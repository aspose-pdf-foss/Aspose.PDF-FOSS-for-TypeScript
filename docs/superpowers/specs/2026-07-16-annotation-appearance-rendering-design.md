# Render annotation & form-field /AP appearances in ToImage/ToSvg

Issue: `aspose-pdf-foss-for-ts-57b`
Date: 2026-07-16

## Problem

`page.ToImage()` and `page.ToSvg()` interpret only the page content stream.
Annotation and widget `/AP` appearance streams are ignored, so a signed,
annotated, or filled document renders incompletely — a stamp, a filled text
field, or a signature appearance is simply absent from the output.

## Approach

Both backends already funnel through `interpret()` (`src/pagerender.ts`), and
`drawForm()` in the same module already implements everything an `/AP` stream
needs: `/Matrix ∘ CTM`, a clip to `/BBox`, the stream's own `/Resources`, and
depth + cycle guards. The feature is therefore a post-content pass over
`/Annots` that reuses `drawForm`. SVG and raster both light up with no backend
changes.

The appearance-selection rules (`/AP /N`, `/AS`, `/F`, `/Rect`+`/BBox`+`/Matrix`
placement) already exist in `src/flatten.ts`, but in a doc-mutating form
(`allocObject` promotes an inline `/AP` stream to an indirect object so it can be
shared from `/Resources`). Rendering must not mutate the document, so the rules
move to a new read-only module that both consumers build on.

## Components

### `src/annotappearance.ts` (new)

The single home for the `/AP` resolution rules. Read-only — never mutates the
document.

```ts
export interface AnnotAppearance {
  entry: PdfObject;   // the raw /N (or /AS-selected) entry, un-promoted
  stream: PdfStream;  // the resolved appearance stream
  place: Matrix;      // /Rect + /BBox + /Matrix placement matrix
}

export function isAnnotVisible(doc: Document, annot: PdfDict): boolean;
export function resolveAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined;
```

`isAnnotVisible` is false for `/F` bit 2 (Hidden, value 2), `/F` bit 6 (NoView,
value 32), and `/Subtype /Popup`.

`resolveAppearance` returns `undefined` when there is no usable appearance: no
`/AP`, an `/N` state subdictionary with no matching `/AS`, a missing `/BBox`, or
a degenerate placement. Returning the un-promoted `entry` alongside the resolved
`stream` lets each consumer take what it needs.

### `src/flatten.ts` (refactor)

`normalAppearanceRef` and `numArray` collapse into a thin wrapper over
`resolveAppearance`. Its mutation stays local:

```ts
const a = resolveAppearance(doc, annot);
const ref = isRef(a.entry) ? a.entry : doc.allocObject(a.stream);
```

and it uses `a.place` for the `cm` it emits.

Flatten **keeps its own `flags()` check** (Hidden | NoView) and does *not* adopt
`isAnnotVisible`, because that predicate also excludes `/Popup` and adopting it
would silently change flatten's behavior. Only the appearance *resolution* is
shared; the *visibility policy* stays per-consumer for now. Flatten's behavior
across this refactor is therefore unchanged — see Out of Scope, and
`aspose-pdf-foss-for-ts-vdp` for converging the two predicates.

This means `isAnnotVisible` has exactly one caller (the render pass) on landing.
That is intentional: it keeps `annotappearance.ts` the home for *all* the `/AP`
display rules rather than splitting them across two modules, and `vdp` makes it
the second caller.

### `src/pagerender.ts` (extend)

```ts
export interface InterpretOptions { annotations?: boolean }

export function interpret(doc, page, base, sink, opts?: InterpretOptions): void {
  const ctx = { doc, sink, resources: page.Resources, depth: 0, seen: new Set() };
  walk(ctx, page.Contents, initialState(base));
  if (opts?.annotations !== false) drawAnnots(ctx, page, base);
}
```

`drawAnnots` iterates `/Annots`, and for each entry that resolves to a dict,
passes `isAnnotVisible`, and yields an `AnnotAppearance`:

