# Removing a structure element, and the content it marked (`q7hc.2`)

## The gap this closes

`q7hc` exists because `AutoTag` is documented as "a starting point a human
refines" and there was no API with which to refine it. `q7hc.1` made a type
writable. There is still no way to **remove** an element: `StructElement`
exposes `Append`, `MarkContent`, `SetType` and the typed attribute writers, and
nothing detaches a node from the tree.

The repair this blocks is the everyday one after a wrong tag: `AutoTag`'s
geometric heuristic invents a `/Table` around a page of ruled callouts, or
marks a decorative rule as a `/Figure`. An author can retype it as of `q7hc.1`,
but cannot delete it.

## Three corrections to the issue's premise, all measured

**1. The validator is SILENT on orphaned marked content, so the acceptance
criterion is unreachable by object-graph surgery alone.** The issue asks that
"the validator reports untagged content rather than a dangling `/ParentTree`
slot". `UntaggedContent` tests `e.mcid === undefined`
(`structvalidate.ts:125-127`), and a detached element's `BDC` is still in the
content stream carrying its MCID — so the content still reads as *tagged*,
pointing at nothing. Probed end to end on a one-element tree:

```
before        []
after detach  []
```

Neither before nor after does any rule fire. Closing this needs both halves
below.

**2. `untagObjects` MUST NOT be reused, though the issue mandates it.** It ends
in `clearParentTreeKeys`, which splices whole `key → value` pairs out of
`/Nums`. That is right for an annotation's `/StructParent` — one key, one
annotation — and **catastrophic** for a page's `/StructParents` key, whose value
is the MCID array shared by EVERY element on that page: removing the pair
orphans all of them. It also assumes the referenced objects are dying, which is
why it never clears `/StructParent` from them; here the annotations SURVIVE, so
theirs must be deleted or it dangles. It is a precedent for the shape, not a
function to call.

**3. A `null` slot is the correct release, and it round-trips.** Measured: an
MCID index set to `null` survives `Save` (`rnums [0,[null]]`) and `ElementFor`
returns `undefined` for it. So the slot is nulled rather than the array
truncated — MCIDs are indices, and shortening the array would renumber every
later one.

## Design

### A new module, `structremove.ts`

`structwrite.ts` is 690 lines and is the *authoring* writer — it creates
elements, allocates MCIDs and wires the `/ParentTree` forward. Removal runs the
same bookkeeping backwards, in three phases, and adds the content unwrap.

**Invariant:** it imports `StructElement` as a TYPE only, as `structwrite.ts`
does, and takes `Document`/`Page` as arguments. Its value imports are
`text.js` (`visitContent`), `editcontent.js` (`EditableContent`) and
`types.js` — so `struct.ts` may call it and the edge closes no cycle.
`test/import-cycles.test.ts` is the fence.

### Three phases, and the order is load-bearing

**Collect.** Walk the element and its descendants, cycle-guarded by a `Set` of
visited dicts, gathering per element its `(page, mcid)` content items and the
annotation dicts its `OBJR` kids name. A `/K` that is a single value rather
than an array is normalized the way `kidsOf` already does.

**Release the `/ParentTree`.** Two different operations, because the tree holds
two different shapes:

- a content item's `(page /StructParents key, mcid)` sets that array's slot to
  `null`;
- an `OBJR` annotation's own `/StructParent` key has its `key → value` pair
  spliced out of `/Nums`, AND `/StructParent` is deleted from the annotation
  dict.

**Invariant:** those two must not be conflated. Splicing a page's pair is
correction 2 above; leaving a surviving annotation's `/StructParent` in place
leaves a key naming nothing.

**Unwrap the content.** For each `(page, mcid)`, locate the `BDC` through
`q7hc.1`'s `marked` event, then scan FORWARD in that op list tracking
`BMC`/`BDC` depth to find its matching `EMC`, and delete **exactly those two
ops** — keeping every op between them. That is literally what the issue asks
for: "the marked content stays in the page and becomes untagged". No ink is
deleted.

**Invariant, and it is the INVERSE of `q7hc.1`'s:** `retagContentItems` can
collect every address up front because a REPLACE moves nothing. A DELETE shifts
every later index in its op list, so deletions are applied DESCENDING by index
within each scope. Get it wrong and the second sequence in a stream loses the
wrong pair — which still produces a valid content stream, so only an op-level
assertion can see it.

