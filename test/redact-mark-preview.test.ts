// Guard for the recorded decision aspose-pdf-foss-for-ts-ar2o: an UNAPPLIED
// /Redact mark must never render like an applied redaction.
//
// The Aspose.PDF-for-Go showcase paints redact appearances as an opaque fill,
// and a "parity" change here would be the single most dangerous thing that
// could happen to this feature: the person checking the document sees black
// boxes over text that is still fully extractable, and ships it.
//
// annotdraw.test.ts already pins the appearance BODY (stroke, never fill). This
// file pins the property that actually matters, one level up, in the consumers
// the decision names — the rasterizer, ToSvg, and flatten — because a mark could
// equally be made opaque by changing how the appearance is composited rather
// than how it is built.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { decodePng } from './helpers/decode-png.js';

/** A 300x300 page with one line of text at (50, 100), 12pt Helvetica. */
function textPage(): Document {
  return Document.Open(buildMultiStreamPage([
    'BT /F1 12 Tf 50 100 Td (CONFIDENTIAL PAYLOAD) Tj ET',
  ]));
}

/** The region the mark covers, in PDF user space. */
const MARK = { rect: [45, 95, 220, 115] as [number, number, number, number] };

/** Render page 1 at 1:1 and decode to pixels. */
function pixels(doc: Document) {
  return decodePng(doc.Pages[0].ToImage({ scale: 1 }));
}

/** Count pixels differing between two renders, strictly inside the mark region
 *  so the 1pt outline itself is not counted. PDF y is up, PNG y is down. */
function interiorDiff(a: ReturnType<typeof pixels>, b: ReturnType<typeof pixels>): number {
  const inset = 3;
  const x0 = Math.ceil(MARK.rect[0] + inset), x1 = Math.floor(MARK.rect[2] - inset);
  const yTop = Math.ceil(a.height - MARK.rect[3] + inset);
  const yBot = Math.floor(a.height - MARK.rect[1] - inset);
  let n = 0;
  for (let y = yTop; y < yBot; y++)
    for (let x = x0; x < x1; x++) {
      const [r1, g1, b1] = a.at(x, y);
      const [r2, g2, b2] = b.at(x, y);
      if (r1 !== r2 || g1 !== g2 || b1 !== b2) n++;
    }
  return n;
}

/** Inked vs background pixel counts inside the mark region.
 *
 *  Both halves matter. "Ink is present" alone cannot tell text from an opaque
 *  black box — a solid fill is ink too — so the test for a hollow preview is
 *  that plenty of BACKGROUND still shows through between the glyphs. */
function interiorInk(p: ReturnType<typeof pixels>): { ink: number; background: number } {
  const x0 = Math.ceil(MARK.rect[0]), x1 = Math.floor(MARK.rect[2]);
  const yTop = Math.ceil(p.height - MARK.rect[3]), yBot = Math.floor(p.height - MARK.rect[1]);
  let ink = 0, background = 0;
  for (let y = yTop; y < yBot; y++)
    for (let x = x0; x < x1; x++) {
      const [r, g, b] = p.at(x, y);
      if (r < 200 || g < 200 || b < 200) ink++; else background++;
    }
  return { ink, background };
}

describe('an unapplied /Redact mark never renders as a redaction', () => {
  it('leaves the text under it untouched in ToImage', () => {
    const before = pixels(textPage());
    const marked = textPage();
    marked.Pages[0].AddRedact(MARK);
    const after = pixels(marked);

    // The mark contributes an outline and nothing else: every pixel inside it
    // is exactly what it was. An opaque preview would repaint all of them.
    expect(interiorDiff(before, after)).toBe(0);
    const { ink, background } = interiorInk(after);
    expect(ink).toBeGreaterThan(50);          // the text really is there
    expect(background).toBeGreaterThan(ink);  // and it is text, not a filled box
  });

  it('still shows the text once the mark is flattened', () => {
    // Flatten composites /AP /N into page content, so an opaque appearance would
    // become permanent ink over text that is still extractable.
    const doc = textPage();
    doc.Pages[0].AddRedact(MARK);
    doc.Pages[0].FlattenAnnotations();
    const { ink, background } = interiorInk(pixels(doc));
    expect(ink).toBeGreaterThan(50);
    expect(background).toBeGreaterThan(ink);   // baked ink, not a baked box
    expect(doc.Pages[0].GetText()).toContain('CONFIDENTIAL PAYLOAD');
  });

  it('emits the mark as a stroked, unfilled path in ToSvg', () => {
    const doc = textPage();
    doc.Pages[0].AddRedact({ ...MARK, fill: [0, 0, 0] });
    const svg = doc.Pages[0].ToSvg();

    // Matched on the path covering the mark's own geometry, and on `fill` and
    // `stroke` together. Asserting only "no black fill anywhere" would be
    // satisfied by a page that drew nothing at all, and asserting the presence
    // of a stroke would not notice a fill added beside it.
    const mark = svg.split('><').find((el) => el.includes('M45 185L220 185'));
    expect(mark).toBeDefined();
    expect(mark).toContain('fill="none"');
    expect(mark).toMatch(/stroke="#[0-9a-f]{6}"/);
    // /IC is the colour the APPLIED redaction will use; the preview must not
    // paint it, whatever attribute order the serializer happens to use.
    expect(mark).not.toContain('fill="#000000"');
  });

  it('covers the text only once the redaction is actually applied', () => {
    // The control: without this the tests above could pass because nothing is
    // ever painted, rather than because the preview is deliberately hollow.
    const doc = textPage();
    doc.Pages[0].AddRedact({ ...MARK, fill: [0, 0, 0] });
    doc.Pages[0].ApplyRedactions();
    expect(doc.Pages[0].GetText()).not.toContain('CONFIDENTIAL PAYLOAD');
    const p = pixels(doc);
    // Now the region IS opaque: essentially every pixel in it is inked.
    const area = (MARK.rect[2] - MARK.rect[0]) * (MARK.rect[3] - MARK.rect[1]);
    expect(interiorInk(p).ink).toBeGreaterThan(area * 0.8);
  });
});
