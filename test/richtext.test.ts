import { describe, it, expect } from 'vitest';
import { richTextToPlain } from '../src/richtext.js';

describe('richTextToPlain — the block-separator rule', () => {
  it('breaks between block elements rather than running them together', () => {
    // THE CASE THE FEATURE EXISTS FOR. Concatenating descendant text turns
    // `<p>a</p><p>b</p>` into 'ab', so a query for 'ab' gets a false hit on
    // text that never appeared.
    expect(richTextToPlain('<p>a</p><p>b</p>')).toBe('a\nb');
  });

  it('does NOT break between inline elements', () => {
    // The opposite error: separating every sibling turns 'axy' into 'a x y',
    // so a query for 'axy' stops matching text that IS there.
    expect(richTextToPlain('<p>a<b>x</b>y</p>')).toBe('axy');
    expect(richTextToPlain('<span>a</span><span>b</span>')).toBe('ab');
  });

  it('treats br as a break even though it carries no content', () => {
    expect(richTextToPlain('<p>a<br/>b</p>')).toBe('a\nb');
  });

  it('breaks between list items', () => {
    expect(richTextToPlain('<ul><li>one</li><li>two</li></ul>')).toBe('one\ntwo');
  });

  it('collapses the indentation a real producer writes between tags', () => {
    // Whitespace between tags is layout, not content. Without collapsing, the
    // output is full of the newlines and spaces of the source markup.
    const rc = '<body>\n  <p>hello</p>\n  <p>world</p>\n</body>';
    expect(richTextToPlain(rc)).toBe('hello\nworld');
  });

  it('collapses runs of whitespace inside a paragraph to one space', () => {
    expect(richTextToPlain('<p>a   \n  b</p>')).toBe('a b');
  });
});

describe('richTextToPlain — input shapes', () => {
  it('accepts a multi-root fragment, which has no single root element', () => {
    // parseXml returns ONE root, so a bare fragment must be wrapped before
    // parsing -- otherwise the second paragraph is silently dropped rather
    // than reported, which is worse than a throw.
    expect(richTextToPlain('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(richTextToPlain('<p>only</p>')).toBe('only');
  });

  it('accepts the rooted document a real /RC usually is', () => {
    const rc = '<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml">'
      + '<p>the report</p></body>';
    expect(richTextToPlain(rc)).toBe('the report');
  });

  it('resolves entities and CDATA rather than leaking them', () => {
    expect(richTextToPlain('<p>a &amp; b</p>')).toBe('a & b');
    expect(richTextToPlain('<p><![CDATA[x < y]]></p>')).toBe('x < y');
  });

  it('does not mistake a > inside an attribute for a tag end', () => {
    // The reason this uses xml.ts rather than stripping angle brackets.
    expect(richTextToPlain('<p title="a>b">text</p>')).toBe('text');
  });

  it('drops comments', () => {
    expect(richTextToPlain('<p>a<!-- note -->b</p>')).toBe('ab');
  });
});

describe('richTextToPlain — degradation', () => {
  it('returns undefined on malformed markup rather than throwing', () => {
    // parseXml throws PdfParseError, and /RC from a real producer is not
    // guaranteed well formed. This must never throw out of a search.
    expect(() => richTextToPlain('<p>unclosed')).not.toThrow();
    expect(richTextToPlain('<p>unclosed')).toBeUndefined();
    expect(richTextToPlain('<a></b>')).toBeUndefined();
  });

  it('returns undefined rather than the raw markup', () => {
    // Falling back to the markup would reinstate the exact defect this fixes:
    // a caller searching for 'p' would match the tag name. Asserted as an
    // explicit undefined, since `not.toContain` on undefined is not a check --
    // it throws on the assertion itself and says nothing about the value.
    const out = richTextToPlain('<p title="x">unclosed');
    expect(out).toBeUndefined();
    expect(typeof out === 'string' && out.includes('<')).toBe(false);
  });

  it('yields an empty string for markup carrying no text', () => {
    expect(richTextToPlain('<p></p>')).toBe('');
    expect(richTextToPlain('')).toBe('');
  });
});
