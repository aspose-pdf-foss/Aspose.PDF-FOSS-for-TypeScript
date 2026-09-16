# PDF/UA-2: PUA, language, optional content, destinations and embedded files (`q7hc.4.4`)

## The gap this closes

`ValidatePdfUa(2)` answers the structure tree (`q7hc.4`, `q7hc.4.1`), the objects
hanging off it (`q7hc.4.2`) and the fonts that draw the text (`q7hc.4.3`). What
is left is everything the reader needs that is not structure and not a font: a
glyph that maps to a private-use codepoint with nothing to say what it means, a
document that declares no language, an optional-content configuration with no
name, a link that lands on a page rather than on a piece of structure, and an
attachment with no description.

This issue is the remaining **11** rules — clauses **8.4.3**, **8.4.4**, **8.6**,
**8.7**, **8.8** and **8.14.1**. With them the epic covers **90 of 91**, leaving
only `8.10.3.5-1` (`q7hc.4.6`), which is stated over a grouped content-item model
this library does not have.

## The anchor

- `veraPDF/veraPDF-validation-profiles@integration`, `PDF_UA/2/**` — the 11 rule
  files listed below.
- `veraPDF/veraPDF-validation@integration` —
  `.../operator/textshow/PUAHelper.java` (the PUA ranges),
  `.../operator/markedcontent/MarkedContentHelper.java` (how `/ActualText` and
  `/Alt` are looked up), `.../pd/actions/GFPDGoToAction.java`.
- `veraPDF/veraPDF-parser@integration` — `.../pd/PDDestination.java` and
  `.../pd/actions/PDAction.java`, which between them define what a *structure
  destination* is.

Fetched **2026-09-16**. A TRANSCRIPTION and not a runnable oracle — `72nc.1`'s
ceiling, unchanged across all five issues of this epic. Every test expression
below is quoted from the profile rather than recalled.

## The count checks out

The profile tree holds **91** files under `PDF_UA/2/`, counted directly:
`8.2` 30, `8.4` 20, `8.9` 19, `8.10` 7, `8.11` 3, `8.7` 2, `8.8` 2, `5` 5,
`6` 1, `8.6` 1, `8.14` 1. `q7hc.4.3` took 15 of `8.4`'s 20; the other five are
`8.4.3` (3) and `8.4.4` (2). So this issue is 3 + 2 + 1 + 2 + 2 + 1 = **11**.

**Note the two UNITS, since CLAUDE.md records this epic mixing them twice
already.** Counted as profile FILES the epic closes exactly:
18 + 21 + 26 + 15 + 11 = 91. Counted as rules IMPLEMENTED it is
18 + 21 + 25 + 15 = 79 today — `q7hc.4.2` covered 25 of its clause's 26, because
`8.2.5.28.2-1` was already satisfied by `IllustrationAlt` — so this issue takes
the total to **90**, and `8.10.3.5-1` is the one file left.

## The eleven

| Clause | Rule name | Object | Profile test |
|---|---|---|---|
| 8.4.3-1 | `PuaWithoutReplacement` | `Glyph` | `isRealContent == false \|\| unicodePUA == false \|\| actualTextPresent == true \|\| altPresent == true` |
| 8.4.3-2 | `ActualTextPua` | `CosActualText` | `containsPUA == false` |
| 8.4.3-3 | `AltPua` | `CosAlt` | `containsPUA == false` |
| 8.4.4-1 | `CatalogLangMissing` | `PDDocument` | `containsLang == true` |
| 8.4.4-2 | `LangSyntax` | `CosLang` | `/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(unicodeValue)` |
| 8.6-1 | `TextStringPua` | `CosTextString` | `containsPUA == false` |
| 8.7-1 | `OcConfigName` | `PDOCConfig` | `gContainsConfigs == false \|\| (Name != null && Name.length() > 0)` |
| 8.7-2 | `OcConfigAs` | `PDOCConfig` | `AS == null` |
| 8.8-1 | `DestinationNotStructure` | `PDDestination` | `isStructDestination == true` |
| 8.8-2 | `GoToNotStructure` | `PDGoToAction` | `containsStructDestination == true` |
| 8.14.1-1 | `EmbeddedFileDesc` | `CosFileSpecification` | `containsDesc == true \|\| presentInEmbeddedFiles == false` |

