// test/cssframe-slices.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { frameBoxes } from '../src/cssframe.js';
import { paragraph } from '../src/flow.js';

const PARAS = Array.from({ length: 60 }, (_, i) => `<p style="margin:0">line ${i}</p>`).join('');
describe('rounded, layered slices (v9j3.4)', () => {
  it('only the true top and bottom corners are rounded across a page break', () => {
    const d = Document.New();
    d.AddHtml(`<div style="background:#ff0000;border-radius:30px;font-family:Helvetica;font-size:24px">${PARAS}</div>`);
    expect(d.Pages.length).toBeGreaterThan(1);
    const pngs = d.Pages.map((p) => decodePng(p.ToImage({ scale: 1 })));
    const red = (png: ReturnType<typeof decodePng>, x: number, y: number) => { const [r, g] = png.at(x, y); return r > 200 && g < 80; };
    // The box's left edge is x 78 (72pt margin + 6pt body margin); radius 30px = 22.5pt.
    // page 1: top-left corner cut, bottom-left corner (at the page break) square
    const first = pngs[0];
    const topRow = [...Array(first.height).keys()].find((y) => red(first, 200, y))!;
    expect(red(first, 79, topRow + 1)).toBe(false);
    const bottomRow = [...Array(first.height).keys()].reverse().find((y) => red(first, 200, y))!;
    expect(red(first, 79, bottomRow - 1)).toBe(true);
    // last page: bottom-left corner cut
    const last = pngs[pngs.length - 1];
    const lastBottom = [...Array(last.height).keys()].reverse().find((y) => red(last, 200, y))!;
    expect(red(last, 79, lastBottom - 1)).toBe(false);
  });
  it('a gradient continues across the break: page 2 starts where page 1 ended', () => {
    const d = Document.New();
    d.AddHtml(`<div style="background:linear-gradient(#ff0000, #0000ff);font-family:Helvetica;font-size:24px">${PARAS}</div>`);
    const pngs = d.Pages.map((p) => decodePng(p.ToImage({ scale: 1 })));
    const blueAt = (png: ReturnType<typeof decodePng>, y: number) => png.at(200, y)[2];
    const p1 = pngs[0];
    const p1Bottom = [...Array(p1.height).keys()].reverse().find((y) => p1.at(200, y)[1] < 80)!;
    const p2 = pngs[1];
    const p2Top = [...Array(p2.height).keys()].find((y) => p2.at(200, y)[1] < 80)!;
    expect(Math.abs(blueAt(p2, p2Top) - blueAt(p1, p1Bottom))).toBeLessThan(12);
    // …and the ramp really PROGRESSED down page 1: a slice that restarted the
    // gradient at its own top would leave both ends of the break near red,
    // which the comparison above alone cannot see.
    const p1Top = [...Array(p1.height).keys()].find((y) => p1.at(200, y)[1] < 80)!;
    expect(blueAt(p1, p1Bottom) - blueAt(p1, p1Top)).toBeGreaterThan(40);
  });
});
it('frameBoxes paints a rounded colour box from a hand-built frame', () => {
  const d = Document.New();
  const els = frameBoxes(paragraph('x', { font: 'Helvetica', fontSize: 40 }), {
    marginLeft: 0, marginRight: 0, insetLeft: 0, insetRight: 0, insetTop: 0, insetBottom: 0,
    background: [1, 0, 0], minHeight: 0,
    radii: Array.from({ length: 4 }, () => ({ x: { abs: 20, frac: 0 }, y: { abs: 20, frac: 0 } })),
  });
  d.NewFlow({ marginLeft: 72, marginTop: 72 }).AddElements(els).Render();
  const png = decodePng(d.Pages[d.Pages.length - 1].ToImage({ scale: 1 }));
  const topRow = [...Array(png.height).keys()].find((y) => png.at(300, y)[1] < 80)!;
  expect(png.at(73, topRow + 1)[1]).toBeGreaterThan(200);           // corner cut: not red
});
