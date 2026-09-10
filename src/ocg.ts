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
