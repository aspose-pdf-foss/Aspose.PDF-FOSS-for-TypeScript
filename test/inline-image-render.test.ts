import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { assemble, contentStream } from './helpers/build-grayscale-pdf.js';

/**
 * Inline images must RENDER (6dud).
 *
 * `pagerender.ts` wrapped the raw `BI` dict into a synthetic stream and handed
 * that to the sink, so the abbreviated keys 32000-1 Table 93 mandates -- /W,
 * /H, /CS, /BPC -- reached decoders that read full names only. Every such image
 * decoded to nothing and drew nothing, in `ToImage` and `ToSvg` alike, with no
 * error anywhere. Table 93 permits both spellings, and the FULL one already
 * worked, which is exactly why no fixture caught it: the two spellings of one
 * construct behaved differently.
 */

/** Samples all < 128, so TextEncoder passes them through unchanged, and
 *  containing no `EI` sequence that would end the image early -- the same
 *  constraint test/helpers/build-grayscale-pdf.ts documents. */
const PIXEL = [120, 20, 60];
const BYTES = PIXEL.map((b) => String.fromCharCode(b)).join('');

/**
 * A 40x20 page: one 1x1 inline image scaled over the left half in ABBREVIATED
 * spelling, the same image over the right half in FULL spelling.
 */
function buildInlinePair(): Uint8Array {
  const content =
    `q 20 0 0 20 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID ${BYTES} EI Q\n`
    + 'q 20 0 0 20 20 0 cm BI /Width 1 /Height 1 /ColorSpace /DeviceRGB '
    + `/BitsPerComponent 8 ID ${BYTES} EI Q\n`;
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 40 20] '
      + '/Resources << >> /Contents 4 0 R >>',
    contentStream(content),
  ]);
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 2;

describe('Page.ToImage — inline images', () => {
  it('paints an inline image written with the abbreviated keys', () => {
    const png = decodePng(Document.Open(buildInlinePair()).Pages[0].ToImage());
    const [r, g, b, a] = png.at(10, 10);
    expect(a).toBe(255);
    expect(near(r, PIXEL[0])).toBe(true);
    expect(near(g, PIXEL[1])).toBe(true);
    expect(near(b, PIXEL[2])).toBe(true);
  });

  it('renders both spellings of one image identically', () => {
    // The bug's signature. Asserting only that the abbreviated form paints
    // would leave a build that renders it in some OTHER colour green, and the
    // full-name half is the control that says what the answer should be.
    const png = decodePng(Document.Open(buildInlinePair()).Pages[0].ToImage());
    expect(png.at(10, 10)).toEqual(png.at(30, 10));
  });
});

describe('Page.ToSvg — inline images', () => {
  it('emits the inline image rather than dropping it', () => {
    // Same single sink.image call site, so ToSvg was broken by the same line --
    // and it reaches images through imagehref.ts rather than the rasterizer, so
    // a green ToImage does not cover it.
    const svg = Document.Open(buildInlinePair()).Pages[0].ToSvg();
    expect((svg.match(/<image /g) ?? []).length).toBe(2);
  });
});
