# PDF/A validation — design

**Date:** 2026-06-29
**Status:** Approved (design); plan pending
**Scope:** First sub-project of a "PDF/A conformance" epic. Validation only;
conversion/remediation is a future sub-project that will build on this validator.

## Context

The library has a complete tagged-PDF read/author/preserve layer and a curated
PDF/UA-1 validator (`doc.ValidatePdfUa()`,
[structvalidate.ts](../../../src/structvalidate.ts)) that returns a structured
`ValidationReport`. It also already has font embedding/subsetting, XMP read/write
([xmp.ts](../../../src/xmp.ts)), encryption state on open, a content-stream
tokenizer ([content.ts](../../../src/content.ts)), and a glyph/image content walk
([text.ts](../../../src/text.ts) `visitContent`).

What is missing is any PDF/A (ISO 19005) support: no `/OutputIntent` awareness, no
conformance-identification XMP, and no validation. This sub-project adds a
**curated, machine-decidable** PDF/A validator covering parts 1–3 at all
conformance levels (b/u/a), in the same spirit as the UA validator.

The library is pure TypeScript with zero runtime dependencies and does no
rendering, so rules requiring visual rendering, deep ICC-profile parsing, or
human judgment are out of scope. The target is the set of rules objectively
decidable from the object model, catalog, metadata, resources, and content
streams. A passing report is therefore **necessary but not sufficient** for
certified PDF/A conformance — this is stated in the public docs, matching the UA
validator's honesty.

## Goals

1. `doc.ValidatePdfA(level)` runs a conformance check for any of `1b`, `1a`,
   `2b`, `2u`, `2a`, `3b`, `3u`, `3a` and returns a `ValidationReport` with
   stable rule ids, severities, ISO 19005 clause references, and precise
   locations (`element` / `page` / offending indirect `object`).
2. Cover the common, deterministic conformance defects: encryption, missing/
   non-embedded fonts, missing or malformed output intent, missing/incorrect
   PDF/A identification XMP, prohibited JavaScript/actions/annotation types,
   transparency in part 1, prohibited filters, external streams, embedded-file
   policy, form/XFA constraints, and (content-scan) device-color-without-intent
   and inline-image filter violations.
3. Gate rules correctly by part and level: `u`-only rules (ToUnicode) do not run
   at `b`; part-1-only rules (transparency, optional content) do not run at
   parts 2/3; `a`-level folds in the existing PDF/UA tagging checks.

## Non-goals (documented limitations / future issues)

- Deep ICC-profile parsing or validity (only structural `/N`-consistency checks).
- Glyph-presence verification inside the embedded font program.
- Visual-fidelity, overprint, halftone, or transfer-function checks.
- Recursive full PDF/A validation of *embedded* PDFs (part 2/3 only checks the
  `/AFRelationship` marker, best-effort).
