import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { buildPages } from '../src/pagetree.js';

describe('buildPages', () => {
  it('returns pages in order with inherited MediaBox', () => {
    const doc = Document.Open(buildClassicPdf(3));
    const pages = buildPages(doc).pages;
    expect(pages.length).toBe(3);
    // MediaBox is defined on Pages node and must be inherited onto each page.
    expect(pages[0].MediaBox).toEqual([0, 0, 200, 200]); // inherited via /Parent
  });

  it('inherits MediaBox and Rotate from an ancestor /Pages node via the live tree', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const pages = buildPages(doc).pages;
    // buildClassicPdf puts /MediaBox on the root /Pages node, not on the page dicts.
    expect(pages[0].Dict.has('MediaBox')).toBe(false); // own dict has no MediaBox
    expect(pages[0].MediaBox).toEqual([0, 0, 200, 200]); // inherited through /Parent
  });
});
