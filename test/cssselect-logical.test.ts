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

const DOC = '<!doctype html><div>'
  + '<p id=a class=x>1</p><p id=b>2</p><span id=c class=x>3</span></div>';

describe('logical pseudo-classes', () => {
  it('matches :not() as the negation', () => {
    expect(ids(DOC, 'p:not(.x)')).toEqual(['b']);
  });

  it('matches :is() as the union', () => {
    expect(ids(DOC, ':is(#a, #c)')).toEqual(['a', 'c']);
  });

  it('matches :where() exactly as :is() does', () => {
    expect(ids(DOC, ':where(#a, #c)')).toEqual(['a', 'c']);
  });

  it('gives :where() ZERO specificity whatever its arguments', () => {
    expect(spec(':where(#a)')).toEqual([0, 0, 0]);
    expect(spec('p:where(#a#b#c)')).toEqual([0, 0, 1]);
  });

  it('gives :is() and :not() their arguments MAXIMUM, not their sum', () => {
    // The sum reading gives [2,0,0] here; the max gives [1,0,0].
    expect(spec(':is(#a, #b)')).toEqual([1, 0, 0]);
    expect(spec(':not(#a, #b)')).toEqual([1, 0, 0]);
    // Max across UNLIKE arguments is lexicographic: an id beats ten classes.
    expect(spec(':is(#a, .b.c.d)')).toEqual([1, 0, 0]);
  });

  it('supports a complex selector inside :not()', () => {
    expect(ids(DOC, 'p:not(div > .x)')).toEqual(['b']);
  });

  it('nests', () => {
    expect(ids(DOC, ':is(p:not(.x))')).toEqual(['b']);
  });
});

describe('dynamic pseudo-classes', () => {
  const LINKS = '<!doctype html><a id=withhref href=x>1</a><a id=bare>2</a>';

  it('matches :link for an <a> that HAS an href', () => {
    expect(ids(LINKS, ':link')).toEqual(['withhref']);
  });

  it('never matches :visited, :hover, :active, :focus or :target', () => {
    for (const s of [':visited', ':hover', ':active', ':focus', ':target']) {
      expect(ids(LINKS, `a${s}`)).toEqual([]);
    }
  });

  it('KEEPS the rest of a list when a dynamic pseudo-class shares it', () => {
    // The rule this whole distinction exists for. A dynamic pseudo-class is
    // KNOWN and never matches; treating it as unknown invalidates the whole
    // list, so `a, a:hover` would lose its `a` half and the document renders
    // unstyled rather than merely un-hovered.
    expect(ids(LINKS, 'a, a:hover')).toEqual(['withhref', 'bare']);
  });

  it('still returns null for a genuinely unsupported pseudo-class', () => {
    // An UNKNOWN NAME, and deliberately not a real-but-unimplemented pseudo:
    // the stand-in here has already moved twice as the engine grew — :has()
    // until zch2.2.4, then :lang() until zch2.2.5 — and a name no spec will
    // ever define cannot be overtaken a third time.
    expect(parseSelectorText('a:nonsense')).toBeNull();
    expect(parseSelectorText('a, a:nonsense')).toBeNull();
    expect(parseSelectorText('a:nonsense(1)')).toBeNull();
  });

  it('weighs a dynamic pseudo-class as a class', () => {
    expect(spec('a:hover')).toEqual([0, 1, 1]);
  });
});

describe('pseudo-elements', () => {
  it('parses and records a pseudo-element without matching any element', () => {
    const list = parseSelectorText('p::before');
    expect(list).not.toBeNull();
    expect(list?.[0]?.parts[0]?.pseudoElement).toBe('before');
    expect(ids('<!doctype html><p id=a>t</p>', 'p::before')).toEqual([]);
  });

  it('does NOT invalidate a list it shares', () => {
    expect(ids('<!doctype html><p id=a>t</p>', 'p, p::before')).toEqual(['a']);
  });

  it('weighs a pseudo-element as a type', () => {
    expect(spec('p::before')).toEqual([0, 0, 2]);
  });
});
