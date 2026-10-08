// test/tabstops.test.ts
import { describe, it, expect } from 'vitest';
import { resolveTabStops, nextStop, leaderGlyph, leaderFill, type TabLayout } from '../src/tabstops.js';

describe('resolveTabStops', () => {
  it('sorts, fills defaults and keeps the interval', () => {
    const r = resolveTabStops([{ position: 200, align: 'right' }, { position: 50 }], undefined);
    expect(r.interval).toBe(36);
    expect(r.stops).toEqual([
      { position: 50, align: 'left', leader: 'none', decimalChar: '.' },
      { position: 200, align: 'right', leader: 'none', decimalChar: '.' },
    ]);
  });
  it('refuses bad input by kind and by range', () => {
    expect(() => resolveTabStops('x', undefined)).toThrow(TypeError);
    expect(() => resolveTabStops([{ position: NaN }], undefined)).toThrow(TypeError);
    expect(() => resolveTabStops([{ position: 1, align: 'up' }], undefined)).toThrow(TypeError);
    expect(() => resolveTabStops([{ position: 1, leader: 'stars' }], undefined)).toThrow(TypeError);
    expect(() => resolveTabStops([{ position: 1, align: 'decimal', decimalChar: ',,' }], undefined)).toThrow(TypeError);
    expect(() => resolveTabStops([{ position: -1 }], undefined)).toThrow(RangeError);
    expect(() => resolveTabStops([{ position: 5 }, { position: 5 }], undefined)).toThrow(RangeError);
    expect(() => resolveTabStops([], 0)).toThrow(RangeError);
    expect(() => resolveTabStops([], 'x')).toThrow(TypeError);
  });
  it('accepts an empty list (default stops only)', () => {
    expect(resolveTabStops([], 72)).toEqual({ stops: [], interval: 72 });
  });
});

describe('nextStop', () => {
  const t = (stops: number[], interval = 36): TabLayout => ({
    stops: stops.map((position) => ({ position, align: 'left', leader: 'none', decimalChar: '.' })), interval, origin: 0,
  });
  it('takes the first explicit stop STRICTLY past the pen', () => {
    expect(nextStop(t([0, 50, 100]), 0, 500)?.position).toBe(50);   // a stop AT the pen is skipped
    expect(nextStop(t([50, 100]), 50, 500)?.position).toBe(100);
  });
  it('past the last explicit stop, the next default multiple; none to its left', () => {
    expect(nextStop(t([50]), 60, 500)?.position).toBe(72);
    expect(nextStop(t([100]), 10, 500)?.position).toBe(100);         // no default at 36 before a custom stop
    expect(nextStop(t([]), 36, 500)?.position).toBe(72);
  });
  it('undefined when the chosen stop lies past the right edge (both sides of the boundary)', () => {
    expect(nextStop(t([100]), 10, 100)?.position).toBe(100);
    expect(nextStop(t([100]), 10, 99.999)).toBeUndefined();
    expect(nextStop(t([]), 200, 215)).toBeUndefined();
  });
});

describe('leader helpers', () => {
  it('maps leaders to glyphs; line and none draw none', () => {
    expect(['dot', 'middleDot', 'hyphen', 'underscore'].map((l) => leaderGlyph(l as never))).toEqual(['.', '\u00B7', '-', '_']);
    expect(leaderGlyph('line')).toBeUndefined();
    expect(leaderGlyph('none')).toBeUndefined();
  });
  it('fills right-aligned against the gap end, a clear at each side', () => {
    // gap 0..100, clear 4: room 92 for 5pt glyphs -> 18, ending at 96.
    expect(leaderFill(0, 100, 5, 4)).toEqual({ count: 18, x: 96 - 18 * 5 });
    expect(leaderFill(0, 7, 5, 4).count).toBe(0);
    expect(leaderFill(0, 100, 0, 4).count).toBe(0);
  });
});
