# PDF/A-4 conversion (`72nc.2`)

## The gap this closes

`72nc.1` shipped the validator and left `convertToPdfA` refusing part 4 with
`UnsupportedFeatureError`. This fills that in: `doc.ConvertToPdfA('4' | '4e' |
'4f')` remediates toward ISO 19005-4:2020 and reports what it could not fix.

The issue text says conversion "must stop removing attachments it removes for
1b..3a". That is **half wrong and worth correcting before anyone acts on it**:
`embeddedFilesPass` removes attachments at **part 1 only** — parts 2/3 already
just stamp `/AFRelationship`, so there is almost nothing to stop doing. The real
work at part 4 runs the *opposite* direction: PDF/A-4 newly requires a filespec
to carry `/UF` and the embedded stream to declare a `/Subtype` MIME type, so
conversion has to **add** two things rather than refrain from deleting one.

And 4f demands something conversion provably cannot supply — see below.

## Scope

**In:** remediation for `'4'`, `'4e'` and `'4f'`, plus the one public API
addition (`XmpMetadata.pdfaRev`) that writing PDF/A-4 identification needs.

**Out, and each deliberately:**

- **Any change to the part-1/2/3 passes' behaviour.** `test/pdfaconvert.test.ts`
  and `test/pdfavalidate.test.ts` must stay green **unedited**; that is the
  fence, exactly as in `72nc.1`.
- **Backporting `72nc.1`'s gated checks.** Tracked as its own issue (`3zpi`).
- **The signing path's hardcoded header.** `serializer.ts:208` emits
  `%PDF-1.7` unconditionally when serializing for a signature, so signing a
  PDF/A-4 document would silently breach its own version rule. Found while
  confirming that catalog `/Version` drives the header (it does, through
  `headerVersion`, for every non-signing path). Real, latent, and a signing bug
  rather than a conversion one — recorded here and filed separately.

## Design

### Types

`Cctx` widens to `part: 1 | 2 | 3 | 4` and
`level: 'b' | 'u' | 'a' | '' | 'e' | 'f'`. The `UnsupportedFeatureError` guard
and the `lvl as 'b' | 'u' | 'a'` cast that `72nc.1` left in `convertToPdfA`
both come out.

`ConvertCategory` gains exactly **one** member, `'info'`. Everything else new
here is either non-destructive normalisation (deleting `/OPI`, adding `/UF`) or
falls under a category that already exists.

### Structure

Part 4 joins the one `PASSES` array as a peer, gated with the
`if (ctx.part === N)` idiom `pdfaconvert.ts` already uses in
`embeddedFilesPass`, `optionalContentPass` and `annotationFlagsPass`. This is
`72nc.1`'s decision applied again rather than a fresh one: a second
`PASSES_A4` table would duplicate the ~8 passes identical across eras, and
"two copies is how they come to disagree" is this repo's most-recorded failure.

### Six existing passes change

Three of them do the **wrong thing** at part 4 today and would fight the
validator shipped in `72nc.1`:

| pass | part-4 change |
|---|---|
| `identificationPass` | conformance **absent** for `'4'` — today it computes `ctx.level.toUpperCase()`, which for `''` is `''`, writing `pdfaid:conformance=""` where the standard demands the key not exist — `E`/`F` for 4e/4f, plus `pdfaid:rev` = `2020` |
| `actionsPass` | JavaScript is **permitted** at part 4; use the part-4 prohibited set, with 4e re-permitting SetOCGState and GoTo3DView |
| `multimediaPass` | part-4 set adds FileAttachment; 4e **keeps** 3D and RichMedia |
| `versionPass` | writes `2.0` at part 4 rather than the 1.4/1.7 ceiling |
| `annotationFlagsPass` | also clears ToggleNoView (bit 9) at part 4 |
| `embeddedFilesPass` | at part 4 never removes; **adds** `/UF` (copied from `/F`), `/AFRelationship` (`/Unspecified`) and a `/Subtype` of `application/octet-stream` where absent |

**Note on that `/Subtype`, because it is silently wrong when done the obvious
way:** a MIME type is written as a PDF **name**, and `/` is a delimiter inside
one — so the value is the name whose text is `application/octet-stream`, which
serializes as `/application#2Foctet-stream`. Build it through `name()` with the
raw string and let the serializer escape it; writing the escaped form into
`name()` double-escapes, and writing a bare `/application/octet-stream` is not
one name. `test/helpers/build-pdfa-pdf.ts` already spells its fixture
`/text#2Fplain` for this reason.

### Six new part-4 passes

| pass | what it fixes |
|---|---|
| `infoPass` | reduces `/Info` to `/ModDate` alone — see the decision below |
| `pdfa4CatalogPass` | deletes `/NeedsRendering`, `/Requirements`, `/Names /AlternatePresentations`, page `/PresSteps`, and non-`/DocMDP` keys from `/Perms` |
| `pdfa4GraphicsPass` | deletes ExtGState `/TR` and `/HTO`, sets `/TR2` to `/Default`, deletes `/HalftoneName`, deletes image `/Alternates` and `/OPI` and Form XObject `/OPI` |
| `pdfa4OutputIntentPass` | deletes `/DestOutputProfileRef`; drops PDF/A output intents beyond the first |
| `pdfa4AnnotPass` | deletes `/AP` keys other than `/N`; deletes `/A` from Widget annotations |
| `ocConfigPass` | gives an optional-content configuration a `/Name` when it has none |

### The `/Info` decision, and why it is the centre of this issue

