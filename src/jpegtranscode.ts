/**
 * Grey a JPEG in the coefficient domain.
 *
 * A YCbCr JPEG's Y channel IS Rec. 601 luma, so greying one by decoding to RGB
 * and re-encoding re-derives, lossily, a number the file already holds exactly.
 * Keeping component 0's quantized coefficients and its quantization table
 * verbatim and dropping the chroma is exact, generation-free, and smaller.
 *
 * Pure: bytes in, bytes out, no PDF objects. Declines rather than throwing, so
 * a caller falls back to the sample route with nothing to catch.
 */
import { ZIGZAG, decodeJpegFrame, jpegTransform } from './jpeg.js';
import { isHierarchical } from './jpeghier.js';
import { encodeJpegFromBlocks } from './jpegcoef.js';

export type TranscodeResult =
  | { kind: 'ok'; data: Uint8Array; width: number; height: number }
  | { kind: 'decline'; reason: string };

export function greyJpegFromCoefficients(data: Uint8Array): TranscodeResult {
  const no = (reason: string): TranscodeResult => ({ kind: 'decline', reason });

  // A hierarchical JPEG has no single frame to take coefficients from, and
  // decodeJpegFrame does not handle one.
  if (isHierarchical(data)) return no('hierarchical JPEG has no single DCT frame');

  let parsed;
  try { parsed = decodeJpegFrame(data); }
  catch (e) { return no(`parse failed: ${(e as Error).message}`); }
  const { frame, adobe } = parsed;

  if (frame.lossless) return no('lossless JPEG carries no DCT coefficients');
  if (frame.precision !== 8) {
    return no(`precision ${frame.precision} is not 8, which the baseline writer emits`);
  }
  if (frame.comps.length !== 3) {
    return no(`${frame.comps.length} components, and only a 3-component YCbCr JPEG has luma in component 0`);
  }
  // The decisive test. Transform 0 means component 0 is RED, and keeping it
  // would emit the red channel as grey -- see jpegTransform's own comment.
  if (jpegTransform(frame, adobe) === 0) {
    return no('colour transform 0: component 0 is not luma');
  }

  const c = frame.comps[0];
  if (c.h !== frame.maxH || c.v !== frame.maxV) {
    return no('component 0 is subsampled relative to the frame');
  }
  const wire = c.quant;
  if (!wire) return no('component 0 has no quantization table');

  // parseDQT stores WIRE order, which is zig-zag; CoefFrame.quant is natural.
  const quant = new Int32Array(64);
  for (let k = 0; k < 64; k++) quant[ZIGZAG[k]] = wire[k];

  // The blocks of the REAL grid, dropping the MCU padding: at 4:2:0 the Y
  // plane is ceil(w/16)*2 blocks wide where a one-component frame needs
  // ceil(w/8), and re-emitting the difference yields a file wider than its own
  // SOF. `blocksPerLine`/`blocksPerColumn` are already those real counts, and
  // equal the output's because component 0 carries the frame's max sampling.
  const blocks: Int32Array[] = [];
  for (let by = 0; by < c.blocksPerColumn; by++) {
    for (let bx = 0; bx < c.blocksPerLine; bx++) {
      const off = (by * c.bpl + bx) * 64;
      // The one natural->zig-zag transposition in the system.
      const zz = new Int32Array(64);
      for (let k = 0; k < 64; k++) zz[k] = c.blocks[off + ZIGZAG[k]];
      blocks.push(zz);
    }
  }

  const out = encodeJpegFromBlocks({
    width: frame.width,
    height: frame.height,
    // One component at 1x1: the chroma is gone, so there is nothing to
    // subsample against and the MCU grid is the block grid.
    comps: [{ blocks, h: 1, v: 1, tq: 0, td: 0 }],
    quant: [quant],
    jfif: true,
    // Rebuilt: the input's tables were tuned for three interleaved components,
    // and a progressive or arithmetic input carries no baseline tables at all.
    optimizeHuffman: true,
  });
  return { kind: 'ok', data: out, width: frame.width, height: frame.height };
}
