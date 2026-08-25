import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildOutlinePdf } from './helpers/build-outline-pdf.js';
import { isDict } from '../src/types.js';

const open = () => Document.Open(buildOutlinePdf());
const reopen = (d: Document) => Document.Open(d.Save());

describe('outline fixture', () => {
  it('opens with three pages and an /Outlines dict', () => {
    const doc = open();
    expect(doc.Pages.length).toBe(3);
    expect(isDict(doc.resolve(doc.catalog().get('Outlines')))).toBe(true);
  });
});

describe('GetOutlines (read)', () => {
  it('returns the nested tree with titles, Open flags, and nesting', () => {
    const items = open().GetOutlines();
    expect(items.map((i) => i.Title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(items[0].Open).toBe(true);
    expect(items[0].Children?.map((c) => c.Title)).toEqual(['Section 1.1']);
    // leaves carry no Open / Children keys
    expect(items[1].Open).toBeUndefined();
    expect(items[1].Children).toBeUndefined();
    expect(items[0].Children![0].Children).toBeUndefined();
  });

  it('resolves an explicit /Dest array with null XYZ coordinates', () => {
    const ch1 = open().GetOutlines()[0];
    expect(ch1.Dest).toEqual({ page: 1, view: { type: 'XYZ', left: null, top: 780, zoom: null } });
  });

  it('returns [] for a document with no /Outlines', () => {
    const doc = open();
    doc.catalog().delete('Outlines');
    expect(doc.GetOutlines()).toEqual([]);
  });
});

describe('GetOutlines destination forms', () => {
  it('reports an explicit dest by page and a named one by name', () => {
    // Named targets are deliberately NOT resolved on read: collapsing one to a
    // page number here would discard the indirection that makes it survive a
    // page insertion, and there would be no way to write it back as a name.
    // GetNamedDestinations resolves when a page number is what you want.
    const doc = open();
    const items = doc.GetOutlines();
    const goto = items[0].Children![0];          // /A /GoTo /D [page2 /Fit]
    const named = items[1];                       // /Dest (chap2) via name tree
    const legacy = items[2];                      // /Dest /chap3 via /Dests dict
    expect(goto.Dest).toEqual({ page: 2, view: { type: 'Fit' } });
    expect(named.Dest).toEqual({ name: 'chap2' });
    expect(legacy.Dest).toEqual({ name: 'chap3' });
    // Both names still resolve through the document's tables.
    const byName = new Map(doc.GetNamedDestinations().map((d) => [d.name, d.dest]));
    expect(byName.get('chap2')).toEqual({ page: 3, view: { type: 'Fit' } });
  });

  it('still reports the name when it resolves to nothing', () => {
    // A dangling name is a target the viewer will fail to follow, not the
    // absence of a target — and it is what the file says.
    const doc = open();
    doc.catalog().delete('Names');
    doc.catalog().delete('Dests');
    expect(doc.GetOutlines()[1].Dest).toEqual({ name: 'chap2' });
    expect(doc.GetNamedDestinations()).toEqual([]);
  });
});

describe('SetOutlines (write + round-trip)', () => {
  it('round-trips a built tree through Save()/Open()', () => {
    const doc = open();
    doc.SetOutlines([
      { Title: 'Intro', Dest: { page: 2 } },
      {
        Title: 'Part A', Dest: { page: 1, view: { type: 'XYZ', left: null, top: 700, zoom: null } },
        Open: false,
        Children: [{ Title: 'A.1', Dest: { page: 3, view: { type: 'Fit' } } }],
      },
    ]);
    const items = reopen(doc).GetOutlines();
    expect(items.map((i) => i.Title)).toEqual(['Intro', 'Part A']);
    expect(items[0].Dest).toEqual({ page: 2, view: { type: 'Fit' } });
    expect(items[1].Open).toBe(false);
    expect(items[1].Children![0].Dest).toEqual({ page: 3, view: { type: 'Fit' } });
    expect(items[1].Dest).toEqual({ page: 1, view: { type: 'XYZ', left: null, top: 700, zoom: null } });
  });

  it('allows an item with no destination', () => {
    const doc = open();
    doc.SetOutlines([{ Title: 'Heading only' }]);
    const items = reopen(doc).GetOutlines();
    expect(items).toEqual([{ Title: 'Heading only' }]);
  });

  it('clears the outline on an empty array', () => {
    const doc = open();
    doc.SetOutlines([]);
    expect(doc.GetOutlines()).toEqual([]);
    expect(reopen(doc).catalog().has('Outlines')).toBe(false);
  });

  it('rejects an out-of-range page without mutating the document', () => {
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 'Bad', Dest: { page: 99 } }])).toThrow(RangeError);
    expect(doc.GetOutlines().map((i) => i.Title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
  });

  it('rejects a non-string title', () => {
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 123 as unknown as string }])).toThrow(TypeError);
  });
});

