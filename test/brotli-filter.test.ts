import { describe, it, expect } from 'vitest';
import { brotliDecompressSync } from 'node:zlib';
import { decodeStream, encodeStream, applyDecodeFilters } from '../src/filters.js';
import { ascii85Encode } from '../src/ascii.js';
import { DecodeBudget, registerStream, RATIO_FLOOR } from '../src/decodebudget.js';
import { LoadLimits, type LoadLimitPatch } from '../src/loadlimits.js';
import { ResourceLimitError, UnsupportedFeatureError } from '../src/errors.js';
import { name, type PdfObject, type PdfStream } from '../src/types.js';
import { buildBrotliStream } from './helpers/build-brotli-stream.js';

const bytes = (s: string) => new TextEncoder().encode(s);
function under(patch: LoadLimitPatch, ...streams: PdfStream[]): DecodeBudget {
  const budget = new DecodeBudget(LoadLimits.defaults.with(patch));
  for (const s of streams) registerStream(s, budget);
  return budget;
}
function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('expected a load-limit refusal');
}

describe('Brotli byte filter', () => {
  it('decodes Node-authored bytes, including empty streams', () => {
    for (const data of [bytes('BT (Brotli content) Tj ET'), new Uint8Array()])
      expect(decodeStream(buildBrotliStream(data))).toEqual(data);
  });

  it.each([
    [2, [10, 10, 10, 10]],
    [12, [1, 10, 10, 10, 10]],
  ])('applies predictor %i after Brotli, aligned in an ASCII85 chain', (predictor, encoded) => {
    const parms = new Map<string, PdfObject>([
      ['Predictor', predictor], ['Columns', 4], ['Colors', 1], ['BitsPerComponent', 8],
    ]);
    const inner = buildBrotliStream(Uint8Array.from(encoded), parms);
    const s: PdfStream = { kind: 'stream', raw: ascii85Encode(inner.raw), dict: new Map<string, PdfObject>([
      ['Filter', [name('ASCII85Decode'), name('BrotliDecode')]],
      ['DecodeParms', [null, parms]],
    ]) };
    expect(decodeStream(s)).toEqual(Uint8Array.from([10, 20, 30, 40]));
  });

  it('leaves an image codec terminal after decoding the Brotli prefix', () => {
    const s = buildBrotliStream(Uint8Array.from([255, 216, 255, 217]));
    expect(applyDecodeFilters(s.raw, ['BrotliDecode', 'DCTDecode'], [])).toEqual({
      bytes: Uint8Array.from([255, 216, 255, 217]), terminal: { name: 'DCTDecode', parms: undefined },
    });
  });

  it('produces standard Brotli bytes when explicitly encoded', () => {
    const data = bytes('Explicit encoding '.repeat(100));
    const s = encodeStream(data, 'BrotliDecode');
    expect(new Uint8Array(brotliDecompressSync(s.raw))).toEqual(data);
    expect(s.dict.get('Filter')).toEqual(name('BrotliDecode'));
    expect(s.dict.get('Length')).toBe(s.raw.length);
  });

  it('rejects corrupt and truncated payloads even with Flate salvage enabled', () => {
    const s = buildBrotliStream(bytes('Brotli truncation '.repeat(200)));
    for (const raw of [Uint8Array.from([255, 255]), s.raw.subarray(0, s.raw.length - 2)]) {
      for (const partial of [false, true]) {
        expect(() => decodeStream({ ...s, raw }, { partial })).toThrow();
        expect(() => decodeStream({ ...s, raw }, { partial })).not.toThrow(UnsupportedFeatureError);
      }
    }
  });
});

describe('Brotli LoadLimits', () => {
  it('admits exactly the decoded-byte bound and refuses one byte over', () => {
    const s = buildBrotliStream(new Uint8Array(10_000));
    under({ maxDecodedStreamBytes: 10_000 }, s);
    expect(decodeStream(s)).toHaveLength(10_000);
    under({ maxDecodedStreamBytes: 9_999 }, s);
    expect(refusal(() => decodeStream(s)).limit).toBe('maxDecodedStreamBytes');
  });

  it('stops inside Brotli rather than allocating the whole expanded stream', () => {
    const s = buildBrotliStream(new Uint8Array(8 * 1024 * 1024));
    under({ maxDecodedStreamBytes: 1000 }, s);
    const e = refusal(() => decodeStream(s));
    expect(e.limit).toBe('maxDecodedStreamBytes');
    expect(e.reached).toBe(1001);
  });

  it('bounds expansion against the original input across nested Brotli layers', () => {
    const inner = buildBrotliStream(new Uint8Array(RATIO_FLOOR + 100));
    const outer = buildBrotliStream(inner.raw);
    outer.dict.set('Filter', [name('BrotliDecode'), name('BrotliDecode')]);
    under({ maxExpansionRatio: 2 }, outer);
    const e = refusal(() => decodeStream(outer));
    expect(e.limit).toBe('maxExpansionRatio');
    expect(e.reached).toBe(Math.ceil((RATIO_FLOOR + 1) / outer.raw.length));
  });

  it('charges distinct streams once and refuses when the shared total is exhausted', () => {
    const a = buildBrotliStream(bytes('12345'));
    const b = buildBrotliStream(bytes('x'));
    const empty = buildBrotliStream(new Uint8Array());
    const budget = under({ maxTotalDecodedBytes: 5 }, a, b, empty);
    expect(decodeStream(a)).toEqual(bytes('12345'));
    expect(decodeStream(a)).toEqual(bytes('12345'));
    expect(budget.decoded).toBe(5);
    expect(decodeStream(empty)).toHaveLength(0);
    const e = refusal(() => decodeStream(b));
    expect(e.limit).toBe('maxTotalDecodedBytes');
    expect(e.reached).toBe(6);
  });

  it('caps page content inside the decoder, including an exhausted budget', () => {
    const s = buildBrotliStream(new Uint8Array(10_000));
    under({ maxContentBytes: 100 }, s);
    const e = refusal(() => decodeStream(s, { contentSoFar: 99 }));
    expect(e.limit).toBe('maxContentBytes');
    expect(e.reached).toBe(101);
    expect(refusal(() => decodeStream(s, { contentSoFar: 100 })).limit).toBe('maxContentBytes');
  });

  it('accepts explicitly unlimited decoding', () => {
    const s = buildBrotliStream(new Uint8Array(RATIO_FLOOR + 1));
    registerStream(s, new DecodeBudget(LoadLimits.unlimited()));
    expect(decodeStream(s)).toHaveLength(RATIO_FLOOR + 1);
  });
});
