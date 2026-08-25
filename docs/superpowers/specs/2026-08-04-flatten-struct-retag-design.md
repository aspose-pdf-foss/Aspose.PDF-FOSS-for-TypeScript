# Flatten and the structure tree: re-point the OBJR at the baked content

Closes `4dqa`. Finishes what `hob8` started: that issue closed the same hole for
`Page.RemoveAnnotation` and `Form.RemoveField` by adding `untagObjects`
(`structwrite.ts:261`), and `flatten.ts` was left out.

`FlattenAnnotations`/`FlattenForm` bake an annotation's `/AP /N` into the page
content and drop it from `/Annots` without touching `/StructTreeRoot`. The
`/OBJR` naming it stays, and `/StructTreeRoot` is reachable from `/Root`, so the
mark-sweep in `Save()` keeps the annotation in the output.

Measured: a tagged text field, `FlattenForm()`, `Save()`, reopen — one dict with
`/Subtype /Widget` survives, in no page's `/Annots` and with `/AcroForm` already
deleted.

## Why not just call untagObjects

Because flatten is not removal. `Page.RemoveAnnotation` destroys the annotation
and its ink together, so dropping the tag loses nothing that still exists.
Flatten destroys the annotation and *keeps* the ink — it is now real page
content. Dropping the tag there throws away the `/Alt` and the reading-order
position of content that is still on the page, and prunes the struct element
outright when the `/OBJR` was its only kid. Flattened output would be
measurably less accessible than its input, which is the wrong direction for the
PDF/UA track.

So the tag follows the ink: the `/OBJR` becomes a marked-content kid naming the
bytes flatten just wrote, in the same `/K` slot.

This is cheap here in a way it is not elsewhere. `markContentRegion` needs
`regionOpSpan` plus `EditableContent` because it is guessing which existing ops
to wrap. Flatten does not guess — it *writes* the content, so it can emit the
`BDC`/`EMC` around its own bytes. Flatten stays append-only; no content
rewriting, no F1.

## The helper

New export in `structwrite.ts`, the third member of the
`tagAnnotation`/`untagObjects` family:

```ts
export function retagAsContent(
  doc: Document, page: Page, annot: PdfDict,
): { tag: string; mcid: number } | undefined
```

It performs the whole structure-tree edit and returns the tag name and MCID for
the caller to wrap its content in. `undefined` means there is nothing to
re-point and the caller should just write its content unwrapped.

1. `/StructParent` on the annotation gives the `/ParentTree` `/Nums` key. Absent
   → `undefined`: an untagged annotation.
2. Key → element **ref**. The ref, not just the dict — step 5 pushes it into the
   page's MCID array. A `/Kids`-based number tree, or a key that is not there →
   `undefined`.
3. Find the `/OBJR` kid in that element's `/K` whose `/Obj` resolves to `annot`,
   remembering its **index**. Not found → `undefined`.
4. Retype `/S`: `Form`→`Figure`, `Link`→`Span`. Everything else is left alone.
5. Allocate the MCID against the page (`pageMcidArray`, then `arr.push(elemRef)`),
   which also creates the page's `/StructParents` key when absent.
6. Write the content kid **at the OBJR's index**, following the same `/Pg` rule
   as `appendContentKid`: an integer MCID while the element's content stays on
   one page, an MCR dict once a second page contributes.
7. Clear the annotation's own `/ParentTree` key.

**Invariant:** the content kid replaces the `/OBJR` **in place**. This is why the
helper cannot be `allocContentMcid`, which appends — appending moves the baked
appearance to the end of the element's reading order, silently reordering a
`/Link` whose text run preceded its annotation.

**Invariant:** an unrewritable tag must not throw. `parentTreeNums` throws
`UnsupportedFeatureError` on a `/Kids`-based `/ParentTree`, and flatten must not
fail on a tree shape we merely decline to author into. Steps 2 and 3 return
`undefined` instead, and the `untagObjects` sweep below drops the tag. Same
principle as `clearParentTreeKeys`, which leaves a `/Kids` tree alone rather
than failing removal.

### Retyping

`/Form` identifies a widget annotation and a `/Link` shall contain a link
annotation (ISO 32000-1 Table 337). After flattening neither is true: what is
left is a static picture of a form field, and a `/Link` tag with no annotation
inside is the kind of thing a strict third-party UA checker flags.

