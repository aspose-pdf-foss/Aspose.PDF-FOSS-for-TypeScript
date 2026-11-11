import { describe, it, expect } from 'vitest';
import { controlDocument } from './helpers/control-fixtures.js';
import type { ImageFormat } from '../src/raster.js';
import type { OperationProgress } from '../src/checkpoint.js';
import { decodeTiff, tiffPageCount } from '../src/tiff.js';

describe('controlled raster and SVG export', () => {
  it.each<ImageFormat>(['png', 'jpeg', 'bmp', 'tiff', 'gif'])('keeps %s sync/async output identical', async (format) => {
    const page = controlDocument().Pages[0];
    const events: OperationProgress[] = [];
    const result = await page.ToImageAsync({ format, onProgress: (event) => events.push(event) });
    expect(result).toEqual(page.ToImage({ format }));
    expect(events.map((e) => [e.operation, e.phase, e.completed, e.pageNumber])).toEqual([
      ['ToImage', 'render', 1, 1], ['ToImage', 'encode', 1, 1],
    ]);
  });

  it('keeps SVG output identical and emits render/assembly snapshots', async () => {
    const page = controlDocument().Pages[1], events: OperationProgress[] = [];
    expect(await page.ToSvgAsync({ onProgress: (event) => events.push(event) })).toBe(page.ToSvg());
    expect(events.map((e) => [e.operation, e.phase, e.pageNumber])).toEqual([
      ['ToSvg', 'render', 2], ['ToSvg', 'assemble', 2],
    ]);
  });

  it('observes pre-abort before invalid rendering options are evaluated', async () => {
    const page = controlDocument().Pages[0], reason = new Error('pre-abort');
    const options = { signal: AbortSignal.abort(reason), threshold: -1 };
    expect(() => page.ToImage(options)).toThrow(reason);
    await expect(page.ToImageAsync(options)).rejects.toBe(reason);
    expect(() => page.ToSvg(options)).toThrow(reason);
    await expect(page.ToSvgAsync(options)).rejects.toBe(reason);
  });

  it.each(['image', 'svg'])('stops %s before encoding/assembly when progress aborts', async (kind) => {
    const controller = new AbortController(), reason = new Error('after render');
    const page = controlDocument().Pages[0], events: OperationProgress[] = [];
    const options = { signal: controller.signal, onProgress: (e: OperationProgress) => { events.push(e); controller.abort(reason); } };
    const result = kind === 'image' ? page.ToImageAsync(options) : page.ToSvgAsync(options);
    await expect(result).rejects.toBe(reason);
    expect(events.map((e) => e.phase)).toEqual(['render']);
  });
});

describe('controlled multi-page TIFF', () => {
  it('uses selection page numbers and one final encoded TIFF', async () => {
    const doc = controlDocument(), events: OperationProgress[] = [];
    const tiff = await doc.ToTiffAsync({ pages: [1, 3], onProgress: (e) => events.push(e) });
    expect(tiff).toEqual(doc.ToTiff({ pages: [1, 3] }));
    expect(tiffPageCount(tiff)).toBe(2);
    const first = decodeTiff(tiff, 0), second = decodeTiff(tiff, 1);
    if (first.kind !== 'rgb' || second.kind !== 'rgb') throw new Error('Expected RGB frames');
    expect(Array.from(first.samples.slice(0, 3))).toEqual([255, 0, 0]);
    expect(Array.from(second.samples.slice(0, 3))).toEqual([0, 0, 255]);
    expect(events.map((e) => [e.operation, e.phase, e.completed, e.total, e.pageNumber])).toEqual([
      ['ToTiff', 'render', 1, 2, 1], ['ToTiff', 'render', 2, 2, 3],
      ['ToTiff', 'encode', 1, 1, undefined],
    ]);
  });

  it('cancels during a frame yield before touching the next selected page', async () => {
    const doc = controlDocument(), controller = new AbortController(), reason = new Error('after frame one');
    // Processing page 3 would exceed the canvas limit, so the reason identifies
    // whether the yield actually occurred before its expensive render.
    doc.Pages[2].Dict.set('MediaBox', [0, 0, 1_000_000, 1_000_000]);
    const events: OperationProgress[] = [];
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(doc.ToTiffAsync({ pages: [1, 3], signal: controller.signal, onProgress: (e) => {
        events.push(e); handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(events.map((e) => e.pageNumber)).toEqual([1]);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('stops synchronously at a callback abort and preserves empty-selection refusal', () => {
    const doc = controlDocument(), controller = new AbortController(), reason = new Error('stop');
    expect(() => doc.ToTiff({ signal: controller.signal, onProgress: () => controller.abort(reason) })).toThrow(reason);
    expect(() => doc.ToTiff({ pages: [] })).toThrow(/selection is empty/);
    expect(() => doc.ToTiff({ signal: AbortSignal.abort(reason), pages: [] })).toThrow(reason);
  });
});
