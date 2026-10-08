# Footnotes and Endnotes in Flow (v9j3.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flow runs can carry footnote and endnote references; footnotes are placed at the foot of the column holding the reference (splitting Word-style when they must), endnotes after the flow's content, both tagged `/Note` in a tagged flow.

**Architecture:** A new module `src/flownotes.ts` owns everything note-specific — lowering a run with a note into body + mark run, numbering, the `NoteElement` decorator, the per-column `NoteColumn`, and the pure budget-settling loop. `FlowElement` gains two optional members (`noteRefs()` and `measure().notes`) that containers forward. `Flow.Render` numbers every note in one pass at its start, then probes each element's kept references before placing it and reserves the column foot for their notes. A general `TextRun.rise` draws the superscript mark.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-footnotes-endnotes-design.md`

## Global Constraints

- Zero runtime dependencies; only `node:` built-ins. Import specifiers carry `.js`.
- A flow that contains no note must take EXACTLY today's code path: `test/rich-runs-identity.test.ts`, `test/markdown-flow.test.ts`, `test/html-identity.test.ts`, `test/docx-flow-identity.test.ts` stay UNEDITED and green.
- A run with no `rise` emits no new operator.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`test/limits-catch.test.ts`); this plan adds no `catch`.
- No new value-import 2-cycle: run `npx vitest run test/import-cycles.test.ts` after any task that adds an import. `flownotes.ts` must NOT value-import `flow.ts` (flow.ts value-imports it); type-only imports are fine.
- Every name exported from `src/index.ts` needs a README API Reference row (`test/readme-api.test.ts` asserts it and the counts).
- Defaults copied from the spec: footnote format `'arabic'`, endnote format `'roman'`; `start` 1; `markScale` 0.6; footnote body `fontSize` 8, endnote 10; separator a rule 1/3 of the column wide, 0.5pt, black; `spacing` 4; endnote `newPage` false; mark rise = 0.33 × the referencing run's size; gutter gap 3pt; `symbols` sequence `* † ‡ § ‖ ¶`, doubled then tripled.
- Errors: `TypeError` for bad values and misuse, `UnsupportedFeatureError` (from `src/errors.ts`) for the scope-outs.
- Before closing: `npm run typecheck` and `npm test` both green.

## Review Focus

1. **Many references on one line** (eight footnotes in one sentence): all eight notes stack at that column's foot in reference order, and the line still lands in the column if the notes fit. → Task 6.
2. **Two tagged flows in one document**: note `/ID`s never collide (`fn-1` in the first flow does not repeat in the second), and every ID resolves through `/IDTree`. → Task 8.
3. **A note longer than three columns after the last element**: `Render` keeps creating pages until the note is fully drawn, then stops. It does not loop forever and does not drop the tail. → Task 6.
4. **A reference run with empty text** (`{ text: '', footnote }`): the mark alone is drawn, the note still appears. → Task 4.
5. **A keep-with-next heading at a column foot whose following paragraph carries a footnote**: the heading's lookahead uses the effective (foot-reduced) bottom, so the heading moves with its paragraph rather than being stranded above footnotes. → Task 6.

---

### Task 1: `TextRun.rise` and the note-key guard

**Files:**
- Modify: `src/textdecor.ts` (the `TextRun` interface near line 136; the run validator if there is one — search `checkRun`)
- Modify: `src/stamp.ts` (`ResolvedRun` ~523, `resolveRuns` ~540, `segmentBoxes` ~788, `runLinkBoxes` ~891, `buildRunBlockBody` ~936)
- Test: `test/text-rise.test.ts` (create)

**Interfaces:**
- Produces: `TextRun.rise?: number` (points, positive raises). `ResolvedRun.rise: number` (0 when unset). `resolveRuns` throws `TypeError` when a run has an own `footnote` or `endnote` key.

- [ ] **Step 1: Write the failing tests**

```ts
// test/text-rise.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';

function content(page: { Contents: Uint8Array }): string {
  return new TextDecoder('latin1').decode(page.Contents);
}

describe('TextRun.rise', () => {
  it('emits Ts before the raised run and resets it after', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    page.AddTextBlock([{ text: 'claim' }, { text: '1', fontSize: 7, rise: 4 }, { text: ' more' }],
      [72, 600, 300, 100], { fontSize: 12 });
    const s = content(page);
    const i = s.indexOf('4 Ts');
    expect(i).toBeGreaterThan(0);
    expect(s.indexOf('(1) Tj', i)).toBeGreaterThan(i);
    expect(s.indexOf('0 Ts', i)).toBeGreaterThan(s.indexOf('(1) Tj', i));
  });

  it('emits no Ts at all for runs without rise', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    page.AddTextBlock([{ text: 'a' }, { text: 'b', fontSize: 7 }], [72, 600, 300, 100]);
    expect(content(page)).not.toMatch(/ Ts\b/);
  });

  it('does not change the line band: a raised mark leaves usedHeight alone', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const a = page.AddTextBlock([{ text: 'x' }], [72, 600, 300, 100], { fontSize: 12 });
    const b = page.AddTextBlock([{ text: 'x' }, { text: '1', fontSize: 7, rise: 4 }],
      [72, 400, 300, 100], { fontSize: 12 });
    expect(b.usedHeight).toBe(a.usedHeight);
  });

  it('moves a raised linked run’s rect up by the rise', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    page.AddTextBlock([{ text: 'x ' }, { text: 'L', link: 'https://a.example/', rise: 5 }],
      [72, 600, 300, 100], { fontSize: 12 });
    const flat = doc.AddPage().page;
    flat.AddTextBlock([{ text: 'x ' }, { text: 'L', link: 'https://a.example/' }],
      [72, 600, 300, 100], { fontSize: 12 });
    const r1 = page.Annotations[0].Rect, r0 = flat.Annotations[0].Rect;
    expect(r1[1] - r0[1]).toBeCloseTo(5, 6);
    expect(r1[3] - r0[3]).toBeCloseTo(5, 6);
  });

  it('refuses a non-finite rise', () => {
    const page = Document.New().AddPage().page;
    expect(() => page.AddTextBlock([{ text: 'a', rise: NaN }], [72, 600, 300, 100]))
      .toThrow(TypeError);
  });
});

describe('the note-key guard', () => {
  it('refuses a run carrying a footnote outside a Flow', () => {
    const page = Document.New().AddPage().page;
    const run = { text: 'a', footnote: { content: 'n' } } as never;
    expect(() => page.AddTextBlock([run], [72, 600, 300, 100]))
      .toThrow(/footnote.*only.*Flow/);
  });
  it('refuses a run carrying an endnote outside a Flow', () => {
    const page = Document.New().AddPage().page;
    const run = { text: 'a', endnote: { content: 'n' } } as never;
    expect(() => page.AddTextBlock([run], [72, 600, 300, 100])).toThrow(TypeError);
  });
});
```

Check `page.AddTextBlock`'s exact return shape and `Annotation.Rect` before running; adjust names if they differ (search `AddTextBlock(` in `src/page.ts`).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/text-rise.test.ts`
Expected: FAIL — `rise` is ignored, no `Ts` emitted; guard tests do not throw.

- [ ] **Step 3: Implement**

`src/textdecor.ts`, in `TextRun`:

```ts
  /** Baseline shift in points; positive raises (a superscript), negative
   *  lowers. Moves the INK only: the line band is still sized from
   *  `fontSize`. Emitted as `Ts`. Default 0. */
  rise?: number;
```

`src/stamp.ts`:

1. Add `rise: number;` to `ResolvedRun`.
2. In `resolveRuns`, before the decor resolution:

```ts
    // A note reference is lowered by Flow alone (flownotes.ts). Anywhere
    // else it would be drawn without its note — refuse rather than drop it.
    if (Object.prototype.hasOwnProperty.call(r, 'footnote')
        || Object.prototype.hasOwnProperty.call(r, 'endnote'))
      throw new TypeError(`run ${i}: footnote/endnote runs are supported only inside a Flow`);
    const rise = r.rise ?? 0;
    if (typeof rise !== 'number' || !Number.isFinite(rise))
      throw new TypeError(`run ${i}: rise must be a finite number`);
```

and push `rise` into the resolved object.
3. `SegmentBox` gains `rise: number`; `segmentBoxes` sets `rise: r.rise` (0 for atomics: `isAtomicRun(r.layout) ? 0 : r.rise`).
4. `runLinkBoxes`: use `b.baseline + b.rise` in both y coordinates.
5. `runDecorOps`: for a box whose run states its OWN decoration (`runs[b.run].decor !== undefined && runs[b.run].decor !== <block decor>` is not available here — instead, add `ownDecor: boolean` to `ResolvedRun`, set to `own` in `resolveRuns`), push `baseline: b.baseline + (runs[b.run].ownDecor ? b.rise : 0)`. A block-level underline keeps spanning the line at the real baseline.
6. `buildRunBlockBody`: track `let curRise = 0;` beside `curSize`. Inside the segment loop, after the `Tf`/`rg` handling and before the `Tj`:

```ts
      if (r.rise !== curRise) { s += `${num(r.rise)} Ts\n`; curRise = r.rise; }
```

and after the segment loop (before `ET`): `if (curRise !== 0) s += '0 Ts\n';`. Since `Ts` persists in the text state, the reset makes a later run on the same line unraised — the next non-raised segment already emits `0 Ts` through the comparison; the trailing reset covers a block ending in a raised run.

- [ ] **Step 4: Run to verify they pass, and the identity fence**

Run: `npx vitest run test/text-rise.test.ts test/rich-runs-identity.test.ts test/rich-runs-link-tagged.test.ts`
Expected: PASS, all.

- [ ] **Step 5: Commit**

```bash
git add src/textdecor.ts src/stamp.ts test/text-rise.test.ts
git commit -m "feat(v9j3.3): TextRun.rise and the note-key guard"
```

---

### Task 2: `flownotes.ts` core — lowering, references, marks, options

**Files:**
- Create: `src/flownotes.ts`
- Test: `test/flownotes-lower.test.ts` (create)

**Interfaces:**
- Produces (all exported from `src/flownotes.ts`):

