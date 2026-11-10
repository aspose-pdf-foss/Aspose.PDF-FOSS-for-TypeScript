import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PdfDict, PdfObject, isDict, isStream, name, ref } from '../src/types.js';
import { embedSimpleFonts } from '../src/simpleembed.js';
import { decodeStream } from '../src/filters.js';
import { parseSfnt, type SfntFont } from '../src/sfnt.js';
import { CffFont } from '../src/cff.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { replaceTable, buildCmap } from '../src/sfntwrite.js';
import { collectGlyphUsage } from '../src/glyphusage.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

const OTF = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf'));
const NIMBUS = parseSfnt(OTF);
const NIMBUS_CFF = new CffFont(NIMBUS.table('CFF ')!);
const LIB = getStd14Sfnt('Helvetica')!;

/** Liberation Sans with its cmap replaced by ONE (3,0) subtable at 0xF020..0xF07E
 *  -- the shape of a Windows symbol font such as Wingdings. */
function symbolFace(): Uint8Array {
  const uni = LIB.cmapSubtable(3, 1)!;
  const m = new Map<number, number>();
  for (let c = 0x20; c <= 0x7e; c++) { const g = uni.get(c); if (g) m.set(0xf000 | c, g); }
  const cmap = buildCmap(m);
  new DataView(cmap.buffer, cmap.byteOffset).setUint16(6, 0);   // (3,1) -> (3,0)
  return replaceTable(LIB.raw, 'cmap', cmap);
}
const SYMBOL = parseSfnt(symbolFace());

let cffDir: string, symDir: string, t1Dir: string;
beforeAll(() => {
  cffDir = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-cff-'));
  writeFileSync(join(cffDir, 'NimbusSans-Regular.otf'), OTF);
  symDir = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-sym-'));
  writeFileSync(join(symDir, 'Symbolic.ttf'), SYMBOL.raw);
  t1Dir = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-t1-'));
  writeFileSync(join(t1Dir, 'NimbusSans-Regular.pfa'), readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));
});

/** /Widths 32..126 as the CFF charstrings state them. */
function cffWidths(): number[] {
  const names = NIMBUS_CFF.charsetNames();
  const uni = NIMBUS.cmapSubtable(3, 1)!;
  const out: number[] = [];
  for (let c = 32; c <= 126; c++) {
    const gid = uni.get(c) ?? 0;
    expect(names[gid]).toBeDefined();
    out.push(Math.round((NIMBUS_CFF.glyphWidth(gid) ?? 0) * 1000 / NIMBUS_CFF.unitsPerEm));
  }
  return out;
}
/** /Widths 32..126 as the symbol face states them, by code. */
function symbolWidths(f: SfntFont): number[] {
  const sym = f.cmapSubtable(3, 0)!;
  const out: number[] = [];
  for (let c = 32; c <= 126; c++) out.push(Math.round((f.advanceWidth(sym.get(0xf000 | c) ?? 0) * 1000) / f.unitsPerEm));
  return out;
}
const symDescriptor = (): Map<string, PdfObject> =>
  new Map<string, PdfObject>([['Type', name('FontDescriptor')], ['FontName', name('LiberationSans')], ['Flags', 4]]);

function open(fonts: FontSpec[], dir: string): Document {
  const doc = Document.Open(buildNonEmbeddedFontPdf(fonts));
  doc.RegisterFontFolder(dir);
  return doc;
}
function font(doc: Document, i = 1): PdfDict {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
  const f = isDict(fonts) ? doc.resolve(fonts.get(`F${i}`)) : undefined;
  if (!isDict(f)) throw new Error(`no F${i}`);
  return f;
}
function descriptor(doc: Document, i = 1): PdfDict {
  const fd = doc.resolve(font(doc, i).get('FontDescriptor'));
  if (!isDict(fd)) throw new Error('no descriptor');
  return fd;
}
function objNum(doc: Document, f: PdfDict): number {
  for (const [r, o] of doc.objectEntries()) if (o === f) return r.num;
  throw new Error('font is not an indirect object');
}
const nameOf = (o: PdfObject | undefined): string | undefined => (o as { name?: string } | undefined)?.name;

