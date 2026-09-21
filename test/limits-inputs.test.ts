import { describe, it, expect } from 'vitest';
import { deflateSync, brotliCompressSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField, type LoadLimitPatch } from '../src/loadlimits.js';
import { ResourceLimitError, PdfParseError } from '../src/errors.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';
import { buildBmp } from './helpers/build-bmp.js';

// ibzo.11: the non-PDF inputs — image files, SVG images, web fonts — decode
// under the document's LoadLimits, exactly as a PDF stream does.

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('completed without reaching a limit');
}
const expectLimit = (e: ResourceLimitError, field: LimitField) => expect(e.limit).toBe(field);

/** A one-page document carrying `patch` as its policy. */
function docWith(patch: LoadLimitPatch = {}): Document {
  const blank = Document.New();
  blank.AddPage();
  return Document.Open(blank.Save(), { limits: LoadLimits.defaults.with(patch) });
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** A gray 8-bit PNG declaring `w` x `h`, its IDAT holding `raw` deflated. CRCs
 *  are zero: the reader does not check them. */
function png(w: number, h: number, raw: Uint8Array): Uint8Array {
  const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const chunk = (t: string, d: number[] | Uint8Array) => [...be32(d.length), ...enc(t), ...d, 0, 0, 0, 0];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...be32(w), ...be32(h), 8, 0, 0, 0, 0]),
    ...chunk('IDAT', deflateSync(raw)), ...chunk('IEND', [])]);
}

