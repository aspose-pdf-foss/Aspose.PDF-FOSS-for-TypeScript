# Document Optimization (`doc.Optimize`) — Design

**Issue:** aspose-pdf-foss-for-ts-doo · Document optimization (doc.Optimize)
**Date:** 2026-07-15

## Problem

No size-reduction path exists. A document opened and re-saved keeps every
embedded glyph, every duplicate stream, and whatever compression the producer
chose. We want a configurable, opt-out-per-concern `doc.Optimize()` that shrinks
the live model in place, so the next `Save()` emits a smaller but
content-identical document.

## Scope

The issue named four concerns: images, fonts, dedup, compress. **Images are out
of scope for this spec** and move to a follow-up issue.

The reason is a hard dependency, not a preference. The acceptance criterion
"image recompression honors target DPI/**quality**" requires a JPEG encoder, and
this repo has none: `jpeg.ts` is decode-only (baseline, progressive, arithmetic,
lossless, hierarchical) and `pngencode.ts` is the only encoder in the tree. A
baseline JPEG encoder (DCT, quantization tables, Huffman) is a substantial
from-scratch subproject — well within house style given the JPX/JBIG2/CCITT
decoders, but it is not a sub-task of an optimizer and deserves its own spec and
test surface.

This spec therefore covers the **Optimize framework + fonts + dedup + compress**.
Issue `doo`'s acceptance criteria narrow accordingly; a follow-up issue covers
the JPEG encoder and image downsampling/recompression.

All three concerns in scope are **lossless**. Content and visual output are
preserved exactly; the only observable change is file size.

## Architecture

Five new focused modules, following the repo's one-concern-per-file convention.
`Document.Optimize` is a thin delegate, mirroring how `ConvertToPdfA` delegates
to `conversion.ts`.

| Module | Responsibility |
|---|---|
| `src/optimize.ts` | Public `OptimizeOptions` / `OptimizeReport`, orchestrator |
| `src/glyphusage.ts` | Raw-code content scan → per-font used-GID sets + completeness |
| `src/fontshrink.ts` | Sparse font-program shrink (glyf blank, CFF blank, table drop) |
| `src/dedup.ts` | Byte-identical indirect-stream merge |
| `src/recompress.ts` | Flate unfiltered streams; re-deflate existing Flate at max level |

### Pass order

Concerns run **fonts → dedup → compress**, and the order is load-bearing:

1. **fonts** rewrites font programs, producing new stream payloads.
2. **dedup** then merges duplicates *including* font programs that shrinking just
   made byte-identical (common: the same face embedded once per page).
3. **compress** re-deflates the final payloads.

Running compress before dedup would spend work on bytes dedup then discards;
running dedup before fonts would miss the newly-identical shrunk programs.

## Concern 1: Fonts

### Key constraint: the live-content contract

This is the inverse of the `AddFont` situation. `subsetGlyf` (src/subset.ts) is
free to renumber GIDs because it runs at `Save` on a font nothing references yet
— `EmbeddedFont.encode` emits draw-time codes and the subsetter picks the
numbering to match.

Here the content streams **already exist**. Their codes resolve to glyphs through
`/Encoding` + `cmap` (simple fonts) or through CIDs (Type0). Renumbering means
rewriting those mappings across a document we did not author, and a mistake
silently renders blank or wrong glyphs — a failure that looks fine until someone
reads the page.

### Approach: sparse blanking

Keep `numGlyphs`, GID numbering, `cmap`, `/Widths`, `/W`, `/Encoding`, and
`CIDToGIDMap` **untouched**. Drop only the outline bytes of unused glyphs, and
drop tables that rendering already-positioned text does not need.

Because no mapping is rewritten, there is no path from a subsetting bug to
corrupted text: a mis-identified glyph yields a blank outline, never a wrong
character or a broken font. The dominant size win (outlines + layout tables) is
captured anyway.

- **glyf**: unused glyph entries become zero-length; `loca` is rebuilt at the
  same entry count (`numGlyphs + 1`).
- **CFF** (`FontFile3` `/CIDFontType0C`, and `/OpenType` whole-embeds): unused
  charstrings are replaced with a bare `endchar`; charset and `numGlyphs` intact.
- **Tables dropped**: `GSUB GPOS GDEF BASE JSTF DSIG kern hdmx VDMX LTSH PCLT
  gasp EBDT EBLC CBDT CBLC sbix SVG MATH`. These are layout/hinting/bitmap
  tables irrelevant to text already positioned in a content stream, and are often
  a bigger win than the outlines.
