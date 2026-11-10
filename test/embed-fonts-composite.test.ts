import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { isStream, type PdfDict, type PdfObject } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

const LIB = getStd14Sfnt('Helvetica')!;            // Liberation Sans
const UNI = LIB.cmapSubtable(3, 1)!;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-cid-'));
  writeFileSync(join(dir, 'LiberationSans-Regular.ttf'), LIB.raw);
});

const adv = (cp: number): number => Math.round((LIB.advanceWidth(UNI.get(cp) ?? 0) * 1000) / LIB.unitsPerEm);
/** /W giving CIDs 32..126 the face's advances for the Unicode `uni(cid)`. */
const cidW = (uni: (cid: number) => number): PdfObject => {
  const ws: number[] = [];
  for (let c = 32; c <= 126; c++) ws.push(adv(uni(c)));
  return [32, ws];
};
const IDENTITY_TU = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
  + '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
  + '1 beginbfrange <0020> <007E> <0020> endbfrange\nendcmap end end';
const spec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: 'LiberationSans', subtype: 'Type0', toUnicode: IDENTITY_TU, cidWidths: cidW((c) => c), text: 'Hello', ...o,
});
const open = (fonts: FontSpec[]): Document => {
  const doc = Document.Open(buildNonEmbeddedFontPdf(fonts));
  doc.RegisterFontFolder(dir);
  return doc;
};
const type0 = (doc: Document): PdfDict => {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
  return doc.resolve(fonts.get('F1')) as PdfDict;
};
const descendant = (doc: Document): PdfDict => doc.resolve((doc.resolve(type0(doc).get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
const gidOfCid = (doc: Document, cid: number): number => {
  const m = doc.resolve(descendant(doc).get('CIDToGIDMap'));
  if (!isStream(m)) throw new Error('no CIDToGIDMap stream');
  const b = decodeStream(m);
  return (b[cid * 2] << 8) | b[cid * 2 + 1];
};
const programOf = (doc: Document): Uint8Array => {
  const fd = doc.resolve(descendant(doc).get('FontDescriptor')) as PdfDict;
  const ff = doc.resolve(fd.get('FontFile2'));
  if (!isStream(ff)) throw new Error('no FontFile2');
  return decodeStream(ff);
};

describe('EmbedFonts: composite (Type0) fonts (g0ky.7)', () => {
  it('embeds a TrueType face as a CIDFontType2 with a CIDToGIDMap from /ToUnicode', () => {
    const doc = open([spec()]);
    const r = doc.EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toMatchObject([{ name: 'LiberationSans', source: 'registered' }]);
    const saved = Document.Open(doc.Save());
    expect(saved.Fonts[0]).toMatchObject({ embedded: true, subtype: 'Type0', descendantSubtype: 'CIDFontType2', program: 'TrueType' });
    expect(saved.Pages[0].GetText()).toBe('Hello');
    expect(gidOfCid(saved, 0x48)).toBe(UNI.get(0x48));
    expect(gidOfCid(saved, 0x6f)).toBe(UNI.get(0x6f));
  });

  it('maps through the character collection when there is no /ToUnicode', () => {
    // Adobe-Japan1 CIDs 1..95 are proportional ASCII: CID c is U+001F + c.
    // HELLO keeps every shown CID in that ASCII range.
    const doc = open([spec({ toUnicode: undefined, ordering: 'Japan1', cidWidths: cidW((c) => c + 0x1f), text: 'HELLO' })]);
    const r = doc.EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(gidOfCid(doc, 0x48)).toBe(UNI.get(0x67));
  });

  it('declines a font whose CIDs have no Unicode to find a glyph by, touching nothing', () => {
    const doc = open([spec({ toUnicode: undefined })]);
    const before = doc.Save();
    const r = doc.EmbedFonts();
    expect(r.embedded).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['cmap']);
    expect(Buffer.compare(before, doc.Save())).toBe(0);
  });

  it('declines when /W disagrees with the face, and puts the font back', () => {
    const doc = open([spec({ cidWidths: [72, [999]] })]);
    const before = doc.Save();
    const r = doc.EmbedFonts();
    expect(r.skipped.map((s) => [s.reason, s.detail])).toEqual([['width-mismatch', `CID 72: /W 999, face ${adv(0x48)}`]]);
    expect(Buffer.compare(before, doc.Save())).toBe(0);
  });

  it('declines a shown CID the face has no glyph for', () => {
    // After the bfrange, which would otherwise map 0048 back to H.
    const tu = IDENTITY_TU.replace('endcmap', '1 beginbfchar <0048> <4E00> endbfchar\nendcmap');
    const r = open([spec({ toUnicode: tu })]).EmbedFonts();
    expect(r.skipped.map((s) => [s.reason, s.detail])).toEqual([['glyph', 'CID 72 has no glyph in the face']]);
  });

  it('reports an encoding other than Identity-H', () => {
    const r = open([spec({ cidEncoding: 'UniJIS-UCS2-H' })]).EmbedFonts();
    expect(r.skipped.map((s) => [s.reason, s.detail])).toEqual([['encoding', 'the Type0 encoding is UniJIS-UCS2-H, not Identity-H']]);
  });

  it('subsets the embedded program to the glyphs shown', () => {
    const whole = open([spec()]);
    whole.EmbedFonts({ subset: false });
    const sub = open([spec()]);
    sub.EmbedFonts();
    expect(programOf(sub).length).toBeLessThan(programOf(whole).length);
  });

  it('declines both Type0 fonts that share one descendant, touching nothing', () => {
    // One program would serve both: embedded for F1 and subset to its glyphs,
    // F2's text drew blank (final review). Both directions of usage are tried.
    for (const [a, b] of [['HHH', 'www'], ['Hello', ''], ['', 'Hello']]) {
      const doc = open([spec({ text: a }), spec({ text: b })]);
      const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
      const f1 = doc.resolve(fonts.get('F1')) as PdfDict;
      const f2 = doc.resolve(fonts.get('F2')) as PdfDict;
      f2.set('DescendantFonts', f1.get('DescendantFonts')!);
      const before = doc.Save();
      const r = doc.EmbedFonts();
      expect(r.embedded).toEqual([]);
      expect(r.skipped.map((x) => x.reason)).toEqual(['shared', 'shared']);
      expect(Buffer.compare(before, doc.Save())).toBe(0);
    }
  });

  it('reports no-face for a composite font no registered face is named for', () => {
    expect(open([spec({ baseFont: 'Garamond' })]).EmbedFonts().skipped.map((s) => s.reason)).toEqual(['no-face']);
  });
});
