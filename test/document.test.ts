import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { isDict, isName } from '../src/types.js';

describe('Document', () => {
  it('resolves catalog from classic pdf', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const cat = doc.catalog();
    expect(isDict(cat)).toBe(true);
    const type = cat.get('Type');
    expect(isName(type!) && type.name).toBe('Catalog');
  });
  it('resolves objects from xref-stream pdf', () => {
    const doc = Document.Open(buildXrefStreamPdf());
    const cat = doc.catalog();
    const pages = doc.resolve(cat.get('Pages')!);
    expect(isDict(pages)).toBe(true);
  });
  it('throws on encrypted pdf', () => {
    const pdf = buildClassicPdf(1);
    // Inject an /Encrypt into the trailer by string surgery for the test.
    // Use latin1-preserving byte conversion (TextEncoder would emit UTF-8 and
    // corrupt the binary header, shifting every xref offset).
    const s = new TextDecoder('latin1').decode(pdf).replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 99 0 R');
    const bytes = Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);
    expect(() => Document.Open(bytes)).toThrow(/encrypt/i);
  });
});

describe('Document.Open eager parse', () => {
  it('materializes every object up front (xref-stream input resolves without lazy parse)', () => {
    const doc = Document.Open(buildXrefStreamPdf());
    const cat = doc.catalog();
    const pages = doc.resolve(cat.get('Pages')!);
    expect(isDict(pages)).toBe(true);
    // Page 3 is reachable through the eagerly-parsed map.
    const kids = (pages as Map<string, any>).get('Kids');
    const page = doc.resolve(kids[0]);
    expect(isDict(page)).toBe(true);
  });
});

describe('Document.Pages', () => {
  it('is populated by open() with one Page per page, numbered from 1', () => {
    const doc = Document.Open(buildClassicPdf(3));
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2, 3]);
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 200, 200]);
  });

  it('is empty for a zero-page document', () => {
    expect(Document.Open(buildClassicPdf(0)).Pages.length).toBe(0);
  });
});

describe('Document.OpenFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdfopenfile-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a PDF from a file path', () => {
    const path = join(dir, 'in.pdf');
    writeFileSync(path, buildClassicPdf(2));
    const doc = Document.OpenFile(path);
    expect(doc.Pages.length).toBe(2);
    expect(isDict(doc.catalog())).toBe(true);
  });

  it('throws when the file does not exist', () => {
    expect(() => Document.OpenFile(join(dir, 'nope.pdf'))).toThrow();
  });
});

describe('Document.Reorder (in-memory)', () => {
  // Decoded content text of a page, e.g. "...(Page 3) Tj..." for assertions.
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('rearranges pages and renumbers them', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1, 2]);
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2, 3]);
    expect(text(doc, 0)).toContain('Page 3');
    expect(text(doc, 1)).toContain('Page 1');
    expect(text(doc, 2)).toContain('Page 2');
  });

  it('drops pages omitted from order (no append)', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1]);
    expect(doc.Pages.length).toBe(2);
    expect(text(doc, 0)).toContain('Page 3');
    expect(text(doc, 1)).toContain('Page 1');
  });

  it('duplicates repeated pages', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([1, 1, 2]);
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2, 3]);
    expect(text(doc, 0)).toContain('Page 1');
    expect(text(doc, 1)).toContain('Page 1');
    expect(text(doc, 2)).toContain('Page 2');
  });

  it('mutates the live /Pages node so Kids reflects the new order immediately', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1]);
    const pagesNode = doc.resolve(doc.catalog().get('Pages')!) as Map<string, any>;
    expect(pagesNode.get('Count')).toBe(2);          // live count updated
    expect((pagesNode.get('Kids') as any[]).length).toBe(2); // live kids updated
  });

  it('clones a repeated page into a distinct live object', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([1, 1]);
    const pagesNode = doc.resolve(doc.catalog().get('Pages')!) as Map<string, any>;
    const kids = pagesNode.get('Kids') as any[];
    expect(kids[0].num).not.toBe(kids[1].num);       // duplicate is a second object
  });

  it('throws RangeError on invalid order and leaves Pages unchanged', () => {
    const doc = Document.Open(buildClassicPdf(3));
    expect(() => doc.Reorder([])).toThrow(RangeError);
    expect(() => doc.Reorder([1, 1.5])).toThrow(RangeError);
    expect(() => doc.Reorder([0, 1, 2])).toThrow(RangeError);
    expect(() => doc.Reorder([1, 2, 4])).toThrow(RangeError);
    expect(doc.Pages.length).toBe(3); // untouched after the throws
  });
});

