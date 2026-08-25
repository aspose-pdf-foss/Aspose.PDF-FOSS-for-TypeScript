import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { TextRun } from '../src/textdecor.js';

// Long enough that a justified line carries real slack across several spaces,
// so a Tw-blind box drifts measurably. The underlined run is LAST, where the
// accumulated drift is largest.
//
// The decorated run carries its OWN FONT deliberately. Decoration is painted as
// path ops and leaves no trace in the text state, so two same-font runs merge
// into a single TextFragment and the quad would be the pair's, not the run's —
// which reports a 36pt error against correct geometry. A font change is what
// makes the extractor split them, so the quad really is this run's glyphs.
// The trailing run matters: `justifySpacing` returns 0 for a `hardBreak` line,
// and the final line of a block is always one — so a decorated run on the LAST
// line is never justified and cannot show the defect. The tail pushes the
// decorated run onto a middle line, where Tw is actually in force.
const RUNS: TextRun[] = [
  { text: 'alpha beta gamma delta epsilon zeta eta theta iota kappa ' },
  { text: 'UNDERLINED', font: 'Helvetica-Bold', underline: true },
  { text: ' lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega '
    + 'and more words still to force several further lines of output here' },
];

describe('run decoration under justify', () => {
  it('puts the underline under the glyphs it decorates', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(RUNS, [50, 500, 300, 200], { align: 'justify', fontSize: 12 });

    const frag = page.GetTextFragments().find((f) => f.text.includes('UNDERLINED'));
    expect(frag).toBeDefined();

    // The underline is the only thin filled path on the page.
    const rules = page.GetPaths().filter(
      (p) => p.fill !== null && p.bbox[3] - p.bbox[1] < 3,
    );
    expect(rules.length).toBe(1);
    const rule = rules[0].bbox;

    // Within a point of the glyph span at both ends.
    expect(Math.abs(rule[0] - frag!.quad[0])).toBeLessThan(1);
    expect(Math.abs(rule[2] - frag!.quad[2])).toBeLessThan(1);
  });

  it('still matches for a left-aligned block (no Tw in play)', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(RUNS, [50, 500, 300, 200], { align: 'left', fontSize: 12 });

    const frag = page.GetTextFragments().find((f) => f.text.includes('UNDERLINED'));
    const rules = page.GetPaths().filter(
      (p) => p.fill !== null && p.bbox[3] - p.bbox[1] < 3,
    );
    expect(rules.length).toBe(1);
    expect(Math.abs(rules[0].bbox[0] - frag!.quad[0])).toBeLessThan(1);
    expect(Math.abs(rules[0].bbox[2] - frag!.quad[2])).toBeLessThan(1);
  });
});
