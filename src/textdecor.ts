import { EmbeddedFont } from './embeddedfont.js';
import { num } from './pagecontent.js';
import type { AuthoringFont } from './stamp.js';

/** A font's vertical metrics as em fractions: baseline = 0, positive up.
 *  `descent` is negative. Scale by fontSize for points. */
export interface VMetrics {
  ascent: number;
  descent: number;
  /** Half of this is SVG's `middle` baseline offset. */
  xHeight: number;
  underlineOffset: number;
  underlineThickness: number;
  strikeOffset: number;
  strikeThickness: number;
}

/** Used when a font supplies nothing usable (no `post`, no OS/2, zeroed entries). */
const FALLBACK: VMetrics = {
  ascent: 0.75, descent: -0.25, xHeight: 0.5,
  underlineOffset: -0.1, underlineThickness: 0.05,
  strikeOffset: 0.25, strikeThickness: 0.05,
};

/** Adobe AFM vertical metrics per 1000-unit em, by Standard-14 family. All 12
 *  Latin faces fall into three families; bold/italic differ from their family's
 *  roman by under 2% of an em, which is invisible at any realistic size. */
const STD14_V: Record<'Helvetica' | 'Times' | 'Courier',
  { ascent: number; descent: number; capHeight: number; xHeight: number }> = {
  Helvetica: { ascent: 718, descent: -207, capHeight: 718, xHeight: 523 },
  Times:     { ascent: 683, descent: -217, capHeight: 662, xHeight: 450 },
  Courier:   { ascent: 629, descent: -157, capHeight: 562, xHeight: 426 },
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
    xHeight: v.xHeight / 1000,
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
    // OS/2 version 1 and earlier carry no sxHeight at all. Estimate from the
    // ascent rather than a flat constant, so an unusual font still scales: the
    // three Standard-14 families sit at xHeight/ascent = 0.73, 0.66, 0.68, so
    // 0.7 lands within a thousandth of Helvetica's real 0.523. Half the ascent
    // would give 0.375, below every real x-height.
    xHeight: or(s.xHeight / upem, or(s.ascent / upem, FALLBACK.ascent) * 0.7),
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

/** One styled span of a rich text block.
 *
 *  Every property but `text` falls back to the block's own option when unset, so
 *  `[{ text: 'a' }, { text: 'b', font: 'Helvetica-Bold' }]` inherits size and
 *  colour from the paragraph rather than restating them.
 *
 *  The split is character-level versus line-level: a run carries what applies to
 *  glyphs, while `align`, `valign`, `leading`, `rotate`, `opacity` and `behind`
 *  describe a line or a block and stay on the block options.
 *
 *  It lives here rather than in layout.ts because it names an AuthoringFont,
 *  which stamp.ts defines — and stamp.ts imports layout.ts, so the reverse would
 *  invert that dependency. This module already owns Decoration and Background and
 *  already takes AuthoringFont as a type-only import. */
export interface TextRun extends DecorationOptions {
  text: string;
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  /** Make this run a hyperlink to this absolute URI. A `/Link` annotation is
   *  placed over the run's laid-out glyphs — one per line it occupies, so a
   *  link broken across a line break stays clickable on both. Styling is NOT
   *  implied: set `color` and `underline` for the usual blue-underlined look.
   *  Default: none. */
  link?: string;
}

/** Whether a `string | TextRun[]` argument is the run form. */
export function isTextRunList(v: string | TextRun[]): v is TextRun[] {
  return Array.isArray(v);
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

/** A rule that paints nothing, so `decorRects` needs no per-layer branch. */
const EMPTY_RULE: ResolvedRule = { color: [0, 0, 0], thickness: 0, offset: 0 };

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
  const above = ruleOps(lines, d.underline ?? EMPTY_RULE)
    + ruleOps(lines, d.strikethrough ?? EMPTY_RULE);
  return { beneath, above };
}