describe('Document.Reorder (persisted on save)', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('round-trips a reorder through save/Open', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1, 2]);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(3);
    expect(text(re, 0)).toContain('Page 3');
    expect(text(re, 1)).toContain('Page 1');
    expect(text(re, 2)).toContain('Page 2');
  });

  it('round-trips a drop', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([3, 1]);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(2);
    expect(text(re, 0)).toContain('Page 3');
    expect(text(re, 1)).toContain('Page 1');
  });

  it('round-trips a duplicate (page cloned into its own object)', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([1, 1, 2]);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(3);
    expect(text(re, 0)).toContain('Page 1');
    expect(text(re, 1)).toContain('Page 1');
    expect(text(re, 2)).toContain('Page 2');
  });

  it('persists a metadata edit and a reorder in one save', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.SetMetadata({ title: 'Reordered' });
    doc.Reorder([2, 1]);
    const re = Document.Open(doc.Save());
    expect(re.GetMetadata().title).toBe('Reordered');
    expect(re.Pages.length).toBe(2);
    expect(text(re, 0)).toContain('Page 2');
    expect(text(re, 1)).toContain('Page 1');
  });
});

describe('Document.AddPage / InsertPage (blank)', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('AddPage appends a blank A4 page and returns its number', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const { page, number } = doc.AddPage();
    expect(number).toBe(3);
    expect(doc.Pages.length).toBe(3);
    expect(page.Number).toBe(3);
    expect(page.MediaBox).toEqual([0, 0, 595, 842]);
    expect(page.Contents.length).toBe(0); // blank: no /Contents
  });

  it('AddPage(PageFormat) sizes the blank page to that format', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const { page } = doc.AddPage(PageFormat.Letter);
    expect(page.MediaBox).toEqual([0, 0, 612, 792]);
    const land = doc.AddPage(PageFormat.A4.landscape());
    expect(land.page.MediaBox).toEqual([0, 0, 842, 595]);
    const custom = doc.AddPage(PageFormat.custom(300, 400));
    expect(custom.page.MediaBox).toEqual([0, 0, 300, 400]);
  });

  it('InsertPage(at, PageFormat) sizes the inserted blank page', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const { page } = doc.InsertPage(1, PageFormat.Legal);
    expect(page.MediaBox).toEqual([0, 0, 612, 1008]);
    expect(doc.Pages.length).toBe(3);
  });

  it('InsertPage at 1 shifts existing pages down', () => {
    const doc = Document.Open(buildClassicPdf(3));
    const { number } = doc.InsertPage(1);
    expect(number).toBe(1);
    expect(doc.Pages.length).toBe(4);
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 595, 842]); // the new blank page
    expect(text(doc, 1)).toContain('Page 1'); // old page 1 is now page 2
    expect(text(doc, 3)).toContain('Page 3'); // old page 3 is now page 4
  });

  it('InsertPage in the middle places the new page at that slot', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.InsertPage(2);
    expect(doc.Pages.length).toBe(4);
    expect(text(doc, 0)).toContain('Page 1');
    expect(doc.Pages[1].Contents.length).toBe(0); // inserted blank at slot 2
    expect(text(doc, 2)).toContain('Page 2'); // old page 2 shifted to 3
  });

  it('InsertPage at length+1 appends (same as AddPage)', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const { number } = doc.InsertPage(3);
    expect(number).toBe(3);
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages[2].Contents.length).toBe(0);
  });

  it('InsertPage throws RangeError out of range and leaves Pages unchanged', () => {
    const doc = Document.Open(buildClassicPdf(2));
    expect(() => doc.InsertPage(0)).toThrow(RangeError);
    expect(() => doc.InsertPage(4)).toThrow(RangeError);   // length+2
    expect(() => doc.InsertPage(1.5)).toThrow(RangeError);
    expect(doc.Pages.length).toBe(2);
  });

  it('round-trips an added blank A4 page through Save/Open', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.AddPage();
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(2);
    expect(re.Pages[1].MediaBox).toEqual([0, 0, 595, 842]);
  });
});

