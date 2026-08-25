import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  expandObjectStreams, chooseCatalog, chooseInfo, findEncryptDict,
} from '../src/rebuild.js';
import { XrefEntry } from '../src/xref.js';
import { PdfObject, PdfStream, PdfDict } from '../src/types.js';

/** A real /ObjStm stream holding `<< /A 1 >>` as object 7 and `42` as object 8. */
function objStm(): PdfStream {
  const payload = '<< /A 1 >> 42';
  const header = '7 0 8 10 '; // objNum offset pairs; offsets are into the payload
  const data = Buffer.from(header + payload, 'latin1');
  const raw = new Uint8Array(deflateSync(data));
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', { kind: 'name', name: 'ObjStm' }],
    ['N', 2],
    ['First', header.length],
    ['Filter', { kind: 'name', name: 'FlateDecode' }],
    ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}

describe('expandObjectStreams', () => {
  it('registers every object an /ObjStm declares as a compressed entry', () => {
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
    ]);
    const { added } = expandObjectStreams(entries, () => objStm());

    expect(added.sort()).toEqual([7, 8]);
    expect(entries.get(7)).toEqual({ type: 'compressed', streamObj: 3, index: 0 });
    expect(entries.get(8)).toEqual({ type: 'compressed', streamObj: 3, index: 1 });
  });

  it('leaves a swept offset entry alone — it was found literally in the file', () => {
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
      [7, { type: 'offset', offset: 900, gen: 0 }],
    ]);
    const { added } = expandObjectStreams(entries, () => objStm());

    expect(added).toEqual([8]);
    expect(entries.get(7)).toEqual({ type: 'offset', offset: 900, gen: 0 });
  });

  it('skips a container that will not load at all rather than throwing', () => {
    // A container that yields *something* is degraded per object (below); this
    // one cannot even be loaded, so there is nothing to register.
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
    ]);
    const { added } = expandObjectStreams(entries, () => { throw new Error('boom'); });

    expect(added).toEqual([]);
    expect(entries.size).toBe(1);
  });

  it('ignores an object that is not an /ObjStm', () => {
    const entries = new Map<number, XrefEntry>([
      [3, { type: 'offset', offset: 100, gen: 0 }],
    ]);
    const { added } = expandObjectStreams(entries, () => new Map<string, PdfObject>([['Type', { kind: 'name', name: 'Catalog' }]]));

    expect(added).toEqual([]);
  });

  it('registers what a damaged container still yielded, and reports the loss', () => {
    // Three objects; the payload keeps only the first 60%, so the header (which
    // sits at the front) survives and names all three while the later bodies do
    // not. Dropping the container whole would cost the object that is intact.
    const bodies = [
      { num: 5, body: '<< /Type /Catalog /Pages 6 0 R >>' },
      { num: 6, body: '<< /Type /Pages /Count 1 /Kids [7 0 R] >>' },
      { num: 7, body: '<< /Type /Page /Parent 6 0 R >>' },
    ];
    let header = ''; let payload = '';
    for (const { num, body } of bodies) {
      header += `${num} ${payload.length} `;
      payload += `${body} `;
    }
    const full = new Uint8Array(deflateSync(Buffer.from(header + payload, 'latin1')));
    const raw = full.subarray(0, Math.floor(full.length * 0.6));
    const container: PdfStream = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', { kind: 'name', name: 'ObjStm' }],
        ['N', 3], ['First', header.length],
        ['Filter', { kind: 'name', name: 'FlateDecode' }],
        ['Length', raw.length],
      ]),
      raw,
    };

    const entries = new Map<number, XrefEntry>([
      [4, { type: 'offset', offset: 0, gen: 0 }],
    ]);
    const { added, damaged } = expandObjectStreams(entries, () => container);

    expect(added.length).toBeGreaterThan(0);
    expect(entries.get(added[0])).toMatchObject({ type: 'compressed', streamObj: 4 });
    expect(damaged.length).toBe(1);
    expect(damaged[0].container).toBe(4);
    expect(damaged[0].lost.length).toBeGreaterThan(0);
  });
});

const nm = (s: string): PdfObject => ({ kind: 'name', name: s });
const rf = (n: number): PdfObject => ({ kind: 'ref', num: n, gen: 0 });

/** A catalog at `num` pointing at `pagesNum`, plus optionally a valid page tree. */
function catalogModel(specs: Array<{ num: number; pages: number; validTree: boolean; offset: number }>) {
  const objects = new Map<number, PdfObject>();
  const entries = new Map<number, XrefEntry>();
  for (const s of specs) {
    objects.set(s.num, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(s.pages)]]));
    entries.set(s.num, { type: 'offset', offset: s.offset, gen: 0 });
    if (s.validTree) {
      objects.set(s.pages, new Map<string, PdfObject>([['Type', nm('Pages')], ['Count', 0], ['Kids', []]]));
      entries.set(s.pages, { type: 'offset', offset: s.offset + 1, gen: 0 });
    }
  }
  return { objects, entries };
}

