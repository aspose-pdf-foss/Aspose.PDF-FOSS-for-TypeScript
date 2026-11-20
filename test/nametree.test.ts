import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import {
  collectNameTree, lookupNameTree, removeNameTreeEntries, upsertNameTreeEntry,
} from '../src/nametree.js';
import { decodePdfText } from '../src/metadata.js';
import { isDict, isRef, isString, name, type PdfDict, type PdfObject, type PdfString } from '../src/types.js';
import { LoadLimits } from '../src/loadlimits.js';
import { registerStructIds } from '../src/structwrite.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';

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

/** Read key bytes independently of the library's decoded name views. */
function rawPairs(doc: Document, node: PdfObject | undefined): Array<[string, PdfObject]> {
  const dict = doc.resolve(node) as PdfDict;
  const names = doc.resolve(dict.get('Names')) as PdfObject[];
  const out: Array<[string, PdfObject]> = [];
  for (let i = 0; i < names.length; i += 2) {
    const key = doc.resolve(names[i]);
    if (!isString(key)) throw new Error('expected a name-tree string key');
    out.push([Buffer.from(key.bytes).toString('hex'), names[i + 1]]);
  }
  return out;
}

function openMixedTree(): Document {
  // <84A0> and <FEFF008400A0> decode to the same JS string, but are distinct
  // PDF keys. <84> is a prefix of <84A0>, and the BOM sorts after both.
  return Document.Open(buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Kids [4 0 R] >> >> /Outlines 5 0 R /StructTreeRoot 7 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>',
    '<< /Type /Page /Parent 2 0 R >>',
    '<< /Limits [<84> <FF>] /Names [<84> [3 0 R /Fit] <84A0> [3 0 R /FitH 50] <FEFF0030> [3 0 R /Fit] <FEFF008400A0> [3 0 R /FitH 80] <FF> [3 0 R /Fit]] >>',
    '<< /Type /Outlines /Count 1 /First 6 0 R /Last 6 0 R >>',
    '<< /Parent 5 0 R /Title (Old) /Dest <84A0> >>',
    '<< /Type /StructTreeRoot /IDTree << /Names [<84A0> 8 0 R] >> /K [8 0 R] >>',
    '<< /Type /StructElem /S /P /P 7 0 R /ID <84A0> >>',
  ]));
}

function destPairs(doc: Document): Array<[string, PdfObject]> {
  const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
  return rawPairs(doc, names.get('Dests'));
}

const pdfKey = (...bytes: number[]): PdfString => ({ kind: 'string', bytes: Uint8Array.of(...bytes) });

