// Builds a PDF that embeds the WHOLE (unsubset) test font as a Type0/
// CIDFontType2 with CIDToGIDMap /Identity, and shows only glyph 1 ('A').
// This is the shape a real producer emits, and the shape AddFont never emits
// (AddFont subsets at Save), so it is the only way to exercise shrinking.
import { deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, name, ref } from '../../src/types.js';
import { buildCmap, buildHead, buildName, buildOS2, buildPost, buildPostV2 } from './build-sfnt.js';
import { buildNameKeyedCff, buildCffOtto } from './build-cff.js';
import { serializeDocument } from '../../src/serializer.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

const u16 = (n: number): Uint8Array => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return b; };
const i16 = (n: number): Uint8Array => { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, n); return b; };
const u32 = (n: number): Uint8Array => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; };
const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const pad4 = (b: Uint8Array): Uint8Array => {
  const r = b.length % 4; return r ? concat([b, new Uint8Array(4 - r)]) : b;
};

/** A 4-point box glyph whose coordinates vary with `seed`, so the glyphs differ
 *  from one another the way a real font's do. Identical glyphs would deflate to
 *  almost nothing and the whole font would already be small — which is exactly
 *  the case that cannot demonstrate shrinking. 34 bytes, even-length. */
function boxGlyph(seed: number): Uint8Array {
  const x0 = 50 + (seed * 7) % 300;
  const y0 = (seed * 11) % 200;
  const x1 = x0 + 200 + (seed * 13) % 300;
  const y1 = y0 + 300 + (seed * 17) % 300;
  const xs = [x0, x1, x1, x0];
  const ys = [y0, y0, y1, y1];
  const xd: Uint8Array[] = []; let px = 0; for (const x of xs) { xd.push(i16(x - px)); px = x; }
  const yd: Uint8Array[] = []; let py = 0; for (const y of ys) { yd.push(i16(y - py)); py = y; }
  return concat([
    i16(1),                                      // numberOfContours
    i16(x0), i16(y0), i16(x1), i16(y1),          // bbox
    u16(3), u16(0),                              // endPtsOfContours[0], instructionLength
    new Uint8Array([1, 1, 1, 1]),                // flags: on-curve, int16 x/y deltas
    ...xd, ...yd,
  ]);
}

/** A whole TrueType font of `n` glyphs: 0=.notdef (empty), 1..n-1 distinct
 *  boxes, cmap mapping 'A'->1 / 'B'->2. Big enough that dropping the unused
 *  glyphs is a real, measurable saving. */
export function buildManyGlyphTtf(n: number, over: { cmap?: Uint8Array; post?: Uint8Array; os2?: Uint8Array; advance?: (gid: number) => number } = {}): Uint8Array {
  const glyphs: Uint8Array[] = [new Uint8Array(0)];
  for (let gid = 1; gid < n; gid++) glyphs.push(boxGlyph(gid));
  const glyf = concat(glyphs);
  const offsets: number[] = [0];
  let off = 0;
  for (const g of glyphs) { off += g.length; offsets.push(off); }
  const loca = concat(offsets.map((o) => u16(o / 2))); // short loca

  const maxp = new Uint8Array(32);
  { const v = new DataView(maxp.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, n); }
  const hhea = new Uint8Array(36);
  { const v = new DataView(hhea.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, n); }
  // Per-gid advances so a test can tell the PROGRAM's answer from /DW, whose
  // spec default is 1000 -- the same number this used to hardcode.
  const hmtx = concat(glyphs.map((_, gid) => concat([u16(over.advance?.(gid) ?? 1000), i16(0)])));

  const tables: { tag: string; data: Uint8Array }[] = [
    { tag: 'OS/2', data: over.os2 ?? buildOS2() }, { tag: 'cmap', data: over.cmap ?? buildCmap() },
    { tag: 'glyf', data: glyf }, { tag: 'head', data: buildHead() },
    { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp },
    { tag: 'name', data: buildName() }, { tag: 'post', data: over.post ?? buildPost() },
  ];
  const numTables = tables.length;
  let at = 12 + numTables * 16;
  const placed = tables.map((t) => {
    const start = at; const padded = pad4(t.data); at += padded.length;
    return { tag: t.tag, at: start, length: t.data.length, padded };
  });
  const offsetTable = concat([u32(0x00010000), u16(numTables), u16(0), u16(0), u16(0)]);
  const dir = concat(placed.map((p) => concat([enc(p.tag), u32(0), u32(p.at), u32(p.length)])));
  return concat([offsetTable, dir, ...placed.map((p) => p.padded)]);
}

