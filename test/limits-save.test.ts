import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { LoadLimits, type LoadLimitPatch } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { planDocument, type SerializeOptions } from '../src/serializer.js';
import { DecodeBudget, registerStream, budgetFor } from '../src/decodebudget.js';
import { decodeStream } from '../src/filters.js';
import { isStream, type PdfObject, type PdfStream } from '../src/types.js';
import { buildSaveBudgetPdf } from './helpers/build-save-budget-pdf.js';

const targets = ['LZWDecode', 'RunLengthDecode', 'BrotliDecode'] as const;
const data = (n: number) => new Uint8Array(n).fill(32);
const open = (sizes: number[], patch: LoadLimitPatch = {}, chain: 'flate' | 'nested' | 'hex' = 'flate') =>
  Document.Open(buildSaveBudgetPdf(sizes.map(data), chain), { limits: LoadLimits.defaults.with(patch) });
function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('expected a load-limit refusal');
}
function source(doc: Document): PdfStream {
  const s = doc.getObject(4);
  if (!isStream(s)) throw new Error('fixture has no content stream');
  return s;
}
function copied(doc: Document): PdfStream {
  const objects = new Map([...doc.objectEntries()].map(([r, o]) => [r.num, o]));
  const plan = planDocument(objects, new Map<string, PdfObject>([['Root', { kind: 'ref', num: 1, gen: 0 }]]));
  const s = plan.objs.find(isStream);
  if (!s) throw new Error('plan has no stream');
  return s;
}

describe.each(targets)('Save({ streamFilter: %s }) decode policy', (streamFilter) => {
  it('refuses the caller\'s per-stream limit during decode, admitting its exact bound', () => {
    const e = refusal(() => open([101], { maxDecodedStreamBytes: 100 }).Save({ streamFilter }));
    expect(e.limit).toBe('maxDecodedStreamBytes');
    expect(e.reached).toBe(101);
    const doc = open([100], { maxDecodedStreamBytes: 100 });
    const original = source(doc);
    const raw = original.raw.slice();
    const out = Document.Open(doc.Save({ streamFilter }));
    expect(decodeStream(source(out))).toEqual(data(100));
    expect(original.raw).toEqual(raw);
    expect(doc.getObject(4)).toBe(original);
  });

  it('preserves a lowered expansion ratio', () => {
    const e = refusal(() => open([1024 * 1024 + 100], { maxExpansionRatio: 2 }).Save({ streamFilter }));
    expect(e.limit).toBe('maxExpansionRatio');
  });

  it('preserves the chain-length limit', () => {
    const e = refusal(() => open([10], { maxFilterChain: 1 }, 'hex').Save({ streamFilter }));
    expect(e.limit).toBe('maxFilterChain');
  });

  it('enforces a shared total across distinct streams with identical payloads', () => {
    const doc = open([6, 6], { maxTotalDecodedBytes: 10 });
    const e = refusal(() => doc.Save({ streamFilter }));
    expect(e.limit).toBe('maxTotalDecodedBytes');
    expect(e.reached).toBe(11);
    expect(doc.decodeBudget.decoded).toBe(6);
  });

  it.each([false, true])('charges each source only once across repeated saves (read first=%s)', (readFirst) => {
    const doc = open([6, 4], { maxTotalDecodedBytes: 10 });
    if (readFirst) for (const [, s] of doc.objectEntries()) if (isStream(s)) decodeStream(s);
    for (let i = 0; i < 3; i++) {
      expect(() => doc.Save({ streamFilter })).not.toThrow();
      expect(doc.decodeBudget.decoded).toBe(10);
    }
    expect(decodeStream(source(doc))).toEqual(data(6));
    expect(doc.decodeBudget.decoded).toBe(10);
  });

  it('honors unlimited policy for an expansion refused by the defaults', () => {
    const input = buildSaveBudgetPdf([data(2 * 1024 * 1024)], 'nested');
    const doc = Document.Open(input, { limits: LoadLimits.unlimited() });
    expect(doc.Save({ streamFilter }).length).toBeGreaterThan(0);
    expect(doc.decodeBudget.decoded).toBe(2 * 1024 * 1024);
  });
});

describe('write-plan accounting identity', () => {
  it('applies to copied streams before either source or copy has decoded', () => {
    const doc = open([6], { maxTotalDecodedBytes: 6 });
    const copy = copied(doc);
    expect(copy).not.toBe(source(doc));
    expect(budgetFor(copy)).toBe(doc.decodeBudget);
    expect(decodeStream(copy)).toEqual(data(6));
    expect(decodeStream(source(doc))).toEqual(data(6));
    expect(doc.decodeBudget.decoded).toBe(6);
  });

  it('preserves a single disabled limit without resetting the other limits', () => {
    const doc = open([2 * 1024 * 1024], { maxExpansionRatio: null }, 'nested');
    expect(doc.Save({ streamFilter: 'RunLengthDecode' }).length).toBeGreaterThan(0);
    expect(doc.decodeBudget.decoded).toBe(2 * 1024 * 1024);
  });

  it('starts distinct accounting when a copy is registered to another budget', () => {
    const doc = open([6], { maxTotalDecodedBytes: 6 });
    const copy = copied(doc);
    decodeStream(copy);
    const next = new DecodeBudget(LoadLimits.defaults.with({ maxTotalDecodedBytes: 6 }));
    registerStream(copy, next);
    expect(decodeStream(copy)).toEqual(data(6));
    expect(next.decoded).toBe(6);
    expect(doc.decodeBudget.decoded).toBe(6);
    expect(decodeStream(source(doc))).toEqual(data(6));
  });

  it('retains default policy for unregistered input streams', () => {
    const doc = open([6]);
    const original = source(doc);
    const unregistered: PdfStream = { ...original, dict: new Map(original.dict) };
    const objects = new Map([...doc.objectEntries()].map(([r, o]) => [r.num, o]));
    objects.set(4, unregistered);
    const plan = planDocument(objects, new Map<string, PdfObject>([['Root', { kind: 'ref', num: 1, gen: 0 }]]));
    const copy = plan.objs.find(isStream)!;
    expect(budgetFor(copy).limits).toBe(LoadLimits.defaults);
    expect(decodeStream(copy)).toEqual(data(6));
    expect(doc.decodeBudget.decoded).toBe(0);
  });
});

describe('save variants', () => {
  it.each<SerializeOptions>([
    {}, { compressed: true }, { encrypt: { userPassword: 'u' } },
    { compressed: true, encrypt: { userPassword: 'u' } },
  ])('retains the decode policy with writer options %j', (options) => {
    const e = refusal(() => open([101], { maxDecodedStreamBytes: 100 })
      .Save({ ...options, streamFilter: 'RunLengthDecode' }));
    expect(e.limit).toBe('maxDecodedStreamBytes');
  });

  it('enforces limits in SaveAsync and shares totals with synchronous Save', async () => {
    await expect(open([101], { maxDecodedStreamBytes: 100 }).SaveAsync({ streamFilter: 'LZWDecode' }))
      .rejects.toMatchObject({ limit: 'maxDecodedStreamBytes' });
    const doc = open([6], { maxTotalDecodedBytes: 6 });
    await doc.SaveAsync({ streamFilter: 'RunLengthDecode' });
    expect(doc.decodeBudget.decoded).toBe(6);
    expect(() => doc.Save({ streamFilter: 'BrotliDecode' })).not.toThrow();
    expect(decodeStream(source(doc))).toEqual(data(6));
    expect(doc.decodeBudget.decoded).toBe(6);
  });
});
