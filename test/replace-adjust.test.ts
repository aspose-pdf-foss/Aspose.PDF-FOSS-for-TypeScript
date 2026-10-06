import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseContentStream } from '../src/content.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildSimpleTextPdf, buildType0Pdf, buildFormTextPdf } from './helpers/build-text-pdf.js';

const open = (stream: string) => Document.Open(buildSimpleTextPdf(stream));
const glyphs = (doc: Document): GlyphEvent[] => {
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (g) => out.push(g) });
  return out;
};
/** The start x of the (first) glyph drawing `ch`. */
const xOf = (doc: Document, ch: string, nth = 0): number => glyphs(doc).filter((g) => g.text === ch)[nth].quad[0];
const operators = (doc: Document): string[] => parseContentStream(doc.Pages[0].Contents).map((o) => o.operator);

// Helvetica AFM advances (1/1000 em): X 667, Y 667, Z 611, W 944, space 278.
const W12 = (units: number) => units * 12 / 1000;

/**
 * The oracle: a follower in the SAME show string moves by exactly the pen
 * change the renderer applies. The same follower drawn in a SEPARATE show
 * operator, positioned where it already was, must land at the same x under
 * `shiftRest` — so the measured delta is checked against the walker's own pen
 * rather than against arithmetic written here.
 */
function oracle(state: string, before: string, find: string, repl: string, after: string) {
  const one = open(`BT /F1 12 Tf ${state} 20 250 Td (${before}${after}) Tj ET`);
  const x0 = xOf(one, after[0]);
  one.Pages[0].ReplaceText(find, repl);
  const want = xOf(one, after[0]);
  const two = open(`BT /F1 12 Tf ${state} 20 250 Td (${before}) Tj ${x0 - 20} 0 Td (${after}) Tj ET`);
  expect(xOf(two, after[0])).toBeCloseTo(x0, 4);
  two.Pages[0].ReplaceText(find, repl, { adjust: 'shiftRest' });
  return { want, got: xOf(two, after[0]) };
}

describe("adjust: 'shiftRest' (u3l5.4)", () => {
  it('moves a separately positioned follower exactly as the pen moves a chained one', () => {
    const { want, got } = oracle('', 'aX', 'X', 'WWW', 'b');
    expect(got).toBeCloseTo(want, 4);
    expect(want).toBeCloseTo(20 + W12(556) + W12(3 * 944), 4);
  });

  it('agrees with the pen under character spacing, word spacing and horizontal scaling', () => {
    const { want, got } = oracle('2 Tc 3 Tw 60 Tz', 'aX', 'X', 'W W', 'b');
    expect(got).toBeCloseTo(want, 4);
  });

  it('agrees with the pen when the replacement is narrower or empty', () => {
    for (const repl of ['', 'i']) {
      const { want, got } = oracle('', 'aX', 'X', repl, 'b');
      expect(got).toBeCloseTo(want, 4);
    }
  });

  it('agrees with the pen under a scaled CTM', () => {
    const doc = (s: string) => open(`2 0 0 2 0 0 cm ${s}`);
    const one = doc('BT /F1 12 Tf 20 100 Td (aXb) Tj ET');
    const x0 = xOf(one, 'b');
    one.Pages[0].ReplaceText('X', 'WW');
    const two = doc(`BT /F1 12 Tf 20 100 Td (aX) Tj ${(x0 / 2) - 20} 0 Td (b) Tj ET`);
    two.Pages[0].ReplaceText('X', 'WW', { adjust: 'shiftRest' });
    expect(xOf(two, 'b')).toBeCloseTo(xOf(one, 'b'), 4);
  });

  it('counts a styled size in the delta', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (b) Tj ET');
    doc.Pages[0].ReplaceText('X', 'Y', { fontSize: 24, adjust: 'shiftRest' });
    expect(xOf(doc, 'b')).toBeCloseTo(60 + W12(667), 4);
  });

  it('counts the TJ kern a match drops', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td [(aX) 100 (Y)] TJ 50 0 Td (b) Tj ET');
    doc.Pages[0].ReplaceText('XY', 'Z', { adjust: 'shiftRest' });
    expect(doc.Pages[0].GetText()).toBe('aZ b');
    expect(xOf(doc, 'b')).toBeCloseTo(70 + W12(611) - W12(667 - 100 + 667), 4);
  });

  it('shifts a follower by READING order, even one drawn before the match', () => {
    const doc = open('BT /F1 12 Tf 60 250 Td (b) Tj ET BT /F1 12 Tf 20 250 Td (aX) Tj ET');
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'shiftRest' });
    expect(xOf(doc, 'b')).toBeCloseTo(60 + W12(3 * 944 - 667), 4);
  });

  it('puts back a chained glyph that READS before the edit', () => {
    // `a` is drawn after X in the same Tj, but a Td-less TJ kern places it
    // left of X on the page: it is not "the rest of the line" and must stay.
    const doc = open('BT /F1 12 Tf 40 250 Td [(X) 3000 (a)] TJ 0 -30 Td (q) Tj ET');
    const a0 = xOf(doc, 'a');
    expect(doc.Pages[0].GetText().startsWith('a')).toBe(true);
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'shiftRest' });
    expect(xOf(doc, 'a')).toBeCloseTo(a0, 4);
  });

  it('moves a later match drawn by its own operator, and what follows it', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (Xb) Tj ET');
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'shiftRest' });
    const d = W12(3 * 944 - 667);
    expect(xOf(doc, 'W', 3)).toBeCloseTo(60 + d, 4);
    expect(xOf(doc, 'b')).toBeCloseTo(60 + d + W12(3 * 944), 4);
  });

  it('leaves other lines alone', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (b) Tj 0 -30 Td (c) Tj ET');
    const c0 = xOf(doc, 'c');
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'shiftRest' });
    expect(xOf(doc, 'c')).toBeCloseTo(c0, 4);
  });

  it('adds nothing where the pen already does the job', () => {
    const a = open('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const b = open('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    a.Pages[0].ReplaceText('X', 'WWW');
    b.Pages[0].ReplaceText('X', 'WWW', { adjust: 'shiftRest' });
    expect(b.Save()).toEqual(a.Save());
  });

  it("is byte-identical to no option under 'none'", () => {
    const s = 'BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (b) Tj ET';
    const a = open(s), b = open(s);
    a.Pages[0].ReplaceText('X', 'WWW');
    b.Pages[0].ReplaceText('X', 'WWW', { adjust: 'none' });
    expect(b.Save()).toEqual(a.Save());
    expect(xOf(b, 'b')).toBeCloseTo(60, 4);
  });

  it('writes a kern into a Tj by making it a TJ', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (b) Tj ET');
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'shiftRest' });
    expect(operators(doc)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'Td', 'TJ', 'ET']);
  });
});

