// SVG <image> -> PDF Image XObject (issue 1gg0.9). Pure: decodes the data: URI
// and computes the placement, allocating nothing. The XObject is a stream, so
// svgdraw.ts hands the built image to a sink svgembed.ts implements — the same
// division of labour tiling patterns and fonts already use.
import { buildImageXObject, type BuiltImage } from './imageembed.js';
import type { SegBBox } from './svgpath.js';
import { fitBox } from './svgtransform.js';
import type { Matrix } from './text.js';

/** The payload of a `data:` URI, or undefined for anything else — another
 *  scheme, or a URI with no comma. Both base64 and percent-encoded bodies are
 *  handled; the media type is never consulted, since data URIs in the wild carry
 *  wrong ones and buildImageXObject sniffs the bytes anyway. */
export function dataUriBytes(href: string): Uint8Array | undefined {
  const s = href.trim();
  if (!/^data:/i.test(s)) return undefined;
  const comma = s.indexOf(',');
  if (comma < 0) return undefined;
  const meta = s.slice(5, comma);
  const payload = s.slice(comma + 1);
  // Buffer ignores whitespace, which a pretty-printer will have wrapped into a
  // long attribute value.
  if (/;\s*base64\s*$/i.test(meta)) return new Uint8Array(Buffer.from(payload, 'base64'));

  // Percent-decoded BYTE-wise. decodeURIComponent would treat the escapes as
  // UTF-8 and throw on the very first high byte of a PNG signature.
  const out: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c !== '%') { out.push(c.charCodeAt(0) & 0xff); continue; }
    const hex = payload.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
    out.push(parseInt(hex, 16));
    i += 2;
  }
  return new Uint8Array(out);
}

/** Build an Image XObject from bytes, or undefined when they are unusable.
 *
 *  buildImageXObject THROWS on unrecognized or corrupt bytes, which is right for
 *  page.AddImage and wrong here: one bad icon in a 200-element illustration must
 *  not abort the whole placement. The catch is deliberately broad — the only
 *  distinction a caller can act on is "this image did not render". */
function tryBuild(bytes: Uint8Array | undefined): BuiltImage | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    return buildImageXObject(bytes);
  } catch {
    return undefined;
  }
}

/** Decode an `<image>` href into an Image XObject, or undefined when it cannot
 *  be embedded.
 *
 *  The built-in `data:` path runs first. `resolve` is the caller's fallback for
 *  anything it cannot decode: a relative path, an `http:` URL, or a `data:`
 *  payload whose bytes are not PNG or JPEG — which is how an image/svg+xml one
 *  arrives, nesting an SVG being a separate feature.
 *
 *  `resolve` is called OUTSIDE tryBuild's catch, deliberately. A throw from it
 *  is a CALLER bug — a bad lookup, a missing map — and must propagate; swallowed,
 *  it becomes a silently missing image and a vague skipped: ['image']. The broad
 *  catch is for corrupt image BYTES, a different failure with a different cause. */
export function decodeImage(
  href: string, resolve?: (href: string) => Uint8Array | undefined,
): BuiltImage | undefined {
  const built = tryBuild(dataUriBytes(href));
  if (built !== undefined) return built;
  if (resolve === undefined) return undefined;
  return tryBuild(resolve(href));
}

/** A decoded `<image>` payload: a raster ready to embed, or SVG bytes for the
 *  walker to recurse into. */
export type ImagePayload =
  | { kind: 'raster'; built: BuiltImage }
  | { kind: 'svg'; bytes: Uint8Array };

/** True when the bytes open with XML rather than a raster's magic number. A
 *  UTF-8 BOM and leading whitespace are skipped; the test is for `<` rather than
 *  a literal `<svg` so an XML declaration, a DOCTYPE or a leading comment still
 *  passes. PNG and JPEG magic numbers never begin with `<`, so sniffing this
 *  before attempting a raster build is unambiguous. Whether the root element
 *  really is <svg> is settled by parsing, not here. */
function looksLikeXml(bytes: Uint8Array): boolean {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length
         && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  return i < bytes.length && bytes[i] === 0x3c;      // '<'
}

/** One source's bytes as a payload, or undefined when they are neither. */
function classify(bytes: Uint8Array | undefined): ImagePayload | undefined {
  if (bytes === undefined || bytes.length === 0) return undefined;
  if (looksLikeXml(bytes)) return { kind: 'svg', bytes };
  const built = tryBuild(bytes);
  return built === undefined ? undefined : { kind: 'raster', built };
}

