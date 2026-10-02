import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import {
  splitOversized, packPages, packTexts, windowPages, addUsage, intOption,
  pageTexts, requireText, checkModel,
} from '../src/aichunk.js';

describe('splitOversized (3ywf.4)', () => {
  it('prefers a blank line, then a newline, then a space, then a hard cut', () => {
    expect(splitOversized('aa\n\nbb\ncc', 8)).toEqual(['aa', 'bb\ncc']);
    expect(splitOversized('aaaa\nbbbb', 8)).toEqual(['aaaa', 'bbbb']);
    expect(splitOversized('aaaa bbbb', 8)).toEqual(['aaaa', 'bbbb']);
    expect(splitOversized('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
  it('never splits a surrogate pair', () => {
    expect(splitOversized('a\u{1F600}b', 2)).toEqual(['a', '\u{1F600}', 'b']);
  });
  it('returns text that fits unchanged, and nothing for blank text', () => {
    expect(splitOversized('short', 100)).toEqual(['short']);
    expect(splitOversized('   ', 100)).toEqual([]);
  });
});

describe('packPages (3ywf.4)', () => {
  it('labels each page and packs consecutive pages under the budget', () => {
    const one = packPages([{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }], 100);
    expect(one).toEqual([{ pages: [1, 2], text: '[page 1]\nalpha\n\n[page 2]\nbeta' }]);
    const two = packPages([{ page: 1, text: 'alpha' }, { page: 2, text: 'beta' }], 20);
    expect(two.map((c) => c.pages)).toEqual([[1], [2]]);
  });
  it('splits an oversized page and keeps every chunk within the budget', () => {
    const chunks = packPages([{ page: 3, text: 'word '.repeat(50) }], 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(60);
      expect(c.text.startsWith('[page 3]\n')).toBe(true);
    }
  });
});

describe('packTexts (3ywf.4)', () => {
  it('joins consecutive texts with a blank line under the budget', () => {
    expect(packTexts(['aaa', 'bbb', 'ccc'], 8)).toEqual(['aaa\n\nbbb', 'ccc']);
  });
});

describe('windowPages (3ywf.4)', () => {
  const words = Array.from({ length: 600 }, (_, i) => `w${String(i).padStart(4, '0')}`);
  const text = words.join(' ');

  it('makes bounded, overlapping windows of whole words that cover the page', () => {
    const w = windowPages([{ page: 1, text }]);
    expect(w.length).toBeGreaterThan(2);
    for (const x of w) {
      expect(x.text.length).toBeLessThanOrEqual(1500);
      for (const tok of x.text.split(/\s+/)) expect(tok).toMatch(/^w\d{4}$/);
    }
    for (let i = 1; i < w.length; i++) {
      const first = w[i]!.text.split(' ')[0]!;
      expect(w[i - 1]!.text.split(' ')).toContain(first);
    }
    const seen = new Set(w.flatMap((x) => x.text.split(' ')));
    for (const word of words) expect(seen.has(word)).toBe(true);
  });

  it('never lets a window span two pages', () => {
    const w = windowPages([{ page: 1, text: 'one '.repeat(10) }, { page: 2, text: 'two '.repeat(10) }]);
    for (const x of w) expect(x.text.includes('one') && x.text.includes('two')).toBe(false);
    expect(w.find((x) => x.text.includes('two'))!.page).toBe(2);
  });
});

describe('helpers (3ywf.4)', () => {
  it('addUsage sums, and stays absent only when both are', () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, undefined)).toEqual({ inputTokens: 1, outputTokens: 2 });
    expect(addUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3, outputTokens: 4 }))
      .toEqual({ inputTokens: 4, outputTokens: 6 });
  });
  it('intOption defaults, and refuses the wrong kind and the out of range', () => {
    expect(intOption('n', undefined, 7, 1)).toBe(7);
    expect(intOption('n', 9, 7, 1)).toBe(9);
    expect(() => intOption('n', '9', 7, 1)).toThrow(TypeError);
    expect(() => intOption('n', 1.5, 7, 1)).toThrow(RangeError);
    expect(() => intOption('n', 0, 7, 1)).toThrow(RangeError);
  });
  it('checkModel refuses anything without complete()', () => {
    expect(() => checkModel({})).toThrow(TypeError);
    expect(() => checkModel(null)).toThrow(TypeError);
    expect(() => checkModel({ complete: async () => ({ text: '' }) })).not.toThrow();
  });
  it('pageTexts drops pages with no text, and requireText refuses an empty set', () => {
    const doc = Document.New(PageFormat.custom(300, 300));
    doc.AddPage(PageFormat.custom(300, 300)).page.AddText('Hello', 20, 150);
    const t = pageTexts(doc, undefined);
    expect(t.map((p) => p.page)).toEqual([2]);
    expect(t[0]!.text).toContain('Hello');
    expect(() => requireText(pageTexts(doc, [1]))).toThrow(/no extractable text/);
  });
});