describe('chooseCatalog', () => {
  it('returns undefined when there is no catalog', () => {
    expect(chooseCatalog(new Map(), new Map())).toBeUndefined();
  });

  it('picks the highest-offset catalog when several are walkable', () => {
    const { objects, entries } = catalogModel([
      { num: 1, pages: 2, validTree: true, offset: 100 },
      { num: 9, pages: 10, validTree: true, offset: 5000 },
    ]);
    expect(chooseCatalog(objects, entries)).toEqual({ root: 9, candidates: [1, 9] });
  });

  it('prefers a walkable catalog over a later broken one', () => {
    // The tail-truncation case: the newest catalog is precisely the broken one.
    const { objects, entries } = catalogModel([
      { num: 1, pages: 2, validTree: true, offset: 100 },
      { num: 9, pages: 10, validTree: false, offset: 5000 },
    ]);
    expect(chooseCatalog(objects, entries)!.root).toBe(1);
  });

  it('falls back to highest offset when no catalog is walkable', () => {
    // Partial salvage beats throwing: the damage rides in doc.recovery.
    const { objects, entries } = catalogModel([
      { num: 1, pages: 2, validTree: false, offset: 100 },
      { num: 9, pages: 10, validTree: false, offset: 5000 },
    ]);
    expect(chooseCatalog(objects, entries)!.root).toBe(9);
  });

  it('ranks a compressed catalog by its container offset', () => {
    const objects = new Map<number, PdfObject>([
      [1, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(2)]])],
      [2, new Map<string, PdfObject>([['Type', nm('Pages')], ['Count', 0], ['Kids', []]])],
      [9, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(2)]])],
    ]);
    const entries = new Map<number, XrefEntry>([
      [1, { type: 'offset', offset: 100, gen: 0 }],
      [2, { type: 'offset', offset: 200, gen: 0 }],
      [5, { type: 'offset', offset: 9000, gen: 0 }],          // the container
      [9, { type: 'compressed', streamObj: 5, index: 0 }],    // catalog inside it
    ]);
    expect(chooseCatalog(objects, entries)!.root).toBe(9);
  });
});

describe('chooseInfo', () => {
  /** Catalog 1 -> Outlines 3 -> item 4, which has /Title and no /Type. */
  function modelWithOutline(extra: Array<[number, PdfObject]> = []) {
    const objects = new Map<number, PdfObject>([
      [1, new Map<string, PdfObject>([['Type', nm('Catalog')], ['Pages', rf(2)], ['Outlines', rf(3)]])],
      [2, new Map<string, PdfObject>([['Type', nm('Pages')], ['Count', 0], ['Kids', []]])],
      [3, new Map<string, PdfObject>([['Type', nm('Outlines')], ['First', rf(4)]])],
      [4, new Map<string, PdfObject>([['Title', { kind: 'string', bytes: new Uint8Array([65]) }], ['Parent', rf(3)]])],
      ...extra,
    ]);
    const entries = new Map<number, XrefEntry>();
    for (const n of objects.keys()) entries.set(n, { type: 'offset', offset: n * 100, gen: 0 });
    return { objects, entries };
  }

  it('does not mistake an outline item for /Info', () => {
    // Object 4 has /Title and no /Type - a key-set test alone matches it. It is
    // reachable from /Root, which is what rules it out.
    const { objects, entries } = modelWithOutline();
    expect(chooseInfo(objects, entries, 1)).toBeUndefined();
  });

  it('finds an unreachable dict carrying /Info keys', () => {
    const info: PdfObject = new Map<string, PdfObject>([
      ['Producer', { kind: 'string', bytes: new Uint8Array([80]) }],
      ['Title', { kind: 'string', bytes: new Uint8Array([84]) }],
    ]);
    const { objects, entries } = modelWithOutline([[9, info]]);
    expect(chooseInfo(objects, entries, 1)).toBe(9);
  });

  it('prefers the candidate carrying more /Info keys', () => {
    const thin: PdfObject = new Map<string, PdfObject>([['Title', { kind: 'string', bytes: new Uint8Array([84]) }]]);
    const rich: PdfObject = new Map<string, PdfObject>([
      ['Producer', { kind: 'string', bytes: new Uint8Array([80]) }],
      ['Creator', { kind: 'string', bytes: new Uint8Array([67]) }],
      ['CreationDate', { kind: 'string', bytes: new Uint8Array([68]) }],
    ]);
    // `thin` is inserted first *and* sits at the higher offset, so both "keep
    // the first match" and "plain last-wins" pick it. Only the score does not.
    const { objects, entries } = modelWithOutline([[9, thin], [8, rich]]);
    expect(chooseInfo(objects, entries, 1)).toBe(8);
  });

  it('rejects a dict that declares a /Type', () => {
    const typed: PdfObject = new Map<string, PdfObject>([
      ['Type', nm('Annot')],
      ['Title', { kind: 'string', bytes: new Uint8Array([84]) }],
    ]);
    const { objects, entries } = modelWithOutline([[9, typed]]);
    expect(chooseInfo(objects, entries, 1)).toBeUndefined();
  });
});

describe('findEncryptDict', () => {
  const standard = (r: number): PdfObject => new Map<string, PdfObject>([
    ['Filter', nm('Standard')], ['V', 5], ['R', r],
    ['O', { kind: 'string', bytes: new Uint8Array(48) }],
    ['U', { kind: 'string', bytes: new Uint8Array(48) }],
    ['P', -4],
  ]);

  it('finds a standard-handler dict by shape', () => {
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => standard(6))!.num).toBe(7);
  });

  it('finds an Adobe.PubSec dict', () => {
    const pubsec: PdfObject = new Map<string, PdfObject>([
      ['Filter', nm('Adobe.PubSec')], ['Recipients', []],
    ]);
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => pubsec)!.num).toBe(7);
  });

  it('ignores a dict that declares a /Type', () => {
    const decoy: PdfObject = new Map<string, PdfObject>([['Type', nm('Filespec')], ['Filter', nm('Standard')]]);
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => decoy)).toBeUndefined();
  });

  it('survives an object that will not parse', () => {
    const entries = new Map<number, XrefEntry>([[7, { type: 'offset', offset: 10, gen: 0 }]]);
    expect(findEncryptDict(entries, () => { throw new Error('boom'); })).toBeUndefined();
  });
});
