import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { lookupNumberTree, numsArrays } from '../src/numbertree.js';
import type { PdfDict, PdfObject } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

/** A Document is needed only for `resolve`; this one is never saved. */
const doc = (): Document => Document.Open(buildStampTarget());

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('numbertree: lookupNumberTree', () => {
  it('finds a key in a flat /Nums', () => {
    const t = dict([['Nums', [0, 101, 1, 102]]]);
    expect(lookupNumberTree(doc(), t, 1)).toBe(102);
  });

  it('returns undefined for a key that is not there', () => {
    expect(lookupNumberTree(doc(), dict([['Nums', [0, 101]]]), 7)).toBeUndefined();
  });

  it('descends into /Kids by /Limits', () => {
    const kid = dict([['Limits', [10, 20]], ['Nums', [15, 103]]]);
    const root = dict([['Kids', [kid]]]);
    expect(lookupNumberTree(doc(), root, 15)).toBe(103);
    expect(lookupNumberTree(doc(), root, 5)).toBeUndefined();
  });

  // A number tree that points at itself is a file we did not write; it must
  // terminate rather than hang.
  it('stops on a cycle', () => {
    const root: PdfDict = new Map();
    root.set('Kids', [root]);
    root.set('Limits', [0, 100]);
    expect(lookupNumberTree(doc(), root, 1)).toBeUndefined();
  });
});

describe('numbertree: numsArrays', () => {
  it('returns the flat /Nums array itself, live', () => {
    const nums: PdfObject[] = [0, 101];
    const t = dict([['Nums', nums]]);
    const got = numsArrays(doc(), t);
    expect(got).toHaveLength(1);
    // LIVE: mutating what we got must mutate the tree.
    got[0].push(1, 102);
    expect(nums).toEqual([0, 101, 1, 102]);
  });

  it('collects every leaf of a /Kids tree, in document order', () => {
    const k1 = dict([['Limits', [0, 9]], ['Nums', [0, 101]]]);
    const k2 = dict([['Limits', [10, 19]], ['Nums', [10, 102]]]);
    const root = dict([['Kids', [k1, k2]]]);
    expect(numsArrays(doc(), root).map((a) => a[1])).toEqual([101, 102]);
  });

  it('collects a node that has BOTH /Nums and /Kids', () => {
    const kid = dict([['Nums', [10, 102]]]);
    const root = dict([['Nums', [0, 101]], ['Kids', [kid]]]);
    expect(numsArrays(doc(), root).map((a) => a[1])).toEqual([101, 102]);
  });

  it('returns nothing for a tree with no /Nums anywhere', () => {
    expect(numsArrays(doc(), dict([['Kids', []]]))).toEqual([]);
  });

  it('stops on a cycle', () => {
    const root: PdfDict = new Map();
    root.set('Nums', [0, 101]);
    root.set('Kids', [root]);
    expect(numsArrays(doc(), root)).toHaveLength(1);
  });
});
