import { describe, it, expect } from 'vitest';
import { HtmlTokenizer, TokenizerState, preprocess } from '../src/htmltoken.js';
import type { HtmlToken } from '../src/htmltoken.js';

/** Drain a tokenizer to EOF. */
function drain(src: string): { tokens: HtmlToken[]; errors: unknown[] } {
  const t = new HtmlTokenizer(src);
  const tokens: HtmlToken[] = [];
  for (;;) { const tok = t.next(); if (tok.kind === 'eof') break; tokens.push(tok); }
  return { tokens, errors: t.errors };
}

function text(src: string): string {
  return drain(src).tokens
    .filter((t) => t.kind === 'character')
    .map((t) => (t as { data: string }).data)
    .join('');
}

/** Narrow a token to a tag, so the assertions below need no cast. */
function tag(t: HtmlToken | undefined): { name: string; attrs: Map<string, string>; selfClosing: boolean } {
  if (t === undefined || (t.kind !== 'startTag' && t.kind !== 'endTag')) {
    throw new Error(`expected a tag token, got ${t === undefined ? 'nothing' : t.kind}`);
  }
  return t;
}

/** Narrow a token to a doctype, so the assertions below need no cast. */
function doctype(t: HtmlToken | undefined): {
  name?: string; publicId?: string; systemId?: string; forceQuirks: boolean;
} {
  if (t === undefined || t.kind !== 'doctype') {
    throw new Error(`expected a doctype token, got ${t === undefined ? 'nothing' : t.kind}`);
  }
  return t;
}

describe('preprocessing', () => {
  // Runs BEFORE tokenizing, and is where the line/col counter is seeded. Wrong,
  // every position after the first CRLF is off while tokens stay perfect.
  it('collapses CRLF and a lone CR to LF', () => {
    expect(preprocess('a\r\nb')).toBe('a\nb');
    expect(preprocess('a\rb')).toBe('a\nb');
    expect(preprocess('a\r\r\nb')).toBe('a\n\nb');
    expect(preprocess('a\nb')).toBe('a\nb');
  });
});

describe('the tokenizer skeleton', () => {
  it('emits characters and then EOF, and EOF is idempotent', () => {
    const t = new HtmlTokenizer('hi');
    expect(t.next()).toEqual({ kind: 'character', data: 'h' });
    expect(t.next()).toEqual({ kind: 'character', data: 'i' });
    expect(t.next()).toEqual({ kind: 'eof' });
    expect(t.next()).toEqual({ kind: 'eof' });
  });

  // Columns count UTF-16 CODE UNITS, so an astral character advances by two.
  // This is not what a code-point count would give, and it is not a choice —
  // the vendored expectations say so, in five test3.test cases that all agree
  // (an eof-in-comment after U+100000 lands at col 7 of a 6-code-point input).
  // Asserted here because the rule reads backwards: this file's own comment
  // used to claim the opposite, and passed, because both halves were ours.
  it('counts columns in UTF-16 code units', () => {
    const { errors } = drain('\u{1F600}\u0000');
    expect(errors).toEqual([{ code: 'unexpected-null-character', line: 1, col: 3 }]);
    // A BMP character still advances by one.
    expect(drain('\u00e9\u0000').errors).toEqual([
      { code: 'unexpected-null-character', line: 1, col: 2 },
    ]);
  });

  // A LONE CR is the discriminating case, and it took a mutation to find that.
  // With CRLF, skipping preprocessing gives the IDENTICAL position — the CR
  // advances the column and the LF still breaks the line — so a CRLF fixture
  // passes whether or not preprocessing runs. A lone CR breaks the line only
  // after preprocessing, so the two readings differ in both line and column.
  it('counts lines from the preprocessed source', () => {
    expect(drain('a\rb\u0000').errors).toEqual([
      { code: 'unexpected-null-character', line: 2, col: 2 },
    ]);
    expect(drain('a\r\nb\u0000').errors).toEqual([
      { code: 'unexpected-null-character', line: 2, col: 2 },
    ]);
  });

  // The other half preprocessing buys, equally invisible to a CRLF-only
  // fixture: a CR must not survive into the token stream as its own character.
  it('emits no CR of its own', () => {
    expect(text('a\rb')).toBe('a\nb');
    expect(text('a\r\nb')).toBe('a\nb');
  });

  it('passes NUL through in the Data state, with an error', () => {
    expect(text('a\u0000b')).toBe('a\u0000b');
  });

  it('never throws, on any input', () => {
    for (const s of ['', '<', '</', '<!', '<!-', '&', '&#', '\u0000', '<\u{1F600}']) {
      expect(() => drain(s)).not.toThrow();
    }
  });

  it('takes PLAINTEXT from setState and never leaves it', () => {
    const t = new HtmlTokenizer('<p>&amp;');
    t.setState(TokenizerState.PLAINTEXT);
    let out = '';
    for (;;) {
      const tok = t.next();
      if (tok.kind === 'eof') break;
      out += (tok as { data: string }).data;
    }
    expect(out).toBe('<p>&amp;');
  });
});

