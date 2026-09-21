import { describe, it, expect } from 'vitest';
import { deflateRawSync, constants } from 'node:zlib';
import { Document } from '../src/document.js';
import { LoadLimits, type LimitField, type LoadLimitPatch } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { parseContentStream } from '../src/content.js';
import { buildObjectsPdf, contentPdf } from './helpers/build-hostile-pdf.js';
import { EditableContent } from '../src/editcontent.js';
import { pageScans } from '../src/validatectx.js';

/** Five forms of 4 tokens drawn by a 10-token page: every parse fits a limit of
 *  20 on its own, and the page walk is 30 (`ibzo.8`). */
function manySmallFormsPdf(): Uint8Array {
  const n = 5;
  const page = Array.from({ length: n }, (_, i) => `/F${i} Do`).join('\n');
  const xobjects = Array.from({ length: n }, (_, i) => `/F${i} ${i + 5} 0 R`).join(' ');
  const form = 'n\n'.repeat(4);
  return contentPdf([page], {
    mediaBox: '[0 0 10 10]',
    resources: `<< /XObject << ${xobjects} >> >>`,
    extraObjects: Array.from({ length: n }, () =>
      `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length ${form.length} >>\nstream\n${form}\nendstream`),
  });
}

function refusal(f: () => unknown): ResourceLimitError {
  try { f(); } catch (e) { if (e instanceof ResourceLimitError) return e; throw e; }
  throw new Error('completed without reaching a limit');
}
const expectLimit = (e: ResourceLimitError, field: LimitField) => expect(e.limit).toBe(field);
const open = (buf: Uint8Array, patch: LoadLimitPatch = {}) =>
  Document.Open(buf, { limits: LoadLimits.defaults.with(patch) });
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Refused at 20 and 29, admitted at exactly the walk's 30 tokens. */
function expectPerWalk(f: (d: Document) => unknown): void {
  const buf = manySmallFormsPdf();
  expectLimit(refusal(() => f(open(buf, { maxContentTokens: 20 }))), 'maxContentTokens');
  expectLimit(refusal(() => f(open(buf, { maxContentTokens: 29 }))), 'maxContentTokens');
  expect(() => f(open(buf, { maxContentTokens: 30 }))).not.toThrow();
}

describe('maxContentTokens', () => {
  it('refuses one token over from GetText and from ToImage alike, and admits one at it', () => {
    const buf = contentPdf(['n\n'.repeat(11)]);
    expectLimit(refusal(() => open(buf, { maxContentTokens: 10 }).Pages[0].GetText()), 'maxContentTokens');
    expectLimit(refusal(() => open(buf, { maxContentTokens: 10 }).Pages[0].ToImage()), 'maxContentTokens');
    expect(() => open(buf, { maxContentTokens: 11 }).Pages[0].GetText()).not.toThrow();
  });

  it('counts OPERANDS and the insides of arrays, not just operators', () => {
    // An operand list with no operator after it never becomes an op, and an
    // array's members are read by a helper the main loop never sees — both
    // accumulate all the same. Counting ops alone lets either grow unbounded.
    expect(() => parseContentStream(new TextEncoder().encode('1 '.repeat(20)),
      LoadLimits.defaults.with({ maxContentTokens: 10 }))).toThrow(ResourceLimitError);
    expect(() => parseContentStream(new TextEncoder().encode(`[${'1 '.repeat(20)}] TJ`),
      LoadLimits.defaults.with({ maxContentTokens: 10 }))).toThrow(ResourceLimitError);
  });

  it('is a budget PER WALK: many forms that each fit still refuse in total (ibzo.8)', () => {
    expectPerWalk((d) => d.Pages[0].GetText());
    expectPerWalk((d) => d.Pages[0].ToImage());
  });

  it('defaults to a bound that is a MEMORY bound, measured', () => {
    // Measured at ~97 heap bytes per token for bare operators: the 50 million
    // ibzo.1 shipped is ~4.8 GB, which is no bound at all.
    expect(LoadLimits.defaults.maxContentTokens as number).toBeLessThanOrEqual(10_000_000);
  });
});

