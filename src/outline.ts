import type { Document } from './document.js';
import { isDeepStrictEqual } from 'node:util';
import type { PdfAction } from './actions.js';
import {
  PdfDict, PdfObject, PdfRef, isArray, isDict, isName, isRef, isString, name, ref,
} from './types.js';
import { decodePdfByteString, decodePdfText, encodePdfByteString, encodePdfText } from './metadata.js';
import { collectNameTree, lookupNameTree } from './nametree.js';

/** A node in the document outline (bookmark) tree. */
export interface OutlineItem {
  Title: string;
  /** Target; undefined for a heading with no (or an unresolvable) destination. */
  Dest?: OutlineDest;
  /** Typed bookmark /A. An unmodelled action survives a same-document edit. */
  Action?: PdfAction;
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

// An enumerable symbol survives {...item} without adding a field to the public
// string-keyed model. Store the wire object separately from the editable views:
// /Next, named /D, field refs and producer keys cannot be rebuilt from PdfAction.
const sourceAction = Symbol('original bookmark action');
type ReadItem = OutlineItem & {
  [sourceAction]?: {
    owner: WeakRef<Document>;
    catalog: WeakRef<PdfDict>;
    raw: PdfObject;
    action: PdfAction | undefined;
    dest: OutlineDest | undefined;
  };
};

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


/** Resolve a named destination through the catalog dictionary and name tree.
 *  A PDF string uses its exact name-tree key first. Decoded names use the
 *  legacy catalog dictionary first. */
export function resolveNamedDest(doc: Document, key: string | Uint8Array): PdfObject | undefined {
  const catalog = doc.catalog();
  const legacy = doc.resolve(catalog.get('Dests'));
  if (typeof key === 'string' && isDict(legacy) && legacy.has(key)) return doc.resolve(legacy.get(key));
  const names = doc.resolve(catalog.get('Names'));
  if (isDict(names)) {
    const found = lookupNameTree(doc, names.get('Dests') ?? null, key);
    if (found !== undefined) return doc.resolve(found);
  }
  if (typeof key === 'string' || !isDict(legacy)) return undefined;
  const fallback = legacy.get(decodePdfByteString(key));
  return fallback === undefined ? undefined : doc.resolve(fallback);
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

/** The explicit /Dest, or the /D of a local GoTo action. */
function destinationObject(doc: Document, item: PdfDict): PdfObject {
  let dest = doc.resolve(item.get('Dest'));
  if (dest === null) {
    const a = doc.resolve(item.get('A'));
    if (isDict(a)) {
      const s = doc.resolve(a.get('S'));
      if (isName(s) && s.name === 'GoTo') dest = doc.resolve(a.get('D'));
    }
  }
  return dest;
}

/** Read an outline or link target. A named target is exposed as `{ name }`
 *  to preserve the indirection that makes it survive page insertion. */
export function parseDest(doc: Document, item: PdfDict, pageOf: PageOf): OutlineDest | undefined {
  const dest = destinationObject(doc, item);
  if (isString(dest)) return { name: decodePdfByteString(dest.bytes) };
  if (isName(dest)) return { name: dest.name };
  return decodeDest(doc, dest, pageOf);
}

/** A named destination: a name plus its resolved target. Always a page target —
 *  the name tables are what resolution ends at. */
export interface NamedDestination {
  name: string;
  dest: PageDest;
}

/** Resolve a GoTo action's destination to a page, keeping raw string keys. */
export function resolvePageDest(
  doc: Document, item: PdfDict, pageOf: PageOf,
): PageDest | undefined {
  let dest = destinationObject(doc, item);
  if (isString(dest)) dest = resolveNamedDest(doc, dest.bytes) ?? null;
  else if (isName(dest)) dest = resolveNamedDest(doc, dest.name) ?? null;
  return decodeDest(doc, dest, pageOf);
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
export function readOutlineTree(
  doc: Document, container: PdfDict, readAction: (raw: PdfObject) => PdfAction | undefined,
  readDest: typeof parseDest = parseDest, depth = 1,
): OutlineItem[] {
  const out: OutlineItem[] = [];
  const seen = new Set<PdfDict>();
  let node = doc.resolve(container.get('First'));
  // Only a level that HAS items counts, so an outline N items deep is admitted
  // at a limit of N; the leaf's empty child list costs nothing to ask for.
  if (isDict(node)) doc.loadLimits.enforce('maxNestingDepth', depth, 'outline');
  while (isDict(node) && !seen.has(node)) {
    seen.add(node);
    const title = doc.resolve(node.get('Title'));
    const item: ReadItem = { Title: isString(title) ? decodePdfText(title.bytes) : '' };
    const dest = readDest(doc, node, o => doc.pageNumberOf(o));
    if (dest) item.Dest = dest;
    const raw = node.get('A');
    if (raw !== undefined && isDict(doc.resolve(raw)) && doc.resolve(node.get('Dest')) === null) {
      item.Action = readAction(raw);
      item[sourceAction] = {
        owner: new WeakRef(doc), catalog: new WeakRef(doc.catalog()), raw,
        action: structuredClone(item.Action), dest: structuredClone(dest),
      };
    }
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
    const children = readOutlineTree(doc, node, readAction, readDest, depth + 1);
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

type OutlineTarget = ['A' | 'Dest', PdfObject];

/** Build context supplied by Document after target validation. */
export interface OutlineBuildCtx {
  /** Install `obj` under a fresh object number and return that number. */
  alloc(obj: PdfObject): number;
  targets: ReadonlyMap<OutlineItem, OutlineTarget>;
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

function prepareDest(doc: Document, dest: OutlineDest, pageRef: (page: number) => PdfRef): PdfObject {
  if ('name' in dest) {
    if (typeof dest.name !== 'string' || dest.name === '')
      throw new TypeError('outline destination name must be a non-empty string');
    return { kind: 'string', bytes: encodePdfByteString(dest.name) };
  }
  const p = dest.page;
  if (!Number.isInteger(p) || p < 1 || p > doc.Pages.length)
    throw new RangeError(`outline destination page ${p} out of range 1..${doc.Pages.length}`);
  return encodeDest(pageRef(p), dest.view);
}

type ActionEncoder = (action: PdfAction) => PdfDict;

function prepareTarget(doc: Document, item: ReadItem, pageRef: (page: number) => PdfRef,
  writeAction: ActionEncoder): OutlineTarget | undefined {
  const source = item[sourceAction];
  let action = item.Action, dest = item.Dest;
  if (source) {
    const actionEdited = !Object.hasOwn(item, 'Action') || !isDeepStrictEqual(action, source.action);
    const destEdited = !isDeepStrictEqual(dest, source.dest);
    if (!actionEdited && !destEdited) {
      // First-write encrypted signing replaces the catalog and renumbers the
      // object graph inside the same Document instance.
      if (source.owner.deref() === doc && source.catalog.deref() === doc.catalog()) return ['A', source.raw];
      // A foreign object number could refer to an entirely different object.
      // Named GoTos retain their name even when it has no entry in this document.
      if (dest && isNamedDest(dest))
        return ['A', new Map<string, PdfObject>([['S', name('GoTo')], ['D', prepareDest(doc, dest, pageRef)]])];
      if (!action) throw new TypeError('unknown bookmark action belongs to a different document object graph');
      dest = undefined;
    } else {
      // A local GoTo exposes both projections for compatibility. Editing only
      // one replaces the wire target, including when the caller removes it.
      if (!destEdited) dest = undefined;
      if (!actionEdited) action = undefined;
    }
  }
  if (action !== undefined && dest !== undefined)
    throw new TypeError('outline item cannot specify both Action and Dest');
  if (action !== undefined) return ['A', writeAction(action)];
  if (dest !== undefined) return ['Dest', prepareDest(doc, dest, pageRef)];
  return undefined;
}

/** Validate and encode the whole tree before the previous outline is removed. */
export function prepareOutlineTargets(doc: Document, items: OutlineItem[], pageRef: (page: number) => PdfRef,
  writeAction: ActionEncoder): Map<OutlineItem, OutlineTarget> {
  const targets = new Map<OutlineItem, OutlineTarget>();
  function visit(item: OutlineItem): void {
    if (typeof item.Title !== 'string') throw new TypeError('outline item Title must be a string');
    const target = prepareTarget(doc, item, pageRef, writeAction);
    if (target) targets.set(item, target);
    if (item.Color !== undefined && (!Array.isArray(item.Color) || item.Color.length !== 3 ||
        !item.Color.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1)))
      throw new TypeError('outline item Color must be [r, g, b] with each component in 0..1');
    if (item.Bold !== undefined && typeof item.Bold !== 'boolean')
      throw new TypeError('outline item Bold must be a boolean');
    if (item.Italic !== undefined && typeof item.Italic !== 'boolean')
      throw new TypeError('outline item Italic must be a boolean');
    if (item.Children) for (const child of item.Children) visit(child);
  }
  for (const item of items) visit(item);
  return targets;
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
      const target = ctx.targets.get(item);
      if (target) d.set(...target);
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