export interface SimpleTtfOptions {
  /** The font's cmap table; defaults to the (3,1) Unicode one ('A'->1, 'B'->2). */
  cmap?: Uint8Array;
  /** The font's post table; defaults to v3.0 (no glyph names). */
  post?: Uint8Array;
  /** The font's OS/2 table; defaults to the standard one. */
  os2?: Uint8Array;
  /** The font dict's /Encoding value. Omitted entirely when undefined, which
   *  hands the font program's built-in encoding the decision. */
  encoding?: PdfObject;
  /** /FontDescriptor /Flags. Defaults to 32 (nonsymbolic). */
  flags?: number;
  /** The show operand; defaults to the literal string `(A)`. */
  content?: string;
  /** Full content-stream body override (ignores `content` when set). */
  body?: string;
  /** A `/ToUnicode` CMap stream; when set it is attached to the font dict. */
  toUnicode?: Uint8Array;
}

/** Glyph names for an `n`-glyph font, none of them in the Adobe Glyph List — the
 *  shape a subsetting producer emits, and the case only `post` can resolve. */
export function customGlyphNames(n: number): string[] {
  const names = ['.notdef'];
  for (let g = 1; g < n; g++) names.push(`g${String(g).padStart(2, '0')}`);
  return names;
}

/** A PDF embedding the whole 200-glyph test font as a *simple* /TrueType font.
 *  Everything a code->GID chain reads is a knob, so each chain in 9.6.6.4 can be
 *  exercised on its own. */
export function buildSimpleTtfPdf(o: SimpleTtfOptions = {}): Uint8Array {
  const ttf = buildManyGlyphTtf(200, { cmap: o.cmap, post: o.post, os2: o.os2 });
  const objects = new Map<number, PdfObject>();

  objects.set(6, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')], ['Length1', ttf.length]]),
    raw: new Uint8Array(deflateSync(Buffer.from(ttf))),
  });

  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestFont')],
    ['Flags', o.flags ?? 32], ['FontBBox', [0, -200, 700, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile2', ref(6, 0)],
  ]));

  const font = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('TrueType')],
    ['BaseFont', name('TestFont')],
    ['FirstChar', 65], ['LastChar', 66], ['Widths', [500, 600]],
    ['FontDescriptor', ref(7, 0)],
  ]);
  if (o.encoding !== undefined) font.set('Encoding', o.encoding);
  if (o.toUnicode !== undefined) {
    objects.set(9, {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Length', o.toUnicode.length]]),
      raw: o.toUnicode,
    });
    font.set('ToUnicode', ref(9, 0));
  }
  objects.set(4, font);

  const body = o.body ?? `BT /F1 24 Tf 50 700 Td ${o.content ?? '(A)'} Tj ET`;
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(8, 0)]]));

  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}

export interface SimpleCffOptions {
  /** The font dict's /Encoding value. Omitted entirely when undefined, which
   *  hands the CFF's built-in encoding the decision. */
  encoding?: PdfObject;
  /** Embed as /FontFile (a PFB stub) instead of /FontFile3 /Type1C — the shape
   *  with no CFF for the chain to resolve against. */
  asPfb?: boolean;
  /** The show operand; defaults to the literal string `(A)`. */
  content?: string;
}

/** A PDF embedding {@link buildNameKeyedCff}(8) as a simple /Type1 font. gid1 is
 *  'A' (standard SID), gid2 is 'g07' (custom SID); the CFF's built-in Encoding
 *  maps 'A'->1 and 'B'->2. Every knob the code->GID chains read is a parameter,
 *  so each chain can be exercised on its own. */
export function buildSimpleCffPdf(o: SimpleCffOptions = {}): Uint8Array {
  const cff = buildNameKeyedCff(8);
  const objects = new Map<number, PdfObject>();

  objects.set(6, {
    kind: 'stream',
    dict: new Map<string, PdfObject>(
      o.asPfb
        ? [['Filter', name('FlateDecode')], ['Length1', cff.length]]
        : [['Filter', name('FlateDecode')], ['Subtype', name('Type1C')]],
    ),
    raw: new Uint8Array(deflateSync(Buffer.from(cff))),
  });

  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestCff')],
    ['Flags', 32], ['FontBBox', [0, -200, 1000, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    [o.asPfb ? 'FontFile' : 'FontFile3', ref(6, 0)],
  ]));

  const font = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')],
    ['BaseFont', name('TestCff')],
    ['FirstChar', 65], ['LastChar', 66], ['Widths', [500, 600]],
    ['FontDescriptor', ref(7, 0)],
  ]);
  if (o.encoding !== undefined) font.set('Encoding', o.encoding);
  objects.set(4, font);

  const body = `BT /F1 24 Tf 50 700 Td ${o.content ?? '(A)'} Tj ET`;
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(8, 0)]]));

  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}

/** A PDF embedding an OTTO (OpenType-CFF) whole-embed as a simple /TrueType font
 *  via an /OpenType /FontFile3. Out of scope for shrinking — rewrapping a shrunk
 *  CFF table back into an sfnt is its own concern — so this exists to prove the
 *  Type1C path does not quietly swallow it. */
