import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { nodeLanguage, nodeDirection, langMatches } from '../src/htmllang.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** The first element with this id, anywhere under the parsed document. */
function byId(src: string, id: string): HtmlElement {
  const root = parseHtml(`<!doctype html>${src}`);
  let hit: HtmlElement | undefined;
  const visit = (n: HtmlNode): void => {
    if (n.kind === 'element' && n.attrs.get('id') === id) { hit ??= n; return; }
    if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment')
      for (const c of n.children) visit(c);
  };
  visit(root);
  if (hit === undefined) throw new Error(`no #${id}`);
  return hit;
}

describe('nodeLanguage', () => {
  it('reads the element\'s own lang', () => {
    expect(nodeLanguage(byId('<p id=t lang=fr>x</p>', 't'))).toBe('fr');
  });

  it('inherits from the nearest ancestor that states one', () => {
    expect(nodeLanguage(byId('<div lang=de><section><p id=t>x</p></section></div>', 't')))
      .toBe('de');
  });

  it('lets a nearer ancestor override a further one', () => {
    expect(nodeLanguage(byId('<div lang=de><span lang=fr><b id=t>x</b></span></div>', 't')))
      .toBe('fr');
  });

  it('is undefined when nothing in scope states a language', () => {
    expect(nodeLanguage(byId('<p id=t>x</p>', 't'))).toBeUndefined();
  });

  it('ignores an EMPTY lang, which HTML uses to mean "unknown"', () => {
    // lang="" explicitly says the language is unknown, so it must not be
    // reported as the literal empty string nor inherited past.
    expect(nodeLanguage(byId('<div lang=de><p id=t lang="">x</p></div>', 't')))
      .toBeUndefined();
  });
});

describe('langMatches — RFC 4647 extended filtering', () => {
  it('matches an exact tag', () => {
    expect(langMatches('en', 'en')).toBe(true);
  });

  it('matches a PREFIX only on a subtag boundary', () => {
    // The whole point of the rule: a naive startsWith says yes to 'english'.
    expect(langMatches('en-US', 'en')).toBe(true);
    expect(langMatches('english', 'en')).toBe(false);
  });

  it('is case-insensitive both ways', () => {
    expect(langMatches('EN-us', 'en-US')).toBe(true);
  });

  it('does not match a shorter tag against a longer range', () => {
    expect(langMatches('en', 'en-US')).toBe(false);
  });

  it('matches a leading wildcard against any first subtag', () => {
    expect(langMatches('de-CH', '*-CH')).toBe(true);
    expect(langMatches('fr-CH', '*-CH')).toBe(true);
    expect(langMatches('de-DE', '*-CH')).toBe(false);
  });

  it('skips intervening subtags for a wildcard range', () => {
    // RFC 4647 §3.3.2: a non-matching tag subtag is skipped and the range
    // retried, which is what lets *-CH reach the region past a script subtag.
    expect(langMatches('zh-Hans-CH', '*-CH')).toBe(true);
  });

  it('matches everything non-empty for a bare wildcard', () => {
    expect(langMatches('en', '*')).toBe(true);
    expect(langMatches('zh-Hans-CN', '*')).toBe(true);
  });

  it('refuses to skip a SINGLETON subtag', () => {
    // §3.3.2 step 3.C.ii: a single-character subtag begins an extension, and
    // skipping past one would match across an extension boundary.
    expect(langMatches('en-a-bbb-x-a-ccc', 'en-*-ccc')).toBe(false);
  });

  it('does not match an empty tag', () => {
    expect(langMatches('', 'en')).toBe(false);
    expect(langMatches('', '*')).toBe(false);
  });
});

describe('nodeDirection', () => {
  it('defaults to ltr with no dir anywhere', () => {
    expect(nodeDirection(byId('<p id=t>x</p>', 't'))).toBe('ltr');
  });

  it('reads an explicit dir on the element', () => {
    expect(nodeDirection(byId('<p id=t dir=rtl>x</p>', 't'))).toBe('rtl');
  });

  it('inherits from the nearest ancestor that states one', () => {
    expect(nodeDirection(byId('<div dir=rtl><section><p id=t>x</p></section></div>', 't')))
      .toBe('rtl');
  });

  it('lets a nearer ancestor override a further one', () => {
    expect(nodeDirection(byId('<div dir=rtl><span dir=ltr><b id=t>x</b></span></div>', 't')))
      .toBe('ltr');
  });

  it('is case-insensitive on the attribute value', () => {
    expect(nodeDirection(byId('<p id=t dir=RTL>x</p>', 't'))).toBe('rtl');
  });

  it('ignores an unknown dir value and inherits instead', () => {
    expect(nodeDirection(byId('<div dir=rtl><p id=t dir=sideways>x</p></div>', 't')))
      .toBe('rtl');
  });
});

describe('nodeDirection — dir=auto', () => {
  it('resolves ltr from a first strong LATIN character', () => {
    expect(nodeDirection(byId('<p id=t dir=auto>hello</p>', 't'))).toBe('ltr');
  });

  it('resolves rtl from a first strong ARABIC character', () => {
    // A wrong answer here is a plausible one, which is why auto is resolved
    // rather than defaulted: an Arabic document would silently read ltr.
    expect(nodeDirection(byId('<p id=t dir=auto>مرحبا</p>', 't')))
      .toBe('rtl');
  });

  it('resolves rtl from a first strong HEBREW character', () => {
    expect(nodeDirection(byId('<p id=t dir=auto>שלום</p>', 't')))
      .toBe('rtl');
  });

  it('skips neutral characters before the first strong one', () => {
    expect(nodeDirection(byId('<p id=t dir=auto>123 — ש</p>', 't'))).toBe('rtl');
  });

  it('falls back to ltr when there is no strong character at all', () => {
    expect(nodeDirection(byId('<p id=t dir=auto>123 456</p>', 't'))).toBe('ltr');
  });

  it('reads text out of descendants', () => {
    expect(nodeDirection(byId('<p id=t dir=auto><span><b>ש</b></span></p>', 't')))
      .toBe('rtl');
  });

  it('SKIPS a descendant that states its own dir', () => {
    // HTML excludes such a subtree from the scan: that text is governed by
    // its own dir, so letting it decide the ancestor's inverts both.
    expect(nodeDirection(byId(
      '<p id=t dir=auto><span dir=ltr>של</span>hello</p>', 't'))).toBe('ltr');
  });

  it('skips script and style content', () => {
    expect(nodeDirection(byId(
      '<div id=t dir=auto><script>var ש = 1;</script>hello</div>', 't'))).toBe('ltr');
  });

  it('gives <bdi> auto by default', () => {
    expect(nodeDirection(byId('<bdi id=t>שלום</bdi>', 't'))).toBe('rtl');
  });

  it('lets an explicit dir on <bdi> win over its auto default', () => {
    expect(nodeDirection(byId('<bdi id=t dir=ltr>של</bdi>', 't'))).toBe('ltr');
  });

  it('resolves auto from the element\'s OWN text, not its parent\'s', () => {
    expect(nodeDirection(byId(
      '<div dir=rtl><p id=t dir=auto>hello</p></div>', 't'))).toBe('ltr');
  });
});
