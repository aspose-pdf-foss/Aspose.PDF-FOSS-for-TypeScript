import { describe, it, expect } from 'vitest';
import { viewBoxFitDown } from '../src/svgtransform.js';
import {
  markerVertices, resolveMarker, markerMatrix, type MarkerVertex,
} from '../src/svgmarker.js';
import { parsePath, shapeSegs } from '../src/svgpath.js';
import { parseXml } from '../src/xml.js';
import { drawSvg } from '../src/svgdraw.js';
import type { PdfDict, PdfObject } from '../src/types.js';

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
/** Apply a matrix to a point, in mul()'s convention. */
const at = (m: readonly number[], x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe('viewBoxFitDown', () => {
  it('is identity for a viewBox matching the target exactly', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 10, 10, undefined);
    const [x, y] = at(m, 3, 4);
    near(x, 3); near(y, 4);
  });

  it('does NOT flip y — that is placementMatrix alone', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 10, 10, undefined);
    const [, y0] = at(m, 0, 0);
    const [, y1] = at(m, 0, 10);
    near(y0, 0); near(y1, 10);       // top stays top
  });

  it('scales a viewBox up to the target', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 30, 30, undefined);
    const [x, y] = at(m, 5, 5);
    near(x, 15); near(y, 15);
  });

  it('offsets by the viewBox origin', () => {
    const m = viewBoxFitDown({ minX: 4, minY: 6, w: 10, h: 10 }, 10, 10, undefined);
    const [x, y] = at(m, 4, 6);
    near(x, 0); near(y, 0);          // the viewBox corner lands at the origin
  });

  it('centres under the default xMidYMid meet', () => {
    // A 10x10 viewBox into a 30x10 target: uniform scale 1, centred on x.
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 30, 10, undefined);
    const [x, y] = at(m, 0, 0);
    near(x, 10); near(y, 0);
  });

  it('stretches each axis under preserveAspectRatio="none"', () => {
    const m = viewBoxFitDown({ minX: 0, minY: 0, w: 10, h: 10 }, 30, 10, 'none');
    const [x, y] = at(m, 10, 10);
    near(x, 30); near(y, 10);
  });
});

// --- Task 2: markerVertices -------------------------------------------------

const deg = (rad: number) => (rad * 180) / Math.PI;
const verts = (d: string) => markerVertices(parsePath(d).segs);

describe('markerVertices — kinds', () => {
  it('marks the first vertex start and the last end', () => {
    const v = verts('M 0 0 L 10 0 L 20 0');
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'end']);
  });

  it('gives the WHOLE path one start, not one per subpath', () => {
    // SVG 1.1 11.6.2: the first vertex of the path element. The second
    // subpath's opening vertex is a mid.
    const v = verts('M 0 0 L 10 0 M 50 0 L 60 0');
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'mid', 'end']);
  });

  it('yields one vertex for a lone moveto', () => {
    const v = verts('M 5 6');
    expect(v.length).toBe(1);
    expect(v[0].kind).toBe('start');
    expect(v[0].angle).toBe(0);
  });

  it('appends the closing vertex for Z', () => {
    // A closed triangle: start, mid, mid, and the closing vertex.
    const v = verts('M 0 0 L 10 0 L 10 10 Z');
    expect(v.length).toBe(4);
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'mid', 'end']);
    expect(v[3].x).toBe(0);
    expect(v[3].y).toBe(0);
  });
});