const cffSpec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: 'NimbusSans-Regular', encoding: name('WinAnsiEncoding'), widths: cffWidths(), text: 'Hello World', ...o,
});
const symSpec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: 'LiberationSans', widths: symbolWidths(SYMBOL), descriptor: symDescriptor(), text: 'Hello', ...o,
});

describe('doc.EmbedFonts — an OpenType-CFF face (g0ky.4)', () => {
  it('embeds the bare CFF as /FontFile3 /Type1C under a /Type1 font, selecting each glyph by name', () => {
    // This test found u5es (a RegisterRenderFontFolder render through a CFF
    // face drew nothing); test/render-substitute-cff.test.ts now compares the
    // two renders.
    const blank = Document.Open(buildNonEmbeddedFontPdf([cffSpec({ text: '' })])).Pages[0].ToImage();
    const doc = open([cffSpec()], cffDir);
    const report = doc.EmbedFonts();
    expect(report.skipped).toEqual([]);
    expect(report.embedded.map((e) => [e.name, e.source, e.postScriptName])).toEqual([['NimbusSans-Regular', 'registered', 'NimbusSans-Regular']]);
    const saved = Document.Open(doc.Save());
    expect(saved.Fonts[0]).toMatchObject({ embedded: true, program: 'Type1C', subtype: 'Type1' });
    expect(saved.Pages[0].GetText()).toBe('Hello World');
    expect(Buffer.compare(saved.Pages[0].ToImage(), blank)).not.toBe(0);
    const names = NIMBUS_CFF.charsetNames();
    const want = new Set(['H', 'e', 'l', 'o', 'space', 'W', 'r', 'd'].map((n) => names.indexOf(n)));
    expect(collectGlyphUsage(saved).get(font(saved))?.gids).toEqual(want);
  });

  it('shrinks the CFF to the glyphs shown', () => {
    const doc = open([cffSpec()], cffDir);
    doc.EmbedFonts();
    const saved = Document.Open(doc.Save());
    const ff = saved.resolve(descriptor(saved).get('FontFile3'));
    if (!isStream(ff)) throw new Error('no FontFile3');
    const bytes = decodeStream(ff);
    expect(bytes.length).toBeLessThan(NIMBUS_CFF.raw.length);
    const kept = new CffFont(bytes);
    const names = kept.charsetNames();
    expect(kept.glyphPath(names.indexOf('H')).length).toBeGreaterThan(0);
    expect(kept.glyphPath(names.indexOf('Z')).length).toBe(0);
  });

  it('declines a shown glyph the charset does not name, and a width it does not state', () => {
    const cyr = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [72, name('uni0416')]]]);
    const report = open([cffSpec({ encoding: cyr }), cffSpec({ widths: cffWidths().map(() => 500) })], cffDir).EmbedFonts();
    expect(report.skipped.map((s) => [s.reason, s.detail])).toEqual([
      // The usage scan finds no glyph for the code before the per-code check
      // can, and its explanation becomes the detail.
      ['usage', 'code 72 has no GID'],
      ['width-mismatch', 'code 32 (space): /Widths 500, face 278'],
    ]);
  });

  it('selects a glyph by its charset name even when the name has no Unicode route', () => {
    const names = NIMBUS_CFF.charsetNames();
    const widths = cffWidths();
    widths[65 - 32] = Math.round((NIMBUS_CFF.glyphWidth(names.indexOf('fi')) ?? 0) * 1000 / NIMBUS_CFF.unitsPerEm);
    const enc = new Map<string, PdfObject>([['Type', name('Encoding')], ['BaseEncoding', name('WinAnsiEncoding')], ['Differences', [65, name('fi')]]]);
    const doc = open([cffSpec({ encoding: enc, widths, text: 'A' })], cffDir);
    expect(doc.EmbedFonts().embedded).toHaveLength(1);
  });

  // g0ky.4 declined this face (its converted CFF is CID-keyed); g0ky.7 embeds
  // the Type 1 program itself. test/embed-fonts-type1.test.ts covers the route.
  it('embeds a Type 1 face as itself, not through its CID-keyed CFF conversion', () => {
    const doc = open([cffSpec()], t1Dir);
    const report = doc.EmbedFonts();
    expect(report.skipped).toEqual([]);
    expect(descriptor(doc).has('FontFile')).toBe(true);
  });
});

