import { describe, it, expect } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { Document, LoadLimits, ResourceLimitError, UnsupportedFeatureError,
  type ThumbnailOptions, type OperationProgress } from '../src/index.js';
import { buildThumbnails } from './helpers/build-thumbnails.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';
import { decodeJpeg } from '../src/jpeg.js';
import { decodeTiff } from '../src/tiff.js';

describe('Document.ToThumbnails', () => {
  it('fits every page in order, enlarges small pages, and renders its ink', () => {
    const doc = buildThumbnails();
    const before = doc.Save();
    const images = doc.ToThumbnails({ maxSize: 64 });
    expect(images).toHaveLength(3);
    const decoded = images.map(decodePng);
    expect(decoded.map(p => [p.width, p.height])).toEqual([[32, 64], [64, 32], [64, 32]]);
    expect(decoded.map(p => p.at(4, 4))).toEqual([
      [255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255],
    ]);
    expect(decoded.map(p => p.at(p.width - 4, 4))).toEqual(
      Array(3).fill([255, 255, 255, 255]));
    expect(images[0]).toEqual(doc.Pages[0].ToImage({ width: 32, height: 64 }));
    expect(doc.Save()).toEqual(before);
  });

  it.each([
    [0, 64, 32], [90, 32, 64], [180, 64, 32], [270, 32, 64], [-90, 32, 64],
  ])('fits rotated crop viewports (%i degrees)', (rotate, width, height) => {
    const doc = Document.Open(buildSvgPdf({
      mediaBox: [0, 0, 300, 300], cropBox: [20, 40, 220, 140], rotate,
      content: '1 0 0 rg 20 40 200 100 re f',
    }));
    const bytes = doc.ToThumbnails({ maxSize: 64 })[0];
    const image = decodePng(bytes);
    expect([image.width, image.height]).toEqual([width, height]);
    expect(image.at(10, 10)).toEqual([255, 0, 0, 255]);
    expect(bytes).toEqual(doc.Pages[0].ToImage({ width, height }));
    const media = decodePng(doc.ToThumbnails({ maxSize: 64, box: 'media' })[0]);
    expect([media.width, media.height]).toEqual([64, 64]);
    expect(media.at(63, 63)).toEqual([255, 255, 255, 255]);
  });

  it.each([
    [3.5, 10.5, 20, 7, 20], [1000, 0.01, 32, 32, 1],
    [120, 240, 1, 1, 1], [1e-200, 2e-200, 8, 4, 8],
  ])('bounds fractional/narrow viewports (%s x %s)', (w, h, maxSize, width, height) => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.Dict.set('MediaBox', [0, 0, w, h]);
    const image = decodePng(doc.ToThumbnails({ maxSize })[0]);
    expect([image.width, image.height]).toEqual([width, height]);
  });

  it('keeps runtime sizing keys from overriding the thumbnail bound', () => {
    const options = { maxSize: 16, width: 1000, height: 1000, scale: 1000 };
    const image = decodePng(buildThumbnails().ToThumbnails(options)[0]);
    expect([image.width, image.height]).toEqual([8, 16]);
  });

  it('returns no images for an empty document', async () => {
    const doc = Document.New();
    expect(doc.ToThumbnails({ maxSize: 32 })).toEqual([]);
    expect(await doc.ToThumbnailsAsync({ maxSize: 32 })).toEqual([]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null, '32'])
    ('rejects invalid maxSize %s even with no pages', (maxSize) => {
      expect(() => Document.New().ToThumbnails({ maxSize } as ThumbnailOptions)).toThrow(TypeError);
    });

  it.each([
    { format: 'webp' }, { format: 'jpeg', background: 'transparent' },
    { mode: 'gray', background: 'transparent' }, { format: 'jpeg', mode: 'bilevel' },
  ])('validates output combinations before rendering an empty document (%j)', options => {
    expect(() => Document.New().ToThumbnails({ maxSize: 16, ...options } as ThumbnailOptions))
      .toThrow(UnsupportedFeatureError);
  });

  it('rejects invalid threshold and incompatible G4 output even with no pages', () => {
    expect(() => Document.New().ToThumbnails({ maxSize: 16, threshold: 256 })).toThrow(TypeError);
    expect(() => Document.New().ToThumbnails({ maxSize: 16, format: 'tiff', compression: 'g4' }))
      .toThrow(TypeError);
  });

  it.each([[0, 0, 0, 10], [0, 0, 10, 0], [0, 0, Infinity, 10], [0, 0, NaN, 10]].map(box => [box]))
    ('preflights a later invalid viewport %j before rendering any page', box => {
      const doc = buildThumbnails();
      doc.Pages[1].Dict.set('CropBox', box);
      const events: OperationProgress[] = [];
      expect(() => doc.ToThumbnails({ maxSize: 16, onProgress: e => events.push(e) }))
        .toThrow(/ToThumbnails.*viewport/);
      expect(events).toEqual([]);
    });

  it('preflights a later viewport whose fitted render scale overflows', () => {
    const doc = buildThumbnails();
    doc.Pages[1].Dict.set('CropBox', [0, 0, 1e-309, 2e-309]);
    const events: OperationProgress[] = [];
    expect(() => doc.ToThumbnails({ maxSize: 8, onProgress: e => events.push(e) }))
      .toThrow(/ToThumbnails.*viewport/);
    expect(events).toEqual([]);
  });

  it('forwards JPEG quality, transparent PNG and TIFF bilevel compression', () => {
    const doc = buildThumbnails();
    const options = { maxSize: 32, format: 'jpeg', quality: 90 } as const;
    const jpeg = doc.ToThumbnails(options)[0];
    expect(jpeg).toEqual(doc.Pages[0].ToImage({ format: 'jpeg', quality: 90, width: 16, height: 32 }));
    const j = decodeJpeg(jpeg);
    expect([j.width, j.height]).toEqual([16, 32]);
    const rgba = decodePng(doc.ToThumbnails({ maxSize: 32, background: 'transparent' })[0]);
    expect(rgba.colorType).toBe(6);
    expect(rgba.at(15, 2)[3]).toBe(0);
    const tiffBytes = doc.ToThumbnails({
      maxSize: 32, format: 'tiff', compression: 'g4', mode: 'bilevel',
    })[0];
    expect(tiffBytes).toEqual(doc.Pages[0].ToImage({
      width: 16, height: 32, format: 'tiff', compression: 'g4', mode: 'bilevel',
    }));
    const tiff = decodeTiff(tiffBytes);
    if (tiff.kind !== 'gray') throw new Error('expected grayscale TIFF');
    expect([tiff.width, tiff.height, tiff.bpc]).toEqual([16, 32, 1]);
  });

  it('honors annotation visibility options', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.MediaBox = [0, 0, 100, 100];
    page.AddSquare({ rect: [10, 10, 90, 90], color: [1, 0, 0], fill: [1, 0, 0] });
    expect(decodePng(doc.ToThumbnails({ maxSize: 20 })[0]).at(10, 10)).toEqual([255, 0, 0, 255]);
    expect(decodePng(doc.ToThumbnails({ maxSize: 20, annotations: false })[0]).at(10, 10))
      .toEqual([255, 255, 255, 255]);
  });

  it('preserves content limits while using the explicit canvas-size exception', () => {
    const bytes = buildSvgPdf({ content: 'n '.repeat(11) });
    const limited = Document.Open(bytes, { limits: LoadLimits.defaults.with({ maxContentTokens: 10 }) });
    expect(() => limited.ToThumbnails({ maxSize: 16 })).toThrow(ResourceLimitError);
    const explicit = Document.Open(bytes, { limits: LoadLimits.defaults.with({ maxCanvasPixels: 1 }) });
    expect(decodePng(explicit.ToThumbnails({ maxSize: 16 })[0]).width).toBe(16);
  });
});

