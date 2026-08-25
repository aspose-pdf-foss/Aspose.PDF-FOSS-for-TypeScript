import { describe, it, expect } from 'vitest';
import { planDocument } from '../src/serializer.js';
import { partitionForLinearization } from '../src/linearize.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import {
  singlePageDoc, multiPageDoc, sharedResourceDoc, noPageDoc,
} from './helpers/build-linear-fixtures.js';

const partition = (live: { objects: any; trailer: any }) =>
  partitionForLinearization(planDocument(live.objects, live.trailer));

describe('partitionForLinearization — single page', () => {
  it('puts every object in the first-page set with an empty remainder', () => {
    const p = partition(singlePageDoc());
    expect(p.pageCount).toBe(1);
    // catalog(1), pages(2), page(3), contents(4) — all reachable, all first-page.
    expect([...p.firstPage].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(p.remainder).toEqual([]);
    expect(p.shared).toEqual([]);
  });

  it('reports the first page object number', () => {
    const p = partition(singlePageDoc());
    expect(p.firstPageObjNum).toBe(3); // the /Type /Page object
  });
});

describe('partitionForLinearization — multi page, nothing shared', () => {
  it('keeps only page 1 and its closure in the first-page set', () => {
    const p = partition(multiPageDoc(3));
    expect(p.pageCount).toBe(3);
    // First-page set: catalog, pages root, page 1, page 1 contents, page 1 font.
    expect(p.firstPage.length).toBe(5);
    // Page 1 is the first /Kids entry; in plan order it renumbers to 3.
    expect(p.firstPageObjNum).toBe(3);
    expect(p.firstPage).toContain(p.firstPageObjNum);
    // Remainder holds pages 2 & 3, each with its own contents + font: 3 each.
    expect(p.remainder.length).toBe(6);
    // No object straddles both sides.
    for (const n of p.remainder) expect(p.firstPage).not.toContain(n);
  });

  it('finds no shared objects when each page has its own resources', () => {
    const p = partition(multiPageDoc(3));
    expect(p.shared).toEqual([]);
  });
});

describe('partitionForLinearization — shared resource', () => {
  it('flags the font used by page 1 and later pages as shared', () => {
    const live = sharedResourceDoc(3);
    const plan = planDocument(live.objects, live.trailer);
    const p = partitionForLinearization(plan);
    // The shared font (old object 3) is in page 1's resource closure.
    const sharedFontNew = plan.oldToNew.get(3)!;
    expect(p.shared).toEqual([sharedFontNew]);
    // It lives in the first-page set and is referenced from the remainder.
    expect(p.firstPage).toContain(sharedFontNew);
  });
});

describe('partitionForLinearization — guards', () => {
  it('throws when the document has no pages', () => {
    const live = noPageDoc();
    expect(() => partitionForLinearization(planDocument(live.objects, live.trailer)))
      .toThrow(UnsupportedFeatureError);
  });
});
