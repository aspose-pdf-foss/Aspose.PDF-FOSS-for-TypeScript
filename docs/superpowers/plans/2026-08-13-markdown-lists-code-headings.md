# PDF→Markdown lists, code blocks and heading inference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export nested lists, code blocks and block quotes to Markdown from both a tagged structure tree and untagged page geometry, and promote body-size lines to headings on three corroborated signals.

**Architecture:** `docmodel.ts` grows three node kinds (`DocList`, `DocListItem`, `DocCode`) and folds `/L`+`/LI`+`/Lbl`+`/LBody` and `/P`>`/Code` into them; a new pure `src/docinfer.ts` holds every untagged heuristic as functions over `TextLine[]` with no `Document` in sight; `mdexport.ts` and `htmlsemantic.ts` gain one serialization rule per construct and no analysis of their own.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-markdown-lists-code-headings-design.md` — read it before Task 1; every invariant cited below is stated there in full.

**Issue:** `aspose-pdf-foss-for-ts-no93.2` (already claimed). Track work with `bd`, never TodoWrite or markdown TODO lists.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension (`import { x } from './text.js'`).
- **`src/docinfer.ts` imports types only** — `import type { TextFragment, TextLine, TextBlock } from './text.js'` plus the value import `dominantFragmentSize` from `./textrank.js`. It must never import `document.js`, `page.js` or any PDF object module. That is the whole reason it exists.
- **`npm run typecheck` and `npm test` must both be green** before the issue is closed.
- Commit after every task. End each commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Never regenerate `test/html-identity.test.ts` snapshots with `vitest -u`. New snapshots are added by writing new cases; existing ones moving is a defect, not a refresh.
- Per CLAUDE.md, a new assertion passing on the first run is not evidence. Task 11 breaks each new path and confirms red.

## File Structure

| File | Responsibility |
|---|---|
| `src/docinfer.ts` (new) | Pure untagged heuristics: marker grammar, content x, code-line test, page metrics, per-block line classification |
| `test/docinfer.test.ts` (new) | Drives the above from hand-built `TextLine`s — no PDF anywhere |
| `src/docmodel.ts` | The three new node kinds; tagged `/L`,`/LI`,`/Lbl`,`/LBody`,`/Code` mapping; untagged classification wiring |
| `src/mdexport.ts` | List, code and quote serialization |
| `src/htmlsemantic.ts` | The same four constructs as HTML |
| `test/docmodel.test.ts` | Model-level assertions for the tagged mapping |
| `test/markdown-export.test.ts` | Markdown output per construct |
| `test/markdown-roundtrip.test.ts` | The tagged and untagged round trips |
| `test/html-identity.test.ts` | New snapshots; existing ones must not move |
| `README.md`, `CLAUDE.md` | Public coverage and the recorded invariants |

---

### Task 1: The marker grammar

**Files:**
- Create: `src/docinfer.ts`
- Test: `test/docinfer.test.ts`

**Interfaces:**
- Consumes: `TextLine`, `TextFragment` from `src/text.ts`.
- Produces: `Marker` (`{ ordered: boolean; ordinal?: number; checked?: boolean }`), `parseMarkerText(s: string): { marker: Marker; length: number } | undefined`, `LineMarker` (`Marker & { textStart: number; markerX: number; bodyX: number }`), `markerOf(line: TextLine): LineMarker | undefined`, `contentX(line: TextLine, textStart: number): number`.

- [ ] **Step 1: Write the failing test**

Create `test/docinfer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { markerOf, parseMarkerText } from '../src/docinfer.js';
import type { TextFragment, TextLine } from '../src/text.js';

/** A fragment at x0..x1 on baseline y. */
export function frag(
  text: string, x0: number, x1: number, y = 100, fontSize = 10, fontName = 'Helvetica',
): TextFragment {
  return { text, quad: [x0, y, x1, y + fontSize], fontSize, fontName };
}

/** A line from fragments; its quad is their bounding box and its text their
 *  concatenation, which is what assembleLines produces for ungapped runs. */
export function line(...fragments: TextFragment[]): TextLine {
  return {
    text: fragments.map((f) => f.text).join(''),
    quad: [
      Math.min(...fragments.map((f) => f.quad[0])), Math.min(...fragments.map((f) => f.quad[1])),
      Math.max(...fragments.map((f) => f.quad[2])), Math.max(...fragments.map((f) => f.quad[3])),
    ],
    fragments,
  };
}

