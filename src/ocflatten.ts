// Flatten optional content: keep only what the configuration SHOWS, then take
// the vocabulary away (`q1g2.6`, `doc.FlattenLayers()`).
//
// Hidden marked-content spans are DELETED from the content streams they sit in
// rather than merely unreferenced, hidden XObject draws and hidden annotations
// go with them, every surviving `/OC` wrapper and `/OC` key is removed, and
// `/OCProperties` is deleted — leaving an ordinary PDF that renders exactly as
// the configuration rendered and from which a reader cannot get the hidden
// content back.
//
// **Note the direction against `ocg.ts`'s `RemoveLayer`**, whose excision looks
// the same and is not: that one takes ONE layer's content out and leaves the
// optional-content machinery standing, so a document keeps its other layers and
// their toggles. This takes the MACHINERY out and leaves one rendering behind.
//
// **Invariant:** `flattenOcOps` is PURE — `types.js` and `content.js` for the op
// model, the two visibility questions as CALLBACKS (the `colorimage.ts` seam) —
// so every rewriting rule is drivable from hand-built op lists with no PDF
// built and no configuration resolved. It never throws.
//
// **Note, measured, and it is the finding worth carrying:** the FIVE nested
// content scopes each needed a fixture built for them, and until they existed
// excluding any one of form XObjects, tiling patterns, Type 3 glyph
// procedures, soft-mask groups or annotation appearances from the walk was
// GREEN. Every fixture in this epic before `q1g2.6` marks content in the PAGE
// stream alone, so a page-content walk satisfies all of them — and the scope
// it misses fails in the WORST direction: `/OCProperties` goes, the section is
// left standing, and the ink the document hid becomes unconditionally visible.
// `build-ocg-render-pdf.ts` gives each scope its own `/Properties` under keys
// the PAGE does not carry, so a walk that reached the stream but resolved its
// operands against the page's resources cannot pass by accident.
//
// **Note, measured, and it covers NOTHING:** deduping scopes by object number
// is a COST rule rather than a correctness one, and removing it reddens not
// one case. A form reached from two pages would simply be walked twice, and
// the second pass finds no `/OC` left to act on, reports `changed: false` and
// writes nothing — so the rewrite is idempotent by construction. It stays
// because a large document should not re-parse a shared form once per referrer.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, PdfRef, PdfStream, isArray, isDict, isName, isRef, isStream }
  from './types.js';
