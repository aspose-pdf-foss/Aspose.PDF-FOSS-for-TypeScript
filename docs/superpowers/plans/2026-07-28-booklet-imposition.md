# Booklet (saddle-stitch) imposition (`doc.Booklet`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.Booklet(opts)` imposes a document's pages as a saddle-stitch
booklet into a **new** Document — padded to a multiple of 4, reordered so that
printing duplex and folding the stack down the middle reads in sequence, two
source pages per printed side, with optional RTL binding and creep compensation.

**Architecture:** A pure model module plus assembly in the facade, mirroring the
`toc.ts`/`tocrender.ts` split. `src/booklet.ts` owns padding, the ordering
permutation and cell geometry (including creep) and imports no `Document`;
`Document.Booklet` in `document.ts` sits beside `NUp`, validates options and
assembles sheets through the same `placeFitted` (compose.ts). No new rendering
primitives.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime
dependencies.

Spec: [docs/superpowers/specs/2026-07-28-booklet-imposition-design.md](../specs/2026-07-28-booklet-imposition-design.md).
Issue: `aspose-pdf-foss-for-ts-1gg0.2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension
  (`import { placeFitted } from './compose.js'`).
- **`strict` TypeScript.** `npm run typecheck` must pass.
- **TDD:** write the failing test first, watch it fail, then implement.
- **`Booklet` never mutates the receiver.** It returns a new Document, exactly
  as `NUp`, `Split` and `ExtractPages` do.
- **Public error types only:** `TypeError` / `RangeError` here (see errors.ts for
  the PDF-specific ones — none apply to this feature).
- **Commit after each task.** Do not use TodoWrite; this project tracks work in
  `bd` (issue `aspose-pdf-foss-for-ts-1gg0.2`).
- Run `npx vitest run test/booklet.test.ts` to target this feature's suite;
  `npm test` for the full run.

## File Structure

| File | Responsibility |
|---|---|
| `src/booklet.ts` (create) | `BookletOptions`, `BookletSide`, `BookletMetrics`, `bookletSides`, `bookletCells` — the whole pure model |
| `src/document.ts` (modify) | `Document.Booklet`, immediately after `NUp` (~line 1837) |
| `src/index.ts` (modify) | export `BookletOptions` (~line 101, beside the compose types) |
| `test/booklet.test.ts` (create) | the feature's suite |
| `README.md` (modify) | `Booklet` in the page-composition bullet and the API table |

### Things you must know before starting

**The source fixture already labels its pages.** `test/helpers/build-nup-source.ts`
exports `buildNUpSource(n)`: a PDF of `n` pages, each `[0 0 200 100]`, whose
content shows `P1`..`Pn`. That label is what lets a test prove *which* source page
landed in *which* cell, rather than merely counting XObjects. Do not write a new
fixture.

**`placeFitted` emits one `q … cm /Fm<k> Do Q` per placement**
([compose.ts:117](../../../src/compose.ts#L117)). Because the fixture's pages carry
no `/Rotate`, the matrix is always of the form `sx 0 0 sy e f`, which is what the
`placements` / `placed` helpers below parse. `test/nup.test.ts` already relies on
this same shape.

**A 200×100 page lands in a 200×100 cell at scale 1.** Under the default sheet
size, `cellW` reduces to exactly the source width and `cellH` to its height, so
`sx = sy = 1` and `e` is simply the cell's `x0`. That is why the creep tests can
read the shift straight off `e`.

---

### Task 1: `bookletSides` — padding and the ordering permutation

**Files:**
- Create: `src/booklet.ts`
- Test: `test/booklet.test.ts` (create — ordering tests only in this task)

**Interfaces:**
- Consumes: nothing. This module imports nothing at all.
- Produces:
  - `interface BookletOptions { binding?: 'left' | 'right'; pageSize?: [number, number]; margin?: number; gutter?: number; creep?: number }`
  - `interface BookletSide { sheet: number; left: number | null; right: number | null }`
  - `bookletSides(pageCount: number, binding?: 'left' | 'right'): BookletSide[]`

- [x] **Step 1: Write the failing tests**

Create `test/booklet.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bookletSides } from '../src/booklet.js';

