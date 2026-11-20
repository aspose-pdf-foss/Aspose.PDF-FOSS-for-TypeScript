import { describe, expect, it } from 'vitest';
import { writeFdfAnnots, readFdfAnnots } from '../src/fdfannot.js';
import type { AnnotData } from '../src/annotdata.js';
import type { SkippedAnnot } from '../src/formdata.js';
import { PdfDict, PdfObject, isName, isRef, name } from '../src/types.js';

const encStr = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });

const square = (extra: [string, PdfObject][] = []): AnnotData => ({
  page: 1,
  dict: new Map<string, PdfObject>([
    ['Type', name('Annot')], ['Subtype', name('Square')],
    ['Rect', [0, 0, 10, 10]], ['NM', encStr('sq-1')], ...extra,
  ]),
});

/** A resolver over the emitted object map, as the FDF reader will have. */
const resolverFor = (objects: Map<number, PdfObject>) =>
  (o: PdfObject): PdfObject => (isRef(o) ? objects.get((o as { num: number }).num) ?? null : o);

const subtypeOf = (a: AnnotData): string => {
  const s = a.dict.get('Subtype');
  return isName(s) ? s.name : '';
};

describe('writeFdfAnnots', () => {
  it('emits one indirect object per annotation, numbered from firstObj', () => {
    const { array, objects } = writeFdfAnnots([square(), square()], 5);
    expect(array.length).toBe(2);
    expect(array.every(isRef)).toBe(true);
    expect([...objects.keys()].sort((a, b) => a - b)).toEqual([5, 6]);
  });

  it('records the page index as /Page, XFDF-style 0-based', () => {
    const { objects } = writeFdfAnnots([square()], 1);
    expect((objects.get(1) as PdfDict).get('Page')).toBe(1);
  });

  it('allocates an inline appearance stream as its own object', () => {
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Subtype', name('Form')]]),
      raw: new TextEncoder().encode('q Q'),
    };
    const a = square([['AP', new Map<string, PdfObject>([['N', stream]])]]);
    const { objects } = writeFdfAnnots([a], 1);
    const ap = (objects.get(1) as PdfDict).get('AP') as PdfDict;
    expect(isRef(ap.get('N'))).toBe(true);
    expect(objects.size).toBe(2);
  });

  it('writes a popup reference to the object on the same page', () => {
    const note: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Text')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('n1')],
      ]),
      popupName: 'p1',
    };
    const popup: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Popup')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('p1')],
      ]),
    };
    const { objects } = writeFdfAnnots([note, popup, { ...popup, page: 1 }], 1);
    const noteDict = objects.get(1) as PdfDict;
    expect(isRef(noteDict.get('Popup'))).toBe(true);
    expect((noteDict.get('Popup') as { num: number }).num).toBe(2);
  });

  it('writes the reply parent name even when the parent is absent from the export', () => {
    const orphan: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([['Subtype', name('Text')], ['Rect', [0, 0, 1, 1]]]),
      inReplyTo: 'parent',
    };
    const { objects } = writeFdfAnnots([orphan], 1);
    expect((objects.get(1) as PdfDict).get('IRT')).toEqual(encStr('parent'));
  });
});

describe('readFdfAnnots', () => {
  it('reads dicts back, inlining refs and lifting /Page', () => {
    const { array, objects } = writeFdfAnnots([square()], 1);
    const skipped: SkippedAnnot[] = [];
    const back = readFdfAnnots(array, resolverFor(objects), skipped);
    expect(back.length).toBe(1);
    expect(back[0].page).toBe(1);
    expect(back[0].dict.has('Page')).toBe(false);
    expect(back[0].dict.get('Rect')).toEqual([0, 0, 10, 10]);
    expect(skipped).toEqual([]);
  });

  it('lifts a popup ref back into a name link', () => {
    const note: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Text')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('n1')],
      ]),
      popupName: 'p1',
    };
    const popup: AnnotData = {
      page: 0,
      dict: new Map<string, PdfObject>([
        ['Subtype', name('Popup')], ['Rect', [0, 0, 1, 1]], ['NM', encStr('p1')],
      ]),
    };
    const { array, objects } = writeFdfAnnots([note, popup], 1);
    const back = readFdfAnnots(array, resolverFor(objects), []);
    const n = back.find((a) => subtypeOf(a) === 'Text')!;
    expect(n.popupName).toBe('p1');
    expect(n.dict.has('Popup')).toBe(false);
  });

  it('reads legacy /IRT refs only when the referenced parent is on the same page', () => {
    const reply = square([['IRT', { kind: 'ref', num: 3, gen: 0 }]]);
    const parent = square([['NM', encStr('parent')]]);
    const { array, objects } = writeFdfAnnots([reply, { ...reply, page: 0 }, parent], 1);
    const samePage = readFdfAnnots(array, resolverFor(objects), []);
    expect(samePage[0].inReplyTo).toBe('parent');
    expect(samePage[0].dict.has('IRT')).toBe(false);
    expect(samePage[1].inReplyTo).toBeUndefined();
  });

  it('round-trips an appearance stream byte-for-byte', () => {
    const raw = new TextEncoder().encode('q 1 0 0 rg 0 0 5 5 re f Q');
    const stream: PdfObject = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Subtype', name('Form')]]),
      raw,
    };
    const a = square([['AP', new Map<string, PdfObject>([['N', stream]])]]);
    const { array, objects } = writeFdfAnnots([a], 1);
    const back = readFdfAnnots(array, resolverFor(objects), []);
    const ap = back[0].dict.get('AP') as PdfDict;
    expect((ap.get('N') as { raw: Uint8Array }).raw).toEqual(raw);
  });

  it('skips an entry with no usable page index', () => {
    const arr: PdfObject[] = [new Map<string, PdfObject>([
      ['Subtype', name('Square')], ['Rect', [0, 0, 1, 1]],
    ])];
    const skipped: SkippedAnnot[] = [];
    expect(readFdfAnnots(arr, (o) => o, skipped)).toEqual([]);
    expect(skipped[0].reason).toBe('missing page index');
  });

  it('returns nothing for a non-array /Annots', () => {
    const skipped: SkippedAnnot[] = [];
    expect(readFdfAnnots(null, (o) => o, skipped)).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it('does not carry the structure back-references', () => {
    const a = square([['P', name('bogus')], ['StructParent', 3]]);
    const { array, objects } = writeFdfAnnots([a], 1);
    const back = readFdfAnnots(array, resolverFor(objects), []);
    expect(back[0].dict.has('P')).toBe(false);
    expect(back[0].dict.has('StructParent')).toBe(false);
  });
});
