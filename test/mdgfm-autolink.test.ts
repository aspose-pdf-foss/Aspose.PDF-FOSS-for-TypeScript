import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdInline } from '../src/mdast.js';

function inlines(src: string, gfm = true): MdInline[] {
  const first = parseMarkdown(src, { gfm }).children[0];
  if (first.type !== 'paragraph') throw new Error(`expected a paragraph, got ${first.type}`);
  return first.children;
}

function link(dest: string, text: string): MdInline {
  return { type: 'link', destination: dest, title: '', children: [{ type: 'text', value: text }] };
}

describe('extended autolinks', () => {
  it('inserts http:// for a www. link', () => {
    expect(inlines('www.commonmark.org')).toEqual([link('http://www.commonmark.org', 'www.commonmark.org')]);
  });

  it('keeps the scheme of a bare url', () => {
    expect(inlines('http://commonmark.org')).toEqual([link('http://commonmark.org', 'http://commonmark.org')]);
  });

  it('prefixes mailto: for a bare address', () => {
    expect(inlines('foo@bar.baz')).toEqual([link('mailto:foo@bar.baz', 'foo@bar.baz')]);
  });

  it('does not double the scheme on an explicit mailto:', () => {
    expect(inlines('mailto:foo@bar.baz')).toEqual([link('mailto:foo@bar.baz', 'mailto:foo@bar.baz')]);
  });

  it('is off unless gfm is asked for', () => {
    expect(inlines('www.commonmark.org', false)).toEqual([{ type: 'text', value: 'www.commonmark.org' }]);
  });

  it('never fires inside a link', () => {
    expect(inlines('[www.a.com](/x)')).toEqual([
      { type: 'link', destination: '/x', title: '', children: [{ type: 'text', value: 'www.a.com' }] },
    ]);
  });

  it('never fires inside a code span', () => {
    expect(inlines('`www.a.com`')).toEqual([{ type: 'code', value: 'www.a.com' }]);
  });

  it('does not start mid-word', () => {
    expect(inlines('xwww.a.com')).toEqual([{ type: 'text', value: 'xwww.a.com' }]);
    expect(inlines('xhttp://a.com')).toEqual([{ type: 'text', value: 'xhttp://a.com' }]);
  });

  // The domain needs a period, and the one in `www.` counts — so a single
  // segment after the prefix is enough, and a bare `www.` is not.
  it('counts the period in www. toward the domain', () => {
    expect(inlines('www.commonmark')).toEqual([link('http://www.commonmark', 'www.commonmark')]);
  });

  it('rejects a bare www. with nothing after it', () => {
    expect(inlines('www.')).toEqual([{ type: 'text', value: 'www.' }]);
  });

  it('rejects an underscore in either of the last two segments', () => {
    expect(inlines('www.xxx.yyy._zzz')).toEqual([{ type: 'text', value: 'www.xxx.yyy._zzz' }]);
    expect(inlines('www._xxx.yyy.zzz')[0].type).toBe('link');
  });

  it('fires across an emphasis boundary on its own text node', () => {
    expect(inlines('*x* www.a.com')).toEqual([
      { type: 'emph', children: [{ type: 'text', value: 'x' }] },
      { type: 'text', value: ' ' },
      link('http://www.a.com', 'www.a.com'),
    ]);
  });

  // The '&' arrives as its own text node from the entity scanner; the pass sees
  // one merged run because NodeList.collect already joins adjacent text nodes.
  it('spans a text node boundary left by a failed entity', () => {
    expect(inlines('www.a.com/x?q=1&hl=en')).toEqual([
      link('http://www.a.com/x?q=1&hl=en', 'www.a.com/x?q=1&hl=en'),
    ]);
  });
});
