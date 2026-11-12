# Selectable OpenType features on text runs

Design for `aspose-pdf-foss-for-ts-nh1t.3`.

Status: approved by the user on 2026-11-12, including independent styled-span
shaping and the paragraph-wide bidi limitation below.

## Intent and scope

Let callers request font-provided old-style figures (`onum`), small capitals
(`smcp`), stylistic sets (`ss01` through `ss20`), and disable standard ligatures
(`liga`). The same selection must govern measurement, wrapping, drawing,
subsetting, and Unicode extraction.

The user selected support for individual `TextRun`s and existing shaped calls.
This includes page text, wrapped blocks, and their existing Flow/table consumers.
It does not add feature parsing to HTML/CSS, Markdown, or DOCX import.

## Approaches

1. Expose feature selection only on existing string-based shaped calls. This
   is smaller, but cannot mix feature choices in one rich block. The user
   selected the broader approach instead.
2. Add a shared feature-selection option and use the existing shaper for each
   resolved rich-text span. This reuses the existing layout and emission
   engines and supports independent feature choices without a second wrapper.
   This is the selected approach.
3. Replace rich layout with a paragraph-wide attributed bidi/shaping engine.
   This would additionally reorder style spans across a mixed-direction
   paragraph, but substantially expands this issue beyond selectable features.
   It is outside this proposal.

## Public API and defaults

Use an optional boolean map, `features?: Readonly<Record<string, boolean>>`,
on shaping options for `AddText`, `AddTextBlock`, `MeasureText`, and `TextRun`.
Keep the existing opt-in: features take effect only when shaping is enabled
for an embedded font. A feature map alone does not enable shaping.

```ts
const font = doc.AddFont(bytes, { shape: true });
page.AddText('123 fi', 72, 700, {
  font, features: { onum: true, liga: false },
});
page.AddTextBlock([
  { text: 'Small capitals ', features: { smcp: true } },
  { text: '123', features: { onum: true, ss01: true } },
], [72, 500, 400, 100], { font, fontSize: 12 });
```

`TextRun` also gains `shape`, `dir`, `script`, and `language` overrides so
its shaping settings can be resolved by the same rules as a block. Undefined
run settings inherit from the block; `shape` then falls back to the resolved
font's existing `shape` flag. Merge feature maps by tag: font-independent
defaults, block overrides, then run overrides. No font-level feature map is
introduced. An empty run map inherits block selections; `false` explicitly
disables an inherited feature. Never mutate a caller's map.

Without overrides, keep the current general GSUB features (`ccmp`, `liga`,
`rlig`, `calt`), GPOS features (`kern`, `mark`, `mkmk`), and Arabic joining.
Enabling an arbitrary valid tag makes it eligible in both GSUB and GPOS;
each table and selected script/language determines whether it exists.
Unknown or absent features are harmless. Apply lookups in the font's lookup
order, with existing deduplication, independent of map insertion order.
Joining-form tags (`init`, `medi`, `fina`, `isol`) remain positional and must
never be applied to every glyph; `false` may suppress their positional pass.

Feature tags must be exactly four printable ASCII characters and values must
be booleans. Invalid maps throw `TypeError`, following the authoring option
validation convention. Validate before document mutation, including invalid
maps on later runs. Alternate indices, ranges, and variation coordinates are
outside this boolean API. Standard-14 fonts keep their existing unshaped path.

## Rich-run shaping boundary

Each style span on a laid line is shaped independently. A run boundary is a
hard shaping boundary: ligatures, joining, and contextual substitutions do
not cross it. Adjacent runs are not merged merely because their settings match.
The layout engine keeps its existing source-run order; bidi reorders glyphs
inside each shaped span, not the collection of style spans in a paragraph.
Document this limitation explicitly. This proposal does not claim general
mixed-direction paragraph shaping across rich-run boundaries.

An existing string-based shaped block continues to shape each whole line.
Tabs combined with shaping retain their current rejection. For rich blocks,
validate that restriction against every effectively shaped run, including
one whose embedded font supplies the shaping default.

## Implementation boundaries

- `shape.ts` resolves enabled GSUB/GPOS feature sets once per shaping call;
  passes them to segments; filters the positional Arabic pass separately.
  `otlayout.ts` retains ownership of script/language lookup selection.
- `stamp.ts` passes selections through all string measuring and drawing paths,
  including `shapeOptsFrom`. Resolve each rich run into a matching measuring
  driver and optional shaped-emission settings. Preserve the old unshaped
  byte path when no run shapes.
- Keep `layoutRuns` as the single wrapping engine. Resolve shaping before
  layout and shape the same emitted span text for painting. Audit greedy
  packing and segment consolidation so feature-dependent contextual widths
  agree with final spans, rather than assuming additive character widths.
  Measurements must not record glyphs or mutate the document.
- Rich emission uses the existing positioned-glyph emitter and records the
  actual selected glyphs through `EmbeddedFont.shapeRuns`. Compose GPOS
  vertical offsets with `TextRun.rise` and restore text state for following
  spans. Link rectangles, backgrounds, and decoration widths use the same
  shaped advances as layout.
- Audit Flow, table-cell measurement, TOC measurement, continuation/remainder
  cloning, and undrawable reporting for bypasses of resolved shaping options.
  Preserve feature maps in remainders and preserve references without mutation.
- Update README examples, API member descriptions, limitations, and CHANGELOG
  in the implementation commit. Keep zero runtime dependencies and ESM imports.

The builder may choose whether the shared map type merits a named public
export, how to organize internal option helpers, and the smallest coherent
refactor needed to share the shaped driver. Any public export must get its
README API row and accurate export counts.

## Verification

Use TDD with the existing synthetic OpenType font builder. Tests must observe
glyph IDs and widths rather than only the presence of feature options.

- Default shaping remains unchanged; `liga: false` prevents the existing
  `fi` substitution and changes measured width accordingly.
- `onum`, `smcp`, and stylistic-set tags select non-cmap replacement glyphs;
  cover `ss01` and `ss20`, missing tags, and language/script selection.
- GPOS disabling (`kern: false`) changes advance and emitted positioning.
- Block/run map inheritance, independent adjacent choices, run-level shaping
  override, and feature retention in overflow all produce the expected glyphs.
- Feature-sensitive wrapping agrees with drawn positions and measurement in
  page blocks, Flow, and table cells; speculative measurement records no glyphs.
- Unicode survives Save/Open for alternates and ligatures; the subset contains
  the selected non-cmap glyphs. Existing unshaped byte-identity tests stay green.
- Positioning tests cover run rise plus GPOS offsets and the following span's
  restored state, link/decor widths, and rejected shaped tabs without mutation.
- Invalid feature selections, including a bad later run, leave Save bytes
  unchanged; absent features do not throw.

Baseline: the four existing shaping/rich-run test files passed, 44 tests.
Before completion, run `npm run typecheck` and `npm test`. Follow repository
commit/push and Beads sync instructions; keep the issue in progress until the
selected scope is implemented and verified.
