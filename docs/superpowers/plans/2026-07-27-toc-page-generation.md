# TOC page generation (`page.AddTOC`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `page.AddTOC(entries, rect, opts)` renders a table of contents — wrapped
titles, dot leaders, right-aligned page labels, borderless GoTo links, optional
nesting indent — with overflow as a returned remainder or by appending pages.

**Architecture:** Two new modules mirroring the table layer's authoring/render
split. `src/toc.ts` holds the model, validation and a pure measure pass;
`src/tocrender.ts` paints and paginates. No new rendering primitives: text goes
through `stampText` (stamp.ts), links through `addLink` (annotation.ts), wrapping
through `layoutText` (layout.ts) behind one new `@internal` `wrapLines` export in
stamp.ts.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime
dependencies.

Spec: [docs/superpowers/specs/2026-07-27-toc-page-generation-design.md](../specs/2026-07-27-toc-page-generation-design.md).
Issue: `aspose-pdf-foss-for-ts-1gg0.1`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension
  (`import { stampText } from './stamp.js'`).
- **`strict` TypeScript.** `npm run typecheck` must pass.
- **TDD:** write the failing test first, watch it fail, then implement.
- **Validate before mutate:** every throwing call must leave the document
  byte-identical. All validation happens in the measure pass, before any paint.
- **Public error types only:** `TypeError` / `RangeError` here (see errors.ts for
  the PDF-specific ones — none apply to this feature).
- **Commit after each task.** Do not use TodoWrite; this project tracks work in
  `bd` (issue `aspose-pdf-foss-for-ts-1gg0.1`).
- Run `npx vitest run test/toc.test.ts` to target this feature's suite;
  `npm test` for the full run.

## File Structure

| File | Responsibility |
|---|---|
| `src/stamp.ts` (modify) | `+ wrapLines` — height-unbounded greedy wrap reporting each line's width |
| `src/toc.ts` (create) | `TOCEntry`, `TOCOptions`, row-style resolution, validation, `measureTOC` |
| `src/tocrender.ts` (create) | `AddTOCResult`, `drawTOC` — painting, links, pagination |
| `src/page.ts` (modify) | `Page.AddTOC` delegating to `drawTOC` |
| `src/index.ts` (modify) | export `TOCEntry`, `TOCOptions`, `AddTOCResult` |
| `test/toc.test.ts` (create) | the feature's suite |
| `test/stamp.test.ts` (modify) | `wrapLines` unit tests |
| `README.md` (modify) | `AddTOC` under the authoring section |

### Gotcha you must know before writing tests

