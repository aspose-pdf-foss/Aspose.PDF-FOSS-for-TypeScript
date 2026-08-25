import { describe, it, expect } from 'vitest';
import { Document, PageFormat } from '../src/index.js';
import { buildDocModel, type DocFigure, type DocNode } from '../src/docmodel.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

/** A 2x1 PNG: its aspect ratio deliberately matches neither rect below, so a
 *  size taken from the pixels cannot accidentally agree with the drawn box. */
const PNG = buildPngRgb();

function figures(nodes: DocNode[]): DocFigure[] {
  const out: DocFigure[] = [];
  const walk = (n: DocNode): void => {
    if (n.kind === 'figure') out.push(n);
    else if (n.kind === 'container') n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

describe('DocFigure sizes', () => {
  it('records the size the image was drawn at, not its pixel count', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddImage(PNG, [10, 10, 180, 120]);
    const fig = figures(buildDocModel(doc, doc.Pages))[0];
    expect(fig.sizes?.[0].width).toBeCloseTo(180, 1);
    expect(fig.sizes?.[0].height).toBeCloseTo(120, 1);
  });

  it('keeps sizes the same length as images', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddImage(PNG, [10, 10, 50, 50]);
    page.AddImage(PNG, [100, 10, 60, 30]);
    for (const f of figures(buildDocModel(doc, doc.Pages)))
      expect(f.sizes?.length).toBe(f.images.length);
  });

  it('carries the drawn size through a tagged /Figure', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const root = doc.CreateStructTree();
    const fig = root.Append('Figure');
    fig.Alt = 'a chart';
    page.AddImage(PNG, [20, 20, 200, 100], { tag: fig });
    const built = figures(buildDocModel(doc, doc.Pages))[0];
    expect(built.tagged).toBe(true);
    expect(built.sizes?.[0].width).toBeCloseTo(200, 1);
    expect(built.sizes?.[0].height).toBeCloseTo(100, 1);
  });
});
