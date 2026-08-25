import { describe, it, expect } from 'vitest';
import { Document, LinkAnnotation, type AddTOCResult } from '../src/index.js';
import type { Page } from '../src/page.js';
import { measureTOC } from '../src/toc.js';
import { measureText } from '../src/stamp.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPageLabelsPdf } from './helpers/build-pagelabels-pdf.js';

/** A letter-size document with `n` pages; page 1 is the TOC page. */
function docWith(n: number): Document {
  const doc = Document.Open(buildBlankPage());
  while (doc.Pages.length < n) doc.AddPage();
  return doc;
}

const RECT: [number, number, number, number] = [72, 400, 400, 300];

/** The stamped runs in content order: each `stampText` emits exactly one
 *  `1 0 0 1 tx ty Tm` + `(text) Tj` pair, so this reads back what was drawn and
 *  where. `GetTextFragments` cannot be used for placement here: stamp.ts writes
 *  Standard-14 font dicts with no /Widths (viewers use the built-in AFM
 *  metrics), and font.ts then estimates every glyph at 0.5em — which both
 *  overshoots a dot leader's end by ~2.7pt per dot and merges neighbouring runs
 *  whatever `leaderGap` is. */
function runs(page: Page): { text: string; x: number; y: number }[] {
  const content = new TextDecoder('latin1').decode(page.Contents);
  const out: { text: string; x: number; y: number }[] = [];
  const re = /1 0 0 1 (-?[\d.]+) (-?[\d.]+) Tm\s*\(([^)]*)\) Tj/g;
  for (let m = re.exec(content); m; m = re.exec(content))
    out.push({ x: Number(m[1]), y: Number(m[2]), text: m[3] });
  return out;
}

/** Right edge of a drawn run, from the same AFM metrics the drawing used. */
const runEnd = (r: { text: string; x: number }, fontSize: number) =>
  r.x + measureText(r.text, fontSize, 'Helvetica');

describe('TOC measurement — measureTOC', () => {
  it('sizes the number column over every entry, not just the widest title', () => {
    const doc = docWith(120);
    const L = measureTOC(doc, [{ title: 'One', page: 1 }, { title: 'Two', page: 120 }], RECT,
      { fontSize: 12 });
    const widest = measureText('120', 12, 'Helvetica');
    expect(L.rowRight).toBeCloseTo(472, 6);
    expect(L.numberLeft).toBeCloseTo(472 - widest, 6);
  });

  it('indents by level and narrows that row\'s title column', () => {
    const doc = docWith(2);
    const L = measureTOC(doc, [
      { title: 'Top', page: 1 },
      { title: 'Nested', page: 2, level: 3 },
    ], RECT, { fontSize: 12, indent: 20 });
    expect(L.rows[0].titleLeft).toBeCloseTo(72, 6);
    expect(L.rows[1].titleLeft).toBeCloseTo(72 + 40, 6);
  });

  it('a row\'s leading follows its own fontSize unless the call sets one', () => {
    const doc = docWith(1);
    const entries = [
      { title: 'Big', page: 1, style: { fontSize: 20 } },
      { title: 'Small', page: 1 },
    ];
    const auto = measureTOC(doc, entries, RECT, { fontSize: 10 });
    expect(auto.rows[0].height).toBeCloseTo(24, 6);   // 1.2 * 20
    expect(auto.rows[1].height).toBeCloseTo(12, 6);   // 1.2 * 10
    const fixed = measureTOC(doc, entries, RECT, { fontSize: 10, leading: 15 });
    expect(fixed.rows[0].height).toBeCloseTo(15, 6);
    expect(fixed.rows[1].height).toBeCloseTo(15, 6);
  });

  it('an empty title still occupies exactly one line', () => {
    const doc = docWith(1);
    const L = measureTOC(doc, [{ title: '', page: 1 }], RECT, { fontSize: 12 });
    expect(L.rows[0].lines).toEqual([]);
    expect(L.rows[0].height).toBeCloseTo(14.4, 6);    // max(0, 1) * 1.2 * 12
  });

  it('defaults the label to the logical page label, else the page number', () => {
    const labelled = Document.Open(buildPageLabelsPdf());     // pages 1-3 roman
    const L = measureTOC(labelled, [{ title: 'Preface', page: 3 }], RECT, { fontSize: 12 });
    expect(L.rows[0].label).toBe('iii');
    const plain = docWith(3);
    expect(measureTOC(plain, [{ title: 'Ch', page: 3 }], RECT, { fontSize: 12 }).rows[0].label)
      .toBe('3');
    expect(measureTOC(plain, [{ title: 'Ch', page: 3, label: 'A-1' }], RECT, { fontSize: 12 })
      .rows[0].label).toBe('A-1');
  });

  it('rejects bad input before producing any layout', () => {
    const doc = docWith(2);
    const ok = [{ title: 'Ch', page: 1 }];
    expect(() => measureTOC(doc, ok, [72, 400, 0, 300])).toThrow(TypeError);
    expect(() => measureTOC(doc, [{ title: 'Ch', page: 9 }], RECT)).toThrow(RangeError);
    expect(() => measureTOC(doc, [{ title: 'Ch', page: 0 }], RECT)).toThrow(RangeError);
    expect(() => measureTOC(doc, [{ title: 42 as unknown as string, page: 1 }], RECT))
      .toThrow(TypeError);
    expect(() => measureTOC(doc, [{ title: 'Ch', page: 1, level: 0 }], RECT)).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { rowGap: -1 })).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { leader: 'dashes' as 'dots' })).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { fontSize: -3 })).toThrow(TypeError);
    expect(() => measureTOC(doc, ok, RECT, { font: 'Comic Sans' as 'Helvetica' })).toThrow(TypeError);
  });

  it('rejects a box too narrow to hold the title column at that level', () => {
    const doc = docWith(1);
    expect(() => measureTOC(doc, [{ title: 'Deep', page: 1, level: 5 }], [72, 400, 60, 300],
      { fontSize: 12, indent: 20 })).toThrow(RangeError);
  });
});

