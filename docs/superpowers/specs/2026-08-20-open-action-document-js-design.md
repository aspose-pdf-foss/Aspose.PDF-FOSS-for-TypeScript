# Catalog /OpenAction and the document JavaScript name tree

Design for `aspose-pdf-foss-for-ts-lucg.4`, the fourth and last child of the
`Authoring breadth` epic (`lucg`). The library reads and *deletes* both
constructs and offers no way to author either.

## Problem

The gap runs one way through the whole stack, the same shape the three previous
children of this epic had:

- `pdfavalidate.ts:467` reports on the catalog `/OpenAction`, and
  `pdfavalidate.ts:470` on the `/Names /JavaScript` tree.
- `pdfxvalidate.ts:533` checks `/OpenAction`.
- `pdfaconvert.ts:266-273` and `pdfxconvert.ts:243-245` *remove* both as
  prohibited constructs.
- `actions.ts` already models a JavaScript action (`JavaScriptAction`) with one
  encoder and one parser, and `parseStandaloneAction` exists precisely for an
  action dict that is not an annotation's `/A`.

So every piece is present except the authoring entry points. A caller who wants
a document to open at page 3, or to carry a document-level script, cannot say
so — while `ConvertToPdfA` can confidently report having removed the thing they
could not add.

Note the Go implementation's `open_action.go` and `javascript.go` are named in
the issue but were **not available to read** while designing this. Nothing here
claims to mirror their API; the design argues from ISO 32000-1 and from this
repository's own conventions, and the naming follows the existing
`GetNamedDestinations` / `SetNamedDestination` / `RemoveNamedDestination` trio.

## Approach

**Two new modules.** `nametree.ts` is a leaf owning the name-tree vocabulary,
read and write; `docaction.ts` owns the two catalog features. `document.ts`
gains the entry points only, as it did for `NewTilingPattern` and
`NewTemplate`.

Two alternatives were considered and rejected:

- **Add the generic upsert/remove to `outline.ts`.** It already holds the read
  half. Rejected on direction: `outline.ts` is bookmarks and destinations, and
  a name tree is neither — `embeddedfile.ts` and the new module would both
  import `outline.js` for something with nothing to do with outlines.
- **No refactor; write a third copy of the upsert/remove body.** Rejected
  because the part that would drift is exactly the part that is easy to get
  wrong and invisible when wrong: the two-level pruning rule.

## Scope

In:

- Catalog `/OpenAction`, read and written, in both of the shapes 32000-1
  table 28 permits.
- The `/Names /JavaScript` name tree: read, upsert, remove.
- A shared `nametree.ts`, with `/Dests` and `/EmbeddedFiles` converted onto it.
- A read fix in `actions.ts` for a `/JS` **stream**.

Out:

- **Catalog `/AA`** — the document-level additional actions `/WC`, `/WS`,
  `/DS`, `/WP`, `/DP`. Adjacent and cheap, but the issue names `/OpenAction`
  and the JavaScript tree, and a second trigger vocabulary is its own decision.
- Interpreting, executing or validating script text. The library stores it.
- Balanced name trees. A single flat node, which is what all three branches
  already write.
- Changes to `pdfaconvert.ts` / `pdfxconvert.ts` / the validators. They already
  handle both constructs; authoring gives them nothing new to do.

## Design

### 1. `nametree.ts`, a leaf

Moved out of `outline.ts` unchanged: `lookupNameTree` (`outline.ts:86`),
`collectNameTree` (`:179`), `flatNameNode` (`:220`). Added:

```ts
export function upsertNameTreeEntry(
  doc: Document, branch: string, key: string, value: PdfObject,
): void;
export function removeNameTreeEntry(
  doc: Document, branch: string, key: string,
): boolean;
```

`branch` is the key under `/Root /Names` — `'Dests'`, `'EmbeddedFiles'`,
`'JavaScript'`.

**Invariant: the module is a LEAF.** It imports `Document` as a *type* only,
exactly as `outline.ts` does. That is what lets `document.ts`, `embeddedfile.ts`
and `docaction.ts` all hold it without any of them depending on another — the
arrangement `tablegrid.ts` already has between the two table detectors.

**Invariant: pruning is two-level, and that is the whole reason this is
shared.** Removing the last entry of a branch deletes the branch from `/Names`,
and if `/Names` is then empty it is deleted from the catalog. One level of
pruning leaves `<< /Names << >> >>` in the saved file: legal, harmless, and
different from what the other branches produce — so the divergence shows up as
a byte diff in an unrelated feature's output rather than as a failure here.

