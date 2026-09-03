import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { lowerHtml, PT_PER_PX } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';
import type { Page } from '../src/page.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';

/** The report as the flat strings, which is what most assertions want. */
const names = (skipped: NotRendered[]): string[] => skipped.map(describeReport);

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;
/** Map a source at a width in POINTS. */
function map(src: string, width = 600) {
  return lowerHtml(parseHtml(`<!doctype html>${src}`), { width, resolveFamily });
}
/** Map and place into a rect, handing back the page for inspection. */
function place(src: string, width = 600): Page {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src, width);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return page;
}
const text = (src: string, width = 600): string => place(src, width).GetText();
describe('the mapping', () => {
  it('turns an inline-content block into one element carrying its text', () => {
    expect(text('<p>hello world</p>')).toContain('hello world');
  });
  it('produces a FLAT array — a nested box adds decorators, not a tree', () => {
    const { elements } = map('<div><p>a</p><p>b</p><p>c</p></div>');
    expect(elements).toHaveLength(3);
    for (const el of elements) expect(typeof el.place).toBe('function');
  });
  it('emits nothing for display:none, and no text either', () => {
    const { elements } = map('<p>a</p><p style="display:none">b</p><p>c</p>');
    expect(elements).toHaveLength(2);
    expect(text('<p>a</p><p style="display:none">b</p><p>c</p>')).not.toContain('b');
  });
  it('keeps document order through a nested container', () => {
    const t = text('<p>one</p><div><p>two</p><div><p>three</p></div></div><p>four</p>');
    expect(t.indexOf('one')).toBeLessThan(t.indexOf('two'));
    expect(t.indexOf('two')).toBeLessThan(t.indexOf('three'));
    expect(t.indexOf('three')).toBeLessThan(t.indexOf('four'));
  });
});
describe('units: CSS px to points', () => {
  it('scales every run font size by 0.75', () => {
    // 16px is the initial font-size, so a bare <p> must reach Flow at 12pt.
    // Leaving the scale out renders 33% too large, which looks deliberate.
    const [frag] = place('<p>x</p>').GetTextFragments();
    expect(frag.fontSize).toBeCloseTo(16 * PT_PER_PX, 4);
  });
  it('scales a margin into the collapsed gap', () => {
    // 40px between two paragraphs collapses to 40px = 30pt.
    const { elements } = map('<p style="margin:0 0 40px 0">a</p><p style="margin:0">b</p>');
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
});
describe('collapsed margins reach Flow as spaceBefore', () => {
  it('puts the whole gap in spaceBefore and zeroes every spaceAfter', () => {
    // TWO DIFFERENT GAPS, on purpose. A uniform list totals identically under
    // spaceAfter, so it cannot tell the two readings apart.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p>'
      + '<p style="margin:0 0 12px 0">b</p>'
      + '<p style="margin:0">c</p>');
    expect(elements).toHaveLength(3);
    expect(elements[0].spaceBefore ?? 0).toBeCloseTo(0, 6);
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
    expect(elements[2].spaceBefore).toBeCloseTo(12 * PT_PER_PX, 4);
    for (const el of elements) expect(el.spaceAfter ?? 0).toBe(0);
  });
  it('combines two adjoining margins rather than adding them', () => {
    // 40px bottom against 20px top collapses to 40px = 30pt, not 60px.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p><p style="margin:20px 0 0 0">b</p>');
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
  it('carries a gap forward across a box that produced no elements', () => {
    // The middle box contributes no ELEMENT, so its gap must land on the box
    // after it rather than being dropped.
    //
    // A ROW-LESS TABLE is the fixture, and an empty <div> is NOT — measured.
    // cssmargin.ts already routes an empty block's margin onto the following
    // box itself (it pushes a 0 gap and continues the pending run), so that
    // shape never reaches this code at all and passes with the carry deleted.
    // `isEmpty` returns false for ANY table box (cssmargin.ts:80), so a table
    // with no rows has its gap emitted against a box that then produces
    // nothing — which is what a SKIPPED table used to be, before zch2.6 made
    // tables render.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p>'
      + '<table style="margin:0"></table>'
      + '<p style="margin:0">b</p>');
    expect(elements).toHaveLength(2);
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
  it('routes an empty block\'s margin through cssmargin, not through the carry', () => {
    // The companion to the case above: this one is zch2.3's rule reaching
    // through unchanged, and it is why it cannot stand in for the carry.
    const { elements } = map(
      '<p style="margin:0 0 40px 0">a</p>'
      + '<div style="margin:0"></div>'
      + '<p style="margin:0">b</p>');
    expect(elements).toHaveLength(2);
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
});
describe('the frame reaches the page', () => {
  it('indents content by a block box padding', () => {
    const [frag] = place(
      '<div style="padding-left:40px"><p style="margin:0">x</p></div>').GetTextFragments();
    // 40px = 30pt from the rect's left edge, plus body's own UA 8px margin.
    expect(frag.quad[0]).toBeCloseTo(20 + 8 * PT_PER_PX + 40 * PT_PER_PX, 3);
  });
  it('paints a block background', () => {
    const body = new TextDecoder('latin1')
      .decode(place('<div style="background:#ff0000"><p>x</p></div>').Contents);
    expect(body).toMatch(/1 0 0 rg/);
  });
  it('paints a border only where its style is not none', () => {
    // The initial border-style is `none` and the initial width `medium` (3px),
    // so every box in every document carries a computed 3px border. Painting
    // it would put a rule around everything.
    const plain = new TextDecoder('latin1')
      .decode(place('<div><p>x</p></div>').Contents);
    expect(plain).not.toMatch(/ re/);
    const ruled = new TextDecoder('latin1')
      .decode(place('<div style="border:2px solid #00ff00"><p>x</p></div>').Contents);
    expect(ruled).toMatch(/0 1 0 rg/);
  });
});
describe('text block options come from the cascade', () => {
  it('carries text-align through to the element', () => {
    const [frag] = place('<p style="text-align:right;margin:0">x</p>').GetTextFragments();
    // Right-aligned: the glyph sits near the right edge, not the left.
    expect(frag.quad[0]).toBeGreaterThan(20 + 300);
  });
});
describe('tables (zch2.6)', () => {
  /** The y of the first fragment whose text contains `s`. */
  const yOf = (page: Page, s: string): number => {
    const f = page.GetTextFragments().find((x) => x.text.includes(s));
    if (f === undefined) throw new Error(`no fragment for ${s}`);
    return f.quad[1];
  };
  it('emits a table element rather than reporting it skipped', () => {
    const { elements, skipped } = map('<table><tr><td>a</td><td>b</td></tr></table>');
    expect(names(skipped)).not.toContain('table');
    expect(elements.length).toBeGreaterThan(0);
  });
  it('draws every cell of the table', () => {
    const t = text('<table><tr><td>alpha</td><td>beta</td></tr></table>');
    expect(t).toContain('alpha');
    expect(t).toContain('beta');
  });
  it('emits the caption BEFORE the table', () => {
    // TableBuilder has no caption vocabulary, so the caption is an ordinary
    // paragraph; dropping it would lose its text. ORDER is asserted on the
    // y coordinate, because element count cannot see it — a caption emitted
    // after the table still gives two elements.
    const src = '<table><caption>Cap</caption><tr><td>cell</td></tr></table>';
    expect(names(map(src).skipped)).not.toContain('table');
    const page = place(src);
    expect(yOf(page, 'Cap')).toBeGreaterThan(yOf(page, 'cell'));
  });
  it('produces NO element for an empty table and carries its gap forward', () => {
    // The gap of a box that produces no element must land on the next box
    // that does, or the space disappears — the rule mapSiblings already has
    // for a skipped table.
    const { elements } = map('<table></table><p>after</p>');
    expect(elements.length).toBe(1);
    expect(text('<table></table><p>after</p>')).toContain('after');
  });
  it("spends the table's collapsed top margin as its spaceBefore", () => {
    // The gap reaches Flow through spaceBefore alone — flow.ts ADDS
    // `spaceAfter + paragraphSpacing + spaceBefore` rather than collapsing —
    // so a table that drops it closes up against the paragraph above it.
    const { elements } = map('<p style="margin:0 0 40px 0">a</p>'
      + '<table style="margin:0"><tr><td>x</td></tr></table>');
    expect(elements).toHaveLength(2);
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
  });
  it('spends it on the CAPTION when there is one, not on the table', () => {
    // Whichever comes first owns the gap; charging both would double it.
    const { elements } = map('<p style="margin:0 0 40px 0">a</p>'
      + '<table style="margin:0"><caption>Cap</caption>'
      + '<tr><td>x</td></tr></table>');
    expect(elements[1].spaceBefore).toBeCloseTo(40 * PT_PER_PX, 4);
    expect(elements[2].spaceBefore).toBe(0);
  });
  it('keeps a spanning cell beside its row', () => {
    const t = text('<table><tr><td colspan=2>wide</td></tr>'
      + '<tr><td>x</td><td>y</td></tr></table>');
    for (const w of ['wide', 'x', 'y']) expect(t).toContain(w);
  });
});