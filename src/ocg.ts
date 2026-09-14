import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfRef,
  isDict, isArray, isRef, isName, isString, isStream, name,
} from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { parseContentStream, serializeContentStream, ContentOp } from './content.js';
import { decodeStream } from './filters.js';
import { streamOf } from './pagecontent.js';
import type { Page } from './page.js';
import {
  LayerUsage, UsageContext, UsageEvent,
  readUsage, writeUsage, applyUsageEntry, combineUsageStates, usageCategoryEvent,
} from './ocusage.js';

export type { LayerUsage, UsageContext, UsageEvent } from './ocusage.js';

/** Reference equality by object/generation number. */
export function sameRef(a: PdfObject | undefined, b: PdfRef): boolean {
  return isRef(a) && a.num === b.num && a.gen === b.gen;
}

/** Resolve `o` to its array of entries (empty when not an array). */
export function arrayOf(doc: Document, o: PdfObject | undefined): PdfObject[] {
  const a = doc.resolve(o);
  return isArray(a) ? a : [];
}

/** Resolve `o` to a dict, or undefined. */
export function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const d = doc.resolve(o);
  return isDict(d) ? d : undefined;
}

/** Does `o` (a ref, an OCG dict, or an OCMD listing the layer) name `target`? */
export function refMatchesLayer(doc: Document, o: PdfObject | undefined, target: PdfRef): boolean {
  if (sameRef(o, target)) return true;
  const d = doc.resolve(o);
  if (isDict(d)) {
    const t = doc.resolve(d.get('Type'));
    if (isName(t) && t.name === 'OCMD') {
      const ocgs = d.get('OCGs');
      if (isArray(doc.resolve(ocgs))) {
        if (arrayOf(doc, ocgs).some((g) => sameRef(g, target))) return true;
      } else if (sameRef(ocgs, target)) {
        return true;
      }
      if (veReferencesLayer(doc, d.get('VE'), target)) return true;
    }
  }
  return false;
}

/** True when `target` appears as any leaf OCG ref in a /VE expression tree. */
function veReferencesLayer(doc: Document, ve: PdfObject | undefined, target: PdfRef): boolean {
  const a = doc.resolve(ve);
  if (!isArray(a)) return false;
  // a[0] is the operator name; operands are a[1..]
  for (let i = 1; i < a.length; i++) {
    const operand = a[i];
    if (sameRef(operand, target)) return true;
    if (isArray(doc.resolve(operand)) && veReferencesLayer(doc, operand, target)) return true;
  }
  return false;
}

/** Prune `target` from a /VE expression tree, returning the rewritten tree, or
 *  `undefined` when the operator is left with no operands (an empty expression).
 *  Nested sub-expressions that collapse to empty are dropped from their parent. */
function pruneVE(doc: Document, ve: PdfObject | undefined, target: PdfRef): PdfObject | undefined {
  const a = doc.resolve(ve);
  if (!isArray(a)) return isArray(ve) ? ve : undefined;
  const operands: PdfObject[] = [];
  for (let i = 1; i < a.length; i++) {
    const operand = a[i];
    if (sameRef(operand, target)) continue;
    if (isArray(doc.resolve(operand))) {
      const pruned = pruneVE(doc, operand, target);
      if (pruned !== undefined) operands.push(pruned);
    } else {
      operands.push(operand);
    }
  }
  return operands.length === 0 ? undefined : [a[0], ...operands];
}

/** Return a copy of `arr` with `target` removed at any depth (for /Order, /RBGroups). */
export function removeRefDeep(arr: PdfObject[], target: PdfRef): PdfObject[] {
  const out: PdfObject[] = [];
  for (const e of arr) {
    if (sameRef(e, target)) continue;
    if (isArray(e)) out.push(removeRefDeep(e, target));
    else out.push(e);
  }
  return out;
}

/** Deep-copy an /Order array (entries are refs, strings, or nested arrays). */
function deepCopyOrder(a: PdfObject[]): PdfObject[] {
  return a.map((e) => (isArray(e) ? deepCopyOrder(e) : e));
}

/** The Table 101 keys that describe a configuration's STATE, as against the
 *  `/Name` and `/Creator` that identify it. These are what
 *  {@link OptionalContent.ApplyConfiguration} moves, and what
 *  {@link OptionalContent.SaveConfiguration} snapshots. */
const CONFIG_STATE_KEYS = [
  'BaseState', 'ON', 'OFF', 'Order', 'Locked', 'AS', 'RBGroups', 'Intent', 'ListMode',
] as const;

/**
 * Copy one configuration value so a DIFFERENT configuration can own it.
 *
 * **Invariant: a ref that NAMES A LAYER is shared; a container the
 * configuration OWNS is cloned.** `/ON`, `/OFF`, `/Order`, `/Locked` and
 * `/RBGroups` hold refs to OCGs — clone those and the copy names layers that
 * do not exist — while the arrays around them are the configuration's own.
 * Sharing a container instead makes two configurations one state wearing two
 * names: under this library's live-mutation model a later `SetVisible` on
 * `/D` would rewrite the preset just applied, and a `SaveConfiguration`
 * snapshot would go on changing after it was taken.
 *
 * `owned` says which side of that line the value sits on, and it is decided
 * PER KEY rather than per value, because the two are indistinguishable from
 * the value alone: an `/AS` entry may be an indirect dict and so may nothing
 * else here. Inside such an entry it flips back to false, since that dict's
 * own `/OCGs` names layers exactly as `/ON` does.
 */
function cloneConfigValue(doc: Document, v: PdfObject, owned: boolean): PdfObject {
  if (isArray(v)) return v.map((e) => cloneConfigValue(doc, e, owned));
  if (owned) {
    const d = resolveDict(doc, v);
    if (d) {
      const out: PdfDict = new Map<string, PdfObject>();
      for (const [k, e] of d) out.set(k, cloneConfigValue(doc, e, false));
      return out;
    }
  }
  return v;
}

