# PDF/A-1 Transparency Flattening Implementation Plan

Use superpowers:executing-plans inline and test-driven-development. Track work
in bd, not markdown task lists.

**Goal:** Opt-in raster flattening with an invisible searchable text layer.
**Architecture:** New pdfaflatten.ts owns glyph-layer preparation, rendering,
resource replacement and orphan cleanup. pdfaconvert.ts resolves the option
and delegates a generator before the existing passes, retaining validation.
**Tech stack:** TypeScript NodeNext ESM, Node built-ins, vitest; zero runtime deps.
**Spec:** docs/superpowers/specs/2026-11-11-pdfa1-transparency-design.md.

## Constraints and review focus

Default unchanged; preserve wins; parts 2/3/4 unchanged. Never bake annotations
twice, delete shared assets, lose invisible text, damage page geometry or swallow
resource limits. Tagged and signed inputs remain unresolved. Every newly
allocated page's font must be complete before the next cancellation checkpoint.

## Task 1: Flattening and text layer

Create src/pdfaflatten.ts and test/pdfa-flatten-transparency.test.ts. Internal
interfaces: resolveFlattenTransparency(value: unknown): number | undefined;
flattenTransparencySteps(doc: Document, dpi: number, context: OperationContext):
OperationSteps<ConvertAction[]>.

Write failing integration tests using buildSvgPdf and the existing transparency
fixtures. Assert default transparency stays unresolved, opt-in removes the
prohibition and preserves known composite colors, source text and invisible
mode; compare rotated/cropped page rendering and validate saved/reopened bytes.
Include forms, inherited/shared resources, existing orphans, nested groups and
image soft masks. Observe red with npx vitest run on the new test file.
Implement packed RGB image + ICCBased sRGB, glyphless text from GlyphEvent pen
geometry, atomic page replacement and before/after reachability cleanup.

## Task 2: Conversion orchestration and controls

Modify src/pdfaconvert.ts: ConvertOptions.flattenTransparency is boolean or
{ dpi?: number }. Resolve before markModified; call the generator only for
part1, no transparency preserve, and unsigned input. Add progress for this
concern to pass totals without changing default totals. Keep the existing pass
order and final validatePdfASteps exactly intact.

Add failing tests for preserve, false, other parts, tagged/signed pages, option
validation before mutation, canvas limits, async equivalence, cancellation and
shared-reference survival across a partially completed run. Implement then run
the new file plus pdfaconvert, raster-transparency and control-convert tests.

## Task 3: Review and delivery

Update README, CHANGELOG and CLAUDE's module/invariant descriptions. Review the
complete diff, exercise critical geometry and orphan-cleanup mutations, and
address important findings with failing-first regressions. Run typecheck and
the full suite on the branch, commit, merge to main, verify both gates on main,
then close nh1t.2, push main and Beads, and clean up the feature branch. Preserve
the user's pre-existing _my files throughout.
