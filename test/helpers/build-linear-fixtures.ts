import { PdfObject, PdfDict, PdfStream, name, ref } from '../../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A live in-memory document model (object map + trailer), ready for
 *  `planDocument`, `serializeDocument`, or `partitionForLinearization`. */
export interface LiveDoc {
  objects: Map<number, PdfObject>;
  trailer: PdfDict;
}

function dict(entries: [string, PdfObject][]): PdfDict {
  return new Map<string, PdfObject>(entries);
}

function contentStream(text: string): PdfStream {
  const raw = enc(text);
  return { kind: 'stream', dict: dict([['Length', raw.length]]), raw };
}

function helvetica(): PdfDict {
  return dict([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Helvetica')],
  ]);
}

/** Single page. Layout: 1=Catalog 2=Pages 3=Page 4=Contents. */
export function singlePageDoc(): LiveDoc {
  const objects = new Map<number, PdfObject>();
  objects.set(1, dict([['Type', name('Catalog')], ['Pages', ref(2)]]));
  objects.set(2, dict([['Type', name('Pages')], ['Count', 1], ['Kids', [ref(3)]]]));
  objects.set(3, dict([
    ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 200, 200]],
    ['Resources', dict([])], ['Contents', ref(4)],
  ]));
  objects.set(4, contentStream('BT /F1 24 Tf 20 100 Td (Page 1) Tj ET'));
  return { objects, trailer: dict([['Root', ref(1)]]) };
}

/** `pageCount` pages, each with its OWN Contents stream and OWN Font object
 *  (nothing shared between pages). Layout: 1=Catalog 2=Pages, then per page a
 *  Page dict, a Contents stream, and a Font. */
export function multiPageDoc(pageCount = 3): LiveDoc {
  const objects = new Map<number, PdfObject>();
  const pageNums: number[] = [];
  let next = 3;
  for (let i = 0; i < pageCount; i++) {
    const pageNum = next++, contentNum = next++, fontNum = next++;
    pageNums.push(pageNum);
    objects.set(pageNum, dict([
      ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 200, 200]],
      ['Resources', dict([['Font', dict([['F1', ref(fontNum)]])]])],
      ['Contents', ref(contentNum)],
    ]));
    objects.set(contentNum, contentStream(`BT /F1 24 Tf 20 100 Td (Page ${i + 1}) Tj ET`));
    objects.set(fontNum, helvetica());
  }
  objects.set(1, dict([['Type', name('Catalog')], ['Pages', ref(2)]]));
  objects.set(2, dict([
    ['Type', name('Pages')], ['Count', pageCount], ['Kids', pageNums.map((n) => ref(n))],
  ]));
  return { objects, trailer: dict([['Root', ref(1)]]) };
}

/** `pageCount` pages that all share ONE indirect Font object (a resource used by
 *  the first page and every later page — the shared-object hint case). Layout:
 *  1=Catalog 2=Pages 3=SharedFont, then per page a Page dict + Contents. */
export function sharedResourceDoc(pageCount = 3): LiveDoc {
  const objects = new Map<number, PdfObject>();
  const fontNum = 3;
  const pageNums: number[] = [];
  let next = 4;
  for (let i = 0; i < pageCount; i++) {
    const pageNum = next++, contentNum = next++;
    pageNums.push(pageNum);
    objects.set(pageNum, dict([
      ['Type', name('Page')], ['Parent', ref(2)], ['MediaBox', [0, 0, 200, 200]],
      ['Resources', dict([['Font', dict([['F1', ref(fontNum)]])]])],
      ['Contents', ref(contentNum)],
    ]));
    objects.set(contentNum, contentStream(`BT /F1 24 Tf 20 100 Td (Page ${i + 1}) Tj ET`));
  }
  objects.set(1, dict([['Type', name('Catalog')], ['Pages', ref(2)]]));
  objects.set(2, dict([
    ['Type', name('Pages')], ['Count', pageCount], ['Kids', pageNums.map((n) => ref(n))],
  ]));
  objects.set(fontNum, helvetica());
  return { objects, trailer: dict([['Root', ref(1)]]) };
}

/** A document with no pages (empty page tree) — linearization must reject it. */
export function noPageDoc(): LiveDoc {
  const objects = new Map<number, PdfObject>();
  objects.set(1, dict([['Type', name('Catalog')], ['Pages', ref(2)]]));
  objects.set(2, dict([['Type', name('Pages')], ['Count', 0], ['Kids', []]]));
  return { objects, trailer: dict([['Root', ref(1)]]) };
}
