import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildPlacedImagePdf } from './helpers/build-image-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

/** A 2x2 DeviceRGB image drawn TWICE on one 100x100 page — 20pt square at
 *  (10,10) and 30pt square at (60,60). Two draws of one image is what makes the
 *  byte-hash dedup rule observable at all; a single-draw fixture would pass
 *  with the dedup removed. */
function twoDraws(): Uint8Array {
  return buildPlacedImagePdf({
    width: 2, height: 2,
    samples: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
    placements: ['20 0 0 20 10 10', '30 0 0 30 60 60'],
  });
}

const media = (bytes: Uint8Array) =>
  unzip(bytes).filter((e) => e.path.startsWith('word/media/'));

const documentXml = (bytes: Uint8Array): string => textOf(unzip(bytes), 'word/document.xml');

describe('textbox mode media', () => {
  it('places each drawn image in its own frame', () => {
    const xml = documentXml(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('w:framePr');
    expect((xml.match(/<w:drawing>/g) ?? [])).toHaveLength(2);
  });

  it('gives the two drawings distinct docPr ids', () => {
    const xml = documentXml(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }));
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('registers ONE media part for two draws of one image', () => {
    // Identity is the hash of the ENCODED BYTES, not the PdfStream object —
    // mdexport.ts's rule, reused rather than re-derived.
    expect(media(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }))).toHaveLength(1);
  });

  it('positions the two draws differently', () => {
    const xml = documentXml(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }));
    // 20pt square at (10,10) on a 100pt page: x = 200 twips, top = 100-30 =
    // 70pt -> 1400. 30pt square at (60,60): x = 1200, top = 100-90 = 10pt -> 200.
    expect(xml).toContain('w:x="200"');
    expect(xml).toContain('w:y="1400"');
    expect(xml).toContain('w:x="1200"');
    expect(xml).toContain('w:y="200"');
  });

  it('emits no backdrop by default and one under backdrop: raster', () => {
    const doc = Document.Open(twoDraws());
    expect(media(doc.ToDocx({ mode: 'textbox' }))).toHaveLength(1);
    expect(media(doc.ToDocx({ mode: 'textbox', backdrop: 'raster' }))).toHaveLength(2);
  });

  it('stores media uncompressed', () => {
    // encodeImage returns JPEG or PNG, both already compressed: deflating costs
    // time and usually grows them. This is the case zip.ts's per-entry method
    // exists for.
    expect(media(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }))[0].method)
      .toBe('store');
  });

  it('resolves every image relationship to a part that exists', () => {
    const zip = unzip(Document.Open(twoDraws()).ToDocx({ mode: 'textbox' }));
    const rels = textOf(zip, 'word/_rels/document.xml.rels');
    const paths = new Set(zip.map((e) => e.path));
    for (const m of rels.matchAll(/Target="([^"]+)"/g)) {
      // Targets resolve against the SOURCE part's directory, not the package root.
      expect(paths.has(`word/${m[1]}`)).toBe(true);
    }
  });

  it('never throws under backdrop: raster', () => {
    const doc = Document.Open(twoDraws());
    expect(() => doc.ToDocx({ mode: 'textbox', backdrop: 'raster' })).not.toThrow();
  });

  it('emits no media part for a page with no images', () => {
    const doc = Document.Open(buildPlacedImagePdf({
      width: 2, height: 2,
      samples: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
      placements: [],
    }));
    expect(media(doc.ToDocx({ mode: 'textbox' }))).toHaveLength(0);
  });
});
