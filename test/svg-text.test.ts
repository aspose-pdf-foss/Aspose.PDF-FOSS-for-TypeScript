import { describe, it, expect } from 'vitest';
import {
  parseFamilies, resolveFamily, std14Face, isBold, isItalic, textMatrix, flattenText,
  placeChars, layoutText, emitGlyphs, glyphsBBox, decorationOps, type TextSink,
} from '../src/svgtext.js';
import { IDENTITY } from '../src/text.js';
import { parseXml } from '../src/xml.js';
import { INITIAL, type Paint } from '../src/svgstyle.js';
import { vmetricsFor } from '../src/textdecor.js';
import { fakeProvider } from './helpers/fake-svg-font.js';

const xml = (s: string) => new TextEncoder().encode(s);
const flatten = (src: string, p = fakeProvider()) =>
  flattenText(parseXml(xml(src)), INITIAL, p, 12);
const place = (src: string) => placeChars(flatten(src));
const lay = (src: string) => layoutText(flatten(src));

/** Map a point from PDF text space through `m`, row-vector convention. */
const apply = (m: number[], x: number, y: number): [number, number] =>
  [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

describe('svgtext — font-family resolution', () => {
  it('splits a CSS family list and strips quotes and space', () => {
    expect(parseFamilies(" 'Segoe UI', Arial , sans-serif "))
      .toEqual(['segoe ui', 'arial', 'sans-serif']);
    expect(parseFamilies(undefined)).toEqual([]);
  });

  it('maps the three generic families', () => {
    expect(resolveFamily(['serif'])).toEqual({ family: 'Times', matched: true });
    expect(resolveFamily(['monospace'])).toEqual({ family: 'Courier', matched: true });
    expect(resolveFamily(['sans-serif'])).toEqual({ family: 'Helvetica', matched: true });
  });

  it('recognizes concrete faces by substring', () => {
    expect(resolveFamily(['times new roman']).family).toBe('Times');
    expect(resolveFamily(['georgia']).family).toBe('Times');
    expect(resolveFamily(['courier new']).family).toBe('Courier');
    expect(resolveFamily(['consolas']).family).toBe('Courier');
    expect(resolveFamily(['helvetica neue']).family).toBe('Helvetica');
  });

  it('takes the first name in the list that matches', () => {
    expect(resolveFamily(['nosuchfont', 'georgia', 'monospace']).family).toBe('Times');
  });

  it('reports no match for a family it cannot place, and still guesses Helvetica', () => {
    // `matched: false` is what lets a caller-supplied embedded handle win, so
    // a concrete face the table does not name must NOT report a match.
    expect(resolveFamily(['wingdings'])).toEqual({ family: 'Helvetica', matched: false });
    expect(resolveFamily(['arial'])).toEqual({ family: 'Helvetica', matched: false });
    expect(resolveFamily([])).toEqual({ family: 'Helvetica', matched: false });
  });

  it('picks the weight and style variant of each family', () => {
    expect(std14Face('Helvetica', false, false)).toBe('Helvetica');
    expect(std14Face('Helvetica', true, false)).toBe('Helvetica-Bold');
    expect(std14Face('Helvetica', false, true)).toBe('Helvetica-Oblique');
    expect(std14Face('Helvetica', true, true)).toBe('Helvetica-BoldOblique');
    expect(std14Face('Times', false, false)).toBe('Times-Roman');
    expect(std14Face('Times', true, true)).toBe('Times-BoldItalic');
    expect(std14Face('Courier', true, false)).toBe('Courier-Bold');
  });

  it('reads font-weight and font-style', () => {
    expect(isBold('bold')).toBe(true);
    expect(isBold('bolder')).toBe(true);
    expect(isBold('600')).toBe(true);
    expect(isBold('500')).toBe(false);
    expect(isBold('normal')).toBe(false);
    expect(isBold(undefined)).toBe(false);
    expect(isItalic('italic')).toBe(true);
    expect(isItalic('oblique')).toBe(true);
    expect(isItalic('normal')).toBe(false);
    expect(isItalic(undefined)).toBe(false);
  });
});

describe('svgtext — the text matrix', () => {
  it('flips y so glyphs are upright in the y-down content stream', () => {
    // d must be NEGATIVE. This is the whole point: PDF text space is y-up and
    // SVG content here is y-down, so without the flip every glyph is mirrored.
    expect(textMatrix(10, 20, 0)).toEqual([1, 0, 0, -1, 10, 20]);
  });

  it('sends the glyph up-vector downward in the y-down space', () => {
    // (0,1) in text space is "up the glyph". In y-down user units that must
    // come out as a NEGATIVE y offset from the origin.
    const [, dy] = apply(textMatrix(0, 0, 0), 0, 1);
    expect(dy).toBeLessThan(0);
  });

  it('keeps the advance direction pointing along +x', () => {
    const [dx, dy] = apply(textMatrix(0, 0, 0), 1, 0);
    expect(dx).toBeCloseTo(1, 12);
    expect(dy).toBeCloseTo(0, 12);
  });

  it('rotates clockwise on screen for a positive angle, as SVG does', () => {
    // rotate(90) makes text read downward. In y-down units the advance
    // direction must therefore become +y.
    const [dx, dy] = apply(textMatrix(0, 0, 90), 1, 0);
    expect(dx).toBeCloseTo(0, 12);
    expect(dy).toBeCloseTo(1, 12);
  });

  it('composes as flip-then-rotate, not rotate-then-flip', () => {
    // The two differ in the sign of b and c. Pinning 180 degrees catches a
    // swapped composition that 0 and 90 would both survive.
    const m = textMatrix(0, 0, 180);
    expect(m[0]).toBeCloseTo(-1, 12);
    expect(m[1]).toBeCloseTo(0, 12);
    expect(m[2]).toBeCloseTo(0, 12);
    expect(m[3]).toBeCloseTo(1, 12);
  });

  it('translates to the requested origin whatever the rotation', () => {
    expect(textMatrix(7, 9, 45).slice(4)).toEqual([7, 9]);
  });
});

describe('svgtext — flattening', () => {
  it('keeps mixed content in source order', () => {
    const f = flatten('<text>Hi <tspan>big</tspan> yo</text>');
    expect(f.chars.map((c) => c.ch).join('')).toBe('Hi big yo');
  });

  it('collapses whitespace by default and trims the element ends', () => {
    const f = flatten('<text>  a \n\t b  </text>');
    expect(f.chars.map((c) => c.ch).join('')).toBe('a b');
  });

  it('keeps whitespace under xml:space="preserve", newlines becoming spaces', () => {
    const f = flatten('<text xml:space="preserve"> a \n b </text>');
    expect(f.chars.map((c) => c.ch).join('')).toBe(' a   b ');
  });

  it('indexes positioning lists AFTER collapsing, not before', () => {
    // "  ab" collapses to "ab", so x applies to 'a' and 'b'. Indexing the
    // uncollapsed string would put x[0] on a space that no longer exists.
    const f = flatten('<text x="10 20">  ab</text>');
    expect(f.chars.map((c) => c.x)).toEqual([10, 20]);
  });

  it("consumes each element's lists against its OWN character index", () => {
    const f = flatten('<text x="0 1">ab<tspan x="50 60">cd</tspan></text>');
    expect(f.chars.map((c) => c.x)).toEqual([0, 1, 50, 60]);
  });

  it("addresses a descendant's characters with an ancestor's list", () => {
    // SVG: an element's x list applies to every character in its subtree, not
    // only its own text. All four characters come from the <text> list here.
    const f = flatten('<text x="0 1 2 3">a<tspan>bc</tspan>d</text>');
    expect(f.chars.map((c) => c.x)).toEqual([0, 1, 2, 3]);
  });

  it('lets an inner tspan override the enclosing list', () => {
    // 'b' is index 1 of <text> and index 0 of the tspan; the tspan wins.
    const f = flatten('<text x="0 1 2 3">a<tspan x="50">bc</tspan>d</text>');
    expect(f.chars.map((c) => c.x)).toEqual([0, 50, 2, 3]);
  });

  it('leaves x undefined past the end of a short list', () => {
    const f = flatten('<text x="5">abc</text>');
    expect(f.chars.map((c) => c.x)).toEqual([5, undefined, undefined]);
  });

  it('repeats the LAST rotate value for the remaining characters', () => {
    // Unique to rotate. dx and friends simply stop applying.
    const f = flatten('<text rotate="10 20">abcd</text>');
    expect(f.chars.map((c) => c.rot)).toEqual([10, 20, 20, 20]);
    const g = flatten('<text dx="1 2">abcd</text>');
    expect(g.chars.map((c) => c.dx)).toEqual([1, 2, undefined, undefined]);
  });

  it('inherits font-size and lets a tspan override it', () => {
    const f = flatten('<text font-size="20">a<tspan font-size="30">b</tspan>c</text>');
    expect(f.chars.map((c) => c.style.size)).toEqual([20, 30, 20]);
  });

  it('passes the resolved font-family list to the provider', () => {
    const p = fakeProvider();
    flatten('<text font-family="Georgia, serif" font-weight="bold">a</text>', p);
    // flattenText asks for a seed face first, so this is not necessarily asks[0].
    expect(p.asks).toContainEqual(['georgia', 'serif']);
  });

  it('inherits fill through the text tree', () => {
    const f = flatten('<text fill="#ff0000">a<tspan>b</tspan></text>');
    expect(f.chars[1].style.paint.fill).toEqual([1, 0, 0]);
  });

  it('resolves dominant-baseline to a shift and text-anchor to a value', () => {
    const f = flatten('<text dominant-baseline="middle" text-anchor="end">a</text>');
    expect(f.chars[0].style.baselineShift).toBeCloseTo(vmetricsFor('Helvetica').xHeight / 2, 9);
    expect(f.chars[0].style.anchor).toBe('end');
  });

  it('flattens a textPath\'s content instead of dropping it', () => {
    const f = flatten('<text>a<textPath href="#p">along</textPath></text>');
    expect(f.chars.map((c) => c.ch).join('')).toBe('aalong');
    // Nothing is reported here: this module cannot tell whether #p resolves,
    // because only svgdraw.ts holds the element index. A dangling href is
    // reported there, and the text still draws on the baseline.
    expect(f.skipped).not.toContain('textPath');
  });

  it('reports a textPath that names no path at all', () => {
    const f = flatten('<text><textPath>along</textPath></text>');
    expect(f.skipped).toContain('textPath');
  });

  it('records method="stretch" without reporting it', () => {
    // Whether stretch can be honoured depends on the faces supplying outlines
    // and on the path resolving, neither of which this module can see — so the
    // flag is recorded here and svgdraw.ts decides and reports.
    const f = flatten('<text><textPath href="#p" method="stretch">a</textPath></text>');
    expect(f.owners[f.chars[0].owner].path!.stretch).toBe(true);
    expect(f.skipped).not.toContain('textPath');
  });

  it('records textLength and lengthAdjust per owning element', () => {
    const f = flatten('<text textLength="100" lengthAdjust="spacingAndGlyphs">ab</text>');
    expect(f.owners[f.chars[0].owner]).toEqual({ textLength: 100, spacingAndGlyphs: true });
  });
});

describe('svgtext — positioning', () => {
  it('advances the cursor by each glyph width', () => {
    // The fake face is 1 em per character, so at font-size 12 that is 12 apart.
    expect(place('<text font-size="12">abc</text>').map((g) => g.x)).toEqual([0, 12, 24]);
  });

  it('sets the cursor absolutely on x and relatively on dx', () => {
    expect(place('<text font-size="10" x="100">ab</text>').map((g) => g.x)).toEqual([100, 110]);
    expect(place('<text font-size="10" dx="0 5">ab</text>').map((g) => g.x)).toEqual([0, 15]);
  });

  it('applies dy cumulatively down the string', () => {
    expect(place('<text dy="0 3 4">abc</text>').map((g) => g.y)).toEqual([0, 3, 7]);
  });

  it('subtracts the baseline shift, because the space is y-down', () => {
    // dominant-baseline: text-before-edge raises the text, which is -y here.
    const g = place('<text font-size="10" dominant-baseline="text-before-edge">a</text>');
    expect(g[0].y).toBeLessThan(0);
  });

  it('starts a new anchored chunk at an absolute x', () => {
    const g = place('<text>ab<tspan x="99">cd</tspan></text>');
    expect(g.map((p) => p.chunk)).toEqual([0, 0, 1, 1]);
  });

  it('starts a new anchored chunk at an absolute y too', () => {
    const g = place('<text>ab<tspan y="99">cd</tspan></text>');
    expect(g.map((p) => p.chunk)).toEqual([0, 0, 1, 1]);
  });

  it('does not start a chunk for a relative dx or dy', () => {
    const g = place('<text>ab<tspan dx="5">cd</tspan></text>');
    expect(g.map((p) => p.chunk)).toEqual([0, 0, 0, 0]);
  });

  it('adds letter-spacing after every glyph', () => {
    expect(place('<text font-size="10" letter-spacing="2">abc</text>').map((g) => g.x))
      .toEqual([0, 12, 24]);
  });

  it('adds word-spacing only after a space', () => {
    const g = place('<text xml:space="preserve" font-size="10" word-spacing="5">a b</text>');
    expect(g.map((p) => p.x)).toEqual([0, 10, 25]);
  });

  it('carries the per-character rotation through', () => {
    expect(place('<text rotate="15">ab</text>').map((g) => g.rot)).toEqual([15, 15]);
  });
});

describe('svgtext — textLength and anchoring', () => {
  it('leaves a start-anchored run where it was placed', () => {
    expect(lay('<text font-size="10">abc</text>').map((g) => g.x)).toEqual([0, 10, 20]);
  });

  it('shifts a middle-anchored chunk by half its advance', () => {
    // 3 glyphs x 10 = 30 wide, so middle moves it back 15.
    expect(lay('<text font-size="10" text-anchor="middle">abc</text>').map((g) => g.x))
      .toEqual([-15, -5, 5]);
  });

  it('shifts an end-anchored chunk by its full advance', () => {
    expect(lay('<text font-size="10" text-anchor="end">abc</text>').map((g) => g.x))
      .toEqual([-30, -20, -10]);
  });

  it('anchors each chunk independently', () => {
    const g = lay('<text font-size="10" text-anchor="end">ab<tspan x="100">cd</tspan></text>');
    expect(g.map((p) => p.x)).toEqual([-20, -10, 80, 90]);
  });

  it("uses the anchor in force at the chunk's FIRST character", () => {
    const g = lay('<text font-size="10">ab<tspan x="50" text-anchor="end">cd</tspan></text>');
    expect(g.map((p) => p.x)).toEqual([0, 10, 30, 40]);
  });

  it('stretches a run to textLength by spacing it out', () => {
    // "ab" is 20 wide naturally; textLength 40 adds 20 across the 1 gap.
    const g = lay('<text font-size="10" textLength="40">ab</text>');
    expect(g.map((p) => p.x)).toEqual([0, 30]);
    expect(g.map((p) => p.hscale)).toEqual([1, 1]);
  });

  it('scales the glyphs too under lengthAdjust="spacingAndGlyphs"', () => {
    const g = lay('<text font-size="10" textLength="40" lengthAdjust="spacingAndGlyphs">ab</text>');
    expect(g.map((p) => p.hscale)).toEqual([2, 2]);
    expect(g.map((p) => p.x)).toEqual([0, 20]);
  });

  it('applies textLength BEFORE the anchor, not after', () => {
    // Natural 20, stretched to 40, then end-anchored: the chunk must span
    // -40..0, not -20..20. Reversing the two gives [-20, 10].
    const g = lay('<text font-size="10" textLength="40" text-anchor="end">ab</text>');
    expect(g.map((p) => p.x)).toEqual([-40, -10]);
  });

  it('ignores a textLength on a single character, which has no gap to spread', () => {
    const g = lay('<text font-size="10" textLength="40">a</text>');
    expect(g.map((p) => p.x)).toEqual([0]);
  });

  it("stretches a descendant's characters too, not just its own", () => {
    // textLength spans the element's whole subtree: 4 glyphs, 3 gaps, natural
    // 40 -> 70 adds 10 per gap.
    const g = lay('<text font-size="10" textLength="70">ab<tspan>cd</tspan></text>');
    expect(g.map((p) => p.x)).toEqual([0, 20, 40, 60]);
  });
});

/** A sink that records operators and reports a fixed paint decision. */
function recSink(fill = true, stroke = false): TextSink & { ops: string[] } {
  const ops: string[] = [];
  return { ops, push: (op) => ops.push(op), setPaint: () => ({ fill, stroke }) };
}

const emit = (src: string, sink = recSink()) => {
  emitGlyphs(lay(src), sink, [...IDENTITY]);
  return sink.ops.join('\n');
};

describe('svgtext — emission', () => {
  it('wraps the run in BT/ET with the flipped text matrix', () => {
    const s = emit('<text font-size="12">ab</text>');
    expect(s).toContain('BT');
    expect(s).toContain('ET');
    expect(s).toMatch(/1 0 0 -1 0 0 Tm/);
    expect(s).toMatch(/\/F 12 Tf/);
  });

  it('emits a single Tj when the glyphs sit at their natural advances', () => {
    const s = emit('<text font-size="10">abc</text>');
    expect(s).toMatch(/\(abc\) Tj/);
    expect(s).not.toContain('TJ');
  });

  it('encodes an irregular gap as a TJ adjustment, not a second Tm', () => {
    // dx pushes 'b' 5 units right of its natural spot. TJ units are 1/1000 em
    // scaled by font size, and a POSITIVE gap is a NEGATIVE adjustment.
    const s = emit('<text font-size="10" dx="0 5">ab</text>');
    expect(s).toContain('TJ');
    expect(s).toMatch(/-500/);
    expect((s.match(/Tm/g) ?? []).length).toBe(1);
  });

  it('starts a new run when the rotation changes', () => {
    const s = emit('<text rotate="0 90">ab</text>');
    expect((s.match(/Tm/g) ?? []).length).toBe(2);
  });

  it('starts a new run when the baseline moves', () => {
    const s = emit('<text dy="0 5">ab</text>');
    expect((s.match(/Tm/g) ?? []).length).toBe(2);
  });

  it('emits Tr 1 for stroke-only and Tr 2 for both', () => {
    expect(emit('<text>a</text>', recSink(false, true))).toContain('1 Tr');
    expect(emit('<text>a</text>', recSink(true, true))).toContain('2 Tr');
  });

  it('emits no text at all when neither fill nor stroke paints', () => {
    const sink = recSink(false, false);
    expect(emitGlyphs(lay('<text>abc</text>'), sink, [...IDENTITY])).toBe(false);
    // A matched q/Q may still be pushed; no glyphs may be.
    expect(sink.ops.join('\n')).not.toContain('BT');
    expect(sink.ops.join('\n')).not.toContain('Tj');
  });

  it('emits an invisible run in rendering mode 3, with no paint at all', () => {
    // Mode 3 is what keeps a stretched textPath extractable behind its vector
    // outlines: the glyphs are shown, so GetText and search find them, but
    // nothing is painted — which is why the sink is never asked for a colour.
    const glyphs = lay('<text font-size="10">ab</text>');
    for (const g of glyphs) g.invisible = true;
    let asked = 0;
    const ops: string[] = [];
    const sink: TextSink = {
      push: (op) => ops.push(op),
      setPaint: () => { asked++; return { fill: true, stroke: false }; },
    };
    expect(emitGlyphs(glyphs, sink, [...IDENTITY])).toBe(true);
    const s = ops.join('\n');
    expect(s).toContain('3 Tr');
    expect(s).toContain('Tj');
    expect(asked).toBe(0);
  });

  it('draws an invisible run even when nothing would paint', () => {
    // recSink(false, false) means "neither fill nor stroke": a visible run would
    // emit nothing, but an invisible one has no paint to be missing.
    const glyphs = lay('<text>abc</text>');
    for (const g of glyphs) g.invisible = true;
    const sink = recSink(false, false);
    expect(emitGlyphs(glyphs, sink, [...IDENTITY])).toBe(true);
    expect(sink.ops.join('\n')).toContain('BT');
  });

  it('never merges a visible glyph with an invisible one', () => {
    const glyphs = lay('<text font-size="10">ab</text>');
    glyphs[1].invisible = true;
    const sink = recSink();
    emitGlyphs(glyphs, sink, [...IDENTITY]);
    expect(sink.ops.join('\n').match(/BT/g)).toHaveLength(2);
  });

  it('folds word-spacing into TJ and never emits Tw', () => {
    // Tw applies only to the single-byte code 32, so under a Type0 Identity-H
    // face it silently does nothing while still looking right in the stream.
    // Folding into TJ is correct for both font kinds, so Tw is never used.
    const s = emit('<text xml:space="preserve" font-size="10" word-spacing="5">a b</text>');
    expect(s).not.toMatch(/\bTw\b/);
    expect(s).toContain('TJ');
  });

  it('folds letter-spacing into TJ and never emits Tc', () => {
    const s = emit('<text font-size="10" letter-spacing="2">abc</text>');
    expect(s).not.toMatch(/\bTc\b/);
    expect(s).toContain('TJ');
  });

  it('emits Tz for a horizontally scaled run', () => {
    const s = emit('<text font-size="10" textLength="40" lengthAdjust="spacingAndGlyphs">ab</text>');
    expect(s).toContain('200 Tz');
  });

  it('measures the ink box from the advances and the vertical metrics', () => {
    // SegBBox is {x, y, w, h} — an origin plus a size, not two corners.
    const g = lay('<text font-size="10">ab</text>');
    const b = glyphsBBox(g)!;
    expect(b.x).toBe(0);
    expect(b.w).toBe(20);
    expect(b.y).toBeLessThan(0);             // ascent is upward, which is -y here
    expect(b.y + b.h).toBeGreaterThan(0);    // descent falls below the baseline
  });

  it('measures fill geometry only — no Paint field reaches the box', () => {
    // objectBoundingBox is fill geometry: svgpath.ts's subtreeBBox inflates no
    // shape by its stroke, and text must match. This is what lets svgdraw's
    // textMeasure seed flattenText with INITIAL rather than with a resolved
    // paint, so it is asserted rather than assumed — a seed differing in every
    // paint field, and the element's own paint attributes, must both leave the
    // box where it was.
    const loud: Paint = {
      ...INITIAL,
      fill: [1, 0, 0], stroke: [0, 0, 1], strokeWidth: 40, dash: [3, 3],
      fillOpacity: 0.1, strokeOpacity: 0.2, lineJoin: 1, miterLimit: 9,
    };
    const src = '<text font-size="10">ab</text>';
    const measure = (seed: Paint, s = src) =>
      glyphsBBox(layoutText(flattenText(parseXml(xml(s)), seed, fakeProvider(), 12)));

    const plain = measure(INITIAL)!;
    expect(measure(loud)).toEqual(plain);
    expect(measure(INITIAL,
      '<text font-size="10" stroke="blue" stroke-width="40" fill-opacity="0.1">ab</text>'))
      .toEqual(plain);
  });
});

describe('svgtext — text-decoration', () => {
  it('draws an underline beneath the glyphs and a strike over them', () => {
    const u = decorationOps(lay('<text font-size="10" text-decoration="underline">ab</text>'));
    expect(u.beneath.join('\n')).toMatch(/re\nf/);
    expect(u.above).toEqual([]);
    const s = decorationOps(lay('<text font-size="10" text-decoration="line-through">ab</text>'));
    expect(s.beneath).toEqual([]);
    expect(s.above.join('\n')).toMatch(/re\nf/);
  });

  // The rule is emitted inside a `cm` carrying textMatrix, so the rect's own
  // coordinates are in the GLYPH frame — y-up — rather than in y-down user
  // space. That is what lets a rule turn with a rotated run, and on a textPath
  // follow the curve. The two assertions below therefore read the opposite sign
  // from the user-space ones they replaced; the ink lands in the same place.
  it('puts the underline BELOW the baseline, a negative y in the glyph frame', () => {
    const ops = decorationOps(lay('<text font-size="10" text-decoration="underline">ab</text>'));
    const m = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re/.exec(ops.beneath.join('\n'))!;
    expect(parseFloat(m[2])).toBeLessThan(0);
  });

  it('puts the overline ABOVE the baseline, a positive y in the glyph frame', () => {
    const ops = decorationOps(lay('<text font-size="10" text-decoration="overline">ab</text>'));
    const m = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re/.exec(ops.beneath.join('\n'))!;
    expect(parseFloat(m[2])).toBeGreaterThan(0);
  });

  it('emits the rule inside the glyph frame, so it turns with the run', () => {
    const flat = decorationOps(lay('<text font-size="10" text-decoration="underline">ab</text>'));
    expect(flat.beneath.join('\n')).toContain('1 0 0 -1 0 0 cm');
  });

  it("spans the run's advance width", () => {
    const ops = decorationOps(lay('<text font-size="10" text-decoration="underline">ab</text>'));
    const m = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re/.exec(ops.beneath.join('\n'))!;
    expect(parseFloat(m[1])).toBeCloseTo(0, 6);
    expect(parseFloat(m[3])).toBeCloseTo(20, 6);
  });

  it('emits nothing when there is no decoration', () => {
    expect(decorationOps(lay('<text>ab</text>'))).toEqual({ beneath: [], above: [] });
  });

  it('inherits the decoration into a tspan', () => {
    const ops = decorationOps(lay('<text text-decoration="underline">a<tspan>b</tspan></text>'));
    expect(ops.beneath.length).toBeGreaterThan(0);
  });
});
