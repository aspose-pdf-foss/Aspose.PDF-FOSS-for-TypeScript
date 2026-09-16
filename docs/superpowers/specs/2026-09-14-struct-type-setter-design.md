# A writable structure type, validated against the RoleMap (`q7hc.1`)

## The gap this closes

`AutoTag` is documented as "a starting point a human refines", and `q7hc` exists
because there is no API with which to refine it. This issue names five text
properties and the structure type.

An element's **structure type** cannot be changed at all. `StructElement.Type`
is a getter over `/S` and nothing writes it after `createElement`, so an
`AutoTag` heuristic that called a heading a paragraph is uncorrectable through
the public API — and retyping is the commonest repair after supplying an
`/Alt`.

Separately, and not mentioned in the issue: **nothing validates a structure type
anywhere**. Measured — `root.Append('Nonsense')` is accepted today with no
check, allocates an object, and the document then reports

```
rules [ 'DocumentTitle', 'DisplayDocTitle', 'StandardType' ]
```

from `ValidatePdfUa`. That is exactly the "fails PDF/UA in a way the author
cannot see" the issue describes, arriving through the entry point the issue
does not name.

## Two corrections to the issue's premise, both measured

**1. Five of the six named properties already ship, and half the acceptance
criterion already passes.** The issue says `Alt`, `ActualText`, `Type` and
`Lang` "are READ-ONLY getters". `set Alt`, `set ActualText`, `set Lang`,
`set Title`, `set Expansion` and `set ID` have been on `StructElement` since
commit `7dd8750d` (2026-06-25) — nearly three months before the issue was
filed — and README documents them under *Tagged-PDF structure authoring*.

Probed directly against a `/Figure` with no alternate text, `ValidatePdfUa`
reports

```
BEFORE [ 'Figure element has no /Alt or /ActualText.' ]
AFTER  []
```

across a `fig.Alt = 'a picture'`. The criterion "setting /Alt on an auto-tagged
/Figure clears the corresponding IllustrationAlt finding" is satisfied by
shipped code. It earns a regression test here — it is the epic's headline claim
and nothing in the suite asserts it end to end — but no implementation.

So the issue narrows to: **the type setter, and the validation behind it.**

**2. A stale BDC tag is invisible to this library.** `markContentRegion` emits
`/<element.Type> <</MCID n>> BDC`, so retagging `/S` afterwards leaves that tag
name describing the old type. Nothing here notices: `text.ts` reads the
operand's `/MCID` (`mcidFromProps`) and only ever compares the *tag* against
`/Artifact`. The rewrite specified below therefore buys conformance with
32000-1 and interoperability with other readers, and **nothing our own stack
observes** — which is the whole reason its tests must assert emitted content
bytes rather than round-tripped structure.

## Design

### A leaf module, because the obvious placement closes a cycle

The validator needs `STANDARD_STRUCTURE_TYPES` and the RoleMap walk, both of
which live in `struct.ts`. But `struct.ts` imports `structwrite.ts` **by
value**, while `structwrite.ts` imports `StructElement` as a **type only** —
so reaching back for those constants from `createElement` would close the
codebase's first value-import 2-cycle between this pair, which
`test/import-cycles.test.ts` fences as a red build naming it.

New leaf **`structtype.ts`**, importing nothing:

```ts
export const STANDARD_STRUCTURE_TYPES: ReadonlySet<string>;
export function resolveRole(role: string, roleMap: ReadonlyMap<string, string>): string;
export function checkStructType(type: unknown, roleMap: ReadonlyMap<string, string>): string;
```

`struct.ts` re-exports the constant — and imports it locally beside that, since
`export … from` creates no local binding — so `index.ts:74` and every internal
import path are unchanged. `StructTreeRoot.ResolveRole` becomes a delegate to
`resolveRole`, keeping one owner for the RoleMap walk rather than two copies
that can disagree about a chain.

**Invariant:** it is a pure leaf. No `Document`, no PDF object, no `node:`
import — a set, a map and a string — which is what lets every rule here be
tested without building a PDF. The extraction `colornames.ts`, `preformat.ts`,
`bordersides.ts`, `datauri.ts` and `langmatch.ts` each already made.

### The rule, and the three places it fires

A type is valid iff `STANDARD_STRUCTURE_TYPES.has(resolveRole(type, roleMap))`
— which is `IsStandardType`'s question, asked *before* the write instead of
reported after it. `RegisterRole` is how a caller declares a deliberate custom
type, so the order is register-then-use.

It fires at **`StructTreeRoot.Append`**, **`StructElement.Append`** and the new
type setter. All three have a root handle in scope, so none needs a new
parameter.

**Invariant:** one rule, checked wherever a type is written. Two ways to set a
structure type with only one of them checked is the drift this repo keeps
recording — and `Append` is the entry point that produced the measured failure
above.

**Invariant:** `TypeError` for a non-string or empty type, `RangeError` for a
name the RoleMap does not resolve — `formcreate.ts`'s split between the wrong
*kind* of thing and a thing outside the allowed *set*.

**Invariant:** validation runs before `doc.allocObject`, so a rejected `Append`
leaves the document byte-identical. `createElement` allocates on its first
statement today and offers no such guarantee.

**Note this is a public behaviour change.** An external caller who appends an
unmapped custom type gets a `RangeError` where they previously got an element.
Measured across `src/` and `test/`: every `Append` in the repo uses a standard
type or a `RegisterRole`'d one, so nothing here moves. The `Subtitle` case in
`test/struct-write.test.ts` — `RegisterRole('Subtitle', 'P')` then
`Append('Subtitle')` — is the fence that a legitimate custom role still works,
and it must pass unedited.

