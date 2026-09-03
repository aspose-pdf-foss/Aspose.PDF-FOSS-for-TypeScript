/** What AddHtml reports when the engine had to compromise at PLACEMENT time
 *  (zch2.16) — the phase after building and lowering. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';
import { buildPngRgbWith } from './helpers/build-embed-images.js';

function png(w: number, h: number): string {
  return Buffer.from(buildPngRgbWith(w, h, new Array(w * h * 3).fill(128), 0))
    .toString('base64');
}
/** 9:16 exceeds the 1.548 column aspect, so it must be scaled to fit. */
const TALL_IMG = `<img src="data:image/png;base64,${png(9, 16)}">`;

/** A float the engine can neither fit nor SPLIT, which is what it takes to
 *  reach the degrade since zch2.15 — a float that merely overflows a column
 *  fragments instead. Its one line cannot be broken and cannot be scaled, so
 *  `splitPaint` paints nothing and the box falls through to ordinary flow.
 *  An over-tall IMAGE will not do it: at 150px the picture is 200pt tall, well
 *  inside the column, and one that were taller would now simply scale. */
const FLOAT_SRC =
  '<div style="float:left;width:150px"><p style="font-size:900px">W</p></div>'
  + '<p style="margin:0">alpha bravo charlie</p>';

describe('doc.AddHtml reports a placement-time compromise', () => {
  it('renders a too-tall image and reports it as scaled', () => {
    const { pages, skipped } = Document.New().AddHtml(TALL_IMG);
    expect(pages).toHaveLength(1);
    expect(skipped.map(describeReport)).toContain('image:scaled-to-fit');
  });

  it('reports an element it could only draw by overflowing', () => {
    const { skipped } = Document.New().AddHtml('<p style="font-size:900px">W</p>');
    expect(skipped.map((r) => r.construct)).toContain('overflow');
    expect(skipped.find((r) => r.construct === 'overflow')?.el?.name).toBe('p');
  });

  it('names the INNERMOST element, not the box that happens to wrap it', () => {
    // mapBox recurses and cssframe.ts wraps every element, so an attribution
    // that does not read through the frame — or that assigns unconditionally —
    // lets the outermost box win and reports every compromise in every
    // document against <html>. A build with either fault passes every other
    // case in this file.
    const { skipped } = Document.New().AddHtml(`<div><section>${TALL_IMG}</section></div>`);
    const img = skipped.find((r) => r.construct === 'image');
    expect(img?.el?.name).toBe('img');
  });

  it('reports NOTHING for content that places normally', () => {
    const { skipped } = Document.New().AddHtml('<p>ordinary</p>');
    expect(skipped).toEqual([]);
  });
});

describe('page.AddHtml reports the same', () => {
  it('scales the image and reports it', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const { skipped, remainder } = page.AddHtml(TALL_IMG, [50, 50, 400, 300]);
    expect(remainder).toHaveLength(0);
    expect(skipped.map(describeReport)).toContain('image:scaled-to-fit');
  });
});

describe('a Flow gets the opt-in sink, and its array never mutates', () => {
  it('fires onNotRendered during Render()', () => {
    const seen: NotRendered[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHtml(TALL_IMG, { onNotRendered: (r) => { seen.push(r); } });
    flow.Render();
    expect(seen.map(describeReport)).toContain('image:scaled-to-fit');
  });

  it('does NOT append to the skipped array it already handed back', () => {
    // Decision 7. A build that pushed into the shared array passes every other
    // case in this file and fails only here.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    const { skipped } = flow.AddHtml(TALL_IMG);
    const before = skipped.length;
    flow.Render();
    expect(skipped.length).toBe(before);
  });
});

describe('a float that cannot be floated', () => {
  it('lays out in flow and reports itself', () => {
    // Reachable for the first time: before this issue it threw.
    const src = FLOAT_SRC;
    const { skipped } = Document.New().AddHtml(src);
    expect(skipped.map((r) => r.construct)).toContain('float');
  });

  it('reports ONE record for one box', () => {
    // Decision 9 predicted this needs the `once` de-duplication in cssflow.ts,
    // because "a retry after a column advance re-enters the float branch".
    // MEASURED, and the prediction does not hold: dropping the de-duplication
    // reddens NOTHING here or anywhere. A float that does not fit is DEFERRED
    // to the next column before it is ever offered a split, so the degrade is
    // only ever reached with `atColumnStart` true — traced, for every filler
    // length from 0 to 390 paragraphs — and the fall-through then always
    // draws. So nothing can fire twice today, and this case pins the COUNT
    // rather than the de-duplication. See CLAUDE.md.
    const { skipped } = Document.New().AddHtml(FLOAT_SRC);
    expect(skipped.filter((r) => r.construct === 'float')).toHaveLength(1);
  });
});
