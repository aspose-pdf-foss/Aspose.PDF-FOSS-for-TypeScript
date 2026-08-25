import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PageGraphics } from '../src/graphics.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng } from './helpers/decode-png.js';

const near = (v: number, target: number, tol = 14) => Math.abs(v - target) <= tol;

/** Draw on a blank 200x200 page, save, reopen, rasterize at 1 px per point — so
 *  a device pixel (x, y) is user (x, 200 - y).
 *
 *  raster.ts is an independently written READER of shading patterns, so these
 *  assertions are not a round trip through one body of code. */
function render(draw: (g: PageGraphics) => void) {
  const doc = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' }));
  const g = doc.Pages[0].Graphics();
  draw(g);
  g.apply();
  const rt = Document.Open(doc.Save());
  return decodePng(rt.Pages[0].ToImage());
}

const RED: [number, number, number] = [1, 0, 0];
const BLUE: [number, number, number] = [0, 0, 1];

describe('setFillGradient through Save/Open/ToImage', () => {
  it('ramps red → blue left to right across the filled rect', () => {
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });

    const [lr, , lb] = png.at(4, 100);
    expect(lr).toBeGreaterThan(215);
    expect(lb).toBeLessThan(45);
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    const [cr, cg, cb] = png.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('runs a vertical gradient the right way up', () => {
    // y increases UPWARD in user space, so y1=0 is the BOTTOM of the page,
    // which is the bottom row of device pixels.
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 0, y2: 200,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });
    expect(png.at(100, 196)[0]).toBeGreaterThan(215);   // bottom is red
    expect(png.at(100, 4)[2]).toBeGreaterThan(215);     // top is blue
  });

  it('extends the ramp past its endpoints by default', () => {
    // The axis spans only the middle 100pt; /Extend [true true] pads the rest.
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 50, y1: 0, x2: 150, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });
    // Both channels are asserted on each side deliberately. With /Extend
    // [false false] the padded region is simply unpainted WHITE, and white
    // passes a red-channel-only check on the left and a blue-channel-only check
    // on the right — so a one-channel assertion here proves nothing.
    const [lr, lg, lb] = png.at(10, 100);
    expect(lr).toBeGreaterThan(215);                    // padded red
    expect(lg).toBeLessThan(45);
    expect(lb).toBeLessThan(45);
    const [rr, rg, rb] = png.at(190, 100);
    expect(rb).toBeGreaterThan(215);                    // padded blue
    expect(rr).toBeLessThan(45);
    expect(rg).toBeLessThan(45);
  });

  it('applies the CTM to the path but not to the gradient', () => {
    // The invariant from the spec, made visible. Under a 2x scale the rect
    // covers x=0..200 in device space, but the ramp still spans x=0..200 in
    // DEFAULT space — so the midpoint of the painted area is the ramp midpoint.
    const png = render((g) => {
      g.transform(2, 0, 0, 2, 0, 0);
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 100, 100).fill();
    });
    // Path scaled to 200x200 device: the far edge is painted at all.
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    // And the ramp was NOT scaled with it: x=100 is still the midpoint.
    const [cr, , cb] = png.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cb, 128)).toBe(true);
  });

  it('ramps a radial gradient red at the centre out to blue at the rim', () => {
    const png = render((g) => {
      g.setFillGradient({
        kind: 'radial', cx: 100, cy: 100, r: 80,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });

    const [cr, , cb] = png.at(100, 100);
    expect(cr).toBeGreaterThan(215);
    expect(cb).toBeLessThan(45);
    // Half way out to the rim is half way along the ramp — in EVERY direction,
    // which is what separates a radial shading from an axial one.
    for (const [x, y] of [[140, 100], [60, 100], [100, 140], [100, 60]]) {
      const [r, , b] = png.at(x, y);
      expect(near(r, 128)).toBe(true);
      expect(near(b, 128)).toBe(true);
    }
    // Past the rim /Extend pads with the last stop rather than leaving it white.
    const [er, eg, eb] = png.at(196, 196);
    expect(eb).toBeGreaterThan(215);
    expect(er).toBeLessThan(45);
    expect(eg).toBeLessThan(45);
  });

  it('puts the hot spot at an off-centre focal point', () => {
    // Focus 40pt left of the centre of a radius-80 circle. The ramp parameter at
    // a point is where its circle sits between focus and rim: the centre itself
    // is only 1/3 of the way along, so it is no longer pure red.
    const png = render((g) => {
      g.setFillGradient({
        kind: 'radial', cx: 100, cy: 100, r: 80, fx: 60, fy: 100,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).rect(0, 0, 200, 200).fill();
    });

    const [fr, , fb] = png.at(60, 100);
    expect(fr).toBeGreaterThan(215);                    // pure red AT the focus
    expect(fb).toBeLessThan(45);
    const [cr, , cb] = png.at(100, 100);
    expect(near(cr, 170)).toBe(true);                   // t = 1/3 at the centre
    expect(near(cb, 85)).toBe(true);
  });

  it('fades a varying stop alpha out across the ramp', () => {
    // Solid red throughout, so ONLY the alpha varies: opaque on the left,
    // invisible on the right. Over a white page that is red -> white.
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED, opacity: 1 },
                { offset: 1, color: RED, opacity: 0 }],
      }).rect(0, 0, 200, 200).fill();
    });

    const [lr, lg, lb] = png.at(4, 100);
    expect(lr).toBeGreaterThan(215);                    // opaque red
    expect(lg).toBeLessThan(45);
    expect(lb).toBeLessThan(45);
    // Mid-ramp is half-strength red over white: g and b lift to ~128, and it is
    // the assertion a uniform-alpha fallback (or no mask at all) fails.
    const [cr, cg, cb] = png.at(100, 100);
    expect(cr).toBeGreaterThan(215);
    expect(near(cg, 128)).toBe(true);
    expect(near(cb, 128)).toBe(true);
    // The far end is fully masked out: bare white page.
    const [rr, rg, rb] = png.at(196, 100);
    expect(rr).toBeGreaterThan(240);
    expect(rg).toBeGreaterThan(240);
    expect(rb).toBeGreaterThan(240);
  });

  it('applies the CTM to the path but not to the alpha ramp either', () => {
    // The colour half of this invariant is pinned above; the mask half is the
    // one that can silently drift, because a soft-mask group DOES render under
    // the CTM at its `gs` unless its /Matrix undoes it. Constant red, so only
    // the alpha can be read out of the pixels.
    const png = render((g) => {
      g.transform(2, 0, 0, 2, 0, 0);
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED, opacity: 1 },
                { offset: 1, color: RED, opacity: 0 }],
      }).rect(0, 0, 100, 100).fill();
    });
    // Device x=100 is default-space x=100, the ramp midpoint: half alpha, so
    // white lifts g/b to ~128. Under a mask scaled with the CTM the ramp would
    // span 0..400 instead and alpha would be 0.75 here, lifting them to ~64.
    const [r, gg, b] = png.at(100, 100);
    expect(r).toBeGreaterThan(215);
    expect(near(gg, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
  });

  it('masks a radial gradient by distance from the centre', () => {
    const png = render((g) => {
      g.setFillGradient({
        kind: 'radial', cx: 100, cy: 100, r: 80,
        stops: [{ offset: 0, color: BLUE, opacity: 1 },
                { offset: 1, color: BLUE, opacity: 0 }],
      }).rect(0, 0, 200, 200).fill();
    });

    const [cr, cg, cb] = png.at(100, 100);
    expect(cb).toBeGreaterThan(215);                    // opaque at the centre
    expect(cr).toBeLessThan(45);
    expect(cg).toBeLessThan(45);
    // Half way to the rim, half masked — in every direction, as for the colour.
    for (const [x, y] of [[140, 100], [60, 100], [100, 140], [100, 60]]) {
      const [r, gg] = png.at(x, y);
      expect(near(r, 128)).toBe(true);
      expect(near(gg, 128)).toBe(true);
    }
    // /Extend pads the alpha ramp with 0 past the rim, so the corner stays white.
    expect(png.at(196, 196)[0]).toBeGreaterThan(240);
  });

  it('paints a uniform stop alpha as constant transparency', () => {
    const png = render((g) => {
      g.setFillGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED, opacity: 0.5 },
                { offset: 1, color: RED, opacity: 0.5 }],
      }).rect(0, 0, 200, 200).fill();
    });
    // Half-strength red over a white page: r stays high, g and b lift to ~128.
    const [r, gg, b] = png.at(100, 100);
    expect(r).toBeGreaterThan(215);
    expect(near(gg, 128)).toBe(true);
    expect(near(b, 128)).toBe(true);
  });
});

