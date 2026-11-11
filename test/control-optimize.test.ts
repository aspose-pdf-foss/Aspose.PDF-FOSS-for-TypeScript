import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { OperationProgress } from '../src/checkpoint.js';
import { buildWholeFontPdf, buildSimpleTtfPdf } from './helpers/build-optimize-pdf.js';
import { buildTwinImagePdf } from './helpers/build-imageopt-pdf.js';
import { buildSignedGrayscalePdf } from './helpers/build-grayscale-pdf.js';

describe('cooperative optimization', () => {
  it('checks pre-abort before modifying the model', async () => {
    const doc = Document.Open(buildWholeFontPdf()), before = doc.Save(), reason = new Error('stop');
    expect(() => doc.Optimize({ signal: AbortSignal.abort(reason) })).toThrow(reason);
    await expect(doc.OptimizeAsync({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(doc.isModifiedInternal()).toBe(false);
    expect(doc.Save()).toEqual(before);
  });

  it.each(['fonts', 'images', 'unembed'])('preserves %s optimization results and the outer name', async (kind) => {
    const bytes = kind === 'images' ? buildTwinImagePdf().bytes : kind === 'unembed' ? buildSimpleTtfPdf() : buildWholeFontPdf();
    const options = kind === 'images' ? { images: { quality: 60 } } : kind === 'unembed' ? { unembedStandard14: true } : {};
    const expectedDoc = Document.Open(bytes), actualDoc = Document.Open(bytes), events: OperationProgress[] = [];
    const expected = expectedDoc.Optimize(options);
    expect(await actualDoc.OptimizeAsync({ ...options, onProgress: (e) => events.push(e) })).toEqual(expected);
    expect(actualDoc.Save()).toEqual(expectedDoc.Save());
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.operation === 'Optimize')).toBe(true);
  });

  it.each(['glyph-pages', 'fonts', 'streams', 'images'])('cancels during %s and retains coherent partial edits', async (phase) => {
    const bytes = phase === 'images' ? buildTwinImagePdf().bytes : buildWholeFontPdf();
    const doc = Document.Open(bytes), controller = new AbortController(), reason = new Error(phase), events: OperationProgress[] = [];
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(doc.OptimizeAsync({ images: phase === 'images' ? { quality: 60 } : undefined,
        signal: controller.signal, onProgress: (e) => {
          events.push(e); if (e.phase === phase) handle = setImmediate(() => controller.abort(reason));
        } })).rejects.toBe(reason);
      expect(events.at(-1)?.phase).toBe(phase);
      expect(doc.isModifiedInternal()).toBe(true);
      expect(Document.Open(doc.Save()).Validate().Passed).toBe(true);
    } finally { if (handle) clearImmediate(handle); }
  });

  it('cancels between atomic dedup iterations without dangling references or changed rendering', async () => {
    const doc = Document.Open(buildTwinImagePdf().bytes), before = doc.Pages[0].ToImage();
    const controller = new AbortController(), reason = new Error('dedup');
    await expect(doc.OptimizeAsync({ fonts: false, compress: false, dr: false,
      signal: controller.signal, onProgress: (e) => { if (e.phase === 'dedup') controller.abort(reason); },
    })).rejects.toBe(reason);
    expect(Document.Open(doc.Save()).Pages[0].ToImage()).toEqual(before);
  });

  it('does not report disabled passes and preserves signed refusal', async () => {
    const doc = Document.Open(buildWholeFontPdf()), events: OperationProgress[] = [];
    await doc.OptimizeAsync({ fonts: false, dedup: false, compress: false, dr: false, onProgress: (e) => events.push(e) });
    expect(events).toEqual([]);
    await expect(Document.Open(buildSignedGrayscalePdf()).OptimizeAsync()).rejects.toThrow(/signature/);
  });
});
