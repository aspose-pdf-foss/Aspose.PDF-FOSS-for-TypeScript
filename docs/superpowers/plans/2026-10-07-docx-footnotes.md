# DOCX Footnotes and Endnotes (v9j3.3.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `AddDocx` renders Word footnotes and endnotes through the v9j3.3 Flow footnote engine, honouring Word's numbering format, start, and restart per section and per page.

**Architecture:** The engine gains a restart marker element (`flow.RestartNotes`) and lazy per-page footnote numbering (`FlowNoteOptions.restart: 'page'`). The DOCX reader parses `footnotes.xml`/`endnotes.xml` through the body's own `Walker` (each part with its own relationships), reads `settings.xml` and per-section `footnotePr`/`endnotePr`, and models a reference as a `note` inline. The mapper builds one `FlowNote` per referenced id from the note's blocks and resolves Word's numbering into flow note options; `doc.AddDocx` feeds them to its Flow, `page.AddDocx` to `notesAsTrailing`. Word 2010 and LibreOffice 26.8 are the oracle.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest; PowerShell + Word COM and LibreOffice UNO Python for the oracle (not run by `npm test`).

**Spec:** `docs/superpowers/specs/2026-10-07-docx-footnotes-design.md`

## Global Constraints

- Zero runtime dependencies; no new value-import 2-cycle (`npx vitest run test/import-cycles.test.ts`).
- Every `catch` in `src/` calls `rethrowLimit(caught)` first (`test/limits-catch.test.ts`).
- A flow that uses neither `RestartNotes` nor `restart: 'page'` takes exactly today's path: the fence of Task 1 Step 1 stays green unedited through every later task.
- `test/docx-flow-identity.test.ts`, `test/rich-runs-identity.test.ts` and every v9j3.3/v9j3.3.1 test stay green; any test edited to the new behaviour gets a ledger ruling.
- New exports get README API rows (`test/readme-api.test.ts`); a new `src/*.ts` module gets a CLAUDE.md entry.
- Report names (exact): `w:footnoteReference` / `w:endnoteReference` (dropped — the notes part is absent, missing or unreadable); `… (unknown id)` (dropped); `… (table cell)` (dropped); `… (in a note)` (dropped); `w:numFmt (footnote)` / `w:numFmt (endnote)`, `w:numRestart (endnote)`, `w:pos (footnote)` / `w:pos (endnote)`, `w:footnotePr (section)` / `w:endnotePr (section)`, `w:footnotePr` / `w:endnotePr` (flow.AddDocx mismatch), `w:br (page)` — all degraded.
- **Ruling (planner):** `parseNotes` lives in `wmlbody.ts`, beside `parseBody`, because it needs the module-private `Walker`; the new `wmlnotes.ts` holds the numbering-property readers. The spec placed `parseNotes` in `wmlnotes.ts`.
- **Ruling (planner):** the up-front numbering pass still numbers per-page footnotes PROVISIONALLY (continuously) — that is what builds their bodies and sets `numberer.any` — and each offer then RENUMBERS them. The spec said the pass "skips" them; the effect is identical, since no provisional mark survives to placement.
- **Ruling (planner):** Word's numbering properties apply through `doc.AddDocx` (which builds the Flow) and `page.AddDocx` (which builds its own note options). `flow.AddDocx` keeps the flow's own options and reports `w:footnotePr` / `w:endnotePr` degraded when Word's differ. A Flow's options are fixed at construction.
- **Ruling (planner):** the oracle recipes do NOT put a list inside a note — LibreOffice's list-style names vary by version, and a recipe that fails to build is no oracle. Lists in notes are held by hand-built cases (Task 4). The spec is amended in Task 6.

## Review Focus

1. **A footnote whose text holds a hyperlink or an image** (relationships of `footnotes.xml`, not `document.xml`): the link is clickable and the image draws. → Task 3 (reader) and Task 4 (end to end).
2. **A reference whose line is pushed to the next page under `eachPage`**: its mark and its note restart at 1 on the new page, and the mark drawn equals the gutter mark. → Task 2.
3. **A note-free DOCX**: output byte-identical to before. → Task 4.
4. **A footnote reference in a table cell**: nothing is drawn for it, the rest of the table renders, and `skipped` names it once per reference. → Task 4.
5. **A document whose footnotes part is missing**: every reference reported once, the body renders. → Task 3/Task 4.

---

### Task 1: Engine — per-section restart (`flow.RestartNotes`) and the byte-identity fence

**Files:**
- Modify: `src/flownotes.ts` (`NoteRestartElement`, `noteRestart`, `isNoteRestart`, `NoteNumberer.restart`, `notesAsTrailing`)
- Modify: `src/flow.ts` (`RestartNotes`, numbering pass, placement loop, keep-with-next lookahead)
- Modify: `src/flowplace.ts` (skip restart elements)
- Test: `test/flow-notes-identity.test.ts` (create — the fence), `test/flow-notes-restart.test.ts` (create)

**Interfaces:**
- Produces:

```ts
// flownotes.ts
export class NoteRestartElement implements FlowElement {   // @internal
  constructor(readonly noteRestart: readonly NoteKind[]);
  measure(): { usedHeight: 0; fits: true };
  place(): { usedHeight: 0; remainder: null; drew: false };
  noteRefs(): NoteRef[];   // []
}
export function noteRestart(kind?: NoteKind): FlowElement;          // @internal
export function isNoteRestart(e: unknown): e is NoteRestartElement; // @internal
// NoteNumberer gains: restart(kinds: readonly NoteKind[]): void
// flow.ts
class Flow { RestartNotes(kind?: 'footnote' | 'endnote'): this }
```

- [ ] **Step 1: Record the byte-identity fence BEFORE any engine edit**

```ts
// test/flow-notes-identity.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';

/** The bytes note flows emit, hashed — recorded on the code BEFORE v9j3.3.2's
 *  engine changes. A FENCE: a flow using neither RestartNotes nor
 *  restart: 'page' must stay byte-identical. Never re-record to make it pass. */
const sha = (pages: { Contents: Uint8Array }[]): string =>
  createHash('sha256').update(Buffer.concat(pages.map((p) => Buffer.from(p.Contents)))).digest('hex').slice(0, 16);
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler sentence number ${i} of the body.`).join(' ');

describe('note flows are byte-identical (v9j3.3.2 fence)', () => {
  it('footnotes across pages', () => {
    const flow = Document.New().NewFlow();
    for (let i = 0; i < 6; i++)
      flow.AddParagraph([{ text: filler(25) }, { text: '', footnote: { content: `Note ${i}. ${filler(3)}` } }]);
    expect(sha(flow.Render())).toMatchInlineSnapshot();
  });
  it('endnotes, a repeat and a custom mark', () => {
    const n = { content: 'Shared.' };
    const flow = Document.New().NewFlow({ endnotes: { newPage: true } });
    flow.AddParagraph([{ text: 'a' }, { text: '', endnote: n }, { text: ' b' }, { text: '', endnote: n }]);
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: { content: 'Star.', mark: '*' } }]);
    expect(sha(flow.Render())).toMatchInlineSnapshot();
  });
  it('tagged two-column flow with footnotes', () => {
    const flow = Document.New().NewFlow({ tagged: true, columns: 2 });
    for (let i = 0; i < 4; i++)
      flow.AddParagraph([{ text: filler(12) }, { text: '', footnote: { content: `Col note ${i}.` } }]);
    expect(sha(flow.Render())).toMatchInlineSnapshot();
  });
});
```

- [ ] **Step 2: Record it**

Run: `npx vitest run test/flow-notes-identity.test.ts -u`
Expected: 3 passed, snapshots written into the file. Then run without `-u`: 3 passed. Commit it alone:

```bash
git add test/flow-notes-identity.test.ts
git commit -m "test(v9j3.3.2): byte-identity fence for note flows, recorded before the engine changes"
```

- [ ] **Step 3: Write the failing restart tests**

```ts
// test/flow-notes-restart.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { notesAsTrailing, normalizeNoteOptions, noteRestart, type NoteText } from '../src/flownotes.js';
import { paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';

/** Marks on a page — citation marks and gutter marks: small fragments that READ
 *  as a mark. The size test alone would also take the 8pt note bodies. */
const marks = (page: { GetTextFragments(): { text: string; fontSize: number }[] }, size: number) =>
  page.GetTextFragments().filter((f) => f.fontSize < size * 0.8 && f.fontSize > 0)
    .map((f) => f.text.trim()).filter((t) => /^(\d+|[ivxlc]+|\*)$/.test(t));

describe('flow.RestartNotes', () => {
  it('restarts footnote numbering at the marker', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }]);
    flow.AddParagraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }]);
    flow.RestartNotes('footnote');
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: { content: 'C' } }]);
    const [p] = flow.Render();
    // three citation marks + three gutter marks
    expect(marks(p, 12).sort()).toEqual(['1', '1', '1', '1', '2', '2']);
  });
  it('restarts only the kind named; no kind restarts both', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }, { text: '', endnote: { content: 'E' } }]);
    flow.RestartNotes('endnote');
    flow.AddParagraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }, { text: '', endnote: { content: 'F' } }]);
    const t = marks(flow.Render()[0], 12);
    expect(t.filter((m) => m === '2')).toHaveLength(2);       // footnote 2 continued (mark + gutter)
    expect(t.filter((m) => m === 'ii')).toHaveLength(0);      // endnotes restarted at i
    expect(t.filter((m) => m === 'i')).toHaveLength(4);
    const both = Document.New().NewFlow();
    both.AddParagraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }]);
    both.RestartNotes();
    both.AddParagraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }]);
    expect(marks(both.Render()[0], 12).filter((m) => m === '2')).toHaveLength(0);
  });
  it('leaves no gap where the marker sits', () => {
    const render = (restart: boolean) => {
      const flow = Document.New().NewFlow();
      flow.AddParagraph('first');
      if (restart) flow.RestartNotes();
      flow.AddParagraph('second');
      const f = flow.Render()[0].GetTextFragments();
      return f.find((x) => x.text.includes('second'))!.quad[1];
    };
    expect(render(true)).toBeCloseTo(render(false), 6);
  });
  it('does not break keep-with-next: a heading before a marker stays with the next paragraph', () => {
    const flow = Document.New().NewFlow({ keepHeadingsWithNext: true });
    flow.AddParagraph('x '.repeat(1900));
    flow.AddHeading(2, 'KEPT');
    flow.RestartNotes();
    flow.AddParagraph('after the heading');
    const pages = flow.Render();
    const pageOf = (s: string) => pages.findIndex((p) => p.GetText().includes(s));
    expect(pageOf('KEPT')).toBe(pageOf('after the heading'));
  });
  it('notesAsTrailing honours and strips restart elements', () => {
    const foot = normalizeNoteOptions(undefined, 'footnote');
    const end = normalizeNoteOptions(undefined, 'endnote');
    const mk = (t: NoteText, s: number) => paragraph(t, { fontSize: s });
    const els = [
      ...paragraph([{ text: 'a' }, { text: '', footnote: { content: 'A' } }]),
      noteRestart('footnote'),
      ...paragraph([{ text: 'b' }, { text: '', footnote: { content: 'B' } }]),
    ];
    const out = notesAsTrailing(els, foot, end, mk);
    expect(out.some((e) => (e as { noteRestart?: unknown }).noteRestart !== undefined)).toBe(false);
    const doc = Document.New();
    const page = doc.AddPage().page;
    placeElements(doc, page, out, [72, 72, 400, 700]);
    expect(marks(page, 12).filter((m) => m === '2')).toHaveLength(0);
  });
  it('placeElements skips a restart element', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r = placeElements(doc, page, [...paragraph('one'), noteRestart(), ...paragraph('two')], [72, 72, 400, 700]);
    expect(r.remainder).toEqual([]);
    expect(page.GetText()).toContain('two');
  });
  it('RestartNotes refuses an unknown kind', () => {
    expect(() => Document.New().NewFlow().RestartNotes('sidenote' as never)).toThrow(TypeError);
  });
});
```

`keepHeadingsWithNext` is the existing FlowOptions key that `this.keepHeadingsWithNext` reads in `flow.ts`; check its exact option name in `FlowOptions` and use it.

- [ ] **Step 4: Run to verify they fail**

Run: `npx vitest run test/flow-notes-restart.test.ts`
Expected: FAIL — `RestartNotes` / `noteRestart` do not exist.

- [ ] **Step 5: Implement**

`src/flownotes.ts` — beside `notesAsTrailing`:

```ts
/** The marker `flow.RestartNotes` queues (v9j3.3.2): the numbering pass resets
 *  the named kinds' counters to their `start` on reaching it. It draws nothing
 *  and takes no room: Render and placeElements skip it outright rather than
 *  placing a zero-height element, which would still earn paragraphSpacing.
 *  @internal */
