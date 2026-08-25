import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildNUpSource } from './helpers/build-nup-source.js';
import { isStream, isDict, type PdfStream, type PdfDict } from '../src/types.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** The /XObject sub-dict of a page's own /Resources. */
function pageXObjects(doc: Document, page: { Dict: PdfDict }): PdfDict {
  const res = doc.resolve(page.Dict.get('Resources')) as PdfDict;
  return doc.resolve(res.get('XObject')) as PdfDict;
}

/** Decoded, concatenated content bytes of a page. */
function pageContent(doc: Document, page: { Contents: Uint8Array }): string {
  return dec(page.Contents);
}

/** Parse `sx 0 0 sy e f cm` placements from a content string, in order. */
function placements(content: string): Array<{ sx: number; sy: number; e: number; f: number }> {
  const re = /(-?[\d.]+) 0 0 (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g;
  const out: Array<{ sx: number; sy: number; e: number; f: number }> = [];
  for (let m = re.exec(content); m; m = re.exec(content))
    out.push({ sx: +m[1], sy: +m[2], e: +m[3], f: +m[4] });
  return out;
}

describe('doc.NUp', () => {
  it('returns a new Document with ceil(pages / cols*rows) sheets, source unchanged', () => {
    const doc = Document.Open(buildNUpSource(5));
    const out = doc.NUp(2, 2);
    expect(out).not.toBe(doc);
    expect(out.Pages.length).toBe(2);        // ceil(5/4)
    expect(doc.Pages.length).toBe(5);        // source untouched
  });

  it('derives the default sheet size from the source page size * grid', () => {
    const out = Document.Open(buildNUpSource(4)).NUp(2, 2);
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 400, 200]);
  });

  it('grows the default sheet by margin and gutter', () => {
    const out = Document.Open(buildNUpSource(4)).NUp(2, 2, { margin: 10, gutter: 5 });
    // 2*200 + 2*10 + 1*5 = 425 ; 2*100 + 2*10 + 1*5 = 225
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 425, 225]);
  });

  it('honors an explicit pageSize', () => {
    const out = Document.Open(buildNUpSource(4)).NUp(2, 2, { pageSize: [612, 792] });
    expect(out.Pages[0].Dict.get('MediaBox')).toEqual([0, 0, 612, 792]);
  });

  it('places cols*rows imported Form XObjects per full sheet, fewer on the last', () => {
    const doc = Document.Open(buildNUpSource(5));
    const out = doc.NUp(2, 2);
    expect(pageXObjects(out, out.Pages[0]).size).toBe(4);
    expect(pageXObjects(out, out.Pages[1]).size).toBe(1); // 5th page only
    // each placed XObject is an imported /Form
    for (const v of pageXObjects(out, out.Pages[0]).values()) {
      const xobj = out.resolve(v);
      expect(isStream(xobj)).toBe(true);
      expect((xobj as PdfStream).dict.get('Subtype')).toMatchObject({ name: 'Form' });
    }
  });

  it('scales each cell to fit (200x100 into a 200x100 cell = no scaling) and 1:1 round-trips', () => {
    const out = Document.Open(buildNUpSource(4)).NUp(2, 2); // 400x200 sheet, four 200x100 cells
    const places = placements(pageContent(out, out.Pages[0]));
    expect(places.length).toBe(4);
    for (const p of places) {
      expect(p.sx).toBeCloseTo(1, 6);   // exact fit, no scaling
      expect(p.sy).toBeCloseTo(1, 6);
    }
    // round-trip survives Save/Open
    const rt = Document.Open(out.Save());
    expect(rt.Pages.length).toBe(1); // ceil(4/4)
    expect(pageXObjects(rt, rt.Pages[0]).size).toBe(4);
  });

  it("fills cells row-major by default and column-major with order:'column'", () => {
    const rowOut = Document.Open(buildNUpSource(4)).NUp(2, 2);
    const colOut = Document.Open(buildNUpSource(4)).NUp(2, 2, { order: 'column' });
    const rowP = placements(pageContent(rowOut, rowOut.Pages[0]));
    const colP = placements(pageContent(colOut, colOut.Pages[0]));
    // 2nd source page (index 1): row-major -> top-right cell (e=200, f=100);
    // column-major -> bottom-left cell (e=0, f=0).
    expect({ e: rowP[1].e, f: rowP[1].f }).toEqual({ e: 200, f: 100 });
    expect({ e: colP[1].e, f: colP[1].f }).toEqual({ e: 0, f: 0 });
  });

  it('throws RangeError for a grid dimension < 1 or non-integer', () => {
    const doc = Document.Open(buildNUpSource(2));
    expect(() => doc.NUp(0, 1)).toThrow(RangeError);
    expect(() => doc.NUp(1, 0)).toThrow(RangeError);
    expect(() => doc.NUp(1.5, 1)).toThrow(RangeError);
  });

  it('contains a differing aspect ratio: uniform scale, centred in the cell', () => {
    // THE case the existing 200x100-into-200x100 test cannot make: there the
    // scale is 1 and the centring offset is 0, so stretch, transpose and
    // no-centring all produce identical numbers.
    //
    // Source pages are 200x100 (2:1). A 300x200 sheet in a 2x1 grid gives
    // 150x200 cells (3:4), so:
    //   contain  -> s = min(150/200, 200/100) = 0.75 both axes,
    //               fh = 75, so f = (200 - 75) / 2 = 62.5
    //   stretch  -> sx = 0.75, sy = 2      (caught by sx === sy)
    //   transposed -> s = min(200/200, 150/100) = 1  (caught by the value)
    //   uncentred  -> f = 0                (caught by the offset)
    const out = Document.Open(buildNUpSource(2)).NUp(2, 1, { pageSize: [300, 200] });
    const places = placements(pageContent(out, out.Pages[0]));
    expect(places).toHaveLength(2);
    for (const p of places) {
      expect(p.sx).toBeCloseTo(0.75, 6);
      expect(p.sy).toBeCloseTo(0.75, 6);   // uniform, not stretched
      expect(p.f).toBeCloseTo(62.5, 6);    // centred vertically in the cell
    }
    // and the two cells sit side by side
    expect(places.map((p) => p.e).sort((a, b) => a - b)).toEqual([0, 150]);
  });
});

