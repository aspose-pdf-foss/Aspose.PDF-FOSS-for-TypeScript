import { describe, it, expect } from 'vitest';
import { collectPageInk, edgeAt, fillUnder, type PageInk } from '../src/tableink.js';
import type { PagePath } from '../src/paths.js';
import type { Rgb } from '../src/colorspace.js';
import type { Matrix } from '../src/text.js';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const BLACK: Rgb = [0, 0, 0];
const GREY: Rgb = [238, 238, 238];
const ADDR = { path: [], streamIndex: 0, opIndex: 0 };

/** A stroked path of axis-aligned lines, in user space, under `ctm`. */
function stroked(
  lines: [number, number, number, number][], width: number, rgb: Rgb, ctm: Matrix = IDENTITY,
): PagePath {
  return {
    subpaths: lines.map(([x0, y0, x1, y1]) => ({
      closed: false,
      segments: [
        { op: 'move' as const, pt: [x0, y0] as [number, number] },
        { op: 'line' as const, pt: [x1, y1] as [number, number] },
      ],
    })),
    ctm,
    bbox: [0, 0, 0, 0],          // deliberately wrong: strokes must not read it
    fill: null,
    stroke: { rgb, space: 'DeviceRGB' },
    fillRule: null,
    lineWidth: width,
    clip: null,
    addr: ADDR,
  };
}

/** A filled rectangle, given directly in device space via its bbox. */
function filled(rect: [number, number, number, number], rgb: Rgb): PagePath {
  const [x0, y0, x1, y1] = rect;
  return {
    subpaths: [{
      closed: true,
      segments: [
        { op: 'move' as const, pt: [x0, y0] as [number, number] },
        { op: 'line' as const, pt: [x1, y0] as [number, number] },
        { op: 'line' as const, pt: [x1, y1] as [number, number] },
        { op: 'line' as const, pt: [x0, y1] as [number, number] },
      ],
    }],
    ctm: IDENTITY,
    bbox: rect,
    fill: { rgb, space: 'DeviceRGB' },
    stroke: null,
    fillRule: 'nonzero',
    lineWidth: 0,
    clip: null,
    addr: ADDR,
  };
}

const ink = (paths: PagePath[]) => collectPageInk(paths, 3, 3);

describe('collectPageInk strokes', () => {
  // A grid drawn as ONE stroked path has a single bbox covering the whole
  // table, so an implementation reading bbox produces one giant edge instead
  // of four. The fixtures above set bbox to [0,0,0,0] to make that fail loudly.
  it('takes a stroked edge per segment, not from the path bbox', () => {
    const i = ink([stroked([[10, 100, 200, 100], [10, 50, 200, 50]], 1, BLACK)]);
    expect(i.horiz.map((e) => e.pos)).toEqual([100, 50]);
    expect(i.horiz.every((e) => e.lo === 10 && e.hi === 200)).toBe(true);
    expect(i.vert).toEqual([]);
  });

  it('carries the stroke width and colour', () => {
    const [e] = ink([stroked([[10, 100, 200, 100]], 1.5, [51, 51, 51])]).horiz;
    expect(e.width).toBe(1.5);
    expect(e.color).toEqual([51, 51, 51]);
  });

  it('splits horizontal from vertical', () => {
    const i = ink([stroked([[10, 100, 200, 100], [10, 20, 10, 100]], 1, BLACK)]);
    expect(i.horiz.length).toBe(1);
    expect(i.vert.length).toBe(1);
    expect(i.vert[0]).toMatchObject({ pos: 10, lo: 20, hi: 100 });
  });

  it('transforms subpaths through the ctm', () => {
    // Scale x2, translate +5 in y: user (10,50)-(60,50) becomes (20,105)-(120,105).
    const i = ink([stroked([[10, 50, 60, 50]], 1, BLACK, [2, 0, 0, 2, 0, 5])]);
    expect(i.horiz[0]).toMatchObject({ pos: 105, lo: 20, hi: 120 });
  });

  it('ignores a segment shorter than minLen', () => {
    expect(ink([stroked([[10, 100, 12, 100]], 1, BLACK)]).horiz).toEqual([]);
  });

  it('ignores a diagonal', () => {
    const i = ink([stroked([[10, 10, 200, 200]], 1, BLACK)]);
    expect(i.horiz).toEqual([]);
    expect(i.vert).toEqual([]);
  });
});

