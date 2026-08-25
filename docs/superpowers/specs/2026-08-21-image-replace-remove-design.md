# Image replace and remove — design

Issue: `10u9.4`, under epic `10u9` (Colour and raster breadth, `gap-vs-go`).
Date: 2026-08-21.

Go has `image_replace.go` and `image_remove.go`; TS has neither. An embedded
image can be enumerated (`page.Images`) and read (`ImageInfo.Decode`), but the
only way to get rid of one is to redact a rectangle over it, and there is no way
at all to swap one picture for another.

Nearly every part this needs is already here and separately tested:
`EditableContent` (per-stream op model with Form-XObject copy-on-write),
`imageCutSet` (the `q … cm … Do … Q` group cut), `sanitizeResources` (orphan
resource pruning), `buildImageXObject` (JPEG/PNG/BMP/TIFF, the latter two new
this epic), and `Save()`'s mark-sweep. What is actually new is a **public
surface** over them and the aliasing rules that surface implies.

## Scope

Two methods on the existing `ImageInfo` handle, both scoped to the page that
handle came from.

Covered: replacing an image XObject's picture while keeping its placement;
removing an image XObject from a page, including one nested inside a Form
XObject; multi-page TIFF and explicit format override on replace; opt-in
redaction-grade resource pruning on remove.

Declined with a named reason: inline `BI…EI` images (no handle for one exists —
see **The inline gap** below); document-wide removal; preserving aspect ratio on
replace; a `Replace(path)` overload.

## The three decisions

An image XObject can be drawn by several `Do` ops, in several scopes, on several
pages, while `page.Images` hands back one handle per resource entry of one page.
Every hard question here is a consequence of that.

**Remove takes this page's draws only.** Every `Do` of that stream on this page —
page content streams and the Form XObjects the page descends into — is dropped,
the resource entry goes, and `Save()` collects the XObject if nothing else points
at it. Other pages drawing the same object are untouched. This is what `page.Images`
already means, and what `redact.ts` already does.

**Replace is copy-on-write, per page.** A fresh XObject is built and this page's
resource key repointed at it. Mutating the stream in place — Go's shape — is
simpler and would update every page at once, but a per-page handle silently
editing other pages contradicts Remove, and a caller cannot see which reading
they are getting. If the image was unshared the old object is orphaned and swept,
so the output file is the same size either way; the copy costs nothing that
reaches disk.

**Cleanup is targeted, with an opt-in escalation.** Remove deletes the
`/XObject` key it occupied and nothing else. Anything the cut block referenced
but nothing else uses — an `/ExtGState` registered for opacity — stays.
`Remove({ sanitize: true })` escalates to `sanitizeResources`, the full prune of
unreferenced `/Font`, `/XObject` and `/ExtGState` names that redaction runs.

**Invariant:** the flag changes which `/Resources` entries survive, never which
objects reach the file. `Save()` sweeps from `/Root`, so an orphaned stream is
gone under either setting. A test asserting only that the image is absent from
the saved bytes therefore passes with `sanitize` ignored entirely; the flag is
pinned by asserting the surviving `/ExtGState` entry both ways.

## Module layout

`redact.ts` imports `image.ts` for its decoder (`new ImageInfo(doc, '', stream).Decode()`).
So an edit module reachable from `ImageInfo` must not import `redact.ts`, or the
cycle closes straight back through the class whose methods started it. Two pure
moves make that true, and both are extractions of the kind `redactannots.ts`,
`bordersides.ts` and `choiceopt.ts` already make.

- **`imageCutSet` moves `redact.ts` → `content.ts`.** It is pure `ContentOp[]`
  arithmetic — walk back over `cm`, check for an enclosing `q`/`Q`, return the
  index set — with no `Document` knowledge at all, and `content.ts` is a leaf
  (`lexer.ts`, `types.ts`, `serialize.ts`). Its neighbour `dropDraws` — a thin
  `ops.filter` over the same cut set — is **deleted**: it has no caller anywhere
  in `src/`, `test/` or `scripts/`, verified before the move, and carrying dead
  code across an extraction is how a second owner of the cut rule appears.
- **`sanitizeResources`, `pruneResources`, `referencedNames`, `mergeRefs` and
  `NAME_OP` move `redact.ts` → new `src/resprune.ts`**, a leaf taking `Document`,
  `Page` and `EditableContent` type-only.

**Invariant:** there is ONE owner for each of those rules. Two copies of the
group-cut rule is how a remove comes to leave a stranded `q` that a redaction
would have taken, and two copies of the prune is how the two features come to
disagree about what "unreferenced" means.

Then:

- **NEW `src/imageedit.ts`** — the object-graph and content-stream work behind
  both methods. Imports `editcontent.ts`, `imageembed.ts`, `pagecontent.ts`,
  `content.ts`, `resprune.ts`, `types.ts`, `errors.ts`; `Document` and `Page`
  type-only. It must import neither `redact.ts` nor `image.ts` — it takes plain
  arguments (`doc`, `page`, the target `PdfStream`), which is also what lets its
  scope walk be driven from hand-built resource dicts.
- `image.ts` — `ImageInfo` gains a `page?: Page` field (type-only import) and two
  thin delegating methods.
- `page.ts` — `collectImages(this.doc, this.Resources, this)`.
- `editcontent.ts` — one new method, `ownXObjectResources(path)`.

**Invariant:** the value-import closures of `imageembed.ts`, `editcontent.ts`,
`pagecontent.ts` and `content.ts` were each checked to contain no path back to
`image.ts` before this layout was chosen. That is what makes the methods
placeable on `ImageInfo` at all; if a future edit adds such an edge, the methods
have to move to `page.ts` and take the handle as an argument.

## Public surface

```ts
class ImageInfo {
  /** Swap the picture, keeping its placement on the page. */
  Replace(data: Uint8Array, opts?: ReplaceImageOptions): void;
  /** Drop this image from the page it was enumerated from. */
  Remove(opts?: RemoveImageOptions): void;
}

export interface ReplaceImageOptions {
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Which image of a multi-image file to use, 0-based. TIFF only. Default 0. */
  page?: number;
}

export interface RemoveImageOptions {
  /** Also prune every now-unreferenced /Font, /XObject and /ExtGState name from
   *  the page and each edited form, as redaction does. Default false. */
  sanitize?: boolean;
}
```

`Uint8Array` in, no path overload: `AddImage` already sets that precedent and
`node.ts` owns file convenience. `format` and `page` mirror `AddImageOptions`
exactly rather than being renamed, so a caller who knows one knows the other —
and `page` carries the same refusal, throwing for a format with no pages rather
than silently ignoring a value the caller believed in.

**Placement is unchanged, and the new image is stretched into the old
footprint.** The `cm` that sizes an image lives in the content stream, not the
XObject, so a replacement of different proportions is distorted rather than
re-fitted. That is Go's documented behaviour and the honest one: the caller asked
to change the picture, not the layout, and a `fit` mode would have to decide
which of the two rectangles wins. It is called out in the doc comment because it
is the surprise a caller meets first.

## Replace — data flow

1. `buildImageXObject(data, opts.format, opts.page ?? 0)`, **before any
   mutation**. Unrecognized bytes, a truncated PNG, a `page` a JPEG cannot
   honour — all throw here.
   **Invariant:** a rejected `Replace` leaves the document byte-identical. This
   is `formcreate.ts`'s validate-before-allocating rule, and it is why the build
   is step 1 rather than interleaved with the resource walk.
2. Walk the page's resource tree exactly as `collectImages` does — page
   `/Resources /XObject`, descending into each Form XObject's own — collecting
   every `{ path, key }` whose entry resolves to **this exact `PdfStream`**, by
   pointer identity.
   **Invariant:** the match is on stream identity, never on `ImageInfo.Name`.
   `collectImages` descends into forms, so two forms may each hold an `Im0` and
   a name alone does not say which; identity also catches one stream registered
   under two keys, which a name match would half-remove.
3. No scopes found → `RangeError`. The handle is stale: the image was already
   removed, or the page's resources were rewritten under it.
4. Allocate the new stream, and its `/SMask` when the source had alpha. The dict
   is built **fresh** from `buildImageXObject`, so `/Decode`, `/Mask`,
   `/DecodeParms` and any previous `/SMask` are gone by construction.
   **Invariant:** only `/OC` carries over from the old dict. Everything else in
   an image dict describes the samples that are being thrown away — replacing an
   alpha PNG with an opaque JPEG must not leave the old soft mask behind, which
   would show the new picture through a stencil cut for the old one. Optional
   content membership is the exception because it describes the *slot*: the
   caller put this image on a layer and asked to change the picture, not to take
   it off the layer.
5. Repoint every owning entry, copy-on-writing the owner first —
   `ensureOwnResources` + `ensureOwnSubdict` at page level, `ownXObjectResources`
   for a nested form. No content stream is touched at all.

## Remove — data flow

The same scope walk (steps 2–3 above), then through one `EditableContent`:

1. For each scope, take its ops (`ec.topOps(i)` across every top stream when the
   path is empty, `ec.xobjectOps(path)` otherwise), find the `Do` ops naming one
   of that scope's keys, expand the indices through `imageCutSet`, and write the
   filtered list back.
   **Invariant:** the cut takes the enclosing `q … cm … Do … Q` group, not the
   `Do` alone. A bare `Do` removal leaves the `cm` that positioned it and the
   `q`/`Q` that fenced it — harmless to look at, and a false negative for anyone
   grepping the saved stream to confirm the image is gone.
