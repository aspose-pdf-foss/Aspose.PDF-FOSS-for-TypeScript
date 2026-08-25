# Redact annotation: mark mode, overlay text and style

Closes `0pvw.1` (epic `0pvw`, annotation coverage completion). Parity target:
`Aspose-PDF-FOSS-for-Go` `_examples/feature_showcase/main.go`.

Redaction today is a single destructive call: `page.Redact(rects)` removes the
covered content and paints a flat box, all in one step. PDF 32000-1 §12.5.6.23
describes the other half — a `/Redact` annotation that *marks* a region and
carries the overlay to paint once someone applies it. The mark is a reviewable
artifact: it survives a save, another tool can see it, and applying it is a
separate, deliberate act.

This adds the annotation type and an apply step that consumes marks. The
destructive machinery in `redact.ts` is reused unchanged.

## API

```ts
// page.ts
AddRedact(opts: RedactAnnotationOptions): RedactAnnotation
MarkRedactText(find: string | RegExp, opts?: MarkRedactTextOptions): number
ApplyRedactions(opts?: ApplyRedactionsOptions): number

// document.ts — mirrors, as Redact/RedactText already have
MarkRedactText(find: string | RegExp, opts?: MarkRedactTextOptions): number
ApplyRedactions(opts?: ApplyRedactionsOptions): number
```

`MarkRedactTextOptions` is `Omit<RedactAnnotationOptions, 'quads' | 'rect'>` —
the region comes from the search. `ApplyRedactionsOptions` carries
`scrubMetadata?: boolean` only; the marker colour that `RedactOptions` has is
not meaningful here, because every applied region takes its colour from its own
annotation.

`RedactAnnotationOptions` reuses the `FreeTextOptions` vocabulary already in
`annotation.ts`, so the two text-bearing annotations read alike:

| Option | Writes | Default |
|---|---|---|
| `quads` \| `rect` | `/QuadPoints` (exactly one of the two; `rect` expands to a single quad) | required |
| `color` | `/C` — the pending-mark outline | `[1, 0, 0]` red |
| `fill` | `/IC` — painted over the region on apply | `[0, 0, 0]` black |
| `overlayText` | `/OverlayText` | absent |
| `repeat` | `/Repeat` | `false` |
| `align` | `/Q` (`'left'` \| `'center'` \| `'right'`) | `'left'` |
| `fontSize`, `textColor` | `/DA` (font `Helv`) | `12`, `[1, 1, 1]` white |
| `contents`, `author`, `opacity`, `popup` | `/Contents`, `/T`, `/CA`, `/Popup` | absent |

The name distinguishes it from `RedactOptions` in `redact.ts`, which configures
the unrelated destructive `Redact`. This is the same collision
`StampAnnotationOptions` resolved against `stamp.ts`'s `StampOptions`.

`RedactAnnotation extends Annotation` with live accessors `QuadPoints`,
`InteriorColor` (`/IC`), `OverlayText`, `Repeat`, `Alignment` (`/Q`), and a
read-only `Overlay` (`/RO`).

`/RO` is read but never authored. It is a form XObject holding arbitrary overlay
artwork; honouring one that Acrobat wrote costs a `Do`, while authoring one adds
a second way to say what `/IC` + `/OverlayText` already say.

### Shared accessors

`QuadPoints` already exists on `MarkupAnnotation`, and `Alignment` and
`InteriorColor` on `FreeTextAnnotation`. `RedactAnnotation` needs all three and
TypeScript has single inheritance, so the bodies move to module-private
get/set helpers in `annotation.ts` that all three classes delegate to. A third
copy of the same `/QuadPoints` validation is how the two halves of a shared
grammar drift apart.

## Modules

| File | Change |
|---|---|
| `src/annotation.ts` | `RedactAnnotation`, `RedactAnnotationOptions`, `addRedact`, the `wrapAnnotation` case, shared accessor helpers |
| `src/annotdraw.ts` | `redactMarkBody(qs, color)` — the pending-mark outline |
| `src/redactapply.ts` | **new**: `applyRedactions`, `paintRedactOverlay`, `markRedactText` |
| `src/redact.ts` | the `redactRegions` seam; no behaviour change |
| `src/page.ts`, `src/document.ts`, `src/index.ts` | wiring and exports |
| `README.md`, `CLAUDE.md` | user-facing docs and the architecture note |

`redactapply.ts` is its own module because `redact.ts` owns destructive content
surgery — glyph rewriting, image re-encoding, resource pruning — and imports no
annotation code. The apply layer reads annotation dicts and paints overlays,
which is a different job with a different dependency set. Same split as
`imageredact.ts` out of `redact.ts`, `annotdraw.ts` out of `annotation.ts`,
`tocrender.ts` out of `toc.ts`.

No cycle: `page.ts → redactapply.ts → { redact.ts, annotation.ts, stamp.ts }`,
and nothing in that second row imports `redactapply.ts`.

### The redact.ts seam

`redactPage` fuses four steps: remove content, sanitize resources, commit, paint.
The first three are exactly what apply needs and their order is load-bearing —
the module's own comment records that a split pass lets glyph rewrites and image
removals drift each other's op indices. So the painter becomes a parameter:

```ts
export function redactRegions(
  doc: Document, page: Page, rects: Rect[], paint: (rects: Rect[]) => void,
): void
```

`redactPage` passes `rs => paintRedactionBoxes(doc, page, rs, opts.color)`;
`applyRedactions` passes a closure that paints each annotation's overlay. One
copy of the ordering, two painters.

