import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const doc = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock('alpha beta gamma delta', [72, 400, 200, 300], { fontSize: 12 });
  return Document.Open(d.Save());
};
const bytes = (d: Document) => d.Pages[0].Contents;

describe('hyphenate option validation (6y39)', () => {
  it('requires adjust: reflow', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { hyphenate: { lang: 'en' } })).toThrow(RangeError);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'shiftRest', hyphenate: { lang: 'en' } })).toThrow(RangeError);
    expect(() => d.RestyleText('beta', { underline: true }, { hyphenate: { lang: 'en' } })).toThrow(RangeError);
  });
  it('false and absent are accepted everywhere', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { hyphenate: false })).not.toThrow();
  });
  it('rejects the wrong kind with TypeError and leaves the document untouched', () => {
    const d = doc();
    const before = bytes(d);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: 'en' as never })).toThrow(TypeError);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: { minLeft: 1.5 } })).toThrow(TypeError);
    expect(bytes(d)).toEqual(before);
  });
  it('rejects values outside the set with RangeError', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: { mode: 'x' as never } })).toThrow(RangeError);
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: { lang: 'tlh' } })).toThrow(RangeError);
  });
  it('accepts auto with no lang: the language comes from the document', () => {
    const d = doc();
    expect(() => d.Pages[0].ReplaceText('beta', 'b', { adjust: 'reflow', hyphenate: {} })).not.toThrow();
  });
  it('messages name the calling API', () => {
    const d = doc();
    expect(() => d.RestyleText('beta', { underline: true }, { adjust: 'reflow', hyphenate: { lang: 'tlh' } })).toThrow(/RestyleText/);
  });
});