/** Copy every state key of `src` onto `dst`, REPLACING what was there.
 *
 * **Invariant: it replaces rather than merges.** Every state key is deleted
 * from `dst` first, so a source silent about `/OFF` leaves the destination
 * silent too. Merged instead, applying a preset that says nothing about a key
 * leaves the previous configuration's value standing and the document sits in
 * a state that is NEITHER configuration — which renders plausibly and is
 * exactly the bug nobody would look for. `/Name` and `/Creator` are not state:
 * they identify a configuration rather than describe it, so `/D` keeps its
 * own and does not come to claim it IS the preset.
 *
 * **Note, measured, and it covers NOTHING:** the `src.has(key)` test is
 * redundant with the `v === null` line two below it and provably cannot be
 * otherwise — `doc.resolve(undefined)` answers `null`, so an absent key
 * reaches that line and is skipped there. Replacing it with a resolved-value
 * comparison reddens not one case. It stays as the honest spelling of
 * "presence is tested on the RAW dict", the trap `pdfxvalidate.ts` records,
 * and as the guard that keeps working if the line below ever changes; do not
 * read the green suite as covering it. */
function copyConfigState(doc: Document, src: PdfDict, dst: PdfDict): void {
  for (const key of CONFIG_STATE_KEYS) {
    dst.delete(key);
    // Presence is tested on the RAW dict: `doc.resolve(undefined)` is `null`,
    // so comparing a resolved value against undefined is true for every
    // absent key.
    if (!src.has(key)) continue;
    const v = doc.resolve(src.get(key));
    if (v === null) continue;
    dst.set(key, cloneConfigValue(doc, v, key === 'AS'));
  }
}

/** Place `ref` under `parent` in an /Order tree (mutates `order`): if the entry
 *  right after `parent` is an array, push into it; else insert a fresh `[ref]`
 *  array right after `parent`. Recurses into nested arrays. Returns whether it
 *  found `parent`. */
function placeUnder(order: PdfObject[], parent: PdfRef, ref: PdfRef): boolean {
  for (let i = 0; i < order.length; i++) {
    const e = order[i];
    if (sameRef(e, parent)) {
      const next = order[i + 1];
      if (isArray(next)) next.push(ref);
      else order.splice(i + 1, 0, [ref]);
      return true;
    }
    if (isArray(e) && placeUnder(e, parent, ref)) return true;
  }
  return false;
}

/** Is `o` the name `n`? */
function sameName(doc: Document, o: PdfObject | undefined, n: string): boolean {
  const v = doc.resolve(o);
  return isName(v) && v.name === n;
}

function textOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const s = doc.resolve(o);
  return isString(s) ? decodePdfText(s.bytes) : undefined;
}

function pdfText(v: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(v) };
}

/** Shared state for excising a deleted layer from content streams. `caseA` holds
 *  the object numbers of XObjects bound to the layer by their own /OC (whose
 *  unconditional `Do` ops must go); `unlinked` collects XObjects whose only `Do`
 *  op sat inside an excised layer block (candidates for removal if not otherwise
 *  invoked). */
interface Excision {
  target: PdfRef;
  caseA: Set<number>;
  unlinked: Set<number>;
}

/** Concatenate a page's decoded /Contents streams (newline-separated), or
 *  undefined when the page has no content stream. */
function pageContentBytes(doc: Document, page: Page): Uint8Array | undefined {
  const c = doc.resolve(page.Dict.get('Contents'));
  const refs: PdfObject[] = isArray(c) ? c : c === null ? [] : [page.Dict.get('Contents') as PdfObject];
  const parts: Uint8Array[] = [];
  for (const r of refs) {
    const s = doc.resolve(r);
    if (isStream(s)) parts.push(decodeStream(s));
  }
  if (parts.length === 0) return undefined;
  const NL = new Uint8Array([0x0a]);
  const joined: Uint8Array[] = [];
  parts.forEach((p, i) => { if (i) joined.push(NL); joined.push(p); });
  const total = joined.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of joined) { buf.set(p, off); off += p.length; }
  return buf;
}

/** Excise every `/OC … BDC … EMC` block bound to the layer from a page's
 *  content (and any `Do` op invoking a `caseA` XObject), rewriting /Contents as
 *  a single uncompressed stream. Returns true when anything was removed. */
function stripLayerContent(doc: Document, page: Page, ex: Excision): boolean {
  const buf = pageContentBytes(doc, page);
  if (!buf) return false;
  const props = resolveDict(doc, page.Resources?.get('Properties'));
  const xobjs = resolveDict(doc, page.Resources?.get('XObject'));
  const { out, dropped } = stripOcBlocks(doc, parseContentStream(buf), props, xobjs, ex);
  if (!dropped) return false;
  page.Dict.set('Contents', [doc.allocObject(streamOf(serializeContentStream(out)))]);
  return true;
}

/** Resolve a `Do` op's operand to the invoked XObject's object number via
 *  `xobjs`, or undefined when the op is not a resolvable `Do`. */
function doTarget(doc: Document, op: ContentOp, xobjs: PdfDict | undefined): number | undefined {
  if (op.operator !== 'Do' || !xobjs) return undefined;
  const nm = op.operands[0];
  if (!isName(nm)) return undefined;
  const r = xobjs.get(nm.name);
  return isRef(r) ? r.num : undefined;
}

/** Filter `/OC … BDC … EMC` blocks bound to the layer out of a parsed op list
 *  (resolving BDC operands against `props`), and drop unconditional `Do` ops
 *  invoking a `caseA` XObject (resolving names against `xobjs`). `Do` ops found
 *  inside a dropped block are recorded in `ex.unlinked`. Nested blocks under a
 *  dropped one go with it. Returns the surviving ops and whether anything was
 *  removed. */
