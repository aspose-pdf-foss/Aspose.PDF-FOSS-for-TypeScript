import type { PdfRef } from './types.js';
import type { Page } from './page.js';
import type { ValidationIssue } from './validation.js';
import type { EmbedFontsReport } from './embedfonts.js';

/** One remediation performed by a converter (PDF/A or PDF/UA). */
export interface ConvertAction {
  /** Validator rule id this addresses, e.g. 'OutputIntent' or 'NaturalLanguage'. */
  rule: string;
  /** What was done, human-readable. */
  action: string;
  object?: PdfRef;
  page?: Page;
}

/** The result of a conversion run: what was applied, what still fails, pass flag. */
export interface ConversionReport {
  applied: ConvertAction[];
  /** Results of the optional registered-font pass, including compatibility refusals. */
  fontEmbedding?: EmbedFontsReport;
  /** == the validator's Errors after the passes run. */
  unresolved: ValidationIssue[];
  passed: boolean;
}
