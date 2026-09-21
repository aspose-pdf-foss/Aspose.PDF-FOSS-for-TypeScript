import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField, type LoadLimitPatch } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { decodeStream } from '../src/filters.js';
import { DecodeBudget, registerStream, RATIO_FLOOR } from '../src/decodebudget.js';
import { lzwEncode, lzwDecode } from '../src/lzw.js';
import { runLengthEncode, runLengthDecode, asciiHexEncode } from '../src/ascii.js';
import { name, isStream, type PdfObject, type PdfStream } from '../src/types.js';
import { buildObjectsPdf, BASE_OBJECTS } from './helpers/build-hostile-pdf.js';

const zeros = (n: number) => new Uint8Array(n);
const deflate = (b: Uint8Array) => new Uint8Array(deflateSync(b));

/** A stream whose payload is `raw`, declared as encoded by `filters` in order. */
function stream(raw: Uint8Array, filters: string[]): PdfStream {
  return {
    kind: 'stream', raw,
    dict: new Map<string, PdfObject>([['Filter', filters.map((f) => name(f))], ['Length', raw.length]]),
  };
}

/** Register `s` under `patch` and return the budget it shares. */
function under(patch: LoadLimitPatch, ...streams: PdfStream[]): DecodeBudget {
  const b = new DecodeBudget(LoadLimits.defaults.with(patch));
  for (const s of streams) registerStream(s, b);
  return b;
}

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('decoded without reaching a limit');
}

function expectLimit(e: ResourceLimitError, field: LimitField): void {
  expect(e.limit).toBe(field);
}

describe('maxDecodedStreamBytes', () => {
  it('refuses one byte over, and admits a stream exactly at the bound', () => {
    const s = stream(deflate(zeros(10_000)), ['FlateDecode']);
    under({ maxDecodedStreamBytes: 9_999 }, s);
    expectLimit(refusal(() => decodeStream(s)), 'maxDecodedStreamBytes');
    under({ maxDecodedStreamBytes: 10_000 }, s);
    expect(decodeStream(s)).toHaveLength(10_000);
  });

  it('STOPS a Flate decode at the bound rather than inflating the whole payload first', () => {
    // zlib's maxOutputLength halts at the cap, so what was produced is at most
    // one byte past it. Inflating first and checking after is the allocation
    // the bound exists to prevent, and it would report the full 8 MiB here.
    const s = stream(deflate(zeros(8 * 1024 * 1024)), ['FlateDecode']);
    under({ maxDecodedStreamBytes: 1000 }, s);
    const e = refusal(() => decodeStream(s));
    expectLimit(e, 'maxDecodedStreamBytes');
    expect(e.reached).toBeLessThanOrEqual(1001);
  });

  it('stops an LZW decode, which accumulates in a loop zlib does not guard', () => {
    const s = stream(lzwEncode(zeros(50_000)), ['LZWDecode']);
    under({ maxDecodedStreamBytes: 10_000 }, s);
    expectLimit(refusal(() => decodeStream(s)), 'maxDecodedStreamBytes');
  });

  it('stops a RunLength decode, whose two bytes expand to 128', () => {
    const s = stream(runLengthEncode(zeros(50_000)), ['RunLengthDecode']);
    under({ maxDecodedStreamBytes: 10_000 }, s);
    expectLimit(refusal(() => decodeStream(s)), 'maxDecodedStreamBytes');
  });

  it('applies to the chain OUTPUT, so an intermediate stage is bounded too', () => {
    const s = stream(asciiHexEncode(deflate(zeros(20_000))), ['ASCIIHexDecode', 'FlateDecode']);
    under({ maxDecodedStreamBytes: 10_000 }, s);
    expectLimit(refusal(() => decodeStream(s)), 'maxDecodedStreamBytes');
  });
});

describe('the loop decoders stop, rather than finishing and being checked', () => {
  // Through decodeStream the check after the stage refuses either way, so only
  // the decoder's own output shows whether it STOPPED — which is the memory
  // bound, since both accumulate into a number[] of eight-byte slots.
  it('LZW returns at most one table entry past the cap', () => {
    const out = lzwDecode(lzwEncode(zeros(200_000)), 1, 10_000);
    expect(out.length).toBeGreaterThan(10_000);
    expect(out.length).toBeLessThanOrEqual(10_000 + 4096);
  });

  it('RunLength returns at most one run past the cap', () => {
    const out = runLengthDecode(runLengthEncode(zeros(200_000)), 10_000);
    expect(out.length).toBeGreaterThan(10_000);
    expect(out.length).toBeLessThanOrEqual(10_000 + 128);
  });
});

describe('maxExpansionRatio', () => {
  it('refuses a nested zip bomb under the DEFAULTS, stopping at the cap', () => {
    // The acceptance input: 64 MiB of zeros deflated twice is a few hundred
    // bytes. One Flate layer cannot pass DEFLATE's own ~1032:1, which is why
    // the default ratio sits above it — the chain is what makes the bomb.
    const inner = deflate(zeros(64 * 1024 * 1024));
    const bomb = deflate(inner);
    const s = stream(bomb, ['FlateDecode', 'FlateDecode']);
    under({}, s);
    const e = refusal(() => decodeStream(s));
    expectLimit(e, 'maxExpansionRatio');
    expect(e.allowed).toBe(LoadLimits.defaults.maxExpansionRatio);
    // Stopped at the cap: for an input this small the cap is the ratio FLOOR, so
    // at most a mebibyte and one byte came out — not the 64 MiB inside.
    expect(e.reached).toBeLessThanOrEqual(Math.ceil((RATIO_FLOOR + 1) / bomb.length));
  });

  it('does not apply below the floor, where a tiny stream legitimately expands far past it', () => {
    // A blank scanline or an empty object stream: a handful of bytes decoding
    // to kilobytes. Measured 100 KiB of zeros deflating to ~100 bytes, a ratio
    // near 1000 at this size — and far higher for a tiny one.
    const raw = deflate(zeros(RATIO_FLOOR));
    const s = stream(raw, ['FlateDecode']);
    under({ maxExpansionRatio: 2 }, s);
    expect(decodeStream(s)).toHaveLength(RATIO_FLOOR);
  });

  it('applies above the floor, measured against the ENCODED input of the whole chain', () => {
    const s = stream(deflate(zeros(RATIO_FLOOR + 1)), ['FlateDecode']);
    under({ maxExpansionRatio: 2 }, s);
    expectLimit(refusal(() => decodeStream(s)), 'maxExpansionRatio');
  });
});

