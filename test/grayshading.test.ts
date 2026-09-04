import { describe, it, expect } from 'vitest';
import { grayscaleShading, grayscaleFunction } from '../src/colorshading.js';
import { parseFunction } from '../src/pdffunction.js';
import { PdfDict, PdfObject, PdfStream, isStream, name } from '../src/types.js';
import { luma } from '../src/colorrule.js';
import { inflateSync } from 'node:zlib';

const resolve = (o: PdfObject | undefined): PdfObject => o as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;
// parseFunction's Inflate is structural ({ dict, raw }), not PdfStream, so a
// PdfStream-typed callback is not assignable to it.
const fnInflate = (s: { dict: PdfDict; raw: Uint8Array }): Uint8Array => s.raw;

const d = (entries: [string, PdfObject][]): PdfDict =>
  new Map<string, PdfObject>(entries) as PdfDict;

const ps = (src: string, domain: number[]): PdfStream => ({
  kind: 'stream',
  dict: d([
    ['FunctionType', 4], ['Domain', domain], ['Range', [0, 1, 0, 1, 0, 1]],
    ['Length', src.length],
  ]),
  raw: new TextEncoder().encode(src),
});

describe('grayscaleFunction — type 2 converts exactly', () => {
  it('maps /C0 and /C1 through luma and keeps /N', () => {
    const fn = d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
      ['C0', [1, 0, 0]], ['C1', [0, 0, 1]],
    ]);
    const out = grayscaleFunction(fn, resolve, inflate, 1) as PdfDict;
    expect(out.get('FunctionType')).toBe(2);
    expect(out.get('N')).toBe(1);
    expect(out.get('C0')).toEqual([0.299]);
    expect(out.get('C1')).toEqual([0.114]);
  });

  it('reads the component count off the colour it was given', () => {
    // Four components is CMYK, not "RGB with a stray operand". Pure cyan.
    const fn = d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
      ['C0', [1, 0, 0, 0]], ['C1', [0, 0, 0, 1]],
    ]);
    const out = grayscaleFunction(fn, resolve, inflate, 1) as PdfDict;
    expect(out.get('C0')).toEqual([0.701]);
    expect(out.get('C1')).toEqual([0]);
  });
});

describe('grayscaleFunction — type 3 recurses', () => {
  it('converts each sub-function and leaves /Bounds and /Encode alone', () => {
    const sub = (c0: number[], c1: number[]): PdfDict => d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1], ['C0', c0], ['C1', c1],
    ]);
    const fn = d([
      ['FunctionType', 3], ['Domain', [0, 1]],
      ['Functions', [sub([1, 0, 0], [0, 1, 0]), sub([0, 1, 0], [0, 0, 1])]],
      ['Bounds', [0.5]], ['Encode', [0, 1, 0, 1]],
    ]);
    const out = grayscaleFunction(fn, resolve, inflate, 1) as PdfDict;
    expect(out.get('Bounds')).toEqual([0.5]);
    expect(out.get('Encode')).toEqual([0, 1, 0, 1]);
    const fns = out.get('Functions') as PdfDict[];
    expect(fns[0].get('C0')).toEqual([0.299]);
    expect(fns[1].get('C1')).toEqual([0.114]);
  });
});

describe('grayscaleFunction — resampling', () => {
  // The oracle is OUTSIDE the conversion: evaluate the converted function and
  // compare against the luma of the ORIGINAL's output. Asserting the emitted
  // dict would only prove the writer agrees with itself.
  const sampleAgrees = (
    original: PdfObject, converted: PdfObject, at: number[][],
  ): void => {
    const before = parseFunction(original, resolve, fnInflate);
    const after = parseFunction(converted, resolve, fnInflate);
    for (const x of at) {
      const rgb = before(x);
      const want = luma(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0);
      expect(after(x)[0]).toBeCloseTo(want, 2);
    }
  };

  it('resamples a type 4 PostScript function into a 1-output sampled function', () => {
    const fn = ps('{ dup 1 exch sub 0 }', [0, 1]);   // t -> (t, 1-t, 0)
    const out = grayscaleFunction(fn, resolve, inflate, 1);
    expect(isStream(out)).toBe(true);
    if (!isStream(out)) return;
    expect(out.dict.get('FunctionType')).toBe(0);
    expect(out.dict.get('Range')).toEqual([0, 1]);
    expect(out.dict.get('Size')).toEqual([256]);
    expect(out.dict.get('BitsPerSample')).toBe(8);
    sampleAgrees(fn, out, [[0], [0.25], [0.5], [0.75], [1]]);
  });

  it('samples a two-input function on a grid, not a line', () => {
    // ShadingType 1 takes a 2-in function. A resampler that assumes one input
    // emits a flat wash -- plausible output nobody looks at closely.
    const fn = ps('{ add 2 div dup dup }', [0, 1, 0, 1]);
    const out = grayscaleFunction(fn, resolve, inflate, 2);
    if (!isStream(out)) throw new Error('expected a sampled function');
    expect(out.dict.get('Size')).toEqual([64, 64]);
    expect(out.dict.get('Domain')).toEqual([0, 1, 0, 1]);
    expect(out.raw.length).toBe(64 * 64);
    // It must actually vary along BOTH axes: a one-input resampler would give
    // every row the same bytes.
    const at = (x: number, y: number) => out.raw[y * 64 + x];
    expect(at(0, 0)).not.toBe(at(63, 0));
    expect(at(0, 0)).not.toBe(at(0, 63));
  });

  it('joins an array of one-output functions into a single function', () => {
    const chan = (v: number): PdfDict => d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1], ['C0', [0]], ['C1', [v]],
    ]);
    const arr: PdfObject = [chan(1), chan(0), chan(0)];   // t -> (t, 0, 0)
    const out = grayscaleFunction(arr, resolve, inflate, 1);
    expect(Array.isArray(out)).toBe(false);
    const after = parseFunction(out, resolve, fnInflate);
    expect(after([1])[0]).toBeCloseTo(0.299, 2);
    expect(after([0])[0]).toBeCloseTo(0, 2);
  });
});