function stripOcBlocks(doc: Document, ops: ContentOp[], props: PdfDict | undefined, xobjs: PdfDict | undefined, ex: Excision): { out: ContentOp[]; dropped: boolean } {
  const out: ContentOp[] = [];
  let dropDepth = -1; // -1 = not dropping; otherwise the nesting level the dropped block opened at
  let nesting = 0;
  let dropped = false;

  for (const op of ops) {
    if (op.operator === 'BDC' || op.operator === 'BMC') {
      const startDrop = dropDepth < 0 && op.operator === 'BDC' && isOcOperand(doc, op, props, ex.target);
      if (startDrop) { dropDepth = nesting; dropped = true; }
      nesting++;
      if (dropDepth < 0) out.push(op);
      continue;
    }
    if (op.operator === 'EMC') {
      nesting = Math.max(0, nesting - 1);
      if (dropDepth >= 0) {
        if (nesting === dropDepth) dropDepth = -1; // close the dropped block (skip this EMC)
        continue;
      }
      out.push(op);
      continue;
    }
    if (dropDepth >= 0) {
      // record XObjects invoked inside excised layer content as removal candidates
      const n = doTarget(doc, op, xobjs);
      if (n !== undefined) ex.unlinked.add(n);
      continue;
    }
    // outside any dropped block: drop unconditional Do ops for /OC-bound XObjects
    const n = doTarget(doc, op, xobjs);
    if (n !== undefined && ex.caseA.has(n)) { dropped = true; continue; }
    out.push(op);
  }
  return { out, dropped };
}

/** Recurse through the XObjects reachable from `resources` (and, for Form
 *  XObjects, their own nested XObjects), removing the deleted layer from each:
 *  clearing an `/OC` that binds the whole XObject (image or form) to `target`,
 *  and excising `/OC … BDC … EMC` blocks bound to `target` from each form's
 *  content stream. Each XObject is processed once (`visited` by object number);
 *  forms whose content changed are rewritten in place so every referrer sees
 *  the edit. */
function stripLayerFromXObjects(doc: Document, resources: PdfDict | undefined, ex: Excision, visited: Set<number>): void {
  const xobjs = resolveDict(doc, resources?.get('XObject'));
  if (!xobjs) return;
  for (const [, v] of xobjs) {
    if (!isRef(v) || visited.has(v.num)) continue;
    visited.add(v.num);
    const xo = doc.resolve(v);
    if (!isStream(xo)) continue;
    // An XObject directly /OC-bound to the layer is removed wholesale (case A);
    // one bound via an OCMD is merely un-layered (its /OC cleared).
    if (sameRef(xo.dict.get('OC'), ex.target)) ex.caseA.add(v.num);
    else if (refMatchesLayer(doc, xo.dict.get('OC'), ex.target)) xo.dict.delete('OC');
    const subtype = doc.resolve(xo.dict.get('Subtype'));
    if (!isName(subtype) || subtype.name !== 'Form') continue;
    const res = resolveDict(doc, xo.dict.get('Resources'));
    const props = resolveDict(doc, res?.get('Properties'));
    const innerX = resolveDict(doc, res?.get('XObject'));
    const { out, dropped } = stripOcBlocks(doc, parseContentStream(decodeStream(xo)), props, innerX, ex);
    if (dropped) {
      const raw = serializeContentStream(out);
      const dict: PdfDict = new Map(xo.dict);
      dict.delete('Filter');
      dict.delete('DecodeParms');
      dict.set('Length', raw.length);
      doc.replaceObject(v.num, { kind: 'stream', dict, raw });
    }
    stripLayerFromXObjects(doc, res, ex, visited); // nested forms
  }
}

/** Collect the object numbers of Form/Image XObjects whose own dict `/OC` is a
 *  direct reference to `target` (their sole purpose is the deleted layer), by
 *  walking the XObject graph reachable from `resources`. */
function collectDirectlyBoundXObjects(doc: Document, resources: PdfDict | undefined, target: PdfRef, out: Set<number>, visited: Set<number>): void {
  const xobjs = resolveDict(doc, resources?.get('XObject'));
  if (!xobjs) return;
  for (const [, v] of xobjs) {
    if (!isRef(v) || visited.has(v.num)) continue;
    visited.add(v.num);
    const xo = doc.resolve(v);
    if (!isStream(xo)) continue;
    if (sameRef(xo.dict.get('OC'), target)) out.add(v.num);
    const subtype = doc.resolve(xo.dict.get('Subtype'));
    if (isName(subtype) && subtype.name === 'Form') {
      collectDirectlyBoundXObjects(doc, resolveDict(doc, xo.dict.get('Resources')), target, out, visited);
    }
  }
}

/** Collect every XObject object number invoked by a `Do` op reachable from the
 *  pages through surviving (post-excision) content — page /Contents and, for
 *  Form XObjects, their content — so callers can tell which excision candidates
 *  are still in use. */
function collectInvokedXObjects(doc: Document): Set<number> {
  const invoked = new Set<number>();
  const seenForms = new Set<number>();
  const walk = (bytes: Uint8Array | undefined, scope: PdfDict | undefined): void => {
    if (!bytes) return;
    const xobjs = resolveDict(doc, scope?.get('XObject'));
    if (!xobjs) return;
    for (const op of parseContentStream(bytes)) {
      const n = doTarget(doc, op, xobjs);
      if (n === undefined) continue;
      invoked.add(n);
      const xo = doc.getObject(n);
      if (!isStream(xo)) continue;
      const subtype = doc.resolve(xo.dict.get('Subtype'));
      if (isName(subtype) && subtype.name === 'Form' && !seenForms.has(n)) {
        seenForms.add(n);
        walk(decodeStream(xo), resolveDict(doc, xo.dict.get('Resources')));
      }
    }
  };
  for (const page of doc.Pages) walk(pageContentBytes(doc, page), page.Resources);
  return invoked;
}

