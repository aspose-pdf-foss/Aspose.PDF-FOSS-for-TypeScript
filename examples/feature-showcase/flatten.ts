import type { Document, Page } from '../../src/index.js';
import {
  addText, pageWidth, pageHeight, sectionHeader, NAVY, TINT, GREEN, FAINT, MUTED,
} from './theme.js';

export function addFlattenDemo(doc: Document, page: Page): void {
  const form = doc.Form;
  const pageNum = page.Number;
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Form & Annotation Flattening',
    'field.Flatten()  •  annotation.Flatten()  •  bake interactive content into static content');

  addText(page,
    "The text field, checkbox and note below were created as interactive AcroForm fields and a live annotation, then flattened — baked into the page's content stream. In the saved PDF this page has no /Annots and contributes no /AcroForm fields: the look is permanent and non-editable, while the still-interactive form lives on the AcroForm Fields page.",
    [40, h - 165, w - 40, h - 115],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  const addLabel = (text: string, y: number): void => {
    addText(page, text, [60, y, 200, y + 18], { font: 'Helvetica-Bold', size: 11 });
  };

  addLabel('Full name:', 660);
  const tb = form.AddTextField({
    page: pageNum, rect: [210, 660, 460, 680], name: 'FlattenName', value: 'Alice Sample',
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY,
    borderWidth: 1, font: 'Helvetica', fontSize: 12,
  });

  addLabel('Subscribe:', 620);
  const cb = form.AddCheckbox({
    page: pageNum, rect: [210, 620, 238, 638], name: 'FlattenCheck',
    checked: true, borderColor: NAVY, borderWidth: 1, textColor: GREEN,
  });

  addLabel('Note:', 575);
  const note = page.AddFreeText({
    rect: [210, 535, 470, 590],
    contents: 'Sticky note — flattened into the page.',
    fontSize: 11, textColor: NAVY, align: 'left',
  });

  // Bake all three. Each bakes its own ink and then unwires itself; the fields
  // on the AcroForm page are untouched.
  tb.Flatten();
  cb.Flatten();
  note.Flatten();

  addText(page, 'Now static content — there is nothing to click or edit in a viewer.',
    [40, 495, w - 40, 515],
    { font: 'Helvetica-Oblique', size: 10, color: MUTED, align: 'center' });
}
