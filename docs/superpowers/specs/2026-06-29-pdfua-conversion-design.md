# PDF/UA conversion / remediation — design

**Date:** 2026-06-29
**Status:** Approved (design); plan pending
**Scope:** Conversion/remediation counterpart to the PDF/UA validator
(`ValidatePdfUa`, ISO 14289-1). Sibling of the PDF/A conversion sub-project.

## Context

The library already ships a curated, read-only PDF/UA-1 validator
([structvalidate.ts](../../../src/structvalidate.ts), entry
`Document.ValidatePdfUa()`, design
[2026-06-26-pdfua-validation-design.md](2026-06-26-pdfua-validation-design.md))
and a PDF/A conversion/remediation engine
([pdfaconvert.ts](../../../src/pdfaconvert.ts), entry
`Document.ConvertToPdfA()`, design
[2026-06-29-pdfa-conversion-design.md](2026-06-29-pdfa-conversion-design.md))
built as an ordered list of mutating *passes* that re-validate at the end and
return a `ConversionReport { applied, unresolved, passed }`.

What is missing is a **remediation** entry point for PDF/UA, the accessibility
counterpart to `ConvertToPdfA`.

### Why PDF/UA conversion is fundamentally partial

Unlike PDF/A — where the overwhelming majority of defects are mechanical
metadata/object fixes — accessibility is largely **human-authored content**.
Alt text, reading order, semantic heading structure, and the tagging of
untagged page content cannot be honestly synthesized by a tool. Fabricating
them produces documents that *pass* a validator while actively misleading
assistive technology.

The PDF/UA validator's rules therefore split into two groups:

- **Mechanically remediable** — a single catalog/metadata setting resolves the
  defect deterministically:
  - `NaturalLanguage` ← catalog `/Lang`
  - `DisplayDocTitle` ← `/ViewerPreferences /DisplayDocTitle = true`
  - `Tagged` (the `/Marked` half) ← `/MarkInfo /Marked = true`
  - `DocumentTitle` ← `/Info /Title` (when a title is available)
  - `StandardType` ← `/StructTreeRoot /RoleMap` entries (when a mapping is given)
  - `Suspects` (warning) ← clear `/MarkInfo /Suspects`
  - plus required `pdfuaid` XMP identification metadata
- **Needs human authoring** — only reportable, never invented:
  `IllustrationAlt`, `HeadingNesting`, `TableStructure`, `ListStructure`,
  `UntaggedContent`.

This design implements the mechanical remediations and reports the rest, exactly
mirroring `ConvertToPdfA`'s pass→re-validate→report shape.

## Goals

1. Add `Document.ConvertToPdfUa(opts?)` that remediates the mechanically-fixable
   PDF/UA-1 defects in place and re-validates via `ValidatePdfUa`.
2. Return the existing `ConversionReport` shape: every fix as a `ConvertAction`,
   the post-conversion validation errors as `unresolved`, and a `passed` flag.
3. Never fabricate accessibility content: defects requiring human judgment are
   left untouched and surface honestly in `unresolved`.

## Non-goals

- Generating a structure tree for untagged content (no reading-order/heading
  inference; would produce unreliable "fake" accessibility).
- Synthesizing alt text, `/ActualText`, table header associations, or any
  semantic content.
- PDF/UA-2 (ISO 14289-2, PDF 2.0). The validator targets PDF/UA-1; so does this.
- Repairing malformed table/list nesting or heading structure.

## Approach

New module `src/pdfuaconvert.ts` holds an ordered list of mutating passes, each
`(ctx) => ConvertAction[]`, concatenated into the applied list; then
`validatePdfUa` runs and its `.Errors` become `unresolved`. The engine mutates
the live object model in place, mirroring `pdfaconvert.ts`.

`Document.ConvertToPdfUa(opts?)` is the facade entry point. As with
`ValidatePdfUa`/`ConvertToPdfA`, the facade supplies the catalog dict to the
engine so catalog-only passes need no new public accessor.

### Shared conversion types (targeted refactor)

`ConvertAction` and `ConversionReport` currently live in `pdfaconvert.ts`. With
two converters now, extract them into a new `src/conversion.ts` — exactly as
`ValidationReport` was extracted into `validation.ts`. Both `pdfaconvert.ts` and
`pdfuaconvert.ts` import from it; `pdfuaconvert` does not depend on
`pdfaconvert`. `pdfaconvert.ts` re-exports the moved types so existing importers
are unaffected.

Rejected alternative: importing `ConvertAction`/`ConversionReport` from
`pdfaconvert.ts` into `pdfuaconvert.ts` — couples the two converters and makes
PDF/A a dependency of PDF/UA for no reason.

## Public API

```ts
// document.ts
ConvertToPdfUa(opts?: PdfUaConvertOptions): ConversionReport;

// pdfuaconvert.ts
interface PdfUaConvertOptions {
  /** Catalog /Lang (e.g. 'en-US'). When set, resolves NaturalLanguage for the
   *  whole document. When omitted and the catalog has no /Lang, NaturalLanguage
   *  is left unresolved — a language is never fabricated. */
  lang?: string;
  /** Fallback document title, used only when neither /Info /Title nor XMP
   *  dc:title is already non-empty. */
  title?: string;
  /** Custom-role → standard-type mappings added to /StructTreeRoot /RoleMap,
   *  for roles actually used in the tree and not already mapped. */
  roleMap?: Record<string, string>;
}

// conversion.ts (moved from pdfaconvert.ts; unchanged shape)
interface ConvertAction { rule: string; action: string; object?: PdfRef; page?: Page; }
interface ConversionReport {
  applied: ConvertAction[];
  unresolved: ValidationIssue[]; // == ValidatePdfUa().Errors after the passes run
  passed: boolean;
}
```

