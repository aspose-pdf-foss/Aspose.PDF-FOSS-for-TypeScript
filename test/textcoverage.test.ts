/** The one owner of "what of this text can this face not draw" (zch2.14).
 *
 *  The exclusions are the whole feature. `probe('a\nb')` is 2 of 3 codepoints
 *  because \n is layout structure rather than ink, so without them every code
 *  block and every hard-broken paragraph in every document reports a loss. */
import { describe, it, expect } from 'vitest';
import { coverageOf, drawsNothing } from '../src/textcoverage.js';
import { winAnsiDriver } from '../src/layout.js';
import { Document } from '../src/document.js';
import { encodeWinAnsi } from '../src/encoding.js';

describe('coverageOf', () => {
  it('returns undefined for text the face draws in full', () => {
    expect(coverageOf('hello world', 'Helvetica', false)).toBeUndefined();
  });

  it('reports every character lost, and that NOTHING drew', () => {
    expect(coverageOf('При', 'Helvetica', false)).toEqual({ lost: 'При', all: true });
  });

  it('reports a PARTIAL loss without claiming the block is blank', () => {
    expect(coverageOf('alpha При omega', 'Helvetica', false))
      .toEqual({ lost: 'При', all: false });
  });

  it('does not report a newline, a carriage return or a tab', () => {
    // Measured: encodeWinAnsi drops all three, so a naive codepoint count puts
    // a report on every code block and every hard-broken paragraph.
    expect(coverageOf('a\nb', 'Helvetica', false)).toBeUndefined();
    expect(coverageOf('a\r\nb', 'Helvetica', false)).toBeUndefined();
    expect(coverageOf('a\tb', 'Helvetica', false)).toBeUndefined();
  });

  it('does not report the WinAnsi punctuation a document actually uses', () => {
    expect(coverageOf('“curly” — dash… ½', 'Helvetica', false)).toBeUndefined();
  });

  it('reports a combining mark, which genuinely does not draw', () => {
    expect(coverageOf('é', 'Helvetica', false))
      .toEqual({ lost: '́', all: false });
  });

  it('reports an astral character as one lost codepoint, not two units', () => {
    expect(coverageOf('a\u{1F600}b', 'Helvetica', false))
      .toEqual({ lost: '\u{1F600}', all: false });
  });

  it('DEDUPLICATES lost characters, in first-appearance order', () => {
    // Without this a page of Cyrillic puts the whole page in a report field.
    expect(coverageOf('ББА', 'Helvetica', false)?.lost).toBe('БА');
  });

  it('judges each run against its OWN face, falling back to the block font', () => {
    const runs = [{ text: 'При' }, { text: 'ok', font: 'Times-Roman' as const }];
    expect(coverageOf(runs, 'Helvetica', false)).toEqual({ lost: 'При', all: false });
  });

  it('suppresses the PARTIAL report for a shaped block, keeping all-or-nothing', () => {
    // A shaper legitimately consumes joiners and format characters, so a
    // per-character scan reports loss where nothing was lost.
    expect(coverageOf('alpha При', 'Helvetica', true)).toBeUndefined();
    expect(coverageOf('При', 'Helvetica', true)).toEqual({ lost: 'При', all: true });
  });

  it('returns undefined for text that is only structure', () => {
    expect(coverageOf('\n\t', 'Helvetica', false)).toBeUndefined();
  });

  it('returns undefined for empty content', () => {
    expect(coverageOf('', 'Helvetica', false)).toBeUndefined();
    expect(coverageOf([], 'Helvetica', false)).toBeUndefined();
  });
});

describe('drawsNothing agrees with coverageOf on text without structure', () => {
  const CASES = ['hello', 'При', 'alpha При omega', '', 'é', 'a\u{1F600}b'];
  it('says nothing-drew exactly when coverageOf says all', () => {
    const d = winAnsiDriver('Helvetica');
    for (const t of CASES) {
      const cov = coverageOf(t, 'Helvetica', false);
      const allLost = cov !== undefined && cov.all;
      expect([t, drawsNothing(t, d)]).toEqual([t, allLost || t === '']);
    }
  });

  it('DIVERGES on structure, which is why they are two functions', () => {
    // The painter emits nothing for a lone newline; the author lost nothing.
    expect(drawsNothing('\n', winAnsiDriver('Helvetica'))).toBe(true);
    expect(coverageOf('\n', 'Helvetica', false)).toBeUndefined();
  });
});

describe('a run is judged against its OWN face, not the block font', () => {
  // Needs TWO faces with DIFFERENT coverage, so it cannot be built from the
  // Standard-14 set alone — all 12 share one WinAnsi table. U+0131 (dotless i)
  // is the discriminator: WinAnsi has no code for it, the embedded face does.
  it('does not report a character the run\u2019s own embedded face can draw', () => {
    const doc = Document.New();
    const embedded = doc.AddFontFile('test/fixtures/fonts/NimbusSans-Regular.t1');
    expect(encodeWinAnsi('\u0131').length).toBe(0);   // Helvetica cannot
    expect(embedded.probe('\u0131')).toBeGreaterThan(0); // the embedded face can
    // Judged against the block font instead, this would report '\u0131'.
    expect(coverageOf([{ text: '\u0131', font: embedded }], 'Helvetica', false))
      .toBeUndefined();
  });

  it('still reports it for a run that states no font of its own', () => {
    expect(coverageOf([{ text: '\u0131' }], 'Helvetica', false))
      .toEqual({ lost: '\u0131', all: true });
  });
});
