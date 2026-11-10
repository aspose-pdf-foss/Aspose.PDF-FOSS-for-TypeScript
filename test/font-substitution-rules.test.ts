import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildGlyphSource } from '../src/raster.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { name, ref, type PdfDict, type PdfObject } from '../src/types.js';
import type { FontSubstitutionRequest } from '../src/index.js';
import { buildNamedFont } from './helpers/build-sfnt.js';
import { buildSimpleTextPdf, buildType0Pdf, fontDictOf } from './helpers/build-text-pdf.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-substrules-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}
const TEXT = 'BT /F1 24 Tf 20 100 Td (AB) Tj ET';
const pdf = (baseFont = 'Arial-BoldMT') => Document.Open(buildSimpleTextPdf(TEXT, { baseFont }));
const sub = () => folderWith({
  'r.ttf': buildNamedFont({ family: 'Sub Sans' }),
  'b.ttf': buildNamedFont({ family: 'Sub Sans', subfamily: 'Bold', bold: true, weight: 700, postScriptName: 'SubSans-Bold' }),
});
const other = () => folderWith({ 'o.ttf': buildNamedFont({ family: 'Other Face' }) });
// Faces are compared by IDENTITY: a failing toBe on two parsed fonts makes
// vitest render a diff of both, which hangs the worker.
const srcOf = (doc: Document) => buildGlyphSource(doc, fontDictOf(doc));
const faceSfnt = (doc: Document, ps: string) => doc.loadRenderFace(doc.renderFontFaces().find((f) => f.names.postScriptName === ps)!);

describe('font substitution rules (g0ky.6)', () => {
  it('a rule matches the family part and keeps the font style inside the substitute', () => {
    const doc = pdf();
    doc.RegisterRenderFontFolder(sub());
    doc.AddFontSubstitution('Arial', 'Sub Sans');
    const src = srcOf(doc);
    expect(src.substituteFamily).toBe('Sub Sans');
    expect(src.sfnt === faceSfnt(doc, 'SubSans-Bold'), "same face: faceSfnt(doc, 'SubSans-Bold')").toBe(true);
  });

  it('an Arial rule does not catch ArialNarrow', () => {
    const doc = pdf('ArialNarrow');
    doc.RegisterRenderFontFolder(sub());
    doc.AddFontSubstitution('Arial', 'Sub Sans');
    expect(srcOf(doc).substituteFamily).toBeUndefined();
  });

  it('the first resolvable rule wins; an unresolvable one is skipped', () => {
    const doc = pdf();
    doc.RegisterRenderFontFolder(sub());
    doc.RegisterRenderFontFolder(other());
    doc.AddFontSubstitution('Arial', 'Not Installed');
    doc.AddFontSubstitution('Arial', 'Other Face');
    doc.AddFontSubstitution('Arial', 'Sub Sans');
    expect(srcOf(doc).substituteFamily).toBe('Other Face');
  });

  it('a rule beats the ladder, even an exact PostScript-name hit', () => {
    const doc = pdf();
    doc.RegisterRenderFontFolder(folderWith({ 'a.ttf': buildNamedFont({ family: 'Arial', postScriptName: 'Arial-BoldMT' }) }));
    doc.RegisterRenderFontFolder(sub());
    expect(srcOf(doc).substituteFamily).toBe('Arial');
    doc.AddFontSubstitution('Arial', 'Sub Sans');
    expect(srcOf(doc).substituteFamily).toBe('Sub Sans');
  });

  it('a rule to a bundled Standard-14 family works with no render faces registered', () => {
    const doc = pdf();
    doc.AddFontSubstitution('Arial', 'Times');
    const src = srcOf(doc);
    expect(src.sfnt === getStd14Sfnt('Times-Bold'), "same face: getStd14Sfnt('Times-Bold')").toBe(true);
    expect(src.substituted).toBe(true);
    expect(src.substituteFamily).toBeUndefined();
  });

  it('skips a substitute that exists only in an authoring folder', () => {
    const doc = pdf();
    doc.RegisterFontFolder(sub());
    doc.AddFontSubstitution('Arial', 'Sub Sans');
    expect(srcOf(doc).sfnt === getStd14Sfnt('Helvetica-Bold'), "same face: getStd14Sfnt('Helvetica-Bold')").toBe(true);
  });

  it('a rule for a Type0 font marks it substituted, so it selects by Unicode', () => {
    const doc = Document.Open(buildType0Pdf('BT /F1 24 Tf 20 100 Td <0041> Tj ET',
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
      + '1 beginbfrange <0041> <0041> <0058> endbfrange\nendcmap end end', { baseFont: 'Foo' }));
    doc.AddFontSubstitution('Foo', 'Courier');
    const src = srcOf(doc);
    expect(src.substituted).toBe(true);
    expect(src.sfnt === getStd14Sfnt('Courier'), "same face: getStd14Sfnt('Courier')").toBe(true);
  });

  it('ClearFontSubstitutions restores the ladder; FontSubstitutions is a frozen copy', () => {
    const doc = pdf();
    doc.AddFontSubstitution('Arial', 'Times');
    const list = doc.FontSubstitutions;
    expect(list).toEqual([{ original: 'Arial', substitute: 'Times' }]);
    expect(Object.isFrozen(list)).toBe(true);
    expect(doc.FontSubstitutions).not.toBe(list);
    srcOf(doc);
    doc.ClearFontSubstitutions();
    expect(doc.FontSubstitutions).toEqual([]);
    expect(srcOf(doc).sfnt === getStd14Sfnt('Helvetica-Bold'), "same face: getStd14Sfnt('Helvetica-Bold')").toBe(true);
  });

  it('refuses wrong-kind arguments', () => {
    const doc = pdf();
    expect(() => doc.AddFontSubstitution('', 'x')).toThrow(TypeError);
    expect(() => doc.AddFontSubstitution(' ', 'x')).toThrow(TypeError);
    expect(() => doc.AddFontSubstitution('x', '')).toThrow(TypeError);
    expect(() => doc.AddFontSubstitution(1 as never, 'x')).toThrow(TypeError);
    expect(() => doc.SetFontSubstitutionHandler(1 as never)).toThrow(TypeError);
  });
});

