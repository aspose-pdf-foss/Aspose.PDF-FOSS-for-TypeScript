import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildMeshPdf } from './helpers/build-mesh-pdf.js';

/**
 * Gouraud mesh shadings, types 4 and 5 (4gtd.4).
 *
 * Both degraded to a flat mid-grey fill of the clip region, which is worse than
 * most rendering faults because it is OPAQUE and covers whatever is behind it —
 * a chart or a map export came out as a grey rectangle.
 *
 * `colormesh.ts` already knew the record layout for ConvertColors, but NOT the
 * coordinates: it copies those as raw bit patterns and never applies /Decode's
 * coordinate half, which is a deliberate invariant (bit-copying is what keeps a
 * re-spliced mesh's geometry bit-identical). So the reader is new, and both it
 * and the re-splicer now run off one shared record walk.
 */

const MID_GRAY: [number, number, number, number] = [128, 128, 128, 255];
const WHITE: [number, number, number, number] = [255, 255, 255, 255];

/** Device pixel: PDF (x, y) on the 200x200 page is device (x, 200 - y). */
const at = (pdf: Uint8Array) => {
  const png = decodePng(Document.Open(pdf).Pages[0].ToImage());
  return (x: number, y: number) => png.at(Math.round(x), Math.round(200 - y));
};

/** A big triangle with one pure-colour vertex each. */
const RGB_TRIANGLE = buildMeshPdf({
  type: 4,
  vertices: [
    { flag: 0, x: 10, y: 10, comps: [1, 0, 0] },
    { flag: 0, x: 190, y: 10, comps: [0, 1, 0] },
    { flag: 0, x: 100, y: 190, comps: [0, 0, 1] },
  ],
});

describe('ShadingType 4 — free-form Gouraud triangles', () => {
  it('interpolates the three vertex colours across the triangle', () => {
    // **Each vertex asserts its own channel HIGH and the other two LOW.** The
    // first version of this checked only "> 200" per channel, which pure WHITE
    // satisfies — and it duly passed against a build that painted nothing at
    // all. An unpainted page is the failure mode here, so every assertion in
    // this file has to be one white cannot satisfy.
    const p = at(RGB_TRIANGLE);
    const red = p(20, 16);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[1]).toBeLessThan(80); expect(red[2]).toBeLessThan(80);

    const green = p(180, 16);
    expect(green[1]).toBeGreaterThan(200);
    expect(green[0]).toBeLessThan(80); expect(green[2]).toBeLessThan(80);

    const blue = p(100, 180);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]).toBeLessThan(80); expect(blue[1]).toBeLessThan(80);
  });

  it('paints the centroid the MEAN of the three, not a flat fill', () => {
    // The assertion a flat-fill build fails: mid-grey is (128,128,128), while a
    // true barycentric mean of pure R, G and B is about (85,85,85).
    const [r, g, bl] = at(RGB_TRIANGLE)(100, 70);
    expect(r).toBeGreaterThan(60); expect(r).toBeLessThan(110);
    expect(g).toBeGreaterThan(60); expect(g).toBeLessThan(110);
    expect(bl).toBeGreaterThan(60); expect(bl).toBeLessThan(110);
  });

  it('leaves the area outside the triangle unpainted', () => {
    // A mesh paints its triangles, not the clip region — which is exactly what
    // the mid-grey degrade got wrong.
    //
    // **The probe must sit INSIDE the triangle's bounding box**, or it measures
    // nothing: the walk is over that box, so a build with no containment test
    // still leaves everything beyond it white. PDF (20, 180) is device (20, 20)
    // — within the box's 10..190 square, and well outside the triangle, whose
    // apex is at device (100, 10).
    expect(at(RGB_TRIANGLE)(20, 180)).toEqual([255, 255, 255, 255]);
  });
});

describe('ShadingType 5 — lattice-form Gouraud triangles', () => {
  it('shows no seam between rows', () => {
    // Two rows of three. **The colours must vary along BOTH axes, and the probe
    // must sit MID-CELL — measured, and the first version had neither.** With a
    // purely vertical ramp the colour field depends only on y, so every
    // triangulation of the quad produces the same picture and a wrong diagonal
    // is invisible; and at a vertex column every triangulation agrees anyway.
    const pdf = buildMeshPdf({
      type: 5,
      verticesPerRow: 3,
      vertices: [
        { x: 10, y: 190, comps: [1, 0, 0] },
        { x: 100, y: 190, comps: [0, 1, 0] },
        { x: 190, y: 190, comps: [0, 0, 1] },
        { x: 10, y: 10, comps: [0, 0, 1] },
        { x: 100, y: 10, comps: [1, 0, 0] },
        { x: 190, y: 10, comps: [0, 1, 0] },
      ],
    });
    const p = at(pdf);
    // **The "it is painted at all" assertion has to come first, or the seam one
    // is vacuous:** under a flat fill — or a blank page — both sides of the
    // boundary agree perfectly and a continuity test alone passes.
    const topLeft = p(20, 180);
    expect(topLeft[0]).toBeGreaterThan(180);          // red corner
    expect(topLeft[2]).toBeLessThan(90);              // ...and NOT white

    // Mid-cell, either side of the row boundary at y=100.
    const above = p(55, 103);
    const below = p(55, 97);
    for (let i = 0; i < 3; i++) expect(Math.abs(above[i] - below[i])).toBeLessThan(30);
    expect(above[3]).toBe(255);
  });
});

