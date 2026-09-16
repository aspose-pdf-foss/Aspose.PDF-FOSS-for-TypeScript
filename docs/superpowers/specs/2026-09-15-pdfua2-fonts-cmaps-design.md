# PDF/UA-2: font and CMap rules (`q7hc.4.3`)

## The gap this closes

`ValidatePdfUa(2)` answers the structure tree (`q7hc.4`, `q7hc.4.1`) and the
objects hanging off it (`q7hc.4.2`), and says nothing about the fonts that draw
the text. A page whose font is not embedded, whose glyphs have no `/ToUnicode`,
whose `/Widths` disagree with the font program, or which shows `.notdef`, passes
today — and every one of those is a document a screen reader cannot read.

This issue is ISO 14289-2 clause **8.4.5**, fonts and CMaps.

## The count is RIGHT this time

`q7hc.4.1` and `q7hc.4.2` each corrected an off-by-one in their issue's rule
count. Counted directly, `8.4 Text representation` holds 20 files, of which
`8.4.5 Fonts` is exactly **15** — the issue's figure. The other five (`8.4.3`
replacements, `8.4.4` natural language) belong to `q7hc.4.4`, whose 11 then
checks out as 3 + 2 + 1 + 2 + 2 + 1. The anchor's arithmetic is now consistent
end to end: 18 + 21 + 26 + 15 + 11 = **91**.

## The anchor

- `veraPDF/veraPDF-validation-profiles@integration`,
  `PDF_UA/2/8.4 Text representation for content/8.4.5 Fonts/**` — 15 files.
- `veraPDF/veraPDF-validation@integration`,
  `validation-model/src/main/java/org/verapdf/gf/model/impl/operator/textshow/GFGlyph.java`
  — the glyph model and, decisively, its CACHE KEY.

Fetched **2026-09-15**. A TRANSCRIPTION and not a runnable oracle — `72nc.1`'s
ceiling, unchanged across all four issues of this epic.

## The fifteen

| Clause | Rule name | Subject | Fires when |
|---|---|---|---|
| 8.4.5.3.1-1 | `CidSystemInfoMatch` | Type0 font | its CIDFont's registry/ordering differ from the CMap's, or its supplement exceeds the CMap's |
| 8.4.5.3.2-1 | `CidToGidMap` | CIDFont | an embedded CIDFontType2 with no `/CIDToGIDMap` |
| 8.4.5.4-1 | `CMapEmbedded` | font CMap | a CMap outside Table 116 that is not embedded |
| 8.4.5.4-2 | `CMapWModeMatch` | embedded CMap | the stream's `/WMode` differs from the CMap text's |
| 8.4.5.4-3 | `CMapReference` | referenced CMap | a `usecmap` naming a CMap outside Table 116 |
| 8.4.5.5.1-1 | `FontNotEmbedded` | font | a rendered font with no font program |
| 8.4.5.5.1-2 | `GlyphNotPresent` | glyph | the program defines no glyph for the code |
| 8.4.5.6-1 | `GlyphWidthMismatch` | glyph | dictionary and program widths differ by more than 1 |
| 8.4.5.7-1 | `TrueTypeNonSymbolicCmap` | TrueType program | non-symbolic with neither a (3,1) nor a (1,0) subtable |
| 8.4.5.7-2 | `TrueTypeNonSymbolicEncoding` | TrueType font | non-symbolic whose `/Encoding` is not MacRoman/WinAnsi, or whose `/Differences` are not Unicode-compliant |
| 8.4.5.7-3 | `TrueTypeSymbolicEncoding` | TrueType font | symbolic with any `/Encoding` |
| 8.4.5.7-4 | `TrueTypeSymbolicCmap` | TrueType program | symbolic with neither a (3,0) nor a (1,0) subtable |
| 8.4.5.8-1 | `ToUnicodeMissing` | glyph | the code maps to no Unicode |
| 8.4.5.8-2 | `ToUnicodeReserved` | glyph | its Unicode contains U+0000, U+FEFF or U+FFFE |
| 8.4.5.9-1 | `NotdefUsed` | glyph | a text-showing operator references `.notdef` |

**Two are `critical` in the profile** (8.4.5.8-1 and -2) where the rest are
`major`; both map to our `error`, since `ValidationIssue` has two severities and
`TabOrder`'s `minor` → `warning` is the only distinction we draw.

## Design

### The rules split three ways, and the split is what sizes the work

