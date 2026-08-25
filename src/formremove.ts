import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';
import { untagObjects } from './structwrite.js';

/** One step of the path from /AcroForm /Fields down to a field: the live array
 *  the node sits in, and where in it. */
interface Step {
  container: PdfObject[];
  index: number;
  node: PdfDict;
}

/** The chain of steps from `container` down to `target`, or undefined when the
 *  field is not in this tree.
 *
 *  Matched by dict identity, not by name: a stale handle, or one belonging to
 *  another document, is simply not found rather than removing the field that
 *  happens to share its name. */
function locate(doc: Document, container: PdfObject[], target: PdfDict): Step[] | undefined {
  for (let i = 0; i < container.length; i++) {
    const d = doc.resolve(container[i]);
    if (!isDict(d)) continue;
    if (d === target) return [{ container, index: i, node: d }];
    const kids = doc.resolve(d.get('Kids'));
    if (!isArray(kids)) continue;
    const below = locate(doc, kids as PdfObject[], target);
    if (below) return [{ container, index: i, node: d }, ...below];
  }
  return undefined;
}

/** The field's widget annotations: a merged field/widget dict is its own widget,
 *  otherwise the resolved /Kids entries. The rule Field.widgets() uses. */
function widgetsOf(doc: Document, field: PdfDict): PdfDict[] {
  const kids = doc.resolve(field.get('Kids'));
  if (!isArray(kids)) return [field];
  const out: PdfDict[] = [];
  for (const k of kids) {
    const d = doc.resolve(k);
    if (isDict(d)) out.push(d);
  }
  return out;
}

/** Drop every dict in `dead` from every page's /Annots.
 *
 *  Spliced in place so an indirect /Annots array keeps its identity, as
 *  Page.RemoveAnnotation does. Every page is scanned rather than the one named
 *  by the widget's /P: /P is optional, and a radio group's widgets sit on
 *  different pages anyway. */
function detachWidgets(doc: Document, dead: Set<PdfDict>): void {
  for (const page of doc.Pages) {
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) continue;
    for (let i = annots.length - 1; i >= 0; i--) {
      const d = doc.resolve(annots[i]);
      if (isDict(d) && dead.has(d)) annots.splice(i, 1);
    }
  }
}

/** Drop refs to any removed node from /AcroForm /CO, the calculation order.
 *
 *  /CO hangs off /AcroForm and so is reachable from /Root: a leftover entry
 *  keeps the dead field and its widgets alive through Save()'s mark-sweep, and
 *  the saved file then carries a field that is in no /Fields and has no /Annots
 *  entry. Nothing we write emits /CO — documents from other producers do. */
function scrubCO(doc: Document, acro: PdfDict, dead: Set<PdfDict>): void {
  const co = doc.resolve(acro.get('CO'));
  if (!isArray(co)) return;
  for (let i = co.length - 1; i >= 0; i--) {
    const d = doc.resolve(co[i]);
    if (isDict(d) && dead.has(d)) co.splice(i, 1);
  }
}

/** Remove a terminal field: unwire it from the field tree, drop its widgets from
 *  every page, and prune the intermediate nodes it leaves empty. True when the
 *  field was found.
 *
 *  An emptied intermediate node is not merely tidy to remove: the form walk
 *  reads a node with no /T-bearing kids as a terminal field, so leaving one
 *  behind gives the document a phantom field under the branch's own name.
 *
 *  Nothing is deleted from the object map. Save() renumbers what is reachable
 *  from /Root, so an unwired field is collected there — which is also why every
 *  remaining reference to it has to go. */
export function removeField(doc: Document, field: PdfDict): boolean {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return false;
  const fields = doc.resolve(acro.get('Fields'));
  if (!isArray(fields)) return false;
  const chain = locate(doc, fields as PdfObject[], field);
  if (!chain) return false;

  const dead = new Set<PdfDict>([field]);
  for (const w of widgetsOf(doc, field)) dead.add(w);
  detachWidgets(doc, dead);

  // Deepest first: each ancestor is judged only after its child is gone, and
  // pruning stops at the first that still has kids. Every container appears
  // once in the chain, so the recorded indices stay valid as we go.
  for (let i = chain.length - 1; i >= 0; i--) {
    const step = chain[i];
    if (i < chain.length - 1) {
      const kids = doc.resolve(step.node.get('Kids'));
      if (isArray(kids) && kids.length > 0) break;
      dead.add(step.node);
    }
    step.container.splice(step.index, 1);
  }

  scrubCO(doc, acro, dead);
  untagObjects(doc, dead);
  doc.markModified();
  return true;
}

/** Detach a field `removeField` could not locate: everything it does EXCEPT the
 *  field-tree surgery, because an unwired field has no /Fields entry to splice.
 *
 *  A separate entry rather than a branch inside `removeField`, whose "false
 *  means not found, and nothing happened" contract `Annotation.Flatten` relies
 *  on — it calls `removeField` with an arbitrary annotation dict expecting a
 *  no-op for anything outside the field tree.
 *
 *  Widgets still go from every page, not just the covered one. Measured: a
 *  sibling widget elsewhere keeps the shared field reachable from /Root, and
 *  the field's /Kids then keeps the "removed" widget reachable in turn — so
 *  detaching one of a group accomplishes nothing at all. /CO is scrubbed for
 *  the same reason it is in `removeField`: it hangs off /AcroForm and would
 *  keep the dead field, and its /V, in the saved bytes.
 *
 *  Pass a widget that names no field as its own field: `widgetsOf` returns the
 *  dict itself, so one path serves every unwired shape. */
export function detachUnwiredField(doc: Document, field: PdfDict): void {
  const dead = new Set<PdfDict>([field]);
  for (const w of widgetsOf(doc, field)) dead.add(w);
  detachWidgets(doc, dead);
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (isDict(acro)) scrubCO(doc, acro, dead);
  untagObjects(doc, dead);
  doc.markModified();
}
