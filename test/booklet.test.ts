import { describe, it, expect } from 'vitest';
import { bookletSides, bookletCells, type BookletMetrics } from '../src/booklet.js';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { isDict, isStream, type PdfDict } from '../src/types.js';
import { buildNUpSource } from './helpers/build-nup-source.js';

/** Compact ["8|1", "2|7", …] view of a booklet's sides; '_' is a pad blank. */
const shape = (sides: ReturnType<typeof bookletSides>) =>
  sides.map((s) => `${s.left ?? '_'}|${s.right ?? '_'}`);

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** The /XObject sub-dict of a page's own /Resources, or an empty map when
 *  nothing was placed on the page (both of its cells were pad blanks). */
function pageXObjects(doc: Document, page: Page): PdfDict {
  const res = doc.resolve(page.Dict.get('Resources'));
  const xo = isDict(res) ? doc.resolve(res.get('XObject')) : undefined;
  return isDict(xo) ? xo : new Map();
}

/** Every placement on `page`, in content order: which source page the placed
 *  Form XObject draws (its "P3" label, from build-nup-source.ts) and the `cm`
 *  translation that positioned it. */
function placed(doc: Document, page: Page): { label: string; e: number; f: number }[] {
  const xobjs = pageXObjects(doc, page);
  const content = dec(page.Contents);
  const re = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*\/(\w+) Do/g;
  const out: { label: string; e: number; f: number }[] = [];
  for (let m = re.exec(content); m; m = re.exec(content)) {
    const xobj = doc.resolve(xobjs.get(m[5]));
    const body = isStream(xobj) ? dec(xobj.raw) : '';
    out.push({ label: body.match(/\((P\d+)\)/)?.[1] ?? '?', e: +m[3], f: +m[4] });
  }
  return out;
}

/** Parse `sx 0 0 sy e f cm` placements from a content string, in order. */
function placements(content: string): { sx: number; sy: number }[] {
  const re = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  const out: { sx: number; sy: number }[] = [];
  for (let m = re.exec(content); m; m = re.exec(content))
    out.push({ sx: +m[1], sy: +m[2] });
  return out;
}

describe('bookletSides — ordering', () => {
  it('orders a 4-page booklet onto one sheet, two sides', () => {
    expect(shape(bookletSides(4, { binding: 'left' }))).toEqual(['4|1', '2|3']);
    expect(bookletSides(4, { binding: 'left' }).map((s) => s.sheet)).toEqual([0, 0]);
    expect(bookletSides(4, { binding: 'left' }).map((s) => s.signature)).toEqual([0, 0]);
  });

  it('nests an 8-page booklet outermost sheet first', () => {
    expect(shape(bookletSides(8, { binding: 'left' }))).toEqual(['8|1', '2|7', '6|3', '4|5']);
    expect(bookletSides(8, { binding: 'left' }).map((s) => s.sheet)).toEqual([0, 0, 1, 1]);
  });

  it('nests a 12-page booklet', () => {
    expect(shape(bookletSides(12, { binding: 'left' })))
      .toEqual(['12|1', '2|11', '10|3', '4|9', '8|5', '6|7']);
  });

  it("mirrors every side with binding 'right'", () => {
    expect(shape(bookletSides(8, { binding: 'right' }))).toEqual(['1|8', '7|2', '3|6', '5|4']);
  });

  it('defaults to left binding', () => {
    expect(shape(bookletSides(8))).toEqual(shape(bookletSides(8, { binding: 'left' })));
  });

  it('pads up to a multiple of 4, the blanks falling at the end of the book', () => {
    expect(shape(bookletSides(5, { binding: 'left' }))).toEqual(['_|1', '2|_', '_|3', '4|5']);
    expect(shape(bookletSides(6, { binding: 'left' }))).toEqual(['_|1', '2|_', '6|3', '4|5']);
    expect(shape(bookletSides(7, { binding: 'left' }))).toEqual(['_|1', '2|7', '6|3', '4|5']);
  });

  it('places every real page exactly once, whatever the padding', () => {
    for (const n of [1, 2, 3, 5, 9, 13]) {
      const seen = bookletSides(n, { binding: 'left' })
        .flatMap((s) => [s.left, s.right])
        .filter((p): p is number => p !== null)
        .sort((a, b) => a - b);
      expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1));
    }
  });

  it('returns no sides for an empty page count', () => {
    expect(bookletSides(0)).toEqual([]);
  });
});

