import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { drawSvg, __ctmProbe, __canon } from '../src/svgdraw.js';
import { isDict, ref, name, type PdfDict } from '../src/types.js';
import { fakeProvider } from './helpers/fake-svg-font.js';

const VP = { minX: 0, minY: 0, w: 100, h: 100 };
/** A sink that hands back a distinct reference per stream, so patKey and the
 *  mask-group cache can tell them apart without a Document. */
const noStreams = () => {
  let n = 0;
  return { stream: () => ref(++n) };
};
/** A sink that hands back a distinct reference per image, so xobjKey can tell
 *  them apart without a Document. */
const noImages = () => {
  let n = 100;
  return { image: () => ref(++n) };
};
const draw = (svg: string) =>
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(), noStreams(), noImages());
const body = (svg: string) => draw(svg).content;

describe('drawSvg — shapes', () => {
  it('emits a path as moveto/lineto and a fill', () => {
    const c = body('<svg><path d="M0 0 L10 0 L10 10 Z"/></svg>');
    expect(c).toContain('0 0 m');
    expect(c).toContain('10 0 l');
    expect(c).toContain('h');
    expect(c).toMatch(/\bf\b/);
  });

  it('emits a rect as a closed subpath', () => {
    const c = body('<svg><rect x="1" y="2" width="3" height="4"/></svg>');
    expect(c).toContain('1 2 m');
    expect(c).toContain('4 2 l');
    expect(c).toContain('4 6 l');
  });

  it('emits circle and ellipse as cubics', () => {
    expect(body('<svg><circle cx="0" cy="0" r="5"/></svg>')).toContain(' c');
    expect(body('<svg><ellipse cx="0" cy="0" rx="5" ry="2"/></svg>')).toContain(' c');
  });

  it('strokes a line, and emits no stroke op when it has no stroke', () => {
    // A line has no area, so the default black fill paints nothing. The fill
    // operator may still be emitted (harmless); what must not appear is S.
    expect(body('<svg><line x1="0" y1="0" x2="10" y2="10"/></svg>')).not.toMatch(/\bS\b/);
    const c = body('<svg><line x1="0" y1="0" x2="10" y2="10" stroke="red"/></svg>');
    expect(c).toContain('0 0 m');
    expect(c).toContain('10 10 l');
    expect(c).toMatch(/\bS\b/);
  });

  it('emits polyline open and polygon closed', () => {
    expect(body('<svg><polyline points="0,0 5,5" stroke="red"/></svg>')).not.toMatch(/\bh\b/);
    expect(body('<svg><polygon points="0,0 5,5 5,0"/></svg>')).toMatch(/\bh\b/);
  });
});

describe('drawSvg — paint', () => {
  it('fills black by default and does not stroke', () => {
    const c = body('<svg><rect width="10" height="10"/></svg>');
    expect(c).toContain('0 0 0 rg');
    expect(c).toMatch(/\bf\b/);
    expect(c).not.toMatch(/\bS\b/);
  });

  it('draws nothing for a shape with neither fill nor stroke', () => {
    const c = body('<svg><rect width="10" height="10" fill="none"/></svg>');
    expect(c).not.toMatch(/\b[fSB]\b/);
  });

  it('uses B when both fill and stroke are set', () => {
    const c = body('<svg><rect width="10" height="10" fill="red" stroke="blue"/></svg>');
    expect(c).toContain('1 0 0 rg');
    expect(c).toContain('0 0 1 RG');
    expect(c).toMatch(/\bB\b/);
  });

  it('selects the even-odd operators for fill-rule evenodd', () => {
    expect(body('<svg><rect width="9" height="9" fill-rule="evenodd"/></svg>')).toMatch(/\bf\*/);
    expect(body('<svg><rect width="9" height="9" fill-rule="evenodd" stroke="red"/></svg>'))
      .toMatch(/\bB\*/);
  });

  it('emits stroke width, cap, join and dash', () => {
    const c = body('<svg><path d="M0 0L9 9" stroke="red" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="bevel" stroke-dasharray="4 2" ' +
      'stroke-dashoffset="1"/></svg>');
    expect(c).toContain('2 w');
    expect(c).toContain('1 J');
    expect(c).toContain('2 j');
    expect(c).toContain('[4 2] 1 d');
  });

  it('registers an ExtGState for partial opacity and references it', () => {
    const r = draw('<svg><rect width="9" height="9" fill="red" fill-opacity="0.5"/></svg>');
    expect(r.content).toMatch(/\/GS\d+ gs/);
    const gs = r.resources.get('ExtGState');
    expect(isDict(gs)).toBe(true);
    const first = [...(gs as PdfDict).values()][0] as PdfDict;
    expect(first.get('ca')).toBeCloseTo(0.5, 9);
    expect(first.get('CA')).toBe(1);
  });

  it('reuses one ExtGState for equal alpha pairs', () => {
    const r = draw('<svg><rect width="9" height="9" opacity="0.5"/>' +
      '<rect width="9" height="9" opacity="0.5"/></svg>');
    expect((r.resources.get('ExtGState') as PdfDict).size).toBe(1);
  });

  it('paints a filled AND stroked shape in one pass with a single B', () => {
    const c = body('<svg><rect width="10" height="10" fill="red" stroke="blue"/></svg>');
    expect(c.match(/\bB\b/g)).toHaveLength(1);
    expect(c).not.toMatch(/\bf\b/);
    expect(c).not.toMatch(/\bS\b/);
    expect(c.match(/\bq\b/g)).toHaveLength(1);
  });

  it('emits no ExtGState at full opacity', () => {
    const r = draw('<svg><rect width="9" height="9"/></svg>');
    expect(r.resources.get('ExtGState')).toBeUndefined();
    expect(r.content).not.toContain(' gs');
  });
});