### `SetType` reports; `set Type` is a thin wrapper over it

```ts
interface StructRetagResult { retagged: number; unreachable: number }

SetType(type: string): StructRetagResult;
set Type(v: string);   // calls SetType, discards the result
```

A property setter cannot report what the surgery could not reach, and doing
content surgery silently behind `=` is surprising. Both go through one
implementation so they cannot drift — the `ToMarkdown` / `ToMarkdownAssets`
pairing, which is a thin wrapper over the same render for the same reason.

`SetType` writes `/S`, then rewrites the BDC tag of **this element's own**
content items. Children keep their own types; an element's content items may
name several pages, and each is walked.

### The rewrite: one new event on `visitContent`

`ContentVisitor` gains a fifth event beside `glyph`, `image`, `path` and
`artifact`:

```ts
interface MarkedContentEvent { addr: ContentAddr; tag: string; mcid: number; properties?: PdfDict }
marked?(e: MarkedContentEvent): void;
```

fired at the **opening** `BDC`. That is the shape `openArtifact(ctx, addr, …)`
already has, and `ArtifactEvent` already sets the precedent for an event fired
at an opening op — which is what makes a scope enclosing no ink reportable at
all.

**Invariant:** it fires only for a `BDC` whose property list resolves an
`/MCID`, which is precisely "a structure content item opens here". The walker
already computes `mcidFromProps` in that branch, so the narrowing costs
nothing, and it means the event has exactly one meaning rather than overlapping
the `artifact` channel — an `/Artifact` BDC carries no MCID, so the two
provably cannot both fire for one op.

**Invariant:** one walker owns "where is this MCID marked". A private recursive
walk in `structwrite.ts` would have to re-derive `/Resources` inheritance and
Form XObject descent, and two content walkers disagreeing about one page is
this repo's most-recorded failure.

**Invariant:** `structwrite.ts` passes no `ContentWalkOptions`, so `skipHidden`
keeps its `false` default and optional content hidden by the current
configuration is still retagged. An edit consumer must see what the file
*contains*, which is the polarity `q1g2.3` fixed and the reason the walker's
default is the opposite of a read API's.

The rewrite itself goes through `EditableContent`, which already performs the
Form XObject copy-on-write and is already `structwrite.ts`'s editing vocabulary.

**Note a COW cost that is correct and worth stating:** a Form XObject shared by
two pages, each marking content inside it, is cloned when one page's element is
retagged — so the file gains a second copy of that form for a metadata edit.
Correct, and unavoidable while pages must not edit each other's content.

**Note:** a form drawn twice under one resource name yields two events at one
`path`; `EditableContent` keys its clone cache by `path.join('\0')`, so the
second rewrite hits the cached clone and the operation is idempotent.

### Fail-open, and what it costs

An MCID the walk cannot address leaves its stale tag, counts into
`unreachable`, and **never throws**. Two populations reach it: a content item
whose `/Pg` does not resolve to a page, and a `BDC` inside a tiling pattern, a
Type 3 `/CharProcs` or an annotation appearance — none of which `ContentAddr`'s
XObject-name chain can name, the limit already recorded under `85l8.6`.

**Invariant:** the direction is the safety property. A stale tag name is a
cosmetic divergence nothing in this library reads, so it must not cost the
caller the retag they asked for; `/S` is written either way and the count says
what was left behind.

## Testing

Unit rules over `structtype.ts` need no PDF: the standard set, a one-hop
RoleMap, a multi-hop chain, a cycle, an unmapped name, a non-string.

Three things need care, and two are unfalsifiable without a deliberate fixture:

**The BDC rewrite is invisible to structure round-tripping.** Measured above —
nothing here reads a tag name. A test that retags and re-reads `Type` passes
with the whole rewrite deleted. The assertion must be on the emitted content
bytes, and the mutation check is deleting the rewrite and watching exactly that
case redden.

**Every MCID-bearing BDC we author is at page top level.** `markContentRegion`
wraps top-level spans, and `flatten.ts` appends its `/<tag> <</MCID n>> BDC` to
page content rather than writing it into the form it draws. So the nested-form
path, and its copy-on-write, are reached by **no existing fixture** and need a
hand-built one whose `BDC` sits inside a Form XObject.

**A `/Figure` whose `/Alt` clears `IllustrationAlt`** gets its regression test,
covering the half of the criterion that already passes, so a future change
cannot silently take it away.

The `Subtitle` case in `test/struct-write.test.ts` stays unedited as the fence
that a `RegisterRole`'d custom type still appends.

## Acceptance

- Setting `/Alt` on an auto-tagged `/Figure` clears the `IllustrationAlt`
  finding from `ValidatePdfUa` — asserted, already true.
- `Append` and `SetType` reject an unmapped custom type with a `RangeError`,
  and accept one the `/RoleMap` resolves.
- A rejected `Append` leaves the document byte-identical.
- Retyping an element rewrites the BDC tag in the page content behind its own
  content items, including one inside a Form XObject, and reports what it could
  not reach rather than throwing.
- `test/import-cycles.test.ts` still names the same set of 2-cycles.

## Out of scope

Moving, reordering and removing elements are `q7hc.3` and `q7hc.2`. Translating
types between vocabularies is explicitly not `q7hc.4`'s job either. Nothing here
touches the PDF 2.0 namespace.
