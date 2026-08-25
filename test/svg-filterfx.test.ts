import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import {
  makeSurface, toSurface, surfaceImage, srgbToLinear, linearToSrgb, convertSpace,
  runFilter, type Surface,
} from '../src/svgfilterfx.js';
import { resolveFilter, type FilterSpec } from '../src/svgfilter.js';
import { parseXml, type XmlNode } from '../src/xml.js';
import { isName } from '../src/types.js';

const near = (a: number, b: number, d = 6) => expect(a).toBeCloseTo(b, d);

describe('sRGB <-> linear', () => {
  it('fixes the endpoints', () => {
    near(srgbToLinear(0), 0); near(srgbToLinear(1), 1);
    near(linearToSrgb(0), 0); near(linearToSrgb(1), 1);
  });

  it('matches the IEC 61966-2-1 piecewise curve at mid gray', () => {
    // 0.5 sRGB -> ((0.5 + 0.055)/1.055)^2.4, the published value.
    near(srgbToLinear(0.5), 0.21404114, 7);
  });

  it('uses the LINEAR segment below the 0.04045 knee', () => {
    // Below the knee the curve is v/12.92, not the power form.
    near(srgbToLinear(0.03), 0.03 / 12.92, 7);
    expect(srgbToLinear(0.03)).not.toBeCloseTo(Math.pow((0.03 + 0.055) / 1.055, 2.4), 5);
  });

  it('round-trips', () => {
    for (const v of [0.02, 0.1, 0.25, 0.5, 0.75, 0.99]) near(linearToSrgb(srgbToLinear(v)), v);
  });
});

describe('toSurface', () => {
  it('premultiplies and linearizes straight sRGB bytes', () => {
    // One pixel: mid-gray at half alpha.
    const img = { w: 1, h: 1, data: new Uint8Array([128, 128, 128, 128]) };
    const s = toSurface(img);
    expect(s.w).toBe(1); expect(s.h).toBe(1);
    expect(s.x).toBe(0); expect(s.y).toBe(0);
    const a = 128 / 255;
    near(s.data[3], a, 5);
    near(s.data[0], srgbToLinear(128 / 255) * a, 5);
  });

  it('leaves a transparent pixel at zero in every channel', () => {
    const img = { w: 1, h: 1, data: new Uint8Array([255, 0, 0, 0]) };
    const s = toSurface(img);
    for (let i = 0; i < 4; i++) near(s.data[i], 0);
  });
});

describe('surfaceImage', () => {
  it('emits a Flate DeviceRGB image with a DeviceGray /SMask', () => {
    const s = makeSurface(0, 0, 2, 1);
    // Opaque red, opaque white — premultiplied linear.
    s.data.set([1, 0, 0, 1, 1, 1, 1, 1]);
    const built = surfaceImage(s);
    const d = built.stream.dict;
    expect(d.get('Width')).toBe(2);
    expect(d.get('Height')).toBe(1);
    expect(d.get('BitsPerComponent')).toBe(8);
    const cs = d.get('ColorSpace');
    expect(isName(cs) && cs.name).toBe('DeviceRGB');
    const f = d.get('Filter');
    expect(isName(f) && f.name).toBe('FlateDecode');
    expect(built.smask).toBeDefined();
    const sm = built.smask!.dict.get('ColorSpace');
    expect(isName(sm) && sm.name).toBe('DeviceGray');
  });

  it('writes sRGB bytes, unpremultiplied', () => {
    const s = makeSurface(0, 0, 1, 1);
    // Linear 0.21404 at alpha 0.5, premultiplied: a mid-gray sRGB pixel.
    s.data.set([0.21404114 * 0.5, 0.21404114 * 0.5, 0.21404114 * 0.5, 0.5]);
    const built = surfaceImage(s);
    const rgb = inflateSync(Buffer.from(built.stream.raw!));
    expect(Math.abs(rgb[0] - 128)).toBeLessThanOrEqual(1);
    const alpha = inflateSync(Buffer.from(built.smask!.raw!));
    expect(Math.abs(alpha[0] - 128)).toBeLessThanOrEqual(1);
  });

  it('round-trips a rasterized image through both edges', () => {
    // The differential rule: this checks toSurface against surfaceImage, which
    // is only meaningful because the two are inverses by construction and the
    // curve itself is pinned against published values above.
    const img = { w: 1, h: 1, data: new Uint8Array([200, 100, 50, 255]) };
    const built = surfaceImage(toSurface(img));
    const rgb = inflateSync(Buffer.from(built.stream.raw!));
    expect(Math.abs(rgb[0] - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(rgb[1] - 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(rgb[2] - 50)).toBeLessThanOrEqual(1);
  });
});

describe('convertSpace', () => {
  it('unpremultiplies before converting', () => {
    // Premultiplied linear mid-gray at half alpha. Converting the PREMULTIPLIED
    // value through the transfer function is the bug this guards: it would give
    // linearToSrgb(0.107) = 0.368, not 0.5*0.5 = 0.25.
    const s = makeSurface(0, 0, 1, 1);
    const lin = srgbToLinear(0.5);
    s.data.set([lin * 0.5, lin * 0.5, lin * 0.5, 0.5]);
    const out = convertSpace(s, 'sRGB');
    near(out.data[0], 0.5 * 0.5, 5);      // 0.5 sRGB, premultiplied by 0.5
    near(out.data[3], 0.5, 6);            // alpha is untouched
  });

  it('is a no-op on a transparent pixel', () => {
    const s = makeSurface(0, 0, 1, 1);
    const out = convertSpace(s, 'sRGB');
    for (let i = 0; i < 4; i++) near(out.data[i], 0);
  });

  it('round-trips linear -> sRGB -> linear', () => {
    const s = makeSurface(0, 0, 1, 1);
    s.data.set([0.3 * 0.8, 0.1 * 0.8, 0.9 * 0.8, 0.8]);
    const back = convertSpace(convertSpace(s, 'sRGB'), 'linearRGB');
    for (let i = 0; i < 4; i++) near(back.data[i], s.data[i], 4);
  });
});

const xmlBytes = (s: string) => new TextEncoder().encode(s);
const VP = { minX: 0, minY: 0, w: 100, h: 100 };

/** Resolve a <filter> whose region is exactly `size` square, so at scale 1 one
 *  user unit is one pixel and every expectation below can be read off directly. */
function specSized(prims: string, size = 10): FilterSpec {
  const root = parseXml(xmlBytes(
    '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
    `width="${size}" height="${size}">${prims}</filter></svg>`));
  let f: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.name === 'filter') f ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  const r = resolveFilter(f!, { x: 0, y: 0, w: size, h: size }, VP);
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}
const specOf = (prims: string): FilterSpec => specSized(prims, 10);

/** A 10x10 source: opaque white in the top-left 2x2, transparent elsewhere. */
function source(): Surface {
  const s = makeSurface(0, 0, 10, 10);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const i = (y * 10 + x) * 4;
    s.data[i] = 1; s.data[i + 1] = 1; s.data[i + 2] = 1; s.data[i + 3] = 1;
  }
  return s;
}

