import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertComps, rgbToCmyk, type CmykTransform } from '../src/colorrule.js';
import { inflateStream } from '../src/flate.js';
import { isStream, isDict, isArray } from '../src/types.js';
import {
  buildGrayscalePdf, buildGrayscaleImagePdf, buildGrayscaleShadingPdf,
  buildGrayscaleMeshPdf,
} from './helpers/build-grayscale-pdf.js';

/**
 * A caller-supplied RGB->CMYK transform (85l8.3).
 *
 * The bundled `rgbToCmyk` is naive maximum-black removal with NO colour
 * management: without the destination profile there is no way to know what ink
 * its numbers produce, which is why PDF/X remediation makes that rewrite
 * opt-in. This does not make the library colour-managed — it makes it possible
 * for a caller who IS to hand the correct numbers in.
 *
 * A sentinel constant transform is used throughout rather than a plausible
 * one: every leg has to be shown to reach it, and a realistic transform's
 * output is too close to the naive one to tell the two apart.
 */
const SENTINEL: CmykTransform = () => [0.1, 0.2, 0.3, 0.4];

/** Every content stream in the saved document, as text. */
function allContent(bytes: Uint8Array): string {
  const doc = Document.Open(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    try { out.push(new TextDecoder().decode(inflateStream(obj))); } catch { /* not content */ }
  }
  return out.join('\n');
}

describe('convertComps takes the cmyk leg from the caller', () => {
  it('uses the supplied transform for a cmyk target', () => {
    expect(convertComps([1, 0, 0], { kind: 'rgb' }, 'cmyk', SENTINEL))
      .toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('defaults to the naive transform, so every existing caller is unmoved', () => {
    expect(convertComps([1, 0, 0], { kind: 'rgb' }, 'cmyk'))
      .toEqual(rgbToCmyk(1, 0, 0));
  });

  // It replaces the RGB->CMYK leg, not the pivot: a gray or rgb target never
  // reaches it, so passing one could only be a mistake.
  it('ignores it for a gray target', () => {
    expect(convertComps([1, 0, 0], { kind: 'rgb' }, 'gray', SENTINEL)).toEqual([0.299]);
  });

  it('ignores it for an rgb target', () => {
    expect(convertComps([1, 0, 0], { kind: 'rgb' }, 'rgb', SENTINEL)).toEqual([1, 0, 0]);
  });

  // A cmyk source is already the target and short-circuits before the pivot,
  // which is the byte-identity rule `convertComps` documents.
  it('is not consulted for a source already in cmyk', () => {
    expect(convertComps([0, 0, 0, 1], { kind: 'cmyk' }, 'cmyk', SENTINEL))
      .toEqual([0, 0, 0, 1]);
  });
});

/**
 * Each leg is asserted separately and mutation-checked separately. A fixture
 * exercising only content operators would leave the image, shading and mesh
 * paths unmeasured — and an image full of naive ink is exactly the defect a
 * colour-managed caller is trying to avoid.
 */
describe('ConvertColors routes every leg through the supplied transform', () => {
  it('reaches content operators', () => {
    const doc = Document.Open(buildGrayscalePdf());
    doc.ConvertColors({ to: 'cmyk', transform: SENTINEL });
    expect(allContent(doc.Save())).toContain('0.1 0.2 0.3 0.4 k');
  });

  it('reaches image samples', () => {
    const doc = Document.Open(buildGrayscaleImagePdf());
    doc.ConvertColors({ to: 'cmyk', transform: SENTINEL });
    const saved = Document.Open(doc.Save());
    const img = [...saved.objectEntries()]
      .map(([, o]) => o)
      .find((o) => isStream(o) && o.dict.get('Width') === 2);
    if (!img || !isStream(img)) throw new Error('image not found');
    // 0.1 0.2 0.3 0.4 as 8-bit samples, for every pixel.
    expect([...inflateStream(img).slice(0, 4)]).toEqual([26, 51, 77, 102]);
  });

  it('reaches a shading function', () => {
    const doc = Document.Open(buildGrayscaleShadingPdf());
    doc.ConvertColors({ to: 'cmyk', transform: SENTINEL });
    const saved = Document.Open(doc.Save());
    const sh = [...saved.objectEntries()]
      .map(([, o]) => o)
      .find((o) => isDict(o) && o.get('ShadingType') === 2);
    if (!sh || !isDict(sh)) throw new Error('shading not found');
    const fn = saved.resolve(sh.get('Function'));
    if (!isDict(fn)) throw new Error('function not found');
    expect(fn.get('C0')).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('reaches a mesh vertex colour', () => {
    const doc = Document.Open(buildGrayscaleMeshPdf());
    doc.ConvertColors({ to: 'cmyk', transform: SENTINEL });
    const saved = Document.Open(doc.Save());
    const mesh = [...saved.objectEntries()]
      .map(([, o]) => o)
      .find((o) => isStream(o) && o.dict.get('ShadingType') === 4);
    if (!mesh || !isStream(mesh)) throw new Error('mesh not found');
    // flag byte, then 4 coordinate bytes, then the four components.
    expect([...inflateStream(mesh).slice(5, 9)]).toEqual([26, 51, 77, 102]);
  });
});

/**
 * Every rejection happens BEFORE anything is converted, so a rejected call
 * leaves the document byte-identical — `checkTarget`'s rule, and the reason
 * the transform is probed once up front rather than trusted per colour.
 */
describe('ConvertColors validates the transform before converting anything', () => {
  const untouched = (bad: () => void): void => {
    const doc = Document.Open(buildGrayscalePdf());
    const before = doc.Save();
    expect(bad).toThrow();
    expect(Document.Open(buildGrayscalePdf()).Save()).toEqual(before);
  };

  it('refuses a transform that is not a function', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(() => doc.ConvertColors(
      { to: 'cmyk', transform: 'nope' as unknown as CmykTransform }))
      .toThrow(TypeError);
  });

  // Outside the allowed set rather than the wrong kind of thing, which is
  // `formcreate.ts`'s split — and silently accepting it is the trap
  // `textedit.ts` records for `region`.
  it('refuses a transform for a target that has no cmyk leg', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(() => doc.ConvertColors({ to: 'rgb', transform: SENTINEL }))
      .toThrow(RangeError);
  });

  it('refuses a transform that does not return four numbers', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(() => doc.ConvertColors(
      { to: 'cmyk', transform: (() => [0, 1]) as unknown as CmykTransform }))
      .toThrow(TypeError);
  });

  it('refuses a transform that returns a non-finite component', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(() => doc.ConvertColors({ to: 'cmyk', transform: () => [0, 0, 0, NaN] }))
      .toThrow(TypeError);
  });

  it('leaves the document byte-identical when it refuses', () => {
    untouched(() => Document.Open(buildGrayscalePdf())
      .ConvertColors({ to: 'rgb', transform: SENTINEL }));
  });

  /**
   * The probe cannot catch a transform that only misbehaves for some inputs,
   * so every result is clamped on the way out. A NaN reaching a content stream
   * is a corrupt file rather than a wrong colour — and note `clamp01(NaN)` is
   * NaN, so the guard has to test finiteness rather than only the range.
   */
  // Blue, deliberately: the probe corners are black, white, red and mid-grey,
  // so a transform that misbehaves for red is REJECTED up front rather than
  // clamped and this case would measure the wrong guard. It took a failing
  // run to notice.
  it('clamps a result that leaves 0..1 for an input the probe did not use', () => {
    const doc = Document.Open(buildGrayscalePdf());
    doc.ConvertColors({
      to: 'cmyk',
      transform: (r, g, b) =>
        (r === 0 && g === 0 && b === 1 ? [5, -2, Number.NaN, 0.5] : [0, 0, 0, 0]),
    });
    const text = allContent(doc.Save());
    expect(text).toContain('1 0 0 0.5 k');
    expect(text).not.toContain('NaN');
  });
});

