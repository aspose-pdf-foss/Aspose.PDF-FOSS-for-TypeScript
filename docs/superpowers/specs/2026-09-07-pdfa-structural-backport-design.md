# Backporting the PDF/A-4 structural checks to parts 1-3 (`pjy7`)

## The gap this closes

`72nc.1` shipped sixteen PDF/A-4 rules gated at `ctx.part === 4`. The gating was
deliberate rather than tidy: `ConvertToPdfA` re-runs `ValidatePdfA` and mirrors
it into `unresolved`/`passed`, so widening a rule silently changes the outcome of
a shipped feature. Nine of those rules are carried by the PDF/A-1, -2 and -3
profiles too, so a document that violates them is reported at `'4'` and passed at
`'2b'` today — the validator is quietly more lenient about older, stricter parts
than about the newest one.

This widens those nine, and widens `ConvertToPdfA`'s matching passes with them,
so a conversion that reports clean today mostly keeps doing so.

## The anchor, and it was checked rather than remembered

veraPDF's published profiles — `veraPDF/veraPDF-validation-profiles`,
`integration` branch, `PDF_A/PDFA-1B.xml`, `PDFA-2B.xml`, `PDFA-3B.xml`,
`PDFA-4.xml`, fetched 2026-09-07. Every row below was read out of those files
and the decisive tests are quoted verbatim in the matrix.

**Note, and it is why the tests are quoted rather than summarised:** the first
pass over `PDFA-2B` reported "no Form XObject `/OPI` rule", because the image
rules sit at clause 6.2.8 and the form rule sits at 6.2.9 bundled with the
PostScript test. A second, targeted read found it. One more summary claimed
PDF/A-3 carries embedded-file rules; it does not — the strings `Filespec`,
`EmbeddedFile` and `AFRelationship` appear nowhere in `PDFA-3B.xml`. Read the
profile for the rule you are about to change; do not trust a digest of it,
this one's included.

## The matrix

Nine rules backport. `✓` means the profile carries the test; `—` means it does
not, and the rule stays gated.

| Our rule | 1B | 2B / 3B | Per-part divergence |
|---|---|---|---|
| `extGStateKeysRule` `/TR`, `/TR2` | ✓ 6.2.8-1/-2 | ✓ 6.2.5-1/-2 | `/HTO` is a PDF 2.0 key and stays part-4-only |
| `halftoneRule` type + `/HalftoneName` | — | ✓ 6.2.5-4/-5 | absent at part 1 |
| `imageKeysRule` `/Alternates`, `/OPI` | ✓ 6.2.4-1/-2 | ✓ 6.2.8-1/-2 | — |
| `imageKeysRule` `BitsPerComponent` | ✓ **{1,2,4,8}** | ✓ {1,2,4,8,16} | **16 is legal at 2/3/4 and illegal at 1** |
| `imageKeysRule` mask `BitsPerComponent == 1` | ✓ 6.2.4-5 | ✓ 6.2.8-5 | — |
| `formXObjectOpiRule` | ✓ 6.2.4-2 (`PDXObject`) | ✓ 6.2.9-1 (`PDXForm`) | — |
| `outputIntentKeysRule` `/DestOutputProfileRef` | — | ✓ 6.2.3-3 | **`S != 'GTS_PDFX' \|\| containsDestOutputProfileRef == false`** — exempt on a PDF/X intent, where part 4's test is bare `containsDestOutputProfileRef == false` |
| `outputIntentKeysRule` surplus-intent count | — | — | 2/3 require `sameOutputProfileIndirect == true` instead, which `outputIntentRule` already reports as `'multiple'`. Stays part-4-only |
| `appearanceKeysRule` (`/AP` holds only `/N`) | ✓ 6.5.3-4 | ✓ 6.3.3-2 | — |
| `widgetActionRule` | ✓ `/A` 6.6.1-3 **and** `/AA` 6.6.2-1 | ✓ `/A`+`/AA` 6.4.1-1 | **parts 1-3 are STRICTER than part 4**, which bans `/A` alone and exempts a Widget's `/AA` under 6.6.3-1 |
| `transparencyBlendingSpaceRule` | — | ✓ 6.2.10-2 | part 1 bans transparency groups outright, so the `/CS` rule has nothing to attach to |
| `needsRenderingRule` | — | ✓ 6.4.2-2 | absent at part 1 |

**Staying part-4-only, on the anchor's authority:** `/HTO`, `ocConfigRule`,
`toUnicodeContentRule`, `requirementsRule`, `alternatePresentationsRule`,
`permissionsRule`, `infoRestrictionRule`, `embeddedFileSpecRule`, and the
surplus-output-intent half above. Each is a PDF 2.0-era construct or a
2.0-era restriction; none appears in the 1B/2B/3B profiles.