describe('Document.AddPage / InsertPage (copy)', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('copies a page from another document without mutating the source', () => {
    const src = Document.Open(buildClassicPdf(3)); // pages: "Page 1".."Page 3"
    const dst = Document.Open(buildClassicPdf(2)); // pages: "Page 1","Page 2"
    const { number } = dst.AddPage(src.Pages[2]);  // copy source "Page 3"
    expect(number).toBe(3);
    expect(dst.Pages.length).toBe(3);
    expect(text(dst, 2)).toContain('Page 3');      // copied content present
    // Source document untouched.
    expect(src.Pages.length).toBe(3);
    expect(text(src, 2)).toContain('Page 3');
  });

  it('InsertPage with a source places the copy at the requested slot', () => {
    const src = Document.Open(buildClassicPdf(3));
    const dst = Document.Open(buildClassicPdf(2));
    dst.InsertPage(1, src.Pages[2]); // copy "Page 3" at slot 1
    expect(dst.Pages.length).toBe(3);
    expect(text(dst, 0)).toContain('Page 3');
    expect(text(dst, 1)).toContain('Page 1');
  });

  it('same-document copy duplicates content into a distinct object', () => {
    const doc = Document.Open(buildClassicPdf(2));
    doc.AddPage(doc.Pages[0]); // duplicate page 1
    expect(doc.Pages.length).toBe(3);
    expect(text(doc, 2)).toContain('Page 1');
    // Distinct live object: editing the copy does not touch the original.
    doc.Pages[2].Rotate = 90;
    expect(doc.Pages[0].Rotate).toBe(0);
  });

  it('round-trips a cross-document copy through Save/Open', () => {
    const src = Document.Open(buildClassicPdf(3));
    const dst = Document.Open(buildClassicPdf(1));
    dst.AddPage(src.Pages[2]);
    const re = Document.Open(dst.Save());
    expect(re.Pages.length).toBe(2);
    expect(new TextDecoder().decode(re.Pages[1].Contents)).toContain('Page 3');
  });
});

describe('Document.RemovePage', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('removes a page by 1-based number and renumbers the rest', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.RemovePage(2);
    expect(doc.Pages.length).toBe(2);
    expect(doc.Pages.map((p) => p.Number)).toEqual([1, 2]);
    expect(text(doc, 0)).toContain('Page 1');
    expect(text(doc, 1)).toContain('Page 3');
  });

  it('removes a page by Page handle', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.RemovePage(doc.Pages[0]);
    expect(doc.Pages.length).toBe(2);
    expect(text(doc, 0)).toContain('Page 2');
  });

  it('can remove down to zero pages', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.RemovePage(1);
    expect(doc.Pages.length).toBe(0);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(0);
  });

  it('throws RangeError on invalid number or foreign page; leaves Pages unchanged', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const foreign = Document.Open(buildClassicPdf(1)).Pages[0];
    expect(() => doc.RemovePage(0)).toThrow(RangeError);
    expect(() => doc.RemovePage(3)).toThrow(RangeError);
    expect(() => doc.RemovePage(1.5)).toThrow(RangeError);
    expect(() => doc.RemovePage(foreign)).toThrow(RangeError);
    expect(doc.Pages.length).toBe(2);
  });

  it('round-trips a removal through Save/Open', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.RemovePage(2);
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(2);
    expect(text(re, 0)).toContain('Page 1');
    expect(text(re, 1)).toContain('Page 3');
  });
});

