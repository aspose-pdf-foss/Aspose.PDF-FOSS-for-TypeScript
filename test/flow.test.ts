import { describe, it, expect } from 'vitest';
import { PageFormat, normalizeFlowOptions, columnX, paragraph, heading, list, image, Flow } from '../src/flow.js';
import { Document } from '../src/index.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

describe('PageFormat', () => {
  it('exposes standard sizes in points', () => {
    expect([PageFormat.A4.width, PageFormat.A4.height]).toEqual([595, 842]);
    expect([PageFormat.Letter.width, PageFormat.Letter.height]).toEqual([612, 792]);
    expect([PageFormat.Legal.width, PageFormat.Legal.height]).toEqual([612, 1008]);
  });

  it('landscape() yields width >= height and is idempotent', () => {
    const l = PageFormat.A4.landscape();
    expect([l.width, l.height]).toEqual([842, 595]);
    expect(l.landscape()).toBe(l); // already landscape → same instance
  });

  it('portrait() yields height >= width and is idempotent', () => {
    const p = PageFormat.A4.landscape().portrait();
    expect([p.width, p.height]).toEqual([595, 842]);
    expect(PageFormat.A4.portrait()).toBe(PageFormat.A4);
  });

  it('custom() validates positive finite dimensions', () => {
    expect([PageFormat.custom(300, 200).width, PageFormat.custom(300, 200).height]).toEqual([300, 200]);
    expect(() => PageFormat.custom(0, 200)).toThrow(TypeError);
    expect(() => PageFormat.custom(300, -1)).toThrow(TypeError);
    expect(() => PageFormat.custom(NaN, 200)).toThrow(TypeError);
  });
});

describe('flow geometry', () => {
  it('defaults: A4, 1 column, 72pt margins', () => {
    const g = normalizeFlowOptions();
    expect(g.contentLeft).toBe(72);
    expect(g.contentTop).toBe(842 - 72);
    expect(g.contentBottom).toBe(72);
    expect(g.columnWidth).toBeCloseTo(595 - 144, 6);
    expect(g.columnHeight).toBeCloseTo(842 - 144, 6);
    expect(g.columns).toBe(1);
    expect(columnX(g, 0)).toBe(72);
  });

  it('splits width across columns with the gap', () => {
    const g = normalizeFlowOptions({
      format: PageFormat.custom(1000, 800), columns: 2, columnGap: 40,
      marginLeft: 50, marginRight: 50, marginTop: 60, marginBottom: 30,
    });
    // contentWidth = 1000-100 = 900; columnWidth = (900-40)/2 = 430
    expect(g.columnWidth).toBeCloseTo(430, 6);
    expect(columnX(g, 0)).toBe(50);
    expect(columnX(g, 1)).toBeCloseTo(50 + 430 + 40, 6);
    expect(g.contentTop).toBe(800 - 60);
    expect(g.contentBottom).toBe(30);
  });

  it('validates its inputs', () => {
    expect(() => normalizeFlowOptions({ columns: 0 })).toThrow(TypeError);
    expect(() => normalizeFlowOptions({ columns: 1.5 })).toThrow(TypeError);
    expect(() => normalizeFlowOptions({ marginLeft: -1 })).toThrow(TypeError);
    expect(() => normalizeFlowOptions({ columnGap: NaN })).toThrow(TypeError);
    // columnWidth <= 0: margins + gap eat all the width
    expect(() => normalizeFlowOptions({ marginLeft: 300, marginRight: 300 })).toThrow(TypeError);
    // columnHeight <= 0
    expect(() => normalizeFlowOptions({ marginTop: 500, marginBottom: 500 })).toThrow(TypeError);
    // wrong format type
    expect(() => normalizeFlowOptions({ format: {} as any })).toThrow(TypeError);
  });
});

describe('flow element measure', () => {
  it('paragraph measure predicts full fit and used height', () => {
    const p = paragraph('word0 word1 word2', { font: 'Helvetica', fontSize: 12, leading: 16 })[0];
    const m = p.measure!({ width: 400, availHeight: 400 });
    expect(m.fits).toBe(true);
    expect(m.usedHeight).toBeCloseTo(16, 6); // one line
  });

  it('paragraph measure reports no full fit when the box clips it', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const p = paragraph(long, { font: 'Helvetica', fontSize: 12, leading: 16 })[0];
    const m = p.measure!({ width: 80, availHeight: 16 }); // room for one line only
    expect(m.fits).toBe(false);
    expect(m.usedHeight).toBeCloseTo(16, 6);
  });

  it('list item measure honors the indent (narrower body wraps sooner)', () => {
    const [item] = list(['alpha beta gamma delta epsilon'], { fontSize: 12, leading: 16, indent: 60 });
    const wide = item.measure!({ width: 300, availHeight: 400 });
    const narrow = item.measure!({ width: 120, availHeight: 400 });
    expect(narrow.usedHeight).toBeGreaterThan(wide.usedHeight); // indent eats width → more lines
  });
});

describe('flow image element', () => {
  const cm = (page: import('../src/page.js').Page) =>
    new TextDecoder('latin1').decode(page.Contents);

  it('default fills the region width with aspect height, left-aligned', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = image(buildPngRgb())[0]; // 2x1 → height = width/2
    const res = el.place({ doc, page, x: 20, top: 400, width: 260, availHeight: 400 });
    expect(res.drew).toBe(true);
    expect(res.usedHeight).toBeCloseTo(130, 6); // 260 * (1/2)
    expect(res.remainder).toBeNull();
    expect(cm(page)).toMatch(/260 0 0 130 20 270 cm/); // [x=20, y=400-130=270, w=260, h=130]
  });

  it('honors an explicit width (aspect height) below the region width', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = image(buildPngRgb(), { width: 100 })[0];
    el.place({ doc, page, x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(page)).toMatch(/100 0 0 50 20 350 cm/); // w=100,h=50,x=20,y=350
  });

  it('clamps an over-region width to the region, preserving aspect', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = image(buildPngRgb(), { width: 520 })[0]; // baseH = 260; factor 260/520
    el.place({ doc, page, x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(page)).toMatch(/260 0 0 130 20 270 cm/); // clamped to 260x130 (still 2:1)
  });

  it('aligns center and right within the region', () => {
    const center = Document.Open(buildBlankPage());
    image(buildPngRgb(), { width: 100, align: 'center' })[0]
      .place({ doc: center, page: center.Pages[0], x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(center.Pages[0])).toMatch(/100 0 0 50 100 350 cm/); // x = 20 + (260-100)/2

    const right = Document.Open(buildBlankPage());
    image(buildPngRgb(), { width: 100, align: 'right' })[0]
      .place({ doc: right, page: right.Pages[0], x: 20, top: 400, width: 260, availHeight: 400 });
    expect(cm(right.Pages[0])).toMatch(/100 0 0 50 180 350 cm/); // x = 20 + 260-100
  });

  it('place returns drew:false / remainder:self when the image is taller than availHeight', () => {
    const doc = Document.Open(buildBlankPage());
    const el = image(buildPngRgb())[0]; // 260-wide region → 130 tall
    const res = el.place({ doc, page: doc.Pages[0], x: 20, top: 400, width: 260, availHeight: 100 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
    expect(cm(doc.Pages[0])).not.toMatch(/Do\b/); // no image XObject drawn
  });

  it('measure reports fit atomically', () => {
    const el = image(buildPngRgb())[0];
    expect(el.measure!({ width: 260, availHeight: 130 })).toEqual({ usedHeight: 130, fits: true });
    expect(el.measure!({ width: 260, availHeight: 129 })).toEqual({ usedHeight: 0, fits: false });
  });

  it('validates options and rejects non-images', () => {
    expect(() => image(buildPngRgb(), { width: 0 })[0]).toThrow(TypeError);
    expect(() => image(buildPngRgb(), { width: -1 })[0]).toThrow(TypeError);
    expect(() => image(buildPngRgb(), { height: -1 })[0]).toThrow(TypeError);
    expect(() => image(buildPngRgb(), { align: 'middle' as any })[0]).toThrow(TypeError);
    expect(() => image(buildPngRgb(), { alt: 5 as any })[0]).toThrow(TypeError);
    expect(() => image(buildPngRgb(), { spaceBefore: -1 })[0]).toThrow(TypeError);
    expect(() => image(new Uint8Array([1, 2, 3]))[0]).toThrow(); // UnsupportedFeatureError
  });
});

describe('flow images (AddImage)', () => {
  const has = (page: any, re: RegExp) => re.test(new TextDecoder('latin1').decode(page.Contents));
  const opts = (extra = {}) => ({
    format: PageFormat.custom(300, 200), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra, // colW 260, colH 160
  });
  const L = { font: 'Helvetica' as const, fontSize: 12, leading: 20 };

  it('renders a column-width image and is chainable', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(flow.AddImage(buildPngRgb())).toBe(flow);
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(has(pages[0], /260 0 0 130 20 /)).toBe(true); // 260-wide, 130 tall at column x
  });

  it('paginates atomically: an image that will not fit moves wholly to the next page', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph(Array.from({ length: 5 }, (_, i) => `F${i}`).join('\n'), L); // 100pt used → 60 left
    flow.AddImage(buildPngRgb()); // 130 tall → cannot fit in 60
    const pages = flow.Render();
    expect(pages.length).toBe(2);
    expect(has(pages[0], /0 0 130 /)).toBe(false); // not on page 1
    expect(has(pages[1], /260 0 0 130 /)).toBe(true); // whole image on page 2
  });

  it('throws when an image is taller than an empty column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 100), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 }); // colH 60 < 130
    flow.AddImage(buildPngRgb());
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/i);
  });

  it('spaceAfter shifts following content by the given points', () => {
    function belowY(spaceAfter: number): number {
      const doc = Document.Open(buildBlankPage());
      const flow = doc.NewFlow(opts({ format: PageFormat.custom(300, 500) })); // tall page, one column
      flow.AddImage(buildPngRgb(), { width: 40, spaceAfter }); // 20 tall
      flow.AddParagraph('below', L);
      const page = flow.Render()[0];
      return page.GetTextFragments().find((f: any) => f.text.includes('below'))!.quad[1];
    }
    expect(belowY(0) - belowY(20)).toBeCloseTo(20, 2); // larger spaceAfter pushes 'below' down
  });

  it('emits exactly one /Figure with /Alt when the flow is tagged', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts({ format: PageFormat.custom(300, 500), tagged: true }));
    flow.AddImage(buildPngRgb(), { alt: 'a red-green dot' });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const figs = sect.Children.filter((c) => c.Type === 'Figure');
    expect(figs.length).toBe(1);
    expect(figs[0].Alt).toBe('a red-green dot');
  });

  it('untagged flow (default) creates no structure for an image', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts({ format: PageFormat.custom(300, 500) }));
    flow.AddImage(buildPngRgb());
    flow.Render();
    expect(Document.Open(doc.Save()).GetStructTree()).toBeNull();
  });

  it('a heading keeps with a following image, treated atomically', () => {
    // 300x200, colH 160 = 8 slots of 20pt. Image {width:40} is 20 tall (one slot).
    const push = Document.Open(buildBlankPage());
    const flowP = new Flow(push, opts());
    flowP.AddParagraph(Array.from({ length: 7 }, (_, i) => `F${i}`).join('\n'), L); // one slot left
    flowP.AddHeading(2, 'HEADING', L);        // fills it; no room for the image
    flowP.AddImage(buildPngRgb(), { width: 40 });
    expect(flowP.Render()[0].GetText().includes('HEADING')).toBe(false); // pushed with the image

    const stay = Document.Open(buildBlankPage());
    const flowS = new Flow(stay, opts());
    flowS.AddParagraph(Array.from({ length: 6 }, (_, i) => `F${i}`).join('\n'), L); // two slots left
    flowS.AddHeading(2, 'HEADING', L);
    flowS.AddImage(buildPngRgb(), { width: 40 });
    expect(flowS.Render()[0].GetText()).toContain('HEADING'); // heading + image both fit
  });
});

