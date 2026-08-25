import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { EditableContent } from '../src/editcontent.js';
import { buildMultiStreamPage, buildSharedXObjectPages } from './helpers/build-edit-pdf.js';

describe('EditableContent — read', () => {
  it('exposes each /Contents stream as its own op list', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 12 Tf 72 144 Td (Hi) Tj ET',
      '1 0 0 RG 10 10 m 20 20 l S',
    ]));
    const ec = new EditableContent(doc, doc.Pages[0]);
    expect(ec.streamCount).toBe(2);
    expect(ec.topOps(0).map((o) => o.operator)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET']);
    expect(ec.topOps(1).map((o) => o.operator)).toEqual(['RG', 'm', 'l', 'S']);
  });

  it('reports zero streams for a page with no /Contents', () => {
    const doc = Document.Open(buildMultiStreamPage([]));
    const ec = new EditableContent(doc, doc.Pages[0]);
    expect(ec.streamCount).toBe(0);
  });
});

describe('EditableContent — edit + commit', () => {
  it('replaces a stream\'s ops and writes them back into /Contents', () => {
    const doc = Document.Open(buildMultiStreamPage([
      'BT /F1 12 Tf 72 144 Td (secret) Tj ET',
    ]));
    const page = doc.Pages[0];
    const ec = new EditableContent(doc, page);
    const ops = ec.topOps(0).filter((o) => o.operator !== 'Tj'); // drop the show op
    ec.setTopOps(0, [...ops]);
    ec.commit();

    const reopened = Document.Open(doc.Save());
    const text = new TextDecoder().decode(reopened.Pages[0].Contents);
    expect(text).not.toContain('secret');
    expect(text).toContain('Td'); // surrounding ops preserved
  });

  it('leaves unmodified streams untouched', () => {
    const doc = Document.Open(buildMultiStreamPage(['(a) Tj', '(b) Tj']));
    const page = doc.Pages[0];
    const before = page.Dict.get('Contents');
    const ec = new EditableContent(doc, page);
    ec.commit(); // no edits
    expect(page.Dict.get('Contents')).toBe(before); // identical reference: nothing rewritten
  });
});

describe('EditableContent — XObject copy-on-write', () => {
  it('edits a shared Form XObject for one page without touching the other', () => {
    const doc = Document.Open(buildSharedXObjectPages());
    const ec = new EditableContent(doc, doc.Pages[0]);

    const ops = ec.xobjectOps(['Fm0']).filter((o) => o.operator !== 'Tj');
    ec.setXobjectOps(['Fm0'], [...ops]);
    ec.commit();

    const re = Document.Open(doc.Save());
    expect(re.Pages[0].GetText()).not.toContain('shared'); // edited page
    expect(re.Pages[1].GetText()).toContain('shared');      // untouched page
  });
});
