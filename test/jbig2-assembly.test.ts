import { describe, it, expect } from 'vitest';
import { decodeJbig2 } from '../src/jbig2.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { customTableSegment, segmentStream } from './helpers/jbig2-unsupported.js';
import * as F from './helpers/jbig2-fixtures.js';

/** Packed samples for a page with no ink. `packBitmap` sets one bit per black
 *  pixel and then inverts the whole buffer, so an empty page is every byte
 *  0xff — not 0x00. */
function blank(width: number, height: number): number[] {
  return Array.from(new Uint8Array(((width + 7) >> 3) * height).fill(0xff));
}

describe('jbig2 page assembly', () => {
  it('composites an immediate generic region (type 38) onto the page', () => {
    const out = decodeJbig2(F.generic_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(Array.from(F.generic_samples));
  });

  // T.88 7.4: an intermediate region is decoded and held for a later segment to
  // consume. It is invisible to the page until something consumes it — and in
  // this child nothing does yet, so the page stays empty. The second assertion
  // guards the first: without it, a `blank()` that happened to match the
  // region's real samples would pass.
  it('holds an intermediate generic region (type 36) off the page', () => {
    const out = decodeJbig2(F.intermediate_generic_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(blank(16, 16));
    expect(Array.from(out)).not.toEqual(Array.from(F.generic_samples));
  });

  it('composites an immediate text region (type 6) onto the page', () => {
    const out = decodeJbig2(F.symtext_stream, undefined, 12, 6);
    expect(Array.from(out)).toEqual(Array.from(F.symtext_samples));
  });

  // The symbol dictionary in this stream is unchanged and contributes no ink of
  // its own, so an empty page here means the type-4 region was held back — not
  // that the dictionary failed to decode. The immediate case above is what
  // proves the dictionary still works.
  it('holds an intermediate text region (type 4) off the page', () => {
    const out = decodeJbig2(F.intermediate_text_stream, undefined, 12, 6);
    expect(Array.from(out)).toEqual(blank(12, 6));
    expect(Array.from(out)).not.toEqual(Array.from(F.symtext_samples));
  });

  // Type 52 carries a profile, not a bitmap. It belongs on the skip line beside
  // the page-information and end-of-* segments and reaches `default:` only
  // because nobody has met one.
  it('skips a profiles segment (type 52) rather than refusing the stream', () => {
    expect(Array.from(decodeJbig2(segmentStream(52), undefined, 8, 8))).toEqual(blank(8, 8));
  });

  // T.88 §7.4.7.2: with no intermediate region in the referred-to set, the
  // reference is the page's own pixels under the rect and the result REPLACES
  // them — the external combination operator does not apply. The fixture's
  // target clears two pixels the reference had set, so an OR cannot produce it:
  // combining instead of replacing is the failure that hides, since refinement
  // output OR-ed onto its own input is more ink in roughly the right places.
  it('refines the page in place when no intermediate region is referred to', () => {
    const out = decodeJbig2(F.refine_page_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(Array.from(F.refine_samples));
    expect(Array.from(out)).not.toEqual(Array.from(F.refine_ref_samples));
  });

  it('refines a referred-to intermediate region and composites the result', () => {
    const out = decodeJbig2(F.refine_buffer_stream, undefined, 16, 16);
    expect(Array.from(out)).toEqual(Array.from(F.refine_samples));
  });

  // SBREFINE decodes as of utax.5. This is the only test that fences the SBRAT
  // header ordering: SBRAT sits between the text-region flags and
  // SBNUMINSTANCES, so reading it late shifts the instance count by four bytes
  // and the region decodes to nothing.
  it('decodes a text region with SBREFINE set', () => {
    const out = decodeJbig2(F.sbrefine_stream, undefined, 16, 8);
    expect(Array.from(out)).toEqual(Array.from(F.sbrefine_samples));
  });

  // Every child of this epic NARROWS a throw rather than deleting it, and this
  // is the fence for what is left. After utax.6 every segment type T.88
  // ASSIGNS is handled, so the `default:` arm is fenced with an UNASSIGNED one
  // — T.88 assigns 0, 4, 6, 7, 16, 20, 22, 23, 36, 38-40, 42, 43, 48-53 and 62,
  // leaving 60 free. The thing that could go wrong quietly is a type riding
  // onto the skip line beside 52, which would have the decoder produce a blank
  // page for a file it cannot read. (Huffman-coded symbol dictionaries and text
  // regions still refuse too, but on a flag bit rather than a segment type;
  // that fence is test/jbig2-unsupported.test.ts.)
  it('still refuses an unassigned segment type by name', () => {
    expect(() => decodeJbig2(segmentStream(60), undefined, 8, 8)).toThrow(UnsupportedFeatureError);
    expect(() => decodeJbig2(segmentStream(60), undefined, 8, 8)).toThrow(/segment type 60/i);
  });

  // Pattern dictionaries and halftone regions decode as of utax.1 and custom
  // Huffman tables as of utax.6, so a bare header with a zero-length body is a
  // damaged file rather than an unsupported feature: it is shorter than the
  // segment's own fixed header. Same inversion utax.3 made for the refinement
  // types.
  it.each([[16], [20], [22], [23], [53]])('rejects a truncated segment type %i rather than decoding garbage', (type) => {
    expect(() => decodeJbig2(segmentStream(type), undefined, 8, 8)).toThrow(PdfParseError);
    expect(() => decodeJbig2(segmentStream(type), undefined, 8, 8)).toThrow(/truncated/i);
  });

  // A custom table carries no ink and contributes nothing to the page — the
  // same "stored, not drawn" shape as an unconsumed intermediate region. It
  // must not refuse, and it must not draw.
  it('stores a custom Huffman table (type 53) and leaves the page blank', () => {
    const table = customTableSegment();
    expect(Array.from(decodeJbig2(table, undefined, 8, 8))).toEqual(blank(8, 8));
  });
});
