# How a parse-whole, rewrite-on-save model tracks a delta — design

**Issue:** `msdn.1` — a DECISION gating the rest of the `msdn` epic (general
incremental update on save).

**Decision:** the delta is computed at save time by comparing canonical
serializations against a baseline **re-parsed from the retained original
bytes**. Mutation sites report nothing and are not trusted.

**Scope answer taken from the issue owner:** both use cases, signatures first —
correctness of the appended revision dominates, and delta minimization is a
later measured optimization on this same seam.

## What the issue got right, and what it got wrong

**Right — the two candidate shapes are the two real ones,** and the axis
between them is who is responsible for reporting a change.

**Right — the obstacle is architectural.** `Save()` mark-sweeps from `/Root`
and renumbers 1..N, which is exactly the information an append must not use.

**Wrong — (a) is not merely burdensome, it is unsound, and the issue frames
this as a cost ("makes every mutation site responsible") rather than as a
correctness property.** Two independent reasons, either fatal:

1. `Page.Dict`, `Annotation.Dict` and `Field.Dict` are public
   `readonly Dict: PdfDict` handles onto the live `Map`
   ([page.ts:82](../../../src/page.ts#L82),
   [annotation.ts:86](../../../src/annotation.ts#L86),
   [formfield.ts:101](../../../src/formfield.ts#L101)). `page.Dict.set('Rotate', 90)`
   mutates the document and reports nothing. No discipline at the 64 existing
   `markModified()` sites can close this while `Dict` is public.
2. The reporting handles generally know their *dict* but not the **indirect
   object number that contains it**. An in-place edit of a nested array inside
   a page's `/Annots` is a mutation of the page object, and nothing walks back
   up to say so. `markModified()` takes no argument today precisely because it
   never needed one.

**Wrong — the issue's cost note for (b), "has to define object equality", is
already answered by the repo.** `serializeObject` is deterministic and
canonical: dict order is `Map` insertion order, numbers and strings have one
spelling each ([serialize.ts](../../../src/serialize.ts)). Byte-equality of its
output *is* the definition, at no design cost.

**Not named — the failure directions are opposite, and that is what settles
it.** A dirty set that misses a mutation writes **too little**: the appended
revision silently omits the edit and the file looks perfectly well-formed. A
save-time diff that cannot prove equality writes **too much**: a larger file,
correct content. This is the same allowlist-not-denylist posture `content.ts`'s
`NON_MARKING` and `fontmatch.ts`'s positive-evidence rule already take, and it
matters more here than usual, because the entire purpose of the feature is a
revision history someone will rely on.

**Not named — much of the machinery already exists.** `originalBytes` is
retained on open ([document.ts:331](../../../src/document.ts#L331)) and
`incremental.ts` already appends objects, a classic xref section and a
`/Prev`-chained trailer. What is missing is only the delta.

## The mechanism

**Invariant: the delta is decided by comparing canonical serializations, never
by trusting a mutation report.** Soundness is then independent of how the
mutation happened, direct `Dict` writes included.

**Invariant: the baseline is a PARSED baseline, not the original file bytes.**
The parse→serialize round trip is lossy in *spelling* (number formatting,
string escaping, dict spacing) and faithful in *content*, so equality must be
defined on the serializer's output with **both sides through the same
serializer**. Comparing a live object's serialization against its original
bytes reports every object in the document as changed.

**Where the baseline comes from (B2, chosen over B1).** Retain the
`OpenOptions` alongside `originalBytes`. On incremental save only, re-open
`this.originalBytes` with them and diff against that pristine model.

The alternative considered and rejected, B1, fingerprints every object at open
(a sha256 of its serialization, captured where `originalBytes` is assigned at
[document.ts:552](../../../src/document.ts#L552) and
[:631](../../../src/document.ts#L631)). It was rejected because it taxes *every*
`Open` in the library — including the overwhelming majority of callers who
never save incrementally — for a feature they do not use, whereas B2 puts the
whole cost inside the operation that asks for it, on a path that is already
writing a file. B2 also dissolves a blocker B1 does not: the decryptor is local
to `build()` and is **not** retained on `Document`, so a re-parse needs the
password back, which retained `OpenOptions` supplies.

The costs B2 does carry, stated rather than discovered later: one extra full
parse per incremental save, a transient second object graph, and a plaintext
password held for the document's lifetime. The last is not a real escalation —
the model already holds the fully decrypted content — but it is a new place to
look for one.

**The diff produces three sets,** which is exactly `appendIncrementalUpdate`'s
existing input plus one:

| condition | outcome |
|---|---|
| in both, serializations differ | **replaced** |
| absent from baseline | **new** |
| in baseline, absent now | **freed** |

`buildXrefSection` writes only `n` entries today, so free entries are a real
gap for `msdn.2`.

**Ordering: the diff runs after `finalizeEmbeddedFonts()`.** Font embedding
allocates objects during `Save` ([document.ts:1486](../../../src/document.ts#L1486)),
so a diff taken before it misses every embedded font.

**Invariant: the incremental delta is REACHABILITY-BLIND.** `Save()`
mark-sweeps from `/Root` and drops orphans; an appended revision must do the
exact opposite, writing changed objects whether or not they remain reachable,
because earlier revisions still point at the old ones. Garbage-collecting here
silently corrupts the revision history that is the whole point of the feature.
This is the inversion of the model documented at the top of CLAUDE.md, so it is
the rule most likely to be "fixed" wrongly later.

## A pre-existing bug found while designing this

`incremental.ts` has **no encryption handling at all**, and nothing guards
signing against it. Signing an encrypted document therefore appends
**plaintext** objects into an encrypted file. This is independent of this epic
and is filed as `x8kx`; it is also why encrypted documents refuse incremental
save below.

## Refusals

All `UnsupportedFeatureError`, all cheap to check:

- **no `originalBytes`** — authored in memory, nothing to append to
- **`doc.recovery !== undefined`** — the xref an append chains `/Prev` to is
  the structure we could not read. Appending onto it produces a file whose
  earlier revision no other reader can follow, which is worse than refusing.
- **encrypted** — until the bug above is fixed
- **combined with `encrypt`, `compressed`, `streamFilter`, or linearization** —
  the first two change what an append cannot change; `streamFilter` rewrites
  every stream, so the "delta" is the whole document. Refusing is honest where
  silently emitting a full-size append is not.

## Limits and decisions, documented rather than refused

- **Generations.** The object map is keyed by number and drops `gen`, so
  `incremental.ts` writes `N 0 obj` unconditionally, while `xref.ts` does parse
  `gen`. Because B2 re-parses anyway, `msdn.2` takes each replaced object's
  generation from the previous xref and writes it correctly. A fix, not a
  limitation — recorded here because the obvious first cut is to refuse
  `gen != 0` documents instead.
- **`/ObjStm` members.** An object that lived in an object stream is replaced
  by a plain `N 0 obj` in the appended section, which legally supersedes it. No
  special handling is needed; stated so that none is added.
- **Section kind.** A classic appended section may chain `/Prev` to a previous
  *cross-reference stream*. Legal for any PDF 1.5+ reader, and our own
  `xref.ts` follows `/Prev` regardless of section kind
  ([xref.ts:31](../../../src/xref.ts#L31)).
- **`/ID` is carried unchanged**, matching what signing already requires.
- **`/Root` and `/Info`** are carried from the live trailer, since the diff
  covers objects and not the trailer;
  `IncrementalUpdateOptions` already accepts both.

## Testing

**The ceiling, stated first.** CLAUDE.md's rule that *a differential test
cannot validate the parser it runs through* applies directly: verifying an
incremental save by reopening it with `Document.Open` puts both sides through
our own reader, so an append our reader happens to tolerate stays green. This
is the same ceiling `tiffencode.ts` and `gifencode.ts` already record.

Anchors outside our own parser:

- **Prefix identity** — `output.subarray(0, original.length)` is byte-identical
  to the input. Parser-free, and the strongest single property the feature has.
- **Signature survival** (`msdn.5`) — a genuine external anchor, because the
  digest is over bytes rather than over our parse.
- **A qpdf-checked golden**, the `fixtures/svg/` arrangement: run qpdf over our
  output offline and commit what it said. qpdf is already in the authoring
  workflow for `fixtures/corrupt/`, and nothing in CI can otherwise call our
  append malformed.

Cases pinning the mechanism:

- **No edits ⇒ zero objects appended.** Also the case that pins the
  parsed-baseline invariant above.
- **One edit to one existing object ⇒ exactly one object appended.** Pins that the diff does not
  over-report, which is the only way this stays useful rather than merely
  correct.
- **A direct `page.Dict.set('Rotate', 90)`, bypassing every `markModified`
  site, is still caught.** This is *the* case separating this design from a
  dirty set — under (a) it is green with silent data loss — so it is written as
  its own named test rather than folded into the edit case.
- **Deletion ⇒ a free xref entry**, with the object unreachable in the new
  revision but still present in the byte image.
- **Each refusal**, asserted by message.

Mutations to run before closing `msdn.2`:

- neuter the serialization comparison — the no-edit, one-edit and direct-`Dict`
  cases must redden
- mark-sweep the delta — an orphan-retention case must redden

## Out of scope, tracked separately

- Encrypted incremental update (and the plaintext-append signing bug).
- Compressed appended sections (`/ObjStm` + cross-reference stream in the
  update), which `Save({ compressed: true })` produces for a full rewrite.
- Delta minimization beyond "unchanged objects are not written": lazy or
  narrowed comparison, and any accelerator set, which may only ever *propose*
  candidates the diff still decides.
