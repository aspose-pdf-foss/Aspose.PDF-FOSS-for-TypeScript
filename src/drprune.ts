import type { Document } from './document.js';
import { ContentOp, parseContentStream } from './content.js';
import {
  PdfDict, PdfObject, PdfRef, isDict, isStream, isArray, isName, isString, isRef,
} from './types.js';
import { decodeStream } from './filters.js';
import { refsIn } from './serializer.js';

/** The /DR categories this pass prunes. /ProcSet is an array of names rather
 *  than a resource dict, and is left alone. */
export const DR_CATEGORIES: readonly string[] = [
  'Font', 'XObject', 'ExtGState', 'ColorSpace', 'Pattern', 'Shading', 'Properties',
];

/** Colour spaces an operator may name that no /Resources ever holds: the device
 *  spaces, /Pattern, and the inline-image abbreviations (32000-1 table 93). */
const DEVICE_SPACES: ReadonlySet<string> = new Set([
  'DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern',
  'G', 'RGB', 'CMYK', 'I', 'Indexed',
]);

/** A reference key. Split at the *first* '/', which is unambiguous: a category
 *  name never contains one, a resource name (via a #2F escape) might. */
export const refKey = (category: string, name: string): string => `${category}/${name}`;

/** Every resource name a content fragment uses, as `Category/name` keys. The
 *  fragment may be a page's content, an /AP stream, or a /DA string — a /DA is
 *  a content-stream fragment by definition (32000-1 12.7.3.3), which is what
 *  lets one collector serve both of this pass's sources. */
export function collectResourceRefs(ops: readonly ContentOp[], out: Set<string>): void {
  for (const op of ops) {
    const a = op.operands;
    const first = a[0];
    switch (op.operator) {
      case 'Tf': if (isName(first)) out.add(refKey('Font', first.name)); break;
      case 'Do': if (isName(first)) out.add(refKey('XObject', first.name)); break;
      case 'gs': if (isName(first)) out.add(refKey('ExtGState', first.name)); break;
      case 'sh': if (isName(first)) out.add(refKey('Shading', first.name)); break;
      case 'cs': case 'CS':
        if (isName(first) && !DEVICE_SPACES.has(first.name)) out.add(refKey('ColorSpace', first.name));
        break;
      case 'scn': case 'SCN': {
        // A pattern is named by the *last* operand; the leading numbers are the
        // underlying colour components of an uncoloured pattern.
        const last = a[a.length - 1];
        if (isName(last)) out.add(refKey('Pattern', last.name));
        break;
      }
      case 'BDC': {
        // operands are [tag, propertyList]; only an inline dict avoids /Properties.
        const props = a[1];
        if (isName(props)) out.add(refKey('Properties', props.name));
        break;
      }
      case 'BI': {
        const d = op.inlineImage?.dict;
        const cs = d?.get('CS') ?? d?.get('ColorSpace');
        if (isName(cs) && !DEVICE_SPACES.has(cs.name)) out.add(refKey('ColorSpace', cs.name));
        break;
      }
    }
  }
}

export interface DrPruneResult {
  /** Qualified keys removed, e.g. 'Font/TiBo'. */
  removed: string[];
  bytesSaved: number;
  /** Set when the pass declined to run; `removed` is then empty. */
  skipped?: string;
}

/** Charge to /DR every name `local` holds that `res` does not resolve. A /DA
 *  has no resource dict of its own, so all of its names are charged. */
function chargeUnresolved(doc: Document, local: Set<string>, res: PdfObject, out: Set<string>): void {
  for (const key of local) {
    const cut = key.indexOf('/');
    const category = key.slice(0, cut), nm = key.slice(cut + 1);
    const table = isDict(res) ? doc.resolve(res.get(category)) : null;
    if (isDict(table) && table.has(nm)) continue;
    out.add(key);
  }
}

/**
 * Every reference the document can make into /DR: each /DA string, and each
 * name an /AP stream cannot resolve against its own /Resources.
 *
 * The walk starts at the catalog, not at `doc.objectEntries()`, and that is
 * load-bearing rather than tidy. `Form.RemoveField` unwires a field and leaves
 * its dict in the object map for `Save()`'s mark-sweep to drop; scanning every
 * object would read the /DA of the very field whose removal this pass exists to
 * clean up after, and the pass would never remove anything.
 */
function collectDrReferences(doc: Document): { refs: Set<string> } | { veto: string } {
  const refs = new Set<string>();
  const seen = new Set<PdfObject>();
  let veto: string | undefined;

  const scan = (stream: PdfObject): void => {
    if (!isStream(stream)) return;
    let ops: ContentOp[];
    try { ops = parseContentStream(decodeStream(stream)); }
    catch { veto ??= 'an appearance stream could not be read'; return; }
    const local = new Set<string>();
    collectResourceRefs(ops, local);
    chargeUnresolved(doc, local, doc.resolve(stream.dict.get('Resources')), refs);
  };

  const visitAP = (ap: PdfObject): void => {
    const d = doc.resolve(ap);
    if (!isDict(d)) return;
    for (const key of ['N', 'D', 'R']) {
      const entry = doc.resolve(d.get(key));
      if (isStream(entry)) scan(entry);
      // The sub-dictionary form: /N << /Yes 5 0 R /Off 6 0 R >>.
      else if (isDict(entry)) for (const v of entry.values()) scan(doc.resolve(v));
    }
  };

  const visit = (o: PdfObject): void => {
    const r = doc.resolve(o);
    if (isArray(r)) {
      if (seen.has(r)) return;
      seen.add(r);
      for (const v of r) visit(v);
      return;
    }
    const d = isDict(r) ? r : isStream(r) ? r.dict : undefined;
    if (!d || seen.has(d)) return;
    seen.add(d);
    const da = doc.resolve(d.get('DA'));
    if (isString(da)) {
      try { collectResourceRefs(parseContentStream(da.bytes), refs); }
      catch { veto ??= 'a /DA string could not be read'; }
    }
    const ap = d.get('AP');
    if (ap !== undefined) visitAP(ap);
    for (const v of d.values()) visit(v);
  };

  visit(doc.catalog());
  return veto !== undefined ? { veto } : { refs };
}

