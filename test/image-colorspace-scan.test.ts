import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { decodePng } from './helpers/decode-png.js';
import { buildImageCsPdf, type ImageCsOptions } from './helpers/build-image-cs-pdf.js';

/**
 * An image XObject's colour space counts as device colour (`ixxw.3`).
 *
 * `pageScans` looked at colour OPERATORS and inline images only, so a page
 * whose only colour is an image reported none at all. Two things followed,
 * both silent: `deviceColorRule` never fired, so `ValidatePdfA` passed a
 * DeviceCMYK payload under an sRGB intent; and `ixxw.2`'s conversion pass,
 * which triggers on the same scan, never ran.
 *
 * Measured before the change: widening the scan reddened NOTHING across all
 * 626 files, the real Ghostscript PDF/X fixtures included. That is a free
 * hand, not a licence — every rule below is pinned here or nowhere.
 *
 * The RE-ENCODING half of `ixxw.3` needed no work at all: `convertColors`
 * already routed a CMYK DCT payload through decode-and-re-encode for both
 * APP14 transforms, emitting 8-bit DeviceRGB with no stale `/Decode`. What
 * was missing was anything that asked it to.
 */

const open = (b: Uint8Array) => Document.Open(b);
const rules = (o: ImageCsOptions) =>
  open(buildImageCsPdf(o)).ValidatePdfA('2b').Errors.map((e) => e.rule);

describe('ValidatePdfA — an image XObject’s colour space is device colour', () => {
  it('flags a DeviceCMYK image under an RGB intent', () => {
    expect(rules({ intent: 'RGB' })).toContain('DeviceColorWithoutIntent');
  });
  it('passes a DeviceCMYK image under a CMYK intent', () => {
    expect(rules({ intent: 'CMYK' })).not.toContain('DeviceColorWithoutIntent');
  });
  it('flags a DeviceRGB image under a CMYK intent', () => {
    expect(rules({ colorSpace: '/DeviceRGB', intent: 'CMYK' }))
      .toContain('DeviceColorWithoutIntent');
  });
  it('passes a DeviceGray image under any intent', () => {
    expect(rules({ colorSpace: '/DeviceGray', intent: 'RGB' }))
      .not.toContain('DeviceColorWithoutIntent');
    expect(rules({ colorSpace: '/DeviceGray', intent: 'CMYK' }))
      .not.toContain('DeviceColorWithoutIntent');
  });

  // An image is device colour for the OUTPUT INTENT rule too: a document whose
  // only colour is a picture still needs an intent, which is the half that
  // decides whether `usesDeviceColor` sees anything at all.
  it('requires an output intent for a document whose only colour is an image', () => {
    const r = rules({ colorSpace: '/DeviceRGB', intent: 'none' });
    expect(r).toContain('OutputIntent');
    expect(r).toContain('DeviceColorWithoutIntent');
  });

  // ICCBased is device-INDEPENDENT and permitted under any intent, so it must
  // NOT be reported. Getting this wrong would fail conformant documents.
  it('does NOT flag an ICCBased /N 4 image', () => {
    expect(rules({ colorSpace: '[/ICCBased 7 0 R]', iccComponents: 4, intent: 'RGB' }))
      .not.toContain('DeviceColorWithoutIntent');
  });

  // An image may name a space in the page's /Resources /ColorSpace rather than
  // stating it inline, which the operator path already resolves.
  it('resolves an image colour space named through /Resources', () => {
    expect(rules({ colorSpace: '/CS0', namedSpace: '/DeviceCMYK', intent: 'RGB' }))
      .toContain('DeviceColorWithoutIntent');
  });

  // An Indexed image's BASE decides whether device colour is used. Validator
  // only: the payload here is a 4-component JPEG, so this document is not
  // renderable and is deliberately never converted in the cases below.
  it('looks through an Indexed space to its base', () => {
    expect(rules({ colorSpace: '[/Indexed /DeviceCMYK 1 <00000000FFFFFFFF>]', intent: 'RGB' }))
      .toContain('DeviceColorWithoutIntent');
    expect(rules({ colorSpace: '[/Indexed /DeviceGray 1 <0011>]', intent: 'RGB' }))
      .not.toContain('DeviceColorWithoutIntent');
  });
});

/** Mean RGB over the whole rendered page. */
function mean(doc: Document): [number, number, number] {
  const img = decodePng(doc.Pages[0]!.ToImage({ scale: 1 }));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [pr, pg, pb] = img.at(x, y);
      r += pr; g += pg; b += pb; n++;
    }
  }
  return [r / n, g / n, b / n];
}

describe('ConvertToPdfA — a CMYK image XObject is converted', () => {
  const imageOf = (doc: Document) => {
    const xo = doc.resolve((doc.Pages[0]!.Resources as Map<string, never>).get('XObject'));
    return doc.resolve((xo as Map<string, never>).get('Im0')) as
      { dict: Map<string, { name?: string }> };
  };

  for (const jpeg of ['cmyk-t0', 'cmyk-ycck'] as const) {
    it(`converts a ${jpeg} payload and then validates`, () => {
      const doc = open(buildImageCsPdf({ jpeg, intent: 'RGB' }));
      const report = doc.ConvertToPdfA('2b');
      expect(report.applied.map((a) => a.rule)).toContain('DeviceColor');
      expect(report.unresolved.map((e) => e.rule)).not.toContain('DeviceColorWithoutIntent');
      const im = imageOf(doc);
      expect(im.dict.get('ColorSpace')?.name).toBe('DeviceRGB');
      expect(im.dict.get('Filter')?.name).toBe('DCTDecode');
      // The stale entries the old space described must go with it.
      expect(im.dict.get('Decode')).toBeUndefined();
      expect(im.dict.get('DecodeParms')).toBeUndefined();
    });

    it(`renders a ${jpeg} payload the same after conversion`, () => {
      const doc = open(buildImageCsPdf({ jpeg, intent: 'RGB' }));
      const before = mean(doc);
      doc.ConvertToPdfA('2b');
      const after = mean(doc);
      // Assert it is a real picture, or an all-white page would satisfy the
      // equality against its own output.
      expect(before[0]).toBeGreaterThan(20);
      expect(before[0]).toBeLessThan(235);
      for (const i of [0, 1, 2]) expect(after[i]).toBeCloseTo(before[i]!, -0.5);
    });
  }

  it('names the route it took', () => {
    const doc = open(buildImageCsPdf({ intent: 'RGB' }));
    const action = doc.ConvertToPdfA('2b').applied.find((a) => a.rule === 'DeviceColor');
    expect(action?.action).toContain('jpeg');
  });

  /**
   * An ICC-CMYK image is already conformant, so converting it would be a lossy
   * JPEG re-encode buying nothing. The issue text asked for it; ISO 19005 says
   * it is permitted, and that wins.
   */
  it('leaves an ICCBased /N 4 image alone and still passes', () => {
    const doc = open(buildImageCsPdf({
      colorSpace: '[/ICCBased 7 0 R]', iccComponents: 4, intent: 'RGB',
    }));
    const before = doc.Save().length;
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).not.toContain('DeviceColor');
    expect(report.unresolved.map((e) => e.rule)).not.toContain('DeviceColorWithoutIntent');
    // A re-encode would move the payload; nothing here should have.
    expect(Math.abs(doc.Save().length - before)).toBeLessThan(2000);
  });
});
