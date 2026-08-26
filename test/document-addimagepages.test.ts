import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { encodeTiff } from '../src/tiffencode.js';
import { decodePng } from './helpers/decode-png.js';

/** A `frames`-frame TIFF, frame i filled with primary `i % 3`, at w x h.
 *
 *  NOTE the fixture source: `test/fixtures/tiff/PROVENANCE.md` records that no
 *  third-party MULTI-PAGE TIFF is vendored — sharp reaches one only through
 *  `pyramid: true`, which is a different shape. So the frame CONTENT here rides
 *  on a decoder anchored by real single-frame files, while the IFD CHAINING is
 *  our writer checked by our reader. Tracked as its own issue. */
function multiFrame(frames: number, w = 8, h = 6): Uint8Array {
  return encodeTiff(Array.from({ length: frames }, (_, i) => {
    const samples = new Uint8Array(w * h * 3);
    for (let p = 0; p < w * h; p++) samples[p * 3 + (i % 3)] = 255;
    return { width: w, height: h, kind: 'rgb' as const, samples };
  }), { compression: 'none' });
}

/** Overwrite the first value of `tag` in IFD `n`, little-endian TIFF. */
function patchTag(t: Uint8Array, ifdIndex: number, tag: number, value: number): Uint8Array {
  const out = t.slice();
  const dv = new DataView(out.buffer);
  let at = dv.getUint32(4, true);
  for (let i = 0; i < ifdIndex; i++) {
    const n = dv.getUint16(at, true);
    at = dv.getUint32(at + 2 + n * 12, true);
    if (at === 0) throw new Error(`no IFD ${ifdIndex}`);
  }
  const count = dv.getUint16(at, true);
  for (let i = 0; i < count; i++) {
    const e = at + 2 + i * 12;
    if (dv.getUint16(e, true) !== tag) continue;
    dv.setUint16(e + 8, value, true);      // inline SHORT payload
    return out;
  }
  throw new Error(`IFD ${ifdIndex} has no tag ${tag}`);
}

/** Which primary a rendered page is painted in. */
function primaryOf(doc: Document, index: number): number {
  const png = decodePng(doc.Pages[index].ToImage());
  const [r, g, b] = png.at(Math.floor(png.width / 2), Math.floor(png.height / 2));
  if (r > 200 && g < 60 && b < 60) return 0;
  if (g > 200 && r < 60 && b < 60) return 1;
  if (b > 200 && r < 60 && g < 60) return 2;
  throw new Error(`page ${index} is not a primary: ${r},${g},${b}`);
}

describe('Document.AddImagePages', () => {
  it('appends one page per frame, in frame order', () => {
    const doc = Document.New();
    const r = doc.AddImagePages(multiFrame(3));

    expect(r.pages.length).toBe(3);
    expect(doc.Pages.length).toBe(3);
    expect([primaryOf(doc, 0), primaryOf(doc, 1), primaryOf(doc, 2)]).toEqual([0, 1, 2]);
  });

  it('sizes each page to its own frame at 72 DPI', () => {
    const doc = Document.New();
    doc.AddImagePages(multiFrame(2, 20, 10));

    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 20, 10]);
  });

  it('scales the page by dpi, leaving the pixels alone', () => {
    const doc = Document.New();
    doc.AddImagePages(multiFrame(1, 300, 150), { dpi: 300 });

    // 300px at 300dpi is one inch = 72pt.
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 72, 36]);
  });

  it('appends to a document that already has pages', () => {
    const doc = Document.New();
    doc.AddPage();
    doc.AddImagePages(multiFrame(2));

    expect(doc.Pages.length).toBe(3);
    expect(primaryOf(doc, 1)).toBe(0);
  });

  // A selection, normalized the way every other page selection in this library
  // is — ascending and deduped. A caller who wants a particular ORDER makes the
  // calls in that order; a selection that silently reordered pages would be a
  // different feature wearing the same name.
  it('normalizes a frame selection ascending and deduped', () => {
    const doc = Document.New();
    const r = doc.AddImagePages(multiFrame(3), { frames: [2, 0, 2] });

    expect(r.pages.length).toBe(2);
    expect([primaryOf(doc, 0), primaryOf(doc, 1)]).toEqual([0, 2]);
  });

  it('treats a single-frame image as one page', () => {
    const doc = Document.New();
    const r = doc.AddImagePages(multiFrame(1));

    expect(r.pages.length).toBe(1);
    expect(r.skipped).toEqual([]);
  });

  // "One page per DECODABLE frame": a damaged frame must cost its own page and
  // nothing else. A partly-corrupt fax should still yield the pages that work,
  // which is the whole reason this reports rather than throwing.
  it('skips a frame it cannot decode and reports it, keeping the others', () => {
    // Compression 6 is old-style JPEG, which tiff.ts refuses.
    const damaged = patchTag(multiFrame(3), 1, 259, 6);
    const doc = Document.New();
    const r = doc.AddImagePages(damaged);

    expect(r.pages.length).toBe(2);
    expect(r.skipped.map((s) => s.frame)).toEqual([1]);
    expect(r.skipped[0].reason).toBeTruthy();
    expect([primaryOf(doc, 0), primaryOf(doc, 1)]).toEqual([0, 2]);
  });

  it('reports an out-of-range frame', () => {
    expect(() => Document.New().AddImagePages(multiFrame(2), { frames: [2] }))
      .toThrow(RangeError);
  });

  it('refuses an empty frame selection in its own terms', () => {
    const call = () => Document.New().AddImagePages(multiFrame(2), { frames: [] });

    expect(call).toThrow(TypeError);
    expect(call).toThrow(/AddImagePages/);
  });

  it('throws when no frame at all could be decoded', () => {
    const allBad = patchTag(patchTag(multiFrame(2), 0, 259, 6), 1, 259, 6);

    expect(() => Document.New().AddImagePages(allBad)).toThrow();
  });
});
