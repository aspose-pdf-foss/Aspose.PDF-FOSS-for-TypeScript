// Read-only resolution of an annotation's /AP appearance: which stream a viewer
// draws, and where. The single home for the /AP display rules, shared by the
// render pass (pagerender.ts) and the flatten pass (flatten.ts).
//
// Never mutates the document. Flatten layers its own ref promotion on top —
// rendering must not, so the raw /N entry is returned un-promoted alongside the
// resolved stream and each consumer takes what it needs.
import type { Document } from './document.js';
import { PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream } from './types.js';
import { placementMatrix, type Matrix } from './text.js';

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
 */
export function resolveAppearance(doc: Document, annot: PdfDict): AnnotAppearance | undefined {
  const entry = normalEntry(doc, annot);
  if (entry === undefined) return undefined;
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
