import { describe, it, expect } from 'vitest';
import { resolveFont, FontRegistry } from '../src/htmlfont.js';

describe('resolveFont', () => {
  it('maps serif to the Times New Roman stack with ascent 0.836', () => {
    expect(resolveFont('serif', false, false)).toEqual({
      stack: '"Times New Roman", Times, serif', weight: 400, style: 'normal', ascent: 0.836,
    });
  });

  it('maps monospace bold+italic to Courier New, weight 700, italic, ascent 0.756', () => {
    expect(resolveFont('monospace', true, true)).toEqual({
      stack: '"Courier New", Courier, monospace', weight: 700, style: 'italic', ascent: 0.756,
    });
  });

  it('falls back to the Arial sans-serif stack (ascent 0.846) for any other family', () => {
    expect(resolveFont('sans-serif', false, false).stack).toBe('Arial, Helvetica, sans-serif');
    expect(resolveFont('sans-serif', false, false).ascent).toBe(0.846);
  });
});

describe('FontRegistry', () => {
  it('shares one class across identical (family,weight,style,color) tuples', () => {
    const r = new FontRegistry();
    const a = r.get('serif', false, false, [0, 0, 0]);
    const b = r.get('serif', false, false, [0, 0, 0]);
    expect(a.cls).toBe(b.cls);
    expect(a.ascent).toBe(0.836);
  });

  it('assigns distinct classes for differing tuples and emits their CSS', () => {
    const r = new FontRegistry();
    const a = r.get('serif', false, false, [0, 0, 0]);
    const c = r.get('serif', true, false, [0, 0, 0]);
    expect(c.cls).not.toBe(a.cls);
    expect(r.css()).toContain('.f0{font-family:"Times New Roman", Times, serif;font-weight:400;font-style:normal;color:#000000}');
    expect(r.css()).toContain('.f1{font-family:"Times New Roman", Times, serif;font-weight:700;font-style:normal;color:#000000}');
  });
});