describe('font substitution handler (g0ky.6)', () => {
  it('is asked before the rules, with the font name, style and characters', () => {
    const doc = pdf();
    doc.RegisterRenderFontFolder(sub());
    doc.RegisterRenderFontFolder(other());
    doc.AddFontSubstitution('Arial', 'Sub Sans');
    let seen: FontSubstitutionRequest | undefined;
    doc.SetFontSubstitutionHandler((r) => { seen = r; return 'Other Face'; });
    expect(srcOf(doc).substituteFamily).toBe('Other Face');
    expect(seen).toMatchObject({ name: 'Arial-BoldMT', bold: true, italic: false });
    expect(seen!.characters.has(0x41)).toBe(true);
  });

  it('undefined, an unresolvable name or unparseable bytes fall through to the rules', () => {
    for (const answer of [undefined, 'Not Installed', new Uint8Array([1, 2, 3])]) {
      const doc = pdf();
      doc.RegisterRenderFontFolder(sub());
      doc.AddFontSubstitution('Arial', 'Sub Sans');
      doc.SetFontSubstitutionHandler(() => answer);
      expect(srcOf(doc).substituteFamily).toBe('Sub Sans');
    }
  });

  it('may answer with font bytes', () => {
    const doc = pdf();
    doc.SetFontSubstitutionHandler(() => buildNamedFont({ family: 'Handed Over' }));
    expect(srcOf(doc).substituteFamily).toBe('Handed Over');
  });

  it('is asked once per font across renders, and again after a rule changes', () => {
    const doc = pdf();
    let calls = 0;
    doc.SetFontSubstitutionHandler(() => { calls++; return undefined; });
    doc.Pages[0].ToImage();
    doc.Pages[0].ToImage();
    expect(calls).toBe(1);
    doc.AddFontSubstitution('Zzz', 'Times');
    doc.Pages[0].ToImage();
    expect(calls).toBe(2);
  });

  it('a name answer resolves against faces registered after it was asked', () => {
    const doc = pdf();
    doc.SetFontSubstitutionHandler(() => 'Sub Sans');
    expect(srcOf(doc).substituteFamily).toBeUndefined();
    doc.RegisterRenderFontFolder(sub());
    expect(srcOf(doc).substituteFamily).toBe('Sub Sans');
  });

  it('a throwing handler reaches the caller through a render', () => {
    const doc = pdf();
    const err = new Error('handler bug');
    doc.SetFontSubstitutionHandler(() => { throw err; });
    expect(() => doc.Pages[0].ToImage()).toThrow(err);
  });

  it('a throwing handler reaches the caller from an annotation appearance', () => {
    const doc = Document.Open(buildSimpleTextPdf('', { baseFont: 'Arial-BoldMT' }));
    const page = doc.Pages[0];
    const fonts = doc.resolve(page.Resources!.get('Font')) as PdfDict;
    const ap = doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 100, 30]],
        ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([['F1', fonts.get('F1')!]])]])],
      ]),
      raw: new TextEncoder().encode('BT /F1 12 Tf 2 10 Td (A) Tj ET'),
    });
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('FreeText')], ['Rect', [10, 10, 110, 40]],
      ['AP', new Map<string, PdfObject>([['N', ap]])],
    ]));
    page.Dict.set('Annots', [annot]);
    void ref;
    const err = new Error('handler bug');
    doc.SetFontSubstitutionHandler(() => { throw err; });
    expect(() => page.ToImage()).toThrow(err);
  });
});

