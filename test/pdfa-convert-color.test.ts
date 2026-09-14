import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';
import { buildPdfaPdf, type PdfaOptions } from './helpers/build-pdfa-pdf.js';

/**
 * Normalising device colour during ConvertToPdfA (`ixxw.2`).
 *
 * `ixxw.1` made the validator ask whether the output intent's profile is a
 * profile OF THE SPACE the content uses. That immediately made a combination
 * the converter itself produces non-conformant: `outputIntentPass` bolts an
 * sRGB intent onto a document that has none, so a DeviceCMYK document came
 * out of `ConvertToPdfA` failing its own post-conversion validation. This
 * pass closes that by running the `85l8` colour walk to the intent's space.
 *
 * SCOPE, decided rather than discovered: it converts only toward an RGB
 * intent, where the rewrite is the same pivot `raster.ts` applies and the
 * rendered page is unchanged. A CMYK or GRAY intent is left alone and
 * reported unresolved — naive maximum-black ink and colour-to-grey are both
 * real appearance changes, and `ConvertToPdfX` already refuses to make the
 * first of them silently (its `convertColor` is opt-in for that reason).
 */

const open = (b: Uint8Array) => Document.Open(b);
const cmykDoc = (extra: PdfaOptions = {}) => open(buildPdfaPdf({
  deviceColorSpace: 'CMYK', fillRect: true, omitOutputIntent: true, ...extra,
}, 2));

/** The rendered colour at the middle of the painted rect. */
function patch(doc: Document): [number, number, number] {
  const img = decodePng(doc.Pages[0]!.ToImage({ scale: 1 }));
  const [r, g, b] = img.at(60, img.height - 60);
  return [r, g, b];
}

describe('ConvertToPdfA — device colour is normalised to the output intent', () => {
  it('a CMYK document converts and then validates', () => {
    const doc = cmykDoc();
    const report = doc.ConvertToPdfA('2b');
    expect(report.unresolved.map((e) => e.rule)).not.toContain('DeviceColorWithoutIntent');
    expect(report.passed).toBe(true);
  });

  it('names the conversion in `applied`', () => {
    const doc = cmykDoc();
    const rules = doc.ConvertToPdfA('2b').applied.map((a) => a.rule);
    expect(rules).toContain('DeviceColor');
  });

  it('removes the CMYK operator from the content stream', () => {
    const doc = cmykDoc();
    doc.ConvertToPdfA('2b');
    const text = new TextDecoder('latin1').decode(doc.Save());
    expect(text).not.toContain(' k\n');
    expect(text).toContain(' rg\n');
  });

  // The acceptance criterion that matters, and the only check here that sees
  // a wrong transform: the walk must be the one the renderer applies, so the
  // page must render the same pixels afterwards.
  it('renders the same colour after conversion', () => {
    const doc = cmykDoc();
    const before = patch(doc);
    doc.ConvertToPdfA('2b');
    const after = patch(doc);
    // 0 1 1 0 k is red; assert it IS red, or a build that greyed everything
    // would satisfy an equality against its own output.
    expect(before[0]).toBeGreaterThan(200);
    expect(before[1]).toBeLessThan(60);
    expect(after[0]).toBeCloseTo(before[0], -0.5);
    expect(after[1]).toBeCloseTo(before[1], -0.5);
    expect(after[2]).toBeCloseTo(before[2], -0.5);
  });

  /**
   * `convertColors` THROWS on a signed document, and ConvertToPdfA has never
   * refused one — so without the guard this pass turns a working call into an
   * UnsupportedFeatureError for every signed CMYK file. `hasSignatureField`
   * is a plain /FT /Sig walk, so the field needs no real signature to be seen.
   * Measured: this is the ONLY case in the suite that covers that guard.
   */
  it('skips a signed document instead of throwing', () => {
    const doc = cmykDoc();
    const sig: PdfDict = new Map<string, PdfObject>([['FT', name('Sig')]]);
    doc.catalog().set('AcroForm', new Map<string, PdfObject>([['Fields', [sig]]]));
    let report!: ReturnType<Document['ConvertToPdfA']>;
    expect(() => { report = doc.ConvertToPdfA('2b'); }).not.toThrow();
    expect(report.applied.map((a) => a.rule)).not.toContain('DeviceColor');
    expect(report.unresolved.map((e) => e.rule)).toContain('DeviceColorWithoutIntent');
  });

  it('survives a save/reopen round trip', () => {
    const doc = cmykDoc();
    doc.ConvertToPdfA('2b');
    const again = open(doc.Save());
    expect(again.ValidatePdfA('2b').Errors.map((e) => e.rule))
      .not.toContain('DeviceColorWithoutIntent');
  });
});

