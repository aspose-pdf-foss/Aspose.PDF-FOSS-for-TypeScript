import {
  constantAlphaPdf, luminositySoftMaskPdf, tilingPatternPdf,
  tilingPatternOffsetClipPdf, strokePatternPdf, blendModePdf, isolatedGroupPdf,
  isolatedBlendGroupPdf, nonIsolatedGroupPdf, nestedClipPdf,
} from './build-transparency-fixtures.js';
import type { Probe } from './compare-image.js';

export interface GoldenFixture {
  /** File stem under test/fixtures/svg/. */
  name: string;
  pdf: () => Uint8Array;
  width: number;
  height: number;
  /** Flat-interior points whose composite value is a mathematical constant. */
  probes: Probe[];
  /** Whole-image failing-pixel budget, as a fraction. This is the LOOSE axis —
   *  it exists to catch gross geometry drift, and antialiasing along colour
   *  boundaries is what consumes it, so the budget scales with edge density, not
   *  with how correct the fixture is. Defaults to DEFAULT_MAX_FAIL_FRACTION;
   *  raise it only with a comment saying why the fixture has many edges. */
  maxFailFraction?: number;
}

/** Budget for a fixture that is mostly large flat regions. */
export const DEFAULT_MAX_FAIL_FRACTION = 0.02;

/** A 100×100 page tiled with 10×10 cells has ~1900 pixels on a colour boundary,
 *  so edge antialiasing alone accounts for roughly a fifth of the image. The
 *  probes are what verify these fixtures; a mis-phased lattice would show
 *  maxDelta near 255, where the observed cross-engine maxDelta is 28. */
const DENSE_TILING = 0.25;

const W = [255, 255, 255] as [number, number, number];
const RED = [255, 0, 0] as [number, number, number];
const BLUE = [0, 0, 255] as [number, number, number];
const CYAN = [0, 255, 255] as [number, number, number];
const YELLOW = [255, 255, 0] as [number, number, number];
const GREEN = [0, 255, 0] as [number, number, number];

/** Backdrop cb = 0.5 in every channel, source cs = (1,0,0), both opaque.
 *  Values are the ISO 32000-1 §11.3.5.2 formulas evaluated by hand. */
const SEPARABLE: [string, [number, number, number]][] = [
  ['Multiply',   [128,   0,   0]],
  ['Screen',     [255, 128, 128]],
  ['Darken',     [128,   0,   0]],
  ['Lighten',    [255, 128, 128]],
  ['Difference', [128, 128, 128]],
  ['Exclusion',  [128, 128, 128]],
];

