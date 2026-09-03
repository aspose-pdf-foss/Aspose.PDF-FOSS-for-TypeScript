# Inline atomics in layoutRuns — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** let the one wrapping engine place a non-text box in a line, so an
`<img>` among words renders instead of being reported.

**Architecture:** an atomic is a U+FFFC character in `layoutRuns`'s
concatenated text, so the whole index-based walk works unchanged; a new pure
leaf `linebox.ts` owns the baseline and band arithmetic; `stamp.ts` advances
the pen with a `TJ` kern and draws the image beside the text object. Atomics
travel in a channel PARALLEL to `TextRun[]`, which therefore does not change.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, no runtime
dependencies.

**Spec:** `docs/superpowers/specs/2026-09-01-inline-atomics-design.md` — read
it first. Its "What the issue got right, and what it got wrong" section is why
this plan spends almost nothing on word units and a whole task on the pen.

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only.
- **ESM + NodeNext.** Every import specifier carries a `.js` extension.
- **`src/linebox.ts` imports NOTHING** and knows no font. It never throws.
- **`src/textdecor.ts` MUST NOT CHANGE.** Atomics ride a parallel channel.
  If a task makes you want to add a field to `TextRun`, STOP — that is the
  design decision this plan is built on.
- **`test/rich-runs-identity.test.ts` IS THE ACCEPTANCE CRITERION AND IS NOT
  EDITED.** Four hashes over eight call sites, confirmed red on a 0.01pt nudge
  to `alignOffset`. Run it at the end of Tasks 2, 3, 4, 5 and 6. If it goes
  red, STOP — the design claims the arithmetic COLLAPSES to today's exactly
  when no atomic is present, so a red hash means that claim is wrong and the
  design needs revisiting, not the fence.
- **Markdown is not touched.** `mdflow.ts` and `mdruns.ts` keep `loneImage`;
  lifting it is a separate issue in `gl6o`'s epic.
- **`vertical-align: middle` is NOT implemented** and stays reported.
- **Run `npm run typecheck` and `npm test` before the final commit.**
- **Mutation-check every rule** (Task 11). Anything that reddens nothing is
  recorded in `CLAUDE.md` as uncovered, not quietly kept.

## File structure

| File | Responsibility |
|---|---|
| `src/linebox.ts` *(new)* | Baseline ascent + band height from item extents. Pure, no font, no imports. |
| `src/layout.ts` | `LayoutRun` union; U+FFFC placeholder; atomic widths; the over-wide clamp; `LaidSegment.atomic`. |
| `src/stamp.ts` | Interleaves runs + atomics; the `TJ` pen kern; draws each image; rebuilds the remainder's atomics. |
| `src/flow.ts` | `FlowAtomic` (bytes, not a `PdfStream`); `paragraph({ atomics })`; carries remainder atomics into the continuation. |
| `src/imageembed.ts` | `imageSize(data)` — intrinsic pixels from the header. |
| `src/cssinline.ts` | Splits the `vertical-align` report: an atomic reports only an unimplemented value. |
| `src/cssflow.ts` | CSS sizing in px, one `× 0.75`, drops the two atomic skip sites. |

---

### Task 1: `linebox.ts` — the band arithmetic

**Files:**
- Create: `src/linebox.ts`
- Test: `test/linebox.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface LineItem {
    ascent: number;
    height: number;
    align: 'baseline' | 'top' | 'bottom';
  }
  export function lineBox(
    items: LineItem[], leading: number, blockFontSize: number,
  ): { ascent: number; height: number };
  ```

- [ ] **Step 1: Write the failing test**

Create `test/linebox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { lineBox, type LineItem } from '../src/linebox.js';

const text = (fontSize: number): LineItem =>
  ({ ascent: fontSize, height: fontSize, align: 'baseline' });
const img = (h: number, align: LineItem['align'] = 'baseline'): LineItem =>
  ({ ascent: align === 'baseline' ? h : 0, height: h, align });

describe('lineBox', () => {
  it('reduces to the pre-zch2.11 arithmetic for text alone', () => {
    // THE acceptance criterion. Before this module the rule was
    //   ascent = max fontSize among runs with text, else blockFontSize
    //   height = max(leading, ascent * leading / blockFontSize)
    // and rich-runs-identity's four hashes depend on it character for
    // character. This must be a COLLAPSE, not a tolerance.
    expect(lineBox([text(10), text(10)], 12, 10)).toEqual({ ascent: 10, height: 12 });
    expect(lineBox([text(24), text(10)], 12, 10))
      .toEqual({ ascent: 24, height: (24 * 12) / 10 });
  });

  it('falls back to the block size for a line with no items', () => {
    // A blank line keeps ordinary leading rather than collapsing to zero.
    expect(lineBox([], 12, 10)).toEqual({ ascent: 10, height: 12 });
  });

  it('lets a baseline-aligned image raise the ascent, moving the baseline', () => {
    // Its bottom sits ON the baseline, so its above-baseline extent is its
    // full height — which is why maxFontSize had to be FED, not replaced.
    expect(lineBox([text(10), img(30)], 12, 10))
      .toEqual({ ascent: 30, height: (30 * 12) / 10 });
  });

  it('lets a TOP-aligned image raise the band WITHOUT moving the baseline', () => {
    // top/bottom align to the BAND, not the baseline. This is the second term
    // the model needed and the reason `middle` was excluded rather than
    // guessed at.
    expect(lineBox([text(10), img(40, 'top')], 12, 10))
      .toEqual({ ascent: 10, height: 40 });
  });

  it('does the same for a BOTTOM-aligned image', () => {
    expect(lineBox([text(10), img(40, 'bottom')], 12, 10))
      .toEqual({ ascent: 10, height: 40 });
  });

  it('does not shrink the band below the leading', () => {
    expect(lineBox([text(10), img(4, 'top')], 12, 10).height).toBe(12);
  });

  it('takes the largest of all three terms', () => {
    // A tall baseline image AND a taller top image: the ascent comes from the
    // first, the band from the second.
    const r = lineBox([text(10), img(20), img(50, 'top')], 12, 10);
    expect(r.ascent).toBe(20);
    expect(r.height).toBe(50);
  });

  it('honours a caller who asked for leading 0', () => {
    // stamp.ts validates blockFontSize positive, so the ratio is finite; a
    // zero leading must still produce a zero band.
    expect(lineBox([text(10)], 0, 10)).toEqual({ ascent: 10, height: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/linebox.test.ts`
Expected: FAIL — `Failed to load url ../src/linebox.js`.

- [ ] **Step 3: Create the module**

Create `src/linebox.ts`:

```ts
/** Where a line's baseline sits and how tall its band is.
 *
 *  Invariant: it imports NOTHING and knows no font. Every rule here is
 *  testable from plain numbers with no PDF built — the split floatstack.ts,
 *  booklet.ts, tablespan.ts and docinfer.ts each already make, and for the
 *  same reason: this is geometry that is silently wrong when reversed.
 *
 *  Invariant: it never throws.
 *
 *  Invariant, and it is zch2.11's acceptance criterion: with no atomic items
 *  this COLLAPSES to the arithmetic layout.ts had before — ascent is the
 *  largest font size and height is `max(leading, ascent * leading /
 *  blockFontSize)`. test/rich-runs-identity.test.ts's four hashes depend on
 *  that being a collapse rather than a tolerance. */

/** One thing occupying a line: a text piece, or a box.
 *
 *  `ascent` is the ABOVE-BASELINE extent. For a text piece it is the font
 *  size — the conservative convention layout.ts already used, which includes
 *  descender room. For a baseline-aligned box it is the whole height, because
 *  its bottom edge sits on the baseline. For a top- or bottom-aligned box it
 *  is 0: those align to the BAND and do not move the baseline. */
export interface LineItem {
  ascent: number;
  height: number;
  align: 'baseline' | 'top' | 'bottom';
}

export function lineBox(
  items: LineItem[], leading: number, blockFontSize: number,
): { ascent: number; height: number } {
  let ascent = 0;
  let banded = 0;          // tallest item that aligns to the band, not the baseline
  for (const it of items) {
    if (it.align === 'baseline') ascent = Math.max(ascent, it.ascent);
    else banded = Math.max(banded, it.height);
  }
  // A line with no baseline-aligned item keeps ordinary leading rather than
  // collapsing: a blank line is still a line.
  if (ascent === 0) ascent = blockFontSize;
  // `blockFontSize` is validated positive by every entry point, so the ratio
  // is finite; a caller who asked for `leading: 0` still gets 0.
  const height = Math.max(leading, (ascent * leading) / blockFontSize, banded);
  return { ascent, height };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/linebox.test.ts`
