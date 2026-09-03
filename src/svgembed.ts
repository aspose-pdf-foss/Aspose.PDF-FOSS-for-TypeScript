// SVG placement (issue 1gg0.3): wrap the content stream from svgdraw.ts as a
// Form XObject and draw it into a target rect. This is the only module in the
// SVG stack that touches a Document.
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfParseError } from './errors.js';
import { parseXml } from './xml.js';
import { enc } from './serialize.js';
import { num, ensureOwnResources, ensureOwnSubdict, freshKey, appendContent } from './pagecontent.js';
import { validateMarkOptions, markDrawing } from './structwrite.js';
import type { StructElement } from './struct.js';
import { name, ref, type PdfDict, type PdfObject } from './types.js';
import {
  drawSvg, type SvgImageSink, type SvgRasterSink, type SvgStreamSink,
} from './svgdraw.js';
import { parseViewBox, placementMatrix, type ViewBox } from './svgtransform.js';
import type { Matrix } from './text.js';
import { rasterizeFormRgba } from './raster.js';
import { faceOutline } from './glyphoutline.js';
import { getStd14Sfnt } from './std14fonts.js';
import { ctmScale } from './strokegeom.js';
import { EmbeddedFont } from './embeddedfont.js';
import { winAnsiDriver } from './layout.js';
import type { StdFont } from './metrics.js';
import { vmetricsFor } from './textdecor.js';
import { resolveFamily, std14Face, type SvgFace, type SvgFontProvider } from './svgtext.js';

/** Options for {@link Page.AddSVGObject}. */
export interface AddSVGOptions {
  /** Override the file's own preserveAspectRatio: 'meet' fits the drawing
   *  inside the rect, 'slice' covers it, 'fill' stretches each axis
   *  independently. Default: whatever the SVG asks for (xMidYMid meet). */
  fit?: 'meet' | 'slice' | 'fill';
  /** Face to use for any font-family the Standard-14 set cannot supply — a
   *  handle from {@link Document.AddFont}. Without it such families are
   *  substituted with the nearest Standard-14 face, and characters outside
   *  WinAnsi are dropped (and reported in `skipped`). */
  font?: EmbeddedFont;
  /** Resolution multiplier for a rasterized `<filter>`: a multiple of the
   *  placed device size. Default 2 (≈144 DPI at 1:1 placement). Capped at 8, so
   *  a typo cannot ask for gigabytes of pixels. */
  filterScale?: number;
  /** Supply the bytes for an `<image>` or `<feImage>` href this library cannot
   *  decode itself — a relative path, an `http:` URL, or a `data:` payload whose
   *  bytes are not PNG or JPEG. Return `undefined` to decline, which reports the
   *  element in `skipped` exactly as without the option. Synchronous by design:
   *  the library performs no I/O, so fetch before the call and resolve out of a
   *  map. A throw propagates — it is a bug in the caller, not a missing image. */
  resolveImage?: (href: string) => Uint8Array | undefined;
  /** Tag the drawing into the logical structure tree (marked content). */
  tag?: StructElement;
  /** Create a /Figure carrying this /Alt and tag the drawing into it. Ignored
   *  when `tag` is given, and on a document with no structure tree. */
  alt?: string;
  /** Mark the drawing as an /Artifact — decoration carrying no meaning. Cannot
   *  be combined with `tag` or `alt`. */
  artifact?: boolean;
}

/** The outcome of {@link Page.AddSVGObject}. */
export interface AddSVGResult {
  /** Distinct element names whose rendering was skipped or incomplete, sorted —
   *  e.g. ['linearGradient', 'text']. Empty when the SVG rendered in full. */
  skipped: string[];
  /** Distinct element names whose subtree was flattened to a bitmap, sorted.
   *  Not a fidelity loss like `skipped` — the content renders correctly — but
   *  it is resolution-bound, and its text is no longer extractable. */
  rasterized: string[];
}

/** The user-unit box the content is expressed in: the viewBox, else the root
 *  width/height, else the target rect (an identity mapping). */
function resolveViewBox(
  attrs: Map<string, string>, rect: [number, number, number, number],
): ViewBox {
  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) return vb;
  const w = parseFloat(attrs.get('width') ?? '');
  const h = parseFloat(attrs.get('height') ?? '');
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)
    return { minX: 0, minY: 0, w, h };
  return { minX: 0, minY: 0, w: rect[2], h: rect[3] };
}

/** Builds the /Font subdictionary as faces are asked for. Only this module may
 *  allocate, which is why svgdraw.ts and svgtext.ts take a provider rather than
 *  resolving fonts themselves. */
