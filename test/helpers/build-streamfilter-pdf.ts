import { deflateSync } from 'node:zlib';
import { PdfDict, PdfObject, PdfStream, name, ref } from '../../src/types.js';

const bytes = (s: string) => new TextEncoder().encode(s);

function stream(dict: [string, PdfObject][], raw: Uint8Array): PdfStream {
  const d: PdfDict = new Map<string, PdfObject>(dict);
  d.set('Length', raw.length);
  return { kind: 'stream', dict: d, raw };
}
function flate(text: string, extra: [string, PdfObject][] = []): PdfStream {
  return stream([...extra, ['Filter', name('FlateDecode')]],
    new Uint8Array(deflateSync(Buffer.from(bytes(text)))));
}

/** A one-page doc reachable from /Root carrying, as page-resource XObjects:
 *  a Flate content stream, an uncompressed stream, a Flate+predictor stream,
 *  a DCTDecode image, plus an XMP /Metadata stream on the catalog. */
export function buildStreamFilterDoc(): { objects: Map<number, PdfObject>; trailer: PdfDict } {
  const objects = new Map<number, PdfObject>();

  // 6 = Flate content stream (page /Contents)
  objects.set(6, flate('BT /F1 12 Tf 10 10 Td (FLATE-CONTENT-STREAM) Tj ET'));
  // 7 = uncompressed Form XObject
  objects.set(7, stream(
    [['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 10, 10]]],
    bytes('UNCOMPRESSED-XOBJECT-BODY')));
  // 8 = Flate + PNG-predictor Form XObject (payload = 8 bytes 10..80)
  {
    const data = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const raw = new Uint8Array(deflateSync(Buffer.from(Uint8Array.from([0, ...data]))));
    const parms: PdfDict = new Map<string, PdfObject>([
      ['Predictor', 12], ['Colors', 1], ['BitsPerComponent', 8], ['Columns', 8]]);
    objects.set(8, {
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 8, 1]],
        ['Filter', name('FlateDecode')], ['DecodeParms', parms], ['Length', raw.length]]),
      raw,
    });
  }
  // 9 = DCTDecode image (never decoded; must stay binary/untouched)
  objects.set(9, stream(
    [['Type', name('XObject')], ['Subtype', name('Image')], ['Width', 1], ['Height', 1],
     ['ColorSpace', name('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', name('DCTDecode')]],
    Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])));
  // 10 = XMP /Metadata stream (exempt)
  objects.set(10, stream(
    [['Type', name('Metadata')], ['Subtype', name('XML')]],
    bytes('<?xpacket?><x:xmpmeta>title</x:xmpmeta>')));

  const resources: PdfDict = new Map<string, PdfObject>([
    ['XObject', new Map<string, PdfObject>([
      ['Fx1', ref(7)], ['Fx2', ref(8)], ['Im0', ref(9)]])],
  ]);
  objects.set(5, resources);
  objects.set(3, new Map<string, PdfObject>([
    ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 200, 200]],
    ['Resources', ref(5)], ['Contents', ref(6)]]));
  objects.set(2, new Map<string, PdfObject>([
    ['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]]]));
  objects.set(1, new Map<string, PdfObject>([
    ['Type', name('Catalog')], ['Pages', ref(2)], ['Metadata', ref(10)]]));

  const trailer: PdfDict = new Map<string, PdfObject>([['Root', ref(1)]]);
  return { objects, trailer };
}
