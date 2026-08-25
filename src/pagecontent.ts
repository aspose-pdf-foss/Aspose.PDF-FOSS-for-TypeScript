import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfObject, PdfDict, PdfRef, PdfStream,
  isDict, isArray, isStream, isRef, name,
} from './types.js';
import { enc, escapeName } from './serialize.js';
import type { Matrix } from './text.js';

/** Format a number compactly for a content stream (no exponent, no float noise). */
export function num(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

export function streamOf(bytes: Uint8Array): PdfStream {
  return { kind: 'stream', dict: new Map(), raw: bytes };
}

/** Wrap a content-stream body in a marked-content sequence carrying an /MCID:
 *  `/<tag> << /MCID n >> BDC` … body … `EMC`. */
export function wrapMarkedContent(tag: string, mcid: number, body: Uint8Array): Uint8Array {
  const head = enc(`/${escapeName(tag)} <</MCID ${mcid}>> BDC\n`);
  const tail = enc('\nEMC');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

/** Wrap a content-stream body as an artifact: `/Artifact BMC` … body … `EMC`.
 *  The no-MCID sibling of {@link wrapMarkedContent} — in a tagged page every
 *  piece of content must be either tagged or marked as an artifact, and
 *  decoration (rules, leaders, running heads) is the latter. */
export function wrapArtifact(body: Uint8Array): Uint8Array {
  const head = enc('/Artifact BMC\n');
  const tail = enc('\nEMC');
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

export function freshKey(d: PdfDict, prefix: string): string {
  for (let i = 0; ; i++) {
    const k = `${prefix}${i}`;
    if (!d.has(k)) return k;
  }
}

/** The page's own /Resources, shallow-copying an inherited one onto the page so
 *  we never shadow it (which would hide fonts the existing content depends on). */
export function ensureOwnResources(doc: Document, page: Page): PdfDict {
  const own = page.Dict.get('Resources');
  if (own !== undefined) {
    const d = doc.resolve(own);
    if (isDict(d)) return d;
  }
  const inherited = page.Resources; // resolved inherited dict or undefined
  const copy: PdfDict = new Map(inherited ?? []);
  page.Dict.set('Resources', copy);
  return copy;
}

/** A fresh own sub-dict (e.g. Font), shallow-copying any existing entries so we
 *  mutate only structures this page owns. */
export function ensureOwnSubdict(doc: Document, resources: PdfDict, key: string): PdfDict {
  const d = doc.resolve(resources.get(key));
  const copy: PdfDict = isDict(d) ? new Map(d) : new Map();
  resources.set(key, copy);
  return copy;
}

/** Which alpha channel(s) an /ExtGState sets: `ca` (fill), `CA` (stroke), or
 *  both. */
export type AlphaChannel = 'both' | 'fill' | 'stroke';

/** Register (or reuse) an /ExtGState with `opacity` on `channel`; returns its
 *  resource key. The default sets both channels, which is what setOpacity and
 *  every stamping caller means.
 *
 *  **Invariant:** the reuse compare matches the exact key SET, not just the
 *  values it happens to find. `ca` and `CA` are independent, so handing a
 *  << /ca 0.5 >> back to a caller asking for both channels silently drops the
 *  stroke half — and a gradient fill's alpha would then be reused for a gradient
 *  stroke's. Presence is read off the RAW dict: doc.resolve(undefined) returns
 *  null, so a resolved absent key does not compare equal to undefined.
 *
 *  **Invariant:** a state carrying an /SMask is never reused. The mask states
 *  registerSoftMaskExtGState builds set ca = CA = 1, so a request for opacity 1
 *  matches them on both channels and would silently inherit the mask. */
export function registerExtGStateIn(
  doc: Document, resources: PdfDict, opacity: number, channel: AlphaChannel = 'both',
): string {
  const wantCa = channel === 'stroke' ? undefined : opacity;
  const wantCA = channel === 'fill' ? undefined : opacity;
  const gs = ensureOwnSubdict(doc, resources, 'ExtGState');
  for (const [k, v] of gs) {
    const d = doc.resolve(v);
    if (!isDict(d) || d.has('SMask')) continue;
    const at = (key: string): PdfObject | undefined =>
      (d.has(key) ? doc.resolve(d.get(key)) : undefined);
    if (at('ca') === wantCa && at('CA') === wantCA) return k;
  }
  const entries: [string, PdfObject][] = [['Type', name('ExtGState')]];
  if (wantCa !== undefined) entries.push(['ca', wantCa]);
  if (wantCA !== undefined) entries.push(['CA', wantCA]);
  const key = freshKey(gs, 'GS');
  gs.set(key, doc.allocObject(new Map<string, PdfObject>(entries)));
  return key;
}

/** The page-targeted form: {@link registerExtGStateIn} against the page's own
 *  /Resources. Every stamping caller uses this one. */
export function registerExtGState(
  doc: Document, page: Page, opacity: number, channel: AlphaChannel = 'both',
): string {
  return registerExtGStateIn(doc, ensureOwnResources(doc, page), opacity, channel);
}

/** Register an /ExtGState carrying a **luminosity soft mask** painted from
 *  `alphaPattern` — the /DeviceGray twin of a shading pattern, whose gray value
 *  at each point is the alpha wanted there — and return its resource key.
 *
 *  The mask is a transparency-group Form XObject declaring /CS /DeviceGray, so
 *  the group's luminosity is exactly what the twin paints; the same shape
 *  svgdraw.ts's maskGroup builds for an SVG gradient.
 *
 *  Its /BBox is the page's MediaBox rather than the ink's own box, because a
 *  PageGraphics caller tracks no paths. That is correct and not merely
 *  convenient: with /Extend [true true] the gray pattern covers the whole plane,
 *  and where extend is off the unpainted area has luminosity 0 — masked out,
 *  which matches the colour pattern being unpainted there too. /BC defaults to
 *  black, which agrees.
 *
 *  `ca`/`CA` are set to 1, so the ramp's own alpha is the only alpha in force —
 *  the same override registerExtGState performs for a uniform stop alpha.
 *
 *  **Invariant:** `matrix` must undo the CTM in force where the `gs` is emitted.
 *  A soft-mask group renders under that CTM (PDF 32000-1 §11.6.5.2), while the
 *  shading pattern it twins is pinned to the content stream's DEFAULT space —
 *  so without the inverse, a caller's `cm` scales the mask and not the colour,
 *  and the ramp silently fades along the wrong axis. /BBox is in the same space
 *  the /Matrix establishes, which is why it may be the MediaBox.
 *
 *  Like registerShadingPattern, this allocates fresh per call: the mask nests a
 *  stream, a group and three dicts deep, and a structural compare would cost
 *  more than the duplication. */
export function registerSoftMaskExtGStateIn(
  doc: Document, resources: PdfDict, alphaPattern: PdfDict, matrix: Matrix,
  bbox: [number, number, number, number],
): string {
  const [x0, y0, x1, y1] = bbox;
  const form: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('XObject')],
      ['Subtype', name('Form')],
      ['FormType', 1],
      ['BBox', [x0, y0, x1, y1]],
      ['Matrix', [...matrix]],
      ['Group', new Map<string, PdfObject>([
        ['Type', name('Group')],
        ['S', name('Transparency')],
        ['CS', name('DeviceGray')],
      ])],
      ['Resources', new Map<string, PdfObject>([
        ['Pattern', new Map<string, PdfObject>([['P0', alphaPattern]])],
      ])],
    ]),
    raw: enc(`/Pattern cs /P0 scn\n${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re\nf`),
  };

  const gs = ensureOwnSubdict(doc, resources, 'ExtGState');
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('ExtGState')],
    ['ca', 1],
    ['CA', 1],
    ['SMask', new Map<string, PdfObject>([
      ['Type', name('Mask')],
      ['S', name('Luminosity')],
      ['G', doc.allocObject(form)],
    ])],
  ]);
  const key = freshKey(gs, 'GS');
  gs.set(key, doc.allocObject(dict));
  return key;
}

