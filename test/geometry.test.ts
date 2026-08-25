import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildGeometryPdf } from './helpers/build-geometry-pdf.js';
import { buildComposeSource } from './helpers/build-compose-pdf.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);
const open = () => Document.Open(buildGeometryPdf());
const reopen = (d: Document) => Document.Open(d.Save());

describe('page.Scale', () => {
  it('multiplies every present boundary box uniformly', () => {
    const doc = open();
    doc.Pages[0].Scale(2);
    const p = doc.Pages[0];
    expect(p.MediaBox).toEqual([0, 0, 400, 200]);
    expect(p.CropBox).toEqual([20, 20, 380, 180]);
    expect(p.BleedBox).toEqual([10, 10, 390, 190]);
    expect(p.TrimBox).toEqual([40, 40, 360, 160]);
    expect(p.ArtBox).toEqual([50, 50, 350, 150]);
  });

  it('wraps content in a uniform cm and preserves the existing content, round-tripping', () => {
    const doc = open();
    doc.Pages[0].Scale(1.5);
    const content = dec(reopen(doc).Pages[0].Contents);
    expect(content).toContain('1.5 0 0 1.5 0 0 cm');
    expect(content).toContain('(X) Tj');
  });

  it('does not materialize absent Bleed/Trim/Art boxes', () => {
    const doc = Document.Open(buildComposeSource()); // page has no Bleed/Trim/Art
    doc.Pages[0].Scale(2);
    const d = doc.Pages[0].Dict;
    expect(d.has('BleedBox')).toBe(false);
    expect(d.has('TrimBox')).toBe(false);
    expect(d.has('ArtBox')).toBe(false);
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 400, 200]);
  });

  it('throws RangeError for a non-positive or non-finite factor', () => {
    for (const f of [0, -1, NaN, Infinity]) {
      const doc = open();
      expect(() => doc.Pages[0].Scale(f)).toThrow(RangeError);
    }
  });
});

describe('page.Resize', () => {
  it('sets MediaBox and CropBox to the box, leaving Bleed/Trim/Art as-is', () => {
    const doc = open();
    doc.Pages[0].Resize([0, 0, 360, 160]);
    const p = doc.Pages[0];
    expect(p.MediaBox).toEqual([0, 0, 360, 160]);
    expect(p.CropBox).toEqual([0, 0, 360, 160]);
    expect(p.BleedBox).toEqual([5, 5, 195, 95]);   // unchanged
    expect(p.TrimBox).toEqual([20, 20, 180, 80]);  // unchanged
    expect(p.ArtBox).toEqual([25, 25, 175, 75]);   // unchanged
  });

  it('does not transform content by default (scaleContent omitted)', () => {
    const doc = open();
    doc.Pages[0].Resize([0, 0, 360, 160]);
    expect(dec(reopen(doc).Pages[0].Contents)).not.toContain('cm');
  });

  it('scales content to fill the new box with scaleContent:true', () => {
    const doc = open();
    // old CropBox [10 10 190 90] (180x80) -> new [0 0 360 160]: sx=2, sy=2, e=-20, f=-20
    doc.Pages[0].Resize([0, 0, 360, 160], { scaleContent: true });
    const content = dec(reopen(doc).Pages[0].Contents);
    expect(content).toContain('2 0 0 2 -20 -20 cm');
    expect(content).toContain('(X) Tj');
  });

  it('throws TypeError for a malformed box', () => {
    const doc = open();
    expect(() => doc.Pages[0].Resize([0, 0, 100] as unknown as [number, number, number, number])).toThrow(TypeError);
    expect(() => doc.Pages[0].Resize([0, 0, 100, NaN])).toThrow(TypeError);
  });
});
