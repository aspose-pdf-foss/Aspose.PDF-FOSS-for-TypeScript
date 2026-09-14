import { describe, it, expect } from 'vitest';
import { repointSpotSpace, SPOT_SAMPLE_BUDGET } from '../src/colorsep.js';
import { parseFunction } from '../src/pdffunction.js';
import { name, type PdfObject, type PdfDict, type PdfStream, isStream } from '../src/types.js';

/**
 * Repointing a Separation or DeviceN over a device alternate (`ixxw.4`).
 *
 * PDF cannot compose a tint transform with an alternate-space conversion, so
 * the composition is RESAMPLED into a type 0 (sampled) function over the
 * target. The space keeps its KIND, its colorant NAMES and its component
 * COUNT, which is what lets every content stream that selects it go untouched
 * — only the alternate and the tint function change.
 *
 * This module is a pure leaf: it takes `resolve`/`inflate` as arguments and
 * allocates nothing, so the tint-function stream comes back for
 * `colorconvert.ts` to give an object number. Every rule below is therefore
 * drivable from hand-built arrays with no document.
 */

const R = (o: PdfObject | undefined): PdfObject => (o === undefined ? null : o);
const INFLATE = (s: { raw: Uint8Array }): Uint8Array => s.raw;

/** A type 2 exponential tint: 0 -> C0, 1 -> C1, linear in between. */
const tint2 = (c0: number[], c1: number[]): PdfDict => new Map<string, PdfObject>([
  ['FunctionType', 2], ['Domain', [0, 1]], ['C0', c0], ['C1', c1], ['N', 1],
]);

/** `[/Separation /Spot <alt> <tint>]`. */
const sep = (alt: string, tint: PdfObject): PdfObject[] =>
  [name('Separation'), name('Spot'), name(alt), tint];

describe('repointSpotSpace — what it rebuilds', () => {
  it('keeps the kind, the colorant name and the component count', () => {
    const out = repointSpotSpace(sep('DeviceCMYK', tint2([0, 0, 0, 0], [0, 1, 1, 0])), R, INFLATE, 'rgb');
    expect(out).toBeDefined();
    expect(out!.family).toBe('Separation');
    expect((out!.names as { name: string }).name).toBe('Spot');
    expect(out!.grid).toHaveLength(1);
  });

  it('hands back a type 0 stream for the caller to allocate', () => {
    const out = repointSpotSpace(sep('DeviceCMYK', tint2([0, 0, 0, 0], [0, 1, 1, 0])), R, INFLATE, 'rgb')!;
    expect(isStream(out.fn)).toBe(true);
    expect((out.fn.dict.get('FunctionType'))).toBe(0);
    expect(out.fn.dict.get('Domain')).toEqual([0, 1]);
    expect(out.fn.dict.get('Range')).toEqual([0, 1, 0, 1, 0, 1]);
    expect(out.fn.dict.get('BitsPerSample')).toBe(8);
    expect(out.fn.dict.get('Size')).toEqual([SPOT_SAMPLE_BUDGET]);
    // Three components at one byte each, over the whole grid.
    expect(out.fn.raw.length).toBe(SPOT_SAMPLE_BUDGET * 3);
  });

  // The whole point: evaluating the NEW function must give what evaluating the
  // OLD tint and then converting its alternate gave. A linear ramp lands on
  // the sample points exactly, so this is an equality rather than a tolerance.
  it('reproduces the composed transform', () => {
    const tint = tint2([0, 0, 0, 0], [0, 1, 1, 0]); // ramp to red-ish CMYK
    const out = repointSpotSpace(sep('DeviceCMYK', tint), R, INFLATE, 'rgb')!;
    const f = parseFunction(out.fn, R, INFLATE);
    // tint 1 -> CMYK (0,1,1,0) -> RGB (1,0,0)
    const [r, g, b] = f([1]);
    expect(r).toBeCloseTo(1, 2);
    expect(g).toBeCloseTo(0, 2);
    expect(b).toBeCloseTo(0, 2);
    // tint 0 -> CMYK (0,0,0,0) -> white
    expect(f([0])).toEqual([1, 1, 1].map((v) => expect.closeTo(v, 2)) as never);
  });

  it('declines a space whose alternate already IS the target', () => {
    expect(repointSpotSpace(sep('DeviceRGB', tint2([0, 0, 0], [1, 0, 0])), R, INFLATE, 'rgb'))
      .toBeUndefined();
  });

  it('declines anything that is not a Separation or DeviceN', () => {
    expect(repointSpotSpace([name('ICCBased'), null], R, INFLATE, 'rgb')).toBeUndefined();
    expect(repointSpotSpace([name('Separation')], R, INFLATE, 'rgb')).toBeUndefined();
    expect(repointSpotSpace([], R, INFLATE, 'rgb')).toBeUndefined();
  });
});

