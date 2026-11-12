# Selectable OpenType Features Implementation Plan

Goal: enable boolean OpenType feature selections on existing shaped calls and
individual rich-text runs, with matching widths and emitted glyphs.

Spec: [approved design](../specs/2026-11-12-opentype-features-design.md).

Architecture: keep feature selection in the shaper, share resolved shaping
settings and measuring drivers across authoring consumers, and retain
`layoutRuns` as the single wrapper. Shape rich spans independently at their
existing run boundaries. Use TypeScript, Vitest, and the existing synthetic
OpenType fixture builders; add no runtime dependencies.

Execution: proposed native execution in this session, followed by independent
whole-branch review. Beads `nh1t.3` tracks progress; the sections below describe
implementation units rather than a second task tracker.

## Global constraints

- Shaping remains opt-in for embedded fonts; Standard-14 stays unshaped.
- Map values are booleans and tags are four printable ASCII characters.
- Merge block/run feature maps by tag, without mutating either map.
- Defaults and unshaped page bytes remain unchanged.
- Preserve positional Arabic joining; never enable its tags over a whole buffer.
- Rich run boundaries are hard shaping boundaries, with source-order spans.
- Tabs plus effective shaping are rejected before mutation.
- Measurement records no glyphs. Drawing alone records used glyphs.
- ESM/NodeNext imports carry `.js`; README documents any new public export.

## Review focus

- Cross-space GSUB/GPOS can make additive word widths disagree with emitted spans.
- GPOS text rise must compose with a run's rise and restore the following span.
- A shaping-default font introduced on a later run must affect validation too.
- Table sizing and auto-fit must use the same selected glyph advances as paint.
- Invalid maps on late runs and speculative measurement must leave Save unchanged.

## Task 1: Feature resolution and existing shaped calls

Files: `src/shape.ts`, `src/stamp.ts`, `src/page.ts`, `src/toc.ts`,
`test/shape-features.test.ts`, `test/shape-authoring.test.ts`, and existing
`test/helpers/build-sfnt.ts` if an extra lookup fixture is needed.

Interface: extend `ShapeOpts` with
`features?: Readonly<Record<string, boolean>>`; carry that field on
`StampOptions` and `Page.MeasureText` options. Extend internal `measureText`
with a final optional feature-map argument so existing positional callers
remain compatible. `shapeOptsFrom` forwards the map. Keep helpers internal
unless sharing them with another source module is necessary.

1. Write shaper tests: nominal `f=10`, `i=11`, `fi=20` gives `[20]` by default,
   `[10,11]` with `liga:false`; `onum`/`smcp`/`ss01`/`ss20` single substitutions
   give their literal replacement GIDs only when enabled. A missing tag is
   unchanged. A `kern` pair at -40 units disappears with `kern:false`.
   Assert map insertion order does not change lookup ordering and Arabic
   `init:false` suppresses only that form. Invalid tags/values throw TypeError.
2. Run `npx vitest run test/shape-features.test.ts` and confirm missing-feature
   failures before implementation.
3. Resolve enabled general features by applying overrides to the existing
   defaults, excluding the four positional Arabic tags from general GSUB.
   Filter the joining pass by explicit false overrides. Validate maps before
   the empty-input return and before authoring mutates anything.
4. Add page tests: `MeasureText('fi',12,font,{features:{liga:false}})` returns
   25.2pt rather than 24pt for the existing builder's 1000/1100/2000 advances;
   `AddText`/string `AddTextBlock` emit the corresponding GIDs and Save/Open
   extracts original Unicode. With shape off, bytes stay unchanged. TOC
   number sizing and drawing forward the same selections.
5. Run the new tests to observe the forwarding failures, implement forwarding
   through page/stamp/TOC, and rerun feature and existing shaping tests.
6. Commit the independently testable feature-control change with its tests.

## Task 2: Rich-span measurement and positioned emission

