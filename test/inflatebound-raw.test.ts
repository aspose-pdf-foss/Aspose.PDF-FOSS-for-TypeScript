import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { InputDecoder } from '../src/inflatebound.js';
import { LoadLimits } from '../src/loadlimits.js';
import { PdfParseError, ResourceLimitError } from '../src/errors.js';

const raw = (b: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(Buffer.from(b)));

describe('InputDecoder.inflateRaw', () => {
  it('decodes raw DEFLATE, which the zlib-wrapped inflate cannot', () => {
    const src = new TextEncoder().encode('hello raw deflate '.repeat(20));
    expect(new InputDecoder().inflateRaw(raw(src), src.length)).toEqual(src);
  });

  it('refuses a declaration past the bounds before inflating anything', () => {
    // Garbage input: if it inflated first, this would be a zlib error instead.
    const d = new InputDecoder(LoadLimits.defaults.with({ maxDecodedStreamBytes: 1000 }));
    expect(() => d.inflateRaw(new Uint8Array([0xff, 0xff, 0xff]), 5000))
      .toThrow(ResourceLimitError);
  });

  it('reads output past a smaller declaration as damage', () => {
    const src = new Uint8Array(10_000);
    expect(() => new InputDecoder().inflateRaw(raw(src), 100)).toThrow(PdfParseError);
  });

  it('lets corrupt data surface as an ordinary error for the caller to wrap', () => {
    let caught: unknown;
    try { new InputDecoder().inflateRaw(new Uint8Array([0xff, 0x00, 0x00]), 10); }
    catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ResourceLimitError);
    expect(caught).not.toBeInstanceOf(PdfParseError);
  });
});

describe('InputDecoder.stored', () => {
  it('returns a copy, not a view of the caller buffer', () => {
    const src = new Uint8Array([1, 2, 3]);
    const out = new InputDecoder().stored(src);
    src[0] = 9;
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('charges the running total like a decode', () => {
    const d = new InputDecoder(LoadLimits.defaults.with({ maxTotalDecodedBytes: 5 }));
    d.stored(new Uint8Array(3));
    expect(() => d.stored(new Uint8Array(3))).toThrow(ResourceLimitError);
  });
});
