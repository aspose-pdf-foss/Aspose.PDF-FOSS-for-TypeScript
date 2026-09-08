// Artifact enumeration: the /Artifact marked-content scopes a page declares,
// with what each one says about itself (32000-1 14.8.2.2) and where it sits.
//
// The read side of a vocabulary this library previously only WROTE --
// `wrapArtifact`, `PageGraphics.BeginArtifact`, the `artifact: true` option on
// every vector producer, `AutoTag`'s undescribed images.
//
// **Invariant:** it measures nothing itself. Glyph, image and path extents are
// text.ts's answers, subscribed to through `visitContent` -- which is also the
// one owner of the marked-content stack, so "which scope is open" is decided
// once. A private walk here would need the whole text state machine (fonts,
// Tf, Tm, TJ) to place a glyph, and would be a second answer to a question
// `GetPaths` and `GetText` already agree on.

import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isArray, isName } from './types.js';
import type { ContentAddr } from './editcontent.js';
import { visitContent, type Rect } from './text.js';

/** Which edges of the page a pagination artifact is attached to (Table 331). */
export type ArtifactEdge = 'Top' | 'Bottom' | 'Left' | 'Right';

/** Where an artifact's {@link PageArtifact.bbox} came from. */
export type ArtifactBBoxSource = 'declared' | 'content';

/** One `/Artifact` marked-content scope drawn on a page.
 *
 *  Every field but `addr` is optional, and that is the format rather than
 *  laxity: the whole property list is optional, and a bare `/Artifact BMC` --
 *  which is what this library itself writes, and what most producers write --
 *  declares nothing at all. */
export interface PageArtifact {
  /** /Type: `Pagination`, `Layout`, `Page` or `Background`. Undefined when the
   *  artifact declares none. Reported as written, so an unknown name from a
   *  future edition comes through rather than being dropped. */
  type?: string;
  /** /Subtype: `Header`, `Footer` or `Watermark` on a pagination artifact. */
  subtype?: string;
  /** /Attached edges, pagination artifacts only. */
  attached?: ArtifactEdge[];
  /** The artifact's extent, in the page's default user space.
   *
   *  A declared /BBox wins and is reported VERBATIM -- 14.8.2.2 says default
   *  user space, so a producer is taken at its word rather than pushed through
   *  a CTM that may only reflect a `cm` preceding the BMC. Absent one, this is
   *  the measured extent of the ink the scope encloses, content drawn inside a
   *  Form XObject it invokes included. Undefined when the scope declares no
   *  /BBox and encloses no ink -- which is how "this artifact draws nothing"
   *  is said. */
  bbox?: Rect;
  /** Which of the two `bbox` is. Absent exactly when `bbox` is. */
  bboxSource?: ArtifactBBoxSource;
  /** The raw property list, for the keys this model does not name. Undefined
   *  for a bare `/Artifact BMC`, which has none. */
  properties?: PdfDict;
  /** Where the opening `BMC`/`BDC` sits: which content stream (an XObject
   *  resource-name chain for one inside a form), and which op within it. */
  addr: ContentAddr;
  /** The enclosing artifact, when this one is nested inside another. Artifacts
   *  are reported one per declared scope, so this is how a caller tells an
   *  inner scope from an outer one. */
  parent?: ContentAddr;
}

/** A scope identity. Joined on a character no PDF name may contain, because
 *  concatenating the fields raw collides: [A]/0/12 and [A0]/1/2 both spell
 *  `A012`. */
const key = (a: ContentAddr): string => [...a.path, a.streamIndex, a.opIndex].join(String.fromCharCode(0));

const nameOf = (doc: Document, o: PdfObject | undefined): string | undefined => {
  const r = doc.resolve(o);
  return isName(r) ? r.name : undefined;
};

const EDGES = new Set<string>(['Top', 'Bottom', 'Left', 'Right']);

