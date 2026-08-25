import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFlattenTarget, buildFlattenStateTarget } from './helpers/build-flatten-target.js';
import { buildAnnotRenderTarget } from './helpers/build-annot-render-target.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 6) => Math.abs(v - target) <= tol;

describe('Page.ToSvg — annotation appearances', () => {
  it('composites a stamp /AP at its /Rect', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg();
    // /BBox 100x40 -> /Rect [10 20 110 60]; base flip [1 0 0 -1 0 200] -> [1 0 0 -1 10 180].
    // The CTM is baked into device-space `d` (no transform attr) so clip-path
    // resolves in device space (aspose-…-cul); [1 0 0 -1 10 180] maps the BBox
    // corners to (10,180),(110,180),(110,140),(10,140).
    expect(svg).toMatch(
      /<path d="M10 180L110 180L110 140L10 140Z" fill="#0000ff"/);
  });

  it('applies the appearance /Matrix on top of the /Rect placement', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg();
    // /BBox 50x20, /Matrix [2 0 0 2 0 0], /Rect [0 100 100 140] -> [2 0 0 -2 0 100].
    // Baked into device-space `d`: [2 0 0 -2 0 100] maps the BBox corners to
    // (0,100),(100,100),(100,60),(0,60).
    expect(svg).toMatch(
      /<path d="M0 100L100 100L100 60L0 60Z" fill="#ff0000"/);
  });

  it('skips Hidden and appearance-less annotations', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg();
    // exactly the two visible, appearance-bearing annots painted a fill
    const fills = svg.match(/<path [^>]*fill="#(?!none)[0-9a-f]{6}"/g) ?? [];
    expect(fills.length).toBe(2);
  });

  it('selects the /N sub-state named by /AS on a widget', () => {
    const doc = Document.Open(buildFlattenStateTarget());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toContain('fill="#00ff00"');   // /AS /On -> green
    expect(svg).not.toContain('fill="#ffffff"'); // the /Off state must not paint
  });

  it('skips /Popup and NoView annotations', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).not.toContain('fill="#00ff00"'); // the green /AP is only reachable via Popup/NoView
  });

  it('renders a good annotation listed after a malformed one', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toContain('fill="#0000ff"');   // the blue stamp follows the throwing /AP
  });

  it('suppresses the pass with annotations: false', () => {
    const doc = Document.Open(buildFlattenTarget());
    const svg = doc.Pages[0].ToSvg({ annotations: false });
    expect(svg).not.toContain('fill="#0000ff"');
    expect(svg).not.toContain('fill="#ff0000"');
  });

  it('does not mutate the document', () => {
    const doc = Document.Open(buildFlattenTarget());
    const annots = doc.Pages[0].Dict.get('Annots');
    const before = doc.Pages[0].Dict.get('Resources');
    doc.Pages[0].ToSvg();
    expect(doc.Pages[0].Dict.get('Annots')).toBe(annots);
    expect(doc.Pages[0].Dict.get('Resources')).toBe(before);
  });
});

describe('Page.ToImage — annotation appearances', () => {
  it('paints a stamp /AP inside its /Rect and leaves the outside alone', () => {
    const doc = Document.Open(buildFlattenTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    // blue /AP at /Rect [10 20 110 60]; user (50,40) -> device (50,160)
    const [r, g, b] = png.at(50, 160);
    expect(near(r, 0)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 255)).toBe(true);
    // user (150,100) -> device (150,100): outside every /Rect -> white
    expect(png.at(150, 100)).toEqual([255, 255, 255, 255]);
  });

  it('skips /Popup and NoView annotations', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(20, 180)).toEqual([255, 255, 255, 255]); // Popup   /Rect [10 10 30 30]
    expect(png.at(50, 180)).toEqual([255, 255, 255, 255]); // NoView  /Rect [40 10 60 30]
  });

  it('skips annotations with no usable appearance', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(80, 180)).toEqual([255, 255, 255, 255]);  // /AS names a missing state
    expect(png.at(110, 180)).toEqual([255, 255, 255, 255]); // /AP /N has no /BBox
  });

  it('renders a good annotation listed after one whose /AP throws', () => {
    const doc = Document.Open(buildAnnotRenderTarget());
    const png = decodePng(doc.Pages[0].ToImage());
    expect(png.at(170, 180)).toEqual([255, 255, 255, 255]); // the throwing /AP paints nothing
    const [r, g, b] = png.at(140, 180);                     // ...but the blue stamp after it does
    expect(near(r, 0)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 255)).toBe(true);
  });

  it('suppresses the pass with annotations: false', () => {
    const doc = Document.Open(buildFlattenTarget());
    const png = decodePng(doc.Pages[0].ToImage({ annotations: false }));
    expect(png.at(50, 160)).toEqual([255, 255, 255, 255]);
  });

  it('honors scale when placing an appearance', () => {
    const doc = Document.Open(buildFlattenTarget());
    const png = decodePng(doc.Pages[0].ToImage({ scale: 2 }));
    expect(png.width).toBe(600);
    // user (50,40) -> device (100,320) at scale 2
    const [r, g, b] = png.at(100, 320);
    expect(near(r, 0)).toBe(true);
    expect(near(g, 0)).toBe(true);
    expect(near(b, 255)).toBe(true);
  });
});
