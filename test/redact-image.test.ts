import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { removeImagesUnder, redactPage } from '../src/redact.js';
import { visitContent, ImageEvent } from '../src/text.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { deflateSync } from 'node:zlib';
import {
  buildPlacedImagePdf, buildSingleImagePdfWithCm, buildPlacedImageWithSMaskPdf, buildPlacedRawImagePdf,
} from './helpers/build-image-pdf.js';
import { encodeBaselineJpeg, encodeProgressiveJpeg } from './helpers/build-jpeg.js';
import { encodeSequentialArithJpeg } from './helpers/build-jpeg-arith.js';
import { encodeLosslessJpeg } from './helpers/build-jpeg-lossless.js';
import { encodeHierarchicalJpeg } from './helpers/build-jpeg-hier.js';
import { ImageInfo } from '../src/image.js';
import { isStream, PdfStream } from '../src/types.js';
import { parseContentStream } from '../src/content.js';
import { inlineImageToStream } from '../src/imageredact.js';

function images(doc: Document, pageIndex = 0): ImageEvent[] {
  const out: ImageEvent[] = [];
  visitContent(doc, doc.Pages[pageIndex], { image: (e) => out.push(e) });
  return out;
}
const content = (doc: Document, i = 0) => new TextDecoder('latin1').decode(doc.Pages[i].Contents);

describe('removeImagesUnder — XObject images', () => {
  it('removes a fully-covered image XObject draw and its placement group', () => {
    const doc = Document.Open(buildImageOnlyPdf()); // /Im0 at [50,50,150,150] via q cm Do Q
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeImagesUnder(doc, page, [[40, 40, 160, 160]], ec); // fully contains the image
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(images(reopened)).toHaveLength(0);     // image no longer drawn
    expect(content(reopened)).not.toContain('Do'); // q cm Do Q group removed wholesale
  });

  it('throws UnsupportedFeatureError for a partially-covered JPEG that fails to decode', () => {
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: 4, height: 4, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode',
      raw: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), cm: '100 0 0 100 0 0',
    }));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    expect(() => removeImagesUnder(doc, page, [[0, 0, 50, 100]], ec)) // clips part of the image
      .toThrow(UnsupportedFeatureError);
  });

  it('leaves surrounding state ops when the q…Q group is not solely a placement', () => {
    // The image shares its q…Q block with a filled rectangle that must survive.
    const doc = Document.Open(buildMultiStreamPage([
      'q 100 0 0 100 50 50 cm BI /W 1 /H 1 /CS /G /BPC 8 ID X EI 0 0 0 rg 10 10 20 20 re f Q',
    ]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeImagesUnder(doc, page, [[40, 40, 160, 160]], ec);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    const c = content(reopened);
    expect(images(reopened)).toHaveLength(0);
    expect(c).not.toContain('BI'); // inline image gone (its bytes are in the stream)
    expect(c).toMatch(/\bre\b/);   // sibling rectangle preserved
    expect(c).toMatch(/\bf\b/);
  });
});

