/**
 * A minimal GIF87a/89a reader, TEST-ONLY.
 *
 * `src/` has no GIF decoder, so `gifencode.ts` would otherwise be checkable
 * only against itself — the shared-convention trap `CLAUDE.md` records, where
 * writer and reader agree with each other and both disagree with the format.
 * This is written from the GIF89a specification independently of the encoder,
 * which is the arrangement `scripts/jbig2-codec.mjs` already uses against
 * `src/jbig2*.ts`: two separately-written halves meeting at a known bitmap.
 *
 * It reads exactly what we write — one image, a global colour table, no
 * interlacing, no animation — and refuses anything else rather than guessing.
 */

export interface GifImage {
  width: number;
  height: number;
  /** Interleaved 8-bit RGB, top-down. */
  rgb: Uint8Array;
  /** The global colour table, RGB triples. */
  palette: Uint8Array;
  /** Per-pixel palette indices, top-down. */
  indices: Uint8Array;
}

/** Concatenate the sub-block chain starting at `p`; returns the data and the
 *  offset just past the terminating zero-length block. */
function readSubBlocks(d: Uint8Array, p: number): { data: Uint8Array; end: number } {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const n = d[p++];
    if (n === 0) break;
    parts.push(d.subarray(p, p + n));
    total += n;
    p += n;
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { data.set(part, at); at += part.length; }
  return { data, end: p };
}

/** GIF LZW: LSB-first, variable width from `minCodeSize + 1`, with the table
 *  reset on the clear code. */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;

  const out = new Uint8Array(pixels);
  let outAt = 0;

  // Dictionary as prefix/suffix chains, the classic representation.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  let next = clear + 2;
  let width = minCodeSize + 1;

  let bitBuf = 0, bitCount = 0, at = 0;
  const nextCode = (): number => {
    while (bitCount < width) {
      if (at >= data.length) return eoi;
      bitBuf |= data[at++] << bitCount;      // LSB-first
      bitCount += 8;
    }
    const c = bitBuf & ((1 << width) - 1);
    bitBuf >>>= width;
    bitCount -= width;
    return c;
  };

  const stack = new Uint8Array(4096);

  /** Emit the string for `code`, returning its FIRST byte — which is the
   *  suffix the next dictionary entry needs. */
  const emit = (code: number): number => {
    let sp = 0;
    let walk = code;
    while (walk >= clear) { stack[sp++] = suffix[walk]; walk = prefix[walk]; }
    stack[sp++] = walk;                 // the root byte
    const first = walk;
    while (sp > 0) out[outAt++] = stack[--sp];
    return first;
  };

  /** The first byte of `code`'s string, without emitting it. */
  const firstOf = (code: number): number => {
    let walk = code;
    while (walk >= clear) walk = prefix[walk];
    return walk;
  };

  const addEntry = (p: number, s: number): void => {
    if (next >= 4096) return;           // table full: stay put until a clear
    prefix[next] = p;
    suffix[next] = s;
    next++;
    if (next === (1 << width) && width < 12) width++;
  };

  // The spec requires a Clear code first, and this reader ENFORCES it rather
  // than tolerating its absence. A lenient reader would let the encoder omit
  // it and still pass here — and many real decoders ARE lenient, so the bug
  // would surface only on the strict one somebody else uses. Consuming it
  // needs no state change: a Clear resets to exactly the initial state.
  const opening = nextCode();
  if (opening !== clear)
    throw new Error(`GIF: stream does not open with a Clear code (got ${opening})`);

  let prev = -1;
  for (;;) {
    const code = nextCode();
    if (code === eoi) break;
    if (code === clear) {
      next = clear + 2;
      width = minCodeSize + 1;
      prev = -1;
      continue;
    }
    if (prev < 0) {                     // first code after a clear: a root
      emit(code);
      prev = code;
      continue;
    }
    if (code < next) {
      const first = emit(code);
      addEntry(prev, first);
    } else if (code === next) {
      // KwKwK: the entry is being used in the same step that defines it.
      const first = firstOf(prev);
      emit(prev);
      out[outAt++] = first;
      addEntry(prev, first);
    } else {
      throw new Error(`GIF: code ${code} beyond the next free entry ${next}`);
    }
    prev = code;
  }
  if (outAt !== pixels)
    throw new Error(`GIF: decoded ${outAt} pixels, expected ${pixels}`);
  return out;
}

export function decodeGif(d: Uint8Array): GifImage {
  const sig = String.fromCharCode(...d.subarray(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error(`GIF: bad signature ${sig}`);

  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  const flags = d[10];
  if ((flags & 0x80) === 0) throw new Error('GIF: no global colour table');
  const gctSize = 2 << (flags & 7);

  let p = 13;
  const palette = new Uint8Array(gctSize * 3);
  palette.set(d.subarray(p, p + gctSize * 3));
  p += gctSize * 3;

  // Skip extension blocks until the image separator.
  for (;;) {
    if (d[p] === 0x2c) break;                       // image descriptor
    if (d[p] === 0x3b) throw new Error('GIF: trailer before any image');
    if (d[p] !== 0x21) throw new Error(`GIF: unexpected block 0x${d[p].toString(16)}`);
    p += 2;                                          // 0x21, label
    p = readSubBlocks(d, p).end;
  }

  p++;                                               // 0x2c
  const width = dv.getUint16(p + 4, true);
  const height = dv.getUint16(p + 6, true);
  const imgFlags = d[p + 8];
  if (imgFlags & 0x40) throw new Error('GIF: interlaced images are not read here');
  if (imgFlags & 0x80) throw new Error('GIF: local colour tables are not read here');
  p += 9;

  const minCodeSize = d[p++];
  const { data } = readSubBlocks(d, p);
  const indices = lzwDecode(data, minCodeSize, width * height);

  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const e = indices[i] * 3;
    rgb[i * 3] = palette[e];
    rgb[i * 3 + 1] = palette[e + 1];
    rgb[i * 3 + 2] = palette[e + 2];
  }
  return { width, height, rgb, palette, indices };
}