```ts
drawForm(ctx, { ...initialState(mul(ap.place, base)) }, ap.stream);
```

Each annotation starts from a **fresh** `initialState`. Annotations do not
inherit page graphics state, and one annotation must not leak color, clip, or
text state into the next.

### Matrix composition

`placementMatrix(bbox, matrix, rect)` (`src/text.ts`) maps the *`/Matrix`-
transformed* BBox onto `/Rect`. `drawForm` then re-applies the stream's
`/Matrix`, so the effective transform is `Matrix × place × base` and the BBox
clip is computed under the same CTM. This matches PDF 32000-1 §12.5.5 (the
appearance-stream placement algorithm).

## Public API

`SvgOptions.annotations?: boolean` and `ImageOptions.annotations?: boolean`,
both defaulting to `true`, plumbed through to `interpret`.

Appearances composite by default: that matches every viewer, and a default that
omitted them would leave the reported bug unfixed. Callers wanting content-only
output pass `annotations: false`.

## Error handling

`renderPageToSvg` / `renderPageToPng` already wrap `interpret` in a try/catch
and degrade — whatever composited before a failure still renders. That
granularity is too coarse for the annotation pass: one malformed appearance
would drop every remaining annotation. Each annotation's `drawForm` call gets
its own try/catch, so a bad `/AP` costs only itself. Page-content behavior is
unchanged, and the "never throws" contract of both entry points holds.

## Testing

New `test/annotrender.test.ts`, with fixtures authored through the public API
(`page.AddStamp` and friends already generate `/AP` streams), mirroring the
existing `test/helpers/` builder style. Where a case needs an `/AP` shape the
public API will not produce (a custom `/Matrix`, a widget `/AS` sub-state
dictionary), the fixture builds the annotation dict directly.

- a stamp `/AP` composites at its `/Rect` — SVG assertion on the emitted
  transform; raster pixel probe inside vs. outside the Rect
- `/BBox` smaller than `/Rect` scales the placement; a `/Matrix` rotation
  produces correct bounds
- `/F` Hidden (2) and NoView (32) are skipped
- `/Subtype /Popup` is skipped
- a widget `/AS` selects the right `/N` sub-state (checkbox on vs. off)
- a filled text field and a signature appearance render
- `annotations: false` suppresses the pass
- an annotation with no `/AP`, and one with an `/AS` naming a missing state, are
  silent no-ops
- a malformed `/AP` does not suppress a following good annotation
- existing render tests stay green (verified: no current render test fixture
  carries annotations, so the default-on change disturbs none of them)

Existing `test/flatten*.test.ts` must stay green across the refactor — it is the
regression net proving the extracted rules did not change meaning.

## Documentation

- README *Rendering (page → PNG)* and *SVG rendering is preview-grade* bullets:
  state that `/AP` appearances composite by default and how to opt out.
- README line ~915 still claims "annotation flattening is out of scope", stale
  since flatten shipped. Fixed in passing.
- `CLAUDE.md` architecture overview: add `annotappearance.ts` to the module map.

## Out of Scope

- **`/D` (down) appearances.** `/D` is shown only while a mouse button is held
  on a widget. A static page render has no mouse state, so `/D` is unreachable
  and every viewer composites `/N`. The issue's acceptance criteria mention
  `/D`; it is dropped as YAGNI. `/AS` is still honored — it selects the
  sub-state *within* `/N`.
- **Flatten's `/Popup` handling.** `flattenPageAnnots` currently bakes `/Popup`
  annotations, which the new `isAnnotVisible` excludes. Routing flatten through
  the predicate would fix that, but it changes existing flatten behavior, so it
  is filed separately as `aspose-pdf-foss-for-ts-vdp`. This work therefore
  shares only appearance *resolution* with flatten, not the *visibility
  predicate*, and preserves flatten's current behavior exactly.
- Tiling patterns, soft masks, blend modes, transparency groups inside
  appearance streams — they degrade exactly as they do in page content today
  (tracked by `aspose-pdf-foss-for-ts-a6i`).
