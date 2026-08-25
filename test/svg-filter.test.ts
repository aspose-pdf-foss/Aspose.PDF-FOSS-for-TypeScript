import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { primLength, resolveFilter, type FilterSpec } from '../src/svgfilter.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** The element carrying `id`, from a document fragment. */
function nodeOf(src: string, id = 'f'): XmlNode {
  const root = parseXml(xml(src));
  let found: XmlNode | undefined;
  const walk = (n: XmlNode): void => {
    if (n.attrs.get('id') === id) found ??= n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found!;
}

const VP = { minX: 0, minY: 0, w: 200, h: 100 };
const BOX = { x: 10, y: 20, w: 40, h: 80 };

/** resolveFilter, asserting it resolved to a runnable spec. */
function spec(src: string, bbox = BOX): FilterSpec {
  const r = resolveFilter(nodeOf(src), bbox, VP);
  if (r.kind !== 'draw') throw new Error(`expected draw, got ${r.kind}`);
  return r.spec;
}

describe('resolveFilter — graph wiring', () => {
  it('defaults the first input to SourceGraphic', () => {
    const s = spec('<svg><filter id="f"><feOffset dx="1"/></filter></svg>');
    expect(s.prims).toHaveLength(1);
    expect(s.prims[0].name).toBe('feOffset');
    expect(s.prims[0].in1).toBe('SourceGraphic');
  });

  it('chains an implicit input to the previous result', () => {
    const s = spec('<svg><filter id="f"><feOffset dx="1"/><feFlood/></filter></svg>');
    // Every primitive gets a result key, named or not; the second reads the first.
    expect(s.prims[1].in1).toBe(s.prims[0].result);
  });

  it('resolves a named result referenced later', () => {
    // in2 is read off the attributes whatever the primitive is, so the wiring
    // is testable before any two-input kernel exists.
    const s = spec(
      '<svg><filter id="f"><feOffset dx="1" result="shift"/>' +
      '<feFlood/><feOffset in="shift" in2="SourceGraphic" dx="1"/></filter></svg>');
    expect(s.prims[2].in1).toBe('shift');
    expect(s.prims[2].in2).toBe('SourceGraphic');
    expect(s.prims[0].result).toBe('shift');
  });

  it('gives distinct result keys to unnamed primitives', () => {
    const s = spec('<svg><filter id="f"><feFlood/><feFlood/><feFlood/></filter></svg>');
    const keys = new Set(s.prims.map((p) => p.result));
    expect(keys.size).toBe(3);
  });

  it('carries SourceAlpha through as a pseudo-input', () => {
    const s = spec('<svg><filter id="f"><feOffset in="SourceAlpha" dx="1"/></filter></svg>');
    expect(s.prims[0].in1).toBe('SourceAlpha');
  });

  it('ignores non-primitive children', () => {
    const s = spec('<svg><filter id="f"><title>x</title><feOffset dx="1"/></filter></svg>');
    expect(s.prims).toHaveLength(1);
  });

  it('reads color-interpolation-filters per primitive, defaulting to linearRGB', () => {
    const s = spec(
      '<svg><filter id="f"><feFlood/>' +
      '<feFlood color-interpolation-filters="sRGB"/></filter></svg>');
    expect(s.prims[0].space).toBe('linearRGB');
    expect(s.prims[1].space).toBe('sRGB');
  });

  it('inherits color-interpolation-filters from the filter element', () => {
    const s = spec(
      '<svg><filter id="f" color-interpolation-filters="sRGB">' +
      '<feFlood/></filter></svg>');
    expect(s.prims[0].space).toBe('sRGB');
  });
});

describe('resolveFilter — refusals', () => {
  it('skips and reports an unsupported primitive', () => {
    // A MADE-UP name, not a real one: SVG 1.1's whole primitive set is now
    // supported, so every real name would make this test pass vacuously the
    // moment its kernel landed. Anything starting with 'fe' counts as a
    // primitive, so this exercises the refusal path and cannot go stale.
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feNonesuch/></filter></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['feNonesuch']);
  });

  it('skips a chain whose `in` names nothing', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feOffset in="ghost" dx="1"/></filter></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['filter']);
  });

  it('skips a forward reference: results are visible only to LATER primitives', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feOffset in="later" dx="1"/>' +
             '<feFlood result="later"/></filter></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
  });

  it('reports BackgroundImage rather than pretending to have a backdrop', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f"><feOffset in="BackgroundImage" dx="1"/></filter></svg>'),
      BOX, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['filter']);
  });

  it('skips an empty filter: no primitives means no defined result', () => {
    const r = resolveFilter(nodeOf('<svg><filter id="f"/></svg>'), BOX, VP);
    expect(r.kind).toBe('skip');
  });
});

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
const OFF = '<feOffset dx="1"/>';