Expected: typecheck clean; PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/linebox.ts test/linebox.test.ts
git commit -m "feat(zch2.11): the line band and baseline arithmetic"
```

---

### Task 2: `layout.ts` — an atomic is a character

**Files:**
- Modify: `src/layout.ts`
- Test: `test/layout-atomics.test.ts` *(new)*

**Interfaces:**
- Consumes: `lineBox`, `LineItem` from `./linebox.js`.
- Produces:
  ```ts
  export interface AtomicBox {
    width: number;
    height: number;
    align: 'baseline' | 'top' | 'bottom';
  }
  export interface TextLayoutRun { text: string; driver: FontDriver; fontSize: number }
  export interface AtomicLayoutRun { atomic: AtomicBox }
  export type LayoutRun = TextLayoutRun | AtomicLayoutRun;
  export function isAtomicRun(r: LayoutRun): r is AtomicLayoutRun;
  // LaidSegment gains:  atomic?: AtomicBox
  // LaidLine.maxFontSize keeps its name and now means the line's ASCENT.
  ```

- [ ] **Step 1: Write the failing test**

Create `test/layout-atomics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { layoutRuns, type LayoutRun, type FontDriver } from '../src/layout.js';

/** A driver where every character is exactly 1pt wide at size 1, so widths are
 *  arithmetic a reader can check by hand. */
const drv: FontDriver = {
  measure: (t, fs) => t.length * fs,
  encode: (t) => new TextEncoder().encode(t),
  probe: (t) => t.length,
};

const txt = (text: string, fontSize = 1): LayoutRun => ({ text, driver: drv, fontSize });
const box = (width: number, height = 1, align: 'baseline' | 'top' | 'bottom' = 'baseline'):
  LayoutRun => ({ atomic: { width, height, align } });