**Nine are per FONT or per FONT PROGRAM** (everything except the five glyph
rules and `CMapWModeMatch`). `validatectx.ts` already has `enumerateFonts`,
`descendantFont` and `hasFontProgram`, which `pdfavalidate.ts` and
`pdfxvalidate.ts` both consume — so these reuse an existing walk rather than
adding a third.

**Five are per GLYPH** — `GlyphNotPresent`, `GlyphWidthMismatch`,
`ToUnicodeMissing`, `ToUnicodeReserved`, `NotdefUsed`. These need a walk over
every glyph the document actually SHOWS, which is `visitContent`'s `glyph`
event.

**One is per embedded CMap stream** — `CMapWModeMatch`.

### `visitContent` must learn `/Tr`, and this is the issue's real work

Four of the five glyph rules carry `renderingMode == 3` as an exemption:
invisible text. That is not a corner — it is the OCR layer of every scanned PDF,
where the glyphs deliberately have no embedded program, no widths worth checking
and often no meaningful `.notdef` story. Without the exemption these rules fire
on exactly the population they are written to excuse.

**`visitContent` tracks no `/Tr` at all.** It is the only text-state operator
missing: `Tc`, `Tw`, `Tz`, `TL` and `Ts` are all there. `GlyphEvent` therefore
gains `renderMode?: number`.

**Invariant: absent means 0.** `GlyphEvent.color` sets the precedent — it is
absent for black, the PDF initial value, because "a key present on every glyph
would move every fixture that compares an event". Mode 0 is the initial value,
so `renderMode` is absent for it and every existing fixture is byte-identical by
construction.

**Invariant, and it is a DELIBERATE INCONSISTENCY inside one struct:**
`renderMode` IS saved and restored across `q`/`Q`; its five siblings are not.
`visitContent` builds its `TextState` once per walk and the `q` stack holds
`{ ctm, fill, conv }` alone, so `Tc`/`Tw`/`Tz`/`TL`/`Ts` persist across `Q`
contrary to ISO 32000-2 9.3.1. Fixing all six is a behaviour change to a shipped
extraction walker — those five affect glyph POSITIONING, so quads would move for
any document using `q`/`Q` around them, and that reaches `GetTextFragments`,
table detection and every export. Filed as **`g5x6`**.

Scoping only the new field correctly is not tidiness: an OCR tool that wraps its
invisible layer in `q … Q` would otherwise leave `renderMode` stuck at 3 and
silently EXEMPT the visible text that follows — a false negative on the exact
population the exemption serves.

**Note `pagerender.ts` does not share the defect.** `4gtd.1` records that its
render mode is graphics state and that its clone is a shallow spread, so `q`/`Q`
carry it. The two walkers are separate by design; this is a place where they
disagree, and `g5x6` is where that is settled.

### Glyphs are DEDUPED, and the key is transcribed

`GFGlyph.getGlyph` caches by
`(fontId, fontName, glyphCode, renderingMode, markedContent, structElem, isRealContent)`
— so veraPDF models a Glyph ONCE per unique combination, not once per
occurrence. A page with five thousand `e`s in one font yields one Glyph and at
most one finding.

We dedupe by **`(font, code, renderMode)`**, dropping the three key components we
cannot cheaply model. That is a deliberate narrowing, and it only ever MERGES
findings that veraPDF would separate — never splits one it would merge — so the
divergence is a smaller report, never a missed defect.

**Invariant: this is a correctness rule as much as a cost one.** Without it,
`GlyphWidthMismatch` loads the font program per glyph occurrence and a
hundred-page document pays for it; and the report becomes one finding per
character drawn, which is unreadable.

### Table 116 is 61 names, and our bundled set is 195

`CMapEmbedded` and `CMapReference` both turn on "is this CMap in ISO 32000-2
Table 116". The profile spells the list out: **61** names.

**Invariant: this is NOT `predefcmap.ts`'s set.** `cmapdata.ts` bundles **195**
predefined Adobe CMaps — every one Adobe published, including the deprecated
Japan2 collection — where Table 116 is the subset PDF 2.0 still sanctions.
Asking "do we have this CMap bundled" answers a different question from "does
PDF 2.0 sanction it", and the bundled set is the larger by a factor of three.
The constant carries an ASSERTED SIZE of 61, the rule `htmlforeign.ts` sets.

### What the existing machinery already answers

