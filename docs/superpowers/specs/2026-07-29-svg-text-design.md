# SVG text (`<text>` / `<tspan>`) — design

Issue: `aspose-pdf-foss-for-ts-1gg0.8` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-29. Deferred from `1gg0.3`, whose design doc
(`2026-07-28-svg-embedding-design.md`) this extends rather than replaces.

## Scope

Render `<text>` and `<tspan>` inside `page.AddSVGObject`, which today reports both
in `skipped` and draws nothing.

v1 covers:

- **Elements** — `text`, `tspan`, including mixed content
  (`<text>Hello <tspan>big</tspan> world</text>`) and `<text>` reached through
  `<use>`.
- **Font selection** — `font-family` (a CSS list, generic families included),
  `font-weight`, `font-style`, `font-size`, resolved against the 12 Latin
  Standard-14 faces or a caller-supplied embedded handle.
- **Positioning** — `x`, `y`, `dx`, `dy`, `rotate` as per-character lists;
  `text-anchor`; `dominant-baseline`.
- **Spacing** — `letter-spacing`, `word-spacing`, `textLength` with both
  `lengthAdjust` modes.
- **Paint** — `fill` and `stroke` including `url(#gradient)` references, reusing
  the shading-pattern path from `1gg0.7`; `text-decoration`
  (underline / overline / line-through).
- **Whitespace** — the default collapsing rules, and `xml:space="preserve"`.

Out of scope, filed as a follow-up:

- **`textPath`.** Text along an arbitrary path needs arc-length
  parameterization of the cubics from `svgpath.ts` and a per-glyph tangent
  frame — larger than everything else here combined. Reported in `skipped`.
- **Vertical writing modes** (`writing-mode: tb`, `glyph-orientation-*`). Not
  reachable from the parity target and not attempted.

## The two problems that shape the design

Everything else is ordinary work. These two are not.

### 1. `XmlNode` loses mixed-content ordering

`xml.ts` gives an element a `text: string` holding **all** its text concatenated,
plus a separate `children` array. The interleaving between them is not recorded,
so `<text>Hello <tspan>big</tspan> world</text>` parses to `text: "Hello  world"`
and one child, with no way to learn that the `tspan` sat between the two words.
SVG text is inherently mixed content, so this must be fixed first.

`parseElement` gains a third, **additive** output:

```ts
export interface XmlNode {
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];            // unchanged
  text: string;                   // unchanged — all text, concatenated
  nodes: (XmlNode | string)[];    // NEW — chunks and children in source order
  raw?: string;
}
```

`text` and `children` keep their exact current meaning, so `xfdf.ts`,
`xfdfannot.ts`, `annotdata.ts` and `cosxml.ts` cannot regress: nothing they read
changes value. The cost is a second reference to each child plus the text chunks.

The rejected alternative was pushing text into `children` as `#text` pseudo-nodes.
It reads better, but every existing `for (const c of node.children)` in the
FDF/XFDF stack would begin visiting nodes that were never there before — a silent
behaviour change in four modules, to serve one new caller.

Re-parsing the element's `raw` source inside the SVG stack was also rejected: it
duplicates a tokenizer, and a second XML reader drifts from the first.

### 2. The content stream is y-down, so text needs its own flip

`1gg0.3` confines the SVG→PDF y-flip to one place: `placementMatrix` in
`svgtransform.ts`. Content is emitted in raw viewBox units with y still pointing
**down**.

Text cannot inherit that for free. PDF text space is y-up with glyphs upright, so
a naive `Tm` in a y-down space draws every glyph **mirrored** — and mirrored text
still reads as text at a glance, which is exactly why it would survive review.

The text matrix carries its own flip, composed with SVG's `rotate` (PDF and SVG
both use row vectors, so the orders agree):

```
M_flip · M_rot  =  [1, 0, 0, -1] · [cos θ, sin θ, -sin θ, cos θ]
                =  [cos θ, sin θ, sin θ, -cos θ]

Tm  =  cos θ   sin θ   sin θ   -cos θ   x   y
```

At θ = 0 this is `1 0 0 -1 x y`. **The negative `d` is the whole point.** It lives
in one exported pure function in `svgtext.ts`, mirroring how `placementMatrix`
isolates the page-level flip, and it is the first thing the mutation pass attacks.

