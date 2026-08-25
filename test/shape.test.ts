import { describe, it, expect } from 'vitest';
import { parseSfnt } from '../src/sfnt.js';
import { shapeText, measureShaped } from '../src/shape.js';
import { EmbeddedFont } from '../src/embeddedfont.js';
import { buildOtFontFor, buildGsub, buildGpos, ligatureLookup, pairKernLookup, singleSubstDelta } from './helpers/build-sfnt.js';

describe('shapeText — Latin', () => {
  it('applies a ligature (f+i → fi) and kerning, LTR, single run', () => {
    // code points 0x66 'f'→gid10, 0x69 'i'→gid11, 0x6a 'j'→gid12
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);   // 10,11 → 20
    const gpos = buildGpos([pairKernLookup('kern', 20, 12, -40)]);     // (20,12) kern -40
    const sfnt = parseSfnt(buildOtFontFor({ gsub, gpos, cmap: [[0x66, 10], [0x69, 11], [0x6a, 12]] }));
    const runs = shapeText('fij', sfnt, { dir: 'ltr' });
    expect(runs.length).toBe(1);
    expect(runs[0].rtl).toBe(false);
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([20, 12]); // fi ligature + j
    expect(runs[0].glyphs[0].cluster).toBe(0);                  // ligature keeps first cluster
    expect(runs[0].glyphs[1].cluster).toBe(2);
    // gid20 natural advance = max(100,20*100)=2000; kern -40 applied to the fi glyph's advance
    expect(runs[0].glyphs[0].xAdvance).toBe(2000 - 40);
  });

  it('measureShaped sums xAdvance in font units', () => {
    const sfnt = parseSfnt(buildOtFontFor({ cmap: [[0x41, 5], [0x42, 6]] }));
    const runs = shapeText('AB', sfnt, { dir: 'ltr' });
    // gid5 = 500, gid6 = 600
    expect(measureShaped(runs)).toBe(500 + 600);
  });
});

describe('shapeText — Arabic / RTL', () => {
  it('reverses an RTL run to visual order and keeps clusters', () => {
    // Two Arabic letters (isolated forms), no GSUB/GPOS: nominal gids, RTL reversed.
    const sfnt = parseSfnt(buildOtFontFor({ cmap: [[0x0627, 30], [0x0628, 31]] })); // alef, beh
    const runs = shapeText('اب', sfnt, { dir: 'rtl' });
    expect(runs.length).toBe(1);
    expect(runs[0].rtl).toBe(true);
    // logical [alef=30(cluster0), beh=31(cluster1)] → visual reversed [31,30]
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([31, 30]);
    expect(runs[0].glyphs.map((g) => g.cluster)).toEqual([1, 0]);
  });

  it('applies init/medi/fina joining forms per glyph', () => {
    // beh 0x0628 → nominal gid40; init form → 41, medi → 42, fina → 43 (Single Subst by feature).
    const gsub = buildGsub([
      singleSubstDelta('init', 40, 1),   // 40 → 41
      singleSubstDelta('medi', 40, 2),   // 40 → 42
      singleSubstDelta('fina', 40, 3),   // 40 → 43
    ]);
    const sfnt = parseSfnt(buildOtFontFor({ gsub, cmap: [[0x0628, 40]] }));
    const runs = shapeText('ببب', sfnt, { dir: 'rtl', script: 'arab' });
    // logical forms: [init, medi, fina] → gids [41,42,43]; RTL visual reverse → [43,42,41]
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([43, 42, 41]);
  });
});

describe('EmbeddedFont.shapeRuns', () => {
  it('records used gids and a ligature gid→source-text ToUnicode entry', () => {
    const gsub = buildGsub([ligatureLookup('liga', 10, [11], 20)]);
    const sfnt = parseSfnt(buildOtFontFor({ gsub, cmap: [[0x66, 10], [0x69, 11]] }));
    const font = new EmbeddedFont(sfnt);
    const runs = font.shapeRuns('fi', { dir: 'ltr' });
    expect(runs[0].glyphs.map((g) => g.gid)).toEqual([20]);
    expect(font.usedGids.has(20)).toBe(true);
    expect(font.toUnicode.get(20)).toBe('fi'); // ligature restores both source code points
  });
});