describe('collectPageInk fills', () => {
  // The same split rulesFromPath makes: thin means a rule, fat means shading.
  it('collapses a thin fill to a centreline edge with its min side as width', () => {
    const [e] = ink([filled([10, 99, 200, 100], BLACK)]).horiz;
    expect(e.pos).toBeCloseTo(99.5, 6);
    expect(e.width).toBeCloseTo(1, 6);
    expect(e.color).toEqual(BLACK);
  });

  it('keeps a fat fill as a shading rect, not an edge', () => {
    const i = ink([filled([10, 80, 200, 100], GREY)]);
    expect(i.horiz).toEqual([]);
    expect(i.fills).toEqual([{ rect: [10, 80, 200, 100], color: GREY }]);
  });

  it('ignores a path that is neither filled nor stroked', () => {
    const p = filled([10, 80, 200, 100], GREY);
    expect(ink([{ ...p, fill: null }]).fills).toEqual([]);
  });

  it('keeps fills in content order, so a later one can win a tie', () => {
    const i = ink([filled([0, 0, 500, 700], GREY), filled([10, 80, 200, 100], BLACK)]);
    expect(i.fills.map((f) => f.color)).toEqual([GREY, BLACK]);
  });
});

const INK: PageInk = {
  horiz: [
    { pos: 100, lo: 10, hi: 200, width: 1, color: BLACK },
    { pos: 50, lo: 10, hi: 60, width: 1, color: BLACK },     // short: first column only
  ],
  vert: [{ pos: 10, lo: 20, hi: 100, width: 2, color: BLACK }],
  fills: [],
};

describe('edgeAt', () => {
  it('finds an edge that spans the whole side', () => {
    expect(edgeAt(INK, 'h', 100, 10, 200, 2)?.width).toBe(1);
  });

  // A short rule under one column does not border the cell beside it. Overlap
  // is not enough -- the edge must SPAN the side.
  it('refuses an edge that only overlaps the side', () => {
    expect(edgeAt(INK, 'h', 50, 10, 200, 2)).toBeUndefined();
    expect(edgeAt(INK, 'h', 50, 10, 60, 2)).toBeDefined();
  });

  it('matches a position within tolerance and not beyond it', () => {
    expect(edgeAt(INK, 'h', 101, 10, 200, 2)).toBeDefined();
    expect(edgeAt(INK, 'h', 104, 10, 200, 2)).toBeUndefined();
  });

  it('looks on the axis it is asked for', () => {
    expect(edgeAt(INK, 'v', 10, 20, 100, 2)?.width).toBe(2);
    expect(edgeAt(INK, 'v', 100, 10, 200, 2)).toBeUndefined();
  });
});

describe('fillUnder', () => {
  const cell: [number, number, number, number] = [10, 80, 200, 100];

  // A page background, a full-table wash and a shaded header cell are all
  // filled rectangles. Containment would let the page background claim every
  // cell and paint the whole table grey.
  it('refuses a fill that merely contains the cell', () => {
    const i: PageInk = { horiz: [], vert: [], fills: [{ rect: [0, 0, 500, 700], color: GREY }] };
    expect(fillUnder(i, cell, 2)).toBeUndefined();
  });

  it('accepts a fill matching the cell on all four edges', () => {
    const i: PageInk = { horiz: [], vert: [], fills: [{ rect: [10, 80, 200, 100], color: GREY }] };
    expect(fillUnder(i, cell, 2)?.color).toEqual(GREY);
  });

  it('accepts a near match within tolerance', () => {
    const i: PageInk = { horiz: [], vert: [], fills: [{ rect: [11, 79, 199, 101], color: GREY }] };
    expect(fillUnder(i, cell, 2)?.color).toEqual(GREY);
  });

  // The last one in content order is the one painted on top.
  it('prefers the last qualifying fill', () => {
    const i: PageInk = { horiz: [], vert: [], fills: [
      { rect: [10, 80, 200, 100], color: GREY },
      { rect: [10, 80, 200, 100], color: BLACK },
    ] };
    expect(fillUnder(i, cell, 2)?.color).toEqual(BLACK);
  });

  it('returns undefined when there is no fill at all', () => {
    expect(fillUnder({ horiz: [], vert: [], fills: [] }, cell, 2)).toBeUndefined();
  });
});
