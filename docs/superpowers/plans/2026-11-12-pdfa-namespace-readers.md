# PDF/A Namespace Readers Implementation Plan

**Issue/spec:** mfan. PDF/A identification readers must use namespace URI
`http://www.aiim.org/pdfa/ns/id/`, independent of prefix and XML entity spelling.
**Goal:** Make GetXmp and PDF/A identification validation agree on valid RDF.
**Architecture:** A shared internal reader uses the existing namespace-resolved
RDF model. Preserve raw scalar strings for validation and existing numeric
coercion for GetXmp. Only an unparseable packet uses the legacy literal-prefix
fallback; resource-limit refusals propagate. Thread the caller's limits through
all readXmp call sites to avoid introducing default limits into trusted paths.
**Tech stack:** TypeScript, existing XML/RDF parser, vitest, no dependencies.
**Execution:** Inline with systematic-debugging and TDD; progress in Beads.

## Constraints and review focus

Keep empty conformance distinct from absence, and empty numbers as NaN.
Ignore foreign namespaces using the pdfaid prefix, nested properties and
comments in parseable packets. Preserve lenient malformed-packet behavior,
numeric lexical validation, raw text and decode/XML limit propagation. PDF/UA
and PDF/X identification parsing remains outside this PDF/A fix.
Exclude alternate-prefix PDF/A fields from the custom list so custom updates
cannot erase built-in identification.
Validation keeps its existing raw-packet reader; obtaining raw text through
GetXmp would unnecessarily parse unrelated damaged custom values.

## Task 1: Reproduce and share namespace-aware reads

Files: test/helpers/build-pdfa-id-packet.ts, test/pdfa-id-namespace.test.ts,
src/xmpid.ts, src/xmp.ts, src/pdfavalidate.ts, src/document.ts,
src/metasync.ts, src/rebuild.ts.

1. Add alternate-prefix attribute, element, default-namespace and entity cases,
   including PDF/A-4 rev, empty/absent/invalid values, namespace negatives,
   malformed fallback, raw preservation and custom/strict limits.
2. Run `npx vitest run test/pdfa-id-namespace.test.ts`; expect missing fields
   and incorrect PdfaIdentification findings before implementation.
3. Implement the shared reader and update the two readers. Forward limits at
   all readXmp callers. Run new tests plus existing XMP/PDF/A/edit regressions,
   expecting all passing. Update README and CHANGELOG.

## Task 2: Verify and integrate

Run typecheck and the full branch suite, and request a fresh read-only review.
Merge into main and rerun both required gates. Only then close mfan, commit the
closure audit entry, push main, sync Beads and remove the merged fix branch.
Preserve unrelated workspace edits.
