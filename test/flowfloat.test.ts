/** The element-backed float: a FloatContent over FlowElement[] (zch2.10). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import { elementFloat, floatElement } from '../src/flowfloat.js';

describe('elementFloat', () => {
  it('measures the height its elements will occupy at the float width', () => {
    const doc = Document.New();
    const c = elementFloat(doc, paragraph('one line of text'), 200, 0);
    expect(c.measure()).toBeGreaterThan(0);
    expect(c.width).toBe(200);
    expect(c.spacing).toBe(0);
  });

  it('measure() equals what paintAt() consumes', () => {
    // One walk, or a float measures one way and paints another.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const c = elementFloat(doc, paragraph('alpha bravo charlie delta echo'), 120, 0);
    const measured = c.measure();
    const painted = c.paintAt(page, 50, 700);
    expect(painted).toBeCloseTo(measured, 6);
  });

  it('counts the GAPS between its elements, not just their heights', () => {
    // A single-paragraph float cannot see this: with one element there is no
    // gap to drop, so every other fixture here passes with the gap arithmetic
    // deleted.
    const doc = Document.New();
    const tight = elementFloat(doc, [
      ...paragraph('one'), ...paragraph('two'),
    ], 200, 0).measure();
    const spaced = elementFloat(doc, [
      ...paragraph('one', { spaceAfter: 10 }),
      ...paragraph('two', { spaceBefore: 6 }),
    ], 200, 0).measure();
    expect(spaced).toBeCloseTo(tight + 16, 6);
  });

  it('is degradable, unlike a FloatingBox', () => {
    const doc = Document.New();
    expect(elementFloat(doc, paragraph('x'), 100, 0).degradeOnOverflow).toBe(true);
  });

  it('measure() draws nothing', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = page.GetText();
    elementFloat(doc, paragraph('must not appear'), 200, 0).measure();
    expect(page.GetText()).toBe(before);
  });

  it('splitPaint paints what fits the budget and hands back the rest', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    // One paragraph's height is the budget, so the first fits and the second
    // cannot. Deriving it rather than hardcoding keeps the fixture honest
    // against a font-metric change.
    const oneHigh = elementFloat(doc, paragraph('alpha alpha'), 200, 0).measure();
    const inner = [...paragraph('alpha alpha'), ...paragraph('bravo bravo')];
    const c = elementFloat(doc, inner, 200, 0);
    const res = c.splitPaint!(page, 50, 700, oneHigh + 1, 'left');
    expect(res.height).toBeGreaterThan(0);
    expect(res.tail).toBeDefined();
    expect(page.GetText()).toContain('alpha');
    expect(page.GetText()).not.toContain('bravo');
  });

  it('the tail carries the float marker, so the engine enqueues it as-is', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const oneHigh = elementFloat(doc, paragraph('alpha alpha'), 200, 0).measure();
    const inner = [...paragraph('alpha alpha'), ...paragraph('bravo bravo')];
    const res = elementFloat(doc, inner, 200, 0)
      .splitPaint!(page, 50, 700, oneHigh + 1, 'right');
    expect(res.tail!.float?.side).toBe('right');
    expect(res.tail!.float?.content.width).toBe(200);
    // And it can split again, which is what lets a float span three columns.
    expect(typeof res.tail!.float?.content.splitPaint).toBe('function');
  });

  it('splitPaint hands back NO tail when everything fits the budget', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const c = elementFloat(doc, paragraph('one line of text'), 200, 0);
    const res = c.splitPaint!(page, 50, 700, c.measure() + 50, 'left');
    expect(res.tail).toBeUndefined();
    expect(res.height).toBeCloseTo(c.measure(), 6);
  });

  it('reports height 0 and paints NOTHING when nothing fits the budget', () => {
    // This is the engine's exit to the degrade path: the call must have had no
    // effect, or degrading afterwards would leave a half-painted float.
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const before = page.GetText();
    const res = elementFloat(doc, paragraph('alpha bravo'), 200, 0)
      .splitPaint!(page, 50, 700, 1, 'left');
    expect(res.height).toBe(0);
    expect(page.GetText()).toBe(before);
  });
});

describe('floatElement', () => {
  it('carries the marker and places its children in flow when asked', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const inner = paragraph('inner body');
    const c = elementFloat(doc, inner, 200, 0);
    const el = floatElement(inner, 'left', c, 0, 0);
    expect(el.float?.side).toBe('left');
    expect(el.float?.content).toBe(c);
    // place() is the degrade path.
    const res = el.place({ doc, page, x: 50, top: 700, width: 400, availHeight: 600 });
    expect(res.drew).toBe(true);
    expect(page.GetText()).toContain('inner body');
  });
});
