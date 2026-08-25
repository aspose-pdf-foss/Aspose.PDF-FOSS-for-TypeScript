import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { drawSvg } from '../src/svgdraw.js';
import { ref } from '../src/types.js';
import { fakeProvider } from './helpers/fake-svg-font.js';
import {
  measurePath, pointAt, placeAt, reverseMetrics, mapGlyphsToPath,
} from '../src/svgtextpath.js';
import type { PlacedGlyph, SvgTextStyle } from '../src/svgtext.js';
import { parsePath } from '../src/svgpath.js';

const segsOf = (d: string) => parsePath(d).segs;

const VP = { minX: 0, minY: 0, w: 200, h: 200 };
const noStreams = () => { let n = 0; return { stream: () => ref(++n) }; };
const noImages = () => { let n = 100; return { image: () => ref(++n) }; };

const draw = (svg: string) =>
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider(),
    noStreams(), noImages());

/** The same, with a provider whose faces CAN supply outlines — the only
 *  difference that lets method="stretch" be honoured rather than fall back. */
const drawStretch = (svg: string) =>
  drawSvg(parseXml(new TextEncoder().encode(svg)), VP, fakeProvider({ outline: true }),
    noStreams(), noImages());
const body = (svg: string) => draw(svg).content;

describe('text decoration follows the glyph rotation', () => {
  // The rule is emitted in the glyph frame, so it carries textMatrix as a `cm`
  // and the rect is local. Helvetica's underlineOffset is -0.1 em, so at 16pt
  // the local y is -0.1*16 - 0.8/2 = -2.
  it('places the same geometry at rot 0', () => {
    const c = body('<svg><text x="0" y="50" text-decoration="underline">Hi</text></svg>');
    expect(c).toContain('1 0 0 -1 0 50 cm');
    expect(c).toContain('0 -2 32 0.8 re');
    // Equivalent to the absolute rect this used to emit: under [1 0 0 -1 0 50],
    // local y [-2, -1.2] maps to user y [51.2, 52] — exactly `0 51.2 32 0.8 re`.
  });

  it('rotates the rule with the run', () => {
    const c = body(
      '<svg><text x="0" y="50" rotate="90" text-decoration="underline">Hi</text></svg>');
    expect(c).toContain('0 1 1 0 0 50 cm');
    expect(c).toContain('0 -2 32 0.8 re');
  });
});

describe('measurePath / pointAt', () => {
  it('measures a straight line', () => {
    const m = measurePath(segsOf('M0 0 L100 0'));
    expect(m.total).toBeCloseTo(100, 9);
    expect(m.pts.length).toBe(2);
  });

  it('measures a polyline as the sum of its legs', () => {
    const m = measurePath(segsOf('M0 0 L30 0 L30 40'));
    expect(m.total).toBeCloseTo(70, 9);
  });

  it('drops zero-length legs rather than storing duplicate vertices', () => {
    const m = measurePath(segsOf('M0 0 L0 0 L10 0'));
    expect(m.total).toBeCloseTo(10, 9);
    expect(m.pts.length).toBe(2);
  });

  it('interpolates a point and its angle along a line', () => {
    const m = measurePath(segsOf('M0 0 L100 0'));
    const p = pointAt(m, 25)!;
    expect(p.x).toBeCloseTo(25, 9);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.angle).toBeCloseTo(0, 9);
  });

  it('reports 90 degrees on a downward line (y is down here)', () => {
    const m = measurePath(segsOf('M10 0 L10 50'));
    const p = pointAt(m, 20)!;
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(20, 9);
    expect(p.angle).toBeCloseTo(90, 9);
  });

  it('returns null past either end', () => {
    const m = measurePath(segsOf('M0 0 L100 0'));
    expect(pointAt(m, -0.5)).toBeNull();
    expect(pointAt(m, 100.5)).toBeNull();
    expect(pointAt(m, 0)).not.toBeNull();
    expect(pointAt(m, 100)).not.toBeNull();
  });

  it('flattens a cubic close to its analytic length', () => {
    // A cubic approximation of a quarter circle of radius 100: arc length is
    // pi*100/2 ~ 157.08. The standard control offset is k = 0.5522847498.
    const k = 55.22847498;
    const m = measurePath(segsOf(`M0 0 C${k} 0 100 ${100 - k} 100 100`));
    expect(m.total).toBeGreaterThan(155);
    expect(m.total).toBeLessThan(159);
  });

  it('closes a subpath on Z', () => {
    const m = measurePath(segsOf('M0 0 L10 0 L10 10 Z'));
    expect(m.total).toBeCloseTo(10 + 10 + Math.hypot(10, 10), 9);
  });

  it('concatenates subpaths, the jump contributing no length', () => {
    const m = measurePath(segsOf('M0 0 L10 0 M50 0 L60 0'));
    expect(m.total).toBeCloseTo(20, 9);
    // Just past the first subpath the angle must come from real geometry, not
    // from the zero-length jump.
    expect(pointAt(m, 10)!.angle).toBeCloseTo(0, 9);
  });

  it('reverseMetrics walks the same geometry backwards', () => {
    const m = reverseMetrics(measurePath(segsOf('M0 0 L100 0')));
    expect(m.total).toBeCloseTo(100, 9);
    const p = pointAt(m, 25)!;
    expect(p.x).toBeCloseTo(75, 9);
    expect(Math.abs(p.angle)).toBeCloseTo(180, 9);
  });

  it('returns null for a path with no extent', () => {
    expect(pointAt(measurePath(segsOf('M5 5')), 0)).toBeNull();
  });
});

