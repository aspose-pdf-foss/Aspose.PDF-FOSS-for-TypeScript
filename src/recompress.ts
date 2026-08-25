import { deflateSync, inflateSync } from 'node:zlib';
import type { Document } from './document.js';
import { PdfDict, PdfStream, isStream, isName, name } from './types.js';
import { filterList, IMAGE_CODECS } from './filters.js';

export interface RecompressResult {
  streams: number;
  bytesSaved: number;
}

/** Structural/metadata streams that must never be re-filtered — the same set
 *  streamfilter.ts exempts, for the same reasons. */
const EXEMPT_TYPES: ReadonlySet<string> = new Set(['XRef', 'ObjStm', 'Metadata']);

const MAX_LEVEL = 9; // node's zlib default is 6

function typeName(d: PdfDict): string | undefined {
  const t = d.get('Type');
  return isName(t) ? t.name : undefined;
}

const deflateMax = (b: Uint8Array): Uint8Array =>
  new Uint8Array(deflateSync(Buffer.from(b), { level: MAX_LEVEL }));

/** Recompress one stream, or undefined to leave it alone. */
function recompressOne(s: PdfStream): PdfStream | undefined {
  const t = typeName(s.dict);
  if (t !== undefined && EXEMPT_TYPES.has(t)) return undefined;

  const { names } = filterList(s);
  if (names.some((n) => IMAGE_CODECS.has(n))) return undefined; // already compressed

  // Unfiltered -> Flate.
  if (names.length === 0) {
    const raw = deflateMax(s.raw);
    if (raw.length >= s.raw.length) return undefined;
    const dict: PdfDict = new Map(s.dict);
    dict.set('Filter', name('FlateDecode'));
    dict.set('Length', raw.length);
    return { kind: 'stream', dict, raw };
  }

  // Exactly [FlateDecode] -> re-deflate at max level. Multi-filter chains are
  // skipped: rebuilding a chain is streamFilter's job, not this pass's.
  const only = names.length === 1 && (names[0] === 'FlateDecode' || names[0] === 'Fl');
  if (!only) return undefined;

  let plain: Uint8Array;
  // Deliberately raw inflate, NOT decodeStream: any /DecodeParms predictor must
  // stay applied to these bytes and untouched in the dict.
  try { plain = new Uint8Array(inflateSync(Buffer.from(s.raw))); } catch { return undefined; }
  const raw = deflateMax(plain);
  if (raw.length >= s.raw.length) return undefined;
  const dict: PdfDict = new Map(s.dict);
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}

/** Flate every unfiltered stream and re-deflate every [FlateDecode] stream at
 *  maximum level, replacing a stream only when the result is strictly smaller. */
export function recompressStreams(doc: Document): RecompressResult {
  let streams = 0;
  let bytesSaved = 0;
  for (const [r, obj] of [...doc.objectEntries()]) {
    if (!isStream(obj)) continue;
    const out = recompressOne(obj);
    if (!out) continue;
    bytesSaved += obj.raw.length - out.raw.length;
    streams++;
    doc.replaceObject(r.num, out);
  }
  return { streams, bytesSaved };
}
