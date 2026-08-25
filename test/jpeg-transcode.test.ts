import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeJpegFrame, decodeJpeg, jpegTransform, idct, ZIGZAG } from '../src/jpeg.js';
import { encodeJpeg } from '../src/jpegencode.js';
import { greyJpegFromCoefficients } from '../src/jpegtranscode.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, 'fixtures/jpeg', name)));

const rgbBytes = (w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { out[i * 3] = 200; out[i * 3 + 1] = 60; out[i * 3 + 2] = 30; }
  return out;
};

/** A two-axis ramp with an 8px bar, so no two 8x8 blocks are alike. A flat
 *  colour cannot detect a mis-walked block grid: every block is the same. */
const rampBytes = (w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3;
    out[i] = (x * 11 + ((y >> 3) & 1) * 70) & 0xff;
    out[i + 1] = (y * 13 + ((x >> 3) & 1) * 50) & 0xff;
    out[i + 2] = (x * 5 + y * 7) & 0xff;
  }
  return out;
};

/**
 * Rewrite a baseline JPEG's three component ids, in BOTH places they appear.
 *
 * SOF0 (0xffc0) carries precision(1) height(2) width(2) nc(1) then a 3-byte
 * spec per component, whose first byte is the id. SOS (0xffda) carries ns(1)
 * then a 2-byte selector per component, whose first byte is that same id --
 * `decodeScan` looks each one up and throws `bad scan component` if the two
 * disagree, so patching only the SOF produces a file no decoder will read.
 */
function setComponentIds(jpeg: Uint8Array, ids: number[]): Uint8Array {
  const out = jpeg.slice();
  let sof = false, sos = false;
  for (let p = 2; p + 3 < out.length && !(sof && sos); ) {
    if (out[p] !== 0xff) { p++; continue; }
    const marker = out[p + 1];
    const len = (out[p + 2] << 8) | out[p + 3];
    if (marker === 0xc0) {
      const base = p + 4 + 6;
      for (let i = 0; i < ids.length; i++) out[base + i * 3] = ids[i];
      sof = true;
    } else if (marker === 0xda) {
      const base = p + 4 + 1;
      for (let i = 0; i < ids.length; i++) out[base + i * 2] = ids[i];
      sos = true;
    }
    p += 2 + len;
  }
  if (!sof || !sos) throw new Error('no SOF0/SOS pair in the fixture');
  return out;
}

describe('decodeJpegFrame', () => {
  it('returns the decoded frame with its quantized blocks, not samples', () => {
    const jpeg = encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 });

    const { frame, qt, adobe } = decodeJpegFrame(jpeg);

    expect(frame.comps).toHaveLength(3);
    expect(frame.width).toBe(16);
    expect(frame.precision).toBe(8);
    expect(adobe).toBeUndefined();
    expect(qt[0]).toBeDefined();
    // A flat colour still has a non-zero DC in every block.
    expect(frame.comps[0].blocks[0]).not.toBe(0);
  });
});

describe('jpegTransform', () => {
  it('reports 1 for a three-component JPEG with ordinary numeric ids', () => {
    const jpeg = encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 });
    const { frame, adobe } = decodeJpegFrame(jpeg);
    expect(jpegTransform(frame, adobe)).toBe(1);
  });

  it("reports 0 for SOF ids 'R','G','B', whose component 0 is red and not luma", () => {
    // libtiff writes exactly this for a JPEG-compressed RGB TIFF. Mistaking it
    // for YCbCr means greying an image to its red channel, which renders as a
    // plausible photograph with nothing to flag it.
    const jpeg = setComponentIds(
      encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 }),
      [0x52, 0x47, 0x42],
    );
    const { frame, adobe } = decodeJpegFrame(jpeg);
    expect(jpegTransform(frame, adobe)).toBe(0);
  });

  it('lets an Adobe marker outrank the id test, since it states intent', () => {
    const jpeg = setComponentIds(
      encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 }),
      [0x52, 0x47, 0x42],
    );
    const { frame } = decodeJpegFrame(jpeg);
    expect(jpegTransform(frame, 1)).toBe(1);
  });
});

/**
 * Component 0's decoded plane, which for a YCbCr JPEG is its Y channel.
 *
 * Deliberately re-implemented here rather than reached through `assemble`: the
 * point is to compare the transcoder's output against the INPUT file's own
 * luma, so the anchor must not be anything the transcoder produced. Returns the
 * padded plane, `blocksPerLine * 8` wide.
 */
