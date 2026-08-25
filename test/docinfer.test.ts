import { describe, it, expect } from 'vitest';
import {
  classifyBlock, isCodeLine, markerOf, pageMetrics, parseMarkerText,
  splitLineLinks,
  type ClassifyContext,
} from '../src/docinfer.js';
import type { TextBlock, TextFragment, TextLine } from '../src/text.js';

/** A fragment at x0..x1 on baseline y. */
export function frag(
  text: string, x0: number, x1: number, y = 100, fontSize = 10, fontName = 'Helvetica',
): TextFragment {
  return { text, quad: [x0, y, x1, y + fontSize], fontSize, fontName };
}

/** A line from fragments, built exactly as `extractStructured`'s closeLine builds
 *  one: the quad is their bounding box, and the text is their concatenation with
 *  a synthesized space wherever the gap exceeds 0.25 x the font size. That space
 *  belongs to no fragment, which is why `contentX` allows the fragment boundary
 *  one character of slack — a helper that merely joined would move text indices
 *  out of step with the code under test. */
export function line(...fragments: TextFragment[]): TextLine {
  let text = '';
  let prevEndX: number | undefined;
  for (const f of fragments) {
    if (prevEndX !== undefined && f.quad[0] - prevEndX > 0.25 * f.fontSize
        && !text.endsWith(' ') && !f.text.startsWith(' ')) text += ' ';
    text += f.text;
    prevEndX = f.quad[2];
  }
  return {
    text,
    quad: [
      Math.min(...fragments.map((f) => f.quad[0])), Math.min(...fragments.map((f) => f.quad[1])),
      Math.max(...fragments.map((f) => f.quad[2])), Math.max(...fragments.map((f) => f.quad[3])),
    ],
    fragments,
  };
}

describe('docinfer — the marker grammar', () => {
  it('reads every bullet character as an unordered marker', () => {
    for (const b of ['•', '◦', '▪', '‣', '-', '*', '+']) {
      const m = parseMarkerText(`${b} item`);
      expect(m, b).toBeDefined();
      expect(m!.marker.ordered).toBe(false);
      expect(m!.length).toBe(2);
    }
  });

  it('reads decimal, parenthesized, roman and alpha ordinals', () => {
    expect(parseMarkerText('1. a')!.marker).toEqual({ ordered: true, ordinal: 1 });
    expect(parseMarkerText('(3) a')!.marker).toEqual({ ordered: true, ordinal: 3 });
    expect(parseMarkerText('iv. a')!.marker).toEqual({ ordered: true });
    expect(parseMarkerText('b) a')!.marker).toEqual({ ordered: true });
  });

  it('reads the two task boxes', () => {
    expect(parseMarkerText('☐ todo')!.marker).toEqual({ ordered: false, checked: false });
    expect(parseMarkerText('☑ done')!.marker).toEqual({ ordered: false, checked: true });
  });

  it('accepts a marker with nothing after it — an empty item is legitimate', () => {
    expect(parseMarkerText('-')).toBeDefined();
    expect(parseMarkerText('1.')!.marker.ordinal).toBe(1);
  });

  it('rejects a word that merely starts with a marker character', () => {
    expect(parseMarkerText('*emphasis* here')).toBeUndefined();  // no space after
    expect(parseMarkerText('nothing here')).toBeUndefined();
  });

  it('takes bodyX from the fragment boundary when the marker is its own stamp', () => {
    const m = markerOf(line(frag('•', 50, 56), frag('item', 65, 90)));
    expect(m!.markerX).toBe(50);
    expect(m!.bodyX).toBe(65);
  });

  it('interpolates bodyX inside a single fragment', () => {
    // '- item' across 50..110: 6 chars, so the body starts 2/6 of the way in.
    const m = markerOf(line(frag('- item', 50, 110)));
    expect(m!.bodyX).toBeCloseTo(70, 6);
  });
});

const block = (...lines: TextLine[]): TextBlock => ({
  text: lines.map((l) => l.text).join('\n'),
  quad: [
    Math.min(...lines.map((l) => l.quad[0])), Math.min(...lines.map((l) => l.quad[1])),
    Math.max(...lines.map((l) => l.quad[2])), Math.max(...lines.map((l) => l.quad[3])),
  ],
  lines,
});

