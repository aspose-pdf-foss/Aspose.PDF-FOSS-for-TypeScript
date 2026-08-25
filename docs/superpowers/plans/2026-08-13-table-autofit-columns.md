# Auto-fit Table Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Size a Markdown table's columns from their content instead of splitting the width equally, so a two-character `Qty` column stops claiming half the table.

**Architecture:** `TableBuilder.autoFitColumns()` sets a flag; `resolveColumnWidths(total)` does the measuring, because that is the only place the column budget exists. Distribution is proportional to max-content, floored at min-content. `mdflow.ts` calls it for every Markdown table; hand-built tables opt in, so their output is unchanged.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-table-autofit-columns-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **TDD.** Write the failing test, run it, watch it fail, then implement.
- **`npm run typecheck && npm test` must be green before every commit.**
- **Hand-built tables must not change.** Auto-fit is opt-in outside Markdown, so `test/table-slice-identity.test.ts` must stay green with no hash regenerated.
- **Never regenerate a byte-identity hash to make a failure go away** — find out what moved.
- **Option validation throws `TypeError` before allocating.** A table too narrow for its own content is a layout outcome, not a caller error: it falls back, it does not throw.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

## Measured baseline

Rendering this into a default A4 flow (451pt content width, 10pt text) today:

```
| Qty | Description |
| --: | :---------- |
| 12 | A reasonably long product description that needs room to breathe |
```

`Qty` is allotted ~225pt for content needing ~20pt, and `Description` wraps to
two lines starting at x=302. Auto-fit should give roughly 35pt / 415pt and stop
the wrapping.

---

### Task 1: Measure and distribute

**Files:**
- Modify: `src/tableauthor.ts` (new helpers near `measuringDriverFor` line 183; `TableBuilder` field + `autoFitColumns`; `continuationFrom` line 472; `resolveColumnWidths` line 495)
- Test: `test/table-autofit.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  TableBuilder.autoFitColumns(): this
  TableBuilder.resolveColumnWidths(totalWidth: number, opts?: { cellPadding?: number }): number[]
  ```
  and two module-private helpers, `cellExtents` and `autoFitWidths`.

- [ ] **Step 1: Write the failing test**

