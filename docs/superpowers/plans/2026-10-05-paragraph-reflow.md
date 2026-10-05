# Paragraph Reflow After Replace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ReplaceText(find, replacement, { adjust: 'reflow' })` re-wraps every paragraph a match touches by repositioning the existing glyph bytes, growing only into free space, and refuses (or reports through `onUnreflowable`) rather than overprint.

**Architecture:** Three units. `reflowpara.ts` (pure) finds the paragraph around an edit — its member glyphs, words, lines, gaps, pitch and alignment — or a refusal reason. `reflowwrap.ts` (pure) wraps its words through `layoutRuns` as atomic boxes and returns a target origin for every member glyph. `textedit.ts` turns targets into `Tm` and `TJ`-kern insertions through the existing split path, restores the line matrix for content after the paragraph, moves link and text-markup quads, and checks free space below.

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-paragraph-reflow-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`).
- `adjust` other than `'reflow'` must leave output byte-identical to before this plan (`test/replace-adjust.test.ts`, `test/replace-options.test.ts`, `test/text-replace.test.ts` are the fences).
- A refused call changes nothing: everything is decided while PLANNING; `apply` only writes.
- `onUnreflowable` given with `adjust` other than `'reflow'` is a `TypeError`.
- Run `npm run typecheck` and `npm test` green before closing; target one file with `npx vitest run test/<name>.test.ts`.
- New public names need a README API Reference row and the README's stated type count updated (`test/readme-api.test.ts` enforces both).
- New `src/*.ts` modules get a CLAUDE.md Source entry in the same commit.
- Write code containing backslashes with the Write/Edit tools, never a bash heredoc (heredocs strip backslashes on this machine).

## Review Focus

1. **A second paragraph in the SAME text object positioned by `Td`** must not move after the first is reflowed — the inserted `Tm`s change the line matrix it is relative to. Pinned in Task 5 ("leaves the next paragraph in the text object where it was").
2. **A replacement that REMOVES a line** — the paragraph's later lines move UP by the pitch and nothing below the paragraph moves. Pinned in Task 5 ("a shorter replacement pulls later lines up").
3. **A justified paragraph whose last line holds ONE word** has no unjustified gap to measure — the natural gap must fall back to the smallest gap. Pinned in Task 3 ("justified with a one-word last line").
4. **A replacement wider than the box** (a long unbreakable unit) must land alone on a line, overflowing, without throwing or hanging. Pinned in Task 4 ("an over-wide word sits alone").
5. **One match per paragraph in two paragraphs, one of them refused** — with `onUnreflowable` the refused one is reported and replaced without reflow while the other is reflowed. Pinned in Task 5 ("reports one paragraph and reflows the other").

---

## File Structure

- Create `src/reflowpara.ts` — paragraph finding and refusal reasons. Pure.
- Create `src/reflowwrap.ts` — wrapping to target origins. Pure.
- Modify `src/text.ts` — `GlyphEvent.tm/tlm/ctm`; `groupLineBlocks` extracted from `extractStructured`.
- Modify `src/replacefont.ts` — `'reflow'`, `onUnreflowable`, `UnreflowableText`, `UnreflowableReason`, validation.
- Modify `src/replaceadjust.ts` — `ShowInsert` replaces `KernInsert`; `ChainGap` replaces the boolean `breaks`.
- Modify `src/showsplit.ts` — an `op` piece.
- Modify `src/textedit.ts` — `pageLayout` (internal, exported for tests), `chainGapFor`, after-op inserts, the reflow writer, annotations.
- Modify `src/index.ts`, `README.md`, `CHANGELOG.md`, `CLAUDE.md`.
- Tests: `test/reflow-foundation.test.ts`, `test/reflow-para.test.ts`, `test/reflow-wrap.test.ts`, `test/reflow.test.ts`, `test/reflow-annots.test.ts`, `test/reflow-tagged.test.ts`.

---

### Task 1: Foundations — matrices on glyphs, insert pieces, chain gaps, the option

**Files:**
- Modify: `src/text.ts` (GlyphEvent, emitGlyphs)
- Modify: `test/docx-group.test.ts` (synthetic glyph helper)
- Modify: `src/replaceadjust.ts`, `src/showsplit.ts`, `src/textedit.ts`, `src/replacefont.ts`, `src/index.ts`
- Test: `test/reflow-foundation.test.ts`

**Interfaces:**
- Produces:
  - `GlyphEvent.tm: Matrix`, `.tlm: Matrix`, `.ctm: Matrix` (text.ts) — the text matrix at the glyph's START, the line matrix, the CTM.
  - `ShowPiece` gains `{ kind: 'op'; op: ContentOp }` (showsplit.ts).
  - `ShowInsert { addr: ContentAddr; elementIndex: number; byteStart: number; piece: { kind: 'kern'; value: number } | { kind: 'op'; op: ContentOp } }` (replaceadjust.ts), replacing `KernInsert`.
  - `type ChainGap = 'none' | 'relative' | 'absolute'` (replaceadjust.ts); `planAdjustment(mode, glyphs, edits, layout, gap: (a, b) => ChainGap)`.
  - `StreamEdits.after: Map<number, ContentOp[]>` (textedit.ts) — operators written AFTER an operator.
  - `chainGapFor(doc, page): (a: ContentAddr, b: ContentAddr) => ChainGap` (textedit.ts, not exported).
  - `ReplaceAdjust` gains `'reflow'`; `ReplaceTextOptions.onUnreflowable?: (r: UnreflowableText) => void`; `interface UnreflowableText { page: number; match: string; reason: UnreflowableReason }`; `type UnreflowableReason = 'vertical' | 'rotated' | 'scopes' | 'interleaved' | 'foreign-ink' | 'annotation' | 'pitch' | 'no-room' | 'not-found'` (replacefont.ts, all exported from index.ts).

- [ ] **Step 1: Write the failing tests**

Create `test/reflow-foundation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, apply, mul, type GlyphEvent } from '../src/text.js';
import { splitShowOp } from '../src/showsplit.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};

describe('GlyphEvent matrices (u3l5.5)', () => {
  it('carries the start text matrix, the line matrix and the CTM', () => {
    const doc = Document.Open(buildSimpleTextPdf('2 0 0 2 0 0 cm BT /F1 12 Tf 10 100 Td (ab) Tj ET'));
    const [a, b] = glyphs(doc);
    expect(a.ctm).toEqual([2, 0, 0, 2, 0, 0]);
    expect(a.tlm).toEqual([1, 0, 0, 1, 10, 100]);
    expect(a.tm).toEqual([1, 0, 0, 1, 10, 100]);
    // b starts where a's advance ended; its origin through tm x ctm is its quad.
    expect(b.tm[4]).toBeCloseTo(10 + 556 * 12 / 1000, 6);
    const [x, y] = apply(mul(b.tm, b.ctm), 0, 0);
    expect(x).toBeCloseTo(b.quad[0], 6);
    expect(y).toBeCloseTo(b.quad[1], 6);
  });
});

describe('splitShowOp op pieces (u3l5.5)', () => {
  const str = (s: string) => ({ kind: 'string' as const, bytes: new TextEncoder().encode(s) });
  const tm = { operator: 'Tm', operands: [1, 0, 0, 1, 50, 60] };
  it('writes an operator between two halves of a Tj', () => {
    const out = splitShowOp({ operator: 'Tj', operands: [str('ab')] },
      [{ kind: 'bytes', bytes: new TextEncoder().encode('a') }, { kind: 'op', op: tm },
        { kind: 'bytes', bytes: new TextEncoder().encode('b') }], { key: '', size: 0 });
    expect(out.map((o) => o.operator)).toEqual(['Tj', 'Tm', 'Tj']);
  });
  it("keeps a ' line move ahead of an operator at its start", () => {
    const out = splitShowOp({ operator: "'", operands: [str('ab')] },
      [{ kind: 'op', op: tm }, { kind: 'bytes', bytes: new TextEncoder().encode('ab') }], { key: '', size: 0 });
    expect(out.map((o) => o.operator)).toEqual(["'", 'Tm', 'Tj']);
  });
});

describe("adjust: 'reflow' validation (u3l5.5)", () => {
  const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (aXb) Tj ET'));
  it('accepts reflow and refuses onUnreflowable without it', () => {
    expect(() => doc.Pages[0].ReplaceText('Q', 'Y', { adjust: 'reflow' })).not.toThrow();
    expect(() => doc.Pages[0].ReplaceText('Q', 'Y', { onUnreflowable: () => {} })).toThrow(TypeError);
    expect(() => doc.Pages[0].ReplaceText('Q', 'Y', { adjust: 'reflow', onUnreflowable: 1 as never })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/reflow-foundation.test.ts`
Expected: FAIL — `a.ctm` is undefined; `op` pieces are dropped; `'reflow'` throws `RangeError`.

- [ ] **Step 3: Add the matrices to `GlyphEvent`**

In `src/text.ts`, after the `hscale: number;` field added by u3l5.4, add:

```ts
  /** The text matrix at this glyph's START, the line matrix and the CTM in
   *  force (u3l5.5). REQUIRED: an edit that moves a glyph writes a `Tm` with
   *  this glyph's own scale and a solved translation, and restores the line
   *  matrix after a paragraph, so it must never guess them. The glyph's
   *  origin is `apply(mul(tm, ctm), 0, rise)`, which is `quad`'s corner. */
  tm: Matrix;
  tlm: Matrix;
  ctm: Matrix;
```

In `emitGlyphs`, in the object passed to `ctx.visitor.glyph`, after `charSpacing: st.charSp, wordSpacing: st.wordSp, hscale: st.hscale,` add:

```ts
      tm: startTm, tlm: st.tlm, ctm,
```

In `test/docx-group.test.ts`, extend the synthetic glyph: replace
`tfKey: 'F1', tfSize: size, charSpacing: 0, wordSpacing: 0, hscale: 1,` with
`tfKey: 'F1', tfSize: size, charSpacing: 0, wordSpacing: 0, hscale: 1, tm: [1, 0, 0, 1, x, baseline], tlm: [1, 0, 0, 1, x, baseline], ctm: [1, 0, 0, 1, 0, 0],`.

- [ ] **Step 4: Add the `op` piece to `splitShowOp`**

In `src/showsplit.ts`, extend `ShowPiece`:

```ts
  | { kind: 'op'; op: ContentOp }
