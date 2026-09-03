import { describe, it, expect } from 'vitest';
import { OpenElements, ActiveFormatting, sameFormattingElement } from '../src/htmlstack.js';
import { createElement } from '../src/htmldom.js';
import type { HtmlNamespace } from '../src/htmldom.js';

function stackOf(...names: string[]): OpenElements {
  const s = new OpenElements();
  for (const n of names) s.push(createElement(n));
  return s;
}

describe('the stack of open elements', () => {
  it('reports the current node as the last pushed', () => {
    expect(stackOf('html', 'body', 'p').current?.name).toBe('p');
    expect(new OpenElements().current).toBeUndefined();
  });

  // Pops THROUGH the match, not up to it.
  it('popUntilName pops the match too', () => {
    const s = stackOf('html', 'body', 'div', 'p', 'span');
    s.popUntilName('div');
    expect(s.items.map((e) => e.name)).toEqual(['html', 'body']);
  });

  it('finds an element in the default scope', () => {
    expect(stackOf('html', 'body', 'div', 'p').hasInScope('div')).toBe(true);
  });

  it('stops the default scope at a table', () => {
    expect(stackOf('html', 'body', 'div', 'table', 'td', 'p').hasInScope('div')).toBe(false);
  });

  // Using plain scope where button scope belongs changes when <p> auto-closes.
  it('distinguishes button scope from the default', () => {
    const s = stackOf('html', 'body', 'p', 'button', 'span');
    expect(s.hasInScope('p', 'default')).toBe(true);
    expect(s.hasInScope('p', 'button')).toBe(false);
  });

  it('distinguishes list-item scope from the default', () => {
    const s = stackOf('html', 'body', 'li', 'ul', 'span');
    expect(s.hasInScope('li', 'default')).toBe(true);
    expect(s.hasInScope('li', 'listItem')).toBe(false);
  });

  it('limits table scope to html, table and template', () => {
    const s = stackOf('html', 'table', 'tbody', 'tr', 'td', 'div');
    expect(s.hasInScope('tbody', 'table')).toBe(true);
    expect(s.hasInScope('div', 'table')).toBe(true);
  });

  // There are FOUR scopes, not five. The HTML Standard removed "select scope"
  // along with the two "in select" insertion modes and moved `select` into the
  // DEFAULT scope's terminator list — a reversal, since select scope was
  // inverted. zch2.1.2's design and plan both described the older five; the
  // vendored WPT corpus is written against the current spec and settles it.
  it('terminates the default scope at a select', () => {
    expect(stackOf('html', 'body', 'div', 'select', 'option').hasInScope('div')).toBe(false);
    expect(stackOf('html', 'body', 'select', 'option').hasInScope('select')).toBe(true);
  });

  it('removes an element from the middle', () => {
    const s = stackOf('html', 'body', 'div', 'p');
    const div = s.items[2];
    s.remove(div as never);
    expect(s.items.map((e) => e.name)).toEqual(['html', 'body', 'p']);
  });
});

describe('the list of active formatting elements', () => {
  it('clears to the last marker, keeping what precedes it', () => {
    const f = new ActiveFormatting();
    f.push(createElement('b'));
    f.pushMarker();
    f.push(createElement('i'));
    f.push(createElement('u'));
    f.clearToLastMarker();
    expect(f.items.length).toBe(1);
    expect((f.items[0] as { name: string }).name).toBe('b');
  });

  // Noah's Ark: at most three equal entries. Missing it grows the list without
  // bound and still renders correctly, so nothing visible reveals it.
  it('keeps at most three equal entries', () => {
    const f = new ActiveFormatting();
    for (let i = 0; i < 5; i++) f.push(createElement('b', new Map([['x', '1']])));
    expect(f.items.length).toBe(3);
  });

  it('counts equality by name and attributes, so a differing attribute is not equal', () => {
    const f = new ActiveFormatting();
    for (let i = 0; i < 4; i++) f.push(createElement('b', new Map([['x', String(i)]])));
    expect(f.items.length).toBe(4);
    expect(sameFormattingElement(
      createElement('b', new Map([['x', '1']])),
      createElement('b', new Map([['x', '1']])),
    )).toBe(true);
    expect(sameFormattingElement(
      createElement('b', new Map([['x', '1']])),
      createElement('b', new Map([['x', '2']])),
    )).toBe(false);
  });

  it('does not look past a marker for the last entry of a name', () => {
    const f = new ActiveFormatting();
    const early = createElement('b');
    f.push(early);
    f.pushMarker();
    expect(f.lastBetweenMarkerAndEnd('b')).toBeUndefined();
    const late = createElement('b');
    f.push(late);
    expect(f.lastBetweenMarkerAndEnd('b')).toBe(late);
  });
});

function nsStackOf(...pairs: [string, HtmlNamespace][]): OpenElements {
  const s = new OpenElements();
  for (const [n, ns] of pairs) s.push(createElement(n, undefined, ns));
  return s;
}

describe('namespace-aware scope', () => {
  // An SVG foreignObject terminates the scope; an HTML element of the same
  // name does not, because no such HTML element is in the list.
  it('terminates a scope at an SVG integration point', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['foreignObject', 'svg'], ['span', 'html']).hasInScope('p')).toBe(false);
  });

  it('does not terminate at an HTML element of the same name', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['foreignObject', 'html'], ['span', 'html']).hasInScope('p')).toBe(true);
  });

  it('terminates at a MathML text integration point', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['mi', 'math'], ['span', 'html']).hasInScope('p')).toBe(false);
  });

  // The everyday direction: an HTML <mi> is an unknown element and stops
  // nothing.
  it('does not terminate at an HTML mi', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['mi', 'html'], ['span', 'html']).hasInScope('p')).toBe(true);
  });

  // The one that actually bit: <td><svg><td> puts an SVG td above the HTML
  // one, so a name-only popUntilName stops at the wrong element and strands
  // the whole SVG subtree on the stack. namespace-sensitivity.dat#0 is the
  // vendored case; this is the same rule with no parser in the way.
  it('pops through an HTML element, stepping over a foreign one of that name', () => {
    const s = nsStackOf(['html', 'html'], ['td', 'html'], ['svg', 'svg'],
      ['td', 'svg'], ['foreignObject', 'svg']);
    s.popUntilName('td');
    expect(s.items.map((e) => e.name)).toEqual(['html']);
  });

  // hasInScope names an HTML element. A foreign element of that name is not
  // the target, or `</p>` inside SVG would close an SVG <p>.
  it('looks for an HTML element, not a foreign one of the same name', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'],
      ['p', 'svg']).hasInScope('p')).toBe(false);
  });
});
