// Read-only resolution of an annotation's /AP appearance: which stream a viewer
// draws, and where. The single home for the /AP display rules, shared by the
// render pass (pagerender.ts) and the flatten pass (flatten.ts).
//
// Never mutates the document. Flatten layers its own ref promotion on top —
// rendering must not, so the raw /N entry is returned un-promoted alongside the
// resolved stream and each consumer takes what it needs.
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream, isString, name } from './types.js';
import { iconBody, type IconFill, type IconSubtype } from './annoticon.js';
import { STAMP_FONT, stampCaption, stampLabelBody } from './annotstamp.js';
import { decodePdfText } from './metadata.js';
import { placementMatrix, type Matrix } from './text.js';
import { AP_FONT_KEY, freeTextParts, shapeParts } from './annotdraw.js';
import { matrixFor } from './appearance.js';

// Annotation flag bits (/F), PDF 32000-1 §12.5.3.
export const FLAG_HIDDEN = 1 << 1; // bit 2, value 2 — not displayed at all
export const FLAG_NOVIEW = 1 << 5; // bit 6, value 32 — displayed on print only, not on screen

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Resolve `o` to a fixed-length array of finite numbers, or undefined. */
function numArray(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out.push(v);
  }
  return out;
}

/** The annotation's /F flag bitfield (0 when absent). */
export function annotFlags(doc: Document, annot: PdfDict): number {
  const f = doc.resolve(annot.get('F'));
  return typeof f === 'number' ? f : 0;
}

/**
 * True when a static page render should draw this annotation: not Hidden, not
 * NoView, and not a /Popup — a popup is the note window belonging to a parent
 * markup annotation, which viewers draw only while the note is open.
 *
 * Shared by the render pass and flatten.ts, so a flat render and a rasterized
 * one agree on exactly which annotations are painted.
 */
export function isAnnotVisible(doc: Document, annot: PdfDict): boolean {
  if ((annotFlags(doc, annot) & (FLAG_HIDDEN | FLAG_NOVIEW)) !== 0) return false;
  const s = doc.resolve(annot.get('Subtype'));
  if (isName(s) && s.name === 'Popup') return false;
  // An /OC naming a layer the default configuration hides (q1g2.2). This lives
  // HERE rather than in the render pass precisely because of the contract above:
  // render, flatten and the drawn-text search must agree about what is painted,
  // and a check in drawAnnots alone would let FlattenAnnotations bake ink into
  // permanent page content that the rendered page does not show.
  //
  // `defaultConfigIfPresent` is the READ-ONLY accessor: `Default` creates
  // /OCProperties and marks the document modified, which a predicate must never
  // do. It is asked per annotation rather than memoized — unlike the marked-
  // content path, whose memo exists because sections are unbounded — since this
  // loop is over a page's /Annots and the raw operand must reach
  // `ResolveVisibility` unresolved either way (it decides by ref identity).
  const oc = annot.get('OC');
  if (oc !== undefined && !(doc.OptionalContent.defaultConfigIfPresent()?.ResolveVisibility(oc) ?? true)) {
    return false;
  }
  return true;
}

export interface AnnotAppearance {
  /** The raw /N (or /AS-selected) entry, un-promoted: a ref, or an inline stream. */
  entry: PdfObject;
  /** The resolved appearance stream. */
  stream: PdfStream;
  /** Maps the /Matrix-transformed /BBox onto /Rect (PDF 32000-1 §12.5.5). */
  place: Matrix;
}

/** The raw /AP /N entry to draw. /N is either a single appearance stream or a
 *  state subdictionary keyed by the annotation's /AS appearance state. */
function normalEntry(doc: Document, annot: PdfDict): PdfObject | undefined {
  const ap = doc.resolve(annot.get('AP'));
  if (!isDict(ap)) return undefined;

  const n = ap.get('N');
  const resolved = doc.resolve(n);
  if (isStream(resolved)) return n;

  if (isDict(resolved)) {
    const as = doc.resolve(annot.get('AS'));
    if (!isName(as)) return undefined;
    const entry = resolved.get(as.name);
    if (entry === undefined || !isStream(doc.resolve(entry))) return undefined;
    return entry;
  }
  return undefined;
}

/**
 * The appearance to draw for `annot` and where to place it, or undefined when
 * there is none usable: no /AP, an /N state subdict with no matching /AS, a
 * missing /Rect or /BBox, or a degenerate placement.
 *
 * The one exception to "no /AP, nothing drawn" is a /Text or /FileAttachment
 * annotation with no /AP key at all, which gets the icon a viewer would draw
 * (`v0tz.1`, see `iconAppearance`) as an INLINE stream in `entry`.
 */
export function resolveAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const entry = normalEntry(doc, annot);
  if (entry === undefined) return annot.has('AP') ? undefined : viewerAppearance(doc, annot);
  const stream = doc.resolve(entry);
  if (!isStream(stream)) return undefined;

  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const bbox = numArray(doc, stream.dict.get('BBox'), 4);
  if (bbox === undefined) return undefined;
  const m = (numArray(doc, stream.dict.get('Matrix'), 6) as Matrix | undefined) ?? IDENTITY;

  const place = placementMatrix(bbox, m, rect);
  if (place === undefined) return undefined;
  return { entry, stream, place };
}

