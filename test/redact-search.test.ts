import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

/** Full latin1 text of the page's /Contents (fixtures are single-stream here). */
function contentText(doc: Document, pageIndex = 0): string {
  return new TextDecoder('latin1').decode(doc.Pages[pageIndex].Contents);
}

describe('page.RedactText', () => {
  it('redacts a literal match: removes the glyphs and paints a marker', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    const n = doc.Pages[0].RedactText('Secret');
    expect(n).toBe(1);

    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('Secret'); // glyphs gone
    expect(re.Pages[0].Search('Secret')).toHaveLength(0);
    expect(contentText(re)).toContain('rg');               // a marker fill was painted
  });

  it('redacts every RegExp occurrence and returns the count', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 10 Tf 50 150 Td (id 111 here) Tj ET',
      'BT /F1 10 Tf 50 100 Td (id 222 here) Tj ET',
    ]));
    const n = doc.Pages[0].RedactText(/\d{3}/);
    expect(n).toBe(2);
    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('111');
    expect(re.Pages[0].GetText()).not.toContain('222');
  });

  it('honors marker color and scrubMetadata', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (classified) Tj ET']));
    doc.SetMetadata({ author: 'Alice' });
    const n = doc.Pages[0].RedactText('classified', { color: [1, 0, 0], scrubMetadata: true });
    expect(n).toBe(1);

    const re = Document.Open(doc.Save());
    expect(contentText(re)).toContain('1 0 0 rg');         // red marker
    expect(re.GetMetadata().author).toBeUndefined();       // metadata scrubbed
  });

  it('no match is a no-op: returns 0 and leaves text + metadata intact', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (visible) Tj ET']));
    doc.SetMetadata({ author: 'Bob' });
    const n = doc.Pages[0].RedactText('absent', { scrubMetadata: true });
    expect(n).toBe(0);

    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).toContain('visible');    // untouched
    expect(re.GetMetadata().author).toBe('Bob');           // not scrubbed on a no-op
  });
});

describe('doc.RedactText', () => {
  it('redacts across all pages and returns the total occurrences', () => {
    const src = buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (secret) Tj ET']);
    const doc = Document.Open(src);
    doc.AddPage(Document.Open(src).Pages[0]); // a second page with the same word
    expect(doc.Pages).toHaveLength(2);

    const total = doc.RedactText('secret');
    expect(total).toBe(2);
    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('secret');
    expect(re.Pages[1].GetText()).not.toContain('secret');
  });
});