/** Delete `nums` from `resources`' /XObject dict (recursing into surviving Form
 *  XObjects), so no live resource entry keeps a removed XObject reachable. */
function stripXObjectEntries(doc: Document, resources: PdfDict | undefined, nums: Set<number>, visited: Set<number>): void {
  const xobjs = resolveDict(doc, resources?.get('XObject'));
  if (!xobjs) return;
  for (const [k, v] of [...xobjs]) {
    if (!isRef(v)) continue;
    if (nums.has(v.num)) { xobjs.delete(k); continue; }
    if (visited.has(v.num)) continue;
    visited.add(v.num);
    const xo = doc.resolve(v);
    if (!isStream(xo)) continue;
    const subtype = doc.resolve(xo.dict.get('Subtype'));
    if (isName(subtype) && subtype.name === 'Form') {
      stripXObjectEntries(doc, resolveDict(doc, xo.dict.get('Resources')), nums, visited);
    }
  }
}

/** True when a BDC op is `/OC <prop> BDC` and <prop> resolves to `target`. */
function isOcOperand(doc: Document, op: ContentOp, props: PdfDict | undefined, target: PdfRef): boolean {
  const tag = op.operands[0];
  if (!isName(tag) || tag.name !== 'OC') return false;
  const p = op.operands[1];
  const oc = isName(p) && props ? props.get(p.name) : p;
  return refMatchesLayer(doc, oc, target);
}

/** A single optional-content group (layer): a live handle over its /OCG dict. */
export class Layer {
  constructor(
    private readonly doc: Document,
    readonly Ref: PdfRef,
    readonly Dict: PdfDict,
    private readonly oc: OptionalContent,
  ) {}

  get Name(): string { return textOf(this.doc, this.Dict.get('Name')) ?? ''; }
  set Name(v: string) { this.Dict.set('Name', pdfText(v)); this.doc.markModified(); }

  get Intent(): string[] {
    const i = this.doc.resolve(this.Dict.get('Intent'));
    if (isName(i)) return [i.name];
    if (isArray(i)) return i.filter(isName).map((n) => n.name);
    return ['View'];
  }

  get Visible(): boolean { return this.oc.Default.IsVisible(this); }
  set Visible(v: boolean) { this.oc.Default.SetVisible(this, v); }

  /** What this group's `/Usage` says about viewing, printing and exporting
   *  it, or undefined when it states nothing.
   *
   *  A statement, not a state: only a configuration's `/AS` turns one into a
   *  visibility — see {@link LayerConfig.ResolveForEvent}. */
  get Usage(): LayerUsage | undefined {
    const u = this.doc.resolve(this.Dict.get('Usage'));
    return isDict(u) ? readUsage((o) => this.doc.resolve(o), u) : undefined;
  }

  /** Write this group's `/Usage` **and** the default configuration's `/AS`
   *  entry that applies it — writing one without the other says nothing.
   *  Delegates to {@link LayerConfig.SetUsage}, as `Visible` delegates to
   *  `SetVisible`; use that directly to write into a named configuration. */
  SetUsage(usage: LayerUsage): void { this.oc.Default.SetUsage(this, usage); }
}

/** One layer's resolved state, as {@link LayerConfig.ResolveForEvent} reports it. */
export interface LayerState {
  layer: Layer;
  visible: boolean;
}

/** One `/AS` usage application dictionary, as read from a configuration. */
interface UsageApplication {
  event: UsageEvent;
  categories: string[];
  /** The `/OCGs` refs, in the order the entry lists them — the scope
   *  `/Language /Preferred` is decided over. */
  ocgs: PdfRef[];
}

/** A viewing configuration (/D or a /Configs entry). */
export class LayerConfig {
  constructor(
    protected readonly doc: Document,
    readonly Dict: PdfDict,
    protected readonly oc: OptionalContent,
  ) {}

  get BaseState(): 'ON' | 'OFF' {
    const b = this.doc.resolve(this.Dict.get('BaseState'));
    return isName(b) && b.name === 'OFF' ? 'OFF' : 'ON';
  }
  set BaseState(v: 'ON' | 'OFF') { this.Dict.set('BaseState', name(v)); this.doc.markModified(); }

  /** @internal Visibility of a single OCG ref under this config. */
  private isRefVisible(ref: PdfRef): boolean {
    if (arrayOf(this.doc, this.Dict.get('ON')).some((r) => sameRef(r, ref))) return true;
    if (arrayOf(this.doc, this.Dict.get('OFF')).some((r) => sameRef(r, ref))) return false;
    return this.BaseState === 'ON';
  }

  IsVisible(layer: Layer): boolean {
    return this.isRefVisible(layer.Ref);
  }

  /** @internal Evaluate a /VE expression tree under this config. Malformed input
   *  (unknown operator, /Not with != 1 operand, empty) -> true. */
  private evaluateVE(ve: PdfObject | undefined): boolean {
    const a = this.doc.resolve(ve);
    if (!isArray(a) || a.length === 0) return true;
    const op = this.doc.resolve(a[0]);
    const opName = isName(op) ? op.name : '';
    const operands = a.slice(1);
    const evalOperand = (o: PdfObject): boolean => {
      if (isArray(this.doc.resolve(o))) return this.evaluateVE(o);
      if (isRef(o)) return this.isRefVisible(o);
      return true;
    };
    if (opName === 'Not') return operands.length === 1 ? !evalOperand(operands[0]) : true;
    if (opName === 'And') return operands.every(evalOperand);
    if (opName === 'Or') return operands.some(evalOperand);
    return true;
  }