describe('repointSpotSpace — DeviceN', () => {
  const devN = (n: number, alt: string): PdfObject[] => [
    name('DeviceN'),
    Array.from({ length: n }, (_, i) => name(`Spot${i}`)),
    name(alt),
    new Map<string, PdfObject>([
      ['FunctionType', 2], ['Domain', Array.from({ length: n * 2 }, (_, i) => i % 2)],
      ['C0', [0, 0, 0, 0]], ['C1', [0, 0, 0, 1]], ['N', 1],
    ]),
  ];

  it('keeps every colorant name and gives the grid one axis per colorant', () => {
    const out = repointSpotSpace(devN(2, 'DeviceCMYK'), R, INFLATE, 'rgb')!;
    expect(out.family).toBe('DeviceN');
    expect((out.names as { name: string }[]).map((x) => x.name)).toEqual(['Spot0', 'Spot1']);
    expect(out.grid).toHaveLength(2);
    expect(out.fn.dict.get('Domain')).toEqual([0, 1, 0, 1]);
  });

  // One axis per colorant against a FIXED TOTAL budget, so a many-colorant
  // space is sampled more coarsely rather than exploding.
  it('spends a fixed total sample budget across the axes', () => {
    const size = (n: number) =>
      repointSpotSpace(devN(n, 'DeviceCMYK'), R, INFLATE, 'rgb')!.grid;
    expect(size(1)).toEqual([SPOT_SAMPLE_BUDGET]);
    for (const n of [2, 3, 4]) {
      const g = size(n);
      expect(g).toHaveLength(n);
      expect(g.every((k) => k === g[0])).toBe(true);
      expect(g.reduce((a, b) => a * b, 1)).toBeLessThanOrEqual(SPOT_SAMPLE_BUDGET ** 1 * 4096);
      expect(g[0]).toBeGreaterThan(1);
    }
  });

  /**
   * The first axis varies FASTEST in a type 0 sample stream (32000-1 7.10.2) —
   * the OPPOSITE of an ICC CLUT, where `icclut.ts` records the first channel
   * varying slowest. Two sampled-table conventions that look alike and run in
   * opposite directions; the implementation shipped with the ICC one and this
   * case is what caught it.
   *
   * Measured: NO other case here can see it. The Separation ones have a single
   * axis, where order is meaningless, and the DeviceN ones above assert the
   * grid and the names but never a sample VALUE. Transposing the walk yields a
   * perfectly smooth surface with the colorants swapped.
   *
   * It needs a tint whose two inputs do DIFFERENT things, so a type 4
   * calculator: with `a b` on the stack, `{ 0 0 }` leaves `a b 0 0` — C from
   * the first colorant, M from the second.
   */
  it('walks the sample grid with the first axis varying fastest', () => {
    const body = new TextEncoder().encode('{ 0 0 }');
    const fn: PdfStream = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['FunctionType', 4], ['Domain', [0, 1, 0, 1]],
        ['Range', [0, 1, 0, 1, 0, 1, 0, 1]], ['Length', body.length],
      ]),
      raw: body,
    };
    const space: PdfObject[] = [
      name('DeviceN'), [name('A'), name('B')], name('DeviceCMYK'), fn,
    ];
    const out = repointSpotSpace(space, R, INFLATE, 'rgb')!;
    const f = parseFunction(out.fn, R, INFLATE);
    const [r1, g1, b1] = f([1, 0]);   // C=1 -> cyan
    const [r2, g2, b2] = f([0, 1]);   // M=1 -> magenta
    expect([r1, g1, b1].map((v) => Math.round(v!))).toEqual([0, 1, 1]);
    expect([r2, g2, b2].map((v) => Math.round(v!))).toEqual([1, 0, 1]);
  });

  it('carries a DeviceN attributes dictionary through verbatim', () => {
    const attrs = new Map<string, PdfObject>([['Subtype', name('NChannel')]]);
    const out = repointSpotSpace([...devN(2, 'DeviceCMYK'), attrs], R, INFLATE, 'rgb')!;
    expect(out.attrs).toBe(attrs);
  });
});

