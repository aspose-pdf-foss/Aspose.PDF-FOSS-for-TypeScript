# Typed FreeText + Popup Annotations

**Issue:** aspose-pdf-foss-for-ts-ur5 (sub-issue 3 of i1p)
**Date:** 2026-07-03

## Context

The annotation model (`src/annotation.ts`, `src/appearance.ts`) ships typed
create/edit + appearance generation for Text, Stamp,
Highlight/Underline/StrikeOut/Squiggly, Link, FileAttachment, and — from
sub-issue 1 of i1p — Line, Square, and Circle. FreeText and Popup still read back
only as the base `Annotation` via `.Dict`, with no typed setters (README
Limitations).

Parent issue i1p was split by complexity into three sub-issues:

1. Simple shapes: Line, Square, Circle. **(closed)**
2. Path shapes: Polygon, Polyline, Ink (issue g6p, open).
3. **This spec — FreeText + Popup.**

This sub-issue mirrors the Line/Square/Circle patterns landed in sub-issue 1:
typed handle classes, `Page.Add*` create APIs, live accessors, and generated
`/AP /N` appearance streams where applicable. Tests + fixtures per subtype.
README updated.

## Scope

- `/FreeText`: a text box drawn directly on the page, including callout leader
  lines (`/CL`, `/IT FreeTextCallout`, `/LE` ending) as well as the plain
  typewriter box.
- `/Popup`: a companion window bound to a parent markup annotation via `/Parent`
  and the parent's `/Popup`; no appearance stream. Creatable standalone and as an
  auto-attached companion of any markup-family `Add*` call.

Non-goals: rich text (`/RS`, `/DS`, `/Rich`); non-Helvetica fonts (appearance
uses Standard-14 Helvetica, matching the rest of the appearance layer);
dashed/cloudy borders (`/BS /D`, `/BE`) — border is a solid width only.

## Handle classes (`src/annotation.ts`)

### `FreeTextAnnotation extends Annotation`
Live accessors over the annotation dict:

- `Alignment`: `'left' | 'center' | 'right'` ↔ `/Q` (0/1/2). Getter maps the
  number (default `'left'`); setter writes 0/1/2.
- `FontSize`: number ↔ the size operand of `/DA`. Getter parses `/DA` via
  `parseDA` (da.ts); setter rebuilds `/DA` preserving the font token and color.
- `TextColor`: `[r,g,b]` in 0..1 ↔ the fill color of `/DA`. Getter parses `/DA`;
  setter rebuilds `/DA` preserving font token and size. Validates 0..1.
- `BorderWidth`: number ↔ `/BS /W`; reuses `readBorderWidth`/`setBorderWidth`
  (default 1 when absent; setter validates a non-negative finite number).
- `InteriorColor`: `[r,g,b] | undefined` ↔ `/IC` (box background). Setter
  validates components in 0..1; `undefined` deletes `/IC`.
- `Intent`: `string | undefined` ↔ `/IT` name (e.g. `FreeText`,
  `FreeTextCallout`, `FreeTextTypewriter`).
- `CalloutLine`: `number[] | undefined` ↔ `/CL` (a flat list of 4 or 6 finite
  numbers = 2 or 3 knee points). Setter validates length ∈ {4,6}.
- `CalloutEnding`: `LineEnding | undefined` ↔ `/LE`. Note `/FreeText /LE` is a
  single name (unlike `/Line /LE`, a `[start, end]` array). Setter validates
  against the existing `LINE_ENDINGS` set.

`FontSize`/`TextColor` share a small internal helper that rebuilds a `/DA`
string (`/Helv <size> Tf r g b rg`) from parsed parts, so a set of either
preserves the other.

### `PopupAnnotation extends Annotation`
- `Open`: `boolean` ↔ `/Open` (mirrors `TextAnnotation.Open`).
- `Parent`: `Annotation | undefined` ↔ `/Parent`, resolved through
  `wrapAnnotation` to the parent's typed handle.

No appearance stream — conforming viewers render the popup window.

### Dispatch
Add cases to `wrapAnnotation`: `'FreeText' -> FreeTextAnnotation`,
`'Popup' -> PopupAnnotation`.

