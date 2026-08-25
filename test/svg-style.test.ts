import { describe, it, expect } from 'vitest';
import { INITIAL, parseColor, resolveStyle, styleGetter, type Paint } from '../src/svgstyle.js';
import type { CssDecls } from '../src/svgcss.js';

const attrs = (o: Record<string, string>) => new Map(Object.entries(o));
const res = (o: Record<string, string>, parent: Paint = INITIAL) => resolveStyle(parent, attrs(o));

describe('parseColor', () => {
  it('parses 3- and 6-digit hex', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0]);
    expect(parseColor('#ff0000')).toEqual([1, 0, 0]);
    expect(parseColor('#000')).toEqual([0, 0, 0]);
  });

  it('parses rgb() in absolute and percentage form', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual([1, 0, 0]);
  });

  it('clamps out-of-range components', () => {
    expect(parseColor('rgb(300, -20, 0)')).toEqual([1, 0, 0]);
  });

  it('parses named colours case-insensitively', () => {
    expect(parseColor('red')).toEqual([1, 0, 0]);
    expect(parseColor('ReD')).toEqual([1, 0, 0]);
    expect(parseColor('rebeccapurple')).toEqual([0.4, 0.2, 0.6]);
  });

  it('returns null for none and transparent', () => {
    expect(parseColor('none')).toBeNull();
    expect(parseColor('transparent')).toBeNull();
  });

  it('returns undefined for anything it cannot render', () => {
    expect(parseColor('url(#grad)')).toBeUndefined();
    expect(parseColor('not-a-colour')).toBeUndefined();
    expect(parseColor('')).toBeUndefined();
  });
});

describe('resolveStyle — initial values', () => {
  it("starts with SVG's black fill and no stroke", () => {
    expect(INITIAL.fill).toEqual([0, 0, 0]);
    expect(INITIAL.stroke).toBeNull();
    expect(INITIAL.strokeWidth).toBe(1);
    expect(INITIAL.fillRule).toBe('nonzero');
  });
});

describe('resolveStyle — cascade', () => {
  it('reads presentation attributes', () => {
    const { paint } = res({ fill: '#00ff00', stroke: 'blue', 'stroke-width': '3' });
    expect(paint.fill).toEqual([0, 1, 0]);
    expect(paint.stroke).toEqual([0, 0, 1]);
    expect(paint.strokeWidth).toBe(3);
  });

  it('lets an inline style= win over the same presentation attribute', () => {
    const { paint } = res({ fill: 'red', style: 'fill: blue' });
    expect(paint.fill).toEqual([0, 0, 1]);
  });

  it('parses a multi-declaration style with stray whitespace and a trailing ;', () => {
    const { paint } = res({ style: ' fill : red ; stroke-width : 4 ; ' });
    expect(paint.fill).toEqual([1, 0, 0]);
    expect(paint.strokeWidth).toBe(4);
  });

  it('inherits everything not set on the element', () => {
    const parent = res({ fill: 'red', 'stroke-width': '7' }).paint;
    const { paint } = res({ stroke: 'blue' }, parent);
    expect(paint.fill).toEqual([1, 0, 0]);
    expect(paint.strokeWidth).toBe(7);
    expect(paint.stroke).toEqual([0, 0, 1]);
  });

  it('maps linecap, linejoin and fill-rule to their PDF codes', () => {
    expect(res({ 'stroke-linecap': 'round' }).paint.lineCap).toBe(1);
    expect(res({ 'stroke-linecap': 'square' }).paint.lineCap).toBe(2);
    expect(res({ 'stroke-linejoin': 'bevel' }).paint.lineJoin).toBe(2);
    expect(res({ 'fill-rule': 'evenodd' }).paint.fillRule).toBe('evenodd');
  });

  it('parses a dash array and ignores an all-zero one', () => {
    expect(res({ 'stroke-dasharray': '4 2' }).paint.dash).toEqual([4, 2]);
    expect(res({ 'stroke-dasharray': '4,2' }).paint.dash).toEqual([4, 2]);
    expect(res({ 'stroke-dasharray': 'none' }).paint.dash).toEqual([]);
    expect(res({ 'stroke-dasharray': '0 0' }).paint.dash).toEqual([]);
  });

  // These two used to assert the opposite. Group opacity applies to the
  // element's rendered result as a UNIT — a transparency group — so folding it
  // into the per-channel alphas was only ever exact for content that does not
  // overlap itself. svgdraw.ts now owns the choice; see svg-opacity.test.ts.
  it('returns group opacity separately from fill and stroke alpha', () => {
    const r = res({ opacity: '0.5', 'fill-opacity': '0.5' });
    expect(r.groupOpacity).toBeCloseTo(0.5, 9);
    expect(r.paint.fillOpacity).toBeCloseTo(0.5, 9);
    expect(r.paint.strokeOpacity).toBeCloseTo(1, 9);
  });

  it('does not multiply opacity down the tree', () => {
    const parent = res({ opacity: '0.5' }).paint;
    const r = res({ opacity: '0.5' }, parent);
    // Each element reports its OWN opacity; nesting composes by nesting groups,
    // not by multiplying an inherited alpha.
    expect(r.groupOpacity).toBeCloseTo(0.5, 9);
    expect(r.paint.fillOpacity).toBeCloseTo(1, 9);
  });

  it('reports a url() paint and falls back to none', () => {
    const { paint, refs } = res({ fill: 'url(#grad)' });
    expect(refs).toEqual(['grad']);
    expect(paint.fill).toBeNull();          // never black
  });

  it('honours an explicit fallback colour after a url()', () => {
    const { paint, refs } = res({ fill: 'url(#grad) red' });
    expect(refs).toEqual(['grad']);
    expect(paint.fill).toEqual([1, 0, 0]);
  });

  it('leaves an unparseable value inherited rather than guessing', () => {
    const parent = res({ fill: 'red' }).paint;
    const { paint } = res({ fill: 'not-a-colour' }, parent);
    expect(paint.fill).toEqual([1, 0, 0]);
  });
});