## Modules

- **`src/svgtext.ts`** — NEW. The font-provider seam, family resolution, the
  layout algorithm, and text-run emission. Pure: no `Document`, no allocation.
- **`src/xml.ts`** — the additive `nodes` array above.
- **`src/svgdraw.ts`** — a `text` branch in `walk` that delegates to `svgtext.ts`
  and merges its output; `text`/`tspan` leave the unsupported-element path.
- **`src/svgembed.ts`** — the new `font` option, the `SvgFontProvider`
  implementation, and merging the provider's `/Font` dict into the form's
  `/Resources`.
- **`src/textdecor.ts`** — `VMetrics` gains `xHeight` (see Baselines).
- **`src/index.ts`** — no new exported types; `AddSVGOptions` gains a field.

## The font-provider seam

`svgdraw.ts` touches no `Document` and allocates nothing — its `/ExtGState`
entries are direct dicts placed in the form's own `/Resources` by `svgembed.ts`.
A Standard-14 `/Font` dict is likewise a non-stream dict and can follow suit.

A caller-supplied `Document.AddFont` handle cannot: its Type0 object is filled by
the document's finalize pass at `Save`, so it must be an **indirect reference**,
and only `svgembed.ts` can allocate one. The walker therefore never resolves
fonts itself:

```ts
/** One resolved face, ready to measure, encode and reference. */
export interface SvgFace {
  /** Resource key within the Form XObject's /Font subdictionary. */
  key: string;
  /** Measure / encode / probe, from layout.ts. */
  driver: FontDriver;
  /** Ascent, descent, xHeight, underline and strike geometry. */
  vmetrics: VMetrics;
  /** False for a Type0 Identity-H face, where `Tw` is a no-op. */
  twUsable: boolean;
}

/** Resolves a CSS font-family list to a usable face, registering it on demand. */
export interface SvgFontProvider {
  face(families: string[], bold: boolean, italic: boolean): SvgFace;
}
```

`svgembed.ts` implements it, owns the `/Font` subdictionary, and allocates the
embedded handle's object exactly once however many runs reference it.

**Invariant:** `Tw` applies only to the single-byte code 32. Under a Type0
Identity-H font — precisely the caller-supplied-handle path — codes are two bytes
and `Tw` is silently ignored (PDF 32000-1 §9.3.3). `word-spacing` must therefore
fold into `TJ` adjustments whenever `twUsable` is false. The flag lives on the
face rather than being re-derived at the emit site, because the emit site is
where forgetting it produces output that looks plausible.

### Family resolution

`font-family` is a comma-separated list, tried left to right:

| Input | Face |
|---|---|
| `serif`, and any family whose name contains `times`, `georgia`, `garamond`, `book`, `roman`, `serif` | Times |
| `monospace`, `courier`, `mono`, `consol`, and any family containing them | Courier |
| `sans-serif`, `cursive`, `fantasy`, anything else | Helvetica |

`font-weight` ≥ 600 (or `bold`/`bolder`) selects the Bold variant;
`font-style: italic|oblique` selects Italic/Oblique. `Helvetica-BoldOblique` and
friends come from the same 12-face table `stamp.ts` already exports.

When `opts.font` supplies an embedded handle, **it wins for any family that does
not resolve to a generic or a Standard-14 name** — the caller had the real font
and said so.