function yPlane(jpeg: Uint8Array): { data: Uint8Array; pw: number } {
  const { frame, qt } = decodeJpegFrame(jpeg);
  const c = frame.comps[0];
  const q = qt[c.tq]!;
  const qn = new Int32Array(64);
  for (let k = 0; k < 64; k++) qn[ZIGZAG[k]] = q[k];
  const pw = c.blocksPerLine * 8;
  const data = new Uint8Array(pw * c.blocksPerColumn * 8);
  const dq = new Int32Array(64);
  const px = new Array<number>(64);
  for (let br = 0; br < c.blocksPerColumn; br++) for (let bc = 0; bc < c.blocksPerLine; bc++) {
    const off = (br * c.bpl + bc) * 64;
    for (let i = 0; i < 64; i++) dq[i] = c.blocks[off + i] * qn[i];
    idct(dq, 0, px, 128, 255);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      data[(br * 8 + y) * pw + (bc * 8 + x)] = px[y * 8 + x];
  }
  return { data, pw };
}

/** Every pixel of `got` equals the input's own Y at the same coordinate. */
function expectMatchesY(got: { width: number; height: number; data: Uint8Array }, src: Uint8Array): void {
  const y = yPlane(src);
  let mismatches = 0;
  let first = '';
  for (let row = 0; row < got.height; row++) for (let col = 0; col < got.width; col++) {
    const a = got.data[row * got.width + col], b = y.data[row * y.pw + col];
    if (a !== b && mismatches++ === 0) first = `at (${col},${row}): got ${a}, Y is ${b}`;
  }
  expect(mismatches === 0 ? 'exact' : `${mismatches} mismatches, ${first}`).toBe('exact');
}

/** True when `data` contains the two-byte marker anywhere before the scan. */
const hasMarker = (data: Uint8Array, second: number): boolean => {
  for (let i = 0; i + 1 < data.length; i++) if (data[i] === 0xff && data[i + 1] === second) return true;
  return false;
};

describe('greyJpegFromCoefficients — exactness', () => {
  it('reproduces the input JPEG\u2019s own Y plane byte for byte', () => {
    const src = fixture('testorig.jpg');            // libjpeg baseline, 227x149, 4:2:0
    const r = greyJpegFromCoefficients(src);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.width).toBe(227);
    expect(r.height).toBe(149);

    const got = decodeJpeg(r.data);
    expect(got.comps).toBe(1);
    expect(got.width).toBe(227);
    expect(got.height).toBe(149);

    // The anchor is the ORIGINAL file's luma, not our encoder. Same
    // coefficients through the same quant table and the same IDCT, so this is
    // equality rather than a tolerance -- which is the whole claim.
    expectMatchesY(got, src);
  });

  it('does the same for an arithmetic-coded JPEG, emitting baseline Huffman', () => {
    const src = fixture('testimgari.jpg');
    const r = greyJpegFromCoefficients(src);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    const got = decodeJpeg(r.data);
    expect(got.comps).toBe(1);
    expectMatchesY(got, src);

    // SOF0, not SOF9: the output is always baseline whatever went in.
    expect(hasMarker(r.data, 0xc0)).toBe(true);
    expect(hasMarker(r.data, 0xc9)).toBe(false);
  });

  it('reproduces a progressive JPEG’s Y plane, emitting baseline output', () => {
    // The one input shape whose coefficients arrive through successive
    // approximation rather than in a single pass, and today's worst case:
    // before 10u9.6 a progressive JPEG was decoded and re-encoded in full.
    const src = fixture('testorig-prog.jpg');
    const { frame } = decodeJpegFrame(src);
    expect(frame.progressive).toBe(true);

    const r = greyJpegFromCoefficients(src);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;

    const got = decodeJpeg(r.data);
    expect(got.comps).toBe(1);
    expect(got.width).toBe(227);
    expectMatchesY(got, src);

    // SOF0, not SOF2.
    expect(hasMarker(r.data, 0xc0)).toBe(true);
    expect(hasMarker(r.data, 0xc2)).toBe(false);
  });
});