The issue's claim that "most of the machinery exists" holds, and it is worth
naming which piece answers which rule, because the alternative to each is a
second implementation:

- `glyphprogram.ts` — `isGlyphPresent` (8.4.5.5.1-2) and `programAdvance`
  (8.4.5.6-1). CLAUDE.md records that `programAdvance` **normalizes to 1/1000
  em**, which is exactly the space the 1-unit tolerance is stated in, so no
  scaling is needed and none must be added.
- `font.ts` — `/Widths`, `/MissingWidth`, `/W` and `/DW` for the dictionary
  side of 8.4.5.6-1, and `TextFont.textOf` for `/ToUnicode` (8.4.5.8).
- `cidcmap.ts` / `predefcmap.ts` — the encoding CMap and its
  registry/ordering/supplement for 8.4.5.3.1-1.
- `sfnt.ts` — `cmap` subtable presence for 8.4.5.7-1 and -4.

### `uafont.ts`

The 15 rules, in their own module beside `uaannot.ts`, both importing the shared
vocabulary from `uarule.ts`. Same split by subject, same reason: it is what keeps
`structvalidate.ts` the structure tree's rules and the three modules free of an
import cycle.

## Deliberate divergences, each recorded in source

**The glyph dedup key is narrower than veraPDF's** — see above. Merges, never
splits.

**`renderMode` is scoped correctly while its five siblings are not**, with
`g5x6` filed. Recorded so the inconsistency reads as a decision.

**Both `critical` rules map to `error`.** `ValidationIssue` has two severities.

**Nothing here is converted.** `ConvertToPdfUa` gains no pass: embedding a font,
synthesizing `/ToUnicode` and correcting `/Widths` are all things
`ConvertToPdfA` does under its own opt-in for its own reasons, and doing them
here would silently re-encode a document the caller asked only to validate.
Every rule lands in `unresolved`.

**No rule is widened to part 1**, `q7hc.4`'s criterion inherited.

## Testing

- **`test/pdfua2-font.test.ts`** — each of the 15 as a cross-part PAIR.
- **`test/text-render-mode-event.test.ts`** — `GlyphEvent.renderMode`: absent
  for mode 0, present otherwise, and RESTORED by `Q`. The last is the one that
  pins the `g5x6` decision, and it needs `q 3 Tr … Q` followed by visible text.
- **`test/helpers/build-font-pdf.ts`** — a tagged page drawing text in a font
  built to order: embedded or not, with `/Widths` that agree or disagree with
  the program, symbolic or not, with or without `/ToUnicode`.
- **The width rule is measured against a font whose `/Widths` deliberately
  disagrees with its program**, as the issue's acceptance criterion asks.

**Fixture traps, recorded in advance:**

- Every glyph rule exempts mode 3, so a fixture that draws its text invisibly
  measures NOTHING — it passes whatever the code does.
- The dedup means a fixture drawing the same character twice yields ONE finding;
  a test asserting two would be asserting the absence of the dedup.
- `GlyphWidthMismatch`'s tolerance is 1/1000 em, so a fixture must differ by
  MORE than 1 — a one-unit disagreement is conformant and measures nothing.
- 8.4.5.7-2's `/Differences` half needs differences that are NOT Unicode
  compliant; a font with a conformant `/Differences` exercises only the
  `/Encoding` half.
- The Standard-14 faces have no embedded program, so a fixture for
  `FontNotEmbedded` is trivially satisfied by any default text — and one for
  the glyph rules must EMBED a font, or `isGlyphPresent` has nothing to answer
  from.

## Acceptance

- Each of the 15 reports at part 2 and is silent at part 1, asserted as a pair.
- `GlyphEvent.renderMode` is absent for mode 0, so every existing fixture that
  compares a glyph event is untouched.
- A `3 Tr` inside `q`/`Q` does not exempt text after the `Q`.
- The Table 116 constant asserts its size (61).
- Part 1 is byte-identical; the four part-1 fences pass UNEDITED.
- `npm run typecheck`, `npm test` and `test/import-cycles.test.ts` green, the
  last with the same 15 pairs.
- CLAUDE.md's rule-count line reads 64 of 91 before this issue, 79 of 91 after.

## Out of scope

- The remaining 12 anchor rules — `q7hc.4.4` (11) and `q7hc.4.6` (1).
- Fixing the other five text-state fields — `g5x6`.
- Conversion of any rule here.
- Widening to part 1 — `q7hc.4.5`.
