import { describe, expect, it } from 'vitest';
import { Document, LineAnnotation, PolyAnnotation, type Page, type RectilinearMeasure } from '../src/index.js';
import { isDict, name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildMeasureReadTarget } from './helpers/build-annot-target.js';

const basic = {
  scaleRatio: '8 pt = 1 ft',
  xAxis: [{ unit: 'ft', conversionFactor: 0.125 }],
  distance: [{ unit: 'ft', conversionFactor: 1 }],
  area: [{ unit: 'sq ft', conversionFactor: 1 }],
} satisfies RectilinearMeasure;

const detailed = {
  ...basic,
  scaleRatio: 'X 8 pt = 1 ft, Y 4 pt = 1 yd',
  yAxis: [{ unit: 'yd', conversionFactor: 0.25 }],
  distance: [
    { unit: 'ft', conversionFactor: 1 },
    {
      unit: 'in', conversionFactor: 12, fractionFormat: 'F', precision: 8, fixedDenominator: false,
      thousandsSeparator: '', decimalSeparator: ',', unitPrefix: '[', unitSuffix: ']', unitPosition: 'P',
    },
  ],
  angle: [{ unit: '°', conversionFactor: 1 }],
  slope: [{ unit: '%', conversionFactor: 100 }],
  origin: [4, -2],
  yToX: 3,
} satisfies RectilinearMeasure;

const builders = [
  ['Line', (page: Page, measure: RectilinearMeasure) => page.AddLine({ line: [0, 0, 16, 16], measure })],
  ['PolyLine', (page: Page, measure: RectilinearMeasure) => page.AddPolyline({ vertices: [0, 0, 16, 16], measure })],
  ['Polygon', (page: Page, measure: RectilinearMeasure) => page.AddPolygon({ vertices: [0, 0, 16, 0, 16, 16], measure })],
] as const;