/** /Attached: an array of edge names. Anything else is not an attachment. */
function attachedOf(doc: Document, o: PdfObject | undefined): ArtifactEdge[] | undefined {
  const r = doc.resolve(o);
  if (!isArray(r)) return undefined;
  const out: ArtifactEdge[] = [];
  for (const e of r) {
    const n = nameOf(doc, e);
    if (n !== undefined && EDGES.has(n)) out.push(n as ArtifactEdge);
  }
  return out.length ? out : undefined;
}

/** /BBox: four numbers, normalized so x0<=x1 and y0<=y1 the way every other
 *  box in this library reads. Undefined when it is not four numbers. */
function bboxOf(doc: Document, o: PdfObject | undefined): Rect | undefined {
  const r = doc.resolve(o);
  if (!isArray(r) || r.length < 4) return undefined;
  const n = r.slice(0, 4).map((v) => doc.resolve(v));
  if (!n.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) return undefined;
  const [a, b, c, d] = n;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Grow `box` to cover `add`, in place; `undefined` grows to a copy of `add`. */
function union(box: Rect | undefined, add: Rect): Rect {
  if (!box) return [add[0], add[1], add[2], add[3]];
  return [
    Math.min(box[0], add[0]), Math.min(box[1], add[1]),
    Math.max(box[2], add[2]), Math.max(box[3], add[3]),
  ];
}

/** The axis box of a path event's flattened segments. */
function segmentBox(segments: readonly [number, number, number, number][]): Rect | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [ax, ay, bx, by] of segments) {
    x0 = Math.min(x0, ax, bx); y0 = Math.min(y0, ay, by);
    x1 = Math.max(x1, ax, bx); y1 = Math.max(y1, ay, by);
  }
  return x0 === Infinity ? undefined : [x0, y0, x1, y1];
}

interface Rec {
  out: PageArtifact;
  /** Ink measured directly inside this scope, before nested scopes fold in. */
  measured?: Rect;
}

/** Enumerate the `/Artifact` scopes a page declares, in the order they open,
 *  descending into Form XObjects. Never throws; returns [] on decode failure.
 *
 *  A nested artifact is its own entry naming its `parent`, and an outer scope's
 *  measured extent covers the ink of the scopes inside it -- an inner artifact
 *  is inside the outer one geometrically as well as syntactically. */
export function extractArtifacts(doc: Document, page: Page): PageArtifact[] {
  const recs: Rec[] = [];
  const byKey = new Map<string, Rec>();

  const grow = (scope: ContentAddr | undefined, box: Rect | undefined) => {
    if (!scope || !box) return;
    const rec = byKey.get(key(scope));
    if (rec) rec.measured = union(rec.measured, box);
  };

  try {
    visitContent(doc, page, {
      artifact: (e) => {
        const props = e.properties;
        const declared = props ? bboxOf(doc, props.get('BBox')) : undefined;
        const rec: Rec = {
          out: {
            type: props ? nameOf(doc, props.get('Type')) : undefined,
            subtype: props ? nameOf(doc, props.get('Subtype')) : undefined,
            attached: props ? attachedOf(doc, props.get('Attached')) : undefined,
            bbox: declared,
            bboxSource: declared ? 'declared' : undefined,
            properties: props,
            addr: e.addr,
            parent: e.parent,
          },
        };
        recs.push(rec);
        byKey.set(key(e.addr), rec);
      },
      glyph: (e) => grow(e.artifactScope, e.quad),
      image: (e) => grow(e.artifactScope, e.quad),
      path: (e) => grow(e.artifactScope, segmentBox(e.segments)),
    });
  } catch {
    return [];
  }

  // Fold each scope's extent into its parent's, innermost first: a record's
  // parent always opened before it, so one reverse pass carries a deeply
  // nested scope's ink all the way out.
  for (let i = recs.length - 1; i >= 0; i--) {
    const rec = recs[i];
    if (!rec.measured || !rec.out.parent) continue;
    const up = byKey.get(key(rec.out.parent));
    if (up) up.measured = union(up.measured, rec.measured);
  }

  for (const rec of recs) {
    if (rec.out.bbox === undefined && rec.measured) {
      rec.out.bbox = rec.measured;
      rec.out.bboxSource = 'content';
    }
  }
  return recs.map((r) => r.out);
}