### Shared-base note
`BorderWidth` now lives on three subclasses (SquareCircle, Line, FreeText) rather
than base `Annotation`, so Text/Link/etc. do not gain a meaningless border
accessor. Lifting it to a shared intermediate base is deferred until g6p
(Polygon needs it too), per the existing note carried from sub-issue 1.

## Create API (`Page` methods → `annotation.ts` functions)

Thin `Page` wrappers (as with `AddStamp`/`AddLine`) delegating to `addFreeText`
and `addPopup` in `annotation.ts`. Validate-before-attach throughout: every input
is validated before any object is allocated or attached to `/Annots`.

### FreeText

```ts
export interface FreeTextOptions {
  rect: [number, number, number, number];   // the text box, in page space
  contents: string;                          // required displayed text
  fontSize?: number;                         // /DA size, default 12
  textColor?: [number, number, number];      // /DA fill color, default black
  align?: 'left' | 'center' | 'right';       // /Q, default 'left'
  color?: [number, number, number];          // border /C, default black
  fill?: [number, number, number];           // box /IC, omitted -> no fill
  width?: number;                            // border /BS /W, default 1
  callout?: number[];                        // /CL: 4 or 6 finite numbers (page space)
  calloutEnding?: LineEnding;                // /LE at the pointing end; default 'OpenArrow' when callout set
  opacity?: number;                          // /CA, 0..1
  popup?: PopupSpec;                         // auto-attach a companion popup (see below)
}
```

`Page.AddFreeText(opts): FreeTextAnnotation`.

`contents` is required and non-empty. `callout`, when present, must hold exactly
4 or 6 finite numbers. The pointing end of the callout is its first point
(`/CL[0..1]`); the last point attaches to the text box.

### Popup

```ts
export interface PopupSpec {
  rect?: [number, number, number, number];   // popup window box; default derived from parent /Rect
  open?: boolean;                            // /Open, default false
}

export interface PopupOptions extends PopupSpec {
  parent: Annotation | PdfDict;              // the markup this popup belongs to (must be an attached, indirect annotation)
}
```

`Page.AddPopup(opts): PopupAnnotation`. Builds a `/Popup` annotation dict, sets
its `/Parent` to the parent's ref, and sets the parent's `/Popup` to the new
popup's ref. When `rect` is omitted it defaults to a ~200×100 box placed beside
the parent's `/Rect` (right edge, top-aligned).

The parent must be an indirect (allocated) annotation dict so it can be
referenced; annotations created by this library's `Add*` methods always are.
Validate before mutating: reject a parent with no resolvable ref.

### Auto-popup

Centralized in the existing `createAnnotation` helper: add an optional
`popup?: PopupSpec` to `BaseAnnotInit`. When set, after the parent dict is
allocated and pushed onto `/Annots`, `createAnnotation` builds and links a popup
via the shared `createPopup(doc, page, parentRef, spec)` implementation (the same
one `addPopup` uses).

Each markup-family public options interface gains a `popup?: PopupSpec` field
forwarded into its `createAnnotation({ ..., popup: opts.popup })` call:
FreeText, Square/Circle, Line, Highlight/Underline/StrikeOut/Squiggly, Stamp,
and TextNote. Link, FileAttachment, and Popup do not expose it (Links have no
popup; a popup cannot own a popup).

## Appearance generation (`src/annotation.ts` + one helper in `appearance.ts`)

