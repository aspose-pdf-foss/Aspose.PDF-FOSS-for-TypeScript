import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { name, isStream, isDict, type PdfDict, type PdfObject } from '../src/types.js';
import { decodeStream } from '../src/filters.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { constantAlphaPdf, luminositySoftMaskPdf, isolatedGroupPdf, blendModePdf } from './helpers/build-transparency-fixtures.js';
import { buildSignedGrayscalePdf } from './helpers/build-grayscale-pdf.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { decodePng } from './helpers/decode-png.js';

const opt = { flattenTransparency: { dpi: 72 } };
function transparentDoc(count = 1): Document {
  const doc = Document.Open(buildClassicPdf(count));
  const gs = doc.allocObject(new Map<string, PdfObject>([['ca', 0.5], ['CA', 0.5]]));
  for (const page of doc.Pages) {
    page.Dict.set('Resources', new Map<string, PdfObject>([
      ['Font', new Map([['F1', new Map<string, PdfObject>([
        ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')], ['Encoding', name('WinAnsiEncoding')],
      ])]])], ['ExtGState', new Map([['A', gs]])],
    ]));
    const raw = new TextEncoder().encode('q /A gs 1 0 0 rg 50 50 100 100 re f Q BT /F1 12 Tf 20 25 Td (Search me) Tj ET');
    page.Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw }));
  }
  return doc;
}
function rasterActions(report: ReturnType<Document['ConvertToPdfA']>) {
  return report.applied.filter((a) => a.rule === 'Transparency' && /[Rr]asteriz/.test(a.action));
}
function contents(doc: Document): string {
  const s = doc.resolve(doc.Pages[0].Dict.get('Contents'));
  if (!isStream(s)) throw new Error('expected one content stream');
  return new TextDecoder().decode(decodeStream(s));
}