  /** @internal Apply an OCMD /P policy over its /OCGs members. */
  private evaluatePolicy(ocmd: PdfDict): boolean {
    const members = arrayOf(this.doc, ocmd.get('OCGs'))
      .filter(isRef)
      .map((r) => this.isRefVisible(r));
    const p = this.doc.resolve(ocmd.get('P'));
    const policy = isName(p) ? p.name : 'AnyOn';
    switch (policy) {
      case 'AllOn':  return members.every((v) => v);
      case 'AnyOff': return members.some((v) => !v);
      case 'AllOff': return members.every((v) => !v);
      case 'AnyOn':
      default:       return members.some((v) => v);
    }
  }

  /** Resolve the visibility of any /OC value under this config: an OCG (its
   *  ON/OFF/BaseState state), or an OCMD (via /VE when present, else its /P
   *  policy over /OCGs). Undefined or non-OC values are visible. */
  ResolveVisibility(oc: PdfObject | undefined): boolean {
    const d = this.doc.resolve(oc);
    if (!isDict(d)) return true; // undefined / non-dict: unconditionally visible
    const t = this.doc.resolve(d.get('Type'));
    const type = isName(t) ? t.name : '';
    if (type === 'OCMD') {
      if (d.get('VE') !== undefined) return this.evaluateVE(d.get('VE'));
      return this.evaluatePolicy(d);
    }
    // /Type /OCG (or an untyped OC dict): resolve by ref state, else BaseState
    return isRef(oc) ? this.isRefVisible(oc) : (this.BaseState === 'ON');
  }

  SetVisible(layer: Layer, v: boolean): void {
    this.removeFrom('ON', layer.Ref);
    this.removeFrom('OFF', layer.Ref);
    this.addTo(v ? 'ON' : 'OFF', layer.Ref);
    this.doc.markModified();
  }

  /** @internal This config's `/AS` entries, damaged ones dropped — an entry
   *  that cannot be read applies to nothing, so it costs itself and never the
   *  configuration.
   *
   *  Only the `/Event` test is load-bearing: without it a `null` event is
   *  dereferenced, and a name outside the three would be compared against
   *  `event` as though it were one.
   *
   *  **Note, measured, and the two emptiness guards cover NOTHING — the
   *  obvious reading is wrong.** An entry left with no groups, or with no
   *  categories, provably cannot change an answer: `ResolveForEvent` maps
   *  over `ocgs` and accumulates per group, so an empty `ocgs` contributes to
   *  nobody, and `combineUsageStates([])` is `undefined`, which is exactly
   *  "this entry said nothing". Dropping both `continue`s reddens not one
   *  case. They stay as the honest spelling of "an entry naming nothing
   *  applies to nothing"; do not cite the damaged-`/AS` cases in
   *  `test/optional-content-usage.test.ts` as covering them. */
  private usageApplications(): UsageApplication[] {
    const out: UsageApplication[] = [];
    for (const e of arrayOf(this.doc, this.Dict.get('AS'))) {
      const d = resolveDict(this.doc, e);
      if (!d) continue;
      const ev = this.doc.resolve(d.get('Event'));
      if (!isName(ev) || (ev.name !== 'View' && ev.name !== 'Print' && ev.name !== 'Export')) continue;
      const ocgs = arrayOf(this.doc, d.get('OCGs')).filter(isRef);
      if (ocgs.length === 0) continue;
      const categories = arrayOf(this.doc, d.get('Category'))
        .map((c) => this.doc.resolve(c))
        .filter(isName)
        .map((c) => c.name);
      if (categories.length === 0) continue;
      out.push({ event: ev.name as UsageEvent, categories, ocgs });
    }
    return out;
  }

  /** @internal The typed `/Usage` of the group `r` names, or undefined. */
  private usageOf(r: PdfRef): LayerUsage | undefined {
    const g = this.doc.resolve(r);
    if (!isDict(g)) return undefined;
    const u = this.doc.resolve(g.get('Usage'));
    return isDict(u) ? readUsage((o) => this.doc.resolve(o), u) : undefined;
  }

  /**
   * Every layer's state for `event`, **changing nothing** — this config's
   * `/ON`/`/OFF`/`BaseState` as the starting point, with each `/AS` usage
   * application dictionary whose `/Event` matches allowed to move the groups
   * it names (PDF 32000-1 8.11.4.4).
   *
   * A group no matching `/AS` entry names comes back at its configured state,
   * whatever its `/Usage` says — `/Usage` alone is inert. Several categories,
   * and several entries, combine so that **any one saying OFF wins**.
   *
   * `/Zoom` and `/Language` describe a viewer, so they stay silent unless
   * `ctx` supplies a magnification or a BCP 47 language tag rather than being
   * decided against an invented one. `/User` is never evaluated: it names a
   * person or organisation, and this library has no viewer identity.
   */
  ResolveForEvent(event: UsageEvent, ctx: UsageContext = {}): LayerState[] {
    const layers = this.oc.Layers;
    const stated = layers.map<(boolean | undefined)[]>(() => []);

    for (const app of this.usageApplications()) {
      if (app.event !== event) continue;
      // The whole entry at once: /Language /Preferred is scoped to it, so a
      // group cannot be resolved on its own.
      const states = applyUsageEntry(
        app.ocgs.map((r) => this.usageOf(r)),
        app.categories,
        ctx,
      );
      app.ocgs.forEach((r, i) => {
        const at = layers.findIndex((l) => sameRef(r, l.Ref));
        if (at >= 0) stated[at].push(states[i]);
      });
    }

    return layers.map((layer, i) => ({
      layer,
      visible: combineUsageStates(stated[i]) ?? this.isRefVisible(layer.Ref),
    }));
  }

  /**
   * Resolve `event` and make the result this configuration's own state,
   * returning only the layers whose state actually moved.
   *
   * The `/AS` entries are left in place: they say what the document intends,
   * and a second `ApplyUsage` for another event must still be able to reach
   * them. Discarding what the configuration does not show is `FlattenLayers`.
   */
  ApplyUsage(event: UsageEvent, ctx: UsageContext = {}): Layer[] {
    const moved: Layer[] = [];
    for (const s of this.ResolveForEvent(event, ctx)) {
      if (this.IsVisible(s.layer) === s.visible) continue;
      this.SetVisible(s.layer, s.visible);
      moved.push(s.layer);
    }
    return moved;
  }

