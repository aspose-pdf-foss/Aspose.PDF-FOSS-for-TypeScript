import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveImagesFile } from '../src/node.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { encodeJpeg } from '../src/jpegencode.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildPng } from './helpers/build-embed-images.js';
import { decodePng } from './helpers/decode-png.js';

const dir = mkdtempSync(join(tmpdir(), 'pdfimages-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SIZE = 16;

/** A 16x16 image, red in its left half and blue in its right. JPEG codes 8x8
 *  blocks and subsamples chroma, so anything that has to survive one is 16x16
 *  and every probe is a block interior. */
function halves(): number[] {
  const rows: number[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      rows.push(x < SIZE / 2 ? 255 : 0, 0, x < SIZE / 2 ? 0 : 255);
    }
  }
  return rows;
}

/** A second picture, distinguishable from `halves` by content. */
function solidGreen(): number[] {
  const rows: number[] = [];
  for (let i = 0; i < SIZE * SIZE; i++) rows.push(0, 255, 0);
  return rows;
}

const realJpeg = () => encodeJpeg(SIZE, SIZE, new Uint8Array(halves()), 'rgb', { quality: 95 });
const flatePng = () => buildPng(SIZE, SIZE, 2, halves());
const greenPng = () => buildPng(SIZE, SIZE, 2, solidGreen());

let seq = 0;
const inputOf = (bytes: Uint8Array): string => {
  const p = join(dir, `in-${++seq}.pdf`);
  writeFileSync(p, bytes);
  return p;
};
const outOf = (label: string) => join(dir, `out-${label}-${++seq}`);

/** A saved document of one page per entry, each carrying the images it names. */
function pdfWith(pages: Uint8Array[][]): string {
  const doc = Document.New();
  for (const images of pages) {
    const { page } = doc.AddPage(PageFormat.A4);
    let x = 10;
    for (const img of images) { page.AddImage(img, [x, 10, 50, 50]); x += 60; }
  }
  return inputOf(doc.Save());
}

/** A document whose first page also carries an image XObject that cannot be
 *  decoded: a /JPXDecode stream holding bytes that are not a codestream.
 *  `page.Images` reaches it through /Resources /XObject whether or not anything
 *  draws it. */
function pdfWithBrokenImage(): string {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  page.AddImage(flatePng(), [10, 10, 50, 50]);

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')],
    ['Width', 8], ['Height', 8], ['BitsPerComponent', 8],
    ['ColorSpace', name('DeviceRGB')], ['Filter', name('JPXDecode')],
  ]);
  const broken = doc.allocObject({ kind: 'stream', dict, raw: new Uint8Array([1, 2, 3, 4]) });
  const res = page.Resources!;
  const xo = doc.resolve(res.get('XObject')) as PdfDict;
  xo.set('Broken', broken);

  return inputOf(doc.Save());
}

describe('saveImagesFile — naming', () => {
  it('names each file from the media type the encoder reports', () => {
    // The one step the wrapper exists to get right: a .png holding JPEG bytes
    // is a file no viewer opens, and the source image cannot be asked.
    return saveImagesFile(pdfWith([[realJpeg(), flatePng()]]), outOf('ext')).then(({ written }) => {
      expect(written).toHaveLength(2);
      expect(written.map((p) => p.slice(-4)).sort()).toEqual(['.jpg', '.png']);
    });
  });

  it('numbers files in document order across pages', async () => {
    const out = outOf('order');
    await saveImagesFile(pdfWith([[flatePng()], [greenPng()]]), out);
    expect(readdirSync(out).sort()).toEqual(['img-1.png', 'img-2.png']);
  });

  it('returns the paths it wrote, joined onto outDir as given', async () => {
    const out = outOf('paths');
    const { written } = await saveImagesFile(pdfWith([[flatePng()]]), out);
    expect(written).toEqual([join(out, 'img-1.png')]);
    expect(existsSync(written[0])).toBe(true);
  });

  it('creates outDir, including a missing parent', async () => {
    const out = join(outOf('deep'), 'a', 'b');
    const { written } = await saveImagesFile(pdfWith([[flatePng()]]), out);
    expect(written).toHaveLength(1);
    expect(readdirSync(out)).toEqual(['img-1.png']);
  });
});

describe('saveImagesFile — one file per distinct picture', () => {
  it('writes a picture drawn on two pages once', async () => {
    // Two AddImage calls make two DISTINCT stream objects with identical
    // content — the shape a merged document has — so this fails for a build
    // keyed on the stream object rather than on the encoded bytes.
    const png = flatePng();
    const out = outOf('dedup');
    const { written } = await saveImagesFile(pdfWith([[png], [png]]), out);
    expect(written).toHaveLength(1);
    expect(readdirSync(out)).toEqual(['img-1.png']);
  });

  it('still writes two pictures that differ', async () => {
    const { written } = await saveImagesFile(
      pdfWith([[flatePng(), greenPng()]]), outOf('distinct'));
    expect(written).toHaveLength(2);
  });
});

describe('saveImagesFile — content', () => {
  it('extracts an unmasked JPEG byte for byte', async () => {
    const jpeg = realJpeg();
    const { written } = await saveImagesFile(pdfWith([[jpeg]]), outOf('faithful'));
    // The faithful default: no re-encode, so no generation loss.
    expect(new Uint8Array(readFileSync(written[0]))).toEqual(jpeg);
  });

  it('honours format, re-encoding a JPEG as a PNG', async () => {
    const { written } = await saveImagesFile(
      pdfWith([[realJpeg()]]), outOf('forced'), { format: 'png' });
    expect(written[0].endsWith('.png')).toBe(true);
    const png = decodePng(new Uint8Array(readFileSync(written[0])));
    expect(png.width).toBe(SIZE);
    // Left half red, right half blue, probed inside a block away from ringing.
    expect(png.at(3, 8)[0]).toBeGreaterThan(200);
    expect(png.at(12, 8)[2]).toBeGreaterThan(200);
  });
});

describe('saveImagesFile — what it could not write', () => {
  it('skips an image that will not encode and still writes its neighbours', async () => {
    const out = outOf('broken');
    const { written, skipped } = await saveImagesFile(pdfWithBrokenImage(), out);
    expect(written).toHaveLength(1);
    expect(readdirSync(out)).toEqual(['img-1.png']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].page).toBe(0);
    expect(skipped[0].name).toBe('Broken');
    expect(skipped[0].reason).toBeTruthy();
  });

  it('reports two empty arrays for a document with no images', async () => {
    const out = outOf('none');
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    const { written, skipped } = await saveImagesFile(inputOf(doc.Save()), out);
    expect(written).toEqual([]);
    expect(skipped).toEqual([]);
    expect(readdirSync(out)).toEqual([]);
  });
});
