import { describe, it, expect } from 'vitest';
import { Lexer } from '../src/lexer.js';

const enc = (s: string) => new TextEncoder().encode(s);
function toks(s: string) {
  const lx = new Lexer(enc(s));
  const out: any[] = [];
  for (;;) { const t = lx.next(); out.push(t); if (t.t === 'eof') break; }
  return out;
}

describe('Lexer', () => {
  it('tokenizes numbers, names, keywords', () => {
    const t = toks('10 0 obj /Type true');
    expect(t.map(x => x.t)).toEqual(['num','num','kw','name','kw','eof']);
    expect(t[0].v).toBe(10);
    expect(t[3].v).toBe('Type');
    expect(t[4].v).toBe('true');
  });
  it('tokenizes dict delimiters and arrays', () => {
    expect(toks('<< /A [1 2] >>').map(x => x.t))
      .toEqual(['delim','name','delim','num','num','delim','delim','eof']);
  });
  it('decodes literal strings with escapes', () => {
    const t = toks('(a\\)b)');
    expect(t[0].t).toBe('str');
    expect(new TextDecoder().decode(t[0].v)).toBe('a)b');
  });
  it('decodes hex strings', () => {
    const t = toks('<48656C6C6F>');
    expect(new TextDecoder().decode(t[0].v)).toBe('Hello');
  });

  // `)`, `{` and `}` are delimiters, so readRegular stops on them without
  // consuming anything. next() must still make progress: every caller loops
  // until 'eof', so a token handed back at an unchanged pos is an infinite
  // loop, and the ops array it appends to exhausts the heap.
  it('consumes a delimiter no other rule claims, rather than standing still', () => {
    for (const s of [')', '{', '}', '>']) {
      const lx = new Lexer(enc(s));
      const t = lx.next();
      expect(t).toMatchObject({ t: 'kw', v: s });
      expect(lx.pos).toBe(1);
      expect(lx.next().t).toBe('eof');
    }
  });

  it('still reads >> as a dict close, not as two stray keywords', () => {
    expect(toks('<< /A 1 >>').map(x => x.t))
      .toEqual(['delim', 'name', 'num', 'delim', 'eof']);
  });

  it('never throws — a damaged file is the parser\'s judgement, not the lexer\'s', () => {
    for (let b = 0; b < 256; b++) {
      expect(() => toks(String.fromCharCode(b))).not.toThrow();
    }
  });
});
