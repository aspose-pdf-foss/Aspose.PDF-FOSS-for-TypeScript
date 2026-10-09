import { inflateSync, deflateSync, constants } from 'node:zlib';
import { PdfStream, PdfDict, PdfObject, isName, isDict, isArray, name } from './types.js';
import { applyPredictor } from './predictor.js';
import { lzwDecode, lzwEncode } from './lzw.js';
import { ascii85Decode, asciiHexDecode, runLengthDecode, ascii85Encode, asciiHexEncode, runLengthEncode } from './ascii.js';
import { UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { DecodeBudget, budgetFor } from './decodebudget.js';
import { LoadLimits } from './loadlimits.js';

/** Filters whose output is not raw samples — they terminate the byte-decode
 *  chain and are handled by the image layer (or rejected for non-image streams). */
export const IMAGE_CODECS: ReadonlySet<string> = new Set([
  'DCTDecode', 'DCT', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode', 'JPXDecode',
]);

export interface TerminalFilter { name: string; parms: PdfDict | undefined; }

/** Decode-time options. `partial` makes FlateDecode return the bytes produced
 *  before a truncated or corrupt payload stopped it, instead of throwing. Only
 *  the damaged-file paths pass it; a well-formed payload decodes identically. */
export interface DecodeOptions {
  partial?: boolean;
  /** This stream is PAGE CONTENT and this many content bytes were decoded
   *  before it (`ibzo.4`), so `maxContentBytes` caps the decode alongside the
   *  per-stream bounds. Set by the helpers that assemble a page's `/Contents`. */
  contentSoFar?: number;
}

/** Options for {@link applyDecodeFilters}: the decode options plus the budget
 *  the chain draws on and the stream it belongs to, which is what the running
 *  total is charged against. `decodeStream` fills both in from the registry. */
export interface ChainOptions extends DecodeOptions { budget?: DecodeBudget; stream?: PdfStream }

/** Node's code for an inflate that reached `maxOutputLength`. */
const TOO_LARGE = 'ERR_BUFFER_TOO_LARGE';
const tooLarge = (e: unknown): boolean => (e as { code?: string } | null)?.code === TOO_LARGE;

/** One decoder's output bound: the cap it may reach, and how to refuse past it.
 *  `refuse` names the bound that set the cap, in that bound's own unit. */
interface OutputBound { cap: number; refuse(reached: number): never }

function num(o: PdfObject | undefined, dflt: number): number {
  return typeof o === 'number' ? o : dflt;
}

function withPredictor(parms: PdfDict | undefined, data: Uint8Array): Uint8Array {
  if (!isDict(parms)) return data;
  return applyPredictor(data, {
    predictor: num(parms.get('Predictor'), 1),
    colors: num(parms.get('Colors'), 1),
    bpc: num(parms.get('BitsPerComponent'), 8),
    columns: num(parms.get('Columns'), 1),
  });
}

/** Inflate as much of a damaged payload as DEFLATE will give up.
 *
 *  Z_SYNC_FLUSH covers a payload that merely stops early: zlib reports the
 *  truncation as Z_BUF_ERROR and hands back what it produced. It does not cover
 *  a payload whose bytes were *altered* — an invalid symbol is Z_DATA_ERROR,
 *  which throws with no output at all, so bit rot in one byte of a stream would
 *  cost the whole stream. Cutting the input before the altered byte turns that
 *  case back into a truncation, which is what the search below looks for.
 *
 *  **Best effort, not a guarantee.** Every prefix ending at or before the first
 *  altered byte decodes truthfully, but a longer one can decode *too* — altered
 *  bytes often still form valid symbols — so the result is correct up to the
 *  damage and arbitrary after it. That also means "decodes" is not monotone in
 *  prefix length and this search can only approximate. Callers must validate
 *  what they parse out of the result and be prepared to discard the tail;
 *  decodeObjStm does, by parsing each object in its own try. */
function inflateSalvage(input: Uint8Array, bound: OutputBound, limits: LoadLimits): Uint8Array {
  // (ibzo.2/.3) Every probe is a full inflate up to the output cap, so the
  // search is bounded twice: by the number of probes, and by what each may
  // produce. A probe that reaches the cap is a bound, never "does not decode" —
  // read as a failure it would steer the search toward a SHORTER prefix and
  // hand back a truncated result where the right answer is a refusal.
  let probes = 0;
  const attempt = (len: number): Uint8Array | undefined => {
    limits.enforce('maxSalvageProbes', ++probes, 'Flate salvage');
    try {
      return new Uint8Array(inflateSync(Buffer.from(input.subarray(0, len)),
        { finishFlush: constants.Z_SYNC_FLUSH, ...zlibCap(bound) }));
    } catch (e) { rethrowLimit(e);
      if (tooLarge(e)) bound.refuse(bound.cap + 1);
      return undefined;
    }
  };
  const whole = attempt(input.length);
  if (whole) return whole;

  let lo = 0;              // known to decode (the empty prefix cannot fail)
  let hi = input.length;   // known to fail
  let best: Uint8Array = new Uint8Array(0);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const out = attempt(mid);
    if (out) { lo = mid; if (out.length > best.length) best = out; } else hi = mid;
  }
  return best;
}