/** The icon a viewer draws for a /Text or /FileAttachment annotation that has
 *  NO /AP key at all (`v0tz.1`), built on the fly and never written into the
 *  document — rendering must not mutate, and a viewer that does draw its own
 *  icons should go on doing so for the notes we create. Flatten promotes the
 *  inline stream to an object, as it does for any inline /N, so the icon
 *  becomes permanent exactly when the caller asks for that.
 *
 *  An /AP that is PRESENT but unusable (an /N state dict with no matching /AS)
 *  never reaches here: the producer stated an appearance, and a viewer draws
 *  nothing for it too. That test is on the RAW dict — `has`, not a resolved
 *  value, since `doc.resolve(undefined)` is null. */
function iconAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const sub = doc.resolve(annot.get('Subtype'));
  if (!isName(sub) || (sub.name !== 'Text' && sub.name !== 'FileAttachment')) return undefined;
  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const w = Math.abs(rect[2] - rect[0]), h = Math.abs(rect[3] - rect[1]);
  if (!(w > 0 && h > 0)) return undefined;
  const nm = doc.resolve(annot.get('Name'));
  const body = iconBody(sub.name as IconSubtype, isName(nm) ? nm.name : undefined, fillOf(doc, annot), w, h);
  const raw = new TextEncoder().encode(body);
  const bbox = [0, 0, w, h];
  const stream: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', bbox], ['Length', raw.length],
    ]),
    raw,
  };
  const place = placementMatrix(bbox, IDENTITY, rect);
  if (place === undefined) return undefined;
  return { entry: stream, stream, place };
}

/** /C as the icon's fill: an empty array is a stated TRANSPARENT (12.5.2), so
 *  `null`; anything unusable is `undefined` and takes the default. */
function fillOf(doc: Document, annot: PdfDict): IconFill {
  const c = doc.resolve(annot.get('C'));
  if (!isArray(c)) return undefined;
  if (c.length === 0) return null;
  const out: number[] = [];
  for (const v of c) {
    const n = doc.resolve(v);
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
    out.push(Math.min(1, Math.max(0, n)));
  }
  return out;
}

/** What a viewer draws for an annotation with NO /AP key: the icon for a /Text
 *  or /FileAttachment (`v0tz.1`), the caption box for a /Stamp (`v0tz.2`),
 *  and nothing for anything else. */
function viewerAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const sub = doc.resolve(annot.get('Subtype'));
  if (isName(sub) && sub.name === 'Stamp') return stampAppearance(doc, annot);
  if (isName(sub) && sub.name === 'FreeText') return freeTextAppearance(doc, annot);
  // The four above keep their own builders: each has a rule the generic path
  // has no way to know — a stamp's DRAFT default, an icon's /Name artwork.
  return iconAppearance(doc, annot) ?? shapeAppearance(doc, annot);
}

/** A shape or text-markup annotation with no /AP, drawn on the fly (`kapw`).
 *
 *  The body is `shapeParts`', the very one `regenerateAppearance` installs on
 *  the import path, so a document that arrives with appearances and one that
 *  does not provably cannot be drawn two ways. That covers the eleven subtypes
 *  the fallback used to miss — /Square, /Circle, /Line, /Polygon, /PolyLine,
 *  /Ink, /Caret and the four text-markup ones — and v0tz.4's cloud borders
 *  come with them, since they are part of the /Square and /Polygon bodies.
 *
 *  Invariant: NOTHING is allocated and the annotation still carries no /AP
 *  afterwards. `installShapeAP` would allocate a font object even for a body
 *  that draws no text, and an ExtGState besides — and rendering must not
 *  mutate, since a spurious `markModified()` turns a later `Sign()` from an
 *  incremental append into a full rewrite of bytes an earlier signature
 *  covered. So the resources are INLINE, as `iconAppearance`'s and
 *  `stampAppearance`'s are.
 *
 *  Only a /Caret with /Sy /P draws any text, naming AP_FONT_KEY for its ¶;
 *  every other body is pure geometry, so the font is written only when the
 *  body actually names one. */
function shapeAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const parts = shapeParts(doc, annot);
  if (parts === undefined) return undefined;

  let body = '';
  if (parts.opacity < 1) body += '/GS0 gs\n';
  body += parts.body;
  const raw = new TextEncoder().encode(`q\n${body}\nQ`);

  const resources: PdfDict = new Map<string, PdfObject>();
  if (parts.body.includes(`/${AP_FONT_KEY} `)) {
    resources.set('Font', new Map<string, PdfObject>([[AP_FONT_KEY,
      new Map<string, PdfObject>([
        ['Type', name('Font')], ['Subtype', name('Type1')],
        ['BaseFont', name(parts.faces.get(AP_FONT_KEY) ?? 'Helvetica')],
        ['Encoding', name('WinAnsiEncoding')],
      ])]]));
  }
  if (parts.opacity < 1) {
    resources.set('ExtGState', new Map<string, PdfObject>([['GS0',
      new Map<string, PdfObject>([
        ['Type', name('ExtGState')], ['ca', parts.opacity], ['CA', parts.opacity],
      ])]]));
  }

  const bbox = [0, 0, parts.g.w, parts.g.h];
  const matrix = matrixFor(parts.g);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', bbox],
    ['Matrix', matrix], ['Length', raw.length],
  ]);
  if (resources.size > 0) dict.set('Resources', resources);
  const stream: PdfStream = { kind: 'stream', dict, raw };

  const place = placementMatrix(bbox, matrix as Matrix, rect);
  if (place === undefined) return undefined;
  return { entry: stream, stream, place };
}

/** The font key the fallback stamp's inline font resource is registered
 *  under. Only this stream's own /Resources names it. */
const STAMP_KEY = 'F0';

/** A /Stamp with no /AP, drawn as the caption box `Page.AddStamp` writes
 *  (`v0tz.2`) — built on the fly and never written, like the icons.
 *
 *  The caption is the stamp's /Name, spelled as a rubber stamp reads for the
 *  14 standard names; with no /Name, the first non-empty line of /Contents;
 *  with neither, DRAFT, which 12.5.6.12 makes the default /Name.
 *
 *  The font dictionary is INLINE in the stream's own /Resources: the shared
 *  `fontResources` allocates an object, and rendering must not mutate. */
function stampAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const w = Math.abs(rect[2] - rect[0]), h = Math.abs(rect[3] - rect[1]);
  if (!(w > 0 && h > 0)) return undefined;
  const body = stampLabelBody(w, h, stampLabel(doc, annot), stampColor(doc, annot), STAMP_KEY);
  const raw = new TextEncoder().encode(`q\n${body}\nQ`);
  const bbox = [0, 0, w, h];
  const font: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')],
    ['BaseFont', name(STAMP_FONT)], ['Encoding', name('WinAnsiEncoding')],
  ]);
  const stream: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', bbox],
      ['Resources', new Map<string, PdfObject>([['Font', new Map<string, PdfObject>([[STAMP_KEY, font]])]])],
      ['Length', raw.length],
    ]),
    raw,
  };
  const place = placementMatrix(bbox, IDENTITY, rect);
  if (place === undefined) return undefined;
  return { entry: stream, stream, place };
}

/** /Name's caption, else /Contents' first non-empty line, else DRAFT. */
function stampLabel(doc: Document, annot: PdfDict): string {
  const n = doc.resolve(annot.get('Name'));
  if (isName(n)) return stampCaption(n.name);
  const c = doc.resolve(annot.get('Contents'));
  if (isString(c)) {
    const line = decodePdfText(c.bytes).split(/\r\n|\r|\n/).map((l) => l.trim()).find((l) => l !== '');
    if (line !== undefined) return line;
  }
  return stampCaption('Draft');
}

/** /C with 1, 3 or 4 components; red otherwise — an EMPTY /C would be a
 *  transparent stamp, which is an invisible one. */
function stampColor(doc: Document, annot: PdfDict): readonly number[] {
  const c = fillOf(doc, annot);
  return c && (c.length === 1 || c.length === 3 || c.length === 4) ? c : [1, 0, 0];
}

/** A /FreeText with no /AP, drawn from /RC (else /Contents) exactly as
 *  `regenerateAppearance` would draw it — one builder, `freeTextParts` — but
 *  wrapped INLINE: its fonts and any /GS0 live in the stream's own
 *  /Resources, so rendering allocates nothing (`v0tz.3`). */
function freeTextAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const parts = freeTextParts(doc, annot);
  if (parts === undefined) return undefined;
  const rect = numArray(doc, annot.get('Rect'), 4);
  if (rect === undefined) return undefined;
  const fonts = new Map<string, PdfObject>();
  for (const [key, face] of parts.faces) {
    fonts.set(key, new Map<string, PdfObject>([
      ['Type', name('Font')], ['Subtype', name('Type1')],
      ['BaseFont', name(face)], ['Encoding', name('WinAnsiEncoding')],
    ]));
  }
  const resources = new Map<string, PdfObject>([['Font', fonts]]);
  let content = parts.body;
  if (parts.opacity < 1) {
    resources.set('ExtGState', new Map<string, PdfObject>([['GS0', new Map<string, PdfObject>([
      ['Type', name('ExtGState')], ['ca', parts.opacity], ['CA', parts.opacity],
    ])]]));
    content = `/GS0 gs\n${content}`;
  }
  const raw = new TextEncoder().encode(`q\n${content}\nQ`);
  const bbox = [0, 0, parts.g.w, parts.g.h];
  const stream: PdfStream = {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', bbox],
      ['Resources', resources], ['Length', raw.length],
    ]),
    raw,
  };
  const place = placementMatrix(bbox, IDENTITY, rect);
  if (place === undefined) return undefined;
  return { entry: stream, stream, place };
}