2. Delete the resource key from the **owned** dict, *after* the op edit.
   **Invariant:** order matters. `cowXObject` clones the form and replaces its
   `/Resources` with a copy, so a dict captured before the op edit is stale and
   deleting from it mutates an object the page no longer points at.
3. `opts.sanitize` → `sanitizeResources(doc, page, ec)`.
4. `ec.commit()`.

An image nested in a form COWs that form, so a second page sharing it keeps its
own copy — which is the per-page rule holding at a depth where it is easy to
lose.

## `EditableContent.ownXObjectResources`

```ts
/** Force the copy-on-write of the Form XObject at `path` and return its owned
 *  /Resources, creating an empty one when it has none. */
ownXObjectResources(path: readonly string[]): PdfDict
```

Replace needs a nested form's resources copy-on-written **without** rewriting its
content stream. Today the only way to trigger that COW is to call
`xobjectOps(path)` purely for the side effect and discard the result, and
`xobjectResources(path)` returns `undefined` until it has happened. The method
makes the intent readable and is a no-op on a scope already COW'd.

`commit()` needs no change: it skips a non-dirty scope, and `cowXObject` has
already repointed the parent entry at the clone by then, so the resource edit is
live whether or not the ops were touched.

## The inline gap

An inline `BI…EI` image has no `/XObject` entry, so `collectImages` never sees
one and no `ImageInfo` for one can exist. Go refuses inline removal explicitly
(`inline images cannot be removed`); here the refusal is structural instead —
there is nothing to call the method on.

This is a real gap rather than a completed feature, and it is recorded as one:
removing an inline image means op-list surgery `redact.ts` already performs
(`removeImagesUnder` handles inline draws), reached through an addressing scheme
`ImageInfo` does not have. A caller who needs it today uses `Redact` over the
image's rect. A follow-up issue is filed rather than the gap being papered over.

## Errors

- Unrecognized or undecodable replacement bytes → `UnsupportedFeatureError`,
  from `buildImageXObject`, before any mutation.
- A `page` index on a format with no pages → `UnsupportedFeatureError`, likewise.
- A handle whose stream is no longer in the page's resource tree → `RangeError`,
  matching `editcontent.ts`'s existing `XObject /X not found`.
- A handle with no page — only reachable internally, from the JBIG2-globals
  recursion inside `Decode` — → `UnsupportedFeatureError` naming the cause.

## Testing

New `test/image-edit.test.ts`, over fixtures built programmatically in
`test/helpers/`. Each case below names the mutation it must redden; a green run
on first write is not evidence and each will be confirmed by breaking the path.

| Case | Pins | Reddened by |
|---|---|---|
| Replace updates `/Width`, `/Height`, `/ColorSpace`; the `cm` operands are unchanged | placement preservation | rewriting the `cm` from the new dimensions |
| Two pages share one image; replace from page 1 | copy-on-write | mutating the stream in place |
| Alpha PNG replaced by an opaque JPEG | `/SMask` deleted, not stale | copying the old dict instead of building fresh |
| `/OC` survives a replace | layer membership carried | building fresh with no carry-over |
| Garbage bytes throw; `Save()` bytes unchanged | validate-before-mutate | moving the build after the resource walk |
| Remove drops `q`, `cm` and `Q` too | `imageCutSet` wiring | cutting the `Do` index alone |
| One stream drawn twice on a page | identity match, all draws | stopping at the first hit |
| Remove nested in a form; second page intact | form COW | editing the shared form in place |
| `{ sanitize: true }` prunes an orphaned `/ExtGState`; default leaves it | the flag itself | ignoring `opts.sanitize` |
| Stale handle | `RangeError` | returning silently |

**Note, and the reason the `sanitize` row states the assertion twice:** both
settings produce a saved file with no image object in it, because `Save()` sweeps
orphans regardless. Only the surviving `/Resources /ExtGState` entry distinguishes
them, so the default-leaves-it half is as load-bearing as the flag-prunes-it half.

The two extractions are pure moves and change no behaviour, so the existing
`redact` suite is their fence — and it will be confirmed red under a deliberate
break to `imageCutSet` rather than assumed to cover the move.

`README.md` gains the two methods under the image section; `CHANGELOG.md` gets an
**Added** entry under `## [Unreleased]`.

## Non-goals

- **Inline image removal.** Filed separately; see **The inline gap**.
- **Document-wide removal.** `doc.Pages.forEach(p => …)` is the caller's loop,
  and a handle from one page silently editing others is the reading this design
  rejected.
- **Aspect-ratio-preserving replace.** Needs a rule for which rectangle wins;
  a caller who wants it removes and re-adds with the rect they want.
- **`Replace(path)`.** File reading is the caller's, as it is for `AddImage`.