describe('bookletSides — signatures', () => {
  it('splits into one-sheet signatures, each folding on its own', () => {
    const sides = bookletSides(12, { sheetsPerSignature: 1 });
    expect(shape(sides)).toEqual(['4|1', '2|3', '8|5', '6|7', '12|9', '10|11']);
    expect(sides.map((s) => s.signature)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('nests two sheets inside each two-sheet signature', () => {
    const sides = bookletSides(16, { sheetsPerSignature: 2 });
    expect(shape(sides)).toEqual([
      '8|1', '2|7', '6|3', '4|5',        // signature 0: pages 1-8
      '16|9', '10|15', '14|11', '12|13', // signature 1: pages 9-16
    ]);
    expect(sides.map((s) => s.signature)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('lets the last signature be short', () => {
    // 10 pages -> padded to 12 -> signature 0 has 2 sheets, signature 1 has 1.
    const sides = bookletSides(10, { sheetsPerSignature: 2 });
    expect(shape(sides)).toEqual(['8|1', '2|7', '6|3', '4|5', '_|9', '10|_']);
    expect(sides.map((s) => s.signature)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('pads every signature full with padSignatures', () => {
    // 10 pages -> padded to 16 -> two full two-sheet signatures.
    const sides = bookletSides(10, { sheetsPerSignature: 2, padSignatures: true });
    expect(shape(sides)).toEqual([
      '8|1', '2|7', '6|3', '4|5',
      '_|9', '10|_', '_|_', '_|_',
    ]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('pads a book shorter than one signature up to a full one', () => {
    // 6 pages, 4 sheets/signature = 16 pages/signature -> padded to 16.
    const sides = bookletSides(6, { sheetsPerSignature: 4, padSignatures: true });
    expect(sides).toHaveLength(8);
    expect(sides.every((s) => s.signature === 0)).toBe(true);
    expect(shape(sides).slice(0, 2)).toEqual(['_|1', '2|_']);
  });

  it('mirrors signature cells with binding right', () => {
    const sides = bookletSides(8, { sheetsPerSignature: 1, binding: 'right' });
    expect(shape(sides)).toEqual(['1|4', '3|2', '5|8', '7|6']);
  });

  it('places every real page exactly once, whatever the signature size', () => {
    for (const n of [5, 9, 10, 13, 17]) {
      for (const sheetsPerSignature of [1, 2, 3]) {
        const seen = bookletSides(n, { sheetsPerSignature })
          .flatMap((s) => [s.left, s.right])
          .filter((p): p is number => p !== null)
          .sort((a, b) => a - b);
        expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      }
    }
  });

  it('is a no-op when the whole book fits one signature', () => {
    expect(bookletSides(8, { sheetsPerSignature: 2 })).toEqual(bookletSides(8));
    expect(bookletSides(8, { sheetsPerSignature: 9 })).toEqual(bookletSides(8));
  });
});

describe('bookletCells — geometry and creep', () => {
  /** A 400x100 sheet of two abutting 200x100 cells: the default for a 200x100
   *  source, where a cell is an exact 1:1 fit. */
  const m: BookletMetrics = {
    sheetW: 400, sheetH: 100, cellW: 200, cellH: 100,
    margin: 0, gutter: 0, creep: 0,
  };

  it('splits the sheet into two abutting cells with no margin, gutter or creep', () => {
    expect(bookletCells(m, 0)).toEqual({
      left: [0, 0, 200, 100],
      right: [200, 0, 400, 100],
    });
  });

  it('insets both cells by the margin and separates them by the gutter', () => {
    const g: BookletMetrics = {
      sheetW: 430, sheetH: 120, cellW: 200, cellH: 100,
      margin: 10, gutter: 10, creep: 0,
    };
    expect(bookletCells(g, 0)).toEqual({
      left: [10, 10, 210, 110],
      right: [220, 10, 420, 110],
    });
  });

  it('leaves the outermost sheet unshifted however large the creep', () => {
    expect(bookletCells({ ...m, creep: 5 }, 0)).toEqual(bookletCells(m, 0));
  });

  it('shifts inner sheets toward the spine — both cells move inward', () => {
    const c = bookletCells({ ...m, creep: 2 }, 3);   // d = 3 * 2 = 6
    expect(c.left).toEqual([6, 0, 206, 100]);        // moved right, toward the centre
    expect(c.right).toEqual([194, 0, 394, 100]);     // moved left, toward the centre
  });

  it('keeps both cells their declared size while creeping', () => {
    const c = bookletCells({ ...m, creep: 2 }, 3);
    expect(c.left[2] - c.left[0]).toBeCloseTo(200, 9);
    expect(c.right[2] - c.right[0]).toBeCloseTo(200, 9);
  });
});

describe('doc.Booklet', () => {
  it('returns a new Document with one page per printed side, source unchanged', () => {
    const doc = Document.Open(buildNUpSource(8));
    const out = doc.Booklet();
    expect(out).not.toBe(doc);
    expect(out.Pages.length).toBe(4);        // 8 pages -> 2 sheets -> 4 sides
    expect(doc.Pages.length).toBe(8);        // source untouched
  });

  it('pads a non-multiple-of-4 source up to whole sheets', () => {
    expect(Document.Open(buildNUpSource(5)).Booklet().Pages.length).toBe(4); // -> 8
    expect(Document.Open(buildNUpSource(1)).Booklet().Pages.length).toBe(2); // -> 4
  });

  it('places the saddle-stitch order onto the sheets', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet();
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P8', 'P1']);
    expect(placed(out, out.Pages[1]).map((p) => p.label)).toEqual(['P2', 'P7']);
    expect(placed(out, out.Pages[2]).map((p) => p.label)).toEqual(['P6', 'P3']);
    expect(placed(out, out.Pages[3]).map((p) => p.label)).toEqual(['P4', 'P5']);
  });

  it("mirrors the order with binding 'right'", () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ binding: 'right' });
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P1', 'P8']);
    expect(placed(out, out.Pages[1]).map((p) => p.label)).toEqual(['P7', 'P2']);
  });

  it('derives a 2-up landscape sheet from the source page size', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet();   // source 200x100
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 400, 100]);
    expect(out.Pages[0].Dict.get('CropBox')).toEqual([0, 0, 400, 100]);
  });

  it('grows the default sheet by margin and gutter', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet({ margin: 10, gutter: 5 });
    // 2*200 + 2*10 + 5 = 425 ; 100 + 2*10 = 120
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 425, 120]);
  });

  it('honors an explicit pageSize', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet({ pageSize: [612, 792] });
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 612, 792]);
  });

  it('fits a 200x100 page into its 200x100 cell without scaling', () => {
    const out = Document.Open(buildNUpSource(4)).Booklet();
    const places = placements(dec(out.Pages[0].Contents));
    expect(places.length).toBe(2);
    for (const p of places) {
      expect(p.sx).toBeCloseTo(1, 6);
      expect(p.sy).toBeCloseTo(1, 6);
    }
  });

  it('places nothing at all in a pad blank cell', () => {
    const out = Document.Open(buildNUpSource(5)).Booklet();  // '_|1','2|_','_|3','4|5'
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P1']);
    expect(pageXObjects(out, out.Pages[0]).size).toBe(1);
    expect(placed(out, out.Pages[3]).map((p) => p.label)).toEqual(['P4', 'P5']);
    expect(pageXObjects(out, out.Pages[3]).size).toBe(2);
  });

  it('round-trips through Save/Open', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet();
    const rt = Document.Open(out.Save());
    expect(rt.Pages.length).toBe(4);
    expect(placed(rt, rt.Pages[0]).map((p) => p.label)).toEqual(['P8', 'P1']);
  });
});

