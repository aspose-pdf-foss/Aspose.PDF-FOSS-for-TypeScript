# XFA Static Chrome Implementation Plan (164g.4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paint an XFA form's draws, borders, fills and field captions as page content on the pages `ConvertXfaToAcroForm` creates for a dynamic document, and carry widget borders into `/MK` + `/BS`.

**Architecture:** The layout engine already computes every node's box; it gains a second output, `PlacedNode[]`, in document order. A pure module (`xfaborder.ts`) reads `<border>`/`<edge>`/`<corner>`/`<fill>` and draw geometry; a pure module (`xfachrome.ts`) turns placed nodes into paint operations in the XFA page frame; `xfapaint.ts` is the only new module holding a `Document` and writes those operations as one content stream per page plus one Form XObject per page area. Text is broken by the SAME `layoutRuns` call that measured it (`xfatext.ts`'s new `layoutLeaf`).

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-13-xfa-chrome-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins.
- Import specifiers carry `.js`. Strict TypeScript.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts` enforces it); a bindingless `catch {` becomes `catch (caught) {`.
- `xfaborder.ts`, `xfachrome.ts`, `xfatext.ts`, `xfarich.ts`, `xfaflow.ts`, `xfageom.ts`, `xfapage.ts`, `xfatemplate.ts` stay pure: no `Document`, no `node:` import, never throw.
- Hybrid documents are untouched: chrome is painted ONLY when the converter replaced a dynamic document's placeholder pages.
- Measurement must not move: every field added to `ParaSpec`, `RunSpec` and `LeafText` is OPTIONAL and written only when the template states a non-default value, so existing `toEqual` assertions and layout goldens stay byte-identical.
- XFA 3.3 citations: `xfa_spec_3_3.pdf`, SHA-256 `a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`; borders p. 38, `<border>` p. 629-630, `<corner>` p. 663-665, `<edge>` p. 687-689, box model p. 49-51, `<caption>` p. 643, `<fill>` p. 734 (empty fill = solid white, p. 39), `<font>` p. 741, `<line>` p. 768, `<para>` p. 800, `<rectangle>` p. 824.
- Run `npm run typecheck` and `npm test` green before closing the issue. Run single files with `npx vitest run test/<name>.test.ts`.
- `npm run gen:xfa` is never run by `npm test`; it needs `npm i --no-save puppeteer` and network access.

## Review Focus

1. **A face nothing resolves on a created page.** Layout already refuses such a leaf; chrome must then paint nothing for it, report it once, and never throw. Test in Task 8.
2. **A dynamic document whose conversion keeps its placeholder pages** (nothing placed). No chrome may be painted on the placeholder, and `chromePages` is 0. Test in Task 8.
3. **Two page areas with different `<medium>` sizes.** Each master Form XObject is built for its own page height; drawing one area's chrome flipped against another's height puts it off the page. Test in Task 8.
4. **A caption with `presence="invisible"`.** Its reserve still narrows the widget; its text is not painted. Test in Task 7.
5. **A degenerate box** (zero width or height, or an edge thicker than the box). Operations stay finite: no `NaN` and no negative dash entries reach a content stream, which would make the file corrupt rather than merely ugly. Test in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/xfaborder.ts` (new, pure) | The border/edge/corner/fill/colour model, its XML readers, draw geometry, `NodeChrome`, and `widgetStyleOf` (XFA border → `WidgetStyle`). |
| `src/xfarich.ts` (modify) | Paragraph `hAlign`, leaf `vAlign`, run colour/underline/lineThrough, `notes`, and `captionText`. |
| `src/xfatemplate.ts` (modify) | Attach `chrome` to layout nodes; `widgetBorder` to fields. |
| `src/xfaflow.ts` (modify) | `PlacedNode`; `layoutPage` fills an optional `nodes` list. |
| `src/xfapage.ts` (modify) | `LaidOutPage.nodes`. |
| `src/xfageom.ts` (modify) | `fieldRegions`: a field's edit region AND caption region from one function. |
| `src/xfatext.ts` (modify) | `layoutLeaf` (laid-out lines); `measureLeaf` derives from it. |
| `src/xfachrome.ts` (new, pure) | Placed nodes → `ChromeOp[]` in the XFA page frame. |
| `src/xfafont.ts` (modify) | `facePicker`: a face's metrics AND where to draw it from. |
| `src/xfapaint.ts` (new) | `ChromeOp[]` → content bytes; page streams and master Form XObjects. |
| `src/xfaconvert.ts` (modify) | Plan chrome for dynamic documents, paint it on apply, report it; widget styles on created fields. |
| `scripts/gen-xfa-goldens.ts` (modify) | Chrome pass → `test/fixtures/xfa-dynamic/chrome-goldens.json`. |
| `test/helpers/xfa-dynamic.ts` (modify) | `ChromeGoldens` type + loader. |

Tests: `test/xfaborder.test.ts`, `test/xfarich-chrome.test.ts`, `test/xfatemplate-chrome.test.ts`, `test/xfaflow-placed.test.ts`, `test/xfatext-layout.test.ts`, `test/xfageom-regions.test.ts`, `test/xfachrome-border.test.ts`, `test/xfachrome-text.test.ts`, `test/xfapaint.test.ts`, `test/xfaconvert-chrome.test.ts`, `test/xfa-widget-border.test.ts`, `test/xfa-chrome-oracle.test.ts`, `test/xfa-chrome-fence.test.ts`.

---

### Task 1: The border model and its readers (`xfaborder.ts`)

**Files:**
- Create: `src/xfaborder.ts`
- Test: `test/xfaborder.test.ts`

**Interfaces:**
- Consumes: `XmlNode` (`src/xml.js`), `measureToPt` (`src/xfageom.js`), `WidgetStyle` type (`src/fieldstyle.js`), `LeafText` type (`src/xfarich.js`), `XfaCaption`, `XfaMargin` types (`src/xfageom.js`).
- Produces (exact names later tasks use):

```ts
export type Rgb = [number, number, number]; // 0..1
export type XfaStroke = 'solid' | 'dashed' | 'dotted' | 'dashDot' | 'dashDotDot'
  | 'lowered' | 'raised' | 'etched' | 'embossed';
export interface XfaEdge { visible: boolean; stroke: XfaStroke; thickness: number; color: Rgb; cap: 'square' | 'butt' | 'round' }
export interface XfaCorner { visible: boolean; stroke: XfaStroke; thickness: number; color: Rgb; radius: number; join: 'square' | 'round'; inverted: boolean }
export type XfaFill = { kind: 'solid'; color: Rgb } | { kind: 'unsupported'; type: string };
export type XfaHand = 'even' | 'left' | 'right';
export interface XfaInsets { l: number; r: number; t: number; b: number }
export interface XfaBorder {
  visible: boolean; hand: XfaHand;
  /** Exactly four (top, right, bottom, left), or undefined: no <edge> at all, so not stroked (p. 38). */
  edges?: XfaEdge[];
  /** Exactly four (top-left, top-right, bottom-right, bottom-left). */
  corners: XfaCorner[];
  fill?: XfaFill; margin: XfaInsets; breakOpen: boolean;
  /** Unreadable values that fell back to a default, for report.warnings. */
  notes: string[];
}
export type XfaGeometry =
  | { kind: 'line'; hand: XfaHand; slope: '\\' | '/'; edge: XfaEdge }
  | { kind: 'rectangle'; hand: XfaHand; edges: XfaEdge[]; corners: XfaCorner[]; fill?: XfaFill }
  | { kind: 'unsupported'; what: string };
export interface NodeChrome {
  border?: XfaBorder;
  geometry?: XfaGeometry;
  caption?: LeafText;
  captionPresence?: string;
  fieldCaption?: XfaCaption;
  fieldMargin?: XfaMargin;
}
export function parseBorder(el: XmlNode): XfaBorder;
export function parseGeometry(value: XmlNode): XfaGeometry | undefined;
export function widgetStyleOf(b: XfaBorder): { style: WidgetStyle; degraded?: string } | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfaborder.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseBorder, parseGeometry, widgetStyleOf } from '../src/xfaborder.js';

const xml = (s: string) => parseXml(new TextEncoder().encode(s));
const MM = 72 / 25.4;

describe('parseBorder (XFA 3.3 p. 38, 629-630, 663-665, 687-689)', () => {
  it('repeats the LAST edge for the missing ones, in the order top, right, bottom, left', () => {
    const b = parseBorder(xml('<border><edge thickness="2pt"/><edge thickness="3pt"/></border>'));
    expect(b.edges!.map((e) => e.thickness)).toEqual([2, 3, 3, 3]);
  });

  it('is not stroked when no <edge> is supplied at all, but may still fill', () => {
    const b = parseBorder(xml('<border><fill><color value="255,0,0"/></fill></border>'));
    expect(b.edges).toBeUndefined();
    expect(b.fill).toEqual({ kind: 'solid', color: [1, 0, 0] });
  });

  it('gives an edge the defaults: solid, 0.5pt, black, square cap, visible', () => {
    const b = parseBorder(xml('<border><edge/></border>'));
    expect(b.edges![0]).toEqual({ visible: true, stroke: 'solid', thickness: 0.5, color: [0, 0, 0], cap: 'square' });
  });

  it('uses default corners for all four when none is supplied', () => {
    const b = parseBorder(xml('<border><edge/></border>'));
    expect(b.corners).toHaveLength(4);
    expect(b.corners[0]).toEqual({ visible: true, stroke: 'solid', thickness: 0.5, color: [0, 0, 0], radius: 0, join: 'square', inverted: false });
  });

  it('repeats the last corner, and reads radius, join and inverted', () => {
    const b = parseBorder(xml('<border><edge/><corner radius="2mm" join="round" inverted="1"/></border>'));
    expect(b.corners.map((c) => c.radius)).toEqual([2 * MM, 2 * MM, 2 * MM, 2 * MM]);
    expect(b.corners[3]).toMatchObject({ join: 'round', inverted: true });
  });

  it('reads an edge colour as 0..255 components', () => {
    const b = parseBorder(xml('<border><edge><color value="51,102,255"/></edge></border>'));
    expect(b.edges![0].color).toEqual([0.2, 0.4, 1]);
  });

  it('falls back to black and records a note for an unreadable colour', () => {
    const b = parseBorder(xml('<border><edge><color value="red"/></edge></border>'));
    expect(b.edges![0].color).toEqual([0, 0, 0]);
    expect(b.notes).toEqual(['edge color value="red" could not be read, so black is used']);
  });

  it('reads an edge whose presence is not visible as invisible', () => {
    const b = parseBorder(xml('<border><edge presence="hidden"/></border>'));
    expect(b.edges!.every((e) => !e.visible)).toBe(true);
  });

  it('reads hand, defaulting to even, and the border margin', () => {
    expect(parseBorder(xml('<border><edge/></border>')).hand).toBe('even');
    const b = parseBorder(xml('<border hand="right"><edge/><margin leftInset="1pt" topInset="2pt"/></border>'));
    expect(b.hand).toBe('right');
    expect(b.margin).toEqual({ l: 1, r: 0, t: 2, b: 0 });
  });

  it('reads an empty <fill/> as solid WHITE (p. 39)', () => {
    expect(parseBorder(xml('<border><fill/></border>')).fill).toEqual({ kind: 'solid', color: [1, 1, 1] });
  });

  it('reads a gradient, pattern or stipple fill as unsupported, naming it', () => {
    for (const t of ['linear', 'radial', 'pattern', 'stipple'])
      expect(parseBorder(xml(`<border><fill><${t}/></fill></border>`)).fill).toEqual({ kind: 'unsupported', type: t });
  });

  it('drops a fill whose presence is not visible', () => {
    expect(parseBorder(xml('<border><fill presence="invisible"/></border>')).fill).toBeUndefined();
  });

  it('reads presence and break', () => {
    expect(parseBorder(xml('<border presence="invisible"><edge/></border>')).visible).toBe(false);
    expect(parseBorder(xml('<border break="open"><edge/></border>')).breakOpen).toBe(true);
  });
});

describe('parseGeometry (p. 768, 824)', () => {
  it('reads a line, its slope defaulting to \\', () => {
    expect(parseGeometry(xml('<value><line><edge thickness="1pt"/></line></value>'))).toMatchObject({
      kind: 'line', slope: '\\', hand: 'even', edge: { thickness: 1 },
    });
    expect(parseGeometry(xml('<value><line slope="/"/></value>'))).toMatchObject({ slope: '/' });
  });

  it('reads a rectangle with the border repetition rules', () => {
    const g = parseGeometry(xml('<value><rectangle><edge thickness="2pt"/></rectangle></value>'));
    expect(g).toMatchObject({ kind: 'rectangle' });
    if (g?.kind !== 'rectangle') throw new Error('not a rectangle');
    expect(g.edges.map((e) => e.thickness)).toEqual([2, 2, 2, 2]);
    expect(g.corners).toHaveLength(4);
  });

  it('reads an arc as unsupported', () => {
    expect(parseGeometry(xml('<value><arc/></value>'))).toEqual({ kind: 'unsupported', what: 'arc' });
  });

  it('is undefined for text content', () => {
    expect(parseGeometry(xml('<value><text>x</text></value>'))).toBeUndefined();
  });
});

describe('widgetStyleOf: an XFA widget border to /MK + /BS', () => {
  // Adobe's own mapping, measured on IRS f1040 f2_39: a 0.0353mm (0.1pt)
  // 51,51,51 edge became /BC [0.2 0.2 0.2] /BS << /S /S /W 1 >>.
  it('writes /W 1 for an edge thinner than a point, as Adobe does', () => {
    const b = parseBorder(xml('<border hand="right"><edge thickness="0.0353mm"><color value="51,51,51"/></edge></border>'));
    expect(widgetStyleOf(b)).toEqual({ style: { borderColor: [0.2, 0.2, 0.2], borderWidth: 1, borderStyle: 'solid' } });
  });

  it('maps lowered to inset and raised to beveled', () => {
    const lo = parseBorder(xml('<border><edge stroke="lowered"/></border>'));
    const hi = parseBorder(xml('<border><edge stroke="raised"/></border>'));
    expect(widgetStyleOf(lo)?.style.borderStyle).toBe('inset');
    expect(widgetStyleOf(hi)?.style.borderStyle).toBe('beveled');
  });

  it('maps the four dash strokes to dashed', () => {
    for (const s of ['dashed', 'dotted', 'dashDot', 'dashDotDot'])
      expect(widgetStyleOf(parseBorder(xml(`<border><edge stroke="${s}"/></border>`)))?.style.borderStyle).toBe('dashed');
  });

  it('maps etched and embossed to solid and says so', () => {
    const r = widgetStyleOf(parseBorder(xml('<border><edge stroke="etched"/></border>')));
    expect(r?.style.borderStyle).toBe('solid');
    expect(r?.degraded).toBe('an etched widget border has no AcroForm counterpart and is drawn solid');
  });

  it('maps a border with only the BOTTOM edge visible to underline', () => {
    const b = parseBorder(xml('<border><edge presence="hidden"/><edge presence="hidden"/><edge/><edge presence="hidden"/></border>'));
    expect(widgetStyleOf(b)?.style.borderStyle).toBe('underline');
  });

  it('draws another partial border as a full box and says so', () => {
    const b = parseBorder(xml('<border><edge/><edge presence="hidden"/></border>'));
    expect(widgetStyleOf(b)?.degraded).toBe('a widget border with only some edges visible is drawn as a full box');
  });

  it('writes the fill colour as /MK /BG', () => {
    const b = parseBorder(xml('<border><edge/><fill><color value="255,255,0"/></fill></border>'));
    expect(widgetStyleOf(b)?.style.backgroundColor).toEqual([1, 1, 0]);
  });

  it('is undefined for an invisible border, or one with no visible edge and no fill', () => {
    expect(widgetStyleOf(parseBorder(xml('<border presence="hidden"><edge/></border>')))).toBeUndefined();
    expect(widgetStyleOf(parseBorder(xml('<border><edge presence="hidden"/></border>')))).toBeUndefined();
  });

  it('writes a fill alone, with no border stroke', () => {
    const r = widgetStyleOf(parseBorder(xml('<border><edge presence="hidden"/><fill><color value="0,0,255"/></fill></border>')));
    expect(r).toEqual({ style: { backgroundColor: [0, 0, 1] } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/xfaborder.test.ts`
Expected: FAIL — cannot resolve `../src/xfaborder.js`.

- [ ] **Step 3: Implement `src/xfaborder.ts`**

```ts
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
```

Note: `XmlNode` literals above must match `src/xml.ts`'s shape (`name`, `attrs: Map`, `children`, `text`, `nodes`) — confirmed at `xml.ts:112`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/xfaborder.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/xfaborder.ts test/xfaborder.test.ts
git commit -m "feat(164g.4): XFA border, edge, corner, fill and draw-geometry model"
```

---

### Task 2: Text styling and caption text (`xfarich.ts`)

**Files:**
- Modify: `src/xfarich.ts` (types at lines 21-41; `fontOf` 59-81; `paraOf` 83-96; `NO_SIZE`/`applyCss` 138-221; `RichBuilder.text` merge predicate 257-261; `leafText` 299-340)
- Test: `test/xfarich-chrome.test.ts`

**Interfaces:**
- Produces:

```ts
// added to ParaSpec
hAlign?: 'center' | 'right' | 'justify' | 'justifyAll';   // absent = left
// added to RunSpec (RunStyle is unchanged)
color?: [number, number, number];  // 0..1; absent = black
underline?: true;
lineThrough?: true;
// added to LeafText
vAlign?: 'middle' | 'bottom';      // absent = top
notes?: string[];                  // fallbacks for report.warnings
// new export
export function captionText(field: XmlNode): LeafText | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfarich-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { leafText, captionText } from '../src/xfarich.js';

const el = (s: string) => parseXml(new TextEncoder().encode(s));

describe('xfarich: what painting needs and measurement ignores (164g.4)', () => {
  it('reads para hAlign onto every paragraph, and leaves left unstated', () => {
    const t = leafText(el('<draw><para hAlign="center"/><value><text>a\nb</text></value></draw>'));
    expect(t.paras.map((p) => p.hAlign)).toEqual(['center', 'center']);
    expect(leafText(el('<draw><para hAlign="left"/><value><text>a</text></value></draw>')).paras[0].hAlign).toBeUndefined();
  });

  it('reads para vAlign onto the leaf, leaving top unstated', () => {
    expect(leafText(el('<draw><para vAlign="bottom"/><value><text>a</text></value></draw>')).vAlign).toBe('bottom');
    expect(leafText(el('<draw><para vAlign="top"/><value><text>a</text></value></draw>')).vAlign).toBeUndefined();
  });

  it('reads the font colour and decoration onto each run', () => {
    const t = leafText(el('<draw><font typeface="Arial" underline="1" lineThrough="1"><fill><color value="255,0,0"/></fill></font><value><text>a</text></value></draw>'));
    expect(t.paras[0].runs[0]).toMatchObject({ color: [1, 0, 0], underline: true, lineThrough: true });
  });

  it('leaves a black, undecorated run exactly as before', () => {
    const t = leafText(el('<draw><font typeface="Arial"/><value><text>a</text></value></draw>'));
    expect(t.paras[0].runs[0]).toEqual({ family: ['Arial'], size: 10, bold: false, italic: false, text: 'a' });
  });

  it('reads rich-text color, text-decoration and text-align', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p style="text-align:right"><span style="color:#0000ff;text-decoration:underline">x</span></p></body></exData></value></draw>`));
    expect(t.paras[0].hAlign).toBe('right');
    expect(t.paras[0].runs[0]).toMatchObject({ text: 'x', color: [0, 0, 1], underline: true });
  });

  it('does not merge two runs that differ only in colour', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p><span style="color:#ff0000">a</span><span style="color:#0000ff">b</span></p></body></exData></value></draw>`));
    expect(t.paras[0].runs.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('falls back to black with a note for an unreadable rich-text colour, keeping the leaf', () => {
    const t = leafText(el(`<draw><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml">
      <p><span style="color:wobble">a</span></p></body></exData></value></draw>`));
    expect(t.refusal).toBeUndefined();
    expect(t.paras[0].runs[0].color).toBeUndefined();
    expect(t.notes).toEqual(['color in rich text could not be read, so black is used']);
  });
});

describe('captionText', () => {
  it('is the caption value, in the caption font', () => {
    const t = captionText(el('<field><caption reserve="20mm"><font typeface="Arial" size="8pt"/><value><text>Name</text></value></caption></field>'));
    expect(t?.paras[0].runs[0]).toMatchObject({ text: 'Name', family: ['Arial'], size: 8 });
  });

  // pdf.js inherits the FIELD's font for a caption that states none (CSS
  // inheritance from the field div); XFA's own default would be Courier 10.
  it('takes the field font when the caption states none', () => {
    const t = captionText(el('<field><font typeface="Times New Roman" size="9pt"/><caption><value><text>N</text></value></caption></field>'));
    expect(t?.paras[0].runs[0]).toMatchObject({ family: ['Times New Roman'], size: 9 });
  });

  it('reads the caption margin as its insets and its para as its alignment', () => {
    const t = captionText(el('<field><caption><margin leftInset="2pt"/><para vAlign="middle" hAlign="right"/><value><text>N</text></value></caption></field>'));
    expect(t?.insets.l).toBe(2);
    expect(t?.vAlign).toBe('middle');
    expect(t?.paras[0].hAlign).toBe('right');
  });

  it('is undefined with no caption, a caption with no value, or a hidden caption', () => {
    expect(captionText(el('<field/>'))).toBeUndefined();
    expect(captionText(el('<field><caption reserve="1in"/></field>'))).toBeUndefined();
    expect(captionText(el('<field><caption presence="hidden"><value><text>N</text></value></caption></field>'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfarich-chrome.test.ts`
Expected: FAIL — `captionText` is not exported; `hAlign`/`vAlign`/`color` undefined.

- [ ] **Step 3: Implement**

In `src/xfarich.ts`:

1. Extend the types (lines 21-41):

```ts
export interface RunStyle { family: string[]; size: number; bold: boolean; italic: boolean }
/** Paint-only run properties (164g.4): written only when the template states a
 *  non-default value, so measurement and every existing `toEqual` see nothing. */
export interface RunPaint { color?: [number, number, number]; underline?: true; lineThrough?: true }
export interface RunSpec extends RunStyle, RunPaint { text: string }
export type XfaHAlign = 'center' | 'right' | 'justify' | 'justifyAll';
export interface ParaSpec {
  runs: RunSpec[];
  base: RunStyle;
  marginLeft: number; marginRight: number; textIndent: number;
  lineHeight: number; spaceAbove: number; spaceBelow: number;
  /** Absent means left (164g.4). Ignored by measurement. */
  hAlign?: XfaHAlign;
}
```

and in `LeafText` add:

```ts
  /** Absent means top (164g.4). Ignored by measurement. */
  vAlign?: 'middle' | 'bottom';
  /** Paint values that could not be read and fell back to a default. */
  notes?: string[];
```

2. `ParaBox` stays `Omit<ParaSpec, 'runs' | 'base'>` — it now includes optional `hAlign`. `ZERO_PARA` is unchanged (no `hAlign` key). In `paraOf`, after the measurement loop, read alignment without adding a key for `left`:

```ts
  const h = p.attrs.get('hAlign');
  if (h === 'center' || h === 'right' || h === 'justify' || h === 'justifyAll') out.hAlign = h;
  return out;
```

The `for (const k of Object.keys(ZERO_PARA) …)` loop is unchanged — it iterates the six measurement keys only.

3. A leaf's `vAlign` and run paint. Add helpers above `leafText`:

```ts
function vAlignOf(el: XmlNode): LeafText['vAlign'] {
  const v = child(el, 'para')?.attrs.get('vAlign');
  return v === 'middle' || v === 'bottom' ? v : undefined;
}

/** `<font>`'s colour (`<fill><color>`) and decoration, p. 741. */
function paintOf(el: XmlNode, notes: string[]): RunPaint {
  const f = child(el, 'font');
  if (!f) return {};
  const out: RunPaint = {};
  const v = child(child(f, 'fill') ?? f, 'color')?.attrs.get('value');
  if (v !== undefined) {
    const n = v.split(',').map((s) => Number(s.trim()));
    if (n.length === 3 && n.every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) {
      if (n.some((x) => x !== 0)) out.color = [n[0] / 255, n[1] / 255, n[2] / 255];
    } else notes.push(`font color value="${v}" could not be read, so black is used`);
  }
  const u = f.attrs.get('underline');
  if (u !== undefined && u !== '0') out.underline = true;
  const lt = f.attrs.get('lineThrough');
  if (lt !== undefined && lt !== '0') out.lineThrough = true;
  return out;
}
```

Note the colour check: `<color value="0,0,0"/>` is black, the default, and writes no key.

4. `plainParas(text, base, para)` keeps its signature; add an optional 4th parameter `paint: RunPaint = {}` and spread it into each run: `runs: rec === '' ? [] : [{ ...base, ...paint, text: rec }]`.

5. Rich text. Remove `'color'`, `'text-decoration'` and `'text-align'` from `NO_SIZE`. Change `Ctx` to `{ style: RunStyle; paint: RunPaint; spacerun: boolean }`, and give `applyCss` a `notes: string[]` parameter. Add three cases before `default:`:

```ts
      case 'color': {
        const c = cssColor(v);
        if (c === undefined) { notes.push('color in rich text could not be read, so black is used'); break; }
        if (c.some((x) => x !== 0)) paint.color = c; else delete paint.color;
        break;
      }
      case 'text-decoration': {
        const words = v.filter((t) => t.kind === 'ident').map((t) => (t as { value: string }).value.toLowerCase());
        if (words.includes('none')) { delete paint.underline; delete paint.lineThrough; }
        if (words.includes('underline')) paint.underline = true;
        if (words.includes('line-through')) paint.lineThrough = true;
        break;
      }
      case 'text-align': {
        if (!para) break;
        const a = kw === 'center' || kw === 'right' ? kw : kw === 'justify' ? 'justify' : undefined;
        if (a !== undefined) para.hAlign = a; else delete para.hAlign;
        break;
      }
```

with `const paint = { ...ctx.paint };` beside `const style = { ...ctx.style };`, returning `{ style, paint, spacerun }`. `cssColor` is a small helper:

```ts
/** A CSS colour as 0..1 RGB: `#rgb`, `#rrggbb` or `rgb(r, g, b)`. */
function cssColor(v: CssValue[]): [number, number, number] | undefined {
  if (v.length === 1 && v[0].kind === 'hash') {
    const h = v[0].value;
    const six = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(six)) return undefined;
    return [0, 2, 4].map((i) => parseInt(six.slice(i, i + 2), 16) / 255) as [number, number, number];
  }
  if (v.length === 1 && v[0].kind === 'function' && v[0].name.toLowerCase() === 'rgb') {
    const n = v[0].value.filter((t) => t.kind === 'number').map((t) => (t as { value: number }).value);
    if (n.length === 3 && n.every((x) => x >= 0 && x <= 255)) return [n[0] / 255, n[1] / 255, n[2] / 255];
  }
  return undefined;
}
```

Check `CssValue`'s `hash` and `function` shapes in `src/cssparse.ts` before relying on `.value`/`.name`; adjust the property names to match the actual type if they differ (the test pins the behaviour, not the field names).

6. `RichBuilder`: thread `notes` through it (constructor param), pass `ctx.paint` into runs (`p.runs.push({ ...s, ...ctx.paint, text: t })`), and extend the merge predicate so runs differing in paint do not merge:

```ts
    const samePaint = (a: RunPaint, b: RunPaint) =>
      (a.color ?? []).join() === (b.color ?? []).join() && !!a.underline === !!b.underline && !!a.lineThrough === !!b.lineThrough;
    if (prev && prev.size === s.size && prev.bold === s.bold && prev.italic === s.italic
      && prev.family.join('\0') === s.family.join('\0') && samePaint(prev, ctx.paint)) prev.text += t;
    else p.runs.push({ ...s, ...ctx.paint, text: t });
```

`br` pushes `{ ...ctx.style, ...ctx.paint, text: '\n' }`.

7. `leafText`: compute `const notes: string[] = []`, `const paint = paintOf(el, notes)`, `const vAlign = vAlignOf(el)`. Add `...(vAlign ? { vAlign } : {})` to `out`. Pass `paint` into the plain path: `plainParas(text, base, pb, paint)`. Start rich text with `{ style: base, paint, spacerun: false }` and pass `notes` to `RichBuilder`. Before every `return`, attach notes when non-empty: `...(notes.length ? { notes } : {})`. Factor this as a local `done = (t: LeafText): LeafText => (notes.length ? { ...t, notes } : t)` and wrap each return.

8. `withValue` keeps `vAlign` (it spreads `rest`) and the first paragraph's `hAlign`: add `...(p?.hAlign ? { hAlign: p.hAlign } : {})` to `box`. It re-applies the first run's paint: `plainParas(value, base, box, p?.runs[0] ? pickPaint(p.runs[0]) : {})`, where `pickPaint` copies only `color`/`underline`/`lineThrough`.

9. `captionText`:

```ts
/** A field's `<caption>` text, laid out in its caption region (164g.4). Its
 *  `<font>`, else the FIELD's -- pdf.js inherits the field's through CSS, and
 *  XFA's own default (Courier 10) would put a different face beside every
 *  field. Undefined when there is no caption, it holds no value, or it is
 *  hidden or inactive. */
export function captionText(field: XmlNode): LeafText | undefined {
  const cap = child(field, 'caption');
  if (!cap || !child(cap, 'value')) return undefined;
  const pr = cap.attrs.get('presence');
  if (pr === 'hidden' || pr === 'inactive') return undefined;
  const ff = child(field, 'font');
  const el = child(cap, 'font') || !ff ? cap : { ...cap, children: [...cap.children, ff] };
  return leafText(el);
}
```

`leafText` reads `caption` only when `el.name === 'field'`, so a caption element yields no nested caption.

- [ ] **Step 4: Run the new tests and the existing xfarich, xfatext and template-text tests**

Run: `npx vitest run test/xfarich-chrome.test.ts test/xfarich.test.ts test/xfatext.test.ts test/xfatemplate-text.test.ts test/xfaflow-measure.test.ts`
Expected: all PASS. The existing files must pass UNEDITED; if one fails, a key leaked into the default case.

- [ ] **Step 5: Typecheck, run the XFA oracles, commit**

```bash
npm run typecheck
npx vitest run test/xfa-dynamic-oracle.test.ts test/xfa-real.test.ts test/xfa-master-oracle.test.ts
git add src/xfarich.ts test/xfarich-chrome.test.ts
git commit -m "feat(164g.4): XFA text alignment, colour, decoration and caption text"
```

---

### Task 3: Chrome on the layout tree (`xfatemplate.ts`)

**Files:**
- Modify: `src/xfaflow.ts:49-84` (add `chrome?: NodeChrome` to `LayoutNode`)
- Modify: `src/xfatemplate.ts` (`XfaField` add `widgetBorder`; `nodeOf` 426-469; `fieldOf`)
- Test: `test/xfatemplate-chrome.test.ts`

**Interfaces:**
- Consumes: `parseBorder`, `parseGeometry`, `NodeChrome`, `XfaBorder` (Task 1); `captionText` (Task 2).
- Produces: `LayoutNode.chrome?: NodeChrome`; `XfaField.widgetBorder?: XfaBorder`.

Rules:
- Any node (`subform`, `area`, `exclGroup`, `field`, `draw`) whose element has a direct `<border>` child gets `chrome.border = parseBorder(...)`, EXCEPT a field whose `<ui>` child is `<button>`: that border is the widget's.
- A `draw` whose `<value>` holds `<line>`/`<rectangle>`/`<arc>` gets `chrome.geometry`.
- A `field` gets `chrome.caption = captionText(el)`, `chrome.captionPresence` (verbatim), `chrome.fieldCaption` and `chrome.fieldMargin` (the same `XfaCaption`/`XfaMargin` objects `fieldOf` already builds for `XfaField.caption`/`.margin`).
- `XfaField.widgetBorder`: the `<ui>/<*>/<border>` when present; for a `<button>` field, the field's own `<border>`.
- `chrome` is omitted entirely when empty, so nodes without chrome are unchanged (existing tree `toEqual`s stay green).

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfatemplate-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import type { LayoutNode } from '../src/xfaflow.js';

const tpl = (body: string) => parseXfaTemplate(parseXml(new TextEncoder().encode(
  `<template><subform name="form1" layout="tb"><pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
   <contentArea w="8.5in" h="11in"/></pageArea></pageSet>${body}</subform></template>`)));
const find = (n: LayoutNode, pred: (n: LayoutNode) => boolean): LayoutNode | undefined =>
  pred(n) ? n : n.children.map((c) => find(c, pred)).find((x) => x !== undefined);

describe('xfatemplate: chrome on the layout tree (164g.4)', () => {
  it("puts a subform's own border on its node", () => {
    const t = tpl('<subform name="S" layout="position" w="1in" h="1in"><border><edge thickness="2pt"/></border></subform>');
    const s = find(t.body!.root, (n) => n.label === 'S[0]')!;
    expect(s.chrome?.border?.edges?.[0].thickness).toBe(2);
  });

  it("puts a draw's geometry and border on its node", () => {
    const t = tpl('<subform name="S" layout="position"><draw x="0" y="0" w="1in" h="0"><value><line/></value><border><edge/></border></draw></subform>');
    const d = find(t.body!.root, (n) => n.kind === 'draw')!;
    expect(d.chrome?.geometry?.kind).toBe('line');
    expect(d.chrome?.border).toBeDefined();
  });

  it("puts a field's caption text, caption and margin on its node, and its ui border on the field", () => {
    const t = tpl(`<subform name="S" layout="position"><field name="f" x="0" y="0" w="2in" h="20pt">
      <ui><textEdit><border><edge stroke="lowered"/></border></textEdit></ui>
      <caption reserve="1in" placement="left"><value><text>Name</text></value></caption>
      <margin leftInset="1pt"/><border><edge/></border></field></subform>`);
    const n = find(t.body!.root, (x) => x.kind === 'field')!;
    expect(n.chrome?.caption?.paras[0].runs[0].text).toBe('Name');
    expect(n.chrome?.fieldCaption).toEqual({ reserve: '1in', placement: 'left' });
    expect(n.chrome?.fieldMargin).toEqual({ leftInset: '1pt' });
    expect(n.chrome?.border).toBeDefined();
    expect(t.fields[0].widgetBorder?.edges?.[0].stroke).toBe('lowered');
  });

  it("gives a push button's field border to its widget, not to the page", () => {
    const t = tpl(`<subform name="S" layout="position"><field name="b" x="0" y="0" w="1in" h="20pt">
      <ui><button/></ui><border><edge stroke="raised"/></border></field></subform>`);
    const n = find(t.body!.root, (x) => x.kind === 'field')!;
    expect(n.chrome?.border).toBeUndefined();
    expect(t.fields[0].widgetBorder?.edges?.[0].stroke).toBe('raised');
  });

  it('carries no chrome key on a node that states none', () => {
    const t = tpl('<subform name="S" layout="position"><field name="f" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>');
    expect('chrome' in find(t.body!.root, (x) => x.kind === 'field')!).toBe(false);
  });

  it('reads chrome on a master page too', () => {
    const t = parseXfaTemplate(parseXml(new TextEncoder().encode(
      `<template><subform name="form1" layout="tb"><pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
       <contentArea w="8.5in" h="11in"/><draw x="0" y="0" w="1in" h="10pt"><value><text>CUI</text></value><border><edge/></border></draw>
       </pageArea></pageSet><subform name="S"/></subform></template>`)));
    const m = t.body!.pageSet!.pageAreas[0].master!;
    expect(find(m, (n) => n.kind === 'draw')?.chrome?.border).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfatemplate-chrome.test.ts`
Expected: FAIL — `chrome` undefined, `widgetBorder` undefined.

- [ ] **Step 3: Implement**

In `src/xfaflow.ts` add `import type { NodeChrome } from './xfaborder.js';` and to `LayoutNode`:

```ts
  /** What this node paints beside its box (164g.4): its border, a draw's
   *  geometry, a field's caption. Absent when it paints nothing of its own. */
  chrome?: NodeChrome;
```

In `src/xfatemplate.ts` add imports `import { captionText } from './xfarich.js';` (merge with the existing `leafText` import) and `import { parseBorder, parseGeometry, type NodeChrome, type XfaBorder } from './xfaborder.js';`. Add to `XfaField`:

```ts
  /** The WIDGET's border (164g.4): `<ui>/<*>/<border>`, or for a push button
   *  the field's own `<border>`. Mapped to `/MK` + `/BS`, never painted. */
  widgetBorder?: XfaBorder;
```

Add a helper and call it at the end of `nodeOf`, before `return n`:

```ts
/** The page-content half of a node's chrome (164g.4). */
function chromeOf(el: XmlNode, kind: LayoutKind): NodeChrome | undefined {
  const c: NodeChrome = {};
  const isButton = kind === 'field' && child(el, 'ui')?.children[0]?.name === 'button';
  const border = child(el, 'border');
  if (border && !isButton) c.border = parseBorder(border);
  if (kind === 'draw') {
    const v = child(el, 'value');
    const g = v ? parseGeometry(v) : undefined;
    if (g) c.geometry = g;
  }
  if (kind === 'field') {
    const cap = captionText(el);
    if (cap) c.caption = cap;
    const ce = child(el, 'caption');
    const pr = ce?.attrs.get('presence');
    if (pr !== undefined) c.captionPresence = pr;
    const fc = captionAttrs(el);
    if (fc) c.fieldCaption = fc;
    const fm = marginOf(el);
    if (fm) c.fieldMargin = fm;
  }
  return Object.keys(c).length > 0 ? c : undefined;
}
```

`captionAttrs(el)` is the code `fieldOf` already uses to build `XfaField.caption` — extract it into this named helper and call it from both places, so the two cannot disagree. `marginOf` already exists (it builds `n.margin` for containers and `XfaField.margin`).

In `nodeOf`: `const ch = chromeOf(el, kind); if (ch) n.chrome = ch;`

In `fieldOf`, set `widgetBorder`:

```ts
  const uiEl = child(el, 'ui')?.children[0];
  const wb = uiEl?.name === 'button' ? child(el, 'border') : uiEl ? child(uiEl, 'border') : undefined;
  if (wb) f.widgetBorder = parseBorder(wb);
```

(Insert after the field object `f` is built; name the variable to match `fieldOf`'s existing local.)

- [ ] **Step 4: Run the new and existing template tests**

Run: `npx vitest run test/xfatemplate-chrome.test.ts test/xfatemplate.test.ts test/xfatemplate-text.test.ts test/xfapage.test.ts`
Expected: PASS, existing files unedited.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/xfaflow.ts src/xfatemplate.ts test/xfatemplate-chrome.test.ts
git commit -m "feat(164g.4): read XFA chrome onto layout nodes and widget borders onto fields"
```

---

### Task 4: Layout reports what it placed (`xfaflow.ts`, `xfapage.ts`)

**Files:**
- Modify: `src/xfaflow.ts` (`Engine.emit` 698-744; `layoutPage` 791-803)
- Modify: `src/xfapage.ts:524-561` (`LaidOutPage`, `layoutPages`)
- Test: `test/xfaflow-placed.test.ts`

**Interfaces:**
- Produces:

```ts
export type PlacedNode =
  | { node: LayoutNode; box: XfaBox; invisible: boolean }
  | { node: LayoutNode; reason: string };
export function layoutPage(root: LayoutNode, measure?: XfaMeasure, warnings?: string[], nodes?: PlacedNode[]): Map<string, Placed>;
export interface LaidOutPage { pageArea: number; pageSet: number; placed: Map<string, Placed>; nodes: PlacedNode[] }
```

Rules (in `emit`):
- A concealed node (`hidden`/`inactive`) records nothing.
- `invisible` propagates down: a node is invisible when it, or any ancestor, has `presence="invisible"` (p. 630: a container's contents inherit).
- A LEAF (field or draw, named or not): compute its size and the flow bottom check exactly as named fields are checked today. On success push `{ node, box, invisible }`, then `put` the field name if it has one. On failure push `{ node, reason }` only when the leaf is NOT a named field (a named field's refusal is already reported as a field).
- A CONTAINER other than `page`: when its own extent failed and not `fromChild`, push `{ node, reason }` and `assignAll` as today. When its extent failed `fromChild`, push `{ node, reason }` (its size is not known, so its border cannot be drawn) and still emit its children. Otherwise push `{ node, box: { x, y, w, h }, invisible }` BEFORE emitting children (document order, parent first), with `w`/`h` from `forced ?? extent`.
- A child whose slot failed: push `{ node: child, reason }` once for the child (not its descendants), then `assignAll` as today.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfaflow-placed.test.ts
import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type PlacedNode } from '../src/xfaflow.js';

const leaf = (label: string, geom: Record<string, string>, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'draw', label, geom, children: [], ...extra });
const page = (children: LayoutNode[], geom: Record<string, string> = { w: '612pt', h: '792pt' }): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'tb', geom, children });

const run = (root: LayoutNode) => { const nodes: PlacedNode[] = []; layoutPage(root, undefined, [], nodes); return nodes; };
const boxes = (ns: PlacedNode[]) => ns.map((n) => ('box' in n ? `${n.node.label}@${n.box.x},${n.box.y},${n.box.w},${n.box.h}` : `${n.node.label}!`));

describe('layoutPage: placed nodes (164g.4)', () => {
  it('reports draws, which have no SOM name, with their boxes', () => {
    const ns = run(page([leaf('d1', { w: '10pt', h: '5pt' }), leaf('d2', { w: '10pt', h: '7pt' })]));
    expect(boxes(ns)).toEqual(['d1@0,0,10,5', 'd2@0,5,10,7']);
  });

  it('reports a container BEFORE its children, in document order', () => {
    const s: LayoutNode = { kind: 'subform', label: 'S', layout: 'position', geom: { w: '50pt', h: '40pt' },
      children: [leaf('a', { x: '5pt', y: '6pt', w: '1pt', h: '1pt' })] };
    expect(boxes(run(page([s])))).toEqual(['S@0,0,50,40', 'a@5,6,1,1']);
  });

  it('marks a node invisible when an ancestor is, and records nothing for a hidden one', () => {
    const s: LayoutNode = { kind: 'subform', label: 'S', layout: 'position', presence: 'invisible',
      geom: { w: '10pt', h: '10pt' }, children: [leaf('a', { w: '1pt', h: '1pt' })] };
    const h = leaf('h', { w: '1pt', h: '1pt' }, { presence: 'hidden' });
    const ns = run(page([s, h]));
    expect(ns.map((n) => ('box' in n ? `${n.node.label}:${String(n.invisible)}` : '?'))).toEqual(['S:true', 'a:true']);
  });

  it('reports a draw that overflows its contentArea as refused, with a reason', () => {
    const ns = run(page([leaf('big', { w: '10pt', h: '900pt' })]));
    expect(ns).toHaveLength(1);
    expect('reason' in ns[0] && ns[0].reason).toMatch(/overflows its contentArea/);
  });

  it('does not report a refused NAMED field as a placed node (it is reported as a field)', () => {
    const f = leaf('f', { w: '10pt', h: '900pt' }, { kind: 'field', field: 'form1[0].f[0]' });
    expect(run(page([f]))).toEqual([]);
  });

  it('uses a table cell size for the leaf it forces', () => {
    const row: LayoutNode = { kind: 'subform', label: 'R', layout: 'row', geom: {},
      children: [leaf('c1', { w: '10pt', h: '5pt' }), leaf('c2', { w: '10pt', h: '9pt' })] };
    const t: LayoutNode = { kind: 'subform', label: 'T', layout: 'table', columnWidths: '20pt 20pt', geom: {}, children: [row] };
    const ns = run(page([t]));
    expect(boxes(ns)).toContain('c1@0,0,20,9');
  });

  it('leaves the field map unchanged', () => {
    const f = leaf('f', { w: '10pt', h: '5pt' }, { kind: 'field', field: 'form1[0].f[0]' });
    const nodes: PlacedNode[] = [];
    const m = layoutPage(page([f]), undefined, [], nodes);
    expect(m.get('form1[0].f[0]')).toEqual({ box: { x: 0, y: 0, w: 10, h: 5 } });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfaflow-placed.test.ts`
Expected: FAIL — `layoutPage` ignores a fourth argument; `PlacedNode` not exported.

- [ ] **Step 3: Implement**

In `src/xfaflow.ts`:

```ts
/** One node the layout placed, or why it has no box (164g.4): chrome is
 *  painted from these. Document order, a container before its children. */
export type PlacedNode =
  | { node: LayoutNode; box: XfaBox; invisible: boolean }
  | { node: LayoutNode; reason: string };
```

Change `emit`'s signature to

```ts
  emit(
    n: LayoutNode, x: number, y: number, forced: Size | undefined,
    flow: string | undefined, out: Map<string, Placed>,
    nodes: PlacedNode[] | undefined, invisible: boolean,
  ): void {
```

and rewrite its body:

```ts
    const hid = concealed(n);
    if (hid !== undefined) { this.assignAll(n, hid, out); return; }
    const inv = invisible || n.presence === 'invisible';
    if (isLeaf(n)) {
      const refuse = (reason: string): void => {
        if (n.field !== undefined) this.put(out, n.field, { reason });
        else nodes?.push({ node: n, reason });
      };
      const size = forced ?? this.extent(n);
      if (isFail(size)) { refuse(size.reason); return; }
      if (flow !== undefined) {
        if (this.bottom === undefined) {
          refuse(`${n.label}: sits under layout="${flow}" and its pageArea declares no `
            + 'contentArea height, so the flow cannot be bounded');
          return;
        }
        if (y + size.h > this.bottom + EPS) {
          refuse(`${n.label}: overflows its contentArea, which needs ${SPLIT_LATER}`);
          return;
        }
      }
      const box = { x, y, w: size.w, h: size.h };
      nodes?.push({ node: n, box, invisible: inv });
      if (n.field !== undefined) this.put(out, n.field, { box });
      return;
    }
    if (n.kind !== 'page') {
      const e = this.extent(n);
      if (isFail(e) && !e.fromChild) {
        nodes?.push({ node: n, reason: e.reason });
        this.assignAll(n, e.reason, out);
        return;
      }
      const size = forced ?? (isFail(e) ? undefined : e);
      if (size === undefined) nodes?.push({ node: n, reason: (e as Fail).reason });
      else nodes?.push({ node: n, box: { x, y, w: size.w, h: size.h }, invisible: inv });
    }
    const lay = n.layout ?? 'position';
    const inner = flow ?? (n.kind !== 'page' && lay !== 'position' ? lay : undefined);
    const slots = this.arrange(n);
    for (const c of n.children) {
      const hidden = concealed(c);
      if (hidden !== undefined) { this.assignAll(c, hidden, out); continue; }
      const s = slots.get(c);
      if (s === undefined) continue;
      if (isFail(s)) {
        if (c.field === undefined) nodes?.push({ node: c, reason: s.reason });
        this.assignAll(c, s.reason, out);
      } else this.emit(c, x + s.x, y + s.y, s.size, inner, out, nodes, inv);
    }
```

Note the leaf path previously returned early for `n.field === undefined` BEFORE sizing; now it sizes every leaf. That is the point (draws are now laid out), and it costs one extra `extent` per draw, memoized.

`layoutPage` gains `nodes?: PlacedNode[]` and calls `engine.emit(root, x ?? 0, y ?? 0, undefined, undefined, out, nodes, false)`.

In `src/xfapage.ts`, `LaidOutPage` gains `nodes: PlacedNode[]`; in `layoutPages`, create `const nodes: PlacedNode[] = []` per page, pass it to every `layoutPage(...)` call for that page's content areas, and return `{ pageArea, pageSet, placed, nodes }`. Import `type PlacedNode` from `./xfaflow.js`.

- [ ] **Step 4: Run the new and every XFA layout test**

Run: `npx vitest run test/xfaflow-placed.test.ts test/xfaflow.test.ts test/xfaflow-measure.test.ts test/xfaflow-table-measure.test.ts test/xfapage.test.ts test/xfa-flow-oracle.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-master-oracle.test.ts test/xfa-real.test.ts`
Expected: PASS, existing files unedited. A changed field box or count there means `emit` moved a field.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/xfaflow.ts src/xfapage.ts test/xfaflow-placed.test.ts
git commit -m "feat(164g.4): XFA layout reports every placed node, draws and containers included"
```

---

### Task 5: Caption region and laid-out lines (`xfageom.ts`, `xfatext.ts`)

**Files:**
- Modify: `src/xfageom.ts` (add `fieldRegions` after `editRegion`, line ~345)
- Modify: `src/xfatext.ts` (refactor `measurePara`/`measureLeaf` into `layoutLeaf`)
- Test: `test/xfageom-regions.test.ts`, `test/xfatext-layout.test.ts`

**Interfaces:**
- Produces:

```ts
// xfageom.ts
export function fieldRegions(box: XfaBox, caption?: XfaCaption, margin?: XfaMargin):
  { edit: XfaBox; caption?: XfaBox } | { reason: string };

// xfatext.ts
export interface LeafSegment { run: number; text: string; width: number }
export interface LeafLine {
  /** Baseline, from the top of the leaf's text block (insets excluded). */
  baseline: number;
  /** Left edge of the line before alignment: marginLeft, plus textIndent on a paragraph's first line. */
  left: number;
  /** Width the line may align within. */
  room: number;
  width: number;
  para: number;
  /** Last line of its paragraph (justify leaves it ragged). */
  last: boolean;
  segments: LeafSegment[];
}
export interface LeafLayout { lines: LeafLine[]; w: number; h: number; text: LeafText }
export function layoutLeaf(t: LeafText, box: MeasureBox, faces: FaceLookup): LeafLayout | { reason: string };
```

`fieldRegions` rules: `edit` is EXACTLY `editRegion(box, caption, margin)` (call it). `caption` is the band of the content region (`box` minus `margin`, p. 50) on the `placement` side, `reserve` deep; absent when there is no caption, it is hidden, or its reserve is unstated or 0. `layoutLeaf` returns `text` (the masked leaf for a password) and lines in the text block's own frame; `measureLeaf` becomes `{ w, h }` of `layoutLeaf`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfageom-regions.test.ts
import { describe, it, expect } from 'vitest';
import { fieldRegions, editRegion } from '../src/xfageom.js';

const box = { x: 10, y: 20, w: 200, h: 30 };

describe('fieldRegions (XFA 3.3 p. 50: the caption is part of the nominal content region)', () => {
  it('returns editRegion unchanged as the edit region', () => {
    const cap = { reserve: '50pt', placement: 'left' };
    const m = { leftInset: '2pt', topInset: '1pt' };
    const r = fieldRegions(box, cap, m);
    expect('edit' in r && r.edit).toEqual(editRegion(box, cap, m));
  });

  it('puts a left caption in the content region, inset by the field margin', () => {
    const r = fieldRegions(box, { reserve: '50pt' }, { leftInset: '2pt', topInset: '1pt', bottomInset: '3pt' });
    expect('caption' in r && r.caption).toEqual({ x: 12, y: 21, w: 50, h: 26 });
  });

  it('puts right, top and bottom captions on their own edge', () => {
    const rr = fieldRegions(box, { reserve: '40pt', placement: 'right' });
    expect('caption' in rr && rr.caption).toEqual({ x: 170, y: 20, w: 40, h: 30 });
    const rt = fieldRegions(box, { reserve: '10pt', placement: 'top' });
    expect('caption' in rt && rt.caption).toEqual({ x: 10, y: 20, w: 200, h: 10 });
    const rb = fieldRegions(box, { reserve: '10pt', placement: 'bottom' });
    expect('caption' in rb && rb.caption).toEqual({ x: 10, y: 40, w: 200, h: 10 });
  });

  it('makes caption and edit region exact complements within the content region', () => {
    const r = fieldRegions(box, { reserve: '50pt' }, { leftInset: '2pt', rightInset: '4pt' });
    if (!('edit' in r) || !r.caption) throw new Error('expected both');
    expect(r.caption.x + r.caption.w).toBeCloseTo(r.edit.x, 9);
    expect(r.edit.x + r.edit.w).toBeCloseTo(box.x + box.w - 4, 9);
  });

  it('has no caption region with no caption, a hidden one, or an unstated reserve', () => {
    for (const cap of [undefined, { reserve: '5pt', presence: 'hidden' }, { placement: 'left' }]) {
      const r = fieldRegions(box, cap);
      expect('edit' in r && r.caption).toBeUndefined();
    }
  });

  it('refuses with editRegion\'s own reason', () => {
    const r = fieldRegions(box, { reserve: '300pt' });
    expect(r).toEqual(editRegion(box, { reserve: '300pt' }));
  });
});
```

```ts
// test/xfatext-layout.test.ts
import { describe, it, expect } from 'vitest';
import { layoutLeaf, measureLeaf, type FaceLookup } from '../src/xfatext.js';
import type { LeafText } from '../src/xfarich.js';

// Every glyph 500 units wide, ascent 800, descent 200, 1000/em.
const faces: FaceLookup = () => ({ unitsPerEm: 1000, ascent: 800, descent: 200, advance: () => 500 });
const base = { family: ['X'], size: 10, bold: false, italic: false };
const para = (text: string, extra = {}) => ({
  runs: [{ ...base, text }], base, marginLeft: 0, marginRight: 0, textIndent: 0,
  lineHeight: 0, spaceAbove: 0, spaceBelow: 0, ...extra,
});
const leaf = (paras: ReturnType<typeof para>[], extra: Partial<LeafText> = {}): LeafText =>
  ({ kind: 'text', paras, insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false, ...extra });

describe('layoutLeaf (164g.4): the lines measureLeaf breaks', () => {
  it('agrees with measureLeaf on the extent', () => {
    const t = leaf([para('aaaa bbbb cccc'), para('dd')]);
    const l = layoutLeaf(t, { width: 40 }, faces);
    const m = measureLeaf(t, { width: 40 }, faces);
    if ('reason' in l || 'reason' in m) throw new Error('refused');
    expect({ w: l.w, h: l.h }).toEqual(m);
  });

  it('puts the baseline the ascent below each line band', () => {
    const l = layoutLeaf(leaf([para('aaaa bbbb')]), { width: 25 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines.map((x) => x.baseline)).toEqual([8, 18]);
  });

  it('marks the last line of each paragraph', () => {
    const l = layoutLeaf(leaf([para('aaaa bbbb'), para('c')]), { width: 25 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines.map((x) => `${String(x.para)}:${String(x.last)}`)).toEqual(['0:false', '0:true', '1:true']);
  });

  it('adds max(spaceBelow, spaceAbove) between paragraphs', () => {
    const l = layoutLeaf(leaf([para('a', { spaceBelow: 3 }), para('b', { spaceAbove: 5 })]), { width: 100 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines[1].baseline).toBe(10 + 5 + 8);
  });

  it('starts a first line at marginLeft + textIndent and gives it the room left', () => {
    const l = layoutLeaf(leaf([para('aaaa bbbb', { marginLeft: 4, textIndent: 6 })]), { width: 100 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines[0]).toMatchObject({ left: 10, room: 90 });
  });

  it('carries each segment\'s run and width', () => {
    const l = layoutLeaf(leaf([para('ab')]), { width: 100 }, faces);
    if ('reason' in l) throw new Error(l.reason);
    expect(l.lines[0].segments).toEqual([{ run: 0, text: 'ab', width: 10 }]);
  });

  it('refuses exactly as measureLeaf does', () => {
    const t = leaf([para('a')], { refusal: 'nope' });
    expect(layoutLeaf(t, { width: 10 }, faces)).toEqual({ reason: 'nope' });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfageom-regions.test.ts test/xfatext-layout.test.ts`
Expected: FAIL — `fieldRegions` and `layoutLeaf` not exported.

- [ ] **Step 3: Implement `fieldRegions`**

```ts
/**
 * A field's edit region AND caption region (164g.4), from one function so the
 * two cannot overlap or leave a gap. `edit` is `editRegion`'s answer exactly.
 * The caption sits in the nominal content region -- the box less the field's
 * margin (XFA 3.3 p. 50) -- on its `placement` side, `reserve` deep; pdf.js
 * places it the same way (its `Caption` inside the margin-padded field).
 */
export function fieldRegions(
  box: XfaBox, caption?: XfaCaption, margin?: XfaMargin,
): { edit: XfaBox; caption?: XfaBox } | { reason: string } {
  const edit = editRegion(box, caption, margin);
  if ('reason' in edit) return edit;
  if (!caption || caption.presence === 'hidden' || caption.reserve === undefined) return { edit };
  const r = measureToPt(caption.reserve);
  if (r === undefined || r <= 0) return { edit };
  const content = applyMargin(box, margin);
  if ('reason' in content) return { edit };
  const edge = CAPTION_EDGE[caption.placement ?? 'left'];
  if (edge === 'left') return { edit, caption: { x: content.x, y: content.y, w: r, h: content.h } };
  if (edge === 'right') return { edit, caption: { x: content.x + content.w - r, y: content.y, w: r, h: content.h } };
  if (edge === 'top') return { edit, caption: { x: content.x, y: content.y, w: content.w, h: r } };
  return { edit, caption: { x: content.x, y: content.y + content.h - r, w: content.w, h: r } };
}
```

- [ ] **Step 4: Implement `layoutLeaf`**

Refactor `measurePara` into `layoutPara(p, width, grow, faces, paraIndex, top)` returning `{ lines: LeafLine[]; w: number; h: number } | { reason }`. It keeps every existing rule (the empty-paragraph line, the `grow` whitespace refusal, `layoutRuns(runs, avail, WIDE, 1, p.base.size, p.textIndent)`) and additionally builds one `LeafLine` per laid line:

```ts
    const lineH = Math.max(asc + desc, p.lineHeight);
    out.push({
      baseline: top + h + asc,
      left: p.marginLeft + (i === 0 ? p.textIndent : 0),
      room: avail - (i === 0 ? p.textIndent : 0),
      width: line.width,
      para: paraIndex,
      last: i === res.lines.length - 1,
      segments: line.segments.map((s) => ({ run: s.run, text: s.text, width: s.width })),
    });
    h += lineH;
```

(`asc`/`desc` are the values the current loop already computes per line; an empty paragraph yields one line with no segments, `width` 0, baseline `top + asc` of its base style.) When `lineHeight` exceeds `asc + desc`, the baseline stays `asc` below the band top — XFA places the extra leading below (p. 61: line height is the tallest glyph box).

`layoutLeaf(t0, box, faces)` is `measureLeaf`'s current body, accumulating lines: it keeps the refusals, the password `mask`, the caption reserve and the insets, calls `layoutPara(..., index, h + spacing)` per paragraph, and returns `{ lines, w, h, text: t }` where `w`/`h` are exactly the values `measureLeaf` returns today. Then:

```ts
export function measureLeaf(
  t0: LeafText, box: MeasureBox, faces: FaceLookup,
): { w: number; h: number } | { reason: string } {
  const l = layoutLeaf(t0, box, faces);
  return 'reason' in l ? l : { w: l.w, h: l.h };
}
```

`layoutLeaf`'s `h` and `w` include the insets and the caption reserve, as `measureLeaf`'s did; lines are in the text block's frame (after the top inset, before the left inset), and `xfachrome.ts` adds the insets back.

- [ ] **Step 5: Run the new and every measurement test**

Run: `npx vitest run test/xfageom-regions.test.ts test/xfatext-layout.test.ts test/xfatext.test.ts test/xfageom.test.ts test/xfaflow-measure.test.ts test/xfaflow-table-measure.test.ts test/xfaconvert-measure.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-real.test.ts`
Expected: PASS, existing files unedited.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/xfageom.ts src/xfatext.ts test/xfageom-regions.test.ts test/xfatext-layout.test.ts
git commit -m "feat(164g.4): XFA caption region from fieldRegions; layoutLeaf exposes the measured lines"
```

---

### Task 6: Border, fill and geometry operations (`xfachrome.ts`)

**Files:**
- Create: `src/xfachrome.ts`
- Test: `test/xfachrome-border.test.ts`

**Interfaces:**
- Consumes: `PlacedNode` (Task 4), `XfaBorder`/`XfaEdge`/`XfaCorner`/`XfaGeometry`/`Rgb` (Task 1).
- Produces:

```ts
export type PathCmd =
  | ['M', number, number] | ['L', number, number]
  | ['C', number, number, number, number, number, number] | ['Z'];
export type ChromeOp =
  | { kind: 'fill'; path: PathCmd[]; color: Rgb }
  | { kind: 'stroke'; path: PathCmd[]; color: Rgb; width: number; dash?: number[];
      cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' }
  | { kind: 'text'; x: number; y: number; text: string; style: RunStyle; color: Rgb;
      underline: boolean; lineThrough: boolean };
export interface ChromeResult { ops: ChromeOp[]; skipped: Array<{ name: string; reason: string }>; warnings: string[] }
export function chromeOps(nodes: readonly PlacedNode[], faces?: FaceLookup): ChromeResult;
export function borderOps(box: XfaBox, b: XfaBorder, out: ChromeOp[], skip: (r: string) => void): void;
```

All coordinates are in the XFA page frame (points, origin top-left, y DOWN). Rules this task owns, each with a citation comment at its code site:

- **Visibility.** A placed node with `invisible: true` paints nothing. A `{ node, reason }` entry with chrome (or any draw) is reported: `{ name: node.field ?? node.label, reason: \`${reason}, so its chrome is not painted\` }`.
- **Rect.** The border rectangle is the box inset by `border.margin` (p. 629).
- **Hand** (p. 630, and pdf.js `createWrapper`): the stroke CENTRELINE of an edge of thickness `t` lies on the rectangle for `even`, `t/2` outward for `left`, `t/2` inward for `right`.
- **Fill** (p. 38, 734): painted when `fill` is present: `solid` fills the border rectangle (with the same rounded corners as the stroke); `unsupported` is reported once per node as `a ${type} fill is not painted`. Fill comes BEFORE the stroke.
- **Uniform border.** When the four edges are all visible with equal `stroke`, `thickness` and `color`, and the four corners share `radius`, `join` and `inverted`: ONE closed stroked path, `join` miter for square corners, round for round ones.
- **Non-uniform border.** Each visible edge is its own open path from corner trim to corner trim, `cap` `square` (border edges have no termination, p. 687 — square caps make adjacent edges meet without a notch).
- **Corner trim** (p. 664, 687): each edge is trimmed from each end by that corner's `radius`; a round corner draws a quarter arc (cubic with `k = 0.5522847498`), convex unless `inverted` (concave: the arc's centre is the rectangle corner itself); a square inverted corner draws a right-angle notch of depth `radius`. With radius 0 a corner draws nothing of its own.
- **Dashes** (no spec figures; our choice, recorded at the code site): with `u = max(t, 0.25)`: `dashed` `[3u, 3u]` butt cap; `dotted` `[0, 2u]` round cap; `dashDot` `[3u, 2u, 0, 2u]` round cap; `dashDotDot` `[3u, 2u, 0, 2u, 0, 2u]` round cap.
- **3-D strokes in page content.** `lowered`/`raised`/`etched`/`embossed` on a page-content border are painted solid and reported: `a ${stroke} border edge is painted solid` (their only corpus instances are widget borders, which Task 9 maps properly).
- **`break="open"`.** Reported (`a break="open" border is drawn closed`) and drawn closed: chrome splitting does not exist.
- **Line draw** (p. 768): from the box's top-left to bottom-right for `\`, bottom-left to top-right for `/`; a zero-width or zero-height box is a straight rule. Uses the edge's own `cap`. `hand` offsets the line by `t/2` perpendicular (left of travel for `left`, right for `right`).
- **Rectangle draw** (p. 824): through `borderOps` with a border built from the rectangle's edges, corners, fill and hand, zero margin.
- **Arc draw:** reported, `an <arc> draw is not painted`.
- **Finiteness.** A box with `w <= 0` or `h <= 0` paints no border or fill (a line draw is the exception — it is the rule). Every emitted coordinate and width is finite; a dash array never holds a negative entry.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfachrome-border.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseBorder, parseGeometry } from '../src/xfaborder.js';
import { chromeOps, type ChromeOp } from '../src/xfachrome.js';
import type { LayoutNode, PlacedNode } from '../src/xfaflow.js';

const xml = (s: string) => parseXml(new TextEncoder().encode(s));
const node = (chrome: LayoutNode['chrome'], kind: LayoutNode['kind'] = 'subform'): LayoutNode =>
  ({ kind, label: 'N', geom: {}, children: [], chrome });
const at = (n: LayoutNode, box = { x: 10, y: 20, w: 100, h: 50 }, invisible = false): PlacedNode => ({ node: n, box, invisible });
const ops = (p: PlacedNode[]) => chromeOps(p).ops;
const strokes = (o: ChromeOp[]) => o.filter((x) => x.kind === 'stroke');

describe('chromeOps: borders (XFA 3.3 p. 38, 629-630, 663-665, 687-689)', () => {
  it('strokes a uniform border as one closed path on the rectangle (hand even)', () => {
    const o = ops([at(node({ border: parseBorder(xml('<border><edge thickness="2pt"/></border>')) }))]);
    expect(o).toEqual([{ kind: 'stroke', width: 2, color: [0, 0, 0], cap: 'butt', join: 'miter',
      path: [['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70], ['Z']] }]);
  });

  it('moves the centreline half a thickness INSIDE for hand right, OUTSIDE for left', () => {
    const r = strokes(ops([at(node({ border: parseBorder(xml('<border hand="right"><edge thickness="2pt"/></border>')) }))]))[0];
    expect(r.kind === 'stroke' && r.path[0]).toEqual(['M', 11, 21]);
    const l = strokes(ops([at(node({ border: parseBorder(xml('<border hand="left"><edge thickness="2pt"/></border>')) }))]))[0];
    expect(l.kind === 'stroke' && l.path[0]).toEqual(['M', 9, 19]);
  });

  it('insets the rectangle by the border margin', () => {
    const o = strokes(ops([at(node({ border: parseBorder(xml('<border><edge/><margin leftInset="5pt" topInset="4pt"/></border>')) }))]))[0];
    expect(o.kind === 'stroke' && o.path[0]).toEqual(['M', 15, 24]);
  });

  it('fills BEFORE stroking, over the border rectangle', () => {
    const o = ops([at(node({ border: parseBorder(xml('<border><edge/><fill><color value="255,0,0"/></fill></border>')) }))]);
    expect(o.map((x) => x.kind)).toEqual(['fill', 'stroke']);
    expect(o[0]).toMatchObject({ color: [1, 0, 0] });
  });

  it('fills but does not stroke a border with no <edge> (p. 38)', () => {
    const o = ops([at(node({ border: parseBorder(xml('<border><fill/></border>')) }))]);
    expect(o.map((x) => x.kind)).toEqual(['fill']);
  });

  it('strokes each visible edge separately, with square caps, when the edges differ', () => {
    const b = parseBorder(xml('<border><edge presence="hidden"/><edge presence="hidden"/><edge thickness="1pt"/><edge presence="hidden"/></border>'));
    const o = strokes(ops([at(node({ border: b }))]));
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ cap: 'square', path: [['M', 10, 70], ['L', 110, 70]] });
  });

  it('trims each edge by the corner radius and draws round corners as arcs', () => {
    const b = parseBorder(xml('<border><edge/><corner radius="5pt" join="round"/></border>'));
    const s = strokes(ops([at(node({ border: b }))]))[0];
    if (s.kind !== 'stroke') throw new Error();
    expect(s.join).toBe('round');
    expect(s.path[0]).toEqual(['M', 15, 20]);
    expect(s.path.filter((c) => c[0] === 'C')).toHaveLength(4);
  });

  it('gives each dash stroke its dash array', () => {
    const d = (s: string) => strokes(ops([at(node({ border: parseBorder(xml(`<border><edge stroke="${s}" thickness="1pt"/></border>`)) }))]))[0];
    expect(d('dashed')).toMatchObject({ dash: [3, 3], cap: 'butt' });
    expect(d('dotted')).toMatchObject({ dash: [0, 2], cap: 'round' });
    expect(d('dashDot')).toMatchObject({ dash: [3, 2, 0, 2] });
    expect(d('dashDotDot')).toMatchObject({ dash: [3, 2, 0, 2, 0, 2] });
  });

  it('paints a 3-D page-content edge solid and reports it', () => {
    const r = chromeOps([at(node({ border: parseBorder(xml('<border><edge stroke="lowered"/></border>')) }))]);
    expect(r.ops[0]).not.toHaveProperty('dash');
    expect(r.skipped).toEqual([{ name: 'N', reason: 'a lowered border edge is painted solid' }]);
  });

  it('reports an unsupported fill and an open break', () => {
    const r = chromeOps([at(node({ border: parseBorder(xml('<border break="open"><edge/><fill><linear/></fill></border>')) }))]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['a linear fill is not painted', 'a break="open" border is drawn closed']);
  });

  it('paints nothing for an invisible node or an invisible border', () => {
    expect(ops([at(node({ border: parseBorder(xml('<border><edge/></border>')) }), undefined, true)])).toEqual([]);
    expect(ops([at(node({ border: parseBorder(xml('<border presence="invisible"><edge/></border>')) }))])).toEqual([]);
  });

  it('reports a refused node that has chrome, and stays silent for one that has none', () => {
    const r = chromeOps([{ node: node({ border: parseBorder(xml('<border><edge/></border>')) }), reason: 'too tall' },
      { node: node(undefined), reason: 'too tall' }]);
    expect(r.skipped).toEqual([{ name: 'N', reason: 'too tall, so its chrome is not painted' }]);
  });

  // Review Focus 5: a degenerate box never puts NaN into a content stream.
  it('paints nothing for a zero-size box and stays finite for an edge thicker than the box', () => {
    expect(ops([at(node({ border: parseBorder(xml('<border><edge/></border>')) }), { x: 0, y: 0, w: 0, h: 10 })])).toEqual([]);
    const o = ops([at(node({ border: parseBorder(xml('<border hand="right"><edge thickness="50pt"/></border>')) }), { x: 0, y: 0, w: 4, h: 4 })]);
    const nums = JSON.stringify(o).match(/-?\d+(\.\d+)?(e-?\d+)?|null|NaN/g) ?? [];
    expect(nums).not.toContain('null');
    expect(nums).not.toContain('NaN');
  });
});

describe('chromeOps: draw geometry (p. 768, 824)', () => {
  const draw = (v: string) => node({ geometry: parseGeometry(xml(`<value>${v}</value>`))! }, 'draw');

  it('draws a \\ line top-left to bottom-right and a / line bottom-left to top-right', () => {
    expect(ops([at(draw('<line/>'))])[0]).toMatchObject({ path: [['M', 10, 20], ['L', 110, 70]], cap: 'square' });
    expect(ops([at(draw('<line slope="/"/>'))])[0]).toMatchObject({ path: [['M', 10, 70], ['L', 110, 20]] });
  });

  it('draws a zero-height line as a horizontal rule', () => {
    expect(ops([at(draw('<line/>'), { x: 0, y: 5, w: 30, h: 0 })])[0]).toMatchObject({ path: [['M', 0, 5], ['L', 30, 5]] });
  });

  it('draws a rectangle through the border engine', () => {
    const o = ops([at(draw('<rectangle><edge thickness="2pt"/></rectangle>'))]);
    expect(o[0]).toMatchObject({ kind: 'stroke', width: 2, path: [['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70], ['Z']] });
  });

  it('reports an arc and paints nothing for it', () => {
    const r = chromeOps([at(draw('<arc/>'))]);
    expect(r.ops).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'N', reason: 'an <arc> draw is not painted' }]);
  });

  it('paints a node\'s fill and border before its geometry', () => {
    const n: LayoutNode = { kind: 'draw', label: 'N', geom: {}, children: [], chrome: {
      border: parseBorder(xml('<border><fill/></border>')), geometry: parseGeometry(xml('<value><line/></value>'))! } };
    expect(ops([at(n)]).map((x) => x.kind)).toEqual(['fill', 'stroke']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfachrome-border.test.ts`
Expected: FAIL — cannot resolve `../src/xfachrome.js`.

- [ ] **Step 3: Implement `src/xfachrome.ts` (borders, fills, geometry)**

Module header: pure, never throws, coordinates in the XFA page frame, each rule cited. Core pieces:

```ts
// src/xfachrome.ts
/**
 * An XFA page's chrome as paint operations (164g.4): a placed node's border,
 * fill, draw geometry and text, in the XFA page frame (points, origin top-left,
 * y DOWN). `xfapaint.ts` flips it into PDF space.
 *
 * **Invariant: pure** -- placed nodes in, operations out. No `Document`; never
 * throws. A construct not painted is REPORTED, never silently dropped.
 *
 * Sources: XFA 3.3 (SHA-256 a3344e7e...ca01e), cited at each rule.
 */
import type { PlacedNode } from './xfaflow.js';
import type { XfaBox } from './xfageom.js';
import type { RunStyle } from './xfarich.js';
import type { FaceLookup } from './xfatext.js';
import type { Rgb, XfaBorder, XfaCorner, XfaEdge, XfaGeometry, XfaHand, XfaStroke } from './xfaborder.js';

export type PathCmd =
  | ['M', number, number] | ['L', number, number]
  | ['C', number, number, number, number, number, number] | ['Z'];
export type ChromeOp =
  | { kind: 'fill'; path: PathCmd[]; color: Rgb }
  | { kind: 'stroke'; path: PathCmd[]; color: Rgb; width: number; dash?: number[];
      cap: 'butt' | 'round' | 'square'; join: 'miter' | 'round' }
  | { kind: 'text'; x: number; y: number; text: string; style: RunStyle; color: Rgb;
      underline: boolean; lineThrough: boolean };
export interface ChromeResult { ops: ChromeOp[]; skipped: Array<{ name: string; reason: string }>; warnings: string[] }

/** The cubic approximation of a quarter circle. */
const K = 0.5522847498;
const THREE_D: ReadonlySet<XfaStroke> = new Set(['lowered', 'raised', 'etched', 'embossed']);

/** Our dash geometry: XFA 3.3 names the strokes (p. 688) and gives no
 *  lengths, so these are a stated choice, scaled by thickness. */
function dashOf(s: XfaStroke, t: number): { dash?: number[]; cap?: 'butt' | 'round' } {
  const u = Math.max(t, 0.25);
  switch (s) {
    case 'dashed': return { dash: [3 * u, 3 * u], cap: 'butt' };
    case 'dotted': return { dash: [0, 2 * u], cap: 'round' };
    case 'dashDot': return { dash: [3 * u, 2 * u, 0, 2 * u], cap: 'round' };
    case 'dashDotDot': return { dash: [3 * u, 2 * u, 0, 2 * u, 0, 2 * u], cap: 'round' };
    default: return {};
  }
}

/** p. 630: where an edge's centreline sits relative to the vector. */
const handShift = (hand: XfaHand, t: number): number => (hand === 'even' ? 0 : hand === 'left' ? t / 2 : -t / 2);
```

Then implement:

- `rectPath(r: XfaBox, corners: XfaCorner[]): PathCmd[]` — closed path clockwise from the top edge, trimming by radius and emitting a cubic per round corner (convex: control points `K * radius` along each edge toward the corner; concave/`inverted`: the arc centred ON the corner, bulging inward), and two `L`s forming a notch for a square `inverted` corner with radius > 0.
- `edgeSegment(r: XfaBox, i: 0|1|2|3, corners): PathCmd[]` — the `i`-th edge trimmed at both ends by its corners' radii.
- `uniform(b: XfaBorder): boolean` — every edge visible with equal `stroke`/`thickness`/`color`, and corners agreeing in `radius`/`join`/`inverted`.
- `borderOps(box, b, out, skip)`:

```ts
export function borderOps(box: XfaBox, b: XfaBorder, out: ChromeOp[], skip: (r: string) => void): void {
  if (!b.visible || !(box.w > 0) || !(box.h > 0)) return;
  const r = { x: box.x + b.margin.l, y: box.y + b.margin.t, w: box.w - b.margin.l - b.margin.r, h: box.h - b.margin.t - b.margin.b };
  if (!(r.w > 0) || !(r.h > 0)) return;
  if (b.fill?.kind === 'solid') out.push({ kind: 'fill', path: rectPath(r, b.corners), color: b.fill.color });
  else if (b.fill?.kind === 'unsupported') skip(`a ${b.fill.type} fill is not painted`);
  if (b.breakOpen) skip('a break="open" border is drawn closed');
  const edges = b.edges;
  if (!edges) return;
  for (const s of new Set(edges.filter((e) => e.visible && THREE_D.has(e.stroke)).map((e) => e.stroke)))
    skip(`a ${s} border edge is painted solid`);
  if (uniform(b)) {
    const e = edges[0];
    const d = handShift(b.hand, e.thickness);
    const rr = { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
    if (!(rr.w > 0) || !(rr.h > 0)) return;
    const ds = dashOf(e.stroke, e.thickness);
    out.push({ kind: 'stroke', path: rectPath(rr, b.corners), color: e.color, width: e.thickness,
      ...(ds.dash ? { dash: ds.dash } : {}), cap: ds.cap ?? 'butt',
      join: b.corners[0].join === 'round' && b.corners[0].radius > 0 ? 'round' : 'miter' });
    return;
  }
  edges.forEach((e, i) => {
    if (!e.visible) return;
    const d = handShift(b.hand, e.thickness);
    const rr = { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
    const ds = dashOf(e.stroke, e.thickness);
    out.push({ kind: 'stroke', path: edgeSegment(rr, i as 0 | 1 | 2 | 3, b.corners), color: e.color,
      width: e.thickness, ...(ds.dash ? { dash: ds.dash } : {}), cap: ds.cap ?? 'square', join: 'miter' });
  });
}
```

(For the separate-edge case, a negative `rr.w`/`rr.h` from a thick `right`-hand edge clamps the edge segment's span to zero rather than going negative: `edgeSegment` must clamp each coordinate into the rectangle so the finiteness test holds.)

- `geometryOps(box, g, out, skip)` for line/rectangle/arc as specified.
- `chromeOps(nodes, faces?)`: for each entry — refused with chrome (or `kind === 'draw'`) → skip; placed and `invisible` → nothing; otherwise `border` then `geometry` then (Task 7) text. `name` is `node.field ?? node.label`. Collect border `notes` into `warnings` prefixed with the name: `${name}: ${note}`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/xfachrome-border.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/xfachrome.ts test/xfachrome-border.test.ts
git commit -m "feat(164g.4): XFA borders, fills and draw geometry as paint operations"
```

---

### Task 7: Text operations — draws and captions (`xfachrome.ts`)

**Files:**
- Modify: `src/xfachrome.ts`
- Test: `test/xfachrome-text.test.ts`

**Interfaces:**
- Consumes: `layoutLeaf` (Task 5), `fieldRegions` (Task 5), `NodeChrome.caption`/`captionPresence`/`fieldCaption`/`fieldMargin` (Task 3), `LayoutNode.text` (existing).
- Produces: `ChromeOp` `text` entries; `chromeOps(nodes, faces)` now uses `faces`.

Rules:
- **A draw's text** (`node.kind === 'draw'` with `node.text?.kind === 'text'` and `paras` holding at least one run): laid out with `layoutLeaf(node.text, { width: box.w + 1e-6 }, faces)` (the `1e-6` keeps a width-growable leaf, measured at its own width, from re-wrapping on a ulp). Its text block is the box less `text.insets`; the caption reserve does not apply (draws carry none).
- **A field's caption**: when `chrome.caption` is present and `captionPresence !== 'invisible'`, the caption region from `fieldRegions(box, chrome.fieldCaption, chrome.fieldMargin)`; no region → nothing painted, no report (the widget still has its edit region). Laid out at the region width; its block is the region less the caption's own `insets`.
- **A field's VALUE is never painted.** Only `chrome.caption` is read for a field.
- **Vertical alignment** (p. 800): `offset = top + (avail - textH) * { top: 0, middle: 0.5, bottom: 1 }`, where `avail` is the block height and `textH` is `layoutLeaf(...).h` less the insets. A negative slack (text taller than the box) aligns top.
- **Horizontal alignment** per line (p. 800): `left` → `x = block.x + line.left`; `center` → `+ (line.room - line.width) / 2`; `right` → `+ line.room - line.width`; `justify` (all lines but the last of a paragraph) and `justifyAll` (every line): the line is split into words at U+0020 and the slack `line.room - line.width` is shared equally between the gaps, each word emitted as its own `text` op. A line with one word, or a negative slack, is left-aligned.
- **One `text` op per segment** (or per word when justified), at `x` = the running sum of segment widths, `y` = block top + `offset` + `line.baseline`. `style` is the run's `RunStyle` (`family`, `size`, `bold`, `italic`); `color` is the run's colour or black; `underline`/`lineThrough` from the run. A segment's text has its trailing spaces kept (they are part of the measured width).
- A leaf that `layoutLeaf` refuses here is reported: `${reason}, so its text is not painted` (layout already measured it, so this only fires for a stated-size leaf whose text cannot be measured — e.g. a face nothing resolves, Review Focus 1).
- `LeafText.notes` go to `warnings` as `${name}: ${note}`.
- Paint order within a node: fill, border, geometry, text (p. 38).

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfachrome-text.test.ts
import { describe, it, expect } from 'vitest';
import { chromeOps, type ChromeOp } from '../src/xfachrome.js';
import type { LayoutNode, PlacedNode } from '../src/xfaflow.js';
import type { FaceLookup } from '../src/xfatext.js';
import type { LeafText, ParaSpec } from '../src/xfarich.js';

const faces: FaceLookup = (s) => (s.family[0] === 'Missing' ? { reason: 'no face named "Missing"' }
  : { unitsPerEm: 1000, ascent: 800, descent: 200, advance: () => 500 });
const base = { family: ['X'], size: 10, bold: false, italic: false };
const para = (text: string, extra: Partial<ParaSpec> = {}): ParaSpec => ({
  runs: [{ ...base, text }], base, marginLeft: 0, marginRight: 0, textIndent: 0,
  lineHeight: 0, spaceAbove: 0, spaceBelow: 0, ...extra,
});
const text = (paras: ParaSpec[], extra: Partial<LeafText> = {}): LeafText =>
  ({ kind: 'text', paras, insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false, ...extra });
const draw = (t: LeafText): LayoutNode => ({ kind: 'draw', label: 'D', geom: {}, children: [], text: t });
const at = (n: LayoutNode, box = { x: 0, y: 0, w: 100, h: 40 }): PlacedNode => ({ node: n, box, invisible: false });
const texts = (o: ChromeOp[]) => o.filter((x): x is Extract<ChromeOp, { kind: 'text' }> => x.kind === 'text');

describe('chromeOps: a draw\'s text (164g.4)', () => {
  it('writes each line at its baseline, from the box top-left plus insets', () => {
    const o = texts(chromeOps([at(draw(text([para('ab')], { insets: { l: 2, r: 0, t: 3, b: 0 } })))], faces).ops);
    expect(o).toEqual([{ kind: 'text', x: 2, y: 11, text: 'ab', style: base, color: [0, 0, 0], underline: false, lineThrough: false }]);
  });

  it('centres and right-aligns per line within the room (p. 800)', () => {
    const c = texts(chromeOps([at(draw(text([para('ab', { hAlign: 'center' })])))], faces).ops)[0];
    expect(c.x).toBe(45);
    const r = texts(chromeOps([at(draw(text([para('ab', { hAlign: 'right' })])))], faces).ops)[0];
    expect(r.x).toBe(90);
  });

  it('aligns the block vertically by vAlign', () => {
    const m = texts(chromeOps([at(draw(text([para('ab')], { vAlign: 'middle' })))], faces).ops)[0];
    expect(m.y).toBe(15 + 8);
    const b = texts(chromeOps([at(draw(text([para('ab')], { vAlign: 'bottom' })))], faces).ops)[0];
    expect(b.y).toBe(30 + 8);
  });

  it('justifies by spreading words, leaving the last line of a paragraph ragged', () => {
    const o = texts(chromeOps([at(draw(text([para('aa bb cc dd', { hAlign: 'justify' })])), { x: 0, y: 0, w: 32, h: 40 })], faces).ops);
    // Line 1 "aa bb " -> words at 0 and 32-10=22; line 2 "cc dd" is last: left.
    expect(o.filter((t) => t.y === 8).map((t) => [t.text.trim(), t.x])).toEqual([['aa', 0], ['bb', 22]]);
    expect(o.filter((t) => t.y === 18).map((t) => t.x)).toEqual([0]);
  });

  it('carries run colour and decoration', () => {
    const p = para('ab');
    p.runs[0] = { ...p.runs[0], color: [1, 0, 0], underline: true };
    expect(texts(chromeOps([at(draw(text([p])))], faces).ops)[0]).toMatchObject({ color: [1, 0, 0], underline: true, lineThrough: false });
  });

  // Review Focus 1: a face nothing resolves.
  it('reports text in a face nothing resolves, and paints none of it', () => {
    const t = text([{ ...para('ab'), runs: [{ ...base, family: ['Missing'], text: 'ab' }], base: { ...base, family: ['Missing'] } }]);
    const r = chromeOps([at(draw(t))], faces);
    expect(texts(r.ops)).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'D', reason: 'no face named "Missing", so its text is not painted' }]);
  });

  it('passes a leaf\'s notes to warnings', () => {
    const r = chromeOps([at(draw(text([para('ab')], { notes: ['font color value="x" could not be read, so black is used'] })))], faces);
    expect(r.warnings).toEqual(['D: font color value="x" could not be read, so black is used']);
  });
});

describe('chromeOps: a field\'s caption', () => {
  const field = (extra: Partial<NonNullable<LayoutNode['chrome']>> = {}): LayoutNode => ({
    kind: 'field', label: 'f[0]', field: 'form1[0].f[0]', geom: {}, children: [],
    text: text([para('THE VALUE')]),
    chrome: { caption: text([para('Cap')]), fieldCaption: { reserve: '40pt', placement: 'left' }, ...extra },
  });

  it('writes the caption in the caption region, never the field value', () => {
    const o = texts(chromeOps([at(field(), { x: 10, y: 20, w: 200, h: 20 })], faces).ops);
    expect(o.map((t) => [t.text, t.x, t.y])).toEqual([['Cap', 10, 28]]);
  });

  it('insets the caption region by the field margin', () => {
    const o = texts(chromeOps([at(field({ fieldMargin: { leftInset: '3pt', topInset: '2pt' } }), { x: 10, y: 20, w: 200, h: 20 })], faces).ops);
    expect([o[0].x, o[0].y]).toEqual([13, 30]);
  });

  // Review Focus 4: an invisible caption keeps its reserve and paints nothing.
  it('paints nothing for a caption with presence="invisible"', () => {
    expect(texts(chromeOps([at(field({ captionPresence: 'invisible' }))], faces).ops)).toEqual([]);
  });

  it('paints no caption without a caption region (no reserve)', () => {
    expect(texts(chromeOps([at(field({ fieldCaption: { placement: 'left' } }))], faces).ops)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfachrome-text.test.ts`
Expected: FAIL — no `text` ops emitted.

- [ ] **Step 3: Implement text placement in `src/xfachrome.ts`**

Add imports `import { layoutLeaf } from './xfatext.js';` and `import { fieldRegions } from './xfageom.js';` and the function:

```ts
/** A leaf's text laid into `block` (XFA 3.3 p. 56-61 for lines, p. 800 for
 *  alignment), by the SAME `layoutRuns` call that measured it. */
function textOps(
  block: XfaBox, t: LeafText, faces: FaceLookup, out: ChromeOp[], skip: (r: string) => void,
): void {
  if (t.kind !== 'text' || !t.paras.some((p) => p.runs.some((r) => r.text.trim() !== ''))) return;
  const l = layoutLeaf(t, { width: block.w + 1e-6 }, faces);
  if ('reason' in l) { skip(`${l.reason}, so its text is not painted`); return; }
  const { l: il, r: ir, t: it, b: ib } = l.text.insets;
  const avail = block.h - it - ib;
  const textH = l.h - it - ib;
  const slack = avail - textH;
  const k = t.vAlign === 'middle' ? 0.5 : t.vAlign === 'bottom' ? 1 : 0;
  const top = block.y + it + (slack > 0 ? slack * k : 0);
  const left = block.x + il;
  void ir;
  for (const line of l.lines) {
    const p = l.text.paras[line.para];
    const y = top + line.baseline;
    const free = line.room - line.width;
    const just = (p.hAlign === 'justify' && !line.last) || p.hAlign === 'justifyAll';
    if (just) {
      const words = wordsOf(line, p);
      if (words.length > 1 && free > 0) {
        const gap = free / (words.length - 1);
        words.forEach((w, i) => out.push(textOp(left + line.left + w.x + gap * i, y, w.text, p.runs[w.run])));
        continue;
      }
    }
    const shift = free <= 0 ? 0 : p.hAlign === 'center' ? free / 2 : p.hAlign === 'right' ? free : 0;
    let x = left + line.left + shift;
    for (const s of line.segments) {
      if (s.text !== '') out.push(textOp(x, y, s.text, p.runs[s.run]));
      x += s.width;
    }
  }
}
```

with `textOp(x, y, text, run)` building `{ kind: 'text', x, y, text, style: { family: run.family, size: run.size, bold: run.bold, italic: run.italic }, color: run.color ?? [0,0,0], underline: !!run.underline, lineThrough: !!run.lineThrough }`, and `wordsOf(line, p)` splitting each segment at U+0020 into `{ run, text, x }` entries, `x` measured with the segment's width share — compute it as `s.width * (charsBefore / s.text.length)` ONLY IF the face is monospaced; otherwise measure each word through `faces(run, word)`: `advance` sums divided by `unitsPerEm` times `run.size`. Use the face measure (correct for any face): pass `faces` into `wordsOf`.

In `chromeOps`, after border and geometry for a placed node:

```ts
      if (n.kind === 'draw' && n.text) textOps(box, n.text, faces, ops, skip);
      if (n.kind === 'field' && n.chrome?.caption && n.chrome.captionPresence !== 'invisible') {
        const reg = fieldRegions(box, n.chrome.fieldCaption, n.chrome.fieldMargin);
        if (!('reason' in reg) && reg.caption) textOps(reg.caption, n.chrome.caption, faces, ops, skip);
      }
```

Text is skipped entirely when `faces` is undefined (border-only callers in Task 6 tests). Collect `t.notes` into `warnings` as `${name}: ${note}` for every leaf whose text is laid out.

- [ ] **Step 4: Run both chrome test files**

Run: `npx vitest run test/xfachrome-text.test.ts test/xfachrome-border.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/xfachrome.ts test/xfachrome-text.test.ts
git commit -m "feat(164g.4): XFA draw text and field captions as paint operations, aligned per p. 800"
```

---

### Task 8: Painting and converter wiring (`xfafont.ts`, `xfapaint.ts`, `xfaconvert.ts`)

**Files:**
- Modify: `src/xfafont.ts` (add `facePicker`; `faceLookup` wraps it)
- Create: `src/xfapaint.ts`
- Modify: `src/xfaconvert.ts` (`XfaSkipped.what`, `XfaConvertReport.chromePages`, `XfaPlan.chrome`, `buildXfaPlan`, `planMasterFields`, `convertXfaToAcroForm`)
- Test: `test/xfapaint.test.ts`, `test/xfaconvert-chrome.test.ts`

**Interfaces:**
- Consumes: `chromeOps`, `ChromeOp` (Tasks 6-7); `LaidOutPage.nodes`, `layoutPage(..., nodes)` (Task 4); `registerFontIn`, `driverFor`, `AuthoringFont` (`src/stamp.js`); `ensureOwnResources`, `ensureOwnSubdict`, `registerXObjectRef`, `appendContent`, `num`, `streamOf` (`src/pagecontent.js`); `resolveDecor`, `decorRects`, `vmetricsFor` (`src/textdecor.js`).
- Produces:

```ts
// xfafont.ts
export type FaceSource = { std14: StdFont } | { sfnt: SfntFont };
export type FacePicker = (style: RunStyle, text: string) => { metrics: FaceMetrics; source: FaceSource } | { reason: string };
export function facePicker(doc: Document): FacePicker;

// xfapaint.ts
export class ChromeFonts { constructor(doc: Document, pick: FacePicker); fontFor(style: RunStyle, text: string): AuthoringFont | { reason: string } }
export function chromeContent(doc: Document, fonts: PdfDict, ops: readonly ChromeOp[], pageHeight: number, cache: ChromeFonts, skip: (r: string) => void): Uint8Array;
export interface XfaChromePlan { pages: Array<{ pageArea: number; ops: ChromeOp[] }>; masters: Map<number, { ops: ChromeOp[]; w: number; h: number }> }
export function paintChrome(doc: Document, chrome: XfaChromePlan, skip: (reason: string) => void): number;

// xfaconvert.ts
// XfaSkipped.what gains 'chrome'; XfaConvertReport gains chromePages: number; XfaPlan gains chrome?: XfaChromePlan
```

Rules:
- **Fonts.** `facePicker` is `faceLookup`'s three tiers with the source kept: an embedded face → `{ sfnt }` (the `SfntFont` it already parsed), a registered face → `{ sfnt }` (`doc.registeredFaceSfnt(rec)`), a substitute → `{ std14: name }` — drawn with the Standard-14 face, whose advances equal the Liberation metrics that measured it. `faceLookup(doc)` becomes `(s, t) => { const r = picker(s, t); return 'reason' in r ? r : r.metrics; }` so measurement is unchanged. `ChromeFonts.fontFor` memoizes `AddFont(source.sfnt.raw)` per `SfntFont` identity; an `AddFont` throw is caught (`rethrowLimit` first) and returns `{ reason: \`the face could not be embedded (${message})\` }`.
- **Content.** `chromeContent` emits, per op, in order: fill `q r g b rg <path> f Q`; stroke `q r g b RG w J j [dash] 0 d <path> S Q`; text `BT /Fk size Tf r g b rg x y Td <hex> Tj ET` then the decoration rects from `decorRects`. Every y is flipped: `pdfY = pageHeight - y`. `J`: butt 0, round 1, square 2; `j`: miter 0, round 1. Hex is the font driver's encoded bytes. A text op whose font returns a reason is skipped with that reason. Numbers through `num()`.
- **Pages.** `paintChrome`: for each master page area with ops, ONE Form XObject (`/Type /XObject /Subtype /Form /BBox [0 0 w h]`, its own `/Resources /Font`), allocated once; for each page `i` in order: a body content stream `q /Xk Do Q` (when its page area has master ops) followed by the page's body ops, through `appendContent`. Returns the number of pages that received any chrome.
- **Plan.** In `buildXfaPlan`, only when `newPages` is set and `!noGeometry`: run `chromeOps(laid.pages[i].nodes, faceLookup(doc))` per page and `chromeOps(masterNodes, ...)` per page area used, building `plan.chrome`; its `skipped` → `report.skipped` as `{ what: 'chrome', name, reason }`, its `warnings` → `report.warnings`. Master page areas are laid out once, shared with `planMasterFields` — move the `laidOut`/`placedIn` cache out of `planMasterFields` into a `layoutMasters(pageSet, measure, warnings)` helper returning `Map<number, { placed: Map<string, Placed>; nodes: PlacedNode[] }>`, and pass it to `planMasterFields`.
- **Apply.** In `convertXfaToAcroForm`, ONLY inside the `replaced` branch, after the pages are created and before the fields are created: `plan.report.chromePages = paintChrome(doc, plan.chrome, plan.report)` when `plan.chrome` exists. When the placeholder pages are kept (`newPages && !replaced`), nothing is painted (Review Focus 2).
- `chromePages` defaults to 0 in the report literal.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfapaint.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { chromeContent, ChromeFonts, paintChrome } from '../src/xfapaint.js';
import { facePicker } from '../src/xfafont.js';
import type { ChromeOp } from '../src/xfachrome.js';

const doc0 = () => { const d = Document.New(); d.AddPage(PageFormat.custom(200, 100)); return d; };
const ascii = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('chromeContent: XFA frame to PDF operators (164g.4)', () => {
  it('flips y and fills', () => {
    const d = doc0();
    const s = ascii(chromeContent(d, new Map(), [{ kind: 'fill', color: [1, 0, 0], path: [['M', 10, 20], ['L', 30, 20], ['L', 30, 40], ['Z']] }],
      100, new ChromeFonts(d, facePicker(d)), () => {}));
    expect(s).toBe('q 1 0 0 rg 10 80 m 30 80 l 30 60 l h f Q\n');
  });

  it('strokes with width, caps, joins and dashes', () => {
    const d = doc0();
    const op: ChromeOp = { kind: 'stroke', color: [0, 0, 0], width: 2, cap: 'round', join: 'miter', dash: [0, 4], path: [['M', 0, 0], ['L', 10, 0]] };
    expect(ascii(chromeContent(d, new Map(), [op], 100, new ChromeFonts(d, facePicker(d)), () => {})))
      .toBe('q 0 0 0 RG 2 w 1 J 0 j [0 4] 0 d 0 100 m 10 100 l S Q\n');
  });

  it('writes text in the Standard-14 face that stands for Arial', () => {
    const d = doc0();
    const fonts = new Map();
    const s = ascii(chromeContent(d, fonts, [{ kind: 'text', x: 5, y: 30, text: 'Hi', color: [0, 0, 0], underline: false, lineThrough: false,
      style: { family: ['Arial'], size: 9, bold: false, italic: false } }], 100, new ChromeFonts(d, facePicker(d)), () => {}));
    expect(s).toMatch(/^BT \/F\d+ 9 Tf 0 0 0 rg 5 70 Td <4869> Tj ET\n$/);
    const key = s.match(/\/(F\d+)/)![1];
    expect((d.resolve((fonts as Map<string, never>).get(key)) as Map<string, { name: string }>).get('BaseFont')).toEqual({ kind: 'name', name: 'Helvetica' });
  });

  it('skips text whose face cannot be resolved, saying why', () => {
    const d = doc0();
    const why: string[] = [];
    const s = chromeContent(d, new Map(), [{ kind: 'text', x: 0, y: 0, text: 'x', color: [0, 0, 0], underline: false, lineThrough: false,
      style: { family: ['NoSuchFace'], size: 9, bold: false, italic: false } }], 100, new ChromeFonts(d, facePicker(d)), (r) => why.push(r));
    expect(s.length).toBe(0);
    expect(why[0]).toMatch(/NoSuchFace/);
  });

  it('draws an underline under underlined text', () => {
    const d = doc0();
    const s = ascii(chromeContent(d, new Map(), [{ kind: 'text', x: 5, y: 30, text: 'Hi', color: [0, 0, 0], underline: true, lineThrough: false,
      style: { family: ['Arial'], size: 9, bold: false, italic: false } }], 100, new ChromeFonts(d, facePicker(d)), () => {}));
    expect(s).toMatch(/ re f/);
  });
});

describe('paintChrome', () => {
  it('places each page area\'s master chrome once as a shared Form XObject, sized to that area', () => {
    const d = Document.New();
    d.AddPage(PageFormat.custom(200, 100));
    d.AddPage(PageFormat.custom(200, 100));
    d.AddPage(PageFormat.custom(300, 400));
    const fill = (y: number): ChromeOp => ({ kind: 'fill', color: [0, 0, 0], path: [['M', 0, y], ['L', 1, y], ['L', 1, y + 1], ['Z']] });
    const n = paintChrome(d, {
      pages: [{ pageArea: 0, ops: [] }, { pageArea: 0, ops: [fill(5)] }, { pageArea: 1, ops: [] }],
      masters: new Map([[0, { ops: [fill(0)], w: 200, h: 100 }], [1, { ops: [fill(0)], w: 300, h: 400 }]]),
    }, () => {});
    expect(n).toBe(3);
    const xobjs = d.Pages.map((p) => [...((p.Resources.get('XObject') as Map<string, unknown>) ?? new Map()).values()]);
    expect(xobjs[0][0]).toEqual(xobjs[1][0]);
    expect(xobjs[0][0]).not.toEqual(xobjs[2][0]);
    // Review Focus 3: the area-1 XObject is flipped against ITS page height.
    const form = d.resolve(xobjs[2][0] as never) as { dict: Map<string, unknown>; raw: Uint8Array };
    expect(form.dict.get('BBox')).toEqual([0, 0, 300, 400]);
    expect(ascii(form.raw)).toContain('0 400 m');
  });

  it('paints nothing and counts 0 when there are no operations', () => {
    const d = doc0();
    expect(paintChrome(d, { pages: [{ pageArea: 0, ops: [] }], masters: new Map() }, () => {})).toBe(0);
  });
});
```

(If `Form XObject` streams are stored deflated by `streamOf`, decode with `decodeStream` from `src/filters.js` before the `toContain` check; check `pagecontent.ts`'s `streamOf` first and assert against whichever it writes.)

```ts
// test/xfaconvert-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const TPL = (body: string, master = '') => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea x="0" y="0" w="8.5in" h="11in"/>${master}</pageArea></pageSet>
  <subform name="Page1" layout="position" w="8.5in" h="11in">${body}</subform></subform></template>`;
const FIELD = '<field name="f" x="1in" y="1in" w="3in" h="20pt"><font typeface="Arial"/><ui><textEdit/></ui><caption reserve="1in"><value><text>Name</text></value></caption></field>';
const DRAW = '<draw x="1in" y="3in" w="3in" h="14pt"><font typeface="Arial" size="10pt"/><value><text>Hello chrome</text></value><border><edge/></border></draw>';
const dynamic = (template: string) => Document.Open(buildXfaPdf({ template, pages: 1, needsRendering: true }));
const reopen = (d: Document) => Document.Open(d.Save());

describe('ConvertXfaToAcroForm paints chrome on the pages it creates (164g.4)', () => {
  it('draws the draw text and the field caption on the created page', () => {
    const doc = dynamic(TPL(FIELD + DRAW));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.pagesCreated).toBe(1);
    expect(r.chromePages).toBe(1);
    const text = reopen(doc).Pages[0].GetText();
    expect(text).toContain('Hello chrome');
    expect(text).toContain('Name');
  });

  it('never paints a field value as page content', () => {
    const doc = Document.Open(buildXfaPdf({
      template: TPL(FIELD), pages: 1, needsRendering: true,
      datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Page1><f>SECRET</f></Page1></form1></xfa:data></xfa:datasets>',
    }));
    doc.ConvertXfaToAcroForm();
    const d2 = reopen(doc);
    const frags = d2.Pages[0].GetTextFragments({ includeAnnotations: false } as never).map((f) => f.text).join(' ');
    expect(frags).not.toContain('SECRET');
  });

  it('paints master-page chrome on every page of that area', () => {
    const master = '<draw x="0.5in" y="0.2in" w="2in" h="12pt"><font typeface="Arial"/><value><text>CUI MARK</text></value></draw>';
    const two = `<template><subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea x="0" y="0" w="8.5in" h="11in"/>${master}</pageArea></pageSet>
      <subform name="A" layout="position" w="8.5in" h="11in">${FIELD}</subform>
      <subform name="B" layout="position" w="8.5in" h="11in"><breakBefore targetType="pageArea"/>${DRAW}</subform></subform></template>`;
    const doc = dynamic(two);
    const r = doc.ConvertXfaToAcroForm();
    expect(r.pagesCreated).toBe(2);
    const d2 = reopen(doc);
    expect(d2.Pages.map((p) => p.GetText().includes('CUI MARK'))).toEqual([true, true]);
  });

  // Review Focus 2: placeholder pages kept, so no chrome on them.
  it('paints nothing when the placeholder pages are kept', () => {
    const doc = dynamic(TPL('<field name="s" x="1in" y="1in" w="1in" h="1in"><ui><signature/></ui></field>' + DRAW));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.pagesCreated).toBe(0);
    expect(r.chromePages).toBe(0);
    expect(reopen(doc).Pages[0].GetText()).not.toContain('Hello chrome');
  });

  // Review Focus 1: a face nothing resolves -- refused at layout, reported, no throw.
  it('reports a draw in a face nothing resolves and paints the rest', () => {
    const missing = '<draw x="1in" y="5in" w="3in"><font typeface="NoSuchFace"/><value><text>gone</text></value></draw>';
    const doc = dynamic(TPL(FIELD + DRAW + missing));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.skipped.filter((s) => s.what === 'chrome').map((s) => s.reason).join('\n')).toMatch(/NoSuchFace/);
    expect(reopen(doc).Pages[0].GetText()).toContain('Hello chrome');
  });

  it('paints nothing on a hybrid, which reports chromePages 0', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL(FIELD + DRAW), pages: 1, acroFieldObjects: ['{HYBRID}'] }));
    expect(doc.ConvertXfaToAcroForm().chromePages).toBe(0);
  });
});
```

(Check `GetTextFragments`'s options name for excluding annotation appearances in `src/page.ts`; if fragments never include widget appearances, drop the option. The assertion that matters is that `SECRET` is not in PAGE content.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfapaint.test.ts test/xfaconvert-chrome.test.ts`
Expected: FAIL — `xfapaint.js` missing; `chromePages` undefined.

- [ ] **Step 3: Implement `facePicker`**

In `src/xfafont.ts`, rename the closure body of `faceLookup` into `facePicker(doc): FacePicker`, keeping the `SfntFont` in each tier: change `Face` to `{ names?: FontNames; metrics: FaceMetrics; sfnt: SfntFont }` (set in `face(s)`), have `accept` return the `Face`, and return `{ metrics: f.metrics, source: { sfnt: f.sfnt } }` for embedded and registered faces and `{ metrics: f.metrics, source: { std14: sub[...] } }` for the substitute. Then:

```ts
export function faceLookup(doc: Document): FaceLookup {
  const pick = facePicker(doc);
  return (style, text) => { const r = pick(style, text); return 'reason' in r ? r : r.metrics; };
}
```

Run `npx vitest run test/xfafont.test.ts` — must pass unedited.

- [ ] **Step 4: Implement `src/xfapaint.ts`**

```ts
// src/xfapaint.ts
/**
 * XFA chrome operations written as page content (164g.4). The only chrome
 * module holding a `Document`: `xfachrome.ts` decides what to paint, this
 * decides how a PDF says it.
 *
 * **Invariant:** text is drawn in the face that MEASURED it -- a Standard-14
 * face for the Arial/Times New Roman/Courier New substitutes (equal advances to
 * the Liberation metrics), otherwise the measured program embedded through
 * `AddFont` -- so ink and layout box cannot disagree.
 *
 * **Invariant:** each page area's master chrome is ONE Form XObject, built for
 * that area's own page height and placed on every page using it.
 */
import type { Document } from './document.js';
import { name, ref, type PdfDict, type PdfObject } from './types.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict, num, registerXObjectRef, streamOf } from './pagecontent.js';
import { driverFor, registerFontIn, type AuthoringFont } from './stamp.js';
import { decorRects, resolveDecor, vmetricsFor } from './textdecor.js';
import { rethrowLimit } from './errors.js';
import type { ChromeOp, PathCmd } from './xfachrome.js';
import type { FacePicker } from './xfafont.js';
import type { RunStyle } from './xfarich.js';
import type { SfntFont } from './sfnt.js';
```

Implement `ChromeFonts`, `chromeContent`, `XfaChromePlan` and `paintChrome` per the rules above. Path emission:

```ts
function pathOps(path: readonly PathCmd[], h: number): string {
  return path.map((c) => {
    switch (c[0]) {
      case 'M': return `${num(c[1])} ${num(h - c[2])} m`;
      case 'L': return `${num(c[1])} ${num(h - c[2])} l`;
      case 'C': return `${num(c[1])} ${num(h - c[2])} ${num(c[3])} ${num(h - c[4])} ${num(c[5])} ${num(h - c[6])} c`;
      default: return 'h';
    }
  }).join(' ');
}
```

Text: `const font = cache.fontFor(op.style, op.text)`; `const key = registerFontIn(doc, fonts, font)`; `const bytes = driverFor(font).encode(op.text)`; hex = `[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')`. Decoration: `resolveDecor({ ...(op.underline ? { underline: true } : {}), ...(op.lineThrough ? { strikethrough: true } : {}) }, op.color, op.style.size, vmetricsFor(font))`; when defined, `decorRects([{ x: op.x, baseline: h - op.y, width: driverFor(font).measure(op.text, op.style.size) }], d)` and append both strings.

`paintChrome`: allocate the master XObjects with `doc.allocObject(streamOf(bytes))` after setting the stream dict's `/Type /XObject /Subtype /Form /BBox [0 0 w h] /Resources << /Font fonts >>` (follow `streamOf`'s return shape — a `PdfStream` with a `dict` you can set keys on). For each page: `const k = registerXObjectRef(doc, page, xref)` then `appendContent(doc, page, enc(\`q /${k} Do Q\n\`))` and the body bytes via `appendContent(doc, page, chromeContent(doc, ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'Font'), ops, page height, cache, skip))`. `skip` is the caller's: the converter passes `(reason) => plan.report.skipped.push({ what: 'chrome', reason })`. Page height is `page.MediaBox[3] - page.MediaBox[1]` (created pages have a `[0 0 w h]` box).

- [ ] **Step 5: Wire the converter**

In `src/xfaconvert.ts`:

1. `XfaSkipped.what`: `'document' | 'packet' | 'page' | 'field' | 'chrome'`; doc comment: "`chrome`: a draw, border, fill or caption on a created page that was not painted, or was painted approximately."
2. `XfaConvertReport.chromePages: number` with doc comment "Pages chrome (draws, borders, captions) was painted on. 0 for a hybrid, whose pages carry Designer's rendering, and when the placeholder pages are kept."; set `chromePages: 0` in the report literal.
3. `XfaPlan.chrome?: XfaChromePlan` (import the type from `./xfapaint.js`).
4. Add `layoutMasters` and use it from `planMasterFields` (replacing its private `laidOut`/`placedIn`):

```ts
/** Each page area's background laid out ONCE (d3mq), with its placed nodes
 *  for chrome (164g.4). */
function layoutMasters(
  pageSet: XfaPageSet | undefined, measure: XfaMeasure, warnings: string[],
): (k: number) => { placed: Map<string, Placed>; nodes: PlacedNode[] } {
  const cache = new Map<number, { placed: Map<string, Placed>; nodes: PlacedNode[] }>();
  return (k) => {
    let m = cache.get(k);
    if (m === undefined) {
      const root = pageSet?.pageAreas[k]?.master;
      const nodes: PlacedNode[] = [];
      m = { placed: root ? layoutPage(root, measure, warnings, nodes) : new Map<string, Placed>(), nodes };
      cache.set(k, m);
    }
    return m;
  };
}
```

`planMasterFields` takes the getter as a parameter and calls `masters(m.pageArea).placed` where it used `placedIn(m.pageArea)`.

5. In `buildXfaPlan` after step 5b, plan the chrome:

```ts
  // 5c. Chrome (164g.4): only for the pages a DYNAMIC document will get. A
  //     hybrid's pages already carry Designer's rendering of it.
  let chrome: XfaChromePlan | undefined;
  if (newPages && !noGeometry) {
    const faces = faceLookup(doc);
    const add = (r: ChromeResult): void => {
      for (const s of r.skipped) report.skipped.push({ what: 'chrome', name: s.name, reason: s.reason });
      report.warnings.push(...r.warnings);
    };
    const masterOps = new Map<number, { ops: ChromeOp[]; w: number; h: number }>();
    const pages = laid.pages.map((pg, i) => {
      if (!masterOps.has(pg.pageArea)) {
        const r = chromeOps(masters(pg.pageArea).nodes, faces);
        add(r);
        masterOps.set(pg.pageArea, { ops: r.ops, w: newPages![i].w, h: newPages![i].h });
      }
      const r = chromeOps(pg.nodes, faces);
      add(r);
      return { pageArea: pg.pageArea, ops: r.ops };
    });
    chrome = { pages, masters: masterOps };
  }
```

and return `...(chrome ? { chrome } : {})` from `buildXfaPlan`. (`masters` is the `layoutMasters(...)` getter created once before step 5b.) Imports: `chromeOps`, `type ChromeOp`, `type ChromeResult` from `./xfachrome.js`; `type PlacedNode` from `./xfaflow.js`; `paintChrome`, `type XfaChromePlan` from `./xfapaint.js`.

6. In `convertXfaToAcroForm`, inside `if (plan.newPages && (...)) { replaced = true; ... }`, after the `RemovePage` loop:

```ts
    if (plan.chrome)
      plan.report.chromePages = paintChrome(doc, plan.chrome, (reason) => plan.report.skipped.push({ what: 'chrome', reason }));
```

- [ ] **Step 6: Run the new tests and every XFA converter test**

Run: `npx vitest run test/xfapaint.test.ts test/xfaconvert-chrome.test.ts test/xfafont.test.ts test/xfaconvert.test.ts test/xfaconvert-pages.test.ts test/xfaconvert-master.test.ts test/xfaconvert-measure.test.ts test/xfaconvert-occur.test.ts test/xfaconvert-choice-data.test.ts test/xfa-real.test.ts test/xfa-dynamic-oracle.test.ts test/xfa-master-oracle.test.ts test/xfa-public-api.test.ts`
Expected: PASS. A pre-existing test asserting `report` with `toEqual` will now see `chromePages`; update ONLY that key in such an assertion (it is a new report field, not a behaviour change), and list each edited assertion in the commit message.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/xfafont.ts src/xfapaint.ts src/xfaconvert.ts test/xfapaint.test.ts test/xfaconvert-chrome.test.ts
git commit -m "feat(164g.4): paint XFA chrome on a dynamic document's created pages"
```

---

### Task 9: Widget borders on created fields, anchored on Adobe

**Files:**
- Modify: `src/xfaconvert.ts` (`PlanEntry.style`, `baseEntry`, `applyPositioned`, `GroupPlan.style`, `applyGroup`)
- Test: `test/xfa-widget-border.test.ts`

**Interfaces:**
- Consumes: `widgetStyleOf` (Task 1), `XfaField.widgetBorder` (Task 3), `createField(doc, init: FieldInit, spec)` (`FieldInit extends FieldStyle`), `addRadioGroup(doc, init: RadioGroupInit)` (`RadioGroupInit extends WidgetStyle`).
- Produces: `PlanEntry.style?: WidgetStyle`; `GroupPlan.style?: WidgetStyle`.

Rules:
- `baseEntry` sets `style` from `widgetStyleOf(f.widgetBorder)` when defined; its `degraded` reason is reported once per field as `{ what: 'chrome', name: f.name, reason: degraded }` (pass `report` into `baseEntry`'s callers, or return the reason and push it at the call site — keep `baseEntry` pure: return `{ entry, degraded? }` is NOT used; instead compute `widgetStyleOf` at both call sites and push the report there).
- `applyPositioned` spreads `e.style` into the `createField` init.
- A radio group takes the first member's style; a later member whose style differs is reported `a radio group's members state different widget borders, so the first is used`.
- Reconciled entries never get a style (they are hybrids' existing widgets); `style` is ignored on the reconcile path.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xfa-widget-border.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { inflateStream } from '../src/flate.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { widgetStyleOf } from '../src/xfaborder.js';
import { isDict, type PdfDict } from '../src/types.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const fixture = (f: string) => Document.Open(new Uint8Array(readFileSync(`test/fixtures/xfa/${f}`)));
const tplOf = (doc: Document) => {
  const d = decodeXfaPackets(doc.resolve(doc.catalog().get('AcroForm')) as PdfDict, (o) => doc.resolve(o), (s) => inflateStream(s));
  if ('reason' in d) throw new Error(d.reason);
  return parseXfaTemplate(d.packets.get('template')!);
};
const r6 = (xs: number[]) => xs.map((x) => Math.round(x * 1e6) / 1e6);

describe('widget borders against what Adobe wrote (164g.4)', () => {
  // IRS f1040's three bordered text fields and DoD DD 1155's Reset button: the
  // only widgets in the corpus whose /AcroForm carries /MK /BC and /BS.
  const CASES: Array<[string, string]> = [
    ['irs-f1040.pdf', 'topmostSubform[0].Page2[0].f2_39[0]'],
    ['irs-f1040.pdf', 'topmostSubform[0].Page2[0].f2_41[0]'],
    ['irs-f1040.pdf', 'topmostSubform[0].Page2[0].f2_43[0]'],
    ['dod-dd1155.pdf', 'form1[0].#pageSet[0].Page1[0].ResetButton[0]'],
  ];
  for (const [file, name] of CASES) {
    it(`maps ${name} as Adobe did`, () => {
      const doc = fixture(file);
      const tpl = tplOf(doc);
      const f = [...tpl.fields, ...tpl.masterPageFields].find((x) => x.name === name)!;
      const ours = widgetStyleOf(f.widgetBorder!)!.style;
      const adobe = doc.Form.Get(name)!.Dict;
      const mk = doc.resolve(adobe.get('MK')) as PdfDict;
      const bs = doc.resolve(adobe.get('BS')) as PdfDict;
      // Adobe writes 0.199997 for 51/255 = 0.2: its own float rounding.
      expect(r6(ours.borderColor!).map((x) => Math.round(x * 1000) / 1000))
        .toEqual(r6(mk.get('BC') as number[]).map((x) => Math.round(x * 1000) / 1000));
      expect(ours.borderWidth).toBe(bs.get('W'));
      expect(ours.borderStyle).toBe('solid');
      expect((bs.get('S') as { name: string }).name).toBe('S');
      expect(ours.backgroundColor).toBeUndefined();
      expect(isDict(mk) && mk.has('BG')).toBe(false);
    });
  }
});

describe('ConvertXfaToAcroForm writes widget borders on fields it creates', () => {
  const TPL = (ui: string, fieldBorder = '') => `<template><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea w="8.5in" h="11in"/></pageArea></pageSet>
    <subform name="Page1" layout="position"><field name="f" x="1in" y="1in" w="2in" h="20pt">${ui}${fieldBorder}</field></subform></subform></template>`;
  const widget = (doc: Document) => doc.Form.Get('form1[0].Page1[0].f[0]')!.Dict;

  it('writes /BS /S /I for a lowered edit-region border', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><textEdit><border><edge stroke="lowered"/></border></textEdit></ui>') }));
    doc.ConvertXfaToAcroForm();
    const bs = doc.resolve(widget(doc).get('BS')) as PdfDict;
    expect((bs.get('S') as { name: string }).name).toBe('I');
  });

  it('writes /BS /S /B for a raised push-button border', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><button/></ui>', '<border><edge stroke="raised"/></border>') }));
    doc.ConvertXfaToAcroForm();
    const bs = doc.resolve(widget(doc).get('BS')) as PdfDict;
    expect((bs.get('S') as { name: string }).name).toBe('B');
  });

  it('writes nothing for a field whose template states no widget border', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><textEdit/></ui>') }));
    doc.ConvertXfaToAcroForm();
    expect(widget(doc).has('BS')).toBe(false);
  });

  it('reports an etched widget border, drawn solid', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><textEdit><border><edge stroke="etched"/></border></textEdit></ui>') }));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.skipped).toContainEqual({ what: 'chrome', name: 'form1[0].Page1[0].f[0]', reason: 'an etched widget border has no AcroForm counterpart and is drawn solid' });
  });
});
```

(`createField`'s push-button route may differ from `Tx`: if `applyPositioned` does not reach push buttons through `createField`, apply the style with `applyWidgetStyle(doc, widgetDict, checkWidgetStyle(style))` after creation. The test pins the result, not the route.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xfa-widget-border.test.ts`
Expected: the Adobe cases PASS already (they test Task 1's pure mapper — if one fails, fix `widgetStyleOf`, not the test); the converter cases FAIL (no `/BS`).

- [ ] **Step 3: Implement**

Add `style?: WidgetStyle` to `PlanEntry` and `GroupPlan` (import `type WidgetStyle` from `./fieldstyle.js`, `widgetStyleOf` from `./xfaborder.js`). At the body-field site in `buildXfaPlan` (after `const entry = baseEntry(...)`) and the master site in `planMasterFields`:

```ts
    const ws = f.widgetBorder ? widgetStyleOf(f.widgetBorder) : undefined;
    if (ws) {
      entry.style = ws.style;
      if (ws.degraded) report.skipped.push({ what: 'chrome', name: f.name, reason: ws.degraded });
    }
```

(For master instances, set it on the spread entry each instance gets; report the degradation once, under `f.name`.)

In `applyPositioned`: `createField(doc, { page: e.page!, rect: e.rect!, name: e.name, readOnly: ..., required: ..., ...(e.style ?? {}) }, specFor(e))`.

Groups: when building a `GroupPlan`, `style` = the first member entry's `style`; if any later member's style differs (`JSON.stringify` comparison), push the report entry. `applyGroup` spreads `g.style` into the `addRadioGroup` init.

- [ ] **Step 4: Run the widget tests and every converter test**

Run: `npx vitest run test/xfa-widget-border.test.ts test/xfaconvert.test.ts test/xfaconvert-master.test.ts test/xfaconvert-chrome.test.ts test/xfa-real.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/xfaconvert.ts test/xfa-widget-border.test.ts
git commit -m "feat(164g.4): XFA widget borders to /MK + /BS, lowered/raised as Inset/Beveled, checked against Adobe"
```

---

### Task 10: The pdf.js chrome oracle

**Files:**
- Modify: `scripts/gen-xfa-goldens.ts` (a chrome collector + `chrome-goldens.json`)
- Modify: `test/helpers/xfa-dynamic.ts` (`ChromeGoldens` type, `chromeGoldens()` loader)
- Create: `test/fixtures/xfa-dynamic/chrome-goldens.json` (GENERATED — never hand-edited)
- Modify: `test/fixtures/xfa-dynamic/PROVENANCE.md`
- Test: `test/xfa-chrome-oracle.test.ts`

**Interfaces:**
- Produces:

```ts
export interface GoldenBorder { page: number; x: number; y: number; w: number; h: number;
  widths: [number, number, number, number]; styles: [string, string, string, string]; colors: [string, string, string, string]; radius: string }
export interface GoldenText { page: number; kind: 'draw' | 'caption'; x: number; y: number; w: number; h: number; text: string }
export interface ChromeGoldens {
  meta: { pdfjsDist: string; pdfjsIntegrity: string; pdfjsGitHead: string; chrome: string };
  files: Record<string, { pages: number; sha256: string; borders: GoldenBorder[]; texts: GoldenText[] }>;
}
export const CHROME_FILES: readonly string[]; // ['opm1644.pdf', 'dod-dd2875.pdf', 'dod-dd1494.pdf']
export function chromeGoldens(): ChromeGoldens;
```

- [ ] **Step 1: Add the collector to the generator**

In `scripts/gen-xfa-goldens.ts` add a second in-page collector STRING (the same `keepNames` reason as `COLLECT`):

```ts
const COLLECT_CHROME = `(() => {
  const r2 = (n) => Math.round(n * 100) / 100;
  const borders = [];
  const texts = [];
  const norm = (s) => s.replace(/\\s+/g, ' ').trim();
  for (const pg of document.querySelectorAll('.page')) {
    const o = pg.getBoundingClientRect();
    const page = Number(pg.dataset.page);
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: r2(b.left - o.left), y: r2(b.top - o.top), w: r2(b.width), h: r2(b.height) }; };
    for (const el of pg.querySelectorAll('.xfaBorder')) {
      const cs = getComputedStyle(el);
      const sides = ['Top', 'Right', 'Bottom', 'Left'];
      borders.push({ page, ...box(el),
        widths: sides.map((s) => r2(parseFloat(cs['border' + s + 'Width']) || 0)),
        styles: sides.map((s) => cs['border' + s + 'Style']),
        colors: sides.map((s) => cs['border' + s + 'Color']),
        radius: cs.borderRadius });
    }
    for (const el of pg.querySelectorAll('.xfaDraw')) {
      const t = norm(el.textContent ?? '');
      if (t !== '') texts.push({ page, kind: 'draw', ...box(el), text: t });
    }
    for (const el of pg.querySelectorAll('.xfaCaption')) {
      const t = norm(el.textContent ?? '');
      if (t !== '') texts.push({ page, kind: 'caption', ...box(el), text: t });
    }
  }
  return { pages: window.__pages, borders, texts };
})()`;
```

Add `collectChrome()` mirroring `collect()` with `COLLECT_CHROME`, then, after the master pass:

```ts
const chromeFiles = {} as ChromeGoldens['files'];
for (const file of CHROME_FILES) {
  const bytes = file === DYNAMIC_FILE ? loadDynamicPdf() : loadMasterPdf(file as MasterFile);
  current = bytes;
  const { pages, borders, texts } = await collectChrome();
  chromeFiles[file] = { pages, sha256: createHash('sha256').update(bytes).digest('hex'), borders, texts };
  console.log(`${file}: ${String(borders.length)} borders, ${String(texts.length)} texts`);
}
```

and write `chrome-goldens.json` beside the others, with the same `meta`.

- [ ] **Step 2: Add the type and loader to `test/helpers/xfa-dynamic.ts`**

Add `GoldenBorder`, `GoldenText`, `ChromeGoldens`, `CHROME_FILES = ['opm1644.pdf', 'dod-dd2875.pdf', 'dod-dd1494.pdf'] as const`, and `chromeGoldens()` reading `test/fixtures/xfa-dynamic/chrome-goldens.json` exactly as `masterGoldens()` reads its file.

- [ ] **Step 3: Generate the goldens**

```bash
npm i --no-save puppeteer
npm run gen:xfa
git diff --stat test/fixtures/xfa-dynamic/
```

Expected: `chrome-goldens.json` created; `goldens.json` and `master-goldens.json` UNCHANGED (if they moved, pdf.js or Chrome changed underneath — stop and investigate before continuing). Record the printed border and text counts per file.

- [ ] **Step 4: Write the oracle test**

```ts
// test/xfa-chrome-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { CHROME_FILES, chromeGoldens, loadDynamicPdf, loadMasterPdf, type MasterFile } from './helpers/xfa-dynamic.js';

/**
 * The pdf.js oracle for chrome (164g.4): pdf.js 6.3.289's XFA engine rendered
 * into headless Chrome (`npm run gen:xfa`). Structural, not pixels -- pdf.js
 * shapes text with browser fonts, so only MEMBERSHIP (which glyphs fall in a
 * box) and box geometry are compared.
 *
 * Its ceiling: pdf.js is a reimplementation, not Adobe -- evidence, not
 * conformance.
 */
const g = chromeGoldens();
const load = (f: string) => Document.Open(f === 'opm1644.pdf' ? loadDynamicPdf() : loadMasterPdf(f as MasterFile));
const TOL = 1;  // points: one layout unit per row is 1/64 px; a page's worth stays well under 1pt.

function converted(f: string) {
  const doc = load(f);
  const report = doc.ConvertXfaToAcroForm();
  return { doc: Document.Open(doc.Save()), report };
}

for (const file of CHROME_FILES) {
  describe(`chrome oracle: ${file}`, () => {
    const gold = g.files[file];
    const { doc, report } = converted(file);

    it('produces pdf.js\'s page count', () => {
      expect(doc.Pages.length).toBe(gold.pages);
      expect(report.chromePages).toBe(gold.pages);
    });

    it('spells pdf.js\'s text inside each draw and caption box', () => {
      let matched = 0;
      const misses: string[] = [];
      for (const t of gold.texts) {
        const page = doc.Pages[t.page - 1];
        const h = page.MediaBox[3];
        const inside = page.GetTextFragments().filter((fr) => {
          const cx = (fr.quad[0] + fr.quad[2]) / 2;
          const cy = h - (fr.quad[1] + fr.quad[3]) / 2;
          return cx >= t.x - TOL && cx <= t.x + t.w + TOL && cy >= t.y - TOL && cy <= t.y + t.h + TOL;
        });
        const ours = inside.map((fr) => fr.text).join(' ').replace(/\s+/g, ' ').trim();
        if (ours === t.text) matched += 1; else misses.push(`p${String(t.page)} ${t.kind} "${t.text}" got "${ours}"`);
      }
      // Pinned exactly; raise only in the issue that changes it.
      expect({ matched, of: gold.texts.length }).toEqual({ matched: MATCHED_TEXT[file], of: gold.texts.length });
      void misses;
    });

    it('strokes a box where pdf.js draws each uniform solid border', () => {
      let matched = 0;
      const uniform = gold.borders.filter((b) => b.styles.every((s) => s === 'solid') && new Set(b.widths).size === 1 && b.widths[0] > 0);
      for (const b of uniform) {
        const page = doc.Pages[b.page - 1];
        const h = page.MediaBox[3];
        const hit = page.GetPaths().some((p) => {
          if (!p.stroke) return false;
          const lw = p.lineWidth / 2;
          const [x0, y0, x1, y1] = [p.bbox[0] - lw, h - p.bbox[3] - lw, p.bbox[2] + lw, h - p.bbox[1] + lw];
          return Math.abs(x0 - b.x) <= TOL && Math.abs(y0 - b.y) <= TOL
            && Math.abs(x1 - (b.x + b.w)) <= TOL && Math.abs(y1 - (b.y + b.h)) <= TOL
            && Math.abs(p.lineWidth - b.widths[0]) <= 0.01;
        });
        if (hit) matched += 1;
      }
      expect({ matched, of: uniform.length }).toEqual({ matched: MATCHED_BORDERS[file], of: uniform.length });
    });
  });
}

/** Filled in from the first green run (Step 5), then pinned. */
const MATCHED_TEXT: Record<string, number> = {};
const MATCHED_BORDERS: Record<string, number> = {};
```

`GetTextFragments()` quads are `[llx, lly, urx, ury]` in PDF space — check `TextFragment.quad`'s layout in `src/text.ts` before relying on the indices and adjust them to match.

- [ ] **Step 5: Run, investigate every miss, then pin**

Run: `npx vitest run test/xfa-chrome-oracle.test.ts` with temporary `console.log(misses)` / border misses.

For each miss: decide whether it is OUR defect (fix the code in its owning task's module, with a unit test there) or a stated limit (a node pdf.js lays out and we refuse — already reported in `report.skipped`; a caption where pdf.js `Math.ceil`s the reserve). Record each class of residual miss in `PROVENANCE.md`. Then set `MATCHED_TEXT`/`MATCHED_BORDERS` to the final counts and remove the logging.

Expected after pinning: PASS, with matched counts recorded.

- [ ] **Step 6: Update `test/fixtures/xfa-dynamic/PROVENANCE.md`**

Add a `chrome-goldens.json` section: what it holds (border boxes, draw and caption text per page), how it is generated (`npm run gen:xfa`, the same pinned pdf.js 6.3.289 and Chrome), what is compared (text membership, uniform solid border boxes within 1pt), what is NOT (pixels, fills, non-uniform or dashed borders, 3-D styles — pdf.js maps those to CSS `inset`/`outset`, not Adobe), the matched counts, and each residual miss class from Step 5.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-xfa-goldens.ts test/helpers/xfa-dynamic.ts test/fixtures/xfa-dynamic/chrome-goldens.json test/fixtures/xfa-dynamic/PROVENANCE.md test/xfa-chrome-oracle.test.ts
git commit -m "test(164g.4): pdf.js chrome oracle -- draw and caption text and border boxes on three dynamic forms"
```

---

### Task 11: Fences, mutation sweep, documentation, close

**Files:**
- Create: `test/xfa-chrome-fence.test.ts`
- Modify: `CHANGELOG.md`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Write the hybrid fence**

```ts
// test/xfa-chrome-fence.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';

// 164g.4: chrome is painted only on pages the converter CREATES. A hybrid's
// pages carry Designer's rendering already; painting again draws every label
// twice. So converting a hybrid must leave each page's content byte-identical.
const HYBRIDS = ['irs-f1040.pdf', 'irs-fw9.pdf', 'uscis-i130.pdf', 'uscis-i765.pdf', 'dod-dd1155.pdf', 'dod-dd1391.pdf'];
const contentHash = (doc: Document) => doc.Pages.map((p) => createHash('sha256').update(p.Contents).digest('hex'));

describe('hybrid pages are untouched by chrome (164g.4)', () => {
  for (const f of HYBRIDS) {
    it(f, () => {
      const doc = Document.Open(new Uint8Array(readFileSync(`test/fixtures/xfa/${f}`)));
      const before = contentHash(doc);
      const r = doc.ConvertXfaToAcroForm();
      expect(r.chromePages).toBe(0);
      expect(contentHash(doc)).toEqual(before);
    });
  }
});
```

(`Page.Contents` is the concatenated decoded content — confirm its name in `src/page.ts`.)

Run: `npx vitest run test/xfa-chrome-fence.test.ts` — Expected: PASS.

- [ ] **Step 2: Full gates**

```bash
npm run typecheck
npm test
```

Expected: all green. Record the file and test counts.

- [ ] **Step 3: Mutation sweep**

For each mutation below: apply it with a node script written via the Write tool (bash heredocs strip backslashes), CONFIRM the file changed (a no-op mutation reports green), run the named tests, record red/green, restore from a backup copy. Kill orphaned vitest workers after any hang before trusting a later run.

| # | Mutation | Expected red in |
|---|---|---|
| 1 | `handOf` default `'even'` → `'right'` | `xfachrome-border`, `xfaborder` |
| 2 | `four()` pads with the FIRST element instead of the last | `xfaborder` |
| 3 | `rectPath` ignores corner radius (no trim) | `xfachrome-border` |
| 4 | `fieldRegions` caption band taken from `box` instead of the content region | `xfageom-regions`, `xfachrome-text` |
| 5 | `chromeOps` paints a field's `node.text` (the value) instead of its caption | `xfaconvert-chrome` (SECRET), `xfachrome-text` |
| 6 | `textOps` ignores `vAlign` | `xfachrome-text` |
| 7 | `paintChrome` builds the master XObject per page instead of once | `xfapaint` |
| 8 | `widgetStyleOf` maps `lowered` → `'solid'` | `xfaborder`, `xfa-widget-border` |
| 9 | `chromeOps` paint order text before fill | `xfachrome-border` order case, `xfachrome-text` |
| 10 | an `invisible` placed node is painted | `xfachrome-border`, `xfaflow-placed` |
| 11 | `emit` pushes children before their container | `xfaflow-placed` |
| 12 | `widgetStyleOf` writes the raw thickness instead of `max(1, t)` below 1pt | `xfa-widget-border` (Adobe cases) |
| 13 | `paintChrome` called also on the hybrid / kept-placeholder path | `xfa-chrome-fence`, `xfaconvert-chrome` |
| 14 | `chromeContent` flips with a fixed 792 instead of the page height | `xfapaint` (Review Focus 3) |
| 15 | `captionText` ignores the field font fallback | `xfarich-chrome` |

Any mutation that stays green: either add the case that reddens it (in the owning task's test file) or record it as a redundant defence / equivalent mutant with the reason, in the module's CLAUDE.md entry.

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]` → `### Added`:

```markdown
- **`ConvertXfaToAcroForm` now paints a dynamic form's chrome.** A dynamic XFA form's PDF holds only Designer's "Please wait" placeholder, so its converted pages used to carry the widgets and nothing else -- no labels, rules, boxes or captions, which left a DD 1494 as 14 pages of floating input boxes. The pages the converter creates now carry the template's draws (text, rich text, lines and rectangles), the borders and fills of fields, draws, subforms and exclusion groups (per-edge thickness and colour, corner radii, dashes), and every field's caption, laid out by the same engine and measured with the same faces that placed the fields. Master-page chrome (headers, CUI markings) is one shared Form XObject per page area. Widget borders become `/MK` and `/BS`, with `lowered` and `raised` drawn as AcroForm Inset and Beveled; the mapping is checked against the widgets Adobe wrote into IRS f1040 and DoD DD 1155. Text and border boxes are checked against pdf.js's rendering of three dynamic federal forms. Hybrid forms are untouched, since their pages already carry Designer's rendering. What is not painted -- gradient and pattern fills, arcs, images, an etched or embossed edge (drawn solid) -- is listed in `skipped` under the new `what: 'chrome'`, and `report.chromePages` counts the pages painted. (aspose-pdf-foss-for-ts-164g.4)
```

- [ ] **Step 5: CLAUDE.md**

Add entries for `xfaborder.ts`, `xfachrome.ts` and `xfapaint.ts` in the Source list (beside the XFA modules, following the house style: a bold lead-in, invariants, measured notes, the mutation results from Step 3), and amend the `xfaflow.ts` paragraph with the `PlacedNode` invariant (document order, container first; a named field's refusal stays a field report). Run the module-doc sweep and confirm it is empty:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 6: README**

In the **XFA forms** capability paragraph (README line ~200) and the "Convert an XFA Form to an AcroForm" section, add one sentence each: a dynamic form's created pages carry its draws, borders, fills and captions; widget borders map to `/MK`/`/BS`; hybrids are untouched. Update the `doc.ConvertXfaToAcroForm(opts?)` API row's report list to name `chromePages`. Run `npx vitest run test/readme-api.test.ts`.

- [ ] **Step 7: Final gates, close, push**

```bash
npm run typecheck
npm test
git add CHANGELOG.md CLAUDE.md README.md test/xfa-chrome-fence.test.ts
git commit -m "docs(164g.4): CHANGELOG, CLAUDE.md, README; hybrid fence"
bd close 164g.4 --reason "Dynamic XFA forms' created pages carry draws, borders, fills and captions; widget borders map to /MK + /BS (Inset/Beveled for lowered/raised), checked against Adobe's f1040 and DD 1155 widgets; text and border boxes checked against pdf.js on three dynamic forms; hybrids byte-identical."
git pull --rebase
git push
git status
```

Expected: `git status` shows up to date with origin.