describe('a mesh with a /Function', () => {
  it('interpolates the parametric value and evaluates after, not before', () => {
    // The fixture needs a NON-LINEAR function or both orderings agree and it
    // measures nothing. A type 2 exponential with N=4 maps t=0.5 to 0.0625,
    // where evaluating at the vertices first and interpolating the results
    // would give 0.5. Those are far apart, which is the point.
    const pdf = buildMeshPdf({
      type: 4,
      colorSpace: '/DeviceGray',
      fn: '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 4 >>',
      vertices: [
        { flag: 0, x: 10, y: 10, comps: [0] },
        { flag: 0, x: 190, y: 10, comps: [1] },
        { flag: 0, x: 100, y: 190, comps: [0] },
      ],
    });
    // Midway along the t=0 -> t=1 edge, t is 0.5, so the colour is 0.5^4.
    //
    // **A BAND, not an upper bound.** `< 60` also admits 0, so it passed under a
    // mutation that collapsed the LUT lookup to its endpoints — measured. The
    // band excludes both that and the wrong ordering's 0.5 -> 127.
    const [v] = at(pdf)(100, 14);
    expect(v).toBeGreaterThan(5);
    expect(v).toBeLessThan(35);                       // 0.0625*255 ~ 16, measured 15
  });
});

/**
 * Patch meshes, types 6 and 7 (4gtd.5).
 *
 * The boundary of a patch is stated as twelve control points walking the 4x4
 * tensor net's border once: stream point 1 is p00, 4 is p03, 7 is p33 and 10 is
 * p30, with the corner colours c1..c4 at those four. Every fixture below lays
 * its net out as `p[i][j]` at PDF `(x0 + s*j, y0 + s*i)`, so v follows x and u
 * follows y.
 */

/** The twelve boundary points of a square patch with straight, evenly spaced
 *  edges, in stream order. */
function squareBoundary(x0: number, y0: number, s: number): [number, number][] {
  const g = (i: number, j: number): [number, number] => [x0 + s * j, y0 + s * i];
  return [
    g(0, 0), g(0, 1), g(0, 2), g(0, 3),   // 1..4   p00 p01 p02 p03
    g(1, 3), g(2, 3), g(3, 3),            // 5..7   p13 p23 p33
    g(3, 2), g(3, 1), g(3, 0),            // 8..10  p32 p31 p30
    g(2, 0), g(1, 0),                     // 11,12  p20 p10
  ];
}

const R = [1, 0, 0], G = [0, 1, 0], B = [0, 0, 1], Y = [1, 1, 0];

