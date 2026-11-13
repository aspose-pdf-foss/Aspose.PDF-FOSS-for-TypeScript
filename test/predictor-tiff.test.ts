import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeTiff } from '../src/tiff.js';
import { buildTiff, baseTags } from './helpers/build-tiff.js';
import { TIFF_PREDICTOR_VECTORS } from './helpers/predictor-vectors.js';

describe.each([true, false])('TIFF packed Predictor 2 container (little endian=%s)', (le) => {
  it.each(TIFF_PREDICTOR_VECTORS.filter((v) => v.colors === 1 && v.bpc <= 4))('$label', (v) => {
    const rowBytes = Math.ceil(v.columns * v.bpc / 8);
    const height = v.encoded.length / rowBytes;
    const input = buildTiff({ le, pages: [{
      tags: baseTags(v.columns, height, 1, [
        { tag: 258, type: 3, values: [v.bpc] }, { tag: 277, type: 3, values: [1] },
        { tag: 259, type: 3, values: [8] }, { tag: 278, type: 4, values: [height] },
        { tag: 317, type: 3, values: [2] },
      ]),
      blocks: [new Uint8Array(deflateSync(Uint8Array.from(v.encoded)))],
    }] });
    const img = decodeTiff(input);
    expect(img.kind).toBe('gray');
    if (img.kind !== 'gray') throw new Error('unexpected image kind');
    expect(img.bpc).toBe(v.bpc);
    expect(img.samples).toEqual(Uint8Array.from(v.decoded));
  });
});
