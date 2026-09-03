import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/csstoken.js';

describe('the CSS tokenizer', () => {
  it('tokenizes an ident, a colon and a whitespace run as three tokens', () => {
    expect(tokenize('a:  b')).toEqual([
      { kind: 'ident', value: 'a' },
      { kind: 'colon' },
      { kind: 'whitespace' },
      { kind: 'ident', value: 'b' },
    ]);
  });

  // A number carries its REPRESENTATION and a type flag beside its value.
  // 1 and 1.0 have equal values and differ only in the flag; +1 and 1 differ
  // only in the representation.
  it('keeps a number’s representation and type flag', () => {
    expect(tokenize('1')).toEqual([{ kind: 'number', repr: '1', value: 1, int: true }]);
    expect(tokenize('1.0')).toEqual([{ kind: 'number', repr: '1.0', value: 1, int: false }]);
    expect(tokenize('+1')).toEqual([{ kind: 'number', repr: '+1', value: 1, int: true }]);
  });

  it('distinguishes a dimension from a percentage from a number', () => {
    expect(tokenize('2em')).toEqual([
      { kind: 'dimension', repr: '2', value: 2, int: true, unit: 'em' },
    ]);
    expect(tokenize('50%')).toEqual([
      { kind: 'percentage', repr: '50', value: 50, int: true },
    ]);
  });

  // `url(` is a url-token whose value runs to the paren with no quoting;
  // `url (` is an ident then a function. A tokenizer that treats `url` as a
  // name everywhere is wrong for every unquoted URL.
  it('distinguishes url( from url (', () => {
    expect(tokenize('url(a)')).toEqual([{ kind: 'url', value: 'a' }]);
    expect(tokenize('url (a)')).toEqual([
      { kind: 'ident', value: 'url' },
      { kind: 'whitespace' },
      { kind: 'open', open: '(' },
      { kind: 'ident', value: 'a' },
      { kind: 'close', close: ')' },
    ]);
  });

  it('treats a quoted url as a function', () => {
    expect(tokenize('url("a")')).toEqual([
      { kind: 'function', name: 'url' },
      { kind: 'string', value: 'a' },
      { kind: 'close', close: ')' },
    ]);
  });

  // A bad string ends at the newline that broke it; a bad url consumes to the
  // closing paren. Collapsing either into its good form changes what the rest
  // of the stylesheet parses as.
  it('ends a bad string at the newline and a bad url at the paren', () => {
    expect(tokenize('"a\nb')).toEqual([
      { kind: 'error', code: 'bad-string' },
      { kind: 'whitespace' },
      { kind: 'ident', value: 'b' },
    ]);
    expect(tokenize('url(a"b)c')).toEqual([
      { kind: 'error', code: 'bad-url' },
      { kind: 'ident', value: 'c' },
    ]);
  });

  // EOF emits the SALVAGED VALUE and THEN the error, rather than replacing
  // the value with it — unlike bad-string and bad-url above, which discard
  // what they had. This expectation was written the other way round first and
  // the vendored corpus corrected it (component_value_list#13, #17).
  it('reports eof inside a string and inside a url after the salvaged value', () => {
    expect(tokenize('"a')).toEqual([
      { kind: 'string', value: 'a' },
      { kind: 'error', code: 'eof-in-string' },
    ]);
    expect(tokenize('url(a')).toEqual([
      { kind: 'url', value: 'a' },
      { kind: 'error', code: 'eof-in-url' },
    ]);
  });

  it('marks a hash id or unrestricted', () => {
    expect(tokenize('#a')).toEqual([{ kind: 'hash', value: 'a', id: true }]);
    expect(tokenize('#1')).toEqual([{ kind: 'hash', value: '1', id: false }]);
  });

  // The corpus's era tokenizes these; the current editor's draft does not.
  // See PROVENANCE.md — this is a decision, not an oversight.
  it('tokenizes the era-specific match and column tokens', () => {
    expect(tokenize('~=')).toEqual([{ kind: 'match', value: '~=' }]);
    expect(tokenize('||')).toEqual([{ kind: 'column' }]);
    expect(tokenize('^=')).toEqual([{ kind: 'match', value: '^=' }]);
  });

  it('tokenizes a unicode range', () => {
    expect(tokenize('U+1')).toEqual([{ kind: 'unicode-range', start: 1, end: 1 }]);
    expect(tokenize('U+1-2')).toEqual([{ kind: 'unicode-range', start: 1, end: 2 }]);
    expect(tokenize('U+1?')).toEqual([{ kind: 'unicode-range', start: 16, end: 31 }]);
  });

  it('resolves an escape in an ident', () => {
    expect(tokenize('\\41')).toEqual([{ kind: 'ident', value: 'A' }]);
  });

  it('strips comments without joining the tokens either side', () => {
    expect(tokenize('a/**/b')).toEqual([
      { kind: 'ident', value: 'a' },
      { kind: 'ident', value: 'b' },
    ]);
  });

  it('never throws, on any input', () => {
    for (const s of ['', '"', 'url(', '\\', '/*', '@', '#', '\\\n', 'U+']) {
      expect(() => tokenize(s)).not.toThrow();
    }
  });
});
