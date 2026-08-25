import { describe, it, expect } from 'vitest';
import { Document, createTable, TableBuilder, AddTableResult } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

describe('table rendering — page.AddTable', () => {
  it('places each cell in its column and row band', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['Alpha', 'Beta']);
    t.addRow(['Gamma', 'Delta']);
    const x = 72, top = 720, width = 400, pad = 3;
    const widths = t.resolveColumnWidths(width);             // [200, 200]
    const { rowHeights } = t.measure(widths, { cellPadding: pad });
    page.AddTable(t, x, top, { width, cellPadding: pad });

    const frags = page.GetTextFragments();
    const columnX = [x, x + widths[0], x + widths[0] + widths[1]];
    const rowTop = [top, top - rowHeights[0]];
    const rowBottom = [top - rowHeights[0], top - rowHeights[0] - rowHeights[1]];
    const find = (s: string) => frags.find((f) => f.text.includes(s))!;

    const alpha = find('Alpha');                             // row 0, col 0
    expect(alpha.quad[0]).toBeGreaterThanOrEqual(columnX[0]);
    expect(alpha.quad[0]).toBeLessThan(columnX[1]);
    expect(alpha.quad[1]).toBeGreaterThanOrEqual(rowBottom[0] - 0.01);
    expect(alpha.quad[1]).toBeLessThanOrEqual(rowTop[0] + 0.01);

    const delta = find('Delta');                             // row 1, col 1
    expect(delta.quad[0]).toBeGreaterThanOrEqual(columnX[1]);
    expect(delta.quad[0]).toBeLessThan(columnX[2]);
    expect(delta.quad[1]).toBeGreaterThanOrEqual(rowBottom[1] - 0.01);
    expect(delta.quad[1]).toBeLessThanOrEqual(rowTop[1] + 0.01);
  });

  it('a colspan header spans the full width; body cells stay in their columns', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('Header', { colSpan: 2 });
    t.addRow(['L', 'R']);
    const x = 72, width = 300;
    const widths = t.resolveColumnWidths(width);             // [150, 150]
    page.AddTable(t, x, 720, { width, cellPadding: 0 });

    const frags = page.GetTextFragments();
    const header = frags.find((f) => f.text.includes('Header'))!;
    const rCell = frags.find((f) => f.text === 'R')!;
    expect(header.quad[0]).toBeGreaterThanOrEqual(x);
    expect(header.quad[0]).toBeLessThan(x + 5);              // starts at table's left edge
    expect(rCell.quad[0]).toBeGreaterThanOrEqual(x + widths[0]); // 'R' in column 1
  });

  it('a two-line first-row cell pushes the next row down by one leading', () => {
    const secondBaseline = (first: string) => {
      const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
      t.addRow([first]);
      t.addRow(['second']);
      const page = Document.Open(buildBlankPage()).Pages[0];
      page.AddTable(t, 72, 720, { width: 200, cellPadding: 0 });
      return page.GetTextFragments().find((f) => f.text.includes('second'))!.quad[1];
    };
    expect(secondBaseline('a') - secondBaseline('a\nb')).toBeCloseTo(12, 4);
  });

  it('an empty table draws nothing and does not throw', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    expect(() => page.AddTable(createTable(), 72, 720, { width: 400 })).not.toThrow();
    expect(page.GetTextFragments()).toEqual([]);
  });

  it('AddTable returns the anchor page and the last row bottom', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['a', 'b']);
    t.addRow(['c', 'd']);
    const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
    const totalH = rowHeights[0] + rowHeights[1];

    const res = page.AddTable(t, 72, 720, { width: 200 });
    expect(res.pages).toEqual([page]);
    expect(res.remainder).toBeUndefined();
    expect(res.endY).toBeCloseTo(720 - totalH, 4);
  });
});

