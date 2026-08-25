import { describe, it, expect } from 'vitest';
import * as pkg from '../src/index.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { PdfDict, PdfObject, PdfStream, isStream, name } from '../src/types.js';
import { buildWholeFontPdf, buildSimpleTtfPdf, buildSharedProgramPdf, buildSimpleCffPdf, buildCffOttoPdf, customGlyphNames } from './helpers/build-optimize-pdf.js';
import { CffFont } from '../src/cff.js';
import { buildSimpleImagePdf, buildTwinImagePdf } from './helpers/build-imageopt-pdf.js';
import { buildCmapTable, buildPostV2 } from './helpers/build-sfnt.js';
import { parseSfnt } from '../src/sfnt.js';
import { decodeStream } from '../src/filters.js';

/** The /FontFile2 program of the document's one simple font. */
function embeddedProgram(doc: Document, key = 'F1'): PdfStream {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const font = doc.resolve(fonts.get(key)) as PdfDict;
  const fd = doc.resolve(font.get('FontDescriptor')) as PdfDict;
  const s = doc.resolve(fd.get('FontFile2'));
  if (!isStream(s)) throw new Error('no FontFile2');
  return s;
}

/** The /FontFile2 of the document's Type0 font, reached through its descendant
 *  CIDFont — which is where a Type0's /FontDescriptor actually lives. */
function type0Program(doc: Document, key = 'F1'): PdfStream {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const font = doc.resolve(fonts.get(key)) as PdfDict;
  const descendants = doc.resolve(font.get('DescendantFonts')) as PdfObject[];
  const d0 = doc.resolve(descendants[0]) as PdfDict;
  const fd = doc.resolve(d0.get('FontDescriptor')) as PdfDict;
  const s = doc.resolve(fd.get('FontFile2'));
  if (!isStream(s)) throw new Error('no FontFile2');
  return s;
}

describe('Document.Optimize', () => {
  it('drops unused glyphs from an already-embedded font', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const report = doc.Optimize();
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].gidsDropped).toBeGreaterThan(0);
    expect(report.fonts[0].baseFont).toBe('TestFont');
  });

  it('produces a smaller, re-openable document', () => {
    const before = buildWholeFontPdf('<0001>');
    const doc = Document.Open(before);
    doc.Optimize();
    const after = doc.Save();
    expect(after.length).toBeLessThan(before.length);
    expect(Document.Open(after).Pages.length).toBe(1);
  });

  it('preserves extracted text exactly', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const textBefore = doc.Pages[0].GetText();
    doc.Optimize();
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(textBefore);
  });

  it('honors per-concern opt-out', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const report = doc.Optimize({ fonts: false });
    expect(report.fonts).toEqual([]);
  });

  it('is idempotent — a second run finds nothing more to drop', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    doc.Optimize();
    const second = doc.Optimize();
    expect(second.fonts.every((f) => f.gidsDropped === 0)).toBe(true);
    expect(second.dedup.merged).toBe(0);
  });

  it('reports a skipped font instead of blanking it', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    // A Type0 with a non-Identity-H encoding cannot be resolved -> must skip.
    const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
    const fonts = doc.resolve(res.get('Font')) as PdfDict;
    (doc.resolve(fonts.get('F1')) as PdfDict).set('Encoding', name('UniGB-UCS2-H'));
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped.length).toBeGreaterThan(0);
    expect(report.skipped[0].reason).toMatch(/Identity-H/);
  });

  it('throws on a signed document rather than silently discarding the work', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    doc.catalog().set('AcroForm', doc.allocObject(new Map<string, PdfObject>([
      ['Fields', [doc.allocObject(new Map<string, PdfObject>([
        ['FT', name('Sig')], ['T', { kind: 'string', bytes: new TextEncoder().encode('sig1') }],
      ]))]],
    ])));
    expect(() => doc.Optimize()).toThrow(UnsupportedFeatureError);
  });
});

