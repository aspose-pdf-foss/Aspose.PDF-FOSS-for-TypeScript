# Rectilinear Annotation Measurements Implementation Plan

**Goal** Add `Measure` and the `measure` creation option to line, polyline, and polygon annotations.

**Spec** [Rectilinear annotation measurements](../specs/2026-11-19-annotation-measure-design.md).

1. Extend the annotation fixture builder with a manually assembled PDF holding an indirect `/Measure` and number-format objects. Add tests for reading it, creating and reopening all three subtypes, malformed and unsupported metadata, defensive snapshots, and validation before attachment.
2. Run `npm test -- test/annotation-measure.test.ts` and confirm the tests fail on missing behavior.
3. Implement the rectilinear codec in `src/measure.ts` and delegate from `src/annotation.ts`. Build each creation dictionary before attaching the annotation. Export the measure types and the two annotation classes.
4. Pin PDFDocEncoding interoperability and PDF 1.7 declarations for full and incremental saves. Update README examples and API rows, the architecture brief, and the Unreleased changelog. Run the focused annotation, encoding, incremental save, and public API tests and review the diff.
5. Merge to `main`, run `npm run typecheck` and `npm test`, then close `k4h1.3`, push `main`, and sync Beads.
