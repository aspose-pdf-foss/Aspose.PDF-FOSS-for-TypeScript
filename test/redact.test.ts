import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { inflateStream } from '../src/flate.js';
import { visitContent } from '../src/text.js';
import { redactRegions } from '../src/redact.js';
import { isDict, isStream, PdfDict } from '../src/types.js';
import {
  buildMultiStreamPage, buildSharedXObjectPages, buildTextAndImagePage,
} from './helpers/build-edit-pdf.js';
import { buildImageOnlyPdf } from './helpers/build-text-pdf.js';
import { buildSingleImagePdfWithCm } from './helpers/build-image-pdf.js';

function images(doc: Document, pageIndex = 0): number {
  let n = 0;
  visitContent(doc, doc.Pages[pageIndex], { image: () => { n++; } });
  return n;
}

/** All inflated content bytes a page can render — its /Contents plus every form
 *  XObject in its resources (one level; fixtures don't nest deeper) — as text.
 *  This is the surface a redaction guarantee must scrub. */
function renderedBytes(doc: Document, pageIndex = 0): string {
  const dec = new TextDecoder('latin1');
  const page = doc.Pages[pageIndex];
  let s = dec.decode(page.Contents);
  const res = doc.resolve(page.Dict.get('Resources'));
  const xo = isDict(res) ? doc.resolve((res as PdfDict).get('XObject')) : undefined;
  if (isDict(xo)) for (const [, v] of xo as PdfDict) {
    const st = doc.resolve(v);
    if (isStream(st)) s += '\n' + dec.decode(inflateStream(st));
  }
  return s;
}

describe('page.Redact — text redaction guarantee', () => {
  it('removes text so it is gone from GetText and the raw saved bytes', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    doc.Pages[0].Redact([[40, 95, 200, 115]]); // covers the whole word

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).not.toContain('TopSecret'); // (a) not rendered
    expect(renderedBytes(reopened)).not.toContain('TopSecret');     // (b) not in the bytes
    expect(renderedBytes(reopened)).toContain('0 0 0 rg');          // black marker painted
  });

  it('removes both text and an image from the same content stream', () => {
    // The bug this guards: text removal rebuilds the op list, so image-op
    // indices from a separate pass would drift. One pass keeps them aligned.
    const doc = Document.Open(buildTextAndImagePage(
      'BT /F1 10 Tf 50 250 Td (Secret) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q'));
    doc.Pages[0].Redact([[40, 245, 120, 265], [40, 40, 160, 160]]); // text rect + image rect

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).not.toContain('Secret');
    expect(renderedBytes(reopened)).not.toContain('Secret'); // text bytes gone
    expect(images(reopened)).toBe(0);                        // image draw gone
    expect(savedText(doc)).not.toContain('/Image');          // image object swept
  });
});

const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());

describe('page.Redact — images & options', () => {
  it('redacts an image and sweeps its XObject from the saved file', () => {
    const doc = Document.Open(buildImageOnlyPdf());
    doc.Pages[0].Redact([[40, 40, 160, 160]]);
    expect(images(Document.Open(doc.Save()))).toBe(0);
    expect(savedText(doc)).not.toContain('/Image');
  });

  it('throws UnsupportedFeatureError for a partially-covered undecodable image and mutates nothing', () => {
    // A JPEG (DCTDecode) image cannot be decoded to pixels, so partial coverage
    // still throws — and it must throw before any edit is applied.
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: 4, height: 4, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode',
      raw: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), cm: '100 0 0 100 0 0',
    }));
    const before = doc.Pages[0].Dict.get('Contents');
    expect(() => doc.Pages[0].Redact([[0, 0, 50, 100]])).toThrow(UnsupportedFeatureError);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(before); // no partial mutation
  });

  it('throws TypeError for a malformed rectangle before mutating', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    const before = doc.Pages[0].Dict.get('Contents');
    expect(() => doc.Pages[0].Redact([[0, 0, 10]] as unknown as [number, number, number, number][]))
      .toThrow(TypeError);
    expect(doc.Pages[0].Dict.get('Contents')).toBe(before);
  });

  it('honours a custom marker colour and scrubMetadata', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.SetMetadata({ author: 'Spy' });
    doc.Pages[0].Redact([[40, 95, 120, 115]], { color: [1, 0, 0], scrubMetadata: true });

    const reopened = Document.Open(doc.Save());
    expect(renderedBytes(reopened)).toContain('1 0 0 rg');
    expect(reopened.GetMetadata().author).toBeUndefined();
  });
});

describe('doc.Redact — convenience over a shared XObject', () => {
  it('redacts one page (1-based) without altering the page that shares the XObject', () => {
    const doc = Document.Open(buildSharedXObjectPages()); // both pages draw Fm0 -> "shared"
    doc.Redact(1, [[45, 45, 95, 75]]);                    // redact page 1 only

    const reopened = Document.Open(doc.Save());
    expect(reopened.Pages[0].GetText()).not.toContain('shared'); // redacted page
    expect(renderedBytes(reopened, 0)).not.toContain('shared');  // and its bytes
    expect(reopened.Pages[1].GetText()).toBe('shared');          // other page intact
  });

  it('rejects an out-of-range page number', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    expect(() => doc.Redact(2, [[0, 0, 10, 10]])).toThrow(RangeError);
  });
});

describe('redactRegions', () => {
  it('removes content and then hands the validated rects to the painter', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    const seen: number[][] = [];
    redactRegions(doc, doc.Pages[0], [[200, 115, 40, 95]], (rs) => { seen.push(...rs); });

    expect(seen).toEqual([[200, 115, 40, 95]]); // passed through as given
    expect(doc.Pages[0].GetText()).not.toContain('TopSecret');
  });

  it('validates every rect before touching the page', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));
    let painted = false;
    expect(() => redactRegions(
      doc, doc.Pages[0], [[40, 95, 200, 115], [1, 2, 3] as never], () => { painted = true; },
    )).toThrow(TypeError);
    expect(painted).toBe(false);
    expect(doc.Pages[0].GetText()).toContain('TopSecret');
  });
});
