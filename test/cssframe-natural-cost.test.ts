import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { frameBoxes, type BoxFrame } from '../src/cssframe.js';
import { paragraph } from '../src/flow.js';
import type { FlowElement } from '../src/flowelement.js';

// v9j3.4 final review: `BoxRun.natural` re-measures EVERY child of a box, and
// it was asked by every slice's paint — for plain boxes too, which need no
// whole-box height at all — so a <div> of N paragraphs cost N² layouts:
// 98.8 s at 2,000 where 218 ms was the baseline. Counted rather than timed:
// measure calls on the inner elements must stay linear in N.
const N = 200;
function counted(): { els: FlowElement[]; calls: () => number } {
  let calls = 0;
  const els = Array.from({ length: N }, (_, i) => paragraph(`line ${i}`, { font: 'Helvetica', fontSize: 10 })).flat()
    .map((e) => new Proxy(e, {
      get(t, k) {
        if (k === 'measure') return (c: Parameters<NonNullable<FlowElement['measure']>>[0]) => { calls++; return t.measure!(c); };
        const v = (t as unknown as Record<PropertyKey, unknown>)[k as string];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }));
  return { els, calls: () => calls };
}
const FRAME: BoxFrame = {
  marginLeft: 0, marginRight: 0, insetLeft: 0, insetRight: 0, insetTop: 0, insetBottom: 0, minHeight: 0,
};

describe('a box of many children measures them a linear number of times', () => {
  for (const [label, extra] of [
    ['plain colour box', { background: [1, 0.9, 0.9] }],
    ['gradient box', { layer: { source: { kind: 'gradient', g: { kind: 'linear', angle: 180, stops: [
      { color: [1, 0, 0], alpha: 1 }, { color: [0, 0, 1], alpha: 1 }] } },
    layer: { size: ['auto', 'auto'], posX: { abs: 0, frac: 0 }, posY: { abs: 0, frac: 0 }, repeatX: true, repeatY: true } } }],
  ] as const) {
    it(label, () => {
      const { els, calls } = counted();
      const d = Document.New();
      d.NewFlow({}).AddElements(frameBoxes(els, { ...FRAME, ...(extra as Partial<BoxFrame>) })).Render();
      expect(calls()).toBeLessThan(20 * N);
    });
  }
});
