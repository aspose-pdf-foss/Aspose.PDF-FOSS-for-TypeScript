# XFA content splitting: an `lr-tb` between items, a table between rows (`164g.12`)

164g.8 splits a `tb` subform between its children. An `lr-tb` or a `table` is
still placed whole, and one too tall for an empty content area is refused. This
design splits both, from the room left, and corrects one 164g.8 rule that
Adobe contradicts (margins).

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Which oracle? | **Adobe Reader probes**, the 164g.11 pipeline (`scripts/gen-xfa-adobe-probes.ts`, `scripts/run-xfa-adobe-probe.ps1`), transcribed from window captures. |
| 2 | Scope | **Items and rows whole.** An `lr-tb` splits only between its items, a table only between its rows. Anything finer is refused by name. |
| 3 | Approach | **Extend 164g.8's fragments** (shallow copies of containers holding this region's children), not a budgeted layout in `xfaflow.ts` and not a tree rewrite. |
| 4 | The margin rule t39 overturns for `tb` | **Fixed in this issue**: one margin rule for all three layouts. |

## Evidence: Adobe Reader probes t27-t39

Adobe Acrobat Reader 26.1 (Reader mode), 2026-10-14. Every probe holds a 216pt
oracle field and a 400pt positioned filler, leaving **104pt** on page 1 of a
720pt content area. Coordinates are Adobe's: `page, x, y, w, h` in points,
relative to the parent's content box. Items are 180pt wide, three to a 540pt
line.

| Probe | Shape | Adobe |
|---|---|---|
| t27 | `lr-tb`, nine 60pt **fields** | `flow` 104 on p1, 120 on p2. f1-f3 p1 y0. **f4 split**: p1 (0,60) h44 + p2 (0,0) h16. f5, f6 p2 at x180/360 y0; f7-f9 p2 y60. |
| t28 | `lr-tb` fields, line 1 h 40/90/40, line 2 h 10/60/10 | b1 p1 (0,90). **b2 split** 14 + 46. b3 p2 **(180,0)**. |
| t29 | table, `columnWidths` 180x3, four rows of 60pt fields | `tbl` 60 on p1, 180 on p2. r1 p1; r2-r4 p2 y 0/60/120. Rows whole. |
| t30 | table `-1 -1`, rows 100/100, 100/100, 250/200 | Every row 450 wide, cells **250/200 on both pages**. r1 p1; r2, r3 p2. |
| t31 | `tb` { 30pt field, `lr-tb` of six 60pt fields } | `outer` 104 + 60. `flow` p1 (0,30) h74. f4 split 14 + 46. f5, f6 p2 x180/360. |
| t32 | `tb` { 30pt field, table of three 60pt rows } | `tbl` p1 (0,30) h60, p2 h120. r1 p1; r2, r3 p2. |
| t33 | `lr-tb` stating `h=180pt` | Whole on p2. |
| t34 | table stating `h=180pt` | Whole on p2. |
| t35 | `lr-tb` fields, margins 20/20 | `flow` **100** on p1 (20+60+20), **160** on p2 (20+120+20). f4 **moved whole** to p2 (0,0). |
| t36 | table, margins 20/20 | `tbl` **100** on p1, **160** on p2. r1 p1; r2, r3 p2. |
| t37 | `lr-tb` **draws** 40/90/40, 10/60/10, 30 | b1 p1 (0,90). b2 p2 (0,0), **b3 p2 (180,0)**, c1 p2 (360,0). `flow` 100 + 60. |
| t38 | `lr-tb`, nine 60pt draws | d1-d3 p1; d4-d9 p2 at y 0/60. `flow` 60 + 120. |
| t39 | `tb` draws 30pt x4, margins 20/20 | `stack` **100** on p1 (20+30+30+20), **100** on p2 (20+60+20). |

What they settle:

- **t37 is the decisive probe.** `b3` (10pt) would have fit on page 1 beside
  `b1`. Adobe put it on page 2. The first item that does not fit ends the
  fragment, and everything after it continues in the next region. The
  continuation **re-packs from x=0**: `b2` at 0, `b3` at 180, `c1` at 360, where
  the unsplit layout had `c1` alone on a third line.
- An `lr-tb` is **not line-atomic**. `b1` stayed on page 1 while its line
  moved (t37, t28).
- A field that straddles the cut is **split** when its piece above the cut is
  at least its font size (t27 44pt, t28 and t31 14pt), and **moved** when it is
  not (t35, 4pt with the bottom margin reserved). That is 164g.11's
  field rule (`xfasplitpos.ts`) and 164g.13's work.
- Table rows stay whole although their cells are fields (t29).
- Auto columns are sized from the **whole** table (t30).
- A stated `h` keeps the container whole (t33, t34).
- **Every fragment carries both margins**, for `lr-tb` (t35), table (t36) and
  `tb` (t39). 164g.8 gives the top margin to the first fragment and the bottom
  to the last. For t39 it would place `d3` and `d4` 20pt too high on page 2 and
  check page 1's room without the bottom margin. DD 1494, 164g.8's oracle,
  has no margins on a split subform, so it could not see this.

## Design

### 1. The rule

1. **One rule for `tb`, `lr-tb` and `table`.** Children are taken in order.
   The first child that does not fit ends the region's fragment. That child and
   every later one go to the next region, where they are laid out as a new
   fragment of the same container. No child after a cut returns to an earlier
   region.
2. **The child:**
   - `tb`: as in 164g.8;
   - `lr-tb`: each **item**;
   - `table`: each **row**, always whole.
3. **Margins:** every fragment carries both of its container's margins, and
   the fit test includes them.
4. **Table columns:** a table fragment keeps the whole table's resolved
   widths, `-1` columns included.
