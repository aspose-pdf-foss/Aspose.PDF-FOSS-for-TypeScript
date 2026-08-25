import { deflateSync } from 'node:zlib';

/** Minimal hand-built JPEG: a valid SOI + SOF0 (baseline) header with the given
 *  dimensions and component count, then EOI. The entropy-coded scan is omitted —
 *  the library never decodes DCT data, it only parses SOF for metadata and stores
 *  the bytes verbatim, so this is sufficient for tests. */
export function buildJpeg(
  width: number, height: number, components: 1 | 3 | 4,
  opts: { adobe?: boolean } = {},
): Uint8Array {
  const hi = (n: number) => (n >> 8) & 0xff;
  const lo = (n: number) => n & 0xff;
  const bytes: number[] = [0xff, 0xd8]; // SOI
  if (opts.adobe) {
    // APP14 "Adobe" marker: 12-byte payload (Adobe + version/flags/transform).
    const payload = [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 100, 0, 0, 0, 0, 0]; // "Adobe"...
    const segLen = payload.length + 2;
    bytes.push(0xff, 0xee, hi(segLen), lo(segLen), ...payload);
  }
  const sofLen = 8 + components * 3; // 2 len + 1 prec + 2 h + 2 w + 1 nc + comps*3
  bytes.push(0xff, 0xc0, hi(sofLen), lo(sofLen)); // SOF0 marker + length
  bytes.push(8); // precision
  bytes.push(hi(height), lo(height));
  bytes.push(hi(width), lo(width));
  bytes.push(components);
  for (let i = 1; i <= components; i++) bytes.push(i, 0x11, 0); // id, sampling, qtable
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** A PNG chunk: length + type + data + (zero) CRC. The library does not verify
 *  CRCs, so a zero placeholder is fine for fixtures. */
function chunk(type: string, data: number[]): number[] {
  const t = [...type].map((c) => c.charCodeAt(0));
  return [...u32(data.length), ...t, ...data, 0, 0, 0, 0];
}

/** Build an 8-bit PNG. colorType: 0 gray, 2 RGB, 3 palette, 6 RGBA.
 *  `rows` is the unfiltered sample data, one number per byte, row-major. */
function buildPng(
  width: number, height: number, colorType: 0 | 2 | 3 | 6,
  rows: number[], opts: { palette?: number[]; trns?: number[] } = {},
): Uint8Array {
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : 4;
  const rowLen = width * channels;
  // prefix each scanline with filter byte 0 (None)
  const filtered: number[] = [];
  for (let r = 0; r < height; r++) {
    filtered.push(0);
    filtered.push(...rows.slice(r * rowLen, (r + 1) * rowLen));
  }
  const idat = [...deflateSync(Buffer.from(filtered))];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32(width), ...u32(height), 8, colorType, 0, 0, 0];
  const out = [...sig, ...chunk('IHDR', ihdr)];
  if (colorType === 3 && opts.palette) out.push(...chunk('PLTE', opts.palette));
  if (colorType === 3 && opts.trns) out.push(...chunk('tRNS', opts.trns)); // after PLTE, before IDAT
  out.push(...chunk('IDAT', idat));
  out.push(...chunk('IEND', []));
  return new Uint8Array(out);
}

/** A 3x1 indexed PNG with a tRNS chunk: index 0 transparent, index 1 semi
 *  (alpha 128), index 2 opaque-by-default (no tRNS entry). */
export function buildPngPaletteTrns(): { png: Uint8Array; expectedAlpha: number[] } {
  const png = buildPng(3, 1, 3, [0, 1, 2], {
    palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
    trns: [0, 128],
  });
  return { png, expectedAlpha: [0, 128, 255] };
}

/** 2x1 RGB image: red, green. */
export function buildPngRgb(): Uint8Array {
  return buildPng(2, 1, 2, [255, 0, 0, 0, 255, 0]);
}

/** 2x1 grayscale image. */
export function buildPngGray(): Uint8Array {
  return buildPng(2, 1, 0, [0x10, 0x20]);
}

/** 2x1 palette image (palette: red, green). */
export function buildPngPalette(): Uint8Array {
  return buildPng(2, 1, 3, [0, 1], { palette: [255, 0, 0, 0, 255, 0] });
}

/** 1x1 RGBA image: red at 50% alpha. Exposes the sample values so tests can
 *  assert the color/alpha split. */
export const RGBA_PIXEL = { r: 255, g: 0, b: 0, a: 128 };
export function buildPngRgba(): Uint8Array {
  const p = RGBA_PIXEL;
  return buildPng(1, 1, 6, [p.r, p.g, p.b, p.a]);
}

/** An interlaced (Adam7) PNG, for the rejection test. */
export function buildPngInterlaced(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32(1), ...u32(1), 8, 2, 0, 0, 1]; // interlace=1
  const idat = [...deflateSync(Buffer.from([0, 0, 0, 0]))];
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', [])]);
}

const ADAM7: [number, number, number, number][] = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

/** Build an 8-bit RGB PNG, either non-interlaced or Adam7-interlaced, from the
 *  same row-major RGB sample array (3 bytes per pixel). */
export function buildPngRgbWith(
  width: number, height: number, rgb: number[], interlace: 0 | 1,
): Uint8Array {
  const filtered: number[] = [];
  const pushRow = (samples: number[]) => { filtered.push(0, ...samples); };
  if (interlace === 0) {
    for (let y = 0; y < height; y++) pushRow(rgb.slice(y * width * 3, (y + 1) * width * 3));
  } else {
    for (const [xs, ys, xstep, ystep] of ADAM7) {
      const pw = xs >= width ? 0 : Math.ceil((width - xs) / xstep);
      const ph = ys >= height ? 0 : Math.ceil((height - ys) / ystep);
      if (pw === 0 || ph === 0) continue;
      for (let r = 0; r < ph; r++) {
        const row: number[] = [];
        for (let c = 0; c < pw; c++) {
          const x = xs + c * xstep, y = ys + r * ystep;
          row.push(rgb[(y * width + x) * 3], rgb[(y * width + x) * 3 + 1], rgb[(y * width + x) * 3 + 2]);
        }
        pushRow(row);
      }
    }
  }
  const idat = [...deflateSync(Buffer.from(filtered))];
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [...u32(width), ...u32(height), 8, 2, 0, 0, interlace];
  return new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', [])]);
}