const px = (s: Surface, x: number, y: number): number[] =>
  [...s.data.slice((y * s.w + x) * 4, (y * s.w + x) * 4 + 4)];

describe('runFilter — feOffset', () => {
  it('shifts by dx/dy in user units scaled to pixels', () => {
    const out = runFilter(specOf('<feOffset dx="3" dy="4"/>'), source(), 1);
    near(px(out, 3, 4)[3], 1);
    near(px(out, 0, 0)[3], 0);
  });

  it('scales the shift with the raster scale', () => {
    const out = runFilter(specOf('<feOffset dx="3" dy="0"/>'), source(), 1);
    // A 20x20 raster of the same 10x10 region: the 2x2 block is now 4x4.
    const big = makeSurface(0, 0, 20, 20);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
      big.data.set([1, 1, 1, 1], (y * 20 + x) * 4);
    const out2 = runFilter(specOf('<feOffset dx="3" dy="0"/>'), big, 2);
    near(px(out, 3, 0)[3], 1);
    near(px(out2, 6, 0)[3], 1);          // 3 user units at 2 px/unit
  });

  it('drops pixels shifted outside the region', () => {
    const out = runFilter(specOf('<feOffset dx="-5" dy="0"/>'), source(), 1);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) near(px(out, x, y)[3], 0);
  });

  it('defaults dx and dy to zero', () => {
    const out = runFilter(specOf('<feOffset/>'), source(), 1);
    near(px(out, 0, 0)[3], 1);
  });

  it('is clipped to its subregion', () => {
    // The subregion clip, on a kernel that paints the WHOLE raster. feFlood
    // cannot test this: it only ever writes its own window, so it would pass
    // with the clip removed. SVG 1.1 §15.7.5 forbids painting outside.
    const out = runFilter(
      specOf('<feOffset dx="0" dy="0" x="0" y="0" width="1" height="1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 5);        // inside the subregion
    near(px(out, 1, 0)[3], 0, 5);        // source ink, cut by the subregion
    near(px(out, 0, 1)[3], 0, 5);
  });
});

describe('runFilter — feFlood', () => {
  it('fills the subregion with flood-color at flood-opacity', () => {
    const out = runFilter(
      specOf('<feFlood flood-color="#ff0000" flood-opacity="0.5"/>'), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 0.5, 5);
    near(p[0], 1 * 0.5, 5);              // linear red 1.0, premultiplied
    near(p[1], 0, 5);
  });

  it('fills ONLY its subregion', () => {
    const out = runFilter(
      specOf('<feFlood flood-color="#ff0000" x="0" y="0" width="4" height="4"/>'),
      source(), 1);
    near(px(out, 2, 2)[3], 1);
    near(px(out, 6, 6)[3], 0);
  });

  it('defaults to opaque black', () => {
    const out = runFilter(specOf('<feFlood/>'), source(), 1);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 1]);
  });

  it('converts the flood colour into the working space', () => {
    // sRGB 0.5 gray floods to LINEAR 0.214 under the default linearRGB.
    const out = runFilter(specOf('<feFlood flood-color="#808080"/>'), source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(128 / 255), 3);
  });

  it('leaves a sRGB primitive in sRGB while it runs, and hands back linear', () => {
    // The pipeline's contract: runFilter always RETURNS linear, whatever any
    // individual primitive asked to work in.
    const out = runFilter(
      specOf('<feFlood flood-color="#808080" color-interpolation-filters="sRGB"/>'),
      source(), 1);
    near(px(out, 5, 5)[0], srgbToLinear(128 / 255), 3);
  });
});