The arithmetic is pure — no `Document`, no page — which is why it is driven
through `resolveColumnWidths` directly. Create `test/table-autofit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createTable } from '../src/tableauthor.js';
import type { TextRun } from '../src/textdecor.js';

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('autoFitColumns', () => {
  it('splits proportionally to content, not equally', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow(['Qty', 'Description']);
    t.addRow(['12', 'A reasonably long product description that needs room']);
    t.autoFitColumns();
    const [qty, desc] = t.resolveColumnWidths(451);
    expect(desc).toBeGreaterThan(qty * 5);
    expect(sum([qty, desc])).toBeCloseTo(451, 6);
  });

  it('gives every column at least its natural width when they all fit', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow(['ab', 'cd']);          // both tiny against a 400pt budget
    t.autoFitColumns();
    const w = t.resolveColumnWidths(400);
    // Nothing wraps: each column is far wider than its content needs.
    expect(Math.min(...w)).toBeGreaterThan(20);
    expect(sum(w)).toBeCloseTo(400, 6);
  });

  it('shrinks columns together when the content cannot fit', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow([
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    ]);
    t.autoFitColumns();
    const [a, b] = t.resolveColumnWidths(120);
    // Both are squeezed; neither collapses, and the wider content keeps the
    // larger share.
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(sum([a, b])).toBeCloseTo(120, 6);
  });

  it('raises a squeezed column to its longest word', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    // One column holds a single long unbreakable word; the other holds a very
    // long sentence, so pure proportionality would starve the first.
    t.addRow(['Supercalifragilistic', `${'word '.repeat(120)}`]);
    t.autoFitColumns();
    const [word, sentence] = t.resolveColumnWidths(300);
    // 'Supercalifragilistic' at 10pt Helvetica is ~95pt; proportionality alone
    // would give this column under 10pt.
    expect(word).toBeGreaterThan(80);
    expect(sentence).toBeGreaterThan(0);
    expect(sum([word, sentence])).toBeCloseTo(300, 6);
  });

  it('falls back to equal shares when the floors cannot be met', () => {
    const t = createTable({ fontSize: 10, padding: 2 });
    t.addRow(['Supercalifragilisticexpialidocious', 'Antidisestablishmentarianism']);
    t.autoFitColumns();
    // Far too narrow for either longest word.
    const w = t.resolveColumnWidths(40);
    expect(w[0]).toBeCloseTo(20, 6);
    expect(w[1]).toBeCloseTo(20, 6);
  });

  it('lets an explicit setColumnWidths win', () => {
    const t = createTable({ fontSize: 10 });
    t.addRow(['Qty', 'Description']);
    t.autoFitColumns();
    t.setColumnWidths([{ fixed: 100 }, { fraction: 1 }]);
    expect(t.resolveColumnWidths(400)).toEqual([100, 300]);
  });

  it('ignores a spanning cell when sizing columns', () => {
    const withSpan = createTable({ fontSize: 10, padding: 2 });
    withSpan.addRow().addCell('a very wide spanning banner across both', { colSpan: 2 });
    withSpan.addRow(['Qty', 'Description text here']);
    withSpan.autoFitColumns();

    const withoutSpan = createTable({ fontSize: 10, padding: 2 });
    withoutSpan.addRow(['Qty', 'Description text here']);
    withoutSpan.autoFitColumns();

    // The banner belongs to no single column, so it must not move either one.
    expect(withSpan.resolveColumnWidths(400))
      .toEqual(withoutSpan.resolveColumnWidths(400));
  });

  it("measures a run cell at each run's own font", () => {
    const plain = createTable({ fontSize: 10, padding: 2 });
    plain.addRow(['MMMM', 'x']);
    plain.autoFitColumns();

    const bold = createTable({ fontSize: 10, padding: 2 });
    bold.addRow()
      .addCell([{ text: 'MMMM', font: 'Helvetica-Bold' }] as TextRun[])
      .addCell('x');
    bold.autoFitColumns();

    // Helvetica-Bold 'MMMM' is wider than Helvetica 'MMMM', so its column
    // claims more of the same budget. Measuring the joined string at the
    // block font would make these two identical.
    expect(bold.resolveColumnWidths(400)[0])
      .toBeGreaterThan(plain.resolveColumnWidths(400)[0]);
  });

  it('sizes a multi-line cell to its longest line, not the whole string', () => {
    const oneLine = createTable({ fontSize: 10, padding: 2 });
    oneLine.addRow(['alpha beta', 'x']);
    oneLine.autoFitColumns();

    const twoLines = createTable({ fontSize: 10, padding: 2 });
    twoLines.addRow(['alpha beta\nalpha beta', 'x']);
    twoLines.autoFitColumns();

    // Measuring across the newline would demand roughly double the width.
    expect(twoLines.resolveColumnWidths(400)[0])
      .toBeCloseTo(oneLine.resolveColumnWidths(400)[0], 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/table-autofit.test.ts`
Expected: FAIL — `t.autoFitColumns is not a function`.

- [ ] **Step 3: Add the two measuring helpers to `src/tableauthor.ts`**

Insert immediately after `measuringDriverFor` (around line 187):

