import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';
import { decodePng } from './helpers/decode-png.js';

/** One document from a content stream per page (300 x 300 pages). */
const doc = (...streams: string[]): Document => Document.Open(buildMultiPageTextPdf(streams));
const sq = (rgb: string, x: number, y: number, s = 20) => `${rgb} rg ${x} ${y} ${s} ${s} re f\n`;
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('Document.CompareRendering', () => {
  it('reports identical pages as identical', () => {
    const r = doc(sq('0 0 1', 50, 50)).CompareRendering(doc(sq('0 0 1', 50, 50)));
    expect(r.identical).toBe(true);
    expect(r.changedPixels).toBe(0);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toMatchObject({ oldPage: 1, newPage: 1, width: 300, height: 300, changedPixels: 0, totalPixels: 90000, ratio: 0, regions: [] });
  });

  it('finds a recoloured square and places it in page space', () => {
    const r = doc(sq('0 0 1', 50, 50)).CompareRendering(doc(sq('1 0 0', 50, 50)));
    expect(r.identical).toBe(false);
    expect(r.pages[0].changedPixels).toBe(400);
    expect(r.pages[0].ratio).toBeCloseTo(400 / 90000);
    expect(r.pages[0].regions).toHaveLength(1);
    close(r.pages[0].regions[0], [50, 50, 70, 70]);
  });

  it('sees what text comparison cannot: same words, different colour', () => {
    const t = (rgb: string) => `${rgb} rg BT /F1 12 Tf 40 200 Td (same words) Tj ET`;
    const a = doc(t('0 0 0')), b = doc(t('1 0 0'));
    expect(a.CompareText(b).stats.changes).toBe(0);
    expect(a.CompareRendering(b).identical).toBe(false);
  });

  it('keeps regions in page space at any resolution', () => {
    const r = doc(sq('0 0 1', 50, 50)).CompareRendering(doc(sq('1 0 0', 50, 50)), { dpi: 144 });
    expect(r.pages[0]).toMatchObject({ width: 600, height: 600, changedPixels: 1600, totalPixels: 360000 });
    close(r.pages[0].regions[0], [50, 50, 70, 70]);
  });

  it('maps regions back through /Rotate and the CropBox', () => {
    const a = doc(sq('0 0 1', 50, 50)), b = doc(sq('1 0 0', 50, 50));
    for (const d of [a, b]) { d.Pages[0].Rotate = 90; d.Pages[0].Dict.set('CropBox', [10, 20, 290, 280]); }
    const p = a.CompareRendering(b).pages[0];
    expect([p.width, p.height]).toEqual([260, 280]);
    close(p.regions[0], [50, 50, 70, 70]);
  });

  it('ignores a difference within the tolerance', () => {
    const a = doc('0.5 g 50 50 20 20 re f'), b = doc('0.52 g 50 50 20 20 re f');
    expect(a.CompareRendering(b).identical).toBe(false);
    expect(a.CompareRendering(b, { tolerance: 10 }).identical).toBe(true);
  });

  it('joins nearby changes into one region, unless the merge distance is 0', () => {
    const a = doc(''), b = doc(sq('1 0 0', 50, 50, 10) + sq('1 0 0', 63, 50, 10));
    expect(a.CompareRendering(b).pages[0].regions).toHaveLength(1);
    expect(a.CompareRendering(b, { mergeDistance: 0 }).pages[0].regions).toHaveLength(2);
  });

  it('measures the merge distance in points, at any resolution', () => {
    // 3pt apart: 12 pixels at 288 dpi, inside the default 6pt only if scaled
    const a = doc(''), b = doc(sq('1 0 0', 50, 50, 10) + sq('1 0 0', 63, 50, 10));
    expect(a.CompareRendering(b, { dpi: 288 }).pages[0].regions).toHaveLength(1);
  });

  it('reports regions in the page space of the second document when the pages differ in size', () => {
    const b = doc(sq('1 0 0', 50, 50));
    b.Pages[0].Dict.set('MediaBox', [0, 0, 300, 400]);
    const p = doc('').CompareRendering(b).pages[0];
    close(p.regions[0], [50, 50, 70, 70]);
  });

  it('bases the difference image on the second document', () => {
    // within the tolerance, so not painted red: the faded pixel shows whose it is
    const b = doc('0.52 g 50 50 20 20 re f');
    const r = doc('0.5 g 50 50 20 20 re f').CompareRendering(b, { image: true, tolerance: 10 });
    const v = decodePng(b.Pages[0].ToImage()).at(60, 240)[0];
    expect(decodePng(r.pages[0].image!).at(60, 240)[0]).toBe(Math.round(v + (255 - v) * 0.75));
  });

  it('reports a page only one document has, against a blank page', () => {
    const r = doc('').CompareRendering(doc('', sq('1 0 0', 50, 50)));
    expect(r.pages).toHaveLength(2);
    expect(r.pages[1]).toMatchObject({ oldPage: undefined, newPage: 2, changedPixels: 400 });
    close(r.pages[1].regions[0], [50, 50, 70, 70]);
    const back = doc('', sq('1 0 0', 50, 50)).CompareRendering(doc(''));
    expect(back.pages[1]).toMatchObject({ oldPage: 2, newPage: undefined, changedPixels: 400 });
    close(back.pages[1].regions[0], [50, 50, 70, 70]);
  });

  it('compares pages of different size over the larger, aligned at the top left', () => {
    const b = doc('');
    b.Pages[0].Dict.set('MediaBox', [0, 0, 300, 400]);
    const p = doc('').CompareRendering(b).pages[0];
    expect([p.width, p.height, p.changedPixels]).toEqual([300, 400, 0]);
  });

  it('includes annotations unless told not to', () => {
    const a = doc(''), b = doc('');
    b.Pages[0].AddHighlight({ quads: [50, 70, 70, 70, 50, 50, 70, 50] });
    expect(a.CompareRendering(b).identical).toBe(false);
    expect(a.CompareRendering(b, { annotations: false }).identical).toBe(true);
  });

  it('writes a difference image when asked: the second page faded, changes in red', () => {
    const r = doc(sq('0 0 1', 50, 50)).CompareRendering(doc(sq('1 0 0', 50, 50) + sq('0 0 0', 200, 200)), { image: true });
    const png = decodePng(r.pages[0].image!);
    expect([png.width, png.height]).toEqual([300, 300]);
    expect(png.at(60, 300 - 60)).toEqual([255, 0, 0, 255]);         // changed: red
    expect(png.at(210, 300 - 210)).toEqual([255, 0, 0, 255]);       // new black square: changed too
    expect(png.at(5, 5)).toEqual([255, 255, 255, 255]);             // untouched white
    expect(doc('').CompareRendering(doc('')).pages[0].image).toBeUndefined();
  });

  it('fades unchanged ink in the difference image', () => {
    const k = sq('0 0 0', 200, 200);
    const r = doc(k).CompareRendering(doc(k + sq('1 0 0', 50, 50)), { image: true });
    expect(decodePng(r.pages[0].image!).at(210, 90)).toEqual([191, 191, 191, 255]);
  });

  it('totals the pages', () => {
    const r = doc(sq('0 0 1', 50, 50), '').CompareRendering(doc(sq('1 0 0', 50, 50), sq('1 0 0', 50, 50)));
    expect(r.changedPixels).toBe(800);
    expect(r.totalPixels).toBe(180000);
    expect(r.ratio).toBeCloseTo(800 / 180000);
  });

  it('leaves both documents unchanged', () => {
    const a = doc(sq('0 0 1', 50, 50)), b = doc(sq('1 0 0', 50, 50));
    const before = [a.Save(), b.Save()];
    a.CompareRendering(b, { image: true });
    expect(a.Save()).toEqual(before[0]);
    expect(b.Save()).toEqual(before[1]);
  });

  describe('refuses bad options before rendering anything', () => {
    it.each([
      [{ dpi: 0 }, RangeError], [{ dpi: Number.NaN }, RangeError],
      [{ tolerance: -1 }, RangeError], [{ tolerance: 256 }, RangeError], [{ tolerance: 1.5 }, RangeError],
      [{ mergeDistance: -1 }, RangeError], [{ mergeDistance: Number.POSITIVE_INFINITY }, RangeError],
    ] as [object, ErrorConstructor][])('%j', (o, E) => {
      expect(() => doc('').CompareRendering(doc(''), o as never)).toThrow(E);
    });

    it('refuses something that is not a Document', () => {
      expect(() => doc('').CompareRendering({} as never)).toThrow(/other must be a Document/);
    });

    it('refuses two documents with no pages', () => {
      expect(() => doc().CompareRendering(doc())).toThrow(RangeError);
    });
  });
});