export function buildCffOttoPdf(): Uint8Array {
  const otto = buildCffOtto();
  const objects = new Map<number, PdfObject>();

  objects.set(6, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')], ['Subtype', name('OpenType')]]),
    raw: new Uint8Array(deflateSync(Buffer.from(otto))),
  });

  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestOtto')],
    ['Flags', 32], ['FontBBox', [0, -200, 1000, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile3', ref(6, 0)],
  ]));

  objects.set(4, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('TrueType')],
    ['BaseFont', name('TestOtto')],
    ['FirstChar', 65], ['LastChar', 66], ['Widths', [500, 600]],
    ['FontDescriptor', ref(7, 0)], ['Encoding', name('WinAnsiEncoding')],
  ]));

  const body = 'BT /F1 24 Tf 50 700 Td (A) Tj ET';
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(8, 0)]]));

  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}

/** `content` defaults to showing CID 1 only (glyph 'A'); every other CID unused.
 *  `over.post` overrides the font's post table, which defaults to v3.0. */
export function buildWholeFontPdf(content = '<0001>', over: { post?: Uint8Array } = {}): Uint8Array {
  const ttf = buildManyGlyphTtf(200, { post: over.post });
  const objects = new Map<number, PdfObject>();

  const fontFile: PdfObject = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Filter', name('FlateDecode')], ['Length1', ttf.length],
    ]),
    raw: new Uint8Array(deflateSync(Buffer.from(ttf))),
  };
  objects.set(6, fontFile);

  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestFont')],
    ['Flags', 4], ['FontBBox', [0, -200, 700, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile2', ref(6, 0)],
  ]));

  objects.set(5, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('CIDFontType2')],
    ['BaseFont', name('TestFont')],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', { kind: 'string', bytes: enc('Adobe') }],
      ['Ordering', { kind: 'string', bytes: enc('Identity') }],
      ['Supplement', 0],
    ])],
    ['FontDescriptor', ref(7, 0)], ['CIDToGIDMap', name('Identity')],
    ['DW', 1000], ['W', [1, [500, 600]]],
  ]));

  objects.set(4, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')],
    ['BaseFont', name('TestFont')], ['Encoding', name('Identity-H')],
    ['DescendantFonts', [ref(5, 0)]],
  ]));

  const body = `BT /F1 24 Tf 50 700 Td ${content} Tj ET`;
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(8, 0)],
  ]));

  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1, 0)]]);
  return serializeDocument(objects, trailer);
}

/** A PDF where a Type0 dict (/F1) and a simple /TrueType dict (/F2) share one
 *  /FontDescriptor, and so one /FontFile2. The Type0 dict alone would license
 *  dropping the program's glyph names; the simple dict must veto it. */
export function buildSharedProgramPdf(): Uint8Array {
  const ttf = buildManyGlyphTtf(200, { post: buildPostV2(customGlyphNames(200)) });
  const objects = new Map<number, PdfObject>();

  objects.set(6, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')], ['Length1', ttf.length]]),
    raw: new Uint8Array(deflateSync(Buffer.from(ttf))),
  });

  // The shared descriptor: both font dicts below point at this one object.
  objects.set(7, new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name('TestFont')],
    ['Flags', 32], ['FontBBox', [0, -200, 700, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile2', ref(6, 0)],
  ]));

  objects.set(5, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('CIDFontType2')],
    ['BaseFont', name('TestFont')],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', { kind: 'string', bytes: enc('Adobe') }],
      ['Ordering', { kind: 'string', bytes: enc('Identity') }],
      ['Supplement', 0],
    ])],
    ['FontDescriptor', ref(7, 0)], ['CIDToGIDMap', name('Identity')],
    ['DW', 1000], ['W', [1, [500, 600]]],
  ]));

  objects.set(4, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')],
    ['BaseFont', name('TestFont')], ['Encoding', name('Identity-H')],
    ['DescendantFonts', [ref(5, 0)]],
  ]));

  objects.set(9, new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('TrueType')],
    ['BaseFont', name('TestFont')],
    ['FirstChar', 65], ['LastChar', 66], ['Widths', [500, 600]],
    ['FontDescriptor', ref(7, 0)],
    ['Encoding', new Map<string, PdfObject>([['Differences', [65, name('g03')]]])],
  ]));

  const body = 'BT /F1 24 Tf 50 700 Td <0001> Tj ET BT /F2 24 Tf 50 650 Td (A) Tj ET';
  objects.set(3, {
    kind: 'stream',
    dict: new Map<string, PdfObject>([['Length', body.length]]),
    raw: enc(body),
  });

  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(8, 0)],
    ['MediaBox', [0, 0, 612, 792]], ['Contents', ref(3, 0)],
    ['Resources', new Map<string, PdfObject>([
      ['Font', new Map<string, PdfObject>([['F1', ref(4, 0)], ['F2', ref(9, 0)]])],
    ])],
  ]));
  objects.set(8, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Kids', [ref(2, 0)]], ['Count', 1],
  ]));
  objects.set(1, new Map<string, PdfObject>([['Type', name('Catalog')], ['Pages', ref(8, 0)]]));

  return serializeDocument(objects, new Map<string, PdfObject>([['Root', ref(1, 0)]]));
}