**Invariant:** the removal → sanitize → commit ordering lives in `redactRegions`
and nowhere else. A second caller that re-derives it is a caller that will
eventually re-derive it wrong, and the failure is silent: the content looks
redacted and the op indices are off by the length of an earlier edit.

## Mark appearance

`AddRedact` installs an `/AP /N` that strokes each quad's outline in `/C`, with
no fill. The content underneath stays readable.

**Invariant:** an unapplied mark must not look like an applied redaction. Both
`ToImage`/`ToSvg` and `FlattenAnnotations` composite `/AP /N`, so an `/AP` that
previewed the final `/IC` fill would render a document whose text is still fully
extractable as though it were already redacted — the classic redaction failure,
manufactured by us. The outline is the whole point: it reads as pending.

## Apply pipeline

```
page.ApplyRedactions(opts)
  1. collect RedactAnnotation[] from the page's own /Annots, in /Annots order
  2. rects = each annotation's /QuadPoints reduced to one Rect per quad
     (the quad's bounding box, via quadsBBox), falling back to its /Rect
     — one with neither is skipped and not counted, never thrown
  3. rects empty -> return 0; no content rewrite, no metadata scrub
  4. redactRegions(doc, page, rects, paint):
        removeRegionContent    glyphs + images, one fused pass
        sanitizeResources      prune what that orphaned
        ec.commit()
        paint -> paintRedactOverlay per annotation
  5. page.RemoveAnnotation(annot) for each
  6. opts.scrubMetadata -> doc.ClearMetadata()
  7. return the number of annotations applied
```

Steps 4 and 5 must stay in that order. The overlay painter needs the annotation
dicts alive, and the paint must land after `ec.commit()` so it sits on top of
what survived.

Removal goes through `Page.RemoveAnnotation`, not a raw `/Annots` splice, because
that is what calls `untagObjects` — the invariant recorded in `CLAUDE.md` for
`struct.ts`. A tagged annotation is also named by an `/OBJR` reachable from
`/Root`, so a raw splice leaves it in the saved bytes with no `/Annots` entry
anywhere. Once detached, the pending-mark `/AP` is unreachable and `Save()`'s
mark-sweep collects it.

Falling back to `/Rect` when `/QuadPoints` is absent is for documents we did not
author; `AddRedact` always writes `/QuadPoints`.

## Overlay painting

`paintRedactOverlay(doc, page, annot)` introduces no rendering primitives — the
rule `tocrender.ts` follows.

1. `/RO` present → draw that form XObject into the region and stop. §12.5.6.23
   gives it precedence over `/IC` and `/OverlayText`; a viewer that renders the
   mark shows `/RO`, so applying it must produce the same ink.
2. Otherwise fill each quad with `/IC` through `PageGraphics`, reusing the
   geometry `paintRedactionBoxes` already uses.
3. Then draw `/OverlayText` with `stampText`, using the `/DA` font and size and
   colour, `/Q` for the horizontal anchor, vertically centred in the quad.
4. `/Repeat true` → tile the text across the quad, stepping by its `measure()`
   width and by the line height, until the quad is full.

### Limitations

Both are carried over unchanged from `paintRedactionBoxes` and get a follow-up
issue rather than scope creep here:

- Apply does not remove other annotations overlapping a redacted region. A
  sticky note under a redaction keeps its `/Contents`.
- The painted overlay is untagged content, which a tagged document should not
  contain.

## Errors

Validation runs before any allocation, so a rejected call leaves the document
byte-identical — the rule `formcreate.ts` states and the whole `Add*` family
follows.

| Case | Behaviour |
|---|---|
| Both `quads` and `rect`, or neither | `TypeError`; no annotation added |
| Malformed quads, colour out of 0..1, non-positive `fontSize`, bad `align` | `TypeError`; no annotation added |
| `ApplyRedactions` with no marks | returns `0`; document untouched |
| `/Redact` with neither `/QuadPoints` nor `/Rect` | skipped, not counted, not thrown |
| Partially-covered undecodable image | `UnsupportedFeatureError` from the existing pipeline |

The last one is why step 5 follows step 4: the throw happens inside
`removeRegionContent`, before `ec.commit()`, so a failed apply leaves both the
page content and the marks intact and the call can be retried.

## Testing

Programmatic fixtures via `test/helpers/`, matching the existing builder style.

1. **A mark is not a redaction.** `AddRedact`, `Save`, `Open`, and `GetText()`
   still returns the secret. This is the assertion the whole design exists to
   make true; it must fail if `AddRedact` ever starts removing content.
2. **Apply is destructive.** After `ApplyRedactions()`, `GetText()` no longer
   contains the secret, no `/Redact` annotation remains, and the count is right.
3. Round-trip: every authored key reads back through `wrapAnnotation` as a
   `RedactAnnotation` with working accessors.
4. Overlay: the `/IC` fill and the overlay text reach page content; `/Q` moves
   the anchor; `/Repeat` emits more than one draw of the text.
5. `/RO` precedence, on a hand-built annotation: the form is drawn and the
   `/IC` fill and overlay text are not.
6. `MarkRedactText` adds one annotation per match and applying clears them all.
7. Empty page: `ApplyRedactions()` returns `0` and rewrites nothing.
8. Validation: `quads` and `rect` together throw and add no annotation.
9. A tagged `/Redact` annotation is untagged on apply — no surviving `/OBJR`.
10. A partially-covered undecodable image throws, leaving content and marks
    intact.

Assertions 1 and 9 are the ones to mutation-test: both pass trivially on a
correct implementation and both cover a failure that is invisible in the
rendered page.
