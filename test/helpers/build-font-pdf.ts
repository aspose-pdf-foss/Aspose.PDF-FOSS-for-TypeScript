import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import { buildManyGlyphTtf } from './build-optimize-pdf.js';
import { buildCmapTable, cmapFormat0, cmapFormat4 } from './build-sfnt.js';
import { name, type PdfDict, type PdfObject } from '../../src/types.js';

/** A program whose glyphs advance 600, so a /Widths of 600 AGREES with it and
 *  any other value disagrees by a stated amount. `buildManyGlyphTtf`'s own
 *  default is 1000, which is also /DW's spec default — a fixture on that
 *  default cannot tell the program's answer from the default. */
const PROGRAM_ADVANCE = 600;

/** One cmap subtable to put in the embedded program. */
export interface CmapSpec { plat: number; enc: number }

/** The (3,1) Windows-Unicode subtable every non-symbolic font is expected to
 *  carry. 'A' (0x41) -> gid 1, 'B' (0x42) -> gid 2. */
const DEFAULT_CMAPS: CmapSpec[] = [{ plat: 3, enc: 1 }];

function programFor(cmaps: CmapSpec[]): Uint8Array {
  const subs = cmaps.map((c) => ({
    plat: c.plat, enc: c.enc,
    // A (3,0) symbolic subtable conventionally maps the F0xx private-use range
    // as well as the low codes, which is what `gidForProgram`'s 0xF000 fallback
    // is for; mapping both keeps one builder serving symbolic and not.
    data: c.plat === 1
      ? cmapFormat0({ 0x41: 1, 0x42: 2 })
      : cmapFormat4([[0x41, 1], [0x42, 2], [0xf041, 1], [0xf042, 2]]),
  }));
  return buildManyGlyphTtf(8, {
    cmap: buildCmapTable(subs),
    advance: () => PROGRAM_ADVANCE,
  });
}

/** An /Encoding written as an embedded CMap STREAM rather than a name. */
export interface EmbeddedCMapSpec {
  /** /WMode inside the CMap PROGRAM. */
  wmode?: 0 | 1;
  /** /WMode on the stream DICT; omitted leaves the key absent. 8.4.5.4-2 is
   *  about these two disagreeing, so they are stated separately. */
  dictWMode?: number;
  /** `/Name usecmap` — the CMap this one extends. */
  usecmap?: string;
  registry?: string;
  ordering?: string;
  supplement?: number;
}

/** The descendant CIDFont of a Type0 font. */
export interface Type0Spec {
  /** /Encoding — a predefined CMap NAME. Ignored when `embeddedCMap` is set. */
  encoding: string;
  /** Write /Encoding as an embedded CMap stream instead of naming one. */
  embeddedCMap?: EmbeddedCMapSpec;
  /** Embed a /FontFile2 on the descendant's descriptor. */
  embed?: boolean;
  /** /CIDToGIDMap; omitted leaves the key absent. */
  cidToGid?: string;
  /** /CIDSystemInfo entries; omitted leaves that dict absent. */
  registry?: string;
  ordering?: string;
  supplement?: number;
  /** /Subtype of the descendant; default CIDFontType2. */
  cidSubtype?: string;
}

export interface FontPdfSpec {
  /** Embed a font program (/FontFile2) on a SIMPLE font. */
  embed?: boolean;
  /** /Subtype of the simple font; default TrueType. */
  subtype?: string;
  /** Set the descriptor's Symbolic (bit 3) or Nonsymbolic (bit 6) flag.
   *  Omitted sets Nonsymbolic, which is the conformant default here. */
  symbolic?: boolean;
  /** /Encoding as a base-encoding name; omitted leaves the key absent. */
  encoding?: string;
  /** /Encoding as a dict with a /Differences array, code -> glyph name. */
  differences?: Record<number, string>;
  /** cmap subtables the embedded program carries; default (3,1). */
  cmaps?: CmapSpec[];
  /** /Widths entries, code -> glyph-space width. Omitted states 600 for the
   *  codes drawn, which AGREES with the program. `{}` states an empty array,
   *  so the dictionary covers no code at all. */
  widths?: Record<number, number>;
  /** Shorthand: state a /Widths that disagrees with the program by this much. */
  widthsDisagreeBy?: number;
  /** /MissingWidth on the descriptor. */
  missingWidth?: number;
  /** Draw a Type0 font instead of a simple one. */
  type0?: Type0Spec;
  /** Text to show; default 'A'. */
  text?: string;
  /** /Tr to set before showing. */
  mode?: number;
  /** Omit /ToUnicode entirely. Default writes one covering the text drawn. */
  noToUnicode?: boolean;
  /** /ToUnicode mapping, code -> Unicode code point, instead of the default. */
  toUnicodeFor?: Record<number, number>;
}

const str = (s: string): PdfObject =>
  ({ kind: 'string', bytes: new TextEncoder().encode(s) });

const stream = (dict: PdfDict, raw: Uint8Array): PdfObject =>
  ({ kind: 'stream', dict, raw });