describe('doc.Booklet — validation', () => {
  const doc = () => Document.Open(buildNUpSource(4));

  it('throws RangeError for a document with no pages', () => {
    expect(() => Document.Open(buildNUpSource(0)).Booklet()).toThrow(RangeError);
  });

  it('rejects a binding that is neither left nor right', () => {
    expect(() => doc().Booklet({ binding: 'top' as 'left' })).toThrow(TypeError);
  });

  it('rejects a negative or non-finite margin, gutter or creep', () => {
    expect(() => doc().Booklet({ margin: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ gutter: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ creep: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ creep: Infinity })).toThrow(TypeError);
    expect(() => doc().Booklet({ margin: NaN })).toThrow(TypeError);
  });

  it('rejects a malformed pageSize', () => {
    expect(() => doc().Booklet({ pageSize: [0, 100] })).toThrow(TypeError);
    expect(() => doc().Booklet({ pageSize: [-1, 100] })).toThrow(TypeError);
    expect(() => doc().Booklet({ pageSize: [100] as unknown as [number, number] }))
      .toThrow(TypeError);
  });

  it('accepts zero for margin, gutter and creep', () => {
    expect(() => doc().Booklet({ margin: 0, gutter: 0, creep: 0 })).not.toThrow();
  });

  it('leaves the source document untouched when a call is rejected', () => {
    const d = doc();
    const before = d.Save();
    expect(() => d.Booklet({ creep: -1 })).toThrow(TypeError);
    expect(d.Save()).toEqual(before);
    expect(d.Pages.length).toBe(4);
  });
});

