import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseXml } from '../src/xml.js';
import { Table, type TableCell, type TableRow } from '../src/tablemodel.js';
import { buildTextAndImagePage } from './helpers/build-edit-pdf.js';

/** A caption and a 1x1 image scaled to 100pt, for the /Figure path — the same
 *  page html-identity.test.ts uses. */
const FIGURE_PAGE =
  'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q';

/** The body markup, wrapped in a single root so a fragment can be parsed.
 *
 *  This is what turns "we emit XHTML" from a claim into a check: EPUB content
 *  documents must be well-formed XML, and this is the serializer that produces
 *  them. */
function parsesAsXml(fragment: string): boolean {
  try {
    parseXml(new TextEncoder().encode(`<root>${fragment}</root>`));
    return true;
  } catch {
    return false;
  }
}

/** A one-cell table whose text carries a newline — the only thing that makes
 *  `toHtml` emit a `<br>` at all. Built directly rather than extracted, as
 *  `table-markdown.test.ts` does, because no PDF fixture in the suite produces
 *  a multi-line cell. */
function cellTable(text: string): Table {
  const c: TableCell = { row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: [0, 0, 1, 1], text };
  const row: TableRow = { cells: [c], quad: [0, 0, 1, 1] };
  return new Table([0, 0, 1, 1], 1, 1, [row]);
}

describe('semantic markup is well-formed XHTML', () => {
  // NOTE, measured: the fixture must actually CONTAIN an image. The first
  // version of this test used buildUntaggedHtmlPdf, which emits only <h1> and
  // <p> — so it passed with the bug fully present and proved nothing.
  it('self-closes the <img> in a figure', () => {
    const html = Document.Open(buildTextAndImagePage(FIGURE_PAGE)).ToHtml({ fragment: true });
    expect(html).toContain('<img ');            // the fixture is not vacuous
    expect(html).not.toMatch(/<img[^>]*[^/]>/);
    expect(parsesAsXml(html)).toBe(true);
  });

  it('self-closes the <br> in a table cell', () => {
    const html = cellTable('one\ntwo').toHtml();
    expect(html).toContain('<br/>');
    expect(html).not.toMatch(/<br>/);
    expect(parsesAsXml(html)).toBe(true);
  });
});