> **Corrected during execution.** The analysis below is wrong about the fix, and
> the `leaderGap: 10` it prescribes does not work. `stampText` writes
> Standard-14 font dicts with **no `/Widths`** (legal — viewers use the built-in
> AFM metrics), so `font.ts` takes its `hasWidths === false` path and estimates
> **every glyph at 0.5em** ([font.ts:29,74](../../../src/font.ts#L29)). A
> 93-dot leader then measures 558pt instead of 310pt, overshooting the label and
> merging with it whatever `leaderGap` is. Fragment *start* x is still exact (it
> is the `Tm` tx); ends and merges are not. **Assert placement by parsing
> `/Contents` for `1 0 0 1 tx ty Tm` + `(text) Tj` pairs** — the house style of
> stamp.test.ts — see the `runs()` helper at the top of `test/toc.test.ts`. The
> shipped tests use that; the `leaderGap` values below are harmless leftovers.

`GetTextFragments` merges consecutive glyphs that share font, size and baseline
when the horizontal gap is `<= 0.5 * fontSize`
([text.ts:487-492](../../../src/text.ts#L487-L492)). At the default
`leaderGap: 4` with `fontSize: 12` the threshold is 6pt, so a row's title, dots
and label merge into **one** fragment. Tests that need them separate must pass
`leaderGap: 10`. This is not a bug — it is why the tests below all specify
`leaderGap`.

---

### Task 1: `wrapLines` in stamp.ts

**Files:**
- Modify: `src/stamp.ts` (add after `measureTextBlock`, ~line 464)
- Test: `test/stamp.test.ts`

**Interfaces:**
- Consumes: existing `layoutText`, `normalizeBlockOptions`, `driverFor`,
  `shapedDriver`, `effectiveShape`, `shapeOptsFrom` — all already in stamp.ts.
- Produces: `wrapLines(text: string, width: number, options?: TextBlockOptions):
  { text: string; width: number }[]`

- [x] **Step 1: Write the failing tests**

Append to `test/stamp.test.ts`. Check its existing imports first — add
`wrapLines` to the `../src/stamp.js` import (it is `@internal`, so it is *not*
exported from `index.ts`).

```ts
describe('wrapLines', () => {
  it('breaks at the box width and reports each line width', () => {
    const lines = wrapLines('alpha beta gamma delta', 60, { font: 'Helvetica', fontSize: 12 });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.map((l) => l.text).join(' ')).toBe('alpha beta gamma delta');
    for (const l of lines) {
      expect(l.width).toBeLessThanOrEqual(60);
      expect(l.width).toBeCloseTo(measureText(l.text, 12, 'Helvetica'), 6);
    }
  });

  it('is height-unbounded: no line is dropped however many there are', () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const lines = wrapLines(text, 60, { font: 'Helvetica', fontSize: 12 });
    expect(lines.length).toBeGreaterThan(20);
    expect(lines.map((l) => l.text).join(' ')).toBe(text);
  });

  it('returns [] for empty or unencodable text', () => {
    expect(wrapLines('', 100)).toEqual([]);
  });

  it('rejects a non-positive width', () => {
    expect(() => wrapLines('a', 0)).toThrow(TypeError);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/stamp.test.ts -t wrapLines`
Expected: FAIL — `wrapLines is not a function` / TypeScript cannot resolve the import.

- [x] **Step 3: Implement `wrapLines`**

Add to `src/stamp.ts` immediately after `measureTextBlock`:

```ts
/** @internal Greedy-wrap `text` to `width` with no height limit, reporting each
 *  line's measured width. Shares `layoutText` — and its shaped-driver selection —
 *  with {@link flowTextBlock}, so lines drawn afterwards through {@link stampText}
 *  break identically. The width is what a caller needs to know where a line ends
 *  (toc.ts starts a dot leader there), which neither stampTextBlock nor
 *  measureTextBlock reports.
 *
 *  Note for embedded fonts: `layoutText` encodes each kept line, and an embedded
 *  font's `encode` records used glyphs. Measuring therefore retains glyphs for
 *  text that a caller may end up not drawing — a marginally larger subset, never
 *  a wrong one. */
export function wrapLines(
  text: string, width: number, options: TextBlockOptions = {},
): { text: string; width: number }[] {
  if (!Number.isFinite(width) || width <= 0)
    throw new TypeError('width must be a positive finite number');
  const o = normalizeBlockOptions(options);
  let driver: FontDriver;
  if (effectiveShape(o.font, options.shape)) driver = shapedDriver(o.font, shapeOptsFrom(options));
  else driver = driverFor(o.font);
  if (driver.probe(text) === 0) return [];
  const { lines } = layoutText(text, driver, o.fontSize, width, Infinity, o.leading);
  return lines.map((l) => ({ text: l.text, width: l.width }));
}
```

The `Infinity` height is legitimate: `layoutText`'s Phase B keeps lines while
`used + leading <= boxHeight + EPS`, which never terminates early at `Infinity`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/stamp.test.ts`
Expected: PASS (the whole file, not just the new block).

- [x] **Step 5: Commit**

```bash
git add src/stamp.ts test/stamp.test.ts
git commit -m "feat(stamp): wrapLines reports wrapped lines and their widths (1gg0.1)"
```

---

### Task 2: `src/toc.ts` — model, validation, measurement

**Files:**
- Create: `src/toc.ts`
- Test: `test/toc.test.ts` (create — measurement tests only in this task)

**Interfaces:**
- Consumes: `wrapLines` (Task 1); `measureText`, `validateFont`, `AuthoringFont`,
  `StampOptions`, `TextBlockOptions` from `./stamp.js`; `encodeAction` from
  `./actions.js`; `OutlineView` from `./outline.js`; `parsePageLabels`,
  `resolvePageLabel` from `./pagelabels.js`.
- Produces:
  - `interface TOCEntry { title: string; page: number; label?: string; level?: number; style?: Pick<TOCOptions, 'font' | 'fontSize' | 'color'> }`
  - `interface TOCOptions extends Omit<TextBlockOptions, 'align' | 'valign' | 'tag'>` with `rowGap?`, `indent?`, `leader?: 'dots' | 'none'`, `leaderGap?`, `links?`, `view?`, `autoPaginate?`
  - `interface RowStyle { font: AuthoringFont; fontSize: number; color: [number, number, number]; leading: number }`
  - `interface MeasuredRow { entry: TOCEntry; style: RowStyle; label: string; lines: { text: string; width: number }[]; titleLeft: number; height: number }`
  - `interface TOCLayout { rows: MeasuredRow[]; numberLeft: number; rowRight: number; rowGap: number; leader: 'dots' | 'none'; leaderGap: number; links: boolean; view: OutlineView; autoPaginate: boolean }`
  - `measureTOC(doc: Document, entries: TOCEntry[], rect: [number, number, number, number], opts?: TOCOptions): TOCLayout`
  - `rowMeasure(s: string, style: RowStyle, opts: TOCOptions): number`
  - `rowStampOptions(style: RowStyle, opts: TOCOptions, align: 'left' | 'right'): StampOptions`

- [x] **Step 1: Write the failing tests**

Create `test/toc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { measureTOC } from '../src/toc.js';
import { measureText } from '../src/stamp.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPageLabelsPdf } from './helpers/build-pagelabels-pdf.js';

/** A letter-size document with `n` pages; page 1 is the TOC page. */
function docWith(n: number): Document {
  const doc = Document.Open(buildBlankPage());
  while (doc.Pages.length < n) doc.AddPage();
  return doc;
}

const RECT: [number, number, number, number] = [72, 400, 400, 300];

describe('TOC measurement — measureTOC', () => {
  it('sizes the number column over every entry, not just the widest title', () => {
    const doc = docWith(120);
    const L = measureTOC(doc, [{ title: 'One', page: 1 }, { title: 'Two', page: 120 }], RECT,
      { fontSize: 12 });
    const widest = measureText('120', 12, 'Helvetica');
    expect(L.rowRight).toBeCloseTo(472, 6);
    expect(L.numberLeft).toBeCloseTo(472 - widest, 6);
  });

  it('indents by level and narrows that row\'s title column', () => {
    const doc = docWith(2);
    const L = measureTOC(doc, [
      { title: 'Top', page: 1 },
      { title: 'Nested', page: 2, level: 3 },
    ], RECT, { fontSize: 12, indent: 20 });
    expect(L.rows[0].titleLeft).toBeCloseTo(72, 6);
    expect(L.rows[1].titleLeft).toBeCloseTo(72 + 40, 6);
  });

  it('a row\'s leading follows its own fontSize unless the call sets one', () => {
    const doc = docWith(1);
    const entries = [
      { title: 'Big', page: 1, style: { fontSize: 20 } },
      { title: 'Small', page: 1 },
    ];
    const auto = measureTOC(doc, entries, RECT, { fontSize: 10 });
    expect(auto.rows[0].height).toBeCloseTo(24, 6);   // 1.2 * 20
    expect(auto.rows[1].height).toBeCloseTo(12, 6);   // 1.2 * 10
    const fixed = measureTOC(doc, entries, RECT, { fontSize: 10, leading: 15 });
    expect(fixed.rows[0].height).toBeCloseTo(15, 6);
    expect(fixed.rows[1].height).toBeCloseTo(15, 6);
  });

  it('an empty title still occupies exactly one line', () => {
    const doc = docWith(1);
    const L = measureTOC(doc, [{ title: '', page: 1 }], RECT, { fontSize: 12 });
    expect(L.rows[0].lines).toEqual([]);
    expect(L.rows[0].height).toBeCloseTo(14.4, 6);    // max(0, 1) * 1.2 * 12
  });

  it('defaults the label to the logical page label, else the page number', () => {
    const labelled = Document.Open(buildPageLabelsPdf());     // pages 1-3 roman
    const L = measureTOC(labelled, [{ title: 'Preface', page: 3 }], RECT, { fontSize: 12 });
    expect(L.rows[0].label).toBe('iii');
    const plain = docWith(3);
    expect(measureTOC(plain, [{ title: 'Ch', page: 3 }], RECT, { fontSize: 12 }).rows[0].label)
      .toBe('3');
    expect(measureTOC(plain, [{ title: 'Ch', page: 3, label: 'A-1' }], RECT, { fontSize: 12 })
      .rows[0].label).toBe('A-1');
  });

  it('rejects bad input before producing any layout', () => {
    const doc = docWith(2);
    const ok = [{ title: 'Ch', page: 1 }];
    expect(() => measureTOC(doc, ok, [72, 400, 0, 300])).toThrow(TypeError);
    expect(() => measureTOC(doc, [{ title: 'Ch', page: 9 }], RECT)).toThrow(RangeError);
    expect(() => measureTOC(doc, [{ title: 'Ch', page: 0 }], RECT)).toThrow(RangeError);
    expect(() => measureTOC(doc, [{ title: 42 as unknown as string, page: 1 }], RECT))
      .toThrow(TypeError);
    expect(() => measureTOC(doc, [{ title: 'Ch', page: 1, level: 0 }], RECT)).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { rowGap: -1 })).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { leader: 'dashes' as 'dots' })).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { fontSize: -3 })).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { font: 'Comic Sans' as 'Helvetica' })).toThrow(TypeError);
  });

  it('rejects a box too narrow to hold the title column at that level', () => {
    const doc = docWith(1);
    expect(() => measureTOC(doc, [{ title: 'Deep', page: 1, level: 5 }], [72, 400, 60, 300],
      { fontSize: 12, indent: 20 })).toThrow(RangeError);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/toc.test.ts`
Expected: FAIL — cannot resolve `../src/toc.js`.

- [x] **Step 3: Create `src/toc.ts`**

```ts
// Table-of-contents model, validation and measurement (issue 1gg0.1). Painting
// and pagination live in tocrender.ts, mirroring the tableauthor/tablerender
// split. The Document is needed for two read-only things only: /PageLabels for
// default labels, and GoTo page-range validation.
import type { Document } from './document.js';
import { encodeAction } from './actions.js';
import type { OutlineView } from './outline.js';
import { parsePageLabels, resolvePageLabel } from './pagelabels.js';
import {
  measureText, validateFont, wrapLines,
  type AuthoringFont, type StampOptions, type TextBlockOptions,
} from './stamp.js';

/** One row of a table of contents. */
export interface TOCEntry {
  /** Row text; wrapped to the title column. May be empty (the row still draws
   *  its label and link on one line). */
  title: string;
  /** 1-based target page for the row's GoTo link. */
  page: number;
  /** Displayed right-hand text. Default: the target page's logical /PageLabels
   *  label, else its decimal page number. */
  label?: string;
  /** Nesting depth, integer >= 1. Default 1. Indents the title by
   *  (level - 1) * indent. */
  level?: number;
  /** Per-row typographic override, merged over the call defaults. */
  style?: Pick<TOCOptions, 'font' | 'fontSize' | 'color'>;
}

/** Options for {@link Page.AddTOC}. Inherits the typographic options of
 *  {@link TextBlockOptions} (font, fontSize, color, opacity, leading, and the
 *  shaping passthrough) minus the ones a TOC row controls itself. */
export interface TOCOptions extends Omit<TextBlockOptions, 'align' | 'valign' | 'tag'> {
  /** Extra vertical gap between consecutive rows, points. Default 0. */
  rowGap?: number;
  /** Indent step per nesting level, points. Default 18. */
  indent?: number;
  /** Leader run between title and label. Default 'dots'. */
  leader?: 'dots' | 'none';
  /** Minimum blank gap on each side of the leader run, points. Default 4. */
  leaderGap?: number;
  /** Create a borderless GoTo link over each row. Default true. */
  links?: boolean;
  /** Destination view for those links. Default { type: 'Fit' }. */
  view?: OutlineView;
  /** Append pages sized to the anchor and draw every entry. Default false. */
  autoPaginate?: boolean;
}

const DEFAULT_INDENT = 18;
const DEFAULT_LEADER_GAP = 4;

/** @internal A row's resolved typography: call defaults with the per-entry
 *  `style` merged over them. */
export interface RowStyle {
  font: AuthoringFont;
  fontSize: number;
  color: [number, number, number];
  leading: number;
}

/** @internal One measured row: everything the painter needs and nothing else. */
export interface MeasuredRow {
  entry: TOCEntry;
  style: RowStyle;
  /** The resolved right-hand text (never undefined by this point). */
  label: string;
  /** Wrapped title lines. Empty for an empty/unencodable title — the row still
   *  occupies one line; see `height`. */
  lines: { text: string; width: number }[];
  titleLeft: number;
  /** max(lines.length, 1) * leading. */
  height: number;
}

/** @internal Resolved call-level geometry and options, shared by every row. */
export interface TOCLayout {
  rows: MeasuredRow[];
  /** Left edge of the right-aligned number column. */
  numberLeft: number;
  /** Right edge of every row (the box's right edge). */
  rowRight: number;
  rowGap: number;
  leader: 'dots' | 'none';
  leaderGap: number;
  links: boolean;
  view: OutlineView;
  autoPaginate: boolean;
}

function nonNeg(v: number | undefined, dflt: number, what: string): number {
  const n = v ?? dflt;
  if (!Number.isFinite(n) || n < 0)
    throw new TypeError(`${what} must be a non-negative finite number`);
  return n;
}

/** Resolve one row's typography. An explicit call-level `leading` applies to
 *  every row; otherwise each row's leading follows its own size, so a 16pt
 *  level-1 row is not cramped by a 12pt call default. */
function rowStyle(entry: TOCEntry, opts: TOCOptions): RowStyle {
  const s = entry.style ?? {};
  const fontSize = s.fontSize ?? opts.fontSize ?? 12;
  return {
    font: s.font ?? opts.font ?? 'Helvetica',
    fontSize,
    color: s.color ?? opts.color ?? [0, 0, 0],
    leading: opts.leading ?? 1.2 * fontSize,
  };
}

/** Validate a resolved row style up front. stamp.ts re-validates on every draw,
 *  but that is too late: the first rows would already be painted. */
function validateRowStyle(style: RowStyle, i: number): void {
  validateFont(style.font);
  if (!Number.isFinite(style.fontSize) || style.fontSize <= 0)
    throw new TypeError(`entries[${i}]: fontSize must be a positive finite number`);
  if (!Number.isFinite(style.leading) || style.leading <= 0)
    throw new TypeError(`entries[${i}]: leading must be a positive finite number`);
  const c = style.color;
  if (!Array.isArray(c) || c.length !== 3 ||
      !c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
    throw new TypeError(`entries[${i}]: color must be [r, g, b] with each component in 0..1`);
}

/** @internal Width of `s` in a row's typography, honoring the call's shaping
 *  options. Shared by the number-column sizing here and the dot-width
 *  computation in tocrender.ts, so both agree. */
export function rowMeasure(s: string, style: RowStyle, opts: TOCOptions): number {
  return measureText(s, style.fontSize, style.font, opts.shape, opts.dir, opts.script, opts.language);
}

/** @internal The stamp.ts single-line options for a row. */
export function rowStampOptions(
  style: RowStyle, opts: TOCOptions, align: 'left' | 'right',
): StampOptions {
  return {
    font: style.font, fontSize: style.fontSize, color: style.color, align,
    opacity: opts.opacity, shape: opts.shape, dir: opts.dir,
    script: opts.script, language: opts.language,
  };
}

/** The block options wrapping uses: the row's typography plus its leading. */
function rowBlockOptions(style: RowStyle, opts: TOCOptions): TextBlockOptions {
  return {
    font: style.font, fontSize: style.fontSize, color: style.color, leading: style.leading,
    opacity: opts.opacity, shape: opts.shape, dir: opts.dir,
    script: opts.script, language: opts.language,
  };
}

/** Validate every entry and option, then measure every row against the box.
 *  Throws before returning anything, so a caller that lets this throw has drawn
 *  nothing and allocated nothing. */
export function measureTOC(
  doc: Document, entries: TOCEntry[], rect: [number, number, number, number],
  opts: TOCOptions = {},
): TOCLayout {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  const [x, , w, h] = rect;
  if (w <= 0 || h <= 0) throw new TypeError('rect width and height must be positive');
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');

  const indent = nonNeg(opts.indent, DEFAULT_INDENT, 'indent');
  const rowGap = nonNeg(opts.rowGap, 0, 'rowGap');
  const leaderGap = nonNeg(opts.leaderGap, DEFAULT_LEADER_GAP, 'leaderGap');
  const leader = opts.leader ?? 'dots';
  if (leader !== 'dots' && leader !== 'none')
    throw new TypeError("leader must be 'dots' or 'none'");
  const links = opts.links ?? true;
  const view: OutlineView = opts.view ?? { type: 'Fit' };
  const autoPaginate = opts.autoPaginate ?? false;

  const labels = parsePageLabels(doc);

  // Pass 1 — per-entry validation, style and label. encodeAction is called
  // purely to validate `page` and `view`: it allocates nothing, and it throws
  // the same RangeError the link would throw later, when rows are already
  // painted.
  const pre: { entry: TOCEntry; style: RowStyle; label: string; level: number }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e === null || typeof e !== 'object') throw new TypeError(`entries[${i}] must be an object`);
    if (typeof e.title !== 'string') throw new TypeError(`entries[${i}].title must be a string`);
    if (e.label !== undefined && typeof e.label !== 'string')
      throw new TypeError(`entries[${i}].label must be a string`);
    const level = e.level ?? 1;
    if (!Number.isInteger(level) || level < 1)
      throw new TypeError(`entries[${i}].level must be an integer >= 1`);
    encodeAction(doc, { type: 'goto', page: e.page, view });
    const style = rowStyle(e, opts);
    validateRowStyle(style, i);
    pre.push({ entry: e, style, label: e.label ?? resolvePageLabel(labels, e.page - 1), level });
  }

  // Pass 2 — the number column, sized over EVERY entry rather than only the ones
  // that fit, so an auto-paginated TOC keeps one column x on every page.
  let numberWidth = 0;
  for (const p of pre) numberWidth = Math.max(numberWidth, rowMeasure(p.label, p.style, opts));
  const rowRight = x + w;
  const numberLeft = rowRight - numberWidth;

  // Pass 3 — wrap each title in its own column.
  const rows: MeasuredRow[] = [];
  for (let i = 0; i < pre.length; i++) {
    const p = pre[i];
    const titleLeft = x + (p.level - 1) * indent;
    const titleWidth = numberLeft - leaderGap - titleLeft;
    if (titleWidth <= 0)
      throw new RangeError(
        `entries[${i}]: TOC box too narrow — level ${p.level} leaves no title column ` +
        `(box width ${w}, indent ${indent}, number column ${numberWidth})`);
    const lines = wrapLines(p.entry.title, titleWidth, rowBlockOptions(p.style, opts));
    rows.push({
      entry: p.entry, style: p.style, label: p.label, lines, titleLeft,
      height: Math.max(lines.length, 1) * p.style.leading,
    });
  }

  return { rows, numberLeft, rowRight, rowGap, leader, leaderGap, links, view, autoPaginate };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/toc.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/toc.ts test/toc.test.ts
git commit -m "feat(toc): TOC model, validation and measurement (1gg0.1)"
```

---

### Task 3: `src/tocrender.ts` — painting and manual overflow, wired to `Page.AddTOC`

**Files:**
- Create: `src/tocrender.ts`
- Modify: `src/page.ts` (import block ~line 15-22; new method after `AddTable`, ~line 504)
- Modify: `src/index.ts` (~line 79, beside the table exports)
- Test: `test/toc.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: `measureTOC`, `rowMeasure`, `rowStampOptions`, `TOCEntry`,
  `TOCOptions`, `TOCLayout`, `MeasuredRow` (Task 2); `stampText` from
  `./stamp.js`.
- Produces:
  - `interface AddTOCResult { pages: Page[]; drawn: number; endY: number; remainder?: TOCEntry[] }`
  - `drawTOC(doc: Document, page: Page, entries: TOCEntry[], rect: [number, number, number, number], opts?: TOCOptions): AddTOCResult`
  - `Page.AddTOC(entries, rect, opts?): AddTOCResult`

- [x] **Step 1: Write the failing tests**

Append to `test/toc.test.ts` (the `docWith` helper and `RECT` from Task 2 are
already in scope; add `AddTOCResult` to the `../src/index.js` import):

```ts
describe('TOC rendering — page.AddTOC', () => {
  it('places the title at the box left and the label flush right on one baseline', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Introduction', page: 3 }], RECT, { fontSize: 12, leaderGap: 10 });
    const frags = page.GetTextFragments();
    const title = frags.find((f) => f.text === 'Introduction')!;
    const label = frags.find((f) => f.text === '3')!;
    const baseline = 400 + 300 - 12;                 // boxTop - fontSize
    expect(title.quad[0]).toBeCloseTo(72, 3);
    expect(title.quad[1]).toBeCloseTo(baseline, 3);
    expect(label.quad[2]).toBeCloseTo(472, 1);       // right-flush at x + w
    expect(label.quad[1]).toBeCloseTo(baseline, 3);
  });

  it('dot leaders from titles of different lengths end at the same x', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([
      { title: 'Short', page: 1 },
      { title: 'A considerably longer chapter title', page: 2 },
    ], RECT, { fontSize: 12, leaderGap: 10 });
    const dots = page.GetTextFragments().filter((f) => /^\.+$/.test(f.text));
    expect(dots).toHaveLength(2);
    expect(dots[0].quad[2]).toBeCloseTo(dots[1].quad[2], 1);
    expect(dots[0].text.length).not.toBe(dots[1].text.length);
  });

  it('draws no leader when the gap is narrower than one dot, or when leader is none', () => {
    const fontSize = 12, leaderGap = 4;
    const w = measureText('Chapter', fontSize, 'Helvetica') + leaderGap * 2
      + measureText('1', fontSize, 'Helvetica');
    const tight = docWith(1).Pages[0];
    tight.AddTOC([{ title: 'Chapter', page: 1 }], [72, 400, w, 300], { fontSize, leaderGap });
    expect(tight.GetTextFragments().some((f) => f.text.includes('.'))).toBe(false);

    const off = docWith(1).Pages[0];
    off.AddTOC([{ title: 'Chapter', page: 1 }], RECT, { fontSize, leader: 'none' });
    expect(off.GetTextFragments().some((f) => f.text.includes('.'))).toBe(false);
  });

  it('a wrapped title makes the row taller and keeps the label on its last line', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const long = 'A chapter title long enough to need two lines in this narrow box';
    page.AddTOC([{ title: long, page: 1 }, { title: 'Next', page: 1 }],
      [72, 400, 200, 300], { fontSize: 10, leaderGap: 8 });
    const frags = page.GetTextFragments();
    const leading = 12;                              // 1.2 * 10
    const firstBaseline = 400 + 300 - 10;
    const next = frags.find((f) => f.text === 'Next')!;
    // Two title lines were drawn, so the following row starts two leadings down.
    expect(next.quad[1]).toBeCloseTo(firstBaseline - 2 * leading, 3);
    // Both labels sit on their row's LAST line.
    const labels = frags.filter((f) => f.text === '1');
    expect(labels.some((f) => Math.abs(f.quad[1] - (firstBaseline - leading)) < 0.01)).toBe(true);
  });

  it('indents a nested row by (level - 1) * indent', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Nested', page: 1, level: 2 }], RECT,
      { fontSize: 12, indent: 20, leaderGap: 10 });
    const title = page.GetTextFragments().find((f) => f.text === 'Nested')!;
    expect(title.quad[0]).toBeCloseTo(92, 3);
  });

  it('returns the rows that did not fit as a remainder of the caller\'s own objects', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const entries = [
      { title: 'One', page: 1 }, { title: 'Two', page: 2 }, { title: 'Three', page: 3 },
    ];
    const leading = 14.4;                            // 1.2 * 12
    const r: AddTOCResult = page.AddTOC(entries, [72, 700, 400, leading * 2], { fontSize: 12 });
    expect(r.drawn).toBe(2);
    expect(r.pages).toEqual([page]);
    expect(r.remainder).toHaveLength(1);
    expect(r.remainder![0]).toBe(entries[2]);        // same object: re-callable as-is
    expect(r.endY).toBeCloseTo(700, 3);              // bottom of the last drawn row
    expect(page.GetTextFragments().some((f) => f.text.includes('Three'))).toBe(false);
  });

  it('draws a row taller than the whole box exactly once rather than looping', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const long = 'word '.repeat(40).trim();
    const r = page.AddTOC([{ title: long, page: 1 }, { title: 'After', page: 1 }],
      [72, 400, 200, 20], { fontSize: 10 });
    expect(r.drawn).toBe(1);
    expect(r.remainder).toHaveLength(1);
    expect(page.GetTextFragments().some((f) => f.text.includes('word'))).toBe(true);
  });

  it('an empty entry list draws nothing', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const r = page.AddTOC([], RECT);
    expect(r).toEqual({ pages: [page], drawn: 0, endY: 700 });
    expect(page.GetTextFragments()).toEqual([]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/toc.test.ts`
Expected: FAIL — `page.AddTOC is not a function`.

- [x] **Step 3a: Create `src/tocrender.ts`**

```ts
// Table-of-contents painting and pagination (issue 1gg0.1). No new rendering
// primitives: titles, leaders and labels go through stampText (stamp.ts) and
// links through addLink (annotation.ts). The model and all validation live in
// toc.ts, which measureTOC runs to completion before anything is painted.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { stampText } from './stamp.js';
import {
  measureTOC, rowMeasure, rowStampOptions,
  type MeasuredRow, type TOCEntry, type TOCLayout, type TOCOptions,
} from './toc.js';

// Tolerance so a box exactly n rows tall fits n rows despite float drift, as in
// layout.ts.
const EPS = 1e-9;

/** The outcome of {@link drawTOC} / `page.AddTOC`. */
export interface AddTOCResult {
  /** Pages drawn onto, anchor first; length > 1 only in auto mode. */
  pages: Page[];
  /** Entries fully drawn, across all pages. */
  drawn: number;
  /** y of the bottom of the last drawn row on the last page, excluding any
   *  trailing rowGap; the box top when nothing was drawn. */
  endY: number;
  /** Entries that did not fit — a slice of the caller's array, so the same
   *  objects can be passed straight back. Manual mode only; undefined when
   *  everything was drawn. */
  remainder?: TOCEntry[];
}

/** Paint one measured row with its top edge at `rowTop`. */
function paintRow(
  doc: Document, page: Page, row: MeasuredRow, L: TOCLayout, opts: TOCOptions, rowTop: number,
): void {
  const { style } = row;
  const left = rowStampOptions(style, opts, 'left');
  const right = rowStampOptions(style, opts, 'right');

  for (let i = 0; i < row.lines.length; i++)
    stampText(doc, page, row.lines[i].text, row.titleLeft,
      rowTop - i * style.leading - style.fontSize, left);

  // An empty title draws no line but still occupies one, so the label sits on
  // the same baseline it would have had.
  const lineCount = Math.max(row.lines.length, 1);
  const lastBaseline = rowTop - (lineCount - 1) * style.leading - style.fontSize;

  if (L.leader === 'dots') {
    const last = row.lines[row.lines.length - 1];
    const lastEnd = row.titleLeft + (last ? last.width : 0);
    const gap = (L.numberLeft - L.leaderGap) - (lastEnd + L.leaderGap);
    const dotWidth = rowMeasure('.', style, opts);
    const count = dotWidth > 0 ? Math.floor(gap / dotWidth) : 0;
    // Right-aligned against the number column so the dot runs line up vertically
    // across rows however long the titles are — left-aligning leaves them ragged
    // exactly where the eye follows them.
    if (count > 0)
      stampText(doc, page, '.'.repeat(count), L.numberLeft - L.leaderGap, lastBaseline, right);
  }

  stampText(doc, page, row.label, L.rowRight, lastBaseline, right);
}

/** Render `entries` as a table of contents into `rect` = [x, y, w, h] on `page`.
 *  Existing content is preserved. */
export function drawTOC(
  doc: Document, page: Page, entries: TOCEntry[], rect: [number, number, number, number],
  opts: TOCOptions = {},
): AddTOCResult {
  const L = measureTOC(doc, entries, rect, opts);   // validates everything; draws nothing
  const [, y, , h] = rect;
  const boxTop = y + h;
  const boxBottom = y;
  if (L.rows.length === 0) return { pages: [page], drawn: 0, endY: boxTop };

  let rowTop = boxTop;
  let drawn = 0;

  for (let i = 0; i < L.rows.length; i++) {
    const row = L.rows[i];
    // A row is atomic: a wrapped title never splits across pages, which keeps
    // exactly one link rect per entry. A row taller than an EMPTY box is drawn
    // anyway and overflows the bottom — the same choice layoutText makes for a
    // word wider than its box, and what stops the caller's remainder loop from
    // spinning.
    if (rowTop - row.height < boxBottom - EPS && drawn > 0)
      return { pages: [page], drawn, endY: rowTop + L.rowGap, remainder: entries.slice(i) };
    paintRow(doc, page, row, L, opts, rowTop);
    drawn++;
    rowTop -= row.height + L.rowGap;
  }
  return { pages: [page], drawn, endY: rowTop + L.rowGap };
}
```

- [x] **Step 3b: Wire `Page.AddTOC`**

In `src/page.ts`, add to the imports (beside the `tablerender` import at line 15):

```ts
import { drawTOC, AddTOCResult } from './tocrender.js';
import type { TOCEntry, TOCOptions } from './toc.js';
```

and add the method immediately after `AddTable` (~line 504):

```ts
  /** Render `entries` as a table of contents into `rect` = [x, y, w, h]: wrapped
   *  titles indented by `level`, dot leaders, right-aligned page labels
   *  (defaulting to each target page's logical /PageLabels label), and a
   *  borderless GoTo link over each row. A too-long TOC is drawn down to the box
   *  bottom and the undrawn entries come back as `result.remainder` (re-draw with
   *  a fresh `AddTOC`); pass `{ autoPaginate: true }` to append pages
   *  automatically. Existing content is preserved. */
  AddTOC(
    entries: TOCEntry[], rect: [number, number, number, number], opts?: TOCOptions,
  ): AddTOCResult {
    return drawTOC(this.doc, this, entries, rect, opts);
  }
```

- [x] **Step 3c: Export the public types**

In `src/index.ts`, beside the table exports (~line 79):

```ts
export type { TOCEntry, TOCOptions } from './toc.js';
export type { AddTOCResult } from './tocrender.js';
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/toc.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/tocrender.ts src/page.ts src/index.ts test/toc.test.ts
git commit -m "feat(toc): page.AddTOC renders rows, leaders and labels (1gg0.1)"
```

---

### Task 4: GoTo links

**Files:**
- Modify: `src/tocrender.ts` (`paintRow`)
- Test: `test/toc.test.ts` (append a third `describe`)

**Interfaces:**
- Consumes: `addLink`, `LinkAnnotation` from `./annotation.js`; `L.links`,
  `L.view` already on `TOCLayout` (Task 2).
- Produces: no new exported symbols — one `/Link` annotation per drawn row.

- [x] **Step 1: Write the failing tests**

Append to `test/toc.test.ts` (add `LinkAnnotation` to the `../src/index.js`
import):

```ts
describe('TOC links', () => {
  it('adds one borderless GoTo link per row, covering all its lines', () => {
    const doc = docWith(4);
    const page = doc.Pages[0];
    const long = 'A chapter title long enough to need two lines in this narrow box';
    page.AddTOC([{ title: long, page: 4 }], [72, 400, 200, 300], { fontSize: 10 });
    const links = page.Annotations.filter((a) => a.Subtype === 'Link') as LinkAnnotation[];
    expect(links).toHaveLength(1);
    expect(links[0].Action).toEqual({ type: 'goto', page: 4, view: { type: 'Fit' } });
    const [llx, lly, urx, ury] = links[0].Rect!;
    expect(llx).toBeCloseTo(72, 3);
    expect(urx).toBeCloseTo(272, 3);
    expect(ury).toBeCloseTo(700, 3);                 // box top
    expect(ury - lly).toBeCloseTo(24, 3);            // two lines * 1.2 * 10
    expect(links[0].Dict.get('Border')).toEqual([0, 0, 0]);
  });

  it('starts the link at the indent, not the box edge', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Nested', page: 2, level: 2 }], RECT, { fontSize: 12, indent: 20 });
    const link = page.Annotations.find((a) => a.Subtype === 'Link') as LinkAnnotation;
    expect(link.Rect![0]).toBeCloseTo(92, 3);
  });

  it('honors an explicit destination view', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Ch', page: 2 }], RECT, { view: { type: 'XYZ', left: 0, top: 792, zoom: null } });
    const link = page.Annotations.find((a) => a.Subtype === 'Link') as LinkAnnotation;
    expect(link.Action).toEqual({ type: 'goto', page: 2, view: { type: 'XYZ', left: 0, top: 792, zoom: null } });
  });

  it('adds no annotations at all with links: false', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Ch', page: 2 }], RECT, { links: false });
    expect(page.Annotations).toEqual([]);
    expect(page.GetTextFragments().length).toBeGreaterThan(0);   // still drawn
  });

  it('links only the rows that were actually drawn', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const entries = [
      { title: 'One', page: 1 }, { title: 'Two', page: 2 }, { title: 'Three', page: 3 },
    ];
    page.AddTOC(entries, [72, 700, 400, 14.4 * 2], { fontSize: 12 });
    expect(page.Annotations.filter((a) => a.Subtype === 'Link')).toHaveLength(2);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/toc.test.ts -t "TOC links"`
Expected: FAIL — `expected [] to have a length of 1` (no links are created yet).

- [x] **Step 3: Add the link to `paintRow`**

In `src/tocrender.ts`, extend the import:

```ts
import { addLink } from './annotation.js';
```

and append to `paintRow`, after the label `stampText`:

```ts
  if (L.links)
    addLink(doc, page, {
      rect: [row.titleLeft, rowTop - row.height, L.rowRight, rowTop],
      action: { type: 'goto', page: row.entry.page, view: L.view },
      border: 0,
    });
```

The rect starts at `titleLeft`, not the box edge, so a nested row's indent is not
clickable, and spans `row.height` so every line of a wrapped title is.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/toc.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/tocrender.ts test/toc.test.ts
git commit -m "feat(toc): borderless GoTo link per TOC row (1gg0.1)"
```

---

### Task 5: `autoPaginate`

**Files:**
- Modify: `src/tocrender.ts` (`drawTOC` loop)
- Test: `test/toc.test.ts` (append a fourth `describe`)

**Interfaces:**
- Consumes: `L.autoPaginate` (Task 2); `doc.AddPage()` returning
  `{ page: Page; number: number }`; `page.MediaBox`.
- Produces: no new exported symbols — `AddTOCResult.pages` gains entries.

- [x] **Step 1: Write the failing tests**

Append to `test/toc.test.ts`:

```ts
describe('TOC pagination — autoPaginate', () => {
  it('appends pages sized to the anchor and draws every entry', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const entries = Array.from({ length: 5 }, (_, i) => ({ title: `Chapter ${i + 1}`, page: 1 }));
    const leading = 14.4;                            // 1.2 * 12
    const r = page.AddTOC(entries, [72, 700, 400, leading * 2], {
      fontSize: 12, autoPaginate: true,
    });
    expect(r.drawn).toBe(5);
    expect(r.remainder).toBeUndefined();
    expect(r.pages).toHaveLength(3);                 // 2 + 2 + 1
    expect(r.pages[0]).toBe(page);
    for (const p of r.pages) expect(p.MediaBox).toEqual([0, 0, 612, 792]);
    expect(r.pages[1].GetTextFragments().some((f) => f.text.includes('Chapter 3'))).toBe(true);
    expect(r.pages[2].GetTextFragments().some((f) => f.text.includes('Chapter 5'))).toBe(true);
    expect(r.endY).toBeCloseTo(700 + leading * 2 - leading, 3);  // one row on the last page
  });

  it('keeps the number column at the same x on every page', () => {
    const doc = docWith(200);
    const page = doc.Pages[0];
    const entries = [
      { title: 'First', page: 1 }, { title: 'Second', page: 2 }, { title: 'Third', page: 200 },
    ];
    const r = page.AddTOC(entries, [72, 700, 400, 14.4], { fontSize: 12, autoPaginate: true });
    expect(r.pages).toHaveLength(3);
    const rightEdge = (p: typeof page, text: string) =>
      p.GetTextFragments().find((f) => f.text.endsWith(text))!.quad[2];
    // The '200' label is the widest, so it sets the column for pages 1 and 2 too.
    expect(rightEdge(r.pages[0], '1')).toBeCloseTo(rightEdge(r.pages[2], '200'), 1);
  });

  it('links on a continuation page point at the right target', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const r = page.AddTOC([{ title: 'A', page: 2 }, { title: 'B', page: 3 }],
      [72, 700, 400, 14.4], { fontSize: 12, autoPaginate: true });
    const link = r.pages[1].Annotations.find((a) => a.Subtype === 'Link') as LinkAnnotation;
    expect(link.Action).toEqual({ type: 'goto', page: 3, view: { type: 'Fit' } });
  });

  it('terminates when a row is taller than a whole page box', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const long = 'word '.repeat(40).trim();
    const r = page.AddTOC([{ title: long, page: 1 }, { title: long, page: 1 }],
      [72, 400, 200, 20], { fontSize: 10, autoPaginate: true });
    expect(r.drawn).toBe(2);
    expect(r.pages).toHaveLength(2);                 // one over-tall row per page
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/toc.test.ts -t autoPaginate`
Expected: FAIL — `expected 2 to be 5` (manual mode still returns a remainder).

- [x] **Step 3: Add the pagination branch**

In `src/tocrender.ts`, replace everything in `drawTOC` from `let rowTop = boxTop;`
to the end of the function (the loop and its trailing `return`) with the block
below. The lines above it — the `measureTOC` call, the `rect` destructuring,
`boxTop`/`boxBottom`, and the `L.rows.length === 0` early return — stay as they
are.

```ts
  const anchorMediaBox = page.MediaBox;
  const pages: Page[] = [page];
  let current = page;
  let rowTop = boxTop;
  let drawn = 0;
  let rowsOnPage = 0;

  for (let i = 0; i < L.rows.length; i++) {
    const row = L.rows[i];
    // A row is atomic: a wrapped title never splits across pages, which keeps
    // exactly one link rect per entry. The test is rowsOnPage, not drawn: after
    // a page break an over-tall row must be drawn on the fresh page rather than
    // triggering another break, or auto mode appends pages forever. A row taller
    // than an EMPTY box therefore overflows the bottom — the same choice
    // layoutText makes for a word wider than its box.
    if (rowTop - row.height < boxBottom - EPS && rowsOnPage > 0) {
      if (!L.autoPaginate)
        return { pages, drawn, endY: rowTop + L.rowGap, remainder: entries.slice(i) };
      // Append a page sized to the anchor and reuse the same box on it.
      current = doc.AddPage().page;
      current.MediaBox = [...anchorMediaBox];
      pages.push(current);
      rowTop = boxTop;
      rowsOnPage = 0;
      i--;                                   // retry this row on the fresh page
      continue;
    }
    paintRow(doc, current, row, L, opts, rowTop);
    drawn++;
    rowsOnPage++;
    rowTop -= row.height + L.rowGap;
  }
  return { pages, drawn, endY: rowTop + L.rowGap };
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/toc.test.ts && npm run typecheck`
Expected: PASS (all four describes), typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/tocrender.ts test/toc.test.ts
git commit -m "feat(toc): autoPaginate appends pages until every entry is drawn (1gg0.1)"
```

---

### Task 6: Atomicity proof, docs, and close-out

**Files:**
- Test: `test/toc.test.ts` (append a fifth `describe`)
- Modify: `README.md` (authoring section, beside `AddTable` / `AddBarcode`)

**Interfaces:**
- Consumes: everything from Tasks 1-5. Adds no source symbols.

- [x] **Step 1: Write the failing test**

Append to `test/toc.test.ts`:

```ts
describe('TOC atomicity', () => {
  it('leaves the document byte-identical when a call is rejected', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const before = doc.Save();
    const bad: [() => unknown, ErrorConstructor][] = [
      [() => page.AddTOC([{ title: 'Ch', page: 99 }], RECT), RangeError],
      [() => page.AddTOC([{ title: 'A', page: 1 }, { title: 'B', page: 0 }], RECT), RangeError],
      [() => page.AddTOC([{ title: 'Deep', page: 1, level: 9 }], [72, 400, 60, 300]), RangeError],
      [() => page.AddTOC([{ title: 'Ch', page: 1 }], RECT, { fontSize: 0 }), TypeError],
      [() => page.AddTOC([{ title: 'Ch', page: 1 }], RECT, { leaderGap: -2 }), TypeError],
    ];
    for (const [call, err] of bad) {
      expect(call).toThrow(err);
      expect(doc.Save()).toEqual(before);
      expect(page.Annotations).toEqual([]);
      expect(page.GetTextFragments()).toEqual([]);
    }
  });

  it('a second entry rejected after a valid first draws nothing at all', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    expect(() => page.AddTOC(
      [{ title: 'Valid', page: 1 }, { title: 'Bad', page: 77 }], RECT)).toThrow(RangeError);
    expect(page.GetTextFragments()).toEqual([]);
  });
});
```

- [x] **Step 2: Run the test**

Run: `npx vitest run test/toc.test.ts -t atomicity`
Expected: PASS on the first run, because `measureTOC` validates everything before
`drawTOC` paints. **Do not accept that at face value** — this repo's rule is that
a green-on-first-run test must be proved load-bearing. Temporarily move the
`encodeAction(doc, ...)` validation call out of `measureTOC`'s pass 1 and into
`paintRow` (as `addLink` would throw it), re-run, and confirm the test goes RED.
Then restore the code and confirm GREEN again.

- [x] **Step 3: Document the API in README.md**

Find the authoring section listing `AddText` / `AddTextBlock` / `AddTable` /
`AddBarcode` and add an `AddTOC` entry in the same style as its neighbours:

```markdown
- **`page.AddTOC(entries, [x, y, w, h], opts?)`** — render a table of contents:
  wrapped titles (indented by `level`), dot leaders, right-aligned page labels
  (defaulting to each target page's logical `/PageLabels` label), and a
  borderless GoTo link per row. Entries that do not fit come back as
  `result.remainder` for a follow-on call, or pass `{ autoPaginate: true }` to
  append pages automatically.

  ```ts
  const { remainder } = page.AddTOC([
    { title: 'Introduction', page: 3 },
    { title: 'Scope', page: 4, level: 2 },
    { title: 'Results', page: 12, style: { fontSize: 14 } },
  ], [72, 100, 450, 600], { fontSize: 12, rowGap: 4 });
  ```
```

- [x] **Step 4: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: both green. The full suite matters here: `Page` gained a method and
`stamp.ts` gained an export, so stamp/table/flow suites must stay green.

- [x] **Step 5: Commit and close the issue**

```bash
git add test/toc.test.ts README.md
git commit -m "test(toc): atomicity proof; docs(toc): README AddTOC (1gg0.1)"
bd close aspose-pdf-foss-for-ts-1gg0.1
git pull --rebase && git push && git status
```

Then file the follow-up the spec deferred:

```bash
bd create "Tag a generated TOC as /TOC + /TOCI structure" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "page.AddTOC draws untagged content. A tagged PDF wants the TOC as a /TOC element with one /TOCI (with /Reference) per row, which needs structwrite.ts and a tag option on TOCOptions. Deferred from 1gg0.1; see docs/superpowers/specs/2026-07-27-toc-page-generation-design.md."
```

---

## Notes for the implementer

- **Do not add `wrapLines` to `index.ts`.** It is `@internal`; the public surface
  is `TOCEntry`, `TOCOptions`, `AddTOCResult` and `Page.AddTOC`.
- **`measureTOC` takes the `Document`** only to read `/PageLabels` and to validate
  page numbers. It must never mutate it — that is what makes the atomicity test in
  Task 6 pass.
- **Float comparisons in tests** use `toBeCloseTo` with 3 digits for positions
  computed from the same arithmetic, and 1 digit where a value round-trips through
  AFM glyph advances (`quad[2]` of a right-aligned run).
- **The byte-identical assertion** in Task 6 compares whole `Save()` outputs.
  Nothing in `Save` stamps a timestamp (there is no auto `/ModDate`), so it is
  deterministic. If it nonetheless proves flaky for a reason unrelated to this
  feature, fall back to `expect(doc.Save().length).toBe(before.length)`, which is
  what test/form-create.test.ts does — but investigate before weakening it.
- **`rowGap` and `endY`:** after each drawn row the cursor moves by
  `height + rowGap`, so `endY = rowTop + rowGap` recovers the bottom of the last
  row without the trailing gap. Both `return` sites use that same expression.
