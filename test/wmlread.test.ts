import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDocx, openDocx } from '../src/wmlread.js';
import { buildDocx } from './helpers/build-docx.js';
import type { WmlParagraph, WmlTable, WmlInline, WmlBlock } from '../src/wmlbody.js';
import { buildOoxmlPackage, type OoxmlPart, type OoxmlRelationship } from '../src/ooxml.js';
import { Document } from '../src/index.js';
import { PdfParseError } from '../src/errors.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';
import { docXml, stylesXml, style, p, r, enc, W_STRICT } from './helpers/wml.js';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STRICT_REL = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const textOf = (x: { inlines: WmlInline[] }) => x.inlines.map((i) => (i.kind === 'text' ? i.text : '')).join('');
const paras = (blocks: WmlBlock[]) => blocks.filter((b): b is WmlParagraph => b.kind === 'paragraph');

function pkg(document: Uint8Array, extra: { parts?: OoxmlPart[]; rels?: OoxmlRelationship[]; relBase?: string } = {}): Uint8Array {
  const base = extra.relBase ?? REL;
  return buildOoxmlPackage([{ path: 'word/document.xml', bytes: document, contentType: `${CT}.document.main+xml` }, ...(extra.parts ?? [])],
    [{ source: '', id: 'rId1', type: `${base}/officeDocument`, target: 'word/document.xml' }, ...(extra.rels ?? [])]);
}

describe('readDocx', () => {
  it('reads a package with styles through the main document\'s relationships', () => {
    const doc = readDocx(pkg(docXml(p(r('Hi'), '<w:pStyle w:val="H"/>')), {
      parts: [{ path: 'word/styles.xml', bytes: stylesXml(style('paragraph', 'H', '<w:pPr><w:outlineLvl w:val="1"/></w:pPr>')), contentType: `${CT}.styles+xml` }],
      rels: [{ source: 'word/document.xml', id: 'rS', type: `${REL}/styles`, target: 'styles.xml' }],
    }));
    expect(paras(doc.blocks)[0]).toMatchObject({ heading: 2 });
    expect(doc.unsupported).toEqual([]);
  });

  it('reads a Strict package: Strict relationship types and a Strict namespace', () => {
    const strictDoc = enc(`<w:document xmlns:w="${W_STRICT}"><w:body>${p(r('strict'))}</w:body></w:document>`);
    expect(textOf(paras(readDocx(pkg(strictDoc, { relBase: STRICT_REL })).blocks)[0])).toBe('strict');
  });

  it('degrades an unreadable styles part to no styles, and records it', () => {
    const doc = readDocx(pkg(docXml(p(r('x'))), {
      parts: [{ path: 'word/styles.xml', bytes: enc('<w:styles'), contentType: `${CT}.styles+xml` }],
      rels: [{ source: 'word/document.xml', id: 'rS', type: `${REL}/styles`, target: 'styles.xml' }],
    }));
    expect(textOf(paras(doc.blocks)[0])).toBe('x');
    expect(doc.unsupported).toEqual([{ name: 'styles.xml: unreadable', count: 1 }]);
  });

  it('records a styles, numbering or theme relationship naming a part the package does not hold', () => {
    const doc = readDocx(pkg(docXml(p(r('x'))), {
      rels: [
        { source: 'word/document.xml', id: 'rS', type: `${REL}/styles`, target: 'styles.xml' },
        { source: 'word/document.xml', id: 'rN', type: `${REL}/numbering`, target: 'numbering.xml' },
        { source: 'word/document.xml', id: 'rT', type: `${REL}/theme`, target: 'theme/theme1.xml' },
      ],
    }));
    expect(textOf(paras(doc.blocks)[0])).toBe('x');
    expect(doc.unsupported).toEqual([
      { name: 'numbering.xml: missing', count: 1 }, { name: 'styles.xml: missing', count: 1 }, { name: 'theme: missing', count: 1 }]);
  });

  it('refuses a package with no main document, or one whose target is absent', () => {
    const none = buildOoxmlPackage([{ path: 'a.xml', bytes: enc('<a/>'), contentType: 'application/xml' }], []);
    expect(() => readDocx(none)).toThrow(/not a WordprocessingML document/);
    const dangling = buildOoxmlPackage([{ path: 'a.xml', bytes: enc('<a/>'), contentType: 'application/xml' }],
      [{ source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' }]);
    expect(() => readDocx(dangling)).toThrow(PdfParseError);
  });

  it('takes the FIRST of several officeDocument relationships, and does not fall through to a later one', () => {
    const second = { path: 'word/other.xml', bytes: docXml(p(r('second'))), contentType: `${CT}.document.main+xml` };
    const two = pkg(docXml(p(r('first'))), {
      parts: [second], rels: [{ source: '', id: 'rId2', type: `${REL}/officeDocument`, target: 'word/other.xml' }],
    });
    expect(textOf(paras(readDocx(two).blocks)[0])).toBe('first');
    const deadFirst = buildOoxmlPackage([second], [
      { source: '', id: 'rId1', type: `${REL}/officeDocument`, target: 'word/document.xml' },
      { source: '', id: 'rId2', type: `${REL}/officeDocument`, target: 'word/other.xml' }]);
    expect(() => readDocx(deadFirst)).toThrow(/no main document part/);
  });

  it('drops the part of an image whose relationship names a part the package does not hold', () => {
    const drawing = '<w:r><w:drawing><wp:inline><wp:extent cx="12700" cy="12700"/><wp:docPr id="1" name="p"/>'
      + '<a:graphic><a:graphicData uri="x"><pic:pic><pic:blipFill><a:blip r:embed="rI"/></pic:blipFill></pic:pic>'
      + '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    const doc = readDocx(pkg(docXml(p(drawing)), {
      rels: [{ source: 'word/document.xml', id: 'rI', type: `${REL}/image`, target: 'media/nope.png' }],
    }));
    expect(paras(doc.blocks)[0].inlines).toEqual([{ kind: 'image', widthPt: 1, heightPt: 1 }]);
    expect(doc.unsupported).toEqual([{ name: 'a:blip (unresolved image)', count: 1 }]);
  });

  it('sorts and totals the unsupported report', () => {
    const doc = readDocx(pkg(docXml(p('<w:r><w:commentReference w:id="1"/></w:r>') + p('<w:r><w:commentReference w:id="2"/><w:sym/></w:r>'))));
    expect(doc.unsupported).toEqual([{ name: 'w:commentReference', count: 2 }, { name: 'w:sym', count: 1 }]);
  });
});

