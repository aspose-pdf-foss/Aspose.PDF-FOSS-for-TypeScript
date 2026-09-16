import type { Document } from './document.js';
import type { StructElement, StructTreeRoot } from './struct.js';
import { PdfDict, PdfObject, isArray, isDict } from './types.js';
import { kArray } from './structwrite.js';
import { detachKid, subtreeOf } from './structremove.js';

/** Anything that can hold structure elements: an element, or the tree root.
 *
 *  **Note the name:** deliberately NOT `StructParent`. `/StructParent` is an
 *  unrelated key on an annotation dict, already modelled here, and the
 *  collision would be read as a relationship that does not exist. */
export type StructContainer = StructElement | StructTreeRoot;

/** The tree root a container belongs to. Only `StructElement` carries `Root`,
 *  which is what narrows the union — `structmove.ts` imports both as TYPES
 *  only, so `instanceof` is unavailable. */
function rootOf(c: StructContainer): StructTreeRoot {
  return 'Root' in c ? c.Root : c;
}

/** Raw /K indices of the element kids of `dict`, in order. */
function elementSlots(doc: Document, dict: PdfDict): number[] {
  const raw = doc.resolve(dict.get('K'));
  const arr = isArray(raw) ? raw : (raw === undefined ? [] : [raw]);
  const out: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const kid = doc.resolve(arr[i]);
    if (isDict(kid) && kid.has('S')) out.push(i);
  }
  return out;
}

/** Write /Pg onto every element in `els` that has a BARE-INTEGER content item
 *  and no /Pg of its own, resolved from where it sits NOW.
 *
 *  **Invariant, and it is the whole safety property of a move:**
 *  `StructElement.Page` walks UP the ancestor chain, and `ContentItems`
 *  resolves a bare-integer MCID against that inherited page — so moving such an
 *  element to a parent on a different page silently re-points every one of its
 *  MCIDs, while the /ParentTree goes on mapping them to the element. The two
 *  directions then disagree, which is worse than either being wrong alone.
 *
 *  **Invariant:** it runs UNCONDITIONALLY, never only when the pages differ.
 *  Deciding whether they differ means resolving the destination's inherited
 *  /Pg — the same walk — so the conditional buys nothing and adds a branch that
 *  is SILENT when wrong.
 *
 *  Only BARE INTEGERS inherit: an MCR dict carries its own /Pg, and an OBJR is
 *  addressed through /StructParent rather than a page key. For anything this
 *  library authored this is a no-op, since `appendContentKid` already
 *  materialized /Pg. */
function materializePg(doc: Document, els: readonly StructElement[]): void {
  for (const el of els) {
    if (el.Dict.has('Pg')) continue;
    const raw = doc.resolve(el.Dict.get('K'));
    const arr: PdfObject[] = isArray(raw) ? raw : (raw === undefined ? [] : [raw]);
    if (!arr.some((k) => typeof doc.resolve(k) === 'number')) continue;
    const page = el.Page;
    if (page === undefined) continue;   // nothing to inherit from either
    el.Dict.set('Pg', doc.pageRef(page.Number));
  }
}

/** Move `element` under `parent`, at `index` among its ELEMENT children
 *  (default: last).
 *
 *  **Invariant:** everything is validated before anything is written, so a
 *  rejected call leaves the document byte-identical — `formcreate.ts`'s rule.
 *
 *  **Invariant:** the /ParentTree is not touched, not one entry. A move changes
 *  /K and /P and nothing else, which is what keeps every MCID resolving. */
export function moveElement(
  doc: Document, element: StructElement, parent: StructContainer, index?: number,
): void {
  if (index !== undefined && !Number.isInteger(index))
    throw new TypeError('index must be an integer');
  if (element.Ref === undefined)
    throw new RangeError('cannot move an element with no indirect ref');
  if (parent.Ref === undefined)
    throw new RangeError('cannot move into a container with no indirect ref');
  if (rootOf(parent).Dict !== element.Root.Dict)
    throw new RangeError('cannot move an element into a different structure tree');

  // The cycle refusal. A tree with a loop is unwalkable, so GetText, Nodes,
  // docmodel.ts and the validator would all hang rather than report anything.
  const els = subtreeOf(element);
  if (els.some((e) => e.Dict === parent.Dict))
    throw new RangeError('cannot move an element into itself or its own subtree');

  const slots = elementSlots(doc, parent.Dict);
  // The element's own slot does not count when it is already under `parent`:
  // it is about to be removed, so the valid range is over the OTHERS.
  const own = slots.length - (parent.Dict === doc.resolve(element.Dict.get('P')) ? 1 : 0);
  const at = index ?? own;
  if (at < 0 || at > own) throw new RangeError(`index ${at} is out of range 0..${own}`);

  // --- nothing above this line has written anything ---

  materializePg(doc, els);

  const from = doc.resolve(element.Dict.get('P'));
  if (isDict(from)) detachKid(doc, from, element.Dict);

  const k = kArray(doc, parent.Dict);
  const after = elementSlots(doc, parent.Dict);
  const rawAt = at < after.length ? after[at] : k.length;
  k.splice(rawAt, 0, element.Ref);
  element.Dict.set('P', parent.Ref);
  doc.markModified();
}

/** Reorder `element`'s ELEMENT children into `order`.
 *
 *  **Invariant:** the element kids permute among the raw /K positions they
 *  ALREADY occupy; every MCID and OBJR kid stays exactly where it is. That is
 *  what makes the operation meaningful for the inline shape — a /P holding its
 *  own text beside a /Link child keeps its text where it was. Permuting the
 *  whole /K instead would let a caller reorder a parent's own text against its
 *  children, which is a different feature, and would break `Nodes`'
 *  interleaving: that reads content order from the page and would then
 *  disagree with /K.
 *
 *  **Invariant:** `order` must be exactly this element's element children, each
 *  once — validated before anything is written. */
export function reorderChildren(
  doc: Document, element: StructElement, order: readonly StructElement[],
): void {
  const slots = elementSlots(doc, element.Dict);
  const raw = doc.resolve(element.Dict.get('K'));
  const arr: PdfObject[] = isArray(raw) ? raw : (raw === undefined ? [] : [raw]);

  if (order.length !== slots.length)
    throw new RangeError(`order has ${order.length} elements, expected ${slots.length}`);

  const current = slots.map((i) => doc.resolve(arr[i]) as PdfDict);
  const seen = new Set<PdfDict>();
  for (const el of order) {
    if (!current.includes(el.Dict))
      throw new RangeError('order names an element that is not a child of this one');
    if (seen.has(el.Dict)) throw new RangeError('order names the same element twice');
    seen.add(el.Dict);
  }

  // --- nothing above this line has written anything ---

  // Keep the raw entries, not the dicts: a kid may be a ref, and replacing it
  // with its resolved dict would inline an object the tree points at.
  const entries = slots.map((i) => arr[i]);
  const byDict = new Map<PdfDict, PdfObject>();
  slots.forEach((i, n) => byDict.set(current[n], entries[n]));
  order.forEach((el, n) => { arr[slots[n]] = byDict.get(el.Dict)!; });

  // /K may have been a single value rather than an array; write the array back
  // when the original was not one.
  if (!isArray(raw)) element.Dict.set('K', arr);
  doc.markModified();
}
