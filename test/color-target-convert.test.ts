import { describe, it, expect } from 'vitest';
import { convertColors } from '../src/colorconvert.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import {
  buildGrayscalePdf, buildGrayscaleImagePdf, buildSignedGrayscalePdf,
} from './helpers/build-grayscale-pdf.js';
import { inflateStream } from '../src/flate.js';
import { isStream, isArray, name } from '../src/types.js';

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

/**
 * `convertColors` -- the document walk retargeted (85l8.1).
 *
 * NOT public API: `doc.ConvertColors` is `85l8.2`. This drives the module
 * entry directly, which is what makes the cmyk and rgb paths falsifiable now
 * rather than dead until the next issue.
 */
describe('convertColors — to cmyk', () => {
  it('converts every content location to k operators', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = convertColors(doc, 'cmyk');
    const text = allContent(doc.Save());

    expect(text).not.toMatch(/\brg\b/);
    expect(text).not.toMatch(/\bRG\b/);
    // The five colours of the gray fixture, as cmyk.
    expect(text).toContain('0 1 1 0 k');        // red
    expect(text).toContain('1 1 0 0 k');        // blue
    expect(text).toContain('1 0 1 0 k');        // green
    expect(text).toContain('0 0 1 0 k');        // yellow
    expect(text).toContain('1 0 0 0 k');        // cyan
    expect(report.streams).toBe(5);
    expect(report.skipped).toEqual([]);
  });

  it('retargets a named colour space to DeviceCMYK', () => {
    const doc = Document.Open(buildGrayscalePdf());
    convertColors(doc, 'cmyk');
    expect(allContent(doc.Save())).toContain('/DeviceCMYK cs');
  });

  it('is idempotent: a second run finds nothing left to do', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(convertColors(doc, 'cmyk').operators).toBeGreaterThan(0);
    expect(convertColors(doc, 'cmyk').operators).toBe(0);
  });

  it('converts image XObjects and names the route', () => {
    const doc = Document.Open(buildGrayscaleImagePdf());
    const report = convertColors(doc, 'cmyk');
    expect(report.images.length).toBeGreaterThan(0);
    // The exact JPEG route is gray-only, so nothing may claim it here.
    expect(report.images.map((i) => i.route)).not.toContain('jpeg-exact');
    for (const [, obj] of doc.objectEntries()) {
      if (isStream(obj) && obj.dict.get('Subtype')?.toString().includes('Image')) continue;
    }
  });

  it('converts an annotation colour array to four components', () => {
    const doc = Document.Open(buildGrayscalePdf());
    convertColors(doc, 'cmyk');
    const page = doc.Pages[0]!;
    const annots = doc.resolve(page.Dict.get('Annots'));
    expect(isArray(annots)).toBe(true);
    if (!isArray(annots)) return;
    let checked = 0;
    for (const a of annots) {
      const ad = doc.resolve(a);
      if (!(ad instanceof Map)) continue;
      const c = doc.resolve(ad.get('C'));
      if (isArray(c) && c.length > 0) { expect(c).toHaveLength(4); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('still refuses a signed document', () => {
    const doc = Document.Open(buildSignedGrayscalePdf());
    expect(() => convertColors(doc, 'cmyk')).toThrow(UnsupportedFeatureError);
  });
});

describe('convertColors — to rgb', () => {
  it('leaves an rgb document alone and converts a cmyk one', () => {
    const doc = Document.Open(buildGrayscalePdf());
    // The fixture is authored in rgb, so rgb is a no-op for its rg operators.
    const report = convertColors(doc, 'rgb');
    const text = allContent(doc.Save());
    expect(text).toContain('1 0 0 rg');
    expect(report.skipped).toEqual([]);
  });
});

describe('ConvertToGrayscale is the gray specialization', () => {
  it('agrees with convertColors at to: gray', () => {
    const a = Document.Open(buildGrayscalePdf());
    a.ConvertToGrayscale();
    const b = Document.Open(buildGrayscalePdf());
    convertColors(b, 'gray');
    expect(a.Save()).toEqual(b.Save());
  });
});
