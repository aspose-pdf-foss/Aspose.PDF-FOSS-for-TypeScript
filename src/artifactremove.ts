// Artifact removal (krf2.2): cut `/Artifact` marked-content spans out of a
// page's content, and prune the resources only they used. The read side is
// artifact.ts; this module takes ADDRESSES and knows nothing of how they were
// found, so it never imports artifact.ts and the edge closes no cycle.
//
// **Invariant:** unlike `structremove.ts`, which untags and keeps every byte of
// ink, this DELETES the span -- the BMC/BDC, everything inside it and its EMC.
// That is the point: the furniture is gone, not merely unmarked.

import type { Document } from './document.js';
import type { Page } from './page.js';
import { isDict, isName, isRef, isStream, type PdfDict } from './types.js';
import { EditableContent, type ContentAddr } from './editcontent.js';
import { parseContentStream, type ContentOp } from './content.js';
import { inflateStream } from './flate.js';
import { budgetFor } from './decodebudget.js';
import { referencedNames, pruneCandidates, mergeRefs } from './resprune.js';
import { rethrowLimit } from './errors.js';

type Refs = Map<string, Set<string>>;

/** One scope's content as a flat op list. The page scope concatenates every
 *  /Contents stream -- 32000-1 7.8.2 makes their division arbitrary, so a span
 *  may open in one and close in the next -- and remembers where each starts. */
export interface CutScope {
  readonly path: string[];
  readonly ops: ContentOp[];
  /** Flat index at which stream i begins (page scope); [0] for a form. */
  readonly starts: number[];
  /** Flat indices to delete; the plan adds to it. */
  readonly cut: Set<number>;
}
interface Scope extends CutScope { removed: ContentOp[] }

const isOpen = (op: ContentOp) => op.operator === 'BMC' || op.operator === 'BDC';
const isArtifactOpen = (op: ContentOp) =>
  isOpen(op) && isName(op.operands[0]) && op.operands[0].name === 'Artifact';

/** Remove the artifact spans opening at `addrs` from `page`.
 *
 *  Every address is located before anything changes, and an address that does
 *  not open an `/Artifact` sequence, or whose sequence never closes, throws
 *  `RangeError` with the document untouched. One `EditableContent` serves the
 *  whole call, so removing several spans in one stream cannot shift the
 *  indices of the next. A form drawn on several pages is copied on write for
 *  THIS page only; a form drawn twice on this page is one stream, so a span in
 *  it is removed from both drawings. */
export function removeArtifactSpans(doc: Document, page: Page, addrs: readonly ContentAddr[]): number {
  if (addrs.length === 0) return 0;
  return cutAndPrune(doc, page, (scopeOf) => {
    // Locate every span first, so a bad address refuses the whole call. Spans
    // that nest or repeat union into one cut set, which is their removal.
    let removed = 0;
    const seen = new Set<string>();
    for (const a of addrs) {
      const k = [...a.path, a.streamIndex, a.opIndex].join('\0');
      if (seen.has(k)) continue;
      seen.add(k);
      const s = scopeOf(a.path);
      const begin = (s.starts[a.streamIndex] ?? NaN) + a.opIndex;
      const op = s.ops[begin];
      if (op === undefined || !isArtifactOpen(op))
        throw new RangeError('this address does not open an /Artifact sequence');
      let depth = 0, end = -1;
      for (let i = begin; i < s.ops.length; i++) {
        if (isOpen(s.ops[i])) depth++;
        else if (s.ops[i].operator === 'EMC' && --depth === 0) { end = i; break; }
      }
      if (end < 0) throw new RangeError('the /Artifact sequence is never closed by an EMC');
      for (let i = begin; i <= end; i++) s.cut.add(i);
      removed++;
    }
    return removed;
  });
}

/** Delete ops from `page` and prune what only they named (krf2.2, krf2.3).
 *
 *  `plan` is handed a scope accessor and marks flat op indices in each scope's
 *  `cut`; it may throw, and since nothing has been edited by then a refusal
 *  leaves the page as it was -- except that an indirect /Resources has been
 *  copied to the page, which changes no appearance. Returns what `plan`
 *  returns. One `EditableContent` serves the whole call, so cuts in one
 *  stream cannot shift each other's indices. */