```ts
export const NOTE: unique symbol;
export type NoteKind = 'footnote' | 'endnote';
export type NoteText = string | TextRun[];               // structurally FlowText
export interface FlowNote { content: NoteText | FlowElement[]; mark?: string }
export interface FlowTextRun extends TextRun { footnote?: FlowNote; endnote?: FlowNote }
export interface MarkRun extends TextRun { [NOTE]: NoteRef }
export interface NoteRef {
  readonly kind: NoteKind;
  readonly note: FlowNote;
  readonly markRun: MarkRun;     // the run object in the lowered list
  readonly baseSize: number;     // the referencing run's size
  mark: string;                  // '' until numbered
  body: FlowElement[];           // [] until numbered
  id?: string;                   // set at tagging commit
  owner?: StructElement;         // set by the element that placed the reference
  noteTag?: StructElement;       // the /Note, set at tagging commit
}
export function lowerNotes(text: NoteText, blockSize: number): NoteText;
export function refsIn(text: NoteText | null): NoteRef[];
export function keptRefs(text: NoteText, remainder: NoteText | null): NoteRef[];
export type MarkFormat = 'arabic' | 'roman' | 'Roman' | 'alpha' | 'Alpha' | 'symbols';
export function formatMark(n: number, format: MarkFormat): string;
export interface FlowNoteOptions { format?: MarkFormat; start?: number; markScale?: number;
  fontSize?: number; separator?: { width?: number; thickness?: number;
  color?: [number, number, number] } | false; spacing?: number }
export interface FlowEndnoteOptions extends FlowNoteOptions { newPage?: boolean }
export interface ResolvedNoteOptions { format: MarkFormat; start: number; markScale: number;
  fontSize: number; separator: { width?: number; thickness: number;
  color: [number, number, number] } | undefined; spacing: number; newPage: boolean }
export function normalizeNoteOptions(o: FlowEndnoteOptions | undefined, kind: NoteKind): ResolvedNoteOptions;
export const MARK_RISE = 0.33;
export const GUTTER_GAP = 3;
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/flownotes-lower.test.ts
import { describe, it, expect } from 'vitest';
import {
  lowerNotes, refsIn, keptRefs, formatMark, normalizeNoteOptions, NOTE,
} from '../src/flownotes.js';
import type { TextRun } from '../src/textdecor.js';

describe('lowerNotes', () => {
  it('returns a string and a note-free run list unchanged (identity)', () => {
    const runs: TextRun[] = [{ text: 'a' }];
    expect(lowerNotes('plain', 12)).toBe('plain');
    expect(lowerNotes(runs, 12)).toBe(runs);
  });

  it('splits a noted run into its body and a mark run carrying a NoteRef', () => {
    const note = { content: 'The note.' };
    const out = lowerNotes([{ text: 'claim', fontSize: 10, color: [1, 0, 0], footnote: note }], 12) as TextRun[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: 'claim', fontSize: 10, color: [1, 0, 0] });
    expect('footnote' in out[0]).toBe(false);
    const ref = (out[1] as never)[NOTE];
    expect(ref.kind).toBe('footnote');
    expect(ref.note).toBe(note);
    expect(ref.baseSize).toBe(10);            // the run's own size wins
    expect(ref.markRun).toBe(out[1]);
    expect(out[1].color).toEqual([1, 0, 0]);
  });

  it('uses the block size when the run states none', () => {
    const out = lowerNotes([{ text: 'x', endnote: { content: 'e' } }], 12) as TextRun[];
    expect((out[1] as never)[NOTE].baseSize).toBe(12);
    expect((out[1] as never)[NOTE].kind).toBe('endnote');
  });

  it('refuses a run with both footnote and endnote', () => {
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 'a' }, endnote: { content: 'b' } } as never], 12))
      .toThrow(TypeError);
  });
  it('refuses an empty or non-string mark', () => {
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 'a', mark: '' } } as never], 12)).toThrow(TypeError);
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 'a', mark: 7 } } as never], 12)).toThrow(TypeError);
  });
  it('refuses a FlowNote referenced twice, even across calls', () => {
    const n = { content: 'a' };
    lowerNotes([{ text: 'x', footnote: n } as never], 12);
    expect(() => lowerNotes([{ text: 'y', footnote: n } as never], 12)).toThrow(/once/);
  });
  it('refuses a note whose text body itself carries a note', () => {
    const inner = { content: 'deep' };
    expect(() => lowerNotes([{ text: 'x', footnote: { content: [{ text: 'n', footnote: inner }] } } as never], 12))
      .toThrow(/nest/);
  });
  it('refuses content that is neither text nor elements', () => {
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 42 } } as never], 12)).toThrow(TypeError);
    expect(() => lowerNotes([{ text: 'x', footnote: { content: [{}] } } as never], 12)).toThrow(TypeError);
  });
  it('validates everything before lowering anything', () => {
    const good = { content: 'ok' };
    expect(() => lowerNotes([{ text: 'a', footnote: good }, { text: 'b', footnote: { content: 'z', mark: '' } }] as never, 12))
      .toThrow(TypeError);
    // `good` was not consumed by the failed call:
    expect(() => lowerNotes([{ text: 'a', footnote: good } as never], 12)).not.toThrow();
  });
});

describe('refsIn / keptRefs', () => {
  it('finds refs in order, and carries them through a {...run} copy', () => {
    const out = lowerNotes([{ text: 'a', footnote: { content: '1' } }, { text: 'b', endnote: { content: '2' } }] as never, 12) as TextRun[];
    const refs = refsIn(out);
    expect(refs.map((r) => r.kind)).toEqual(['footnote', 'endnote']);
    const copy = out.map((r) => ({ ...r, text: r.text }));   // what sliceContent does
    expect(refsIn(copy)).toEqual(refs);
  });
  it('keptRefs is refs(text) minus refs(remainder), by identity', () => {
    const out = lowerNotes([{ text: 'a', footnote: { content: '1' } }, { text: 'b', footnote: { content: '2' } }] as never, 12) as TextRun[];
    const [r1, r2] = refsIn(out);
    expect(keptRefs(out, null)).toEqual([r1, r2]);
    expect(keptRefs(out, out.slice(2))).toEqual([r1]);
    expect(keptRefs(out, out)).toEqual([]);
    expect(refsIn('text')).toEqual([]);
  });
});

describe('formatMark', () => {
  it.each([
    [1, 'arabic', '1'], [12, 'arabic', '12'],
    [4, 'roman', 'iv'], [9, 'roman', 'ix'], [40, 'roman', 'xl'], [1994, 'Roman', 'MCMXCIV'],
    [1, 'alpha', 'a'], [26, 'alpha', 'z'], [27, 'alpha', 'aa'], [28, 'Alpha', 'BB'],
    [1, 'symbols', '*'], [6, 'symbols', '¶'], [7, 'symbols', '**'], [13, 'symbols', '***'],
  ] as const)('%i as %s is %s', (n, f, want) => {
    expect(formatMark(n, f)).toBe(want);
  });
});

describe('normalizeNoteOptions', () => {
  it('fills the spec defaults per kind', () => {
    const f = normalizeNoteOptions(undefined, 'footnote');
    expect(f).toMatchObject({ format: 'arabic', start: 1, markScale: 0.6, fontSize: 8, spacing: 4, newPage: false });
    expect(f.separator).toEqual({ width: undefined, thickness: 0.5, color: [0, 0, 0] });
    const e = normalizeNoteOptions(undefined, 'endnote');
    expect(e).toMatchObject({ format: 'roman', fontSize: 10 });
  });
  it('separator false means none', () => {
    expect(normalizeNoteOptions({ separator: false }, 'footnote').separator).toBeUndefined();
  });
  it.each([
    [{ format: 'greek' }], [{ start: 0 }], [{ start: 1.5 }], [{ markScale: 0 }], [{ markScale: 1.5 }],
    [{ fontSize: 0 }], [{ spacing: -1 }], [{ separator: { thickness: 0 } }],
    [{ separator: { color: [2, 0, 0] } }], [{ newPage: 'yes' }],
  ])('refuses %j', (o) => {
    expect(() => normalizeNoteOptions(o as never, 'endnote')).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flownotes-lower.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/flownotes.ts` (core section)**

Open with a module doc comment stating the purpose and the invariants this task establishes (the symbol key survives `{ ...run }`; numbering is NOT done here; `LOWERED` makes a `FlowNote` single-use). Then:

```ts
import type { FlowElement } from './flowelement.js';
import type { TextRun } from './textdecor.js';
import type { StructElement } from './struct.js';

export const NOTE: unique symbol = Symbol('flowNote');
export type NoteKind = 'footnote' | 'endnote';
export type NoteText = string | TextRun[];
export interface FlowNote { content: NoteText | FlowElement[]; mark?: string }
export interface FlowTextRun extends TextRun { footnote?: FlowNote; endnote?: FlowNote }
export interface MarkRun extends TextRun { [NOTE]: NoteRef }
export interface NoteRef { /* as in Interfaces */ }

export const MARK_RISE = 0.33;
export const GUTTER_GAP = 3;

/** A FlowNote is referenced once: a second reference would render it twice
 *  under two numbers. Module-wide, so reuse across flows is refused too. */
const LOWERED = new WeakSet<FlowNote>();

function isElementList(c: unknown): c is FlowElement[] {
  return Array.isArray(c) && c.length > 0
    && c.every((e) => typeof e === 'object' && e !== null && typeof (e as FlowElement).place === 'function');
}

function hasNote(r: TextRun): boolean {
  return (r as FlowTextRun).footnote !== undefined || (r as FlowTextRun).endnote !== undefined;
}

function checkNote(n: unknown, i: number, seen: Set<FlowNote>): asserts n is FlowNote {
  if (typeof n !== 'object' || n === null) throw new TypeError(`run ${i}: a note must be an object`);
  const note = n as FlowNote;
  if (note.mark !== undefined && (typeof note.mark !== 'string' || note.mark === ''))
    throw new TypeError(`run ${i}: note mark must be a non-empty string`);
  const c = note.content;
  if (typeof c === 'string') { /* ok */ }
  else if (Array.isArray(c) && c.every((r) => typeof r === 'object' && r !== null && typeof (r as TextRun).text === 'string')) {
    if ((c as TextRun[]).some(hasNote)) throw new TypeError(`run ${i}: notes do not nest — a note body may not reference a note`);
  } else if (isElementList(c)) {
    if (c.some((e) => (e.noteRefs?.().length ?? 0) > 0))
      throw new TypeError(`run ${i}: notes do not nest — a note body may not reference a note`);
  } else {
    throw new TypeError(`run ${i}: note content must be text, a run list, or FlowElements`);
  }
  if (LOWERED.has(note) || seen.has(note))
    throw new TypeError(`run ${i}: a FlowNote may be referenced only once`);
  seen.add(note);
}

export function lowerNotes(text: NoteText, blockSize: number): NoteText {
  if (typeof text === 'string' || !text.some(hasNote)) return text;
  const seen = new Set<FlowNote>();
  text.forEach((r, i) => {
    const fr = r as FlowTextRun;
    if (fr.footnote !== undefined && fr.endnote !== undefined)
      throw new TypeError(`run ${i}: a run may carry a footnote or an endnote, not both`);
    const n = fr.footnote ?? fr.endnote;
    if (n !== undefined) checkNote(n, i, seen);
  });
  const out: TextRun[] = [];
  for (const r of text) {
    const { footnote, endnote, ...body } = r as FlowTextRun;
    out.push(body);
    const note = footnote ?? endnote;
    if (note === undefined) continue;
    LOWERED.add(note);
    const markRun = { text: '', font: body.font, color: body.color, link: body.link } as MarkRun;
    // Drop undefined keys so the mark run states only what it inherits.
    for (const k of ['font', 'color', 'link'] as const) if (markRun[k] === undefined) delete markRun[k];
    const ref: NoteRef = {
      kind: footnote !== undefined ? 'footnote' : 'endnote',
      note, markRun, baseSize: body.fontSize ?? blockSize, mark: '', body: [],
    };
    markRun[NOTE] = ref;
    out.push(markRun);
  }
  return out;
}

export function refsIn(text: NoteText | null): NoteRef[] {
  if (text === null || typeof text === 'string') return [];
  const out: NoteRef[] = [];
  for (const r of text) { const ref = (r as Partial<MarkRun>)[NOTE]; if (ref !== undefined) out.push(ref); }
  return out;
}

export function keptRefs(text: NoteText, remainder: NoteText | null): NoteRef[] {
  const later = new Set(refsIn(remainder));
  return refsIn(text).filter((r) => !later.has(r));
}
```