export const GOLDEN_FIXTURES: GoldenFixture[] = [
  {
    name: 'constant-alpha',
    pdf: constantAlphaPdf,
    width: 200, height: 200,
    probes: [
      { x: 100, y: 100, rgb: [255, 128, 128], note: 'ca 0.5 red over white' },
      { x: 10, y: 10, rgb: W, note: 'outside the square' },
    ],
  },
  {
    name: 'soft-mask-luminosity',
    pdf: luminositySoftMaskPdf,
    width: 200, height: 200,
    probes: [
      { x: 50, y: 100, rgb: [255, 0, 0], note: 'under the white half of the mask' },
      { x: 150, y: 100, rgb: W, note: 'under the black half of the mask' },
    ],
  },
  {
    name: 'tiling-pattern',
    pdf: tilingPatternPdf,
    width: 100, height: 100,
    maxFailFraction: DENSE_TILING,
    probes: [
      { x: 5, y: 95, rgb: BLUE, note: 'user (5,5) in-cell' },
      { x: 15, y: 85, rgb: W, note: 'user (15,15) gap' },
      { x: 45, y: 55, rgb: BLUE, note: 'user (45,45) third tile' },
    ],
  },
  {
    name: 'tiling-pattern-offset-clip',
    pdf: tilingPatternOffsetClipPdf,
    width: 100, height: 100,
    maxFailFraction: DENSE_TILING,
    probes: [
      { x: 45, y: 55, rgb: BLUE, note: 'user (45,45) in-cell inside the clip' },
      { x: 55, y: 45, rgb: W, note: 'user (55,55) gap' },
      { x: 65, y: 35, rgb: BLUE, note: 'user (65,65) in-cell' },
      { x: 5, y: 95, rgb: W, note: 'user (5,5) outside the clip' },
      { x: 95, y: 5, rgb: W, note: 'user (95,95) outside the clip' },
    ],
  },
  {
    name: 'stroke-pattern',
    pdf: strokePatternPdf,
    width: 100, height: 100,
    probes: [
      { x: 50, y: 50, rgb: BLUE, note: 'inside the stroke band' },
      { x: 50, y: 10, rgb: W, note: 'above the stroke band' },
    ],
  },
  {
    name: 'isolated-group',
    pdf: isolatedGroupPdf,
    width: 200, height: 200,
    probes: [
      // Drawn inline the overlap composites twice and reads (255,64,64).
      { x: 80, y: 120, rgb: [255, 128, 128], note: 'overlap — must not double-darken' },
      { x: 30, y: 170, rgb: [255, 128, 128], note: 'non-overlapping part' },
    ],
  },
  {
    name: 'non-isolated-group',
    pdf: () => nonIsolatedGroupPdf('absent'),
    width: 200, height: 200,
    probes: [
      // /I absent is the spec default (false) and the ordinary /Group form.
      // Before bbu this drew inline and the overlap read (255,64,64).
      { x: 80, y: 120, rgb: [255, 128, 128], note: 'overlap — must not double-darken' },
      { x: 30, y: 170, rgb: [255, 128, 128], note: 'non-overlapping part' },
    ],
  },
  {
    name: 'nested-clip',
    pdf: nestedClipPdf,
    width: 100, height: 100,
    // Two clip edges (x=60, y=60) bound the red corner; a modest budget above
    // the flat-fixture default covers their antialiasing.
    maxFailFraction: 0.05,
    probes: [
      { x: 30, y: 70, rgb: RED, note: 'user (30,30) inside both clips' },
      // The load-bearing probe: inner band minus enclosing band. Chained, this
      // is intersected away and reads white; drop the chain and the leaf is
      // clipped to the inner band alone and it paints red.
      { x: 85, y: 70, rgb: W, note: 'user (85,30) inside inner, outside enclosing' },
      { x: 30, y: 15, rgb: W, note: 'user (30,85) inside enclosing, outside inner' },
      { x: 85, y: 15, rgb: W, note: 'user (85,85) outside both' },
    ],
  },
  ...SEPARABLE.map(([mode, rgb]) => ({
    name: `blend-${mode.toLowerCase()}`,
    pdf: () => blendModePdf(mode),
    width: 100, height: 100,
    probes: [{ x: 50, y: 50, rgb, note: `${mode} of cs=(1,0,0) over cb=0.5` }],
  })),
  {
    name: 'blend-luminosity',
    pdf: () => blendModePdf('Luminosity'),
    width: 100, height: 100,
    // Neutral gray backdrop has no hue; source luminance is 0.3·1 → 77.
    probes: [{ x: 50, y: 50, rgb: [77, 77, 77], note: 'Luminosity → neutral gray 0.3' }],
  },
  {
    name: 'isolated-blend-group',
    pdf: () => isolatedBlendGroupPdf(true),
    width: 200, height: 200,
    probes: [
      // Isolated, the inner multiply sees a transparent backdrop and is a
      // no-op. Drawn against the page it would read (0,255,0).
      { x: 100, y: 100, rgb: CYAN, note: 'inner blend sees the group backdrop, not the page' },
      { x: 20, y: 20, rgb: YELLOW, note: 'page backdrop outside the group' },
    ],
  },
  {
    name: 'non-isolated-blend-group',
    pdf: () => isolatedBlendGroupPdf(false),
    width: 200, height: 200,
    probes: [
      // The mirror image of isolated-blend-group. Not isolated, the inner
      // Multiply sees the yellow page and cyan × yellow reads green. Rendered
      // isolated it would read (0,255,255) — which is what ToSvg emits today,
      // because the /BBox clip wrapper establishes a stacking context (7wg).
      { x: 100, y: 100, rgb: GREEN, note: 'inner blend must reach the page backdrop' },
      { x: 20, y: 20, rgb: YELLOW, note: 'page backdrop outside the group' },
    ],
  },
];