describe('paragraph element placement', () => {
  it('draws what fits and returns a continuation for the rest', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = paragraph('aaa\nbbb\nccc\nddd', { font: 'Helvetica', fontSize: 10, leading: 12 })[0];
    // availHeight only fits 2 lines
    const res = el.place({ doc, page, x: 72, top: 600, width: 40, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.usedHeight).toBeCloseTo(24, 6);
    expect(res.remainder).not.toBeNull();

    // The continuation places the rest in a taller box with no leftover.
    const res2 = res.remainder!.place({ doc, page, x: 72, top: 500, width: 40, availHeight: 200 });
    expect(res2.drew).toBe(true);
    expect(res2.remainder).toBeNull();
  });

  it('retries (remainder=self, drew=false) when no space is left', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = paragraph('hello', { fontSize: 10, leading: 12 })[0];
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 0 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
  });

  it('discards empty text (remainder=null, drew=false)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const el = paragraph('', { fontSize: 10, leading: 12 })[0];
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 200 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBeNull();
  });
});

describe('list item element placement', () => {
  it('draws the marker once and indents the body past it', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = list(['hello'], { ordered: false, fontSize: 12, indent: 24 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 200 });
    expect(res.drew).toBe(true);
    expect(res.remainder).toBeNull();

    // GetTextFragments merges the marker and body runs into one fragment, so
    // assert marker geometry on the content stream (the repo's pattern for this).
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Body is positioned at the gutter x = 72 + indent(24) = 96, baseline 588.
    expect(content).toMatch(/96 588 Td\s+\(hello\)/);
    // Default marker is a vector disc, not a text glyph. Its rightmost point (the
    // Bézier start 'm') sits one markerGap left of the gutter.
    expect(content).not.toMatch(/\(\\225\)/);
    const m = content.match(/([\d.]+) [\d.]+ m\n/);
    expect(m).not.toBeNull();
    const markerX = parseFloat(m![1]);
    expect(markerX).toBeLessThan(96);    // left of the body gutter
    expect(markerX).toBeGreaterThan(72); // right of the list edge
  });

  it('splits a tall item: marker on the first block only, body-only continuation', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = list(['aaa\nbbb\nccc\nddd'],
      { fontSize: 10, leading: 12, indent: 20 });
    // availHeight fits only 2 lines (24pt).
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 24 });
    expect(res.drew).toBe(true);
    expect(res.remainder).not.toBeNull();
    // Continuation places the rest with no leftover and draws NO second marker.
    const doc2 = Document.Open(buildBlankPage());
    const page2 = doc2.Pages[0];
    // Re-run first placement on page2 so the continuation's page is clean of a marker.
    const [el2] = list(['aaa\nbbb\nccc\nddd'], { fontSize: 10, leading: 12, indent: 20 });
    const first = el2.place({ doc: doc2, page: page2, x: 72, top: 600, width: 200, availHeight: 24 });
    const cont = first.remainder!;
    const doc3 = Document.Open(buildBlankPage());
    const page3 = doc3.Pages[0];
    const res3 = cont.place({ doc: doc3, page: page3, x: 72, top: 500, width: 200, availHeight: 200 });
    expect(res3.drew).toBe(true);
    expect(res3.remainder).toBeNull();
    // The continuation page has body text but no bullet marker.
    const contFrags = page3.GetTextFragments();
    expect(contFrags.some((f) => f.text.includes('ccc'))).toBe(true);
    expect(contFrags.some((f) => f.text.includes('•'))).toBe(false);
  });

  it('retries (remainder=self, drew=false) when no space is left', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = list(['hi'], { fontSize: 10, leading: 12 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 0 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBe(el);
  });

  it('discards an empty item (remainder=null, drew=false)', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const [el] = list([''], { fontSize: 10, leading: 12 });
    const res = el.place({ doc, page, x: 72, top: 600, width: 200, availHeight: 200 });
    expect(res.drew).toBe(false);
    expect(res.remainder).toBeNull();
  });
});

describe('flow list options', () => {
  it('validates its inputs', () => {
    expect(() => list(['a'], { start: 1.5 })).toThrow(TypeError);
    expect(() => list(['a'], { itemSpacing: -1 })).toThrow(TypeError);
    expect(() => list(['a'], { spaceBefore: NaN })).toThrow(TypeError);
    expect(() => list(['a'], { fontSize: 0 })).toThrow(TypeError);
    expect(() => list(['a'], { indent: -5 })).toThrow(TypeError);
    expect(() => list('nope' as any)).toThrow(TypeError);
    expect(() => list([1 as any])).toThrow(TypeError);
  });

  it('builds one element per item; empty array builds none', () => {
    expect(list(['a', 'b', 'c']).length).toBe(3);
    expect(list([]).length).toBe(0);
  });

  it('first item carries spaceBefore, last carries spaceAfter, middles carry itemSpacing', () => {
    const els = list(['a', 'b', 'c'],
      { spaceBefore: 10, spaceAfter: 20, itemSpacing: 5 });
    expect(els[0].spaceBefore).toBe(10);
    expect(els[0].spaceAfter).toBe(5);   // itemSpacing between item 0 and 1
    expect(els[1].spaceBefore).toBe(0);
    expect(els[1].spaceAfter).toBe(5);
    expect(els[2].spaceAfter).toBe(20);  // list-level spaceAfter on the last item
  });
});