describe('ShadingType 6 — Coons patch meshes', () => {
  it('interpolates the four corner colours across the patch', () => {
    // Each corner asserts its own channel HIGH and the others LOW, so neither
    // the mid-grey degrade nor an unpainted white page can satisfy one — the
    // rule 4gtd.4 had to learn the hard way, three of its cases having passed
    // against a build that painted nothing.
    const p = at(buildMeshPdf({
      type: 6,
      patches: [{ points: squareBoundary(40, 40, 40), colors: [R, G, B, Y] }],
    }));
    const c1 = p(50, 50);                          // near p00 → red
    expect(c1[0]).toBeGreaterThan(200);
    expect(c1[1]).toBeLessThan(80); expect(c1[2]).toBeLessThan(80);
    const c2 = p(150, 50);                         // near p03 → green
    expect(c2[1]).toBeGreaterThan(200);
    expect(c2[0]).toBeLessThan(80); expect(c2[2]).toBeLessThan(80);
    const c3 = p(150, 150);                        // near p33 → blue
    expect(c3[2]).toBeGreaterThan(200);
    expect(c3[0]).toBeLessThan(80); expect(c3[1]).toBeLessThan(80);
    const c4 = p(50, 150);                         // near p30 → yellow
    expect(c4[0]).toBeGreaterThan(200); expect(c4[1]).toBeGreaterThan(200);
    expect(c4[2]).toBeLessThan(80);                // ...and white fails HERE
  });

  it('paints nothing outside the patch', () => {
    const p = at(buildMeshPdf({
      type: 6,
      patches: [{ points: squareBoundary(40, 40, 40), colors: [R, G, B, Y] }],
    }));
    expect(p(100, 20)).toEqual(WHITE);
    expect(p(20, 100)).toEqual(WHITE);
  });

  // THE fixture that separates a Coons patch from the bilinear quad its four
  // corners span: bow one edge so the surface reaches outside that quad. A flat
  // patch cannot see the difference at all — both readings paint the square.
  it('bulges outside its corners when an edge is bowed', () => {
    const pts = squareBoundary(40, 40, 40);
    pts[1] = [80, 10]; pts[2] = [120, 10];         // bow the p00→p03 edge out
    const p = at(buildMeshPdf({ type: 6, patches: [{ points: pts, colors: [R, R, B, B] }] }));
    // The bowed edge reaches y = 17.5 at its midpoint, well outside the square
    // the corners span (y >= 40) — and the flat fixture above is white there.
    expect(p(100, 22)).not.toEqual(WHITE);
    expect(p(100, 5)).toEqual(WHITE);              // ...but not flooding either
  });

  it('continues a neighbour exactly across a shared edge', () => {
    // Patch A spans x 20..100 and carries RED at its p00/p30 corners and BLUE
    // at p03/p33 — so its whole right edge is blue. Patch B continues at that
    // edge with flag 1, which inherits c2 and c3, so B's left edge is blue too:
    // the seam is one colour on both sides however the two are tessellated.
    const a = squareBoundary(20, 40, 80 / 3);
    // B's own eight points: p13 p23 p33 p32 p31 p30 p20 p10, running right.
    const b: [number, number][] = [
      [130, 160], [160, 160], [190, 160],
      [190, 120], [190, 80], [190, 40],
      [160, 40], [130, 40],
    ];
    const p = at(buildMeshPdf({
      type: 6,
      patches: [
        { points: a, colors: [R, B, B, R] },
        { flag: 1, points: b, colors: [G, G] },
      ],
    }));
    const left = p(96, 100), right = p(104, 100);
    expect(left[2]).toBeGreaterThan(200);          // blue on A's side
    expect(right[2]).toBeGreaterThan(200);         // blue on B's side
    for (let k = 0; k < 3; k++) expect(Math.abs(left[k] - right[k])).toBeLessThan(24);
    expect(p(30, 100)[0]).toBeGreaterThan(150);    // A ramps back to red
    const far = p(180, 100);                       // B ramps on to green
    expect(far[1]).toBeGreaterThan(150);
    expect(far[2]).toBeLessThan(110);
  });

  it('degrades to mid-grey when the patch data ends mid-record', () => {
    const pdf = buildMeshPdf({
      type: 6,
      patches: [{ points: squareBoundary(40, 40, 40).slice(0, 6), colors: [R, G, B, Y] }],
    });
    expect(at(pdf)(100, 100)).toEqual(MID_GRAY);
  });

  it('degrades when the first patch is a continuation with nothing to continue', () => {
    // Dropped rather than guessed at: it names four points and two colours that
    // do not exist, and inventing them paints a patch nobody described.
    const pdf = buildMeshPdf({
      type: 6,
      patches: [{ flag: 2, points: squareBoundary(40, 40, 40).slice(4), colors: [R, G] }],
    });
    expect(at(pdf)(100, 100)).toEqual(MID_GRAY);
  });
});

describe('ShadingType 7 — tensor patch meshes', () => {
  // A tensor patch states four INTERIOR control points a Coons patch derives.
  // A fixture whose interiors sit where the Coons formula would have put them
  // is byte-identical to the type 6 and measures nothing, so these are pulled
  // far off — and the same boundary as a type 6 is asserted NOT to reach there.
  const boundary = squareBoundary(40, 40, 80 / 3);   // x,y over 40..120
  const interior: [number, number][] = [[80, 195], [80, 195], [80, 195], [80, 195]];

  it('reads its own interior points rather than deriving them', () => {
    const tensor = at(buildMeshPdf({
      type: 7,
      patches: [{ points: [...boundary, ...interior], colors: [R, R, B, B] }],
    }));
    const coons = at(buildMeshPdf({
      type: 6,
      patches: [{ points: boundary, colors: [R, R, B, B] }],
    }));
    // The displaced interiors bulge the surface past y = 120, where the Coons
    // patch over the same boundary stops.
    expect(tensor(80, 135)).not.toEqual(WHITE);
    expect(coons(80, 135)).toEqual(WHITE);
    // Both still paint the middle, so this is a difference rather than a
    // tensor patch failing to draw at all.
    expect(tensor(80, 80)).not.toEqual(WHITE);
    expect(coons(80, 80)).not.toEqual(WHITE);
  });

  it('carries four fewer points on a continuation, its interiors still its own', () => {
    const b: [number, number][] = [
      [130, 160], [160, 160], [190, 160],
      [190, 120], [190, 80], [190, 40],
      [160, 40], [130, 40],
    ];
    const p = at(buildMeshPdf({
      type: 7,
      patches: [
        { points: [...squareBoundary(20, 40, 80 / 3), ...interior], colors: [R, B, B, R] },
        { flag: 1, points: [...b, [140, 100], [160, 100], [160, 100], [140, 100]], colors: [G, G] },
      ],
    }));
    expect(p(160, 100)[1]).toBeGreaterThan(120);   // the continuation drew
    expect(p(96, 100)[2]).toBeGreaterThan(180);    // the shared edge is still blue
  });
});
