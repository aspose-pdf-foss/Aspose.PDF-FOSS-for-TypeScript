// Orphaned-resource pruning: after content-stream surgery removes ops, delete
// the /Resources entries nothing references any more, so the removed text or
// images cannot be recovered from what is left behind. Its own module (rather
// than part of redact.ts) because redact.ts imports image.ts for its decoder,
// and imageedit.ts -- which is reachable from ImageInfo -- needs this function.
//
// **Invariant:** ONE owner for the prune. Redaction and image removal must not
// disagree about what "unreferenced" means.

import type { Document } from './document.js';
import type { Page } from './page.js';
import type { EditableContent } from './editcontent.js';
import type { ContentOp } from './content.js';
import { PdfDict, isDict, isName } from './types.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';

/** Resource categories pruned by sanitization, keyed by the operator (and its
 *  first operand) that references a name in that /Resources sub-dict. */
const NAME_OP: Record<string, string> = { Tf: 'Font', Do: 'XObject', gs: 'ExtGState' };

/** Names still referenced by `ops`, bucketed by resource sub-dict. */
function referencedNames(ops: readonly ContentOp[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const op of ops) {
    const key = NAME_OP[op.operator];
    const a = op.operands[0];
    if (key && isName(a)) {
      let s = out.get(key);
      if (!s) { s = new Set(); out.set(key, s); }
      s.add(a.name);
    }
  }
  return out;
}

/** Delete entries of each prunable sub-dict of `resources` not in `refs`. The
 *  sub-dict is copy-on-written before mutation so shared dicts stay intact. */
function pruneResources(doc: Document, resources: PdfDict, refs: Map<string, Set<string>>): void {
  for (const key of Object.values(NAME_OP)) {
    const sub = doc.resolve(resources.get(key));
    if (!isDict(sub)) continue;
    const keep = refs.get(key) ?? new Set<string>();
    const owned = ensureOwnSubdict(doc, resources, key);
    for (const nm of [...owned.keys()]) if (!keep.has(nm)) owned.delete(nm);
  }
}

/** Prune resources orphaned by R1/R2 from the page and every edited Form
 *  XObject, so removed text/images cannot be recovered from leftover resources
 *  (newly-unreachable objects are swept by `Save`). Run before `ec.commit()`. */
export function sanitizeResources(doc: Document, page: Page, ec: EditableContent): void {
  // Page scope: referenced names are the union across all top content streams.
  const pageRefs = new Map<string, Set<string>>();
  for (let i = 0; i < ec.streamCount; i++) mergeRefs(pageRefs, referencedNames(ec.topOps(i)));
  pruneResources(doc, ensureOwnResources(doc, page), pageRefs);

  // Each edited Form XObject: prune its own /Resources against its own ops.
  for (const path of ec.editedXObjectPaths()) {
    const res = ec.xobjectResources(path);
    if (res) pruneResources(doc, res, referencedNames(ec.xobjectOps(path)));
  }
}

function mergeRefs(into: Map<string, Set<string>>, from: Map<string, Set<string>>): void {
  for (const [k, s] of from) {
    let t = into.get(k);
    if (!t) { t = new Set(); into.set(k, t); }
    for (const v of s) t.add(v);
  }
}