describe('TOC rendering — page.AddTOC', () => {
  it('places the title at the box left and the label flush right on one baseline', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Introduction', page: 3 }], RECT, { fontSize: 12, leaderGap: 10 });
    const drawn = runs(page);
    const title = drawn.find((r) => r.text === 'Introduction')!;
    const label = drawn.find((r) => r.text === '3')!;
    const baseline = 400 + 300 - 12;                 // boxTop - fontSize
    expect(title.x).toBeCloseTo(72, 3);
    expect(title.y).toBeCloseTo(baseline, 3);
    expect(runEnd(label, 12)).toBeCloseTo(472, 3);   // right-flush at x + w
    expect(label.y).toBeCloseTo(baseline, 3);
  });

  it('dot leaders from titles of different lengths end at the same x', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([
      { title: 'Short', page: 1 },
      { title: 'A considerably longer chapter title', page: 2 },
    ], RECT, { fontSize: 12, leaderGap: 10 });
    const dots = runs(page).filter((r) => /^\.+$/.test(r.text));
    expect(dots).toHaveLength(2);
    expect(runEnd(dots[0], 12)).toBeCloseTo(runEnd(dots[1], 12), 1);
    expect(dots[0].text.length).not.toBe(dots[1].text.length);
  });

  it('draws no leader when the gap is narrower than one dot, or when leader is none', () => {
    const fontSize = 12, leaderGap = 4;
    const w = measureText('Chapter', fontSize, 'Helvetica') + leaderGap * 2
      + measureText('1', fontSize, 'Helvetica');
    const tight = docWith(1).Pages[0];
    tight.AddTOC([{ title: 'Chapter', page: 1 }], [72, 400, w, 300], { fontSize, leaderGap });
    expect(runs(tight).some((r) => r.text.includes('.'))).toBe(false);

    const off = docWith(1).Pages[0];
    off.AddTOC([{ title: 'Chapter', page: 1 }], RECT, { fontSize, leader: 'none' });
    expect(runs(off).some((r) => r.text.includes('.'))).toBe(false);
  });

  it('a wrapped title makes the row taller and keeps the label on its last line', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const long = 'A chapter title long enough to need two lines in this narrow box';
    page.AddTOC([{ title: long, page: 1 }, { title: 'Next', page: 1 }],
      [72, 400, 200, 300], { fontSize: 10, leaderGap: 8 });
    const drawn = runs(page);
    const leading = 12;                              // 1.2 * 10
    const firstBaseline = 400 + 300 - 10;
    const next = drawn.find((r) => r.text === 'Next')!;
    // Two title lines were drawn, so the following row starts two leadings down.
    expect(next.y).toBeCloseTo(firstBaseline - 2 * leading, 3);
    // Both labels sit on their row's LAST line.
    const labels = drawn.filter((r) => r.text === '1');
    expect(labels.some((r) => Math.abs(r.y - (firstBaseline - leading)) < 0.01)).toBe(true);
  });

  it('indents a nested row by (level - 1) * indent', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Nested', page: 1, level: 2 }], RECT,
      { fontSize: 12, indent: 20, leaderGap: 10 });
    const title = runs(page).find((r) => r.text === 'Nested')!;
    expect(title.x).toBeCloseTo(92, 3);
  });

  it('returns the rows that did not fit as a remainder of the caller\'s own objects', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const entries = [
      { title: 'One', page: 1 }, { title: 'Two', page: 2 }, { title: 'Three', page: 3 },
    ];
    const leading = 14.4;                            // 1.2 * 12
    const r: AddTOCResult = page.AddTOC(entries, [72, 700, 400, leading * 2], { fontSize: 12 });
    expect(r.drawn).toBe(2);
    expect(r.pages).toEqual([page]);
    expect(r.remainder).toHaveLength(1);
    expect(r.remainder![0]).toBe(entries[2]);        // same object: re-callable as-is
    expect(r.endY).toBeCloseTo(700, 3);              // bottom of the last drawn row
    expect(runs(page).some((r2) => r2.text.includes('Three'))).toBe(false);
  });

  it('draws a row taller than the whole box exactly once rather than looping', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const long = 'word '.repeat(40).trim();
    const r = page.AddTOC([{ title: long, page: 1 }, { title: 'After', page: 1 }],
      [72, 400, 200, 20], { fontSize: 10 });
    expect(r.drawn).toBe(1);
    expect(r.remainder).toHaveLength(1);
    expect(runs(page).some((r2) => r2.text.includes('word'))).toBe(true);
  });

  it('an empty entry list draws nothing', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const r = page.AddTOC([], RECT);
    expect(r).toEqual({ pages: [page], drawn: 0, endY: 700 });
    expect(page.GetTextFragments()).toEqual([]);
  });
});