`formatMark`: arabic `String(n)`; roman via the standard value/numeral table (`M CM D CD C XC L XL X IX V IV I`), lowercased for `'roman'`; alpha: letter `(n-1) % 26`, repeated `Math.floor((n-1)/26)+1` times (`aa`, `bb` — Word's convention, not spreadsheet columns); symbols: `SYMBOLS = ['*','†','‡','§','‖','¶']`, symbol `(n-1)%6` repeated `Math.floor((n-1)/6)+1` times.

`normalizeNoteOptions`: validate each field (`format` in the six; `start` positive integer; `markScale` in (0,1]; `fontSize` > 0 finite; `spacing` >= 0 finite; `separator` false/undefined/object with `width` > 0 finite when given, `thickness` > 0 finite, `color` checked as `[r,g,b]` in 0..1; `newPage` boolean, and only meaningful for endnotes but accepted for either). Defaults from Global Constraints; footnote `fontSize` 8, endnote 10; footnote format arabic, endnote roman.

`FlowElement.noteRefs` does not exist yet; reference it as `(e as { noteRefs?: () => NoteRef[] }).noteRefs` for now — Task 4 adds it to the interface and you then drop the cast.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/flownotes-lower.test.ts test/import-cycles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flownotes.ts test/flownotes-lower.test.ts
git commit -m "feat(v9j3.3): note lowering, references, mark formats, options"
```

---

### Task 3: Numbering and the `NoteElement` decorator

**Files:**
- Modify: `src/flownotes.ts`
- Test: `test/flownotes-number.test.ts` (create)

**Interfaces:**
- Consumes: Task 2's `NoteRef`, `ResolvedNoteOptions`, `formatMark`, `MARK_RISE`, `GUTTER_GAP`.
- Produces:

```ts
export type BodyMaker = (text: NoteText, fontSize: number) => FlowElement[];
export class NoteNumberer {
  constructor(foot: ResolvedNoteOptions, end: ResolvedNoteOptions, makeBody: BodyMaker);
  /** Number one ref (idempotent): sets mark, markRun.text/fontSize/rise, body. */
  assign(ref: NoteRef): void;
  /** Whether any ref was assigned. */
  readonly any: boolean;
}
export class NoteElement implements FlowElement { /* decorator, see below */ }
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/flownotes-number.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph } from '../src/flow.js';
import { lowerNotes, refsIn, normalizeNoteOptions, NoteNumberer, NoteElement } from '../src/flownotes.js';
import type { TextRun } from '../src/textdecor.js';

const mk = () => new NoteNumberer(
  normalizeNoteOptions(undefined, 'footnote'), normalizeNoteOptions(undefined, 'endnote'),
  (t, fontSize) => paragraph(t, { fontSize }));

function refsOf(runs: unknown[]) { return refsIn(lowerNotes(runs as TextRun[], 12)); }

describe('NoteNumberer', () => {
  it('numbers footnotes and endnotes in separate sequences, in order', () => {
    const n = mk();
    const [a, b, c] = refsOf([
      { text: 'a', footnote: { content: 'x' } }, { text: 'b', endnote: { content: 'y' } },
      { text: 'c', footnote: { content: 'z' } }]);
    for (const r of [a, b, c]) n.assign(r);
    expect([a.mark, b.mark, c.mark]).toEqual(['1', 'i', '2']);
    expect(n.any).toBe(true);
  });

  it('an explicit mark consumes no number', () => {
    const n = mk();
    const [a, b] = refsOf([{ text: 'a', footnote: { content: 'x', mark: '*' } }, { text: 'b', footnote: { content: 'y' } }]);
    n.assign(a); n.assign(b);
    expect([a.mark, b.mark]).toEqual(['*', '1']);
  });

  it('is idempotent per ref', () => {
    const n = mk();
    const [a, b] = refsOf([{ text: 'a', footnote: { content: 'x' } }, { text: 'b', footnote: { content: 'y' } }]);
    n.assign(a); n.assign(a); n.assign(b);
    expect(b.mark).toBe('2');
  });

  it('sizes and raises the mark run from the referencing run', () => {
    const n = mk();
    const [a] = refsIn(lowerNotes([{ text: 'a', fontSize: 10, footnote: { content: 'x' } }] as never, 12));
    n.assign(a);
    expect(a.markRun.text).toBe('1');
    expect(a.markRun.fontSize).toBeCloseTo(6, 9);
    expect(a.markRun.rise).toBeCloseTo(3.3, 9);
  });

  it('honours start and format', () => {
    const n = new NoteNumberer(normalizeNoteOptions({ start: 5, format: 'Alpha' }, 'footnote'),
      normalizeNoteOptions(undefined, 'endnote'), (t, s) => paragraph(t, { fontSize: s }));
    const [a] = refsOf([{ text: 'a', footnote: { content: 'x' } }]);
    n.assign(a);
    expect(a.mark).toBe('E');
  });

  it('builds a text body as NoteElements at the note font size; an element body wraps each element', () => {
    const n = mk();
    const els = [...paragraph('one'), ...paragraph('two')];
    const [a, b] = refsOf([{ text: 'a', footnote: { content: 'text body' } }, { text: 'b', footnote: { content: els } }]);
    n.assign(a); n.assign(b);
    expect(a.body.length).toBeGreaterThan(0);
    expect(a.body.every((e) => e instanceof NoteElement)).toBe(true);
    expect(b.body).toHaveLength(2);
    expect(b.body.every((e) => e instanceof NoteElement)).toBe(true);
  });
});

