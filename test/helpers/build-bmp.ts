/**
 * Synthesize BMP files for the decoder tests.
 *
 * Deliberately dumb: it lays bytes out from the caller's numbers and performs
 * no decoding of its own, so it cannot "agree" with the decoder about a
 * misreading the way a round-trip through a shared codec would. The published
 * hex dumps in test/bmp.test.ts are the anchor; this is the matrix sweep.
 */
export interface BuildBmpOptions {
  width: number;
  height: number;
  bpp: 1 | 2 | 4 | 8 | 16 | 24 | 32;
  /** DIB header size: 12, 40, 52, 56, 64, 108 or 124. Default 40. */
  dibSize?: number;
  /** BI_* value. Default 0 (BI_RGB). */
  compression?: number;
  /** true stores the top row first and writes a negative height. */
  topDown?: boolean;
  /** BGR(A) or index bytes, ONE ROW AT A TIME, top row first. Padding is added. */
  rows: number[][];
  /** BGR(x) palette entries as [b, g, r] triples. Entry size follows dibSize. */
  palette?: Array<[number, number, number]>;
  /** Written into biClrUsed. Defaults to palette.length. */
  clrUsed?: number;
  /** Channel masks for BI_BITFIELDS / V2+ headers: [r, g, b, a]. */
  masks?: [number, number, number, number];
  /** Extra bytes between the palette and the pixel array. */
  gap?: number;
  /** Replaces the pixel array outright (for RLE and embedded payloads). */
  rawPixels?: Uint8Array;
}

const put32 = (d: Uint8Array, o: number, v: number): void => {
  d[o] = v & 0xff; d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff; d[o + 3] = (v >>> 24) & 0xff;
};
const put16 = (d: Uint8Array, o: number, v: number): void => {
  d[o] = v & 0xff; d[o + 1] = (v >>> 8) & 0xff;
};

export function buildBmp(o: BuildBmpOptions): Uint8Array {
  const dibSize = o.dibSize ?? 40;
  const compression = o.compression ?? 0;
  const core = dibSize === 12;
  const entry = core ? 3 : 4;
  const palBytes = (o.palette?.length ?? 0) * entry;
  // A 40-byte header with bitfields keeps its masks where the palette would go.
  const inlineMasks = dibSize === 40 && (compression === 3 || compression === 6)
    ? (compression === 6 ? 16 : 12) : 0;
  const gap = o.gap ?? 0;

  const stride = (((o.width * o.bpp + 31) / 32) | 0) * 4;
  const pixels = o.rawPixels ?? (() => {
    const buf = new Uint8Array(stride * o.height);
    // `rows` is top-down; a bottom-up file stores them reversed.
    o.rows.forEach((r, y) => {
      const dst = (o.topDown ? y : o.height - 1 - y) * stride;
      buf.set(Uint8Array.from(r), dst);
    });
    return buf;
  })();

  const offBits = 14 + dibSize + inlineMasks + palBytes + gap;
  const out = new Uint8Array(offBits + pixels.length);
  out[0] = 0x42; out[1] = 0x4d;
  put32(out, 0x02, out.length);
  put32(out, 0x0a, offBits);
  put32(out, 0x0e, dibSize);

  if (core) {
    put16(out, 0x12, o.width);
    put16(out, 0x14, o.height);
    put16(out, 0x16, 1);
    put16(out, 0x18, o.bpp);
  } else {
    put32(out, 0x12, o.width);
    put32(out, 0x16, o.topDown ? -o.height : o.height);
    put16(out, 0x1a, 1);
    put16(out, 0x1c, o.bpp);
    put32(out, 0x1e, compression);
    put32(out, 0x22, pixels.length);
    put32(out, 0x26, 2835);
    put32(out, 0x2a, 2835);
    put32(out, 0x2e, o.clrUsed ?? o.palette?.length ?? 0);
    put32(out, 0x32, 0);
  }

  if (o.masks) {
    // V2+ headers hold the masks INSIDE themselves at 0x36; a 40-byte header
    // holds them immediately AFTER itself. Getting this backwards consumes the
    // first palette entries as masks.
    const at = dibSize >= 52 ? 0x36 : 14 + dibSize;
    put32(out, at, o.masks[0]);
    put32(out, at + 4, o.masks[1]);
    put32(out, at + 8, o.masks[2]);
    if (dibSize >= 56 || compression === 6) put32(out, at + 12, o.masks[3]);
  }
  if (dibSize >= 108) put32(out, 0x46, 0x57696e20);   // "Win " colour space

  if (o.palette) {
    let p = 14 + dibSize + inlineMasks;
    for (const [b, g, r] of o.palette) {
      out[p] = b; out[p + 1] = g; out[p + 2] = r;
      p += entry;
    }
  }
  out.set(pixels, offBits);
  return out;
}
