import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import {
  buildGrayscalePdf, buildSignedGrayscalePdf,
} from './helpers/build-grayscale-pdf.js';
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';

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
 * `doc.ConvertColors({ to })` -- the public entry (85l8.2).
 *
 * The walk itself is `85l8.1`'s and is covered by the five `color-target*`
 * files; what is new here is the METHOD: a required target, its validation,
 * and that the gray shorthand still agrees with it exactly.
 */
describe('Document.ConvertColors', () => {
  it('converts to DeviceCMYK', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertColors({ to: 'cmyk' });
    const text = allContent(doc.Save());
    expect(text).toContain('0 1 1 0 k');            // red
    expect(text).toContain('/DeviceCMYK cs');
    expect(text).not.toMatch(/\brg\b/);
    expect(report.streams).toBeGreaterThan(0);
    expect(report.skipped).toEqual([]);
  });

  it('converts to DeviceRGB', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertColors({ to: 'rgb' });
    expect(allContent(doc.Save())).toContain('1 0 0 rg');
    expect(report.skipped).toEqual([]);
  });

  // The whole reason ConvertToGrayscale survives as a named shorthand: it must
  // be the same operation, not a second one that happens to agree today.
  it('agrees byte for byte with ConvertToGrayscale at to: gray', () => {
    const a = Document.Open(buildGrayscalePdf());
    a.ConvertToGrayscale();
    const b = Document.Open(buildGrayscalePdf());
    b.ConvertColors({ to: 'gray' });
    expect(b.Save()).toEqual(a.Save());
  });

  it('reports the same shape both entries return', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertColors({ to: 'cmyk' });
    expect(report).toMatchObject({
      streams: expect.any(Number), operators: expect.any(Number),
      images: expect.any(Array), shadings: expect.any(Number),
      annotations: expect.any(Number), skipped: expect.any(Array),
      lossy: expect.any(Boolean), bytesDelta: expect.any(Number),
    });
  });

  it('still refuses a signed document', () => {
    const doc = Document.Open(buildSignedGrayscalePdf());
    expect(() => doc.ConvertColors({ to: 'cmyk' })).toThrow(UnsupportedFeatureError);
  });
});

describe('Document.ConvertColors — target validation', () => {
  // A typo'd target that silently converted nothing while reporting success is
  // the failure worth preventing: the caller reads `skipped: []` and believes
  // the document converted.
  it('rejects an unknown target rather than silently doing nothing', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(() => doc.ConvertColors({ to: 'CMYK' as never })).toThrow(RangeError);
    expect(() => doc.ConvertColors({ to: 'lab' as never })).toThrow(RangeError);
  });

  it('rejects a missing target', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(() => doc.ConvertColors({} as never)).toThrow(RangeError);
  });

  it('leaves the document untouched when it rejects', () => {
    const src = buildGrayscalePdf();
    const doc = Document.Open(src);
    const before = doc.Save();
    expect(() => doc.ConvertColors({ to: 'CMYK' as never })).toThrow(RangeError);
    expect(doc.Save()).toEqual(before);
  });
});