  /**
   * Write `layer`'s `/Usage` **and** the `/AS` entries of this configuration
   * that apply it. Writing one without the other says nothing: a `/Usage`
   * no `/AS` entry reaches is inert, and an `/AS` entry naming a category the
   * group does not carry moves nothing.
   *
   * One entry per (event, category) pair, so a second group asking for the
   * same thing joins the entry that already exists rather than appending a
   * duplicate. `/Usage` is replaced wholesale, so `layer` is first dropped
   * from every entry here — a category the new usage no longer states stops
   * being applied, and an entry left naming no group is removed.
   *
   * Only the categories this library turns into a state get an entry:
   * `/View`, `/Zoom` and `/Language` on the View event, `/Print` on Print and
   * `/Export` on Export. `/CreatorInfo`, `/PageElement` and `/User` are
   * written into `/Usage` and reach no `/AS`, the first two because they
   * carry no state at all and `/User` because there is no viewer identity to
   * match it against.
   */
  SetUsage(layer: Layer, usage: LayerUsage): void {
    const dict = writeUsage(usage);
    layer.Dict.set('Usage', dict);

    // Drop this group from every entry first, so a rewrite that no longer
    // states a category stops applying it.
    const entries: PdfDict[] = [];
    for (const e of arrayOf(this.doc, this.Dict.get('AS'))) {
      const d = resolveDict(this.doc, e);
      if (!d) continue;
      const ocgs = arrayOf(this.doc, d.get('OCGs')).filter((r) => !sameRef(r, layer.Ref));
      if (ocgs.length === 0) continue; // the entry named this group alone
      d.set('OCGs', ocgs);
      entries.push(d);
    }

    for (const category of dict.keys()) {
      const event = usageCategoryEvent(category);
      if (event === undefined) continue;
      let entry = entries.find((d) => {
        const ev = this.doc.resolve(d.get('Event'));
        const cats = arrayOf(this.doc, d.get('Category'));
        return isName(ev) && ev.name === event
          && cats.length === 1 && sameName(this.doc, cats[0], category);
      });
      if (!entry) {
        entry = new Map<string, PdfObject>([
          ['Event', name(event)],
          ['Category', [name(category)]],
          ['OCGs', []],
        ]);
        entries.push(entry);
      }
      entry.set('OCGs', [...arrayOf(this.doc, entry.get('OCGs')), layer.Ref]);
    }

    if (entries.length === 0) this.Dict.delete('AS');
    else this.Dict.set('AS', entries);
    this.doc.markModified();
  }

  get Name(): string | undefined { return textOf(this.doc, this.Dict.get('Name')); }
  set Name(v: string) { this.Dict.set('Name', pdfText(v)); this.doc.markModified(); }

  get Creator(): string | undefined { return textOf(this.doc, this.Dict.get('Creator')); }

  get Locked(): Layer[] {
    const out: Layer[] = [];
    for (const r of arrayOf(this.doc, this.Dict.get('Locked'))) {
      const l = this.oc.layerForRef(r);
      if (l) out.push(l);
    }
    return out;
  }

  SetLocked(layer: Layer, v: boolean): void {
    if (v) this.addTo('Locked', layer.Ref);
    else this.removeFrom('Locked', layer.Ref);
    this.doc.markModified();
  }

  /** @internal Drop a ref from a config array (leaving the array present). */
  protected removeFrom(key: string, r: PdfRef): void {
    const existing = this.doc.resolve(this.Dict.get(key));
    if (!isArray(existing)) return;
    this.Dict.set(key, existing.filter((e) => !sameRef(e, r)));
  }

  /** @internal Append a ref to a config array, creating it when absent. */
  protected addTo(key: string, r: PdfRef): void {
    const existing = this.doc.resolve(this.Dict.get(key));
    const arr = isArray(existing) ? [...existing] : [];
    if (!arr.some((e) => sameRef(e, r))) arr.push(r);
    this.Dict.set(key, arr);
  }
}

/** Options for {@link OptionalContent.AddLayer}. */
export interface AddLayerOptions {
  /** Nest the new layer under this one in /D /Order. Default: top level. */
  parent?: Layer;
  /** Default-config visibility. Default: true. */
  visible?: boolean;
  /** /Intent name(s). Default: 'View' (implicit when /Intent absent). */
  intent?: string | string[];
}

/** The document's optional-content properties (/OCProperties). */
export class OptionalContent {
  constructor(private readonly doc: Document) {}

  private ocProps(): PdfDict | undefined {
    return resolveDict(this.doc, this.doc.catalog().get('OCProperties'));
  }

  /** Create /OCProperties (with an empty /OCGs and /D) when absent. */
  private ensureOcProps(): PdfDict {
    let p = this.ocProps();
    if (!p) {
      p = new Map<string, PdfObject>([
        ['OCGs', []],
        ['D', new Map<string, PdfObject>([['Order', []]])],
      ]);
      this.doc.catalog().set('OCProperties', p);
      this.doc.markModified();
    }
    return p;
  }

  get Layers(): Layer[] {
    const p = this.ocProps();
    if (!p) return [];
    const out: Layer[] = [];
    for (const r of arrayOf(this.doc, p.get('OCGs'))) {
      if (!isRef(r)) continue;
      const d = this.doc.resolve(r);
      if (isDict(d)) out.push(new Layer(this.doc, r, d, this));
    }
    return out;
  }

  GetLayer(name: string): Layer | undefined {
    return this.Layers.find((l) => l.Name === name);
  }