/** zlib stops ONE byte past the cap, so the overshoot is observable and the
 *  bound can be named; an infinite cap passes nothing, zlib rejecting it. */
function zlibCap(bound: OutputBound): { maxOutputLength?: number } {
  return Number.isFinite(bound.cap) ? { maxOutputLength: Math.max(1, bound.cap + 1) } : {};
}

function decodeOne(
  filter: string, input: Uint8Array, parms: PdfDict | undefined, partial: boolean,
  bound: OutputBound, limits: LoadLimits,
): Uint8Array {
  switch (filter) {
    case 'FlateDecode': case 'Fl': {
      if (partial) return withPredictor(parms, inflateSalvage(input, bound, limits));
      let inflated: Uint8Array;
      try {
        inflated = new Uint8Array(inflateSync(Buffer.from(input), zlibCap(bound)));
      } catch (e) { rethrowLimit(e);
        if (tooLarge(e)) bound.refuse(bound.cap + 1);
        throw e;
      }
      return withPredictor(parms, inflated);
    }
    case 'LZWDecode': case 'LZW':
      return withPredictor(parms, lzwDecode(input, num(parms?.get('EarlyChange'), 1), bound.cap));
    case 'ASCII85Decode': case 'A85': return ascii85Decode(input);
    case 'ASCIIHexDecode': case 'AHx': return asciiHexDecode(input);
    case 'RunLengthDecode': case 'RL': return runLengthDecode(input, bound.cap);
    // A stream's own crypt filter (32000-1 7.4.10). It is applied when the
    // object is LOADED -- crypto.ts's streamCryptFilter chooses the cipher --
    // so by the time a stream is decoded its bytes are already plaintext (lj8t).
    case 'Crypt': return input;
    default:
      throw new UnsupportedFeatureError(`unsupported decode filter: ${filter}`);
  }
}

/** Apply the leading byte-filters in order; stop at the first image-codec
 *  (terminal) filter and return the partially-decoded bytes plus that filter.
 *
 *  **Invariant (`ibzo.3`):** every stage is bounded against the ENCODED input
 *  of the whole chain, not its own input. A ratio per stage lets a nested bomb
 *  pass stage by stage — two Flate layers each under DEFLATE's ~1032:1 multiply
 *  to a million. The cap is handed INTO the decoder, so zlib and the LZW and
 *  RunLength loops stop at it; checking the output afterwards bounds nothing,
 *  the allocation having already happened. */
