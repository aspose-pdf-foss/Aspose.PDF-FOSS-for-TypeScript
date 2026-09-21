import { describe, it, expect } from 'vitest';
import { LoadLimits, type LimitField } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { decodeJpeg } from '../src/jpeg.js';
import { decodeJpx } from '../src/jpx.js';
import { decodeCcitt } from '../src/ccitt.js';
import { decodeJbig2, newBitmap } from '../src/jbig2.js';
import { heightClassWalk } from '../src/jbig2symbol.js';
import type { IntSource } from '../src/jbig2ints.js';
import { parseFunction } from '../src/pdffunction.js';
import { name, type PdfObject, type PdfStream } from '../src/types.js';
import { Document } from '../src/document.js';
import { buildObjectsPdf } from './helpers/build-hostile-pdf.js';
import { decodeImageStream } from '../src/imagedecode.js';

/** Decode object 4 of `d` as an image. */
const decodeObject4 = (d: Document) => decodeImageStream(d, d.getObject(4) as PdfStream);

// Every fixture here is a HEADER and nothing more: the geometry it declares is
// what must be refused, before any sample is read or any buffer sized from it.
// A decoder that allocated first would exhaust the heap on these rather than
// fail, which is what the tests would then show.

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('decoded without reaching a limit');
}
const expectLimit = (e: ResourceLimitError, field: LimitField) => expect(e.limit).toBe(field);
const pixels = (n: number) => LoadLimits.defaults.with({ maxImagePixels: n });
const u16 = (v: number) => [(v >> 8) & 255, v & 255];
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

describe('DCT (JPEG)', () => {
  /** SOI + an SOF0 declaring `w` x `h` with three components. */
  const sof = (w: number, h: number) => new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, ...u16(17), 8, ...u16(h), ...u16(w), 3,
    1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ]);

  it('refuses the frame from its SOF under the DEFAULTS', () => {
    expectLimit(refusal(() => decodeJpeg(sof(65535, 65535))), 'maxImagePixels');
  });

  it('refuses one pixel over, and gets past the frame header at the bound', () => {
    expectLimit(refusal(() => decodeJpeg(sof(100, 100), pixels(9_999))), 'maxImagePixels');
    // At the bound the frame header is accepted; the file then fails for want of
    // any scan, which is a parse error and not a limit.
    expect(() => decodeJpeg(sof(100, 100), pixels(10_000))).not.toThrow(ResourceLimitError);
  });
});

describe('JPX (JPEG 2000)', () => {
  /** SOC + a one-component SIZ. */
  const siz = (xsiz: number, ysiz: number, xtsiz: number, ytsiz: number) => new Uint8Array([
    0xff, 0x4f, 0xff, 0x51, ...u16(41), ...u16(0),
    ...u32(xsiz), ...u32(ysiz), ...u32(0), ...u32(0),
    ...u32(xtsiz), ...u32(ytsiz), ...u32(0), ...u32(0),
    ...u16(1), 7, 1, 1,
  ]);

  it('refuses an absurd tile grid naming the limit, before counting the tiles', () => {
    // The acceptance input. Every tile holds at least one pixel, so the image
    // area bounds the tile count too — and this grid would otherwise land on
    // "multiple tiles unsupported", which names no limit at all.
    const e = refusal(() => decodeJpx(siz(100_000, 100_000, 1, 1)));
    expectLimit(e, 'maxImagePixels');
  });

  it('refuses a single-tile image one pixel over', () => {
    expectLimit(refusal(() => decodeJpx(siz(100, 100, 100, 100), pixels(9_999))), 'maxImagePixels');
  });
});

describe('CCITT', () => {
  const params = (columns: number, rows: number) => ({
    k: -1, columns, rows, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true,
  });

  it('refuses DECLARED geometry before decoding a row', () => {
    expectLimit(refusal(() => decodeCcitt(new Uint8Array(0), params(100_000, 100_000))), 'maxImagePixels');
    expectLimit(refusal(() => decodeCcitt(new Uint8Array(0), params(100, 100), pixels(9_999))), 'maxImagePixels');
  });

  it('bounds an UNDECLARED row count as rows are produced', () => {
    // /Rows absent means "until the data ends", so nothing is known up front.
    // G4 with every row a vertical-0 copy of a white reference: one bit a row.
    const data = new Uint8Array(4096).fill(0xff);
    expectLimit(refusal(() => decodeCcitt(data, params(1000, 0), pixels(50_000))), 'maxImagePixels');
  });
});

