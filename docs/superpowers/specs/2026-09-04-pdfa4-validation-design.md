# PDF/A-4 validation (`72nc.1`)

## The gap this closes

`PdfALevel` stops at `'3a'`. PDF/A-4 (ISO 19005-4:2020) is the part new
archival mandates increasingly name, and PDF/A-4f's allowance for arbitrary
embedded files is why engineering and regulatory archives are moving to it.

The issue text predicted this "extends a table rather than building a
subsystem". That reading is **wrong in one important way** and the correction
is the reason this document exists: PDF/A-4 is a PDF 2.0-era standard whose
rule set is not a superset of parts 1–3. It *inverts* four rules we already
ship — a document that fails at `'2u'` can pass at `'4'` for the same reason.
Extending the table alone would report findings PDF/A-4 does not make.

The four inversions, each measured against the anchor below:

| we check today | PDF/A-4 |
|---|---|
| Type0 font must have `/ToUnicode` (level u/a) | **no presence requirement at all**; only a constraint on a ToUnicode CMap's contents *if* one exists |
| subset CID font must have `/CIDSet` | no `/CIDSet` or `/CharSet` rule exists |
| JavaScript actions and a `/Names /JavaScript` tree are prohibited | JavaScript is **permitted** — absent from the prohibited-action list |
| `/Info` fields must agree with XMP | `/Info` is near-banned: allowed only alongside a catalog `/PieceInfo`, and then may contain **only** `/ModDate` |

The `/ToUnicode` one contradicts the widespread "PDF/A-4 ≈ PDF/A-2u" folklore.
We follow the anchor and record the disagreement rather than splitting the
difference.

## Scope

**In:** validation for the three PDF/A-4 conformances — `'4'`, `'4e'`
(engineering) and `'4f'` (embedded files) — over the object model,
catalog, metadata, resources and content scans we already build.

**Out, and each deliberately:**

- **Conversion.** `72nc.2` owns it and depends on this issue. `pdfaconvert.ts`
  must *refuse* part 4 rather than fall through: running part-2-shaped
  remediation would write `pdfaid:conformance`, which PDF/A-4 forbids,
  producing a file that fails the validator this issue ships.
- **Backporting the ~15 new checks that also apply to parts 1–3.** Most of what
  PDF/A-4 adds here (`/Requirements`, `/NeedsRendering`, `/PresSteps`, `/TR`,
  `/HTO`, halftone types, `/Alternates`, `/OPI`, `BitsPerComponent`, filespec
  `/F`+`/UF`+`/AFRelationship`) is in the PDF/A-2 and -3 profiles too; our
  validator simply never had them. They are gated at part 4 here and tracked as
  their own issue. The reason is not tidiness: `ConvertToPdfA` re-runs
  `ValidatePdfA` and mirrors it into `unresolved`/`passed`, so adding a rule to
  parts 1–3 silently changes the outcome of a shipped feature.
- **A `'4a'` level.** It does not exist — see the invariant below.
- **Everything the original PDF/A design excluded**, unchanged: ICC profile
  internals, glyph presence and widths inside font programs, rendering-based
  checks, recursive PDF/A validation of embedded files, XMP extension schemas.

## The anchor

The rule set is transcribed from **veraPDF's published validation profiles** —
`veraPDF/veraPDF-validation-profiles`, `integration` branch,
`PDF_A/PDFA-4.xml`, `PDFA-4E.xml`, `PDFA-4F.xml`, fetched 2026-09-04. Base
PDF/A-4 carries 113 rules, each with an ISO 19005-4 clause reference.

