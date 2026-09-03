import { describe, it, expect } from 'vitest';
import { imageSize, buildImageXObject } from '../src/imageembed.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

describe('imageSize', () => {
  it('reads a PNG\'s intrinsic pixels', () => {
    expect(imageSize(new Uint8Array(PNG_1x1))).toEqual({ width: 1, height: 1 });
  });

  it('agrees with what buildImageXObject puts in the dict', () => {
    // Two readings of one header is how they would come to disagree, so this
    // asserts they do not.
    const built = buildImageXObject(new Uint8Array(PNG_1x1));
    expect(imageSize(new Uint8Array(PNG_1x1))).toEqual({
      width: built.stream.dict.get('Width'),
      height: built.stream.dict.get('Height'),
    });
  });

  it('is undefined for bytes it cannot read, rather than throwing', () => {
    // The caller routes an undefined straight to the existing
    // `image:<src>`/dropped report; a throw would have to be caught somewhere.
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(imageSize(new Uint8Array(0))).toBeUndefined();
    expect(() => imageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).not.toThrow();
  });
});
