import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict } from '../src/types.js';
import { visitContent, mul, type GlyphEvent } from '../src/text.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { buildInkTtf } from './helpers/build-sfnt.js';

const options = { flattenTransparency: { dpi: 72 } };
const ink = buildInkTtf();
const cmap = new TextEncoder().encode(
  'begincmap 7 beginbfchar <0001> <3042> <0002> <3044> ' +
  '<0003> <00660069D835DC00> <0004> <3042> <0005> <3046> ' +
  '<0006> <3048> <0007> <304A> endbfchar endcmap');

/** All visible source codes draw the same ink glyph. Their Unicode strings
 *  and vertical metrics are independently controlled by the PDF dictionaries. */
function verticalDoc(content: string, form = false): Document {
  const fonts = '/Font << /V 5 0 R /H << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>';
  return Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 300, 300],
    resources: `<< ${fonts} /ExtGState << /A << /ca .5 >> >> ${form ? '/XObject << /Fm 11 0 R >>' : ''} >>`,
    content: `q /A gs 1 0 0 rg 0 0 10 10 re f Q ${form ? 'q .8 .2 -.1 1 20 10 cm /Fm Do Q q 1 0 0 1 80 -20 cm /Fm Do Q' : content}`,
    extra: {
      5: '<< /Type /Font /Subtype /Type0 /BaseFont /Ink /Encoding /Identity-V /DescendantFonts [6 0 R] /ToUnicode 9 0 R >>',
      6: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Ink /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap 10 0 R /DW 1000 /DW2 [900 -1000] /W2 [1 [-800 400 850 -1200 450 870 -600 500 880 -1500 350 800 0 500 880 500 500 880]] >>',
      7: '<< /Type /FontDescriptor /FontName /Ink /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /StemV 80 /FontFile2 8 0 R >>',
      8: { dict: `<< /Length1 ${ink.length} >>`, raw: ink },
      9: { dict: '<< >>', raw: cmap },
      10: { dict: '<< >>', raw: Uint8Array.of(0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1) },
      ...(form ? { 11: { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 300 300] /Matrix [1 .1 .2 1 4 6] /Resources << ${fonts} /XObject << /Inner 12 0 R >> >> >>`,
        raw: new TextEncoder().encode('q 1 0 0 1 3 5 cm /Inner Do Q') },
        12: { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 300 300] /Matrix [.9 0 0 1 2 1] /Resources << ${fonts} >> >>`,
          raw: new TextEncoder().encode(content) } } : {}),
    } as NonNullable<Parameters<typeof buildSvgPdf>[0]['extra']>,
  }));
}

function glyphs(doc: Document, page = 0): GlyphEvent[] {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[page], { glyph: (g) => out.push(g) });
  return out;
}

function near(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 4));
}

function preservesGeometry(actual: GlyphEvent[], expected: GlyphEvent[]): void {
  expect(actual.map((g) => [g.text, g.vertical])).toEqual(expected.map((g) => [g.text, g.vertical]));
  actual.forEach((g, i) => {
    const source = expected[i];
    near(g.quad, source.quad);
    near(g.penEnd, source.penEnd);
    expect(g.fontSize).toBeCloseTo(source.fontSize, 4);
    if (g.vertical) {
      expect(g.tfSize).toBe(source.tfSize);
      const m = mul(g.tm, g.ctm), original = mul(source.tm, source.ctm);
      near(m.slice(0, 4), original.slice(0, 4));
    }
  });
}

function flattenAndCheck(doc: Document): void {
  const before = glyphs(doc), text = doc.Pages[0].GetText();
  const searches = doc.Pages[0].Search('あ').map((hit) => hit.quads);
  const image = doc.Pages[0].ToImage();
  const result = doc.ConvertToPdfA('1b', options);
  expect(result.applied.filter((a) => a.rule === 'Transparency' && /Rasterized/.test(a.action))).toHaveLength(1);
  expect(result.passed).toBe(true);
  expect(result.unresolved).toEqual([]);
  preservesGeometry(glyphs(doc), before);
  expect(doc.Pages[0].GetText()).toBe(text);
  expect(doc.Pages[0].ToImage()).toEqual(image);
  const reopened = Document.Open(doc.Save());
  preservesGeometry(glyphs(reopened), before);
  expect(reopened.Pages[0].GetText()).toBe(text);
  const afterSearches = reopened.Pages[0].Search('あ').map((hit) => hit.quads);
  expect(afterSearches).toHaveLength(searches.length);
  afterSearches.forEach((quads, i) => {
    expect(quads).toHaveLength(searches[i].length);
    quads.forEach((quad, j) => near(quad, searches[i][j]));
  });
  expect(reopened.ValidatePdfA('1b').Passed).toBe(true);
}

