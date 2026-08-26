/**
 * 24-bit BMP **writer**, the counterpart to `bmp.ts`'s reader.
 *
 * Note the direction, and that the two share no code — only a format and the
 * two stride helpers, which `bmp.ts` already owns and exports. Pure: bytes in,
 * bytes out, no `Document` and no PDF object.
 *
 * Only the uncompressed 24-bit form is written. `bmp.ts` reads far more —
 * palettes, RLE, bitfields, embedded JPEG/PNG — but a writer has to CHOOSE one
 * encoding, and 24-bit BI_RGB is the form every reader in existence handles.
 * A palette would mean quantization, which is `gifencode.ts`'s problem and not
 * one BMP needs to have.
 *
 * **Invariant:** rows are written BOTTOM-UP under a positive height. That is
 * BMP's own convention and the opposite of the top-down samples this library
 * holds everywhere else — `bmp.ts` centralises the flip on the reading side in
 * `eachRowTopDown` for exactly this reason. Getting it wrong produces a
 * vertically mirrored image, which is a plausible picture rather than an
 * obvious fault, so `test/raster-bmp.test.ts` pins it with a fixture that is
 * asymmetric top-to-bottom; a left/right one cannot see the flip at all.
 *
 * **Invariant:** each row is padded to a 4-byte boundary (`fileStride`), which
 * is a different number from the packed row length whenever the width is not a
 * multiple of 4. Writing the packed length instead walks progressively further
 * into the wrong row — a shear, not a crash.
 */

import { fileStride } from './bmp.js';

const FILE_HEADER = 14;
const DIB_HEADER = 40;      // BITMAPINFOHEADER

/**
 * Encode interleaved top-down 8-bit RGB as an uncompressed 24-bit BMP.
 *
 * @param width   pixels, ≥ 1
 * @param height  pixels, ≥ 1
 * @param samples `width * height * 3` bytes, RGB order, TOP-DOWN
 */
export function encodeBmp(width: number, height: number, samples: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new TypeError('encodeBmp: width and height must be positive integers');
  const want = width * height * 3;
  if (samples.length !== want)
    throw new TypeError(`encodeBmp: expected ${want} samples, got ${samples.length}`);

  const stride = fileStride(width, 24);
  const offBits = FILE_HEADER + DIB_HEADER;
  const out = new Uint8Array(offBits + stride * height);
  const dv = new DataView(out.buffer);

  // --- BITMAPFILEHEADER ---
  out[0] = 0x42; out[1] = 0x4d;                 // "BM"
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, offBits, true);

  // --- BITMAPINFOHEADER ---
  dv.setUint32(14, DIB_HEADER, true);
  dv.setInt32(18, width, true);
  // POSITIVE height, which is what selects bottom-up storage. A negative height
  // would mean top-down and let the rows be written in the order we hold them,
  // but several readers still do not accept it, and the whole point of writing
  // BMP at all is that everything opens it.
  dv.setInt32(22, height, true);
  dv.setUint16(26, 1, true);                    // planes
  dv.setUint16(28, 24, true);                   // bits per pixel
  dv.setUint32(30, 0, true);                    // BI_RGB
  dv.setUint32(34, stride * height, true);      // image size
  dv.setUint32(38, 2835, true);                 // ~72 DPI, pixels per metre
  dv.setUint32(42, 2835, true);

  // --- pixel array: bottom-up, BGR, row-padded ---
  for (let y = 0; y < height; y++) {
    const src = y * width * 3;
    const dst = offBits + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      out[dst + x * 3]     = samples[src + x * 3 + 2];   // B
      out[dst + x * 3 + 1] = samples[src + x * 3 + 1];   // G
      out[dst + x * 3 + 2] = samples[src + x * 3];       // R
    }
    // The pad bytes are already zero from the allocation.
  }
  return out;
}
