# Rich inline runs in the Flow text engine

Design for `aspose-pdf-foss-for-ts-gl6o.3.1`, the first of three pieces of
`gl6o.3` (Render Markdown into Flow and directly onto a page), itself the third
child of the `gl6o` epic.

## Problem

`gl6o.3` as filed is three separable pieces of work, and this is the one the
other two stand on.

The Flow text pipeline is **single-style end to end**. `Flow.AddParagraph(text,
options)` takes a plain string and one set of options;
[layout.ts](../../../src/layout.ts)'s `layoutText` wraps a string through one
`FontDriver` at one size; [stamp.ts](../../../src/stamp.ts)'s `buildBlockBody`
emits one `Tf` and one `rg` for the whole block; and the overflow remainder that
drives pagination is a `string`.

A Markdown paragraph is a sequence of mixed runs — `**bold**`, `*italic*`,
`` `code` ``, `[link](/x)`. There is no way to express one through this engine,
so `gl6o.3.2` (the AST → Flow mapping) cannot begin until wrapping, emission and
the remainder all carry runs.

This issue produces no Markdown. It produces rich text, and the guarantee that
every existing caller is byte-identical afterwards.

## Scope

In scope: a `TextRun` model, accepted by the wrapped-text entry points; one
wrapping engine that carries runs; per-run emission, decoration and measurement.

Out of scope, each for a stated reason:

- **Markdown.** The mapping is `gl6o.3.2`; tables and links in flow are
  `gl6o.3.3`. Nothing here imports `mdast.ts`.
- **Complex-text shaping with runs.** `{ shape: true }` plus a run list throws
  `UnsupportedFeatureError`. BiDi reordering runs across a whole paragraph, and
  how a bidi-run boundary should interact with a style boundary is a real
  question this piece does not need to answer.
- **Per-line leading.** The block's leading governs (see Limitations).
- **Runs in `AddText`.** The single-line stamp does no wrapping and nothing
  needs runs there.

## Architecture

### The run model

```ts
export interface TextRun {
  text: string;
  font?: AuthoringFont;
  fontSize?: number;
  color?: [number, number, number];
  underline?: Decoration;
  strikethrough?: Decoration;
  background?: Background;
}
```

The split is **character-level versus line-level**. A run may override the seven
properties above. Everything describing a *line* — `align`, `valign`, `leading`,
`rotate`, `opacity`, `behind` — stays on the block options and governs all of
it. Any property a run leaves unset falls back to the block's, so
`[{ text: 'a' }, { text: 'b', font: 'Helvetica-Bold' }]` inherits size and
colour from the paragraph rather than restating them.

Runs are accepted wherever a wrapped string is accepted today, through overloads
that leave existing call sites typed exactly as they are:

```ts
AddTextBlock(text: string,    rect, options?): string | null;
AddTextBlock(runs: TextRun[], rect, options?): TextRun[] | null;
```

`Page.AddTextBlock` is public API returning `string | null`; widening the
parameter without overloading would widen that return and break every consumer
that assigns it. `Flow.AddParagraph`, `Flow.AddHeading` and `FlowListItem.text`
take the same union and are chainable, so they raise no return-type question.

### Where the run model lives

`TextRun` names an `AuthoringFont`, a `Decoration` and a `Background`, and
`AuthoringFont` is defined in `stamp.ts` — which imports `layout.ts`. Putting
the type in `layout.ts` would invert that dependency.

It goes in **`textdecor.ts`**, which already owns `Decoration` and `Background`,
already takes `AuthoringFont` as a type-only import, and is described in
`CLAUDE.md` as the decoration vocabulary shared by every text producer. A run is
the same kind of thing: styling vocabulary, no PDF objects, no layout.

`layout.ts` keeps its purity — it never sees an `AuthoringFont` today and will
not start. `layoutRuns` works over **resolved** runs:

```ts
interface ResolvedRun { text: string; driver: FontDriver; fontSize: number; style: RunStyle }
```

exactly mirroring how `layoutText` already takes a `FontDriver` rather than a
font object. `stamp.ts` owns the resolution step — validate each run, build its
driver, fill unset properties from the block — and it is the only module that
does, so a run cannot be resolved one way for measurement and another for
painting.

Validation is per run and reuses the existing rules: `validateFont`, the
positive-finite `fontSize` check, the `[r,g,b]`-in-0..1 colour check, and
`validateDecoration`/`validateBackground`. As everywhere else in this codebase,
a rejected call must leave the document untouched, so every run in the list is
validated before any byte is emitted.

`wrapLines` (used by [toc.ts](../../../src/toc.ts)) stays string-only. Nothing
asks a table of contents for mixed styling, and leaving its signature alone
keeps one more caller in the byte-identity corpus for free.

### One wrapping engine, not two

`layoutText` becomes a thin wrapper: it builds a single run and calls a new
`layoutRuns`, which is the only word-wrapping code in the module. This is not
tidiness. The same engine is what [floatbox.ts](../../../src/floatbox.ts) and
[tableauthor.ts](../../../src/tableauthor.ts) *measure* through while
[stamp.ts](../../../src/stamp.ts) *paints* through it; a second wrapper lets a
box measure one way and paint another, which is the shape of bug this codebase
keeps recording invariants about.

Two structures change:

- **`LaidLine` gains `segments`** — the per-run pieces of that line, each with
  its own text, resolved style, measured width and encoded bytes. `text` and
  `width` remain the concatenation, so the justification gap count and the
  existing decoration geometry keep working untouched.
