import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { collectImageUsage } from '../src/imageusage.js';
import { isStream, name, PdfObject, PdfStream } from '../src/types.js';
import {
  buildSimpleImagePdf, buildTwoPlacementPdf, buildFormImagePdf,
  buildAnnotImagePdf, buildSmaskPdf,
} from './helpers/build-imageopt-pdf.js';

/** The live image stream stored at `num`. */
function streamAt(doc: Document, num: number): PdfStream {
  const o = doc.getObject(num);
  if (!isStream(o)) throw new Error(`object ${num} is not a stream`);
  return o;
}

/** Replace page 0's /Contents. There is no Page.SetContent; this is the house
 *  pattern (see test/glyphusage.test.ts). */
function setContent(doc: Document, src: string): void {
  doc.Pages[0].Dict.set('Contents', doc.allocObject({
    kind: 'stream',
    dict: new Map<string, PdfObject>(),
    raw: new TextEncoder().encode(src),
  }));
}

describe('collectImageUsage', () => {
  it('measures a 64px image in a 16pt box as 288 DPI', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5);
    expect(u.name).toBe('Im0');
  });

  it('takes the MAX dpi across placements, not the last or the smallest', () => {
    const { bytes, imgObjNum } = buildTwoPlacementPdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5); // not the 72 DPI of the big box
  });

  it('composes a Form XObject /Matrix with the CTM', () => {
    const { bytes, imgObjNum } = buildFormImagePdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5); // cm 8 x Matrix 2 = 16pt box
  });

  it('measures a rotated placement by its true device extent', () => {
    // A 90-degree rotation into a 16pt box: a and d are both 0, so a naive a/d
    // read would divide by zero. hypot(a,b) recovers the real 16pt extent.
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    setContent(doc, 'q 0 16 -16 0 30 10 cm /Im0 Do Q');
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5);
  });

  it('finds an image drawn only from an annotation /AP stream', () => {
    const { bytes, imgObjNum } = buildAnnotImagePdf();
    const doc = Document.Open(bytes);
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(true);
    expect(u.maxDpi).toBeCloseTo(288, 5);
  });

  it('marks an /SMask incomplete: referenced, never drawn', () => {
    const { bytes, imgObjNum, smaskObjNum } = buildSmaskPdf();
    const doc = Document.Open(bytes);
    const usage = collectImageUsage(doc);
    expect(usage.get(streamAt(doc, imgObjNum))!.complete).toBe(true);
    const sm = usage.get(streamAt(doc, smaskObjNum))!;
    expect(sm.complete).toBe(false);
    expect(sm.reason).toMatch(/not reached/);
  });

  it('marks every image in scope incomplete when a content stream will not decode', () => {
    const { bytes, imgObjNum } = buildSimpleImagePdf();
    const doc = Document.Open(bytes);
    // Replace /Contents with an undecodable stream (bad Flate payload). Mirrors
    // test/glyphusage.test.ts — a proven trigger, unlike malformed syntax, which
    // the tokenizer may tolerate rather than throw on.
    doc.Pages[0].Dict.set('Contents', doc.allocObject({
      kind: 'stream',
      dict: new Map<string, PdfObject>([['Filter', name('FlateDecode')]]),
      raw: Uint8Array.from([0, 1, 2, 3]),
    }));
    const u = collectImageUsage(doc).get(streamAt(doc, imgObjNum))!;
    expect(u.complete).toBe(false);
    expect(u.reason).toMatch(/failed to (parse|decode)/);
  });
});
