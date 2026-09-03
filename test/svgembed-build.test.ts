/** buildSvgForm imports an SVG from a Document alone — no Page — which is what
 *  lets zch2.12 run the import at BUILD time and fold the importer's report
 *  into AddHtml's, which is handed back before anything is drawn. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildSvgForm } from '../src/svgembed.js';

const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
  + '<rect width="10" height="10" fill="red"/></svg>');

describe('buildSvgForm', () => {
  it('builds a Form XObject with no page in sight', () => {
    const doc = Document.New();
    const built = buildSvgForm(doc, SVG, [100, 100]);
    expect(built.ref).toBeDefined();
    expect(built.skipped).toEqual([]);
    expect(built.rasterized).toEqual([]);
  });

  it('reports what it could not render, at BUILD time', () => {
    // An <image> with an href this library cannot decode and no resolver.
    const doc = Document.New();
    const built = buildSvgForm(doc, new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
      + '<image href="nope.png" width="10" height="10"/></svg>'), [100, 100]);
    expect(built.skipped).toContain('image');
  });

  it('matrixFor(rect) equals a translate of matrixFor at the origin', () => {
    // The whole reason the builder takes a SIZE: placementMatrix bakes rx/ry
    // into e and f ADDITIVELY, so position is a translate and a form can be
    // built before its position is known.
    const doc = Document.New();
    const built = buildSvgForm(doc, SVG, [100, 50]);
    const atOrigin = built.matrixFor([0, 0, 100, 50]);
    const moved = built.matrixFor([20, 30, 100, 50]);
    expect(moved[0]).toBeCloseTo(atOrigin[0], 9);
    expect(moved[3]).toBeCloseTo(atOrigin[3], 9);
    expect(moved[4]).toBeCloseTo(atOrigin[4] + 20, 9);
    expect(moved[5]).toBeCloseTo(atOrigin[5] + 30, 9);
  });

  it('allocates nothing on a page, unlike AddSVGObject', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = new TextDecoder('latin1').decode(page.Contents);
    buildSvgForm(doc, SVG, [100, 100]);
    expect(new TextDecoder('latin1').decode(page.Contents)).toBe(before);
  });
});
