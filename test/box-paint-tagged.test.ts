import { it, expect } from 'vitest';
import { Document } from '../src/document.js';

// v9j3.4: the rounded, layered box painter artifacts its ink in a tagged flow,
// as the plain painter always has — a gradient, a clip and a rounded ring must
// not reach the page as untagged content. UntaggedContent is a WARNING, so the
// test reads Issues rather than Errors.
it('a tagged flow with rounded, layered boxes leaves no untagged content', () => {
  const d = Document.New();
  d.AddHtml('<div style="background:linear-gradient(red,blue);border-radius:12px;border:2px solid black;'
    + 'border-color:red green blue black;font-family:Helvetica"><p>One</p><p>Two</p></div>',
  { tagged: true, title: 'T', lang: 'en' });
  const r = Document.Open(d.Save()).ValidatePdfUa();
  expect(r.Issues.filter((e) => e.rule === 'UntaggedContent')).toEqual([]);
  expect(r.Errors).toEqual([]);
});
