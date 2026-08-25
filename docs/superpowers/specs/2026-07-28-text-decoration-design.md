# Text decoration in AddText / AddTextBlock

Issue: `aspose-pdf-foss-for-ts-1gg0.4` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Parity target: `Aspose-PDF-FOSS-for-Go`
`_examples/feature_showcase/main.go`, whose text state carries underline,
strike-out, and a background colour, and whose text stamp can be laid beneath
existing page content.

## Goal

Add four options to the text-authoring layer:

- `underline` — a rule below the baseline,
- `strikethrough` — a rule through the glyphs,
- `background` — a fill behind the glyphs,
- `behind` — sink the whole stamp beneath existing page content.

They land on `StampOptions` (so `page.AddText` and, by inheritance,
`page.AddTextBlock` get them) and are then forwarded explicitly through every
consumer that owns its own options type: `flow.ts`, `tableauthor.ts` /
`tablerender.ts`, `toc.ts`, and `decorate.ts`.

Non-goals: per-character or per-run decoration (a decoration applies to the whole
call), double/wavy/dotted rule styles, and decoration of the list markers that
`flow.AddList` draws as separate stamps.

## Public API

```ts
/** A rule drawn beneath (underline) or through (strikethrough) the text. */
export interface DecorationStyle {
  /** RGB in 0..1. Default: the text's own `color`. */
  color?: [number, number, number];
  /** Rule thickness in points. Default: from the font's metrics, scaled by fontSize. */
  thickness?: number;
  /** Baseline-relative offset in points, positive up. Default: from the font's metrics. */
  offset?: number;
}

/** A fill painted behind the glyphs. */
export interface BackgroundStyle {
  /** RGB in 0..1. Required — a background with no colour is just `undefined`. */
  color: [number, number, number];
  /** Points added on all four sides of the text-tight rect. Default 0. */
  padding?: number;
}

export type Decoration = boolean | DecorationStyle;
export type Background = [number, number, number] | BackgroundStyle;
```

Added to `StampOptions`:

```ts
underline?: Decoration;
strikethrough?: Decoration;
background?: Background;
behind?: boolean;
```

`true` means "use the font's metrics and the text's own colour"; `false` and
`undefined` are both off. The bare-tuple `Background` form is the common case
(`background: [1, 1, 0.6]`); the object form adds `padding`.

`TextBlockOptions extends Omit<StampOptions, 'align' | 'rotate'>`, so all four
reach `AddTextBlock` unchanged. `behind` is offered on both: `prependContent`
already treats an empty `/Contents` identically to `appendContent`, so
`behind: true` on a blank page simply draws normally.

## Architecture

### `src/textdecor.ts` (new)

`stamp.ts` is 501 lines across four body builders. The decoration work splits
cleanly at a seam: resolving font metrics into rectangles needs no `Document`,
no `Page`, and no content-splicing, so it is its own module and is unit-tested
directly rather than through emitted PDF bytes.

```ts
/** Vertical metrics as em fractions, baseline = 0, positive up. */
export interface VMetrics {
  ascent: number;
  descent: number;            // negative
  underlineOffset: number;    // negative
  underlineThickness: number;
  strikeOffset: number;       // positive
  strikeThickness: number;
}

export function vmetricsFor(font: AuthoringFont): VMetrics;

/** One laid line in the frame the caller chooses. */
export interface LineBox { x: number; baseline: number; width: number }

/** Resolved (validated, defaults applied) decoration for one call. */
export interface ResolvedDecor {
  underline?: { color: [number, number, number]; thickness: number; offset: number };
  strikethrough?: { color: [number, number, number]; thickness: number; offset: number };
  background?: { color: [number, number, number]; padding: number };
}

export function resolveDecor(o: StampOptions, textColor: [number, number, number],
                             fontSize: number, vm: VMetrics): ResolvedDecor | undefined;

/** `re f` operator text for the two layers, or '' when that layer is empty. */
export function decorRects(lines: LineBox[], fontSize: number,
                           d: ResolvedDecor): { beneath: string; above: string };
```

`decorRects` works in whatever frame the caller's `LineBox` coordinates are in.
The single-line rotated path passes text-local boxes (`x: 0, baseline: 0`) and
wraps the result in a `cm`; the block path passes absolute user-space boxes and
needs no `cm`. One function, caller picks the frame.

