import { deflateSync } from 'node:zlib';
import { assemble, contentStream } from './build-grayscale-pdf.js';
import { encodeJpeg } from '../../src/jpegencode.js';

/**
 * Fixtures for `/Mask` rendering (10u9.12).
 *
 * Every image is N x N and fills an N x N page, so at the default scale one
 * image pixel is one device pixel and `sampleBilinear` returns it exactly.
 * Probing a 2x2 image scaled up instead lands between texels, where a blend of
 * a masked and an unmasked neighbour proves nothing.
 */
export const N = 40;

/** Quadrant of pixel (x, y): 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right. */
export const quadrant = (x: number, y: number): number =>
  (y < N / 2 ? 0 : 2) + (x < N / 2 ? 0 : 1);

/**
 * Four quadrants of flat colour. Top-left is the KEYED colour (255,0,0) and
 * top-right is (0,130,0) — which greys to the same 76, so a mask re-derived in
 * grey would take both. That is what the ConvertToGrayscale round trip checks.
 */
const QUAD_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0], [0, 130, 0], [0, 0, 255], [255, 255, 255],
];

function rgbQuadrants(): Uint8Array {
  const out = new Uint8Array(N * N * 3);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = QUAD_RGB[quadrant(x, y)];
    const i = (y * N + x) * 3;
    out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
  }
  return out;
}

/** One bit per pixel, rows padded to a byte: set = masked out. */
function packStencil(masked: (x: number, y: number) => boolean): Uint8Array {
  const rowBytes = (N + 7) >> 3;
  const out = new Uint8Array(rowBytes * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (masked(x, y)) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  return out;
}

type Obj = string | { dict: string; raw: Uint8Array };

const page = (imageObj: Obj, extra: Obj[] = []): Uint8Array => assemble([
  '',
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${N} ${N}] `
    + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
  contentStream(`q ${N} 0 0 ${N} 0 0 cm /Im0 Do Q`),
  imageObj,
  ...extra,
]);

const rgbDict = (mask: string, len: number): string =>
  `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
  + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode `
  + `${mask}/Length ${len} >>`;

/** An RGB image whose top-left quadrant is masked by a colour-key ARRAY. */
export function buildColorKeyRenderPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(rgbQuadrants()));
  return page({ dict: rgbDict('/Mask [250 255 0 5 0 5] ', raw.length), raw });
}

/** The same image, masked by a STENCIL stream — the form 10u9.7 emits. */
export function buildStencilMaskRenderPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(rgbQuadrants()));
  const st = new Uint8Array(deflateSync(packStencil((x, y) => quadrant(x, y) === 0)));
  return page(
    { dict: rgbDict('/Mask 6 0 R ', raw.length), raw },
    [{ dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
        + '/ImageMask true /BitsPerComponent 1 /Decode [0 1] '
        + `/Filter /FlateDecode /Length ${st.length} >>`, raw: st } ],
  );
}

/** A stencil whose own /Decode [1 0] inverts the paint sense: the OTHER three
 *  quadrants mask, and the top-left one paints. */
export function buildInvertedStencilRenderPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(rgbQuadrants()));
  const st = new Uint8Array(deflateSync(packStencil((x, y) => quadrant(x, y) === 0)));
  return page(
    { dict: rgbDict('/Mask 6 0 R ', raw.length), raw },
    [{ dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
        + '/ImageMask true /BitsPerComponent 1 /Decode [1 0] '
        + `/Filter /FlateDecode /Length ${st.length} >>`, raw: st } ],
  );
}

/** An INDEXED image keyed on index 0: its samples are raw indices, one byte
 *  per pixel, so the key is matched against the index and not against a colour. */
export function buildIndexedColorKeyRenderPdf(): Uint8Array {
  const idx = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) idx[y * N + x] = quadrant(x, y);
  const raw = new Uint8Array(deflateSync(idx));
  const palette = QUAD_RGB.flatMap((c) => [...c]).map((v) => v.toString(16).padStart(2, '0')).join('');
  return page({
    dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
      + `/ColorSpace [/Indexed /DeviceRGB 3 <${palette}>] /BitsPerComponent 8 `
      + `/Filter /FlateDecode /Mask [0 0] /Length ${raw.length} >>`,
    raw,
  } );
}

/** Both an /SMask (fully opaque) and a colour-key /Mask that would hide the
 *  top-left quadrant. 32000-1 makes them mutually exclusive; /SMask wins. */
export function buildMaskAndSMaskRenderPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(rgbQuadrants()));
  const sm = new Uint8Array(deflateSync(new Uint8Array(N * N).fill(255)));
  return page(
    { dict: rgbDict('/Mask [250 255 0 5 0 5] /SMask 6 0 R ', raw.length), raw },
    [{ dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
        + '/ColorSpace /DeviceGray /BitsPerComponent 8 '
        + `/Filter /FlateDecode /Length ${sm.length} >>`, raw: sm } ],
  );
}

/** An /SMask soft mask: the top-left quadrant transparent, the rest opaque. */
function smaskBytes(): Uint8Array {
  const out = new Uint8Array(N * N).fill(255);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (quadrant(x, y) === 0) out[y * N + x] = 0;
  }
  return out;
}

const smaskObj = (sm: Uint8Array): Obj => ({
  dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
    + '/ColorSpace /DeviceGray /BitsPerComponent 8 '
    + `/Filter /FlateDecode /Length ${sm.length} >>`,
  raw: sm,
});

/** A Flate RGB image with a genuine /SMask. */
export function buildSMaskRenderPdf(): Uint8Array {
  const raw = new Uint8Array(deflateSync(rgbQuadrants()));
  const sm = new Uint8Array(deflateSync(smaskBytes()));
  return page({ dict: rgbDict('/SMask 6 0 R ', raw.length), raw }, [smaskObj(sm)]);
}

/** The same, but the base image is a JPEG — which cannot carry alpha itself. */
export function buildDctSMaskRenderPdf(): Uint8Array {
  const jpeg = encodeJpeg(N, N, rgbQuadrants(), 'rgb', { quality: 95 });
  const sm = new Uint8Array(deflateSync(smaskBytes()));
  return page({
    dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
      + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
      + `/SMask 6 0 R /Length ${jpeg.length} >>`,
    raw: jpeg,
  }, [smaskObj(sm)]);
}

/** A JPEG with no mask at all: its bytes must still pass through untouched. */
export function buildPlainDctPdf(): Uint8Array {
  const jpeg = encodeJpeg(N, N, rgbQuadrants(), 'rgb', { quality: 95 });
  return page({
    dict: `<< /Type /XObject /Subtype /Image /Width ${N} /Height ${N} `
      + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
      + `/Length ${jpeg.length} >>`,
    raw: jpeg,
  });
}
