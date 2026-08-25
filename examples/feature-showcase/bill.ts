import type { Page } from '../../src/index.js';
import { createTable } from '../../src/index.js';
import { addText, pageWidth, pageHeight, sectionHeader, BROWN } from './theme.js';

export function addRestaurantBill(page: Page): void {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Restaurant Bill',
    'Trattoria da Marco — single-page table with colSpan summary rows');

  addText(page, 'Date: 2026-05-19    Table: 7    Server: Marco    Receipt #: 4218',
    [50, h - 140, w - 50, h - 122],
    { size: 10, color: [0.3, 0.3, 0.3], align: 'center' });

  const table = createTable({
    font: 'Helvetica',
    fontSize: 11,
    outerBorder: { width: 1, color: BROWN },
    border: { width: 0.4, color: [0.75, 0.75, 0.75] },
    padding: { top: 5, right: 8, bottom: 5, left: 8 },
  });
  table.setColumnWidths([{ fixed: 260 }, { fixed: 50 }, { fixed: 75 }, { fixed: 75 }]);

  // Header row.
  const header = table.addRow(undefined, {
    background: BROWN, font: 'Helvetica-Bold', fontSize: 11, color: [1, 1, 1],
  });
  header.addCell('Item', { align: 'left' });
  header.addCell('Qty', { align: 'center' });
  header.addCell('Unit Price', { align: 'right' });
  header.addCell('Total', { align: 'right' });

  const items: Array<[string, number, number, number]> = [
    ['Bruschetta al Pomodoro', 2, 8.50, 17.00],
    ['Insalata Caprese', 1, 12.00, 12.00],
    ['Spaghetti alla Carbonara', 2, 16.50, 33.00],
    ['Pizza Margherita', 1, 14.00, 14.00],
    ['Tiramisu', 2, 7.50, 15.00],
    ['House Red Wine (bottle)', 1, 28.00, 28.00],
    ['Espresso', 4, 3.50, 14.00],
  ];
  let subtotal = 0;
  for (const [name, qty, unit, total] of items) {
    subtotal += total;
    const row = table.addRow();
    row.addCell(name, { align: 'left' });
    row.addCell(String(qty), { align: 'center' });
    row.addCell(`€${unit.toFixed(2)}`, { align: 'right' });
    row.addCell(`€${total.toFixed(2)}`, { align: 'right' });
  }

  // Summary rows: one label cell spanning the first three columns, then the
  // amount on the right.
  const addSummary = (
    label: string, amount: number, bold: boolean, bg?: [number, number, number],
  ): void => {
    const row = table.addRow(undefined, bg ? { background: bg } : {});
    const style = bold
      ? { font: 'Helvetica-Bold' as const, fontSize: 12 }
      : { font: 'Helvetica' as const, fontSize: 11 };
    row.addCell(label, { ...style, colSpan: 3, align: 'right' });
    row.addCell(`€${amount.toFixed(2)}`, { ...style, align: 'right' });
  };
  const tax = subtotal * 0.10;
  const service = subtotal * 0.15;
  addSummary('Subtotal:', subtotal, false);
  addSummary('Tax (10%):', tax, false);
  addSummary('Service (15%):', service, false);
  addSummary('TOTAL:', subtotal + tax + service, true, [0.97, 0.93, 0.85]);

  // 460pt wide, centred on A4 (595 - 460 = 135 -> 67.5 each side).
  page.AddTable(table, 67.5, h - 165, { width: 460 });

  addText(page, 'Grazie mille e a presto!', [50, 140, w - 50, 175],
    { font: 'Helvetica-Oblique', size: 14, color: BROWN, align: 'center' });
}
