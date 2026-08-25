# Page decoration API: watermark / header-footer / Bates numbering

Issue: `aspose-pdf-foss-for-ts-h8s` (P3, feature)
Date: 2026-07-17

## Goal

An ergonomic layer over the existing stamping primitives: repeating text or image
stamps across a page range, with `{page}`/`{total}`/Bates tokens resolved per
page, positioning presets, opacity, and rotation.

No new rendering primitives. `decorate.ts` calls `stampText` (stamp.ts) and
`buildImageXObject` (imageembed.ts); it adds page selection, token resolution,
and preset geometry on top.

## Non-goals

- A general public stamping primitive. `page.AddText` / `page.AddImage` already
  are that; the three methods here are presets over them.
- Configurable date/time formats. `{date}`/`{time}` are ISO-ish and fixed; a
  caller wanting another format passes the pre-formatted string as literal text.
- Per-page custom text via callback. `pages` plus a loop covers it.

## Modules

| File | Change | Purpose |
|---|---|---|
| `src/pagerange.ts` | new | `resolvePages(spec, total): number[]` — the range grammar and its errors. Internal. |
| `src/decorate.ts` | new | Shared placer + the three entry points. |
| `src/document.ts` | edit | Three thin delegating methods, in the style of `Overlay`/`NUp`. |
| `src/index.ts` | edit | Export the three option types + `StampPosition`. |
| `README.md` | edit | Features bullet + API-overview entry (project convention). |

`pagerange.ts` is separate from `decorate.ts` because it is a self-contained
grammar with its own tests, and because `Overlay` (which today takes
`pages?: number[]`) can adopt it later without a public commitment today.

## Public API

```ts
/** Where a stamp anchors in the page's visual frame. */
export type StampPosition =
  | 'diagonal' | 'center'
  | 'top-left' | 'top-center' | 'top-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface WatermarkOptions {
  text?: string;                    // exactly one of text / image
  image?: Uint8Array;               // JPEG or PNG bytes
  pages?: number[] | string;        // default: all pages
  position?: StampPosition;         // default 'diagonal'
  opacity?: number;                 // default 0.3
  rotate?: number;                  // degrees CCW; default: the preset's own angle
  mode?: 'overlay' | 'underlay';    // default 'underlay'
  font?: AuthoringFont;             // default 'Helvetica'
  fontSize?: number;                // default: auto-fit for 'diagonal', 24 otherwise
  color?: [number, number, number]; // default [0.5, 0.5, 0.5]
  margin?: number;                  // default 36 (corner/edge presets only)
  width?: number;                   // image only; see "Image sizing" below
}

export interface HeaderFooterOptions {
  header?: { left?: string; center?: string; right?: string };
  footer?: { left?: string; center?: string; right?: string };
  pages?: number[] | string;
  margin?: number;                  // default 36
  font?: AuthoringFont;             // default 'Helvetica'
  fontSize?: number;                // default 10
  color?: [number, number, number]; // default [0, 0, 0]
  opacity?: number;                 // default 1
}

export interface BatesOptions {
  text?: string;                    // default '{bates}'
  pages?: number[] | string;
  start?: number;                   // default 1
  step?: number;                    // default 1
  digits?: number;                  // minimum zero-pad width, default 6
  prefix?: string;                  // default ''
  suffix?: string;                  // default ''
  position?: StampPosition;         // default 'bottom-right'
  margin?: number;                  // default 36
  font?: AuthoringFont;             // default 'Helvetica'
  fontSize?: number;                // default 10
  color?: [number, number, number]; // default [0, 0, 0]
  opacity?: number;                 // default 1
}

// On Document:
AddWatermark(opts: WatermarkOptions): void;
AddHeaderFooter(opts: HeaderFooterOptions): void;
AddBatesNumbering(opts?: BatesOptions): number;  // → next unused number
```

Tokens are accepted in every text position, including each of
`AddHeaderFooter`'s six slots.

### API decisions

**`text` vs `image` as two validated optionals**, not a discriminated union.
Laxer than the type system allows, but it matches `StampAnnotationOptions`,
which already expresses "provide exactly one of `name`/`text`/`image`" this way.
Consistency with the codebase beats the stricter type.

**Nested slot objects on `AddHeaderFooter`**, not flat `headerLeft`/`headerCenter`/…
A header is one band with three cells, and the nesting says so.

**`AddBatesNumbering()` requires no argument.** The defaults (bottom-right,
`{bates}`, 10pt) are the legal-discovery default, so the bare call is correct.

**`AddBatesNumbering` returns the next unused number**, so a sequence chains
across a document set:

```ts
let n = 1;
for (const d of docs) n = d.AddBatesNumbering({ start: n });
```

`void` would force callers to recompute it from the page count, and get it wrong
whenever `pages` selected a subset or `step` was not 1.

## Page range grammar (`pagerange.ts`)

`resolvePages(spec: number[] | string | undefined, total: number): number[]`

- `undefined` → every page, `1..total`.
- `number[]` → as given (the existing `Overlay` convention).
- `string` → comma-separated terms, each one of:
  - `N` — single page
  - `N-M` — inclusive range
  - `N-` — `N` through the last page
  - `-M` — page 1 through `M`
- Whitespace around terms and hyphens is tolerated: `"1 - 5, 8"` is valid.
- 1-based, inclusive. The result is normalized: ascending, duplicates collapsed.
  `"3,1-2,1"` → `[1, 2, 3]`.
- Malformed input (empty term, non-integer, reversed range like `"5-1"`) →
  `TypeError`.
- Out-of-bounds (`0`, `total+1`) → `RangeError`, matching `Overlay`'s existing
  behavior.

## Geometry: the visual frame

Presets are defined against what the viewer sees. `stampText` draws in user
space. The two frames disagree whenever a page carries `/Rotate` or a `CropBox`
with a non-zero origin — both common in scanned and print-production files. A
watermark that lands sideways on a rotated page is a bug, not a preference, so
rotation-awareness is unconditional (no opt-out knob).

Let `M` map visual-frame coordinates (origin at the bottom-left of the page *as
displayed*, size `VW × VH`) into user space. Given `CropBox = [x0, y0, x1, y1]`,
`w = x1 - x0`, `h = y1 - y0`, and `/Rotate R`:

| R | `VW × VH` | `M` |
|---|---|---|
| 0 | `w × h` | `[1, 0, 0, 1, x0, y0]` |
| 90 | `h × w` | `[0, 1, -1, 0, x0 + w, y0]` |
| 180 | `w × h` | `[-1, 0, 0, -1, x0 + w, y0 + h]` |
| 270 | `h × w` | `[0, -1, 1, 0, x0, y0 + h]` |

Geometry is computed per page, so a document of mixed page sizes fits each page
correctly.

### Text needs no `cm`

Each preset yields an anchor point and an `align` in the visual frame. Map the
anchor through `M` for the user-space `(x, y)`, then pass
`rotate = presetAngle + R` to `stampText`, which already rotates about its own
anchor. `R` is exactly the counter-rotation cancelling the viewer's clockwise
display rotation, so the stamp renders upright. `stampText`'s existing
`rotate`/`align` do all the work — which is why rotation-awareness is nearly
free here.

**The rotation sign is the likeliest bug in this design.** `presetAngle + R` is
the reading of two opposing conventions: `/Rotate` is clockwise-as-displayed,
`stampText`'s `rotate` is counter-clockwise in user space. Sign errors here are
invisible until someone opens a rotated page. The `/Rotate 90`/`270` quad
assertions pin it and are written first.

### Images take the general path

One `q [/GS gs] <cm> /Im Do Q` body, `cm` composing the placement with `M`. This
covers rotation, which `addImage`'s axis-aligned rect cannot express — hence
bypassing `addImage` in favor of `buildImageXObject` plus our own body.

That is the call we need regardless: `addImage` builds a fresh Image XObject per
call, so a naive image watermark over 400 pages would embed 400 copies of the
JPEG. The image is built **once** and the single ref registered on each selected
page — the same sharing `overlay` already does for Form XObjects.

### Presets

- Corner and edge presets inset by `margin` from the visual frame, with the
  `align` implied by the name (`top-left` → `align: 'left'`, etc.).
- `center` anchors at the visual center, `align: 'center'`, angle 0.
- `diagonal` anchors at the visual center, `align: 'center'`, angle
  `atan2(VH, VW)` — the page's own diagonal, so ~45° on Letter but correct at any
  aspect ratio. `fontSize` auto-fits so `measureText` ≈ `0.8 * hypot(VW, VH)`;
  an explicit `fontSize` opts out of auto-fit.
- An explicit `rotate` overrides the preset's angle (the `R` term is still
  added).

### Image sizing

An image stamp is placed with the same anchor, `align`, and angle as the text
stamp for its preset; only its extent is computed differently. `width` (in
points) sets the drawn width and the height follows from the image's intrinsic
aspect ratio. Its default depends on the preset:

- `diagonal` — `0.8 * hypot(VW, VH)`, mirroring the text auto-fit.
- `center` — `0.5 * VW`.
- Corner/edge presets — `0.25 * VW`, placed inside the `margin` inset.