describe('doc.NUp drawBorder', () => {
  /** Stroked paths on a sheet, as bboxes rounded to 3dp. */
  const frames = (out: Document, i = 0) =>
    out.Pages[i].GetPaths().filter((p) => p.stroke)
      .map((p) => p.bbox.map((n) => Math.round(n * 1000) / 1000).join(','));

  it('frames each imposed cell', () => {
    // 400x200 sheet, four 200x100 cells, no margin or gutter.
    const out = Document.Open(buildNUpSource(4)).NUp(2, 2, { drawBorder: true });
    expect(frames(out).sort()).toEqual([
      '0,0,200,100', '0,100,200,200', '200,0,400,100', '200,100,400,200',
    ].sort());
  });

  it('follows margin and gutter, so the frame is the cell not the sheet', () => {
    const out = Document.Open(buildNUpSource(4))
      .NUp(2, 2, { margin: 10, gutter: 5, drawBorder: true });
    const f = frames(out);
    expect(f.length).toBe(4);
    // Every frame sits inside the margin, and none spans the gutter.
    for (const s of f) {
      const [x0, y0, x1, y1] = s.split(',').map(Number);
      expect(x0).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(y0).toBeGreaterThanOrEqual(10 - 1e-6);
      expect(x1 - x0).toBeCloseTo((400 + 20 + 5 - 20 - 5) / 2, 6);
      expect(y1 - y0).toBeCloseTo((200 + 20 + 5 - 20 - 5) / 2, 6);
    }
  });

  it('frames only the cells that received a page', () => {
    // 3 pages into a 2x2 grid: the fourth cell is empty and gets no frame,
    // which would otherwise read as a missing page rather than an unused cell.
    const out = Document.Open(buildNUpSource(3)).NUp(2, 2, { drawBorder: true });
    expect(frames(out).length).toBe(3);
  });

  it('takes an explicit width and colour', () => {
    const out = Document.Open(buildNUpSource(1))
      .NUp(1, 1, { drawBorder: { width: 2, color: [1, 0, 0] } });
    const strokes = out.Pages[0].GetPaths().filter((p) => p.stroke);
    expect(strokes.length).toBe(1);
    expect(strokes[0].lineWidth).toBeCloseTo(2, 6);
    expect(strokes[0].stroke!.rgb).toEqual([255, 0, 0]);
  });

  it('omitting it is byte-identical to today', () => {
    const a = Document.Open(buildNUpSource(4)).NUp(2, 2).Save();
    const b = Document.Open(buildNUpSource(4)).NUp(2, 2, { drawBorder: false }).Save();
    expect(a).toEqual(b);
    expect(dec(a)).not.toMatch(/(^|\s)S(\s|$)/);
  });

  it('rejects a malformed border spec', () => {
    const doc = () => Document.Open(buildNUpSource(2));
    expect(() => doc().NUp(2, 1, { drawBorder: { width: 0 } })).toThrow(/drawBorder/);
    expect(() => doc().NUp(2, 1, { drawBorder: { width: -1 } })).toThrow(/drawBorder/);
    expect(() => doc().NUp(2, 1, { drawBorder: { color: [2, 0, 0] } as never })).toThrow(/drawBorder/);
    expect(() => doc().NUp(2, 1, { drawBorder: 'yes' as never })).toThrow(/drawBorder/);
  });
});
