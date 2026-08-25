import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeJpeg } from '../src/jpeg.js';
import { readPnm } from './helpers/read-pnm.js';

// JPEGs in the tree that our own test/helpers/build-jpeg*.ts did NOT produce.
// They exist to catch the shared-convention bug class: a marker layout or
// component ordering that our decoder and our fixture builder get wrong in the
// SAME direction, which a round-trip against our own decoder can never see.
//
// Two provenance classes live here, and the difference decides how tightly each
// can assert (see PROVENANCE.md):
//
//   testorig/testimgint/testimgari -- a third-party IMAGE encoded by a
//   third-party encoder. Ground truth (testorig.ppm) is the uncompressed source
//   libjpeg compressed, not a reference decode, so the deltas are real
//   lossy-compression loss on content nobody chose: mean ~1.4, max ~34. Only a
//   statistical bound works; the near(a,b,3) style used in jpeg.test.ts against
//   synthetic fixtures would fail here on legitimate loss.
//
//   synth-* -- OUR source image encoded by a third-party encoder. That still
//   catches the same bug class (the bytes are not ours), but because we chose
//   low-frequency source content the loss is tiny (max 3 and 6), so these assert
//   an order of magnitude tighter than the vendored set can.
//
// Provenance, licence, pinned commit, encoder command lines:
//   test/fixtures/jpeg/PROVENANCE.md
// Design: docs/superpowers/specs/2026-07-17-jpeg-real-fixtures-design.md

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(join(here, 'fixtures/jpeg', name)));

const ref = readPnm(fixture('testorig.ppm'));
const N = ref.width * ref.height * 3;

interface Err { mean: number; max: number; within8: number }

function errorVs(data: Uint8Array, refData: Uint8Array): Err {
  const n = refData.length;
  let sum = 0, max = 0, within8 = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(data[i] - refData[i]);
    sum += d;
    if (d > max) max = d;
    if (d <= 8) within8++;
  }
  return { mean: sum / n, max, within8: within8 / n };
}

const errorVsRef = (data: Uint8Array): Err => errorVs(data, ref.data);

describe('decodeJpeg — real libjpeg fixtures (227x149 RGB 4:2:0)', () => {
  it('reference original is the expected 227x149 P6', () => {
    expect(ref.magic).toBe('P6');
    expect(ref.width).toBe(227);
    expect(ref.height).toBe(149);
    expect(ref.max).toBe(255);
    expect(ref.data.length).toBe(N);
  });

  for (const name of ['testorig.jpg', 'testimgint.jpg']) {
    describe(name, () => {
      const dec = decodeJpeg(fixture(name));

      it('decodes to the frame declared in SOF0', () => {
        expect(dec.width).toBe(227);
        expect(dec.height).toBe(149);
        expect(dec.comps).toBe(3);
        expect(dec.data.length).toBe(N);
      });

      it('reproduces the uncompressed original within lossy tolerance', () => {
        const e = errorVsRef(dec.data);
        expect(e.mean).toBeLessThan(2.0);      // measured: 1.365 / 1.428
        expect(e.max).toBeLessThanOrEqual(40); // measured: 34 / 30
        expect(e.within8).toBeGreaterThanOrEqual(0.97); // measured: 98.21% / 98.14%
      });

      it('reproduces the flat top-left corner exactly', () => {
        // A flat region has no lossy excuse: a wrong DC, quant table, or
        // component order cannot survive this, cheaply and sharply.
        expect([...dec.data.subarray(0, 3)]).toEqual([...ref.data.subarray(0, 3)]);
      });
    });
  }

  it('both baseline encoder configs agree with each other', () => {
    // Same image, different encoder settings: they must land on the same picture
    // even though neither is bit-identical to the original.
    const a = decodeJpeg(fixture('testorig.jpg')).data;
    const b = decodeJpeg(fixture('testimgint.jpg')).data;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += Math.abs(a[i] - b[i]);
    expect(sum / N).toBeLessThan(2.0);
  });
});

