import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolvePattern, tileRect, tileMatrix } from '../src/svgpattern.js';
import { IDENTITY } from '../src/text.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** Index every element carrying an id, as svgdraw does. */
function index(root: XmlNode): Map<string, XmlNode> {
  const m = new Map<string, XmlNode>();
  const walk = (n: XmlNode): void => {
    const id = n.attrs.get('id');
    if (id !== undefined && !m.has(id)) m.set(id, n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return m;
}

function pat(src: string, id = 'p') {
  const root = parseXml(xml(src));
  const ids = index(root);
  return { r: resolvePattern(ids.get(id)!, ids), ids };
}

const VP = { minX: 0, minY: 0, w: 200, h: 100 };
const BOX = { x: 10, y: 20, w: 40, h: 80 };

describe('svgpattern — href inheritance', () => {
  it('keeps its own attributes', () => {
    const { r } = pat('<svg><pattern id="p" width="4" height="5"/></svg>');
    expect(r.attrs.get('width')).toBe('4');
  });

  it('inherits attributes it does not define', () => {
    const { r } = pat('<svg><pattern id="base" width="4" height="5"/>' +
      '<pattern id="p" href="#base" width="9"/></svg>');
    expect(r.attrs.get('width')).toBe('9');       // own wins
    expect(r.attrs.get('height')).toBe('5');      // inherited
  });

  it('never inherits id or href', () => {
    const { r } = pat('<svg><pattern id="base" width="4"/>' +
      '<pattern id="p" href="#base"/></svg>');
    expect(r.attrs.get('id')).toBe('p');
    expect(r.attrs.get('href')).toBe('#base');
  });

  it('takes content from the nearest ancestor that has children', () => {
    const { r } = pat('<svg><pattern id="base"><rect width="1" height="1"/></pattern>' +
      '<pattern id="p" href="#base" width="9"/></svg>');
    expect(r.content.children.map((c) => c.name)).toEqual(['rect']);
  });

  it('prefers its own content over inherited content', () => {
    const { r } = pat('<svg><pattern id="base"><rect/></pattern>' +
      '<pattern id="p" href="#base"><circle/></pattern></svg>');
    expect(r.content.children.map((c) => c.name)).toEqual(['circle']);
  });

  it('terminates on a reference cycle', () => {
    const { r } = pat('<svg><pattern id="p" href="#q" width="1"/>' +
      '<pattern id="q" href="#p" height="2"/></svg>');
    expect(r.attrs.get('height')).toBe('2');
  });
});

describe('svgpattern — tile rect', () => {
  it('resolves objectBoundingBox fractions against the shape box', () => {
    const attrs = new Map([['x', '0.5'], ['y', '0.25'], ['width', '0.5'], ['height', '0.5']]);
    expect(tileRect(attrs, true, BOX, VP)).toEqual({ x: 30, y: 40, w: 20, h: 40 });
  });

  it('resolves userSpaceOnUse values as user units', () => {
    const attrs = new Map([['x', '5'], ['y', '6'], ['width', '7'], ['height', '8']]);
    expect(tileRect(attrs, false, BOX, VP)).toEqual({ x: 5, y: 6, w: 7, h: 8 });
  });

  it('resolves a userSpaceOnUse percentage against the viewport', () => {
    const attrs = new Map([['width', '50%'], ['height', '50%']]);
    const t = tileRect(attrs, false, BOX, VP)!;
    expect(t.w).toBeCloseTo(100, 9);
    expect(t.h).toBeCloseTo(50, 9);
  });

  it('defaults x and y to zero', () => {
    const attrs = new Map([['width', '4'], ['height', '5']]);
    expect(tileRect(attrs, false, BOX, VP)).toMatchObject({ x: 0, y: 0 });
  });

  it('returns null for a tile with no area', () => {
    // SVG: the element is not rendered by that paint. Not a fidelity loss.
    expect(tileRect(new Map([['width', '0'], ['height', '5']]), false, BOX, VP)).toBe(null);
    expect(tileRect(new Map([['width', '4'], ['height', '-1']]), false, BOX, VP)).toBe(null);
    expect(tileRect(new Map(), false, BOX, VP)).toBe(null);
  });

  it('returns null under objectBoundingBox when the shape has no area', () => {
    const attrs = new Map([['width', '0.5'], ['height', '0.5']]);
    expect(tileRect(attrs, true, { x: 0, y: 0, w: 0, h: 10 }, VP)).toBe(null);
  });
});

const RECT = { x: 10, y: 20, w: 4, h: 5 };
const attrs = (o: Record<string, string>) => new Map(Object.entries(o));

describe('svgpattern — the tile matrix', () => {
  it('translates the pattern origin to the tile rect', () => {
    const { matrix } = tileMatrix(attrs({}), RECT, false, BOX, [...IDENTITY]);
    expect(matrix).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it('composes the walker CTM after the tile placement', () => {
    const { matrix } = tileMatrix(attrs({}), RECT, false, BOX, [2, 0, 0, 2, 0, 0]);
    expect(matrix).toEqual([2, 0, 0, 2, 20, 40]);
  });

  it('applies patternTransform inside the pattern coordinate system', () => {
    // Leftmost = first applied, matching gradientTransform's order.
    const { matrix } = tileMatrix(
      attrs({ patternTransform: 'scale(3)' }), RECT, false, BOX, [...IDENTITY]);
    expect(matrix).toEqual([3, 0, 0, 3, 10, 20]);
  });

  it('leaves the content transform identity by default', () => {
    const { content } = tileMatrix(attrs({}), RECT, false, BOX, [...IDENTITY]);
    expect(content).toEqual([...IDENTITY]);
  });

  it('scales content by the shape box under patternContentUnits', () => {
    const { content } = tileMatrix(
      attrs({ patternContentUnits: 'objectBoundingBox' }), RECT, false, BOX, [...IDENTITY]);
    expect(content).toEqual([BOX.w, 0, 0, BOX.h, 0, 0]);
  });

  it('fits a viewBox to the tile, overriding patternContentUnits', () => {
    // viewBox 0 0 10 10 into a 4x5 tile, meet -> uniform scale 0.4.
    const { content } = tileMatrix(
      attrs({ viewBox: '0 0 10 10', patternContentUnits: 'objectBoundingBox' }),
      RECT, false, BOX, [...IDENTITY]);
    expect(content[0]).toBeCloseTo(0.4, 9);
    expect(content[3]).toBeCloseTo(0.4, 9);
  });

  it('stretches a viewBox under preserveAspectRatio none', () => {
    const { content } = tileMatrix(
      attrs({ viewBox: '0 0 10 10', preserveAspectRatio: 'none' }),
      RECT, false, BOX, [...IDENTITY]);
    expect(content[0]).toBeCloseTo(0.4, 9);
    expect(content[3]).toBeCloseTo(0.5, 9);
  });

  it('keeps the viewBox fit y-DOWN, so tile content is not mirrored', () => {
    // placementMatrix carries the page y-flip; a tile must not inherit it.
    const { content } = tileMatrix(
      attrs({ viewBox: '0 0 10 10' }), RECT, false, BOX, [...IDENTITY]);
    expect(content[3]).toBeGreaterThan(0);
  });
});
