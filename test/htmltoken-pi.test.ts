import { describe, it, expect } from 'vitest';
import { HtmlTokenizer } from '../src/htmltoken.js';
import type { HtmlToken } from '../src/htmltoken.js';

/** Drain a tokenizer to EOF, keeping the parse errors it reported. */
function drain(src: string): { tokens: HtmlToken[]; codes: string[] } {
  const t = new HtmlTokenizer(src);
  const tokens: HtmlToken[] = [];
  for (;;) { const tok = t.next(); if (tok.kind === 'eof') break; tokens.push(tok); }
  return { tokens, codes: (t.errors as { code: string }[]).map((e) => e.code) };
}

/** Narrow to the processing instruction token, so assertions need no cast. */
function pi(t: HtmlToken | undefined): { target: string; data: string } {
  if (t === undefined || t.kind !== 'pi')
    throw new Error(`expected a pi token, got ${t === undefined ? 'nothing' : t.kind}`);
  return { target: t.target, data: t.data };
}

function comment(t: HtmlToken | undefined): string {
  if (t === undefined || t.kind !== 'comment')
    throw new Error(`expected a comment token, got ${t === undefined ? 'nothing' : t.kind}`);
  return t.data;
}

// The HTML Standard gained processing instructions in whatwg/html#12118,
// merged 2026-06-25: `<?target data?>` is a real PI rather than a bogus
// comment. Tag open's `?` branch no longer reports
// unexpected-question-mark-instead-of-tag-name at all.
describe('processing instruction open state', () => {
  it('makes a PI from a target and no data', () => {
    const { tokens, codes } = drain('<?something>');
    expect(pi(tokens[0])).toEqual({ target: 'something', data: '' });
    expect(codes).toEqual([]);
  });

  it('reports no parse error for what used to be a question-mark error', () => {
    // The whole point of the spec change: this is now well-formed input.
    expect(drain('<?something>').codes)
      .not.toContain('unexpected-question-mark-instead-of-tag-name');
  });

  it('accepts an underscore as the first target character', () => {
    // The target may START with an ASCII alpha OR U+005F, which is wider than
    // the tag-name rule it otherwise mirrors.
    expect(pi(drain('<?_x>').tokens[0])).toEqual({ target: '_x', data: '' });
  });

  it('falls back to a bogus comment KEEPING the question mark', () => {
    // WPT expects `<!-- ?# -->` for this, so the `?` is part of the comment
    // even though tag open consumed it. A conversion that dropped it would
    // give `#` — a plausible comment, and the wrong one.
    const { tokens, codes } = drain('<?#');
    expect(comment(tokens[0])).toBe('?#');
    expect(codes).toContain('invalid-first-character-of-processing-instruction-target');
  });

  it('treats whitespace straight after <? as no target at all', () => {
    expect(comment(drain('<? x>').tokens[0])).toBe('? x');
  });

  it('reports eof-in-processing-instruction for a bare <? at EOF', () => {
    const { tokens, codes } = drain('<?');
    expect(codes).toContain('eof-in-processing-instruction');
    // Nothing is emitted: the spec emits the EOF token, never the buffer.
    expect(tokens).toHaveLength(0);
  });
});

describe('processing instruction target state', () => {
  it('takes alphanumerics, hyphens and underscores into the target', () => {
    expect(pi(drain('<?a-b_c9>').tokens[0])).toEqual({ target: 'a-b_c9', data: '' });
  });

  it('ends the target at whitespace and reads the rest as data', () => {
    expect(pi(drain('<?target the data>').tokens[0]))
      .toEqual({ target: 'target', data: 'the data' });
  });

  it('refuses xml as a target, case-insensitively', () => {
    // Blocklisted so a page cannot smuggle in an xml-stylesheet load.
    const { tokens, codes } = drain('<?xml version="1.0">');
    expect(comment(tokens[0])).toBe('?xml version="1.0"');
    expect(codes).toContain('disallowed-processing-instruction-target');
    expect(comment(drain('<?XmL foo>').tokens[0])).toBe('?XmL foo');
  });

  it('refuses xml-stylesheet as a target', () => {
    const { tokens, codes } = drain('<?xml-stylesheet href="a">');
    expect(comment(tokens[0])).toBe('?xml-stylesheet href="a"');
    expect(codes).toContain('disallowed-processing-instruction-target');
  });

  it('allows a target that merely starts with xml', () => {
    // `xmlfoo` is not `xml`, and an over-eager prefix test would refuse it.
    expect(pi(drain('<?xmlfoo>').tokens[0])).toEqual({ target: 'xmlfoo', data: '' });
  });

  it('falls back to a bogus comment on a character the target cannot hold', () => {
    const { tokens, codes } = drain('<?foo!bar>');
    expect(comment(tokens[0])).toBe('?foo!bar');
    expect(codes).toContain('invalid-processing-instruction-target');
  });

  it('reports eof-in-processing-instruction inside a target', () => {
    const { tokens, codes } = drain('<?foo');
    expect(codes).toContain('eof-in-processing-instruction');
    expect(tokens).toHaveLength(0);
  });
});

describe('after processing instruction target state', () => {
  it('skips the whitespace between target and data', () => {
    expect(pi(drain('<?t   \t\n data>').tokens[0])).toEqual({ target: 't', data: 'data' });
  });

  it('closes on > straight after the target', () => {
    expect(pi(drain('<?t>').tokens[0])).toEqual({ target: 't', data: '' });
  });
});

describe('processing instruction data state', () => {
  it('closes on a bare >, as a bogus comment does', () => {
    expect(pi(drain('<?t a>b').tokens[0])).toEqual({ target: 't', data: 'a' });
  });

  it('closes on ?> and drops that question mark', () => {
    expect(pi(drain('<?t a?>').tokens[0])).toEqual({ target: 't', data: 'a' });
  });

  it('keeps a question mark that is not followed by >', () => {
    // The questionable state's whole reason for existing: only `?>` closes.
    expect(pi(drain('<?t a?b>').tokens[0])).toEqual({ target: 't', data: 'a?b' });
  });

  it('keeps a run of question marks before the closer', () => {
    expect(pi(drain('<?t a??>').tokens[0])).toEqual({ target: 't', data: 'a?' });
  });

  it('reports eof-in-processing-instruction in the data', () => {
    const { tokens, codes } = drain('<?t data');
    expect(codes).toContain('eof-in-processing-instruction');
    expect(tokens).toHaveLength(0);
  });

  it('reports eof-in-processing-instruction after a trailing question mark', () => {
    expect(drain('<?t a?').codes).toContain('eof-in-processing-instruction');
  });
});