describe('removeImagesUnder — inline images', () => {
  it('removes a fully-covered inline image, keeping other content', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 10 Tf 50 250 Td (keep) Tj ET q 100 0 0 100 50 50 cm BI /W 1 /H 1 /CS /G /BPC 8 ID X EI Q',
    ]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeImagesUnder(doc, page, [[40, 40, 160, 160]], ec);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(images(reopened)).toHaveLength(0);
    expect(content(reopened)).not.toContain('BI');     // inline data gone from the stream
    expect(reopened.Pages[0].GetText()).toContain('keep'); // text untouched
  });

  it('partially redacts an inline image, keeping the rest and staying inline', () => {
    const px = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) { px[i * 3] = 10 + i; px[i * 3 + 1] = 100; px[i * 3 + 2] = 200; }
    const stream = `q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${toHex(px)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    removeImagesUnder(doc, page, [[0, 0, 50, 100]], ec); // left half
    ec.commit();

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // still inline
    const { w, s } = inlineSamples(reopened);
    const at = (x: number, y: number) => [s[(y * w + x) * 3], s[(y * w + x) * 3 + 1], s[(y * w + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]); // covered → black
    expect(at(3, 3)[2]).toBe(200);       // uncovered → preserved
  });
});

// A 4×4 DeviceRGB image; each pixel a distinct non-black colour so blanking is
// detectable. Row 0 is the TOP row of the image.
function grid4(): Uint8Array {
  const s = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < 16; i++) { s[i * 3] = 10 + i; s[i * 3 + 1] = 100; s[i * 3 + 2] = 200; }
  return s;
}
const PLACE = '100 0 0 100 0 0'; // image placed at device [0,0,100,100]

describe('partial image redaction (clip + re-encode)', () => {
  it('blacks only the covered pixel columns, leaving the rest', () => {
    const doc = Document.Open(buildPlacedImagePdf({ width: 4, height: 4, samples: grid4(), placements: [PLACE] }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 2 columns
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const w = imgs[0].Width, samples = imgs[0].Decode();
    const px = (x: number, y: number) => [samples[(y * w + x) * 3], samples[(y * w + x) * 3 + 1], samples[(y * w + x) * 3 + 2]];
    expect(px(0, 0)).toEqual([0, 0, 0]); // covered (left) → black
    expect(px(1, 2)).toEqual([0, 0, 0]);
    expect(px(2, 0)[1]).toBe(100);       // uncovered (right) → original green channel
    expect(px(3, 3)[2]).toBe(200);
  });

  it('still drops a fully-covered image', () => {
    const doc = Document.Open(buildPlacedImagePdf({ width: 4, height: 4, samples: grid4(), placements: [PLACE] }));
    redactPage(doc, doc.Pages[0], [[-5, -5, 105, 105]]); // fully contains the image
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].Images).toHaveLength(0);
    expect(content(reopened)).not.toContain('Do');
  });

  it('leaves a second placement of a shared image untouched (copy-on-write)', () => {
    const doc = Document.Open(buildPlacedImagePdf({
      width: 4, height: 4, samples: grid4(),
      placements: ['100 0 0 100 0 0', '100 0 0 100 100 0'], mediaBox: '0 0 200 100',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // covers left half of the FIRST placement only
    const reopened = Document.Open(doc.Save());
    const decoded = reopened.Pages[0].Images.map((im) => im.Decode());
    const original = grid4();
    const untouched = decoded.some((d) => d.length === original.length && d.every((v, i) => v === original[i]));
    expect(untouched).toBe(true); // the second placement's image survives byte-for-byte
  });

  it('partially redacts a rotated placement, blanking only the covered pixels', () => {
    // 90° placement over device [0,100]²; redact device [0,0,50,50] → the mapped
    // quad covers the top-left 2×2 image pixels (px∈{0,1}, py∈{0,1}).
    const doc = Document.Open(buildPlacedImagePdf({
      width: 4, height: 4, samples: grid4(), placements: ['0 100 -100 0 100 0'], mediaBox: '0 0 100 100',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 50]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const w = imgs[0].Width, s = imgs[0].Decode();
    const px = (x: number, y: number) => [s[(y * w + x) * 3], s[(y * w + x) * 3 + 1], s[(y * w + x) * 3 + 2]];
    expect(px(0, 0)).toEqual([0, 0, 0]); // covered corner → black
    expect(px(1, 1)).toEqual([0, 0, 0]);
    expect(px(2, 0)[1]).toBe(100);       // px=2 uncovered → original green
    expect(px(0, 2)[2]).toBe(200);       // py=2 uncovered → original blue
    expect(px(3, 3)[2]).toBe(200);
  });

  it('throws for a partially-covered JPEG that fails to decode (truncated)', () => {
    const dct = Document.Open(buildSingleImagePdfWithCm({
      width: 4, height: 4, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode',
      raw: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), cm: '100 0 0 100 0 0',
    }));
    expect(() => redactPage(dct, dct.Pages[0], [[0, 0, 50, 100]])).toThrow(UnsupportedFeatureError);
  });

  it('blacks only the covered columns of a baseline JPEG (decode + re-encode)', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; } // flat colour
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 4 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode(); // re-encoded as Flate DeviceRGB
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);           // covered (left) → black
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered (right) → preserved
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('blacks only the covered columns of a 12-bit grayscale JPEG (decode + re-encode)', () => {
    const w = 8, h = 8;
    const px = new Uint16Array(w * h).fill(3600); // flat 12-bit gray → 3600>>4 = 225 after downscale
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 1, pixels: px, precision: 12 });
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: w, height: h, colorSpace: 'DeviceGray', bits: 12, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 4 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode(); // re-encoded as Flate DeviceRGB
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);           // covered (left) → black
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 225)).toBeLessThanOrEqual(5); // uncovered (right) → preserved gray
    expect(Math.abs(px2(7, 7)[2] - 225)).toBeLessThanOrEqual(5);
  });

  it('honors a DCT-encoded /SMask: covered pixels opaque black, uncovered alpha preserved', () => {
    // Base 4×4 DeviceRGB; DCT (baseline JPEG) grayscale soft mask, flat alpha 128.
    const smAlpha = new Uint8Array(4 * 4).fill(128);
    const smJpg = encodeBaselineJpeg({ width: 4, height: 4, comps: 1, pixels: smAlpha });
    const doc = Document.Open(buildPlacedImageWithSMaskPdf({
      width: 4, height: 4, samples: grid4(),
      smask: { width: 4, height: 4, filter: 'DCTDecode', raw: smJpg },
      placements: [PLACE],
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 2 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const w = imgs[0].Width, samples = imgs[0].Decode();
    const px = (x: number, y: number) => [samples[(y * w + x) * 3], samples[(y * w + x) * 3 + 1], samples[(y * w + x) * 3 + 2]];
    expect(px(0, 0)).toEqual([0, 0, 0]); // covered (left) → black
    expect(px(2, 0)[1]).toBe(100);       // uncovered (right) → original green channel

    // Re-encoded image must still carry a soft mask (proof the DCT alpha was decoded,
    // not defaulted to fully-opaque, which would have dropped the mask entirely).
    const sm = reopened.resolve(imgs[0].Dict.get('SMask'));
    expect(isStream(sm)).toBe(true);
    const alpha = new ImageInfo(reopened, '', sm as PdfStream).Decode();
    const aw = imgs[0].Width;
    expect(alpha[0 * aw + 0]).toBe(255);                    // covered → forced opaque
    expect(Math.abs(alpha[0 * aw + 2] - 128)).toBeLessThanOrEqual(6); // uncovered → decoded alpha kept
  });

  it('blacks only the covered columns of a progressive JPEG (decode + re-encode)', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; } // flat colour
    const jpg = encodeProgressiveJpeg({ width: w, height: h, comps: 3, pixels: px, successive: true });
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 4 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);           // covered (left) → black
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered (right) → preserved
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('blacks only the covered columns of an arithmetic JPEG (decode + re-encode)', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; } // flat colour
    const jpg = encodeSequentialArithJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → left 4 columns

    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images;
    expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);           // covered (left) → black
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered (right) → preserved
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('blacks only the covered columns of a lossless Huffman JPEG (decode + re-encode)', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px });
    const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images; expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5);
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('blacks only the covered columns of a lossless arithmetic JPEG (decode + re-encode)', () => {
    const w = 8, h = 8; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeLosslessJpeg({ width: w, height: h, comps: 3, pixels: px, mode: 'arithmetic' });
    const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images; expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(6, 0)[0] - 200)).toBeLessThanOrEqual(5);
    expect(Math.abs(px2(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('blacks only the covered columns of a hierarchical (SOF5) JPEG (decode + re-encode)', () => {
    const w = 16, h = 16; const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeHierarchicalJpeg({ width: w, height: h, comps: 3, pixels: px, residual: 'seq-dct', expand: 'hv' });
    const doc = Document.Open(buildSingleImagePdfWithCm({ width: w, height: h, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode', raw: jpg, cm: '100 0 0 100 0 0' }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const imgs = reopened.Pages[0].Images; expect(imgs).toHaveLength(1);
    const iw = imgs[0].Width, samples = imgs[0].Decode();
    const px2 = (x: number, y: number) => [samples[(y * iw + x) * 3], samples[(y * iw + x) * 3 + 1], samples[(y * iw + x) * 3 + 2]];
    expect(px2(0, 0)).toEqual([0, 0, 0]);
    expect(px2(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(px2(12, 0)[0] - 200)).toBeLessThanOrEqual(6);
    expect(Math.abs(px2(15, 15)[1] - 100)).toBeLessThanOrEqual(6);
  });
});

describe('partial image redaction — colorspace/bit-depth preservation', () => {
  const CM = '100 0 0 100 0 0'; // image at device [0,0,100,100]

  it('keeps DeviceCMYK 8-bpc: uncovered samples identical, covered zeroed', () => {
    // 4×1 CMYK, distinct per-pixel samples.
    const s = new Uint8Array(4 * 4);
    for (let i = 0; i < 16; i++) s[i] = 10 + i;
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 4, height: 1, colorSpace: '/DeviceCMYK', bits: 8, samples: s, cm: CM, mediaBox: '0 0 100 100',
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // leftmost column (pixel 0)

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceCMYK');
    expect(img.Bits).toBe(8);
    const d = img.Decode();
    expect([...d.subarray(0, 4)]).toEqual([0, 0, 0, 0]);        // covered pixel 0 → zero
    expect([...d.subarray(4, 16)]).toEqual([...s.subarray(4, 16)]); // pixels 1..3 byte-identical
  });

  it('keeps an Indexed 8-bpc palette: uncovered indices identical, covered → index 0', () => {
    // 4×1 indexed, palette of 3 RGB entries; indices 1,2,1,2 across the row.
    const idx = Uint8Array.from([1, 2, 1, 2]);
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 4, height: 1,
      colorSpace: '[/Indexed /DeviceRGB 2 <000000 ff0000 00ff00>]',
      bits: 8, samples: idx, cm: CM,
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // pixel 0

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.ColorSpace).toBe('Indexed');
    const d = img.Decode();
    expect(d[0]).toBe(0);                 // covered index → 0
    expect([...d.subarray(1, 4)]).toEqual([2, 1, 2]); // uncovered indices unchanged
  });

  it('keeps sub-byte 4-bpc packing: box-edge byte shares an uncovered nibble', () => {
    // 4×1, 4 bpc indexed → 2 bytes: byte0 = pixels(0,1), byte1 = pixels(2,3).
    const packed = Uint8Array.from([0xab, 0xcd]);
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 4, height: 1,
      colorSpace: '[/Indexed /DeviceGray 15 <000102030405060708090a0b0c0d0e0f>]',
      bits: 4, samples: packed, cm: CM,
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // pixel 0 = high nibble of byte0

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.Bits).toBe(4);
    const d = img.Decode();
    expect([...d]).toEqual([0x0b, 0xcd]); // pixel0 nibble cleared, pixel1 nibble (0x0b) kept
  });

  it('keeps DeviceGray 16-bpc: uncovered 16-bit samples identical, covered zeroed', () => {
    // 2×1 gray, 16 bpc → 4 bytes.
    const s = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
    const doc = Document.Open(buildPlacedRawImagePdf({
      width: 2, height: 1, colorSpace: '/DeviceGray', bits: 16, samples: s, cm: CM,
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 25, 100]]); // pixel 0 (left half of width-2 image)

    const img = Document.Open(doc.Save()).Pages[0].Images[0];
    expect(img.Bits).toBe(16);
    const d = img.Decode();
    expect([...d.subarray(0, 2)]).toEqual([0, 0]);            // covered pixel 0
    expect([...d.subarray(2, 4)]).toEqual([0x56, 0x78]);      // pixel 1 unchanged
  });

  it('falls back to RGBA (DeviceRGB + SMask) for a soft-masked image', () => {
    // A base image carrying an /SMask is ineligible for the sample path, so it
    // re-encodes via the RGBA path — which always emits DeviceRGB and keeps an SMask.
    const smAlpha = new Uint8Array(4 * 4).fill(200);
    const doc = Document.Open(buildPlacedImageWithSMaskPdf({
      width: 4, height: 4, samples: grid4(),
      smask: { width: 4, height: 4, filter: 'FlateDecode', raw: new Uint8Array(deflateSync(Buffer.from(smAlpha))) },
      placements: [CM],
    }));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);

    const reopened = Document.Open(doc.Save());
    const img = reopened.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceRGB');                 // RGBA fallback ran
    expect(isStream(reopened.resolve(img.Dict.get('SMask')))).toBe(true); // SMask kept, not dropped
  });
});

// hex-encode bytes for an ASCIIHexDecode (/AHx) inline image data segment.
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// Decode the (single) inline image of a reopened page back to samples.
function inlineSamples(doc: Document): { w: number; h: number; s: Uint8Array } {
  const ops = parseContentStream(doc.Pages[0].Contents);
  const bi = ops.find((o) => o.operator === 'BI');
  if (!bi || !bi.inlineImage) throw new Error('no inline image found');
  const stream = inlineImageToStream(bi.inlineImage);
  const info = new ImageInfo(doc, '', stream);
  return { w: info.Width, h: info.Height, s: info.Decode() };
}

describe('partial inline image redaction — sample-preserving', () => {
  it('blacks only the covered columns of a DeviceRGB inline image, in place', () => {
    // 4x4 DeviceRGB, one distinct colour per pixel; placed at device [0,0,100,100].
    const px = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) { px[i * 3] = 10 + i; px[i * 3 + 1] = 100; px[i * 3 + 2] = 200; }
    const stream = `q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${toHex(px)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → columns 0..1

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // stayed inline
    expect(content(reopened)).not.toContain('/XObject');
    const { w, s } = inlineSamples(reopened);
    const at = (x: number, y: number) => [s[(y * w + x) * 3], s[(y * w + x) * 3 + 1], s[(y * w + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]); // covered → black
    expect(at(1, 2)).toEqual([0, 0, 0]);
    expect(at(2, 0)[1]).toBe(100);       // uncovered → original green channel
    expect(at(3, 3)[2]).toBe(200);
  });

  it('clears only the covered bits of a 1-bit DeviceGray inline image', () => {
    // 8x1 DeviceGray, all-white (0xff); redact left half → columns 0..3 cleared.
    const stream = `q 100 0 0 100 0 0 cm BI /W 8 /H 1 /CS /G /BPC 1 /F /AHx ID ff> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const { s } = inlineSamples(reopened);
    expect(s[0]).toBe(0x0f); // MSB-first: cols 0..3 → 0, cols 4..7 → 1
  });

  it('partially redacts a rotated inline placement, staying inline', () => {
    // 90° placement; redact device [0,0,50,50] → top-left 2×2 image pixels blanked.
    const px = new Uint8Array(4 * 4 * 3).fill(120);
    const stream = `q 0 100 -100 0 100 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${toHex(px)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 50]]);
    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // stayed inline
    const { w, s } = inlineSamples(reopened);
    const at = (x: number, y: number) => [s[(y * w + x) * 3], s[(y * w + x) * 3 + 1], s[(y * w + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]);          // covered corner → black
    expect(at(1, 1)).toEqual([0, 0, 0]);
    expect(at(2, 2)).toEqual([120, 120, 120]);    // uncovered → preserved
  });
});

