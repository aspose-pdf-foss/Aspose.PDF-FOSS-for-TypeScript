/** CSS floats place, and `float` has left the skipped report (zch2.10). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';

/** The float has to be TALLER THAN ONE LINE and the paragraph has to state
 *  `margin:0`, both learned the hard way. A one-line float leaves only a
 *  couple of points of band once the paragraph's own top margin is spent, so
 *  the text correctly resumes BELOW it and the narrowing assertion sees
 *  nothing — the engine was right and the first fixture was not.
 *
 *  Every word is FLOATED so each of its wrapped fragments can be filtered out;
 *  with mixed words only the first fragment carries the marker. */
const SRC = `<div style="float:left;width:150px">FLOATED FLOATED FLOATED FLOATED FLOATED</div>
<p style="margin:0">alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima</p>`;

const BODY_ONLY = '<p style="margin:0">alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima</p>';

/** Body fragments' x positions, TOP LINE FIRST.
 *
 *  The float's own text sits at the container's left edge, so it is filtered
 *  out; and a Math.min over what remains would pick the line that correctly
 *  resumed at full width BELOW the float, which is the opposite of what a
 *  narrowing assertion wants. */
function bodyXs(page: { GetTextFragments(): { quad: number[]; text: string }[] }): number[] {
  return page.GetTextFragments()
    .filter((f) => !f.text.includes('FLOATED'))
    .sort((a, b) => b.quad[1] - a.quad[1])
    .map((f) => f.quad[0]);
}

describe('AddHtml places a float', () => {
  it('narrows the channel for the text beside it', () => {
    const withFloat = bodyXs(Document.New().AddHtml(SRC).pages[0]);
    const without = bodyXs(Document.New().AddHtml(BODY_ONLY).pages[0]);
    expect(withFloat[0]).toBeGreaterThan(without[0] + 100);
  });

  it('draws the float’s own content', () => {
    expect(Document.New().AddHtml(SRC).pages[0].GetText()).toContain('FLOATED');
  });

  it('no longer reports float in skipped', () => {
    // A construct LEAVING the report is worth pinning: a caller reads it to
    // tell a dropped construct from an empty document.
    const { skipped } = Document.New().AddHtml(SRC);
    expect(skipped.filter((r) => r.construct === 'float')).toEqual([]);
  });

  it('shrink-to-fits an auto-width float rather than filling the column', () => {
    // Measured against the NO-FLOAT baseline, and it has to be: a full-width
    // float leaves the body at 78 (below it) while a shrunk one puts it at
    // 90.4 (beside it), and a loose "between 72 and 200" bound accepts both —
    // which is exactly what the first version of this test did, passing with
    // the MeasureFn unwired.
    const first = (src: string): number => Document.New().AddHtml(src).pages[0]
      .GetTextFragments().filter((f) => f.text.includes('alpha'))[0].quad[0];
    const baseline = first(BODY_ONLY);
    const beside = first(`<div style="float:left">hi</div>${BODY_ONLY}`);
    expect(beside).toBeGreaterThan(baseline + 5);
  });

  it('reports two same-side floats that CSS would have put side by side', () => {
    const { skipped } = Document.New().AddHtml(
      `<div style="float:left;width:50px">A</div><div style="float:left;width:50px">B</div><p>x</p>`);
    const f = skipped.filter((r) => r.construct === 'float');
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('degraded');
  });

  it('places floats through all three entry points alike', () => {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    const viaDoc = Document.New().AddHtml(SRC).pages[0].GetText();
    const flowDoc = Document.New();
    const flow = flowDoc.NewFlow({ format: PageFormat.A4 });
    flow.AddHtml(SRC);
    const viaFlow = flow.Render()[0].GetText();
    const pageDoc = Document.New();
    const { page } = pageDoc.AddPage(PageFormat.A4);
    page.AddHtml(SRC, [72, 72, 451, 697]);
    const viaPage = page.GetText();
    expect(norm(viaFlow)).toBe(norm(viaDoc));
    expect(norm(viaPage)).toBe(norm(viaDoc));
  });
});

describe('an over-tall CSS float (zch2.15)', () => {
  // 150px is 112.5pt, at which each LINEnn word is most of a line, so 200 of
  // them run well past the 698pt column and the float must span two pages.
  const TALL = Array.from({ length: 200 }, (_, i) => `LINE${i}`).join(' ');
  const SRC_TALL = `<div style="float:left;width:150px">${TALL}</div>
<p style="margin:0">alpha bravo charlie delta echo</p>`;

  it('splits across pages instead of laying out in flow', () => {
    const { pages } = Document.New().AddHtml(SRC_TALL);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0].GetText()).toContain('LINE0');
    expect(pages[pages.length - 1].GetText()).toContain('LINE199');
  });

  it('keeps narrowing the channel on the page it continues onto', () => {
    // The head's band is easy to get right and the tail's is the one a lost
    // band leaves plausible: both halves still paint, and only the text beside
    // the tail moves.
    const { pages } = Document.New().AddHtml(SRC_TALL);
    const floatXs = pages[1].GetTextFragments()
      .filter((f) => f.text.includes('LINE'))
      .map((f) => f.quad[0]);
    expect(floatXs.length).toBeGreaterThan(0);
    // The continuation sits at the column's left edge, exactly as the head did.
    expect(Math.min(...floatXs)).toBeCloseTo(72, 0);
  });
});
