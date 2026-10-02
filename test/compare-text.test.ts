import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { TextChange } from '../src/compare.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';
import { buildOcgRenderPdf } from './helpers/build-ocg-render-pdf.js';

/** One document from pages of lines; each line sits 20pt below the last, at x 20. */
const doc = (...pages: string[][]): Document => Document.Open(buildMultiPageTextPdf(
  pages.map((lines) => lines.map((l, i) => `BT /F1 10 Tf 20 ${260 - 20 * i} Td (${l}) Tj ET`).join('\n')),
));

const shape = (cs: TextChange[]): string[] =>
  cs.map((c) => `${c.op}:${c.op === 'insert' ? c.newText : c.oldText}`);

describe('Document.CompareText', () => {
  it('reports one equal change for identical documents', () => {
    const r = doc(['the quick brown fox']).CompareText(doc(['the quick brown fox']));
    expect(shape(r.changes)).toEqual(['equal:the quick brown fox']);
    expect(r.stats).toEqual({ equal: 4, deleted: 0, inserted: 0, changes: 0, oldTokens: 4, newTokens: 4, similarity: 1 });
    expect(r.minimal).toBe(true);
    expect(r.pages).toBeUndefined();
  });

  it('reports a replaced word as delete then insert', () => {
    const r = doc(['the quick brown fox']).CompareText(doc(['the slow brown fox']));
    expect(shape(r.changes)).toEqual(['equal:the', 'delete:quick', 'insert:slow', 'equal:brown fox']);
    expect(r.stats).toMatchObject({ equal: 3, deleted: 1, inserted: 1, changes: 1 });
    expect(r.stats.similarity).toBeCloseTo(6 / 8);
  });

  it('places each side of a change where Search finds the same word', () => {
    const a = doc(['the quick brown fox']), b = doc(['the slow brown fox']);
    const r = a.CompareText(b);
    const del = r.changes.find((c) => c.op === 'delete')!;
    const ins = r.changes.find((c) => c.op === 'insert')!;
    expect(del.new).toEqual([]);
    expect(ins.old).toEqual([]);
    expect(del.old).toEqual([{ page: 1, text: 'quick', quads: a.Pages[0].Search('quick')[0].quads }]);
    expect(ins.new).toEqual([{ page: 1, text: 'slow', quads: b.Pages[0].Search('slow')[0].quads }]);
  });

  it('gives an equal change a span on each side', () => {
    const r = doc(['alpha beta']).CompareText(doc(['', 'alpha beta']));
    const eq = r.changes[0];
    expect(eq.op).toBe('equal');
    expect(eq.old[0].quads[0][1]).toBeGreaterThan(eq.new[0].quads[0][1]); // moved down a line
  });

  it('splits a change that runs over two lines into one quad per line', () => {
    const r = doc(['keep one two', 'three keep']).CompareText(doc(['keep keep']));
    expect(shape(r.changes)).toEqual(['equal:keep', 'delete:one two three', 'equal:keep']);
    const del = r.changes[1];
    expect(del.old).toHaveLength(1);
    expect(del.old[0].quads).toHaveLength(2);
  });

  describe('document mode', () => {
    it('reads across page breaks, so text that moves to the next page is unchanged', () => {
      const r = doc(['one two three'], ['four']).CompareText(doc(['one two'], ['three four']));
      expect(shape(r.changes)).toEqual(['equal:one two three four']);
    });

    it('gives a change spanning a page break one span per page', () => {
      const r = doc(['keep gone'], ['also gone keep']).CompareText(doc(['keep'], ['keep']));
      const del = r.changes.find((c) => c.op === 'delete')!;
      expect(del.oldText).toBe('gone also gone');
      expect(del.old.map((s) => [s.page, s.text])).toEqual([[1, 'gone'], [2, 'also gone']]);
    });
  });

  describe('pages mode', () => {
    it('compares page with page, so text that moves between pages is a change on each', () => {
      const r = doc(['one two three'], ['four']).CompareText(doc(['one two'], ['three four']), { mode: 'pages' });
      expect(r.pages!.map((p) => [p.oldPage, p.newPage, shape(p.changes)])).toEqual([
        [1, 1, ['equal:one two', 'delete:three']],
        [2, 2, ['insert:three', 'equal:four']],
      ]);
      expect(shape(r.changes)).toEqual(['equal:one two', 'delete:three', 'insert:three', 'equal:four']);
      expect(r.stats).toMatchObject({ equal: 3, deleted: 1, inserted: 1, changes: 2, oldTokens: 4, newTokens: 4 });
    });

    it('reports a page only one document has as wholly inserted or deleted', () => {
      const r = doc(['same']).CompareText(doc(['same'], ['extra page']), { mode: 'pages' });
      expect(r.pages!.map((p) => [p.oldPage, p.newPage, shape(p.changes)])).toEqual([
        [1, 1, ['equal:same']],
        [undefined, 2, ['insert:extra page']],
      ]);
      const back = doc(['same'], ['extra page']).CompareText(doc(['same']), { mode: 'pages' });
      expect(back.pages![1]).toMatchObject({ oldPage: 2, newPage: undefined });
      expect(shape(back.pages![1].changes)).toEqual(['delete:extra page']);
    });
  });

  it('ignores case when asked, reporting each side as written', () => {
    const r = doc(['Hello World']).CompareText(doc(['hello world']), { ignoreCase: true });
    expect(r.changes.map((c) => [c.op, c.oldText, c.newText])).toEqual([['equal', 'Hello World', 'hello world']]);
    expect(shape(doc(['Hello']).CompareText(doc(['hello'])).changes)).toEqual(['delete:Hello', 'insert:hello']);
  });

  describe('regions', () => {
    // line 0 at y 260, line 1 at y 240
    const a = () => doc(['top same', 'bottom old']);
    const b = () => doc(['top same', 'bottom new']);

    it('compares only what lies inside region', () => {
      const r = a().CompareText(b(), { region: [0, 250, 300, 300] });
      expect(shape(r.changes)).toEqual(['equal:top same']);
    });

    it('skips what lies inside an exclusion area', () => {
      const r = a().CompareText(b(), { exclude: [[0, 230, 300, 249]] });
      expect(shape(r.changes)).toEqual(['equal:top same']);
      const all = a().CompareText(b());
      expect(shape(all.changes)).toEqual(['equal:top same bottom', 'delete:old', 'insert:new']);
    });
  });

  describe('character granularity', () => {
    it('reports the characters that changed inside a word', () => {
      const r = doc(['colour']).CompareText(doc(['color']), { granularity: 'character' });
      expect(shape(r.changes)).toEqual(['equal:colo', 'delete:u', 'equal:r']);
      expect(r.changes[1].old[0].quads).toEqual(doc(['colour']).Pages[0].Search('u')[0].quads);
    });

    it('collapses whitespace by default, so a reflowed line break is no change', () => {
      const r = doc(['ab cd']).CompareText(doc(['ab', 'cd']), { granularity: 'character' });
      expect(shape(r.changes)).toEqual(['equal:ab cd']);
    });

    it('treats whitespace as a character to compare unless ignored', () => {
      const a = doc(['data base']), b = doc(['database']);
      expect(shape(a.CompareText(b, { granularity: 'character' }).changes))
        .toEqual(['equal:data', 'delete: ', 'equal:base']);
      expect(shape(a.CompareText(b, { granularity: 'character', whitespace: 'ignore' }).changes))
        .toEqual(['equal:database']);
    });

    it('treats a page break as whitespace in document mode', () => {
      const r = doc(['ab'], ['cd']).CompareText(doc(['ab cd']), { granularity: 'character' });
      expect(shape(r.changes)).toEqual(['equal:ab cd']);
    });
  });

  it('compares what the pages show, and hidden layers too under includeHidden', () => {
    const shown = 'BT /F1 12 Tf 20 150 Td (shownword) Tj ET\n';
    const hidden = Document.Open(buildOcgRenderPdf(`${shown}/OC /OCHid BDC\nBT /F1 12 Tf 20 100 Td (hiddenword) Tj ET\nEMC\n`));
    const plain = Document.Open(buildOcgRenderPdf(shown));
    expect(shape(hidden.CompareText(plain).changes)).toEqual(['equal:shownword']);
    expect(shape(hidden.CompareText(plain, { includeHidden: true }).changes))
      .toEqual(['equal:shownword', 'delete:hiddenword']);
  });

  it('reports the insertion first when asked', () => {
    const r = doc(['the quick fox']).CompareText(doc(['the slow fox']), { order: 'insert-first' });
    expect(shape(r.changes)).toEqual(['equal:the', 'insert:slow', 'delete:quick', 'equal:fox']);
  });

  it('reports pages mode as not minimal when any page was cut short', () => {
    const r = doc(['same'], ['a b c d e f g h']).CompareText(doc(['same'], ['h g f e d c b a']), { mode: 'pages', maxCost: 1 });
    expect(r.pages!.map((p) => p.minimal)).toEqual([true, false]);
    expect(r.minimal).toBe(false);
  });

  it('reports a cut-short search as not minimal, still reassembling both sides', () => {
    const a = doc(['a b c d e f g h']), b = doc(['h g f e d c b a']);
    const r = a.CompareText(b, { maxCost: 1 });
    expect(r.minimal).toBe(false);
    const side = (k: 'oldText' | 'newText', skip: string) =>
      r.changes.filter((c) => c.op !== skip).map((c) => c[k]).join(' ');
    expect(side('oldText', 'insert')).toBe('a b c d e f g h');
    expect(side('newText', 'delete')).toBe('h g f e d c b a');
  });

  describe('refuses bad options before doing any work', () => {
    const a = doc(['x']);
    it.each([
      [{ mode: 'chapters' }, RangeError],
      [{ granularity: 'line' }, RangeError],
      [{ whitespace: 'ignore' }, RangeError],               // word granularity has no whitespace to choose
      [{ granularity: 'character', whitespace: 'keep' }, RangeError],
      [{ order: 'random' }, RangeError],
      [{ region: [0, 0, 1] }, TypeError],
      [{ region: [0, 0, 1, Number.NaN] }, TypeError],
      [{ exclude: [0, 0, 1, 1] }, TypeError],                // a rect, not a list of rects
      [{ maxCost: 0 }, RangeError],
      [{ maxCost: 1.5 }, RangeError],
    ] as [object, ErrorConstructor][])('%j', (opts, E) => {
      expect(() => a.CompareText(doc(['x']), opts as never)).toThrow(E);
    });

    it('refuses something that is not a Document', () => {
      expect(() => a.CompareText({} as never)).toThrow(/other must be a Document/);
      expect(() => a.CompareText(null as never)).toThrow(/other must be a Document/);
    });
  });
});
