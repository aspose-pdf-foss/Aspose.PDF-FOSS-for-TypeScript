import { describe, it, expect } from 'vitest';
import { ArithDecoder } from '../src/jpegarith.js';
import { ArithEncoder } from './helpers/build-jpeg-arith.js';

describe('QM arithmetic coder', () => {
  it('round-trips a pseudo-random decision sequence through one adaptive context', () => {
    // Deterministic LCG bit source.
    let seed = 0x12345;
    const nextBit = (): 0 | 1 => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return ((seed >> 16) & 1) as 0 | 1; };
    const bits: (0 | 1)[] = []; for (let i = 0; i < 5000; i++) bits.push(nextBit());

    const enc = new ArithEncoder();
    const est = new Uint8Array(1); // single adaptive context bin
    for (const b of bits) enc.encode(est, 0, b);
    const bytes = Uint8Array.from(enc.finish());

    const dec = new ArithDecoder(bytes, 0);
    const dst = new Uint8Array(1);
    for (let i = 0; i < bits.length; i++) expect(dec.decode(dst, 0)).toBe(bits[i]);
  });

  it('round-trips a biased (mostly-zero) sequence', () => {
    let seed = 0x9e3779b1;
    const bits: (0 | 1)[] = [];
    for (let i = 0; i < 4000; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; bits.push((((seed >> 20) % 8) === 0 ? 1 : 0) as 0 | 1); }
    const enc = new ArithEncoder();
    const est = new Uint8Array(1);
    for (const b of bits) enc.encode(est, 0, b);
    const bytes = Uint8Array.from(enc.finish());
    const dec = new ArithDecoder(bytes, 0);
    const dst = new Uint8Array(1);
    for (let i = 0; i < bits.length; i++) expect(dec.decode(dst, 0)).toBe(bits[i]);
  });
});
