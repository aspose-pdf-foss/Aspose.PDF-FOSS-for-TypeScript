import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { flattenGlyphContours, glyphPolys, faceOutline } from '../src/glyphoutline.js';
import { flattenPath, FLATTEN_TOL } from '../src/strokegeom.js';
import { IDENTITY } from '../src/text.js';
import { getStd14Sfnt } from '../src/std14fonts.js';
import { parseSfnt, type GlyphPoint } from '../src/sfnt.js';

/** Bounding box of a set of flat [x,y,...] polylines. */
function bounds(polys: number[][]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (let i = 0; i + 1 < p.length; i += 2) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  return { x0, y0, x1, y1 };
}

describe('flattenGlyphContours', () => {
  it('walks an all-on-curve contour as a polygon', () => {
    const square: GlyphPoint[][] = [[
      { x: 0, y: 0, on: true }, { x: 10, y: 0, on: true },
      { x: 10, y: 10, on: true }, { x: 0, y: 10, on: true },
    ]];
    const polys = flattenGlyphContours(square, [...IDENTITY]);
    expect(polys).toHaveLength(1);
    expect(bounds(polys)).toEqual({ x0: 0, y0: 0, x1: 10, y1: 10 });
  });

  it('subdivides an off-curve point into a bulging arc', () => {
    // One off-curve control pulling the top edge up to y=10: the flattened
    // polyline must reach ABOVE the on-curve points (which cap at y=0) without
    // reaching the control point itself — that is what a quadratic does.
    const arc: GlyphPoint[][] = [[
      { x: 0, y: 0, on: true }, { x: 10, y: 10, on: false }, { x: 20, y: 0, on: true },
    ]];
    const b = bounds(flattenGlyphContours(arc, [...IDENTITY]));
    expect(b.y1).toBeGreaterThan(0);
    expect(b.y1).toBeLessThan(10);
  });

  it('maps every point through the matrix', () => {
    const square: GlyphPoint[][] = [[
      { x: 0, y: 0, on: true }, { x: 10, y: 0, on: true }, { x: 10, y: 10, on: true },
    ]];
    // Half scale, y flipped, shifted right by 100 — the em→user shape the SVG
    // stack passes in.
    const b = bounds(flattenGlyphContours(square, [0.5, 0, 0, -0.5, 100, 0]));
    expect(b).toEqual({ x0: 100, y0: -5, x1: 105, y1: 0 });
  });
});

describe('flattenPath', () => {
  it('flattens a cubic to a polyline under the ctm', () => {
    const polys = flattenPath(
      [{ op: 'M', x: 0, y: 0 }, { op: 'C', x1: 0, y1: 10, x2: 10, y2: 10, x: 10, y: 0 }],
      [...IDENTITY]);
    expect(polys).toHaveLength(1);
    expect(polys[0].length).toBeGreaterThan(4);       // subdivided, not a chord
    const b = bounds(polys);
    expect(b.y1).toBeGreaterThan(0);
    expect(b.y1).toBeLessThan(10);
  });

  it('closes a subpath back to its start on Z', () => {
    const polys = flattenPath(
      [{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 10, y: 0 }, { op: 'Z' }], [...IDENTITY]);
    expect(polys[0]).toEqual([0, 0, 10, 0, 0, 0]);
  });
});

describe('glyphPolys', () => {
  it('scales a glyf outline out of font units into em units', () => {
    const sfnt = getStd14Sfnt('Helvetica')!;
    const gid = sfnt.cmapLookup('H'.codePointAt(0)!)!;
    // Identity matrix => the result is in EM units, so a capital H must be
    // about 0.7 em tall and sit on the baseline. Checked against typography,
    // not against our own parser — a cap height near 1.0 or 700 would mean the
    // unitsPerEm scaling was skipped.
    const b = bounds(glyphPolys({ sfnt }, gid, [...IDENTITY]));
    expect(b.y0).toBeCloseTo(0, 2);
    expect(b.y1).toBeGreaterThan(0.6);
    expect(b.y1).toBeLessThan(0.8);
    expect(b.x1 - b.x0).toBeGreaterThan(0.4);
  });

  it('returns an empty set for a blank glyph', () => {
    const sfnt = getStd14Sfnt('Helvetica')!;
    const gid = sfnt.cmapLookup(' '.codePointAt(0)!)!;
    expect(glyphPolys({ sfnt }, gid, [...IDENTITY])).toEqual([]);
  });
});

describe('faceOutline', () => {
  it('resolves a character through the cmap on a glyf face', () => {
    const out = faceOutline(getStd14Sfnt('Helvetica')!);
    const b = bounds(out('H', [...IDENTITY], FLATTEN_TOL)!);
    expect(b.y1).toBeGreaterThan(0.6);
    expect(b.y1).toBeLessThan(0.8);
  });

  it('returns null for a character the face has no glyph for', () => {
    const out = faceOutline(getStd14Sfnt('Helvetica')!);
    expect(out('中', [...IDENTITY], FLATTEN_TOL)).toBeNull();
  });

  it('unwraps the CFF table of an OpenType-CFF face', () => {
    // A real third-party OTTO font: our own builders never produce one, so this
    // is the only way to prove the CFF branch is wired. See
    // test/fixtures/fonts/PROVENANCE.md.
    const otf = parseSfnt(new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf')));
    expect(otf.outlines).toBe('cff');
    const b = bounds(faceOutline(otf)('H', [...IDENTITY], FLATTEN_TOL)!);
    expect(b.y1).toBeGreaterThan(0.6);
    expect(b.y1).toBeLessThan(0.8);
  });
});
