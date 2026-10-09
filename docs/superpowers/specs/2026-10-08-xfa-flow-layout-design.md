# XFA fixed-size flow layout (164g.1)

## Goal

`ConvertXfaToAcroForm` places a field only when every container between it and
its page origin is `layout="position"`. A field under a flowed container
(`tb`, `lr-tb`, `table`, `row`) is converted as a geometry-less dict that
nothing draws. This work lays out flowed containers whose sizes the template
**states**, so those fields get real widgets.

Success:

- The 40 flowed fields of IRS f1040 (`test/helpers/xfa-flow-oracle.ts`,
  `164g.5`) reproduce Adobe's rects exactly, to 0.01pt. With the 159 already
  placed, every one of f1040's 199 fields has a widget.
- The existing 159-rect equality in `test/xfa-real.test.ts` does not move. It
  is the fence for unifying positioned and flowed layout into one engine.

## Scope

In: `position`, `tb`, `lr-tb`, `table` and `row`. Sizes come from the template
alone: a leaf's `w`/`h`, a table's `columnWidths`, and the extent a container
takes from its children.

Out, each refused by name and tracked elsewhere:

| Shape | Why | Tracked |
|---|---|---|
| A field or draw whose own `w` or `h` is absent, or that carries `minW`/`minH`/`maxW`/`maxH`, where it is not sized by a table | its size comes from text measurement | 164g.7 |
| `<occur>` with `max` other than 1 | repetition | 164g.2 |
| Content that overflows its `contentArea`, or a fixed-size flowed container | splitting and page breaking | 164g.3 |
| `rl-tb`, `rl-row`, and any unknown layout | not transcribed; an allowlist | — |

## Sources

