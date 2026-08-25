import type { Document } from './document.js';
import type { Page } from './page.js';
import type { StructElement } from './struct.js';
import type { Annotation } from './annotation.js';
import { PdfObject, PdfDict, PdfRef, isDict, isArray, isName, isRef, name } from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { encodePdfText } from './metadata.js';
import { EditableContent } from './editcontent.js';
import { visitContent, type Rect } from './text.js';
import type { ContentAddr } from './editcontent.js';
import type { ContentOp } from './content.js';
import { wrapMarkedContent, wrapArtifact } from './pagecontent.js';

const asNum = (o: PdfObject): number | undefined => (typeof o === 'number' ? o : undefined);

/** Largest key in a flat /ParentTree /Nums array ([key,val,key,val,...]); -1 when empty. */
function maxKey(nums: PdfObject[]): number {
  let m = -1;
  for (let i = 0; i < nums.length; i += 2) { const k = asNum(nums[i]); if (k !== undefined && k > m) m = k; }
  return m;
}

/** The live ParentTree dict, creating `<< /Nums [] >>` (+ /ParentTreeNextKey on the
 *  root) when absent. */
export function ensureParentTree(doc: Document, rootDict: PdfDict): PdfDict {
  let pt = doc.resolve(rootDict.get('ParentTree'));
  if (!isDict(pt)) {
    pt = new Map<string, PdfObject>([['Nums', []]]);
    rootDict.set('ParentTree', doc.allocObject(pt));
  }
  if (asNum(doc.resolve(rootDict.get('ParentTreeNextKey'))) === undefined) {
    const nums = doc.resolve((pt as PdfDict).get('Nums'));
    rootDict.set('ParentTreeNextKey', maxKey(isArray(nums) ? nums : []) + 1);
  }
  return pt as PdfDict;
}

/** Ensure the catalog has a /StructTreeRoot (+ /ParentTree, /MarkInfo Marked) and
 *  return its live dict and ref. Idempotent. */
export function ensureStructTree(doc: Document): { dict: PdfDict; ref: PdfRef } {
  const catalog = doc.catalog();
  const existingRef = catalog.get('StructTreeRoot');
  const existing = doc.resolve(existingRef);
  let dict: PdfDict;
  let rootRef: PdfRef;
  if (isDict(existing) && isRef(existingRef)) {
    dict = existing;
    rootRef = existingRef;
  } else {
    dict = new Map<string, PdfObject>([['Type', name('StructTreeRoot')], ['K', []]]);
    rootRef = doc.allocObject(dict);
    catalog.set('StructTreeRoot', rootRef);
  }
  ensureParentTree(doc, dict);
  const mi = doc.resolve(catalog.get('MarkInfo'));
  if (isDict(mi)) mi.set('Marked', true);
  else catalog.set('MarkInfo', new Map<string, PdfObject>([['Marked', true]]));
  doc.markModified();
  return { dict, ref: rootRef };
}

/** Options for creating a structure element. */
export interface ElemOpts {
  alt?: string;
  actualText?: string;
  lang?: string;
  title?: string;
  expansion?: string;
  id?: string;
}

/** ElemOpts field -> PDF dict key. */
const OPT_KEYS: ReadonlyArray<[keyof ElemOpts, string]> = [
  ['alt', 'Alt'], ['actualText', 'ActualText'], ['lang', 'Lang'],
  ['title', 'T'], ['expansion', 'E'], ['id', 'ID'],
];

/** Write the given ElemOpts onto a struct-element dict as PDF text strings. */
export function applyElemOpts(dict: PdfDict, opts?: ElemOpts): void {
  if (!opts) return;
  for (const [field, key] of OPT_KEYS) {
    const v = opts[field];
    if (v !== undefined) dict.set(key, { kind: 'string', bytes: encodePdfText(v) });
  }
}

/** Ensure `dict`'s /K is a live array (wrapping a single existing entry) and
 *  return it. Works whether /K was absent, a single item, or a (ref-to-)array. */
export function kArray(doc: Document, dict: PdfDict): PdfObject[] {
  const raw = dict.get('K');
  const resolved = doc.resolve(raw);
  if (isArray(resolved)) return resolved; // live; mutations persist (same object)
  const arr: PdfObject[] = raw === undefined ? [] : [raw];
  dict.set('K', arr);
  return arr;
}

/** Allocate a new /StructElem under `parentRef`, append its ref to `parentK`,
 *  apply `opts`, and return the live dict + ref. */
