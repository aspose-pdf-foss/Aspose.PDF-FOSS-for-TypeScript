import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdParagraph } from '../src/mdast.js';
import { resolveMarkdownStyle } from '../src/mdstyle.js';
import { inlineRuns, plainText } from '../src/mdruns.js';

const STYLE = resolveMarkdownStyle();
const CTX = { family: STYLE.family, fontSize: STYLE.fontSize };

/** The inlines of a one-paragraph document. */
const inlinesOf = (src: string, gfm = true) => {
  const doc = parseMarkdown(src, { gfm });
  return (doc.children[0] as MdParagraph).children;
};
const runs = (src: string, skipped: string[] = []) =>
  inlineRuns(inlinesOf(src), STYLE, CTX, skipped);

describe('inlineRuns', () => {
  it('plain text is ONE run carrying no overrides at all', () => {
    // The closest a run list gets to the string path, which is what keeps a
    // plain Markdown paragraph cheap and its output stable.
    expect(runs('hello world')).toEqual([{ text: 'hello world' }]);
  });

  it('merges adjacent pieces of identical style', () => {
    // A soft break is a space; it must not split the run.
    expect(runs('one\ntwo')).toEqual([{ text: 'one two' }]);
  });

  it('a hard break becomes a newline in the run text', () => {
    const r = runs('one  \ntwo');
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe('one\ntwo');
  });

  it('selects bold, italic and bold-italic faces', () => {
    expect(runs('**b**')[0].font).toBe('Helvetica-Bold');
    expect(runs('*i*')[0].font).toBe('Helvetica-Oblique');
    expect(runs('**a *b* c**').map((r) => r.font))
      .toEqual(['Helvetica-Bold', 'Helvetica-BoldOblique', 'Helvetica-Bold']);
  });

  it('nesting order does not matter', () => {
    expect(runs('*__x__*')[0].font).toBe('Helvetica-BoldOblique');
    expect(runs('__*x*__')[0].font).toBe('Helvetica-BoldOblique');
  });

  it('inline code takes the code face at sizeRatio of the block size', () => {
    const r = runs('`x`');
    expect(r[0].font).toBe('Courier');
    expect(r[0].fontSize).toBeCloseTo(11 * 0.9, 6);
    expect(r[0].background).toEqual([0.96, 0.96, 0.96]);
  });

  it('inline code scales to the block it sits in, not to the body size', () => {
    const big = inlineRuns(inlinesOf('`x`'), STYLE, { family: STYLE.family, fontSize: 24 }, []);
    expect(big[0].fontSize).toBeCloseTo(24 * 0.9, 6);
  });

  it('strikethrough decorates the run', () => {
    expect(runs('~~gone~~')[0].strikethrough).toBe(true);
  });

  it('a link colours and underlines its children, keeping their faces', () => {
    const r = runs('[**bold** plain](/x)');
    expect(r[0].font).toBe('Helvetica-Bold');
    expect(r.every((x) => x.underline === true)).toBe(true);
    expect(r.every((x) => x.color !== undefined)).toBe(true);
  });

  it('an inline image falls back to its alt text and reports itself', () => {
    const skipped: string[] = [];
    const r = inlineRuns(inlinesOf('see ![a cat](cat.png) here'), STYLE, CTX, skipped);
    expect(r.map((x) => x.text).join('')).toBe('see a cat here');
    expect(skipped).toEqual(['image:cat.png']);
  });

  it('inline HTML is dropped and reported', () => {
    const skipped: string[] = [];
    const r = inlineRuns(inlinesOf('a <b>c'), STYLE, CTX, skipped);
    expect(r.map((x) => x.text).join('')).toBe('a c');
    expect(skipped).toEqual(['html_inline']);
  });

  it('an embedded family without a bold face leaves the run unstyled, not dropped', () => {
    const fam = {
      regular: 'Helvetica' as const, bold: 'Helvetica' as const,
      italic: 'Helvetica' as const, boldItalic: 'Helvetica' as const,
    };
    const r = inlineRuns(inlinesOf('**b**'), STYLE, { family: fam, fontSize: 11 }, []);
    expect(r).toEqual([{ text: 'b' }]);
  });
});

describe('plainText', () => {
  it('flattens every inline to its characters', () => {
    expect(plainText(inlinesOf('**a** *b* `c` [d](/x)'))).toBe('a b c d');
  });
});