/** The page-targeted form, with the mask /BBox taken from the page's MediaBox.
 *  See {@link registerSoftMaskExtGStateIn} for why that box is the right one
 *  for a PageGraphics caller, which tracks no paths. The normalization lives
 *  here rather than in the variant: a caller passing a tile's [0, 0, w, h] has
 *  nothing to normalize. */
export function registerSoftMaskExtGState(
  doc: Document, page: Page, alphaPattern: PdfDict, matrix: Matrix,
): string {
  const [a, b, c, d] = page.MediaBox;
  return registerSoftMaskExtGStateIn(
    doc, ensureOwnResources(doc, page), alphaPattern, matrix,
    [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]);
}

/** Register `pattern` under the page's /Resources /Pattern and return its
 *  resource key (for `/Pattern cs` + `/<key> scn`).
 *
 *  Unlike registerExtGState above, this does NOT deduplicate: it allocates a
 *  fresh key per call. A shading pattern nests three dicts deep, and svgdraw.ts
 *  reaches the same conclusion — a field-by-field compare would cost more than
 *  the duplication. Optimize()'s content-hashed dedup is the general answer. */
export function registerShadingPatternIn(
  doc: Document, resources: PdfDict, pattern: PdfDict,
): string {
  const pat = ensureOwnSubdict(doc, resources, 'Pattern');
  const key = freshKey(pat, 'P');
  pat.set(key, doc.allocObject(pattern));
  return key;
}

/** The page-targeted form: {@link registerShadingPatternIn} against the page's
 *  own /Resources. */
export function registerShadingPattern(doc: Document, page: Page, pattern: PdfDict): string {
  return registerShadingPatternIn(doc, ensureOwnResources(doc, page), pattern);
}

/** Register (or reuse) an already-allocated pattern object under `resources`
 *  /Pattern and return its key (for `/Pattern cs` + `/<key> scn`).
 *
 *  Unlike {@link registerShadingPatternIn}, which allocates from a dict, this
 *  takes a ref that already exists — a tiling pattern is created once on the
 *  Document and used on many pages. Reusing an existing key that maps to the
 *  same ref is what makes that cheap, and mirrors registerOcPropertyIn, which
 *  reuses for the same reason. */