describe('thumbnail operation controls', () => {
  it('shares sync/async bytes and reports outer operation identity and page numbers', async () => {
    const doc = buildThumbnails();
    const events: OperationProgress[] = [];
    const result = await doc.ToThumbnailsAsync({ maxSize: 16, onProgress: e => events.push(e) });
    expect(result).toEqual(doc.ToThumbnails({ maxSize: 16 }));
    expect(events.map(e => e.operation)).toEqual(Array(6).fill('ToThumbnails'));
    expect(events.map(e => e.pageNumber)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(events.map(e => e.phase)).toEqual(['render', 'encode', 'render', 'encode', 'render', 'encode']);
  });

  it('preserves pre-abort reasons in both entry points', async () => {
    const reason = new Error('cancelled');
    const signal = AbortSignal.abort(reason);
    const doc = buildThumbnails();
    expect(() => doc.ToThumbnails({ maxSize: 16, signal })).toThrow(reason);
    await expect(doc.ToThumbnailsAsync({ maxSize: 16, signal })).rejects.toBe(reason);
  });

  it('stops between pages after a progress callback aborts', async () => {
    for (const async of [false, true]) {
      const controller = new AbortController();
      const reason = new Error('stop');
      const events: OperationProgress[] = [];
      const options = { maxSize: 16, signal: controller.signal, onProgress: (e: OperationProgress) => {
        events.push(e);
        if (e.phase === 'encode') controller.abort(reason);
      } };
      const doc = buildThumbnails();
      if (async) await expect(doc.ToThumbnailsAsync(options)).rejects.toBe(reason);
      else expect(() => doc.ToThumbnails(options)).toThrow(reason);
      expect(events.map(e => e.pageNumber)).toEqual([1, 1]);
    }
  });

  it('yields even without a progress callback', async () => {
    let completed = false;
    const pending = buildThumbnails().ToThumbnailsAsync({ maxSize: 16 }).then(() => { completed = true; });
    await setImmediate();
    expect(completed).toBe(false);
    await pending;
  });

  it('preserves progress callback errors', async () => {
    const reason = new Error('listener');
    const options = { maxSize: 16, onProgress: () => { throw reason; } };
    expect(() => buildThumbnails().ToThumbnails(options)).toThrow(reason);
    await expect(buildThumbnails().ToThumbnailsAsync(options)).rejects.toBe(reason);
  });
});
