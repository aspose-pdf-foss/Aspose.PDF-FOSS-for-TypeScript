# Text Decoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `underline`, `strikethrough`, `background` and `behind` to the text-authoring layer (`page.AddText` / `page.AddTextBlock`) and forward them through every consumer that owns its own options type.

**Architecture:** A new dependency-free `src/textdecor.ts` turns font metrics into rectangles; `src/stamp.ts`'s four body builders sandwich their existing `BT … ET` between an optional background layer and an optional rules layer, without modifying the `BT … ET` region itself. `behind` selects `prependContent` over `appendContent` for the stamp's single content splice.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. Zero runtime dependencies.

Spec: [docs/superpowers/specs/2026-07-28-text-decoration-design.md](../specs/2026-07-28-text-decoration-design.md).
Issue: `aspose-pdf-foss-for-ts-1gg0.4`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { x } from './textdecor.js'`).
- **strict TypeScript.** `npm run typecheck` must be green before any task is considered done.
- **TDD.** Write the failing test, run it, watch it fail, then implement.
- **Errors are `TypeError`** for bad option values, thrown by the existing `normalizeOptions` / `normalizeBlockOptions` / `validateStyleOpts` paths *before* any document mutation.
- **Undecorated output must stay byte-identical.** Every existing `AddText` / `AddTextBlock` call emits exactly the bytes it does today. Task 3 adds the regression test that locks this in.
- **`background` means the cell box fill in `tableauthor.ts`** and is already taken. The text-level option is named `textBackground` there, and only there.
- Run `npm run typecheck` and `npm test` before closing the issue; both must be green.

---

### Task 1: Font vertical metrics

**Files:**
- Modify: `src/sfnt.ts` (the `SfntFont` field block near line 45, and the OS/2 + `post` parsing near lines 405-425)
- Create: `src/textdecor.ts`
- Test: `test/textdecor.test.ts`

**Interfaces:**
- Consumes: `SfntFont` (`src/sfnt.ts`), `EmbeddedFont` (`src/embeddedfont.ts`), `AuthoringFont` (`src/stamp.ts`, type-only), `getStd14Sfnt` (`src/std14fonts.ts`).
- Produces:
  - `SfntFont.underlinePosition`, `.underlineThickness`, `.strikeoutPosition`, `.strikeoutSize` — numbers in font units, `0` when the source table is absent.
  - `export interface VMetrics { ascent; descent; underlineOffset; underlineThickness; strikeOffset; strikeThickness }` — all em fractions, baseline = 0, positive up; `descent` negative.
  - `export function vmetricsFor(font: AuthoringFont): VMetrics`

Note on imports: `textdecor.ts` imports `AuthoringFont` with `import type` (erased at compile time) and `EmbeddedFont` as a value for `instanceof`. `embeddedfont.ts` does not import `stamp.ts`, so there is no runtime cycle even though `stamp.ts` will import `textdecor.ts` in Task 3.

- [ ] **Step 1: Write the failing test**

Create `test/textdecor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { vmetricsFor } from '../src/textdecor.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import type { StdFont } from '../src/metrics.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/textdecor.test.ts`
Expected: FAIL — `Failed to resolve import "../src/textdecor.js"`.

- [ ] **Step 3: Add the four metric fields to `SfntFont`**

In `src/sfnt.ts`, extend the field block (currently `ascent = 0; descent = 0; capHeight = 0; italicAngle = 0; flags = 0; stemV = 0;`) with:

```ts
  /** @internal `post` underline metrics in font units; 0 when the table is absent. */
  underlinePosition = 0; underlineThickness = 0;
  /** @internal OS/2 strikeout metrics in font units; 0 when the table is absent. */
  strikeoutPosition = 0; strikeoutSize = 0;
```

In the OS/2 branch of the parse function, after the `capHeight` line, add (guarding the length, since `yStrikeout*` sit at offsets 26/28 and a truncated OS/2 must not throw):

```ts
    if (os2.length >= 30) {
      f.strikeoutSize = ov.getInt16(26);
      f.strikeoutPosition = ov.getInt16(28);
    }
```

In the `post` branch, after the `italicAngle` line, add (`underlinePosition`/`underlineThickness` are FWords at offsets 8 and 10 of the same record):

```ts
    if (post.length >= 12) {
      f.underlinePosition = pv.getInt16(8);
      f.underlineThickness = pv.getInt16(10);
    }
```

- [ ] **Step 4: Create `src/textdecor.ts` with the metrics half**

```ts
import { EmbeddedFont } from './embeddedfont.js';
import type { AuthoringFont } from './stamp.js';

/** A font's vertical metrics as em fractions: baseline = 0, positive up.
 *  `descent` is negative. Scale by fontSize for points. */
export interface VMetrics {
  ascent: number;
  descent: number;
  underlineOffset: number;
  underlineThickness: number;
  strikeOffset: number;
  strikeThickness: number;
}

/** Used when a font supplies nothing usable (no `post`, no OS/2, zeroed entries). */
const FALLBACK: VMetrics = {
  ascent: 0.75, descent: -0.25,
  underlineOffset: -0.1, underlineThickness: 0.05,
  strikeOffset: 0.25, strikeThickness: 0.05,
};

/** Adobe AFM vertical metrics per 1000-unit em, by Standard-14 family. All 12
 *  Latin faces fall into three families; bold/italic differ from their family's
 *  roman by under 2% of an em, which is invisible at any realistic size. */
const STD14_V: Record<'Helvetica' | 'Times' | 'Courier',
  { ascent: number; descent: number; capHeight: number }> = {
  Helvetica: { ascent: 718, descent: -207, capHeight: 718 },
  Times:     { ascent: 683, descent: -217, capHeight: 662 },
  Courier:   { ascent: 629, descent: -157, capHeight: 562 },
};

/** UnderlinePosition / UnderlineThickness are identical across all 12 AFMs. */
const STD14_UL_POSITION = -100;
const STD14_UL_THICKNESS = 50;

/** The AFMs carry no strikeout entry; half the cap height is the usual choice. */
function std14VMetrics(font: string): VMetrics {
  const fam = font.startsWith('Times') ? 'Times'
    : font.startsWith('Courier') ? 'Courier' : 'Helvetica';
  const v = STD14_V[fam];
  return {
    ascent: v.ascent / 1000,
    descent: v.descent / 1000,
    underlineOffset: STD14_UL_POSITION / 1000,
    underlineThickness: STD14_UL_THICKNESS / 1000,
    strikeOffset: v.capHeight / 2000,
    strikeThickness: STD14_UL_THICKNESS / 1000,
  };
}

/** A zero entry means "the table was absent or said nothing"; fall back rather
 *  than emit a zero-thickness rule that paints nothing. */
const or = (v: number, dflt: number): number => (v ? v : dflt);

function embeddedVMetrics(f: EmbeddedFont): VMetrics {
  const s = f.sfnt;
  const upem = s.unitsPerEm || 1000;
  const ut = or(s.underlineThickness / upem, FALLBACK.underlineThickness);
  return {
    ascent: or(s.ascent / upem, FALLBACK.ascent),
    // Some fonts store a positive descender; normalize the sign so the
    // background rect always extends downward from the baseline.
    descent: -Math.abs(or(s.descent / upem, FALLBACK.descent)),
    underlineOffset: or(s.underlinePosition / upem, FALLBACK.underlineOffset),
    underlineThickness: ut,
    strikeOffset: or(s.strikeoutPosition / upem,
      or(s.capHeight / upem / 2, FALLBACK.strikeOffset)),
    strikeThickness: or(s.strikeoutSize / upem, ut),
  };
}

