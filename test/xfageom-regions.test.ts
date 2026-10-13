// test/xfageom-regions.test.ts
import { describe, it, expect } from 'vitest';
import { fieldRegions, editRegion } from '../src/xfageom.js';

const box = { x: 10, y: 20, w: 200, h: 30 };

describe('fieldRegions (XFA 3.3 p. 50: the caption is part of the nominal content region)', () => {
  it('returns editRegion unchanged as the edit region', () => {
    const cap = { reserve: '50pt', placement: 'left' };
    const m = { leftInset: '2pt', topInset: '1pt' };
    const r = fieldRegions(box, cap, m);
    expect('edit' in r && r.edit).toEqual(editRegion(box, cap, m));
  });

  it('puts a left caption in the content region, inset by the field margin', () => {
    const r = fieldRegions(box, { reserve: '50pt' }, { leftInset: '2pt', topInset: '1pt', bottomInset: '3pt' });
    expect('caption' in r && r.caption).toEqual({ x: 12, y: 21, w: 50, h: 26 });
  });

  it('puts right, top and bottom captions on their own edge', () => {
    const rr = fieldRegions(box, { reserve: '40pt', placement: 'right' });
    expect('caption' in rr && rr.caption).toEqual({ x: 170, y: 20, w: 40, h: 30 });
    const rt = fieldRegions(box, { reserve: '10pt', placement: 'top' });
    expect('caption' in rt && rt.caption).toEqual({ x: 10, y: 20, w: 200, h: 10 });
    const rb = fieldRegions(box, { reserve: '10pt', placement: 'bottom' });
    expect('caption' in rb && rb.caption).toEqual({ x: 10, y: 40, w: 200, h: 10 });
  });

  it('makes caption and edit region exact complements within the content region', () => {
    const r = fieldRegions(box, { reserve: '50pt' }, { leftInset: '2pt', rightInset: '4pt' });
    if (!('edit' in r) || !r.caption) throw new Error('expected both');
    expect(r.caption.x + r.caption.w).toBeCloseTo(r.edit.x, 9);
    expect(r.edit.x + r.edit.w).toBeCloseTo(box.x + box.w - 4, 9);
  });

  it('has no caption region with no caption, a hidden one, or an unstated reserve', () => {
    for (const cap of [undefined, { reserve: '5pt', presence: 'hidden' }, { placement: 'left' }]) {
      const r = fieldRegions(box, cap);
      expect('edit' in r && r.caption).toBeUndefined();
    }
  });

  it('refuses with editRegion\'s own reason', () => {
    const r = fieldRegions(box, { reserve: '300pt' });
    expect(r).toEqual(editRegion(box, { reserve: '300pt' }));
  });
});