describe("adjust: 'spaceWidth' (u3l5.4)", () => {
  // 10 Tw widens each space to 278*12/1000 + 10 = 13.336pt, half of which —
  // 6.668pt — a gap may give; X -> XX is 8.004pt over three gaps, 2.668 each.
  const WIDE = 'BT /F1 12 Tf 10 Tw 20 250 Td (aX one two end) Tj ET';
  const SPACE = W12(278);

  it('takes the difference out of the gaps after the replacement, keeping the line end', () => {
    const before = open(WIDE);
    const [one, two, end] = ['o', 't', 'd'].map((c) => xOf(before, c));
    const doc = open(WIDE);
    doc.Pages[0].ReplaceText('X', 'XX', { adjust: 'spaceWidth' });
    expect(doc.Pages[0].GetText()).toBe('aXX one two end');
    const delta = W12(667);
    expect(xOf(doc, 'o')).toBeCloseTo(one + delta * 2 / 3, 4);
    expect(xOf(doc, 't')).toBeCloseTo(two + delta / 3, 4);
    expect(xOf(doc, 'd')).toBeCloseTo(end, 4);
  });

  it('widens the gaps freely for a narrower replacement', () => {
    const line = 'BT /F1 12 Tf 20 250 Td (aWWW one two end) Tj ET';
    const end = xOf(open(line), 'd');
    const doc = open(line);
    doc.Pages[0].ReplaceText('WWW', 'i', { adjust: 'spaceWidth' });
    expect(xOf(doc, 'd')).toBeCloseTo(end, 4);
  });

  it('gives at most half of each gap, and shifts the rest of the line by the remainder', () => {
    const line = 'BT /F1 12 Tf 20 250 Td (aX one two end) Tj ET';
    const before = open(line);
    const [one, two, end] = ['o', 't', 'd'].map((c) => xOf(before, c));
    const doc = open(line);
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'spaceWidth' });
    expect(doc.Pages[0].GetText()).toBe('aWWW one two end');
    const delta = W12(3 * 944 - 667), give = SPACE / 2;
    expect(xOf(doc, 'o')).toBeCloseTo(one + delta - give, 4);
    expect(xOf(doc, 't')).toBeCloseTo(two + delta - 2 * give, 4);
    expect(xOf(doc, 'd')).toBeCloseTo(end + delta - 3 * give, 4);
  });

  it('treats a run of spaces as ONE gap, measured whole', () => {
    // Two gaps after X: a double space (6.672pt) and a single (3.336pt). Each
    // gives half the narrowest, so `one` moves back one half-space and `b`
    // two. Counted per SPACE there would be three gaps and `one` would move
    // back two half-spaces. (A lone double space cannot tell the readings
    // apart: per-space, it gives two quarter-gaps of the same total.)
    const line = 'BT /F1 12 Tf 20 250 Td (aX  one b) Tj ET';
    const before = open(line);
    const [o0, b0] = ['o', 'b'].map((c) => xOf(before, c));
    const doc = open(line);
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'spaceWidth' });
    const d = W12(3 * 944 - 667);
    expect(xOf(doc, 'o')).toBeCloseTo(o0 + d - SPACE / 2, 4);
    expect(xOf(doc, 'b')).toBeCloseTo(b0 + d - SPACE, 4);
  });

  it('measures a run of spaces to the glyph after its LAST space', () => {
    // The double space (6.672pt) is the narrowest gap here, the second being a
    // wide inferred one, so it gives half of itself: one whole space each. Its
    // first space alone would measure 3.336 and give half that.
    const line = 'BT /F1 12 Tf 20 250 Td (aX  one) Tj 100 0 Td (b) Tj ET';
    const b0 = xOf(open(line), 'b');
    const doc = open(line);
    doc.Pages[0].ReplaceText('X', 'WWW', { adjust: 'spaceWidth' });
    expect(xOf(doc, 'b')).toBeCloseTo(b0 + W12(3 * 944 - 667) - 2 * SPACE, 4);
  });

  it('counts a gap layout inferred between separately drawn words', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 60 0 Td (end) Tj ET');
    doc.Pages[0].ReplaceText('X', 'XX', { adjust: 'spaceWidth' });
    expect(xOf(doc, 'e')).toBeCloseTo(80, 4);
  });

  it("shifts as 'shiftRest' when no gap follows", () => {
    const a = open('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    const b = open('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    a.Pages[0].ReplaceText('X', 'WWW');
    b.Pages[0].ReplaceText('X', 'WWW', { adjust: 'spaceWidth' });
    expect(xOf(b, 'b')).toBeCloseTo(xOf(a, 'b'), 4);
  });

  it('splits the difference between two edits on one line', () => {
    const line = 'BT /F1 12 Tf 10 Tw 20 250 Td (X a X b end) Tj ET';
    const e0 = xOf(open(line), 'e');
    const doc = open(line);
    doc.Pages[0].ReplaceText('X', 'XX', { adjust: 'spaceWidth' });
    expect(doc.Pages[0].GetText()).toBe('XX a XX b end');
    expect(xOf(doc, 'e')).toBeCloseTo(e0, 4);
  });
});

