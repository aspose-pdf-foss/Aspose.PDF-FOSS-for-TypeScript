import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { isDict, isStream, name, type PdfDict, type PdfObject } from '../src/types.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

// g0ky.9: the leftovers of g0ky.7's final review.

const LIB = getStd14Sfnt('Helvetica')!;            // Liberation Sans
const UNI = LIB.cmapSubtable(3, 1)!;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-reach-'));
  writeFileSync(join(dir, 'LiberationSans-Regular.ttf'), LIB.raw);
});
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const adv = (cp: number): number => Math.round((LIB.advanceWidth(UNI.get(cp) ?? 0) * 1000) / LIB.unitsPerEm);
const widths = (): number[] => Array.from({ length: 95 }, (_, i) => adv(32 + i));
const open = (fonts: FontSpec[]): Document => {
  const doc = Document.Open(buildNonEmbeddedFontPdf(fonts));
  doc.RegisterFontFolder(dir);
  return doc;
};
/** A non-embedded Liberation Sans simple font dict, to write DIRECTLY somewhere. */
const directFont = (): PdfDict => new Map<string, PdfObject>([
  ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('LiberationSans')],
  ['Encoding', name('WinAnsiEncoding')], ['FirstChar', 32], ['LastChar', 126], ['Widths', widths()],
]);
const stream = (content: string, dict: [string, PdfObject][] = []): PdfObject => ({
  kind: 'stream', dict: new Map<string, PdfObject>([['Length', content.length], ...dict]), raw: enc(content),
});
const programOf = (doc: Document, font: PdfDict): string | undefined => {
  const fd = doc.resolve(font.get('FontDescriptor'));
  if (!isDict(fd)) return undefined;
  return ['FontFile', 'FontFile2', 'FontFile3'].find((k) => fd.has(k));
};

describe('EmbedFonts reaches direct font dicts outside page resources (g0ky.9)', () => {
  it('embeds a direct font an annotation appearance draws with', () => {
    const doc = open([]);
    const font = directFont();
    const ap = doc.allocObject(stream('BT /FA 12 Tf 2 2 Td (Hi) Tj ET', [
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 50, 20]],
      ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['FA', font]])]])],
    ]));
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Square')], ['Rect', [10, 10, 60, 30]],
      ['AP', new Map<string, PdfObject>([['N', ap]])],
    ]));
    doc.Pages[0].Dict.set('Annots', [annot]);
    const r = doc.EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toMatchObject([{ name: 'LiberationSans', pages: [1] }]);
    expect(programOf(doc, font)).toBe('FontFile2');
  });

  it('embeds a direct font a tiling pattern draws with', () => {
    const doc = open([]);
    const font = directFont();
    const pat = doc.allocObject(stream('BT /FP 8 Tf 0 0 Td (Hi) Tj ET', [
      ['Type', name('Pattern')], ['PatternType', 1], ['PaintType', 1], ['TilingType', 1],
      ['BBox', [0, 0, 20, 20]], ['XStep', 20], ['YStep', 20],
      ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['FP', font]])]])],
    ]));
    doc.Pages[0].Resources!.set('Pattern', new Map<string, PdfObject>([['P0', pat]]));
    const r = doc.EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toHaveLength(1);
    expect(programOf(doc, font)).toBe('FontFile2');
  });

  it('embeds a direct font a Type 3 glyph procedure draws with', () => {
    const doc = open([]);
    const font = directFont();
    const proc = doc.allocObject(stream('1000 0 d0 BT /FG 8 Tf 0 0 Td (Hi) Tj ET'));
    const t3 = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type3')], ['FontBBox', [0, 0, 1000, 1000]],
      ['FontMatrix', [0.001, 0, 0, 0.001, 0, 0]], ['FirstChar', 65], ['LastChar', 65], ['Widths', [1000]],
      ['Encoding', new Map<string, PdfObject>([['Differences', [65, name('g')]]])],
      ['CharProcs', new Map<string, PdfObject>([['g', proc]])],
      ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['FG', font]])]])],
    ]));
    doc.Pages[0].Resources!.set('Font', new Map<string, PdfObject>([['T3', t3]]));
    const r = doc.EmbedFonts();
    expect(r.embedded.map((e) => e.name)).toEqual(['LiberationSans']);
    expect(programOf(doc, font)).toBe('FontFile2');
  });

  it('reports, rather than ignores, a direct font only /AcroForm /DR holds', () => {
    const doc = open([]);
    const root = doc.catalog();
    root.set('AcroForm', new Map<string, PdfObject>([
      ['Fields', []], ['DR', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['Helv', directFont()]])]])],
    ]));
    const r = doc.EmbedFonts();
    expect(r.embedded).toEqual([]);
    expect(r.skipped.map((s) => [s.name, s.reason])).toEqual([['LiberationSans', 'usage']]);
  });
});

