import { describe, it, expect } from 'vitest';
import { decodeJbig2 } from '../src/jbig2.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { halftoneStream, huffmanTextStream, refinementStream, segmentStream } from './helpers/jbig2-unsupported.js';

describe('JBIG2 graceful rejection', () => {
  // Halftone regions decode as of utax.1, so this stream — a bare type-22
  // header with a zero-length body — is no longer an unsupported feature but a
  // damaged file: it is far shorter than the 38 bytes a halftone region's own
  // header occupies before any coded data. Same inversion utax.3 made for the
  // refinement case below.
  it('rejects a truncated halftone region rather than decoding garbage', () => {
    expect(() => decodeJbig2(halftoneStream(), undefined, 8, 8)).toThrow(PdfParseError);
    expect(() => decodeJbig2(halftoneStream(), undefined, 8, 8)).toThrow(/truncated/i);
  });

  // Huffman-coded text regions decode as of utax.7, the last coding feature in
  // the epic. This stream carries a region header and no coded data at all, so
  // it is now a damaged file: the symbol-ID code table (§7.4.3.1.7) reads 35
  // runcode lengths off the front, finds all zeros, and no runcode can match.
  it('rejects a Huffman text region with no coded data rather than decoding garbage', () => {
    expect(() => decodeJbig2(huffmanTextStream(), undefined, 8, 8)).toThrow(PdfParseError);
  });

  // NOTHING in the JBIG2 stack refuses a coding feature any more — after
  // utax.7 the only UnsupportedFeatureError left is for a segment type T.88
  // does not assign. That is the epic's goal, so it is asserted rather than
  // claimed: type 60 is unassigned and must still be named, and none of the
  // real ones may join it.
  it('refuses only an unassigned segment type, and by name', () => {
    const assigned = [0, 4, 6, 7, 16, 20, 22, 23, 36, 38, 39, 40, 42, 43, 48, 49, 50, 51, 52, 53, 62];
    for (const type of assigned) {
      let err: unknown;
      try { decodeJbig2(segmentStream(type), undefined, 8, 8); } catch (e) { err = e; }
      expect(err, `segment type ${type}`).not.toBeInstanceOf(UnsupportedFeatureError);
    }
    expect(() => decodeJbig2(segmentStream(60), undefined, 8, 8)).toThrow(UnsupportedFeatureError);
  });

  // Refinement regions decode as of utax.3, so this stream — a bare type-40
  // header with a zero-length body — is no longer an unsupported feature but a
  // damaged file, and must be refused as one rather than decoded into a bitmap
  // built out of bytes that are not there.
  it('rejects a truncated refinement region rather than decoding garbage', () => {
    expect(() => decodeJbig2(refinementStream(), undefined, 8, 8)).toThrow(PdfParseError);
    expect(() => decodeJbig2(refinementStream(), undefined, 8, 8)).toThrow(/truncated/i);
  });
});
