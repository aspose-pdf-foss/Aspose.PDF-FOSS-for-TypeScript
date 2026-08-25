# PDF/UA validation rules — design

**Date:** 2026-06-26
**Status:** Approved (design); plan pending
**Issue:** aspose-pdf-foss-for-ts-pjx.5 (S5)
**Scope:** Fifth sub-project of the "Tagged PDF / accessibility" epic (Phase 9).

## Context

The prior sub-projects shipped a complete tagged-PDF read model and authoring
layer:

- `Document.GetStructTree(): StructTreeRoot | null`, `Document.IsTagged`,
  `Document.Lang` (S1, [struct.ts](../../../src/struct.ts)).
- `StructElement` / `StructTreeRoot` live handles with `Type`, `StandardType`
  (RoleMap-resolved), `IsStandardType`, `Alt`, `ActualText`, `Title`, `Lang`,
  `EffectiveLang`, `Children`, `ContentItems`, `Page`, `GetText()`.
- Deep attribute semantics for Table/List/Layout (S4,
  [structattr.ts](../../../src/structattr.ts)).
- A content walk ([text.ts](../../../src/text.ts) `visitContent`) that emits
  glyph and image events, each glyph tagged with its active `/MCID`.

What is missing is any way to **validate** a tagged document against PDF/UA-1
(ISO 14289-1) requirements. This sub-project adds a curated, machine-checkable
subset of those rules and a query API to run them.

The library is pure TypeScript with no rendering and zero runtime dependencies,
so rules requiring human judgment or visual rendering are out of scope. The
target is the set of rules that are **objectively decidable** from the tag tree,
catalog, metadata, and content streams.

## Goals

1. Let a caller run PDF/UA validation over an opened document and receive a
   structured, per-issue report with stable rule ids, severities, ISO/Matterhorn
   references, and precise locations (`StructElement` / `Page`) where applicable.
2. Cover the common, deterministic accessibility defects: missing tagging,
   missing document title / `DisplayDocTitle`, missing alt text on
   illustrations, unmapped custom roles, malformed table/list nesting, skipped
   heading levels, and missing natural-language specification.
3. Provide a best-effort, clearly-labelled heuristic check for untagged real
   page content (warning severity, so heuristic false positives never fail the
   report).

## Non-goals (future issues)

- Path-painting untagged-content detection (the content walk emits no path
  events).
- Table header / `Headers` attribute association and reading-order correctness.
- Link-text adequacy and any semantic-quality judgment.
- Anything requiring rendering or human review.
- Auto-remediation (this sub-project only reports; it never mutates).

## Approach

New module `src/structvalidate.ts` holds a small rule engine: an ordered list of
rule functions, each `(doc, root, ctx) => ValidationIssue[]`, whose results are
concatenated into a report. The engine is pure and read-only.

`Document.ValidatePdfUa(): ValidationReport` is the facade entry point, mirroring
`GetStructTree()` / `GetMetadata()`. When the document is untagged
(`GetStructTree()` returns `null`), the engine short-circuits to a single
`Tagged` error rather than running tree/content rules against a missing tree.

A per-run context object carries memoized work shared across rules — most
importantly the per-page content-walk results used by `UntaggedContent` — so the
content streams are walked at most once per page.

Rejected alternative: throwing an exception on the first violation. It loses the
structured multi-issue report that auditing use cases need and forces callers
into `try`/`catch`. Rejected alternative: a standalone exported function with no
facade method — inconsistent with the rest of the live-handle API.

## Public API

```ts
// document.ts
ValidatePdfUa(): ValidationReport;

// structvalidate.ts
type Severity = 'error' | 'warning';

interface ValidationIssue {
  rule: string;            // stable id, e.g. 'FigureAlt'
  severity: Severity;
  message: string;         // human-readable description
  clause?: string;         // ISO 14289-1 / Matterhorn reference
  element?: StructElement;  // offending node, when applicable
  page?: Page;             // offending page, when applicable
}

class ValidationReport {
  readonly Issues: ValidationIssue[];
  get Errors(): ValidationIssue[];   // severity === 'error'
  get Warnings(): ValidationIssue[]; // severity === 'warning'
  get Passed(): boolean;             // no errors (warnings are allowed)
}
```

## Rules

### Document-level (deterministic)

| id | severity | check | reference |
|---|---|---|---|
| `Tagged` | error | `/MarkInfo /Marked === true` **and** catalog `/StructTreeRoot` present | ISO 14289-1 §7.1 |
| `DocumentTitle` | error | Info `/Title` or XMP `dc:title` non-empty | §7.1 (Matterhorn 06-003) |
| `DisplayDocTitle` | error | catalog `/ViewerPreferences /DisplayDocTitle === true` | §7.1 (Matterhorn 07-001) |
| `Suspects` | warning | `/MarkInfo /Suspects` is not `true` | Matterhorn 01-005 |

`DisplayDocTitle` reads the catalog directly inside the rule; no new public
`ViewerPreferences` accessor is added (YAGNI — can be promoted later if other
features need it).

### Tree-walk (deterministic)