describe('grayscaleShading', () => {
  it('retargets /ColorSpace, greys /Background and converts /Function', () => {
    const sh = d([
      ['ShadingType', 2], ['ColorSpace', name('DeviceRGB')],
      ['Coords', [0, 0, 100, 0]], ['Background', [1, 0, 0]],
      ['Function', d([
        ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
        ['C0', [1, 0, 0]], ['C1', [0, 0, 1]],
      ])],
    ]);
    const r = grayscaleShading(sh, resolve, inflate);
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    expect(r.dict.get('Background')).toEqual([0.299]);
    expect((r.dict.get('Function') as PdfDict).get('C0')).toEqual([0.299]);
  });

  it('reports none for a shading already in DeviceGray', () => {
    const sh = d([['ShadingType', 2], ['ColorSpace', name('DeviceGray')]]);
    expect(grayscaleShading(sh, resolve, inflate).kind).toBe('none');
  });

  it('rewrites a function-less mesh’s bit-packed per-vertex colours', () => {
    const sh: PdfStream = {
      kind: 'stream',
      dict: d([
        ['ShadingType', 4], ['ColorSpace', name('DeviceRGB')],
        ['BitsPerCoordinate', 16], ['BitsPerComponent', 8], ['BitsPerFlag', 8],
        ['Decode', [0, 600, 0, 800, 0, 1, 0, 1, 0, 1]], ['Length', 8],
      ]),
      // flag 0, x = 0x0102, y = 0x0304, rgb = ff 00 00
      raw: new Uint8Array([0, 0x01, 0x02, 0x03, 0x04, 0xff, 0x00, 0x00]),
    };

    const r = grayscaleShading(sh, resolve, inflate);

    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    // The coordinate half of /Decode survives; the three colour ranges become
    // the one grey range.
    expect(r.dict.get('Decode')).toEqual([0, 600, 0, 800, 0, 1]);
    expect(r.raw).toBeDefined();
    // The coordinates are copied bit for bit; luma(1, 0, 0) * 255 rounds to 76.
    expect([...new Uint8Array(inflateSync(r.raw as Uint8Array))])
      .toEqual([0, 0x01, 0x02, 0x03, 0x04, 76]);
  });

  it('skips a mesh with no /Decode, which is where the colour ranges live', () => {
    const sh: PdfStream = {
      kind: 'stream',
      dict: d([
        ['ShadingType', 4], ['ColorSpace', name('DeviceRGB')],
        ['BitsPerCoordinate', 16], ['BitsPerComponent', 8], ['BitsPerFlag', 8],
      ]),
      raw: new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]),
    };
    const r = grayscaleShading(sh, resolve, inflate);
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/Decode/);
  });

  it('converts a mesh that DOES carry a /Function', () => {
    const sh = d([
      ['ShadingType', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerCoordinate', 16], ['BitsPerComponent', 8], ['BitsPerFlag', 8],
      ['Function', d([
        ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
        ['C0', [1, 0, 0]], ['C1', [0, 1, 0]],
      ])],
    ]);
    expect(grayscaleShading(sh, resolve, inflate).kind).toBe('converted');
  });

  it('samples a type 1 shading function on a grid', () => {
    const sh = d([
      ['ShadingType', 1], ['ColorSpace', name('DeviceRGB')],
      ['Domain', [0, 1, 0, 1]],
      ['Function', ps('{ add 2 div dup dup }', [0, 1, 0, 1])],
    ]);
    const r = grayscaleShading(sh, resolve, inflate);
    if (r.kind !== 'converted') throw new Error('expected converted');
    const fn = r.dict.get('Function');
    if (!isStream(fn)) throw new Error('expected a sampled function');
    expect(fn.dict.get('Size')).toEqual([64, 64]);
  });
});
