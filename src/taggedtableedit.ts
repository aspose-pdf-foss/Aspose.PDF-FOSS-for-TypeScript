import type { Document } from './document.js';
import type { Page } from './page.js';
import type { TableBuilder } from './tableauthor.js';
import type { Rect, Table } from './tablemodel.js';
import { TableTagger } from './tabletag.js';
import { drawFittedTable } from './tablerender.js';
import { StructElement } from './struct.js';
import { subtreeOf } from './structremove.js';
import { numsArrays } from './numbertree.js';
import { flatNameNode, nameTreeEntries } from './nametree.js';
import { isArray, isDict, isRef, type PdfRef } from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { removeTaggedTableInk } from './taggedtableink.js';

const refuse = (why: string) => new UnsupportedFeatureError('Cannot edit tagged table: ' + why);
const stale = () => new RangeError('Detected table is stale. Call GetTables() again.');
interface Target { page: WeakRef<Page>; ref: PdfRef; revision: number; box: Rect; cells: Rect[] }
const targets = new WeakMap<Table, Target>();

export function bindTaggedTable(table: Table, page: Page, element: StructElement): void {
  if (!element.Ref) return;
  targets.set(table, { page: new WeakRef(page), ref: element.Ref, revision: page.Document.tableEditRevision,
    box: [...table.quad], cells: table.rows.flatMap(r => r.cells.map(c => [...c.quad] as Rect)) });
}

/** Null only the selected slots. Other pages and object keys keep their raw
 * values. Flattening the number tree also lets the tag writer append MCIDs. */
function releaseSlots(el: StructElement, doc: Document, pageKey: number, ids: Set<number>): void {
  const tree = doc.resolve(el.Root.Dict.get('ParentTree'));
  if (!isDict(tree)) throw refuse('missing parent tree');
  const nums = numsArrays(doc, tree).flat();
  let found = false;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (doc.resolve(nums[i]) !== pageKey) continue;
    const slots = doc.resolve(nums[i + 1]);
    if (found || !isArray(slots)) throw refuse('ambiguous page parent-tree entry');
    const copy = slots.slice();
    for (const id of ids) copy[id] = null;
    nums[i + 1] = copy;
    found = true;
  }
  if (!found) throw refuse('missing page parent-tree entry');
  el.Root.Dict.set('ParentTree', doc.allocObject(new Map([['Nums', nums]])));
}

/** Returns false for a geometry-only or unbound handle. */
export function editTaggedTable(table: Table, builder?: TableBuilder): boolean {
  const target = targets.get(table);
  if (!target) return false;
  const page = target.page.deref(), doc = page?.Document;
  if (!page || !doc || doc.tableEditRevision !== target.revision || !doc.pageNumberOf(page.Dict)) throw stale();
  const root = doc.GetStructTree(), dict = doc.resolve(target.ref);
  if (!root?.Ref || !isDict(dict)) throw stale();
  const element = new StructElement(doc, dict, target.ref, root);
  const parentRef = dict.get('P'), pageKey = doc.resolve(page.Dict.get('StructParents'));
  if (!isRef(parentRef) || typeof pageKey !== 'number') throw refuse('missing parent or page structure key');
  if (doc.Pages.some(p => p.Dict !== page.Dict && doc.resolve(p.Dict.get('StructParents')) === pageKey))
    throw refuse('shared page structure key');
  const elements = subtreeOf(element), detached = new Set<number>(), names = new Set<string>(), ids = new Set<number>();
  for (const e of elements) {
    if (!e.Ref || (e !== element && e.StandardType === 'Table')) throw refuse('direct or nested table structure');
    if (!builder || e !== element) {
      detached.add(e.Ref.num);
      if (e.ID !== undefined) names.add(e.ID);
    }
    const raw = doc.resolve(e.Dict.get('K'));
    for (const kid of isArray(raw) ? raw : [raw]) {
      const item = doc.resolve(kid);
      if (isDict(item) && item.has('Stm')) throw refuse('marked content in a separate stream');
    }
    for (const item of e.ContentItems) {
      if (item.kind !== 'mcid' || item.page?.Dict !== page.Dict)
        throw refuse('object references or content on another page');
      if (ids.has(item.mcid) || root.ElementFor(pageKey, item.mcid)?.Dict !== e.Dict)
        throw refuse('ambiguous MCID ownership');
      ids.add(item.mcid);
    }
  }
  doc.editTablePage(page, draft => {
    const d = draft.Document, r = d.GetStructTree()!, elemDict = d.resolve(target.ref);
    const parent = d.resolve(parentRef);
    if (!isDict(elemDict) || !isDict(parent)) throw stale();
    const el = new StructElement(d, elemDict, target.ref, r);
    const raw = parent.get('K'), resolved = d.resolve(raw);
    const kids = isArray(resolved) ? resolved : raw === undefined ? [] : [raw];
    if (kids.filter(k => d.resolve(k) === elemDict).length !== 1) throw stale();
    if (builder) {
      elemDict.set('K', []);
      elemDict.delete('ActualText');
    } else parent.set('K', kids.filter(k => d.resolve(k) !== elemDict));
    releaseSlots(el, d, pageKey, ids);
    const tree = r.Dict.get('IDTree');
    if (tree) {
      const entries = [...nameTreeEntries(d, tree)];
      const kept = entries.filter(([, v]) => !isRef(v) || !detached.has(v.num));
      if (kept.length !== entries.length) r.Dict.set('IDTree', d.allocObject(flatNameNode(kept)));
    }
    for (const child of r.Children) {
      for (const e of subtreeOf(child)) {
        if (names.size && e.TableAttributes?.headers?.some(id => names.has(id)))
          throw refuse('external reference to a cell ID');
        if (e.ContentItems.some(item => item.kind === 'mcid' && item.page?.Dict === draft.Dict && ids.has(item.mcid)))
          throw refuse('another structure element uses a table MCID');
      }
    }
    const box = removeTaggedTableInk(draft, ids, target.box, target.cells, !!builder);
    if (builder) drawFittedTable(draft, builder, box, doc, 0, new TableTagger(d, { structParent: el }));
  }, { dictionaries: [root.Ref, parentRef, target.ref], detached });
  return true;
}