describe('Flow engine', () => {
  // Small page so overflow is easy to force: 300x260, 1 column, 30pt margins.
  const smallOpts = () => ({
    format: PageFormat.custom(300, 260), columns: 1,
    marginLeft: 30, marginRight: 30, marginTop: 30, marginBottom: 30,
  });

  it('renders a single paragraph onto one appended page', () => {
    const doc = Document.Open(buildBlankPage());
    const before = doc.Pages.length;
    const flow = new Flow(doc, smallOpts());
    flow.AddParagraph('hello world', { font: 'Helvetica', fontSize: 12, leading: 14 });
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(doc.Pages.length).toBe(before + 1);
    expect([pages[0].MediaBox[2], pages[0].MediaBox[3]]).toEqual([300, 260]);
    expect(pages[0].GetText()).toContain('hello');
  });

  it('auto-paginates: long text spans multiple appended pages in order', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, smallOpts());
    // Column height = 260 - 60 = 200; at leading 20 that is ~10 lines/page.
    const lines = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n');
    const flow2 = flow.AddParagraph(lines, { font: 'Helvetica', fontSize: 12, leading: 20 });
    expect(flow2).toBe(flow); // chainable
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    // First marker on page 0, a later marker on a subsequent page.
    expect(pages[0].GetText()).toContain('L0');
    expect(pages[pages.length - 1].GetText()).toContain('L39');
    expect(pages[0].GetText()).not.toContain('L39');
  });

  it('fills column 0 then column 1 before a new page (2-col)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 260), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    const lines = Array.from({ length: 24 }, (_, i) => `N${i}`).join('\n');
    flow.AddParagraph(lines, { font: 'Helvetica', fontSize: 12, leading: 20 });
    const pages = flow.Render();
    // Column width = (360-20)/2 = 170; column 1 left edge = 20+170+20 = 210.
    const frags = pages[0].GetTextFragments();
    const n0 = frags.find((f) => f.text.includes('N0'))!;
    const later = frags.find((f) => f.text.includes('N11'))!;
    expect(n0.quad[0]).toBeLessThan(210);   // first content in the left column
    expect(later.quad[0]).toBeGreaterThanOrEqual(210); // later content in the right column
  });

  it('AddColumnBreak forces the next column with space left', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 400), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    flow.AddParagraph('AAA', { font: 'Helvetica', fontSize: 12, leading: 14 });
    flow.AddColumnBreak();
    flow.AddParagraph('BBB', { font: 'Helvetica', fontSize: 12, leading: 14 });
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    const frags = pages[0].GetTextFragments();
    const a = frags.find((f) => f.text.includes('AAA'))!;
    const b = frags.find((f) => f.text.includes('BBB'))!;
    expect(a.quad[0]).toBeLessThan(210);           // left column
    expect(b.quad[0]).toBeGreaterThanOrEqual(210);  // right column (break jumped)
  });

  it('empty flow still produces one blank page', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, smallOpts());
    const pages = flow.Render();
    expect(pages.length).toBe(1);
  });

  it('throws on second Render', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, smallOpts());
    flow.AddParagraph('x', { fontSize: 12, leading: 14 });
    flow.Render();
    expect(() => flow.Render()).toThrow(/already rendered/i);
  });

  it('throws when an element cannot fit an empty column', () => {
    const doc = Document.Open(buildBlankPage());
    // Column height ~ 8pt but leading 40 → not even one line fits.
    const flow = new Flow(doc, {
      format: PageFormat.custom(300, 60), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 26, marginBottom: 26,
    });
    flow.AddParagraph('too tall', { fontSize: 30, leading: 40 });
    expect(() => flow.Render()).toThrow(/does not fit/i);
  });
});

describe('flow lists (AddList)', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  it('renders a bullet list: one marker glyph per item, bodies present', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['First', 'Second', 'Third'], { fontSize: 12, leading: 16 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Default bullet is a vector disc: one fill-paint (f\nQ) per item.
    expect((content.match(/f\nQ/g) ?? []).length).toBe(3);
    const text = page.GetText();
    expect(text).toContain('First');
    expect(text).toContain('Second');
    expect(text).toContain('Third');
  });

  it('numbers an ordered list from start and aligns wide/narrow ordinals', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
    flow.AddList(items, { ordered: true, start: 1, fontSize: 12, leading: 16 });
    const [page] = flow.Render();
    const text = page.GetText();
    expect(text).toContain('1.');
    expect(text).toContain('10.');
    // "1." and "10." bodies share one gutter: item0 and item9 body x match.
    const frags = page.GetTextFragments();
    const b0 = frags.find((f) => f.text.includes('item0'))!;
    const b9 = frags.find((f) => f.text.includes('item9'))!;
    expect(b0.quad[0]).toBeCloseTo(b9.quad[0], 1);
  });

  it('itemSpacing inserts a vertical gap between items', () => {
    function gap(itemSpacing: number): number {
      const doc = Document.Open(buildBlankPage());
      const flow = new Flow(doc, opts());
      flow.AddList(['AAA', 'BBB'], { fontSize: 12, leading: 14, itemSpacing });
      const [page] = flow.Render();
      const a = page.GetTextFragments().find((f) => f.text.includes('AAA'))!;
      const b = page.GetTextFragments().find((f) => f.text.includes('BBB'))!;
      return a.quad[1] - b.quad[1]; // larger y = higher; positive gap downward
    }
    expect(gap(20) - gap(0)).toBeCloseTo(20, 2);
  });

  it('is chainable and empty array is a no-op', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(flow.AddList([])).toBe(flow);
    expect(flow.AddList(['x'])).toBe(flow);
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('x');
  });

  it('draws the marker once when an item spans a page boundary', () => {
    // Short page: force a single long item to overflow onto a second page.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(200, 120), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    flow.AddList([long], { fontSize: 12, leading: 16 });
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThan(1);
    const bulletCount = pages.reduce(
      (n, p) => n + (new TextDecoder('latin1').decode(p.Contents).match(/f\nQ/g) ?? []).length, 0);
    expect(bulletCount).toBe(1); // exactly one marker paint across all pages
  });

  it('AddColumnBreak between items jumps to the next column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 400), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    flow.AddList(['AAA'], { fontSize: 12, leading: 14 });
    flow.AddColumnBreak();
    flow.AddList(['BBB'], { fontSize: 12, leading: 14 });
    const [page] = flow.Render();
    const frags = page.GetTextFragments();
    const a = frags.find((f) => f.text.includes('AAA'))!;
    const b = frags.find((f) => f.text.includes('BBB'))!;
    expect(a.quad[0]).toBeLessThan(210);
    expect(b.quad[0]).toBeGreaterThanOrEqual(210);
  });
});

describe('flow list vector bullets', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  it('draws the default bullet as a filled disc (Bézier path + fill), not text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['One'], { fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    expect(content).toMatch(/ c\n/);   // circle Bézier curve op
    expect(content).toMatch(/f\nQ/);   // filled
    expect(content).not.toMatch(/\(\\225\)/); // no WinAnsi bullet glyph
  });

  it('an explicit bullet string is still drawn as text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['One'], { bullet: '*', fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    expect(content).toContain('(*)'); // text marker
  });

  it('tags a vector bullet /Lbl with /ActualText', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, { ...opts(), tagged: true });
    flow.AddList(['One'], { fontSize: 12, leading: 16 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const l = sect.Children.find((c) => c.Type === 'L')!;
    const lbl = l.Children[0].Children.find((c) => c.Type === 'Lbl')!;
    expect(lbl.ActualText).toBe('•');
  });
});

describe('flow nested lists', () => {
  const opts = (extra = {}) => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra,
  });
  const bodyX = (page: any, needle: string) =>
    page.GetTextFragments().find((f: any) => f.text.includes(needle))!.quad[0];

  it('indents a sub-list deeper than its parent', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([{ text: 'Parent', items: ['Child'] }, 'Sibling'], { fontSize: 12, leading: 16 });
    const [page] = flow.Render();
    expect(bodyX(page, 'Child')).toBeGreaterThan(bodyX(page, 'Parent'));
    expect(bodyX(page, 'Sibling')).toBeCloseTo(bodyX(page, 'Parent'), 1);
  });

  it('restarts ordered numbering per sub-list', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([
      { text: 'A', ordered: true, items: ['a1', 'a2'] },
      { text: 'B', ordered: true, items: ['b1', 'b2'] },
    ], { ordered: true, fontSize: 12, leading: 16 });
    const text = flow.Render()[0].GetText();
    // Top: 1. A, 2. B. Each sub-list restarts: 1. 2.
    expect(text).toContain('1.');
    expect(text).toContain('2.');
    expect(text).not.toContain('3.'); // sub-lists restarted, no running count
  });

  it('cycles bullet shapes by depth (disc, ring, square)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([{ text: 'L0', items: [{ text: 'L1', items: ['L2'] }] }], { fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    // depth 0 disc (fill), depth 1 ring (stroke), depth 2 square (fill).
    expect((content.match(/f\nQ/g) ?? []).length).toBe(2); // disc + square
    expect((content.match(/S\nQ/g) ?? []).length).toBe(1); // ring
  });

  it('supports mixed ordered/unordered nesting via the item override', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList([{ text: 'Bulleted', ordered: true, items: ['n1', 'n2'] }], { fontSize: 12, leading: 16 });
    const content = new TextDecoder('latin1').decode(flow.Render()[0].Contents);
    expect(content).toMatch(/f\nQ/);   // top is a vector disc
    expect(content).toContain('(1.)'); // sub-list is ordered text
  });

  it('emits nested /L under the parent /LBody when tagged', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts({ tagged: true }));
    flow.AddList([{ text: 'Parent', items: ['Child'] }], { fontSize: 12, leading: 16 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const topL = sect.Children.find((c) => c.Type === 'L')!;
    const parentLi = topL.Children.find((c) => c.Type === 'LI')!;
    const parentBody = parentLi.Children.find((c) => c.Type === 'LBody')!;
    const nestedL = parentBody.Children.find((c) => c.Type === 'L'); // nested /L inside /LBody
    expect(nestedL).toBeDefined();
    expect(nestedL!.Children.some((c) => c.Type === 'LI')).toBe(true);
  });

  it('validates node shapes', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddList([{ text: 5 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', items: 'no' as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', ordered: 1 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', bullet: 5 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', start: 1.5 as any }])).toThrow(TypeError);
  });
});

