/**
 * TrueType / OpenType Collections (`.ttc`, `.otc`).
 *
 * A collection is a `ttcf` header pointing at N table directories that all
 * share one file, and each directory's entries hold offsets from the start of
 * that file -- so several faces commonly share a `glyf` or a `cmap`.
 *
 * A face is EXTRACTED into a standalone sfnt rather than read in place, and
 * that is the whole design decision here. `SfntFont` resolves tables by
 * absolute offset into its `raw`, so handing it the collection with a face's
 * directory offset would decode perfectly -- and `fontembed.ts`'s CFF fallback
 * whole-embeds `font.raw`, which would then put every face of a 40 MB system
 * collection into the PDF as a single OpenType program. Extracting at this
 * boundary costs a copy of one face's tables and keeps collections invisible
 * to subsetting, embedding, cmap and glyph access alike.
 */
import { PdfParseError } from './errors.js';
import { assembleSfnt } from './sfntwrite.js';

const TTCF = 0x74746366; // 'ttcf'

const u16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const u32 = (d: Uint8Array, o: number): number =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/**
 * Byte offset of each face's table directory, or `undefined` when `bytes` is
 * not a collection.
 *
 * Header versions 1.0 and 2.0 differ only in fields that follow the offset
 * array (the DSIG triple), so one reader serves both -- and `.otc` is the same
 * container with CFF faces inside.
 */
export function ttcFaceOffsets(bytes: Uint8Array): number[] | undefined {
  if (bytes.length < 12 || u32(bytes, 0) !== TTCF) return undefined;
  const numFonts = u32(bytes, 8);
  if (numFonts === 0 || numFonts > 0xffff) return undefined;
  if (bytes.length < 12 + numFonts * 4) return undefined;
  const out: number[] = [];
  for (let i = 0; i < numFonts; i++) out.push(u32(bytes, 12 + i * 4));
  return out;
}

/**
 * Face `index` of a collection, rebuilt as a standalone sfnt.
 *
 * Throws `PdfParseError` for a non-collection, an out-of-range index, or a
 * directory that runs past the end of the file. A caller scanning a folder
 * catches that and skips the file; a caller naming a face is being told it
 * asked for something that is not there.
 */
export function extractTtcFace(bytes: Uint8Array, index: number): Uint8Array {
  const offsets = ttcFaceOffsets(bytes);
  if (!offsets) throw new PdfParseError('not a font collection (no ttcf header)', 0);
  if (!Number.isInteger(index) || index < 0 || index >= offsets.length) {
    throw new PdfParseError(
      `font collection has ${offsets.length} faces, asked for index ${index}`, 0);
  }

  const dir = offsets[index];
  if (dir + 12 > bytes.length) throw new PdfParseError('collection face offset out of bounds', dir);
  const flavor = u32(bytes, dir);
  const numTables = u16(bytes, dir + 4);
  if (dir + 12 + numTables * 16 > bytes.length) {
    throw new PdfParseError('collection face directory out of bounds', dir);
  }

  const tables: { tag: string; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const rec = dir + 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    const off = u32(bytes, rec + 8), len = u32(bytes, rec + 12);
    if (off + len > bytes.length) {
      throw new PdfParseError(`collection table '${tag}' out of bounds`, off);
    }
    tables.push({ tag, data: bytes.subarray(off, off + len) });
  }
  return assembleSfnt(flavor, tables);
}