/** Vertical metrics for an authoring font: AFM constants for a Standard-14
 *  face, the font's own `post`/OS/2 tables for an embedded handle. */
export function vmetricsFor(font: AuthoringFont): VMetrics {
  return font instanceof EmbeddedFont ? embeddedVMetrics(font) : std14VMetrics(font);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/textdecor.test.ts`
Expected: PASS, 5 tests.

If the cross-check fails, the substitute faces disagree with the AFM values by more than 8% of an em. Do **not** loosen the tolerance to make it green — read the actual `sfnt.ascent / upem` values it reports and correct the `STD14_V` table, since the substitutes are the more trustworthy source at that point.

- [ ] **Step 6: Add the embedded-font metric test**

Append to `test/textdecor.test.ts`:

```ts
import { EmbeddedFont } from '../src/embeddedfont.js';
import { parseSfnt } from '../src/sfnt.js';
import { buildOtFontFor } from './helpers/build-sfnt.js';

describe('vmetricsFor: embedded fonts', () => {
  it('reads the font\'s own tables, scaled by unitsPerEm', () => {
    const sfnt = parseSfnt(buildOtFontFor({ cmap: new Map([[65, 1]]) }));
    const vm = vmetricsFor(new EmbeddedFont(sfnt));
    const upem = sfnt.unitsPerEm || 1000;
    if (sfnt.underlineThickness)
      expect(vm.underlineThickness).toBeCloseTo(sfnt.underlineThickness / upem, 6);
    expect(vm.descent).toBeLessThanOrEqual(0);
    expect(vm.ascent).toBeGreaterThan(0);
    expect(vm.underlineThickness).toBeGreaterThan(0);
    expect(vm.strikeThickness).toBeGreaterThan(0);
  });

  it('falls back when the tables say nothing', () => {
    const sfnt = parseSfnt(buildOtFontFor({ cmap: new Map([[65, 1]]) }));
    sfnt.underlinePosition = 0; sfnt.underlineThickness = 0;
    sfnt.strikeoutPosition = 0; sfnt.strikeoutSize = 0;
    sfnt.ascent = 0; sfnt.descent = 0; sfnt.capHeight = 0;
    const vm = vmetricsFor(new EmbeddedFont(sfnt));
    expect(vm).toEqual({
      ascent: 0.75, descent: -0.25,
      underlineOffset: -0.1, underlineThickness: 0.05,
      strikeOffset: 0.25, strikeThickness: 0.05,
    });
  });

  it('normalizes a positive stored descender to point downward', () => {
    const sfnt = parseSfnt(buildOtFontFor({ cmap: new Map([[65, 1]]) }));
    sfnt.descent = 200; // some fonts store it unsigned
    expect(vmetricsFor(new EmbeddedFont(sfnt)).descent).toBeLessThan(0);
  });
});
```

- [ ] **Step 7: Run the tests and the typechecker**

Run: `npx vitest run test/textdecor.test.ts && npm run typecheck`
Expected: PASS, 8 tests; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/sfnt.ts src/textdecor.ts test/textdecor.test.ts
git commit -m "feat(textdecor): font vertical metrics for decoration geometry (1gg0.4)"
```

---

### Task 2: Decoration resolution and rect emission

**Files:**
- Modify: `src/textdecor.ts`
- Test: `test/textdecor.test.ts`

**Interfaces:**
- Consumes: `VMetrics`, `vmetricsFor` (Task 1); `num` (`src/pagecontent.ts`).
- Produces:
  - `export interface DecorationStyle { color?: [number,number,number]; thickness?: number; offset?: number }`
  - `export interface BackgroundStyle { color: [number,number,number]; padding?: number }`
  - `export type Decoration = boolean | DecorationStyle`
  - `export type Background = [number,number,number] | BackgroundStyle`
  - `export interface DecorationOptions { underline?: Decoration; strikethrough?: Decoration; background?: Background }` — `StampOptions` will extend this in Task 3.
  - `export interface LineBox { x: number; baseline: number; width: number }`
  - `export interface ResolvedDecor` (opaque to callers beyond being passed back to `decorRects`)
  - `export function resolveDecor(o, textColor, fontSize, vm): ResolvedDecor | undefined`
  - `export function decorRects(lines: readonly LineBox[], d: ResolvedDecor): { beneath: string; above: string }`
  - `export function validateDecoration(label: string, d: Decoration | undefined): void`
  - `export function validateBackground(label: string, b: Background | undefined): void`

Note: `decorRects` takes no `fontSize` — the design spec sketched one, but `resolveDecor` already bakes every em fraction into points, so passing it again would be a second source of truth. The two validators are exported because `tableauthor.ts` (Task 6) validates its own cascade and must not re-implement them.

- [ ] **Step 1: Write the failing test**

Append to `test/textdecor.test.ts`:

```ts
import { resolveDecor, decorRects, validateDecoration, validateBackground } from '../src/textdecor.js';

const BLACK: [number, number, number] = [0, 0, 0];
const HELV = vmetricsFor('Helvetica');
// One line, 100pt wide, baseline at the origin.
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
    expect(d.background).toEqual({ color: [1, 1, 0], padding: 0, top: 7.18, bottom: -2.07 });
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
    expect(() => validateDecoration('underline', { color: [2, 0, 0] } as never))
      .toThrow(/underline\.color/);
    expect(() => validateDecoration('underline', { thickness: -1 })).toThrow(/underline\.thickness/);
    expect(() => validateDecoration('underline', { offset: NaN })).toThrow(/underline\.offset/);
    expect(() => validateBackground('background', { padding: -1 } as never))
      .toThrow(/background\.color/);
    expect(() => validateBackground('background', { color: [1, 1, 0], padding: -1 }))
      .toThrow(/background\.padding/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/textdecor.test.ts`
Expected: FAIL — `resolveDecor is not exported by ../src/textdecor.js`.

- [ ] **Step 3: Implement the resolution and emission half**

Append to `src/textdecor.ts`:

```ts
import { num } from './pagecontent.js';

/** A rule drawn beneath (underline) or through (strikethrough) the text. */
export interface DecorationStyle {
  /** RGB in 0..1. Default: the text's own `color`. */
  color?: [number, number, number];
  /** Rule thickness in points. Default: from the font's metrics. */
  thickness?: number;
  /** Baseline-relative offset in points, positive up. Default: from the font's metrics. */
  offset?: number;
}

/** A fill painted behind the glyphs. */
export interface BackgroundStyle {
  /** RGB in 0..1. */
  color: [number, number, number];
  /** Points added on all four sides of the text-tight rect. Default 0. */
  padding?: number;
}

/** `true` uses the font's metrics and the text's own colour; `false` is off. */
export type Decoration = boolean | DecorationStyle;
/** A bare RGB tuple, or the object form when `padding` is wanted. */
export type Background = [number, number, number] | BackgroundStyle;

/** The decoration options shared by every text-authoring options type. */
export interface DecorationOptions {
  /** Rule below the baseline. Default: none. */
  underline?: Decoration;
  /** Rule through the glyphs. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the glyphs. Default: none. */
  background?: Background;
}

/** One laid line, in whatever frame the caller emits its `cm` for. */
export interface LineBox { x: number; baseline: number; width: number }

/** @internal A rule with every value resolved to points. */
interface ResolvedRule { color: [number, number, number]; thickness: number; offset: number }

/** @internal A call's decoration with every em fraction baked into points.
 *  `top`/`bottom` are the background's baseline-relative extent. */
export interface ResolvedDecor {
  underline?: ResolvedRule;
  strikethrough?: ResolvedRule;
  background?: { color: [number, number, number]; padding: number; top: number; bottom: number };
}

function checkColor(label: string, rgb: unknown): void {
  if (!Array.isArray(rgb) || rgb.length !== 3 ||
      !rgb.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError(`${label} must be [r, g, b] with each component in 0..1`);
}

function checkNonNeg(label: string, n: unknown): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0)
    throw new TypeError(`${label} must be a non-negative finite number`);
}

/** Validate an `underline`/`strikethrough` option. `label` names it in the error. */
export function validateDecoration(label: string, d: Decoration | undefined): void {
  if (d === undefined || typeof d === 'boolean') return;
  if (typeof d !== 'object' || d === null || Array.isArray(d))
    throw new TypeError(`${label} must be a boolean or a { color, thickness, offset } object`);
  if (d.color !== undefined) checkColor(`${label}.color`, d.color);
  if (d.thickness !== undefined) checkNonNeg(`${label}.thickness`, d.thickness);
  if (d.offset !== undefined && (typeof d.offset !== 'number' || !Number.isFinite(d.offset)))
    throw new TypeError(`${label}.offset must be a finite number`);
}

/** Validate a `background` option in either its tuple or object form. */
export function validateBackground(label: string, b: Background | undefined): void {
  if (b === undefined) return;
  if (Array.isArray(b)) { checkColor(`${label}.color`, b); return; }
  if (typeof b !== 'object' || b === null)
    throw new TypeError(`${label} must be [r, g, b] or a { color, padding } object`);
  checkColor(`${label}.color`, b.color);
  if (b.padding !== undefined) checkNonNeg(`${label}.padding`, b.padding);
}

function resolveRule(
  d: Decoration, textColor: [number, number, number], fontSize: number,
  offsetEm: number, thicknessEm: number,
): ResolvedRule {
  const s: DecorationStyle = typeof d === 'boolean' ? {} : d;
  return {
    color: s.color ?? textColor,
    thickness: s.thickness ?? thicknessEm * fontSize,
    offset: s.offset ?? offsetEm * fontSize,
  };
}

/** Resolve a call's decoration options into points, or `undefined` when the call
 *  asks for no decoration at all — the fast path every existing call takes.
 *  Validates first, so a bad option throws before anything is drawn. */
export function resolveDecor(
  o: DecorationOptions, textColor: [number, number, number], fontSize: number, vm: VMetrics,
): ResolvedDecor | undefined {
  validateDecoration('underline', o.underline);
  validateDecoration('strikethrough', o.strikethrough);
  validateBackground('background', o.background);

  const d: ResolvedDecor = {};
  if (o.underline)
    d.underline = resolveRule(o.underline, textColor, fontSize,
      vm.underlineOffset, vm.underlineThickness);
  if (o.strikethrough)
    d.strikethrough = resolveRule(o.strikethrough, textColor, fontSize,
      vm.strikeOffset, vm.strikeThickness);
  if (o.background) {
    const b: BackgroundStyle = Array.isArray(o.background) ? { color: o.background } : o.background;
    d.background = {
      color: b.color,
      padding: b.padding ?? 0,
      top: vm.ascent * fontSize,
      bottom: vm.descent * fontSize,
    };
  }
  return d.underline || d.strikethrough || d.background ? d : undefined;
}

const fillColorOp = (c: [number, number, number]): string =>
  `${num(c[0])} ${num(c[1])} ${num(c[2])} rg\n`;

const rectOp = (x: number, y: number, w: number, h: number): string =>
  `${num(x)} ${num(y)} ${num(w)} ${num(h)} re f\n`;

function ruleOps(lines: readonly LineBox[], r: ResolvedRule): string {
  let s = '';
  for (const l of lines) {
    if (!(l.width > 0) || !(r.thickness > 0)) continue;
    s += rectOp(l.x, l.baseline + r.offset - r.thickness / 2, l.width, r.thickness);
  }
  return s ? fillColorOp(r.color) + s : '';
}

/** Content-stream operators for the two decoration layers, in the same frame as
 *  `lines`. `beneath` paints before the glyphs, `above` after them. Either may
 *  be `''`. Zero-width lines and zero-thickness rules paint nothing. */
export function decorRects(
  lines: readonly LineBox[], d: ResolvedDecor,
): { beneath: string; above: string } {
  let beneath = '';
  if (d.background) {
    const bg = d.background;
    const h = bg.top - bg.bottom + 2 * bg.padding;
    let s = '';
    for (const l of lines) {
      if (!(l.width > 0) || !(h > 0)) continue;
      s += rectOp(l.x - bg.padding, l.baseline + bg.bottom - bg.padding,
        l.width + 2 * bg.padding, h);
    }
    if (s) beneath = fillColorOp(bg.color) + s;
  }
  return { beneath, above: ruleOps(lines, d.underline ?? EMPTY_RULE) + ruleOps(lines, d.strikethrough ?? EMPTY_RULE) };
}

/** A rule that paints nothing, so `decorRects` needs no per-layer branch. */
const EMPTY_RULE: ResolvedRule = { color: [0, 0, 0], thickness: 0, offset: 0 };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/textdecor.test.ts && npm run typecheck`
Expected: PASS, 18 tests; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/textdecor.ts test/textdecor.test.ts
git commit -m "feat(textdecor): resolve decoration options into rect operators (1gg0.4)"
```

---

### Task 3: Wire the single-line path in `stamp.ts`

**Files:**
- Modify: `src/stamp.ts` (`StampOptions`, `NormalizedOptions`, `normalizeOptions`, `buildStampBody`, `buildShapedStampBody`, `stampText`)
- Test: `test/text-decoration.test.ts`

**Interfaces:**
- Consumes: `DecorationOptions`, `ResolvedDecor`, `resolveDecor`, `decorRects`, `vmetricsFor`, `LineBox` (Tasks 1-2); `prependContent` (`src/pagecontent.ts`).
- Produces:
  - `StampOptions extends DecorationOptions`, plus `behind?: boolean`.
  - `NormalizedOptions` gains `behind: boolean` and `decor: ResolvedDecor | undefined`.
  - `stampText`'s `splice` parameter becomes optional (`splice?: ContentSplice`) with no default; `behind` resolves it when the caller passes none.

- [ ] **Step 1: Write the failing test**

Create `test/text-decoration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

/** Byte offset of the first `BT` in the page's content, for ordering checks. */
const btAt = (c: string) => c.indexOf('BT');
const etAt = (c: string) => c.lastIndexOf('ET');

describe('AddText decoration', () => {
  it('draws the background before BT and the rules after ET', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100, {
      underline: true, strikethrough: true, background: [1, 1, 0],
    });
    const c = decoded(page);
    const bgAt = c.indexOf('1 1 0 rg');
    expect(bgAt).toBeGreaterThan(-1);
    expect(bgAt).toBeLessThan(btAt(c));
    // Two rules, both after ET.
    const rules = [...c.matchAll(/re f/g)].map((m) => m.index!);
    expect(rules.filter((i) => i > etAt(c))).toHaveLength(2);
  });

  it('keeps decoration inside the stamp\'s outer q/Q', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100, { underline: true });
    const c = decoded(page);
    expect(c.startsWith('q')).toBe(true);
    expect(c.trimEnd().endsWith('Q')).toBe(true);
  });

  it('rotates the rules with the text (same matrix as Tm)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100, { rotate: 90, underline: true });
    const c = decoded(page);
    const tm = /([-\d. ]+) Tm/.exec(c)![1].trim();
    expect(c).toContain(`${tm} cm`);
  });

  it('an explicit style overrides colour and thickness', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddText('Hi', 10, 10, { underline: { color: [1, 0, 0], thickness: 2, offset: -4 } });
    const c = decoded(page);
    expect(c).toContain('1 0 0 rg');
    expect(c).toContain('0 -5 '); // offset -4 - thickness/2
  });

  it('rejects a bad decoration before touching the page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const before = decoded(page);
    expect(() => page.AddText('Hi', 10, 10, { underline: { thickness: -1 } }))
      .toThrow(TypeError);
    expect(decoded(page)).toBe(before);
  });
});