/** Compact ["8|1", "2|7", …] view of a booklet's sides; '_' is a pad blank. */
const shape = (sides: ReturnType<typeof bookletSides>) =>
  sides.map((s) => `${s.left ?? '_'}|${s.right ?? '_'}`);

describe('bookletSides — ordering', () => {
  it('orders a 4-page booklet onto one sheet, two sides', () => {
    expect(shape(bookletSides(4, 'left'))).toEqual(['4|1', '2|3']);
    expect(bookletSides(4, 'left').map((s) => s.sheet)).toEqual([0, 0]);
  });

  it('nests an 8-page booklet outermost sheet first', () => {
    expect(shape(bookletSides(8, 'left'))).toEqual(['8|1', '2|7', '6|3', '4|5']);
    expect(bookletSides(8, 'left').map((s) => s.sheet)).toEqual([0, 0, 1, 1]);
  });

  it('nests a 12-page booklet', () => {
    expect(shape(bookletSides(12, 'left')))
      .toEqual(['12|1', '2|11', '10|3', '4|9', '8|5', '6|7']);
  });

  it("mirrors every side with binding 'right'", () => {
    expect(shape(bookletSides(8, 'right'))).toEqual(['1|8', '7|2', '3|6', '5|4']);
  });

  it('defaults to left binding', () => {
    expect(shape(bookletSides(8))).toEqual(shape(bookletSides(8, 'left')));
  });

  it('pads up to a multiple of 4, the blanks falling at the end of the book', () => {
    expect(shape(bookletSides(5, 'left'))).toEqual(['_|1', '2|_', '_|3', '4|5']);
    expect(shape(bookletSides(6, 'left'))).toEqual(['_|1', '2|_', '6|3', '4|5']);
    expect(shape(bookletSides(7, 'left'))).toEqual(['_|1', '2|7', '6|3', '4|5']);
  });

  it('places every real page exactly once, whatever the padding', () => {
    for (const n of [1, 2, 3, 5, 9, 13]) {
      const seen = bookletSides(n, 'left')
        .flatMap((s) => [s.left, s.right])
        .filter((p): p is number => p !== null)
        .sort((a, b) => a - b);
      expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    }
  });

  it('returns no sides for an empty page count', () => {
    expect(bookletSides(0, 'left')).toEqual([]);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/booklet.test.ts`
Expected: FAIL — cannot resolve `../src/booklet.js`.

- [x] **Step 3: Create `src/booklet.ts`**

```ts
// Saddle-stitch booklet imposition: the pure model (issue 1gg0.2). Padding, the
// sheet ordering permutation, and cell geometry including creep. This module
// imports nothing and touches no PDF objects, so the arithmetic that is silently
// wrong when reversed can be tested without building a file. Sheet assembly
// lives in document.ts (Document.Booklet), beside NUp.

/** Options for {@link Document.Booklet}. */
export interface BookletOptions {
  /** Binding edge. 'right' mirrors every side for an RTL book. Default 'left'. */
  binding?: 'left' | 'right';
  /** Output sheet size [w, h]; default = [2*W + 2*margin + gutter, H + 2*margin]
   *  from the first source page's CropBox. */
  pageSize?: [number, number];
  /** Outer margin in points around both cells. Default 0. */
  margin?: number;
  /** Spacing in points between the two cells (across the spine). Default 0. */
  gutter?: number;
  /** Creep compensation in points per nesting level; inner sheets' content
   *  shifts toward the spine and sheet 0 never moves. Default 0. */
  creep?: number;
}

/** @internal One printed side of a folded sheet. */
export interface BookletSide {
  /** Nesting level of the physical sheet: 0 = outermost. Drives creep. */
  sheet: number;
  /** 1-based source page number in the left cell, or null for a pad blank. */
  left: number | null;
  /** 1-based source page number in the right cell, or null for a pad blank. */
  right: number | null;
}

/** @internal Resolved sheet geometry, shared by every side. */
export interface BookletMetrics {
  sheetW: number;
  sheetH: number;
  cellW: number;
  cellH: number;
  margin: number;
  gutter: number;
  creep: number;
}

/** @internal The printed sides of a saddle-stitch booklet of `pageCount` pages,
 *  in duplex print order (sheet 0 front, sheet 0 back, sheet 1 front, …).
 *
 *  Pages are padded to a multiple of 4. A padded page number beyond `pageCount`
 *  is a blank and comes back as `null` rather than a number, so the caller
 *  places nothing there — as NUp leaves the unused cells of a partial last sheet
 *  empty. Sheet s carries front `[N-2s | 2s+1]` and back `[2s+2 | N-2s-1]`;
 *  'right' binding swaps the two cells on every side. */
export function bookletSides(
  pageCount: number, binding: 'left' | 'right' = 'left',
): BookletSide[] {
  if (pageCount <= 0) return [];
  const n = Math.ceil(pageCount / 4) * 4;
  const cell = (p: number): number | null => (p <= pageCount ? p : null);
  const sides: BookletSide[] = [];
  for (let s = 0; s < n / 4; s++) {
    const pairs: [number, number][] = [
      [n - 2 * s, 2 * s + 1],   // front
      [2 * s + 2, n - 2 * s - 1], // back
    ];
    for (const [l, r] of pairs) {
      const [left, right] = binding === 'right' ? [r, l] : [l, r];
      sides.push({ sheet: s, left: cell(left), right: cell(right) });
    }
  }
  return sides;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/booklet.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/booklet.ts test/booklet.test.ts
git commit -m "feat(booklet): saddle-stitch page ordering and padding (1gg0.2)"
```

---

### Task 2: `bookletCells` — cell geometry and creep

**Files:**
- Modify: `src/booklet.ts` (append after `bookletSides`)
- Test: `test/booklet.test.ts` (append a second `describe`)

**Interfaces:**
- Consumes: `BookletMetrics` (Task 1).
- Produces: `bookletCells(m: BookletMetrics, sheet: number): { left: [number, number, number, number]; right: [number, number, number, number] }`

- [x] **Step 1: Write the failing tests**

Append to `test/booklet.test.ts`, and extend the `../src/booklet.js` import to
`import { bookletSides, bookletCells, type BookletMetrics } from '../src/booklet.js';`:

```ts
describe('bookletCells — geometry and creep', () => {
  /** A 400x100 sheet of two abutting 200x100 cells: the default for a 200x100
   *  source, where a cell is an exact 1:1 fit. */
  const m: BookletMetrics = {
    sheetW: 400, sheetH: 100, cellW: 200, cellH: 100,
    margin: 0, gutter: 0, creep: 0,
  };

  it('splits the sheet into two abutting cells with no margin, gutter or creep', () => {
    expect(bookletCells(m, 0)).toEqual({
      left: [0, 0, 200, 100],
      right: [200, 0, 400, 100],
    });
  });

  it('insets both cells by the margin and separates them by the gutter', () => {
    const g: BookletMetrics = {
      sheetW: 430, sheetH: 120, cellW: 200, cellH: 100,
      margin: 10, gutter: 10, creep: 0,
    };
    expect(bookletCells(g, 0)).toEqual({
      left: [10, 10, 210, 110],
      right: [220, 10, 420, 110],
    });
  });

  it('leaves the outermost sheet unshifted however large the creep', () => {
    expect(bookletCells({ ...m, creep: 5 }, 0)).toEqual(bookletCells(m, 0));
  });

  it('shifts inner sheets toward the spine — both cells move inward', () => {
    const c = bookletCells({ ...m, creep: 2 }, 3);   // d = 3 * 2 = 6
    expect(c.left).toEqual([6, 0, 206, 100]);        // moved right, toward the centre
    expect(c.right).toEqual([194, 0, 394, 100]);     // moved left, toward the centre
  });

  it('keeps both cells their declared size while creeping', () => {
    const c = bookletCells({ ...m, creep: 2 }, 3);
    expect(c.left[2] - c.left[0]).toBeCloseTo(200, 9);
    expect(c.right[2] - c.right[0]).toBeCloseTo(200, 9);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/booklet.test.ts -t bookletCells`
Expected: FAIL — `bookletCells is not a function`.

- [x] **Step 3: Implement `bookletCells`**

Append to `src/booklet.ts`:

```ts
/** @internal The two cell rects `[x0, y0, x1, y1]` of a sheet at nesting level
 *  `sheet`, with creep applied.
 *
 *  **Creep direction.** Nested sheets protrude at the fore edge when folded, and
 *  the stack is then trimmed flush, so INNER pages lose more fore-edge paper
 *  than outer ones. The compensation therefore moves inner sheets' content
 *  TOWARD the spine — left cell `+d`, right cell `-d`. Reversing this looks
 *  identical on screen and is wrong on paper, which is why the sign has its own
 *  test. Sheet 0 is never shifted, so `creep: 0` is byte-identical to omitting
 *  the option.
 *
 *  The offset moves the whole cell rect, not the content within a fixed cell:
 *  `placeFitted` scales-to-fit and centres inside whatever rect it is given, so
 *  the placed content translates and does not change size. */
export function bookletCells(
  m: BookletMetrics, sheet: number,
): { left: [number, number, number, number]; right: [number, number, number, number] } {
  const d = sheet * m.creep;
  const y0 = m.margin, y1 = m.margin + m.cellH;
  const leftX0 = m.margin + d;
  const rightX0 = m.margin + m.cellW + m.gutter - d;
  return {
    left: [leftX0, y0, leftX0 + m.cellW, y1],
    right: [rightX0, y0, rightX0 + m.cellW, y1],
  };
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/booklet.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/booklet.ts test/booklet.test.ts
git commit -m "feat(booklet): cell geometry with creep compensation (1gg0.2)"
```

---

### Task 3: `doc.Booklet` — sheet assembly

**Files:**
- Modify: `src/document.ts` (import block ~line 50; new method after `NUp`, ~line 1837)
- Modify: `src/index.ts` (~line 101, beside the compose type exports)
- Test: `test/booklet.test.ts` (append a third `describe`)

**Interfaces:**
- Consumes: `bookletSides`, `bookletCells`, `BookletOptions`, `BookletMetrics`
  (Tasks 1-2); `placeFitted` from `./compose.js` (already imported by
  document.ts); the private `Document.createEmptyDocument`,
  `requireIndirectPagesRoot`, `allocObject`, `syncPages` that `NUp` already uses.
- Produces: `Document.Booklet(opts?: BookletOptions): Document`

This task wires the method up with defaults only. Option **validation** is
Task 4 — do not add the `throw` statements yet.

- [x] **Step 1: Write the failing tests**

Append to `test/booklet.test.ts`. Extend the imports at the top of the file with:

```ts
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { isDict, isStream, type PdfDict } from '../src/types.js';
import { buildNUpSource } from './helpers/build-nup-source.js';
```

and add these helpers below the existing `shape` helper:

```ts
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** The /XObject sub-dict of a page's own /Resources, or an empty map when
 *  nothing was placed on the page (both of its cells were pad blanks). */
function pageXObjects(doc: Document, page: Page): PdfDict {
  const res = doc.resolve(page.Dict.get('Resources'));
  const xo = isDict(res) ? doc.resolve(res.get('XObject')) : undefined;
  return isDict(xo) ? xo : new Map();
}

/** Every placement on `page`, in content order: which source page the placed
 *  Form XObject draws (its "P3" label, from build-nup-source.ts) and the `cm`
 *  translation that positioned it. */
function placed(doc: Document, page: Page): { label: string; e: number; f: number }[] {
  const xobjs = pageXObjects(doc, page);
  const content = dec(page.Contents);
  const re = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*\/(\w+) Do/g;
  const out: { label: string; e: number; f: number }[] = [];
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const xobj = doc.resolve(xobjs.get(m[5]));
    const body = isStream(xobj) ? dec(xobj.raw) : '';
    out.push({ label: body.match(/\((P\d+)\)/)?.[1] ?? '?', e: +m[3], f: +m[4] });
  }
  return out;
}

/** Parse `sx 0 0 sy e f cm` placements from a content string, in order. */
function placements(content: string): { sx: number; sy: number }[] {
  const re = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  const out: { sx: number; sy: number }[] = [];
  for (let m = re.exec(content); m; m = re.exec(content))
    out.push({ sx: +m[1], sy: +m[2] });
  return out;
}
```

Then append the suite:

```ts
describe('doc.Booklet', () => {
  it('returns a new Document with one page per printed side, source unchanged', () => {
    const doc = Document.Open(buildNUpSource(8));
    const out = doc.Booklet();
    expect(out).not.toBe(doc);
    expect(out.Pages.length).toBe(4);        // 8 pages -> 2 sheets -> 4 sides
    expect(doc.Pages.length).toBe(8);        // source untouched
  });

  it('pads a non-multiple-of-4 source up to whole sheets', () => {
    expect(Document.Open(buildNUpSource(5)).Booklet().Pages.length).toBe(4); // -> 8
    expect(Document.Open(buildNUpSource(1)).Booklet().Pages.length).toBe(2); // -> 4
  });

  it('places the saddle-stitch order onto the sheets', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet();
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P8', 'P1']);
    expect(placed(out, out.Pages[1]).map((p) => p.label)).toEqual(['P2', 'P7']);
    expect(placed(out, out.Pages[2]).map((p) => p.label)).toEqual(['P6', 'P3']);
    expect(placed(out, out.Pages[3]).map((p) => p.label)).toEqual(['P4', 'P5']);
  });

  it("mirrors the order with binding 'right'", () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ binding: 'right' });
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P1', 'P8']);
    expect(placed(out, out.Pages[1]).map((p) => p.label)).toEqual(['P7', 'P2']);
  });

  it('derives a 2-up landscape sheet from the source page size', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet();   // source 200x100
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 400, 100]);
    expect(out.Pages[0].Dict.get('CropBox')).toEqual([0, 0, 400, 100]);
  });

  it('grows the default sheet by margin and gutter', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet({ margin: 10, gutter: 5 });
    // 2*200 + 2*10 + 5 = 425 ; 100 + 2*10 = 120
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 425, 120]);
  });

  it('honors an explicit pageSize', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet({ pageSize: [612, 792] });
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 612, 792]);
  });

  it('fits a 200x100 page into its 200x100 cell without scaling', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet();
    const places = placements(dec(out.Pages[0].Contents));
    expect(places.length).toBe(2);
    for (const p of places) {
      expect(p.sx).toBeCloseTo(1, 6);
      expect(p.sy).toBeCloseTo(1, 6);
    }
  });

  it('places nothing at all in a pad blank cell', () => {
    const out = Document.Open(buildNUpSource(5)).Booklet();  // '_|1','2|_','_|3','4|5'
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P1']);
    expect(pageXObjects(out, out.Pages[0]).size).toBe(1);
    expect(placed(out, out.Pages[3]).map((p) => p.label)).toEqual(['P4', 'P5']);
    expect(pageXObjects(out, out.Pages[3]).size).toBe(2);
  });

  it('round-trips through Save/Open', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet();
    const rt = Document.Open(out.Save());
    expect(rt.Pages.length).toBe(4);
    expect(placed(rt, rt.Pages[0]).map((p) => p.label)).toEqual(['P8', 'P1']);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/booklet.test.ts -t "doc.Booklet"`
Expected: FAIL — `doc.Booklet is not a function`.

- [x] **Step 3a: Import the model into `src/document.ts`**

Add beside the compose import at line 50:

```ts
import { bookletSides, bookletCells, type BookletOptions, type BookletMetrics } from './booklet.js';
```

- [x] **Step 3b: Add the `Booklet` method**

In `src/document.ts`, immediately after `NUp`'s closing brace (~line 1837):

```ts
  /** Impose this document's pages as a saddle-stitch booklet into a **new**
   *  Document (this one is unmodified, like NUp/Split/ExtractPages). Pages are
   *  padded to a multiple of 4 and reordered so that printing the result duplex
   *  and folding the stack down the middle reads in sequence: two source pages
   *  per printed side, each imported as a shared Form XObject and placed
   *  scaled-to-fit in its cell. `binding: 'right'` mirrors every side for an RTL
   *  book. `creep` compensates for the fore-edge push-out of nested sheets by
   *  shifting inner sheets' content toward the spine. Throws RangeError when the
   *  document has no pages. */
  Booklet(opts: BookletOptions = {}): Document {
    const binding = opts.binding ?? 'left';
    const margin = opts.margin ?? 0, gutter = opts.gutter ?? 0, creep = opts.creep ?? 0;

    const src = this.Pages;
    if (src.length === 0) throw new RangeError('Booklet: document has no pages');

    // Cell base size from the first page's CropBox (falls back to MediaBox),
    // through NUp(2, 1)'s formula so the two features stay dimensionally
    // consistent: a booklet cell is exactly an N-up cell.
    const [bx0, by0, bx1, by1] = src[0].CropBox;
    const baseW = Math.abs(bx1 - bx0), baseH = Math.abs(by1 - by0);
    const [sheetW, sheetH] = opts.pageSize ?? [
      2 * baseW + 2 * margin + gutter,
      baseH + 2 * margin,
    ];
    const metrics: BookletMetrics = {
      sheetW, sheetH,
      cellW: (sheetW - 2 * margin - gutter) / 2,
      cellH: sheetH - 2 * margin,
      margin, gutter, creep,
    };

    const sides = bookletSides(src.length, binding);
    const out = Document.createEmptyDocument();
    const rootNum = out.requireIndirectPagesRoot();
    const sheetNums: number[] = [];
    for (let i = 0; i < sides.length; i++) {
      const page: PdfDict = new Map<string, PdfObject>([
        ['Type', name('Page')],
        ['Parent', ref(rootNum)],
        ['MediaBox', [0, 0, sheetW, sheetH]],
        ['CropBox', [0, 0, sheetW, sheetH]],
        ['Resources', new Map<string, PdfObject>()],
      ]);
      sheetNums.push(out.allocObject(page).num);
    }
    out.syncPages(sheetNums.map((n) => ref(n)));

    for (let i = 0; i < sides.length; i++) {
      const side = sides[i];
      const sheet = out.Pages[i];
      const cells = bookletCells(metrics, side.sheet);
      // A null cell is a pad blank: place nothing, as NUp does for the unused
      // cells of a partial last sheet.
      if (side.left !== null) placeFitted(out, sheet, src[side.left - 1], cells.left);
      if (side.right !== null) placeFitted(out, sheet, src[side.right - 1], cells.right);
    }
    return out;
  }
```

- [x] **Step 3c: Export the public type**

In `src/index.ts`, beside the compose type exports (~line 101):

```ts
export type { BookletOptions } from './booklet.js';
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/booklet.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/document.ts src/index.ts test/booklet.test.ts
git commit -m "feat(booklet): doc.Booklet imposes saddle-stitch sheets (1gg0.2)"
```

---

### Task 4: option validation

**Files:**
- Modify: `src/document.ts` (`Booklet`, the top of the method)
- Test: `test/booklet.test.ts` (append a fourth `describe`)

**Interfaces:**
- Consumes: `Document.Booklet` (Task 3).
- Produces: no new exported symbols — `Booklet` gains its `throw` statements.

- [x] **Step 1: Write the failing tests**

Append to `test/booklet.test.ts`:

```ts
describe('doc.Booklet — validation', () => {
  const doc = () => Document.Open(buildNUpSource(4));

  it('throws RangeError for a document with no pages', () => {
    expect(() => Document.Open(buildNUpSource(0)).Booklet()).toThrow(RangeError);
  });

  it('rejects a binding that is neither left nor right', () => {
    expect(() => doc().Booklet({ binding: 'top' as 'left' })).toThrow(TypeError);
  });

  it('rejects a negative or non-finite margin, gutter or creep', () => {
    expect(() => doc().Booklet({ margin: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ gutter: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ creep: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ creep: Infinity })).toThrow(TypeError);
    expect(() => doc().Booklet({ margin: NaN })).toThrow(TypeError);
  });

  it('rejects a malformed pageSize', () => {
    expect(() => doc().Booklet({ pageSize: [0, 100] })).toThrow(TypeError);
    expect(() => doc().Booklet({ pageSize: [-1, 100] })).toThrow(TypeError);
    expect(() => doc().Booklet({ pageSize: [100] as unknown as [number, number] }))
      .toThrow(TypeError);
  });

  it('accepts zero for margin, gutter and creep', () => {
    expect(() => doc().Booklet({ margin: 0, gutter: 0, creep: 0 })).not.toThrow();
  });

  it('leaves the source document untouched when a call is rejected', () => {
    const d = doc();
    const before = d.Save();
    expect(() => d.Booklet({ creep: -1 })).toThrow(TypeError);
    expect(d.Save()).toEqual(before);
    expect(d.Pages.length).toBe(4);
  });
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/booklet.test.ts -t validation`
Expected: FAIL — the bad-option cases do not throw (a negative `creep` silently
produces a booklet, `binding: 'top'` silently behaves as `'left'`).

- [x] **Step 3: Add the validation**

In `src/document.ts`, replace the first two lines of `Booklet`'s body —

```ts
    const binding = opts.binding ?? 'left';
    const margin = opts.margin ?? 0, gutter = opts.gutter ?? 0, creep = opts.creep ?? 0;
```

— with:

```ts
    const binding = opts.binding ?? 'left';
    if (binding !== 'left' && binding !== 'right')
      throw new TypeError("Booklet: binding must be 'left' or 'right'");
    const margin = opts.margin ?? 0, gutter = opts.gutter ?? 0, creep = opts.creep ?? 0;
    if (!Number.isFinite(margin) || margin < 0)
      throw new TypeError('Booklet: margin must be a finite number >= 0');
    if (!Number.isFinite(gutter) || gutter < 0)
      throw new TypeError('Booklet: gutter must be a finite number >= 0');
    if (!Number.isFinite(creep) || creep < 0)
      throw new TypeError('Booklet: creep must be a finite number >= 0');
    if (opts.pageSize !== undefined &&
        (!Array.isArray(opts.pageSize) || opts.pageSize.length !== 2 ||
         !opts.pageSize.every((n) => Number.isFinite(n) && n > 0)))
      throw new TypeError('Booklet: pageSize must be [w, h] (two positive numbers)');
```

The rest of the method is unchanged.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/booklet.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add src/document.ts test/booklet.test.ts
git commit -m "feat(booklet): validate Booklet options before building (1gg0.2)"
```

---

### Task 5: creep end-to-end, docs, and close-out

**Files:**
- Test: `test/booklet.test.ts` (append a fifth `describe`)
- Modify: `README.md` (page-composition bullet ~line 23; API table ~line 1338)

**Interfaces:**
- Consumes: everything from Tasks 1-4. Adds no source symbols.

- [x] **Step 1: Write the failing tests**

Append to `test/booklet.test.ts`:

```ts
describe('doc.Booklet — creep', () => {
  // Source 200x100 -> 400x100 sheet, two 200x100 cells at x0 = 0 and x0 = 200.
  // The fit is 1:1, so each placement's `e` IS its cell's x0.
  it('leaves the outermost sheet in place and pulls inner sheets toward the spine', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ creep: 2 });
    const sheet0 = placed(out, out.Pages[0]);   // ['P8','P1'] — nesting level 0
    const sheet1 = placed(out, out.Pages[2]);   // ['P6','P3'] — nesting level 1
    expect(sheet0[0].e).toBeCloseTo(0, 6);      // left cell, unshifted
    expect(sheet0[1].e).toBeCloseTo(200, 6);    // right cell, unshifted
    expect(sheet1[0].e).toBeCloseTo(2, 6);      // left cell moved RIGHT, inward
    expect(sheet1[1].e).toBeCloseTo(198, 6);    // right cell moved LEFT, inward
  });

  it('applies the same shift to both sides of one physical sheet', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ creep: 2 });
    expect(placed(out, out.Pages[2]).map((p) => p.e))
      .toEqual(placed(out, out.Pages[3]).map((p) => p.e));
  });

  it('does not resize the placed content', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ creep: 2 });
    for (const p of placements(dec(out.Pages[2].Contents))) {
      expect(p.sx).toBeCloseTo(1, 6);
      expect(p.sy).toBeCloseTo(1, 6);
    }
  });

  it('creep 0 is identical to no creep at all', () => {
    const a = Document.Open(buildNUpSource(8)).Booklet({ creep: 0 }).Save();
    const b = Document.Open(buildNUpSource(8)).Booklet().Save();
    expect(a).toEqual(b);
  });
});
```

- [x] **Step 2: Run the tests**

Run: `npx vitest run test/booklet.test.ts -t creep`
Expected: PASS on the first run, because `bookletCells` already applies creep.
**Do not accept that at face value** — this repo's rule is that a green-on-first-run
test must be proved load-bearing, and a reversed creep sign is exactly the bug
that looks fine on screen. Temporarily flip the sign in `bookletCells`:

```ts
  const leftX0 = m.margin - d;                        // was + d
  const rightX0 = m.margin + m.cellW + m.gutter + d;  // was - d
```

Re-run and confirm the first test goes RED (`expected -2 to be close to 2`). Then
restore both lines and confirm GREEN again.

- [x] **Step 3: Document the API in README.md**

In the **Page composition** feature bullet (~line 23), after the `doc.NUp(...)`
sentence, add:

```markdown
`doc.Booklet(opts?)` imposes the pages as a saddle-stitch booklet into a **new** `Document` — padded to a multiple of 4 and reordered so printing duplex and folding down the middle reads in sequence, two pages per printed side (`binding` for an RTL book, `pageSize`, `margin`, `gutter`, and `creep` to compensate for the fore-edge push-out of nested sheets).
```

In the API table, immediately after the `doc.NUp(...)` row (~line 1338):

```markdown
| `doc.Booklet(opts?)` | Impose pages as a saddle-stitch booklet into a new `Document` — padded to a multiple of 4, 2-up per printed side in fold order (`binding`, `pageSize`, `margin`, `gutter`, `creep`) |
```

- [x] **Step 4: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: both green. The full suite matters here: `Document` gained a method and
`index.ts` a type export, so the document/compose/nup suites must stay green.

- [x] **Step 5: Commit and close the issue**

```bash
git add test/booklet.test.ts README.md
git commit -m "test(booklet): creep proof; docs(booklet): README Booklet (1gg0.2)"
bd close aspose-pdf-foss-for-ts-1gg0.2
git pull --rebase && git push && git status
```

Then file the follow-up the spec deferred:

```bash
bd create "Booklet: sheetsPerSignature (multi-signature imposition)" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-1gg0 \
  -d "doc.Booklet imposes a single signature: every sheet nests in one fold. A long book cannot be folded that way (40 nested sheets is not physical), so real binderies split it into signatures of N sheets, each folded and stapled separately. Add sheetsPerSignature?: number to BookletOptions, splitting the padded page list into chunks of 4*N and running the existing per-signature ordering over each. Deferred from 1gg0.2; see docs/superpowers/specs/2026-07-28-booklet-imposition-design.md."
```

---

## Notes for the implementer

- **`src/booklet.ts` imports nothing.** That is deliberate and load-bearing: it
  is what lets the ordering and creep arithmetic be tested as plain functions.
  If you find yourself needing `Document` there, the logic belongs in
  `document.ts` instead.
- **Do not export `bookletSides` / `bookletCells` from `index.ts`.** They are
  `@internal`; the public surface is `BookletOptions` and `Document.Booklet`.
- **Blank cells place nothing.** Do not synthesize an empty page to place — a pad
  blank is simply an absent placement, which is why `pageXObjects` in the test
  file tolerates a page with no `/XObject` sub-dict at all.
- **`Booklet` builds a new Document**, so a rejected call cannot corrupt the
  source. Validation still runs first so it cannot leave a half-built output
  either.
- **Creep is per physical sheet, not per side.** Both sides of sheet `s` get the
  same `s * creep` shift; that is why the test comparing `Pages[2]` and
  `Pages[3]` exists.
