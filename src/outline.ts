import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isString, name, ref,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { collectNameTree, lookupNameTree } from './nametree.js';

/** A node in the document outline (bookmark) tree. */
export interface OutlineItem {
  Title: string;
  /** Target; undefined for a heading with no (or an unresolvable) destination. */
  Dest?: OutlineDest;
  /** Expanded state; set on read for items with children, default true on write. */
  Open?: boolean;
  /** Child items; omitted/empty for a leaf. */
  Children?: OutlineItem[];
  /** Bookmark-panel colour as RGB 0..1 (`/C`). Omitted when unset. */
  Color?: [number, number, number];
  /** Bold title (`/F` bit 2). Read as true only when the bit is set. */
  Bold?: boolean;
  /** Italic title (`/F` bit 1). Read as true only when the bit is set. */
  Italic?: boolean;
}

/** A page destination: 1-based page number plus an optional view. */
export interface PageDest {
  page: number;
  view?: OutlineView;
}

/** A destination given by name, resolved by the viewer through the document's
 *  named-destination tables rather than at write time. */
export interface NamedDest {
  name: string;
}

/** An outline or link target: an explicit page, or a named destination.
 *
 *  The two are not interchangeable in practice. A page destination is resolved
 *  when it is written, so inserting a page ahead of it silently retargets it; a
 *  named one resolves at view time and follows its page object instead. */
export type OutlineDest = PageDest | NamedDest;

/** Discriminate the two destination forms. */
export function isNamedDest(d: OutlineDest): d is NamedDest {
  return typeof (d as NamedDest).name === 'string';
}

/** A PDF 32000-1 §12.3.2.2 destination view. `null` = "retain current value". */
export type OutlineView =
  | { type: 'XYZ'; left?: number | null; top?: number | null; zoom?: number | null }
  | { type: 'Fit' }
  | { type: 'FitH'; top?: number | null }
  | { type: 'FitV'; left?: number | null }
  | { type: 'FitR'; left: number; bottom: number; right: number; top: number }
  | { type: 'FitB' }
  | { type: 'FitBH'; top?: number | null }
  | { type: 'FitBV'; left?: number | null };

/** Map a dest array element to a coordinate number, treating null/absent as null. */
function coord(o: PdfObject | undefined): number | null {
  return typeof o === 'number' ? o : null;
}

/** Decode the tail of a destination array (the fit name + operands) to a view. */
export function decodeView(parts: PdfObject[]): OutlineView {
  const fit = isName(parts[0]) ? parts[0].name : 'Fit';
  switch (fit) {
    case 'XYZ': return { type: 'XYZ', left: coord(parts[1]), top: coord(parts[2]), zoom: coord(parts[3]) };
    case 'FitH': return { type: 'FitH', top: coord(parts[1]) };
    case 'FitV': return { type: 'FitV', left: coord(parts[1]) };
    case 'FitR': return {
      type: 'FitR', left: coord(parts[1]) ?? 0, bottom: coord(parts[2]) ?? 0,
      right: coord(parts[3]) ?? 0, top: coord(parts[4]) ?? 0,
    };
    case 'FitB': return { type: 'FitB' };
    case 'FitBH': return { type: 'FitBH', top: coord(parts[1]) };
    case 'FitBV': return { type: 'FitBV', left: coord(parts[1]) };
    default: return { type: 'Fit' };
  }
}

/** Resolve a 1-based page number from a destination's first element. */
export type PageOf = (o: PdfObject) => number | undefined;


/** Resolve a named destination (`key`) via the legacy catalog /Dests dict, then
 *  the /Names /Dests name tree. Returns the raw dest array, or undefined. */
export function resolveNamedDest(doc: Document, key: string): PdfObject | undefined {
  const catalog = doc.catalog();
  const legacy = doc.resolve(catalog.get('Dests'));
  if (isDict(legacy) && legacy.has(key)) return doc.resolve(legacy.get(key));
  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names)) {
    const found = lookupNameTree(doc, names.get('Dests') ?? null, key);
    if (found !== undefined) return doc.resolve(found);
  }
  return undefined;
}

/** Decode a raw destination value (a dest array or a `<< /D [...] >>` dict) to an
 *  OutlineDest; undefined when the target page is unresolvable. */
export function decodeDest(doc: Document, value: PdfObject | undefined, pageOf: PageOf): PageDest | undefined {
  let dest = doc.resolve(value);
  if (isDict(dest)) dest = doc.resolve(dest.get('D')); // named dest given as << /D [...] >>
  if (!isArray(dest)) return undefined;
  const page = pageOf(dest[0]);
  if (page === undefined) return undefined;
  return { page, view: decodeView(dest.slice(1).map((p) => doc.resolve(p))) };
}

