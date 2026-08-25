import { deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, PdfRef, PdfStream, name, ref } from './types.js';
import { SfntFont } from './sfnt.js';
import { subsetGlyf } from './subset.js';
import { subsetCff } from './cffsubset.js';

/** Allocate an object in the document and return an indirect reference to it.
 *  Structurally satisfied by `Document.allocObject` (kept structural to avoid a
 *  module cycle between document.ts and fontembed.ts). */
export type Alloc = (obj: PdfObject) => PdfRef;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const pstr = (s: string): PdfObject => ({ kind: 'string', bytes: enc(s) });
const flate = (bytes: Uint8Array): Uint8Array => new Uint8Array(deflateSync(Buffer.from(bytes)));

function flateStream(raw: Uint8Array, extra: Record<string, PdfObject> = {}): PdfStream {
  const dict: PdfDict = new Map<string, PdfObject>([['Filter', name('FlateDecode')], ...Object.entries(extra)]);
  return { kind: 'stream', dict, raw: flate(raw) };
}

/** Six uppercase letters derived deterministically from the font program, used
 *  as the `ABCDEF+` subset-font prefix on /BaseFont. */
function subsetTag(seed: Uint8Array): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (const b of seed) { h = (h ^ b) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
  let tag = '';
  for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + (h % 26)); h = Math.floor(h / 26) + 1; }
  return tag;
}

/** Strip characters PostScript names disallow; fall back to a generic name. */
function sanitizeName(n: string | undefined): string {
  const s = (n ?? '').replace(/[\s()<>[\]{}/%]/g, '');
  return s.length ? s : 'Font';
}

/** Group a sorted CID list into the array form of /W: `cid [w w …]` per run of
 *  consecutive CIDs. */
function buildW(cids: number[], widthOf: (cid: number) => number): PdfObject[] {
  const out: PdfObject[] = [];
  const sorted = [...new Set(cids)].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i];
    const run: PdfObject[] = [widthOf(sorted[i])];
    let j = i + 1;
    while (j < sorted.length && sorted[j] === sorted[j - 1] + 1) { run.push(widthOf(sorted[j])); j++; }
    out.push(start, run);
    i = j;
  }
  return out;
}

const hex4 = (n: number): string => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');
/** UTF-16BE hex of a destination string (each code unit -> 4 hex digits). */
function utf16beHex(s: string): string {
  let h = '';
  for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i));
  return h;
}

/** Build a /ToUnicode CMap mapping each CID (2-byte) to its Unicode text. */
function buildToUnicode(entries: [number, string][]): Uint8Array {
  const head =
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [cid, u] of chunk) body += `<${hex4(cid)}> <${utf16beHex(u)}>\n`;
    body += 'endbfchar\n';
  }
  const tail = 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  return enc(head + body + tail);
}

/**
 * Build the PDF font object graph for one embedded font and return the Type0
 * font dict (descendant CIDFont, FontDescriptor, FontFile, /CIDToGIDMap, and
 * /ToUnicode streams are allocated via `alloc`). Nothing the caller owns is
 * mutated, so a second build runs cleanly.
 *
 * - `glyf` fonts are subset and embedded as CIDFontType2 + FontFile2, with a
 *   /CIDToGIDMap stream translating the original GID (= CID, emitted at draw
 *   time) to the renumbered subset GID.
 * - CFF (`OTTO`) fonts are subset and embedded as CIDFontType0 + FontFile3
 *   /Subtype /CIDFontType0C, with /CIDToGIDMap /Identity — the emitted CID-keyed
 *   CFF's charset maps the original GID (= CID, emitted at draw time) to the
 *   renumbered subset GID. Malformed/exotic CFF falls back to whole-embedding the
 *   OTTO program as /Subtype /OpenType.
 *
 * /W and /ToUnicode are keyed by the stable original GID either way.
 */
