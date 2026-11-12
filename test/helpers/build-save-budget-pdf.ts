import { deflateSync } from 'node:zlib';
import { asciiHexEncode } from '../../src/ascii.js';
import { serializeDocument } from '../../src/serializer.js';
import { name, ref, type PdfObject, type PdfDict } from '../../src/types.js';

/** One page with Node-authored content streams, decoded only when read/saved.
 *  A second Flate layer makes small fixtures exceed the DEFAULT ratio bound. */
export function buildSaveBudgetPdf(payloads: Uint8Array[], chain: 'flate' | 'nested' | 'hex' = 'flate'): Uint8Array {
  const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);
  const objects = new Map<number, PdfObject>([
    [1, dict([['Type', name('Catalog')], ['Pages', ref(2)]])],
    [2, dict([['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]]])],
    [3, dict([['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 100, 100]],
      ['Contents', payloads.map((_, i) => ref(i + 4))]])],
  ]);
  payloads.forEach((data, i) => {
    let raw: Uint8Array = new Uint8Array(deflateSync(data));
    let filter: PdfObject = name('FlateDecode');
    if (chain === 'nested') {
      raw = new Uint8Array(deflateSync(raw));
      filter = [name('FlateDecode'), name('FlateDecode')];
    } else if (chain === 'hex') {
      raw = asciiHexEncode(raw);
      filter = [name('ASCIIHexDecode'), name('FlateDecode')];
    }
    objects.set(i + 4, { kind: 'stream', raw, dict: dict([['Filter', filter], ['Length', raw.length]]) });
  });
  return serializeDocument(objects, dict([['Root', ref(1)]]));
}
