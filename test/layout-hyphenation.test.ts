import { describe, it, expect } from 'vitest';
import { layoutRuns, layoutText, winAnsiDriver, type FontDriver } from '../src/layout.js';
import { resolveHyphenation, hyphenator } from '../src/hyphenate.js';

// Courier is 600 units for every glyph, the hyphen included: at 10pt every
// character, '-' and space is 6pt, so widths are arithmetic.
const CR = winAnsiDriver('Courier');
const SHY = '­';
const manual = hyphenator(resolveHyphenation({ mode: 'manual' }));
const text = (t: string, w: number, h = 1000, hy = manual) =>
  layoutText(t, CR, 10, w, h, 12, hy).lines.map((l) => l.text);

describe('layoutRuns with hyphenation (v9j3.2)', () => {
  it('splits the word that does not fit at its rightmost fitting point and draws a hyphen', () => {
    // 'aaa ' is 24pt; in 60pt the head may be 36pt: 'hy-' (18) fits, 'hyphen-' (42) does not.
    expect(text(`aaa hy${SHY}phen${SHY}ation`, 60)).toEqual(['aaa hy-', 'phenation']);
    // In 66pt the head may be 42pt: 'hyphen-' fits and is the rightmost.
    expect(text(`aaa hy${SHY}phen${SHY}ation`, 66)).toEqual(['aaa hyphen-', 'ation']);
  });

  it('counts the hyphen in the line width', () => {
    const l = layoutText(`aaa hy${SHY}phen${SHY}ation`, CR, 10, 66, 1000, 12, manual).lines[0];
    expect(l.width).toBeCloseTo(66, 6);
  });

  it('draws a soft hyphen as nothing mid-line', () => {
    const l = layoutText(`hy${SHY}phen`, CR, 10, 200, 1000, 12, manual).lines[0];
    expect(l.text).toBe('hyphen');
    expect(l.width).toBeCloseTo(36, 6);
  });

  it('moves the whole word when no point fits', () => {
    expect(text(`aaaaaaa hy${SHY}phen`, 60)).toEqual(['aaaaaaa', 'hyphen']);
  });

  it('hyphenates an over-wide word before the plain split', () => {
    // 132pt in a 60pt box; manual points after 'hy', 'hyphen' and 'hyphenation'.
    // 'hyphen-' (42) and 'ation-' (36) fit; the last 'hyphenation' (66) has no
    // point and no UAX #14 opportunity (AL x AL), so it overflows whole, as today.
    const w = `hy${SHY}phen${SHY}ation${SHY}hyphenation`;
    expect(text(w, 60)).toEqual(['hyphen-', 'ation-', 'hyphenation']);
  });

  it('skips a point whose font cannot draw a hyphen', () => {
    const noHyphen: FontDriver = {
      measure: (t, fs) => t.length * 0.6 * fs,
      encode: (t) => new TextEncoder().encode(t),
      probe: (t) => (t.includes('-') ? 0 : t.length),
    };
    // 'aaa hyphen' is 60pt, so a 54pt box forces the split the font cannot draw.
    const lines = layoutText(`aaa hy${SHY}phen`, noHyphen, 10, 54, 1000, 12, manual).lines.map((l) => l.text);
    expect(lines).toEqual(['aaa', 'hyphen']);
  });

  it('keeps the soft hyphens in the remainder', () => {
    const r = layoutRuns([{ text: `aaa hy${SHY}phen${SHY}ation more`, driver: CR, fontSize: 10 }], 60, 12, 12, 10, 0, manual);
    expect(r.lines.map((l) => l.text)).toEqual(['aaa hy-']);
    expect(r.remainder.map((s) => s.text).join('')).toBe(`phen${SHY}ation more`);
  });

  it('re-joins to the input once line-end hyphens and soft hyphens are removed', () => {
    const auto = hyphenator(resolveHyphenation({ lang: 'en' }));
    const src = 'The quick brown fox jumps over the lazy dog and hyphenation documentation';
    const lines = layoutText(src, CR, 10, 70, 1000, 12, auto).lines;
    const joined = lines.map((l, i) => (i < lines.length - 1 && l.text.endsWith('-') ? l.text.slice(0, -1) : `${l.text} `)).join('');
    expect(joined.trim()).toBe(src);
    expect(lines.some((l) => l.text.endsWith('-'))).toBe(true);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(70 + 1e-6);
  });

  it('is unchanged without a hyphenator', () => {
    const src = `aaa hy${SHY}phen${SHY}ation`;
    const a = layoutRuns([{ text: src, driver: CR, fontSize: 10 }], 60, 1000, 12, 10);
    const b = layoutRuns([{ text: src, driver: CR, fontSize: 10 }], 60, 1000, 12, 10, 0, undefined);
    expect(b).toEqual(a);
    expect(a.lines.map((l) => l.text).join('|')).toContain(SHY);   // today's behaviour: drawn
  });
});
