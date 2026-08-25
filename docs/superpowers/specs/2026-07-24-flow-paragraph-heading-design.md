# Flow paragraph & heading elements — design (db7v.2)

**Issue:** aspose-pdf-foss-for-ts-db7v.2 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-24
**Status:** approved, ready to plan
**Depends on:** db7v.1 (Flow container: geometry, columns, auto-pagination) — shipped

## Goal

Complete the paragraph/heading authoring surface of the flow engine:
`flow.AddHeading(level, text, options)` and per-element spacing on both headings
and paragraphs, over the existing `layout.ts` word-wrap engine and `stamp.ts`
emitter. `AddParagraph` already shipped in db7v.1; this issue adds headings,
per-element spacing, and opt-in logical-structure tagging.

## Parity target

Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go`:

```go
h2 := pdf.TextStyle{Font: pdf.FontHelveticaBold, Size: 15, Color: indigo}
flow.AddHeading(2, name, h2)
flow.AddParagraph(tagline, lede)
flow.AddParagraph(formula, pdf.TextStyle{Font: formulaFont, Size: 15, Color: indigo, HAlign: pdf.HAlignCenter})
```

Go's `AddHeading(level, text, style)` is `(level int, text string, style TextStyle)`.
This library keeps the TS option idiom established in db7v.1
(`FlowParagraphOptions` with `font`/`fontSize`/`color`/`align`/`leading`) rather
than adopting the Go `TextStyle` field names (`Size`/`LineSpacing`/`HAlign`).

## Public surface

```ts
class Flow {
  AddParagraph(text: string, options?: FlowParagraphOptions): this; // existing; gains spacing
  AddHeading(level: number, text: string, options?: FlowHeadingOptions): this; // new
  AddColumnBreak(): this;   // existing
  Render(): Page[];         // existing
}
```

`AddHeading` returns `this` (chainable). `level` is an integer in `1..6`; any
other value throws `TypeError`.

### Options

Both option interfaces gain per-element spacing. `FlowHeadingOptions` is
structurally identical to `FlowParagraphOptions` — `level` is the positional
argument, not an option field.

```ts
interface FlowParagraphOptions {
  font?: AuthoringFont;                              // default 'Helvetica'
  fontSize?: number;                                 // default 12
  color?: [number, number, number];                 // default [0, 0, 0]
  align?: 'left' | 'center' | 'right' | 'justify';   // default 'left'
  leading?: number;                                  // default 1.2 * fontSize
  spaceBefore?: number;   // pts inserted above the element; finite, >= 0; default 0
  spaceAfter?: number;    // pts inserted below the element; finite, >= 0; default 0
}

