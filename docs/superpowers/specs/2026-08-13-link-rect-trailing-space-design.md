# A link rect stops at its last glyph

Design for `aspose-pdf-foss-for-ts-2avp`, a P3 follow-up filed during `gl6o.3.3`
(Markdown tables and links in flow) and recorded there as a known limitation.

## Problem

A `/Link` annotation's rect covers the segment its run painted, and that segment
includes the separator space between two words. The space belongs to the run
that *precedes* it — a `layout.ts` invariant, because that run's `Tf` is in
force when the space paints — so a linked run followed by more text paints one
space after its last glyph, and the rect covers it.

Measured, rather than assumed from the invariant:

| Case | Link run text | Segment painted | Overshoot @12pt |
|---|---|---|---|
| mid-sentence | `docs` | `docs ` | 3.34pt |
| run text ends with a space | `docs ` | `docs ` | 3.34pt — layout normalises |
| run text *starts* with a space | ` docs` | `docs ` | 3.34pt — the leading space moves out |
| **justified** | `docs` | `docs ` | **6.16pt** — `Tw` widens the trailing space |
| end of a wrapped line | `docs` | `docs ` | 3.34pt |

Three facts the measurement settles:

1. It is always exactly one **trailing** space. A leading space never survives
   into the linked run's segment, so only one end needs trimming.
2. Justification makes it worse, because `Tw` widens that space along with every
   other one. The fix must account for `Tw` or it under-trims a justified line.
3. Nothing misbehaves — no viewer is confused. The symptom is a hand cursor over
   3-6pt of blank space after the link text, which reads as sloppy rather than
   broken.

## Scope

In scope: trimming trailing spaces from the `/Link` annotation rect.

Out of scope, each for a stated reason:

- **Run decoration.** An underline, strikethrough or background on the same run
  keeps spanning the space. It is shipped typography fenced by
  `test/rich-runs-identity.test.ts`, so trimming it would move bytes for callers
  who never asked; and the two concerns differ — a link rect is an interaction
  target where a stray 3-6pt is felt directly, an underline is not. If the
  inconsistency ever grates, it is its own decision with its own hash
  regeneration.
- **Changing which run owns the separator space.** That is the `layout.ts`
  invariant every existing caller's bytes depend on.
- **Leading whitespace.** Measured as impossible: layout moves it to the
  preceding run.
- **U+00A0.** A code block substitutes it for every space so indentation
  survives (`preformat`). It is a real glyph the author asked for, not a
  separator.

## Architecture

One field on an existing internal type, and one subtraction. No new modules, no
public surface change.

```
stamp.ts   SegmentBox.trailing   NEW — points of trailing space inside `width`
           segmentBoxes()        computes it; gains a `runs` parameter
           runLinkBoxes()        subtracts it from the rect's right edge
           runDecorOps()         ignores it — decoration is unchanged
```

`segmentBoxes` is the single walk that already folds `Tw` into each segment's
drawn width, so it is the one place that knows both the segment's text and the
`Tw` in force. Computing `trailing` anywhere else means re-deriving one or the
other.

```ts
interface SegmentBox {
  run: number; x: number; baseline: number; width: number;
  /** Points of trailing space included in `width`.
   *
   *  The separator between two words belongs to the run that PAINTS it, which
   *  is the preceding one — so a linked run followed by more text paints a
   *  space after its last glyph. A link rect trims this; decoration does not. */
  trailing: number;
}
```

computed as

```ts
const tail = seg.text.slice(seg.text.replace(/ +$/, '').length);
const trailing = tail === ''
  ? 0
  : r.layout.driver.measure(tail, r.layout.fontSize) + tw * tail.length;
```

Three details, each load-bearing:

- **`/ +$/`, not `/\s+$/`.** JavaScript's `\s` matches U+00A0, which a code
  block deliberately paints for every space. It also matches what
  `justifySpacing` counts, which is `ch === ' '` exactly.
- **Measured through the run's own driver**, not a constant, so an embedded
  font's space advance is right.
- **`+ tw * tail.length`** because `width` already includes the `Tw` those
  spaces gained; subtracting only the nominal advance under-trims a justified
  line by 2.8pt in the measured case.

`segmentBoxes` gains a `runs: ResolvedRun[]` parameter to reach the driver. It
has one caller, `buildRunBlockBody`, which already holds them.

`runLinkBoxes` subtracts:

```ts
rect: [b.x, baseline + descent, b.x + b.width - b.trailing, baseline + ascent]
```

`placeRunLinks` already skips zero-area boxes, so a linked run that is entirely
whitespace places no annotation.

## Invariants

To be recorded in `CLAUDE.md`:

- **A link rect stops at the last glyph; run decoration does not.** The
  separator space belongs to the run that paints it, so both would otherwise
  include it. They are deliberately different: an interaction target versus
  typography, and only one of them is byte-fenced.
- **Trailing-space trimming counts U+0020 only.** `\s` would eat the U+00A0 a
  code block paints for indentation.
- **The trim subtracts `Tw` as well as the nominal advance.** `width` already
  includes it.

## Error handling

None. No new option, no new argument, no new failure mode. A segment with no
trailing space yields `trailing === 0` and an unchanged rect.

## Testing

The obvious anchor does not work and the test must not pretend otherwise:
`GetTextFragments` reports the fragment as `"docs "`, *including* the space, so
asserting `rect === frag.quad` asserts exactly the behaviour being removed.

- **Differential on the input, not on the implementation.** Render one linked
  run twice — once followed by more text, once as the final run, where layout
  appends no separator at all — and require the two rect widths to match. That
  states the property directly: a trailing separator contributes nothing to the
  rect. It varies the input through one code path rather than comparing a
  fixture against the parser that produced it.
- **Bounded against the fragment.** The rect's right edge sits strictly inside
  the fragment's, and by no more than one space advance — which catches an
  untrimmed rect and an over-trimmed one with the same assertion.
- **A justified case**, since `Tw` is the half that is easy to get wrong: 6.16pt
  of overshoot versus 3.34pt unjustified, in the measured example.
- **Decoration is unchanged**, asserted rather than assumed: a run carrying both
  a link and an underline yields an underline wider than its link rect by the
  trimmed amount, with the underline read from `GetPaths` — a different
  extractor from the annotation dict.
- **A whitespace-only linked run places no annotation.**
- **A code block's U+00A0 runs are untouched**, guarding the `\s` trap
  directly rather than through a rendering that would not reveal it.
- **`test/rich-runs-identity.test.ts` stays green**, and that is checked rather
  than assumed — it is what proves decoration and emission did not move.

## Public surface

None. `SegmentBox` is module-private to `stamp.ts`, and the change is visible
only as a slightly narrower `/Link` `/Rect`.

`README.md`'s Markdown limitation sentence — "A link's rect includes the
separator space owned by the linked run, so it can run about one space wider
than its glyphs" — is removed, since the limitation no longer exists.