describe('runFilter — graph', () => {
  it("returns the LAST primitive's result", () => {
    const out = runFilter(
      specOf('<feFlood flood-color="#ff0000"/><feOffset in="SourceGraphic" dx="1"/>'),
      source(), 1);
    near(px(out, 1, 0)[3], 1);
    near(px(out, 5, 5)[3], 0);           // the flood is not the result
  });

  it('feeds SourceAlpha as black at the source alpha', () => {
    const out = runFilter(specOf('<feOffset in="SourceAlpha" dx="0"/>'), source(), 1);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 1]);
  });
});

describe('runFilter — feMerge', () => {
  it('stacks its nodes bottom-first', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" result="r"/>' +
      '<feFlood flood-color="#0000ff" x="0" y="0" width="4" height="4" result="b"/>' +
      '<feMerge><feMergeNode in="r"/><feMergeNode in="b"/></feMerge>'), source(), 1);
    // Blue is listed second, so it is on top inside its 4x4 subregion.
    near(px(out, 2, 2)[2], 1, 3);
    near(px(out, 2, 2)[0], 0, 3);
    // Outside it, red shows.
    near(px(out, 6, 6)[0], 1, 3);
  });

  it('is source-over, not replacement', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" result="r"/>' +
      '<feFlood flood-color="#0000ff" flood-opacity="0.5" result="b"/>' +
      '<feMerge><feMergeNode in="r"/><feMergeNode in="b"/></feMerge>'), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 1, 3);
    near(p[0], 0.5, 3);          // red at 1-0.5
    near(p[2], 0.5, 3);
  });

  it('produces transparent black for an feMerge with no nodes', () => {
    const out = runFilter(specOf('<feMerge/>'), source(), 1);
    expect(px(out, 5, 5)).toEqual([0, 0, 0, 0]);
  });
});

describe('runFilter — feComposite', () => {
  /** Two overlapping opaque floods: A over the left 6 columns, B over the top 6
   *  rows. (2,2) is in both, (8,2) is in B only, (2,8) is in A only, (8,8) in
   *  neither. */
  const AB = (op: string) =>
    '<feFlood flood-color="#ff0000" x="0" y="0" width="6" height="10" result="a"/>' +
    '<feFlood flood-color="#0000ff" x="0" y="0" width="10" height="6" result="b"/>' +
    `<feComposite in="a" in2="b" operator="${op}"/>`;

  it('over: A where A is, B where only B is', () => {
    const out = runFilter(specOf(AB('over')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);        // A wins in the overlap
    near(px(out, 8, 2)[2], 1, 3);        // B alone
    near(px(out, 2, 8)[0], 1, 3);        // A alone
    near(px(out, 8, 8)[3], 0, 3);
  });

  it('in: A only where B is', () => {
    const out = runFilter(specOf(AB('in')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);
    near(px(out, 2, 8)[3], 0, 3);        // A without B: gone
    near(px(out, 8, 2)[3], 0, 3);        // B without A: never contributes colour
  });

  it('out: A only where B is not', () => {
    const out = runFilter(specOf(AB('out')), source(), 1);
    near(px(out, 2, 2)[3], 0, 3);
    near(px(out, 2, 8)[0], 1, 3);
  });

  it('atop: A over B, clipped to B', () => {
    const out = runFilter(specOf(AB('atop')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);        // A in the overlap
    near(px(out, 8, 2)[2], 1, 3);        // B outside A
    near(px(out, 2, 8)[3], 0, 3);        // A outside B: dropped
  });

  it('xor: either but not both', () => {
    const out = runFilter(specOf(AB('xor')), source(), 1);
    near(px(out, 2, 2)[3], 0, 3);
    near(px(out, 2, 8)[0], 1, 3);
    near(px(out, 8, 2)[2], 1, 3);
  });

  it('arithmetic: k1*i1*i2 + k2*i1 + k3*i2 + k4, per channel', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" flood-opacity="0.5" result="a"/>' +
      '<feFlood flood-color="#ffffff" flood-opacity="0.25" result="b"/>' +
      '<feComposite in="a" in2="b" operator="arithmetic" ' +
      'k1="1" k2="0.5" k3="0.25" k4="0.1"/>'), source(), 1);
    // Alpha: 1*0.5*0.25 + 0.5*0.5 + 0.25*0.25 + 0.1 = 0.125+0.25+0.0625+0.1
    near(px(out, 5, 5)[3], 0.5375, 3);
  });

  it('clamps an arithmetic result into 0..1', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="a"/>' +
      '<feComposite in="a" in2="a" operator="arithmetic" k2="5"/>'), source(), 1);
    near(px(out, 5, 5)[3], 1, 6);
  });

  it('defaults to over', () => {
    const out = runFilter(specOf(AB('bogus')), source(), 1);
    near(px(out, 2, 2)[0], 1, 3);
  });
});

