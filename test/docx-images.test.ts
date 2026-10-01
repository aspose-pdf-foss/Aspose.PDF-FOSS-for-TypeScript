import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { visitContent, type ImageEvent } from '../src/text.js';
import { buildDocx } from './helpers/build-docx.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { p, r } from './helpers/wml.js';

const drawing = (rid: string, cxPt: number, cyPt: number) => '<w:r><w:drawing><wp:inline>'
  + `<wp:extent cx="${cxPt * 12700}" cy="${cyPt * 12700}"/><wp:docPr id="1" name="p" descr="A cat"/>`
  + `<a:graphic><a:graphicData uri="x"><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>`
  + '</wp:inline></w:drawing></w:r>';
const png = buildPngRgbWith(4, 4, Array.from({ length: 16 }, () => [0, 128, 255]).flat(), 0);
const media = { media: [{ name: 'i.png', bytes: png, contentType: 'image/png' }],
  rels: [{ id: 'rI', type: 'image', target: 'media/i.png' }] };
const drawn = (doc: Document): { w: number; h: number; x: number; y: number }[] => {
  const ev: ImageEvent[] = [];
  visitContent(doc, doc.Pages[0], { image: (e) => ev.push(e) });
  return ev.map((e) => ({ w: e.quad[2] - e.quad[0], h: e.quad[3] - e.quad[1], x: e.quad[0], y: e.quad[1] }));
};

describe('AddDocx: images', () => {
  it('draws a lone image as a figure at its extent, with its description', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(drawing('rI', 100, 50)), media), { tagged: true });
    expect(skipped).toEqual([]);
    const d = drawn(doc);
    expect(d).toHaveLength(1);
    expect(d[0].w).toBeCloseTo(100, 1);
    expect(d[0].h).toBeCloseTo(50, 1);
    const types = (el: { Type: string; Alt?: string; Children: unknown[] }[]): string[] =>
      el.flatMap((e) => [`${e.Type}:${e.Alt ?? ''}`, ...types(e.Children as never)]);
    expect(types(doc.GetStructTree()!.Children as never)).toContain('Figure:A cat');
  });

  it('aligns a lone image as its paragraph says', () => {
    const at = (pPr: string) => {
      const doc = Document.New();
      doc.AddDocx(buildDocx(p(drawing('rI', 100, 50), pPr), media));
      return drawn(doc)[0].x;
    };
    expect(at('<w:jc w:val="right"/>')).toBeGreaterThan(at('') + 200);
  });

  it('draws an image among words on the text line, between them', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(r('before ') + drawing('rI', 12, 12) + r(' after')), media));
    expect(skipped).toEqual([]);
    const d = drawn(doc);
    expect(d).toHaveLength(1);
    expect(d[0].w).toBeCloseTo(12, 1);
    const f = doc.Pages[0].GetTextFragments();
    const before = f.find((x) => x.text.includes('before'))!;
    const after = f.find((x) => x.text.includes('after'))!;
    expect(d[0].x).toBeGreaterThan(before.quad[0]);
    expect(d[0].x).toBeLessThan(after.quad[0]);
    expect(d[0].y).toBeCloseTo(before.quad[1], 0);
  });

  it('drops an image in a format we cannot draw, naming its type', () => {
    const doc = Document.New();
    const emf = { media: [{ name: 'i.emf', bytes: new Uint8Array([1, 0, 0, 0]), contentType: 'image/x-emf' }],
      rels: [{ id: 'rI', type: 'image', target: 'media/i.emf' }] };
    const { skipped } = doc.AddDocx(buildDocx(p(r('t ') + drawing('rI', 12, 12)), emf));
    expect(skipped).toContainEqual({ name: 'image:image/x-emf', count: 1, kind: 'dropped' });
    expect(doc.Pages[0].GetText()).toContain('t');
    expect(drawn(doc)).toHaveLength(0);
  });

  it('keeps the line of a paragraph whose only image cannot be drawn', () => {
    const emf = { media: [{ name: 'i.emf', bytes: new Uint8Array([1, 0, 0, 0]), contentType: 'image/x-emf' }],
      rels: [{ id: 'rI', type: 'image', target: 'media/i.emf' }] };
    const y = (body: string) => {
      const doc = Document.New();
      doc.AddDocx(buildDocx(body, emf));
      return doc.Pages[0].GetTextFragments().find((x) => x.text.includes('B'))!.quad[1];
    };
    expect(y(p(r('A')) + p(drawing('rI', 12, 12)) + p(r('B')))).toBeCloseTo(y(p(r('A')) + p('') + p(r('B'))), 1);
  });

  it('draws a paragraph of two images and nothing else, both of them', () => {
    for (const between of ['', r(' ')]) {
      const doc = Document.New();
      const { skipped } = doc.AddDocx(buildDocx(p(drawing('rI', 30, 20) + between + drawing('rI', 40, 20)), media));
      expect(skipped).toEqual([]);
      const d = drawn(doc).sort((a, b) => a.x - b.x);
      expect(d).toHaveLength(2);
      expect(d[0].w).toBeCloseTo(30, 1);
      expect(d[1].w).toBeCloseTo(40, 1);
      expect(d[1].x).toBeGreaterThan(d[0].x + 29);
    }
  });

  it('draws an inline image stating no extent at its intrinsic size', () => {
    const noExtent = drawing('rI', 12, 12).replace(/<wp:extent[^>]*\/>/, '');
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(r('a ') + noExtent + r(' b')), media));
    expect(skipped).toEqual([]);
    const d = drawn(doc);
    expect(d).toHaveLength(1);
    expect(d[0].w).toBeCloseTo(3, 1); // 4 px at 0.75 pt a pixel
  });

  it('reports an image scaled to fit a column it is taller than, as degraded', () => {
    const doc = Document.New();
    const { skipped } = doc.AddDocx(buildDocx(p(drawing('rI', 400, 2000)), media));
    expect(skipped).toContainEqual({ name: 'image:scaled-to-fit', count: 1, kind: 'degraded' });
    expect(drawn(doc)).toHaveLength(1);
  });
});
