import type { OcrEngine, OcrImage, OcrSpan } from '../../src/ocr.js';

/** A scripted OcrEngine: `byPage(n, image)` answers the n-th call (1-based). */
export function fakeOcr(
  byPage: (n: number, image: OcrImage) => OcrSpan[] | Promise<OcrSpan[]>,
): OcrEngine & { calls: OcrImage[] } {
  const calls: OcrImage[] = [];
  return {
    calls,
    async recognize(image: OcrImage): Promise<OcrSpan[]> {
      calls.push(image);
      return byPage(calls.length, image);
    },
  };
}
