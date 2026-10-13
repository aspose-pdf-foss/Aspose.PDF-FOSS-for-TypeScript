// test/xfaborder.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseBorder, parseGeometry, widgetStyleOf } from '../src/xfaborder.js';

const xml = (s: string) => parseXml(new TextEncoder().encode(s));
const MM = 72 / 25.4;

describe('parseBorder (XFA 3.3 p. 38, 629-630, 663-665, 687-689)', () => {
  it('repeats the LAST edge for the missing ones, in the order top, right, bottom, left', () => {
    const b = parseBorder(xml('<border><edge thickness="2pt"/><edge thickness="3pt"/></border>'));
    expect(b.edges!.map((e) => e.thickness)).toEqual([2, 3, 3, 3]);
  });

  it('is not stroked when no <edge> is supplied at all, but may still fill', () => {
    const b = parseBorder(xml('<border><fill><color value="255,0,0"/></fill></border>'));
    expect(b.edges).toBeUndefined();
    expect(b.fill).toEqual({ kind: 'solid', color: [1, 0, 0] });
  });

  it('gives an edge the defaults: solid, 0.5pt, black, square cap, visible', () => {
    const b = parseBorder(xml('<border><edge/></border>'));
    expect(b.edges![0]).toEqual({ visible: true, stroke: 'solid', thickness: 0.5, color: [0, 0, 0], cap: 'square' });
  });

  it('uses default corners for all four when none is supplied', () => {
    const b = parseBorder(xml('<border><edge/></border>'));
    expect(b.corners).toHaveLength(4);
    expect(b.corners[0]).toEqual({ visible: true, stroke: 'solid', thickness: 0.5, color: [0, 0, 0], radius: 0, join: 'square', inverted: false });
  });

  it('repeats the last corner, and reads radius, join and inverted', () => {
    const b = parseBorder(xml('<border><edge/><corner radius="2mm" join="round" inverted="1"/></border>'));
    expect(b.corners.map((c) => c.radius)).toEqual([2 * MM, 2 * MM, 2 * MM, 2 * MM]);
    expect(b.corners[3]).toMatchObject({ join: 'round', inverted: true });
  });

  it('reads an edge colour as 0..255 components', () => {
    const b = parseBorder(xml('<border><edge><color value="51,102,255"/></edge></border>'));
    expect(b.edges![0].color).toEqual([0.2, 0.4, 1]);
  });

  it('falls back to black and records a note for an unreadable colour', () => {
    const b = parseBorder(xml('<border><edge><color value="red"/></edge></border>'));
    expect(b.edges![0].color).toEqual([0, 0, 0]);
    expect(b.notes).toEqual(['edge color value="red" could not be read, so black is used']);
  });

  it('reads an edge whose presence is not visible as invisible', () => {
    const b = parseBorder(xml('<border><edge presence="hidden"/></border>'));
    expect(b.edges!.every((e) => !e.visible)).toBe(true);
  });

  it('reads hand, defaulting to even, and the border margin', () => {
    expect(parseBorder(xml('<border><edge/></border>')).hand).toBe('even');
    const b = parseBorder(xml('<border hand="right"><edge/><margin leftInset="1pt" topInset="2pt"/></border>'));
    expect(b.hand).toBe('right');
    expect(b.margin).toEqual({ l: 1, r: 0, t: 2, b: 0 });
  });

  it('reads an empty <fill/> as solid WHITE (p. 39)', () => {
    expect(parseBorder(xml('<border><fill/></border>')).fill).toEqual({ kind: 'solid', color: [1, 1, 1] });
  });

  it('reads a gradient, pattern or stipple fill as unsupported, naming it', () => {
    for (const t of ['linear', 'radial', 'pattern', 'stipple'])
      expect(parseBorder(xml(`<border><fill><${t}/></fill></border>`)).fill).toEqual({ kind: 'unsupported', type: t });
  });

  it('drops a fill whose presence is not visible', () => {
    expect(parseBorder(xml('<border><fill presence="invisible"/></border>')).fill).toBeUndefined();
  });

  it('reads presence and break', () => {
    expect(parseBorder(xml('<border presence="invisible"><edge/></border>')).visible).toBe(false);
    expect(parseBorder(xml('<border break="open"><edge/></border>')).breakOpen).toBe(true);
  });
});