## Three corrections to the issue text

Each was found by reading the profile rather than its prose, and each would have
been got wrong from recall.

**8.4.4-1 does not test for a non-empty value.** The profile's *description*
says "with a non-empty value"; its *test* is `containsLang == true` alone. An
empty `/Lang ()` passes 8.4.4-1 and is caught by 8.4.4-2 instead, whose regex
demands at least one letter. The pair gives the prose's answer and neither rule
alone does — so implementing 8.4.4-1 as "present and non-empty" would report one
defect twice, and diverge from what veraPDF says about that file.

**8.7-1 is conditional on `/Configs` existing.** `gContainsConfigs` is a
document-level variable over `PDOCProperties` (`containsConfigs`). A document
carrying only a `/D` and no `/Configs` array is exempt **entirely**. So
"including the default" means *when a `/Configs` array is present, `/D` is
examined too*, not *`/D` always needs a name*.

**PUA is three ranges, not one.** `PUAHelper` holds
`{0xE000, 0xF8FF, 0xF0000, 0xFFFFD, 0x100000, 0x10FFFD}` — the BMP private use
area plus planes 15 and 16. Note both plane bounds end at `FFFD` rather than
`FFFF`: the last two code points of each plane are noncharacters and are
deliberately outside. A single-range check silently passes every supplementary
PUA codepoint.

## What a structure destination actually is

This is the part the issue's one-line summary cannot convey, and it decides both
8.8 rules and the authoring change.

`PDDestination.getIsStructDestination()` resolves a NAME or STRING destination
through the catalog's `/Dests` dictionary or the `/Names /Dests` name tree
first — returning **false** when the name does not resolve — and then:

- a **dict** is a structure destination when it has an `/SD` key;
- an **array** is one when `at(0)` has an `/S` key — that is, when the first
  element is a **structure element** rather than a page. A structure element
  dictionary always carries `/S` (its type); a page never does.

`PDAction.containsStructureDestination()` is **not** the same test, and the
asymmetry is the finding:

- `/SD` present on the action → true;
- otherwise, if `/D` is a NAME or STRING, resolve it and apply the destination
  test above;
- **if `/D` is a direct ARRAY, it falls through to `false`** — even when that
  array *is* a structure destination.

So a GoTo action can satisfy 8.8-2 **only** through `/SD`, or through a named
destination. Writing a structure-destination array into an action's `/D`
provably cannot satisfy it.

## Scope decisions

Three were genuinely open. Each is recorded here so it reads as a decision.

**8.6-1 is a CURATED set of string entries.** veraPDF decides "intended to be
human readable" by which strings its model wraps as `CosTextString`; we have no
such model, and sweeping every string in the document would report on `/ID`, the
encryption `/O` and `/U`, and a signature's `/Contents` — binary values that are
not text at all, so every encrypted or signed file would report. The set is the
entries this library already models as human-readable: `/Info` `/Title`
`/Author` `/Subject` `/Keywords` `/Creator` `/Producer`; an outline item's
`/Title`; an annotation's `/Contents`, `/T` and `/Subj`; a form field's `/T`,
`/TU` and a string `/V`; a structure element's `/Alt`, `/ActualText`, `/E` and
`/T`; an optional-content configuration's `/Name` and `/Creator`; and a file
specification's `/Desc`. This matches the README's existing framing of these
validators as a curated, machine-checkable subset, and it CANNOT fire on a
binary string. The narrowing is stated in the module and in README.

**8.4.3-1's `/ActualText` and `/Alt` lookup is the profile's, not the obvious
one.** `MarkedContentHelper.containsStringKey` checks, in order: an *inherited*
string attribute on the marked-content stack (a BDC property list carrying the
key, inherited through nesting), then the structure element the glyph's `/MCID`
resolves to through the `/ParentTree` — and on that element it reads the key
**directly, not up the ancestor chain**, and requires a non-empty **string**.
It returns false when there is no marked content at all. So an `/Alt` on a
grandparent element does not excuse a PUA glyph, and untagged PUA content always
reports.