Files: `src/textdecor.ts`, `src/stamp.ts`, `src/layout.ts`,
`src/otemit.ts`, `src/textcoverage.ts`, `test/rich-run-features.test.ts`,
and existing rich-run tests whose explicit unsupported-shaping contract changes.

Interfaces: `TextRun` gains optional `shape`, `dir`, `script`, `language`,
and the same feature-map type. Resolved runs carry `ShapeOpts | undefined`
for their own embedded font. A shared internal driver resolver must provide
pure measure/probe and non-recording layout encoding for shaped runs; actual
emission calls `EmbeddedFont.shapeRuns` and existing `emitLine`.
If a new shared source module is needed to avoid cycles, document it in
CLAUDE.md and keep it out of public index exports.

1. Write tests with two adjacent runs sharing a font but different maps:
   one `smcp` span emits its alternate GID while the next emits nominal text;
   block `onum:true` plus run `liga:false` preserves both settings. Empty run
   maps inherit; explicit false cancels a block selection. Run `shape:false`
   overrides a shaping-default font, while `shape:true` enables another run.
   Confirm failures before adding resolution and replacing blanket rejection.
2. Resolve and validate every run before layout. Build shaped measuring drivers
   and route shaped emission through positioned glyphs, leaving unshaped
   emission unchanged. Overflow cloning retains all source options.
3. Add a contextual-width fixture crossing a word/space boundary: use a known
   ligature or pair adjustment so a candidate line fits only after whole-span
   shaping. Assert the literal line count, shaped width, and following run's
   x position. Observe failure, then adapt packing/final segment widths only
   where a non-additive shaped driver is present; preserve the existing lazy
   unshaped packing path and its performance tests.
4. Add tests for selected-feature overflow across boxes, a run-local Arabic/RTL
   span, no joining across two runs, and rejected tabs with a later shaped
   run. Invalid maps on a late run leave Save bytes unchanged.
5. Add GPOS vertical-placement tests with a nonzero run rise and a following
   unraised run; assert composed positions, restored state, and link/decor
   geometry. Extend `emitLine` with an optional base rise or equivalent
   internal composition without changing existing zero-rise output.
6. Verify speculative measuring preserves `usedGids` and `toUnicode`; drawing
   records selected alternate GIDs and Save/Open restores source Unicode.
   Update the old rich-runs rejection test to exercise actual supported
   shaping. Run the focused feature/rich-run/identity/layout suites and commit.

## Task 3: Shared consumers, documentation, and whole-branch verification

Files: `src/tableauthor.ts`, `src/textextents.ts`, `src/flow.ts`, and other
actual option-forwarding consumers found by search; `test/table-cell-runs.test.ts`,
`test/rich-run-features.test.ts`, relevant Flow tests, README.md, CHANGELOG.md,
and CLAUDE.md if the architecture gains a helper module.

Interfaces: table measurement and intrinsic sizing use the same pure shaped
driver and per-run inheritance from Task 2. Existing string-table APIs need
no new block-level feature option; run-level maps work through `TextRun`.
Flow/TOC options that already inherit text options forward feature maps.

1. Add failing table tests where selected `onum` advances change auto-fit
   width and row wrapping. Assert literal widths/heights and drawn glyphs;
   repeat measurement without growing font usage. Add a Flow continuation
   case whose later page preserves its per-run map and selects the alternate.
2. Implement forwarding through table sizing, intrinsic extents, coverage
   reporting, and Flow call sites that reconstruct options. Retain pure
   measurement and existing unshaped output paths. Run the focused suites.
3. Document the exact boolean map syntax, inheritance, opt-in requirement,
   harmless missing features, span-local shaping/bidi limitation, and tab
   restriction. Add a user-visible Added changelog entry citing nh1t.3.
4. Run `npm run typecheck` and `npm test`; both must pass. Run build if public
   declaration changes warrant checking package emission. Have a fresh reviewer
   inspect the final branch against the approved spec and fix material findings.
5. Commit, update Beads, pull/rebase and push the branch, and run `bd dolt push`.
   Report verified results and integration status; do not close an issue while
   required implementation or validation remains outstanding.