describe('runFilter — feBlend', () => {
  const two = (mode: string, ca: string, cb: string) =>
    `<feFlood flood-color="${ca}" result="a"/>` +
    `<feFlood flood-color="${cb}" result="b"/>` +
    `<feBlend in="a" in2="b" mode="${mode}"/>`;

  it('normal is source-over', () => {
    const out = runFilter(specOf(two('normal', '#ff0000', '#0000ff')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
    near(px(out, 5, 5)[2], 0, 3);
  });

  it('multiply darkens: opaque cr = ca*cb', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" result="a"/>' +
      '<feFlood flood-color="#ffffff" result="b"/>' +
      '<feBlend in="a" in2="b" mode="multiply"/>'), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);      // red x white = red
    near(px(out, 5, 5)[1], 0, 3);
  });

  it('screen lightens: 1-(1-ca)(1-cb)', () => {
    const out = runFilter(specOf(two('screen', '#ff0000', '#0000ff')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 1, 3); near(p[2], 1, 3);
  });

  it('darken takes the per-channel minimum where both are opaque', () => {
    const out = runFilter(specOf(two('darken', '#ff0000', '#0000ff')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 0, 3); near(p[2], 0, 3);
  });

  it('lighten takes the per-channel maximum', () => {
    const out = runFilter(specOf(two('lighten', '#ff0000', '#0000ff')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 1, 3); near(p[2], 1, 3);
  });

  it('falls back to normal for an unknown mode', () => {
    const out = runFilter(specOf(two('color-dodge', '#ff0000', '#0000ff')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
  });
});

describe('runFilter — feColorMatrix', () => {
  /** An opaque flood of `c`, colour-matrixed. */
  const cm = (c: string, attrs: string) =>
    `<feFlood flood-color="${c}" result="a"/><feColorMatrix in="a" ${attrs}/>`;

  it('saturate=0 applies the spec luminance coefficients', () => {
    // SVG 1.1 15.7.6: 0.2126 R + 0.7152 G + 0.0722 B (the published values).
    const out = runFilter(specOf(cm('#ff0000', 'type="saturate" values="0"')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 0.2126, 3);
    near(p[1], 0.2126, 3);
    near(p[2], 0.2126, 3);
    near(p[3], 1, 6);
  });

  it('saturate=1 is the identity', () => {
    const out = runFilter(specOf(cm('#ff0000', 'type="saturate" values="1"')), source(), 1);
    near(px(out, 5, 5)[0], 1, 4);
    near(px(out, 5, 5)[1], 0, 4);
  });

  it('luminanceToAlpha writes luminance into alpha and zeroes colour', () => {
    const out = runFilter(specOf(cm('#00ff00', 'type="luminanceToAlpha"')), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 0.7152, 3);
    near(p[0], 0, 4); near(p[1], 0, 4); near(p[2], 0, 4);
  });

  it('hueRotate by 360 degrees is the identity', () => {
    const out = runFilter(specOf(cm('#ff0000', 'type="hueRotate" values="360"')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
    near(px(out, 5, 5)[1], 0, 3);
  });

  it('type=matrix takes the 20 values row-major', () => {
    // Swap R and B, keep alpha.
    const out = runFilter(specOf(cm('#ff0000',
      'type="matrix" values="0 0 1 0 0  0 1 0 0 0  1 0 0 0 0  0 0 0 1 0"')), source(), 1);
    const p = px(out, 5, 5);
    near(p[0], 0, 4); near(p[2], 1, 3);
  });

  it('operates on NON-premultiplied values', () => {
    // A half-transparent red. An identity colour part with a constant alpha of
    // 1 must give FULL red, not the premultiplied 0.5 red that reusing the
    // stored value would produce.
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" flood-opacity="0.5" result="a"/>' +
      '<feColorMatrix in="a" type="matrix" ' +
      'values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1"/>'), source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 1, 4);
    near(p[0], 1, 3);
  });

  it('defaults to the identity matrix for a malformed values list', () => {
    const out = runFilter(specOf(cm('#ff0000', 'type="matrix" values="1 2 3"')), source(), 1);
    near(px(out, 5, 5)[0], 1, 4);
  });
});

describe('runFilter — feComponentTransfer', () => {
  const ct = (c: string, funcs: string) =>
    `<feFlood flood-color="${c}" result="a"/>` +
    `<feComponentTransfer in="a">${funcs}</feComponentTransfer>`;

  it('linear applies slope*C + intercept', () => {
    const out = runFilter(specOf(ct('#ffffff',
      '<feFuncR type="linear" slope="0.5" intercept="0.1"/>')), source(), 1);
    near(px(out, 5, 5)[0], 0.6, 4);
    near(px(out, 5, 5)[1], 1, 4);          // G untouched: no feFuncG
  });

  it('table interpolates between its entries', () => {
    // C = 1 lands on the last entry exactly.
    const out = runFilter(specOf(ct('#ffffff',
      '<feFuncR type="table" tableValues="0 0.25"/>')), source(), 1);
    near(px(out, 5, 5)[0], 0.25, 4);
  });

  it('table interpolates in the middle', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="w"/>' +
      '<feComponentTransfer in="w">' +
      '<feFuncR type="linear" slope="0.5"/></feComponentTransfer>' +
      '<feComponentTransfer><feFuncR type="table" tableValues="0 1"/>' +
      '</feComponentTransfer>'), source(), 1);
    near(px(out, 5, 5)[0], 0.5, 3);
  });

  it('discrete steps without interpolating', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="w"/>' +
      '<feComponentTransfer in="w">' +
      '<feFuncR type="linear" slope="0.5"/></feComponentTransfer>' +
      '<feComponentTransfer><feFuncR type="discrete" tableValues="0 0.3 0.9"/>' +
      '</feComponentTransfer>'), source(), 1);
    // n=3, C=0.5 -> k = floor(0.5*3) = 1 -> v[1] = 0.3.
    near(px(out, 5, 5)[0], 0.3, 3);
  });

  it('gamma applies amplitude*C^exponent + offset', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" result="w"/>' +
      '<feComponentTransfer in="w">' +
      '<feFuncR type="linear" slope="0.25"/></feComponentTransfer>' +
      '<feComponentTransfer><feFuncR type="gamma" amplitude="1" exponent="0.5" offset="0.1"/>' +
      '</feComponentTransfer>'), source(), 1);
    // Deliberately in range: a result over 1 would be clamped, and the clamp
    // would mask the formula it is meant to check.
    near(px(out, 5, 5)[0], Math.sqrt(0.25) + 0.1, 3);
  });

  it('clamps a transfer result into 0..1', () => {
    const out = runFilter(specOf(ct('#ffffff',
      '<feFuncR type="linear" slope="5"/>')), source(), 1);
    near(px(out, 5, 5)[0], 1, 6);
  });

  it('identity and an absent function both leave the channel alone', () => {
    const out = runFilter(specOf(ct('#ff8000', '<feFuncR type="identity"/>')), source(), 1);
    near(px(out, 5, 5)[0], 1, 3);
  });

  it('transfers alpha, and operates on NON-premultiplied colour', () => {
    // Half-transparent white with alpha forced to 1: the colour must come back
    // to full white, which only holds if the kernel unpremultiplied first.
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" flood-opacity="0.5" result="a"/>' +
      '<feComponentTransfer in="a">' +
      '<feFuncA type="linear" slope="0" intercept="1"/></feComponentTransfer>'),
      source(), 1);
    const p = px(out, 5, 5);
    near(p[3], 1, 4);
    near(p[0], 1, 3);
  });
});

