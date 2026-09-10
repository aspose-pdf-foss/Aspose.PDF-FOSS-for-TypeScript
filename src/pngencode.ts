import { deflateSync } from 'node:zlib';
import { crc32 } from './crc32.js';

/** `'bilevel'` is colour type 0 at BIT DEPTH 1, packed MSB-first with rows
 *  padded to a byte.
 *
 *  **Its polarity is the OPPOSITE of TIFF's:** PNG greyscale means 0 is BLACK,
 *  where a bilevel TIFF here declares PhotometricInterpretation 0 (WhiteIsZero)
 *  and carries 1 = black. The packing is identical and only the meaning of a
 *  set bit differs, which is why the caller states the polarity rather than
 *  each format keeping its own packer — get it backwards and the file is a
 *  perfect negative, which reads as a deliberate effect rather than a fault. */
export type PngKind = 'gray' | 'rgb' | 'rgba' | 'bilevel';

const CHANNELS: Record<PngKind, number> = { gray: 1, rgb: 3, rgba: 4, bilevel: 1 };
const COLOR_TYPE: Record<PngKind, number> = { gray: 0, rgb: 2, rgba: 6, bilevel: 0 };
/** Bits per sample by kind. Only bilevel is sub-byte. */
const BIT_DEPTH: Record<PngKind, number> = { gray: 8, rgb: 8, rgba: 8, bilevel: 1 };

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
  // A bilevel row is already packed to a byte boundary by the caller, so the
  // stride follows the BIT depth rather than the channel count.
  const stride = kind === 'bilevel' ? (width + 7) >> 3 : width * ch;
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
  ihdr[8] = BIT_DEPTH[kind];   // bit depth
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