/** 32000-2 Table 121 font descriptor flags. Bit 3 is Symbolic (value 4) and
 *  bit 6 is Nonsymbolic (value 32) — they are bit POSITIONS counted from 1, so
 *  the values are 2^(n-1). Checked against the table, not recalled. */
const FLAG_SYMBOLIC = 4;
const FLAG_NONSYMBOLIC = 32;

/** A /ToUnicode CMap stream mapping each code to a code point. */
function toUnicodeStream(map: Record<number, number>): PdfObject {
  const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
  const entries = Object.entries(map)
    .map(([code, cp]) => `<${hex(Number(code), 2)}> <${hex(cp, 4)}>`);
  const text = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin begincmap',
    '/CMapName /Test def /CMapType 2 def',
    '1 begincodespacerange <00> <FF> endcodespacerange',
    `${entries.length} beginbfchar`,
    ...entries,
    'endbfchar',
    'endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const raw = new TextEncoder().encode(text);
  return stream(new Map<string, PdfObject>([['Length', raw.length]]), raw);
}

/** An embedded CID CMap stream. `/Registry` and `/Ordering` are written as
 *  literal strings, which `parseCidCMap` reads as `str` tokens exactly as it
 *  reads hex ones. */
function cmapStream(spec: EmbeddedCMapSpec): PdfObject {
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
  ];
  if (spec.usecmap !== undefined) lines.push(`/${spec.usecmap} usecmap`);
  lines.push(
    `/CIDSystemInfo << /Registry (${spec.registry ?? 'Adobe'}) `
      + `/Ordering (${spec.ordering ?? 'Identity'}) `
      + `/Supplement ${spec.supplement ?? 0} >> def`,
    '/CMapName /Test-H def',
    '/CMapType 1 def',
    `/WMode ${spec.wmode ?? 0} def`,
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '1 begincidrange',
    '<0000> <FFFF> 0',
    'endcidrange',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  );
  const raw = new TextEncoder().encode(lines.join('\n'));
  const dict = new Map<string, PdfObject>([
    ['Type', name('CMap')],
    ['CMapName', name('Test-H')],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', str(spec.registry ?? 'Adobe')],
      ['Ordering', str(spec.ordering ?? 'Identity')],
      ['Supplement', spec.supplement ?? 0],
    ])],
    ['Length', raw.length],
  ]);
  if (spec.dictWMode !== undefined) dict.set('WMode', spec.dictWMode);
  return stream(dict, raw);
}

/**
 * A tagged, titled one-page document drawing `spec.text` in a font built to
 * order.
 *
 * The font dict is written BY HAND rather than through `AddFont`, because the
 * authoring API always embeds and always writes a conformant descriptor — so it
 * provably cannot produce the documents these rules are about. The struct tree
 * and the document metadata go through the API, since `validatePdfUa`
 * short-circuits on an untagged document and every rule would then be silent.
 *
 * The drawn text is deliberately NOT marked content. These rules read
 * `/Resources /Font` and the glyphs a page shows; neither needs the text
 * tagged, and leaving it loose keeps the fixture about fonts. `UntaggedContent`
 * therefore reports on every document here, which no assertion looks at.
 */
