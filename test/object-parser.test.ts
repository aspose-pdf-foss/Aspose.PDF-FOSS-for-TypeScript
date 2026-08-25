import { describe, it, expect } from 'vitest';
import { Lexer } from '../src/lexer.js';
import { ObjectParser } from '../src/object-parser.js';
import { isDict, isStream, isRef } from '../src/types.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (s: string) => new ObjectParser(new Lexer(enc(s))).parseObject();

describe('ObjectParser', () => {
  it('parses scalars and arrays', () => {
    expect(parse('42')).toBe(42);
    expect(parse('true')).toBe(true);
    expect(parse('null')).toBe(null);
    expect(parse('[1 2 3]')).toEqual([1, 2, 3]);
  });
  it('parses references vs numbers', () => {
    const r = parse('5 0 R');
    expect(isRef(r) && r.num).toBe(5);
  });
  it('parses dicts with nested values', () => {
    const d = parse('<< /Type /Page /Count 3 >>');
    expect(isDict(d)).toBe(true);
    if (isDict(d)) { expect((d.get('Count'))).toBe(3); }
  });
  it('parses streams', () => {
    const s = parse('<< /Length 5 >>\nstream\nHello\nendstream');
    expect(isStream(s)).toBe(true);
    if (isStream(s)) expect(new TextDecoder().decode(s.raw)).toBe('Hello');
  });

  // The lexer hands back an unmatched `>` as a one-character keyword rather
  // than throwing, because a content stream must survive one. Object syntax
  // must not: the sweep that rebuilds a damaged xref decides an offset holds no
  // object by whether parsing it throws, so tolerating junk here would let a
  // byte-shifted offset produce a plausible-looking object.
  it('rejects an unmatched > in object syntax', () => {
    expect(() => parse('>')).toThrow(PdfParseError);
    expect(() => parse('[1 > 2]')).toThrow(PdfParseError);
    expect(() => parse('<< /A > >>')).toThrow(PdfParseError);
    expect(() => new ObjectParser(new Lexer(enc('1 0 obj > endobj'))).parseIndirectObject())
      .toThrow(PdfParseError);
  });
});