```

In `splitShowOp`'s loop, before `if (p.kind === 'foreign') {`, add:

```ts
    if (p.kind === 'op') { flush(); out.push(p.op); continue; }
```

(`flush` already keeps a `'`/`"` operator as the first piece even when its string is empty, which is what puts the line move ahead of the `Tm`.)

- [ ] **Step 5: Generalise inserts and chain gaps in `replaceadjust.ts`**

Replace the `KernInsert` interface with:

```ts
/** A piece to write before the glyph at `byteStart` of `elementIndex`: a TJ
 *  kern (u3l5.4) or an operator such as a `Tm` (u3l5.5). */
export interface ShowInsert {
  addr: ContentAddr; elementIndex: number; byteStart: number;
  piece: { kind: 'kern'; value: number } | { kind: 'op'; op: ContentOp };
}

/** What lies between two glyphs of one scope in content order: nothing that
 *  moves the pen (`'none'`, they are CHAINED), only operators positioning
 *  relative to the line matrix (`'relative'`: `Td TD T* ' "`), or at least one
 *  that sets it outright (`'absolute'`: `BT ET Tm`, or going backwards). */
export type ChainGap = 'none' | 'relative' | 'absolute';
```

Add `import type { ContentOp } from './content.js';`. In `planAdjustment`, rename the parameter `breaks: (a, b) => boolean` to `gap: (a: ContentAddr, b: ContentAddr) => ChainGap`, change `breaks(st.last.addr, g.addr)` to `gap(st.last.addr, g.addr) !== 'none'`, change the return type and `out` to `ShowInsert[]`, and push:

```ts
    out.push({ addr: g.addr, elementIndex: el, byteStart: byte, piece: { kind: 'kern', value: Math.round(-c * 1000 / per * 1000) / 1000 } });
```

- [ ] **Step 6: Wire `textedit.ts` to the new shapes**

1. Import `type ShowInsert, type ChainGap` instead of `type KernInsert`.
2. `StreamEdits`: `inserts: Map<number, ShowInsert[]>;` and add `after: Map<number, ContentOp[]>;` initialised as `new Map()` in `streamFor`.
3. Replace `planLineAdjust`'s local `breaks` with a module function:

```ts
const ABSOLUTE = new Set(['BT', 'ET', 'Tm']);

/** The `ChainGap` between two glyphs of one scope, from the scope's ops read
 *  ONCE and cached. Going backwards — a form drawn a second time — is
 *  `'absolute'`: its chain starts again. */
function chainGapFor(doc: Document, page: Page): (a: ContentAddr, b: ContentAddr) => ChainGap {
  const cache = new Map<string, ContentOp[][]>();
  const opsOf = (path: readonly string[]): ContentOp[][] => {
    const key = path.join('\0');
    let ops = cache.get(key);
    if (!ops) { ops = readScopeOps(doc, page, path); cache.set(key, ops); }
    return ops;
  };
  return (a, b) => {
    if (a.path.join('\0') !== b.path.join('\0')) return 'absolute';
    if (b.streamIndex < a.streamIndex || (b.streamIndex === a.streamIndex && b.opIndex < a.opIndex)) return 'absolute';
    if (b.streamIndex === a.streamIndex && b.opIndex === a.opIndex) return 'none';
    const ops = opsOf(a.path);
    let found: ChainGap = 'none';
    for (let si = a.streamIndex; si <= b.streamIndex; si++) {
      const list = ops[si];
      if (!list) return 'absolute';
      const from = si === a.streamIndex ? a.opIndex + 1 : 0;
      const to = si === b.streamIndex ? b.opIndex : list.length - 1;
      for (let i = from; i <= to; i++) {
        if (ABSOLUTE.has(list[i].operator)) return 'absolute';
        if (PEN_RESET.has(list[i].operator)) found = 'relative';
      }
    }
    return found;
  };
}
```

   `planLineAdjust` takes `gap` (built once per plan with `chainGapFor(doc, page)`) instead of building `breaks`, and passes it to `planAdjustment`. Its dropped-kern lookup keeps reading ops through `readScopeOps`.
4. `showPieces(op, edits, kerns, keyFor, inserts: readonly ShowInsert[] = [])`: in `kernsUpTo`, replace the two kern pushes with

```ts
        pieces.push({ kind: 'bytes', bytes: el.bytes.subarray(pos, kernsHere[ki].byteStart) });
        pieces.push(kernsHere[ki].piece);
```

5. `applyEdits`: destructure `after`; after each op's output is pushed (in all three branches: unchanged, split, spliced), push `...(after.get(i) ?? [])`. Rewrite the loop body as:

```ts
    ops.forEach((op, i) => {
      const e = perOp.get(i) ?? [], k = kerns.get(i) ?? [], ins = inserts.get(i) ?? [];
      if (e.length === 0 && k.length === 0 && ins.length === 0) out.push(op);
      else if (ins.length > 0 || e.some(hasForeign)) {
        out.push(...splitShowOp(op, showPieces(op, e, k, keyFor, ins), restore.get(i) ?? NO_RESTORE));
      } else {
        const next = spliceShowOp(op, e, k);
        if (!emptiedTj(op, next)) out.push(next);
      }
      out.push(...(after.get(i) ?? []));
    });
```


- [ ] **Step 7: The option, its types and validation**

In `src/replacefont.ts`:

```ts
export type ReplaceAdjust = 'none' | 'shiftRest' | 'spaceWidth' | 'reflow';
const ADJUSTS: readonly ReplaceAdjust[] = ['none', 'shiftRest', 'spaceWidth', 'reflow'];

/** Why a paragraph could not be reflowed (u3l5.5). */
export type UnreflowableReason =
  | 'vertical' | 'rotated' | 'scopes' | 'interleaved' | 'foreign-ink'
  | 'annotation' | 'pitch' | 'no-room' | 'not-found';

/** A paragraph `adjust: 'reflow'` declined; its matches were replaced
 *  without reflow. */
export interface UnreflowableText {
  /** 1-based page number. */
  page: number;
  /** The first match in the paragraph. */
  match: string;
  reason: UnreflowableReason;
}
```

Extend the `adjust` doc comment with: `` `'reflow'` re-wraps every paragraph a match touches by moving its existing glyphs between lines, growing only into free space below it; a paragraph that cannot be reflowed safely throws `UnsupportedFeatureError`, or with `onUnreflowable` is replaced without reflow and reported. `` and add to `ReplaceTextOptions`:

```ts
  /** With `adjust: 'reflow'`, called once per paragraph that cannot be
   *  reflowed; its matches are then replaced without reflow. Without it such
   *  a call throws `UnsupportedFeatureError` and changes nothing. */
  onUnreflowable?: (r: UnreflowableText) => void;
```

In `checkReplaceOptions`, after the `adjust` check:

```ts
  if (o.onUnreflowable !== undefined) {
    if (typeof o.onUnreflowable !== 'function') throw new TypeError('ReplaceText: onUnreflowable must be a function');
    if (o.adjust !== 'reflow') throw new TypeError("ReplaceText: onUnreflowable applies only with adjust: 'reflow'");
  }
```

In `textedit.ts`, `planReplace`'s adjustment branch must not hand `'reflow'` to `planLineAdjust`. Change the guard to

```ts
  if (opts.adjust === 'shiftRest' || opts.adjust === 'spaceWidth') {
```

(Task 5 adds the `'reflow'` branch.)

In `src/index.ts`: `export type { ReplaceTextOptions, ReplaceAdjust, UndrawableText, UnreflowableText, UnreflowableReason } from './replacefont.js';`

In `README.md`: update the `ReplaceAdjust` row to list `'reflow'`; add rows (alphabetical within the types run that holds `ReplaceTextOptions`):

```
| `UnreflowableReason` | Why `ReplaceText({ adjust: 'reflow' })` declined a paragraph: `'vertical'`, `'rotated'`, `'scopes'`, `'interleaved'`, `'foreign-ink'`, `'annotation'`, `'pitch'`, `'no-room'` or `'not-found'`. |
| `UnreflowableText` | A paragraph reflow declined: `page` (1-based), the first `match`, and the `reason`. |
```

and add `onUnreflowable` to the `ReplaceTextOptions` row. Then run `npx vitest run test/readme-api.test.ts` and set the README's stated type count to the number it reports.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run test/reflow-foundation.test.ts test/replace-adjust.test.ts test/replace-options.test.ts test/text-replace.test.ts test/showsplit.test.ts test/docx-group.test.ts test/readme-api.test.ts && npm run typecheck`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/text.ts src/showsplit.ts src/replaceadjust.ts src/textedit.ts src/replacefont.ts src/index.ts README.md test/docx-group.test.ts test/reflow-foundation.test.ts
git commit -m "feat(u3l5.5): glyph matrices, op inserts, chain gaps, the reflow option"
```

---

### Task 2: One block grouping for extraction and reflow

**Files:**
- Modify: `src/text.ts` (`extractStructured`)
- Test: `test/reflow-foundation.test.ts`

**Interfaces:**
- Produces: `groupLineBlocks(lines: readonly { quad: [number, number, number, number] }[]): number[]` (text.ts, exported) — for each line, in order, the index of the block it belongs to (0, 0, 1, 1, 1, …).

- [ ] **Step 1: Write the failing test**

Append to `test/reflow-foundation.test.ts`:

```ts
import { groupLineBlocks } from '../src/text.js';

describe('groupLineBlocks (u3l5.5)', () => {
  it("splits on extractStructured's gap and indent rules", () => {
    const q = (x: number, y: number): { quad: [number, number, number, number] } => ({ quad: [x, y, x + 100, y + 12] });
    // 14pt pitch keeps a block; a 40pt drop or a 40pt indent starts one.
    expect(groupLineBlocks([q(20, 200), q(20, 186), q(20, 146), q(60, 132)])).toEqual([0, 0, 1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/reflow-foundation.test.ts -t groupLineBlocks`
Expected: FAIL — `groupLineBlocks` is not exported.

- [ ] **Step 3: Extract it**

In `src/text.ts`, add above `extractStructured`:

```ts
/** For each line, top to bottom, the index of the paragraph-like block it
 *  belongs to: a new block starts at a baseline drop over 1.6 line heights or
 *  a left-edge shift over 2. The ONE rule `extractStructured` and
 *  `ReplaceText({ adjust: 'reflow' })` share, so the two cannot disagree about
 *  what a paragraph is. */
export function groupLineBlocks(lines: readonly { quad: [number, number, number, number] }[]): number[] {
  const out: number[] = [];
  let block = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      const prev = lines[i - 1].quad, line = lines[i].quad;
      const size = Math.max(prev[3] - prev[1], line[3] - line[1]) || 1;
      const gap = prev[1] - line[1];
      const indent = Math.abs(line[0] - prev[0]);
      if (gap > 1.6 * size || indent > 2 * size) block++;
    }
    out.push(block);
  }
  return out;
}
```

Replace the block-grouping loop at the end of `extractStructured` with:

```ts
  const blockOf = groupLineBlocks(lines);
  const blocks: TextBlock[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j < lines.length && blockOf[j] === blockOf[i]) j++;
    const group = lines.slice(i, j);
    blocks.push({ text: group.map((l) => l.text).join('\n'), quad: bbox(group.map((l) => l.quad)), lines: group });
    i = j;
  }
  return blocks;
```

- [ ] **Step 4: Run the test and the extraction fences**

Run: `npx vitest run test/reflow-foundation.test.ts test/text-structured.test.ts test/html-identity.test.ts test/docmodel.test.ts test/markdown-export.test.ts`
Expected: PASS (if a file name does not exist, `ls test | grep -i structured` and run what does).

- [ ] **Step 5: Commit**

```bash
git add src/text.ts test/reflow-foundation.test.ts
git commit -m "refactor(u3l5.5): one block grouping for extraction and reflow"
```

---

### Task 3: Finding the paragraph (`reflowpara.ts`)

**Files:**
- Create: `src/reflowpara.ts`
- Modify: `src/textedit.ts` (export `pageLayout` for tests)
- Test: `test/reflow-para.test.ts`

**Interfaces:**
- Consumes: `GlyphEvent` (with `tm`, `ctm`), `ChainGap`, `glyphAdvance` (replaceadjust.ts), `groupLineBlocks` (text.ts).
- Produces (reflowpara.ts):

```ts
export type Rect = [number, number, number, number];
export interface ParaWord { glyphs: GlyphEvent[]; start: number; end: number; line: number }
export interface ParaLine { first: number; last: number; baseline: number; left: number; right: number }
export interface Paragraph {
  members: Set<GlyphEvent>;
  words: ParaWord[];
  lines: ParaLine[];
  gaps: number[];
  box: Rect;
  pitch: number;
  size: number;
  align: 'left' | 'right' | 'center' | 'justify';
  indent: number;
}
export interface ParaInput {
  all: readonly GlyphEvent[];
  text: string;
  refs: readonly (GlyphEvent | undefined)[];
  covered: Uint8Array;
  keyOf: (g: GlyphEvent) => unknown;
  anchor: GlyphEvent;
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap;
  inks: readonly Rect[];
  annots: readonly { subtype: string; rect: Rect }[];
}
export const MOVABLE_ANNOTS: ReadonlySet<string>;
export function untaggedKeys(text: string, refs: readonly (GlyphEvent | undefined)[]): (g: GlyphEvent) => unknown;
export function findParagraph(inp: ParaInput): Paragraph | UnreflowableReason;
```

- textedit.ts: `export function pageLayout(doc, page, opts): { text; refs; all; inks: Rect[] }` marked `@internal` — `pageText` renamed and extended to collect image quads and path bounding boxes into `inks`.

- [ ] **Step 1: Expose the layout walk**

In `src/textedit.ts`, rename `pageText` to `pageLayout`, export it with an `/** @internal — exported for tests. */` line, and extend it:

```ts
export function pageLayout(
  doc: Document, page: Page, opts: SearchOptions,
): { text: string; refs: (GlyphEvent | undefined)[]; all: GlyphEvent[]; inks: Rect[] } {
  const runs: RefRun<GlyphEvent>[] = [];
  const all: GlyphEvent[] = [];
  const inks: Rect[] = [];   // images and paths, for reflow's free-space rules (u3l5.5)
  const region = opts.region;
  visitContent(doc, page, {
    glyph: (e) => {
      all.push(e);
      if (!e.text) return;
      if (region && !centroidIn(region, e.quad)) return;
      runs.push(runFromGlyph(e, e));
    },
    image: (e) => inks.push(e.quad),
    path: (e) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [ax, ay, bx, by] of e.segments) {
        x0 = Math.min(x0, ax, bx); y0 = Math.min(y0, ay, by);
        x1 = Math.max(x1, ax, bx); y1 = Math.max(y1, ay, by);
      }
      if (x0 <= x1) inks.push([x0, y0, x1, y1]);
    },
  }, walkOpts(opts));
  return { ...layoutLines(runs), all, inks };
}
```

Update the two call sites (`searchText`, `planReplace`) to `pageLayout`.

- [ ] **Step 2: Write the failing tests**

Create `test/reflow-para.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout, findRanges } from '../src/textedit.js';
import { findParagraph, untaggedKeys, type Paragraph } from '../src/reflowpara.js';
import { buildSimpleTextPdf, buildType0Pdf } from './helpers/build-text-pdf.js';

/** findParagraph on a page, anchored at the first glyph of `find`'s first
 *  match, with an always-chained gap rule unless one is given. */
function para(doc: Document, find: string, extra: { gap?: 'none' | 'relative'; annots?: { subtype: string; rect: [number, number, number, number] }[] } = {}) {
  const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
  const [[s]] = findRanges(text, find);
  return findParagraph({
    all, text, refs, covered: new Uint8Array(text.length), keyOf: untaggedKeys(text, refs),
    anchor: refs[s]!, gap: () => extra.gap ?? 'relative', inks, annots: extra.annots ?? [],
  });
}
const block = (text: string, opts: object = {}) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [72, 500, 272, 700], { fontSize: 12, ...opts });
  return Document.Open(d.Save());
};
const LONG = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';