export function createElement(
  doc: Document, type: string, parentRef: PdfRef, parentK: PdfObject[], opts?: ElemOpts,
): { dict: PdfDict; ref: PdfRef } {
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('StructElem')],
    ['S', name(type)],
    ['P', parentRef],
    ['K', []],
  ]);
  applyElemOpts(dict, opts);
  const r = doc.allocObject(dict);
  parentK.push(r);
  doc.markModified();
  return { dict, ref: r };
}

/** The live ParentTree /Nums array. Throws for a /Kids-based number tree
 *  (authoring supports only a flat /Nums). */
function parentTreeNums(doc: Document, rootDict: PdfDict): PdfObject[] {
  const pt = ensureParentTree(doc, rootDict);
  const nums = doc.resolve(pt.get('Nums'));
  if (isArray(nums)) return nums;
  if (pt.has('Kids'))
    throw new UnsupportedFeatureError('authoring into a /Kids-based /ParentTree is not supported');
  const arr: PdfObject[] = [];
  pt.set('Nums', arr);
  return arr;
}

/** Read and post-increment the root's /ParentTreeNextKey. */
function takeNextKey(doc: Document, rootDict: PdfDict): number {
  ensureParentTree(doc, rootDict); // guarantees /ParentTreeNextKey exists
  const cur = asNum(doc.resolve(rootDict.get('ParentTreeNextKey')))!;
  rootDict.set('ParentTreeNextKey', cur + 1);
  return cur;
}

/** The page's MCID->element array in the ParentTree, creating it (and the page's
 *  /StructParents key) when absent. Returned live so callers can append. */
function pageMcidArray(doc: Document, rootDict: PdfDict, page: Page): PdfObject[] {
  const nums = parentTreeNums(doc, rootDict);
  const existing = asNum(doc.resolve(page.Dict.get('StructParents')));
  if (existing !== undefined) {
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (asNum(doc.resolve(nums[i])) === existing) {
        const arr = doc.resolve(nums[i + 1]);
        if (isArray(arr)) return arr;
      }
    }
  }
  const key = takeNextKey(doc, rootDict);
  page.Dict.set('StructParents', key);
  const arr: PdfObject[] = [];
  nums.push(key, arr);
  return arr;
}

/** Append a content reference to an element's /K following the /Pg rule: integer
 *  MCID + element /Pg while content stays on one page; an MCR dict once a second
 *  page contributes. */
export function appendContentKid(
  doc: Document, elemDict: PdfDict, mcid: number, pageRef: PdfRef,
): void {
  const k = kArray(doc, elemDict);
  const pg = elemDict.get('Pg');
  if (pg === undefined) {
    elemDict.set('Pg', pageRef);
    k.push(mcid);
  } else if (isRef(pg) && pg.num === pageRef.num) {
    k.push(mcid);
  } else {
    k.push(new Map<string, PdfObject>([['Type', name('MCR')], ['Pg', pageRef], ['MCID', mcid]]));
  }
}

/** Allocate the next MCID for `page` against `element`: wires the ParentTree and
 *  the element's /K, returns the MCID. */
/** How a producer's drawing should be marked in a tagged document. */
export interface MarkOptions {
  /** Tag the drawing into this existing element. Wins over `alt`. */
  tag?: StructElement;
  /** Create a /Figure carrying this /Alt and tag the drawing into it. */
  alt?: string;
  /** Mark the drawing as an /Artifact — decoration that carries no meaning. */
  artifact?: boolean;
}

/** Validate a marking choice. Throws before the caller allocates anything, so a
 *  rejected call leaves the document byte-identical. */
export function validateMarkOptions(opts: MarkOptions): void {
  if (opts.artifact !== undefined && typeof opts.artifact !== 'boolean')
    throw new TypeError('artifact must be a boolean');
  if (opts.alt !== undefined && typeof opts.alt !== 'string')
    throw new TypeError('alt must be a string');
  if (opts.artifact && (opts.tag !== undefined || opts.alt !== undefined))
    throw new TypeError('artifact cannot be combined with tag or alt');
}

/** Wrap `body` according to `opts`: the caller's element, else a fresh /Figure
 *  carrying `alt`, else an /Artifact, else unchanged.
 *
 *  `tag` wins over `alt`: the caller supplied a specific element, and quietly
 *  re-parenting their content under a fresh /Figure would be the more surprising
 *  reading. An `alt` on an untagged document is ignored rather than thrown —
 *  there is no tree to attach to, and failing the draw would be worse than
 *  ignoring the hint. `artifact` needs no tree, so it is honoured either way. */
