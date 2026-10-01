import { describe, it, expect } from 'vitest';
import { resolveTarget } from '../src/opcread.js';

describe('resolveTarget', () => {
  it('resolves relative to the SOURCE part directory, not the package root', () => {
    expect(resolveTarget('word/document.xml', 'styles.xml')).toBe('word/styles.xml');
    expect(resolveTarget('word/document.xml', 'media/image1.png')).toBe('word/media/image1.png');
  });

  it('resolves the package root relationships against the root', () => {
    expect(resolveTarget('', 'word/document.xml')).toBe('word/document.xml');
  });

  it('resolves ./ and ../ segments', () => {
    expect(resolveTarget('word/document.xml', './styles.xml')).toBe('word/styles.xml');
    expect(resolveTarget('word/document.xml', '../customXml/item1.xml')).toBe('customXml/item1.xml');
    expect(resolveTarget('word/sub/a.xml', '../../b.xml')).toBe('b.xml');
  });

  it('treats a leading slash as absolute within the package', () => {
    expect(resolveTarget('word/document.xml', '/word/media/x.png')).toBe('word/media/x.png');
  });

  it('CLAMPS .. past the root, as remove_dot_segments does', () => {
    expect(resolveTarget('word/document.xml', '../../../x.xml')).toBe('x.xml');
    expect(resolveTarget('', '../x.xml')).toBe('x.xml');
  });

  it('percent-decodes the result as UTF-8', () => {
    expect(resolveTarget('word/document.xml', 'media/my%20pic.png')).toBe('word/media/my pic.png');
    expect(resolveTarget('word/document.xml', 'm%C3%A9dia.xml')).toBe('word/média.xml');
  });

  it('keeps a part name case as written (lookup folds case, resolution does not)', () => {
    expect(resolveTarget('Word/Document.xml', 'Styles.XML')).toBe('Word/Styles.XML');
  });

  it('gives no part for a query, a fragment, a scheme, a network path, or an empty target', () => {
    expect(resolveTarget('word/document.xml', 'a.xml?x=1')).toBeUndefined();
    expect(resolveTarget('word/document.xml', 'a.xml#frag')).toBeUndefined();
    expect(resolveTarget('word/document.xml', 'http://example.com/a')).toBeUndefined();
    expect(resolveTarget('word/document.xml', '//host/a')).toBeUndefined();
    expect(resolveTarget('word/document.xml', '')).toBeUndefined();
  });

  it('gives no part for a malformed percent-escape', () => {
    expect(resolveTarget('word/document.xml', 'a%ZZ.xml')).toBeUndefined();
  });

  it('gives no part when resolution lands on the root itself', () => {
    expect(resolveTarget('word/document.xml', '..')).toBeUndefined();
  });
});

// Final review I1: decoding AFTER dot-segment removal let an encoded dot or
// separator survive into the part name, so this reader and a normalizing one
// (RFC 3986 6.2.2.2 decodes unreserved characters first) named different parts.
describe('resolveTarget: encoded dots and separators', () => {
  it('decodes before removing dot segments, so %2e%2e is ..', () => {
    expect(resolveTarget('word/document.xml', '%2e%2e/%2e%2e/x.xml')).toBe('x.xml');
    expect(resolveTarget('word/document.xml', '%2E%2E/media/a.png')).toBe('media/a.png');
    expect(resolveTarget('word/document.xml', '%2e%2e')).toBeUndefined();
  });

  it('gives no part for an encoded slash or backslash, which part names forbid', () => {
    expect(resolveTarget('word/document.xml', 'a%2Fb.xml')).toBeUndefined();
    expect(resolveTarget('word/document.xml', 'a%2fb.xml')).toBeUndefined();
    expect(resolveTarget('word/document.xml', 'a%5Cb.xml')).toBeUndefined();
  });
});
