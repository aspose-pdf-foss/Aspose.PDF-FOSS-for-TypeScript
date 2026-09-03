import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { lowerHtml } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';
import type { StructElement } from '../src/struct.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;

const map = (src: string, width = 600) =>
  lowerHtml(parseHtml(`<!doctype html>${src}`), { width, resolveFamily });

/** Place into a TAGGED document and hand back every structure type, in
 *  document order. */
function structTypes(src: string): string[] {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const sect = doc.CreateStructTree().Append('Sect');
  const { elements } = map(src);
  placeElements(doc, page, elements, [20, 20, 600, 750],
    { paragraphSpacing: 0, structParent: sect });
  const out: string[] = [];
  const walk = (el: StructElement): void => {
    out.push(el.Type);
    for (const k of el.Children) {
      if (typeof k === 'object' && k !== null && 'Type' in k) walk(k as StructElement);
    }
  };
  walk(sect);
  return out;
}

function text(src: string, width = 600): string {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src, width);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return page.GetText();
}

function fragments(src: string, width = 600) {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src, width);
  placeElements(doc, page, elements, [20, 20, width, 750], { paragraphSpacing: 0 });
  return page.GetTextFragments();
}

describe('headings', () => {
  it('routes h1..h6 through heading(), so a tagged flow gets /H1../H6', () => {
    // paragraph() emits /P for every one of these — a silent loss, since the
    // rendering is identical.
    expect(structTypes('<h1>a</h1>')).toContain('H1');
    expect(structTypes('<h3>a</h3>')).toContain('H3');
    expect(structTypes('<p>a</p>')).toContain('P');
  });

  it('makes a heading eligible for keep-with-next and a paragraph not', () => {
    const { elements } = map('<h2>a</h2><p>b</p>');
    expect(elements[0].keepWithNextEligible).toBe(true);
    expect(elements[1].keepWithNextEligible ?? false).toBe(false);
  });

  it('uses the CASCADE font size, not the builder default', () => {
    // heading() defaults h1 to 24pt and the UA sheet says 2em = 32px = 24pt,
    // so h1 cannot separate the two. h3 can: the UA sheet gives 1.17em =
    // 18.72px = 14.04pt against the builder's flat 14pt.
    const [frag] = fragments('<h3>x</h3>');
    expect(frag.fontSize).toBeCloseTo(18.72 * 0.75, 3);
  });

  it('honours an author font-size over the UA sheet', () => {
    const [frag] = fragments('<h1 style="font-size:40px">x</h1>');
    expect(frag.fontSize).toBeCloseTo(30, 3);
  });
});

describe('lists', () => {
  it('renders a bullet list with its items', () => {
    const t = text('<ul><li>alpha</li><li>bravo</li></ul>');
    expect(t).toContain('alpha');
    expect(t).toContain('bravo');
  });

  it('numbers an ordered list continuously — ONE list(), not one per item', () => {
    // A list() per item restarts the counter, so every marker reads "1.".
    const t = text('<ol><li>alpha</li><li>bravo</li><li>charlie</li></ol>');
    expect(t).toContain('1.');
    expect(t).toContain('2.');
    expect(t).toContain('3.');
  });

  it('honours <ol start>', () => {
    const t = text('<ol start=5><li>alpha</li><li>bravo</li></ol>');
    expect(t).toContain('5.');
    expect(t).toContain('6.');
  });

  it('does not number an unordered list', () => {
    expect(text('<ul><li>alpha</li><li>bravo</li></ul>')).not.toContain('1.');
  });

  it('splits two lists separated by a paragraph, restarting the second', () => {
    const t = text('<ol><li>a</li><li>b</li></ol><p>mid</p><ol><li>c</li></ol>');
    expect(t).toContain('mid');
    // The second list restarts at 1, so "1." appears twice.
    expect(t.match(/1\./g)?.length).toBe(2);
  });

  it('emits /L > /LI > /LBody in a tagged flow', () => {
    const types = structTypes('<ul><li>a</li></ul>');
    expect(types).toContain('L');
    expect(types).toContain('LI');
    expect(types).toContain('LBody');
  });

  it('nests a sub-list through the item blocks', () => {
    const t = text('<ul><li>outer<ul><li>inner</li></ul></li></ul>');
    expect(t).toContain('outer');
    expect(t).toContain('inner');
  });

  it('keys on display:list-item, not on the ul/ol tag', () => {
    expect(text('<div><span style="display:list-item">alpha</span></div>'))
      .toContain('alpha');
  });

  it('keeps a paragraph after a list out of it', () => {
    const { elements } = map('<ul><li>a</li></ul><p>after</p>');
    // The trailing paragraph is its own element, not an item.
    expect(elements.length).toBeGreaterThan(1);
    expect(text('<ul><li>a</li></ul><p>after</p>')).toContain('after');
  });
});