**Invariant: only the tree half is shared.** Each consumer keeps its own extra
step, because they are not the same step and folding them in would give the
leaf three special cases:

| Consumer | Branch | Its own extra |
|---|---|---|
| `document.ts` | `Dests` | also removes from the legacy catalog `/Dests` dict |
| `embeddedfile.ts` | `EmbeddedFiles` | registers/unregisters the filespec in `/AF` |
| `docaction.ts` | `JavaScript` | none |

`removeNameTreeEntry` returns a boolean because `removeEmbeddedFile` already
reports whether the name was there and `RemoveJavaScript` will too.
`RemoveNamedDestination` stays `void` and ignores the return, since it goes on
to the legacy `/Dests` dict either way — the name may live in one, the other,
or both. `upsertNameTreeEntry` returns nothing.

**The value is stored as given.** `SetNamedDestination` stores a direct array
and `upsertEmbeddedFile` stores a ref; the leaf must not decide. `docaction.ts`
stores a direct dict.

### 2. Catalog `/OpenAction`

```ts
export type OpenAction =
  | { kind: 'dest';   dest: PageDest }
  | { kind: 'action'; action: PdfAction };
```

32000-1 table 28: `/OpenAction` is *either* a destination *or* an action
dictionary.

**Invariant: the discriminator is `/S`, and nothing else.** Three shapes reach
the reader and two of them are dicts:

| Written form | Reads as |
|---|---|
| `[3 0 R /Fit]` — an array | `dest` |
| `<< /D [3 0 R /Fit] >>` — a dict, no `/S` | `dest` |
| `<< /S /GoTo /D [3 0 R /Fit] >>` | `action` |

`decodeDest` in `outline.ts` already accepts the `<< /D [...] >>` form, so a
dict alone cannot decide it — and a GoTo action carries `/D` too. Test the
presence of `/S` first: a dict with `/S` is an action, a dict without is a
destination.

This is the one rule in the feature that is silently wrong when wrong. A GoTo
action mis-read as a destination resolves to **the same page**, so every
page-number assertion passes; what breaks is that `GetOpenAction()` reports the
wrong `kind`, and a read-modify-write turns a producer's action dict into a
bare array. Both cases are therefore asserted side by side (see Testing).

Writers:

- `SetOpenDestination(dest: PageDest)` — writes the bare array through
  `encodeDest`. Page range validated as `SetNamedDestination` does, throwing
  `RangeError`.
- `SetOpenAction(action: PdfAction)` — writes a direct dict through
  `encodeAction`, which already range-checks a `goto` page (`RangeError`) and
  rejects an unknown `type` (`TypeError`). **No new validation is written**; a
  second copy of those checks is how the two entry points come to disagree
  about a page number.
- `RemoveOpenAction()` — deletes the key. A no-op when absent.

`GetOpenAction(): OpenAction | undefined` — `undefined` both when the key is
absent and when it is present but unmodellable (an action type `actions.ts`
does not model, a destination whose page does not resolve). The library already
takes that position for an annotation's `/A`, and inventing a third state for
"present but not understood" would put a shape in the public type that no
caller can act on.

### 3. The document JavaScript name tree

```ts
export interface DocumentJavaScript { name: string; script: string; }
```

- `GetJavaScripts(): DocumentJavaScript[]` — every entry of `/Root /Names
  /JavaScript`, sorted by name, matching `GetNamedDestinations`.
- `SetJavaScript(name: string, script: string): void` — upsert. Rejects an
  empty name (`TypeError`, as `SetNamedDestination` does) and an empty script
  (`encodeAction` already rejects it).
- `RemoveJavaScript(name: string): boolean`.

**Invariant: an entry is read through `parseStandaloneAction`, never by reading
`/JS` directly.** That is the one owner for the action grammar, and it is what
gives the stream fix in §4 to this feature for free.

**Invariant: a non-JavaScript entry is skipped, and the skip is documented.**
32000-1 §7.7.4 requires these values to be JavaScript actions; an entry that
parses as, say, a `uri` action has no `script` to report and the type admits
nothing else. Skipping is the only outcome that types, so it is stated rather
than discovered.

### 4. `/JS` as a stream