An image is never scaled anisotropically, and `width` never triggers the text
auto-fit path (`fontSize` is irrelevant to an image stamp; passing both `image`
and `fontSize` is accepted and `fontSize` ignored).

## Token resolution

One pass per template: `/\{\{|\{([a-z]+)\}/g`.

| Token | Value |
|---|---|
| `{page}` | 1-based page number |
| `{total}` | document page count |
| `{label}` | `doc.PageLabelFor(n - 1)` (0-based; falls back to the decimal number without `/PageLabels`) |
| `{bates}` | `prefix + padStart(counter, digits, '0') + suffix` — `AddBatesNumbering` only |
| `{date}` | `YYYY-MM-DD` |
| `{time}` | `HH:MM` |

- `{{` → a literal `{`. A bare `}` is literal.
- An unknown name → `TypeError` naming the offending token and listing the valid
  set. Silently stamping the literal text `{pages}` onto 400 pages is a bad,
  silent failure discovered only when someone opens the PDF.
- `{bates}` outside `AddBatesNumbering` → the same `TypeError` (no counter in
  scope).
- `{date}`/`{time}` are computed **once per call**, not per page: a long run must
  not straddle midnight and stamp two different dates.

**`{page}` is the plain number, `{label}` the page label.** Keeping them
separate means neither surprises anyone.

## Bates semantics

- The counter **counts stamped pages, not document pages**: `pages: '5-10'` with
  `start: 1` gives page 5 `000001`. Stamping a subset must not leave gaps in a
  legal-numbering sequence.
- Page *i* of the selection (0-based) gets `start + step * i`.
- `digits` is a **minimum** width, matching `padStart` semantics everywhere else.
  Overflow widens rather than throwing: with `digits: 3`, `999` is followed by
  `1000`. Never loses information.

## Errors and atomicity

**All validation happens before any mutation.** Options are normalized once up
front, `pages` is resolved and bounds-checked up front, and every template is
token-scanned up front. Those are the only failure modes, so a call either
stamps every selected page or throws having touched nothing — never a
half-watermarked 400-page document. This is why token validation is eager rather
than lazy per page.

- `TypeError` — malformed options, unknown tokens, neither-or-both of
  `text`/`image`.
- `RangeError` — out-of-bounds page selection.
- `UnsupportedFeatureError` — an unrecognized image format (propagated from
  `buildImageXObject`).
- Empty or all-unencodable text no-ops, per `stampText`'s existing contract.

## Testing

TDD per the project convention. Fixtures built programmatically in
`test/helpers/build-decorate-pdf.ts`, in the style of `build-compose-pdf.ts`:
multi-page documents at `/Rotate` 0/90/180/270, a non-zero-origin `CropBox`,
mixed page sizes, and `/PageLabels`.

**`test/pagerange.test.ts`**
- Every grammar form (`N`, `N-M`, `N-`, `-M`, comma-separated combinations).
- Whitespace tolerance; normalization (ascending, deduped).
- `TypeError` on malformed input; `RangeError` on out-of-bounds.

**`test/decorate.test.ts`**
- *Tokens:* each token resolves; `{{` escapes; unknown name throws; `{bates}`
  rejected outside Bates; `{date}` identical across all pages.
- *Bates:* `start`/`step`/`digits`; overflow widens (`999` → `1000`); a subset
  selection numbers from `start` with no gaps; the return value chains across two
  documents.
- *Selection:* string and array forms select the same pages; unselected pages are
  untouched.
- *Geometry:* on each `/Rotate`, assert via `GetTextFragments()` quads that the
  stamp sits in the expected visual quadrant and is upright. This is the test
  that catches a wrong rotation sign.
- *Sharing:* an image watermark over 10 pages yields exactly one Image XObject in
  the saved file.
- *Non-destructiveness:* the original `GetText()` survives; underlay precedes and
  overlay follows existing content.
- *Opacity:* `opacity < 1` emits an `/ExtGState`.
- *Round-trip:* `Save` → `Open` → text and fragments intact (acceptance
  criteria).

## Acceptance criteria mapping

| Criterion | Covered by |
|---|---|
| `AddWatermark`/`AddHeaderFooter`/`AddBatesNumbering` across a page range | Public API + `pagerange.ts` |
| Tokens resolved | Token resolution |
| Positioning presets | `StampPosition` + visual frame |
| Opacity / rotation | Options → `stampText` / `/ExtGState` |
| Output renders and re-opens | Round-trip tests |
| Underlying content untouched except the overlay | Non-destructiveness tests; `appendContent`/`prependContent` only |
