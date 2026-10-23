import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageFormControls } from '../src/htmlforms.js';
import { name, type PdfDict } from '../src/types.js';

/** A paper forms barcode (2srz.4) next to an ordinary text field, both
 *  filled, so the barcode carries tab-delimited content and a drawn symbol. */
function form(): Document {
  const doc = Document.New();
  doc.AddPage(PageFormat.custom(400, 300));
  doc.Form.AddTextField({ name: 'a', page: 1, rect: [10, 260, 100, 280] });
  doc.Form.AddBarcodeField({ name: 'bc', page: 1, rect: [20, 20, 380, 180] });
  (doc.Form.Get('a')!).Value = 'alpha';
  return Document.Open(doc.Save());
}

describe('ToHtml({ forms: true }) and a paper forms barcode (2srz.6)', () => {
  it('converts the ordinary field and leaves the barcode widget unclaimed', () => {
    const doc = form();
    let tab = 0;
    const r = pageFormControls(doc, doc.Pages[0], doc.Form, () => ++tab);
    const widgetOf = (n: string) => doc.Form.Get(n)!.Widgets[0] as PdfDict;
    expect(r.converted.has(widgetOf('a'))).toBe(true);
    // Unclaimed means the page render keeps drawing the symbol.
    expect(r.converted.has(widgetOf('bc'))).toBe(false);
    expect(r.html).not.toContain('name="bc"');
  });

  it('still draws the symbol in the fixed export', () => {
    const html = form().ToHtml({ mode: 'fixed', forms: true });
    expect(html).toContain('name="a"');
    expect(html).not.toContain('name="bc"');
    // Exactly one control carries the value: the ordinary field's.
    expect(html.match(/value="alpha"/g) ?? []).toHaveLength(1);
    // The symbol is still painted: the page SVG holds the barcode's modules,
    // where with nothing drawn it is an empty <svg></svg>.
    const svg = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'));
    expect(svg).toMatch(/<path|<rect/);
  });

  it('converts a text field whose /PMD is unreadable, as the generator draws it as text', () => {
    const doc = form();
    const bc = doc.Form.Get('bc')!;
    // A symbology readPmd does not know: no barcode, an ordinary text field.
    expect(bc.Dict.has('PMD')).toBe(true);
    bc.Dict.set('PMD', new Map([['Symbology', name('Aztec')]]) as PdfDict);
    let tab = 0;
    const r = pageFormControls(doc, doc.Pages[0], doc.Form, () => ++tab);
    expect(r.converted.has(bc.Widgets[0] as PdfDict)).toBe(true);
  });
});
