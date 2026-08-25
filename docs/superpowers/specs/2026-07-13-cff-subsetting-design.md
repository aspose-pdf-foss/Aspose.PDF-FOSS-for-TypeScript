# CFF/Type2 Charstring Subsetting — Design

**Issue:** aspose-pdf-foss-for-ts-y18 · Font embedding: CFF subsetting
**Date:** 2026-07-13

## Problem

Embedded OpenType-CFF (`.otf`, `OTTO`) fonts are currently **whole-embedded**:
`buildEmbeddedFont` (src/fontembed.ts) puts the entire `font.raw` sfnt into
`FontFile3 /Subtype /OpenType` with `CIDToGIDMap /Identity`. Every glyph in the
source font ships, regardless of use. We want a real subsetter that renumbers
glyphs to the used set and prunes the CharStrings INDEX, charset, and subrs, then
rewrites a compact, valid CFF.

The `CffFont` class (src/cff.ts) already parses CFF (INDEX/DICT, charset,
FDSelect/FDArray) and interprets Type2 charstrings for **rendering**. There is no
CFF **writer** yet. This work adds one.

## Key constraint: the draw-time contract

Draw-time codes are baked into content streams as 2-byte Identity-H codes equal
to the **original GID** (`EmbeddedFont.encode`). The embedded font must therefore
map `original-GID-as-code → correct outline`.

For a `CIDFontType0` + `FontFile3` descendant, `CIDToGIDMap` is **ignored** by the
PDF spec — CID→GID resolution lives in the CFF program's own **charset**. So if we
renumber glyphs during subsetting, the output CFF must be **CID-keyed**, with a
charset mapping `subsetGID → originalGID` (as CID). The reader then resolves
`code (= origGID, treated as CID) → subsetGID` through that charset. Content
streams and `EmbeddedFont.encode` are unchanged.

This mirrors how the glyf path uses a `CIDToGIDMap` stream to decouple draw-time
GIDs from subset GIDs; for CFF the CFF charset plays that role.

## Approach: renumber + inline subrs

Renumber glyphs to the used set, prune the CharStrings INDEX and charset, and
handle subrs by **inlining** rather than renumbering. Emit a bare **CID-keyed**
subset CFF (`CIDFontType0C`). Non-CID sources are naturally re-keyed by GID.