  /** @internal Map an OCG ref back to a Layer handle. */
  layerForRef(r: PdfObject | undefined): Layer | undefined {
    if (!isRef(r)) return undefined;
    return this.Layers.find((l) => sameRef(r, l.Ref));
  }

  /**
   * The default configuration if the document HAS one, without creating
   * anything — the read-only twin of `Default`.
   *
   * **This exists because `Default` MUTATES.** It goes through
   * `ensureOcProps`, which writes `/OCProperties` into the catalog and calls
   * `markModified()`, so a renderer asking "is this layer visible" through it
   * would modify every document it draws. That is not cosmetic: `choosePath()`
   * takes the incremental append only for an UNMODIFIED base, so a `ToImage()`
   * before a `Sign()` would silently turn the signature into a full rewrite of
   * bytes an earlier signature covered — `pagemode.ts` records the same hazard
   * for a no-op delete. A document with no `/OCProperties` answers `undefined`
   * and its caller then treats every section as visible.
   */
  defaultConfigIfPresent(): LayerConfig | undefined {
    const p = this.ocProps();
    if (!p) return undefined;
    const d = resolveDict(this.doc, p.get('D'));
    return d ? new LayerConfig(this.doc, d, this) : undefined;
  }

  get Default(): LayerConfig {
    const p = this.ensureOcProps();
    let d = resolveDict(this.doc, p.get('D'));
    if (!d) { d = new Map(); p.set('D', d); this.doc.markModified(); }
    return new LayerConfig(this.doc, d, this);
  }

  get Configs(): LayerConfig[] {
    const p = this.ocProps();
    if (!p) return [];
    const out: LayerConfig[] = [];
    for (const e of arrayOf(this.doc, p.get('Configs'))) {
      const d = resolveDict(this.doc, e);
      if (d) out.push(new LayerConfig(this.doc, d, this));
    }
    return out;
  }

  GetConfig(name: string): LayerConfig | undefined {
    return this.Configs.find((c) => c.Name === name);
  }

  AddConfig(name: string): LayerConfig {
    const p = this.ensureOcProps();
    const existing = this.doc.resolve(p.get('Configs'));
    const arr = isArray(existing) ? [...existing] : [];
    const dict: PdfDict = new Map();
    dict.set('Name', pdfText(name));
    arr.push(this.doc.allocObject(dict));
    p.set('Configs', arr);
    this.doc.markModified();
    return new LayerConfig(this.doc, dict, this);
  }

  /**
   * Adopt `cfg` as the document's current state, copying its
   * `/BaseState`, `/ON`, `/OFF`, `/Order`, `/Locked`, `/AS`, `/RBGroups`,
   * `/Intent` and `/ListMode` into `/D`. The preset itself is untouched and
   * stays in `/Configs` to be chosen again.
   *
   * **A WRITE into `/D`, deliberately, rather than an in-memory selection.**
   * This library has one notion of "the current state" and `/D` is it — the
   * one rendering, extraction, `ApplyUsage` and every export all read — so a
   * configuration that were merely *selected* would be a second answer to the
   * same question. It follows that `/D`'s previous state is overwritten:
   * {@link SaveConfiguration} is how a caller keeps it.
   *
   * `/D`'s own `/Name` and `/Creator` survive, since they identify the
   * default configuration rather than describe its state.
   */
  ApplyConfiguration(cfg: LayerConfig): void {
    const dst = this.Default.Dict;
    if (dst === cfg.Dict) return; // applying /D to itself changes nothing
    copyConfigState(this.doc, cfg.Dict, dst);
    this.doc.markModified();
  }

  /**
   * Snapshot the current `/D` as a named preset in `/Configs` and return it.
   *
   * The counterpart to {@link ApplyConfiguration}, which overwrites `/D`. It
   * is a SNAPSHOT: later edits to `/D` do not reach it, because every
   * container is cloned rather than shared (see `cloneConfigValue`).
   *
   * Names are not unique, exactly as {@link AddConfig} leaves them — a caller
   * wanting overwrite semantics removes the old preset first.
   */
  SaveConfiguration(name: string): LayerConfig {
    // Reading /D first is only how it reads: `AddConfig` touches /Configs and
    // never /D, and both it and `Default` reach the same dict through
    // `ensureOcProps`, so the two orders are provably equivalent — measured,
    // swapping them reddens nothing. Not a rule; do not write one.
    const src = this.Default.Dict;      // creates /OCProperties and /D if absent
    const cfg = this.AddConfig(name);
    copyConfigState(this.doc, src, cfg.Dict);
    this.doc.markModified();
    return cfg;
  }

  RemoveConfig(cfg: LayerConfig): void {
    const p = this.ocProps();
    if (!p) return;
    const existing = this.doc.resolve(p.get('Configs'));
    if (!isArray(existing)) return;
    p.set('Configs', existing.filter((e) => resolveDict(this.doc, e) !== cfg.Dict));
    this.doc.markModified();
  }