describe('table rendering — backgrounds & alignment', () => {
  it('a cell background paints a filled rect at the cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow().addCell('x', { background: [1, 0, 0] });
    const { rowHeights } = t.measure(t.resolveColumnWidths(100), { cellPadding: 2 });
    page.AddTable(t, 72, 720, { width: 100 });
    const red = page.GetPaths().find(
      (p) => p.fill && p.fill.space === 'DeviceRGB' &&
             p.fill.rgb[0] === 255 && p.fill.rgb[1] === 0 && p.fill.rgb[2] === 0)!;
    expect(red).toBeTruthy();
    expect(red.bbox[0]).toBeCloseTo(72, 3);
    expect(red.bbox[2]).toBeCloseTo(172, 3);
    expect(red.bbox[3]).toBeCloseTo(720, 3);
    expect(red.bbox[1]).toBeCloseTo(720 - rowHeights[0], 3);
  });

  it('background cascades table -> row -> cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ background: [0.5, 0.5, 0.5] });     // table gray
    t.addRow(['a'], { background: [0, 0, 1] });                 // row blue
    t.addRow(['b']);                                            // inherits table gray
    t.addRow().addCell('c', { background: [1, 0, 0] });         // cell red
    page.AddTable(t, 72, 720, { width: 60 });
    const rgbs = page.GetPaths().filter((p) => p.fill?.space === 'DeviceRGB').map((p) => p.fill!.rgb);
    expect(rgbs).toContainEqual([0, 0, 255]);
    expect(rgbs).toContainEqual([128, 128, 128]);              // round(0.5*255)
    expect(rgbs).toContainEqual([255, 0, 0]);
  });

  it('horizontal alignment shifts text: left < center < right', () => {
    const xAt = (align: 'left' | 'center' | 'right') => {
      const t = createTable({ fontSize: 10, leading: 12, align });
      t.addRow(['Hi']);
      const page = Document.Open(buildBlankPage()).Pages[0];
      page.AddTable(t, 72, 720, { width: 200, cellPadding: 4 });
      return page.GetTextFragments().find((f) => f.text.includes('Hi'))!.quad[0];
    };
    expect(xAt('left')).toBeLessThan(xAt('center'));
    expect(xAt('center')).toBeLessThan(xAt('right'));
  });

  it('table padding (from style) shifts a left-aligned cell right', () => {
    const xAt = (padding: number) => {
      const t = createTable({ fontSize: 10, leading: 12, padding });
      t.addRow(['Hi']);
      const page = Document.Open(buildBlankPage()).Pages[0];
      page.AddTable(t, 72, 720, { width: 200 });               // no cellPadding -> style padding
      return page.GetTextFragments().find((f) => f.text.includes('Hi'))!.quad[0];
    };
    expect(xAt(10) - xAt(2)).toBeCloseTo(8, 3);
  });
});

describe('table rendering — borders', () => {
  it('a cell border strokes a rect at each cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12, border: { width: 0.75, color: [0, 0, 0] } });
    t.addRow(['a', 'b']);
    const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
    page.AddTable(t, 72, 720, { width: 200 });
    const cellStrokes = page.GetPaths().filter(
      (p) => p.stroke?.space === 'DeviceRGB' && Math.abs(p.lineWidth - 0.75) < 1e-6);
    expect(cellStrokes.length).toBeGreaterThanOrEqual(2);
    expect(cellStrokes[0].stroke!.rgb).toEqual([0, 0, 0]);
    const c0 = cellStrokes.find((p) => Math.abs(p.bbox[0] - 72) < 1e-3)!;
    expect(c0.bbox[2]).toBeCloseTo(172, 3);
    expect(c0.bbox[3]).toBeCloseTo(720, 3);
    expect(c0.bbox[1]).toBeCloseTo(720 - rowHeights[0], 3);
  });

  it('outerBorder strokes one rect around the whole table', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12, outerBorder: { width: 1.5, color: [0, 0, 1] } });
    t.addRow(['a', 'b']);
    t.addRow(['c', 'd']);
    const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
    const totalH = rowHeights[0] + rowHeights[1];
    page.AddTable(t, 72, 720, { width: 200 });
    const strokes = page.GetPaths().filter((p) => p.stroke && Math.abs(p.lineWidth - 1.5) < 1e-6);
    expect(strokes.length).toBe(1);
    expect(strokes[0].stroke!.rgb).toEqual([0, 0, 255]);
    expect(strokes[0].bbox[0]).toBeCloseTo(72, 3);
    expect(strokes[0].bbox[2]).toBeCloseTo(272, 3);            // 72 + Σwidths
    expect(strokes[0].bbox[3]).toBeCloseTo(720, 3);
    expect(strokes[0].bbox[1]).toBeCloseTo(720 - totalH, 3);
  });
});