## Design

### Approach: per-part selector functions

Each varying rule asks a named helper for its target's answer rather than
carrying a part conditional inline:

```ts
/** Parts 1-3 and 4 all police these; the PART decides the set. */
function permittedBpc(ctx: Ctx): Set<number> {
  // ISO 19005-1 6.2.4-4 stops at 8: PDF 1.4 had no 16-bit images.
  return ctx.part === 1 ? PERMITTED_BPC_A1 : PERMITTED_BPC;
}

/** ISO 19005-2/-3 6.2.3-3 exempts a PDF/X output intent, where 19005-4's
 *  6.2.3-3 is unconditional. A PDF/A-2 file may legally carry a GTS_PDFX
 *  intent beside its GTS_PDFA1 one, and /DestOutputProfileRef is legal there. */
function destProfileRefExempt(ctx: Ctx, oi: PdfDict): boolean {
  return ctx.part !== 4 && nameOf(ctx, oi, 'S') === 'GTS_PDFX';
}
```

This is the shape `prohibitedActions(ctx)` and `prohibitedAnnots(ctx)` already
take in `pdfavalidate.ts`, so a reader who has seen one has seen all. Each
widened rule's gate loosens from `if (ctx.part !== 4) return []` to the set of
parts that carry it — `if (ctx.part === 1) return []` for the four that start at
part 2, and no gate at all for the five that apply everywhere.

Two rules approved and rejected: inline part conditionals (the per-part
knowledge lands in nine places instead of a named one, and the next backport
re-derives it), and separate parts-1-3 rules beside the part-4 ones (two copies
of one clause, which is the failure this codebase records most often — and the
clause NUMBERS differ per part while the TESTS do not, so the duplication would
be of the half that is identical).

### `widgetActionRule` widens as well as ungates

**Invariant, and it is the one that reads backwards:** parts 1-3 are STRICTER
here than part 4. ISO 19005-1 6.6.1-3 and 6.6.2-1, and 19005-2/-3 6.4.1-1,
forbid a Widget's `/A` **and** its `/AA`; ISO 19005-4 6.4.1-1 forbids `/A`
alone, and 6.6.3-1 explicitly exempts a Widget's additional actions "whose
triggers are the form's". So the rule takes a per-part key set, and part 4 keeps
the narrower one. Widening part 4 to match parts 1-3 would report a document
ISO 19005-4 permits.

### The converter widens in step

`72nc.2`'s passes already fix six of the newly-detected defects, so ungating
them keeps conversions passing rather than merely reporting more:

| Pass | Change |
|---|---|
| `pdfa4GraphicsPass` → `graphicsKeysPass` | ungate `/TR`, `/TR2`, image `/Alternates`+`/OPI`, form `/OPI` to parts 1-3; `/HalftoneName` to parts 2-3; `/HTO` stays part-4-only |
| `pdfa4OutputIntentPass` → `outputIntentKeysPass` | ungate the `/DestOutputProfileRef` deletion to parts 2-3, honouring the `GTS_PDFX` exemption; the surplus-intent drop stays part-4-only |
| `pdfa4AnnotPass` → `annotKeysPass` | ungate the `/AP`-key prune to parts 1-3; strip a Widget's `/A` there **and its `/AA`**, behind the new category below |

The three are renamed because the `pdfa4` prefix becomes a lie the moment they
run at part 2 — this repo's own rule that a module or symbol named for what it
does beats one named for where it started. `pdfa4CatalogPass` keeps its name:
every rule it serves stays part-4-only.

**Invariant:** the passes take their per-part scope from the SAME helpers the
rules do. A pass that decided independently which parts it serves is how a
converter comes to fix something the validator does not report, or leave
something it does.

### One new `ConvertCategory`: `'formActions'`

Stripping `/A` and `/AA` from every widget deletes real behaviour — a push
button's action, a field's keystroke and format scripts. That is what
conformance demands and what the converter will do by default, reporting each
removal in `applied`; `preserve: ['formActions']` keeps them and reports
`WidgetAction` unresolved instead. This is the shape every other destructive
removal here already takes (`xfa`, `multimedia`, `optionalContent`, `info`),
and the loss is exactly the kind those categories exist to make opt-out.

**Note it is NOT folded into `'javascript'`.** That category gates `actionsPass`
entirely, so reusing it would tie "keep my form's buttons working" to "keep
every prohibited action in the document", which are different requests. It also
reads wrong: a `/A` with an `/S /GoTo` is not JavaScript.