describe('lookupNameTree', () => {
  it('finds a UTF-16BE key inside a range that would exclude its decoded name', () => {
    const doc = openMixedTree();
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    const tree = names.get('Dests')!;
    expect(lookupNameTree(doc, tree, '0')).toEqual([doc.pageRef(1), name('Fit')]);
    expect(lookupNameTree(doc, tree, '\u0084\u00a0')).toEqual([doc.pageRef(1), name('FitH'), 50]);
  });

  it('keeps the string lookup compatible with an odd UTF-16BE tail and skips disjoint subtrees', () => {
    const doc = Document.Open(Document.New().Save(), { limits: LoadLimits.defaults.with({ maxNestingDepth: 2 }) });
    const low = pdfKey(0xfe, 0xff, 0, 0x41, 0x80);
    const high = pdfKey(0xfe, 0xff, 0, 0x41, 0xff);
    const outside = doc.allocObject(pdfKey(0x42));
    const deeper = new Map<string, PdfObject>([['Names', [pdfKey(0x42), 42]]]);
    const disjoint = new Map<string, PdfObject>([['Limits', [outside, outside]], ['Kids', [deeper]]]);
    const leaf = new Map<string, PdfObject>([['Limits', [low, high]], ['Names', [low, 1, high, 2]]]);
    const tree = new Map<string, PdfObject>([['Kids', [disjoint, leaf]]]);
    expect(lookupNameTree(doc, tree, 'A')).toBe(1);
    expect(lookupNameTree(doc, tree, Uint8Array.of(0xfe, 0xff, 0, 0x41, 0xff))).toBe(2);
    expect(lookupNameTree(doc, tree, 'absent')).toBeUndefined();
  });

  it.each([
    { bytes: [0xfe, 0xff, 0, 0x30], view: { type: 'Fit' } },
    { bytes: [0x84, 0xa0], view: { type: 'FitH', top: 50 } },
    { bytes: [0xfe, 0xff, 0, 0x84, 0, 0xa0], view: { type: 'FitH', top: 80 } },
  ])('resolves GoTo $bytes by its exact name-tree key', ({ bytes, view }) => {
    const doc = openMixedTree();
    doc.catalog().set('OpenAction', new Map<string, PdfObject>([['S', name('GoTo')], ['D', pdfKey(...bytes)]]));
    expect(doc.GetOpenAction()).toEqual({ kind: 'action', action: { type: 'goto', page: 1, view } });
  });

  it('prefers an exact tree key for a PDF string and retains legacy dictionary lookup', () => {
    const doc = openMixedTree();
    const legacy = [doc.pageRef(1), name('FitH'), 99];
    doc.catalog().set('Dests', new Map<string, PdfObject>([['0', legacy], ['legacy', legacy]]));
    const action = new Map<string, PdfObject>([['S', name('GoTo')]]);
    doc.catalog().set('OpenAction', action);
    const viewFor = (target: PdfObject) => {
      action.set('D', target);
      return doc.GetOpenAction();
    };
    const goto = (view: object) => ({ kind: 'action', action: { type: 'goto', page: 1, view } });
    expect(viewFor(pdfKey(0xfe, 0xff, 0, 0x30))).toEqual(goto({ type: 'Fit' }));
    expect(viewFor(name('0'))).toEqual(goto({ type: 'FitH', top: 99 }));
    expect(viewFor(pdfKey(...Buffer.from('legacy')))).toEqual(goto({ type: 'FitH', top: 99 }));
    expect(viewFor(pdfKey(0xfe, 0xff, 0, 0x84, 0, 0xa0, 0x01))).toBeUndefined();
  });
});

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

describe('removeNameTreeEntries', () => {
  it('returns the removed values and an empty list for an absent key', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 42);
    expect(removeNameTreeEntries(doc, 'Dests', 'nope')).toEqual([]);
    expect(branchOf(doc, 'Dests')).toEqual([['a', 42]]); // untouched
    expect(removeNameTreeEntries(doc, 'Dests', 'a')).toEqual([42]);
  });

  it('returns an empty list when there is no /Names at all', () => {
    expect(removeNameTreeEntries(Document.New(), 'Dests', 'a')).toEqual([]);
  });

  it('prunes the branch but KEEPS /Names while another branch survives', () => {
    // The first half of the two-level rule. A single-branch fixture cannot tell
    // correct pruning from over-eager pruning — both delete /Names here — which
    // is why this case and the next are asserted as a pair.
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'JavaScript', 'x', 2);
    removeNameTreeEntries(doc, 'Dests', 'a');
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
    removeNameTreeEntries(doc, 'JavaScript', 'x');
    expect(doc.catalog().has('Names')).toBe(false);
  });

  it('leaves the surviving entries alone when the branch does not empty', () => {
    const doc = Document.New();
    upsertNameTreeEntry(doc, 'Dests', 'a', 1);
    upsertNameTreeEntry(doc, 'Dests', 'b', 2);
    removeNameTreeEntries(doc, 'Dests', 'a');
    expect(branchOf(doc, 'Dests')).toEqual([['b', 2]]);
  });
});

