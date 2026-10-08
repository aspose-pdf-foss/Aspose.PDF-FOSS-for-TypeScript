# Footnotes and Endnotes in Flow Table Cells (v9j3.3.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A footnote or endnote reference in a Flow table cell renders through the v9j3.3 note engine — hand-built flows, Markdown and DOCX — instead of being refused.

**Architecture:** `table()` (`flowtable.ts`) lowers cited cell runs with `lowerNotes` on a PRIVATE COPY of the builder (`TableBuilder.mapCells`, internal), so `page.AddTable` keeps refusing through the existing `resolveRuns` guard. `TableElement` exposes `noteRefs()`, reports the kept rows' references from `measure()`, sets `ref.owner` to its cell's `/TD`/`/TH`, and a continuation leaves its repeated header rows' references out. Markdown and DOCX cells stop refusing.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-table-cell-notes-design.md`

## Global Constraints

- Zero runtime dependencies; no new value-import 2-cycle (`npx vitest run test/import-cycles.test.ts`). `flowtable.ts` → `flownotes.ts` is new: verify it with that test in Task 2.
- Every `catch` in `src/` calls `rethrowLimit(caught)` first (`test/limits-catch.test.ts`) — this plan adds no `catch`.
- A table whose cells cite no note takes EXACTLY today's path: `table()` hands the caller's builder through untouched. The fence of Task 2 Step 1 stays green unedited through every later task, and so do `test/rich-runs-identity.test.ts`, `test/docx-flow-identity.test.ts` and `test/flow-notes-identity.test.ts`.
- The caller's `TableBuilder` is never mutated: `page.AddTable` with a cited run still throws `TypeError` (`footnote/endnote runs are supported only inside a Flow`).
- Report names removed: `footnote (table cell)` (Markdown), `w:footnoteReference (table cell)` and `w:endnoteReference (table cell)` (DOCX). Kept: `footnote (nested)`, `w:footnoteReference (in a note)`, `w:endnoteReference (in a note)`.
- **Ruling (planner, found while planning):** `lowerNotes` inserts a mark run after every cited run, so an atomic's `beforeRun` must be rebased past the marks before it. Paragraphs, headings and list items ALREADY get this wrong — measured: runs `[AAA (cited), ' BBB']` with an image `beforeRun: 1` draw `AAA` at x 72, the 20pt image, then the mark at x 116, where the mark belongs right after `AAA`. One helper (`rebaseForMarks`) fixes it for paragraphs (Task 1, a separate **Fixed** entry) and is reused by the table copy (Task 2).
- Every new test asserts against something the code does not compute itself; every mutation in Task 4 must be shown RED, or recorded as equivalent with the reason.

## Review Focus

1. **A note in a repeating header row of a table that splits across pages**: the mark draws in the header on every page, the note is placed once, on page 1. → Task 2.
2. **A cited row near the page foot**: the row moves to the next page WITH its note; a row and its note never land on different pages. → Task 2 (property case over filler sizes).
3. **A note-free table, plain / split / tagged**: byte-identical output. → Task 2 Step 1 fence.
4. **The builder handed to `flow.AddTable` reused with `page.AddTable`**: still a `TypeError`, and its cells still hold the caller's own runs. → Task 2.
5. **`page.AddMarkdown` / `page.AddDocx` with a cited table cell (one rect)**: the note is drawn after the content inside the rect, nothing reported. → Task 3.

---

### Task 1: Rebase atomics past note marks (paragraphs, headings, list items)

**Files:**
- Modify: `src/flownotes.ts` (new exports `citesNote`, `rebaseForMarks`, beside `lowerNotes`)
- Modify: `src/flow.ts:409-438` (`paragraph`, `heading`), `src/flow.ts:1110-1113` (list items)
- Test: `test/flownotes-rebase.test.ts` (new)

**Interfaces:**
- Produces: `citesNote(text: string | TextRun[]): boolean` — whether any run carries `footnote`/`endnote`.
- Produces: `rebaseForMarks<T extends { beforeRun: number }>(text: string | TextRun[], atomics: T[] | undefined): T[] | undefined` — the same atomics with each `beforeRun` moved past the marks `lowerNotes` inserts before it; returns `atomics` itself when nothing is cited.

- [ ] **Step 1: Write the failing tests**

