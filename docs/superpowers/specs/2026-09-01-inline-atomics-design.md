# Inline atomics in layoutRuns — design

**Issue:** `zch2.11` — an image on a line of text.

**Goal:** let the one wrapping engine place a non-text box in a line, so an
`<img>` among words renders instead of being reported. `cssflow.ts` loses its
two atomic skip sites.

## What the issue got right, and what it got wrong

The issue named four obstacles. Two are smaller than it thought and two more
exist that it did not name. Recording both directions, because the wrong ones
would have shaped the work.

**Smaller than feared — word units.** The issue expected "the unit builder and
the UAX #14 break search both need a non-text unit". They do not. `layoutRuns`
is index-based over a concatenated string with an `owner` array mapping
character to run, so an atomic can simply BE a character: **U+FFFC OBJECT
REPLACEMENT CHARACTER**, which is what Unicode defines it for. Units build
unchanged, `piecesOf` works unchanged, the remainder reconstruction works
unchanged. `a<img>b` is then one unbreakable unit and `a <img> b` is three —
the correct CSS answer, for free, because U+FFFC is a non-space character.

**Smaller than feared — the baseline model.** The issue expected
`LaidLine.maxFontSize` to be replaced by an ascent/descent model because "an
atomic HAS NO FONT SIZE, so that field cannot answer for it". For
`vertical-align: baseline` an image's bottom sits ON the baseline, so its
above-baseline extent is exactly its height: the field has to be FED, not
replaced. (`top`/`bottom` do force a second term — see below — but that is a
band minimum, not an ascent/descent model.)

**Not named, and it is the real work — the pen does not advance.**
`buildRunBlockBody`'s own comment says it: *"No per-segment `Td` — `Tj`
advances the pen by the string's own width."* An atomic emits no `Tj`, so the
text after an image would overprint it. It needs an explicit `[ -N ] TJ` kern,
and a `TJ` needs a current `Tf` that an atomic has no font to supply.

**Not named — the text path has never drawn an image.** It cannot go inside
`BT…ET`. It becomes a `q … cm … /Im Do … Q` beside the text object, with an
XObject on the page.

## Decisions

**1. Scope is the engine plus HTML.** `layout.ts`, a new `linebox.ts`,
`stamp.ts`, `flow.ts`, `cssinline.ts` and `cssflow.ts`. **Markdown's
`loneImage` lift is a separate issue in `gl6o`'s epic** — `mdflow.ts` and
`mdruns.ts` are not touched here.

**2. `textdecor.ts`'s `TextRun` does NOT change.** Atomics travel in a
PARALLEL channel with `beforeRun` indices — which is exactly what
`cssinline.ts` already emits, so nothing is invented. Every existing consumer
of `TextRun` (`mdruns.ts`, `tableauthor.ts`, `flowtable.ts`, `docmodel.ts`) is
untouched BY CONSTRUCTION, which makes byte-identity for atomic-free input a
structural property rather than something a test has to catch.

**3. `vertical-align` implements `baseline`, `top` and `bottom`.** `middle` is
NOT implemented: CSS defines it against half the x-height, which the AFM
tables do not expose, and an approximation would be a divergence to document
for the commonest case rather than a rule. `middle` and every other value stay
on `zch2.7`'s report as `vertical-align:<value>`, `degraded`.

**4. An over-wide atomic clamps to the box width, aspect preserved.** That is
the rule `flow.ts`'s `image()` already applies to a block image ("clamped down
to the region width if larger"), so it is one rule rather than two.

## Architecture

```
cssinline.ts   already emits { runs: TextRun[], atomics: AtomicInline[] }
      │        with beforeRun indices           (UNCHANGED shape)
      ▼
cssflow.ts     sizes each atomic in CSS px, converts ONCE to points,
      │        passes bytes + box            (drops its two skip sites)
      ▼
flow.ts        paragraph(runs, { atomics })     (new option, additive)
      │        builds the XObject from the bytes, as image() already does
      ▼
stamp.ts       interleaves runs + atomics into ONE LayoutRun[]
      │        emits the TJ kern; draws each image via drawBuiltImage
      ▼
layout.ts      an atomic is a U+FFFC char; width comes from the atomic
      │
      ▼
linebox.ts     ascent + band height from item extents        (NEW, pure)
```

