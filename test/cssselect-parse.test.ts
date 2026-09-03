import { describe, it, expect } from 'vitest';
import { parseSelectorText } from '../src/cssselect.js';

describe('selector parsing', () => {
  it('parses a type selector', () => {
    expect(parseSelectorText('div')).toEqual([
      { parts: [{ type: 'div', ids: [], classes: [], attrs: [], pseudos: [] }], combinators: [] },
    ]);
  });

  it('lowercases a type name once, at parse time', () => {
    // Matching is ASCII case-insensitive for HTML, so folding here means the
    // matcher compares two already-folded strings rather than folding per
    // element per rule.
    expect(parseSelectorText('DIV')?.[0]?.parts[0]?.type).toBe('div');
  });

  it('keeps NO second spelling, because one folded name serves every element', () => {
    // A foreign type name folds too in an HTML document, so there is nothing
    // for a raw spelling to do — see test/cssselect-match.test.ts, which
    // measures that against Blink's three code paths.
    const c = parseSelectorText('linearGradient')?.[0]?.parts[0];
    expect(c).toEqual({ type: 'lineargradient', ids: [], classes: [], attrs: [], pseudos: [] });
  });

  it('parses the universal selector as no constraint at all', () => {
    expect(parseSelectorText('*')?.[0]?.parts[0]).toEqual(
      { ids: [], classes: [], attrs: [], pseudos: [] });
  });

  it('parses id and classes, and keeps their case', () => {
    const c = parseSelectorText('#Main.a.B')?.[0]?.parts[0];
    expect(c?.ids).toEqual(['Main']);
    expect(c?.classes).toEqual(['a', 'B']);
  });

  it('ACCEPTS a compound naming two ids, which is valid CSS that matches nothing', () => {
    // The grammar admits `#a#b`; it simply cannot match, since an element has
    // one id. Rejecting it turns a never-matching selector into an INVALID
    // one — and an invalid selector invalidates the whole list, so `p, #a#b`
    // would lose its `p` half and the document render unstyled. That is why
    // ids are a list rather than a single field.
    expect(parseSelectorText('#a#b')?.[0]?.parts[0]?.ids).toEqual(['a', 'b']);
    expect(parseSelectorText('p, #a#b')?.length).toBe(2);
  });

  it('rejects a hash that is not an identifier', () => {
    // csstoken gives `#1a` id:false. Accepting it would admit a selector CSS
    // does not have.
    expect(parseSelectorText('#1a')).toBeNull();
  });

  it('parses all four combinators, leftmost first', () => {
    const s = parseSelectorText('a b > c + d ~ e')?.[0];
    expect(s?.parts.map((p) => p.type)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(s?.combinators).toEqual(
      ['descendant', 'child', 'next-sibling', 'subsequent-sibling']);
  });

  it('parses a selector list into independent complex selectors', () => {
    expect(parseSelectorText('a, b')?.length).toBe(2);
  });

  it('parses an attribute presence test', () => {
    expect(parseSelectorText('[hidden]')?.[0]?.parts[0]?.attrs)
      .toEqual([{ name: 'hidden', op: 'exists' }]);
  });

  it('parses [a=b], whose operator is a delim rather than a match token', () => {
    // The trap: only ~= |= ^= $= *= are `match` tokens. A parser keyed on
    // `kind === "match"` rejects the commonest attribute selector there is.
    expect(parseSelectorText('[t=b]')?.[0]?.parts[0]?.attrs)
      .toEqual([{ name: 't', op: '=', value: 'b' }]);
  });

  it('parses the five compound operators', () => {
    for (const op of ['~=', '|=', '^=', '$=', '*='] as const) {
      expect(parseSelectorText(`[t${op}"x"]`)?.[0]?.parts[0]?.attrs)
        .toEqual([{ name: 't', op, value: 'x' }]);
    }
  });

  it('reads the i flag, and defaults to case-sensitive', () => {
    expect(parseSelectorText('[t=b i]')?.[0]?.parts[0]?.attrs[0]?.ci).toBe(true);
    expect(parseSelectorText('[t=b s]')?.[0]?.parts[0]?.attrs[0]?.ci).toBe(false);
    expect(parseSelectorText('[t=b]')?.[0]?.parts[0]?.attrs[0]?.ci).toBeUndefined();
  });

  it('lowercases an attribute name and keeps its value case', () => {
    expect(parseSelectorText('[HREF=Foo]')?.[0]?.parts[0]?.attrs)
      .toEqual([{ name: 'href', op: '=', value: 'Foo' }]);
  });

  it('returns null for an empty or whitespace-only selector', () => {
    expect(parseSelectorText('')).toBeNull();
    expect(parseSelectorText('   ')).toBeNull();
  });

  it('returns null for a dangling or doubled combinator', () => {
    for (const s of ['a >', '> a', 'a > > b', 'a,', ',a']) {
      expect(parseSelectorText(s)).toBeNull();
    }
  });

  it('returns null for a namespace-qualified selector', () => {
    // We implement no @namespace, so the prefix has nothing to resolve to.
    expect(parseSelectorText('svg|rect')).toBeNull();
  });

  it('invalidates the WHOLE list when one selector is unsupported', () => {
    // CSS's own rule. A half-applied rule is worse than none, because the
    // half that applied is indistinguishable from a correct render.
    expect(parseSelectorText('a, svg|rect')).toBeNull();
  });

  it('never throws, whatever it is given', () => {
    for (const s of ['[', '[]', '[=]', '#', '.', '..a', 'a[', '((']) {
      expect(() => parseSelectorText(s)).not.toThrow();
    }
  });
});
