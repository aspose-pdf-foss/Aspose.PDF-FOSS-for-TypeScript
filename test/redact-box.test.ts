import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paintRedactionBoxes } from '../src/redact.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

describe('paintRedactionBoxes', () => {
  it('paints an opaque black filled rectangle on top of existing content', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (hi) Tj ET']));
    const page = doc.Pages[0];
    paintRedactionBoxes(doc, page, [[40, 95, 120, 115]]); // default colour

    const c = content(Document.Open(doc.Save()));
    expect(c).toContain('0 0 0 rg');        // black fill
    expect(c).toContain('40 95 80 20 re');  // [x0,y0,x1,y1] -> x,y,w,h
    expect(c).toMatch(/\bf\b/);             // fill
    expect(c.indexOf('(hi)')).toBeLessThan(c.indexOf('0 0 0 rg')); // box drawn last
  });

  it('uses a configurable fill colour', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (hi) Tj ET']));
    paintRedactionBoxes(doc, doc.Pages[0], [[10, 10, 20, 20]], [1, 0, 0]); // red
    expect(content(Document.Open(doc.Save()))).toContain('1 0 0 rg');
  });

  it('paints one rectangle per region', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (hi) Tj ET']));
    paintRedactionBoxes(doc, doc.Pages[0], [[10, 10, 30, 30], [100, 100, 140, 160]]);
    const c = content(Document.Open(doc.Save()));
    expect(c).toContain('10 10 20 20 re');
    expect(c).toContain('100 100 40 60 re');
    expect((c.match(/\bre\b/g) ?? []).length).toBe(2);
  });

  it('is a no-op for an empty region list', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (hi) Tj ET']));
    const before = doc.Pages[0].Dict.get('Contents');
    paintRedactionBoxes(doc, doc.Pages[0], []);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(before); // nothing appended
  });

  it('throws TypeError for a malformed rectangle', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (hi) Tj ET']));
    expect(() => paintRedactionBoxes(doc, doc.Pages[0], [[0, 0, NaN, 10]])).toThrow(TypeError);
  });
});
