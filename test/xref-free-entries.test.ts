import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { readXref } from '../src/xref.js';
import { appendIncrementalUpdate } from '../src/incremental.js';
import { name, PdfObject, PdfStream } from '../src/types.js';

const objs = (d: Document): Map<number, PdfObject> =>
  (d as unknown as { objects: Map<number, PdfObject> }).objects;

/** Free object `num` in an appended revision. */
const freeing = (base: Uint8Array, num: number): Uint8Array =>
  appendIncrementalUpdate(base, { objects: new Map(), freed: new Set([num]) });

describe('a free entry shadows the object it supersedes', () => {
  it('records the tombstone rather than dropping it', () => {
    const base = buildClassicPdf(2);
    const out = freeing(base, 5);
    expect(readXref(base).entries.get(5)?.type).toBe('offset');
    expect(readXref(out).entries.get(5)?.type).toBe('free');
  });

  it('keeps the freed object out of the live object map', () => {
    const base = buildClassicPdf(2);
    expect(objs(Document.Open(base)).has(5)).toBe(true);
    expect(objs(Document.Open(freeing(base, 5))).has(5)).toBe(false);
  });

  // The reverse direction, and it is the half a one-sided fix gets wrong: a
  // newer section that REUSES the number must beat the older tombstone, or
  // freeing an object once would make that number unusable forever.
  it('lets a later revision reuse a freed object number', () => {
    const base = buildClassicPdf(2);
    const freed = freeing(base, 5);
    const reused = appendIncrementalUpdate(freed, {
      objects: new Map<number, PdfObject>([[5, 42]]),
    });
    expect(readXref(reused).entries.get(5)?.type).toBe('offset');
    expect(objs(Document.Open(reused)).get(5)).toBe(42);
  });

  // Recording free entries makes object 0 visible for the first time: every
  // classic table opens with `0000000000 65535 f`, the head of the free list.
  // That is a real change to what readXref returns, so it is pinned rather
  // than tolerated — and object 0 must still produce no OBJECT, which is what
  // keeps `doc.objectEntries()` and the all-objects scans unchanged.
  it('reports object 0 as the free-list head, and builds no object for it', () => {
    const base = buildClassicPdf(2);
    const e = readXref(base).entries;
    expect([...e.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(e.get(0)).toEqual({ type: 'free', gen: 65535 });
    for (let n = 1; n <= 6; n++) expect(e.get(n)?.type).toBe('offset');

    const live = objs(Document.Open(base));
    expect(live.has(0)).toBe(false);
    expect([...live.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  // The cross-reference STREAM branch reads type-0 rows, and it is a SECOND
  // reader with its own field decoding — dropping it is invisible to every
  // classic-table fixture, since Save({ incremental: true }) refuses
  // `compressed` and so can never append a stream section. A compressed save
  // emits object 0 as type 0, which is what reaches it.
  it('records a free row in a cross-reference stream too', () => {
    const compressed = Document.Open(buildClassicPdf(2)).Save({ compressed: true });
    const e = readXref(compressed).entries;
    expect(e.get(0)).toEqual({ type: 'free', gen: 65535 });
    expect(objs(Document.Open(compressed)).has(0)).toBe(false);
  });

  // The committed golden qpdf approved: it says object 5 is gone, and until
  // this fix we said it was present. Two implementations now agree.
  it('agrees with qpdf about the committed freed-object golden', () => {
    const bytes = new Uint8Array(readFileSync('test/fixtures/qpdf/freed-object.pdf'));
    expect(objs(Document.Open(bytes)).has(5)).toBe(false);
    const report = readFileSync('test/fixtures/qpdf/freed-object.txt', 'utf8');
    expect(report.slice(report.indexOf('--show-xref'))).not.toContain('5/0:');
  });

  // The user-facing symptom. Validation scans ALL objects rather than the
  // reachable graph, so a resurrected object made a document fail for content
  // its author had correctly deleted.
  it('stops a freed prohibited stream from failing PDF/A validation', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const bad: PdfStream = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('LZWDecode')], ['Length', 0]]),
      raw: new Uint8Array(0),
    };
    const num = Math.max(...objs(doc).keys()) + 1;
    objs(doc).set(num, bad);
    const withBad = doc.Save({ incremental: true });
    const lzw = (d: Document): number =>
      d.ValidatePdfA('2b').Issues.filter((i) => /LZWDecode/.test(i.message)).length;
    expect(lzw(Document.Open(withBad))).toBe(1);

    const d2 = Document.Open(withBad);
    objs(d2).delete(num);
    const freed = d2.Save({ incremental: true });
    expect(lzw(Document.Open(freed))).toBe(0);
  });
});
