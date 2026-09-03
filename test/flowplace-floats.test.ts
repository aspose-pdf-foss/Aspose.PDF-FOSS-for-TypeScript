/** placeElements gains the same band bookkeeping Render has, so page.AddHtml
 *  places floats too — zch2.5's rule is that the three entry points are one
 *  implementation (zch2.10). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { placeElements, measureElements } from '../src/flowplace.js';
import { elementFloat, floatElement } from '../src/flowfloat.js';

const BODY = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet';

/** The BODY fragments' x positions, top line first.
 *
 *  Two traps this helper exists for, both hit while writing it. The float's own
 *  text sits at the rect's left edge, so it has to be filtered out; and a plain
 *  `Math.min` over what is left picks the line that correctly RESUMED at full
 *  width below the float, which is the opposite of what the narrowing test
 *  wants to see. */
function bodyXs(withFloat: boolean): number[] {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  const els = [];
  if (withFloat) {
    const inner = paragraph('FLOATBOX');
    els.push(floatElement(inner, 'left', elementFloat(doc, inner, 150, 6), 0, 0));
  }
  els.push(...paragraph(BODY));
  placeElements(doc, page, els, [50, 50, 400, 700]);
  return page.GetTextFragments()
    .filter((f) => !f.text.includes('FLOATBOX'))
    .sort((a, b) => b.quad[1] - a.quad[1])
    .map((f) => f.quad[0]);
}

describe('placeElements with a float', () => {
  it('narrows the channel for the text beside it', () => {
    expect(bodyXs(true)[0]).toBeGreaterThan(bodyXs(false)[0] + 100);
  });

  it('resumes at full width below the float band', () => {
    // The line beside the float is indented; a later one is not. Without this
    // the text would stay in the narrowed channel for the rest of the rect.
    const xs = bodyXs(true);
    expect(xs.length).toBeGreaterThan(1);
    expect(xs[xs.length - 1]).toBeLessThan(xs[0] - 100);
  });

  it('places the float itself', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = paragraph('floated words');
    placeElements(doc, page, [
      floatElement(inner, 'left', elementFloat(doc, inner, 150, 6), 0, 0),
      ...paragraph(BODY),
    ], [50, 50, 400, 700]);
    expect(page.GetText()).toContain('floated words');
  });

  it('does NOT split an over-tall float — one rect has no next column', () => {
    // Splitting here would paint the head and leave the tail in a remainder
    // most callers of page.AddHtml never re-place: half a float drawn and the
    // rest silently gone. Degrading to in-flow draws everything.
    //
    // The fixture turns on the width difference: the same words need ~7 lines
    // at the float's 100pt and 2 at the rect's 400pt, so a 60pt rect cannot
    // take the float and can take it in flow.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = paragraph(BODY);
    const el = floatElement(inner, 'left', elementFloat(doc, inner, 100, 6), 0, 0);
    const res = placeElements(doc, page, [el], [50, 600, 400, 60]);
    expect(res.remainder).toHaveLength(0);
    expect(page.GetText()).toContain('juliet');
  });
});

describe('measureElements', () => {
  it('reports the height placeElements consumes for the same elements', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const els = paragraph(BODY);
    const measured = measureElements(els, 300);
    const { usedHeight } = placeElements(doc, page, els, [50, 50, 300, 700]);
    expect(measured).toBeCloseTo(usedHeight, 6);
  });

  it('draws nothing', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    measureElements(paragraph('must not appear'), 300);
    expect(page.GetText()).toBe('');
  });
});