describe('parseGeometry (p. 768, 824)', () => {
  it('reads a line, its slope defaulting to \\', () => {
    expect(parseGeometry(xml('<value><line><edge thickness="1pt"/></line></value>'))).toMatchObject({
      kind: 'line', slope: '\\', hand: 'even', edge: { thickness: 1 },
    });
    expect(parseGeometry(xml('<value><line slope="/"/></value>'))).toMatchObject({ slope: '/' });
  });

  it('reads a rectangle with the border repetition rules', () => {
    const g = parseGeometry(xml('<value><rectangle><edge thickness="2pt"/></rectangle></value>'));
    expect(g).toMatchObject({ kind: 'rectangle' });
    if (g?.kind !== 'rectangle') throw new Error('not a rectangle');
    expect(g.edges.map((e) => e.thickness)).toEqual([2, 2, 2, 2]);
    expect(g.corners).toHaveLength(4);
  });

  it('reads an arc as unsupported', () => {
    expect(parseGeometry(xml('<value><arc/></value>'))).toEqual({ kind: 'unsupported', what: 'arc' });
  });

  it('is undefined for text content', () => {
    expect(parseGeometry(xml('<value><text>x</text></value>'))).toBeUndefined();
  });
});

describe('widgetStyleOf: an XFA widget border to /MK + /BS', () => {
  // Adobe's own mapping, measured on IRS f1040 f2_39: a 0.0353mm (0.1pt)
  // 51,51,51 edge became /BC [0.2 0.2 0.2] /BS << /S /S /W 1 >>.
  it('writes /W 1 for an edge thinner than a point, as Adobe does', () => {
    const b = parseBorder(xml('<border hand="right"><edge thickness="0.0353mm"><color value="51,51,51"/></edge></border>'));
    expect(widgetStyleOf(b)).toEqual({ style: { borderColor: [0.2, 0.2, 0.2], borderWidth: 1, borderStyle: 'solid' } });
  });

  it('maps lowered to inset and raised to beveled', () => {
    const lo = parseBorder(xml('<border><edge stroke="lowered"/></border>'));
    const hi = parseBorder(xml('<border><edge stroke="raised"/></border>'));
    expect(widgetStyleOf(lo)?.style.borderStyle).toBe('inset');
    expect(widgetStyleOf(hi)?.style.borderStyle).toBe('beveled');
  });

  it('maps the four dash strokes to dashed', () => {
    for (const s of ['dashed', 'dotted', 'dashDot', 'dashDotDot'])
      expect(widgetStyleOf(parseBorder(xml(`<border><edge stroke="${s}"/></border>`)))?.style.borderStyle).toBe('dashed');
  });

  it('maps etched and embossed to solid and says so', () => {
    const r = widgetStyleOf(parseBorder(xml('<border><edge stroke="etched"/></border>')));
    expect(r?.style.borderStyle).toBe('solid');
    expect(r?.degraded).toBe('an etched widget border has no AcroForm counterpart and is drawn solid');
  });

  it('maps a border with only the BOTTOM edge visible to underline', () => {
    const b = parseBorder(xml('<border><edge presence="hidden"/><edge presence="hidden"/><edge/><edge presence="hidden"/></border>'));
    expect(widgetStyleOf(b)?.style.borderStyle).toBe('underline');
  });

  it('draws another partial border as a full box and says so', () => {
    const b = parseBorder(xml('<border><edge/><edge presence="hidden"/></border>'));
    expect(widgetStyleOf(b)?.degraded).toBe('a widget border with only some edges visible is drawn as a full box');
  });

  it('writes the fill colour as /MK /BG', () => {
    const b = parseBorder(xml('<border><edge/><fill><color value="255,255,0"/></fill></border>'));
    expect(widgetStyleOf(b)?.style.backgroundColor).toEqual([1, 1, 0]);
  });

  it('is undefined for an invisible border, or one with no visible edge and no fill', () => {
    expect(widgetStyleOf(parseBorder(xml('<border presence="hidden"><edge/></border>')))).toBeUndefined();
    expect(widgetStyleOf(parseBorder(xml('<border><edge presence="hidden"/></border>')))).toBeUndefined();
  });

  it('writes a fill alone, with no border stroke', () => {
    const r = widgetStyleOf(parseBorder(xml('<border><edge presence="hidden"/><fill><color value="0,0,255"/></fill></border>')));
    expect(r).toEqual({ style: { backgroundColor: [0, 0, 1] } });
  });
});
