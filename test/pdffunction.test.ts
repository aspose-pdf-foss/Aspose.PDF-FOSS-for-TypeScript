import { describe, it, expect } from 'vitest';
import { parseFunction } from '../src/pdffunction.js';
import { PdfDict, PdfObject, PdfStream } from '../src/types.js';

const id = (o: PdfObject | undefined): PdfObject => o ?? null;
const inflate = (s: { raw: Uint8Array }) => s.raw;

function dict(entries: Record<string, PdfObject>): PdfDict {
  return new Map(Object.entries(entries));
}

describe('parseFunction', () => {
  it('evaluates a type 2 exponential function', () => {
    const f = parseFunction(
      dict({ FunctionType: 2, Domain: [0, 1], C0: [0, 0, 0], C1: [1, 0.5, 0], N: 1 }),
      id, inflate,
    );
    expect(f([0]).map((n) => +n.toFixed(3))).toEqual([0, 0, 0]);
    expect(f([1]).map((n) => +n.toFixed(3))).toEqual([1, 0.5, 0]);
    expect(f([0.5]).map((n) => +n.toFixed(3))).toEqual([0.5, 0.25, 0]);
  });

  it('evaluates a type 3 stitching function', () => {
    const seg = (c0: number, c1: number) =>
      dict({ FunctionType: 2, Domain: [0, 1], C0: [c0], C1: [c1], N: 1 });
    const f = parseFunction(
      dict({ FunctionType: 3, Domain: [0, 1], Functions: [seg(0, 1), seg(1, 0)],
             Bounds: [0.5], Encode: [0, 1, 0, 1] }),
      id, inflate,
    );
    expect(f([0.25])[0]).toBeCloseTo(0.5, 3);
    expect(f([0.75])[0]).toBeCloseTo(0.5, 3);
  });
});

/** A type 4 function stream carrying `src` as its program. */
function psFn(src: string, range: number[], domain: number[] = [0, 1]): PdfStream {
  return {
    kind: 'stream',
    dict: dict({ FunctionType: 4, Domain: domain, Range: range }),
    raw: new TextEncoder().encode(src),
  };
}

describe('parseFunction — type 4', () => {
  it('evaluates a PostScript calculator function instead of a flat midpoint', () => {
    // R = t, G = 0, B = 1 - t. The midpoint fallback would return
    // [0.5, 0.5, 0.5] for every input, so a varying result is the assertion.
    const f = parseFunction(psFn('{ dup 0 exch 1 exch sub }', [0, 1, 0, 1, 0, 1]), id, inflate);
    expect(f([0]).map((n) => +n.toFixed(3))).toEqual([0, 0, 1]);
    expect(f([1]).map((n) => +n.toFixed(3))).toEqual([1, 0, 0]);
    expect(f([0.25]).map((n) => +n.toFixed(3))).toEqual([0.25, 0, 0.75]);
  });

  it('clamps each output to its own /Range pair', () => {
    const f = parseFunction(psFn('{ pop 5 -5 }', [0, 1, 0, 2]), id, inflate);
    expect(f([0])).toEqual([1, 0]);
  });

  it('takes the output count from /Range', () => {
    const f = parseFunction(psFn('{ pop 1 2 3 }', [0, 9, 0, 9]), id, inflate);
    expect(f([0])).toEqual([2, 3]);        // topmost 2, last on top
  });

  it('clamps the input to /Domain before running the program', () => {
    const f = parseFunction(psFn('{ }', [0, 10], [2, 5]), id, inflate);
    expect(f([9])).toEqual([5]);
    expect(f([-3])).toEqual([2]);
  });

  it('falls back to the Range midpoint when the program will not parse', () => {
    const f = parseFunction(psFn('{ 1 2 add', [0, 1, 0, 4]), id, inflate);
    expect(f([0])).toEqual([0.5, 2]);
  });

  it('falls back to the Range midpoint when the program faults at run time', () => {
    const f = parseFunction(psFn('{ pop add }', [0, 1]), id, inflate);
    expect(f([0])).toEqual([0.5]);
  });

  it('keeps the midpoint fallback for genuinely unsupported function types', () => {
    const f = parseFunction(dict({ FunctionType: 7, Domain: [0, 1], Range: [0, 1] }), id, inflate);
    expect(f([0])).toEqual([0.5]);
  });

  it('returns equal results from the cache on a repeated input', () => {
    // /Domain must admit 3 and 4 — the default [0,1] would clamp both and make
    // the test pass for the wrong reason.
    const f = parseFunction(psFn('{ dup mul }', [0, 100], [0, 10]), id, inflate);
    expect(f([3])).toEqual([9]);
    expect(f([3])).toEqual([9]);
    expect(f([4])).toEqual([16]);
    expect(f([3])).toEqual([9]);
  });
});
