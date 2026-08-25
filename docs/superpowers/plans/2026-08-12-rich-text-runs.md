# Rich Inline Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a wrapped text block carry a list of differently-styled runs — `[{ text: 'a' }, { text: 'b', font: 'Helvetica-Bold' }]` — through wrapping, pagination and emission, so `gl6o.3.2` can render a Markdown paragraph.

**Architecture:** `layoutText` becomes a one-run wrapper over a new `layoutRuns`, keeping one wrapping engine for the four modules that measure and paint through it. `TextRun` lives in `textdecor.ts` (which already owns the styling vocabulary) because `stamp.ts` imports `layout.ts` and the reverse would invert that. Every existing string entry point keeps its exact signature via overloads, and a byte-identity corpus captured *before* the refactor proves their output does not move.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext:** every import specifier carries the `.js` extension.
- **Byte identity is the gate.** Every existing string call site must emit the same content-stream bytes after this change as before. Task 1 captures that corpus and every later task re-runs it.
- **`layout.ts` never sees an `AuthoringFont`.** It works through `FontDriver`, as it does today. The font-to-driver resolution belongs to `stamp.ts`.
- **A rejected call leaves the document untouched.** Validate every run before emitting any byte.
- **Design doc:** `docs/superpowers/specs/2026-08-12-rich-text-runs-design.md`. Read it before starting.
- **Quality gate before closing any task:** `npm run typecheck` and `npm test` both green.
- **Reading a page's emitted bytes in a test:** `new TextDecoder('latin1').decode(page.Contents)` — the established pattern, see `test/stamp.test.ts:9`.

---

### Task 1: Capture the byte-identity corpus

**This task must land before any `src/` change.** Its hashes are the record of how the engine behaves today; generated after a refactor they prove nothing.

**Files:**
- Create: `test/rich-runs-identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a corpus every later task re-runs unchanged.

- [ ] **Step 1: Write the corpus with empty expected hashes**

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';
import { buildUnicodeTtf } from './helpers/build-embed-fonts.js';

/** The bytes a page emitted, hashed.
 *
 *  This suite is a REGRESSION FENCE for gl6o.3.1, not a feature test. The rich-run
 *  refactor rebuilds the wrapping engine and the block emitter underneath every
 *  existing caller; nothing else in the suite would notice a half-point drift in a
 *  table cell or one dropped `Tw`. These hashes were generated from the
 *  implementation BEFORE that refactor. If one changes, the output moved — either
 *  fix the change or, if the move is genuinely intended, say so in the commit
 *  message and re-record deliberately. */
const sha = (page: { Contents: Uint8Array }): string =>
  createHash('sha256').update(page.Contents).digest('hex').slice(0, 16);

const LOREM = 'The quick brown fox jumps over the lazy dog, and then it does so again '
  + 'because one sentence is not enough to force a wrap in a narrow column.';

/** Each case builds a document and returns the page whose bytes are hashed. */
const CASES: Record<string, () => { Contents: Uint8Array }> = {
  'textblock-plain': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200]);
    return page;
  },
  'textblock-justified': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200], { align: 'justify' });
    return page;
  },
  'textblock-decorated': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200], {
      underline: true, strikethrough: { thickness: 2 }, background: [0.9, 0.9, 1],
    });
    return page;
  },
  'textblock-rotated-centered': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(LOREM, [50, 500, 200, 200], {
      rotate: 30, align: 'center', valign: 'center', opacity: 0.5,
    });
    return page;
  },
  'textblock-embedded': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const font = doc.AddFont(buildUnicodeTtf());
    page.AddTextBlock(LOREM, [50, 500, 200, 200], { font, align: 'justify' });
    return page;
  },
  'flow-paragraph-heading-list': () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, columns: 2 });
    flow.AddHeading(1, 'A Heading That Is Long Enough To Wrap Across Lines');
    flow.AddParagraph(LOREM, { align: 'justify' });
    flow.AddList(['first item', { text: 'second item', items: ['nested one', 'nested two'] }],
      { ordered: true });
    flow.AddParagraph(LOREM);
    return flow.Render()[0];
  },
  'table-cell': () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const t = createTable();
    t.addRow().addCell('short').addCell(LOREM);
    t.addRow().addCell('another').addCell('cell text');
    page.AddTable(t, 72, 720, { width: 300 });
    return page;
  },
  'floating-box': () => {
    const doc = Document.New();
    const box = doc.NewFloatingBox({ width: 150 });
    box.AddParagraph(LOREM);
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(LOREM);
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph(LOREM);
    return flow.Render()[0];
  },
};

/** Filled in by Step 3. */
const EXPECTED: Record<string, string> = {};

describe('byte identity across the rich-run refactor', () => {
  it('covers every string call site the refactor passes through', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [name, build] of Object.entries(CASES)) {
    it(`${name} emits unchanged bytes`, () => {
      expect(sha(build())).toBe(EXPECTED[name]);
    });
  }
});
```

- [ ] **Step 2: Run it and confirm every case fails on the hash, not on an error**

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: FAIL — each case reports `expected '<hash>' to be undefined`. If any case throws instead (a wrong API name, a missing helper), fix the case: a throwing case records nothing.

- [ ] **Step 3: Record the hashes**

Print them:

```bash
npx vitest run test/rich-runs-identity.test.ts --reporter=verbose 2>&1 | grep -o "expected '[0-9a-f]*'" | sort -u
```

Simpler and less brittle: temporarily change the assertion to
`expect({ [name]: sha(build()) }).toEqual({})`, run once, copy each name/hash
pair from the diff into `EXPECTED`, then restore the assertion.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/rich-runs-identity.test.ts`
Expected: PASS, 9 tests (8 cases + the coverage check).

- [ ] **Step 5: Prove the fence actually catches movement**

In `src/stamp.ts`, temporarily change `alignOffset`'s centre case from
`(boxWidth - lineWidth) / 2` to `(boxWidth - lineWidth) / 2 + 0.01` and re-run.
Expected: `textblock-rotated-centered` FAILS. Revert and re-run: PASS.

A fence nobody has seen fail is a fence nobody knows is connected.

- [ ] **Step 6: Commit**

```bash
git add test/rich-runs-identity.test.ts
git commit -m "test(text): byte-identity corpus for the rich-run refactor (gl6o.3.1)"
```

---

### Task 2: `TextRun` in textdecor.ts

**Files:**
- Modify: `src/textdecor.ts`
- Create: `test/rich-runs.test.ts`

**Interfaces:**
- Consumes: `DecorationOptions`, `AuthoringFont` (both already in scope in `textdecor.ts`).
- Produces:
  ```ts
  export interface TextRun extends DecorationOptions {
    text: string;
    font?: AuthoringFont;
    fontSize?: number;
    color?: [number, number, number];
  }
  export function isTextRunList(v: string | TextRun[]): v is TextRun[];
  ```

- [ ] **Step 1: Write the failing test**

Create `test/rich-runs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isTextRunList, type TextRun } from '../src/textdecor.js';