describe('placeAt', () => {
  // A path running straight DOWN: the tangent is +90 degrees in y-down space,
  // so the normal (-sin, cos) is (-1, 0) — a positive perp moves LEFT, which is
  // the same "further down the page at angle 0" convention the layout uses.
  const down = measurePath(segsOf('M100 20 L100 120'));

  it('walks the distance along the path', () => {
    const p = placeAt(down, 30, 0)!;
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(50, 6);
    expect(p.angle).toBeCloseTo(90, 6);
  });

  it('displaces perpendicular to the tangent', () => {
    const p = placeAt(down, 30, 10)!;
    expect(p.x).toBeCloseTo(90, 6);        // +perp is left of a downward tangent
    expect(p.y).toBeCloseTo(50, 6);
  });

  it('is null past either end', () => {
    expect(placeAt(down, -1, 0)).toBeNull();
    expect(placeAt(down, 101, 0)).toBeNull();
  });
});

/** A minimal PlacedGlyph. Only x/y/adv/rot/chain matter to the mapper, so the
 *  style is a cast rather than a real face — building one would test the font
 *  provider, not the mapping. */
const g = (x: number, adv: number, y = 0): PlacedGlyph => ({
  ch: 'x', x, y, rot: 0, adv, chunk: 0, hscale: 1, chain: [0], owner: 0,
  style: undefined as unknown as SvgTextStyle,
});

describe('mapGlyphsToPath', () => {
  const line = measurePath(segsOf('M0 0 L100 0'));

  it('places a glyph by the MIDPOINT of its advance', () => {
    // Midpoint at 0 + 5 = 5, so the origin backs off 5 to land at x = 0.
    const [out] = mapGlyphsToPath([g(0, 10)], () => true, line, 0);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.rot).toBeCloseTo(0, 9);
  });

  it('adds startOffset along the path', () => {
    const [out] = mapGlyphsToPath([g(0, 10)], () => true, line, 20);
    expect(out.x).toBeCloseTo(20, 9);
  });

  it('rotates to the tangent and keeps y as a perpendicular offset', () => {
    const down = measurePath(segsOf('M10 0 L10 100'));
    // Midpoint at 5 -> point (10, 5); origin backs off 5 along the tangent to
    // (10, 0); y = 3 displaces along the normal (-sin, cos) = (-1, 0).
    const [out] = mapGlyphsToPath([g(0, 10, 3)], () => true, down, 0);
    expect(out.x).toBeCloseTo(7, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(out.rot).toBeCloseTo(90, 9);
  });

  it('drops a glyph whose midpoint runs off the end', () => {
    const out = mapGlyphsToPath([g(0, 10), g(200, 10)], () => true, line, 0);
    expect(out.length).toBe(1);
    expect(out[0].x).toBeCloseTo(0, 9);
  });

  it('drops a glyph pushed before the start by a negative offset', () => {
    const out = mapGlyphsToPath([g(0, 10)], () => true, line, -50);
    expect(out.length).toBe(0);
  });

  it('leaves non-member glyphs untouched and in place', () => {
    const off = g(70, 10);
    const out = mapGlyphsToPath([g(0, 10), off], (x) => x !== off, line, 0);
    expect(out.length).toBe(2);
    expect(out[1]).toBe(off);
    expect(off.x).toBe(70);
    expect(off.rot).toBe(0);
  });

  it('adds the tangent to any rotate= the author already applied', () => {
    const down = measurePath(segsOf('M10 0 L10 100'));
    const one = g(0, 10);
    one.rot = 15;
    const [out] = mapGlyphsToPath([one], () => true, down, 0);
    expect(out.rot).toBeCloseTo(105, 9);
  });
});

