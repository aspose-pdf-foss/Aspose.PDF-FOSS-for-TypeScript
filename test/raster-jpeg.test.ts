import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { decodeJpeg } from '../src/jpeg.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';

/** A red block on the left half of a 120x90 page, so a decoded pixel says
 *  whether THIS page was encoded rather than a blank canvas of the right size. */
const doc = () => Document.Open(buildSvgPdf({
  mediaBox: [0, 0, 120, 90],
  content: '1 0 0 rg 0 0 60 90 re f',
}));

describe('page.ToImage — JPEG output', () => {
  it('emits a decodable 3-component JPEG at the page pixel size', () => {
    const img = decodeJpeg(doc().Pages[0].ToImage({ format: 'jpeg' }));

    expect(img.width).toBe(120);
    expect(img.height).toBe(90);
    expect(img.comps).toBe(3);
  });

  // Dimensions alone come from the SOF header and would match a blank canvas,
  // so read actual ink: left half red, right half the white background.
  it('encodes the page content, not an empty canvas', () => {
    const img = decodeJpeg(doc().Pages[0].ToImage({ format: 'jpeg' }));
    const at = (x: number, y: number) => {
      const p = (y * img.width + x) * 3;
      return [img.data[p], img.data[p + 1], img.data[p + 2]];
    };

    const [lr, lg, lb] = at(30, 45);
    expect(lr).toBeGreaterThan(200);
    expect(lg).toBeLessThan(60);
    expect(lb).toBeLessThan(60);

    const [rr, rg, rb] = at(90, 45);
    expect(rr).toBeGreaterThan(200);
    expect(rg).toBeGreaterThan(200);
    expect(rb).toBeGreaterThan(200);
  });

  it('passes quality through to the encoder', () => {
    const low = doc().Pages[0].ToImage({ format: 'jpeg', quality: 10 });
    const high = doc().Pages[0].ToImage({ format: 'jpeg', quality: 95 });

    expect(low.length).toBeLessThan(high.length);
  });

  // DECISION (vk5h.2): JPEG has no alpha channel, so `background: 'transparent'`
  // and `format: 'jpeg'` are a contradiction. We REFUSE rather than quietly
  // compositing onto white.
  //
  // Compositing would return a perfectly valid file, which is what makes it the
  // worse option: the caller's transparency request would vanish with no signal,
  // and `ToImage` returns bytes with no report channel to carry one — unlike
  // `AddSVGObject`'s `skipped`, where "visible ink beats a silent drop" applies
  // because there IS somewhere to say so. Refusing is also the reversible
  // choice: relaxing it to composite later is additive, where tightening a
  // silent composite into a throw would break callers.
  it('refuses transparent background, which JPEG cannot represent', () => {
    const page = doc().Pages[0];
    const call = () => page.ToImage({ format: 'jpeg', background: 'transparent' });

    expect(call).toThrow(UnsupportedFeatureError);
    // The message must name both halves — the format alone does not tell the
    // caller which of their two options to change.
    expect(call).toThrow(/jpeg/);
    expect(call).toThrow(/transparent/);
  });

  it('still accepts the default opaque background', () => {
    expect(() => doc().Pages[0].ToImage({ format: 'jpeg', background: 'white' }))
      .not.toThrow();
    expect(() => doc().Pages[0].ToImage({ format: 'jpeg' })).not.toThrow();
  });

  it('honours scale, so the other options are not swallowed', () => {
    const img = decodeJpeg(doc().Pages[0].ToImage({ format: 'jpeg', scale: 2 }));

    expect(img.width).toBe(240);
    expect(img.height).toBe(180);
  });
});