describe('findParagraph (u3l5.5)', () => {
  it('collects the block holding the anchor into words and lines', () => {
    const p = para(block(LONG), 'lazy') as Paragraph;
    expect(typeof p).toBe('object');
    expect(p.words.map((w) => w.glyphs.map((g) => g.text).join('')).join(' ')).toBe(LONG);
    expect(p.lines.length).toBeGreaterThan(2);
    expect(p.pitch).toBeCloseTo(14.4, 6);
    expect(p.align).toBe('left');
    expect(p.indent).toBe(0);
    expect(p.size).toBe(12);
  });

  it('measures gaps between words on a line and fills line starts with the median', () => {
    const p = para(block(LONG), 'lazy') as Paragraph;
    const space = 278 * 12 / 1000;
    for (let i = 1; i < p.words.length; i++) expect(p.gaps[i]).toBeCloseTo(space, 6);
    expect(p.gaps[0]).toBe(0);
  });

  it('detects justified text and uses the last line for the natural gap', () => {
    const p = para(block(LONG, { align: 'justify' }), 'lazy') as Paragraph;
    expect(p.align).toBe('justify');
    for (let i = 1; i < p.words.length; i++) expect(p.gaps[i]).toBeCloseTo(278 * 12 / 1000, 6);
  });

  it('justified with a one-word last line falls back to the smallest gap', () => {
    // The last line holds "woods" alone (box narrowed so it wraps alone).
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock('aaaa bbbb cccc dddd eeee ffff gggggggggggggggg', [72, 500, 172, 700], { fontSize: 12, align: 'justify' });
    const p = para(Document.Open(d.Save()), 'aaaa') as Paragraph;
    expect(p.align).toBe('justify');
    // The smallest gap actually drawn between two words on one line.
    let smallest = Infinity;
    for (let i = 1; i < p.words.length; i++) {
      if (p.words[i].line !== p.words[i - 1].line) continue;
      const prev = p.words[i - 1].glyphs[p.words[i - 1].glyphs.length - 1];
      smallest = Math.min(smallest, p.words[i].glyphs[0].quad[0] - prev.penEnd[0]);
    }
    expect(Number.isFinite(smallest)).toBe(true);
    for (const g of p.gaps.slice(1)) expect(g).toBeCloseTo(smallest, 6);
  });

  it('detects centred and right-aligned text', () => {
    expect((para(block(LONG, { align: 'center' }), 'lazy') as Paragraph).align).toBe('center');
    expect((para(block(LONG, { align: 'right' }), 'lazy') as Paragraph).align).toBe('right');
  });

  it('a one-line paragraph is left-aligned with a 1.2 x size pitch', () => {
    const p = para(Document.Open(buildSimpleTextPdf('BT /F1 10 Tf 20 250 Td (one line) Tj ET')), 'one') as Paragraph;
    expect(p.align).toBe('left');
    expect(p.pitch).toBeCloseTo(12, 6);
  });

  it('refuses vertical text', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0041> <0041> endbfchar\n';
    const doc = Document.Open(buildType0Pdf('BT /F1 12 Tf 100 250 Td <00410041> Tj ET', cmap, { encoding: 'Identity-V' }));
    expect(para(doc, 'A')).toBe('vertical');
  });

  it('answers not-found when the anchor has no paragraph key', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (abc) Tj ET'));
    const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
    expect(findParagraph({ all, text, refs, covered: new Uint8Array(text.length), keyOf: () => undefined,
      anchor: refs[0]!, gap: () => 'relative', inks, annots: [] })).toBe('not-found');
  });

  it('refuses rotated text', () => {
    expect(para(Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 0 1 -1 0 100 100 Tm (abc) Tj ET')), 'abc')).toBe('rotated');
  });

  it('refuses a non-member glyph chained to a member', () => {
    // One Tj draws the end of one block and, after a long kern, text far below
    // is impossible in one chain; use two blocks joined by no positioning op.
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 250 Td (first para) Tj ET BT /F1 12 Tf 20 150 Td (other) Tj ET'));
    expect(para(doc, 'first', { gap: 'none' })).toBe('interleaved');
  });

  it('refuses foreign ink inside the box', () => {
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 250 Td (one two three) Tj 0 -14 Td (four five six) Tj ET 60 240 10 10 re f'));
    expect(para(doc, 'two')).toBe('foreign-ink');
  });

  it('refuses an overlapping annotation it cannot move, and accepts a link', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (one two) Tj ET'));
    expect(para(doc, 'one', { annots: [{ subtype: 'FreeText', rect: [20, 250, 40, 262] }] })).toBe('annotation');
    expect(typeof para(doc, 'one', { annots: [{ subtype: 'Link', rect: [20, 250, 40, 262] }] })).toBe('object');
  });

  it('refuses a varying pitch', () => {
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 250 Td (aa bb) Tj 0 -14 Td (cc dd) Tj 0 -18 Td (ee ff) Tj ET'));
    expect(para(doc, 'aa')).toBe('pitch');
  });

  it('refuses glyphs in two scopes', () => {
    // Exercised end to end in test/reflow.test.ts with a form; here the rule
    // itself: a member set spanning paths.
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (aa bb) Tj ET'));
    const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
    const forged = all.map((g, i) => (i === 1 ? { ...g, addr: { ...g.addr, path: ['Fm0'] } } : g));
    const forgedRefs = refs.map((g) => (g === all[1] ? forged[1] : g));
    expect(findParagraph({
      all: forged, text, refs: forgedRefs, covered: new Uint8Array(text.length),
      keyOf: untaggedKeys(text, forgedRefs), anchor: forged[0], gap: () => 'relative', inks, annots: [],
    })).toBe('scopes');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/reflow-para.test.ts`
Expected: FAIL — `../src/reflowpara.js` does not exist.

- [ ] **Step 4: Implement `src/reflowpara.ts`**

```ts
// The paragraph around an edit, for ReplaceText({ adjust: 'reflow' }) (u3l5.5).
// Pure over glyph events and the page's layout: it reads no content stream and
// allocates nothing, and answers a Paragraph or the reason it will not reflow.
import type { GlyphEvent } from './text.js';
import { groupLineBlocks } from './text.js';
import type { ContentAddr } from './editcontent.js';
import type { ChainGap } from './replaceadjust.js';
import type { UnreflowableReason } from './replacefont.js';

export type Rect = [number, number, number, number];

/** A word: the text glyphs between two gaps, in reading order. */
export interface ParaWord { glyphs: GlyphEvent[]; start: number; end: number; line: number }
/** An original line: its words [first, last], baseline and edges. */
export interface ParaLine { first: number; last: number; baseline: number; left: number; right: number }

export interface Paragraph {
  /** Every glyph of the paragraph, text-less ones included. */
  members: Set<GlyphEvent>;
  words: ParaWord[];
  lines: ParaLine[];
  /** The natural gap BEFORE each word, device units; 0 for the first. */
  gaps: number[];
  box: Rect;
  pitch: number;
  /** The median member glyph font size. */
  size: number;
  align: 'left' | 'right' | 'center' | 'justify';
  /** Line 0's left minus the other lines'. */
  indent: number;
}

export interface ParaInput {
  all: readonly GlyphEvent[];
  text: string;
  refs: readonly (GlyphEvent | undefined)[];
  covered: Uint8Array;
  /** The paragraph a TEXT glyph belongs to; undefined for none. */
  keyOf: (g: GlyphEvent) => unknown;
  anchor: GlyphEvent;
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap;
  /** Images and paths. */
  inks: readonly Rect[];
  annots: readonly { subtype: string; rect: Rect }[];
}

/** Annotations anchored to glyphs, which move with them. */
export const MOVABLE_ANNOTS: ReadonlySet<string> = new Set(['Link', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly']);

const TOL = 0.5;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const overlaps = (a: Rect, b: Rect): boolean =>
  Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.01 && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.01;

/** The untagged paragraph key: the block (`groupLineBlocks`) of the layout
 *  line a glyph sits on. */
export function untaggedKeys(text: string, refs: readonly (GlyphEvent | undefined)[]): (g: GlyphEvent) => unknown {
  const quads: Rect[] = [];
  const lineOf = new Map<GlyphEvent, number>();
  let line = 0;
  let q: Rect = [Infinity, Infinity, -Infinity, -Infinity];
  const close = () => { quads.push(q); q = [Infinity, Infinity, -Infinity, -Infinity]; line++; };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') { close(); continue; }
    const g = refs[i];
    if (!g) continue;
    lineOf.set(g, line);
    q = [Math.min(q[0], g.quad[0]), Math.min(q[1], g.quad[1]), Math.max(q[2], g.quad[2]), Math.max(q[3], g.quad[3])];
  }
  close();
  const blocks = groupLineBlocks(quads.map((quad) => ({ quad })));
  return (g) => { const l = lineOf.get(g); return l === undefined ? undefined : blocks[l]; };
}

/** The 2x2 linear part of `tm x ctm`: upright means no skew or rotation and
 *  positive axes. */
function upright(g: GlyphEvent): boolean {
  const [a1, b1, c1, d1] = g.tm, [a2, b2, c2, d2] = g.ctm;
  const a = a1 * a2 + b1 * c2, b = a1 * b2 + b1 * d2, c = c1 * a2 + d1 * c2, d = c1 * b2 + d1 * d2;
  const eps = 1e-6 * Math.max(Math.abs(a), Math.abs(d), 1);
  return a > 0 && d > 0 && Math.abs(b) < eps && Math.abs(c) < eps;
}

export function findParagraph(inp: ParaInput): Paragraph | UnreflowableReason {
  const { all, text, refs, covered, keyOf, anchor, gap } = inp;
  const key = keyOf(anchor);
  if (key === undefined) return 'not-found';

  // Membership: a text glyph by its key; a text-less one inherits from the
  // glyph its pen is CHAINED to, before it, else after it.
  const members = new Set<GlyphEvent>();
  const isText = (g: GlyphEvent) => g.text !== '';
  const lastIn = new Map<string, GlyphEvent>();
  const pendingTextless = new Map<string, GlyphEvent[]>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    const prev = lastIn.get(scope);
    const chained = prev !== undefined && gap(prev.addr, g.addr) === 'none';
    if (isText(g)) {
      const mine = keyOf(g) === key;
      if (mine) members.add(g);
      for (const t of pendingTextless.get(scope) ?? []) if (mine) members.add(t);
      pendingTextless.delete(scope);
    } else if (chained && members.has(prev)) {
      members.add(g);
    } else if (chained || prev === undefined) {
      const l = pendingTextless.get(scope);
      if (l) l.push(g); else pendingTextless.set(scope, [g]);
    }
    lastIn.set(scope, g);
  }

  // Shape and scope.
  const memberList = all.filter((g) => members.has(g));
  for (const g of memberList) {
    if (g.vertical) return 'vertical';
    if (Math.abs(g.angle) > 0.01 || !upright(g)) return 'rotated';
  }
  const path0 = memberList[0].addr.path.join('\0');
  if (memberList.some((g) => g.addr.path.join('\0') !== path0)) return 'scopes';

  // Interleaving: a chained pair with exactly one member drags the other.
  const prevIn = new Map<string, GlyphEvent>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    const prev = prevIn.get(scope);
    if (prev && gap(prev.addr, g.addr) === 'none' && members.has(prev) !== members.has(g)) return 'interleaved';
    prevIn.set(scope, g);
  }

  // Words and lines over the member text positions, in reading order.
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) { const g = refs[i]; if (g && members.has(g)) positions.push(i); }
  const lo = positions[0], hi = positions[positions.length - 1];
  const words: ParaWord[] = [];
  const lines: ParaLine[] = [];
  let line = 0;
  let cur: ParaWord | undefined;
  const endWord = () => { if (cur) { words.push(cur); cur = undefined; } };
  for (let i = lo; i <= hi; i++) {
    const ch = text[i];
    if (ch === '\n') { endWord(); line++; continue; }
    if (ch === ' ' && !covered[i]) { endWord(); continue; }
    const g = refs[i];
    if (g && !members.has(g)) return 'foreign-ink';
    if (!cur) cur = { glyphs: [], start: i, end: i + 1, line };
    if (g && cur.glyphs[cur.glyphs.length - 1] !== g) cur.glyphs.push(g);
    cur.end = i + 1;
  }
  endWord();
  // Renumber lines densely (a blank layout line holds no word).
  const used = [...new Set(words.map((w) => w.line))];
  for (const w of words) w.line = used.indexOf(w.line);
  for (let l = 0; l < used.length; l++) {
    const first = words.findIndex((w) => w.line === l);
    let last = first;
    while (last + 1 < words.length && words[last + 1].line === l) last++;
    const gl = words.slice(first, last + 1).flatMap((w) => w.glyphs);
    lines.push({
      first, last,
      baseline: words[first].glyphs[0].quad[1],
      left: words[first].glyphs[0].quad[0],
      right: Math.max(...gl.map((g) => g.quad[2])),
    });
  }

  const box: Rect = [
    Math.min(...memberList.map((g) => g.quad[0])), Math.min(...memberList.map((g) => g.quad[1])),
    Math.max(...memberList.map((g) => g.quad[2])), Math.max(...memberList.map((g) => g.quad[3])),
  ];
  for (const g of all) if (g.text && !members.has(g) && overlaps(box, g.quad)) return 'foreign-ink';
  for (const r of inp.inks) if (overlaps(box, r)) return 'foreign-ink';
  for (const a of inp.annots) if (overlaps(box, a.rect) && !MOVABLE_ANNOTS.has(a.subtype)) return 'annotation';

  const size = median(memberList.filter(isText).map((g) => g.fontSize));
  let pitch = 1.2 * size;
  if (lines.length >= 2) {
    const drops = lines.slice(1).map((l, i) => lines[i].baseline - l.baseline);
    pitch = median(drops);
    if (drops.some((d) => Math.abs(d - pitch) > 0.1 * pitch)) return 'pitch';
  }

  // Alignment, from the original edges.
  const n = lines.length;
  const agree = (xs: number[]) => xs.length > 0 && Math.max(...xs) - Math.min(...xs) <= TOL;
  const lefts = lines.map((l) => l.left), rights = lines.map((l) => l.right);
  let align: Paragraph['align'] = 'left';
  let indent = 0;
  if (n >= 3 && agree(lefts.slice(1)) && agree(rights.slice(0, n - 1))) align = 'justify';
  else if (n >= 2 && agree(lefts.slice(1))) align = 'left';
  else if (n >= 2 && agree(rights)) align = 'right';
  else if (n >= 2 && agree(lines.map((l) => (l.left + l.right) / 2))) align = 'center';
  if ((align === 'left' || align === 'justify') && n >= 2) indent = lines[0].left - lines[1].left;

  // Gaps: measured on a line; a line start takes the median, and justified
  // text takes its LAST line's median (the one line not stretched), else the
  // smallest gap measured.
  const measured: (number | undefined)[] = words.map((w, i) => {
    if (i === 0 || words[i - 1].line !== w.line) return undefined;
    const prev = words[i - 1].glyphs[words[i - 1].glyphs.length - 1];
    return w.glyphs[0].quad[0] - prev.penEnd[0];
  });
  const known = measured.filter((x): x is number => x !== undefined);
  let base = known.length ? median(known) : 0.25 * size;
  if (align === 'justify') {
    const last = measured.filter((x, i): x is number => x !== undefined && words[i].line === n - 1);
    base = last.length ? median(last) : Math.min(...known);
  }
  const gaps = words.map((_, i) => (i === 0 ? 0 : align === 'justify' ? base : measured[i] ?? base));

  return { members, words, lines, gaps, box, pitch, size, align, indent };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/reflow-para.test.ts`
Expected: PASS. If the justified one-word-last-line case shows two distinct gap values, the fallback is not the smallest gap — fix `base`, not the test.

- [ ] **Step 6: Commit**

```bash
git add src/reflowpara.ts src/textedit.ts test/reflow-para.test.ts
git commit -m "feat(u3l5.5): find the paragraph around an edit"
```

---

### Task 4: Wrapping to target origins (`reflowwrap.ts`)

**Files:**
- Create: `src/reflowwrap.ts`
- Test: `test/reflow-wrap.test.ts`

**Interfaces:**
- Consumes: `Paragraph`, `ParaWord` (Task 3); `layoutRuns`, `LayoutRun`, `FontDriver` (layout.ts).
- Produces:

```ts
export interface WrapInput {
  para: Paragraph;
  /** Device advance of each member text glyph AFTER the edits: an edit's new
   *  width on its first glyph, 0 on its others. */
  advanceOf: (g: GlyphEvent) => number;
  /** Index of the first and last word an edit touched. */
  firstEdited: number;
  lastEdited: number;
}
export interface WrapResult {
  /** Target origin (x, baseline incl. rise) of every member text glyph. */
  targets: Map<GlyphEvent, [number, number]>;
  /** New line count minus old. */
  addedLines: number;
  /** The lowest target baseline. */
  lowest: number;
}
export function wrapParagraph(inp: WrapInput): WrapResult;
```

- [ ] **Step 1: Write the failing tests**

Create `test/reflow-wrap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout, findRanges } from '../src/textedit.js';
import { findParagraph, untaggedKeys, type Paragraph } from '../src/reflowpara.js';
import { wrapParagraph } from '../src/reflowwrap.js';
import { glyphAdvance } from '../src/replaceadjust.js';

const BOX: [number, number, number, number] = [72, 400, 272, 700];
const block = (text: string, opts: object = {}) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, BOX, { fontSize: 12, ...opts });
  return Document.Open(d.Save());
};
function paraOf(doc: Document, anchorText: string): Paragraph {
  const { text, refs, all, inks } = pageLayout(doc, doc.Pages[0], { includeHidden: true });
  const [[s]] = findRanges(text, anchorText);
  const p = findParagraph({ all, text, refs, covered: new Uint8Array(text.length), keyOf: untaggedKeys(text, refs),
    anchor: refs[s]!, gap: () => 'relative', inks, annots: [] });
  if (typeof p === 'string') throw new Error(p);
  return p;
}
const wordIndex = (p: Paragraph, w: string) => p.words.findIndex((x) => x.glyphs.map((g) => g.text).join('') === w);

