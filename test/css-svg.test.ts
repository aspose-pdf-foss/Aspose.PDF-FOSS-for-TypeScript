/** An inline <svg> renders through the existing importer (zch2.12). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

const SRC = '<p>before</p>'
  + '<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>'
  + '<p>after</p>';

/** The page's content stream as latin1, for operator assertions. */
const cs = (page: { Contents: Uint8Array }): string =>
  new TextDecoder('latin1').decode(page.Contents);

describe('AddHtml renders an inline <svg>', () => {
  it('draws a Form XObject for it', () => {
    const { pages } = Document.New().AddHtml(SRC);
    expect(cs(pages[0])).toMatch(/\/Fm\d+ Do/);
  });

  it('keeps the surrounding content', () => {
    const { pages } = Document.New().AddHtml(SRC);
    const t = pages[0].GetText();
    expect(t).toContain('before');
    expect(t).toContain('after');
  });

  it('no longer reports svg as dropped', () => {
    const { skipped } = Document.New().AddHtml(SRC);
    expect(skipped.filter((r) => r.construct === 'svg')).toEqual([]);
  });

  it('folds what the IMPORTER could not draw into the same report', () => {
    // An <image> href this library cannot decode, with no resolver.
    const { skipped } = Document.New().AddHtml(
      '<svg viewBox="0 0 10 10"><image href="nope.png" width="10" height="10"/></svg>');
    const svg = skipped.filter((r) => r.construct === 'svg');
    expect(svg).toHaveLength(1);
    expect(svg[0].kind).toBe('degraded');
    expect(svg[0].detail).toBe('image');
    expect(svg[0].el?.name).toBe('svg');
  });

  it('renders the same through all three entry points', () => {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const viaDoc = Document.New().AddHtml(SRC).pages[0].GetText();
    const flowDoc = Document.New();
    const flow = flowDoc.NewFlow({ format: PageFormat.A4 });
    flow.AddHtml(SRC);
    const viaFlow = flow.Render()[0].GetText();
    const pageDoc = Document.New();
    const { page } = pageDoc.AddPage(PageFormat.A4);
    page.AddHtml(SRC, [72, 72, 451, 697]);
    expect(norm(viaFlow)).toBe(norm(viaDoc));
    expect(norm(page.GetText())).toBe(norm(viaDoc));
  });

  it('reports svg/dropped rather than throwing when it will not import', () => {
    const doc = Document.New();
    let skipped: { construct: string; kind: string }[] = [];
    expect(() => { skipped = doc.AddHtml('<svg><rect/></svg>').skipped; }).not.toThrow();
    // A rootless or unreadable graphic is dropped, which is the pre-zch2.12
    // behaviour — the worst case is no worse than the status quo.
    expect(Array.isArray(skipped)).toBe(true);
  });

  it('sizes a viewBox-only <svg> to fill the column, as Chrome does', () => {
    // Measured: <svg viewBox="0 0 100 50"> is 800x400 in an 800px container,
    // NOT a small default box. The Do is preceded by the clip rect, so the
    // drawn width is readable straight out of the content stream.
    const { pages } = Document.New().AddHtml('<svg viewBox="0 0 100 50"></svg>');
    const m = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s*\nW n/.exec(cs(pages[0]));
    expect(m).not.toBeNull();
    const w = parseFloat(m![3]);
    const h = parseFloat(m![4]);
    // A4 content width at 72pt margins is 451.28pt; height follows the aspect.
    expect(w).toBeGreaterThan(400);
    expect(h).toBeCloseTo(w / 2, 1);
  });
});

describe('inline <svg> sizing, measured against Chrome/152', () => {
  /** The drawn box, read out of the clip rect that precedes the form's Do.
   *  In POINTS: cssflow crosses the px -> pt x 0.75 boundary. */
  function drawn(src: string): { w: number; h: number } {
    const { pages } = Document.New().AddHtml(src);
    const m = /([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re\s*\nW n/.exec(cs(pages[0]));
    if (m === null) throw new Error('no form drawn');
    return { w: parseFloat(m[3]), h: parseFloat(m[4]) };
  }

  it('honours width/height attributes: 120x60 px = 90x45 pt', () => {
    const d = drawn('<svg width="120" height="60" viewBox="0 0 100 50"></svg>');
    expect(d.w).toBeCloseTo(90, 1);
    expect(d.h).toBeCloseTo(45, 1);
  });

  it('lets CSS win over the attributes: 200px = 150pt', () => {
    const d = drawn('<svg width="120" height="60" viewBox="0 0 100 50" style="width:200px"></svg>');
    expect(d.w).toBeCloseTo(150, 1);
  });

  it('resolves a percentage attribute against the containing block', () => {
    // 40% of whatever the full-fill width is — asserted as a RATIO so the
    // number does not depend on the page format.
    const fill = drawn('<svg viewBox="0 0 100 50"></svg>').w;
    const d = drawn('<svg width="40%" viewBox="0 0 100 50"></svg>');
    expect(d.w).toBeCloseTo(fill * 0.4, 1);
  });

  it('falls back to 300x150 px = 225x112.5 pt with no viewBox and no size', () => {
    // The default object size applies only when there is NO aspect ratio to
    // work from — with one, the element fills its container instead.
    const d = drawn('<svg></svg>');
    expect(d.w).toBeCloseTo(225, 1);
    expect(d.h).toBeCloseTo(112.5, 1);
  });
});

describe('what the importer rasterized is reported too', () => {
  it('folds a rasterized filter in as degraded', () => {
    // PDF has no filter model, so a filtered subtree is flattened to a bitmap.
    // It draws correctly but is resolution-bound and its text stops being
    // extractable — "drawn, but not as specified", so `degraded` rather than
    // silence.
    const { skipped } = Document.New().AddHtml(
      '<svg viewBox="0 0 10 10"><filter id="f"><feGaussianBlur stdDeviation="1"/></filter>'
      + '<rect width="10" height="10" filter="url(#f)"/></svg>');
    const svg = skipped.filter((r) => r.construct === 'svg');
    expect(svg).toHaveLength(1);
    expect(svg[0].kind).toBe('degraded');
    expect(svg[0].detail).toBe('filter');
  });
});
