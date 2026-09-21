/** Decompression for input files that are NOT PDF — PNG, TIFF, WOFF, WOFF2 —
 *  under the same bounds a PDF stream decodes under (`ibzo.11`).
 *
 *  **Invariant:** the bounds are `DecodeBudget`'s, not new ones. One decode is
 *  capped by `maxDecodedStreamBytes` and, past the 1 MiB floor, by
 *  `maxExpansionRatio`; every decode ONE `InputDecoder` performs is charged to
 *  its `maxTotalDecodedBytes` — so the strips of a TIFF, or the tables of a
 *  WOFF, are bounded together, and a file cannot do in many small blocks what
 *  it may not in one. A second vocabulary would be a second answer to "how much
 *  may this file make us decompress".
 *
 *  **Invariant:** the cap is handed INTO the decoder — zlib and brotli's
 *  `maxOutputLength`, the LZW and RunLength loops — which stops one byte past
 *  it. A check after the decoder returned bounds nothing: the allocation has
 *  happened. A decode reaching the cap is a `ResourceLimitError`, never damage.
 *
 *  **Invariant:** `declared` narrows the cap to what the file's own header says
 *  a block holds, where the format states one (a WOFF table's `origLength`). The
 *  declaration is checked against the bounds FIRST, so a header claiming 2 GiB
 *  is refused before anything is inflated, and output past a SMALLER
 *  declaration is damage — a `PdfParseError` found at the declared length, not
 *  after inflating the bomb behind it.
 *
 *  A leaf over `loadlimits.js`, `decodebudget.js`, `lzw.js`, `ascii.js` and
 *  `errors.js`; it knows no `Document`. */
import { inflateSync, brotliDecompressSync } from 'node:zlib';
import { LoadLimits } from './loadlimits.js';
import { DecodeBudget } from './decodebudget.js';
import { lzwDecode } from './lzw.js';
import { runLengthDecode } from './ascii.js';
import { PdfParseError, rethrowLimit } from './errors.js';

/** Node's code for a zlib or brotli decode that reached `maxOutputLength`. */
const tooLarge = (e: unknown): boolean =>
  (e as { code?: string } | null)?.code === 'ERR_BUFFER_TOO_LARGE';

const view = (b: Uint8Array): Buffer => Buffer.from(b.buffer, b.byteOffset, b.byteLength);

export class InputDecoder {
  private readonly budget: DecodeBudget;

  /** `what` names the input in a refusal — `'PNG image data'`, `'TIFF strip'`. */
  constructor(limits: LoadLimits = LoadLimits.defaults, private readonly what = 'input') {
    this.budget = new DecodeBudget(limits);
  }

  get limits(): LoadLimits { return this.budget.limits; }

  /** Refuse a declared output size before decoding, then decode. */
  private run(
    input: Uint8Array, declared: number | undefined,
    decode: (cap: number) => Uint8Array,
  ): Uint8Array {
    if (declared !== undefined) this.budget.check(declared, input.length, undefined, this.what);
    const bound = this.budget.cap(input.length).bytes;
    const cap = declared === undefined ? bound : Math.min(bound, declared);
    let out: Uint8Array;
    try { out = decode(cap); }
    catch (e) { rethrowLimit(e);
      if (!tooLarge(e)) throw e;
      // Past the cap: past a declaration inside the bounds is damage, and past
      // the bounds themselves is a refusal naming the field that set them.
      if (declared !== undefined && declared <= bound) this.damage(declared);
      this.budget.check(bound + 1, input.length, undefined, this.what);
      throw e;
    }
    if (declared !== undefined && out.length > declared) this.damage(declared);
    this.budget.check(out.length, input.length, undefined, this.what);
    this.budget.chargeBytes(out.length);
    return out;
  }

  private damage(declared: number): never {
    throw new PdfParseError(`${this.what}: decodes to more than the ${declared} bytes it declares`);
  }

  /** zlib (RFC 1950), as PNG IDAT, TIFF Deflate strips and WOFF tables use. */
  inflate(input: Uint8Array, declared?: number): Uint8Array {
    return this.run(input, declared, (cap) => new Uint8Array(
      inflateSync(view(input), Number.isFinite(cap) ? { maxOutputLength: Math.max(1, cap + 1) } : {})));
  }

  /** Brotli, as WOFF2's single compressed block uses. */
  brotli(input: Uint8Array, declared?: number): Uint8Array {
    return this.run(input, declared, (cap) => new Uint8Array(
      brotliDecompressSync(view(input), Number.isFinite(cap) ? { maxOutputLength: Math.max(1, cap + 1) } : {})));
  }

  /** TIFF LZW (early change 1). */
  lzw(input: Uint8Array): Uint8Array {
    return this.run(input, undefined, (cap) => lzwDecode(input, 1, cap));
  }

  /** TIFF PackBits. */
  packBits(input: Uint8Array): Uint8Array {
    return this.run(input, undefined, (cap) => runLengthDecode(input, cap));
  }
}