describe('wrapParagraph (u3l5.5)', () => {
  const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';

  it('reproduces the producer when nothing changes width', () => {
    const doc = block(T);
    const p = paraOf(doc, 'lazy');
    const k = wordIndex(p, 'lazy');
    const { targets, addedLines } = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k });
    expect(addedLines).toBe(0);
    // Word glyphs only: a space glyph is a gap, not part of any word, and gets
    // no target — the writer lets it ride along its pen chain.
    for (const w of p.words) for (const g of w.glyphs) {
      expect(targets.get(g)![0]).toBeCloseTo(g.quad[0], 6);
      expect(targets.get(g)![1]).toBeCloseTo(g.quad[1], 6);
    }
  });

  it('matches AddTextBlock of the new text when a word grows', () => {
    // "quick" made four times as wide, the shape an edit has: the word's first
    // glyph carries the whole new width and its other glyphs 0.
    const doc = block(T);
    const p = paraOf(doc, 'quick');
    const k = wordIndex(p, 'quick');
    const quick = p.words[k].glyphs;
    const wide = 4 * quick.reduce((s, x) => s + glyphAdvance(x), 0);
    const { targets } = wrapParagraph({
      para: p, firstEdited: k, lastEdited: k,
      advanceOf: (g) => (g === quick[0] ? wide : quick.includes(g) ? 0 : glyphAdvance(g)),
    });
    // Every word after "quick" starts where AddTextBlock of the grown text
    // starts it.
    const grown = paraOf(block(T.replace('quick', 'quickquickquickquick')), 'brown');
    const expected = grown.words.slice(k + 1).map((w) => [w.glyphs[0].quad[0], w.glyphs[0].quad[1]]);
    const after = p.words.slice(k + 1).map((w) => targets.get(w.glyphs[0])!);
    expect(after.length).toBe(expected.length);
    after.forEach(([x, y], i) => { expect(x).toBeCloseTo(expected[i][0], 3); expect(y).toBeCloseTo(expected[i][1], 3); });
  });

  it('an over-wide word sits alone, overflowing, without throwing', () => {
    const doc = block(T);
    const p = paraOf(doc, 'fox');
    const k = wordIndex(p, 'fox');
    const fox0 = p.words[k].glyphs[0];
    const r = wrapParagraph({ para: p, firstEdited: k, lastEdited: k,
      advanceOf: (g) => (g === fox0 ? 500 : p.words[k].glyphs.includes(g) ? 0 : glyphAdvance(g)) });
    const fx = r.targets.get(fox0)!;
    const prevWord = p.words[k - 1].glyphs[0];
    expect(fx[1]).toBeLessThan(r.targets.get(prevWord)![1]);   // its own, lower line
    expect(fx[0]).toBeCloseTo(BOX[0], 6);
  });

  it('stops at convergence: later lines keep their breaks and move by the added lines', () => {
    const doc = block(T);
    const p = paraOf(doc, 'brown');
    const k = wordIndex(p, 'brown');
    const b0 = p.words[k].glyphs[0];
    const extra = 90;   // enough to push one word down a line, not enough for two
    const r = wrapParagraph({ para: p, firstEdited: k, lastEdited: k,
      advanceOf: (g) => (g === b0 ? p.words[k].glyphs.reduce((s, x) => s + glyphAdvance(x), 0) + extra : p.words[k].glyphs.includes(g) ? 0 : glyphAdvance(g)) });
    const lastLine = p.lines[p.lines.length - 1];
    const g = p.words[lastLine.first].glyphs[0];
    expect(r.targets.get(g)![0]).toBeCloseTo(g.quad[0], 6);
    expect(r.targets.get(g)![1]).toBeCloseTo(g.quad[1] - r.addedLines * p.pitch, 6);
    expect(r.addedLines).toBeGreaterThanOrEqual(0);
  });

  it('spreads justified lines and leaves the last line natural', () => {
    const doc = block(T, { align: 'justify' });
    const p = paraOf(doc, 'lazy');
    const k = wordIndex(p, 'lazy');
    const { targets } = wrapParagraph({ para: p, advanceOf: glyphAdvance, firstEdited: k, lastEdited: k });
    for (const g of p.members) if (g.text && g.text !== ' ') expect(targets.get(g)![0]).toBeCloseTo(g.quad[0], 3);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/reflow-wrap.test.ts`
Expected: FAIL — `../src/reflowwrap.js` does not exist.

- [ ] **Step 3: Implement `src/reflowwrap.ts`**

```ts
// Where each glyph of a reflowed paragraph lands (u3l5.5). Pure: words go
// through layoutRuns as ATOMIC boxes — the one wrapping engine — with each gap
// a one-space run measured at exactly that gap, so lines break only BETWEEN
// words and a replacement containing spaces stays one unit.
import type { GlyphEvent } from './text.js';
import type { Paragraph } from './reflowpara.js';
import { layoutRuns, type FontDriver, type LayoutRun } from './layout.js';

export interface WrapInput {
  para: Paragraph;
  advanceOf: (g: GlyphEvent) => number;
  firstEdited: number;
  lastEdited: number;
}
export interface WrapResult {
  targets: Map<GlyphEvent, [number, number]>;
  addedLines: number;
  lowest: number;
}

/** A driver whose space is exactly `w` wide. */
const gapDriver = (w: number): FontDriver => ({
  measure: (t) => (t === ' ' ? w : 0),
  encode: () => new Uint8Array([0x20]),
  probe: (t) => t.length,
});

export function wrapParagraph(inp: WrapInput): WrapResult {
  const { para: p, advanceOf } = inp;
  const targets = new Map<GlyphEvent, [number, number]>();
  const width = (w: number) => p.words[w].glyphs.reduce((s, g) => s + advanceOf(g), 0);
  // Place a word's glyphs from x on a line whose baseline is y; a glyph keeps
  // its rise relative to its ORIGINAL line's baseline.
  const place = (w: number, x: number, y: number): number => {
    const word = p.words[w];
    const lineBase = p.lines[word.line].baseline;
    for (const g of word.glyphs) {
      targets.set(g, [x, y + (g.quad[1] - lineBase)]);
      x += advanceOf(g);
    }
    return x;
  };

  const L = p.words[inp.firstEdited].line;
  // Lines before the edit keep their places.
  for (let w = 0; w < p.lines[L].first; w++) {
    for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1]]);
  }

  const boxLeft = p.align === 'right' || p.align === 'center'
    ? Math.min(...p.lines.map((l) => l.left))
    : p.lines.length >= 2 ? p.lines[1].left : p.lines[0].left;
  const boxRight = Math.max(...p.lines.map((l) => l.right));
  const indent = L === 0 ? p.indent : 0;

  // Runs: atomic word, then a gap run before each later word. Zero-width words
  // (wholly deleted) drop out with their gap.
  const runs: LayoutRun[] = [];
  const runWord: number[] = [];   // run index -> word index, for atomics
  for (let w = p.lines[L].first; w < p.words.length; w++) {
    const wd = width(w);
    if (wd <= 0) continue;
    if (runs.length > 0) { runs.push({ text: ' ', driver: gapDriver(p.gaps[w]), fontSize: p.size }); runWord.push(-1); }
    runs.push({ atomic: { width: wd, height: p.size, align: 'baseline' } });
    runWord.push(w);
  }
  const laid = layoutRuns(runs, boxRight - boxLeft, 1e9, p.pitch, p.size, indent).lines;
  const newLines = laid.map((ln) => ln.segments.filter((s) => s.atomic).map((s) => runWord[s.run]));

  // Convergence: the first new line (after the first) starting where an
  // original line starts, past the last edit.
  let used = newLines.length;
  let shift = newLines.length - (p.lines.length - L);
  for (let k = 1; k < newLines.length; k++) {
    const first = newLines[k][0];
    if (first === undefined || first <= inp.lastEdited) continue;
    const j = p.lines.findIndex((l) => l.first === first);
    if (j > L) { used = k; shift = (L + k) - j; break; }
  }

  const baseY = p.lines[L].baseline;
  for (let k = 0; k < used; k++) {
    const ws = newLines[k];
    const y = baseY - k * p.pitch;
    const lineWidth = ws.reduce((s, w, i) => s + width(w) + (i > 0 ? p.gaps[w] : 0), 0);
    const left = boxLeft + (k === 0 ? indent : 0);
    const isLast = k === newLines.length - 1 && used === newLines.length;
    let x = p.align === 'right' ? boxRight - lineWidth
      : p.align === 'center' ? (boxLeft + boxRight) / 2 - lineWidth / 2
      : left;
    const extra = p.align === 'justify' && !isLast && ws.length > 1
      ? (boxRight - left - lineWidth) / (ws.length - 1) : 0;
    ws.forEach((w, i) => {
      if (i > 0) x += p.gaps[w] + extra;
      x = place(w, x, y);
    });
  }
  // Lines after convergence: their own breaks and x, moved by the shift.
  if (used < newLines.length) {
    const j0 = p.lines.findIndex((l) => l.first === newLines[used][0]);
    for (let j = j0; j < p.lines.length; j++) {
      for (let w = p.lines[j].first; w <= p.lines[j].last; w++) {
        for (const g of p.words[w].glyphs) targets.set(g, [g.quad[0], g.quad[1] - shift * p.pitch]);
      }
    }
  }
  // Zero-width words keep their original origin: they draw nothing.
  for (const w of p.words) for (const g of w.glyphs) if (!targets.has(g)) targets.set(g, [g.quad[0], g.quad[1]]);

  let lowest = Infinity;
  for (const [, [, y]] of targets) lowest = Math.min(lowest, y);
  return { targets, addedLines: shift, lowest };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/reflow-wrap.test.ts`
Expected: PASS. If "reproduces the producer" fails on the last line under justify, check `isLast` before touching tolerances — the last line must not be spread.

- [ ] **Step 5: Commit**

```bash
git add src/reflowwrap.ts test/reflow-wrap.test.ts
git commit -m "feat(u3l5.5): wrap a paragraph's words to target origins"
```

---

### Task 5: Writing the reflow (`textedit.ts`)

**Files:**
- Modify: `src/textedit.ts`
- Test: `test/reflow.test.ts`

**Interfaces:**
- Consumes: `findParagraph`, `untaggedKeys`, `MOVABLE_ANNOTS`, `Paragraph` (Task 3); `wrapParagraph` (Task 4); `ShowInsert`, `ChainGap`, `glyphAdvance`, `runsAdvance` (replaceadjust.ts); `StreamEdits.after`, `chainGapFor`, `pageLayout` (Task 1/3).
- Produces: `planReflow(...)` (internal) called from `planReplace` when `opts.adjust === 'reflow'`.

- [ ] **Step 1: Write the failing tests**

Create `test/reflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { pageLayout } from '../src/textedit.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import type { UnreflowableText } from '../src/replacefont.js';
import { buildSimpleTextPdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 272, 700];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
const block = (text: string, opts: object = {}) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, BOX, { fontSize: 12, ...opts });
  return Document.Open(d.Save());
};
/** Non-space glyph origins in reading order, as [char, x, baseline]. */
const origins = (doc: Document) => {
  const { text, refs } = pageLayout(doc, doc.Pages[0], {});
  const out: [string, number, number][] = [];
  let last;
  for (let i = 0; i < text.length; i++) {
    const g = refs[i];
    if (!g || g === last || g.text.trim() === '') continue;
    last = g;
    out.push([g.text, g.quad[0], g.quad[1]]);
  }
  return out;
};
const same = (a: [string, number, number][], b: [string, number, number][]) => {
  expect(a.map((x) => x[0]).join('')).toBe(b.map((x) => x[0]).join(''));
  a.forEach((x, i) => { expect(x[1]).toBeCloseTo(b[i][1], 3); expect(x[2]).toBeCloseTo(b[i][2], 3); });
};

