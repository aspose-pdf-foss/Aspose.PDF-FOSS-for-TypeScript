# Rotated / skewed (non-axis-aligned) table extraction

Issue: `aspose-pdf-foss-for-ts-5ct` (follow-up to `7y8`, table extraction v1,
geometry-only). v1 handles only axis-aligned tables with horizontal/vertical
rules.

## Problem

The extraction pipeline assumes axis-aligned geometry throughout:

- `rulesFromPath` (`src/table.ts`) keeps only segments with `dy <= AXIS_TOL`
  (horizontal) or `dx <= AXIS_TOL` (vertical); diagonal/rotated rules are dropped.
- Column/row detection projects onto page X/Y (`columnCuts`, `groupLines`,
  `uniqSorted`).
- `TextFragment.quad` / `GlyphEvent.quad` are built as `[x, y, endX, y + size]`
  (`src/text.ts`), which assumes a horizontal baseline. Under any rotation — even
  90° — the width collapses (`endX ≈ x`) and the top edge is wrong, so **rotated
  text positions are lost**, not just rules.

A rotated table (a landscape table at 90°, or a skewed scan at a few degrees)
therefore cannot be detected.

## Scope

- **In:** an arbitrary *uniform* rotation angle θ per page — both rule families
  stay perpendicular (a rigid rotation). Orthogonal cases (90/180/270) fall out
  as a subset. Both ruled and borderless tables.
- **Out:** true affine shear (non-perpendicular axes); a single page bearing
  tables at *different* angles (resolves to the dominant orientation — others may
  be missed). Both documented as limitations.

## Approach

Rotate the geometry, not the algorithms. Detect one dominant orientation θ for the
page, rotate all rules and text into an upright frame where the existing
`partitionRules` / `buildRuledRegion` / `segmentBlocks` run unchanged, then tag
each resulting table with θ.

Chosen over: (1) rewriting `table.ts` to operate in oriented coordinates natively
— a large rewrite with high regression risk against the current suite; (2)
physically rotating the page content model and re-running extraction — hacky and
imprecise.

Because output quads are returned in the table's own upright frame (see Output
below), the pipeline's quads are already in the frame we return — no back-mapping
of results is required; we only record `angle`.

**Regression gate:** when `|θ| < EPS` (≈0.3°, i.e. `0.005` rad) the page is treated
as axis-aligned and the current code path runs unchanged, so axis-aligned output
is byte-identical to today (`angle === 0`).

## Components

### a. Text layer — additive orientation (`src/text.ts`)

- In `emitGlyphs`, compute the baseline angle `θg = Math.atan2(startComb[1],
  startComb[0])` and add `angle: number` to `GlyphEvent`. The glyph's device
  origin is already `quad[0], quad[1]` (exact under any rotation).
- Extract the glyph→fragment grouping currently inline in `extractFragments` into
  a reusable pure helper `fragmentsFromGlyphs(glyphs: GlyphEvent[]): TextFragment[]`;
  `extractFragments` becomes `fragmentsFromGlyphs(<all glyphs>)`. This lets the
  rotated path reuse the same grouping.
- Add optional `angle?: number` to `TextFragment` (baseline angle; absent/0 =
  horizontal). Angle-0 content is unchanged.

### b. Orientation module — pure (`src/tableorient.ts`, new)

- `dominantAngle(segments, glyphAngles): number` — **text-baseline-primary**: the
  modal glyph baseline angle over the full circle when any glyphs exist (text
  resolves the full rotation, including 90°/180°, which rules cannot — a grid's
  rules look identical every 90°). Falls back to the length-weighted modal
  segment direction taken mod 90°, normalised to `(-45°, 45°]`, when there is no
  text. Returns 0 when neither is available.
- Rotation helpers built on `text.ts` `Matrix` / `apply` / `mul`: `rot(θ): Matrix`
  (rotation about the origin) and point/segment transform utilities.
- The `EPS` angle constant and the near-axis test.

### c. `table.ts` orchestration

- Collect *all* painted centerline segments (strokes as-is; thin fills collapsed
  to a centerline by their page-space AABB — so rotated *filled* rules are a
  documented gap; rotated *stroked* rules are captured) plus the set of glyph
  baseline angles; call `dominantAngle` → θ.
- If `|θ| < EPS`: run the existing path (angle 0), no new behaviour.
- Else: rotate segment endpoints and glyph origins by `R(-θ)` into the upright
  frame; classify the now-axis-aligned rules through the existing
  `clusterRules`/`collectRules` machinery; build oriented fragments (origin
  rotated into the frame, width ≈ `advance · fontSize`, height `fontSize`) and
  group them with `fragmentsFromGlyphs`; run the ruled and whitespace pipelines
  in the upright frame; set `angle = θ` on every returned table.

### d. `tablemodel.ts`

- Add `angle: number` (default 0) to `Table`. `quad`, rows, and cells remain
  upright-frame axis Rects. `toHtml` / `toMarkdown` are geometry-agnostic and stay
  unchanged.

## Output geometry

Cell / row / table quads stay axis-aligned Rects **in the table's own upright
frame** (grid intact, non-overlapping, precise). `Table.angle` (radians) records
the rotation; a consumer maps an upright-frame corner to page space via `R(angle)`
about the page origin. Axis-aligned tables have `angle === 0` and are identical to
today.

## Data flow & edge cases

`extractTables` → detect θ → (upright transform if rotated) → existing builders →
tables tagged with θ. Degenerate input (no rules, no text) → θ = 0. Non-
perpendicular shear → the dominant direction wins and is treated as a rotation
(shear unsupported). A page with tables at multiple distinct angles → the dominant
θ; non-conforming tables may be missed. Cross-page stitching continues to operate
within a shared θ; stitching tables of differing angles is out of scope.

## Testing

- New builder helper emitting a table wrapped in a rotation `cm` operator (rotated
  rules + text) in `test/helpers/build-table-pdf.ts`.
- Cases: ruled table at 90° and at ~5°; borderless table at 90° and at ~10° —
  assert correct `rowCount`/`colCount`, cell text, and `angle ≈ θ`.
- Regression: existing axis-aligned fixtures return `angle === 0` with identical
  structure; `npm run typecheck` and full `npm test` stay green.