Reuses `buildAppearanceXObject`, `installAP`, `WidgetGeom`, the private
`drawEnding` arrowhead helper, and the `/GS0` ExtGState opacity path already used
by `addMarkup`/`installShapeAP` (when `opacity < 1`, prepend `/GS0 gs` and
register a `ca`/`CA` ExtGState in the form's `/Resources`).

Popups get no appearance stream.

### Shared wrapped-text helper (`appearance.ts`)
Add and export one helper that emits body ops for wrapped, aligned text within a
box:

```ts
export function wrapTextBody(
  text: string, std: StdFont, size: number, color: [number, number, number],
  boxW: number, boxH: number, inset: number, align: 'left' | 'center' | 'right',
): string;
```

Greedy word-wrap (reusing the existing `wrapLines`) + `measure` for per-line
alignment, top-anchored, `leading = size * 1.15`. The form's existing
`multilineText` is left untouched to limit blast radius; a future refactor may
fold it onto this helper.

### FreeText — no callout
`/Rect` is used as given (the text box). Body:
1. optional `/IC` fill: `r g b rg 0 0 w h re f`.
2. optional inset border stroke (like Square): inset by half the border width,
   `r g b RG width w x y w h re S`; record the half-inset in `/RD`
   (`[half half half half]`).
3. wrapped text via `wrapTextBody`, using `fontSize`, `textColor`, `align`, and
   the border width as inset.

### FreeText — with callout
`/CL` holds the true leader points in page space. `/Rect` is derived as the bbox
of (text box ∪ all callout points), padded by `margin = max(width, endingSize)`
where `endingSize = max(8, 3·width)` (mirrors `addLine`). `/RD` records the
padding between `/Rect` and the text box `[left, top, right, bottom]` per PDF
32000-1 Table 174. `/IT` is set to `FreeTextCallout`.

Body (all geometry translated into BBox space, origin at `/Rect` lower-left):
1. the text box fill/border/text exactly as the no-callout case, but positioned
   at the text box's offset within the BBox.
2. the `/CL` polyline stroked in the border color/width (`m` … `l` … `S`).
3. an arrowhead at the pointing end (first `/CL` point) via `drawEnding`,
   oriented along the first segment; default `'OpenArrow'` unless
   `calloutEnding` overrides. `'None'` draws no head.

## Testing (`test/`)

Fixtures in `test/helpers/build-annot-target.ts` (mirroring
`buildShapeReadTarget`): a read-back builder producing a page with a `/FreeText`
(with `/DA`, `/Q`, `/IC`, `/BS`, `/CL`, `/LE`) and a `/Popup` linked to a parent
markup (parent `/Popup` → popup, popup `/Parent` → parent).

`test/annotation.test.ts` additions:

- **Read model:** typed handles from `Page.Annotations`; `Alignment`,
  `FontSize`, `TextColor`, `BorderWidth`, `InteriorColor`, `Intent`,
  `CalloutLine`, `CalloutEnding` read correctly for FreeText; `Open` and a typed
  `Parent` for Popup.
- **Setters:** round-trip each accessor; `FontSize`/`TextColor` each preserve the
  other in `/DA`; `undefined`/out-of-range/malformed inputs rejected with
  `TypeError`.
- **Create FreeText:** `AddFreeText` attaches a well-formed dict to `/Annots`
  with `/Type /Annot`, `/Subtype /FreeText`, `/Rect`, `/DA`, default `/F` print,
  and an installed `/AP /N` Form XObject. Callout variant sets `/CL`, `/LE`,
  `/IT FreeTextCallout`, and an enlarged `/Rect` + `/RD`.
- **Create Popup:** `AddPopup` attaches a `/Popup` dict, sets its `/Parent` to
  the parent ref, and sets the parent's `/Popup` to the popup ref; no `/AP`.
- **Auto-popup:** an `Add*` call with `popup` attaches both the parent and a
  linked popup; the linkage is symmetric.
- **Appearance sanity:** decoded FreeText `/AP /N` contains text (`Tj`), the
  callout stroke (`m`/`l`/`S`) and arrowhead path, and `/GS0 gs` when
  `opacity < 1`.
- **Validate-before-attach:** invalid inputs (empty contents, bad `/CL` length,
  parent with no ref, out-of-range colors) throw before `/Annots` grows.

Run `npm run typecheck` and `npm test` green before closing.

## Docs (`README.md`)

- Add `AddFreeText`/`AddPopup` usage to the annotations example and the
  API-overview table.
- Extend the typed-handle paragraph with `FreeTextAnnotation`
  (`Alignment`/`FontSize`/`TextColor`/`BorderWidth`/`InteriorColor`/`CalloutLine`)
  and `PopupAnnotation` (`Open`/`Parent`).
- Note the `popup` auto-attach option on the markup-family `Add*` methods.
- Update the Limitations note to list only the still-unmodeled subtypes:
  Ink, Polygon/Polyline (pending g6p).
