/** The glyphless font behind `MakeSearchable`'s invisible text (`3ywf.3`).
 *
 *  OCR text is drawn in render mode 3 — never painted — so its glyph SHAPES
 *  are irrelevant, and what matters is that any script extracts and that
 *  validators accept the font. Tesseract and OCRmyPDF answer this with a
 *  "glyphless" font, and so does this module: a two-glyph TrueType (`.notdef`
 *  and one EMPTY glyph), embedded as a composite Identity-H font, where each
 *  distinct character the run meets gets its own code and `/ToUnicode` maps
 *  the code back.
 *
 *  **Invariant:** every code ≥ 1 maps to GID 1, NEVER 0. ISO 14289-2
 *  8.4.5's `NotdefUsed` does NOT exempt render mode 3 (`uafont.ts`).
 *
 *  **Invariant:** `/BaseFont` carries NO subset tag, so PDF/A's `/CIDSet` rule
 *  (subset fonts only) does not apply — the program genuinely is the whole font.
 *
 *  **Invariant:** `/ToUnicode` and `/CIDToGIDMap` are written ONCE, by
 *  `finish`, from the final assigner — every page shares one font object.
 *
 *  A near-LEAF: no `Document`; objects arrive through `alloc`/`replace`. */
import { name, type PdfDict, type PdfObject, type PdfRef, type PdfStream } from './types.js';
import { assembleSfnt, buildCmap } from './sfntwrite.js';
import { buildToUnicode, flateStream } from './fontembed.js';

/** The one advance every code has, in 1/1000 em. */
export const GLYPHLESS_ADVANCE = 500;
const FONT_NAME = 'GlyphLessFont';
const MAX_CODES = 0xffff;

let program: Uint8Array | undefined;

/** The glyphless TrueType program, built once per process. */
export function glyphlessProgram(): Uint8Array {
  program ??= buildProgram();
  return program;
}

function table(len: number, fill: (v: DataView) => void): Uint8Array {
  const b = new Uint8Array(len);
  fill(new DataView(b.buffer));
  return b;
}

function nameTable(): Uint8Array {
  const recs: [number, string][] = [[1, FONT_NAME], [2, 'Regular'], [4, FONT_NAME], [6, FONT_NAME]];
  const strings = recs.map(([, s]) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) >> 8; b[i * 2 + 1] = s.charCodeAt(i) & 0xff; }
    return b;
  });
  const header = 6 + 12 * recs.length;
  const total = header + strings.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0); v.setUint16(2, recs.length); v.setUint16(4, header);
  let off = 0;
  recs.forEach(([id], i) => {
    const r = 6 + 12 * i;
    v.setUint16(r, 3); v.setUint16(r + 2, 1); v.setUint16(r + 4, 0x409);
    v.setUint16(r + 6, id); v.setUint16(r + 8, strings[i]!.length); v.setUint16(r + 10, off);
    out.set(strings[i]!, header + off);
    off += strings[i]!.length;
  });
  return out;
}

function buildProgram(): Uint8Array {
  const head = table(54, (v) => {
    v.setUint32(0, 0x00010000); v.setUint32(4, 0x00010000); v.setUint32(8, 0);
    v.setUint32(12, 0x5f0f3cf5); v.setUint16(16, 0x000b); v.setUint16(18, 1000);
    // created/modified (20..35) zero; bbox (36..43) zero: both glyphs are empty.
    v.setUint16(44, 0); v.setUint16(46, 8); v.setInt16(48, 2);
    v.setInt16(50, 0); v.setInt16(52, 0); // short loca, glyph data format 0
  });
  const hhea = table(36, (v) => {
    v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setInt16(8, 0);
    v.setUint16(10, GLYPHLESS_ADVANCE); v.setInt16(18, 1); v.setUint16(34, 2);
  });
  const maxp = table(32, (v) => { v.setUint32(0, 0x00010000); v.setUint16(4, 2); v.setUint16(14, 2); });
  const hmtx = table(8, (v) => { v.setUint16(0, GLYPHLESS_ADVANCE); v.setUint16(4, GLYPHLESS_ADVANCE); });
  const loca = new Uint8Array(6); // three zero offsets: both glyphs empty
  const glyf = new Uint8Array(0);
  const post = table(32, (v) => { v.setUint32(0, 0x00030000); v.setInt16(8, -100); v.setInt16(10, 50); });
  return assembleSfnt(0x00010000, [
    { tag: 'head', data: head }, { tag: 'hhea', data: hhea }, { tag: 'maxp', data: maxp },
    { tag: 'hmtx', data: hmtx }, { tag: 'loca', data: loca }, { tag: 'glyf', data: glyf },
    { tag: 'cmap', data: buildCmap(new Map([[0x20, 1]])) }, { tag: 'name', data: nameTable() },
    { tag: 'post', data: post },
  ]);
}

