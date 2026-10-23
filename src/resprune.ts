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
import { PdfDict, PdfObject, isDict, isName } from './types.js';
import { ensureOwnResources, ensureOwnSubdict } from './pagecontent.js';

/** Resource categories pruned by sanitization, keyed by the operator (and its
 *  first operand) that references a name in that /Resources sub-dict. */
const NAME_OP: Record<string, string> = { Tf: 'Font', Do: 'XObject', gs: 'ExtGState' };

/** Device colour-space names, which a `cs`/`CS` or an inline image may name
 *  without any /ColorSpace entry. Not resources, so never counted. */
const DEVICE_CS = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'G', 'RGB', 'CMYK', 'Pattern', 'I', 'Indexed']);

/** Names referenced by `ops`, bucketed by resource sub-dict, across EVERY
 *  category an operator can name (krf2.2): Font, XObject, ExtGState,
 *  ColorSpace, Pattern, Shading and Properties. `sanitizeResources` reads only
 *  its three (`NAME_OP`) out of this, so both prunes share one reading of
 *  "referenced". */
export function referencedNames(ops: readonly ContentOp[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, o: PdfObject | undefined) => {
    if (!isName(o)) return;
    let s = out.get(key);
    if (!s) { s = new Set(); out.set(key, s); }
    s.add(o.name);
  };
  for (const op of ops) {
    const ops0 = op.operands;
    const key = NAME_OP[op.operator];
    if (key) { add(key, ops0[0]); continue; }
    switch (op.operator) {
      case 'cs': case 'CS':
        if (isName(ops0[0]) && !DEVICE_CS.has(ops0[0].name)) add('ColorSpace', ops0[0]);
        break;
      case 'scn': case 'SCN': add('Pattern', ops0[ops0.length - 1]); break;
      case 'sh': add('Shading', ops0[0]); break;
      case 'BDC': case 'DP': add('Properties', ops0[1]); break;
      case 'BI': {
        const d = op.inlineImage?.dict;
        const cs = d?.get('CS') ?? d?.get('ColorSpace');
        if (isName(cs) && !DEVICE_CS.has(cs.name)) add('ColorSpace', cs);
        break;
      }
    }
  }
  return out;
}

/** Delete from `resources` each candidate name nothing in `refs` still names
 *  (krf2.2). Only the CANDIDATES go -- names the removed content used -- so an
 *  entry that was already unreferenced stays, unlike `sanitizeResources`. Each
 *  touched sub-dict is copied first, so a shared one stays intact. */
export function pruneCandidates(
  doc: Document, resources: PdfDict,
  candidates: Map<string, Set<string>>, refs: Map<string, Set<string>>,
): void {
  for (const [key, names] of candidates) {
    const sub = doc.resolve(resources.get(key));
    if (!isDict(sub)) continue;
    const keep = refs.get(key);
    const drop = [...names].filter((n) => sub.has(n) && !keep?.has(n));
    if (drop.length === 0) continue;
    const owned = ensureOwnSubdict(doc, resources, key);
    for (const n of drop) owned.delete(n);
  }
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

export function mergeRefs(into: Map<string, Set<string>>, from: Map<string, Set<string>>): void {
  for (const [k, s] of from) {
    let t = into.get(k);
    if (!t) { t = new Set(); into.set(k, t); }
    for (const v of s) t.add(v);
  }
}
