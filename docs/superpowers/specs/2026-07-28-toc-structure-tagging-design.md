# Tagging a generated TOC as `/TOC` + `/TOCI` — design

Issue: `aspose-pdf-foss-for-ts-1gg0.5` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-28. Deferred from `1gg0.1`; see
`2026-07-27-toc-page-generation-design.md`, whose "Out of scope" section filed it.

## Scope

`page.AddTOC` draws untagged content. This adds opt-in logical structure: one
`/TOC` element holding one `/TOCI` per entry, each pointing at its target through
a `/Reference` → `/Link` → `OBJR` chain, with the dot leader marked as an
artifact and `entry.level` mapped onto nested `/TOC` elements.

No new rendering primitives and no change to the drawn bytes: the same stamps in
the same places, wrapped in marked content. `tagged: false` (the default) must
leave output byte-identical to today.

Out of scope, deliberately:

- Retro-tagging a TOC drawn by an earlier untagged call. `Sect.MarkContent` is
  the escape hatch for that and already exists.
- Deriving structure from the *target* pages (linking a TOCI to the `/H1` it
  refers to). `/Reference` cites a location, not an element.
- A `/Lbl` for entry numbering ("1.2 Introduction"). `entry.title` is one string;
  splitting it is the caller's business.

## API

```ts
// toc.ts
export interface TOCOptions extends Omit<TextBlockOptions, 'align' | 'valign' | 'tag'> {
  // … existing options unchanged …

  /** Emit /TOC + /TOCI logical structure into the document structure tree.
   *  Default false, in which case output is byte-identical to an untagged call. */
  tagged?: boolean;

  /** Element to append the /TOC under. Default: the structure tree root
   *  (bootstrapped with doc.CreateStructTree()). When this element is itself a
   *  /TOC it is *reused* rather than nested, which is how a manual-pagination
   *  loop keeps one TOC across pages. Requires `tagged: true`. */
  structParent?: StructElement;
}

// tocrender.ts
export interface AddTOCResult {
  // … existing fields unchanged …

  /** The /TOC element, when tagged; undefined otherwise (including a tagged
   *  call that drew nothing). Pass it back as `structParent` on the
   *  continuation call. */
  struct?: StructElement;
}
```

`tagged` mirrors `FlowOptions.tagged`, the closest precedent in the codebase.
`structParent` is the escape hatch flow.ts does not need, because a flow owns its
whole document while a TOC is a box on someone else's page and usually belongs
inside an existing `/Sect` or `/Part`.

### Continuation across a manual page break

```ts
let r = page.AddTOC(entries, rect, { tagged: true });
while (r.remainder?.length)
  r = doc.AddPage().page.AddTOC(r.remainder, rect, { tagged: true, structParent: r.struct });
```

The `/TOC`-reuse rule exists for exactly this loop. Without it each continuation
call would append a sibling `/TOC`, and a three-page TOC would read as three
tables of contents.

**Limitation as shipped, lifted by 1gg0.16:** the level stack (below) was per
call, so a continuation whose first row is `level: 2` started from the reused
`/TOC` with an empty stack and attached that row at depth 1 instead of reopening
the previous page's nested `/TOC`. That was written up as needing the stack
serialized into `AddTOCResult`; it does not, because the stack is *recoverable
from the tree*. A nested `/TOC` is only ever created under the **last** `/TOCI`
of its parent, so descending that spine from the reused `/TOC` — last `/TOCI`,
its nested `/TOC`, repeat — replays exactly the stack and the per-depth
`lastTOCI` the previous call ended with. `TocTagger.resumeDepth` does that walk
in the constructor, and the public surface is unchanged.

The walk stops on a `/TOC` with no indirect ref (`beginRow` may only push
elements it can `Append` to) and on a ref it has already visited: `structParent`
need only be a `/TOC` inside this document's tree, so a reused one can come from
an opened file whose `/K` is cyclic, and an unguarded descent would not
terminate.

## Structure emitted

