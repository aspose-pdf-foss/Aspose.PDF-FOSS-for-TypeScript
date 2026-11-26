import { expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { LoadLimits } from '../src/loadlimits.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { decodeTiff } from '../src/tiff.js';
import type { ImageOptions, RasterBackground, ThumbnailOptions, TiffExportOptions } from '../src/raster.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { constantAlphaPdf } from './helpers/build-transparency-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

it('returns owned RGBA bytes in top-left row order from both entry points', async () => {
  const page = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 2, 2],
    content: '1 0 0 rg 0 1 1 1 re f 0 0 1 rg 1 0 1 1 re f' })).Pages[0];
  const pixels = page.ToPixels();
  expect(pixels).toMatchObject({ width: 2, height: 2, stride: 8 });
  expect(pixels.data).toBeInstanceOf(Uint8Array);
  const expected = Uint8Array.of(255, 0, 0, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 0, 0, 255, 255);
  expect(pixels.data).toEqual(expected);
  const other = await page.ToPixelsAsync();
  pixels.data.fill(7);
  expect(other.data).toEqual(expected);
  expect(page.ToPixels().data).toEqual(expected);
});

it('uses straight alpha and matches decoded transparent PNG', () => {
  const page = Document.Open(constantAlphaPdf()).Pages[0];
  const opts = { background: 'transparent', width: 10 } as const;
  const pixels = page.ToPixels(opts);
  const i = pixels.stride * 5 + 4 * 5;
  expect([...pixels.data.slice(i, i + 4)]).toEqual([255, 0, 0, 128]);
  expect(pixels.data).toEqual(decodePng(page.ToImage(opts)).data);
});

it('uses the existing rotated viewport, annotation switch and canvas limits', () => {
  const pdf = buildSvgPdf({ mediaBox: [0, 0, 80, 50], cropBox: [10, 10, 50, 30], rotate: 90, content: '' });
  const page = Document.Open(pdf, { limits: LoadLimits.defaults.with({ maxCanvasPixels: 800 }) }).Pages[0];
  page.AddSquare({ rect: [15, 15, 35, 25], fill: [1, 0, 0] });
  expect(page.ToPixels()).toMatchObject({ width: 20, height: 40, stride: 80 });
  expect(page.ToPixels().data).not.toEqual(page.ToPixels({ annotations: false }).data);
  expect(() => page.ToPixels({ scale: 2 })).toThrow(/maxCanvasPixels/);
  expect(() => page.ToPixels({ box: 'media' })).toThrow(/maxCanvasPixels/);
  expect(page.ToPixels({ box: 'media', width: 30, height: 30 }).data.length).toBe(3600);
});

it('observes cancellation before drawing and between rendering and conversion', async () => {
  const page = Document.Open(constantAlphaPdf()).Pages[0];
  const reason = new Error('cancel render');
  expect(() => page.ToPixels({ signal: AbortSignal.abort(reason) })).toThrow(reason);
  const controller = new AbortController();
  const phases: string[] = [];
  await expect(page.ToPixelsAsync({ signal: controller.signal, onProgress(e) {
    expect(e.operation).toBe('ToPixels');
    phases.push(e.phase!);
    if (e.phase === 'render') controller.abort(reason);
  } })).rejects.toBe(reason);
  expect(phases).toEqual(['render']);
});

it('seeds the canvas before Multiply and matches PNG at every pixel', () => {
  const page = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 2, 1],
    resources: '<< /ExtGState << /M << /BM /Multiply >> >> >>',
    content: '/M gs 1 0 0 rg 1 0 1 1 re f' })).Pages[0];
  const cases: [RasterBackground, number[], number[]][] = [
    ['white', [255, 255, 255, 255], [255, 0, 0, 255]],
    ['transparent', [0, 0, 0, 0], [255, 0, 0, 255]],
    [[0.2, 0.4, 0.6], [51, 102, 153, 255], [51, 0, 0, 255]],
    [[0.2, 0.4, 0.6, 0.5], [51, 102, 153, 128], [153, 0, 0, 255]],
    [[0.2, 0.4, 0.6, 0], [51, 102, 153, 0], [255, 0, 0, 255]],
  ];
  for (const [background, left, right] of cases) {
    const png = decodePng(page.ToImage({ background }));
    expect(png.channels).toBe(left[3] === 255 ? 3 : 4);
    const data = page.ToPixels({ background }).data;
    expect([...data]).toEqual([...left, ...right]);
    expect([...data]).toEqual([...png.at(0, 0), ...png.at(1, 0)]);
  }
  expect(page.ToImage({ background: [1, 1, 1, 1] })).toEqual(page.ToImage());
});