describe('<textPath> reaches the layout', () => {
  const P = '<defs><path id="p" d="M0 0 L500 0"/></defs>';

  it('no longer discards the characters', () => {
    expect(draw(`<svg>${P}<text><textPath href="#p">Hi</textPath></text></svg>`)
      .content).toContain('Tj');
  });

  it('no longer reports textPath merely for existing', () => {
    expect(draw(`<svg>${P}<text><textPath href="#p">Hi</textPath></text></svg>`)
      .skipped).not.toContain('textPath');
  });

  it('still reports an unresolvable reference, and draws the text anyway', () => {
    const r = draw('<svg><text><textPath href="#nope">Hi</textPath></text></svg>');
    expect(r.skipped).toContain('textPath');
    expect(r.content).toContain('Tj');
  });

  it('gives the textPath its own anchored chunk', () => {
    // text-anchor=end would, in one shared chunk, shift both runs by the
    // combined width. fakeProvider makes every glyph 1 em wide, so at the
    // default 16pt the "AAAA" chunk is 64 wide and "BB" is 32. Sharing a chunk
    // would put the first run's origin at -96 instead of -64.
    const c = draw(`<svg>${P}<text x="0" y="10" text-anchor="end">AAAA` +
      '<textPath href="#p">BB</textPath></text></svg>').content;
    expect(c).toContain('-64 ');
    expect(c).not.toContain('-96 ');
  });
});

/** Every `Tm` operand row in the content, as arrays of numbers.
 *
 *  The character class admits `e`/`E` and `+`: cos(90) is 6.1e-17 rather than a
 *  clean zero, and if `num` ever emits that in exponent form a stricter regex
 *  would silently match nothing and every assertion here would vacuously pass. */
function textMatrices(svg: string): number[][] {
  return [...body(svg).matchAll(/^([-+\d.eE ]+) Tm$/gm)]
    .map((m) => m[1].trim().split(/\s+/).map(Number));
}

const DOWN = '<defs><path id="p" d="M50 0 L50 500"/></defs>';

