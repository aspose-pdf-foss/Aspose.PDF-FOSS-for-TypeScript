// SVG paint: colour parsing and the presentation-attribute + inline-style +
// stylesheet cascade (issues 1gg0.3, 1gg0.11). Pure — touches no PDF objects.
// The CssDecls import is type-only, so no runtime cycle with svgcss.ts.
import type { CssDecls } from './svgcss.js';
import { NAMED_COLORS } from './colornames.js';

export type Rgb = [number, number, number];

/** A resolved paint state. `null` fill or stroke means "do not paint". */
export interface Paint {
  fill: Rgb | null;
  stroke: Rgb | null;
  /** The id from `fill="url(#id)"`, else null. Kept so a gradient reference
   *  survives the cascade; `fill` still holds the explicit fallback colour, or
   *  null when the paint gave none. */
  fillRef: string | null;
  /** Likewise for `stroke="url(#id)"`. */
  strokeRef: string | null;
  fillRule: 'nonzero' | 'evenodd';
  strokeWidth: number;
  lineCap: 0 | 1 | 2;
  lineJoin: 0 | 1 | 2;
  miterLimit: number;
  dash: number[];
  dashOffset: number;
  fillOpacity: number;
  strokeOpacity: number;
  /** The id from `marker-start="url(#id)"`, else null. Inherited, like the
   *  paint properties, so it travels in `{ ...parent }`. Not in `refs`: a marker
   *  is not a paint server, and svgdraw.ts resolves it separately. */
  markerStart: string | null;
  markerMid: string | null;
  markerEnd: string | null;
}

/** SVG's initial values. The two that are routinely got backwards: the initial
 *  fill is BLACK (not none) and the initial stroke is NONE (not black). */
export const INITIAL: Paint = {
  fill: [0, 0, 0],
  stroke: null,
  fillRef: null,
  strokeRef: null,
  fillRule: 'nonzero',
  strokeWidth: 1,
  lineCap: 0,
  lineJoin: 0,
  miterLimit: 4,
  dash: [],
  dashOffset: 0,
  fillOpacity: 1,
  strokeOpacity: 1,
  markerStart: null,
  markerMid: null,
  markerEnd: null,
};

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Parse an SVG colour. Returns `null` for `none`/`transparent` (do not paint)
 *  and `undefined` when the value cannot be rendered — including `url(...)`
 *  references, which the caller reports rather than guessing a colour for. */
export function parseColor(s: string): Rgb | null | undefined {
  const v = (s ?? '').trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'none' || v === 'transparent') return null;
  if (v[0] === '#') {
    const h = v.slice(1);
    if (/^[0-9a-f]{3}$/.test(h))
      return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255,
              parseInt(h[2] + h[2], 16) / 255];
    if (/^[0-9a-f]{6}$/.test(h))
      return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255,
              parseInt(h.slice(4, 6), 16) / 255];
    return undefined;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(v);
  if (m) {
    const parts = m[1].split(/[\s,]+/).filter((p) => p !== '');
    if (parts.length < 3) return undefined;
    const comp = parts.slice(0, 3).map((p) => {
      const n = parseFloat(p);
      if (!Number.isFinite(n)) return NaN;
      return p.endsWith('%') ? n / 100 : n / 255;
    });
    if (comp.some((n) => Number.isNaN(n))) return undefined;
    return [clamp01(comp[0]), clamp01(comp[1]), clamp01(comp[2])];
  }
  return NAMED_COLORS.get(v) as Rgb | undefined;
}

/** A paint value, which may be a url() reference with an optional fallback.
 *  `out.ref` is set to the referenced id when there is one. */