describe('flow per-item list styling', () => {
  const opts = (extra = {}) => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra,
  });
  const cm = (page: any) => new TextDecoder('latin1').decode(page.Contents);
  const bodyX = (page: any, needle: string) =>
    page.GetTextFragments().find((f: any) => f.text.includes(needle))!.quad[0];

  it('overrides font size for one item only', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['Small', { text: 'Big', fontSize: 20 }], { fontSize: 10, leading: 24 });
    const content = cm(flow.Render()[0]);
    expect(content).toMatch(/ 10 Tf/); // the default item
    expect(content).toMatch(/ 20 Tf/); // the overridden item
  });

  it('overrides colour for the body AND the marker of one item', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['Black', { text: 'Red', color: [1, 0, 0] }], { fontSize: 12, leading: 16 });
    const content = cm(flow.Render()[0]);
    // The red item paints red twice: once for its disc marker, once for its body.
    expect((content.match(/1 0 0 rg/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(content).toMatch(/0 0 0 rg/); // the black item is still black
  });

  it('widens the depth gutter when an item uses a larger marker size', () => {
    const uni = Document.Open(buildBlankPage());
    const uniFlow = new Flow(uni, opts());
    uniFlow.AddList(['A', 'B'], { fontSize: 10, leading: 24 });
    const uniX = bodyX(uniFlow.Render()[0], 'A');

    const big = Document.Open(buildBlankPage());
    const bigFlow = new Flow(big, opts());
    bigFlow.AddList([{ text: 'A', fontSize: 30 }, 'B'], { fontSize: 10, leading: 34 });
    const bigX = bodyX(bigFlow.Render()[0], 'B'); // sibling shifts too: shared depth gutter
    expect(bigX).toBeGreaterThan(uniX); // 30pt marker widened the gutter for the whole depth
  });

  it('renders byte-identically to a plain string list when no style is overridden', () => {
    const a = Document.Open(buildBlankPage());
    const strFlow = new Flow(a, opts());
    strFlow.AddList(['One', 'Two'], { fontSize: 12, leading: 16 });
    const strContent = cm(strFlow.Render()[0]);

    const b = Document.Open(buildBlankPage());
    const objFlow = new Flow(b, opts());
    objFlow.AddList([{ text: 'One' }, { text: 'Two' }], { fontSize: 12, leading: 16 });
    const objContent = cm(objFlow.Render()[0]);
    expect(objContent).toBe(strContent);
  });

  it('validates per-item style field types', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddList([{ text: 'x', font: 5 as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', fontSize: 0 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', color: [1, 0] as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', align: 'middle' as any }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', leading: -1 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', indent: -1 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', spaceBefore: -1 }])).toThrow(TypeError);
    expect(() => flow.AddList([{ text: 'x', spaceAfter: -1 }])).toThrow(TypeError);
  });

  it('applies a per-item indent to that item only', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddList(['Normal', { text: 'Hung', indent: 80 }], { fontSize: 12, leading: 16 });
    const page = flow.Render()[0];
    // Column left is marginLeft = 20; the override item's body sits at 20 + 80.
    expect(bodyX(page, 'Hung')).toBeCloseTo(100, 1);
    expect(bodyX(page, 'Normal')).toBeLessThan(100); // auto indent, unaffected
  });

  it('applies a per-item spaceAfter, dropping the next item further down', () => {
    const bodyY = (page: any, needle: string) =>
      page.GetTextFragments().find((f: any) => f.text.includes(needle))!.quad[1];

    const plain = Document.Open(buildBlankPage());
    const plainFlow = new Flow(plain, opts());
    plainFlow.AddList(['P1', 'P2', 'P3'], { fontSize: 12, leading: 16 });
    const plainY = bodyY(plainFlow.Render()[0], 'P3');

    const spaced = Document.Open(buildBlankPage());
    const spacedFlow = new Flow(spaced, opts());
    spacedFlow.AddList(['P1', { text: 'P2', spaceAfter: 40 }, 'P3'], { fontSize: 12, leading: 16 });
    const spacedY = bodyY(spacedFlow.Render()[0], 'P3');
    // Extra 40pt gap after P2 pushes P3 ~40pt lower (smaller y in PDF space).
    expect(plainY - spacedY).toBeCloseTo(40, 0);
  });
});

describe('flow list tagging', () => {
  const tagged = () => ({
    format: PageFormat.custom(400, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, tagged: true,
  });

  it('emits /L → /LI → /Lbl + /LBody for each item (round-trip)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, tagged());
    flow.AddList(['Alpha', 'Beta'], { ordered: true, fontSize: 12, leading: 16 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const list = sect.Children.find((c) => c.Type === 'L')!;
    expect(list).toBeDefined();
    const items = list.Children.filter((c) => c.Type === 'LI');
    expect(items.length).toBe(2);
    for (const li of items) {
      expect(li.Children.some((c) => c.Type === 'Lbl')).toBe(true);
      expect(li.Children.some((c) => c.Type === 'LBody')).toBe(true);
    }
    // Text survives a save/open round-trip and lands under the list.
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.GetText()).toContain('Alpha');
    expect(re.GetStructTree()!.GetText()).toContain('Beta');
  });

  it('an all-empty list produces no /L node', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, tagged());
    flow.AddList(['', ''], { fontSize: 12 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    expect(sect.Children.some((c) => c.Type === 'L')).toBe(false);
  });

  it('a split item keeps exactly one /Lbl and one /LBody', () => {
    // Two short columns force a single long item to span a column boundary.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(360, 120), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, tagged: true,
    });
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    flow.AddList([long], { fontSize: 12, leading: 16 });
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const list = sect.Children.find((c) => c.Type === 'L')!;
    const lis = list.Children.filter((c) => c.Type === 'LI');
    expect(lis.length).toBe(1); // one item, even though it drew on two columns
    const li = lis[0];
    expect(li.Children.filter((c) => c.Type === 'Lbl').length).toBe(1);
    expect(li.Children.filter((c) => c.Type === 'LBody').length).toBe(1);
  });

  it('untagged flow (default) creates no list structure', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 500), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, // tagged omitted
    });
    flow.AddList(['x', 'y'], { fontSize: 12 });
    flow.Render();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()).toBeNull();
  });
});