function fontProvider(doc: Document, fallback: EmbeddedFont | undefined): {
  provider: SvgFontProvider; fonts: PdfDict;
} {
  const fonts: PdfDict = new Map<string, PdfObject>();
  const cache = new Map<string, SvgFace>();

  const provider: SvgFontProvider = {
    dict: () => fonts,
    face(families, bold, italic): SvgFace {
      const m = resolveFamily(families);
      // The caller had the real font and said so: it wins wherever the
      // Standard-14 set has nothing to offer.
      const useFallback = fallback !== undefined && !m.matched;
      const id = useFallback ? 'embedded' : std14Face(m.family, bold, italic);
      const hit = cache.get(id);
      if (hit) return hit;

      const key = `F${fonts.size}`;
      let face: SvgFace;
      if (useFallback) {
        const f = fallback!;
        // An indirect ref, not a direct dict: the Type0 object is filled by the
        // document's finalize pass at Save, exactly as stamp.ts does it.
        if (f.objNum === undefined) f.objNum = doc.allocObject(new Map<string, PdfObject>()).num;
        fonts.set(key, ref(f.objNum));
        // The caller's own program, so a stretched outline is the drawn font.
        face = { key, driver: f.driver(), vmetrics: vmetricsFor(f), outline: faceOutline(f.sfnt) };
      } else {
        const std = id as StdFont;
        // A Standard-14 dict is not a stream, so it can sit directly in the
        // form's own /Resources -- the same trick the /ExtGState entries use.
        fonts.set(key, new Map<string, PdfObject>([
          ['Type', name('Font')],
          ['Subtype', name('Type1')],
          ['BaseFont', name(std)],
          ['Encoding', name('WinAnsiEncoding')],
        ]));
        // Outlines come from the bundled Liberation/URW substitute, which is
        // metric-compatible with the AFM widths winAnsiDriver laid the run out
        // with -- the same approximation ToImage already makes. Absent when the
        // bundled data will not parse, which degrades stretch to align.
        const sub = getStd14Sfnt(std);
        face = {
          key, driver: winAnsiDriver(std), vmetrics: vmetricsFor(std),
          ...(sub ? { outline: faceOutline(sub) } : {}),
        };
      }
      cache.set(id, face);
      return face;
    },
  };
  return { provider, fonts };
}

/** The sink svgdraw.ts uses to turn a built content stream into a PDF object.
 *  This module is the only one that may allocate, which is why the walker takes
 *  a sink rather than building the stream itself: a PatternType 1 pattern and a
 *  luminosity mask group are both streams, and streams must be indirect. */
function streamSink(doc: Document): SvgStreamSink {
  return {
    stream: (dict, content) =>
      doc.allocObject({ kind: 'stream', dict, raw: enc(content) }),
  };
}

/** Allocates the Image XObject for an `<image>`, and its soft mask. The only
 *  place a stream may be created; mirrors streamSink, and the /SMask handling
 *  mirrors imageembed.ts's addImage. */
function imageSink(doc: Document): SvgImageSink {
  return {
    image: (built) => {
      if (built.smask) built.stream.dict.set('SMask', doc.allocObject(built.smask));
      return doc.allocObject(built.stream);
    },
  };
}

/** Rasterizes the filtered subtree for an SVG `<filter>`. Only this module may
 *  allocate the scratch objects raster.ts needs, which is why the walker
 *  reaches rasterization through a sink at all. Never throws: a failure makes
 *  the element draw unfiltered and report. */
function rasterSink(doc: Document): SvgRasterSink {
  return {
    rasterize: (dict, content, devW, devH) => {
      try {
        return rasterizeFormRgba(doc, { kind: 'stream', dict, raw: enc(content) }, devW, devH);
      } catch {
        return null;
      }
    },
  };
}

/** Parse `data` as SVG and draw it into `rect` on `page`. Existing content is
 *  preserved. Validation runs before anything is allocated, so a rejected call
 *  leaves the document byte-identical. */
/** What an imported SVG is, before it is placed. @internal */
export interface BuiltSvg {
  ref: PdfObject;
  /** The placement matrix for a rect. A CLOSURE rather than a baked matrix, so
   *  addSvgObject computes exactly the matrix it always did and its output
   *  stays BYTE-IDENTICAL. placementMatrix takes rx/ry additively in `e` and
   *  `f`, so this is also just a translate of the origin matrix. */
  matrixFor(rect: [number, number, number, number]): Matrix;
  skipped: string[];
  rasterized: string[];
}

