import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  constantAlphaPdf, luminositySoftMaskPdf, tilingPatternPdf,
  tilingPatternOffsetClipPdf, strokePatternPdf, blendModePdf, isolatedGroupPdf,
  isolatedBlendGroupPdf, nonIsolatedGroupPdf, nonIsolatedBlendGroupPdf,
  fractionalAlphaRemovalGroupPdf, knockoutIsolatedPdf, knockoutNonIsolatedPdf,
} from './helpers/build-transparency-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 2) => Math.abs(v - target) <= tol;

describe('Page.ToImage — ExtGState constant alpha', () => {
  it('composites a ca 0.5 red fill over white as (255, 128, 128)', () => {
    const p = decodePng(Document.Open(constantAlphaPdf()).Pages[0].ToImage());
    // User (50..150)² → device (50..150)² after the Y-flip (the square is centered).
    const [r, g, b] = p.at(100, 100);
    expect(near(r, 255)).toBe(true);
    expect(near(g, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
    // Outside the square: untouched white.
    expect(p.at(10, 10)).toEqual([255, 255, 255, 255]);
  });
});

describe('Page.ToImage — ExtGState luminosity soft mask', () => {
  it('paints where the mask is white and masks out where it is black', () => {
    const p = decodePng(Document.Open(luminositySoftMaskPdf()).Pages[0].ToImage());
    expect(p.at(50, 100).slice(0, 3)).toEqual([255, 0, 0]);        // under white mask
    expect(p.at(150, 100)).toEqual([255, 255, 255, 255]);          // under black mask
  });
});

describe('Page.ToImage — tiling pattern', () => {
  it('tiles the cell across the filled path', () => {
    const p = decodePng(Document.Open(tilingPatternPdf()).Pages[0].ToImage());
    // The page is 100 tall, so device y = 100 - user y.
    expect(p.at(5, 95).slice(0, 3)).toEqual([0, 0, 255]);      // user (5,5) → in-cell
    expect(p.at(15, 85).slice(0, 3)).toEqual([255, 255, 255]); // user (15,15) → gap
    expect(p.at(45, 55).slice(0, 3)).toEqual([0, 0, 255]);     // user (45,45) → 3rd tile
  });

  it('tiles into a clip away from the origin, with the cell outside it', () => {
    const p = decodePng(Document.Open(tilingPatternOffsetClipPdf()).Pages[0].ToImage());
    // Clip is user (40..80)²; the lattice still lands blue squares at user
    // x,y ≡ 0..10 (mod 20), so user (45,45) is in-cell and (55,55) is a gap.
    expect(p.at(45, 55).slice(0, 3)).toEqual([0, 0, 255]);      // user (45,45)
    expect(p.at(55, 45).slice(0, 3)).toEqual([255, 255, 255]);  // user (55,55) → gap
    expect(p.at(65, 35).slice(0, 3)).toEqual([0, 0, 255]);      // user (65,65)
    // Nothing escapes the clip.
    expect(p.at(5, 95).slice(0, 3)).toEqual([255, 255, 255]);   // user (5,5)
    expect(p.at(95, 5).slice(0, 3)).toEqual([255, 255, 255]);   // user (95,95)
  });
});

describe('Page.ToImage — isolated transparency group', () => {
  // The one assertion in this suite that cannot pass by accident: a no-op
  // composeGroup satisfies every other test here. Drawn inline the overlap
  // composites twice and reads (255, 64, 64); composited through a real
  // offscreen the group flattens first, so the overlap matches the rest.
  it('composites the group once, so the overlap does not double-darken', () => {
    const p = decodePng(Document.Open(isolatedGroupPdf()).Pages[0].ToImage());
    // Overlap of the two squares: user (60..100)² → device y = 200 - user y.
    const [or_, og, ob] = p.at(80, 120);
    // Non-overlapping part of the first square.
    const [nr, ng, nb] = p.at(30, 170);
    for (const [a, b] of [[or_, nr], [og, ng], [ob, nb]]) {
      expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(og - 128)).toBeLessThanOrEqual(3);   // 128, not 64
  });
});

describe('Page.ToImage — non-isolated transparency groups', () => {
  // /I defaults to false, so 'absent' is the ordinary /Group form. All three
  // must buffer: the group composites as a unit at ca 0.5 regardless of /I.
  it.each(['absent', 'false', 'true'] as const)(
    'composites as a unit with /I %s, so the overlap does not double-darken',
    (iso) => {
      const p = decodePng(Document.Open(nonIsolatedGroupPdf(iso)).Pages[0].ToImage());
      // squares are user (20..100)² and (60..140)²; page is 200 tall, so
      // device y = 200 - user y. Overlap user (80,80) → device (80,120).
      expect(p.at(80, 120).slice(0, 3)).toEqual([255, 128, 128]);   // inline → 255,64,64
      // Single coverage, user (30,30) → device (30,170).
      expect(p.at(30, 170).slice(0, 3)).toEqual([255, 128, 128]);
    });

  it('removes the seeded backdrop so an inner blend sees the page (§11.4.6)', () => {
    const p = decodePng(Document.Open(nonIsolatedBlendGroupPdf(false)).Pages[0].ToImage());
    // squares are user (40..120)² and (80..160)²; overlap is user (80..120)².
    // Page is 200 tall → device y = 200 - user y. user (100,100) → (100,100).
    // Inline would read (64,255,0); isolated would read (128,255,128).
    expect(p.at(100, 100).slice(0, 3)).toEqual([128, 255, 0]);
    // Single coverage, user (60,60) → device (60,140).
    expect(p.at(60, 140).slice(0, 3)).toEqual([128, 255, 0]);
  });

  it('differs from the isolated group on the same fixture', () => {
    const nonIso = decodePng(Document.Open(nonIsolatedBlendGroupPdf(false)).Pages[0].ToImage());
    const iso = decodePng(Document.Open(nonIsolatedBlendGroupPdf(true)).Pages[0].ToImage());
    // Isolated: the inner multiply sees the group's transparent backdrop and is
    // a no-op, so the group composites pure cyan down at 0.5 over yellow.
    expect(iso.at(100, 100).slice(0, 3)).toEqual([128, 255, 128]);
    // The two paths must not collapse into each other.
    expect(nonIso.at(100, 100).slice(0, 3)).not.toEqual(iso.at(100, 100).slice(0, 3));
  });

  it('exercises the §11.4.6 removal term at fractional group alpha', () => {
    // The flat-opaque fixture above has αgn = α0 = 1 at every interior probe, so
    // the removal term k = α0/αgn − α0 is identically 0 there and a k=0 mutation
    // survives. Here the inner square draws at ca 0.5 → αgn = 0.5 over the opaque
    // yellow page (α0 = 1), so k = 1. Correct removal reads (191,255,0); dropping
    // the term reads (223,255,0). The gap is exact-match discriminable.
    const p = decodePng(Document.Open(fractionalAlphaRemovalGroupPdf(false)).Pages[0].ToImage());
    // Square is user (50..150)²; page 200 tall → device (100,100) is a flat interior.
    expect(p.at(100, 100).slice(0, 3)).toEqual([191, 255, 0]);
  });

  it('produces no NaN or out-of-range channel anywhere on the page', () => {
    // Guards the αgn = 0 and α0 = 0 division cases in the removal formula.
    const p = decodePng(Document.Open(nonIsolatedBlendGroupPdf(false)).Pages[0].ToImage());
    for (let y = 0; y < 200; y += 7)
      for (let x = 0; x < 200; x += 7)
        for (const c of p.at(x, y))
          expect(Number.isInteger(c) && c >= 0 && c <= 255).toBe(true);
  });
});

describe('Page.ToImage — separable blend modes', () => {
  // Backdrop cb = 0.5 in every channel; source cs = (1, 0, 0). Expected values
  // are the ISO 32000-1 §11.3.5.2 formulas evaluated by hand, so they are
  // independent of the implementation under test.
  const cases: [string, [number, number, number]][] = [
    ['Multiply',   [128,   0,   0]],   // cb*cs
    ['Screen',     [255, 128, 128]],   // cb + cs - cb*cs
    ['Darken',     [128,   0,   0]],   // min(cb, cs)
    ['Lighten',    [255, 128, 128]],   // max(cb, cs)
    ['Difference', [128, 128, 128]],   // |cb - cs|
    ['Exclusion',  [128, 128, 128]],   // cb + cs - 2*cb*cs
  ];
  for (const [mode, expected] of cases) {
    it(`applies ${mode}`, () => {
      const p = decodePng(Document.Open(blendModePdf(mode)).Pages[0].ToImage());
      const [r, g, b] = p.at(50, 50);
      expect(near(r, expected[0], 3)).toBe(true);
      expect(near(g, expected[1], 3)).toBe(true);
      expect(near(b, expected[2], 3)).toBe(true);
    });
  }
});

describe('Page.ToImage — non-separable blend modes', () => {
  it('applies Luminosity: source luminance over backdrop hue', () => {
    // Backdrop is neutral gray 0.5 (no hue); source is pure red, luminance
    // 0.3·1 = 0.3. Luminosity keeps the backdrop's (absent) hue and takes the
    // source's luminance → neutral gray at 0.3 → 77.
    const p = decodePng(Document.Open(blendModePdf('Luminosity')).Pages[0].ToImage());
    const [r, g, b] = p.at(50, 50);
    for (const v of [r, g, b]) expect(Math.abs(v - 77)).toBeLessThanOrEqual(4);
  });

  it('applies Color: source hue at backdrop luminance', () => {
    // Source red carried to the backdrop's luminance 0.5. SetLum lifts every
    // channel by 0.5 - 0.3 = 0.2 and ClipColor pulls the result back in range,
    // so this is a light red: red saturated, green and blue equal and well
    // above zero — the signature of a preserved hue.
    const p = decodePng(Document.Open(blendModePdf('Color')).Pages[0].ToImage());
    const [r, g, b] = p.at(50, 50);
    expect(r).toBeGreaterThan(240);
    expect(g).toBeGreaterThan(20);
    expect(Math.abs(g - b)).toBeLessThanOrEqual(4);
  });
});

describe('Page.ToImage — SCN stroke pattern', () => {
  it('paints the stroke band through the pattern', () => {
    const p = decodePng(Document.Open(strokePatternPdf()).Pages[0].ToImage());
    expect(p.at(50, 50).slice(0, 3)).toEqual([0, 0, 255]);      // inside the band
    expect(p.at(50, 10).slice(0, 3)).toEqual([255, 255, 255]);  // above it
  });
});

describe('Page.ToImage — isolated group with an inner blend mode', () => {
  it('blends against the group backdrop, not the page', () => {
    const p = decodePng(Document.Open(isolatedBlendGroupPdf(true)).Pages[0].ToImage());
    expect(p.at(100, 100).slice(0, 3)).toEqual([0, 255, 255]);  // pure cyan
    expect(p.at(20, 20).slice(0, 3)).toEqual([255, 255, 0]);    // page backdrop
  });

  // Proves the assertion above is not vacuous: if isolation were ignored, both
  // cases would read green and the fixture would verify nothing.
  it('blends against the page when the group is not isolated', () => {
    const p = decodePng(Document.Open(isolatedBlendGroupPdf(false)).Pages[0].ToImage());
    expect(p.at(100, 100).slice(0, 3)).toEqual([0, 255, 0]);    // cyan × yellow
  });
});

describe('Page.ToImage — knockout transparency groups', () => {
  // Only semi-transparent overlaps discriminate knockout: each element
  // composites against the group's INITIAL (here transparent) backdrop, so in
  // the overlap the topmost element replaces the one beneath rather than
  // compositing over it. Squares are user (40..120)² (red) and (80..160)² (blue),
  // each at inner ca 0.5, in an isolated group over white. Page 200 tall →
  // device y = 200 − user y.
  it('replaces in the overlap instead of compositing over (isolated)', () => {
    const p = decodePng(Document.Open(knockoutIsolatedPdf(true)).Pages[0].ToImage());
    // Overlap user (100,100) → device (100,100): pure blue at 0.5 over white.
    expect(p.at(100, 100).slice(0, 3)).toEqual([128, 128, 255]);
    // Red-only user (60,60) → device (60,140): red at 0.5 over white.
    expect(p.at(60, 140).slice(0, 3)).toEqual([255, 128, 128]);
    // Blue-only user (140,140) → device (140,60): blue at 0.5 over white.
    expect(p.at(140, 60).slice(0, 3)).toEqual([128, 128, 255]);
  });

  it('differs from the same group drawn without knockout', () => {
    const ko = decodePng(Document.Open(knockoutIsolatedPdf(true)).Pages[0].ToImage());
    const no = decodePng(Document.Open(knockoutIsolatedPdf(false)).Pages[0].ToImage());
    // Non-knockout composites blue over red in the overlap → (128, 64, 191).
    expect(no.at(100, 100).slice(0, 3)).toEqual([128, 64, 191]);
    expect(ko.at(100, 100).slice(0, 3)).not.toEqual(no.at(100, 100).slice(0, 3));
  });

  it('knocks out over the seeded page backdrop, then removes it (non-isolated)', () => {
    // Yellow page; non-isolated /K group, red (40..120)² then blue (80..160)²,
    // each inner ca 0.5, Normal. Elements composite over the page (B0 = yellow);
    // in the overlap blue knocks out red. Overlap user (100,100) → device (100,100).
    const ko = decodePng(Document.Open(knockoutNonIsolatedPdf(true)).Pages[0].ToImage());
    const no = decodePng(Document.Open(knockoutNonIsolatedPdf(false)).Pages[0].ToImage());
    expect(ko.at(100, 100).slice(0, 3)).toEqual([128, 128, 128]);
    // Without knockout blue composites over red over yellow → (128, 64, 128).
    expect(no.at(100, 100).slice(0, 3)).toEqual([128, 64, 128]);
    expect(ko.at(100, 100).slice(0, 3)).not.toEqual(no.at(100, 100).slice(0, 3));
  });
});
