import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseSelectorText, selectAll } from '../src/cssselect.js';

const hit = (src: string, sel: string): string[] => {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.name);
};

/** Six list items, so a nth-child expectation is legible as a set of indices. */
const LIST = '<!doctype html><ul>'
  + '<li id=n1>1</li><li id=n2>2</li><li id=n3>3</li>'
  + '<li id=n4>4</li><li id=n5>5</li><li id=n6>6</li></ul>';

const ids = (src: string, sel: string): string[] => {
  const list = parseSelectorText(sel);
  if (list === null) throw new Error(`unparseable selector: ${sel}`);
  return selectAll(parseHtml(src), list).map((e) => e.attrs.get('id') ?? '?');
};

describe('structural pseudo-classes', () => {
  it('matches :root against the document element only', () => {
    expect(hit('<!doctype html><p>t</p>', ':root')).toEqual(['html']);
  });

  it('matches :empty for an element with no children at all', () => {
    // A text node — even whitespace — makes an element non-empty.
    expect(ids('<!doctype html><p id=a></p><p id=b> </p><p id=c><i>x</i></p>', 'p:empty'))
      .toEqual(['a']);
  });

  it('matches :first-child, :last-child and :only-child', () => {
    expect(ids(LIST, 'li:first-child')).toEqual(['n1']);
    expect(ids(LIST, 'li:last-child')).toEqual(['n6']);
    expect(ids(LIST, 'li:only-child')).toEqual([]);
    expect(ids('<!doctype html><ul><li id=solo>x</li></ul>', 'li:only-child'))
      .toEqual(['solo']);
  });

  it('counts nth-child from ONE, not zero', () => {
    expect(ids(LIST, 'li:nth-child(1)')).toEqual(['n1']);
  });

  it('handles odd and even', () => {
    expect(ids(LIST, 'li:nth-child(odd)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(even)')).toEqual(['n2', 'n4', 'n6']);
    expect(ids(LIST, 'li:nth-child(ODD)')).toEqual(['n1', 'n3', 'n5']);
  });

  it('handles 2n+1 and its spaced form', () => {
    expect(ids(LIST, 'li:nth-child(2n+1)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(2n + 1)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(2N+1)')).toEqual(['n1', 'n3', 'n5']);
  });

  it('handles 2n-1, which is ONE dimension token whose unit is "n-1"', () => {
    // The trap. `n-1` is a valid CSS name, so `2n-1` is NOT dimension+number.
    // A parser written from the obvious reading gets 2n+1 right and this
    // wrong — and 2n-1 is `odd` shifted, so a striped table still looks
    // striped and only the first row is wrong.
    expect(ids(LIST, 'li:nth-child(2n-1)')).toEqual(['n1', 'n3', 'n5']);
    expect(ids(LIST, 'li:nth-child(2n - 1)')).toEqual(['n1', 'n3', 'n5']);
  });

  it('handles the bare and negated n forms', () => {
    expect(ids(LIST, 'li:nth-child(n)')).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(ids(LIST, 'li:nth-child(-n+3)')).toEqual(['n1', 'n2', 'n3']);
    expect(ids(LIST, 'li:nth-child(n+3)')).toEqual(['n3', 'n4', 'n5', 'n6']);
    expect(ids(LIST, 'li:nth-child(n-1)')).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(ids(LIST, 'li:nth-child(-n-1)')).toEqual([]);
  });

  it('rejects a malformed An+B rather than guessing', () => {
    for (const s of [':nth-child()', ':nth-child(- 1n)', ':nth-child(n-1-2)',
      ':nth-child(2x+1)', ':nth-child(a)']) {
      expect(parseSelectorText(`li${s}`)).toBeNull();
    }
  });

  it('counts nth-last-child from the END', () => {
    expect(ids(LIST, 'li:nth-last-child(1)')).toEqual(['n6']);
    expect(ids(LIST, 'li:nth-last-child(2)')).toEqual(['n5']);
  });

  it('counts the -of-type family among SAME-TYPE siblings only', () => {
    const doc = '<!doctype html><div>'
      + '<p id=p1>a</p><span id=s1>b</span><p id=p2>c</p><span id=s2>d</span></div>';
    expect(ids(doc, 'p:first-of-type')).toEqual(['p1']);
    expect(ids(doc, 'span:first-of-type')).toEqual(['s1']);
    expect(ids(doc, 'p:nth-of-type(2)')).toEqual(['p2']);
    expect(ids(doc, 'span:last-of-type')).toEqual(['s2']);
    expect(ids(doc, 'p:only-of-type')).toEqual([]);
    // The distinction that matters: s1 is the SECOND child but the FIRST span.
    expect(ids(doc, 'span:first-child')).toEqual([]);
  });

  it('matches -of-type on TYPE AND NAMESPACE, not name alone', () => {
    // An SVG <a> and an HTML <a> are different types.
    const doc = '<!doctype html><div><svg><a id=sa/></svg><a id=ha>x</a></div>';
    expect(ids(doc, 'a:first-of-type').length).toBe(2);
  });
});
