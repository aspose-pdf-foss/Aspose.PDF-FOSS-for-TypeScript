import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, matches, selectAll } from '../src/cssselect.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** Every element in document order, template content included, so a test can
 *  reach an element selectAll is supposed to skip. */
function allElements(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') {
      out.push(x);
      if (x.content !== undefined) walk(x.content);
    }
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** Match a selector across a document and report the matched tag names. */
function hit(src: string, sel: string): string[] {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.name);
}

describe('matching', () => {
  it('matches a type selector', () => {
    expect(hit('<p>a</p><div>b</div>', 'p')).toEqual(['p']);
  });

  it('matches the universal selector against every element', () => {
    expect(hit('<p>a</p>', '*')).toEqual(['html', 'head', 'body', 'p']);
  });

  it('matches id and class', () => {
    expect(hit('<p id=x class="a b">t</p>', '#x')).toEqual(['p']);
    expect(hit('<p id=x class="a b">t</p>', '.b')).toEqual(['p']);
    expect(hit('<p class="a">t</p>', '.a.b')).toEqual([]);
  });

  it('matches NOTHING for a compound naming two ids', () => {
    // Valid CSS, and unsatisfiable: an element has one id. Keeping only the
    // first would make `#x#other` match <p id=x>, which is worse than the
    // rejection the parser used to make — it renders wrongly rather than not
    // at all.
    expect(hit('<p id=x>t</p>', '#x#other')).toEqual([]);
    expect(hit('<p id=x>t</p>', '#x#x')).toEqual(['p']);
  });

  it('matches a TYPE NAME ASCII case-insensitively for HTML elements', () => {
    expect(hit('<p>a</p>', 'P')).toEqual(['p']);
  });

  it('folds a FOREIGN type name too, this being an HTML document', () => {
    // The obvious reading — fold for HTML elements, compare a foreign one
    // exactly — is what this issue's design and plan both said, and it is
    // wrong here. Blink matches all three spellings against SVG
    // <linearGradient> through querySelectorAll, Element.matches and the
    // stylesheet cascade alike; the case-sensitive rule belongs to XML
    // documents, and parseHtml never produces one.
    const doc = '<svg><linearGradient/></svg>';
    expect(hit(doc, 'linearGradient')).toEqual(['linearGradient']);
    expect(hit(doc, 'lineargradient')).toEqual(['linearGradient']);
    expect(hit(doc, 'LINEARGRADIENT')).toEqual(['linearGradient']);
    // Still FOLDING rather than matching anything: a different name misses.
    expect(hit(doc, 'clippath')).toEqual([]);
  });

  it('matches an ATTRIBUTE NAME case-insensitively and its VALUE case-sensitively', () => {
    expect(hit('<a HREF="Foo">t</a>', '[href]')).toEqual(['a']);
    expect(hit('<a href="Foo">t</a>', '[href=Foo]')).toEqual(['a']);
    expect(hit('<a href="Foo">t</a>', '[href=foo]')).toEqual([]);
  });

  it('honours the i flag on an attribute value', () => {
    expect(hit('<a href="Foo">t</a>', '[href=foo i]')).toEqual(['a']);
  });

  it('applies the five compound attribute operators', () => {
    const doc = '<a href="http://x/y" class="one two" lang="en-GB">t</a>';
    expect(hit(doc, '[href^="http"]')).toEqual(['a']);
    expect(hit(doc, '[href$="/y"]')).toEqual(['a']);
    expect(hit(doc, '[href*="://"]')).toEqual(['a']);
    expect(hit(doc, '[class~="two"]')).toEqual(['a']);
    expect(hit(doc, '[lang|="en"]')).toEqual(['a']);
    // ~= is whitespace-separated-word, not substring: "tw" must not match.
    expect(hit(doc, '[class~="tw"]')).toEqual([]);
    // |= matches the exact value or the value followed by a hyphen.
    expect(hit(doc, '[lang|="en-G"]')).toEqual([]);
  });

  it('treats an empty attribute value as never matching for ^= $= *=', () => {
    // Selectors 4: these three never match when the value is the empty string.
    expect(hit('<a href="x">t</a>', '[href^=""]')).toEqual([]);
    expect(hit('<a href="x">t</a>', '[href$=""]')).toEqual([]);
    expect(hit('<a href="x">t</a>', '[href*=""]')).toEqual([]);
  });

  it('matches the descendant combinator, and BACKTRACKS', () => {
    // The nearest b-matching ancestor has no `a` above it; a further one does.
    // Without backtracking this reports nothing.
    const doc = '<div class=a><div class=b><div class=b><i>t</i></div></div></div>'
      + '<div class=b><em>t</em></div>';
    expect(hit(doc, '.a .b i')).toEqual(['i']);
  });

  it('matches the child combinator without descending further', () => {
    expect(hit('<div><section><p>t</p></section></div>', 'div > p')).toEqual([]);
    expect(hit('<div><p>t</p></div>', 'div > p')).toEqual(['p']);
  });

  it('matches the next-sibling combinator against the IMMEDIATE previous element', () => {
    expect(hit('<h1>a</h1><p>b</p>', 'h1 + p')).toEqual(['p']);
    expect(hit('<h1>a</h1><div>x</div><p>b</p>', 'h1 + p')).toEqual([]);
  });

  it('ignores text nodes when finding the previous sibling ELEMENT', () => {
    // "+ p" must still match with whitespace and text between the two.
    expect(hit('<h1>a</h1>   text   <p>b</p>', 'h1 + p')).toEqual(['p']);
  });

  it('matches the subsequent-sibling combinator, and BACKTRACKS', () => {
    const doc = '<h1>a</h1><div>x</div><p>b</p>';
    expect(hit(doc, 'h1 ~ p')).toEqual(['p']);
  });

  it('matches a selector list as the union of its selectors, in document order', () => {
    expect(hit('<p>a</p><div>b</div>', 'div, p')).toEqual(['p', 'div']);
  });

  it('reports each element at most once when two selectors both match it', () => {
    expect(hit('<p class=a>t</p>', 'p, .a')).toEqual(['p']);
  });

  it('matches id and class case-SENSITIVELY in no-quirks mode', () => {
    const doc = '<!doctype html><p id=Main class=Big>t</p>';
    expect(hit(doc, '#main')).toEqual([]);
    expect(hit(doc, '.big')).toEqual([]);
  });

  it('matches id and class case-INSENSITIVELY in quirks mode', () => {
    // No doctype puts the document in quirks mode (htmltree.ts:637), which is
    // computed today and read by exactly one line of parsing logic.
    const doc = '<p id=Main class=Big>t</p>';
    expect(parseHtml(doc).quirks).toBe(true);
    expect(hit(doc, '#main')).toEqual(['p']);
    expect(hit(doc, '.big')).toEqual(['p']);
  });
});

describe('the template content boundary', () => {
  const DOC = '<!doctype html><div id=host><template><b class=inside>t</b></template></div>';

  it('does not descend into a template\'s content', () => {
    expect(hit(DOC, '.inside')).toEqual([]);
    expect(hit(DOC, 'b')).toEqual([]);
  });

  it('cannot match OUT of a template\'s content either', () => {
    // htmltree.ts assigns el.content = createFragment(), and createFragment
    // leaves parent null — so the chain from inside runs element -> fragment
    // -> null and never reaches the document. The boundary is structural in
    // BOTH directions, which is a property of two files agreeing rather than
    // of one line, so it is asserted rather than assumed.
    const el = allElements(parseHtml(DOC)).find((e) => e.name === 'b');
    expect(el).toBeDefined();
    const sel = parseSelectorText('#host b');
    expect(sel).not.toBeNull();
    expect(matches(sel![0]!, el!)).toBe(false);
  });
});