```ts
// test/flownotes-rebase.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { rebaseForMarks, citesNote } from '../src/flownotes.js';
import { makePng } from './helpers/make-png.js';

const atomic = (beforeRun: number) => ({ beforeRun, data: makePng(), width: 20, height: 10 });
const cited = [{ text: 'AAA', footnote: { content: 'NOTE' } }, { text: ' BBB' }];

/** The mark sits right after AAA: x of the small '1' fragment vs AAA's left. */
function markGap(pages: { GetTextFragments(): { text: string; fontSize: number; quad: number[] }[] }[]): number {
  const f = pages[0].GetTextFragments();
  const aaa = f.find((x) => x.text.includes('AAA'))!;
  const mark = f.find((x) => x.text.trim() === '1' && x.fontSize < 8 && Math.abs(x.quad[1] - aaa.quad[1]) < 8)!;
  return mark.quad[0] - aaa.quad[0];
}

describe('rebaseForMarks', () => {
  it('moves an atomic past every mark inserted before it', () => {
    const text = [{ text: 'a', footnote: { content: 'x' } }, { text: 'b' }, { text: 'c', endnote: { content: 'y' } }, { text: 'd' }];
    const out = rebaseForMarks(text, [{ beforeRun: 0 }, { beforeRun: 1 }, { beforeRun: 2 }, { beforeRun: 3 }, { beforeRun: 4 }]);
    // lowered: [a, m, b, c, m, d]
    expect(out!.map((a) => a.beforeRun)).toEqual([0, 2, 3, 5, 6]);
  });
  it('returns the atomics themselves when nothing is cited, and undefined for undefined', () => {
    const list = [{ beforeRun: 1 }];
    expect(rebaseForMarks([{ text: 'a' }, { text: 'b' }], list)).toBe(list);
    expect(rebaseForMarks('plain', list)).toBe(list);
    expect(rebaseForMarks(cited, undefined)).toBeUndefined();
  });
  it('citesNote', () => {
    expect(citesNote('x')).toBe(false);
    expect(citesNote([{ text: 'x' }])).toBe(false);
    expect(citesNote(cited)).toBe(true);
  });
});

describe('an image after a cited run draws AFTER the mark', () => {
  it('paragraph', () => {
    const flow = Document.New().NewFlow();
    flow.AddParagraph(cited, { atomics: [atomic(1)] });
    expect(markGap(flow.Render())).toBeLessThan(30);   // AAA is 24pt wide; the bug put the image first (44)
  });
  it('heading', () => {
    const flow = Document.New().NewFlow();
    flow.AddHeading(3, cited, { fontSize: 12, atomics: [atomic(1)] });
    expect(markGap(flow.Render())).toBeLessThan(30);
  });
  it('list item', () => {
    const flow = Document.New().NewFlow();
    flow.AddList([{ text: cited, atomics: [atomic(1)] }]);
    expect(markGap(flow.Render())).toBeLessThan(30);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/flownotes-rebase.test.ts`
Expected: FAIL — `rebaseForMarks`/`citesNote` are not exported; once they are, the three render cases fail with a gap near 44. (If `AddHeading`'s or `AddList`'s option shape differs from the above, read `src/flow.ts` and adapt the CALL only — the assertion stays.)

- [ ] **Step 3: Implement in `src/flownotes.ts`, directly after `lowerNotes`**

```ts
/** Whether any run of `text` cites a note. @internal */
export function citesNote(text: string | TextRun[]): boolean {
  return typeof text !== 'string' && text.some(hasNote);
}

/** Atomics whose `beforeRun` indexes `text` rebased onto `lowerNotes(text)`'s
 *  output (v9j3.3.3): lowering inserts a mark run after every cited run, so an
 *  atomic before run i moves past the marks of the cited runs before i — and
 *  so draws after the mark of run i - 1, where it belongs. Returns `atomics`
 *  itself when nothing is cited. @internal */
export function rebaseForMarks<T extends { beforeRun: number }>(
  text: string | TextRun[], atomics: T[] | undefined,
): T[] | undefined {
  if (atomics === undefined || !citesNote(text)) return atomics;
  const runs = text as TextRun[];
  const shift: number[] = [0];
  for (let i = 0; i < runs.length; i++) shift.push(shift[i] + (hasNote(runs[i]) ? 1 : 0));
  return atomics.map((a) => Number.isInteger(a.beforeRun) && a.beforeRun >= 0 && a.beforeRun <= runs.length
    ? { ...a, beforeRun: a.beforeRun + shift[a.beforeRun] } : a);
}
```