describe('docinfer — the marker grammar', () => {
  it('reads every bullet character as an unordered marker', () => {
    for (const b of ['•', '◦', '▪', '‣', '-', '*', '+']) {
      const m = parseMarkerText(`${b} item`);
      expect(m, b).toBeDefined();
      expect(m!.marker.ordered).toBe(false);
      expect(m!.length).toBe(2);
    }
  });

  it('reads decimal, parenthesized, roman and alpha ordinals', () => {
    expect(parseMarkerText('1. a')!.marker).toEqual({ ordered: true, ordinal: 1 });
    expect(parseMarkerText('(3) a')!.marker).toEqual({ ordered: true, ordinal: 3 });
    expect(parseMarkerText('iv. a')!.marker).toEqual({ ordered: true });
    expect(parseMarkerText('b) a')!.marker).toEqual({ ordered: true });
  });

  it('reads the two task boxes', () => {
    expect(parseMarkerText('☐ todo')!.marker).toEqual({ ordered: false, checked: false });
    expect(parseMarkerText('☑ done')!.marker).toEqual({ ordered: false, checked: true });
  });

  it('accepts a marker with nothing after it — an empty item is legitimate', () => {
    expect(parseMarkerText('-')).toBeDefined();
    expect(parseMarkerText('1.')!.marker.ordinal).toBe(1);
  });

  it('rejects a word that merely starts with a marker character', () => {
    expect(parseMarkerText('*emphasis* here')).toBeUndefined();  // no space after
    expect(parseMarkerText('nothing here')).toBeUndefined();
  });

  it('takes bodyX from the fragment boundary when the marker is its own stamp', () => {
    const m = markerOf(line(frag('•', 50, 56), frag('item', 65, 90)));
    expect(m!.markerX).toBe(50);
    expect(m!.bodyX).toBe(65);
  });

  it('interpolates bodyX inside a single fragment', () => {
    // '- item' across 50..110: 6 chars, so the body starts 2/6 of the way in.
    const m = markerOf(line(frag('- item', 50, 110)));
    expect(m!.bodyX).toBeCloseTo(70, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docinfer.test.ts`
Expected: FAIL — `Failed to resolve import "../src/docinfer.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/docinfer.ts`:

```ts
/** Untagged document-shape heuristics: what a line looks like on the page.
 *
 *  Pure by design. It takes positioned lines and returns classifications, so
 *  every bullet character, nesting tolerance and heading rule is testable
 *  without building a PDF — the split floatstack.ts and booklet.ts already make
 *  against the modules that draw. Nothing here may import a Document.
 *
 *  **Invariant:** the marker grammar has ONE owner, `parseMarkerText`. The
 *  tagged path parses a /Lbl's text with it and the untagged path parses a
 *  line's opening with it; two grammars is how an export comes to read `(3)` as
 *  a list in one document and as prose in the other. */

import type { TextFragment, TextLine } from './text.js';
import { dominantFragmentSize } from './textrank.js';

/** What a marker proves about its item. */
export interface Marker {
  ordered: boolean;
  /** Decimal value only. A roman or alphabetic ordinal is ordered but carries no
   *  number: `start` would have to invent one, and CommonMark's `start` is
   *  decimal regardless. */
  ordinal?: number;
  /** A task-list box's state. Absent for an ordinary item. */
  checked?: boolean;
}

const BULLET = /^[•◦▪‣·–—*+-](?:\s+|$)/;
const TASK = /^([☐☑])(?:\s+|$)/;
const ORDINAL = /^\(?(\d{1,9}|[ivxlcdm]{1,7}|[IVXLCDM]{1,7}|[a-zA-Z])[.)](?:\s+|$)/;

/** The marker opening `s`, with the length of the marker and the space after it.
 *  Undefined when `s` does not open an item. */
export function parseMarkerText(s: string): { marker: Marker; length: number } | undefined {
  const task = TASK.exec(s);
  if (task) return { marker: { ordered: false, checked: task[1] === '☑' }, length: task[0].length };
  const bullet = BULLET.exec(s);
  if (bullet) return { marker: { ordered: false }, length: bullet[0].length };
  const ord = ORDINAL.exec(s);
  if (ord) {
    const marker: Marker = { ordered: true };
    if (/^\d+$/.test(ord[1])) marker.ordinal = Number(ord[1]);
    return { marker, length: ord[0].length };
  }
  return undefined;
}

/** A marker found on a positioned line, with the geometry nesting needs. */
export interface LineMarker extends Marker {
  /** Index into `line.text` where the item's own content begins. */
  textStart: number;
  /** Page-space x of the line's left edge — the marker's own x. */
  markerX: number;
  /** Page-space x where the content begins — the item's body indent. */
  bodyX: number;
}

export function markerOf(line: TextLine): LineMarker | undefined {
  const hit = parseMarkerText(line.text);
  if (!hit) return undefined;
  return {
    ...hit.marker,
    textStart: hit.length,
    markerX: line.quad[0],
    bodyX: contentX(line, hit.length),
  };
}

/** Page-space x of the character at `textStart`.
 *
 *  A fragment boundary is preferred over interpolation because it is exact and
 *  because it is the shape our own lists produce — flow.ts stamps the marker
 *  separately from the body. `assembleLines` may synthesize a space between
 *  gapped fragments, which shifts text indices without touching fragment order,
 *  so the boundary is allowed one character of slack. A line whose marker and
 *  body share one fragment falls back to interpolating within it. */
export function contentX(line: TextLine, textStart: number): number {
  let seen = 0;
  for (const f of line.fragments) {
    if (f.text.trim() !== '' && seen >= textStart - 1) return f.quad[0];
    seen += f.text.length;
  }
  const f = line.fragments[0];
  if (!f) return line.quad[0];
  const len = f.text.length;
  if (len === 0) return f.quad[0];
  return f.quad[0] + (f.quad[2] - f.quad[0]) * (Math.min(textStart, len) / len);
}
```

Note the unused `TextFragment` and `dominantFragmentSize` imports are consumed by Tasks 2 and 3; if the linter objects at this point, add them in the task that first uses them instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docinfer.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/docinfer.ts test/docinfer.test.ts
git commit -m "feat(docinfer): the list-marker grammar, shared by both export paths"
```

---

### Task 2: Code lines and page metrics

**Files:**
- Modify: `src/docinfer.ts`
- Test: `test/docinfer.test.ts`

**Interfaces:**
- Produces: `isCodeLine(line: TextLine): boolean`, `PageMetrics` (`{ columnWidth: number; leading: number }`), `pageMetrics(blocks: TextBlock[], bodySize: number): PageMetrics`.

- [ ] **Step 1: Write the failing test**

Append to `test/docinfer.test.ts`:

```ts
import { isCodeLine, pageMetrics } from '../src/docinfer.js';
import type { TextBlock } from '../src/text.js';

const block = (...lines: TextLine[]): TextBlock => ({
  text: lines.map((l) => l.text).join('\n'),
  quad: [
    Math.min(...lines.map((l) => l.quad[0])), Math.min(...lines.map((l) => l.quad[1])),
    Math.max(...lines.map((l) => l.quad[2])), Math.max(...lines.map((l) => l.quad[3])),
  ],
  lines,
});

describe('docinfer — code lines', () => {
  it('accepts a line set entirely in a monospaced face', () => {
    expect(isCodeLine(line(frag('const x = 1;', 50, 130, 100, 9, 'Courier')))).toBe(true);
    expect(isCodeLine(line(frag('x', 50, 60, 100, 9, 'DejaVuSansMono')))).toBe(true);
  });

  it('strips a subset prefix before testing the name', () => {
    expect(isCodeLine(line(frag('x', 50, 60, 100, 9, 'ABCDEF+Courier-Bold')))).toBe(true);
  });

  it('rejects a line where any fragment is proportional', () => {
    expect(isCodeLine(line(
      frag('const ', 50, 80, 100, 9, 'Courier'),
      frag('x', 80, 90, 100, 9, 'Helvetica'),
    ))).toBe(false);
  });

  it('rejects a line whose font has no name at all', () => {
    const f = frag('x', 50, 60);
    delete (f as { fontName?: string }).fontName;
    expect(isCodeLine(line(f))).toBe(false);
  });
});

describe('docinfer — page metrics', () => {
  it('takes the column width from the widest line and leading from the median gap', () => {
    const m = pageMetrics([block(
      line(frag('a wide line of body text', 50, 250)),
      line(frag('short', 50, 90, 88)),
      line(frag('short', 50, 90, 76)),
    )], 10);
    expect(m.columnWidth).toBe(200);
    expect(m.leading).toBe(12);
  });

  it('falls back to 1.2x the body size when no block has two lines', () => {
    expect(pageMetrics([block(line(frag('only', 50, 90)))], 10).leading).toBeCloseTo(12, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docinfer.test.ts`
Expected: FAIL — `isCodeLine is not exported` / `pageMetrics is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/docinfer.ts`:

```ts
/** A face name naming a monospaced family. Deliberately a NAME test rather than
 *  an advance-width test: a code block set in one glyph per Tj gives no run to
 *  measure, and a name is what every producer of code listings supplies. */
const MONO = /courier|mono/i;

/** '/ABCDEF+Courier-Bold' -> 'Courier-Bold'. */
function baseName(name: string): string {
  return /^[A-Z]{6}\+/.test(name) ? name.slice(7) : name;
}

/** True when EVERY fragment on the line is set in a monospaced face. Every, not
 *  some: one proportional word means the line is prose that quotes an
 *  identifier, which is an inline code span and not a code block. */
export function isCodeLine(line: TextLine): boolean {
  if (line.fragments.length === 0) return false;
  return line.fragments.every(
    (f: TextFragment) => f.fontName !== undefined && MONO.test(baseName(f.fontName)));
}

/** Page-level measurements the line rules need. Passed in rather than derived
 *  per line, so a heading's "short" is measured against the page's column and
 *  not against its own block. */
export interface PageMetrics {
  /** The widest line on the page, excluding table regions. */
  columnWidth: number;
  /** Median baseline-to-baseline distance between consecutive lines. */
  leading: number;
}

export function pageMetrics(blocks: TextBlock[], bodySize: number): PageMetrics {
  let columnWidth = 0;
  const gaps: number[] = [];
  for (const b of blocks) {
    for (const l of b.lines) columnWidth = Math.max(columnWidth, l.quad[2] - l.quad[0]);
    for (let i = 1; i < b.lines.length; i++) {
      const gap = b.lines[i - 1].quad[1] - b.lines[i].quad[1];
      if (gap > 0) gaps.push(gap);
    }
  }
  gaps.sort((a, b) => a - b);
  const leading = gaps.length ? gaps[Math.floor(gaps.length / 2)] : bodySize * 1.2;
  return { columnWidth, leading };
}
```

Add `TextBlock` to the type import at the top of the file:

```ts
import type { TextBlock, TextFragment, TextLine } from './text.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docinfer.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/docinfer.ts test/docinfer.test.ts
git commit -m "feat(docinfer): monospace line detection and page metrics"
```

---

### Task 3: Line classification — list runs, nesting and code runs

**Files:**
- Modify: `src/docinfer.ts`
- Test: `test/docinfer.test.ts`

**Interfaces:**
- Produces: `LineClass` (`{ kind: 'item'; marker: LineMarker; depth: number } | { kind: 'continuation' } | { kind: 'code' } | { kind: 'heading' } | { kind: 'text' }`), `ClassifyContext` (`{ metrics: PageMetrics; bodySize: number; prevBaseline?: number; nextLine?: TextLine }`), `classifyBlock(lines: TextLine[], ctx: ClassifyContext): LineClass[]`.
- Task 4 onward: `docmodel.ts` calls `classifyBlock` once per block. Heading promotion arrives in Task 4; this task always returns `'text'` for a non-item, non-code line.

- [ ] **Step 1: Write the failing test**

Append to `test/docinfer.test.ts`:

```ts
import { classifyBlock, type ClassifyContext } from '../src/docinfer.js';

const CTX: ClassifyContext = { metrics: { columnWidth: 200, leading: 12 }, bodySize: 10 };

describe('docinfer — list runs', () => {
  it('classifies two adjacent marked lines as items at depth 0', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('first', 65, 100, 200)),
      line(frag('•', 50, 56, 188), frag('second', 65, 105, 188)),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['item', 'item']);
    expect(cls.every((c) => c.kind === 'item' && c.depth === 0)).toBe(true);
  });

  it('leaves a lone marked line as prose — 1990. It was a good year', () => {
    const cls = classifyBlock([
      line(frag('1990. It was a good year and nothing else happened', 50, 240, 200)),
      line(frag('in the industry at all, by any measure.', 50, 230, 188)),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['text', 'text']);
  });

  it('confirms a single item when the next line is indented to its body', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('a long item', 65, 140, 200)),
      line(frag('wrapping on', 65, 130, 188)),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['item', 'continuation']);
  });

  it('gives a deeper marker a deeper depth', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('outer', 65, 100, 200)),
      line(frag('◦', 80, 86, 188), frag('inner', 95, 130, 188)),
      line(frag('•', 50, 56, 176), frag('outer again', 65, 130, 176)),
    ], CTX);
    expect(cls.map((c) => (c.kind === 'item' ? c.depth : c.kind))).toEqual([0, 1, 0]);
  });

  it('buckets markers within the tolerance to one depth', () => {
    // 0.5 x 10pt body size = 5pt tolerance; 52 is within it of 50.
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('a', 65, 75, 200)),
      line(frag('•', 52, 58, 188), frag('b', 67, 77, 188)),
    ], CTX);
    expect(cls.map((c) => (c.kind === 'item' ? c.depth : c.kind))).toEqual([0, 0]);
  });

  it('classifies consecutive monospaced lines as code', () => {
    const cls = classifyBlock([
      line(frag('function f() {', 50, 140, 200, 9, 'Courier')),
      line(frag('    return 1;', 50, 140, 188, 9, 'Courier')),
      line(frag('}', 50, 60, 176, 9, 'Courier')),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['code', 'code', 'code']);
  });

  it('never treats a code line as an item, even when it opens with a dash', () => {
    const cls = classifyBlock([
      line(frag('- x', 50, 80, 200, 9, 'Courier')),
      line(frag('- y', 50, 80, 188, 9, 'Courier')),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['code', 'code']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docinfer.test.ts`
Expected: FAIL — `classifyBlock is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/docinfer.ts`:

```ts
/** What a line is, once its neighbours have been taken into account. */
export type LineClass =
  | { kind: 'item'; marker: LineMarker; depth: number }
  | { kind: 'continuation' }
  | { kind: 'code' }
  | { kind: 'heading' }
  | { kind: 'text' };

/** Everything a block's lines are judged against. */
export interface ClassifyContext {
  metrics: PageMetrics;
  /** The page's dominant font size. A line above it is ranked by size and never
   *  reaches the heading signals here. */
  bodySize: number;
  /** Baseline of the last line before this block. Absent for the first block on
   *  a page, which counts as having a gap above it. */
  prevBaseline?: number;
  /** First line of the next block that will be emitted, for the "followed by
   *  body text" corroboration. Absent when this is the last block. */
  nextLine?: TextLine;
}

/** Marker x positions this close are the same nesting level. */
function tolerance(bodySize: number): number { return Math.max(3, 0.5 * bodySize); }

export function classifyBlock(lines: TextLine[], ctx: ClassifyContext): LineClass[] {
  const tol = tolerance(ctx.bodySize);
  const code = lines.map((l) => isCodeLine(l));
  const markers = lines.map((l, i) => (code[i] ? undefined : markerOf(l)));

  // A marked line forms an item only with corroboration: an adjacent marked
  // line, or a following line indented to its own body x. Without this,
  // '1990. It was a good year' is a list.
  const item = markers.map((m, i) => {
    if (!m) return false;
    if (markers[i - 1] || markers[i + 1]) return true;
    const next = lines[i + 1];
    return next !== undefined && !code[i + 1] && Math.abs(next.quad[0] - m.bodyX) <= tol;
  });

  // Depth is the rank of the marker's x bucket among the buckets in this block.
  const xs = [...new Set(markers.filter((m, i) => item[i]).map((m) => m!.markerX))]
    .sort((a, b) => a - b);
  const buckets: number[] = [];
  for (const x of xs) {
    if (!buckets.length || x - buckets[buckets.length - 1] > tol) buckets.push(x);
  }
  const depthOf = (x: number): number => {
    let d = 0;
    for (let i = 0; i < buckets.length; i++) if (x >= buckets[i] - tol) d = i;
    return d;
  };

  const out: LineClass[] = [];
  let open: LineMarker | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) { open = undefined; out.push({ kind: 'code' }); continue; }
    const m = markers[i];
    if (m && item[i]) { open = m; out.push({ kind: 'item', marker: m, depth: depthOf(m.markerX) }); continue; }
    if (open && Math.abs(lines[i].quad[0] - open.bodyX) <= tol) { out.push({ kind: 'continuation' }); continue; }
    open = undefined;
    out.push({ kind: 'text' });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docinfer.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/docinfer.ts test/docinfer.test.ts
git commit -m "feat(docinfer): list runs, nesting depth and code runs"
```

---

### Task 4: The three heading signals

**Files:**
- Modify: `src/docinfer.ts`
- Test: `test/docinfer.test.ts`

**Interfaces:**
- Consumes: `classifyBlock` and `ClassifyContext` from Task 3.
- Produces: `classifyBlock` now returns `{ kind: 'heading' }` for a promoted line. No new exported names.

- [ ] **Step 1: Write the failing test**

Append to `test/docinfer.test.ts`:

```ts
describe('docinfer — heading signals', () => {
  // A short line at body size, with a gap above and body text below at the same
  // left edge. Each signal is added on top of that shared corroboration.
  const body = (text: string, y: number, font = 'Helvetica') =>
    line(frag(text, 50, 50 + text.length * 5, y, 10, font));

  const classify = (lines: TextLine[], extra: Partial<ClassifyContext> = {}) =>
    classifyBlock(lines, { ...CTX, prevBaseline: 300, ...extra }).map((c) => c.kind);

  it('promotes a fully bold short isolated line', () => {
    expect(classify([body('Revenue', 200, 'Helvetica-Bold'), body('Body text follows here', 188)]))
      .toEqual(['heading', 'text']);
  });

  it('promotes an all-caps short isolated line', () => {
    expect(classify([body('REVENUE', 200), body('Body text follows here', 188)]))
      .toEqual(['heading', 'text']);
  });

  it('promotes a short isolated line on its own', () => {
    expect(classify([body('Revenue', 200), body('Body text follows here', 188)]))
      .toEqual(['heading', 'text']);
  });

  it('refuses a short isolated line ending in a full stop', () => {
    expect(classify([body('Revenue.', 200), body('Body text follows here', 188)]))
      .toEqual(['text', 'text']);
  });

  it('refuses a line with nothing after it — the ruled-card case', () => {
    expect(classify([body('Card heading', 200)])).toEqual(['text']);
  });

  it('refuses a line whose follower sits at another left edge', () => {
    const next = line(frag('Body text elsewhere', 200, 300, 188));
    expect(classify([body('Revenue', 200)], { nextLine: next })).toEqual(['text']);
  });

  it('refuses a line with no gap above it', () => {
    expect(classify([body('Revenue', 200), body('Body text follows here', 188)],
      { prevBaseline: 210 })).toEqual(['text', 'text']);
  });

  it('refuses a long line however bold', () => {
    const long = line(frag('x'.repeat(40), 50, 240, 200, 10, 'Helvetica-Bold'));
    expect(classify([long, body('Body text follows here', 188)])).toEqual(['text', 'text']);
  });

  it('takes the follower from the next block when the heading is alone in its own', () => {
    const next = line(frag('Body text follows here', 50, 160, 188));
    expect(classify([body('Revenue', 200)], { nextLine: next })).toEqual(['heading']);
  });

  it('never promotes a line inside a list run or a code run', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('SHORT', 65, 95, 200)),
      line(frag('•', 50, 56, 188), frag('ALSO SHORT', 65, 120, 188)),
    ], { ...CTX, prevBaseline: 300 });
    expect(cls.map((c) => c.kind)).toEqual(['item', 'item']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docinfer.test.ts`
Expected: FAIL — the promotion cases return `'text'`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/docinfer.ts`, above `classifyBlock`:

```ts
const BOLD = /bold|black|heavy|semibold|demi/i;

/** True when every cased letter is uppercase, over at least two letters. One
 *  letter is an initial, not a style. */
function allCaps(s: string): boolean {
  const letters = s.match(/\p{L}/gu);
  return letters !== null && letters.length >= 2 && s === s.toUpperCase();
}

/** The corroboration all three heading signals share: short, a gap above, and
 *  body text below at the same left edge.
 *
 *  The follower requirement is load-bearing rather than decorative — without it
 *  the bare short-isolated signal promotes `test/html-identity.test.ts`'s
 *  'Card heading', a short body-size line inside a ruled card with nothing after
 *  it, and moves a snapshot that has nothing to do with this feature. */
function corroborated(
  lines: TextLine[], i: number, ctx: ClassifyContext, tol: number,
): boolean {
  const l = lines[i];
  const width = l.quad[2] - l.quad[0];
  if (ctx.metrics.columnWidth <= 0 || width >= 0.6 * ctx.metrics.columnWidth) return false;

  const prevBaseline = i > 0 ? lines[i - 1].quad[1] : ctx.prevBaseline;
  // The first block on a page has no predecessor and counts as having a gap.
  if (prevBaseline !== undefined && prevBaseline - l.quad[1] < 1.2 * ctx.metrics.leading)
    return false;

  const next = i + 1 < lines.length ? lines[i + 1] : ctx.nextLine;
  if (!next) return false;
  if (Math.abs(next.quad[0] - l.quad[0]) > tol) return false;
  return dominantFragmentSize(next.fragments) <= ctx.bodySize + 0.5;
}

/** True when a body-size line carries heading evidence. A size-derived rank
 *  always wins, so this is consulted only at body size. */
function isHeading(lines: TextLine[], i: number, ctx: ClassifyContext, tol: number): boolean {
  const l = lines[i];
  if (dominantFragmentSize(l.fragments) > ctx.bodySize + 0.5) return false;  // ranked by size
  if (!corroborated(lines, i, ctx, tol)) return false;
  const bold = l.fragments.every((f) => f.fontName !== undefined && BOLD.test(f.fontName));
  // The trailing-punctuation refusal belongs to the bare signal alone: a bold or
  // all-caps heading that ends in a stop is still a heading.
  return bold || allCaps(l.text.trim()) || !/[.,]$/.test(l.text.trim());
}
```

Then in `classifyBlock`, replace the final fallback:

```ts
    open = undefined;
    out.push({ kind: 'text' });
```

with:

```ts
    open = undefined;
    out.push(isHeading(lines, i, ctx, tol) ? { kind: 'heading' } : { kind: 'text' });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docinfer.test.ts`
Expected: PASS, 30 tests.

- [ ] **Step 5: Commit**

```bash
git add src/docinfer.ts test/docinfer.test.ts
git commit -m "feat(docinfer): three corroborated heading signals at body size"
```

---

### Task 5: The vocabulary and the tagged list mapping

**Files:**
- Modify: `src/docmodel.ts`
- Test: `test/docmodel.test.ts`

**Interfaces:**
- Consumes: `parseMarkerText` from `src/docinfer.ts`.
- Produces: exported `DocList` (`{ kind: 'list'; ordered: boolean; start?: number; items: DocListItem[] }`), `DocListItem` (`{ kind: 'listItem'; blocks: DocNode[]; checked?: boolean }`), `DocCode` (`{ kind: 'code'; text: string }`), all three added to the `DocNode` union. Tasks 8 and 9 serialize them.

- [ ] **Step 1: Write the failing test**

Append to `test/docmodel.test.ts`:

```ts
import { Document } from '../src/document.js';
import { buildDocModel, type DocList, type DocNode } from '../src/docmodel.js';

/** Every list in the model, depth-first. */
function lists(nodes: DocNode[], out: DocList[] = []): DocList[] {
  for (const n of nodes) {
    if (n.kind === 'list') { out.push(n); for (const it of n.items) lists(it.blocks, out); }
    else if (n.kind === 'container') lists(n.children, out);
    else if (n.kind === 'listItem') lists(n.blocks, out);
  }
  return out;
}

/** A tagged document rendered from Markdown by our own authoring stack. */
function tagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true });
  return Document.Open(doc.Save());
}

describe('docmodel — tagged lists', () => {
  it('reads /L, /LI and /LBody as a list of items', () => {
    const doc = tagged('- alpha\n- beta\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(false);
    expect(l.items).toHaveLength(2);
  });

  it('drops the /Lbl from the content — a marker is evidence, not text', () => {
    const doc = tagged('- alpha\n- beta\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    const text = JSON.stringify(l.items[0]);
    expect(text).toContain('alpha');
    expect(text).not.toContain('•');
  });

  it('reads ordered-ness and a start from the /Lbl text', () => {
    const doc = tagged('3. three\n4. four\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(3);
  });

  it('omits start when the list begins at one', () => {
    const doc = tagged('1. one\n2. two\n');
    expect(lists(buildDocModel(doc, doc.Pages))[0].start).toBeUndefined();
  });

  it('nests a sub-list under its parent item', () => {
    const doc = tagged('- outer\n  - inner\n');
    const all = lists(buildDocModel(doc, doc.Pages));
    expect(all).toHaveLength(2);
    expect(all[0].items[0].blocks.some((b) => b.kind === 'list')).toBe(true);
  });

  it('reads a task marker as checked state', () => {
    const doc = tagged('- [ ] todo\n- [x] done\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.items.map((i) => i.checked)).toEqual([false, true]);
  });

  it('prefers an explicit /ListNumbering over the label text', () => {
    const doc = Document.New();
    doc.AddMarkdown('- alpha\n- beta\n', { tagged: true });
    const l = doc.CreateStructTree().Children[0].Children.find((c) => c.Type === 'L')!;
    l.SetListAttributes({ listNumbering: 'Decimal' });
    const reopened = Document.Open(doc.Save());
    expect(lists(buildDocModel(reopened, reopened.Pages))[0].ordered).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docmodel.test.ts`
Expected: FAIL — `lists(...)` is empty, since `/L` currently flattens to containers.

- [ ] **Step 3: Write minimal implementation**

In `src/docmodel.ts`, extend the union and add the kinds:

```ts
export type DocNode = DocContainer | DocText | DocTable | DocFigure | DocList | DocListItem | DocCode;

/** A list. `ordered` and `start` are decisions rather than structure types,
 *  which is why this is a kind of its own: the model otherwise speaks only
 *  standard types, and no type records whether a list is numbered. */
export interface DocList { kind: 'list'; ordered: boolean; start?: number; items: DocListItem[] }
/** One item. `blocks` are block-level nodes, so a nested list is just a block. */
export interface DocListItem { kind: 'listItem'; blocks: DocNode[]; checked?: boolean }
/** Preformatted text, newline-separated, unescaped and unfenced. */
export interface DocCode { kind: 'code'; text: string }
```

Add the import:

```ts
import { parseMarkerText } from './docinfer.js';
```

Add the list builders above `elementNode`:

```ts
/** The blocks under an /LBody (or, for a malformed /LI, under the item itself).
 *
 *  Text runs directly under the body become a P, because DocListItem.blocks is
 *  block level: a bare DocText there would leave each serializer to decide what
 *  wraps it, which is the disagreement this model exists to prevent. */
function itemBlocks(ctx: Ctx, el: StructElement): DocNode[] {
  const out: DocNode[] = [];
  let texts: string[] = [];
  const flush = (): void => {
    const text = texts.join('');
    texts = [];
    if (text) out.push({ kind: 'container', type: 'P', children: [{ kind: 'text', text }] });
  };
  const actual = el.ActualText;
  if (actual !== undefined) {
    if (actual !== '') out.push({ kind: 'container', type: 'P', children: [{ kind: 'text', text: actual }] });
    return out;
  }
  for (const n of el.Nodes) {
    if (isText(n)) {
      if (ctx.only && n.page !== ctx.only) continue;
      if (n.text !== '') texts.push(n.text);
    } else {
      flush();
      const child = elementNode(ctx, n);
      if (child) out.push(child);
    }
  }
  flush();
  return out;
}

/** One /LI: its /Lbl read for evidence, its /LBody read for content. */
function listItemNode(
  ctx: Ctx, el: StructElement,
): { item: DocListItem; marker?: Marker } | undefined {
  if (!onPage(el, ctx.only)) return undefined;
  const children = el.Children;
  const lbl = children.find((c) => c.StandardType === 'Lbl');
  const body = children.find((c) => c.StandardType === 'LBody');
  // A bullet /Lbl carries its glyph as /ActualText, since flow.ts draws the
  // bullet as vector geometry and there is no text to extract.
  const label = lbl ? (lbl.ActualText ?? lbl.GetText()).trim() : '';
  const marker = label ? parseMarkerText(label)?.marker : undefined;
  const blocks = body ? itemBlocks(ctx, body) : itemBlocks(ctx, el);
  if (!blocks.length) return undefined;
  const item: DocListItem = { kind: 'listItem', blocks };
  if (marker?.checked !== undefined) item.checked = marker.checked;
  return { item, marker };
}

/** An /L. Ordered-ness comes from /ListNumbering when the producer set one, and
 *  from the labels otherwise — which is the path our own authoring takes, since
 *  flow.ts appends a bare /L with no attributes. */
function listNode(ctx: Ctx, el: StructElement): DocNode[] {
  const items: DocListItem[] = [];
  const extra: DocNode[] = [];
  let labelled: Marker | undefined;
  let start: number | undefined;
  for (const child of el.Children) {
    if (child.StandardType !== 'LI') {
      const n = elementNode(ctx, child);      // a non-/LI kid stays a sibling block
      if (n) extra.push(n);
      continue;
    }
    const built = listItemNode(ctx, child);
    if (!built) continue;
    items.push(built.item);
    if (built.marker && !labelled) {
      labelled = built.marker;
      if (built.marker.ordinal !== undefined && built.marker.ordinal !== 1)
        start = built.marker.ordinal;
    }
  }
  if (!items.length) return extra;

  const numbering = el.ListAttributes?.listNumbering;
  const ordered = numbering !== undefined
    ? !['None', 'Disc', 'Circle', 'Square'].includes(numbering)
    : (labelled?.ordered ?? false);
  const list: DocList = { kind: 'list', ordered, items };
  if (ordered && start !== undefined) list.start = start;
  return [list, ...extra];
}
```

Import the `Marker` type beside `parseMarkerText`:

```ts
import { parseMarkerText, type Marker } from './docinfer.js';
```

In `elementNode`, dispatch before the generic container path (just after the `Figure` branch):

```ts
  if (type === 'L') {
    const nodes = listNode(ctx, el);
    // A single node returns itself; several mean the /L had non-/LI kids, which
    // the transparency rule keeps as siblings — wrap them so one node comes back.
    if (!nodes.length) return undefined;
    return nodes.length === 1 ? nodes[0]
      : { kind: 'container', type: 'Div', children: nodes };
  }
```

`elementNode`'s existing `for (const n of el.Nodes)` loop must not descend into an `/LI` on its own, which it no longer does: `/L` is intercepted above and `listNode` reads the items itself.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docmodel.test.ts`
Expected: PASS, all cases including the seven new ones.

- [ ] **Step 5: Commit**

```bash
git add src/docmodel.ts test/docmodel.test.ts
git commit -m "feat(docmodel): DocList/DocListItem/DocCode and the tagged /L mapping"
```

---

### Task 6: The tagged code mapping

**Files:**
- Modify: `src/docmodel.ts`
- Test: `test/docmodel.test.ts`

**Interfaces:**
- Consumes: `DocCode` from Task 5.
- Produces: a `/P` whose only element child is a `/Code` yields `DocCode`; U+00A0 is mapped back to U+0020 in its text.

- [ ] **Step 1: Write the failing test**

Append to `test/docmodel.test.ts`:

```ts
function codes(nodes: DocNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === 'code') out.push(n.text);
    else if (n.kind === 'container') codes(n.children, out);
    else if (n.kind === 'list') for (const it of n.items) codes(it.blocks, out);
  }
  return out;
}

describe('docmodel — tagged code blocks', () => {
  it('collapses /P > /Code to a code node', () => {
    const doc = tagged('```\nconst x = 1;\n```\n');
    expect(codes(buildDocModel(doc, doc.Pages))).toEqual(['const x = 1;']);
  });

  it('restores indentation from the NBSP preformat substituted', () => {
    const doc = tagged('```\nif (x) {\n    return 1;\n}\n```\n');
    const [text] = codes(buildDocModel(doc, doc.Pages));
    expect(text).toBe('if (x) {\n    return 1;\n}');
    expect(text).not.toContain('\u00A0');
  });

  it('keeps a code block inside a list item as the item’s own block', () => {
    const doc = tagged('- item\n\n  ```\n  x\n  ```\n');
    expect(codes(buildDocModel(doc, doc.Pages))).toEqual(['x']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docmodel.test.ts`
Expected: FAIL — `codes(...)` is `[]`; the code text flattens into a paragraph.

- [ ] **Step 3: Write minimal implementation**

Add to `src/docmodel.ts`, above `elementNode`:

```ts
/** A /Code element's text, page-filtered, its MCID runs joined by a newline.
 *
 *  **Invariant:** U+00A0 maps back to U+0020. That substitution is preformat's,
 *  made because layoutRuns collapses runs of spaces and a code block's
 *  indentation would not otherwise survive being drawn; undoing it here is what
 *  makes the indentation survive being read back. Confined to code, where the
 *  character is provably a substitution rather than an author's choice. */
function codeText(ctx: Ctx, el: StructElement): string {
  const parts: string[] = [];
  const walk = (e: StructElement): void => {
    for (const n of e.Nodes) {
      if (isText(n)) {
        if (ctx.only && n.page !== ctx.only) continue;
        if (n.text !== '') parts.push(n.text);
      } else walk(n);
    }
  };
  walk(el);
  return parts.join('\n').replace(/\u00A0/g, ' ');
}

/** The /Code that is this element's only element child, if any. /Code is inline
 *  level and needs a block-level element around it (32000-1 14.8.4.3), so the
 *  wrapping /P carries no content of its own and collapses away. */
function loneCode(el: StructElement): StructElement | undefined {
  const kids = el.Children;
  if (kids.length !== 1 || kids[0].StandardType !== 'Code') return undefined;
  return el.Nodes.every((n) => (isText(n) ? n.text.trim() === '' : true)) ? kids[0] : undefined;
}
```

In `elementNode`, after the `L` branch:

```ts
  if (type === 'Code') {
    const text = codeText(ctx, el);
    return text ? { kind: 'code', text } : undefined;
  }
  if (type === 'P') {
    const code = loneCode(el);
    if (code) {
      const text = codeText(ctx, code);
      if (text) return { kind: 'code', text };
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docmodel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/docmodel.ts test/docmodel.test.ts
git commit -m "feat(docmodel): /P > /Code collapses to a code node with its indentation"
```

---

### Task 7: Wiring the untagged path

**Files:**
- Modify: `src/docmodel.ts:160-197` (`blockNodes`, `untaggedModel`)
- Test: `test/docmodel.test.ts`

**Interfaces:**
- Consumes: `classifyBlock`, `pageMetrics`, `ClassifyContext`, `LineClass` from `src/docinfer.ts`.
- Produces: no new exports. `buildDocModel` on an untagged document now yields `DocList` and `DocCode` nodes, and headings promoted by the Task 4 signals.

- [ ] **Step 1: Write the failing test**

Append to `test/docmodel.test.ts`:

```ts
/** The same Markdown rendered WITHOUT a structure tree. */
function untagged(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src);
  return Document.Open(doc.Save());
}

describe('docmodel — untagged inference', () => {
  it('recovers a bullet list from page geometry', () => {
    const doc = untagged('- alpha\n- beta\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l).toBeDefined();
    expect(l.ordered).toBe(false);
    expect(l.items).toHaveLength(2);
  });

  it('recovers nesting from the marker indent', () => {
    const doc = untagged('- outer\n  - inner\n- outer again\n');
    const all = lists(buildDocModel(doc, doc.Pages));
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].items[0].blocks.some((b) => b.kind === 'list')).toBe(true);
  });

  it('recovers an ordered list and its start', () => {
    const doc = untagged('3. three\n4. four\n');
    const [l] = lists(buildDocModel(doc, doc.Pages));
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(3);
  });

  it('recovers a code block from its monospaced face', () => {
    const doc = untagged('```\nif (x) {\n    return 1;\n}\n```\n');
    expect(codes(buildDocModel(doc, doc.Pages))).toEqual(['if (x) {\n    return 1;\n}']);
  });

  it('leaves prose that opens with a year as a paragraph', () => {
    const doc = untagged('1990. It was a good year for the industry, and nothing at all happened.\n');
    expect(lists(buildDocModel(doc, doc.Pages))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docmodel.test.ts`
Expected: FAIL — the untagged path still emits paragraphs only.

- [ ] **Step 3: Write minimal implementation**

Replace `blockNodes` and `untaggedModel` in `src/docmodel.ts` with:

```ts
/** A run of item and continuation lines as one (possibly nested) list.
 *
 *  A nested list is pushed into the PREVIOUS item's blocks, which is why the
 *  open item is closed before the stack is adjusted: its own paragraph must
 *  already be in place, or the sub-list lands ahead of the text that introduces
 *  it. Returns the index one past the run. */
function buildList(
  lines: TextLine[], classes: LineClass[], start: number,
): { node: DocList; end: number } {
  const stack: { depth: number; list: DocList }[] = [];
  let item: DocListItem | undefined;
  let texts: string[] = [];
  const closeItem = (): void => {
    if (!item) return;
    const text = texts.join(' ').replace(/\s+/g, ' ').trim();
    if (text)
      item.blocks.unshift({ kind: 'container', type: 'P', children: [{ kind: 'text', text }] });
    texts = [];
    item = undefined;
  };

  let i = start;
  for (; i < lines.length; i++) {
    const c = classes[i];
    if (c.kind === 'continuation') { texts.push(lines[i].text); continue; }
    if (c.kind !== 'item') break;
    closeItem();
    while (stack.length && stack[stack.length - 1].depth > c.depth) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.depth < c.depth) {
      const list: DocList = { kind: 'list', ordered: c.marker.ordered, items: [] };
      if (c.marker.ordered && c.marker.ordinal !== undefined && c.marker.ordinal !== 1)
        list.start = c.marker.ordinal;
      const parentItem = top?.list.items[top.list.items.length - 1];
      if (top) {
        if (parentItem) parentItem.blocks.push(list);
        else top.list.items.push({ kind: 'listItem', blocks: [list] });
      }
      stack.push({ depth: c.depth, list });
      top = stack[stack.length - 1];
    }
    item = { kind: 'listItem', blocks: [] };
    if (c.marker.checked !== undefined) item.checked = c.marker.checked;
    top.list.items.push(item);
    texts.push(lines[i].text.slice(c.marker.textStart));
  }
  closeItem();
  return { node: stack[0].list, end: i };
}

/** A block's lines as heading, paragraph, list and code nodes.
 *
 *  Ranking is per line, not per block: the block grouper clusters a heading with
 *  the body paragraph beneath it whenever they are left-aligned and close (the
 *  ordinary case), and ranking such a block as a whole would let the longer body
 *  text outvote the heading and demote it to P. Consecutive lines of equal rank
 *  merge into one container, so a wrapped paragraph stays a single P and a
 *  two-line heading stays a single H1. */
function blockNodes(
  block: TextBlock, ranks: Map<number, number>, ctx: ClassifyContext, out: DocNode[],
): void {
  const classes = classifyBlock(block.lines, ctx);
  let level: number | undefined;
  let texts: string[] = [];
  const flush = (): void => {
    const text = texts.join(' ').trim();
    texts = [];
    if (!text) return;
    out.push({
      kind: 'container',
      type: level ? `H${level}` : 'P',
      children: [{ kind: 'text', text }],
    });
  };

  let i = 0;
  while (i < block.lines.length) {
    const c = classes[i];
    if (c.kind === 'code') {
      flush();
      const from = i;
      while (i < block.lines.length && classes[i].kind === 'code') i++;
      const text = block.lines.slice(from, i)
        .map((l) => l.text.replace(/\u00A0/g, ' ')).join('\n');
      if (text.trim()) out.push({ kind: 'code', text });
      continue;
    }
    if (c.kind === 'item') {
      flush();
      const { node, end } = buildList(block.lines, classes, i);
      out.push(node);
      i = end;
      continue;
    }
    const line = block.lines[i];
    // A size-derived rank wins; the signals promote only at body size, and the
    // fallback level sits one below the smallest size-derived heading.
    const sized = ranks.get(dominantFragmentSize(line.fragments));
    const lineLevel = sized ?? (c.kind === 'heading' ? Math.min(ranks.size + 1, 6) : undefined);
    if (texts.length && lineLevel !== level) flush();
    level = lineLevel;
    texts.push(line.text);
    i++;
  }
  flush();
}

/** Merge adjacent lists of the same ordered-ness, so a list the block grouper
 *  split on loose spacing comes back as one list. */
function mergeLists(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.kind === 'list' && prev?.kind === 'list' && prev.ordered === n.ordered
      && n.start === undefined) {
      prev.items.push(...n.items);
      continue;
    }
    out.push(n);
  }
  return out;
}

function untaggedModel(doc: Document, pages: Page[], ranks: Map<number, number>): DocNode[] {
  const out: DocNode[] = [];
  for (const page of pages) {
    const tables: Table[] = page.GetTables();
    // Table-absorbed blocks are emitted as part of their table, not twice — and
    // they are excluded from the metrics and from the follower lookup, so a cell
    // never corroborates a heading outside the table.
    const blocks = page.GetStructuredText()
      .filter((b) => !tables.some((t) => centerInside(b.quad, t.quad)));
    const bodySize = dominantFragmentSize(blocks.flatMap((b) => b.lines.flatMap((l) => l.fragments)));
    const metrics = pageMetrics(blocks, bodySize);

    const pageNodes: DocNode[] = [];
    blocks.forEach((block, i) => {
      const prev = blocks[i - 1]?.lines.at(-1);
      const ctx: ClassifyContext = {
        metrics,
        bodySize,
        ...(prev ? { prevBaseline: prev.quad[1] } : {}),
        ...(blocks[i + 1]?.lines[0] ? { nextLine: blocks[i + 1].lines[0] } : {}),
      };
      blockNodes(block, ranks, ctx, pageNodes);
    });
    out.push(...mergeLists(pageNodes));

    for (const table of tables) out.push({ kind: 'table', table });
    for (const img of page.Images) {
      out.push({ kind: 'figure', alt: '', images: [img.Stream], tagged: false });
    }
  }
  return out;
}
```

Add the imports at the top of `src/docmodel.ts`:

```ts
import { classifyBlock, pageMetrics, type ClassifyContext, type LineClass } from './docinfer.js';
import { visitContent, type Rect, type TextBlock, type TextLine } from './text.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/docmodel.test.ts test/docinfer.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite — this is the step that catches collateral damage**

Run: `npm test`
Expected: PASS. If `test/html-identity.test.ts` moves, STOP: the heading signals have escaped their corroboration, and the fix belongs in `docinfer.ts`, not in the snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/docmodel.ts test/docmodel.test.ts
git commit -m "feat(docmodel): infer lists, code blocks and headings on the untagged path"
```

---

### Task 8: Markdown serialization

**Files:**
- Modify: `src/mdexport.ts`
- Test: `test/markdown-export.test.ts`

**Interfaces:**
- Consumes: `DocList`, `DocListItem`, `DocCode` from `src/docmodel.ts`.
- Produces: no new exports; `renderDocumentToMarkdown` and `renderPageToMarkdown` now emit lists, fences and quotes.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-export.test.ts`:

```ts
/** Markdown for a source rendered through our own authoring stack. */
function via(src: string, opts?: { tagged: boolean }): string {
  const doc = Document.New();
  doc.AddMarkdown(src, opts?.tagged ? { tagged: true } : undefined);
  return Document.Open(doc.Save()).ToMarkdown();
}

describe('ToMarkdown — lists', () => {
  it('emits a tight bullet list', () => {
    expect(via('- alpha\n- beta\n', { tagged: true })).toBe('- alpha\n- beta\n');
  });

  it('emits an ordered list counting from its start', () => {
    expect(via('3. three\n4. four\n', { tagged: true })).toBe('3. three\n4. four\n');
  });

  it('indents a nested list inside its parent item', () => {
    expect(via('- outer\n  - inner\n', { tagged: true })).toBe('- outer\n  - inner\n');
  });

  it('emits task markers', () => {
    expect(via('- [ ] todo\n- [x] done\n', { tagged: true })).toBe('- [ ] todo\n- [x] done\n');
  });

  it('separates the items of a loose list with a blank line', () => {
    const md = via('- alpha\n\n  second paragraph\n\n- beta\n', { tagged: true });
    expect(md).toContain('- alpha\n\n  second paragraph\n\n- beta');
  });
});

describe('ToMarkdown — code blocks', () => {
  it('fences a code block and keeps its indentation', () => {
    expect(via('```\nif (x) {\n    return 1;\n}\n```\n', { tagged: true }))
      .toBe('```\nif (x) {\n    return 1;\n}\n```\n');
  });

  it('lengthens the fence past any backtick run inside', () => {
    expect(via('````\nsee ``` for fences\n````\n', { tagged: true }))
      .toBe('````\nsee ``` for fences\n````\n');
  });

  it('never escapes inside a fence', () => {
    expect(via('```\nconst a = b[0] * 2;\n```\n', { tagged: true }))
      .toContain('const a = b[0] * 2;');
  });
});

describe('ToMarkdown — quotes', () => {
  it('prefixes every line of a quote', () => {
    expect(via('> quoted text\n', { tagged: true })).toBe('> quoted text\n');
  });

  it('composes nesting into a double prefix', () => {
    expect(via('> > deeper\n', { tagged: true })).toBe('> > deeper\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/markdown-export.test.ts`
Expected: FAIL — lists come back as bare paragraph text, code as escaped prose.

- [ ] **Step 3: Write minimal implementation**

In `src/mdexport.ts`, add `'Code'` to the inline set so a `/Code` used inline concatenates into its paragraph rather than becoming its own block:

```ts
const INLINE_TYPES = new Set(['Span', 'Link', 'Code']);
```

Add the three block builders above `nodeBlocks`:

```ts
/** Render `nodes` as a block string — the same joining `render` uses, so a
 *  nested construct reads exactly as it would at the top level. */
function blocksText(doc: Document, nodes: DocNode[], sep = '\n\n'): string {
  const out: string[] = [];
  for (const n of nodes) nodeBlocks(doc, n, out);
  return out.join(sep);
}

/** An item's blocks. A list or a code block follows its introducing text with a
 *  single newline: a blank line there makes the parser read the whole list as
 *  loose, which changes how it renders. */
function itemText(doc: Document, item: DocListItem): string {
  const parts: string[] = [];
  for (const b of item.blocks) {
    const chunk: string[] = [];
    nodeBlocks(doc, b, chunk);
    const text = chunk.join('\n\n');
    if (!text) continue;
    if (!parts.length) parts.push(text);
    else parts.push((b.kind === 'list' || b.kind === 'code' ? '\n' : '\n\n') + text);
  }
  return parts.join('');
}

function listMarkdown(doc: Document, node: DocList): string {
  // Loose means an item holds more than one block that is NOT a nested list:
  // counting the sub-list would make every nesting parent loose, and the blank
  // lines that follow would make it loose for the parser too.
  const loose = node.items.some(
    (it) => it.blocks.filter((b) => b.kind !== 'list').length > 1);
  let n = node.start ?? 1;
  const items: string[] = [];
  for (const item of node.items) {
    const marker = node.ordered ? `${n++}. `
      : item.checked === undefined ? '- ' : item.checked ? '- [x] ' : '- [ ] ';
    const body = itemText(doc, item);
    if (!body) continue;
    const indent = ' '.repeat(marker.length);
    const [first, ...rest] = body.split('\n');
    items.push([marker + first, ...rest.map((l) => (l ? indent + l : ''))].join('\n'));
  }
  return items.join(loose ? '\n\n' : '\n');
}

/** **Invariant:** the fence is one backtick longer than the longest run inside.
 *  A fixed three-backtick fence lets a block containing a fenced example break
 *  out of itself, producing valid Markdown that says something else. There is no
 *  info string: a PDF records no language, and guessing one lexically would be a
 *  claim the document does not make. */
function codeMarkdown(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function quoteMarkdown(inner: string): string {
  return inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
}
```

In `nodeBlocks`, add the three cases before the heading check:

```ts
  if (node.kind === 'list') { const t = listMarkdown(doc, node); if (t) out.push(t); return; }
  if (node.kind === 'listItem') { const t = itemText(doc, node); if (t) out.push(t); return; }
  if (node.kind === 'code') { out.push(codeMarkdown(node.text)); return; }
```

and, in the container path, before the `P`/inline check:

```ts
  if (node.type === 'BlockQuote') {
    const inner = blocksText(doc, node.children);
    if (inner) out.push(quoteMarkdown(inner));
    return;
  }
```

Import the new types:

```ts
import { buildDocModel, type DocFigure, type DocList, type DocListItem, type DocNode } from './docmodel.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/markdown-export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mdexport.ts test/markdown-export.test.ts
git commit -m "feat(mdexport): serialize lists, fenced code blocks and quotes"
```

---

### Task 9: HTML serialization

**Files:**
- Modify: `src/htmlsemantic.ts`
- Test: `test/html-identity.test.ts`

**Interfaces:**
- Consumes: `DocList`, `DocListItem`, `DocCode`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `test/html-identity.test.ts`:

```ts
/** A tagged document rendered from Markdown, for the constructs no93.2 adds. */
function fromMarkdown(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true });
  return Document.Open(doc.Save());
}

describe('ToHtml — the constructs no93.2 adds', () => {
  it('tagged: a nested bullet list', () => {
    expect(fromMarkdown('- outer\n  - inner\n').ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: an ordered list with a start', () => {
    expect(fromMarkdown('3. three\n4. four\n').ToHtml({ fragment: true })).toMatchSnapshot();
  });

  it('tagged: a task list', () => {
    expect(fromMarkdown('- [ ] todo\n- [x] done\n').ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });

  it('tagged: a code block and a quote', () => {
    expect(fromMarkdown('```\nx = 1;\n```\n\n> quoted\n').ToHtml({ fragment: true }))
      .toMatchSnapshot();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/html-identity.test.ts`
Expected: the four new snapshots are WRITTEN (vitest records new snapshots on first run) — so read them. Expected FAIL of intent, not of the runner: they will show `<div>`-wrapped text with duplicated bullet labels, not `<ul>`/`<ol>`/`<pre>`/`<blockquote>`. Delete the four recorded snapshots from `test/__snapshots__/html-identity.test.ts.snap` before Step 3 so they are re-recorded against the finished implementation.

- [ ] **Step 3: Write minimal implementation**

In `src/htmlsemantic.ts`, add `BlockQuote` to the tag table:

```ts
const TAG_FOR: Record<string, string> = {
  P: 'p', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6',
  L: 'ul', LI: 'li', Span: 'span', Link: 'a', BlockQuote: 'blockquote', Code: 'code',
  Document: 'div', Part: 'div', Sect: 'div', Div: 'div', Art: 'div', TOC: 'div', TOCI: 'div',
};
```

and handle the three kinds at the top of `nodeHtml`, beside the existing `table` and `figure` cases:

```ts
  if (node.kind === 'code') return `<pre><code>${escapeHtml(node.text)}</code></pre>`;
  if (node.kind === 'listItem') return listItemHtml(doc, node);
  if (node.kind === 'list') {
    const tag = node.ordered ? 'ol' : 'ul';
    const start = node.ordered && node.start !== undefined ? ` start="${node.start}"` : '';
    const items = node.items.map((it) => listItemHtml(doc, it)).filter((s) => s).join('');
    return items ? `<${tag}${start}>${items}</${tag}>` : '';
  }
```

with the item helper above `nodeHtml`:

```ts
/** One list item. A task's state is CONTENT rather than a marker — it is the one
 *  place the marker-suppression rule does not apply — so it survives as a
 *  checkbox, disabled because an exported document is not a form. */
function listItemHtml(doc: Document, item: DocListItem): string {
  const inner = item.blocks.map((b) => nodeHtml(doc, b)).filter((s) => s).join('');
  const box = item.checked === undefined ? ''
    : `<input type="checkbox" disabled${item.checked ? ' checked' : ''}>`;
  return inner || box ? `<li>${box}${inner}</li>` : '';
}
```

Import the types:

```ts
import type { DocFigure, DocListItem, DocNode } from './docmodel.js';
```

- [ ] **Step 4: Run the tests and read every new snapshot**

Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS with four newly written snapshots. Open `test/__snapshots__/html-identity.test.ts.snap` and confirm by eye: `<ul><li><p>outer</p><ul><li><p>inner</p></li></ul></li></ul>` in shape, `<ol start="3">`, `<input type="checkbox" disabled checked>`, `<pre><code>`, `<blockquote>`. **Every pre-existing snapshot in that file must be unchanged** — check with `git diff` before committing.

- [ ] **Step 5: Commit**

```bash
git add src/htmlsemantic.ts test/html-identity.test.ts test/__snapshots__/html-identity.test.ts.snap
git commit -m "feat(html): serialize lists, code blocks and quotes from the document model"
```

---

### Task 10: The round trips

**Files:**
- Modify: `test/markdown-roundtrip.test.ts`

**Interfaces:**
- Consumes: everything above. No production code changes — if a case fails here, the defect is in an earlier task's module.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-roundtrip.test.ts`:

```ts
const RICH = [
  '# Release notes',
  '',
  '- alpha',
  '  - nested alpha',
  '- beta',
  '',
  '1. first',
  '2. second',
  '',
  '```',
  'if (x) {',
  '    return 1;',
  '}',
  '```',
  '',
  '> quoted line',
  '',
].join('\n');

/** Blocks as coarse shapes: enough to tell a list from a paragraph, ignoring the
 *  inline styling a round trip through PDF legitimately loses. */
function shapes(md: string): string[] {
  const doc = parseMarkdown(md, { gfm: true });
  const walk = (blocks: MdBlock[], out: string[]): string[] => {
    for (const b of blocks) {
      if (b.type === 'heading') out.push(`h${b.level}:${textOf(b).trim()}`);
      else if (b.type === 'paragraph') out.push(`p:${textOf(b).trim()}`);
      else if (b.type === 'code_block') out.push(`code:${b.literal}`);
      else if (b.type === 'block_quote') { out.push('quote{'); walk(b.children, out); out.push('}'); }
      else if (b.type === 'list') {
        out.push(`list:${b.ordered ? 'ordered' : 'bullet'}{`);
        for (const item of b.children) walk(item.children, out);
        out.push('}');
      }
    }
    return out;
  };
  return walk(doc.children, []);
}

describe('Markdown round trip — lists, code and quotes', () => {
  it('recovers them from a tagged document', () => {
    const doc = Document.New();
    doc.AddMarkdown(RICH, { tagged: true });
    const back = Document.Open(doc.Save()).ToMarkdown();

    expect(shapes(back)).toEqual(shapes(RICH));
  });

  // The inference path is held to the SAME output as the structure tree: that
  // agreement is the whole claim docinfer.ts makes.
  it('recovers them from an untagged rendering', () => {
    const doc = Document.New();
    doc.AddMarkdown(RICH);
    const back = Document.Open(doc.Save()).ToMarkdown();

    expect(shapes(back)).toEqual(shapes(RICH));
  });

  // Code is compared EXACTLY, unlike prose: indentation is the whole point of
  // the construct, and a comparison that trims it measures nothing.
  it('preserves code indentation byte for byte, tagged and untagged', () => {
    for (const tagged of [true, false]) {
      const doc = Document.New();
      doc.AddMarkdown(RICH, tagged ? { tagged: true } : undefined);
      const back = Document.Open(doc.Save()).ToMarkdown();
      expect(back, `tagged=${tagged}`).toContain('if (x) {\n    return 1;\n}');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes honestly**

Run: `npx vitest run test/markdown-roundtrip.test.ts`
Expected: PASS if Tasks 5–9 are complete. If a case fails, fix the module it points at — do NOT weaken the assertion. The one legitimate adjustment: if the untagged path reports the nested list at a depth the fixture's indent cannot support, widen the *fixture's* nesting indent (Markdown's two spaces may render as a small point offset), and record why in a comment.

- [ ] **Step 3: Commit**

```bash
git add test/markdown-roundtrip.test.ts
git commit -m "test(mdexport): round-trip lists, code and quotes through PDF both ways"
```

---

### Task 11: Mutation verification, docs, and close-out

**Files:**
- Modify: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the finished feature.

- [ ] **Step 1: Run the five mutations, confirming each goes red**

Apply each mutation, run the named command, confirm FAIL, then revert it (`git checkout -- <file>`). A mutation that stays green means the assertion is not load-bearing — write a better one before continuing.

| # | Mutation | Run | Must fail |
|---|---|---|---|
| 1 | In `listItemNode`, prepend the `/Lbl` label to the item's text | `npx vitest run test/docmodel.test.ts` | "drops the /Lbl from the content" |
| 2 | In `codeText` and `blockNodes`, drop the `.replace(/\u00A0/g, ' ')` | `npx vitest run test/docmodel.test.ts test/markdown-roundtrip.test.ts` | the indentation cases |
| 3 | In `corroborated`, delete the `next`/left-edge check (`return true` after the gap test) | `npm test` | `test/html-identity.test.ts` ruled-card snapshot moves |
| 4 | In `classifyBlock`, make every marked line an item (`const item = markers.map((m) => !!m)`) | `npx vitest run test/docinfer.test.ts test/docmodel.test.ts` | the `1990.` cases |
| 5 | In `codeMarkdown`, hardcode ``const fence = '```'`` | `npx vitest run test/markdown-export.test.ts` | "lengthens the fence past any backtick run inside" |

- [ ] **Step 2: Run the full gates**

```bash
npm run typecheck
npm test
```
Expected: both green, no snapshot writes.

- [ ] **Step 3: Update `README.md`**

In the `ToMarkdown` part of the API overview, extend the coverage sentence to name nested lists (ordered, bullet and task), fenced code blocks and block quotes, and add the two limitations verbatim:

```markdown
On an untagged document these are inferred from page geometry: a single-item
list is not recognised (a marker needs a neighbouring item or an indented
continuation to be distinguished from prose such as `1990. It was...`), and a
code block indented by glyph positioning rather than by spaces loses its
indentation.
```

- [ ] **Step 4: Update `CLAUDE.md`**

Add a `docinfer.ts` bullet immediately after the `docmodel.ts` bullet in the Source list, carrying the four invariants: the marker grammar has one owner (`parseMarkerText`, shared by the tagged `/Lbl` and the untagged line); a marked line needs corroboration; the heading signals share one corroboration whose follower clause is fenced by `test/html-identity.test.ts`'s ruled-card snapshot; and the module may never import a `Document`. Extend the `mdexport.ts` bullet with the U+00A0 and fence-length invariants.

- [ ] **Step 5: Commit and close the issue**

```bash
git add README.md CLAUDE.md
git commit -m "docs(mdexport): record the no93.2 invariants and untagged limitations"
bd close aspose-pdf-foss-for-ts-no93.2
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Self-Review

**Spec coverage.** Vocabulary → Task 5. Tagged `/L`,`/LI`,`/Lbl`,`/LBody` incl. `/ListNumbering`, `start`, `checked` → Task 5. Tagged `/Code` + `/P` collapse + U+00A0 → Task 6. `/BlockQuote` → Tasks 8 (Markdown) and 9 (HTML). Marker grammar + corroboration → Tasks 1, 3. Nesting buckets → Task 3. Code lines → Tasks 2, 3. Heading signals → Task 4. Untagged wiring + adjacent-list merge + page metrics → Task 7. Markdown rules (marker widths, tight/loose, fence length, no info string, no escaping inside a fence) → Task 8. HTML rules → Task 9. Testing → Tasks 1–10; the five named mutations → Task 11. Docs → Task 11.

**Type consistency.** `parseMarkerText` returns `{ marker, length }` in Task 1 and is consumed that way in Tasks 3 and 5. `Marker.ordinal` is decimal-only in Task 1, and Tasks 5 and 7 both guard `ordinal !== undefined && ordinal !== 1` before setting `start`. `LineClass` is produced in Task 3, extended with `'heading'` in Task 4, and consumed in Task 7. `DocListItem.blocks` is block level in Task 5 and relied on as such by `itemText` (Task 8) and `listItemHtml` (Task 9).

**Known soft spot, deliberately left to execution.** Task 10's untagged round trip depends on the nesting indent our own list renderer produces exceeding `docinfer`'s bucket tolerance of `max(3pt, 0.5 × body size)`. `mdstyle.ts`'s default list indent is comfortably larger, but if a future style default shrinks it the fixture is what will notice. That is why Task 10 permits widening the fixture's indent with a recorded reason, and nothing else.
