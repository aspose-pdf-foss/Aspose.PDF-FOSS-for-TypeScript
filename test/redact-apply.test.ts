import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { RedactAnnotation } from '../src/annotation.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { buildRedactWithROTarget } from './helpers/build-redact-annot.js';
import { buildSingleImagePdfWithCm } from './helpers/build-image-pdf.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { isDict, isName } from '../src/types.js';

/** The page's own /Contents, inflated, as latin1 text. */
function contentText(doc: Document, pageIndex = 0): string {
  return new TextDecoder('latin1').decode(doc.Pages[pageIndex].Contents);
}

const secretPage = () => Document.Open(
  buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));

describe('page.ApplyRedactions', () => {
  it('destroys the marked text and reports the count', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });

    expect(doc.Pages[0].ApplyRedactions()).toBe(1);

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].GetText()).not.toContain('TopSecret');
    expect(contentText(back)).not.toContain('TopSecret');
  });

  it('removes the mark once applied', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    doc.Pages[0].ApplyRedactions();
    expect(doc.Pages[0].Annotations.filter((a) => a instanceof RedactAnnotation)).toHaveLength(0);
  });

  it('paints the /IC fill over the region', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], fill: [0, 0, 1] });
    doc.Pages[0].ApplyRedactions();
    expect(contentText(doc)).toContain('0 0 1 rg');
  });

  it('is a no-op returning 0 when the page carries no marks', () => {
    const doc = secretPage();
    const before = doc.Save();
    expect(doc.Pages[0].ApplyRedactions()).toBe(0);
    expect(doc.Save()).toEqual(before);
  });

  it('leaves a non-Redact annotation alone', () => {
    const doc = secretPage();
    doc.Pages[0].AddTextNote({ rect: [10, 10, 30, 30], contents: 'keep me' });
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    expect(doc.Pages[0].ApplyRedactions()).toBe(1);
    expect(doc.Pages[0].Annotations).toHaveLength(1);
    expect(doc.Pages[0].Annotations[0].Subtype).toBe('Text');
  });

  it('scrubs metadata only when asked', () => {
    const doc = secretPage();
    doc.SetMetadata({ author: 'Spy' });
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    doc.Pages[0].ApplyRedactions({ scrubMetadata: true });
    expect(doc.GetMetadata().author).toBeUndefined();
  });
});

describe('doc.ApplyRedactions', () => {
  it('sums across pages', () => {
    const doc = secretPage();
    doc.Pages[0].AddRedact({ rect: [40, 95, 120, 115] });
    doc.Pages[0].AddRedact({ rect: [120, 95, 200, 115] });
    expect(doc.ApplyRedactions()).toBe(2);
  });
});

describe('overlay text', () => {
  const wide = () => Document.Open(
    buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));

  it('draws /OverlayText in the /DA colour over the fill', () => {
    const doc = wide();
    doc.Pages[0].AddRedact({
      rect: [40, 95, 200, 115], overlayText: 'REDACTED', textColor: [1, 1, 1],
    });
    doc.Pages[0].ApplyRedactions();

    const body = contentText(doc);
    expect(body).toContain('(REDACTED) Tj');
    expect(body).toContain('1 1 1 rg');
    expect(Document.Open(doc.Save()).Pages[0].GetText()).toContain('REDACTED');
  });

  it('honours /Q by moving the text anchor', () => {
    const mk = (align: 'left' | 'center' | 'right') => {
      const doc = wide();
      doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], overlayText: 'X', align });
      doc.Pages[0].ApplyRedactions();
      return contentText(doc);
    };
    // Same text, same box: only the x origin of the text matrix may differ.
    expect(mk('left')).not.toEqual(mk('center'));
    expect(mk('center')).not.toEqual(mk('right'));
  });

  it('tiles the text when /Repeat is set', () => {
    const once = () => {
      const doc = wide();
      doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], overlayText: 'X', fontSize: 8 });
      doc.Pages[0].ApplyRedactions();
      return (contentText(doc).match(/\(X\) Tj/g) ?? []).length;
    };
    const many = () => {
      const doc = wide();
      doc.Pages[0].AddRedact({
        rect: [40, 95, 200, 115], overlayText: 'X', fontSize: 8, repeat: true,
      });
      doc.Pages[0].ApplyRedactions();
      return (contentText(doc).match(/\(X\) Tj/g) ?? []).length;
    };
    expect(once()).toBe(1);
    expect(many()).toBeGreaterThan(1);
  });

  it('paints only the fill when there is no overlay text', () => {
    const doc = wide();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], fill: [0, 0, 0] });
    doc.Pages[0].ApplyRedactions();
    expect(contentText(doc)).not.toContain('Tj');
  });
});