describe('AddText behind', () => {
  it('places the stamp before existing content', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Under', 10, 10, { behind: true });
    const c = decoded(page);
    expect(c.indexOf('Under')).toBeLessThan(c.indexOf('Original'));
  });

  it('defaults to drawing on top', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Over', 10, 10);
    const c = decoded(page);
    expect(c.indexOf('Over')).toBeGreaterThan(c.indexOf('Original'));
  });

  it('is a plain draw on an empty page', () => {
    const a = Document.Open(buildBlankPage());
    a.Pages[0].AddText('Hi', 10, 10, { behind: true });
    const b = Document.Open(buildBlankPage());
    b.Pages[0].AddText('Hi', 10, 10);
    expect(decoded(a.Pages[0])).toBe(decoded(b.Pages[0]));
  });
});

describe('undecorated output is unchanged', () => {
  it('AddText emits the pre-change byte sequence', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddText('Hi', 100, 100);
    expect(decoded(doc.Pages[0])).toBe(
      'q\nBT\n/F0 12 Tf\n0 0 0 rg\n1 0 0 1 100 100 Tm\n(Hi) Tj\nET\nQ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/text-decoration.test.ts`
Expected: FAIL — the decoration tests fail (no `1 1 0 rg` in the stream) and the `behind` tests fail (`behind` is not a known option). The "undecorated output is unchanged" test should **PASS** already; if it does not, fix the expected string to the current output *before* touching `stamp.ts`, so it is a true baseline.

- [ ] **Step 3: Extend the options and normalization**

In `src/stamp.ts`, add to the imports:

```ts
import { appendContent, prependContent } from './pagecontent.js';   // extend the existing import
import {
  resolveDecor, decorRects, vmetricsFor,
  type DecorationOptions, type ResolvedDecor, type LineBox,
} from './textdecor.js';
```

Change the `StampOptions` declaration to extend `DecorationOptions` and add `behind`:

```ts
export interface StampOptions extends DecorationOptions {
  // ... every existing member unchanged ...
  /** Draw this stamp beneath existing page content instead of on top of it.
   *  Default false. On a page with no content yet this is a plain draw. */
  behind?: boolean;
}
```

Extend `NormalizedOptions`:

```ts
interface NormalizedOptions {
  font: AuthoringFont;
  fontSize: number;
  color: [number, number, number];
  rotate: number;
  opacity: number;
  align: 'left' | 'center' | 'right';
  behind: boolean;
  decor: ResolvedDecor | undefined;
}
```

At the end of `normalizeOptions`, before the return, add:

```ts
  const behind = o.behind ?? false;
  if (typeof behind !== 'boolean') throw new TypeError('behind must be a boolean');
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(font));
  return { font, fontSize, color, rotate, opacity, align, behind, decor };
```

- [ ] **Step 4: Decorate the two single-line body builders**

In `buildStampBody`, replace the body-assembly block. The `BT … ET` region is unchanged; only the wrapper gains layers:

```ts
  const mat = `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)}`;
  const dec = o.decor ? decorRects([{ x: 0, baseline: 0, width }], o.decor) : undefined;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec?.beneath) s += `q\n${mat} cm\n${dec.beneath}Q\n`;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  s += `${mat} Tm\n`;
  s += `${serializeString(bytes)} Tj\n`;
  s += 'ET\n';
  if (dec?.above) s += `q\n${mat} cm\n${dec.above}Q\n`;
  s += 'Q';
  return enc(s);
```

Note `s += 'ET\n'` followed by `s += 'Q'` produces exactly the `ET\nQ` the old single statement did, so an undecorated stamp is byte-identical. The `mat` local also replaces the inline `Tm` operand string — same characters, one source.

Apply the identical treatment to `buildShapedStampBody`, whose only difference is `s += inner;` (already newline-terminated) in place of the `Tj` line.

- [ ] **Step 5: Resolve the splice from `behind`**

Change `stampText`'s signature and add the resolution. The parameter loses its default so an explicit caller-supplied splice (`decorate.ts`'s underlay watermark) still wins:

```ts
export function stampText(
  doc: Document, page: Page, text: string, x: number, y: number, options: StampOptions = {},
  splice?: ContentSplice,
): void {
  const o = normalizeOptions(options);
  const put = splice ?? (o.behind ? prependContent : appendContent);
  // ... both branches: replace every `splice(doc, page, tagged)` with `put(doc, page, tagged)`
```

There are two `splice(doc, page, tagged)` call sites (the shaped early-return branch and the plain path). Both become `put(...)`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/text-decoration.test.ts && npm run typecheck`
Expected: PASS, 9 tests; typecheck clean.

- [ ] **Step 7: Run the full suite to catch collateral damage**

Run: `npm test`
Expected: PASS. `test/stamp.test.ts`, `test/decorate-*.test.ts` and `test/toc*.test.ts` all assert on emitted content and are the ones that would catch an accidental byte change.

- [ ] **Step 8: Commit**

```bash
git add src/stamp.ts test/text-decoration.test.ts
git commit -m "feat(stamp): underline/strikethrough/background/behind on AddText (1gg0.4)"
```

---

### Task 4: Wire the block path in `stamp.ts`

**Files:**
- Modify: `src/stamp.ts` (`NormalizedBlockOptions`, `normalizeBlockOptions`, `buildBlockBody`, `buildShapedBlockBody`, `flowTextBlock`)
- Test: `test/text-decoration.test.ts`

**Interfaces:**
- Consumes: everything from Task 3.
- Produces: `NormalizedBlockOptions` gains `behind: boolean` and `decor: ResolvedDecor | undefined`. `TextBlockOptions` needs no declaration change — it already reads `Omit<StampOptions, 'align' | 'rotate'>`, which carries the four new options through.

- [ ] **Step 1: Write the failing test**

Append to `test/text-decoration.test.ts`:

```ts
describe('AddTextBlock decoration', () => {
  it('emits one underline per laid line', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('one two three four five six seven eight',
      [50, 500, 80, 200], { fontSize: 10, underline: true });
    const c = decoded(page);
    const lines = (c.match(/Tj/g) ?? []).length;
    expect(lines).toBeGreaterThan(1);
    expect((c.match(/re f/g) ?? []).length).toBe(lines);
  });

  it('a justified line is decorated to the full box width', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('alpha beta gamma delta epsilon zeta eta theta',
      [50, 500, 120, 200], { fontSize: 10, align: 'justify', underline: true });
    const c = decoded(page);
    // At least one rule spans the full 120pt box (a Tw-justified line).
    expect(c).toMatch(/ 120 [\d.]+ re f/);
  });

  it('background sits under the whole block, rules over it', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('hello world', [50, 500, 200, 100],
      { fontSize: 10, background: [0, 1, 0], underline: true });
    const c = decoded(page);
    expect(c.indexOf('0 1 0 rg')).toBeLessThan(c.indexOf('BT'));
    expect(c.lastIndexOf('re f')).toBeGreaterThan(c.lastIndexOf('ET'));
  });

  it('honours behind', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddTextBlock('Under', [10, 10, 200, 50], { behind: true });
    const c = decoded(page);
    expect(c.indexOf('Under')).toBeLessThan(c.indexOf('Original'));
  });

  it('places the background rect where GetPaths reads it back', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTextBlock('hi', [50, 500, 200, 100],
      { fontSize: 10, valign: 'top', leading: 12, background: [0, 1, 0] });
    const paths = page.GetPaths().filter((p) => p.fill !== null);
    expect(paths).toHaveLength(1);
    const [x0, y0, x1, y1] = paths[0].bbox;
    // First baseline = rect top (600) - fontSize (10) = 590.
    // Helvetica ascent .718 / descent -.207 at 10pt.
    expect(x0).toBeCloseTo(50, 3);
    expect(y0).toBeCloseTo(590 - 2.07, 3);
    expect(y1).toBeCloseTo(590 + 7.18, 3);
    expect(x1).toBeGreaterThan(x0);
  });
});

