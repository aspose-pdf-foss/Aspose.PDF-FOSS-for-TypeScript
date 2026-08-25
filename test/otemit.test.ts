import { describe, it, expect } from 'vitest';
import { emitLine } from '../src/otemit.js';
import type { ShapedRun } from '../src/shape.js';

const nat = (gid: number) => Math.max(100, gid * 100); // mirror buildOtFont hmtx

function run(glyphs: [number, number, number, number, number][]): ShapedRun {
  // [gid, cluster, xAdvance, xOffset, yOffset]
  return { rtl: false, glyphs: glyphs.map(([gid, cluster, xAdvance, xOffset, yOffset]) => ({ gid, cluster, xAdvance, xOffset, yOffset })) };
}

describe('emitLine', () => {
  it('collapses trivial LTR text to a single Tj', () => {
    const s = emitLine([run([[10, 0, 1000, 0, 0], [11, 1, 1100, 0, 0]])], 12, 1000, nat);
    expect(s.trim()).toBe('<000a000b> Tj');
  });

  it('emits a kern advance delta as a TJ number', () => {
    // gid20 natural 2000, advance 1960 → post-adjust = (0 + 2000 - 1960)*1000/1000 = 40
    const s = emitLine([run([[20, 0, 1960, 0, 0], [12, 1, 1200, 0, 0]])], 12, 1000, nat);
    expect(s.trim()).toBe('[<0014> 40 <000c>] TJ');
  });

  it('emits a mark yOffset as Ts around the glyph', () => {
    const s = emitLine([run([[50, 0, 0, 0, 300]])], 12, 1000, nat); // yOffset 300 units
    // Ts = 300 * 12 / 1000 = 3.6 ; mark advance 0, natural 5000 → post = 0 + 5000 - 0 = 5000
    expect(s).toContain('3.6 Ts');
    expect(s).toContain('0 Ts');
  });
});
