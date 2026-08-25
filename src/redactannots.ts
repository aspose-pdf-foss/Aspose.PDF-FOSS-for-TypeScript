// The annotation half of redaction. Content surgery in redact.ts works only on
// content streams through EditableContent; /Annots is a separate object graph it
// never visits, so an annotation over a redacted region keeps its text — and,
// when it has an /AP, keeps drawing it on top of the marker box, because
// annotations composite after page content.
//
// Imports nothing from redact.ts: redact.ts imports this module, and the reverse
// would be a cycle. The four lines of AABB math below are therefore local.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isArray, isDict, isName } from './types.js';
import { removeField, detachUnwiredField } from './formremove.js';
import type { Rect } from './text.js';

/** A rect as [minX, minY, maxX, maxY], however the corners were ordered. */
function normRect(r: Rect): Rect {
  return [
    Math.min(r[0], r[2]), Math.min(r[1], r[3]),
    Math.max(r[0], r[2]), Math.max(r[1], r[3]),
  ];
}

/** Inclusive AABB overlap: touching edges count as intersecting. */
function intersects(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** /Subtype name without the leading slash; '' when absent. */
function subtypeOf(doc: Document, d: PdfDict): string {
  const s = doc.resolve(d.get('Subtype'));
  return isName(s) ? s.name : '';
}

/** /Rect as four finite numbers, or undefined when missing or malformed. */
function rectOf(doc: Document, d: PdfDict): Rect | undefined {
  const a = doc.resolve(d.get('Rect'));
  if (!isArray(a) || a.length < 4) return undefined;
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return [out[0], out[1], out[2], out[3]];
}

/** The terminal field a widget belongs to: the widget itself when it is a merged
 *  field/widget dict (it carries /FT), otherwise the nearest /Parent that does.
 *  The hop cap stops a cyclic /Parent from hanging the sweep. */
function fieldOf(doc: Document, widget: PdfDict): PdfDict | undefined {
  let node: PdfDict | undefined = widget;
  for (let hops = 0; node !== undefined && hops < 32; hops++) {
    if (node.has('FT')) return node;
    const p = doc.resolve(node.get('Parent'));
    node = isDict(p) ? p : undefined;
  }
  return undefined;
}

/**
 * Remove every annotation on `page` whose /Rect intersects one of `rects`, and
 * return how many went. Intersection rather than containment: a /FreeText
 * hanging half out of the region carries its whole text and draws all of it.
 *
 * A /Redact annotation is never removed — it is redaction machinery, not page
 * content, and applyRedactions owns removing its own marks after the overlay
 * painter has read them.
 *
 * Nothing here throws: an annotation with no readable /Rect is skipped, because
 * redaction must not fail on a shape we merely decline to judge.
 */
export function removeCoveredAnnotations(
  doc: Document, page: Page, rects: Rect[],
): number {
  if (rects.length === 0) return 0;
  const regions = rects.map(normRect);

  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return 0;
  // Snapshot before mutating: removal splices the very array we are walking.
  const entries: PdfObject[] = [...annots];

  const doomed: PdfDict[] = [];
  const dead = new Set<PdfDict>();
  for (const e of entries) {
    const d = doc.resolve(e);
    if (!isDict(d)) continue;
    if (subtypeOf(doc, d) === 'Redact') continue;
    const r = rectOf(doc, d);
    if (r === undefined) continue;
    const box = normRect(r);
    if (!regions.some((g) => intersects(box, g))) continue;
    doomed.push(d);
    dead.add(d);
  }

  // A markup's popup follows its parent wherever the popup itself sits, the same
  // orphan rule flatten.ts applies when it bakes a markup away.
  for (const e of entries) {
    const d = doc.resolve(e);
    if (!isDict(d) || dead.has(d)) continue;
    if (subtypeOf(doc, d) !== 'Popup') continue;
    const parent = doc.resolve(d.get('Parent'));
    if (isDict(parent) && dead.has(parent)) { doomed.push(d); dead.add(d); }
  }

  let removed = 0;
  for (const d of doomed) {
    if (subtypeOf(doc, d) === 'Widget') {
      // A widget's value lives on the field, so detaching the widget alone would
      // leave the field and its /V in /AcroForm /Fields — a leak and a stranded
      // object both. removeField unwires the field, detaches every widget it
      // owns (on any page), and untags. A radio group therefore goes whole,
      // which is the honest consequence of a shared /V.
      //
      // removeField returns false for exactly one case: the field is not
      // reachable from /AcroForm /Fields (including a document with no
      // /AcroForm). That is not a reason to keep the annotation — it is still
      // covering the region, and this branch used to `continue` past it, so the
      // widget survived redaction and went on drawing its /AP over the marker
      // box. detachUnwiredField does the rest of removeField's work without the
      // field-tree surgery there is no entry for.
      //
      // A widget naming no field is its own field here, so the two failure modes
      // share one path.
      const field = fieldOf(doc, d) ?? d;
      if (!removeField(doc, field)) detachUnwiredField(doc, field);
      removed++;
      continue;
    }
    // RemoveAnnotation, not a raw splice: it is what calls untagObjects, so a
    // tagged annotation does not survive via its /OBJR.
    page.RemoveAnnotation(d);
    removed++;
  }
  return removed;
}