describe('drawSvg — structure and transforms', () => {
  it('emits a transform as a cm inside a q/Q pair', () => {
    const c = body('<svg><g transform="translate(10 20)"><rect width="1" height="1"/></g></svg>');
    expect(c).toContain('1 0 0 1 10 20 cm');
    expect(c).toMatch(/q[\s\S]*cm[\s\S]*Q/);
  });

  it('nests group transforms', () => {
    const c = body('<svg><g transform="translate(10 0)"><g transform="scale(2)">' +
      '<rect width="1" height="1"/></g></g></svg>');
    expect(c).toContain('1 0 0 1 10 0 cm');
    expect(c).toContain('2 0 0 2 0 0 cm');
  });

  it('applies a transform on the shape itself', () => {
    expect(body('<svg><rect width="1" height="1" transform="scale(3)"/></svg>'))
      .toContain('3 0 0 3 0 0 cm');
  });

  it('inherits paint from an enclosing group', () => {
    expect(body('<svg><g fill="red"><rect width="9" height="9"/></g></svg>'))
      .toContain('1 0 0 rg');
  });

  it('ignores non-rendering elements without reporting them', () => {
    const r = draw('<svg><title>T</title><desc>D</desc><metadata>M</metadata>' +
      '<rect width="9" height="9"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).toMatch(/\bf\b/);
  });

  it('does not draw the contents of defs', () => {
    const r = draw('<svg><defs><rect width="9" height="9"/></defs></svg>');
    expect(r.content).not.toMatch(/\bf\b/);
    expect(r.skipped).toEqual([]);
  });
});

describe('drawSvg — skipped reporting', () => {
  // <text> was the exemplar until 1gg0.8 made it render, then <mask> until
  // 1gg0.10 did. <foreignObject> is the durable choice: it embeds a foreign
  // markup namespace, so no phase of the SVG work will ever make it render.
  it('reports an unsupported element once, sorted', () => {
    const r = draw('<svg><foreignObject/><rect width="9" height="9"/><foreignObject/></svg>');
    expect(r.skipped).toEqual(['foreignObject']);
  });

  it('reports several unsupported elements in sorted order', () => {
    const r = draw('<svg><image href="x"/><foreignObject/></svg>');
    expect(r.skipped).toEqual(['foreignObject', 'image']);
  });

  it('reports the referenced element behind an unsupported paint', () => {
    // <pattern> stood in for the general unsupported case until 1gg0.19 made
    // it a real paint server; <mask> is not one, so naming it in a fill is
    // both unsupported and unresolvable as paint.
    const r = draw('<svg><defs><mask id="m"/></defs>' +
      '<rect width="9" height="9" fill="url(#m)"/></svg>');
    expect(r.skipped).toContain('mask');
    expect(r.content).not.toMatch(/\bf\b/);      // falls back to none, never black
  });

  it('reports an unresolvable paint reference as url()', () => {
    const r = draw('<svg><rect width="9" height="9" fill="url(#missing)"/></svg>');
    expect(r.skipped).toEqual(['url()']);
  });

  it('reports a path whose data was truncated', () => {
    const r = draw('<svg><path d="M0 0 L10 10 L20"/></svg>');
    expect(r.skipped).toEqual(['path']);
    expect(r.content).toContain('10 10 l');       // the valid prefix still drew
  });
});

describe('drawSvg — clipPath', () => {
  it('emits the clip geometry followed by W n before the clipped content', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<g clip-path="url(#c)"><rect width="10" height="10"/></g></svg>');
    expect(c).toMatch(/0 0 m[\s\S]*W n[\s\S]*\bf\b/);
  });

  it('does not report a clipPath as an unsupported paint reference', () => {
    const r = draw('<svg><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<rect width="10" height="10" clip-path="url(#c)"/></svg>');
    expect(r.skipped).toEqual([]);
  });

  it('uses the even-odd clip operator when the clip path asks for it', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5" ' +
      'clip-rule="evenodd"/></clipPath></defs>' +
      '<rect width="10" height="10" clip-path="url(#c)"/></svg>');
    expect(c).toContain('W* n');
  });

  it('never paints the clip path geometry itself', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5" fill="red"/></clipPath>' +
      '</defs><rect width="10" height="10" clip-path="url(#c)"/></svg>');
    expect(c).not.toContain('1 0 0 rg');
  });

  it('scopes the clip to the element that carries it', () => {
    const c = body('<svg><defs><clipPath id="c"><rect width="5" height="5"/></clipPath></defs>' +
      '<rect width="10" height="10" clip-path="url(#c)"/><rect width="20" height="20"/></svg>');
    // The clip is inside its own q/Q, so it is popped before the second rect.
    expect(c.indexOf('Q')).toBeGreaterThan(c.indexOf('W n'));
  });

  it('ignores an unresolvable clip-path reference rather than dropping content', () => {
    const r = draw('<svg><rect width="10" height="10" clip-path="url(#missing)"/></svg>');
    expect(r.content).toMatch(/\bf\b/);
    expect(r.skipped).toEqual([]);
  });
});

