# Geometry-Path Nested Table Extraction Design

> Issue: `aspose-pdf-foss-for-ts-e2o` — nested tables in the geometry path.
> Follow-up to `aspose-pdf-foss-for-ts-84u` (tagged-path nesting, which shipped
> the `TableCell.tables` model field and nested `toHtml()`) and `7y8` (geometry
> v1). This issue is only the geometry **detection algorithm** — model and
> serialization already support nesting.

## Goal

Detect a table nested inside a ruled table's cell in the untagged (geometry)
path, and attach it to its parent `TableCell` (recursive, arbitrary depth), with
its text removed from the parent cell — reusing the `tables` field and nested
`toHtml()` from 84u.

## Problem

`extractTables` in `src/table.ts` builds one flat grid with `assembleTable` from
**all** clustered ruling-line positions on the page. It has no notion of nesting
levels: a nested grid's rules contribute global cut positions, so the nested
cells flatten into the outer grid as top-level cells and the surrounding
container area fragments. The detector is also single-table-per-page today.

## Key insight and the false-positive trap

The one signal that survives regardless of whether the nested table's border
touches the parent cell's border is **rule span**: an outer table's separators
run (near) the full width/height of the table, while a nested table's *interior*
separators run only within one cell. Connectivity alone fails the
shared-border case, so classification is by span, not by touching strokes.

The trap: a **spanning cell** (e.g. a merged header over two columns) also
produces a partial/short divider. The discriminator is that a nested table is a
**cluster of ≥2×2 confined rules**, whereas a spanning-cell divider is a *lone*
confined line. Only ≥2×2 clusters are treated as nested; lone confined dividers
are left in place so the existing spanning-cell logic still applies.

## Architecture

All logic lives **in `src/table.ts`**, reusing its module-private helpers
(`assembleTable`, `buildCells`, `cellText`, `uniqSorted`, `collectRules`,
`contains`, `centroid`). No new module (would require exporting those
internals). No changes to `src/tablemodel.ts`, `src/tablestruct.ts`,
`src/page.ts`, or `src/index.ts`. `Rule` is the existing `{ pos; lo; hi }`.

## Algorithm

A recursive function replaces the direct `assembleTable` call on the ruled path:

```
buildRuledRegion(horiz: Rule[], vert: Rule[], frags: TextFragment[], bbox: Rect): Table | undefined
```

**Constant:** `SPAN_FRAC = 0.9` (structural-span threshold τ).

1. **Classify** each clustered rule relative to `bbox`
   (`bboxWidth = bbox[2]-bbox[0]`, `bboxHeight = bbox[3]-bbox[1]`):
   - horizontal `h` is *structural* if `h.hi - h.lo >= SPAN_FRAC * bboxWidth`;
   - vertical `v` is *structural* if `v.hi - v.lo >= SPAN_FRAC * bboxHeight`;
   - otherwise *confined*.