type FlowHeadingOptions = FlowParagraphOptions;
```

`spaceBefore`/`spaceAfter` validate as non-negative finite numbers (throw
`TypeError` otherwise), consistent with the existing option validation.

### `FlowOptions` addition

```ts
interface FlowOptions {
  // ...existing fields unchanged...
  tagged?: boolean;   // default false; enable logical-structure tagging on Render
}
```

## Heading level semantics

`level` (1..6) drives **overridable presentational defaults** and the **logical
structure type**.

- **Default font size** when `options.fontSize` is not given: a fixed ramp
  indexed by level — `[24, 18, 14, 12, 10, 8]` for levels 1..6. An explicit
  `fontSize` always wins (matches the Go example, which passes `Size: 15`).
- **Default font** when `options.font` is not given: `Helvetica-Bold`
  (paragraphs continue to default to `Helvetica`).
- `color`, `align`, `leading`, `spaceBefore`, `spaceAfter` behave exactly as for
  a paragraph and are all overridable.
- **Structure type**: `H1`..`H6` (paragraphs → `P`). Emitted **only when the
  flow is tagged** (see below).

## Logical-structure tagging (opt-in)

`FlowOptions.tagged` defaults to `false`. When `false`, no structure tree is
touched and the flow's byte output is unchanged from db7v.1.

When `true`, `Render()`:

1. Ensures a structure tree via `doc.CreateStructTree()` (reuses an existing one
   if present).
2. Appends **one `/Sect` grouping element** for this flow under the tree root.
3. Each text element, on its **first successful draw**, appends its own
   `/Hn` (heading) or `/P` (paragraph) `StructElement` under that `/Sect`, then
   passes it as the `tag` option to `flowTextBlock`.

This rides entirely on existing machinery:

- `flowTextBlock` already accepts `options.tag: StructElement` and emits the
  `BDC/EMC` marked-content wrapper (`wrapMarkedContent` + `allocContentMcid`)
  **only when `lines.length > 0`** — i.e. only when a line actually paints. An
  overflow probe (`availHeight` too small, zero lines) allocates no MCID and
  leaves the struct element untouched, so it produces no orphan.
- A paragraph or heading that spans a column/page boundary reuses **one**
  `StructElement` across its continuations. The existing MCR (marked-content
  reference) cross-page path in the struct writer handles the multi-page case —
  already covered by `struct-write.test.ts` ("uses MCR entries when one element
  spans two pages").

**Reading order.** Struct elements are appended under `/Sect` in first-draw
order, which equals queue (authoring) order: the engine places elements strictly
in queue order, and a later element never draws before an earlier element's
continuations complete. So append-on-first-draw yields correct logical order.

**No orphan on empty text.** Text that probes to zero drawable glyphs is
discarded by the engine (`remainder === null`, `drew === false`) and never draws;
its struct element is therefore never created (creation is on first successful
draw), so the tree gains no empty node.

## Spacing engine change

Today the engine applies the global `paragraphSpacing` *after* a fully-placed
element (`colTop -= paragraphSpacing`), dropped at a column top via the
`atColumnStart` reset. This is refactored into a single **gap-before-element**
computation:

```
gap = atColumnStart ? 0 : (prevSpaceAfter + paragraphSpacing + thisSpaceBefore)
```

- The gap is **additive** and **entirely dropped at a column top** — the first
  element of any column starts flush at `contentTop`, so a heading never dangles
  a leading gap directly under a column head.
- `prevSpaceAfter` is the `spaceAfter` of the previously fully-placed element in
  the current column (0 at a column top).
- With no per-element spacing set, `gap` reduces to the uniform
  `paragraphSpacing` between elements — **identical** to today's behavior, so
  existing pagination tests stay green.
- The gap reduces both `colTop` and the `availHeight` handed to `place()`. If
  the reduced space cannot hold the element, the normal overflow path advances
  the column and the gap is discarded.
- A **continuation** (overflow remainder) element carries `spaceBefore = 0` — it
  already started — and retains its `spaceAfter`, which applies only once the
  element finally completes.

## Implementation shape

The existing internal `ParagraphElement` is generalized into one
`TextElement implements FlowElement` carrying:

- `text: string`
- normalized `TextBlockOptions` (font/size/color/align/leading)
- `structType: string` — `'P'` for paragraphs, `'H1'`..`'H6'` for headings
- `spaceBefore: number`, `spaceAfter: number`
- a lazily-created / continuation-carried `tag?: StructElement`

`AddParagraph` and `AddHeading` are thin constructors over `TextElement`.
`AddHeading` computes the effective `TextBlockOptions` by applying the level ramp
(font size) and bold-default (font) before user overrides, and sets
`structType = 'H' + level`.

The `FlowElement` protocol gains optional readable spacing so the engine can
compute the gap without knowing the concrete element type:

```ts
interface FlowElement {
  place(ctx: PlaceContext): PlaceResult;
  readonly spaceBefore?: number;   // default treated as 0
  readonly spaceAfter?: number;    // default treated as 0
}
```

`PlaceContext` gains an optional `structParent?: StructElement` (the `/Sect`),
present only when the flow is tagged; a `TextElement` appends its `structType`
element under it on first draw and reuses it thereafter.

## Testing (`test/flow.test.ts`, additive)

Programmatic fixtures per repo convention; assertions proven load-bearing, not
merely green:

- **Heading ramp & bold default** — `AddHeading(1, …)` with no options renders at
  24pt Helvetica-Bold (assert via `page.MeasureText` / extracted glyph widths
  against the ramp size); levels 1..6 map to `[24,18,14,12,10,8]`.
- **Explicit override wins** — `AddHeading(2, …, { fontSize: 15, font: 'Times-Bold' })`
  uses 15pt Times-Bold, not the ramp.
- **Level guard** — `AddHeading(0, …)` / `AddHeading(7, …)` / non-integer throw
  `TypeError`.
- **Per-element spacing** — `spaceBefore`/`spaceAfter` shift following content by
  the expected number of points (assert extracted text Y positions); both drop
  at a column top (first element flush at `contentTop`); combine additively with
  the global `paragraphSpacing`.
- **Spacing validation** — negative / non-finite `spaceBefore`/`spaceAfter` throw
  `TypeError`.
- **Tagged round-trip** — a tagged flow with a heading then a paragraph
  round-trips through `Save()` → `GetStructTree()`; `ElementFor(...)` reports
  `H2` then `P` in reading order (mirrors `struct-write.test.ts`); a `BDC/EMC`
  pair wraps each body.
- **Untagged emits no structure** — default (`tagged` unset) flow output carries
  no `/StructParents` on its pages and no struct tree is created.
- **Heading spanning a column boundary** — a heading long enough to overflow a
  column produces exactly one struct element (MCR spanning), not two.
- **Regression** — existing flow pagination/geometry tests and all `stamp.ts`
  tests stay green (the spacing refactor and the generalized `TextElement`
  preserve current behavior).

## Defaults chosen (flagged for record)

- **`tagged` is opt-in** (default `false`) rather than auto-enabling whenever a
  heading is added, so default flow output stays byte-identical to db7v.1.
- **`spaceBefore`/`spaceAfter` default to `0`** (explicit) rather than baking in
  heading whitespace, matching db7v.1's conservative-and-explicit defaults.
- **Heading font-size ramp** `[24, 18, 14, 12, 10, 8]` and **`Helvetica-Bold`**
  bold default; both fully overridable.

## Out of scope (follow-up)

- **Keep-with-next / orphan-widow control** for headings (a heading dangling at a
  column bottom pushing to the next column) is deferred to a new issue
  (db7v.6), per the design decision. It needs engine lookahead and is a
  self-contained follow-up.
- Lists (db7v.3), floating boxes (db7v.4), and flow images (db7v.5) remain their
  own issues.
