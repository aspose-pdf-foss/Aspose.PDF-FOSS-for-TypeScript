import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const BOX: [number, number, number, number] = [72, 400, 200, 300];
const LONG = 'Documentation of internationalization requirements demonstrates extraordinary responsibility and considerable organizational flexibility throughout implementation';
const hblock = (text: string, width = BOX[2]) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(text, [BOX[0], BOX[1], width, BOX[3]], { fontSize: 12, hyphenate: { lang: 'en' } });
  return Document.Open(d.Save());
};
const HY = { adjust: 'reflow' as const, hyphenate: { lang: 'en' } };
const hyphens = (d: Document) => (d.Pages[0].GetText().match(/-\n/g) ?? []).length;

describe('rejoin in ReplaceText (6y39)', () => {
  // A drawn '-' at a line end may be an author's compound hyphen, and the
  // patterns cannot tell — en breaks wellknown at 4 — so it is never removed.
  // Only a soft hyphen, which is a break by definition, rejoins.
  const lines = (ls: string[]) => Document.Open(buildSimpleTextPdf(
    `BT /F1 12 Tf 20 280 Td (${ls[0]}) Tj ${ls.slice(1).map((l) => `0 -14 Td (${l}) Tj`).join(' ')} ET`));
  it('keeps an author\'s compound hyphen that a reflow brings mid-line', () => {
    const doc = lines(['alpha beta gamma delta well-', 'known results follow here', 'and then some more']);
    doc.Pages[0].ReplaceText('beta gamma', 'b', HY);
    const text = doc.Pages[0].GetText();
    expect(text).not.toContain('well-\nknown');                    // non-vacuous: the halves did meet
    expect(text).toMatch(/well-\s*known/);
    expect(text).not.toContain('wellknown');
  });
  it('removes a line-end soft hyphen when its halves rejoin', () => {
    const doc = lines(['alpha beta gamma delta docu\\255', 'mentation results follow here', 'and then some more']);
    doc.Pages[0].ReplaceText('beta gamma', 'b', HY);
    const text = doc.Pages[0].GetText();
    expect(text).toContain('documentation');
    expect(text).not.toContain('­');
  });
  it('an edit on a later line keeps the lines before it', () => {
    const doc = hblock(LONG);
    const before = doc.Pages[0].GetText().split('\n');
    doc.Pages[0].ReplaceText('considerable', 'big', HY);
    const after = doc.Pages[0].GetText().split('\n');
    const L = before.findIndex((l) => l.includes('considerable'));
    expect(after.slice(0, L)).toEqual(before.slice(0, L));
  });
  // 'a second reflow over our own output leaves no stray hyphen' waits on
  // 8eew: ANY second reflow over our own output is refused 'interleaved',
  // hyphenated or not, so that case cannot run yet.
  it('ReplaceText still counts only real matches', () => {
    const doc = hblock(LONG);
    expect(doc.Pages[0].ReplaceText('Documentation', 'Docs', HY)).toBe(1);
  });
  // Review Focus 3: a tagged document stays tagged.
  it('a tagged document reports no new untagged content', () => {
    const d = Document.New();
    d.AddMarkdown(LONG, { tagged: true, hyphenate: { lang: 'en' }, format: PageFormat.custom(320, 600) });
    const doc = Document.Open(d.Save());
    expect(hyphens(doc)).toBeGreaterThan(0);                       // non-vacuous
    const before = doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent').length;
    doc.Pages[0].ReplaceText('Documentation', 'Documentation and analysis', HY);
    expect(hyphens(doc)).toBeGreaterThan(0);
    expect(doc.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent').length).toBe(before);
  });
});