describe('TOC links', () => {
  it('adds one borderless GoTo link per row, covering all its lines', () => {
    const doc = docWith(4);
    const page = doc.Pages[0];
    const long = 'A chapter title long enough to need two lines in this narrow box';
    page.AddTOC([{ title: long, page: 4 }], [72, 400, 200, 300], { fontSize: 10 });
    const links = page.Annotations.filter((a) => a.Subtype === 'Link') as LinkAnnotation[];
    expect(links).toHaveLength(1);
    expect(links[0].Action).toEqual({ type: 'goto', page: 4, view: { type: 'Fit' } });
    const [llx, lly, urx, ury] = links[0].Rect!;
    expect(llx).toBeCloseTo(72, 3);
    expect(urx).toBeCloseTo(272, 3);
    expect(ury).toBeCloseTo(700, 3);                 // box top
    expect(ury - lly).toBeCloseTo(24, 3);            // two lines * 1.2 * 10
    expect(links[0].Dict.get('Border')).toEqual([0, 0, 0]);
  });

  it('starts the link at the indent, not the box edge', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Nested', page: 2, level: 2 }], RECT, { fontSize: 12, indent: 20 });
    const link = page.Annotations.find((a) => a.Subtype === 'Link') as LinkAnnotation;
    expect(link.Rect![0]).toBeCloseTo(92, 3);
  });

  it('honors an explicit destination view', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Ch', page: 2 }], RECT, { view: { type: 'XYZ', left: 0, top: 792, zoom: null } });
    const link = page.Annotations.find((a) => a.Subtype === 'Link') as LinkAnnotation;
    expect(link.Action).toEqual({ type: 'goto', page: 2, view: { type: 'XYZ', left: 0, top: 792, zoom: null } });
  });

  it('adds no annotations at all with links: false', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    page.AddTOC([{ title: 'Ch', page: 2 }], RECT, { links: false });
    expect(page.Annotations).toEqual([]);
    expect(runs(page).length).toBeGreaterThan(0);   // still drawn
  });

  it('links only the rows that were actually drawn', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const entries = [
      { title: 'One', page: 1 }, { title: 'Two', page: 2 }, { title: 'Three', page: 3 },
    ];
    page.AddTOC(entries, [72, 700, 400, 14.4 * 2], { fontSize: 12 });
    expect(page.Annotations.filter((a) => a.Subtype === 'Link')).toHaveLength(2);
  });
});

