// Stream-level image decoding: which codec an image XObject uses, and its
// decoded samples. Moved verbatim out of `image.ts` so that the modules which
// only wanted THAT — `imagehref.ts` and `imagergba.ts`, both of which
// constructed a throwaway `ImageInfo` to reach `.Filter` and `.Decode()` — need
// not import the facade.
//
// **Invariant:** this is a LEAF over `types.js` and the codecs, and it must not
// import `image.js`. `ImageInfo.Save` delegates to `imagehref.ts`, so an edge
// back from either of those modules to `image.ts` would close the codebase's
// FIRST import cycle — measured: a sweep over every module in `src/` finds none.
// It is the same extraction `colornames.ts`, `preformat.ts`, `bordersides.ts`,
// `resprune.ts` and `datauri.ts` each already made, and for the same reason:
// two consumers that must not reach each other through a third.
import type { Document } from './document.js';
import { PdfDict, PdfStream, isDict, isStream, isName, isArray } from './types.js';
import { applyDecodeFilters } from './filters.js';
import { decodeCcitt } from './ccitt.js';
import { decodeJpx } from './jpx.js';
import { decodeJbig2 } from './jbig2.js';
import { UnsupportedFeatureError } from './errors.js';

/** A numeric dict entry, or `dflt` when absent or not a number. */
export function numOf(doc: Document, dict: PdfDict, key: string, dflt: number): number {
  const v = doc.resolve(dict.get(key));
  return typeof v === 'number' ? v : dflt;
}

/** Effective single codec filter name (last in a chain), or undefined when none. */
export function filterName(doc: Document, dict: PdfDict): string | undefined {
  const f = doc.resolve(dict.get('Filter'));
  if (isName(f)) return f.name;
  if (isArray(f) && f.length > 0) {
    const last = doc.resolve(f[f.length - 1]);
    if (isName(last)) return last.name;
  }
  return undefined;
}

/** Resolved filter names + per-filter DecodeParms (indirects dereferenced). */
function resolvedFilters(
  doc: Document, dict: PdfDict,
): { names: string[]; parms: (PdfDict | undefined)[] } {
  const f = doc.resolve(dict.get('Filter'));
  const names = isName(f) ? [f.name]
    : isArray(f)
      ? f.map((x) => doc.resolve(x)).filter(isName).map((n) => n.name)
      : [];
  const p = doc.resolve(dict.get('DecodeParms') ?? dict.get('DP'));
  const parms = isArray(p)
    ? p.map((x) => { const r = doc.resolve(x); return isDict(r) ? r : undefined; })
    : names.map(() => (isDict(p) ? p : undefined));
  return { names, parms };
}

/** Decoded bytes. JPEG passthrough for DCTDecode; decoded 8-bit samples for
 *  Flate/LZW/ASCII chains, CCITTFaxDecode, and JPXDecode (JPEG 2000); decoded
 *  1-bpp samples for JBIG2Decode (arithmetic generic/symbol/text + MMR).
 *
 *  The body of `ImageInfo.Decode`, which delegates here. */
export function decodeImageStream(doc: Document, stream: PdfStream): Uint8Array {
  const dict = stream.dict;
  const { names, parms } = resolvedFilters(doc, dict);
  const { bytes, terminal } = applyDecodeFilters(stream.raw, names, parms);
  if (!terminal) return bytes;
  if (terminal.name === 'DCTDecode' || terminal.name === 'DCT') return bytes;
  if (terminal.name === 'CCITTFaxDecode' || terminal.name === 'CCF') {
    const dp = terminal.parms;
    const n = (k: string, d: number) => {
      const v = dp ? doc.resolve(dp.get(k)) : undefined;
      return typeof v === 'number' ? v : d;
    };
    const b = (k: string, d: boolean) => {
      const v = dp ? doc.resolve(dp.get(k)) : undefined;
      return typeof v === 'boolean' ? v : d;
    };
    return decodeCcitt(bytes, {
      k: n('K', 0),
      columns: n('Columns', 1728),
      rows: n('Rows', numOf(doc, dict, 'Height', 0)),
      blackIs1: b('BlackIs1', false),
      byteAlign: b('EncodedByteAlign', false),
      endOfLine: b('EndOfLine', false),
      endOfBlock: b('EndOfBlock', true),
    });
  }
  if (terminal.name === 'JPXDecode') return decodeJpx(bytes).data;
  if (terminal.name === 'JBIG2Decode') {
    const dp = terminal.parms;
    let globals: Uint8Array | undefined;
    const g = dp ? doc.resolve(dp.get('JBIG2Globals')) : undefined;
    // Handles a Flate-wrapped globals stream.
    if (isStream(g)) globals = decodeImageStream(doc, g);
    return decodeJbig2(bytes, globals, numOf(doc, dict, 'Width', 0), numOf(doc, dict, 'Height', 0));
  }
  throw new UnsupportedFeatureError(`Image.Decode: unsupported filter ${terminal.name}`);
}
