// JBIG2 generic region decode — ITU-T T.88 §6.2. Arithmetic (GB templates 0-3
// with adaptive-template pixels and TPGDON typical prediction) and MMR (Group-4,
// delegated to the shared CCITT engine).
import { MqDecoder } from './jpxmq.js';
import { decodeCcittConsumed } from './ccitt.js';
import { newBitmap, type Bitmap } from './jbig2.js';

export interface GenericParams {
  width: number; height: number; template: number;
  at: Array<{ x: number; y: number }>; tpgdon: boolean; mmr: boolean;
  /** HENABLESKIP's skip bitmap (T.88 §6.6.5.1), same dimensions as the region.
   *  A set pixel is 0 and is NOT decoded — it consumes no arithmetic decision.
   *  That is why this cannot be a post-filter over a finished plane: filtering
   *  afterwards leaves the stream desynchronised from the first skipped pixel
   *  onward, so the whole plane is wrong. Arithmetic only — T.88 hands the skip
   *  bitmap to no MMR procedure, so the mmr branch ignores it. */
  skip?: Bitmap;
}

// Fixed template pixels (T.88 §6.2.5.3, Figures 4-7). The AT pixels are appended
// and the whole set is sorted by (y, x); the first pixel is the context MSB.
const CODING_TEMPLATES: number[][][] = [
  [[-1,-2],[0,-2],[1,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[-4,0],[-3,0],[-2,0],[-1,0]],
  [[-1,-2],[0,-2],[1,-2],[2,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[2,-1],[-3,0],[-2,0],[-1,0]],
  [[-1,-2],[0,-2],[1,-2],[-2,-1],[-1,-1],[0,-1],[1,-1],[-2,0],[-1,0]],
  [[-3,-1],[-2,-1],[-1,-1],[0,-1],[1,-1],[-4,0],[-3,0],[-2,0],[-1,0]],
];
// SLTP contexts for TPGDON (T.88 §6.2.5.7), per template.
const REUSED_CONTEXTS = [0x9b25, 0x0795, 0x00e5, 0x0195];

function buildTemplate(template: number, at: Array<{ x: number; y: number }>): number[][] {
  const t = CODING_TEMPLATES[template].map((p) => [p[0], p[1]]).concat(at.map((a) => [a.x, a.y]));
  t.sort((p, q) => (p[1] - q[1]) || (p[0] - q[0]));
  return t;
}

function px(bm: Bitmap, x: number, y: number): number {
  return (x < 0 || x >= bm.width || y < 0 || y >= bm.height) ? 0 : bm.data[y * bm.width + x];
}

/** Decode one MMR-coded bitmap (T.88 §6.2.6), reporting bytes consumed. The
 *  count exists for Annex C.5's grayscale bitplanes, which are packed into ONE
 *  datastream with an EOFB between them; `decodeGeneric`'s mmr branch is this
 *  with the count dropped, so there is one place that knows how MMR bits become
 *  a `Bitmap` rather than two that can disagree. */
export function decodeMmrBitmap(
  data: Uint8Array, start: number, end: number, width: number, height: number,
): { bitmap: Bitmap; consumed: number } {
  // decodeCcitt fills 1=black internally, then XORs when blackIs1 is set; a
  // JBIG2 bitmap wants 1=black, so leave blackIs1 false (no inversion).
  const r = decodeCcittConsumed(data.subarray(start, end), {
    k: -1, columns: width, rows: height, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: false,
  });
  const bm = newBitmap(width, height);
  const rowBytes = (width + 7) >> 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) bm.data[y * width + x] = (r.data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
  }
  return { bitmap: bm, consumed: r.consumed };
}

/** Decode a generic region (T.88 §6.2). When `mq`/`cx` are supplied (symbol-dict
 *  / text reuse) they drive the arithmetic decode; otherwise a fresh decoder and
 *  a 2^16-context array are allocated. */
export function decodeGeneric(data: Uint8Array, start: number, end: number, prm: GenericParams, mqIn?: MqDecoder, cxIn?: Int8Array): Bitmap {
  const bm = newBitmap(prm.width, prm.height);
  if (prm.mmr) return decodeMmrBitmap(data, start, end, prm.width, prm.height).bitmap;
  const mq = mqIn ?? new MqDecoder(data, start, end);
  const cx = cxIn ?? new Int8Array(1 << 16);
  const tpl = buildTemplate(prm.template, prm.at);
  let ltp = 0;
  const TPGD_CTX = REUSED_CONTEXTS[prm.template];
  for (let y = 0; y < prm.height; y++) {
    if (prm.tpgdon) {
      ltp ^= mq.decode(cx, TPGD_CTX);
      if (ltp) { if (y > 0) bm.data.copyWithin(y * prm.width, (y - 1) * prm.width, y * prm.width); continue; }
    }
    for (let x = 0; x < prm.width; x++) {
      // Before the context is assembled, and `continue` rather than a filter:
      // a skipped pixel consumes NO arithmetic decision (T.88 §6.6.5.1).
      if (prm.skip !== undefined && prm.skip.data[y * prm.width + x]) { bm.data[y * prm.width + x] = 0; continue; }
      let ctx = 0;
      for (const [dx, dy] of tpl) ctx = (ctx << 1) | px(bm, x + dx, y + dy);
      bm.data[y * prm.width + x] = mq.decode(cx, ctx);
    }
  }
  return bm;
}