describe('outline item colour and text flags', () => {
  it('round-trips /C and /F through a nested tree', () => {
    const doc = open();
    doc.SetOutlines([
      {
        Title: 'Red bold', Dest: { page: 1 }, Color: [1, 0, 0], Bold: true,
        Children: [{ Title: 'Italic kid', Dest: { page: 2 }, Italic: true }],
      },
      { Title: 'Plain', Dest: { page: 3 } },
    ]);
    const items = reopen(doc).GetOutlines();
    expect(items[0].Color).toEqual([1, 0, 0]);
    expect(items[0].Bold).toBe(true);
    expect(items[0].Italic).toBeUndefined();
    expect(items[0].Children![0].Italic).toBe(true);
    expect(items[0].Children![0].Bold).toBeUndefined();
    expect(items[1].Color).toBeUndefined();
  });

  it('maps italic to /F bit 1 and bold to bit 2', () => {
    // Asserted against the spec's numbering (PDF 32000-1 12.3.3), not just
    // round-tripped: swapping the two bits on both the read and the write side
    // round-trips perfectly and renders every bookmark in the wrong style.
    const fOf = (item: Record<string, unknown>) => {
      const doc = open();
      doc.SetOutlines([{ Title: 'x', Dest: { page: 1 }, ...item }]);
      const outlines = doc.resolve(doc.catalog().get('Outlines')) as Map<string, unknown>;
      const first = doc.resolve(outlines.get('First') as never) as Map<string, unknown>;
      return doc.resolve(first.get('F') as never);
    };
    expect(fOf({ Italic: true })).toBe(1);
    expect(fOf({ Bold: true })).toBe(2);
    expect(fOf({ Bold: true, Italic: true })).toBe(3);

    const both = reopen((() => {
      const d = open();
      d.SetOutlines([{ Title: 'Both', Dest: { page: 1 }, Bold: true, Italic: true }]);
      return d;
    })()).GetOutlines()[0];
    expect(both.Bold).toBe(true);
    expect(both.Italic).toBe(true);
  });

  it('emits no /C or /F when unset, byte-identical to before the fields existed', () => {
    const styled = open();
    styled.SetOutlines([{ Title: 'A', Dest: { page: 1 } }]);
    const plain = open();
    plain.SetOutlines([{ Title: 'A', Dest: { page: 1 } }]);
    expect(styled.Save()).toEqual(plain.Save());
    const text = new TextDecoder('latin1').decode(styled.Save());
    expect(text).not.toContain('/C [');
    expect(text).not.toMatch(/\/F \d/);
  });

  it('rejects a malformed colour or non-boolean flag', () => {
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 'x', Color: [2, 0, 0] as never }]))
      .toThrow(/outline item Color/);
    expect(() => doc.SetOutlines([{ Title: 'x', Color: [0, 0] as never }]))
      .toThrow(/outline item Color/);
    expect(() => doc.SetOutlines([{ Title: 'x', Bold: 'yes' as never }]))
      .toThrow(/outline item Bold/);
    expect(() => doc.SetOutlines([{ Title: 'x', Italic: 1 as never }]))
      .toThrow(/outline item Italic/);
  });
});

describe('outline destinations by name', () => {
  it('writes a named /Dest and reports it back unresolved', () => {
    const doc = open();
    doc.SetNamedDestination('intro', { page: 2 });
    doc.SetOutlines([{ Title: 'Intro', Dest: { name: 'intro' } }]);
    const item = reopen(doc).GetOutlines()[0];
    expect(item.Dest).toEqual({ name: 'intro' });
  });

  it('survives a page insertion that shifts every later page number', () => {
    // The whole point over a page-number dest: that one is resolved at write
    // time, so inserting ahead of it silently retargets the bookmark.
    const doc = open();
    doc.SetNamedDestination('ch3', { page: 3 });
    doc.SetOutlines([
      { Title: 'ByName', Dest: { name: 'ch3' } },
      { Title: 'ByNumber', Dest: { page: 3 } },
    ]);
    const targetPage = doc.Pages[2].Dict;

    doc.InsertPage(1);                              // everything shifts down one
    const reopened = reopen(doc);
    const named = reopened.GetNamedDestinations().find((d) => d.name === 'ch3')!;
    expect(named.dest.page).toBe(4);                // followed the page object
    expect(reopened.GetOutlines()[1].Dest).toEqual({ page: 4, view: { type: 'Fit' } });
    expect(doc.Pages[3].Dict).toBe(targetPage);     // same page object, new number
  });

  it('leaves page-number destinations byte-identical', () => {
    const a = open();
    a.SetOutlines([{ Title: 'A', Dest: { page: 2, view: { type: 'Fit' } } }]);
    const b = open();
    b.SetOutlines([{ Title: 'A', Dest: { page: 2, view: { type: 'Fit' } } }]);
    expect(a.Save()).toEqual(b.Save());
  });

  it('rejects an empty or non-string destination name', () => {
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 'x', Dest: { name: '' } }]))
      .toThrow(/destination name/);
    expect(() => doc.SetOutlines([{ Title: 'x', Dest: { name: 7 as never } }]))
      .toThrow(/destination name/);
  });

  it('does not require the name to exist yet', () => {
    // Resolution is the viewer's job at view time; a forward reference to a
    // destination added later must not be rejected at write time.
    const doc = open();
    expect(() => doc.SetOutlines([{ Title: 'x', Dest: { name: 'later' } }])).not.toThrow();
    expect(reopen(doc).GetOutlines()[0].Dest).toEqual({ name: 'later' });
  });
});