(An out-of-range `beforeRun` is passed through unchanged so `resolveAtomics`' own validation still reports it.)

- [ ] **Step 4: Use it in `src/flow.ts`**

In `paragraph` replace `paragraphOptions(o)` in the `TextElement` construction with `paragraphOptions({ ...o, atomics: rebaseForMarks(text, o.atomics) })`. In `heading` replace `paragraphOptions(withDefaults)` with `paragraphOptions({ ...withDefaults, atomics: rebaseForMarks(text, withDefaults.atomics) })`. In the list loop replace `resolveAtomics(p.item.atomics)` with `resolveAtomics(rebaseForMarks(p.item.text, p.item.atomics))`. Add `citesNote` is not needed here; add `rebaseForMarks` to the existing `./flownotes.js` import list at `src/flow.ts:33`.

Note `forFirstLine` turns a STRING into one run and never touches a run list, so it does not shift indices.

- [ ] **Step 5: Run, expect PASS**

Run: `npx vitest run test/flownotes-rebase.test.ts test/flow-footnotes.test.ts test/flow-notes-identity.test.ts test/markdown-footnotes.test.ts test/docx-notes.test.ts test/rich-runs-identity.test.ts`
Expected: PASS, every fence unedited.

- [ ] **Step 6: Commit**

```bash
git add src/flownotes.ts src/flow.ts test/flownotes-rebase.test.ts
git commit -m "fix(v9j3.3.3): an inline image after a cited run draws after its note mark"
```

---

### Task 2: The engine — cited table cells in a Flow

**Files:**
- Modify: `src/tableauthor.ts` (`TableBuilder.mapCells`, internal)
- Modify: `src/tabletag.ts` (`TableTagger.elementOf`)
- Modify: `src/flowtable.ts` (`table()`, `TableElement`)
- Test: `test/flow-table-notes-identity.test.ts` (new, the fence), `test/flow-table-notes.test.ts` (new)

**Interfaces:**
- Consumes: `citesNote`, `rebaseForMarks` (Task 1); `lowerNotes`, `refsIn`, `NoteRef`, `FlowTextRun` from `flownotes.ts`; `resolveCellStyle` from `tableauthor.ts`.
- Produces: `TableBuilder.mapCells(f: (cell: CellBuilder, row: RowBuilder) => { text: string | TextRun[]; atomics?: BlockAtomic[] } | undefined): TableBuilder` — `@internal`; a copy sharing every table field and every cell `f` answers `undefined` for.
- Produces: `TableTagger.elementOf(cell: CellBuilder): StructElement | undefined` — the element `cell()` last created for that cell.

- [ ] **Step 1: Record the byte-identity fence BEFORE any engine change**

```ts
// test/flow-table-notes-identity.test.ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { createTable } from '../src/tableauthor.js';

/** Note-free Flow tables, hashed on the code BEFORE v9j3.3.3. A FENCE:
 *  never re-record to make it pass. */
const sha = (pages: { Contents: Uint8Array }[]): string =>
  createHash('sha256').update(Buffer.concat(pages.map((p) => Buffer.from(p.Contents)))).digest('hex').slice(0, 16);

const big = () => {
  const t = createTable({ fontSize: 10 });
  t.addRow(['Head A', 'Head B']);
  t.setRepeatingRowsCount(1);
  for (let i = 0; i < 90; i++) {
    const r = t.addRow();
    r.addCell([{ text: `row ${i}` }]);
    r.addCell('second');
  }
  return t;
};

describe('note-free Flow tables are byte-identical (v9j3.3.3 fence)', () => {
  it('a plain run-cell table', () => {
    const t = createTable();
    t.addRow(['a', 'b']);
    t.addRow().addCell([{ text: 'rich ' }, { text: 'bold', font: 'Helvetica-Bold' }]);
    t.rows[1].addCell('c');
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    expect(sha(flow.Render())).toMatchInlineSnapshot();
  });
  it('a split table with a repeating header', () => {
    const flow = Document.New().NewFlow();
    flow.AddTable(big());
    expect(sha(flow.Render())).toMatchInlineSnapshot();
  });
  it('a tagged split table', () => {
    const flow = Document.New().NewFlow({ tagged: true });
    flow.AddTable(big());
    expect(sha(flow.Render())).toMatchInlineSnapshot();
  });
});
```

Run: `npx vitest run test/flow-table-notes-identity.test.ts` — vitest writes the three inline snapshots. Confirm the file now holds three 16-hex-digit strings, then commit:

```bash
git add test/flow-table-notes-identity.test.ts
git commit -m "test(v9j3.3.3): byte-identity fence for note-free Flow tables, recorded before the engine changes"
```

- [ ] **Step 2: Write the failing engine tests**

```ts
// test/flow-table-notes.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { createTable, type TableBuilder } from '../src/tableauthor.js';
import { table } from '../src/flowtable.js';
import type { StructElement } from '../src/struct.js';

type Frag = { text: string; fontSize: number; quad: number[] };
type Pg = { GetTextFragments(): Frag[]; GetText(): string };
const fn = (c: string) => ({ footnote: { content: c } });
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Body sentence ${i} fills the page.`).join(' ');
const pageOf = (pages: Pg[], s: string) => pages.findIndex((p) => p.GetText().includes(s));
/** The gutter mark left of a note body: small, same line, to its left. */
function gutterOf(p: Pg, body: string): string | undefined {
  const f = p.GetTextFragments();
  const b = f.find((x) => x.text.includes(body));
  if (b === undefined) return undefined;
  return f.find((x) => x.fontSize < b.fontSize && Math.abs(x.quad[1] - b.quad[1]) < 4 && x.quad[0] < b.quad[0])?.text.trim();
}
const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
const cited = (label: string, note: string) => [{ text: label }, { text: '', ...fn(note) }];

