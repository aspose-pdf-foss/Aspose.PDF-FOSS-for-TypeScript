import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, selectAll, specificityOf } from '../src/cssselect.js';

/** The ids of every element matching `sel` in `src`, in document order. */
function ids(src: string, sel: string): string[] {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`selector did not parse: ${sel}`);
  return selectAll(parseHtml(`<!doctype html>${src}`), list)
    .map((e) => e.attrs.get('id') ?? '');
}

describe(':lang() parsing', () => {
  it('parses an ident argument', () => {
    expect(parseSelectorText('p:lang(en)')).not.toBeNull();
  });

  it('parses a tag with a region subtag', () => {
    expect(parseSelectorText('p:lang(de-CH)')).not.toBeNull();
  });

  it('REFUSES the forms Selectors 4 defines and Blink does not implement', () => {
    // Measured against Chrome 152, which accepts ONLY a bare ident: it
    // refuses the comma list, every wildcard spelling, and even a quoted
    // `:lang("en")`. Accepting them would make us style content that no
    // browser styles — an unsupported selector invalidates its whole list,
    // so `p, p:lang("*-CH")` is entirely dropped by Blink — and the Blink
    // corpus cannot see the divergence, because Blink refuses the selector
    // rather than answering it.
    expect(parseSelectorText('p:lang(en, fr)')).toBeNull();
    expect(parseSelectorText('p:lang("en")')).toBeNull();
    expect(parseSelectorText('p:lang("*-CH")')).toBeNull();
    expect(parseSelectorText('p:lang(*-CH)')).toBeNull();
  });

  it('REFUSES an empty argument, invalidating the whole list', () => {
    expect(parseSelectorText('p:lang()')).toBeNull();
    expect(parseSelectorText('p, p:lang()')).toBeNull();
  });

  it('refuses a non-ident, non-string argument', () => {
    expect(parseSelectorText('p:lang(1)')).toBeNull();
  });

  it('weighs as a class, like every other pseudo-class', () => {
    const [sel] = parseSelectorText('p:lang(en)')!;
    expect(specificityOf(sel)).toEqual([0, 1, 1]);
  });
});

describe(':lang() matching', () => {
  const doc = '<p id=a lang=en>a</p><p id=b lang=en-US>b</p>'
    + '<p id=c lang=fr>c</p><p id=d>d</p>';

  it('matches an exact tag and a subtag-boundary prefix', () => {
    expect(ids(doc, 'p:lang(en)')).toEqual(['a', 'b']);
  });

  it('does not match a tag that merely starts with the range', () => {
    // The rule a startsWith gets wrong.
    expect(ids('<p id=a lang=english>a</p>', 'p:lang(en)')).toEqual([]);
  });

  it('matches through inheritance from an ancestor', () => {
    expect(ids('<div lang=de><p id=a>a</p></div>', 'p:lang(de)')).toEqual(['a']);
  });

  it('matches nothing when no language is in scope', () => {
    // An element with no lang has no language, so it matches no range.
    expect(ids('<p id=a>a</p>', 'p:lang(en)')).toEqual([]);
  });

  it('matches a full tag exactly and not a sibling region', () => {
    const swiss = '<p id=a lang=de-CH>a</p><p id=b lang=fr-CH>b</p>'
      + '<p id=c lang=de-DE>c</p>';
    expect(ids(swiss, 'p:lang(de-CH)')).toEqual(['a']);
    // The prefix rule still applies below the region: `de` reaches both.
    expect(ids(swiss, 'p:lang(de)')).toEqual(['a', 'c']);
  });

  it('is case-insensitive on both the tag and the range', () => {
    expect(ids('<p id=a lang=EN-us>a</p>', 'p:lang(en-US)')).toEqual(['a']);
  });
});

describe(':dir() parsing', () => {
  it('parses ltr and rtl', () => {
    expect(parseSelectorText('p:dir(ltr)')).not.toBeNull();
    expect(parseSelectorText('p:dir(rtl)')).not.toBeNull();
  });

  it('accepts an UNKNOWN direction as valid, matching nothing', () => {
    // Selectors 4 makes an unknown directionality never-matching, NOT
    // invalid. Getting that backwards costs the selector's whole list, so
    // `p, p:dir(sideways)` would drop its `p` half and render unstyled.
    expect(parseSelectorText('p:dir(sideways)')).not.toBeNull();
    expect(ids('<p id=a dir=ltr>a</p>', 'p:dir(sideways)')).toEqual([]);
    expect(ids('<p id=a dir=ltr>a</p>', 'p, p:dir(sideways)')).toEqual(['a']);
  });

  it('REFUSES an empty argument', () => {
    expect(parseSelectorText('p:dir()')).toBeNull();
  });

  it('weighs as a class', () => {
    const [sel] = parseSelectorText('p:dir(rtl)')!;
    expect(specificityOf(sel)).toEqual([0, 1, 1]);
  });
});

describe(':dir() matching', () => {
  it('matches an explicit direction', () => {
    const doc = '<p id=a dir=rtl>a</p><p id=b dir=ltr>b</p>';
    expect(ids(doc, 'p:dir(rtl)')).toEqual(['a']);
    expect(ids(doc, 'p:dir(ltr)')).toEqual(['b']);
  });

  it('matches ltr by default with no dir anywhere', () => {
    expect(ids('<p id=a>a</p>', 'p:dir(ltr)')).toEqual(['a']);
  });

  it('matches through inheritance', () => {
    expect(ids('<div dir=rtl><p id=a>a</p></div>', 'p:dir(rtl)')).toEqual(['a']);
  });

  it('resolves dir=auto from the first strong character', () => {
    const doc = '<p id=a dir=auto>مرحبا</p><p id=b dir=auto>hello</p>';
    expect(ids(doc, 'p:dir(rtl)')).toEqual(['a']);
    expect(ids(doc, 'p:dir(ltr)')).toEqual(['b']);
  });

  it('gives <bdi> auto by default', () => {
    expect(ids('<bdi id=a>שלום</bdi>', 'bdi:dir(rtl)')).toEqual(['a']);
  });
});

describe('the two compose with the rest of the engine', () => {
  it('combines with a combinator', () => {
    expect(ids('<div lang=fr><p id=a>a</p></div><div lang=en><p id=b>b</p></div>',
      'div > p:lang(fr)')).toEqual(['a']);
  });

  it('works inside :is() and :not()', () => {
    const doc = '<p id=a lang=en>a</p><p id=b lang=fr>b</p>';
    expect(ids(doc, 'p:is(:lang(fr))')).toEqual(['b']);
    expect(ids(doc, 'p:not(:lang(fr))')).toEqual(['a']);
  });

  it('works inside :has()', () => {
    expect(ids('<div id=a><span lang=fr>x</span></div><div id=b><span>y</span></div>',
      'div:has(span:lang(fr))')).toEqual(['a']);
  });
});
