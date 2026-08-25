# `post` 2.0 → 3.0 Downgrade in the Font Shrinker — Design

**Issue:** aspose-pdf-foss-for-ts-gfs · Optimize: downgrade 'post' to version 3 when glyph names are provably unused
**Date:** 2026-07-15

## Problem

`fontshrink.ts` drops layout, hinting, and bitmap tables (`DROP_TABLES`) but
copies `post` verbatim. A `post` v2.0 table carries a glyph-name index plus a
Pascal-string name pool that can run ~40KB on a large face. `doo` left that on
the table deliberately.

Version 3.0 is the same table with the names removed. Rewriting 2.0 → 3.0 is a
pure size win — but only where nothing resolves a glyph by name.

## Sequencing: the collision with `4by` already resolved itself

The issue framed this as a choice: if `gfs` landed first, the downgrade could be
unconditional for Type0; if `4by` (simple-font subsetting) landed first, the
downgrade must be conditional.

`4by` landed first, in part. Commit `88dd3a8` ("feat(optimize): subset simple
TrueType fonts") brought simple TrueType fonts into the optimizer's scope, and
`glyphusage.ts:143-148` resolves codes through `post` names for `/Differences`
names outside the Adobe Glyph List. `test/optimize.test.ts:105` guards exactly
that. Simple CFF remains a `TODO(4by)` at `glyphusage.ts:154`.

**The downgrade must therefore be conditional.** This spec takes the conditional
branch the issue anticipated.

## Who resolves glyphs by name

| Font dict | Chain | Needs `post`? |
|---|---|---|
| Type0 / Identity-H | code → CID → GID via `CIDToGIDMap` or CFF charset | No — never consults a name |
| Simple TrueType, nonsymbolic | `/Encoding` + `/Differences` → name → AGL → cmap, falling back to `post` for names outside the AGL (PDF 32000 9.6.6.4) | Yes |
| Simple TrueType, symbolic | raw code → cmap (3,0)/(1,0) | Not in principle, but the `/Flags` symbolic bit is widely wrong in the wild and a font can carry both a symbol cmap and `/Differences` |
| Simple CFF | code → name → charset | Yes — but a bare CFF program carries no `post` to drop, so it never reaches the rewrite |

Only Type0 is provably name-free from the font dict's `/Subtype` alone.

### Why not a per-name proof for simple fonts

A tempting extension: downgrade a simple font too, when every *used* code
resolves without the `post` chain. Rejected. `glyphusage.ts` unions all
defensible chains because viewers disagree on which to follow, while a real
viewer follows a priority order. A name our union judged redundant could be the
one a given viewer actually resolves through, and dropping it swaps in a
different glyph. The failure is silent and visual. This contradicts the scan's
stated "skip on any doubt" policy for a P4 size win.

## Scope

`post` only exists in sfnt-packaged, `glyf`-outlined programs, so this touches
**`shrinkGlyf` only**. `shrinkCff` rebuilds through `assembleCidCff`, which emits
no `post`. Reached via `FontFile2`, and `FontFile3`/`OpenType` when
`outlines === 'glyf'`.

## Architecture

Three additions, no new modules.

### 1. `rewritePostV3` — `src/fontshrink.ts`

```ts
function rewritePostV3(post: Uint8Array): Uint8Array | undefined
```

A `post` v2.0 table is a 32-byte header (version, `italicAngle`,
`underlinePosition`, `underlineThickness`, `isFixedPitch`, and four
`min/maxMemType42/1` hints), then `numGlyphs` (uint16 at offset 32), the glyph
name index array, and the name pool. Version 3.0 is the 32-byte header alone.

The rewrite: copy the first 32 bytes, stamp version `0x00030000`. Every header
field survives.

Returns `undefined` unless the input is v2.0. v1.0, v2.5, v3.0, and v4.0 are left
verbatim rather than guessed at, which keeps the caller a one-liner and makes a
double-`Optimize` a no-op on the second pass.

### 2. Opt-in on the shrinker

```ts
function shrinkGlyf(font: SfntFont, keep: Set<number>, opts?: { dropGlyphNames?: boolean }): ShrinkResult
```

Default off. Every existing caller stays behavior-identical. When set and
`rewritePostV3` returns bytes, the rewritten table replaces the verbatim copy in
the `tables` list; otherwise `post` is copied as today.

### 3. `glyphNameDroppableFonts` — `src/optimize.ts`

```ts
function glyphNameDroppableFonts(doc: Document): Set<PdfDict>
```

> **Corrected during implementation.** This was specced as
> `nameResolvingPrograms(doc): Set<PdfStream>` — a veto set keyed on program
> identity, consulted by `shrinkOne` as `!veto.has(prog.stream)`. That defeats
> itself. `shrinkOne` replaces a shrunk program with a freshly allocated stream,
> so when two font dicts share a `/FontDescriptor`, the *second* dict resolves to
> a stream the *first* pass just created — an object the veto set has never seen.
> It reads as "not vetoed" and the names are dropped, on precisely the
> shared-program case the veto exists to protect. The shared-program test caught
> it. The veto is still decided per program; it is now *answered* per font dict,
> resolved up front on the pristine graph, so no stream lookup happens after
> mutation begins.

One walk over `doc.objectEntries()` (`document.ts:564`, `@internal`, and
already the sanctioned way to scan the whole object graph — `pdfavalidate.ts`
uses it). For every `/Type /Font` dict, resolve its program via the existing
`fontProgram` helper (which reaches a Type0's descriptor through `descendantOf`)
and record `dict -> program`. A dict whose `/Subtype` is **not** one of `Type0`,
`CIDFontType0`, or `CIDFontType2` vetoes its program. A font dict is then
name-droppable when its program went unvetoed.

`shrinkOne` takes the answer as a plain `dropGlyphNames: boolean`
(`nameDroppable.has(font)`), so it performs no stream lookup of its own.

**Excluding the CIDFont descendants is load-bearing, not a detail.** A Type0
font's `/FontDescriptor` does not live on the Type0 dict; it lives on the
descendant CIDFont, which `shrinkOne` reaches via `descendantOf`
(`optimize.ts:101`). That descendant is itself a `/Type /Font` dict with
`/Subtype /CIDFontType2` — "not `Type0`". A veto rule that only excluded `Type0`
would therefore veto **every Type0 program via its own descendant**, and the
downgrade would never fire on anything. `glyphusage.ts:382-388` documents this
same trap for its safety net.

The exclusion is safe for the same reason stated there: a CIDFont descendant is
only ever reachable through its Type0 parent, and that parent resolves
code → CID → GID without consulting a name.

The three exclusions are named explicitly rather than inverted into an allow-list
of simple subtypes, so an unrecognized `/Subtype` vetoes by default. `Type3`
carries `/CharProcs` rather than a `FontFile`, so it contributes nothing to the
set either way.

**Vetoed per program, answered per dict.** A face embedded once and referenced by
both a Type0 dict and a simple dict keeps its names — the veto must consider
every dict reaching a program, not just the one being shrunk. But the *answer*
must be a dict-keyed fact settled before any mutation, because the program's
identity does not survive the pass that consumes it (see the correction note
above).

**Identity works, up front.** `doc.resolve` returns the same `PdfStream` instance
for the same ref, so `Map<PdfDict, PdfStream>` grouping is exact while the graph
is pristine — no object-number bookkeeping. It stops being exact the moment
`shrinkOne` allocates a replacement, which is why nothing consults it afterwards.

**Whole-graph, not usage-map — for independence, not coverage.** `UsageMap` would
in fact answer this today: `collectGlyphUsage`'s safety net
(`glyphusage.ts:377-392`) already adds every unreached font dict in the object
graph to the map, skipping only CIDFont descendants, so every simple dict is
present. Reusing it would save a pass.

It is rejected anyway. That would make this veto's correctness a downstream
consequence of another module's safety net — a net written for a different
purpose (don't blank unreached fonts) that a future change could narrow without
any signal here. The failure would be silent: an under-approximated veto set
drops names a viewer needs, and nothing fails until someone looks at a page. A
self-contained scan costs one cheap pass and states its own invariant. The set is
built once per `optimizeFonts` call, not per font.

## Data flow

```
optimizeFonts
  ├── glyphNameDroppableFonts(doc) → nameDroppable: Set<PdfDict>   (once, pristine graph)
  ├── collectGlyphUsage(doc)       → UsageMap
  └── per font dict:
        shrinkOne(doc, font, gids, nameDroppable.has(font))
          └── shrinkGlyf(sfnt, gids, { dropGlyphNames })
                └── rewritePostV3(post)
```

The usage scan reads `post` names off the *original* program before any rewrite,
so its own name chain is unaffected by ordering.

`glyphNameDroppableFonts` must run before the first `shrinkOne`, and its result
must be dict-keyed rather than stream-keyed — those are the same requirement seen
from two sides, since `shrinkOne` invalidates program identity as it goes.

## Error handling

No new failure mode. A malformed or non-2.0 `post` falls through to "keep
verbatim". The existing `shrink failed:` catch in `shrinkOne` still covers
structural surprises, and the existing `bytesSaved <= 0` rule still reverts the
whole rewrite when it fails to pay for itself.

## Report

No new `OptimizeReport` field. The savings roll into the existing per-font
`bytesSaved`. A breakdown can be added later if anyone asks for one.

## Testing

TDD, vitest, fixture builders in `test/helpers/` per repo convention.
`buildPostV2` (`build-sfnt.ts:97`) and `customGlyphNames`
(`build-optimize-pdf.ts:98`) already exist.

**`test/fontshrink.test.ts`**
- With `dropGlyphNames`: `postNames()` is `undefined`, the `post` table is
  exactly 32 bytes, version reads 3.0, and header fields (`italicAngle`,
  `underlinePosition`, `isFixedPitch`) match the input.
- Without the flag: `post` is byte-identical to the input.
- A `post` already at v3.0 is left alone; a v1.0 `post` is left alone.
- Glyph outlines and `numGlyphs` are unaffected either way.

**`test/optimize.test.ts`**
- Type0 with a `post` v2.0: names gone after `Optimize`, program strictly
  smaller, `GetText()` byte-identical across `Save` + re-`Open`. **This is also
  the regression test for the descendant-exclusion trap above** — get that wrong
  and the names survive, so this test fails loudly rather than silently
  degrading into a no-op.
- A `FontFile2` shared by a Type0 dict and a simple dict: names survive.
- **`optimize.test.ts:105` stays green unmodified** — the primary regression
  signal that conditionality holds.

The Type0 fixture in `test/helpers/build-optimize-pdf.ts` may need a `post`
option added, mirroring the one `buildSimpleTtfPdf` already accepts.

## Out of scope — filed separately

`shrinkOne` re-resolves the program per font *dict*, so two dicts sharing one
`FontFile2` each shrink it against their own gid set: the second pass shrinks the
first pass's output, blanking glyphs the first dict shows. This is a pre-existing
`doo`/`4by` defect, orthogonal to `post`, and the veto set above sidesteps it for
names only. Filed as `aspose-pdf-foss-for-ts-4hf`.