- **`post` was kept as-is in `doo`.** Downgrading to version 3 drops glyph names
  (~40KB on a large face). Deferred rather than risked. Taken up by `gfs`, which
  drops them only for programs reachable exclusively from Type0 dicts — see
  `docs/superpowers/specs/2026-07-15-post-v3-downgrade-design.md`.
- **Every non-Type0 font — simple TrueType, Type1 (`FontFile`), Type3, and
  simple CFF/Type1C**: skipped, reported. The exclusion is not a gap in the
  shrinker but in the usage scan: each has its own heuristic code→GID chain, and
  a wrong guess silently blanks a glyph that is actually shown. Type0/Identity-H
  is the only path where resolution is exact.

  > **Superseded by `4by`.** Simple TrueType and simple CFF are now subset too —
  > see `2026-07-15-simple-font-subsetting-design.md`. Only Type1 (`FontFile`
  > PFB), Type3, and OpenType-CFF whole-embeds remain skipped. That spec also
  > corrects the claim below: the shrinker did *not* already handle both outline
  > formats. `shrinkCff` emits a CID-keyed program, which is invalid under a
  > simple font dict, so simple CFF needed a name-keyed shrink path of its own
  > (`shrinkNameKeyedCff`).

The CFF blanking path therefore serves **Type0/CIDFontType0**; the glyf blanking
path serves **Type0/CIDFontType2**.

`assembleSfnt` (src/subset.ts:60) is currently module-local and hardcodes the
`0x00010000` TrueType sfnt tag. It gets exported and taught the `OTTO` tag. This
is the only pre-existing code this concern modifies.

### Glyph usage scan

Subsetting needs **used GIDs per font dict**. The existing `visitContent`
(src/text.ts) cannot supply them: `GlyphEvent` exposes decoded `text`, not raw
codes, and carries no reference to the owning font dict; `TextFont` (src/font.ts)
maps code→Unicode and never exposes code→GID.

So `glyphusage.ts` is a new scanner over the `content.ts` tokenizer. It tracks
`Tf` against the active scope's resource `/Font` dict and collects raw codes from
`Tj`, `TJ`, `'`, and `"`.

```ts
type UsageMap = Map<PdfDict /* font dict */, { gids: Set<number>; complete: boolean }>;
```

**Sites walked** — a font missed here is a font whose glyphs we could wrongly
blank, so the scan is deliberately wide: page `/Contents`; Form XObjects
(recursive, depth-capped at 8 per the existing `MAX_XOBJECT_DEPTH` precedent);
annotation `/AP` `/N`, `/D`, `/R` streams with their own `/Resources`;
tiling-pattern content streams; Type3 `/CharProcs`. Cycle-guarded by visited-dict
sets.

**Code→GID resolution**, exact paths only:

- **Type0 + Identity-H, CIDFontType2** — code (2 bytes) = CID; GID =
  `CIDToGIDMap[CID]`, or CID when `CIDToGIDMap` is `/Identity`.
- **Type0 + Identity-H, CIDFontType0** — GID = CFF charset lookup(CID).

### Skip policy

A font is skipped (and reported with a reason) whenever its usage cannot be
fully accounted for. `complete: false` when:

- any content stream in a scope fails to parse — this marks every font in **that
  scope's** `/Font` dict incomplete, which is the correct granularity since a
  broken stream could have shown any of them;
- a Type0 font uses a non-Identity-H encoding (variable code width);
- the font is not Type0/Identity-H (simple TrueType, Type1, Type3, simple CFF);
- a font dict is reachable from a `/Font` resource dict the scan never walked.

That last rule is the safety net that makes the policy real rather than
aspirational: it catches usage sites this design did not anticipate, rather than
assuming the enumerated list is exhaustive. A glyph is blanked only when every
site that could reference it was scanned successfully.

## Concern 2: Dedup

Indirect **streams only**. The key is the canonical dict (keys **sorted** — two
semantically equal dicts can differ in `Map` insertion order) plus a SHA-256 of
`raw`, via `node:crypto`. Single pass, no fixpoint.

**Exempt `/Type`**: `Page`, `Annot`, `OCG`, `Sig`, `XRef`, `ObjStm`, `Metadata`.
These are objects whose *identity* is meaningful even when their content is
identical — merging two OCGs collapses two layers into one.

The lowest object number wins; refs are rewritten across the live model; orphans
fall out of the existing `Save` mark-sweep with no extra work.

Restricting to streams is what makes this safe against `Document`'s own
bookkeeping: `pageObjNums` and `EmbeddedFont.objNum` both point at **dicts**, so
no stream merge can invalidate them. Streams are also where the bulk of real
duplication lives (images and font programs repeated per page).

## Concern 3: Compress