/** Resolve an outline item's destination: explicit /Dest, then an /A GoTo
 *  action. A target given by name is reported as `{ name }` and deliberately
 *  NOT resolved to a page — resolution is the viewer's job at view time, and
 *  collapsing it here would lose the very indirection that makes a named
 *  destination survive page insertion. Use `Document.GetNamedDestinations` to
 *  resolve one. Returns undefined when unresolvable or for non-GoTo actions. */
export function parseDest(doc: Document, item: PdfDict, pageOf: PageOf): OutlineDest | undefined {
  let dest = doc.resolve(item.get('Dest'));
  if (dest === null) {
    const a = doc.resolve(item.get('A'));
    if (isDict(a)) {
      const s = doc.resolve(a.get('S'));
      if (isName(s) && s.name === 'GoTo') dest = doc.resolve(a.get('D'));
    }
  }
  if (isString(dest)) return { name: decodePdfText(dest.bytes) };
  if (isName(dest)) return { name: dest.name };
  return decodeDest(doc, dest, pageOf);
}

/** A named destination: a name plus its resolved target. Always a page target —
 *  the name tables are what resolution ends at. */
export interface NamedDestination {
  name: string;
  dest: PageDest;
}

/** Resolve a destination to a page one, following a name through the document's
 *  tables. Undefined when the name is dangling. For consumers that can only
 *  express a page — a `/GoTo` action's modelled form — rather than for outline
 *  or link reads, which report the name as written. */
export function resolvePageDest(
  doc: Document, d: OutlineDest | undefined, pageOf: PageOf,
): PageDest | undefined {
  if (d === undefined) return undefined;
  if (!isNamedDest(d)) return d;
  return decodeDest(doc, resolveNamedDest(doc, d.name), pageOf);
}

/** Read all named destinations, merging the /Root /Names /Dests name tree with
 *  the legacy /Root /Dests dict (legacy wins on a name clash, mirroring
 *  resolveNamedDest); returned sorted by name. */
export function readNamedDestinations(doc: Document, pageOf: PageOf): NamedDestination[] {
  const catalog = doc.catalog();
  const map = new Map<string, PageDest>();
  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names)) {
    const entries: Array<[string, PdfObject]> = [];
    collectNameTree(doc, names.get('Dests') ?? null, entries);
    for (const [k, v] of entries) {
      const d = decodeDest(doc, v, pageOf);
      if (d) map.set(k, d);
    }
  }
  const legacy = doc.resolve(catalog.get('Dests'));
  if (isDict(legacy))
    for (const k of legacy.keys()) {
      const d = decodeDest(doc, legacy.get(k), pageOf);
      if (d) map.set(k, d);
    }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, dest]) => ({ name, dest }));
}

/** Walk a sibling list from `container`'s /First, following /Next, into items. */
export function readOutlineTree(doc: Document, container: PdfDict, pageOf: PageOf): OutlineItem[] {
  const out: OutlineItem[] = [];
  const seen = new Set<PdfDict>();
  let node = doc.resolve(container.get('First'));
  while (isDict(node) && !seen.has(node)) {
    seen.add(node);
    const title = doc.resolve(node.get('Title'));
    const item: OutlineItem = { Title: isString(title) ? decodePdfText(title.bytes) : '' };
    const dest = parseDest(doc, node, pageOf);
    if (dest) item.Dest = dest;
    const c = doc.resolve(node.get('C'));
    if (isArray(c) && c.length === 3) {
      const rgb = c.map((v) => doc.resolve(v));
      if (rgb.every((v) => typeof v === 'number'))
        item.Color = [rgb[0] as number, rgb[1] as number, rgb[2] as number];
    }
    const f = doc.resolve(node.get('F'));
    if (typeof f === 'number') {
      if (f & 1) item.Italic = true;   // bit position 1 (PDF 32000-1 12.3.3)
      if (f & 2) item.Bold = true;     // bit position 2
    }
    const children = readOutlineTree(doc, node, pageOf);
    if (children.length) {
      item.Children = children;
      const count = doc.resolve(node.get('Count'));
      item.Open = !(typeof count === 'number' && count < 0);
    }
    out.push(item);
    node = doc.resolve(node.get('Next'));
  }
  return out;
}

/** Build context supplied by Document: object allocation + page-ref lookup. */
export interface OutlineBuildCtx {
  /** Install `obj` under a fresh object number and return that number. */
  alloc(obj: PdfObject): number;
  /** The page object ref for a validated 1-based page number. */
  pageRef(page: number): PdfRef;
}

