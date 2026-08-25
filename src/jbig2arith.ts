// JBIG2 arithmetic integer decoding — ITU-T T.88 Annex A, over the shared MQ
// decoder (src/jpxmq.ts; JBIG2's arithmetic coder is the same MQ coder as
// JPEG 2000's). Each procedure owns a context array packed as `index<<1 | mps`.
import type { MqDecoder } from './jpxmq.js';

/** Context for one IAx integer procedure (T.88 A.2). 512 states (PREV in 1..511). */
export class IntCtx { readonly cx = new Int8Array(512); }

/** IAx integer arithmetic decoding procedure (T.88 A.2). Returns null for OOB. */
export function decodeInt(mq: MqDecoder, ctx: IntCtx): number | null {
  const cx = ctx.cx;
  let prev = 1;
  const bit = (): number => {
    const d = mq.decode(cx, prev);
    prev = prev < 256 ? (prev << 1) | d : ((((prev << 1) | d) & 511) | 256);
    return d;
  };
  const s = bit();
  let n: number, offset: number;
  if (!bit()) { n = 2; offset = 0; }
  else if (!bit()) { n = 4; offset = 4; }
  else if (!bit()) { n = 6; offset = 20; }
  else if (!bit()) { n = 8; offset = 84; }
  else if (!bit()) { n = 12; offset = 340; }
  else { n = 16; offset = 4436; }
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | bit();
  v = (v >>> 0) + offset;
  if (s === 0) return v;
  if (v > 0) return -v;
  return null; // S==1 && V==0 -> OOB (out-of-band)
}

/** Context for the IAID symbol-ID decoder (T.88 A.3), sized to the code length. */
export class IaidCtx {
  readonly cx: Int8Array;
  constructor(symCodeLen: number) { this.cx = new Int8Array(1 << (symCodeLen + 1)); }
}

/** IAID symbol-ID arithmetic decoding (T.88 A.3). */
export function decodeIaid(mq: MqDecoder, ctx: IaidCtx, symCodeLen: number): number {
  let prev = 1;
  for (let i = 0; i < symCodeLen; i++) { const d = mq.decode(ctx.cx, prev); prev = (prev << 1) | d; }
  return prev - (1 << symCodeLen);
}

// `TextIntCtx` used to live here — the bundle of contexts a text region needs.
// `ArithIntSource` in jbig2ints.ts supersedes it: that class holds the same
// contexts plus the symbol dictionary's, behind the `IntSource` interface the
// Huffman implementation also satisfies. Keeping both would leave two answers
// to "which contexts does an aggregate text region share with its dictionary".
