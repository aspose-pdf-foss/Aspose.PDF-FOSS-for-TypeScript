import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { PdfDict, PdfObject } from '../src/types.js';

describe('Document.DisplayDocTitle', () => {
  it('is false on a fresh document', () => {
    expect(Document.New().DisplayDocTitle).toBe(false);
  });

  it('round-trips through a save and reopen', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    doc.DisplayDocTitle = true;
    expect(doc.DisplayDocTitle).toBe(true);
    expect(Document.Open(doc.Save()).DisplayDocTitle).toBe(true);
  });

  it('can be turned back off', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    doc.DisplayDocTitle = true;
    doc.DisplayDocTitle = false;
    expect(Document.Open(doc.Save()).DisplayDocTitle).toBe(false);
  });

  it('preserves other ViewerPreferences entries', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    // A pre-existing dict must be EXTENDED, not replaced — the setter creates
    // one only when there is none.
    const vp: PdfDict = new Map<string, PdfObject>([['FitWindow', true]]);
    doc.catalog().set('ViewerPreferences', vp);
    doc.DisplayDocTitle = true;
    const re = Document.Open(doc.Save());
    const back = re.resolve(re.catalog().get('ViewerPreferences')) as PdfDict;
    expect(back.get('FitWindow')).toBe(true);
    expect(back.get('DisplayDocTitle')).toBe(true);
  });
});