describe('doc.Booklet — creep', () => {
  // Source 200x100 -> 400x100 sheet, two 200x100 cells at x0 = 0 and x0 = 200.
  // The fit is 1:1, so each placement's `e` IS its cell's x0.
  it('leaves the outermost sheet in place and pulls inner sheets toward the spine', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ creep: 2 });
    const sheet0 = placed(out, out.Pages[0]);   // ['P8','P1'] — nesting level 0
    const sheet1 = placed(out, out.Pages[2]);   // ['P6','P3'] — nesting level 1
    expect(sheet0[0].e).toBeCloseTo(0, 6);      // left cell, unshifted
    expect(sheet0[1].e).toBeCloseTo(200, 6);    // right cell, unshifted
    expect(sheet1[0].e).toBeCloseTo(2, 6);      // left cell moved RIGHT, inward
    expect(sheet1[1].e).toBeCloseTo(198, 6);    // right cell moved LEFT, inward
  });

  it('applies the same shift to both sides of one physical sheet', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ creep: 2 });
    expect(placed(out, out.Pages[2]).map((p) => p.e))
      .toEqual(placed(out, out.Pages[3]).map((p) => p.e));
  });

  it('does not resize the placed content', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ creep: 2 });
    for (const p of placements(dec(out.Pages[2].Contents))) {
      expect(p.sx).toBeCloseTo(1, 6);
      expect(p.sy).toBeCloseTo(1, 6);
    }
  });

  it('creep 0 is identical to no creep at all', () => {
    const a = Document.Open(buildNUpSource(8)).Booklet({ creep: 0 }).Save();
    const b = Document.Open(buildNUpSource(8)).Booklet().Save();
    expect(a).toEqual(b);
  });
});