describe('JBIG2', () => {
  it('refuses the PAGE from the image dictionary\'s declared size', () => {
    expectLimit(refusal(() => decodeJbig2(new Uint8Array(0), undefined, 65_536, 65_536)), 'maxImagePixels');
  });

  /** One segment header + body. Short-form referred-to, one-byte page. */
  const segment = (type: number, body: number[]) => new Uint8Array([
    ...u32(0), type, 0, 1, ...u32(body.length), ...body,
  ]);
  const regionInfo = (w: number, h: number) => [...u32(w), ...u32(h), ...u32(0), ...u32(0), 0];

  it('refuses a region declaring 2^31 pixels, before the region is allocated', () => {
    // The acceptance input: an immediate generic region on a 1x1 page.
    const seg = segment(38, [...regionInfo(65_536, 32_768), 0]);
    const e = refusal(() => decodeJbig2(seg, undefined, 1, 1));
    expectLimit(e, 'maxImagePixels');
    expect(e.reached).toBe(2 ** 31);
  });

  it('refuses a halftone GRID, which sizes two allocations of its own', () => {
    // HGW x HGH cells: the skip bitmap and the grayscale value array are both
    // that size, and the region around them is only 1x1.
    const seg = segment(22, [...regionInfo(1, 1), 0, ...u32(65_536), ...u32(65_536), ...u32(0), ...u32(0), ...u16(256), ...u16(0)]);
    expectLimit(refusal(() => decodeJbig2(seg, undefined, 1, 1)), 'maxImagePixels');
  });

  it('refuses a symbol whose DECODED size is over the bound, before producing it', () => {
    // A symbol's width and height are integers out of the entropy stream, so the
    // check sits in the walk that sums them, ahead of the producer that allocates.
    let produced = 0;
    const deltas = { dh: [1000], dw: [1000] };
    const int = {
      dh: () => deltas.dh.shift() ?? null,
      dw: () => deltas.dw.shift() ?? null,
    } as unknown as IntSource;
    const producer = { kind: 'perSymbol' as const, produce: () => { produced++; return newBitmap(1, 1); } };
    const e = refusal(() => heightClassWalk(int, 1, producer, [], pixels(999_999)));
    expectLimit(e, 'maxImagePixels');
    expect(produced).toBe(0);
  });
});

describe('sampled (type 0) functions', () => {
  const R = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);
  const fn = (size: number[]) => ({
    kind: 'stream' as const, raw: new Uint8Array(0),
    dict: new Map<string, PdfObject>([
      ['FunctionType', 0], ['Domain', size.flatMap(() => [0, 1])], ['Range', [0, 1]],
      ['Size', size], ['BitsPerSample', 8], ['Filter', name('FlateDecode')],
    ]),
  });
  let inflated = 0;
  const INFLATE = (s: { raw: Uint8Array }) => { inflated++; return s.raw; };

  it('refuses the declared sample table before inflating it', () => {
    inflated = 0;
    const e = refusal(() => parseFunction(fn([65_536, 65_536]), R, INFLATE));
    expectLimit(e, 'maxFunctionSamples');
    expect(inflated).toBe(0);
  });

  it('counts every OUTPUT, not just the grid', () => {
    const f = fn([100, 100]);
    f.dict.set('Range', [0, 1, 0, 1, 0, 1]);           // three outputs
    expectLimit(refusal(() => parseFunction(f, R, INFLATE,
      LoadLimits.defaults.with({ maxFunctionSamples: 29_999 }))), 'maxFunctionSamples');
    expect(() => parseFunction(f, R, INFLATE, LoadLimits.defaults.with({ maxFunctionSamples: 30_000 })))
      .not.toThrow();
  });
});

describe('a refused image does not degrade to a blank one', () => {
  // Every image path wraps decoding in a catch that skips a broken image. A
  // bound reached there must escape: swallowed, a refused 2^31-pixel region
  // renders as a page with the picture simply missing, and nobody is told.
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const jbig2Region = new Uint8Array([...u32(0), 38, 0, 1, ...u32(18),
    ...u32(65_536), ...u32(32_768), ...u32(0), ...u32(0), 0, 0]);

  it('ToImage raises ResourceLimitError naming the bound', () => {
    const payload = `${hex(jbig2Region)}>`;
    const content = 'q 10 0 0 10 0 0 cm /Im0 Do Q';
    const buf = buildObjectsPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1 `
        + `/Filter [/ASCIIHexDecode /JBIG2Decode] /Length ${payload.length} >>\nstream\n${payload}\nendstream`,
    ]);
    const doc = Document.Open(buf);
    expect(doc.Pages[0].Images).toHaveLength(1);
    expectLimit(refusal(() => doc.Pages[0].ToImage()), 'maxImagePixels');
  });

  it('decodes an image under the DOCUMENT policy, not the defaults', () => {
    // A 100x100 JBIG2 page with no segments: nothing but the declared page size
    // can refuse it, and only a lowered document limit can.
    const doc = (limit?: number) => Document.Open(buildObjectsPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>',
      '<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 1 '
        + '/Filter /JBIG2Decode /Length 0 >>\nstream\n\nendstream',
    ]), limit === undefined ? {} : { limits: LoadLimits.defaults.with({ maxImagePixels: limit }) });
    expect(() => decodeObject4(doc())).not.toThrow();
    expectLimit(refusal(() => decodeObject4(doc(9_999))), 'maxImagePixels');
  });
});