describe("adjust: 'reflow' — the AddTextBlock oracle (u3l5.5)", () => {
  for (const align of ['left', 'justify'] as const) {
    it(`a longer replacement re-wraps like a fresh block (${align})`, () => {
      const doc = block(T, { align });
      doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
      same(origins(doc), origins(block(T.replace('quick', 'remarkably quick'), { align })));
    });
    it(`a shorter replacement pulls later lines up (${align})`, () => {
      const doc = block(T, { align });
      doc.Pages[0].ReplaceText('quick brown fox jumps over the', 'cat', { adjust: 'reflow' });
      same(origins(doc), origins(block(T.replace('quick brown fox jumps over the', 'cat'), { align })));
    });
  }
  it('reflows after a match on the last line too', () => {
    const doc = block(T);
    doc.Pages[0].ReplaceText('woods', 'woods and over the hills', { adjust: 'reflow' });
    same(origins(doc), origins(block(`${T.replace('woods', 'woods and over the hills')}`)));
  });
});

describe("adjust: 'reflow' — producer shapes (u3l5.5)", () => {
  const LINES = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon zeta) Tj 0 -14 Td (eta theta iota) Tj ET';
  it('re-wraps lines placed by Td, keeping the box width', () => {
    const doc = Document.Open(buildSimpleTextPdf(LINES));
    doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
    const t = doc.Pages[0].GetText().split('\n');
    expect(t[0]).toBe('alpha');
    expect(t.join(' ')).toBe('alpha betabetabetabeta gamma delta epsilon zeta eta theta iota');
  });
  it("re-wraps lines placed by ' and by T*", () => {
    for (const s of [
      "BT /F1 12 Tf 14 TL 20 280 Td (alpha beta gamma) Tj (delta epsilon zeta) ' (eta theta iota) ' ET",
      'BT /F1 12 Tf 14 TL 20 280 Td (alpha beta gamma) Tj T* (delta epsilon zeta) Tj T* (eta theta iota) Tj ET',
    ]) {
      const doc = Document.Open(buildSimpleTextPdf(s));
      doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
      expect(doc.Pages[0].GetText().split(/\s+/).join(' ')).toBe('alpha betabetabetabeta gamma delta epsilon zeta eta theta iota');
    }
  });
  it('leaves the next paragraph in the text object where it was', () => {
    const s = `${LINES.replace(' ET', '')} 0 -60 Td (next paragraph here) Tj ET`;
    const before = Document.Open(buildSimpleTextPdf(s));
    const n0 = before.Pages[0].Search('next')[0].quads[0];
    const doc = Document.Open(buildSimpleTextPdf(s));
    doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow' });
    expect(doc.Pages[0].Search('next')[0].quads[0]).toEqual(n0);
  });
  it('writes nothing when no break moves', () => {
    const a = Document.Open(buildSimpleTextPdf(LINES));
    const b = Document.Open(buildSimpleTextPdf(LINES));
    a.Pages[0].ReplaceText('beta', 'bet');
    b.Pages[0].ReplaceText('beta', 'bet', { adjust: 'reflow' });
    // Only kerns/Tm where a word must move; "bet" moves nothing across a line.
    expect(b.Pages[0].GetText()).toBe(a.Pages[0].GetText());
  });
});

