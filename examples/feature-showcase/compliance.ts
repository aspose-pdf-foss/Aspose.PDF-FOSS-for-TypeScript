import { writeFileSync } from 'node:fs';
import type { Document, Page, ValidationReport } from '../../src/index.js';
import { createTable } from '../../src/index.js';
import {
  addText, pageWidth, sectionHeader, DEEP_NAVY, GREEN, INK, MUTED, NAVY,
} from './theme.js';

const PDFA_PATH = 'docs/feature-showcase-pdfa.pdf';

/** One rule, how many issues carry it, and at what severity. */
interface RuleCount { rule: string; severity: string; count: number; clause: string }

function summarize(report: ValidationReport): RuleCount[] {
  const by = new Map<string, RuleCount>();
  for (const issue of report.Issues) {
    const key = `${issue.rule} ${issue.severity}`;
    const existing = by.get(key);
    if (existing) existing.count++;
    else by.set(key, {
      rule: issue.rule,
      severity: issue.severity,
      count: 1,
      clause: issue.clause ?? '',
    });
  }
  // Errors first, then by descending count — the most load-bearing findings top.
  return [...by.values()].sort((a, b) =>
    (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1));
}

function verdict(report: ValidationReport): string {
  return report.Passed
    ? `PASS — ${report.Warnings.length} warning(s)`
    : `FAIL — ${report.Errors.length} error(s), ${report.Warnings.length} warning(s)`;
}

export function addComplianceShowcase(doc: Document, page: Page): void {
  const w = pageWidth(page);

  sectionHeader(page, 'Standards Validation — PDF/A · PDF/X · PDF/UA',
    'real findings from this very document  •  ConvertToPdfA and what it could not fix');

  const pdfa = doc.ValidatePdfA('2b');
  const pdfx = doc.ValidatePdfX('4');
  const pdfua = doc.ValidatePdfUa();

  console.log(`validate: PDF/A-2b ${verdict(pdfa)}; PDF/X-4 ${verdict(pdfx)}; `
    + `PDF/UA ${verdict(pdfua)}`);

  addText(page,
    "These are this document's own validation results, produced on this run — "
    + 'not a curated example. It does not pass PDF/A-2b, and the reasons are '
    + 'worth seeing: the Standard-14 faces this showcase stamps with are not '
    + 'embedded, and there is no /OutputIntent. That is what a first run over '
    + 'your own files will look like.',
    [50, 630, w - 50, 700], { size: 10, color: INK, lineSpacing: 1.35 });

  const verdicts: Array<[string, ValidationReport]> = [
    ['PDF/A-2b', pdfa], ['PDF/X-4', pdfx], ['PDF/UA-1', pdfua],
  ];
  verdicts.forEach(([label, r], i) => {
    const x = 50 + i * ((w - 100) / 3);
    addText(page, label, [x, 602, x + 150, 618],
      { font: 'Helvetica-Bold', size: 11, color: NAVY });
    addText(page, verdict(r), [x, 586, x + 165, 600],
      { size: 9, color: r.Passed ? GREEN : [0.70, 0.20, 0.15] });
  });

  // --- The findings table --------------------------------------------------
  const table = createTable({
    font: 'Helvetica',
    fontSize: 8.5,
    outerBorder: { width: 1, color: DEEP_NAVY },
    border: { width: 0.4, color: [0.80, 0.80, 0.80] },
    padding: { top: 3, right: 5, bottom: 3, left: 5 },
  });
  table.setColumnWidths([
    { fixed: 104 }, { fixed: 58 }, { fixed: 48 }, { fixed: 38 }, { fixed: 247 },
  ]);

  const header = table.addRow(undefined, {
    minHeight: 20, background: DEEP_NAVY,
    font: 'Helvetica-Bold', fontSize: 9, color: [1, 1, 1],
  });
  const HEAD: Array<[string, 'left' | 'right']> = [
    ['Rule', 'left'], ['Standard', 'left'], ['Severity', 'left'],
    ['Count', 'right'], ['Clause', 'left'],
  ];
  for (const [label, align] of HEAD) header.addCell(label, { align, valign: 'center' });
  table.setRepeatingRowsCount(1);

  let zebra = 0;
  for (const [standard, report] of verdicts) {
    for (const rc of summarize(report)) {
      const row = table.addRow(undefined,
        zebra++ % 2 === 1 ? { background: [0.97, 0.97, 0.98] } : {});
      row.addCell(rc.rule, { align: 'left' });
      row.addCell(standard, { align: 'left' });
      row.addCell(rc.severity, {
        align: 'left',
        color: rc.severity === 'error' ? [0.70, 0.20, 0.15] : [0.65, 0.45, 0.05],
      });
      row.addCell(String(rc.count), { align: 'right' });
      row.addCell(rc.clause, { align: 'left', fontSize: 7, color: MUTED });
    }
  }

  page.AddTable(table, 50, 570, { width: w - 100, autoPaginate: false, bottomMargin: 150 });

  // --- Conversion ----------------------------------------------------------
  // ExtractPages gives an independent copy. The live document still has to be
  // saved unconverted, so ConvertToPdfA must never touch it.
  const copy = doc.ExtractPages(doc.Pages.map((_, i) => i + 1));
  const conversion = copy.ConvertToPdfA('2b');
  writeFileSync(PDFA_PATH, copy.Save());
  console.log(`pdf/a convert: ${conversion.applied.length} action(s) applied, `
    + `${conversion.unresolved.length} unresolved -> ${PDFA_PATH}`);

  addText(page, "ConvertToPdfA('2b') on a copy", [50, 128, w - 50, 142],
    { font: 'Helvetica-Bold', size: 11, color: NAVY });

  const appliedRules = [...new Set(conversion.applied.map((a) => a.rule))];
  const unresolvedRules = [...new Set(conversion.unresolved.map((i) => i.rule))];
  addText(page,
    `Wrote ${PDFA_PATH}. Applied ${conversion.applied.length} action(s)`
    + (appliedRules.length ? ` covering ${appliedRules.join(', ')}` : '')
    + `. ${conversion.unresolved.length} issue(s) remain unresolved`
    + (unresolvedRules.length ? ` (${unresolvedRules.join(', ')})` : '')
    + `. Result: ${conversion.passed ? 'passes' : 'still fails'} PDF/A-2b. `
    + 'Conversion runs on an ExtractPages copy — the live document still has to '
    + 'be saved unconverted, so it is never touched.',
    [50, 70, w - 50, 124], { size: 8.5, color: INK, lineSpacing: 1.3 });
}
