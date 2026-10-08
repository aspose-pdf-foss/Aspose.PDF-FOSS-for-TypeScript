import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodePng } from './helpers/decode-png.js';

// v9j3.8: a multi-child box's gradient is laid out over the WHOLE unbroken box
// (box-decoration-break: slice), so the slice after a column break must start
// where it sits in that box. When the break fell INSIDE the gap between two
// children, BoxRun.used grew by the painted part of the gap only, every later
// slice started too high, and the ramp stopped short of its final colour.
function lastSliceBottom(leadLines: number): [number, number, number] {
  const d = Document.New();
  d.AddHtml('<p style="margin:0;font-size:20px;font-family:Helvetica">lead</p>'.repeat(leadLines)
    + '<div style="background:linear-gradient(#f00,#00f);font-family:Helvetica;font-size:20px;padding:1px 0">'
    + '<p style="margin:0">first</p><p style="margin:200px 0 0">second</p></div>',
  { format: PageFormat.custom(300, 400), marginLeft: 0, marginRight: 0, marginTop: 20, marginBottom: 20 });
  expect(d.Pages.length).toBe(2);
  const png = decodePng(d.Pages[1].ToImage({ scale: 1 }));
  let bottom = png.height - 1;
  while (bottom >= 0) { const [r, g, b] = png.at(280, bottom); if (!(r > 245 && g > 245 && b > 245)) break; bottom--; }
  const [r, g, b] = png.at(280, bottom - 2);                 // clear of the antialiased edge
  return [r, g, b];
}

describe('a gradient box broken inside a gap reaches its final colour', () => {
  it('the break falls inside the 200px gap: the last slice still ends blue', () => {
    const [r, , b] = lastSliceBottom(14);
    expect(r).toBeLessThan(20);
    expect(b).toBeGreaterThan(235);
  });
  it('control: the break falls between the children, no gap cut', () => {
    const [r, , b] = lastSliceBottom(10);
    expect(r).toBeLessThan(20);
    expect(b).toBeGreaterThan(235);
  });
});