describe('table rendering — pagination (manual)', () => {
  const tallTable = (n: number) => {
    const t = createTable({ fontSize: 10, leading: 12 });
    for (let i = 0; i < n; i++) t.addRow([`row${i}`]);
    return t;
  };

  it('draws rows that fit above bottomMargin and returns the rest', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = tallTable(40);                            // 16pt rows
    const res = page.AddTable(t, 72, 100, { width: 200, cellPadding: 2 });
    expect(res.remainder).toBeDefined();
    expect(res.pages).toEqual([page]);
    for (const f of page.GetTextFragments()) expect(f.quad[1]).toBeGreaterThanOrEqual(0);
    expect(res.endY).toBeGreaterThanOrEqual(0);
  });

  it('remainder redrawn continues; the union of drawn rows covers all rows once', () => {
    const t = tallTable(40);
    const seen: string[] = [];
    let rem: TableBuilder | undefined = t;
    let guard = 0;
    while (rem && guard++ < 60) {
      const page = Document.Open(buildBlankPage()).Pages[0];   // fresh page each slice
      const res: AddTableResult = page.AddTable(rem, 72, 100, { width: 200, cellPadding: 2 });
      for (const f of page.GetTextFragments()) if (/^row\d+$/.test(f.text)) seen.push(f.text);
      rem = res.remainder;
    }
    expect(rem).toBeUndefined();                          // fully consumed
    const expected = Array.from({ length: 40 }, (_, i) => `row${i}`);
    expect(seen.slice().sort()).toEqual(expected.slice().sort());   // each row once
  });

  it('a row that would straddle the bottom line moves whole to the remainder', () => {
    // top 40, bottomMargin 0, 16pt rows: row0 [40..24], row1 [24..8], row2 [8..-8]
    // -> row2 does not fit; only 2 rows drawn, row2 is first of remainder.
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = tallTable(5);
    const res = page.AddTable(t, 72, 40, { width: 200, cellPadding: 2 });
    const drawn = page.GetTextFragments().map((f) => f.text).filter((s) => /^row\d+$/.test(s));
    expect(drawn.sort()).toEqual(['row0', 'row1']);
    // remainder starts at row2
    const rpage = Document.Open(buildBlankPage()).Pages[0];
    rpage.AddTable(res.remainder!, 72, 700, { width: 200, cellPadding: 2 });
    const first = rpage.GetTextFragments().find((f) => /^row\d+$/.test(f.text))!;
    expect(first.text).toBe('row2');
  });

  it('a single row taller than the page is drawn anyway (no infinite remainder)', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['only']);
    // bottomMargin so large the row cannot fit, but it is first-on-page -> drawn.
    const res = page.AddTable(t, 72, 40, { width: 200, cellPadding: 2, bottomMargin: 100 });
    expect(page.GetTextFragments().some((f) => f.text.includes('only'))).toBe(true);
    expect(res.remainder).toBeUndefined();
  });

  it('an empty table returns the anchor page and no remainder', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const res = page.AddTable(createTable(), 72, 720, { width: 400 });
    expect(res).toEqual({ pages: [page], endY: 720, remainder: undefined });
    expect(page.GetTextFragments()).toEqual([]);
  });
});

