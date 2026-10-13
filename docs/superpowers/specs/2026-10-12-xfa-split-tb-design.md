# XFA content splitting: a `tb` subform split between its children (`164g.8`)

164g.3 places every child of the root subform WHOLE. A child too tall for an
empty content area is refused ("would need splitting (164g.8)") unless the p. 295
override applies. DoD DD 1494 is refused that way: one page-level subform,
`TopForm`, holds the whole body, and pdf.js lays it across 14 pages. This design
splits a `tb` subform between its children, which is exactly what DD 1494 needs.
The rest of XFA's splitting rules become child issues (below).

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | What does 164g.8 cover? | **This slice only**: a `tb` subform splits between its children. 164g.8 closes with it, and each remaining rule becomes a child issue under 164g, each saying that no oracle exists for it yet. The requester's decision. |
| 2 | Where does a splittable container split: at the room left, or after moving whole to a fresh page? | **At the room left.** XFA 3.3 p. 290 ("Content Overflow"): the processor "may split the object, putting the top of it into the current region and the rest into the next available region". DD 1494 cannot tell the two apart (see Evidence), so the specification decides. |
| 3 | DD 1494 uses `breakBefore` and `<overflow>` INSIDE the subform being split (found during implementation; the spike missed them). Refuse them, as first designed, or widen? | **Widen** (the requester's decision). A `breakBefore` on a child in a split chain is applied with the root children's rules. An `<overflow>` is refused only when its container actually continues into another region, which is when a leader or trailer would be inserted. `breakAfter` in a chain stays refused (164g.16). Added after the design was approved, as an amendment. |

## Sources

XFA Specification 3.3, pinned by 164g.1 (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`,
re-fetched for this design from the Internet Archive capture of 2016-03-29 and
re-verified), printed page numbers:

- **Content Overflow** (p. 290). An object too tall for the room left may be
  placed anyway, deferred to the next region, or split, "putting the top of it
  into the current region and the rest into the next". Splitting can reach any
  object whose ancestor flows.
- **Split Restrictions** (p. 291-292). "Splitting is always forbidden within top
  and bottom margins." `keep intact` is `none` (split anywhere it can),
  `contentArea` (never split) or `pageArea` (may split, but not across pages).
  The DEFAULT for a subform is `contentArea` when it is a table row or when its
  container's layout is positioned, and `none` otherwise. A draw is always
  `contentArea`. A field is `none`, but a widget's appearance never splits and
  text splits only between lines.
- **Split consensus** (p. 293-294). A container splits at the lowest location
  every contained object accepts. When that location reaches the top, the
  object cannot split.
- **Borders** (p. 294): a border's `break` decides how a fragment's border is
  drawn. Borders have no effect on layout, so nothing here reads them.
- **Overriding ContentArea Boundaries** (p. 295): when the region is empty and
  the object fits neither it nor the next region, "even by splitting", it is
  forced onto the page. 164g.3 implements this, and this design keeps it.

## Evidence: DoD DD 1494, laid out by pdf.js

pdf.js 6.3.289 (the generator 164g.6 pinned) lays DD 1494 out on 14 pages.

**Correction (amendment).** The spike reported that the template has no
`<keep>`, `<break*>` or `<overflow>`. That was false: its scan matched only
tags on one line, and DD 1494 wraps its tags. The template holds:

- `<overflow leader="headingN">` on every `Pn.front`. In pdf.js's layout it never
  fires, because no `front` splits.
- `<breakBefore targetType="pageArea" target="Page1">` on the `front` of P2-P6,
  and `<breakBefore targetType="pageArea" startNew="1">` on P5's and P6's
  `lineDiagramPg`. The second is why `lineDiagramPg` starts a new page.
- 33 `<keep>`: 32 `intact="none"` (the default) and one `contentArea`, on a
  hidden `lr-tb`.
- 29 `<occur>`, which 164g.2 already instantiates.

So DD 1494 exercises breaks inside a split chain as well as the split itself, and
the page-area goldens record which page area pdf.js used for every page.

- Only `tb` subforms fragment: `form1`, `TopForm`, and `P1`…`P6`. Every node below
  them lands whole on one page. The innermost children, `front`,
  `lineDiagramPg` (P5 and P6) and `back`, each take a page: P1-P4 two pages
  each, P5 and P6 three each.
- Our engine already measures those 14 children within 0.01pt of pdf.js, except
  `P1.front` at 719.50 against 719.94. Laid out alone on its page, every one of
  the 297 fields on those pages matches pdf.js's box within 0.05pt. So the
  0.44pt is slack below `P1.front`'s last field and moves nothing.
- Decision #2 has no witness. P5's `front` leaves 20.9pt on page 9, but
  `lineDiagramPg` starts a new page because of its own `startNew` break, and
  its first child is 679.5pt tall anyway.
- pdf.js is a reimplementation: evidence, not Adobe conformance.

## Design

### 1. Which containers split

In this slice a node is **splittable** when all of the following hold:

- it is a `subform`;
- its layout is `tb`;
- it states no `h` (a stated height is a fixed extent, and splitting one has no
  oracle);
- it states no `<keep intact>` other than `none`;
- its parent's layout is `tb` or `lr-tb`. A positioned parent defaults it to
  `contentArea` (p. 292), and every node in a split chain has a `tb` parent
  anyway.

Splittable means: it may split BETWEEN its children, and a child that is itself
splittable may split in turn. Every other node is placed WHOLE. That is right by
the specification for a draw, a widget, a subform kept `contentArea`, and a
subform under a positioned parent. For a positioned subform, an `lr-tb`, a table
or multi-line text it is a narrowing (see child issues), and it is 164g.3's
existing behaviour for every root child.

`<keep intact="contentArea">` is read and honoured: that subform is never split.
`<keep intact="pageArea">` is refused with the reason naming its child issue.
`<keep>`'s `next`/`previous` adhesion is the same: a subform reached in a split
chain that states either is refused, naming its child issue.

### 2. Atoms (`xfapage.ts`)

A root child that is splittable is flattened, recursively, into a sequence of
atoms:

- `open(c)`: its top margin;
- its children in order, each either a whole atom or, when splittable, its own
  flattened sequence;
- `close(c)`: its bottom margin.

Each whole child's height comes from `measureExtent(child, limit, measure, [],
'tb')`, its parent being a `tb` (bkdi). The sum of a container's atoms equals
its own extent, since a container in a `tb` parent is its content plus its
margins.

### 3. Filling content areas

The existing greedy loop places atoms instead of root children:

- An atom that fits the room left is placed.
- No break may fall between an `open` and the atom after it, or between an atom
  and the `close` after it: a margin never splits (p. 291). An `open` therefore
  travels with the first child after it, and a `close` with the last child before
  it.
- A fragment holds at least one child. If nothing but margins would fit, the
  break moves back to before the container's `open`.
- When the next atom does not fit and the region already holds content, layout
  advances to the next region, and the atom is tried again there.
- When an atom does not fit an EMPTY region, the p. 295 override and the
  splitting refusal apply to THAT atom, exactly as 164g.3 applies them to a root
  child. They already handle a whole child that is too tall.

A root child that fits is never flattened. That keeps every existing oracle
where it is: fw9, I-130, I-765, OPM 1644, and bkdi's DD 1391, DD 1155 and DD 2875.
It also keeps the p. 295 override's cases untouched: a child placed past the
boundary because its ink fits has nothing left over to split.

### 4. Fragments

Each content area receives the atoms placed in it, regrouped as shallow copies
of their containers. A copy keeps the container's own properties and holds only
the children placed in that region. The first copy keeps the top margin and the
last keeps the bottom margin; an intermediate copy has neither. Fields and draws
are shared nodes, so each lands in exactly one fragment and its SOM name does not
change. `xfaflow.ts` lays the fragments out as it lays out any `tb`, unchanged.

### 5. Breaks and overflow in a split chain (amended, decision #3)

- A `breakBefore` on a child reached by splitting is applied, with
  `Paginator.apply` and the same rules as a root child's (164g.3), before that
  child's unit is placed. On a flattened child it rides on its `open` atom.
- A splittable root child is flattened when it does not fit, AND when its chain
  holds a `breakBefore`, even if it would fit whole: a break must take effect
  wherever it sits.
- An `<overflow>` on a container is refused only when that container is about
  to continue into a second region, the point where XFA would insert its leader
  or trailer (164g.15). A container that stays in one region needs neither.

Still refused, the failing leaf and every later one, naming the child issue that
owns them:

- a `breakAfter` on a child in a split chain (164g.16; DD 1494 has none);
- `<keep intact="pageArea">`, or adhesion (`next`/`previous`) (164g.14).

### 6. Template reading (`xfatemplate.ts`)

`LayoutNode` gains `keep?: { intact?: string; next?: string; previous?: string }`
and `overflow?: boolean`, read from a subform's DIRECT `<keep>` and `<overflow>`
children. Nothing outside pagination reads them.

## The oracle

- `scripts/gen-xfa-goldens.ts` keeps DD 1494's body nodes as a new `body` list
  beside each master file's page-area `nodes`. d3mq's test reads `nodes` and does
  not move.
- The generator's two registry requests move from `fetch` to `node:https` with a
  60-second timeout. On this network `fetch`'s 10-second connect timeout fails
  where curl succeeds in 15 seconds. The pinned integrity check is unchanged.
- A new test converts DD 1494 end to end (`ConvertXfaToAcroForm`). It asserts:
  14 pages created; no "splitting (164g.8)" refusal; and every body field pdf.js
  placed lands on pdf.js's page and box within 0.05pt (Chrome's 1/64px, as
  164g.6 and d3mq use).

## Testing

`test/xfapage.test.ts` builder cases, each over hand-built `LayoutNode`s:

- a `tb` root child taller than the region splits between its children, and the
  first fragment fills the room left on a page that already holds content (#2);
- nested splitting: a splittable child splits in turn;
- the top margin stays with the first child and the bottom with the last; a
  container whose only fitting atom is its `open` moves whole;
- a positioned child, a draw, and a subform stating `h` or
  `<keep intact="contentArea">` are placed whole;
- a whole atom too tall for an empty region still takes the p. 295 override when
  its ink fits, and is refused otherwise;
- each of the three refusals in §5.

Mutations, each expected to redden: split at a fresh page instead of the room
left; drop the margin binding; allow a margin-only fragment; split a subform that
states `h`; ignore `<keep intact="contentArea">`; drop the recursion into a
splittable child. The DD 1494 oracle should catch the recursion mutation. The
others are held by builder cases; the plan confirms which.

## Child issues filed at close

Each states that no oracle exists for it yet:

- splitting a positioned subform by split consensus (p. 293-294);
- splitting an `lr-tb` between lines and a table between rows;
- splitting text between lines, with orphan and widow control (p. 291);
- `keep intact="pageArea"` and adhesion (p. 311);
- overflow leaders and trailers actually inserted (p. 318);
- a `breakAfter` inside a split chain.

## Documentation

- CHANGELOG **Added**: `ConvertXfaToAcroForm` splits a `tb` subform between its
  children across pages; DD 1494 converts onto pdf.js's 14 pages.
- CLAUDE.md: the `xfapage.ts` entry (atoms, the margin rule, the slice and its
  narrowing), and the 164g.3 note that refuses "needs splitting".
- `test/fixtures/xfa-dynamic/PROVENANCE.md`: DD 1494's body is now compared.