**`isRealContent` maps to "not an artifact".** `GlyphEvent` already carries
`artifact` and `artifactScope`, so the rule reads `!artifact`. This is the one
term below transcribed by inference rather than quotation — `isRealContent` is a
constructor parameter threaded down from the operator layer — and it is recorded
as such rather than presented as certain.

## Architecture

Three new modules. None throws; all are appended to `RULES`, each rule opening
`if (ctx.part !== 2) return [];` so part 1 stays byte-identical.

**`uaglyph.ts`** — the deduped glyph walk, MOVED out of `uafont.ts`. A near-leaf
over `text.js`, `types.js` and `uarule.js`'s types, importing neither rule
module. This is the extraction `colornames.ts`, `preformat.ts`, `bordersides.ts`,
`datauri.ts` and `langmatch.ts` each already made: two consumers need one thing
and neither may reach the other. `uafont.ts` re-exports nothing — its import
path changes internally only, and `test/pdfua2-font.test.ts` is the fence that
the move changed no behaviour.

**`uatext.ts`** — clauses 8.4.3, 8.4.4 and 8.6. Six rules: the PUA family and
language.

**`uadoc.ts`** — clauses 8.7, 8.8 and 8.14.1. Five rules: optional content,
destinations and embedded files.

### The dedup key, and why the walk moves rather than widens

`GFGlyph.getGlyph` caches by `(fontId, fontName, glyphCode, renderingMode,
markedContent, structElem, isRealContent)`. `q7hc.4.3` dropped the last three,
recording that doing so "only ever MERGES findings veraPDF would separate and
never splits one it would merge".

8.4.3-1 cannot accept that merge: the same PUA code drawn once under an element
carrying `/Alt` and once under an element carrying none must be distinguishable,
or a real defect is hidden behind a conformant sibling. That is a *missed
defect*, not a smaller report.

So the leaf yields the FINER granularity — keyed by
`(fontDict, code, renderMode, mcid, artifact)` — and **`uafont.ts` collapses
`mcid` and `artifact` away on its own side**, preserving its current report
exactly. Font findings do not change; the PUA rule gets the fidelity it needs.
`test/pdfua2-font.test.ts`'s dedup cases are the fence for that claim and must
pass unedited.

### What `text.ts` gains

`GlyphEvent` gains one optional field, following `renderMode`'s absent-by-default
discipline:

```ts
/** /ActualText, /Alt and /Lang inherited from the marked-content stack.
 *  Absent when no BDC in scope states any of them. */
mcProps?: { actualText?: string; alt?: string; lang?: string };
```

The walk already maintains `mcidStack` and `artifactStack`; this adds a third of
the same shape. It is needed because `MarkedContentEvent` fires **only** when an
`/MCID` resolves — a deliberate `q7hc.1` invariant that must not be widened, and
a BDC may carry `/ActualText` with no `/MCID` at all.

**A stated narrowing:** 8.4.4-2's property-list half therefore sees a `/Lang`
only on a BDC that encloses at least one glyph. A `/Lang` on a marked-content
sequence containing no text is not examined. Widening `marked` to fire without
an `/MCID` would break the invariant above; a second content walker would be the
duplication this repo repeatedly records as a defect. The narrowing is recorded
in the module rather than left to be discovered.

## The authoring change

