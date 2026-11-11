import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { OperationControlOptions, OperationProgress } from '../src/checkpoint.js';
import type { ValidationReport } from '../src/validation.js';
import { isArray, isDict } from '../src/types.js';
import { controlDocument } from './helpers/control-fixtures.js';
import { buildMultiPageTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';

const cases = [
  { name: 'Validate', sync: (d: Document, o?: OperationControlOptions) => d.Validate(o), async: (d: Document, o?: OperationControlOptions) => d.ValidateAsync(o) },
  { name: 'ValidatePdfA', sync: (d: Document, o?: OperationControlOptions) => d.ValidatePdfA('2a', o), async: (d: Document, o?: OperationControlOptions) => d.ValidatePdfAAsync('2a', o) },
  { name: 'ValidatePdfUa', sync: (d: Document, o?: OperationControlOptions) => d.ValidatePdfUa(2, o), async: (d: Document, o?: OperationControlOptions) => d.ValidatePdfUaAsync(2, o) },
  { name: 'ValidatePdfX', sync: (d: Document, o?: OperationControlOptions) => d.ValidatePdfX('4', o), async: (d: Document, o?: OperationControlOptions) => d.ValidatePdfXAsync('4', o) },
];
const rules = (r: ValidationReport) => r.Issues.map((i) => [i.rule, i.severity, i.message, i.clause]);

describe('cooperative validators', () => {
  for (const c of cases) {
    it(`${c.name} preserves issue order, bytes, and the outer operation name`, async () => {
      const doc = Document.Open(buildMultiPageTaggedPdf()), before = doc.Save(), events: OperationProgress[] = [];
      const expected = rules(c.sync(doc));
      expect(rules(await c.async(doc, { onProgress: (e) => events.push(e) }))).toEqual(expected);
      expect(doc.Save()).toEqual(before);
      expect(events.length).toBeGreaterThan(0);
      expect(new Set(events.map((e) => e.operation))).toEqual(new Set([c.name]));
    });

    it(`${c.name} propagates pre-abort and callback errors`, async () => {
      const doc = Document.Open(buildMultiPageTaggedPdf()), reason = new Error('stop');
      expect(() => c.sync(doc, { signal: AbortSignal.abort(reason) })).toThrow(reason);
      await expect(c.async(doc, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
      expect(() => c.sync(doc, { onProgress: () => { throw 'callback'; } })).toThrow('callback');
    });

    it(`${c.name} cancels during a yield before the next rule/node`, async () => {
      const doc = Document.Open(buildMultiPageTaggedPdf()), controller = new AbortController(), reason = new Error('yield');
      const events: OperationProgress[] = [];
      let handle: NodeJS.Immediate | undefined;
      try {
        await expect(c.async(doc, { signal: controller.signal, onProgress: (e) => {
          events.push(e); handle = setImmediate(() => controller.abort(reason));
        } })).rejects.toBe(reason);
        expect(events).toHaveLength(1);
      } finally { if (handle) clearImmediate(handle); }
    });
  }

  it('checks pre-abort on the untagged UA early-return path', async () => {
    const doc = controlDocument(), reason = new Error('untagged');
    expect(doc.ValidatePdfUa().Issues[0].rule).toBe('Tagged');
    await expect(doc.ValidatePdfUaAsync(1, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  });

  it('keeps cycle/shared-node structural diagnostics and Repair behavior', async () => {
    const doc = controlDocument(), pages = doc.resolve(doc.catalog().get('Pages'));
    if (!isDict(pages)) throw new Error('Expected page tree');
    const kids = pages.get('Kids');
    if (!isArray(kids)) throw new Error('Expected kids');
    kids.push(kids[0], doc.catalog().get('Pages')!);
    const expected = rules(doc.Validate());
    expect(expected.filter((r) => r[0] === 'PageTreeShared')).toHaveLength(2);
    expect(rules(await doc.ValidateAsync())).toEqual(expected);
    doc.Repair();
    expect(doc.Validate().Passed).toBe(true);
  });
});
