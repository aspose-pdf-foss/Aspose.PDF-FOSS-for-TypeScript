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

/** Four pages with attributes inherited from the root and two nested levels. */
export function inheritedAttributesDoc(): LiveDoc {
  const live = multiPageDoc(4);
  const { objects } = live;
  const [first, second, third, fourth] = [3, 6, 9, 12].map((n) => objects.get(n) as PdfDict);
  const root = objects.get(2) as PdfDict;
  root.set('Kids', [ref(17), ref(19)]);
  root.set('MediaBox', ref(20));
  root.set('CropBox', [4, 5, 196, 195]);
  root.set('Rotate', 90);
  root.set('Resources', ref(15));
  objects.set(15, third.get('Resources')!);
  objects.set(16, first.get('Resources')!);
  objects.set(17, dict([
    ['Type', name('Pages')], ['Parent', ref(2)], ['Count', 2], ['Kids', [ref(18), ref(6)]],
    ['Rotate', 180], ['Resources', ref(16)],
  ]));
  objects.set(18, dict([
    ['Type', name('Pages')], ['Parent', ref(17)], ['Count', 1], ['Kids', ref(21)],
    ['CropBox', [10, 20, 180, 190]],
  ]));
  objects.set(19, dict([
    ['Type', name('Pages')], ['Parent', ref(2)], ['Count', 2], ['Kids', [ref(9), ref(12)]],
  ]));
  objects.set(20, [0, 0, 220, 240]);
  objects.set(21, [ref(3)]);
  (objects.get(5) as PdfDict).set('BaseFont', name('Courier'));
  (objects.get(14) as PdfDict).set('BaseFont', name('Times-Roman'));
  for (const [page, parent] of [[first, 18], [second, 17], [third, 19]] as const) {
    page.set('Parent', ref(parent));
    page.delete('MediaBox');
    page.delete('Resources');
  }
  fourth.set('Parent', ref(19));
  fourth.set('CropBox', [5, 10, 190, 180]);
  fourth.set('Rotate', 0);
  return live;
}

/** A document with no pages (empty page tree) — linearization must reject it. */
export function noPageDoc(): LiveDoc {
  const objects = new Map<number, PdfObject>();
  objects.set(1, dict([['Type', name('Catalog')], ['Pages', ref(2)]]));
  objects.set(2, dict([['Type', name('Pages')], ['Count', 0], ['Kids', []]]));
  return { objects, trailer: dict([['Root', ref(1)]]) };
}
