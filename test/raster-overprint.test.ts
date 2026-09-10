import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/**
 * Overprint preview (`4gtd.7`) — `/OP`, `/op` and `/OPM`.
 *
 * **This is a PREVIEW, not a separation model.** A plate-accurate answer needs
 * per-colorant buffers; the canvas is RGB, so an overprinting paint composites
 * with per-channel MINIMUM. A colorant the paint does not lay down has no ink,
 * so its RGB channel is 1 and the minimum preserves the backdrop by itself.
 *
 * **Every fixture puts the backdrop on ONE plate and the overprint on a
 * DIFFERENT one**, because that is the only shape where preserving and
 * replacing give different pictures: 50% cyan is RGB (128, 255, 255), and 100%
 * magenta over it reads (128, 0, 255) when the cyan plate is preserved and
 * (255, 0, 255) when the paint replaces it. Same page, opposite answers.
 */

/** A 60x40 page: a 50% cyan backdrop rect, then `over` painted across it. */
const page = (over: string, extra = '', res = '') => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, 60, 40],
  resources: `<< /ExtGState << /GS << ${extra} >> >> ${res} >>`,
  content: `0.5 0 0 0 k 0 0 60 40 re f /GS gs ${over}`,
})).Pages[0];

const at = (p: ReturnType<typeof page>) => {
  const png = decodePng(p.ToImage());
  return (x: number, y: number) => png.at(x, 40 - y).slice(0, 3);
};

/** 50% cyan is (128,255,255): the backdrop, where nothing painted over it. */
const CYAN_50: number[] = [128, 255, 255];
/** Magenta over preserved cyan — cyan's plate survives, magenta's goes down. */
const PRESERVED: number[] = [128, 0, 255];
/** Magenta having REPLACED every plate: the cyan is gone. */
const REPLACED: number[] = [255, 0, 255];

describe('overprint — DeviceCMYK and /OPM', () => {
  // Mode 1 leaves a component equal to 0 alone; mode 0 writes every component
  // INCLUDING the zeros, which is exactly normal painting. That difference is
  // the whole of what makes /OPM observable rather than decorative.
  it('preserves a zero-valued plate under /OPM 1', () => {
    const p = at(page('0 1 0 0 k 10 10 40 20 re f', '/op true /OPM 1'));
    expect(p(30, 20)).toEqual(PRESERVED);
    expect(p(5, 20)).toEqual(CYAN_50);          // outside the overprinted rect
  });

  it('replaces every plate under /OPM 0, overprint or not', () => {
    // The SAME page and the same flag: only the mode differs, so a build that
    // ignored /OPM would give one answer for both.
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/op true /OPM 0'))(30, 20))
      .toEqual(REPLACED);
  });

  it('replaces when overprint is off, so the flag is what is measured', () => {
    // Without this the /OPM 1 case measures the default rather than /op.
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/op false /OPM 1'))(30, 20))
      .toEqual(REPLACED);
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/OPM 1'))(30, 20))
      .toEqual(REPLACED);
  });
});

describe('overprint — Separation and DeviceN', () => {
  // A Separation names a SUBSET of the device's colorants, so the rest are
  // preserved whatever /OPM says — which is why this needs no mode at all.
  const SEP = '/ColorSpace << /Spot [/Separation /PANTONE /DeviceCMYK 5 0 R] >>';
  const TINT = '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>';

  const spotPage = (extra: string) => Document.Open(buildSvgPdf({
    mediaBox: [0, 0, 60, 40],
    resources: `<< /ExtGState << /GS << ${extra} >> >> ${SEP} >>`,
    content: '0.5 0 0 0 k 0 0 60 40 re f /GS gs /Spot cs 1 scn 10 10 40 20 re f',
    extra: { 5: TINT },
  })).Pages[0];

  it('darkens rather than replaces, with no /OPM stated', () => {
    // THE acceptance criterion: an overprinted spot over CMYK darkens.
    expect(at(spotPage('/op true'))(30, 20)).toEqual(PRESERVED);
  });

  it('replaces when overprint is off', () => {
    expect(at(spotPage('/op false'))(30, 20)).toEqual(REPLACED);
  });

  it('needs no /OPM 1, unlike DeviceCMYK', () => {
    // Mode 0 and mode 1 agree for a Separation — asserted directly, since the
    // DeviceCMYK rule reads as though it should apply here too.
    expect(at(spotPage('/op true /OPM 0'))(30, 20)).toEqual(PRESERVED);
  });
});

describe('overprint — which flag governs which paint', () => {
  // A fill fixture cannot see /OP and a stroke fixture cannot see /op, so
  // setting both would let either implementation pass. Each is asserted with
  // the OTHER flag explicitly false.
  it('/op governs a fill and /OP does not', () => {
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/op true /OP false /OPM 1'))(30, 20))
      .toEqual(PRESERVED);
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/op false /OP true /OPM 1'))(30, 20))
      .toEqual(REPLACED);
  });

  it('/OP governs a stroke and /op does not', () => {
    // A 20pt stroke down the middle, so the probe sits well inside it.
    const stroke = '0 1 0 0 K 20 w 0 20 m 60 20 l S';
    expect(at(page(stroke, '/OP true /op false /OPM 1'))(30, 20)).toEqual(PRESERVED);
    expect(at(page(stroke, '/OP false /op true /OPM 1'))(30, 20)).toEqual(REPLACED);
  });

  it('/OP alone sets the fill flag too, for backward compatibility', () => {
    // Table 58: /op absent means /OP sets both. Reading them the other way
    // round would lose /op for a dict carrying both, which the case above pins
    // from the other side.
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/OP true /OPM 1'))(30, 20))
      .toEqual(PRESERVED);
  });
});

describe('overprint — where it does NOT apply', () => {
  it('ignores a DeviceRGB paint, whatever the flags say', () => {
    // 11.7.4.2: overprint is meaningful only in a device subtractive space.
    // Magenta as RGB is (1, 0, 1) — the same colour, a different space — so
    // without this rule the two would be indistinguishable.
    expect(at(page('1 0 1 rg 10 10 40 20 re f', '/op true /OPM 1'))(30, 20))
      .toEqual(REPLACED);
  });

  it('leaves an explicit /BM alone rather than replacing it', () => {
    // The approximation IS a blend mode, so the two collide. A document that
    // asked for Multiply gets Multiply: 50% cyan (128,255,255) times magenta
    // (255,0,255) is (128,0,255) — which happens to equal the preserved
    // answer, so the case that discriminates is Screen, whose result neither
    // Darken nor a plain replace can produce.
    expect(at(page('0 1 0 0 k 10 10 40 20 re f', '/op true /OPM 1 /BM /Screen'))(30, 20))
      .toEqual([255, 255, 255]);
  });
});