describe('isTextRunList', () => {
  it('distinguishes a run list from a string', () => {
    expect(isTextRunList('hello')).toBe(false);
    expect(isTextRunList([{ text: 'hello' }])).toBe(true);
    expect(isTextRunList([])).toBe(true);
  });

  it('narrows the type for a caller', () => {
    const v: string | TextRun[] = [{ text: 'a', fontSize: 9 }];
    expect(isTextRunList(v) ? v[0].fontSize : 0).toBe(9);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/rich-runs.test.ts`
Expected: FAIL — `isTextRunList` is not exported from textdecor.

- [ ] **Step 3: Add the type and the guard**

In `src/textdecor.ts`, after the `DecorationOptions` interface:

```ts
/** One styled span of a rich text block.
 *
 *  Every property but `text` falls back to the block's own option when unset, so
 *  `[{ text: 'a' }, { text: 'b', font: 'Helvetica-Bold' }]` inherits size and
 *  colour from the paragraph rather than restating them.
 *
 *  The split is character-level versus line-level: a run carries what applies to
 *  glyphs, while `align`, `valign`, `leading`, `rotate`, `opacity` and `behind`
 *  describe a line or a block and stay on the block options.
 *
 *  It lives here rather than in layout.ts because it names an AuthoringFont,
 *  which stamp.ts defines — and stamp.ts imports layout.ts, so the reverse would
 *  invert that dependency. This module already owns Decoration and Background and
 *  already takes AuthoringFont as a type-only import. */
export interface TextRun extends DecorationOptions {
  text: string;
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
}

/** Whether a `string | TextRun[]` argument is the run form. */
export function isTextRunList(v: string | TextRun[]): v is TextRun[] {
  return Array.isArray(v);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/rich-runs.test.ts && npm run typecheck`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/textdecor.ts test/rich-runs.test.ts
git commit -m "feat(text): the TextRun styling vocabulary (gl6o.3.1)"
```

---

### Task 3: `layoutRuns` — one wrapping engine

The core of the piece. `layout.ts` stays pure: no `AuthoringFont`, no PDF objects.

**Files:**
- Modify: `src/layout.ts`
- Create: `test/layout-runs.test.ts`

**Interfaces:**
- Consumes: `FontDriver` (already in `layout.ts`).
- Produces:
  ```ts
  export interface LayoutRun { text: string; driver: FontDriver; fontSize: number }
  export interface LaidSegment { run: number; text: string; width: number; bytes: Uint8Array }
  export interface RunSlice { run: number; text: string }
  // LaidLine gains: segments: LaidSegment[]
  export function layoutRuns(
    runs: LayoutRun[], boxWidth: number, boxHeight: number, leading: number,
  ): { lines: LaidLine[]; remainder: RunSlice[] };
  ```
  `layoutText(text, driver, fontSize, boxWidth, boxHeight, leading)` keeps its exact
  signature and return type (`remainder: string`).

- [ ] **Step 1: Write the failing tests**

Create `test/layout-runs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { layoutRuns, layoutText, winAnsiDriver, type LayoutRun } from '../src/layout.js';

const helv = winAnsiDriver('Helvetica');
const run = (text: string, fontSize = 10): LayoutRun => ({ text, driver: helv, fontSize });

/** The text of each laid line, for readability in assertions. */
const texts = (r: { lines: { text: string }[] }): string[] => r.lines.map((l) => l.text);

describe('layoutRuns', () => {
  it('wraps a single run exactly as layoutText does', () => {
    const width = 60;
    const a = layoutRuns([run('one two three four five')], width, Infinity, 12);
    const b = layoutText('one two three four five', helv, 10, width, Infinity, 12);
    expect(texts(a)).toEqual(texts(b));
  });

  // The whole reason segments exist: a word may span a style boundary.
  it('does not break between runs inside one word', () => {
    // 'boldtext' is one word; at a width that fits it but not the following word,
    // it must stay whole on one line.
    const r = layoutRuns([run('bold'), run('text'), run(' and more words here')], 40, Infinity, 12);
    expect(r.lines[0].text.startsWith('boldtext')).toBe(true);
  });

  it('splits one line into a segment per run', () => {
    const r = layoutRuns([run('aa'), run('bb'), run('cc')], 200, Infinity, 12);
    expect(r.lines.length).toBe(1);
    expect(r.lines[0].text).toBe('aabbcc');
    expect(r.lines[0].segments.map((s) => [s.run, s.text])).toEqual([[0, 'aa'], [1, 'bb'], [2, 'cc']]);
  });

  it('measures a line as the sum of its segments', () => {
    const r = layoutRuns([run('aa'), run('bb')], 200, Infinity, 12);
    const total = r.lines[0].segments.reduce((n, s) => n + s.width, 0);
    expect(r.lines[0].width).toBeCloseTo(total, 9);
  });

  it('gives a run its own size when measuring', () => {
    const small = layoutRuns([run('aaaa', 6)], 200, Infinity, 12).lines[0].width;
    const large = layoutRuns([run('aaaa', 24)], 200, Infinity, 12).lines[0].width;
    expect(large).toBeCloseTo(small * 4, 6);
  });

  it('carries the split run forward in the remainder', () => {
    // Two runs, wrapped so the break falls inside the second.
    const r = layoutRuns([run('alpha '), run('beta gamma delta')], 45, 12, 12);
    expect(r.lines.length).toBe(1);
    expect(r.remainder.every((s) => s.run === 1)).toBe(true);
    expect(r.remainder.map((s) => s.text).join('')).toContain('gamma');
  });

  it('reports an empty remainder when everything fits', () => {
    expect(layoutRuns([run('a b')], 200, 100, 12).remainder).toEqual([]);
  });

  it('drops empty runs without emitting empty segments', () => {
    const r = layoutRuns([run('aa'), run(''), run('bb')], 200, Infinity, 12);
    expect(r.lines[0].segments.map((s) => s.text)).toEqual(['aa', 'bb']);
  });
});

describe('layoutText', () => {
  it('still returns a string remainder', () => {
    const r = layoutText('one two three four five six', helv, 10, 40, 24, 12);
    expect(typeof r.remainder).toBe('string');
    expect(r.remainder.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/layout-runs.test.ts`
Expected: FAIL — `layoutRuns` is not exported.

- [ ] **Step 3: Rewrite `layout.ts`'s wrapping over runs**

First change `breakOverwideWord`'s measure callback from string-based to
index-based, so a piece is measured at its real position in whatever runs it
spans. Only its signature and the one call inside it change:

```ts
/** Split `word` (already known to exceed `boxWidth`) into pieces at UAX #14 break
 *  opportunities, each as wide as fits. Pieces join with `''` (no space). A piece
 *  with no interior opportunity that still overflows is emitted whole.
 *
 *  `measure` takes CHARACTER indices into `word` rather than a substring: an
 *  over-wide token may span several runs, and only its position says which font
 *  measures which part of it. */
function breakOverwideWord(
  word: string, measure: (fromChar: number, toChar: number) => number, boxWidth: number,
): string[] {
  const chars = [...word];
  const codes = chars.map((c) => c.codePointAt(0)!);
  const brk = lineBreakOpportunities(codes); // brk[i] = boundary before chars[i]
  const pieces: string[] = [];
  let start = 0;      // index into chars
  let lastOpp = -1;   // last break-opportunity index seen since `start`
  for (let i = start + 1; i <= chars.length; i++) {
    const overflow = measure(start, i) > boxWidth;
    if (overflow && lastOpp > start) {
      pieces.push(chars.slice(start, lastOpp).join(''));
      start = lastOpp; lastOpp = -1; i = start; // restart the scan from the break
      continue;
    }
    if (i < chars.length && brk[i] !== LBRK.PROHIBITED) lastOpp = i;
  }
  pieces.push(chars.slice(start).join(''));
  return pieces;
}
```

Then replace `LaidLine`, `LayoutResult` and `layoutText` with the following,
keeping `FontDriver` and `winAnsiDriver` exactly as they are:

```ts
/** One run as the layout engine sees it: already resolved to a driver and a
 *  size. layout.ts never learns what an AuthoringFont is — stamp.ts owns that
 *  resolution, and owning it in one place is what keeps a block from being
 *  measured one way and painted another. */
export interface LayoutRun {
  text: string;
  driver: FontDriver;
  fontSize: number;
}

/** The piece of one laid line contributed by one run. */
export interface LaidSegment {
  /** Index into the `runs` array passed to {@link layoutRuns}. */
  run: number;
  text: string;
  width: number;
  bytes: Uint8Array;
}

/** A piece of unconsumed text, tagged with the run it came from. */
export interface RunSlice { run: number; text: string }

/** A single positioned line produced by {@link layoutRuns}. */
export interface LaidLine {
  /** The line's text (no trailing newline), all runs concatenated. */
  text: string;
  /** Measured width in points: the sum of the segment widths. */
  width: number;
  /** Encoded bytes for the whole line. Meaningful only for a single-run line;
   *  the emitter writes `segments`. */
  bytes: Uint8Array;
  /** True if this line ends a paragraph (an explicit `\n`) or is the last
   *  emitted line. Used to suppress justification on final/short lines. */
  hardBreak: boolean;
  /** The line split at run boundaries, in order. Never empty for a non-empty line. */
  segments: LaidSegment[];
}

export interface LayoutResult {
  lines: LaidLine[];
  /** Unconsumed text (`''` if everything fit). */
  remainder: string;
}

export interface RunLayoutResult {
  lines: LaidLine[];
  /** Unconsumed text as run slices (`[]` if everything fit). */
  remainder: RunSlice[];
}

// Tolerance so an exact n*leading box height fits n lines despite float drift.
const EPS = 1e-9;

/** One word: a half-open span [start, end) into the concatenated run text, plus
 *  whether a separator space precedes it on its line.
 *
 *  Lines are lists of these rather than one contiguous span, because the engine
 *  COLLAPSES runs of spaces — `split(' ').filter(w => w !== '')` in the code this
 *  replaces — so `a  b` lays out as `a b`. A span-based line would preserve the
 *  double space and move the bytes of every existing caller. */
interface Unit { start: number; end: number; spaceBefore: boolean }

interface WrappedLine {
  units: Unit[];
  /** Separator to restore AFTER this line when reflowing the remainder:
   *  `' '` a soft space wrap, `'\n'` a paragraph boundary, `''` a zero-width
   *  (UAX #14 / CJK) break inside an over-wide token. */
  sepAfter: ' ' | '' | '\n';
}

/** The concatenated run text plus, for each character, the run it came from. */
function joinRuns(runs: LayoutRun[]): { text: string; owner: Uint32Array } {
  let text = '';
  for (const r of runs) text += r.text;
  const owner = new Uint32Array(text.length);
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    owner.fill(i, at, at + runs[i].text.length);
    at += runs[i].text.length;
  }
  return { text, owner };
}

/** Wrap `runs` into a box, greedily, honoring explicit `\n`.
 *
 *  **Invariant:** break opportunities are found on the CONCATENATED text, never
 *  per run. `**bold**text` is one word and must not break at the style boundary.
 *  That is why everything below indexes into the joined string and only splits at
 *  run boundaries at the very end, when a kept line is cut into segments.
 *
 *  Widths are summed per segment rather than measured over the whole line. For
 *  the WinAnsi and Identity-H drivers a string's width is the sum of its glyph
 *  advances, so the two agree exactly — which is what lets the single-run path
 *  stay byte-identical. It would NOT hold for a shaping driver, which is one more
 *  reason shaping stays single-run. */
export function layoutRuns(
  runs: LayoutRun[], boxWidth: number, boxHeight: number, leading: number,
): RunLayoutResult {
  const { text, owner } = joinRuns(runs);
  if (text === '') return { lines: [], remainder: [] };

  /** Width of the joined text's [from, to) span, each part in its own run's size. */
  const spanWidth = (from: number, to: number): number => {
    let w = 0;
    let i = from;
    while (i < to) {
      const r = owner[i];
      let j = i;
      while (j < to && owner[j] === r) j++;
      w += runs[r].driver.measure(text.slice(i, j), runs[r].fontSize);
      i = j;
    }
    return w;
  };

  /** Width of a separator space, measured in the run that precedes it — the run
   *  whose `Tf` is in force when that space is emitted. */
  const spaceWidth = (at: number): number => {
    const r = runs[owner[at]];
    return r.driver.measure(' ', r.fontSize);
  };

  // --- Phase A: wrap every paragraph into lines (ignoring height). ---
  const wrapped: WrappedLine[] = [];
  let paraStart = 0;
  for (;;) {
    const nl = text.indexOf('\n', paraStart);
    const paraEnd = nl < 0 ? text.length : nl;

    // Words are maximal non-space spans of the joined text, so a word may cross
    // any number of run boundaries. Runs of spaces collapse to one separator,
    // exactly as the string engine did.
    const units: Unit[] = [];
    let i = paraStart;
    let first = true;
    while (i < paraEnd) {
      while (i < paraEnd && text[i] === ' ') i++;
      if (i >= paraEnd) break;
      let j = i;
      while (j < paraEnd && text[j] !== ' ') j++;
      const spaceBefore = !first;
      first = false;
      if (spanWidth(i, j) > boxWidth) {
        // An over-wide token expands into UAX #14 sub-pieces joined with ''.
        // The measure is index-based so each piece is measured at its real
        // position, in whatever runs it actually spans.
        const word = text.slice(i, j);
        const chars = [...word];
        const off: number[] = [0];
        for (const c of chars) off.push(off[off.length - 1] + c.length);
        const pieces = breakOverwideWord(word,
          (a, b) => spanWidth(i + off[a], i + off[b]), boxWidth);
        let at = i;
        pieces.forEach((pc, pi) => {
          units.push({ start: at, end: at + pc.length, spaceBefore: pi === 0 ? spaceBefore : false });
          at += pc.length;
        });
      } else {
        units.push({ start: i, end: j, spaceBefore });
      }
      i = j;
    }

    // Greedy pack. Widths accumulate per unit rather than by re-measuring the
    // whole line: for the WinAnsi and Identity-H drivers a string's width is the
    // sum of its glyph advances, so the two agree exactly.
    const paraLines: { units: Unit[]; sepAfter: ' ' | '' }[] = [];
    let cur: Unit[] = [];
    let curWidth = 0;
    for (const u of units) {
      if (cur.length === 0) { cur = [u]; curWidth = spanWidth(u.start, u.end); continue; }
      const sep = u.spaceBefore ? spaceWidth(cur[cur.length - 1].end - 1) : 0;
      const next = curWidth + sep + spanWidth(u.start, u.end);
      if (next <= boxWidth) { cur.push(u); curWidth = next; continue; }
      paraLines.push({ units: cur, sepAfter: u.spaceBefore ? ' ' : '' });
      cur = [u];
      curWidth = spanWidth(u.start, u.end);
    }
    paraLines.push({ units: cur, sepAfter: '' }); // final line, or an empty paragraph

    for (let k = 0; k < paraLines.length; k++) {
      wrapped.push({
        units: paraLines[k].units,
        sepAfter: k === paraLines.length - 1 ? '\n' : paraLines[k].sepAfter,
      });
    }

    if (nl < 0) break;
    paraStart = nl + 1;
  }

  // --- Phase B: keep the lines whose baselines fit the box height. ---
  let used = 0;
  let kept = 0;
  while (kept < wrapped.length && used + leading <= boxHeight + EPS) {
    used += leading;
    kept++;
  }

  /** Walk a line's units into run-tagged pieces, inserting one separator space
   *  before each unit that had one. Adjacent pieces from the same run merge, so a
   *  single-run line yields exactly ONE piece holding the whole line — which is
   *  what makes its measurement and its emitted bytes identical to the string
   *  engine's. */
  const piecesOf = (units: Unit[]): { run: number; text: string }[] => {
    const out: { run: number; text: string }[] = [];
    const push = (run: number, t: string): void => {
      const last = out[out.length - 1];
      if (last !== undefined && last.run === run) { last.text += t; return; }
      out.push({ run, text: t });
    };
    for (let ui = 0; ui < units.length; ui++) {
      const u = units[ui];
      // The space is emitted under the preceding run's Tf, so it belongs to it.
      if (u.spaceBefore && ui > 0) push(owner[units[ui - 1].end - 1], ' ');
      let i = u.start;
      while (i < u.end) {
        const r = owner[i];
        let j = i;
        while (j < u.end && owner[j] === r) j++;
        push(r, text.slice(i, j));
        i = j;
      }
    }
    return out;
  };

  const lines: LaidLine[] = [];
  for (let k = 0; k < kept; k++) {
    const segments: LaidSegment[] = piecesOf(wrapped[k].units).map((p) => ({
      run: p.run,
      text: p.text,
      width: runs[p.run].driver.measure(p.text, runs[p.run].fontSize),
      bytes: runs[p.run].driver.encode(p.text),
    }));
    lines.push({
      text: segments.map((s) => s.text).join(''),
      width: segments.reduce((n, s) => n + s.width, 0),
      bytes: segments.length === 1 ? segments[0].bytes : concatBytes(segments),
      hardBreak: wrapped[k].sepAfter === '\n' || k === kept - 1,
      segments,
    });
  }

  // Reconstruct the remainder from the leftover lines, restoring each line's
  // separator, and tag each piece with the run it came from.
  const remainder: RunSlice[] = [];
  const pushSlice = (run: number, t: string): void => {
    const last = remainder[remainder.length - 1];
    if (last !== undefined && last.run === run) { last.text += t; return; }
    remainder.push({ run, text: t });
  };
  for (let k = kept; k < wrapped.length; k++) {
    for (const p of piecesOf(wrapped[k].units)) pushSlice(p.run, p.text);
    const units = wrapped[k].units;
    if (k < wrapped.length - 1 && wrapped[k].sepAfter !== '' && units.length > 0) {
      // The separator belongs to the run that ended the line.
      pushSlice(owner[units[units.length - 1].end - 1], wrapped[k].sepAfter);
    }
  }

  return { lines, remainder };
}

function concatBytes(segments: LaidSegment[]): Uint8Array {
  let n = 0;
  for (const s of segments) n += s.bytes.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const s of segments) { out.set(s.bytes, at); at += s.bytes.length; }
  return out;
}

/** Greedy word-wrap of `text` into lines no wider than `boxWidth`, honoring
 *  explicit `\n`. A single word wider than the box is emitted alone (it
 *  overflows horizontally — no hyphenation). Then keep only the lines whose
 *  baselines fit within `boxHeight` (each line consumes `leading`), returning
 *  the rest as a re-flowable `remainder`.
 *
 *  One run through {@link layoutRuns}, which is the only wrapping code in this
 *  module. Four callers measure and paint through it and must not disagree.
 *  @internal */
export function layoutText(
  text: string, driver: FontDriver, fontSize: number,
  boxWidth: number, boxHeight: number, leading: number,
): LayoutResult {
  const { lines, remainder } = layoutRuns([{ text, driver, fontSize }], boxWidth, boxHeight, leading);
  return { lines, remainder: remainder.map((s) => s.text).join('') };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/layout-runs.test.ts && npm run typecheck`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the byte-identity fence and the whole suite**

Run: `npx vitest run test/rich-runs-identity.test.ts && npm test`
Expected: PASS. This is the step the whole task exists to survive — the engine
under every existing caller has just been replaced.

If a hash moved, do not re-record it. Find the difference: the likely causes are
the empty-paragraph case, the separator handling in the remainder, or summing
segment widths where the old code measured a whole string.

- [ ] **Step 6: Prove the word-boundary invariant is load-bearing**

In `layoutRuns`, temporarily make the word scan stop at run boundaries: change
`while (j < paraEnd && text[j] !== ' ') j++;` to
`while (j < paraEnd && text[j] !== ' ' && owner[j] === owner[i]) j++;`
and re-run `npx vitest run test/layout-runs.test.ts`.
Expected: "does not break between runs inside one word" FAILS. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/layout.ts test/layout-runs.test.ts
git commit -m "feat(text): layoutRuns, the one wrapping engine (gl6o.3.1)"
```

---

### Task 4: Resolve runs in stamp.ts, and measure them

Resolution and validation only — no drawing yet, so the whole task is testable
through `measureTextBlock`.

**Files:**
- Modify: `src/stamp.ts`
- Modify: `test/rich-runs.test.ts`

**Interfaces:**
- Consumes: `TextRun`, `isTextRunList` (Task 2); `LayoutRun`, `layoutRuns` (Task 3).
- Produces:
  ```ts
  interface ResolvedRun { layout: LayoutRun; font: AuthoringFont; color: [number, number, number]; decor: ResolvedDecor | undefined }
  function resolveRuns(runs: TextRun[], o: NormalizedBlockOptions): ResolvedRun[]
  export function measureTextBlock(text: string, width, availHeight, options?): { usedHeight: number; remainder: string | null };
  export function measureTextBlock(runs: TextRun[], width, availHeight, options?): { usedHeight: number; remainder: TextRun[] | null };
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/rich-runs.test.ts`:

```ts
import { measureTextBlock } from '../src/stamp.js';
import { Document } from '../src/document.js';
import { buildUnicodeTtf } from './helpers/build-embed-fonts.js';

describe('measureTextBlock with runs', () => {
  it('agrees with the string form for a single run', () => {
    const a = measureTextBlock('one two three four', 60, 100, { fontSize: 10 });
    const b = measureTextBlock([{ text: 'one two three four' }], 60, 100, { fontSize: 10 });
    expect(b.usedHeight).toBe(a.usedHeight);
  });

  it('returns a run-list remainder, preserving each run style', () => {
    const r = measureTextBlock(
      [{ text: 'alpha beta ' }, { text: 'gamma delta', font: 'Helvetica-Bold' }],
      40, 12, { fontSize: 10 },
    );
    expect(Array.isArray(r.remainder)).toBe(true);
    const rest = r.remainder as { text: string; font?: string }[];
    expect(rest.some((x) => x.font === 'Helvetica-Bold')).toBe(true);
  });

  it('a larger run makes the block taller', () => {
    const small = measureTextBlock([{ text: 'aaaa bbbb cccc' }], 40, 500, { fontSize: 10 });
    const big = measureTextBlock(
      [{ text: 'aaaa ' }, { text: 'bbbb cccc', fontSize: 30 }], 40, 500, { fontSize: 10 });
    expect(big.usedHeight).toBeGreaterThan(small.usedHeight);
  });

  it('validates every run before doing anything', () => {
    expect(() => measureTextBlock([{ text: 'a' }, { text: 'b', fontSize: -1 }], 100, 100))
      .toThrow(/fontSize/);
    expect(() => measureTextBlock([{ text: 'a', color: [2, 0, 0] }], 100, 100))
      .toThrow(/color/);
    expect(() => measureTextBlock([{ text: 'a', underline: { thickness: -1 } }], 100, 100))
      .toThrow(/thickness/);
  });

  it('rejects shaping with runs rather than silently ignoring it', () => {
    const doc = Document.New();
    const font = doc.AddFont(buildUnicodeTtf());
    expect(() => measureTextBlock([{ text: 'a' }], 100, 100, { font, shape: true }))
      .toThrow(/shap/i);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/rich-runs.test.ts`
Expected: FAIL — `measureTextBlock` does not accept an array.

- [ ] **Step 3: Add resolution and the measure overload**

In `src/stamp.ts`, add after `normalizeBlockOptions`:

```ts
/** One run with every inherited property filled in and its driver built. */
interface ResolvedRun {
  layout: LayoutRun;
  font: AuthoringFont;
  color: [number, number, number];
  decor: ResolvedDecor | undefined;
}

/** Resolve a run list against the block's options.
 *
 *  Validation runs over EVERY run before any byte is emitted, so a bad run late
 *  in the list leaves the document untouched — the rule every authoring entry
 *  point in this codebase follows.
 *
 *  A run inherits any property it does not state, so the common case
 *  (`{ text }` with one bold run among them) restates nothing. */
function resolveRuns(runs: TextRun[], o: NormalizedBlockOptions): ResolvedRun[] {
  const out: ResolvedRun[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (typeof r?.text !== 'string') throw new TypeError(`run ${i}: text must be a string`);
    const font = r.font ?? o.font;
    validateFont(font);
    const fontSize = r.fontSize ?? o.fontSize;
    if (!Number.isFinite(fontSize) || fontSize <= 0)
      throw new TypeError(`run ${i}: fontSize must be a positive finite number`);
    const color = r.color ?? o.color;
    if (!Array.isArray(color) || color.length !== 3 ||
        !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
      throw new TypeError(`run ${i}: color must be [r, g, b] with each component in 0..1`);
    // A run that states no decoration of its own inherits the block's, which is
    // what keeps a block-level underline spanning the whole line.
    const own = r.underline !== undefined || r.strikethrough !== undefined
      || r.background !== undefined;
    const decor = own
      ? resolveDecor(r, color, fontSize, vmetricsFor(font))
      : o.decor;
    out.push({ layout: { text: r.text, driver: driverFor(font), fontSize }, font, color, decor });
  }
  return out;
}

/** Justification rides on `Tw`, which moves only single-byte code 32 and is inert
 *  for 2-byte Identity-H text. One embedded run is enough to make the whole block
 *  fall back to left, exactly as one embedded font does for the string path. */
function justifiable(runs: ResolvedRun[]): boolean {
  return runs.every((r) => !(r.font instanceof EmbeddedFont));
}

/** Runs plus shaping is not implemented: BiDi reorders across a whole paragraph,
 *  and how a bidi-run boundary should interact with a style boundary is an open
 *  question. Throwing beats silently dropping either the styles or the shaping. */
function rejectShapedRuns(o: TextBlockOptions, font: AuthoringFont): void {
  if (effectiveShape(font, o.shape))
    throw new UnsupportedFeatureError('complex-text shaping is not supported with a run list');
}
```

Imports this needs in `src/stamp.ts`: `UnsupportedFeatureError` from
`./errors.js`; `TextRun` (type) and `isTextRunList` from `./textdecor.js`;
`layoutRuns`, and the types `LayoutRun` and `RunSlice`, from `./layout.js`
(alongside the existing `layoutText`, `LaidLine`, `FontDriver`, `winAnsiDriver`);
and `LineBox` (type) from `./textdecor.js` for Task 5's `runDecorOps`.

Replace `measureTextBlock` with an overloaded pair:

```ts
export function measureTextBlock(
  text: string, width: number, availHeight: number, options?: TextBlockOptions,
): { usedHeight: number; remainder: string | null };
export function measureTextBlock(
  runs: TextRun[], width: number, availHeight: number, options?: TextBlockOptions,
): { usedHeight: number; remainder: TextRun[] | null };
export function measureTextBlock(
  content: string | TextRun[], width: number, availHeight: number, options: TextBlockOptions = {},
): { usedHeight: number; remainder: string | TextRun[] | null } {
  const o = normalizeBlockOptions(options);
  if (isTextRunList(content)) {
    rejectShapedRuns(options, o.font);
    const resolved = resolveRuns(content, o);
    if (resolved.every((r) => r.layout.driver.probe(r.layout.text) === 0))
      return { usedHeight: 0, remainder: null };
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), width, availHeight, o.leading);
    return {
      usedHeight: lines.length * o.leading,
      remainder: remainder.length === 0 ? null : sliceRuns(remainder, content),
    };
  }
  let driver: FontDriver;
  if (effectiveShape(o.font, options.shape)) driver = shapedDriver(o.font, shapeOptsFrom(options));
  else driver = driverFor(o.font);
  if (driver.probe(content) === 0) return { usedHeight: 0, remainder: null };
  const { lines, remainder } = layoutText(content, driver, o.fontSize, width, availHeight, o.leading);
  return { usedHeight: lines.length * o.leading, remainder: remainder === '' ? null : remainder };
}

/** Rebuild a run list from the layout's slices, carrying each source run's style.
 *  Adjacent slices from the same run merge, so a remainder re-flows into the same
 *  number of runs it started with rather than one per line. */
function sliceRuns(slices: RunSlice[], source: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  let lastRun = -1;
  for (const s of slices) {
    if (s.run === lastRun) { out[out.length - 1].text += s.text; continue; }
    out.push({ ...source[s.run], text: s.text });
    lastRun = s.run;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/rich-runs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the fence and the suite**

Run: `npx vitest run test/rich-runs-identity.test.ts && npm test`
Expected: PASS — the string path through `measureTextBlock` is untouched.

- [ ] **Step 6: Commit**

```bash
git add src/stamp.ts test/rich-runs.test.ts
git commit -m "feat(text): resolve and measure rich runs (gl6o.3.1)"
```

---

### Task 5: Per-run emission

**Files:**
- Modify: `src/stamp.ts`
- Modify: `test/rich-runs.test.ts`

**Interfaces:**
- Consumes: `ResolvedRun`, `resolveRuns`, `justifiable`, `rejectShapedRuns`, `sliceRuns` (Task 4).
- Produces:
  ```ts
  export function flowTextBlock(doc, page, text: string,     rect, options?): { remainder: string | null;     usedHeight: number };
  export function flowTextBlock(doc, page, runs: TextRun[],  rect, options?): { remainder: TextRun[] | null;  usedHeight: number };
  export function stampTextBlock(doc, page, text: string,    rect, options?): string | null;
  export function stampTextBlock(doc, page, runs: TextRun[], rect, options?): TextRun[] | null;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/rich-runs.test.ts`:

These call `stampTextBlock` directly rather than `page.AddTextBlock`, which
Task 6 is what widens — so this task stays green on its own. Task 6 adds its own
tests through the page method.

```ts
import { PageFormat } from '../src/pageformat.js';
import { stampTextBlock } from '../src/stamp.js';
import type { TextRun } from '../src/textdecor.js';

const body = (page: import('../src/page.js').Page): string =>
  new TextDecoder('latin1').decode(page.Contents);

/** Draw a run list onto a fresh page and hand the page back. */
function drawRuns(
  runs: TextRun[], rect: [number, number, number, number],
  options: import('../src/stamp.js').TextBlockOptions = {},
  withFont?: (d: Document) => TextRun[],
) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const list = withFont ? withFont(doc) : runs;
  const rest = stampTextBlock(doc, page, list, rect, options);
  return { page, rest };
}

describe('rich run emission', () => {
  it('switches Tf between runs of different fonts', () => {
    const { page } = drawRuns(
      [{ text: 'plain ' }, { text: 'bold', font: 'Helvetica-Bold' }], [50, 500, 300, 100]);
    const c = body(page);
    // Two distinct font resources, both selected inside one text object.
    expect(c.match(/\/[A-Za-z0-9]+ 12 Tf/g)?.length).toBeGreaterThanOrEqual(2);
    expect(c.match(/BT/g)?.length).toBe(1);
  });

  it('switches rg between runs of different colours', () => {
    const { page } = drawRuns(
      [{ text: 'black ' }, { text: 'red', color: [1, 0, 0] }], [50, 500, 300, 100]);
    expect(body(page)).toContain('1 0 0 rg');
  });

  it('mixes a Standard-14 face with an embedded one on one line', () => {
    const { page } = drawRuns([], [50, 500, 300, 100], {},
      (d) => [{ text: 'std ' }, { text: 'emb', font: d.AddFont(buildUnicodeTtf()) }]);
    const c = body(page);
    expect(c.match(/Tf/g)?.length).toBeGreaterThanOrEqual(2);
    expect(c).toContain('Tj');
  });

  it('drops justify to left when any run is embedded', () => {
    const { page } = drawRuns([], [50, 500, 60, 100], { align: 'justify' },
      (d) => [{ text: 'aaa bbb ccc ddd eee fff ggg hhh ' },
              { text: 'x', font: d.AddFont(buildUnicodeTtf()) }]);
    expect(body(page)).not.toContain('Tw');
  });

  it('underlines only the run that asked for it', () => {
    const { page } = drawRuns(
      [{ text: 'plain ' }, { text: 'linked', underline: true }], [50, 500, 300, 100]);
    const c = body(page);
    const rects = [...c.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re f/g)];
    expect(rects.length).toBe(1);
    // The rule starts after 'plain ' and is narrower than the whole line.
    expect(Number(rects[0][1])).toBeGreaterThan(50);
    expect(Number(rects[0][3])).toBeLessThan(300);
  });

  it('returns a run-list remainder that keeps its style', () => {
    const { page, rest } = drawRuns(
      [{ text: 'alpha beta ' }, { text: 'gamma delta epsilon', font: 'Helvetica-Bold' }],
      [50, 500, 50, 20]);
    expect(Array.isArray(rest)).toBe(true);
    expect((rest as TextRun[]).some((r) => r.font === 'Helvetica-Bold')).toBe(true);
    expect(body(page)).toContain('BT');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/rich-runs.test.ts`
Expected: FAIL — `stampTextBlock` does not accept an array.

- [ ] **Step 3: Write the per-run block body**

In `src/stamp.ts`, add beside `buildBlockBody`:

```ts
/** The decoration boxes for a laid block when runs carry their own decoration.
 *  Each distinct ResolvedDecor gets its own box list, so a run-level underline
 *  spans exactly that run and a block-level one still spans the line.
 *
 *  The single-decor fast path is NOT routed through here: an unstyled block must
 *  emit the same bytes it always did, and `blockLineBoxes` is what produced them. */
function runDecorOps(
  lines: LaidLine[], runs: ResolvedRun[], x: number, w: number,
  baseline0: number, o: NormalizedBlockOptions,
): { beneath: string; above: string } {
  const buckets = new Map<ResolvedDecor, LineBox[]>();
  lines.forEach((line, i) => {
    const baseline = baseline0 - i * o.leading;
    let dx = x + alignOffset(o.align, w, line.width);
    for (const seg of line.segments) {
      const d = runs[seg.run].decor;
      if (d !== undefined) {
        const list = buckets.get(d) ?? [];
        list.push({ x: dx, baseline, width: seg.width });
        buckets.set(d, list);
      }
      dx += seg.width;
    }
  });
  let beneath = '';
  let above = '';
  for (const [d, boxes] of buckets) {
    const ops = decorRects(boxes, d);
    beneath += ops.beneath;
    above += ops.above;
  }
  return { beneath, above };
}

/** Per-run block body: one text object, a `Tf` when the font or size changes and
 *  an `rg` when the colour changes, then one `Tj` per segment. No per-segment
 *  `Td` — `Tj` advances the pen by the string's own width. */
function buildRunBlockBody(
  lines: LaidLine[], runs: ResolvedRun[], fontKeys: string[],
  x: number, y: number, w: number, h: number,
  o: NormalizedBlockOptions, gsKey: string | undefined,
): Uint8Array {
  const blockHeight = lines.length * o.leading;
  const valignOffset = o.valign === 'center' ? (h - blockHeight) / 2
    : o.valign === 'bottom' ? h - blockHeight : 0;
  const baseline0 = (y + h - valignOffset) - o.fontSize;

  const dec = runDecorOps(lines, runs, x, w, baseline0, o);
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  if (dec.beneath) s += dec.beneath;
  s += 'BT\n';

  let curFont = '';
  let curSize = -1;
  let curColor = '';
  let prevOffset = 0;
  let prevTw = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tw = justifySpacing(o.align, w, line);
    if (tw !== prevTw) { s += `${num(tw)} Tw\n`; prevTw = tw; }
    const offset = alignOffset(o.align, w, line.width);
    if (i === 0) s += `${num(x + offset)} ${num(baseline0)} Td\n`;
    else s += `${num(offset - prevOffset)} ${num(-o.leading)} Td\n`;
    prevOffset = offset;
    for (const seg of line.segments) {
      const r = runs[seg.run];
      const key = fontKeys[seg.run];
      if (key !== curFont || r.layout.fontSize !== curSize) {
        s += `/${key} ${num(r.layout.fontSize)} Tf\n`;
        curFont = key;
        curSize = r.layout.fontSize;
      }
      const col = `${num(r.color[0])} ${num(r.color[1])} ${num(r.color[2])} rg`;
      if (col !== curColor) { s += `${col}\n`; curColor = col; }
      s += `${serializeString(seg.bytes)} Tj\n`;
    }
  }
  s += 'ET\n';
  if (dec.above) s += dec.above;
  s += 'Q';
  return enc(s);
}
```

- [ ] **Step 4: Overload `flowTextBlock` and `stampTextBlock`**

Add the run branch at the top of `flowTextBlock`'s body, leaving the two existing
paths below it completely untouched:

```ts
export function flowTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options?: TextBlockOptions,
): { remainder: string | null; usedHeight: number };
export function flowTextBlock(
  doc: Document, page: Page, runs: TextRun[],
  rect: [number, number, number, number], options?: TextBlockOptions,
): { remainder: TextRun[] | null; usedHeight: number };
export function flowTextBlock(
  doc: Document, page: Page, content: string | TextRun[],
  rect: [number, number, number, number], options: TextBlockOptions = {},
): { remainder: string | TextRun[] | null; usedHeight: number } {
  validateMarking(options);
  validateRect(rect);
  const o = normalizeBlockOptions(options);
  const put = o.behind ? prependContent : appendContent;
  const [x, y, w, h] = rect;

  if (isTextRunList(content)) {
    rejectShapedRuns(options, o.font);
    const resolved = resolveRuns(content, o);
    if (resolved.every((r) => r.layout.driver.probe(r.layout.text) === 0))
      return { remainder: null, usedHeight: 0 };
    // Justification falls back to left when any run is embedded, and `o` is a
    // local copy so the block's own options are not mutated.
    const ro: NormalizedBlockOptions =
      o.align === 'justify' && !justifiable(resolved) ? { ...o, align: 'left' } : o;
    const { lines, remainder } = layoutRuns(
      resolved.map((r) => r.layout), w, h, ro.leading);
    if (lines.length > 0) {
      const fontKeys = resolved.map((r) => registerFont(doc, page, r.font));
      const gsKey = ro.opacity < 1 ? registerExtGState(doc, page, ro.opacity) : undefined;
      const bodyBytes = buildRunBlockBody(lines, resolved, fontKeys, x, y, w, h, ro, gsKey);
      put(doc, page, markContent(doc, page, options, rotateBody(bodyBytes, ro.rotate, x, y)));
    }
    return {
      remainder: remainder.length === 0 ? null : sliceRuns(remainder, content),
      usedHeight: lines.length * ro.leading,
    };
  }

  // ... the two existing paths, unchanged ...
}
```

and the matching overload on `stampTextBlock`:

```ts
export function stampTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options?: TextBlockOptions,
): string | null;
export function stampTextBlock(
  doc: Document, page: Page, runs: TextRun[],
  rect: [number, number, number, number], options?: TextBlockOptions,
): TextRun[] | null;
export function stampTextBlock(
  doc: Document, page: Page, content: string | TextRun[],
  rect: [number, number, number, number], options: TextBlockOptions = {},
): string | TextRun[] | null {
  // The two arms are identical on purpose: TypeScript resolves an overloaded
  // call by picking one signature, and a `string | TextRun[]` argument matches
  // neither. Narrowing first is what lets each arm pick its own. The same
  // two-armed shape appears in page.ts and flow.ts for the same reason — it is
  // not a copy-paste slip.
  return isTextRunList(content)
    ? flowTextBlock(doc, page, content, rect, options).remainder
    : flowTextBlock(doc, page, content, rect, options).remainder;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/rich-runs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the fence and the suite**

Run: `npx vitest run test/rich-runs-identity.test.ts && npm test`
Expected: PASS — no existing caller reaches the new branch.

- [ ] **Step 7: Prove the decoration and justify assertions are load-bearing**

Temporarily make `runDecorOps` use the whole line width instead of the segment's
(`width: line.width`) and re-run `npx vitest run test/rich-runs.test.ts`:
the "underlines only the run that asked for it" test must FAIL. Revert.

Temporarily make `justifiable` return `true` always and re-run: the "drops
justify to left" test must FAIL. Revert.

- [ ] **Step 8: Commit**

```bash
git add src/stamp.ts test/rich-runs.test.ts
git commit -m "feat(text): per-run emission for rich blocks (gl6o.3.1)"
```

---

### Task 6: Flow and Page take runs

**Files:**
- Modify: `src/page.ts:470-476`
- Modify: `src/flow.ts`
- Modify: `test/rich-runs.test.ts`

**Interfaces:**
- Consumes: the `stampTextBlock`/`flowTextBlock`/`measureTextBlock` overloads (Tasks 4–5).
- Produces:
  ```ts
  Page.AddTextBlock(text: string,    rect, options?): string | null;
  Page.AddTextBlock(runs: TextRun[], rect, options?): TextRun[] | null;
  Flow.AddParagraph(content: string | TextRun[], options?): this;
  Flow.AddHeading(level: number, content: string | TextRun[], options?): this;
  // FlowListItem.text widens to string | TextRun[]
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/rich-runs.test.ts`:

```ts
describe('Flow and Page with runs', () => {
  it('AddTextBlock takes runs and returns a run remainder', () => {
    const page = pageWith((p) => {
      const rest = p.AddTextBlock(
        [{ text: 'alpha beta gamma ' }, { text: 'delta epsilon zeta', font: 'Helvetica-Bold' }],
        [50, 500, 50, 20]);
      expect(Array.isArray(rest)).toBe(true);
      expect((rest as { font?: string }[]).some((r) => r.font === 'Helvetica-Bold')).toBe(true);
    });
    expect(body(page)).toContain('BT');
  });

  it('a paragraph and a heading take runs and paginate', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHeading(1, [{ text: 'Mixed ' }, { text: 'Heading', color: [1, 0, 0] }]);
    flow.AddParagraph([
      { text: 'Body text with ' },
      { text: 'bold', font: 'Helvetica-Bold' },
      { text: ' and ' },
      { text: 'code', font: 'Courier', background: [0.95, 0.95, 0.95] },
      { text: ' inline. ' + LOREM_LONG },
    ]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const c = body(pages[0]);
    expect(c).toContain('1 0 0 rg');
    expect(c.match(/Tf/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('a list item takes runs', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddList([{ text: [{ text: 'item with ' }, { text: 'emphasis', font: 'Helvetica-Oblique' }] }]);
    const pages = flow.Render();
    expect(body(pages[0]).match(/Tf/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
```

Add near the top of the file:

```ts
const LOREM_LONG = ('Sentences repeated enough times to spill a column and force '
  + 'the remainder path to carry run styles across the break. ').repeat(20);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/rich-runs.test.ts`
Expected: FAIL — the argument types are rejected.

- [ ] **Step 3: Widen `Page.AddTextBlock`**

In `src/page.ts`, replace the single method with overloads (the doc comment stays
as it is, with one sentence added):

```ts
  /** ... existing comment ...
   *
   *  Pass a {@link TextRun} list instead of a string to mix fonts, sizes, colours
   *  and decorations within the block; the remainder comes back as runs. */
  AddTextBlock(
    text: string, rect: [number, number, number, number], options?: TextBlockOptions,
  ): string | null;
  AddTextBlock(
    runs: TextRun[], rect: [number, number, number, number], options?: TextBlockOptions,
  ): TextRun[] | null;
  AddTextBlock(
    content: string | TextRun[], rect: [number, number, number, number], options?: TextBlockOptions,
  ): string | TextRun[] | null {
    return isTextRunList(content)
      ? stampTextBlock(this.doc, this, content, rect, options ?? {})
      : stampTextBlock(this.doc, this, content, rect, options ?? {});
  }
```

Import `type TextRun` and `isTextRunList` from `./textdecor.js`.

- [ ] **Step 4: Widen the Flow elements**

In `src/flow.ts`, change `TextElement`'s `text` field type to
`string | TextRun[]`, and its two call sites so the union flows through:

```ts
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { usedHeight, remainder } = isTextRunList(this.text)
      ? measureTextBlock(this.text, ctx.width, ctx.availHeight, this.opts)
      : measureTextBlock(this.text, ctx.width, ctx.availHeight, this.opts);
    return { usedHeight, fits: remainder === null && usedHeight > 0 };
  }
```

and in `place`, the same two-armed call plus the emptiness test, which must now
cope with a run list:

```ts
    // A run list is empty when every run is, which is what decides whether this
    // element ever gets a structure node.
    const empty = isTextRunList(this.text)
      ? this.text.every((r) => r.text.length === 0)
      : this.text.length === 0;
    if (this.tag === undefined && ctx.structParent && !empty) {
      this.tag = ctx.structParent.Append(this.structType);
    }
```

with the continuation built from whichever remainder type came back:

```ts
      remainder: remainder === null ? null
        : new TextElement(remainder, this.opts, this.structType, 0, this.spaceAfter, this.tag),
```

Then widen the signatures: `AddParagraph(content: string | TextRun[], ...)`,
`AddHeading(level: number, content: string | TextRun[], ...)`,
`makeParagraph(text: string | TextRun[], ...)`, and `FlowListItem.text` to
`string | TextRun[]`. The list body element (`ListElement`) already routes through
`flowTextBlock`/`measureTextBlock`; give it the same two-armed calls.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/rich-runs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the fence and the suite**

Run: `npx vitest run test/rich-runs-identity.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/page.ts src/flow.ts test/rich-runs.test.ts
git commit -m "feat(text): Flow and Page accept run lists (gl6o.3.1)"
```

---

### Task 7: Exports, the end-to-end check, and documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `test/rich-runs.test.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `TextRun` on the public surface.

- [ ] **Step 1: Write the failing end-to-end test**

Append to `test/rich-runs.test.ts`:

```ts
describe('end to end', () => {
  // Reads the RESULT rather than the emitter that produced it: the extractor
  // resolves each fragment's font from the page resources, so this fails if a
  // run's Tf never reached the stream or pointed at the wrong resource.
  it('each fragment comes back with the font its run asked for', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'regular ' }, { text: 'bold ', font: 'Helvetica-Bold' },
       { text: 'mono', font: 'Courier' }],
      [50, 700, 400, 60]);
    const reopened = Document.Open(doc.Save());
    const frags = reopened.Pages[0].GetTextFragments();
    const seen = frags.map((f) => f.fontName ?? '');
    expect(seen.some((n) => n.includes('Helvetica-Bold'))).toBe(true);
    expect(seen.some((n) => n.includes('Courier'))).toBe(true);
    expect(frags.map((f) => f.text).join('')).toContain('bold');
  });
});
```

`fontName` is `TextFragment`'s `/BaseFont` name (`src/text.ts:557`). Do not
weaken this to a text-only assertion if it fails — text is what the emission
tests already cover, and the font is the whole point of reading the result back.

- [ ] **Step 2: Run it to verify it fails or passes for the right reason**

Run: `npx vitest run test/rich-runs.test.ts -t "font its run asked for"`
Expected: PASS if Tasks 5–6 are correct. If it fails, the emitter is registering
one font resource for the whole block — fix that rather than the test.

- [ ] **Step 3: Export `TextRun`**

In `src/index.ts`, beside the existing text-authoring exports:

```ts
export type { TextRun } from './textdecor.js';
```

- [ ] **Step 4: Update `README.md`**

In the API overview's text section, after `AddTextBlock`:

```markdown
`AddTextBlock` also takes a **run list** instead of a string, to mix styles
within one wrapped block:

```ts
page.AddTextBlock([
  { text: 'Regular, ' },
  { text: 'bold', font: 'Helvetica-Bold' },
  { text: ', and ' },
  { text: 'code', font: 'Courier', background: [0.95, 0.95, 0.95] },
], [50, 700, 400, 60]);
```

A run may override `font`, `fontSize`, `color`, `underline`, `strikethrough` and
`background`; anything it leaves unset comes from the block. `align`, `valign`,
`leading`, `rotate` and `opacity` describe the whole block and stay there. The
overflow remainder comes back as runs, so it continues into another box or
column with its styles intact. `Flow.AddParagraph`, `Flow.AddHeading` and a list
item's `text` take the same run list.

Two limits: `align: 'justify'` falls back to left if any run uses an embedded
font (justification rides on `Tw`, which only moves single-byte spaces), and
complex-text shaping (`shape: true`) is not supported with runs.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Extend the `layout.ts` mention in the content-authoring bullet, and add:

```markdown
  **Invariant:** there is ONE wrapping engine, `layoutRuns` in layout.ts.
  `layoutText` is a one-run wrapper over it. floatbox.ts and tableauthor.ts
  *measure* through it while stamp.ts *paints* through it, so a second wrapper
  lets a box measure one way and paint another.
  **Invariant:** a rich block's break opportunities are found on the
  CONCATENATED run text, never per run. `**bold**text` is one word and must not
  break at the style boundary. Widths are summed per segment, which agrees
  exactly with measuring the whole string for the WinAnsi and Identity-H drivers
  (a string's width is the sum of its glyph advances) — and is what lets the
  single-run path stay byte-identical. It would not hold for a shaping driver,
  which is one more reason shaping stays single-run and throws with a run list.
  **Invariant:** `TextRun` lives in textdecor.ts, not layout.ts. It names an
  `AuthoringFont`, which stamp.ts defines, and stamp.ts imports layout.ts — the
  reverse inverts that dependency. layout.ts works over resolved runs carrying a
  `FontDriver` and never learns what a font object is.
  **Invariant:** a run inherits every property it does not state from the block,
  and an unstyled block still emits through `blockLineBoxes`, not the per-run
  decoration path. That fast path is what keeps output byte-identical for every
  caller that never asks for runs — asserted directly by
  `test/rich-runs-identity.test.ts`, which hashes emitted page bytes for eight
  existing call sites.
  **Note:** leading stays block-level, so a run whose `fontSize` exceeds the
  block's can collide with the line above. `usedHeight = lines * leading` is
  baked into flow pagination, measurement and decoration geometry; variable
  per-line leading is a change to the height model, not a detail of this one.
```

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/rich-runs.test.ts README.md CLAUDE.md
git commit -m "feat(text): export TextRun and document rich runs (gl6o.3.1)"
```

- [ ] **Step 8: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-gl6o.3.1
git pull --rebase
git push -u origin feat/rich-text-runs-gl6o.3.1
git status
```