describe('annotation measurements', () => {
  it('reads existing indirect measurements and the default rectilinear subtype', () => {
    const [line] = Document.Open(buildMeasureReadTarget()).Pages[0].Annotations;
    expect(line).toBeInstanceOf(LineAnnotation);
    expect((line as LineAnnotation).Measure).toEqual({
      ...basic,
      distance: [{ unit: 'ft', conversionFactor: 1, unitPosition: 'S' }, {
        unit: 'in', conversionFactor: 12, fractionFormat: 'F', precision: 8,
      }],
      origin: [10, -2],
    });
  });

  it('decodes existing PDFDocEncoding calibration text and unit labels', () => {
    const doc = Document.Open(buildMeasureReadTarget());
    const [line] = doc.Pages[0].Annotations;
    const measure = doc.resolve(line.Dict.get('Measure')) as PdfDict;
    measure.set('R', { kind: 'string', bytes: Uint8Array.of(0x84, 0xa0) });
    measure.set('T', [new Map<string, PdfObject>([
      ['U', { kind: 'string', bytes: Uint8Array.of(0x84) }], ['C', 1],
      ['PS', { kind: 'string', bytes: Uint8Array.of(0xa0) }],
    ])]);

    const [reopened] = Document.Open(doc.Save()).Pages[0].Annotations as LineAnnotation[];
    expect(reopened.Measure?.scaleRatio).toBe('—€');
    expect(reopened.Measure?.angle).toEqual([{ unit: '—', conversionFactor: 1, unitPrefix: '€' }]);
  });

  it('round-trips text whose code points collide with PDFDocEncoding accents', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const distance = [{ unit: 'ft', conversionFactor: 1, unitPrefix: '\u0018' }];
    page.AddLine({ line: [0, 0, 16, 16], measure: { ...basic, distance } });
    const [line] = Document.Open(doc.Save()).Pages[0].Annotations as LineAnnotation[];
    expect(line.Measure?.distance).toEqual(distance);
  });

  it.each(builders)('authors and reopens a %s with an ordered set of number formats', (subtype, add) => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const annotation = add(page, detailed);
    const raw = doc.resolve(annotation.Dict.get('Measure'));
    expect(isDict(raw)).toBe(true);
    const measure = raw as PdfDict;
    expect(measure.get('Type')).toEqual(name('Measure'));
    expect(measure.get('Subtype')).toEqual(name('RL'));
    expect(measure.get('CYX')).toBe(3);
    const [feet, inches] = measure.get('D') as PdfDict[];
    expect(feet.get('C')).toBe(1);
    expect(inches.get('C')).toBe(12);
    expect(inches.get('F')).toEqual(name('F'));
    expect(inches.get('D')).toBe(8);
    expect(inches.get('FD')).toBe(false);
    expect(inches.get('O')).toEqual(name('P'));

    const [reopened] = Document.Open(doc.Save()).Pages[0].Annotations;
    expect(reopened.Subtype).toBe(subtype);
    expect(reopened).toBeInstanceOf(subtype === 'Line' ? LineAnnotation : PolyAnnotation);
    expect((reopened as LineAnnotation | PolyAnnotation).Measure).toEqual(detailed);
  });

  it('replaces and clears an existing measure without changing the shape or its appearance', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const polygon = page.AddPolygon({ vertices: [0, 0, 16, 0, 16, 16] });
    const appearance = polygon.Dict.get('AP');
    polygon.Dict.set('IT', name('PolygonCloud'));
    expect(polygon.Measure).toBeUndefined();
    polygon.Measure = basic;
    polygon.Measure = detailed;
    expect(polygon.Measure).toEqual(detailed);
    polygon.Measure = undefined;
    expect(polygon.Dict.has('Measure')).toBe(false);
    expect(polygon.Dict.get('AP')).toBe(appearance);
    expect(polygon.Dict.get('IT')).toEqual(name('PolygonCloud'));
    expect(polygon.Vertices).toEqual([0, 0, 16, 0, 16, 16]);
  });

  it('keeps inputs and read snapshots independent from the PDF dictionaries', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const input = { ...basic, xAxis: [{ unit: 'ft', conversionFactor: 0.125 }] };
    const line = page.AddLine({ line: [0, 0, 16, 16], measure: input });
    input.xAxis[0].conversionFactor = 7;
    const snapshot = line.Measure!;
    snapshot.xAxis[0].unit = 'changed';
    expect(line.Measure).toEqual(basic);
  });

  it('leaves unsupported or malformed existing dictionaries accessible through Dict', () => {
    const doc = Document.Open(buildMeasureReadTarget());
    const [line] = doc.Pages[0].Annotations as LineAnnotation[];
    const original = line.Dict.get('Measure');
    const raw = doc.resolve(original) as PdfDict;
    raw.set('Subtype', name('GEO'));
    expect(line.Measure).toBeUndefined();
    expect(line.Dict.get('Measure')).toBe(original);
    raw.set('Subtype', name('RL'));
    raw.delete('A');
    expect(line.Measure).toBeUndefined();
  });

  it.each(builders)('rejects a malformed %s measurement before attaching the annotation', (_subtype, add) => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    doc.catalog().set('Version', name('1.6'));
    expect(() => add(page, { ...basic, xAxis: Array(1) })).toThrow(TypeError);
    expect(() => add(page, { ...basic, distance: [] })).toThrow(TypeError);
    expect(() => add(page, { ...basic, yToX: Infinity })).toThrow(TypeError);
    expect(() => add(page, { ...basic, origin: [0, NaN] })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
    expect(doc.catalog().get('Version')).toEqual(name('1.6'));
  });

  it.each(['create', 'edit'] as const)('emits at least PDF 1.7 when authoring a measurement with %s', (mode) => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    doc.catalog().set('Version', name('1.6'));
    if (mode === 'create') page.AddLine({ line: [0, 0, 16, 16], measure: basic });
    else page.AddLine({ line: [0, 0, 16, 16] }).Measure = basic;
    expect(new TextDecoder().decode(doc.Save().subarray(0, 8))).toBe('%PDF-1.7');

    doc.catalog().set('Version', name('2.0'));
    page.AddPolyline({ vertices: [0, 0, 16, 16], measure: basic });
    expect(new TextDecoder().decode(doc.Save().subarray(0, 8))).toBe('%PDF-2.0');
  });

  it('declares PDF 1.7 in an incremental update to an older PDF', () => {
    const original = Document.New();
    original.AddPage().page.AddLine({ line: [0, 0, 16, 16] });
    const bytes = original.Save();
    bytes[7] = 0x36; // Same-width version edit preserves the original xref offsets.
    const doc = Document.Open(bytes);
    expect(doc.headerVersion()).toBe('1.6');
    expect(doc.catalog().has('Version')).toBe(false);
    (doc.Pages[0].Annotations[0] as LineAnnotation).Measure = basic;

    const saved = doc.Save({ incremental: true });
    expect(new TextDecoder().decode(saved.subarray(0, 8))).toBe('%PDF-1.6');
    const reopened = Document.Open(saved);
    expect(reopened.headerVersion()).toBe('1.7');
    expect((reopened.Pages[0].Annotations[0] as LineAnnotation).Measure).toEqual(basic);
  });

  it('keeps an existing measurement when an update contains invalid number formatting', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const line = page.AddLine({ line: [0, 0, 16, 16], measure: basic });
    const original = line.Dict.get('Measure');
    const setDistance = (value: unknown) => { line.Measure = { ...basic, distance: [value as never] }; };
    expect(() => setDistance({ unit: 'ft', conversionFactor: NaN })).toThrow(TypeError);
    expect(() => setDistance({ unit: 'ft', conversionFactor: 1, precision: 2 })).toThrow(TypeError);
    expect(() => setDistance({ unit: 'ft', conversionFactor: 1, fixedDenominator: 1 })).toThrow(TypeError);
    expect(() => setDistance({ unit: 'ft', conversionFactor: 1, unitPosition: 'M' })).toThrow(TypeError);
    expect(line.Dict.get('Measure')).toBe(original);
    expect(line.Measure).toEqual(basic);
  });
});