describe('greyJpegFromCoefficients — structure', () => {
  it('carries component 0\u2019s coefficients and quant table through unchanged', () => {
    const src = fixture('testorig.jpg');
    const r = greyJpegFromCoefficients(src);
    if (r.kind !== 'ok') throw new Error(r.reason);

    const a = decodeJpegFrame(src);
    const b = decodeJpegFrame(r.data);

    // Quant table: the input's, verbatim. A doubly-permuted table would still
    // decode, with the wrong frequencies scaled -- invisible to a pixel test on
    // smooth content.
    expect([...b.qt[b.frame.comps[0].tq]!]).toEqual([...a.qt[a.frame.comps[0].tq]!]);

    // Coefficients: every block of the un-padded grid, natural order both sides.
    const ca = a.frame.comps[0], cb = b.frame.comps[0];
    expect(cb.blocksPerLine).toBe(ca.blocksPerLine);
    expect(cb.blocksPerColumn).toBe(ca.blocksPerColumn);
    for (let by = 0; by < ca.blocksPerColumn; by++) for (let bx = 0; bx < ca.blocksPerLine; bx++) {
      const oa = (by * ca.bpl + bx) * 64, ob = (by * cb.bpl + bx) * 64;
      expect([...cb.blocks.slice(ob, ob + 64)]).toEqual([...ca.blocks.slice(oa, oa + 64)]);
    }
  });
});

describe('greyJpegFromCoefficients — the MCU padding trap', () => {
  // At 4:2:0 the Y plane's grid is ceil(w/16)*2 blocks wide, while a
  // one-component frame needs ceil(w/8). Those differ by one whenever w mod 16
  // falls in 1..8 -- 20 mod 16 = 4 -- so a build that re-emits the padding
  // produces a file that still decodes, just wider than its own SOF claims.
  it('drops the padding column and row rather than re-emitting them', () => {
    const w = 20, h = 20;
    // A GRADIENT, not a flat colour: every block must differ from its
    // neighbours, or reading the grid one column too wide shuffles blocks that
    // happen to be identical and nothing observable changes.
    const src = encodeJpeg(w, h, rampBytes(w, h), 'rgb', { quality: 90, subsampling: '4:2:0' });

    const a = decodeJpegFrame(src);
    expect(a.frame.comps[0].bpl).toBe(4);            // ceil(20/16) * 2, padded
    expect(a.frame.comps[0].blocksPerLine).toBe(3);  // ceil(20/8), real

    const r = greyJpegFromCoefficients(src);
    if (r.kind !== 'ok') throw new Error(r.reason);

    // MEASURED, and the reason this case asserts pixels at all: the three
    // header fields below are BLIND to the bug. A decoder derives bpl and
    // blocksPerLine from the SOF width, which the transcoder writes from
    // `frame.width` either way -- so a build that walked the padded grid emits
    // 16 blocks into a 3-wide layout, shuffling the image, while every header
    // assertion here still passes. Only the content shows it.
    expectMatchesY(decodeJpeg(r.data), src);

    const b = decodeJpegFrame(r.data);
    expect(b.frame.width).toBe(w);
    expect(b.frame.comps[0].bpl).toBe(3);
    expect(b.frame.comps[0].blocksPerColumn).toBe(3);
  });
});

describe('greyJpegFromCoefficients — what it declines', () => {
  const decline = (jpeg: Uint8Array): string => {
    const r = greyJpegFromCoefficients(jpeg);
    if (r.kind !== 'decline') throw new Error('expected a decline');
    return r.reason;
  };

  it("declines SOF ids 'R','G','B', whose component 0 is red rather than luma", () => {
    const jpeg = setComponentIds(
      encodeJpeg(16, 16, rgbBytes(16, 16), 'rgb', { quality: 90 }),
      [0x52, 0x47, 0x42],
    );
    expect(decline(jpeg)).toMatch(/luma|transform/i);
  });

  it('declines a CMYK JPEG, whose component 0 is cyan', () => {
    const cmyk = new Uint8Array(16 * 16 * 4).fill(80);
    expect(decline(encodeJpeg(16, 16, cmyk, 'cmyk', { quality: 90 }))).toMatch(/component/i);
  });

  it('declines a one-component JPEG, which is already grey', () => {
    expect(decline(fixture('synth-gray-baseline.jpg'))).toMatch(/component/i);
  });

  it('declines rather than throwing on bytes that are not a JPEG', () => {
    expect(decline(new Uint8Array([1, 2, 3, 4]))).toMatch(/parse/i);
  });
});
