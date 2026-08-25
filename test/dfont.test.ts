import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dfontSfntRanges, isDfont, extractDfontFace } from '../src/dfont.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildDfont } from './helpers/build-dfont.js';
import { buildNamedFont, buildMinimalTtf } from './helpers/build-sfnt.js';

/** The walk over a whole buffer, which is what extractDfontFace does too. */
const ranges = (b: Uint8Array) => dfontSfntRanges((o, l) => b.subarray(o, o + l), b.length);

describe('dfontSfntRanges', () => {
  it('finds the one face of a single-face suitcase', () => {
    // THE MINUS-ONE CASE. Both counts are stored minus one, so a suitcase
    // holding one face stores 0 -- read raw, every single-face .dfont in
    // existence yields no faces at all, with nothing to say why.
    const face = buildNamedFont({ family: 'Solo Sans' });
    const r = ranges(buildDfont({ faces: [face] }));
    expect(r).toBeDefined();
    expect(r!.length).toBe(1);
  });

  it('finds both faces of a two-face suitcase, in order', () => {
    const a = buildNamedFont({ family: 'Duo Sans' });
    const b = buildNamedFont({ family: 'Duo Sans', subfamily: 'Bold', bold: true, weight: 700 });
    const d = buildDfont({ faces: [a, b] });
    const r = ranges(d)!;
    expect(r.length).toBe(2);
    expect(d.subarray(r[0].offset, r[0].offset + r[0].length)).toEqual(a);
    expect(d.subarray(r[1].offset, r[1].offset + r[1].length)).toEqual(b);
  });

  it('selects by TYPE TAG, not by position in the map', () => {
    // A real suitcase carries FOND family records beside its sfnts. Here the
    // FOND comes FIRST in both the data area and the type list, so a reader
    // that indexes positionally hands back the FOND as though it were a font.
    const face = buildNamedFont({ family: 'Tagged Sans' });
    const d = buildDfont({
      faces: [face],
      otherTypes: [{ tag: 'FOND', resources: [Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])] }],
    });
    const r = ranges(d)!;
    expect(r.length).toBe(1);
    expect(d.subarray(r[0].offset, r[0].offset + r[0].length)).toEqual(face);
  });

  it('does not depend on the map carrying a copy of the header', () => {
    // Inside Macintosh reserves those 16 bytes for a header copy and nothing
    // enforces it. Requiring a match would refuse a font for no benefit.
    const r = ranges(buildDfont({
      faces: [buildNamedFont({ family: 'Zeroed Sans' })], zeroHeaderCopy: true,
    }));
    expect(r).toBeDefined();
    expect(r!.length).toBe(1);
  });

  it('rejects what is not a suitcase, rather than guessing', () => {
    expect(ranges(buildMinimalTtf())).toBeUndefined();
    expect(ranges(new Uint8Array(0))).toBeUndefined();
    expect(ranges(new Uint8Array(64))).toBeUndefined();          // all zeros
    expect(ranges(new Uint8Array(readFileSync('fonts/LiberationSans-Regular.ttf'))))
      .toBeUndefined();
  });

  it('rejects a suitcase holding no sfnt type', () => {
    // A bitmap-only suitcase is a real thing and is not a font we can use.
    const d = buildDfont({
      faces: [], otherTypes: [{ tag: 'NFNT', resources: [Uint8Array.from([9, 9])] }],
    });
    expect(ranges(d)).toBeUndefined();
  });
});

describe('extractDfontFace', () => {
  it('hands back a face that parseSfnt reads', () => {
    const d = buildDfont({ faces: [buildNamedFont({ family: 'Real Sans' })] });
    const f = parseSfnt(extractDfontFace(d, 0));
    expect(f.numGlyphs).toBe(2);
  });

  it('addresses faces by index, as a collection does', () => {
    const d = buildDfont({
      faces: [
        buildNamedFont({ family: 'Pick Sans' }),
        buildNamedFont({ family: 'Beta Sans' }),
      ],
    });
    expect(parseSfnt(extractDfontFace(d, 1)).postScriptName).toBe('BetaSans');
    expect(extractDfontFace(d, 0)).not.toEqual(extractDfontFace(d, 1));
  });

  it('throws on a non-suitcase and on an index that is not there', () => {
    // The asymmetry ttc.ts sets: a folder scan catches and skips, while a
    // caller NAMING a face is told it asked for something absent.
    const d = buildDfont({ faces: [buildNamedFont({ family: 'One Sans' })] });
    expect(() => extractDfontFace(buildMinimalTtf(), 0)).toThrow(/not a \.dfont/);
    expect(() => extractDfontFace(d, 1)).toThrow(/asked for index 1/);
    expect(() => extractDfontFace(d, -1)).toThrow();
  });

  it('returns a view, not a copy', () => {
    // A face needs no rebuild -- each sfnt resource is self-consistent with
    // offsets relative to its own start -- and SfntFont threads byteOffset
    // through every DataView, so a subarray is safe and free.
    const d = buildDfont({ faces: [buildNamedFont({ family: 'View Sans' })] });
    expect(extractDfontFace(d, 0).buffer).toBe(d.buffer);
  });
});

describe('isDfont', () => {
  it('agrees with the walk', () => {
    expect(isDfont(buildDfont({ faces: [buildNamedFont({ family: 'Is Sans' })] }))).toBe(true);
    expect(isDfont(buildMinimalTtf())).toBe(false);
  });
});