### `src/linebox.ts` — new pure leaf

```ts
export interface LineItem {
  /** Above-baseline extent: a text piece's fontSize, an image's height. */
  ascent: number;
  height: number;
  align: 'baseline' | 'top' | 'bottom';
}
export function lineBox(
  items: LineItem[], leading: number, blockFontSize: number,
): { ascent: number; height: number };
```

**Invariant: it imports NOTHING and knows no font.** Every rule here is
testable from plain numbers with no PDF built — the split `floatstack.ts`,
`booklet.ts`, `tablespan.ts` and `docinfer.ts` each already make, and the
reason is the same: this is geometry that is silently wrong when reversed.

The rules:

- `ascent` = the largest above-baseline extent among **baseline-aligned**
  items, falling back to `blockFontSize` for a line with none. A text piece
  contributes its `fontSize` — the existing conservative convention, which
  already includes descender room — and a baseline-aligned image its full
  height.
- `height` = `max(leading, ascent · leading / blockFontSize, H)` where `H` is
  the tallest **top/bottom-aligned** item. That third term is what `top` and
  `bottom` force: they align to the BAND, not the baseline, so they can make
  the band taller without moving the baseline.
- The baseline sits `ascent` below the band top.

**Invariant, and it is the acceptance criterion: with no atomics this COLLAPSES
to today's arithmetic exactly.** `ascent` reduces to `maxFontSize` and the
third term vanishes, leaving `max(leading, maxFontSize · leading / fontSize)`
character for character. `test/rich-runs-identity.test.ts`'s four hashes
therefore cannot move, and they cannot move by a *collapse* rather than by a
tolerance.

### `layout.ts`

`LayoutRun` becomes a union: the existing text shape, or
`{ atomic: { width: number; height: number; align } }`. An atomic run
contributes exactly one U+FFFC to the concatenated text.

- `spanWidth` returns the atomic's width for a U+FFFC position instead of
  measuring it, and `maxSizeOf` is replaced by a walk that builds `LineItem[]`
  for `lineBox`.
- A `LaidSegment` for an atomic carries `text: ''`, empty `bytes`, its
  `width`, and a new `atomic` field. `segmentBoxes` already advances
  `dx += width` per segment, so run decoration and link rects stay correct
  across an image with no change at all.
- **The clamp lives here**, the only place that knows `boxWidth`: an atomic
  wider than the box scales both dimensions by `boxWidth / width` before
  wrapping, so the band sees the clamped height.
- U+FFFC never reaches a `driver.encode`, so no font is asked to render it.

### `stamp.ts`

- `ResolvedRun` gains the same union internally (`@internal`, so no public
  surface).
- The painter emits `[ -N ] TJ` for an atomic segment, `N = width · 1000 /
  fontSize` of the font in force — borrowed from the neighbouring run, since
  an atomic has none.
- Each image draws through the EXISTING `drawBuiltImage(doc, page, built,
  rect)`, which already handles `/SMask`, resource registration and tagging.
  **No refactor of `imageembed.ts`.** It appends its own content stream, so
  the image lands after the text body — unobservable, because an inline
  atomic's box never overlaps the glyphs it sits between.

### The remainder, and the trap in it

`layoutRuns` returns `remainder: RunSlice[]`, and `stamp.ts` turns that back
into authoring runs through `sliceRuns` — a NEW `TextRun[]` for the next
column, not a re-flow against the same `LayoutRun[]`. So an atomic that does
not fit must be rebuilt into the parallel channel with a **re-based
`beforeRun`**, or an image at a column break silently disappears from the
overflow.

`sliceRuns` therefore gains an atomic-aware sibling returning
`{ runs, atomics }`, and its fixture is an image placed so that it lands in
the overflow rather than the first column. A test that only checks the first
column cannot see this.

### `flow.ts` and `cssflow.ts`

`FlowParagraphOptions` gains `atomics?: FlowAtomic[]`, where a `FlowAtomic` is
`{ beforeRun: number; data: Uint8Array; width: number; height: number; align }`
— **bytes, not a `PdfStream`**, so `cssflow.ts` keeps its rule of touching no
PDF object module. `flow.ts` builds the XObject exactly as `image()` does.