Scoped deliberately to the half that is free. `encodeDest` (outline.ts) is the
ONE owner of destination encoding, with exactly four call sites:
`actions.ts:61` (a GoTo action's `/D`), `docaction.ts:55` (`/OpenAction`),
`document.ts:1492` (a named destination) and `outline.ts:297` (an outline item's
`/Dest`).

**Only the GoTo action changes.** It gains `/SD` **beside** its existing `/D`,
when the document is tagged and a structure element resolves for the target
page. An old viewer reads `/D` and navigates as before; a PDF 2.0 viewer reads
`/SD`. There is no compatibility loss, and 8.8-2 is satisfied for every link
this library authors.

**Outline items, `/OpenAction` and named destinations are left alone**, and keep
reporting 8.8-1. Their `/Dest` is tested directly as `at(0).knownKey('S')`, so
satisfying it means replacing the page reference with a structure element — a
destination a PDF 1.7 viewer cannot resolve. Trading navigation in every
existing viewer for a conformance line is the caller's decision, not the
library's default; the rule reports and `ConvertToPdfUa` leaves it in
`unresolved`, exactly as `FontNotEmbedded` does.

The target element is the first structure element, in tree order, whose content
lies on the target page. Tree order rather than content order because it is
deterministic and independent of how the page was drawn. When the document is
untagged, or no element resolves, no `/SD` is written and the output is
byte-identical — which is what keeps every existing fixture unmoved.

## Conversion

**No new passes.** 8.4.4-1 is the first rule in this epic that an EXISTING pass
already fixes: `ConvertToPdfUa` sets the catalog `/Lang` from `opts.lang`, so
`CatalogLangMissing` resolves for any caller supplying one. That is worth
asserting directly rather than assuming, since it is the only such case.

Everything else lands in `unresolved`. Synthesizing an optional-content `/Name`
or an attachment `/Desc` invents text the document does not contain; stripping
`/AS` is destructive, and `ocusage.ts` records that `/AS` is precisely what makes
a `/Usage` do anything, so removing it silently changes what the document
intends; and rewriting a destination is the trade-off declined above.

## Testing

Each rule gets a cross-part PAIR in `test/pdfua2-text.test.ts` and
`test/pdfua2-doc.test.ts` — reports at part 2, silent at part 1 — the shape
`q7hc.4.2` and `q7hc.4.3` both use, because a single-part assertion provably
cannot tell a rule that correctly went quiet from one never wired up.

A census, `test/pdfua2-misc-coverage.test.ts`, asserts the 11 names against
their clauses and that the PUA range table holds exactly three ranges — the
size-assertion rule `htmlforeign.ts` sets for its five tables.

Fixtures that need care, each because the obvious one measures nothing:

- **8.4.3-1** needs a font whose `/ToUnicode` maps a code INTO the PUA. A
  fixture drawing ordinary text cannot reach the rule at all.
- The same rule needs THREE cases to pin the lookup: covered by a BDC property
  list, covered by the MCID's own element, and covered by a GRANDPARENT element
  — the third must still REPORT, since the profile reads the direct element
  only.
- **8.7-1** needs a `/Configs` array present, or `gContainsConfigs` is false and
  the rule is silent whatever `/D` says. A fixture with only a `/D` measures
  nothing.
- **8.8-2** needs a GoTo action whose `/D` is a structure-destination ARRAY, to
  pin that this still reports — the asymmetry above is invisible to any fixture
  that only tests `/SD` present versus absent.
- **8.6-1** needs a PUA codepoint in a supplementary plane as well as the BMP,
  or the two-extra-ranges half of `PUAHelper` is unmeasured.
- **8.14.1-1** needs a filespec that is NOT in `/EmbeddedFiles` (a
  `/FileAttachment` annotation's `/FS`) to pin the `presentInEmbeddedFiles`
  escape.

Fences that must pass UNEDITED: `test/pdfua-part1-identity.test.ts`,
`test/pdfua2-validate.test.ts`, `test/pdfuaconvert.test.ts`,
`test/markdown-pdfua.test.ts` (part 1 is untouched), and
`test/pdfua2-font.test.ts` (the glyph-walk move and the dedup collapse changed
no font behaviour). `test/import-cycles.test.ts` must still report the same 15
pairs.

## Expected fallout

`test/pdfua2-convert.test.ts` will move, as it did for `q7hc.4.3`: its fixtures
draw text and carry no catalog `/Lang` in some cases, and any that author a link
will report `GoToNotStructure` until the authoring change lands. Each new entry
is recorded in that file's own style beside `HeadingNesting`, `LinkEnclosure`
and `FontNotEmbedded`, with the reason it is a true positive rather than a
regression.

## Out of scope

- `8.10.3.5-1` — `q7hc.4.6`, unchanged.
- Rewriting outline, `/OpenAction` or named destinations as structure
  destinations, for the compatibility reason stated above.
- Any conversion pass beyond the existing `/Lang` one.
