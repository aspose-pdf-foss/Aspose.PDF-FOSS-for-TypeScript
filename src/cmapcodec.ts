import { CMapGeometry, CidRange, CodespaceRange } from './cidcmap.js';

/**
 * The binary container for a bundled predefined CMap's ranges: a columnar,
 * delta-varint encoding that brotli then compresses (see cmapdata.ts).
 *
 * **Invariant:** the encoder and the decoder are one module. The encoder runs
 * only at build time, from `scripts/gen-cmaps.ts`, and ships unused — a few
 * hundred bytes of dist buying the guarantee that a format with no
 * self-description cannot drift between the half that writes it and the half
 * that reads it. `test/cmapcodec.test.ts` round-trips every bundled CMap
 * through both halves against the text parse, which is only a meaningful
 * assertion because both halves are here to be exercised together.
 *
 * Two choices earn most of the compression, measured over the 195 bundled
 * CMaps (385,860 ranges):
 *
 * - **Delta, not absolute.** Ranges are grouped by code width and sorted, so a
 *   `lo` becomes a small gap and a CID becomes a small step from where the
 *   previous range ended. Adobe's CMaps are largely runs of adjacent codes
 *   mapping to adjacent CIDs, which delta-encode to long stretches of the
 *   literal bytes `01 00 01`.
 * - **Columnar, not interleaved.** All the `lo` gaps, then all the spans, then
 *   all the CID steps — rather than a `(lo, span, cid)` triple per range. The
 *   three columns have very different value distributions, and separating them
 *   gives brotli runs of like-valued bytes to match: 893 KB against 1,010 KB
 *   for the same data interleaved, before brotli, and 753 KB against 813 KB
 *   after.
 */

// ---- varints ----

function putVarint(out: number[], value: number): void {
  let n = value >>> 0;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = n >>> 7; }
  out.push(n);
}

/** Zigzag, so a small negative step costs one byte like a small positive one. */
function putSignedVarint(out: number[], value: number): void {
  putVarint(out, value < 0 ? -value * 2 - 1 : value * 2);
}

/** A cursor over the encoded bytes. Reads past the end yield 0 rather than
 *  throwing: a truncated blob then decodes to fewer ranges, and the CMap that
 *  built it degrades to unmapped codes instead of failing the document. */
class Reader {
  private i = 0;
  constructor(private readonly buf: Uint8Array) {}
  get done(): boolean { return this.i >= this.buf.length; }
  varint(): number {
    let n = 0, shift = 0;
    for (let k = 0; k < 5 && this.i < this.buf.length; k++) {
      const b = this.buf[this.i++];
      n += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return n >>> 0;
  }
  signedVarint(): number {
    const n = this.varint();
    return (n & 1) ? -((n + 1) / 2) : n / 2;
  }
}

// ---- ranges ----

/** Group by code width, ascending; sort each group by `lo`. */
function groupByWidth(ranges: readonly CidRange[]): [number, CidRange[]][] {
  const byWidth = new Map<number, CidRange[]>();
  for (const r of ranges) {
    let g = byWidth.get(r.nbytes);
    if (!g) byWidth.set(r.nbytes, (g = []));
    g.push(r);
  }
  const out = [...byWidth].sort((a, b) => a[0] - b[0]);
  for (const [, g] of out) g.sort((a, b) => a.lo - b.lo);
  return out;
}

function encodeRanges(out: number[], ranges: readonly CidRange[]): void {
  const groups = groupByWidth(ranges);
  putVarint(out, groups.length);
  for (const [nbytes, g] of groups) {
    putVarint(out, nbytes);
    putVarint(out, g.length);
    let prev = 0;
    for (const r of g) { putVarint(out, r.lo - prev); prev = r.lo; }
    for (const r of g) putVarint(out, r.hi - r.lo);
    // Each CID step is measured from where the previous range's CIDs ended, so
    // a run of ranges that continues one CID sequence encodes as a run of 1s.
    let prevCid = 0;
    for (const r of g) { putSignedVarint(out, r.cid - prevCid); prevCid = r.cid + (r.hi - r.lo); }
  }
}

function decodeRanges(rd: Reader): CidRange[] {
  const out: CidRange[] = [];
  const groups = rd.varint();
  for (let gi = 0; gi < groups && !rd.done; gi++) {
    const nbytes = rd.varint();
    const count = rd.varint();
    const lo = new Array<number>(count);
    let prev = 0;
    for (let i = 0; i < count; i++) { prev += rd.varint(); lo[i] = prev >>> 0; }
    const span = new Array<number>(count);
    for (let i = 0; i < count; i++) span[i] = rd.varint();
    let prevCid = 0;
    for (let i = 0; i < count; i++) {
      const cid = (prevCid + rd.signedVarint()) >>> 0;
      prevCid = cid + span[i];
      out.push({ nbytes, lo: lo[i], hi: (lo[i] + span[i]) >>> 0, cid });
    }
  }
  return out;
}

// ---- codespace ----

function encodeCodespace(out: number[], ranges: readonly CodespaceRange[]): void {
  putVarint(out, ranges.length);
  for (const r of ranges) {
    putVarint(out, r.nbytes);
    putVarint(out, r.lo);
    putVarint(out, r.hi - r.lo);
  }
}

function decodeCodespace(rd: Reader): CodespaceRange[] {
  const out: CodespaceRange[] = [];
  const count = rd.varint();
  for (let i = 0; i < count && !rd.done; i++) {
    const nbytes = rd.varint();
    const lo = rd.varint();
    const hi = (lo + rd.varint()) >>> 0;
    out.push({ nbytes, lo, hi });
  }
  return out;
}

// ---- entry points ----

/** Encode a CMap's ranges. Build-time only; see the module note. */
export function encodeCMapGeometry(g: CMapGeometry): Uint8Array {
  const out: number[] = [];
  encodeCodespace(out, g.codespace);
  encodeRanges(out, g.cidRanges);
  encodeRanges(out, g.notdefRanges);
  return Uint8Array.from(out);
}

/** Decode a CMap's ranges. Never throws; a truncated blob yields what it held. */
export function decodeCMapGeometry(buf: Uint8Array): CMapGeometry {
  const rd = new Reader(buf);
  const codespace = decodeCodespace(rd);
  const cidRanges = decodeRanges(rd);
  const notdefRanges = decodeRanges(rd);
  return { codespace, cidRanges, notdefRanges };
}
