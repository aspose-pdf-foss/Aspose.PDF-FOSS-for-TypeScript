import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

describe('decoration round-trips', () => {
  it('survives Save and Open with all three decorations applied', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 3 }));
    doc.AddWatermark({ text: 'DRAFT' });
    doc.AddHeaderFooter({ footer: { center: 'Page {page} of {total}' } });
    doc.AddBatesNumbering({ prefix: 'ACME-', digits: 4 });

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages).toHaveLength(3);
    // Assert on positioned runs, not GetText(): the diagonal watermark is
    // rotated, and GetText's baseline-based line assembly interleaves a rotated
    // run with the horizontal ones sharing its y-band.
    const joined = reopened.Pages[1].GetTextFragments().map((f) => f.text).join('');
    expect(joined).toContain('P2');            // original content survived
    expect(joined).toContain('DRAFT');
    expect(joined).toContain('Page 2 of 3');
    expect(joined).toContain('ACME-0002');
  });

  it('keeps the diagonal watermark on the page diagonal after a round-trip', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1 }));
    doc.AddWatermark({ text: 'DRAFT' });
    const frags = Document.Open(doc.Save()).Pages[0].GetTextFragments();
    const draft = frags.filter((f) => f.angle !== undefined);
    expect(draft.length).toBeGreaterThan(0);
    // atan2(100, 200) = 0.4636 rad on the 200x100 fixture.
    for (const f of draft) expect(f.angle!).toBeCloseTo(Math.atan2(100, 200), 4);
  });

  it('round-trips through a compressed save', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ text: 'CONFIDENTIAL', position: 'center' });
    const reopened = Document.Open(doc.Save({ compressed: true }));
    expect(reopened.Pages[0].GetText()).toContain('CONFIDENTIAL');
  });

  it('round-trips an image watermark', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    doc.AddWatermark({ image: buildPngRgb() });
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Images).toHaveLength(1);
    expect(reopened.Pages[0].GetText()).toContain('P1');
  });

  it('renders each decorated page to PNG without throwing', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 1, rotate: 90 }));
    doc.AddWatermark({ text: 'DRAFT' });
    doc.AddBatesNumbering();
    const png = Document.Open(doc.Save()).Pages[0].ToImage({ scale: 1 });
    expect(png.length).toBeGreaterThan(0);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('leaves an undecorated page byte-identical after a decoration of others', () => {
    const doc = Document.Open(buildDecorateTarget({ count: 2 }));
    const before = new TextDecoder('latin1').decode(doc.Pages[1].Contents);
    doc.AddWatermark({ text: 'DRAFT', pages: '1' });
    expect(new TextDecoder('latin1').decode(doc.Pages[1].Contents)).toBe(before);
  });
});