export function registerPatternRefIn(
  doc: Document, resources: PdfDict, ref: PdfRef,
): string {
  const pat = ensureOwnSubdict(doc, resources, 'Pattern');
  for (const [k, v] of pat) {
    if (isRef(v) && v.num === ref.num && v.gen === ref.gen) return k;
  }
  const key = freshKey(pat, 'P');
  pat.set(key, ref);
  return key;
}

/** Register (or reuse) an already-allocated XObject under the page's
 *  /Resources /XObject and return its key (for `/<key> Do`).
 *
 *  Reuses an existing key mapping to the same ref, which is what lets one
 *  template placed twice on a page emit two `Do` against one key. Contrast
 *  compose.ts's placeFitted, which mints a fresh key per cell because every
 *  N-up cell is a DIFFERENT imported form. */
export function registerXObjectRef(doc: Document, page: Page, ref: PdfRef): string {
  const res = ensureOwnResources(doc, page);
  const xo = ensureOwnSubdict(doc, res, 'XObject');
  for (const [k, v] of xo) {
    if (isRef(v) && v.num === ref.num && v.gen === ref.gen) return k;
  }
  const key = freshKey(xo, 'Fm');
  xo.set(key, ref);
  return key;
}

/** Register (or reuse) `ocg` under the page's /Resources /Properties and return
 *  its resource key (for `/OC /<key> BDC`). Reuses an existing key that already
 *  maps to the same ref. */
export function registerOcPropertyIn(
  doc: Document, resources: PdfDict, ocg: PdfRef,
): string {
  const props = ensureOwnSubdict(doc, resources, 'Properties');
  for (const [k, v] of props) {
    if (isRef(v) && v.num === ocg.num && v.gen === ocg.gen) return k;
  }
  const key = freshKey(props, 'OC');
  props.set(key, ocg);
  return key;
}

/** The page-targeted form: {@link registerOcPropertyIn} against the page's own
 *  /Resources. */
export function registerOcProperty(doc: Document, page: Page, ocg: PdfRef): string {
  return registerOcPropertyIn(doc, ensureOwnResources(doc, page), ocg);
}

/** Normalize /Contents to an array of stream refs (allocating for any inline
 *  streams), keeping only entries that resolve to streams. */
function normalizeContents(doc: Document, c: PdfObject | undefined): PdfRef[] {
  if (c === undefined) return [];
  if (isRef(c)) return isStream(doc.resolve(c)) ? [c] : [];
  if (isStream(c)) return [doc.allocObject(c)];
  if (isArray(c)) {
    const out: PdfRef[] = [];
    for (const e of c) {
      if (isRef(e)) { if (isStream(doc.resolve(e))) out.push(e); }
      else if (isStream(e)) out.push(doc.allocObject(e));
    }
    return out;
  }
  return [];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Splice `body` into /Contents, wrapping existing content in q/Q so prior
 *  graphics state cannot leak into the appended body. */
export function appendContent(doc: Document, page: Page, body: Uint8Array): void {
  const existing = normalizeContents(doc, page.Dict.get('Contents'));
  if (existing.length === 0) {
    page.Dict.set('Contents', [doc.allocObject(streamOf(body))]);
    return;
  }
  const qRef = doc.allocObject(streamOf(enc('q')));
  const tailRef = doc.allocObject(streamOf(concat([enc('Q\n'), body])));
  page.Dict.set('Contents', [qRef, ...existing, tailRef]);
}

/** Wrap **all** existing page content in `q <cm> ... Q`, so the whole page is
 *  rendered through `cm` (a global transform — used by Resize/Scale). Existing
 *  streams are kept by reference; the save/restore isolates the transform. */
export function transformContent(doc: Document, page: Page, cm: Matrix): void {
  const existing = normalizeContents(doc, page.Dict.get('Contents'));
  const head = doc.allocObject(streamOf(enc(`q\n${cm.map(num).join(' ')} cm\n`)));
  const tail = doc.allocObject(streamOf(enc('\nQ')));
  page.Dict.set('Contents', [head, ...existing, tail]);
}

/** Splice `body` into /Contents BEFORE existing content, so it draws behind it
 *  (an underlay). Existing content is wrapped in q/Q so its state stays
 *  isolated. `body` is assumed self-contained (its own q/Q), mirroring
 *  appendContent. */
export function prependContent(doc: Document, page: Page, body: Uint8Array): void {
  const existing = normalizeContents(doc, page.Dict.get('Contents'));
  if (existing.length === 0) {
    page.Dict.set('Contents', [doc.allocObject(streamOf(body))]);
    return;
  }
  const headRef = doc.allocObject(streamOf(concat([body, enc('\nq\n')])));
  const tailRef = doc.allocObject(streamOf(enc('Q\n')));
  page.Dict.set('Contents', [headRef, ...existing, tailRef]);
}