export function markDrawing(
  doc: Document, page: Page, body: Uint8Array, opts: MarkOptions,
): Uint8Array {
  if (opts.tag !== undefined)
    return wrapMarkedContent(opts.tag.Type, allocContentMcid(doc, opts.tag, page), body);

  if (opts.alt !== undefined) {
    const root = doc.GetStructTree();
    if (root === null) return body; // untagged document: nothing to attach to
    const parent = root.Children[0];
    const elem = parent !== undefined
      ? parent.Append('Figure', { alt: opts.alt })
      : root.Append('Figure', { alt: opts.alt });
    return wrapMarkedContent(elem.Type, allocContentMcid(doc, elem, page), body);
  }

  if (opts.artifact) return wrapArtifact(body);
  return body;
}

export function allocContentMcid(doc: Document, element: StructElement, page: Page): number {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot tag content to an element with no ref');
  const arr = pageMcidArray(doc, element.Root.Dict, page);
  const mcid = arr.length;
  arr.push(elemRef);
  appendContentKid(doc, element.Dict, mcid, doc.pageRef(page.Number));
  doc.markModified();
  return mcid;
}

/** Reserve a marked-content id on `page` against `element` WITHOUT appending it
 *  to that element's /K — for a caller that will attach the kid itself, to an
 *  element it has not created yet.
 *
 *  A linked run is the case: its glyphs must end up under a /Link that only
 *  exists once the block is laid out, but the id has to be known while the
 *  content stream is being built. Reserve here, then {@link retargetMcid} and
 *  {@link appendContentKid} onto the /Link. `allocContentMcid` is the ordinary
 *  form and should be preferred wherever the owning element is already known.
 *  @internal */
export function reserveContentMcid(doc: Document, element: StructElement, page: Page): number {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot tag content to an element with no ref');
  const arr = pageMcidArray(doc, element.Root.Dict, page);
  const mcid = arr.length;
  arr.push(elemRef);
  doc.markModified();
  return mcid;
}

/** Point `page`'s parent-tree entry for `mcid` at `element`. Used when the
 *  reserving element and the owning element differ — a link's glyphs are
 *  reserved against the block being laid out and owned by its /Link. @internal */
export function retargetMcid(
  doc: Document, element: StructElement, page: Page, mcid: number,
): void {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot retarget to an element with no ref');
  pageMcidArray(doc, element.Root.Dict, page)[mcid] = elemRef;
  doc.markModified();
}

/** Tag an annotation object: allocate an object /StructParent key, set
 *  ParentTree[key] = element ref, and append an OBJR to the element's /K. The
 *  page is derived from the annotation's /P. */
export function tagAnnotation(doc: Document, element: StructElement, annot: Annotation): void {
  const elemRef = element.Ref;
  if (elemRef === undefined) throw new Error('cannot tag an annotation to an element with no ref');
  const pRef = annot.Dict.get('P');
  const page = isRef(pRef) ? doc.pageForRef(pRef) : undefined;
  if (!page) throw new UnsupportedFeatureError('annotation has no page (/P) to tag against');

  // Find (and promote to indirect if needed) the annotation's ref in /Annots.
  const annots = doc.resolve(page.Dict.get('Annots'));
  let annotRef: PdfRef | undefined;
  if (isArray(annots)) {
    for (let i = 0; i < annots.length; i++) {
      if (doc.resolve(annots[i]) === annot.Dict) {
        annotRef = isRef(annots[i]) ? (annots[i] as PdfRef) : doc.allocObject(annot.Dict);
        if (!isRef(annots[i])) annots[i] = annotRef;
        break;
      }
    }
  }
  if (annotRef === undefined) throw new UnsupportedFeatureError('annotation is not on its page /Annots');

  const nums = parentTreeNums(doc, element.Root.Dict);
  const key = takeNextKey(doc, element.Root.Dict);
  annot.Dict.set('StructParent', key);
  nums.push(key, elemRef);
  const k = kArray(doc, element.Dict);
  k.push(new Map<string, PdfObject>([
    ['Type', name('OBJR')], ['Pg', doc.pageRef(page.Number)], ['Obj', annotRef],
  ]));
  doc.markModified();
}