Rect geometry per line, before padding:

- background: `x` .. `x + width`, `baseline + descent*fontSize` ..
  `baseline + ascent*fontSize`
- underline: `x` .. `x + width`, `baseline + offset - thickness/2` .. `+ thickness/2`
- strikethrough: same, at `strikeOffset`

`resolveDecor` returns `undefined` when nothing is set, which is the fast path
every existing call takes.

### Metric sources

**Standard-14.** `metrics.ts` carries width tables only. `textdecor.ts` adds
vertical constants from the Adobe AFMs, keyed by family, since all 12 Latin faces
fall into three:

| Family | Ascender | Descender | CapHeight | UnderlinePosition | UnderlineThickness |
|---|---|---|---|---|---|
| Helvetica (4 faces) | 718 | -207 | 718 | -100 | 50 |
| Times (4 faces) | 683 | -217 | 662 | -100 | 50 |
| Courier (4 faces) | 629 | -157 | 562 | -100 | 50 |

Per 1000 em. `UnderlinePosition`/`UnderlineThickness` are uniform across all 12,
which is why one constant covers them. The AFMs carry no strikeout entry, so
`strikeOffset = 0.5 * CapHeight` and `strikeThickness = underlineThickness`.

Bold and italic faces differ slightly from their family's roman in ascender and
cap-height. Per-family values are used deliberately: the difference is under 2%
of an em, invisible at any realistic font size, and a 12-row table would be four
times the data for no visible gain. If a fixture ever shows it mattering, the
table is trivially widened.

**Embedded fonts.** `sfnt.ts` already parses the `post` table at
[sfnt.ts:422](../../../src/sfnt.ts) for `italicAngle` (offset 4);
`underlinePosition` and `underlineThickness` are FWords at offsets 8 and 10 of
the same record. OS/2 is already parsed for ascent/descent/capHeight; strikeout
lives in the same table at offsets 26 (`yStrikeoutSize`) and 28
(`yStrikeoutPosition`). Four new fields on `SfntFont`, divided by `unitsPerEm` by
`vmetricsFor`.

**Fallback**, when a font supplies none (no `post`, no OS/2, or a zeroed entry):
`underlineOffset -0.1`, `underlineThickness 0.05`, `strikeOffset 0.25`,
`strikeThickness 0.05`, `ascent 0.75`, `descent -0.25`.

### Emission in `stamp.ts`

All four body builders — `buildStampBody`, `buildShapedStampBody`,
`buildBlockBody`, `buildShapedBlockBody` — sandwich their existing `BT … ET`
between two optional layers. **The `BT … ET` region itself is not modified**:

```
q
  [/GS gs]
  q <matrix> cm  <background re f ops>  Q        ← only when background is set
  BT … ET                                        ← byte-identical to today
  q <matrix> cm  <underline + strike re f ops> Q ← only when a rule is set
Q
```

Rules paint above the glyphs so a strikethrough reads over the text it crosses;
the background paints below them. Everything stays inside the stamp's single
outer `q … Q` and reaches `/Contents` through **one** splice, so `behind` moves
the decoration and the glyphs together atomically.

The `cm` on the single-line path is the same
`cos sin -sin cos tx ty` matrix `buildStampBody` already computes for `Tm`,
which is what makes rotation and `align` apply to the rules for free. The block
path has no rotation, so its `LineBox`es are absolute and the `cm` is omitted.

Why not `PageGraphics`, as the issue suggested: `PageGraphics.apply()` splices
its own separate content stream. That would decouple the rules from the stamp's
`Tm` matrix (breaking rotation and alignment) and split `behind` across two
independent splices. Same `re`/`f` primitives, emitted inline.

An explicitly-passed `splice` still wins over `behind`, so `decorate.ts`'s
underlay watermark is unaffected:

```ts
const put = splice ?? (o.behind ? prependContent : appendContent);
```

`flowTextBlock` has no `splice` parameter today and gains the same internal
resolution (not a public parameter).

Validation joins `normalizeOptions` / `normalizeBlockOptions`, which already
throw `TypeError` for every bad option before any mutation: colours must be
`[r,g,b]` in 0..1, `thickness` and `padding` finite and `>= 0`, `offset` finite,
`behind` a boolean.

## Consumers

Each owns an options type that whitelists what it forwards, so each needs an
explicit edit.

