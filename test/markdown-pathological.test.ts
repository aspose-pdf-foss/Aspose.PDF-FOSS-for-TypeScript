import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';

/** Markdown is untrusted text by definition, and every case here has CVE
 *  history in cmark. No spec case nests past ten or exercises adversarial
 *  emphasis, so the 652-case suite cannot protect any of this — the bounds
 *  live here or nowhere. The parser must never throw and never take the
 *  process down. */
describe('pathological input', () => {
  it('survives deeply nested block quotes', () => {
    expect(() => parseMarkdown(`${'>'.repeat(50_000)} x\n`)).not.toThrow();
  });

  it('survives deeply nested brackets', () => {
    expect(() => parseMarkdown('['.repeat(50_000) + 'a' + ']'.repeat(50_000))).not.toThrow();
  });

  it('survives list nesting past the depth cap', () => {
    // Past MAX_DEPTH (1000) no further container opens, so the tree stops
    // growing. Re-matching every open container on every line is quadratic by
    // construction — the reference algorithm is too — and the cap is what keeps
    // that bounded rather than unbounded. The time budget is deliberately loose:
    // it is here to catch exponential behaviour, not to pin a constant.
    let src = '';
    for (let i = 0; i < 1_200; i++) src += `${'  '.repeat(i)}- a\n`;
    const t0 = Date.now();
    expect(() => parseMarkdown(src)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  // cmark's own "openers and closers multiple of 3" case, plus the two
  // one-sided shapes. These are linearity regression guards, NOT proof that
  // openers_bottom is doing work: disabling that guard changes neither these
  // timings nor the 652 spec cases. See the note on processEmphasis.
  it('does not blow up on emphasis whose runs sum to a multiple of 3', () => {
    const t0 = Date.now();
    parseMarkdown('a**b***c**d*'.repeat(5_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on many emphasis closers with no openers', () => {
    const t0 = Date.now();
    parseMarkdown('a* b* '.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on many emphasis openers with no closers', () => {
    const t0 = Date.now();
    parseMarkdown('*a '.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on unmatched code-span backticks', () => {
    const t0 = Date.now();
    parseMarkdown('`a'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on many unresolved reference labels', () => {
    const t0 = Date.now();
    parseMarkdown('[a]'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on nested emphasis inside brackets', () => {
    const t0 = Date.now();
    parseMarkdown('[*a'.repeat(20_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe('degenerate but legal input', () => {
  it('parses a document with no trailing newline', () => {
    expect(parseMarkdown('a').children.length).toBe(1);
  });

  it('parses an empty document', () => {
    expect(parseMarkdown('').children).toEqual([]);
  });

  it('parses a document that is only a newline', () => {
    expect(parseMarkdown('\n').children).toEqual([]);
  });

  it('normalizes all three line endings', () => {
    const want = JSON.stringify(parseMarkdown('a\nb\n'));
    expect(JSON.stringify(parseMarkdown('a\r\nb\r\n'))).toBe(want);
    expect(JSON.stringify(parseMarkdown('a\rb\r'))).toBe(want);
  });

  it('scrubs NUL to U+FFFD', () => {
    const p = parseMarkdown('a\0b\n').children[0] as { children: { value?: string }[] };
    expect(p.children[0].value).toBe('a�b');
  });
});
