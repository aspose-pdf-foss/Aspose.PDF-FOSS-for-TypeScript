# Per-line Leading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each wrapped line a height derived from its own runs, so a run larger than its block stops overrunning the line above it.

**Architecture:** `layoutRuns` computes each line's height while wrapping — it is the function that decides which lines fit the budget, so it must know. `LaidLine` carries `height` and `maxFontSize`; `stamp.ts` derives baselines and `usedHeight` from them, and `tableauthor.ts` sums them for row heights. The rule `max(leading, maxRunSize × leading/fontSize)` collapses to `leading` for any line whose runs sit at or below the block size, which is why no existing caller's bytes move.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-per-line-leading-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **TDD.** Write the failing test, run it, watch it fail, then implement.
- **`npm run typecheck && npm test` must be green before every commit.**
- **All 14 `test/rich-runs-identity.test.ts` hashes and `test/table-slice-identity.test.ts` must stay green with none regenerated.** They are the fence for this whole change. If one moves, the `max` did not collapse where it should have — find out why rather than re-recording.
- **`num()` rounds to 1e-6** (`Math.round(n * 1e6) / 1e6`), so a baseline delta accumulated as a difference of sums still prints identically to a constant `-leading`. This is what makes the per-line `Td` byte-safe.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

## Measured baseline

A 24pt run inside a 10pt block with 12pt leading, in a 250pt-wide box:

```
baseline=690.0  top=700.0  size=10  "ordinary body text that wraps onto a sec…"
baseline=678.0  top=688.0  size=10  "there is something above "
baseline=678.0  top=702.0  size=24  "HUGE "          <- top 702 > 700, overlaps
baseline=666.0  top=676.0  size=10  "ordinary text continues after it…"
```

After the change the 24pt fragment's top must sit at or below the previous
line's baseline (690).

---

### Task 1: `layoutRuns` computes per-line heights

**Files:**
- Modify: `src/layout.ts` (`LaidLine` line 56; `layoutRuns` signature line 143; phase B line 247; the `lines.push` at line 288; `layoutText` line 333)
- Test: `test/line-height.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  interface LaidLine { …; maxFontSize: number; height: number }
  function layoutRuns(
    runs: LayoutRun[], boxWidth: number, boxHeight: number,
    leading: number, blockFontSize: number,
  ): RunLayoutResult
  ```
  `layoutText` keeps its signature — it already receives `fontSize` and passes it through.

- [ ] **Step 1: Write the failing test**

Create `test/line-height.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { layoutRuns, winAnsiDriver } from '../src/layout.js';
import type { LayoutRun } from '../src/layout.js';

const d = winAnsiDriver('Helvetica');
const run = (text: string, fontSize: number): LayoutRun => ({ text, driver: d, fontSize });

describe('per-line height', () => {
  it('is the block leading when every run is at the block size', () => {
    const { lines } = layoutRuns([run('alpha beta gamma', 10)], 400, 400, 12, 10);
    expect(lines.length).toBe(1);
    expect(lines[0].height).toBe(12);
    expect(lines[0].maxFontSize).toBe(10);
  });

  it('scales the block ratio for a larger run', () => {
    // ratio = 12/10 = 1.2, so a 24pt run wants 28.8.
    const { lines } = layoutRuns([run('small ', 10), run('BIG', 24)], 400, 400, 12, 10);
    expect(lines.length).toBe(1);
    expect(lines[0].maxFontSize).toBe(24);
    expect(lines[0].height).toBeCloseTo(28.8, 9);
  });

  it('keeps the block leading for a SMALLER run', () => {
    // The max is a floor: a small run must not tighten the line.
    const { lines } = layoutRuns([run('big ', 10), run('tiny', 4)], 400, 400, 12, 10);
    expect(lines[0].height).toBe(12);
  });

  it('preserves a double-spaced block ratio around the big run', () => {
    // ratio = 20/10 = 2, so a 24pt run wants 48 rather than 28.8.
    const { lines } = layoutRuns([run('small ', 10), run('BIG', 24)], 400, 400, 20, 10);
    expect(lines[0].height).toBeCloseTo(48, 9);
  });

  it('fits fewer lines in a fixed budget once one line is tall', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta';
    // Narrow box, 4 lines' worth of height at the block leading.
    const flat = layoutRuns([run(words, 10)], 60, 48, 12, 10);
    const tall = layoutRuns([run('alpha ', 10), run('BETA', 24), run(` ${words}`, 10)],
      60, 48, 12, 10);
    expect(tall.lines.length).toBeLessThan(flat.lines.length);
    // And the kept lines' heights sum inside the budget.
    expect(tall.lines.reduce((n, l) => n + l.height, 0)).toBeLessThanOrEqual(48 + 1e-9);
  });

  it('uses the block size for a line with no runs on it', () => {
    // A blank paragraph line has no units to measure.
    const { lines } = layoutRuns([run('a\n\nb', 10)], 400, 400, 12, 10);
    expect(lines.every((l) => l.height === 12)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/line-height.test.ts`
