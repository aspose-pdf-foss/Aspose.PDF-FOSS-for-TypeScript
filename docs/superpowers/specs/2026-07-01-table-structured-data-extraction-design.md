# Table / Structured-Data Extraction — Design

- **Issue:** aspose-pdf-foss-for-ts-7y8 (P3, feature)
- **Date:** 2026-07-01
- **Status:** approved (brainstorming)

## Goal

Reconstruct tables (rows / cells) from a page's text-fragment geometry and vector
ruling lines, and optionally serialize them to HTML and Markdown. This is a
higher-level analytics layer built on the shipped positioned-text extraction
(`extractFragments`/`extractStructured` in `text.ts`); the only new low-level
work is capturing vector ruling lines from content operators.

## Acceptance criteria (from issue)

Given a page, detect table regions and emit a rows×cells model with cell text and
bounding quads; handle ruled and whitespace-delimited tables; optional
HTML/Markdown serialization. Tested against representative fixtures.

## Scope (confirmed)

- **Both** ruled and whitespace-delimited tables, in one issue.
- Output: model **plus** `toHtml()` and `toMarkdown()`.
- Discovery: **auto-detect across the page, with an optional caller `region`** to
  constrain/force extraction of a known area.
- **Spanning cells** (`rowSpan`/`colSpan`) are supported in the v1 model.

## Approach: unified separator model

Both ruling lines and whitespace gaps reduce to a single set of horizontal cuts
(y) and vertical cuts (x). A maximal grid is built from the union of cuts; cells
and spans are derived by asking which interior separators are actually *present*:

- A ruled table with a missing interior rule → a cell that spans across that cut.
- A whitespace table has every inferred cut "present" → a clean simple grid.

This gives one code path for ruled, borderless, and partially-ruled tables, and
makes span derivation fall out of the same model. (Rejected alternatives:
ruled-primary + whitespace-fallback — two divergent paths, awkward for
partially-ruled tables; whitespace-primary with lines as hints — weak on merged
cells and heavily-ruled grids.)

## Components

### 1. Ruling-line capture — `src/text.ts` (extension)

Extend the existing content walker rather than adding a second walk.

- Add an optional callback to `ContentVisitor`:

  ```ts
  interface PathEvent {
    addr: ContentAddr;
    /** Page-space axis segments [x0,y0,x1,y1] after CTM. */
    segments: [number, number, number, number][];
    stroke: boolean;   // painted with S/s/B/B*
    fill: boolean;     // painted with f/F/f*/B/B*
    /** Stroke width in page units (line-width * CTM scale); 0 when unknown. */
    lineWidth: number;
  }
  interface ContentVisitor {
    glyph?(e: GlyphEvent): void;
    image?(e: ImageEvent): void;
    path?(e: PathEvent): void;   // new
  }
  ```

- In `walkScope`, track path-construction state and line width:
  - `w` sets current line width (transformed by CTM scale at paint time).
  - `m x y` → start subpath / current point; `l x y` → line segment; `h` →
    close (segment back to subpath start).
  - `re x y w h` → four edge segments.
  - Curves `c`/`v`/`y` → approximated by a segment between current point and the
    final control point (endpoints only; curves are not tables, but this keeps
    the current point correct and avoids dropping a following `l`).
  - Paint ops `S`/`s`/`f`/`F`/`f*`/`B`/`B*`/`b`/`b*`/`n` flush the constructed
    subpaths as one `PathEvent` (with `stroke`/`fill` set per op; `n` emits
    nothing paintable but resets the path), then clear path state.
  - All points transformed by the current CTM into page space.
- Existing glyph/image consumers are unaffected (callback is optional).

Rationale for living in `text.ts`: it already owns `visitContent`, the CTM/path
threading, and `ContentAddr`; a parallel walker would duplicate all of that.

### 2. Detection pipeline — `src/table.ts` (new)

```
GetTables(doc, page, options?) ->
  1. collect rule segments (PathEvent) + fragments (extractFragments),
     clipped to options.region if given
  2. keep axis-aligned rules: horizontal (|y0-y1| ~ 0) and vertical (|x0-x1| ~ 0);
     thin filled rectangles collapse to their long centerline segment
  3. cluster rules into connected "rule networks" (segments sharing endpoints /
     near-intersections) -> each dense network is a ruled-table candidate region
  4. remaining text not covered by a ruled candidate -> whitespace candidates,
     conservatively: require >=2 rows and >=2 columns separated by a consistent
     vertical whitespace gap spanning most rows
  5. per candidate -> buildGrid -> Table
```

**buildGrid (per candidate region):**

- **y-cuts (row boundaries):** cluster horizontal rule y-positions (snap within
  tolerance); if absent, derive from text-line clustering (baseline gaps, reusing
  the line grouping already in `extractStructured`).