describe('vertical glyphless transparency flattening (izia)', () => {
  it('retains one cell per glyph, varied advances, original sizes and mixed-direction ordering', () => {
    const doc = verticalDoc(
      'BT /H 12 Tf 20 280 Td (Header) Tj /V 20 Tf 1 0 0 1 100 250 Tm <0001000400020003> Tj ' +
      '/V 14 Tf 1 0 0 1 180 250 Tm <00070001> Tj /H 12 Tf 1 0 0 1 20 20 Tm (Footer) Tj ET');
    const vertical = glyphs(doc).filter((g) => g.vertical);
    expect(vertical.map((g) => g.text)).toEqual(['あ', 'あ', 'い', 'fi\u{1d400}', 'お', 'あ']);
    expect(vertical[0].quad).toEqual([90, 234, 110, 250]);
    expect(vertical[1].quad).toEqual([90, 204, 110, 234]);
    expect(vertical[3].quad).toEqual([90, 168, 110, 180]);
    expect(doc.Pages[0].GetText()).toContain('fi\u{1d400}');
    flattenAndCheck(doc);
  });

  it('retains Tc, Tz, TJ gaps, rise, zero advances and upward advances', () => {
    const doc = verticalDoc(
      'BT /V 20 Tf 150 Tz 2 Tc 5 Ts 1 0 0 1 100 250 Tm [<0001> 100 <00040002>] TJ ' +
      '0 Tc 1 0 0 1 180 200 Tm <00050006> Tj ET');
    const before = glyphs(doc);
    expect(before[0].quad).toEqual([90, 241, 110, 255]);
    expect(before[1].penEnd).toEqual([100, 211]);
    expect(before[3].quad).toEqual([170, 205, 190, 205]);
    expect(before[4].quad).toEqual([170, 205, 190, 215]);
    flattenAndCheck(doc);
  });

  it.each([0, -12])('retains unusual source font size %s with character spacing', (size) => {
    const doc = verticalDoc(`BT /V ${size} Tf 3 Tc 100 200 Td <00010002> Tj /H 12 Tf 1 0 0 1 20 20 Tm (After) Tj ET`);
    flattenAndCheck(doc);
  });

  it.each([
    ['/V 100000000 Tf .0000001 0 0 .0000001', 100000000],
    ['/V .0000001 Tf 100000000 0 0 100000000', 0.0000001],
  ] as const)('retains small source operands with compensating scales (%s)', (operands, size) => {
    const doc = verticalDoc(`BT ${operands} 100 250 Tm <00010004> Tj ET`);
    const source = glyphs(doc);
    expect(source[0].tfSize).toBe(size);
    expect(source[0].fontSize).toBe(10);
    expect(source[0].quad).toEqual([95, 242, 105, 250]);
    flattenAndCheck(doc);
  });

  it.each([0, 20])('retains one-byte vertical word spacing at size %s and resets it for horizontal text', (size) => {
    const doc = verticalDoc(`BT /V ${size} Tf 3 Tc 5 Tw 100 250 Td <2041> Tj ` +
      '/H 12 Tf 0 Tc 0 Tw 1 0 0 1 20 20 Tm (After) Tj ET');
    const fonts = doc.resolve(doc.Pages[0].Resources!.get('Font'));
    if (!isDict(fonts)) throw new Error('no fonts');
    const font = doc.resolve(fonts.get('V'));
    if (!isDict(font)) throw new Error('no vertical font');
    font.set('Encoding', doc.allocObject({ kind: 'stream', dict: new Map(), raw: new TextEncoder().encode(
      'begincmap /WMode 1 def 1 begincodespacerange <00> <FF> endcodespacerange ' +
      '2 begincidchar <20> 1 <41> 2 endcidchar endcmap') }));
    font.set('ToUnicode', doc.allocObject({ kind: 'stream', dict: new Map(), raw: new TextEncoder().encode(
      'begincmap 2 beginbfchar <20> <3042> <41> <3044> endbfchar endcmap') }));
    expect(glyphs(doc)[0].penEnd).toEqual([100, size === 0 ? 258 : 242]);
    flattenAndCheck(doc);
  });

  it.each([0, 90, 180, 270])('retains transformed nested/repeated forms on a cropped page rotated %s', (rotation) => {
    const doc = verticalDoc('BT /V 18 Tf 4 Ts 1 .2 .1 1 60 180 Tm <000100030004> Tj ET', true);
    doc.Pages[0].Dict.set('CropBox', [10, 20, 280, 290]);
    doc.Pages[0].Dict.set('Rotate', rotation);
    flattenAndCheck(doc);
  });

  it('finishes vertical mappings before cancellation yields a partially converted document', async () => {
    const source = verticalDoc('BT /V 20 Tf 100 250 Td <000100030004> Tj ET');
    const doc = Document.New();
    doc.Append(source);
    doc.Append(source);
    const before = glyphs(doc), text = doc.Pages[0].GetText();
    const controller = new AbortController(), reason = new Error('stop');
    await expect(doc.ConvertToPdfAAsync('1b', { ...options, signal: controller.signal, onProgress: (e) => {
      if (e.phase === 'transparency-pages') controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(doc.Pages[0].Images).toHaveLength(1);
    expect(doc.Pages[1].Images).toHaveLength(0);
    const reopened = Document.Open(doc.Save());
    preservesGeometry(glyphs(reopened), before);
    expect(reopened.Pages[0].GetText()).toBe(text);
    expect(reopened.Validate().Passed).toBe(true);
  });

  it('preserves the same vertical text and image through the async entry point', async () => {
    const bytes = verticalDoc('BT /V 20 Tf 100 250 Td <000100030004> Tj ET').Save();
    const sync = Document.Open(bytes), cooperative = Document.Open(bytes);
    const expected = sync.ConvertToPdfA('1b', options);
    const actual = await cooperative.ConvertToPdfAAsync('1b', options);
    expect(actual.passed).toBe(expected.passed);
    expect(actual.passed).toBe(true);
    preservesGeometry(glyphs(cooperative), glyphs(sync));
    expect(cooperative.Pages[0].GetText()).toBe(sync.Pages[0].GetText());
    expect(cooperative.Pages[0].ToImage()).toEqual(sync.Pages[0].ToImage());
  });
});