// The arithmetic-coded (SOF9 + DAC) sibling of the two baseline fixtures above.
// libjpeg always emits a DAC for an arithmetic frame -- even when it carries the
// plain T.81 defaults -- so this is the only fixture that exercises parseDAC's
// nibble order at all. That is what it caught: L is the LOW nibble of the
// conditioning byte and U the HIGH one (T.81 B.2.4.3), and we had them swapped
// on both the read and the write side, so the synthetic round-trip stayed green.
describe('decodeJpeg — real arithmetic JPEG', () => {
  it('reproduces the uncompressed original within lossy tolerance', () => {
    const dec = decodeJpeg(fixture('testimgari.jpg'));
    expect(dec.width).toBe(227);
    expect(dec.height).toBe(149);
    expect(dec.comps).toBe(3);
    const e = errorVsRef(dec.data);
    expect(e.mean).toBeLessThan(2.0);
    expect(e.max).toBeLessThanOrEqual(40);
    expect(e.within8).toBeGreaterThanOrEqual(0.97);
  });
});

// The progressive (SOF2) sibling, added for 10u9.6. It earned its keep on its
// first run, the way testimgari.jpg did: `decodeScan` looked up BOTH Huffman
// table classes for every scan before reading Ss/Se, so it could not know which
// the scan referenced. A progressive scan codes either the DC coefficient or a
// band of AC ones, never both, and mozjpeg opens with a DC-only scan and sends
// the AC tables afterwards -- so `huffAC[0]` is legitimately absent there and
// every real progressive JPEG was refused at its very first scan with
// "missing Huffman table".
//
// Nothing caught it because the suite's only progressive coverage was a stream
// our own encoder-side test helper built, which declares every table up front.
// This is exactly the shared-convention class test/fixtures/ exists for.
describe('decodeJpeg — real progressive JPEG', () => {
  it('reproduces the uncompressed original within lossy tolerance', () => {
    const dec = decodeJpeg(fixture('testorig-prog.jpg'));
    expect(dec.width).toBe(227);
    expect(dec.height).toBe(149);
    expect(dec.comps).toBe(3);
    const e = errorVsRef(dec.data);
    expect(e.mean).toBeLessThan(2.0);
    expect(e.max).toBeLessThanOrEqual(40);
    expect(e.within8).toBeGreaterThanOrEqual(0.97);
  });
});

// The two configs libjpeg-turbo's testimages/ cannot supply: 1-component
// grayscale, and 3-component RGB with NO chroma subsampling. Real cjpeg bytes
// over a source image we designed, so the .pgm/.ppm beside them is the exact
// input the encoder saw. 61x37 is deliberate: both dimensions are non-multiples
// of 8, so each edge carries a partial MCU.
describe('decodeJpeg — real cjpeg fixtures over a synthetic source (61x37)', () => {
  it('grayscale baseline decodes as 1 component', () => {
    const src = readPnm(fixture('synth-gray.pgm'));
    const dec = decodeJpeg(fixture('synth-gray-baseline.jpg'));
    expect(src.magic).toBe('P5');
    expect(dec.width).toBe(61);
    expect(dec.height).toBe(37);
    expect(dec.comps).toBe(1);           // 1 sample/px, not an RGB-expanded 3
    expect(dec.data.length).toBe(61 * 37);

    const e = errorVs(dec.data, src.data);
    expect(e.mean).toBeLessThan(0.6);    // measured: 0.2503
    expect(e.max).toBeLessThanOrEqual(6); // measured: 3
    // Flat corner: no lossy excuse, so a wrong DC or quant table dies here.
    expect(dec.data[0]).toBe(src.data[0]);
  });

  it('RGB 4:4:4 baseline decodes without subsampling, in R,G,B order', () => {
    const src = readPnm(fixture('synth-rgb.ppm'));
    const dec = decodeJpeg(fixture('synth-rgb444-baseline.jpg'));
    expect(src.magic).toBe('P6');
    expect(dec.width).toBe(61);
    expect(dec.height).toBe(37);
    expect(dec.comps).toBe(3);
    expect(dec.data.length).toBe(61 * 37 * 3);

    const e = errorVs(dec.data, src.data);
    expect(e.mean).toBeLessThan(1.5);     // measured: 0.7734
    expect(e.max).toBeLessThanOrEqual(12); // measured: 6
    // The flat corner's three channels are deliberately distinct (32/96/160), so
    // this pins component ORDER exactly -- a swap cannot alias into a pass.
    expect([...dec.data.subarray(0, 3)]).toEqual([32, 96, 160]);
  });
});