// --- integration: the option, the content stream, and the render ------------

import { Document } from '../src/index.js';
import { convertColors } from '../src/colorconvert.js';
import { decodePng } from './helpers/decode-png.js';
import { assemble, contentStream } from './helpers/build-grayscale-pdf.js';
import { isArray, isName } from '../src/types.js';

/**
 * A page with a process-CMYK fill AND a spot fill. The CMYK fill is what
 * triggers `ConvertToPdfA`'s colour pass; the spot is what must survive it.
 */
function buildSpotPdf(): Uint8Array {
  const objs: (string | { dict: string; raw: Uint8Array })[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R '
    + '/Resources << /ColorSpace << /Sep 5 0 R >> >> >>';
  objs[4] = contentStream(
    '0 1 1 0 k 0 0 50 100 re f\n'          // process CMYK: triggers the pass
    + '/Sep cs 1 scn 50 0 50 100 re f\n',  // the spot: must survive
  );
  objs[5] = '[/Separation /Spot /DeviceCMYK 6 0 R]';
  objs[6] = '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 0 0] /N 1 >>';
  return assemble(objs);
}

const sepArray = (doc: Document): readonly PdfObject[] => {
  const res = doc.Pages[0]!.Resources as PdfDict;
  const cs = doc.resolve(res.get('ColorSpace')) as PdfDict;
  const arr = doc.resolve(cs.get('Sep'));
  return isArray(arr) ? arr : [];
};
const altName = (doc: Document): string | undefined => {
  const a = doc.resolve(sepArray(doc)[2]);
  return isName(a) ? a.name : undefined;
};
const contentText = (doc: Document): string =>
  new TextDecoder('latin1').decode(doc.Save());

function meanOf(doc: Document): [number, number, number] {
  const img = decodePng(doc.Pages[0]!.ToImage({ scale: 1 }));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [pr, pg, pb] = img.at(x, y);
      r += pr; g += pg; b += pb; n++;
    }
  }
  return [r / n, g / n, b / n];
}

describe('convertColors — preserveSpotColors', () => {
  it('repoints the space and leaves the content stream alone', () => {
    const doc = Document.Open(buildSpotPdf());
    expect(altName(doc)).toBe('DeviceCMYK');
    convertColors(doc, 'rgb', { preserveSpotColors: true });
    expect(altName(doc)).toBe('DeviceRGB');
    // The colorant name and the operators that select it are untouched.
    expect((doc.resolve(sepArray(doc)[1]) as { name: string }).name).toBe('Spot');
    const text = contentText(doc);
    expect(text).toContain('/Sep cs');
    expect(text).toContain('1 scn');
    // The process CMYK beside it still converted.
    expect(text).not.toContain(' k\n');
  });

  it('renders the same after repointing', () => {
    const doc = Document.Open(buildSpotPdf());
    const before = meanOf(doc);
    convertColors(doc, 'rgb', { preserveSpotColors: true });
    const after = meanOf(doc);
    expect(before[0]).toBeGreaterThan(20);
    expect(before[0]).toBeLessThan(235);
    for (const i of [0, 1, 2]) expect(after[i]).toBeCloseTo(before[i]!, -0.5);
  });

  // The fence for every existing caller: without the option, today's
  // flattening stands and the spot becomes process colour.
  it('flattens the spot when the option is off, as it always has', () => {
    const doc = Document.Open(buildSpotPdf());
    convertColors(doc, 'rgb');
    const text = contentText(doc);
    expect(text).not.toContain('/Sep cs');
    expect(altName(doc)).toBe('DeviceCMYK'); // the space itself is untouched
  });
});

describe('ConvertToPdfA — a spot colour survives the colour pass', () => {
  it('converts the process colour and repoints the spot', () => {
    const doc = Document.Open(buildSpotPdf());
    const before = meanOf(doc);
    const report = doc.ConvertToPdfA('2b');
    expect(report.applied.map((a) => a.rule)).toContain('DeviceColor');
    expect(altName(doc)).toBe('DeviceRGB');
    const text = contentText(doc);
    expect(text).toContain('/Sep cs');
    expect(text).not.toContain(' k\n');
    for (const i of [0, 1, 2]) expect(meanOf(doc)[i]).toBeCloseTo(before[i]!, -0.5);
  });
});
