import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeJpeg, type JpegKind, type JpegEncodeOptions } from '../src/jpegencode.js';

/** A REGRESSION FENCE for 10u9.6's extraction of `encodeJpeg`'s back half into
 *  `jpegcoef.ts`, not a feature test. The entropy coder, the Huffman table
 *  selection and the marker assembly move out of `encodeJpeg` and are claimed
 *  byte-identical for every existing caller.
 *
 *  The hashes were recorded BEFORE the extraction. If one changes, the
 *  extraction moved a table, a marker or an allocation order: find out why
 *  rather than re-recording.
 *
 *  WHAT IT COVERS THAT THE REST OF THE SUITE DOES NOT, measured rather than
 *  assumed -- two mutations were applied to `encodeJpeg` in turn:
 *
 *    DHT writes reordered (AC tables before DC)
 *        this file  RED (9 of 9 hash cases)
 *        jpeg / jpeg-real / grayimage / grayscale-convert  ALL GREEN (95)
 *
 *    every quantization table value reduced by one
 *        this file  RED (9 of 9)
 *        grayimage  RED -- its DCT-route case asserts a decoded value within
 *                   +/-6 of 76, and the nudge pushes it out
 *
 *  So the marker-order class is the one that is invisible everywhere else, and
 *  it is the sharper reason this file exists: a decoder indexes Huffman tables
 *  by class and id out of the DHT payload, so their write order is free to
 *  change without altering a single decoded pixel. Do NOT read the quant-nudge
 *  row as evidence that pixel tests would catch a general regression here. */

/** A deterministic source: a diagonal ramp plus an 8px bar, so the DCT output
 *  is neither flat (which quantizes to nothing) nor noise (which defeats the
 *  Huffman optimizer). 61x37 makes both edges a partial MCU. */
function samples(w: number, h: number, nch: number): Uint8Array {
  const out = new Uint8Array(w * h * nch);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < nch; c++) {
      out[(y * w + x) * nch + c] = (x * 3 + y * 5 + c * 61 + ((x >> 3) & 1) * 40) & 0xff;
    }
  }
  return out;
}

const W = 61, H = 37;
const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

interface Case { name: string; kind: JpegKind; opts: JpegEncodeOptions; sha: string }

/** Every branch `encodeJpeg` has: the three channel counts, both subsampling
 *  modes, two qualities (which scale the quant tables differently), and the
 *  non-optimized path that emits the Annex K standard tables. */
const CASES: Case[] = [
  { name: 'gray q50', kind: 'gray', opts: { quality: 50 }, sha: '8a8fd10049484a1f966cb98e8b7cd407c44b30bf89ff6eab1394320030309614' },
  { name: 'gray q90', kind: 'gray', opts: { quality: 90 }, sha: '9c186ff1e588b598926213da90b8806039495f357bb5efe981492986c8c2ffae' },
  { name: 'rgb 4:4:4 q50', kind: 'rgb', opts: { quality: 50, subsampling: '4:4:4' }, sha: '0af6397630cd5d70d9d67a31a2a8a4bf4db569d87c088a2cf5b79522ae7d4b11' },
  { name: 'rgb 4:4:4 q90', kind: 'rgb', opts: { quality: 90, subsampling: '4:4:4' }, sha: '5411c8aee3aecf06b728918fea41480c328650c2b88c658c3e9d31de0465a48a' },
  { name: 'rgb 4:2:0 q50', kind: 'rgb', opts: { quality: 50, subsampling: '4:2:0' }, sha: '7b692f48511973fd85fc9ed4411ed1f4a9001fe1e49c8a67ecaeab8082be9bf6' },
  { name: 'rgb 4:2:0 q90', kind: 'rgb', opts: { quality: 90, subsampling: '4:2:0' }, sha: '16f7e9bc5649b2aa633850e8a8b345e234181a5ec8279a7fb9a63883c9767abd' },
  { name: 'rgb 4:2:0 q75 std tables', kind: 'rgb', opts: { optimizeHuffman: false }, sha: '225d5b3f2b917486bc0c8ef84dd5875e1bdddac7da62addce6859423fc2be48c' },
  { name: 'cmyk q50', kind: 'cmyk', opts: { quality: 50 }, sha: 'f339fe16dad23c4ac6b0c0077c349001ac8b46602432aebef10c257b79ed868e' },
  { name: 'cmyk q90', kind: 'cmyk', opts: { quality: 90 }, sha: 'd21c7f9f7cc1353ae7cff4583517f6ea1ef2f762a0abeb210c980126802b249e' },
];

const encode = (c: Case): Uint8Array =>
  encodeJpeg(W, H, samples(W, H, CHANNELS[c.kind]), c.kind, c.opts);

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('encodeJpeg — byte-identity fence', () => {
  for (const c of CASES) {
    it(`is byte-identical for ${c.name}`, () => {
      expect(sha256(encode(c))).toBe(c.sha);
    });
  }

  it('is reproducible: two encodes of one input agree', () => {
    expect(sha256(encode(CASES[4]))).toBe(sha256(encode(CASES[4])));
  });
});