/** Encode a destination as a PDF dest array `[pageRef /Fit ...]`. */
export function encodeDest(pageRef: PdfRef, view: OutlineView = { type: 'Fit' }): PdfObject[] {
  const n = (x: number | null | undefined): PdfObject => (typeof x === 'number' ? x : null);
  switch (view.type) {
    case 'XYZ': return [pageRef, name('XYZ'), n(view.left), n(view.top), n(view.zoom)];
    case 'FitH': return [pageRef, name('FitH'), n(view.top)];
    case 'FitV': return [pageRef, name('FitV'), n(view.left)];
    case 'FitR': return [pageRef, name('FitR'), view.left, view.bottom, view.right, view.top];
    case 'FitB': return [pageRef, name('FitB')];
    case 'FitBH': return [pageRef, name('FitBH'), n(view.top)];
    case 'FitBV': return [pageRef, name('FitBV'), n(view.left)];
    default: return [pageRef, name('Fit')];
  }
}

/** Count visible descendants of a node (children plus open children's visible
 *  descendants). Used for the signed /Count entry. */
function visibleCount(children: OutlineItem[]): number {
  let c = children.length;
  for (const kid of children)
    if (kid.Children?.length && kid.Open !== false) c += visibleCount(kid.Children);
  return c;
}

/** Validate the whole tree; throws before any mutation. `pageCount` is the
 *  document's page count; `checkPage` mirrors Document.pageRefForNumber so a
 *  non-indirect target page fails here too. */
export function validateOutlineItems(
  items: OutlineItem[], pageCount: number, checkPage: (page: number) => void,
): void {
  for (const item of items) {
    if (typeof item.Title !== 'string') throw new TypeError('outline item Title must be a string');
    if (item.Dest !== undefined) {
      // Discriminated on key presence, not on `isNamedDest`: this validates
      // caller input, so `{ name: 7 }` must report a bad name rather than fall
      // through and report a missing page.
      const d = item.Dest as { name?: unknown; page?: unknown };
      if ('name' in d) {
        // Not checked against the document's existing names: resolution happens
        // at view time, so a forward reference to a destination the caller adds
        // afterwards is legitimate.
        if (typeof d.name !== 'string' || d.name === '')
          throw new TypeError('outline destination name must be a non-empty string');
      } else {
        const p = (item.Dest as PageDest).page;
        if (!Number.isInteger(p) || p < 1 || p > pageCount)
          throw new RangeError(`outline destination page ${p} out of range 1..${pageCount}`);
        checkPage(p);
      }
    }
    if (item.Color !== undefined && (!Array.isArray(item.Color) || item.Color.length !== 3 ||
        !item.Color.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1)))
      throw new TypeError('outline item Color must be [r, g, b] with each component in 0..1');
    if (item.Bold !== undefined && typeof item.Bold !== 'boolean')
      throw new TypeError('outline item Bold must be a boolean');
    if (item.Italic !== undefined && typeof item.Italic !== 'boolean')
      throw new TypeError('outline item Italic must be a boolean');
    if (item.Children) validateOutlineItems(item.Children, pageCount, checkPage);
  }
}

/** Build the /Outlines object graph from a validated tree; returns the root
 *  object number. Wires /Parent /Prev /Next /First /Last /Count /Title /Dest. */
export function buildOutlineObjects(items: OutlineItem[], ctx: OutlineBuildCtx): number {
  const rootDict: PdfDict = new Map<string, PdfObject>([['Type', name('Outlines')]]);
  const rootNum = ctx.alloc(rootDict);

  const buildList = (siblings: OutlineItem[], parent: PdfRef): { first: number; last: number } => {
    const dicts = siblings.map(() => new Map<string, PdfObject>());
    const nums = dicts.map((d) => ctx.alloc(d));
    siblings.forEach((item, i) => {
      const d = dicts[i];
      d.set('Title', { kind: 'string', bytes: encodePdfText(item.Title) });
      if (item.Dest) {
        // A string, not a name object: that is what the /Names /Dests tree keys
        // on, so a bookmark and Document.SetNamedDestination agree.
        d.set('Dest', isNamedDest(item.Dest)
          ? { kind: 'string', bytes: encodePdfText(item.Dest.name) }
          : encodeDest(ctx.pageRef(item.Dest.page), item.Dest.view));
      }
      if (item.Color) d.set('C', [...item.Color]);
      const flags = (item.Italic ? 1 : 0) | (item.Bold ? 2 : 0);
      if (flags !== 0) d.set('F', flags);
      d.set('Parent', parent);
      if (i > 0) d.set('Prev', ref(nums[i - 1]));
      if (i < nums.length - 1) d.set('Next', ref(nums[i + 1]));
      if (item.Children?.length) {
        const { first, last } = buildList(item.Children, ref(nums[i]));
        d.set('First', ref(first));
        d.set('Last', ref(last));
        const cnt = visibleCount(item.Children);
        d.set('Count', item.Open === false ? -cnt : cnt);
      }
    });
    return { first: nums[0], last: nums[nums.length - 1] };
  };

  const { first, last } = buildList(items, ref(rootNum));
  rootDict.set('First', ref(first));
  rootDict.set('Last', ref(last));
  rootDict.set('Count', visibleCount(items));
  return rootNum;
}