**Substitution is silent.** It is not added to `skipped`. This deliberately
breaks the paint rule from `1gg0.3` ("never fall back to black — a silently-wrong
solid fill is worse than a visibly missing one"), because text inverts the
trade-off: invisible text is far worse than substituted text, and every browser
and every other PDF producer substitutes. It is documented in the README beside
the group-opacity approximation, which it resembles.

Characters the resolved face **cannot encode** are a different matter: they are
dropped, and that *is* reported as `text` in `skipped`, because ink that should
exist does not.

### Baselines

`dominant-baseline: middle` is defined as half the **x-height** above the
alphabetic baseline, which `VMetrics` does not currently carry. It gains
`xHeight`: a per-family constant from the AFMs for the Standard-14 faces,
`OS/2.sxHeight` for an embedded handle, falling back to `0.5 * ascent` when that
table entry is zero — the same "a zero entry means the table said nothing"
treatment `embeddedVMetrics` already applies to its other fields.

| `dominant-baseline` | shift from the alphabetic baseline |
|---|---|
| `auto`, `alphabetic`, `no-change`, unrecognized | 0 |
| `middle` | `xHeight / 2` |
| `central` | `(ascent + descent) / 2` |
| `hanging` | `0.8 * ascent` — an approximation; the true hanging baseline lives in the font's `BASE` table, which neither the AFMs nor `sfnt.ts` expose |
| `mathematical` | `0.5 * ascent` — likewise approximate |
| `text-before-edge` | `ascent` |
| `text-after-edge` | `descent` |
| `ideographic` | `descent` |

The shift is a **per-character** property, not a per-element one: a `tspan` may
change it mid-string.

## Layout algorithm

A pure function — flattened characters in, positioned glyphs out. This is where
the weight of the test suite goes, because it is where a failure can be isolated
to one cause.

**1. Flatten.** Walk the `<text>` subtree in source order over `nodes`, producing
*addressable characters*. Each carries its resolved style, its owning element,
and its index within that element's own character sequence — the index is what
consumes the positioning lists.

Whitespace collapses **before** indexing, since the lists address post-collapse
characters. The default rules: newlines are removed, tabs become spaces, runs of
spaces collapse to one, and leading/trailing space is trimmed at the start and
end of the `<text>` element. `xml:space="preserve"` (inherited) keeps everything,
converting newlines and tabs to spaces.

**2. Position.** A cursor `(cx, cy)` walks the characters. For character `i`,
owned by element `E` at that element's index `j`:

- `E.x[j]` present → `cx = E.x[j]`, and this character **begins a new anchored
  chunk**; likewise `E.y[j]` → `cy = E.y[j]`, also beginning a chunk
- `cx += E.dx[j] ?? 0`, `cy += E.dy[j] ?? 0`
- rotation is `E.rotate[j]`, or — when the list is shorter than the run — its
  **last** value, repeated for every remaining character. This repetition rule is
  specific to `rotate`; a short `x`/`y`/`dx`/`dy` list simply stops applying.
- add the character's baseline shift to `cy`, place the glyph, then
  `cx += advance·size + letterSpacing + (wordSpacing if the character is a space)`

**3. `textLength`.** For each element declaring it, measure the span its
characters actually cover and redistribute the difference: `spacing` (the
default) spreads it across the inter-character gaps; `spacingAndGlyphs` also
scales the glyphs horizontally.

**4. Anchor.** Per chunk, shift every glyph in it by `0`, `-w/2` or `-w` for
`start` / `middle` / `end`, where `w` is the chunk's advance extent and the
anchor is the one in effect at the chunk's **first** character.

Steps 3 and 4 are in that order because SVG anchors the *adjusted* chunk, not the
natural one. Reversing them is wrong only when both features appear together,
which is why it gets its own test rather than being left to a golden.

## Emission

Positioned glyphs are grouped into maximal **runs** sharing face, size, paint,
rotation and baseline, with no positional restart inside. Per run:

- one `Tm`, from the flip-and-rotate composition above
- `Tj` when the run's glyphs sit at their natural advances, else `TJ` whose
  adjustments encode natural-advance minus actual-x. That one mechanism covers
  `dx`, `textLength: spacing`, and letter/word spacing on the Type0 path where
  `Tw` is dead.
- `Tc` / `Tw` only when the spacing is uniform *and* `twUsable`
- `Tz` for `lengthAdjust="spacingAndGlyphs"`
- text render mode `Tr`: fill 0, stroke 1, both 2. Neither means the run is not
  emitted at all — the same "the op is simply not emitted" rule shapes already
  follow.

### Paint

Solid paints emit `rg` / `RG` exactly as `paintShape` does. A `url(#gradient)`
reference reuses `Emitter.patKey` and emits `/Pattern cs … scn`, so the shading
work from `1gg0.7` extends to text with no new machinery. For
`gradientUnits="objectBoundingBox"` the box is the text's own ink extent: the x
range from the advances, the y range from ascent and descent.

`text-decoration` reuses `decorRects` from `textdecor.ts` — the same geometry
`AddText` draws — with the baseline-relative offsets negated, since that module
works in y-up and this content stream is y-down. Rules are painted per run, under
the glyphs for `underline`/`overline` and over them for `line-through`, matching
`AddText`'s beneath/above split.

## Errors and reporting

No new error conditions. Malformed numbers inside a positioning list follow the
tolerance the SVG stack already applies to path data: parse the valid prefix and
stop.

`skipped` gains:

| Condition | Reported |
|---|---|
| `textPath` encountered | `textPath` |
| characters the face cannot encode, dropped | `text` |
| font substituted for an unmapped family | *nothing* — see Family resolution |

The new `font` option must be an `EmbeddedFont` handle; a Standard-14 name is
rejected with a `TypeError` rather than accepted, since the option exists to
supply what the Standard-14 set cannot, and a caller wanting a different
Standard-14 face can say so in `font-family`. `stamp.ts`'s `validateFont` is
deliberately **not** reused: it accepts both, which is right for `AddText` and
wrong here. Validation runs before anything is allocated, preserving
`AddSVGObject`'s invariant that a rejected call leaves the document
byte-identical.

## API

```ts
export interface AddSVGOptions {
  fit?: 'meet' | 'slice' | 'fill';
  /** Face to use for any font-family the Standard-14 set cannot supply — a
   *  handle from Document.AddFont. Without it, such families are substituted
   *  with the nearest Standard-14 face and characters outside WinAnsi are
   *  dropped (and reported). */
  font?: EmbeddedFont;
}
```

`AddSVGResult` is unchanged.

## Testing

The pure layout carries most of the suite, per module:

- **`svgtext.ts`, flattening** — mixed content ordering; whitespace collapse in
  both modes; collapse happening before list indexing.
- **`svgtext.ts`, positioning** — list consumption across `tspan` boundaries; the
  repeating-`rotate` rule against a short list, and a short `dx` list *not*
  repeating; chunk splitting on an absolute `x` and on an absolute `y`; all three
  anchors; every `dominant-baseline` value; letter- and word-spacing; both
  `lengthAdjust` modes; `textLength` and a non-`start` anchor together, in that
  order.
- **`svgtext.ts`, family resolution** — each generic; weight and style variant
  selection; the embedded handle winning for an unmapped family; the Standard-14
  fallback when there is no handle.
- **`svgdraw.ts` / `svgembed.ts`** — `/Font` present in the form's `/Resources`;
  a direct dict for a Standard-14 face versus an indirect ref for a handle; one
  registration shared by two runs; `textPath` and unencodable characters reaching
  `skipped`; a `Save()`/`Open()` round-trip.
- **`xml.ts`** — `nodes` ordering, and that `text`/`children` are byte-for-byte
  what they were (the FDF/XFDF suites are the real guard here and must stay
  green untouched).

Two assertions get special handling, both from CLAUDE.md's rules:

- **The flip is asserted from outside our own matrix code.** A test that compares
  our `Tm` against an expected matrix runs both sides through the same
  understanding and passes happily on mirrored output. Instead, rasterize through
  `ToImage` and assert ink asymmetry — an `L` has ink at bottom-left, not
  top-left. That is the assertion that can actually fail.
- **Mutation-prove the load-bearing signs**: the `d` component of `Tm`, the
  anchor offsets, and the `word-spacing`-under-Type0 path (flip `twUsable` to
  `true` and confirm the suite goes red, since a passing `Tw` emission looks
  correct in the content stream and simply does nothing).

End-to-end golden rasterization follows the pattern `1gg0.7` established for
gradients.

## Documentation

`README.md`: extend the `AddSVGObject` entry with the text support, the `font`
option, and — beside the existing group-opacity note — the two approximations a
user meets first: silent font substitution, and `textPath` being unsupported.

## Follow-ups

Filed under epic `1gg0`:

1. `textPath` — text along a path.
2. CSS `<style>` selectors (already filed as `1gg0.11`) — worth more now, since
   real-world SVG routinely sets `font-family` from a stylesheet rather than a
   presentation attribute.