export function buildEmbeddedFont(
  font: SfntFont, usedGids: Set<number>, alloc: Alloc,
  toUnicode?: Map<number, string>,
): PdfDict {
  const scale = 1000 / (font.unitsPerEm || 1000);
  const em = (v: number): number => Math.round(v * scale);
  const psName = sanitizeName(font.postScriptName);

  // FontDescriptor metadata shared by both outline kinds.
  const descriptor: PdfDict = new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')],
    ['Flags', font.flags],
    ['FontBBox', font.bbox.map(em) as PdfObject[]],
    ['ItalicAngle', Math.round(font.italicAngle)],
    ['Ascent', em(font.ascent)],
    ['Descent', em(font.descent)],
    ['CapHeight', em(font.capHeight)],
    ['StemV', font.stemV],
  ]);

  // CIDs whose glyphs the font program retains, and the widths to publish.
  let cids: number[];
  let cidToGidMap: PdfObject;
  let baseTag: string;
  let descendantSubtype: string;

  if (font.outlines === 'glyf') {
    const { bytes, gidMap } = subsetGlyf(font, usedGids);
    baseTag = subsetTag(bytes);
    descendantSubtype = 'CIDFontType2';
    descriptor.set('FontFile2', alloc(flateStream(bytes, { Length1: bytes.length })));
    cids = [...gidMap.keys()].sort((a, b) => a - b);
    // CIDToGIDMap stream: 2 bytes per CID for CID 0..max(original GID).
    const maxCid = cids[cids.length - 1] ?? 0;
    const mapBytes = new Uint8Array((maxCid + 1) * 2);
    const mv = new DataView(mapBytes.buffer);
    for (const [orig, sub] of gidMap) mv.setUint16(orig * 2, sub);
    cidToGidMap = alloc(flateStream(mapBytes));
  } else {
    descendantSubtype = 'CIDFontType0';
    cidToGidMap = name('Identity');
    try {
      const { bytes, gidMap } = subsetCff(font.table('CFF ')!, usedGids);
      baseTag = subsetTag(bytes);
      descriptor.set('FontFile3', alloc(flateStream(bytes, { Subtype: name('CIDFontType0C') })));
      cids = [...gidMap.keys()].sort((a, b) => a - b);
    } catch {
      // Exotic/malformed CFF: preserve robustness by whole-embedding the OTTO
      // program, as before. Draw-time GIDs still resolve (identity).
      baseTag = subsetTag(font.raw);
      descriptor.set('FontFile3', alloc(flateStream(font.raw, { Subtype: name('OpenType') })));
      cids = [...usedGids].filter((g) => Number.isInteger(g) && g >= 0 && g < font.numGlyphs).sort((a, b) => a - b);
      if (!cids.includes(0)) cids.unshift(0);
    }
  }

  const baseFont = `${baseTag}+${psName}`;
  descriptor.set('FontName', name(baseFont));

  // /ToUnicode from the shaped cluster map when present (ligatures/reordering),
  // else the font's reverse cmap; restricted to the published CIDs.
  const rev = font.cmapReverse();
  const tuEntries: [number, string][] = [];
  for (const cid of cids) {
    const override = toUnicode?.get(cid);
    if (override !== undefined && override !== '') { tuEntries.push([cid, override]); continue; }
    const cp = rev.get(cid);
    if (cp !== undefined) tuEntries.push([cid, String.fromCodePoint(cp)]);
  }

  const cidFont: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name(descendantSubtype)],
    ['BaseFont', name(baseFont)],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', pstr('Adobe')], ['Ordering', pstr('Identity')], ['Supplement', 0],
    ])],
    ['FontDescriptor', alloc(descriptor)],
    ['CIDToGIDMap', cidToGidMap],
    ['DW', 1000],
    ['W', buildW(cids, (cid) => em(font.advanceWidth(cid)))],
  ]);

  const type0: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type0')],
    ['BaseFont', name(baseFont)],
    ['Encoding', name('Identity-H')],
    ['DescendantFonts', [alloc(cidFont)]],
    ['ToUnicode', alloc(flateStream(buildToUnicode(tuEntries)))],
  ]);
  return type0;
}
