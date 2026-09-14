import { PdfObject, PdfDict, isDict, isName, isStream } from './types.js';

/**
 * Can anything these resources reach use transparency? (`ixxw.5`)
 *
 * ISO 19005-1 prohibits transparency, and `ConvertToPdfA` cannot flatten it —
 * correctly, since flattening means rasterizing the page and losing its text.
 * But producers STAMP `/Group /S /Transparency` on pages that use no
 * transparency at all, and such a group cannot change the rendered result. The
 * converter drops one only when this answers false.
 *
 * **Invariant:** DELIBERATELY CONSERVATIVE, and the direction is the safety
 * property. Every ExtGState in a resource dictionary counts, whether or not
 * any operator selects it — false means "transparency is ruled out", so a
 * wrong false removes a group that was doing something, while a wrong true
 * merely leaves a document to be reported. Anything unrecognised therefore
 * says nothing rather than being taken as safe.
 *
 * **Invariant:** it reads no CONTENT STREAM. That is what the resource-level
 * over-approximation buys: no parsing, no `q`/`Q` state, and no chance of
 * missing an operator in a stream that would not parse.
 *
 * **Invariant:** a pure LEAF. `resolve` arrives as an argument (the
 * `colorimage.ts` seam) and nothing is mutated, so every rule is drivable from
 * hand-built dicts with no document. It never throws.
 */

type Resolve = (o: PdfObject | undefined) => PdfObject;

/** Blend modes that composite as though there were no transparency. */
const OPAQUE_BLEND = new Set(['Normal', 'Compatible']);

/** Depth bound for the resource walk. Resources nest through forms and
 *  patterns; `seen` stops a cycle, this stops a pathologically deep chain. */
const MAX_DEPTH = 16;

/** True when this ExtGState declares any transparency. */
function gsUsesTransparency(gs: PdfDict, resolve: Resolve): boolean {
  // Presence is tested on the RAW dict: `resolve(undefined)` is null and
  // `null !== undefined`, so resolving first reports a soft mask for every
  // ExtGState that has none — the trap `transparencyRule` already records.
  const sm = gs.get('SMask') === undefined ? undefined : resolve(gs.get('SMask'));
  if (sm !== undefined && !(isName(sm) && sm.name === 'None')) return true;
  const bm = resolve(gs.get('BM'));
  if (isName(bm) && !OPAQUE_BLEND.has(bm.name)) return true;
  if (Array.isArray(bm)) {
    // A blend mode may be an ARRAY, the first supported entry winning. Any
    // non-opaque name in it is enough to keep the group.
    for (const e of bm) {
      const n = resolve(e);
      if (isName(n) && !OPAQUE_BLEND.has(n.name)) return true;
    }
  }
  for (const k of ['CA', 'ca']) {
    const v = resolve(gs.get(k));
    if (typeof v === 'number' && v < 1) return true;
  }
  return false;
}

/** True when this XObject declares transparency, or reaches it. */
function xobjUsesTransparency(
  xo: PdfObject, resolve: Resolve, seen: Set<object>, depth: number,
): boolean {
  if (!isStream(xo)) return false;
  const sub = resolve(xo.dict.get('Subtype'));
  const subtype = isName(sub) ? sub.name : undefined;
  if (subtype === 'Image') {
    // An /SMask is an alpha channel and a /Mask is a stencil or colour key;
    // either composites the image against what is under it.
    return xo.dict.get('SMask') !== undefined || xo.dict.get('Mask') !== undefined;
  }
  // A nested transparency group. The issue's own list makes this a
  // disqualifier rather than something to look inside: a group declares group
  // compositing, and ruling THAT inert is a separate judgement.
  const grp = resolve(xo.dict.get('Group'));
  if (isDict(grp)) {
    const s = resolve(grp.get('S'));
    if (isName(s) && s.name === 'Transparency') return true;
  }
  return walk(resolve(xo.dict.get('Resources')), resolve, seen, depth + 1);
}

function walk(
  resources: PdfObject | undefined, resolve: Resolve, seen: Set<object>, depth: number,
): boolean {
  if (depth > MAX_DEPTH) return true; // cannot rule it out; keep the group
  const res = resolve(resources);
  if (!isDict(res) || seen.has(res)) return false;
  seen.add(res);

  const gsDict = resolve(res.get('ExtGState'));
  if (isDict(gsDict)) {
    for (const v of gsDict.values()) {
      const gs = resolve(v);
      if (isDict(gs) && gsUsesTransparency(gs, resolve)) return true;
    }
  }

  const xobjs = resolve(res.get('XObject'));
  if (isDict(xobjs)) {
    for (const v of xobjs.values()) {
      const xo = resolve(v);
      if (isStream(xo) && seen.has(xo.dict)) continue;
      if (isStream(xo)) seen.add(xo.dict);
      if (xobjUsesTransparency(xo, resolve, seen, depth)) return true;
    }
  }

  const patterns = resolve(res.get('Pattern'));
  if (isDict(patterns)) {
    for (const v of patterns.values()) {
      const p = resolve(v);
      const pd = isStream(p) ? p.dict : isDict(p) ? p : undefined;
      if (!pd) continue;
      // A shading pattern's /ExtGState is its own, beside its resources.
      const pgs = resolve(pd.get('ExtGState'));
      if (isDict(pgs) && gsUsesTransparency(pgs, resolve)) return true;
      if (walk(pd.get('Resources'), resolve, seen, depth + 1)) return true;
    }
  }

  // A Type 3 font draws through glyph procedures with resources of their own.
  const fonts = resolve(res.get('Font'));
  if (isDict(fonts)) {
    for (const v of fonts.values()) {
      const f = resolve(v);
      if (!isDict(f)) continue;
      if (walk(f.get('Resources'), resolve, seen, depth + 1)) return true;
    }
  }
  return false;
}

/** Entry point. See the module docs above. */
export function usesTransparency(
  resources: PdfObject | undefined, resolve: Resolve,
): boolean {
  return walk(resources, resolve, new Set<object>(), 0);
}