| Module | Change |
|---|---|
| `flow.ts` | `underline`/`strikethrough`/`background` on `FlowParagraphOptions`; forwarded in `paragraphOptions()`. `FlowHeadingOptions` inherits. |
| `tableauthor.ts` + `tablerender.ts` | `underline`/`strikethrough`/`textBackground` on `CellTextOptions` and `ResolvedStyle`; the cell→row→table cascade in `resolveStyle`; validation; forwarded in `tablerender.ts` pass 2. |
| `toc.ts` | Forwarded in `rowStampOptions` and `rowBlockOptions`; added to `RowStyle` and to the per-entry `style` `Pick`. |
| `decorate.ts` | `underline`/`strikethrough`/`background` on `WatermarkOptions`, `HeaderFooterOptions`, `BatesOptions` and on the internal `Placement`; forwarded through `drawText`. |

Three deliberate asymmetries:

**`behind` is not offered on `flow.ts`, `tableauthor.ts`, or `toc.ts`.** These lay
content into a column, cell, or box on a page they are composing; sinking one
element of it beneath the page has no coherent meaning and would reorder the
element against its siblings.

**`behind` is not offered on `decorate.ts`.** `WatermarkOptions.mode:
'overlay' | 'underlay'` already owns z-order for watermarks, and headers,
footers and Bates numbers are furniture that belongs on top. A second control
for the same thing would be a bug waiting to happen.

**Table cells use `textBackground`, not `background`.** `CellTextOptions.background`
already exists and means the fill of the whole cell box. `underline` and
`strikethrough` do not collide and keep their names.

### Known limitations (documented, follow-ups filed)

- **TOC underline breaks across the dot leader.** A TOC row is drawn as three
  separate stamps (title, leader, page number), so an underline follows the two
  text runs and skips the leader between them. This is the defensible reading —
  the leader is not text being underlined — and spanning the row would need a
  one-off code path in `tocrender.ts` that no other consumer has.
- **`flow.AddList` decorates the item body only.** The marker is a separate
  `stampText` call and is left undecorated.
- **`toc.ts` never forwarded the inherited typographic options.** `TOCOptions`
  is declared as `Omit<TextBlockOptions, …>` but `rowStampOptions` /
  `rowBlockOptions` copy a fixed field list. This spec adds the decoration
  fields to those copies; it does not audit what else the `Omit` promises and
  the copies drop. Filed separately.

## Testing

`test/textdecor.test.ts` — the pure geometry, no PDF:

- `vmetricsFor` for each of the 12 Standard-14 faces and for an embedded font
  with and without `post` / OS/2.
- Rect math: offset, thickness, and padding all move the rect the expected way;
  a multi-line block yields one rect per line at the right baselines.
- **AFM cross-check**: the hardcoded Standard-14 constants are asserted against
  `getStd14Sfnt(face)`'s parsed `ascent`/`descent`/`capHeight` within a
  tolerance. Per the repo's differential-test rule this asserts the constants
  against data outside the constant table — the bundled substitute faces are
  metric-compatible clones parsed by an unrelated code path.

`test/text-decoration.test.ts` — emission:

- All four body builders: background `re f` appears before `BT`, rules after
  `ET`, both inside the outer `q … Q`.
- Rotation: a rotated underline's `cm` matches the text's `Tm`.
- `behind: true` places the body before existing content; `behind` on an empty
  page behaves as a plain draw.
- **Regression guard**: an undecorated `AddText` / `AddTextBlock` emits bytes
  identical to the pre-change output.
- **Placement, read back**: at least one case asserts through `page.GetPaths`
  rather than string-matching the stream, so the rect is checked where it
  actually lands.

Per-consumer forwarding tests (one each for `flow.ts`, table cells, `toc.ts`,
`decorate.ts`) confirming the option survives the whitelist and reaches the
content stream — including that a table cell's `background` and `textBackground`
produce two distinct rects.

Finally, the mutation pass CLAUDE.md requires: perturb the geometry in
`textdecor.ts` (flip the underline offset's sign, drop the padding term) and
confirm the suite goes red, so the assertions are known to be load-bearing
rather than merely green.

## Documentation

`README.md`: the Features list and the `AddText` / `AddTextBlock` section of the
API overview, plus a short example. The TOC-leader and list-marker limitations
go in Limitations.