describe('PNG input (AddImage)', () => {
  it('refuses a declared size over maxImagePixels BEFORE inflating anything', () => {
    // 2^31 x 2^31 used to be embedded as-is: an image nobody can decode,
    // written into the output PDF.
    const e = refusal(() => docWith().Pages[0].AddImage(png(0x7fffffff, 0x7fffffff, new Uint8Array(4)), [0, 0, 10, 10]));
    expectLimit(e, 'maxImagePixels');
  });

  it('caps IDAT inflation with the document\'s decode bounds', () => {
    // 2,000 x 1,000 gray is 2,001,000 bytes of filtered rows.
    const img = png(2000, 1000, new Uint8Array(2_001_000));
    expectLimit(refusal(() => docWith({ maxDecodedStreamBytes: 1_000_000 }).Pages[0].AddImage(img, [0, 0, 10, 10])),
      'maxDecodedStreamBytes');
    expect(() => docWith().Pages[0].AddImage(img, [0, 0, 10, 10])).not.toThrow();
  });

  it('stops a zlib bomb at the cap rather than after inflating it', () => {
    // IDAT inflating to 64 MiB behind a 100 x 100 header. The cap stops zlib
    // one byte past the bound, so the refusal never holds the 64 MiB.
    const e = refusal(() => docWith({ maxDecodedStreamBytes: 1_000_000 }).Pages[0]
      .AddImage(png(100, 100, new Uint8Array(64 * 1024 * 1024)), [0, 0, 10, 10]));
    expectLimit(e, 'maxDecodedStreamBytes');
    expect(e.reached).toBeLessThanOrEqual(1_000_001);
  });

  it('reaches an SVG <image> data: URI too', () => {
    const d = docWith({ maxDecodedStreamBytes: 1_000_000 });
    const b64 = Buffer.from(png(2000, 1000, new Uint8Array(2_001_000))).toString('base64');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image width="10" height="10" href="data:image/png;base64,${b64}"/></svg>`;
    expectLimit(refusal(() => d.Pages[0].AddSVGObject(new TextEncoder().encode(svg), [0, 0, 10, 10])),
      'maxDecodedStreamBytes');
  });
});

describe('TIFF and BMP input', () => {
  const tiff = (w: number, h: number, strips: Uint8Array[], rowsPerStrip: number) => buildTiff({
    pages: [{
      tags: baseTags(w, h, 1, [
        { tag: 258, type: 3, values: [8] }, { tag: 259, type: 3, values: [8] },
        { tag: 277, type: 3, values: [1] }, { tag: 278, type: 4, values: [rowsPerStrip] },
      ]),
      blocks: strips,
    }],
  });

  it('caps a Deflate strip with the document\'s decode bounds', () => {
    const img = tiff(1000, 1000, [deflateSync(new Uint8Array(1_000_000))], 1000);
    expectLimit(refusal(() => docWith({ maxDecodedStreamBytes: 500_000 }).AddImagePages(img)), 'maxDecodedStreamBytes');
    expect(() => docWith().AddImagePages(img)).not.toThrow();
  });

  it('bounds the strips of one file IN TOTAL, not strip by strip', () => {
    // Ten 100,000-byte strips: each fits a 500,000-byte stream bound, and
    // together they pass a 600,000-byte total.
    const strips = Array.from({ length: 10 }, () => deflateSync(new Uint8Array(100_000)));
    const img = tiff(1000, 1000, strips, 100);
    const e = refusal(() => docWith({ maxDecodedStreamBytes: 500_000, maxTotalDecodedBytes: 600_000 }).AddImagePages(img));
    expectLimit(e, 'maxTotalDecodedBytes');
  });

  it('refuses past the DOCUMENT\'s maxImagePixels, as a ResourceLimitError', () => {
    const img = tiff(200, 200, [deflateSync(new Uint8Array(40_000))], 200);
    expectLimit(refusal(() => docWith({ maxImagePixels: 39_999 }).AddImagePages(img)), 'maxImagePixels');
    const bmp = buildBmp({ width: 200, height: 200, bpp: 24, rows: [], rawPixels: new Uint8Array(4) });
    expectLimit(refusal(() => docWith({ maxImagePixels: 39_999 }).Pages[0].AddImage(bmp, [0, 0, 10, 10])), 'maxImagePixels');
  });
});

describe('web fonts (AddFont)', () => {
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];

  /** A WOFF 1.0 holding one `head` table: `comp` stored, `origLength` declared. */
  function woff1(comp: Uint8Array, origLength: number): Uint8Array {
    const header = [0x77, 0x4f, 0x46, 0x46, ...be32(0x00010000), ...be32(44 + 20 + comp.length),
      ...u16(1), ...u16(0), ...be32(origLength + 12 + 16), ...u16(1), ...u16(0),
      ...be32(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0)];
    const dir = [0x68, 0x65, 0x61, 0x64, ...be32(44 + 20), ...be32(comp.length), ...be32(origLength), ...be32(0)];
    return Uint8Array.from([...header, ...dir, ...comp]);
  }

  /** A WOFF2 holding one null-transformed `head` table of declared `origLength`. */
  function woff2(stream: Uint8Array, origLength: number): Uint8Array {
    const comp = brotliCompressSync(stream);
    const b128: number[] = [];
    for (let v = origLength, first = true; first || v > 0; first = false) { b128.unshift((v & 0x7f) | (first ? 0 : 0x80)); v = Math.floor(v / 128); }
    const dir = [0x01, ...b128];
    const header = [0x77, 0x4f, 0x46, 0x32, ...be32(0x00010000), ...be32(48 + dir.length + comp.length),
      ...u16(1), ...u16(0), ...be32(origLength + 12 + 16), ...be32(comp.length), ...u16(1), ...u16(0),
      ...be32(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0)];
    return Uint8Array.from([...header, ...dir, ...comp]);
  }

  it('refuses a WOFF table DECLARING more than maxDecodedStreamBytes, before inflating', () => {
    expectLimit(refusal(() => docWith().AddFont(woff1(deflateSync(new Uint8Array(10)), 0x7fffffff))),
      'maxDecodedStreamBytes');
  });

  /** What `f` threw — so a DAMAGE refusal can be told from a LIMIT one. */
  const thrown = (f: () => unknown): unknown => { try { f(); } catch (e) { return e; } return undefined; };

  it('stops a WOFF table inflating past its declared length AT that length, as damage', () => {
    // 64 MiB of zeros behind a declared 1,000 bytes, under a 1 MB stream bound.
    // Capped at the declaration it is damage found at byte 1,001; capped only
    // by the bound it would reach 1 MB and be reported as a limit instead.
    const e = thrown(() => docWith({ maxDecodedStreamBytes: 1_000_000 })
      .AddFont(woff1(deflateSync(new Uint8Array(64 * 1024 * 1024)), 1000)));
    expect(e).toBeInstanceOf(PdfParseError);
  });

  it('refuses a WOFF2 DECLARING more than maxDecodedStreamBytes, and caps brotli at what it declares', () => {
    expectLimit(refusal(() => docWith().AddFont(woff2(new Uint8Array(10), 0x7fffffff))), 'maxDecodedStreamBytes');
    const e = thrown(() => docWith({ maxDecodedStreamBytes: 1_000_000 })
      .AddFont(woff2(new Uint8Array(16 * 1024 * 1024), 1000)));
    expect(e).toBeInstanceOf(PdfParseError);
  });
});

// ibzo.11 part B: nesting. Each of these overflowed the stack as a RangeError
// before; each is now a ResourceLimitError naming maxNestingDepth, checked
// once at the entry rather than in every recursive walk behind it.
describe('nesting depth of HTML, CSS and SVG input', () => {
  const svg = (inner: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);

  it('HTML: refuses one element past maxNestingDepth, and admits one at it', () => {
    // html > body > p > b x37 is 40 elements deep.
    expect(() => docWith({ maxNestingDepth: 40 }).AddHtml('<p>' + '<b>'.repeat(37) + 'x')).not.toThrow();
    expectLimit(refusal(() => docWith({ maxNestingDepth: 40 }).AddHtml('<p>' + '<b>'.repeat(38) + 'x')),
      'maxNestingDepth');
  });

  it('HTML: a tree 20,000 deep is refused under the DEFAULTS instead of overflowing', () => {
    expectLimit(refusal(() => docWith().AddHtml('<p>' + '<b>'.repeat(20_000) + 'x')), 'maxNestingDepth');
  });

  it('CSS: block and function nesting follow the DOCUMENT\'s bound, in a style attribute and a sheet alike', () => {
    const calc = (n: number) => `<p style="width:${'calc('.repeat(n)}1px${')'.repeat(n)}">x</p>`;
    const parens = (n: number) => `<style>p{color:${'('.repeat(n)}}</style><p>x</p>`;
    expect(() => docWith().AddHtml(calc(60))).not.toThrow();
    expectLimit(refusal(() => docWith({ maxNestingDepth: 40 }).AddHtml(calc(60))), 'maxNestingDepth');
    expectLimit(refusal(() => docWith({ maxNestingDepth: 40 }).AddHtml(parens(60))), 'maxNestingDepth');
    expectLimit(refusal(() => docWith().AddHtml(parens(100_000))), 'maxNestingDepth');
  });

  it('SVG: refuses one element past maxNestingDepth, and admits one at it', () => {
    // svg > g x38 > rect is 40 elements deep.
    const deep = (k: number) => svg('<g>'.repeat(k) + '<rect width="5" height="5"/>' + '</g>'.repeat(k));
    expect(() => docWith({ maxNestingDepth: 40 }).Pages[0].AddSVGObject(deep(38), [0, 0, 9, 9])).not.toThrow();
    expectLimit(refusal(() => docWith({ maxNestingDepth: 40 }).Pages[0].AddSVGObject(deep(39), [0, 0, 9, 9])),
      'maxNestingDepth');
    expectLimit(refusal(() => docWith().Pages[0].AddSVGObject(deep(20_000), [0, 0, 9, 9])), 'maxNestingDepth');
  });
});

// ibzo.11 part D: <use> expansion. Ten references per level expand 10^n times;
// the import counts the content tokens it emits against maxContentTokens, the
// bound the page walk will later parse the result under.
describe('SVG content expansion', () => {
  /** `levels` of ten-way <use> fan-out over one rect: 10^levels rects. */
  const laughs = (levels: number, wrap: (use: string) => string = (u) => u) => {
    let defs = '<rect id="g0" width="1" height="1"/>';
    for (let i = 1; i <= levels; i++) defs += `<g id="g${i}">` + `<use href="#g${i - 1}"/>`.repeat(10) + '</g>';
    return new TextEncoder().encode(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs>${defs}</defs>${wrap(`<use href="#g${levels}"/>`)}</svg>`);
  };

  it('refuses a <use> expansion past maxContentTokens, and admits it under the defaults', () => {
    expectLimit(refusal(() => docWith({ maxContentTokens: 10_000 }).Pages[0].AddSVGObject(laughs(4), [0, 0, 9, 9])),
      'maxContentTokens');
    expect(() => docWith().Pages[0].AddSVGObject(laughs(4), [0, 0, 9, 9])).not.toThrow();
  });

  it('counts every pattern tile together, not each on its own', () => {
    // Each tile is its own emitter and expands <use> to 100 rects, measured at
    // 2,000 tokens a tile. Three tiles are 6,000: under a limit of 5,000 each
    // tile fits ALONE, so only a count shared across emitters refuses. (A
    // single over-limit tile cannot tell the two apart — it refuses either way.)
    const tiles = (n: number) => laughs(2, (use) => {
      let out = '';
      for (let t = 0; t < n; t++)
        out += `<pattern id="p${t}" width="10" height="10" patternUnits="userSpaceOnUse">${use}</pattern>`
          + `<rect width="10" height="10" fill="url(#p${t})"/>`;
      return out;
    });
    expect(() => docWith({ maxContentTokens: 5_000 }).Pages[0].AddSVGObject(tiles(1), [0, 0, 9, 9])).not.toThrow();
    expectLimit(refusal(() => docWith({ maxContentTokens: 5_000 }).Pages[0].AddSVGObject(tiles(3), [0, 0, 9, 9])),
      'maxContentTokens');
  });
});