describe('Document page ops compose', () => {
  const text = (doc: Document, i: number) => new TextDecoder().decode(doc.Pages[i].Contents);

  it('AddPage + RemovePage + Reorder compose in one session and persist', () => {
    const doc = Document.Open(buildClassicPdf(3)); // Page 1,2,3
    doc.AddPage();          // -> 1,2,3,blank (4 pages)
    doc.RemovePage(2);      // -> 1,3,blank (3 pages)
    doc.Reorder([3, 1, 2]); // -> blank,1,3
    expect(doc.Pages.length).toBe(3);
    expect(doc.Pages[0].Contents.length).toBe(0); // blank first
    expect(text(doc, 1)).toContain('Page 1');
    expect(text(doc, 2)).toContain('Page 3');
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(3);
    expect(re.Pages[0].Contents.length).toBe(0);
    expect(new TextDecoder().decode(re.Pages[2].Contents)).toContain('Page 3');
  });
});

describe('Document.Save / WriteTo', () => {
  it('Save round-trips a metadata edit through reopen', () => {
    const doc = Document.Open(buildClassicPdf(1, { info: { Title: 'Old' } }));
    doc.SetMetadata({ title: 'New' });
    expect(Document.Open(doc.Save()).GetMetadata().title).toBe('New');
  });

  it('Save drops pages removed by Reorder (reachable-only)', () => {
    const doc = Document.Open(buildClassicPdf(3));
    doc.Reorder([2]); // keep only old page 2
    const re = Document.Open(doc.Save());
    expect(re.Pages.length).toBe(1);
    const txt = new TextDecoder().decode(re.Pages[0].Contents);
    expect(txt).toContain('Page 2');
  });

  it('Save is stable across reopen (idempotent bytes)', () => {
    const doc = Document.Open(buildClassicPdf(2, { info: { Title: 'X' } }));
    const first = doc.Save();
    const second = Document.Open(first).Save();
    expect(second).toEqual(first);
  });

  it('persists Page.Rotate set via the live handle', () => {
    const doc = Document.Open(buildClassicPdf(1));
    doc.Pages[0].Rotate = 90;
    expect(Document.Open(doc.Save()).Pages[0].Rotate).toBe(90);
  });

  it('WriteTo writes serialized bytes to a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdfwriteto-'));
    try {
      const path = join(dir, 'out.pdf');
      Document.Open(buildClassicPdf(2)).WriteTo(path);
      expect(Document.Open(new Uint8Array(readFileSync(path))).Pages.length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Document.New', () => {
  it('with no format is a zero-page document that saves and re-opens', () => {
    const doc = Document.New();
    expect(doc.Pages.length).toBe(0);
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages.length).toBe(0);
  });

  it('with a format is a one-page document of that size', () => {
    const doc = Document.New(PageFormat.A4);
    expect(doc.Pages.length).toBe(1);
    expect(doc.Pages[0].MediaBox).toEqual([0, 0, 595, 842]);
    expect(Document.Open(doc.Save()).Pages[0].MediaBox).toEqual([0, 0, 595, 842]);
    expect(Document.New(PageFormat.Letter.landscape()).Pages[0].MediaBox)
      .toEqual([0, 0, 792, 612]);
  });

  it('round-trips a document authored entirely from scratch', () => {
    const doc = Document.New(PageFormat.A4);
    doc.Pages[0].AddText('Hello from scratch', 72, 720, { fontSize: 14 });
    doc.AddPage(PageFormat.A4).page.AddText('Second page', 72, 720, { fontSize: 14 });
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages.length).toBe(2);
    expect(reopened.Pages[0].GetText()).toContain('Hello from scratch');
    expect(reopened.Pages[1].GetText()).toContain('Second page');
  });

  it('is the same empty document Merge() builds from no inputs', () => {
    // Merge keeps delegating to the same private helper, so the two agree byte
    // for byte; if they ever diverge, one of them grew a catalog entry.
    expect(Document.New().Save()).toEqual(Document.Merge().Save());
  });

  it('rejects a format that is not a PageFormat', () => {
    // Matched on message: a missing method throws a TypeError too, so
    // `toThrow(TypeError)` alone would pass before New exists at all.
    expect(() => Document.New({ width: 595, height: 842 } as never))
      .toThrow(/Document.New: format must be a PageFormat/);
    expect(() => Document.New('A4' as never))
      .toThrow(/Document.New: format must be a PageFormat/);
  });
});