describe('setStrokeGradient through Save/Open/ToImage', () => {
  it('ramps red → blue along a thick stroked line and paints nothing off it', () => {
    const png = render((g) => {
      g.setStrokeGradient({
        kind: 'linear', x1: 0, y1: 0, x2: 200, y2: 0,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).setLineWidth(40).drawLine(0, 100, 200, 100).stroke();
    });

    // The line covers user y 80..120, i.e. the same device rows.
    const [lr, , lb] = png.at(4, 100);
    expect(lr).toBeGreaterThan(215);
    expect(lb).toBeLessThan(45);
    const [rr, , rb] = png.at(196, 100);
    expect(rr).toBeLessThan(45);
    expect(rb).toBeGreaterThan(215);
    const [cr, cg, cb] = png.at(100, 100);
    expect(near(cr, 128)).toBe(true);
    expect(near(cg, 0)).toBe(true);
    expect(near(cb, 128)).toBe(true);

    // Off the line the page is untouched. This is what proves the shading was
    // clipped to the STROKE: a fill-side mix-up would flood the whole page.
    expect(png.at(4, 20).slice(0, 3)).toEqual([255, 255, 255]);
    expect(png.at(100, 180).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('strokes a radial ramp centred on the circle it draws', () => {
    const png = render((g) => {
      g.setStrokeGradient({
        kind: 'radial', cx: 100, cy: 100, r: 60,
        stops: [{ offset: 0, color: RED }, { offset: 1, color: BLUE }],
      }).setLineWidth(20).circle(100, 100, 60).stroke();
    });

    // The stroke straddles r = 60, where the ramp has reached its last stop.
    const [r, , b] = png.at(160, 100);
    expect(b).toBeGreaterThan(r);
    // Inside the circle, away from the stroke, nothing was painted.
    expect(png.at(100, 100).slice(0, 3)).toEqual([255, 255, 255]);
  });
});
