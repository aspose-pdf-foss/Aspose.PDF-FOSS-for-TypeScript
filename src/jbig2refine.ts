// JBIG2 generic refinement region decode — ITU-T T.88 §6.3. Refines a reference
// bitmap into a new one of the same nominal size.
//
// Arithmetic only: T.88 defines no MMR refinement, which is why a Huffman text
// region has to alternate entropy coders within one stream rather than refining
// in its own coding.
//
// Pure over `Bitmap` and an `MqDecoder` — the reference and its (dx, dy) arrive
// as arguments and nothing here knows what a segment is, which is what lets one
// procedure serve all three callers T.88 gives it: the refinement region
// segment, a symbol dictionary with REFAGG=1, and a text region with SBREFINE.
import { MqDecoder } from './jpxmq.js';
import { newBitmap, type Bitmap } from './jbig2.js';

export interface RefineParams {
  width: number; height: number;
  /** The bitmap being refined (T.88 GRREFERENCE). */
  reference: Bitmap;
  /** Reference offset (GRREFERENCEDX/DY): the reference pixel for (x, y) is
   *  (x - dx, y - dy). Zero for a refinement region segment; the decoded
   *  RDX/RDY for the symbol-dictionary and text-region callers. */
  dx: number; dy: number;
  /** GRTEMPLATE: 0 (13-bit context, two AT pixels) or 1 (10-bit, no AT). */
  template: number;
  /** The two AT pixels, template 0 only: at[0] joins the coding template,
   *  at[1] the reference template. Both nominally (-1, -1). */
  at: Array<{ x: number; y: number }>;
  /** TPGRON typical prediction (T.88 §6.3.5.6). */
  tpgron: boolean;
}

export interface RefineTemplate { coding: number[][]; reference: number[][] }

// T.88 §6.3.5.3, Figures 12-14. Coding pixels are read from the bitmap being
// built; reference pixels from GRREFERENCE at (x - dx, y - dy).
const CODING: number[][][] = [
  [[0, -1], [1, -1], [-1, 0]],
  [[-1, -1], [0, -1], [1, -1], [-1, 0]],
];
const REFERENCE: number[][][] = [
  [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
  [[0, -1], [-1, 0], [0, 0], [1, 0], [0, 1], [1, 1]],
];

/** SLTP contexts for TPGRON (T.88 §6.3.5.6), per template — and the only
 *  outside evidence of the context bit order. Each is the label for "every
 *  template pixel 0 except the reference pixel at (0,0)", so asserting that
 *  equality pins the template lengths, the coding-before-reference order, and
 *  the fact that the AT pixels are appended rather than sorted in. A round trip
 *  through our own encoder agrees with itself whatever order we pick. */
export const REFINE_REUSED_CONTEXTS = [0x0020, 0x0008];

/** Build a template's pixel lists, AT pixels APPENDED — never sorted in, unlike
 *  jbig2generic.ts's buildTemplate, which sorts the whole set by (y, x).
 *  Copying that habit here is the likeliest way to get §6.3 wrong. */
export function refineTemplate(template: number, at: Array<{ x: number; y: number }>): RefineTemplate {
  const t = template === 0 ? 0 : 1;
  const coding = CODING[t].map((p) => [p[0], p[1]]);
  const reference = REFERENCE[t].map((p) => [p[0], p[1]]);
  if (t === 0) {
    coding.push([at[0]?.x ?? -1, at[0]?.y ?? -1]);
    reference.push([at[1]?.x ?? -1, at[1]?.y ?? -1]);
  }
  return { coding, reference };
}

function px(bm: Bitmap, x: number, y: number): number {
  return (x < 0 || x >= bm.width || y < 0 || y >= bm.height) ? 0 : bm.data[y * bm.width + x];
}

/** The context label for one pixel (T.88 §6.3.5.3): coding pixels first and
 *  most significant, then reference pixels. */
export function refineContext(
  bm: Bitmap, ref: Bitmap, tpl: RefineTemplate, x: number, y: number, dx: number, dy: number,
): number {
  let ctx = 0;
  for (const [ox, oy] of tpl.coding) ctx = (ctx << 1) | px(bm, x + ox, y + oy);
  for (const [ox, oy] of tpl.reference) ctx = (ctx << 1) | px(ref, x - dx + ox, y - dy + oy);
  return ctx;
}

/** TPGRON's typicality test (T.88 §6.3.5.6): where LTP is set, a pixel whose
 *  3x3 reference neighbourhood is uniform takes that value directly and is NOT
 *  decoded — it consumes no arithmetic decision. Anything else returns
 *  undefined and is decoded normally.
 *
 *  Note this is unlike TPGDON in jbig2generic.ts, which copies the row above:
 *  refinement's typicality is a property of the REFERENCE, not of the row. */
export function typicalPixel(ref: Bitmap, rx: number, ry: number): number | undefined {
  // Out-of-bounds reference pixels read as 0 through `px`, deliberately: that is
  // what makes the edge of a uniformly-black reference NOT typical, and treating
  // those cells as matching instead sends the first and last row of every TPGRON
  // region down the typical path and desynchronises the stream.
  const first = px(ref, rx - 1, ry - 1);
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) if (px(ref, rx + ox, ry + oy) !== first) return undefined;
  }
  return first;
}

/** Decode a generic refinement region (T.88 §6.3). When `mqIn`/`cxIn` are
 *  supplied (the symbol-dictionary and text-region callers) they drive the
 *  decode; otherwise a fresh decoder and a 2^13-context array are allocated. */
export function decodeRefinement(
  data: Uint8Array, start: number, end: number, prm: RefineParams,
  mqIn?: MqDecoder, cxIn?: Int8Array,
): Bitmap {
  const bm = newBitmap(prm.width, prm.height);
  const mq = mqIn ?? new MqDecoder(data, start, end);
  const cx = cxIn ?? new Int8Array(1 << 13);
  const tpl = refineTemplate(prm.template, prm.at);
  const sltp = REFINE_REUSED_CONTEXTS[prm.template === 0 ? 0 : 1];
  let ltp = 0;
  for (let y = 0; y < prm.height; y++) {
    if (prm.tpgron) ltp ^= mq.decode(cx, sltp);
    for (let x = 0; x < prm.width; x++) {
      if (ltp) {
        const t = typicalPixel(prm.reference, x - prm.dx, y - prm.dy);
        if (t !== undefined) { bm.data[y * prm.width + x] = t; continue; }
      }
      bm.data[y * prm.width + x] = mq.decode(cx, refineContext(bm, prm.reference, tpl, x, y, prm.dx, prm.dy));
    }
  }
  return bm;
}
