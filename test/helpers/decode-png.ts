import { inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;          // 1 gray, 3 rgb, 4 rgba
  colorType: number;         // 0 gray, 2 rgb, 6 rgba
  data: Uint8Array;          // row-major, `channels` bytes per pixel
  /** Return [r,g,b,a] (0..255) for pixel (x,y); gray/rgb pad to opaque. */
  at(x: number, y: number): [number, number, number, number];
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Decode an 8-bit non-interlaced PNG (gray/RGB/RGBA, filter types 0-4). */
export function decodePng(bytes: Uint8Array): DecodedPng {
  let off = 8;                 // skip signature
  let width = 0, height = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = u32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = u32(data, 0); height = u32(data, 4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map((u) => Buffer.from(u)))));
  const out = new Uint8Array(stride * height);
  const bpp = channels;                       // 8-bit only, so bytes-per-pixel == channels
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;          // left
      const b = prev ? prev[i] : 0;                    // above
      const c = prev && i >= bpp ? prev[i - bpp] : 0;  // upper-left
      let v: number;
      if (f === 0) v = src[i];
      else if (f === 1) v = src[i] + a;
      else if (f === 2) v = src[i] + b;
      else if (f === 3) v = src[i] + ((a + b) >> 1);
      else if (f === 4) v = src[i] + paeth(a, b, c);
      else throw new Error(`unexpected PNG filter ${f} on row ${y}`);
      row[i] = v & 255;
    }
  }
  return {
    width, height, channels, colorType, data: out,
    at(x: number, y: number) {
      const i = (y * width + x) * channels;
      if (channels === 1) return [out[i], out[i], out[i], 255];
      if (channels === 3) return [out[i], out[i + 1], out[i + 2], 255];
      return [out[i], out[i + 1], out[i + 2], out[i + 3]];
    },
  };
}
