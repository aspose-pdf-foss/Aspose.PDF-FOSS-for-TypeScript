import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import {
  N, buildColorKeyRenderPdf, buildStencilMaskRenderPdf,
  buildInvertedStencilRenderPdf, buildIndexedColorKeyRenderPdf,
  buildMaskAndSMaskRenderPdf,
} from './helpers/build-mask-pdf.js';

/**
 * `/Mask` rendering (10u9.12). raster.ts honoured /SMask and /ImageMask but
 * ignored the /Mask entry in BOTH of its legal forms, so every masked image
 * rendered fully opaque with its masked-out pixels painted.
 *
 * The image fills the page at 1:1, so image pixel (x, y) is device pixel
 * (x, y): row 0 of an image is its top, and device y grows downward, so no
 * flip enters the probe coordinates.
 */

/** Probe the middle of each quadrant. */
const Q = N / 4;                       // 10 — a quarter in, i.e. mid-quadrant
const TL: [number, number] = [Q, Q];
const TR: [number, number] = [N - Q, Q];
const BL: [number, number] = [Q, N - Q];
const BR: [number, number] = [N - Q, N - Q];

const render = (bytes: Uint8Array) => {
  const png = decodePng(Document.Open(bytes).Pages[0].ToImage());
  return (p: [number, number]) => png.at(p[0], p[1]);
};

/** The page background shows through wherever the image was masked out. */
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

describe('Page.ToImage — colour-key /Mask', () => {
  it('leaves the keyed colour unpainted and paints everything else', () => {
    const at = render(buildColorKeyRenderPdf());
    expect(at(TL)).toEqual(WHITE);           // (255,0,0) is keyed
    expect(at(TR)).toEqual([0, 130, 0, 255]);
    expect(at(BL)).toEqual([0, 0, 255, 255]);
    expect(at(BR)).toEqual(WHITE);           // the image's own white, opaque
  });

  it('keys an Indexed image by its INDEX, one byte per pixel', () => {
    // Note this does NOT pin a stride bug, and was written believing it did:
    // resolveColorSpace reports one component for an Indexed space, so the
    // stride is already right and swapping it for `cs.components` changes
    // nothing (measured). What it does pin is that an Indexed colour key is
    // keyed on the INDEX and works at all -- the path where samples are raw
    // indices rather than 0..1 fractions.
    const at = render(buildIndexedColorKeyRenderPdf());
    expect(at(TL)).toEqual(WHITE);           // index 0, keyed
    expect(at(TR)).toEqual([0, 130, 0, 255]);
    expect(at(BL)).toEqual([0, 0, 255, 255]);
  });
});

describe('Page.ToImage — stencil /Mask', () => {
  it('masks where the stencil bit is set', () => {
    // The form 10u9.7 emits, so this is what closes that issue's verification
    // loop: its output was exact and no render could show it.
    const at = render(buildStencilMaskRenderPdf());
    expect(at(TL)).toEqual(WHITE);
    expect(at(TR)).toEqual([0, 130, 0, 255]);
    expect(at(BL)).toEqual([0, 0, 255, 255]);
  });

  it('honours the stencil’s own /Decode [1 0], which flips the paint sense', () => {
    // Same stencil bits, inverted meaning: now the top-left is the only
    // quadrant that paints. Ignoring /Decode renders the exact negative of the
    // intended transparency, which looks deliberate rather than broken.
    const at = render(buildInvertedStencilRenderPdf());
    expect(at(TL)).toEqual([255, 0, 0, 255]);
    expect(at(TR)).toEqual(WHITE);
    expect(at(BL)).toEqual(WHITE);
  });
});

describe('Page.ToImage — /SMask outranks /Mask', () => {
  it('paints the keyed colour when a fully opaque /SMask is also present', () => {
    // 32000-1 makes the two mutually exclusive, so a file carrying both is
    // already malformed; the soft mask is the richer of the two and wins.
    const at = render(buildMaskAndSMaskRenderPdf());
    expect(at(TL)).toEqual([255, 0, 0, 255]);
  });
});

describe('ConvertToGrayscale round trip', () => {
  it('masks the same pixels after the key becomes a stencil', () => {
    // The whole point of 10u9.12. 10u9.7 converts a colour-key /Mask into a
    // stencil, exactly -- and could not show it, because nothing rendered
    // either form. The luma collision is what makes this sharp: (255,0,0) and
    // (0,130,0) both grey to 76, so after conversion the SAMPLES cannot tell
    // the keyed quadrant from its neighbour and only the stencil can.
    const doc = Document.Open(buildColorKeyRenderPdf());
    expect(doc.ConvertToGrayscale().skipped).toEqual([]);

    const png = decodePng(doc.Pages[0].ToImage());
    const at = (p: [number, number]) => png.at(p[0], p[1]);

    expect(at(TL)).toEqual(WHITE);              // still masked
    expect(at(TR)).toEqual([76, 76, 76, 255]);  // its luma twin, still painted
    expect(at(BL)).toEqual([29, 29, 29, 255]);
  });
});
