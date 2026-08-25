import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

const docFor = (stream: string) => Document.Open(buildSimpleTextPdf(stream));

const documentXml = (bytes: Uint8Array): string => textOf(unzip(bytes), 'word/document.xml');

describe('ToDocx({ mode: "textbox" })', () => {
  it('positions text in page-anchored frames', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    const xml = documentXml(doc.ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('w:framePr');
    expect(xml).toContain('w:hAnchor="page"');
    expect(xml).toContain('Hello');
  });

  it('states the page size from the sizing box', () => {
    // build-text-pdf's MediaBox is 300x300 points -> 6000x6000 twips.
    const xml = documentXml(docFor('BT /F1 12 Tf 20 100 Td (Hi) Tj ET').ToDocx({ mode: 'textbox' }));
    expect(xml).toContain('<w:pgSz w:w="6000" w:h="6000"/>');
  });

  it('carries the fill colour end to end', () => {
    // GlyphEvent.color -> TextGroup.color -> w:color, the whole Task 1 chain.
    const doc = docFor('BT /F1 12 Tf 20 100 Td 1 0 0 rg (Red) Tj ET');
    expect(documentXml(doc.ToDocx({ mode: 'textbox' }))).toContain('<w:color w:val="FF0000"/>');
  });

  it('splits a leader row into two frames', () => {
    // The adaptive merge, observed through the real pipeline rather than from
    // hand-built events: two runs far apart on one baseline stay apart.
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Intro) Tj 200 0 Td (3) Tj ET');
    const xml = documentXml(doc.ToDocx({ mode: 'textbox' }));
    expect((xml.match(/w:framePr/g) ?? []).length).toBe(2);
  });

  it('emits no w:framePr in flow mode', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    expect(documentXml(doc.ToDocx())).not.toContain('w:framePr');
    expect(documentXml(doc.ToDocx({ mode: 'flow' }))).not.toContain('w:framePr');
  });

  it('emits no styles or numbering part in textbox mode', () => {
    // It names no style id and allocates no list, and a part defining styles
    // nobody uses is the same nothing as a .rels with no relationships.
    const paths = unzip(docFor('BT /F1 12 Tf 20 100 Td (Hi) Tj ET')
      .ToDocx({ mode: 'textbox' })).map((e) => e.path);
    expect(paths).not.toContain('word/styles.xml');
    expect(paths).not.toContain('word/numbering.xml');
  });

  it('renders one page through Page.ToDocx', () => {
    const doc = docFor('BT /F1 12 Tf 20 100 Td (Hello) Tj ET');
    expect(documentXml(doc.Pages[0].ToDocx({ mode: 'textbox' }))).toContain('w:framePr');
  });

  it('never throws on a page with no text', () => {
    const doc = docFor('');
    expect(() => doc.ToDocx({ mode: 'textbox' })).not.toThrow();
    expect(documentXml(doc.ToDocx({ mode: 'textbox' }))).toContain('<w:sectPr>');
  });
});