describe('readDocx over ToDocx output', () => {
  it('reads headings, both list kinds, an image, a link and a spanning table cell', () => {
    const d = Document.New();
    const flow = d.NewFlow({ tagged: true });
    const png = Buffer.from(buildPngRgbWith(4, 4, new Array(48).fill(128), 0)).toString('base64');
    flow.AddMarkdown(['# Title', '', '- one', '- two', '', '1. first', '2. second', '',
      `![pic](data:image/png;base64,${png})`, '', '[the docs](https://example.com)', ''].join('\n'));
    flow.AddHtml('<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>');
    flow.Render();
    const doc = readDocx(d.ToDocx());
    const ps = paras(doc.blocks);
    expect(ps.find((x) => textOf(x) === 'Title')?.heading).toBe(1);
    expect(ps.filter((x) => x.list?.bullet).map(textOf)).toEqual(['one', 'two']);
    expect(ps.filter((x) => x.list && !x.list.bullet).map((x) => [textOf(x), x.list!.label])).toEqual([['first', '1.'], ['second', '2.']]);
    const img = ps.flatMap((x) => x.inlines).find((i) => i.kind === 'image');
    expect(img).toMatchObject({ kind: 'image', part: expect.stringMatching(/^word\/media\//) });
    const link = ps.flatMap((x) => x.inlines).find((i) => i.kind === 'text' && i.link);
    expect(link).toMatchObject({ text: expect.stringContaining('the docs'), link: { url: 'https://example.com' } });
    const table = doc.blocks.find((b): b is WmlTable => b.kind === 'table');
    expect(table?.rows[0].cells[0].span).toBe(2);
    expect(doc.page?.widthPt).toBeGreaterThan(0);
  });
});

describe('readDocx over a Word 2010 document (test/fixtures/docx/PROVENANCE.md)', () => {
  const doc = readDocx(new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'docx', 'word2010-basic.docx'))));
  const ps = paras(doc.blocks);

  it('reads the heading through Word\'s localized style id', () => {
    expect(ps[0]).toMatchObject({ heading: 1, styleName: 'heading 1' });
    expect(textOf(ps[0])).toBe('Quarterly Report');
  });

  it('numbers the list', () => {
    expect(ps.filter((x) => x.list).map((x) => [textOf(x), x.list!.label])).toEqual([['First item', '1.'], ['Second item', '2.']]);
  });

  it('resolves the image and the link', () => {
    const inlines = ps.flatMap((x) => x.inlines);
    expect(inlines.find((i) => i.kind === 'image')).toMatchObject({ part: 'word/media/image1.png' });
    expect(inlines.find((i) => i.kind === 'text' && i.link)).toMatchObject({ text: 'the docs', link: { url: 'https://example.com' } });
  });

  it('reads the A4 page and resolves the theme body font', () => {
    expect(doc.page).toMatchObject({ widthPt: 595.3, heightPt: 841.9 });
    expect((ps[1].inlines[0] as { props: { font?: string } }).props.font).toBe('Calibri');
  });
});

describe('openDocx', () => {
  it('reads a part lazily, with its content type, and says nothing for a missing one', () => {
    const png = buildPngRgbWith(2, 2, [255, 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0], 0);
    const o = openDocx(buildDocx(p(r('x')), { media: [{ name: 'a.png', bytes: png, contentType: 'image/png' }] }));
    expect(o.readPart('word/media/a.png')).toEqual({ bytes: png, contentType: 'image/png' });
    expect(o.readPart('word/media/none.png')).toBeUndefined();
  });

  it('maps fontTable w:family to a generic class, by exact font name', () => {
    const o = openDocx(buildDocx(p(r('x')), { fontTable:
      '<w:font w:name="Cambria"><w:family w:val="roman"/></w:font><w:font w:name="Calibri"><w:family w:val="swiss"/></w:font>'
      + '<w:font w:name="Consolas"><w:family w:val="modern"/></w:font><w:font w:name="Brush"><w:family w:val="script"/></w:font>' }));
    expect(['Cambria', 'Calibri', 'Consolas', 'Brush', 'Nope'].map((n) => o.fontClass(n)))
      .toEqual(['serif', 'sans-serif', 'monospace', 'sans-serif', undefined]);
  });

  it('reads a non-blank core title, and none for a blank or absent one', () => {
    expect(openDocx(buildDocx(p(r('x')), { core: '<dc:title> Report </dc:title>' })).title).toBe('Report');
    expect(openDocx(buildDocx(p(r('x')), { core: '<dc:title>  </dc:title>' })).title).toBeUndefined();
    expect(openDocx(buildDocx(p(r('x')))).title).toBeUndefined();
  });

  it('degrades an unreadable font table to no classes, and records it', () => {
    const o = openDocx(buildDocx(p(r('x')), { fontTable: '<w:font' }));
    expect(o.fontClass('Calibri')).toBeUndefined();
    expect(o.doc.unsupported).toContainEqual({ name: 'fontTable.xml: unreadable', count: 1 });
  });
});