describe('doc.Booklet — signatures', () => {
  it('imposes each signature as its own fold', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ sheetsPerSignature: 1 });
    expect(out.Pages.length).toBe(4);
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P4', 'P1']);
    expect(placed(out, out.Pages[1]).map((p) => p.label)).toEqual(['P2', 'P3']);
    expect(placed(out, out.Pages[2]).map((p) => p.label)).toEqual(['P8', 'P5']);
    expect(placed(out, out.Pages[3]).map((p) => p.label)).toEqual(['P6', 'P7']);
  });

  it('leaves the last signature short by default', () => {
    // 10 pages -> padded to 12 -> 6 printed sides.
    const out = Document.Open(buildNUpSource(10)).Booklet({ sheetsPerSignature: 2 });
    expect(out.Pages.length).toBe(6);
  });

  it('pads every signature full with padSignatures', () => {
    // 10 pages -> padded to 16 -> 8 printed sides, the last carrying nothing.
    const out = Document.Open(buildNUpSource(10))
      .Booklet({ sheetsPerSignature: 2, padSignatures: true });
    expect(out.Pages.length).toBe(8);
    expect(pageXObjects(out, out.Pages[6]).size).toBe(0);
    expect(pageXObjects(out, out.Pages[7]).size).toBe(0);
  });

  it('matches the default output when the book fits one signature', () => {
    const a = Document.Open(buildNUpSource(8)).Booklet({ sheetsPerSignature: 2 }).Save();
    const b = Document.Open(buildNUpSource(8)).Booklet().Save();
    expect(a).toEqual(b);
  });

  it('restarts creep at every signature', () => {
    // 16 pages, 2 sheets/signature -> sides: sig0 s0, sig0 s1, sig1 s0, sig1 s1
    // (two output pages each). Signature 1's sheet 1 is the FOURTH physical
    // sheet: a globally-counted nesting level would shift it by 3*creep.
    const out = Document.Open(buildNUpSource(16))
      .Booklet({ sheetsPerSignature: 2, creep: 2 });
    expect(out.Pages.length).toBe(8);
    const sig0sheet1 = placed(out, out.Pages[2]);
    const sig1sheet0 = placed(out, out.Pages[4]);
    const sig1sheet1 = placed(out, out.Pages[6]);
    expect(sig0sheet1[0].e).toBeCloseTo(2, 6);     // 1 * creep
    expect(sig1sheet0[0].e).toBeCloseTo(0, 6);     // outermost of its fold: unshifted
    expect(sig1sheet1[0].e).toBeCloseTo(2, 6);     // 1 * creep, NOT 3 * creep
    expect(sig1sheet1[1].e).toBeCloseTo(198, 6);   // right cell, inward
  });
});

describe('doc.Booklet — signature validation', () => {
  const doc = () => Document.Open(buildNUpSource(4));

  it('rejects a sheetsPerSignature that is not a positive integer', () => {
    expect(() => doc().Booklet({ sheetsPerSignature: 0 })).toThrow(TypeError);
    expect(() => doc().Booklet({ sheetsPerSignature: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ sheetsPerSignature: 1.5 })).toThrow(TypeError);
    expect(() => doc().Booklet({ sheetsPerSignature: NaN })).toThrow(TypeError);
  });

  it('rejects a non-boolean padSignatures', () => {
    expect(() => doc().Booklet({ sheetsPerSignature: 1, padSignatures: 'yes' as unknown as boolean }))
      .toThrow(TypeError);
  });

  it('rejects padSignatures without sheetsPerSignature', () => {
    expect(() => doc().Booklet({ padSignatures: true })).toThrow(TypeError);
    expect(() => doc().Booklet({ padSignatures: false })).toThrow(TypeError);
  });

  it('leaves the source untouched when a signature option is rejected', () => {
    const d = doc();
    const before = d.Save();
    expect(() => d.Booklet({ sheetsPerSignature: 0 })).toThrow(TypeError);
    expect(d.Save()).toEqual(before);
  });
});