describe('ConvertToPdfA — declining the device-colour category', () => {
  it('leaves the CMYK content alone and reports it unresolved', () => {
    const doc = cmykDoc();
    const report = doc.ConvertToPdfA('2b', { preserve: ['deviceColor'] });
    expect(report.applied.map((a) => a.rule)).not.toContain('DeviceColor');
    expect(report.unresolved.map((e) => e.rule)).toContain('DeviceColorWithoutIntent');
    expect(new TextDecoder('latin1').decode(doc.Save())).toContain(' k\n');
  });

  // A document that needs no conversion must not be touched by the pass at
  // all, which is what "declining leaves it byte-identical" really tests: with
  // RGB content under the sRGB intent conversion adds, there is nothing to do,
  // so preserving the category may not change one byte.
  it('is byte-identical either way when nothing needs converting', () => {
    const opts: PdfaOptions = {
      deviceColorSpace: 'RGB', fillRect: true, omitOutputIntent: true,
    };
    const a = open(buildPdfaPdf(opts, 2));
    a.ConvertToPdfA('2b');
    const b = open(buildPdfaPdf(opts, 2));
    b.ConvertToPdfA('2b', { preserve: ['deviceColor'] });
    expect(a.Save()).toEqual(b.Save());
  });

  it('does not touch a DeviceGray document, which any intent satisfies', () => {
    const opts: PdfaOptions = {
      deviceColorSpace: 'Gray', fillRect: true, omitOutputIntent: true,
    };
    const doc = open(buildPdfaPdf(opts, 2));
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).not.toContain('DeviceColor');
    expect(new TextDecoder('latin1').decode(doc.Save())).toContain(' g\n');
    expect(report.passed).toBe(true);
  });
});

describe('ConvertToPdfA — only an RGB intent is converted toward', () => {
  // A caller-supplied CMYK profile. Converting to it would mean naive
  // maximum-black ink, which ConvertToPdfX refuses to do without an opt-in;
  // the honest answer is to leave the content and report it.
  const profile = (space: 'CMYK' | 'GRAY'): Uint8Array => {
    const b = new Uint8Array(256);
    const put = (o: number, s: string): void => {
      for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i);
    };
    b[3] = 1; b[8] = 2;
    put(12, 'prtr'); put(16, space); put(20, 'Lab '); put(36, 'acsp');
    return b;
  };

  it('leaves RGB content under a caller-supplied CMYK intent, and reports it', () => {
    const doc = open(buildPdfaPdf({
      deviceColorSpace: 'RGB', fillRect: true, omitOutputIntent: true,
    }, 2));
    const report = doc.ConvertToPdfA('2b', {
      iccProfile: { bytes: profile('CMYK'), n: 4, identifier: 'Synthetic CMYK' },
    });
    expect(report.applied.map((a) => a.rule)).not.toContain('DeviceColor');
    expect(report.unresolved.map((e) => e.rule)).toContain('DeviceColorWithoutIntent');
    expect(new TextDecoder('latin1').decode(doc.Save())).toContain(' rg\n');
  });

  /**
   * The case that actually pins the RGB-only rule, and it took a mutation to
   * find: the test above is held by the DeviceCMYK TRIGGER, not by the intent
   * check, because its content is RGB and so nothing would convert either way.
   * This one has content the trigger fires on AND a non-RGB intent, so only
   * the intent check can stop it — and stop it it must, since converting to
   * DeviceRGB under a GRAY intent would rewrite every colour in the document
   * and still not satisfy the clause.
   */
  it('leaves CMYK content under a GRAY intent rather than converting it anyway', () => {
    const doc = cmykDoc();
    const report = doc.ConvertToPdfA('2b', {
      iccProfile: { bytes: profile('GRAY'), n: 1, identifier: 'Synthetic Gray' },
    });
    expect(report.applied.map((a) => a.rule)).not.toContain('DeviceColor');
    expect(report.unresolved.map((e) => e.rule)).toContain('DeviceColorWithoutIntent');
    expect(new TextDecoder('latin1').decode(doc.Save())).toContain(' k\n');
  });
});