## Passes

Each pass returns the `ConvertAction[]` it performed (empty when nothing was
needed). Order is fixed; passes are independent and individually testable.

| # | pass | fix | resolves |
|---|---|---|---|
| 1 | `markedPass` | struct tree present → `/MarkInfo /Marked = true`; no tree → no-op | `Tagged` (Marked half) |
| 2 | `titlePass` | keep existing `/Info /Title` or XMP `dc:title`; else if `opts.title`, set `/Info /Title` and mirror XMP | `DocumentTitle` |
| 3 | `displayDocTitlePass` | `/ViewerPreferences /DisplayDocTitle = true` (creating `/ViewerPreferences` if absent) | `DisplayDocTitle` |
| 4 | `langPass` | `opts.lang` → catalog `/Lang`; absent + no existing `/Lang` → no-op | `NaturalLanguage` |
| 5 | `roleMapPass` | add `opts.roleMap` entries to `/StructTreeRoot /RoleMap` for used, unmapped custom roles | `StandardType` |
| 6 | `suspectsPass` | `/MarkInfo /Suspects === true` → set `false` | `Suspects` (warning) |
| 7 | `identificationPass` | write `pdfuaid:part 1` XMP identification | (required metadata) |

Notes:

- **markedPass** never fabricates a structure tree. A document with no
  `/StructTreeRoot` cannot be made PDF/UA by this tool; `Tagged` remains in
  `unresolved` and the report's `passed` is `false`.
- **roleMapPass** only maps roles that actually appear in the tree and are not
  already resolvable, so it never adds dead `/RoleMap` entries. Mappings whose
  target is itself a non-standard type are skipped (and the role stays
  unresolved).
- The human-authoring rules (`IllustrationAlt`, `HeadingNesting`,
  `TableStructure`, `ListStructure`, `UntaggedContent`) have **no pass**. They
  appear in `unresolved` whenever present — the intended honest behavior.

## xmp.ts change (additive)

PDF/UA identification lives in its own namespace, separate from `pdfaid`:

- Add `pdfuaPart?: number` to `XmpMetadata`.
- `readXmp`: parse `pdfuaid:part` (attribute or element form), mirroring the
  existing `pdfaid:part` scan.
- `buildXmp`: emit an `rdf:Description` with
  `xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"` and `pdfuaid:part` when
  `pdfuaPart` is set, mirroring the existing `pdfaid` block.

Purely additive; existing XMP consumers ignore the new field. `identificationPass`
calls `doc.SetXmp({ pdfuaPart: 1 })`.

## Module boundaries

- `conversion.ts` — new; owns `ConvertAction` / `ConversionReport` (depends only
  on `types.ts`, `page.ts`, `validation.ts`).
- `pdfaconvert.ts` — imports the two types from `conversion.ts` and re-exports
  them; otherwise unchanged.
- `pdfuaconvert.ts` — new; depends on `document.ts` (catalog/metadata/XMP
  access), `structvalidate.ts` (`validatePdfUa` for re-validation), `struct.ts`
  (read model for `roleMap`/`marked` decisions), `conversion.ts`, `types.ts`.
- `document.ts` — gains the thin `ConvertToPdfUa()` wrapper.
- `xmp.ts` — additive `pdfuaPart` read/build.
- `index.ts` — export `ConvertToPdfUa`, `PdfUaConvertOptions`, and
  `ConversionReport` / `ConvertAction` (now from `conversion.ts`).

## Testing (TDD)

Extend `test/helpers/build-tagged-pdf.ts` with options to emit a document
carrying mechanically-fixable defects (no `/MarkInfo /Marked`, no title, no
`/ViewerPreferences /DisplayDocTitle`, no `/Lang`, an unmapped custom role,
`/MarkInfo /Suspects = true`) and at least one unfixable defect (a `Figure`
without `/Alt`).

New `test/pdfuaconvert.test.ts`:

- Document with only mechanical defects + matching `opts` (`lang`, `title`,
  `roleMap`) → `passed === true`; assert each expected `ConvertAction.rule` is
  present.
- `Figure` without `/Alt` (and/or untagged content) → that issue remains in
  `unresolved`; `passed === false`; the mechanical fixes are still applied
  (assert the `ConvertAction`s and the catalog state).
- No `opts.lang` and no existing `/Lang` → `NaturalLanguage` in `unresolved`;
  same fixture with `opts.lang` → resolved.
- Save()/Open() round-trip preserves the fixes: `/Lang`,
  `/ViewerPreferences /DisplayDocTitle`, `/MarkInfo /Marked`, the added
  `/RoleMap` entry, and the `pdfuaid:part` XMP.
- Untagged document (no `/StructTreeRoot`) → `Tagged` stays in `unresolved`; no
  structure tree is fabricated.
- `roleMapPass` skips mappings whose target is non-standard (role stays
  unresolved).

`npm run typecheck` and `npm test` must both be green before close.

## Documentation

`README.md` "Features" gains a PDF/UA conversion/remediation bullet;
"Limitations" notes that conversion is mechanical only — alt text, reading
order, heading/table/list structure, and tagging of untagged content require
manual authoring and are reported, not synthesized.
