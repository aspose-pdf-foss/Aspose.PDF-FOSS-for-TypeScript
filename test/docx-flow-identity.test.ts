import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';

/** The bytes `doc.ToDocx()` produced before textbox mode existed.
 *
 *  This is a FENCE, not a golden to be refreshed when it goes red. Flow mode is
 *  the shipped behaviour of three prior issues (8yt9.1-.3); textbox mode adds a
 *  second body producer and an option bag, and neither may move a byte of it.
 *  If a change here is genuinely intended, say so in the commit — do not update
 *  the constant to make a build green. */
const FLOW_SHA256 = '582e1a0e1cc1d4a4c6174dfb45d8b5a7a477109f1f5098091cd9a55977447835';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('flow mode is byte-frozen', () => {
  it('produces the bytes it produced before textbox mode existed', () => {
    expect(sha(Document.Open(buildTaggedPdf()).ToDocx())).toBe(FLOW_SHA256);
  });

  it('produces identical bytes with no options and with mode: flow', () => {
    // What makes the option bag provably free: adding it cost the default path
    // nothing, and naming the default explicitly changes nothing either.
    const doc = Document.Open(buildTaggedPdf());
    expect(sha(doc.ToDocx({ mode: 'flow' }))).toBe(sha(doc.ToDocx()));
  });

  it('ignores the textbox-only options in flow mode', () => {
    const doc = Document.Open(buildTaggedPdf());
    expect(sha(doc.ToDocx({ mode: 'flow', box: 'media', backdrop: 'raster' })))
      .toBe(FLOW_SHA256);
  });

  it('is reproducible across two renders of one document', () => {
    // Timestamps are the fixed 1980-01-01 constant, never the clock — zip.ts's
    // rule. Two renders a millisecond apart would agree even with a clock, so
    // this pins reproducibility rather than that specific rule.
    const doc = Document.Open(buildTaggedPdf());
    expect(sha(doc.ToDocx())).toBe(sha(doc.ToDocx()));
  });

  it('is reproducible across two separately opened documents', () => {
    expect(sha(Document.Open(buildTaggedPdf()).ToDocx()))
      .toBe(sha(Document.Open(buildTaggedPdf()).ToDocx()));
  });
});
