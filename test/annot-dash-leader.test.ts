import { describe, expect, it } from 'vitest';
import { Document, LineAnnotation, type Annotation, type Page } from '../src/index.js';
import { resolveAppearance } from '../src/annotappearance.js';
import { decodeStream } from '../src/filters.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildBlankPage } from './helpers/build-annot-target.js';
import { decodePng } from './helpers/decode-png.js';

function body(doc: Document, annot: Annotation): string {
  return new TextDecoder().decode(decodeStream(resolveAppearance(doc, annot.Dict)!.stream));
}

const dashed = { borderStyle: 'dashed', dashPattern: [8, 5] } as const;
const options = () => ({ ...dashed, dashPattern: [...dashed.dashPattern] });
const drawings = [
  ['square', (p: Page) => p.AddSquare({ rect: [10, 10, 100, 60], ...options() })],
  ['circle', (p: Page) => p.AddCircle({ rect: [10, 10, 100, 60], ...options() })],
  ['line', (p: Page) => p.AddLine({ line: [10, 10, 100, 60], ...options() })],
  ['polygon', (p: Page) => p.AddPolygon({ vertices: [10, 10, 100, 60, 10, 60], ...options() })],
  ['polyline', (p: Page) => p.AddPolyline({ vertices: [10, 10, 100, 60, 10, 60], ...options() })],
  ['ink', (p: Page) => p.AddInk({ paths: [[10, 10, 100, 60]], ...options() })],
] as const;

describe('drawing annotation borders', () => {
  it.each(drawings)('writes and regenerates a dashed %s from the same properties', (_, add) => {
    const doc = Document.Open(buildBlankPage());
    const a = add(doc.Pages[0]);
    expect(a.BorderStyle).toBe('dashed');
    expect(a.DashPattern).toEqual([8, 5]);
    const bs = doc.resolve(a.Dict.get('BS')) as PdfDict;
    expect(bs.get('S')).toEqual(name('D'));
    expect(bs.get('D')).toEqual([8, 5]);
    const expected = body(doc, a);
    expect(expected).toContain('[8 5] 0 d');
    const reopened = Document.Open(doc.Save());
    const [imported] = reopened.Pages[0].Annotations as (typeof a)[];
    expect(body(reopened, imported)).toBe(expected);
    imported.Dict.delete('AP');
    expect(body(reopened, imported)).toBe(expected);
    expect(imported.RegenerateAppearance()).toBe(true);
    expect(imported.Dict.has('AP')).toBe(true);
    expect(body(reopened, imported)).toBe(expected);
  });

  it('edits an imported indirect style without overwriting custom keys or another annotation', () => {
    const doc = Document.Open(buildBlankPage());
    const first = doc.Pages[0].AddSquare({ rect: [10, 10, 50, 50] });
    const second = doc.Pages[0].AddCircle({ rect: [50, 50, 80, 80] });
    const old = new Map<string, PdfObject>([['S', name('D')], ['W', 2], ['D', doc.allocObject([7, 4])], ['Private', 17]]);
    const ref = doc.allocObject(old);
    first.Dict.set('BS', ref);
    second.Dict.set('BS', ref);
    first.BorderWidth = 6;
    expect(first.BorderStyle).toBe('dashed');
    expect(first.DashPattern).toEqual([7, 4]);
    expect((doc.resolve(first.Dict.get('BS')) as PdfDict).get('Private')).toBe(17);
    expect(second.BorderWidth).toBe(2);
    first.DashPattern![0] = 37;
    expect(first.DashPattern).toEqual([7, 4]);
    const pattern = [5, 2];
    first.DashPattern = pattern;
    pattern[0] = 90;
    expect(first.DashPattern).toEqual([5, 2]);
    expect(body(doc, first)).toContain('[5 2] 0 d');
    first.DashPattern = undefined;
    expect(body(doc, first)).toContain('[3] 0 d');
    first.BorderStyle = 'solid';
    expect(body(doc, first)).not.toContain(' 0 d');
  });

  it('honours legacy /Border when /BS is absent, including after editing the width', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddLine({ line: [10, 20, 100, 20] });
    a.Dict.delete('BS');
    a.Dict.delete('AP');
    a.Dict.set('Border', doc.allocObject([0, 0, 2, [10, 6]]));
    expect(a.BorderWidth).toBe(2);
    expect(a.BorderStyle).toBe('dashed');
    expect(a.DashPattern).toEqual([10, 6]);
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(14, 180)[0]).toBeLessThan(10);
    expect(png.at(23, 180)[0]).toBe(255);
    a.BorderWidth = 3;
    expect(body(doc, a)).toContain('[10 6] 0 d');
  });

  it('restyles a line without moving its rectangle or discarding its alternate appearances', () => {
    const doc = Document.Open(buildBlankPage());
    const line = doc.Pages[0].AddLine({ line: [30, 30, 90, 30] });
    line.Rect = [12, 12, 125, 65];
    const ap = doc.resolve(line.Dict.get('AP')) as PdfDict;
    ap.set('R', ap.get('N')!);
    ap.set('D', ap.get('N')!);
    line.BorderStyle = 'dashed';
    const edited = doc.resolve(line.Dict.get('AP')) as PdfDict;
    expect(line.Rect).toEqual([12, 12, 125, 65]);
    expect(edited.get('R')).toEqual(ap.get('R'));
    expect(edited.get('D')).toEqual(ap.get('D'));
    expect(body(doc, line)).toContain('[3] 0 d');
  });

  it('regenerates and renders drawings with an indirect /Subtype', () => {
    const source = Document.Open(buildBlankPage());
    const a = source.Pages[0].AddLine({ line: [20, 30, 100, 30] });
    a.Dict.set('Subtype', source.allocObject(name('Line')));
    const doc = Document.Open(source.Save());
    const [line] = doc.Pages[0].Annotations as LineAnnotation[];
    expect(line).toBeInstanceOf(LineAnnotation);
    line.BorderStyle = 'dashed';
    expect(body(doc, line)).toContain('[3] 0 d');
    line.Dict.delete('AP');
    expect(body(doc, line)).toContain('[3] 0 d');
  });

  it('rejects invalid dash lengths and leaders before attaching or editing annotations', () => {
    const doc = Document.Open(buildBlankPage());
    const p = doc.Pages[0];
    for (const bad of [[0, 0], [-1, 1], [NaN], [Infinity], Array<number>(2)]) {
      expect(() => p.AddSquare({ rect: [10, 10, 60, 60], ...options(), dashPattern: bad })).toThrow();
    }
    expect(() => p.AddLine({ line: [10, 10, 60, 60], leaderLineLength: Infinity })).toThrow();
    expect(p.Annotations).toHaveLength(0);
    const a = p.AddLine({ line: [10, 10, 60, 60], ...options() });
    const before = doc.Save();
    expect(() => { a.DashPattern = [-1]; }).toThrow();
    expect(() => { a.LeaderLineLength = NaN; }).toThrow();
    expect(doc.Save()).toEqual(before);
  });
});

