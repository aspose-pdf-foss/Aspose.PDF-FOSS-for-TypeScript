import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { MarkupAnnotation } from '../src/annotation.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';

const doc = (...pages: string[][]): Document => Document.Open(buildMultiPageTextPdf(
  pages.map((lines) => lines.map((l, i) => `BT /F1 10 Tf 20 ${260 - 20 * i} Td (${l}) Tj ET`).join('\n')),
));
const highlights = (d: Document, page = 0): MarkupAnnotation[] =>
  d.Pages[page].Annotations.filter((a): a is MarkupAnnotation => a.Subtype === 'Highlight');
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('Document.CompareSideBySide', () => {
  it('sets each page pair side by side on one sheet, separated by the gap', () => {
    const { document: out } = doc(['the quick brown fox']).CompareSideBySide(doc(['the slow brown fox']));
    expect(out.Pages).toHaveLength(1);
    expect(out.Pages[0].MediaBox).toEqual([0, 0, 620, 300]);
    const text = out.Pages[0].GetText();
    expect(text).toContain('quick');
    expect(text).toContain('slow');
  });

  it('returns the comparison it marked', () => {
    const a = doc(['the quick brown fox']), b = doc(['the slow brown fox']);
    const { comparison } = a.CompareSideBySide(b);
    expect(comparison.changes.map((c) => c.op)).toEqual(['equal', 'delete', 'insert', 'equal']);
    expect(comparison.stats).toEqual(a.CompareText(b).stats);
  });

  it('highlights a deletion on the left and an insertion on the right, over the words themselves', () => {
    const { document: out } = doc(['the quick brown fox']).CompareSideBySide(doc(['the slow brown fox']));
    const [del, ins] = highlights(out);
    expect(del.Contents).toBe('Deleted: quick');
    expect(ins.Contents).toBe('Inserted: slow');
    // Search on the RESULT sheet finds each word through the placed form's own
    // transform, so it checks the mark against something the mark did not compute.
    close(del.Rect!, out.Pages[0].Search('quick')[0].quads[0]);
    close(ins.Rect!, out.Pages[0].Search('slow')[0].quads[0]);
    expect(ins.Rect![0]).toBeGreaterThan(320);   // right half
    expect(del.Rect![2]).toBeLessThan(300);      // left half
    expect(del.Color).toEqual([1, 0.55, 0.55]);
    expect(ins.Color).toEqual([0.45, 0.85, 0.45]);
  });

  it('marks a change that runs over two lines with one quad per line', () => {
    const { document: out } = doc(['keep one two', 'three keep']).CompareSideBySide(doc(['keep keep']));
    const [del] = highlights(out);
    expect(del.QuadPoints).toHaveLength(16);
  });

  it('follows the page a span is on, in document mode', () => {
    const { document: out } = doc(['keep'], ['gone keep']).CompareSideBySide(doc(['keep'], ['keep']));
    expect(highlights(out, 0)).toHaveLength(0);
    expect(highlights(out, 1).map((h) => h.Contents)).toEqual(['Deleted: gone']);
  });

  it('moves a mark by its own sheet placement, not the first sheet placement', () => {
    // The OTHER page on sheet 2 is taller, so the left page sits 100pt lower
    // there than on sheet 1: the two sheets place their left pages differently.
    const b = doc(['keep'], ['keep']);
    b.Pages[1].Dict.set('MediaBox', [0, 0, 300, 400]);
    const { document: out } = doc(['keep'], ['gone keep']).CompareSideBySide(b);
    const [del] = highlights(out, 1);
    close(del.Rect!, out.Pages[1].Search('gone')[0].quads[0]);
  });

  it('places a rotated, cropped page by the same transform as its marks', () => {
    const a = doc(['the quick brown fox']), b = doc(['the slow brown fox']);
    for (const d of [a, b]) {
      d.Pages[0].Rotate = 90;
      d.Pages[0].Dict.set('CropBox', [10, 150, 280, 290]);
    }
    const { document: out } = a.CompareSideBySide(b);
    // upright: 140 wide, 270 tall each
    expect(out.Pages[0].MediaBox).toEqual([0, 0, 300, 270]);
    // Search cannot be the oracle here: on rotated text its quad is the pen span
    // plus the font size, not a bounding box (measured: zero-width). So the
    // expected boxes are derived by hand. The 90° import maps (x, y) to
    // (290 - y, x - 10) for this CropBox; 'quick' spans x 36.68..60.02 and
    // 'slow' x 36.68..56.68 (Helvetica advances), baseline 260 at 10pt; the
    // right page is offset by 140 + 20.
    const [del, ins] = highlights(out);
    close(del.Rect!, [20, 26.68, 30, 50.02]);
    close(ins.Rect!, [180, 26.68, 190, 46.68]);
  });

  it('aligns the tops of two pages of different height', () => {
    const a = doc(['the quick fox']);
    a.Pages[0].Dict.set('MediaBox', [0, 0, 300, 400]);
    a.Pages[0].Dict.delete('CropBox');
    const b = doc(['the slow fox']);
    const { document: out } = a.CompareSideBySide(b);
    expect(out.Pages[0].MediaBox).toEqual([0, 0, 620, 400]);
    const [del, ins] = highlights(out);
    close(del.Rect!, out.Pages[0].Search('quick')[0].quads[0]);
    close(ins.Rect!, out.Pages[0].Search('slow')[0].quads[0]);
    // b's text sits 40pt below the top of its 300pt page, on a 400pt sheet
    expect(ins.Rect![3]).toBeGreaterThan(350);
  });

  it('leaves the half of a page only one document has empty', () => {
    const { document: out } = doc(['same']).CompareSideBySide(doc(['same'], ['extra page']));
    expect(out.Pages).toHaveLength(2);
    expect(out.Pages[1].MediaBox).toEqual([0, 0, 620, 300]);
    const marks = highlights(out, 1);
    expect(marks.map((m) => m.Contents)).toEqual(['Inserted: extra page']);
    expect(marks[0].Rect![0]).toBeGreaterThan(320);
    expect(out.Pages[1].Search('extra')[0].quads[0][0]).toBeGreaterThan(320);
  });

  it('keeps the right half width when only the first document has the page', () => {
    const { document: out } = doc(['same'], ['extra page']).CompareSideBySide(doc(['same']));
    expect(out.Pages[1].MediaBox).toEqual([0, 0, 620, 300]);
    const marks = highlights(out, 1);
    expect(marks.map((m) => m.Contents)).toEqual(['Deleted: extra page']);
    expect(marks[0].Rect![2]).toBeLessThan(300);
  });

  it('draws the marks into the page content instead, when asked', () => {
    const { document: out } = doc(['the quick brown fox']).CompareSideBySide(doc(['the slow brown fox']), { marks: 'content' });
    expect(out.Pages[0].Annotations).toHaveLength(0);
    const fills = out.Pages[0].GetPaths().filter((p) => p.fill !== undefined);
    expect(fills).toHaveLength(2);
    close(fills[0].bbox, out.Pages[0].Search('quick')[0].quads[0]);
    close(fills[1].bbox, out.Pages[0].Search('slow')[0].quads[0]);
  });

  it('takes colours, a gap and comparison options', () => {
    const a = doc(['Hello there']), b = doc(['hello here']);
    const { document: out } = a.CompareSideBySide(b, {
      gap: 0, deleteColor: [0, 0, 1], insertColor: [1, 1, 0], compare: { ignoreCase: true },
    });
    expect(out.Pages[0].MediaBox).toEqual([0, 0, 600, 300]);
    expect(highlights(out).map((h) => [h.Contents, h.Color])).toEqual([
      ['Deleted: there', [0, 0, 1]], ['Inserted: here', [1, 1, 0]],
    ]);
  });

  it('leaves both documents unchanged and writes a file that reopens', () => {
    const a = doc(['the quick fox']), b = doc(['the slow fox']);
    const before = [a.Save(), b.Save()];
    const { document: out } = a.CompareSideBySide(b);
    expect(a.Save()).toEqual(before[0]);
    expect(b.Save()).toEqual(before[1]);
    const again = Document.Open(out.Save());
    expect(again.Pages[0].GetText()).toContain('slow');
    expect(highlights(again)).toHaveLength(2);
  });

  describe('refuses bad options before building anything', () => {
    const a = doc(['x']);
    it.each([
      [{ gap: -1 }, RangeError], [{ gap: Number.NaN }, RangeError],
      [{ marks: 'ink' }, RangeError],
      [{ deleteColor: [1, 0] }, TypeError], [{ insertColor: [0, 2, 0] }, TypeError],
      [{ compare: { mode: 'chapters' } }, RangeError],
    ] as [object, ErrorConstructor][])('%j', (o, E) => {
      expect(() => a.CompareSideBySide(doc(['x']), o as never)).toThrow(E);
    });
  });

  it('refuses two documents with no pages between them', () => {
    const empty = doc();
    expect(() => empty.CompareSideBySide(doc())).toThrow(RangeError);
  });
});