```ts
/** @internal One piece of a cell's content with the font it measures at. */
interface CellPiece { text: string; driver: FontDriver; fontSize: number }

/** Width of the concatenated pieces' [from, to) slice, measured piece by piece
 *  so each keeps its own font. Summing per piece agrees exactly with measuring
 *  the whole string for the WinAnsi and Identity-H drivers — a string's width is
 *  the sum of its glyph advances — which is the rule layoutRuns already uses. */
function sliceWidth(pieces: CellPiece[], from: number, to: number): number {
  let w = 0;
  let at = 0;
  for (const p of pieces) {
    const s = Math.max(from, at);
    const e = Math.min(to, at + p.text.length);
    if (e > s) w += p.driver.measure(p.text.slice(s - at, e - at), p.fontSize);
    at += p.text.length;
  }
  return w;
}

/** The widest single LINE (max-content) and widest single WORD (min-content) of
 *  a cell's content, in points, excluding padding.
 *
 *  Lines rather than the whole string: a cell may carry a hard break — addCell
 *  takes arbitrary text and mdruns.ts maps a linebreak to '\n' — and measuring
 *  across one would demand a column wide enough for every line at once.
 *
 *  Words are found on the CONCATENATED run text, because a word may span a run
 *  boundary (`**bold**text` is one word), which is what layoutRuns does for
 *  break opportunities; each piece is still measured at its own run's font.
 *  Only U+0020 and '\n' break, so the U+00A0 a code block paints for
 *  indentation keeps its line intact. */
function cellExtents(
  text: string | TextRun[], st: ResolvedStyle,
): { longestLine: number; longestWord: number } {
  const pieces: CellPiece[] = isTextRunList(text)
    ? text.map((r) => ({
      text: r.text,
      driver: measuringDriverFor(r.font ?? st.font),
      fontSize: r.fontSize ?? st.fontSize,
    }))
    : [{ text, driver: measuringDriverFor(st.font), fontSize: st.fontSize }];
  const all = pieces.map((p) => p.text).join('');
  let longestLine = 0;
  let longestWord = 0;
  let lineStart = 0;
  let wordStart = 0;
  for (let i = 0; i <= all.length; i++) {
    const ch = i < all.length ? all[i] : '\n';
    if (ch !== '\n' && ch !== ' ') continue;
    if (i > wordStart) longestWord = Math.max(longestWord, sliceWidth(pieces, wordStart, i));
    wordStart = i + 1;
    if (ch === '\n') {
      longestLine = Math.max(longestLine, sliceWidth(pieces, lineStart, i));
      lineStart = i + 1;
    }
  }
  return { longestLine, longestWord };
}

/** Distribute `total` across columns from their measured content.
 *
 *  Proportional to max-content handles both regimes with one rule: when the
 *  natural widths fit, every column gets its need plus a share of the slack;
 *  when they do not, all shrink together rather than one collapsing. Anything
 *  landing under its min-content is then raised to it, and the shortfall taken
 *  proportionally from the columns still above their own floor. */
function autoFitWidths(max: number[], min: number[], total: number): number[] {
  const n = max.length;
  const maxSum = max.reduce((a, b) => a + b, 0);
  const minSum = min.reduce((a, b) => a + b, 0);
  // Nothing can satisfy the floors (or there is no content to go on): equal
  // shares is the honest answer rather than an arbitrary winner. Not an error —
  // a table too narrow for its own words is a layout outcome.
  if (minSum > total || maxSum <= 0) return new Array<number>(n).fill(total / n);
  const w = max.map((m) => (total * m) / maxSum);
  const under = w.map((x, i) => x < min[i]);
  if (!under.some(Boolean)) return w;
  let shortfall = 0;
  let slack = 0;
  for (let i = 0; i < n; i++) {
    if (under[i]) { shortfall += min[i] - w[i]; w[i] = min[i]; } else slack += w[i] - min[i];
  }
  // slack >= shortfall always: Σ(w − min) = total − minSum >= 0, and the columns
  // under their floor contribute −shortfall to that sum, so the rest hold at
  // least shortfall between them. The redistribution lands exactly on `total`.
  if (slack > 0) {
    for (let i = 0; i < n; i++) if (!under[i]) w[i] -= (shortfall * (w[i] - min[i])) / slack;
  }
  return w;
}
```

- [ ] **Step 4: Add the flag, the method, and the per-column measurement**

In `TableBuilder`, beside `private columnSpecs?: ColumnWidth[]` (line 406):

```ts
  /** @internal Set by {@link autoFitColumns}; read by resolveColumnWidths. */
  private autoFit = false;
```

Add the public method beside `setColumnWidths`:

```ts
  /** Size columns from their content rather than splitting the width equally:
   *  proportional to each column's widest unwrapped line, floored at its widest
   *  single word. Chainable.
   *
   *  The measuring happens at resolve time, not here, because the column budget
   *  is not known until the table is placed — it differs between a one-column
   *  and a two-column flow, and again on a continuation.
   *
   *  An explicit {@link setColumnWidths} wins: a stated width is a decision, a
   *  measured one is a guess. */
  autoFitColumns(): this {
    this.autoFit = true;
    return this;
  }
```

and the per-column measurement as a private method:

```ts
  /** @internal Max-content and min-content width per column, including each
   *  contributing cell's horizontal padding. */
  private contentWidths(tablePadding?: number): { max: number[]; min: number[] } {
    const n = this.columnCount();
    const max = new Array<number>(n).fill(0);
    const min = new Array<number>(n).fill(0);
    for (const row of this.rows) {
      let c = 0;
      for (const cell of row.cells) {
        // A spanning cell contributes to no single column: attributing its
        // width to one of the columns it covers would be arbitrary, which is
        // the choice CSS auto-layout makes for the same reason.
        if (cell.colSpan === 1 && c < n) {
          const st = resolveCellStyle(cell, row.style, this.defaults, tablePadding);
          const pad = st.padding.left + st.padding.right;
          const { longestLine, longestWord } = cellExtents(cell.text, st);
          max[c] = Math.max(max[c], longestLine + pad);
          min[c] = Math.max(min[c], longestWord + pad);
        }
        c += cell.colSpan;
      }
    }
    return { max, min };
  }
```