- **`LayoutResult.remainder` becomes `TextRun[]`.** Wrapping mid-run has to
  split that run and carry its style forward. The string entry points flatten it
  back to a string on the way out, which is lossless because a one-run input can
  only ever produce one-run output.

**Invariant:** word boundaries are computed on the **concatenated** line text,
not per run. `**bold**text` is one word and must never break between its two
runs. The wrapper joins the runs, finds break opportunities on the joined
string, and maps the chosen breaks back onto run offsets. Splitting each run and
wrapping it independently is the obvious implementation, is simpler, and is
wrong — and it is wrong in a way that looks like a font problem rather than a
wrapping one.

### Emission

`buildBlockBody` walks segments instead of whole lines: emit `Tf` when the
(font, size) pair changes, `rg` when the colour changes, then `Tj` with that
segment's bytes. No per-segment `Td` — `Tj` advances the pen by the string's
own width.

The Standard-14 versus embedded distinction is **not** the boundary it appears
to be: an embedded font's `FontDriver.encode` already returns Identity-H bytes
that go out through the same `Tj`, which is why `buildBlockBody` handles both
today. The genuinely separate path is `buildShapedBlockBody`, and shaping stays
single-run. So one line may freely mix an embedded body face with Standard-14
Courier — the case Markdown actually needs, since Courier costs nothing to embed
and is always available.

### Justification

`align: 'justify'` falls back to `'left'` when **any** run uses an embedded
font. This extends the rule already at `normalizeBlockOptions`, for the same
reason: `Tw` moves only single-byte code 32 and is inert for 2-byte Identity-H
text. Stated over a set of runs rather than over one font.

The interaction is sharper than it looks. `Tw` changes the pen advance of a
space, and alignment is computed from measured widths; if a `Tw` were in force
while an Identity-H segment painted, the pen would advance by an amount the
measurement did not predict and the rest of the line would drift.

### Decorations

`decorRects` takes one `LineBox` per line today. It gains per-run boxes:

- A **block-level** decoration still produces one box per line — byte-identical
  output when no run overrides anything.
- A **run-level** decoration produces a box spanning just that run's extent
  within the line: x is the line's start plus the widths of the preceding
  segments, width is the segment's own width, and thickness and offset come from
  that run's own vmetrics and size rather than the block's.

This is what makes a link underline and a `code` background possible in
`gl6o.3.2`.

## Limitations

**Leading stays block-level.** `usedHeight = lines × leading` is baked into flow
pagination, measurement and decoration geometry, so a run whose `fontSize`
exceeds the block's can collide with the line above. Variable per-line leading
is a separate change to the height model, not a detail of this one. Markdown's
runs are the same size as their paragraph or smaller, so nothing in `gl6o.3.2`
depends on it — recorded here so it is read as a decision rather than an
oversight.

## Testing

**The load-bearing test is byte-identity.** Every existing string call site —
`AddTextBlock`, a Flow paragraph, a Flow heading, a list item, a table cell, a
floating box — must produce the same content-stream bytes after this change as
before. Captured as fixtures from the current implementation before the
refactor and asserted on saved bytes, this is what makes a one-run wrapper over
a rebuilt engine safe to land. Nothing else in the suite would notice a
half-point drift in a table cell.

Then, each pinned by breaking its path and confirming a red build:

- **`layoutRuns`**, directly: a word spanning a run boundary does not break
  there; a wrap that falls inside a run splits it; the remainder carries the
  split run's style, not the block's.
- **Emission**: per-run `Tf` and `rg` appear in the content stream, and one line
  mixes a Standard-14 face with an embedded one.
- **Justification**: an embedded run anywhere in the block drops the whole block
  to left alignment.
- **Decorations**: a run-level underline's rect spans that run's extent and no
  more, with its own thickness.
- **Shaping**: `{ shape: true }` with a run list throws
  `UnsupportedFeatureError`.
- **End to end**: `GetTextFragments()` over a rendered rich paragraph reports
  each fragment with the font it was given. This reads the *result* rather than
  the emitter that produced it — the differential-testing rule from `CLAUDE.md`,
  which is why it is worth having beside the emission assertions.

## Files

| File | Change |
|---|---|
| `src/textdecor.ts` | `TextRun` and `RunStyle`; per-run decoration boxes |
| `src/layout.ts` | `layoutRuns` over resolved runs, `LaidLine.segments`, run remainder; `layoutText` becomes a one-run wrapper |
| `src/stamp.ts` | run resolution and validation, per-run emission in `buildBlockBody`, run overloads on `stampTextBlock`/`flowTextBlock`/`measureTextBlock`, justify rule, shaping guard |
| `src/flow.ts` | `string \| TextRun[]` on `AddParagraph`, `AddHeading`, `FlowListItem.text`; run remainder through `TextElement` |
| `src/page.ts` | `AddTextBlock` overloads |
| `src/index.ts` | export `TextRun` |
| `src/toc.ts` | unchanged — `wrapLines` stays string-only |
| `test/rich-runs.test.ts` | new — the engine, emission, justify, decoration and shaping cases |
| `test/rich-runs-identity.test.ts` | new — the byte-identity corpus |
| `README.md` | rich runs in Features and the API overview |
| `CLAUDE.md` | the one-engine and word-boundary invariants |
