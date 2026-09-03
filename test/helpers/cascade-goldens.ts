/** Loader and comparators for the Blink-generated cascade corpus.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  test/helpers/selector-goldens.ts already sets.
 *
 *  The comparators exist because `getComputedStyle` returns STRINGS in
 *  Chrome's own spellings — `rgb(255, 0, 0)`, `16px` — while ComputedStyle
 *  holds numbers and structures. Comparing formatted text on both sides would
 *  mean writing a CSS serializer whose bugs could cancel Chrome's spellings
 *  out; comparing PARSED numbers keeps the comparison in the value domain. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlElement } from '../../src/htmldom.js';
import type { ComputedStyle } from '../../src/cssprop.js';
import { fixedPx } from '../../src/cssvalue.js';
import type { LengthPct } from '../../src/cssvalue.js';

const FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-cascade', 'goldens.json',
);

export interface CascadeCase {
  id: string; html: string; props: string[]; values: Record<string, string>[];
}
export interface CascadeGoldens { chrome: string; cases: CascadeCase[] }

export function loadCascadeGoldens(): CascadeGoldens {
  return JSON.parse(readFileSync(FILE, 'utf8')) as CascadeGoldens;
}

/** The child-index path from the document element, element children only —
 *  the same walk scripts/gen-cascade-goldens.ts makes with querySelectorAll,
 *  which returns document order. */
export function pathOf(el: HtmlElement): number[] {
  const out: number[] = [];
  let n: HtmlElement = el;
  for (;;) {
    const p = n.parent;
    if (p === null || p.kind !== 'element') return out;
    const sibs = p.children.filter((c): c is HtmlElement => c.kind === 'element');
    out.unshift(sibs.indexOf(n));
    n = p;
  }
}

const LENGTH_PROPS = new Set([
  'font-size', 'text-indent', 'border-spacing',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
]);

const COLOR_PROPS = new Set([
  'color', 'background-color', 'text-decoration-color',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
]);

const KEY_OF: Record<string, keyof ComputedStyle> = {
  'font-size': 'fontSize', 'font-style': 'fontStyle', 'font-weight': 'fontWeight',
  'text-indent': 'textIndent', 'border-spacing': 'borderSpacing',
  'margin-top': 'marginTop', 'margin-right': 'marginRight',
  'margin-bottom': 'marginBottom', 'margin-left': 'marginLeft',
  'padding-top': 'paddingTop', 'padding-right': 'paddingRight',
  'padding-bottom': 'paddingBottom', 'padding-left': 'paddingLeft',
  'border-top-width': 'borderTopWidth', 'border-right-width': 'borderRightWidth',
  'border-bottom-width': 'borderBottomWidth', 'border-left-width': 'borderLeftWidth',
  'border-top-style': 'borderTopStyle', 'border-right-style': 'borderRightStyle',
  'border-bottom-style': 'borderBottomStyle', 'border-left-style': 'borderLeftStyle',
  color: 'color', 'background-color': 'backgroundColor',
  'border-top-color': 'borderTopColor', 'border-right-color': 'borderRightColor',
  'border-bottom-color': 'borderBottomColor', 'border-left-color': 'borderLeftColor',
  'text-decoration-color': 'textDecorationColor',
  'text-decoration-style': 'textDecorationStyle',
  'text-decoration-line': 'textDecorationLine',
  'text-align': 'textAlign', 'white-space': 'whiteSpace', display: 'display',
  float: 'float', clear: 'clear', 'vertical-align': 'verticalAlign',
  'list-style-type': 'listStyleType', 'list-style-position': 'listStylePosition',
  'border-collapse': 'borderCollapse', 'line-height': 'lineHeight',
};

/** Is this property one the comparator actually knows how to compare?
 *
 *  Exported so a test can assert the MAP covers every property the fixtures
 *  name, directly. Asking `compareProp` instead would conflate a missing
 *  KEY_OF row — a silent ok:true, which is the bug worth catching — with a
 *  value-dependent exclusion like `line-height: normal`, which is deliberate. */
export function isComparedProp(prop: string): boolean {
  // A custom property is deliberately NOT compared: this stack does not store
  // one on ComputedStyle — the environment dies with the compute walk — so
  // there is no value on our side to compare against Chrome's. Named here
  // rather than left to fall through KEY_OF, because a silent ok:true is
  // exactly what this predicate exists to catch, and a future reader would
  // otherwise assume the corpus covers what it does not.
  if (prop.startsWith('--')) return true;
  return Object.prototype.hasOwnProperty.call(KEY_OF, prop);
}