describe('markerVertices — angles', () => {
  it('takes the outgoing tangent at the start', () => {
    expect(deg(verts('M 0 0 L 10 0')[0].angle)).toBeCloseTo(0);
    expect(deg(verts('M 0 0 L 0 10')[0].angle)).toBeCloseTo(90);   // y-down
  });

  it('takes the incoming tangent at the end', () => {
    const v = verts('M 0 0 L 10 0 L 10 10');
    expect(deg(v[2].angle)).toBeCloseTo(90);
  });

  it('bisects at a mid vertex', () => {
    // In at 0 deg, out at 90 deg: the bisector is 45.
    const v = verts('M 0 0 L 10 0 L 10 10');
    expect(deg(v[1].angle)).toBeCloseTo(45);
  });

  it('bisects across the +-180 seam without averaging angles', () => {
    // In at 180 deg (leftward), out at -170. Averaging the two angles gives 5,
    // which points the WRONG WAY; the unit-vector sum gives 175.
    const v = markerVertices(parsePath(
      'M 100 0 L 0 0 L -98.48 -17.36').segs);
    expect(Math.abs(deg(v[1].angle))).toBeCloseTo(175, 0);
  });

  it('falls back to the incoming tangent on a perfect reversal', () => {
    // Out is exactly -in, so the unit vectors cancel and there is no bisector.
    const v = verts('M 0 0 L 10 0 L 0 0');
    expect(deg(v[1].angle)).toBeCloseTo(0);
  });

  it('takes a cubic tangent from its first control leg', () => {
    const v = verts('M 0 0 C 10 10 20 0 30 0');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('falls through a degenerate first control leg', () => {
    // p1 == p0, so the tangent must come from p0->p2.
    const v = verts('M 0 0 C 0 0 10 10 20 0');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('falls through to the chord when both control legs are degenerate', () => {
    const v = verts('M 0 0 C 0 0 0 0 10 10');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('skips a zero-length segment when seeking a tangent', () => {
    const v = verts('M 0 0 L 0 0 L 10 10');
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });

  it('wraps the tangent round at a Z join', () => {
    // Closing leg comes in at 180 (from 10,0 back to 0,0); the subpath opens at
    // 0. The bisector of 180 and 0 is a reversal, so it falls back to incoming.
    const v = verts('M 0 0 L 10 0 Z');
    expect(deg(v[v.length - 1].angle)).toBeCloseTo(180);
  });

  it('bisects a square closing corner using the initial outgoing tangent', () => {
    // Closing leg arrives at 270 (upward, y-down); the subpath opens at 0.
    // Bisector of (0,-1) + (1,0) = 315 deg.
    const v = verts('M 0 0 L 10 0 L 10 10 L 0 10 Z');
    const a = deg(v[v.length - 1].angle);
    expect(a < 0 ? a + 360 : a).toBeCloseTo(315);
  });
});

describe('markerVertices — through basic shapes', () => {
  it('reaches a polyline via shapeSegs', () => {
    const root = parseXml(new TextEncoder().encode(
      '<svg><polyline points="0,0 10,0 10,10"/></svg>'));
    const v = markerVertices(shapeSegs(root.children[0]).segs);
    expect(v.map((p) => p.kind)).toEqual(['start', 'mid', 'end']);
    expect(deg(v[1].angle)).toBeCloseTo(45);
  });

  it('reaches a line via shapeSegs', () => {
    const root = parseXml(new TextEncoder().encode(
      '<svg><line x1="0" y1="0" x2="10" y2="10"/></svg>'));
    const v = markerVertices(shapeSegs(root.children[0]).segs);
    expect(v.length).toBe(2);
    expect(deg(v[0].angle)).toBeCloseTo(45);
  });
});

// --- Task 3: resolveMarker / markerMatrix -----------------------------------

function marker(src: string, id = 'm') {
  const root = parseXml(new TextEncoder().encode(src));
  let found: import('../src/xml.js').XmlNode | undefined;
  const walk = (n: import('../src/xml.js').XmlNode): void => {
    if (n.attrs.get('id') === id) found ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return resolveMarker(found!);
}

const V = (over: Partial<MarkerVertex> = {}): MarkerVertex =>
  ({ x: 0, y: 0, angle: 0, kind: 'mid', ...over });

describe('resolveMarker', () => {
  it('defaults markerWidth and markerHeight to 3', () => {
    const s = marker('<svg><marker id="m"/></svg>')!;
    expect(s.w).toBe(3);
    expect(s.h).toBe(3);
  });

  it('returns null for a non-positive viewport', () => {
    expect(marker('<svg><marker id="m" markerWidth="0"/></svg>')).toBeNull();
    expect(marker('<svg><marker id="m" markerHeight="-1"/></svg>')).toBeNull();
  });

  it('defaults markerUnits to strokeWidth', () => {
    expect(marker('<svg><marker id="m"/></svg>')!.scaleByStroke).toBe(true);
    expect(marker('<svg><marker id="m" markerUnits="userSpaceOnUse"/></svg>')!.scaleByStroke)
      .toBe(false);
  });

  it('clips to the viewport by default and not under overflow visible', () => {
    const hidden = marker('<svg><marker id="m" markerWidth="4" markerHeight="6"/></svg>')!;
    expect(hidden.clip).toEqual({ x: 0, y: 0, w: 4, h: 6 });
    expect(marker('<svg><marker id="m" overflow="visible"/></svg>')!.clip).toBeNull();
  });

  it('parses orient', () => {
    expect(marker('<svg><marker id="m"/></svg>')!.orient).toBe(0);
    expect(marker('<svg><marker id="m" orient="auto"/></svg>')!.orient).toBe('auto');
    expect(marker('<svg><marker id="m" orient="auto-start-reverse"/></svg>')!.orient)
      .toBe('auto-start-reverse');
    expect(marker('<svg><marker id="m" orient="90"/></svg>')!.orient)
      .toBeCloseTo(Math.PI / 2);
  });

  it('maps refX and refY THROUGH the viewBox fit', () => {
    // viewBox 0 0 10 10 into a 20x20 viewport: scale 2. refX=5 is a viewBox
    // coordinate, so it lands at 10 in viewport space, not at 5.
    const s = marker(
      '<svg><marker id="m" viewBox="0 0 10 10" markerWidth="20" markerHeight="20" ' +
      'refX="5" refY="5"/></svg>')!;
    near(s.refX, 10);
    near(s.refY, 10);
  });

  it('includes the viewBox translation when mapping refX', () => {
    // viewBox minX=10: the fit shifts content by -10*scale, and refX must ride
    // along or the marker is offset by the viewBox origin.
    const s = marker(
      '<svg><marker id="m" viewBox="10 0 10 10" markerWidth="10" markerHeight="10" ' +
      'refX="10" refY="0"/></svg>')!;
    near(s.refX, 0);
  });

  it('takes refX literally with no viewBox', () => {
    const s = marker('<svg><marker id="m" refX="2" refY="3"/></svg>')!;
    near(s.refX, 2);
    near(s.refY, 3);
  });
});

describe('markerMatrix', () => {
  it('lands the reference point exactly on the vertex', () => {
    const s = marker('<svg><marker id="m" markerWidth="10" markerHeight="10" ' +
      'refX="5" refY="5" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ x: 100, y: 200 }), 1);
    const [x, y] = at(m, 5, 5);      // the reference point in content space
    near(x, 100); near(y, 200);
  });

  it('scales by stroke-width under the default markerUnits', () => {
    const s = marker('<svg><marker id="m" markerWidth="10" markerHeight="10"/></svg>')!;
    const m = markerMatrix(s, V(), 4);
    const [x, y] = at(m, 1, 0);
    near(x, 4); near(y, 0);
  });

  it('ignores stroke-width under markerUnits="userSpaceOnUse"', () => {
    const s = marker('<svg><marker id="m" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V(), 4);
    const [x] = at(m, 1, 0);
    near(x, 1);
  });

  it('rotates by a fixed orient angle', () => {
    const s = marker('<svg><marker id="m" orient="90" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V(), 1);
    const [x, y] = at(m, 1, 0);
    near(x, 0); near(y, 1);          // y-down: +90 turns +x into +y
  });

  it('rotates to the tangent under orient="auto"', () => {
    const s = marker('<svg><marker id="m" orient="auto" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ angle: Math.PI / 2 }), 1);
    const [x, y] = at(m, 1, 0);
    near(x, 0); near(y, 1);
  });

  it('reverses a START vertex under auto-start-reverse', () => {
    const s = marker(
      '<svg><marker id="m" orient="auto-start-reverse" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ kind: 'start', angle: 0 }), 1);
    const [x, y] = at(m, 1, 0);
    near(x, -1); near(Math.abs(y), 0);
  });

  it('does NOT reverse a mid or end vertex under auto-start-reverse', () => {
    const s = marker(
      '<svg><marker id="m" orient="auto-start-reverse" markerUnits="userSpaceOnUse"/></svg>')!;
    for (const kind of ['mid', 'end'] as const) {
      const [x] = at(markerMatrix(s, V({ kind, angle: 0 }), 1), 1, 0);
      near(x, 1);
    }
  });

  it('applies rotation about the reference point, not the content origin', () => {
    // refX=5 with a 90 deg rotation: the reference point must stay on the vertex
    // no matter the angle. Composing rotate BEFORE the ref translate would swing
    // the marker away from it.
    const s = marker('<svg><marker id="m" markerWidth="10" markerHeight="10" ' +
      'refX="5" refY="5" orient="90" markerUnits="userSpaceOnUse"/></svg>')!;
    const m = markerMatrix(s, V({ x: 70, y: 80 }), 1);
    const [x, y] = at(m, 5, 5);
    near(x, 70); near(y, 80);
  });
});

// --- Task 5: walker wiring --------------------------------------------------
// The sink/provider/draw helpers mirror test/svg-mask.test.ts, which exports
// nothing; they stand in for svgembed.ts, the only module that may allocate.

function recordingSink() {
  const streams: { dict: PdfDict; content: string }[] = [];
  return {
    streams,
    sink: {
      stream: (dict: PdfDict, content: string): PdfObject => {
        streams.push({ dict, content });
        return { kind: 'ref' as const, num: streams.length, gen: 0 };
      },
    },
    images: { image: (): PdfObject => ({ kind: 'ref' as const, num: 999, gen: 0 }) },
  };
}

const noFonts = {
  dict: () => new Map<string, PdfObject>(),
  face: () => { throw new Error('no font expected'); },
};

function draw(src: string) {
  const rec = recordingSink();
  const r = drawSvg(parseXml(new TextEncoder().encode(src)),
    { minX: 0, minY: 0, w: 100, h: 100 }, noFonts as never, rec.sink, rec.images as never);
  return { ...r, streams: rec.streams };
}

const ARROW =
  '<defs><marker id="mk" markerWidth="10" markerHeight="10" refX="5" refY="5" ' +
  'markerUnits="userSpaceOnUse"><rect width="10" height="10" fill="#0000ff"/>' +
  '</marker></defs>';

describe('svgdraw — marker wiring', () => {
  it('reports nothing and emits one Do per vertex', () => {
    const { content, skipped } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 50 10 L 90 10" stroke="#000" marker-mid="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    // One mid vertex on a three-vertex path.
    expect((content.match(/\/Fm\d+ Do/g) ?? []).length).toBe(1);
  });

  it('emits a Do for each of start, mid and end', () => {
    const { content } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 50 10 L 90 10" stroke="#000" marker="url(#mk)"/></svg>');
    expect((content.match(/\/Fm\d+ Do/g) ?? []).length).toBe(3);
  });

  it("allocates ONE form for all of an element's vertices", () => {
    const { streams } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 50 10 L 90 10" stroke="#000" marker="url(#mk)"/></svg>');
    expect(streams.length).toBe(1);
  });

  it('places each Do at its vertex', () => {
    const { content } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 20 L 90 20" stroke="#000" marker-start="url(#mk)"/></svg>');
    // refX/refY 5,5 with userSpaceOnUse: the content shifts by -5,-5 then lands
    // on (10,20), so the cm translation is (5,15).
    expect(content).toMatch(/1 0 0 1 5 15 cm/);
  });

  it('does not paint a <marker> where it sits', () => {
    const { content, skipped } = draw(`<svg viewBox="0 0 100 100">${ARROW}</svg>`);
    expect(content.trim()).toBe('');
    expect(skipped).toEqual([]);
  });

  it('ignores markers on a shape they do not apply to', () => {
    const { content, skipped } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<rect width="50" height="50" stroke="#000" marker="url(#mk)"/></svg>');
    expect(skipped).toEqual([]);
    expect(content).not.toMatch(/\/Fm\d+ Do/);
  });

  it('applies to line, polyline and polygon', () => {
    for (const shape of [
      '<line x1="0" y1="0" x2="10" y2="0" stroke="#000" marker-start="url(#mk)"/>',
      '<polyline points="0,0 10,0" stroke="#000" marker-start="url(#mk)"/>',
      '<polygon points="0,0 10,0 10,10" stroke="#000" marker-start="url(#mk)"/>',
    ]) {
      const { content } = draw(`<svg viewBox="0 0 100 100">${ARROW}${shape}</svg>`);
      expect(content).toMatch(/\/Fm\d+ Do/);
    }
  });

  it('reports url() for a missing marker target and still draws the path', () => {
    const { content, skipped } = draw(
      '<svg viewBox="0 0 100 100">' +
      '<path d="M 0 0 L 10 0" stroke="#000" marker-start="url(#gone)"/></svg>');
    expect(skipped).toEqual(['url()']);
    // The path carries SVG's initial black fill as well as the stroke, so it
    // paints with B (fill-and-stroke) rather than S. What matters is that ink
    // was emitted at all: a broken marker must not take the path with it.
    expect(content).toMatch(/\nB\b/);
    expect(content).not.toMatch(/\/Fm\d+ Do/);
  });

  it('clips the form to the viewport by default', () => {
    const { streams } = draw(
      `<svg viewBox="0 0 100 100">${ARROW}` +
      '<path d="M 10 10 L 90 10" stroke="#000" marker-start="url(#mk)"/></svg>');
    expect(streams[0].dict.get('BBox')).toEqual([0, 0, 10, 10]);
  });

  it("does not inherit the referencing element's paint", () => {
    // The path is red; the marker rect specifies no fill, so it must be BLACK
    // (SVG's initial fill), not red.
    const { streams } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<marker id="mk" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse">' +
      '<rect width="10" height="10"/></marker></defs>' +
      '<path d="M 0 0 L 10 0" fill="#ff0000" stroke="#ff0000" marker-start="url(#mk)"/></svg>');
    expect(streams[0].content).toContain('0 0 0 rg');
    expect(streams[0].content).not.toContain('1 0 0 rg');
  });

  it('scales by stroke-width under the default markerUnits', () => {
    const { content } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<marker id="mk" markerWidth="10" markerHeight="10"><rect width="10" height="10"/>' +
      '</marker></defs>' +
      '<path d="M 0 0 L 10 0" stroke="#000" stroke-width="3" marker-start="url(#mk)"/></svg>');
    expect(content).toMatch(/3 0 0 3 0 0 cm/);
  });

  it('breaks a marker reference cycle instead of recursing forever', () => {
    const { skipped } = draw(
      '<svg viewBox="0 0 100 100"><defs>' +
      '<marker id="mk" markerWidth="10" markerHeight="10">' +
      '<path d="M 0 0 L 5 0" stroke="#000" marker-start="url(#mk)"/></marker></defs>' +
      '<path d="M 0 0 L 10 0" stroke="#000" marker-start="url(#mk)"/></svg>');
    expect(skipped).toContain('marker');        // returns, does not hang
  });
});