describe('undecorated block output is unchanged', () => {
  it('AddTextBlock emits the pre-change byte sequence', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Pages[0].AddTextBlock('hi', [50, 500, 200, 100], { fontSize: 10, leading: 12 });
    expect(decoded(doc.Pages[0])).toBe(
      'q\nBT\n/F0 10 Tf\n0 0 0 rg\n50 590 Td\n(hi) Tj\nET\nQ');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/text-decoration.test.ts -t 'AddTextBlock'`
Expected: FAIL — no `re f` in the block output. As in Task 3, the "undecorated block output is unchanged" test should pass first; correct its expected string to the current output if it does not, before changing anything.

- [ ] **Step 3: Extend the block normalization**

In `src/stamp.ts`, extend `NormalizedBlockOptions`:

```ts
interface NormalizedBlockOptions {
  font: AuthoringFont;
  fontSize: number;
  color: [number, number, number];
  opacity: number;
  align: 'left' | 'center' | 'right' | 'justify';
  valign: 'top' | 'center' | 'bottom';
  leading: number;
  behind: boolean;
  decor: ResolvedDecor | undefined;
}
```

At the end of `normalizeBlockOptions`, before the return:

```ts
  const behind = o.behind ?? false;
  if (typeof behind !== 'boolean') throw new TypeError('behind must be a boolean');
  const decor = resolveDecor(o, color, fontSize, vmetricsFor(font));
  return { font, fontSize, color, opacity, align, valign, leading, behind, decor };
```

- [ ] **Step 4: Add the shared line-box helper**

Add to `src/stamp.ts`, above `buildBlockBody`:

```ts
/** The decoration boxes for a laid block, in absolute user space (the block path
 *  has no rotation, so no `cm` is needed). A justified line is drawn to the full
 *  box width — `Tw` spreads its slack — so its decoration must span `w`, not the
 *  narrower measured `line.width`. */
function blockLineBoxes(
  lines: LaidLine[], x: number, w: number, baseline0: number, o: NormalizedBlockOptions,
): LineBox[] {
  return lines.map((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    return {
      x: x + alignOffset(o.align, w, line.width),
      baseline: baseline0 - i * o.leading,
      width: tw > 0 ? w : line.width,
    };
  });
}
```

- [ ] **Step 5: Decorate the two block body builders**

In `buildBlockBody`, after `baseline0` is computed and before `let s = 'q\n';`:

```ts
  const dec = o.decor
    ? decorRects(blockLineBoxes(lines, x, w, baseline0, o), o.decor)
    : undefined;
```

Then insert the background layer right after the optional `gs` line:

```ts
  if (dec?.beneath) s += dec.beneath;
```

and replace the trailing `s += 'ET\nQ';` with:

```ts
  s += 'ET\n';
  if (dec?.above) s += dec.above;
  s += 'Q';
```

The block path needs no `q … cm … Q` wrapper: the coordinates are already absolute and `re f` does not disturb the text state. Only the fill colour changes, and the stamp's own `rg` is re-emitted inside `BT` on every call.

Apply the identical treatment to `buildShapedBlockBody`. It computes `baseline0` the same way; note it does **not** call `justifySpacing` (embedded fonts fall back to left alignment), but `blockLineBoxes` calls it and `justifySpacing` returns 0 for any non-`'justify'` align, so the shared helper is correct there without a special case.

- [ ] **Step 6: Resolve the splice in `flowTextBlock`**

`flowTextBlock` has no `splice` parameter and does not gain a public one. Inside it, after `const o = normalizeBlockOptions(options);`:

```ts
  const put = o.behind ? prependContent : appendContent;
```

and replace both `appendContent(doc, page, tagged);` call sites (the shaped branch and the plain branch) with `put(doc, page, tagged);`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/text-decoration.test.ts && npm run typecheck && npm test`
Expected: PASS, 15 tests in the new file; full suite green.

- [ ] **Step 8: Commit**

```bash
git add src/stamp.ts test/text-decoration.test.ts
git commit -m "feat(stamp): decoration and behind on AddTextBlock (1gg0.4)"
```

---

### Task 5: Forward through `flow.ts`

**Files:**
- Modify: `src/flow.ts` (`FlowParagraphOptions` near line 162, `paragraphOptions` near line 188)
- Test: `test/flow-decoration.test.ts`

**Interfaces:**
- Consumes: `Decoration`, `Background` (`src/textdecor.ts`).
- Produces: `FlowParagraphOptions` gains `underline`, `strikethrough`, `background`. `FlowHeadingOptions extends FlowParagraphOptions` inherits them with no edit.

`behind` is deliberately **not** offered: a flow lays elements into a column it is composing, and sinking one element beneath the page would reorder it against its siblings.

- [ ] **Step 1: Write the failing test**

Create `test/flow-decoration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/flow.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

// A flow is created on the Document (`NewFlow`), queued, then `Render()`ed,
// which APPENDS the laid-out pages and returns them — the decorated content is
// on the returned page, not on Pages[0].
const opts = () => ({ format: PageFormat.A4, columns: 1, margin: 72 });

describe('Flow paragraph decoration', () => {
  it('forwards underline to the laid paragraph', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('hello world', { fontSize: 12, underline: true });
    const pages = flow.Render();
    expect(decoded(pages[0])).toContain('re f');
  });

  it('forwards background and strikethrough', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('hello', { fontSize: 12, background: [0, 0, 1], strikethrough: true });
    const c = decoded(flow.Render()[0]);
    expect(c).toContain('0 0 1 rg');
    expect((c.match(/re f/g) ?? []).length).toBe(2);
  });

  it('a heading inherits the same options', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddHeading('Title', 1, { underline: true });
    expect(decoded(flow.Render()[0])).toContain('re f');
  });

  it('an undecorated paragraph emits no rects', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('hello world', { fontSize: 12 });
    expect(decoded(flow.Render()[0])).not.toContain('re f');
  });
});
```

Check `test/flow.test.ts` (its `opts()` helper and the `NewFlow` → `Render()`
tests around line 176) if the `FlowOptions` shape above needs adjusting.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow-decoration.test.ts`
Expected: FAIL — the three decoration tests find no `re f`; the fourth passes.

- [ ] **Step 3: Extend `FlowParagraphOptions`**

In `src/flow.ts`, add to the imports:

```ts
import type { Decoration, Background } from './textdecor.js';
```

and to `FlowParagraphOptions`, after `leading?: number;`:

```ts
  /** Rule below the baseline of every line. Default: none. */
  underline?: Decoration;
  /** Rule through the glyphs of every line. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind each line's text. Default: none. */
  background?: Background;
```

- [ ] **Step 4: Forward them in `paragraphOptions`**

Replace the body of `paragraphOptions`:

```ts
function paragraphOptions(o: FlowParagraphOptions): TextBlockOptions {
  return {
    font: o.font, fontSize: o.fontSize, color: o.color, align: o.align, leading: o.leading,
    underline: o.underline, strikethrough: o.strikethrough, background: o.background,
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/flow-decoration.test.ts && npm run typecheck && npm test`
Expected: PASS, 4 tests; full suite green.

- [ ] **Step 6: Commit**

```bash
git add src/flow.ts test/flow-decoration.test.ts
git commit -m "feat(flow): text decoration on paragraphs and headings (1gg0.4)"
```

---

### Task 6: Forward through the table layer

**Files:**
- Modify: `src/tableauthor.ts` (`CellTextOptions` line ~15, `ResolvedStyle` line ~69, `resolveCellStyle` line ~163, `validateStyleOpts` line ~150)
- Modify: `src/tablerender.ts` (the pass-2 `stampTextBlock` call, line ~125)
- Test: `test/table-decoration.test.ts`

**Interfaces:**
- Consumes: `Decoration`, `Background`, `validateDecoration`, `validateBackground` (`src/textdecor.ts`).
- Produces: `CellTextOptions` and `ResolvedStyle` gain `underline?: Decoration`, `strikethrough?: Decoration`, `textBackground?: Background`.

**The name is `textBackground`, not `background`.** `CellTextOptions.background` already exists and means the fill of the whole cell box. `underline` and `strikethrough` do not collide and keep their plain names.

- [ ] **Step 1: Write the failing test**

Create `test/table-decoration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

// `createTable(defaults)` takes only style defaults — column widths come from
// `setColumnWidths`, and `AddTable(table, x, top, { width })` anchors at a
// top-left point with a total width, NOT a rect.
describe('Table cell text decoration', () => {
  it('underlines a cell\'s text', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable();
    t.addRow().addCell('hi', { underline: true });
    page.AddTable(t, 50, 500, { width: 100 });
    expect(decoded(page)).toContain('re f');
  });

  it('keeps the cell background and the text background distinct', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable();
    t.addRow().addCell('hi', { background: [1, 0, 0], textBackground: [0, 0, 1] });
    page.AddTable(t, 50, 500, { width: 100 });
    const c = decoded(page);
    expect(c).toContain('1 0 0 rg');   // cell box fill
    expect(c).toContain('0 0 1 rg');   // text-tight fill
    // The cell fill is wider than the text fill.
    const fills = page.GetPaths().filter((p) => p.fill !== null);
    const widths = fills.map((p) => p.bbox[2] - p.bbox[0]).sort((a, b) => a - b);
    expect(widths.length).toBeGreaterThanOrEqual(2);
    expect(widths[0]).toBeLessThan(widths[widths.length - 1]);
  });

  it('cascades cell over row over table', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ underline: true });
    t.setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    const row = t.addRow();
    row.addCell('a');                        // inherits the table underline
    row.addCell('b', { underline: false });  // opts out
    page.AddTable(t, 50, 500, { width: 200 });
    expect((decoded(page).match(/re f/g) ?? []).length).toBe(1);
  });

  it('rejects a bad decoration with a labelled TypeError', () => {
    const t = createTable();
    expect(() => t.addRow().addCell('hi', { underline: { thickness: -1 } }))
      .toThrow(/underline\.thickness/);
  });
});
```

Note on the last test: `addCell` must validate eagerly for this to pass. Check
whether `CellBuilder`'s constructor path runs `validateStyleOpts` on per-cell
options; if validation only happens at `createTable`/`addRow` today, assert the
throw at `page.AddTable(...)` instead rather than adding a new validation site.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/table-decoration.test.ts`
Expected: FAIL — `underline` is not a known property of `CellOptions`.

