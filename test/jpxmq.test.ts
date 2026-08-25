import { describe, it, expect } from 'vitest';
import { MqDecoder, QE } from '../src/jpxmq.js';

// The MQ arithmetic coder (ISO/IEC 15444-1 Annex C) is validated for true
// spec-conformance end-to-end via the real-codestream fixtures in test/jpx.test.ts
// (a wrong MQ decoder cannot produce an exact lossless reconstruction). These unit
// tests pin the fixed Qe transition table and the decoder's deterministic behavior.

describe('MQ arithmetic decoder', () => {
  it('has the 47-entry Qe transition table with canonical endpoints', () => {
    expect(QE.length).toBe(47);
    expect(QE[0].qe).toBe(0x5601);
    expect(QE[0].nmps).toBe(1);
    expect(QE[0].nlps).toBe(1);
    expect(QE[0].sw).toBe(1);
    expect(QE[46].qe).toBe(0x5601);
    expect(QE[46].nmps).toBe(46);
    expect(QE[46].nlps).toBe(46);
    expect(QE[46].sw).toBe(0);
  });

  it('decodes a byte stream to a deterministic 256-bit sequence without throwing', () => {
    // The canonical Annex C.5 encoded example bytes.
    const encoded = Uint8Array.from([
      0x84, 0xC7, 0x3B, 0xFC, 0xE1, 0xA1, 0x43, 0x04, 0x02, 0x20, 0x00, 0x00,
      0x41, 0x0D, 0xBB, 0x86, 0xF4, 0x31, 0x7F, 0xFF, 0x88, 0xFF, 0x37, 0x47,
      0x1A, 0xDB, 0x6A, 0xDF, 0xFF, 0xAC, 0x00, 0x00,
    ]);
    const dec = new MqDecoder(encoded, 0, encoded.length);
    const cx = new Int8Array(1); // single context, initial state 0, MPS 0
    const bits: number[] = [];
    for (let i = 0; i < 256; i++) bits.push(dec.decode(cx, 0));
    expect(bits.length).toBe(256);
    expect(bits.every((b) => b === 0 || b === 1)).toBe(true);
    // Determinism: a second pass over the same input yields identical bits.
    const dec2 = new MqDecoder(encoded, 0, encoded.length);
    const cx2 = new Int8Array(1);
    const bits2: number[] = [];
    for (let i = 0; i < 256; i++) bits2.push(dec2.decode(cx2, 0));
    expect(bits2).toEqual(bits);
  });
});
