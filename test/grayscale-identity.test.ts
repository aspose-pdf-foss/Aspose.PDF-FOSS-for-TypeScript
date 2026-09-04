import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import {
  buildGrayscalePdf, buildGrayscaleImagePdf, buildGrayscaleShadingPdf,
  buildGrayscaleMeshPdf, buildColorKeyMaskPdf,
} from './helpers/build-grayscale-pdf.js';

/**
 * The byte-identity fence for `ConvertToGrayscale` (85l8.1).
 *
 * This is a FENCE, not a golden to refresh when it goes red. Generalizing the
 * walk to take a target space touches all six gray* modules, and the gray path
 * must not move.
 *
 * What it is FOR, measured rather than assumed -- the first rationale written
 * here was wrong and is recorded because the mistake is instructive. It does
 * NOT uniquely catch a broken colour rule: routing `grayOf`'s gray arm through
 * `luma(g, g, g)` reddens `grayscale-core.test.ts`'s own unit assertion and
 * leaves every hash here GREEN, because `colorops.ts` short-circuits on
 * `space.kind === 'gray'` and never calls it. Nor does it uniquely catch a
 * sample-rounding change: `Math.floor` in `greySamples` reddens
 * `grayimage.test.ts` and `grayscale-convert.test.ts` too.
 *
 * What it catches ALONE is an INCIDENTAL ENCODING change -- one the semantic
 * assertions provably cannot see, because they inflate a stream and read the
 * operators out of it. Measured: making `convertContent` re-deflate its output
 * instead of writing raw bytes reddens exactly one case here and NOTHING in
 * the other seven files, 90 assertions of which stay green. That is the whole
 * class this fence exists for -- a rewrite that keeps every documented
 * behaviour and quietly changes filter selection, dict key order, stream
 * lengths or number spelling.
 *
 * `Save()` is byte-deterministic here -- it preserves the document `/ID` and
 * the fixtures are built from fixed bytes -- measured over two runs of each
 * fixture before these constants were recorded.
 *
 * Note what the fixtures REACH, since it bounds every claim above: the `flate`
 * and `jpeg-exact` image routes, two shadings, one mesh and a colour-key
 * /Mask. The `jpeg` and `palette` routes are NOT reached by any of them --
 * dropping the JPEG quality default from 90 to 85 reddens nothing here -- so
 * do not read these hashes as covering the lossy route. `grayimage.test.ts`
 * drives that one directly.
 *
 * Recorded 2026-09-03 against the pre-85l8.1 implementation.
 */
const EXPECTED: ReadonlyArray<readonly [string, () => Uint8Array, string]> = [
  ['content streams', buildGrayscalePdf,
    '4c128ab45eafbd9fe22f12af4c6367971a2389a29ced7250c178428a9d2195ea'],
  ['image XObjects', buildGrayscaleImagePdf,
    'd8cc09a77e7308ee28bbddaaccc933cee82a0a249a255f8e13763c29686856b3'],
  ['shadings', buildGrayscaleShadingPdf,
    'fd6cbe8f8a02405a35ac897d40b57148bd702b7676549e811c22aac714b779d2'],
  ['mesh shadings', buildGrayscaleMeshPdf,
    'ae275af9cf26f41b79bf325c53f2bb23734b3a9b5f4293c212a537632881c284'],
  ['a colour-key /Mask', buildColorKeyMaskPdf,
    '708a17bb1c7ba72719f5c617e82654dcad5c502e34cb130dc74e3208b63c245d'],
];

describe('ConvertToGrayscale byte identity', () => {
  for (const [what, build, sha] of EXPECTED) {
    it(`is byte-identical for ${what}`, () => {
      const doc = Document.Open(build());
      doc.ConvertToGrayscale();
      expect(createHash('sha256').update(doc.Save()).digest('hex')).toBe(sha);
    });
  }
});