This is the habit the repo already follows for its trickier arithmetic — cite
something outside our own code (32000-1, T.88's SLTP constants, UAX #9/#14,
Adobe TN #5014) rather than invent a reading.

### The ceiling, recorded here rather than discovered later

**There is no oracle that can run.** veraPDF is not installed on the dev
machine, and a validation profile is a *rule list*, not bytes — so unlike
`test/fixtures/pdfx/`, which holds Ghostscript output a separate implementation
produced, this is a **transcription** anchored on a document. It is the
`ccitt-tables.ts` and JBIG2-Annex-B class of work, not the differential class.

What the suite proves is that the implementation agrees with our reading of the
profile. It does **not** prove that either matches ISO 19005-4, and no test
here can. Vendoring real PDF/A-4 files and running veraPDF against our output is
a separate issue; until it exists, do not read a green suite as conformance
evidence.

## Design

### Types and dispatch

```ts
export type PdfALevel =
  | '1b' | '1a' | '2b' | '2u' | '2a' | '3b' | '3u' | '3a'
  | '4' | '4e' | '4f';

interface Conformance { part: 1 | 2 | 3 | 4; level: 'b' | 'u' | 'a' | '' | 'e' | 'f'; }
```

`parseLevel` needs exactly one change — `level[1] ?? ''`, since `'4'` has no
second character. `Number(level[0])` already yields 4. Every existing
`ctx.level === 'a'` and `=== 'b'` test then stays correct by construction
rather than by review, which is why this shape was chosen over a discriminated
union: the alternative would have forced an edit at each of those sites.

**Invariant: PDF/A-4 has no accessibility level.** The profile tree has no
`6.8 Logical structure` clause and no `4a` variant, so `'4a'` is
*unrepresentable* rather than merely unsupported, and `validatePdfA`'s PDF/UA
chain — gated on `lvl === 'a'` — provably cannot fire for part 4. Expect
"why doesn't PDF/A-4 check tagging" to be filed as a bug; it is the standard's
decision, not ours. Tagging is declared separately through PDF/UA.

### Structure: part 4 as a peer conformance in the one rule table

Rejected alternatives, both real:

- **A separate `RULES_A4` table.** Cleanest era separation, and no growing
  `part === 4` guards — but it duplicates the ~12 rules identical across eras
  (encryption, external stream, LZW, PostScript XObject, reference XObject,
  metadata presence, font embedding, font encoding, output intent, ICC `/N`,
  device colour, XFA). "Two copies is how they come to disagree" is the failure
  this codebase records more than any other.
- **Rule metadata** (`{ parts, run }`, filtered by the dispatcher). Most
  declarative, but it restructures 31 shipped rules to buy a property the
  one-line guard already delivers.

So each rule keeps one owner and states its own part-4 stance with the guard
idiom `pdfavalidate.ts` already speaks — `optionalContentRule`,
`transparencyRule` and `annotationOpacityRule` all open with
`if (ctx.part !== 1) return []`.

### The existing 31 rules

Eighteen are unchanged. Thirteen differ, and the four marked **silent** are the
inversions — the rule must *stop* firing, which is the half a test written
against part 4 alone cannot see:

| rule | part-4 stance | clause |
|---|---|---|
| `externalStreamRule` | widens: the stream dictionary must omit `/FFilter` and `/FDecodeParms` as well as `/F` | 6.1.6.1-2 |
| `versionRule` | no longer a ceiling: header **and** catalog `/Version` must both be `2.n`. A PDF 1.7 file is not PDF/A-4. | 6.1.2-1, 6.1.12-1 |
| `pdfaIdRule` | conformance **absent** for `'4'`, `E` for `'4e'`, `F` for `'4f'`; plus `pdfaid:rev` = `2020` | 6.7.3-2,3,5 |
| `xmpInfoConsistencyRule` | **silent** — superseded by the `/Info` restriction | 6.1.3-5 |
| `fontCidSetRule` | **silent** | — |
| `toUnicodeRule` | **silent** — a content rule replaces it | 6.2.10.7-1 |
| `actionsRule` | JavaScript **permitted**, so the `/Names /JavaScript` check goes silent too. Prohibited: Launch, Sound, Movie, ResetForm, ImportData, Hide, Rendition, Trans, SetOCGState, GoTo3DView, SetState, NoOp. `'4e'` re-permits SetOCGState and GoTo3DView. | 6.6.1-1 |
| `annotationSubtypeRule` | prohibited set adds FileAttachment; `'4e'` permits 3D and RichMedia | 6.3.1-1 |
| `annotationFlagsRule` | ToggleNoView (bit 9) joins the prohibited flags | 6.3.2-2 |
| `annotationAppearanceRule` | `/Projection` joins Popup and Link as exempt | 6.3.3-1 |
| `additionalActionsRule` | `/AA` keys restricted to E, X, D, U, Fo, Bl; Widget annotations exempt | 6.6.3-1 |
| `blendModeRule`, `imageInterpolateRule` | severity **error** at part 4 (both are *shall* clauses); warning at parts 2/3 as today | 6.2.9-1, 6.2.7.1-3 |

Also new at part 4: named actions are restricted to NextPage, PrevPage,
FirstPage and LastPage (6.6.1-2), which folds into `actionsRule`.

**One deliberate divergence from the anchor.** `psXObjectRule` has no
counterpart in the PDF/A-4 profile, because PDF 2.0 removed PostScript
XObjects outright. It keeps firing at part 4: it can only match a construct
PDF 2.0 does not define, so a hit is a genuine defect the profile happens not
to enumerate. Recorded so it reads as a decision rather than an oversight.

### The new part-4 rules

All decidable from scans we already build:

| rule | what it checks | clause |
|---|---|---|
| `InfoRestriction` | `/Info` only alongside catalog `/PieceInfo`; if present, contains **only** `/ModDate` | 6.1.3-4,5 |
| `ToUnicodeContent` | no U+0000, U+FEFF or U+FFFE among a ToUnicode CMap's values (read through `cmap.ts`, which already parses these) | 6.2.10.7-1 |
| `Permissions` | catalog `/Perms` holds only `/DocMDP` | 6.1.11-1 |
| `NeedsRendering` | catalog `/NeedsRendering` absent | 6.4.2-2 |
| `Requirements` | catalog `/Requirements` absent | 6.12-1 |
| `AlternatePresentations` | `/Names /AlternatePresentations` absent; page `/PresSteps` absent | 6.11-1,2 |
| `ExtGStateKeys` | no `/TR`, no `/HTO`; `/TR2` only `/Default` | 6.2.5-1,2,3 |
| `Halftone` | `/HalftoneType` is 1 or 5; no `/HalftoneName` | 6.2.5-4,5 |
| `ImageKeys` | no `/Alternates`, no `/OPI`; `BitsPerComponent` ∈ {1,2,4,8,16}; image-mask BPC = 1 | 6.2.7.1-1,2,4,5 |
| `FormXObjectOpi` | no `/OPI` on a Form XObject | 6.2.8.1-1 |
| `OutputIntentKeys` | no `/DestOutputProfileRef`; at most one PDF/A output intent | 6.2.3-3,4 |
| `TransparencyBlendingSpace` | with no document output intent, a page containing transparency needs a page-level intent or `/Group` with a `/CS` | 6.2.9-2 |
| `AppearanceKeys` | an `/AP` dictionary contains only `/N` | 6.3.3-2 |
| `WidgetAction` | a Widget annotation has no `/A` | 6.4.1-1 |
| `EmbeddedFileSpec` | filespec carries `/F`, `/UF` and `/AFRelationship`; the embedded stream carries a `/Subtype` MIME type | 6.9-1,2,4 |
| `EmbeddedFilesRequired` | `'4f'` **only**: catalog `/Names /EmbeddedFiles` must exist | 6.9-5 |
| `OcConfig` | an optional-content configuration has a `/Name`, and names are unique | 6.10-1,2 |

`'4f'` requiring at least one embedded file is worth noting: it is the single
place PDF/A-4f *demands* something rather than relaxing something.

**Unverifiable, and reported as a warning rather than passed over.** Clause
6.9-3 — "all of the embedded files shall be compliant with ISO 19005-1, 19005-2
or 19005-4" — applies to base `'4'` and needs recursive PDF/A validation of the
embedded bytes, which the original design excluded. Each embedded file draws a
`warning` saying its conformance was not verified. Silence would read as "we
checked and it is fine", which is the one answer that is certainly wrong.
`'4e'` and `'4f'` drop the rule entirely, so they draw nothing.

`OcConfig`'s third veraPDF test — `/Order` referencing every OCG (6.10-3) — is
left out for now; it needs a full walk of the OCG set against a nested order
array for a check no caller has asked for.

### Not covered

Extending the exclusion list the README already publishes, these PDF/A-4
clauses are **not** checked: ICC profile internals (6.2.3-1, 6.2.4.2-1..3);
glyph presence and width consistency inside font programs (6.2.10.4.1-2,
6.2.10.5) and `.notdef` references (6.2.10.9); JPEG 2000 codestream internals
(6.2.7.3-1..5); embedded CMap internals (6.2.10.3.3-2); byte-level file
structure — binary comment, xref EOL, hex-string syntax, `obj`/`endobj`
spacing, `/Length` accuracy, data after the final EOF, inline-image `/L`
(6.1.2-2, 6.1.3-3, 6.1.4, 6.1.5, 6.1.6.1-1, 6.1.8, 6.1.9-2); undefined content
operators and resource-reference completeness (6.2.2-1..3); UTF-8 validity of
names (6.1.7); ActualText private-use values (6.2.10.8); DeviceN and Separation
consistency (6.2.4.4); CMYK overprint (6.2.4.2-2,3).

About twenty covered against twenty-five not. The README's "necessary but not
sufficient" wording must keep saying so, now naming part 4.

## Testing

`test/helpers/build-pdfa-pdf.ts` gains a part-4 mode: a `%PDF-2.0` header, XMP
carrying `pdfaid:part 4` and `pdfaid:rev 2020` with conformance absent or `E`/`F`,
and `/Info` either omitted or paired with a catalog `/PieceInfo`. A new
`test/pdfa4-validate.test.ts` holds a clean part-4 baseline plus a case per rule.

**The inversions need cross-part pairs.** A Type0 font with no `/ToUnicode`
must report at `'2u'` *and stay silent at* `'4'`; a JavaScript `/OpenAction`
must report at `'2b'` and stay silent at `'4'`; a subset CID font with no
`/CIDSet` must report at `'2b'` and stay silent at `'4'`. A single-part
assertion provably cannot tell a rule that correctly went quiet from a rule
that was never wired up, which is exactly the failure mode this file is
otherwise most exposed to.

Each new rule is mutation-checked, per the repo's standing habit, and any that
proves to redden nothing is recorded as uncovered rather than quietly kept.

**The fence:** `test/pdfavalidate.test.ts` and `test/pdfaconvert.test.ts` must
stay green **unedited**. That is what makes "parts 1–3 did not move" evidence
rather than an assertion. A red one there is information, not a chore.

## Delivery

1. Types and dispatch: `PdfALevel`, `Conformance`, `parseLevel`, `Ctx`; part-4
   refusal in `pdfaconvert.ts`.
2. The eleven changed stances on existing rules, with their cross-part pairs.
3. The seventeen new part-4 rules, plus the unverifiable-embedded-file warning.
4. README, CLAUDE.md (`pdfavalidate.ts` entry: the inversions, the no-`a`-level
   invariant, the anchor and its ceiling), `CHANGELOG.md` under Added.
5. A bd issue for backporting the non-part-4-specific checks to parts 1–3.

## Acceptance

- `doc.ValidatePdfA('4' | '4e' | '4f')` returns a `ValidationReport` over the
  rules above; a clean part-4 fixture passes and each rule's fixture fails.
- The four inversions are each pinned by a cross-part pair.
- `test/pdfavalidate.test.ts` and `test/pdfaconvert.test.ts` pass unedited.
- `npm run typecheck` and `npm test` are green.
- README and CLAUDE.md state what part 4 covers, what it does not, and that the
  anchor is a transcription with no runnable oracle.