export function buildFontPdf(spec: FontPdfSpec): Uint8Array {
  const doc = Document.Open(buildStampTarget());
  doc.Lang = 'en-US';
  doc.SetMetadata({ title: 'T' });
  doc.DisplayDocTitle = true;
  doc.CreateStructTree().Append('Document');

  const page = doc.Pages[0];
  const text = spec.text ?? 'A';
  const codes = [...new Set([...text].map((ch) => ch.charCodeAt(0)))];

  // ---- the font program ---------------------------------------------------
  const program = programFor(spec.cmaps ?? DEFAULT_CMAPS);
  const fontFile = (): PdfObject => doc.allocObject(stream(
    new Map<string, PdfObject>([['Length1', program.length]]), program,
  ));

  // ---- the descriptor ------------------------------------------------------
  const symbolic = spec.symbolic === true;
  const descriptor = new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')],
    ['FontName', name('TestFont')],
    ['Flags', symbolic ? FLAG_SYMBOLIC : FLAG_NONSYMBOLIC],
    ['ItalicAngle', 0], ['Ascent', 800], ['Descent', -200],
    ['CapHeight', 700], ['StemV', 80], ['FontBBox', [0, -200, 600, 800]],
  ]);
  if (spec.missingWidth !== undefined) descriptor.set('MissingWidth', spec.missingWidth);

  // ---- the font dict -------------------------------------------------------
  let fontRef: PdfObject;
  if (spec.type0 !== undefined) {
    const t0 = spec.type0;
    if (t0.embed === true) descriptor.set('FontFile2', fontFile());
    const cidFont = new Map<string, PdfObject>([
      ['Type', name('Font')],
      ['Subtype', name(t0.cidSubtype ?? 'CIDFontType2')],
      ['BaseFont', name('TestFont')],
      ['FontDescriptor', doc.allocObject(descriptor)],
      ['DW', 1000],
    ]);
    if (t0.cidToGid !== undefined) cidFont.set('CIDToGIDMap', name(t0.cidToGid));
    if (t0.registry !== undefined || t0.ordering !== undefined) {
      const csi = new Map<string, PdfObject>();
      if (t0.registry !== undefined) csi.set('Registry', str(t0.registry));
      if (t0.ordering !== undefined) csi.set('Ordering', str(t0.ordering));
      csi.set('Supplement', t0.supplement ?? 0);
      cidFont.set('CIDSystemInfo', csi);
    }
    const font = new Map<string, PdfObject>([
      ['Type', name('Font')],
      ['Subtype', name('Type0')],
      ['BaseFont', name('TestFont')],
      ['Encoding', t0.embeddedCMap !== undefined
        ? doc.allocObject(cmapStream(t0.embeddedCMap))
        : name(t0.encoding)],
      ['DescendantFonts', [doc.allocObject(cidFont)]],
    ]);
    if (spec.noToUnicode !== true) {
      font.set('ToUnicode', doc.allocObject(toUnicodeStream(
        spec.toUnicodeFor ?? Object.fromEntries(codes.map((c) => [c, c])),
      )));
    }
    fontRef = doc.allocObject(font);
  } else {
    if (spec.embed === true) descriptor.set('FontFile2', fontFile());
    const subtype = spec.subtype ?? 'TrueType';
    const font = new Map<string, PdfObject>([
      ['Type', name('Font')],
      ['Subtype', name(subtype)],
      ['BaseFont', name('TestFont')],
    ]);
    // A Type3 font needs the three keys that make it one; without them the
    // parser cannot build a TextFont and the glyph walk emits nothing.
    if (subtype === 'Type3') {
      font.set('FontMatrix', [0.001, 0, 0, 0.001, 0, 0]);
      font.set('CharProcs', new Map<string, PdfObject>());
      font.set('FontBBox', [0, 0, 0, 0]);
    } else {
      font.set('FontDescriptor', doc.allocObject(descriptor));
    }
    if (spec.differences !== undefined) {
      const diffs: PdfObject[] = [];
      for (const [code, glyph] of Object.entries(spec.differences)) {
        diffs.push(Number(code), name(glyph));
      }
      font.set('Encoding', new Map<string, PdfObject>([
        ['Type', name('Encoding')],
        ['BaseEncoding', name(spec.encoding ?? 'WinAnsiEncoding')],
        ['Differences', diffs],
      ]));
    } else if (spec.encoding !== undefined) {
      font.set('Encoding', name(spec.encoding));
    }
    // /Widths: by default state the program's own advance, so the font AGREES
    // with itself and only a fixture that asks for a disagreement gets one.
    const widths = spec.widthsDisagreeBy !== undefined
      ? Object.fromEntries(codes.map((c) => [c, PROGRAM_ADVANCE + spec.widthsDisagreeBy!]))
      : spec.widths ?? Object.fromEntries(codes.map((c) => [c, PROGRAM_ADVANCE]));
    const keys = Object.keys(widths).map(Number).sort((a, b) => a - b);
    if (keys.length > 0) {
      const first = keys[0];
      const last = keys[keys.length - 1];
      const arr: PdfObject[] = [];
      for (let c = first; c <= last; c++) arr.push(widths[c] ?? 0);
      font.set('FirstChar', first);
      font.set('LastChar', last);
      font.set('Widths', arr);
    }
    if (spec.noToUnicode !== true) {
      font.set('ToUnicode', doc.allocObject(toUnicodeStream(
        spec.toUnicodeFor ?? Object.fromEntries(codes.map((c) => [c, c])),
      )));
    }
    fontRef = doc.allocObject(font);
  }

  // ---- resources and content ----------------------------------------------
  const res = page.Dict.get('Resources');
  const resolved = doc.resolve(res);
  const resources = resolved instanceof Map
    ? resolved
    : new Map<string, PdfObject>();
  const fonts = new Map<string, PdfObject>([['F1', fontRef]]);
  resources.set('Font', fonts);
  page.Dict.set('Resources', resources);

  const esc = (s: string): string => s.replace(/[\\()]/g, (c) => `\\${c}`);
  // A Type0 font's show string is two bytes per CID under Identity-H and the
  // predefined CMaps used here, so the codes are written as a hex string.
  const show = spec.type0 !== undefined
    ? `<${[...text].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0')).join('')}> Tj`
    : `(${esc(text)}) Tj`;
  const content = [
    spec.mode === undefined ? '' : `${spec.mode} Tr`,
    'BT /F1 12 Tf',
    '1 0 0 1 72 700 Tm',
    show,
    'ET',
  ].filter((l) => l !== '').join('\n');
  const raw = new TextEncoder().encode(content);
  page.Dict.set('Contents', doc.allocObject(
    stream(new Map<string, PdfObject>([['Length', raw.length]]), raw),
  ));

  doc.markModified();
  return doc.Save();
}