describe('drawSvg — use', () => {
  it('draws the referenced element in place', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use href="#r"/></svg>');
    expect(c).toMatch(/\bf\b/);
    expect(c).toContain('0 0 m');
  });

  it('offsets by the use x and y', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use href="#r" x="10" y="20"/></svg>');
    expect(c).toContain('1 0 0 1 10 20 cm');
  });

  it('resolves xlink:href, whose prefix xml.ts strips', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use xlink:href="#r"/></svg>');
    expect(c).toMatch(/\bf\b/);
  });

  it('inherits paint from the use site', () => {
    const c = body('<svg><defs><rect id="r" width="4" height="4"/></defs>' +
      '<use href="#r" fill="red"/></svg>');
    expect(c).toContain('1 0 0 rg');
  });

  it('draws a referenced group', () => {
    const c = body('<svg><defs><g id="g"><rect width="4" height="4"/>' +
      '<rect x="5" width="4" height="4"/></g></defs><use href="#g"/></svg>');
    expect((c.match(/\bf\b/g) ?? []).length).toBe(2);
  });

  it('terminates on a self-referencing use instead of hanging', () => {
    const r = draw('<svg><g id="a"><use href="#a"/></g></svg>');
    expect(r.skipped).toContain('use');
  });

  it('terminates on a mutually recursive pair', () => {
    const r = draw('<svg><defs><g id="a"><use href="#b"/></g>' +
      '<g id="b"><use href="#a"/></g></defs><use href="#a"/></svg>');
    expect(r.skipped).toContain('use');
  });

  it('reports a use whose target does not exist', () => {
    const r = draw('<svg><use href="#nope"/></svg>');
    expect(r.skipped).toEqual(['use']);
  });
});