`cssflow.ts` does the CSS sizing: an `<img>`'s used size is its stated
`width`/`height`, else its intrinsic pixel size read as CSS px, with the
aspect preserved when only one is stated. That needs the intrinsic size before
the XObject exists, so `imageembed.ts` exports
`imageSize(data): { width: number; height: number } | undefined` — the pixel
dimensions from the header alone, a header read rather than a decode, and
`undefined` for bytes it cannot read, which sends the image down the existing
`image:<src>`/`dropped` path. The `× 0.75` px→pt conversion then happens once,
in `cssflow.ts`, where CLAUDE.md records that it belongs.

`FlowAtomic.align` is `'baseline' | 'top' | 'bottom'` and nothing else.
`cssflow.ts` maps `ComputedStyle.verticalAlign` onto it and **maps every other
value to `baseline`**, which is what makes decision 3's refusal concrete
rather than a promise.

**The interaction with `zch2.7`'s report, and it must not be missed:**
`cssinline.ts` today reports `vertical-align:<value>` for ANY non-baseline
value on any inline element. For an ATOMIC, `top` and `bottom` are now
implemented, so reporting them would be false. The rule becomes: an atomic
reports `vertical-align` only for a value outside the three implemented ones;
a non-atomic inline is unchanged and still reports every non-baseline value,
because for text none of them are implemented. Two rules where there was one,
and the sweep in `test/htmlreport-render.test.ts` must keep asserting the
non-atomic case so the widening cannot swallow it.

## Error handling

- `layout.ts` still never throws, and `linebox.ts` never throws.
- `flow.ts`'s `paragraph` validates `atomics` as every builder validates its
  options, so a bad atomic is rejected before any byte is emitted — the rule
  every authoring entry point follows.
- An image whose bytes will not decode never becomes an atomic: `cssflow.ts`
  keeps reporting it as `image:<src>`/`dropped`, exactly as it does today. What
  LEAVES the report is a RESOLVABLE image sharing a line with text.
- A zero-width or zero-height atomic contributes nothing and draws nothing
  rather than being rejected; it is a picture with no area, not damage.

## Testing

- **`linebox.ts` from plain numbers**: each alignment, an empty line, a
  baseline image taller than the text, a `top` image forcing the band without
  moving the baseline, and the collapse to today's values with no atomics.
- **`layout.ts` through `layoutRuns` with a stub `FontDriver`**: an atomic
  mid-line, wrapping AROUND one, an atomic alone on an over-wide line, the
  clamp, and the remainder reconstruction across one.
- **`test/rich-runs-identity.test.ts` is the acceptance criterion and is NOT
  EDITED.** Four hashes over eight call sites, confirmed red on a 0.01pt nudge
  to `alignOffset`.
- **End to end**: `<p>before <img> after</p>` draws the image between the
  words at the x the layout gave it, with both words present.
- **An image at a COLUMN BREAK**, placed so it lands in the overflow rather
  than the first column — the only fixture that can see a `beforeRun` index
  that was not re-based.
- **`vertical-align` on an atomic vs on a span**: `top` on an `<img>` reports
  nothing and moves the box; `top` on a `<span>` still reports. One fixture
  each, because a single widened rule would satisfy either alone.
- **The inversion is the proof the feature landed**:
  `test/htmlreport-render.test.ts`'s "still reports an image that shares its
  line with text" flips to asserting that it does NOT report and DOES draw.
  The sweep's `image` row keeps working unchanged, because it uses an
  unresolvable `a.png`.
- **Mutation sweep**, as every issue in this epic has run: every rule proved
  load-bearing, anything that reddens nothing recorded in `CLAUDE.md` as
  uncovered rather than quietly kept.

## Out of scope, each tracked

- **Markdown's `loneImage`** — decision 1; its own issue in `gl6o`.
- **`vertical-align: middle`**, and `sub`/`super`/`text-top`/`text-bottom` —
  decision 3; they stay reported.
- **`vertical-align` on TEXT runs.** This issue makes it observable for
  atomics only; a raised or lowered text run is a different feature.
- **Inline images in a table cell or a floating box.** `tableauthor.ts` and
  `floatbox.ts` measure through `layoutRuns` and would inherit the capability,
  but neither has an authoring surface for atomics and neither is asked to.
- **`inline-block` as a real box** — still reported, `zch2.7`'s rule.
