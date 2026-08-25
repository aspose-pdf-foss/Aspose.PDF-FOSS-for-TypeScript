import { deflateSync } from 'node:zlib';
import { crc32 } from './crc32.js';

export type PngKind = 'gray' | 'rgb' | 'rgba';

const CHANNELS: Record<PngKind, number> = { gray: 1, rgb: 3, rgba: 4 };
const COLOR_TYPE: Record<PngKind, number> = { gray: 0, rgb: 2, rgba: 6 };

function u32(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 8 + data.length);
  return out;
}

/** Encode row-major 8-bit samples into a complete PNG file. */
export function encodePng(width: number, height: number, samples: Uint8Array, kind: PngKind): Uint8Array {
  const ch = CHANNELS[kind];
  const stride = width * ch;
  // Prefix each row with filter byte 0 (None).
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(samples.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(Buffer.from(raw)));

  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;                 // bit depth
  ihdr[9] = COLOR_TYPE[kind];  // color type
  // ihdr[10..12] = 0: deflate, no filter, no interlace

  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** A `data:` URI for the given PNG bytes. */
export function pngDataUri(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}
