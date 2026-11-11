// Lossless generic-region encoder, promoted from scripts/jbig2-codec.mjs.
// ITU-T T.88 sections 6.2/7.4 and Annex E. No symbol matching or preprocessing.
import { QE } from './jpxmq.js';
import { LoadLimits } from './loadlimits.js';
import { UnsupportedFeatureError } from './errors.js';

/** Annex E arithmetic encoder. Contexts use the decoder's index<<1 | mps. */
class MqEncoder {
  private out: number[] = [];
  private dummy = 0;
  private a = 0x8000;
  private c = 0;
  private ct = 12;
  private bp = -1;

  private getByte(): number { return this.bp < 0 ? this.dummy : this.out[this.bp]; }
  private setByte(v: number): void {
    if (this.bp < 0) this.dummy = v & 0xff;
    else this.out[this.bp] = v & 0xff;
  }
  private byteOut(): void {
    if (this.getByte() === 0xff) {
      this.bp++; this.setByte(this.c >>> 20); this.c &= 0xfffff; this.ct = 7;
    } else if ((this.c & 0x8000000) === 0) {
      this.bp++; this.setByte(this.c >>> 19); this.c &= 0x7ffff; this.ct = 8;
    } else {
      this.setByte(this.getByte() + 1);
      if (this.getByte() === 0xff) {
        this.c &= 0x7ffffff;
        this.bp++; this.setByte(this.c >>> 20); this.c &= 0xfffff; this.ct = 7;
      } else {
        this.bp++; this.setByte(this.c >>> 19); this.c &= 0x7ffff; this.ct = 8;
      }
    }
  }
  private renorm(): void {
    do {
      if (this.ct === 0) this.byteOut();
      this.a = (this.a << 1) & 0xffff;
      this.c = (this.c << 1) >>> 0;
      this.ct--;
    } while ((this.a & 0x8000) === 0);
  }
  encode(cx: Int8Array, i: number, d: number): void {
    let state = cx[i] >> 1, mps = cx[i] & 1;
    const q = QE[state];
    this.a -= q.qe;
    if (mps === d) {
      if ((this.a & 0x8000) === 0) {
        if (this.a < q.qe) this.a = q.qe;
        else this.c = (this.c + q.qe) >>> 0;
        state = q.nmps; this.renorm();
      } else this.c = (this.c + q.qe) >>> 0;
    } else {
      if (this.a < q.qe) this.c = (this.c + q.qe) >>> 0;
      else this.a = q.qe;
      if (q.sw) mps = 1 - mps;
      state = q.nlps; this.renorm();
    }
    cx[i] = (state << 1) | mps;
  }
  flush(): Uint8Array {
    const temp = (this.c + this.a) >>> 0;
    this.c = (this.c | 0xffff) >>> 0;
    if (this.c >= temp) this.c = (this.c - 0x8000) >>> 0;
    this.c = (this.c << this.ct) >>> 0; this.byteOut();
    this.c = (this.c << this.ct) >>> 0; this.byteOut();
    if (this.getByte() !== 0xff) this.bp++;
    return Uint8Array.from(this.out.slice(0, Math.max(0, this.bp)));
  }
}

// Template 0 including its default adaptive pixels, sorted by (y, x).
const TEMPLATE = [
  [-2, -2], [-1, -2], [0, -2], [1, -2], [2, -2],
  [-3, -1], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [3, -1],
  [-4, 0], [-3, 0], [-2, 0], [-1, 0],
];

/** Encode packed PDF 1-bit samples as an embedded JBIG2 stream. Zero becomes
 *  JBIG2 black; Decode/ColorSpace remain the caller's concern. Padding bits are
 *  ignored. The input is never changed or expanded into a byte-per-pixel plane.
 *  Internal codec API, not exported from the package entry point. */
export function encodeJbig2(
  width: number, height: number, samples: Uint8Array,
  limits: LoadLimits = LoadLimits.defaults,
): Uint8Array {
  if (![width, height].every((v) => Number.isInteger(v) && v > 0 && v <= 0xffffffff)
    || !Number.isSafeInteger(width * height))
    throw new UnsupportedFeatureError('JBIG2 encode: invalid image dimensions');
  limits.enforce('maxImagePixels', width * height, 'JBIG2 encode');
  const stride = Math.ceil(width / 8);
  if (samples.length !== stride * height)
    throw new UnsupportedFeatureError('JBIG2 encode: sample length disagrees with image dimensions');

  const pixel = (x: number, y: number): number =>
    x < 0 || x >= width || y < 0 || y >= height ? 0
      : ((samples[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) ^ 1;
  const mq = new MqEncoder(), cx = new Int8Array(1 << 16);
  let ltp = 0;
  for (let y = 0; y < height; y++) {
    let same = y > 0;
    if (same) for (let x = 0; x < width; x++) {
      if (pixel(x, y) !== pixel(x, y - 1)) { same = false; break; }
    }
    mq.encode(cx, 0x9b25, ltp ^ Number(same));
    ltp = Number(same);
    if (same) continue;
    for (let x = 0; x < width; x++) {
      let ctx = 0;
      for (const [dx, dy] of TEMPLATE) ctx = (ctx << 1) | pixel(x + dx, y + dy);
      mq.encode(cx, ctx, pixel(x, y));
    }
  }
  const arith = mq.flush();
  // Page info: 11-byte segment header + 19-byte payload. Generic region:
  // 11-byte header + 26-byte region info/flags/AT + arithmetic + FF AC marker.
  const out = new Uint8Array(69 + arith.length), view = new DataView(out.buffer);
  let pos = 0;
  const u32 = (v: number) => { view.setUint32(pos, v); pos += 4; };
  const header = (num: number, type: number, length: number) => {
    u32(num); out[pos++] = type; out[pos++] = 0; out[pos++] = 1; u32(length);
  };
  header(0, 48, 19);
  u32(width); u32(height); u32(0); u32(0);
  out[pos++] = 1; // eventually lossless, white default, OR combination
  pos += 2; // not striped
  header(1, 39, 28 + arith.length);
  u32(width); u32(height); u32(0); u32(0);
  out[pos++] = 0; // OR at (0,0)
  out[pos++] = 8; // arithmetic template 0, TPGDON
  out.set([3, 255, 253, 255, 2, 254, 254, 254], pos); pos += 8;
  out.set(arith, pos); pos += arith.length;
  out[pos++] = 0xff; out[pos] = 0xac;
  return out;
}
