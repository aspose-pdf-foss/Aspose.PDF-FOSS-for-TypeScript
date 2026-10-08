import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodePng } from './helpers/decode-png.js';
import { clipStopsAtZero } from '../src/boxpaint.js';

// v9j3.4 final review, two radial-gradient edge cases.
const render = (bg: string) => {
  const d = Document.New();
  d.AddHtml(`<div style="width:200px;height:100px;background:${bg}"></div>`,
    { format: PageFormat.custom(150, 75), marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0 });
  return decodePng(Document.Open(d.Save()).Pages[0].ToImage({ scale: 96 / 72 }));
};

describe('a radial gradient with a stop before its centre', () => {
  it('starts at the colour INTERPOLATED at the centre, not at the clamped stop', () => {
    // red at -50%, blue at 50%: the centre is half way, purple.
    const [r, g, b] = render('radial-gradient(red -50%, blue 50%)').at(100, 50);
    expect(Math.abs(r - 128)).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    expect(Math.abs(b - 128)).toBeLessThan(20);
  });
  it('clipStopsAtZero interpolates colour and alpha at 0 and drops what lies before it', () => {
    const s = clipStopsAtZero([
      { t: -1, color: [1, 0, 0], alpha: 1 }, { t: 1, color: [0, 0, 1], alpha: 0 }]);
    expect(s).toEqual([{ t: 0, color: [0.5, 0, 0.5], alpha: 0.5 }, { t: 1, color: [0, 0, 1], alpha: 0 }]);
    const all = [{ t: -2, color: [1, 0, 0] as [number, number, number], alpha: 1 }, { t: -1, color: [0, 1, 0] as [number, number, number], alpha: 1 }];
    expect(clipStopsAtZero(all)).toEqual([{ t: 0, color: [0, 1, 0], alpha: 1 }]);
    const none = [{ t: 0, color: [1, 0, 0] as [number, number, number], alpha: 1 }, { t: 1, color: [0, 0, 1] as [number, number, number], alpha: 1 }];
    expect(clipStopsAtZero(none)).toEqual(none);
  });
});

describe('a degenerate radial ending shape', () => {
  it('paints the last colour rather than nothing (CSS Images 3: a vanishing ellipse)', () => {
    // closest-side from a centre on the top edge: ry = 0.
    const png = render('radial-gradient(closest-side at 50% 0%, red, blue)');
    const [r, g, b] = png.at(100, 60);
    expect(r).toBeLessThan(20);
    expect(g).toBeLessThan(20);
    expect(b).toBeGreaterThan(235);
  });
});
