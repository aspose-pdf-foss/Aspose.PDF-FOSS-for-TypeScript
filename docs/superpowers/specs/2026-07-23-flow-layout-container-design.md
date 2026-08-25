# Flow layout container — design (db7v.1)

**Issue:** aspose-pdf-foss-for-ts-db7v.1 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-23
**Status:** approved, ready to plan

## Goal

Add a flow/document layout container: `doc.NewFlow(options)` producing a `Flow`
that accepts content elements, lays them into a multi-column page geometry, and
auto-paginates — appending fresh pages at the end of the document as content
overflows. `flow.Render()` drives placement.

This is the **container** issue. It ships the geometry, the multi-column
pagination engine, `AddColumnBreak`, `Render`, and one minimal concrete content
element (`AddParagraph`) so the engine is exercised end-to-end. The richer
content elements are separate issues that plug into the same flowable protocol
defined here:

- db7v.2 — paragraphs & headings (styles, spacing, heading levels)
- db7v.3 — lists (bulleted / numbered)
- db7v.4 — floating boxes (wrap-around)
- db7v.5 — flow images

db7v.1 **blocks** db7v.2 and db7v.5.

## Parity target

Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go`:

```go
flow := doc.NewFlow(pdf.FlowOptions{
    Format: pdf.PageFormatA4.Landscape(),
    Columns: 2, ColumnGap: 34,
    MarginLeft: 48, MarginRight: 48, MarginTop: 128, MarginBottom: 52,
    ParagraphSpacing: 7,
})
```

Flow methods in the Go API: `AddImage`, `AddHeading`, `AddParagraph`,
`AddFloatingBox`, `AddColumnBreak`, `AddList`. The flow "appends its own page(s)
at the end," auto-paginating as content overflows. db7v.1 implements the
container plus `AddParagraph` and `AddColumnBreak`; the rest arrive with the
sibling issues.

## Module & public surface

New file **`src/flow.ts`** holds the engine, geometry, `PageFormat`,
`FlowOptions`, the flowable-element protocol, and the minimal paragraph.
`doc.NewFlow()` is added to the `Document` facade (`document.ts`). Public types
are re-exported from `index.ts`. `README.md` gains a Flow-layout subsection.

### PageFormat

A small Go-parity abstraction (the user chose this over the codebase's bare
`[w, h]` tuple idiom). All values in points (1/72").

```ts
class PageFormat {
  readonly width: number;
  readonly height: number;
  static readonly A4     = new PageFormat(595, 842);
  static readonly Letter = new PageFormat(612, 792);
  static readonly Legal  = new PageFormat(612, 1008);
  static custom(width: number, height: number): PageFormat; // validates > 0, finite
  landscape(): PageFormat; // returns a format with width >= height
  portrait():  PageFormat; // returns a format with height >= width
}
```

`landscape()`/`portrait()` return `this` when already in the requested
orientation, else a new `PageFormat` with the dimensions swapped. Instances are
immutable.

### FlowOptions

```ts
interface FlowOptions {
  format?: PageFormat;        // default PageFormat.A4
  columns?: number;           // default 1; integer >= 1
  columnGap?: number;         // default 0; gutter between columns, pts, >= 0
  marginLeft?: number;        // default 72
  marginRight?: number;       // default 72
  marginTop?: number;         // default 72
  marginBottom?: number;      // default 72
  paragraphSpacing?: number;  // default 0; gap between elements, pts, >= 0
}
```

Validation at `NewFlow` (throw `TypeError` on violation): every provided number
finite; `columns` an integer `>= 1`; margins/gap/spacing `>= 0`; derived
`columnWidth > 0` and column height `> 0`.

### Flow

```ts
doc.NewFlow(options?: FlowOptions): Flow

