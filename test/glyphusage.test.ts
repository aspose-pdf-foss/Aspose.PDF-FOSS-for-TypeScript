import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, name, PdfDict, PdfObject } from '../src/types.js';
import { collectGlyphUsage } from '../src/glyphusage.js';
import { buildWholeFontPdf, buildSimpleTtfPdf, buildSimpleCffPdf, customGlyphNames } from './helpers/build-optimize-pdf.js';
import { buildCmapTable, cmapFormat0, cmapFormat4, buildPostV2 } from './helpers/build-sfnt.js';

/** The page's Type0 font dict. */
function type0(doc: Document): PdfDict {
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const f = doc.resolve(fonts.get('F1'));
  if (!isDict(f)) throw new Error('no font');
  return f;
}

describe('collectGlyphUsage', () => {
  it('collects the CIDs shown by a Type0/Identity-H font as GIDs', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const usage = collectGlyphUsage(doc);
    const u = usage.get(type0(doc))!;
    expect(u).toBeDefined();
    expect(u.complete).toBe(true);
    expect([...u.gids].sort()).toEqual([1]);
  });

  it('collects every CID in a TJ array', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const usage = collectGlyphUsage(doc);
    expect([...usage.get(type0(doc))!.gids]).toContain(1);
  });

  it('maps CID->GID through a CIDToGIDMap /Identity descendant', () => {
    const doc = Document.Open(buildWholeFontPdf('<0002>'));
    const usage = collectGlyphUsage(doc);
    expect([...usage.get(type0(doc))!.gids].sort()).toEqual([2]);
  });
});

/** The page's /F1 font dict, whatever its subtype. */
const pageFont = (doc: Document): PdfDict => type0(doc);

describe('collectGlyphUsage — simple TrueType (9.6.6.4)', () => {
  it('resolves a nonsymbolic font through /Differences -> Unicode -> cmap(3,1)', () => {
    // /Differences maps code 65 to 'B', whose Unicode the (3,1) cmap sends to gid 2.
    const doc = Document.Open(buildSimpleTtfPdf({
      encoding: new Map<string, PdfObject>([['Differences', [65, name('B')]]]),
    }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(true);
    expect([...u.gids]).toEqual([2]);
  });

  it('resolves a base encoding with no /Differences through the Unicode cmap', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ encoding: name('WinAnsiEncoding') }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(true);
    expect([...u.gids]).toEqual([1]);   // 'A' -> gid 1
  });

  it('resolves a symbolic font through cmap(3,0) at the 0xF000 offset', () => {
    const doc = Document.Open(buildSimpleTtfPdf({
      flags: 4,
      cmap: buildCmapTable([{ plat: 3, enc: 0, data: cmapFormat4([[0xf041, 7]]) }]),
    }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(true);
    expect([...u.gids]).toEqual([7]);
  });

  it('resolves a symbolic font through cmap(3,0) at the raw code', () => {
    const doc = Document.Open(buildSimpleTtfPdf({
      flags: 4,
      cmap: buildCmapTable([{ plat: 3, enc: 0, data: cmapFormat4([[0x41, 9]]) }]),
    }));
    expect([...collectGlyphUsage(doc).get(pageFont(doc))!.gids]).toEqual([9]);
  });

  it('resolves a symbolic font through a Mac cmap(1,0) format 0 subtable', () => {
    const doc = Document.Open(buildSimpleTtfPdf({
      flags: 4,
      cmap: buildCmapTable([{ plat: 1, enc: 0, data: cmapFormat0({ 0x41: 11 }) }]),
    }));
    expect([...collectGlyphUsage(doc).get(pageFont(doc))!.gids]).toEqual([11]);
  });

  it('resolves a /Differences name outside the AGL through the post table', () => {
    // 'g03' has no Unicode, so only the post chain can answer.
    const doc = Document.Open(buildSimpleTtfPdf({
      post: buildPostV2(customGlyphNames(200)),
      encoding: new Map<string, PdfObject>([['Differences', [65, name('g03')]]]),
    }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(true);
    expect([...u.gids]).toEqual([3]);
  });

  it('unions every plausible chain rather than choosing one', () => {
    // Ambiguous by construction: a symbol cmap says gid 7, /Differences says
    // 'B' -> gid 2. Viewers disagree; keeping both never blanks a shown glyph.
    const doc = Document.Open(buildSimpleTtfPdf({
      flags: 4,
      cmap: buildCmapTable([
        { plat: 3, enc: 0, data: cmapFormat4([[0xf041, 7]]) },
        { plat: 3, enc: 1, data: cmapFormat4([[0x41, 1], [0x42, 2]]) },
      ]),
      encoding: new Map<string, PdfObject>([['Differences', [65, name('B')]]]),
    }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(true);
    expect([...u.gids].sort((a, b) => a - b)).toEqual([2, 7]);
  });

  it('skips a font whose cmap has no subtable any chain can read', () => {
    const doc = Document.Open(buildSimpleTtfPdf({ cmap: buildCmapTable([]) }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/no usable cmap/);
  });

  it('skips a font whose code no chain resolves', () => {
    // 'Z' is in WinAnsi but not in the font's cmap: nothing maps code 90.
    const doc = Document.Open(buildSimpleTtfPdf({ content: '(Z)' }));
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/code 90 has no GID/);
  });

  it('skips a TrueType font with no embedded program', () => {
    const doc = Document.Open(buildSimpleTtfPdf());
    const fd = doc.resolve(pageFont(doc).get('FontDescriptor')) as PdfDict;
    fd.delete('FontFile2');
    const u = collectGlyphUsage(doc).get(pageFont(doc))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/not embedded/);
  });
});

describe('collectGlyphUsage — wide sites', () => {
  it('counts glyphs shown only from an annotation /AP stream', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const page = doc.Pages[0];
    const pageRes = doc.resolve(page.Dict.get('Resources')) as PdfDict;
    const fontRef = pageRes.get('Font') as PdfDict;
    // /AP /N form XObject showing CID 2, with its own /Resources.
    const body = 'BT /F1 12 Tf <0002> Tj ET';
    const ap = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')],
        ['BBox', [0, 0, 100, 100]],
        ['Resources', new Map<string, PdfObject>([['Font', fontRef]])],
        ['Length', body.length],
      ]),
      raw: new TextEncoder().encode(body),
    });
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Stamp')],
      ['Rect', [0, 0, 100, 100]],
      ['AP', new Map<string, PdfObject>([['N', ap]])],
    ]));
    page.Dict.set('Annots', [annot]);

    const usage = collectGlyphUsage(doc);
    // CID 1 from page content, CID 2 from the annotation appearance.
    expect([...usage.get(type0(doc))!.gids].sort()).toEqual([1, 2]);
  });

  it('marks a font incomplete when its scope has an unparseable stream', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    const page = doc.Pages[0];
    // Replace /Contents with an undecodable stream (bad Flate payload).
    page.Dict.set('Contents', doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')]]),
      raw: Uint8Array.from([0, 1, 2, 3]),
    }));
    const usage = collectGlyphUsage(doc);
    const u = usage.get(type0(doc))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/failed to (parse|decode)/);
  });

  it('marks a font incomplete when it is never reached by the scan', () => {
    const doc = Document.Open(buildWholeFontPdf('<0001>'));
    // A font dict reachable in the object graph but in no walked scope.
    const orphanFont = new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type0')],
      ['BaseFont', name('Ghost')], ['Encoding', name('Identity-H')],
    ]);
    const r = doc.allocObject(orphanFont);
    doc.catalog().set('Names', r); // reachable from /Root, never scanned
    const usage = collectGlyphUsage(doc);
    expect(usage.get(orphanFont)?.complete).toBe(false);
  });
});