describe('resolveStyle — paint references', () => {
  it('records a url() fill id and leaves the fill unpainted with no fallback', () => {
    const { paint, refs } = res({ fill: 'url(#g)' });
    expect(paint.fillRef).toBe('g');
    expect(paint.fill).toBeNull();
    expect(refs).toEqual(['g']);
  });

  it('keeps the explicit fallback colour alongside the reference', () => {
    const { paint } = res({ fill: 'url(#g) red' });
    expect(paint.fillRef).toBe('g');
    expect(paint.fill).toEqual([1, 0, 0]);
  });

  it('records a url() stroke id independently of the fill', () => {
    const { paint } = res({ stroke: 'url(#s)', fill: 'blue' });
    expect(paint.strokeRef).toBe('s');
    expect(paint.fillRef).toBeNull();
    expect(paint.fill).toEqual([0, 0, 1]);
  });

  it('clears an inherited reference when the child names a solid colour', () => {
    const parent = res({ fill: 'url(#g)' }).paint;
    const { paint } = res({ fill: 'green' }, parent);
    expect(paint.fillRef).toBeNull();
    expect(paint.fill).toEqual([0, 0.5019607843137255, 0]);
  });

  it('inherits a reference when the child declares no fill at all', () => {
    const parent = res({ fill: 'url(#g)' }).paint;
    expect(res({ stroke: 'red' }, parent).paint.fillRef).toBe('g');
  });

  it('reads a reference out of inline style=, which beats the attribute', () => {
    expect(res({ fill: 'red', style: 'fill: url(#g)' }).paint.fillRef).toBe('g');
  });

  it('drops to none when a reference carries an unparseable fallback', () => {
    const { paint } = res({ fill: 'url(#g) notacolour' });
    expect(paint.fillRef).toBe('g');
    expect(paint.fill).toBeNull();
  });

  it('INITIAL carries no references', () => {
    expect(INITIAL.fillRef).toBeNull();
    expect(INITIAL.strokeRef).toBeNull();
  });
});