function parsePaint(
  v: string, refs: string[], out: { ref: string | null },
): Rgb | null | undefined {
  const m = /^url\(\s*#([^)\s]+)\s*\)\s*(.*)$/.exec(v.trim());
  if (!m) { out.ref = null; return parseColor(v); }
  refs.push(m[1]);
  out.ref = m[1];
  // SVG: fall back to the colour after the reference, else to none. Never to
  // black — a silently wrong solid fill is worse than a visibly missing one.
  return m[2].trim() === '' ? null : parseColor(m[2]);
}

function numOr(v: string | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Declarations from an inline `style=""`, lower-cased property names, split by
 *  importance so the cascade can rank them separately. */
function parseInlineStyle(s: string | undefined): CssDecls {
  const normal = new Map<string, string>();
  const important = new Map<string, string>();
  if (!s) return { normal, important };
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    let value = decl.slice(i + 1).trim();
    const m = /!\s*important$/i.exec(value);
    if (m) {
      value = value.slice(0, m.index).trim();
      if (value !== '') important.set(prop, value);
    } else if (value !== '') {
      normal.set(prop, value);
    }
  }
  return { normal, important };
}

/** One element's property lookup, in CSS 2.1 cascade order:
 *
 *    inline !important  >  sheet !important  >  inline  >  sheet  >  attribute
 *
 *  Presentation attributes sit at the BOTTOM: CSS treats them as specificity-0
 *  declarations at the start of the author stylesheet, so any matching rule
 *  outranks them. With no stylesheet the two middle tiers are empty and this
 *  collapses to the previous `inline ?? attrs`, byte for byte.
 *
 *  Exported because <stop> children and the text properties take exactly the
 *  same cascade. */
export function styleGetter(
  attrs: Map<string, string>, css?: CssDecls,
): (k: string) => string | undefined {
  const inline = parseInlineStyle(attrs.get('style'));
  return (k: string): string | undefined =>
    inline.important.get(k) ?? css?.important.get(k)
      ?? inline.normal.get(k) ?? css?.normal.get(k) ?? attrs.get(k);
}

/** Resolve one element's paint over its parent's. Presentation attributes are
 *  read first, then inline `style=` overrides them (CSS beats attributes).
 *  `refs` collects the ids of any url() paints, which the caller resolves to
 *  element names for its skipped list.
 *
 *  `groupOpacity` is the element's own `opacity` and is deliberately NOT folded
 *  into the two alphas. Folding it made it inherit through fillOpacity, which
 *  both hid the fact that it applies to the subtree as a UNIT and made it
 *  unrecoverable — see the group-opacity design spec. The caller decides: a
 *  transparency group, or a fold where the element paints exactly once. */
export function resolveStyle(
  parent: Paint, attrs: Map<string, string>, css?: CssDecls,
): { paint: Paint; refs: string[]; groupOpacity: number } {
  const get = styleGetter(attrs, css);
  const refs: string[] = [];
  const p: Paint = { ...parent, dash: [...parent.dash] };

  const fill = get('fill');
  if (fill !== undefined) {
    const out = { ref: null as string | null };
    const c = parsePaint(fill, refs, out);
    p.fillRef = out.ref;
    if (c !== undefined) p.fill = c;
    // A reference with an unparseable fallback: the reference decides, so the
    // fallback is "none" rather than whatever was inherited.
    else if (out.ref !== null) p.fill = null;
  }
  const stroke = get('stroke');
  if (stroke !== undefined) {
    const out = { ref: null as string | null };
    const c = parsePaint(stroke, refs, out);
    p.strokeRef = out.ref;
    if (c !== undefined) p.stroke = c;
    else if (out.ref !== null) p.stroke = null;
  }

  const rule = get('fill-rule');
  if (rule === 'evenodd' || rule === 'nonzero') p.fillRule = rule;

  p.strokeWidth = Math.max(0, numOr(get('stroke-width'), parent.strokeWidth));
  p.miterLimit = Math.max(1, numOr(get('stroke-miterlimit'), parent.miterLimit));
  p.dashOffset = numOr(get('stroke-dashoffset'), parent.dashOffset);

  const cap = get('stroke-linecap');
  if (cap === 'butt') p.lineCap = 0;
  else if (cap === 'round') p.lineCap = 1;
  else if (cap === 'square') p.lineCap = 2;

  const join = get('stroke-linejoin');
  if (join === 'miter') p.lineJoin = 0;
  else if (join === 'round') p.lineJoin = 1;
  else if (join === 'bevel') p.lineJoin = 2;

  const dash = get('stroke-dasharray');
  if (dash !== undefined) {
    if (dash.trim() === 'none') p.dash = [];
    else {
      const a = dash.split(/[\s,]+/).map(parseFloat).filter((n) => Number.isFinite(n) && n >= 0);
      // An all-zero pattern is invalid and would emit a degenerate `d` array.
      p.dash = a.length > 0 && a.some((n) => n > 0) ? a : [];
    }
  }

  // Returned, not folded: `opacity` applies to the element's rendered result as
  // a UNIT, which is a transparency group, not a per-child alpha. Multiplying it
  // in here made it inherit along with fillOpacity and become unrecoverable.
  const groupOpacity = clamp01(numOr(get('opacity'), 1));
  p.fillOpacity = clamp01(numOr(get('fill-opacity'), 1)) * parent.fillOpacity;
  p.strokeOpacity = clamp01(numOr(get('stroke-opacity'), 1)) * parent.strokeOpacity;

  // marker sets all three; a longhand on the same element outranks it. `none`
  // and an unparseable value both clear the inherited id.
  const markerId = (v: string | undefined): string | null | undefined => {
    if (v === undefined) return undefined;
    const m = /^url\(\s*#([^)\s]+)\s*\)$/.exec(v.trim());
    return m ? m[1] : null;
  };
  const all = markerId(get('marker'));
  if (all !== undefined) { p.markerStart = all; p.markerMid = all; p.markerEnd = all; }
  const ms = markerId(get('marker-start'));
  if (ms !== undefined) p.markerStart = ms;
  const mm = markerId(get('marker-mid'));
  if (mm !== undefined) p.markerMid = mm;
  const me = markerId(get('marker-end'));
  if (me !== undefined) p.markerEnd = me;

  return { paint: p, refs, groupOpacity };
}
