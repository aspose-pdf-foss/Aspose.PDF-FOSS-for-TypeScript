import { describe, it, expect } from 'vitest';
import {
  clearTo, insetsAt, nextBoundary, pruneFloats, resolveFloatTop, type ActiveFloat,
} from '../src/floatstack.js';

const L = (band: number, bottom: number): ActiveFloat => ({ side: 'left', band, bottom });
const R = (band: number, bottom: number): ActiveFloat => ({ side: 'right', band, bottom });

describe('insetsAt', () => {
  it('reports zero insets with no floats', () => {
    expect(insetsAt([], 470)).toEqual({ left: 0, right: 0 });
  });

  it('reports the band of a float in force', () => {
    expect(insetsAt([L(106, 400)], 470)).toEqual({ left: 106, right: 0 });
    expect(insetsAt([R(86, 400)], 470)).toEqual({ left: 0, right: 86 });
  });

  it('reports both sides concurrently', () => {
    expect(insetsAt([L(106, 400), R(86, 300)], 470)).toEqual({ left: 106, right: 86 });
  });

  it('takes the widest band per side (staircase)', () => {
    const fs = [L(106, 400), L(66, 300)];
    expect(insetsAt(fs, 470).left).toBe(106); // both in force → the wider wins
    expect(insetsAt(fs, 350).left).toBe(66);  // the wide one has been passed
  });

  it('ignores a float the pen has reached or passed', () => {
    expect(insetsAt([L(106, 400)], 400)).toEqual({ left: 0, right: 0 });
    expect(insetsAt([L(106, 400)], 399)).toEqual({ left: 0, right: 0 });
  });
});

describe('nextBoundary', () => {
  it('is undefined when no float is in force', () => {
    expect(nextBoundary([], 470)).toBeUndefined();
    expect(nextBoundary([L(106, 400)], 400)).toBeUndefined();
  });

  it('picks the highest bottom among the floats in force', () => {
    const fs = [L(106, 400), L(66, 300)];
    expect(nextBoundary(fs, 470)).toBe(400);
    expect(nextBoundary(fs, 350)).toBe(300);
  });

  it('spans both sides', () => {
    expect(nextBoundary([L(106, 300), R(86, 420)], 470)).toBe(420);
  });
});

describe('pruneFloats', () => {
  it('drops the floats the pen has passed and keeps the rest', () => {
    expect(pruneFloats([L(106, 400), L(66, 300)], 350)).toEqual([L(66, 300)]);
    expect(pruneFloats([L(106, 400)], 400)).toEqual([]);
    expect(pruneFloats([L(106, 400)], 470)).toEqual([L(106, 400)]);
  });
});

describe('resolveFloatTop', () => {
  it('returns naturalTop unchanged, by identity, when nothing pushes the box', () => {
    const naturalTop = 474;
    expect(resolveFloatTop([], 'left', 100, 6, naturalTop, 260)).toBe(naturalTop);
  });

  it('never shares a side: a same-side float pushes the box below it', () => {
    // left float bottom 400, spacing 6 → new box top 394.
    expect(resolveFloatTop([L(106, 400)], 'left', 100, 6, 474, 260)).toBe(394);
  });

  it('sits beside an opposing float when the box fits the remaining channel', () => {
    // left band 106 + width 100 = 206 <= 260 → unchanged.
    expect(resolveFloatTop([L(106, 400)], 'right', 100, 6, 474, 260)).toBe(474);
  });

  it('pushes below an opposing float the box cannot fit beside', () => {
    // left band 106 + width 160 = 266 > 260 → below the left float.
    expect(resolveFloatTop([L(106, 400)], 'right', 160, 6, 474, 260)).toBe(394);
  });

  it('resolves across both rules in successive passes', () => {
    // pass 1: same-side left in force → 400 - 6 = 394.
    // pass 2: opposing band 200 + width 100 = 300 > 260 → 250 - 6 = 244.
    // pass 3: nothing in force at 244 → done.
    expect(resolveFloatTop([L(106, 400), R(200, 250)], 'left', 100, 6, 474, 260)).toBe(244);
  });

  it('gives up rather than looping when the box exceeds the bare column', () => {
    // No opposing float to push below; the caller handles the overflow.
    expect(resolveFloatTop([], 'left', 400, 6, 474, 260)).toBe(474);
  });
});

describe('clearTo', () => {
  it('is undefined when the requested side carries no float', () => {
    expect(clearTo([], 'both')).toBeUndefined();
    expect(clearTo([L(106, 400)], 'right')).toBeUndefined();
    expect(clearTo([R(86, 400)], 'left')).toBeUndefined();
  });

  it('returns the bottom of the float on the requested side', () => {
    expect(clearTo([L(106, 400)], 'left')).toBe(400);
    expect(clearTo([R(86, 300)], 'right')).toBe(300);
  });

  it('is side-selective: it ignores the other side entirely', () => {
    const fs = [L(106, 400), R(86, 300)];
    expect(clearTo(fs, 'left')).toBe(400);   // not 300 — the right float is not cleared
    expect(clearTo(fs, 'right')).toBe(300);
  });

  it("'both' clears every float", () => {
    expect(clearTo([L(106, 400), R(86, 300)], 'both')).toBe(300);
  });

  it('picks the LOWEST bottom when a side carries stacked floats', () => {
    // Smaller y = further down the page. Clearing must pass the lower box.
    expect(clearTo([L(106, 400), L(66, 250)], 'left')).toBe(250);
  });
});
