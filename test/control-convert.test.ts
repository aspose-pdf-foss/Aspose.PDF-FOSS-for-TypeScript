import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { OperationControlOptions, OperationProgress } from '../src/checkpoint.js';
import { buildGrayscalePdf, buildSignedGrayscalePdf } from './helpers/build-grayscale-pdf.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';

const cases = [
  { name: 'ConvertColors', sync: (d: Document, o: OperationControlOptions) => d.ConvertColors({ to: 'gray', ...o }), async: (d: Document, o: OperationControlOptions) => d.ConvertColorsAsync({ to: 'gray', ...o }) },
  { name: 'ConvertToGrayscale', sync: (d: Document, o: OperationControlOptions) => d.ConvertToGrayscale(o), async: (d: Document, o: OperationControlOptions) => d.ConvertToGrayscaleAsync(o) },
  { name: 'ConvertToPdfA', sync: (d: Document, o: OperationControlOptions) => d.ConvertToPdfA('2b', o), async: (d: Document, o: OperationControlOptions) => d.ConvertToPdfAAsync('2b', o) },
  { name: 'ConvertToPdfUa', sync: (d: Document, o: OperationControlOptions) => d.ConvertToPdfUa({ title: 'Controlled', ...o }), async: (d: Document, o: OperationControlOptions) => d.ConvertToPdfUaAsync({ title: 'Controlled', ...o }) },
  { name: 'ConvertToPdfX', sync: (d: Document, o: OperationControlOptions) => d.ConvertToPdfX('4', o), async: (d: Document, o: OperationControlOptions) => d.ConvertToPdfXAsync('4', o) },
];

describe('cooperative transformations', () => {
  for (const c of cases) {
    it(`${c.name} preserves pre-abort state and sync/async results`, async () => {
      const bytes = c.name.includes('Pdf') ? buildPdfaPdf({}, 2) : buildGrayscalePdf();
      const doc = Document.Open(bytes), reason = new Error('pre-abort'), before = doc.Save();
      expect(() => c.sync(doc, { signal: AbortSignal.abort(reason) })).toThrow(reason);
      await expect(c.async(doc, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(doc.isModifiedInternal()).toBe(false);
      expect(doc.Save()).toEqual(before);
      const expected = c.sync(Document.Open(bytes), {}), events: OperationProgress[] = [];
      const actual = await c.async(Document.Open(bytes), { onProgress: (e) => events.push(e) });
      // Compare reports without Page handles, whose Document identity differs.
      const normalized = (r: unknown) => JSON.stringify(r, (k, v: unknown) => k === 'page' && typeof v === 'object' && v !== null && 'Number' in v ? (v as { Number: number }).Number : v);
      expect(normalized(actual)).toBe(normalized(expected));
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((e) => e.operation))).toEqual(new Set([c.name]));
    });
  }

  it('retains completed colour edits after an abort during a yield', async () => {
    const doc = Document.Open(buildGrayscalePdf()), controller = new AbortController(), reason = new Error('partial');
    let handle: NodeJS.Immediate | undefined;
    try {
      await expect(doc.ConvertToGrayscaleAsync({ signal: controller.signal, onProgress: (e) => {
        if (e.phase === 'content' && e.completed === 1) handle = setImmediate(() => controller.abort(reason));
      } })).rejects.toBe(reason);
      expect(doc.isModifiedInternal()).toBe(true);
      const reopened = Document.Open(doc.Save());
      expect(reopened.Validate().Passed).toBe(true);
    } finally { if (handle) clearImmediate(handle); }
  });

  it.each(['ConvertToPdfA', 'ConvertToPdfUa', 'ConvertToPdfX'])('%s leaves completed passes and skips later passes after callback abort', async (name) => {
    const c = cases.find((entry) => entry.name === name)!, doc = Document.Open(buildPdfaPdf({}, 2));
    const controller = new AbortController(), reason = new Error('pass one'), events: OperationProgress[] = [];
    await expect(c.async(doc, { signal: controller.signal, onProgress: (e) => { events.push(e); controller.abort(reason); } })).rejects.toBe(reason);
    expect(events.map((e) => [e.phase, e.completed])).toEqual([['passes', 1]]);
    expect(doc.isModifiedInternal()).toBe(true);
    expect(Document.Open(doc.Save()).Validate().Passed).toBe(true);
  });

  it('retains part-2 revalidation and the outer conversion name', async () => {
    const doc = Document.Open(buildPdfaPdf({}, 2)), events: OperationProgress[] = [];
    const report = await doc.ConvertToPdfUaAsync({ part: 2, onProgress: (e) => events.push(e) });
    expect(report.unresolved.map((e) => e.rule)).toEqual(doc.ValidatePdfUa(2).Errors.map((e) => e.rule));
    expect(events.every((e) => e.operation === 'ConvertToPdfUa')).toBe(true);
  });

  it('preserves invalid-target and signed-document refusals', async () => {
    const doc = Document.Open(buildGrayscalePdf());
    await expect(doc.ConvertColorsAsync({ to: 'invalid' as 'gray' })).rejects.toThrow(/target/);
    const signed = Document.Open(buildSignedGrayscalePdf());
    await expect(signed.ConvertToGrayscaleAsync()).rejects.toThrow(/signed/);
  });
});
