// Editing an embedded image in place: where in a page's resource tree an image
// XObject sits, and the replace/remove operations built on that. Object-graph
// and content-stream work only -- no decoding, no rasterizing.
//
// **Invariant:** this module imports neither redact.ts nor image.ts. redact.ts
// imports image.ts for its decoder, so either edge would close a cycle back to
// ImageInfo, whose methods delegate here. It takes doc, page and the target
// stream as plain arguments, which is also what lets the scope walk be driven
// from hand-built resource dicts.

import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfStream, isDict, isName, isStream } from './types.js';
import { EditableContent } from './editcontent.js';
import { buildImageXObject } from './imageembed.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';
import { UnsupportedFeatureError } from './errors.js';
import { imageCutSet, type ContentOp } from './content.js';
import { sanitizeResources } from './resprune.js';

/** Where one image XObject sits in a page's resource tree. */
export interface ImageScope {
  /** Chain of Form XObject resource names from the page down; [] at page level. */
  readonly path: string[];
  /** The /XObject key the stream is registered under in that scope. */
  readonly key: string;
}

/** Every place `target` is registered in `page`'s resource tree, descending into
 *  Form XObjects exactly as `collectImages` does.
 *
 *  **Invariant:** the match is on stream IDENTITY, never on a resource name.
 *  Two forms may each hold an `Im0`, so a name alone does not say which; and one
 *  stream registered under two keys would be only half-handled by a name match.
 *  Identity is sound because `Document.resolve` is a map lookup -- the whole file
 *  is parsed into the object map on `Open`, so a given object number always
 *  yields the same instance. */
export function imageScopes(doc: Document, page: Page, target: PdfStream): ImageScope[] {
  const out: ImageScope[] = [];
  const seen = new Set<PdfDict>();
  const walk = (res: PdfObject, path: string[]): void => {
    const r = doc.resolve(res);
    if (!isDict(r)) return;
    const xobj = doc.resolve(r.get('XObject'));
    if (!isDict(xobj) || seen.has(xobj)) return;
    seen.add(xobj);
    for (const [key, val] of xobj) {
      const obj = doc.resolve(val);
      if (!isStream(obj)) continue;
      if (obj === target) { out.push({ path: [...path], key }); continue; }
      const sub = doc.resolve(obj.dict.get('Subtype'));
      if (isName(sub) && sub.name === 'Form')
        walk(obj.dict.get('Resources') ?? null, [...path, key]);
    }
  };
  walk(page.Resources ?? null, []);
  return out;
}

/** Options for {@link replaceImage} / `ImageInfo.Replace`. */
export interface ReplaceImageOptions {
  /** Override format auto-detection. Default: sniff magic bytes. */
  format?: 'jpeg' | 'png' | 'bmp' | 'tiff';
  /** Which image of a multi-image file to use, 0-based. TIFF only; a non-zero
   *  value THROWS for a format with no pages rather than being silently
   *  ignored. Default 0. */
  page?: number;
}

/** Swap the picture `target` holds for `data`, keeping its placement.
 *
 *  Copy-on-write and scoped to `page`: a fresh XObject is built and this page's
 *  resource keys repointed at it, so an image shared with another page leaves
 *  that page alone. If nothing else pointed at the old object, `Save()` sweeps
 *  it — the file is the same size either way.
 *
 *  The new image is STRETCHED into the existing footprint whatever its
 *  proportions: the `cm` that sizes an image lives in the content stream, and
 *  the caller asked to change the picture, not the layout.
 *
 *  **Invariant:** the build runs before any mutation, so a rejected call leaves
 *  the document byte-identical.
 *
 *  **Invariant:** only /OC carries over from the old dict. Every other entry
 *  describes the samples being discarded — a stale /SMask would show the new
 *  picture through a stencil cut for the old one — while optional-content
 *  membership describes the slot. */
