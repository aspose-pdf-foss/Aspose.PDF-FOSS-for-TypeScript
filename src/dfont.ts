/**
 * Macintosh `.dfont` font suitcases.
 *
 * A `.dfont` is a DATA-fork font: it holds resource-fork-FORMAT bytes in the
 * ordinary data fork, which is the entire reason the format exists. So there
 * is no `..namedfork/rsrc` path to handle and no platform branch anywhere —
 * `openSync` sees one as a plain file.
 *
 * Each `sfnt` resource is a complete, self-consistent sfnt whose table offsets
 * are relative to its own start, so a face is a `subarray` rather than the
 * `assembleSfnt` rebuild `ttc.ts` needs. `SfntFont` threads `byteOffset`
 * through every `DataView`, which is what makes that safe.
 *
 * A pure leaf: `errors.js` and nothing else.
 */
import { PdfParseError } from './errors.js';

/** Reads `length` bytes at `offset`, or fewer at end of file. */
export type ByteReader = (offset: number, length: number) => Uint8Array;

const u16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const u24 = (d: Uint8Array, o: number): number => (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
const u32 = (d: Uint8Array, o: number): number =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

const SFNT = 0x73666e74;   // 'sfnt'
/** Header copy, next-map handle, file ref, attributes, two list offsets. */
const MAP_PROLOGUE = 28;
/** `mapLength` is a u32 in a file we did not write. A map is small even for a
 *  large suitcase — 1 MB is some 87,000 resources — so this bounds a hostile
 *  value without bounding a real one. */
const MAX_MAP = 1 << 20;

/**
 * The byte range of each `sfnt` resource, or `undefined` when this is not a
 * `.dfont`.
 *
 * A `.dfont` carries NO SIGNATURE — it opens with a raw `u32` data offset — so
 * the walk that finds the faces IS the test that the file is one. Same shape as
 * `ttcFaceOffsets`, and for the same reason.
 *
 * Takes a READER rather than bytes, because two callers want this walk over
 * different access strategies: `parseSfnt` holds the whole buffer, and
 * `fontsource.ts` holds a file descriptor and must not read one. A bytes-only
 * signature would force `fontsource.ts` to keep its own map parse — which is
 * how an index and a loader come to disagree about how many faces a file holds.
 */
export function dfontSfntRanges(
  read: ByteReader, fileLength: number,
): { offset: number; length: number }[] | undefined {
  if (fileLength < 16 + MAP_PROLOGUE) return undefined;
  const h = read(0, 16);
  if (h.length < 16) return undefined;
  const dataOffset = u32(h, 0), mapOffset = u32(h, 4);
  const dataLength = u32(h, 8), mapLength = u32(h, 12);

  if (dataOffset < 16 || mapOffset < 16) return undefined;
  if (mapLength < MAP_PROLOGUE + 2 || mapLength > MAX_MAP) return undefined;
  if (dataOffset + dataLength > fileLength) return undefined;
  if (mapOffset + mapLength > fileLength) return undefined;

  const map = read(mapOffset, mapLength);
  if (map.length < mapLength) return undefined;

  // The map's first 16 bytes are reserved for a copy of the header. Nothing
  // enforces that, so it is deliberately NOT checked: a tool that zeroes the
  // field would otherwise cost us a font for no benefit.
  const typeListAt = u16(map, 24);
  if (typeListAt + 2 > mapLength) return undefined;
  const numTypes = u16(map, typeListAt) + 1;          // stored MINUS ONE
  if (typeListAt + 2 + numTypes * 8 > mapLength) return undefined;

  for (let i = 0; i < numTypes; i++) {
    const e = typeListAt + 2 + i * 8;
    // Faces are selected by TAG, never by position: a real suitcase carries
    // FOND records, and often NFNT strikes or POST fragments, in this same list.
    if (u32(map, e) !== SFNT) continue;
    const count = u16(map, e + 4) + 1;                // stored MINUS ONE
    // The reference-list offset is from the TYPE LIST start, not the map start.
    // The two bases differ by the 28-byte prologue, so confusing them lands
    // inside a real structure and reads a plausible wrong list.
    const refAt = typeListAt + u16(map, e + 6);
    if (refAt < 0 || refAt + count * 12 > mapLength) return undefined;

    const out: { offset: number; length: number }[] = [];
    for (let r = 0; r < count; r++) {
      const at = dataOffset + u24(map, refAt + r * 12 + 5);
      if (at + 4 > fileLength) return undefined;
      const lenBytes = read(at, 4);
      if (lenBytes.length < 4) return undefined;
      // That u24 addresses a LENGTH, not data: the sfnt begins four bytes on.
      const length = u32(lenBytes, 0);
      const offset = at + 4;
      if (length === 0 || offset + length > fileLength) return undefined;
      out.push({ offset, length });
    }
    return out;
  }
  return undefined;      // a bitmap-only suitcase, or not a suitcase at all
}

const slicer = (bytes: Uint8Array): ByteReader =>
  (o, l) => bytes.subarray(o, Math.min(o + l, bytes.length));

/**
 * Whether `bytes` opens as a `.dfont`.
 *
 * This walks the container a second time, which is accepted rather than
 * optimised away: the walk reads the header and the map and no glyph data, and
 * what it buys is a `parseSfnt` dispatch chain that reads uniformly beside
 * `isType1(bytes)`, plus an `extractDfontFace` that can still distinguish "not
 * a suitcase" from "no such face in this suitcase".
 */
export function isDfont(bytes: Uint8Array): boolean {
  return dfontSfntRanges(slicer(bytes), bytes.length) !== undefined;
}

/**
 * Face `index` of a suitcase, as a standalone sfnt.
 *
 * Throws `PdfParseError` for a non-`.dfont` or an out-of-range index. A caller
 * scanning a folder catches that and skips the file; a caller naming a face is
 * being told it asked for something that is not there — `ttc.ts`'s rule.
 */
export function extractDfontFace(bytes: Uint8Array, index: number): Uint8Array {
  const ranges = dfontSfntRanges(slicer(bytes), bytes.length);
  if (!ranges) throw new PdfParseError('not a .dfont (no resource map with an sfnt type)', 0);
  if (!Number.isInteger(index) || index < 0 || index >= ranges.length) {
    throw new PdfParseError(`.dfont holds ${ranges.length} faces, asked for index ${index}`, 0);
  }
  const r = ranges[index];
  return bytes.subarray(r.offset, r.offset + r.length);
}