describe('NoteElement', () => {
  it('draws the mark once, in the gutter, and indents its body by the gutter', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const n = mk();
    const [a] = refsOf([{ text: 'a', footnote: { content: 'body text' } }]);
    n.assign(a);
    let top = 700;
    for (const el of a.body) {
      const r = el.place({ doc, page, x: 72, top, width: 300, availHeight: 200 });
      top -= r.usedHeight;
    }
    const frags = page.GetTextFragments();
    const mark = frags.find((f) => f.text === '1')!;
    const body = frags.find((f) => f.text.startsWith('body'))!;
    expect(mark.quad[0]).toBeCloseTo(72, 1);
    expect(body.quad[0]).toBeGreaterThan(mark.quad[2]);
    expect(frags.filter((f) => f.text === '1')).toHaveLength(1);
  });

  it('forwards measure to its child at the narrowed width', () => {
    const n = mk();
    const [a] = refsOf([{ text: 'a', footnote: { content: 'word '.repeat(60) } }]);
    n.assign(a);
    const el = a.body[0];
    const wide = el.measure!({ width: 400, availHeight: 1e6 }).usedHeight;
    const narrow = el.measure!({ width: 150, availHeight: 1e6 }).usedHeight;
    expect(narrow).toBeGreaterThan(wide);
  });

  it('a continuation draws no second mark', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const n = mk();
    const [a] = refsOf([{ text: 'a', footnote: { content: 'word '.repeat(200) } }]);
    n.assign(a);
    const r1 = a.body[0].place({ doc, page, x: 72, top: 700, width: 300, availHeight: 30 });
    expect(r1.remainder).not.toBeNull();
    r1.remainder!.place({ doc, page, x: 72, top: 400, width: 300, availHeight: 30 });
    expect(page.GetTextFragments().filter((f) => f.text === '1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flownotes-number.test.ts`
Expected: FAIL — `NoteNumberer` not exported.

- [ ] **Step 3: Implement**

In `src/flownotes.ts` add value imports `insetScale` (flowelement.js), `stampText`, `measureText` and type `AuthoringFont` (stamp.js), type `Compromise`, `MeasureContext`, `PlaceContext`, `PlaceResult` (flowelement.js).

```ts
export type BodyMaker = (text: NoteText, fontSize: number) => FlowElement[];

/** Shared by every NoteElement one note lowers to — the list-item marker
 *  pattern: whichever decorator draws FIRST paints the mark. */
interface NoteHolder {
  ref: NoteRef;
  gutter: number;
  markSize: number;
  fontSize: number;
  drawn: boolean;
  lbl?: StructElement;
}

export class NoteNumberer {
  private next: Record<NoteKind, number>;
  private assigned = false;
  constructor(
    private readonly foot: ResolvedNoteOptions,
    private readonly end: ResolvedNoteOptions,
    private readonly makeBody: BodyMaker,
  ) { this.next = { footnote: foot.start, endnote: end.start }; }

  get any(): boolean { return this.assigned; }

  assign(ref: NoteRef): void {
    if (ref.mark !== '') return;
    const o = ref.kind === 'footnote' ? this.foot : this.end;
    ref.mark = ref.note.mark ?? formatMark(this.next[ref.kind]++, o.format);
    ref.markRun.text = ref.mark;
    ref.markRun.fontSize = ref.baseSize * o.markScale;
    ref.markRun.rise = ref.baseSize * MARK_RISE;
    const c = ref.note.content;
    const els = typeof c === 'string' || !isElementList(c) ? this.makeBody(c as NoteText, o.fontSize) : c;
    const markSize = o.fontSize * o.markScale;
    const holder: NoteHolder = {
      ref, markSize, fontSize: o.fontSize, drawn: false,
      gutter: measureText(ref.mark, markSize, 'Helvetica') + GUTTER_GAP,
    };
    ref.body = els.map((e, i) => new NoteElement(e, holder,
      (i === 0 ? o.spacing : 0) + (e.spaceBefore ?? 0), e.spaceAfter ?? 0));
    this.assigned = true;
  }
}

export class NoteElement implements FlowElement {
  constructor(
    private readonly inner: FlowElement,
    private readonly h: NoteHolder,
    readonly spaceBefore: number,
    readonly spaceAfter: number,
  ) {}

  get onCompromise(): ((how: Compromise) => void) | undefined { return this.inner.onCompromise; }
  set onCompromise(fn: ((how: Compromise) => void) | undefined) { this.inner.onCompromise = fn; }

  /** ONE definition read by measure and place (the e1bp floor). */
  private indentFor(width: number): number { return this.h.gutter * insetScale(width, this.h.gutter); }

  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const indent = this.indentFor(ctx.width);
    return this.inner.measure?.({ width: ctx.width - indent, availHeight: ctx.availHeight })
      ?? { usedHeight: 0, fits: false };
  }

  place(ctx: PlaceContext): PlaceResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, remainder: this, drew: false };
    const note = this.h.ref.noteTag;
    // /Lbl before the body's nodes, so the /Note reads mark-then-text.
    if (note !== undefined && this.h.lbl === undefined && !this.h.drawn) this.h.lbl = note.Append('Lbl');
    const indent = this.indentFor(ctx.width);
    const res = this.inner.place({
      ...ctx, x: ctx.x + indent, width: ctx.width - indent,
      structParent: note ?? ctx.structParent,
    });
    if (res.drew && !this.h.drawn) {
      stampText(ctx.doc, ctx.page, this.h.ref.mark, ctx.x,
        ctx.top - this.h.fontSize + this.h.fontSize * MARK_RISE,
        { font: 'Helvetica', fontSize: this.h.markSize, ...(this.h.lbl ? { tag: this.h.lbl } : {}) });
      this.h.drawn = true;
    }
    if (res.drew && indent < this.h.gutter) this.onCompromise?.('squeezed');
    return {
      usedHeight: res.usedHeight,
      drew: res.drew,
      remainder: res.remainder === null ? null : new NoteElement(res.remainder, this.h, 0, this.spaceAfter),
    };
  }

  noteRefs(): NoteRef[] { return []; }   // nesting is refused at lowering
}
```

Check `stampText`'s signature in `src/stamp.ts` (~line 290) and adapt the call (it takes `(doc, page, text, x, y, options)`).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/flownotes-number.test.ts test/flownotes-lower.test.ts test/import-cycles.test.ts`
Expected: PASS. If `import-cycles` reports `flownotes ↔ flow` you value-imported flow.ts — the test file may import `paragraph` from flow.ts, `src/flownotes.ts` must not.

- [ ] **Step 5: Commit**

```bash
git add src/flownotes.ts test/flownotes-number.test.ts
git commit -m "feat(v9j3.3): note numbering and the NoteElement decorator"
```

---

### Task 4: The protocol — `noteRefs()`, `measure().notes`, builders lower

**Files:**
- Modify: `src/flowelement.ts` (`FlowElement`, `measure` return type)
- Modify: `src/flow.ts` (`FlowText` type ~line 162, `TextElement` ~290, `paragraph`/`heading` ~412-440, `ListItemElement` ~685, `ListBlockElement` ~795, list item construction in `buildListElements` ~1074; re-export the note types)
- Modify: `src/flowblock.ts` (`QuotedElement` ~329, `IndentElement` ~428)
- Modify: `src/cssframe.ts` (`BoxElement` ~83)
- Modify: `src/flowplace.ts` (`placeElements` ~41)
- Modify: `src/index.ts` (export `FlowNote`, `FlowTextRun`, `FlowNoteOptions`, `FlowEndnoteOptions` as types beside `FlowText`)
- Test: `test/flow-notes-protocol.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 (`lowerNotes`, `refsIn`, `keptRefs`, `NoteRef`, `FlowTextRun`).
- Produces:

```ts
// flowelement.ts
export interface MeasureResult { usedHeight: number; fits: boolean; notes?: readonly NoteRef[] }
interface FlowElement {
  measure?(ctx: MeasureContext): MeasureResult;
  /** Every note reference this element (and anything it wraps) carries, in
   *  reading order, whatever the budget. Absent means none. */
  noteRefs?(): NoteRef[];
}
// flow.ts
export type FlowText = string | FlowTextRun[];
```

TextElement and ListItemElement set `ref.owner` on each kept ref when they draw (`this.tag` / `this.state.lbody`).

- [ ] **Step 1: Write the failing tests**

```ts
// test/flow-notes-protocol.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph, heading, list, quote } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { NoteNumberer, normalizeNoteOptions } from '../src/flownotes.js';

const fn = (t: string) => ({ footnote: { content: t } });
const words = (n: number) => 'word '.repeat(n);
function numberAll(els: { noteRefs?: () => unknown[] }[]) {
  const nb = new NoteNumberer(normalizeNoteOptions(undefined, 'footnote'),
    normalizeNoteOptions(undefined, 'endnote'), (t, s) => paragraph(t, { fontSize: s }));
  for (const e of els) for (const r of (e.noteRefs?.() ?? []) as never[]) nb.assign(r);
}

describe('noteRefs', () => {
  it('a paragraph reports its refs; a note-free paragraph reports none', () => {
    const [p] = paragraph([{ text: 'a', ...fn('x') }, { text: ' b', ...fn('y') }]);
    expect(p.noteRefs!().map((r) => r.note.content)).toEqual(['x', 'y']);
    expect(paragraph('plain')[0].noteRefs?.() ?? []).toEqual([]);
  });
  it('headings, list items, list blocks, quotes and indents forward', () => {
    expect(heading(2, [{ text: 'H', ...fn('h') }])[0].noteRefs!()).toHaveLength(1);
    const l = list([{ text: [{ text: 'item', ...fn('i') }], blocks: paragraph([{ text: 'blk', ...fn('b') }]) }]);
    expect(l.flatMap((e) => e.noteRefs?.() ?? [])).toHaveLength(2);
    expect(quote(paragraph([{ text: 'q', ...fn('q') }]))[0].noteRefs!()).toHaveLength(1);
    expect(paragraph([{ text: 'i', ...fn('i') }], { indent: { left: 10 } })[0].noteRefs!()).toHaveLength(1);
  });
});

describe('measure().notes', () => {
  it('reports only the refs in the content that would be kept', () => {
    const [p] = paragraph([{ text: words(40) }, { text: 'early', ...fn('e') }, { text: words(400) }, { text: 'late', ...fn('l') }]);
    numberAll([p]);
    const part = p.measure!({ width: 300, availHeight: 60 });
    expect(part.fits).toBe(false);
    expect(part.notes!.map((r) => r.note.content)).toEqual(['e']);
    const all = p.measure!({ width: 300, availHeight: 1e6 });
    expect(all.notes!.map((r) => r.note.content)).toEqual(['e', 'l']);
  });
  it('omits notes for a note-free element', () => {
    expect(paragraph('plain')[0].measure!({ width: 300, availHeight: 100 }).notes).toBeUndefined();
  });
});

describe('placeElements', () => {
  it('refuses an element carrying note references', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    expect(() => placeElements(doc, page, paragraph([{ text: 'a', ...fn('x') }]), [72, 72, 300, 600]))
      .toThrow(UnsupportedFeatureError);
  });
});

describe('a reference with empty text', () => {
  it('lowers to a bare mark that still reports its note', () => {
    const [p] = paragraph([{ text: '', ...fn('lonely') }]);
    numberAll([p]);
    expect(p.measure!({ width: 300, availHeight: 100 }).notes).toHaveLength(1);
    const doc = Document.New();
    const page = doc.AddPage().page;
    expect(p.place({ doc, page, x: 72, top: 700, width: 300, availHeight: 100 }).drew).toBe(true);
    expect(page.GetText()).toContain('1');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flow-notes-protocol.test.ts`
Expected: FAIL — `noteRefs` undefined; placeElements does not throw.

- [ ] **Step 3: Implement**

`src/flowelement.ts`: add `import type { NoteRef } from './flownotes.js';`, the `MeasureResult` interface, change `measure?` to return `MeasureResult`, add `noteRefs?(): NoteRef[];` with a doc comment ("Every note reference this element carries… Containers forward their child's; only text elements originate one. Absent means none.").

`src/flow.ts`:
- `import { lowerNotes, refsIn, keptRefs, type FlowTextRun, type NoteRef } from './flownotes.js';` and re-export types: `export type { FlowNote, FlowTextRun, FlowNoteOptions, FlowEndnoteOptions } from './flownotes.js';`.
- `export type FlowText = string | FlowTextRun[];`
- `TextElement`:

```ts
  noteRefs(): NoteRef[] { return refsIn(this.text); }

  measure(ctx: MeasureContext): MeasureResult {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false };
    const { usedHeight, remainder } = measureFlowText(this.text, ctx.width, ctx.availHeight, this.scaled(ctx.indentScale));
    const notes = keptRefs(this.text, remainder);
    return notes.length > 0 ? { usedHeight, fits: remainder === null, notes } : { usedHeight, fits: remainder === null };
  }
```

and in `place`, after the `usedHeight === 0` early return: `for (const r of keptRefs(this.text, remainder)) r.owner = this.tag;`.
- `paragraph()`: compute `const size = o.fontSize ?? 12;` and pass `lowerNotes(text, size)` instead of `text` to `forFirstLine` (keep `reportCoverage(text, …)` on the raw text). `heading()`: same with `withDefaults.fontSize!`.
- `ListItemElement`: `noteRefs()` returns `refsIn(this.text)`; `measure` adds `notes` exactly as `TextElement`; `place` sets `r.owner = this.state.lbody` for kept refs after the `usedHeight === 0` return.
- In `buildListElements` where `new ListItemElement(p.item.text, …)` is constructed, pass `lowerNotes(p.item.text, p.opts.fontSize)`.
- `ListBlockElement`: `noteRefs() { return this.inner.noteRefs?.() ?? []; }`; `measure` returns the inner result (already forwards the object; keep `notes` by returning `this.inner.measure?.(...)` unchanged).

`src/flowblock.ts` `QuotedElement` and `IndentElement`: add `noteRefs(): NoteRef[] { return this.inner.noteRefs?.() ?? []; }` (type import of `NoteRef`), and type `measure` as returning `MeasureResult` — they already return the inner object, which carries `notes`.

`src/cssframe.ts` `BoxElement`: add the same `noteRefs()`; in `measure`, carry `notes: m.notes` into both returned objects when defined.

`src/flowplace.ts` `placeElements`, after the argument checks:

```ts
  // A single rect has no column foot and no next column: a footnote placed
  // here would have nowhere honest to go (v9j3.3 scope). Refuse rather than drop.
  if (elements.some((e) => (e.noteRefs?.().length ?? 0) > 0))
    throw new UnsupportedFeatureError('footnotes and endnotes are supported only by Flow.Render, not by a single-rect placement');
```

Note: `NoteElement` (footnote area painting, Task 5) returns `[]`, so it passes this check. `src/flownotes.ts` (Task 2) can now drop its `noteRefs` cast.

`src/index.ts`: add the four types to the existing flow type export.

- [ ] **Step 4: Run to verify they pass, plus the fences**

Run: `npx vitest run test/flow-notes-protocol.test.ts test/flow.test.ts test/flow-blocks.test.ts test/flowplace-floats.test.ts test/rich-runs-identity.test.ts test/markdown-flow.test.ts test/html-identity.test.ts test/import-cycles.test.ts`
Then: `npm run typecheck`
Expected: PASS. `test/readme-api.test.ts` will FAIL until Task 9 adds the README rows — that is expected here; note it and move on.

- [ ] **Step 5: Commit**

```bash
git add src/flowelement.ts src/flow.ts src/flowblock.ts src/cssframe.ts src/flowplace.ts src/flownotes.ts src/index.ts test/flow-notes-protocol.test.ts
git commit -m "feat(v9j3.3): note references in the element protocol"
```

---

### Task 5: `NoteColumn` and `settleBudget` (pure)

**Files:**
- Modify: `src/flownotes.ts`
- Test: `test/flownotes-column.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2-3; `placeElements`/`measureElements` (flowplace.js), `fillRect`, `paintDecoration` (flowblock.js).
- Produces:

```ts
export interface Probe { usedHeight: number; notes?: readonly NoteRef[] }
export type Settled = { budget: number; refs: NoteRef[] } | 'advance';
/** Lower `budget` until the kept content plus its footnotes fit in `room`. */
export function settleBudget(
  measure: (budget: number) => Probe, budget: number, room: number,
  footHeightWith: (refs: NoteRef[]) => number, atColumnStart: boolean,
): Settled;
export class NoteColumn {
  constructor(opts: ResolvedNoteOptions, width: number);
  readonly empty: boolean;                     // no carry and nothing committed
  footHeight(extra?: readonly NoteRef[]): number;
  commit(refs: readonly NoteRef[]): void;      // footnote refs only
  /** Paint at column close; leaves the unpainted remainder as carry. */
  paint(args: { doc: Document; page: Page; x: number; penY: number; contentBottom: number;
    structParent?: StructElement; columnEmpty: boolean }): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/flownotes-column.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph } from '../src/flow.js';
import {
  settleBudget, NoteColumn, NoteNumberer, normalizeNoteOptions, lowerNotes, refsIn,
  type NoteRef,
} from '../src/flownotes.js';

const foot = normalizeNoteOptions(undefined, 'footnote');
function makeRefs(bodies: string[]): NoteRef[] {
  const runs = bodies.map((b, i) => ({ text: `w${i} `, footnote: { content: b } }));
  const refs = refsIn(lowerNotes(runs as never, 12));
  const nb = new NoteNumberer(foot, normalizeNoteOptions(undefined, 'endnote'), (t, s) => paragraph(t, { fontSize: s }));
  refs.forEach((r) => nb.assign(r));
  return refs;
}

describe('NoteColumn.footHeight', () => {
  it('is 0 with no notes and spacing + separator + stacked body otherwise', () => {
    const col = new NoteColumn(foot, 300);
    expect(col.footHeight()).toBe(0);
    const [a] = makeRefs(['short note']);
    const h = col.footHeight([a]);
    expect(h).toBeGreaterThan(4 + 0.5);
    col.commit([a]);
    expect(col.footHeight()).toBeCloseTo(h, 9);
    expect(col.empty).toBe(false);
  });
});

describe('settleBudget', () => {
  // A stub: content kept grows with the budget; a ref is kept once 50pt is.
  const ref = { kind: 'footnote' } as NoteRef;
  const measure = (b: number) => ({ usedHeight: Math.floor(b / 10) * 10, notes: b >= 50 ? [ref] : [] });

  it('leaves the budget alone when no footnote is kept', () => {
    expect(settleBudget(measure, 40, 100, () => 30, false)).toEqual({ budget: 40, refs: [] });
  });
  it('lowers the budget by the note room and keeps the ref when it still fits', () => {
    const s = settleBudget(measure, 100, 100, (rs) => (rs.length ? 30 : 0), false);
    expect(s).toEqual({ budget: 70, refs: [ref] });
  });
  it('advances mid-column when the ref and its note cannot share the column', () => {
    expect(settleBudget(measure, 100, 100, (rs) => (rs.length ? 80 : 0), false)).toBe('advance');
  });
  it('at a column start bisects to the smallest budget that keeps a line', () => {
    const s = settleBudget(measure, 100, 100, (rs) => (rs.length ? 80 : 0), true);
    expect(s).not.toBe('advance');
    if (s !== 'advance') { expect(s.budget).toBeGreaterThanOrEqual(10); expect(s.budget).toBeLessThan(20); }
  });
  it('terminates on a budget that only ever shrinks', () => {
    let calls = 0;
    const grow = (b: number) => { calls++; return { usedHeight: b, notes: Array.from({ length: Math.floor(b) }, () => ref) }; };
    settleBudget(grow, 100, 100, (rs) => rs.length * 0.9, false);
    expect(calls).toBeLessThan(200);
  });
  it('ignores endnote refs when reserving room but returns them', () => {
    const en = { kind: 'endnote' } as NoteRef;
    const m = (b: number) => ({ usedHeight: b, notes: [en] });
    expect(settleBudget(m, 60, 100, () => 999, false)).toEqual({ budget: 60, refs: [en] });
  });
});

describe('NoteColumn.paint', () => {
  it('paints a separator and the notes at the column foot, nothing left over', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const col = new NoteColumn(foot, 300);
    const refs = makeRefs(['first note', 'second note']);
    col.commit(refs);
    col.paint({ doc, page, x: 72, penY: 600, contentBottom: 72, columnEmpty: false });
    expect(col.empty).toBe(true);
    const frags = page.GetTextFragments();
    const first = frags.find((f) => f.text.startsWith('first'))!;
    const second = frags.find((f) => f.text.startsWith('second'))!;
    expect(first.quad[1]).toBeGreaterThan(second.quad[1]);      // note 1 above note 2
    expect(second.quad[1]).toBeGreaterThanOrEqual(72 - 1e-6);
    expect(new TextDecoder('latin1').decode(page.Contents)).toMatch(/ re\nf/);   // the rule
  });
  it('carries what does not fit into the next column, painting it first there', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const col = new NoteColumn(foot, 300);
    col.commit(makeRefs(['word '.repeat(600)]));
    col.paint({ doc, page, x: 72, penY: 150, contentBottom: 72, columnEmpty: false });
    expect(col.empty).toBe(false);
    const page2 = doc.AddPage().page;
    col.paint({ doc, page: page2, x: 72, penY: 770, contentBottom: 72, columnEmpty: true });
    expect(page2.GetText()).toContain('word');
  });
  it('draws an unsplittable piece taller than an empty column past the bottom rather than looping', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const col = new NoteColumn(foot, 300);
    const [r] = makeRefs(['x']);
    const tall = { measure: () => ({ usedHeight: 2000, fits: true }),
      place: (c: { availHeight: number }) => c.availHeight >= 2000
        ? { usedHeight: 2000, remainder: null, drew: true } : { usedHeight: 0, remainder: tall, drew: false } } as never;
    r.body = [tall];
    col.commit([r]);
    col.paint({ doc, page, x: 72, penY: 770, contentBottom: 72, columnEmpty: true });
    expect(col.empty).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flownotes-column.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
const BISECT_STEPS = 30;
const BISECT_TOL = 0.01;
const OVERFLOW_PROBE = 1e6;

export function settleBudget(
  measure: (budget: number) => Probe, budget: number, room: number,
  footHeightWith: (refs: NoteRef[]) => number, atColumnStart: boolean,
): Settled {
  const feet = (p: Probe) => (p.notes ?? []).filter((r) => r.kind === 'footnote');
  let a = budget;
  let p = measure(a);
  if (p.usedHeight <= 0) return { budget, refs: [] };     // the engine's normal no-fit path
  for (;;) {
    const fr = feet(p);
    if (fr.length === 0) return { budget: a, refs: [...(p.notes ?? [])] };
    const a2 = Math.min(a, room - footHeightWith(fr));
    if (a2 >= a - 1e-9) return { budget: a, refs: [...(p.notes ?? [])] };
    a = a2;
    if (a <= 0) break;
    p = measure(a);
    if (p.usedHeight <= 0) break;
  }
  // Collapsed: the content and its WHOLE notes cannot share this column.
  if (!atColumnStart) return 'advance';
  let lo = 0, hi = budget;                                 // measure(hi).usedHeight > 0
  for (let i = 0; i < BISECT_STEPS && hi - lo > BISECT_TOL; i++) {
    const mid = (lo + hi) / 2;
    if (measure(mid).usedHeight > 0) hi = mid; else lo = mid;
  }
  return { budget: hi, refs: [...(measure(hi).notes ?? [])] };
}
```

`NoteColumn`:

```ts
export class NoteColumn {
  private carry: FlowElement[] = [];
  private committed: FlowElement[] = [];
  constructor(private readonly opts: ResolvedNoteOptions, private readonly width: number) {}

  get empty(): boolean { return this.carry.length === 0 && this.committed.length === 0; }
  private get sepH(): number { return this.opts.separator?.thickness ?? 0; }

  footHeight(extra: readonly NoteRef[] = []): number {
    const els = [...this.carry, ...this.committed, ...extra.flatMap((r) => r.body)];
    if (els.length === 0) return 0;
    return this.opts.spacing + this.sepH + measureElements(els, this.width);
  }

  commit(refs: readonly NoteRef[]): void {
    for (const r of refs) if (r.kind === 'footnote') this.committed.push(...r.body);
  }

  paint(a: { doc: Document; page: Page; x: number; penY: number; contentBottom: number;
    structParent?: StructElement; columnEmpty: boolean }): void {
    if (this.empty) return;
    const els = [...this.carry, ...this.committed];
    this.carry = []; this.committed = [];
    const areaH = Math.min(this.opts.spacing + this.sepH + measureElements(els, this.width),
      a.penY - a.contentBottom);
    const ruleTop = a.contentBottom + areaH - this.opts.spacing;
    const ctx = { doc: a.doc, page: a.page, x: a.x, top: ruleTop, width: this.width,
      availHeight: areaH, structParent: a.structParent };
    const sep = this.opts.separator;
    if (sep !== undefined)
      paintDecoration(ctx, fillRect(a.x, ruleTop - sep.thickness,
        Math.min(sep.width ?? this.width / 3, this.width), sep.thickness, sep.color));
    const h = ruleTop - this.sepH - a.contentBottom;
    let rest = els;
    if (h > 0) {
      const r = placeElements(a.doc, a.page, els, [a.x, a.contentBottom, this.width, h],
        { structParent: a.structParent });
      rest = r.remainder;
      if (r.usedHeight === 0 && rest.length > 0 && a.columnEmpty) rest = this.overflow(rest, a, ruleTop - this.sepH);
    } else if (a.columnEmpty) {
      rest = this.overflow(rest, a, ruleTop - this.sepH);
    }
    this.carry = rest;
  }

  /** An unsplittable piece taller than an empty column: drawn at its natural
   *  height past the bottom (the main loop's zch2.16 rule) so carry terminates. */
  private overflow(els: FlowElement[], a: { doc: Document; page: Page; x: number;
    structParent?: StructElement }, top: number): FlowElement[] {
    const [first, ...more] = els;
    first.onCompromise?.('overflow');
    const natural = first.measure?.({ width: this.width, availHeight: OVERFLOW_PROBE })?.usedHeight ?? OVERFLOW_PROBE;
    const res = first.place({ doc: a.doc, page: a.page, x: a.x, top, width: this.width,
      availHeight: natural > 0 ? natural : OVERFLOW_PROBE, structParent: a.structParent });
    return res.remainder === null ? more : [res.remainder, ...more];
  }
}
```

Check `placeElements`' option names (`structParent`, `paragraphSpacing`) against `src/flowplace.ts`. Check that importing `flowblock.js` from `flownotes.ts` closes no cycle (`flowblock.ts` must only TYPE-import flownotes).

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/flownotes-column.test.ts test/import-cycles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flownotes.ts test/flownotes-column.test.ts
git commit -m "feat(v9j3.3): NoteColumn and the budget-settling loop"
```

---

### Task 6: Footnotes in `Flow.Render`

**Files:**
- Modify: `src/flow.ts` (`FlowOptions` ~58, `Flow` constructor ~1307, `Render` ~1507)
- Test: `test/flow-footnotes.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 2-5.
- Produces: `FlowOptions.footnotes?: FlowNoteOptions`, `FlowOptions.endnotes?: FlowEndnoteOptions` (validated in the constructor through `normalizeNoteOptions`). Endnote placement is Task 7; here endnote refs are only collected into a local list.

- [ ] **Step 1: Write the failing tests**

```ts
// test/flow-footnotes.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const fn = (content: unknown, mark?: string) => ({ footnote: { content, ...(mark ? { mark } : {}) } }) as never;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function pageOf(pages: { GetText(): string }[], needle: string): number {
  return pages.findIndex((p) => p.GetText().includes(needle));
}

describe('footnotes', () => {
  it('places the note on the same page as its reference, below the body text', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'A claim' }, { text: '', ...fn('Source: the archive.') }, { text: ' continues.' }]);
    const [p] = flow.Render();
    const frags = p.GetTextFragments();
    const body = frags.find((f) => f.text.includes('claim'))!;
    const note = frags.find((f) => f.text.includes('Source'))!;
    expect(note.quad[1]).toBeLessThan(body.quad[1]);
    expect(note.quad[1]).toBeGreaterThanOrEqual(72 - 1e-6);
    expect(note.quad[1]).toBeLessThan(200);                      // at the foot, not after the text
  });

  it('a flow without notes renders byte-identically to before', () => {
    // Page content, not Save(): Save() writes a fresh random /ID per document.
    const a = Document.New().NewFlow().AddParagraph(words(300)).Render();
    const b = Document.New().NewFlow({ footnotes: { fontSize: 9 } }).AddParagraph(words(300)).Render();
    expect(b).toHaveLength(a.length);
    a.forEach((p, i) => expect(Buffer.from(b[i].Contents).equals(Buffer.from(p.Contents))).toBe(true));
  });

  it('moves a reference line to the next page when its note cannot fit below it', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph(words(560));                                  // fills most of page 1
    flow.AddParagraph([{ text: 'REF' }, { text: '', ...fn(words(120)) }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'REF')).toBe(pageOf(pages, 'w119'));
  });

  it('splits a note taller than a column across pages, continuing under a separator', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'Start' }, { text: '', ...fn(words(2500)) }]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pageOf(pages, 'Start')).toBe(0);
    expect(pageOf(pages, 'w0 ')).toBe(0);                            // the note STARTS on the ref's page
    expect(pages[pages.length - 1].GetText()).toContain('w2499');   // and is drawn to the end
  });

  it('drains a very long note after the last element (Review Focus 3)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2 });
    flow.AddParagraph([{ text: 'Only' }, { text: '', ...fn(words(9000)) }]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[pages.length - 1].GetText()).toContain('w8999');
  });

  it('stacks many notes from one line in reference order (Review Focus 1)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    const runs = Array.from({ length: 8 }, (_, i) => [{ text: ` s${i}` }, { text: '', ...fn(`NOTE${i}`) }]).flat();
    flow.AddParagraph(runs as never);
    const [p] = flow.Render();
    const ys = Array.from({ length: 8 }, (_, i) => p.GetTextFragments().find((f) => f.text.includes(`NOTE${i}`))!.quad[1]);
    for (let i = 1; i < 8; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
  });

  it('two columns: each column carries its own notes', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2, columnGap: 18 });
    flow.AddParagraph([{ text: 'LEFT' }, { text: '', ...fn('Left note') }]);
    flow.AddColumnBreak();
    flow.AddParagraph([{ text: 'RIGHT' }, { text: '', ...fn('Right note') }]);
    const [p] = flow.Render();
    const f = p.GetTextFragments();
    const mid = PageFormat.A4.width / 2;
    expect(f.find((x) => x.text.includes('Left note'))!.quad[0]).toBeLessThan(mid);
    expect(f.find((x) => x.text.includes('Right note'))!.quad[0]).toBeGreaterThan(mid);
  });

  it('numbers continuously across pages and honours an explicit mark', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', ...fn('n-a') }]);
    flow.AddParagraph([{ text: 'b' }, { text: '', ...fn('n-b', '†') }]);
    flow.AddColumnBreak();
    flow.AddParagraph([{ text: 'c' }, { text: '', ...fn('n-c') }]);
    const pages = flow.Render();
    expect(pages[1].GetTextFragments().some((x) => x.text === '2')).toBe(true);
  });

  it('a float never overlaps the foot area', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'R' }, { text: '', ...fn(words(150)) }]);
    const box = doc.NewFloatingBox({ width: 150 });
    box.AddParagraph(words(220));
    flow.AddFloatBox(box, 'right');
    const pages = flow.Render();
    const noteTop = Math.max(...pages[0].GetTextFragments()
      .filter((x) => x.fontSize < 8.5 && x.quad[1] < 400).map((x) => x.quad[3]));
    const floatBottom = Math.min(...pages[0].GetTextFragments()
      .filter((x) => x.quad[0] > 300 && x.fontSize > 8.5).map((x) => x.quad[1]));
    expect(floatBottom).toBeGreaterThan(noteTop);
  });

  it('keep-with-next sees the foot-reduced bottom (Review Focus 5)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph(words(540));
    flow.AddHeading(2, 'KEPT');
    flow.AddParagraph([{ text: 'body' }, { text: '', ...fn(words(90)) }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'KEPT')).toBe(pageOf(pages, 'body'));
  });

  it('refuses a float whose content carries a reference', () => {
    // elementFloat content is only reachable through AddHtml today; build it directly.
    // Skip if the test cannot construct one without the CSS stack: assert via a
    // hand-built FlowElement carrying `float` and `noteRefs`.
    const doc = Document.New();
    const flow = doc.NewFlow();
    const el = { float: { side: 'left', content: { width: 50, spacing: 0, measure: () => 10, paintAt: () => 10 } },
      noteRefs: () => [{ kind: 'footnote' }], place: () => ({ usedHeight: 0, remainder: null, drew: false }) };
    flow.AddElements([el as never]);
    expect(() => flow.Render()).toThrow(UnsupportedFeatureError);
  });

  it('validates note options in the constructor', () => {
    expect(() => Document.New().NewFlow({ footnotes: { fontSize: -1 } })).toThrow(TypeError);
  });
});
```

Check `NewFloatingBox`/`AddFloatBox` names and option shapes in `src/document.ts`/`src/flow.ts` before running and adapt.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flow-footnotes.test.ts`
Expected: FAIL — notes are drawn inline nowhere (bodies never placed) and options are unknown.

- [ ] **Step 3: Implement**

`FlowOptions`: add `footnotes?: FlowNoteOptions;` and `endnotes?: FlowEndnoteOptions;` with doc comments (defaults from the spec). Constructor: `this.footOpts = normalizeNoteOptions(options?.footnotes, 'footnote'); this.endOpts = normalizeNoteOptions(options?.endnotes, 'endnote');` (private readonly fields).

`Render`, at the top after `queue` is built:

```ts
    // Number every note once, in queue (= Add) order, before anything is
    // measured — so a mark's width never changes after a line was measured.
    const numberer = new NoteNumberer(this.footOpts, this.endOpts,
      (t, fontSize) => paragraph(t, { fontSize }));
    for (const it of queue) {
      if (isBreak(it)) continue;
      const refs = (it as FlowElement).noteRefs?.() ?? [];
      if (refs.length > 0 && floatOf(it) !== undefined)
        throw new UnsupportedFeatureError('footnotes inside a float are not supported');
      for (const r of refs) numberer.assign(r);
    }
    const notes = numberer.any ? new NoteColumn(this.footOpts, g.columnWidth) : undefined;
    const endnoteRefs: NoteRef[] = [];
    const effBottom = (): number => g.contentBottom + (notes?.footHeight() ?? 0);
    const closeColumn = (): void => {
      if (notes === undefined || notes.empty) return;
      notes.paint({ doc: this.doc, page: ensurePage(pageIdx), x: columnX(g, col), penY: colTop,
        contentBottom: g.contentBottom, structParent, columnEmpty: atColumnStart });
    };
```

`advanceColumn` calls `closeColumn()` as its FIRST statement.

Replace `g.contentBottom` with `effBottom()` at: the float fit test (`boxTop - h >= …`), the `splitPaint` budget (`boxTop - …`), `availHeight` (both arms: `besideFloat ? Math.min(top - boundary, top - effBottom()) : top - effBottom()`), and keep-with-next `remaining`. Leave the OVERFLOW path alone.

Right after `availHeight` is computed (before the `elemWidth <= 0` check), add:

```ts
      // Footnotes (or carry) fill what is left of this column: content waits.
      if (notes !== undefined && top - effBottom() <= 0) { advanceColumn(); continue; }
```

Before `const page = ensurePage(pageIdx);` add the probe:

```ts
      let budget = availHeight;
      let placedRefs: NoteRef[] = [];
      if (notes !== undefined && item2.measure !== undefined) {
        const s = settleBudget(
          (b) => item2.measure!({ width: elemWidth, availHeight: b }),
          availHeight, top - g.contentBottom, (rs) => notes.footHeight(rs), atColumnStart);
        if (s === 'advance') { advanceColumn(); continue; }
        budget = s.budget;
        placedRefs = s.refs;
      }
```

and pass `availHeight: budget` to `item2.place(...)`. In the `res.drew` branch, before `continue`:

```ts
        if (placedRefs.length > 0) {
          notes!.commit(placedRefs);
          for (const r of placedRefs) if (r.kind === 'endnote') endnoteRefs.push(r);
        }
```

(Task 8 adds the tagging commit here.) Note `settleBudget` returning a smaller budget than `availHeight` makes the element leave a remainder → the existing remainder branch advances the column, which is exactly what we want.

At the end, replace `if (pages.length === 0) ensurePage(0);` with:

```ts
    closeColumn();
    // Carry left after the last element: keep opening columns until it drains.
    // Every column paints some carry (NoteColumn.paint's overflow rule), so this ends.
    while (notes !== undefined && !notes.empty) {
      col++; if (col >= g.columns) { col = 0; pageIdx++; }
      colTop = g.contentTop; atColumnStart = true;
      closeColumn();
    }
    if (pages.length === 0) ensurePage(0);
```

Import `NoteNumberer`, `NoteColumn`, `settleBudget`, `normalizeNoteOptions`, types; `UnsupportedFeatureError` from errors.js.

- [ ] **Step 4: Run to verify they pass, plus the fences**

Run: `npx vitest run test/flow-footnotes.test.ts test/flow.test.ts test/flow-overtall.test.ts test/flow-float-content.test.ts test/flowfloat.test.ts test/markdown-flow.test.ts test/html-identity.test.ts test/docx-flow-identity.test.ts test/rich-runs-identity.test.ts`
Expected: PASS. If a geometry assertion in `flow-footnotes` is off by the font's descent, adjust the bound, not the engine — but never loosen the "same page" assertions.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-footnotes.test.ts
git commit -m "feat(v9j3.3): footnotes at the column foot in Flow.Render"
```

---

### Task 7: Endnotes

**Files:**
- Modify: `src/flow.ts` (`Render`)
- Test: `test/flow-endnotes.test.ts` (create)

**Interfaces:**
- Consumes: Task 6's `endnoteRefs` list, `this.endOpts`, `rule()` from flowblock.js.

- [ ] **Step 1: Write the failing tests**

```ts
// test/flow-endnotes.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph, list } from '../src/flow.js';

const en = (content: unknown) => ({ endnote: { content } }) as never;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('endnotes', () => {
  it('follow the content, in reference order, with roman marks', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'first' }, { text: '', ...en('END-A') }]);
    flow.AddParagraph([{ text: 'second' }, { text: '', ...en('END-B') }]);
    flow.AddParagraph('closing paragraph');
    const [p] = flow.Render();
    const f = p.GetTextFragments();
    const y = (s: string) => f.find((x) => x.text.includes(s))!.quad[1];
    expect(y('END-A')).toBeLessThan(y('closing'));
    expect(y('END-B')).toBeLessThan(y('END-A'));
    expect(f.some((x) => x.text === 'ii')).toBe(true);
  });

  it('newPage starts them on a fresh page', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'body' }, { text: '', ...en('END') }]);
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    expect(pages[1].GetText()).toContain('END');
    expect(pages[0].GetText()).not.toContain('END');
  });

  it('paginate like content when long', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en(words(2000)) }]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pages[pages.length - 1].GetText()).toContain('w1999');
  });

  it('accept an element body (a list inside a note)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en([...paragraph('intro'), ...list(['alpha', 'beta'])]) }]);
    const t = flow.Render()[0].GetText();
    expect(t).toContain('alpha');
    expect(t).toContain('beta');
  });

  it('coexist with footnotes', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', footnote: { content: 'FOOT' } } as never,
      { text: ' y' }, { text: '', ...en('ENDN') }]);
    const t = flow.Render()[0].GetText();
    expect(t).toContain('FOOT');
    expect(t).toContain('ENDN');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flow-endnotes.test.ts`
Expected: FAIL — endnote bodies never placed.

- [ ] **Step 3: Implement**

Wrap the main `while` in an outer loop so endnotes are appended once and placed by the same machinery:

```ts
    let endnotesQueued = false;
    for (;;) {
      while (queue.length > 0 || pending.length > 0) {
        /* existing body, unchanged */
      }
      if (endnotesQueued || endnoteRefs.length === 0) break;
      endnotesQueued = true;
      const sep = this.endOpts.separator;
      if (this.endOpts.newPage && !atColumnStartOfPage()) {
        forcePage = true;                          // honoured once by advanceColumn
        queue.push({ kind: 'column-break' });      // the sentinel AddColumnBreak pushes
      }
      if (sep !== undefined)
        queue.push(...rule({ thickness: sep.thickness, color: sep.color,
          width: sep.width ?? g.columnWidth / 3, spaceBefore: this.endOpts.spacing }));
      for (const r of endnoteRefs) queue.push(...r.body);
    }
```

with, declared beside `atColumnStart`:

```ts
    let forcePage = false;
    // A fresh page already: col 0 and nothing placed yet. newPage then adds nothing.
    const atColumnStartOfPage = (): boolean => col === 0 && atColumnStart;
```

and in `advanceColumn`, after `closeColumn()` and before `col++`:

```ts
      // A page break, not a column break: jump past the remaining columns.
      if (forcePage) { col = g.columns - 1; forcePage = false; }
```

A one-column flow behaves the same with or without `forcePage`; a multi-column flow needs it, since one `column-break` would only move to the next column. Endnote bodies carry no refs, so the probe stays inert for them. Add to the test file a two-column `newPage` case: `NewFlow({ columns: 2, endnotes: { newPage: true } })` with one short referencing paragraph — the endnote must be on page 2, not in column 2 of page 1.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/flow-endnotes.test.ts test/flow-footnotes.test.ts test/flow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts test/flow-endnotes.test.ts
git commit -m "feat(v9j3.3): endnotes after the flow's content"
```

---

### Task 8: Tagging — `/Note`, `/Lbl`, `/ID`, `/IDTree`

**Files:**
- Modify: `src/structwrite.ts` (add `registerStructIds`)
- Modify: `src/flownotes.ts` (add `tagNote`, `takenIds`, `nextNoteId`)
- Modify: `src/flow.ts` (`Render`: call `tagNote` at commit, register IDs at the end)
- Test: `test/flow-notes-tagged.test.ts` (create)

**Interfaces:**
- Produces:

```ts
// structwrite.ts
/** Add (id -> element ref) entries to the StructTreeRoot's /IDTree, rewritten
 *  once as a flat name node. Existing entries are kept. */
export function registerStructIds(doc: Document, rootDict: PdfDict, entries: ReadonlyArray<[string, PdfRef]>): void;
// flownotes.ts
export function takenIds(doc: Document, rootDict: PdfDict): Set<string>;
export function nextNoteId(kind: NoteKind, taken: Set<string>): string;   // 'fn-<k>' / 'en-<k>', skipping taken, adds it
export function tagNote(ref: NoteRef, fallback: StructElement, id: string): void;  // sets ref.id, ref.noteTag
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/flow-notes-tagged.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { lookupNameTree } from '../src/nametree.js';
import type { StructElement } from '../src/struct.js';

const fn = (c: string) => ({ footnote: { content: c } }) as never;
const en = (c: string) => ({ endnote: { content: c } }) as never;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function all(el: { Children: StructElement[] }): StructElement[] {
  return el.Children.flatMap((c) => [c, ...all(c)]);
}

describe('tagged notes', () => {
  it('a footnote is a /Note child of the referencing /P, with /Lbl and /P inside, and an /ID in /IDTree', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'claim' }, { text: '', ...fn('The source.') }]);
    flow.Render();
    const root = doc.GetStructTree()!;
    const note = all(root).find((e) => e.Type === 'Note')!;
    expect(note.Parent!.Type).toBe('P');
    expect(note.Children.map((c) => c.Type)).toEqual(['Lbl', 'P']);
    expect(note.ID).toBe('fn-1');
    const hit = lookupNameTree(doc, root.Dict.get('IDTree') ?? null, 'fn-1');
    expect(hit).toEqual(note.Ref);
  });

  it('an endnote is tagged at its reference too', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'x' }, { text: '', ...en('E') }]);
    flow.AddParagraph('after');
    flow.Render();
    const note = all(doc.GetStructTree()!).find((e) => e.Type === 'Note')!;
    expect(note.Parent!.Type).toBe('P');
    expect(note.ID).toBe('en-1');
  });

  it('a split note stays one /Note; ValidatePdfUa reports no UntaggedContent', () => {
    const doc = Document.New();
    doc.Title = 'T'; doc.Lang = 'en';
    const flow = doc.NewFlow({ tagged: true, lang: 'en' });
    flow.AddParagraph([{ text: 'start' }, { text: '', ...fn(words(2500)) }, { text: ' and' }, { text: '', ...en('tail') }]);
    flow.Render();
    const notes = all(doc.GetStructTree()!).filter((e) => e.Type === 'Note');
    expect(notes).toHaveLength(2);
    const report = doc.ValidatePdfUa();
    expect(report.Issues.filter((i) => i.rule === 'UntaggedContent')).toEqual([]);
  });

  it('two tagged flows in one document never collide on /ID (Review Focus 2)', () => {
    const doc = Document.New();
    for (let k = 0; k < 2; k++) {
      const flow = doc.NewFlow({ tagged: true });
      flow.AddParagraph([{ text: `f${k}` }, { text: '', ...fn(`note ${k}`) }]);
      flow.Render();
    }
    const root = doc.GetStructTree()!;
    const ids = all(root).filter((e) => e.Type === 'Note').map((e) => e.ID);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(lookupNameTree(doc, root.Dict.get('IDTree') ?? null, id!)).toBeDefined();
  });

  it('an untagged flow writes no /Note and no /IDTree', () => {
    const doc = Document.New();
    doc.NewFlow().AddParagraph([{ text: 'x' }, { text: '', ...fn('n') }]).Render();
    expect(doc.GetStructTree()).toBeNull();
  });
});
```

Check `doc.Title`/`doc.Lang` setter names, `ValidatePdfUa()`'s report shape and issue `rule` field in `src/document.ts`/`src/validation.ts`; adapt.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flow-notes-tagged.test.ts`
Expected: FAIL — no `/Note` element.