export function applyDecodeFilters(
  raw: Uint8Array, names: string[], parms: (PdfDict | undefined)[],
  opts?: ChainOptions,
): { bytes: Uint8Array; terminal?: TerminalFilter } {
  const budget = opts?.budget ?? new DecodeBudget(LoadLimits.defaults);
  const stream = opts?.stream;
  budget.limits.enforce('maxFilterChain', names.length, 'filter chain');
  let bytes = raw;
  for (let k = 0; k < names.length; k++) {
    const nm = names[k];
    if (IMAGE_CODECS.has(nm)) return { bytes, terminal: { name: nm, parms: parms[k] } };
    const { bytes: cap } = budget.cap(raw.length, stream, opts?.contentSoFar);
    const bound: OutputBound = {
      cap,
      refuse: (reached) => {
        budget.check(reached, raw.length, stream, `${nm} filter`, opts?.contentSoFar);
        // check() must throw for any reached > cap; reaching here is a bug.
        throw new Error(`decode bound ${cap} passed without refusal`);
      },
    };
    bytes = decodeOne(nm, bytes, parms[k], opts?.partial ?? false, bound, budget.limits);
    budget.check(bytes.length, raw.length, stream, `${nm} filter`, opts?.contentSoFar);
  }
  if (stream) budget.charge(stream, bytes.length);
  return { bytes };
}

export function filterList(s: PdfStream): { names: string[]; parms: (PdfDict | undefined)[] } {
  const f = s.dict.get('Filter');
  const names = isName(f) ? [f.name]
    : isArray(f) ? f.filter(isName).map((n) => n.name) : [];
  const p = s.dict.get('DecodeParms') ?? s.dict.get('DP');
  const parms = isArray(p)
    ? p.map((x) => (isDict(x) ? x : undefined))
    : names.map(() => (isDict(p) ? p : undefined));
  return { names, parms };
}

/** Fully decode a stream's byte-filters. Throws UnsupportedFeatureError if an
 *  image-codec filter remains (not valid for non-image streams). */
export function decodeStream(s: PdfStream, opts?: DecodeOptions): Uint8Array {
  const { names, parms } = filterList(s);
  // An unfiltered stream costs no decode, but as page content it still counts:
  // a /Contents array of plain streams is exactly what maxContentBytes bounds.
  if (names.length === 0) {
    if (opts?.contentSoFar !== undefined)
      budgetFor(s).limits.enforce('maxContentBytes', opts.contentSoFar + s.raw.length, 'page content');
    return s.raw;
  }
  const { bytes, terminal } = applyDecodeFilters(s.raw, names, parms, { ...opts, budget: budgetFor(s), stream: s });
  if (terminal) throw new UnsupportedFeatureError(`unsupported filter for stream decode: ${terminal.name}`);
  return bytes;
}

/** Encode `input` with a single byte-filter, the inverse of decodeOne. Predictors
 *  are not applied on encode. Throws for unknown/unsupported (incl. image-codec)
 *  filters. */
export function encodeFilter(filter: string, input: Uint8Array): Uint8Array {
  switch (filter) {
    case 'FlateDecode': case 'Fl': return new Uint8Array(deflateSync(Buffer.from(input)));
    case 'LZWDecode': case 'LZW': return lzwEncode(input);
    case 'ASCII85Decode': case 'A85': return ascii85Encode(input);
    case 'ASCIIHexDecode': case 'AHx': return asciiHexEncode(input);
    case 'RunLengthDecode': case 'RL': return runLengthEncode(input);
    default:
      throw new UnsupportedFeatureError(`unsupported encode filter: ${filter}`);
  }
}

/** Build a PdfStream whose /Filter is `filter` and whose raw payload is `bytes`
 *  encoded with that filter (merging any `extraDict` entries). Guarantees
 *  decodeStream(encodeStream(x, f)) deep-equals x. */
export function encodeStream(bytes: Uint8Array, filter: string, extraDict?: PdfDict): PdfStream {
  const dict: PdfDict = new Map(extraDict ?? []);
  dict.set('Filter', name(filter));
  const raw = encodeFilter(filter, bytes);
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}
