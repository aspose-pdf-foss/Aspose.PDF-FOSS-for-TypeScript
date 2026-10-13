# XFA page breaking into page areas (`164g.3`)

Today a page subform's page is its ordinal among its siblings: page subform
k takes the k-th `<pageArea>` and lands on PDF page k, and `xfaconvert.ts`
refuses every field of a document whose `<pageArea>` count differs from its
page count. XFA does not work that way. A `<pageArea>` is a prototype,
instantiated as often as layout needs it, so three of the four vendored hybrid
forms (fw9, I-130, I-765: one `<pageArea>`, 6, 12 and 7 pages) are refused
outright, and OPM 1644's `Page2` lands nowhere. This design makes pages an
OUTPUT of layout.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Layout needs more pages than the PDF has | In a **dynamic** document (`/NeedsRendering true`, no AcroForm fields) the PDF's pages are Designer's placeholder: replace them with fresh pages sized from each `<medium>`. A **hybrid** keeps its pages; its count must equal the layout's or the document is refused, as today. |
| 2 | Content that does not fit the room left | **Never split.** A child that does not fit moves whole to the next content area. Splitting (with overflow leaders and trailers) is filed as its own issue. |
| 3 | How much `<pageSet>` selection | **`orderedOccurrence` only**: page-area `occur`, `breakBefore`/`breakAfter`/legacy `break` targets, `startNew`, several content areas per page area. `simplexPaginated`, `duplexPaginated` and nested page sets are refused by name and filed. |
| 4 | Where pagination lives | A new pure module, **`xfapage.ts`**, deciding which root child lands in which content area; `xfaflow.ts` still decides every position. Paginating inside `xfaflow.ts` (776 lines) would mix "which page" with "where on it"; deciding pages in the template walk is impossible, since fitting needs laid-out heights. |

## Sources