```
[structParent | StructTreeRoot]
  TOC
    TOCI
      Reference
        Link                      <- omitted when links:false (content moves up to Reference)
          <MCID per wrapped title line>
          <MCID for the page label>
          OBJR -> the /Link annotation
      TOC                         <- only when a deeper row follows
        TOCI
          …
```

Why this shape:

- `/Reference` is the standard element for a TOC entry's citation
  (PDF 32000-1 §14.8.4.3.4: `TOCI ::= Lbl? Reference? NonStruct? P? TOC?`).
- `/Link` wraps the annotation because ISO 14289-1 §7.18.5 requires a link
  annotation to be nested in a `/Link` structure element, and because the element
  should span exactly what the clickable rect covers — which, per the
  `1gg0.1` design, is the title *and* the page number.
- Every wrapped line of a title is a separate MCID under the same `/Link`
  element; a wrapped row is one entry, not several.
- An empty title draws no line, so its `/Link` holds just the label MCID and the
  OBJR. That row still exists visually (the one-line-minimum rule) and still
  exists structurally.

The dot leader is wrapped `/Artifact BMC … EMC` and belongs to no element. In a
tagged page every piece of real content must be tagged or marked as an artifact;
leaving a run of dots bare is a PDF/UA failure, and tagging it as text makes a
screen reader say "dot dot dot dot dot".

### Level nesting

The tagger keeps a stack of open `/TOC` elements — `stack[0]` is the root one, so
`stack.length` is the currently open depth — plus the last `/TOCI` created at each
depth. For an entry at `level = L`, the target depth is

```
maxDepth = stack.length + (a /TOCI exists at depth stack.length ? 1 : 0)
d        = min(L, maxDepth)
```

- A row may descend **at most one level per row**, and only when the current
  depth already has a `/TOCI` to hang the child `/TOC` from. So `1 → 3` clamps to
  depth 2, and a TOC whose *first* row is level 3 clamps to depth 1 — neither
  invents empty intermediate TOCIs.
- `d === stack.length + 1`: append a child `/TOC` to the last `/TOCI` at depth
  `d - 1` and push it.
- `d <= stack.length`: pop back to depth `d`.

On a reused `/TOC` the stack is not empty at the first row: the constructor
rebuilds it from the tree (above), so the clamp is computed against the depth the
previous call left open and a continuation can descend one level below it, exactly
as the next row of a single call could.

The visual indent is unchanged and still driven by `(level - 1) * indent`, so a
clamped row indents deeper than it nests. That is the honest rendering of ragged
input: the drawing does what the caller asked, the structure says what can be
justified.

## Modules

- **`src/tocstruct.ts`** *(new)* — `TocTagger`: the `/TOC` bootstrap, the level
  stack, and the per-row subtree. Two methods, `beginRow(level)` returning the
  element that row's content is tagged into, and `finishRow(annotation)`. It is
  its own module for the reason `tablerender.ts` is separate from
  `tableauthor.ts`: `tocrender.ts` is about where ink goes, and threading a
  structure stack through `paintRow` would blur that.
- **`src/pagecontent.ts`** — `wrapArtifact(body)`, the no-MCID sibling of
  `wrapMarkedContent` (`/Artifact BMC … EMC`). Reusable by any later authoring
  code that needs to disclaim decoration.
- **`src/stamp.ts`** — `artifact?: boolean` on `StampOptions` (`@internal`),
  routed through the same wrap point as the existing `tag`. Passing both throws:
  content is either someone's or no one's.
- **`src/toc.ts`** — the two new options and their validation (below).
- **`src/tocrender.ts`** — construct the tagger lazily on the first *painted*
  row; pass `tag` into `rowStampOptions` for the title and label stamps,
  `artifact: true` for the leader stamp; call `element.AddAnnotation(link)` with
  the `LinkAnnotation` that `addLink` already returns.
- **`src/index.ts`** — no new exports; `StructElement` and `AddTOCResult` are
  already public.

## Validation and atomicity

