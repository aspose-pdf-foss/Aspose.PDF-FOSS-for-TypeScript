import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { FigureContent, figurePage } from '../src/figurecontent.js';
import { renderPageRegionToPng } from '../src/raster.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

const ihdr = (png: Uint8Array): [number, number] => {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
};

function taggedImageDoc(): { doc: Document; fig: ReturnType<Document['CreateStructTree']>['Children'][number] } {
  const doc = Document.New(PageFormat.custom(400, 400));
  const root = doc.CreateStructTree();
  const fig = root.Append('Figure');
  doc.Pages[0]!.AddImage(buildPngRgb(), [20, 20, 200, 100], { tag: fig });
  return { doc, fig };
}

describe('FigureContent (3ywf.4)', () => {
  it('finds the image a tagged figure draws, and its extent', () => {
    const { doc, fig } = taggedImageDoc();
    const fc = new FigureContent(doc);
    const imgs = fc.imagesOf(fig);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.width).toBeCloseTo(200, 3);
    const box = fc.bboxOf(fig, doc.Pages[0]!)!;
    expect(box[0]).toBeCloseTo(20, 3); expect(box[1]).toBeCloseTo(20, 3);
    expect(box[2]).toBeCloseTo(220, 3); expect(box[3]).toBeCloseTo(120, 3);
    expect(figurePage(fig)).toBe(doc.Pages[0]);
  });

  it('gives a vector figure no image but an extent inside its drawing', () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    const fig = doc.CreateStructTree().Append('Figure');
    doc.Pages[0]!.AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 100, 200, 60], { tag: fig });
    const fc = new FigureContent(doc);
    expect(fc.imagesOf(fig)).toEqual([]);
    const box = fc.bboxOf(fig, doc.Pages[0]!)!;
    expect(box[0]).toBeGreaterThanOrEqual(50 - 1e-6); expect(box[2]).toBeLessThanOrEqual(250 + 1e-6);
    expect(box[1]).toBeGreaterThanOrEqual(100 - 1e-6); expect(box[3]).toBeLessThanOrEqual(160 + 1e-6);
  });

  it('has no extent for a figure that marks nothing', () => {
    const doc = Document.New(PageFormat.custom(400, 400));
    const fig = doc.CreateStructTree().Append('Figure');
    expect(new FigureContent(doc).bboxOf(fig, doc.Pages[0]!)).toBeUndefined();
  });
});

describe('renderPageRegionToPng (3ywf.4)', () => {
  it('crops to the region at the given scale', () => {
    const { doc } = taggedImageDoc();
    expect(ihdr(renderPageRegionToPng(doc, doc.Pages[0]!, [20, 20, 220, 120], 2)!)).toEqual([400, 200]);
  });
  it('clamps to the page and refuses an empty region', () => {
    const { doc } = taggedImageDoc();
    expect(ihdr(renderPageRegionToPng(doc, doc.Pages[0]!, [-50, -50, 100, 100], 1)!)).toEqual([100, 100]);
    expect(renderPageRegionToPng(doc, doc.Pages[0]!, [500, 500, 600, 600], 1)).toBeUndefined();
  });
  it('maps the region through /Rotate (Review Focus 3)', () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    doc.Pages[0]!.Rotate = 90;
    // 50 wide and 100 tall on the page is 100 wide and 50 tall once turned.
    expect(ihdr(renderPageRegionToPng(doc, doc.Pages[0]!, [0, 0, 50, 100], 1)!)).toEqual([100, 50]);
  });
});