describe('Optimize — simple TrueType', () => {
  it('subsets a simple /TrueType font instead of skipping it', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding') }));
    const report = doc.Optimize();
    expect(report.skipped).toEqual([]);
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].gidsKept).toBe(2);          // .notdef + 'A'
    expect(report.fonts[0].gidsDropped).toBe(198);
    expect(report.fonts[0].bytesSaved).toBeGreaterThan(0);
  });

  it('preserves extracted text exactly and re-opens', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding') }));
    const before = doc.Pages[0].GetText();
    doc.Optimize();
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toBe(before);
    expect(before).toBe('A');
  });

  it('keeps the cmap and post tables the code->GID chain runs through', () => {
    const doc = Document.Open(buildSimpleTtfPdf({
      post: buildPostV2(customGlyphNames(200)),
      encoding: new Map<string, PdfObject>([['Differences', [65, name('g03')]]]),
    }));
    expect(doc.Optimize().fonts[0].gidsKept).toBe(2);   // .notdef + g03
    const f = parseSfnt(decodeStream(embeddedProgram(Document.Open(doc.Save()))));
    expect(f.numGlyphs).toBe(200);                      // numbering untouched
    expect(f.postNames()![3]).toBe('g03');
    expect(f.cmapLookup(0x41)).toBe(1);
    expect(f.glyphData(3).length).toBeGreaterThan(0);   // the shown glyph survives
    expect(f.glyphData(4).length).toBe(0);              // an unused one is blanked
  });

  it('leaves a simple TrueType with no usable cmap untouched, with a reason', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ cmap: buildCmapTable([]) }));
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped[0].reason).toMatch(/no usable cmap/);
  });
});

describe('Optimize — public surface and end-to-end guards', () => {
  it('exposes Optimize on the Document exported from the package root', () => {
    // Types are erased at runtime; assert the entry point loads and Optimize exists.
    expect(typeof pkg.Document.Open(buildWholeFontPdf()).Optimize).toBe('function');
  });

  it('keeps a glyph that is only ever shown from an annotation appearance', () => {
    const doc = pkg.Document.Open(buildWholeFontPdf('<0001>'));
    const page = doc.Pages[0];
    const res = doc.resolve(page.Dict.get('Resources')) as PdfDict;
    const body = 'BT /F1 12 Tf <0002> Tj ET';
    const ap = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 100, 100]],
        ['Resources', new Map<string, PdfObject>([['Font', res.get('Font') as PdfDict]])],
        ['Length', body.length],
      ]),
      raw: new TextEncoder().encode(body),
    });
    page.Dict.set('Annots', [doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Stamp')],
      ['Rect', [0, 0, 100, 100]], ['AP', new Map<string, PdfObject>([['N', ap]])],
    ]))]);

    const report = doc.Optimize();
    // gid 2 is used only by the appearance stream; it must survive.
    expect(report.fonts[0].gidsKept).toBeGreaterThanOrEqual(3); // {0, 1, 2}
    expect(pkg.Document.Open(doc.Save()).Pages.length).toBe(1);
  });
});

describe('Optimize({ images })', () => {
  /** The live image stream stored at `num`. */
  function imageAt(doc: Document, num: number): PdfStream {
    const o = doc.getObject(num);
    if (!isStream(o)) throw new Error(`object ${num} is not a stream`);
    return o;
  }

  it('touches no image and reports lossy: false with no args', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const before = imageAt(doc, imgObjNum).raw.slice();
    const r = doc.Optimize();
    expect(r.lossy).toBe(false);
    expect(r.images).toEqual([]);
    expect([...imageAt(doc, imgObjNum).raw]).toEqual([...before]);
  });

  it('reports lossy: true and shrinks the image when opted in', () => {
    const { bytes } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const r = doc.Optimize({ images: { dpi: 72 } });
    expect(r.lossy).toBe(true);
    expect(r.images).toHaveLength(1);
    expect(r.images[0].bytesSaved).toBeGreaterThan(0);
    expect(r.bytesSaved).toBeGreaterThanOrEqual(r.images[0].bytesSaved);
  });

  it('dedups two identical images that recompression made identical', () => {
    // Guards the pass order: images must run BEFORE dedup.
    const { bytes } = buildTwinImagePdf();
    const doc = Document.Open(bytes);
    const r = doc.Optimize({ images: { dpi: 72 } });
    expect(r.images).toHaveLength(2);
    expect(r.dedup.merged).toBeGreaterThanOrEqual(1);
  });
});

