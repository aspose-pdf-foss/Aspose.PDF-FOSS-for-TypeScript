import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseXml } from '../src/xml.js';
import { unzip, entry, textOf } from './helpers/unzip.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildTextAndImagePage, buildTwoImagePage } from './helpers/build-edit-pdf.js';
import { buildTaggedBookPdf } from './helpers/build-tagged-book-pdf.js';

/** A caption and a 1x1 image scaled to 100pt, for the /Figure path. */
const FIGURE_PAGE =
  'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

const tagged = () => Document.Open(buildTaggedPdf());
const withImage = () => Document.Open(buildTextAndImagePage(FIGURE_PAGE));

describe('Document.ToEpub', () => {
  it('produces a package whose manifest resolves', () => {
    const zip = unzip(tagged().ToEpub());
    const opf = textOf(zip, 'EPUB/package.opf');
    const hrefs = [...opf.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(entry(zip, `EPUB/${h}`)).toBeDefined();
  });

  it('emits content documents that parse as XML', () => {
    // The whole reason htmlsemantic.ts self-closes its void elements: an EPUB
    // content document that is not well-formed XML is rejected outright.
    const zip = unzip(tagged().ToEpub());
    for (const path of ['EPUB/chapter1.xhtml', 'EPUB/nav.xhtml']) {
      expect(entry(zip, path)).toBeDefined();
      expect(() => parseXml(entry(zip, path)!.bytes)).not.toThrow();
    }
  });

  it('writes images as parts, not data: URIs', () => {
    const zip = unzip(withImage().ToEpub());
    const content = textOf(zip, 'EPUB/chapter1.xhtml');
    expect(content).not.toContain('data:');
    expect(content).toMatch(/src="images\/image1\.(png|jpg)"/);
    expect(zip.some((e) => e.path.startsWith('EPUB/images/'))).toBe(true);
  });

  it('defaults dc:language to und rather than claiming English', () => {
    // A missing dc:language makes the file invalid, so something must be
    // written -- but 'en' would state a fact the PDF never stated.
    // NOTE: buildTaggedPdf declares /Lang en-US, so it cannot show this at all
    // -- the fixture must be one with NO /Lang.
    const opf = textOf(unzip(withImage().ToEpub()), 'EPUB/package.opf');
    expect(opf).toContain('<dc:language>und</dc:language>');
  });

  it("uses the document's own /Lang when it has one", () => {
    // The companion that stops the above passing because 'und' is written
    // unconditionally.
    const opf = textOf(unzip(tagged().ToEpub()), 'EPUB/package.opf');
    expect(opf).toContain('<dc:language>en-US</dc:language>');
  });

  it('takes the identifier from options when given', () => {
    const opf = textOf(unzip(tagged().ToEpub({ identifier: 'urn:isbn:123' })),
      'EPUB/package.opf');
    expect(opf).toContain('urn:isbn:123');
  });

  it('falls back to a deterministic identifier with no option', () => {
    const opf = textOf(unzip(tagged().ToEpub()), 'EPUB/package.opf');
    expect(opf).toMatch(/<dc:identifier id="pub-id">urn:(uuid|sha256):[0-9a-f]+</);
  });

  it('is byte-reproducible', () => {
    const doc = tagged();
    expect(doc.ToEpub()).toEqual(doc.ToEpub());
  });

  it('does not throw on a document with no structure at all', () => {
    expect(() => withImage().ToEpub()).not.toThrow();
  });
});

describe('ToEpub — chapter split', () => {
  /** Tagged Markdown, re-opened so the export reads it back off the page. */
  function book(md: string): Document {
    const doc = Document.New();
    doc.AddMarkdown(md, { tagged: true });
    return Document.Open(doc.Save());
  }

  const chapterParts = (bytes: Uint8Array) =>
    unzip(bytes).filter((e) => /^EPUB\/chapter\d+\.xhtml$/.test(e.path));

  it('emits one content document per top-level heading', () => {
    const zip = chapterParts(book('# One\n\nalpha\n\n# Two\n\nbeta\n').ToEpub());
    expect(zip).toHaveLength(2);
  });

  it('keeps a sub-heading inside its own chapter', () => {
    const bytes = book('# One\n\n## Sub\n\nalpha\n\n# Two\n\nbeta\n').ToEpub();
    expect(chapterParts(bytes)).toHaveLength(2);
    const first = textOf(unzip(bytes), 'EPUB/chapter1.xhtml');
    expect(first).toContain('Sub');
    expect(first).not.toContain('Two');
  });

  it('lists every chapter in the nav, in spine order', () => {
    const bytes = book('# One\n\nalpha\n\n# Two\n\nbeta\n').ToEpub();
    const zip = unzip(bytes);
    const nav = textOf(zip, 'EPUB/nav.xhtml');
    const hrefs = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['chapter1.xhtml', 'chapter2.xhtml']);
    for (const h of hrefs) expect(entry(zip, `EPUB/${h}`)).toBeDefined();

    const opf = textOf(zip, 'EPUB/package.opf');
    const refs = [...opf.matchAll(/idref="([^"]+)"/g)].map((m) => m[1]);
    expect(refs).toEqual(['ch1', 'ch2']);
  });

  it('names each nav entry after its heading', () => {
    const nav = textOf(unzip(book('# Alpha\n\na\n\n# Beta\n\nb\n').ToEpub()),
      'EPUB/nav.xhtml');
    expect(nav).toContain('>Alpha<');
    expect(nav).toContain('>Beta<');
  });

  it('still emits exactly one chapter with no headings', () => {
    // zwto.1's behaviour, preserved: the spine and the nav are never empty.
    const bytes = book('just a paragraph\n').ToEpub();
    expect(chapterParts(bytes)).toHaveLength(1);
  });

  it('registers one media part for an image drawn twice', () => {
    // ONE sink spans the whole render, so a repeated picture is one part.
    //
    // NOTE, measured rather than assumed: this fixture puts both draws in the
    // SAME chapter, so it does NOT pin the "one sink across chapters" half of
    // the rule -- a per-chapter sink keeps it green, confirmed by mutation.
    // AutoTag would not produce a document with an image inside two separate
    // chapters (it ranks headings per block, so the headings here cluster into
    // one), which is why the cross-chapter half needs a hand-built structure
    // tree -- buildTaggedBookPdf, in the case below.
    const stream = 'q 60 0 0 60 20 200 cm /Im0 Do Q q 60 0 0 60 20 60 cm /Im0 Do Q';
    const doc = Document.Open(buildTwoImagePage(stream));
    doc.AutoTag({ alt: () => 'pic' });   // no alt callback => no /Figure at all
    const zip = unzip(Document.Open(doc.Save()).ToEpub());
    const chapter = textOf(zip, 'EPUB/chapter1.xhtml');
    expect((chapter.match(/<img/g) ?? [])).toHaveLength(2);   // drawn twice
    expect(zip.filter((e) => e.path.startsWith('EPUB/images/'))).toHaveLength(1);
  });

  it('registers one media part for an image drawn in two chapters', () => {
    // The other half of the rule, and the half the same-chapter case above
    // cannot see: the sink is created OUTSIDE the chapter loop, so a picture
    // shared by two chapters is a single package part. Move that construction
    // inside the loop and this goes red with two parts -- while every other
    // assertion in this file, the markup included, stays green.
    const zip = unzip(Document.Open(buildTaggedBookPdf()).ToEpub());
    const chapters = zip.filter((e) => /^EPUB\/chapter\d+\.xhtml$/.test(e.path));
    expect(chapters).toHaveLength(2);
    for (const c of chapters) expect(textOf(zip, c.path)).toContain('<img');
    expect(zip.filter((e) => e.path.startsWith('EPUB/images/'))).toHaveLength(1);
  });
});
