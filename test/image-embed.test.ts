import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import {
  buildJpeg, buildPngRgb, buildPngGray, buildPngPalette, buildPngRgba,
  buildPngRgbWith, buildPngPaletteTrns, RGBA_PIXEL,
} from './helpers/build-embed-images.js';
import { inflateStream } from '../src/flate.js';
import { buildImageXObject, drawBuiltImage } from '../src/imageembed.js';
import { isName } from '../src/types.js';

function content(doc: Document): string {
  return new TextDecoder().decode(doc.Pages[0].Contents);
}

describe('buildImageXObject', () => {
  it('builds a DeviceRGB Image XObject from a JPEG without attaching it to a page', () => {
    const built = buildImageXObject(buildJpeg(4, 3, 3));
    const st = built.stream.dict.get('Subtype');
    expect(isName(st) && st.name).toBe('Image');
    expect(built.stream.dict.get('Width')).toBe(4);
    expect(built.stream.dict.get('Height')).toBe(3);
    expect(built.smask).toBeUndefined();
  });

  it('returns a soft mask for an RGBA PNG', () => {
    const built = buildImageXObject(buildPngRgba());
    expect(built.smask).toBeDefined();
  });

  it('throws on unrecognized image bytes', () => {
    expect(() => buildImageXObject(new Uint8Array([1, 2, 3]))).toThrow(UnsupportedFeatureError);
  });
});

describe('drawBuiltImage', () => {
  it('embeds a pre-built image into a rect and paints a cm/Do', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(40, 20, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [10, 10, 80, 40]);
    expect(doc.Pages[0].Images.length).toBe(1);
    const text = content(doc);
    expect(text).toContain('80 0 0 40 10 10 cm');
    expect(text).toContain('Do');
  });

  it('can embed the same BuiltImage twice as two independent XObjects', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildPngRgba());   // carries a soft mask
    drawBuiltImage(doc, doc.Pages[0], built, [0, 0, 10, 10]);
    drawBuiltImage(doc, doc.Pages[0], built, [20, 0, 10, 10]);
    const imgs = doc.Pages[0].Images;
    expect(imgs.length).toBe(2);                        // two distinct XObjects
  });

  it('registers an /ExtGState when opacity < 1', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(8, 8, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [0, 0, 8, 8], { opacity: 0.4 });
    expect(content(doc)).toMatch(/\/GS\d+ gs/);
  });

  it('wraps the draw in an /Artifact sequence when asked', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(40, 20, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [10, 10, 80, 40], { artifact: true });
    const text = content(doc);
    expect(text).toContain('/Artifact BMC');
    expect(text).toContain('EMC');
    expect(text.indexOf('/Artifact BMC')).toBeLessThan(text.indexOf('Do'));
  });

  it('draws bare when artifact is false', () => {
    const doc = Document.Open(buildStampTarget());
    const built = buildImageXObject(buildJpeg(40, 20, 3));
    drawBuiltImage(doc, doc.Pages[0], built, [10, 10, 80, 40], { artifact: false });
    expect(content(doc)).not.toContain('/Artifact BMC');
  });
});

describe('page.AddImage — JPEG', () => {
  it('embeds an RGB JPEG as a DCTDecode XObject and paints it', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildJpeg(40, 20, 3), [10, 10, 80, 40]);

    const imgs = doc.Pages[0].Images;
    expect(imgs.length).toBe(1);
    expect(imgs[0].Width).toBe(40);
    expect(imgs[0].Height).toBe(20);
    expect(imgs[0].ColorSpace).toBe('DeviceRGB');
    expect(imgs[0].Filter).toBe('DCTDecode');

    const text = content(doc);
    expect(text).toContain('80 0 0 40 10 10 cm');
    expect(text).toContain('Do');
    expect(text).toContain('Original'); // existing content preserved
  });

  it('grayscale JPEG -> DeviceGray', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildJpeg(8, 8, 1), [0, 0, 8, 8]);
    expect(doc.Pages[0].Images[0].ColorSpace).toBe('DeviceGray');
  });

  it('CMYK JPEG -> DeviceCMYK, no /Decode without an Adobe marker', () => {
    const built = buildImageXObject(buildJpeg(8, 8, 4));
    const cs = built.stream.dict.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceCMYK');
    expect(built.stream.dict.get('Decode')).toBeUndefined();
  });

  it('Adobe-APP14 CMYK JPEG -> inverting /Decode array', () => {
    const built = buildImageXObject(buildJpeg(8, 8, 4, { adobe: true }));
    expect(built.stream.dict.get('Decode')).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('passes the JPEG bytes through unchanged (RawData round-trip)', () => {
    const doc = Document.Open(buildStampTarget());
    const jpeg = buildJpeg(16, 16, 3);
    doc.Pages[0].AddImage(jpeg, [0, 0, 16, 16]);
    expect(doc.Pages[0].Images[0].RawData).toEqual(jpeg);
  });

  it('opacity registers an ExtGState and emits gs', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildJpeg(8, 8, 3), [0, 0, 8, 8], { opacity: 0.3 });
    expect(content(doc)).toMatch(/\/GS\d+ gs/);
  });

  it('rejects a non-image buffer', () => {
    const doc = Document.Open(buildStampTarget());
    expect(() => doc.Pages[0].AddImage(new Uint8Array([1, 2, 3]), [0, 0, 1, 1]))
      .toThrow(UnsupportedFeatureError);
  });
});

