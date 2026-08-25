import type { Document, Page } from '../../src/index.js';
import {
  addText, pageWidth, pageHeight, sectionHeader, NAVY, TINT, GREEN, FAINT,
} from './theme.js';
import { asposeLogoPng } from './assets.js';

export function addFormFields(doc: Document, page: Page): void {
  const form = doc.Form;
  const pageNum = page.Number;
  const w = pageWidth(page);
  const h = pageHeight(page);
  const labelW = 130;

  const addLabel = (text: string, y: number): void => {
    addText(page, text, [50, y, 50 + labelW, y + 18], { font: 'Helvetica-Bold', size: 11 });
  };

  sectionHeader(page, 'AcroForm Fields',
    'Text  •  checkbox  •  radio group  •  combo box  •  list box  •  push button');

  addText(page,
    'Fields below are styled at creation (border, background, text colour, font, alignment)  ·  Also available  ·  read / write any value  ·  Required & ReadOnly flags  ·  MaxLen, Multiline, Password, Comb (text)  ·  MultiSelect (list)  ·  AddOption / RemoveOption  ·  RemoveField',
    [30, h - 145, w - 30, h - 115],
    { size: 9, color: FAINT, align: 'center', lineSpacing: 1.3 });

  // Row 1: text field — navy border, faint tint fill, navy text.
  addLabel('Full name:', 670);
  form.AddTextField({
    page: pageNum, rect: [200, 670, 450, 690], name: 'FullName', value: 'Alice Sample',
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY,
    borderWidth: 1, font: 'Helvetica', fontSize: 12,
  });

  // Row 2: checkbox — navy box, green check.
  addLabel('Subscribe:', 630);
  form.AddCheckbox({
    page: pageNum, rect: [200, 630, 218, 648], name: 'Subscribe',
    checked: true, borderColor: NAVY, borderWidth: 1, textColor: GREEN,
  });

  // Row 3: radio group, three options laid out horizontally.
  addLabel('Plan:', 590);
  form.AddRadioGroup({
    name: 'Plan',
    selected: 'Pro',
    borderColor: NAVY, borderWidth: 1, textColor: NAVY,
    options: [
      { page: pageNum, rect: [200, 590, 218, 608], export: 'Basic' },
      { page: pageNum, rect: [290, 590, 308, 608], export: 'Pro' },
      { page: pageNum, rect: [380, 590, 398, 608], export: 'Enterprise' },
    ],
  });
  addText(page, 'Basic', [222, 592, 280, 608], { size: 10 });
  addText(page, 'Pro', [312, 592, 370, 608], { size: 10 });
  addText(page, 'Enterprise', [402, 592, 480, 608], { size: 10 });

  // Row 4: combo box. /V holds the export, the appearance draws the display text.
  addLabel('Country:', 550);
  form.AddComboBox({
    page: pageNum, rect: [200, 550, 350, 570], name: 'Country', value: 'US',
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY, borderWidth: 1,
    options: [
      { export: 'US', display: 'United States' },
      { export: 'UK', display: 'United Kingdom' },
      { export: 'DE', display: 'Germany' },
      { export: 'JP', display: 'Japan' },
    ],
  });

  // Row 5: multi-select list box.
  addLabel('Interests:', 490);
  form.AddListBox({
    page: pageNum, rect: [200, 410, 350, 510], name: 'Interests',
    multiSelect: true, value: ['pdf'],
    borderColor: NAVY, backgroundColor: TINT, textColor: NAVY, borderWidth: 1,
    options: [
      { export: 'pdf', display: 'PDF Engineering' },
      { export: 'crypto', display: 'Cryptography' },
      { export: 'type', display: 'Typography' },
      { export: 'color', display: 'Color Science' },
    ],
  });

  // Row 6: branded push button. /N, /R and /D are all generated, so the button
  // reacts to hover and press in any viewer.
  addLabel('Submit:', 360);
  form.AddPushButton({
    page: pageNum, rect: [200, 320, 320, 388], name: 'Submit',
    caption: 'Submit',
    rolloverCaption: 'Click to submit',
    downCaption: 'Submitting…',
    icon: asposeLogoPng(),
    iconPosition: 'icon-above-caption',
    textColor: [1, 1, 1],
    backgroundColor: NAVY,
    borderColor: [0.08, 0.12, 0.4],
    borderWidth: 1,
    action: { type: 'submit', url: 'https://httpbin.org/post', format: 'fdf' },
  });
}