describe('atomics in layoutRuns', () => {
  it('places an atomic between two words and gives it its own segment', () => {
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines).toHaveLength(1);
    const seg = lines[0].segments.find((s) => s.atomic !== undefined);
    expect(seg).toBeDefined();
    expect(seg!.width).toBe(5);
    expect(seg!.text).toBe('');
    expect(seg!.bytes).toHaveLength(0);
  });

  it('counts the atomic in the line width', () => {
    // 'ab' = 2, space = 1, box = 5, space = 1, 'cd' = 2.
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines[0].width).toBe(11);
  });

  it('never puts U+FFFC in a line\'s text or bytes', () => {
    // The placeholder is internal. A driver asked to encode it would draw a
    // glyph nobody asked for.
    const { lines } = layoutRuns([txt('ab '), box(5), txt(' cd')], 100, 100, 2, 1);
    expect(lines[0].text).not.toContain('￼');
    expect(new TextDecoder().decode(lines[0].bytes)).not.toContain('￼');
  });

  it('wraps a line when the atomic no longer fits', () => {
    // 'aaaa' = 4 then a 5-wide box: 4 + 1 + 5 = 10 > 8, so the box wraps.
    const { lines } = layoutRuns([txt('aaaa '), box(5)], 8, 100, 2, 1);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe('aaaa');
    expect(lines[1].segments.some((s) => s.atomic !== undefined)).toBe(true);
  });

  it('keeps an atomic ADJACENT to text in the same unbreakable word', () => {
    // `a<img>b` has no space, so it is one word — the correct CSS answer, and
    // it falls out of U+FFFC being a non-space character rather than from a
    // rule anyone wrote.
    const { lines } = layoutRuns([txt('a'), box(2), txt('b')], 100, 100, 2, 1);
    expect(lines).toHaveLength(1);
  });

  it('lets a tall baseline atomic raise the line band', () => {
    // leading 2, block size 1: a 6-tall box gives 6 * 2 / 1 = 12.
    const { lines } = layoutRuns([txt('a '), box(1, 6)], 100, 100, 2, 1);
    expect(lines[0].height).toBe(12);
    expect(lines[0].maxFontSize).toBe(6);
  });

  it('lets a TOP-aligned atomic raise the band without moving the baseline', () => {
    const { lines } = layoutRuns([txt('a '), box(1, 6, 'top')], 100, 100, 2, 1);
    expect(lines[0].height).toBe(6);
    expect(lines[0].maxFontSize).toBe(1);
  });

  it('carries an atomic into the REMAINDER when its line does not fit', () => {
    // boxHeight 2 fits exactly one line of leading 2.
    const { lines, remainder } = layoutRuns(
      [txt('aaaa '), box(5)], 8, 2, 2, 1);
    expect(lines).toHaveLength(1);
    expect(remainder.some((s) => s.text === '￼')).toBe(true);
  });

  it('lays out atomic-free input exactly as before', () => {
    // The collapse, asserted at this level too: same widths, same segment
    // count, one segment for a single-run line.
    const { lines } = layoutRuns([txt('hello world')], 100, 100, 2, 1);
    expect(lines).toHaveLength(1);
    expect(lines[0].segments).toHaveLength(1);
    expect(lines[0].width).toBe(11);
    expect(lines[0].maxFontSize).toBe(1);
    expect(lines[0].height).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/layout-atomics.test.ts`
Expected: FAIL — `AtomicLayoutRun` does not typecheck and every atomic case
fails at runtime.

- [ ] **Step 3: Split `LayoutRun` into a union**

In `src/layout.ts`, replace the `LayoutRun` interface:

```ts
/** A box occupying width in a line without contributing characters — an image.
 *  @internal */
export interface AtomicBox {
  width: number;
  height: number;
  /** `baseline` puts its bottom on the baseline; `top`/`bottom` align it to
   *  the line band. `middle` is deliberately absent — CSS defines it against
   *  half the x-height, which the AFM tables do not expose. */
  align: 'baseline' | 'top' | 'bottom';
}

/** One TEXT run as the layout engine sees it: already resolved to a driver and
 *  a size. layout.ts never learns what an AuthoringFont is. @internal */
export interface TextLayoutRun {
  text: string;
  driver: FontDriver;
  fontSize: number;
}

/** One atomic run. @internal */
export interface AtomicLayoutRun { atomic: AtomicBox }

export type LayoutRun = TextLayoutRun | AtomicLayoutRun;

export function isAtomicRun(r: LayoutRun): r is AtomicLayoutRun {
  return (r as AtomicLayoutRun).atomic !== undefined;
}
```

Add to `LaidSegment`:

```ts
  /** Present for an atomic segment, whose `text` is '' and `bytes` empty. The
   *  emitter draws the box and advances the pen; every consumer that walks
   *  segments for geometry already advances by `width` and needs no change. */
  atomic?: AtomicBox;
```

And retitle `LaidLine.maxFontSize`'s doc — the FIELD NAME does not change, so
no consumer moves:

```ts
  /** The line's ASCENT: how far below the band top its baseline sits. The
   *  largest font size among the runs with text, or a baseline-aligned
   *  atomic's height when that is larger; the block's own size for a line with
   *  neither. Named `maxFontSize` since before zch2.11 gave it the second
   *  meaning — the name is kept because four modules read it. */
  maxFontSize: number;
```

- [ ] **Step 4: Give an atomic a character and a width**

At the top of `layoutRuns`, replace the text concatenation:

```ts
  // U+FFFC OBJECT REPLACEMENT CHARACTER, which is what Unicode defines it for.
  // One character per atomic is what lets the whole index-based walk below —
  // units, the break search, piecesOf, the remainder — work unchanged.
  const OBJ = '￼';
  let text = '';
  for (const r of runs) text += isAtomicRun(r) ? OBJ : r.text;
```

`spanWidth` gains the atomic case (note it still walks run by run, so an
atomic's single character is its own group):

```ts
  const spanWidth = (from: number, to: number): number => {
    let w = 0;
    let i = from;
    while (i < to) {
      const r = owner[i];
      let j = i;
      while (j < to && owner[j] === r) j++;
      const run = runs[r];
      w += isAtomicRun(run)
        ? run.atomic.width
        : run.driver.measure(text.slice(i, j), run.fontSize);
      i = j;
    }
    return w;
  };
```

`spaceWidth` measures in the preceding run, which may now be an atomic — an
atomic has no font, so fall back to the block size through the nearest text
run:

```ts
  /** Width of a separator space, measured in the run that precedes it. An
   *  atomic has no font, so the search walks back to the nearest TEXT run;
   *  with none, the space is zero-width, which is the only honest answer when
   *  no font is in force. */
  const spaceWidth = (at: number): number => {
    for (let k = owner[at]; k >= 0; k--) {
      const r = runs[k];
      if (!isAtomicRun(r)) return r.driver.measure(' ', r.fontSize);
    }
    return 0;
  };
```

- [ ] **Step 5: Route the band through `lineBox`**

Add the import:

```ts
import { lineBox, type LineItem } from './linebox.js';
```

Replace `maxSizeOf` and `heightOf` with one walk that builds items:

```ts
  /** The items on a line, for linebox.ts. A text piece contributes its font
   *  size as its ascent — layout.ts's convention since before atomics — and an
   *  atomic contributes its box. */
  const itemsOf = (units: Unit[]): LineItem[] => {
    const items: LineItem[] = [];
    for (const u of units) {
      let i = u.start;
      while (i < u.end) {
        const r = owner[i];
        let j = i;
        while (j < u.end && owner[j] === r) j++;
        const run = runs[r];
        if (isAtomicRun(run)) {
          const a = run.atomic;
          items.push({
            ascent: a.align === 'baseline' ? a.height : 0,
            height: a.height,
            align: a.align,
          });
        } else {
          items.push({ ascent: run.fontSize, height: run.fontSize, align: 'baseline' });
        }
        i = j;
      }
    }
    return items;
  };
```

Phase B and the line build then read `lineBox`:

```ts
  // --- Phase B: keep the lines whose bands fit the box height. ---
  let used = 0;
  let kept = 0;
  const heights: number[] = [];
  const ascents: number[] = [];
  while (kept < wrapped.length) {
    const b = lineBox(itemsOf(wrapped[kept].units), leading, blockFontSize);
    if (used + b.height > boxHeight + EPS) break;
    used += b.height;
    heights.push(b.height);
    ascents.push(b.ascent);
    kept++;
  }
```

and in the `lines.push`, `maxFontSize: ascents[k]`.

- [ ] **Step 6: Emit an atomic segment**

In the `lines` build, the segment mapper branches on the run kind. An atomic's
`text` is the U+FFFC placeholder in `piecesOf`'s output, so it is REPLACED by
`''` here — which is what keeps U+FFFC out of `line.text` and out of any
`encode` call:

```ts
    const segments: LaidSegment[] = piecesOf(wrapped[k].units).map((p) => {
      const run = runs[p.run];
      if (isAtomicRun(run)) {
        return {
          run: p.run, text: '', width: run.atomic.width,
          bytes: new Uint8Array(0), atomic: run.atomic,
        };
      }
      return {
        run: p.run,
        text: p.text,
        width: run.driver.measure(p.text, run.fontSize),
        bytes: run.driver.encode(p.text),
      };
    });
```

`layoutText` passes a single text run and needs no change, but its call now
reads `[{ text, driver, fontSize }]` against the union — confirm it still
typechecks rather than editing it.

- [ ] **Step 7: Run the tests and the fence**

Run: `npm run typecheck && npx vitest run test/layout-atomics.test.ts test/layout.test.ts test/layout-runs.test.ts test/layout-linebreak.test.ts`
Expected: typecheck may report errors in `src/stamp.ts` (it reads
`r.layout.text` and `r.layout.fontSize`, which the union no longer guarantees)
— Task 4 fixes those. Every layout test PASSES.

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: PASS. **If red, STOP** — see the Global Constraints.

- [ ] **Step 8: Commit**

```bash
git add src/layout.ts test/layout-atomics.test.ts
git commit -m "feat(zch2.11): an atomic is a U+FFFC character in the layout"
```

---

### Task 3: `layout.ts` — the over-wide clamp

**Files:**
- Modify: `src/layout.ts`
- Test: `test/layout-atomics.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/layout-atomics.test.ts`:

```ts
describe('an over-wide atomic', () => {
  it('clamps to the box width, preserving the aspect', () => {
    // The rule flow.ts's image() already applies to a block image ("clamped
    // down to the region width if larger"), so it is one rule and not two.
    // 20 wide x 10 tall in a box of 8 becomes 8 x 4.
    const { lines } = layoutRuns([box(20, 10)], 8, 100, 2, 1);
    const seg = lines[0].segments.find((s) => s.atomic !== undefined)!;
    expect(seg.width).toBe(8);
    expect(seg.atomic!.height).toBe(4);
  });

  it('feeds the CLAMPED height to the band, not the original', () => {
    // Miss this and a wide photo reserves a band for a height it no longer
    // has, leaving a stripe of blank page under it.
    const { lines } = layoutRuns([box(20, 10)], 8, 100, 2, 1);
    expect(lines[0].height).toBe((4 * 2) / 1);
  });

  it('leaves an atomic that already fits untouched', () => {
    const { lines } = layoutRuns([box(4, 10)], 8, 100, 2, 1);
    const seg = lines[0].segments.find((s) => s.atomic !== undefined)!;
    expect(seg.width).toBe(4);
    expect(seg.atomic!.height).toBe(10);
  });

  it('ignores a zero-width atomic rather than dividing by it', () => {
    // A picture with no area is not damage; it contributes nothing and draws
    // nothing. The guard exists so the clamp's ratio is never 0/0.
    expect(() => layoutRuns([txt('a'), box(0, 0)], 8, 100, 2, 1)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/layout-atomics.test.ts`
Expected: FAIL — the first three cases; the zero-width one already passes.

- [ ] **Step 3: Implement**

At the top of `layoutRuns`, before the text concatenation, normalize the runs:

```ts
  // An atomic wider than the box scales BOTH dimensions down — the rule
  // flow.ts's image() already applies to a block image, so it is one rule
  // rather than two. It happens here because this is the only place that
  // knows boxWidth, and the clamped height is what the band must see.
  runs = runs.map((r) => {
    if (!isAtomicRun(r) || r.atomic.width <= boxWidth || r.atomic.width <= 0) return r;
    const k = boxWidth / r.atomic.width;
    return { atomic: { ...r.atomic, width: boxWidth, height: r.atomic.height * k } };
  });
```

Change the parameter to `let runs` — or bind a local `const scaled` and use it
throughout; either is fine, but do NOT mutate the caller's array or its
objects, because `stamp.ts` reuses the same `ResolvedRun.layout` objects for
`segmentBoxes` and the painter.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/layout-atomics.test.ts && npx vitest run test/rich-runs-identity.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/layout.ts test/layout-atomics.test.ts
git commit -m "feat(zch2.11): clamp an over-wide atomic, aspect preserved"
```

---

### Task 4: `stamp.ts` — interleave, and advance the pen

**Files:**
- Modify: `src/stamp.ts`
- Test: `test/stamp-atomics.test.ts` *(new)*

**Interfaces:**
- Consumes: `AtomicBox`, `isAtomicRun` from `./layout.js`.
- Produces:
  ```ts
  /** An atomic in TextBlockOptions, at stamp.ts's level: the image is already
   *  built, because stamp.ts may allocate objects and layout.ts may not. */
  export interface BlockAtomic {
    /** Index into the run list this sits BEFORE; runs.length means at the end. */
    beforeRun: number;
    built: BuiltImage;
    width: number;
    height: number;
    align: 'baseline' | 'top' | 'bottom';
  }
  // TextBlockOptions gains:  atomics?: BlockAtomic[]
  ```

- [ ] **Step 1: Write the failing test**

Create `test/stamp-atomics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { flowTextBlock } from '../src/stamp.js';
import { buildImageXObject } from '../src/imageembed.js';

/** A 1x1 red PNG — the smallest thing buildImageXObject accepts. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function draw(atomicAt: number) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const built = buildImageXObject(new Uint8Array(PNG_1x1));
  flowTextBlock(doc, page, [{ text: 'before ' }, { text: 'after' }],
    [20, 400, 400, 300], {
      fontSize: 12,
      atomics: [{ beforeRun: atomicAt, built, width: 20, height: 20, align: 'baseline' }],
    });
  return { doc, page };
}

describe('an atomic in a stamped run block', () => {
  it('advances the pen with a TJ kern', () => {
    // buildRunBlockBody emits NO per-segment Td — its own comment says "Tj
    // advances the pen by the string's own width". An atomic emits no Tj, so
    // without an explicit kern the text after the image overprints it.
    const { doc, page } = draw(1);
    const content = new TextDecoder().decode(page.GetContent());
    expect(content).toMatch(/\[\s*-?\d+(\.\d+)?\s*\]\s*TJ/);
    void doc;
  });

  it('puts the text after the image further right than without it', () => {
    // The kern is only correct if it MOVES something: this is the assertion a
    // malformed-but-present TJ cannot satisfy.
    const withBox = draw(1).page.GetTextFragments().find((f) => f.text.includes('after'))!;
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    flowTextBlock(doc, page, [{ text: 'before ' }, { text: 'after' }],
      [20, 400, 400, 300], { fontSize: 12 });
    const without = page.GetTextFragments().find((f) => f.text.includes('after'))!;
    expect(withBox.quad[0]).toBeGreaterThan(without.quad[0] + 19);
  });

  it('draws both words either side of the image', () => {
    const t = draw(1).page.GetText();
    expect(t).toContain('before');
    expect(t).toContain('after');
  });

  it('measures a block the same way it paints it', () => {
    // measureTextBlock and flowTextBlock share resolveRuns and layoutRuns, so
    // an atomic must reach BOTH or a paragraph measures one way and paints
    // another — the failure the one-wrapping-engine rule exists to prevent.
    // A 200pt-wide box in a 100pt column forces a wrap, so a measure that
    // ignored the atomic would report ONE line's height where two are drawn.
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    const opts = {
      fontSize: 12,
      atomics: [{ beforeRun: 1, built, width: 200, height: 20,
        align: 'baseline' as const }],
    };
    const runs = [{ text: 'before ' }, { text: 'after' }];
    const measured = measureTextBlock(runs, 100, 300, opts).usedHeight;

    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const drawn = flowTextBlock(doc, page, runs, [20, 100, 100, 300], opts).usedHeight;
    expect(measured).toBe(drawn);
  });
});
```

The imports at the top of the file are
`import { flowTextBlock, measureTextBlock } from '../src/stamp.js';`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stamp-atomics.test.ts`
Expected: FAIL — `atomics` is not a `TextBlockOptions` property.

- [ ] **Step 3: Add the option and the interleave**

In `src/stamp.ts`, add to `TextBlockOptions`:

```ts
  /** Boxes to place among the runs — an image on a line of text. Each names
   *  the run index it sits BEFORE. A PARALLEL channel rather than a field on
   *  TextRun, so textdecor.ts's model — read by mdruns.ts, tableauthor.ts,
   *  flowtable.ts and docmodel.ts — does not change and every existing caller
   *  is byte-identical by construction. Ignored for a string block. */
  atomics?: BlockAtomic[];
```

Add the interleave, used by BOTH entry points so they cannot disagree:

```ts
/** Runs and atomics woven into ONE list, in document order.
 *
 *  Shared by flowTextBlock and measureTextBlock deliberately: they already
 *  share resolveRuns and layoutRuns, and a second weave is how a paragraph
 *  comes to measure one way and paint another. */
function weaveAtomics(
  resolved: ResolvedRun[], atomics: BlockAtomic[] | undefined,
): { woven: ResolvedRun[]; atomicOf: Map<number, BlockAtomic> } {
  const atomicOf = new Map<number, BlockAtomic>();
  if (atomics === undefined || atomics.length === 0)
    return { woven: resolved, atomicOf };
  const woven: ResolvedRun[] = [];
  const at = (i: number): void => {
    for (const a of atomics) {
      if (a.beforeRun !== i) continue;
      atomicOf.set(woven.length, a);
      woven.push({
        layout: { atomic: { width: a.width, height: a.height, align: a.align } },
        // An atomic has no font, colour, decoration or link of its own; these
        // are inert and exist only so the array stays homogeneous.
        font: resolved[0]?.font ?? resolved[resolved.length - 1]?.font,
        color: [0, 0, 0], decor: undefined, link: undefined,
      } as ResolvedRun);
    }
  };
  for (let i = 0; i < resolved.length; i++) { at(i); woven.push(resolved[i]); }
  at(resolved.length);
  return { woven, atomicOf };
}
```

In BOTH `flowTextBlock`'s run branch and `measureTextBlock`'s run branch,
replace `const resolved = resolveRuns(content, o);` with:

```ts
    const { woven: resolved, atomicOf } = weaveAtomics(resolveRuns(content, o), options.atomics);
```

and change the all-unencodable early return so an atomic-only block still
draws:

```ts
    if (resolved.every((r) => isAtomicRun(r.layout) ? false
      : r.layout.driver.probe(r.layout.text) === 0))
      return { remainder: null, usedHeight: 0 };
```

Every `r.layout.text` / `r.layout.fontSize` read in `stamp.ts` now needs an
`isAtomicRun` guard. `justifiable`, `registerFont` over `resolved`, and
`segmentBoxes`'s trailing measure are the sites; give an atomic run a trailing
of 0 and skip it in the font registration by registering the block font.

- [ ] **Step 4: Emit the kern**

In `buildRunBlockBody`'s segment loop, before the `Tf` block:

```ts
      if (seg.atomic !== undefined) {
        // No Tj, so the pen would not advance and the following text would
        // overprint the image. A TJ with a single negative number kerns by
        // `n/1000 * fontSize`, so the advance is exact at the size in force.
        // `curSize` is whatever the last Tf set; a block that opens with an
        // atomic has none yet, so fall back to the block size.
        const size = curSize > 0 ? curSize : o.fontSize;
        s += `[ ${num(-(seg.width * 1000) / size)} ] TJ\n`;
        continue;
      }
```

Note `continue` skips the MCID wrap too: an image is not the link's text.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/stamp-atomics.test.ts`
Expected: typecheck clean; the first, second and fourth cases PASS. The third
("draws both words") passes too. No image is drawn yet — that is Task 5.

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: PASS. `weaveAtomics` returns `resolved` unchanged when `atomics` is
absent, so no byte moves.

- [ ] **Step 6: Commit**

```bash
git add src/stamp.ts test/stamp-atomics.test.ts
git commit -m "feat(zch2.11): weave atomics into a run block and advance the pen"
```

---

### Task 5: `stamp.ts` — draw the image

**Files:**
- Modify: `src/stamp.ts`
- Test: `test/stamp-atomics.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/stamp-atomics.test.ts`:

```ts
describe('the image itself', () => {
  it('registers an XObject and draws it', () => {
    const { page } = draw(1);
    const content = new TextDecoder().decode(page.GetContent());
    expect(content).toMatch(/\/Im\d+ Do/);
  });

  it('places it where the layout put it, on the text baseline', () => {
    // The box's BOTTOM sits on the baseline for align: baseline, so its cm
    // translate must equal the baseline of the line it is on.
    const { page } = draw(1);
    const before = page.GetTextFragments().find((f) => f.text.includes('before'))!;
    const paths = page.GetPaths();
    void paths;
    const content = new TextDecoder().decode(page.GetContent());
    const m = /20 0 0 20 ([\d.]+) ([\d.]+) cm/.exec(content);
    expect(m, `no 20x20 cm in ${content.slice(0, 400)}`).not.toBeNull();
    expect(Number(m![2])).toBeCloseTo(before.quad[1], 1);
  });

  it('draws nothing for a zero-area atomic', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    flowTextBlock(doc, page, [{ text: 'a' }], [20, 400, 400, 300], {
      fontSize: 12,
      atomics: [{ beforeRun: 1, built, width: 0, height: 0, align: 'baseline' }],
    });
    expect(new TextDecoder().decode(page.GetContent())).not.toMatch(/Do/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stamp-atomics.test.ts`
Expected: FAIL — no `Do` in the content.

- [ ] **Step 3: Implement**

In `flowTextBlock`'s run branch, after `put(doc, page, …)` (so the image lands
after the text body — unobservable, because an inline atomic's box never
overlaps the glyphs it sits between):

```ts
      // Drawn through the EXISTING drawBuiltImage, which already handles
      // /SMask, resource registration and tagging — no refactor of
      // imageembed.ts. It cannot go inside BT…ET, so it is its own
      // q…cm…Do…Q beside the text object.
      boxes.forEach((b, i) => {
        const at = segAt(lines, i);
        if (at === undefined || at.seg.atomic === undefined) return;
        const a = atomicOf.get(at.seg.run);
        if (a === undefined || a.width <= 0 || a.height <= 0) return;
        // `align: baseline` puts the box BOTTOM on the baseline, so the rect's
        // y IS the baseline. top/bottom align to the BAND: the baseline sits
        // `maxFontSize` (the line's ascent) below the band top, which is what
        // recovers the band from a box that only knows its baseline.
        const bandTop = b.baseline + at.line.maxFontSize;
        const y = a.align === 'baseline' ? b.baseline
          : a.align === 'top' ? bandTop - a.height
            : bandTop - at.line.height;
        drawBuiltImage(doc, page, a.built, [b.x, y, a.width, a.height],
          { artifact: options.artifact });
      });
```

with one helper beside `segmentBoxes`, since `boxes` and the segments are
built by the same nested iteration and index i of one names index i of the
other:

```ts
/** The laid segment at flat index `i` across all lines, with the line it is
 *  on — `boxes[i]`'s segment. Both lists come from the same nested walk, which
 *  is what makes the index shared; a second walk is how a box and its segment
 *  come to disagree about where a picture goes. */
function segAt(
  lines: LaidLine[], i: number,
): { seg: LaidSegment; line: LaidLine } | undefined {
  let n = i;
  for (const line of lines) {
    if (n < line.segments.length) return { seg: line.segments[n], line };
    n -= line.segments.length;
  }
  return undefined;
}
```

Import `drawBuiltImage` from `./imageembed.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/stamp-atomics.test.ts && npx vitest run test/rich-runs-identity.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stamp.ts test/stamp-atomics.test.ts
git commit -m "feat(zch2.11): draw an inline image beside the text object"
```

---

### Task 6: the remainder carries its atomics

**Files:**
- Modify: `src/stamp.ts`, `src/flow.ts`
- Test: `test/stamp-atomics.test.ts`

**Interfaces:**
- Produces: `flowTextBlock` and `measureTextBlock`'s run overloads gain
  `remainderAtomics?: BlockAtomic[]` in their return type.

- [ ] **Step 1: Write the failing test**

Append to `test/stamp-atomics.test.ts`:

```ts
describe('an atomic at a column break', () => {
  it('re-bases beforeRun onto the sliced run list', () => {
    // THE TRAP. layoutRuns returns RunSlice[] and stamp.ts rebuilds a FRESH
    // TextRun[] via sliceRuns — it does not re-flow against the same array.
    // An atomic in the overflow whose beforeRun was not re-based lands at the
    // wrong place, or off the end and vanishes. A test that only inspects the
    // FIRST column cannot see this.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    // A box only 14pt tall fits one line of 12pt leading, so run 1 overflows.
    const res = flowTextBlock(doc, page,
      [{ text: 'aaaa bbbb cccc dddd ' }, { text: 'eeee' }],
      [20, 400, 60, 14], {
        fontSize: 12,
        atomics: [{ beforeRun: 1, built, width: 10, height: 10, align: 'baseline' }],
      });
    expect(res.remainder).not.toBeNull();
    expect(res.remainderAtomics).toBeDefined();
    expect(res.remainderAtomics!).toHaveLength(1);
    // Re-based: it must name a run index that EXISTS in the returned list.
    expect(res.remainderAtomics![0].beforeRun)
      .toBeLessThanOrEqual(res.remainder!.length);
  });

  it('reports no remainder atomics when everything fit', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    const res = flowTextBlock(doc, page, [{ text: 'a ' }, { text: 'b' }],
      [20, 400, 400, 300], {
        fontSize: 12,
        atomics: [{ beforeRun: 1, built, width: 10, height: 10, align: 'baseline' }],
      });
    expect(res.remainder).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/stamp-atomics.test.ts`
Expected: FAIL — `remainderAtomics` does not exist.

- [ ] **Step 3: Implement `sliceContent`**

Beside `sliceRuns` in `src/stamp.ts`:

```ts
/** Rebuild the remainder's runs AND its atomics, with each atomic's
 *  `beforeRun` re-based onto the new list.
 *
 *  Forced rather than tidy: flow.ts's TextElement builds its continuation with
 *  `this.opts`, so an atomic carried forward unchanged would name an index
 *  into the ORIGINAL run list — landing in the wrong place, or off the end and
 *  vanishing entirely at a column break. */
function sliceContent(
  slices: RunSlice[], source: TextRun[], atomicOf: Map<number, BlockAtomic>,
  woven: ResolvedRun[],
): { runs: TextRun[]; atomics: BlockAtomic[] } {
  // `source` is indexed by the ORIGINAL run list; `slices` by the woven one.
  // This map takes a woven index back to a source index.
  const sourceIndex: number[] = [];
  let n = 0;
  for (let i = 0; i < woven.length; i++) sourceIndex.push(atomicOf.has(i) ? -1 : n++);

  const runs: TextRun[] = [];
  const atomics: BlockAtomic[] = [];
  let lastRun = -1;
  for (const s of slices) {
    const a = atomicOf.get(s.run);
    if (a !== undefined) {
      // The atomic sits before whatever run comes next in the REBUILT list.
      atomics.push({ ...a, beforeRun: runs.length });
      lastRun = -1;                       // an atomic breaks the merge run
      continue;
    }
    if (s.run === lastRun) { runs[runs.length - 1].text += s.text; continue; }
    runs.push({ ...source[sourceIndex[s.run]], text: s.text });
    lastRun = s.run;
  }
  return { runs, atomics };
}
```

In both entry points, replace the `sliceRuns(remainder, content)` call:

```ts
    const rest = sliceContent(remainder, content, atomicOf, resolved);
    return {
      remainder: remainder.length === 0 ? null : rest.runs,
      remainderAtomics: rest.atomics.length === 0 ? undefined : rest.atomics,
      usedHeight: linesHeight(lines),
    };
```

Widen both run overloads' return types with
`remainderAtomics?: BlockAtomic[]`. `sliceRuns` is now unused — DELETE it
rather than leaving two rebuilders that can disagree.

- [ ] **Step 4: Carry them into the continuation**

In `src/flow.ts`, `drawFlowText` and `measureFlowText` pass the field through,
and `TextElement.place`'s continuation uses it:

```ts
    const { remainder, remainderAtomics, usedHeight } =
      drawFlowText(ctx.doc, ctx.page, this.text, rect, opts);
```

```ts
      remainder: remainder === null ? null
        : new TextElement(remainder, { ...this.opts, atomics: remainderAtomics },
          this.structType, 0, this.spaceAfter, this.tag),
```

Note `{ ...this.opts, atomics: remainderAtomics }` and NOT `this.opts`: the
original atomics index the original runs.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/stamp-atomics.test.ts && npx vitest run test/rich-runs-identity.test.ts && npx vitest run test/flow-tagging.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stamp.ts src/flow.ts test/stamp-atomics.test.ts
git commit -m "feat(zch2.11): re-base an atomic carried into the next column"
```

---

### Task 7: `flow.ts` — the authoring option

**Files:**
- Modify: `src/flow.ts`
- Test: `test/flow-atomics.test.ts` *(new)*

**Interfaces:**
- Produces:
  ```ts
  export interface FlowAtomic {
    beforeRun: number;
    /** BYTES, not a PdfStream — cssflow.ts must touch no PDF object module. */
    data: Uint8Array;
    width: number;
    height: number;
    align?: 'baseline' | 'top' | 'bottom';
  }
  // FlowParagraphOptions gains:  atomics?: FlowAtomic[]
  ```

- [ ] **Step 1: Write the failing test**

Create `test/flow-atomics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

function place(atomics: unknown) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const els = paragraph([{ text: 'before ' }, { text: 'after' }],
    { fontSize: 12, atomics } as never);
  placeElements(doc, page, els, [20, 20, 400, 750], { paragraphSpacing: 0 });
  return page;
}

describe('paragraph({ atomics })', () => {
  it('takes BYTES and builds the XObject itself', () => {
    // cssflow.ts hands bytes and never a PdfStream, which is what keeps its
    // rule of touching no PDF object module.
    const page = place([{ beforeRun: 1, data: new Uint8Array(PNG_1x1),
      width: 20, height: 20 }]);
    expect(new TextDecoder().decode(page.GetContent())).toMatch(/\/Im\d+ Do/);
    expect(page.GetText()).toContain('before');
  });

  it('defaults align to baseline', () => {
    const page = place([{ beforeRun: 1, data: new Uint8Array(PNG_1x1),
      width: 20, height: 20 }]);
    expect(new TextDecoder().decode(page.GetContent())).toMatch(/Do/);
  });

  it('rejects a bad atomic BEFORE emitting any byte', () => {
    // The rule every authoring entry point follows: a rejected call leaves the
    // document byte-identical.
    for (const bad of [
      { beforeRun: -1, data: new Uint8Array(PNG_1x1), width: 1, height: 1 },
      { beforeRun: 0, data: 'nope', width: 1, height: 1 },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: -1, height: 1 },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: 1, height: Number.NaN },
      { beforeRun: 0, data: new Uint8Array(PNG_1x1), width: 1, height: 1, align: 'middle' },
    ]) {
      expect(() => place([bad]), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it('leaves an atomic-free paragraph exactly as it was', () => {
    const page = place(undefined);
    expect(new TextDecoder().decode(page.GetContent())).not.toMatch(/Do/);
    expect(page.GetText()).toContain('before');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/flow-atomics.test.ts`
Expected: FAIL — `atomics` is not an option and nothing is drawn.

- [ ] **Step 3: Implement**

In `src/flow.ts`, add `FlowAtomic` and the option to `FlowParagraphOptions`
(and therefore to `FlowHeadingOptions`, which extends it):

```ts
/** A box placed among a paragraph's runs — an image on a line of text.
 *
 *  `data` is IMAGE BYTES rather than a built XObject, so a pure mapper like
 *  cssflow.ts can produce one without importing any PDF object module; this
 *  builder does the same `buildImageXObject` call `image()` already does. */
export interface FlowAtomic {
  /** The run index this sits BEFORE; `runs.length` places it at the end. */
  beforeRun: number;
  data: Uint8Array;
  /** Drawn size in POINTS. Both > 0, or the atomic draws nothing. */
  width: number;
  height: number;
  /** Default 'baseline' — the box's bottom edge sits on the text baseline.
   *  'middle' is not offered: CSS defines it against half the x-height, which
   *  the AFM tables do not expose. */
  align?: 'baseline' | 'top' | 'bottom';
}
```

and a validator + converter called from `paragraphOptions`:

```ts
/** Validate and build. Every atomic is checked BEFORE any XObject is
 *  allocated, so a rejected call leaves the document byte-identical — the rule
 *  every authoring entry point here follows. */
function resolveAtomics(list: FlowAtomic[] | undefined): BlockAtomic[] | undefined {
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) throw new TypeError('atomics must be an array');
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!Number.isInteger(a?.beforeRun) || a.beforeRun < 0)
      throw new TypeError(`atomic ${i}: beforeRun must be a non-negative integer`);
    if (!(a.data instanceof Uint8Array))
      throw new TypeError(`atomic ${i}: data must be a Uint8Array`);
    for (const k of ['width', 'height'] as const) {
      if (!Number.isFinite(a[k]) || a[k] < 0)
        throw new TypeError(`atomic ${i}: ${k} must be a non-negative finite number`);
    }
    if (a.align !== undefined && !['baseline', 'top', 'bottom'].includes(a.align))
      throw new TypeError(`atomic ${i}: align must be 'baseline', 'top' or 'bottom'`);
  }
  return list.map((a) => ({
    beforeRun: a.beforeRun,
    built: buildImageXObject(a.data),
    width: a.width,
    height: a.height,
    align: a.align ?? 'baseline',
  }));
}
```

Import `buildImageXObject` from `./imageembed.js` and `BlockAtomic` from
`./stamp.js`. `paragraphOptions` sets `atomics: resolveAtomics(o.atomics)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/flow-atomics.test.ts && npx vitest run test/rich-runs-identity.test.ts`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-atomics.test.ts
git commit -m "feat(zch2.11): paragraph({ atomics }), taking image bytes"
```

---

### Task 8: `imageembed.ts` — intrinsic size from the header

**Files:**
- Modify: `src/imageembed.ts`
- Test: `test/imageembed-size.test.ts` *(new)*

**Interfaces:**
- Produces:
  `export function imageSize(data: Uint8Array): { width: number; height: number } | undefined;`

- [ ] **Step 1: Write the failing test**

Create `test/imageembed-size.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { imageSize, buildImageXObject } from '../src/imageembed.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

describe('imageSize', () => {
  it('reads a PNG\'s intrinsic pixels', () => {
    expect(imageSize(new Uint8Array(PNG_1x1))).toEqual({ width: 1, height: 1 });
  });

  it('agrees with what buildImageXObject puts in the dict', () => {
    // Two readings of one header is how they would come to disagree, so this
    // asserts they do not.
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    expect(imageSize(new Uint8Array(PNG_1x1))).toEqual({
      width: built.stream.dict.get('Width'),
      height: built.stream.dict.get('Height'),
    });
  });

  it('is undefined for bytes it cannot read, rather than throwing', () => {
    // The caller routes an undefined straight to the existing
    // `image:<src>`/dropped report; a throw would have to be caught somewhere.
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageSize(new Uint8Array(0))).toBeUndefined();
    expect(() => imageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/imageembed-size.test.ts`
Expected: FAIL — `imageSize` is not exported.

- [ ] **Step 3: Implement**

In `src/imageembed.ts`:

```ts
/** An image's intrinsic size in PIXELS, or undefined for bytes this module
 *  cannot read.
 *
 *  It goes through buildImageXObject rather than re-reading the headers,
 *  because two readings of one header is how they come to disagree about a
 *  picture — the rule imagehref.ts records for its own decoder. The cost is a
 *  header parse rather than a decode: no sample data is touched for a JPEG or
 *  a PNG, whose dimensions live in SOF/IHDR.
 *
 *  Undefined rather than a throw: the caller reports the image as unresolvable
 *  through the path it already has. */
export function imageSize(data: Uint8Array): { width: number; height: number } | undefined {
  try {
    const built = buildImageXObject(data);
    const width = built.stream.dict.get('Width');
    const height = built.stream.dict.get('Height');
    return typeof width === 'number' && typeof height === 'number'
      ? { width, height } : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/imageembed-size.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/imageembed.ts test/imageembed-size.test.ts
git commit -m "feat(zch2.11): imageSize, an image's intrinsic pixels"
```

---

### Task 9: wire HTML

**Files:**
- Modify: `src/cssflow.ts`, `src/cssinline.ts`
- Test: `test/htmlreport-render.test.ts`, `test/htmlflow.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/htmlreport-render.test.ts`:

```ts
suite('inline images (zch2.11)', () => {
  const PNG = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('renders an image sharing its line with text, and reports nothing', () => {
    const r = render(`<p>before <img src="${PNG}"> after</p>`);
    expect(r.text).toContain('before');
    expect(r.text).toContain('after');
    expect(r.names.some((n) => n.startsWith('image:'))).toBe(false);
  });

  it('still reports an image it cannot resolve', () => {
    // What LEAVES the report is a RESOLVABLE image sharing a line with text.
    const r = render('<p>a <img src="missing.png"> b</p>');
    expect(r.names).toContain('image:missing.png');
  });

  it('sizes an img from its width and height attributes', () => {
    const r = render(`<p>a <img src="${PNG}" style="width:40px;height:20px"> b</p>`);
    // 40 CSS px -> 30pt.
    expect(new TextDecoder().decode(r.page.GetContent())).toMatch(/30 0 0 15 /);
  });

  it('reports vertical-align on a SPAN but not on an aligned IMG', () => {
    // Two rules where there was one: top/bottom are implemented for an atomic
    // and for nothing else. A single widened rule satisfies either fixture
    // alone, so both are asserted.
    expect(render(`<p>a <img src="${PNG}" style="vertical-align:top"> b</p>`).names)
      .not.toContain('vertical-align:top');
    expect(render('<p>a<span style="vertical-align:top">s</span></p>').names)
      .toContain('vertical-align:top');
  });

  it('still reports an img asking for a value we do not implement', () => {
    expect(render(`<p>a <img src="${PNG}" style="vertical-align:middle"> b</p>`).names)
      .toContain('vertical-align:middle');
  });
});
```

Then update `test/htmlflow.test.ts`'s zch2.6 case "still reports an image that
shares its line with text" — it INVERTS, and that inversion is the proof the
feature landed:

```ts
  it('renders an image sharing its line with text (zch2.11)', () => {
    // Inverted from zch2.6, where layoutRuns could not place a box in a line.
    const { skipped, page } = render(`<p>before <img src="${PNG_1x1}"> after</p>`);
    expect(skipped.some((s) => s.construct === 'image')).toBe(false);
    expect(page.GetText()).toContain('before');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/htmlreport-render.test.ts test/htmlflow.test.ts`
Expected: FAIL — the image is still reported.

- [ ] **Step 3: Split the vertical-align report in `cssinline.ts`**

Replace the unconditional report:

```ts
    // An ATOMIC implements baseline/top/bottom (zch2.11), so reporting those
    // for one would be false. Everything else still reports, and a NON-atomic
    // inline still reports every non-baseline value, because for text none of
    // them are implemented.
    const atomicHere = n.ns === 'html' && n.name === 'img';
    const implemented = atomicHere
      && (st.verticalAlign === 'top' || st.verticalAlign === 'bottom');
    if (st.verticalAlign !== 'baseline' && !implemented) {
      report.push({
        el: n, kind: 'degraded', construct: 'vertical-align',
        detail: st.verticalAlign,
      });
    }
```

Note this sits BEFORE the `img` branch's `return`, so move the three
"computed and never read" reports above it — or read `st.verticalAlign` inside
the `img` branch as well. Whichever you choose, an `<img>` must reach the
check exactly once.

- [ ] **Step 4: Emit atomics from `cssflow.ts`**

Replace the two `c.skipped.push({ … construct: 'image' … })` loops with a
builder that resolves each atomic, reporting only the ones it cannot:

```ts
/** The CSS used size of an `<img>`, in POINTS.
 *
 *  Stated width/height win; otherwise the intrinsic pixel size is read as CSS
 *  px, with the aspect preserved when only one is stated. The `x 0.75` px->pt
 *  conversion happens HERE and nowhere else, which is CLAUDE.md's rule. */
function atomicBox(
  a: AtomicInline, data: Uint8Array,
): { width: number; height: number } | undefined {
  const nat = imageSize(data);
  if (nat === undefined || nat.width <= 0 || nat.height <= 0) return undefined;
  const s = a.style;
  const wPx = 'auto' in s.width ? undefined : fixedPx(s.width);
  const hPx = 'auto' in s.height ? undefined : fixedPx(s.height);
  const aspect = nat.height / nat.width;
  let w = wPx ?? (hPx !== undefined ? hPx / aspect : nat.width);
  let h = hPx ?? (wPx !== undefined ? wPx * aspect : nat.height);
  if (!(w > 0) || !(h > 0)) { w = nat.width; h = nat.height; }
  return { width: pt(w), height: pt(h) };
}

const ALIGN_OF: Record<string, 'baseline' | 'top' | 'bottom'> = {
  baseline: 'baseline', top: 'top', bottom: 'bottom',
};

/** Every atomic that resolves, as a FlowAtomic; the rest are reported. */
function atomicsOf(
  content: { runs: TextRun[]; atomics: AtomicInline[] }, c: Ctx,
): FlowAtomic[] {
  const out: FlowAtomic[] = [];
  for (const a of content.atomics) {
    const src = a.el.attrs.get('src') ?? '';
    const alt = a.el.attrs.get('alt') ?? '';
    const data = decodeDataUri(src) ?? c.resolveImage?.(src, alt);
    const box = data === undefined ? undefined : atomicBox(a, data);
    if (data === undefined || box === undefined) {
      c.skipped.push({ el: a.el, kind: 'dropped', construct: 'image', detail: src });
      continue;
    }
    out.push({
      beforeRun: a.beforeRun, data, width: box.width, height: box.height,
      align: ALIGN_OF[a.style.verticalAlign] ?? 'baseline',
    });
  }
  return out;
}
```

In `mapBox`'s inline branch, the lone-image fast path stays exactly as it is —
a lone image is still a block figure and takes `image()`. Otherwise:

```ts
    const atomics = atomicsOf(box.content, c);
    const runs = scaleRuns(box.content.runs);
    if (runs.length === 0 && atomics.length === 0) return [];
    return frameBoxes(
      textElement(runs, box.el, style, atomics), frameOf(r), spacing);
```

`textElement` gains an `atomics` parameter and passes it into `paragraph`'s
and `heading`'s options. Do the same in `mapList`'s inline branch, where the
item's `text` becomes runs and its atomics ride the item's own options.

Import `imageSize` from `./imageembed.js`, `FlowAtomic` from `./flow.js`, and
`fixedPx` from `./cssvalue.js`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run typecheck && npx vitest run test/htmlreport-render.test.ts test/htmlflow.test.ts test/cssflow-report.test.ts test/cssflow.test.ts`
Expected: all PASS. `cssflow-report`'s "names an image by its src" and
"reports in document order" use unresolvable `.png` names and keep working.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: green. If `test/rich-runs-identity.test.ts` is red, STOP.

- [ ] **Step 7: Commit**

```bash
git add src/cssflow.ts src/cssinline.ts test/
git commit -m "feat(zch2.11): render an img among words through AddHtml"
```

---

### Task 10: end to end

**Files:**
- Modify: `test/htmlreport-render.test.ts`

- [ ] **Step 1: Write the tests**

```ts
suite('inline images end to end (zch2.11)', () => {
  const PNG = 'data:image/png;base64,'
    + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('puts the following word to the RIGHT of the image', () => {
    // The pen-advance rule, end to end: without the TJ kern "after" would sit
    // where it sits with no image at all, on top of the picture.
    const withImg = render(`<p>before <img src="${PNG}" style="width:60px;height:12px"> after</p>`)
      .page.GetTextFragments().find((f) => f.text.includes('after'))!;
    const without = render('<p>before  after</p>')
      .page.GetTextFragments().find((f) => f.text.includes('after'))!;
    expect(withImg.quad[0]).toBeGreaterThan(without.quad[0] + 40);
  });

  it('wraps to a second line when the image does not fit', () => {
    const r = render(
      `<p>aaaa bbbb cccc <img src="${PNG}" style="width:300px;height:12px"> dddd</p>`,
      200);
    expect(r.text).toContain('aaaa');
    expect(r.text).toContain('dddd');
  });

  it('keeps a LONE image on the block path', () => {
    // zch2.6's figure rule is untouched: a lone image is still a block image,
    // not an atomic, so its width still fills the column.
    const r = render(`<p><img src="${PNG}"></p>`);
    expect(r.names).toEqual([]);
    expect(new TextDecoder().decode(r.page.GetContent())).toMatch(/Do/);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/htmlreport-render.test.ts`
Expected: PASS — Tasks 2-9 already made it work; this is the guard at the
public boundary.

- [ ] **Step 3: Commit**

```bash
git add test/htmlreport-render.test.ts
git commit -m "test(zch2.11): inline images end to end"
```

---

### Task 11: mutation sweep

Reuse the harness from `zch2.6`/`zch2.7` (a throwaway script in the session
scratchpad, not `scripts/`):

```js
// mutate.mjs — apply one mutation, run tests, report which redden, restore.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const [, , srcPath, testPath, specPath] = process.argv;
const MUTATIONS = JSON.parse(readFileSync(specPath, 'utf8'));
const original = readFileSync(srcPath, 'utf8');
for (const m of MUTATIONS) {
  if (!original.includes(m.find)) { console.log(`!! ${m.name}: FIND NOT PRESENT`); continue; }
  writeFileSync(srcPath, original.replace(m.find, m.replace));
  let out = '';
  try {
    out = execSync(`npx vitest run ${testPath} --reporter=json`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { out = e.stdout ?? ''; }
  let failed;
  try {
    failed = JSON.parse(out.slice(out.indexOf('{'))).testResults
      .flatMap((f) => f.assertionResults).filter((a) => a.status === 'failed')
      .map((a) => a.title);
  } catch { failed = ['<<could not parse reporter output>>']; }
  console.log(`\n== ${m.name}`);
  console.log(failed.length === 0 ? '   NOTHING REDDENED' : failed.map((t) => `   red: ${t}`).join('\n'));
}
writeFileSync(srcPath, original);
console.log('\nrestored');
```

Test target throughout:
`test/linebox.test.ts test/layout-atomics.test.ts test/stamp-atomics.test.ts test/flow-atomics.test.ts test/imageembed-size.test.ts test/htmlreport-render.test.ts test/htmlflow.test.ts test/rich-runs-identity.test.ts`

- [ ] **Step 1: Mutate `src/linebox.ts`**

| Mutation | Must redden |
|---|---|
| a top/bottom item contributes to `ascent` | the top-aligned and bottom-aligned cases |
| the `banded` term is dropped from the `height` max | the top and bottom cases |
| the `ascent === 0` fallback is removed | the empty-line case |
| `Math.max` over `ascent` becomes `Math.min` | the tall-baseline-image case and the collapse case |

- [ ] **Step 2: Mutate `src/layout.ts`**

| Mutation | Must redden |
|---|---|
| `spanWidth` measures U+FFFC instead of using `atomic.width` | the line-width and wrapping cases |
| the atomic segment keeps `text: '￼'` | the "never puts U+FFFC in a line's text" case |
| the clamp is removed | the three over-wide cases |
| the clamp scales width but not height | the clamped-height-to-the-band case |
| `itemsOf` gives an atomic `align: 'baseline'` always | the top-aligned case |

- [ ] **Step 3: Mutate `src/stamp.ts`**

| Mutation | Must redden |
|---|---|
| the `TJ` kern is not emitted | the pen-advance cases, and the end-to-end "to the RIGHT" case |
| the kern's sign is flipped | the same cases |
| `weaveAtomics` appends every atomic at the end | the placement cases |
| `sliceContent` carries `beforeRun` unchanged | the column-break case |
| the image `y` ignores `align` | expected to redden NOTHING unless a fixture asserts a top-aligned image's y — **add one if so, else record as uncovered** |

- [ ] **Step 4: Record the results and close real gaps**

Any mutation that SHOULD redden and does not means the test is not
load-bearing: add the case, then re-run. Any expected to redden nothing goes
into `CLAUDE.md` in Task 12 as an explicitly uncovered rule.

- [ ] **Step 5: Commit**

```bash
git add test/
git commit -m "test(zch2.11): close the gaps the mutation sweep found"
```

---

### Task 12: documentation

**Files:**
- Modify: `CLAUDE.md`, `CHANGELOG.md`, `README.md`

- [ ] **Step 1: CLAUDE.md**

Add a `linebox.ts` entry to the Source list carrying, as invariants: that it
imports nothing and knows no font; that it never throws; that `ascent` is the
above-baseline extent and a `top`/`bottom` item contributes 0 to it while
raising the band; and — the one that matters most — that **with no atomics it
COLLAPSES to layout.ts's pre-zch2.11 arithmetic exactly**, which is what makes
`rich-runs-identity`'s four hashes hold by construction rather than by
tolerance.

Add to the `layout.ts` prose in the **graphics.ts / layout.ts** entry: that an
atomic is a U+FFFC character, and that this is what lets units, the UAX #14
search, `piecesOf` and the remainder work unchanged — naming it as the reason
the issue's own prediction (that all of those needed a non-text unit) was
wrong. Record that `LaidLine.maxFontSize` KEPT ITS NAME while gaining a second
meaning (a baseline-aligned atomic's height), because four modules read it.
Record the clamp and that it feeds the CLAMPED height to the band.

Add to `stamp.ts`'s prose: the `TJ` kern and WHY — `buildRunBlockBody` emits
no per-segment `Td`, so an atomic that emits no `Tj` advances nothing and the
following text overprints the image. Record that `sliceContent` re-bases
`beforeRun` and that `flow.ts`'s `TextElement` builds its continuation with
`{ ...this.opts, atomics: remainderAtomics }` — with the note that carrying
`this.opts` unchanged makes an image vanish at a column break, which only a
fixture that overflows can see.

Add to `cssinline.ts`'s entry: that `vertical-align` now has TWO rules — an
atomic reports only an unimplemented value, a non-atomic reports every
non-baseline one — and that a single widened rule satisfies either fixture
alone, which is why both exist.

Then run the module sweep and confirm `linebox.ts` is covered:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected output: the five pre-existing entries (`colorkey.ts`, `errors.ts`,
`formremove.ts`, `htmlforms.ts`, `tabletag.ts`) and NOTHING else.

- [ ] **Step 2: CHANGELOG.md**

Under `## [Unreleased]` → `### Added`, newest first. Say what a user gets — an
`<img>` among words now renders instead of being reported, with `width`/
`height`/intrinsic sizing and `vertical-align: baseline`/`top`/`bottom`. Say
the limits: `middle` is not implemented and stays reported, Markdown's
`loneImage` is unchanged (its own issue), and a lone image is still a block
figure. Note the new `paragraph({ atomics })` authoring option, since it is a
new public surface. Cite `(zch2.11)`.

- [ ] **Step 3: README.md**

In the Limitations paragraph, remove "an image sharing its line with text is
reported rather than drawn, since a picture cannot yet be placed inside a
line" from the four table/image degradations — it is now three. In the HTML
feature bullet, note that an inline image renders.

- [ ] **Step 4: Verify everything**

```bash
npm run typecheck && npm test && npm run build
```

Expected: typecheck clean, all files green, `dist/index.js` produced.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md CHANGELOG.md README.md
git commit -m "docs(zch2.11): CHANGELOG, README and CLAUDE.md for inline atomics"
```

- [ ] **Step 6: Close, file the follow-up, and push**

```bash
bd close zch2.11 --reason "<what shipped, the limits, the mutation results>"
bd create "Lift mdflow.ts's loneImage: inline images in Markdown" -t feature -p 3 \
  --deps aspose-pdf-foss-for-ts-zch2.11
git add -A .beads && git commit -m "chore(beads): close zch2.11"
git checkout main && git merge --ff-only <branch> && git push origin main
git status -sb   # MUST show main...origin/main with no ahead/behind
```

**No `--parent`, and that is deliberate:** `gl6o`, the Markdown epic, is
CLOSED, so hanging a new child off it would reopen a finished epic to hold one
follow-up. The issue stands alone with a dependency on `zch2.11`, which is
what actually orders the work. Say in its body that the engine landed in
`zch2.11` and that all it needs is to stop routing through `loneImage`.

---

## Self-review

**Spec coverage.** Every spec section maps to a task: `linebox.ts` and its
collapse to Task 1; the U+FFFC representation, widths, band wiring and the
atomic segment to Task 2; the clamp to Task 3; the interleave and the `TJ`
kern to Task 4; `drawBuiltImage` to Task 5; the remainder trap to Task 6; the
`FlowAtomic` bytes-not-a-stream rule to Task 7; `imageSize` to Task 8; CSS
sizing, the align mapping and the split `vertical-align` report to Task 9; the
testing section to Tasks 1-3, 9 and 10; the mutation sweep to Task 11;
documentation to Task 12. The "out of scope" list needs no task — it is
prohibitions, and Markdown's is enforced by a Global Constraint plus the
follow-up issue Task 12 files.

**Type consistency.** `AtomicBox`, `TextLayoutRun`, `AtomicLayoutRun`,
`LayoutRun`, `isAtomicRun` and `LaidSegment.atomic` are defined in Task 2 and
used with those names in Tasks 3, 4 and 5. `BlockAtomic` is defined in Task 4
and used in Tasks 6 and 7. `FlowAtomic` is defined in Task 7 and used in
Task 9. `imageSize` is defined in Task 8 and used in Task 9. `lineBox` and
`LineItem` are defined in Task 1 and used in Task 2.

**Three things this plan deliberately does not do**, named so they are not
read as omissions. `LaidLine.maxFontSize` is NOT renamed, though its meaning
widens — four modules read it and a rename is churn with no test behind it.
`sliceRuns` IS deleted rather than kept beside `sliceContent`, because two
remainder rebuilders is exactly the drift this repo keeps recording. And
`tableauthor.ts` and `floatbox.ts` INHERIT the capability through `layoutRuns`
without gaining an authoring surface for it — that is the spec's out-of-scope
call, and nothing here exposes it.

**One mutation is predicted to redden nothing** and is called out in Task 11
rather than discovered: the image `y` ignoring `align`, unless Task 9's
top-aligned fixture happens to assert a coordinate. The step says to add the
assertion or record it as uncovered.
