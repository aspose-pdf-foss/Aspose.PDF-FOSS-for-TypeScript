import { describe, it, expect } from 'vitest';
import { convertShadingSpace, grayscaleShading } from '../src/colorshading.js';
import { respliceMesh, type MeshLayout } from '../src/colormesh.js';
import { PdfDict, PdfObject, PdfStream, isStream, name } from '../src/types.js';
import { inflateSync } from 'node:zlib';

const resolve = (o: PdfObject | undefined): PdfObject => o as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;

const dict = (entries: [string, PdfObject][]): PdfDict =>
  new Map<string, PdfObject>(entries) as PdfDict;

/**
 * `convertShadingSpace` and `respliceMesh` retargeted (85l8.1).
 *
 * `grayshading.test.ts` and `graymesh.test.ts` cover the gray path unedited.
 */
describe('convertShadingSpace — the dict', () => {
  const axial = () => dict([
    ['ShadingType', 2], ['ColorSpace', name('DeviceRGB')],
    ['Coords', [0, 0, 1, 0]],
    ['Function', dict([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
      ['C0', [1, 0, 0]], ['C1', [0, 0, 1]],
    ]) as unknown as PdfObject],
  ]);

  it('retargets /ColorSpace to the target name', () => {
    const r = convertShadingSpace(axial(), resolve, inflate, 'cmyk');
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.dict.get('ColorSpace')).toEqual(name('DeviceCMYK'));
  });

  it('converts a type 2 function s /C0 and /C1 exactly, with no resampling', () => {
    const r = convertShadingSpace(axial(), resolve, inflate, 'cmyk');
    if (r.kind !== 'converted') throw new Error('expected converted');
    const fn = r.dict.get('Function') as PdfDict;
    expect(fn.get('FunctionType')).toBe(2);          // still exact, not a type 0
    expect(fn.get('C0')).toEqual([0, 1, 1, 0]);      // red
    expect(fn.get('C1')).toEqual([1, 1, 0, 0]);      // blue
  });

  it('converts /Background to the target component count', () => {
    const d = axial();
    d.set('Background', [0, 1, 0]);
    const r = convertShadingSpace(d, resolve, inflate, 'cmyk');
    if (r.kind !== 'converted') throw new Error('expected converted');
    expect(r.dict.get('Background')).toEqual([1, 0, 1, 0]);   // green
  });

  it('reports none when the shading is already in the target space', () => {
    const d = axial();
    d.set('ColorSpace', name('DeviceCMYK'));
    expect(convertShadingSpace(d, resolve, inflate, 'cmyk').kind).toBe('none');
  });
});

describe('convertShadingSpace — the resampled route', () => {
  // A type 0 sampled function has no exact form, so it is re-evaluated. Its
  // /Range must gain one interval PER TARGET COMPONENT, or a reader takes the
  // sample table to be one-component and the ramp collapses.
  const sampled = () => dict([
    ['ShadingType', 2], ['ColorSpace', name('DeviceRGB')],
    ['Coords', [0, 0, 1, 0]],
    ['Function', {
      kind: 'stream',
      dict: dict([
        ['FunctionType', 0], ['Domain', [0, 1]], ['Range', [0, 1, 0, 1, 0, 1]],
        ['Size', [2]], ['BitsPerSample', 8],
      ]),
      raw: new Uint8Array([255, 0, 0, 0, 0, 255]),
    } as PdfObject],
  ]);

  it('states one /Range interval per target component', () => {
    const r = convertShadingSpace(sampled(), resolve, inflate, 'cmyk');
    if (r.kind !== 'converted') throw new Error('expected converted');
    const fn = r.dict.get('Function') as PdfStream;
    expect(isStream(fn)).toBe(true);
    expect(fn.dict.get('Range')).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    // 256 samples x 4 components.
    expect(fn.raw).toHaveLength(256 * 4);
  });

  it('states a single /Range interval for gray, as before', () => {
    const r = grayscaleShading(sampled(), resolve, inflate);
    if (r.kind !== 'converted') throw new Error('expected converted');
    const fn = r.dict.get('Function') as PdfStream;
    expect(fn.dict.get('Range')).toEqual([0, 1]);
    expect(fn.raw).toHaveLength(256);
  });
});

describe('respliceMesh — a target of more than one component', () => {
  const layout: MeshLayout = {
    type: 4, bitsPerCoordinate: 16, bitsPerComponent: 8, bitsPerFlag: 8,
    components: 3, colorDecode: [0, 1, 0, 1, 0, 1],
  };

  it('writes every component the recolour returns', () => {
    // flag 0, x = 0x0102, y = 0x0304, rgb = ff 00 00
    const data = new Uint8Array([0, 0x01, 0x02, 0x03, 0x04, 0xff, 0x00, 0x00]);
    const r = respliceMesh(data, layout, (c) => [c[0] ?? 0, 0, 1, 0.5]);
    expect(r).toEqual({
      kind: 'ok',
      data: new Uint8Array([0, 0x01, 0x02, 0x03, 0x04, 0xff, 0x00, 0xff, 0x80]),
    });
  });
});

describe('convertShadingSpace — a function-less mesh', () => {
  const mesh = (): PdfStream => ({
    kind: 'stream',
    dict: dict([
      ['ShadingType', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerCoordinate', 16], ['BitsPerComponent', 8], ['BitsPerFlag', 8],
      ['Decode', [0, 1, 0, 1, 0, 1, 0, 1, 0, 1]],
    ]),
    raw: new Uint8Array([0, 0x01, 0x02, 0x03, 0x04, 0xff, 0x00, 0x00]),
  });

  it('rewrites /Decode s colour half to one range per target component', () => {
    const r = convertShadingSpace(mesh(), resolve, inflate, 'cmyk');
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.dict.get('Decode')).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
    // The vertex now carries four components: red -> (0, 1, 1, 0).
    expect([...inflateSync(r.raw!)])
      .toEqual([0, 0x01, 0x02, 0x03, 0x04, 0x00, 0xff, 0xff, 0x00]);
  });
});