`1gg0.1`'s invariant holds unchanged: everything is validated by `measureTOC`
before anything is drawn, so a throwing call leaves the document byte-identical.
The new checks live there too, and all throw `TypeError`:

- `tagged` is a boolean.
- `structParent` without `tagged: true` — explicit rejection rather than
  implying `tagged`, so an unused option never silently changes output.
- `structParent` with no `Ref` (`StructElement.Ref === undefined`) — it cannot
  be a parent, and `createElement` would fail later, mid-paint.
- `structParent.Root.Dict` is not this document's `/StructTreeRoot` — an element
  from another document, which would otherwise wire a cross-document ref.

Allocation is lazy in a second sense: the tagger is built on the first painted
row, not at the top of `drawTOC`. A tagged call with empty `entries`, or one
whose first row does not fit, bootstraps no structure tree and leaves the
document untouched. `struct` is `undefined` in that case, and the continuation
idiom above degenerates correctly (the next call bootstraps).

Auto-pagination needs no new code: `appendContentKid` already switches from a
bare MCID to an `MCR` dict once a second page contributes, and `pageMcidArray`
gives each page its own `/StructParents` key.

## Tests

`test/tocstruct.test.ts`, fixtures from the existing `test/helpers/` builders.

- **Default is inert**: an untagged call adds no `/StructTreeRoot` and no
  `/MarkInfo`, and its page content stream contains no `BDC`/`BMC` operator —
  the drawn bytes are the same stamps as before.
- **Shape**: N entries give one `/TOC` with N `/TOCI`; each is
  `TOCI > Reference > Link`; the `/Link` element's `/K` holds the title MCIDs,
  the label MCID and one `OBJR` pointing at the row's annotation.
- **Text round-trip**: the `/Link` element's collected text equals
  `title + label` — this is what proves the MCIDs are wired to the right marked
  content, not merely present.
- **Leader is an artifact**: `GetTextFragments` reports the dot run with
  `artifact: true`, and it contributes to no element's text.
- **Levels**: `1,2,2,1` nests one child `/TOC` under the first `/TOCI` and
  returns to the root for the last row; `1,3` clamps the second row to depth 2
  while its *indent* stays at level 3.
- **`links: false`**: no `/Link` element, content directly under `/Reference`,
  no `/Annots` on the page.
- **`structParent`**: the `/TOC` lands under a caller-made `/Sect`; passing a
  `/TOC` reuses it, so the manual-pagination loop above yields exactly one `/TOC`
  with all entries.
- **Resumed depth** (1gg0.16): a continuation whose first row is `level: 2` joins
  the nested `/TOC` the previous call left open rather than adding a depth-1
  sibling; a deeper spine is recovered whole; a continuation may descend one level
  below where the previous call ended (which is what proves the per-depth
  `lastTOCI` is recovered, not just the stack); a shallow first row still pops
  back; a non-`/TOC` `structParent` still starts fresh; and a hand-forged cyclic
  `/K` terminates instead of descending forever.
- **Rejections**: `structParent` without `tagged`, a refless element, and an
  element from another document each throw `TypeError` and leave `doc.Save()`
  byte-identical to a pre-call save.
- **Empty**: `tagged: true` with `entries: []` returns `struct: undefined` and
  adds no `/StructTreeRoot`.
- **Auto-pagination**: a tagged `autoPaginate` TOC spanning two pages emits
  `MCR` dicts for the second page's rows and a distinct `/StructParents` on each
  page.
- **Validator**: `ValidatePdfUa` on a tagged-TOC document reports no
  `StandardType` issue (every type used — `TOC`, `TOCI`, `Reference`, `Link` —
  is standard).

Mutation check, per the repo's fixture rule: the text round-trip and artifact
assertions must be shown load-bearing by breaking the MCID wiring and the
artifact wrap and confirming the suite goes red.

`README.md` gains the `tagged` option under `AddTOC`. `npm run typecheck` and
`npm test` must be green before the issue closes.
