// Flatten track (Phase 4). L1: bake each annotation's /AP /N appearance stream
// into the page content as a Form XObject draw at its /Rect, then drop the
// annotation from /Annots. Append-only — no content rewriting (no F1 needed).
//
// The /AP resolution and visibility rules live in annotappearance.ts, shared
// with the render pass. Flatten adds the ref promotion on top (rendering must
// stay read-only).
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isRef } from './types.js';
import {
  appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, num,
} from './pagecontent.js';
import { isAnnotVisible, resolveAppearance } from './annotappearance.js';
import { retagAsContent, untagObjects } from './structwrite.js';
import { removeField } from './formremove.js';
import { enc } from './serialize.js';

/**
 * True when `entry` is a /Popup whose parent markup is in `baked`. The parent's
 * note is now static page content, so the window that would have opened it has
 * nothing left to show. Dropping it also keeps /Parent from resurrecting the
 * baked markup dict: Save marks from /Root, so a kept popup would drag its
 * flattened parent back into the file as an annotation on no page.
 */
function isOrphanedPopup(doc: Document, entry: PdfObject, baked: Set<PdfDict>): boolean {
  const annot = doc.resolve(entry);
  if (!isDict(annot)) return false;
  const s = doc.resolve(annot.get('Subtype'));
  if (!isName(s) || s.name !== 'Popup') return false;
  const parent = doc.resolve(annot.get('Parent'));
  return isDict(parent) && baked.has(parent);
}

/**
 * Bake each /Annots entry that `accept`s into the page content as a Form XObject
 * draw at its /Rect, then drop it from /Annots. Annotations a viewer would not
 * draw (Hidden, NoView, /Popup — see isAnnotVisible) and those lacking a usable
 * appearance are never baked. Of those, a /Popup is still dropped when its own
 * parent was baked; everything else is left in place. Returns the number of
 * annotations baked. Shared core of L1 (all annotations) and L2 (widgets).
 */
function flattenPageAnnots(doc: Document, page: Page, accept: (a: PdfDict) => boolean): number {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return 0;

  const keep: PdfObject[] = [];
  const baked = new Set<PdfDict>();
  let body = '';
  let count = 0;
  let xobjs: PdfDict | undefined;

  for (const entry of annots) {
    const annot = doc.resolve(entry);
    if (!isDict(annot) || !isAnnotVisible(doc, annot) || !accept(annot)) {
      keep.push(entry);
      continue;
    }
    const ap = resolveAppearance(doc, annot);
    if (ap === undefined) { keep.push(entry); continue; }

    // Rendering must not mutate, so resolveAppearance leaves /N un-promoted;
    // baking needs an indirect object to share from /Resources /XObject.
    const apRef = isRef(ap.entry) ? ap.entry : doc.allocObject(ap.stream);

    if (xobjs === undefined) {
      xobjs = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'XObject');
    }
    const key = freshKey(xobjs, 'Fm');
    xobjs.set(key, apRef);
    // Flatten writes this content itself, so it can bracket its own bytes —
    // no regionOpSpan, no EditableContent, and flatten stays append-only.
    const tagged = retagAsContent(doc, page, annot);
    if (tagged) body += `/${tagged.tag} <</MCID ${tagged.mcid}>> BDC\n`;
    body += `q ${ap.place.map(num).join(' ')} cm /${key} Do Q\n`;
    if (tagged) body += 'EMC\n';
    count++;
    baked.add(annot);
    // annotation intentionally dropped from /Annots (not pushed to keep)
  }

  if (count === 0) return 0;
  appendContent(doc, page, enc(body));

  // Second pass: /Annots order is arbitrary, so a popup can only be judged once
  // the whole baked set is known.
  const kept: PdfObject[] = [];
  const dead = new Set(baked);
  for (const e of keep) {
    if (!isOrphanedPopup(doc, e, baked)) { kept.push(e); continue; }
    const d = doc.resolve(e);
    if (isDict(d)) dead.add(d);
  }
  page.Dict.set('Annots', kept);

  // Every annotation that just left /Annots must also leave the structure tree.
  // /StructTreeRoot hangs off /Root, so an OBJR still naming one keeps it in the
  // saved bytes with no /Annots entry anywhere — the same trap hob8 closed for
  // Page.RemoveAnnotation and Form.RemoveField.
  untagObjects(doc, dead);
  return count;
}