describe('PDF/A-1 opt-in transparency flattening', () => {
  it.each([undefined, false])('leaves real transparency unresolved with option %s', (flattenTransparency) => {
    const doc = Document.Open(constantAlphaPdf()), report = doc.ConvertToPdfA('1b', { flattenTransparency });
    expect(report.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
    expect(rasterActions(report)).toHaveLength(0);
    expect(doc.Pages[0].Images).toHaveLength(0);
  });

  it('flattens alpha over the backdrop and validates live and saved documents', () => {
    const doc = Document.Open(constantAlphaPdf()), before = doc.Pages[0].ToImage();
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(1);
    expect(report.unresolved).toEqual([]);
    expect(report.passed).toBe(true);
    expect(doc.Pages[0].ToImage()).toEqual(before);
    expect(decodePng(doc.Pages[0].ToImage()).at(100, 100)).toEqual([255, 128, 128, 255]);
    expect(Document.Open(doc.Save()).ValidatePdfA('1b').Passed).toBe(true);
  });

  it('removes the flattened page transparency group', () => {
    const doc = transparentDoc();
    doc.Pages[0].Dict.set('Group', new Map([['S', name('Transparency')]]));
    const before = doc.Pages[0].ToImage();
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(1);
    expect(doc.Pages[0].Dict.has('Group')).toBe(false);
    expect(report.unresolved).toEqual([]);
    expect(doc.Pages[0].ToImage()).toEqual(before);
  });

  it.each([luminositySoftMaskPdf, isolatedGroupPdf, () => blendModePdf('Multiply')])('handles soft masks and groups without orphan transparency', (build) => {
    const doc = Document.Open(build()), before = doc.Pages[0].ToImage();
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(1);
    expect(report.unresolved).toEqual([]);
    expect(doc.Pages[0].ToImage()).toEqual(before);
  });

  it('preserves text extraction through a complete invisible embedded-font layer', () => {
    const doc = transparentDoc(), text = doc.Pages[0].GetText(), before = doc.Pages[0].ToImage();
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(1);
    expect(report.passed).toBe(true);
    expect(doc.Pages[0].GetText()).toBe(text);
    expect(contents(doc)).toContain('3 Tr');
    expect(doc.Pages[0].ToImage()).toEqual(before);
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).toBe(text);
    expect(reopened.ValidatePdfA('1b').Passed).toBe(true);
    const fontRes = doc.resolve(doc.Pages[0].Resources?.get('Font'));
    expect(isDict(fontRes)).toBe(true);
  });

  it.each([90, 180, 270])('keeps offset crop geometry and rotation %i', (rotation) => {
    const doc = transparentDoc();
    doc.Pages[0].Dict.set('MediaBox', [-20, -10, 210, 220]);
    doc.Pages[0].Dict.set('CropBox', [10, 10, 180, 190]);
    doc.Pages[0].Dict.set('Rotate', rotation);
    const before = doc.Pages[0].ToImage(), text = doc.Pages[0].GetText();
    doc.ConvertToPdfA('1b', opt);
    expect(doc.Pages[0].ToImage()).toEqual(before);
    expect(doc.Pages[0].GetText()).toBe(text);
    expect(doc.Pages[0].Dict.get('CropBox')).toEqual([10, 10, 180, 190]);
    expect(doc.Pages[0].Dict.get('Rotate')).toBe(rotation);
  });

  it('keeps nested-form text and rotated baselines searchable', () => {
    const doc = Document.Open(buildSvgPdf({
      resources: '<< /XObject << /Fm 5 0 R >> /ExtGState << /A << /ca 0.5 >> >> >>',
      content: 'q /A gs 1 0 0 rg 0 0 50 50 re f Q q 0 1 -1 0 150 20 cm /Fm Do Q',
      extra: { 5: { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
        raw: new TextEncoder().encode('BT /F1 12 Tf 10 10 Td (Nested) Tj ET') } },
    }));
    const text = doc.Pages[0].GetText();
    doc.ConvertToPdfA('1b', opt);
    expect(doc.Pages[0].GetText()).toBe(text);
    expect(text).toContain('Nested');
  });

  it('retains the orientation of zero-width combining glyphs', () => {
    const doc = transparentDoc(), fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
    const font = doc.resolve(fonts.get('F1')) as PdfDict;
    font.set('FirstChar', 65); font.set('LastChar', 67); font.set('Widths', [600, 0, 600]);
    const cmap = new TextEncoder().encode('begincmap 3 beginbfchar <41> <0041> <42> <0301> <43> <0043> endbfchar endcmap');
    font.set('ToUnicode', doc.allocObject({ kind: 'stream', dict: new Map(), raw: cmap }));
    const raw = new TextEncoder().encode('q /A gs 0 0 10 10 re f Q BT /F1 12 Tf 0 1 -1 0 100 20 Tm (ABC) Tj ET');
    doc.Pages[0].Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw }));
    expect(doc.Pages[0].GetText()).toBe('A\u0301C');
    doc.ConvertToPdfA('1b', opt);
    expect(doc.Pages[0].GetText()).toBe('A\u0301C');
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe('A\u0301C');
  });

  it('declines vertical writing without changing text order or selection geometry', () => {
    const raw = new TextEncoder().encode('begincmap 2 beginbfchar <0001> <3042> <0002> <3044> endbfchar endcmap');
    const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 300, 300],
      resources: '<< /Font << /V 5 0 R /H << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> /ExtGState << /A << /ca .5 >> >> >>',
      content: 'q /A gs 0 0 10 10 re f Q BT /V 20 Tf 1 0 0 1 100 250 Tm <00010001> Tj 1 0 0 1 150 250 Tm <00020002> Tj /H 12 Tf 1 0 0 1 20 280 Tm (Header) Tj ET',
      extra: {
        5: '<< /Type /Font /Subtype /Type0 /BaseFont /Vertical /Encoding /Identity-V /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
        6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Vertical /DW 1000 /DW2 [880 -1000] /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
        7: { dict: `<< /Length ${raw.length} >>`, raw },
      },
    }));
    const text = doc.Pages[0].GetText();
    const before = doc.Pages[0].GetTextFragments().map((f) => [f.text, f.quad, f.vertical]);
    expect(before.some((f) => f[2] === true)).toBe(true);
    const result = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(result)).toHaveLength(0);
    expect(doc.Pages[0].GetText()).toBe(text);
    expect(doc.Pages[0].GetTextFragments().map((f) => [f.text, f.quad, f.vertical])).toEqual(before);
    expect(result.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
  });

  it('honors preserved optional content, including text in an OFF layer', () => {
    const doc = transparentDoc();
    const layer = doc.allocObject(new Map<string, PdfObject>([['Type', name('OCG')], ['Name', { kind: 'string', bytes: new TextEncoder().encode('Layer') }]]));
    doc.catalog().set('OCProperties', new Map<string, PdfObject>([['OCGs', [layer]], ['D', new Map<string, PdfObject>([['OFF', [layer]]])]]));
    doc.Pages[0].Resources!.set('Properties', new Map([['Layer', layer]]));
    const raw = new TextEncoder().encode('q /A gs 0 0 10 10 re f Q /OC /Layer BDC BT /F1 12 Tf 20 25 Td (Keep hidden) Tj ET EMC');
    doc.Pages[0].Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw }));
    expect(doc.Pages[0].GetText()).toBe('');
    const before = doc.Pages[0].GetText({ includeHidden: true });
    expect(before).toContain('Keep hidden');
    const report = doc.ConvertToPdfA('1b', { ...opt, preserve: ['optionalContent'] });
    expect(rasterActions(report)).toHaveLength(0);
    expect(doc.Pages[0].GetText({ includeHidden: true })).toBe(before);
    expect(report.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
  });

  it('honors preserved PostScript resources instead of deleting them as orphans', () => {
    const doc = Document.Open(buildPdfaPdf({ psXObject: true }, 1));
    doc.Pages[0].Resources!.set('ExtGState', new Map([['A', new Map([['ca', 0.5]])]]));
    const original = doc.Pages[0].Dict.get('Contents');
    const report = doc.ConvertToPdfA('1b', { ...opt, preserve: ['postScript'] });
    expect(rasterActions(report)).toHaveLength(0);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(original);
    expect(report.unresolved.some((i) => i.rule === 'PostScriptXObject')).toBe(true);
  });

  it('retains Unicode mappings and already invisible text without OCR', () => {
    const doc = transparentDoc(), fonts = doc.resolve(doc.Pages[0].Resources!.get('Font')) as PdfDict;
    const font = doc.resolve(fonts.get('F1')) as PdfDict;
    const cmap = new TextEncoder().encode('begincmap 1 beginbfchar <41> <03A9> endbfchar endcmap');
    font.set('ToUnicode', doc.allocObject({ kind: 'stream', dict: new Map(), raw: cmap }));
    const raw = new TextEncoder().encode('q /A gs 0 0 10 10 re f Q BT /F1 12 Tf 20 25 Td <41> Tj 3 Tr 0 20 Td (hidden) Tj ET');
    doc.Pages[0].Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw }));
    const before = doc.Pages[0].GetText();
    expect(before).toContain('Ω'); expect(before).toContain('hidden');
    doc.ConvertToPdfA('1b', opt);
    expect(doc.Pages[0].GetText()).toBe(before);
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toBe(before);
  });

  it('keeps annotations interactive and out of the raster image', () => {
    const doc = transparentDoc(), raw = new TextEncoder().encode('0 0 1 rg 0 0 30 30 re f');
    const ap = doc.allocObject({ kind: 'stream', raw, dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 30, 30]], ['Resources', new Map()],
    ]) });
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Stamp')], ['Rect', [10, 10, 40, 40]], ['F', 4], ['AP', new Map([['N', ap]])],
    ]));
    doc.Pages[0].Dict.set('Annots', [annot]);
    const without = doc.Pages[0].ToImage({ annotations: false }), withAnnot = doc.Pages[0].ToImage();
    expect(Buffer.compare(without, withAnnot)).not.toBe(0);
    doc.ConvertToPdfA('1b', opt);
    expect(doc.Pages[0].Dict.get('Annots')).toEqual([annot]);
    expect(doc.Pages[0].ToImage({ annotations: false })).toEqual(without);
    expect(doc.Pages[0].ToImage()).toEqual(withAnnot);
  });

  it.each(['N', 'R', 'D'])('declines annotations whose %s appearance inherits page resources', (state) => {
    const doc = transparentDoc(), raw = new TextEncoder().encode('0 0 1 rg 0 0 30 30 re f');
    const ink = doc.allocObject({ kind: 'stream', raw, dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 30, 30]], ['Resources', new Map()],
    ]) });
    doc.Pages[0].Resources!.set('XObject', new Map([['Ink', ink]]));
    const ap = doc.allocObject({ kind: 'stream', raw: new TextEncoder().encode('/Ink Do'),
      dict: new Map<string, PdfObject>([['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 30, 30]]]),
    });
    // Include indirect state dictionaries and inactive rollover/down states;
    // the flattening decision precedes the later appearance-pruning pass.
    const appearance = state === 'N' ? ap : doc.allocObject(new Map([['On', ap]]));
    const annot = doc.allocObject(new Map<string, PdfObject>([
      ['Type', name('Annot')], ['Subtype', name('Stamp')], ['Rect', [10, 10, 40, 40]], ['F', 4],
      ['AP', new Map<string, PdfObject>([['N', ink], [state, appearance]])],
    ]));
    doc.Pages[0].Dict.set('Annots', [annot]);
    const before = doc.Pages[0].ToImage(), content = doc.Pages[0].Dict.get('Contents');
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(0);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(content);
    expect(doc.Pages[0].ToImage()).toEqual(before);
    expect(doc.resolve(ink)).toBeTruthy();
    expect(report.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
  });

  it('uses the requested resolution and embeds RGB under an ICC color space', () => {
    const doc = Document.Open(constantAlphaPdf()); doc.ConvertToPdfA('1b', { flattenTransparency: true });
    const img = doc.Pages[0].Images[0];
    expect(img.Width).toBe(Math.ceil(200 * 150 / 72));
    expect(img.Dict.get('ColorSpace')).toEqual([name('ICCBased'), expect.anything()]);
  });

  it('preserve transparency wins over flattening', () => {
    const doc = transparentDoc(), report = doc.ConvertToPdfA('1b', { ...opt, preserve: ['transparency'] });
    expect(rasterActions(report)).toHaveLength(0);
    expect(report.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
  });

  it.each(['2b', '3b', '4'] as const)('does not rasterize PDF/A-%s', (level) => {
    const doc = transparentDoc(), report = doc.ConvertToPdfA(level, opt);
    expect(rasterActions(report)).toHaveLength(0);
    expect(doc.Pages[0].Images).toHaveLength(0);
  });

  it('leaves opaque pages intact and retains shared objects still in use', () => {
    const doc = transparentDoc(2);
    const first = doc.Pages[0].Resources!, fonts = first.get('Font');
    doc.Pages[1].Dict.set('Resources', new Map<string, PdfObject>([['Font', fonts!]]));
    const original = doc.Pages[1].Dict.get('Contents');
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(1);
    expect(doc.Pages[1].Dict.get('Contents')).toEqual(original);
    expect(doc.Pages[1].GetText()).toContain('Search me');
  });

  it('removes inherited resources only after their leaf pages stop inheriting them', () => {
    const doc = transparentDoc(2), pages = doc.resolve(doc.catalog().get('Pages')) as PdfDict;
    pages.set('Resources', doc.Pages[0].Resources!);
    for (const p of doc.Pages) p.Dict.delete('Resources');
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(2);
    expect(pages.has('Resources')).toBe(false);
    expect(report.unresolved).toEqual([]);
  });

  it('does not remove pre-existing orphan objects', () => {
    const doc = transparentDoc(), orphan = doc.allocObject(new Map([['Marker', name('Keep')]]));
    const value = doc.resolve(orphan);
    doc.ConvertToPdfA('1b', opt);
    expect(doc.resolve(orphan)).toBe(value);
  });

  it.each(['StructParents', 'MCID'])('leaves tagged content (%s) unresolved rather than breaking links', (kind) => {
    const doc = transparentDoc();
    if (kind === 'StructParents') doc.Pages[0].Dict.set('StructParents', 0);
    else {
      const raw = new TextEncoder().encode('/P <</MCID 0>> BDC q /A gs 0 0 50 50 re f Q EMC');
      doc.Pages[0].Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw }));
    }
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(0);
    expect(report.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 1201])('refuses invalid DPI %s before any mutation', (dpi) => {
    const doc = transparentDoc(), before = doc.Save();
    expect(() => doc.ConvertToPdfA('1b', { flattenTransparency: { dpi } })).toThrow(RangeError);
    expect(doc.Save()).toEqual(before);
  });

  it.each([null, 'yes', 1, [], { dpi: '150' }])('rejects malformed options before mutation (%j)', (flattenTransparency) => {
    const doc = transparentDoc(), before = doc.Save();
    expect(() => doc.ConvertToPdfA('1b', { flattenTransparency } as any)).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  it('propagates canvas pixel limits before replacing the current page', () => {
    const bytes = transparentDoc().Save();
    const doc = Document.Open(bytes, { limits: LoadLimits.defaults.with({ maxCanvasPixels: 10 }) });
    const before = doc.Pages[0].Dict.get('Contents');
    expect(() => doc.ConvertToPdfA('1b', opt)).toThrow(ResourceLimitError);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(before);
  });

  it('uses the same sync and async implementation', async () => {
    const bytes = transparentDoc().Save(), sync = Document.Open(bytes), asyncDoc = Document.Open(bytes);
    const expected = sync.ConvertToPdfA('1b', opt);
    const actual = await asyncDoc.ConvertToPdfAAsync('1b', opt);
    expect(actual.passed).toBe(expected.passed);
    expect(actual.applied.map((a) => [a.rule, a.action])).toEqual(expected.applied.map((a) => [a.rule, a.action]));
    expect(asyncDoc.Pages[0].GetText()).toBe(sync.Pages[0].GetText());
    expect(asyncDoc.Pages[0].ToImage()).toEqual(sync.Pages[0].ToImage());
  });

  it('cancels between complete pages with a finished text font and coherent graph', async () => {
    const doc = transparentDoc(2), controller = new AbortController(), reason = new Error('stop');
    await expect(doc.ConvertToPdfAAsync('1b', { ...opt, signal: controller.signal, onProgress: (e) => {
      expect(e.operation).toBe('ConvertToPdfA');
      if (e.phase === 'transparency-pages') controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(doc.Pages[0].Images).toHaveLength(1);
    expect(doc.Pages[1].Images).toHaveLength(0);
    expect(doc.Pages[0].GetText()).toContain('Search me');
    const reopened = Document.Open(doc.Save());
    expect(reopened.Validate().Passed).toBe(true);
    expect(reopened.Pages[0].GetText()).toContain('Search me');
    expect(doc.ValidatePdfA('1b').Errors.some((i) => i.rule === 'Transparency')).toBe(true);
  });

  it('does not flatten a document with a signature field', () => {
    const doc = Document.Open(buildSignedGrayscalePdf());
    doc.Pages[0].Dict.set('Resources', new Map([['ExtGState', new Map([['A', new Map([['ca', 0.5]])]])]]));
    const raw = new TextEncoder().encode('q /A gs 0 0 10 10 re f Q');
    doc.Pages[0].Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map(), raw }));
    const original = doc.Pages[0].Dict.get('Contents');
    const report = doc.ConvertToPdfA('1b', opt);
    expect(rasterActions(report)).toHaveLength(0);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(original);
    expect(report.unresolved.some((i) => i.rule === 'Transparency')).toBe(true);
  });
});