describe('TOC pagination — autoPaginate', () => {
  it('appends pages sized to the anchor and draws every entry', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const entries = Array.from({ length: 5 }, (_, i) => ({ title: `Chapter ${i + 1}`, page: 1 }));
    const leading = 14.4;                            // 1.2 * 12
    const r = page.AddTOC(entries, [72, 700, 400, leading * 2], {
      fontSize: 12, autoPaginate: true,
    });
    expect(r.drawn).toBe(5);
    expect(r.remainder).toBeUndefined();
    expect(r.pages).toHaveLength(3);                 // 2 + 2 + 1
    expect(r.pages[0]).toBe(page);
    for (const p of r.pages) expect(p.MediaBox).toEqual([0, 0, 612, 792]);
    expect(runs(r.pages[1]).some((x) => x.text.includes('Chapter 3'))).toBe(true);
    expect(runs(r.pages[2]).some((x) => x.text.includes('Chapter 5'))).toBe(true);
    expect(r.endY).toBeCloseTo(700 + leading * 2 - leading, 3);  // one row on the last page
  });

  it('keeps the number column at the same x on every page', () => {
    const doc = docWith(200);
    const page = doc.Pages[0];
    const entries = [
      { title: 'First', page: 1 }, { title: 'Second', page: 2 }, { title: 'Third', page: 200 },
    ];
    const r = page.AddTOC(entries, [72, 700, 400, 14.4], { fontSize: 12, autoPaginate: true });
    expect(r.pages).toHaveLength(3);
    const rightEdge = (p: Page, text: string) =>
      runEnd(runs(p).find((x) => x.text === text)!, 12);
    // The '200' label is the widest, so it sets the column for pages 1 and 2 too.
    expect(rightEdge(r.pages[0], '1')).toBeCloseTo(rightEdge(r.pages[2], '200'), 1);
  });

  it('links on a continuation page point at the right target', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const r = page.AddTOC([{ title: 'A', page: 2 }, { title: 'B', page: 3 }],
      [72, 700, 400, 14.4], { fontSize: 12, autoPaginate: true });
    const link = r.pages[1].Annotations.find((a) => a.Subtype === 'Link') as LinkAnnotation;
    expect(link.Action).toEqual({ type: 'goto', page: 3, view: { type: 'Fit' } });
  });

  it('terminates when a row is taller than a whole page box', () => {
    const doc = docWith(1);
    const page = doc.Pages[0];
    const long = 'word '.repeat(40).trim();
    const r = page.AddTOC([{ title: long, page: 1 }, { title: long, page: 1 }],
      [72, 400, 200, 20], { fontSize: 10, autoPaginate: true });
    expect(r.drawn).toBe(2);
    expect(r.pages).toHaveLength(2);                 // one over-tall row per page
  });
});

describe('TOC atomicity', () => {
  it('leaves the document byte-identical when a call is rejected', () => {
    const doc = docWith(3);
    const page = doc.Pages[0];
    const before = doc.Save();
    const bad: [() => unknown, ErrorConstructor][] = [
      [() => page.AddTOC([{ title: 'Ch', page: 99 }], RECT), RangeError],
      [() => page.AddTOC([{ title: 'A', page: 1 }, { title: 'B', page: 0 }], RECT), RangeError],
      [() => page.AddTOC([{ title: 'Deep', page: 1, level: 9 }], [72, 400, 60, 300]), RangeError],
      [() => page.AddTOC([{ title: 'Ch', page: 1 }], RECT, { fontSize: 0 }), TypeError],
      [() => page.AddTOC([{ title: 'Ch', page: 1 }], RECT, { leaderGap: -2 }), TypeError],
    ];
    for (const [call, err] of bad) {
      expect(call).toThrow(err);
      expect(doc.Save()).toEqual(before);
      expect(page.Annotations).toEqual([]);
      expect(runs(page)).toEqual([]);
    }
  });

  it('a second entry rejected after a valid first draws nothing at all', () => {
    const doc = docWith(2);
    const page = doc.Pages[0];
    expect(() => page.AddTOC(
      [{ title: 'Valid', page: 1 }, { title: 'Bad', page: 77 }], RECT)).toThrow(RangeError);
    expect(runs(page)).toEqual([]);
  });
});