/** Object numbers reachable from /Root (+ /Info) — what `Save()` would write. */
function reachableSet(doc: Document): Set<number> {
  const objects = new Map<number, PdfObject>();
  for (const [r, o] of doc.objectEntries()) objects.set(r.num, o);
  const seen = new Set<number>();
  const queue: number[] = [];
  const push = (n: number): void => {
    if (seen.has(n) || !objects.has(n)) return;
    seen.add(n);
    queue.push(n);
  };
  for (const key of ['Root', 'Info']) {
    const r = doc.trailer.get(key);
    if (isRef(r)) push(r.num);
  }
  while (queue.length) {
    const out: PdfRef[] = [];
    refsIn(objects.get(queue.shift()!)!, out);
    for (const r of out) push(r.num);
  }
  return seen;
}

/**
 * A /DR entry can itself be a content stream — a form XObject, a tiling pattern —
 * naming further /DR entries. Charge those, for *kept* entries only, to a
 * fixpoint.
 *
 * Kept-only is what makes the pass idempotent. Charging every /DR stream would
 * let an entry that this same run deletes keep a resource alive, and the next
 * Optimize would then remove more than this one did.
 */
function chargeKeptDrStreams(doc: Document, dr: PdfDict, refs: Set<string>): string | undefined {
  for (;;) {
    let grew = false;
    for (const category of DR_CATEGORIES) {
      const table = doc.resolve(dr.get(category));
      if (!isDict(table)) continue;
      for (const nm of table.keys()) {
        if (!refs.has(refKey(category, nm))) continue;
        const entry = doc.resolve(table.get(nm));
        if (!isStream(entry)) continue;
        let ops: ContentOp[];
        try { ops = parseContentStream(decodeStream(entry)); }
        catch { return 'a /DR resource stream could not be read'; }
        const local = new Set<string>();
        collectResourceRefs(ops, local);
        const before = refs.size;
        chargeUnresolved(doc, local, doc.resolve(entry.dict.get('Resources')), refs);
        if (refs.size !== before) grew = true;
      }
    }
    if (!grew) return undefined;
  }
}

/**
 * Delete /AcroForm /DR entries nothing in the document can name, and the objects
 * that leaves unreachable.
 *
 * Deleting the orphans is what keeps the rest of Optimize honest: an orphaned
 * stream left in the object map is still walked by dedup and recompress, which
 * would report bytes saved on an object `Save()` was going to drop anyway. It is
 * a mark-sweep confined to what this pass orphaned — anything already unreachable
 * beforehand is left to `Save()`.
 */
export function pruneDefaultResources(doc: Document): DrPruneResult {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return { removed: [], bytesSaved: 0 };
  // An XFA packet names /DR faces and txgg documented that we never read it. A
  // scan that structurally cannot see those references is not complete, and
  // "unused" is exactly the conclusion it must not draw. Editing a hybrid
  // document stays allowed — concluding something in it is dead does not.
  if (acro.has('XFA')) {
    return {
      removed: [], bytesSaved: 0,
      skipped: 'a hybrid XFA document may name /DR resources from its XFA packet',
    };
  }
  const dr = doc.resolve(acro.get('DR'));
  if (!isDict(dr)) return { removed: [], bytesSaved: 0 };

  const found = collectDrReferences(doc);
  if ('veto' in found) return { removed: [], bytesSaved: 0, skipped: found.veto };
  const refs = found.refs;
  const streamVeto = chargeKeptDrStreams(doc, dr, refs);
  if (streamVeto !== undefined) return { removed: [], bytesSaved: 0, skipped: streamVeto };

  const before = reachableSet(doc);
  const removed: string[] = [];
  for (const category of DR_CATEGORIES) {
    const table = doc.resolve(dr.get(category));
    if (!isDict(table)) continue;
    let removedHere = 0;
    for (const nm of [...table.keys()]) {
      if (refs.has(refKey(category, nm))) continue;
      table.delete(nm);
      removed.push(refKey(category, nm));
      removedHere++;
    }
    // An empty category dict is a leftover; the next Add* rebuilds what it needs.
    if (removedHere > 0 && table.size === 0) dr.delete(category);
  }
  if (removed.length === 0) return { removed, bytesSaved: 0 };
  if (dr.size === 0) acro.delete('DR');

  const after = reachableSet(doc);
  let bytesSaved = 0;
  const orphans: number[] = [];
  for (const [r, o] of [...doc.objectEntries()]) {
    if (!before.has(r.num) || after.has(r.num)) continue;
    orphans.push(r.num);
    // Stream payloads only. A font dict with no program frees bytes the report
    // cannot measure, matching the estimate the rest of OptimizeReport gives.
    if (isStream(o)) bytesSaved += o.raw.length;
  }
  for (const num of orphans) doc.deleteObject(num);
  return { removed, bytesSaved };
}
