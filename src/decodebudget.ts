/** What decoding one document's streams may cost (`ibzo.3`).
 *
 *  **Invariant, and it is the whole plumbing decision:** a stream finds its
 *  document's policy through a REGISTRY rather than an argument. About ninety
 *  call sites decode a stream, most of them pure modules that were handed an
 *  `inflate` callback and never see a `Document`; threading a policy through
 *  every one of those signatures is a diff where a missed site fails silently.
 *  `Document` registers every stream it holds — parsed, allocated or replaced —
 *  and `filters.ts` looks the stream up. A stream nobody registered (one this
 *  library built in passing, an inline image's synthetic stream) is decoded
 *  under {@link LoadLimits.defaults} with no running total, which is bounded
 *  and never refuses more than the defaults would.
 *
 *  **Invariant:** the running total counts each DISTINCT stream once, the first
 *  time it decodes. A lifetime total would refuse a long-lived document that
 *  renders its pages twice; per stream, it bounds what one FILE can make us
 *  decompress, which is the attack — many small streams doing what one large
 *  one may not.
 *
 *  **Invariant:** the expansion ratio applies only past {@link RATIO_FLOOR}. A
 *  Flate stream holding a blank scanline or an empty object stream is a few
 *  bytes decoding to kilobytes, legitimately and far past any ratio, so a ratio
 *  bound with no floor refuses ordinary files; a stream that decodes to under a
 *  mebibyte cannot be a bomb whatever its ratio.
 *
 *  A leaf over `loadlimits.js` and `types.js`'s TYPES, so every rule is drivable
 *  from plain numbers. */
import type { PdfStream } from './types.js';
import { LoadLimits, type LimitField } from './loadlimits.js';

/** Output below which the expansion ratio is not applied. */
export const RATIO_FLOOR = 1024 * 1024;

export class DecodeBudget {
  private total = 0;
  private readonly counted = new WeakSet<PdfStream>();

  constructor(readonly limits: LoadLimits) {}

  /** The most bytes one decode of `encoded` input may produce before a bound
   *  is reached, and the bound that sets it. A decoder that can stop early —
   *  zlib's `maxOutputLength`, the LZW and RunLength loops — stops ONE byte
   *  past this, so `check` sees the overshoot and names the bound. */
  cap(encoded: number, stream?: PdfStream, contentSoFar?: number): { bytes: number; field: LimitField } {
    const l = this.limits;
    let best: { bytes: number; field: LimitField } = { bytes: Infinity, field: 'maxDecodedStreamBytes' };
    const offer = (bytes: number | null, field: LimitField) => {
      if (bytes !== null && bytes < best.bytes) best = { bytes, field };
    };
    offer(l.maxDecodedStreamBytes, 'maxDecodedStreamBytes');
    if (l.maxExpansionRatio !== null)
      offer(Math.max(RATIO_FLOOR, l.maxExpansionRatio * Math.max(1, encoded)), 'maxExpansionRatio');
    if (l.maxTotalDecodedBytes !== null && !(stream && this.counted.has(stream)))
      offer(Math.max(0, l.maxTotalDecodedBytes - this.total), 'maxTotalDecodedBytes');
    if (contentSoFar !== undefined && l.maxContentBytes !== null)
      offer(Math.max(0, l.maxContentBytes - contentSoFar), 'maxContentBytes');
    return best;
  }

  /** Refuse `bytes` of output from `encoded` bytes of input, naming the bound.
   *  Each bound reports in its OWN unit — the ratio as a ratio, the total as the
   *  total — so `ResourceLimitError.reached` is comparable to `allowed`. */
  check(bytes: number, encoded: number, stream?: PdfStream, what = 'stream', contentSoFar?: number): void {
    const l = this.limits;
    if (contentSoFar !== undefined) l.enforce('maxContentBytes', contentSoFar + bytes, 'page content');
    l.enforce('maxDecodedStreamBytes', bytes, what);
    if (bytes > RATIO_FLOOR) l.enforce('maxExpansionRatio', Math.ceil(bytes / Math.max(1, encoded)), what);
    if (!(stream && this.counted.has(stream))) l.enforce('maxTotalDecodedBytes', this.total + bytes, what);
  }

  /** Charge a stream's decoded size to the running total, once per stream. */
  charge(stream: PdfStream, bytes: number): void {
    if (this.counted.has(stream)) return;
    this.counted.add(stream);
    this.total += bytes;
  }

  /** Charge bytes that belong to no `PdfStream` — one decode of an input FILE
   *  that is not a PDF (`inflatebound.ts`, `ibzo.11`). Every call counts: such
   *  a decode has no identity to be charged once by. */
  chargeBytes(bytes: number): void { this.total += bytes; }

  /** Bytes charged so far. */
  get decoded(): number { return this.total; }
}

const registry = new WeakMap<PdfStream, DecodeBudget>();

/** Tie `stream` to a document's budget. Re-registering moves it. */
export function registerStream(stream: PdfStream, budget: DecodeBudget): void {
  registry.set(stream, budget);
}

/** The budget `stream` decodes under: its document's, else a fresh default one
 *  that carries no running total. */
export function budgetFor(stream: PdfStream): DecodeBudget {
  return registry.get(stream) ?? new DecodeBudget(LoadLimits.defaults);
}