Expected: FAIL — `layoutRuns` takes five arguments, not six, and `LaidLine` has
no `height`. TypeScript will also complain at the call sites in the test.

- [ ] **Step 3: Add the fields to `LaidLine` in `src/layout.ts`**

In the `LaidLine` interface, after `segments`:

```ts
  /** Largest `fontSize` among the runs with text on this line; the block's own
   *  size for a line with no text. The baseline sits this far below the line's
   *  band top, which is what keeps an oversized run inside the box. */
  maxFontSize: number;
  /** This line's band height: `max(leading, maxFontSize * leading / fontSize)`.
   *  The `max` collapses to `leading` for every line whose runs sit at or below
   *  the block size, which is what makes every existing caller byte-identical. */
  height: number;
```

- [ ] **Step 4: Take the block size and compute the heights**

Change the signature:

```ts
export function layoutRuns(
  runs: LayoutRun[], boxWidth: number, boxHeight: number,
  leading: number, blockFontSize: number,
): RunLayoutResult {
```

and add, immediately after the `spaceWidth` helper (around line 177):

```ts
  /** Largest run size with text in `units`; the block's size when there is
   *  none, so a blank line keeps ordinary leading. The separator space belongs
   *  to the run that ends the preceding unit, which is already covered. */
  const maxSizeOf = (units: Unit[]): number => {
    let m = 0;
    for (const u of units) {
      let i = u.start;
      while (i < u.end) {
        const r = owner[i];
        m = Math.max(m, runs[r].fontSize);
        while (i < u.end && owner[i] === r) i++;
      }
    }
    return m > 0 ? m : blockFontSize;
  };

  /** A line's band height. `blockFontSize` is validated positive by every entry
   *  point, so the ratio is finite; a caller who asked for `leading: 0` still
   *  gets 0. */
  const heightOf = (maxSize: number): number =>
    Math.max(leading, (maxSize * leading) / blockFontSize);
```

- [ ] **Step 5: Make phase B cumulative**

Replace the fitting loop (line 247):

```ts
  // --- Phase B: keep the lines whose bands fit the box height. ---
  // Cumulative rather than `kept * leading`: a line containing an oversized run
  // claims more of the budget than its neighbours.
  let used = 0;
  let kept = 0;
  const heights: number[] = [];
  while (kept < wrapped.length) {
    const h = heightOf(maxSizeOf(wrapped[kept].units));
    if (used + h > boxHeight + EPS) break;
    used += h;
    heights.push(h);
    kept++;
  }
```

- [ ] **Step 6: Put the fields on each line**

In the `lines.push({ … })` (line 288), add the two fields. Recompute
`maxFontSize` rather than threading it from phase B, so the line carries its own
truth:

```ts
    const maxFontSize = maxSizeOf(wrapped[k].units);
    lines.push({
      text: segments.map((s) => s.text).join(''),
      width: segments.reduce((n, s) => n + s.width, 0),
      bytes: segments.length === 1 ? segments[0].bytes : concatBytes(segments),
      hardBreak: wrapped[k].sepAfter === '\n' || k === kept - 1,
      segments,
      maxFontSize,
      height: heights[k],
    });
```

- [ ] **Step 7: Pass the size through from `layoutText`**

```ts
  const { lines, remainder } = layoutRuns(
    [{ text, driver, fontSize }], boxWidth, boxHeight, leading, fontSize);
```

Its single run is at the block size, so `max(leading, fontSize * leading /
fontSize)` is `leading` and every string-path caller is unchanged.

- [ ] **Step 8: Fix the three other `layoutRuns` call sites**

They already hold the block size; without this the build fails.

`src/stamp.ts` (the `flowTextBlock` runs branch, around line 820):

```ts
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), w, h, ro.leading, ro.fontSize);
```

`src/stamp.ts` (the `measureTextBlock` runs branch, around line 902):

```ts
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), width, availHeight, o.leading, o.fontSize);
```

`src/tableauthor.ts` (in `measure`, around line 705): add `st.fontSize` as the
final argument of the `layoutRuns(...)` call.

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/line-height.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 10: Confirm the `max` floor is load-bearing**

Temporarily change `heightOf` to `(maxSize * leading) / blockFontSize` with no
`Math.max`. Re-run. Expected: "keeps the block leading for a SMALLER run" goes
red. Restore.

- [ ] **Step 11: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean. Nothing reads `height` yet, so no rendering changes.

```bash
git add src/layout.ts src/stamp.ts src/tableauthor.ts test/line-height.test.ts
git commit -m "$(cat <<'EOF'
feat(layout): each line carries its own band height

max(leading, maxRunSize * leading / fontSize), computed while wrapping because
layoutRuns is what decides which lines fit the budget — a caller computing
heights afterwards would disagree with the wrapping about what fitted. The max
collapses to `leading` for any line whose runs sit at or below the block size,
which is every line every existing caller produces.

Phase B is cumulative rather than kept * leading. Nothing reads the new fields
yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Baselines and `usedHeight` follow the line heights

**Files:**
- Modify: `src/stamp.ts` (`firstBaseline`; `buildRunBlockBody`; `buildBlockBody`; `buildShapedBlockBody`; `segmentBoxes`; `blockLineBoxes`; the `usedHeight` returns in `flowTextBlock` and `measureTextBlock`)
- Test: `test/line-height.test.ts` (append)

**Interfaces:**
- Consumes: `LaidLine.height`, `LaidLine.maxFontSize` (Task 1).
- Produces: two module-private helpers in `stamp.ts`:
  ```ts
  function blockTopOf(y: number, h: number, lines: LaidLine[], o: NormalizedBlockOptions): number
  function lineBaselines(lines: LaidLine[], blockTop: number): number[]
  ```
  replacing `firstBaseline`.

- [ ] **Step 1: Write the failing test**

Append to `test/line-height.test.ts`:

```ts
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { measureTextBlock } from '../src/stamp.js';
import type { TextRun } from '../src/textdecor.js';

const RUNS: TextRun[] = [
  { text: 'ordinary body text that wraps onto a second line so there is something above ' },
  { text: 'HUGE', fontSize: 24 },
  { text: ' and then ordinary text continues after it for a while longer here' },
];

