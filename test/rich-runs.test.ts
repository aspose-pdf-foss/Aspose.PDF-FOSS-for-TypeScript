import { describe, it, expect } from 'vitest';
import { isTextRunList, type TextRun } from '../src/textdecor.js';

describe('isTextRunList', () => {
  it('distinguishes a run list from a string', () => {
    expect(isTextRunList('hello')).toBe(false);
    expect(isTextRunList([{ text: 'hello' }])).toBe(true);
    expect(isTextRunList([])).toBe(true);
  });

  it('narrows the type for a caller', () => {
    const v: string | TextRun[] = [{ text: 'a', fontSize: 9 }];
    expect(isTextRunList(v) ? v[0].fontSize : 0).toBe(9);
  });
});

import { measureTextBlock } from '../src/stamp.js';
import { Document } from '../src/document.js';
import { buildUnicodeTtf } from './helpers/build-sfnt.js';

describe('measureTextBlock with runs', () => {
  it('agrees with the string form for a single run', () => {
    const a = measureTextBlock('one two three four', 60, 100, { fontSize: 10 });
    const b = measureTextBlock([{ text: 'one two three four' }], 60, 100, { fontSize: 10 });
    expect(b.usedHeight).toBe(a.usedHeight);
  });

  it('returns a run-list remainder, preserving each run style', () => {
    const r = measureTextBlock(
      [{ text: 'alpha beta ' }, { text: 'gamma delta', font: 'Helvetica-Bold' }],
      40, 12, { fontSize: 10 },
    );
    expect(Array.isArray(r.remainder)).toBe(true);
    const rest = r.remainder as TextRun[];
    expect(rest.some((x) => x.font === 'Helvetica-Bold')).toBe(true);
  });

  it('a larger run takes more width, so it wraps sooner', () => {
    const small = measureTextBlock([{ text: 'aaaa bbbb cccc' }], 100, 500, { fontSize: 10 });
    const big = measureTextBlock(
      [{ text: 'aaaa ' }, { text: 'bbbb cccc', fontSize: 30 }], 100, 500, { fontSize: 10 });
    expect(big.usedHeight).toBeGreaterThan(small.usedHeight);
  });

  // The documented limitation: leading is block-level, so a 30pt run inside a
  // 10pt paragraph still advances one 12pt line and can collide with the line
  // above. usedHeight is always a whole number of block leadings.
  it('keeps leading block-level regardless of run sizes', () => {
    const r = measureTextBlock(
      [{ text: 'aaaa ' }, { text: 'bbbb cccc', fontSize: 30 }], 100, 500,
      { fontSize: 10, leading: 12 });
    expect(r.usedHeight % 12).toBeCloseTo(0, 9);
  });

  it('validates every run before doing anything', () => {
    expect(() => measureTextBlock([{ text: 'a' }, { text: 'b', fontSize: -1 }], 100, 100))
      .toThrow(/fontSize/);
    expect(() => measureTextBlock([{ text: 'a', color: [2, 0, 0] }], 100, 100))
      .toThrow(/color/);
    expect(() => measureTextBlock([{ text: 'a', underline: { thickness: -1 } }], 100, 100))
      .toThrow(/thickness/);
  });

  it('rejects shaping with runs rather than silently ignoring it', () => {
    const doc = Document.New();
    const font = doc.AddFont(buildUnicodeTtf());
    expect(() => measureTextBlock([{ text: 'a' }], 100, 100, { font, shape: true }))
      .toThrow(/shap/i);
  });
});

import { PageFormat } from '../src/pageformat.js';
import { stampTextBlock, measureText, type TextBlockOptions } from '../src/stamp.js';

const body = (page: import('../src/page.js').Page): string =>
  new TextDecoder('latin1').decode(page.Contents);

/** Draw a run list onto a fresh page and hand the page back. `withFont` builds
 *  the list when it needs the Document (to embed a font). */
function drawRuns(
  runs: TextRun[], rect: [number, number, number, number],
  options: TextBlockOptions = {},
  withFont?: (d: Document) => TextRun[],
) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const list = withFont ? withFont(doc) : runs;
  const rest = stampTextBlock(doc, page, list, rect, options);
  return { page, rest };
}