- [ ] **Step 3: Extend the table style types**

In `src/tableauthor.ts`, add to the imports:

```ts
import {
  validateDecoration, validateBackground,
  type Decoration, type Background,
} from './textdecor.js';
```

Add to `CellTextOptions`, after `background?: [number, number, number];`:

```ts
  /** Rule below the baseline of the cell's text. Default: none. */
  underline?: Decoration;
  /** Rule through the cell's text. Default: none. */
  strikethrough?: Decoration;
  /** Fill behind the cell's *text* (text-tight, per line). Distinct from
   *  `background`, which fills the whole cell box. Default: none. */
  textBackground?: Background;
```

Add the same three (non-optional-key, still optional-valued) to `ResolvedStyle`:

```ts
  underline?: Decoration;
  strikethrough?: Decoration;
  textBackground?: Background;
```

- [ ] **Step 4: Extend the cascade and the validator**

In `resolveCellStyle`, add to the returned object after `background:`:

```ts
    underline: o.underline ?? row.underline ?? table.underline,
    strikethrough: o.strikethrough ?? row.strikethrough ?? table.strikethrough,
    textBackground: o.textBackground ?? row.textBackground ?? table.textBackground,
```

In `validateStyleOpts`, after the existing `background` check:

```ts
  validateDecoration('underline', o.underline);
  validateDecoration('strikethrough', o.strikethrough);
  validateBackground('textBackground', o.textBackground);
```

