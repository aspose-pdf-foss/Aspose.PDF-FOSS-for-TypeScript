import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isStream, isRef } from '../src/types.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildPngRgb, buildPngRgba } from './helpers/build-embed-images.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

/** Image XObject refs registered on a page's /Resources /XObject. */
function imageRefs(doc: Document, page: import('../src/page.js').Page): number[] {
  const xo = doc.resolve(page.Resources!.get('XObject'));
  const out: number[] = [];
  if (xo instanceof Map) for (const v of xo.values()) if (isRef(v)) out.push(v.num);
  return out;
}

describe('AddWatermark with an image', () => {
  it('embeds one shared XObject across every stamped page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 10 }));
    doc.AddWatermark({ image: buildPngRgb() });
    const first = imageRefs(doc, doc.Pages[0]);
    expect(first).toHaveLength(1);
    // Every page points at the same object number: built once, placed ten times.
    for (let i = 1; i < 10; i++) expect(imageRefs(doc, doc.Pages[i])).toEqual(first);
  });

  it('draws the image on each selected page', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ image: buildPngRgb(), pages: '1,3' });
    expect(decoded(doc.Pages[0])).toMatch(/\/Im\d+ Do/);
    expect(decoded(doc.Pages[1])).not.toMatch(/\/Im\d+ Do/);
    expect(decoded(doc.Pages[2])).toMatch(/\/Im\d+ Do/);
  });

  it('wires an /SMask for an alpha PNG, shared too', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ image: buildPngRgba() });
    const [num] = imageRefs(doc, doc.Pages[0]);
    const img = doc.getObject(num);
    expect(isStream(img)).toBe(true);
    expect(isRef(isStream(img) ? img.dict.get('SMask') : undefined)).toBe(true);
  });

  it('preserves the image aspect ratio', () => {
    // buildPngRgb() is 2x1, so height is half the drawn width: 40 -> 20.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'bottom-left', width: 40 });
    expect(decoded(doc.Pages[0])).toContain('40 0 0 20 36 36 cm');
  });

  it('defaults a corner image to a quarter of the visual width', () => {
    // 200x100 page -> width 50, 2:1 image -> height 25, bottom-left at margin.
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'bottom-left' });
    expect(decoded(doc.Pages[0])).toContain('50 0 0 25 36 36 cm');
  });

  it('anchors a top-right image by its own top-right corner', () => {
    // 50x25 image, anchor (164, 64) with fx=1, fy=1 -> origin (114, 39).
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'top-right' });
    expect(decoded(doc.Pages[0])).toContain('50 0 0 25 114 39 cm');
  });

  it('maps through the frame matrix on a /Rotate 180 page', () => {
    // Visual bottom-left (36, 36) with M = [-1 0 0 -1 200 100]: the image is
    // laid out in the visual frame and mapped, so it is flipped in user space
    // and lands at the unrotated top-right.
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 180 }));
    doc.AddWatermark({ image: buildPngRgb(), position: 'bottom-left', width: 40 });
    expect(decoded(doc.Pages[0])).toContain('-40 0 0 -20 164 64 cm');
  });

  it('defaults to an underlay at 0.3 opacity', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb() });
    const s = decoded(doc.Pages[0]);
    expect(s).toMatch(/\/GS\d+ gs/);
    expect(s.indexOf('Do')).toBeLessThan(s.indexOf('(P1)'));
  });

  it('preserves existing content', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ image: buildPngRgb() });
    expect(doc.Pages[0].GetText()).toContain('P1');
  });

  it('throws UnsupportedFeatureError for a non-image payload', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddWatermark({ image: new Uint8Array([1, 2, 3, 4]) }))
      .toThrow(/unrecognized image format/);
  });

  it('ignores fontSize for an image stamp', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    expect(() => doc.AddWatermark({ image: buildPngRgb(), fontSize: 12 })).not.toThrow();
  });
});