describe('styleGetter', () => {
  it('prefers an inline style declaration over the presentation attribute', () => {
    const g = styleGetter(new Map([['stop-color', 'red'], ['style', 'stop-color: blue']]));
    expect(g('stop-color')).toBe('blue');
  });

  it('falls back to the attribute and returns undefined for an absent property', () => {
    const g = styleGetter(new Map([['offset', '50%']]));
    expect(g('offset')).toBe('50%');
    expect(g('stop-opacity')).toBeUndefined();
  });
});

const css = (normal: Record<string, string>, important: Record<string, string> = {}): CssDecls =>
  ({ normal: new Map(Object.entries(normal)), important: new Map(Object.entries(important)) });

describe('svgstyle — the CSS cascade', () => {
  it('falls back to a presentation attribute when nothing else sets it', () => {
    expect(styleGetter(attrs({ fill: 'red' }), css({}))('fill')).toBe('red');
  });

  it('lets a CSS rule beat a presentation attribute', () => {
    // Presentation attributes are specificity-0 declarations at the START of
    // the author sheet, so ANY matching rule outranks them.
    expect(styleGetter(attrs({ fill: 'red' }), css({ fill: 'blue' }))('fill')).toBe('blue');
  });

  it('lets inline style beat a CSS rule', () => {
    expect(styleGetter(attrs({ style: 'fill: green' }), css({ fill: 'blue' }))('fill'))
      .toBe('green');
  });

  it('lets a CSS !important beat inline style', () => {
    expect(styleGetter(attrs({ style: 'fill: green' }), css({}, { fill: 'blue' }))('fill'))
      .toBe('blue');
  });

  it('lets an inline !important beat a CSS !important', () => {
    expect(styleGetter(attrs({ style: 'fill: green !important' }), css({}, { fill: 'blue' }))('fill'))
      .toBe('green');
  });

  it('behaves exactly as before when no stylesheet is supplied', () => {
    expect(styleGetter(attrs({ fill: 'red', style: 'fill: green' }))('fill')).toBe('green');
    expect(styleGetter(attrs({ fill: 'red' }))('fill')).toBe('red');
  });

  it('reaches resolveStyle, not just the getter', () => {
    expect(resolveStyle(INITIAL, attrs({ fill: 'red' }), css({ fill: 'blue' })).paint.fill)
      .toEqual([0, 0, 1]);
  });
});

describe('resolveStyle — marker properties', () => {
  it('defaults to null', () => {
    const { paint } = res({});
    expect(paint.markerStart).toBeNull();
    expect(paint.markerMid).toBeNull();
    expect(paint.markerEnd).toBeNull();
  });

  it('reads the three longhands', () => {
    const { paint } = res({
      'marker-start': 'url(#a)', 'marker-mid': 'url(#b)', 'marker-end': 'url(#c)',
    });
    expect(paint.markerStart).toBe('a');
    expect(paint.markerMid).toBe('b');
    expect(paint.markerEnd).toBe('c');
  });

  it('sets all three from the marker shorthand', () => {
    const { paint } = res({ marker: 'url(#a)' });
    expect([paint.markerStart, paint.markerMid, paint.markerEnd]).toEqual(['a', 'a', 'a']);
  });

  it('lets a longhand outrank the shorthand on the same element', () => {
    const { paint } = res({ marker: 'url(#a)', 'marker-end': 'url(#z)' });
    expect(paint.markerStart).toBe('a');
    expect(paint.markerEnd).toBe('z');
  });

  it('inherits from the parent', () => {
    const { paint: parent } = res({ 'marker-mid': 'url(#b)' });
    const { paint } = res({}, parent);
    expect(paint.markerMid).toBe('b');
  });

  it('lets none clear an inherited value', () => {
    const { paint: parent } = res({ 'marker-mid': 'url(#b)' });
    const { paint } = res({ 'marker-mid': 'none' }, parent);
    expect(paint.markerMid).toBeNull();
  });

  it('honours an inline style over the attribute', () => {
    const { paint } = res({ 'marker-end': 'url(#a)', style: 'marker-end:url(#z)' });
    expect(paint.markerEnd).toBe('z');
  });

  it('does NOT add a marker id to refs — it is not a paint server', () => {
    const { refs } = res({ 'marker-end': 'url(#a)' });
    expect(refs).toEqual([]);
  });
});