32000-1 table 217: a JavaScript action's `/JS` is "a text string **or** a text
stream". `parseActionDict` (`actions.ts:191`) accepts only `isString(js)`, so a
stream reads back as `undefined` — the whole action vanishes, not just its
script.

This is a **pre-existing defect**, reachable today from any annotation `/A` and
any field `/AA`, and it is logged in the changelog under **Fixed** rather than
as part of the new feature. Document-level JavaScript is simply where it bites
hardest, since that is where large scripts live and where producers most often
choose the stream form.

The fix reads the stream through `decodeStream` (`filters.ts:118`) and decodes
the bytes as PDF text, exactly as the string branch does.

**Writing stays string-only.** A size threshold that chose the stream form
above some length would make the output shape depend on content length — two
encodings to test and a byte-identity fence that moves with the script.

### 5. Public surface

On `Document`, beside the named-destination trio:

```ts
GetOpenAction(): OpenAction | undefined;
SetOpenAction(action: PdfAction): void;
SetOpenDestination(dest: PageDest): void;
RemoveOpenAction(): void;

GetJavaScripts(): DocumentJavaScript[];
SetJavaScript(name: string, script: string): void;
RemoveJavaScript(name: string): boolean;
```

`index.ts` exports the types `OpenAction` and `DocumentJavaScript`. The
`nametree.ts` helpers stay internal, as they are today.

## Testing

`test/nametree.test.ts` — the shared machinery, from hand-built dicts:

- upsert creates `/Names` and the branch when neither exists;
- upsert into an existing branch preserves the other entries and keeps the
  `/Names` array sorted;
- **the two-level prune**: removing the last entry of the only branch deletes
  the branch *and then* `/Names`; removing the last entry of one of two
  branches deletes that branch and **keeps** `/Names`. The second case is what
  distinguishes correct pruning from over-eager pruning, and a single-branch
  fixture cannot see the difference.
- remove returns `false` for an absent key and leaves the tree untouched.

`test/docaction.test.ts` — `/OpenAction`:

- a destination round-trips as `kind: 'dest'` with its page and view;
- an action round-trips as `kind: 'action'`;
- **the discriminator pair**: a hand-built `<< /D [...] >>` reads as `dest` and
  a hand-built `<< /S /GoTo /D [...] >>` reads as `action`. Asserted side by
  side and on `kind`, not on the page — both resolve to the same page, so a
  page assertion passes with the discriminator inverted.
- `SetOpenDestination` writes an array and `SetOpenAction` writes a dict,
  asserted on the saved bytes: the two writers must not converge.
- an out-of-range page throws `RangeError` and leaves the document
  byte-identical;
- `RemoveOpenAction` on a document with none is a no-op.

`test/docjs.test.ts` — the JavaScript tree:

- set/get round trip, several names, returned sorted;
- remove returns `true` then `false`, and removing the last entry prunes
  `/Names` entirely — the end-to-end reading of the `nametree.ts` rule;
- an entry whose action is not JavaScript is skipped while its siblings are
  still returned (the skip must not truncate the list);
- **a stream `/JS` is read**, from a hand-built fixture.

**The refactor's fence is the existing suites.** The named-destination,
attachment and PDF/A converter tests must stay green with no edits — that is
the evidence the extraction preserved behaviour, the same argument
`containMatrix` rested on in `lucg.3`. They are named in the plan as
must-run-unchanged rather than left to `npm test` to notice.

**To prove load-bearing** (each mutation must redden the named case and leave
the others green):

- invert the `/S` test in the reader → the discriminator pair reddens, the
  page-number assertions do not;
- prune one level only → the two-branch prune case reddens, the single-branch
  one stays green;
- revert the `/JS` stream branch → the stream fixture reddens alone.

## Risks

- **The extraction is a verbatim move**, which is the change a green suite is
  most likely to be mistaken for coverage of. Mitigated by converting
  `/Dests` and `/EmbeddedFiles` onto the shared helper in the same task and
  running their suites unedited, and by the mutation above.
- **`upsertNameTreeEntry` changes who allocates the node.** All three existing
  call sites do `doc.allocObject(flatNameNode(entries))`; the helper must keep
  doing exactly that, or an existing branch's value becomes direct where it was
  a ref and every saved-bytes assertion in the attachment suite moves.
- **`GetOpenAction()` returning `undefined` for an unmodelled action** is
  indistinguishable from "absent" to a caller. Accepted deliberately (§2), and
  the reason is recorded so it reads as a decision.