Two lossless model mutations, orthogonal to `Save({ compressed: true })` (xref
stream + ObjStm) and `Save({ streamFilter })`, which act at serialize time. They
compose.

- **Unfiltered stream** (empty `/Filter` chain) → `deflateSync` level 9, set
  `/Filter /FlateDecode`.
- **Stream whose filter chain is exactly `[FlateDecode]`** → `inflateSync(raw)`
  then `deflateSync(raw, level 9)`. Node's default level is 6, so this is a few
  percent for free. Multi-filter chains (e.g. `[ASCII85Decode, FlateDecode]`) are
  **skipped**: re-deflating an inner member would require rebuilding the whole
  chain, which is `streamFilter`'s job, not this pass's.

The re-deflate deliberately operates on **raw inflated bytes, not
`decodeStream`**. `decodeStream` applies any `/DecodeParms` predictor; re-
deflating its output while leaving `/DecodeParms` in the dict would silently
desync the two and corrupt the stream. Working on raw inflated bytes leaves the
predictor params untouched and correct.

**Skipped**: image-codec streams (re-wrapping DCT/JPX/JBIG2/CCITT only grows
them) and the `EXEMPT_TYPES` set (`XRef`, `ObjStm`, `Metadata`) that
`streamfilter.ts` already defines. A stream is replaced only when the result is
strictly smaller.

## API

```ts
doc.Optimize()                   // all three concerns, lossless
doc.Optimize({ fonts: false })   // opt out per concern

interface OptimizeOptions {
  fonts?: boolean;    // default true
  dedup?: boolean;    // default true
  compress?: boolean; // default true
}

interface OptimizeReport {
  fonts:    { baseFont: string; gidsKept: number; gidsDropped: number; bytesSaved: number }[];
  skipped:  { baseFont: string; reason: string }[];
  dedup:    { merged: number; bytesSaved: number };
  compress: { streams: number; bytesSaved: number };
  /** Estimated raw-delta sum. Not a file-size delta — see below. */
  bytesSaved: number;
}
```

All concerns default **on**: each is lossless, so the no-argument call is the
safe and expected one. Each is individually disableable.

`bytesSaved` is an **estimate**: the sum of per-stream raw byte deltas. True
before/after file size is not knowable inside `Optimize`, which mutates the model
— only `Save` produces bytes. The report documents this rather than implying a
precision it cannot have.

The `skipped` list is the feature's debuggability surface: when `Optimize`
under-delivers, that list is the answer, so it is part of the return value rather
than a log line.

### Signed documents

`Optimize` throws `UnsupportedFeatureError` when the document contains signature
fields. Optimization mutates the model, which invalidates any existing signature;
`Save` would then return `pendingSignedBytes` verbatim and silently discard every
optimization. Both outcomes are bad, and failing loudly is the honest one.

## Testing

TDD per house style, with synthetic fixtures built by the existing
`test/helpers/build-sfnt.ts` and `build-cff.ts` builders. Tests live in
`test/optimize.test.ts` (plus per-module tests).

The load-bearing test is **content preservation**: `GetText()` and
`GetTextFragments()` are byte-identical before and after `Optimize`, and the
`Save()` output re-opens cleanly. Everything else is a size win that only counts
if this holds.

Per-concern:

- unused GIDs are blanked while every used GID survives;
- a font used **only** from an annotation `/AP` stream keeps its glyphs (guards
  the scan-wide requirement);
- an unparseable content stream forces a skip with a reported reason (guards the
  skip policy);
- a Type0 with a non-Identity-H encoding is skipped;
- a simple TrueType font is skipped rather than subset;
- duplicate image streams merge to one; exempt types (two identical OCGs) do not;
- predictor-bearing Flate streams round-trip byte-identically through recompress;
- a signed document throws;
- `Optimize` is idempotent — a second run reports approximately zero savings.

## Follow-up issues

- **Image optimization** (needs a baseline JPEG encoder first): downsampling to a
  target DPI and recompression at a target quality.
- **Simple-font subsetting**: extend the usage scan to simple TrueType (PDF
  32000 9.6.6.4: symbolic → `cmap(3,0)`/`(1,0)` by code; nonsymbolic →
  `/Encoding` + `/Differences` → Unicode → `cmap(3,1)`) and simple CFF (code →
  glyph name → charset). The shrinker already handles both outline formats — only
  the scan's resolution chain is missing. Deferred because those chains are
  heuristic and their failure mode (a silently blanked glyph) is severe; they
  deserve their own fixtures and review.
- ~~**`post` table downgrade** to version 3 for fonts where glyph names are
  provably unused.~~ Done — `gfs`.