describe('partial inline image redaction — RGBA fallback and scope', () => {
  it('blacks covered columns of an opaque DCT inline image via the RGBA fallback', () => {
    const w = 8, h = 8;
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { px[i * 3] = 200; px[i * 3 + 1] = 100; px[i * 3 + 2] = 50; }
    const jpg = encodeBaselineJpeg({ width: w, height: h, comps: 3, pixels: px });
    // /F [/AHx /DCT]: hex-armour the JPEG so the fixture stays ASCII.
    const stream = `q 100 0 0 100 0 0 cm BI /W ${w} /H ${h} /CS /RGB /BPC 8 /F [/AHx /DCT] ID ${toHex(jpg)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]); // left device half → columns 0..3

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI'); // still inline
    const { w: iw, s } = inlineSamples(reopened); // re-encoded as /Fl /RGB
    const at = (x: number, y: number) => [s[(y * iw + x) * 3], s[(y * iw + x) * 3 + 1], s[(y * iw + x) * 3 + 2]];
    expect(at(0, 0)).toEqual([0, 0, 0]);                 // covered → black
    expect(at(1, 4)).toEqual([0, 0, 0]);
    expect(Math.abs(at(6, 0)[0] - 200)).toBeLessThanOrEqual(5); // uncovered → preserved (± JPEG)
    expect(Math.abs(at(7, 7)[1] - 100)).toBeLessThanOrEqual(5);
  });

  it('partially redacts an inline image mask, staying an inline ImageMask', () => {
    // 8x1 /ImageMask, all-zeros (every pixel MARKS under the default /Decode [0 1]).
    // Redact the left device half → covered columns become non-marking (bit 1).
    const stream = `q 100 0 0 100 0 0 cm BI /W 8 /H 1 /IM true /BPC 1 /F /AHx ID 00> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);

    const reopened = Document.Open(doc.Save());
    expect(content(reopened)).toContain('BI');          // stayed inline
    expect(content(reopened)).not.toContain('/XObject'); // no XObject fallback
    const op = parseContentStream(reopened.Pages[0].Contents).find((o) => o.operator === 'BI')!;
    expect(op.inlineImage!.dict.get('IM')).toBe(true);  // still a stencil mask
    const { s } = inlineSamples(reopened);
    expect(s[0]).toBe(0xf0); // MSB-first: cols 0..3 → 1 (masked), cols 4..7 → 0 (unchanged)
  });

  it('honours /D [1 0] when clearing an inline image mask', () => {
    // 8x1 /ImageMask, all-ones; under /D [1 0] sample 1 MARKS, so every pixel paints.
    // Redact left half → covered columns become the non-marking value (bit 0).
    const stream = `q 100 0 0 100 0 0 cm BI /W 8 /H 1 /IM true /BPC 1 /D [1 0] /F /AHx ID ff> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]]);
    const reopened = Document.Open(doc.Save());
    const { s } = inlineSamples(reopened);
    expect(s[0]).toBe(0x0f); // cols 0..3 → 0 (masked under [1 0]), cols 4..7 → 1 (unchanged)
  });

  it('throws for a partially-covered undecodable (truncated DCT) inline image', () => {
    const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]); // SOI+EOI only
    const stream = `q 100 0 0 100 0 0 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F [/AHx /DCT] ID ${toHex(jpg)}> EI Q`;
    const doc = Document.Open(buildMultiStreamPage([stream]));
    expect(() => redactPage(doc, doc.Pages[0], [[0, 0, 50, 100]])).toThrow(UnsupportedFeatureError);
  });
});
