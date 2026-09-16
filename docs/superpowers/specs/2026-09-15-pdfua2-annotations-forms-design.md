# PDF/UA-2: annotation and form rules (`q7hc.4.2`)

## The gap this closes

`ValidatePdfUa(2)` answers the structure tree (`q7hc.4`, `q7hc.4.1`) and says
nothing about the objects hanging off it. An invisible annotation that is not an
artifact, a `/Sound` annotation PDF/UA-2 prohibits outright, a widget with no
label and no `/Contents`, a page carrying annotations with no `/Tabs` — all pass
today.

This issue is ISO 14289-2 clauses **8.9 (annotations)** and **8.10 (forms)**.

## Two corrections to the issue's own text, both measured against the anchor

**The anchor has 91 rule files, not 90, and `8.9 Annotations` has 19, not 18.**
Counted directly: 5 + 1 + 30 + 20 + 1 + 2 + 2 + **19** + 7 + 3 + 1 = **91**. The
issue's list of 18 omits **8.9.4.2-1** — where an annotation has `/Contents` and
the directly enclosing structure element has `/Alt`, the two shall be identical.
It belongs here; nothing else claims it.

That also makes `q7hc.4.1`'s CLAUDE.md line wrong twice: it reads "38 of the
anchor's 90". The right figure is **39 of 91** — 38 counted the *new rule names*
`q7hc.4.1` added, while the rest of that sentence counts *profile files*, and
`8.2.5.28.2-1` is covered without being newly implemented. Corrected here.

**One rule is deferred**, so this issue ships **25 of the 26**. See below.

## The anchor

Three sources, `integration` branch, fetched **2026-09-15**:

- `veraPDF/veraPDF-validation-profiles`, `PDF_UA/2/8.9 Annotations/**` (19) and
  `PDF_UA/2/8.10 Forms/**` (7).
- `veraPDF/veraPDF-validation`,
  `validation-model/src/main/java/org/verapdf/gf/model/impl/pd/` —
  `GFPDAnnot.java` (the subtype dispatch, `isArtifact`, `structParentType`),
  `annotations/GFPDWidgetAnnot.java`, `annotations/GFPDMarkupAnnot.java`,
  `annotations/GFPDFileAttachmentAnnot.java`, `gfse/GFSEForm.java`,
  `tools/DictionaryKeysHelper.java`.
- `veraPDF/veraPDF-parser`, `TaggedPDFConstants.java`.

**A TRANSCRIPTION, not a runnable oracle** — `72nc.1`'s ceiling, unchanged. As
in `q7hc.4.1`, the profiles alone are not enough: `isArtifact`, `isFieldWidget`,
`containsLbl` and the rich-text reduction are bare identifiers there, and the
algorithm behind each is only in the Java.

## Twenty-five rules

Every rule opens `if (ctx.part !== 2) return [];`.

### Annotations (8.9) — 19

| Clause | Rule name | Fires when |
|---|---|---|
| 8.9.2.2-1 | `AnnotInvisible` | `/F` bit 1 (Invisible) set, in the tree, not an artifact |
| 8.9.2.2-2 | `AnnotNoView` | `/F` bit 6 (NoView) set without bit 9 (ToggleNoView), in the tree, not an artifact |
| 8.9.2.3-1 | `MarkupEnclosure` | a markup annotation whose enclosing element is not `Annot` |
| 8.9.2.3-2 | `MarkupRichText` | `/RC` present and its reduced text differs from `/Contents` |
| 8.9.2.4.7-1 | `StampDescription` | a `/Stamp` with neither `/Name` nor `/Contents` |
| 8.9.2.4.8-1 | `InkDescription` | an `/Ink` with no `/Contents` |
| 8.9.2.4.9-1 | `PopupInTree` | a `/Popup` that IS in the structure tree |
| 8.9.2.4.10-1 | `FileAttachmentRelationship` | `/FS` present and its filespec has no `/AFRelationship` |
| 8.9.2.4.11-1 | `SoundProhibited` | any `/Sound` |
| 8.9.2.4.11-2 | `MovieProhibited` | any `/Movie` |
| 8.9.2.4.12-1 | `ScreenDescription` | a `/Screen` with no `/Contents` |
| 8.9.2.4.13-1 | `ZeroSizeWidget` | a widget of zero width AND height, in the tree, not an artifact |
| 8.9.2.4.14-1 | `PrinterMarkArtifact` | a `/PrinterMark` in the tree, not an artifact |
| 8.9.2.4.15-1 | `TrapNetProhibited` | any `/TrapNet` |
| 8.9.2.4.16-1 | `WatermarkEnclosure` | a `/Watermark` in the tree, not an artifact, not enclosed by `Annot` |
| 8.9.2.4.19-1 | `ThreeDDescription` | a `/3D` with no `/Contents` |
| 8.9.2.4.19-2 | `RichMediaDescription` | a `/RichMedia` with no `/Contents` |
| 8.9.3.3-1 | `TabOrder` | a page with annotations whose `/Tabs` is not `A`, `W` or `S` (**warning**) |
| 8.9.4.2-1 | `AnnotAltMismatch` | `/Contents` and the enclosing element's `/Alt` both present and differing |