- [ ] **Step 3: Implement**

`src/structwrite.ts`:

```ts
import { collectNameTree, flatNameNode } from './nametree.js';

export function registerStructIds(doc: Document, rootDict: PdfDict, entries: ReadonlyArray<[string, PdfRef]>): void {
  if (entries.length === 0) return;
  const collected: Array<[string, PdfObject]> = [];
  collectNameTree(doc, rootDict.get('IDTree'), collected);
  const map = new Map<string, PdfObject>(collected);
  for (const [id, ref] of entries) map.set(id, ref);
  rootDict.set('IDTree', doc.allocObject(flatNameNode(map)));
  doc.markModified();
}
```

(Verify `structwrite.ts → nametree.ts` closes no cycle: nametree imports Document as a type only.)

`src/flownotes.ts`:

```ts
export function takenIds(doc: Document, rootDict: PdfDict): Set<string> {
  const out: Array<[string, PdfObject]> = [];
  collectNameTree(doc, rootDict.get('IDTree'), out);
  return new Set(out.map(([k]) => k));
}

export function nextNoteId(kind: NoteKind, taken: Set<string>): string {
  const p = kind === 'footnote' ? 'fn' : 'en';
  let k = 1;
  while (taken.has(`${p}-${k}`)) k++;
  const id = `${p}-${k}`;
  taken.add(id);
  return id;
}

/** The /Note is created at COMMIT, as a child of the element holding the
 *  reference, so it reads right after the chunk that cites it — endnotes too,
 *  whose ink is at the end. */
export function tagNote(ref: NoteRef, fallback: StructElement, id: string): void {
  ref.id = id;
  ref.noteTag = (ref.owner ?? fallback).Append('Note', { id });
}
```

