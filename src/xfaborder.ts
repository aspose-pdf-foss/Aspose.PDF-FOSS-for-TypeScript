// src/xfaborder.ts
/**
 * An XFA box's chrome as the template states it (164g.4): `<border>`,
 * `<edge>`, `<corner>`, `<fill>` and a draw's `<line>`/`<rectangle>`/`<arc>`.
 *
 * **Invariant: pure** -- XML in, a model out. No `Document`, no PDF object, no
 * `node:` import; never throws. An unreadable value falls back to the spec's
 * default and is recorded in `notes`: a wrong colour must not cost the box.
 *
 * Sources: XFA 3.3 (SHA-256 a3344e7e...ca01e), p. 38 (borders), p. 629-630
 * (`<border>`), p. 663-665 (`<corner>`), p. 687-689 (`<edge>`), p. 734 and
 * p. 39 (`<fill>`: an empty fill is solid white), p. 768 (`<line>`), p. 824
 * (`<rectangle>`).
 */
import type { XmlNode } from './xml.js';
import { measureToPt, type XfaCaption, type XfaMargin } from './xfageom.js';
import type { WidgetStyle, FieldBorderStyle } from './fieldstyle.js';
import type { LeafText } from './xfarich.js';

export type Rgb = [number, number, number];
export type XfaStroke = 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'dashDotDot'
  | 'lowered' | 'raised' | 'etched' | 'embossed';
export interface XfaEdge { visible: boolean; stroke: XfaStroke; thickness: number; color: Rgb; cap: 'square' | 'butt' | 'round' }
export interface XfaCorner { visible: boolean; stroke: XfaStroke; thickness: number; color: Rgb; radius: number; join: 'square' | 'round'; inverted: boolean }
export type XfaFill = { kind: 'solid'; color: Rgb } | { kind: 'unsupported'; type: string };
export type XfaHand = 'even' | 'left' | 'right';
export interface XfaInsets { l: number; r: number; t: number; b: number }
export interface XfaBorder {
  visible: boolean;
  hand: XfaHand;
  /** Exactly four (top, right, bottom, left), or undefined when no <edge> is
   *  supplied at all: then the border is not stroked (p. 38). */
  edges?: XfaEdge[];
  /** Exactly four (top-left, top-right, bottom-right, bottom-left). */
  corners: XfaCorner[];
  fill?: XfaFill;
  margin: XfaInsets;
  breakOpen: boolean;
  notes: string[];
}
export type XfaGeometry =
  | { kind: 'line'; hand: XfaHand; slope: '\\' | '/'; edge: XfaEdge }
  | { kind: 'rectangle'; hand: XfaHand; edges: XfaEdge[]; corners: XfaCorner[]; fill?: XfaFill }
  | { kind: 'unsupported'; what: string };

/** What a layout node paints, beside its box (164g.4). */
export interface NodeChrome {
  /** The node's own `<border>`. Absent on a push button, whose field border
   *  is its WIDGET's (`XfaField.widgetBorder`). */
  border?: XfaBorder;
  /** A `<line>`, `<rectangle>` or `<arc>` draw. */
  geometry?: XfaGeometry;
  /** A field's caption text (`captionText`). */
  caption?: LeafText;
  /** The caption's `presence`: `invisible` keeps the reserve and paints nothing. */
  captionPresence?: string;
  /** A field's caption and margin as `xfageom.ts`'s `fieldRegions` reads them. */
  fieldCaption?: XfaCaption;
  fieldMargin?: XfaMargin;
}

const STROKES: readonly XfaStroke[] = ['solid', 'dashed', 'dotted', 'dashDot', 'dashDotDot', 'lowered', 'raised', 'etched', 'embossed'];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [1, 1, 1];

const kids = (n: XmlNode, name: string): XmlNode[] => n.children.filter((c) => c.name === name);
const kid = (n: XmlNode, name: string): XmlNode | undefined => n.children.find((c) => c.name === name);