describe('EmbedFonts: composite fonts, review leftovers (g0ky.9)', () => {
  const cidW = (uni: (cid: number) => number): PdfObject => [32, Array.from({ length: 95 }, (_, i) => adv(uni(32 + i)))];
  const japan1 = (o: Partial<FontSpec> = {}): FontSpec => ({
    baseFont: 'LiberationSans', subtype: 'Type0', ordering: 'Japan1', cidWidths: cidW((c) => c + 0x1f), text: 'HELLO', ...o,
  });
  const cmap = (body: string): string => '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n'
    + `1 begincodespacerange <0000> <FFFF> endcodespacerange\n${body}\nendcmap end end`;

  it('fills the CIDs a partial /ToUnicode leaves out from the collection table', () => {
    // Adobe-Japan1 CID c is U+001F + c for c <= 95; the CMap states one CID.
    const r = open([japan1({ toUnicode: cmap('1 beginbfchar <0048> <0067> endbfchar') })]).EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toHaveLength(1);
  });

  it('falls back to the collection table when /ToUnicode maps nothing', () => {
    const r = open([japan1({ toUnicode: 'garbage that is no CMap' })]).EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toHaveLength(1);
  });

  it('names a shown CID that stands for several characters as the reason', () => {
    const tu = cmap('1 beginbfrange <0020> <007E> <0020> endbfrange\n1 beginbfchar <0048> <00660066> endbfchar');
    const r = open([{ baseFont: 'LiberationSans', subtype: 'Type0', toUnicode: tu, cidWidths: cidW((c) => c), text: 'Hello' }]).EmbedFonts();
    expect(r.skipped.map((s) => [s.reason, s.detail])).toEqual([['glyph', 'CID 72 stands for several characters, which no one glyph of the face draws']]);
  });

  it('drops a stale /CIDSet from the descriptor it copies', () => {
    const desc = new Map<string, PdfObject>([
      ['Type', name('FontDescriptor')], ['FontName', name('LiberationSans')], ['Flags', 32],
    ]);
    const tu = cmap('1 beginbfrange <0020> <007E> <0020> endbfrange');
    const doc = open([{ baseFont: 'LiberationSans', subtype: 'Type0', toUnicode: tu, cidWidths: cidW((c) => c), text: 'Hello', descriptor: desc }]);
    const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
    const d0 = doc.resolve((doc.resolve((doc.resolve(fonts.get('F1')) as PdfDict).get('DescendantFonts')) as PdfObject[])[0]) as PdfDict;
    (doc.resolve(d0.get('FontDescriptor')) as PdfDict).set('CIDSet', doc.allocObject(stream('ÿ')));
    expect(doc.EmbedFonts().embedded).toHaveLength(1);
    const fd = doc.resolve(d0.get('FontDescriptor')) as PdfDict;
    expect(fd.has('FontFile2')).toBe(true);
    expect(fd.has('CIDSet')).toBe(false);
  });

  it('reports a Type0 font with no descendant rather than skipping it silently', () => {
    const doc = open([japan1({ toUnicode: cmap('1 beginbfrange <0020> <007E> <0020> endbfrange') })]);
    const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
    (doc.resolve(fonts.get('F1')) as PdfDict).delete('DescendantFonts');
    const r = doc.EmbedFonts();
    expect(r.skipped.map((s) => [s.reason, s.detail])).toEqual([['usage', 'the Type0 font has no descendant font']]);
  });
});

describe('EmbedFonts: a simple font keeps no stale glyph set (g0ky.9)', () => {
  it('drops /CharSet and /CIDSet from a descriptor it writes a program into', () => {
    const desc = new Map<string, PdfObject>([
      ['Type', name('FontDescriptor')], ['FontName', name('LiberationSans')], ['Flags', 32],
      ['CharSet', { kind: 'string', bytes: enc('/H/e/l/o') }],
    ]);
    const doc = open([{ baseFont: 'LiberationSans', encoding: name('WinAnsiEncoding'), widths: widths(), text: 'Hello', descriptor: desc }]);
    const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
    const fd = doc.resolve((doc.resolve(fonts.get('F1')) as PdfDict).get('FontDescriptor')) as PdfDict;
    fd.set('CIDSet', doc.allocObject(stream('ÿ')));
    expect(doc.EmbedFonts().embedded).toHaveLength(1);
    expect(fd.has('FontFile2')).toBe(true);
    expect(fd.has('CharSet')).toBe(false);
    expect(fd.has('CIDSet')).toBe(false);
  });

  it('puts /CharSet back when the font is declined', () => {
    const desc = new Map<string, PdfObject>([
      ['Type', name('FontDescriptor')], ['FontName', name('LiberationSans')], ['Flags', 32],
      ['CharSet', { kind: 'string', bytes: enc('/H/e/l/o') }],
    ]);
    const doc = open([{ baseFont: 'LiberationSans', encoding: name('WinAnsiEncoding'), widths: widths().map((w) => w + 50), text: 'Hello', descriptor: desc }]);
    expect(doc.EmbedFonts().skipped.map((s) => s.reason)).toEqual(['width-mismatch']);
    const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
    const fd = doc.resolve((doc.resolve(fonts.get('F1')) as PdfDict).get('FontDescriptor')) as PdfDict;
    expect(fd.has('CharSet')).toBe(true);
    expect(isStream(fd.get('FontFile2'))).toBe(false);
  });
});
