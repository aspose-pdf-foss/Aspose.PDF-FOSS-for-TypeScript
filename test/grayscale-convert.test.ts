import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import {
  buildGrayscalePdf, buildAlreadyGrayPdf, buildSignedGrayscalePdf,
  buildGrayscaleImagePdf, buildGrayscaleShadingPdf, buildGrayscaleMeshPdf,
  buildColorKeyMaskPdf,
} from './helpers/build-grayscale-pdf.js';
import { inflateStream } from '../src/flate.js';
import { isName, isStream, name, type PdfObject, type PdfStream } from '../src/types.js';

/** Every content stream in the saved document, as text. */
function allContent(bytes: Uint8Array): string {
  const doc = Document.Open(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    try { out.push(new TextDecoder().decode(inflateStream(obj))); } catch { /* not content */ }
  }
  return out.join('\n');
}

describe('Document.ConvertToGrayscale — content streams', () => {
  it('converts colour in all five content locations', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertToGrayscale();
    const text = allContent(doc.Save());

    // No colour-setting operator survives anywhere.
    expect(text).not.toMatch(/\brg\b/);
    expect(text).not.toMatch(/\bRG\b/);

    // Each of the five reds/blues/greens/yellows/cyans became its luma.
    expect(text).toContain('0.299 g');   // page content, 1 0 0 rg
    expect(text).toContain('0.114 g');   // page content, /CS0 cs 0 0 1 sc
    expect(text).toContain('0.587 g');   // tiling pattern, 0 1 0 rg
    expect(text).toContain('0.886 g');   // Type 3 charproc, 1 1 0 rg
    expect(text).toContain('0.701 g');   // annotation /AP, 0 1 1 rg

    expect(report.streams).toBe(5);
    // Five `rg` (page, form, tile, charproc, /AP), one `sc`, one `cs` retarget.
    // The page's `/Pattern cs` and `/P0 scn` are deliberately NOT counted: a
    // bare /Pattern space has no base to convert and a coloured pattern takes
    // its colour from its own stream, which is one of the five.
    expect(report.operators).toBe(7);
    expect(report.skipped).toEqual([]);
    expect(report.lossy).toBe(false);
  });

  it('retargets a named colour space to DeviceGray', () => {
    const doc = Document.Open(buildGrayscalePdf());
    doc.ConvertToGrayscale();
    expect(allContent(doc.Save())).toContain('/DeviceGray cs');
  });

  it('is idempotent: a second run finds nothing left to do', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const first = doc.ConvertToGrayscale();
    const again = doc.ConvertToGrayscale();
    expect(first.operators).toBeGreaterThan(0);
    expect(again.operators).toBe(0);
    expect(again.streams).toBe(0);
  });

  it('leaves an already-grey document byte-identical', () => {
    const src = buildAlreadyGrayPdf();
    const control = Document.Open(src).Save();
    const doc = Document.Open(src);
    const report = doc.ConvertToGrayscale();
    expect(report.operators).toBe(0);
    expect(doc.Save()).toEqual(control);
  });

  it('refuses a signed document rather than discarding the change', () => {
    const doc = Document.Open(buildSignedGrayscalePdf());
    expect(() => doc.ConvertToGrayscale()).toThrow(UnsupportedFeatureError);
  });
});