/** One code per distinct character (code point), assigned from 1. */
export class GlyphlessCodes {
  private readonly byChar = new Map<string, number>();
  private readonly chars: string[] = [];

  /** The codes for `text`, one per code point. ATOMIC: a string that would push
   *  the font past 65,535 characters assigns nothing and throws `RangeError`,
   *  so one oversized page cannot poison the pages after it. */
  encode(text: string): number[] {
    const fresh = new Set<string>();
    for (const ch of text) if (!this.byChar.has(ch)) fresh.add(ch);
    if (this.chars.length + fresh.size > MAX_CODES)
      throw new RangeError(`glyphless font: more than ${MAX_CODES} distinct characters`);
    for (const ch of fresh) { this.chars.push(ch); this.byChar.set(ch, this.chars.length); }
    return [...text].map((ch) => this.byChar.get(ch)!);
  }

  get maxCode(): number { return this.chars.length; }

  entries(): [number, string][] { return this.chars.map((ch, i) => [i + 1, ch]); }
}

export interface GlyphlessFont {
  /** The Type0 font dictionary, to register in a page's `/Resources /Font`. */
  font: PdfRef;
  /** Write `/CIDToGIDMap` and `/ToUnicode` from the final assigner. */
  finish(codes: GlyphlessCodes): void;
}

const pstr = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const empty = (): PdfStream => ({ kind: 'stream', dict: new Map(), raw: new Uint8Array(0) });

/** Allocate the glyphless font's objects. `/CIDToGIDMap` and `/ToUnicode` are
 *  placeholders until {@link GlyphlessFont.finish} replaces them in place. */
export function createGlyphlessFont(
  alloc: (o: PdfObject) => PdfRef,
  replace: (r: PdfRef, o: PdfObject) => void,
): GlyphlessFont {
  const bytes = glyphlessProgram();
  const descriptor: PdfDict = new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name(FONT_NAME)], ['Flags', 4],
    ['FontBBox', [0, -200, GLYPHLESS_ADVANCE, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile2', alloc(flateStream(bytes, { Length1: bytes.length }))],
  ]);
  const cidToGid = alloc(empty());
  const toUnicode = alloc(empty());
  const cidFont: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('CIDFontType2')], ['BaseFont', name(FONT_NAME)],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', pstr('Adobe')], ['Ordering', pstr('Identity')], ['Supplement', 0],
    ])],
    ['FontDescriptor', alloc(descriptor)], ['CIDToGIDMap', cidToGid], ['DW', GLYPHLESS_ADVANCE],
  ]);
  const font = alloc(new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')], ['BaseFont', name(FONT_NAME)],
    ['Encoding', name('Identity-H')], ['DescendantFonts', [alloc(cidFont)]], ['ToUnicode', toUnicode],
  ]));
  return {
    font,
    finish(codes: GlyphlessCodes): void {
      const max = codes.maxCode;
      const map = new Uint8Array((max + 1) * 2);
      const v = new DataView(map.buffer);
      for (let c = 1; c <= max; c++) v.setUint16(c * 2, 1);
      replace(cidToGid, flateStream(map));
      replace(toUnicode, flateStream(buildToUnicode(codes.entries())));
    },
  };
}