Nineteen, where the issue's own list has eighteen: the extra row is
`8.9.4.2-1`. The table is the anchor's, not the issue's. With the six form rules
below, 19 + 6 = the **25** this issue ships.

### Forms (8.10) — 6 shipped, 1 deferred

| Clause | Rule name | Fires when |
|---|---|---|
| 8.10.1-1 | `WidgetEnclosure` | a field widget in the tree, not an artifact, not enclosed by `Form` |
| 8.10.1-2 | `FormWidgetCount` | a `Form` element holding more than one widget `/OBJR` |
| 8.10.1-3 | `XfaPresent` | `/AcroForm /XFA` present |
| 8.10.2.3-1 | `WidgetDescription` | a field widget with neither an `Lbl` sibling nor `/Contents` |
| 8.10.2.3-2 | `WidgetActionDescription` | a field widget with `/AA` and no `/Contents` |
| 8.10.3.3-1 | `TextFieldRichValue` | `/RV` present without `/V`, or their texts differ |
| ~~8.10.3.5-1~~ | — | **deferred to `q7hc.4.6`** |

**8.10.3.5-1 is deferred**, and it is the only rule of the two clauses that
cannot be transcribed faithfully with the models we have. veraPDF states it over
`SEGraphicContentItem` — a graphic CONTENT ITEM whose `isSignature` comes from
the grouped content it sits in. `visitFormContent` gives us *annotation*
granularity, not content-item granularity, so any version we shipped now would
be an approximation. Filed rather than approximated silently.

**Note `XfaPresent` overlaps `xfaconvert.ts`**, and the useful order is
documented rather than automated: `ConvertXfaToAcroForm()` converts the fields
and removes `/XFA`, so running it first satisfies this rule for free. The
converter is not called from the validator, and `ConvertToPdfUa` gains no XFA
pass — conversion there would be a field-authoring decision.

## Design

### `uarule.ts` — the shared rule vocabulary, extracted

A near-leaf holding `PdfUaPart`, `UaCtx`, `Rule` and `uaClause`, which
`structvalidate.ts` owns today.

**Invariant, and it is forced rather than tidy.** `structvalidate.ts` must
import the new rules by VALUE to append them to `RULES`, and the new module must
import `uaClause` by VALUE to cite its clauses — which is a 2-cycle, and
`test/import-cycles.test.ts` asserts the exact set of those. Extracting the
shared vocabulary to a leaf both import is the move `structtype.ts` and
`numbertree.ts` each already made, for exactly this reason. `structvalidate.ts`
re-exports `PdfUaPart` so every existing import path is unchanged.

### `uaannot.ts` — the 25 rules

**Invariant: ONE walk, ONE per-annotation record.** Twenty-two of the 25 rules read
the same three facts, so they are computed once per annotation and the rules
read the record:

```ts
interface AnnotCtx {
  annot: Annotation;
  page: Page;
  subtype: string;
  flags: number;              // /F, 0 when absent
  contents?: string;          // /Contents
  /** The structure element enclosing it — /StructParent through the
   *  ParentTree, which is `getParentDictionary`. */
  parent?: StructElement;
  /** An `Artifact` element ANYWHERE up the ancestor chain. */
  isArtifact: boolean;
}
```

**Invariant, and the obvious reading is wrong: `isArtifact` walks the WHOLE
ANCESTOR CHAIN**, not the direct parent (`GFPDAnnot.getisArtifact`). Eight rules
read it, and checking only the parent passes an annotation nested two deep in an
artifact subtree — silently, since such a document renders identically.

**Invariant: "in the structure tree" means `/StructParent` RESOLVES.** Every
artifact rule carries `structParentType == null` as a pass, so an annotation
outside the tree is exempt. That reads wrong — it is `8.2.5.20-1`'s shape from
`q7hc.4.1`, and it is what the anchor says.

**Note the guard that needs it is a CONJUNCTION**, which `q7hc.4.1` measured for
the link rules: the `/StructParent`-is-a-number test and the
`element === undefined` test are redundant defences, so breaking either alone
proves nothing. The same pair appears here and is recorded, not deduplicated.

### The markup set is SIXTEEN subtypes, and it is not ISO's

`PDMarkupAnnot` in veraPDF is the 13 subtypes of the dispatch's default branch —
`Caret`, `Circle`, `FreeText`, `Highlight`, `Line`, `Polygon`, `PolyLine`,
`Redact`, `StrikeOut`, `Square`, `Squiggly`, `Text`, `Underline` — **plus
`FileAttachment`, `Ink` and `Stamp`**, whose classes EXTEND `GFPDMarkupAnnot`.

**Invariant: this is NOT ISO 32000-2 Table 171's markup list and must not be
"fixed" into it.** Table 171 counts `Sound` and `Movie` as markup; veraPDF's
model does not, and the profile's `object="PDMarkupAnnot"` resolves against the
model. Nor is it `annotation.ts`'s `MARKUP_SUBTYPES`, which is the narrow
text-markup family (highlight/underline/strikeout/squiggly) behind
`MarkupAnnotation.MarkupType` — a third, smaller set with a confusingly similar
name. Three sets, one word; the constant carries an ASSERTED SIZE of 16, the
rule `htmlforeign.ts` sets for its five tables.

### `richtext.ts` gains a mode, and does not gain a twin

Two rules compare rich text against plain text. veraPDF reduces by
CONCATENATING every text node — no block separators, no whitespace collapsing
(`DictionaryKeysHelper.getAllNodeText`) — so `<p>a</p><p>b</p>` becomes `ab`.
`reduceRichText` does the opposite ON PURPOSE: CLAUDE.md records that it inserts
a block sentinel precisely so that does not happen, because concatenating makes
a search for `ab` match text that never appeared.

`reduceRichText(markup, { separateBlocks = true })` serves both. The default is
unchanged, so `annotsearch.ts` and every existing caller are byte-identical by
construction.

**Invariant: the two behaviours answer DIFFERENT QUESTIONS and the option name
says which.** `separateBlocks: true` answers "is this text present" — a search,
where running two blocks together invents a phrase. `false` answers "are these
two the same text" — an equivalence, where the anchor's answer is the one that
must be matched. A second module would be two tag walkers that drift; a second
question is a parameter.

### Where each rule's subject lives

- **Per annotation** (22): everything except the three below.
- **Per page** (1): `TabOrder`, over `page.Annotations.length > 0` and `/Tabs`.
  The one **warning**-severity rule here — the profile tags it `minor` where
  every other rule in both clauses is `major`.
- **Per structure element** (1): `FormWidgetCount`, counting `/OBJR` kids whose
  referenced dict is `/Subtype /Widget`.
- **Per document** (1): `XfaPresent`.

### `containsLbl`, and the empty-label trap

`GFPDWidgetAnnot.getcontainsLbl` looks among the ENCLOSING element's struct
children for an `Lbl` **whose own `/K` is non-empty**. An empty `Lbl` does not
count — a label element with nothing in it labels nothing. Transcribed; a first
reading tests only the type.