- [ ] **Step 5: Branch `resolveColumnWidths`**

Give it the optional second parameter and the auto-fit branch. The padding
override matters: `drawTable` passes a draw-time `cellPadding` that stands in
for the table level, and padding is part of a column's natural width.

```ts
  resolveColumnWidths(totalWidth: number, opts: { cellPadding?: number } = {}): number[] {
    if (typeof totalWidth !== 'number' || !Number.isFinite(totalWidth) || totalWidth <= 0)
      throw new TypeError('totalWidth must be a positive finite number');
    const n = this.columnCount();
    if (n === 0) return [];
    // Explicit widths win over a measurement.
    if (this.autoFit && this.columnSpecs === undefined) {
      const { max, min } = this.contentWidths(opts.cellPadding);
      return autoFitWidths(max, min, totalWidth);
    }
    const specs = this.columnSpecs ?? Array.from({ length: n }, () => ({ fraction: 1 } as ColumnWidth));
    // ... rest unchanged ...
```

- [ ] **Step 6: Carry the flag into a continuation**

`continuationFrom` already copies `columnSpecs`; without the flag too, the
second page of a paginated auto-fit table would revert to equal fractions and
its columns would jump. Beside `t.columnSpecs = this.columnSpecs;` (line 478):

```ts
    t.autoFit = this.autoFit;
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run test/table-autofit.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 8: Confirm the min-content floor is load-bearing**

Temporarily make `autoFitWidths` return `w` immediately after the proportional
step (before the `under` computation). Re-run. Expected: "raises a squeezed
column to its longest word" goes red. Restore.

- [ ] **Step 9: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean. Nothing calls `autoFitColumns` yet, so no rendering changes and
`test/table-slice-identity.test.ts` is untouched.

```bash
git add src/tableauthor.ts test/table-autofit.test.ts
git commit -m "$(cat <<'EOF'
feat(table): autoFitColumns, sizing columns from their content

Proportional to max-content, floored at min-content, with equal shares when the
floors cannot be met — a table too narrow for its own words is a layout outcome,
not a caller error. The measuring happens at resolve time because the column
budget does not exist until the table is placed, and a continuation carries the
flag so a paginated table's columns do not jump.

A spanning cell sizes no column: its width belongs to none of them.

Nothing calls this yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire it into Markdown