describe('runFilter — feGaussianBlur', () => {
  /** A single opaque white pixel at the centre of a 21x21 region. */
  function delta(): Surface {
    const s = makeSurface(0, 0, 21, 21);
    s.data.set([1, 1, 1, 1], (10 * 21 + 10) * 4);
    return s;
  }
  const bigSpec = (prims: string) => specSized(prims, 21);
  const sum = (s: Surface, ch: number): number => {
    let t = 0;
    for (let p = 0; p < s.w * s.h; p++) t += s.data[p * 4 + ch];
    return t;
  };

  it('conserves energy: a blurred delta still sums to 1', () => {
    for (const sd of ['0.7', '1.5', '3']) {
      const out = runFilter(bigSpec(`<feGaussianBlur stdDeviation="${sd}"/>`), delta(), 1);
      expect(Math.abs(sum(out, 3) - 1)).toBeLessThan(0.02);
    }
  });

  it('spreads: the centre falls and the neighbours rise', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="2"/>'), delta(), 1);
    expect(px(out, 10, 10)[3]).toBeLessThan(0.3);
    expect(px(out, 12, 10)[3]).toBeGreaterThan(0);
    expect(px(out, 10, 12)[3]).toBeGreaterThan(0);
  });

  it('is symmetric about the delta', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="2"/>'), delta(), 1);
    near(px(out, 8, 10)[3], px(out, 12, 10)[3], 5);
    near(px(out, 10, 8)[3], px(out, 10, 12)[3], 5);
  });

  it('takes two stdDeviations as x and y', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="3 0"/>'), delta(), 1);
    expect(px(out, 13, 10)[3]).toBeGreaterThan(0);
    near(px(out, 10, 13)[3], 0, 6);        // no vertical spread
  });

  it('is the identity at stdDeviation 0', () => {
    const out = runFilter(bigSpec('<feGaussianBlur stdDeviation="0"/>'), delta(), 1);
    near(px(out, 10, 10)[3], 1, 5);
  });

  it('scales the radius with the raster scale', () => {
    const wide = runFilter(bigSpec('<feGaussianBlur stdDeviation="1"/>'), delta(), 2);
    const narrow = runFilter(bigSpec('<feGaussianBlur stdDeviation="1"/>'), delta(), 1);
    expect(px(wide, 13, 10)[3]).toBeGreaterThan(px(narrow, 13, 10)[3]);
  });
});

