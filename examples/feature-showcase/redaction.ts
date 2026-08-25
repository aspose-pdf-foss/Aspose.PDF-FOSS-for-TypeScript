import type { Page } from '../../src/index.js';
import type { Box } from './theme.js';
import { addText, pageWidth, pageHeight, sectionHeader } from './theme.js';

/** Values destroyed by the apply pass — absent from the saved page's text. */
export const REDACTED_VALUES = ['$185,000.00', '+1 (415) 555-0182'];
/** Values left intact beneath unapplied marks — still present in the saved text. */
export const MARKED_VALUES = ['026009593', '4421-9087-7733-2104'];

type Phase = 'none' | 'apply' | 'mark';

interface Row { label: string; value: string; y: number; phase: Phase }

export function addRedactionDemo(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Redactions',
    'Mark-mode  vs  applied — both phases side by side on the same page');

  addText(page,
    'ApplyRedactions destructively rewrites the content stream — glyphs inside every targeted /Redact annotation are gone for good. Marks added after the call stay unapplied: the value reads through and is still copy-selectable.',
    [50, h - 180, w - 50, h - 130],
    { size: 10.5, color: [0.3, 0.3, 0.3], lineSpacing: 1.4 });

  addText(page, 'Internal memo — Q3 personnel changes', [60, h - 220, w - 60, h - 200],
    { font: 'Helvetica-Bold', size: 14 });

  const valueLLX = 220;
  const valueURX = 460;
  const rows: Row[] = [
    { label: 'Employee:', value: 'Maria Castellano (ID 47821)', y: 580, phase: 'none' },
    { label: 'Retention bonus:', value: REDACTED_VALUES[0], y: 550, phase: 'apply' },
    { label: 'Direct phone:', value: REDACTED_VALUES[1], y: 520, phase: 'apply' },
    { label: 'Bank routing:', value: MARKED_VALUES[0], y: 490, phase: 'mark' },
    { label: 'Account number:', value: MARKED_VALUES[1], y: 460, phase: 'mark' },
    { label: 'Effective date:', value: '2026-04-15', y: 430, phase: 'none' },
  ];

  for (const r of rows) {
    addText(page, r.label, [60, r.y, 215, r.y + 16],
      { font: 'Helvetica-Bold', size: 12, color: [0.3, 0.3, 0.3] });
    addText(page, r.value, [valueLLX, r.y, valueURX, r.y + 16],
      { font: 'Times-Roman', size: 12 });
    if (r.phase !== 'none') {
      const tag = r.phase === 'apply' ? 'applied' : 'mark-mode';
      const color: [number, number, number] =
        r.phase === 'apply' ? [0.7, 0.1, 0.1] : [0.5, 0.4, 0.0];
      addText(page, tag, [475, r.y + 1, w - 50, r.y + 15],
        { font: 'Helvetica-Bold', size: 8, color });
    }
  }

  const rectFor = (y: number): Box => [valueLLX - 4, y - 2, valueURX, y + 18];

  // Phase 1 — mark the "applied" rows, then apply. That rewrites the content
  // stream (the value glyphs inside each quad are destroyed) and removes those
  // marks, so the saved page holds a plain filled rectangle: no annotation, no
  // recoverable text.
  for (const r of rows.filter((x) => x.phase === 'apply')) {
    page.AddRedact({
      rect: rectFor(r.y),
      fill: [0, 0, 0],
      overlayText: '[REDACTED]',
      align: 'center',
      fontSize: 9,
      textColor: [1, 1, 1],
    });
  }
  page.ApplyRedactions();

  // Phase 2 — marks added AFTER the apply call stay unapplied for ever. The
  // annotation is part of the PDF and the content under it is alive. Colour is
  // the discriminator: black + "[REDACTED]" is applied and gone, amber + "MARK"
  // is an annotation whose value survives beneath it.
  for (const r of rows.filter((x) => x.phase === 'mark')) {
    page.AddRedact({
      rect: rectFor(r.y),
      color: [0.98, 0.82, 0.18],
      fill: [0.98, 0.82, 0.18],
      overlayText: 'MARK — annotation, not applied',
      align: 'center',
      fontSize: 9,
      textColor: [0.4, 0.3, 0],
    });
  }

  addText(page,
    'Try copying the values: applied rows yield nothing (the glyphs are not there), mark-mode rows still copy the original text.',
    [50, 380, w - 50, 400],
    { font: 'Helvetica-Oblique', size: 10, color: [0.5, 0.5, 0.5], align: 'center' });
}