describe('docinfer — code lines', () => {
  it('accepts a line set entirely in a monospaced face', () => {
    expect(isCodeLine(line(frag('const x = 1;', 50, 130, 100, 9, 'Courier')))).toBe(true);
    expect(isCodeLine(line(frag('x', 50, 60, 100, 9, 'DejaVuSansMono')))).toBe(true);
  });

  it('strips a subset prefix before testing the name', () => {
    expect(isCodeLine(line(frag('x', 50, 60, 100, 9, 'ABCDEF+Courier-Bold')))).toBe(true);
  });

  it('rejects a line where any fragment is proportional', () => {
    expect(isCodeLine(line(
      frag('const ', 50, 80, 100, 9, 'Courier'),
      frag('x', 80, 90, 100, 9, 'Helvetica'),
    ))).toBe(false);
  });

  it('rejects a line whose font has no name at all', () => {
    const f = frag('x', 50, 60);
    delete (f as { fontName?: string }).fontName;
    expect(isCodeLine(line(f))).toBe(false);
  });
});

describe('docinfer — page metrics', () => {
  it('takes the column width from the widest line and leading from the median gap', () => {
    const m = pageMetrics([block(
      line(frag('a wide line of body text', 50, 250)),
      line(frag('short', 50, 90, 88)),
      line(frag('short', 50, 90, 76)),
    )], 10);
    expect(m.columnWidth).toBe(200);
    expect(m.leading).toBe(12);
  });

  it('falls back to 1.2x the body size when no block has two lines', () => {
    expect(pageMetrics([block(line(frag('only', 50, 90)))], 10).leading).toBeCloseTo(12, 6);
  });
});

const CTX: ClassifyContext = { metrics: { columnWidth: 200, leading: 12 }, bodySize: 10 };

describe('docinfer — list runs', () => {
  it('classifies two adjacent marked lines as items at depth 0', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('first', 65, 100, 200)),
      line(frag('•', 50, 56, 188), frag('second', 65, 105, 188)),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['item', 'item']);
    expect(cls.every((c) => c.kind === 'item' && c.depth === 0)).toBe(true);
  });

  it('leaves a lone marked line as prose — 1990. It was a good year', () => {
    const cls = classifyBlock([
      line(frag('1990. It was a good year and nothing else happened', 50, 240, 200)),
      line(frag('in the industry at all, by any measure.', 50, 230, 188)),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['text', 'text']);
  });

  it('confirms a single item when the next line is indented to its body', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('a long item', 65, 140, 200)),
      line(frag('wrapping on', 65, 130, 188)),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['item', 'continuation']);
  });

  it('gives a deeper marker a deeper depth', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('outer', 65, 100, 200)),
      line(frag('◦', 80, 86, 188), frag('inner', 95, 130, 188)),
      line(frag('•', 50, 56, 176), frag('outer again', 65, 130, 176)),
    ], CTX);
    expect(cls.map((c) => (c.kind === 'item' ? c.depth : c.kind))).toEqual([0, 1, 0]);
  });

  it('buckets markers within the tolerance to one depth', () => {
    // 0.5 x 10pt body size = 5pt tolerance; 52 is within it of 50.
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('a', 65, 75, 200)),
      line(frag('•', 52, 58, 188), frag('b', 67, 77, 188)),
    ], CTX);
    expect(cls.map((c) => (c.kind === 'item' ? c.depth : c.kind))).toEqual([0, 0]);
  });

  it('classifies consecutive monospaced lines as code', () => {
    const cls = classifyBlock([
      line(frag('function f() {', 50, 140, 200, 9, 'Courier')),
      line(frag('    return 1;', 50, 140, 188, 9, 'Courier')),
      line(frag('}', 50, 60, 176, 9, 'Courier')),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['code', 'code', 'code']);
  });

  it('never treats a code line as an item, even when it opens with a dash', () => {
    const cls = classifyBlock([
      line(frag('- x', 50, 80, 200, 9, 'Courier')),
      line(frag('- y', 50, 80, 188, 9, 'Courier')),
    ], CTX);
    expect(cls.map((c) => c.kind)).toEqual(['code', 'code']);
  });
});