describe("adjust: 'reflow' — refusals (u3l5.5)", () => {
  // "below" sits 26pt under the paragraph's last baseline: past the 1.6-line
  // block split (so it is NOT a member) but inside the line the growth needs.
  const roomless = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon zeta) Tj ET BT /F1 12 Tf 20 240 Td (below) Tj ET';
  it('refuses when the paragraph cannot grow into free space, changing nothing', () => {
    const doc = Document.Open(buildSimpleTextPdf(roomless));
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('beta', 'betabetabetabetabetabeta', { adjust: 'reflow' }))
      .toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
  it('reports with onUnreflowable and replaces without reflow', () => {
    const doc = Document.Open(buildSimpleTextPdf(roomless));
    const seen: UnreflowableText[] = [];
    doc.Pages[0].ReplaceText('beta', 'bet', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) });
    // Narrower: no line is added, so no room is needed and nothing is refused.
    expect(seen).toEqual([]);
    doc.Pages[0].ReplaceText('bet', 'betabetabetabetabetabeta', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) });
    expect(seen).toEqual([{ page: 1, match: 'bet', reason: 'no-room' }]);
    expect(doc.Pages[0].GetText()).toContain('betabetabetabetabetabeta');
  });
  it('reports one paragraph and reflows the other', () => {
    const s = 'BT /F1 12 Tf 20 280 Td (alpha beta gamma) Tj 0 -14 Td (delta epsilon zeta) Tj ET ' +
      'BT /F1 12 Tf 0 1 -1 0 250 20 Tm (beta) Tj ET';
    const doc = Document.Open(buildSimpleTextPdf(s));
    const seen: UnreflowableText[] = [];
    expect(doc.Pages[0].ReplaceText('beta', 'betabetabetabeta', { adjust: 'reflow', onUnreflowable: (r) => seen.push(r) })).toBe(2);
    expect(seen.map((r) => r.reason)).toEqual(['rotated']);
    expect(doc.Pages[0].GetText().split('\n')[0]).toBe('alpha');
  });
  it('refuses a paragraph spanning the page and a form', () => {
    const doc = Document.Open(buildFormTextPdf('BT /F1 12 Tf 20 250 Td (alpha beta) Tj ET /Fm0 Do', 'BT /F1 12 Tf 20 236 Td (gamma delta) Tj ET'));
    expect(() => doc.Pages[0].ReplaceText('beta', 'betabetabetabetabetabetabetabeta', { adjust: 'reflow' }))
      .toThrow(/scopes/);
  });
  it('doc.ReplaceText refuses before changing any page', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
    d.AddPage();
    d.Pages[1].AddTextBlock('beta', [72, 0, 300, 14], { fontSize: 12 });
    const doc = Document.Open(d.Save());
    const before = doc.Save();
    expect(() => doc.ReplaceText(/quick|beta/, 'remarkably long replacement words', { adjust: 'reflow' }))
      .toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/reflow.test.ts`
Expected: FAIL — `'reflow'` writes no line changes; the oracle comparisons mismatch.

- [ ] **Step 3: Add `planReflow` to `textedit.ts`**

Imports: `import { findParagraph, untaggedKeys, MOVABLE_ANNOTS, type Paragraph, type Rect as ParaRect } from './reflowpara.js';`, `import { wrapParagraph } from './reflowwrap.js';`, `import type { UnreflowableReason, UnreflowableText } from './replacefont.js';`. (`MOVABLE_ANNOTS` is first used in Task 6; if it is unused here, import it there.)

In `planReplace`, change the destructure to `const { text, refs, all, inks } = pageLayout(...)`, and after the existing `shiftRest`/`spaceWidth` branch add:

```ts
  const unreflowable: UnreflowableText[] = [];
  if (opts.adjust === 'reflow') {
    planReflow(doc, page, pageNumber, streams, streamFor, all, text, refs, covered, spans, inks, anchored, unreflowable, opts);
  }
```

and in `apply`, after the undrawable reports, `for (const u of unreflowable) opts.onUnreflowable?.({ ...u });`.

Add below `planLineAdjust`:

```ts
const DESCENT = 0.25;

/**
 * Plan `adjust: 'reflow'` (u3l5.5): for each paragraph a match touches, find
 * it, wrap it, refuse or report what cannot be reflowed, and turn its target
 * origins into `Tm` and kern inserts.
 *
 * **Invariant:** a word is corrected only where its NATURAL position differs
 * from its target. The natural position is the pen chain's (u3l5.4); after a
 * relative pen reset (`Td TD T* ' "`) it is the ORIGINAL position only while
 * no `Tm` of ours is in force in that text object (`dirty`), since those
 * operators are relative to a line matrix we may have moved. An absolute reset
 * (`BT ET Tm`) clears `dirty`.
 *
 * **Invariant:** before the first NON-member glyph after a member in the same
 * scope, while `dirty`, a `Tm` restoring the last member's line matrix is
 * written after that member's operator — so content positioned relative to
 * the line matrix after the paragraph does not move.
 */
function planReflow(
  doc: Document, page: Page, pageNumber: number,
  streams: Map<string, StreamEdits>, streamFor: (a: ContentAddr) => StreamEdits,
  all: readonly GlyphEvent[], text: string, refs: readonly (GlyphEvent | undefined)[],
  covered: Uint8Array, spans: Map<GlyphEvent, [number, number]>, inks: readonly ParaRect[],
  anchored: [number, number][], unreflowable: UnreflowableText[], opts: ReplaceTextOptions,
): void {
  const gap = chainGapFor(doc, page);
  const annots = annotRects(doc, page);
  const keyOf = untaggedKeys(text, refs);   // Task 7 replaces this for tagged pages

  // Every StrEdit with the op it sits in, and each edited glyph's edit.
  const edits: { edit: StrEdit; addr: ContentAddr }[] = [];
  for (const s of streams.values()) for (const [opIndex, list] of s.perOp) for (const edit of list) edits.push({ edit, addr: { ...s.addr, opIndex } });
  const editOfGlyph = new Map<GlyphEvent, StrEdit>();
  for (const g of all) {
    const hit = edits.find(({ edit, addr }) => g.addr.opIndex === addr.opIndex && g.addr.streamIndex === addr.streamIndex
      && g.addr.path.join('\0') === addr.path.join('\0') && g.elementIndex === edit.elementIndex
      && g.byteStart >= edit.start && g.byteStart < edit.end);
    if (hit) editOfGlyph.set(g, hit.edit);
  }
  /** Device advance after the edits: an edit's whole new width on its anchor. */
  const advanceOf = (g: GlyphEvent): number => {
    const e = editOfGlyph.get(g);
    if (!e) return glyphAdvance(g);
    return g === e.anchor ? runsAdvance(e.runs, e.anchor) : 0;
  };

  // One paragraph per distinct key, with the matches it holds.
  const done = new Set<unknown>();
  const crop = page.CropBox;
  for (const [s] of anchored) {
    let a = s;
    while (refs[a] === undefined) a++;
    const anchor = refs[a]!;
    const key = keyOf(anchor);
    if (done.has(key)) continue;
    done.add(key);
    const refuse = (reason: UnreflowableReason): void => {
      if (!opts.onUnreflowable) {
        throw new UnsupportedFeatureError(`ReplaceText: page ${pageNumber}: cannot reflow the paragraph holding ${JSON.stringify(text.slice(s, anchored.find((r) => r[0] === s)![1]))}: ${reason}`);
      }
      unreflowable.push({ page: pageNumber, match: text.slice(s, anchored.find((r) => r[0] === s)![1]), reason });
    };
    const p = findParagraph({ all, text, refs, covered, keyOf, anchor, gap, inks, annots });
    if (typeof p === 'string') { refuse(p); continue; }

    const wordOf = new Map<GlyphEvent, number>();
    p.words.forEach((w, i) => { for (const g of w.glyphs) wordOf.set(g, i); });
    const editedWords = p.words.map((_, i) => i).filter((i) => p.words[i].glyphs.some((g) => editOfGlyph.has(g)));
    if (editedWords.length === 0) continue;
    const wrap = wrapParagraph({ para: p, advanceOf, firstEdited: editedWords[0], lastEdited: editedWords[editedWords.length - 1] });

    if (wrap.addedLines > 0 && !roomBelow(p, wrap.lowest, all, inks, crop)) { refuse('no-room'); continue; }
    writeReflow(p, wrap.targets, all, gap, editOfGlyph, advanceOf, streamFor);
    moveAnnotQuads(doc, page, p, wrap.targets, advanceOf);   // Task 6 fills this in
  }
}

/** Whether lines may grow down to `lowest` without reaching the next ink
 *  below the paragraph within its horizontal span, or the crop box. */
function roomBelow(p: Paragraph, lowest: number, all: readonly GlyphEvent[], inks: readonly ParaRect[], crop: number[]): boolean {
  const floor = lowest - DESCENT * p.size;
  if (floor < crop[1]) return false;
  const below = (r: ParaRect) => r[3] <= p.box[1] + 0.01 && Math.min(r[2], p.box[2]) - Math.max(r[0], p.box[0]) > 0.01;
  for (const g of all) if (g.text && !p.members.has(g) && below(g.quad) && g.quad[3] > floor) return false;
  for (const r of inks) if (below(r) && r[3] > floor) return false;
  return true;
}

/** Turn targets into inserts, walking each scope's glyphs in content order. */
function writeReflow(
  p: Paragraph, targets: Map<GlyphEvent, [number, number]>, all: readonly GlyphEvent[],
  gap: (a: ContentAddr, b: ContentAddr) => ChainGap, editOfGlyph: Map<GlyphEvent, StrEdit>,
  advanceOf: (g: GlyphEvent) => number, streamFor: (a: ContentAddr) => StreamEdits,
): void {
  const insert = (g: GlyphEvent, piece: ShowInsert['piece']) => {
    const e = editOfGlyph.get(g);
    const ins: ShowInsert = { addr: g.addr, elementIndex: g.elementIndex, byteStart: e ? e.start : g.byteStart, piece };
    const map = streamFor(g.addr).inserts;
    const list = map.get(g.addr.opIndex);
    if (list) list.push(ins); else map.set(g.addr.opIndex, [ins]);
  };
  const after = (g: GlyphEvent, op: ContentOp) => {
    const map = streamFor(g.addr).after;
    const list = map.get(g.addr.opIndex);
    if (list) list.push(op); else map.set(g.addr.opIndex, [op]);
  };
  const tmFor = (g: GlyphEvent, x: number, y: number): ContentOp => {
    const [ca, cb, cc, cd] = g.ctm;
    const dx = x - g.quad[0], dy = y - g.quad[1];
    const det = ca * cd - cb * cc;
    const de = (dx * cd - dy * cc) / det, df = (dy * ca - dx * cb) / det;
    const r = (v: number) => Math.round(v * 1e6) / 1e6;
    return { operator: 'Tm', operands: [r(g.tm[0]), r(g.tm[1]), r(g.tm[2]), r(g.tm[3]), r(g.tm[4] + de), r(g.tm[5] + df)] };
  };
  type St = { pen?: [number, number]; dirty: boolean; last?: GlyphEvent; lastMember?: GlyphEvent };
  const state = new Map<string, St>();
  for (const g of all) {
    const scope = g.addr.path.join('\0');
    let st = state.get(scope);
    if (!st) { st = { dirty: false }; state.set(scope, st); }
    const kind = st.last ? gap(st.last.addr, g.addr) : 'absolute';
    if (kind === 'absolute') st.dirty = false;
    if (kind !== 'none') st.pen = undefined;
    st.last = g;
    if (!p.members.has(g)) {
      if (st.lastMember && st.dirty) {
        after(st.lastMember, { operator: 'Tm', operands: [...st.lastMember.tlm] });
        st.dirty = false;
      }
      st.lastMember = undefined;
      continue;
    }
    st.lastMember = g;
    const e = editOfGlyph.get(g);
    if (e && g !== e.anchor) continue;          // drawn by its edit's anchor
    const t = targets.get(g);
    if (!t) { if (st.pen) st.pen[0] += advanceOf(g); continue; }   // text-less: rides along
    if (!st.pen && !st.dirty) st.pen = [g.quad[0], g.quad[1]];     // a chain start we did not move
    if (!st.pen || Math.abs(st.pen[1] - t[1]) > 1e-6) {
      insert(g, { kind: 'op', op: tmFor(g, t[0], t[1]) });
      st.dirty = true;
    } else if (Math.abs(st.pen[0] - t[0]) > 1e-6) {
      const per = g.fontSize * g.hscale;
      insert(g, { kind: 'kern', value: Math.round(-(t[0] - st.pen[0]) * 1000 / per * 1000) / 1000 });
    }
    st.pen = [t[0] + advanceOf(g), t[1]];
  }
  for (const st of state.values()) {
    if (st.lastMember && st.dirty) after(st.lastMember, { operator: 'Tm', operands: [...st.lastMember.tlm] });
  }
}

/** Every annotation's subtype and /Rect, for the overlap rules. */
function annotRects(doc: Document, page: Page): { subtype: string; rect: ParaRect }[] {
  const out: { subtype: string; rect: ParaRect }[] = [];
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return out;
  for (const a of annots) {
    const d = doc.resolve(a);
    if (!isDict(d)) continue;
    const st = doc.resolve(d.get('Subtype'));
    const r = doc.resolve(d.get('Rect'));
    if (!isName(st) || !isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'number')) continue;
    const [x0, y0, x1, y1] = r as number[];
    out.push({ subtype: st.name, rect: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] });
  }
  return out;
}

