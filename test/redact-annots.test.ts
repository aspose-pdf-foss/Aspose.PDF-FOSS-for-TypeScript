import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { removeCoveredAnnotations } from '../src/redactannots.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import type { Rect } from '../src/text.js';
import type { PdfDict } from '../src/types.js';

const REGION: Rect = [40, 80, 260, 140];

/** A page with text inside REGION, annotations over it, and one far away. */
function build(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 100 Td (PageSecret) Tj ET',
  ]));
  const p = doc.Pages[0];
  p.AddTextNote({ rect: [60, 90, 80, 110], contents: 'NoteSecret', author: 'AuthorSecret' });
  p.AddFreeText({ rect: [90, 85, 250, 135], contents: 'FreeTextSecret' });
  p.AddHighlight({ quads: [45, 115, 255, 115, 45, 85, 255, 85], contents: 'HighlightSecret' });
  p.AddLink({
    rect: [45, 85, 255, 135],
    action: { type: 'uri', uri: 'https://secret.example/LinkSecret' },
  });
  p.AddTextNote({ rect: [500, 500, 520, 520], contents: 'FarAwaySecret' });
  return doc;
}

describe('removeCoveredAnnotations', () => {
  it('removes every annotation intersecting the region and counts them', () => {
    const doc = build();
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(4);
    expect(doc.Pages[0].Annotations.map((a) => a.Contents)).toEqual(['FarAwaySecret']);
  });

  it('leaves an annotation outside the region untouched', () => {
    const doc = build();
    removeCoveredAnnotations(doc, doc.Pages[0], [REGION]);
    const kept = doc.Pages[0].Annotations;
    expect(kept).toHaveLength(1);
    expect(kept[0].Rect).toEqual([500, 500, 520, 520]);
  });

  it('removes on any intersection, not only full containment', () => {
    // Clips the region's top-right corner and hangs well outside it.
    const doc = build();
    doc.Pages[0].AddStamp({ rect: [250, 135, 400, 200], text: 'ClipSecret' });
    removeCoveredAnnotations(doc, doc.Pages[0], [REGION]);
    expect(doc.Pages[0].Annotations.map((a) => a.Rect))
      .toEqual([[500, 500, 520, 520]]);
  });

  it('never sweeps a /Redact mark', () => {
    const doc = build();
    doc.Pages[0].AddRedact({ rect: REGION, overlayText: 'X' });
    removeCoveredAnnotations(doc, doc.Pages[0], [REGION]);
    expect(doc.Pages[0].Annotations.map((a) => a.Subtype).sort())
      .toEqual(['Redact', 'Text']);
  });

  it('removes a popup orphaned by its parent', () => {
    const doc = build();
    const p = doc.Pages[0];
    // A markup inside the region, with a popup parked far outside it.
    p.AddSquare({ rect: [50, 90, 100, 130], popup: { rect: [600, 600, 700, 700] } });
    expect(p.Annotations.some((a) => a.Subtype === 'Popup')).toBe(true);

    removeCoveredAnnotations(doc, p, [REGION]);
    expect(p.Annotations.some((a) => a.Subtype === 'Popup')).toBe(false);
  });

  it('skips an annotation with no readable /Rect rather than throwing', () => {
    const doc = build();
    const p = doc.Pages[0];
    const note = p.Annotations[0];
    note.Dict.delete('Rect');
    expect(() => removeCoveredAnnotations(doc, p, [REGION])).not.toThrow();
    expect(p.Annotations.some((a) => a.Dict === note.Dict)).toBe(true);
  });

  it('returns 0 and changes nothing when given no regions', () => {
    const doc = build();
    const before = doc.Pages[0].Annotations.length;
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [])).toBe(0);
    expect(doc.Pages[0].Annotations).toHaveLength(before);
  });
});

/** The saved file as latin1 text, for byte-level leak assertions. */
const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());

