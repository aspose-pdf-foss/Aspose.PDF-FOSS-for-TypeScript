import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodeTiff, tiffPageCount } from '../src/tiff.js';
import { encodeTiff } from '../src/tiffencode.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/** Red on the left half, so a decoded pixel says whether THIS page was
 *  encoded rather than a blank field of the right size — the miss that the
 *  JPEG work measured, where dimensions come from the header either way. */
const page = (h = 90) => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, 120, h],
  content: `1 0 0 rg 0 0 60 ${h} re f`,
})).Pages[0];

/** Assert against our own TIFF DECODER, which is anchored outside this repo:
 *  `test/fixtures/tiff/` holds libtiff- and utif2-written files with ground
 *  truth from a third decoder. That is what makes it a usable oracle here
 *  rather than the differential trap of a writer checked by its own reader. */
const rgbAt = (img: { width: number; samples: Uint8Array }, x: number, y: number) => {
  const p = (y * img.width + x) * 3;
  return [img.samples[p], img.samples[p + 1], img.samples[p + 2]];
};

/** How many strips IFD 0 declares, read straight out of tag 273's count field.
 *  Deliberately parsed here rather than taken from the decoder: the decoder
 *  reassembles strips into one raster, so it cannot report how many there were,
 *  which is the whole thing under test. */
function stripCount(t: Uint8Array): number {
  const dv = new DataView(t.buffer, t.byteOffset, t.length);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    if (dv.getUint16(at, true) === 273) return dv.getUint32(at + 4, true);
  }
  throw new Error('no StripOffsets tag');
}

describe('page.ToImage — TIFF output', () => {
  it('emits a decodable RGB TIFF at the page pixel size', () => {
    const img = decodeTiff(page().ToImage({ format: 'tiff' }));

    if (img.kind !== 'rgb') throw new Error(`expected rgb, got ${img.kind}`);
    expect(img.width).toBe(120);
    expect(img.height).toBe(90);
  });

  it('encodes the page content, not an empty canvas', () => {
    const img = decodeTiff(page().ToImage({ format: 'tiff' }));
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    const [lr, lg, lb] = rgbAt(img, 30, 45);
    expect([lr, lg, lb]).toEqual([255, 0, 0]);
    expect(rgbAt(img, 90, 45)).toEqual([255, 255, 255]);
  });

  it('opens as a little-endian TIFF', () => {
    const t = page().ToImage({ format: 'tiff' });

    expect([t[0], t[1]]).toEqual([0x49, 0x49]);   // "II"
    expect(t[2] | (t[3] << 8)).toBe(42);
  });

  it('compresses by default, and `none` round-trips to the same pixels', () => {
    const deflated = page().ToImage({ format: 'tiff' });
    const raw = page().ToImage({ format: 'tiff', compression: 'none' });

    // The fixture is two flat blocks, so Deflate should win by a wide margin.
    expect(deflated.length).toBeLessThan(raw.length);

    const a = decodeTiff(deflated), b = decodeTiff(raw);
    if (a.kind !== 'rgb' || b.kind !== 'rgb') throw new Error('expected rgb');
    expect(a.samples).toEqual(b.samples);
  });

  // The issue asks for STRIPS, not one image-sized block. Measured: asserting
  // only that the pixels round-trip does NOT pin this — a single whole-image
  // strip reassembles perfectly and leaves such a test green. The count has to
  // come out of the file, so this reads tag 273's own count.
  it('splits a tall page into several strips', () => {
    const tall = page(600).ToImage({ format: 'tiff', compression: 'none' });

    expect(stripCount(tall)).toBeGreaterThan(1);
    // ...and a short page still fits in one, so the budget is a real threshold
    // rather than an unconditional split.
    expect(stripCount(page(20).ToImage({ format: 'tiff', compression: 'none' }))).toBe(1);
  });

  it('reassembles a multi-strip page, including its last short strip', () => {
    const img = decodeTiff(page(600).ToImage({ format: 'tiff', compression: 'none' }));
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    expect(img.height).toBe(600);
    expect(rgbAt(img, 30, 0)).toEqual([255, 0, 0]);
    expect(rgbAt(img, 30, 300)).toEqual([255, 0, 0]);
    expect(rgbAt(img, 30, 599)).toEqual([255, 0, 0]);
    expect(rgbAt(img, 90, 599)).toEqual([255, 255, 255]);
  });

  // Unlike JPEG, TIFF CAN carry alpha, so `background: 'transparent'` is
  // honoured rather than refused — the reason vk5h.2's refusal is a property
  // of the format and not a blanket rule.
  it('honours a transparent background through ExtraSamples', () => {
    const img = decodeTiff(page().ToImage({ format: 'tiff', background: 'transparent' }));
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    expect(img.alpha).toBeDefined();
    expect(img.alpha![45 * 120 + 30]).toBe(255);   // painted
    expect(img.alpha![45 * 120 + 90]).toBe(0);     // untouched
  });
});

