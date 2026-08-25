import { describe, it, expect } from 'vitest';
import {
  vmetricsFor, resolveDecor, decorRects, validateDecoration, validateBackground,
} from '../src/textdecor.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import type { StdFont } from '../src/metrics.js';
import { EmbeddedFont } from '../src/embeddedfont.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildOtFontFor } from './helpers/build-sfnt.js';

describe('vmetricsFor: Standard-14', () => {
  it('gives Helvetica its AFM metrics as em fractions', () => {
    const vm = vmetricsFor('Helvetica');
    expect(vm.ascent).toBeCloseTo(0.718, 6);
    expect(vm.descent).toBeCloseTo(-0.207, 6);
    expect(vm.underlineOffset).toBeCloseTo(-0.1, 6);
    expect(vm.underlineThickness).toBeCloseTo(0.05, 6);
    expect(vm.strikeOffset).toBeCloseTo(0.359, 6); // capHeight 718 / 2
    expect(vm.strikeThickness).toBeCloseTo(0.05, 6);
  });

  it('distinguishes the three families', () => {
    expect(vmetricsFor('Times-Roman').descent).toBeCloseTo(-0.217, 6);
    expect(vmetricsFor('Courier').descent).toBeCloseTo(-0.157, 6);
    expect(vmetricsFor('Times-Roman').strikeOffset).toBeCloseTo(0.331, 6); // 662 / 2
    expect(vmetricsFor('Courier').strikeOffset).toBeCloseTo(0.281, 6);     // 562 / 2
  });

  it('gives every face of a family the same metrics', () => {
    for (const f of ['Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'] as StdFont[])
      expect(vmetricsFor(f)).toEqual(vmetricsFor('Helvetica'));
  });

  it('underline position and thickness are uniform across all 12 faces', () => {
    const faces: StdFont[] = [
      'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
      'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
      'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique',
    ];
    for (const f of faces) {
      expect(vmetricsFor(f).underlineOffset).toBeCloseTo(-0.1, 6);
      expect(vmetricsFor(f).underlineThickness).toBeCloseTo(0.05, 6);
    }
  });
});

// The repo rule: a differential test through our own parser proves nothing. The
// bundled substitute faces are metric-compatible clones parsed by an unrelated
// code path (std14fonts -> parseSfnt), so they are outside the constant table
// this asserts.
describe('vmetricsFor: AFM constants cross-checked against the bundled substitutes', () => {
  it.each(['Helvetica', 'Times-Roman', 'Courier'] as StdFont[])(
    '%s ascent/descent/strike agree within 8%% of an em', (face) => {
      const sfnt = getStd14Sfnt(face);
      expect(sfnt, `no bundled substitute for ${face}`).toBeDefined();
      const upem = sfnt!.unitsPerEm || 1000;
      const vm = vmetricsFor(face);
      expect(Math.abs(vm.ascent - sfnt!.ascent / upem)).toBeLessThan(0.08);
      expect(Math.abs(vm.descent + Math.abs(sfnt!.descent) / upem)).toBeLessThan(0.08);
      expect(Math.abs(vm.strikeOffset - sfnt!.capHeight / upem / 2)).toBeLessThan(0.08);
    });
});

describe('vmetricsFor: embedded fonts', () => {
  const sfntOf = () => parseSfnt(buildOtFontFor({ cmap: [[65, 1]] }));

  // The fixture font carries no `post` underline and no OS/2 strikeout entries,
  // so they are set here explicitly: asserting against whatever the builder
  // happens to emit would leave the table-reading path untested.
  it('reads the font\'s own tables, scaled by unitsPerEm', () => {
    const sfnt = sfntOf();
    sfnt.unitsPerEm = 2048;
    sfnt.ascent = 1536; sfnt.descent = -512; sfnt.capHeight = 1400;
    sfnt.underlinePosition = -256; sfnt.underlineThickness = 128;
    sfnt.strikeoutPosition = 1024; sfnt.strikeoutSize = 102;
    expect(vmetricsFor(new EmbeddedFont(sfnt))).toEqual({
      ascent: 1536 / 2048,
      descent: -512 / 2048,
      // No sxHeight set, so estimated from the ascent.
      xHeight: (1536 / 2048) * 0.7,
      underlineOffset: -256 / 2048,
      underlineThickness: 128 / 2048,
      strikeOffset: 1024 / 2048,
      strikeThickness: 102 / 2048,
    });
  });

  it('derives a missing strikeout offset from half the cap height', () => {
    const sfnt = sfntOf();
    sfnt.unitsPerEm = 1000; sfnt.capHeight = 700; sfnt.strikeoutPosition = 0;
    expect(vmetricsFor(new EmbeddedFont(sfnt)).strikeOffset).toBeCloseTo(0.35, 6);
  });

  it('falls back when the tables say nothing', () => {
    const sfnt = sfntOf();
    sfnt.underlinePosition = 0; sfnt.underlineThickness = 0;
    sfnt.strikeoutPosition = 0; sfnt.strikeoutSize = 0;
    sfnt.ascent = 0; sfnt.descent = 0; sfnt.capHeight = 0;
    expect(vmetricsFor(new EmbeddedFont(sfnt))).toEqual({
      ascent: 0.75, descent: -0.25, xHeight: 0.75 * 0.7,
      underlineOffset: -0.1, underlineThickness: 0.05,
      strikeOffset: 0.25, strikeThickness: 0.05,
    });
  });

  it('normalizes a positive stored descender to point downward', () => {
    const sfnt = sfntOf();
    sfnt.descent = 200; // some fonts store it unsigned
    expect(vmetricsFor(new EmbeddedFont(sfnt)).descent).toBeLessThan(0);
  });
});

