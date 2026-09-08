import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { createTable } from '../src/tableauthor.js';
import { drawTable } from '../src/tablerender.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

const img = (beforeRun: number, width = 30, height = 40) =>
  ({ beforeRun, data: buildPngRgb(), width, height });

/** A one-row table whose first cell optionally carries atomics. */
const table = (atomics?: unknown) => {
  const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
  const r = t.addRow();
  r.addCell([{ text: 'before ' }, { text: 'after' }], { atomics } as never);
  r.addCell('plain');
  return t;
};

/**
 * Boxes among a table cell's runs (`dsw8`).
 *
 * **The issue that asked for this was filed on a WRONG PREMISE, and the
 * correction is why the change is small.** It claimed a cell's height was
 * `max(1, lineCount) * leading` — a model that could not express a line an
 * image made taller — and that supporting one therefore meant replacing the
 * table height model. That is the stale DOC COMMENT on `measure`; the CODE
 * already sums per-line band heights out of `layoutRuns`, so a taller band is
 * carried for free. These cases pin that it really is carried, since the
 * reasoning that says so was wrong once already.
 */
describe('table cell atomics', () => {
  it('a taller line grows the row', () => {
    // 12pt leading against a 40pt picture: the row must follow the band, not
    // the line count. Both numbers asserted, so a build that merely changed
    // the height cannot pass.
    expect(table().measure([100, 100]).rowHeights[0]).toBe(16);
    expect(table([img(1)]).measure([100, 100]).rowHeights[0]).toBe(52);
  });

  it('draws the picture and keeps the text', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    drawTable(doc, page, table([img(1)]), 50, 700, { width: 200 });
    expect([...cs(page).matchAll(/\/[A-Za-z0-9]+ Do/g)]).toHaveLength(1);
    expect(page.GetText()).toContain('before');
    expect(page.GetText()).toContain('after');
  });

  /**
   * MEASURE AND PAINT SHARE ONE WEAVE, which is `layout.ts`'s
   * `weaveByBeforeRun`. A second copy of the interleaving order is how a cell
   * comes to be sized against one arrangement and drawn with another — so the
   * height the table reserved must be the height the draw consumed.
   */
  it('the row height it measured is the row height it draws', () => {
    const t = table([img(1)]);
    const measured = t.measure([100, 100]).totalHeight;
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { endY } = drawTable(doc, page, t, 50, 700, { width: 200 });
    expect(700 - endY).toBeCloseTo(measured, 6);
  });

  it('auto-fit sizes the column wide enough for the picture', () => {
    // Without the atomic reaching textExtents the column is sized on text
    // alone, and layoutRuns then CLAMPS the image down to fit it — a shrunken
    // picture rather than an overflowing one, which is why this is asserted on
    // the resolved width rather than on the drawn output.
    const narrow = table();
    const wide = table([img(1, 300, 40)]);
    narrow.autoFitColumns();
    wide.autoFitColumns();
    const w0 = narrow.resolveColumnWidths(600)[0];
    const w1 = wide.resolveColumnWidths(600)[0];
    // Measured at +148pt for a 300pt picture, not +300: auto-fit hands every
    // column its need PLUS a share of the slack, so a narrow column is topped
    // up too and the difference is diluted. Without the atomic reaching
    // textExtents the two are EXACTLY equal, which is what this catches.
    expect(w1).toBeGreaterThan(w0 + 100);
  });

  it('rejects a bad atomic before building anything', () => {
    const t = createTable();
    const r = t.addRow();
    expect(() => r.addCell('x', { atomics: [{ beforeRun: -1 }] } as never)).toThrow(TypeError);
    expect(() => r.addCell('x', { atomics: 'nope' } as never)).toThrow(TypeError);
  });

  it('a cell stating none is measured exactly as before', () => {
    // The fence: a plain string cell keeps the pre-existing layoutText path.
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    t.addRow(['one', 'two']);
    expect(t.measure([100, 100]).rowHeights).toEqual([16]);
  });

  /** A cell can carry BOTH: setImage is one picture aspect-fit under the text,
   *  atomics sit in the text. Two features, not two spellings of one. */
  it('coexists with a cell background image', () => {
    const t = createTable({ font: 'Helvetica', fontSize: 10, leading: 12 });
    const r = t.addRow();
    r.addCell([{ text: 'a' }], { atomics: [img(1)] } as never).setImage(buildPngRgb());
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    drawTable(doc, page, t, 50, 700, { width: 200 });
    expect([...cs(page).matchAll(/\/[A-Za-z0-9]+ Do/g)]).toHaveLength(2);
  });
});