PDF/A-4 near-bans the document information dictionary: clause 6.1.3-4 permits
`/Info` only alongside a catalog `/PieceInfo`, and 6.1.3-5 then allows it to
hold nothing but `/ModDate`. Essentially every real document has an `/Info`
carrying a title, author, producer and dates — so **converting any document to
PDF/A-4 destroys it**.

`infoPass` reduces `/Info` to `/ModDate`, which is legal without a
`/PieceInfo`, and is gated on the new `'info'` category so
`preserve: ['info']` keeps the dictionary and reports `InfoRestriction`
unresolved instead. Deleting `/Info` outright was considered and rejected: it
discards `/ModDate` too, and some tooling still reads the dictionary.

**Invariant, and it is the ordering mistake this design exists to prevent:**
`identificationPass` must run **BEFORE** `infoPass`. It calls
`ctx.doc.GetMetadata()` — which reads `/Info` — to mirror title, author,
subject and keywords into XMP. Strip `/Info` first and that mirror silently
comes out empty, losing exactly the metadata the `'info'` decision was meant to
preserve. The failure is invisible in the converted file's conformance: it
passes validation either way.

### One pass deliberately absent

`TransparencyBlendingSpace` needs no remediation and gets none.
`outputIntentPass` adds a `GTS_PDFA1` output intent whenever the document lacks
one, and that rule fires **only** when there is no PDF/A output intent — so it
is unreachable after conversion by construction. Asserted directly in the suite
so it reads as reasoning rather than as a pass somebody forgot.

### What stays unresolved

Conversion re-runs `ValidatePdfA` and mirrors it into `unresolved`/`passed` —
the documented invariant — so these are reported rather than fixed:

- **`EmbeddedFilesRequired`** on a 4f document with no attachment. Clause 6.9-5
  requires a PDF/A-4f file to carry an embedded file, and conversion cannot
  synthesize one. All three levels are still accepted: remediating everything
  else and reporting the one impossible rule preserves the mirror invariant,
  where refusing up front would make 4f the only level that declines on
  document content.
- **`ImageKeys`** for a `BitsPerComponent` outside {1,2,4,8,16} — fixing it
  means re-encoding the image.
- **`Halftone`** for a type outside {1,5} — forcing it to 1 would change how
  the page prints.
- **`ToUnicodeContent`**, and this one is a deliberate YAGNI call rather than an
  inability. Because PDF/A-4 has **no** `/ToUnicode` presence requirement
  (`72nc.1`'s inversion), deleting the offending CMap outright would be legal
  and would make the document pass — but it destroys text extraction to fix a
  handful of bad code points. Reporting beats silently taking that trade.

### Public API

`XmpMetadata` gains `pdfaRev?: number`, parsed and written by `xmp.ts` beside
`pdfaPart` and `pdfaConformance`. Additive, and the only thing here outside
`pdfaconvert.ts` a consumer can see. It is needed because
`pdfaid:rev = "2020"` is mandatory for PDF/A-4 identification and `SetXmp`
cannot currently write it at all.

## Testing

Part-4 cases join `test/pdfaconvert.test.ts`, asserting the strongest property
available and the one the existing tests already use: convert, then
`ValidatePdfA(level).Passed === true`.

Beyond that:

- **The unresolved set is asserted explicitly** for 4f-without-attachment and
  for each non-remediable rule — a `Passed === false` assertion alone cannot
  tell which rule survived.
- **`preserve: ['info']`** leaves `/Info` intact *and* reports
  `InfoRestriction` unresolved. Both halves, since either alone passes with the
  category ignored.
- **The ordering invariant** is pinned by converting a document with an
  `/Info /Title` and asserting the XMP still carries that title afterwards.
  Note a fixture whose `/Info` is already absent measures nothing here.
- **The absent transparency pass** is pinned by converting a document with a
  `/Group /S /Transparency` and no output intent, and asserting
  `TransparencyBlendingSpace` is absent from the report.
- Every new pass is mutation-checked; any that reddens nothing is recorded as
  uncovered rather than quietly kept.

**The fence:** `test/pdfaconvert.test.ts`'s existing 21 cases and
`test/pdfavalidate.test.ts`'s 42 must stay green **unedited**.

## The oracle

Unchanged from `72nc.1` and worth restating: there is **none that runs here**.
veraPDF is not installed, so conversion is verified against *our own validator*
— which is itself a transcription of veraPDF's published profiles. A passing
conversion therefore attests that the remediation satisfies our reading of
those profiles, not that either matches ISO 19005-4.

That circularity is sharper for conversion than it was for validation: the two
halves now agree with each other by construction. Do not read a green suite as
evidence that a converted file would pass a certified validator.

## Delivery

1. Types: `Cctx`, `ConvertCategory`, remove the part-4 refusal.
2. `XmpMetadata.pdfaRev` in `xmp.ts`, with round-trip tests.
3. The six changed passes, with their cross-part assertions.
4. The six new part-4 passes.
5. The unresolved cases and the two "absent by construction" assertions.
6. README, CLAUDE.md, `CHANGELOG.md`.
7. A bd issue for the signing path's hardcoded `%PDF-1.7` header.

## Acceptance

- `doc.ConvertToPdfA('4' | '4e' | '4f')` returns a `ConversionReport`; a
  remediable fixture converts to `Passed === true` at each level.
- A 4f document with no attachment reports `EmbeddedFilesRequired` unresolved
  and remediates everything else.
- `preserve: ['info']` keeps `/Info` and reports it unresolved.
- XMP still carries the title after `/Info` is stripped.
- `test/pdfaconvert.test.ts` and `test/pdfavalidate.test.ts` pass unedited.
- `npm run typecheck` and `npm test` green.
- README and CLAUDE.md record the `/Info` decision, the ordering invariant, the
  unresolved set and the circular-oracle caveat.