describe('table rendering — pagination (auto)', () => {
  const tallTable = (n: number) => {
    const t = createTable({ fontSize: 10, leading: 12 });
    for (let i = 0; i < n; i++) t.addRow([`row${i}`]);
    return t;
  };

  it('appends pages and draws the whole table, no remainder', () => {
    const doc = Document.Open(buildBlankPage());          // 1 page, 612 x 792
    const page = doc.Pages[0];
    const t = tallTable(120);                             // far taller than one page
    const res = page.AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.remainder).toBeUndefined();
    expect(res.pages.length).toBeGreaterThan(1);
    expect(res.pages[0]).toBe(page);
    expect(doc.Pages.length).toBe(res.pages.length);      // pages were appended
    // Every row text appears somewhere across the appended pages.
    const all = res.pages.flatMap((p) => p.GetTextFragments().map((f) => f.text));
    for (let i = 0; i < 120; i++) expect(all).toContain(`row${i}`);
  });

  it('appended pages copy the anchor MediaBox (Letter, not the AddPage A4 default)', () => {
    const doc = Document.Open(buildBlankPage());          // Letter 612 x 792
    const t = tallTable(120);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    expect(res.pages[1].MediaBox).toEqual([0, 0, 612, 792]);   // not 595 x 842
  });

  it('endY is the last drawn row bottom on the last page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = tallTable(120);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    const last = res.pages[res.pages.length - 1];
    const lowest = Math.min(...last.GetTextFragments().map((f) => f.quad[1]));
    // endY (row bottom) is below the lowest baseline but within a row height of it.
    expect(res.endY).toBeLessThanOrEqual(lowest);
    expect(lowest - res.endY).toBeLessThan(16);
  });

  it('reprints a 1-row header at the top of every continuation page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['HEADER']);                          // row 0 = header
    for (let i = 0; i < 120; i++) t.addRow([`row${i}`]);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    // HEADER appears exactly once per page.
    for (const p of res.pages) {
      const headers = p.GetTextFragments().filter((f) => f.text.includes('HEADER'));
      expect(headers.length).toBe(1);
    }
    // Every body row still appears somewhere.
    const all = res.pages.flatMap((p) => p.GetTextFragments().map((f) => f.text));
    for (let i = 0; i < 120; i++) expect(all).toContain(`row${i}`);
  });

  it('reprints a 2-row header (incl. a colspan header) on each continuation page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 }).setColumnWidths([{ fraction: 1 }, { fraction: 1 }]);
    t.addRow().addCell('TITLE', { colSpan: 2 });   // row 0
    t.addRow(['A', 'B']);                          // row 1
    for (let i = 0; i < 120; i++) t.addRow([`c${i}`, `d${i}`]);
    t.setRepeatingRowsCount(2);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    for (const p of res.pages) {
      const texts = p.GetTextFragments().map((f) => f.text);
      expect(texts.filter((x) => x.includes('TITLE')).length).toBe(1);
      expect(texts.filter((x) => x === 'A').length).toBe(1);
    }
  });

  it('header on the header-carrying manual remainder reprints when redrawn', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['HEADER']);
    for (let i = 0; i < 120; i++) t.addRow([`row${i}`]);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, { width: 200, cellPadding: 2, bottomMargin: 72 });
    expect(res.remainder).toBeDefined();
    // The remainder's first row is the header, so a redraw reprints it.
    expect(res.remainder!.rows[0].cells[0].text).toBe('HEADER');
    const rpage = Document.Open(buildBlankPage()).Pages[0];
    rpage.AddTable(res.remainder!, 72, 720, { width: 200, cellPadding: 2, bottomMargin: 72 });
    expect(rpage.GetTextFragments().some((f) => f.text.includes('HEADER'))).toBe(true);
  });

  it('a repeating count of 0 leaves auto pagination unchanged', () => {
    const doc = Document.Open(buildBlankPage());
    const t = tallTable(120);
    t.setRepeatingRowsCount(0);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    // row0 appears exactly once total (not reprinted per page).
    const all = res.pages.flatMap((p) => p.GetTextFragments().map((f) => f.text));
    expect(all.filter((x) => x === 'row0').length).toBe(1);
  });
});