- [ ] **Step 5: Forward them in `tablerender.ts`**

In the pass-2 loop, extend the options object passed to `stampTextBlock`:

```ts
  for (const p of placed)
    stampTextBlock(doc, page, p.text,
      [p.x + padding, p.bottom + padding, p.w - 2 * padding, p.h - 2 * padding],
      { font: p.style.font, fontSize: p.style.fontSize, leading: p.style.leading,
        color: p.style.color, align: p.style.align, valign: p.style.valign,
        underline: p.style.underline, strikethrough: p.style.strikethrough,
        background: p.style.textBackground });
```

Note the rename crossing the boundary: the cell's `textBackground` becomes `stampTextBlock`'s `background`. That is the whole point of the distinct name — inside a cell, `background` already meant the box.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/table-decoration.test.ts && npm run typecheck && npm test`
Expected: PASS, 4 tests; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/tableauthor.ts src/tablerender.ts test/table-decoration.test.ts
git commit -m "feat(table): underline/strikethrough/textBackground in the cell style cascade (1gg0.4)"
```

---

### Task 7: Forward through `toc.ts`

**Files:**
- Modify: `src/toc.ts` (`TOCEntry.style` Pick line ~28, `RowStyle` line ~57, `rowStyle` line ~101, `rowStampOptions` line ~135, `rowBlockOptions` line ~146)
- Test: `test/toc-decoration.test.ts`

**Interfaces:**
- Consumes: `Decoration`, `Background` (`src/textdecor.ts`); `TOCOptions` already inherits the three option names through `Omit<TextBlockOptions, 'align' | 'valign' | 'tag'>`, so **no** declaration change is needed on `TOCOptions` itself — only on the per-entry `style` Pick and on `RowStyle`.
- Produces: `RowStyle` gains `underline?: Decoration; strikethrough?: Decoration; background?: Background`.

Known and accepted: a TOC row is drawn as three separate stamps (title, dot leader, page number), so an underline follows the two text runs and skips the leader between them. Document it; do not add a row-spanning code path.

- [ ] **Step 1: Write the failing test**

