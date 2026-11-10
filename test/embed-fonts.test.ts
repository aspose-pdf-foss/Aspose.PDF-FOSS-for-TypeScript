import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, isDict, isStream, name } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { serializeObject } from '../src/serialize.js';
import type { SfntFont } from '../src/sfnt.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

const REGULAR = getStd14Sfnt('Helvetica')!;      // Liberation Sans
const BOLD = getStd14Sfnt('Helvetica-Bold')!;    // Liberation Sans Bold
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf4ts-embedfonts-'));
  writeFileSync(join(dir, 'LiberationSans-Regular.ttf'), REGULAR.raw);
  writeFileSync(join(dir, 'LiberationSans-Bold.ttf'), BOLD.raw);
});

/** /Widths 32..126 as the face states them, in 1/1000 em. */
function widthsOf(f: SfntFont): number[] {
  const cmap = f.cmapSubtable(3, 1)!;
  const out: number[] = [];
  for (let c = 32; c <= 126; c++) out.push(Math.round((f.advanceWidth(cmap.get(c) ?? 0) * 1000) / f.unitsPerEm));
  return out;
}

const spec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: REGULAR.postScriptName!, encoding: name('WinAnsiEncoding'), widths: widthsOf(REGULAR), text: 'Hello World', ...o,
});

function open(fonts: FontSpec[], register = true): Document {
  const doc = Document.Open(buildNonEmbeddedFontPdf(fonts));
  if (register) doc.RegisterFontFolder(dir);
  return doc;
}

function font(doc: Document, i = 1): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  const f = isDict(fonts) ? doc.resolve(fonts.get(`F${i}`)) : undefined;
  if (!isDict(f)) throw new Error(`no F${i}`);
  return f;
}
function program(doc: Document, i = 1): Uint8Array | undefined {
  const fd = doc.resolve(font(doc, i).get('FontDescriptor'));
  const ff = isDict(fd) ? doc.resolve(fd.get('FontFile2')) : undefined;
  return isStream(ff) ? decodeStream(ff) : undefined;
}
const text = (d: PdfObject): string => new TextDecoder().decode(serializeObject(d));

