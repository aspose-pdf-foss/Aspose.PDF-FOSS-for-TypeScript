# Flow floating boxes (wrap-around) — design (db7v.4)

**Issue:** aspose-pdf-foss-for-ts-db7v.4 (parent epic db7v — Flow layout engine)
**Date:** 2026-07-24
**Status:** approved, ready to plan
**Depends on:** db7v.2 (Paragraph & heading elements) — shipped; builds on db7v.3 (Lists)

## Goal

Add `doc.NewFloatingBox(options)` — a padded/bordered/filled box holding
paragraphs and/or an image — that `flow.AddFloatBox(box, side)` floats to the
left or right of a column, with surrounding flow text wrapping in the narrowed
channel beside it and resuming full width once the pen passes the box bottom.

## Scope (v1)

- **One float active at a time** (option A). A box floats left or right; text
  wraps in the narrowed channel beside it and resumes full width below. A second
  float placed while one is active is laid out below (it clears). No simultaneous
  left+right, no float stacking, no CSS `clear` controls — those are B/C
  follow-ups.
- **Box content:** paragraphs (`AddParagraph`) and images (`AddImage`), rendered
  inside the box. Box images are self-contained (fixed size in the box); this is
  independent of db7v.5 (main-column flow images).
- **Atomic floats:** a box never splits across columns — if it does not fit the
  remaining height, the whole box moves to the next column/page top; a box taller
  than a full empty column throws.
- **Tagging:** under a tagged flow, emit the box's image as `/Figure` (with
  `/Alt`) and its paragraphs as `/P`, at the float's flow position (before the
  wrapping text).

## Parity target

Aspose-PDF-FOSS-for-Go `_examples/feature_showcase/main.go`:

```go
flow.AddFloatBox(pdf.NewFloatingBox().
    SetSpacing(2).SetBackground(&pdf.Color{...}).SetBorder(pdf.BorderInfo{...}).
    SetPadding(pdf.MarginInfo{...}).AddImage(img, 112, 0).AddParagraph(text, style),
    pdf.FloatLeft, 112)
```

This library keeps the TS idiom (options object + `doc.NewFloatingBox`, side at
attach time) rather than the Go builder-of-`SetXxx` and redundant width argument.

## Public API

```ts
/** Options for {@link Document.NewFloatingBox}. All lengths in points. */
export interface FloatBoxOptions {
  /** Outer box width (border-box), points. Required, > 0. */
  width: number;
  /** Inside padding between border and content. Default 0. */
  padding?: number | { top: number; right: number; bottom: number; left: number };
  /** Border stroke. Default none. */
  border?: { width: number; color: [number, number, number] };
  /** Background fill color. Default none (transparent). */
  background?: [number, number, number];
  /** Gap between the box's outer edge and the wrapped text, and the vertical gap
   *  above/below the box in the flow. Default 0. */
  spacing?: number;
  /** Alt text for the box's `/Figure` when the flow is tagged. */
  alt?: string;
}

/** Options for {@link FloatingBox.AddImage}. */
export interface FloatBoxImageOptions {
  /** Drawn width, points. Default: the box content width. */
  width?: number;
  /** Drawn height, points. Omitted/0 → auto from aspect ratio at the drawn width. */
  height?: number;
  format?: 'jpeg' | 'png';
}

class FloatingBox {
  AddParagraph(text: string, options?: FlowParagraphOptions): this;
  AddImage(data: Uint8Array, options?: FloatBoxImageOptions): this;
}

// Document facade:
doc.NewFloatingBox(options: FloatBoxOptions): FloatingBox

// Flow:
flow.AddFloatBox(box: FloatingBox, side: 'left' | 'right'): this   // chainable
```

Usage:

```ts
const box = doc.NewFloatingBox({
  width: 112, spacing: 2, padding: 6,
  border: { width: 1, color: [0.2, 0.2, 0.6] }, background: [0.95, 0.95, 1],
});
box.AddImage(pngBytes, { height: 0 });          // auto aspect at content width
box.AddParagraph('caption text', { fontSize: 10 });
flow.AddFloatBox(box, 'left');
```

## Module & box model

New module `src/floatbox.ts` (keeps `flow.ts` focused).

`contentWidth = width − padLeft − padRight − 2·border.width`.

`FloatingBox` is a builder holding an ordered list of inner elements
(`{ kind: 'paragraph', text, opts } | { kind: 'image', built, drawW, drawH }`).

