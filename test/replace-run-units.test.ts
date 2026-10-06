import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { pageLayout } from '../src/textedit.js';
import { runsAdvance, runUnits, splitRuns } from '../src/replaceadjust.js';
import type { Run } from '../src/replacefont.js';
import { buildSimpleTextPdf } from './helpers/build-text-pdf.js';

const anchorOf = (justify = false) => {
  const d = Document.New(PageFormat.A4);
  d.Pages[0].AddTextBlock('alpha beta gamma delta epsilon zeta eta theta', [72, 400, 120, 300], { fontSize: 12, align: justify ? 'justify' : 'left' });
  const doc = Document.Open(d.Save());
  return pageLayout(doc, doc.Pages[0], {}).all.find((g) => g.text === 'a')!;
};
const enc = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe('runUnits / splitRuns (6y39)', () => {
  it('units sum exactly to runsAdvance, original and foreign runs alike', () => {
    for (const justify of [false, true]) {
      const g = anchorOf(justify);
      const runs: Run[] = [{ font: 'original', bytes: enc('ab c') }, { font: 'Times-Roman', text: 'xy z' }];
      const us = runUnits(runs, g);
      expect(us.map((u) => u.text).join('')).toBe('ab cxy z');
      expect(us.map((u) => u.run)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
      expect(us.reduce((s, u) => s + u.width, 0)).toBeCloseTo(runsAdvance(runs, g), 9);
    }
  });
  it('sums to runsAdvance under non-zero Tc and Tw (both branches take them)', () => {
    const doc = Document.Open(buildSimpleTextPdf('BT /F1 12 Tf 1.5 Tc 2 Tw 10 100 Td (a b) Tj ET'));
    const g = pageLayout(doc, doc.Pages[0], {}).all.find((e) => e.text === 'a')!;
    expect(g.charSpacing).not.toBe(0);
    const runs: Run[] = [{ font: 'original', bytes: enc('ab c') }, { font: 'Times-Roman', text: 'xy z' }];
    expect(runUnits(runs, g).reduce((s, u) => s + u.width, 0)).toBeCloseTo(runsAdvance(runs, g), 9);
  });
  it('a styled run measures at its own size', () => {
    const g = anchorOf();
    const runs: Run[] = [{ font: 'original', bytes: enc('ab'), style: { size: g.tfSize * 2 } }];
    expect(runUnits(runs, g).reduce((s, u) => s + u.width, 0)).toBeCloseTo(runsAdvance(runs, g), 9);
  });
  it('splitRuns cuts inside a run at a unit boundary and keeps style', () => {
    const g = anchorOf();
    const style = { size: 5 };
    const runs: Run[] = [{ font: 'original', bytes: enc('abc'), style }, { font: 'Times-Roman', text: 'xyz' }];
    const parts = splitRuns(runs, g, [2, 4]);
    expect(parts).toEqual([
      [{ font: 'original', bytes: enc('ab'), style }],
      [{ font: 'original', bytes: enc('c'), style }, { font: 'Times-Roman', text: 'x' }],
      [{ font: 'Times-Roman', text: 'yz' }],
    ]);
  });
  it('a cut at a run boundary yields no empty run', () => {
    const g = anchorOf();
    const runs: Run[] = [{ font: 'original', bytes: enc('ab') }, { font: 'Times-Roman', text: 'xy' }];
    expect(splitRuns(runs, g, [2])).toEqual([[runs[0]], [runs[1]]]);
  });
});