describe('notes in Flow table cells', () => {
  it('a cell footnote is drawn at the page foot, its mark raised in the cell', () => {
    const t = createTable();
    t.addRow().addCell(cited('cell', 'CELLNOTE'));
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const [p] = flow.Render();
    const f = p.GetTextFragments();
    const note = f.find((x) => x.text.includes('CELLNOTE'))!;
    expect(note.quad[1]).toBeLessThan(200);
    expect(note.quad[1]).toBeLessThan(f.find((x) => x.text.includes('cell'))!.quad[1]);
    expect(f.filter((x) => x.text.trim() === '1' && x.fontSize < 8)).toHaveLength(2);   // citation + gutter
  });

  it('numbers cells row-major', () => {
    const t = createTable();
    t.addRow().addCell(cited('a', 'N00')); t.rows[0].addCell(cited('b', 'N01'));
    t.addRow().addCell(cited('c', 'N10')); t.rows[1].addCell(cited('d', 'N11'));
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const [p] = flow.Render();
    expect(['N00', 'N01', 'N10', 'N11'].map((s) => gutterOf(p, s))).toEqual(['1', '2', '3', '4']);
  });

  it('a split table places each note on the page its row lands on', () => {
    const t = createTable();
    for (let i = 0; i < 120; i++) t.addRow().addCell(i === 2 ? cited('r2', 'EARLY') : i === 110 ? cited('r110', 'LATE') : [{ text: `row ${i}` }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(pageOf(pages, 'EARLY')).toBe(pageOf(pages, 'r2'));
    expect(pageOf(pages, 'LATE')).toBe(pageOf(pages, 'r110'));
    expect(pageOf(pages, 'LATE')).toBeGreaterThan(0);
  });

  it('a cited row and its note always share a page (property over filler sizes)', () => {
    for (let n = 70; n <= 110; n += 2) {
      const t = createTable();
      t.addRow().addCell(cited('CITEDROW', `THENOTE ${filler(4)}`));
      const flow = Document.New().NewFlow();
      flow.AddParagraph(filler(n));
      flow.AddTable(t);
      const pages = flow.Render();
      expect(pageOf(pages, 'THENOTE'), `filler ${n}`).toBe(pageOf(pages, 'CITEDROW'));
    }
  });

  it('a note in a repeating header row: mark on every page, note once (Review Focus 1)', () => {
    const t = createTable();
    t.addRow().addCell(cited('HEAD', 'HEADNOTE'));
    t.setRepeatingRowsCount(1);
    for (let i = 0; i < 120; i++) t.addRow().addCell([{ text: `row ${i}` }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.filter((p) => p.GetText().includes('HEADNOTE'))).toHaveLength(1);
    expect(pageOf(pages, 'HEADNOTE')).toBe(0);
    for (const p of pages) {
      const f = p.GetTextFragments();
      const head = f.find((x) => x.text.includes('HEAD') && !x.text.includes('HEADNOTE'))!;
      // the raised citation mark beside the header text, on every page
      expect(f.some((x) => x.text.trim() === '1' && x.fontSize < 8 && Math.abs(x.quad[1] - head.quad[1]) < 8)).toBe(true);
    }
  });

  it('endnotes from a cell go after the content', () => {
    const t = createTable();
    t.addRow().addCell([{ text: 'x' }, { text: '', endnote: { content: 'ENDTEXT' } }]);
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    flow.AddParagraph('closing');
    const f = flow.Render()[0].GetTextFragments();
    expect(f.find((x) => x.text.includes('ENDTEXT'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('closing'))!.quad[1]);
  });

  it("restart: 'page' numbers a split table's notes from 1 on each page", () => {
    const t = createTable();
    for (let i = 0; i < 120; i++) t.addRow().addCell(i % 30 === 0 ? cited(`c${i}`, `NT${i}`) : [{ text: `row ${i}` }]);
    const flow = Document.New().NewFlow({ footnotes: { restart: 'page' } });
    flow.AddTable(t);
    const pages = flow.Render();
    for (const p of pages) {
      const marks = [0, 30, 60, 90].map((i) => gutterOf(p, `NT${i}`)).filter((m) => m !== undefined).map(Number);
      expect(marks).toEqual(marks.map((_, k) => k + 1));
    }
  });

  it('a tagged note is a /Note under the cell’s /TD, and under /TH for a header cell', () => {
    const doc = Document.New();
    const t = createTable();
    t.addRow().addCell(cited('h', 'HN'), { header: true });
    t.addRow().addCell(cited('d', 'DN'));
    const flow = doc.NewFlow({ tagged: true });
    flow.AddTable(t);
    flow.Render();
    const notes = all(doc.GetStructTree()!).filter((e) => e.Type === 'Note');
    expect(notes.map((n) => n.Parent!.Type).sort()).toEqual(['TD', 'TH']);
  });

  it('an image after a cited run in a cell draws after the mark', async () => {
    const { makePng } = await import('./helpers/make-png.js');
    const t = createTable();
    t.addRow().addCell([{ text: 'AAA', ...fn('N') }, { text: ' BBB' }],
      { atomics: [{ beforeRun: 1, data: makePng(), width: 20, height: 10 }] });
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    const f = flow.Render()[0].GetTextFragments();
    const aaa = f.find((x) => x.text.includes('AAA'))!;
    const mark = f.find((x) => x.text.trim() === '1' && x.fontSize < 8 && Math.abs(x.quad[1] - aaa.quad[1]) < 8)!;
    expect(mark.quad[0] - aaa.quad[0]).toBeLessThan(30);
  });

  it('the caller’s builder is untouched and page.AddTable still refuses it (Review Focus 4)', () => {
    const t: TableBuilder = createTable();
    t.addRow().addCell(cited('x', 'N'));
    const before = t.rows[0].cells[0].text;
    const flow = Document.New().NewFlow();
    flow.AddTable(t);
    flow.Render();
    expect(t.rows[0].cells[0].text).toBe(before);
    expect((before as unknown[]).length).toBe(2);
    const doc = Document.New();
    expect(() => doc.AddPage().page.AddTable(t, 72, 720, { width: 400 })).toThrow(/only inside a Flow/);
  });

  it('two table() calls over one builder lower two sets of references', () => {
    const t = createTable();
    t.addRow().addCell(cited('x', 'N'));
    const [a] = table(t);
    const [b] = table(t);
    expect(a.noteRefs!()).toHaveLength(1);
    expect(b.noteRefs!()[0]).not.toBe(a.noteRefs!()[0]);
  });

  it('mapCells keeps column specs, auto-fit and repeating rows', () => {
    const t = createTable();
    t.addRow(['a', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb']);
    t.addRow(['c', 'd']);
    t.setRepeatingRowsCount(1);
    t.autoFitColumns();
    const copy = t.mapCells(() => undefined);
    expect(copy.resolveColumnWidths(400)).toEqual(t.resolveColumnWidths(400));
    expect(copy.repeatingRowCount).toBe(1);
    expect(copy.rows[0].cells[0]).toBe(t.rows[0].cells[0]);
    const fixed = createTable();
    fixed.addRow(['a', 'b']);
    fixed.setColumnWidths([{ fixed: 100 }, { fraction: 1 }]);
    expect(fixed.mapCells(() => undefined).resolveColumnWidths(400)).toEqual([100, 300]);
  });
});
```

(`addCell`'s exact options are `CellOptions`: `header`, `atomics`, `colSpan`, … — confirm against `src/tableauthor.ts:124-155`. If `AddTable`'s `x, top` argument order differs, read `src/page.ts:869` and adapt the call only.)

- [ ] **Step 3: Run, expect FAIL**

Run: `npx vitest run test/flow-table-notes.test.ts`
Expected: FAIL — most cases throw `footnote/endnote runs are supported only inside a Flow` at render; `mapCells` does not exist.

- [ ] **Step 4: `TableBuilder.mapCells` in `src/tableauthor.ts`, directly after `continuationFrom`**

```ts
  /** @internal A copy of this table whose cells are what `f` answers, every
   *  cell `f` answers `undefined` for shared as it is, and every table-level
   *  setting (defaults, column specs, auto-fit, forced column count,
   *  repeating rows) carried over (v9j3.3.3: `table()` lowers cited runs on a
   *  copy so the caller's builder is never mutated). */
  mapCells(
    f: (cell: CellBuilder, row: RowBuilder) => { text: string | TextRun[]; atomics?: BlockAtomic[] } | undefined,
  ): TableBuilder {
    const t = new TableBuilder(this.defaults);
    t.columnSpecs = this.columnSpecs;
    t.autoFit = this.autoFit;
    t.forcedColumnCount = this.forcedColumnCount;
    t._repeatingRows = this._repeatingRows;
    for (const r of this.rows) {
      const nr = new RowBuilder(r.style, r.minHeight);
      for (const c of r.cells) {
        const m = f(c, r);
        if (m === undefined) { nr.cells.push(c); continue; }
        const nc = new CellBuilder(m.text, c.options, c.colSpan, c.rowSpan, c.header, m.atomics);
        if (c.image !== undefined) nc.image = c.image;
        nr.cells.push(nc);
      }
      t.rows.push(nr);
    }
    return t;
  }
```

Before writing it, list every instance field `TableBuilder` declares (`grep -n "^  private\|^  readonly" src/tableauthor.ts` within the class); any field beyond the five named above must be copied too, and the "mapCells keeps…" case extended to cover it.

- [ ] **Step 5: `TableTagger.elementOf` in `src/tabletag.ts`**

Add a field and record in `cell()`:

```ts
  /** The element `cell()` last created per cell, for a note's owner (v9j3.3.3). */
  private readonly cellElements = new Map<CellBuilder, StructElement>();

  /** The /TD or /TH `cell()` last created for `cell`. */
  elementOf(cell: CellBuilder): StructElement | undefined { return this.cellElements.get(cell); }
```

In `cell()`, after `const elem = this.row.Append(...)`, add `this.cellElements.set(cell, elem);`.

- [ ] **Step 6: Lowering and the element in `src/flowtable.ts`**

Imports:

```ts
import { reportTableCoverage, resolveCellStyle, type TableBuilder, type BorderInfo } from './tableauthor.js';
import { lowerNotes, refsIn, citesNote, rebaseForMarks, type NoteRef, type FlowTextRun } from './flownotes.js';
```

Above `table()`:

```ts
/** `t` itself when no cell cites a note — the byte-identity argument, by
 *  construction — else a private copy whose cited run lists are lowered at
 *  the cell's cascaded size and whose atomics are rebased past the marks
 *  (v9j3.3.3). The caller's builder is never mutated, so the same builder
 *  passed to page.AddTable still meets resolveRuns' guard. */
function lowerTableNotes(t: TableBuilder): TableBuilder {
  if (!t.rows.some((r) => r.cells.some((c) => citesNote(c.text)))) return t;
  return t.mapCells((c, row) => {
    if (!citesNote(c.text)) return undefined;
    const runs = c.text as FlowTextRun[];
    const size = resolveCellStyle(c, row.style, t.defaults).fontSize;
    return { text: lowerNotes(runs, size), atomics: rebaseForMarks(runs, c.atomics) };
  });
}
```

In `table()`, construct the element with `lowerTableNotes(t)` in place of `t` (keep `reportTableCoverage(t, …)` on the caller's builder — a mark is `''` there and covers nothing).

In `TableElement`, add a constructor parameter after `tagger`:

```ts
    /** Leading rows that REPEAT the header on a continuation: their references
     *  were committed by the first slice, so they are left out here while
     *  their marks still draw (v9j3.3.3). */
    private readonly echo = 0,
```

and these members:

```ts
  /** References in rows [echo, to), row-major, in run order. */
  private refsTo(to: number): NoteRef[] {
    const out: NoteRef[] = [];
    for (let i = this.echo; i < to; i++)
      for (const c of this.t.rows[i].cells) if (typeof c.text !== 'string') out.push(...refsIn(c.text));
    return out;
  }

  noteRefs(): NoteRef[] { return this.refsTo(this.t.rows.length); }
```

`measure` returns the kept rows' references (rows are atomic, so a larger budget keeps a superset — settleBudget's monotonicity):

```ts
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean; notes: NoteRef[] } {
    if (ctx.availHeight <= 0) return { usedHeight: 0, fits: false, notes: [] };
    const { rowHeights, grid } = this.metrics(ctx.width);
    const { rows, height } = this.fit(rowHeights, ctx.availHeight, grid.safeBreak);
    return { usedHeight: height, fits: rows === this.t.rows.length && rows > 0, notes: this.refsTo(rows) };
  }
```

In `place`, after `paintRowSlice(...)`:

```ts
    // A tagged note is created under the cell holding its reference.
    if (this.tagger !== undefined)
      for (let i = this.echo; i < rows; i++)
        for (const c of this.t.rows[i].cells) {
          const el = this.tagger.elementOf(c);
          if (el !== undefined && typeof c.text !== 'string') for (const r of refsIn(c.text)) r.owner = el;
        }
```

and build the continuation with its echo:

```ts
    const next = this.t.continuationFrom(rows);
    return {
      usedHeight: height,
      remainder: new TableElement(next, this.o, 0, this.spaceAfter, undefined, this.tagger, next.repeatingRowCount),
      drew: true,
    };
```

Update the class comment (`TableElement`) with one paragraph stating the three rules: references come from the kept rows, the owner is the cell's element, a continuation's repeated header rows contribute none.

- [ ] **Step 7: Run, expect PASS**

Run: `npx vitest run test/flow-table-notes.test.ts test/flow-table-notes-identity.test.ts test/import-cycles.test.ts test/flow-notes-identity.test.ts test/rich-runs-identity.test.ts test/docx-flow-identity.test.ts`
Expected: PASS, the fence unedited.

If the property case fails at some filler size, the engine is telling you a row and its note were split — debug through `settleBudget` (`src/flownotes.ts`) with that `n`; do NOT narrow the loop.

- [ ] **Step 8: Commit**

```bash
git add src/tableauthor.ts src/tabletag.ts src/flowtable.ts test/flow-table-notes.test.ts
git commit -m "feat(v9j3.3.3): footnotes and endnotes in Flow table cells"
```

---

### Task 3: Markdown and DOCX cells cite notes

**Files:**
- Modify: `src/mdflow.ts:386-393` (table cells), `src/wmlflow.ts:298-299` (`cellContent`) and `:42-47` (`DROPPED`), `src/wmlruns.ts:26-29` and `:103` (`refusal`)
- Modify: `test/markdown-footnotes.test.ts:53-57`, `test/docx-notes.test.ts:82-91` (both asserted the refusal — rulings below)
- Test: `test/table-notes-frontends.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 (`table()` lowers cited cell runs).
- Produces: nothing new; `RunCtx.refusal` narrows to `'in a note'`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/table-notes-frontends.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { buildDocx } from './helpers/build-docx.js';
import { p, r } from './helpers/wml.js';

type Frag = { text: string; fontSize: number; quad: number[] };
type Pg = { GetTextFragments(): Frag[]; GetText(): string };
const gutterOf = (pages: Pg[], body: string): string | undefined => {
  for (const pg of pages) {
    const f = pg.GetTextFragments();
    const b = f.find((x) => x.text.includes(body));
    if (b !== undefined)
      return f.find((x) => x.fontSize < b.fontSize && Math.abs(x.quad[1] - b.quad[1]) < 4 && x.quad[0] < b.quad[0])?.text.trim();
  }
  return undefined;
};
const MD = 'Text.[^a]\n\n| head |\n| - |\n| cell[^b] |\n\n[^a]: FIRSTNOTE\n[^b]: CELLNOTE\n';
const fnRef = (id: string) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
const fn = (id: string, body: string) => `<w:footnote w:id="${id}">${body}</w:footnote>`;
const tbl = (inner: string) => '<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>' + inner + '</w:tc></w:tr></w:tbl>';
const DOCX = () => buildDocx(p(r('Text.') + fnRef('1')) + tbl(p(r('cell') + fnRef('2'))) + p(r('after')),
  { footnotes: fn('1', p(r('FIRSTNOTE'))) + fn('2', p(r('CELLNOTE'))) });

describe('Markdown table cells cite notes', () => {
  it('doc.AddMarkdown: drawn, numbered in order, nothing reported', () => {
    const { pages, skipped } = Document.New().AddMarkdown(MD, { gfm: true });
    expect(pages[0].GetText()).not.toContain('[^b]');
    expect(gutterOf(pages, 'FIRSTNOTE')).toBe('1');
    expect(gutterOf(pages, 'CELLNOTE')).toBe('2');
    expect(skipped).toEqual([]);
  });
  it('a cell citing the same definition as a paragraph repeats its mark; the note is drawn once', () => {
    const { pages } = Document.New().AddMarkdown('Text.[^a]\n\n| h |\n| - |\n| c[^a] |\n\n[^a]: ONCE\n', { gfm: true });
    const t = pages.map((pg) => pg.GetText()).join('\n');
    expect(t.split('ONCE').length - 1).toBe(1);
  });
  it('flow.AddMarkdown', () => {
    const flow = Document.New().NewFlow();
    flow.AddMarkdown(MD, { gfm: true });
    expect(gutterOf(flow.Render(), 'CELLNOTE')).toBe('2');
  });
  it('page.AddMarkdown places the cell note after the content inside the rect (Review Focus 5)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const res = page.AddMarkdown(MD, [72, 72, 450, 700], { gfm: true });
    expect(res.skipped).toEqual([]);
    expect(gutterOf([page], 'CELLNOTE')).toBe('2');
    const f = page.GetTextFragments();
    expect(f.find((x) => x.text.includes('CELLNOTE'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('cell'))!.quad[1]);
  });
  it("footnotePlacement 'end' makes a cell citation an endnote", () => {
    const { pages } = Document.New().AddMarkdown(MD, { gfm: true, footnotePlacement: 'end' });
    expect(gutterOf(pages, 'CELLNOTE')).toBe('ii');
  });
});

describe('DOCX table cells cite notes', () => {
  it('doc.AddDocx: drawn, numbered in order, nothing reported', () => {
    const { pages, skipped } = Document.New().AddDocx(DOCX());
    expect(gutterOf(pages, 'FIRSTNOTE')).toBe('1');
    expect(gutterOf(pages, 'CELLNOTE')).toBe('2');
    expect(skipped.filter((s) => s.name.includes('Reference'))).toEqual([]);
  });
  it('flow.AddDocx', () => {
    const flow = Document.New().NewFlow();
    flow.AddDocx(DOCX());
    expect(gutterOf(flow.Render(), 'CELLNOTE')).toBe('2');
  });
  it('page.AddDocx (Review Focus 5)', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const res = page.AddDocx(DOCX(), [72, 72, 450, 700]);
    expect(res.skipped.filter((s) => s.name.includes('Reference'))).toEqual([]);
    expect(gutterOf([page], 'CELLNOTE')).toBe('2');
  });
  it('a reference inside a note is still reported (in a note)', () => {
    const bytes = buildDocx(p(r('t') + fnRef('1')),
      { footnotes: fn('1', tbl(p(r('INNER') + fnRef('2')))) + fn('2', p(r('NESTED'))) });
    const { pages, skipped } = Document.New().AddDocx(bytes);
    expect(pages.map((pg) => pg.GetText()).join('\n')).not.toContain('NESTED');
    expect(skipped).toContainEqual({ name: 'w:footnoteReference (in a note)', count: 1, kind: 'dropped' });
  });
  it('Word 2010 corpus: the marks drawn are Word’s, the cell note included', () => {
    const dir = join('test', 'fixtures', 'docx');
    const truth = JSON.parse(readFileSync(join(dir, 'word2010-notes.word.json'), 'utf8')) as
      { notes: { footnotes: { mark: string; text: string }[] } };
    const { pages } = Document.New().AddDocx(new Uint8Array(readFileSync(join(dir, 'word2010-notes.docx'))));
    const drawn = truth.notes.footnotes.map((n) => gutterOf(pages, n.text.split('\n')[0].replace(/\.$/, '')));
    expect(drawn).toEqual(truth.notes.footnotes.map((n) => n.mark));
  });
});
```

(If `page.AddMarkdown`'s result field is not `skipped`, read `src/page.ts:666` and adapt. For the corpus case, if a note text's first line is matched by another fragment first — e.g. "First note" also inside body text — narrow by the note's font size the way `gutterOf` already compares sizes; do not drop a note from the comparison.)

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run test/table-notes-frontends.test.ts`
Expected: FAIL — Markdown draws `[^b]` literally and reports `footnote (table cell)`; DOCX reports `w:footnoteReference (table cell)`; the corpus case finds no gutter for "Cell note".

- [ ] **Step 3: Markdown — `src/mdflow.ts`**

Replace the cell's run context:

```ts
      const content = inlineRuns(cell.children, c.st,
        { ...(row.header ? header : body), atomic: atomicResolver(c), ...noteFields(c) },
        c.skipped);
```

and delete the comment line `// No note resolver: a citation in a cell is literal until v9j3.3.3.`. Inside a note body `noteFields` still yields `noteRefusal: 'footnote (nested)'`.

- [ ] **Step 4: DOCX — `src/wmlflow.ts` and `src/wmlruns.ts`**

In `cellContent` replace

```ts
    // No note in a cell until v9j3.3.3: reported, nothing drawn.
    const got = inlineContent(inl, { ...c, cite: undefined, refusal: 'table cell' });
```

with

```ts
    // A cell cites notes like any paragraph (v9j3.3.3); inside a note body
    // `c.cite` is undefined and the reference is reported (in a note).
    const got = inlineContent(inl, c);
```

Remove `'w:footnoteReference (table cell)', 'w:endnoteReference (table cell)',` from `DROPPED`. In `src/wmlruns.ts` narrow `refusal?: 'table cell' | 'in a note'` to `refusal?: 'in a note'`, update its doc comment (a cell no longer refuses), and change `` `${tag} (${c.refusal ?? 'table cell'})` `` to `` `${tag} (${c.refusal ?? 'in a note'})` ``.

- [ ] **Step 5: Update the two tests that asserted the refusal (rulings)**

`test/markdown-footnotes.test.ts:53-57` — replace the case with:

```ts
  it('a citation in a table cell is drawn as a note (v9j3.3.3 lifted the refusal)', () => {
    const { pages, skipped } = render('t[^a]\n\n| h |\n| - |\n| c[^a] |\n\n[^a]: n\n');
    expect(pages[0].GetText()).not.toContain('[^a]');
    expect(skipped).not.toContain('footnote (table cell)');
  });
```

`test/docx-notes.test.ts:82-91` — replace the case with:

```ts
  it('a reference in a table cell renders (v9j3.3.3 lifted the refusal)', () => {
    const tbl = '<w:tbl><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc>'
      + p(r('cell') + fnRef('1') + fnRef('2')) + '</w:tc></w:tr></w:tbl>';
    const { pages, skipped } = Document.New().AddDocx(buildDocx(tbl + p(r('after')),
      { footnotes: fn('1', p(r('CELLNOTE'))) + fn('2', p(r('CELLNOTE2'))) }));
    const t = pages[0].GetText();
    for (const s of ['cell', 'after', 'CELLNOTE', 'CELLNOTE2']) expect(t).toContain(s);
    expect(skipped.filter((s) => s.name.includes('table cell'))).toEqual([]);
  });
```

Ruling, recorded in the commit message: both tests pinned the v9j3.3.2/v9j3.3.1 refusal the spec lifts.

- [ ] **Step 6: Run, expect PASS**

Run: `npx vitest run test/table-notes-frontends.test.ts test/markdown-footnotes.test.ts test/docx-notes.test.ts test/docx-corpus.test.ts test/docx-import-corpus.test.ts test/docx-flow-identity.test.ts test/gfm-footnotes-spec.test.ts`
Expected: PASS. If `docx-import-corpus` pins a `skipped` list containing a `(table cell)` name for `word2010-notes.docx`, that name is now gone by design — update the pinned list there and say so in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/mdflow.ts src/wmlflow.ts src/wmlruns.ts test/table-notes-frontends.test.ts test/markdown-footnotes.test.ts test/docx-notes.test.ts
git commit -m "feat(v9j3.3.3): Markdown and DOCX table cells cite notes — the (table cell) refusal is lifted"
```

---

### Task 4: Mutation sweep, docs, verification

**Files:**
- Modify: `README.md` (line ~1138 Flow notes paragraph; line ~174 Markdown capability; line ~227 DOCX capability; line ~4267 DOCX limitations)
- Modify: `CHANGELOG.md` (`## [Unreleased]`: **Added** table-cell notes; **Fixed** atomics after a mark; **Changed** the removed report names)
- Modify: `CLAUDE.md` (the `runlink.ts`, `flowtable.ts` entry: table-cell note invariants; `flownotes.ts` entry: `rebaseForMarks`; `wmlnotes.ts` entry: the cell refusal sentence; the `mdflow.ts` entry if it mentions the cell refusal)
- Modify: `test/fixtures/docx/PROVENANCE.md` (the notes section: the cell note is now rendered and render-checked)

- [ ] **Step 1: Mutation sweep** — the v9j3.3.2 harness (`scratchpad/mutate.mjs` pattern: strip ANSI, judge by exit status, every pattern applied exactly once or NOT-APPLIED, a load failure is LOAD-ERROR, a timeout TIMEOUT, never GREEN). Test set: `test/flow-table-notes.test.ts test/flownotes-rebase.test.ts test/table-notes-frontends.test.ts test/flow-table-notes-identity.test.ts test/markdown-footnotes.test.ts test/docx-notes.test.ts`. Each expected RED:
1. `lowerTableNotes` returns `t` always → most engine cases throw.
2. `mapCells` drops `_repeatingRows` → header case / mapCells case.
3. `mapCells` drops `autoFit` → mapCells case.
4. `refsTo` starts at 0 instead of `this.echo` → header case (note drawn twice).
5. continuation built with echo 0 → header case.
6. `measure` returns all refs regardless of `rows` → property case or split case.
7. `measure` omits `notes` → property case.
8. owner loop removed → tagged case.
9. `elementOf` never recorded (`cellElements.set` removed) → tagged case.
10. `size` from table defaults instead of `resolveCellStyle` cascade → add a case if green (a cell `fontSize: 20` whose mark must be larger than a 10pt cell's).
11. `rebaseForMarks` not applied in the table copy → cell image case.
12. `rebaseForMarks` shift off by one (`shift[a.beforeRun + 1]`) → unit case.
13. paragraph `atomics` not rebased → paragraph case.
14. Markdown cells keep `noteRefusal` → Markdown cases.
15. DOCX `cellContent` passes `cite: undefined` → DOCX cases + corpus case.
16. `reportTableCoverage` given the lowered copy → expect EQUIVALENT (a mark is `''` at build time); confirm and record.
Record results in CLAUDE.md, naming any rule held only by hand-built cases and any equivalent mutant.

- [ ] **Step 2: Docs**, house style (bold lead-in, what it does, why, what was measured, issue id):
  - README ~1138: "a table cell, a floating box…" → table cells accept note references (marks repeat in repeating header rows, the note is placed once); a floating box and `placeElements` still refuse.
  - README ~174: replace "A citation inside a table cell or inside another note is drawn as its literal `[^label]`" with "A citation inside another note…".
  - README ~227 and ~4267: remove the table-cell refusal (and the "a later note in that section is then numbered one lower" clause); `skipped` no longer lists a note reference in a table cell.
  - CHANGELOG **Added** (`v9j3.3.3`), **Fixed** (`v9j3.3.3`, an image after a cited run drew before its mark — measured 20pt off), **Changed** (the three `(table cell)` report names are gone; a caller filtering on them stops seeing them because the construct now renders).
  - CLAUDE.md invariants: the copy-not-mutate rule and why (`page.AddTable`'s guard stays free); rows atomic ⇒ `measure().notes` monotone; echo rows; owner via `TableTagger.elementOf`; `rebaseForMarks` as the one owner of "where an atomic sits once marks are inserted".
  Run `npx vitest run test/readme-api.test.ts` (no new public export is expected — `mapCells` and `elementOf` are `@internal`; if the test reports `mapCells` as an undocumented export of `TableBuilder`'s surface, mark it `@internal` in its doc comment as written above) and the CLAUDE.md module sweep (`for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done`), which must print nothing.

- [ ] **Step 3: Full verification**

Run: `npx tsc -p tsconfig.json --noEmit; echo tsc=$?` then `npm test > <scratchpad>/full.txt 2>&1; echo test=$?` and read the tail.
Expected: `tsc=0`, `test=0`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md test/fixtures/docx/PROVENANCE.md
git commit -m "docs(v9j3.3.3): footnotes in Flow table cells — README, CHANGELOG, CLAUDE.md"
```
