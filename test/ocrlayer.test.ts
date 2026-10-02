import { describe, it, expect } from 'vitest';
import { buildOcrLayer } from '../src/ocrlayer.js';
import { GlyphlessCodes } from '../src/glyphless.js';
import type { Matrix } from '../src/text.js';

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
/** Device matrix of a 200x100 page at scale 1, Rotate 0: page → pixels. */
const FLIP: Matrix = [1, 0, 0, -1, 0, 100];
const IMG = { width: 200, height: 100 };

/** The numbers of the one `Tm` in a single-span layer. */
function tm(body: Uint8Array): number[] {
  const m = /([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm/.exec(dec(body));
  if (!m) throw new Error('no Tm');
  return m.slice(1).map(Number);
}

describe('buildOcrLayer (3ywf.3)', () => {
  it('writes one invisible text object in the named font', () => {
    const l = buildOcrLayer([{ text: 'Hi', box: [10, 20, 50, 40] }], FLIP, IMG, new GlyphlessCodes(), 'OCR0');
    const s = dec(l.body);
    expect(s.startsWith('BT\n/OCR0 1 Tf\n3 Tr\n')).toBe(true);
    expect(s.endsWith('ET')).toBe(true);
    expect(s).toContain('<00010002> Tj');
    expect(l).toMatchObject({ written: 1, dropped: 0 });
  });

  it('maps the box bottom-left to the origin and stretches the natural width onto the box', () => {
    // box x 10..50 (40px), y 20..40 (20px) at scale 1 on a flipped page:
    // origin = (10, 100-40) = (10, 60); two glyphs of 0.5 em → natural 1.0,
    // so a = 40 / 1.0; up = (0, 20).
    const l = buildOcrLayer([{ text: 'Hi', box: [10, 20, 50, 40] }], FLIP, IMG, new GlyphlessCodes(), 'F');
    expect(tm(l.body)).toEqual([40, 0, 0, 20, 10, 60]);
  });

  it('follows a rotated device matrix with no special case', () => {
    // Rotate 90, 200x100 page: device maps page (x, y) to pixel (y, x).
    const ROT90: Matrix = [0, 1, 1, 0, 0, 0];
    const l = buildOcrLayer([{ text: 'Hi', box: [10, 20, 50, 40] }], ROT90, { width: 100, height: 200 }, new GlyphlessCodes(), 'F');
    // origin pixel (10, 40) → page (40, 10); along pixel +x → page +y; up pixel −y → page −x.
    expect(tm(l.body)).toEqual([0, 40, -20, 0, 40, 10]);
  });

  it('NFC-normalizes text before encoding', () => {
    const codes = new GlyphlessCodes();
    buildOcrLayer([{ text: 'é', box: [0, 0, 10, 10] }], FLIP, IMG, codes, 'F');
    expect(codes.entries()).toEqual([[1, 'é']]);
  });

  it('drops and counts bad spans', () => {
    const bad = [
      { text: '   ', box: [0, 0, 10, 10] },                 // whitespace only
      { text: '', box: [0, 0, 10, 10] },                    // empty
      { text: 'a', box: [10, 10, 10, 20] },                 // zero width
      { text: 'a', box: [20, 10, 10, 20] },                 // inverted
      { text: 'a', box: [0, Number.NaN, 10, 20] },          // non-finite
      { text: 'a', box: [300, 10, 400, 20] },               // wholly outside
    ] as const;
    const l = buildOcrLayer(bad as never, FLIP, IMG, new GlyphlessCodes(), 'F');
    expect(l).toMatchObject({ written: 0, dropped: 6 });
  });

  it('clamps a box partly outside the image', () => {
    const l = buildOcrLayer([{ text: 'Hi', box: [-10, 20, 30, 40] }], FLIP, IMG, new GlyphlessCodes(), 'F');
    expect(tm(l.body)).toEqual([30, 0, 0, 20, 0, 60]);
  });

  it('lets an encode overflow propagate (the page fails, the caller decides)', () => {
    const codes = new GlyphlessCodes();
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_535; cp++) big += String.fromCodePoint(cp);
    codes.encode(big);
    expect(() => buildOcrLayer([{ text: 'A', box: [0, 0, 10, 10] }], FLIP, IMG, codes, 'F')).toThrow(RangeError);
  });
});