2. **Coarse container grid.** Build a *coarse* grid from **structural rules
   only**: `coarse = assembleTable(structuralHoriz, structuralVert, [])`. Its
   cells are the *container* rectangles that a nested table may sit inside. (This
   grid is used only to locate/bound nested tables; it is **not** the returned
   table.) If `coarse` is `undefined` (fewer than 2 structural cuts on an axis),
   there are no container cells → no container qualifies, and step 4 builds the
   outer table from all rules (identical to today's flat path).

3. **Per-container nested detection.** For each coarse cell `C`:
   - `inConfinedH` / `inConfinedV` = confined rules whose extent lies within
     `C.quad` (expanded by `SNAP`).
   - `fragsC` = fragments whose centroid is in `C.quad`.
   - **Tier 1 (inset):** `cand = assembleTable(inConfinedH, inConfinedV, fragsC)`.
   - **Tier 2 (shared border):** if Tier 1 is `undefined` or not `≥2×2`, retry
     with the container edges added as rules —
     `assembleTable(inConfinedH + [topEdge, bottomEdge], inConfinedV + [leftEdge,
     rightEdge], fragsC)`, where the edges are `Rule`s along `C.quad`'s sides
     (a horizontal rule at `C.top`/`C.bottom` spanning `[C.left, C.right]`, etc.).
   - `C` **qualifies** with the first candidate that has
     `rowCount >= 2 && colCount >= 2`. Record `{ cell: C, rules: the qualifying
     rule set, bbox: cand.quad }`. Otherwise `C` contributes nothing (its
     confined rules, if any, remain lone dividers).

   A lone confined divider (e.g. a spanning-cell border) never reaches `≥2×2`
   under either tier, so it is not treated as nested.

4. **Build the returned outer table** with `assembleTable(outerHoriz, outerVert,
   outerFrags)` where `outerHoriz`/`outerVert` = **all** rules minus the confined
   rules consumed by a qualified container, and `outerFrags` = `frags` minus
   fragments whose centroid is inside a qualified container's nested `bbox`.
   Because only qualified nested rules are removed, lone dividers stay and
   spanning-cell behavior is preserved. If the outer grid has < 1 row or column,
   return `undefined`.

5. **Attach + recurse.** For each qualified container `{ cell, rules, bbox }`:
   - find the *outer* cell whose `quad` contains `centroid(bbox)`;
   - recursively `nested = buildRuledRegion(rules.horiz, rules.vert, fragsInBbox,
     bbox)` — so a nested table's own confined clusters become deeper nested
     tables (arbitrary depth);
   - if `nested`, push it onto that outer cell's `tables` and recompute the
     cell's `text = cellText(frags in cell.quad but outside every qualified
     nested bbox)`.

**Regression safety:** when no container qualifies (the common case — no nested
tables), step 4 runs `assembleTable` on all rules and no cell text is
recomputed, so output is byte-identical to today. The coarse grid is internal
and never returned.

**Tier rationale:** an *inset* nested table's own confined lines already form a
`≥2×2` grid (Tier 1). A *shared-border* nested table has only interior confined
lines (e.g. one vertical + one horizontal); it becomes `≥2×2` only once bounded
by the container-cell edges (Tier 2). Preferring Tier 1 keeps the inset nested
table tight rather than padded out to the whole container cell.

## Integration

In `extractTables` (`src/table.ts`), the ruled branch changes from calling
`assembleTable(horiz, vert, frags)` to `buildRuledRegion(horiz, vert, frags,
bbox)`, where `bbox` is the union of all rule extents
(`[minLo_x, minLo_y, maxHi_x, maxHi_y]` computed from `horiz`/`vert`). The
`≥2 h-cuts && ≥2 v-cuts` guard, the tagged-first dispatch (k33), and the
whitespace fallback are unchanged. The whitespace/borderless path gets **no**
nested detection (rule-based only, consistent with 84u's ruled-only nested
choice).

## Serialization

No change — `Table.toHtml()` already nests a child `<table>` inside the parent
`<td>`/`<th>` (84u), and `toMarkdown()` already omits nested tables. Geometry
nested tables carry no `isHeader`/`scope`/`id`/`headers`/`summary` (those are
tagged-only), so they render as plain nested grids.

## Testing

**Fixtures** (built with the existing `hline`/`vline`/`text`/`buildTablePdf`
helpers in `test/helpers/build-table-pdf.ts`):

- **Inset nested:** outer 2×2 ruled grid; one cell contains a 2×2 grid drawn
  with a gap (separate strokes, no shared border).
- **Shared-border nested:** outer 2×2 grid; one cell contains a 2×2 grid whose
  outer border coincides with the parent cell borders (the harder case).
- **Spanning-cell control:** an outer table with a merged 2-column header (a lone
  partial divider) and **no** nested table.
- **Deep nesting:** a nested cell that itself contains a 2×2 grid.

**Tests** (`test/table-nested.test.ts`, new):

- Inset and shared-border: outer table stays 2×2; the container cell has
  `tables.length === 1`; nested is 2×2 with the expected cell text; container
  `text` excludes nested content.
- Spanning-cell control: exactly one flat table, correct colspan, and **no** cell
  has a `tables` field (false-positive guard).
- Deep nesting: the nested cell carries its own `tables`.
- Serialization: `Page.GetTables()[0].toHtml()` nests the child `<table>`.
- Regression: the full existing `test/table.test.ts` stays green (no nested
  clusters ⇒ byte-identical output); `npm test` all green.

## Scope

**In scope:** rule-hierarchy nested detection on the geometry ruled path
(arbitrary depth); the `SPAN_FRAC` threshold constant; parent-cell text
stripping.

**Out of scope:** whitespace/borderless nested detection; multiple-tables-per-page
(`aspose-pdf-foss-for-ts-fwc`); rotated/skewed tables (`5ct`); cross-page tables
(`7ac`).

**Files touched:** `src/table.ts` (add `buildRuledRegion` + confined-cluster
helpers; call it from `extractTables`), `README.md` (limitations note), and a new
`test/table-nested.test.ts` with fixtures added to
`test/helpers/build-table-pdf.ts` if new primitives are needed. No public API
signature changes.
