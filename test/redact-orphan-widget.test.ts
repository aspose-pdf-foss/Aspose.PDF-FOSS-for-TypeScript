// vvft — a covered widget whose field is NOT reachable from /AcroForm /Fields.
//
// removeField returns false for exactly that case, and the widget branch used to
// `continue` on it, so the annotation survived redaction entirely: it stayed in
// /Annots and kept drawing its /AP over the marker box, because annotations
// composite after page content. That is the hazard redactannots.ts exists to
// prevent, and its doc comment promises removal unconditionally.
//
// Five shapes, all measured. Shapes 4 and 5 are here because they defeat the
// obvious fix: detaching only the covered widget leaves the value alive through
// /AcroForm /CO, and leaves the whole group alive whenever a sibling widget
// elsewhere keeps the shared field reachable.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { removeCoveredAnnotations } from '../src/redactannots.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import type { Rect } from '../src/text.js';
import type { PdfDict } from '../src/types.js';

const REGION: Rect = [40, 80, 260, 140];
const savedText = (doc: Document) => new TextDecoder('latin1').decode(doc.Save());
const acroOf = (doc: Document) => doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;

/** A page with one text field over REGION, its value the marker string. */
function withField(): Document {
  const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
  doc.Form.AddTextField({ page: 1, rect: [50, 90, 250, 130], name: 'ssn', value: 'OrphanSecret' });
  doc.Form.GenerateAppearances();
  return doc;
}

describe('a covered widget whose field is unwired still goes', () => {
  it('BASELINE: a well-formed field is still removed whole', () => {
    // The mssf behaviour this fix must not disturb.
    const doc = withField();
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);
    expect(doc.Form.Get('ssn')).toBeUndefined();
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(savedText(doc)).not.toContain('OrphanSecret');
  });

  it('removes the widget when the document has no /AcroForm at all', () => {
    const doc = withField();
    doc.catalog().delete('AcroForm');
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(savedText(doc)).not.toContain('OrphanSecret');
  });

  it('removes the widget when /AcroForm /Fields does not contain its field', () => {
    const doc = withField();
    acroOf(doc).set('Fields', []);
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(savedText(doc)).not.toContain('OrphanSecret');
  });

  it('removes a widget that names no field at all (no /FT, no /Parent)', () => {
    // fieldOf returns undefined here, the branch's other failure mode. The
    // widget is treated as its own field: widgetsOf returns the dict itself.
    const doc = withField();
    const w = doc.Pages[0].Annotations[0].Dict;
    w.delete('FT');
    w.delete('Parent');
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(savedText(doc)).not.toContain('OrphanSecret');
  });

  it('scrubs /AcroForm /CO, which would otherwise keep the value alive', () => {
    // /CO hangs off /AcroForm and so is reachable from /Root. Measured: a
    // fallback that only detaches the widget leaves 'OrphanSecret' in the bytes,
    // because scrubCO lives inside removeField and is skipped on the false path.
    const doc = withField();
    const acro = acroOf(doc);
    const fieldRef = (acro.get('Fields') as unknown as PdfDict[])[0];
    acro.set('CO', [fieldRef]);
    acro.set('Fields', []);
    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);
    expect(savedText(doc)).not.toContain('OrphanSecret');
  });

  it('takes the whole unwired group, including a sibling on another page', () => {
    // The shape that defeats a detach-only fix. Measured before the fix:
    // detaching just the covered widget left BOTH exports in the bytes, because
    // the sibling's /Parent keeps the field reachable and the field's /Kids then
    // keeps the covered widget reachable in turn.
    const doc = Document.Open(buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (x) Tj ET']));
    doc.AddPage();
    doc.Form.AddRadioGroup({
      name: 'choice',
      options: [
        { page: 1, export: 'CoveredSecret', rect: [50, 90, 70, 110] },
        { page: 2, export: 'SiblingSecret', rect: [50, 500, 70, 520] },
      ],
    });
    acroOf(doc).set('Fields', []);

    expect(removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).toBe(1);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
    expect(doc.Pages[1].Annotations).toHaveLength(0);
    const bytes = savedText(doc);
    expect(bytes).not.toContain('CoveredSecret');
    expect(bytes).not.toContain('SiblingSecret');
  });

  it('stops the orphan drawing its appearance over the marker box', () => {
    // The visible half, and the reason this is a leak rather than a stranded
    // object: annotations composite after page content, so before the fix the
    // redacted region still showed the field's value in a render.
    const doc = withField();
    doc.catalog().delete('AcroForm');
    doc.Pages[0].Redact([REGION]);
    expect(Document.Open(doc.Save()).Pages[0].ToSvg()).not.toContain('OrphanSecret');
  });

  it('still does not throw on any of these shapes', () => {
    const doc = withField();
    acroOf(doc).set('Fields', []);
    expect(() => removeCoveredAnnotations(doc, doc.Pages[0], [REGION])).not.toThrow();
  });
});
