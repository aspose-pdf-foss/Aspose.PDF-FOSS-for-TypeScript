import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { placeElements } from '../src/flowplace.js';

const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

const LOREM = 'The quick brown fox jumps over the lazy dog, and then it does so again '
  + 'because one sentence is not enough to force a wrap in a narrow column.';

describe('placeElements', () => {
  it('stacks elements from the top of the rect downward', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12 }),
      ...paragraph('two', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100]);
    expect(r.remainder).toEqual([]);
    expect(r.usedHeight).toBeCloseTo(24, 6);
    // Rect top = 300 + 100 = 400; baselines at 400-10 and 388-10.
    expect(cs(page)).toMatch(/50 390 Td/);
    expect(cs(page)).toMatch(/50 378 Td/);
  });

  it('inserts paragraphSpacing between elements but never above the first', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12 }),
      ...paragraph('two', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100], { paragraphSpacing: 6 });
    expect(r.usedHeight).toBeCloseTo(30, 6);
    expect(cs(page)).toMatch(/50 390 Td/);
    expect(cs(page)).toMatch(/50 372 Td/);
  });

  it("honours an element's own spaceBefore and spaceAfter", () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12, spaceAfter: 5 }),
      ...paragraph('two', { fontSize: 10, leading: 12, spaceBefore: 3 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100]);
    expect(r.usedHeight).toBeCloseTo(12 + 5 + 3 + 12, 6);
  });

  it('returns a split element as the head of the remainder', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph(LOREM, { fontSize: 10, leading: 12 }),
      ...paragraph('after', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 100, 24]);
    expect(r.usedHeight).toBeCloseTo(24, 6);
    expect(r.remainder).toHaveLength(2);
    // The head is the continuation, not the original.
    expect(r.remainder[0]).not.toBe(els[0]);
    expect(r.remainder[1]).toBe(els[1]);
  });

  it('returns an unplaceable element whole, without splitting it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('one', { fontSize: 10, leading: 12 }),
      ...paragraph('two', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 12]);
    expect(r.usedHeight).toBeCloseTo(12, 6);
    expect(r.remainder).toEqual([els[1]]);
  });

  it('a remainder can be fed straight back into another rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const first = placeElements(doc, page, [...paragraph(LOREM, { fontSize: 10, leading: 12 })],
      [50, 500, 100, 24]);
    expect(first.remainder).toHaveLength(1);
    const second = placeElements(doc, page, first.remainder, [200, 100, 300, 400]);
    expect(second.remainder).toEqual([]);
    expect(cs(page)).toMatch(/200 \d+(\.\d+)? Td/);
  });

  it('discards an element that draws nothing and is not retryable', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = [...paragraph('', { fontSize: 10, leading: 12 }),
      ...paragraph('visible', { fontSize: 10, leading: 12 })];
    const r = placeElements(doc, page, els, [50, 300, 200, 100]);
    expect(r.remainder).toEqual([]);
    expect(r.usedHeight).toBeCloseTo(12, 6);
  });

  it('validates its rect', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    expect(() => placeElements(doc, page, [], [0, 0, 0, 10])).toThrow(TypeError);
    expect(() => placeElements(doc, page, [], [0, 0, 10, -1])).toThrow(TypeError);
    expect(() => placeElements(doc, page, 'no' as never, [0, 0, 10, 10])).toThrow(TypeError);
  });
});