describe('page.AddImage — PNG', () => {
  it('RGB PNG -> DeviceRGB FlateDecode XObject, samples round-trip', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngRgb(), [0, 0, 2, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.Width).toBe(2);
    expect(img.Height).toBe(1);
    expect(img.ColorSpace).toBe('DeviceRGB');
    expect(img.Filter).toBe('FlateDecode');
    expect([...img.Decode()]).toEqual([255, 0, 0, 0, 255, 0]);
  });

  it('grayscale PNG -> DeviceGray', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngGray(), [0, 0, 2, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceGray');
    expect([...img.Decode()]).toEqual([0x10, 0x20]);
  });

  it('palette PNG -> Indexed color space, index samples round-trip', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngPalette(), [0, 0, 2, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('Indexed');
    expect([...img.Decode()]).toEqual([0, 1]);
  });

  it('RGBA PNG splits alpha into an /SMask DeviceGray image', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddImage(buildPngRgba(), [0, 0, 1, 1]);
    const img = doc.Pages[0].Images[0];
    expect(img.ColorSpace).toBe('DeviceRGB');
    expect([...img.Decode()]).toEqual([RGBA_PIXEL.r, RGBA_PIXEL.g, RGBA_PIXEL.b]);
    // SMask present and holds the alpha byte
    const smaskRef = img.Dict.get('SMask');
    expect(smaskRef).toBeDefined();
    const smask = doc.resolve(smaskRef);
    expect((smask as any).kind).toBe('stream');
    expect([...inflateStream(smask as any)]).toEqual([RGBA_PIXEL.a]);
  });

  it('maps palette tRNS transparency to a DeviceGray /SMask', () => {
    const { png, expectedAlpha } = buildPngPaletteTrns();
    const built = buildImageXObject(png);
    expect(built.smask).toBeDefined();
    expect(isName(built.stream.dict.get('ColorSpace'))).toBe(false); // Indexed array
    expect([...inflateStream(built.smask!)]).toEqual(expectedAlpha);
  });

  it('embeds an interlaced (Adam7) PNG identically to its non-interlaced twin', () => {
    // 5x3 RGB with distinct per-pixel values so every Adam7 pass carries data.
    const rgb: number[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) rgb.push(x * 40, y * 80, (x + y) * 20);
    const plain = buildImageXObject(buildPngRgbWith(5, 3, rgb, 0)).stream;
    const adam7 = buildImageXObject(buildPngRgbWith(5, 3, rgb, 1)).stream;
    expect([...inflateStream(adam7)]).toEqual([...inflateStream(plain)]);
    expect([...inflateStream(adam7)]).toEqual(rgb);
  });
});

describe('AddImage optional-content', () => {
  it('tags an embedded image into an optional-content layer via opts.layer', () => {
    const doc = Document.Open(buildStampTarget());
    const layer = doc.OptionalContent.AddLayer('Photos');
    doc.Pages[0].AddImage(buildPngRgb(), [0, 0, 100, 100], { layer });

    const res = doc.Pages[0].Resources!;
    const xobjs = doc.resolve(res.get('XObject')) as Map<string, any>;
    // the single Im* entry is the image we just added
    const imRef = [...xobjs.values()].find((v) => v && v.kind === 'ref');
    const xo = doc.resolve(imRef) as any;
    const oc = xo.dict.get('OC');
    expect(oc.kind).toBe('ref');
    expect(oc.num).toBe(layer.Ref.num);
  });
});