Create `test/toc-decoration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

describe('TOC row decoration', () => {
  it('forwards a call-level underline to every row', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'One', label: '1' }, { title: 'Two', label: '2' }],
      [50, 400, 300, 300], { underline: true });
    // Two rows x (title + number) = 4 rules; the leader is not decorated.
    expect((decoded(page).match(/re f/g) ?? []).length).toBe(4);
  });

  it('lets a per-entry style override the call default', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTOC(
      [{ title: 'One', label: '1' }, { title: 'Two', label: '2', style: { underline: false } }],
      [50, 400, 300, 300], { underline: true });
    expect((decoded(page).match(/re f/g) ?? []).length).toBe(2);
  });

  it('forwards a background', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'One', label: '1' }], [50, 400, 300, 300],
      { background: [1, 0, 1] });
    expect(decoded(page)).toContain('1 0 1 rg');
  });

  it('an undecorated TOC emits no rects', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'One', label: '1' }], [50, 400, 300, 300]);
    expect(decoded(page)).not.toContain('re f');
  });
});
```

`AddTOC(entries, rect, opts)` is correct as written. Confirm `TOCEntry`'s field
names (`title`, `label`, `style`) against `src/toc.ts`. If dot leaders themselves
emit `re f`, count the delta against the undecorated baseline instead of an
absolute count.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/toc-decoration.test.ts`
Expected: FAIL — the decorated rows emit no rects, because `rowStampOptions` copies a fixed field list.

- [ ] **Step 3: Extend the row style**

In `src/toc.ts`, add to the imports:

```ts
import type { Decoration, Background } from './textdecor.js';
```

Widen the per-entry `style` Pick on `TOCEntry`:

```ts
  /** Per-row typographic override, merged over the call defaults. */
  style?: Pick<TOCOptions,
    'font' | 'fontSize' | 'color' | 'underline' | 'strikethrough' | 'background'>;
```

Add to `RowStyle`:

```ts
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
```

In `rowStyle`, add to the returned object:

```ts
    underline: s.underline ?? opts.underline,
    strikethrough: s.strikethrough ?? opts.strikethrough,
    background: s.background ?? opts.background,
```

- [ ] **Step 4: Forward them in both options builders**

Add the same three lines to the object returned by `rowStampOptions` and to the one returned by `rowBlockOptions`:

```ts
    underline: style.underline, strikethrough: style.strikethrough,
    background: style.background,
```

Both read from the resolved `style`, not from `opts`, so a per-entry override wins.

- [ ] **Step 5: Document the leader gap**

Add to the `TOCOptions` doc comment, and to the `underline` mention in the README section written in Task 9:

```ts
/** Options for {@link Page.AddTOC}. …
 *
 *  Note: a row is drawn as three stamps (title, dot leader, page number), so
 *  `underline` and `strikethrough` follow the two text runs and skip the leader
 *  between them. `background` likewise fills behind the text, not the leader. */
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/toc-decoration.test.ts && npm run typecheck && npm test`
Expected: PASS, 4 tests; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/toc.ts test/toc-decoration.test.ts
git commit -m "feat(toc): forward text decoration to TOC rows (1gg0.4)"
```

---

### Task 8: Forward through `decorate.ts`

**Files:**
- Modify: `src/decorate.ts` (`Placement` line ~162, `normalizePlacement` line ~177, `drawText` line ~213, `WatermarkOptions` line ~309, `addWatermark` line ~337, `HeaderFooterOptions` line ~383, `addHeaderFooter`, `BatesOptions` line ~446, `addBatesNumbering`)
- Test: `test/decorate-decoration.test.ts`

**Interfaces:**
- Consumes: `Decoration`, `Background`, `validateDecoration`, `validateBackground` (`src/textdecor.ts`).
- Produces: `Placement` gains `underline?: Decoration; strikethrough?: Decoration; background?: Background`; the same three land on `WatermarkOptions`, `HeaderFooterOptions` and `BatesOptions`.

`behind` is deliberately **not** offered here. `WatermarkOptions.mode: 'overlay' | 'underlay'` already owns z-order for watermarks, and headers, footers and Bates numbers are furniture that belongs on top. `drawText` already passes an explicit splice (`p.underlay ? prependContent : appendContent`), which Task 3's `splice ?? …` resolution preserves.

- [ ] **Step 1: Write the failing test**

Create `test/decorate-decoration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import type { Page } from '../src/page.js';

const decoded = (page: Page) => new TextDecoder('latin1').decode(page.Contents);

describe('decorate.ts text decoration', () => {
  it('underlines a watermark', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddWatermark({ text: 'DRAFT', underline: true });
    expect(decoded(doc.Pages[0])).toContain('re f');
  });

  it('backgrounds a header cell', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddHeaderFooter({ header: { center: 'Title' }, background: [1, 1, 0] });
    expect(decoded(doc.Pages[0])).toContain('1 1 0 rg');
  });

  it('strikes through a Bates number', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddBatesNumbering({ strikethrough: true });
    expect(decoded(doc.Pages[0])).toContain('re f');
  });

  it('an undecorated watermark emits no rects', () => {
    const doc = Document.Open(buildDecorateTarget());
    doc.AddWatermark({ text: 'DRAFT' });
    expect(decoded(doc.Pages[0])).not.toContain('re f');
  });

  it('rejects a bad decoration before touching any page', () => {
    const doc = Document.Open(buildDecorateTarget());
    const before = decoded(doc.Pages[0]);
    expect(() => doc.AddWatermark({ text: 'DRAFT', underline: { thickness: -1 } }))
      .toThrow(/underline\.thickness/);
    expect(decoded(doc.Pages[0])).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/decorate-decoration.test.ts`
Expected: FAIL — `underline` is not a known property of `WatermarkOptions`.

- [ ] **Step 3: Extend `Placement` and its validator**

In `src/decorate.ts`, add to the imports:

```ts
import {
  validateDecoration, validateBackground,
  type Decoration, type Background,
} from './textdecor.js';
```

Add to `Placement`, after `color`:

```ts
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
```

At the end of `normalizePlacement`, before `return p;` — this is what makes the last test's "before touching any page" assertion true, since `normalizePlacement` runs before the first mutation:

```ts
  validateDecoration('underline', p.underline);
  validateDecoration('strikethrough', p.strikethrough);
  validateBackground('background', p.background);
```

- [ ] **Step 4: Forward them in `drawText`**

Extend the `stampText` options object:

```ts
  stampText(doc, page, text, x, y, {
    font: p.font,
    fontSize,
    color: p.color,
    opacity: p.opacity,
    rotate: (p.rotate ?? a.angle) + f.R,
    align: a.align,
    underline: p.underline,
    strikethrough: p.strikethrough,
    background: p.background,
  }, p.underlay ? prependContent : appendContent);
```

The explicit trailing splice stays exactly as it is — Task 3 made `splice` win over `behind`, and `decorate.ts` is the caller that relies on it.

- [ ] **Step 5: Add the three options to the three public interfaces**

Add to `WatermarkOptions`, `HeaderFooterOptions` and `BatesOptions` (all three, same wording):

```ts
  /** Rule below the baseline of the stamped text. Default: none. */
  underline?: Decoration;
  /** Rule through the stamped text. Default: none. */
  strikethrough?: Decoration;
  /** Fill painted behind the stamped text. Default: none. */
  background?: Background;
```

Then forward them into each function's `normalizePlacement({ … })` call. In `addWatermark`:

```ts
  const p = normalizePlacement({
    position: opts.position ?? 'diagonal',
    margin: opts.margin ?? 36,
    opacity: opts.opacity ?? 0.3,
    rotate: opts.rotate,
    font: opts.font ?? 'Helvetica',
    fontSize: opts.fontSize,
    color: opts.color ?? [0.5, 0.5, 0.5],
    underlay: (opts.mode ?? 'underlay') === 'underlay',
    underline: opts.underline,
    strikethrough: opts.strikethrough,
    background: opts.background,
  });
```