describe('the report says which transform ran', () => {
  it('reports a supplied transform', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(doc.ConvertColors({ to: 'cmyk', transform: SENTINEL }).cmykTransform)
      .toBe('supplied');
  });

  it('reports the naive default', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(doc.ConvertColors({ to: 'cmyk' }).cmykTransform).toBe('naive');
  });

  // Absent rather than a third value: a gray or rgb conversion has no cmyk leg
  // at all, so naming one would state something about work that never ran.
  it('says nothing for a target with no cmyk leg', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(doc.ConvertColors({ to: 'rgb' }).cmykTransform).toBeUndefined();
  });
});

/** The fence: passing no transform must move no bytes anywhere. */
describe('no transform means exactly the output of before', () => {
  it('converts to cmyk byte-identically to the naive path', () => {
    const a = Document.Open(buildGrayscalePdf());
    a.ConvertColors({ to: 'cmyk' });
    const b = Document.Open(buildGrayscalePdf());
    b.ConvertColors({ to: 'cmyk', transform: rgbToCmyk });
    expect(a.Save()).toEqual(b.Save());
  });

  it('leaves an annotation colour array on the same rule', () => {
    const doc = Document.Open(buildGrayscalePdf());
    doc.ConvertColors({ to: 'cmyk', transform: SENTINEL });
    const annot = doc.Pages[0].Annotations[0];
    const c = annot.Dict.get('C');
    if (!isArray(c)) throw new Error('/C not an array');
    expect(c).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});