import { ContentOp, parseContentStream, serializeContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { ocVisibilityFor, ocVisible } from './ocvisible.js';
import { hasSignatureField } from './signature.js';
import { UnsupportedFeatureError } from './errors.js';

/** What {@link Document.FlattenLayers} did. */
export interface FlattenLayersReport {
  /** Pages whose content, annotations or resources changed.
   *
   *  A page counts when anything it reaches changed — its own content, a form
   *  XObject, a tiling pattern, a Type 3 glyph procedure, a soft-mask group or
   *  an annotation appearance — so a form shared by two pages marks both, even
   *  though it is rewritten once. */
  pagesChanged: number;
  /** Marked-content spans deleted because the configuration hid them. */
  hiddenSections: number;
  /** Visible `/OC` marked-content wrappers removed with their content kept. */
  unwrappedSections: number;
  /** `Do` operators dropped because the XObject's own `/OC` was hidden. */
  hiddenDraws: number;
  /** XObjects removed outright: their `/OC` was hidden, or every invocation of
   *  them sat inside a deleted span and nothing else draws them. */
  removedXObjects: number;
  /** Annotations removed because their `/OC` was hidden. */
  hiddenAnnotations: number;
  /** `/OC` marked-content operands LEFT EXACTLY AS WRITTEN because they could
   *  not be resolved — an inline dictionary, or a name no `/Properties` entry
   *  claims. Their content survives; see {@link Document.FlattenLayers}. */
  unresolved: number;
}

function emptyReport(): FlattenLayersReport {
  return {
    pagesChanged: 0, hiddenSections: 0, unwrappedSections: 0, hiddenDraws: 0,
    removedXObjects: 0, hiddenAnnotations: 0, unresolved: 0,
  };
}

// ---------------------------------------------------------------------------
// The pure half: rewriting one group of content streams.
// ---------------------------------------------------------------------------

/** What the two visibility questions answer, supplied by the caller. */
export interface OcFlattenOptions {
  /** The scope's resolved `/Resources /Properties`, where a BDC's name operand
   *  is looked up. */
  readonly properties: PdfDict | undefined;
  /** Is this raw (UNRESOLVED) `/Properties` value a group the configuration
   *  hides? */
  hidden(raw: PdfObject): boolean;
  /** Is the XObject this `Do` names hidden by its own dictionary `/OC`? */
  hiddenXObject(name: string): boolean;
}

/** What {@link flattenOcOps} made of one group. */
export interface OcFlattenResult {
  /** The surviving ops, one list per input stream and in the same order. */
  readonly streams: ContentOp[][];
  /** Whether each stream lost anything. Ops are only ever REMOVED, never
   *  added, so this is a length comparison rather than a diff. */
  readonly changed: boolean[];
  readonly hiddenSections: number;
  readonly unwrappedSections: number;
  readonly hiddenDraws: number;
  /** XObject resource names a surviving `Do` still invokes. */
  readonly invoked: Set<string>;
  /** XObject resource names whose every `Do` here was removed. */
  readonly removedDraws: Set<string>;
  readonly unresolved: number;
}

/** One open marked-content section, by what the flatten made of it. */
type Frame = 'keep' | 'unwrap' | 'drop';

/**
 * Rewrite one GROUP of content streams that share a marked-content nesting
 * state: delete the spans the configuration hides, unwrap the `/OC` wrappers it
 * shows, and drop the `Do` of a hidden XObject.
 *
 * **Invariant: a GROUP, not a stream, and that is what a page's `/Contents`
 * ARRAY is.** 32000-1 7.8.2 makes the division between a page's content streams
 * arbitrary — the concatenation is interpreted as a single stream — so a `BDC`
 * in one and its `EMC` in the next is a legal page, and a per-stream walk would
 * delete to the end of the first stream and leave the rest of the span standing.
 * Every other scope (a form, a tiling pattern, a glyph procedure, a soft-mask
 * group, an appearance stream) is a group of one.
 *
 * **Note this is deliberately NOT `colorconvert.ts`'s per-stream walk**, and
 * the two must not be merged: a colour operator is local to the op that carries
 * it, so conversion is per STREAM, while an `/OC` section is a SPAN.
 *
 * **Invariant:** an `/OC` operand that is an inline DICTIONARY, or a name no
 * `/Properties` entry claims, is left EXACTLY AS WRITTEN — the wrapper as well
 * as its content. Hiding a section on a shape we did not resolve is the one
 * error that loses ink, and removing the wrapper would claim we had decided
 * about it. `ocvisible.ts` takes the same direction for rendering.
 */
export function flattenOcOps(
  streams: readonly (readonly ContentOp[])[], opts: OcFlattenOptions,
): OcFlattenResult {
  const out: ContentOp[][] = [];
  const changed: boolean[] = [];
  const invoked = new Set<string>();
  const removedDraws = new Set<string>();
  let hiddenSections = 0, unwrappedSections = 0, hiddenDraws = 0, unresolved = 0;

  // Shared ACROSS the group's streams, which is the whole point of the group.
  const stack: Frame[] = [];
  let dropping = 0;

  for (const ops of streams) {
    const kept: ContentOp[] = [];
    for (const op of ops) {
      if (op.operator === 'BDC' || op.operator === 'BMC') {
        let frame: Frame = 'keep';
        if (dropping === 0 && op.operator === 'BDC') {
          switch (classify(op, opts)) {
            case 'hidden': frame = 'drop'; hiddenSections++; break;
            case 'visible': frame = 'unwrap'; unwrappedSections++; break;
            case 'unresolved': unresolved++; break;
            default: break;
          }
        }
        stack.push(frame);
        if (frame === 'drop') dropping++;
        else if (dropping === 0 && frame === 'keep') kept.push(op);
        continue;
      }
      if (op.operator === 'EMC') {
        // An unbalanced EMC is tolerated — `ocvisible.ts`'s stack tolerates one
        // too — and closes nothing, so it survives as the document wrote it.
        const frame = stack.pop();
        if (frame === 'drop') { dropping--; continue; }
        if (dropping > 0) continue;
        if (frame === 'unwrap') continue;
        kept.push(op);
        continue;
      }
      const target = op.operator === 'Do' && isName(op.operands[0])
        ? (op.operands[0] as { name: string }).name : undefined;
      if (dropping > 0) {
        if (target !== undefined) removedDraws.add(target);
        continue;
      }
      if (target !== undefined && opts.hiddenXObject(target)) {
        removedDraws.add(target);
        hiddenDraws++;
        continue;
      }
      if (target !== undefined) invoked.add(target);
      kept.push(op);
    }
    out.push(kept);
    changed.push(kept.length !== ops.length);
  }

  return {
    streams: out, changed, hiddenSections, unwrappedSections, hiddenDraws,
    invoked, removedDraws, unresolved,
  };
}

/** What a `BDC` is, to the flatten. */
function classify(
  op: ContentOp, opts: OcFlattenOptions,
): 'none' | 'hidden' | 'visible' | 'unresolved' {
  const tag = op.operands[0];
  if (!isName(tag) || tag.name !== 'OC') return 'none';
  const p = op.operands[1];
  if (!isName(p)) return 'unresolved';          // an inline dictionary
  const raw = opts.properties?.get(p.name);
  if (raw === undefined) return 'unresolved';   // a name /Properties does not claim
  return opts.hidden(raw) ? 'hidden' : 'visible';
}

// ---------------------------------------------------------------------------
// The document half.
// ---------------------------------------------------------------------------

/** Guard against a resource graph that points back at itself. */
const MAX_DEPTH = 32;

/** One set of streams sharing a marked-content nesting state, plus the
 *  resources their names resolve against. */
interface ScopeGroup {
  readonly objNums: number[];
  readonly streams: PdfStream[];
  readonly resources: PdfDict | undefined;
}

function dictOf(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const d = doc.resolve(o);
  return isDict(d) ? d : undefined;
}

function nameOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const n = doc.resolve(o);
  return isName(n) ? n.name : undefined;
}