/** Structure types that describe an *annotation* rather than the ink it draws.
 *  Once flatten has baked that ink into the page, neither is true any more:
 *  ISO 32000-1 Table 337 has /Form identify a widget annotation and a /Link
 *  contain a link annotation. /Figure carries the same /Alt requirement /Form
 *  does (structvalidate.ts, Matterhorn 13-004), so a document that validated
 *  before still validates; /Span requires nothing, so demoting a /Link cannot
 *  break one either.
 *
 *  Matched on the raw /S, never StandardType: a custom type role-mapped to
 *  /Form is a name the author chose deliberately, and retyping is already a
 *  judgment made on the caller's behalf. */
const FLATTENED_TYPE: ReadonlyMap<string, string> = new Map([
  ['Form', 'Figure'],
  ['Link', 'Span'],
]);

/** The element ref the /ParentTree maps `key` to, or undefined.
 *
 *  Reads /Nums directly rather than going through `parentTreeNums`, which
 *  throws on a /Kids-based tree. That throw protects *authoring*; flatten must
 *  not fail on a tree shape we merely decline to author into, so an unreadable
 *  tree returns undefined and the caller drops the tag instead. Same principle
 *  as `clearParentTreeKeys`, which leaves a /Kids tree alone rather than
 *  failing removal. */
function parentTreeLookup(doc: Document, rootDict: PdfDict, key: number): PdfRef | undefined {
  const pt = doc.resolve(rootDict.get('ParentTree'));
  if (!isDict(pt)) return undefined;
  const nums = doc.resolve(pt.get('Nums'));
  if (!isArray(nums)) return undefined;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    if (asNum(doc.resolve(nums[i])) === key && isRef(nums[i + 1])) return nums[i + 1] as PdfRef;
  }
  return undefined;
}

/**
 * Re-point a flattened annotation's tag at the page content that replaced it:
 * swap the OBJR naming `annot` for a marked-content kid in the *same* /K slot,
 * retype the element, and clear the annotation's /ParentTree key. Returns the
 * BDC tag and MCID for the caller to wrap its content in, or undefined when
 * there is nothing to re-point (the caller then writes its content unwrapped
 * and lets `untagObjects` drop the tag).
 *
 * The near-mirror of `tagAnnotation`, and the reason flatten does not simply
 * call `untagObjects` like removal does: removal destroys the annotation *and*
 * its ink, so dropping the tag loses nothing that still exists. Flatten keeps
 * the ink. Dropping the tag there throws away the /Alt and the reading-order
 * position of content still on the page, and prunes the element outright when
 * the OBJR was its only kid.
 */
export function retagAsContent(
  doc: Document, page: Page, annot: PdfDict,
): { tag: string; mcid: number } | undefined {
  const key = asNum(doc.resolve(annot.get('StructParent')));
  if (key === undefined) return undefined; // untagged: nothing to re-point
  const rootDict = doc.resolve(doc.catalog().get('StructTreeRoot'));
  if (!isDict(rootDict)) return undefined;

  // The ref, not just the dict: the page's MCID array is written in refs.
  const elemRef = parentTreeLookup(doc, rootDict, key);
  if (elemRef === undefined) return undefined;
  const elem = doc.resolve(elemRef);
  if (!isDict(elem)) return undefined;

  // Where the OBJR sits in /K — the content kid takes that exact slot, so the
  // baked ink keeps the annotation's place in the reading order.
  const k = kArray(doc, elem);
  let at = -1;
  for (let i = 0; i < k.length && at < 0; i++) {
    const kid = doc.resolve(k[i]);
    if (!isDict(kid)) continue;
    const type = doc.resolve(kid.get('Type'));
    if (isName(type) && type.name === 'OBJR' && doc.resolve(kid.get('Obj')) === annot) at = i;
  }
  if (at < 0) return undefined;

  const s = doc.resolve(elem.get('S'));
  if (!isName(s)) return undefined;
  const tag = FLATTENED_TYPE.get(s.name) ?? s.name;
  if (tag !== s.name) elem.set('S', name(tag));

  const arr = pageMcidArray(doc, rootDict, page);
  const mcid = arr.length;
  arr.push(elemRef);

  // Same /Pg rule as appendContentKid: an integer MCID while the element's
  // content stays on one page, an MCR dict once a second page contributes.
  const pageRef = doc.pageRef(page.Number);
  const pg = elem.get('Pg');
  if (pg === undefined) {
    elem.set('Pg', pageRef);
    k[at] = mcid;
  } else if (isRef(pg) && pg.num === pageRef.num) {
    k[at] = mcid;
  } else {
    k[at] = new Map<string, PdfObject>([['Type', name('MCR')], ['Pg', pageRef], ['MCID', mcid]]);
  }

  clearParentTreeKeys(doc, rootDict, new Set([key]));
  annot.delete('StructParent');
  doc.markModified();
  return { tag, mcid };
}

