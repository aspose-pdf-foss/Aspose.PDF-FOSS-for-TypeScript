# Vertical Flattening Implementation Plan

Use superpowers:executing-plans inline and test-driven-development. Track task
progress and implementation rulings in bd, as the repository requires.

**Goal:** Flatten transparent pages containing vertical text while retaining
Unicode, ordering, font sizes and selection geometry.

**Architecture:** Extend glyphless.ts with glyph-sequence/advance assignment
and an optional Identity-V font. pdfaflatten.ts writes each vertical source
glyph through that font at its original size and composed transform. Existing
horizontal and OCR callers keep their defaults.

**Tech Stack:** TypeScript NodeNext ESM, Node built-ins, vitest.

**Spec:** docs/superpowers/specs/2026-11-17-vertical-flattening-design.md, approved
by the user on 2026-11-17 with instructions to implement.

## Global constraints

Zero runtime dependencies. No new public option or export. Two-byte codes start
at one, with an atomic 65,535-entry limit. Every installed page's fonts are
complete before yielding. Preserve page atomicity and existing cleanup rules.

## Review focus

Repeated Unicode with different advances must select different metrics.
Multiple code points in one glyph must retain one selection cell.
Mixed writing modes must reset font size, Tz, Tc and Tw between shows.
Zero font size must retain spacing without division by zero.
Cancellation must leave complete mappings on the pages already installed.

## Task 1 — Vertical glyphless font

Modify src/glyphless.ts and test/glyphless.test.ts.

Add `GlyphlessCodes.encodeGlyph(text: string, advance: number): number` and
`verticalWidths(): PdfObject[]`. Key codes by full Unicode text and finite
advance. Keep encode(text), maxCode and entries() compatible. Add optional
third argument `vertical = false` to createGlyphlessFont(alloc, replace,
vertical). Vertical fonts use Identity-V, DW2 [880, -1000] and W2 triples from
verticalWidths(); finish still writes ToUnicode and maps each code to GID 1.

First write tests for sequence reuse, distinct metrics, complete Unicode
strings including astral code points, invalid advances and atomic exhaustion.
Font tests decode the result through TextFont and assert wmode 1, per-code
advances, position vectors and the GID map. Run `npm test --
test/glyphless.test.ts`, observe the missing-feature failure, implement, then
rerun the file. Commit the tested font change with its changelog entry.

## Task 2 — Vertical reconstruction and integration

Modify src/pdfaflatten.ts and test/pdfa-flatten-transparency.test.ts. Add focused
geometry coverage in test/pdfa-flatten-vertical.test.ts using the existing PDF
and embedded ink-font fixture builders.

textLayer consumes separate horizontal and vertical GlyphlessCodes instances.
For vertical glyphs emit one code at g.tfSize with the composed linear matrix
and the rise-adjusted pen specified by the design. Encode g.advance into W2;
reset spacing, except that zero-size glyphs carry effective source spacing in
Tc. Font selection and horizontal scaling must reset on writing-mode switches.
Allocate and finish only fonts whose assigners contain codes. Remove the
vertical refusal and retain tagged-page handling.

Change the existing refusal test to expect a rasterization action and preserved
mixed-direction text/quads. Run it and observe failure before changing the
flattener. Add known-coordinate tests for default and varied advances, repeated
Unicode, ligatures/astral mappings, original sizes, rise, Tc/Tw/TJ, upward and
zero advances, zero size, nested/repeated transformed forms and rotated cropped
pages. Compare per-glyph Unicode, vertical flag, effective size, quad and pen
end before/after and after Save/Open. Assert GetText and Search geometry,
nonzero source determinants, visible raster equality at 72 DPI and PDF/A-1
validation. Cover sync/async equivalence and cancellation after a vertical page.

Run the vertical, transparency, glyphless, vertical-writing, OCR and conversion
control test files and typecheck. Observe green before committing.

## Task 3 — Review and delivery

Update README's vertical limitation and CLAUDE.md's pdfaflatten/glyphless
invariants. Exercise mutations to Identity-H, uniform W2, code-point splitting
and normalized font sizes and confirm each relevant test fails, restoring each
mutation before the next. Review the complete branch with a fresh reviewer.
Resolve important findings using failing-first regressions.

Run npm run typecheck and npm test. Commit all issue changes, integrate using
the repository's authorized main workflow, and verify required gates on main
before closing izia. Push code and sync Beads. Preserve the existing _my files.
