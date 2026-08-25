import { describe, it, expect } from 'vitest';
import { MqDecoder } from '../src/jpxmq.js';
import { IntCtx, decodeInt, IaidCtx, decodeIaid } from '../src/jbig2arith.js';
import * as V from './helpers/jbig2-arith-vectors.js';

function decodeAll(bytes: Uint8Array, n: number): (number | null)[] {
  const mq = new MqDecoder(bytes, 0, bytes.length);
  const ctx = new IntCtx();
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) out.push(decodeInt(mq, ctx));
  return out;
}

describe('jbig2 arithmetic integer decoder', () => {
  it('round-trips small signed integers incl. zero', () => {
    expect(decodeAll(V.ints_small.bytes, V.ints_small.values.length)).toEqual(V.ints_small.values);
  });
  it('round-trips values at every range boundary', () => {
    expect(decodeAll(V.ints_ranges.bytes, V.ints_ranges.values.length)).toEqual(V.ints_ranges.values);
  });
  it('decodes the OOB value as null', () => {
    expect(decodeAll(V.ints_oob.bytes, V.ints_oob.values.length)).toEqual(V.ints_oob.values);
  });
  it('decodes symbol IDs (IAID)', () => {
    const mq = new MqDecoder(V.iaid_seq.bytes, 0, V.iaid_seq.bytes.length);
    const ctx = new IaidCtx(V.iaid_seq.symCodeLen);
    const out = V.iaid_seq.values.map(() => decodeIaid(mq, ctx, V.iaid_seq.symCodeLen));
    expect(out).toEqual(V.iaid_seq.values);
  });
});
