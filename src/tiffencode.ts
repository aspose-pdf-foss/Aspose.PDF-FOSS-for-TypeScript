/**
 * Baseline TIFF **writer**, the counterpart to `tiff.ts`'s reader.
 *
 * Note the direction, and that the two share no code: `tiff.ts` turns a file on
 * disk into a `RasterImage` for embedding, and this turns rendered samples into
 * a file. What they do share is a format, so every choice here is made from the
 * set `tiff.ts` already decodes — a file we write that we could not read back
 * would be the clearest possible sign that one half had drifted.
 *
 * Pure: bytes in, bytes out. It touches no `Document` and no PDF object, the
 * split `svgdraw.ts`/`svgembed.ts` and `grayimage.ts` already make, which is
 * what lets every rule below be tested from hand-built samples.
 *
 * **Note on what the suite can and cannot check, measured rather than assumed:**
 * the tests read what we write back through `tiff.ts`, which is a usable oracle
 * only because `test/fixtures/tiff/` anchors that decoder against libtiff- and
 * utif2-written files with ground truth from a third decoder. It is still OUR
 * decoder, so anything it TOLERATES is invisible here. Word-aligning each IFD
 * is the known instance: TIFF 6.0 requires it, a Deflate strip ends at an
 * arbitrary length so the alignment genuinely fires, and removing `align2()`
 * before the IFD leaves all 12 cases green because our reader seeks to the
 * offset and does not care. There is no third-party TIFF *validator* in this
 * suite — the same gap `docxpackage.ts` records about not being able to open
 * Word — so read spec conformance here as reasoned, not measured.
 *
 * **Invariant:** frames are a LIST, and a single-page write is a list of one.
 * A multi-page TIFF is the format's whole reason for existing in document
 * archival and fax gateways, and it is not a different writer — it is the same
 * IFDs with their `nextIFD` pointers chained. Building a one-page writer first
 * and generalizing later would mean rewriting the offset arithmetic, which is
 * the only part of this that is easy to get wrong.
 */

import { deflateSync } from 'node:zlib';
import { encodeG4 } from './ccittencode.js';

/** One page of a TIFF. Samples are interleaved 8-bit, TOP-DOWN and tightly
 *  packed — the same row order `rasterimage.ts` fixes for the reading side, so
 *  neither half of this library has to think about which end a row starts. */
export interface TiffFrame {
  width: number;
  height: number;
  /** 'gray' is one channel, 'rgb' three, 'rgba' four with straight (NOT
   *  premultiplied) alpha written as an unassociated ExtraSample.
   *
   *  'bilevel' is 1 BIT per pixel, packed MSB-first with **1 = black**, rows
   *  padded to a byte — the only kind `compression: 'g4'` accepts, and what
   *  `decodeCcitt` returns under `blackIs1: false`. */
  kind: 'gray' | 'rgb' | 'rgba' | 'bilevel';
  samples: Uint8Array;
}

export interface TiffEncodeOptions {
  /** Default 'deflate'. 'none' writes the samples verbatim. 'g4' is CCITT
   *  Group 4 and requires every frame to be `kind: 'bilevel'` — it REFUSES
   *  anything else rather than thresholding, since choosing a threshold is a
   *  decision about the image the caller did not ask us to make. */
  compression?: 'none' | 'deflate' | 'g4';
}

const CHANNELS: Record<TiffFrame['kind'], number> = { gray: 1, rgb: 3, rgba: 4, bilevel: 1 };

/** Bits per sample by kind. Only bilevel is sub-byte. */
const BPS: Record<TiffFrame['kind'], number> = { gray: 8, rgb: 8, rgba: 8, bilevel: 1 };

/** Packed bytes per row -- the stride the caller must supply and we write. */
const rowStride = (f: TiffFrame): number =>
  f.kind === 'bilevel' ? (f.width + 7) >> 3 : f.width * CHANNELS[f.kind];

// Tag numbers, kept in the order an IFD must list them.
const T_WIDTH = 256, T_HEIGHT = 257, T_BPS = 258, T_COMPRESSION = 259;
const T_PHOTOMETRIC = 262, T_STRIP_OFFSETS = 273, T_SAMPLES = 277;
const T_ROWS_PER_STRIP = 278, T_STRIP_COUNTS = 279, T_PLANAR = 284;
const T_EXTRA_SAMPLES = 338;

const TYPE_SHORT = 3, TYPE_LONG = 4;

/** Target bytes per strip. TIFF 6.0 §Strips recommends ~8K; 64K is the modern
 *  convention and keeps the offsets array short on a large page. A strip is at
 *  least one row, so a page wider than the budget simply gets one row per
 *  strip rather than a strip smaller than a row. */
const STRIP_BUDGET = 64 * 1024;

interface Entry { tag: number; type: number; values: number[] }

