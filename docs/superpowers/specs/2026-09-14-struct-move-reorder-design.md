# Moving and reordering structure elements (`q7hc.3`)

## The gap this closes

Reading order **is** the structure tree's order. `q7hc.1` made an element's type
writable and `q7hc.2` made it removable; there is still no way to put a
correctly-typed element in the right place.

That is the repair `AutoTag`'s geometric heuristic most often needs. It ranks
headings per block and walks the page in geometric order, so a multi-column
page with a full-width banner comes out with the banner interleaved between the
columns — every element correctly typed, in the wrong sequence. Retyping does
not help; only moving does.

## Three corrections to the issue's premise, all measured

**1. The acceptance criterion names an API that provably cannot move.** It asks
that moving a heading "changes `GetStructuredText`'s order".
`extractStructured` (`text.ts`) sorts text fragments by baseline and then by x
and never touches the structure tree — swept, zero references to it in the
function. Measured, swapping two kids in one element's `/K`:

```
GetText            before "AAA\nbbb"        after "bbb\nAAA"
ToMarkdown         before "# AAA\n\nbbb\n"  after "bbb\n\n# AAA\n"
GetStructuredText  before AAA|bbb|Original  after AAA|bbb|Original
```

What a move changes is `GetText`, `StructElement.Nodes`, and everything built
over `docmodel.ts`'s tagged path — `ToHtml('semantic')`, `ToMarkdown`,
`ToDocx`, `ToEpub`. The issue's own prose says exactly that; only its criterion
is wrong, and it is restated under **Acceptance** below.

**2. "The element keeps its content items and its `/Pg`" is CONDITIONAL, and
where it fails the corruption is silent.** `StructElement.Page` walks UP the
ancestor chain for `/Pg`, and `ContentItems` resolves a bare-integer MCID
against that inherited page. So moving an element that has no `/Pg` of its own
to a parent on a different page silently re-points every one of its MCIDs —
while the `/ParentTree` goes on mapping them to the element. The two directions
then disagree, which is worse than either being wrong alone.

Measured: `appendContentKid` writes `/Pg` onto the element the first time
content is added, so anything this library authored is already safe. The
exposed population is hand-built and third-party trees — precisely the
documents this epic exists to repair.

**3. `/K` interleaves element kids with content-item kids**, so "reorder the
children" has no single meaning for a `/P` that carries its own text beside a
`/Link` child — the everyday inline shape. The rule is stated below rather than
left to the implementation.

## Design

### API

```ts
/** Anything that can hold structure elements: an element, or the tree root. */
export type StructContainer = StructElement | StructTreeRoot;

element.MoveTo(parent: StructContainer, index?: number): void;
element.ReorderChildren(order: StructElement[]): void;
```

`index` counts ELEMENT children only — matching the reorder rule below — and
defaults to the end.

`ReorderChildren` takes the children IN THEIR NEW ORDER rather than an index
permutation. It is self-documenting at the call site, where `[2, 0, 1]` reads
equally well forwards and backwards, and it validates naturally: the argument
must be exactly this element's element-children, each exactly once.

**Invariant:** both return `void`. Unlike `SetType` and `Remove` there is no
partial outcome to report — every failure here is a refusal, and the `/Pg`
materialization below changes nothing a caller can observe. A result object
whose fields are always the same number is noise.

**Note the name:** `StructContainer`, deliberately NOT `StructParent`.
`/StructParent` is an unrelated key on an annotation dict, already modelled in
this codebase, and the collision would be read as a relationship that does not
exist.

### Where it lives

A new **`structmove.ts`**, importing `detachKid` from `structremove.ts` — one
owner for "take a kid out of `/K`", which must handle a `/K` that is a single
value as well as an array. `detachKid` becomes exported.

**Note what is NOT done and why:** unlike `numbertree.ts` in `q7hc.2`, nothing
is extracted to a leaf. The edge `structmove.ts` → `structremove.ts` is
one-way — `structremove.ts` does not and will not import back — so it closes no
cycle, and the extraction rule `resprune.ts` follows applies only where one
would.

### Validate everything, then move

