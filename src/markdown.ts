import type { MdDocument } from './mdast.js';
import { parseBlocks } from './mdblock.js';
import { parseInlines } from './mdinline.js';

/** Options for `parseMarkdown`. */
export interface MarkdownOptions {
  /** Enable the five GitHub Flavored Markdown extensions: tables, task list
   *  items, strikethrough, extended autolinks and disallowed raw HTML.
   *
   *  Off by default, so the default path is strict CommonMark 0.31.2 — the one
   *  the 652-case conformance suite pins. */
  gfm?: boolean;
}

/** Parse CommonMark 0.31.2 into an abstract syntax tree.
 *
 *  Never throws: every string is a valid Markdown document. Unlike every other
 *  parser in this library there is no PdfParseError path — damage shows up as
 *  literal text. */
export function parseMarkdown(src: string, options?: MarkdownOptions): MdDocument {
  const gfm = options?.gfm === true;
  // Line endings normalize on entry and NUL becomes U+FFFD, as the spec requires.
  const text = src.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const { doc, refs } = parseBlocks(lines, gfm);
  parseInlines(doc, refs, gfm);
  return doc;
}
