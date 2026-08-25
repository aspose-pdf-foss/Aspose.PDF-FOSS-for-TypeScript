import { describe, it, expect } from 'vitest';
import { containMatrix, placementMatrix, IDENTITY } from '../src/text.js';
import { rotateAbout } from '../src/template.js';

const BBOX = [0, 0, 200, 100];   // a 2:1 form

describe('containMatrix', () => {
  it('scales uniformly and centres vertically in a taller cell', () => {
    // 200x100 into a 150x200 cell: s = min(0.75, 2) = 0.75, fh = 75,
    // so the vertical offset is (200 - 75) / 2 = 62.5.
    const m = containMatrix(BBOX, IDENTITY, [0, 0, 150, 200])!;
    expect(m[0]).toBeCloseTo(0.75, 9);
    expect(m[3]).toBeCloseTo(0.75, 9);   // uniform, not stretched
    expect(m[4]).toBeCloseTo(0, 9);
    expect(m[5]).toBeCloseTo(62.5, 9);
  });

  it('scales uniformly and centres horizontally in a wider cell', () => {
    // The other axis, on its own: 200x100 into 400x100 gives s = 1 and a
    // horizontal offset of (400 - 200) / 2 = 100. One vector at a time —
    // a single case cannot tell a transposed fit from a correct one.
    const m = containMatrix(BBOX, IDENTITY, [0, 0, 400, 100])!;
    expect(m[0]).toBeCloseTo(1, 9);
    expect(m[3]).toBeCloseTo(1, 9);
    expect(m[4]).toBeCloseTo(100, 9);
    expect(m[5]).toBeCloseTo(0, 9);
  });

  it('agrees with placementMatrix on an exactly-matching rect', () => {
    // The degenerate case the old N-up test lived on: with the same aspect
    // ratio the two modes coincide, which is why it pinned nothing.
    const a = containMatrix(BBOX, IDENTITY, [0, 0, 400, 200])!;
    const b = placementMatrix(BBOX, IDENTITY, [0, 0, 400, 200])!;
    expect(a).toEqual(b);
  });

  it('is undefined for a degenerate box', () => {
    expect(containMatrix([0, 0, 0, 100], IDENTITY, [0, 0, 10, 10])).toBeUndefined();
  });
});

describe('rotateAbout', () => {
  it('is the identity at zero degrees', () => {
    expect(rotateAbout(50, 50, 0)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('leaves its own centre fixed', () => {
    // The defining property: the pivot does not move. A rotation composed in
    // the wrong order still LOOKS rotated while moving the content off the
    // rect entirely, so this is the assertion that matters.
    const m = rotateAbout(50, 20, 90);
    const x = m[0] * 50 + m[2] * 20 + m[4];
    const y = m[1] * 50 + m[3] * 20 + m[5];
    expect(x).toBeCloseTo(50, 9);
    expect(y).toBeCloseTo(20, 9);
  });

  it('turns +x into +y about the origin', () => {
    const m = rotateAbout(0, 0, 90);
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[1]).toBeCloseTo(1, 9);
    expect(m[2]).toBeCloseTo(-1, 9);
    expect(m[3]).toBeCloseTo(0, 9);
  });
});
