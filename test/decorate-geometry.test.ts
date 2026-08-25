import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visualFrame, textAnchor, imageAnchor } from '../src/decorate.js';
import { apply } from '../src/text.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';

/** First page of a 200x100 document at the given /Rotate. */
const pageAt = (rotate: number) =>
  Document.Open(buildDecorateTarget({ count: 1, rotate })).Pages[0];

describe('visualFrame', () => {
  it('is the identity on an unrotated page at the origin', () => {
    const f = visualFrame(pageAt(0));
    expect(f.M).toEqual([1, 0, 0, 1, 0, 0]);
    expect([f.VW, f.VH]).toEqual([200, 100]);
    expect(f.R).toBe(0);
  });

  it('swaps the extent and maps corners for /Rotate 90', () => {
    const f = visualFrame(pageAt(90));
    expect(f.M).toEqual([0, 1, -1, 0, 200, 0]);
    expect([f.VW, f.VH]).toEqual([100, 200]);
    // Visual bottom-left is the unrotated page's bottom-right: a 90-degree
    // clockwise display turn brings the right edge down to the bottom.
    expect(apply(f.M, 0, 0)).toEqual([200, 0]);
    // Visual top-right is the unrotated top-left.
    expect(apply(f.M, 100, 200)).toEqual([0, 100]);
  });

  it('maps corners for /Rotate 180', () => {
    const f = visualFrame(pageAt(180));
    expect(f.M).toEqual([-1, 0, 0, -1, 200, 100]);
    expect([f.VW, f.VH]).toEqual([200, 100]);
    expect(apply(f.M, 0, 0)).toEqual([200, 100]);
  });

  it('swaps the extent and maps corners for /Rotate 270', () => {
    const f = visualFrame(pageAt(270));
    expect(f.M).toEqual([0, -1, 1, 0, 0, 100]);
    expect([f.VW, f.VH]).toEqual([100, 200]);
    expect(apply(f.M, 0, 0)).toEqual([0, 100]);
  });

  it('offsets by a non-zero CropBox origin', () => {
    const page = Document.Open(
      buildDecorateTarget({ count: 1, origin: [50, 20] })).Pages[0];
    const f = visualFrame(page);
    expect(f.M).toEqual([1, 0, 0, 1, 50, 20]);
    expect([f.VW, f.VH]).toEqual([200, 100]);
  });
});

describe('textAnchor', () => {
  const f = {
    M: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    VW: 200, VH: 100, R: 0,
  };

  it('insets a bottom-left anchor by the margin, on the baseline', () => {
    expect(textAnchor('bottom-left', f, 36, 10))
      .toEqual({ vx: 36, vy: 36, align: 'left', angle: 0 });
  });

  it('drops a top anchor by the margin plus the font size', () => {
    expect(textAnchor('top-left', f, 36, 10))
      .toEqual({ vx: 36, vy: 100 - 36 - 10, align: 'left', angle: 0 });
  });

  it('centers a top-center anchor horizontally', () => {
    expect(textAnchor('top-center', f, 36, 10).vx).toBe(100);
    expect(textAnchor('top-center', f, 36, 10).align).toBe('center');
  });

  it('insets a bottom-right anchor from the right edge', () => {
    expect(textAnchor('bottom-right', f, 36, 10))
      .toEqual({ vx: 164, vy: 36, align: 'right', angle: 0 });
  });

  it('places center at the visual middle with no rotation', () => {
    const a = textAnchor('center', f, 36, 10);
    expect(a.vx).toBe(100);
    expect(a.vy).toBeCloseTo(50 - 3.5, 6);
    expect(a.angle).toBe(0);
  });

  it('rotates diagonal to the page diagonal', () => {
    // atan2(100, 200) = 26.565 degrees
    expect(textAnchor('diagonal', f, 36, 10).angle).toBeCloseTo(26.5651, 3);
  });

  it('uses 45 degrees on a square page', () => {
    const sq = { ...f, VW: 300, VH: 300 };
    expect(textAnchor('diagonal', sq, 36, 10).angle).toBeCloseTo(45, 6);
  });
});

describe('imageAnchor', () => {
  const f = {
    M: [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number],
    VW: 200, VH: 100, R: 0,
  };

  it('anchors bottom-left at the margin with the bottom-left fraction', () => {
    expect(imageAnchor('bottom-left', f, 36))
      .toEqual({ vx: 36, vy: 36, fx: 0, fy: 0, angle: 0 });
  });

  it('anchors top-right at the inset corner with the top-right fraction', () => {
    expect(imageAnchor('top-right', f, 36))
      .toEqual({ vx: 164, vy: 64, fx: 1, fy: 1, angle: 0 });
  });

  it('centers diagonal on its own middle so it rotates about its center', () => {
    const a = imageAnchor('diagonal', f, 36);
    expect([a.vx, a.vy, a.fx, a.fy]).toEqual([100, 50, 0.5, 0.5]);
    expect(a.angle).toBeCloseTo(26.5651, 3);
  });
});
