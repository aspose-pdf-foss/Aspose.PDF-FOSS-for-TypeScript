import { describe, it, expect } from 'vitest';
import { grayscaleOps, type SpaceLookup } from '../src/grayops.js';
import type { GraySpace } from '../src/grayscale.js';
import type { ContentOp } from '../src/content.js';
import { name } from '../src/types.js';

const op = (operator: string, ...operands: unknown[]): ContentOp =>
  ({ operator, operands: operands as ContentOp['operands'] });

const none: SpaceLookup = () => undefined;

describe('grayscaleOps — device colour operators', () => {
  it('rewrites rg to g with the luma', () => {
    const r = grayscaleOps([op('rg', 1, 0, 0)], none);
    expect(r.ops).toEqual([op('g', 0.299)]);
    expect(r.changed).toBe(1);
  });

  it('rewrites RG to G, keeping the stroke/fill distinction', () => {
    const r = grayscaleOps([op('RG', 0, 1, 0)], none);
    expect(r.ops).toEqual([op('G', 0.587)]);
  });

  it('rewrites k to g', () => {
    const r = grayscaleOps([op('k', 1, 0, 0, 0)], none);
    expect(r.ops).toEqual([op('g', 0.701)]);
  });

  it('leaves g and G untouched and counts no change', () => {
    const r = grayscaleOps([op('g', 0.5), op('G', 0.25)], none);
    expect(r.ops).toEqual([op('g', 0.5), op('G', 0.25)]);
    expect(r.changed).toBe(0);
  });

  it('leaves non-colour operators alone', () => {
    const ops = [op('q'), op('re', 0, 0, 10, 10), op('f'), op('Q')];
    const r = grayscaleOps(ops, none);
    expect(r.ops).toEqual(ops);
    expect(r.changed).toBe(0);
  });
});

describe('grayscaleOps — named colour spaces', () => {
  const lookup: SpaceLookup = (n) =>
    n === 'CS0' ? ({ kind: 'rgb' } as GraySpace) : undefined;

  it('retargets cs to DeviceGray and converts the following sc', () => {
    const r = grayscaleOps([op('cs', name('CS0')), op('sc', 1, 0, 0)], lookup);
    expect(r.ops).toEqual([op('cs', name('DeviceGray')), op('g', 0.299)]);
    expect(r.changed).toBe(2);
  });

  it('resolves scn through the space in force, not the operand count', () => {
    // Four operands in a DeviceN space -- an operand-count heuristic would
    // read this as CMYK and get a different answer.
    const dn: SpaceLookup = (n) => n === 'DN' ? ({
      kind: 'other',
      converter: { components: 4, toRgb: () => [0, 0, 255], initial: () => [0, 0, 0] },
    } as GraySpace) : undefined;
    const r = grayscaleOps([op('cs', name('DN')), op('scn', 0.1, 0.2, 0.3, 0.4)], dn);
    expect(r.ops[1]).toEqual(op('g', 0.114));
  });

  it('does not rewrite a cs that already names DeviceGray', () => {
    const r = grayscaleOps([op('cs', name('DeviceGray')), op('sc', 0.5)], none);
    expect(r.changed).toBe(0);
    expect(r.ops).toEqual([op('cs', name('DeviceGray')), op('sc', 0.5)]);
  });

  it('falls back to gray for an unresolvable space rather than throwing', () => {
    const r = grayscaleOps([op('cs', name('Nope')), op('sc', 0.5)], none);
    expect(() => r).not.toThrow();
    expect(r.ops[0]).toEqual(op('cs', name('DeviceGray')));
  });
});

describe('grayscaleOps — graphics state', () => {
  it('restores the space in force across q/Q', () => {
    const lookup: SpaceLookup = (n) => n === 'CS0' ? ({ kind: 'rgb' } as GraySpace) : undefined;
    const r = grayscaleOps([
      op('cs', name('CS0')),
      op('q'), op('cs', name('DeviceGray')), op('sc', 0.5), op('Q'),
      op('sc', 1, 0, 0),
    ], lookup);
    // The trailing sc must still be read as RGB -- the inner DeviceGray was popped.
    expect(r.ops[5]).toEqual(op('g', 0.299));
  });

  it('clamps an unbalanced Q instead of throwing', () => {
    expect(() => grayscaleOps([op('Q'), op('Q'), op('rg', 1, 0, 0)], none)).not.toThrow();
    const r = grayscaleOps([op('Q'), op('rg', 1, 0, 0)], none);
    expect(r.ops[1]).toEqual(op('g', 0.299));
  });

  it('starts in DeviceGray, PDF initial colour', () => {
    const r = grayscaleOps([op('sc', 0.4)], none);
    expect(r.changed).toBe(0);
  });
});

describe('grayscaleOps — patterns', () => {
  it('leaves a coloured pattern scn entirely alone', () => {
    const r = grayscaleOps(
      [op('cs', name('Pattern')), op('scn', name('P0'))], none);
    expect(r.ops).toEqual([op('cs', name('Pattern')), op('scn', name('P0'))]);
    expect(r.changed).toBe(0);
  });

  it('converts an uncoloured pattern operands and reports its space', () => {
    const lookup: SpaceLookup = (n) => n === 'CSp'
      ? ({ kind: 'pattern', base: { kind: 'rgb' }, resourceName: 'CSp' } as GraySpace)
      : undefined;
    const r = grayscaleOps(
      [op('cs', name('CSp')), op('scn', 1, 0, 0, name('P0'))], lookup);
    // The pattern space itself is kept: the name must stay resolvable.
    expect(r.ops[0]).toEqual(op('cs', name('CSp')));
    expect(r.ops[1]).toEqual(op('scn', 0.299, name('P0')));
    expect([...r.patternSpaces]).toEqual(['CSp']);
  });
});

describe('grayscaleOps — inline images', () => {
  const bi = (dict: [string, unknown][], data: Uint8Array): ContentOp => ({
    operator: 'BI', operands: [],
    inlineImage: { dict: new Map(dict) as never, data },
  });

  it('greys unfiltered RGB samples and rewrites /CS and /BPC', () => {
    const op0 = bi([
      ['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8],
    ], new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));

    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(1);
    const out = r.ops[0].inlineImage!;
    expect(out.dict.get('CS')).toEqual(name('G'));
    expect(out.dict.get('BPC')).toBe(8);
    expect([...out.data]).toEqual([76, 150, 29, 255]);
  });

  it('leaves an inline image mask alone', () => {
    const op0 = bi([['W', 8], ['H', 1], ['IM', true]], new Uint8Array([0xff]));
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(0);
    expect(r.ops[0]).toBe(op0);
  });

  it('leaves a filtered inline image alone rather than guessing at its bytes', () => {
    const op0 = bi([
      ['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8], ['F', name('Fl')],
    ], new Uint8Array([1, 2, 3]));
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(0);
  });

  it('leaves an already-grey inline image alone', () => {
    const op0 = bi([['W', 2], ['H', 2], ['CS', name('G')], ['BPC', 8]],
      new Uint8Array([1, 2, 3, 4]));
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(0);
  });

  it('greys a CMYK inline image by its own space, not as RGB', () => {
    const op0 = bi([['W', 1], ['H', 1], ['CS', name('CMYK')], ['BPC', 8]],
      new Uint8Array([255, 0, 0, 0]));   // pure cyan
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(1);
    expect([...r.ops[0].inlineImage!.data]).toEqual([179]);
  });
});