describe('flow floating boxes', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  it('left float: text wraps beside it, then resumes full width below', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 100, spacing: 6 });
    box.AddParagraph('BOX', { fontSize: 10, leading: 12 });
    box.AddParagraph('BOX2', { fontSize: 10, leading: 12 });
    box.AddParagraph('BOX3', { fontSize: 10, leading: 12 }); // make the box tall
    flow.AddFloatBox(box, 'left');
    // Lots of wrapping text: early lines beside the box, later lines below it.
    const body = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    flow.AddParagraph(body, { fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const frags = page.GetTextFragments();
    // band = width(100) + spacing(6) = 106; columnX = 20 → beside-text starts at 126.
    const first = frags.find((f) => f.text.includes('word0'))!;
    const last = frags.find((f) => f.text.includes('word39'))!;
    expect(first.quad[0]).toBeGreaterThan(120);   // beside the left float
    expect(last.quad[0]).toBeLessThan(60);        // resumed full width (near columnX 20)
  });

  it('right float: box on the right, beside-text stays left', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 100, spacing: 6 });
    box.AddParagraph('R', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'right');
    flow.AddParagraph('sidetext', { fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    // Box content and wrapping text share a baseline, so GetTextFragments merges
    // them — assert positions on the content stream instead.
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Wrapping text stays at the left margin (x = 20).
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(sidetext\)/);
    // Box content 'R' sits on the right: columnX + colWidth - width = 20+260-100 = 180.
    expect(content).toMatch(/(^|\n)180 [\d.]+ Td\s+\(R\)/);
  });

  it('a box taller than a full column throws', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(200, 120), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 });
    const box = doc.NewFloatingBox({ width: 100 });
    for (let i = 0; i < 20; i++) box.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/i);
  });

  it('is chainable', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 50 });
    box.AddParagraph('x');
    expect(flow.AddFloatBox(box, 'left')).toBe(flow);
  });

  it('left + right floats are active at once: text flows in the middle channel', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // Left box: 5 paragraphs → 5*12 + 4*6 = 84 tall, bottom 480-84 = 396, band 86.
    const left = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 5; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    // Right box: 3 paragraphs → 3*12 + 2*6 = 48 tall, top 474, bottom 426, band 86.
    const right = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 3; i++) right.AddParagraph(`R${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(right, 'right');
    // Two image probes pin the two channel edges. One alone cannot: a
    // right-aligned image lands at columnX + columnWidth - insetR, in which the
    // left inset cancels out, so it is blind to the left float.
    flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24 });
    flow.AddImage(buildPngRgb(), { align: 'right', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Channel at top 474: x = 20+86 = 106, width = 260-86-86 = 88.
    // Left-aligned probe → x = 106, y = 474-24 = 450.
    expect(content).toMatch(/(^|\n)40 0 0 24 106 450 cm/);
    // Right-aligned probe, one row down → x = 106 + (88-40) = 154, y = 426.
    expect(content).toMatch(/(^|\n)40 0 0 24 154 426 cm/);
    // Both boxes painted at their column edges: left at 20, right at 20+260-80 = 200.
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(L1\)/);
    expect(content).toMatch(/(^|\n)200 [\d.]+ Td\s+\(R1\)/);
  });

  it('a channel closed by both bands skips to where it reopens', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // Bands 136 and 126 sum to 262 > columnWidth 260 → the channel is negative.
    const left = doc.NewFloatingBox({ width: 130, spacing: 6 });
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    const right = doc.NewFloatingBox({ width: 120, spacing: 6 });
    right.AddParagraph('R1', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');   // 48 tall, bottom 432
    flow.AddFloatBox(right, 'right'); // 12 tall, top 474, bottom 462
    flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Skips to the right box's bottom (462), where only the left band remains:
    // x = 20+136 = 156, avail = 462-432 = 30 >= 24, y = 462-24 = 438.
    expect(content).toMatch(/(^|\n)40 0 0 24 156 438 cm/);
  });

  it('same-side floats stack vertically instead of overlapping', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // A: 3 paragraphs → 3*12 + 2*6 = 48 tall. Top 480, bottom 432.
    const a = doc.NewFloatingBox({ width: 100, spacing: 6 });
    for (let i = 1; i <= 3; i++) a.AddParagraph(`A${i}`, { fontSize: 10, leading: 12 });
    // B: 2 paragraphs → 2*12 + 6 = 30 tall. Pushed to A.bottom - spacing = 426.
    const b = doc.NewFloatingBox({ width: 60, spacing: 6 });
    for (let i = 1; i <= 2; i++) b.AddParagraph(`B${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Both boxes paint at the column edge (x = 20).
    const a1 = /(?:^|\n)20 ([\d.]+) Td\s+\(A1\)/.exec(content);
    const b1 = /(?:^|\n)20 ([\d.]+) Td\s+\(B1\)/.exec(content);
    expect(a1).not.toBeNull();
    expect(b1).not.toBeNull();
    // B starts strictly below A's bottom edge (432) — before db7v.9 it overlapped.
    expect(Number(a1![1])).toBeGreaterThan(432);
    expect(Number(b1![1])).toBeLessThan(432);
  });

  it('a pushed float leaves the pen alone, so text fills the upper channel first', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const a = doc.NewFloatingBox({ width: 100, spacing: 6 }); // band 106, bottom 432
    for (let i = 1; i <= 3; i++) a.AddParagraph(`A${i}`, { fontSize: 10, leading: 12 });
    const b = doc.NewFloatingBox({ width: 60, spacing: 6 });  // band 66, top 426, bottom 396
    for (let i = 1; i <= 2; i++) b.AddParagraph(`B${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    // Three left-aligned 40x24 images: their x is exactly the channel's left edge.
    for (let i = 0; i < 3; i++) flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Pen still at 480 (B was pushed): first two images sit beside the WIDE box A
    // at x = 20+106 = 126, filling 480→432 exactly (2 * 24).
    expect(content).toMatch(/(^|\n)40 0 0 24 126 456 cm/);
    expect(content).toMatch(/(^|\n)40 0 0 24 126 432 cm/);
    // Third image: A is passed, so the staircase steps left to B's band,
    // x = 20+66 = 86, y = 432-24 = 408.
    expect(content).toMatch(/(^|\n)40 0 0 24 86 408 cm/);
  });

  it('a float too wide to sit beside an opposing float is pushed below it', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const left = doc.NewFloatingBox({ width: 100, spacing: 6 }); // band 106, bottom 432
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    // 106 + 160 = 266 > columnWidth 260 → cannot sit beside; pushed to 432-6 = 426.
    const wide = doc.NewFloatingBox({ width: 160, spacing: 6 });
    wide.AddParagraph('R1', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(wide, 'right');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // x = 20+260-160 = 120, and it starts below the left box's bottom (432).
    const r1 = /(?:^|\n)120 ([\d.]+) Td\s+\(R1\)/.exec(content);
    expect(r1).not.toBeNull();
    expect(Number(r1![1])).toBeLessThan(432);
  });

  it('a float that still fits beside an opposing float stays at the pen', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const left = doc.NewFloatingBox({ width: 100, spacing: 6 }); // band 106
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    // 106 + 140 = 246 <= 260 → sits beside, at the natural top 480-6 = 474.
    const fits = doc.NewFloatingBox({ width: 140, spacing: 6 });
    fits.AddParagraph('R1', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(fits, 'right');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // x = 20+260-140 = 140, and it stays level with the left box (above 432).
    const r1 = /(?:^|\n)140 ([\d.]+) Td\s+\(R1\)/.exec(content);
    expect(r1).not.toBeNull();
    expect(Number(r1![1])).toBeGreaterThan(432);
  });

  it('a stacked float that overruns the column moves to the next page', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // A: 12 paragraphs → 12*12 + 11*6 = 210 tall, bottom 480-210 = 270.
    const a = doc.NewFloatingBox({ width: 100, spacing: 6 });
    for (let i = 1; i <= 12; i++) a.AddParagraph(`A${i}`, { fontSize: 10, leading: 12 });
    // B: 17 paragraphs → 17*12 + 16*6 = 300 tall. Stacked at 270-6 = 264 it would
    // end at -36, below contentBottom 20 → next page, where it starts at 480.
    const b = doc.NewFloatingBox({ width: 100, spacing: 6 });
    for (let i = 1; i <= 17; i++) b.AddParagraph(`B${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    expect(pages[0].GetText()).toContain('A1');
    expect(pages[0].GetText()).not.toContain('B1');
    expect(pages[1].GetText()).toContain('B1');
  });
});

describe('flow floating box tagging', () => {
  const tagged = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, tagged: true,
  });

  it('emits /Figure (with /Alt) and /P for box content, before the wrapping text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(tagged());
    const box = doc.NewFloatingBox({ width: 100, spacing: 4, alt: 'a red dot' });
    box.AddImage(buildPngRgb());
    box.AddParagraph('caption', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph('body text that wraps beside the floated figure box', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const kinds = sect.Children.map((c) => c.Type);
    // Figure and the box caption come before the wrapping paragraph.
    expect(kinds.indexOf('Figure')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('Figure')).toBeLessThan(kinds.lastIndexOf('P'));
    const fig = sect.Children.find((c) => c.Type === 'Figure')!;
    expect(fig.Alt).toBe('a red dot');
    // Box caption /P + wrapping /P → at least two P nodes.
    expect(kinds.filter((k) => k === 'P').length).toBeGreaterThanOrEqual(2);
  });

  it('two stacked floats tag in flow order, before the wrapping text', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(tagged());
    const a = doc.NewFloatingBox({ width: 100, spacing: 6, alt: 'boxA' });
    a.AddImage(buildPngRgb(), { width: 40, height: 24 });
    const b = doc.NewFloatingBox({ width: 100, spacing: 6, alt: 'boxB' });
    b.AddImage(buildPngRgb(), { width: 40, height: 24 });
    flow.AddFloatBox(a, 'left');
    flow.AddFloatBox(b, 'left');
    flow.AddParagraph('body text beside the two stacked boxes', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const kinds = sect.Children.map((c) => c.Type);
    // Both boxes tag, in the order they were floated.
    expect(sect.Children.filter((c) => c.Type === 'Figure').map((c) => c.Alt))
      .toEqual(['boxA', 'boxB']);
    // The wrapping paragraph comes after both.
    expect(kinds.lastIndexOf('P')).toBeGreaterThan(kinds.lastIndexOf('Figure'));
  });

  it('untagged flow (default) creates no structure for a float box', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 500), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 });
    const box = doc.NewFloatingBox({ width: 100 });
    box.AddParagraph('x');
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph('y');
    flow.Render();
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()).toBeNull();
  });
});

import { PageFormat as PageFormatPub, Flow as FlowPub } from '../src/index.js';