- **`AddParagraph(text, opts)`** — records a paragraph wrapped at `contentWidth`.
- **`AddImage(data, opts)`** — builds the XObject now (`buildImageXObject`);
  resolves `drawW` (default `contentWidth`) and `drawH` (aspect from the built
  image's `/Width`,`/Height` when omitted/0).
- **`measure(): number`** — lays out each inner element at `contentWidth`
  (paragraphs via `layoutText` + a measuring `FontDriver`, mirroring
  `tableauthor`; images via `drawH`), sums element heights + inter-element
  spacing + `padTop + padBottom + 2·border.width`. Pure, no drawing.
- **`paintAt(page, x, topY): number`** — paints, top-down:
  1. background: `PageGraphics.rect(x, topY−h, width, h).setFillColor(bg).fill()`
     when `background` set;
  2. border: `rect(...).setLineWidth(bw).setStrokeColor(c).stroke()` inset by
     `bw/2` when `border` set;
  3. inner content inside the padding box at
     `(x + padLeft + bw, topY − padTop − bw)` via `stampTextBlock` /
     `drawBuiltImage`.
  Returns `h` (= `measure()`).

Validation (throw `TypeError`): `width` finite & > 0; `padding`/`border.width`/
`spacing` non-negative; `background`/`border.color` are `[r,g,b]` in 0..1.

## Wrap-around integration in `Flow.Render`

A new `FlowItem` kind `{ kind: 'float'; box: FloatingBox; side: 'left'|'right' }`
is enqueued by `AddFloatBox`. `Render` gains one per-column state variable:

```ts
let activeFloat: { side: 'left' | 'right'; band: number; bottom: number } | undefined;
// band = box.width + spacing (horizontal space to avoid)
// bottom = the y the float extends down to
```

**Dequeue a `float` item:**
1. `h = box.measure()`. If `h > colTop − contentBottom` and not `atColumnStart` →
   `advanceColumn()`. If still `h > colTop − contentBottom` at a column start →
   `throw new Error('Flow: floating box does not fit in an empty column (column too short for the box)')`.
2. Apply the leading vertical gap (`spacing`, dropped at a column top) to get the
   box top `boxTop = colTop − gap`.
3. Box x: left → `columnX(g, col)`; right → `columnX(g, col) + columnWidth − box.width`.
4. `box.paintAt(page, boxX, boxTop)` (+ tagging, below).
5. `activeFloat = { side, band: box.width + spacing, bottom: boxTop − h }`.
   `colTop = boxTop` — **not advanced past the box**; following text wraps beside
   it. `atColumnStart = false`.

**Place a normal element with an active float (`top > activeFloat.bottom`):**
- Narrow the rect:
  - left float → `x = columnX + band`, `width = columnWidth − band`;
  - right float → `x = columnX`, `width = columnWidth − band`.
- **Cap `availHeight` at `top − activeFloat.bottom`** so the element re-flows at
  the float's bottom edge; the remainder re-enqueues and continues (full width
  once the pen clears the box). This "beside then below" wrap falls out of the
  existing `place`/remainder mechanism — `place` is unchanged.
- If a beside placement cannot fit even one line in the narrowed region
  (`drew:false`, remainder = self), advance the pen to the float bottom
  (`colTop = activeFloat.bottom`, clear `activeFloat`) and retry full width,
  rather than looping.

**Clear the float:** when `top ≤ activeFloat.bottom` or on `advanceColumn`, set
`activeFloat = undefined`; elements resume full column width.

## Pagination & fit

- Atomic: a float lives in one column; it never splits (step 1 above).
- Wrapping text paginates normally; if beside-text overflows the column while
  still beside the float, `advanceColumn` clears the float and the remainder
  continues full-width in the next column (the float does not carry over — this
  is the one-float-at-a-time model).
- `spacing` supplies the vertical gap above the box (dropped at a column top) and
  below it.

## Tagging (tagged flow only)

At the point the `float` item is placed, append the box's structure under the
flow's `Sect`, **before** the wrapping text's structure (correct reading order
for a leading float):

- image → `structParent.Append('Figure')` with `/Alt` from `options.alt`
  (reusing the image-tagging path);
- each box paragraph → `structParent.Append('P')`.

Lazy/orphan rule preserved: a box that draws nothing tags nothing. Untagged flows
emit byte-identical output with no structure.

## Testing & validation

New `test/floatbox.test.ts` (box unit) + additions to `test/flow.test.ts`
(integration); hermetic builders, test-only factories.

- **Box measure/paint (unit):** known padding/border/content → expected height;
  `paintAt` emits a background fill, a border stroke, and inner content (assert on
  content-stream ops). Image auto-height matches a small PNG fixture's aspect.
- **Option validation:** `width` required & positive; `padding`/`border.width`/
  `spacing` non-negative; bad types throw `TypeError`.
- **Wrap-around geometry:** left float + paragraph → beside-text lines start at
  `columnX + band` (narrower); lines below the box resume at `columnX` full width
  (assert via `GetTextFragments` x-positions). Symmetric right-float test.
- **Atomic fit:** a box that does not fit remaining height moves whole to the next
  column/page top; a box taller than a full column throws.
- **Text clears the float:** short float + long wrapping text → later lines widen
  once the pen passes the box bottom.
- **Image + paragraph box:** both render inside the padding region (positions
  within the box rect).
- **Tagging:** `{ tagged: true }` → `GetStructTree` shows the box `/Figure` (with
  `/Alt`) and `/P` at the float's flow position, before the wrapping paragraph's
  `/P`; untagged flow → no structure; load-bearing check (break `/Figure` → red,
  revert).

Quality gates before closing: `npm run typecheck` and `npm test` green; keep
`README.md` (Flow section) in sync.

## Follow-ups (filed as issues)

- Simultaneous left+right floats and per-side float stacking (option B).
- CSS-style float clearing controls and cross-column float carry (option C).
