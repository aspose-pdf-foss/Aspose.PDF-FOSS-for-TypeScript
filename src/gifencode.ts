/**
 * GIF89a **writer** — a single, non-interlaced image with a global colour
 * table. Pure: bytes in, bytes out.
 *
 * **Note on the oracle, and it is unlike every other codec here:** `src/` has
 * no GIF *reader*, so this writer cannot be checked against its own counterpart
 * the way `tiffencode.ts` is checked against `tiff.ts`. `test/helpers/decode-gif.ts`
 * is a test-only reader written independently from the GIF89a specification —
 * the arrangement `scripts/jbig2-codec.mjs` already has against `src/jbig2*.ts`:
 * two separately-written halves meeting at a known bitmap. That is stronger
 * than a self-check and weaker than a real-world fixture; there is no
 * third-party GIF in `test/fixtures/`.
 *
 * **Invariant:** GIF's LZW is NOT the LZW in `lzw.ts`. That one is PDF's:
 * 8-bit-rooted, MSB-first, with an early-change quirk. GIF's is LSB-first, its
 * root code size comes from the palette, and its output is framed in
 * length-prefixed sub-blocks. Reusing `lzwEncode` would produce a file that
 * looks structurally right and decodes to noise.
 *
 * **Invariant:** the code width grows when the dictionary reaches `1 << width`,
 * and the ENCODER must grow it one step later than a naive reading suggests —
 * the width applies to codes already emitted, so it increases only after the
 * entry that fills the current width is added. Off by one here desynchronises
 * the decoder partway through, which looks like corruption in the second half
 * of an otherwise fine image.
 */

import { quantize } from './quantize.js';

/** Bits per palette index: the smallest size holding `n` entries, min 2 —
 *  GIF's smallest legal global colour table is 4 entries. */
function tableBits(n: number): number {
  let bits = 2;
  while ((1 << bits) < n) bits++;
  if (bits > 8) throw new RangeError(`gif: ${n} palette entries exceeds 256`);
  return bits;
}

/** LSB-first bit packer that emits GIF's length-prefixed sub-blocks. */
class SubBlockWriter {
  private out: number[] = [];
  private block: number[] = [];
  private bitBuf = 0;
  private bitCount = 0;

  write(code: number, width: number): void {
    this.bitBuf |= code << this.bitCount;
    this.bitCount += width;
    while (this.bitCount >= 8) {
      this.pushByte(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCount -= 8;
    }
  }

  private pushByte(b: number): void {
    this.block.push(b);
    if (this.block.length === 255) this.flushBlock();
  }

  private flushBlock(): void {
    if (this.block.length === 0) return;
    this.out.push(this.block.length, ...this.block);
    this.block = [];
  }

  /** Flush the partial byte, the partial block, and the terminator. */
  finish(): Uint8Array {
    if (this.bitCount > 0) {
      this.pushByte(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCount = 0;
    }
    this.flushBlock();
    this.out.push(0);
    return Uint8Array.from(this.out);
  }
}

/** Compress palette indices with GIF's LZW. */
function lzwCompress(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  const w = new SubBlockWriter();
  let width = minCodeSize + 1;
  let next = clear + 2;
  // Dictionary keyed by (prefix << 8) | suffix — a byte suffix always, since
  // every root is one palette index.
  let dict = new Map<number, number>();

  w.write(clear, width);

  let prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const b = indices[i];
    const k = (prev << 8) | b;
    const found = dict.get(k);
    if (found !== undefined) { prev = found; continue; }

    w.write(prev, width);
    if (next < 4096) {
      dict.set(k, next);
      next++;
      // Grow AFTER the entry that fills the current width, not before: the
      // width applies to codes already emitted.
      if (next > (1 << width) && width < 12) width++;
    } else {
      w.write(clear, width);
      dict = new Map();
      next = clear + 2;
      width = minCodeSize + 1;
    }
    prev = b;
  }
  w.write(prev, width);
  w.write(eoi, width);
  return w.finish();
}

/**
 * Encode interleaved top-down 8-bit RGB as a GIF89a.
 *
 * Colour is reduced to at most 256 entries by `quantize`, which passes an
 * image that already fits through EXACTLY — so a page of text and flat fills
 * round-trips losslessly and only a photograph or gradient loses anything.
 */
export function encodeGif(width: number, height: number, samples: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new TypeError('encodeGif: width and height must be positive integers');
  if (width > 0xffff || height > 0xffff)
    throw new RangeError('encodeGif: dimensions are 16-bit, max 65535');
  const want = width * height * 3;
  if (samples.length !== want)
    throw new TypeError(`encodeGif: expected ${want} samples, got ${samples.length}`);

  const q = quantize(samples, width * height);
  const entries = q.palette.length / 3;
  const bits = tableBits(entries);
  const tableSize = 1 << bits;

  // The LZW root size is the table size, floored at 2: a 1-bit root would make
  // the clear code 2 and leave no room for both control codes.
  const minCodeSize = Math.max(2, bits);
  const lzw = lzwCompress(q.indices, minCodeSize);

  const out: number[] = [];
  const u16 = (v: number) => { out.push(v & 0xff, (v >> 8) & 0xff); };

  // --- header + logical screen descriptor ---
  for (const c of 'GIF89a') out.push(c.charCodeAt(0));
  u16(width);
  u16(height);
  out.push(0x80 | ((bits - 1) & 7));   // global table present, its size
  out.push(0);                         // background colour index
  out.push(0);                         // pixel aspect ratio: none

  // --- global colour table, padded to the declared size ---
  for (let i = 0; i < tableSize; i++) {
    if (i < entries) out.push(q.palette[i * 3], q.palette[i * 3 + 1], q.palette[i * 3 + 2]);
    else out.push(0, 0, 0);
  }

  // --- image descriptor ---
  out.push(0x2c);
  u16(0); u16(0);                      // left, top
  u16(width); u16(height);
  out.push(0);                         // no local table, not interlaced

  // --- image data ---
  out.push(minCodeSize);
  for (const b of lzw) out.push(b);

  out.push(0x3b);                      // trailer
  return Uint8Array.from(out);
}