describe('runFilter — feDropShadow', () => {
  it('keeps the source and adds an offset shadow beneath it', () => {
    const out = runFilter(specOf(
      '<feDropShadow dx="4" dy="4" stdDeviation="0" flood-color="#ff0000"/>'), source(), 1);
    // The source is white and on top at its own pixels.
    near(px(out, 0, 0)[3], 1, 4);
    near(px(out, 0, 0)[0], 1, 3);
    // The shadow is red, offset by (4,4).
    const s = px(out, 4, 4);
    near(s[3], 1, 3);
    near(s[0], 1, 3); near(s[1], 0, 3);
  });

  it('honours flood-opacity', () => {
    const out = runFilter(specOf(
      '<feDropShadow dx="4" dy="4" stdDeviation="0" flood-opacity="0.5"/>'), source(), 1);
    near(px(out, 4, 4)[3], 0.5, 3);
  });
});

describe('runFilter — feMorphology', () => {
  it('dilate by radius 1 grows the 2x2 block to 4x4, exactly', () => {
    const out = runFilter(specOf('<feMorphology operator="dilate" radius="1"/>'),
                          source(), 1);
    // The source block is (0,0)-(1,1). Radius 1 reaches one pixel out.
    for (let y = 0; y <= 2; y++) for (let x = 0; x <= 2; x++) near(px(out, x, y)[3], 1, 5);
    near(px(out, 3, 0)[3], 0, 5);
    near(px(out, 0, 3)[3], 0, 5);
  });

  it('erode by radius 1 removes the 2x2 block entirely', () => {
    // Every pixel of a 2x2 block has a transparent neighbour within radius 1.
    const out = runFilter(specOf('<feMorphology operator="erode" radius="1"/>'),
                          source(), 1);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) near(px(out, x, y)[3], 0, 5);
  });

  it('is the identity at radius 0', () => {
    const out = runFilter(specOf('<feMorphology operator="dilate" radius="0"/>'),
                          source(), 1);
    near(px(out, 0, 0)[3], 1, 5);
    near(px(out, 2, 0)[3], 0, 5);
  });

  it('takes two radii as x and y', () => {
    const out = runFilter(specOf('<feMorphology operator="dilate" radius="2 0"/>'),
                          source(), 1);
    near(px(out, 3, 0)[3], 1, 5);
    near(px(out, 0, 3)[3], 0, 5);
  });

  it('defaults to erode', () => {
    const out = runFilter(specOf('<feMorphology radius="1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 0, 5);
  });
});

describe('runFilter — feTile', () => {
  it('repeats the input subregion across the output subregion', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" x="0" y="0" width="2" height="2" result="t"/>' +
      '<feTile in="t" x="0" y="0" width="10" height="10"/>'), source(), 1);
    near(px(out, 0, 0)[0], 1, 3);
    near(px(out, 4, 4)[0], 1, 3);       // two tiles across and down
    near(px(out, 9, 9)[0], 1, 3);
  });

  it('produces nothing from an empty input subregion', () => {
    const out = runFilter(specOf(
      '<feFlood flood-color="#ff0000" x="0" y="0" width="0" height="0" result="t"/>' +
      '<feTile in="t"/>'), source(), 1);
    near(px(out, 5, 5)[3], 0, 5);
  });
});

/** The <filter> element of a fixture, for tests that assert a REFUSAL and so
 *  cannot go through specSized (which throws on anything but 'draw'). */
function nodeOfFilter(prims: string, size = 10): XmlNode {
  const root = parseXml(xmlBytes(
    '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
    `width="${size}" height="${size}">${prims}</filter></svg>`));
  let f: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.name === 'filter') f ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return f!;
}