`formcreate.ts`'s rule, scaled to one element: every check runs before any
mutation, so a rejected call leaves the document byte-identical. Four refusals,
all `RangeError`:

- the destination is the element ITSELF or one of its DESCENDANTS. This is the
  one that matters: it would make the tree unwalkable, and every consumer that
  recurses — `GetText`, `Nodes`, `docmodel.ts`, the validator — would hang or
  blow the stack rather than report anything;
- the destination belongs to a different structure tree;
- `index` is outside `0..n`, where `n` is the destination's element-child count;
- `ReorderChildren`'s argument is not exactly this element's element-children,
  each exactly once.

### The `/Pg` materialization, which is the whole safety property

Before detaching, walk the moved subtree and write `/Pg` onto every element
that has bare-integer content items and no `/Pg` of its own, resolved from
where it sits NOW. The move then provably cannot change any MCID's page.

**Invariant:** it runs UNCONDITIONALLY, never only when the two pages differ.
Deciding whether they differ means resolving the destination's inherited
`/Pg` — the same walk — so the conditional buys nothing and adds a branch that
is SILENT when wrong. For anything this library authored it is a no-op, since
`appendContentKid` already materialized `/Pg`.

### Reordering a mixed `/K`

**Invariant:** `ReorderChildren` permutes the ELEMENT kids among the positions
they already occupy. Every MCID and OBJR kid stays exactly where it is.

That is what makes the operation meaningful for the inline shape: a `/P`
holding its own text runs and a `/Link` child keeps its text where it was, and
only the elements move relative to one another. Permuting the whole `/K`
instead would let a caller reorder a parent's own text against its children —
a different feature, which would also break `Nodes`' interleaving, since that
reads content order from the page and would then disagree with `/K`.

### What a move must not touch

**Invariant:** the `/ParentTree` — not one entry. A move changes `/K` and `/P`
and nothing else. That is why this is so much smaller than `q7hc.2`, and it is
asserted directly rather than left implicit: "the `/ParentTree` still resolves
every MCID" is the issue's own criterion, and the cheapest way to get it wrong
is to reach for the release code that now sits in the neighbouring module.

## Testing

The `/Pg` case needs building and cannot be borrowed from any existing fixture:
a two-page document, an element with bare-integer MCIDs and NO `/Pg`, its
`/Pg` inherited from a parent, moved under a parent on the other page — then
assert `ContentItems`' page is unchanged. Nothing this library authors can
produce that shape, for the reason correction 2 gives, so it is hand-built.

Cases that each cover something no other does:

- **Order is visible through `GetText` and `ToMarkdown`, and NOT through
  `GetStructuredText`** — asserted BOTH ways, so correction 1 is recorded as a
  decision rather than as an omission somebody later "fixes".
- **A mixed `/K`**: content-item kids stay at their indices while the element
  kids permute around them.
- **The cycle refusal**, specifically moving a parent under its own child. A
  test that only checks `toThrow` is weak here; it must also assert the tree is
  unchanged afterwards, since the refusal's value is that nothing was written.
- **Each of the other three refusals**, and that the document is byte-identical
  after one.
- **`ElementFor` resolves every MCID afterwards**, and the document round-trips
  through `Save`.
- **Moving to and from the tree root**, which is the `StructContainer` union's
  only other arm.

## Acceptance

- Moving an element changes `GetText`, `StructElement.Nodes` and
  `ToMarkdown`/`ToHtml('semantic')` order; `GetStructuredText` is unchanged,
  because it is geometric.
- `ElementFor` still resolves every MCID in the moved subtree, and each
  resolves to the same page it did before.
- A move into the element's own subtree is refused and writes nothing.
- `ReorderChildren` leaves every content-item kid at its original index.
- `test/import-cycles.test.ts` still names the same set of 2-cycles.

## Out of scope

PDF/UA-2 is `q7hc.4`. Moving elements BETWEEN documents is refused rather than
implemented: the content items name pages and `/ParentTree` keys of the source
document, so it is a copy with remapping — `structpreserve.ts`'s problem, not
this one. Re-parenting content items without moving their element (splitting a
paragraph, say) is a separate feature nobody has asked for.