describe('drawSvg — accumulated CTM', () => {
  const probe = (svg: string) =>
    __ctmProbe(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(), noStreams(), noImages());

  it('is identity for a shape at the root', () => {
    expect(probe('<svg><rect width="1" height="1"/></svg>')).toEqual([[1, 0, 0, 1, 0, 0]]);
  });

  it('carries an element transform', () => {
    expect(probe('<svg><rect transform="translate(3 4)" width="1" height="1"/></svg>'))
      .toEqual([[1, 0, 0, 1, 3, 4]]);
  });

  it('composes a nested group transform outermost-last', () => {
    // Inner scale(2) then outer translate(10,0): a point (1,1) in the rect's own
    // space lands at (12, 2).
    const [m] = probe('<svg><g transform="translate(10 0)">' +
      '<g transform="scale(2)"><rect width="1" height="1"/></g></g></svg>');
    expect(m).toEqual([2, 0, 0, 2, 10, 0]);
  });

  it('carries a <use> x/y shift into the target', () => {
    const [m] = probe('<svg><defs><rect id="r" width="1" height="1"/></defs>' +
      '<use href="#r" x="5" y="6"/></svg>');
    expect(m).toEqual([1, 0, 0, 1, 5, 6]);
  });

  it('pops back out of a group for a following sibling', () => {
    const ms = probe('<svg><g transform="translate(10 0)"><rect width="1" height="1"/></g>' +
      '<rect width="1" height="1"/></svg>');
    expect(ms).toEqual([[1, 0, 0, 1, 10, 0], [1, 0, 0, 1, 0, 0]]);
  });
});