describe('an oversized run in a rendered block', () => {
  it('no longer overruns the line above it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(RUNS, [50, 400, 250, 300], { fontSize: 10, leading: 12 });
    const frags = page.GetTextFragments().sort((a, b) => b.quad[1] - a.quad[1]);
    const big = frags.find((f) => f.fontSize === 24)!;
    // Every fragment strictly above the big one must clear its top. Measured
    // before this change: the 24pt top was 702 against a baseline of 690 above.
    const above = frags.filter((f) => f.quad[1] > big.quad[1]);
    expect(above.length).toBeGreaterThan(0);
    for (const f of above) expect(big.quad[3]).toBeLessThanOrEqual(f.quad[1] + 1e-6);
  });

  it('keeps an oversized run on line 0 inside the block', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const top = 400 + 300;      // rect [50, 400, 250, 300] -> top edge at 700
    page.AddTextBlock(
      [{ text: 'HUGE', fontSize: 24 }, { text: ' then ordinary text after it' }],
      [50, 400, 250, 300], { fontSize: 10, leading: 12 },
    );
    const big = page.GetTextFragments().find((f) => f.fontSize === 24)!;
    expect(big.quad[3]).toBeLessThanOrEqual(top + 1e-6);
  });

  it('reports a larger usedHeight for a block with an oversized run', () => {
    const flat = measureTextBlock(
      [{ text: 'alpha beta gamma' }] as TextRun[], 400, 400, { fontSize: 10, leading: 12 });
    const tall = measureTextBlock(
      [{ text: 'alpha ' }, { text: 'BETA', fontSize: 24 }, { text: ' gamma' }] as TextRun[],
      400, 400, { fontSize: 10, leading: 12 });
    expect(flat.usedHeight).toBeCloseTo(12, 9);
    expect(tall.usedHeight).toBeCloseTo(28.8, 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/line-height.test.ts`
Expected: the three new cases FAIL — the big fragment still overruns, and
`usedHeight` is still 12 for both blocks.

- [ ] **Step 3: Replace `firstBaseline` in `src/stamp.ts`**

Delete `firstBaseline` and put these two in its place:

```ts
/** The top edge of the laid block within [y, y+h], after vertical alignment.
 *  The block's height is the sum of its line bands, not `lines * leading`. */
function blockTopOf(
  y: number, h: number, lines: LaidLine[], o: NormalizedBlockOptions,
): number {
  let blockHeight = 0;
  for (const l of lines) blockHeight += l.height;
  const valignOffset = o.valign === 'center' ? (h - blockHeight) / 2
    : o.valign === 'bottom' ? h - blockHeight : 0;
  return y + h - valignOffset;
}

/** Each line's baseline, top-down. A line occupies a band of its own height and
 *  sits `maxFontSize` below that band's top.
 *
 *  This reduces exactly to `blockTop - fontSize - i * leading` when every line
 *  is at the block size, which is the byte-identity argument — and `num()`
 *  rounds to 1e-6, so accumulating the bands prints the same as a constant
 *  step. Using `maxFontSize` rather than the block's `fontSize` is also what
 *  keeps an oversized run on line 0 inside the box. */
function lineBaselines(lines: LaidLine[], blockTop: number): number[] {
  const out: number[] = [];
  let bandTop = blockTop;
  for (const l of lines) {
    out.push(bandTop - l.maxFontSize);
    bandTop -= l.height;
  }
  return out;
}
```

- [ ] **Step 4: Use them in `buildRunBlockBody`**

Replace the `baseline0` line and the per-line `Td`:

```ts
  const baselines = lineBaselines(lines, blockTopOf(y, h, lines, o));
  const boxes = segmentBoxes(lines, x, w, baselines, o, runs);
  const dec = runDecorOps(boxes, runs);
```

and inside the emission loop:

```ts
    if (i === 0) s += `${num(x + offset)} ${num(baselines[0])} Td\n`;
    else s += `${num(offset - prevOffset)} ${num(baselines[i] - baselines[i - 1])} Td\n`;
```

- [ ] **Step 5: Take baselines in `segmentBoxes` and `blockLineBoxes`**

Both currently derive `baseline0 - i * o.leading`. Change each to accept the
array and index it.

`segmentBoxes`:

```ts
function segmentBoxes(
  lines: LaidLine[], x: number, w: number, baselines: number[],
  o: NormalizedBlockOptions, runs: ResolvedRun[],
): SegmentBox[] {
  const out: SegmentBox[] = [];
  lines.forEach((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    const baseline = baselines[i];
    // ... body unchanged ...
```

`blockLineBoxes`:

```ts
function blockLineBoxes(
  lines: LaidLine[], x: number, w: number, baselines: number[],
  o: NormalizedBlockOptions,
): LineBox[] {
  return lines.map((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    return {
      x: x + alignOffset(o.align, w, line.width),
      baseline: baselines[i],
      width: tw > 0 ? w : line.width,
    };
  });
}
```

- [ ] **Step 6: Update the two single-font body builders**

`buildBlockBody` (the string path) and `buildShapedBlockBody` both compute
`blockHeight`, `valignOffset` and `baseline0` inline and step by `-o.leading`.
Give each the same treatment:

```ts
  const baselines = lineBaselines(lines, blockTopOf(y, h, lines, o));
```

then `blockLineBoxes(lines, x, w, baselines, o)` for the decoration, and in each
emission loop:

```ts
    if (i === 0) s += `${num(x + offset)} ${num(baselines[0])} Td\n`;
    else s += `${num(offset - prevOffset)} ${num(baselines[i] - baselines[i - 1])} Td\n`;
```

Both take one run at the block size, so every line's height is `leading` and
their bytes are unchanged.

- [ ] **Step 7: Update `flowTextBlock`'s own `segmentBoxes` call**

`firstBaseline` has THREE call sites, not two — `buildRunBlockBody` (line 695),
`buildShapedBlockBody`, and `flowTextBlock`'s runs branch (line 825), which
builds its own boxes for the link rects. Miss the last and the link annotations
land on the old flat baselines while the ink uses the new ones. In
`flowTextBlock`:

```ts
      const boxes = segmentBoxes(
        lines, x, w, lineBaselines(lines, blockTopOf(y, h, lines, ro)), ro, resolved);
```

- [ ] **Step 8: Sum the heights for `usedHeight`**

There are five `lines.length * …leading` expressions to replace — three in
`flowTextBlock` (runs, shaped, string) and two in `measureTextBlock` (runs,
string). Add one helper beside `blockTopOf`:

```ts
/** A laid block's height: the sum of its line bands. */
function linesHeight(lines: LaidLine[]): number {
  let n = 0;
  for (const l of lines) n += l.height;
  return n;
}
```

and use `linesHeight(lines)` in each of the five places.

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run test/line-height.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 10: Check the byte-identity fence**

Run: `npx vitest run test/rich-runs-identity.test.ts test/table-slice-identity.test.ts`
Expected: PASS, all 15, with no hash regenerated. If one moves, the `max` failed
to collapse somewhere — find out where. Do NOT re-record.

- [ ] **Step 11: Confirm the maxFontSize baseline is load-bearing**

In `lineBaselines`, temporarily change `out.push(bandTop - l.maxFontSize)` to
`out.push(bandTop - l.height)` — a plausible-looking substitution that puts the
baseline a full band below the top rather than a font size.

Run: `npx vitest run test/line-height.test.ts`
Expected: "keeps an oversized run on line 0 inside the block" goes red, since
the whole block shifts down and the big glyphs move with it. Restore.

- [ ] **Step 12: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean.

```bash
git add src/stamp.ts test/line-height.test.ts
git commit -m "$(cat <<'EOF'
fix(text): an oversized run no longer overruns the line above

Baselines come from each line's own band rather than a constant leading step,
and usedHeight is the sum of the bands. Measured before: a 24pt run in a 10pt
block reached 2pt above the previous line's TOP, covering it outright; on line 0
it left the box entirely, which is why the baseline drops by the line's
maxFontSize rather than the block's fontSize.

Byte-identical for every existing caller by construction, not by luck: the max
collapses to `leading` for any line whose runs sit at or below the block size,
and num() rounds to 1e-6 so accumulating the bands prints the same as a constant
step.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: A table row accounts for an oversized cell run

**Files:**
- Modify: `src/tableauthor.ts` (`measure`, the `textHeight` computation around line 715)
- Test: `test/table-cell-runs.test.ts` (append)

**Interfaces:**
- Consumes: `LaidLine.height` (Task 1).

- [ ] **Step 1: Write the failing test**

Append to `test/table-cell-runs.test.ts`:

```ts
describe('a cell holding an oversized run', () => {
  it('makes its row tall enough for the big glyphs', () => {
    const flat = createTable({ fontSize: 10, leading: 12 });
    flat.addRow().addCell([{ text: 'alpha beta' }] as TextRun[]);

    const tall = createTable({ fontSize: 10, leading: 12 });
    tall.addRow().addCell(
      [{ text: 'alpha ' }, { text: 'BETA', fontSize: 24 }] as TextRun[]);

    // A row sized by lineCount * leading would report these as equal, and the
    // 24pt glyphs would spill into whatever sits above the row.
    expect(tall.measure([300]).rowHeights[0])
      .toBeGreaterThan(flat.measure([300]).rowHeights[0]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/table-cell-runs.test.ts`
Expected: FAIL — both rows measure the same, because the height is
`lineCount * st.leading`.

- [ ] **Step 3: Sum the line heights in `measure`**

Replace the two lines computing `lineCount` and `textHeight`:

```ts
        // Sum the line bands rather than lineCount * leading: a cell run larger
        // than the cell's font size claims a taller band, and a row sized on the
        // flat product would let its glyphs spill out of the row.
        const textHeight = res.lines.length === 0
          ? st.leading                       // an empty cell still occupies a line
          : res.lines.reduce((n, l) => n + l.height, 0);
```

`lineCount` is used only for `textHeight`, so it goes; if anything else in the
loop references it, keep it as `Math.max(1, res.lines.length)`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/table-cell-runs.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean, with `test/table-slice-identity.test.ts` green — its cells are
plain strings, so every line's height is `leading`.

```bash
git add src/tableauthor.ts test/table-cell-runs.test.ts
git commit -m "$(cat <<'EOF'
fix(table): a row fits a cell's oversized run

Row height sums the line bands rather than lineCount * leading, so a run larger
than the cell's font size no longer spills into the row above.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Documentation

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the `README.md` limitation**

In the Limitations bullet beginning "**Markdown rendering covers the block and
inline vocabulary**", delete this sentence:

```
Leading is per block, not per line, so a run whose `fontSize` exceeds the block's can collide with the line above it.
```

Nothing replaces it — the limitation no longer exists. Leave the rest of the
bullet untouched.

- [ ] **Step 2: Replace the `CLAUDE.md` note**

In the `graphics.ts` / `layout.ts` entry, replace the note beginning
"**Note:** leading stays block-level" (and its two following sentences about
`usedHeight = lines * leading`) with:

```markdown
  **Invariant:** a line's height is `max(blockLeading, maxRunSize *
  blockLeading / blockFontSize)`, computed in `layoutRuns` while wrapping —
  that function decides which lines fit the budget, so a caller computing
  heights afterwards would disagree with the wrapping about what fitted. The
  `max` collapses to `blockLeading` for any line whose runs sit at or below the
  block size, which is every line the string path and every pre-`g61q` caller
  produces; that collapse, not a recorded hash, is why the change is
  byte-identical.
  **Invariant:** a line's baseline sits `maxFontSize` below its band top, NOT
  the block's `fontSize`. With the block size, an oversized run on line 0 leaves
  the box entirely rather than merely crowding a neighbour — measured at 2pt
  above the previous line's top for a 24pt run in a 10pt block.
  **Invariant:** `usedHeight` is the SUM of the line bands, and the flow engine
  reads it without re-deriving it — which is why pagination, keep-with-next and
  the column budget needed no change at all when leading became per-line.
```

- [ ] **Step 3: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(layout): record the per-line height rules

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

All three green, with `test/rich-runs-identity.test.ts` (14 hashes) and
`test/table-slice-identity.test.ts` (1 hash) passing as recorded.

- [ ] **Close and push**

```bash
bd close aspose-pdf-foss-for-ts-g61q
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```
