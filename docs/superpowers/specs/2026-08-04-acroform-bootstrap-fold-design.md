# Folding attachSigWidget onto the shared AcroForm bootstrap

Closes `jp31`, deferred from `dbpr.1`.

`document.ts`'s `attachSigWidget` carried its own copy of ensure-`/AcroForm` +
append-field + attach-widget, because it threads a `touched` set of object
numbers for the incremental-update delta and the shared helpers in
`formcreate.ts` did not model that. This designs the seam and folds it in.

## The seam

An optional `touched?: TouchedObjects` (a `Set<number>`) on `ensureAcroForm`,
the new `appendField`, and `attachWidget`. Only signing passes one: `Save()`
renumbers and rewrites the whole reachable model, so a full rewrite has nothing
to track.

An alternative was considered and rejected: diffing `doc.objects.keys()` around
the call, the way `installSignatureField` already does for a visible signature's
appearance objects. That only catches what was *allocated*. The bootstrap also
**mutates** existing objects — the catalog, the page dict, `/AcroForm`, and any
indirect array it appends to — and none of those appear in an allocation diff.

So each helper records both halves: what it allocated, and what it changed.

## The bug this exposed

`/Fields` and `/Annots` are the same problem and only one of them was handled.

Appending into an **indirect** array mutates that array's own object; the dict
holding the reference is unchanged. The old code knew this for `/Fields` —

> When /Fields is an indirect array we mutate it in place, so its own object
> must join the incremental delta (else the new widget would be dropped).

— and did not for `/Annots`: it recorded the *page* object number
unconditionally. When a page carries `/Annots 5 0 R`, signing wrote back a page
whose bytes had not changed and left object 5 out of the delta, so the signature
widget vanished from the signed output. Our own writer emits `/Annots` as a
direct array, which is why no fixture caught it; a foreign document being signed
routinely does not.

`attachWidget` now applies the `/Fields` rule to `/Annots`: an indirect array
joins the delta itself, and it is the page that joins only when `/Annots` is
direct or absent. `test/sign-incremental-dirty.test.ts` gains
`buildIndirectAnnotsPdf`, the `/Annots` counterpart of the existing
`buildIndirectFieldsPdf`.

## What stayed signing-specific

Two things, and they are the reason `attachSigWidget` still exists rather than
disappearing entirely:

- `/SigFlags` — OR'd with 3 (signatures exist, append-only) after the bootstrap.
  The generic bootstrap has no business writing it.
- The delta bookkeeping itself, which is now three optional arguments rather
  than a duplicated implementation.

`attachSigWidget` also now takes a **page index** rather than a page object
number, since the shared `attachWidget` works from a `Page`. Both call sites had
an index to hand and were converting it to an object number only for this.

## Not folded

`createField` appends to `path.container`, which `resolvePath` has already
resolved to either the root `/Fields` array or an intermediate node's `/Kids` —
not necessarily `/AcroForm /Fields`. It is also a full-rewrite path, so the
indirect-array delta rule does not apply to it. `appendField` is for the
signature path, which appends at the root.
