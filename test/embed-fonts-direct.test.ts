import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { isDict, name, type PdfDict, type PdfObject } from '../src/types.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import type { SfntFont } from '../src/sfnt.js';
import { buildNonEmbeddedFontPdf, type FontSpec } from './helpers/build-nonembedded-font-pdf.js';

const REGULAR = getStd14Sfnt('Helvetica')!;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pdf4ts-embeddirect-'));
  writeFileSync(join(dir, 'LiberationSans-Regular.ttf'), REGULAR.raw);
});
function widthsOf(f: SfntFont): number[] {
  const cmap = f.cmapSubtable(3, 1)!;
  const out: number[] = [];
  for (let c = 32; c <= 126; c++) out.push(Math.round((f.advanceWidth(cmap.get(c) ?? 0) * 1000) / f.unitsPerEm));
  return out;
}
const spec = (o: Partial<FontSpec> = {}): FontSpec => ({
  baseFont: 'LiberationSans', encoding: name('WinAnsiEncoding'), widths: widthsOf(REGULAR), text: 'Hello', ...o,
});
const open = (fonts: FontSpec[]): Document => {
  const doc = Document.Open(buildNonEmbeddedFontPdf(fonts));
  doc.RegisterFontFolder(dir);
  return doc;
};
const fontAt = (doc: Document, i: number): PdfDict => {
  const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
  return doc.resolve(fonts.get(`F${i}`)) as PdfDict;
};

describe('EmbedFonts: font dicts written directly in /Resources (g0ky.7)', () => {
  it('embeds a direct font dict, reporting the pages that declare it', () => {
    const doc = open([spec({ direct: true })]);
    const r = doc.EmbedFonts();
    expect(r.skipped).toEqual([]);
    expect(r.embedded).toHaveLength(1);
    expect(r.embedded[0].object).toBeUndefined();
    expect(r.embedded[0].pages).toEqual([1]);
    const saved = Document.Open(doc.Save());
    expect(saved.Fonts[0]).toMatchObject({ embedded: true, program: 'TrueType' });
    expect(saved.Pages[0].GetText()).toBe('Hello');
  });

  it('reports a direct font it cannot embed by its pages', () => {
    const doc = open([spec({ direct: true, baseFont: 'NoSuchFace' })]);
    expect(doc.EmbedFonts().skipped).toEqual([{ name: 'NoSuchFace', pages: [1], reason: 'no-face' }]);
  });

  it('copies a descriptor a direct font shares with an indirect one before writing it', () => {
    const fd = new Map<string, PdfObject>([['Type', name('FontDescriptor')], ['FontName', name('LiberationSans')], ['Flags', 32]]);
    const doc = open([spec({ descriptor: fd }), spec({ direct: true, baseFont: 'NoSuchFace', shareDescriptorWith: 0 })]);
    doc.EmbedFonts();
    const d1 = doc.resolve(fontAt(doc, 1).get('FontDescriptor'));
    const d2 = doc.resolve(fontAt(doc, 2).get('FontDescriptor'));
    expect(isDict(d1) && d1.has('FontFile2')).toBe(true);
    expect(isDict(d2) && d2.has('FontFile2')).toBe(false);
  });
});