describe('drawSvg — gradients', () => {
  const GRAD = '<linearGradient id="g"><stop offset="0" stop-color="red"/>' +
    '<stop offset="1" stop-color="blue"/></linearGradient>';
  const patterns = (svg: string): PdfDict =>
    (draw(svg).resources.get('Pattern') as PdfDict | undefined) ?? new Map();

  it('selects the pattern colour space and scn for a gradient fill', () => {
    const c = body(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(c).toContain('/Pattern cs');
    expect(c).toMatch(/\/P\d+ scn/);
    expect(c).toMatch(/\bf\b/);
    expect(c).not.toContain('rg');
  });

  it('selects the pattern colour space and SCN for a gradient stroke', () => {
    const c = body(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="none" stroke="url(#g)"/></svg>');
    expect(c).toContain('/Pattern CS');
    expect(c).toMatch(/\/P\d+ SCN/);
    expect(c).toMatch(/\bS\b/);
  });

  it('registers the pattern as a direct dict in the walker resources', () => {
    const pats = patterns(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(pats.size).toBe(1);
    const p = [...pats.values()][0] as PdfDict;
    expect(isDict(p)).toBe(true);
    expect(p.get('PatternType')).toBe(2);
  });

  it('does not report a resolved gradient in skipped', () => {
    expect(draw(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>').skipped).toEqual([]);
  });

  it('dedupes one gradient shared by two identically-placed shapes', () => {
    const pats = patterns('<svg><defs>' +
      '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="10">' +
      '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
      '</linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(pats.size).toBe(1);
  });

  it('emits two patterns when the same gradient meets two different boxes', () => {
    const pats = patterns(`<svg><defs>${GRAD}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/>' +
      '<rect width="20" height="4" fill="url(#g)"/></svg>');
    expect(pats.size).toBe(2);
  });

  it('bakes a nested group transform into the pattern /Matrix', () => {
    const pats = patterns(`<svg><defs>${GRAD}</defs>` +
      '<g transform="translate(5 6)"><rect width="10" height="10" fill="url(#g)"/></g></svg>');
    const p = [...pats.values()][0] as PdfDict;
    // obb map [10 0 0 10 0 0] then the group translate.
    expect(p.get('Matrix')).toEqual([10, 0, 0, 10, 5, 6]);
  });

  it('folds a uniform stop-opacity into the ExtGState alpha', () => {
    const svg = '<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(body(svg)).toMatch(/\/GS\d+ gs/);
    const gs = draw(svg).resources.get('ExtGState') as PdfDict;
    expect([...gs.values()].some((v) => (v as PdfDict).get('ca') === 0.5)).toBe(true);
  });

  it('multiplies a uniform stop-opacity by the element fill-opacity', () => {
    const svg = '<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/></svg>';
    const gs = draw(svg).resources.get('ExtGState') as PdfDict;
    expect([...gs.values()].some((v) => (v as PdfDict).get('ca') === 0.25)).toBe(true);
  });

  it('no longer reports a radial reflect spread', () => {
    expect(draw('<svg><defs><radialGradient id="g" spreadMethod="reflect">' +
      '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
      '</radialGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>')
      .skipped).toEqual([]);
  });

  it('paints a solid colour for a one-stop gradient, with no pattern at all', () => {
    const svg = '<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="lime"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(body(svg)).toContain('0 1 0 rg');
    expect(draw(svg).resources.get('Pattern')).toBeUndefined();
  });

  it('paints nothing for a stopless gradient and does not report it', () => {
    const r = draw('<svg><defs><linearGradient id="g"/></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>');
    expect(r.content).not.toMatch(/\b[fB]\b/);
    expect(r.skipped).toEqual([]);
  });

  it('keeps a solid stroke when the gradient fill is suppressed', () => {
    const c = body('<svg><defs><linearGradient id="g"/></defs>' +
      '<rect width="10" height="10" fill="url(#g)" stroke="red"/></svg>');
    expect(c).toContain('1 0 0 RG');
    expect(c).toMatch(/\bS\b/);
  });

  it('never applies a gradient fill to a <line>', () => {
    const svg = `<svg><defs>${GRAD}</defs>` +
      '<line x1="0" y1="0" x2="10" y2="10" fill="url(#g)" stroke="red"/></svg>';
    expect(body(svg)).not.toContain('/Pattern cs');
    expect(draw(svg).resources.get('Pattern')).toBeUndefined();
  });
});

describe('drawSvg — varying stop-opacity', () => {
  const FADE = '<linearGradient id="g">' +
    '<stop offset="0" stop-color="red" stop-opacity="0"/>' +
    '<stop offset="1" stop-color="blue" stop-opacity="1"/></linearGradient>';
  const gstates = (svg: string): PdfDict =>
    (draw(svg).resources.get('ExtGState') as PdfDict | undefined) ?? new Map();

  it('no longer reports a varying stop-opacity', () => {
    expect(draw(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>').skipped).toEqual([]);
  });

  it('references a luminosity soft mask from the ExtGState', () => {
    const svg = `<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)"/></svg>';
    expect(body(svg)).toMatch(/\/GS\d+ gs/);
    const gs = [...gstates(svg).values()][0] as PdfDict;
    const sm = gs.get('SMask') as PdfDict;
    expect(isDict(sm)).toBe(true);
    expect(sm.get('S')).toMatchObject({ name: 'Luminosity' });
    expect(sm.get('G')).toMatchObject({ kind: 'ref' });
    expect(gs.get('ca')).toBe(1);
  });

  it('keeps the element fill-opacity in /ca beside the mask', () => {
    const gs = [...gstates(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)" fill-opacity="0.5"/></svg>')
      .values()][0] as PdfDict;
    expect(gs.get('ca')).toBe(0.5);
    expect(isDict(gs.get('SMask'))).toBe(true);
  });

  it('emits no soft mask for a uniform stop-opacity', () => {
    const gs = [...gstates('<svg><defs><linearGradient id="g">' +
      '<stop offset="0" stop-color="red" stop-opacity="0.5"/>' +
      '<stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/></svg>').values()][0] as PdfDict;
    expect(gs.get('SMask')).toBeUndefined();
  });

  it('splits a masked fill and a solid stroke into two passes', () => {
    const c = body(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)" stroke="lime"/></svg>');
    expect(c).not.toMatch(/\bB\b/);
    expect(c.match(/\bf\b/g)).toHaveLength(1);
    expect(c.match(/\bS\b/g)).toHaveLength(1);
    expect(c.match(/\bq\b/g)).toHaveLength(2);
    // The mask is on the fill pass only: the stroke's own gs must not carry one.
    const [fillHalf, strokeHalf] = c.split(/\bf\b/);
    expect(fillHalf).toMatch(/\/GS\d+ gs/);
    expect(strokeHalf).toContain('0 1 0 RG');
  });

  it('paints one pass when fill and stroke share the same varying gradient', () => {
    const c = body(`<svg><defs>${FADE}</defs>` +
      '<rect width="10" height="10" fill="url(#g)" stroke="url(#g)"/></svg>');
    expect(c.match(/\bB\b/g)).toHaveLength(1);
  });

  it('reports the gradient when a text run cannot split fill from stroke', () => {
    const r = draw(`<svg viewBox="0 0 100 100"><defs>${FADE}</defs>` +
      '<text x="10" y="20" fill="url(#g)" stroke="lime">hi</text></svg>');
    expect(r.skipped).toEqual(['linearGradient']);
    expect(r.content).not.toContain('/SMask');
  });

  it('masks a text run whose fill alone carries the ramp', () => {
    const r = draw(`<svg viewBox="0 0 100 100"><defs>${FADE}</defs>` +
      '<text x="10" y="20" fill="url(#g)">hi</text></svg>');
    expect(r.skipped).toEqual([]);
    const gs = [...((r.resources.get('ExtGState') as PdfDict).values())][0] as PdfDict;
    expect(isDict(gs.get('SMask'))).toBe(true);
  });
});

describe('drawSvg — text', () => {
  it('draws a <text> instead of reporting it', () => {
    const r = draw('<svg viewBox="0 0 100 100"><text x="10" y="20">hi</text></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('BT');
    expect(r.content).toContain('Tj');
  });

  it('does not draw a <text> sitting inside <defs>', () => {
    const r = draw('<svg viewBox="0 0 100 100"><defs><text id="t">hi</text></defs></svg>');
    expect(r.content).not.toContain('BT');
  });

  it('draws a <text> reached through <use>', () => {
    const r = draw('<svg viewBox="0 0 100 100"><defs><text id="t">hi</text></defs>' +
                   '<use href="#t" x="5"/></svg>');
    expect(r.content).toContain('BT');
  });

  it('reports a textPath whose href resolves to nothing', () => {
    // #p is not in this document. The text still draws, on the baseline —
    // visible ink beats silently dropped content — and the loss is reported.
    const r = draw('<svg viewBox="0 0 100 100"><text><textPath href="#p">x</textPath></text></svg>');
    expect(r.skipped).toContain('textPath');
    expect(r.content).toContain('Tj');
  });

  it('applies the element transform to the text as a cm', () => {
    const r = draw('<svg viewBox="0 0 100 100">' +
                   '<g transform="translate(10,20)"><text>hi</text></g></svg>');
    expect(r.content).toContain('1 0 0 1 10 20 cm');
  });

  it('inherits fill from an enclosing group', () => {
    const r = draw('<svg viewBox="0 0 100 100"><g fill="#00ff00"><text>hi</text></g></svg>');
    expect(r.content).toContain('0 1 0 rg');
  });
});

describe('drawSvg — CSS', () => {
  it('applies a class rule and no longer reports the style element', () => {
    const r = draw('<svg><style>.a { fill: red }</style>' +
      '<rect class="a" width="9" height="9"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('1 0 0 rg');
  });

  it('applies a rule declared after the element it styles', () => {
    const c = body('<svg><rect class="a" width="9" height="9"/>' +
      '<style>.a { fill: red }</style></svg>');
    expect(c).toContain('1 0 0 rg');
  });

  it('lets a CSS rule beat a presentation attribute', () => {
    const c = body('<svg><style>rect { fill: red }</style>' +
      '<rect fill="blue" width="9" height="9"/></svg>');
    expect(c).toContain('1 0 0 rg');
  });

  it('lets inline style beat a CSS rule', () => {
    const c = body('<svg><style>rect { fill: red }</style>' +
      '<rect style="fill: lime" width="9" height="9"/></svg>');
    expect(c).toContain('0 1 0 rg');
  });

  it('honours a descendant combinator', () => {
    const c = body('<svg><style>g .a { fill: red }</style>' +
      '<g><rect class="a" width="9" height="9"/></g></svg>');
    expect(c).toContain('1 0 0 rg');
  });

  // clip-path and clip-rule are CSS properties, not just presentation
  // attributes, and used to be read straight off the element (1gg0.23) — so a
  // stylesheet or an inline style was silently ignored, while `mask` and
  // `filter` next to them honoured the cascade.
  const CLIP = '<defs><clipPath id="c"><rect width="5" height="9"/></clipPath></defs>';

  it('applies a clip-path from a CSS rule', () => {
    const c = body(`<svg><style>.a { clip-path: url(#c) }</style>${CLIP}` +
      '<rect class="a" width="9" height="9"/></svg>');
    expect(c).toContain('W n');
  });

  it('applies a clip-path from an inline style', () => {
    const c = body(`<svg>${CLIP}` +
      '<rect style="clip-path: url(#c)" width="9" height="9"/></svg>');
    expect(c).toContain('W n');
  });

  it('lets CSS clip-path:none switch OFF a presentation attribute', () => {
    // The dangerous direction: a stylesheet that removes a clip was ignored,
    // so content the author meant to reveal stayed cropped.
    const c = body(`<svg>${CLIP}` +
      '<rect clip-path="url(#c)" style="clip-path: none" width="9" height="9"/></svg>');
    expect(c).not.toContain('W n');
  });

  it('applies clip-rule from a CSS rule on the clip child', () => {
    // W* n rather than W n: the even-odd clip. The attribute spelling already
    // worked, so only the cascade path is new here.
    const c = body('<svg><style>.r { clip-rule: evenodd }</style>' +
      '<defs><clipPath id="c"><path class="r" d="M0 0 H9 V9 H0 Z"/></clipPath></defs>' +
      '<rect clip-path="url(#c)" width="9" height="9"/></svg>');
    expect(c).toContain('W* n');
  });

  it('reports style when a rule is dropped as unparseable', () => {
    const r = draw('<svg><style>.a:hover { fill: red }</style>' +
      '<rect width="9" height="9"/></svg>');
    expect(r.skipped).toEqual(['style']);
  });

  it('reports style for an at-rule', () => {
    const r = draw('<svg><style>@media print { .a { fill: red } }</style>' +
      '<rect width="9" height="9"/></svg>');
    expect(r.skipped).toEqual(['style']);
  });

  it('reports style for a non-CSS type', () => {
    const r = draw('<svg><style type="text/plain">.a { fill: red }</style>' +
      '<rect width="9" height="9"/></svg>');
    expect(r.skipped).toEqual(['style']);
  });
});

describe('drawSvg — CSS on text and gradients', () => {
  it('applies stylesheet properties to text', () => {
    const r = draw('<svg viewBox="0 0 100 100"><style>text { font-size: 30 }</style>' +
      '<text y="20">hi</text></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('30 Tf');
  });

  it('applies a stylesheet rule to a gradient stop', () => {
    // Asserted differentially against the SAME svg without the rule: the stop
    // colour is buried in a shading function several dicts deep, and any
    // assertion shallow enough to write by hand would also pass on the
    // unstyled output. stop-color defaults to black, so the two must differ.
    const withRule = draw('<svg><style>.s { stop-color: #ff0000 }</style>' +
      '<defs><linearGradient id="g"><stop class="s" offset="0"/>' +
      '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs>' +
      '<rect width="9" height="9" fill="url(#g)"/></svg>');
    const without = draw('<svg>' +
      '<defs><linearGradient id="g"><stop class="s" offset="0"/>' +
      '<stop offset="1" stop-color="#0000ff"/></linearGradient></defs>' +
      '<rect width="9" height="9" fill="url(#g)"/></svg>');
    expect(withRule.skipped).toEqual([]);
    expect(withRule.content).toContain('/Pattern cs');
    const dump = (r: typeof withRule) => JSON.stringify([...r.resources], (_k, v) =>
      v instanceof Map ? [...v] : v);
    expect(dump(withRule)).not.toBe(dump(without));
  });
});

describe('svgdraw — canon', () => {
  it('distinguishes two different references', () => {
    // Without a ref branch both stringify to "[object Object]", so patKey
    // returns the FIRST tile's key for the second and it paints the wrong
    // content. Dormant until tiling patterns put refs in a pattern dict.
    expect(__canon(ref(4))).not.toBe(__canon(ref(5)));
  });

  it('distinguishes a reference from a name and from a number', () => {
    expect(__canon(ref(4))).not.toBe(__canon(name('R4')));
    expect(__canon(ref(4))).not.toBe(__canon(4));
  });

  it('still canonicalizes equal references equally', () => {
    expect(__canon(ref(4))).toBe(__canon(ref(4)));
  });

  it('reaches a reference nested inside a dict', () => {
    const a = new Map([['X', ref(1)]]);
    const b = new Map([['X', ref(2)]]);
    expect(__canon(a)).not.toBe(__canon(b));
  });
});

describe('drawSvg — pattern', () => {
  const P = '<defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse">' +
    '<rect width="2" height="2" fill="red"/></pattern></defs>';

  it('paints a pattern fill and reports nothing', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="url(#p)"/></svg>`);
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('/Pattern cs');
    expect(r.content).toMatch(/\/P\d+ scn/);
  });

  it('registers the tile as a Pattern resource', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="url(#p)"/></svg>`);
    const pat = r.resources.get('Pattern') as PdfDict;
    expect(isDict(pat)).toBe(true);
    expect(pat.size).toBe(1);
  });

  it('does not draw the pattern content at form level', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="url(#p)"/></svg>`);
    expect((r.content.match(/1 0 0 rg/g) ?? []).length).toBe(0);
  });

  it('paints nothing and reports nothing for an empty pattern', () => {
    // SVG mandates the element is not rendered by that paint: an outcome, not
    // a fidelity loss -- the same rule a stopless gradient follows.
    const r = draw('<svg><defs><pattern id="p" width="4" height="4"/></defs>' +
      '<rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).not.toMatch(/\bf\b/);
  });

  it('paints nothing for a zero-sized tile', () => {
    const r = draw('<svg><defs><pattern id="p" width="0" height="4">' +
      '<rect width="1" height="1"/></pattern></defs>' +
      '<rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).not.toMatch(/\bf\b/);
  });

  it('reports a pattern reference cycle instead of hanging', () => {
    const r = draw('<svg><defs><pattern id="p" width="4" height="4" ' +
      'patternUnits="userSpaceOnUse">' +
      '<rect width="2" height="2" fill="url(#p)"/></pattern></defs>' +
      '<rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toContain('pattern');
  });

  it('propagates a loss from inside a tile', () => {
    const r = draw('<svg><defs><pattern id="p" width="4" height="4" ' +
      'patternUnits="userSpaceOnUse"><foreignObject/><rect width="1" height="1"/>' +
      '</pattern></defs><rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toContain('foreignObject');
  });

  it('strokes with a pattern too', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="none" ` +
      'stroke="url(#p)" stroke-width="2"/></svg>');
    expect(r.content).toContain('/Pattern CS');
    expect(r.content).toMatch(/\/P\d+ SCN/);
  });
});

describe('drawSvg — pattern overflow', () => {
  const tile = (overflow: string) =>
    '<svg><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"' +
    (overflow ? ` overflow="${overflow}"` : '') +
    '><rect x="-2" y="-2" width="8" height="8" fill="red"/></pattern></defs>' +
    '<rect width="20" height="20" fill="url(#p)"/></svg>';

  /** The single tile dict handed to the sink. */
  function tileDict(src: string): PdfDict {
    const seen: PdfDict[] = [];
    drawSvg(parseXml(new TextEncoder().encode(src)), VP, fakeProvider(), {
      stream: (d) => { seen.push(d); return ref(seen.length); },
    }, noImages());
    expect(seen.length).toBe(1);
    return seen[0];
  }

  it('clips to the tile box by default', () => {
    const d = tileDict(tile(''));
    expect(d.get('BBox')).toEqual([0, 0, 4, 4]);
    expect(d.get('XStep')).toBe(4);
  });

  it('grows the BBox to the ink under overflow visible, keeping the step', () => {
    // PDF always clips to /BBox, so spilling is expressed by a BBox larger
    // than the step: adjacent cells then overlap.
    const d = tileDict(tile('visible'));
    const b = d.get('BBox') as number[];
    expect(b[0]).toBeLessThanOrEqual(-2);
    expect(b[2]).toBeGreaterThanOrEqual(6);
    expect(d.get('XStep')).toBe(4);        // spacing unchanged
    expect(d.get('YStep')).toBe(4);
  });

  it('leaves the BBox at the tile when overflow visible has no overhang', () => {
    const d = tileDict(
      '<svg><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse" ' +
      'overflow="visible"><rect width="4" height="4"/></pattern></defs>' +
      '<rect width="20" height="20" fill="url(#p)"/></svg>');
    expect(d.get('BBox')).toEqual([0, 0, 4, 4]);
  });
});