/**
 * Every content-bearing scope this page reaches, each as a group.
 *
 * The page's own `/Contents` is ONE group; a form XObject, a tiling pattern, a
 * Type 3 glyph procedure, a soft-mask group and an annotation appearance are
 * each a group of one. `seen` dedupes by OBJECT NUMBER across the whole
 * document, because visibility is a property of the configuration rather than
 * of the page — so unlike redaction, a form reached from two pages is rewritten
 * ONCE and both pages report the change.
 */
function pageScopes(
  doc: Document, page: Page, seen: Set<number>, resourceDicts: Set<PdfDict>,
): { groups: ScopeGroup[]; touched: number[] } {
  const groups: ScopeGroup[] = [];
  const touched: number[] = [];

  const streamOfRef = (o: PdfObject | undefined): { num: number; s: PdfStream } | undefined => {
    const s = doc.resolve(o);
    if (!isStream(s) || !isRef(o)) return undefined;
    return { num: o.num, s };
  };

  const addOne = (o: PdfObject | undefined, inherited: PdfDict | undefined, depth: number): void => {
    const hit = streamOfRef(o);
    if (!hit || depth > MAX_DEPTH) return;
    touched.push(hit.num);
    if (seen.has(hit.num)) return;
    seen.add(hit.num);
    const own = dictOf(doc, hit.s.dict.get('Resources')) ?? inherited;
    groups.push({ objNums: [hit.num], streams: [hit.s], resources: own });
    walkResources(own, depth + 1);
  };

  const walkResources = (resources: PdfDict | undefined, depth: number): void => {
    if (!resources || depth > MAX_DEPTH) return;
    resourceDicts.add(resources);

    const xo = dictOf(doc, resources.get('XObject'));
    if (xo) {
      for (const [, v] of xo) {
        const s = doc.resolve(v);
        if (isStream(s) && nameOf(doc, s.dict.get('Subtype')) === 'Form')
          addOne(v, resources, depth);
      }
    }
    const pat = dictOf(doc, resources.get('Pattern'));
    if (pat) {
      for (const [, v] of pat) {
        const s = doc.resolve(v);
        if (isStream(s) && doc.resolve(s.dict.get('PatternType')) === 1)
          addOne(v, resources, depth);
      }
    }
    const fonts = dictOf(doc, resources.get('Font'));
    if (fonts) {
      for (const [, v] of fonts) {
        const f = dictOf(doc, v);
        const procs = f ? dictOf(doc, f.get('CharProcs')) : undefined;
        if (!procs) continue;
        const fontRes = f ? dictOf(doc, f.get('Resources')) : undefined;
        for (const [, p] of procs) addOne(p, fontRes ?? resources, depth);
      }
    }
    const gs = dictOf(doc, resources.get('ExtGState'));
    if (gs) {
      for (const [, v] of gs) {
        const g = dictOf(doc, v);
        const sm = g ? dictOf(doc, g.get('SMask')) : undefined;
        if (sm) addOne(sm.get('G'), resources, depth);
      }
    }
  };

  const resources = page.Resources;

  // The page's own content: ONE group, however many streams /Contents lists.
  const contents = doc.resolve(page.Dict.get('Contents'));
  const entries = isArray(contents) ? contents : [page.Dict.get('Contents')];
  const objNums: number[] = [];
  const streams: PdfStream[] = [];
  for (const e of entries) {
    const hit = streamOfRef(e);
    if (!hit) continue;
    touched.push(hit.num);
    if (seen.has(hit.num)) continue;
    seen.add(hit.num);
    objNums.push(hit.num);
    streams.push(hit.s);
  }
  if (streams.length) groups.push({ objNums, streams, resources });
  walkResources(resources, 0);

  const annots = doc.resolve(page.Dict.get('Annots'));
  if (isArray(annots)) {
    for (const a of annots) {
      const ap = dictOf(doc, dictOf(doc, a)?.get('AP'));
      if (!ap) continue;
      for (const key of ['N', 'R', 'D']) {
        const entry = ap.get(key);
        const r = doc.resolve(entry);
        if (isStream(r)) addOne(entry, resources, 0);
        else if (isDict(r)) for (const [, st] of r) addOne(st, resources, 0);
      }
    }
  }

  return { groups, touched };
}

