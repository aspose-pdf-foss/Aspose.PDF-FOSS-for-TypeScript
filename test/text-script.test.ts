import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { markScriptLevel, type TextFragment } from '../src/text.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';
import { buildOtFontFor, buildGpos, buildGdefClasses, markBaseLookup } from './helpers/build-sfnt.js';

/** A horizontal fragment on `baseline`, roughly `size * 0.5` per character. */
function f(text: string, x: number, baseline: number, size: number): TextFragment {
  return {
    text, fontSize: size,
    quad: [x, baseline, x + text.length * size * 0.5, baseline + size],
  };
}

const scripts = (frags: TextFragment[]): (string | undefined)[] => {
  markScriptLevel(frags);
  return frags.map((x) => x.script);
};

describe('markScriptLevel', () => {
  it('marks a smaller raised run as super', () => {
    // 6pt raised 3.3pt off a 10pt baseline — a real superscript's proportions.
    expect(scripts([f('H', 72, 700, 10), f('2', 78, 703.3, 6)]))
      .toEqual([undefined, 'super']);
  });

  it('marks a smaller lowered run as sub', () => {
    expect(scripts([f('H', 72, 700, 10), f('2', 78, 698, 6)]))
      .toEqual([undefined, 'sub']);
  });

  it('marks both on one line', () => {
    expect(scripts([
      f('x', 72, 700, 10), f('2', 78, 703.3, 6),
      f('y', 84, 700, 10), f('3', 90, 698, 6),
    ])).toEqual([undefined, 'super', undefined, 'sub']);
  });

  it('does NOT mark a same-size raised run', () => {
    // This is GPOS mark/cursive positioning, which otemit.ts emits as a Ts for
    // shaped Arabic and Devanagari. Raised, but not a script — and the size
    // requirement is the only thing that distinguishes the two.
    expect(scripts([f('a', 72, 700, 10), f('b', 78, 703, 10)]))
      .toEqual([undefined, undefined]);
  });

  it('does NOT mark a smaller run on the same baseline', () => {
    // Small caps, a smaller inline label — smaller but never moved.
    expect(scripts([f('big', 72, 700, 10), f('sm', 90, 700, 6)]))
      .toEqual([undefined, undefined]);
  });

  it('takes the reference baseline from the dominant-size fragments, not the line box', () => {
    // The line's own quad starts at 698 because the subscript pulled it down.
    // Measuring the shift against that box yields 0 for the subscript and marks
    // nothing; measuring against the 10pt fragments' baseline (700) is correct.
    expect(scripts([f('Hello', 72, 700, 10), f('2', 100, 698, 6)]))
      .toEqual([undefined, 'sub']);
  });

  it('does not mark a lone raised run with nothing to compare against', () => {
    // Its own size IS the dominant size, so there is no drop. Deliberate:
    // precision over recall, the trade docinfer.ts makes with single-item lists.
    expect(scripts([f('2', 72, 704, 6)])).toEqual([undefined]);
  });

  it('treats separate baselines as separate lines', () => {
    // A 6pt run a full line below 10pt text is body text of its own, not a
    // subscript of the line above.
    expect(scripts([f('big', 72, 700, 10), f('small', 72, 680, 6)]))
      .toEqual([undefined, undefined]);
  });

  it('skips vertical runs', () => {
    // axisKeys flips both axes for vertical text, so "raised" is a horizontal
    // offset there and means something else entirely.
    const v: TextFragment[] = [
      { ...f('a', 72, 700, 10), vertical: true },
      { ...f('b', 76, 703.3, 6), vertical: true },
    ];
    expect(scripts(v)).toEqual([undefined, undefined]);
  });

  it('returns quietly for no fragments', () => {
    expect(scripts([])).toEqual([]);
  });
});

const fragsOf = (stream: string): TextFragment[] =>
  Document.Open(buildSimpleTextPdf(stream)).Pages[0].GetTextFragments();

const scriptOf = (frags: TextFragment[], text: string): string | undefined =>
  frags.find((x) => x.text === text)?.script;