/** Task 6 implements this; until then a reflow leaves annotations as they are. */
function moveAnnotQuads(
  _doc: Document, _page: Page, _p: Paragraph, _targets: Map<GlyphEvent, [number, number]>,
  _advanceOf: (g: GlyphEvent) => number,
): void {}
```

Note: `moveAnnotQuads` is a stub ONLY between Task 5's and Task 6's commits; Task 6 replaces it. It must not ship stubbed — Task 6's tests fail against it.

Also `doc.ReplaceText`: no change — it already dry-plans every page, and `planReflow` throws during planning.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/reflow.test.ts`
Expected: PASS. If an oracle case is off by a constant on one line, print both origin lists and compare the line's first word: the usual cause is a `Tm` solved from the wrong glyph (an edit's non-anchor glyph) — `insert` must use the anchor's `byteStart` (`e.start`).

- [ ] **Step 5: Run the fences**

Run: `npx vitest run test/replace-adjust.test.ts test/replace-options.test.ts test/text-replace.test.ts test/replace-fallback.test.ts test/text-replace-ligature.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/textedit.ts test/reflow.test.ts
git commit -m "feat(u3l5.5): reflow a paragraph by repositioning its glyphs"
```

---

### Task 6: Links and text markup move with their glyphs

**Files:**
- Modify: `src/textedit.ts` (`moveAnnotQuads`)
- Test: `test/reflow-annots.test.ts`

**Interfaces:**
- Consumes: `MOVABLE_ANNOTS`, `Paragraph`, `centroidIn`.
- Produces: `moveAnnotQuads(doc, page, p, targets, advanceOf): void` — mutates at APPLY time (see Step 3).

- [ ] **Step 1: Write the failing tests**

Create `test/reflow-annots.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const BOX: [number, number, number, number] = [72, 400, 272, 700];
const T = 'The quick brown fox jumps over the lazy dog and then keeps running far away into the woods';
function linked() {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, BOX, { fontSize: 12 });
  const doc = Document.Open(d.Save());
  const m = doc.Pages[0].Search('lazy dog')[0];
  doc.Pages[0].AddLink({ rect: m.quads[0], action: { type: 'uri', uri: 'https://example.com' } });
  doc.Pages[0].AddHighlight({ quads: m.quads.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]) });
  return doc;
}

describe('reflow moves glyph-anchored annotations (u3l5.5)', () => {
  it('re-derives a link and a highlight from the moved words', () => {
    const doc = linked();
    doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' });
    const moved = doc.Pages[0].Search('lazy dog')[0].quads;
    for (const a of doc.Pages[0].Annotations) {
      const r = a.Rect!;
      const covers = moved.some((q) => q[0] >= r[0] - 0.01 && q[2] <= r[2] + 0.01 && q[1] >= r[1] - 0.01 && q[3] <= r[3] + 0.01);
      expect(covers).toBe(true);
    }
  });

  it('writes one quad per line the words now span', () => {
    const doc = linked();
    // Push "lazy" to the end of a line so "lazy dog" wraps.
    doc.Pages[0].ReplaceText('jumps', 'jumps and jumps and jumps', { adjust: 'reflow' });
    const lines = doc.Pages[0].Search('lazy dog')[0].quads.length;
    const hl = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Highlight')!;
    expect((hl.Dict.get('QuadPoints') as number[]).length).toBe(8 * lines);
  });

  it('leaves the annotations byte-identical when the paragraph is refused', () => {
    const doc = linked();
    doc.Pages[0].AddFreeText({ rect: [72, 680, 120, 700], contents: 'note' });
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('quick', 'remarkably quick indeed', { adjust: 'reflow' })).toThrow(/annotation/);
    expect(doc.Save()).toEqual(before);
  });
});
```


- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/reflow-annots.test.ts`
Expected: FAIL on the first two cases (rects not moved); the third passes already.

- [ ] **Step 3: Implement `moveAnnotQuads`**

Annotation changes must happen at APPLY time, not plan time (a refused call changes nothing). So `planReflow` records them and `apply` writes them. Change the stub's call site in `planReflow` to push a closure: add a parameter `annotWrites: (() => void)[]` to `planReflow`, create it in `planReplace` beside `unreflowable`, call `for (const w of annotWrites) w();` in `apply` after `applyEdits`, and replace the stub with:

```ts
/** Recompute /QuadPoints and /Rect of every Link or text-markup annotation
 *  over the paragraph from its glyphs' targets — one quad per target line —
 *  as a closure `apply` runs. A glyph is covered by its quad's CENTROID,
 *  `SearchOptions.region`'s rule. */
