import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { TextRun } from '../src/textdecor.js';

const LINK = 'https://example.com';

/** Render `runs` into a page and return the single /Link annotation's rect. */
const linkRect = (runs: TextRun[], opts: object = {}): number[] => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  page.AddTextBlock(runs, [50, 300, 300, 300], { fontSize: 12, ...opts });
  const links = page.Annotations.filter((a) => a.Subtype === 'Link');
  expect(links.length).toBe(1);
  return links[0].Rect!;
};

describe('a link rect stops at its last glyph', () => {
  it('is the same width whether or not text follows the link', () => {
    // The separator space belongs to the run that PAINTS it, which is the
    // preceding one — so the linked run's segment is 'docs ' when text follows
    // and 'docs' when it does not. The rect must not notice the difference.
    const followed = linkRect([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
      { text: ' and more' },
    ]);
    const final = linkRect([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
    ]);
    expect(followed[2] - followed[0]).toBeCloseTo(final[2] - final[0], 5);
  });

  it('ends inside the extracted fragment, by no more than one space', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
      { text: ' and more' },
    ], [50, 300, 300, 300], { fontSize: 12 });
    const rect = page.Annotations.filter((a) => a.Subtype === 'Link')[0].Rect!;
    // GetTextFragments reports this fragment as 'docs ' — INCLUDING the
    // separator — which is exactly why `rect === frag.quad` is the wrong
    // assertion here. Bound it instead: strictly inside, by at most a space.
    const frag = page.GetTextFragments().find((f) => f.text.startsWith('docs'))!;
    const space = 0.278 * 12;   // every Helvetica face's space advance is 278/1000
    expect(rect[2]).toBeLessThan(frag.quad[2]);
    expect(rect[2]).toBeGreaterThan(frag.quad[2] - space - 0.5);
  });

  it('trims the Tw-widened space on a justified line', () => {
    const runs: TextRun[] = [
      { text: 'alpha beta gamma delta epsilon zeta eta ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
      { text: ' theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon' },
    ];
    // Justification widens spaces via Tw and leaves glyphs alone, and it does
    // not change where lines break — so once the separator is trimmed, the two
    // rects cover the identical four glyphs and must be identically wide.
    // Untrimmed they differ by the Tw the separator gained.
    const justified = linkRect(runs, { align: 'justify' });
    const left = linkRect(runs, { align: 'left' });
    expect(justified[2] - justified[0]).toBeCloseTo(left[2] - left[0], 5);
  });

  it('places no annotation for a link run that is only whitespace', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([
      { text: 'see' },
      { text: '   ', link: LINK },
      { text: 'more' },
    ], [50, 300, 300, 300], { fontSize: 12 });
    expect(page.Annotations.filter((a) => a.Subtype === 'Link').length).toBe(0);
  });
});

describe('what the trim must not touch', () => {
  it('does not trim a non-breaking space, which is a real glyph', () => {
    // The \s trap, guarded directly. A code block substitutes U+00A0 for every
    // space so its indentation survives layout collapsing runs of spaces; \s
    // matches U+00A0 in JavaScript, so trimming with it would eat glyphs the
    // author asked for. No rendering would reveal this — only a width does.
    //
    // Write the escape, never a literal U+00A0: on screen it is identical to a
    // space, and this test turns entirely on which of the two it is.
    const withNbsp = linkRect([{ text: 'docs\u00A0', link: LINK }]);
    const plain = linkRect([{ text: 'docs', link: LINK }]);
    // Assert the FULL advance, not merely `toBeGreaterThan`. Measured: a
    // trimming build computes 28.68 - 3.336 = 25.344000000000004 against a
    // plain 25.344, so `>` passes on floating-point residue alone and the guard
    // reports green while the bug is present.
    expect((withNbsp[2] - withNbsp[0]) - (plain[2] - plain[0]))
      .toBeCloseTo(0.278 * 12, 2);   // U+00A0 advances like a space: 278/1000
  });

  it('leaves an underline spanning the space the link rect drops', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK, underline: true },
      { text: ' and more' },
    ], [50, 300, 300, 300], { fontSize: 12 });
    const rect = page.Annotations.filter((a) => a.Subtype === 'Link')[0].Rect!;
    // The underline is the only thin filled path on the page. Read from
    // GetPaths — a different extractor from the annotation dict.
    const rules = page.GetPaths().filter(
      (p) => p.fill !== null && p.bbox[3] - p.bbox[1] < 3);
    expect(rules.length).toBe(1);
    // Decoration is deliberately NOT trimmed: it is byte-fenced typography, and
    // an interaction target and a rule are different concerns.
    expect(rules[0].bbox[2]).toBeGreaterThan(rect[2]);
  });
});