describe('sub/superscript through the real pipeline', () => {
  it('detects a Ts-positioned superscript', () => {
    const frags = fragsOf(
      'BT /F1 10 Tf 20 100 Td (H) Tj /F1 6 Tf 3.3 Ts (2) Tj 0 Ts /F1 10 Tf (O) Tj ET',
    );
    expect(scriptOf(frags, '2')).toBe('super');
    expect(scriptOf(frags, 'H')).toBeUndefined();
  });

  it('detects a Tm-positioned superscript with no Ts anywhere', () => {
    // The payoff of the producer-agnostic rule: this is how a great many real
    // producers write a superscript, and a Ts-based rule sees nothing here.
    const frags = fragsOf(
      'BT /F1 10 Tf 20 100 Td (H) Tj ET'
      + ' BT /F1 6 Tf 27 103.3 Td (2) Tj ET'
      + ' BT /F1 10 Tf 31 100 Td (O) Tj ET',
    );
    expect(scriptOf(frags, '2')).toBe('super');
  });

  it('detects a Tm-positioned subscript', () => {
    const frags = fragsOf(
      'BT /F1 10 Tf 20 100 Td (H) Tj ET'
      + ' BT /F1 6 Tf 27 98 Td (2) Tj ET'
      + ' BT /F1 10 Tf 31 100 Td (O) Tj ET',
    );
    expect(scriptOf(frags, '2')).toBe('sub');
  });

  it('leaves ordinary text unmarked', () => {
    const frags = fragsOf('BT /F1 10 Tf 20 100 Td (Hello world) Tj ET');
    expect(frags.every((x) => x.script === undefined)).toBe(true);
  });

  it('does not mark a same-size raised run separated by a gap', () => {
    // THIS is the end-to-end guard for the size rule, and the only one that
    // reaches it. A same-size raised run needs a wide horizontal gap to become
    // its own fragment at all (a shift inside half an em merges into its
    // neighbour), and a shift inside the line tolerance to still count as the
    // same line. 'X' is 10pt raised 3pt after a 41pt gap, which is both.
    // Measured: with the size requirement deleted this comes back 'super'.
    const frags = fragsOf('BT /F1 10 Tf 20 100 Td (word) Tj 60 3 Td (X) Tj ET');
    expect(scriptOf(frags, 'X')).toBeUndefined();
  });
});

describe('GPOS-positioned glyphs are not scripts', () => {
  /** A font whose mark-to-base GPOS lifts gid 3 above base gid 4 — the exact
   *  mechanism that places an Arabic vowel mark, at an unchanged font size.
   *  `mark` is in shape.ts's GPOS_FEATURES, so it actually runs (`curs` is not).
   *
   *  A 400/1000 anchor gives a 4.8pt rise at 12pt, which is a realistic mark
   *  placement. */
  function markFont(): Uint8Array {
    const gpos = buildGpos([markBaseLookup('mark', 3, { x: 0, y: -400 }, 4, { x: 300, y: 0 })]);
    const gdef = buildGdefClasses([[3, 3], [4, 1]]);   // gid3 = mark, gid4 = base
    return buildOtFontFor({ gpos, gdef, cmap: [[0x61, 4], [0x62, 3]] });
  }

  /** **This test is NOT the guard for the size rule** — measured, not assumed.
   *  Deleting the size requirement leaves it green, because a shaped mark never
   *  reaches `markScriptLevel` as a candidate: a rise inside
   *  `fragmentsFromGlyphs`'s baseline tolerance (`max(2, 0.5 * fontSize)`) is
   *  absorbed into the base's fragment, and a rise past it lands on a line of
   *  its own, where a single fragment is never evaluated. What this test does
   *  prove is that shaped output is not mislabelled end to end, which is worth
   *  having on its own. The size rule is pinned by "does NOT mark a same-size
   *  raised run" above and by the gap case in the pipeline block. */
  it('does not mark a shaped run that GPOS raised', () => {
    const doc = Document.Open(buildStampTarget());
    const font = doc.AddFont(markFont(), { shape: true });
    doc.Pages[0].AddText('ab', 20, 100, { font, fontSize: 12, shape: true });
    const round = Document.Open(doc.Save());

    // Guard the guard: the rise must actually be in the stream, or this test
    // would pass on a page where nothing was raised at all.
    const content = new TextDecoder('latin1').decode(round.Pages[0].Contents);
    expect(content).toMatch(/[\d.-]+ Ts/);

    for (const frag of round.Pages[0].GetTextFragments())
      expect(frag.script).toBeUndefined();
  });
});
