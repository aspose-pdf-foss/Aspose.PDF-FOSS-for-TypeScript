import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, selectAll, specificityOf } from '../src/cssselect.js';
import type { Specificity } from '../src/cssselect.js';

const ids = (src: string, sel: string): string[] => {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.attrs.get('id') ?? '?');
};

const spec = (s: string): Specificity => {
  const list = parseSelectorText(s);
  if (list === null) throw new Error(`unparseable selector: ${s}`);
  return specificityOf(list[0]!);
};

/** Nested deeply enough that a descendant lead and a child lead disagree, and
 *  that the anchor has somewhere wrong to land. */
const NEST = '<!doctype html><div id=outer><div id=inner><p id=p1><i id=i1>t</i></p>'
  + '</div></div><div id=lone><span id=s1>u</span></div>';

const SIBS = '<!doctype html><section><h1 id=h>t</h1><p id=pa><em id=e1>a</em></p>'
  + '<span id=sp>b</span><p id=pb>c</p></section>';

describe(':has() leads', () => {
  it('takes a bare argument as the DESCENDANT lead', () => {
    expect(ids(NEST, 'div:has(p)')).toEqual(['outer', 'inner']);
  });

  it('restricts a > lead to a child', () => {
    // outer's only child is a div, so the descendant answer above and this
    // one differ — which is the whole point of writing the lead.
    expect(ids(NEST, 'div:has(> p)')).toEqual(['inner']);
  });

  it('matches a + lead against the immediately following sibling only', () => {
    expect(ids(SIBS, 'h1:has(+ p)')).toEqual(['h']);
    expect(ids(SIBS, 'h1:has(+ span)')).toEqual([]);
  });

  it('matches a ~ lead against any following sibling', () => {
    expect(ids(SIBS, 'h1:has(~ span)')).toEqual(['h']);
  });

  it('matches nothing when the subtree holds no candidate', () => {
    expect(ids(NEST, 'div:has(em)')).toEqual([]);
  });
});

describe(':has() anchoring', () => {
  // The rule that separates a correct implementation from the plausible wrong
  // one. `:has(> div p)` asks for a p under a div that is OUR OWN child; the
  // wrong reading — "some descendant matches `div p`" — also reports #inner,
  // because #p1 matches `div p` on its own account.
  it('anchors the LEFTMOST compound to the subject element', () => {
    expect(ids(NEST, 'div:has(> div p)')).toEqual(['outer']);
  });

  it('anchors a + lead across a deep subject', () => {
    // #e1 is inside #pa, which is h1's immediately following sibling.
    expect(ids(SIBS, 'h1:has(+ p em)')).toEqual(['h']);
    // #sp is not inside h1's next sibling, so a ~ answer must not leak in.
    expect(ids(SIBS, 'h1:has(+ span)')).toEqual([]);
  });

  it('does not match an element against its own subtree by the descendant lead', () => {
    // A descendant is strictly below: `p:has(p)` must not report #p1 itself.
    //
    // Note, measured: this is held by the ANCHORING, not by `descendants`
    // excluding the anchor. Making that generator yield the anchor too leaves
    // this green, because matchFrom walks UP from the candidate and can never
    // find the anchor above itself. Two redundant defences, so breaking either
    // one alone proves nothing.
    expect(ids(NEST, 'p:has(p)')).toEqual([]);
  });
});

describe(':has() composition', () => {
  it('combines with the rest of its own compound', () => {
    expect(ids(NEST, 'div:has(> p):has(> p > i)')).toEqual(['inner']);
  });

  it('takes a comma-separated list, matching on ANY argument', () => {
    expect(ids(NEST, 'div:has(> span, > p)')).toEqual(['inner', 'lone']);
  });

  it('nests inside :is() and :not()', () => {
    expect(ids(NEST, 'div:is(:has(> p))')).toEqual(['inner']);
    expect(ids(NEST, 'div:not(:has(p))')).toEqual(['lone']);
  });

  it('does not reach into a template content fragment', () => {
    // A template's children live in its content fragment, which is not part
    // of the document — the structural rule selectAll already follows.
    const doc = '<!doctype html><div id=d><template><p>t</p></template></div>';
    expect(ids(doc, 'div:has(p)')).toEqual([]);
  });
});

describe(':has() refusals', () => {
  it('refuses a nested :has(), invalidating the whole list', () => {
    expect(parseSelectorText('div:has(p:has(span))')).toBeNull();
    expect(parseSelectorText('div, div:has(p:has(span))')).toBeNull();
  });

  it('refuses a :has() reached through :is() or :not() inside a :has()', () => {
    expect(parseSelectorText('div:has(:is(p:has(span)))')).toBeNull();
    expect(parseSelectorText('div:has(:not(p:has(span)))')).toBeNull();
  });

  it('refuses a pseudo-element inside a :has()', () => {
    expect(parseSelectorText('div:has(p::before)')).toBeNull();
  });

  it('refuses an empty argument and a bare combinator', () => {
    expect(parseSelectorText('div:has()')).toBeNull();
    expect(parseSelectorText('div:has(>)')).toBeNull();
  });
});

describe(':has() specificity', () => {
  it('takes its arguments MAXIMUM, as :is() does', () => {
    expect(spec(':has(p, #a)')).toEqual([1, 0, 0]);
    expect(spec('div:has(#a)')).toEqual([1, 0, 1]);
  });

  it('gives the implicit anchor NO weight', () => {
    // `> p` weighs [0,0,1]; the :scope the lead hangs off is not written by
    // the author and must not be counted. Weighing it as a pseudo-class would
    // report [0,1,2] here.
    expect(spec('div:has(> p)')).toEqual([0, 0, 2]);
    expect(spec('div:has(p)')).toEqual([0, 0, 2]);
  });

  it('is not zero, unlike :where()', () => {
    expect(spec(':has(.x)')).toEqual([0, 1, 0]);
  });
});
