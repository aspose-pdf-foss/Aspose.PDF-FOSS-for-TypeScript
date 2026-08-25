# Rotated / Skewed Table Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract tables (ruled and borderless) at an arbitrary uniform rotation angle θ, returning rows/columns/cell text correctly plus the table's `angle`.

**Architecture:** Detect one dominant θ per page (from text baselines, falling back to rule directions), rotate all rules and glyphs into an upright frame where the existing `partitionRules`/`buildRuledRegion`/`segmentBlocks` pipeline runs unchanged, and tag each resulting `Table` with `angle = θ`. When `|θ| < ANGLE_EPS` the current axis-aligned code path runs unchanged (byte-identical output).

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest. Node built-ins only.

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. No npm runtime deps.
- ESM + NodeNext: all relative imports carry the `.js` extension.
- `strict` TypeScript. `npm run typecheck` and `npm test` must both be green before closing.
- No public API signature changes to `extractTables` / `GetTables`; `Table` gains an additive `angle` field (default 0).
- Axis-aligned output (`angle === 0`) must remain byte-identical: the θ≈0 branch calls the existing `collectRules` + `extractFragments` code path unchanged.
- Follow existing `src/table.ts` / `src/text.ts` style: small pure helpers, `SNAP`/`AXIS_TOL` geometry, validation guards.

---

### Task 1: Expose glyph/fragment baseline orientation (text layer)

Add a baseline `angle` to glyph events and fragments, and factor the glyph→fragment grouping into a reusable pure helper. Add a test-only `rotate` content wrapper. Axis-aligned content stays byte-identical (no `angle` property emitted when horizontal).

**Files:**
- Modify: `src/text.ts` (`GlyphEvent` interface ~`src/text.ts:136`; `emitGlyphs` ~`src/text.ts:383`; `TextFragment` interface ~`src/text.ts:442`; `extractFragments` ~`src/text.ts:456`)
- Modify: `test/helpers/build-table-pdf.ts` (add `rotate`)
- Test: `test/table.test.ts` (new `describe('extractFragments — orientation', …)`)

