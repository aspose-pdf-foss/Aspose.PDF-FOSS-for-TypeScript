import {
  QUANT_LUMA, QUANT_CHROMA, scaleQuantTable, fdct8x8, quantizeBlock,
} from './jpegfdct.js';
import { encodeJpegFromBlocks } from './jpegcoef.js';

export type JpegKind = 'gray' | 'rgb' | 'cmyk';

export interface JpegEncodeOptions {
  /** 1..100 on the IJG scale. Default 75. */
  quality?: number;
  /** 3-component only; ignored for gray and CMYK. Default '4:2:0'. */
  subsampling?: '4:4:4' | '4:2:0';
  /** Per-image Huffman tables. Default true. */
  optimizeHuffman?: boolean;
}

const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

/** One component: its sample plane plus the table slots it uses. */
interface Plane {
  data: Uint8Array;
  w: number;
  h: number;
  /** Sampling factors relative to the frame. */
  hs: number;
  vs: number;
  /** Quant table slot (0 = luma, 1 = chroma). */
  tq: 0 | 1;
  /** DC/AC Huffman table slot. */
  td: 0 | 1;
}

const clamp8 = (v: number): number => {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

/** Box-average a plane 2x2, clamping the source index on odd edges. */
function box2x2(src: Uint8Array, w: number, h: number): Uint8Array {
  const dw = Math.ceil(w / 2), dh = Math.ceil(h / 2);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = 2 * x, y0 = 2 * y;
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    out[y * dw + x] = Math.round(
      (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]) / 4,
    );
  }
  return out;
}

/** Split interleaved samples into per-component planes, applying the JPEG colour
 *  transform. Gray and CMYK pass through; CMYK is deliberately not inverted and
 *  carries no APP14 (see the spec's "Colorspace conventions"). */
function toPlanes(
  width: number, height: number, samples: Uint8Array, kind: JpegKind, sub420: boolean,
): Plane[] {
  const px = width * height;
  if (kind === 'gray') {
    return [{ data: samples.slice(), w: width, h: height, hs: 1, vs: 1, tq: 0, td: 0 }];
  }
  if (kind === 'cmyk') {
    const out: Plane[] = [];
    for (let c = 0; c < 4; c++) {
      const d = new Uint8Array(px);
      for (let i = 0; i < px; i++) d[i] = samples[i * 4 + c];
      out.push({ data: d, w: width, h: height, hs: 1, vs: 1, tq: 0, td: 0 });
    }
    return out;
  }
  const Y = new Uint8Array(px), Cb = new Uint8Array(px), Cr = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    const R = samples[i * 3], G = samples[i * 3 + 1], B = samples[i * 3 + 2];
    Y[i] = clamp8(0.299 * R + 0.587 * G + 0.114 * B);
    Cb[i] = clamp8(-0.168736 * R - 0.331264 * G + 0.5 * B + 128);
    Cr[i] = clamp8(0.5 * R - 0.418688 * G - 0.081312 * B + 128);
  }
  if (!sub420) {
    return [
      { data: Y, w: width, h: height, hs: 1, vs: 1, tq: 0, td: 0 },
      { data: Cb, w: width, h: height, hs: 1, vs: 1, tq: 1, td: 1 },
      { data: Cr, w: width, h: height, hs: 1, vs: 1, tq: 1, td: 1 },
    ];
  }
  const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
  return [
    { data: Y, w: width, h: height, hs: 2, vs: 2, tq: 0, td: 0 },
    { data: box2x2(Cb, width, height), w: cw, h: ch, hs: 1, vs: 1, tq: 1, td: 1 },
    { data: box2x2(Cr, width, height), w: cw, h: ch, hs: 1, vs: 1, tq: 1, td: 1 },
  ];
}

/** Sample a plane with edge replication, so partial blocks extend the margin. */
const at = (p: Plane, x: number, y: number): number =>
  p.data[Math.min(y, p.h - 1) * p.w + Math.min(x, p.w - 1)];

/** Encode interleaved 8-bit samples as a baseline JPEG. */
export function encodeJpeg(
  width: number, height: number, samples: Uint8Array, kind: JpegKind,
  opts: JpegEncodeOptions = {},
): Uint8Array {
  const nch = CHANNELS[kind];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new TypeError('encodeJpeg: width and height must be positive integers');
  if (samples.length !== width * height * nch)
    throw new TypeError(
      `encodeJpeg: expected ${width * height * nch} samples, got ${samples.length}`,
    );

  const quality = opts.quality ?? 75;
  const sub420 = kind === 'rgb' && (opts.subsampling ?? '4:2:0') === '4:2:0';
  const optimize = opts.optimizeHuffman ?? true;

  const planes = toPlanes(width, height, samples, kind, sub420);
  const maxH = Math.max(...planes.map((p) => p.hs));
  const maxV = Math.max(...planes.map((p) => p.vs));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerCol = Math.ceil(height / (8 * maxV));

  const quant: Int32Array[] = [scaleQuantTable(QUANT_LUMA, quality)];
  const usesChroma = planes.some((p) => p.tq === 1);
  if (usesChroma) quant.push(scaleQuantTable(QUANT_CHROMA, quality));

  // FDCT + quantize every block of every plane, in raster order per plane.
  const coefs: Int32Array[][] = planes.map((p) => {
    const bpl = mcusPerLine * p.hs, bpc = mcusPerCol * p.vs;
    const q = quant[p.tq];
    const spatial = new Float64Array(64);
    const freq = new Float64Array(64);
    const out: Int32Array[] = [];
    for (let br = 0; br < bpc; br++) for (let bc = 0; bc < bpl; bc++) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
        spatial[y * 8 + x] = at(p, bc * 8 + x, br * 8 + y) - 128;
      fdct8x8(spatial, freq);
      const zz = new Int32Array(64);
      quantizeBlock(freq, q, zz);
      out.push(zz);
    }
    return out;
  });

  return encodeJpegFromBlocks({
    width, height,
    comps: planes.map((p, pi) => ({
      blocks: coefs[pi], h: p.hs, v: p.vs, tq: p.tq, td: p.td,
    })),
    quant,
    jfif: kind !== 'cmyk',
    optimizeHuffman: optimize,
  });
}