/** Decode an `<image>` href into either a raster XObject or SVG bytes to recurse
 *  into, or undefined when neither is available.
 *
 *  Mirrors decodeImage's source chain exactly — the `data:` path first, the
 *  caller's resolver as the fallback, `resolve` called outside any try so its
 *  throw propagates — and adds the raster/vector discrimination. Either source
 *  may carry either kind: a `data:image/svg+xml` URI and a resolver handing back
 *  `logo.svg` are the same case. Classifying PER SOURCE is what preserves the
 *  fallback: junk `data:` bytes must still reach the resolver.
 *
 *  decodeImage is deliberately left alone as the raster-only entry, and remains
 *  what feImage calls: a filter primitive rasterizes its input, so nesting a
 *  vector document there is a separate feature. */
export function decodePayload(
  href: string, resolve?: (href: string) => Uint8Array | undefined,
): ImagePayload | undefined {
  const direct = classify(dataUriBytes(href));
  if (direct !== undefined) return direct;
  if (resolve === undefined) return undefined;
  return classify(resolve(href));
}

/** The image's intrinsic pixel size, off the XObject dict the build produced. */
export function imageSize(built: BuiltImage): { w: number; h: number } {
  const w = built.stream.dict.get('Width');
  const h = built.stream.dict.get('Height');
  return {
    w: typeof w === 'number' ? w : 0,
    h: typeof h === 'number' ? h : 0,
  };
}

/** Where one <image> lands, in the walker's y-down space. */
export interface ImagePlacement {
  /** The `cm` for the image's unit square. */
  cm: Matrix;
  /** The fitted box, for the pattern-overflow ink union. */
  box: SegBBox;
  /** The element rect to clip to. Present only when the fit overflows it, which
   *  only a `slice` can do. */
  clip?: [number, number, number, number];
}

/** One length attribute, or NaN when absent or unparseable. A percentage is read
 *  as its bare number, consistent with every other length in this stack. */
function len(attrs: Map<string, string>, k: string): number {
  const v = attrs.get(k);
  if (v === undefined) return NaN;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : NaN;
}

/** Resolve an <image>'s rect and fit against an intrinsic size of `iw` x `ih`.
 *  Returns null when nothing should be drawn: SVG 1.1 §5.6 makes a zero
 *  `width`/`height` a deliberate no-render, so it is not a reported loss.
 *
 *  An absent dimension takes the intrinsic size (SVG 2 / browser behaviour);
 *  when only one is absent the other supplies it through the intrinsic aspect
 *  ratio, which is what keeps a one-dimension author from distorting the image. */
export function imagePlacement(
  attrs: Map<string, string>, iw: number, ih: number,
): ImagePlacement | null {
  if (!(iw > 0) || !(ih > 0)) return null;
  const ax = len(attrs, 'x'), ay = len(attrs, 'y');
  const x = Number.isNaN(ax) ? 0 : ax;
  const y = Number.isNaN(ay) ? 0 : ay;
  let w = len(attrs, 'width');
  let h = len(attrs, 'height');
  if (Number.isNaN(w) && Number.isNaN(h)) { w = iw; h = ih; }
  else if (Number.isNaN(w)) w = (h * iw) / ih;
  else if (Number.isNaN(h)) h = (w * ih) / iw;
  if (!(w > 0) || !(h > 0)) return null;

  const f = fitBox({ w: iw, h: ih }, { w, h }, attrs.get('preserveAspectRatio'));
  const bw = iw * f.sx, bh = ih * f.sy;
  const bx = x + f.tx, by = y + f.ty;
  // A PDF image fills the unit square with its first row at v = 1, and this
  // space is y-DOWN, so the local -bh is the flip that cancels the one in
  // placementMatrix. Emitting +bh mirrors the image vertically.
  const cm: Matrix = [bw, 0, 0, -bh, bx, by + bh];
  const box: SegBBox = { x: bx, y: by, w: bw, h: bh };
  // A size comparison, not an offset one: xMinYMin slice leaves tx = ty = 0 and
  // still spills off the far edges.
  const overflows = bw - w > 1e-9 || bh - h > 1e-9;
  return overflows ? { cm, box, clip: [x, y, w, h] } : { cm, box };
}