- Reading-order and full semantic-quality judgment (inherited from the UA
  validator's own non-goals for `a`-level).
- Full XMP extension-schema description validation.
- PDF/A-4 (ISO 19005-4, PDF 2.0). Out of scope; may be a later sub-project.
- Conversion/remediation — this sub-project only reports; it never mutates.

## Approach

New module `src/pdfavalidate.ts` holds a small rule engine: an ordered list of
pure rule functions, each `(doc, catalog, ctx) => ValidationIssue[]`, whose
results are concatenated into a report. Each rule decides internally whether it
applies to `ctx.part` / `ctx.conformance` and returns no issues when it does not.
The engine is pure and read-only.

`Document.ValidatePdfA(level: PdfALevel): ValidationReport` is the facade entry
point, mirroring `ValidatePdfUa()`. It parses `level` into `{ part, conformance }`
and supplies the catalog dict (so catalog-only rules need no new public
accessor, exactly as `ValidatePdfUa` already does).

A per-run context object carries memoized work shared across rules: the resolved
catalog, the set of output intents, the enumerated fonts (deduped across pages),
and the per-page content-scan results (device-color usage, inline-image filters,
rendering intents) so each content stream is tokenized at most once.

For level `a`, the engine calls `validatePdfUa(doc, catalog)` and folds its
issues into the report with rule ids prefixed `UA:` and the clause re-pointed to
ISO 19005-x §6.8 (which incorporates the tagging requirements). PDF/A-1a's
tagging requirements are a subset of what the UA validator already checks, so
reuse is faithful and avoids duplicating the tree walk.

Rejected alternatives: per-part validator functions (`validatePdfA1`, …) —
duplication; a unified UA+A rule framework — YAGNI/over-abstraction; throwing on
first violation — loses the structured multi-issue report auditing needs.

## Shared-types refactor (enabling)

`Severity`, `ValidationIssue`, and `ValidationReport` currently live in
`structvalidate.ts`. Extract them into a new `src/validation.ts`. `structvalidate.ts`
re-exports them (back-compat for any importer); `pdfavalidate.ts` imports them
from `validation.ts`. This keeps the two validators from depending on each other
merely for shared primitives.

`ValidationIssue` gains one optional field so object-level findings can point at
the offending indirect object:

```ts
// validation.ts
export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  rule: string;            // stable id, e.g. 'FontEmbedded'
  severity: Severity;
  message: string;
  clause?: string;         // ISO 19005-x / Matterhorn reference
  element?: StructElement; // offending node, when applicable
  page?: Page;             // offending page, when applicable
  object?: PdfRef;         // offending indirect object, when applicable (NEW)
}

export class ValidationReport {
  readonly Issues: ValidationIssue[];
  get Errors(): ValidationIssue[];   // severity === 'error'
  get Warnings(): ValidationIssue[]; // severity === 'warning'
  get Passed(): boolean;             // no errors (warnings allowed)
}
```

The new `object?` field is additive; existing UA-validator construction sites and
consumers are unaffected.

## Public API

```ts
// document.ts
export type PdfALevel = '1b' | '1a' | '2b' | '2u' | '2a' | '3b' | '3u' | '3a';

ValidatePdfA(level: PdfALevel): ValidationReport;

// index.ts re-exports PdfALevel and (already) ValidationReport/ValidationIssue/Severity
```

## Rules

Applicability key: **part** ∈ {1,2,3}; **conformance** ∈ {b,u,a} where a rule
that applies at `b` also applies at `u` and `a` (b ⊂ u ⊂ a). "all" = every level
of every in-scope part.

### File / structure

| id | severity | check | applies |
|---|---|---|---|
| `Encryption` | error | trailer has no `/Encrypt` | all |
| `FileID` | error | trailer `/ID` present | all |
| `Version` | error | PDF version ≤ ceiling (1.4 part 1; 1.7 parts 2/3); catalog `/Version` does not exceed it | all |
| `ExternalStream` | error | no stream carries an `/F` external-file reference | all |
| `LZW` | error | no `/LZWDecode` filter anywhere (stream dicts + inline images) | all |
| `PostScriptXObject` | error | no `/Subtype /PS` XObject and no `/PS` key | all |
| `ReferenceXObject` | error | no Form XObject with a `/Ref` (reference XObject) | all |
| `OptionalContent` | error | catalog has no `/OCProperties` (layers) | part 1 |

### Metadata

| id | severity | check | applies |
|---|---|---|---|
| `Metadata` | error | `/Root /Metadata` present and a well-formed XMP packet | all |
| `PdfaIdentification` | error | XMP `pdfaid:part` and `pdfaid:conformance` match the claimed level (part number; conformance letter case-insensitive, `a`/`b`/`u`) | all |
| `XmpInfoConsistency` | error (part 1) / warning (parts 2/3) | when `/Info` is present, its `/Title`/`/Author`/`/Subject`/`/Keywords`/`/CreationDate`/`/ModDate` agree with the XMP equivalents | all |

### Color / output intent

| id | severity | check | applies |
|---|---|---|---|
| `OutputIntent` | error | when device-dependent color is used (per content scan or default color spaces), a PDF/A `/OutputIntents` entry with `/S /GTS_PDFA1` and an ICC `/DestOutputProfile` stream exists; all PDF/A output intents reference the same profile | all |
| `ICCBasedN` | error | every `/ICCBased` color-space stream has `/N` ∈ {1,3,4} and (when present) an alternate matching that component count | all |
| `DeviceColorWithoutIntent` | error | *(content scan)* a DeviceGray/DeviceRGB/DeviceCMYK color operator or image is used without a matching PDF/A output intent | all |

`DeviceColorWithoutIntent` is the content-scan counterpart that locates the
specific page; `OutputIntent` is the document-level "intent is missing/malformed"
finding. They share the device-color memo in `ctx` and are deduped (one
`DeviceColorWithoutIntent` per offending page; one `OutputIntent` document-level).

### Fonts

| id | severity | check | applies |
|---|---|---|---|
| `FontEmbedded` | error | every used font embeds a font program (`/FontFile`/`/FontFile2`/`/FontFile3`), including standard-14 fonts and Type0 descendant CIDFonts | all |
| `FontEncoding` | error | non-symbolic TrueType uses `/WinAnsiEncoding` or `/MacRomanEncoding` (optionally with `/Differences`); symbolic TrueType has no `/Encoding` | all |
| `FontCIDSet` | error (part 1) / warning (parts 2/3) | an embedded CID **subset** font carries a `/CIDSet` in its descriptor | all |
| `ToUnicode` | error | every font is Unicode-mappable: has `/ToUnicode`, or is a simple font with a standard predefined encoding, or is Type0 with a known Identity/registered CMap | **u**, **a** |

Fonts are enumerated once into `ctx` by walking every page's `/Resources /Font`
(recursing into Form XObject resources), deduped by indirect reference.

### Transparency

| id | severity | check | applies |
|---|---|---|---|
| `Transparency` | error | no transparency group (`/Group /S /Transparency` on a page or Form XObject), no ExtGState `/SMask` other than `/None`, no `/BM` other than `Normal`/`Compatible`, no `/CA`/`/ca` < 1 | part 1 |
| `BlendMode` | warning | every ExtGState `/BM` is a standard separable/non-separable blend-mode name | parts 2/3 |

ExtGState dicts are gathered from every `/Resources /ExtGState` (pages + Form
XObjects); page/XObject `/Group` dicts are inspected directly. No content scan is
required for transparency — these all live in resource/object dicts.

### Annotations / forms / actions

| id | severity | check | applies |
|---|---|---|---|
| `AnnotationAppearance` | error | every annotation except `/Popup` and `/Link` has a normal appearance `/AP /N`; for an appearance subdictionary the `/AS`-selected state exists | all |
| `AnnotationSubtype` | error | no `/Movie`, `/Sound`, `/Screen`, `/3D`, or `/RichMedia` annotation | all |
| `AnnotationFlags` | error | annotation `/F` has the Print bit set and does **not** set Hidden, NoView, or Invisible | all |
| `AnnotationOpacity` | error | annotation `/CA` is absent or equals 1 | part 1 |
| `Actions` | error | no `/Launch`, `/Sound`, `/Movie`, `/ResetForm`, `/ImportData`, `/JavaScript`, `/SetState`, `/Hide`, or `/SetOCGState` action anywhere (`/OpenAction`, annotation/field `/A`, all `/AA` slots, `/Names /JavaScript`) | all |
| `AdditionalActions` | error | part 1: no `/AA` at all (catalog/page/annot/field); parts 2/3: no `/AA` slot containing a prohibited action | all |
| `NeedAppearances` | error | AcroForm `/NeedAppearances` is absent or false | all |
| `XFA` | error | AcroForm has no `/XFA` (dynamic XFA forms prohibited) | all |

`Actions` subsumes the JavaScript prohibition (the `/JavaScript` action type and
`/Names /JavaScript` tree); no separate `JavaScript` rule is needed.

### Images / content scan

| id | severity | check | applies |
|---|---|---|---|
| `ImageFilter` | error | image XObjects and inline images use no `/LZWDecode` (all) and no `/JPXDecode`/`/JBIG2Decode` (part 1) | all |
| `ImageInterpolate` | warning | no image has `/Interpolate true` | all |
| `RenderingIntent` | error | every `ri` operator operand and annotation/image `/Intent` is one of the four standard rendering-intent names | all |

`LZW` (file/structure) and `ImageFilter` overlap on LZW; the engine emits the
LZW finding once per offending object via the shared filter scan and does not
double-report.

### Tagging (level `a` only)

For `a`-level, fold in `validatePdfUa(doc, catalog)`: each UA `ValidationIssue`
is copied with its `rule` prefixed `UA:` and `clause` re-pointed to ISO 19005-x
§6.8. UA warnings stay warnings, errors stay errors, so a heuristic UA warning
(e.g. `UntaggedContent`) does not by itself fail the PDF/A report.

## Content scan

A small internal operator scanner (in `pdfavalidate.ts`, using the `content.ts`
tokenizer) walks each page's content stream once and records into `ctx`:

- **device-color usage** — any of `g`/`G`/`rg`/`RG`/`k`/`K`, or `cs`/`CS`
  selecting `/DeviceGray`/`/DeviceRGB`/`/DeviceCMYK` (or `/Pattern` whose
  underlying space is device), then `sc`/`scn`/`SC`/`SCN`.
- **inline images** — `BI … ID … EI`: the inline image dict's abbreviated
  `/F`/`/Filter` and `/CS` keys (expanded from the standard abbreviations).
- **rendering intent** — `ri` operands.

The scanner recurses into Form XObject content streams (bounded by the same
`MAX_XOBJECT_DEPTH` guard `text.ts` uses) so device color used only inside an
XObject is still detected. Image XObject color spaces and filters are read from
the XObject stream dicts directly (resource scan), not the content scan.

## Module boundaries

- `validation.ts` (new) — `Severity`, `ValidationIssue` (+ `object?`),
  `ValidationReport`. No behavior beyond the report partitioning. Depends only on
  `struct.ts`/`page.ts`/`types.ts` for the locator field types.
- `structvalidate.ts` — re-exports the three types from `validation.ts`;
  otherwise unchanged.
- `pdfavalidate.ts` (new) — the rule engine and content scanner. Depends on
  `validation.ts`, `document.ts` (catalog/metadata/font/xmp access), `xmp.ts`
  (identification + Info consistency), `content.ts` (tokenizer), and
  `structvalidate.ts` (`validatePdfUa` for `a`-level). Exposes `PdfALevel` and
  the internal `validatePdfA(doc, catalog, level)` entry the facade calls.
- `document.ts` — gains the thin `ValidatePdfA(level)` wrapper and the
  `PdfALevel` re-export.
- `index.ts` — exports `PdfALevel` (and already exports the report types).

Each rule is an independently-testable function with no shared mutable state
beyond the read-only memoized `ctx`.

## Testing (TDD)

New `test/helpers/build-pdfa-pdf.ts` builds a clean, conformant fixture
(embedded font, output intent with a minimal ICC stream, identification XMP, a
title, no prohibited features) plus toggles to emit one violating fixture per
rule: encrypted, missing `/ID`, over-ceiling version, external stream, an
LZW-filtered stream, a PostScript/reference XObject, `/OCProperties` present,
missing/empty `/Metadata`, wrong `pdfaid` part/conformance, inconsistent
`/Info`↔XMP, missing output intent while using device color, a bad `/ICCBased`
`/N`, a non-embedded font, a symbolic TrueType with `/Encoding`, a CID subset
without `/CIDSet`, a font without `/ToUnicode`, a transparency group, an
ExtGState `/ca` < 1, an annotation without `/AP`, a `/Movie` annotation, a
Hidden-flagged annotation, a `/JavaScript` action, an `/AA` slot, AcroForm
`/NeedAppearances true`, `/XFA`, a `/JPXDecode` image (part 1), `/Interpolate
true`, a non-standard `ri`, and an inline LZW image.

New `test/pdfavalidate.test.ts`:

- The clean fixture validates with **zero errors** at its declared level
  (warnings asserted absent for the clean case).
- One focused test per rule asserting the expected `rule` id, `severity`, and
  locator (`object`/`page`/`element`).
- **Level gating:** a `ToUnicode` violation passes at `b` and fails at `u`/`a`;
  a part-1 `Transparency` violation passes at part 2/3; a part-1-only
  `OptionalContent` violation passes at part 2/3.
- **`a`-level folding:** an untagged document validated at `1a`/`2a`/`3a`
  surfaces a `UA:Tagged` error.
- `Passed`/`Errors`/`Warnings` partitioning (warnings do not flip `Passed`).

`npm run typecheck` and `npm test` must both be green before close.

## Documentation

`README.md` "Features" gains a PDF/A validation bullet listing
`doc.ValidatePdfA(level)`, the supported levels (`1b`/`1a`/`2b`/`2u`/`2a`/`3b`/
`3u`/`3a`), and the rule families. "Limitations" gains the curated/decidable-
subset paragraph and the non-goals list (no deep ICC parsing, no glyph-presence,
no visual fidelity, no recursive embedded-PDF/A, no PDF/A-4, validation-only),
plus the explicit statement that a passing report is necessary but not sufficient
for certified conformance.
