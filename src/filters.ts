import { inflateSync, deflateSync, constants } from 'node:zlib';
import { PdfStream, PdfDict, PdfObject, isName, isDict, isArray, name } from './types.js';
import { applyPredictor } from './predictor.js';
import { lzwDecode, lzwEncode } from './lzw.js';
import { ascii85Decode, asciiHexDecode, runLengthDecode, ascii85Encode, asciiHexEncode, runLengthEncode } from './ascii.js';
import { UnsupportedFeatureError } from './errors.js';

/** Filters whose output is not raw samples — they terminate the byte-decode
 *  chain and are handled by the image layer (or rejected for non-image streams). */
export const IMAGE_CODECS: ReadonlySet<string> = new Set([
  'DCTDecode', 'DCT', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode', 'JPXDecode',
]);

export interface TerminalFilter { name: string; parms: PdfDict | undefined; }

/** Decode-time options. `partial` makes FlateDecode return the bytes produced
 *  before a truncated or corrupt payload stopped it, instead of throwing. Only
 *  the damaged-file paths pass it; a well-formed payload decodes identically. */
export interface DecodeOptions { partial?: boolean }

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
function inflateSalvage(input: Uint8Array): Uint8Array {
  const attempt = (len: number): Uint8Array | undefined => {
    try {
      return new Uint8Array(inflateSync(Buffer.from(input.subarray(0, len)),
        { finishFlush: constants.Z_SYNC_FLUSH }));
    } catch { return undefined; }
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

function decodeOne(
  filter: string, input: Uint8Array, parms: PdfDict | undefined, partial = false,
): Uint8Array {
  switch (filter) {
    case 'FlateDecode': case 'Fl':
      return withPredictor(parms, new Uint8Array(partial
        ? inflateSalvage(input)
        : inflateSync(Buffer.from(input))));
    case 'LZWDecode': case 'LZW':
      return withPredictor(parms, lzwDecode(input, num(parms?.get('EarlyChange'), 1)));
    case 'ASCII85Decode': case 'A85': return ascii85Decode(input);
    case 'ASCIIHexDecode': case 'AHx': return asciiHexDecode(input);
    case 'RunLengthDecode': case 'RL': return runLengthDecode(input);
    default:
      throw new UnsupportedFeatureError(`unsupported decode filter: ${filter}`);
  }
}

/** Apply the leading byte-filters in order; stop at the first image-codec
 *  (terminal) filter and return the partially-decoded bytes plus that filter. */
export function applyDecodeFilters(
  raw: Uint8Array, names: string[], parms: (PdfDict | undefined)[],
  opts?: DecodeOptions,
): { bytes: Uint8Array; terminal?: TerminalFilter } {
  let bytes = raw;
  for (let k = 0; k < names.length; k++) {
    const nm = names[k];
    if (IMAGE_CODECS.has(nm)) return { bytes, terminal: { name: nm, parms: parms[k] } };
    bytes = decodeOne(nm, bytes, parms[k], opts?.partial);
  }
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
  if (names.length === 0) return s.raw;
  const { bytes, terminal } = applyDecodeFilters(s.raw, names, parms, opts);
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