Walked once over the whole structure tree (depth-first from
`StructTreeRoot.Children`).

| id | severity | check | reference |
|---|---|---|---|
| `StandardType` | error | every element's `StandardType` is a known standard type (custom roles must resolve through `/RoleMap`) | Matterhorn 02-001 |
| `IllustrationAlt` | error | elements whose `StandardType` is `Figure`, `Formula`, or `Form` have a non-empty `Alt` or `ActualText` | §7.3 (Matterhorn 13-004) |
| `HeadingNesting` | error | numbered headings `H1`–`H6` do not skip a level when descending (e.g. an `H1` may not be directly followed in nesting by an `H3`) | Matterhorn 14-002 |
| `TableStructure` | error | `TR` appears only under `Table`/`THead`/`TBody`/`TFoot`; `TH`/`TD` appear only under `TR` | Matterhorn checkpoint 09 (tables) |
| `ListStructure` | error | `LI` appears only under `L`; `Lbl`/`LBody` appear only under `LI` | Matterhorn checkpoint 10 (lists) |
| `NaturalLanguage` | error | every text-bearing element (one that contributes glyphs via its content items) has a defined `EffectiveLang` | §7.2 (Matterhorn 11-001) |

`NaturalLanguage` uses `EffectiveLang`, which already folds in the catalog
`/Lang` default, so a document that sets `/Lang` once at the catalog passes
without per-element `/Lang`. The check fails only when neither the element, any
ancestor, nor the catalog supplies a language.

`HeadingNesting` compares against the nearest ancestor-or-prior numbered heading
level encountered in document order. Generic `H` (unnumbered) elements are not
subject to the skip check (they carry no level), matching the PDF/UA model where
either numbered or unnumbered headings are used, not mixed.

### Content-walk (heuristic)

| id | severity | check | reference |
|---|---|---|---|
| `UntaggedContent` | warning | a page bears glyphs or images with `mcid === undefined` that are not inside an `/Artifact` marked-content scope | Matterhorn 01-006 |

This rule walks each page's content via `visitContent` and flags any glyph or
image event that is neither tagged (has an `mcid`) nor inside an artifact scope.
Emitted at `warning` severity because the artifact/real-content distinction is
heuristic and legitimately-artifacted content patterns can produce false
positives. The check is scoped to **text and image** content — the two event
types the walk emits; path-painting content is not observable and is a
documented limitation / future issue. One issue is emitted per offending page
(located by `page`), not one per glyph.

## text.ts change (additive)

The content walk currently tracks the active `/MCID` on a stack and tags each
`GlyphEvent`. Extend it, mirroring how `mcid` was added in S1:

- Track an **artifact-scope depth** alongside the MCID stack: a `BMC`/`BDC`
  whose tag operand is `/Artifact` increments the depth; the matching `EMC`
  decrements it. The current event is "in an artifact" when depth > 0.
- Add `artifact?: boolean` to `GlyphEvent` and to `ImageEvent`.
- Add `mcid?: number` to `ImageEvent` (images can be tagged too).

The change is purely additive: existing consumers (redaction, `GetText`,
fragments, `struct.ts` MCID correlation) ignore the new fields.

## Module boundaries

- `structvalidate.ts` depends on `struct.ts` (read model), `document.ts`
  (catalog/metadata access), `text.ts` (`visitContent` for `UntaggedContent`),
  and `structattr.ts` only if a rule needs interpreted attributes (none in this
  set; kept out). It exposes `ValidationReport`, `ValidationIssue`, `Severity`,
  and the internal `validatePdfUa(doc)` engine entry that the facade calls.
- `document.ts` gains only the thin `ValidatePdfUa()` wrapper.
- `text.ts` gains the additive artifact tracking and event fields.
- `index.ts` exports `ValidationReport`, `ValidationIssue`, `Severity`.

Each rule is an independently-testable function with no shared mutable state
beyond the read-only memoized context.

## Testing (TDD)

Extend `test/helpers/build-tagged-pdf.ts` with options to emit violating
fixtures: missing/empty `Alt` on a `Figure`, a skipped heading level, a `TD`
outside any `TR`, an `LI` outside an `L`, a missing document title, absent
`DisplayDocTitle`, an unmapped custom role, a text-bearing element with no
resolvable language, and an untagged (non-artifact, non-MCID) glyph run on a
page.

New `test/structvalidate.test.ts`:

- A well-formed tagged document validates with **zero errors** (warnings
  permitted and asserted absent for the clean fixture).
- One focused fixture per rule asserting the expected issue `rule` id,
  `severity`, and location (`element` or `page`).
- Untagged document → single `Tagged` error, no tree/content rules run.
- `Passed` / `Errors` / `Warnings` partitioning behaves correctly (warnings do
  not flip `Passed` to false; errors do).

`npm run typecheck` and `npm test` must both be green before close.

## Documentation

`README.md` "Features" gains a PDF/UA validation bullet; "Limitations" notes the
curated/heuristic scope (no path-content check, no reading-order or
header-association validation, no rendering-based checks).
