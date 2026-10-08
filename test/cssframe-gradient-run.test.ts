import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodePng } from './helpers/decode-png.js';

// v9j3.4: a box holding several children paints one slice per child, and its
// gradient is laid out over the WHOLE box — `BoxRun.natural` gives the box's
// height, gaps between the children included, and `BoxRun.used` how far down
// the box each slice starts, the gap the previous slice painted over
// included. Either one wrong and the ramp is no longer one line from the
// box's top to its bottom: it restarts, or reaches its end colour early.
describe('a multi-child box ramps its gradient once, top to bottom', () => {
  it('t = blue / (red + blue) grows linearly down the whole box, across the gaps', () => {
    const d = Document.New();
    d.AddHtml(
      '<div style="background:linear-gradient(#f00,#00f);font-family:Helvetica">'
      + '<p style="margin:30px 0">a</p><p style="margin:30px 0">b</p><p style="margin:30px 0">c</p></div>',
      { format: PageFormat.custom(300, 400), marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0 },
    );
    const png = decodePng(d.Pages[0].ToImage({ scale: 1 }));
    const ch = png.data.length / (png.width * png.height);
    const x = png.width - 20;                                  // clear of the one-letter text
    const at = (y: number): [number, number, number] => {
      const i = (y * png.width + x) * ch;
      return [png.data[i], png.data[i + 1], png.data[i + 2]];
    };
    const painted = (y: number): boolean => { const [r, g, b] = at(y); return !(r > 245 && g > 245 && b > 245); };
    let top = 0; while (top < png.height && !painted(top)) top++;
    let bottom = top; while (bottom < png.height && painted(bottom)) bottom++;
    expect(bottom - top).toBeGreaterThan(60);
    let worst = 0;
    for (let y = top + 2; y < bottom - 2; y += 3) {
      const [r, , b] = at(y);
      const t = b / (r + b), want = (y + 0.5 - top) / (bottom - top);
      worst = Math.max(worst, Math.abs(t - want));
    }
    expect(worst).toBeLessThan(0.04);
  });
});
