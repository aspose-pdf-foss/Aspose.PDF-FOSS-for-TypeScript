# Unicode Normalization for Shaping — Assessment

**Issue:** aspose-pdf-foss-for-ts-5pz (follow-up to complex-text shaping 8u0.2/8u0.3)
**Date:** 2026-07-10
**Outcome:** Deferred — no code shipped. Documented limitation; revisit on a concrete failing case.

## Question

Does the Phase-3 shaping pipeline (`src/shape.ts`) require a Unicode
normalization pass (NFC/NFD + Canonical_Combining_Class reordering) for correct
mark placement and ligature matching?

## Findings

`shapeText` maps raw code points → glyphs 1:1 via the font cmap, in **input
order**, then runs GSUB (`ccmp`, `liga`, `rlig`, `calt`) and GPOS (`kern`,
`mark`, `mkmk`). Consequences:

- **No CCC reordering** — combining marks supplied in non-canonical order stay
  in input order, so GPOS `mark`/`mkmk` stacking can be wrong.
- **No compose/decompose to match font coverage** — cmap lookup happens *before*
  `ccmp`, so:
  - Decomposed input (`e`+◌́) against a font whose cmap has only the precomposed
    `é` → the base maps and the mark maps (or drops) separately; correctness then
    depends entirely on the font's GPOS `mark` quality.
  - Precomposed input (`é`) against a font whose cmap has only decomposed glyphs
    → `é` is absent from the cmap and is **dropped**.

So normalization *would* improve correctness, but only in font-dependent edge
cases. In practice, application text is overwhelmingly **NFC**, and fonts'
`ccmp` + `mark` features handle the NFC case well.

## Decision

**Defer.** For a PDF authoring library the NFC-input common case is adequately
covered; the cost of a correct solution (new UCD decomposition + composition-
exclusion data, a conformance-tested `normalize.ts`, and font-aware
recomposition wired into the shaping path with original-code-point cluster
tracking for `/ToUnicode` fidelity) is not justified by current demand.

The README shaping caveats now state that input should be supplied in NFC form
and that decomposed marks are not canonically reordered.

## If revisited (recommended approach)

The correct-by-construction design (HarfBuzz-lite), preserved here so a future
implementer need not re-derive it:

1. **Data** — extend `scripts/gen-ucd.mjs` to emit canonical decompositions
   (field 5 of `UnicodeData.txt`, excluding the `<...>` compatibility mappings)
   and the composition-exclusion set (`CompositionExclusions.txt`), plus the
   already-generated `combiningClass`.
2. **Pure module** `src/normalize.ts` — `toNFD`/`toNFC` (recursive canonical
   decomposition → stable CCC sort → canonical composition honoring exclusions),
   verified against `NormalizationTest.txt` (mirrors the bidi/line-break
   conformance-fixture pattern).
3. **Shaping integration** — in `shapeText`, run a *font-aware* pass:
   decompose → CCC-reorder → recompose only where `sfnt.cmapLookup` has the
   precomposed glyph. Keep the cluster map keyed to the **original** input code
   points so `GetText`/`/ToUnicode` still round-trips to what the caller passed.

**Trigger to reopen:** a concrete font+string case where shaped output places or
drops marks incorrectly that NFC/NFD would fix.
