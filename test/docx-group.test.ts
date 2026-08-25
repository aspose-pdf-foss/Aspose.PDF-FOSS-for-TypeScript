import { describe, it, expect } from 'vitest';
import type { GlyphEvent } from '../src/text.js';
import { groupGlyphs } from '../src/docxgroup.js';

/** A horizontal glyph at (x, baseline), `size * 0.5` wide. */
function g(
  text: string, x: number, baseline: number, size = 10,
  extra: Partial<GlyphEvent> = {},
): GlyphEvent {
  return {
    addr: { path: [], streamIndex: 0, opIndex: 0 },
    font: { bold: false, italic: false } as unknown as GlyphEvent['font'],
    quad: [x, baseline, x + size * 0.5, baseline + size],
    fontSize: size, angle: 0, text, elementIndex: 0,
    byteStart: 0, byteLen: 1, advance: 0.5,
    ...extra,
  };
}

/** Consecutive glyphs starting at x, each `size * 0.5` wide. */
function run(text: string, x: number, baseline: number, size = 10): GlyphEvent[] {
  return [...text].map((ch, i) => g(ch, x + i * size * 0.5, baseline, size));
}

describe('groupGlyphs', () => {
  it('merges a continuous run into one group', () => {
    const out = groupGlyphs(run('Hello', 20, 100));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe('Hello');
    expect(out[0].quad[0]).toBeCloseTo(20);
    expect(out[0].quad[2]).toBeCloseTo(45);
  });

  it('splits at a leader gap on the same baseline', () => {
    // "Introduction" at x=72, "3" at x=468 — a table-of-contents leader row.
    const out = groupGlyphs([...run('Introduction', 72, 700), ...run('3', 468, 700)]);
    expect(out.map((t) => t.text)).toEqual(['Introduction', '3']);
  });

  it('splits at a two-column gutter', () => {
    const out = groupGlyphs([...run('left', 50, 400), ...run('right', 320, 400)]);
    expect(out.map((t) => t.text)).toEqual(['left', 'right']);
  });

  it('keeps an ordinary inter-word space in one group', () => {
    // The gap threshold is bounded from BOTH sides: this is the lower bound,
    // and the leader/gutter cases above are the upper one.
    const out = groupGlyphs([...run('one', 20, 100), ...run('two', 38, 100)]);
    expect(out).toHaveLength(1);
  });

  it('splits at a colour change mid-run in one face at one size', () => {
    // The boundary must fall mid-run: a colour change coinciding with a font or
    // size change would be split by that instead, and this test would pass with
    // the colour rule removed.
    const glyphs = [
      ...run('see', 20, 100),
      ...run('here', 35, 100).map((e) => ({ ...e, color: [0, 0, 255] as [number, number, number] })),
    ];
    const out = groupGlyphs(glyphs);
    expect(out.map((t) => t.text)).toEqual(['see', 'here']);
    expect(out[0].color).toBeUndefined();
    expect(out[1].color).toEqual([0, 0, 255]);
  });

  it('splits at a font-size change', () => {
    const out = groupGlyphs([...run('big', 20, 100, 18), ...run('small', 47, 100, 8)]);
    expect(out.map((t) => t.text)).toEqual(['big', 'small']);
    expect(out[0].fontSize).toBe(18);
    expect(out[1].fontSize).toBe(8);
  });

  it('splits at a baseline change', () => {
    const out = groupGlyphs([...run('one', 20, 100), ...run('two', 20, 86)]);
    expect(out.map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('keeps a kerned pair together despite a sub-tolerance baseline wobble', () => {
    const out = groupGlyphs([g('A', 20, 100), g('V', 25, 100.05)]);
    expect(out).toHaveLength(1);
  });

  it('carries emphasis from the producing font', () => {
    const bold = { bold: true, italic: false } as unknown as GlyphEvent['font'];
    const out = groupGlyphs(run('hi', 20, 100).map((e) => ({ ...e, font: bold })));
    expect(out[0].bold).toBe(true);
    expect(out[0].italic).toBeUndefined();
  });

  it('splits at an emphasis change mid-run at one size', () => {
    // Same reason as the colour rule: without this, a bold word following a
    // regular one merges and the whole group takes the FIRST glyph's emphasis.
    // The boundary falls mid-run so no size or baseline rule can split it.
    const bold = { bold: true, italic: false } as unknown as GlyphEvent['font'];
    const out = groupGlyphs([
      ...run('very', 20, 100),
      ...run('bold', 40, 100).map((e) => ({ ...e, font: bold })),
    ]);
    expect(out.map((t) => t.text)).toEqual(['very', 'bold']);
    expect(out[0].bold).toBeUndefined();
    expect(out[1].bold).toBe(true);
  });

  it('marks a rotated run skewed', () => {
    const out = groupGlyphs(run('turn', 20, 100).map((e) => ({ ...e, angle: Math.PI / 2 })));
    expect(out[0].skewed).toBe(true);
  });

  it('marks a vertical run skewed', () => {
    const out = groupGlyphs(run('down', 20, 100).map((e) => ({ ...e, vertical: true as const })));
    expect(out[0].skewed).toBe(true);
  });

  it('leaves an unskewed group with no skewed key', () => {
    expect(groupGlyphs(run('flat', 20, 100))[0].skewed).toBeUndefined();
  });

  it('returns [] for no glyphs', () => {
    expect(groupGlyphs([])).toEqual([]);
  });
});