export class NoteRestartElement implements FlowElement {
  constructor(readonly noteRestart: readonly NoteKind[]) {}
  measure(): { usedHeight: number; fits: boolean } { return { usedHeight: 0, fits: true }; }
  place(): PlaceResult { return { usedHeight: 0, remainder: null, drew: false }; }
  noteRefs(): NoteRef[] { return []; }
}

/** A restart marker for `kind`, or for both kinds. @internal */
export function noteRestart(kind?: NoteKind): FlowElement {
  if (kind !== undefined && kind !== 'footnote' && kind !== 'endnote')
    throw new TypeError("kind must be 'footnote' or 'endnote'");
  return new NoteRestartElement(kind === undefined ? ['footnote', 'endnote'] : [kind]);
}

/** Whether `e` is a restart marker. @internal */
export function isNoteRestart(e: unknown): e is NoteRestartElement { return e instanceof NoteRestartElement; }
```

(`PlaceResult` is already imported from `flowelement.js` in this module — add it to that import if not.)

`NoteNumberer` — add:

```ts
  /** Reset the named kinds' counters to their `start` (a restart marker). */
  restart(kinds: readonly NoteKind[]): void {
    for (const k of kinds) this.next[k] = (k === 'footnote' ? this.foot : this.end).start;
  }
```

`notesAsTrailing` — replace the two lines
`for (const r of refs) nb.assign(r);` and the computation of `refs` so restarts are honoured in order, and strip the markers from the output:

```ts
  const refs = elements.flatMap((e) => e.noteRefs?.() ?? []);
  if (refs.length === 0) return elements.filter((e) => !isNoteRestart(e));
  const nb = new NoteNumberer(foot, end, makeBody);
  for (const e of elements) {
    if (isNoteRestart(e)) { nb.restart(e.noteRestart); continue; }
    for (const r of e.noteRefs?.() ?? []) nb.assign(r);
  }
```

and change `const out = [...elements];` to `const out = elements.filter((e) => !isNoteRestart(e));`. Note the "returns `elements` itself when nothing cites a note" behaviour changes only when a marker is present; update its doc comment: "Returns `elements` itself when nothing cites a note and no restart marker is present." — and make that literally true:

```ts
  if (refs.length === 0) return elements.some(isNoteRestart) ? elements.filter((e) => !isNoteRestart(e)) : elements;
```

`src/flowplace.ts` — at the top of `placeElements`, after the paragraphSpacing validation and BEFORE the note-refusal check:

```ts
  // A restart marker (v9j3.3.2) numbers nothing here and draws nothing.
  if (elements.some(isNoteRestart)) elements = elements.filter((e) => !isNoteRestart(e));
```

(import `isNoteRestart` from `./flownotes.js`; `elements` is already reassigned later in the function, so it is a mutable parameter — if it is declared `readonly` or `const`-bound, rebind through a local `let els = elements` and use `els` throughout the edit.)

`src/flow.ts`:
- import `noteRestart, isNoteRestart` from `./flownotes.js`.
- method, beside `AddColumnBreak`:

```ts
  /** Restart note numbering here (v9j3.3.2): the next footnote (or endnote, or
   *  both when `kind` is omitted) takes its kind's `start` again — Word's
   *  "restart each section". Draws nothing and takes no room. Chainable. */
  RestartNotes(kind?: 'footnote' | 'endnote'): this {
    this.items.push(noteRestart(kind));
    return this;
  }
```

- numbering pass: in `for (const it of queue) {` add first line
  `if (isNoteRestart(it)) { numberer.restart(it.noteRestart); continue; }`
- placement loop: after `if (isBreak(item)) { queue.shift(); advanceColumn(); continue; }` add
  `if (isNoteRestart(item)) { queue.shift(); continue; }`
- keep-with-next lookahead: replace

```ts
          const next = queue.length > 1 && !isBreak(queue[1]) && !isFloat(queue[1])
            ? (queue[1] as FlowElement) : undefined;
```

with

```ts
          // The next element that DRAWS: a restart marker takes no room (v9j3.3.2).
          const after = queue.slice(1).find((q) => !isNoteRestart(q));
          const next = after !== undefined && !isBreak(after) && !isFloat(after)
            ? (after as FlowElement) : undefined;
```

- [ ] **Step 6: Run to verify they pass, plus the fences**

Run: `npx vitest run test/flow-notes-restart.test.ts test/flow-notes-identity.test.ts test/flownotes-repeat.test.ts test/flow-footnotes.test.ts test/flow-endnotes.test.ts test/flow-notes-tagged.test.ts test/markdown-footnotes.test.ts test/import-cycles.test.ts`
Expected: PASS. Then `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` → `tsc=0` (read the exit code, never pipe tsc through `tail`).

- [ ] **Step 7: Commit**

```bash
git add src/flownotes.ts src/flow.ts src/flowplace.ts test/flow-notes-restart.test.ts
git commit -m "feat(v9j3.3.2): flow.RestartNotes — restart note numbering at a marker"
```

---

### Task 2: Engine — per-page footnote restart (`restart: 'page'`)

**Files:**
- Modify: `src/flownotes.ts` (`FlowNoteOptions.restart`, `ResolvedNoteOptions.restart`, `normalizeNoteOptions`, `NoteNumberer.renumber`, module invariant)
- Modify: `src/flow.ts` (per-page counter in `commitRefs`, renumbering at offer and in the lookahead)
- Test: `test/flow-notes-page-restart.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `NoteNumberer.restart`.
- Produces: `FlowNoteOptions.restart?: 'continuous' | 'page'`; `ResolvedNoteOptions.restart: 'continuous' | 'page'`; `NoteNumberer.renumber(ref: NoteRef, n: number): void`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/flow-notes-page-restart.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { normalizeNoteOptions } from '../src/flownotes.js';

const filler = (n: number) => Array.from({ length: n }, (_, i) => `Body sentence ${i} fills the page steadily.`).join(' ');
/** Small fragments (marks) on a page, with their y. */
const smalls = (page: { GetTextFragments(): { text: string; fontSize: number; quad: number[] }[] }) =>
  page.GetTextFragments().filter((f) => f.fontSize < 8).map((f) => ({ t: f.text.trim(), y: f.quad[1] }));

describe("footnotes.restart: 'page'", () => {
  const build = (restart: 'page' | 'continuous') => {
    const flow = Document.New().NewFlow({ footnotes: { restart } });
    for (let i = 0; i < 8; i++)
      flow.AddParagraph([{ text: filler(14) }, { text: '', footnote: { content: `NOTE${i}` } }]);
    return flow.Render();
  };
  it('numbers from 1 on every page', () => {
    const pages = build('page');
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const nums = smalls(p).map((s) => s.t).filter((t) => /^\d+$/.test(t)).map(Number);
      if (nums.length === 0) continue;
      expect(Math.min(...nums)).toBe(1);
    }
  });
  it('continuous numbering is unchanged (control)', () => {
    const pages = build('continuous');
    const last = pages[pages.length - 1];
    const nums = smalls(last).map((s) => s.t).filter((t) => /^\d+$/.test(t)).map(Number);
    expect(Math.min(...nums)).toBeGreaterThan(1);
  });
  it('a citation mark always equals its gutter mark', () => {
    for (const p of build('page')) {
      const t = p.GetText();
      for (let i = 0; i < 8; i++) {
        if (!t.includes(`NOTE${i}`)) continue;
        // the gutter mark sits on the note's own line, just left of it
        const f = p.GetTextFragments();
        const body = f.find((x) => x.text.includes(`NOTE${i}`))!;
        const gutter = f.filter((x) => x.fontSize < 8 && Math.abs(x.quad[1] - body.quad[1]) < 4 && x.quad[0] < body.quad[0]);
        expect(gutter).toHaveLength(1);
        const mark = gutter[0].text.trim();
        // the same number appears as a raised citation mark above the foot
        const citations = f.filter((x) => x.fontSize < 8 && x.text.trim() === mark && x.quad[1] > body.quad[1] + 20);
        expect(citations.length).toBeGreaterThan(0);
      }
    }
  });
  it('a line pushed to the next page is renumbered there (Review Focus 2)', () => {
    // One page nearly full, then a citation whose line cannot fit with its note.
    const flow = Document.New().NewFlow({ footnotes: { restart: 'page' } });
    flow.AddParagraph([{ text: filler(40) }, { text: '', footnote: { content: 'FIRSTPAGE' } }]);
    flow.AddParagraph([{ text: filler(4) }, { text: '', footnote: { content: 'MOVED ' + filler(6) } }]);
    const pages = flow.Render();
    const pageOf = (s: string) => pages.findIndex((p) => p.GetText().includes(s));
    const moved = pageOf('MOVED');
    if (moved > pageOf('FIRSTPAGE')) {
      const f = pages[moved].GetTextFragments();
      const body = f.find((x) => x.text.includes('MOVED'))!;
      const gutter = f.find((x) => x.fontSize < 8 && Math.abs(x.quad[1] - body.quad[1]) < 4 && x.quad[0] < body.quad[0])!;
      expect(gutter.text.trim()).toBe('1');
    }
    expect(moved).toBeGreaterThanOrEqual(0);
  });
  it('endnotes refuse restart: page', () => {
    expect(() => normalizeNoteOptions({ restart: 'page' } as never, 'endnote')).toThrow(TypeError);
    expect(() => normalizeNoteOptions({ restart: 'sometimes' } as never, 'footnote')).toThrow(TypeError);
    expect(normalizeNoteOptions(undefined, 'footnote').restart).toBe('continuous');
  });
});
```

The "pushed to the next page" case must actually push: after Step 4 passes, confirm the `if (moved > …)` branch ran (add a temporary `console.log(moved, pageOf('FIRSTPAGE'))`, adjust `filler(40)` until it reports moved = 1, then remove the log and replace the `if` with `expect(moved).toBe(pageOf('FIRSTPAGE') + 1)`). A case whose branch never runs measures nothing.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flow-notes-page-restart.test.ts`
Expected: FAIL (`restart` is unknown; numbering continuous).

- [ ] **Step 3: Implement**

`src/flownotes.ts`:
- `FlowNoteOptions` gains:

```ts
  /** When footnote numbers restart (v9j3.3.2): `'continuous'` (default) or
   *  `'page'`, from `start` on every page — Word's "restart each page".
   *  Footnotes only; endnotes refuse `'page'`. */
  restart?: 'continuous' | 'page';
```

- `ResolvedNoteOptions` gains `restart: 'continuous' | 'page';`.
- `normalizeNoteOptions`, before the return:

```ts
  const restart = v.restart ?? 'continuous';
  if (restart !== 'continuous' && restart !== 'page')
    throw new TypeError(`${p}.restart must be 'continuous' or 'page'`);
  if (restart === 'page' && kind === 'endnote')
    throw new TypeError("endnotes.restart cannot be 'page': endnotes do not sit on the page that cites them");
```

and add `restart` to the returned object.
- `NoteNumberer`: keep each first reference's holder — add `private readonly holders = new Map<NoteRef, NoteHolder>();` and in `assign`, after `const holder: NoteHolder = {…};` add `this.holders.set(ref, holder);`. Then:

```ts
  /** Re-number a reference not yet placed (`restart: 'page'`): its mark and
   *  its gutter, which is measured from the mark. An explicit mark takes no
   *  number and is left alone; a repeat copies its first citation's mark. */
  renumber(ref: NoteRef, n: number): void {
    if (ref.repeatOf !== undefined) { ref.mark = ref.repeatOf.mark; ref.markRun.text = ref.mark; return; }
    if (ref.note.mark !== undefined) return;
    const o = ref.kind === 'footnote' ? this.foot : this.end;
    ref.mark = formatMark(n, o.format);
    ref.markRun.text = ref.mark;
    const h = this.holders.get(ref);
    if (h !== undefined) h.gutter = measureText(ref.mark, h.markSize, 'Helvetica') + GUTTER_GAP;
  }
```

- Module doc: replace "**Invariant:** lowering does NOT number. … so a mark's width never changes after a line was measured." 's last clause by adding, after it:

```
 *  **Invariant (`v9j3.3.2`):** under `footnotes.restart: 'page'` a footnote's
 *  number depends on the page its line lands on, so it is (re)numbered each
 *  time its element is OFFERED to a column, before any probe, from that
 *  page's count of footnotes already placed. A mark therefore never changes
 *  after its line is PLACED — every measurement happens in the column the
 *  line is then placed in. Committed references are final.
```

`src/flow.ts` (inside `Render`):
- after `const notes = numberer.any ? …` add:

```ts
    // restart: 'page' (v9j3.3.2): footnotes placed on the current page, and
    // every reference already committed, whose number is final.
    const pageRestart = this.footOpts.restart === 'page';
    const committed = new Set<NoteRef>();
    let countPage = -1;
    let countOnPage = 0;
    const renumberForPage = (el: FlowElement): void => {
      let n = this.footOpts.start + (countPage === pageIdx ? countOnPage : 0);
      for (const r of el.noteRefs?.() ?? []) {
        if (r.kind !== 'footnote' || committed.has(r)) continue;
        numberer.renumber(r, n);
        if (r.repeatOf === undefined && r.note.mark === undefined) n++;
      }
    };
```

- in `commitRefs`, first line inside the function (after the `refs.length === 0` return):

```ts
      for (const r of refs) {
        committed.add(r);
        if (r.kind !== 'footnote' || r.repeatOf !== undefined || r.note.mark !== undefined) continue;
        if (countPage !== pageIdx) { countPage = pageIdx; countOnPage = 0; }
        countOnPage++;
      }
```

- after `const item2: FlowElement = item as FlowElement;` add
  `if (pageRestart) renumberForPage(item2);`
