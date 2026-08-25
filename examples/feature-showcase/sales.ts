import type { Page } from '../../src/index.js';
import { createTable } from '../../src/index.js';
import { pageWidth, pageHeight, sectionHeader, DEEP_NAVY } from './theme.js';
import { salesBanner } from './assets.js';

export function addSalesReport(page: Page): number {
  const w = pageWidth(page);
  const h = pageHeight(page);

  sectionHeader(page, 'Multi-Page Sales Report',
    'image header  •  repeating headers  •  colSpan  •  row background  •  overflow');

  const navy = DEEP_NAVY;
  const white: [number, number, number] = [1, 1, 1];
  const titleBG: [number, number, number] = [0.94, 0.95, 0.99];
  const sectionBG: [number, number, number] = [0.85, 0.88, 0.95];
  const zebraBG: [number, number, number] = [0.97, 0.97, 0.97];
  const totalBG: [number, number, number] = [0.97, 0.93, 0.85];

  const table = createTable({
    font: 'Helvetica',
    fontSize: 10,
    outerBorder: { width: 1, color: navy },
    border: { width: 0.4, color: [0.78, 0.78, 0.78] },
    padding: { top: 4, right: 6, bottom: 4, left: 6 },
  });
  table.setColumnWidths([{ fixed: 260 }, { fixed: 60 }, { fixed: 80 }, { fixed: 80 }]);

  // Row 0: banner image spanning all four columns; minHeight makes it a strip.
  table.addRow(undefined, { minHeight: 54, background: navy })
    .addCell('', { colSpan: 4, align: 'center', valign: 'center' })
    .setImage(salesBanner(), { align: 'center', valign: 'center', height: 46 });

  // Row 1: title.
  table.addRow(undefined, { minHeight: 28, background: titleBG })
    .addCell('Trattoria da Marco  —  Quarterly Sales Report  (Q3 2026)', {
      colSpan: 4, font: 'Helvetica-Bold', fontSize: 14, color: navy,
      align: 'center', valign: 'center',
    });

  // Row 2: column headers — row style propagates, per-cell align overrides.
  const colHeader = table.addRow(undefined, {
    minHeight: 22, background: navy, font: 'Helvetica-Bold', fontSize: 11, color: white,
  });
  colHeader.addCell('Item', { align: 'left', valign: 'center' });
  colHeader.addCell('Qty', { align: 'center', valign: 'center' });
  colHeader.addCell('Unit Price', { align: 'right', valign: 'center' });
  colHeader.addCell('Revenue', { align: 'right', valign: 'center' });

  table.setRepeatingRowsCount(3);

  const divider = (label: string): void => {
    table.addRow(undefined, { background: sectionBG })
      .addCell(label, {
        colSpan: 4, font: 'Helvetica-Bold', fontSize: 11, color: navy, align: 'left',
      });
  };

  let grandTotal = 0;
  let zebraIdx = 0;
  const addItems = (items: Array<[string, string, string, string]>): void => {
    items.forEach(([name, qty, unit, revenue], i) => {
      const row = table.addRow(undefined,
        (i + zebraIdx) % 2 === 1 ? { background: zebraBG } : {});
      row.addCell(name, { align: 'left' });
      row.addCell(qty, { align: 'center' });
      row.addCell(unit, { align: 'right' });
      row.addCell(revenue, { align: 'right' });
      grandTotal += Number(revenue);
    });
    zebraIdx += items.length;
  };

  divider('Pasta Dishes');
  addItems([
    ['Spaghetti alla Carbonara', '47', '16.50', '775.50'],
    ['Tagliatelle al Ragu Bolognese', '38', '17.00', '646.00'],
    ['Lasagna alla Forno', '29', '18.50', '536.50'],
    ['Fettuccine Alfredo', '24', '16.00', '384.00'],
    ["Penne all'Arrabbiata", '31', '15.00', '465.00'],
    ['Linguine al Pesto Genovese', '26', '16.50', '429.00'],
    ['Ravioli di Spinaci e Ricotta', '22', '17.50', '385.00'],
    ['Gnocchi ai Quattro Formaggi', '19', '17.00', '323.00'],
  ]);

  divider('Pizza Selection');
  addItems([
    ['Pizza Margherita', '62', '12.00', '744.00'],
    ['Pizza Quattro Formaggi', '41', '14.50', '594.50'],
    ['Pizza Capricciosa', '35', '15.00', '525.00'],
    ['Pizza Diavola', '33', '14.00', '462.00'],
    ['Pizza Marinara', '28', '11.00', '308.00'],
    ['Pizza Napoletana', '39', '13.50', '526.50'],
    ['Pizza Prosciutto e Funghi', '37', '15.50', '573.50'],
    ['Pizza Quattro Stagioni', '30', '16.00', '480.00'],
  ]);

  divider('Antipasti');
  addItems([
    ['Bruschetta al Pomodoro', '54', '8.50', '459.00'],
    ['Carpaccio di Manzo', '21', '14.00', '294.00'],
    ['Insalata Caprese', '33', '12.00', '396.00'],
    ['Vitello Tonnato', '18', '16.50', '297.00'],
  ]);

  divider('Desserts');
  addItems([
    ['Tiramisu Classico', '67', '7.50', '502.50'],
    ['Panna Cotta ai Frutti di Bosco', '44', '7.00', '308.00'],
    ['Cannoli Siciliani', '32', '6.50', '208.00'],
    ['Gelato Misto (3 scoops)', '58', '6.00', '348.00'],
    ['Sfogliatella Napoletana', '27', '7.50', '202.50'],
  ]);

  divider('Beverages');
  addItems([
    ['House Red Wine (Chianti, bottle)', '42', '28.00', '1176.00'],
    ['House White Wine (Pinot Grigio, bottle)', '36', '26.00', '936.00'],
    ['Sparkling Water (Acqua Frizzante, 1L)', '89', '4.50', '400.50'],
    ['Espresso', '215', '3.50', '752.50'],
    ['Cappuccino', '127', '4.50', '571.50'],
    ['Limoncello (glass)', '53', '8.00', '424.00'],
  ]);

  // TOTAL row: two colSpan(2) cells so the formatted total has room.
  const totalRow = table.addRow(undefined, {
    minHeight: 32, background: totalBG,
    padding: { top: 6, right: 8, bottom: 6, left: 8 },
  });
  totalRow.addCell('GRAND TOTAL', {
    colSpan: 2, font: 'Helvetica-Bold', fontSize: 13, color: navy,
    align: 'right', valign: 'center',
  });
  totalRow.addCell(`€${grandTotal.toFixed(2)}`, {
    colSpan: 2, font: 'Helvetica-Bold', fontSize: 14, color: navy,
    align: 'right', valign: 'center',
  });

  const res = page.AddTable(table, 50, h - 130, {
    width: w - 100, autoPaginate: true, bottomMargin: 70, topMargin: 60,
  });
  return res.pages.length - 1;
}