describe('/RO precedence', () => {
  it('draws the /RO form and neither the /IC fill nor the overlay text', () => {
    const doc = Document.Open(buildRedactWithROTarget());
    expect(doc.Pages[0].ApplyRedactions()).toBe(1);

    const body = contentText(doc);
    expect(body).toContain('Do');                        // the form was placed
    expect(body).not.toContain('0 0 1 rg');              // /IC not painted
    expect(body).not.toContain('SHOULD NOT APPEAR');     // /OverlayText not drawn
    expect(doc.Pages[0].GetText()).not.toContain('TopSecret'); // still destructive
  });
});

describe('page.MarkRedactText', () => {
  const twoHits = () => Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 200 Td (card 4111 here) Tj ET',
    'BT /F1 10 Tf 50 100 Td (card 4222 here) Tj ET',
  ]));

  it('adds one mark per match and destroys nothing', () => {
    const doc = twoHits();
    expect(doc.Pages[0].MarkRedactText(/\d{4}/, { overlayText: 'X' })).toBe(2);

    const marks = doc.Pages[0].Annotations.filter((a) => a instanceof RedactAnnotation);
    expect(marks).toHaveLength(2);
    expect((marks[0] as RedactAnnotation).OverlayText).toBe('X');
    expect(doc.Pages[0].GetText()).toContain('4111'); // still there — only marked
  });

  it('returns 0 and adds nothing when there is no match', () => {
    const doc = twoHits();
    expect(doc.Pages[0].MarkRedactText('nothing-here')).toBe(0);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('marks then applies, end to end', () => {
    const doc = twoHits();
    doc.Pages[0].MarkRedactText(/\d{4}/, { overlayText: 'X' });
    expect(doc.Pages[0].ApplyRedactions()).toBe(2);

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].GetText()).not.toContain('4111');
    expect(back.Pages[0].GetText()).not.toContain('4222');
    expect(back.Pages[0].Annotations.filter((a) => a instanceof RedactAnnotation)).toHaveLength(0);
  });
});

describe('doc.MarkRedactText', () => {
  it('sums across pages', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (card 4111) Tj ET']));
    expect(doc.MarkRedactText(/\d{4}/)).toBe(1);
  });
});

/** Dicts of the given /Subtype anywhere in the object map — including objects no
 *  page points at any more, which is the whole question here. */
function subtypeCount(doc: Document, subtype: string): number {
  let n = 0;
  for (const [, o] of doc.objectEntries()) {
    if (!isDict(o)) continue;
    const st = doc.resolve(o.get('Subtype'));
    if (isName(st) && st.name === subtype) n++;
  }
  return n;
}

describe('applied marks are untagged, not just detached', () => {
  it('leaves no /OBJR keeping the annotation alive through Save', () => {
    // /StructTreeRoot is reachable from /Root, so an /OBJR naming the annotation
    // survives the mark-sweep: the file would carry a /Redact in no /Annots.
    const doc = secretPage();
    const mark = doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    doc.CreateStructTree().Append('Note').AddAnnotation(mark);

    expect(doc.Pages[0].ApplyRedactions()).toBe(1);

    const back = Document.Open(doc.Save());
    expect(subtypeCount(back, 'Redact')).toBe(0);
  });
});

describe('a failed apply changes nothing', () => {
  it('throws on an undecodable partially-covered image, leaving marks and text', () => {
    // The throw happens inside removeRegionContent, before ec.commit(), so the
    // whole apply is a no-op and the caller can fix the mark and retry.
    const doc = Document.Open(buildSingleImagePdfWithCm({
      width: 4, height: 4, colorSpace: 'DeviceRGB', bits: 8, filter: 'DCTDecode',
      raw: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), cm: '100 0 0 100 0 0',
    }));
    const page = doc.Pages[0];
    page.AddRedact({ rect: [0, 0, 50, 100] }); // clips part of the image

    expect(() => page.ApplyRedactions()).toThrow(UnsupportedFeatureError);
    expect(page.Annotations.filter((a) => a instanceof RedactAnnotation)).toHaveLength(1);
  });
});