- in the keep-with-next block, after `next` is bound (Task 1's form) and before `if (next?.measure) {`, add
  `if (pageRestart && next !== undefined) renumberForPage(next);`

`pageIdx` is the Render-local page counter; `commitRefs` and the placement both run with the page the element lands on, so `countPage === pageIdx` compares like with like.

- [ ] **Step 4: Run to verify they pass, plus the fences**

Run: `npx vitest run test/flow-notes-page-restart.test.ts test/flow-notes-restart.test.ts test/flow-notes-identity.test.ts test/flownotes-repeat.test.ts test/flownotes-number.test.ts test/flow-footnotes.test.ts test/flow-endnotes.test.ts test/flow-notes-tagged.test.ts test/flow-notes-review.test.ts test/markdown-footnotes.test.ts`
Expected: PASS (do Step 1's "make the push branch run" adjustment here). `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` → `tsc=0`.

- [ ] **Step 5: Commit**

```bash
git add src/flownotes.ts src/flow.ts test/flow-notes-page-restart.test.ts
git commit -m "feat(v9j3.3.2): restart footnote numbering on every page"
```

---

### Task 3: Reader — notes parts, settings, references, section properties

**Files:**
- Create: `src/wmlnotes.ts` (`WmlNotePr`, `WmlSectionNotes`, `readNotePr`, `readSectionNotes`, `parseSettingsNotes`)
- Modify: `src/wmlbody.ts` (`WmlNoteRef` inline, `WmlParagraph.sectionEnd`, `BodyResult.lastSection`, `parseNotes`, `DROPPED` gains `footnoteRef`/`endnoteRef`)
- Modify: `src/wmlread.ts` (`WmlDocument.footnotes`/`endnotes`/`notePr`; read the three parts)
- Modify: `test/helpers/build-docx.ts` (`footnotes`, `endnotes`, `settings`, `notesRels` parts)
- Test: `test/wml-notes.test.ts` (create)

**Interfaces:**
- Produces:

```ts
// wmlnotes.ts
export interface WmlNotePr { numFmt?: string; numStart?: number; numRestart?: string; pos?: string }
export interface WmlSectionNotes { footnotePr?: WmlNotePr; endnotePr?: WmlNotePr }
export function readNotePr(el: NsElement | undefined): WmlNotePr | undefined;
export function readSectionNotes(sectPr: NsElement | undefined): WmlSectionNotes;
export function parseSettingsNotes(bytes: Uint8Array, limits: LoadLimits): WmlSectionNotes;
// wmlbody.ts
export interface WmlNoteRef { kind: 'note'; note: 'footnote' | 'endnote'; id: string; props: RunProps; mark?: string }
// WmlInline gains WmlNoteRef; WmlParagraph gains sectionEnd?: WmlSectionNotes;
// BodyResult gains lastSection: WmlSectionNotes;
export function parseNotes(bytes: Uint8Array, ctx: BodyContext, kind: 'footnote' | 'endnote'): { notes: Map<string, WmlBlock[]>; unsupported: Map<string, number> };
// wmlread.ts WmlDocument gains:
//   footnotes?: Map<string, WmlBlock[]>;   // undefined: no usable part
//   endnotes?: Map<string, WmlBlock[]>;
//   notePr: { settings: WmlSectionNotes; last: WmlSectionNotes };
```

- [ ] **Step 1: Extend the builder**

In `test/helpers/build-docx.ts`, `DocxParts` gains:

```ts
  /** Inner XML of <w:footnotes> / <w:endnotes> / <w:settings>. */
  footnotes?: string; endnotes?: string; settings?: string;
  /** Relationships OF footnotes.xml (images, hyperlinks inside a note). */
  footnoteRels?: { id: string; type: string; target: string; external?: boolean }[];
```

and in `buildDocx`, before `for (const m of parts.media …)`:

```ts
  const wrap = (root: string, inner: string) => enc(`<w:${root} xmlns:w="${W_NS}" `
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `${inner}</w:${root}>`);
  if (parts.footnotes !== undefined) {
    p.push({ path: 'word/footnotes.xml', bytes: wrap('footnotes', parts.footnotes), contentType: `${CT}.footnotes+xml` });
    docRel('rFn', 'footnotes', 'footnotes.xml');
  }
  if (parts.endnotes !== undefined) {
    p.push({ path: 'word/endnotes.xml', bytes: wrap('endnotes', parts.endnotes), contentType: `${CT}.endnotes+xml` });
    docRel('rEn', 'endnotes', 'endnotes.xml');
  }
  if (parts.settings !== undefined) {
    p.push({ path: 'word/settings.xml', bytes: wrap('settings', parts.settings), contentType: `${CT}.settings+xml` });
    docRel('rSe', 'settings', 'settings.xml');
  }
  for (const x of parts.footnoteRels ?? []) {
    r.push({ source: 'word/footnotes.xml', id: x.id, type: `${REL}/${x.type}`, target: x.target, ...(x.external ? { external: true } : {}) });
  }
```

(a note image's `a:blip` needs the `a`/`pic`/`wp` namespaces: the tests below inline them on the element, so `wrap` need not declare them.)

- [ ] **Step 2: Write the failing tests**

```ts
// test/wml-notes.test.ts
import { describe, it, expect } from 'vitest';
import { readDocx } from '../src/wmlread.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';
import type { WmlParagraph } from '../src/wmlbody.js';

const fnRef = (id: string, extra = '') => `<w:r><w:rPr><w:b/></w:rPr><w:footnoteReference w:id="${id}"${extra}/></w:r>`;
const SEPARATORS = '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
  + '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
const note = (id: string, body: string) => `<w:footnote w:id="${id}">${body}</w:footnote>`;
const noteP = (text: string) => p(`<w:r><w:footnoteRef/></w:r>${r(' ' + text)}`);
const textOf = (ps: unknown[]) => (ps as WmlParagraph[]).map((x) => x.inlines.map((i) => ('text' in i ? i.text : '')).join('')).join('|');

describe('footnotes.xml', () => {
  it('reads notes by id, skips separators, drops footnoteRef', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), { footnotes: SEPARATORS + note('1', noteP('First.') + p(r('Second.'))) }));
    expect([...doc.footnotes!.keys()]).toEqual(['1']);
    expect(textOf(doc.footnotes!.get('1')!)).toBe(' First.|Second.');
    expect(doc.unsupported).toEqual([]);
  });
  it('models a reference as a note inline carrying its run props', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), { footnotes: note('1', noteP('N')) }));
    const inl = (doc.blocks[0] as WmlParagraph).inlines[1];
    expect(inl).toMatchObject({ kind: 'note', note: 'footnote', id: '1' });
    expect((inl as { props: { bold: boolean } }).props.bold).toBe(true);
  });
  it('customMarkFollows: the following text is the mark, not body text', () => {
    const body = p(r('a') + `<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r>` + r('b'));
    const doc = readDocx(buildDocx(body, { footnotes: note('1', noteP('N')) }));
    const ps = doc.blocks[0] as WmlParagraph;
    expect(ps.inlines.find((i) => i.kind === 'note')).toMatchObject({ mark: '*' });
    expect(textOf([ps])).toBe('ab');
  });
  it('resolves a note’s hyperlink against footnotes.xml’s OWN relationships (Review Focus 1)', () => {
    const fnBody = p(`<w:hyperlink r:id="rL1">${r('site')}</w:hyperlink>`);
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), {
      footnotes: note('1', fnBody),
      footnoteRels: [{ id: 'rL1', type: 'hyperlink', target: 'https://example.com/fn', external: true }],
    }));
    const link = (doc.footnotes!.get('1')![0] as WmlParagraph).inlines.find((i) => i.kind === 'text') as { link?: unknown };
    expect(link.link).toEqual({ url: 'https://example.com/fn' });
  });
  it('endnotes.xml likewise', () => {
    const doc = readDocx(buildDocx(p(r('a') + '<w:r><w:endnoteReference w:id="2"/></w:r>'), {
      endnotes: '<w:endnote w:id="2">' + p('<w:r><w:endnoteRef/></w:r>' + r(' E.')) + '</w:endnote>',
    }));
    expect(textOf(doc.endnotes!.get('2')!)).toBe(' E.');
  });
  it('a missing notes part leaves footnotes undefined and records it (Review Focus 5)', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1')), {
      rels: [{ id: 'rX', type: 'footnotes', target: 'nowhere.xml' }],
    }));
    expect(doc.footnotes).toBeUndefined();
    expect(doc.unsupported).toContainEqual({ name: 'footnotes.xml: missing', count: 1 });
  });
  it('no notes part at all: footnotes undefined, nothing recorded by the reader', () => {
    const doc = readDocx(buildDocx(p(r('a') + fnRef('1'))));
    expect(doc.footnotes).toBeUndefined();
    expect(doc.unsupported).toEqual([]);
  });
});

describe('numbering properties', () => {
  it('reads settings.xml footnotePr / endnotePr', () => {
    const doc = readDocx(buildDocx(p(r('a')), { settings:
      '<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/><w:numRestart w:val="eachPage"/><w:pos w:val="pageBottom"/></w:footnotePr>'
      + '<w:endnotePr><w:numFmt w:val="upperLetter"/></w:endnotePr>' }));
    expect(doc.notePr.settings).toEqual({
      footnotePr: { numFmt: 'lowerRoman', numStart: 3, numRestart: 'eachPage', pos: 'pageBottom' },
      endnotePr: { numFmt: 'upperLetter' },
    });
  });
  it('a section-ending paragraph carries its section’s properties; the body sectPr is the last', () => {
    const sect1 = '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr></w:sectPr>';
    const body = p(r('one'), sect1) + p(r('two'))
      + '<w:sectPr><w:footnotePr><w:numFmt w:val="chicago"/></w:footnotePr></w:sectPr>';
    const doc = readDocx(buildDocx(body));
    expect((doc.blocks[0] as WmlParagraph).sectionEnd).toEqual({ footnotePr: { numRestart: 'eachSect' } });
    expect((doc.blocks[1] as WmlParagraph).sectionEnd).toBeUndefined();
    expect(doc.notePr.last).toEqual({ footnotePr: { numFmt: 'chicago' } });
  });
  it('a junk numStart is not kept', () => {
    const doc = readDocx(buildDocx(p(r('a')), { settings: '<w:footnotePr><w:numStart w:val="x"/></w:footnotePr>' }));
    expect(doc.notePr.settings).toEqual({});
  });
});
```

`p(inner, pPr)` puts `pPr` inside `<w:pPr>`; check `test/helpers/wml.ts` and pass the `sectPr` XML as the second argument. `body` with a trailing `<w:sectPr>` is a body-level `sectPr` — check that `docXml` wraps `bodyXml` verbatim inside `<w:body>`.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/wml-notes.test.ts`
Expected: FAIL (`footnotes` undefined everywhere; no `note` inline).

- [ ] **Step 4: Implement**

`src/wmlnotes.ts` (new):

```ts
/** Word's note NUMBERING properties (v9j3.3.2): `w:footnotePr` / `w:endnotePr`
 *  in settings.xml (the document defaults) and in each section's `sectPr`. A
 *  leaf over wmlns.ts; it never throws on content — an unreadable value is
 *  simply not kept — and resolves nothing: what a section's effective numbering
 *  is, is the mapper's (wmlflow.ts) decision. */
import type { LoadLimits } from './loadlimits.js';
import type { NsElement } from './xmlns.js';
import { PdfParseError } from './errors.js';
import { parseWml, W, wAttr, wChild } from './wmlns.js';

export interface WmlNotePr { numFmt?: string; numStart?: number; numRestart?: string; pos?: string }
export interface WmlSectionNotes { footnotePr?: WmlNotePr; endnotePr?: WmlNotePr }

/** A footnotePr/endnotePr element's four properties, only those stated and
 *  readable; undefined when none is. */
export function readNotePr(el: NsElement | undefined): WmlNotePr | undefined {
  if (el === undefined) return undefined;
  const out: WmlNotePr = {};
  const fmt = wAttr(wChild(el, 'numFmt'), 'val');
  if (fmt) out.numFmt = fmt;
  const start = wAttr(wChild(el, 'numStart'), 'val');
  if (start !== undefined && /^\d+$/.test(start) && Number(start) >= 1) out.numStart = Number(start);
  const restart = wAttr(wChild(el, 'numRestart'), 'val');
  if (restart) out.numRestart = restart;
  const pos = wAttr(wChild(el, 'pos'), 'val');
  if (pos) out.pos = pos;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A sectPr's (or settings') note properties. */
export function readSectionNotes(el: NsElement | undefined): WmlSectionNotes {
  const out: WmlSectionNotes = {};
  const f = readNotePr(wChild(el, 'footnotePr'));
  if (f) out.footnotePr = f;
  const e = readNotePr(wChild(el, 'endnotePr'));
  if (e) out.endnotePr = e;
  return out;
}

export function parseSettingsNotes(bytes: Uint8Array, limits: LoadLimits): WmlSectionNotes {
  const root = parseWml(bytes, limits);
  if (root.ns !== W || root.local !== 'settings') throw new PdfParseError('settings.xml: the root is not w:settings');
  return readSectionNotes(root);
}
```

Check `wChild`'s signature accepts `undefined` (it is called that way across wmlbody.ts) and that `NsElement` is exported from `xmlns.ts`.

`src/wmlbody.ts`:
- import `readSectionNotes, type WmlSectionNotes` from `./wmlnotes.js`.
- types:

```ts
/** A footnote or endnote reference (v9j3.3.2). `props` is the reference run's
 *  resolved style (a mark in bold text is bold); `mark` is a custom mark
 *  (`w:customMarkFollows`), the run's following text. */
export interface WmlNoteRef { kind: 'note'; note: 'footnote' | 'endnote'; id: string; props: RunProps; mark?: string }
```

add `| WmlNoteRef` to `WmlInline`; add to `WmlParagraph`:
`/** This paragraph ends a section: that section's note properties (v9j3.3.2). */ sectionEnd?: WmlSectionNotes;`
and `BodyResult` gains `lastSection: WmlSectionNotes;`.
- `DROPPED` gains `'footnoteRef', 'endnoteRef'` (Word's own number inside a note body: the engine draws the gutter mark).
- `paragraph()`: after `if (sect) { this.note('w:sectPr'); this.section(sect); }` it builds `para`; after `para` is built add
  `if (sect) para.sectionEnd = readSectionNotes(sect);`
- `run()`: before `for (const c of r.children) {` add `let awaitingMark: WmlNoteRef | undefined;` and in the switch:

```ts
        case 't':
          if (awaitingMark) { if (!this.skipping()) awaitingMark.mark = c.text; awaitingMark = undefined; break; }
          text(c.text);
          break;
        case 'footnoteReference':
        case 'endnoteReference': {
          const id = wAttr(c, 'id');
          if (id === undefined || this.skipping()) break;
          const ref: WmlNoteRef = { kind: 'note', note: c.local === 'footnoteReference' ? 'footnote' : 'endnote', id, props: rr.props };
          other(ref);
          if (onOff(c, 'customMarkFollows') === true) awaitingMark = ref;
          break;
        }
```

(replace the existing `case 't': text(c.text); break;`. Check `onOff`'s signature in wmlbody.ts/wmlns.ts — it reads an ST_OnOff attribute; if it only reads `w:val`, read the attribute directly: `const cmf = wAttr(c, 'customMarkFollows'); if (cmf === '1' || cmf === 'true' || cmf === 'on') awaitingMark = ref;`.)
- `parseBody`: return `lastSection: readSectionNotes(wChild(body, 'sectPr'))` in both branches of its return.
- new export beside `parseBody`:

```ts
/** footnotes.xml / endnotes.xml (v9j3.3.2): each note's blocks by `w:id`,
 *  through the SAME Walker the body uses — so a note's lists, tables, images
 *  and links resolve by the body's rules — with `ctx.rel` being THIS part's
 *  relationships. Separator entries (`w:type` separator, continuationSeparator,
 *  continuationNotice) are skipped: the engine draws its own rule. */
export function parseNotes(bytes: Uint8Array, ctx: BodyContext, kind: 'footnote' | 'endnote'): { notes: Map<string, WmlBlock[]>; unsupported: Map<string, number> } {
  const root = parseWml(bytes, ctx.limits);
  const plural = `${kind}s`;
  if (root.ns !== W || root.local !== plural) throw new PdfParseError(`${plural}.xml: the root is not w:${plural}`);
  const walker = new Walker(ctx);
  const notes = new Map<string, WmlBlock[]>();
  for (const n of wChildren(root, kind)) {
    const type = wAttr(n, 'type');
    if (type !== undefined && type !== 'normal') continue;
    const id = wAttr(n, 'id');
    if (id === undefined || notes.has(id)) continue;
    notes.set(id, walker.blocksOf(n));
  }
  walker.finish();
  return { notes, unsupported: walker.unsupported };
}
```

(import `wChildren` from `./wmlns.js` if not already.)

`src/wmlread.ts`:
- imports: `parseNotes` from `./wmlbody.js`; `parseSettingsNotes, type WmlSectionNotes` from `./wmlnotes.js`.
- constants beside `THEME`:

```ts
const FOOTNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
const ENDNOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes';
const SETTINGS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings';
```

- `WmlDocument` gains:

```ts
  /** Footnote / endnote bodies by w:id (v9j3.3.2); undefined when the document
   *  has no usable part — a missing or unreadable one is also recorded. */
  footnotes?: Map<string, WmlBlock[]>;
  endnotes?: Map<string, WmlBlock[]>;
  /** Note numbering properties: settings.xml's, and the LAST section's. */
  notePr: { settings: WmlSectionNotes; last: WmlSectionNotes };
```

- in `openDocx`, after `numbering` is read:

```ts
  const settingsNotes: WmlSectionNotes = optional('settings.xml', SETTINGS, (b) => parseSettingsNotes(b, limits), {});
```

- after `const rel = …` (the main part's resolver) and BEFORE `parseBody`, add a per-part relationship resolver and read both notes parts:

```ts
  // A notes part resolves r:ids against ITS OWN relationships (v9j3.3.2).
  const relOf = (part: string) => {
    let prs: readonly OpcRelationship[] = [];
    try { prs = pkg.relationships(part); } catch (caught) { rethrowLimit(caught); note(`${part.slice(part.lastIndexOf('/') + 1)}.rels: unreadable`); }
    const ids = new Map(prs.map((x) => [x.id, x]));
    return (id: string): BodyRel | undefined => {
      const x = ids.get(id);
      if (x?.part === undefined || pkg.has(x.part)) return x;
      return { target: x.target, external: x.external };
    };
  };
  const notesOf = (kind: 'footnote' | 'endnote', type: string): Map<string, WmlBlock[]> | undefined => {
    const role = `${kind}s.xml`;
    const r = rels.find((x) => isType(x, type));
    if (r === undefined) return undefined;
    if (r.part === undefined || !pkg.has(r.part)) { note(`${role}: missing`); return undefined; }
    try {
      const got = parseNotes(pkg.read(r.part), { styles, numbering, limits, rel: relOf(r.part) }, kind);
      for (const [name, count] of got.unsupported) note(name, count);
      return got.notes;
    } catch (caught) { rethrowLimit(caught); note(`${role}: unreadable`); return undefined; }
  };
  const footnotes = notesOf('footnote', FOOTNOTES);
  const endnotes = notesOf('endnote', ENDNOTES);
```

- build `doc` with `notePr: { settings: settingsNotes, last: body.lastSection }` and, after it, `if (footnotes) doc.footnotes = footnotes; if (endnotes) doc.endnotes = endnotes;`. Import `WmlBlock` and `BodyRel` types as needed.

- [ ] **Step 5: Run to verify they pass, plus the DOCX reader suites**

Run: `npx vitest run test/wml-notes.test.ts test/wmlread.test.ts test/wml-oracle.test.ts test/opcread-docx.test.ts test/docx-truth.test.ts`
Expected: PASS. (`docx-corpus.test.ts` now fails on its "records every construct" case for the `skipped` files — that is Task 5's to fix; do not touch it here. Note it in the ledger.) `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` — fix compile errors in consumers that switch over `WmlInline` exhaustively by adding a `note` case that does nothing (`test/helpers/docx-truth.ts`'s `inlineText` default already returns `''`).

- [ ] **Step 6: Commit**

```bash
git add src/wmlnotes.ts src/wmlbody.ts src/wmlread.ts test/helpers/build-docx.ts test/wml-notes.test.ts
git commit -m "feat(v9j3.3.2): read Word footnotes, endnotes and their numbering properties"
```

---

### Task 4: Mapping and the three entry points

**Files:**
- Modify: `src/wmlruns.ts` (`RunCtx.cite`/`refusal`; the `note` inline; runs typed `FlowTextRun[]`)
- Modify: `src/wmlflow.ts` (`noteFormat`, `docxNoteOptions`, `DROPPED`, note bodies, cell refusal, section restarts, `wmlElements` result gains `notes`)
- Modify: `src/wmlimport.ts` (`docxElements` returns `notes`)
- Modify: `src/flow.ts` (`AddDocx` mismatch report), `src/document.ts` (`AddDocx` passes Word's note options), `src/page.ts` (`AddDocx` via `notesAsTrailing`; shared trailing helper with `AddMarkdown`)
- Modify: `test/docx-import.test.ts`, `test/docx-file.test.ts` only if their footnote expectations move (they should not: no notes part → `w:footnoteReference` dropped, as before)
- Test: `test/docx-notes.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 `noteRestart`; Task 2 `restart: 'page'`; Task 3 model.
- Produces:

```ts
// wmlflow.ts
export function noteFormat(numFmt: string | undefined): MarkFormat | undefined; // undefined: unmappable
export interface DocxNoteOptions { footnotes: FlowNoteOptions; endnotes: FlowEndnoteOptions; skipped: string[] }
export function docxNoteOptions(doc: WmlDocument): DocxNoteOptions;
export function sectionNotes(doc: WmlDocument): WmlSectionNotes[]; // effective, one per section, in order
// wmlElements(...) returns { segments, skipped, notes: DocxNoteOptions; cited: boolean }
```

- [ ] **Step 1: Write the failing tests**

```ts
// test/docx-notes.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';
import { docxNoteOptions } from '../src/wmlflow.js';
import { readDocx } from '../src/wmlread.js';
import type { StructElement } from '../src/struct.js';

const fnRef = (id: string) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
const enRef = (id: string) => `<w:r><w:endnoteReference w:id="${id}"/></w:r>`;
const fn = (id: string, body: string) => `<w:footnote w:id="${id}">${body}</w:footnote>`;
const en = (id: string, body: string) => `<w:endnote w:id="${id}">${body}</w:endnote>`;
const noteP = (t: string) => p(`<w:r><w:footnoteRef/></w:r>${r(' ' + t)}`);
const count = (t: string, s: string) => t.split(s).length - 1;

describe('doc.AddDocx footnotes and endnotes', () => {
  it('draws the mark and the note at the page foot; nothing reported', () => {
    const bytes = buildDocx(p(r('A claim.') + fnRef('1')), { footnotes: fn('1', noteP('The SOURCE.')) });
    const { pages, skipped } = Document.New().AddDocx(bytes);
    const f = pages[0].GetTextFragments();
    const note = f.find((x) => x.text.includes('SOURCE'))!;
    expect(note.quad[1]).toBeLessThan(f.find((x) => x.text.includes('claim'))!.quad[1]);
    expect(note.quad[1]).toBeLessThan(200);
    expect(skipped.filter((s) => s.name.includes('Reference'))).toEqual([]);
  });
  it('a note’s list and table render inside it', () => {
    const body = noteP('intro') + p(r('item one'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')
      + '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' + p(r('CELLINNOTE')) + '</w:tc></w:tr></w:tbl>';
    const numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const { pages } = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', body), numbering }));
    const t = pages[0].GetText();
    for (const s of ['intro', 'item one', 'CELLINNOTE']) expect(t).toContain(s);
  });
  it('a note’s external hyperlink is clickable (Review Focus 1)', () => {
    const bytes = buildDocx(p(r('t') + fnRef('1')), {
      footnotes: fn('1', p(`<w:hyperlink r:id="rL1">${r('LINKED')}</w:hyperlink>`)),
      footnoteRels: [{ id: 'rL1', type: 'hyperlink', target: 'https://example.com/n', external: true }],
    });
    const { pages } = Document.New().AddDocx(bytes);
    const uris = pages[0].Annotations.map((a) => (a as { URI?: string }).URI).filter(Boolean);
    expect(uris).toContain('https://example.com/n');
  });
  it('endnotes go after the content', () => {
    const bytes = buildDocx(p(r('A.') + enRef('2')) + p(r('closing')), { endnotes: en('2', p(r('ENDTEXT'))) });
    const f = Document.New().AddDocx(bytes).pages[0].GetTextFragments();
    expect(f.find((x) => x.text.includes('ENDTEXT'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('closing'))!.quad[1]);
  });
  it('a custom mark is drawn as the mark', () => {
    const body = p(r('star') + '<w:r><w:footnoteReference w:customMarkFollows="1" w:id="1"/><w:t>*</w:t></w:r>');
    const f = Document.New().AddDocx(buildDocx(body, { footnotes: fn('1', p(r('STARRED'))) })).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.trim() === '*').length).toBe(2);   // citation + gutter
  });
  it('lowerRoman from settings.xml, starting at 3', () => {
    const bytes = buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', p(r('N'))),
      settings: '<w:footnotePr><w:numFmt w:val="lowerRoman"/><w:numStart w:val="3"/></w:footnotePr>' });
    const f = Document.New().AddDocx(bytes).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.trim() === 'iii').length).toBe(2);
  });
  it('eachSect restarts at each section boundary', () => {
    const sect = '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr></w:sectPr>';
    const body = p(r('a') + fnRef('1')) + p(r('b') + fnRef('2'), sect) + p(r('c') + fnRef('3'))
      + '<w:sectPr><w:footnotePr><w:numRestart w:val="eachSect"/></w:footnotePr></w:sectPr>';
    const bytes = buildDocx(body, { footnotes: fn('1', p(r('N1'))) + fn('2', p(r('N2'))) + fn('3', p(r('N3'))) });
    const f = Document.New().AddDocx(bytes).pages[0].GetTextFragments();
    expect(f.filter((x) => x.text.trim() === '3')).toHaveLength(0);
    expect(f.filter((x) => x.text.trim() === '1')).toHaveLength(4);
  });
  it('a reference in a table cell draws nothing and is reported once per reference (Review Focus 4)', () => {
    const tbl = '<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>'
      + p(r('cell') + fnRef('1') + fnRef('2')) + '</w:tc></w:tr></w:tbl>';
    const { pages, skipped } = Document.New().AddDocx(buildDocx(tbl + p(r('after')),
      { footnotes: fn('1', p(r('CELLNOTE'))) + fn('2', p(r('CELLNOTE2'))) }));
    expect(pages[0].GetText()).toContain('cell');
    expect(pages[0].GetText()).toContain('after');
    expect(pages[0].GetText()).not.toContain('CELLNOTE');
    expect(skipped).toContainEqual({ name: 'w:footnoteReference (table cell)', count: 2, kind: 'dropped' });
  });
  it('an unknown id is reported; a missing part reports every reference (Review Focus 5)', () => {
    const a = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('9')), { footnotes: fn('1', p(r('N'))) }));
    expect(a.skipped).toContainEqual({ name: 'w:footnoteReference (unknown id)', count: 1, kind: 'dropped' });
    const b = Document.New().AddDocx(buildDocx(p(r('t') + fnRef('1') + fnRef('2')),
      { rels: [{ id: 'rX', type: 'footnotes', target: 'gone.xml' }] }));
    expect(b.skipped).toContainEqual({ name: 'w:footnoteReference', count: 2, kind: 'dropped' });
    expect(b.pages[0].GetText()).toContain('t');
  });
  it('reports unmappable format, endnote eachPage and non-default positions', () => {
    const o = docxNoteOptions(readDocx(buildDocx(p(r('x')), { settings:
      '<w:footnotePr><w:numFmt w:val="hebrew1"/><w:pos w:val="beneathText"/></w:footnotePr>'
      + '<w:endnotePr><w:numRestart w:val="eachPage"/><w:pos w:val="sectEnd"/></w:endnotePr>' })));
    expect(o.skipped.sort()).toEqual(['w:numFmt (footnote)', 'w:numRestart (endnote)', 'w:pos (endnote)', 'w:pos (footnote)']);
    expect(o.footnotes.format).toBe('arabic');
  });
  it('a section whose format differs from the last is reported', () => {
    const body = p(r('a'), '<w:sectPr><w:footnotePr><w:numFmt w:val="upperRoman"/></w:footnotePr></w:sectPr>') + p(r('b'));
    expect(docxNoteOptions(readDocx(buildDocx(body))).skipped).toContain('w:footnotePr (section)');
  });
  it('eachPage maps to restart: page', () => {
    const o = docxNoteOptions(readDocx(buildDocx(p(r('x')), { settings: '<w:footnotePr><w:numRestart w:val="eachPage"/></w:footnotePr>' })));
    expect(o.footnotes.restart).toBe('page');
  });
  it('the gutter mark is sized from the first note’s own text', () => {
    const big = p(`<w:r><w:rPr><w:sz w:val="28"/></w:rPr><w:t>BIGNOTE</w:t></w:r>`);   // 14pt
    expect(docxNoteOptions(readDocx(buildDocx(p(r('x') + fnRef('1')), { footnotes: fn('1', big) }))).footnotes.fontSize).toBe(14);
  });
  it('tagged: one /Note per note', () => {
    const doc = Document.New();
    doc.AddDocx(buildDocx(p(r('a') + fnRef('1')), { footnotes: fn('1', p(r('N'))) }), { tagged: true });
    const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
    expect(all(doc.GetStructTree()!).filter((e) => e.Type === 'Note')).toHaveLength(1);
  });
  it('a note-free DOCX is byte-identical to the same body without a notes part (Review Focus 3)', () => {
    const sha = (b: Uint8Array) => createHash('sha256')
      .update(Buffer.concat(Document.New().AddDocx(b).pages.map((pg) => Buffer.from(pg.Contents)))).digest('hex');
    const body = p(r('plain words')) + p(r('second'));
    expect(sha(buildDocx(body, { footnotes: fn('1', p(r('unused'))) }))).toBe(sha(buildDocx(body)));
  });
});

describe('page.AddDocx and flow.AddDocx', () => {
  it('page.AddDocx places notes after the content inside the rect', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r0 = page.AddDocx(buildDocx(p(r('A claim.') + fnRef('1'))), [72, 72, 400, 700]);
    expect(r0.skipped).toContainEqual({ name: 'w:footnoteReference', count: 1, kind: 'dropped' });
    const page2 = doc.AddPage().page;
    const r1 = page2.AddDocx(buildDocx(p(r('A claim.') + fnRef('1')), { footnotes: fn('1', p(r('RECTNOTE'))) }), [72, 72, 400, 700]);
    const f = page2.GetTextFragments();
    expect(f.find((x) => x.text.includes('RECTNOTE'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('claim'))!.quad[1]);
    expect(r1.remainder).toEqual([]);
  });
  it('flow.AddDocx reports Word numbering the flow does not follow', () => {
    const flow = Document.New().NewFlow();
    const { skipped } = flow.AddDocx(buildDocx(p(r('t') + fnRef('1')), { footnotes: fn('1', p(r('N'))),
      settings: '<w:footnotePr><w:numFmt w:val="lowerRoman"/></w:footnotePr>' }));
    expect(skipped).toContainEqual({ name: 'w:footnotePr', count: 1, kind: 'degraded' });
  });
});
```

`Annotations` and the link annotation's `URI` accessor: check the names in `src/annotation.ts` (`LinkAnnotation`) and use the real ones. `docxNoteOptions(...).skipped` is a `string[]` of names (all degraded); sort-compare as written.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/docx-notes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement — `wmlruns.ts`**

```ts
import type { WmlInline, WmlNoteRef, WmlText } from './wmlbody.js';
import type { FlowNote, FlowTextRun } from './flownotes.js';

export interface RunCtx {
  env: WmlFlowEnv;
  log: SkipLog;
  /** How a note reference becomes a cited note (v9j3.3.2); undefined result:
   *  `cite` reported why. ABSENT where a reference cannot be honoured — a table
   *  cell, a note body — and then `refusal` names the place in `skipped`. */
  cite?: (r: WmlNoteRef) => { kind: 'footnote' | 'endnote'; note: FlowNote } | undefined;
  refusal?: 'table cell' | 'in a note';
}
```

`inlineContent` returns `runs: FlowTextRun[]` (declare `const runs: FlowTextRun[] = [];`) and gains:

```ts
    } else if (i.kind === 'note') {
      const tag = i.note === 'footnote' ? 'w:footnoteReference' : 'w:endnoteReference';
      if (c.cite === undefined) { c.log.add(`${tag} (${c.refusal ?? 'table cell'})`, 'dropped'); continue; }
      const got = c.cite(i);
      if (got === undefined) continue;
      // An EMPTY run carrying the note, in the reference run's own face and size:
      // the engine draws the mark after it (a mark in bold text is bold).
      const fam = c.env.family(i.props.font);
      runs.push({ text: '', font: face(fam.family, i.props.bold, i.props.italic), fontSize: i.props.sizePt, [got.kind]: got.note });
    }
```

Do NOT log `i.props`'s unmodelled names: the reference run's superscript is the engine's to draw.

- [ ] **Step 4: Implement — `wmlflow.ts`**

- imports: `noteRestart, type FlowNote, type FlowNoteOptions, type FlowEndnoteOptions, type MarkFormat` from `./flownotes.js`; `type WmlNoteRef` from `./wmlbody.js`; `type WmlNotePr, type WmlSectionNotes` from `./wmlnotes.js`.
- `DROPPED` gains the four refused-reference names:

```ts
  'w:footnoteReference (table cell)', 'w:endnoteReference (table cell)',
  'w:footnoteReference (unknown id)', 'w:endnoteReference (unknown id)',
  'w:footnoteReference (in a note)', 'w:endnoteReference (in a note)',
```

- numbering resolution:

```ts
const NUM_FMT: Readonly<Record<string, MarkFormat>> = {
  decimal: 'arabic', lowerRoman: 'roman', upperRoman: 'Roman',
  lowerLetter: 'alpha', upperLetter: 'Alpha', chicago: 'symbols',
};
/** Word's w:numFmt as the engine's mark format; undefined when it has none. */
export function noteFormat(numFmt: string | undefined): MarkFormat | undefined {
  return numFmt !== undefined && Object.hasOwn(NUM_FMT, numFmt) ? NUM_FMT[numFmt] : undefined;
}

/** Each section's EFFECTIVE note properties, in order: its own sectPr's over
 *  settings.xml's, field by field. The last section is the body's sectPr. */
export function sectionNotes(doc: WmlDocument): WmlSectionNotes[] {
  const merge = (own: WmlSectionNotes): WmlSectionNotes => ({
    footnotePr: { ...doc.notePr.settings.footnotePr, ...own.footnotePr },
    endnotePr: { ...doc.notePr.settings.endnotePr, ...own.endnotePr },
  });
  const ends = doc.blocks.filter((b): b is WmlParagraph => b.kind === 'paragraph' && b.sectionEnd !== undefined);
  return [...ends.map((p) => merge(p.sectionEnd!)), merge(doc.notePr.last)];
}

export interface DocxNoteOptions { footnotes: FlowNoteOptions; endnotes: FlowEndnoteOptions; skipped: string[] }

/** The flow note options Word's numbering asks for, from the LAST section (as
 *  page geometry is), and what the engine cannot honour (all degraded). */
export function docxNoteOptions(doc: WmlDocument): DocxNoteOptions {
  const secs = sectionNotes(doc);
  const last = secs[secs.length - 1];
  const skipped: string[] = [];
  const opts = (kind: 'footnote' | 'endnote', pr: WmlNotePr | undefined, notes: Map<string, WmlBlock[]> | undefined) => {
    const o: FlowNoteOptions = {};
    if (pr?.numFmt !== undefined) {
      const f = noteFormat(pr.numFmt);
      if (f === undefined) { skipped.push(`w:numFmt (${kind})`); if (kind === 'footnote') o.format = 'arabic'; }
      else o.format = f;
    }
    if (pr?.numStart !== undefined) o.start = pr.numStart;
    if (pr?.numRestart === 'eachPage') {
      if (kind === 'footnote') o.restart = 'page';
      else skipped.push('w:numRestart (endnote)');
    }
    const pos = pr?.pos;
    if (pos !== undefined && pos !== (kind === 'footnote' ? 'pageBottom' : 'docEnd')) skipped.push(`w:pos (${kind})`);
    const size = firstNoteSize(notes);
    if (size !== undefined) o.fontSize = size;
    return o;
  };
  const footnotes = opts('footnote', last.footnotePr, doc.footnotes);
  const endnotes = opts('endnote', last.endnotePr, doc.endnotes) as FlowEndnoteOptions;
  for (const kind of ['footnote', 'endnote'] as const) {
    const key = kind === 'footnote' ? 'footnotePr' : 'endnotePr';
    const differs = secs.slice(0, -1).some((s) => s[key]?.numFmt !== last[key]?.numFmt || s[key]?.numStart !== last[key]?.numStart);
    if (differs) skipped.push(`w:${key} (section)`);
  }
  return { footnotes, endnotes, skipped };
}

/** The first note's first paragraph's largest text size: the size the engine's
 *  gutter mark is drawn against. */
function firstNoteSize(notes: Map<string, WmlBlock[]> | undefined): number | undefined {
  const first = notes?.values().next().value;
  const para = first?.find((b): b is WmlParagraph => b.kind === 'paragraph');
  const sizes = para?.inlines.flatMap((i) => (i.kind === 'text' ? [i.props.sizePt] : [])) ?? [];
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}
```

(the unmappable endnote format leaves the engine's own default, lower roman — only a footnote falls back to `'arabic'` explicitly, which is the engine default anyway; keep the assignment so the intent reads.)

- `Ctx` gains `noteSection?: { idx: number; restartAt: ('footnote' | 'endnote')[][] }` — `restartAt[k]` lists the kinds whose section `k + 1` restarts each section.
- note bodies and citing, in `wmlElements`:

```ts
export function wmlElements(doc: WmlDocument, width: number, env: WmlFlowEnv): {
  segments: FlowElement[][]; skipped: DocxSkipped[]; notes: DocxNoteOptions; cited: boolean;
} {
  const log = new SkipLog();
  for (const u of doc.unsupported) log.add(u.name, kindOf(u.name), u.count);
  const notes = docxNoteOptions(doc);
  for (const s of notes.skipped) log.add(s, 'degraded');
  const secs = sectionNotes(doc);
  const restartAt = secs.slice(1).map((s) => (['footnote', 'endnote'] as const)
    .filter((k) => s[k === 'footnote' ? 'footnotePr' : 'endnotePr']?.numRestart === 'eachSect'));
  const c: Ctx = { env, log, width, segments: [[]], gap: 0, prevAfter: 0, noteSection: { idx: 0, restartAt } };
  const built = { footnote: new Map<string, FlowNote>(), endnote: new Map<string, FlowNote>() };
  let cited = false;
  c.cite = (ref: WmlNoteRef) => {
    const part = ref.note === 'footnote' ? doc.footnotes : doc.endnotes;
    const tag = ref.note === 'footnote' ? 'w:footnoteReference' : 'w:endnoteReference';
    if (part === undefined) { log.add(tag, 'dropped'); return undefined; }
    const blocks = part.get(ref.id);
    if (blocks === undefined) { log.add(`${tag} (unknown id)`, 'dropped'); return undefined; }
    let note = built[ref.note].get(ref.id);
    if (note === undefined) {
      note = { content: noteElements(blocks, c), ...(ref.mark !== undefined ? { mark: ref.mark } : {}) };
      built[ref.note].set(ref.id, note);
    }
    cited = true;
    return { kind: ref.note, note };
  };
  blockElements(doc.blocks, c);
  return { segments: c.segments, skipped: log.list(), notes, cited };
}

/** A note's blocks as flow elements, mapped by the same block mapper at the
 *  note's own Word styles, with references inside it refused (notes do not
 *  nest). A page or column break inside a note cannot be honoured. */
function noteElements(blocks: WmlBlock[], parent: Ctx): FlowElement[] {
  const nc: Ctx = { env: parent.env, log: parent.log, width: parent.width, segments: [[]], gap: 0, prevAfter: 0, refusal: 'in a note' };
  blockElements(blocks, nc);
  if (nc.segments.length > 1) parent.log.add('w:br (page)', 'degraded', nc.segments.length - 1);
  return nc.segments.flat();
}
```

- `blockElements`: after the paragraph branch processes `b` (after the `parts.forEach(…)`), add:

```ts
      if (b.sectionEnd !== undefined && c.noteSection !== undefined) {
        const kinds = c.noteSection.restartAt[c.noteSection.idx++] ?? [];
        for (const k of kinds) cur(c).push(noteRestart(k));
      }
```

- `cellContent`: replace `const got = inlineContent(inl, c);` with
  `const got = inlineContent(inl, { ...c, cite: undefined, refusal: 'table cell' });`

`blockElements` is called with the body `Ctx` only from `wmlElements` and `noteElements`; a note `Ctx` has no `noteSection`, so a `sectPr` inside a note (Word never writes one) restarts nothing.

- [ ] **Step 5: Implement — the entry points**

`src/wmlimport.ts` — `docxElements` returns `{ segments; skipped; notes: DocxNoteOptions; cited: boolean }` (pass `wmlElements`'s result through; import the type).

`src/flow.ts` `AddDocx`:

```ts
    const { segments, skipped, notes, cited } = docxElements(this.doc, src, this.geometry.columnWidth, options);
    segments.forEach((els, k) => {
      if (k > 0) this.AddColumnBreak();
      this.items.push(...els);
    });
    // Word's numbering applies through doc.AddDocx, which builds the flow from
    // it; a flow built otherwise keeps its own and says so (v9j3.3.2).
    const extra: DocxSkipped[] = [];
    if (cited) {
      const same = (w: ResolvedNoteOptions, mine: ResolvedNoteOptions) =>
        w.format === mine.format && w.start === mine.start && w.restart === mine.restart;
      if (!same(normalizeNoteOptions(notes.footnotes, 'footnote'), this.footOpts))
        extra.push({ name: 'w:footnotePr', count: 1, kind: 'degraded' });
      if (!same(normalizeNoteOptions(notes.endnotes, 'endnote'), this.endOpts))
        extra.push({ name: 'w:endnotePr', count: 1, kind: 'degraded' });
    }
    return { skipped: extra.length > 0 ? mergeSkipped(skipped, extra) : skipped };
```

(import `mergeSkipped` and `DocxSkipped` from `./wmlflow.js` / `./wmlimport.js` as `flow.ts` already does for the DOCX types; `ResolvedNoteOptions` from `./flownotes.js`.) `normalizeNoteOptions` here never throws: `docxNoteOptions` only produces valid values (a `start` ≥ 1, a known format, `restart: 'page'` for footnotes alone).

`src/document.ts` `AddDocx` — after `const pg = …`:

```ts
    // Word's note numbering (v9j3.3.2), the caller's explicit options winning.
    const word = docxNoteOptions(src.opened.doc);
    const noteOptions = (w: object, mine: unknown): unknown =>
      mine === undefined ? w : typeof mine === 'object' && mine !== null && !Array.isArray(mine) ? { ...w, ...mine } : mine;
```

and in BOTH `flowOptions` object literals, after `...options`, add
`footnotes: noteOptions(word.footnotes, options.footnotes) as FlowOptions['footnotes'], endnotes: noteOptions(word.endnotes, options.endnotes) as FlowOptions['endnotes'],`
(a non-object caller value passes through so the Flow still refuses it). Import `docxNoteOptions` from `./wmlflow.js`.

`src/page.ts`: extract the Markdown trailing-notes block into a private method shared by `AddMarkdown` and `AddDocx`:

```ts
  /** Notes for one rect (v9j3.3.1/.2): numbered and placed after the content,
   *  tagged under `structParent` as a flow tags them. Returns the elements to
   *  place and a `done()` that registers the note IDs once placement is over. */
  private trailingNotes(
    elements: FlowElement[], foot: FlowNoteOptions, end: FlowEndnoteOptions, structParent: StructElement | undefined,
  ): { placed: FlowElement[]; done(): void } {
    const root = structParent !== undefined ? this.doc.GetStructTree() ?? undefined : undefined;
    const tagging = structParent !== undefined && root !== undefined
      ? { parent: structParent, taken: takenIds(this.doc, root.Dict), entries: [] as Array<[string, PdfRef]> }
      : undefined;
    const placed = notesAsTrailing(elements, normalizeNoteOptions(foot, 'footnote'), normalizeNoteOptions(end, 'endnote'),
      (t, size) => paragraph(t, { fontSize: size }), tagging);
    return {
      placed,
      done: () => { if (tagging !== undefined && root !== undefined && tagging.entries.length > 0) registerStructIds(this.doc, root.Dict, tagging.entries); },
    };
  }
```

`AddMarkdown` uses it with `{ fontSize }` / `{ fontSize }` (its existing `fontSize`), placing `t.placed` and calling `t.done()` after `placeElements` — behaviour unchanged, so `test/markdown-footnotes.test.ts` is the fence. `AddDocx`:

```ts
    const { segments, skipped, notes } = docxElements(this.doc, bytes, rect[2], { ...options, onSkipped });
    if (segments.length > 1) late.add('w:br (page)', 'degraded', segments.length - 1);
    const t = this.trailingNotes(segments.flat(), notes.footnotes, notes.endnotes, options.structParent);
    const { usedHeight, remainder } = placeElements(this.doc, this, t.placed, rect, {
      paragraphSpacing: 0, structParent: options.structParent,
    });
    t.done();
```

(`segments.length` counts break segments only; `noteRestart` elements live inside segments and do not add any.)

- [ ] **Step 6: Run to verify they pass, plus the DOCX and Markdown suites**

Run: `npx vitest run test/docx-notes.test.ts test/docx-import.test.ts test/docx-file.test.ts test/docx-flow-identity.test.ts test/markdown-footnotes.test.ts test/flow-notes-identity.test.ts test/import-cycles.test.ts test/limits-catch.test.ts`
Expected: PASS. `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` → `tsc=0`. If `docx-import.test.ts`'s footnote case changed count or name, that is a behaviour change: stop and find why (with no notes part it must still be `w:footnoteReference` / dropped / 2).

- [ ] **Step 7: Commit**

```bash
git add src/wmlruns.ts src/wmlflow.ts src/wmlimport.ts src/flow.ts src/document.ts src/page.ts test/docx-notes.test.ts
git commit -m "feat(v9j3.3.2): render Word footnotes and endnotes through the Flow engine"
```

---

### Task 5: The oracle — Word 2010 and LibreOffice read notes

**Files:**
- Modify: `scripts/gen-docx-corpus-word.ps1` (`notes` recipe; `-Only` parameter), `scripts/gen-docx-corpus-lo.py` (`notes` recipe; optional topic argument), `scripts/gen-docx-corpus.ps1` (`-Only` passed through)
- Modify: `scripts/docx-truth-word.ps1`, `scripts/docx-truth-lo.py` (a `notes` field)
- Modify: `test/helpers/docx-truth.ts` (`notes` in the schema, the shape check, `comparable`, `readerDisagreements`, `truthOf`)
- Modify: `test/docx-corpus.test.ts`, `test/docx-import-corpus.test.ts` (notes are modelled now)
- Create (generated): `test/fixtures/docx/word2010-notes.docx`, `lo26.8-notes.docx` and their `.word.json`/`.lo.json`; every existing `*.word.json`/`*.lo.json` gains `notes`; `disagreements.json` regenerated
- Modify: `test/fixtures/docx/PROVENANCE.md`

**Interfaces:**
- Consumes: Task 3 model; Task 4 `noteFormat`, `sectionNotes`.
- Produces: `DocxTruth.notes: { footnotes: TruthNote[]; endnotes: TruthNote[] }`, `TruthNote = { mark: string; text: string }`.

- [ ] **Step 1: Probe what each reader reports for a note's mark**

Write `%TEMP%\probe-notes.ps1` (not committed) that opens `test/fixtures/docx/word2010-skipped.docx` read-only through Word COM and prints, for `Footnotes.Item(1)` and `Endnotes.Item(1)`: `[int][char]$fn.Reference.Text[0]`, `$fn.Index`, `$fn.Reference.Sections.Item(1).Range.FootnoteOptions.NumberStyle`, `.StartingNumber`, `.NumberingRule`, and `$fn.Range.Text`. Write `%TEMP%\probe-notes.py` (run with LibreOffice's `python.exe`, reusing `docx-truth-lo.py`'s `Office` context — copy its helper block) printing for `doc.Footnotes.getByIndex(0)`: `getLabel()`, `getAnchor().getString()`, `getString()`.
Expected: Word's `Reference.Text` is a control character (0x02) for an auto-numbered note; LibreOffice's anchor string is the displayed number (`1`, `i`). Record both outputs in the ledger. If Word's `Reference.Text` is instead the printable number, Step 3's Word half uses it directly for every note and skips the derivation; if LibreOffice's anchor string is empty, use `getLabel()` when non-empty and otherwise the derivation of Step 3's Word half applied to `doc.FootnoteSettings` (`NumberingType`, `StartAt`) — and say so in PROVENANCE.

- [ ] **Step 2: Add the `notes` recipes and the `-Only` switch**

`scripts/gen-docx-corpus-word.ps1`: `param([string]$OutDir = …, [string]$Only = '')`; wrap each `# ---- <topic> ----` block in `if (-not $Only -or $Only -eq '<topic>') { … }`. Add before `} finally {`:

```powershell
  # ---- notes (v9j3.3.2) ----
  if (-not $Only -or $Only -eq 'notes') {
  New-Doc
  P (S -2) @('Notes')
  $sel.TypeText('Alpha'); $d.Footnotes.Add($sel.Range).Range.Text = 'First note.'; Endpos; $sel.TypeParagraph()
  $sel.TypeText('Beta'); $fn = $d.Footnotes.Add($sel.Range); $fn.Range.Text = 'Para one.'
  $fn.Range.InsertParagraphAfter(); $fn.Range.InsertAfter('Para two.'); Endpos; $sel.TypeParagraph()
  $sel.TypeText('Gamma'); $d.Footnotes.Add($sel.Range, '*').Range.Text = 'Starred note.'; Endpos; $sel.TypeParagraph()
  $sel.TypeText('Delta'); $d.Endnotes.Add($sel.Range).Range.Text = 'An endnote.'; Endpos; $sel.TypeParagraph()
  $t = $d.Tables.Add($sel.Range, 1, 2); $t.Borders.Enable = $true
  $t.Cell(1, 1).Range.Text = 'Cell'; $d.Footnotes.Add($t.Cell(1, 2).Range).Range.Text = 'Cell note.'
  Endpos; $sel.TypeParagraph()
  $sel.InsertBreak(2)                                              # wdSectionBreakNextPage
  $o = $d.Sections.Item(2).Range.FootnoteOptions
  $o.NumberStyle = 2; $o.NumberingRule = 1; $o.StartingNumber = 1  # lowercase roman, restart each section
  $sel.TypeText('Epsilon'); $d.Footnotes.Add($sel.Range).Range.Text = 'Second section note.'; Endpos; $sel.TypeParagraph()
  Save-Doc 'notes'
  }
```

The table's footnote is the LAST in section 1 on purpose: the renderer drops a cell reference (until v9j3.3.3), so any note after it would be numbered one lower than Word numbers it.

`scripts/gen-docx-corpus-lo.py`: add

```python
def notes_doc(o, tag):
    w = Writer(o)
    fs = w.doc.FootnoteSettings
    fs.NumberingType = 3          # com.sun.star.style.NumberingType.ROMAN_LOWER
    fs.StartAt = 2                # LibreOffice counts StartAt from 0: the first note reads iii
    w.para('Heading 1', ['Notes'])
    for word, text in (('Alpha', 'First note.'), ('Beta', 'Second note.')):
        w.para('Standard', [word])
        fn = w.doc.createInstance('com.sun.star.text.Footnote'); w.text.insertTextContent(w.cur, fn, False); fn.setString(text)
    w.para('Standard', ['Gamma'])
    fn = w.doc.createInstance('com.sun.star.text.Footnote'); fn.setLabel('*')
    w.text.insertTextContent(w.cur, fn, False); fn.setString('Starred note.')
    w.para('Standard', ['Delta'])
    en = w.doc.createInstance('com.sun.star.text.Endnote'); w.text.insertTextContent(w.cur, en, False); en.setString('An endnote.')
    w.save('lo%s-notes.docx' % tag)
```

and in `main()` call it — honouring an optional topic: `only = sys.argv[2] if len(sys.argv) > 2 else ''` and wrap each `*_doc(...)` call as `if not only or only == '<topic>': …`. (Check `main()`'s argv layout: argv[1] is the output directory.) The two recipes differ deliberately: LibreOffice's footnote numbering is document-wide, so its file exercises format + start while Word's exercises a per-section restart — each file is read by BOTH readers, which is what the corpus compares. Update both scripts' header comments (they say the recipes mirror each other "text for text") to name this exception.

`scripts/gen-docx-corpus.ps1`: `param(..., [string]$Only = '')`; pass `-Only $Only` to the Word builder and `$Only` as the LibreOffice builder's second argument.

- [ ] **Step 3: Teach both truth readers `notes`**

`scripts/docx-truth-word.ps1` — before `$counts = …` add:

```powershell
    # Notes (v9j3.3.2): text, and the mark Word shows. Word reports an
    # auto-numbered mark as a control character, so the number is derived from
    # what WORD reports — the note's section, its NumberStyle, StartingNumber and
    # NumberingRule — counting only auto-numbered notes. A custom mark is its text.
    function Fmt([int]$n, [int]$style) {
      switch ($style) {
        1 { return (Roman $n).ToUpper() } 2 { return Roman $n }
        3 { return ([string][char](64 + (($n - 1) % 26) + 1)) * ([math]::Floor(($n - 1) / 26) + 1) }
        4 { return ([string][char](96 + (($n - 1) % 26) + 1)) * ([math]::Floor(($n - 1) / 26) + 1) }
        9 { $sym = @('*', [string][char]0x2020, [string][char]0x2021, [string][char]0x00A7); return $sym[($n - 1) % 4] * ([math]::Floor(($n - 1) / 4) + 1) }
        default { return [string]$n }
      }
    }
    function Roman([int]$n) {
      $vals = 1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1
      $syms = 'm', 'cm', 'd', 'cd', 'c', 'xc', 'l', 'xl', 'x', 'ix', 'v', 'iv', 'i'
      $s = ''; for ($i = 0; $i -lt 13; $i++) { while ($n -ge $vals[$i]) { $s += $syms[$i]; $n -= $vals[$i] } }; return $s
    }
    function NotesOf($coll, [bool]$foot) {
      $out = @(); $count = @{}
      for ($i = 1; $i -le $coll.Count; $i++) {
        $n = $coll.Item($i)
        $text = ((Clean ($n.Range.Text -replace "`r", "`n")) -replace '^[\s]+', '').Trim()
        $ref = [string]$n.Reference.Text
        if ($ref.Length -ge 1 -and [int][char]$ref[0] -ge 32) { $mark = $ref }
        else {
          $sec = $n.Reference.Sections.Item(1)
          $opt = if ($foot) { $sec.Range.FootnoteOptions } else { $sec.Range.EndnoteOptions }
          $key = if ($opt.NumberingRule -eq 1) { "s$($sec.Index)" } else { 'doc' }
          $count[$key] = 1 + [int]$count[$key]
          $mark = Fmt ($opt.StartingNumber + $count[$key] - 1) $opt.NumberStyle
        }
        $out += ,([ordered]@{ mark = $mark; text = $text })
      }
      return ,$out
    }
    $notes = [ordered]@{ footnotes = (NotesOf $d.Footnotes $true); endnotes = (NotesOf $d.Endnotes $false) }
```

and add `notes = $notes` to the truth object that is written out (find where `reader`, `paragraphs`, `counts` are assembled into the ordered hashtable, and make sure an empty or one-element array survives `ConvertTo-Json` as an array — the script already guards `paragraphs` against PowerShell's scalar collapse; use the same guard). Per-page restart (`NumberingRule -eq 2`) is not derived: the recipes do not use it, and a page number is Word's layout, not the document's.

`scripts/docx-truth-lo.py` — in `read()`, before the `return`:

```python
        def notes_of(coll):
            out = []
            for i in range(coll.getCount()):
                n = coll.getByIndex(i)
                out.append({'mark': n.getLabel() or n.getAnchor().getString(), 'text': clean(n.getString()).strip()})
            return out
        notes = {'footnotes': notes_of(doc.Footnotes), 'endnotes': notes_of(doc.Endnotes)}
```

and add `'notes': notes` to the returned dict. Apply Step 1's findings to the mark expression if they differ.

- [ ] **Step 4: Extend the schema and the projection (failing first)**

`test/helpers/docx-truth.ts`:
- `export interface TruthNote { mark: string; text: string }`; `DocxTruth` and `Comparable` gain `notes: { footnotes: TruthNote[]; endnotes: TruthNote[] }`.
- `assertTruthShape`: `notes` must be an object with two arrays whose items have string `mark` and `text` (report `notes.footnotes[i]` on failure).
- `comparable` passes `notes` through; `readerDisagreements` already diffs `comparable`.
- `truthOf` computes ours:

```ts
import { formatMark } from '../../src/flownotes.js';
import { noteFormat, sectionNotes } from '../../src/wmlflow.js';

/** Our notes in the truth schema: each reference in document order, its note's
 *  text, and the mark Word's numbering gives it — resolved by wmlflow.ts's
 *  own noteFormat/sectionNotes and the engine's formatMark, counting only
 *  auto-numbered notes, restarting at an eachSect section. Per-page restart is
 *  not projected (no recipe uses it). Cell references are included: Word and
 *  LibreOffice number them. */
function notesOf(doc: WmlDocument): Comparable['notes'] {
  const secs = sectionNotes(doc);
  const out = { footnotes: [] as TruthNote[], endnotes: [] as TruthNote[] };
  const counters = { footnote: 0, endnote: 0 };
  let sec = 0;
  const noteText = (blocks: readonly WmlBlock[]): string => {
    const flat: { p: WmlParagraph; inTable: boolean }[] = [];
    flatten(blocks, false, flat);
    return flat.map((x) => paraText(x.p, [])).join('\n').trim();
  };
  const visit = (blocks: readonly WmlBlock[]): void => {
    for (const b of blocks) {
      if (b.kind === 'table') { for (const row of b.rows) for (const cell of row.cells) visit(cell.blocks); continue; }
      for (const i of b.inlines) {
        if (i.kind !== 'note') continue;
        const part = i.note === 'footnote' ? doc.footnotes : doc.endnotes;
        const body = part?.get(i.id);
        if (body === undefined) continue;
        const pr = secs[sec][i.note === 'footnote' ? 'footnotePr' : 'endnotePr'];
        const mark = i.mark ?? formatMark((pr?.numStart ?? 1) + counters[i.note]++,
          noteFormat(pr?.numFmt) ?? (i.note === 'footnote' ? 'arabic' : 'roman'));
        out[i.note === 'footnote' ? 'footnotes' : 'endnotes'].push({ mark, text: noteText(body) });
      }
      if (b.sectionEnd !== undefined) {
        sec++;
        for (const k of ['footnote', 'endnote'] as const)
          if (secs[sec]?.[k === 'footnote' ? 'footnotePr' : 'endnotePr']?.numRestart === 'eachSect') counters[k] = 0;
      }
    }
  };
  visit(doc.blocks);
  return out;
}
```

and add `notes: notesOf(doc)` to `truthOf`'s returned object. Note: `formatMark`'s `'symbols'` sequence is the engine's (`* † ‡ § ¶ #`); Word's chicago is `* † ‡ §`. They agree up to the fourth note — a chicago file with five or more notes would diverge, which no recipe has; record it in PROVENANCE.

- `test/docx-corpus.test.ts`: the "records every construct" case must no longer demand a skip name for a construct now MODELLED. Replace its body:

```ts
    const names = new Set(ours.unsupported.map((u) => u.name));
    // Footnotes and endnotes are modelled since v9j3.3.2: the readers' counts
    // must be matched by notes in the model, not by a skip name.
    const modelled: Partial<Record<keyof TruthCounts, number>> = {
      footnotes: ours.footnotes?.size ?? 0, endnotes: ours.endnotes?.size ?? 0,
    };
    const missing = COUNT_KEYS.filter((k) => truths.every((t) => t.counts[k] > 0)
      && (k in modelled ? (modelled[k] ?? 0) === 0 : !SKIP_MAP[k].some((n) => names.has(n))));
```

- `test/docx-import-corpus.test.ts` "names in skipped every construct both readers counted": footnotes/endnotes now RENDER; exclude them from the skip demand and assert instead that each reader-agreed note text appears in the rendered text:

```ts
    const missing = COUNT_KEYS.filter((k) => k !== 'footnotes' && k !== 'endnotes'
      && truths.every((t) => t.counts[k] > 0) && !SKIP_MAP[k].some((n) => names.has(n)));
```

plus a new case in that file's `describe.each`:

```ts
  it('renders every note text both readers agree on, outside table cells', () => {
    const agreed = [...truths[0].notes.footnotes, ...truths[0].notes.endnotes]
      .map((n) => n.text).filter((t) => t !== '' && truths.every((u) => [...u.notes.footnotes, ...u.notes.endnotes].some((m) => m.text === t)))
      .filter((t) => !/^Cell note/.test(t));          // a cell reference is dropped until v9j3.3.3
    const missing = agreed.map(norm).filter((t) => !text.includes(t));
    expect(missing).toEqual([]);
  });
```

(`norm` and `text` are that file's existing helpers — read the file and use its names.)

Run: `npx vitest run test/docx-truth.test.ts test/docx-corpus.test.ts`
Expected: FAIL — the vendored JSON files have no `notes` (shape check).

- [ ] **Step 5: Regenerate the corpus**

Run (PowerShell, LibreOffice's program directory from `test/fixtures/docx/PROVENANCE.md`):
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-docx-corpus.ps1 -LoProgram <dir> -Only notes`
then the readers over EVERY corpus file (the `-SkipBuild` path re-reads all):
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-docx-corpus.ps1 -LoProgram <dir> -SkipBuild`
then `npx tsx scripts/docx-disagreements.ts`.
Expected: two new `.docx` files and their JSON; every existing JSON changes ONLY by gaining `notes` — check with `git diff --stat test/fixtures/docx/*.json` and `git diff -U0 test/fixtures/docx/word2010-styles.word.json`. Any other change to an existing truth file is a finding: stop, ledger it, and decide (reader nondeterminism, not this issue's to absorb silently). The existing `.docx` files must be byte-identical (`git status` shows them unmodified).

- [ ] **Step 6: Run the corpus suites; triage**

Run: `npx vitest run test/docx-truth.test.ts test/docx-corpus.test.ts test/docx-import-corpus.test.ts`
Expected: PASS. A `notes[...]` path in the "matches the readers wherever they agree" diff is evidence: when OUR model differs from what both readers agree on, fix the reader or `docxNoteOptions` (Tasks 3–4), not the projection, unless the projection itself is wrong — ledger each as a ruling naming the file and path. Reader disagreements land in `disagreements.json` and are pinned as before.

- [ ] **Step 7: PROVENANCE and commit**

`test/fixtures/docx/PROVENANCE.md`: add the `notes` recipe to the recipe table (`word2010-notes`: footnotes incl. two paragraphs, a custom mark `*`, an endnote, a cell footnote last in section 1, a second section restarting lowercase roman; `lo26.8-notes`: document-wide lowercase roman from iii, a custom mark, an endnote), the new files' SHA-256s (printed by the script), and a "Notes" paragraph: what Word's mark is derived from (Word-reported section, NumberStyle, StartingNumber, NumberingRule — the formatting of those numbers is the script's), that LibreOffice reports its mark directly, the chicago-vs-symbols divergence past four, and that per-page restart is NOT in the corpus (it depends on pagination this library does not share with Word) — held by `test/flow-notes-page-restart.test.ts` alone.

```bash
git add scripts/gen-docx-corpus-word.ps1 scripts/gen-docx-corpus-lo.py scripts/gen-docx-corpus.ps1 scripts/docx-truth-word.ps1 scripts/docx-truth-lo.py test/helpers/docx-truth.ts test/docx-corpus.test.ts test/docx-import-corpus.test.ts test/fixtures/docx
git commit -m "test(v9j3.3.2): Word 2010 and LibreOffice read notes — corpus oracle for footnotes and endnotes"
```

---

### Task 6: Docs, mutation sweep, verification

**Files:**
- Modify: `README.md` (DOCX capability line; Flow footnotes section: `RestartNotes`, `restart: 'page'`; DOCX limitations; API rows for `RestartNotes` as a member if the table lists Flow members)
- Modify: `CHANGELOG.md` (`### Added`: DOCX footnotes and endnotes; `### Added`: note restart in Flow)
- Modify: `CLAUDE.md` (`wmlnotes.ts` entry; `wmlflow.ts`/`wmlbody.ts`/`wmlread.ts` invariants; `flownotes.ts` invariants for both restarts; the fixtures table's `fixtures/docx/` row mentions notes)
- Modify: `docs/superpowers/specs/2026-10-07-docx-footnotes-design.md` (oracle recipe: no list in a note — Global Constraints ruling; `parseNotes` location ruling)

- [ ] **Step 1: Mutation sweep** — the harness pattern of v9j3.3.1 (strip ANSI, judge by exit status, every pattern applied exactly once, a file that fails to load is LOAD-ERROR, a timeout is TIMEOUT, never GREEN). Each expected RED:
1. Numbering pass ignores restart markers (`numberer.restart` call removed) → restart tests.
2. Placement loop does not skip markers → "leaves no gap".
3. Lookahead takes `queue[1]` again → keep-with-next case.
4. `renumberForPage` uses the continuous count (`countPage === pageIdx ? countOnPage : 0` → `countOnPage`) → page-restart tests.
5. `commitRefs` stops counting → page-restart tests.
6. `renumber` keeps the old gutter → mark-equals-gutter case.
7. `normalizeNoteOptions` accepts `'page'` for endnotes → refusal case.
8. `parseNotes` keeps separator entries → reader test.
9. Notes part resolved against `document.xml.rels` (pass `rel` instead of `relOf(r.part)`) → hyperlink tests (reader + end to end).
10. `customMarkFollows` ignored → custom mark tests.
11. `cellContent` passes the body `Ctx` (cite defined) → table-cell case (the engine refuses a cell reference: expect a throw, which is RED).
12. `noteElements` gives the note body a `cite` → nested case (add a hand-built note citing another note if green: Word never writes one, so the test builds `footnotes.xml` by hand).
13. `docxNoteOptions` reads the FIRST section instead of the last → section/format cases.
14. eachSect markers not emitted → `eachSect` case and the Word corpus file.
15. `document.ts` drops Word's note options → lowerRoman case.
16. `noteFormat` maps `lowerRoman` → `'Roman'` → lowerRoman case and corpus.
Record results in CLAUDE.md and PROVENANCE, naming rules held only by hand-built cases and any equivalent mutant.

- [ ] **Step 2: Docs** per the Files list, house style (bold lead-in, what it does, why, what was measured, issue id). README DOCX line: footnotes and endnotes now render (Word's format, start and restart honoured; a reference in a table cell reported until v9j3.3.3); remove footnotes/endnotes from the "reported in `skipped` rather than drawn" list in Scope and Limitations and add the cell-reference and chicago-past-four notes. README Flow footnotes section: `flow.RestartNotes(kind?)` and `footnotes: { restart: 'page' }` with a two-line example:

```ts
const flow = doc.NewFlow({ footnotes: { restart: 'page' } });   // 1, 2, … on every page
flow.AddParagraph([{ text: 'Chapter one' }, { text: '', footnote: { content: 'A note.' } }]);
flow.RestartNotes('footnote');                                  // the next footnote is 1 again
```

Run `npx vitest run test/readme-api.test.ts` and copy any count it reports. Run the CLAUDE.md module sweep (`for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done`); it must print nothing.

- [ ] **Step 3: Full verification**

Run: `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` then `npm test > <workspace>/full.txt 2>&1; echo test=$?` and read the tail.
Expected: `tsc=0`, `test=0`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md docs/superpowers/specs/2026-10-07-docx-footnotes-design.md test/fixtures/docx/PROVENANCE.md
git commit -m "docs(v9j3.3.2): DOCX footnotes and endnotes — README, CHANGELOG, CLAUDE.md"
```