**Detach.** Remove the element from its parent's `/K` — or from the ROOT's,
since `StructElement.Parent` returns `undefined` at the top level and that
branch is the one a test built on a nested element never reaches. The element
dict itself is not deleted: `Save`'s mark-sweep drops it once unreachable,
which is this library's model everywhere else.

### The validator widening

`UntaggedContent` treats an MCID that does not RESOLVE through the
`/ParentTree` as untagged, memoized per page so `ElementFor`'s number-tree
lookup is not repeated per glyph. A page with no `/StructParents` at all
resolves nothing, so all of its MCID-bearing content counts as untagged —
which is the true answer, those MCIDs naming no entry anywhere.

**Note, measured, and it is why this needs its own fixture:** the widening
reddens **NOTHING** — all 631 files and 19,165 tests stay green — because every
MCID this library authors resolves, and so does every one in the vendored
corpora. It is a real fix for a document we did not write, and the existing
suite provably cannot cover it. A hand-built dangling-MCID fixture is the only
thing that can.

### Shape and reporting

```ts
interface StructRemoveResult {
  elements: number;      // elements detached, including descendants
  mcids: number;         // /ParentTree slots released
  annotations: number;   // OBJR annotations unwired
  unreachable: number;   // BDCs the content walk could not address
}

Remove(): StructRemoveResult;
```

**Invariant:** it FAILS OPEN, as `SetType` does. The object graph is always
cleaned; a `BDC` the walk cannot address — inside a tiling pattern, a Type 3
`/CharProcs` or an annotation appearance, none of which `ContentAddr`'s
XObject-name chain can name (the `85l8.6` limit) — keeps its wrapper and is
counted. A document half-untagged is still better than a refused repair, and
the released `/ParentTree` slot already makes that content orphaned rather than
mis-attributed.

**Note the two halves converge, which is what makes failing open safe HERE in a
way it is not for `SetType`:** the release always happens, so an unwrapped
sequence has no MCID and an un-unwrapped one has an MCID resolving to `null`.
The widened rule reports BOTH as untagged. A caller who ignores `unreachable`
still gets a document whose validator tells the truth; what they lose is the
well-formedness of the stream, not the report.

**Invariant:** the parent is found through `/P`, falling back to the element's
`Root` when `/P` does not resolve to a structure element. `StructElement.Parent`
already reads it that way, so removal and navigation agree about who owns a
node.

**Invariant:** removing the same element twice is a no-op returning zeroes
rather than throwing. After the first call it is in no `/K`, and a second
attempt has nothing to find.

## Testing

The acceptance criterion "the page renders identically" is the one to get
right. **A rendering comparison cannot check it** — dropping the ink between
the `BDC` and the `EMC` would still render *something* and a pixel assertion
over a text fixture is weak. The test asserts the surviving OP LIST is
identical to the original minus exactly the two marking ops.

Cases that each cover something no other does:

- **Descending delete order:** two marked sequences in ONE content stream, both
  removed. With ascending deletion the second pair's indices have shifted and
  the wrong ops go. A single-sequence fixture cannot see it.
- **A nested subtree:** a parent whose child holds its own MCID, where the
  child's `BDC` sits INSIDE the parent's. Covers both the recursive collect and
  the nesting-depth `EMC` scan.
- **The root `/K` branch:** an element appended to the root, not to a parent
  element.
- **A surviving annotation:** its `OBJR` goes, its `/StructParent` is deleted,
  and the annotation is still in the page's `/Annots`.
- **The dangling-MCID fixture** for the widened rule — hand-built, since
  nothing we author can produce one.
- **`ElementFor` returns undefined** for every released MCID, and the document
  round-trips through `Save`.

## Acceptance

- The removed element's MCIDs no longer resolve through `ElementFor`.
- The page's op list is the original minus exactly the `BDC`/`EMC` pairs; every
  painting operator survives.
- `ValidatePdfUa` reports `UntaggedContent` for the page afterwards.
- A surviving annotation keeps its `/Annots` entry and loses `/StructParent`.
- Removing an element twice returns zeroes rather than throwing.
- `test/import-cycles.test.ts` still names the same set of 2-cycles.

## Out of scope

Moving and reordering are `q7hc.3`; PDF/UA-2 is `q7hc.4`. Re-marking the
now-untagged content under a different element is `MarkContent`, which already
exists. No `/IDTree` cleanup: this library never writes one (swept, zero hits
in `src/`), so a removed element's `/ID` can dangle in a third-party document —
recorded as a limit rather than guessed at.
