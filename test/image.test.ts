import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildImagePdf, buildSingleImagePdf, lzwEncode } from './helpers/build-image-pdf.js';
import { lossless_gray_j2k, lossless_gray_rgb } from './helpers/jpx-fixtures.js';
import { drawBuiltImage, buildImageXObject } from '../src/imageembed.js';
import { buildPngRgb } from './helpers/build-embed-images.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

describe('drawBuiltImage tagging', () => {
  it('drawBuiltImage wraps the draw in marked content when tagged', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const fig = doc.CreateStructTree().Append('Figure', { alt: 'a red dot' });
    const built = buildImageXObject(buildPngRgb());
    drawBuiltImage(doc, page, built, [10, 10, 20, 20], { tag: fig });
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('BDC');
    expect(content).toContain('EMC');
  });
});

describe('Image extraction', () => {
  it('opens the fixture with one page', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    expect(doc.Pages).toHaveLength(1);
  });

  it('enumerates page images, recursing into Form XObjects', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const names = doc.Pages[0].Images.map((i) => i.Name);
    expect(names).toEqual(['Im0', 'Dct0', 'ImF', 'Msk0', 'Jb0']);
  });

  it('reads dimensions, colorspace and bits', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const im0 = doc.Pages[0].Images.find((i) => i.Name === 'Im0')!;
    expect([im0.Width, im0.Height]).toEqual([2, 2]);
    expect(im0.ColorSpace).toBe('DeviceRGB');
    expect(im0.Bits).toBe(8);
    expect(im0.Filter).toBe('FlateDecode');
  });

  it('handles image masks gracefully (1 bit, no colorspace)', () => {
    const doc = Document.Open(buildImagePdf().bytes);
    const msk = doc.Pages[0].Images.find((i) => i.Name === 'Msk0')!;
    expect(msk.Bits).toBe(1);
    expect(msk.ColorSpace).toBe('');
  });

  it('decodes Flate samples and passes JPEG bytes through', () => {
    const { bytes, rgbSamples, jpegBytes } = buildImagePdf();
    const doc = Document.Open(bytes);
    const imgs = doc.Pages[0].Images;
    const im0 = imgs.find((i) => i.Name === 'Im0')!;
    expect(im0.Decode()).toEqual(rgbSamples);
    const dct = imgs.find((i) => i.Name === 'Dct0')!;
    expect(dct.Filter).toBe('DCTDecode');
    expect(dct.RawData).toEqual(jpegBytes);
    expect(dct.Decode()).toEqual(jpegBytes);
  });

  it('decodes a JBIG2 image to 1-bpp samples', () => {
    const built = buildImagePdf();
    const doc = Document.Open(built.bytes);
    const jb = doc.Pages[0].Images.find((i) => i.Name === 'Jb0')!;
    expect(jb.RawData.length).toBeGreaterThan(0); // raw access never throws
    expect(Array.from(jb.Decode())).toEqual(Array.from(built.jbig2Samples));
  });

  it('decodes an LZW-compressed image to samples', () => {
    const samples = Uint8Array.from([0x10, 0x20, 0x30, 0x40]);
    const bytes = buildSingleImagePdf({
      width: 2, height: 2, colorSpace: 'DeviceGray', bits: 8,
      filter: 'LZWDecode', raw: lzwEncode(samples),
    });
    const img = Document.Open(bytes).Pages[0].Images[0];
    expect(Array.from(img.Decode())).toEqual(Array.from(samples));
  });

  it('decodes a CCITTFaxDecode (Group 4) image to 1-bpp samples', () => {
    const bytes = buildSingleImagePdf({
      width: 8, height: 1, colorSpace: 'DeviceGray', bits: 1,
      filter: 'CCITTFaxDecode', extra: '/DecodeParms << /K -1 /Columns 8 /Rows 1 >>',
      raw: Uint8Array.from([0x80]),
    });
    const img = Document.Open(bytes).Pages[0].Images[0];
    expect(Array.from(img.Decode())).toEqual([0x00]);
  });

  it('decodes a JPXDecode (JPEG 2000) image to samples', () => {
    const bytes = buildSingleImagePdf({
      width: lossless_gray_rgb.width, height: lossless_gray_rgb.height,
      colorSpace: 'DeviceGray', bits: 8, filter: 'JPXDecode', raw: lossless_gray_j2k,
    });
    const img = Document.Open(bytes).Pages[0].Images[0];
    expect(Array.from(img.Decode())).toEqual(Array.from(lossless_gray_rgb.data));
  });
});