describe('signed line annotation leaders', () => {
  it.each(['create', 'edit'] as const)('declares PDF 1.6 on full and incremental saves after %s', mode => {
    const source = buildBlankPage();
    source[7] = 0x34; // The same-length header change preserves xref offsets.
    const doc = Document.Open(source);
    const line: [number, number, number, number] = [10, 10, 70, 10];
    if (mode === 'create') doc.Pages[0].AddLine({ line, leaderLineLength: -12 });
    else {
      const a = doc.Pages[0].AddLine({ line, leaderLineLength: 0 });
      expect(doc.Version).toBe('1.4');
      a.LeaderLineLength = -12;
    }
    const full = doc.Save();
    expect(new TextDecoder().decode(full.subarray(0, 8))).toBe('%PDF-1.6');
    const incremental = doc.Save({ incremental: true });
    expect(incremental.subarray(0, source.length)).toEqual(source);
    const reopened = Document.Open(incremental);
    expect(reopened.Version).toBe('1.6');
    expect((reopened.Pages[0].Annotations[0] as LineAnnotation).LeaderLineLength).toBe(-12);
  });

  it.each([20, -20])('draws both leaders, the displaced shaft and its ending for /LL %i', length => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddLine({ line: [30, 70, 130, 70], width: 2, leaderLineLength: length, endEnding: 'Square' });
    expect(a.LeaderLineLength).toBe(length);
    expect(a.Dict.get('L')).toEqual([30, 70, 130, 70]);
    const y = 70 + length;
    expect(a.Rect![1]).toBeLessThanOrEqual(Math.min(70, y - 4));
    expect(a.Rect![3]).toBeGreaterThanOrEqual(Math.max(70, y + 4));
    const reopened = Document.Open(doc.Save());
    const p = reopened.Pages[0];
    const [line] = p.Annotations as LineAnnotation[];
    expect(line.LeaderLineLength).toBe(length);
    const authored = body(reopened, line);
    const png = decodePng(p.ToImage());
    expect(png.at(30, 200 - (70 + length / 2))[0]).toBeLessThan(10);
    expect(png.at(130, 200 - (70 + length / 2))[0]).toBeLessThan(10);
    expect(png.at(80, 200 - y)[0]).toBeLessThan(10);
    expect(png.at(132, 200 - y + 2)[0]).toBeLessThan(10);
    expect(png.at(80, 130)[0]).toBe(255);
    line.Dict.delete('AP');
    expect(body(reopened, line)).toBe(authored);
    line.RegenerateAppearance();
    expect(body(reopened, line)).toBe(authored);
    line.LeaderLineLength = 0;
    expect(line.Dict.has('LL')).toBe(false);
    expect(decodePng(p.ToImage()).at(80, 130)[0]).toBeLessThan(10);
  });

  it('places a changed oblique line and signed leaders in the resized page', () => {
    const doc = Document.Open(buildBlankPage());
    const a = doc.Pages[0].AddLine({ line: [30, 30, 60, 70], width: 2, leaderLineLength: -10 });
    a.Line = [60, 40, 90, 80]; // right normal of (3, 4) offsets by (8, -6)
    doc.ResizePages([1], [0, 0, 600, 400]);
    expect(a.LeaderLineLength).toBe(-20);
    a.RegenerateAppearance();
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(166, 292)[0]).toBeLessThan(100); // shaft midpoint = (166,108)
    expect(png.at(128, 326)[0]).toBeLessThan(100); // start leader midpoint
    expect(png.at(188, 246)[0]).toBeLessThan(100); // end leader midpoint
  });
});
