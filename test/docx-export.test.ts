import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { unzip, textOf } from './helpers/unzip.js';
import { parseXml } from '../src/xml.js';

function built(): Document {
  const doc = Document.New();
  const flow = doc.NewFlow({ tagged: true });
  flow.AddMarkdown([
    '# Title', '', 'Plain start **bold middle** plain end.', '',
    '- one', '- two', '', '[the docs](https://example.com)', '',
  ].join('\n'));
  flow.Render();
  return doc;
}

const parts = (doc: Document) => unzip(doc.ToDocx());
const paths = (doc: Document) => parts(doc).map((e) => e.path).sort();

describe('ToDocx package', () => {
  it('writes the expected part set', () => {
    const p = paths(built());
    for (const want of [
      '[Content_Types].xml', '_rels/.rels', 'word/document.xml',
      'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels',
    ]) expect(p).toContain(want);
  });

  it('declares a content type for every part', () => {
    const es = parts(built());
    const ct = textOf(es, '[Content_Types].xml');
    for (const e of es) {
      if (e.path === '[Content_Types].xml') continue;
      if (e.path.endsWith('.rels')) continue;   // covered by the extension default
      expect(ct).toContain(`PartName="/${e.path}"`);
    }
  });

  it('resolves every internal relationship to a part that exists', () => {
    const es = parts(built());
    const present = new Set(es.map((e) => e.path));
    let checked = 0;
    for (const e of es) {
      if (!e.path.endsWith('.rels')) continue;
      const dir = e.path.replace(/_rels\/[^/]+$/, '');
      const xml = new TextDecoder().decode(e.bytes);
      for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
        if (/TargetMode="External"/.test(m[0])) continue;
        const target = /Target="([^"]+)"/.exec(m[0])![1];
        expect(present.has(`${dir}${target}`)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2);        // the assertion above ran
  });

  it('marks a hyperlink relationship external', () => {
    const rels = textOf(parts(built()), 'word/_rels/document.xml.rels');
    expect(rels).toMatch(/Target="https:\/\/example\.com"[^>]*TargetMode="External"/);
  });

  it('parses every XML part', () => {
    for (const e of parts(built())) {
      if (!e.path.endsWith('.xml') && !e.path.endsWith('.rels')) continue;
      expect(() => parseXml(e.bytes)).not.toThrow();
    }
  });

  // Both are serializers over one model, so their VISIBLE text cannot disagree.
  // A link's destination is not visible text and legitimately differs: Markdown
  // writes the URL inline, a .docx puts it in a relationship -- which is why
  // the Markdown side is reduced to its link labels first.
  it('agrees with the Markdown export about the text', () => {
    const doc = built();
    const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    // Tags become a SPACE, not '': the body carries no whitespace between block
    // elements, so stripping them to nothing would glue two paragraphs into one
    // word and fail on a difference the documents do not have.
    const docx = textOf(parts(doc), 'word/document.xml').replace(/<[^>]+>/g, ' ');
    const md = doc.ToMarkdown().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    expect(words(docx)).toBe(words(md));
  });

  // Word's default is US Letter, so an A4 document would otherwise reflow on
  // open -- a change made by saying nothing.
  it('closes the body with the page size', () => {
    expect(textOf(parts(built()), 'word/document.xml')).toContain('<w:pgSz ');
  });

  // Two runs over one input must give identical bytes, or nothing downstream
  // can be snapshot-tested.
  it('is byte-reproducible', () => {
    const doc = built();
    expect(Buffer.from(doc.ToDocx()).equals(Buffer.from(doc.ToDocx()))).toBe(true);
  });

  it('omits numbering when the document has no list', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph('No lists here.');
    flow.Render();
    expect(paths(doc)).not.toContain('word/numbering.xml');
  });

  it('exports one page on its own', () => {
    const doc = built();
    expect(() => unzip(doc.Pages[0].ToDocx())).not.toThrow();
  });
});