describe('doc.NewFlow integration', () => {
  it('creates a Flow bound to the document and renders through it', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 260), marginLeft: 30,
      marginRight: 30, marginTop: 30, marginBottom: 30 });
    flow.AddParagraph('bound to the doc', { font: 'Helvetica', fontSize: 12, leading: 14 });
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(pages[0].GetText()).toContain('bound');
    // Round-trips through save/open.
    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[reopened.Pages.length - 1].GetText()).toContain('bound');
  });

  it('exports PageFormat and Flow from the package index', () => {
    expect(typeof FlowPub).toBe('function');
    expect(PageFormatPub.A4.width).toBe(595);
  });

  it('exports FloatingBox and NewFloatingBox from the package', async () => {
    const mod = await import('../src/index.js');
    expect(typeof (mod as any).FloatingBox).toBe('function');
    const doc = Document.Open(buildBlankPage());
    expect(doc.NewFloatingBox({ width: 50 })).toBeInstanceOf((mod as any).FloatingBox);
  });

  it('AddList is available on a doc-bound flow and renders', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.custom(300, 400),
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20 });
    flow.AddList(['one', 'two'], { ordered: true });
    const [page] = flow.Render();
    expect(page.GetText()).toContain('one');
    expect(page.GetText()).toContain('1.');
  });
});

describe('flow per-element spacing', () => {
  // 400pt tall page, 1 column, so two short paragraphs share a column and we can
  // measure the vertical gap between them from extracted text positions.
  const opts = () => ({
    format: PageFormat.custom(300, 400), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  function topOf(page: import('../src/index.js').Page, needle: string): number {
    const f = page.GetTextFragments().find((fr) => fr.text.includes(needle))!;
    // quad = [x0, y0, x1, y1]; y0 is the baseline row. Larger y = higher on page.
    return f.quad[1];
  }

  it('spaceBefore pushes the following element down by the given points', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow.AddParagraph('BBB', { fontSize: 12, leading: 14, spaceBefore: 30 });
    const [page] = flow.Render();

    const doc2 = Document.Open(buildBlankPage());
    const flow2 = new Flow(doc2, opts());
    flow2.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow2.AddParagraph('BBB', { fontSize: 12, leading: 14 }); // no spaceBefore
    const [page2] = flow2.Render();

    const gapWith = topOf(page, 'AAA') - topOf(page, 'BBB');
    const gapWithout = topOf(page2, 'AAA') - topOf(page2, 'BBB');
    expect(gapWith - gapWithout).toBeCloseTo(30, 3);
  });

  it('spaceAfter of the previous element also pushes the next down', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph('AAA', { fontSize: 12, leading: 14, spaceAfter: 25 });
    flow.AddParagraph('BBB', { fontSize: 12, leading: 14 });
    const [page] = flow.Render();

    const doc2 = Document.Open(buildBlankPage());
    const flow2 = new Flow(doc2, opts());
    flow2.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow2.AddParagraph('BBB', { fontSize: 12, leading: 14 });
    const [page2] = flow2.Render();

    const gapWith = topOf(page, 'AAA') - topOf(page, 'BBB');
    const gapWithout = topOf(page2, 'AAA') - topOf(page2, 'BBB');
    expect(gapWith - gapWithout).toBeCloseTo(25, 3);
  });

  it('drops leading gap at a column top (first element flush at contentTop)', () => {
    // Two columns; a spaceBefore paragraph forced to the top of column 1 must NOT
    // be pushed down by its spaceBefore.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(400, 300), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    });
    flow.AddParagraph('AAA', { fontSize: 12, leading: 14 });
    flow.AddColumnBreak();
    flow.AddParagraph('BBB', { fontSize: 12, leading: 14, spaceBefore: 40 });
    const [page] = flow.Render();
    // BBB is the first element of column 1: its baseline sits within one leading
    // of contentTop (300 - 20 = 280), i.e. spaceBefore was dropped.
    const top = topOf(page, 'BBB');
    expect(top).toBeGreaterThan(280 - 14 - 0.5); // ~266, not pushed 40 lower
  });

  it('rejects negative / non-finite spacing', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddParagraph('x', { spaceBefore: -1 })).toThrow(TypeError);
    expect(() => flow.AddParagraph('x', { spaceAfter: NaN })).toThrow(TypeError);
  });
});

describe('flow headings', () => {
  const opts = () => ({
    format: PageFormat.custom(400, 400), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  function fragOf(page: import('../src/index.js').Page, needle: string) {
    return page.GetTextFragments().find((f) => f.text.includes(needle))!;
  }

  it('level maps to the default size ramp [24,18,14,12,10,8] in Helvetica-Bold', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddHeading(1, 'H1');
    flow.AddHeading(3, 'H3');
    flow.AddHeading(6, 'H6');
    const [page] = flow.Render();
    expect(fragOf(page, 'H1').fontSize).toBeCloseTo(24, 3);
    expect(fragOf(page, 'H3').fontSize).toBeCloseTo(14, 3);
    expect(fragOf(page, 'H6').fontSize).toBeCloseTo(8, 3);
    // Bold default: the rendered heading's /BaseFont is Helvetica-Bold.
    expect(fragOf(page, 'H1').fontName).toBe('Helvetica-Bold');
  });

  it('explicit fontSize/font override the level defaults', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddHeading(2, 'HH', { fontSize: 15, font: 'Times-Bold' });
    const [page] = flow.Render();
    expect(fragOf(page, 'HH').fontSize).toBeCloseTo(15, 3); // 15, not the ramp's 18
    expect(fragOf(page, 'HH').fontName).toBe('Times-Bold');
  });

  it('rejects an out-of-range or non-integer level', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(() => flow.AddHeading(0, 'x')).toThrow(TypeError);
    expect(() => flow.AddHeading(7, 'x')).toThrow(TypeError);
    expect(() => flow.AddHeading(2.5, 'x')).toThrow(TypeError);
  });

  it('is chainable', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    expect(flow.AddHeading(1, 'x')).toBe(flow);
  });
});

describe('flow heading keep-with-next', () => {
  // 200x200, 20pt margins → column height 160 = 8 lines at leading 20.
  const opts = (extra = {}) => ({
    format: PageFormat.custom(200, 200), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, ...extra,
  });
  const L = { font: 'Helvetica' as const, fontSize: 12, leading: 20 };
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `F${i}`).join('\n');
  const page1Has = (pages: any[], s: string) => pages[0].GetText().includes(s);

  it('pushes a heading whose next line will not fit to the next column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);        // fills 7 of 8 slots; one 20pt slot left
    flow.AddHeading(2, 'HEADING', L);       // fits the last slot alone…
    flow.AddParagraph('body', L);           // …but heading+body do not → push both
    const pages = flow.Render();
    expect(pages.length).toBe(2);
    expect(page1Has(pages, 'HEADING')).toBe(false);   // heading pushed off page 1
    expect(pages[1].GetText()).toContain('HEADING');
    expect(pages[1].GetText()).toContain('body');
  });

  it('does not push when the next line fits beneath the heading', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(6), L);        // two slots left: heading + body both fit
    flow.AddHeading(2, 'HEADING', L);
    flow.AddParagraph('body', L);
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(page1Has(pages, 'HEADING')).toBe(true);
    expect(pages[0].GetText()).toContain('body');
  });

  it('per-heading keepWithNext:false disables the push', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', { ...L, keepWithNext: false });
    flow.AddParagraph('body', L);
    const pages = flow.Render();
    expect(page1Has(pages, 'HEADING')).toBe(true); // stays at the column bottom
  });

  it('flow-level keepHeadingsWithNext:false disables it, per-heading true re-enables', () => {
    const off = Document.Open(buildBlankPage());
    const flowOff = new Flow(off, opts({ keepHeadingsWithNext: false }));
    flowOff.AddParagraph(filler(7), L);
    flowOff.AddHeading(2, 'HEADING', L);
    flowOff.AddParagraph('body', L);
    expect(flowOff.Render()[0].GetText()).toContain('HEADING'); // not pushed

    const on = Document.Open(buildBlankPage());
    const flowOn = new Flow(on, opts({ keepHeadingsWithNext: false }));
    flowOn.AddParagraph(filler(7), L);
    flowOn.AddHeading(2, 'HEADING', { ...L, keepWithNext: true }); // override wins
    flowOn.AddParagraph('body', L);
    const pages = flowOn.Render();
    expect(pages[0].GetText().includes('HEADING')).toBe(false);   // pushed
  });

  it('pushes when the following element is a list whose first line will not fit', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    flow.AddList(['listitem'], { fontSize: 12, leading: 20 });
    const pages = flow.Render();
    expect(pages[0].GetText().includes('HEADING')).toBe(false);   // pushed with the list
  });

  it('no-op: a trailing heading (nothing follows) draws in place', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    const pages = flow.Render();
    expect(pages.length).toBe(1);
    expect(pages[0].GetText()).toContain('HEADING');
  });

  it('no-op: a column-break after the heading does not trigger a push', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    flow.AddColumnBreak();
    flow.AddParagraph('body', L);
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('HEADING'); // heading stayed; break moved body
  });

  it('no-op: a float after the heading does not trigger a push', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph(filler(7), L);
    flow.AddHeading(2, 'HEADING', L);
    const box = doc.NewFloatingBox({ width: 80 });
    box.AddParagraph('BX', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    const pages = flow.Render();
    expect(pages[0].GetText()).toContain('HEADING'); // heading not pushed by a float
  });

  it('accepts the orphan without looping when even a full column cannot hold heading+line', () => {
    // Column height 40 = 2 lines; heading (20) + body line (20) = 40 fits a FULL column,
    // so make the body two lines tall so heading+body never co-fit any column.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(200, 80), columns: 1,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20, // height 40 = 2 lines
    });
    flow.AddHeading(2, 'HEADING', L);                 // heading at a fresh column start
    flow.AddParagraph('one\ntwo\nthree', L);          // 3 lines: never co-fits
    const pages = flow.Render();                      // must terminate, not loop/throw
    expect(pages[0].GetText()).toContain('HEADING');  // drawn at column start (orphan accepted)
  });

  it('folds spaceAfter/spaceBefore into the one-line check', () => {
    // 6-line filler leaves two 20pt slots. Without spacing, heading+body fit (no push).
    // A 5pt spaceAfter on the heading pushes body's baseline past the last slot → push.
    const push = Document.Open(buildBlankPage());
    const flow = new Flow(push, opts());
    flow.AddParagraph(filler(6), L);                  // two slots: without spacing, no push
    flow.AddHeading(2, 'HEADING', { ...L, spaceAfter: 5 });
    flow.AddParagraph('body', L);
    expect(flow.Render()[0].GetText().includes('HEADING')).toBe(false); // pushed
  });

  it('validates the policy options', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => new Flow(doc, opts({ keepHeadingsWithNext: 'yes' as any }))).toThrow(TypeError);
    const flow = new Flow(Document.Open(buildBlankPage()), opts());
    expect(() => flow.AddHeading(2, 'x', { keepWithNext: 1 as any })).toThrow(TypeError);
  });
});