- **x-cuts (column boundaries):** cluster vertical rule x-positions; if absent,
  derive from a whitespace X-projection over the region (columns of near-zero
  glyph coverage wider than a gap threshold, present across most rows).
- **maximal grid:** sorted unique cuts define an `(rows) × (cols)` lattice of
  atomic rectangles.
- **cells & spans:** starting from each not-yet-consumed top-left atomic cell,
  grow right while no interior *vertical* rule covers the shared edge, and grow
  down while no interior *horizontal* rule covers the shared edge; mark consumed.
  Whitespace-inferred cuts count as "present" (always split), so borderless
  tables yield a simple grid. Each resulting cell records
  `row/col/rowSpan/colSpan/quad`.
- **cell text:** assign fragments to a cell by fragment-centroid containment;
  assemble with the existing intra-line spacing logic (left-to-right, insert a
  space on gaps > 0.25·fontSize), multiple lines joined with `\n`.

Tolerances (snap distance, gap thresholds) are module constants derived from
median font size / rule spacing; not exposed in v1.

### 3. Public API

`page.ts` gains a thin wrapper (mirrors `GetText`/`GetTextFragments`/
`GetStructuredText`):

```ts
Page.GetTables(options?: TableExtractOptions): Table[]
```

Exported from `index.ts` via `table.ts`:

```ts
type Rect = [number, number, number, number];   // reuse text.ts Rect (page space)

interface TableExtractOptions { region?: Rect; }

interface TableCell {
  row: number; col: number;        // grid position of the cell's top-left atom
  rowSpan: number; colSpan: number;
  quad: Rect;                      // page-space bbox
  text: string;                    // assembled cell text ('' when empty)
}

interface TableRow { cells: TableCell[]; quad: Rect; }  // span cells listed once, in their top row

class Table {
  quad: Rect;
  rowCount: number;
  colCount: number;
  rows: TableRow[];
  toHtml(): string;      // <table>; td colspan/rowspan honored; text HTML-escaped
  toMarkdown(): string;  // GFM pipe table with header separator; spans approximated
}
```

**Serialization notes:**
- `toHtml`: one `<table>`; each row `<tr>`; cells `<td>` with `colspan`/`rowspan`
  attributes when > 1; cell text HTML-escaped; newlines → `<br>`.
- `toMarkdown`: GFM pipe table (first row treated as header, followed by the
  `---` separator row). Markdown cannot span, so a `colSpan` cell repeats its
  text across the covered columns and a `rowSpan` cell leaves blanks below;
  in-cell newlines become spaces. Documented as lossy.

## Data flow

```
content stream --visitContent--> glyph events  --extractFragments--> TextFragment[]
                              \-> path events   --collectRules-----> Segment[]
                                                          |
                             region? (clip) ----------> detect candidates
                                                          |
                                                       buildGrid --> Table[]
                                                          |
                                                 toHtml() / toMarkdown()
```

## Error handling

- No tables found → return `[]` (never throw).
- Degenerate candidates (0 cells, all-empty) are discarded during detection.
- Malformed / unbalanced path state is tolerated: an unterminated subpath at a
  paint op is flushed with what was constructed; unknown ops are ignored (same
  posture as the existing walker).
- No new public error types; consistent with the read-only extraction layer.

## Testing

Fixture builders in `test/helpers/` using the existing `PageGraphics` (draw
ruling lines / thin rects) + `AddText` (place cell text):

1. **Fully-ruled grid** — N×M cells, all borders. Assert `rowCount`/`colCount`,
   each cell's text and quad, and `toHtml`/`toMarkdown` output.
2. **Borderless whitespace table** — aligned columns, no rules. Assert columns
   are detected from gaps, correct row/col counts, cell text, simple grid (no
   spans).
3. **Merged-cell table** — ruled grid with a missing interior rule producing a
   `colSpan`/`rowSpan` cell. Assert span values, cell quad covers the merged
   area, and `toHtml` emits `colspan`/`rowspan`.
4. **Region-constrained** — a page with a table plus surrounding prose; assert
   `region` limits extraction to the table.
5. **Negative** — a page of ordinary paragraph text yields `[]` (guards against
   whitespace false positives).

Unit-level tests for `buildGrid` / span derivation with synthetic cut+rule
inputs (no PDF) where practical.

Run `npm run typecheck` and `npm test` (and target
`npx vitest run test/table.test.ts`) before closing the issue.

## Docs

- `README.md`: add table extraction to Features and API overview; a Limitations
  note that whitespace-table detection is heuristic (conservative; may miss
  loosely-aligned tables) and Markdown span output is approximate.
- This spec under `docs/superpowers/specs/`.

## Out of scope (v1)

- Nested tables, rotated/skewed tables (non-axis-aligned rules), and diagonal
  rules.
- Cross-page table stitching.
- Tolerance/heuristic tuning knobs in the public API (module constants only).
- Using the tagged-PDF structure tree (`/Table` structure elements) as a source;
  geometry-only for v1.
```