describe('encodeTiff', () => {
  const frame = (w: number, h: number, r: number) => ({
    width: w, height: h, kind: 'rgb' as const,
    samples: Uint8Array.from({ length: w * h * 3 }, (_, i) => (i % 3 === 0 ? r : 0)),
  });

  // The multi-frame contract vk5h.4 builds `doc.ToTiff()` on: one IFD per
  // frame, chained. Tested here at the module rather than through a public
  // entry, which .4 adds.
  it('chains several frames into one multi-page file', () => {
    const t = encodeTiff([frame(8, 4, 255), frame(6, 3, 128)]);

    expect(tiffPageCount(t)).toBe(2);

    const a = decodeTiff(t, 0), b = decodeTiff(t, 1);
    if (a.kind !== 'rgb' || b.kind !== 'rgb') throw new Error('expected rgb');
    expect([a.width, a.height]).toEqual([8, 4]);
    expect([b.width, b.height]).toEqual([6, 3]);
    expect(a.samples[0]).toBe(255);
    expect(b.samples[0]).toBe(128);
  });

  // ExtraSamples 1 means ASSOCIATED (premultiplied) alpha, and `tiff.ts`
  // divides that back out on read — so writing 1 over straight alpha brightens
  // every SEMI-transparent pixel on the round trip.
  //
  // Measured, and the reason this test exists apart from the page-level one:
  // a fixture whose alpha is only 0 or 255 cannot see the difference at all
  // (255 divides by one, 0 is forced to 0), so it stays green with the wrong
  // value written. The half-alpha pixel is the entire point.
  it('writes alpha as unassociated, leaving semi-transparent colour unscaled', () => {
    const t = encodeTiff([{
      width: 2, height: 1, kind: 'rgba',
      samples: Uint8Array.from([200, 100, 50, 128, 10, 20, 30, 255]),
    }]);
    const img = decodeTiff(t);
    if (img.kind !== 'rgb') throw new Error('expected rgb');

    expect(img.alpha).toBeDefined();
    expect([...img.alpha!]).toEqual([128, 255]);
    // Unchanged. Under ExtraSamples 1 the decoder would scale these by 255/128.
    expect([...img.samples.subarray(0, 3)]).toEqual([200, 100, 50]);
    expect([...img.samples.subarray(3, 6)]).toEqual([10, 20, 30]);
  });

  it('encodes a single grayscale frame', () => {
    const t = encodeTiff([{
      width: 4, height: 2, kind: 'gray',
      samples: Uint8Array.from([0, 64, 128, 255, 255, 128, 64, 0]),
    }]);
    const img = decodeTiff(t);

    if (img.kind !== 'gray') throw new Error('expected gray');
    expect(img.width).toBe(4);
    expect(img.bpc).toBe(8);
    expect([...img.samples]).toEqual([0, 64, 128, 255, 255, 128, 64, 0]);
  });

  // --- CCITT Group 4 (vk5h.7) ---

  /** A bilevel frame: 1 bpp, MSB-first, 1 = black. */
  const bilevel = (w: number, h: number, on: (x: number, y: number) => boolean) => {
    const stride = (w + 7) >> 3;
    const samples = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (on(x, y)) samples[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    return { width: w, height: h, kind: 'bilevel' as const, samples };
  };

  it('writes a G4 frame that reads back with the same pixels', () => {
    const f = bilevel(40, 24, (x, y) => (x >> 3) % 2 === 0 && y % 5 !== 0);
    const img = decodeTiff(encodeTiff([f], { compression: 'g4' }));

    if (img.kind !== 'gray') throw new Error(`expected gray, got ${img.kind}`);
    expect(img.bpc).toBe(1);
    expect([img.width, img.height]).toEqual([40, 24]);
    // tiff.ts normalizes to DeviceGray (0 = black), so our 1-is-black samples
    // come back inverted. Comparing against the inverse is what pins the
    // photometric declaration rather than leaving polarity to chance.
    const inverted = Uint8Array.from(f.samples, (b) => ~b & 0xff);
    expect([...img.samples]).toEqual([...inverted]);
  });

  it('makes a sparse bilevel page much smaller under G4 than uncompressed', () => {
    const f = bilevel(1000, 200, (x, y) => y % 20 < 12 && x % 64 < 28);
    const g4 = encodeTiff([f], { compression: 'g4' });
    const raw = encodeTiff([f], { compression: 'none' });

    expect(g4.length).toBeLessThan(raw.length / 4);
  });

  it('chains several G4 frames', () => {
    const a = bilevel(24, 8, (x) => x < 12);
    const b = bilevel(24, 8, (x) => x >= 12);
    const t = encodeTiff([a, b], { compression: 'g4' });

    expect(tiffPageCount(t)).toBe(2);
    const first = decodeTiff(t, 0), second = decodeTiff(t, 1);
    if (first.kind !== 'gray' || second.kind !== 'gray') throw new Error('expected gray');
    expect(first.samples).not.toEqual(second.samples);
  });

  // The issue's own rule: refuse rather than threshold, because picking a
  // threshold is a decision about the image the caller did not ask us to make.
  it('refuses G4 for a frame that is not bilevel, naming the frame', () => {
    const rgb = { width: 2, height: 1, kind: 'rgb' as const, samples: new Uint8Array(6) };
    const call = () => encodeTiff([bilevel(8, 1, () => true), rgb], { compression: 'g4' });

    expect(call).toThrow(TypeError);
    expect(call).toThrow(/frame 1/);
    expect(call).toThrow(/bilevel/);
  });

  it('refuses G4 from ToImage, a rendered page not being bilevel', () => {
    const call = () => page().ToImage({ format: 'tiff', compression: 'g4' });

    expect(call).toThrow(/bilevel/);
  });

  it('rejects a frame whose sample count does not match its dimensions', () => {
    expect(() => encodeTiff([{
      width: 4, height: 2, kind: 'rgb', samples: new Uint8Array(10),
    }])).toThrow(TypeError);
  });

  it('rejects an empty frame list rather than writing a headerless file', () => {
    expect(() => encodeTiff([])).toThrow(TypeError);
  });
});