describe('docinfer — heading signals', () => {
  // A short line at body size, with a gap above and body text below at the same
  // left edge. Each signal is added on top of that shared corroboration.
  const body = (text: string, y: number, font = 'Helvetica') =>
    line(frag(text, 50, 50 + text.length * 5, y, 10, font));

  const classify = (lines: TextLine[], extra: Partial<ClassifyContext> = {}) =>
    classifyBlock(lines, { ...CTX, prevBaseline: 300, ...extra }).map((c) => c.kind);

  it('promotes a fully bold short isolated line', () => {
    expect(classify([body('Revenue', 200, 'Helvetica-Bold'), body('Body text follows here', 188)]))
      .toEqual(['heading', 'text']);
  });

  it('promotes an all-caps short isolated line', () => {
    expect(classify([body('REVENUE', 200), body('Body text follows here', 188)]))
      .toEqual(['heading', 'text']);
  });

  it('promotes a short isolated line on its own', () => {
    expect(classify([body('Revenue', 200), body('Body text follows here', 188)]))
      .toEqual(['heading', 'text']);
  });

  it('refuses a short isolated line ending in a full stop', () => {
    expect(classify([body('Revenue.', 200), body('Body text follows here', 188)]))
      .toEqual(['text', 'text']);
  });

  it('refuses a line with nothing after it — the ruled-card case', () => {
    expect(classify([body('Card heading', 200)])).toEqual(['text']);
  });

  it('refuses a line whose follower sits at another left edge', () => {
    const next = line(frag('Body text elsewhere', 200, 300, 188));
    expect(classify([body('Revenue', 200)], { nextLine: next })).toEqual(['text']);
  });

  it('refuses a line with no gap above it', () => {
    expect(classify([body('Revenue', 200), body('Body text follows here', 188)],
      { prevBaseline: 210 })).toEqual(['text', 'text']);
  });

  it('refuses a long line however bold', () => {
    const long = line(frag('x'.repeat(40), 50, 240, 200, 10, 'Helvetica-Bold'));
    expect(classify([long, body('Body text follows here', 188)])).toEqual(['text', 'text']);
  });

  it('takes the follower from the next block when the heading is alone in its own', () => {
    const next = line(frag('Body text follows here', 50, 160, 188));
    expect(classify([body('Revenue', 200)], { nextLine: next })).toEqual(['heading']);
  });

  it('never promotes a line inside a list run or a code run', () => {
    const cls = classifyBlock([
      line(frag('•', 50, 56, 200), frag('SHORT', 65, 95, 200)),
      line(frag('•', 50, 56, 188), frag('ALSO SHORT', 65, 120, 188)),
    ], { ...CTX, prevBaseline: 300 });
    expect(cls.map((c) => c.kind)).toEqual(['item', 'item']);
  });
});

describe('docinfer — link spans', () => {
  const band = { y0: 95, y1: 115 };

  it('leaves a line no span touches byte-identical', () => {
    const l = line(frag('See the docs here.', 50, 200));
    expect(splitLineLinks(l, [])).toEqual([{ text: 'See the docs here.' }]);
    expect(splitLineLinks(l, [{ text: 'absent', href: 'u', ...band }]))
      .toEqual([{ text: 'See the docs here.' }]);
  });

  it('slices the covered phrase out of the line', () => {
    const l = line(frag('See the docs here.', 50, 200));
    expect(splitLineLinks(l, [{ text: 'the docs', href: 'https://e.com', ...band }])).toEqual([
      { text: 'See ' },
      { text: 'the docs', href: 'https://e.com' },
      { text: ' here.' },
    ]);
  });

  it('ignores a span whose band is on another line', () => {
    const l = line(frag('See the docs here.', 50, 200));
    expect(splitLineLinks(l, [{ text: 'the docs', href: 'u', y0: 500, y1: 520 }]))
      .toEqual([{ text: 'See the docs here.' }]);
  });

  // Without position information the first occurrence is only a guess, and
  // linking the wrong words reads as a defect where an unlinked phrase merely
  // reads as a missing feature.
  it('skips a span whose text occurs twice — ambiguous, so not guessed at', () => {
    const l = line(frag('docs and more docs', 50, 200));
    expect(splitLineLinks(l, [{ text: 'docs', href: 'u', ...band }]))
      .toEqual([{ text: 'docs and more docs' }]);
  });

  it('handles two distinct spans on one line, in order', () => {
    const l = line(frag('alpha and beta', 50, 200));
    const segs = splitLineLinks(l, [
      { text: 'beta', href: 'https://b', ...band },
      { text: 'alpha', href: 'https://a', ...band },
    ]);
    expect(segs).toEqual([
      { text: 'alpha', href: 'https://a' },
      { text: ' and ' },
      { text: 'beta', href: 'https://b' },
    ]);
  });
});
