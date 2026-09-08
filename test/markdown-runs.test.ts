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
  inlineRuns(inlinesOf(src), STYLE, CTX, skipped).runs;

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
    const big = inlineRuns(inlinesOf('`x`'), STYLE, { family: STYLE.family, fontSize: 24 }, []).runs;
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
    const r = inlineRuns(inlinesOf('see ![a cat](cat.png) here'), STYLE, CTX, skipped).runs;
    expect(r.map((x) => x.text).join('')).toBe('see a cat here');
    expect(skipped).toEqual(['image:cat.png']);
  });

  it('inline HTML is dropped and reported', () => {
    const skipped: string[] = [];
    const r = inlineRuns(inlinesOf('a <b>c'), STYLE, CTX, skipped).runs;
    expect(r.map((x) => x.text).join('')).toBe('a c');
    expect(skipped).toEqual(['html_inline']);
  });

  it('an embedded family without a bold face leaves the run unstyled, not dropped', () => {
    const fam = {
      regular: 'Helvetica' as const, bold: 'Helvetica' as const,
      italic: 'Helvetica' as const, boldItalic: 'Helvetica' as const,
    };
    const r = inlineRuns(inlinesOf('**b**'), STYLE, { family: fam, fontSize: 11 }, []).runs;
    expect(r).toEqual([{ text: 'b' }]);
  });
});

describe('plainText', () => {
  it('flattens every inline to its characters', () => {
    expect(plainText(inlinesOf('**a** *b* `c` [d](/x)'))).toBe('a b c d');
  });
});

/**
 * Inline images as atomics (`z77w`).
 *
 * The resolver is INJECTED, so these drive it with a fake box and never decode
 * a byte — which is what keeps mdruns.ts a pure leaf and lets every rule here
 * be checked as arithmetic over indices.
 */
describe('inlineRuns atomics', () => {
  const BOX = { data: new Uint8Array([1, 2, 3]), width: 10, height: 5 };
  const withAtomic = (src: string, skipped: string[] = []) =>
    inlineRuns(inlinesOf(src), STYLE, { ...CTX, atomic: () => BOX }, skipped);

  it('emits an inline image as an atomic rather than reporting it', () => {
    const skipped: string[] = [];
    const c = withAtomic('see ![a cat](cat.png) here', skipped);
    expect(skipped).toEqual([]);
    expect(c.atomics).toHaveLength(1);
    expect(c.atomics[0]).toEqual({ beforeRun: 1, ...BOX });
    // The alt text is NOT emitted: the picture is drawn instead of described.
    expect(c.runs.map((r) => r.text).join('')).toBe('see  here');
  });

  /**
   * THE MERGE BARRIER, and it is the rule that renders wrongly rather than
   * failing when broken. An atomic records the run index it sits BEFORE, so
   * the identically-styled text on either side must NOT merge — if `a` and `b`
   * became one run, the atomic's `beforeRun: 1` would point past the end and
   * its intended index 1 would name the wrong boundary.
   */
  it('an atomic is a merge barrier between identically styled text', () => {
    const c = withAtomic('a![x](i.png)b');
    expect(c.runs.map((r) => r.text)).toEqual(['a', 'b']);
    expect(c.atomics[0].beforeRun).toBe(1);
  });

  it('an atomic before any text records beforeRun 0', () => {
    const c = withAtomic('![x](i.png)tail');
    expect(c.atomics[0].beforeRun).toBe(0);
    expect(c.runs.map((r) => r.text)).toEqual(['tail']);
  });

  it('an atomic after all text records beforeRun at the end', () => {
    const c = withAtomic('head ![x](i.png)');
    expect(c.atomics[0].beforeRun).toBe(c.runs.length);
  });

  it('several images each keep their own place among the runs', () => {
    const c = withAtomic('a![1](i.png)b![2](j.png)c');
    expect(c.runs.map((r) => r.text)).toEqual(['a', 'b', 'c']);
    expect(c.atomics.map((a) => a.beforeRun)).toEqual([1, 2]);
  });

  it('a resolver that declines falls back to the alt text and reports', () => {
    const skipped: string[] = [];
    const c = inlineRuns(inlinesOf('see ![a cat](cat.png) here'), STYLE,
      { ...CTX, atomic: () => undefined }, skipped);
    expect(skipped).toEqual(['image:cat.png']);
    expect(c.runs.map((r) => r.text).join('')).toBe('see a cat here');
    expect(c.atomics).toEqual([]);
  });

  it('no resolver at all is the same fallback, which is what a table cell gets', () => {
    const skipped: string[] = [];
    const c = inlineRuns(inlinesOf('see ![a cat](cat.png) here'), STYLE, CTX, skipped);
    expect(skipped).toEqual(['image:cat.png']);
    expect(c.atomics).toEqual([]);
  });

  it('asks the resolver once per image and no more', () => {
    let calls = 0;
    inlineRuns(inlinesOf('![a](1.png) ![b](2.png)'), STYLE,
      { ...CTX, atomic: () => { calls++; return BOX; } }, []);
    expect(calls).toBe(2);
  });

  it('a link around an image still resolves the image', () => {
    const c = withAtomic('[![badge](b.png)](https://example.com)');
    expect(c.atomics).toHaveLength(1);
  });
});