describe('Optimize — post glyph names', () => {
  const namedPost = () => buildPostV2(customGlyphNames(200));

  it('drops post names from a Type0 program, which never resolves by name', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>', { post: namedPost() }));
    expect(parseSfnt(decodeStream(type0Program(doc))).postNames()![3]).toBe('g03');

    const report = doc.Optimize();
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].bytesSaved).toBeGreaterThan(0);   // strictly smaller

    const after = parseSfnt(decodeStream(type0Program(Document.Open(doc.Save()))));
    expect(after.postNames()).toBeUndefined();
    expect(after.table('post')!.length).toBe(32);   // v3.0 header only
    expect(after.numGlyphs).toBe(200);              // GID numbering still intact
  });

  it('preserves extracted text exactly when post names are dropped', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>', { post: namedPost() }));
    const before = doc.Pages[0].GetText();
    doc.Optimize();
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(before);
  });

  it('keeps post names on a program a simple font dict also reaches', () => {
    const doc = Document.Open(buildSharedProgramPdf());
    doc.Optimize();
    // /F2 is the simple dict; it shares /F1's descriptor, so either path finds
    // the same program.
    const after = parseSfnt(decodeStream(embeddedProgram(Document.Open(doc.Save()), 'F2')));
    expect(after.postNames()![3]).toBe('g03');
  });

  it('keeps the glyphs of every font dict reaching one shared program', () => {
    const doc = Document.Open(buildSharedProgramPdf());
    doc.Optimize();
    // /F1 (Type0) shows gid 1; /F2 (simple) shows gid 3 via /Differences -> post.
    // One program serves both, so the shrink must keep the union, not whichever
    // dict ran last.
    const after = parseSfnt(decodeStream(embeddedProgram(Document.Open(doc.Save()), 'F2')));
    expect(after.glyphData(1).length).toBeGreaterThan(0);
    expect(after.glyphData(3).length).toBeGreaterThan(0);
    expect(after.glyphData(2).length).toBe(0);   // still shrunk: gid 2 is unused
  });

  it('reports one entry per shared program, not one per font dict', () => {
    const doc = Document.Open(buildSharedProgramPdf());
    const report = doc.Optimize();
    expect(report.skipped).toEqual([]);
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].gidsKept).toBe(3);   // .notdef + gid 1 + gid 3
  });
});

/** The /FontFile3 program of the document's one simple CFF font. */
function cffProgram(doc: Document): PdfStream {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const font = doc.resolve(fonts.get('F1')) as PdfDict;
  const fd = doc.resolve(font.get('FontDescriptor')) as PdfDict;
  const s = doc.resolve(fd.get('FontFile3'));
  if (!isStream(s)) throw new Error('no FontFile3');
  return s;
}

describe('Optimize — simple CFF', () => {
  it('subsets a simple /Type1C font instead of skipping it', () => {
    const doc = Document.Open(buildSimpleCffPdf());
    const report = doc.Optimize();
    expect(report.skipped).toEqual([]);
    expect(report.fonts.length).toBe(1);
    expect(report.fonts[0].gidsKept).toBe(2);          // .notdef + 'A'
    expect(report.fonts[0].gidsDropped).toBe(6);
  });

  it('preserves extracted text exactly and re-opens', () => {
    const doc = Document.Open(buildSimpleCffPdf());
    const before = doc.Pages[0].GetText();
    doc.Optimize();
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(before);
  });

  it('leaves the program name-keyed, not CID-keyed', () => {
    const doc = Document.Open(buildSimpleCffPdf());
    doc.Optimize();
    const f = new CffFont(decodeStream(cffProgram(Document.Open(doc.Save()))));
    expect(f.isCID).toBe(false);
    expect(f.charsetNames()[1]).toBe('A');
    expect(f.charsetNames()[2]).toBe('g07');
    expect(f.builtinEncoding()!.get(0x41)).toBe(1);
  });

  it('keeps the shown glyph drawable and blanks an unused one', () => {
    const orig = new CffFont(decodeStream(cffProgram(Document.Open(buildSimpleCffPdf()))));
    const doc = Document.Open(buildSimpleCffPdf());
    doc.Optimize();
    const f = new CffFont(decodeStream(cffProgram(Document.Open(doc.Save()))));
    expect(f.glyphPath(1)).toEqual(orig.glyphPath(1));   // 'A' still drawn
    expect(f.glyphPath(3).length).toBe(0);               // unused, blanked
  });

  it('skips a Type1 /FontFile PFB with a reason', () => {
    const doc = Document.Open(buildSimpleCffPdf({ asPfb: true }));
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped[0].reason).toMatch(/CFF|PFB/i);
  });
});

describe('Optimize — OpenType CFF whole-embed stays out of scope', () => {
  it('skips an /OpenType FontFile3 with CFF outlines, with a reason', () => {
    // Unchanged behavior, asserted so the Type1C dispatch cannot quietly swallow
    // it: rewrapping a shrunk CFF table into an OTTO sfnt is a separate concern.
    const doc = Document.Open(buildCffOttoPdf());
    const report = doc.Optimize();
    expect(report.fonts).toEqual([]);
    expect(report.skipped[0].reason).toMatch(/CFF-outlined|OpenType/);
  });
});
