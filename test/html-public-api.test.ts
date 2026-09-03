import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';

describe('the public HTML parser surface', () => {
  it('exports parseHtml', () => {
    expect(typeof api.parseHtml).toBe('function');
  });

  it('parses a document through the public entry', () => {
    const doc = api.parseHtml('<p>hi');
    expect(doc.kind).toBe('document');
    const html = doc.children[0];
    expect(html?.kind).toBe('element');
  });

  // The signature is the tree alone. Parse errors stay on the tokenizer:
  // every HTML string is a valid document by construction, so an error is
  // never actionable for a caller rendering a PDF, and the list a caller CAN
  // act on is zch2.7's. Widening later is additive; narrowing is not.
  it('returns the document itself rather than a result object', () => {
    const doc = api.parseHtml('');
    expect(doc.kind).toBe('document');
    expect((doc as unknown as { errors?: unknown }).errors).toBeUndefined();
  });

  // zch2.8: the bytes entry point is a SIBLING rather than a widening of
  // parseHtml's signature. parseHtml is what 8,862 vendored cases anchor, and
  // it must keep taking a string and nothing else.
  it('exports parseHtmlBytes beside parseHtml', () => {
    expect(typeof api.parseHtmlBytes).toBe('function');
  });

  it('works out the encoding from the document, through the public entry', () => {
    // windows-1251 bytes: invalid UTF-8, so without the restart this is
    // three U+FFFD rather than three Cyrillic letters.
    const bytes = Uint8Array.from([
      ...[...'<meta charset="windows-1251"><p>'].map((c) => c.charCodeAt(0)),
      0xCF, 0xF0, 0xE8,
    ]);
    // A walker rather than JSON.stringify: htmldom's nodes carry `parent`
    // back-pointers, so the tree is circular by design.
    const textOf = (n: api.HtmlNode): string => {
      if (n.kind === 'text') return n.data;
      if (n.kind === 'element' || n.kind === 'document' || n.kind === 'fragment')
        return n.children.map(textOf).join('');
      return '';
    };
    expect(textOf(api.parseHtmlBytes(bytes))).toBe('При');
  });

  // Deliberately absent, each for its own reason recorded in CLAUDE.md.
  it('does not export the fragment entry or the mutation helpers', () => {
    for (const name of ['parseHtmlFragment', 'appendChild', 'insertBefore',
      'removeChild', 'createElement', 'createFragment', 'createDocument',
      'createText', 'createComment', 'createDoctype', 'HtmlTokenizer']) {
      expect(api).not.toHaveProperty(name);
    }
  });
});
