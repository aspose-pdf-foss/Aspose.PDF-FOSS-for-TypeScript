import { describe, it, expect } from 'vitest';
import { tokenize, rankBm25 } from '../src/bm25.js';

describe('tokenize (3ywf.4)', () => {
  it('lowercases and keeps word-like segments only', () => {
    expect(tokenize('Hello, World! 42')).toEqual(['hello', 'world', '42']);
  });
  it('segments Cyrillic and CJK with no dictionary of ours', () => {
    expect(tokenize('Привет, мир')).toEqual(['привет', 'мир']);
    const ja = tokenize('東京に行きます');
    expect(ja.length).toBeGreaterThan(1);
    for (const t of ja) expect('東京に行きます').toContain(t);
  });
});

describe('rankBm25 (3ywf.4)', () => {
  it('ranks the document sharing the query terms first', () => {
    const r = rankBm25(['the cat sat', 'a dog barked loudly', 'cats and dogs'], 'dog barked');
    expect(r[0]!.index).toBe(1);
    expect(r[0]!.score).toBeGreaterThan(0);
  });

  it('lets a rare term outweigh repetitions of a common one (IDF)', () => {
    // alpha is in two of three documents, zeta in one. Without IDF the four
    // alphas of doc 0 win on term frequency alone; with it, zeta does.
    const docs = ['alpha alpha alpha alpha', 'zeta w w w', 'alpha w w w'];
    expect(rankBm25(docs, 'alpha zeta')[0]!.index).toBe(1);
  });

  it('scores 0 for a query sharing nothing, and breaks ties by index', () => {
    const r = rankBm25(['one', 'two', 'three'], 'nothing here');
    expect(r.map((x) => x.score)).toEqual([0, 0, 0]);
    expect(r.map((x) => x.index)).toEqual([0, 1, 2]);
  });

  it('counts a repeated query term once', () => {
    const docs = ['red apple', 'green pear'];
    expect(rankBm25(docs, 'red red red')[0]!.score).toBeCloseTo(rankBm25(docs, 'red')[0]!.score, 12);
  });

  it('handles an empty corpus', () => {
    expect(rankBm25([], 'x')).toEqual([]);
  });
});