**Note it uses PLAIN children, not `significantChildren`.** `q7hc.4.1`'s
pass-through splicing (`NonStruct`/`Div`/`Part`) is `getStructuralSignificanceChildren`,
a different method, and veraPDF calls the plain one here. Do not "unify" them.

### `isFieldWidget`

A widget is a FIELD widget when its dict is itself a field (a merged field/widget,
carrying `/FT`) **or** it has a `/Parent`. A standalone widget belonging to no
field is exempt from 8.10.1-1 and both 8.10.2.3 rules.

## Deliberate divergences, each recorded in source

**The markup set is veraPDF's, not ISO's** — see above. A hit or a miss here is
a divergence from ISO 32000-2 Table 171 and an agreement with the anchor.

**`TabOrder` is a warning.** The profile tags it `minor`; every other rule in
8.9/8.10 is `major`. Our `severity` mirrors that, so a document with only this
defect still reports `Passed`.

**Nothing here is converted.** `ConvertToPdfUa` gains no pass: an absent
`/Contents`, a missing `Lbl`, a prohibited `/Sound` and an XFA packet are all
authoring or destructive decisions, and the two that could be automated
(`/Tabs`, `/AFRelationship`) are not worth a pass on their own. Every rule lands
in `unresolved`. Stated so the absence reads as a decision.

**No rule is widened to part 1**, `q7hc.4`'s criterion inherited.

## Testing

- **`test/pdfua2-annot.test.ts`** — each of the 25 rules as a cross-part PAIR:
  reports at part 2, silent at part 1. A single-part assertion cannot tell a
  rule that correctly went quiet from one never wired up.
- **The three prohibited-subtype rules are pinned from BOTH directions**, as the
  issue's acceptance criterion asks: a `/Sound` reports and a `/Text` in the
  same position does not, so the rule is not simply firing on every annotation.
- **`test/helpers/build-annot-pdf.ts`** — a tagged page carrying annotations of
  a named subtype, flags, `/Contents`, and a chosen enclosing element, so the
  22 per-annotation rules share one builder.
- **`test/richtext.test.ts`** grows the mode, and its EXISTING cases are the
  fence that the default did not move.

**Fixture traps, recorded in advance:**

- `isArtifact`'s ancestor walk needs an annotation nested at least TWO levels
  inside the `Artifact` element; a direct-parent fixture passes under both
  readings.
- Every artifact rule exempts an annotation outside the tree, so a fixture that
  forgets to tag the annotation measures NOTHING — it passes whatever the code
  does.
- `containsLbl`'s empty-`Lbl` rule needs an `Lbl` WITH children and one without;
  one fixture alone cannot see it.
- The rich-text mode needs MULTI-BLOCK markup. Single-`<p>` rich text — which is
  what Acrobat writes — reduces identically under both modes, so the obvious
  fixture cannot tell them apart.
- `isFieldWidget` needs a STANDALONE widget (no `/FT`, no `/Parent`) to show the
  exemption; every widget our own form API creates is a field widget.

## Acceptance

- Each of the 25 rules reports at part 2 and is silent at part 1, asserted as a
  pair; the three prohibited-subtype rules are pinned from both directions.
- `8.10.3.5-1` is absent and `q7hc.4.6` is filed, so the gap is a decision.
- The markup set asserts its size (16).
- `reduceRichText`'s default is unchanged — `test/richtext.test.ts` and
  `test/annot-search.test.ts` pass UNEDITED.
- Part 1 is byte-identical; the four part-1 fences pass UNEDITED.
- `npm run typecheck`, `npm test` and `test/import-cycles.test.ts` green, the
  last with the same 15 pairs — `uarule.ts` is what keeps it there.
- CLAUDE.md's rule-count line reads 39 of 91 before this issue, 64 of 91 after.

## Out of scope

- `8.10.3.5-1` — `q7hc.4.6`.
- The remaining 26 anchor rules — `q7hc.4.3` (fonts and CMaps, 15) and
  `q7hc.4.4` (PUA, language, optional content, destinations, embedded files, 11).
- Conversion of any rule here.
- Widening to part 1 — `q7hc.4.5`.
