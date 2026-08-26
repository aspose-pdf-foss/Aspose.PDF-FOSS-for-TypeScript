import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodeTiff, tiffPageCount } from '../src/tiff.js';

/** Three 40x30 pages, each filled a different flat colour, so a decoded pixel
 *  identifies WHICH page a frame came from — the thing a page-range selection
 *  gets wrong silently, since every frame is the right size either way. */
const CHANNEL = [0, 1, 2];   // page 1 red, page 2 green, page 3 blue
function threePages(): Document {
  const doc = Document.New();
  for (const c of CHANNEL) {
    const { page } = doc.AddPage(PageFormat.custom(40, 30));
    const rgb: [number, number, number] = [0, 0, 0];
    rgb[c] = 1;
    const g = page.Graphics();
    g.setFillColor(rgb).rect(0, 0, 40, 30).fill();
    g.apply();
  }
  return doc;
}

/** Which primary the frame is painted in, by reading its first pixel. */
function channelOf(t: Uint8Array, frame: number): number {
  const img = decodeTiff(t, frame);
  if (img.kind !== 'rgb') throw new Error(`expected rgb, got ${img.kind}`);
  const [r, g, b] = [img.samples[0], img.samples[1], img.samples[2]];
  if (r > 200 && g < 60 && b < 60) return 0;
  if (g > 200 && r < 60 && b < 60) return 1;
  if (b > 200 && r < 60 && g < 60) return 2;
  throw new Error(`frame ${frame} is not a primary: ${r},${g},${b}`);
}

describe('Document.ToTiff', () => {
  it('writes one frame per page, in document order', () => {
    const t = threePages().ToTiff();

    expect(tiffPageCount(t)).toBe(3);
    expect([channelOf(t, 0), channelOf(t, 1), channelOf(t, 2)]).toEqual([0, 1, 2]);
  });

  it('selects a page range', () => {
    const t = threePages().ToTiff({ pages: '2-3' });

    expect(tiffPageCount(t)).toBe(2);
    expect([channelOf(t, 0), channelOf(t, 1)]).toEqual([1, 2]);
  });

  it('takes an explicit page list, normalized ascending and deduped', () => {
    const t = threePages().ToTiff({ pages: [3, 1, 3] });

    expect(tiffPageCount(t)).toBe(2);
    expect([channelOf(t, 0), channelOf(t, 1)]).toEqual([0, 2]);
  });

  it('applies the render options to every frame', () => {
    const t = threePages().ToTiff({ scale: 2 });
    const first = decodeTiff(t, 0), last = decodeTiff(t, 2);

    if (first.kind !== 'rgb' || last.kind !== 'rgb') throw new Error('expected rgb');
    expect([first.width, first.height]).toEqual([80, 60]);
    expect([last.width, last.height]).toEqual([80, 60]);
  });

  it('honours the compression option', () => {
    const deflated = threePages().ToTiff();
    const raw = threePages().ToTiff({ compression: 'none' });

    expect(deflated.length).toBeLessThan(raw.length);
    expect(tiffPageCount(raw)).toBe(3);
    expect(channelOf(raw, 1)).toBe(1);
  });

  it('reports an out-of-range page against the document, not the encoder', () => {
    expect(() => threePages().ToTiff({ pages: [4] })).toThrow(RangeError);
  });

  // resolvePages([]) is legal and empty, and encodeTiff would then refuse with
  // a message naming itself — an internal the caller never called. The mistake
  // is a page selection that matched nothing, so say that instead.
  it('refuses an empty selection in its own terms', () => {
    const call = () => threePages().ToTiff({ pages: [] });

    expect(call).toThrow(TypeError);
    expect(call).toThrow(/ToTiff/);
    expect(call).not.toThrow(/encodeTiff/);
  });

  it('accepts a transparent background, which TIFF can carry', () => {
    const t = threePages().ToTiff({ background: 'transparent' });
    const img = decodeTiff(t, 0);

    if (img.kind !== 'rgb') throw new Error('expected rgb');
    expect(img.alpha).toBeDefined();
  });
});