export function cutAndPrune(
  doc: Document, page: Page, plan: (scopeOf: (path: readonly string[]) => CutScope) => number,
): number {
  // A shared /Resources must become this page's own BEFORE the edit: the
  // copy-on-write repoints an /XObject entry, and pruning deletes names, and
  // either done to a dict another page holds changes that page too.
  const own = page.Dict.get('Resources');
  if (isRef(own)) {
    const d = doc.resolve(own);
    if (isDict(d)) page.Dict.set('Resources', new Map(d));
  }

  const ec = new EditableContent(doc, page);
  const scopes = new Map<string, Scope>();
  const scopeOf = (path: readonly string[]): Scope => {
    const k = path.join('\0');
    let s = scopes.get(k);
    if (s) return s;
    if (path.length === 0) {
      const ops: ContentOp[] = [];
      const starts: number[] = [];
      for (let i = 0; i < ec.streamCount; i++) { starts.push(ops.length); ops.push(...ec.topOps(i)); }
      s = { path: [], ops, starts, cut: new Set(), removed: [] };
    } else {
      s = { path: [...path], ops: [...ec.xobjectOps(path)], starts: [0], cut: new Set(), removed: [] };
    }
    scopes.set(k, s);
    return s;
  };

  const result = plan(scopeOf);
  applyCuts(doc, page, ec, scopes);
  return result;
}

/** Write each scope's cuts back, prune what only the cut ops named, commit. */
function applyCuts(doc: Document, page: Page, ec: EditableContent, scopes: Map<string, Scope>): void {
  for (const s of scopes.values()) {
    s.removed = s.ops.filter((_, i) => s.cut.has(i));
    if (s.path.length === 0) {
      for (let i = 0; i < s.starts.length; i++) {
        const lo = s.starts[i], hi = s.starts[i + 1] ?? s.ops.length;
        const kept: ContentOp[] = [];
        let touched = false;
        for (let j = lo; j < hi; j++) { if (s.cut.has(j)) touched = true; else kept.push(s.ops[j]); }
        if (touched) ec.setTopOps(i, kept);
      }
    } else {
      ec.setXobjectOps(s.path, s.ops.filter((_, i) => !s.cut.has(i)));
    }
  }

  // Prune what only the removed spans named. What still names a resource is
  // the scope's remaining ops PLUS every form they draw that has no /Resources
  // of its own, which looks its names up in this scope's dict.
  for (const s of scopes.values()) {
    const candidates = referencedNames(s.removed);
    if (candidates.size === 0) continue;
    const resources = s.path.length === 0 ? ownResources(doc, page) : ec.xobjectResources(s.path);
    if (!resources) continue;
    const kept = s.path.length === 0
      ? Array.from({ length: ec.streamCount }, (_, i) => ec.topOps(i)).flat()
      : ec.xobjectOps(s.path);
    const refs = referencedNames(kept);
    inheritedRefs(doc, resources, refs, 0, new Set());
    pruneCandidates(doc, resources, candidates, refs);
  }
  ec.commit();
}

/** The page's own /Resources, made own if it was inherited. */
function ownResources(doc: Document, page: Page): PdfDict {
  const d = doc.resolve(page.Dict.get('Resources'));
  if (isDict(d)) return d;
  const copy: PdfDict = new Map(page.Resources ?? []);
  page.Dict.set('Resources', copy);
  return copy;
}

/** Add to `refs` the names used by every form `refs` already draws through
 *  `resources` that has no /Resources of its own -- it inherits this scope's,
 *  so pruning a name it uses would break it. Recursive, bounded by
 *  `maxNestingDepth` and by a seen set against a form that draws itself. A
 *  form that will not parse contributes nothing, since nothing it names is
 *  then provably needed by it. */
function inheritedRefs(doc: Document, resources: PdfDict, refs: Refs, depth: number, seen: Set<object>): void {
  doc.loadLimits.enforce('maxNestingDepth', depth + 1, 'inherited form resources');
  const xobjs = doc.resolve(resources.get('XObject'));
  if (!isDict(xobjs)) return;
  for (const nm of [...(refs.get('XObject') ?? [])]) {
    const f = doc.resolve(xobjs.get(nm));
    if (!isStream(f) || seen.has(f) || f.dict.has('Resources')) continue;
    seen.add(f);
    let ops: ContentOp[];
    try {
      ops = parseContentStream(inflateStream(f), budgetFor(f).limits);
    } catch (caught) { rethrowLimit(caught);
      continue;
    }
    const inner = referencedNames(ops);
    mergeRefs(refs, inner);
    inheritedRefs(doc, resources, inner, depth + 1, seen);
    mergeRefs(refs, inner);
  }
}
