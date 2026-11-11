import { deflateSync } from 'node:zlib';
import { Document } from '../../src/document.js';
import { PdfDict, PdfObject, PdfStream, name } from '../../src/types.js';
import { buildClassicPdf } from './build-pdf.js';

/** Repeated rows with an irregular edge pattern; zero samples are black. */
export function bilevelSamples(width: number, height: number): Uint8Array {
  const stride = Math.ceil(width / 8), out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x % 29 < 13) !== (Math.floor(y / 16) % 2 === 0))
      out[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

export function buildBilevelDoc(opts: {
  width?: number; height?: number; count?: number; flate?: boolean; stencil?: boolean;
} = {}): { doc: Document; nums: number[]; samples: Uint8Array } {
  const width = opts.width ?? 513, height = opts.height ?? 128;
  const doc = Document.Open(buildClassicPdf(1)), samples = bilevelSamples(width, height);
  const xobjects: PdfDict = new Map(), nums: number[] = [];
  let content = '';
  for (let i = 0; i < (opts.count ?? 1); i++) {
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Image')],
      ['Width', width], ['Height', height], ['BitsPerComponent', 1],
    ]);
    if (opts.stencil) dict.set('ImageMask', true);
    else dict.set('ColorSpace', name('DeviceGray'));
    const raw = opts.flate ? new Uint8Array(deflateSync(samples, { level: 0 })) : samples.slice();
    if (opts.flate) dict.set('Filter', name('FlateDecode'));
    dict.set('Length', raw.length);
    const stream: PdfStream = { kind: 'stream', dict, raw };
    const r = doc.allocObject(stream); nums.push(r.num); xobjects.set(`Im${i}`, r);
    content += `q 100 0 0 100 0 0 cm /Im${i} Do Q\n`;
  }
  doc.Pages[0].Dict.set('Resources', new Map([['XObject', xobjects]]));
  const raw = new TextEncoder().encode(content);
  doc.Pages[0].Dict.set('Contents', doc.allocObject({ kind: 'stream', dict: new Map([['Length', raw.length]]), raw }));
  return { doc, nums, samples };
}
