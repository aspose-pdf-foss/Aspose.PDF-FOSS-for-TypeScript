import {
  PdfObject, PdfDict, PdfStream, isStream, isName, name,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { filterList, encodeFilter, decodeStream } from './filters.js';

/** Byte-filters this pass can re-encode a stream into. */
export type StreamFilterName =
  | 'ASCII85Decode' | 'ASCIIHexDecode' | 'LZWDecode' | 'RunLengthDecode';

const VALID: ReadonlySet<string> = new Set<StreamFilterName>([
  'ASCII85Decode', 'ASCIIHexDecode', 'LZWDecode', 'RunLengthDecode',
]);
/** Targets that armor (wrap) rather than replace the existing chain. */
const ARMOR: ReadonlySet<string> = new Set(['ASCII85Decode', 'ASCIIHexDecode']);
/** Known byte-filters (canonical + abbreviations) — a stream is eligible only
 *  if every existing filter is one of these (image codecs / unknowns excluded). */
const BYTE_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW',
  'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'RunLengthDecode', 'RL',
]);
/** /Type values that must never be re-encoded (structural + XMP metadata). */
const EXEMPT_TYPES: ReadonlySet<string> = new Set(['XRef', 'ObjStm', 'Metadata']);

function typeName(d: PdfDict): string | undefined {
  const t = d.get('Type');
  return isName(t) ? t.name : undefined;
}

/** Eligible = not a structural/metadata stream, and every existing filter is a
 *  known byte-filter (empty chain = uncompressed = eligible). */
function isEligible(s: PdfStream, names: string[]): boolean {
  const t = typeName(s.dict);
  if (t !== undefined && EXEMPT_TYPES.has(t)) return false;
  return names.every((n) => BYTE_FILTERS.has(n));
}

/** Replace the whole byte-filter chain with `filter` (decode fully, re-encode). */
function replace(s: PdfStream, names: string[], filter: string): PdfStream | undefined {
  if (names.length === 1 && names[0] === filter) return undefined; // already exactly this
  const raw = encodeFilter(filter, decodeStream(s));
  const dict: PdfDict = new Map(s.dict);
  dict.set('Filter', name(filter));
  dict.delete('DecodeParms');
  dict.delete('DP');
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/** Wrap the existing raw payload in `filter` (an ASCII armor), preserving any
 *  inner byte-filters and their DecodeParms. */
function armor(
  s: PdfStream, names: string[], parms: (PdfDict | undefined)[], filter: string,
): PdfStream | undefined {
  if (names[0] === filter) return undefined; // already armored on top
  const raw = encodeFilter(filter, s.raw);
  const dict: PdfDict = new Map(s.dict);
  const newNames = [filter, ...names];
  dict.set('Filter', newNames.length === 1
    ? name(filter)
    : newNames.map((n) => name(n)));
  if (parms.some((p) => p !== undefined)) {
    // Prepend a null for the parm-less ASCII filter; keep the rest aligned.
    const arr: PdfObject[] = [null, ...parms.map((p) => (p === undefined ? null : p))];
    dict.set('DecodeParms', arr);
    dict.delete('DP');
  } else {
    dict.delete('DecodeParms');
    dict.delete('DP');
  }
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/** Re-encode every eligible stream in `objs` (remapped write-plan copies) with
 *  `filter`, replacing the array slot. Never mutates a stream's shared `raw`. */
export function applyStreamFilter(objs: PdfObject[], filter: StreamFilterName): void {
  if (!VALID.has(filter)) throw new UnsupportedFeatureError(`unsupported streamFilter: ${filter}`);
  for (let i = 0; i < objs.length; i++) {
    const s = objs[i];
    if (!isStream(s)) continue;
    const { names, parms } = filterList(s);
    if (!isEligible(s, names)) continue;
    const out = ARMOR.has(filter)
      ? armor(s, names, parms, filter)
      : replace(s, names, filter);
    if (out) objs[i] = out;
  }
}