/** An element's /K kids as a plain array, however /K is shaped. The array is the
 *  live one when /K already holds an array, so splices persist. */
function kidsOf(doc: Document, elem: PdfDict): { arr: PdfObject[]; live: boolean } {
  const k = doc.resolve(elem.get('K'));
  if (isArray(k)) return { arr: k, live: true };
  return { arr: k === undefined || k === null ? [] : [k], live: false };
}

/** Drop /ParentTree /Nums entries for `keys`.
 *
 *  A /Kids-based number tree is left alone rather than throwing: removal must
 *  not fail on a tree shape we decline to author into, and a stale entry there
 *  points at a *live* element, so it costs a lookup that returns nothing —
 *  never a resurrected annotation. */
function clearParentTreeKeys(doc: Document, rootDict: PdfDict, keys: ReadonlySet<number>): void {
  const pt = doc.resolve(rootDict.get('ParentTree'));
  if (!isDict(pt)) return;
  const nums = doc.resolve(pt.get('Nums'));
  if (!isArray(nums)) return;
  for (let i = nums.length - 2; i >= 0; i -= 2) {
    const k = asNum(doc.resolve(nums[i]));
    if (k !== undefined && keys.has(k)) nums.splice(i, 2);
  }
}

/**
 * Unwire removed annotations from the logical structure tree: drop the OBJR kids
 * naming them, prune elements that leaves with nothing, and clear their
 * /ParentTree slots. The exact reverse of `tagAnnotation`.
 *
 * Load-bearing, not tidiness. /StructTreeRoot is reachable from /Root, so an
 * OBJR's /Obj ref keeps a removed annotation alive through Save()'s mark-sweep:
 * the saved file then carries a widget that is in no page's /Annots and no
 * /AcroForm /Fields. It is the same trap a leftover /AcroForm /CO entry sprang
 * (see scrubCO in formremove.ts) — one ref from a /Root-reachable table is all
 * it takes.
 *
 * An element is pruned only when this pass *emptied* it. An element that was
 * already contentless is left where it is: removing an annotation is not a
 * licence to tidy a tree the caller built.
 */
export function untagObjects(doc: Document, dead: ReadonlySet<PdfDict>): void {
  if (dead.size === 0) return;
  const rootDict = doc.resolve(doc.catalog().get('StructTreeRoot'));
  if (!isDict(rootDict)) return;

  const keys = new Set<number>();
  for (const d of dead) {
    const k = asNum(doc.resolve(d.get('StructParent')));
    if (k !== undefined) keys.add(k);
  }

  const seen = new Set<PdfDict>();
  /** Scrub one node; true when it lost a kid and now has none, so its own parent
   *  should drop it too. */
  const scrub = (elem: PdfDict): boolean => {
    if (seen.has(elem)) return false;
    seen.add(elem);
    const { arr, live } = kidsOf(doc, elem);
    let lost = false;
    for (let i = arr.length - 1; i >= 0; i--) {
      const kid = doc.resolve(arr[i]);
      if (!isDict(kid)) continue; // an MCID integer: nothing to unwire
      const type = doc.resolve(kid.get('Type'));
      if (isName(type) && type.name === 'OBJR') {
        const obj = doc.resolve(kid.get('Obj'));
        if (isDict(obj) && dead.has(obj)) { arr.splice(i, 1); lost = true; }
        continue;
      }
      // Only structure elements recurse; an MCR dict has no kids of its own.
      if (!kid.has('S')) continue;
      if (scrub(kid)) { arr.splice(i, 1); lost = true; }
    }
    if (!lost) return false;
    // /K held a single value, so the splice above hit a copy: write it back.
    if (!live) {
      if (arr.length > 0) elem.set('K', arr[0]);
      else elem.delete('K');
    } else if (arr.length === 0) elem.delete('K');
    return arr.length === 0;
  };

  scrub(rootDict); // the root is never pruned, however empty it ends up
  clearParentTreeKeys(doc, rootDict, keys);
}

/** Normalize a rect to [minX,minY,maxX,maxY]. */
function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/** Axis-aligned box overlap. */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** One stream's op span, plus how many hits produced it. */
interface StreamSpan { streamIndex: number; min: number; max: number; count: number }