/**
 * Flatten the document's optional content against its default configuration.
 *
 * See {@link FlattenLayersReport} and `Document.FlattenLayers` for the contract.
 */
export function flattenLayers(doc: Document): FlattenLayersReport {
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'FlattenLayers: the document is signed; deleting hidden content would '
      + 'invalidate the signature',
    );
  }
  const report = emptyReport();
  // A document with no /OCProperties has no optional content to flatten, and
  // nothing here may create one — `ocvisible.ts` records why reaching for a
  // configuration through `Default` modifies every document it touches.
  if (doc.catalog().get('OCProperties') === undefined) return report;
  const oc = ocVisibilityFor(doc);

  const hidden = (raw: PdfObject): boolean => !ocVisible(oc, raw);

  // Pass 1 — the XObjects. A dictionary `/OC` binds the WHOLE XObject, so a
  // hidden one loses every `Do` and its resource entries, while a visible one
  // merely loses the key. Done first because the content rewrite asks about it.
  const seen = new Set<number>();
  const resourceDicts = new Set<PdfDict>();
  const pageGroups: { page: Page; groups: ScopeGroup[]; touched: number[] }[] = [];
  for (const page of doc.Pages) {
    const { groups, touched } = pageScopes(doc, page, seen, resourceDicts);
    pageGroups.push({ page, groups, touched });
  }

  const hiddenXo = new Set<number>();
  for (const resources of resourceDicts) {
    const xo = dictOf(doc, resources.get('XObject'));
    if (!xo) continue;
    for (const [, v] of xo) {
      const s = doc.resolve(v);
      if (!isStream(s)) continue;
      const ocKey = s.dict.get('OC');
      if (ocKey === undefined) continue;
      if (hidden(ocKey)) { if (isRef(v)) hiddenXo.add(v.num); }
      else s.dict.delete('OC');
    }
  }

  // Pass 2 — the content. Each scope is rewritten once, by object number.
  const changedObjs = new Set<number>();
  const invokedRefs = new Set<number>();
  const droppedRefs = new Set<number>();
  for (const { groups } of pageGroups) {
    for (const group of groups) {
      const xobjs = dictOf(doc, group.resources?.get('XObject'));
      const refFor = (nm: string): PdfRef | undefined => {
        const v = xobjs?.get(nm);
        return isRef(v) ? v : undefined;
      };
      let parsed: ContentOp[][];
      try {
        parsed = group.streams.map((s) => parseContentStream(inflateStream(s)));
      } catch {
        continue;   // a stream we cannot read is one we must not rewrite
      }
      const r = flattenOcOps(parsed, {
        properties: dictOf(doc, group.resources?.get('Properties')),
        hidden,
        hiddenXObject: (nm) => { const ref = refFor(nm); return !!ref && hiddenXo.has(ref.num); },
      });
      report.hiddenSections += r.hiddenSections;
      report.unwrappedSections += r.unwrappedSections;
      report.hiddenDraws += r.hiddenDraws;
      report.unresolved += r.unresolved;
      for (const nm of r.invoked) { const ref = refFor(nm); if (ref) invokedRefs.add(ref.num); }
      for (const nm of r.removedDraws) { const ref = refFor(nm); if (ref) droppedRefs.add(ref.num); }
      for (let i = 0; i < group.streams.length; i++) {
        if (!r.changed[i]) continue;
        changedObjs.add(group.objNums[i]);
        rewriteStream(doc, group.objNums[i], group.streams[i], r.streams[i]);
      }
    }
  }

  // Pass 3 — the annotations, and the pages' own tally.
  for (const { page, touched } of pageGroups) {
    let pageChanged = touched.some((n) => changedObjs.has(n));
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (isArray(annots)) {
      for (const a of [...annots]) {
        const ad = dictOf(doc, a);
        const ocKey = ad?.get('OC');
        if (!ad || ocKey === undefined) continue;
        if (hidden(ocKey)) {
          // Through `RemoveAnnotation`, never a raw /Annots splice: that is what
          // calls `untagObjects`, and a tagged annotation is also named by an
          // /OBJR reachable from /Root, which would keep it in the saved bytes.
          page.RemoveAnnotation(ad);
          report.hiddenAnnotations++;
        } else {
          ad.delete('OC');
        }
        pageChanged = true;
      }
    }
    if (pageChanged) report.pagesChanged++;
  }

  // Pass 4 — the resource entries. An XObject the flatten hid, or one whose
  // every invocation sat inside a deleted span and which nothing else draws,
  // must lose its /Resources entry: leave it and the object stays reachable
  // through the page, so `Save()`'s mark-sweep keeps the hidden content in the
  // file — which is exactly what this is for.
  const dead = new Set<number>(hiddenXo);
  for (const n of droppedRefs) if (!invokedRefs.has(n)) dead.add(n);
  if (dead.size) {
    for (const resources of resourceDicts) {
      const xo = dictOf(doc, resources.get('XObject'));
      if (!xo) continue;
      for (const [k, v] of [...xo]) if (isRef(v) && dead.has(v.num)) xo.delete(k);
    }
    for (const n of dead) doc.deleteObject(n);
    report.removedXObjects = dead.size;
  }

  // Pass 5 — the vocabulary itself. Every /Properties entry naming an OCG or an
  // OCMD, then /OCProperties; the group objects are then unreachable and
  // `Save()`'s mark-sweep drops them.
  for (const resources of resourceDicts) {
    const props = dictOf(doc, resources.get('Properties'));
    if (!props) continue;
    for (const [k, v] of [...props]) {
      const t = nameOf(doc, dictOf(doc, v)?.get('Type'));
      if (t === 'OCG' || t === 'OCMD') props.delete(k);
    }
    if (props.size === 0) resources.delete('Properties');
  }
  doc.catalog().delete('OCProperties');
  doc.markModified();
  return report;
}

/** Replace a content stream's payload in place, so every referrer sees it. */
function rewriteStream(doc: Document, num: number, stream: PdfStream, ops: ContentOp[]): void {
  const raw = serializeContentStream(ops);
  const dict: PdfDict = new Map(stream.dict);
  dict.delete('Filter');            // we wrote raw (uncompressed) bytes
  dict.delete('DecodeParms');
  dict.set('Length', raw.length);
  doc.replaceObject(num, { kind: 'stream', dict, raw });
}