## What newly fails, and it is a short list

With the converter widened, only the two defects nobody can fix mechanically
newly reach `unresolved` at parts 1-3 — and both already do at part 4:

- **`Halftone`** for a type outside {1,5} at parts 2-3. Forcing it to 1 would
  change how the page prints.
- **`ImageKeys`** for a `BitsPerComponent` outside the permitted set. Fixing it
  means re-encoding the image. **Note the part-1 case is genuinely new**, not
  merely newly-reported: a 16-bit image is legal at parts 2/3/4 and illegal at
  part 1, so a document that converts clean to `'2b'` today can legitimately
  fail `'1b'` afterwards. That is the standard's decision, and the report names
  the object.

Everything else the widened passes repair.

## Testing

The `72nc.1` idiom, and it is the shape that pins a backport rather than merely
exercising it: **every widened rule gets a CROSS-PART PAIR** — the same fixture
asserted as reported at each part that carries the check, and SILENT at each
part that does not. A single-part assertion cannot tell a rule that correctly
widened from one that widened too far.

The pairs that matter most, because each turns on a divergence rather than on
the ungating:

- `BitsPerComponent` **16**: silent at `'2b'`/`'3b'`/`'4'`, reported at `'1b'`.
- `/DestOutputProfileRef` on a `GTS_PDFX` intent: silent at `'2b'`, reported at
  `'4'`. On a `GTS_PDFA1` intent: reported at both.
- Widget `/AA`: reported at `'1b'`/`'2b'`, silent at `'4'`.
- `/HalftoneName` and `/NeedsRendering`: silent at `'1b'`, reported at `'2b'`.
- Transparency `/CS`: silent at `'1b'`, reported at `'2b'`.

Conversion gets the matching pairs: `preserve: ['formActions']` keeps the
actions **and** reports `WidgetAction` unresolved — both halves, since either
alone passes with the category ignored.

**The fence, and it differs from `72nc.1`'s and `72nc.2`'s.** Those froze
`test/pdfavalidate.test.ts` (42 cases) and `test/pdfaconvert.test.ts` (21).
Here they may legitimately MOVE: widening a rule to parts 1-3 is precisely what
this issue is for. The rule is that **every case that moves is examined and its
movement explained in the commit**, never blanket-updated — a fixture that
starts failing may be a fixture that was always non-conformant, or it may be the
backport reaching too far, and only reading it says which.

Every widened rule and every widened pass is mutation-checked; any that reddens
nothing is recorded as uncovered rather than quietly kept.

## The oracle

Unchanged from `72nc.1` and worth restating in the same terms: **there is none
that runs here.** veraPDF is not installed. The profiles are fetched text, and
this issue's transcription is verified against them field by field — but a
passing report still attests that our reading of those profiles is
self-consistent, not that either matches ISO 19005.

What this issue DOES improve is narrower and real: nine rules that disagreed
with the profiles for parts 1-3 will now agree with them.

## Delivery

1. The per-part helpers, and the five rules that apply at every part.
2. The four rules that start at part 2 (`halftoneRule`, `needsRenderingRule`,
   `transparencyBlendingSpaceRule`, `outputIntentKeysRule`'s
   `/DestOutputProfileRef`), with the `GTS_PDFX` exemption.
3. `widgetActionRule`'s per-part key set (`/A` everywhere, `/AA` at parts 1-3).
4. The three converter passes: rename, ungate, per-part scope from the shared
   helpers.
5. `ConvertCategory` gains `'formActions'`; the Widget strip goes behind it.
6. The cross-part pairs and the mutation sweep.
7. README, `CLAUDE.md`, `CHANGELOG.md`.

## Acceptance

- Each of the nine rules reports at every part the profile carries it, and stays
  silent at every part the profile does not — asserted as pairs.
- The three per-part divergences (part-1 `BitsPerComponent`, the `GTS_PDFX`
  exemption, Widget `/AA`) each have a case that fails if the divergence is
  flattened in either direction.
- `ConvertToPdfA('1b'|'2b'|'3b')` on the existing messy fixtures still reports
  `passed === true`, except where a non-remediable defect above is present.
- `preserve: ['formActions']` keeps the actions and reports `WidgetAction`.
- Every moved case in `test/pdfavalidate.test.ts` and `test/pdfaconvert.test.ts`
  is explained rather than updated.
- `npm run typecheck` and `npm test` green.
- README and `CLAUDE.md` record the per-part matrix, the three divergences, the
  new category, and the unchanged circular-oracle caveat.