describe('runFilter — feConvolveMatrix', () => {
  it('an identity kernel leaves the input alone', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" kernelMatrix="0 0 0  0 1 0  0 0 0"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 5);
    near(px(out, 1, 1)[3], 1, 5);
    near(px(out, 5, 5)[3], 0, 5);
  });

  it('a shift kernel translates by one pixel', () => {
    // kernelMatrix is applied ROTATED 180 degrees (SVG 1.1 15.7.5 indexes it
    // [orderX-j-1, orderY-i-1]), so the BOTTOM-RIGHT cell is the one that
    // samples (x-1, y-1) and therefore moves ink DOWN-RIGHT.
    // edgeMode="none" keeps the border out of it.
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" edgeMode="none" ' +
      'kernelMatrix="0 0 0  0 0 0  0 0 1"/>'), source(), 1);
    near(px(out, 2, 2)[3], 1, 5);
    near(px(out, 0, 0)[3], 0, 5);
  });

  it('the top-left cell moves ink the other way', () => {
    // The mirror of the above, so a kernel indexed forwards cannot pass both.
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" edgeMode="none" ' +
      'kernelMatrix="1 0 0  0 0 0  0 0 0"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 5);        // reads input(1,1)
    near(px(out, 2, 2)[3], 0, 5);
  });

  it('divides by the kernel sum by default', () => {
    // Read at (2,2), whose 3x3 window is fully interior and holds exactly one
    // opaque pixel — (1,1), the block's corner. At (0,0) the default
    // edgeMode="duplicate" clamps every out-of-range sample back into the
    // opaque block, which would make the whole window opaque and prove nothing.
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 2, 2)[3], 1 / 9, 4);
  });

  it('honours an explicit divisor', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" divisor="4" ' +
      'kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 4);          // 4/4, clamped at 1
  });

  it('adds bias', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" bias="0.25" ' +
      'kernelMatrix="0 0 0  0 0 0  0 0 0"/>'), source(), 1);
    near(px(out, 5, 5)[3], 0.25, 4);
  });

  it('preserveAlpha=true leaves alpha untouched', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" preserveAlpha="true" ' +
      'kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 5);          // original alpha survives
  });

  it('edgeMode=none treats outside as transparent black', () => {
    const out = runFilter(specOf(
      '<feConvolveMatrix order="3" edgeMode="none" divisor="1" ' +
      'kernelMatrix="1 1 1  1 1 1  1 1 1"/>'), source(), 1);
    near(px(out, 0, 0)[3], 1, 4);          // 4 opaque neighbours, clamped
  });

  it('rejects a kernelMatrix whose length does not match order', () => {
    const r = resolveFilter(
      nodeOfFilter('<feConvolveMatrix order="3" kernelMatrix="1 2 3"/>'),
      { x: 0, y: 0, w: 10, h: 10 }, VP);
    expect(r.kind).toBe('skip');
  });
});

