import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  collectNameTree, removeNameTreeEntry, upsertNameTreeEntry,
} from '../src/nametree.js';
import { decodePdfText } from '../src/metadata.js';
import { isDict, isRef, isString, type PdfDict, type PdfObject } from '../src/types.js';

/** The entries of one branch, read back through the collector. */
const branchOf = (doc: Document, branch: string): Array<[string, PdfObject]> => {
  const names = doc.resolve(doc.catalog().get('Names'));
  if (!isDict(names)) return [];
  const out: Array<[string, PdfObject]> = [];
  collectNameTree(doc, names.get(branch) ?? null, out);
  return out;
};

/** The raw key order of a branch's /Names array — flatNameNode must sort. */
const keyOrder = (doc: Document, branch: string): string[] => {
  const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
  const node = doc.resolve(names.get(branch)) as PdfDict;
  const arr = doc.resolve(node.get('Names')) as PdfObject[];
  const keys: string[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const k = doc.resolve(arr[i]);
    if (isString(k)) keys.push(decodePdfText(k.bytes));
  }
  return keys;
};

describe('upsertNameTreeEntry', () => {
  it('creates /Names and the branch when neither exists', () => {
    const doc = Document.New();
    expect(doc.catalog().has('Names')).toBe(false);
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    expect(branchOf(doc, 'Dests')).toEqual([['a', 42]]);
  });

  it('stores the branch node as an indirect REF, not a direct dict', () => {
    // Pins the risk the spec names: all three existing call sites allocate the
    // node, and turning it direct would move every saved-bytes assertion in the
    // attachment suite while every behavioural test stayed green.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    expect(isRef(names.get('Dests'))).toBe(true);
  });

  it('keeps the other entries and sorts the /Names array by key', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'b', 2);
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    expect(keyOrder(doc, 'Dests')).toEqual(['a', 'b']);
  });

  it('replaces the value for an existing key rather than duplicating it', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'Dests', 'a', 2);
    expect(branchOf(doc, 'Dests')).toEqual([['a', 2]]);
  });
});

describe('removeNameTreeEntry', () => {
  it('returns the removed value, and undefined for an absent key', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    expect(removeNameTreeEntry(doc, 'Dests', 'nope')).toBeUndefined();
    expect(branchOf(doc, 'Dests')).toEqual([['a', 42]]); // untouched
    expect(removeNameTreeEntry(doc, 'Dests', 'a')).toBe(42);
  });

  it('returns undefined when there is no /Names at all', () => {
    expect(removeNameTreeEntry(Document.New(), 'Dests', 'a')).toBeUndefined();
  });

  it('prunes the branch but KEEPS /Names while another branch survives', () => {
    // The first half of the two-level rule. A single-branch fixture cannot tell
    // correct pruning from over-eager pruning — both delete /Names here — which
    // is why this case and the next are asserted as a pair.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'JavaScript', 'x', 2);
    removeNameTreeEntry(doc, 'Dests', 'a');
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    expect(names.has('Dests')).toBe(false);
    expect(names.has('JavaScript')).toBe(true);
  });

  it('prunes /Names itself once its last branch empties', () => {
    // The second half. One level of pruning leaves << /Names << >> >> in the
    // saved file: legal, harmless, and different from what the other branches
    // produce.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'JavaScript', 'x', 2);
    removeNameTreeEntry(doc, 'JavaScript', 'x');
    expect(doc.catalog().has('Names')).toBe(false);
  });

  it('leaves the surviving entries alone when the branch does not empty', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'Dests', 'b', 2);
    removeNameTreeEntry(doc, 'Dests', 'a');
    expect(branchOf(doc, 'Dests')).toEqual([['b', 2]]);
  });
});
