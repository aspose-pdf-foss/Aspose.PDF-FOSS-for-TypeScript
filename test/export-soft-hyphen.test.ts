// 5cil: a word broken at a line-end soft hyphen exports whole.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

const SHY = '\u00AD';
const T = 'Hyphenation keeps documentation of extraordinary responsibility readable in narrow columns of text';
const words = T.split(' ');
const html = (d: Document) => d.ToHtml().match(/<body>[^]*<\/body>/)![0];
/** Every word of `s`, markup and Markdown list markers stripped. */
const wordsOf = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/^\s*- /gm, ' ').split(/\s+/).filter(Boolean);
const docxText = (d: Document) => textOf(unzip(d.ToDocx()), 'word/document.xml').replace(/<[^>]*>/g, ' ');

const untagged = () => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { fontSize: 12, hyphenate: { lang: 'en' } });
  return Document.Open(d.Save());
};
const tagged = () => {
  const d = Document.New();
  d.AddMarkdown(`${T}\n\n- ${T}\n`, { tagged: true, hyphenate: { lang: 'en' }, format: PageFormat.custom(200, 800) });
  return Document.Open(d.Save());
};

describe('exports join a word broken at a soft hyphen (5cil)', () => {
  it('untagged: Markdown and HTML read every word whole', () => {
    const doc = untagged();
    expect(doc.Pages[0].GetText()).toContain(`${SHY}\n`);         // non-vacuous: it did break
    for (const out of [doc.ToMarkdown(), html(doc)]) {
      expect(out).not.toContain(SHY);
      expect(wordsOf(out)).toEqual(words);
    }
  });
  it('tagged: a paragraph and a list item read every word whole, in Markdown, HTML and DOCX', () => {
    const doc = tagged();
    expect(doc.Pages[0].GetText()).toContain(`${SHY}\n`);
    for (const out of [doc.ToMarkdown(), html(doc), docxText(doc)]) {
      expect(out).not.toContain(SHY);
      expect(wordsOf(out)).toEqual([...words, ...words]);
    }
  });
  it('a break across two text nodes (a style change at the break) joins too', () => {
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddText(`docu${SHY}`, 72, 700, { fontSize: 12 });
    d.Pages[0].AddText('mentation follows', 72, 685, { fontSize: 12, font: 'Helvetica-Bold' });
    const p = d.CreateStructTree().Append('P');
    p.MarkContent(d.Pages[0], [60, 670, 300, 720]);
    const doc = Document.Open(d.Save());
    const md = doc.ToMarkdown();
    expect(md).not.toContain(SHY);
    expect(md).toContain('docu**mentation follows**');
    expect(html(doc)).toContain('docu<b>mentation follows</b>');
  });
  it('untagged: a list item continued across a soft-hyphen break joins', () => {
    // Item body x = 20 + width('1. ') in Helvetica 12pt (556 + 278 + 278) = 33.344,
    // so the continuation line is corroborated as the item's own.
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 280 Td (1. alpha docu\\255) Tj ET BT /F1 12 Tf 33.344 266 Td (mentation here) Tj ET '
      + 'BT /F1 12 Tf 20 252 Td (2. beta) Tj ET'));
    const md = doc.ToMarkdown();
    expect(md).toMatch(/^1\. alpha documentation here$/m);
    expect(md).not.toContain(SHY);
  });
  it('keeps a line-end soft hyphen before a capital, and a drawn -', () => {
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 12 Tf 20 280 Td (alpha well-) Tj 0 -14 Td (known beta Mc\\255) Tj 0 -14 Td (Donald gamma) Tj ET'));
    const md = doc.ToMarkdown();
    expect(md).toContain('well- known');                           // a compound's own hyphen
    expect(md).toContain(`Mc${SHY} Donald`);                       // not lower-case: left alone
  });
  it('leaves a soft hyphen drawn MID-LINE in a tagged text node alone', () => {
    // Drawn as a visible hyphen (hyphenation off), with no line break after it:
    // nothing says the word was broken there.
    const d = Document.New(PageFormat.A4);
    d.Pages[0].AddText(`co${'\u00AD'}operate today`, 72, 700, { fontSize: 12 });
    d.CreateStructTree().Append('P').MarkContent(d.Pages[0], [60, 690, 300, 720]);
    expect(Document.Open(d.Save()).ToMarkdown()).toContain(`co${SHY}operate today`);
  });
  it('an embedded font, which draws -, is unchanged', () => {
    const d = Document.New(PageFormat.A4);
    const font = d.AddFont(readFileSync('test/fixtures/fonts/NimbusSans-Regular.otf'));
    d.Pages[0].AddTextBlock(T, [72, 500, 90, 300], { font, fontSize: 12, hyphenate: { lang: 'en' } });
    const md = Document.Open(d.Save()).ToMarkdown();
    expect(md).toMatch(/[a-z]- [a-z]/);
  });
});