describe('table rendering — images in cells', () => {
  const png2x1 = () => buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0);   // aspect 2:1
  const png1x1 = () => buildPngRgbWith(1, 1, [0, 0, 255], 0);              // square
  const content = (page: any) => new TextDecoder().decode(page.Contents);
  // Parse the single "w 0 0 h x y cm" image placement from the content.
  const cmOf = (page: any) => {
    const m = content(page).match(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/Im\d+ Do/);
    if (!m) throw new Error('no image cm found');
    return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] };
  };

  it('registers the image XObject and scales it aspect-fit to the inner width', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1());
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });   // innerWidth 96 -> 96x48
    expect(page.Images.length).toBe(1);
    const cm = cmOf(page);
    expect(cm.w).toBeCloseTo(96, 3);
    expect(cm.h).toBeCloseTo(48, 3);
    expect(cm.x).toBeCloseTo(72 + 2, 3);          // left inset by padding
  });

  it('honors an explicit height (height-capped) and centers a square image', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable();
    t.addRow().addCell('').setImage(png1x1(), { height: 20, align: 'center', valign: 'top' });
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });   // innerWidth 96, box 96x20
    const cm = cmOf(page);
    expect(cm.w).toBeCloseTo(20, 3);              // square contained into 96x20 -> 20x20
    expect(cm.h).toBeCloseTo(20, 3);
    expect(cm.x).toBeCloseTo(72 + 2 + (96 - 20) / 2, 3);   // centered horizontally
  });

  it('draws the image under the cell text (both present)', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow().addCell('LABEL').setImage(png2x1());
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });
    expect(page.Images.length).toBe(1);                        // image present
    expect(page.GetTextFragments().some((f) => f.text.includes('LABEL'))).toBe(true);  // text present
    // Image Do appears before the text 'LABEL' in the content stream (image under text).
    const c = content(page);
    const doIdx = c.indexOf(' Do');
    const txtIdx = c.indexOf('LABEL');
    expect(doIdx).toBeGreaterThanOrEqual(0);
    expect(txtIdx).toBeGreaterThanOrEqual(0);
    expect(doIdx).toBeLessThan(txtIdx);
  });

  it('spans a colspan image across the combined column width', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable().setColumnWidths([{ fixed: 60 }, { fixed: 60 }]);
    t.addRow().addCell('', { colSpan: 2 }).setImage(png2x1());  // inner width 120 - 4 = 116
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 120, cellPadding: 2 });
    const cm = cmOf(page);
    expect(cm.w).toBeCloseTo(116, 3);
  });

  it('applies image opacity via /ExtGState', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable();
    t.addRow().addCell('').setImage(png2x1(), { opacity: 0.3 });
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 100, cellPadding: 2 });
    expect(content(page)).toMatch(/\/GS\d+ gs/);
  });

  it('reprints a header image on every auto-paginated page', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow().addCell('').setImage(png2x1(), { height: 10 });   // header row with image
    for (let i = 0; i < 120; i++) t.addRow([`row${i}`]);
    t.setRepeatingRowsCount(1);
    const res = doc.Pages[0].AddTable(t, 72, 720, {
      width: 100, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    for (const p of res.pages) expect(p.Images.length).toBe(1);   // one image per page
  });
});