describe('Document.ConvertToGrayscale — images', () => {
  it('converts both image XObjects and reports each route', () => {
    const doc = Document.Open(buildGrayscaleImagePdf());
    const report = doc.ConvertToGrayscale();

    expect(report.images).toHaveLength(2);
    expect(report.images.map((i) => i.route).sort()).toEqual(['flate', 'jpeg-exact']);
    for (const i of report.images) expect(i.from).toBe('DeviceRGB');
    // The JPEG took the coefficient route, so nothing was re-encoded and the
    // whole conversion is lossless. Before 10u9.6 this asserted `true`.
    expect(report.lossy).toBe(false);
    expect(report.skipped).toEqual([]);
  });

  it('leaves every image XObject in DeviceGray', () => {
    const doc = Document.Open(buildGrayscaleImagePdf());
    doc.ConvertToGrayscale();
    const saved = Document.Open(doc.Save());
    let images = 0;
    for (const [, obj] of saved.objectEntries()) {
      if (!isStream(obj)) continue;
      const st = saved.resolve(obj.dict.get('Subtype'));
      if (!st || !isName(st) || st.name !== 'Image') continue;
      images++;
      expect(obj.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    }
    expect(images).toBe(2);
  });

  it('converts a colour-key /Mask into a stencil, exactly', () => {
    const doc = Document.Open(buildColorKeyMaskPdf());
    const report = doc.ConvertToGrayscale();
    expect(report.skipped).toEqual([]);
    expect(report.images).toHaveLength(1);

    const saved = Document.Open(doc.Save());
    const image = [...saved.objectEntries()].map(([, o]) => o).find(
      (o): o is PdfStream => isStream(o)
        && saved.resolve(o.dict.get('Width')) === 2
        && saved.resolve(o.dict.get('ImageMask')) !== true);
    if (!image) throw new Error('the image did not survive the save');

    expect(image.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    // Both keyed and unkeyed pixel are grey 76 now: the samples cannot tell
    // them apart, which is exactly why the range had to become a stencil.
    expect([...inflateStream(image)]).toEqual([76, 76, 29, 255]);

    const stencil = saved.resolve(image.dict.get('Mask'));
    if (!isStream(stencil)) throw new Error('/Mask is not a stencil stream');
    expect(stencil.dict.get('ImageMask')).toBe(true);
    expect(stencil.dict.get('Width')).toBe(2);
    // Only the keyed pixel is masked, not its luma twin.
    expect([...inflateStream(stencil)]).toEqual([0x80, 0x00]);
  });

  it('is not lossy when no JPEG was re-encoded', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(doc.ConvertToGrayscale().lossy).toBe(false);
  });
});

describe('Document.ConvertToGrayscale — shadings', () => {
  it('converts a /Shading resource and a shading pattern alike', () => {
    const doc = Document.Open(buildGrayscaleShadingPdf());
    const report = doc.ConvertToGrayscale();
    expect(report.shadings).toBe(2);
    expect(report.skipped).toEqual([]);

    const text = new TextDecoder().decode(doc.Save());
    expect(text).not.toContain('/DeviceRGB');
    expect(text).toContain('/DeviceGray');
    expect(text).toContain('/C0 [0.299]');
    expect(text).toContain('/C1 [0.114]');
  });

  it('rewrites a function-less mesh’s vertex data rather than skipping it', () => {
    const doc = Document.Open(buildGrayscaleMeshPdf());
    const report = doc.ConvertToGrayscale();
    expect(report.shadings).toBe(1);
    expect(report.skipped).toEqual([]);

    const saved = Document.Open(doc.Save());
    const sh = [...saved.objectEntries()]
      .map(([, o]) => o)
      .find((o): o is PdfStream =>
        isStream(o) && saved.resolve(o.dict.get('ShadingType')) === 4);
    if (!sh) throw new Error('the mesh shading did not survive the save');

    expect(sh.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    // Three colour ranges become one; the coordinate half is untouched.
    expect(sh.dict.get('Decode')).toEqual([0, 200, 0, 200, 0, 1]);
    // Each vertex keeps its flag and its four coordinate bytes, and its three
    // colour bytes collapse to the luma of the colour they stated:
    // red -> 76, green -> 150, blue -> 29.
    expect([...inflateStream(sh)]).toEqual([
      0, 0x00, 0x00, 0x00, 0x00, 76,
      0, 0xff, 0xff, 0x00, 0x00, 150,
      0, 0x80, 0x00, 0xff, 0xff, 29,
    ]);
  });
});

describe('Document.ConvertToGrayscale — annotations', () => {
  it('greys /C and /IC', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertToGrayscale();
    const annot = doc.Pages[0].Annotations[0];
    expect(annot.Dict.get('C')).toEqual([0.299]);
    expect(annot.Dict.get('IC')).toEqual([0.114]);
    expect(report.annotations).toBe(1);
  });

  it('leaves an empty /C empty rather than painting a black border', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const annot = doc.Pages[0].Annotations[0];
    annot.Dict.set('C', []);
    doc.ConvertToGrayscale();
    expect(annot.Dict.get('C')).toEqual([]);
  });

  it('rewrites a /DA through the content rewriter, keeping its other operators', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const annot = doc.Pages[0].Annotations[0];
    annot.Dict.set('DA', {
      kind: 'string', bytes: new TextEncoder().encode('/Helv 12 Tf 1 0 0 rg'),
    });
    doc.ConvertToGrayscale();
    const da = new TextDecoder().decode(
      (annot.Dict.get('DA') as { bytes: Uint8Array }).bytes);
    expect(da).toContain('/Helv 12 Tf');   // parseDA would have kept only this
    expect(da).toContain('0.299 g');
    expect(da).not.toContain('rg');
  });

  it('greys a widget /MK /BG and /BC', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const annot = doc.Pages[0].Annotations[0];
    annot.Dict.set('MK', new Map<string, PdfObject>([
      ['BG', [0, 1, 0]], ['BC', [0, 0, 1]],
    ]));
    doc.ConvertToGrayscale();
    const mk = annot.Dict.get('MK') as Map<string, PdfObject>;
    expect(mk.get('BG')).toEqual([0.587]);
    expect(mk.get('BC')).toEqual([0.114]);
  });
});
