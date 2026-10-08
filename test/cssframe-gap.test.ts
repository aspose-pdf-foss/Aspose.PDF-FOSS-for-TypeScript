// test/cssframe-gap.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';

const column = (html: string, x = 100) => {
  const d = Document.New(); d.AddHtml(html);
  const png = decodePng(d.Pages[d.Pages.length - 1].ToImage({ scale: 1 }));
  let s = '';
  for (let y = 0; y < 200; y++) { const [r, g] = png.at(x, y); s += r > 200 && g < 80 ? 'R' : r > 200 ? '.' : '#'; }
  return s;
};

describe('a box background covers the gaps between its children (v9j3.4 Fixed)', () => {
  it('one unbroken red run from the first paragraph to the last', () => {
    const s = column('<div style="background:#ff0000;font-family:Helvetica"><p style="margin:20px 0">AAA</p><p style="margin:20px 0">BBB</p></div>');
    const first = s.indexOf('R'), last = s.lastIndexOf('R');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(s.slice(first, last + 1)).not.toContain('.');               // no white hole
  });
  it('the side borders run through the gap too', () => {
    const s = column('<div style="border-left:6px solid #ff0000;font-family:Helvetica"><p style="margin:20px 0">AAA</p><p style="margin:20px 0">BBB</p></div>', 80);   // 72pt flow margin + 6pt body margin: the border is 78..82.5
    const first = s.indexOf('R'), last = s.lastIndexOf('R');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(s.slice(first, last + 1)).not.toContain('.');
  });
});

describe('an empty box still paints its own decoration (v9j3.4 Fixed)', () => {
  const box = (html: string) => {
    const d = Document.New(); d.AddHtml(html);
    const png = decodePng(d.Pages[d.Pages.length - 1].ToImage({ scale: 1 }));
    let x0 = -1, y0 = -1, x1 = -1, y1 = -1;
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const [r, g] = png.at(x, y);
      if (r > 200 && g < 80) { if (x0 < 0 || x < x0) x0 = x; if (y0 < 0) y0 = y; x1 = Math.max(x1, x); y1 = y; }
    }
    return [x0, y0, x1, y1];
  };
  it('a sized empty div with a background paints its whole box', () => {
    // 72pt margin + 6pt body margin at the left; at the top body's margin collapses
    // out of the root and is dropped (cssflow.ts), so the box starts at 72. 200x100px = 150x75pt.
    expect(box('<div style="width:200px;height:100px;background:#ff0000"></div>')).toEqual([78, 72, 227, 146]);
  });
  it('so does one whose only content draws nothing', () => {
    expect(box('<div style="width:200px;height:100px;background:#ff0000">&nbsp;</div>')).toEqual([78, 72, 227, 146]);
  });
  it('padding alone gives an empty box its height', () => {
    const [, y0, , y1] = box('<div style="padding:20px;background:#ff0000"></div>');
    expect(y1 - y0 + 1).toBe(30);                                    // 40px = 30pt
  });
});

describe('CSS height sizes the CONTENT box (v9j3.4 Fixed)', () => {
  const tall = (html: string) => {
    const d = Document.New(); d.AddHtml(html);
    const png = decodePng(d.Pages[0].ToImage({ scale: 1 }));
    let y0 = -1, y1 = -1;
    for (let y = 0; y < png.height; y++) { const [r, g] = png.at(300, y); if (r > 200 && g < 80) { if (y0 < 0) y0 = y; y1 = y; } }
    return y1 - y0 + 1;
  };
  it('height plus padding: 100px + 2 x 20px = 140px = 105pt', () => {
    expect(tall('<div style="height:100px;padding:20px;background:#ff0000;font-family:Helvetica">x</div>')).toBe(105);
  });
  it('an empty box: height plus borders', () => {
    expect(tall('<div style="height:100px;border:10px solid #ff0000"></div>')).toBe(90);   // 120px
  });
});