describe('table rendering — row minHeight', () => {
  it('pushes the next row down by the enlarged band, not by the content height', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['banner'], { minHeight: 60 });                 // content would be 16pt
    t.addRow(['below']);
    const top = 700;
    page.AddTable(t, 72, top, { width: 200, cellPadding: 2 });
    const frags = page.GetTextFragments();
    const below = frags.find((f) => f.text.includes('below'))!;
    // Row 1's band is [top-60-16, top-60]; its top-aligned text sits inside it.
    expect(below.quad[1]).toBeLessThanOrEqual(top - 60 + 0.01);
    expect(below.quad[1]).toBeGreaterThanOrEqual(top - 60 - 16 - 0.01);
  });

  it('valign positions cell content within the enlarged box', () => {
    const yOf = (valign: 'top' | 'center' | 'bottom') => {
      const page = Document.Open(buildBlankPage()).Pages[0];
      const t = createTable({ fontSize: 10, leading: 12, valign });
      t.addRow(['x'], { minHeight: 60 });
      page.AddTable(t, 72, 700, { width: 200, cellPadding: 2 });
      return page.GetTextFragments().find((f) => f.text.includes('x'))!.quad[1];
    };
    const [tp, ctr, bt] = [yOf('top'), yOf('center'), yOf('bottom')];
    expect(tp).toBeGreaterThan(ctr);
    expect(ctr).toBeGreaterThan(bt);
    expect(tp - bt).toBeCloseTo(60 - 2 * 2 - 12, 1);         // box minus padding minus one line
  });

  it('a minHeight row that no longer fits moves whole to the remainder', () => {
    // top 100, bottomMargin 0: row0 [100..40] (minHeight 60), row1 needs 60 more.
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ fontSize: 10, leading: 12 });
    t.addRow(['first'], { minHeight: 60 });
    t.addRow(['second'], { minHeight: 60 });
    const res = page.AddTable(t, 72, 100, { width: 200, cellPadding: 2 });
    const drawn = page.GetTextFragments().map((f) => f.text.trim());
    expect(drawn).toContain('first');
    expect(drawn).not.toContain('second');
    expect(res.endY).toBeCloseTo(40, 6);
    const rpage = Document.Open(buildBlankPage()).Pages[0];
    const r2 = rpage.AddTable(res.remainder!, 72, 700, { width: 200, cellPadding: 2 });
    expect(r2.endY).toBeCloseTo(640, 6);                     // minHeight survives the split
  });

  it('an auto-paginated minHeight row starts a new page without overlapping', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ fontSize: 10, leading: 12 });
    for (let i = 0; i < 12; i++) t.addRow([`row${i}`], { minHeight: 60 });
    const res = doc.Pages[0].AddTable(t, 72, 700, {
      width: 200, cellPadding: 2, autoPaginate: true, bottomMargin: 72, topMargin: 72,
    });
    expect(res.pages.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const p of res.pages) {
      const ys = p.GetTextFragments()
        .filter((f) => /^row\d+$/.test(f.text.trim()))
        .map((f) => { seen.push(f.text.trim()); return f.quad[1]; })
        .sort((a, b) => b - a);
      for (let i = 1; i < ys.length; i++) expect(ys[i - 1] - ys[i]).toBeGreaterThanOrEqual(60 - 0.01);
    }
    expect(seen.sort()).toEqual(Array.from({ length: 12 }, (_, i) => `row${i}`).sort());
  });
});