  AddLayer(layerName: string, opts: AddLayerOptions = {}): Layer {
    const p = this.ensureOcProps();
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('OCG')],
      ['Name', pdfText(layerName)],
    ]);
    if (opts.intent !== undefined) {
      dict.set('Intent', Array.isArray(opts.intent)
        ? opts.intent.map((i) => name(i))
        : name(opts.intent));
    }
    const ref = this.doc.allocObject(dict);

    // /OCGs — authoritative list
    p.set('OCGs', [...arrayOf(this.doc, p.get('OCGs')), ref]);

    // /D /Order — panel tree
    const d = this.Default.Dict; // creates /D if absent
    const order = deepCopyOrder(arrayOf(this.doc, d.get('Order')));
    if (!(opts.parent && placeUnder(order, opts.parent.Ref, ref))) order.push(ref);
    d.set('Order', order);

    const layer = new Layer(this.doc, ref, dict, this);
    if (opts.visible === false) this.Default.SetVisible(layer, false);
    this.doc.markModified();
    return layer;
  }

  RemoveLayer(layer: Layer): void {
    const p = this.ocProps();
    if (!p) return;
    const target = layer.Ref;

    // 1. /OCGs
    p.set('OCGs', removeRefDeep(arrayOf(this.doc, p.get('OCGs')), target));

    // 1b. every config dict (/D and each /Configs entry)
    const configDicts: PdfDict[] = [];
    const dDict = resolveDict(this.doc, p.get('D'));
    if (dDict) configDicts.push(dDict);
    for (const e of arrayOf(this.doc, p.get('Configs'))) {
      const cd = resolveDict(this.doc, e);
      if (cd) configDicts.push(cd);
    }
    for (const cd of configDicts) {
      for (const key of ['ON', 'OFF', 'Order', 'Locked', 'RBGroups']) {
        const a = this.doc.resolve(cd.get(key));
        if (isArray(a)) cd.set(key, removeRefDeep(a, target));
      }
    }

    // 2. annotations, per page
    for (const page of this.doc.Pages) {
      const annots = this.doc.resolve(page.Dict.get('Annots'));
      if (isArray(annots)) {
        const kept = annots.filter((a) => {
          const ad = resolveDict(this.doc, a);
          return !(ad && refMatchesLayer(this.doc, ad.get('OC'), target));
        });
        if (kept.length !== annots.length) page.Dict.set('Annots', kept);
      }
    }

    // 3./4. Excise the layer from content. First find XObjects whose own /OC
    //   binds them entirely to the layer (case A). Then, per page: strip /OC
    //   blocks (and case-A `Do` ops) from /Contents, and recurse the same into
    //   Form/Image XObjects (clearing OCMD /OC bindings, recording `Do`s inside
    //   excised blocks as removal candidates).
    const ex: Excision = { target, caseA: new Set(), unlinked: new Set() };
    {
      const seen = new Set<number>();
      for (const page of this.doc.Pages) {
        collectDirectlyBoundXObjects(this.doc, page.Resources, target, ex.caseA, seen);
      }
    }
    const visited = new Set<number>();
    for (const page of this.doc.Pages) {
      stripLayerContent(this.doc, page, ex);
      stripLayerFromXObjects(this.doc, page.Resources, ex, visited);
    }

    // 4b. Remove XObjects used only by the deleted layer: those bound by /OC
    //   (case A) and those whose only invocation sat inside an excised block and
    //   are no longer invoked anywhere. Drop their objects and resource entries;
    //   Save()'s mark-sweep reclaims anything they transitively orphaned.
    const invoked = collectInvokedXObjects(this.doc);
    const removed = new Set<number>(ex.caseA);
    for (const n of ex.unlinked) if (!invoked.has(n)) removed.add(n);
    if (removed.size) {
      const seen = new Set<number>();
      for (const page of this.doc.Pages) stripXObjectEntries(this.doc, page.Resources, removed, seen);
      for (const n of removed) this.doc.deleteObject(n);
    }

    // 5. prune the deleted layer out of surviving OCMDs (dropping any left with
    //    no members) and clean up dangling page /Properties entries.
    this.pruneProperties(target);

    this.doc.deleteObject(target.num);
    this.doc.markModified();
  }

  /** Prune `target` out of every page-referenced OCMD's /OCGs and /VE, then drop
   *  any page /Properties entry (on any page) that would be left dangling: one
   *  mapping to a now-empty OCMD, or one mapping straight to the deleted layer.
   *  Now-empty OCMD objects are deleted too. */
  private pruneProperties(target: PdfRef): void {
    const emptied = new Set<number>();
    for (const page of this.doc.Pages) {
      const props = resolveDict(this.doc, page.Resources?.get('Properties'));
      if (!props) continue;
      for (const [, v] of props) {
        if (!isRef(v)) continue;
        const ocmd = resolveDict(this.doc, v);
        if (!ocmd) continue;
        const t = this.doc.resolve(ocmd.get('Type'));
        if (!isName(t) || t.name !== 'OCMD') continue;
        // Only touch OCMDs that actually reference the deleted layer, so a
        // pre-existing degenerate (member-less) OCMD is never dropped here.
        if (!refMatchesLayer(this.doc, v, target)) continue;
        this.pruneOcmdMembership(ocmd, target);
        if (!ocmd.has('OCGs') && !ocmd.has('VE')) emptied.add(v.num);
      }
    }
    // Drop /Properties entries that would dangle through Save()'s renumber: ones
    // pointing at a now-empty OCMD, or straight at the deleted layer…
    for (const page of this.doc.Pages) {
      const props = resolveDict(this.doc, page.Resources?.get('Properties'));
      if (!props) continue;
      for (const [k, v] of [...props]) {
        if (isRef(v) && (sameRef(v, target) || emptied.has(v.num))) props.delete(k);
      }
    }
    // …then delete the now-empty OCMD objects themselves.
    for (const num of emptied) this.doc.deleteObject(num);
  }

  /** Remove `target` from a single OCMD dict's /OCGs (array or single ref) and
   *  /VE tree, deleting either key when it is left with no members. */
  private pruneOcmdMembership(ocmd: PdfDict, target: PdfRef): void {
    const ocgs = ocmd.get('OCGs');
    const resolved = this.doc.resolve(ocgs);
    if (isArray(resolved)) {
      const kept = resolved.filter((e) => !sameRef(e, target));
      if (kept.length) ocmd.set('OCGs', kept);
      else ocmd.delete('OCGs');
    } else if (sameRef(ocgs, target)) {
      ocmd.delete('OCGs');
    }
    if (ocmd.has('VE')) {
      const ve = pruneVE(this.doc, ocmd.get('VE'), target);
      if (ve === undefined) ocmd.delete('VE');
      else ocmd.set('VE', ve);
    }
  }
}
