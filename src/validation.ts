import type { StructElement } from './struct.js';
import type { Page } from './page.js';
import type { PdfRef } from './types.js';

export type Severity = 'error' | 'warning';

/** A single validation finding. `element`/`page`/`object` locate the offender
 *  when applicable; at most the most specific one is usually set. */
export interface ValidationIssue {
  /** Stable rule id, e.g. 'FontEmbedded'. */
  rule: string;
  severity: Severity;
  /** Human-readable description. */
  message: string;
  /** Standards clause or Matterhorn reference, when applicable. */
  clause?: string;
  /** Offending structure element, when applicable. */
  element?: StructElement;
  /** Offending page, when applicable. */
  page?: Page;
  /** Offending indirect object, when applicable. */
  object?: PdfRef;
}

/** Findings from a document structure or standards validation pass. */
export class ValidationReport {
  constructor(readonly Issues: ValidationIssue[]) {}
  get Errors(): ValidationIssue[] { return this.Issues.filter((i) => i.severity === 'error'); }
  get Warnings(): ValidationIssue[] { return this.Issues.filter((i) => i.severity === 'warning'); }
  /** True when there are no error-severity issues (warnings are allowed). */
  get Passed(): boolean { return this.Errors.length === 0; }
}