describe('adjust refusals and validation (u3l5.4)', () => {
  it('refuses vertical text, changing nothing', () => {
    const cmap = '1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfchar <0041> <0041> endbfchar\n';
    const doc = Document.Open(buildType0Pdf('BT /F1 12 Tf 100 250 Td <00410041> Tj ET', cmap, { encoding: 'Identity-V' }));
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('A', '', { adjust: 'shiftRest' })).toThrow(UnsupportedFeatureError);
    expect(doc.Save()).toEqual(before);
    expect(doc.Pages[0].ReplaceText('A', '')).toBe(2);
  });

  it('validates the option', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aXb) Tj ET');
    expect(() => doc.Pages[0].ReplaceText('X', 'Y', { adjust: 'shift' as never })).toThrow(RangeError);
    expect(() => doc.Pages[0].ReplaceText('X', 'Y', { adjust: 1 as never })).toThrow(TypeError);
  });
});

describe('adjust: a Form XObject drawn twice (u3l5.10)', () => {
  // The form shows "aX"; the page draws it twice, each drawing followed on
  // its own line by page text. Replacing X with WWWW widens BOTH drawings, so
  // both tails move — by the drawing's own change, not twice what X removed.
  const FORM = 'BT /F1 12 Tf 20 250 Td (aX) Tj ET';
  const delta = W12(4 * 944 - 667);
  const twice = (secondCm: string) => Document.Open(buildFormTextPdf(
    `q /Fm0 Do Q BT /F1 12 Tf 80 250 Td (tail) Tj ET q ${secondCm} cm /Fm0 Do Q BT /F1 12 Tf 80 150 Td (tail) Tj ET`, FORM));

  it('moves the rest of each drawing\'s line by that drawing\'s change', () => {
    const doc = twice('1 0 0 1 0 -100');
    doc.Pages[0].ReplaceText('X', 'WWWW', { adjust: 'shiftRest' });
    expect(xOf(doc, 't', 0)).toBeCloseTo(80 + delta, 3);
    expect(xOf(doc, 't', 1)).toBeCloseTo(80 + delta, 3);
  });

  it('measures each drawing alone when the two are drawn back to back', () => {
    // Nothing between the two Do's: the second drawing's glyphs follow the
    // first's in the same op, and must not be counted into its edit.
    const doc = Document.Open(buildFormTextPdf(
      'q /Fm0 Do Q q 1 0 0 1 0 -100 cm /Fm0 Do Q BT /F1 12 Tf 80 250 Td (tail) Tj ET BT /F1 12 Tf 80 150 Td (tail) Tj ET', FORM));
    doc.Pages[0].ReplaceText('X', 'WWWW', { adjust: 'shiftRest' });
    expect(xOf(doc, 't', 0)).toBeCloseTo(80 + delta, 3);
    expect(xOf(doc, 't', 1)).toBeCloseTo(80 + delta, 3);
  });

  it('refuses when two drawings on one line would need different kerns in their shared stream', () => {
    const doc = Document.Open(buildFormTextPdf('q /Fm0 Do Q q 1 0 0 1 100 0 cm /Fm0 Do Q', FORM));
    const before = doc.Save();
    expect(() => doc.Pages[0].ReplaceText('X', 'WWWW', { adjust: 'shiftRest' }))
      .toThrow(/Form XObject drawn more than once/);
    expect(doc.Save()).toEqual(before);
  });
});

