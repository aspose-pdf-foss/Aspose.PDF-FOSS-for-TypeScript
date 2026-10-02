import { describe, it, expect } from 'vitest';
import {
  diffSequences, diffStats, tokenizeWords, type DiffRun,
} from '../src/textdiff.js';

const w = (s: string): string[] => (s === '' ? [] : s.split(' '));
const ops = <T>(runs: DiffRun<T>[]): string[] =>
  runs.map((r) => `${r.op}:${(r.op === 'insert' ? r.new : r.old).join(' ')}`);

/** Independent oracle: the LCS length by the textbook O(NM) table. Myers' answer
 *  is minimal exactly when it edits N + M - 2·LCS tokens. */
function lcs(a: string[], b: string[]): number {
  const t: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
}

function oldOf<T>(runs: DiffRun<T>[]): T[] { return runs.flatMap((r) => r.old); }
function newOf<T>(runs: DiffRun<T>[]): T[] { return runs.flatMap((r) => r.new); }

/** Deterministic PRNG so a failing case is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('diffSequences', () => {
  it('returns nothing for two empty sequences', () => {
    expect(diffSequences([], []).runs).toEqual([]);
  });

  it('reports one equal run for identical input', () => {
    expect(ops(diffSequences(w('a b c'), w('a b c')).runs)).toEqual(['equal:a b c']);
  });

  it('reports a pure insert and a pure delete', () => {
    expect(ops(diffSequences([], w('a b')).runs)).toEqual(['insert:a b']);
    expect(ops(diffSequences(w('a b'), []).runs)).toEqual(['delete:a b']);
  });

  it('reports a replacement as delete then insert', () => {
    expect(ops(diffSequences(w('a b c'), w('a x c')).runs))
      .toEqual(['equal:a', 'delete:b', 'insert:x', 'equal:c']);
  });

  it('puts the insert first when asked', () => {
    expect(ops(diffSequences(w('a b c'), w('a x c'), String, { order: 'insert-first' }).runs))
      .toEqual(['equal:a', 'insert:x', 'delete:b', 'equal:c']);
  });

  it('coalesces interleaved edits between two equalities into one delete and one insert', () => {
    // Myers can emit d i d i here; a reader wants one change region.
    const runs = diffSequences(w('k a b k'), w('k x y k')).runs;
    expect(ops(runs)).toEqual(['equal:k', 'delete:a b', 'insert:x y', 'equal:k']);
  });

  it('records where each run starts in both sequences', () => {
    const runs = diffSequences(w('a b c d'), w('a x c d e')).runs;
    expect(runs.map((r) => [r.op, r.oldIndex, r.newIndex])).toEqual([
      ['equal', 0, 0], ['delete', 1, 1], ['insert', 2, 1], ['equal', 2, 2], ['insert', 4, 4],
    ]);
  });

  it('pairs an equal run token by token, keeping each side its own payload', () => {
    type Tok = { text: string; page: number };
    const a: Tok[] = [{ text: 'A', page: 1 }, { text: 'B', page: 1 }];
    const b: Tok[] = [{ text: 'a', page: 7 }, { text: 'b', page: 8 }];
    const runs = diffSequences(a, b, (t) => t.text.toLowerCase()).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0].op).toBe('equal');
    expect(runs[0].old).toEqual(a);
    expect(runs[0].new).toEqual(b);
  });

  it('compares by the key alone', () => {
    expect(ops(diffSequences(w('A b'), w('a B'), (s) => s.toLowerCase()).runs)).toEqual(['equal:A b']);
    expect(ops(diffSequences(w('A b'), w('a B')).runs)).toEqual(['delete:A b', 'insert:a B']);
  });

  describe('slides a lone edit to its canonical (leftmost) position', () => {
    it('for an insert, merging the equalities it separated', () => {
      // "a" + ins "x a" + "c"  ==  ins "a x" + "a c": the same edit, two spellings.
      expect(ops(diffSequences(w('a c'), w('a x a c')).runs)).toEqual(['insert:a x', 'equal:a c']);
    });

    it('for a delete', () => {
      expect(ops(diffSequences(w('a x a c'), w('a c')).runs)).toEqual(['delete:a x', 'equal:a c']);
    });

    it('stops sliding where the tokens stop matching', () => {
      expect(ops(diffSequences(w('p a c'), w('p a x a c')).runs))
        .toEqual(['equal:p', 'insert:a x', 'equal:a c']);
    });

    it('gives the same answer for a repeated token however Myers placed it', () => {
      for (const n of [1, 2, 3, 6]) {
        const base = new Array(n).fill('z');
        const runs = diffSequences(base, [...base, 'z']).runs;
        expect(ops(runs)).toEqual(['insert:z', `equal:${base.join(' ')}`]);
      }
    });
  });

  describe("cleanup: 'semantic'", () => {
    const sem = { cleanup: 'semantic' } as const;

    it('folds a short coincidental match inside a rewrite into one change', () => {
      // "of" is shared by two unrelated sentences; minimal keeps it, a reader does not
      expect(ops(diffSequences(w('k a b of c d k'), w('k p q of r s k')).runs))
        .toEqual(['equal:k', 'delete:a b', 'insert:p q', 'equal:of', 'delete:c d', 'insert:r s', 'equal:k']);
      expect(ops(diffSequences(w('k a b of c d k'), w('k p q of r s k'), String, sem).runs))
        .toEqual(['equal:k', 'delete:a b of c d', 'insert:p q of r s', 'equal:k']);
    });

    it('keeps an equality longer than the edits on either side', () => {
      expect(ops(diffSequences(w('k a same same same b k'), w('k z same same same y k'), String, sem).runs))
        .toEqual(['equal:k', 'delete:a', 'insert:z', 'equal:same same same', 'delete:b', 'insert:y', 'equal:k']);
    });

    it('never folds an equality with no edit on one side', () => {
      expect(ops(diffSequences(w('the quick brown fox'), w('the slow brown fox'), String, sem).runs))
        .toEqual(['equal:the', 'delete:quick', 'insert:slow', 'equal:brown fox']);
    });

    it('keeps a one-word equality between one-word edits: a landmark, not a coincidence', () => {
      expect(ops(diffSequences(w('a x b'), w('d x e'), String, sem).runs))
        .toEqual(['delete:a', 'insert:d', 'equal:x', 'delete:b', 'insert:e']);
    });

    it('lets one fold enable the next', () => {
      // "x" (1) folds between edits of 3 and 2, making a region of 6; only then
      // is "y y" (2) shorter than the edits on both of its sides
      expect(ops(diffSequences(w('a a a x b b y y c c c'), w('d d d x e e y y f f f'), String, sem).runs))
        .toEqual(['delete:a a a x b b y y c c c', 'insert:d d d x e e y y f f f']);
    });

    it('still reassembles both sides exactly', () => {
      const r = rng(9);
      for (let k = 0; k < 200; k++) {
        const gen = (): string[] => Array.from({ length: Math.floor(r() * 25) }, () => 'abc'[Math.floor(r() * 3)]);
        const a = gen(), b = gen();
        const { runs } = diffSequences(a, b, String, sem);
        expect(oldOf(runs)).toEqual(a);
        expect(newOf(runs)).toEqual(b);
      }
    });
  });

  it('is minimal and reassembles both sides, against an O(NM) oracle', () => {
    const r = rng(42);
    for (let k = 0; k < 400; k++) {
      const alpha = 2 + Math.floor(r() * 4);
      const gen = (): string[] =>
        Array.from({ length: Math.floor(r() * 30) }, () => String.fromCharCode(97 + Math.floor(r() * alpha)));
      const a = gen(), b = gen();
      const { runs, minimal } = diffSequences(a, b);
      expect(minimal).toBe(true);
      expect(oldOf(runs)).toEqual(a);
      expect(newOf(runs)).toEqual(b);
      const edited = runs.filter((x) => x.op !== 'equal').reduce((s, x) => s + x.old.length + x.new.length, 0);
      expect(edited).toBe(a.length + b.length - 2 * lcs(a, b));
      // shape: no empty run, no two adjacent runs of one kind, equal runs paired
      for (let i = 0; i < runs.length; i++) {
        expect(runs[i].old.length + runs[i].new.length).toBeGreaterThan(0);
        if (i > 0) expect(runs[i].op).not.toBe(runs[i - 1].op);
        if (runs[i].op === 'equal') expect(runs[i].new).toEqual(runs[i].old);
        if (runs[i].op === 'delete') expect(runs[i].new).toEqual([]);
        if (runs[i].op === 'insert') expect(runs[i].old).toEqual([]);
      }
      // delete always precedes insert inside one change region
      for (let i = 1; i < runs.length; i++)
        expect(!(runs[i - 1].op === 'insert' && runs[i].op === 'delete')).toBe(true);
    }
  });

  it('degrades to a correct but non-minimal diff past the cost budget, and says so', () => {
    const a = w('a b c d e f g h'), b = w('h g f e d c b a');
    const tight = diffSequences(a, b, String, { maxCost: 1 });
    expect(tight.minimal).toBe(false);
    expect(oldOf(tight.runs)).toEqual(a);
    expect(newOf(tight.runs)).toEqual(b);
    const full = diffSequences(a, b);
    expect(full.minimal).toBe(true);
    const edited = full.runs.filter((x) => x.op !== 'equal').reduce((s, x) => s + x.old.length + x.new.length, 0);
    expect(edited).toBe(16 - 2 * lcs(a, b));
  });

  it('does not spend the budget on a shared prefix and suffix', () => {
    const body = Array.from({ length: 20000 }, (_, i) => `w${i}`);
    const a = [...body, 'old', ...body];
    const b = [...body, 'new', ...body];
    const res = diffSequences(a, b, String, { maxCost: 10 });
    expect(res.minimal).toBe(true);
    expect(res.runs.map((x) => x.op)).toEqual(['equal', 'delete', 'insert', 'equal']);
  });

  it('diffs a long document with scattered edits quickly', () => {
    const r = rng(7);
    const a = Array.from({ length: 50000 }, () => `t${Math.floor(r() * 5000)}`);
    const b = a.slice();
    for (let k = 0; k < 200; k++) b[Math.floor(r() * b.length)] = 'EDIT';
    const t0 = performance.now();
    const { runs, minimal } = diffSequences(a, b);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(minimal).toBe(true);
    expect(newOf(runs)).toEqual(b);
  });
});

describe('diffStats', () => {
  it('counts tokens and change regions', () => {
    const { runs } = diffSequences(w('a b c d e'), w('a x c e f'));
    expect(diffStats(runs)).toEqual({ equal: 3, deleted: 2, inserted: 2, changes: 3 });
  });

  it('reports zero changes for identical input', () => {
    expect(diffStats(diffSequences(w('a b'), w('a b')).runs)).toEqual({ equal: 2, deleted: 0, inserted: 0, changes: 0 });
  });
});

describe('tokenizeWords', () => {
  it('splits on whitespace and keeps punctuation with its word', () => {
    expect(tokenizeWords('  Hello,  world!\n\tBye. ')).toEqual(['Hello,', 'world!', 'Bye.']);
  });

  it('treats U+00A0 and other Unicode spaces as separators', () => {
    expect(tokenizeWords('a b c　d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns nothing for blank text', () => {
    expect(tokenizeWords(' \n ')).toEqual([]);
  });
});