**Why inline subrs instead of renumbering them?** Statically rewriting
`callsubr`/`callgsubr` operands requires walking each charstring past its
`hintmask`/`cntrmask` bytes, whose length is `⌈stemCount/8⌉`. Professionally
hinted CFF fonts routinely declare stem hints *inside* subrs ("hint
replacement"), and those subrs themselves contain `hintmask` whose byte length
depends on the caller's accumulated stem count — which varies per call site. A
single-pass static operand rewrite can silently misalign on exactly those fonts.

Inlining avoids the whole problem: for each used glyph, we expand its charstring
by splicing every called subr inline (recursively), copying `hintmask` bytes
verbatim while a shared running stem counter descends through the subr calls
(reusing the same stem-counting logic cff.ts's interpreter already uses). The
result is a self-contained charstring with **no** subr calls; the emitted CFF
carries **empty** global and local subr INDEXes. This "prunes subrs to the used
set" (to empty), preserves outlines and hinting exactly, and is correct on
hint-replacement fonts. The cost is somewhat larger charstrings (a shared subr is
duplicated across the few kept glyphs) — still far smaller than the whole font.

Two confirmed decisions:
- **Emit a bare `CIDFontType0C`** CFF program, not a re-wrapped OTTO sfnt.
- **Graceful fallback to whole-embed** on any exotic/malformed CFF the subsetter
  cannot handle (non-literal subr index, `seac`-form `endchar`, unsupported
  FDSelect format, out-of-range subr index, malformed DICT/INDEX).

## Components

### 1. `src/cffsubset.ts` (new)

Single entry point, shaped like `subsetGlyf`:

```ts
export function subsetCff(cff: Uint8Array, usedGids: Iterable<number>): {
  bytes: Uint8Array;            // bare subset CFF program (CIDFontType0C)
  gidMap: Map<number, number>;  // origGID -> subsetGID
}
```

It reuses cff.ts's low-level INDEX/DICT readers (exported from cff.ts to avoid
duplication) and adds a CFF **writer** plus a charstring **flattener**.

**Pipeline:**

1. **Parse** header; Name / Top / String / GlobalSubr INDEXes; Top DICT;
   CharStrings INDEX; and either (CID) FDArray / FDSelect / per-FD local subrs, or
   (non-CID) the single Private's local subrs. Global subrs are shared.
2. **Select glyphs.** Subset order = `{0} ∪ used`, sorted ascending; build
   `gidMap: origGID → subsetGID`. CFF has no composite glyphs, so no glyph closure
   is needed (simpler than glyf).
3. **Flatten** each retained glyph's charstring: expand `callsubr`/`callgsubr`
   inline (recursively), dropping the subr index literal and the call operator and
   splicing the subr body (minus its trailing `return`). A shared stem counter is
   carried through the recursion so `hintmask`/`cntrmask` byte lengths are read
   correctly; the stack depth is threaded across calls so a subr that returns
   values the caller consumes is handled. Depth is bounded (guards against
   pathological/looping subrs). `endchar` terminates the whole glyph; a `seac`-form
   `endchar` (≥4 pending operands) throws to the fallback.
4. **Emit** a CID-keyed CFF (`CIDFontType0C`):
   - Header (`1 0 4 1`).
   - Name INDEX (copied, or a generic name).
   - String INDEX = `[Adobe, Identity]` (SIDs 391, 392 for ROS).
   - **Empty** Global Subr INDEX.
   - Top DICT: `ROS` (12 30), `CharStrings` (17), `charset` (15), `FDArray`
     (12 36), `FDSelect` (12 37). (No `FontMatrix`: charstring coordinates are in
     font units regardless, and PDF advance scaling uses the sfnt `head`
     unitsPerEm, so omission is outline-neutral.)
   - CharStrings INDEX = the flattened retained glyphs, in subset order.
   - charset **format 0**: for subsetGID `1..n-1`, a 2-byte CID = origGID.
     (gid 0 ⇒ CID 0, implicit.)
   - FDSelect **format 3**: a single range covering all glyphs → FD 0.
   - FDArray: **one** Font DICT with `Private [0 0]` (no Private DICT body, no
     local subrs). Per-FD width defaults are irrelevant here: CFF advance widths
     are never used for `CIDFontType0` (PDF `/W` governs), and the interpreter
     discards any leading width operand, so a single FD-0 is correct and simplest.

**Offset bootstrapping.** Top DICT offset operands use the fixed 5-byte integer
form (`29 + int32`, as the existing `buildCidCff` test fixture does). Because the
Top DICT is constant-width and the FDArray is emitted last, the whole program
lays out in a single pass with no iterative offset convergence.

**Failure signalling.** `subsetCff` throws `PdfParseError` /
`UnsupportedFeatureError` on any structure it cannot faithfully flatten; the
caller catches this and falls back to whole-embed.

### 2. `src/fontembed.ts` wiring

The CFF (`else`) branch of `buildEmbeddedFont` becomes:

```ts
} else {
  descendantSubtype = 'CIDFontType0';
  cidToGidMap = name('Identity');           // resolution now via CFF charset
  try {
    const { bytes, gidMap } = subsetCff(font.table('CFF ')!, usedGids);
    baseTag = subsetTag(bytes);
    descriptor.set('FontFile3', alloc(flateStream(bytes, { Subtype: name('CIDFontType0C') })));
    cids = [...gidMap.keys()].sort((a, b) => a - b);
  } catch {
    // Exotic/malformed CFF: whole-embed the OTTO program, as before.
    baseTag = subsetTag(font.raw);
    descriptor.set('FontFile3', alloc(flateStream(font.raw, { Subtype: name('OpenType') })));
    cids = [...usedGids].filter(...).sort(...);
    if (!cids.includes(0)) cids.unshift(0);
  }
}
```

`/W` and `/ToUnicode` stay keyed by the original GID (unchanged). The draw-time
contract is untouched.

### 3. Tests

**`test/cffsubset.test.ts`** (new):
- New fixture `buildRichCff`: a non-CID CFF with decoy + live global and local
  subrs and several glyphs (exercises inlining of both subr kinds, non-CID→CID
  conversion, and pruning), alongside reused `buildMinimalCff`/`buildCidCff`.
- The subset `bytes` parse via `CffFont`.
- For each used glyph, `CffFont.glyphPath(subsetGID)` on the subset equals
  `glyphPath(origGID)` on the original (outline preserved through inlining and
  renumbering).
- `CffFont.cidToGid(origGID) === subsetGID` (charset correctness); the subset is
  CID-keyed; unused glyphs are gone; the emitted subr INDEXes are empty;
  `bytes.length < cff.length`.

**`test/fontembed.test.ts`** (additions):
- CFF branch now emits `CIDFontType0` + `FontFile3 /Subtype /CIDFontType0C` +
  `CIDToGIDMap /Identity`.
- Round-trip: a drawn glyph's original GID resolves through the emitted charset to
  the correct subset outline.
- Fallback path: a deliberately-broken CFF still yields a valid whole-embed
  (`/Subtype /OpenType`).

Round-trip render/extract coverage satisfies "text still extracts/renders".

### 4. Docs

- README font-embedding note: CFF fonts are now **subset**, not whole-embedded.
- Update the `buildEmbeddedFont` header comment in fontembed.ts.

## Out of scope

- Re-wrapping the subset CFF back into an OTTO sfnt (we emit bare CFF).
- Preserving/renumbering subrs (we inline and drop them).
- Preserving multiple FDs or per-FD Private DICTs (we collapse to a single FD;
  outline-neutral for `CIDFontType0`).
- Subsetting CFF2 / variable fonts.
- Recomputing charstring geometry or hint optimization — charstring bytes are
  copied verbatim apart from inline subr expansion.

## Acceptance criteria (from the issue)

Embedded `.otf` CFF fonts are subset to used glyphs with valid CFF output; size
reduction verified; text still extracts/renders; vitest; README.
