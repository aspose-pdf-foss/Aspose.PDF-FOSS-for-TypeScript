import type { TextComparison } from './compare.js';
import { comparisonBlocks, type ComparisonReportOptions } from './comparereport.js';
import { Document } from './document.js';
import { UnsupportedFeatureError } from './errors.js';
import type { FlowTextRun } from './flow.js';
import type { Undrawable } from './textcoverage.js';

export interface ComparisonPdfOptions extends ComparisonReportOptions {
  /** Visible heading and PDF metadata title. Defaults to Comparison. */
  title?: string;
  /** A font program covering the report text, for characters outside WinAnsi. */
  fontBytes?: Uint8Array;
}

/** Write a paginated, searchable text diff from an existing comparison. */
export function comparisonToPdf(result: TextComparison, options: ComparisonPdfOptions = {}): Uint8Array {
  if (options.title !== undefined && typeof options.title !== 'string')
    throw new TypeError('comparisonToPdf: title must be a string');
  const blocks = comparisonBlocks(result, options.context);
  const title = options.title ?? 'Comparison';
  const doc = Document.New();
  doc.SetMetadata({ title });
  const font = options.fontBytes && doc.AddFont(options.fontBytes);
  const onUndrawable = ({ lost }: Undrawable) => {
    throw new UnsupportedFeatureError(`comparisonToPdf: supply fontBytes covering the missing characters ${JSON.stringify(lost)}`);
  };
  const style = { font, onUndrawable };
  const flow = doc.NewFlow();
  flow.AddHeading(1, title, style);
  const { deleted, inserted, similarity } = result.stats;
  flow.AddParagraph(`${deleted} deleted, ${inserted} inserted, similarity ${Math.round(similarity * 100)}%`, style);
  const separator = result.granularity === 'word' ? ' ' : '';
  for (const block of blocks) {
    if (block.heading) flow.AddHeading(2, block.heading, style);
    const runs: FlowTextRun[] = block.pieces.map((piece, i) => {
      let text = piece.kind === 'elided' ? '…' : piece.text;
      if ((piece.kind === 'delete' || piece.kind === 'insert') && !text.trim())
        text = '[space]'.repeat(Math.max(1, text.length));
      const run: FlowTextRun = { text: (i ? separator : '') + text };
      if (piece.kind === 'delete') { run.color = [0.54, 0.11, 0.08]; run.strikethrough = true; }
      if (piece.kind === 'insert') { run.color = [0.08, 0.37, 0.14]; run.underline = true; }
      return run;
    });
    if (runs.length) flow.AddParagraph(runs, style);
  }
  flow.Render();
  return doc.Save();
}
