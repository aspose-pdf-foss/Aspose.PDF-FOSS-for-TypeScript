import type { XlsxSheet } from '../../src/xlsxpackage.js';

export function buildXlsxSheets(): XlsxSheet[] {
  return [
    {
      name: 'Sales & "tax"',
      rows: [
        ['00123', '=1+2', 12.5, true, false, null, ' <A&B> 🐝 ', ''],
        [],
        [...Array<null>(25).fill(null), 'Across Z'],
      ],
      merges: [{ row: 2, column: 25, rowSpan: 2, columnSpan: 3 }],
    },
    { name: '第二', rows: [[0, -7]] },
  ];
}
