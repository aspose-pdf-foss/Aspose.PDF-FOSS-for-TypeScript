import { buildTwoPageTablePdf, hline, vline, text } from './build-table-pdf.js';

/** Two pages repeat a header that contains a different nested grid on each page. */
export function buildNestedHeaderPdf(): Uint8Array {
  function fragment(label: string): string {
    return hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50)
      + vline(50, 50, 250) + vline(150, 50, 250) + vline(250, 50, 250)
      + hline(170, 230, 230) + hline(170, 230, 200) + hline(170, 230, 170)
      + vline(170, 170, 230) + vline(200, 170, 230) + vline(230, 170, 230)
      + text(70, 200, 'Header') + text(174, 210, label) + text(204, 210, 'X')
      + text(174, 180, 'Y') + text(204, 180, 'Z') + text(70, 100, 'Body') + text(170, 100, 'Cell');
  }
  return buildTwoPageTablePdf(fragment('P1'), fragment('P2'));
}

/** Two aligned ruled tables with a repeated, two-column spanning header. */
export function buildXlsxTablePdf(): Uint8Array {
  function fragment(left: string, right: string): string {
    return hline(50, 250, 250) + hline(50, 250, 150) + hline(50, 250, 50)
      + vline(50, 50, 250) + vline(250, 50, 250) + vline(150, 50, 150)
      + text(70, 200, 'Register') + text(70, 100, left) + text(170, 100, right);
  }
  return buildTwoPageTablePdf(fragment('00123', '=1+2'), fragment('00456', 'Final'));
}