// ibzo.9: every walker that follows ONE page's content graph shares one count.
// Each case reaches a single walker, so each is mutation-checked on its own.
describe('maxContentTokens per page walk in the remaining walkers (ibzo.9)', () => {
  it('GetPaths', () => { expectPerWalk((d) => d.Pages[0].GetPaths()); });

  it("Optimize's glyph-usage scan", () => {
    expectPerWalk((d) => d.Optimize({ dedup: false, compress: false, dr: false }));
  });

  it("Optimize's image-usage scan, with the font pass off", () => {
    expectPerWalk((d) => d.Optimize({ fonts: false, dedup: false, compress: false, dr: false, images: {} }));
  });

  it("the validators' page scan", () => {
    expectPerWalk((d) => pageScans({ doc: d, catalog: d.catalog(), R: (o) => d.resolve(o), cache: new Map() }));
  });

  it('EditableContent, across its top-level streams and every form path it parses', () => {
    expectPerWalk((d) => {
      const ec = new EditableContent(d, d.Pages[0]);
      ec.topOps(0);
      for (let i = 0; i < 5; i++) ec.xobjectOps([`F${i}`]);
    });
  });

  it('starts a fresh count for each walk rather than carrying one over', () => {
    const d = open(manySmallFormsPdf(), { maxContentTokens: 30 });
    d.Pages[0].GetPaths(); d.Pages[0].GetPaths();
    d.Optimize({ images: {} }); d.Optimize({ images: {} });
  });

  it("the Optimize scans reset the count per PAGE, not per document", () => {
    // Two pages drawing the same 30-token walk: 60 across the document, 30 a
    // page. The scans visit every page in ONE call, so only a per-page reset
    // admits this at a limit of 30.
    const forms = Array.from({ length: 5 }, (_, i) => `/F${i} ${i + 6} 0 R`).join(' ');
    const page = Array.from({ length: 5 }, (_, i) => `/F${i} Do`).join('\n');
    const form = 'n\n'.repeat(4);
    const pageDict = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << /XObject << ${forms} >> >> /Contents 5 0 R >>`;
    const buf = buildObjectsPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      pageDict, pageDict,
      `<< /Length ${page.length} >>\nstream\n${page}\nendstream`,
      ...Array.from({ length: 5 }, () =>
        `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length ${form.length} >>\nstream\n${form}\nendstream`),
    ]);
    expect(() => open(buf, { maxContentTokens: 30 }).Optimize({ dedup: false, compress: false, dr: false })).not.toThrow();
    expect(() => open(buf, { maxContentTokens: 30 })
      .Optimize({ fonts: false, dedup: false, compress: false, dr: false, images: {} })).not.toThrow();
  });
});

describe('maxNestingDepth in content', () => {
  it('bounds an operand array, whose reader recursed with no bound', () => {
    const deep = `${'['.repeat(11)}${']'.repeat(11)} TJ`;
    const limits = LoadLimits.defaults.with({ maxNestingDepth: 10 });
    expect(() => parseContentStream(new TextEncoder().encode(deep), limits)).toThrow(ResourceLimitError);
    expect(() => parseContentStream(new TextEncoder().encode(`${'['.repeat(10)}${']'.repeat(10)} TJ`), limits))
      .not.toThrow();
  });
});

describe('maxContentBytes', () => {
  it('bounds a /Contents ARRAY by its combined size, not stream by stream', () => {
    const buf = contentPdf(['n\n'.repeat(3000), 'n\n'.repeat(3000)]);   // 6000 bytes each
    expectLimit(refusal(() => open(buf, { maxContentBytes: 10_000 }).Pages[0].GetText()), 'maxContentBytes');
    expectLimit(refusal(() => open(buf, { maxContentBytes: 10_000 }).Pages[0].ToImage()), 'maxContentBytes');
    expect(() => open(buf, { maxContentBytes: 12_001 }).Pages[0].GetText()).not.toThrow();
  });

  it('refuses a page whose content expands to GIGABYTES, from GetText and ToImage alike, under the DEFAULTS', () => {
    // The acceptance input: 2 GiB of `n\n` as a zlib stream of sync-flushed
    // DEFLATE blocks — a few megabytes on disk, built without ever holding the
    // gigabytes. Its trailer is never checked: the decode is stopped long before.
    const block = new Uint8Array(deflateRawSync(Buffer.from('n\n'.repeat(4 * 1024 * 1024)),
      { finishFlush: constants.Z_SYNC_FLUSH }));
    const parts: Uint8Array[] = [new Uint8Array([0x78, 0x9c])];
    for (let i = 0; i < 256; i++) parts.push(block);
    parts.push(new Uint8Array([0x03, 0x00, 0, 0, 0, 0]));
    const zlib = Buffer.concat(parts);
    const buf = contentPdf([`${hex(zlib)}>`], { filter: '[/ASCIIHexDecode /FlateDecode]' });

    const t = refusal(() => Document.Open(buf).Pages[0].GetText());
    expectLimit(t, 'maxContentBytes');
    // Stopped at the cap, not after decoding the page.
    expect(t.reached).toBeLessThanOrEqual((LoadLimits.defaults.maxContentBytes as number) + 1);
    expectLimit(refusal(() => Document.Open(buf).Pages[0].ToImage()), 'maxContentBytes');
  }, 120_000);
});

describe('maxImagePixels at the render boundary', () => {
  it('refuses an image from its DECLARED size, before any sample is decoded', () => {
    // A 1-byte Flate payload claiming 100,000 x 100,000: the pixels are the
    // declaration, and render and extraction alike must refuse from it.
    const img = '<< /Type /XObject /Subtype /Image /Width 100000 /Height 100000 /ColorSpace /DeviceGray '
      + '/BitsPerComponent 8 /Length 1 >>\nstream\nx\nendstream';
    const buf = contentPdf(['q 10 0 0 10 0 0 cm /Im0 Do Q'],
      { resources: '<< /XObject << /Im0 5 0 R >> >>', extraObjects: [img] });
    expectLimit(refusal(() => Document.Open(buf).Pages[0].ToImage()), 'maxImagePixels');
    expectLimit(refusal(() => Document.Open(buf).Pages[0].Images[0].Decode()), 'maxImagePixels');
  });
});

describe('maxCanvasPixels', () => {
  it('refuses a canvas sized from the DOCUMENT\'s page box', () => {
    const buf = contentPdf(['n'], { mediaBox: '[0 0 200000 200000]' });
    expectLimit(refusal(() => Document.Open(buf).Pages[0].ToImage()), 'maxCanvasPixels');
    // The bound is on the canvas actually allocated: scaled down to 2000 x 2000
    // the same page box fits, so a caller can still render it.
    expect(() => Document.Open(buf).Pages[0].ToImage({ scale: 0.01 })).not.toThrow();
  });

  it('leaves a canvas the CALLER sized explicitly alone — width and height are theirs', () => {
    // Over the bound on purpose: a small explicit canvas cannot tell an exempt
    // build from one that checks everything, since both admit it.
    const buf = contentPdf(['n'], { mediaBox: '[0 0 100 100]' });
    const doc = open(buf, { maxCanvasPixels: 9_999 });
    expect(() => doc.Pages[0].ToImage({ width: 200, height: 200 })).not.toThrow();
    expectLimit(refusal(() => doc.Pages[0].ToImage({ scale: 2 })), 'maxCanvasPixels');
  });

  it('refuses one pixel over, and admits a canvas at the bound', () => {
    const buf = contentPdf(['n'], { mediaBox: '[0 0 100 100]' });
    expectLimit(refusal(() => open(buf, { maxCanvasPixels: 9_999 }).Pages[0].ToImage()), 'maxCanvasPixels');
    expect(() => open(buf, { maxCanvasPixels: 10_000 }).Pages[0].ToImage()).not.toThrow();
  });
});
