import { describe, it, expect } from 'vitest';
import { serializeValue } from '../src/serialize.js';
import { Document } from '../src/document.js';
import type { LineAnnotation } from '../src/annotation.js';

// PDF numbers have no exponent (32000-1 7.3.3), and String(n) writes one for
// |n| < 1e-6 and |n| >= 1e21. A computed coordinate that should be 0 —
// -2.66e-14 from a gradient line — was written as `-2.6645352591003757e-14`,
// which our own parser (and every other reader) refuses: the saved file did
// not reopen. Found by v9j3.4's tagged box-paint check.
describe('a number is never written in exponent notation', () => {
  it('ordinary numbers are written exactly as before', () => {
    for (const n of [0, 1, -1, 14.399999999999999, 0.5, 1e20, 0.000001, -612.25]) {
      expect(serializeValue(n)).toBe(String(n));
    }
  });
  it('a tiny number is plain decimal', () => {
    for (const n of [-2.6645352591003757e-14, 1e-7, -3.5e-9, 1e-22, -1.25e-22, Number.MIN_VALUE, -Number.MIN_VALUE]) {
      const s = serializeValue(n);
      expect(s).toMatch(/^-?0\.\d+$/);
      expect(Number(s), `round-trip for ${n}`).toBe(n);
    }
  });
  it('a huge number is plain digits', () => {
    expect(serializeValue(1e21)).toBe('1000000000000000000000');
    const s = serializeValue(-2.5e22);
    expect(s).toMatch(/^-\d+$/);
    expect(Number(s)).toBe(-2.5e22);
  });
  it('a CSS gradient background saves a file that reopens', () => {
    const d = Document.New();
    d.AddHtml('<p style="background:linear-gradient(red,blue)">x</p>');
    expect(() => Document.Open(d.Save())).not.toThrow();
  });
  it.each(['classic', 'compressed', 'incremental'] as const)('preserves signed tiny measurement factors with %s output', (mode) => {
    const original = Document.New();
    const measure = {
      scaleRatio: '1 pt = 1 m',
      xAxis: [{ unit: 'm', conversionFactor: 1 }],
      distance: [{ unit: 'm', conversionFactor: 0 }, { unit: 'cm', conversionFactor: 0 }],
      area: [{ unit: 'm²', conversionFactor: 1 }],
    };
    original.AddPage().page.AddLine({ line: [0, 0, 16, 16], measure });
    const doc = Document.Open(original.Save());
    const line = doc.Pages[0].Annotations[0] as LineAnnotation;
    const distance = [{ unit: 'm', conversionFactor: 1e-22 }, { unit: 'cm', conversionFactor: -1.25e-22 }];
    line.Measure = { ...measure, distance };

    const saved = doc.Save({ compressed: mode === 'compressed', incremental: mode === 'incremental' });
    const reopened = Document.Open(saved).Pages[0].Annotations[0] as LineAnnotation;
    expect(reopened.Measure?.distance).toEqual(distance);
  });
});