describe('doc.EmbedFonts (g0ky.2)', () => {
  it('embeds a registered face matched by PostScript name and draws what the installed face draws', () => {
    const pdf = buildNonEmbeddedFontPdf([spec()]);
    const viaRender = Document.Open(pdf);
    viaRender.RegisterRenderFontFolder(dir);
    const before = viaRender.Pages[0].ToImage();

    const doc = open([spec()]);
    const report = doc.EmbedFonts();
    expect(report.skipped).toEqual([]);
    expect(report.embedded).toEqual([{
      name: 'LiberationSans', object: report.embedded[0].object, source: 'registered',
      postScriptName: 'LiberationSans', path: join(dir, 'LiberationSans-Regular.ttf'), faceIndex: 0,
    }]);
    const saved = Document.Open(doc.Save());
    expect(saved.Fonts[0]).toMatchObject({ embedded: true, program: 'TrueType', subtype: 'TrueType' });
    expect(saved.Pages[0].GetText()).toBe('Hello World');
    expect(Buffer.compare(saved.Pages[0].ToImage(), before)).toBe(0);
  });

  it('shrinks the program to the glyphs shown, or keeps it whole with subset: false', () => {
    const doc = open([spec()]);
    doc.EmbedFonts();
    const shrunk = program(Document.Open(doc.Save()))!;
    expect(shrunk.length).toBeLessThan(REGULAR.raw.length);

    const whole = open([spec()]);
    whole.EmbedFonts({ subset: false });
    expect(Buffer.compare(program(Document.Open(whole.Save()))!, REGULAR.raw)).toBe(0);
  });

  it("matches Word's family,style spelling to the face in that style, and not to another style", () => {
    const doc = open([
      spec({ baseFont: 'LiberationSans,Bold', widths: widthsOf(BOLD) }),
      spec({ baseFont: 'Liberation Sans,Italic' }),
    ]);
    const report = doc.EmbedFonts();
    expect(report.embedded.map((e) => [e.name, e.postScriptName])).toEqual([['LiberationSans,Bold', 'LiberationSans-Bold']]);
    expect(report.skipped.map((s) => [s.name, s.reason])).toEqual([['Liberation Sans,Italic', 'no-face']]);
  });

  it('declines a font whose /Widths disagree with the face, and leaves the document untouched', () => {
    const pdf = buildNonEmbeddedFontPdf([spec({ widths: widthsOf(REGULAR).map(() => 500) })]);
    const untouched = Document.Open(pdf).Save();
    const doc = Document.Open(pdf);
    doc.RegisterFontFolder(dir);
    const report = doc.EmbedFonts();
    expect(report.embedded).toEqual([]);
    expect(report.skipped).toEqual([{
      name: 'LiberationSans', object: report.skipped[0].object, reason: 'width-mismatch',
      detail: 'code 32 (space): /Widths 500, face 278',
    }]);
    expect(doc.isModifiedInternal()).toBe(false);
    expect(Buffer.compare(doc.Save(), untouched)).toBe(0);
  });

  it('declines a shown code the face has no glyph for', () => {
    const enc = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [72, name('uni4E00')]]]);
    const report = open([spec({ encoding: enc })]).EmbedFonts();
    expect(report.skipped.map((s) => [s.reason, s.detail])).toEqual([['glyph', 'code 72 (uni4E00) has no glyph in the face']]);
  });

  it('puts a declined font back exactly while embedding its neighbour', () => {
    const doc = open([spec(), spec({ widths: widthsOf(REGULAR).map(() => 500) })]);
    const was = text(font(doc, 2));
    const report = doc.EmbedFonts();
    expect(report.embedded).toHaveLength(1);
    expect(report.skipped.map((s) => s.reason)).toEqual(['width-mismatch']);
    expect(text(font(doc, 2))).toBe(was);
    expect(program(doc, 1)).toBeDefined();
  });

  it('gives each font its own copy of a shared descriptor and leaves the original as it was', () => {
    const fd = new Map<string, PdfObject>([['Type', name('FontDescriptor')], ['FontName', name('LiberationSans')], ['Flags', 32]]);
    const doc = open([spec({ descriptor: fd }), spec({ shareDescriptorWith: 0, widths: widthsOf(REGULAR).map(() => 500) })]);
    const report = doc.EmbedFonts();
    expect(report.embedded).toHaveLength(1);
    const fd2 = doc.resolve(font(doc, 2).get('FontDescriptor'));
    expect(isDict(fd2) && fd2.has('FontFile2')).toBe(false);
    expect(doc.resolve(font(doc, 1).get('FontDescriptor'))).not.toBe(fd2);
  });

  it('ConvertToPdfA no longer leaves a /Type1 font pointing at a TrueType program through a shared descriptor', () => {
    const fd = new Map<string, PdfObject>([['Type', name('FontDescriptor')], ['FontName', name('Helvetica')], ['Flags', 32]]);
    const helv = { baseFont: 'Helvetica', widths: undefined } as const;
    const doc = open([spec({ ...helv, descriptor: fd }), spec({ ...helv, shareDescriptorWith: 0, text: 'Again' })], false);
    expect(doc.ConvertToPdfA('2b').applied.filter((a) => a.rule === 'FontEmbedded')).toHaveLength(2);
    for (const i of [1, 2]) {
      expect((font(doc, i).get('Subtype') as { name: string }).name).toBe('TrueType');
      expect(program(doc, i)).toBeDefined();
    }
  });

  it('reports a font with no registered face, a composite font and an unreadable encoding', () => {
    const report = open([
      spec({ baseFont: 'Garamond' }),
      spec({ baseFont: 'Arial', subtype: 'Type0', text: 'AB' }),
      spec({ encoding: name('MacExpertEncoding') }),
    ]).EmbedFonts();
    expect(report.embedded).toEqual([]);
    expect(report.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['Garamond', 'no-face'], ['Arial', 'no-face'], ['LiberationSans', 'encoding'],
    ]);
  });

  it('embeds the bundled substitute for a Standard-14 font only when asked', () => {
    const helv = (): FontSpec[] => [spec({ baseFont: 'Helvetica', widths: undefined })];
    expect(open(helv(), false).EmbedFonts().skipped.map((s) => s.reason)).toEqual(['no-face']);
    const report = open(helv(), false).EmbedFonts({ bundledStandard14: true });
    expect(report.embedded.map((e) => [e.name, e.source, e.postScriptName])).toEqual([['Helvetica', 'bundled', 'LiberationSans']]);
  });

  it('is a no-op the second time, since the fonts are embedded', () => {
    const doc = open([spec()]);
    doc.EmbedFonts();
    expect(doc.EmbedFonts()).toEqual({ embedded: [], skipped: [] });
  });

  it('refuses options of the wrong kind before touching anything', () => {
    const doc = open([spec()]);
    expect(() => doc.EmbedFonts({ subset: 'yes' as unknown as boolean })).toThrow(TypeError);
    expect(program(doc)).toBeUndefined();
  });
});
