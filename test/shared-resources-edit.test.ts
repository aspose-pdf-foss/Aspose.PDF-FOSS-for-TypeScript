import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildSharedResourcesPdf } from './helpers/build-image-edit-pdf.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

// v9fp: an edit on page 1 must not reach page 2 through a /Resources dict the
// two pages share by reference.

const cases = [
  { label: 'shared indirect resources', open: () => Document.Open(buildSharedResourcesPdf()) },
  ...(['direct', 'inherited', 'indirect'] as const).map(placement => ({
    label: `Reorder duplicates with ${placement} resources`,
    open: () => {
      const doc = Document.Open(buildSharedResourcesPdf(placement));
      doc.Reorder([1, 1]);
      return doc;
    },
  })),
];
const page2Unchanged = (doc: Document) => {
  const reopened = Document.Open(doc.Save());
  const p2 = reopened.Pages[1];
  expect(p2.GetText()).toContain('Hello');
  expect(p2.GetText()).toContain('SECRET');
  expect(p2.Images.length).toBe(1);
  expect(p2.Images[0].Height).toBe(2);
  expect(p2.Images[0].Decode()).toEqual(Uint8Array.from([
    255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0,
  ]));
  return reopened;
};

describe.each(cases)('edits on a page with $label', ({ open }) => {
  it('Redact of form text leaves the other page drawing the original form', () => {
    const doc = open();
    doc.Pages[0].Redact([[0, 140, 200, 170]]);
    const r = page2Unchanged(doc);
    expect(r.Pages[0].GetText()).not.toContain('SECRET');
  });

  it("Redact's prune leaves the other page's resource names in place", () => {
    const doc = open();
    doc.Pages[0].Redact([[0, 0, 200, 200]]);
    const r = page2Unchanged(doc);
    expect(r.Pages[0].GetText()).not.toContain('Hello');
  });

  it("Redact's prune of a top-level image leaves the other page's /Im0", () => {
    // Removes page-level content only, so no form is copied-on-write first:
    // the prune is the one write into /Resources.
    const doc = open();
    doc.Pages[0].Redact([[5, 5, 35, 35]]);
    const r = page2Unchanged(doc);
    expect(r.Pages[0].Images.length).toBe(0);
  });

  it('ImageInfo.Remove leaves the other page drawing the image', () => {
    const doc = open();
    doc.Pages[0].Images[0].Remove({ sanitize: true });
    const r = page2Unchanged(doc);
    expect(r.Pages[0].Images.length).toBe(0);
  });

  it('ImageInfo.Remove without sanitize leaves the other page drawing the image', () => {
    const doc = open();
    doc.Pages[0].Images[0].Remove();
    page2Unchanged(doc);
  });

  it('ImageInfo.Replace changes only its own page', () => {
    const doc = open();
    doc.Pages[0].Images[0].Replace(buildPngRgb()); // 2x1 red, green, replacing 2x2.
    const r = page2Unchanged(doc);
    expect(r.Pages[0].Images[0].Height).toBe(1);
    expect(r.Pages[0].Images[0].Decode()).toEqual(Uint8Array.from([255, 0, 0, 0, 255, 0]));
  });
});
