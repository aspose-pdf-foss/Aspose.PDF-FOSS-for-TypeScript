import { describe, it, expect } from 'vitest';
import {
  decodeEntities, unescapeString, normalizeLabel,
  scanHtmlTag, scanLinkDestination, scanLinkTitle, isPunctuation, isUnicodeWhitespace,
} from '../src/mdscan.js';

const cp = (s: string) => s.codePointAt(0)!;

describe('character classes', () => {
  it('treats ASCII punctuation and Unicode P*/S* alike', () => {
    expect(isPunctuation(cp('!'))).toBe(true);
    expect(isPunctuation(cp('$'))).toBe(true);
    expect(isPunctuation(cp('。'))).toBe(true);
    expect(isPunctuation(cp('a'))).toBe(false);
  });

  it('counts Zs plus tab, LF, FF and CR as whitespace, and nothing else', () => {
    for (const c of [' ', '\t', '\n', '\f', '\r', ' ', '　', ' ']) {
      expect(isUnicodeWhitespace(cp(c)), JSON.stringify(c)).toBe(true);
    }
    expect(isUnicodeWhitespace(cp('​'))).toBe(false); // Cf, not Zs
    expect(isUnicodeWhitespace(cp('a'))).toBe(false);
  });
});

describe('decodeEntities', () => {
  it('resolves named, decimal and hex references', () => {
    expect(decodeEntities('&copy; &#35; &#X22; &#x22;')).toBe('© # " "');
  });

  it('leaves an unknown or unterminated reference literal', () => {
    expect(decodeEntities('&nope; &copy &#; &#x; &')).toBe('&nope; &copy &#; &#x; &');
  });

  it('maps zero, out-of-range and surrogate references to U+FFFD', () => {
    expect(decodeEntities('&#0;')).toBe('�');
    expect(decodeEntities('&#x110000;')).toBe('�');
    expect(decodeEntities('&#xD800;')).toBe('�');
  });
});

describe('unescapeString', () => {
  it('unescapes the 32 ASCII punctuation characters and nothing else', () => {
    expect(unescapeString('\\*\\_\\!\\\\')).toBe('*_!\\');
    expect(unescapeString('\\a\\ \\\n')).toBe('\\a\\ \\\n');
  });

  it('applies escapes before entities, so an escaped ampersand stays literal', () => {
    expect(unescapeString('\\&copy;')).toBe('&copy;');
    expect(unescapeString('&copy;')).toBe('©');
  });
});

describe('normalizeLabel', () => {
  it('strips, collapses internal whitespace, and case folds', () => {
    expect(normalizeLabel('  Foo\n  Bar  ')).toBe('foo bar');
    expect(normalizeLabel('ТОЛПОЙ')).toBe(normalizeLabel('Толпой'));
  });
});

describe('scanHtmlTag', () => {
  it('accepts open tags, close tags, comments, PIs, declarations and CDATA', () => {
    for (const s of ['<a>', '<a href="x" />', '</a>', '<!-- c -->', '<?php ?>', '<!DOCTYPE html>', '<![CDATA[x]]>']) {
      expect(scanHtmlTag(s, 0), s).toBe(s.length);
    }
  });

  it('rejects what is not a tag', () => {
    for (const s of ['<>', '<1a>', '< a>', '</a b>', '<a', '<!--', '<!-- x']) {
      expect(scanHtmlTag(s, 0), s).toBe(-1);
    }
  });

  it('accepts the 0.31.2 comment forms, which 0.30 rejected', () => {
    // `<!-->` and `<!--->` are comments, and a body may contain `--`.
    expect(scanHtmlTag('<!-->', 0)).toBe(5);
    expect(scanHtmlTag('<!--->', 0)).toBe(6);
    expect(scanHtmlTag('<!-- a -- b -->', 0)).toBe(15);
    expect(scanHtmlTag('<!-- a\nb -->', 0)).toBe(12);
  });
});

describe('scanLinkDestination', () => {
  it('reads a pointy-bracket destination, unescaping inside', () => {
    expect(scanLinkDestination('<a b\\>c>', 0)).toEqual({ dest: 'a b>c', end: 8 });
  });

  it('reads a bare destination with balanced parentheses', () => {
    expect(scanLinkDestination('a(b)c d', 0)).toEqual({ dest: 'a(b)c', end: 5 });
  });

  it('rejects a bare destination with unbalanced parentheses', () => {
    expect(scanLinkDestination('a(b', 0)).toBeUndefined();
  });

  it('rejects a pointy-bracket destination containing a newline', () => {
    expect(scanLinkDestination('<a\nb>', 0)).toBeUndefined();
  });
});

describe('scanLinkTitle', () => {
  it('reads all three quotings', () => {
    expect(scanLinkTitle('"t"', 0)).toEqual({ title: 't', end: 3 });
    expect(scanLinkTitle("'t'", 0)).toEqual({ title: 't', end: 3 });
    expect(scanLinkTitle('(t)', 0)).toEqual({ title: 't', end: 3 });
  });

  it('unescapes and decodes entities inside', () => {
    expect(scanLinkTitle('"a\\"b&copy;"', 0)).toEqual({ title: 'a"b©', end: 12 });
  });

  it('rejects an unclosed title and a parenthesised title containing (', () => {
    expect(scanLinkTitle('"t', 0)).toBeUndefined();
    expect(scanLinkTitle('(a(b)', 0)).toBeUndefined();
  });
});