function colorOf(el: XmlNode | undefined, fallback: Rgb, what: string, notes: string[]): Rgb {
  const c = el ? kid(el, 'color') : undefined;
  const v = c?.attrs.get('value');
  if (v === undefined) return fallback;
  const parts = v.split(',').map((s) => s.trim());
  const n = parts.map(Number);
  if (parts.length !== 3 || n.some((x) => !Number.isFinite(x) || x < 0 || x > 255)) {
    notes.push(`${what} color value="${v}" could not be read, so ${fallback === WHITE ? 'white' : 'black'} is used`);
    return fallback;
  }
  return [n[0] / 255, n[1] / 255, n[2] / 255];
}

function measure(v: string | undefined, fallback: number, what: string, notes: string[]): number {
  if (v === undefined || v === '') return fallback;
  const p = measureToPt(v);
  if (p === undefined || p < 0) {
    notes.push(`${what}="${v}" could not be read, so ${String(fallback)}pt is used`);
    return fallback;
  }
  return p;
}

function strokeOf(el: XmlNode): XfaStroke {
  const s = el.attrs.get('stroke');
  return s !== undefined && (STROKES as readonly string[]).includes(s) ? s as XfaStroke : 'solid';
}

const visibleOf = (el: XmlNode): boolean => (el.attrs.get('presence') ?? 'visible') === 'visible';

function edgeOf(el: XmlNode, notes: string[]): XfaEdge {
  const cap = el.attrs.get('cap');
  return {
    visible: visibleOf(el),
    stroke: strokeOf(el),
    thickness: measure(el.attrs.get('thickness'), 0.5, 'edge thickness', notes),
    color: colorOf(el, BLACK, 'edge', notes),
    cap: cap === 'butt' || cap === 'round' ? cap : 'square',
  };
}

function cornerOf(el: XmlNode | undefined, notes: string[]): XfaCorner {
  if (!el) return { visible: true, stroke: 'solid', thickness: 0.5, color: BLACK, radius: 0, join: 'square', inverted: false };
  return {
    visible: visibleOf(el),
    stroke: strokeOf(el),
    thickness: measure(el.attrs.get('thickness'), 0.5, 'corner thickness', notes),
    color: colorOf(el, BLACK, 'corner', notes),
    radius: measure(el.attrs.get('radius'), 0, 'corner radius', notes),
    join: el.attrs.get('join') === 'round' ? 'round' : 'square',
    inverted: el.attrs.get('inverted') === '1',
  };
}

/** p. 38: fewer than four reuses the last. */
function four<T>(xs: T[]): T[] {
  const out = xs.slice(0, 4);
  while (out.length < 4) out.push(out[out.length - 1]);
  return out;
}

function fillOf(el: XmlNode | undefined, notes: string[]): XfaFill | undefined {
  if (!el || !visibleOf(el)) return undefined;
  for (const t of ['linear', 'radial', 'pattern', 'stipple'])
    if (kid(el, t)) return { kind: 'unsupported', type: t };
  return { kind: 'solid', color: colorOf(el, WHITE, 'fill', notes) };
}

function insets(el: XmlNode | undefined, notes: string[]): XfaInsets {
  const m = el ? kid(el, 'margin') : undefined;
  if (!m) return { l: 0, r: 0, t: 0, b: 0 };
  return {
    l: measure(m.attrs.get('leftInset'), 0, 'border margin leftInset', notes),
    r: measure(m.attrs.get('rightInset'), 0, 'border margin rightInset', notes),
    t: measure(m.attrs.get('topInset'), 0, 'border margin topInset', notes),
    b: measure(m.attrs.get('bottomInset'), 0, 'border margin bottomInset', notes),
  };
}

function handOf(el: XmlNode): XfaHand {
  const h = el.attrs.get('hand');
  return h === 'left' || h === 'right' ? h : 'even';
}