XFA Specification 3.3, as pinned by 164g.1 (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`); printed
page numbers.

- **The layout algorithm** (p. 288): the root subform is placed into the first
  content area of the first page area; "as each new content node is encountered
  it is placed within the current container, unless and until the current
  container fills up".
- **Flowing between content areas** (p. 294): a full content area gives way to
  its next sibling in document order; when every content area of the page area
  is full, a new page area is added, chosen by the pagination strategy.
- **Overriding content area boundaries** (p. 295): when the current content
  region is EMPTY and the object fits neither it nor the next, "the layout
  processor overrides the boundaries of the current content region to force the
  layout object down onto the page".
- **`orderedOccurrence`** (p. 295) is the default relation. **Determining the
  start point** (p. 296): the root's `breakBefore`, else the root's FIRST
  subform child's `breakBefore`, else the first page area. **Occurrence limits**
  (p. 296–300): a page area or page set with no `occur` replicates without limit
  (`max` -1); a page area whose `max` is spent gives way to the next page area,
  then to a new page-set instance; when every limit is spent, "the additional
  content is discarded" (p. 300).
- **Page selection and break conditions** (p. 269–270, 360–362):
  `targetType="pageArea"` treats the current page as full; `contentArea` moves
  to the next available content area; `target` is `#` + an XML ID, else a SOM
  expression; `startNew="1"` always starts a new container, `0` only when the
  current one does not match the target. A target resolving to nothing is an
  error the spec recovers from by going "to the next available" (p. 361).
- **`breakAfter`** (p. 365, 635) mirrors `breakBefore`.
- **The deprecated `break` element** (p. 632–634): `before`/`after` take the
  `targetType` values, `beforeTarget`/`afterTarget` are `#` + XML ID, and
  `startNew` applies to `before`. OPM 1644 uses it
  (`<break before="pageArea" startNew="1">`).

**A conflict, recorded.** Example 9.22 (p. 362) shows a FIRST child asserting
`breakBefore startNew="1"` leaving page 1 blank. The start-point rule (p. 296,
added in XFA 2.5) and both oracles disagree: every page subform of I-130 and
I-765 after the first carries `startNew="1"` and so does fw9's third, and
Adobe puts page 1's content on page 1; pdf.js puts OPM's `Page1` on page 1. We
follow the start-point rule: **the first placed child's `breakBefore` selects
where layout starts and never opens a page of its own.** Everywhere else a
break is processed as written, including a `breakAfter` followed by a
`breakBefore` (p. 360: "processed sequentially").

## The evidence

| Form | PDF pages | Page areas | Root | Page subforms |
|---|---|---|---|---|
| IRS f1040 | 2 | 2 | `tb` | `breakBefore target="PageArea1"`, `"PageArea2"` |
| IRS fw9 | 6 | 1 | `tb` | first targets `PageArea1`; the rest `startNew="1"`, three with the target too |
| USCIS I-130 | 12 | 1 (inset content area) | `tb` | all but the first `startNew="1"` |
| USCIS I-765 | 7 | 1 (inset content area) | `tb` | all but the first `startNew="1"` |
| OPM 1644 | 1 (placeholder) | 1 | `tb` | `Page2` has legacy `<break before="pageArea" startNew="1">` |

Every page subform is as tall as its content area, to the rounding of its
units, with ONE exception: fw9's odd pages are `h="10.999597in"` = 791.971pt
inside a content area of 791.968pt. Adobe puts each on its own page, which is
the p. 295 override. No vendored form has content that would split.

## Design

### 1. The template (`xfatemplate.ts`)

`parseXfaTemplate` stops assigning pages. `XfaTemplate.roots` and
`XfaField.pageIndex` are replaced by:

```ts
export interface XfaContentArea { name?: string; id?: string; node: LayoutNode }
export interface XfaPageAreaModel extends XfaPageArea {
  id?: string;
  /** `<occur max>`; -1 (the default, p. 300) is no limit. */
  max: number;
  contentAreas: XfaContentArea[];
}
export interface XfaPageSet {
  /** `relation`, `orderedOccurrence` when absent. */
  relation: string;
  max: number;
  pageAreas: XfaPageAreaModel[];
  /** Why this page set cannot be paginated: a nested page set, an unreadable
   *  `occur`, a page area with no content area and `max` -1 (p. 298). */
  refusal?: string;
}
export interface XfaBreak {
  targetType: 'auto' | 'contentArea' | 'pageArea' | string;
  target?: string;
  startNew: boolean;
  /** A script, leader, trailer or `pageEven`/`pageOdd`: refused, by name. */
  refusal?: string;
}
export interface XfaBody {
  /** The root (the subform carrying `<pageSet>`): its layout must be `tb`. */
  root: LayoutNode;
  pageSet?: XfaPageSet;
  /** The root's children in document order, instances included (164g.2), each
   *  a LayoutNode with `breakBefore`/`breakAfter` attached. */
  children: LayoutNode[];
}
```

`LayoutNode` gains `breakBefore?: XfaBreak` and `breakAfter?: XfaBreak`, read
from `<breakBefore>`, `<breakAfter>` or the legacy `<break>` (whose
`before`/`beforeTarget`/`startNew` and `after`/`afterTarget` map onto the same
model). The 164g.2 refusal "a repeating page subform needs page breaking
(164g.3)" is lifted: an instance of a repeating page subform is one more child.

### 2. Pagination (`xfapage.ts`, new, pure)

```ts
export interface PaginatedPage {
  pageArea: number;
  /** Per content area of that page area, the children that landed there. */
  contentAreas: Array<{ index: number; children: LayoutNode[] }>;
}
export interface Pagination {
  pages: PaginatedPage[];
  /** A child that could not be placed, with the reason each field below it gets. */
  refused: Map<LayoutNode, string>;
}
export function paginate(
  body: XfaBody,
  height: (n: LayoutNode, limit: number) => { h: number; past: boolean } | { reason: string },
): Pagination;
```

It walks `children` with a cursor (page-set instance, page-area instance and
its occurrence count, content area, height used) and applies, in order:

1. **Start point** (p. 296): the first child's `breakBefore` target, else the
   first page area. It never opens a page of its own (the recorded conflict).
2. **`breakBefore`**: `contentArea` moves to the next content area matching the
   target (any, without one); `pageArea` to a new page whose page area matches.
   `startNew="0"` with a target the current container already matches stays.
3. **Fit**: `height` is the child's laid-out height. (No width argument: the engine's extent of a child does not depend on its `tb` parent's width.)
   A child that fits the room left is placed. One that does not moves to the
   next content area, then the next page, and is tried there.
4. **The p. 295 override**: a child that does not fit an EMPTY content area is
   placed there anyway WHEN nothing inside it lies past the boundary
   (`past` false: every descendant box ends within the content area's
   height, `limit`). Otherwise it would need splitting, and it is refused:
   `<label>: does not fit an empty content area and would need splitting`.
5. **`breakAfter`**, as `breakBefore`, after the child is placed.
6. **Next page**: the next content area of the page area; then a new instance of
   the same page area while its `max` allows; then the next page area; then a
   new page-set instance while its `max` allows. Past every limit the remaining
   children are refused: `content past every page area's occur max is discarded
   (p. 300)`.

**Targets.** `#id` resolves against the `id` of page areas and content areas; a
bare name (an NCName, the shape f1040 writes) against their `name`. It must
resolve to exactly one object of the type `targetType` names. Anything else is
REFUSED rather than sent "to the next available" (p. 361): a field placed
perfectly on the wrong page looks right.

**Refused by name**, each field below the child getting the reason:

| Shape | Reason |
|---|---|
| Root layout not `tb` | `the root subform's layout "…" is not paginated (only tb)` |
| `relation` other than `orderedOccurrence` | `pageSet relation="…" is not implemented` |
| A page set inside a page set, or a `<pageSet>` not on the root | `a nested pageSet is not paginated` |
| A break with a `<script>`, `leader`, `trailer`, or `pageEven`/`pageOdd` | `<breakBefore …> is not implemented` |
| A target resolving to nothing, or to more than one | `break target "…" names no pageArea` (etc.) |
| Too tall for an empty content area with content past the boundary | as step 4 |
| Past every occurrence limit | as step 6 |
| No page area declares a `<contentArea>` | `no pageArea declares a contentArea, so no content can be laid out (p. 296)` |
| A content area that states no `h` | `contentArea … states no h, so it cannot be filled` |

**A page area with no `<contentArea>` is pure boilerplate** (p. 296, 298): reached by the advance, it is emitted as a page holding nothing and the advance continues; its `max` of -1 is read as 1 with a warning, as p. 298 recommends. Designer always writes a content area; several hand-built test templates in this repo do not, and they gain one rather than an invented content area being assumed.

**A refused child refuses every child after it**, each with `an earlier item in its flow could not be laid out (<cause>)`, the rule `xfaflow.ts` already applies inside a flow: the root IS a `tb` flow, so where a later page subform lands depends on the one that failed. (This corrects the first draft, which kept later children on their pages.) When the page set itself is refused, every child is.

### 3. Layout (`xfaflow.ts`)

One addition: `measureExtent(node, limit, measure?)` returning the
node's laid-out height and `past`, whether any descendant's box ends below
`limit`. After pagination, each content area holding children becomes a
layout root exactly as `pageRootOf` builds one today, except that its layout is
`tb` and its children are the page's children; `layoutPage` lays it out. The
engine decides every position; pagination decides membership only.

### 4. The converter (`xfaconvert.ts`)

**Plan, then apply.** `buildXfaPlan` paginates and lays out, allocating
nothing; each field's page is its LAID-OUT page index.

**Page identity** replaces today's page-area count rule:

- **Dynamic** (catalog `/NeedsRendering true` and an `/AcroForm` with no
  fields): at apply time, and only when at least one field is placed, the PDF's
  pages are removed and the laid-out pages created in order, each sized from its
  page area's `<medium>` (`short` x `long`, swapped for `orientation=
  "landscape"`). A laid-out page whose page area has no readable `<medium>` gets no
  invented size, and since a missing page would shift every later one, the
  WHOLE document's geometry is refused. The created page IS the medium, so the
  medium check holds by construction. A replaced placeholder is named in
  `warnings`.
- **Hybrid** (anything else): the laid-out page count must equal the PDF's, or
  the whole document's geometry is refused, the message naming both. The
  per-page `<medium>` check against each CropBox is unchanged.

`XfaConvertReport` gains `pagesCreated: number` (0 for a hybrid). A conversion
that places nothing leaves the document byte-identical, as today.

An `<overflow target>` (or the legacy `overflowTarget`) acts only when content SPLITS (p. 366), which this design never does, so it is read and ignored rather than refused.

### 5. Out of scope, filed

- Content splitting, with overflow leaders and trailers, `keep`, and adhesion (`164g.8`).
- `simplexPaginated`/`duplexPaginated`, `pagePosition`/`oddOrEven`, `pageEven`/
  `pageOdd` breaks (`164g.9`).
- Break scripts.
- d3mq part 2 (master-page fields on every page) is unblocked by this, not done.

## Testing

- **Adobe oracle** (`test/xfa-real.test.ts`): fw9 (6 pages), I-130 (12) and
  I-765 (7) convert from the template alone with their `/AcroForm /Fields`
  stripped, and every placed rect is compared with Adobe's. The exact-match
  counts are pinned as equalities, and any field that does not match is
  explained in `test/fixtures/xfa/PROVENANCE.md`, not tolerated. **f1040's 151
  exact rects is the fence** and must not move.
- **pdf.js oracle** (`test/xfa-dynamic-oracle.test.ts`): `published` paginates
  to 2 pages and `pages` to 4, as pdf.js does; `Page2`'s fields agree with
  pdf.js's boxes; in `pages`, `Page2[k]` is on page k + 2 and binds `Bank k+1`.
  The placed counts are re-pinned.
- **`xfapage.ts`** from hand-built nodes, one case per rule: the start point
  (and no blank first page), targets by `#id` and by name, `startNew` both
  ways, `contentArea` breaks across several content areas, `breakAfter`, the
  legacy `break`, page-area and page-set `max`, the p. 295 override and its
  refusal half, each refusal in the table, and a refused child leaving later
  children on their pages.
- **Converter**: a dynamic document gets fresh pages of its medium's size and
  loses its placeholder; nothing placed leaves it byte-identical; a hybrid whose
  count disagrees is still refused; `pagesCreated`.
- **Mutation sweep** over `xfapage.ts` and the converter's page identity, its
  result recorded in CLAUDE.md.
