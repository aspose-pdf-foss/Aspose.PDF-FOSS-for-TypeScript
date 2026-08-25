import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';
import { unzip, textOf } from './helpers/unzip.js';

/** A borderless table whose first row spans both columns. The geometry the
 *  pure tests use is taken from this page, measured rather than assumed. */
const spanningPdf = () => buildSimpleTextPdf([
  'BT /F1 10 Tf 20 260 Td (Quarterly results) Tj ET',
  'BT /F1 10 Tf 20 245 Td (Q1) Tj 100 0 Td (Q2) Tj ET',
  'BT /F1 10 Tf 20 230 Td (10) Tj 100 0 Td (20) Tj ET',
].join(' '));

const firstTable = () => Document.Open(spanningPdf()).Pages[0].GetTables()[0];

describe('whitespace table spans, end to end', () => {
  it('reports the header as one spanning cell', () => {
    const t = firstTable();
    expect(t.rows[0].cells).toHaveLength(1);
    expect(t.rows[0].cells[0].colSpan).toBe(2);
    expect(t.rows[0].cells[0].text).toBe('Quarterly results');
  });

  it('leaves the body rows 1x1', () => {
    // Without this, the assertion above is satisfied by spanning EVERY cell,
    // which is the worst available bug.
    const t = firstTable();
    for (const r of t.rows.slice(1)) {
      expect(r.cells).toHaveLength(2);
      expect(r.cells.every((c) => c.colSpan === 1)).toBe(true);
    }
  });

  it('emits colspan in HTML', () => {
    expect(firstTable().toHtml()).toContain('colspan="2"');
  });

  it('emits w:gridSpan in DOCX', () => {
    // The span must reach the export layer, not just the model.
    const zip = unzip(Document.Open(spanningPdf()).Pages[0].ToDocx());
    expect(textOf(zip, 'word/document.xml')).toContain('<w:gridSpan w:val="2"/>');
  });

  it('does not span a table whose rows are uniform', () => {
    const doc = Document.Open(buildSimpleTextPdf([
      'BT /F1 10 Tf 20 260 Td (Q1) Tj 100 0 Td (Q2) Tj ET',
      'BT /F1 10 Tf 20 245 Td (10) Tj 100 0 Td (20) Tj ET',
    ].join(' ')));
    const t = doc.Pages[0].GetTables()[0];
    for (const r of t.rows) expect(r.cells.every((c) => c.colSpan === 1)).toBe(true);
  });
});
