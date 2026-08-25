# Redaction removes annotations covering the region

Closes `mssf`. Redaction removes the text and images under a region, but
annotations over that region survive untouched, so their text stays in the file
and, in the `/AP`-bearing cases, stays on the page.

## What actually leaks

Measured, not assumed. A page whose content and four annotations all sit inside
one redaction region, after `page.Redact` and again after `ApplyRedactions`:

| Secret | Carried by | Raw bytes | `GetText()` |
|---|---|---|---|
| `PageSecret` | page content | gone | gone |
| `NoteSecret` | `/Text` `/Contents` | **leaks** | gone |
| `AuthorSecret` | `/Text` `/T` | **leaks** | gone |
| `FreeTextSecret` | `/FreeText` `/Contents` + `/AP` | **leaks** | gone |
| `HighlightSecret` | `/Highlight` `/Contents` | **leaks** | gone |
| `LinkSecret` | `/Link` `/A` `/URI` | **leaks** | gone |

All four annotations remain on the page. Two findings beyond the filed report:

- **`GetText()` cannot see any of it.** It walks page content only, so the
  library's own text extraction reports every one of these as gone. A test
  written against `GetText` would pass on a document that still carries the lot.
- **The ink still renders.** `ToSvg()` of the redacted page still contains
  `FreeTextSecret`. The marker box is painted into page *content*, and
  annotations composite on top of page content, so a `/FreeText` over a redacted
  region is drawn **over** the box and is plainly readable. This is a visible
  failure, not only a metadata leak.

**Root cause** is structural rather than a logic defect: `redactRegions` operates
exclusively on content streams through `EditableContent`. `/Annots` is a separate
object graph that content surgery never visits, and no code path in `redact.ts`
or `redactapply.ts` reads it.

The second finding rules out one of the two fixes the issue proposed. Scrubbing
an annotation's text keys cannot work on its own, because `/Contents` is also
baked into `/AP`; closing the visible leak would mean regenerating or dropping
every appearance, which removes the visible annotation anyway. So the annotation
goes.

## The rule

An annotation is removed when its `/Rect` intersects any redaction rect. Reuse
the `intersects` helper already in `redact.ts` (inclusive, so touching edges
count). An annotation whose `/Rect` is missing or malformed is skipped — there is
nothing to judge it by.

Intersection, not containment: a `/FreeText` hanging half out of the region
carries its whole text and draws all of it, so containment would leave exactly
the leak this closes. Redaction is a security operation and the bias belongs on
the side of over-removal.

**Invariant:** a `/Redact` annotation is never swept. Marks are redaction
machinery, not page content. This is also what keeps the ordering decoupled:
`applyRedactions` still owns removing its own marks *after* `paintRedactOverlay`
has read their `/IC`, `/OverlayText` and `/RO`, and the sweep cannot pull them
out from under it.

## Widgets

A widget is an annotation, but its value lives on the *field*. Detaching the
widget alone would leave the field and its `/V` in `/AcroForm /Fields` — both a
leak and the stranded-object bug `CLAUDE.md` already carries an invariant
against.

A covered widget therefore resolves to its terminal field, and the field goes
through `removeField(doc, fieldDict)` (`formremove.ts`), which unwires it from
`/AcroForm /Fields`, detaches **every** widget it owns including ones on other
pages, and untags. A radio group with a single widget in the region loses the
whole group; that is the honest consequence of a shared `/V`.

`doc.Form` is rebuilt on each access, so no held handle goes stale.

## Popups

A markup annotation's `/Popup` is removed along with its parent, mirroring the
orphan handling in `flatten.ts`. A popup that intersects the region on its own
account is already removed by the uniform rule.

## API

One new optional field on each existing options interface, alongside the fields
they already carry (`color`/`scrubMetadata` and `scrubMetadata` respectively):

```ts
/** Keep annotations overlapping a redacted region instead of removing them.
 *  Default false. Setting it preserves their text in the saved file. */
keepAnnotations?: boolean;
```

Default `false` — secure by default. The flag reaches `page.Redact`,
`page.RedactText`, `doc.Redact`, `doc.RedactText` and `ApplyRedactions`, and
exists for the caller who deliberately wants an overlapping annotation kept (say,
redacting an image region beneath a review comment that should survive). Setting
it is a leak by construction, and the README says so.

## Module

New `src/redactannots.ts`:

```ts
export function removeCoveredAnnotations(
  doc: Document, page: Page, rects: Rect[],
): number
```

Called from `redactRegions`, so every redaction path shares one implementation.
The return count is internal — `Redact` returns `void` today and this does not
change that.

It operates on raw dicts (`/Rect`, `/Subtype`, `/Popup`) plus `formremove.ts`,
so it needs no `annotation.ts` import. Removal of a non-widget goes through
`Page.RemoveAnnotation`, which accepts a raw dict and is what calls
`untagObjects` — the same reason `applyRedactions` uses it.

Dependency direction: `redact.ts` → `redactannots.ts` → `formremove.ts`, with
`Document`/`Page` as type-only imports. No cycle.

This relaxes the `CLAUDE.md` note that `redact.ts` "imports no annotation code".
That line exists to explain why `redactapply.ts` is a separate module — the
mark-and-apply concern — and a one-line delegation to a named module does not
blur that boundary. Reword it rather than leave it contradicted.

## Errors

No new error paths. The sweep throws nothing: an unreadable `/Rect`, a widget
whose field cannot be located, and a `/Popup` whose `/Parent` is missing are each
skipped. Redaction must not fail on an annotation shape we merely decline to
judge — the same posture `flatten.ts` takes toward tree shapes it will not
author into.

Ordering inside `redactRegions` is unchanged: removal → sanitize → commit →
paint. The annotation sweep runs **last, after `paint`**, so the painter sees an
unchanged annotation set. Nothing in the sweep touches content streams, so the
position is free; pinning it after `paint` keeps `applyRedactions`'s overlay
painter — which reads its marks' `/IC`, `/OverlayText` and `/RO` — unaffected by
any sweep ordering question.

## Testing

The characterisation probe becomes the test, asserting **on raw saved bytes**.
`GetText()` cannot see any of these leaks, so a test written against it would
pass on a document that still carries every secret.

1. After `page.Redact`, none of `NoteSecret`, `AuthorSecret`, `FreeTextSecret`,
   `HighlightSecret` or `LinkSecret` appears in the saved bytes, and no
   annotation remains on the page.
2. The same after `ApplyRedactions`.
3. `ToSvg()` of the redacted page no longer contains the `/FreeText` ink — the
   visible half of the leak.
4. An annotation entirely outside the region survives, with its `/Contents`
   intact. Over-removal would be as wrong as under-removal.
5. A covered widget takes its whole field: `/V` gone from the bytes, the field
   gone from `/AcroForm /Fields`.
6. A radio group with one widget in the region loses the group, including the
   widget on a page the redaction never touched.
7. A `/Popup` orphaned by its parent's removal is removed too.
8. `/Redact` marks are never swept: `ApplyRedactions` still returns the right
   count and still paints each overlay.
9. `keepAnnotations: true` leaves the annotations — and the secrets — in place.
10. A tagged annotation removed by the sweep leaves no `/OBJR` behind, the same
    invariant `0pvw.1` established for applied marks.

Assertions 3 and 10 are the ones to mutation-check: both pass trivially on a
correct implementation, and both cover a failure that is invisible in the
model — one only shows up in a render, the other only in the saved bytes.