/** An IFD entry's payload is inline when it fits in the 4-byte value field,
 *  and external otherwise — which is a property of the COUNT, not of the tag,
 *  so it is decided here once rather than per tag. */
const payloadBytes = (e: Entry): number =>
  e.values.length * (e.type === TYPE_SHORT ? 2 : 4);

const isInline = (e: Entry): boolean => payloadBytes(e) <= 4;

class ByteWriter {
  private buf = new Uint8Array(1024);
  private len = 0;

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  get length(): number { return this.len; }

  u8(v: number): void { this.need(1); this.buf[this.len++] = v & 0xff; }
  u16(v: number): void { this.u8(v); this.u8(v >>> 8); }
  u32(v: number): void { this.u16(v); this.u16(v >>> 16); }

  bytes(b: Uint8Array): void {
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  /** Overwrite a previously written u32 — how a `nextIFD` pointer is filled in
   *  once the following IFD's position is known. */
  patchU32(at: number, v: number): void {
    this.buf[at] = v & 0xff;
    this.buf[at + 1] = (v >>> 8) & 0xff;
    this.buf[at + 2] = (v >>> 16) & 0xff;
    this.buf[at + 3] = (v >>> 24) & 0xff;
  }

  /** TIFF requires each IFD and each external value to begin on a word
   *  boundary. */
  align2(): void { if (this.len & 1) this.u8(0); }

  finish(): Uint8Array { return this.buf.slice(0, this.len); }
}

function compressStrip(
  bytes: Uint8Array, how: 'none' | 'deflate' | 'g4', columns: number, rows: number,
): Uint8Array {
  if (how === 'none') return bytes;
  // No EOFB per strip: TIFF gives each strip its own byte count, and libtiff
  // does not write one either. A trailing EOFB is legal but pure overhead
  // repeated once per strip.
  if (how === 'g4') return encodeG4(bytes, columns, rows, { eofb: false });
  return new Uint8Array(deflateSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)));
}

/** G4 codes a bilevel raster and nothing else. Refuse rather than threshold:
 *  picking a threshold is a decision about the image the caller did not ask us
 *  to make, and a silently thresholded page is a different picture. */
function checkG4(frames: readonly TiffFrame[]): void {
  const bad = frames.findIndex((f) => f.kind !== 'bilevel');
  if (bad >= 0)
    throw new TypeError(
      `encodeTiff: compression 'g4' needs every frame to be kind: 'bilevel', ` +
      `but frame ${bad} is '${frames[bad].kind}' — supply 1-bpp packed samples ` +
      `(1 = black); this encoder will not threshold for you`);
}

function checkFrame(f: TiffFrame, i: number): void {
  const ch = CHANNELS[f.kind];
  if (ch === undefined) throw new TypeError(`encodeTiff: frame ${i} has unknown kind ${f.kind}`);
  if (!Number.isInteger(f.width) || !Number.isInteger(f.height) ||
      f.width < 1 || f.height < 1)
    throw new TypeError(`encodeTiff: frame ${i} must have positive integer dimensions`);
  const want = rowStride(f) * f.height;
  if (f.samples.length !== want)
    throw new TypeError(
      `encodeTiff: frame ${i} expected ${want} samples, got ${f.samples.length}`);
}

/** The IFD entries for one frame, in ASCENDING tag order — which TIFF 6.0
 *  requires and many readers rely on. Offsets and counts are filled by the
 *  caller, which is the only part that depends on where the data landed. */
function entriesFor(
  f: TiffFrame, compression: number, stripOffsets: number[], stripCounts: number[],
  rowsPerStrip: number,
): Entry[] {
  const ch = CHANNELS[f.kind];
  const entries: Entry[] = [
    { tag: T_WIDTH, type: TYPE_LONG, values: [f.width] },
    { tag: T_HEIGHT, type: TYPE_LONG, values: [f.height] },
    { tag: T_BPS, type: TYPE_SHORT, values: new Array(ch).fill(BPS[f.kind]) },
    { tag: T_COMPRESSION, type: TYPE_SHORT, values: [compression] },
    // 1 = BlackIsZero, matching RasterImage's DeviceGray convention on the
    // reading side; 2 = RGB. A bilevel frame carries 1 = BLACK, so it declares
    // photometric 0 (WhiteIsZero) — the fax convention, and what `tiff.ts`
    // normalizes back on read.
    {
      tag: T_PHOTOMETRIC, type: TYPE_SHORT,
      values: [f.kind === 'bilevel' ? 0 : f.kind === 'gray' ? 1 : 2],
    },
    { tag: T_STRIP_OFFSETS, type: TYPE_LONG, values: stripOffsets },
    { tag: T_SAMPLES, type: TYPE_SHORT, values: [ch] },
    { tag: T_ROWS_PER_STRIP, type: TYPE_LONG, values: [rowsPerStrip] },
    { tag: T_STRIP_COUNTS, type: TYPE_LONG, values: stripCounts },
    { tag: T_PLANAR, type: TYPE_SHORT, values: [1] },
  ];
  // 2 = UNASSOCIATED alpha. Value 1 would claim the colour is premultiplied,
  // and `tiff.ts` divides that back out on read -- so writing 1 over straight
  // alpha brightens every semi-transparent pixel on the round trip.
  if (f.kind === 'rgba') entries.push({ tag: T_EXTRA_SAMPLES, type: TYPE_SHORT, values: [2] });
  return entries;
}