describe('doc.EmbedFonts — a symbolic font (g0ky.4)', () => {
  it('embeds a symbol face as a symbolic /TrueType with no encoding, its codes going through (3,0)', () => {
    const doc = open([symSpec()], symDir);
    const report = doc.EmbedFonts();
    expect(report.skipped).toEqual([]);
    expect(report.embedded).toHaveLength(1);
    const saved = Document.Open(doc.Save());
    const f = font(saved);
    expect(nameOf(f.get('Subtype'))).toBe('TrueType');
    expect(f.has('Encoding')).toBe(false);
    const flags = saved.resolve(descriptor(saved).get('Flags')) as number;
    expect([flags & 4, flags & 32]).toEqual([4, 0]);
    const sym = SYMBOL.cmapSubtable(3, 0)!;
    const want = new Set([...'Helo'].map((c) => sym.get(0xf000 | c.charCodeAt(0))!));
    expect(collectGlyphUsage(saved).get(f)?.gids).toEqual(want);
  });

  it('treats a non-embedded Symbol with no descriptor as symbolic', () => {
    const report = open([symSpec({ baseFont: 'Symbol', descriptor: undefined })], symDir).EmbedFonts();
    expect(report.skipped.map((s) => s.reason)).toEqual(['no-face']);   // reached the face lookup, not the text route
  });

  it('declines a symbolic font over a face with no (3,0) cmap, and one with no /Widths', () => {
    const textFace = mkdtempSync(join(tmpdir(), 'pdf4ts-embed-sym-text-'));
    writeFileSync(join(textFace, 'LiberationSans.ttf'), LIB.raw);
    expect(open([symSpec()], textFace).EmbedFonts().skipped.map((s) => s.reason)).toEqual(['cmap']);
    expect(open([symSpec({ widths: undefined })], symDir).EmbedFonts().skipped.map((s) => s.reason)).toEqual(['widths']);
  });

  it('takes the text route for a font flagged both Symbolic and Nonsymbolic', () => {
    const fd = new Map<string, PdfObject>([...symDescriptor(), ['Flags', 4 | 32]]);
    const report = open([symSpec({ descriptor: fd })], symDir).EmbedFonts();
    expect(report.skipped.map((s) => s.reason)).toEqual(['cmap']);   // no (3,1) to map names through
  });

  it('treats a Standard-14 Symbol with no descriptor as symbolic, and needs its /Widths', () => {
    const doc = Document.Open(buildNonEmbeddedFontPdf([symSpec({ baseFont: 'Symbol', descriptor: undefined })]));
    const f = font(doc);
    const [ok] = embedSimpleFonts(doc, [{ object: ref(objNum(doc, f), 0), font: f, sfnt: SYMBOL }], { subset: true });
    expect(ok.embedded).toBe(true);
    const doc2 = Document.Open(buildNonEmbeddedFontPdf([symSpec({ baseFont: 'Symbol', descriptor: undefined, widths: undefined })]));
    const f2 = font(doc2);
    const [no] = embedSimpleFonts(doc2, [{ object: ref(objNum(doc2, f2), 0), font: f2, sfnt: SYMBOL, std: 'Symbol' }], { subset: true });
    expect(no.reason).toBe('widths');
  });

  it('takes the text route for a symbolic font that states an encoding', () => {
    const report = open([symSpec({ encoding: name('WinAnsiEncoding') })], symDir).EmbedFonts();
    expect(report.skipped.map((s) => s.reason)).toEqual(['cmap']);   // no (3,1) to map names through
  });
});