/**
 * Flatten every visible, appearance-bearing annotation on `page`: draw its
 * /AP /N appearance into the page content at its /Rect and remove it from
 * /Annots. Hidden / NoView annotations, /Popup note windows, and those lacking a
 * usable appearance are never drawn; they stay in /Annots, except for a popup
 * whose parent markup was baked, which is dropped with it. Returns the number of
 * annotations flattened.
 */
export function flattenAnnotations(doc: Document, page: Page): number {
  return flattenPageAnnots(doc, page, () => true);
}

/**
 * Bake exactly the annotations in `targets`, wherever they live, and drop them
 * from their pages' /Annots. Returns how many were baked — a target with no
 * usable appearance, or one a viewer would not draw, is left alone and does not
 * count. Every page is scanned rather than trusting a widget's /P: /P is
 * optional, and a radio group's widgets sit on different pages anyway.
 */
function flattenTargets(doc: Document, targets: ReadonlySet<PdfDict>): number {
  if (targets.size === 0) return 0;
  let count = 0;
  for (const page of doc.Pages) count += flattenPageAnnots(doc, page, (a) => targets.has(a));
  return count;
}

/**
 * Flatten a single annotation: bake its /AP /N into its page's content and drop
 * it from /Annots. True when it was baked, false when it was not found, is not
 * one a viewer would draw, or has no usable appearance.
 *
 * A form widget needs {@link flattenFieldWidgets} as well — baking a widget on
 * its own leaves the field wired into /AcroForm /Fields with no widget anywhere.
 * `Annotation.Flatten` handles that; this function is the ink half only.
 */
export function flattenAnnotation(doc: Document, annot: PdfDict): boolean {
  return flattenTargets(doc, new Set([annot])) > 0;
}

/**
 * Flatten one field: bake `widgets` into their pages' content, then unwire
 * `field` from /AcroForm /Fields (pruning the intermediate nodes it empties and
 * scrubbing /CO). Returns the number of widgets baked.
 *
 * **Invariant:** bake before unwiring, never the reverse. `retagAsContent` finds
 * the element to rewrite through the OBJR that names the annotation, and
 * `removeField`'s `untagObjects` deletes exactly that OBJR. Unwire first and the
 * retag silently no-ops, so the baked ink lands in the page as untagged content
 * — a fresh `UntaggedContent` failure in a document that validated before. In
 * this order `untagObjects` is a harmless no-op instead: `retagAsContent` has
 * already replaced the OBJR with a marked-content kid and deleted the widget's
 * /StructParent, so there is nothing left for it to find.
 */
export function flattenFieldWidgets(doc: Document, field: PdfDict, widgets: PdfDict[]): number {
  const count = flattenTargets(doc, new Set(widgets));
  removeField(doc, field);
  return count;
}

/** True when the annotation is an interactive form widget (/Subtype /Widget). */
function isWidget(doc: Document, annot: PdfDict): boolean {
  const s = doc.resolve(annot.get('Subtype'));
  return isName(s) && s.name === 'Widget';
}

/**
 * Flatten the interactive form: generate every field's appearance, bake each
 * widget annotation into its page's content via the L1 mechanism, then drop the
 * widget annotations and the document /AcroForm. After this the form is static
 * content — fields are no longer editable. Returns the number of widgets baked.
 */
export function flattenForm(doc: Document): number {
  doc.Form.GenerateAppearances(); // ensure every widget has an /AP to bake
  let count = 0;
  for (const page of doc.Pages) {
    count += flattenPageAnnots(doc, page, (a) => isWidget(doc, a));
  }
  doc.catalog().delete('AcroForm');
  return count;
}
