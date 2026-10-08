import { describe, it, expect } from 'vitest';
import { serializeValue } from '../src/serialize.js';
import { Document } from '../src/document.js';

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
    for (const n of [-2.6645352591003757e-14, 1e-7, -3.5e-9]) {
      const s = serializeValue(n);
      expect(s).not.toMatch(/e/i);
      expect(Number(s)).toBeCloseTo(n, 15);
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
});