/**
 * Encode one or more frames as a baseline TIFF.
 *
 * Layout is header, then every frame's strip data, then the chained IFDs. Data
 * first is what lets a strip offset be known before the IFD that names it is
 * written, so the whole file is produced in one forward pass with only the
 * `nextIFD` pointers patched afterwards.
 */
export function encodeTiff(
  frames: readonly TiffFrame[], opts: TiffEncodeOptions = {},
): Uint8Array {
  if (frames.length === 0)
    throw new TypeError('encodeTiff: at least one frame is required');
  frames.forEach(checkFrame);

  const how = opts.compression ?? 'deflate';
  if (how === 'g4') checkG4(frames);
  const compression = how === 'deflate' ? 8 : how === 'g4' ? 4 : 1;

  const w = new ByteWriter();
  w.u16(0x4949);          // "II" — little-endian
  w.u16(42);
  const ifd0PointerAt = w.length;
  w.u32(0);               // patched once the first IFD's position is known

  // --- strip data, frame by frame ---
  interface Laid { offsets: number[]; counts: number[]; rowsPerStrip: number }
  const laid: Laid[] = [];

  for (const f of frames) {
    const rowBytes = rowStride(f);
    const rowsPerStrip = Math.max(1, Math.floor(STRIP_BUDGET / rowBytes));
    const offsets: number[] = [];
    const counts: number[] = [];

    for (let y = 0; y < f.height; y += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, f.height - y);
      const raw = f.samples.subarray(y * rowBytes, (y + rows) * rowBytes);
      const payload = compressStrip(raw, how, f.width, rows);
      w.align2();
      offsets.push(w.length);
      counts.push(payload.length);
      w.bytes(payload);
    }
    laid.push({ offsets, counts, rowsPerStrip });
  }

  // --- IFDs, chained ---
  let prevNextPointerAt = ifd0PointerAt;

  frames.forEach((f, i) => {
    const { offsets, counts, rowsPerStrip } = laid[i];
    const entries = entriesFor(f, compression, offsets, counts, rowsPerStrip);

    // An external payload must sit outside the IFD, so its address depends on
    // the IFD's own size: 2 count bytes + 12 per entry + 4 nextIFD.
    w.align2();
    const ifdAt = w.length;
    w.patchU32(prevNextPointerAt, ifdAt);

    let extAt = ifdAt + 2 + entries.length * 12 + 4;
    const external: Entry[] = [];
    const addrOf = new Map<Entry, number>();
    for (const e of entries) {
      if (isInline(e)) continue;
      // TIFF requires an external value to start on a word boundary.
      //
      // **Note, measured and recorded as UNREACHABLE today** rather than left
      // to look load-bearing: `ifdAt` is even, the IFD's own size (2 + 12n + 4)
      // is even, and every payload here is a SHORT count of 3 (6 bytes) or a
      // run of LONGs (4 bytes each) — so `extAt` is even at every step and this
      // never fires. Deleting it leaves the whole suite green. It is retained
      // because the invariant it protects is real and the first ASCII tag or
      // odd-count SHORT anyone adds would break it silently. Do not read the
      // green suite as covering this line, and do not delete it as dead code.
      if (extAt & 1) extAt++;
      addrOf.set(e, extAt);
      external.push(e);
      extAt += payloadBytes(e);
    }

    w.u16(entries.length);
    for (const e of entries) {
      w.u16(e.tag);
      w.u16(e.type);
      w.u32(e.values.length);
      if (isInline(e)) {
        // Inline values are left-justified in the 4-byte field, so a single
        // SHORT occupies the first two bytes and the rest stay zero.
        let written = 0;
        for (const v of e.values) {
          if (e.type === TYPE_SHORT) { w.u16(v); written += 2; } else { w.u32(v); written += 4; }
        }
        for (; written < 4; written++) w.u8(0);
      } else {
        w.u32(addrOf.get(e)!);
      }
    }
    prevNextPointerAt = w.length;
    w.u32(0);               // patched by the next frame, or left 0 as the end

    for (const e of external) {
      w.align2();
      for (const v of e.values) {
        if (e.type === TYPE_SHORT) w.u16(v); else w.u32(v);
      }
    }
  });

  return w.finish();
}