describe('flow logical-structure tagging', () => {
  const opts = (tagged: boolean) => ({
    format: PageFormat.custom(400, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
    tagged,
  });

  it('tags heading then paragraph as /H2, /P in reading order (round-trip)', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts(true));
    flow.AddHeading(2, 'The Heading');
    flow.AddParagraph('The body paragraph text.');
    const [page] = flow.Render();

    // BDC/EMC pair emitted around the tagged bodies.
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toContain('BDC');
    expect(content).toContain('EMC');

    const re = Document.Open(doc.Save());
    const root = re.GetStructTree()!;
    expect(root.GetText()).toContain('The Heading');
    expect(root.GetText()).toContain('The body paragraph text.');
    const rePage = re.Pages[re.Pages.length - 1];
    const spKey = re.resolve(rePage.Dict.get('StructParents')) as number;
    expect(root.ElementFor(spKey, 0)!.Type).toBe('H2');
    expect(root.ElementFor(spKey, 1)!.Type).toBe('P');
  });

  it('untagged flow (default) creates no structure tree and no /StructParents', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts(false));
    flow.AddHeading(2, 'Heading');
    flow.AddParagraph('Body.');
    const [page] = flow.Render();
    expect(page.Dict.has('StructParents')).toBe(false);
    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()).toBeNull();
  });

  it('a heading spanning a column boundary yields one struct element (MCR)', () => {
    // Force the heading to overflow one column into the next via a 2-column page.
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, {
      format: PageFormat.custom(360, 140), columns: 2, columnGap: 20,
      marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
      tagged: true,
    });
    const many = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    flow.AddHeading(3, many, { fontSize: 12, leading: 14 });
    flow.Render();
    const root = doc.CreateStructTree(); // reuses the one Render created
    // Exactly one /Sect with exactly one /H3 child, even though it drew on two columns.
    const sect = root.Children.find((c) => c.Type === 'Sect')!;
    const headings = sect.Children.filter((c) => c.Type === 'H3');
    expect(headings.length).toBe(1);
  });

  it('empty text in a tagged flow creates no struct element', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = new Flow(doc, opts(true));
    flow.AddParagraph('');
    flow.AddParagraph('Real text.');
    flow.Render();
    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    // Only the non-empty paragraph produced a /P; the empty one made no node.
    expect(sect.Children.filter((c) => c.Type === 'P').length).toBe(1);
  });
});