it('shares the original backdrop across TIFF frames and thumbnails', async () => {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 2, 1], content: '' }));
  doc.AddPage(doc.Pages[0]);
  const background: [number, number, number, number] = [0.2, 0.4, 0.6, 0.5];
  const tint = () => { background[0] = 1; };
  const tiff = await doc.ToTiffAsync({ background, onProgress: tint });
  for (const n of [0, 1]) {
    const frame = decodeTiff(tiff, n);
    if (frame.kind !== 'rgb') throw new Error('expected RGB TIFF frame');
    expect([...frame.samples.slice(0, 3)]).toEqual([51, 102, 153]);
    expect(frame.alpha?.[0]).toBe(128);
  }
  background[0] = 0.2;
  const thumbs = doc.ToThumbnails({ maxSize: 2, background, onProgress: tint });
  expect(thumbs).toHaveLength(2);
  for (const thumbnail of thumbs) expect(decodePng(thumbnail).at(0, 0)).toEqual([51, 102, 153, 128]);
});

it('uses validated output settings after a progress callback edits its options', async () => {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 2, 1], content: '' }));
  doc.AddPage(doc.Pages[0]);
  const background = [1, 0, 0, 0.5] as const;
  const image: ImageOptions = { background, onProgress() { image.mode = 'gray'; } };
  expect(decodePng(await doc.Pages[0].ToImageAsync(image)).at(0, 0)).toEqual([255, 0, 0, 128]);
  const thumbs: ThumbnailOptions = { background, maxSize: 2, onProgress() { thumbs.mode = 'gray'; } };
  for (const png of doc.ToThumbnails(thumbs)) expect(decodePng(png).at(0, 0)).toEqual([255, 0, 0, 128]);
  const tiff: TiffExportOptions = { background, onProgress() { tiff.compression = 'g4'; } };
  const frame = decodeTiff(doc.ToTiff(tiff), 1);
  if (frame.kind !== 'rgb') throw new Error('expected RGB TIFF frame');
  expect(frame.alpha?.[0]).toBe(128);
});

it('validates backdrop shapes and values before canvas allocation', () => {
  const pdf = buildSvgPdf({ mediaBox: [0, 0, 10, 10], content: '' });
  const doc = Document.Open(pdf, { limits: LoadLimits.defaults.with({ maxCanvasPixels: 1 }) });
  for (const background of [[], [1, 1], [1, 1, 1, 1, 1], [1, '1', 1], Array(3), null, 'blue']) {
    expect(() => doc.Pages[0].ToPixels({ background: background as RasterBackground })).toThrow(TypeError);
  }
  for (const background of [[NaN, 0, 0], [0, Infinity, 0], [0, 0, -0.1], [1, 1, 1, 1.01]] as const)
    expect(() => doc.Pages[0].ToImage({ background })).toThrow(RangeError);
  const translucent = [0, 0, 1, 0.5] as const;
  for (const format of ['jpeg', 'gif', 'bmp'] as const) {
    expect(() => doc.Pages[0].ToImage({ format, background: translucent })).toThrow(UnsupportedFeatureError);
    expect(doc.Pages[0].ToImage({ format, background: [0, 0, 1, 1], width: 2, height: 2 }).length).toBeGreaterThan(0);
  }
  for (const mode of ['gray', 'bilevel'] as const) {
    expect(() => doc.ToTiff({ mode, background: translucent })).toThrow(UnsupportedFeatureError);
    expect(() => doc.Pages[0].ToImage({ mode, background: translucent })).toThrow(UnsupportedFeatureError);
  }
  expect(() => Document.New().ToThumbnails({ maxSize: 2, format: 'jpeg', background: translucent }))
    .toThrow(UnsupportedFeatureError);
});