`src/flow.ts` `Render`: when `structParent` exists, compute once `const root = this.doc.GetStructTree()!; const taken = takenIds(this.doc, root.Dict); const idEntries: Array<[string, PdfRef]> = [];`. In the commit block from Task 6, BEFORE `notes!.commit(...)`:

```ts
          if (structParent !== undefined)
            for (const r of placedRefs) {
              tagNote(r, structParent, nextNoteId(r.kind, taken));
              idEntries.push([r.id!, r.noteTag!.Ref!]);
            }
```

At the very end of `Render`, before `return pages`: `if (structParent !== undefined) registerStructIds(this.doc, root.Dict, idEntries);`.

`NoteElement.place` (Task 3) already appends `/Lbl` under `ref.noteTag` and hands `noteTag` to its child as `structParent`, and `NoteColumn.paint` passes `structParent` so the separator is artifacted.

- [ ] **Step 4: Run to verify they pass, plus tagging fences**

Run: `npx vitest run test/flow-notes-tagged.test.ts test/flow-tagging.test.ts test/markdown-pdfua.test.ts test/flow-footnotes.test.ts test/flow-endnotes.test.ts test/import-cycles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/structwrite.ts src/flownotes.ts src/flow.ts test/flow-notes-tagged.test.ts
git commit -m "feat(v9j3.3): tag notes as /Note with /ID registered in /IDTree"
```