describe('adjust: region scopes the search, not the line (u3l5.10)', () => {
  it('moves the rest of the line beyond the region edge', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 60 0 Td (tail) Tj ET');
    expect(xOf(doc, 't')).toBeCloseTo(80, 3);
    expect(doc.Pages[0].ReplaceText('X', 'WWWW', { adjust: 'shiftRest', region: [0, 200, 50, 300] })).toBe(1);
    expect(xOf(doc, 't')).toBeCloseTo(80 + W12(4 * 944 - 667), 3);
  });

  it('still finds nothing beyond the region', () => {
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 60 0 Td (tXil) Tj ET');
    expect(doc.Pages[0].ReplaceText('X', 'WWWW', { adjust: 'shiftRest', region: [0, 200, 50, 300] })).toBe(1);
    expect(doc.Pages[0].GetText()).toBe('aWWWW tXil');
  });

  it('does not count a space layout inserted inside a match as a word gap', () => {
    const src = 'BT /F1 12 Tf 20 250 Td (a) Tj 10 0 Td (X) Tj 40 0 Td (b c) Tj ET';
    const doc = open(src);
    expect(doc.Pages[0].GetText()).toBe('a X b c');
    doc.Pages[0].ReplaceText('a X', 'WW', { adjust: 'spaceWidth', region: [0, 200, 50, 300] });
    const whole = open(src);
    whole.Pages[0].ReplaceText('a X', 'WW', { adjust: 'spaceWidth' });
    expect(xOf(doc, 'b')).toBeCloseTo(xOf(whole, 'b'), 4);
  });

  it('takes the word gaps beyond the region under spaceWidth', () => {
    // "aX" then "b c" drawn later; both gaps lie outside the region, and
    // each gives half of the wider W, so b moves and the line end stays.
    const doc = open('BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (b c) Tj ET');
    const b0 = xOf(doc, 'b');
    doc.Pages[0].ReplaceText('X', 'W', { adjust: 'spaceWidth', region: [0, 200, 50, 300] });
    const whole = open('BT /F1 12 Tf 20 250 Td (aX) Tj 40 0 Td (b c) Tj ET');
    whole.Pages[0].ReplaceText('X', 'W', { adjust: 'spaceWidth' });
    expect(xOf(doc, 'b')).toBeCloseTo(xOf(whole, 'b'), 4);
    expect(xOf(doc, 'b')).toBeCloseTo(b0 + W12(944 - 667) / 2, 3);
  });
});
