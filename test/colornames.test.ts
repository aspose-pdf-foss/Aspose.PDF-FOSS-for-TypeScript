import { describe, it, expect } from 'vitest';
import { NAMED_COLORS } from '../src/colornames.js';

describe('the named colour table', () => {
  it('holds exactly 148 entries', () => {
    // 147 X11 names plus rebeccapurple. Asserted so a half-pasted table is a
    // red build rather than a colour that silently falls back to undefined.
    expect(NAMED_COLORS.size).toBe(148);
  });

  it('stores components as 0..1, matching the repo convention', () => {
    expect(NAMED_COLORS.get('black')).toEqual([0, 0, 0]);
    expect(NAMED_COLORS.get('white')).toEqual([1, 1, 1]);
    expect(NAMED_COLORS.get('red')).toEqual([1, 0, 0]);
  });

  it('carries rebeccapurple, the one name that is not X11', () => {
    const c = NAMED_COLORS.get('rebeccapurple');
    expect(c?.[0]).toBeCloseTo(0x66 / 255, 10);
    expect(c?.[1]).toBeCloseTo(0x33 / 255, 10);
    expect(c?.[2]).toBeCloseTo(0x99 / 255, 10);
  });

  it('does NOT carry transparent', () => {
    // `transparent` is not a named colour: it is rgba(0,0,0,0), and it has an
    // alpha the table has no room for. Both consumers handle it themselves.
    expect(NAMED_COLORS.has('transparent')).toBe(false);
  });

  it('carries both spellings of the grey names', () => {
    expect(NAMED_COLORS.get('gray')).toEqual(NAMED_COLORS.get('grey'));
    expect(NAMED_COLORS.get('darkgray')).toEqual(NAMED_COLORS.get('darkgrey'));
  });

  it('is keyed lowercase, so a caller folds before looking up', () => {
    expect(NAMED_COLORS.has('Red')).toBe(false);
    expect(NAMED_COLORS.has('red')).toBe(true);
  });
});
