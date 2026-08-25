import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { runXml } from '../src/docxflow.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

describe('runXml vertical alignment', () => {
  it('emits nothing when script is unset', () => {
    expect(runXml('x')).toBe('<w:r><w:t xml:space="preserve">x</w:t></w:r>');
  });

  it('emits w:vertAlign for super and sub', () => {
    expect(runXml('2', { script: 'super' })).toContain('<w:vertAlign w:val="superscript"/>');
    expect(runXml('2', { script: 'sub' })).toContain('<w:vertAlign w:val="subscript"/>');
  });

  it('places w:vertAlign after w:szCs, as CT_RPr orders it', () => {
    // ECMA-376 CT_RPr is a SEQUENCE: ... color, sz, szCs, highlight, u, ...,
    // vertAlign. Wrong order is a file Word refuses, so this is asserted rather
    // than trusted. Unlike w:framePr in w:pPr, vertAlign happens to come last
    // among the properties this emitter writes, so appending is correct here.
    const xml = runXml('2', { script: 'super', size: 6, bold: true, color: [255, 0, 0] });
    expect(xml.indexOf('w:b/')).toBeLessThan(xml.indexOf('w:color'));
    expect(xml.indexOf('w:color')).toBeLessThan(xml.indexOf('w:sz '));
    expect(xml.indexOf('w:szCs')).toBeLessThan(xml.indexOf('w:vertAlign'));
  });
});

/** H, then a smaller raised 2, then O — one face, the superscript INSIDE the
 *  run. A same-size raised run would be absorbed into its neighbour's fragment
 *  and never classified; measured in c3t7.1. */
const h2o = () => buildSimpleTextPdf(
  'BT /F1 10 Tf 20 250 Td (H) Tj /F1 6 Tf 3.3 Ts (2) Tj 0 Ts /F1 10 Tf (O) Tj ET',
);

const documentXml = (bytes: Uint8Array): string => textOf(unzip(bytes), 'word/document.xml');

describe('script through the DOCX export', () => {
  it('marks the superscript run and only that run', () => {
    const xml = documentXml(Document.Open(h2o()).ToDocx());
    expect((xml.match(/<w:vertAlign w:val="superscript"\/>/g) ?? [])).toHaveLength(1);
    expect(xml).toContain('2');
  });

  it('keeps the surrounding text in its own unmarked runs', () => {
    const xml = documentXml(Document.Open(h2o()).ToDocx());
    // Three runs: H, the raised 2, and O — the script boundary splits them, so a
    // single merged run would mean the model lost the distinction.
    expect((xml.match(/<w:r>/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('marks a subscript', () => {
    const doc = Document.Open(buildSimpleTextPdf(
      'BT /F1 10 Tf 20 250 Td (H) Tj /F1 6 Tf -2 Ts (2) Tj 0 Ts /F1 10 Tf (O) Tj ET',
    ));
    expect(documentXml(doc.ToDocx())).toContain('<w:vertAlign w:val="subscript"/>');
  });

  it('emits no w:vertAlign for ordinary text', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 10 Tf 20 250 Td (plain text) Tj ET'));
    expect(documentXml(doc.ToDocx())).not.toContain('w:vertAlign');
  });
});