export function parseBorder(el: XmlNode): XfaBorder {
  const notes: string[] = [];
  const es = kids(el, 'edge').map((e) => edgeOf(e, notes));
  const cs = kids(el, 'corner').map((c) => cornerOf(c, notes));
  const fill = fillOf(kid(el, 'fill'), notes);
  return {
    visible: visibleOf(el),
    hand: handOf(el),
    ...(es.length > 0 ? { edges: four(es) } : {}),
    corners: cs.length > 0 ? four(cs) : four([cornerOf(undefined, notes)]),
    ...(fill ? { fill } : {}),
    margin: insets(el, notes),
    breakOpen: el.attrs.get('break') === 'open',
    notes,
  };
}

export function parseGeometry(value: XmlNode): XfaGeometry | undefined {
  const g = value.children[0];
  if (!g) return undefined;
  const notes: string[] = [];
  if (g.name === 'line') {
    const e = kid(g, 'edge');
    return {
      kind: 'line', hand: handOf(g), slope: g.attrs.get('slope') === '/' ? '/' : '\\',
      edge: e ? edgeOf(e, notes) : edgeOf({ name: 'edge', attrs: new Map(), children: [], text: '', nodes: [] }, notes),
    };
  }
  if (g.name === 'rectangle') {
    const b = parseBorder(g);
    const fill = b.fill;
    return {
      kind: 'rectangle', hand: b.hand,
      edges: b.edges ?? four([edgeOf({ name: 'edge', attrs: new Map(), children: [], text: '', nodes: [] }, notes)]),
      corners: b.corners,
      ...(fill ? { fill } : {}),
    };
  }
  if (g.name === 'arc') return { kind: 'unsupported', what: 'arc' };
  return undefined;
}

const BS_OF: Record<XfaStroke, FieldBorderStyle> = {
  solid: 'solid', dashed: 'dashed', dotted: 'dashed', dashDot: 'dashed', dashDotDot: 'dashed',
  lowered: 'inset', raised: 'beveled', etched: 'solid', embossed: 'solid',
};

/**
 * A widget's XFA border as `/MK` + `/BS`.
 *
 * **Anchored on Adobe's own output:** IRS f1040's `f2_39` states a 0.0353mm
 * (0.1pt) 51,51,51 edge on its `<ui><textEdit><border>` and Adobe wrote
 * `/BC [0.2 0.2 0.2] /BS << /S /S /W 1 >>`; DoD DD 1155's Reset button states a
 * default 0.5pt edge and got `/W 1`. So a thickness below 1pt becomes `/W 1`.
 * Above 1pt the thickness is written as it is -- UNANCHORED, no instance seen.
 * `lowered`/`raised` become Inset/Beveled (32000-1 12.5.4), which no Adobe
 * instance in the corpus shows -- the only ones are on hidden page counters.
 */
export function widgetStyleOf(b: XfaBorder): { style: WidgetStyle; degraded?: string } | undefined {
  if (!b.visible) return undefined;
  const style: WidgetStyle = {};
  let degraded: string | undefined;
  const vis = (b.edges ?? []).map((e) => e.visible);
  const first = (b.edges ?? []).find((e) => e.visible);
  if (first) {
    style.borderColor = first.color;
    style.borderWidth = first.thickness < 1 ? 1 : first.thickness;
    const onlyBottom = vis[0] === false && vis[1] === false && vis[2] === true && vis[3] === false;
    style.borderStyle = onlyBottom ? 'underline' : BS_OF[first.stroke];
    if (first.stroke === 'etched' || first.stroke === 'embossed')
      degraded = `an ${first.stroke} widget border has no AcroForm counterpart and is drawn solid`;
    else if (!onlyBottom && vis.some((v) => !v))
      degraded = 'a widget border with only some edges visible is drawn as a full box';
  }
  if (b.fill?.kind === 'solid') style.backgroundColor = b.fill.color;
  if (Object.keys(style).length === 0) return undefined;
  return { style, ...(degraded !== undefined ? { degraded } : {}) };
}