Add the same three lines to the `normalizePlacement({ … })` calls in `addHeaderFooter` and `addBatesNumbering`. Read each one first — their other defaults differ from the watermark's and must not be disturbed.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/decorate-decoration.test.ts && npm run typecheck && npm test`
Expected: PASS, 5 tests; full suite green.

- [ ] **Step 7: Commit**

```bash
git add src/decorate.ts test/decorate-decoration.test.ts
git commit -m "feat(decorate): text decoration on watermarks, headers/footers and Bates (1gg0.4)"
```

---

### Task 9: Public exports, docs, mutation proof, and close-out

**Files:**
- Modify: `src/index.ts` (near line 76, where `StampOptions` is exported)
- Modify: `README.md`
- Test: the whole suite, plus a deliberate-mutation pass

**Interfaces:**
- Consumes: everything above.
- Produces: `Decoration`, `DecorationStyle`, `Background`, `BackgroundStyle`, `DecorationOptions` on the package's public type surface.

- [ ] **Step 1: Export the public types**

In `src/index.ts`, beside the existing `export type { StampOptions, TextBlockOptions, AuthoringFont } from './stamp.js';`:

```ts
export type {
  Decoration, DecorationStyle, Background, BackgroundStyle, DecorationOptions,
} from './textdecor.js';
```

`VMetrics`, `LineBox`, `ResolvedDecor`, `resolveDecor`, `decorRects`, `vmetricsFor`,
`validateDecoration` and `validateBackground` stay internal — they are the
implementation, not the API.

- [ ] **Step 2: Verify the public surface compiles for a consumer**

Run: `npm run build`
Expected: clean `dist/` build with `.d.ts` emitted; no error about a non-exported type appearing in an exported signature (which is what would happen if `StampOptions.underline` referenced an unexported `Decoration`).

- [ ] **Step 3: Prove the geometry assertions are load-bearing**

CLAUDE.md's rule: a fixture that passes on the first run is not evidence. Break each geometry path and confirm the suite goes red. Detect failure by **exit code**, never by reading output.

Mutation 1 — flip the underline offset's sign. In `src/textdecor.ts`, in `ruleOps`, change `l.baseline + r.offset` to `l.baseline - r.offset`. Then:

```bash
npx vitest run test/textdecor.test.ts test/text-decoration.test.ts; echo "exit=$?"
```

Expected: `exit=1`. Revert the change.

Mutation 2 — drop the background padding. In `decorRects`, change `l.x - bg.padding` to `l.x` and `l.width + 2 * bg.padding` to `l.width`. Run the same command; expected `exit=1`. Revert.

Mutation 3 — ignore justification in the block path. In `blockLineBoxes` (`src/stamp.ts`), change `width: tw > 0 ? w : line.width` to `width: line.width`. Run:

```bash
npx vitest run test/text-decoration.test.ts; echo "exit=$?"
```

Expected: `exit=1`. Revert.

If any mutation leaves the suite green, the corresponding assertion is not load-bearing — strengthen the test before continuing. Confirm every revert landed with `git diff --stat` showing no changes before moving on.

- [ ] **Step 4: Update the README**

Add `underline`, `strikethrough`, `background` and `behind` to the `AddText` / `AddTextBlock` part of the API overview, with a short example:

```ts
page.AddText('Reviewed', 72, 700, {
  underline: true,
  background: [1, 1, 0.6],
});
page.AddTextBlock('Struck through', [72, 600, 200, 50], {
  strikethrough: { color: [1, 0, 0], thickness: 1.5 },
});
page.AddText('WATERMARK', 200, 400, { behind: true, opacity: 0.2 });
```

Mention in the same section that cell styles spell the text fill `textBackground`, because `background` there is the cell box. Add to Limitations:

- A TOC row is stamped as title + leader + number, so its underline skips the dot leader.
- `flow.AddList` decorates the item body; the marker is a separate stamp and is left undecorated.
- `behind` is offered on `AddText` / `AddTextBlock` only. Watermarks use `mode: 'underlay'`; flow, table and TOC content is laid into a container where sinking one element has no meaning.

- [ ] **Step 5: Run the full gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: all three green. Do not proceed on a red or skipped result — report the failure instead.

- [ ] **Step 6: File the follow-up issues**

```bash
bd create "Audit TOCOptions' unforwarded inherited options" \
  -t task -p 3 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "TOCOptions is declared Omit<TextBlockOptions, 'align'|'valign'|'tag'> but rowStampOptions/rowBlockOptions copy a hardcoded field list. 1gg0.4 added the decoration fields to those copies without auditing what else the Omit promises and the copies silently drop."

bd create "Decorate flow.AddList markers, not just item bodies" \
  -t task -p 4 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "flow.AddList draws the marker and the body as separate stamps (ListItemElement). 1gg0.4 forwards decoration to the body only, so an underlined list item leaves its bullet/number undecorated."
```

- [ ] **Step 7: Commit, close, and push**

```bash
git add src/index.ts README.md
git commit -m "feat(textdecor): export the public decoration types; docs (1gg0.4)"
bd close aspose-pdf-foss-for-ts-1gg0.4
git add -A && git commit -m "chore(bd): close 1gg0.4 and file two follow-ups" || true
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Per CLAUDE.md, the work is not complete until `git push` succeeds. If it fails, resolve and retry until it does.

---

## Self-Review

**Spec coverage.** Every section maps to a task: public API → Tasks 2-4 + 9 Step 1; `textdecor.ts` → Tasks 1-2; metric sources incl. the sfnt extension and the fallback → Task 1; emission and the `behind` splice → Tasks 3-4; the four consumers → Tasks 5-8; the three deliberate asymmetries → Tasks 5, 6, 8 preambles; known limitations → Tasks 7 and 9; testing incl. the AFM cross-check, the `GetPaths` read-back, the byte-identity guards and the mutation pass → Tasks 1, 2, 4, 9; documentation → Task 9.

**Type consistency.** `Decoration` / `DecorationStyle` / `Background` / `BackgroundStyle` / `DecorationOptions` / `LineBox` / `ResolvedDecor` / `VMetrics` are defined in Tasks 1-2 and used under those exact names in Tasks 3-9. `vmetricsFor`, `resolveDecor`, `decorRects`, `validateDecoration`, `validateBackground` likewise. The one intentional rename is `ResolvedStyle.textBackground` → `stampTextBlock`'s `background` at the Task 6 boundary, called out where it happens.

**Two divergences from the spec**, both simplifications made while writing real code, neither changing behaviour:

1. `decorRects(lines, d)` drops the spec's `fontSize` parameter — `resolveDecor` already bakes every em fraction into points, so a second `fontSize` would be a second source of truth.
2. `resolveDecor` also carries the background's `top`/`bottom` extent, which the spec left implicit in "`VMetrics`".

**One correctness detail the spec did not anticipate**, added in Task 4 Step 4: a justified line is drawn to the full box width because `Tw` spreads its slack, so its decoration must span the box, not the narrower measured `line.width`.

**Consumer test setup was verified against the real APIs**, which caught two wrong sketches: a flow is created with `doc.NewFlow(opts)` and `Render()` appends and returns the laid pages (not a page-level `CreateFlow`), and `AddTable(table, x, top, { width })` anchors at a point with a total width while column widths come from `setColumnWidths` (not a rect and not a `columns` option). `AddTOC(entries, rect, opts)` was already right. Two residual notes remain, both about behaviour rather than shape: whether dot leaders themselves emit `re f` (Task 7) and whether `addCell` validates eagerly (Task 6). Each says what to assert instead if the assumption does not hold.