// The one config neither libjpeg-turbo's testimages/ nor cjpeg can supply:
// 4-component CMYK with an Adobe APP14 marker. These are the only bytes in the
// tree that check the APP14 conventions against an encoder that is not us --
// build-jpeg-arith.ts and build-jpeg-lossless.ts write the transform byte AND
// the inversion themselves, so writer and reader agree by construction and the
// round-trip suite can never disagree with itself. src/jpegencode.ts sidesteps
// the branch entirely by emitting CMYK with no APP14 at all.
//
// synth-cmyk.raw is headerless (61*37*4 interleaved C,M,Y,K) and is the exact
// input both encoders read -- ground truth is analytic and ours.
//
// Two encoders because neither reaches the other's branch: ImageMagick always
// writes transform=2 (YCCK), libvips always transform=0. See PROVENANCE.md.
describe('decodeJpeg — real CMYK fixtures over a synthetic source (61x37)', () => {
  const src = fixture('synth-cmyk.raw');
  const N = 61 * 37 * 4;

  it('the authored source is the expected size', () => {
    expect(src.length).toBe(N);
    // The flat corner's four channels are deliberately distinct.
    expect([...src.subarray(0, 4)]).toEqual([32, 96, 160, 64]);
  });

  // transform, mean bound, max bound -- YCCK is looser because it carries an
  // extra lossy YCbCr<->CMY conversion the transform=0 file does not.
  const cases = [
    { name: 'synth-cmyk-t0-baseline.jpg', label: 'Adobe transform=0 (plain CMYK)', mean: 0.5, max: 6 },
    { name: 'synth-cmyk-ycck-baseline.jpg', label: 'Adobe transform=2 (YCCK)', mean: 1.5, max: 16 },
  ];

  for (const { name, label, mean, max } of cases) {
    describe(label, () => {
      const dec = decodeJpeg(fixture(name));

      it('decodes as 4 components at the declared frame size', () => {
        expect(dec.width).toBe(61);
        expect(dec.height).toBe(37);
        expect(dec.comps).toBe(4);
        expect(dec.data.length).toBe(N);
      });

      it('reproduces the authored source within lossy tolerance', () => {
        const e = errorVs(dec.data, src);
        expect(e.mean).toBeLessThan(mean);
        expect(e.max).toBeLessThanOrEqual(max);
      });

      it('reproduces the flat corner exactly, pinning order and inversion', () => {
        // Four distinct values in a flat region: no lossy excuse. A dropped
        // Adobe inversion, a wrong transform branch, or a channel swap all die
        // here -- none of them can land on 32,96,160,64 by accident.
        expect([...dec.data.subarray(0, 4)]).toEqual([32, 96, 160, 64]);
      });
    });
  }

  it('both transforms agree with each other', () => {
    // Same source, different Adobe transform: a wrong YCCK branch cannot agree
    // with a correct transform=0 decode.
    const a = decodeJpeg(fixture('synth-cmyk-t0-baseline.jpg')).data;
    const b = decodeJpeg(fixture('synth-cmyk-ycck-baseline.jpg')).data;
    expect(errorVs(a, b).mean).toBeLessThan(1.5);
  });
});