/** Import an SVG into `doc` as a Form XObject, WITHOUT placing it.
 *
 *  Split out of {@link addSvgObject} along the line that function already had:
 *  everything here touches only the Document, and only the page attachment
 *  needs a Page. That is what lets zch2.12 import at BUILD time and fold the
 *  importer's report into the one AddHtml hands back before anything is drawn.
 *
 *  Takes a SIZE rather than a rect, and that is forced: placementMatrix bakes
 *  the rect's rx/ry into the matrix, so a form built before its position is
 *  known cannot be handed one. resolveViewBox reads only the width and height,
 *  so nothing else here depends on the position. @internal */
export function buildSvgForm(
  doc: Document, data: Uint8Array, size: [number, number],
  opts: AddSVGOptions = {},
): BuiltSvg {
  const [sw, sh] = size;
  validateMarkOptions(opts); // before anything is parsed or allocated
  if (!(sw > 0) || !(sh > 0))
    throw new TypeError('rect width and height must be positive');
  const fit = opts.fit;
  if (fit !== undefined && fit !== 'meet' && fit !== 'slice' && fit !== 'fill')
    throw new TypeError("fit must be 'meet', 'slice' or 'fill'");
  // Only an embedded handle: the option exists to supply what the Standard-14
  // set cannot, and a caller wanting a different Standard-14 face can say so in
  // font-family. stamp.ts's validateFont accepts both, which is right for
  // AddText and wrong here.
  const font = opts.font;
  if (font !== undefined && !(font instanceof EmbeddedFont))
    throw new TypeError('font must be an EmbeddedFont handle from Document.AddFont');
  const filterScale = opts.filterScale;
  if (filterScale !== undefined
      && (!Number.isFinite(filterScale) || filterScale <= 0 || filterScale > 8))
    throw new TypeError('filterScale must be a finite number in (0, 8]');
  const resolveImage = opts.resolveImage;
  if (resolveImage !== undefined && typeof resolveImage !== 'function')
    throw new TypeError('resolveImage must be a function');

  const root = parseXml(data);                 // throws PdfParseError if malformed
  if (root.name !== 'svg') throw new PdfParseError(`SVG: root element is <${root.name}>, not <svg>`);

  const origin: [number, number, number, number] = [0, 0, sw, sh];
  const vb = resolveViewBox(root.attrs, origin);
  const par = root.attrs.get('preserveAspectRatio');
  // /Font is assembled by the walker, per content stream: a pattern tile is a
  // separate stream with its own /Resources and cannot see the form's.
  const { provider } = fontProvider(doc, font);
  // The placement is resolved BEFORE the walk: a rasterized <filter> needs to
  // know how many device pixels a user unit is worth, and deviceScale is the
  // one scalar that carries it across the seam. Computed at the ORIGIN, which
  // changes nothing: ctmScale reads the scale terms, and a translate does not
  // touch them.
  const m0 = placementMatrix(vb, origin, par, fit);
  const { content, resources, skipped, rasterized } = drawSvg(
    root, vb, provider, streamSink(doc), imageSink(doc),
    { deviceScale: ctmScale(m0), filterScale, raster: rasterSink(doc), resolveImage });

  const form: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [vb.minX, vb.minY, vb.minX + vb.w, vb.minY + vb.h]],
    ['Matrix', [1, 0, 0, 1, 0, 0]],
    ['Resources', resources],
  ]);
  const ref = doc.allocObject({ kind: 'stream', dict: form, raw: enc(content) });

  return {
    ref,
    matrixFor: (rect) => placementMatrix(vb, rect, par, fit),
    skipped,
    rasterized,
  };
}

export function addSvgObject(
  doc: Document, page: Page, data: Uint8Array,
  rect: [number, number, number, number], opts: AddSVGOptions = {},
): AddSVGResult {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n) => Number.isFinite(n)))
    throw new TypeError('rect must be [x, y, w, h] of finite numbers');
  const built = buildSvgForm(doc, data, [rect[2], rect[3]], opts);

  const res = ensureOwnResources(doc, page);
  const xobjs = ensureOwnSubdict(doc, res, 'XObject');
  const key = freshKey(xobjs, 'Fm');
  xobjs.set(key, built.ref);

  // Clip to the rect unconditionally: 'slice' deliberately overflows, and no
  // SVG should paint outside the rectangle it was handed.
  const [x, y, w, h] = rect;
  const m = built.matrixFor(rect);
  const drawn = enc(
    `q\n${num(x)} ${num(y)} ${num(w)} ${num(h)} re\nW n\n` +
    `${m.map(num).join(' ')} cm\n/${key} Do\nQ`);
  appendContent(doc, page, markDrawing(doc, page, drawn, opts));

  return { skipped: built.skipped, rasterized: built.rasterized };
}