/** The top-level op span in EVERY content stream whose glyph/image boxes fall in
 *  `region`, in stream order; empty when the region has no top-level content.
 *  Content inside Form XObjects (addr.path non-empty) is ignored — a documented
 *  AutoTag limitation.
 *
 *  **Invariant:** every covered stream is reported, not just the busiest one.
 *  A page's `/Contents` is an ARRAY as often as not — `page.AddText` splices a
 *  new stream per call — and a region covering several of them is one line of
 *  text, not a damaged file (32000-1 7.8.2: the division between streams is
 *  unrelated to the page's logical content). Reducing to a single stream leaves
 *  the rest of the region unmarked, which is neither tagged nor artifacted, so
 *  it vanishes from the structure tree and from every export built on it
 *  (c3t7.10). */
export function regionOpSpans(doc: Document, page: Page, region: Rect): StreamSpan[] {
  const r = normRect(region);
  const per = new Map<number, StreamSpan>();
  const hit = (addr: ContentAddr, quad: Rect) => {
    if (addr.path.length !== 0 || !rectsIntersect(quad, r)) return;
    const s = per.get(addr.streamIndex);
    if (!s) per.set(addr.streamIndex, {
      streamIndex: addr.streamIndex, min: addr.opIndex, max: addr.opIndex, count: 1,
    });
    else { s.min = Math.min(s.min, addr.opIndex); s.max = Math.max(s.max, addr.opIndex); s.count++; }
  };
  visitContent(doc, page, { glyph: (e) => hit(e.addr, e.quad), image: (e) => hit(e.addr, e.quad) });
  // Stream order is reading order, and the caller appends one /K kid per span.
  return [...per.values()].sort((a, b) => a.streamIndex - b.streamIndex);
}

/** The single busiest span of the above — for a caller whose region covers one
 *  op by construction, such as the `Do` of an image. */
export function regionOpSpan(
  doc: Document, page: Page, region: Rect,
): { streamIndex: number; min: number; max: number } | undefined {
  let best: StreamSpan | undefined;
  for (const s of regionOpSpans(doc, page, region)) {
    if (!best || s.count > best.count) best = s;
  }
  return best;
}

/** Rebuild top stream `streamIndex`, inserting `before` at op `min` and `after`
 *  immediately after op `max`. The caller commits `ec`. */
export function wrapRegionOps(
  ec: EditableContent, streamIndex: number, min: number, max: number,
  before: ContentOp, after: ContentOp,
): void {
  const ops = [...ec.topOps(streamIndex)];
  ec.setTopOps(streamIndex, [
    ...ops.slice(0, min), before, ...ops.slice(min, max + 1), after, ...ops.slice(max + 1),
  ]);
}

/** Wrap the top-level content of `region` in `/<element.Type> <</MCID n>> BDC …
 *  EMC` under `element` and return the allocated MCID; -1 when the region has no
 *  top-level content (nothing is allocated or written).
 *
 *  **Invariant:** a region covering several content streams gets one BALANCED
 *  sequence per stream, each with its own MCID, all appended as kids of the one
 *  element. Our own reader would tolerate a single sequence opened in one stream
 *  and closed in another — `walkScope` keeps its marked-content state outside
 *  the stream loop, since a page's streams concatenate — but a sequence opening
 *  and closing in one stream is the rule this repo already holds itself to, and
 *  it leaves each stream independently well-formed for readers that do not
 *  concatenate. An element with several MCIDs is ordinary: `struct.ts` splits
 *  its own text run per MCID and already reassembles them in order.
 *
 *  Returns the FIRST MCID, which is the one a single-stream region has always
 *  returned — the whole point being that a caller cannot tell the two apart. */
export function markContentRegion(
  doc: Document, element: StructElement, page: Page, region: Rect,
): number {
  const spans = regionOpSpans(doc, page, region);
  if (spans.length === 0) return -1;
  const ec = new EditableContent(doc, page);
  let first = -1;
  for (const span of spans) {
    // Allocated per span: an MCID names one marked-content sequence, and the
    // /ParentTree maps it back to this element.
    const mcid = allocContentMcid(doc, element, page);
    if (first < 0) first = mcid;
    wrapRegionOps(
      ec, span.streamIndex, span.min, span.max,
      { operator: 'BDC', operands: [name(element.Type), new Map<string, PdfObject>([['MCID', mcid]])] },
      { operator: 'EMC', operands: [] },
    );
  }
  // One commit: each span edits a different stream, so the op indices the spans
  // carry stay valid — an insert into stream 0 shifts nothing in stream 1.
  ec.commit();
  return first;
}