function moveAnnotQuads(
  doc: Document, page: Page, p: Paragraph, targets: Map<GlyphEvent, [number, number]>,
  advanceOf: (g: GlyphEvent) => number, annotWrites: (() => void)[],
): void {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const a of annots) {
    const d = doc.resolve(a);
    if (!isDict(d)) continue;
    const st = doc.resolve(d.get('Subtype'));
    if (!isName(st) || !MOVABLE_ANNOTS.has(st.name)) continue;
    const qp = doc.resolve(d.get('QuadPoints'));
    const rect = doc.resolve(d.get('Rect'));
    const areas: ParaRect[] = [];
    if (isArray(qp) && qp.length >= 8 && qp.length % 8 === 0 && qp.every((v) => typeof v === 'number')) {
      const n = qp as number[];
      for (let i = 0; i < n.length; i += 8) {
        const xs = [n[i], n[i + 2], n[i + 4], n[i + 6]], ys = [n[i + 1], n[i + 3], n[i + 5], n[i + 7]];
        areas.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      }
    } else if (isArray(rect) && rect.length === 4 && rect.every((v) => typeof v === 'number')) {
      const r = rect as number[];
      areas.push([Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
    } else continue;
    const covered = [...p.members].filter((g) => g.text.trim() !== '' && areas.some((r) => centroidIn(r, g.quad)));
    if (covered.length === 0) continue;
    if (covered.every((g) => { const t = targets.get(g); return !t || (t[0] === g.quad[0] && t[1] === g.quad[1]); })) continue;
    // Group by target baseline, then one quad per line.
    const byLine = new Map<number, ParaRect>();
    for (const g of covered) {
      const t = targets.get(g) ?? [g.quad[0], g.quad[1]];
      const key = Math.round(t[1] * 1000);
      const box: ParaRect = [t[0], t[1], t[0] + advanceOf(g), t[1] + g.fontSize];
      const cur = byLine.get(key);
      byLine.set(key, cur ? [Math.min(cur[0], box[0]), Math.min(cur[1], box[1]), Math.max(cur[2], box[2]), Math.max(cur[3], box[3])] : box);
    }
    const lines = [...byLine.values()].sort((x, y) => y[1] - x[1]);
    const quads = lines.flatMap(([x0, y0, x1, y1]) => [x0, y1, x1, y1, x0, y0, x1, y0]);
    const union: ParaRect = [
      Math.min(...lines.map((l) => l[0])), Math.min(...lines.map((l) => l[1])),
      Math.max(...lines.map((l) => l[2])), Math.max(...lines.map((l) => l[3])),
    ];
    annotWrites.push(() => {
      d.set('QuadPoints', quads);
      d.set('Rect', [...union]);
      doc.markModified();
    });
  }
}
```

and change the call in `planReflow` to `moveAnnotQuads(doc, page, p, wrap.targets, advanceOf, annotWrites);`. (`doc.markModified()` is public on `Document`.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/reflow-annots.test.ts test/reflow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/textedit.ts test/reflow-annots.test.ts
git commit -m "feat(u3l5.5): move link and text-markup quads with reflowed words"
```

---

### Task 7: Tagged paragraphs

**Files:**
- Modify: `src/textedit.ts` (`planReflow`'s `keyOf`)
- Test: `test/reflow-tagged.test.ts`

**Interfaces:**
- Consumes: `doc.GetStructTree()`, `StructTreeRoot.ElementFor(key, mcid)`, `StructElement.Parent`, `.StandardType`, `.Dict`.
- Produces: `taggedKeys(doc, page): ((g: GlyphEvent) => unknown) | undefined` (textedit.ts, internal).

- [ ] **Step 1: Write the failing tests**

Create `test/reflow-tagged.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';

// The linked paragraph is LAST on the page, so its growth has the page below.
const MD = 'First paragraph stays put.\n\nThe quick brown fox jumps over the lazy dog and then keeps running far away into the [woods](https://example.com) at night.';
function tagged(md = MD) {
  const d = Document.New();
  d.AddMarkdown(md, { tagged: true });
  return Document.Open(d.Save());
}
const rules = (doc: Document) => doc.ValidatePdfUa().Issues.map((i) => i.rule).sort();

describe('reflow in a tagged document (u3l5.5)', () => {
  it('reflows the /P holding the match and keeps every MCID resolving', () => {
    const doc = tagged();
    const issues0 = rules(doc);
    const firstY = doc.Pages[0].Search('First')[0].quads[0];
    doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
    expect(doc.Pages[0].Search('First')[0].quads[0]).toEqual(firstY);
    expect(doc.Pages[0].GetText()).toContain('remarkably quick');
    expect(rules(doc)).toEqual(issues0);
    expect(rules(doc)).not.toContain('UntaggedContent');
  });

  it('keeps the link annotation over its word', () => {
    const doc = tagged();
    doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' });
    const w = doc.Pages[0].Search('woods')[0].quads[0];
    const link = doc.Pages[0].Annotations.find((a) => a.Subtype === 'Link')!;
    const r = link.Rect!;
    expect(w[0]).toBeGreaterThanOrEqual(r[0] - 0.01);
    expect(w[2]).toBeLessThanOrEqual(r[2] + 0.01);
  });

  it('uses the structure, not the geometry, to find the paragraph', () => {
    // A heading directly above the paragraph: by geometry the two can merge
    // into one block of uneven pitch (and refuse); by structure the /H1 is not
    // a member, so the /P reflows and the heading does not move.
    const doc = tagged('# Title\n\nThe quick brown fox jumps over the lazy dog and then keeps running far away into the woods.');
    const titleY = doc.Pages[0].Search('Title')[0].quads[0];
    expect(() => doc.Pages[0].ReplaceText('quick', 'remarkably quick', { adjust: 'reflow' })).not.toThrow();
    expect(doc.Pages[0].Search('Title')[0].quads[0]).toEqual(titleY);
  });

  it('refuses text on a tagged page that no structure element owns', () => {
    const doc = tagged();
    doc.Pages[0].AddText('stray words here', 72, 60);   // drawn untagged
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('stray', 'much longer stray', { adjust: 'reflow' })).toThrow(/not-found/);
    expect(doc.Save()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/reflow-tagged.test.ts`
Expected: FAIL — the untagged key groups by geometry, and the link/span MCIDs split the paragraph's words.

- [ ] **Step 3: Implement `taggedKeys`**

```ts
/** Block-level structure types: a paragraph is the nearest of these above a
 *  glyph's MCID element (after the RoleMap). */
const BLOCK_TYPES = new Set(['P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LBody', 'TD', 'TH', 'Caption', 'BlockQuote', 'Note']);

/** The tagged paragraph key: the Dict of the block-level element owning a
 *  glyph's MCID. Undefined when the page is not tagged (no structure tree or
 *  no /StructParents), so the caller falls back to geometry. A glyph inside a
 *  form, or with no MCID, has no key. */
function taggedKeys(doc: Document, page: Page): ((g: GlyphEvent) => unknown) | undefined {
  const root = doc.GetStructTree();
  const sp = doc.resolve(page.Dict.get('StructParents'));
  if (!root || typeof sp !== 'number') return undefined;
  const memo = new Map<number, unknown>();
  return (g) => {
    if (g.mcid === undefined || g.addr.path.length > 0) return undefined;
    if (memo.has(g.mcid)) return memo.get(g.mcid);
    let el = root.ElementFor(sp, g.mcid);
    while (el && !BLOCK_TYPES.has(el.StandardType) && !/^H\d+$/.test(el.StandardType)) el = el.Parent;
    const key = el?.Dict;
    memo.set(g.mcid, key);
    return key;
  };
}
```

In `planReflow`, replace `const keyOf = untaggedKeys(text, refs);` with:

```ts
  // A tagged page's paragraph is its block-level structure element; geometry
  // is the fallback for an untagged one.
  const keyOf = taggedKeys(doc, page) ?? untaggedKeys(text, refs);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/reflow-tagged.test.ts test/reflow.test.ts test/reflow-annots.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/textedit.ts test/reflow-tagged.test.ts
git commit -m "feat(u3l5.5): reflow a tagged paragraph by its structure element"
```

---

### Task 8: Docs, mutation sweep, close

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: README**

In the **Text replace** Key Capabilities paragraph, after the `options.adjust` sentence, add:

```
`adjust: 'reflow'` re-wraps every paragraph a match touches — words move between lines through the same engine `AddTextBlock` uses, the paragraph's alignment (left, right, centred or justified) and first-line indent are kept, and it may grow only into free space below it. The glyphs themselves are not re-encoded: each moved word gets a `Tm` or a `TJ` kern, so fonts, colours and marked content survive, and links and text-markup annotations over the paragraph move with their words. A paragraph is the block-level structure element in a tagged document and the extracted text block otherwise. Where reflow could overprint — rotated or vertical text, a paragraph spanning a form, other ink inside it, an annotation it cannot move, uneven line spacing, or no room below — the call throws `UnsupportedFeatureError`, or with `onUnreflowable` replaces that paragraph without reflow and reports it.
```

In the **Replace Text** example block, add:

```ts
// Re-wrap the paragraph instead of letting a longer word run on.
doc.ReplaceText('Draft', 'Final reviewed version', { adjust: 'reflow' });
```

In **Scope and Limitations**, replace the start of the "Text replace does not reflow" bullet with `**Text replace reflows within a paragraph only, and does not re-subset** — ` and add: `` `adjust: 'reflow'` re-wraps one paragraph by moving its glyphs; it never moves content below the paragraph, never hyphenates or breaks inside a word, and declines a paragraph split across a column or a page. ``

- [ ] **Step 2: CHANGELOG**

Under `## [Unreleased]` → `### Added`, at the top:

```
- **`ReplaceText` can re-wrap the paragraph around a replacement.** `adjust: 'reflow'` moves words between lines so a longer or shorter replacement reads like text that was always there. Words wrap through `layoutRuns`, the engine `AddTextBlock` uses, as unbreakable units; the paragraph keeps its alignment — left, right, centred or justified, detected from its original line edges — and its first-line indent, and grows only into free space below it. Lines before the edit keep their breaks, and once a new break lands on an original one the rest keep theirs too, moving by the lines added. Nothing is re-encoded: each moved word gets a `Tm` or a `TJ` kern, so fonts, colours, kerning inside words and marked content survive, and after the paragraph the line matrix is put back so a following paragraph positioned by `Td` does not move. Links and highlights, underlines, strike-outs and squiggles over the paragraph get new quads from their moved words. A tagged document's paragraph is its block-level structure element; otherwise it is the text block `GetStructuredText` reports, through one shared grouping. A paragraph that could be overprinted is refused rather than guessed at — vertical or rotated text, glyphs in two scopes, another paragraph's text in the same pen chain, other ink inside it, an annotation that is not anchored to text, uneven line spacing, or no room below — with `UnsupportedFeatureError` naming the reason, or through `onUnreflowable`, which replaces that paragraph without reflow and reports `{ page, match, reason }`. Checked against `AddTextBlock` itself: reflowing a block to new text puts every glyph where a fresh block of that text does. `GlyphEvent` gains `tm`, `tlm` and `ctm`. (u3l5.5)
```

- [ ] **Step 3: CLAUDE.md**

Add a Source entry before `**replaceadjust.ts**`:

```
- **reflowpara.ts**, **reflowwrap.ts** — `ReplaceText({ adjust: 'reflow' })`
  (`u3l5.5`). `reflowpara.ts` finds the paragraph around an edit — members,
  words, lines, gaps, pitch, alignment — or a refusal reason; `reflowwrap.ts`
  wraps its words to target origins. Both pure; `textedit.ts`'s `planReflow`
  writes the targets.
  **Invariant:** words go through `layoutRuns` as ATOMIC boxes with each gap a
  one-space run measured at that gap, so the one wrapping engine breaks only
  BETWEEN words. The oracle is `AddTextBlock` itself: reflowing a block to new
  text must put every glyph where a fresh block of that text does.
  **Invariant:** nothing is re-encoded. A moved word gets an absolute `Tm` —
  its own scale, the translation solved through the inverse CTM — or a `TJ`
  kern. After a relative pen reset the natural position is the original one
  only while none of our `Tm`s is in force in that text object (`dirty`), and
  before the next NON-member glyph a `Tm` restores the last member's line
  matrix, so a following paragraph placed by `Td` does not move.
  **Invariant:** wrapping starts at the first EDITED line and stops at
  CONVERGENCE; a producer's breaks need not be greedy, so re-wrapping from line
  0 would change lines the edit never touched.
  **Invariant:** the paragraph key is the block-level structure element on a
  tagged page and `groupLineBlocks` otherwise — the ONE grouping
  `extractStructured` uses. Everything is decided while PLANNING; annotation
  quads are written by closures `apply` runs.
```

and under text.ts's GlyphEvent notes add one line: `**Invariant (u3l5.5):** \`tm\` is the text matrix at the glyph's START, so \`apply(mul(tm, ctm), 0, rise)\` is its origin — the corner of \`quad\`.`

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 5: Mutation sweep**

Write a scratchpad node script (not in the repo) that, for each mutation below, replaces the text, runs `npx vitest run test/reflow-foundation.test.ts test/reflow-para.test.ts test/reflow-wrap.test.ts test/reflow.test.ts test/reflow-annots.test.ts test/reflow-tagged.test.ts`, restores the file, and prints RED/GREEN/TIMEOUT/LOAD-ERROR (a run where any file failed to load is LOAD-ERROR, not GREEN). Every mutation must be RED, or be recorded in CLAUDE.md's entry as a redundant defence with the case that shows it:

1. `reflowpara.ts`: drop the interleaving loop's `return 'interleaved'`.
2. `reflowpara.ts`: `overlaps` threshold `> 0.01` → `> 1e9` (foreign ink never detected).
3. `reflowpara.ts`: justified `base` from all gaps instead of the last line.
4. `reflowpara.ts`: `n >= 3` → `n >= 2` in the justify test.
5. `reflowwrap.ts`: drop `+ (g.quad[1] - lineBase)` (rise ignored).
6. `reflowwrap.ts`: never converge (`if (j > L)` → `if (false)`).
7. `reflowwrap.ts`: justify the last line too (`!isLast` → `true`).
8. `textedit.ts` `writeReflow`: drop the restoring `Tm` before a non-member.
9. `textedit.ts` `writeReflow`: `kind === 'absolute'` no longer clears `dirty`.
10. `textedit.ts` `writeReflow`: insert at `g.byteStart` even for an edit's anchor.
11. `textedit.ts` `roomBelow`: always `true`.
12. `textedit.ts` `taggedKeys`: return `undefined` always.
13. `textedit.ts` `moveAnnotQuads`: skip the per-line grouping (one union quad).

- [ ] **Step 6: Commit, close, push**

```bash
git add README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(u3l5.5): paragraph reflow"
bd close aspose-pdf-foss-for-ts-u3l5.5 --reason "adjust: 'reflow' — paragraph found (tagged/untagged), wrapped through layoutRuns, glyphs repositioned by Tm/kerns, annotations moved; AddTextBlock oracle"
git add .beads && git commit -m "beads: u3l5.5 closed"
git pull --rebase && git push && git status
```