describe('flow float clearing', () => {
  const opts = () => ({
    format: PageFormat.custom(300, 500), columns: 1,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  /** Left box 84 tall (bottom 396, band 86) + right box 48 tall (top 474,
   *  bottom 426, band 86). Channel between them: x 106, width 88. */
  const twoFloats = (doc: Document, flow: Flow) => {
    const left = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 5; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    const right = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 3; i++) right.AddParagraph(`R${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(right, 'right');
  };

  it('without clear, a heading sits in the channel between the floats', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    twoFloats(doc, flow);
    flow.AddHeading(2, 'SECTION', { fontSize: 10 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Channel left edge = 20 + 86 = 106; above the deeper float bottom (426).
    const m = /(?:^|\n)106 ([\d.]+) Td\s+\(SECTION\)/.exec(content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(426);
  });

  it("clear: 'both' drops the element below every float", () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    twoFloats(doc, flow);
    flow.AddHeading(2, 'SECTION', { fontSize: 10, clear: 'both' });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Cleared to the lowest bottom (396) → full column width, x = 20.
    const m = /(?:^|\n)20 ([\d.]+) Td\s+\(SECTION\)/.exec(content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(396);
  });

  it('clearing moves the pen only: spaceBefore still applies', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    twoFloats(doc, flow);
    flow.AddHeading(2, 'SECTION', { fontSize: 10, clear: 'both', spaceBefore: 20 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Cleared to 396, then the 20pt gap applies → top 376, baseline 366. Were a
    // cleared element treated as sitting at a column top, the gap would be
    // dropped and the baseline would be 386.
    const m = /(?:^|\n)20 ([\d.]+) Td\s+\(SECTION\)/.exec(content);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThan(380);
  });

  it("clear: 'left' leaves a deeper right float in force", () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    // Left 48 tall (bottom 432, band 86); right 138 tall (top 474, bottom 336).
    const left = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 3; i++) left.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    const right = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 8; i++) right.AddParagraph(`R${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(left, 'left');
    flow.AddFloatBox(right, 'right');
    // Both probes: the left one proves the left float cleared, the right one
    // proves the right float did NOT (a full-width region would put it at 240).
    flow.AddImage(buildPngRgb(), { align: 'left', width: 40, height: 24, clear: 'left' });
    flow.AddImage(buildPngRgb(), { align: 'right', width: 40, height: 24 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Cleared to 432: x = 20 (left band gone), y = 432-24 = 408.
    expect(content).toMatch(/(^|\n)40 0 0 24 20 408 cm/);
    // Still inside the right band: width 174 → x = 20 + (174-40) = 154, y = 384.
    expect(content).toMatch(/(^|\n)40 0 0 24 154 384 cm/);
  });

  it('clear on a list applies to the first item only', () => {
    const els = list(['a', 'b'], { clear: 'left' });
    expect(els[0].clear).toBe('left');
    expect(els[1].clear).toBeUndefined();
  });

  it('clear drops the whole list below the float', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    const box = doc.NewFloatingBox({ width: 80, spacing: 6 }); // band 86, bottom 432
    for (let i = 1; i <= 3; i++) box.AddParagraph(`L${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    // Explicit indent keeps the body x metric-free: cleared → 20+30 = 50.
    flow.AddList(['ITEMA', 'ITEMB'], { clear: 'left', indent: 30, fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toMatch(/(^|\n)50 [\d.]+ Td\s+\(ITEMA\)/);
  });

  it('clear is a no-op with no active floats', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    flow.AddParagraph('SOLO', { fontSize: 10, leading: 12, clear: 'both' });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(SOLO\)/);
  });

  it('rejects an invalid clear value', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(opts());
    expect(() => flow.AddParagraph('x', { clear: 'sideways' as never })).toThrow(TypeError);
    expect(() => flow.AddImage(buildPngRgb(), { clear: 'up' as never })).toThrow(TypeError);
    expect(() => flow.AddList(['a'], { clear: 'down' as never })).toThrow(TypeError);
  });
});

describe('flow deferred-float carry', () => {
  const twoCol = () => ({
    format: PageFormat.custom(400, 300), columns: 2, columnGap: 20,
    marginLeft: 20, marginRight: 20, marginTop: 20, marginBottom: 20,
  });

  /** A box 246pt tall — fits an empty 260pt column, not the ~244 left after a
   *  line of text. Paragraph labels are prefixed so tests can tell boxes apart. */
  const tallBox = (doc: Document, label: string) => {
    const box = doc.NewFloatingBox({ width: 80, spacing: 6 });
    for (let i = 1; i <= 14; i++) box.AddParagraph(`${label}${i}`, { fontSize: 10, leading: 12 });
    return box;
  };

  it('a deferred float no longer drags following content out of the column', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(twoCol());
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(tallBox(doc, 'X'), 'left');
    flow.AddParagraph('AFTER', { fontSize: 10, leading: 12 });
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Column 1 (x=20) keeps filling: AFTER stays there instead of following the
    // float into column 2 (where it used to land beside the box at x=296).
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(FIRST\)/);
    expect(content).toMatch(/(^|\n)20 [\d.]+ Td\s+\(AFTER\)/);
    // The box itself lands at the top of column 2 (x=210).
    expect(content).toMatch(/(^|\n)210 [\d.]+ Td\s+\(X1\)/);
  });

  it('a float deferred by the last element is still drawn', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(twoCol());
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(tallBox(doc, 'X'), 'left');
    const [page] = flow.Render();
    const content = new TextDecoder('latin1').decode(page.Contents);
    // Nothing follows the float, so only the trailing flush can place it.
    expect(content).toMatch(/(^|\n)210 [\d.]+ Td\s+\(X1\)/);
  });

  it('two floats deferred from one column land on successive columns', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow(twoCol());
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(tallBox(doc, 'X'), 'left');
    flow.AddFloatBox(tallBox(doc, 'Y'), 'left');
    flow.AddParagraph('AFTER', { fontSize: 10, leading: 12 });
    const pages = flow.Render();
    expect(pages).toHaveLength(2);
    // X takes column 2 of page 1; Y cannot stack under it, so it carries again
    // to column 1 of page 2.
    const p1 = new TextDecoder('latin1').decode(pages[0].Contents);
    const p2 = new TextDecoder('latin1').decode(pages[1].Contents);
    expect(p1).toMatch(/(^|\n)210 [\d.]+ Td\s+\(X1\)/);
    expect(p2).toMatch(/(^|\n)20 [\d.]+ Td\s+\(Y1\)/);
    // Both deferrals leave column 1 usable, so AFTER stays on page 1 at x=20.
    // Without carry it follows the boxes to page 2 and wraps beside Y at x=106.
    expect(p1).toMatch(/(^|\n)20 [\d.]+ Td\s+\(AFTER\)/);
  });

  it('a deferred float tags in draw order, after the text that outran it', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ ...twoCol(), tagged: true });
    const box = doc.NewFloatingBox({ width: 80, spacing: 6, alt: 'carried' });
    for (let i = 1; i <= 14; i++) box.AddParagraph(`X${i}`, { fontSize: 10, leading: 12 });
    flow.AddParagraph('FIRST', { fontSize: 10, leading: 12 });
    flow.AddFloatBox(box, 'left');
    flow.AddParagraph('AFTER', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.CreateStructTree().Children.find((c) => c.Type === 'Sect')!;
    const kinds = sect.Children.map((c) => c.Type);
    // Structure is appended when content draws, and the deferred box draws last,
    // so its paragraphs follow both flow paragraphs. Reading order tracks visual
    // order, not call order — see the design's "Accepted consequence".
    expect(kinds.filter((k) => k === 'P').length).toBeGreaterThanOrEqual(3);
    expect(kinds.lastIndexOf('P')).toBeGreaterThan(1);
  });
});

describe('Flow.AddFloatingBox (in-flow)', () => {
  it('places the box in column order and consumes its own height', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.A4, marginLeft: 50, marginRight: 50, marginTop: 50, marginBottom: 50, paragraphSpacing: 0 });
    const box = doc.NewFloatingBox({ width: 200, padding: 0 });
    box.AddParagraph('boxed', { fontSize: 10, leading: 12 });
    flow.AddParagraph('before', { fontSize: 10, leading: 12 });
    flow.AddFloatingBox(box);
    flow.AddParagraph('after', { fontSize: 10, leading: 12 });
    const pages = flow.Render();

    const frags = pages[0].GetTextFragments();
    const y = (t: string) => frags.find((f) => f.text.includes(t))!.quad[3];
    // Strictly stacked: no text sits beside the box, unlike a side float.
    expect(y('before')).toBeGreaterThan(y('boxed'));
    expect(y('boxed')).toBeGreaterThan(y('after'));
    // 'after' clears the whole box height, not just one line.
    expect(y('boxed') - y('after')).toBeGreaterThanOrEqual(12 - 0.01);
  });

  it('moves a box that does not fit to the next column, intact', () => {
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({
      format: PageFormat.A4, marginLeft: 50, marginRight: 50, marginTop: 50, marginBottom: 50, columns: 2, columnGap: 20, paragraphSpacing: 0,
    });
    const box = doc.NewFloatingBox({ width: 100, padding: 0 });
    for (let i = 0; i < 6; i++) box.AddParagraph(`line${i}`, { fontSize: 10, leading: 12 });
    // Column height is 842 - 2*50 = 742pt, so 61 lines of 12pt leave 10pt —
    // less than the box's 72, which is what forces it to the next column.
    for (let i = 0; i < 61; i++) flow.AddParagraph(`fill${i}`, { fontSize: 10, leading: 12 });
    flow.AddFloatingBox(box);
    const pages = flow.Render();

    const frags = pages[0].GetTextFragments();
    const xs = frags.filter((f) => /^line\d$/.test(f.text.trim())).map((f) => f.quad[0]);
    expect(xs.length).toBe(6);                       // every line of the box drawn
    const col2Left = 50 + (595 - 100 - 20) / 2 + 20;
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(col2Left - 1);  // all in column 2
    // Intact: one contiguous run, not split across the column boundary.
    const ys = frags.filter((f) => /^line\d$/.test(f.text.trim()))
      .map((f) => f.quad[3]).sort((a, b) => b - a);
    expect(ys[0] - ys[5]).toBeCloseTo(5 * 12, 0);
  });

  it('emits the box /Figure in reading order in a tagged flow', () => {
    const doc = Document.Open(buildBlankPage());
    doc.CreateStructTree();
    const flow = doc.NewFlow({ format: PageFormat.A4, marginLeft: 50, marginRight: 50, marginTop: 50, marginBottom: 50, tagged: true });
    const box = doc.NewFloatingBox({ width: 200, padding: 0 });
    box.AddParagraph('inside', { fontSize: 10, leading: 12 });
    flow.AddParagraph('before', { fontSize: 10, leading: 12 });
    flow.AddFloatingBox(box);
    flow.AddParagraph('after', { fontSize: 10, leading: 12 });
    flow.Render();

    const sect = doc.GetStructTree()!.Children.find((c) => c.Type === 'Sect')!;
    const types = sect.Children.map((c) => c.Type);
    expect(types).toEqual(['P', 'P', 'P']);          // before, box paragraph, after
    expect(sect.GetText()).toMatch(/before[\s\S]*inside[\s\S]*after/);
  });

  it('rejects a non-FloatingBox', () => {
    // Not /FloatingBox/: "flow.AddFloatingBox is not a function" contains it.
    const doc = Document.Open(buildBlankPage());
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    expect(() => flow.AddFloatingBox({ width: 10 } as never))
      .toThrow(/must be a FloatingBox/);
  });
});

describe('element builders', () => {
  it('every builder returns an array of elements', () => {
    expect(paragraph('hi')).toHaveLength(1);
    expect(heading(2, 'hi')).toHaveLength(1);
    expect(list(['a', 'b'])).toHaveLength(2);
    expect(image(buildPngRgb())).toHaveLength(1);
  });

  it('heading applies the level default size and bold face', () => {
    // 24pt is HEADING_SIZES[0]; a 1-line H1 consumes 1.2 * 24 of leading.
    const [h1] = heading(1, 'Title');
    expect(h1.measure!({ width: 400, availHeight: 400 }).usedHeight).toBeCloseTo(28.8, 6);
    const [h3] = heading(3, 'Title');
    expect(h3.measure!({ width: 400, availHeight: 400 }).usedHeight).toBeCloseTo(16.8, 6);
  });

  it('heading rejects an out-of-range level before building anything', () => {
    expect(() => heading(0, 'x')).toThrow(TypeError);
    expect(() => heading(7, 'x')).toThrow(TypeError);
    expect(() => heading(1.5, 'x')).toThrow(TypeError);
  });

  it('AddHeading and heading() produce the same bytes', () => {
    const viaMethod = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      flow.AddHeading(2, 'Same Title');
      return flow.Render()[0].Contents;
    })();
    const viaBuilder = (() => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      for (const el of heading(2, 'Same Title')) (flow as never as { items: unknown[] }).items.push(el);
      return flow.Render()[0].Contents;
    })();
    expect(Buffer.from(viaBuilder).equals(Buffer.from(viaMethod))).toBe(true);
  });
});

describe('PlaceContext.paragraphSpacing', () => {
  it('Render reports the flow gap to every element it places', () => {
    const seen: (number | undefined)[] = [];
    const probe = {
      place(ctx: import('../src/flowelement.js').PlaceContext) {
        seen.push(ctx.paragraphSpacing);
        return { usedHeight: 10, remainder: null, drew: true };
      },
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, paragraphSpacing: 7 });
    (flow as never as { items: unknown[] }).items.push(probe, probe);
    flow.Render();
    expect(seen).toEqual([7, 7]);
  });
});