describe('resolveFilter — region', () => {
  it('defaults to a 10% bleed around the box under objectBoundingBox', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    near(s.region.x, 10 - 4);        // x - 0.1*w
    near(s.region.y, 20 - 8);        // y - 0.1*h
    near(s.region.w, 40 * 1.2);
    near(s.region.h, 80 * 1.2);
  });

  it('takes explicit fractions under objectBoundingBox', () => {
    const s = spec(
      `<svg><filter id="f" x="0" y="0" width="0.5" height="0.25">${OFF}</filter></svg>`);
    near(s.region.x, 10); near(s.region.y, 20);
    near(s.region.w, 20); near(s.region.h, 20);
  });

  it('takes literal user units under userSpaceOnUse', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="5" y="6" ' +
      `width="30" height="40">${OFF}</filter></svg>`);
    near(s.region.x, 5); near(s.region.y, 6);
    near(s.region.w, 30); near(s.region.h, 40);
  });

  it('resolves the percentage defaults against the VIEWPORT under userSpaceOnUse', () => {
    const s = spec(
      `<svg><filter id="f" filterUnits="userSpaceOnUse">${OFF}</filter></svg>`);
    near(s.region.x, -0.1 * VP.w);
    near(s.region.y, -0.1 * VP.h);
    near(s.region.w, 1.2 * VP.w);
    near(s.region.h, 1.2 * VP.h);
  });

  it('renders nothing, and reports nothing, for a zero-width region', () => {
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f" width="0">${OFF}</filter></svg>`), BOX, VP);
    // SVG 1.1 15.7.2: the element is not rendered. The author asked for it.
    expect(r.kind).toBe('empty');
  });

  it('renders nothing for a negative height', () => {
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f" height="-1">${OFF}</filter></svg>`), BOX, VP);
    expect(r.kind).toBe('empty');
  });

  it('skips when objectBoundingBox units meet a box with no area', () => {
    // Not 'empty': the element has ink, and dropping it would be a loss.
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f">${OFF}</filter></svg>`),
      { x: 0, y: 0, w: 0, h: 10 }, VP);
    expect(r.kind).toBe('skip');
    if (r.kind === 'skip') expect(r.report).toEqual(['filter']);
  });

  it('skips when objectBoundingBox units meet no box at all', () => {
    const r = resolveFilter(
      nodeOf(`<svg><filter id="f">${OFF}</filter></svg>`), null, VP);
    expect(r.kind).toBe('skip');
  });

  it('does NOT need a box under userSpaceOnUse with userSpaceOnUse primitives', () => {
    const r = resolveFilter(
      nodeOf('<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" ' +
             `width="10" height="10">${OFF}</filter></svg>`), null, VP);
    expect(r.kind).toBe('draw');
  });

  it('carries filterRes as a raster cap', () => {
    const s = spec(`<svg><filter id="f" filterRes="64 32">${OFF}</filter></svg>`);
    expect(s.res).toEqual([64, 32]);
  });

  it('ignores a malformed filterRes rather than capping to nonsense', () => {
    const s = spec(`<svg><filter id="f" filterRes="wide">${OFF}</filter></svg>`);
    expect(s.res).toBeUndefined();
  });
});

describe('resolveFilter — primitive subregions', () => {
  it('defaults a subregion to the whole filter region', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    expect(s.prims[0].sub).toEqual(s.region);
  });

  it('takes literal user units under the default primitiveUnits', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
      '<feOffset dx="1" x="10" y="20" width="30" height="40"/></filter></svg>');
    const sub = s.prims[0].sub;
    near(sub.x, 10); near(sub.y, 20); near(sub.w, 30); near(sub.h, 40);
  });

  it('takes bbox fractions under primitiveUnits=objectBoundingBox', () => {
    const s = spec(
      '<svg><filter id="f" primitiveUnits="objectBoundingBox" ' +
      'filterUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">' +
      '<feOffset dx="1" x="0" y="0" width="0.5" height="0.5"/></filter></svg>');
    const sub = s.prims[0].sub;
    // BOX is (10, 20, 40, 80).
    near(sub.x, 10); near(sub.y, 20); near(sub.w, 20); near(sub.h, 40);
  });

  it('clips a subregion to the filter region', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="50" height="50">' +
      '<feOffset dx="1" x="40" y="40" width="100" height="100"/></filter></svg>');
    const sub = s.prims[0].sub;
    near(sub.x, 40); near(sub.y, 40); near(sub.w, 10); near(sub.h, 10);
  });

  it('takes only the axes that are given, leaving the others at the region', () => {
    const s = spec(
      '<svg><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="50" height="50">' +
      '<feOffset dx="1" x="10"/></filter></svg>');
    const sub = s.prims[0].sub;
    near(sub.x, 10); near(sub.y, 0);
    near(sub.w, 40);                   // narrowed by the x shift, not reset
    near(sub.h, 50);
  });

  it('records primitiveUnits on the spec', () => {
    const a = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    const b = spec(
      `<svg><filter id="f" primitiveUnits="objectBoundingBox">${OFF}</filter></svg>`);
    expect(a.obb).toBe(false);
    expect(b.obb).toBe(true);
  });
});

describe('primLength', () => {
  it('is literal under userSpaceOnUse', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    near(primLength(s, '4', 0, 'x'), 4);
    near(primLength(s, '4', 0, 'y'), 4);
  });

  it('scales by the box axis under objectBoundingBox', () => {
    const s = spec(
      `<svg><filter id="f" primitiveUnits="objectBoundingBox">${OFF}</filter></svg>`);
    near(primLength(s, '0.5', 0, 'x'), 20);    // 0.5 * BOX.w
    near(primLength(s, '0.5', 0, 'y'), 40);    // 0.5 * BOX.h
  });

  it('returns the default for an absent or unparseable value', () => {
    const s = spec(`<svg><filter id="f">${OFF}</filter></svg>`);
    near(primLength(s, undefined, 7, 'x'), 7);
    near(primLength(s, 'thick', 7, 'x'), 7);
  });
});