describe('name-tree byte identity on edits', () => {
  it('preserves bookmark targets and other existing keys in PDF byte order after save and reopen', () => {
    const doc = openMixedTree();
    doc.SetNamedDestination('a', { page: 1 });
    doc.SetNamedDestination('Å', { page: 1 });
    const reopened = Document.Open(doc.Save());
    const outlines = reopened.resolve(reopened.catalog().get('Outlines')) as PdfDict;
    const bookmark = reopened.resolve(outlines.get('First')) as PdfDict;
    const target = reopened.resolve(bookmark.get('Dest'));
    expect(target).toEqual({ kind: 'string', bytes: Uint8Array.of(0x84, 0xa0) });
    const pairs = destPairs(reopened);
    expect(pairs.map(([key]) => key)).toEqual(['61', '84', '84a0', 'feff0030', 'feff008400a0', 'feff00c5', 'ff']);
    expect((pairs.find(([key]) => key === '84a0')?.[1] as PdfObject[])[2]).toBe(50);
    expect((pairs.find(([key]) => key === 'feff008400a0')?.[1] as PdfObject[])[2]).toBe(80);
  });

  it('updates existing byte spellings of the requested decoded name', () => {
    const doc = openMixedTree();
    doc.SetNamedDestination('\u0084\u00a0', { page: 1, view: { type: 'FitH', top: 100 } });
    const pairs = destPairs(doc);
    expect(pairs.map(([key]) => key)).toEqual(['84', '84a0', 'feff0030', 'feff008400a0', 'ff']);
    expect((pairs[1][1] as PdfObject[])[2]).toBe(100);
    expect((pairs[3][1] as PdfObject[])[2]).toBe(100);
  });

  it('keeps the old spelling and binds a newly authored bookmark after an upsert', () => {
    const doc = openMixedTree();
    doc.SetNamedDestination('\u0084', { page: 1, view: { type: 'FitH', top: 100 } });
    doc.SetOutlines([{ Title: 'New', Dest: { name: '\u0084' } }]);
    const reopened = Document.Open(doc.Save());
    const outlines = reopened.resolve(reopened.catalog().get('Outlines')) as PdfDict;
    const bookmark = reopened.resolve(outlines.get('First')) as PdfDict;
    const target = reopened.resolve(bookmark.get('Dest'));
    if (!isString(target)) throw new Error('expected a named bookmark target');
    const pairs = new Map(destPairs(reopened));
    expect(pairs.get(Buffer.from(target.bytes).toString('hex'))).toEqual(pairs.get('84'));
    expect((pairs.get('84') as PdfObject[])[2]).toBe(100);
  });

  it('removes only the requested decoded name and preserves surviving keys', () => {
    const doc = openMixedTree();
    doc.RemoveNamedDestination('\u0084\u00a0');
    expect(destPairs(doc).map(([key]) => key)).toEqual(['84', 'feff0030', 'ff']);
  });

  it('cleans up removed attachment spellings and keeps a filespec still named elsewhere', () => {
    const doc = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /AF [4 0 R 5 0 R 6 0 R] /Names << /EmbeddedFiles << /Names [<84A0> 4 0 R <FEFF008400A0> 5 0 R <FF> 4 0 R <FF01> 6 0 R] >> >> >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Filespec /F (first.bin) >>',
      '<< /Type /Filespec /F (second.bin) >>',
      '<< /Type /Filespec /F (keep.bin) >>',
    ]));
    expect(doc.RemoveAttachment('\u0084\u00a0')).toBe(true);
    const names = doc.resolve(doc.catalog().get('Names')) as PdfDict;
    const shared = { kind: 'ref', num: 4, gen: 0 };
    const keep = { kind: 'ref', num: 6, gen: 0 };
    expect(rawPairs(doc, names.get('EmbeddedFiles'))).toEqual([['ff', shared], ['ff01', keep]]);
    expect(doc.catalog().get('AF')).toEqual([shared, keep]);
  });

  it('uses an existing attachment spelling when selecting the initial portfolio file', () => {
    const doc = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [<E9> 4 0 R] >> >> >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>',
      '<< /Type /Page /Parent 2 0 R >>',
      '<< /Type /Filespec /F (legacy.bin) >>',
    ]));
    doc.SetCollection({ fields: [], initialFile: 'é' });
    const col = doc.resolve(doc.catalog().get('Collection')) as PdfDict;
    expect(col.get('D')).toEqual({ kind: 'string', bytes: Uint8Array.of(0xe9) });
  });

  it('keeps an existing ID-tree key and registers a new element under its own encoded ID', () => {
    const doc = openMixedTree();
    const root = doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict;
    const ref = doc.allocObject(new Map<string, PdfObject>([
      ['ID', { kind: 'string', bytes: Uint8Array.of(0xfe, 0xff, 0, 0x84, 0, 0xa0) }],
    ]));
    registerStructIds(doc, root, [['\u0084\u00a0', { kind: 'ref', num: 8, gen: 0 }], ['\u0084\u00a0', ref]]);
    expect(rawPairs(doc, root.get('IDTree'))).toEqual([
      ['84a0', { kind: 'ref', num: 8, gen: 0 }],
      ['feff008400a0', ref],
    ]);
  });
});