describe('table rendering — per-side borders', () => {
  const content = (page: any) => new TextDecoder().decode(page.Contents);
  /** Count of standalone `re` operators (the four-edge rect shorthand). */
  const rectOps = (cs: string) => (cs.match(/(^|\s)re(\s|$)/g) ?? []).length;

  const draw = (border: any, rows = [['a']], width = 200) => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, border });
    for (const r of rows) t.addRow(r);
    const { rowHeights } = t.measure(t.resolveColumnWidths(width), { cellPadding: 2 });
    page.AddTable(t, 72, 720, { width, cellPadding: 2 });
    return { page, rowHeights, cs: content(page) };
  };

  it('a bottom-only cell border paints one rule at the cell bottom, not a rect', () => {
    const { page, rowHeights, cs } = draw({ width: 0.75, color: [0, 0, 0], sides: { bottom: true } });
    expect(rectOps(cs)).toBe(0);                       // no `re`: not all four edges
    const strokes = page.GetPaths().filter((p) => p.stroke);
    expect(strokes.length).toBe(1);
    const [x0, y0, x1, y1] = strokes[0].bbox;
    expect(y0).toBeCloseTo(720 - rowHeights[0], 3);
    expect(y1).toBeCloseTo(720 - rowHeights[0], 3);    // zero height => a single rule
    expect(x0).toBeCloseTo(72, 3);
    expect(x1).toBeCloseTo(272, 3);
  });

  it('a left-only cell border paints a vertical rule at the cell left edge', () => {
    const { page, rowHeights, cs } = draw({ width: 0.75, color: [0, 0, 0], sides: { left: true } });
    expect(rectOps(cs)).toBe(0);
    const [x0, y0, x1, y1] = page.GetPaths().filter((p) => p.stroke)[0].bbox;
    expect(x0).toBeCloseTo(72, 3);
    expect(x1).toBeCloseTo(72, 3);                     // zero width
    expect(y0).toBeCloseTo(720 - rowHeights[0], 3);
    expect(y1).toBeCloseTo(720, 3);
  });

  it("omitting sides, 'all', and all four flags are byte-identical", () => {
    const base = draw({ width: 0.75, color: [0, 0, 0] }, [['a', 'b'], ['c', 'd']]).cs;
    expect(draw({ width: 0.75, color: [0, 0, 0], sides: 'all' }, [['a', 'b'], ['c', 'd']]).cs).toBe(base);
    expect(draw({ width: 0.75, color: [0, 0, 0], sides: { top: true, right: true, bottom: true, left: true } },
      [['a', 'b'], ['c', 'd']]).cs).toBe(base);
    expect(rectOps(base)).toBe(4);                     // still the rect shorthand
  });

  it("sides: 'none' and an all-false object paint nothing", () => {
    for (const sides of ['none', {}, { bottom: false }] as const) {
      const { page, cs } = draw({ width: 0.75, color: [0, 0, 0], sides });
      expect(page.GetPaths().filter((p) => p.stroke)).toEqual([]);
      expect(rectOps(cs)).toBe(0);
    }
  });

  it("a tagged table whose only borders are 'none' opens no artifact sequence", () => {
    // The border pass must not BeginArtifact for borders that draw nothing:
    // apply() no-ops on an empty part list, but BeginArtifact pushes a part.
    const doc = Document.Open(buildBlankPage());
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      border: { width: 0.5, color: [0, 0, 0], sides: 'none' },
    });
    t.addRow(['a', 'b']);
    doc.Pages[0].AddTable(t, 72, 720, { width: 300, tagged: true });
    expect(content(doc.Pages[0])).not.toContain('/Artifact BMC');
  });

  it('the outer border honours sides independently of the cell borders', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({
      font: 'Helvetica', fontSize: 10, leading: 12,
      border: { width: 0.75, color: [0, 0, 0], sides: { bottom: true } },
      outerBorder: { width: 1.5, color: [0, 0, 1], sides: { top: true, bottom: true } },
    });
    t.addRow(['a']);
    t.addRow(['b']);
    const { rowHeights } = t.measure(t.resolveColumnWidths(200), { cellPadding: 2 });
    page.AddTable(t, 72, 720, { width: 200, cellPadding: 2 });
    const outer = page.GetPaths().filter((p) => p.stroke && Math.abs(p.lineWidth - 1.5) < 1e-6);
    expect(outer.length).toBe(1);                      // one path, two horizontal rules
    expect(outer[0].bbox[1]).toBeCloseTo(720 - rowHeights[0] - rowHeights[1], 3);
    expect(outer[0].bbox[3]).toBeCloseTo(720, 3);
    expect(rectOps(content(page))).toBe(0);            // neither border is all four
  });

  it('adjacent cells each paint their own shared edge (no de-duplication)', () => {
    // Documents today's behaviour: the border pass strokes per cell and always
    // has, so row 0's bottom rule and row 1's top rule are two coincident
    // segments on the shared edge. Asserted on the emitted ops, since both land
    // in one path per cell and a bbox cannot tell them apart.
    const { cs, rowHeights } = draw({ width: 0.75, color: [0, 0, 0], sides: { top: true, bottom: true } },
      [['a'], ['b']]);
    const shared = 720 - rowHeights[0];
    const starts = [...cs.matchAll(/([-\d.]+) ([-\d.]+) m/g)].map((m) => +m[2]);
    expect(starts.filter((y) => Math.abs(y - shared) < 1e-3).length).toBe(2);
    expect(starts.length).toBe(4);                     // 2 edges x 2 cells
  });
});