describe('rich run emission', () => {
  it('switches Tf between runs of different fonts', () => {
    const { page } = drawRuns(
      [{ text: 'plain ' }, { text: 'bold', font: 'Helvetica-Bold' }], [50, 500, 300, 100]);
    const c = body(page);
    expect(c.match(/\/[A-Za-z0-9]+ 12 Tf/g)?.length).toBeGreaterThanOrEqual(2);
    expect(c.match(/BT/g)?.length).toBe(1);
  });

  it('switches rg between runs of different colours', () => {
    const { page } = drawRuns(
      [{ text: 'black ' }, { text: 'red', color: [1, 0, 0] }], [50, 500, 300, 100]);
    expect(body(page)).toContain('1 0 0 rg');
  });

  it('mixes a Standard-14 face with an embedded one on one line', () => {
    const { page } = drawRuns([], [50, 500, 300, 100], {},
      (d) => [{ text: 'std ' }, { text: 'AA', font: d.AddFont(buildUnicodeTtf()) }]);
    const c = body(page);
    expect(c.match(/Tf/g)?.length).toBeGreaterThanOrEqual(2);
    expect(c).toContain('Tj');
  });

  it('drops justify to left when any run is embedded', () => {
    const { page } = drawRuns([], [50, 500, 60, 100], { align: 'justify' },
      (d) => [{ text: 'aaa bbb ccc ddd eee fff ggg hhh ' },
              { text: 'AA', font: d.AddFont(buildUnicodeTtf()) }]);
    expect(body(page)).not.toContain('Tw');
  });

  it('underlines only the run that asked for it', () => {
    const { page } = drawRuns(
      [{ text: 'plain ' }, { text: 'linked', underline: true }], [50, 500, 300, 100]);
    const c = body(page);
    const rects = [...c.matchAll(/([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) re f/g)];
    expect(rects.length).toBe(1);
    // Measured, not merely "narrower than the box": the box is 300pt and the
    // whole line is far shorter, so a bounds check cannot tell a run-wide rule
    // from a line-wide one.
    const [, x, , w] = rects[0];
    expect(Number(x)).toBeCloseTo(50 + measureText('plain ', 12), 2);
    expect(Number(w)).toBeCloseTo(measureText('linked', 12), 2);
  });

  it('returns a run-list remainder that keeps its style', () => {
    const { page, rest } = drawRuns(
      [{ text: 'alpha beta ' }, { text: 'gamma delta epsilon', font: 'Helvetica-Bold' }],
      [50, 500, 50, 20]);
    expect(Array.isArray(rest)).toBe(true);
    expect((rest as TextRun[]).some((r) => r.font === 'Helvetica-Bold')).toBe(true);
    expect(body(page)).toContain('BT');
  });
});

const LOREM_LONG = ('Sentences repeated enough times to spill a column and force '
  + 'the remainder path to carry run styles across the break. ').repeat(20);

describe('Flow and Page with runs', () => {
  it('AddTextBlock takes runs and returns a run remainder', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const rest = page.AddTextBlock(
      [{ text: 'alpha beta gamma ' }, { text: 'delta epsilon zeta', font: 'Helvetica-Bold' }],
      [50, 500, 50, 20]);
    expect(Array.isArray(rest)).toBe(true);
    expect((rest as TextRun[]).some((r) => r.font === 'Helvetica-Bold')).toBe(true);
    expect(body(page)).toContain('BT');
  });

  it('a paragraph and a heading take runs and paginate', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHeading(1, [{ text: 'Mixed ' }, { text: 'Heading', color: [1, 0, 0] }]);
    flow.AddParagraph([
      { text: 'Body text with ' },
      { text: 'bold', font: 'Helvetica-Bold' },
      { text: ' and ' },
      { text: 'code', font: 'Courier', background: [0.95, 0.95, 0.95] },
      { text: ' inline. ' + LOREM_LONG },
    ]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(1);
    const c = body(pages[0]);
    expect(c).toContain('1 0 0 rg');
    expect(c.match(/Tf/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('a list item takes runs', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddList([{ text: [{ text: 'item with ' }, { text: 'emphasis', font: 'Helvetica-Oblique' }] }]);
    const pages = flow.Render();
    expect(body(pages[0]).match(/Tf/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('end to end', () => {
  // Reads the RESULT rather than the emitter that produced it: the extractor
  // resolves each fragment's font from the page resources, so this fails if a
  // run's Tf never reached the stream or pointed at the wrong resource.
  it('each fragment comes back with the font its run asked for', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(
      [{ text: 'regular ' }, { text: 'bold ', font: 'Helvetica-Bold' },
       { text: 'mono', font: 'Courier' }],
      [50, 700, 400, 60]);
    const reopened = Document.Open(doc.Save());
    const frags = reopened.Pages[0].GetTextFragments();
    const seen = frags.map((f) => f.fontName ?? '');
    expect(seen.some((n) => n.includes('Helvetica-Bold'))).toBe(true);
    expect(seen.some((n) => n.includes('Courier'))).toBe(true);
    expect(frags.map((f) => f.text).join('')).toContain('bold');
  });
});