export function replaceImage(
  doc: Document, page: Page, target: PdfStream,
  data: Uint8Array, opts: ReplaceImageOptions = {},
): void {
  if (data.length === 0)
    throw new UnsupportedFeatureError('ImageInfo.Replace: empty image data');
  const built = buildImageXObject(data, opts.format, opts.page ?? 0);

  const scopes = imageScopes(doc, page, target);
  if (scopes.length === 0)
    throw new RangeError('ImageInfo.Replace: image not found in the page resource tree');

  const oc = target.dict.get('OC');
  if (oc !== undefined) built.stream.dict.set('OC', oc);
  if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
  const ref = doc.allocObject(built.stream);

  const ec = new EditableContent(doc, page);
  for (const { path, key } of scopes) {
    const res = path.length === 0
      ? ensureOwnResources(doc, page)
      : ec.ownXObjectResources(path);
    ensureOwnSubdict(doc, res, 'XObject').set(key, ref);
  }
  ec.commit();
}

/** Options for {@link removeImage} / `ImageInfo.Remove`. */
export interface RemoveImageOptions {
  /** Also prune every now-unreferenced /Font, /XObject and /ExtGState name from
   *  the page and each edited form, as redaction does. Default false, which
   *  removes only this image's own entry. Either way `Save()` sweeps objects
   *  nothing points at, so this changes which /Resources entries survive, not
   *  which objects reach the file. */
  sanitize?: boolean;
}

/** Ops with each `Do` naming one of `keys` cut, together with its placement
 *  group, or undefined when this op list draws none of them. */
function cutDraws(ops: readonly ContentOp[], keys: Set<string>): ContentOp[] | undefined {
  const hits = new Set<number>();
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i].operands[0];
    if (ops[i].operator === 'Do' && isName(a) && keys.has(a.name)) hits.add(i);
  }
  if (hits.size === 0) return undefined;
  const cut = imageCutSet(ops, hits);
  return ops.filter((_, i) => !cut.has(i));
}

/** Drop `target` from `page`: every `Do` of it in the page's content streams and
 *  in the Form XObjects the page descends into, plus the /XObject entries it
 *  occupied. The XObject itself is left to `Save()`'s mark-sweep, which keeps it
 *  when another page still draws it.
 *
 *  **Invariant:** scoped to this page. A handle came from one page's `Images`,
 *  so it edits that page; a form shared with another page is copy-on-written
 *  rather than edited in place. */
export function removeImage(
  doc: Document, page: Page, target: PdfStream, opts: RemoveImageOptions = {},
): void {
  const scopes = imageScopes(doc, page, target);
  if (scopes.length === 0)
    throw new RangeError('ImageInfo.Remove: image not found in the page resource tree');

  // One bucket per scope: a stream may hold several keys in the same scope.
  const byPath = new Map<string, { path: string[]; keys: Set<string> }>();
  for (const { path, key } of scopes) {
    const id = path.join('\0');
    let e = byPath.get(id);
    if (!e) { e = { path, keys: new Set() }; byPath.set(id, e); }
    e.keys.add(key);
  }

  const ec = new EditableContent(doc, page);

  // 1. Cut the draws.
  for (const { path, keys } of byPath.values()) {
    if (path.length === 0) {
      for (let i = 0; i < ec.streamCount; i++) {
        const out = cutDraws(ec.topOps(i), keys);
        if (out) ec.setTopOps(i, out);
      }
    } else {
      const out = cutDraws(ec.xobjectOps(path), keys);
      if (out) ec.setXobjectOps(path, out);
    }
  }

  // 2. Delete the resource entries. What matters is that this reaches the dict
  //    THROUGH `ec`: the form copy-on-write replaces a scope's /Resources, so a
  //    dict captured during the `imageScopes` walk above is stale and deleting
  //    from it would mutate an object the page no longer points at.
  //
  //    Note the loop ORDER is not load-bearing, which was measured rather than
  //    assumed -- `cowXObject` memoizes by path, so whichever of the two loops
  //    runs first performs the COW and the other gets the same cached clone.
  //    Swapping them leaves every case in test/image-edit.test.ts green.
  for (const { path, keys } of byPath.values()) {
    const res = path.length === 0
      ? ensureOwnResources(doc, page)
      : ec.ownXObjectResources(path);
    const xobjs = ensureOwnSubdict(doc, res, 'XObject');
    for (const key of keys) xobjs.delete(key);
  }

  if (opts.sanitize) sanitizeResources(doc, page, ec);
  ec.commit();
}
