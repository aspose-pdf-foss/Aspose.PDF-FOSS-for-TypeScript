import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { inflateStream } from '../src/flate.js';
import type { PdfDict, PdfStream, PdfObject } from '../src/types.js';
import { name } from '../src/types.js';

describe('inflateStream', () => {
  it('inflates FlateDecode without predictor', () => {
    const raw = deflateSync(Buffer.from('hello world'));
    const dict: PdfDict = new Map([['Filter', name('FlateDecode')]]);
    const out = inflateStream({ kind: 'stream', dict, raw: new Uint8Array(raw) });
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });
});

function flateStream(raw: Uint8Array): PdfStream {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('FlateDecode')], ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}

describe('partial inflate', () => {
  // Deliberately hard to compress: a run of one byte deflates to so little that
  // cutting the tail removes only the checksum, and the whole payload still
  // decodes — which would make the assertion below vacuous.
  const source = Uint8Array.from({ length: 600 }, (_, i) => (i * 37) % 251);

  it('returns the prefix of a payload cut short', () => {
    const full = new Uint8Array(deflateSync(Buffer.from(source)));
    const cut = flateStream(full.subarray(0, Math.floor(full.length * 0.6)));

    expect(() => inflateStream(cut)).toThrow();
    const partial = inflateStream(cut, { partial: true });
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(source.length);
    // What did come out is correct, not merely present.
    expect(partial).toEqual(source.subarray(0, partial.length));
  });

  it('decodes an undamaged payload identically with and without the option', () => {
    const s = flateStream(new Uint8Array(deflateSync(Buffer.from(source))));
    expect(inflateStream(s, { partial: true })).toEqual(inflateStream(s));
    expect(inflateStream(s)).toEqual(source);
  });

  it('recovers the data ahead of bytes that were altered in place', () => {
    // Distinct from truncation, and not covered by Z_SYNC_FLUSH alone: zlib
    // reports a truncation as Z_BUF_ERROR and hands back what it produced, but
    // an invalid symbol is Z_DATA_ERROR and throws with nothing at all. Without
    // the prefix search, damage anywhere costs the entire stream.
    const full = new Uint8Array(deflateSync(Buffer.from(source)));
    const rotted = Uint8Array.from(full);
    rotted.fill(0x5a, Math.floor(full.length * 0.75));

    expect(() => inflateStream(flateStream(rotted))).toThrow();
    const partial = inflateStream(flateStream(rotted), { partial: true });

    // The data ahead of the damage comes back correct. The tail deliberately is
    // NOT asserted: altered bytes often still form valid DEFLATE symbols, so a
    // prefix reaching past the damage decodes to something arbitrary. That is
    // the documented limit of the salvage, and why every consumer validates what
    // it parses out — see decodeObjStm's per-object try.
    expect(partial.length).toBeGreaterThan(150);
    expect(partial.subarray(0, 150)).toEqual(source.subarray(0, 150));
  });

  it('gives back nothing rather than throwing when no prefix decodes', () => {
    const notDeflate = flateStream(Uint8Array.from({ length: 40 }, () => 0x5a));
    expect(inflateStream(notDeflate, { partial: true }).length).toBe(0);
  });
});