describe('font substitution: what does not change (g0ky.6)', () => {
  it('an empty rule list renders byte-identically to none', () => {
    const a = pdf();
    const b = pdf();
    b.AddFontSubstitution('Arial', 'Times');
    b.ClearFontSubstitutions();
    expect(Buffer.compare(a.Pages[0].ToImage(), b.Pages[0].ToImage())).toBe(0);
  });

  it('a matching rule changes the render but not ToSvg or Save', () => {
    const a = pdf();
    const b = pdf();
    b.AddFontSubstitution('Arial', 'Courier');
    expect(Buffer.compare(a.Pages[0].ToImage(), b.Pages[0].ToImage())).not.toBe(0);
    expect(b.Pages[0].ToSvg()).toBe(a.Pages[0].ToSvg());
    expect(Buffer.compare(a.Save(), b.Save())).toBe(0);
  });

  it('EmbedFonts ignores the rules', () => {
    const doc = Document.Open(buildSimpleTextPdf(TEXT, { baseFont: 'Foo' }));
    doc.RegisterRenderFontFolder(sub());
    doc.AddFontSubstitution('Foo', 'Sub Sans');
    const before = doc.Save();
    doc.EmbedFonts();
    expect(Buffer.compare(before, doc.Save())).toBe(0);
  });
});

describe('font substitution: which renders consult it (g0ky.6 review)', () => {
  const throwing = () => {
    const doc = pdf();
    const err = new Error('handler bug');
    let calls = 0;
    doc.SetFontSubstitutionHandler(() => { calls++; throw err; });
    return { doc, err, calls: () => calls };
  };

  it('ToTiff and an HTML page backdrop render through it, so its error reaches the caller', () => {
    const a = throwing();
    expect(() => a.doc.ToTiff()).toThrow(a.err);
    const b = throwing();
    expect(() => b.doc.ToHtml({ mode: 'fixed', backdrop: 'page' })).toThrow(b.err);
  });

  it('a glyph-less raster backdrop draws no text and never asks it', () => {
    const t = throwing();
    t.doc.ToHtml({ mode: 'fixed', backdrop: 'raster' });
    expect(t.calls()).toBe(0);
  });

  it('fixed HTML with embedded fonts never asks it about a font with no program', () => {
    for (const fonts of ['embed', 'embed-all'] as const) {
      const t = throwing();
      t.doc.ToHtml({ mode: 'fixed', fonts });
      expect(t.calls()).toBe(0);
    }
  });
});
