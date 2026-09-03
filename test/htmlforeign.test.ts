import { describe, it, expect } from 'vitest';
import {
  SVG_TAG_NAMES, SVG_ATTRS, MATHML_ATTRS, FOREIGN_ATTRS, FOREIGN_BREAKOUT,
  adjustSvgTagName, adjustAttributes,
  isMathmlTextIntegrationPoint, isHtmlIntegrationPoint,
} from '../src/htmlforeign.js';
import { createElement } from '../src/htmldom.js';

describe('the foreign-content adjustment tables', () => {
  // Sizes asserted so a half-transcribed table is a red build rather than a
  // silently mis-cased element that still renders. Read from the HTML
  // Standard on 2026-08-27.
  it('has the sizes the spec has', () => {
    expect(SVG_TAG_NAMES.size).toBe(37);
    expect(SVG_ATTRS.size).toBe(58);
    expect(MATHML_ATTRS.size).toBe(1);
    expect(FOREIGN_ATTRS.size).toBe(11);
    expect(FOREIGN_BREAKOUT.size).toBe(44);
  });

  // Every key is the all-lowercase spelling the tokenizer produces.
  it('keys every table on the lowercase spelling the tokenizer emits', () => {
    for (const table of [SVG_TAG_NAMES, SVG_ATTRS, MATHML_ATTRS]) {
      for (const key of table.keys()) expect(key).toBe(key.toLowerCase());
    }
  });

  it('fixes SVG tag case, and leaves an unlisted name alone', () => {
    expect(adjustSvgTagName('foreignobject')).toBe('foreignObject');
    expect(adjustSvgTagName('fegaussianblur')).toBe('feGaussianBlur');
    expect(adjustSvgTagName('textpath')).toBe('textPath');
    expect(adjustSvgTagName('g')).toBe('g');
    expect(adjustSvgTagName('circle')).toBe('circle');
  });

  it('renames a listed attribute and keeps its value', () => {
    const out = adjustAttributes(new Map([['viewbox', '0 0 1 1'], ['id', 'x']]), SVG_ATTRS);
    expect(out.get('viewBox')).toBe('0 0 1 1');
    expect(out.has('viewbox')).toBe(false);
    expect(out.get('id')).toBe('x');
  });

  it('adjusts the one MathML attribute', () => {
    const out = adjustAttributes(new Map([['definitionurl', 'u']]), MATHML_ATTRS);
    expect(out.get('definitionURL')).toBe('u');
  });

  // A namespaced attribute is stored under its DISPLAY key: prefix, a SPACE,
  // then the local name. That is what the html5lib format writes, and it is
  // unforgeable — whitespace ends an attribute name in the tokenizer.
  it('rewrites a namespaced attribute to its display key', () => {
    const out = adjustAttributes(
      new Map([['xlink:href', 'foo'], ['xml:lang', 'en']]), FOREIGN_ATTRS,
    );
    expect(out.get('xlink href')).toBe('foo');
    expect(out.get('xml lang')).toBe('en');
  });

  // xmlns has NO prefix, so it keeps its own name — the one entry in the
  // table whose key and value are equal, which reads like a typo.
  it('leaves a bare xmlns alone while prefixing xmlns:xlink', () => {
    const out = adjustAttributes(
      new Map([['xmlns', 'u'], ['xmlns:xlink', 'v']]), FOREIGN_ATTRS,
    );
    expect(out.get('xmlns')).toBe('u');
    expect(out.get('xmlns xlink')).toBe('v');
  });

  it('returns a new map rather than mutating its input', () => {
    const input = new Map([['viewbox', '0 0 1 1']]);
    const out = adjustAttributes(input, SVG_ATTRS);
    expect(input.get('viewbox')).toBe('0 0 1 1');
    expect(out).not.toBe(input);
  });
});

describe('the integration-point predicates', () => {
  it('names the five MathML text integration points', () => {
    for (const n of ['mi', 'mo', 'mn', 'ms', 'mtext']) {
      expect(isMathmlTextIntegrationPoint(createElement(n, undefined, 'math'))).toBe(true);
    }
    expect(isMathmlTextIntegrationPoint(createElement('math', undefined, 'math'))).toBe(false);
  });

  // The namespace is half the answer. An HTML <mi> is an ordinary unknown
  // element; only a MathML one is an integration point.
  it('requires the MathML namespace', () => {
    expect(isMathmlTextIntegrationPoint(createElement('mi'))).toBe(false);
    expect(isMathmlTextIntegrationPoint(createElement('mi', undefined, 'svg'))).toBe(false);
  });

  it('reads annotation-xml encoding case-insensitively', () => {
    const enc = (v: string) =>
      createElement('annotation-xml', new Map([['encoding', v]]), 'math');
    expect(isHtmlIntegrationPoint(enc('text/html'))).toBe(true);
    expect(isHtmlIntegrationPoint(enc('TEXT/HTML'))).toBe(true);
    expect(isHtmlIntegrationPoint(enc('application/xhtml+xml'))).toBe(true);
    expect(isHtmlIntegrationPoint(enc('text/plain'))).toBe(false);
    expect(isHtmlIntegrationPoint(createElement('annotation-xml', undefined, 'math'))).toBe(false);
  });

  it('names the three SVG integration points', () => {
    for (const n of ['foreignObject', 'desc', 'title']) {
      expect(isHtmlIntegrationPoint(createElement(n, undefined, 'svg'))).toBe(true);
    }
    expect(isHtmlIntegrationPoint(createElement('g', undefined, 'svg'))).toBe(false);
  });

  // foreignObject is stored ADJUSTED, so the predicate matches the adjusted
  // spelling. Matching the lowercase one instead silently never fires.
  it('matches the adjusted spelling of foreignObject', () => {
    expect(isHtmlIntegrationPoint(createElement('foreignobject', undefined, 'svg'))).toBe(false);
    expect(isHtmlIntegrationPoint(createElement('foreignObject', undefined, 'svg'))).toBe(true);
  });
});

describe('the foreign breakout list', () => {
  it('holds the HTML start tags that pop out of foreign content', () => {
    for (const n of ['b', 'blockquote', 'div', 'h1', 'table', 'ul', 'var']) {
      expect(FOREIGN_BREAKOUT.has(n)).toBe(true);
    }
  });

  // `font` is NOT in the list: it breaks out only when it carries color,
  // face or size, which is a rule at the call site rather than a member.
  it('excludes font, whose rule is conditional', () => {
    expect(FOREIGN_BREAKOUT.has('font')).toBe(false);
  });
});