describe('maxFilterChain', () => {
  const hexChain = (n: number) => {
    let bytes: Uint8Array = new TextEncoder().encode('payload');
    for (let i = 0; i < n; i++) bytes = asciiHexEncode(bytes);
    return stream(bytes, Array(n).fill('ASCIIHexDecode'));
  };

  it('refuses a chain one filter over the default of 8, and admits one at it', () => {
    const nine = hexChain(9);
    under({}, nine);
    expectLimit(refusal(() => decodeStream(nine)), 'maxFilterChain');
    const eight = hexChain(8);
    under({}, eight);
    expect(new TextDecoder().decode(decodeStream(eight))).toBe('payload');
  });
});

describe('maxTotalDecodedBytes', () => {
  it('is shared across one document, so many streams cannot do what one may not', () => {
    const a = stream(deflate(zeros(6_000)), ['FlateDecode']);
    const b = stream(deflate(zeros(6_000)), ['FlateDecode']);
    under({ maxTotalDecodedBytes: 10_000 }, a, b);
    expect(decodeStream(a)).toHaveLength(6_000);
    expectLimit(refusal(() => decodeStream(b)), 'maxTotalDecodedBytes');
  });

  it('charges each DISTINCT stream once, so decoding the same page twice is free', () => {
    // A lifetime total would refuse a long-lived document that renders its
    // pages repeatedly; the attack is many streams, not one stream read again.
    const a = stream(deflate(zeros(6_000)), ['FlateDecode']);
    const budget = under({ maxTotalDecodedBytes: 10_000 }, a);
    for (let i = 0; i < 5; i++) decodeStream(a);
    expect(budget.decoded).toBe(6_000);
  });

  it('is NOT shared between documents', () => {
    const a = stream(deflate(zeros(6_000)), ['FlateDecode']);
    const b = stream(deflate(zeros(6_000)), ['FlateDecode']);
    under({ maxTotalDecodedBytes: 10_000 }, a);
    under({ maxTotalDecodedBytes: 10_000 }, b);
    decodeStream(a);
    expect(decodeStream(b)).toHaveLength(6_000);
  });
});

describe('maxSalvageProbes', () => {
  it('bounds inflateSalvage\'s search for a prefix that still decodes', () => {
    // Text rather than zeros: a flipped byte inside a run of zeros usually still
    // inflates, so the salvage search never starts. Verified to fail whole.
    let text = '';
    for (let i = 0; i < 5000; i++) text += `line ${(i * 7919) % 10007} of text ${i}\n`;
    const bad = deflate(new TextEncoder().encode(text));
    for (let i = 0; i < 16; i++) bad[Math.floor(bad.length / 2) + i] = 0xff;
    const s = stream(bad, ['FlateDecode']);
    under({ maxSalvageProbes: 1 }, s);
    expectLimit(refusal(() => decodeStream(s, { partial: true })), 'maxSalvageProbes');
    under({}, s);
    expect(() => decodeStream(s, { partial: true })).not.toThrow();
  });

  it('refuses a salvage probe that reaches the output cap, rather than trying a shorter prefix', () => {
    // Read as "does not decode", a capped probe steers the binary search toward a
    // SHORTER prefix and hands back a truncated stream where the answer is a
    // refusal — a damaged bomb would open as a quietly smaller one.
    const bad = deflate(zeros(200_000));
    bad[bad.length - 3] ^= 0xff;              // damage the trailer only
    const s = stream(bad, ['FlateDecode']);
    under({ maxDecodedStreamBytes: 10_000 }, s);
    expectLimit(refusal(() => decodeStream(s, { partial: true })), 'maxDecodedStreamBytes');
  });
});

describe('registration', () => {

  it('ties every stream a parsed document holds to that document\'s policy', () => {
    const hex = new TextDecoder('latin1').decode(asciiHexEncode(deflate(zeros(10_000))));
    const buf = buildObjectsPdf([...BASE_OBJECTS,
      `<< /Filter [/ASCIIHexDecode /FlateDecode] /Length ${hex.length} >>\nstream\n${hex}\nendstream`]);
    const doc = Document.Open(buf, { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: 9_999 }) });
    const s = doc.getObject(4);
    expect(isStream(s)).toBe(true);
    expectLimit(refusal(() => decodeStream(s as PdfStream)), 'maxDecodedStreamBytes');
    const open = Document.Open(buf);
    expect(decodeStream(open.getObject(4) as PdfStream)).toHaveLength(10_000);
  });

  it('ties a stream ALLOCATED into a document to that document\'s policy', () => {
    const buf = buildObjectsPdf(BASE_OBJECTS);
    const doc = Document.Open(buf, { limits: LoadLimits.defaults.with({ maxDecodedStreamBytes: 9_999 }) });
    const s = stream(deflate(zeros(10_000)), ['FlateDecode']);
    doc.allocObject(s);
    expectLimit(refusal(() => decodeStream(s)), 'maxDecodedStreamBytes');
  });
});