describe('tag states', () => {
  it('tokenizes a start tag with quoted, unquoted and valueless attributes', () => {
    const { tokens } = drain(`<h a='b' c="d" e=f g>`);
    expect(tokens).toEqual([{
      kind: 'startTag', name: 'h', selfClosing: false,
      attrs: new Map([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', '']]),
    }]);
  });

  it('lowercases a tag name and an attribute name', () => {
    const { tokens } = drain('<DIV CLASS=x>');
    expect(tag(tokens[0]).name).toBe('div');
    expect([...tag(tokens[0]).attrs.keys()]).toEqual(['class']);
  });

  it('marks a self-closing tag', () => {
    expect(tag(drain('<br/>').tokens[0]).selfClosing).toBe(true);
  });

  // First wins. Map.set semantics keep the LAST, which is the natural mistake,
  // and the error fires where the NAME ends — the '=' at col 11 — not at emit.
  it('keeps the first of a duplicate attribute and errors at the name', () => {
    const { tokens, errors } = drain(`<h a='b' a='d'>`);
    expect(tag(tokens[0]).attrs).toEqual(new Map([['a', 'b']]));
    expect(errors).toEqual([{ code: 'duplicate-attribute', line: 1, col: 11 }]);
  });

  it('emits no token at all for </>', () => {
    const { tokens, errors } = drain('</>');
    expect(tokens).toEqual([]);
    expect(errors).toEqual([{ code: 'missing-end-tag-name', line: 1, col: 3 }]);
  });

  it('emits the literal characters for <>', () => {
    expect(text('<>')).toBe('<>');
    expect(drain('<>').errors).toEqual([
      { code: 'invalid-first-character-of-tag-name', line: 1, col: 2 },
    ]);
  });

  it('drops an end tag\u2019s attributes but keeps the token', () => {
    const { tokens, errors } = drain(`<h></h a='b'>`);
    expect(tokens[1]).toEqual({ kind: 'endTag', name: 'h', attrs: new Map(), selfClosing: false });
    expect(errors).toEqual([{ code: 'end-tag-with-attributes', line: 1, col: 13 }]);
  });

  it('reports a missing space between attributes at the offending character', () => {
    expect(drain(`<h a='b'c='d'>`).errors).toEqual([
      { code: 'missing-whitespace-between-attributes', line: 1, col: 9 },
    ]);
  });

  it('treats an unterminated tag as EOF in tag, emitting nothing', () => {
    const { tokens, errors } = drain('<div a=b');
    expect(tokens).toEqual([]);
    expect(errors).toEqual([{ code: 'eof-in-tag', line: 1, col: 9 }]);
  });

  // Until whatwg/html#12118 (merged 2026-06-25) this case asserted a bogus
  // comment `?php ?` plus unexpected-question-mark-instead-of-tag-name. Both
  // are gone: `php` is a usable target, so these bytes are a processing
  // instruction and there is no parse error at all. See test/htmltoken-pi.test.ts
  // for the five states, and zch2.9 for why the html5lib pin still disagrees.
  it('turns <? into a processing instruction', () => {
    const { tokens, errors } = drain('<?php ?>');
    expect(tokens).toEqual([{ kind: 'pi', target: 'php', data: '' }]);
    expect(errors).toEqual([]);
  });
});

describe('comments', () => {
  it('tokenizes a plain comment', () => {
    expect(drain('<!--x-->').tokens).toEqual([{ kind: 'comment', data: 'x' }]);
  });

  it('reports an abruptly closed empty comment', () => {
    const { tokens, errors } = drain('<!-->');
    expect(tokens).toEqual([{ kind: 'comment', data: '' }]);
    expect(errors).toEqual([{ code: 'abrupt-closing-of-empty-comment', line: 1, col: 5 }]);
  });

  // The one peek-based error site: <!DOC> fires at the D it only looked at.
  it('reports an incorrectly opened comment at the peeked character', () => {
    const { tokens, errors } = drain('<!DOC>');
    expect(tokens).toEqual([{ kind: 'comment', data: 'DOC' }]);
    expect(errors).toEqual([{ code: 'incorrectly-opened-comment', line: 1, col: 3 }]);
  });

  it('keeps a double hyphen inside a comment body', () => {
    expect(drain('<!---- >').tokens).toEqual([{ kind: 'comment', data: '-- >' }]);
    expect(drain('<!---- >').errors).toEqual([{ code: 'eof-in-comment', line: 1, col: 9 }]);
  });

  it('reports a nested comment', () => {
    expect(drain('<!--<!--x-->').errors[0]).toEqual({
      code: 'nested-comment', line: 1, col: 9,
    });
  });

  it('reports an incorrectly closed comment', () => {
    const { tokens, errors } = drain('<!--x--!>');
    expect(tokens).toEqual([{ kind: 'comment', data: 'x' }]);
    expect(errors).toEqual([{ code: 'incorrectly-closed-comment', line: 1, col: 9 }]);
  });
});

describe('DOCTYPE', () => {
  it('lowercases the name and clears force-quirks', () => {
    expect(drain('<!DOCTYPE HtMl>').tokens).toEqual([{
      kind: 'doctype', name: 'html', publicId: undefined, systemId: undefined, forceQuirks: false,
    }]);
  });

  // The suite's DOCTYPE 'correctness' field is !forceQuirks. Reading it as the
  // flag itself inverts every doctype case while every identifier still
  // matches, so the polarity is asserted on its own.
  it('sets force-quirks on EOF in doctype', () => {
    const { tokens, errors } = drain('<!DOCTYPE HtMl');
    expect(doctype(tokens[0]).forceQuirks).toBe(true);
    expect(doctype(tokens[0]).name).toBe('html');
    expect(errors).toEqual([{ code: 'eof-in-doctype', line: 1, col: 15 }]);
  });

  // The NAME is lowercased; the identifiers are NOT.
  it('keeps the case of a public and a system identifier', () => {
    const { tokens } = drain('<!DOCTYPE HtMl PUBLIC "FooBar" "BazQux">');
    expect(tokens[0]).toEqual({
      kind: 'doctype', name: 'html', publicId: 'FooBar', systemId: 'BazQux', forceQuirks: false,
    });
  });

  it('reads a SYSTEM-only identifier', () => {
    const { tokens } = drain('<!DOCTYPE html SYSTEM "BazQux">');
    expect(doctype(tokens[0]).systemId).toBe('BazQux');
    expect(doctype(tokens[0]).publicId).toBeUndefined();
    expect(doctype(tokens[0]).forceQuirks).toBe(false);
  });

  it('reports a missing name', () => {
    const { tokens, errors } = drain('<!DOCTYPE>');
    expect(doctype(tokens[0]).forceQuirks).toBe(true);
    expect(errors).toEqual([{ code: 'missing-doctype-name', line: 1, col: 10 }]);
  });

  it('reports an unrecognised sequence after the name and force-quirks', () => {
    const { tokens, errors } = drain('<!DOCTYPE html FOO>');
    expect(doctype(tokens[0]).forceQuirks).toBe(true);
    expect(errors).toEqual([
      { code: 'invalid-character-sequence-after-doctype-name', line: 1, col: 16 },
    ]);
  });
});

describe('CDATA outside foreign content', () => {
  // The two markup-declaration-open errors report at DIFFERENT ends of what
  // they looked at, and the difference is not cosmetic: this branch consumed
  // the seven characters of '[CDATA[' and reports at the LAST of them (col 9),
  // while incorrectly-opened-comment consumed nothing and reports at the one
  // character it peeked (col 3). Asserted side by side for that reason.
  it('becomes a bogus comment, reported at the end of the sequence', () => {
    const { tokens, errors } = drain('<![CDATA[x]]>');
    expect(tokens).toEqual([{ kind: 'comment', data: '[CDATA[x]]' }]);
    expect(errors).toEqual([{ code: 'cdata-in-html-content', line: 1, col: 9 }]);
    expect(drain('<!DOC>').errors).toEqual([
      { code: 'incorrectly-opened-comment', line: 1, col: 3 },
    ]);
  });
});

function drainFrom(src: string, state: TokenizerState, lastStartTag: string) {
  const t = new HtmlTokenizer(src);
  t.setState(state);
  t.setLastStartTag(lastStartTag);
  const tokens: HtmlToken[] = [];
  for (;;) { const tok = t.next(); if (tok.kind === 'eof') break; tokens.push(tok); }
  return { tokens, errors: t.errors };
}

function textOf(tokens: HtmlToken[]): string {
  return tokens
    .filter((t) => t.kind === 'character')
    .map((t) => (t as { data: string }).data)
    .join('');
}

describe('alternate content models', () => {
  it('closes RCDATA on the appropriate end tag, case-insensitively', () => {
    const { tokens } = drainFrom('foo</XMP>', TokenizerState.RCDATA, 'xmp');
    expect(textOf(tokens)).toBe('foo');
    expect(tokens[tokens.length - 1]).toEqual({
      kind: 'endTag', name: 'xmp', attrs: new Map(), selfClosing: false,
    });
  });

  // A non-matching end tag is not a tag at all: the buffered '</name' comes
  // back out as characters, which is what keeps '</div>' inside a <textarea>
  // visible.
  it('emits a non-matching end tag as characters', () => {
    const { tokens } = drainFrom('foo</div>', TokenizerState.RCDATA, 'xmp');
    expect(tokens.every((t) => t.kind === 'character')).toBe(true);
    expect(textOf(tokens)).toBe('foo</div>');
  });

  // One case label apart, and nothing renders the difference until a <title>
  // shows the five literal characters &amp;.
  it('resolves references in RCDATA and not in RAWTEXT', () => {
    expect(textOf(drainFrom('&amp;</xmp>', TokenizerState.RCDATA, 'xmp').tokens)).toBe('&');
    expect(textOf(drainFrom('&amp;</xmp>', TokenizerState.RAWTEXT, 'xmp').tokens)).toBe('&amp;');
  });

  it('replaces NUL with U+FFFD in RAWTEXT but passes it through in Data', () => {
    expect(textOf(drainFrom('\u0000</xmp>', TokenizerState.RAWTEXT, 'xmp').tokens)).toBe('\ufffd');
    expect(text('\u0000')).toBe('\u0000');
  });

  it('keeps a commented close tag as text in RAWTEXT', () => {
    const { tokens } = drainFrom('foo<!--</xmp>--></xmp>', TokenizerState.RAWTEXT, 'xmp');
    expect(tokens.filter((t) => t.kind === 'endTag').length).toBe(2);
    expect(textOf(tokens)).toBe('foo<!---->');
  });

  it('handles script data double escaping', () => {
    const { tokens } = drainFrom(
      '<!--<script></script>--></script>', TokenizerState.ScriptData, 'script',
    );
    expect(tokens[tokens.length - 1]).toEqual({
      kind: 'endTag', name: 'script', attrs: new Map(), selfClosing: false,
    });
    expect(textOf(tokens)).toBe('<!--<script></script>-->');
  });

  it('reports EOF inside script-comment-like text', () => {
    const { errors } = drainFrom('<!--', TokenizerState.ScriptData, 'script');
    expect(errors).toEqual([
      { code: 'eof-in-script-html-comment-like-text', line: 1, col: 5 },
    ]);
  });
});

describe('the CDATA routing seam', () => {
  function tokensOf(src: string, foreign: boolean) {
    const t = new HtmlTokenizer(src, { adjustedCurrentNodeIsForeign: () => foreign });
    const out: HtmlToken[] = [];
    for (;;) {
      const tok = t.next();
      if (tok.kind === 'eof') break;
      out.push(tok);
    }
    return { tokens: out, errors: t.errors };
  }

  // In HTML content `<![CDATA[` is a bogus comment plus a parse error. This
  // is zch2.1.1's behaviour and must not move.
  it('makes a bogus comment in HTML content', () => {
    const { tokens, errors } = tokensOf('<![CDATA[a]]>', false);
    expect(tokens).toEqual([{ kind: 'comment', data: '[CDATA[a]]' }]);
    expect(errors.map((e) => e.code)).toContain('cdata-in-html-content');
  });

  // In foreign content the same bytes are a CDATA section: its contents come
  // through as CHARACTERS and there is no parse error at all.
  it('makes character tokens in foreign content', () => {
    const { tokens, errors } = tokensOf('<![CDATA[a]]>', true);
    expect(tokens.map((t) => (t as { data: string }).data).join('')).toBe('a');
    expect(tokens.every((t) => t.kind === 'character')).toBe(true);
    expect(errors.map((e) => e.code)).not.toContain('cdata-in-html-content');
  });

  // The default is what keeps zch2.1.1's 7,032 cases untouched.
  it('defaults to HTML content when no callback is given', () => {
    const t = new HtmlTokenizer('<![CDATA[a]]>');
    expect(t.next()).toEqual({ kind: 'comment', data: '[CDATA[a]]' });
  });

  // Asked at the moment of the decision, never cached: the stack changes
  // between tokens, so a flag read once is right until a <svg> opens.
  it('asks the callback at each decision rather than caching it', () => {
    let foreign = false;
    const t = new HtmlTokenizer('<![CDATA[a]]><![CDATA[b]]>', {
      adjustedCurrentNodeIsForeign: () => foreign,
    });
    expect(t.next()).toEqual({ kind: 'comment', data: '[CDATA[a]]' });
    foreign = true;
    expect(t.next()).toEqual({ kind: 'character', data: 'b' });
  });
});