`/Figure` and `/Form` are both in the alt-required set that `ValidatePdfUa`
enforces (`structvalidate.ts:65`, Matterhorn 13-004), so a document that
validated before still validates: the `/Alt` it already needed carries over
unchanged. `/Span` has no such requirement, so demoting a `/Link` cannot break
one either. Our own validator has no annotation-tagging rules at all, so it is
neutral on the `/OBJR` itself in both directions.

Matched on the raw `/S` name, not `StandardType`. A custom type role-mapped to
`/Form` is left alone rather than guessed at — retyping is already a judgment
made on the caller's behalf, and making it through a `/RoleMap` indirection
would extend that judgment to a name the author chose deliberately.

## The caller

`flattenPageAnnots` (`flatten.ts:41`) already builds the content body itself, so
the wrap is three lines in the existing loop:

```ts
const t = retagAsContent(doc, page, annot);
if (t) body += `/${t.tag} <</MCID ${t.mcid}>> BDC\n`;
body += `q ${ap.place.map(num).join(' ')} cm /${key} Do Q\n`;
if (t) body += 'EMC\n';
```

An untagged document therefore emits byte-identical content to today.

Then one `untagObjects(doc, dead)` before returning, where `dead` is **every**
annotation that left `/Annots` — the baked ones and the orphaned `/Popup`s the
second pass filters out at `flatten.ts:79`. The popups are removed rather than
baked, so there is no content for them to point at; they take the removal path
by construction.

`dead` is unconditional rather than "the ones `retagAsContent` declined". For a
successfully retagged annotation the `/OBJR` is already gone, so the sweep finds
nothing, prunes nothing, and costs one idempotent key-clear. Making it
unconditional means a malformed document naming one annotation from two `/OBJR`s
still cannot leak — the helper rewrites the first and the sweep drops the rest.

MCID numbering is safe across the whole operation: `pageMcidArray` returns the
page's live array and each annotation takes `arr.length`, which already accounts
for existing tagged content and for the annotations flattened before it on the
same page. A page's content streams concatenate into one logical stream, so the
MCIDs in the appended stream share the page's numbering.

## Testing

New `test/flatten-struct.test.ts`, mirroring `test/struct-remove.test.ts` — the
same `subtypeCount`/`kids`/`objrs`/`parentTreeKeys` helpers and the same
`taggedField` builder over `buildBlankPage`.

1. **The bug.** Tagged text field, `FlattenForm()`, `Save()`, reopen →
   `subtypeCount(saved, 'Widget')` is 0. Written first, confirmed red.
2. The struct element survives, retyped `/Form` → `/Figure`, `/Alt` preserved.
3. `/K` holds an MCID integer where the `/OBJR` was, `/ParentTree` maps that MCID
   back to the element, and the page content carries
   `/Figure <</MCID 0>> BDC … EMC` around the `Do`.
4. **Reading order.** An element with kids `[OBJR, MCID_text]` becomes
   `[MCID_baked, MCID_text]`, in that order.

   The `/OBJR` must come **first**, with another kid after it. With the `/OBJR`
   last, appending the content kid and then letting the `untagObjects` sweep
   drop the `/OBJR` lands on the same array as writing in place, so the
   assertion holds under both and proves nothing.
5. **Fallback.** A `/Kids`-based `/ParentTree`: flatten does not throw, the
   `/OBJR` is dropped, and the widget is gone from the saved bytes.
6. **Untagged.** No `BDC` in the emitted content and no `/StructParents` added.
7. `FlattenAnnotations` with a tagged markup annotation and its `/Popup`: both
   leave, and the popup's tag goes with it.

The existing `flatten-annotations`, `flatten-form` and `flatten-api` suites must
stay green.

Per CLAUDE.md, each assertion is proved load-bearing by breaking the path it
covers and confirming the suite goes red — passing on the first run is not
evidence.

## Documentation

`CLAUDE.md`'s struct.ts entry carries the `hob8` invariant ("removing an
annotation must also untag it"). Extend it: flattening an annotation must
*retag* it, because the ink survives. `README.md` needs no change — no public
API moves.
