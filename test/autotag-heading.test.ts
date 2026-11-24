import { describe, expect, it } from 'vitest';
import type { AutoTagOptions } from '../src/autotag.js';
import { prepareHeadings } from '../src/autotagheading.js';
import { Document } from '../src/document.js';
import { encodeDest, type OutlineItem } from '../src/outline.js';
import { isDict, name, type PdfObject } from '../src/types.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

function tags(doc: Document): string[] {
  return Document.Open(doc.Save()).GetStructTree()!.Children.map(el => el.Type);
}

describe('AutoTag heading strategies', () => {
  it('applies inclusive size cutoffs, independent of the body size, to at most two lines', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 18 Tf 20 270 Td (One) Tj ET ' +
      'BT /F1 17.9 Tf 20 225 Td (Two) Tj ET ' +
      'BT /F1 12 Tf 20 180 Td (Three) Tj ET ' +
      'BT /F1 11.9 Tf 20 140 Td (Body) Tj ET ' +
      'BT /F1 18 Tf 20 95 Td (A) Tj 0 -20 Td (B) Tj 0 -20 Td (C) Tj ET',
    ]));
    const report = doc.AutoTag({ headingStrategy: 'thresholds', headingThresholds: [18, 12], tables: false });
    expect(tags(doc)).toEqual(['H1', 'H2', 'H2', 'P', 'P']);
    expect(report.headings).toBe(3);
  });

  it('matches complete outline titles only on their target pages and uses their depth', () => {
    const doc = Document.New();
    const first = doc.AddPage().page, second = doc.AddPage().page;
    first.AddText('Introduction', 30, 350, { fontSize: 12 });
    first.AddText('An appendix', 30, 250, { fontSize: 24 });
    second.AddText('Introduction', 30, 350, { fontSize: 12 });
    second.AddText('Named target', 30, 250, { fontSize: 12 });
    second.AddText('Deep target', 30, 150, { fontSize: 12 });
    second.AddText('External', 30, 50, { fontSize: 24 });
    doc.SetNamedDestination('section', { page: 2 });
    let deep: OutlineItem = { Title: 'Deep target', Action: { type: 'goto', page: 2 } };
    for (let i = 0; i < 6; i++) deep = { Title: 'Folder', Children: [deep] };
    doc.SetOutlines([
      { Title: 'Introduction', Dest: { page: 1 }, Children: [
        { Title: '  named   TARGET ', Dest: { name: 'section' } },
      ] },
      { Title: 'appendix', Dest: { page: 1 } },
      { Title: 'External', Action: { type: 'uri', uri: 'https://example.org' } },
      deep,
    ]);
    expect(doc.AutoTag({ headingStrategy: 'outline', tables: false }).headings).toBe(3);
    expect(tags(doc)).toEqual(['H1', 'P', 'P', 'H2', 'H6', 'P']);
  });

  it('keeps repeated page text and ambiguous bookmark levels as paragraphs', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    page.AddText('Repeated', 30, 350, { fontSize: 20 });
    page.AddText('Repeated', 30, 250, { fontSize: 12 });
    page.AddText('Conflict', 30, 150, { fontSize: 16 });
    doc.SetOutlines([
      { Title: 'Repeated', Dest: { page: 1 } },
      { Title: 'Conflict', Dest: { page: 1 }, Children: [{ Title: 'Conflict', Dest: { page: 1 } }] },
    ]);
    expect(doc.AutoTag({ headingStrategy: 'outline', tables: false }).headings).toBe(0);
    expect(tags(doc)).toEqual(['P', 'P', 'P']);
  });

  it('does not reuse an outline title for matching text split out of another block', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 12 Tf 20 245 Td (Heading) Tj ET ' +
      'BT /F1 12 Tf 20 150 Td (Heading) Tj 0 -14 Td (- Item) Tj ET',
    ]));
    doc.SetOutlines([{ Title: 'Heading', Dest: { page: 1 } }]);
    const page = doc.Pages[0], blocks = page.GetStructuredText();
    const classify = prepareHeadings(doc, { headingStrategy: 'outline' });
    expect(classify(page, blocks[0], blocks)).toBe(1);
    const line = blocks[1].lines[0];
    expect(classify(page, { lines: [line], text: line.text, quad: line.quad }, blocks)).toBeUndefined();
  });

  it('follows a GoTo string to its name-tree page when a legacy destination shadows its name', () => {
    const doc = Document.New();
    for (let i = 0; i < 2; i++) doc.AddPage().page.AddText('Section', 30, 250);
    doc.SetNamedDestination('section', { page: 2 });
    doc.catalog().set('Dests', new Map([['section', encodeDest(doc.pageRef(1))]]));
    doc.SetOutlines([{ Title: 'Section', Dest: { name: 'section' } }]);
    const outlines = doc.resolve(doc.catalog().get('Outlines'));
    const item = isDict(outlines) && doc.resolve(outlines.get('First'));
    if (!isDict(item)) throw new Error('expected outline item');
    item.set('A', new Map<string, PdfObject>([['S', name('GoTo')], ['D', item.get('Dest')!]]));
    item.delete('Dest');

    doc.AutoTag({ headingStrategy: 'outline' });
    expect(tags(doc)).toEqual(['P', 'H1']);
  });

  it.each([
    { headingStrategy: 'bogus' }, { headingStrategy: null },
    { headingStrategy: 'thresholds' }, { headingThresholds: [18] },
    { headingStrategy: 'outline', headingThresholds: [18] },
    ...[[], [10, 20], [10, 10], [0], [Infinity], [NaN], Array(2), [7, 6, 5, 4, 3, 2, 1], '18']
      .map(headingThresholds => ({ headingStrategy: 'thresholds', headingThresholds })),
  ])('rejects invalid heading configuration before mutating the PDF (%j)', options => {
    const doc = Document.New();
    doc.AddPage();
    const before = doc.Save();
    expect(() => doc.AutoTag({ ...options, lang: 'en' } as AutoTagOptions)).toThrow();
    expect(doc.Save()).toEqual(before);
  });
});