**Files:**
- Modify: `src/mdflow.ts` (`mdTable`)
- Modify: `src/tablerender.ts` (`drawTable`'s `resolveColumnWidths` call, line ~283)
- Modify: `src/flowtable.ts` (`TableElement.metrics`)
- Test: `test/markdown-tables.test.ts` (append)

**Interfaces:**
- Consumes: `autoFitColumns()`, `resolveColumnWidths(total, { cellPadding })` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-tables.test.ts`:

```ts
describe('Markdown tables size to their content', () => {
  const WIDE = [
    '| Qty | Description |',
    '| --: | :---------- |',
    '| 12 | A reasonably long product description that needs room to breathe |',
  ].join('\n');

  it('stops the wide column wrapping that equal fractions forced', () => {
    const { pages } = render(WIDE);
    const frags = pages[0].GetTextFragments();
    // Measured before this change: the description wrapped onto a second line
    // at 'needs room to breathe'. Auto-fit gives it the width to stay on one.
    const desc = frags.filter((f) => f.text.includes('reasonably'));
    expect(desc.length).toBe(1);
    expect(desc[0].text).toContain('breathe');
  });

  it('gives the narrow column much less than half the table', () => {
    const { pages } = render(WIDE);
    const frags = pages[0].GetTextFragments();
    const qty = frags.find((f) => f.text.trim() === 'Qty')!;
    const desc = frags.find((f) => f.text.includes('Description'))!;
    // The Description column starts where the Qty column ends, so an early
    // start means Qty is narrow. Equal fractions put this near x=302.
    expect(desc.quad[0]).toBeLessThan(150);
    expect(qty.quad[0]).toBeLessThan(desc.quad[0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/markdown-tables.test.ts`
Expected: FAIL — the description is still two fragments, and the second column
still starts around x=302.

- [ ] **Step 3: Call it from `src/mdflow.ts`**

In `mdTable`, immediately before the `return t;`:

```ts
  // GFM declares no column widths, so equal fractions would give a two-character
  // 'Qty' column the same share as a paragraph of description.
  t.autoFitColumns();
```

- [ ] **Step 4: Pass the padding override through in `src/tablerender.ts`**

In `drawTable`, the `cellPadding` override stands in for the table level, so it
belongs in the measurement:

```ts
  const widths = table.resolveColumnWidths(opts.width, { cellPadding: opts.cellPadding });
```

- [ ] **Step 5: Pass it through in `src/flowtable.ts`**

In `TableElement.metrics`:

```ts
    const widths = this.t.resolveColumnWidths(
      this.o.width ?? width, { cellPadding: this.o.cellPadding });
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run test/markdown-tables.test.ts`
Expected: PASS. If the existing alignment case ("honours the column alignment")
fails, read it before changing it: it asserts a right-aligned column's text ends
further right than a left-aligned column's, which should survive new widths. A
failure there means the assertion was fragile about absolute position rather
than about alignment, and it should be rewritten to say what it means — not
retuned to the new numbers.

- [ ] **Step 7: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean, and `test/table-slice-identity.test.ts` green — `page.AddTable`
never calls `autoFitColumns`, so its bytes cannot move.

- [ ] **Step 8: Commit**

```bash
git add src/mdflow.ts src/tablerender.ts src/flowtable.ts test/markdown-tables.test.ts
git commit -m "$(cat <<'EOF'
feat(markdown): tables size their columns to their content

GFM declares no widths, so equal fractions gave a two-character Qty column the
same share as a paragraph of description — measured at ~225pt of 451 for content
needing 20, with the description wrapping to two lines as a result.

Hand-built tables are unchanged: autoFitColumns is opt-in outside Markdown, so
table-slice-identity's hash cannot move.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md`'s Markdown limitation**

In the Limitations bullet beginning "**Markdown rendering covers the block and
inline vocabulary**", replace this sentence:

```
A table's columns are always equal fractions of the flow column, since GFM declares no widths — use `flow.AddTable` with `setColumnWidths` for control.
```

with:

```
A table's columns are sized from their content (proportional to each column's widest unwrapped line, floored at its widest word), since GFM declares no widths — use `flow.AddTable` with `setColumnWidths` for exact control.
```

- [ ] **Step 2: Add the method to `README.md`'s table bullet**

In the **Table authoring** feature bullet, after the `setRepeatingRowsCount(n)`
mention, add:

```
`table.autoFitColumns()` sizes columns from their content instead of splitting the width equally — proportional to each column's widest unwrapped line, floored at its widest single word, and falling back to equal shares when even the floors do not fit. Markdown tables use it by default; hand-built ones opt in.
```

- [ ] **Step 3: Add the invariants to `CLAUDE.md`**

In the `tableauthor.ts` / `tablerender.ts` entry, append:

```markdown
  **Invariant:** auto-fit measures at RESOLVE time, not at build time. The
  column budget arrives when the table is placed and differs between a
  one-column and a two-column flow, and again on a continuation — so widths
  computed up front could only be fractions, and a fraction cannot carry the
  min-content floor, which depends on the total.
  **Invariant:** `continuationFrom` carries the auto-fit flag as well as the
  column specs. Without it the second page of a paginated table reverts to equal
  fractions and its columns visibly jump mid-table.
  **Invariant:** an explicit `setColumnWidths` outranks `autoFitColumns` — a
  stated width is a decision, a measured one is a guess — and a `colSpan` cell
  sizes no column at all, since its width belongs to none of them.
  **Invariant:** auto-fit is opt-in for hand-built tables and default for
  Markdown. GFM declares no widths so Markdown has nothing to lose, while
  `page.AddTable` callers have `setColumnWidths` and a byte-identity fence.
  **Invariant:** a cell's max-content is its longest LINE, not its whole string
  — `addCell` takes arbitrary text and `mdruns.ts` maps a hard break to `'\n'`,
  and measuring across one would demand a column fitting every line at once. Its
  min-content is its longest word found on the CONCATENATED run text, because a
  word may span a run boundary, with each piece measured at its own run's font.
```

- [ ] **Step 4: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(table): record the auto-fit column rules

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing the issue

- [ ] **Run the whole gate**

```bash
npm run typecheck
npm test
npm run build
```

All three green, with `test/table-slice-identity.test.ts` and
`test/rich-runs-identity.test.ts` passing on their recorded hashes.

- [ ] **Close and push**

```bash
bd close aspose-pdf-foss-for-ts-qdat
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```