describe('table rendering — per-row and per-cell padding', () => {
  const content = (page: any) => new TextDecoder().decode(page.Contents);

  it('a roomier row insets its text by its own padding, not the table default', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 2 });
    t.addRow(['tight']);
    t.addRow(['roomy'], { padding: 12 });
    const x = 72, top = 720;
    const { rowHeights } = t.measure(t.resolveColumnWidths(200));
    page.AddTable(t, x, top, { width: 200 });
    const frags = page.GetTextFragments();
    const tight = frags.find((f) => f.text.includes('tight'))!;
    const roomy = frags.find((f) => f.text.includes('roomy'))!;
    expect(tight.quad[0]).toBeCloseTo(x + 2, 1);
    expect(roomy.quad[0]).toBeCloseTo(x + 12, 1);
    // Row 1's text sits 12pt below its band top, not 2pt.
    expect(roomy.quad[3]).toBeCloseTo(top - rowHeights[0] - 12, 1);
  });

  it('a per-cell padding insets only that cell', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 2 });
    const r = t.addRow();
    r.addCell('left');
    r.addCell('right', { padding: { left: 20 } });
    const x = 72;
    const widths = t.resolveColumnWidths(200);
    page.AddTable(t, x, 720, { width: 200 });
    const frags = page.GetTextFragments();
    expect(frags.find((f) => f.text.includes('left'))!.quad[0]).toBeCloseTo(x + 2, 1);
    expect(frags.find((f) => f.text.includes('right'))!.quad[0])
      .toBeCloseTo(x + widths[0] + 20, 1);
  });

  it('a per-side padding places the cell image in the padded box', () => {
    const doc = Document.Open(buildBlankPage());
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow().addCell('').setImage(buildPngRgbWith(2, 1, [255, 0, 0, 0, 255, 0], 0),
      { height: 10, align: 'left', valign: 'top' })
      .options;
    t.rows[0].cells[0].options.padding = { left: 15, top: 5, right: 2, bottom: 2 };
    const page = doc.Pages[0];
    page.AddTable(t, 72, 720, { width: 200 });
    const m = content(page).match(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\s*\/Im\d+ Do/)!;
    expect(+m[3]).toBeCloseTo(72 + 15, 1);                 // left inset
  });

  it('an explicit table padding equals the same value spelled on every row', () => {
    const build = (onTable: boolean) => {
      const page = Document.Open(buildBlankPage()).Pages[0];
      const t = createTable({
        font: 'Helvetica', fontSize: 10, leading: 12,
        border: { width: 0.5, color: [0, 0, 0] },
        ...(onTable ? { padding: 7 } : {}),
      });
      t.addRow(['a', 'b'], onTable ? {} : { padding: 7 });
      t.addRow(['c', 'd'], onTable ? {} : { padding: 7 });
      page.AddTable(t, 72, 720, { width: 200 });
      return content(page);
    };
    expect(build(false)).toBe(build(true));
  });

  it('AddTable({ cellPadding }) replaces the table padding but not a row padding', () => {
    const page = Document.Open(buildBlankPage()).Pages[0];
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12, padding: 2 });
    t.addRow(['plain']);
    t.addRow(['fixed'], { padding: 3 });
    page.AddTable(t, 72, 720, { width: 200, cellPadding: 9 });
    const frags = page.GetTextFragments();
    expect(frags.find((f) => f.text.includes('plain'))!.quad[0]).toBeCloseTo(72 + 9, 1);
    expect(frags.find((f) => f.text.includes('fixed'))!.quad[0]).toBeCloseTo(72 + 3, 1);
  });
});