**Interfaces:**
- Produces (for Task 3):
  - `GlyphEvent.angle: number` — baseline angle in radians (`atan2` of the text→device matrix's x-basis).
  - `TextFragment.angle?: number` — baseline angle; absent when horizontal (`|angle| <= 1e-6`).
  - `fragmentsFromGlyphs(glyphs: GlyphEvent[]): TextFragment[]` — groups consecutive glyphs sharing font/size/**angle**/baseline into fragments (the former body of `extractFragments`).
  - `rotate(deg: number, tx: number, ty: number, inner: string): string` (test helper) — wraps `inner` in `q <rotation-by-deg cm> … Q`, rotating about the origin then translating by `(tx,ty)`.

- [ ] **Step 1: Write the failing tests**

Add the `rotate` helper to `test/helpers/build-table-pdf.ts`:

```ts
/** Wrap content in a CTM that rotates by `deg` about the origin, then translates
 *  by (tx,ty). Glyphs/paths inside are emitted rotated in page space. */
export function rotate(deg: number, tx: number, ty: number, inner: string): string {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const f = (n: number) => n.toFixed(6);
  return `q ${f(c)} ${f(s)} ${f(-s)} ${f(c)} ${tx} ${ty} cm\n${inner}Q\n`;
}
```

Add to `test/table.test.ts` (imports for `extractFragments` and `rotate` are added in Step 3/here):

```ts
import { extractFragments } from '../src/text.js';
// (add `rotate` to the existing build-table-pdf import line)

describe('extractFragments — orientation', () => {
  it('reports the baseline angle of rotated text', () => {
    const stream = rotate(30, 60, 60, text(0, 0, 'Hi'));
    const doc = Document.Open(buildTablePdf(stream));
    const frags = extractFragments(doc, doc.Pages[0]);
    expect(frags.length).toBeGreaterThanOrEqual(1);
    expect(frags[0].angle).toBeCloseTo((30 * Math.PI) / 180, 2);
  });

  it('leaves horizontal text without an angle (byte-identical fragments)', () => {
    const doc = Document.Open(buildTablePdf(text(50, 200, 'Hi')));
    expect(extractFragments(doc, doc.Pages[0])[0].angle).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table.test.ts -t "orientation"`
Expected: FAIL — `frags[0].angle` is `undefined` for the rotated case (field does not exist yet). The second test passes trivially but stays as a regression guard.

- [ ] **Step 3: Add `angle` to `GlyphEvent` and compute it in `emitGlyphs`**

In `src/text.ts`, add to the `GlyphEvent` interface (after the `fontSize` field ~`src/text.ts:143`):

```ts
  /** Baseline angle in radians: atan2 of the text→device matrix x-basis. 0 = horizontal. */
  angle: number;
```

In `emitGlyphs` (`src/text.ts`), compute the angle from `startComb` and include it in the emitted event. Replace the event emission:

```ts
    const angle = Math.atan2(startComb[1], startComb[0]);
    ctx.visitor.glyph?.({
      addr, font: st.font, quad: [x, y, endX, y + size], text: g.text,
      fontSize: size, angle, elementIndex, byteStart: g.byteStart, byteLen: g.byteLen, advance, mcid,
      artifact: artifact || undefined,
    });
```

- [ ] **Step 4: Add `angle?` to `TextFragment` and factor out `fragmentsFromGlyphs`**

In `src/text.ts`, add to the `TextFragment` interface (after `fontName?` ~`src/text.ts:450`):

```ts
  /** Baseline angle in radians; absent when horizontal. */
  angle?: number;
```

Replace the `extractFragments` function (`src/text.ts:456`-`487`) with a reusable grouper plus a thin wrapper:

```ts
/** Group consecutive glyph events sharing font, size, baseline angle, and
 *  baseline (with no large horizontal gap) into positioned fragments. */
export function fragmentsFromGlyphs(glyphs: GlyphEvent[]): TextFragment[] {
  const out: TextFragment[] = [];
  let cur: (TextFragment & { font: TextFont; endX: number; angle: number }) | undefined;
  const flush = () => {
    if (!cur) return;
    const { font, endX, angle, ...rest } = cur;
    out.push(Math.abs(angle) > 1e-6 ? { ...rest, angle } : rest);
    cur = undefined;
  };
  for (const e of glyphs) {
    if (!e.text) continue;
    const [x0, y0, x1, y1] = e.quad;
    const sameStyle = cur
      && cur.font === e.font
      && Math.abs(cur.fontSize - e.fontSize) < 0.01
      && Math.abs(cur.angle - e.angle) < 0.01
      && Math.abs(cur.quad[1] - y0) <= Math.max(2, 0.5 * e.fontSize)
      && x0 - cur.endX <= 0.5 * e.fontSize;
    if (cur && sameStyle) {
      cur.text += e.text;
      cur.quad[2] = Math.max(cur.quad[2], x1);
      cur.quad[3] = Math.max(cur.quad[3], y1);
      cur.endX = x1;
    } else {
      flush();
      cur = {
        text: e.text, quad: [x0, y0, x1, y1], fontSize: e.fontSize,
        fontName: e.font.name, font: e.font, endX: x1, angle: e.angle,
      };
    }
  }
  flush();
  return out;
}

/** Walk a page's content and group consecutive glyphs into positioned fragments,
 *  in content order. The thin positioned counterpart to `extractText`. */
export function extractFragments(doc: Document, page: Page): TextFragment[] {
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: (e) => glyphs.push(e) });
  return fragmentsFromGlyphs(glyphs);
}
```

- [ ] **Step 5: Run the orientation tests**

Run: `npx vitest run test/table.test.ts -t "orientation"`
Expected: PASS (both).

- [ ] **Step 6: Run the full suite to catch text-layer regressions**

Run: `npm test`
Expected: all PASS. If any test fails **only** because a fragment/glyph now carries `angle`, that assertion was comparing the whole event/fragment object — update it to expect the added field (the underlying data is unchanged). Horizontal fragments must remain `angle`-free, so `extractFragments` consumers should be unaffected.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/text.ts test/helpers/build-table-pdf.ts test/table.test.ts
git commit -m "feat(5ct): expose glyph/fragment baseline angle + fragmentsFromGlyphs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Orientation module (`src/tableorient.ts`)

A pure module: dominant-angle detection and rotation helpers. Unit-tested directly.

**Files:**
- Create: `src/tableorient.ts`
- Test: `test/tableorient.test.ts`

**Interfaces:**
- Consumes: `Matrix`, `apply` from `./text.js`.
- Produces (for Task 3):
  - `interface Seg { x0: number; y0: number; x1: number; y1: number; }`
  - `ANGLE_EPS = 0.005` (radians, ≈0.29°).
  - `rot(theta: number): Matrix` — rotation about the origin.
  - `dominantAngle(segments: Seg[], glyphAngles: number[]): number` — text-baseline-primary; else rule-direction mod 90°; else 0.

- [ ] **Step 1: Write the failing tests**

Create `test/tableorient.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { apply } from '../src/text.js';
import { dominantAngle, rot, ANGLE_EPS, type Seg } from '../src/tableorient.js';

describe('dominantAngle', () => {
  it('uses the modal glyph baseline angle when text is present', () => {
    const a = (30 * Math.PI) / 180;
    expect(dominantAngle([], [a, a, a, 0])).toBeCloseTo(a, 2);
  });

  it('resolves a 90° table from text even when rules look axis-aligned', () => {
    const axisSegs: Seg[] = [
      { x0: 0, y0: 0, x1: 10, y1: 0 }, { x0: 0, y0: 0, x1: 0, y1: 10 },
    ];
    const a = Math.PI / 2;
    expect(dominantAngle(axisSegs, [a, a, a])).toBeCloseTo(a, 2);
  });

  it('falls back to rule direction (mod 90°) when there is no text', () => {
    const t = (5 * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
    const segs: Seg[] = [
      { x0: 0, y0: 0, x1: 10 * c, y1: 10 * s },     // ~5°
      { x0: 0, y0: 0, x1: -10 * s, y1: 10 * c },    // ~95° → 5° mod 90
    ];
    expect(dominantAngle(segs, [])).toBeCloseTo(t, 2);
  });

  it('returns 0 for empty input', () => {
    expect(dominantAngle([], [])).toBe(0);
    expect(Math.abs(dominantAngle([], [0.001]))).toBeLessThan(ANGLE_EPS);
  });
});

describe('rot', () => {
  it('rotates the unit x-vector by the angle', () => {
    const [x, y] = apply(rot(Math.PI / 2), 1, 0);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(1, 6);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tableorient.test.ts`
Expected: FAIL — module `../src/tableorient.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `src/tableorient.ts`:

```ts
import type { Matrix } from './text.js';

/** ~0.29°: below this, a page is treated as axis-aligned. */
export const ANGLE_EPS = 0.005;

export interface Seg { x0: number; y0: number; x1: number; y1: number; }

/** Rotation-about-origin matrix for angle `theta` (radians). */
export function rot(theta: number): Matrix {
  const c = Math.cos(theta), s = Math.sin(theta);
  return [c, s, -s, c, 0, 0];
}

/** Wrap `a` into (-period/2, period/2]. */
function normalize(a: number, period: number): number {
  let x = a % period;
  if (x < 0) x += period;
  if (x > period / 2) x -= period;
  return x;
}

/** Weighted modal angle over [0, period): 1° bins, then the weighted mean of the
 *  modal bin and its immediate neighbours, normalised to (-period/2, period/2]. */
function modeAngle(angles: number[], weights: number[], period: number): number {
  const binW = Math.PI / 180;
  const nbins = Math.max(1, Math.round(period / binW));
  const acc = new Array(nbins).fill(0);
  const norm = angles.map((a) => { let x = a % period; if (x < 0) x += period; return x; });
  const binOf = (x: number) => Math.min(nbins - 1, Math.floor((x / period) * nbins));
  norm.forEach((x, i) => { acc[binOf(x)] += weights[i]; });
  let best = 0;
  for (let b = 1; b < nbins; b++) if (acc[b] > acc[best]) best = b;
  let sw = 0, sa = 0;
  norm.forEach((x, i) => { if (Math.abs(binOf(x) - best) <= 1) { sw += weights[i]; sa += weights[i] * x; } });
  const mean = sw ? sa / sw : ((best + 0.5) * period) / nbins;
  return normalize(mean, period);
}

/** Dominant rotation angle (radians). Text-baseline-primary (full circle);
 *  falls back to rule direction mod 90°; 0 when neither is available. */
export function dominantAngle(segments: Seg[], glyphAngles: number[]): number {
  if (glyphAngles.length) return modeAngle(glyphAngles, glyphAngles.map(() => 1), 2 * Math.PI);
  const oriented = segments
    .map((s) => ({ a: Math.atan2(s.y1 - s.y0, s.x1 - s.x0), w: Math.hypot(s.x1 - s.x0, s.y1 - s.y0) }))
    .filter((o) => o.w > 0);
  if (!oriented.length) return 0;
  return modeAngle(oriented.map((o) => o.a), oriented.map((o) => o.w), Math.PI / 2);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tableorient.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tableorient.ts test/tableorient.test.ts
git commit -m "feat(5ct): dominant-angle detection + rotation helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Rotated extraction orchestration + `Table.angle` + fixtures

Wire detection and the upright-frame transform into `extractTables`, add the `angle` field to `Table`, and cover rotated ruled and borderless tables end-to-end. Factor the shared build core into `buildTables` so the axis and rotated branches reuse it.

**Files:**
- Modify: `src/tablemodel.ts` (`Table` class ~`src/tablemodel.ts:26`)
- Modify: `src/table.ts` (imports; add `pathCenterlines`, `collectOriented`, `classifyRules`, `buildTables`; rewrite `extractTables` ~`src/table.ts:363`)
- Test: `test/table.test.ts` (new `describe('extractTables — rotated', …)`)

**Interfaces:**
- Consumes: `dominantAngle`, `rot`, `ANGLE_EPS`, `Seg` (Task 2); `fragmentsFromGlyphs`, `GlyphEvent`, `apply` (Task 1 + text.ts); existing `partitionRules`, `buildRuledRegion`, `ruleBbox`, `rectContains`, `uniqSorted`, `segmentBlocks`, `contains`, `centroid`, `clusterRules`, `collectRules`, `extractFragments`, `AXIS_TOL`, `MIN_RULE_LEN`, `MAX_RULE_THICK`, `Rule`, `inRegion`.
- Produces: `Table.angle: number` (0 for axis-aligned; θ radians for rotated). No new exported functions.

- [ ] **Step 1: Write the failing tests**

Add to `test/table.test.ts` (ensure `rotate` is imported — added in Task 1):

```ts
describe('extractTables — rotated', () => {
  // A small upright 2×2 ruled table (cols x=0,50,100; rows y=0,40,80).
  const ruledInner =
    hline(0, 100, 80) + hline(0, 100, 40) + hline(0, 100, 0) +
    vline(0, 0, 80) + vline(50, 0, 80) + vline(100, 0, 80) +
    text(5, 60, 'X') + text(55, 60, 'Y') +
    text(5, 20, 'p') + text(55, 20, 'q');
  // A small upright borderless 2-col/3-row table (cols x=0,60; rows y=40,25,10).
  const wsRows = [['Name', 'Age'], ['Al', '1'], ['Bo', '2']];
  let wsInner = '';
  wsRows.forEach((r, i) => { const y = 40 - i * 15; wsInner += text(0, y, r[0]) + text(60, y, r[1]); });

  it('extracts a ruled table rotated 90°', () => {
    const doc = Document.Open(buildTablePdf(rotate(90, 100, 100, ruledInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo(Math.PI / 2, 2);
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.text))).toEqual([['X', 'Y'], ['p', 'q']]);
  });

  it('extracts a ruled table skewed ~5°', () => {
    const doc = Document.Open(buildTablePdf(rotate(5, 30, 30, ruledInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo((5 * Math.PI) / 180, 2);
    expect(tables[0].rows.map((r) => r.cells.map((c) => c.text))).toEqual([['X', 'Y'], ['p', 'q']]);
  });

  it('extracts a borderless table rotated 90°', () => {
    const doc = Document.Open(buildTablePdf(rotate(90, 80, 100, wsInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo(Math.PI / 2, 2);
    expect(tables[0].colCount).toBe(2);
    expect(tables[0].rowCount).toBe(3);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
  });

  it('extracts a borderless table skewed ~10°', () => {
    const doc = Document.Open(buildTablePdf(rotate(10, 40, 40, wsInner)));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables).toHaveLength(1);
    expect(tables[0].angle).toBeCloseTo((10 * Math.PI) / 180, 2);
    expect(tables[0].rows[0].cells.map((c) => c.text)).toEqual(['Name', 'Age']);
  });

  it('leaves an axis-aligned table with angle 0', () => {
    const stream =
      hline(50, 150, 200) + hline(50, 150, 100) +
      vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200) +
      text(55, 150, 'X') + text(105, 150, 'Y');
    const doc = Document.Open(buildTablePdf(stream));
    const tables = extractTables(doc, doc.Pages[0]);
    expect(tables[0].angle).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/table.test.ts -t "rotated"`
Expected: FAIL — `tables[0].angle` is `undefined` (field missing) and rotated cases return 0 tables or a garbled single table.

- [ ] **Step 3: Add the `angle` field to `Table`**

In `src/tablemodel.ts`, add a field to the `Table` class body (after the constructor, before `toHtml` ~`src/tablemodel.ts:38`):

```ts
  /** Rotation of the table in radians; 0 for axis-aligned. Quads are in the
   *  table's own upright frame — map a corner to page space via a rotation by
   *  `angle` about the origin. */
  angle = 0;
```

- [ ] **Step 4: Add the geometry helpers to `table.ts`**

In `src/table.ts`, update the imports at the top:

```ts
import { visitContent, extractFragments, fragmentsFromGlyphs, apply, type PathEvent, type TextFragment, type GlyphEvent } from './text.js';
import { dominantAngle, rot, ANGLE_EPS, type Seg } from './tableorient.js';
```

(Keep the other existing imports.) Then add these helpers immediately before `export function extractTables` (`src/table.ts:363`):

```ts
/** Page-space centerline segments of a painted path: stroked segments as-is;
 *  a thin filled rectangle collapsed to its centerline by its page-space AABB.
 *  (A rotated *filled* rule's AABB is not thin, so it is dropped — documented
 *  gap; rotated *stroked* rules are preserved.) */
function pathCenterlines(e: PathEvent): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (e.fill && !e.stroke) {
    const xs = e.segments.flatMap((s) => [s[0], s[2]]);
    const ys = e.segments.flatMap((s) => [s[1], s[3]]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, h = y1 - y0;
    if (Math.min(w, h) <= MAX_RULE_THICK && Math.max(w, h) >= MIN_RULE_LEN) {
      if (w >= h) out.push([x0, (y0 + y1) / 2, x1, (y0 + y1) / 2]);
      else out.push([(x0 + x1) / 2, y0, (x0 + x1) / 2, y1]);
    }
    return out;
  }
  for (const s of e.segments) out.push([s[0], s[1], s[2], s[3]]);
  return out;
}

/** One content walk collecting page-space centerline segments and text glyphs. */
function collectOriented(doc: Document, page: Page): { segs: Seg[]; glyphs: GlyphEvent[] } {
  const segs: Seg[] = [];
  const glyphs: GlyphEvent[] = [];
  visitContent(doc, page, {
    path: (e) => { for (const c of pathCenterlines(e)) segs.push({ x0: c[0], y0: c[1], x1: c[2], y1: c[3] }); },
    glyph: (e) => { if (e.text) glyphs.push(e); },
  });
  return { segs, glyphs };
}

/** Classify oriented centerline segments into clustered axis-aligned rules
 *  (identical rule math to `rulesFromPath`'s stroke branch). */
function classifyRules(segs: [number, number, number, number][]): { horiz: Rule[]; vert: Rule[] } {
  const horiz: Rule[] = [], vert: Rule[] = [];
  for (const [x0, y0, x1, y1] of segs) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    if (dy <= AXIS_TOL && dx >= MIN_RULE_LEN) {
      horiz.push({ pos: (y0 + y1) / 2, lo: Math.min(x0, x1), hi: Math.max(x0, x1) });
    } else if (dx <= AXIS_TOL && dy >= MIN_RULE_LEN) {
      vert.push({ pos: (x0 + x1) / 2, lo: Math.min(y0, y1), hi: Math.max(y0, y1) });
    }
  }
  return { horiz: clusterRules(horiz), vert: clusterRules(vert) };
}

/** The ruled + whitespace build core, shared by the axis and rotated branches.
 *  Operates in whatever frame `horiz`/`vert`/`frags` are expressed in. */
function buildTables(horiz: Rule[], vert: Rule[], frags: TextFragment[]): Table[] {
  const out: Table[] = [];
  const comps = partitionRules(horiz, vert).map((c) => ({ ...c, bbox: ruleBbox(c.horiz, c.vert) }));
  const rectArea = (b: Rect): number => (b[2] - b[0]) * (b[3] - b[1]);
  for (const top of comps) {
    if (comps.some((o) => o !== top && rectArea(o.bbox) > rectArea(top.bbox) && rectContains(o.bbox, top.bbox))) continue;
    const cHoriz: Rule[] = [], cVert: Rule[] = [];
    for (const c of comps) if (c === top || rectContains(top.bbox, c.bbox)) { cHoriz.push(...c.horiz); cVert.push(...c.vert); }
    if (uniqSorted(cHoriz.map((r) => r.pos), false).length < 2
      || uniqSorted(cVert.map((r) => r.pos), true).length < 2) continue;
    const bbox = ruleBbox(cHoriz, cVert);
    const compFrags = frags.filter((f) => contains(bbox, ...centroid(f.quad)));
    const t = buildRuledRegion(cHoriz, cVert, compFrags, bbox);
    if (t && t.rows.length) out.push(t);
  }
  // Whitespace tables from fragments not inside a ruled table.
  const ruledBoxes = out.map((t) => t.quad);
  const wsFrags = frags.filter((f) => !ruledBoxes.some((b) => contains(b, ...centroid(f.quad))));
  out.push(...segmentBlocks(wsFrags));
  // Reading order: top→bottom, then left→right.
  out.sort((a, b) => (b.quad[3] - a.quad[3]) || (a.quad[0] - b.quad[0]));
  return out;
}
```

- [ ] **Step 5: Rewrite `extractTables` to detect θ and branch**

In `src/table.ts`, replace the whole body of `extractTables` (`src/table.ts:363`-`399`) with:

```ts
export function extractTables(doc: Document, page: Page, options: TableExtractOptions = {}): Table[] {
  if (options.structure !== 'off') {
    const tagged = extractTaggedTables(doc, page, options);
    if (tagged.length) return tagged;
  }
  const { segs, glyphs } = collectOriented(doc, page);
  const theta = dominantAngle(segs, glyphs.map((g) => g.angle));

  // Axis-aligned: run the existing code path unchanged (byte-identical output).
  if (Math.abs(theta) < ANGLE_EPS) {
    const { horiz, vert } = collectRules(doc, page, options.region);
    const frags = extractFragments(doc, page).filter((f) =>
      !options.region || contains(options.region, ...centroid(f.quad)));
    return buildTables(horiz, vert, frags);
  }

  // Rotated: filter by the page-space region, rotate into the upright frame,
  // classify rules, rebuild fragments, run the pipeline, tag with theta.
  const inReg = (x: number, y: number): boolean =>
    !options.region || contains(options.region, x, y);
  const R = rot(-theta);
  const rSeg = segs
    .filter((s) => inReg((s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2))
    .map((s) => {
      const [x0, y0] = apply(R, s.x0, s.y0);
      const [x1, y1] = apply(R, s.x1, s.y1);
      return [x0, y0, x1, y1] as [number, number, number, number];
    });
  const { horiz, vert } = classifyRules(rSeg);
  const rGlyphs = glyphs
    .filter((g) => inReg((g.quad[0] + g.quad[2]) / 2, (g.quad[1] + g.quad[3]) / 2))
    .map((g) => {
      const [ox, oy] = apply(R, g.quad[0], g.quad[1]);
      const w = g.advance * g.fontSize;   // upright baseline width (approx)
      return { ...g, quad: [ox, oy, ox + w, oy + g.fontSize] as Rect, angle: 0 };
    });
  const frags = fragmentsFromGlyphs(rGlyphs);
  const tables = buildTables(horiz, vert, frags);
  for (const t of tables) t.angle = theta;
  return tables;
}
```

- [ ] **Step 6: Run the rotated tests**

Run: `npx vitest run test/table.test.ts -t "rotated"`
Expected: PASS (all five).

- [ ] **Step 7: Run the full table suites + typecheck**

Run: `npx vitest run test/table.test.ts test/table-nested.test.ts test/table-stitch.test.ts test/table-tagged.test.ts test/tablemodel.test.ts test/tableorient.test.ts && npm run typecheck`
Expected: all PASS; no type errors. Confirms the axis-aligned path is unchanged.

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/table.ts src/tablemodel.ts test/table.test.ts
git commit -m "feat(5ct): rotated/skewed table extraction via upright-frame transform

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Regression safety hinges on the θ≈0 branch** calling the original `collectRules` + `extractFragments` + `buildTables` sequence. `buildTables` is a verbatim extraction of the current post-`ajj` `extractTables` tail (ruled loop → whitespace → sort); do not alter its logic.
- **`advance · fontSize`** approximates the upright glyph width; exactness is not required because fragments are assigned to cells by centroid and grouped with generous tolerances.
- **Detection is text-primary** so a 90° table (whose rules are still axis-aligned in page space) is correctly rotated by its text baseline; rules-mod-90° is only the no-text fallback.
- **Documented limitations** (from the spec): one dominant θ per page (mixed-angle pages resolve to the dominant orientation); true non-perpendicular shear unsupported; rotated *filled* (non-stroked) rules are dropped by `pathCenterlines`.
- No README change required beyond noting rotated-table support if the table section enumerates capabilities — check `README.md`'s table-extraction blurb during Task 3 and add a one-line mention if appropriate.
```