---

### Task 9: Guards, docs, follow-ups, full verification

**Files:**
- Test: `test/flow-notes-guards.test.ts` (create)
- Modify: `README.md` (Key Capabilities line, an example "Add Footnotes and Endnotes" under Additional Examples, API Reference rows for `FlowNote`, `FlowTextRun`, `FlowNoteOptions`, `FlowEndnoteOptions`, the `TextRun.rise` mention in the `TextRun` row, the `FlowOptions` row's new fields, Scope and Limitations lines for the scope-outs)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → Added)
- Modify: `CLAUDE.md` (Source list entry for `flownotes.ts`; one line under `flow.ts` for the probe and the `FlowElement.noteRefs` protocol)

- [ ] **Step 1: Write the guard tests**

```ts
// test/flow-notes-guards.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { table } from '../src/flow.js';
import { createTable } from '../src/tableauthor.js';

const run = { text: 'x', footnote: { content: 'n' } } as never;

describe('note references outside Flow paragraphs are refused, not dropped', () => {
  it('AddTextBlock', () => {
    const page = Document.New().AddPage().page;
    expect(() => page.AddTextBlock([run], [72, 72, 300, 600])).toThrow(TypeError);
  });
  it('a table cell inside a flow', () => {
    const doc = Document.New();
    const t = createTable({ columns: 1 });
    t.addRow().addCell([run]);
    const flow = doc.NewFlow();
    flow.AddElements(table(t));
    expect(() => flow.Render()).toThrow(TypeError);
  });
  it('a FloatingBox paragraph', () => {
    const doc = Document.New();
    const box = doc.NewFloatingBox({ width: 100 });
    expect(() => { box.AddParagraph([run]); doc.NewFlow().AddFloatBox(box, 'left').Render(); }).toThrow(TypeError);
  });
});
```

Check `createTable`/`addRow`/`addCell` and `AddFloatBox` signatures and adapt.

- [ ] **Step 2: Run them**

Run: `npx vitest run test/flow-notes-guards.test.ts`
Expected: PASS (Task 1's guard does the work). If one passes silently instead of throwing, the guard is being bypassed on that path: find where that path resolves runs and route it through `resolveRuns`.

- [ ] **Step 3: Docs**

- README: add the example (a three-line Flow with a footnote and an endnote), the four API rows (first cell `` `FlowNote` `` etc.), and Scope and Limitations lines: "Footnotes in table cells, in floats and in single-rect placement (`page.AddMarkdown`/`AddHtml`/`AddDocx`) are refused with an error"; "Footnote numbering is continuous per flow; restarting per page is not offered"; "No internal links from mark to note". Run `npx vitest run test/readme-api.test.ts` and copy the counts it reports into the intro sentence.
- CHANGELOG `## [Unreleased]` → `### Added`: **Footnotes and endnotes in Flow.** — what it does, the Word-style split, probe-and-shrink and why, `/Note` with `/ID` at the reference, the scope-outs; then a second entry **`TextRun.rise`** — baseline shift moving ink not layout. Cite `(v9j3.3)`.
- CLAUDE.md: a `flownotes.ts` entry in the house style — purpose; invariants (numbering before any measure; the symbol key survives `sliceContent`; probe only when a note exists, which is the byte-identity argument; whole notes first, split only at a column start; paint at column close, never incrementally; carry precedence and why it terminates; `/Note` under the referencing element). Run the module sweep from CLAUDE.md and confirm it prints nothing.

- [ ] **Step 4: Mutation check (record results in the CLAUDE.md entry)**

For each, apply the mutation, run the named file, confirm it goes RED, revert, confirm GREEN (verify the mutation actually applied — a no-op reports GREEN):
1. Float fit test back to `g.contentBottom` → `test/flow-footnotes.test.ts` ("a float never overlaps").
2. `settleBudget`: drop the `Math.min(a, …)` (use `room - footHeightWith(fr)` alone) → `test/flownotes-column.test.ts`.
3. `NoteColumn.paint`: reverse `els` → "note 1 above note 2".
4. `paint`: put `committed` before `carry` → "carries what does not fit".
5. `registerStructIds` call removed → `test/flow-notes-tagged.test.ts`.
6. `lowerNotes`: build the mark run with `Object.assign({}, …)` and a string key instead of the symbol → `test/flownotes-lower.test.ts` copy case.
7. Keep-with-next `remaining` back to `g.contentBottom` → Review Focus 5 case.
8. The `top - effBottom() <= 0` advance removed → the drain test (expect a hang: run with `--testTimeout=20000` and kill orphaned vitest workers afterwards).

- [ ] **Step 5: Full verification**

Run: `npm run typecheck`
Run: `npm test`
Expected: both green.

- [ ] **Step 6: File follow-ups and commit**

```bash
bd create "Footnotes in Flow table cells" --parent aspose-pdf-foss-for-ts-v9j3.3 -t feature -p 2 -l net-parity -d "v9j3.3 refuses a note reference in a table cell. Lift it: flowtable measure must report refs in the kept rows, cells lower notes, tableauthor's resolveRuns path must accept lowered mark runs."
bd create "Internal links between footnote marks and notes" --parent aspose-pdf-foss-for-ts-v9j3.3 -t feature -p 3 -l net-parity -d "v9j3.3 writes no /Link from a reference mark to its note or back. Add GoTo links both ways (and /Ref in a PDF 2.0 tree if FENote is ever written)."
git add README.md CHANGELOG.md CLAUDE.md test/flow-notes-guards.test.ts
git commit -m "docs(v9j3.3): footnotes and endnotes — README, CHANGELOG, CLAUDE.md"
```