describe('removeCoveredAnnotations — form fields', () => {
  it('removes the whole field, not just the widget', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.Form.AddTextField({ page: 1, rect: [50, 90, 250, 130], name: 'ssn', value: '123-45-6789' });

    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);

    expect(doc.Form.Get('ssn')).toBeUndefined();          // unwired from /AcroForm
    expect(doc.Pages[0].Annotations).toHaveLength(0);      // widget detached
    expect(savedText(doc)).not.toContain('123-45-6789');   // the value is gone
  });

  it('takes a radio group entirely, including a widget on an untouched page', () => {
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.AddPage();
    doc.Form.AddRadioGroup({
      name: 'choice',
      options: [
        { page: 1, export: 'CoveredSecret', rect: [50, 90, 70, 110] },
        { page: 2, export: 'OtherPageSecret', rect: [50, 500, 70, 520] },
      ],
    });

    // Only page 1's widget is in the region; the group's value is shared, so the
    // whole group goes.
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);

    expect(doc.Form.Get('choice')).toBeUndefined();
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(doc.Pages[1].Annotations).toHaveLength(0); // other page cleaned too
    expect(savedText(doc)).not.toContain('OtherPageSecret');
  });

  it('removes a widget whose field is not in the tree, rather than skipping it', () => {
    // This case used to be named "skips ... rather than throwing" and asserted
    // only that it did not throw — which is true of the leak as well as of the
    // fix. removeField returns false when the field is not locatable, and the
    // widget branch used to `continue` on that, leaving the annotation in place
    // to draw its /AP over the marker box (vvft). The full shape matrix is in
    // test/redact-orphan-widget.test.ts.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.Form.AddTextField({ page: 1, rect: [50, 90, 250, 130], name: 'orphan', value: 'v' });
    // Unwire /AcroForm /Fields so the widget's field can no longer be located.
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    acro.set('Fields', []);

    expect(() => removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).not.toThrow();
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });
});

const SECRETS = [
  'NoteSecret', 'AuthorSecret', 'FreeTextSecret', 'HighlightSecret', 'LinkSecret',
];

describe('redaction removes covered annotations end to end', () => {
  it('leaves no annotation secret in the bytes after page.Redact', () => {
    const doc = build();
    doc.Pages[0].Redact([REGION]);
    const bytes = savedText(doc);
    // Assert on raw bytes: GetText() walks page content only and reports every
    // one of these as gone even when the file still carries them.
    for (const s of ['PageSecret', ...SECRETS]) expect(bytes).not.toContain(s);
    expect(bytes).toContain('FarAwaySecret'); // untouched annotation survives
  });

  it('leaves no annotation secret in the bytes after ApplyRedactions', () => {
    const doc = build();
    doc.Pages[0].AddRedact({ rect: REGION });
    expect(doc.Pages[0].ApplyRedactions()).toBe(1);
    const bytes = savedText(doc);
    for (const s of ['PageSecret', ...SECRETS]) expect(bytes).not.toContain(s);
  });

  it('stops the covered FreeText ink from rendering over the marker box', () => {
    // The visible half of the leak: the marker box is page content and
    // annotations composite on top of it, so before this fix ToSvg still drew
    // the FreeText's text across the redacted region.
    const doc = build();
    doc.Pages[0].Redact([REGION]);
    expect(Document.Open(doc.Save()).Pages[0].ToSvg()).not.toContain('FreeTextSecret');
  });

  it('keeps them — and the secrets — under keepAnnotations', () => {
    const doc = build();
    doc.Pages[0].Redact([REGION], { keepAnnotations: true });
    const bytes = savedText(doc);
    expect(bytes).not.toContain('PageSecret');  // content still redacted
    expect(bytes).toContain('NoteSecret');      // annotation deliberately kept
    expect(doc.Pages[0].Annotations.length).toBeGreaterThan(1);
  });

  it('honours keepAnnotations on ApplyRedactions too', () => {
    const doc = build();
    doc.Pages[0].AddRedact({ rect: REGION });
    doc.Pages[0].ApplyRedactions({ keepAnnotations: true });
    expect(savedText(doc)).toContain('NoteSecret');
  });

  it('redacts by text without stranding the covered annotations', () => {
    const doc = build();
    expect(doc.Pages[0].RedactText('PageSecret')).toBe(1);
    expect(savedText(doc)).not.toContain('NoteSecret');
  });

  it('untags a tagged annotation instead of stranding its /OBJR', () => {
    // /StructTreeRoot is reachable from /Root, so an /OBJR naming the annotation
    // keeps it in the saved bytes with no /Annots entry anywhere.
    const doc = build();
    const note = doc.Pages[0].Annotations[0];
    doc.CreateStructTree().Append('Note').AddAnnotation(note);

    doc.Pages[0].Redact([REGION]);
    expect(savedText(doc)).not.toContain('NoteSecret');
  });
});