function parseChromeColor(s: string): [number, number, number, number] | undefined {
  const m = /^rgba?\(([^)]*)\)$/.exec(s.trim());
  if (m === null) return undefined;
  const p = (m[1] as string).split(/[\s,/]+/).filter((x) => x !== '');
  if (p.length < 3) return undefined;
  const n = p.map((x) => parseFloat(x));
  return [
    (n[0] as number) / 255, (n[1] as number) / 255, (n[2] as number) / 255,
    p.length > 3 ? (n[3] as number) : 1,
  ];
}

/** Each border-width property to the style property that governs whether
 *  Chrome reports its computed value or a used 0. */
const BORDER_WIDTH_STYLE: Record<string, keyof ComputedStyle> = {
  'border-top-width': 'borderTopStyle',
  'border-right-width': 'borderRightStyle',
  'border-bottom-width': 'borderBottomStyle',
  'border-left-width': 'borderLeftStyle',
};

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.02;

/** Compare one property. Returns whether it matched and how ours rendered,
 *  so a failure message can name both sides. */
export function compareProp(
  prop: string, ours: ComputedStyle, chrome: string,
): { ok: boolean; ours: string } {
  if (prop.startsWith('--')) {
    return { ok: true, ours: '(custom property: not compared)' };
  }
  const key = KEY_OF[prop];
  if (key === undefined) return { ok: true, ours: '(not compared)' };
  const v = (ours as unknown as Record<string, unknown>)[key];

  if (prop === 'line-height') {
    // `normal` is EXCLUDED, on both sides. Chrome resolves it to a px from
    // font metrics we do not have, so a comparison there would measure the
    // metrics rather than the cascade — and every element a fixture does not
    // style has it, so this branch is reached constantly.
    if (v === 'normal') return { ok: true, ours: 'normal (not compared)' };
    // Chrome reports a used px even for a NUMBER line-height, so ours is
    // resolved against the element's own font size before comparing. The
    // number-versus-percentage distinction is still visible: an inheriting
    // child with a different font size gets a different px under each.
    const px = typeof v === 'object' && v !== null && 'number' in v
      ? (v as { number: number }).number * ours.fontSize
      : typeof v === 'object' && v !== null && 'px' in v
        ? (v as { px: number }).px
        : NaN;
    if (Number.isNaN(px)) return { ok: false, ours: String(v) };
    return { ok: near(px, parseFloat(chrome)), ours: `${String(px)}px` };
  }

  // A border width whose STYLE is none or hidden is excluded, because Chrome
  // reports the USED value there — 0 — while this module produces the
  // computed one, which is the initial `medium` (3px). Different questions,
  // so comparing them measures nothing. It bites on every element a fixture
  // does not give a border to, which is most of them, so the exclusion is
  // driven off the style rather than off the fixture.
  const widthStyle = BORDER_WIDTH_STYLE[prop];
  if (widthStyle !== undefined) {
    const st = (ours as unknown as Record<string, unknown>)[widthStyle];
    if (st === 'none' || st === 'hidden') {
      return { ok: true, ours: `${String(v)}px (style ${String(st)}: not compared)` };
    }
  }

  if (LENGTH_PROPS.has(prop)) {
    if (typeof v === 'number') return { ok: near(v, parseFloat(chrome)), ours: `${v}px` };
    // A value that depends on the percentage BASIS is excluded from the
    // corpus — see PROVENANCE — because Chrome reports the used px and this
    // module produces the unresolved value. The question is asked through
    // `fixedPx` rather than by testing for a `px` field, and that matters
    // since zch2.2.6: EVERY LengthPct now carries `px`, so a bare `50%`
    // arrives as `{ px: 0, pct: 50 }` and a field test would compare our 0
    // against Chrome's used pixels. It never fired before only because no
    // fixture declared a percentage; the calc fixtures do.
    if (typeof v === 'object' && v !== null) {
      const px = fixedPx(v as LengthPct);
      if (px !== undefined) return { ok: near(px, parseFloat(chrome)), ours: `${px}px` };
    }
    return { ok: true, ours: '(not compared)' };
  }

  if (COLOR_PROPS.has(prop)) {
    const c = parseChromeColor(chrome);
    const o = v as { rgb: [number, number, number]; a: number };
    if (c === undefined) return { ok: false, ours: JSON.stringify(o) };
    const ok = near(o.rgb[0], c[0]) && near(o.rgb[1], c[1])
      && near(o.rgb[2], c[2]) && near(o.a, c[3]);
    return { ok, ours: `rgba(${o.rgb.join(', ')}, ${o.a})` };
  }

  if (prop === 'font-weight') {
    return { ok: near(v as number, parseFloat(chrome)), ours: String(v) };
  }

  if (prop === 'text-decoration-line') {
    const mine = (v as string[]).length === 0 ? 'none' : (v as string[]).join(' ');
    return { ok: mine === chrome.trim(), ours: mine };
  }

  return { ok: String(v) === chrome.trim(), ours: String(v) };
}