describe('textPath geometry', () => {
  it('emits one Tm per glyph, since each carries its own tangent', () => {
    expect(textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p">abc</textPath></text></svg>').length).toBe(3);
  });

  it('rotates the glyphs onto a downward path', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p">a</textPath></text></svg>');
    // textMatrix(x, y, 90) = [cos, sin, sin, -cos] = [0, 1, 1, 0].
    expect(m[0][0]).toBeCloseTo(0, 6);
    expect(m[0][1]).toBeCloseTo(1, 6);
    expect(m[0][4]).toBeCloseTo(50, 6);   // x pinned to the path
  });

  it('honours startOffset', () => {
    const at = (off: string) => textMatrices(`<svg>${DOWN}` +
      `<text><textPath href="#p" startOffset="${off}">a</textPath></text></svg>`)[0][5];
    expect(at('40') - at('0')).toBeCloseTo(40, 6);
  });

  it('reads startOffset as a percentage of path length', () => {
    const at = (off: string) => textMatrices(`<svg>${DOWN}` +
      `<text><textPath href="#p" startOffset="${off}">a</textPath></text></svg>`)[0][5];
    expect(at('10%')).toBeCloseTo(at('50'), 6);
  });

  it('accepts SVG 2 inline path data', () => {
    const m = textMatrices('<svg><text>' +
      '<textPath path="M50 0 L50 500">a</textPath></text></svg>');
    expect(m[0][1]).toBeCloseTo(1, 6);
    expect(m[0][4]).toBeCloseTo(50, 6);
  });

  it('walks the path backwards for side="right"', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p" side="right">a</textPath></text></svg>');
    // Reversed, the tangent is -90: textMatrix = [0, -1, -1, 0].
    expect(m[0][1]).toBeCloseTo(-1, 6);
  });

  it('drops glyphs that run off the end', () => {
    // fakeProvider glyphs are 1 em = 16 wide, so only the first midpoint (8)
    // is on a 20-long path; the second (24) is past it.
    const m = textMatrices('<svg><defs><path id="s" d="M0 0 L20 0"/></defs>' +
      '<text><textPath href="#s">abc</textPath></text></svg>');
    expect(m.length).toBe(1);
  });

  it('renders nothing for a path with no extent, and does not report it', () => {
    const r = draw('<svg><defs><path id="z" d="M5 5"/></defs>' +
      '<text><textPath href="#z">abc</textPath></text></svg>');
    expect(r.content).not.toContain('Tj');
    expect(r.skipped).not.toContain('textPath');
  });

  it('warps the outlines, and shows the run invisibly so it stays extractable', () => {
    // The one assertion that catches a stretched run being marked visible: it
    // would then paint twice — the warped outlines AND upright glyphs over them
    // — which still looks right in a raster and still extracts, so only the
    // rendering mode tells the two apart.
    const r = drawStretch(`<svg>${DOWN}` +
      '<text font-size="10"><textPath href="#p" method="stretch">ab</textPath></text></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).toMatch(/ l\n/);       // warped contours, as path geometry
    expect(r.content).toContain('3 Tr');     // the invisible layer
    expect(r.content).toContain('Tj');
  });

  it('still reports method="stretch" when the face has no outlines', () => {
    // fakeProvider supplies no outline, which is the align fallback.
    const r = draw(`<svg>${DOWN}` +
      '<text><textPath href="#p" method="stretch">a</textPath></text></svg>');
    expect(r.skipped).toContain('textPath');
    expect(r.content).toContain('Tj');
  });

  it('does not report spacing="auto"', () => {
    const r = draw(`<svg>${DOWN}` +
      '<text><textPath href="#p" spacing="auto">a</textPath></text></svg>');
    expect(r.skipped).not.toContain('textPath');
  });

  it('leaves text outside the textPath on the baseline', () => {
    const m = textMatrices(`<svg>${DOWN}` +
      '<text x="0" y="10">A<textPath href="#p">b</textPath></text></svg>');
    // The unmapped "A" keeps the upright matrix; the mapped "b" does not.
    expect(m.some((r) => r[0] === 1 && r[1] === 0)).toBe(true);
    expect(m.some((r) => Math.abs(r[1] - 1) < 1e-6)).toBe(true);
  });

  it('ignores the referenced path element own transform', () => {
    const m = textMatrices(
      '<svg><defs><path id="t" d="M50 0 L50 500" transform="translate(90 0)"/></defs>' +
      '<text><textPath href="#t">a</textPath></text></svg>');
    expect(m[0][4]).toBeCloseTo(50, 6);
  });
});

describe('absolute x/y do not apply inside a textPath', () => {
  it('ignores an enclosing <text y=>, which would be a perpendicular offset', () => {
    // Found by the render test: with y honoured, the whole run is thrown 150
    // units clear of the path it names. Only dx/dy may offset path text.
    const at = (attrs: string) => textMatrices(`<svg>${DOWN}` +
      `<text ${attrs}><textPath href="#p">a</textPath></text></svg>`)[0];
    expect(at('x="10" y="150"')).toEqual(at(''));
  });

  it('still honours dy as a perpendicular offset', () => {
    const plain = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p">a</textPath></text></svg>')[0];
    const shifted = textMatrices(`<svg>${DOWN}` +
      '<text><textPath href="#p" dy="7">a</textPath></text></svg>')[0];
    // On a downward path the normal is (-1, 0), so +dy moves -x.
    expect(shifted[4]).toBeCloseTo(plain[4] - 7, 6);
  });

  it('leaves absolute x/y working outside a textPath', () => {
    const m = textMatrices('<svg><text x="30" y="40">a</text></svg>')[0];
    expect(m[4]).toBeCloseTo(30, 6);
    expect(m[5]).toBeCloseTo(40, 6);
  });
});