Every layout rule is transcribed from the **XFA Specification 3.3**
(`xfa_spec_3_3.pdf`, Adobe, retrieved from the Internet Archive copy of
`partners.adobe.com/public/developer/en/xml/xfa_spec_3_3.pdf`, SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`). The spec is not vendored; it is cited by chapter and page,
and each rule in code carries its citation. Where the spec does not settle a
shape, that shape refuses.

- **Flowing layout** (ch. 8, "Flowing Layout for Containers", p. 279–280): a
  flowed child's `x`, `y` and anchor point are **ignored**; children are placed
  "sequentially in abutting positions".
- **tb** (p. 280): first child at the container's top-left; each next one
  "immediately below the nominal extent of the previous contained object and
  aligned with the left edge of the container".
- **lr-tb** (p. 281): each next child "immediately to the right of the nominal
  extent of the previous object, or if this fails immediately below it aligned
  with the left edge of the container".
- **Tables** (p. 327–331): cells are laid out left to right at their natural
  sizes; each row's cells are expanded vertically to the tallest cell; rows are
  stacked top to bottom; each column's cells are expanded horizontally to the
  designated width, or to the widest cell when the width is `-1` or absent.
  `colSpan` is a positive count or `-1` (all remaining columns, later cells not
  displayed); it defaults to 1 and must not be 0. A short row leaves an empty
  region on its right.
- **Growable containers** (p. 275–277): a container with no `h` (or `w`) is
  growable on that axis and its dimension is computed "inside-out": a content
  region from its contents, then its margins applied. With both `w` and `h`
  stated, `min*`/`max*` are ignored.
- **presence** (ch. 2, p. 67–68): `hidden` and `inactive` are absent from
  layout; `invisible` takes up space. An outer container's restriction is
  inherited by everything inside it.
- **hAlign** (p. 282): "it takes the default value which is left for
  Left-To-Right layout". The non-default cases are shown only as examples
  without a stated rule, so a flowed child that states any other `hAlign`
  refuses.

One conflict with a secondary source is recorded: Adobe's Designer scripting
reference says `row` cells are "laid out from right to left". The XFA spec
(p. 327) and the f1040 oracle both say left to right (`rl-row` is the
right-to-left form), and they win.

## Architecture

```
xfatemplate.ts ──► layout tree per page (LayoutNode)
                         │
xfaflow.ts (pure) ───────┘──► placed box or reason, per node
                         │
xfageom.ts (pure) ──► editRegion: caption, margin, button  (unchanged rules)
                         │
xfaconvert.ts ──► rect via rectFromBox, then the existing apply path
```

### `xfatemplate.ts`: the layout tree

The walk already visits every container. It additionally builds, per page, a
tree of `LayoutNode`s and keeps it on `XfaTemplate.layout`:

```ts
interface LayoutNode {
  kind: 'subform' | 'exclGroup' | 'area' | 'field' | 'draw' | 'page';
  /** Containers only; 'position' when absent. 'occur' as today for a
   *  repeating subform. */
  layout?: string;
  geom: XfaRawGeom;                 // x y w h anchorType rotate, verbatim
  minMax?: { minW?: string; minH?: string; maxW?: string; maxH?: string };
  colSpan?: string;
  hAlign?: string;                  // the node's own attribute, not <para>'s
  presence?: string;
  /** The node's own <margin>. For a container it insets its content; for a
   *  field it is the edit-region inset xfageom already applies. */
  margin?: XfaMargin;
  columnWidths?: string;            // table only
  /** The field's SOM name; fields only. */
  field?: string;
  children: LayoutNode[];
}
```

- **Draws join the tree** (today they are discarded), because a draw takes up
  space in a flow exactly as a field does. They never produce a field.
- The page root is a synthetic `page` node: positioned, sized to the page's
  `contentArea` (its `w`/`h`, else unknown), offset by the contentArea's
  `x`/`y`. Its single child is the page subform.
- `XfaField.layouts` stays: it feeds the report and the flow oracle.
  `XfaField.offsets` and `geom` stop driving geometry and are removed once
  `xfaconvert.ts` no longer reads them.

### `xfaflow.ts`: the engine (new)

A pure leaf over `xfageom.ts` (for `measureToPt`, `anchorShift`). No
`Document`, no PDF object, no `node:` import, never throws.

```ts
type Placed = { box: XfaBox } | { reason: string };
function layoutPage(root: LayoutNode): Map<string /*field SOM*/, Placed>;
```

It runs two passes over the tree.

**Pass 1, size (bottom-up).** Each node gets a nominal size `{w, h}` or a
reason.

- **Leaf** (field, draw): `w` and `h` as stated. If either is absent, or
  `minW`/`minH`/`maxW`/`maxH` is present while that axis is unstated, the leaf
  is unsized. An unsized leaf is still allowed as a **table cell**, where the
  column supplies the width. Its height must still be stated.
- **Container with both `w` and `h`**: as stated; `min*`/`max*` ignored
  (p. 276).
- **Growable container** (an axis unstated): content extent per its layout,
  plus its own margin insets on that axis, then raised to `min*` if stated. If
  the content exceeds a stated `max*`, it refuses: clipping is not modelled.
  - `position`: the extent of `max(child x + w)` and `max(child y + h)`, each
    child's corner after its anchor shift. A child at a negative coordinate
    refuses.
  - `tb`: width is the widest child, height the sum.
  - `lr-tb` with no stated `w`: one line, so the width is the sum and the height
    the tallest child. With a stated `w`, the wrapped extent from pass 2's line
    breaking.
  - `table`: the aligned table's total width and height (below).
- `hidden`/`inactive` (own or inherited) contributes nothing and gets no box.
  A field so concealed still converts, bare, with the reason
  `presence="hidden" takes no space in the layout`. This applies under
  `position` too, where today such a field gets a widget. That is a behaviour
  change, but no field in either vendored form carries it: the hidden items
  there are draws, such as the draft stamps.

**Pass 2, place (top-down).** Each node gets its top-left in the page's XFA
frame, given its parent's content origin. A container's content origin is its
own corner plus its left and top margin insets.

- **position**: corner = origin + stated `x`/`y` + `anchorShift`. This is
  today's arithmetic, now applied to containers too: `accumulateOrigin`
  ignored a container's `anchorType`. Every container in f1040 is `topLeft`,
  and the 159-rect fence holds that.
- **tb**: `y` advances by each child's height; `x` = content left.
- **lr-tb**: `x` advances by each child's width; when the next child does not
  fit the content width (`x + w > width`), wrap to the content left, below the
  line. A child wider than the whole content width is placed at the start of a
  line by itself. Because the spec's "immediately below it" does not say what
  happens when a line's children differ in height, a wrap after a line of mixed
  heights refuses. A single line of mixed heights is fine: every child sits at
  the line's top.
- **table**: children must all be `row` subforms. An out-of-place child (p. 329)
  refuses, as does a `row` outside a table (p. 282, "inappropriate layout
  strategy"). Column widths come from `columnWidths`. A `-1` or missing entry is
  the widest natural cell width in that column, from cells spanning exactly that
  one column. A `-1` column whose only cells span several columns refuses.
  Each cell's box: x = start of its first column, width = sum of its spanned
  columns, height = the row height (tallest natural cell height in the row).
  `colSpan="-1"` spans the rest; later cells in that row get no box and are
  reported. `colSpan="0"` refuses.
- A cell's box **replaces** its natural size: its contents are laid out in the
  expanded box, so a positioned cell subform keeps its children at their stated
  offsets inside it.

**Failure propagation.** A failed node never yields a guessed position.

- In a flow (`tb`, `lr-tb`, `row`): a failed or unsized child fails itself and
  every later sibling, whose positions depend on it.
- In a table: a failed cell fails its row and every later row.
- In `position`: a failed child fails only itself.
- A container whose extent is needed (it is growable, or it sits in a flow)
  and depends on a failed child fails too, which then propagates to its own
  later siblings by the same rules.
- Each failed field gets one reason. The node that failed first is named in
  it, e.g. `an earlier item in its flow could not be laid out (Row3[0]: ...)`.

**Overflow.** A placed node extending past its fixed-size parent's content
region, in a flowed parent, refuses (splitting, 164g.3). The same holds for
anything past the page root's `contentArea`. A positioned child that overhangs
its parent is not refused: the spec permits it, and today's code places it.

### `xfageom.ts`

`boxFor`'s chain arithmetic (`accumulateOrigin`, the per-field `x`/`y`/`w`/`h`
read) moves into the engine. What stays is the edit-region step, exposed as
`editRegion(box, caption, margin)`: `applyCaption` then `applyMargin`,
unchanged. `buttonBox` is unchanged. `chainIsPositioned` stays for the oracle
helper. `XFA_FLOW_LAYOUTS` gains a note that `tb`, `lr-tb`, `row` and `table`
are now laid out.

### `xfaconvert.ts`

`buildXfaPlan` runs `layoutPage` once per page that passed the medium check.
`geometryFor` looks the field up:

- `{ reason }`: the field goes bare with that reason, as now.
- `{ box }`: `editRegion`, then `buttonBox` for a check button, then
  `rectFromBox`. This is exactly today's path from `boxFor` on.

The "an ancestor uses layout=…" refusal disappears; its successors are the
named refusals above. A `rotate` on a field still refuses.

## Testing

All fixtures are hand-built except the two vendored forms.

- **`test/xfaflow.test.ts`** (new), from hand-built `LayoutNode` trees. One case
  per rule:
  - `tb` stacking
  - `lr-tb`: one line, a wrap with equal heights, the refusal of a wrap after
    mixed heights, and an over-wide child alone on its line
  - `table`: stated columns, `-1` columns, `colSpan` n and `-1`, a short row,
    row-height expansion
  - growable extents for `position`, `tb` and `lr-tb`, with margins
  - `min*` raising an extent and `max*` refusing
  - presence: `hidden`, `inactive` and `invisible`, each inherited
  - container anchors
  - every refusal in the scope table, plus failure propagation in each layout
- **`test/xfatemplate.test.ts`**: the tree includes draws, `colSpan`,
  `columnWidths`, `presence`, the container margin and the page root.
- **`test/xfa-flow-oracle.test.ts`**: "is exactly the set the converter leaves
  without a widget" becomes "places all 40 exactly". Every oracle field must be
  converted with a rect within 0.01pt of Adobe's, and nothing in f1040 may stay
  bare.
- **`test/xfa-real.test.ts`**: the equality grows from 159 to 199 compared
  rects, still exact.
- **Mutation checks** (each must redden, recorded in CLAUDE.md):
  - the cell-height expansion
  - column widths from `columnWidths`
  - `colSpan` summing
  - the `tb` advance
  - the `lr-tb` wrap test
  - the mixed-height refusal
  - the container margin inset
  - growable extent from children
  - presence `hidden` taking no space
  - failure propagation to later siblings
  - the container anchor shift

  The oracle alone covers only cell expansion, column widths and the `lr-tb`
  advance, so the rest rest on the hand-built cases. That is stated in
  PROVENANCE.

## Documentation

- **CHANGELOG `Added`**: flowed XFA subforms with stated sizes are laid out.
- **README Limitations** (the XFA bullet) is rewritten: what flows now, and what
  still refuses.
- **CLAUDE.md**: an `xfaflow.ts` entry with the invariants above, and the
  `xfatemplate.ts`/`xfageom.ts` notes updated.
- **PROVENANCE.md** (`test/fixtures/xfa/`): the oracle is now asserted for
  correctness, not just presence, along with what it cannot see (`tb`, the wrap,
  `colSpan`, `-1` columns).
