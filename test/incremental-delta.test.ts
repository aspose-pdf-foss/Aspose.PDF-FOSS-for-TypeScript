import { describe, it, expect } from 'vitest';
import { diffObjects } from '../src/incrementaldelta.js';
import { name, PdfDict, PdfObject } from '../src/types.js';

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('diffObjects', () => {
  it('reports nothing for two identical maps', () => {
    const a = new Map<number, PdfObject>([[1, dict([['Type', name('Catalog')]])], [2, 42]]);
    const b = new Map<number, PdfObject>([[1, dict([['Type', name('Catalog')]])], [2, 42]]);
    const d = diffObjects(a, b);
    expect([...d.replaced]).toEqual([]);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });

  it('reports an object whose value changed as replaced', () => {
    const a = new Map<number, PdfObject>([[1, 42]]);
    const b = new Map<number, PdfObject>([[1, 43]]);
    expect([...diffObjects(a, b).replaced]).toEqual([1]);
  });

  it('reports an object number absent from the baseline as added', () => {
    const a = new Map<number, PdfObject>([[1, 42]]);
    const b = new Map<number, PdfObject>([[1, 42], [7, 9]]);
    const d = diffObjects(a, b);
    expect([...d.added]).toEqual([7]);
    expect([...d.replaced]).toEqual([]);
  });

  it('reports an object number absent from the live map as freed', () => {
    const a = new Map<number, PdfObject>([[1, 42], [7, 9]]);
    const b = new Map<number, PdfObject>([[1, 42]]);
    const d = diffObjects(a, b);
    expect([...d.freed]).toEqual([7]);
    expect([...d.replaced]).toEqual([]);
  });

  // The safe-direction invariant: a dict whose keys were deleted and re-added
  // serializes in a different order, so it is reported changed even though the
  // content is equal. Verbose, never silent -- this is the whole argument for
  // a save-time diff over a dirty set, and it is asserted so it stays a
  // decision rather than being "fixed" into a semantic comparison.
  it('conservatively reports a key-reordered dict as replaced', () => {
    const a = new Map<number, PdfObject>([[1, dict([['A', 1], ['B', 2]])]]);
    const b = new Map<number, PdfObject>([[1, dict([['B', 2], ['A', 1]])]]);
    expect([...diffObjects(a, b).replaced]).toEqual([1]);
  });

  // `null` is a valid PdfObject, so absence must be tested with `has` rather
  // than by comparing `get` against undefined -- otherwise an object whose
  // value is null reads as absent and is wrongly reported added or freed.
  it('distinguishes a stored null from an absent object number', () => {
    const a = new Map<number, PdfObject>([[1, null]]);
    const b = new Map<number, PdfObject>([[1, null]]);
    const d = diffObjects(a, b);
    expect([...d.replaced]).toEqual([]);
    expect([...d.added]).toEqual([]);
    expect([...d.freed]).toEqual([]);
  });
});
