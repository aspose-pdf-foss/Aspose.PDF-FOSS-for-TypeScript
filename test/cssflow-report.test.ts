import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { lowerHtml } from '../src/cssflow.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { placeElements } from '../src/flowplace.js';
import { elementFloat } from '../src/flowfloat.js';
import { describe as describeReport } from '../src/htmlreport.js';
import type { NotRendered } from '../src/htmlreport.js';

/** The report as the flat strings, which is what most assertions want. */
const names = (skipped: NotRendered[]): string[] => skipped.map(describeReport);

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;
/** Floats need a makeFloat adapter, which htmlflow.ts supplies in production.
 *  Without one they take the documented no-adapter fallback and lay out in
 *  flow, so these tests would measure a path no entry point uses.
 *
 *  `doc` is a PARAMETER, and it has to be: the adapter captures the Document it
 *  will draw into, so handing it a throwaway one paints the float onto a page
 *  belonging to a different document and its text never appears. In production
 *  htmlflow.ts closes over the same Document the flow or page belongs to. */
const map = (src: string, width = 600, doc: Document = Document.New()) =>
  lowerHtml(parseHtml(`<!doctype html>${src}`), {
    width, resolveFamily,
    makeFloat: (els, w, spacing) => elementFloat(doc, els, w, spacing),
  });
function text(src: string): string {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const { elements } = map(src, 600, doc);
  placeElements(doc, page, elements, [20, 20, 600, 750], { paragraphSpacing: 0 });
  return page.GetText();
}
describe('skipped', () => {
  it('no longer names a table, which zch2.6 renders', () => {
    // The report is what a caller reads to tell a dropped construct from an
    // empty document, so a construct LEAVING it is worth pinning too.
    const { skipped } = map('<p>before</p><table><tr><td>cell</td></tr></table>');
    expect(names(skipped)).toEqual([]);
  });
  it('names a table cell whose block content had to be flattened', () => {
    // TableBuilder.addCell takes `string | TextRun[]`, so a cell holding a <p>
    // and a <ul> cannot be represented. The text survives; the structure does
    // not, and that is what is reported.
    const { skipped } = map('<table><tr><td><p>a</p><p>b</p></td></tr></table>');
    expect(names(skipped)).toEqual(['table-cell-blocks']);
  });
  it('emits the text of a table and of what surrounds it', () => {
    // Visible content beats a silently dropped subtree — svgdraw.ts's rule.
    const t = text('<p>before</p><table><tr><td>x</td></tr></table><p>after</p>');
    expect(t).toContain('before');
    expect(t).toContain('x');
    expect(t).toContain('after');
  });
  it('carries the ELEMENT and the kind, not just a name', () => {
    // The whole reason skipped is structured: a caller can reach the source
    // element and can tell a dropped construct from a degraded one. Two
    // same-side floats are the vehicle since zch2.10 — a lone float RENDERS
    // and reports nothing at all.
    const { skipped } = map(
      '<div style="float:left;width:50px">a</div><div style="float:left;width:50px">b</div>');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].construct).toBe('float');
    expect(skipped[0].kind).toBe('degraded');
    expect(skipped[0].detail).toBe('left');
    expect(skipped[0].el?.name).toBe('div');
  });
  it('names an image by its src', () => {
    expect(names(map('<p>a <img src="pic.png"> b</p>').skipped)).toContain('image:pic.png');
  });
  it('still emits the text around a skipped image', () => {
    const t = text('<p>alpha <img src="pic.png"> bravo</p>');
    expect(t).toContain('alpha');
    expect(t).toContain('bravo');
  });
  it('no longer names a float, which zch2.10 places', () => {
    // A construct LEAVING the report is worth pinning: a caller reads it to
    // tell a dropped construct from an empty document. Same shape as the
    // table case above, which zch2.6 retired the same way.
    const src = '<div style="float:left;width:100px">side</div><p>body</p>';
    expect(names(map(src).skipped)).toEqual([]);
    expect(text(src)).toContain('side');
  });
  it('reports in document order', () => {
    const { skipped } = map(
      '<p><img src="a.png"></p><div style="float:left">s</div>'
      + '<p><img src="b.png"></p>');
    // No float entry since zch2.10: a lone float renders.
    expect(names(skipped)).toEqual(['image:a.png', 'image:b.png']);
  });
  it('is empty for a document that renders whole', () => {
    expect(names(map('<p>a</p><h1>b</h1><ul><li>c</li></ul>').skipped)).toEqual([]);
  });
  it('names an image inside a list item', () => {
    expect(names(map('<ul><li>a <img src="in-li.png"></li></ul>').skipped))
      .toContain('image:in-li.png');
  });
  it('reaches a float and an image nested several containers deep', () => {
    // The walk must not short-circuit at the top level: a real document
    // buries both inside wrappers. A LONE float renders since zch2.10, so the
    // nested vehicle is a same-side PAIR.
    expect(names(map('<div><section><div style="float:left;width:50px">x</div>'
      + '<div style="float:left;width:50px">y</div></section></div>')
      .skipped)).toEqual(['float:left']);
    expect(names(map('<div><section><p>t <img src="d.png"></p></section></div>')
      .skipped)).toEqual(['image:d.png']);
  });
});
describe('unsupported', () => {
  it('passes an unknown property through from the cascade', () => {
    const { unsupported } = map('<p style="grid-template-columns:1fr">a</p>');
    expect(unsupported.some((u) => u.property === 'grid-template-columns'
      && u.reason === 'unknown-property')).toBe(true);
  });
  it('is empty for a document using only supported properties', () => {
    expect(map('<p style="color:red;margin:4px">a</p>').unsupported).toEqual([]);
  });
});
describe('option validation', () => {
  it('rejects a non-positive width', () => {
    expect(() => lowerHtml(parseHtml('<p>a</p>'), { width: 0, resolveFamily }))
      .toThrow(TypeError);
  });
  it('rejects a missing resolveFamily', () => {
    expect(() => lowerHtml(
      parseHtml('<p>a</p>'),
      { width: 100 } as unknown as { width: number; resolveFamily: FamilyResolver },
    )).toThrow(TypeError);
  });
  it('never throws on document content, however damaged', () => {
    expect(() => map('<p>a<div><table><tr><em>b</table></em></p></div>')).not.toThrow();
  });
  it('handles an empty document', () => {
    const { elements, skipped } = map('');
    expect(elements).toEqual([]);
    expect(names(skipped)).toEqual([]);
  });
});