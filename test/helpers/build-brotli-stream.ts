import { brotliCompressSync } from 'node:zlib';
import { name, type PdfDict, type PdfObject, type PdfStream } from '../../src/types.js';

/** Node-authored payload, independent of the library's filter encoder. */
export function buildBrotliStream(bytes: Uint8Array, parms?: PdfDict): PdfStream {
  const raw = new Uint8Array(brotliCompressSync(bytes));
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Filter', name('BrotliDecode')], ['Length', raw.length],
  ]);
  if (parms) dict.set('DecodeParms', parms);
  return { kind: 'stream', dict, raw };
}