const BLACK: [number, number, number] = [0, 0, 0];
const HELV = vmetricsFor('Helvetica');
/** One line, 100pt wide, baseline at the origin. */
const ONE = [{ x: 0, baseline: 0, width: 100 }];

describe('resolveDecor', () => {
  it('returns undefined when nothing is set', () => {
    expect(resolveDecor({}, BLACK, 12, HELV)).toBeUndefined();
    expect(resolveDecor({ underline: false }, BLACK, 12, HELV)).toBeUndefined();
  });

  it('underline: true takes metrics and the text colour', () => {
    const d = resolveDecor({ underline: true }, [1, 0, 0], 10, HELV)!;
    expect(d.underline).toEqual({ color: [1, 0, 0], thickness: 0.5, offset: -1 });
  });

  it('an object form overrides colour, thickness and offset', () => {
    const d = resolveDecor(
      { underline: { color: [0, 0, 1], thickness: 2, offset: -3 } }, BLACK, 10, HELV)!;
    expect(d.underline).toEqual({ color: [0, 0, 1], thickness: 2, offset: -3 });
  });

  it('a bare tuple background defaults its padding to 0', () => {
    const d = resolveDecor({ background: [1, 1, 0] }, BLACK, 10, HELV)!;
    expect(d.background!.color).toEqual([1, 1, 0]);
    expect(d.background!.padding).toBe(0);
    expect(d.background!.top).toBeCloseTo(7.18, 6);
    expect(d.background!.bottom).toBeCloseTo(-2.07, 6);
  });
});

describe('decorRects', () => {
  it('emits nothing for a zero-width line', () => {
    const d = resolveDecor({ underline: true, background: [1, 1, 0] }, BLACK, 10, HELV)!;
    expect(decorRects([{ x: 0, baseline: 0, width: 0 }], d))
      .toEqual({ beneath: '', above: '' });
  });

  it('puts the background beneath and the rules above', () => {
    const d = resolveDecor(
      { underline: true, strikethrough: true, background: [1, 1, 0] }, BLACK, 10, HELV)!;
    const { beneath, above } = decorRects(ONE, d);
    expect(beneath).toContain('1 1 0 rg');
    expect(beneath).toContain('re f');
    expect(above).toContain('0 0 0 rg');
    expect((above.match(/re f/g) ?? []).length).toBe(2); // underline + strikethrough
  });

  it('centres the underline rule on its offset', () => {
    const d = resolveDecor({ underline: { thickness: 1, offset: -2 } }, BLACK, 10, HELV)!;
    // y = offset - thickness/2 = -2.5, height = 1
    expect(decorRects(ONE, d).above).toContain('0 -2.5 100 1 re f');
  });

  it('padding grows the background on all four sides', () => {
    const d = resolveDecor({ background: { color: [1, 1, 0], padding: 3 } }, BLACK, 10, HELV)!;
    // x -3, y -2.07-3 = -5.07, w 100+6 = 106, h 9.25+6 = 15.25
    expect(decorRects(ONE, d).beneath).toContain('-3 -5.07 106 15.25 re f');
  });

  it('emits one rect per line at the right baselines', () => {
    const d = resolveDecor({ underline: { thickness: 1, offset: -2 } }, BLACK, 10, HELV)!;
    const lines = [
      { x: 10, baseline: 100, width: 50 },
      { x: 10, baseline: 88, width: 30 },
    ];
    const { above } = decorRects(lines, d);
    expect(above).toContain('10 97.5 50 1 re f');
    expect(above).toContain('10 85.5 30 1 re f');
  });
});

describe('decoration validators', () => {
  it('accept booleans, undefined, and well-formed objects', () => {
    expect(() => validateDecoration('underline', undefined)).not.toThrow();
    expect(() => validateDecoration('underline', true)).not.toThrow();
    expect(() => validateDecoration('underline', { thickness: 1, offset: -2 })).not.toThrow();
    expect(() => validateBackground('background', [1, 1, 0])).not.toThrow();
    expect(() => validateBackground('background', { color: [1, 1, 0], padding: 2 })).not.toThrow();
  });

  it('reject bad values with a labelled TypeError', () => {
    expect(() => validateDecoration('underline', { color: [2, 0, 0] }))
      .toThrow(/underline\.color/);
    expect(() => validateDecoration('underline', { thickness: -1 })).toThrow(/underline\.thickness/);
    expect(() => validateDecoration('underline', { offset: NaN })).toThrow(/underline\.offset/);
    expect(() => validateBackground('background', {} as never))
      .toThrow(/background\.color/);
    expect(() => validateBackground('background', { color: [1, 1, 0], padding: -1 }))
      .toThrow(/background\.padding/);
  });
});

describe('VMetrics.xHeight', () => {
  it('uses the AFM x-height for each Standard-14 family', () => {
    expect(vmetricsFor('Helvetica').xHeight).toBeCloseTo(0.523, 6);
    expect(vmetricsFor('Times-Roman').xHeight).toBeCloseTo(0.450, 6);
    expect(vmetricsFor('Courier-Bold').xHeight).toBeCloseTo(0.426, 6);
  });

  it('keeps x-height below the ascent, which is what makes it a distinct baseline', () => {
    for (const f of ['Helvetica', 'Times-Roman', 'Courier'] as const) {
      const v = vmetricsFor(f);
      expect(v.xHeight).toBeGreaterThan(0);
      expect(v.xHeight).toBeLessThan(v.ascent);
    }
  });
});