describe('runFilter — feDisplacementMap', () => {
  /** A displacement map flooded with a known constant, displacing the source. */
  const disp = (color: string, attrs: string) =>
    `<feFlood flood-color="${color}" result="d" ` +
    'color-interpolation-filters="sRGB"/>' +
    `<feDisplacementMap in="SourceGraphic" in2="d" ${attrs} ` +
    'color-interpolation-filters="sRGB"/>';

  it('a mid-grey map displaces nothing', () => {
    // SVG 1.1 15.7.9: the shift is scale * (C - 0.5), so C = 0.5 is neutral.
    const out = runFilter(specOf(
      disp('#808080', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    near(px(out, 0, 0)[3], 1, 3);
    near(px(out, 4, 4)[3], 0, 3);
  });

  it('displaces by scale * (C - 0.5) along x', () => {
    // R = 1.0 -> +0.5 * scale = +4 px of SAMPLING offset, so the output at
    // (x,y) reads the source at (x+4,y): ink appears 4 px to the LEFT.
    const out = runFilter(specOf(
      disp('#ff8080', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    near(px(out, 0, 0)[3], 0, 3);
    near(px(out, 4, 0)[3], 0, 3);
  });

  it('selects the channel named by yChannelSelector', () => {
    const a = runFilter(specOf(
      disp('#8080ff', 'scale="8" xChannelSelector="R" yChannelSelector="B"')),
      source(), 1);
    const b = runFilter(specOf(
      disp('#8080ff', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    // B=1 drives y in the first and not the second, so the two must differ.
    let differs = false;
    for (let y = 0; y < 10 && !differs; y++) for (let x = 0; x < 10; x++)
      if (Math.abs(px(a, x, y)[3] - px(b, x, y)[3]) > 1e-6) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('is the identity at scale 0', () => {
    const out = runFilter(specOf(
      disp('#ff0000', 'scale="0" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    near(px(out, 0, 0)[3], 1, 3);
    near(px(out, 1, 1)[3], 1, 3);
  });

  it('reads the MAP unpremultiplied', () => {
    // A half-transparent white map. Unpremultiplied its R is 1.0 (x shift +4);
    // premultiplied it would be 0.5 (x shift 0, i.e. the identity). A is 0.5
    // either way, so y never moves and the two readings are distinguishable by
    // whether the block stays where it is.
    const out = runFilter(specOf(
      '<feFlood flood-color="#ffffff" flood-opacity="0.5" result="d" ' +
      'color-interpolation-filters="sRGB"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="d" scale="8" ' +
      'xChannelSelector="R" yChannelSelector="A" ' +
      'color-interpolation-filters="sRGB"/>'), source(), 1);
    // output(x,y) = input(x+4, y), so the block at the origin is unreachable.
    near(px(out, 0, 0)[3], 0, 3);
    near(px(out, 1, 1)[3], 0, 3);
  });

  it('samples outside the source as transparent black', () => {
    const out = runFilter(specOf(
      disp('#008080', 'scale="8" xChannelSelector="R" yChannelSelector="G"')),
      source(), 1);
    // R = 0 -> -4 px: every output pixel reads 4 to its LEFT, so the block at
    // the origin reappears shifted right.
    near(px(out, 4, 0)[3], 1, 3);
    near(px(out, 0, 0)[3], 0, 3);
  });
});

describe('runFilter — feImage', () => {
  /** A 4x4 opaque red surface, as the walker would have pre-rasterized it. */
  function redPatch(): Surface {
    const s = makeSurface(0, 0, 10, 10);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++)
      s.data.set([1, 0, 0, 1], (y * 10 + x) * 4);
    return s;
  }

  it('places the surface the walker pre-rasterized for it', () => {
    const spec = specOf('<feImage href="#el"/>');
    const extras = new Map([[spec.prims[0].result, redPatch()]]);
    const out = runFilter(spec, source(), 1, extras);
    near(px(out, 1, 1)[0], 1, 4);
    near(px(out, 1, 1)[3], 1, 4);
    near(px(out, 8, 8)[3], 0, 4);
  });

  it('produces transparent black when the walker supplied nothing', () => {
    // Unreachable in practice: emitFiltered refuses the whole filter when a
    // reference cannot be rasterized. Asserted so a future caller cannot make
    // a missing extra look like a deliberate pass-through of the input.
    const out = runFilter(specOf('<feImage href="#el"/>'), source(), 1);
    near(px(out, 1, 1)[3], 0, 5);
  });

  it('is clipped to its own subregion', () => {
    const spec = specOf('<feImage href="#el" x="0" y="0" width="2" height="2"/>');
    const extras = new Map([[spec.prims[0].result, redPatch()]]);
    const out = runFilter(spec, source(), 1, extras);
    near(px(out, 1, 1)[3], 1, 4);
    near(px(out, 3, 3)[3], 0, 4);      // inside the patch, outside the subregion
  });
});

describe('resolveFilter — feImage href shapes', () => {
  const shape = (href: string) =>
    resolveFilter(nodeOfFilter(`<feImage href="${href}"/>`),
                  { x: 0, y: 0, w: 10, h: 10 }, VP).kind;

  it('accepts a same-document fragment reference', () => {
    expect(shape('#el')).toBe('draw');
  });

  it('accepts a data: URI', () => {
    expect(shape('data:image/png;base64,iVBORw0KGgo=')).toBe('draw');
  });

  it('refuses an external href: the library performs no I/O', () => {
    expect(shape('https://example.com/a.png')).toBe('skip');
    expect(shape('./a.png')).toBe('skip');
  });

  it('refuses an feImage with no href at all', () => {
    expect(resolveFilter(nodeOfFilter('<feImage/>'),
                         { x: 0, y: 0, w: 10, h: 10 }, VP).kind).toBe('skip');
  });
});

describe('runFilter — feTurbulence', () => {
  it('fills its subregion with noise and ignores its input', () => {
    const out = runFilter(specOf(
      '<feTurbulence baseFrequency="0.1" numOctaves="2" seed="3"/>'), source(), 1);
    const varied = new Set<number>();
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++)
      varied.add(Math.round(px(out, x, y)[3] * 255));
    expect(varied.size).toBeGreaterThan(3);
  });

  it('is clipped to its subregion', () => {
    const out = runFilter(specOf(
      '<feTurbulence baseFrequency="0.1" seed="3" x="0" y="0" width="4" height="4"/>'),
      source(), 1);
    near(px(out, 8, 8)[3], 0, 5);
  });

  it('takes two baseFrequency numbers as x and y', () => {
    const a = runFilter(specOf('<feTurbulence baseFrequency="0.3 0" seed="1"/>'), source(), 1);
    const b = runFilter(specOf('<feTurbulence baseFrequency="0.3" seed="1"/>'), source(), 1);
    let differs = false;
    for (let y = 0; y < 10 && !differs; y++) for (let x = 0; x < 10; x++)
      if (Math.abs(px(a, x, y)[3] - px(b, x, y)[3]) > 1e-6) { differs = true; break; }
    expect(differs).toBe(true);
  });

  it('a negative baseFrequency is ignored rather than inverting the field', () => {
    const out = runFilter(specOf('<feTurbulence baseFrequency="-1" seed="1"/>'), source(), 1);
    for (let i = 0; i < 4; i++) expect(out.data[i]).toBeGreaterThanOrEqual(0);
  });
});
