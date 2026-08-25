import { describe, it, expect } from 'vitest';
import { xywh, rectToQuads, centeredRect } from '../examples/feature-showcase/theme.js';

describe('showcase theme geometry', () => {
  it('converts a Go-shaped box to x/y/w/h', () => {
    expect(xywh([50, 100, 250, 160])).toEqual([50, 100, 200, 60]);
  });

  it('emits QuadPoints in top-left, top-right, bottom-left, bottom-right order', () => {
    // PDF 32000-1 12.5.6.10 order, as the library's own README documents it.
    expect(rectToQuads([72, 528, 240, 540])).toEqual([
      72, 540, 240, 540, // top-left, top-right
      72, 528, 240, 528, // bottom-left, bottom-right
    ]);
  });

  it('centres a box of the given size inside an outer box', () => {
    expect(centeredRect([0, 0, 100, 100], 40, 20)).toEqual([30, 40, 70, 60]);
  });
});
