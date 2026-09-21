import { describe, it, expect } from 'vitest';
import { Lexer } from '../src/lexer.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('Lexer.maxTokenBytes', () => {
  it('stops a literal string at the cap and flags it, without reading the rest', () => {
    // What makes maxObjectBytes a MEMORY bound rather than a report after the
    // fact: a literal string accumulates into a number[] of eight-byte slots,
    // so a 900 MB string is gone from the heap before any span check runs.
    const src = bytes(`(${'a'.repeat(1000)})`);
    const lx = new Lexer(src);
    lx.maxTokenBytes = 10;
    const t = lx.next();
    expect(t.t).toBe('str');
    expect(t.over).toBeGreaterThan(10);
    expect(lx.pos).toBeLessThan(100);
  });

  it('caps hex strings, names and regular tokens alike', () => {
    for (const src of [`<${'41'.repeat(500)}>`, `/${'N'.repeat(1000)}`, `${'k'.repeat(1000)}`]) {
      const lx = new Lexer(bytes(src));
      lx.maxTokenBytes = 10;
      expect(lx.next().over, src.slice(0, 3)).toBeGreaterThan(10);
      expect(lx.pos).toBeLessThan(100);
    }
  });

  it('never flags a token at or under the cap, and still always advances', () => {
    const lx = new Lexer(bytes('(abc) /Name 12345 keyword'));
    lx.maxTokenBytes = 7;
    for (let t = lx.next(); t.t !== 'eof'; t = lx.next()) expect(t.over).toBeUndefined();
  });

  it('is off by default, which is what keeps content streams, CMaps and /DA untouched', () => {
    const lx = new Lexer(bytes(`(${'a'.repeat(100_000)})`));
    expect(lx.next().over).toBeUndefined();
  });
});