class Flow {
  AddParagraph(text: string, options?: FlowParagraphOptions): this; // chainable
  AddColumnBreak(): this;
  Render(): Page[]; // appends fresh pages at doc end; returns them in order
}
```

`Render()` is single-shot: a second call throws (`Flow already rendered`), since
re-running would append duplicate pages. `AddHeading`/`AddList`/`AddImage`/
`AddFloatingBox` are intentionally absent — they belong to db7v.2–.5 and will
implement the `FlowElement` protocol defined below.

## Geometry

Derived once from `FlowOptions` (identical on every page the flow creates):

- `contentLeft   = marginLeft`
- `contentTop    = format.height - marginTop`
- `contentBottom = marginBottom`
- `contentWidth  = format.width - marginLeft - marginRight`
- `columnWidth   = (contentWidth - (columns - 1) * columnGap) / columns`
- column `c` left edge = `contentLeft + c * (columnWidth + columnGap)`
- column height = `contentTop - contentBottom`

## Flowable protocol + pagination engine

The abstraction sibling issues plug into:

```ts
interface FlowElement {
  place(ctx: {
    doc: Document; page: Page;
    x: number; top: number;      // column left edge, current top (PDF user space)
    width: number;               // columnWidth
    availHeight: number;         // top - contentBottom
  }): {
    usedHeight: number;              // height consumed in this column
    remainder: FlowElement | null;   // overflow → continue in next column/page
    drew: boolean;                   // did anything paint?
  };
}
```

`AddColumnBreak()` enqueues a lightweight break marker (a discriminated value,
not a `FlowElement`) that the engine recognizes.

**Engine loop (`Render`).** Create page 1 via `doc.AddPage()`, set its
`MediaBox = [0, 0, format.width, format.height]`. Walk columns `0..columns-1` on
the current page; when the columns are exhausted with content still queued,
append another fresh page (same size) and continue. Within a column, greedily
place queued items from `colTop` (initially `contentTop`) toward
`contentBottom`:

- **drew && !remainder** — advance `colTop` by `usedHeight`, then by
  `paragraphSpacing` before the next element. Spacing is dropped at a column top
  (never applied before the first element of a column).
- **drew && remainder** — column is full: unshift the remainder element, move to
  the next column.
- **!drew** — nothing fit in the space left: move to the next column. If this is
  a *fresh, full-height* column and the element still draws nothing (column
  shorter than a single line of that element), `Render` throws a descriptive
  error rather than loop forever.
- **break marker** — skip to the next column (next page if it was the last
  column).

The flow only ever **appends** pages at the document end; it never anchors onto
or draws over existing content. This matches the parity behavior and keeps the
engine independent of the rest of the document.

`Render()` returns the array of pages it created, in order.

## Minimal paragraph, reusing the stamp/layout stack

The paragraph element does **no** text emission of its own — it drives the
existing `layout.ts` wrap engine and `stamp.ts` emitter. One helper is added to
**`stamp.ts`**:

```ts
// stamp.ts
export function flowTextBlock(
  doc: Document, page: Page, text: string,
  rect: [number, number, number, number], options: TextBlockOptions,
): { remainder: string | null; usedHeight: number };
```

`flowTextBlock` contains what `stampTextBlock` does today plus a reported
`usedHeight` (`lines.length * leading`). `stampTextBlock` is refactored into a
thin wrapper that calls `flowTextBlock` and returns just `remainder` — no
behavior change to the existing public API, verified by the existing stamp
tests.

The paragraph element stores `text` and normalized options. Its `place()` calls
`flowTextBlock` with rect `[x, top - availHeight, width, availHeight]`
(top-aligned within the slice). A non-null remainder string becomes a
continuation paragraph element carrying the same options. `drew` is
`usedHeight > 0`.

```ts
interface FlowParagraphOptions {
  font?: AuthoringFont;                         // default 'Helvetica'
  fontSize?: number;                            // default 12
  color?: [number, number, number];            // default [0,0,0]
  align?: 'left' | 'center' | 'right' | 'justify'; // default 'left'
  leading?: number;                             // default 1.2 * fontSize
}
```

`valign` is deliberately excluded (flow content is always top-down). The
embedded-font and complex-text-shaping paths are inherited for free through the
shared `flowTextBlock` helper — the flow engine stays unaware of them.

## Testing (`test/flow.test.ts`, vitest)

Programmatic fixtures (per repo convention). Assertions prove the engine
load-bearing, not merely green:

- **Geometry** — column x positions and widths follow `columns`, `columnGap`,
  and margins for 1- and multi-column configs.
- **Pagination** — text long enough to overflow spans N appended pages;
  `Render()` returns exactly those pages; each page's `MediaBox` equals the
  format.
- **Multi-column fill order** — content fills column 0, then column 1, then a
  new page (verified by extracted text positions).
- **Column break** — `AddColumnBreak()` jumps to the next column while space
  remains in the current one.
- **PageFormat** — `.landscape()` swaps dimensions; created page size reflects
  it; `.portrait()`/`.landscape()` are idempotent when already oriented.
- **Round-trip** — `page.GetText()` confirms the real content landed on the
  expected pages in reading order, asserting against output *outside* the text
  emitter.
- **stampTextBlock unchanged** — existing stamp tests stay green after the
  `flowTextBlock` refactor.
- **Guards** — `Render()` called twice throws; a column too short for one line
  throws; invalid `FlowOptions` throw `TypeError`.

## Defaults chosen (flagged for record)

- Margins default to 72pt (1"); `columnGap` and `paragraphSpacing` default to 0
  — conservative and explicit.
- `Render()` is single-shot (throws on re-call) rather than idempotent.

## Out of scope (sibling issues)

Headings, lists, images, floating boxes, keep-together/keep-with-next, per-page
running headers/footers, and any anchoring onto pre-existing pages. The
`FlowElement` protocol and the engine are designed so these land as new element
types without reworking the container.