5. **Stated `h`:** the container is placed whole.
6. **Nesting:** an `lr-tb` or table reached in a split chain splits too.
7. **An `lr-tb` item that straddles the cut:**
   - a draw moves;
   - a field moves when its piece above the cut is below its font size, and is
     **refused** (164g.13) otherwise;
   - a subform item that is itself splittable is **refused** (a new child
     issue);
   - any other item moves.

   A row never straddles; it moves.

### 2. Which containers split

`splittable(n)` holds for a `subform` whose layout is `tb`, `lr-tb` or
`table`, which states no `h`, carries no `refusal`, and whose `keep intact` is
absent or `none`. A table's rows are its leaves and are never flattened. A
`row`, a positioned subform (164g.11 handles a keep-none root child), a draw
and a field are leaves.

### 3. Fit by measuring the region

164g.8 adds up precomputed atom heights. That cannot express rule 3 (margins
on every fragment), rule 1's re-pack, or a row measured under the whole
table's columns. Instead, pagination builds the region's **fragment tree**
leaf by leaf, and decides fit by MEASURING it:

```
fits(leaf)  <=>  usedBefore + measure(region's fragment root with leaf added) <= capacity
```

`measure` is the existing `XfaHeight` callback: `measureExtent` with a `'tb'`
parent, as bkdi requires. `xfaflow.ts` later lays out exactly the fragments
that were measured, so pagination and layout cannot disagree about a cut.

- `flatten` yields **leaves only**: each with its container path and any
  `breakBefore` riding on it. The `open` and `close` atoms and `Unit` go. A
  fragment is created only when a leaf lands in it, so 164g.8's "no fragment
  holds only margins" holds by construction.
- A fragment is a shallow copy of its container that keeps **both** margins.
  A table fragment also pins `columnWidths` to the whole table's resolved
  widths.
- **Straddle test (rule 7).** When a leaf does not fit and its parent is an
  `lr-tb`, the candidate fragment root is laid out (`layoutPage`) to read the
  leaf's top. The piece above the cut is `capacity - usedBefore - top -` the
  bottom margins of the fragments enclosing it. A field compares it with its
  font size through the helper `xfasplitpos.ts` already uses.
- **Unchanged from 164g.8:**
  - a root child that fits is never flattened;
  - a `breakBefore` in a chain is applied before its leaf;
  - an `<overflow>` is refused when its container continues into a second
    region (164g.15);
  - `breakAfter`, `keep intact="pageArea"` and adhesion in a chain are refused;
  - a chain 164g.8 cannot split falls back to whole placement.
- **The p. 295 empty-region rule** applies to a fresh fragment holding just
  that leaf, through the existing `emptyRegion`.
- **Cost:** re-measuring after every leaf is O(k²) layout per region, where k
  is the number of leaves placed there. Leaf heights are memoized per node
  inside the callback, so re-measuring lays out containers but measures no
  text twice. The plan times DD 1494.

### 4. `xfaflow.ts`

One new export: a table node's resolved column widths, computed by
`table()`'s own resolution, so widths keep one owner. Nothing else changes.
A fragment is an ordinary node.

## Risks

- DD 1494 nests `lr-tb` subforms in its split `tb` chain. They always moved
  whole and now become splittable. If one straddles a cut, its pdf.js
  comparison will say so. That is investigated, not re-recorded.
- The margin correction changes the layout of any split `tb` with margins.
  No vendored oracle has one except t39.

## Testing

**Oracle** (`test/xfa-adobe-oracle.test.ts`):
- t27-t39 are vendored beside t3-t26: `tN.xml`, the `tN.pdf` Reader rendered,
  and the capture under `captures/`.
- Their numbers go into `adobe.json` in the existing shape. Draws are added to
  it, since t37-t39 hold only draws.
- **Exact on Adobe's page and box:** t29, t30, t32-t39.
- **Refused by name:** t27, t28, t31 (164g.13).

**Fences that must not move:**
- DD 1494 against pdf.js;
- the hybrid oracles: fw9, I-130, I-765, DD 1391, DD 1155, DD 2952;
- OPM 1644;
- 164g.11's t3-t26 and 164g.9's q1-q15.

**Builder cases** (`test/xfapage.test.ts`), for what the probes leave open:
- a row taller than an empty region takes the p. 295 rule;
- an `lr-tb` item that is a splittable subform, straddling, is refused;
- `<overflow>` on a split `lr-tb` or table that continues is refused;
- `keep intact="contentArea"` on an `lr-tb` or table places it whole;
- no fragment holds only margins.

**Mutations, each expected to redden:**

| Mutation | Probe |
|---|---|
| per-line cuts instead of per-item | t37 |
| column widths per fragment | t30 |
| 164g.8's top/bottom-only margins | t35, t36, t39 |
| a later item returns to an earlier region | t37 `b3` |
| no font-size straddle test | t27 refused against t35 moved |
| splitting a container that states `h` | t33, t34 |
| no recursion into a chained `lr-tb` or table | t31, t32 |

The plan records which are held by builder cases alone.

## Documentation

- CHANGELOG **Added**: `ConvertXfaToAcroForm` splits an `lr-tb` between its
  items and a table between its rows, as Adobe Reader does.
- CHANGELOG **Fixed**: a split `tb` with margins placed its continued content
  too high and did not reserve its bottom margin on the first page.
- CLAUDE.md: the `xfapage.ts` invariants (one rule, fit by measuring, both
  margins on every fragment) and the `fixtures/xfa-adobe/` row.
- `test/fixtures/xfa-adobe/PROVENANCE.md`: a section for t27-t39.

## Child issues filed at close

- An `lr-tb` item that is itself a splittable subform straddling the cut
  (split consensus across a line).
- Table header rows repeated through `overflowLeader`, unless 164g.15 already
  covers them.