/** The usage entry for the document's one simple CFF font (/F1). */
function cffUsageOf(bytes: Uint8Array) {
  const doc = Document.Open(bytes);
  const res = doc.resolve(doc.Pages[0].Dict.get('Resources')) as PdfDict;
  const fonts = doc.resolve(res.get('Font')) as PdfDict;
  const font = doc.resolve(fonts.get('F1')) as PdfDict;
  return collectGlyphUsage(doc).get(font)!;
}

const differences = (code: number, glyph: string): PdfObject =>
  new Map<string, PdfObject>([['Differences', [code, name(glyph)]]]);

describe('collectGlyphUsage — simple CFF', () => {
  it('resolves a /Differences name through the charset', () => {
    const u = cffUsageOf(buildSimpleCffPdf({ encoding: differences(65, 'g07') }));
    expect(u.complete).toBe(true);
    expect([...u.gids]).toContain(2);          // 'g07' is gid 2, via a custom SID
  });

  it('resolves through the built-in Encoding when the dict has no /Encoding', () => {
    const u = cffUsageOf(buildSimpleCffPdf());  // no /Encoding -> built-in governs
    expect(u.complete).toBe(true);
    expect([...u.gids]).toContain(1);           // 'A' -> gid 1
  });

  it('unions the /Differences and built-in chains rather than choosing between them', () => {
    // Code 65: /Differences says 'g07' (gid 2), the built-in Encoding says gid 1.
    // Both are defensible and viewers disagree, so both must survive — dropping
    // either blanks a glyph some viewer shows.
    const u = cffUsageOf(buildSimpleCffPdf({ encoding: differences(65, 'g07') }));
    expect([...u.gids].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('skips a Type1 /FontFile PFB with a reason, rather than guessing', () => {
    const u = cffUsageOf(buildSimpleCffPdf({ asPfb: true }));
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/CFF|FontFile3|PFB/i);
  });

  it('skips rather than guesses when no chain resolves a shown code', () => {
    // 'Z' is in neither the built-in Encoding (only A, B) nor any /Differences,
    // and with no /Encoding the base-encoding chain does not apply.
    const u = cffUsageOf(buildSimpleCffPdf({ content: '(Z)' }));
    expect(u.complete).toBe(false);
  });
});
