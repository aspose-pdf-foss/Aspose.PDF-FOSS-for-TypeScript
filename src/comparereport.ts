/**
 * A text comparison written out as HTML, Markdown or JSON (`aq4a.3`).
 *
 * Pure over `compare.ts`'s result types: no `Document`, no PDF object, so every
 * rule is testable from a comparison and nothing here can disagree with
 * `CompareText` about what changed — it only decides how to show it.
 *
 * One block per document, or one per page pair in `'pages'` mode. Equal text
 * is shown in the SECOND document's spelling, so the output reads as the new
 * version with the deletions struck in place; under `ignoreCase` the two
 * spellings differ and this is the one a reader of the new version knows.
 */
import type { TextChange, TextComparison, PageTextComparison } from './compare.js';
import { escapeXml } from './xml.js';
import { escapeMarkdown, escapeMarkdownInline } from './mdescape.js';

export interface ComparisonReportOptions {
  /** Unchanged words (characters, at character granularity) to keep either
   *  side of each change. A longer unchanged stretch is cut to an ellipsis.
   *  Default: keep everything. */
  context?: number;
}

export interface ComparisonHtmlOptions extends ComparisonReportOptions {
  /** Return only the markup (a `<div class="pdf-diff">`), for embedding in a
   *  page of your own. Default false: a complete HTML document with a style
   *  sheet, a title and a summary line. */
  fragment?: boolean;
  /** The document title. Default `Comparison`. */
  title?: string;
}

export interface ComparisonJsonOptions {
  /** Include each change's `old`/`new` spans (pages and quads). Default true. */
  spans?: boolean;
  /** Spaces per indent level; 0 writes one line. Default 2. */
  indent?: number;
}

/** A piece of one block: unchanged, deleted or inserted text, or a cut. */
type Piece = { kind: 'equal' | 'delete' | 'insert'; text: string } | { kind: 'elided' };
interface Block { heading?: string; pieces: Piece[] }

const VISIBLE_SPACE = '␣';

/** Write a comparison as HTML: deletions in `<del>`, insertions in `<ins>`. */
export function comparisonToHtml(result: TextComparison, opts: ComparisonHtmlOptions = {}): string {
  const context = checkContext(opts.context);
  if (opts.title !== undefined && typeof opts.title !== 'string') throw new TypeError('comparisonToHtml: title must be a string');
  const sep = result.granularity === 'word' ? ' ' : '';
  const para = (pieces: Piece[]): string => `<p>${pieces.map((p) => {
    if (p.kind === 'elided') return '<span class="elided">…</span>';
    const t = escapeXml(p.kind === 'equal' ? p.text : visible(p.text));
    return p.kind === 'equal' ? t : `<${p.kind === 'delete' ? 'del' : 'ins'}>${t}</${p.kind === 'delete' ? 'del' : 'ins'}>`;
  }).join(sep)}</p>\n`;
  let body = '<div class="pdf-diff">\n';
  for (const b of blocks(result, context)) {
    body += b.heading === undefined ? para(b.pieces) : `<section>\n<h2>${escapeXml(b.heading)}</h2>\n${para(b.pieces)}</section>\n`;
  }
  body += '</div>\n';
  if (opts.fragment) return body;
  const s = result.stats;
  return '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n'
    + `<title>${escapeXml(opts.title ?? 'Comparison')}</title>\n`
    + '<style>\n'
    + 'body { font-family: system-ui, sans-serif; line-height: 1.5; max-width: 50rem; margin: 2rem auto; padding: 0 1rem; }\n'
    + 'del { background: #fde2e1; color: #8a1c14; text-decoration: line-through; }\n'
    + 'ins { background: #dcf3de; color: #1d5e24; text-decoration: none; }\n'
    + '.elided { color: #77808a; }\n'
    + '.summary { color: #55606a; }\n'
    + '</style>\n</head>\n<body>\n'
    + `<p class="summary">${s.deleted} deleted, ${s.inserted} inserted, similarity ${Math.round(s.similarity * 100)}%</p>\n`
    + body + '</body>\n</html>\n';
}

/** Write a comparison as GitHub-flavored Markdown: at word granularity a
 *  deletion is `~~struck~~` and an insertion `**bold**`; at character
 *  granularity they are inline `<del>`/`<ins>` tags, because a change inside a
 *  word next to punctuation leaves a delimiter that cannot open or close. */
export function comparisonToMarkdown(result: TextComparison, opts: ComparisonReportOptions = {}): string {
  const context = checkContext(opts.context);
  const words = result.granularity === 'word';
  const para = (pieces: Piece[]): string => {
    const out = pieces.map((p) => {
      if (p.kind === 'elided') return '…';
      if (p.kind === 'equal') return escapeMarkdownInline(p.text);
      const t = escapeMarkdownInline(visible(p.text));
      if (!words) return p.kind === 'delete' ? `<del>${t}</del>` : `<ins>${t}</ins>`;
      // A word token holds no whitespace and sits between spaces, so the
      // delimiters are always flanked correctly.
      return p.kind === 'delete' ? `~~${t}~~` : `**${t}**`;
    }).join(words ? ' ' : '');
    // Inline escaping everywhere, plus the block openers at the line's start.
    return escapeLineStart(out);
  };
  return blocks(result, context)
    .map((b) => (b.heading === undefined ? '' : `## ${escapeMarkdown(b.heading)}\n\n`) + para(b.pieces) + '\n')
    .join('\n');
}

/** Write a comparison as JSON: `granularity`, `minimal`, `stats`, `changes`
 *  and, in `'pages'` mode, `pages`. */
export function comparisonToJson(result: TextComparison, opts: ComparisonJsonOptions = {}): string {
  const indent = opts.indent ?? 2;
  if (!Number.isInteger(indent) || indent < 0 || indent > 10) throw new RangeError('comparisonToJson: indent must be an integer from 0 to 10');
  const spans = opts.spans !== false;
  const change = (c: TextChange): object =>
    spans ? { op: c.op, oldText: c.oldText, newText: c.newText, old: c.old, new: c.new } : { op: c.op, oldText: c.oldText, newText: c.newText };
  const page = (p: PageTextComparison): object =>
    ({ oldPage: p.oldPage, newPage: p.newPage, stats: p.stats, minimal: p.minimal, changes: p.changes.map(change) });
  const out = {
    granularity: result.granularity,
    minimal: result.minimal,
    stats: result.stats,
    changes: result.changes.map(change),
    pages: result.pages?.map(page),
  };
  return JSON.stringify(out, null, indent || undefined);
}

function checkContext(c: number | undefined): number {
  if (c === undefined) return Infinity;
  if (!Number.isInteger(c) || c < 0) throw new RangeError('context must be a non-negative integer');
  return c;
}

/** A change that is only whitespace would vanish inside its mark. */
function visible(text: string): string {
  return text.trim() === '' ? VISIBLE_SPACE.repeat(Math.max(1, text.length)) : text;
}

/** `escapeMarkdown`'s block-opener rule for the one line a block is. The
 *  pieces were escaped inline already, so only the openers remain. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s{0,3})([#>+=-])/, '$1\\$2').replace(/^(\s{0,3})(\d{1,9})([.)])/, '$1$2\\$3');
}

function blocks(result: TextComparison, context: number): Block[] {
  if (!result.pages) return [{ pieces: pieces(result.changes, result.granularity, context) }];
  return result.pages.map((p) => ({
    heading: p.oldPage === undefined ? `Page ${p.newPage} (second document only)`
      : p.newPage === undefined ? `Page ${p.oldPage} (first document only)`
        : `Page ${p.oldPage}`,
    pieces: pieces(p.changes, result.granularity, context),
  }));
}

function pieces(changes: TextChange[], granularity: 'word' | 'character', context: number): Piece[] {
  const out: Piece[] = [];
  changes.forEach((c, i) => {
    if (c.op === 'delete') { out.push({ kind: 'delete', text: c.oldText }); return; }
    if (c.op === 'insert') { out.push({ kind: 'insert', text: c.newText }); return; }
    const toks = granularity === 'word' ? c.newText.split(' ') : Array.from(c.newText);
    const head = i > 0 ? context : 0;
    const tail = i < changes.length - 1 ? context : 0;
    const join = (t: string[]): string => t.join(granularity === 'word' ? ' ' : '');
    // Infinity means "keep everything" even where no change is near: a run with
    // no neighbour on either side keeps 0 + 0 words under any finite context.
    if (context === Infinity || toks.length <= head + tail) { out.push({ kind: 'equal', text: c.newText }); return; }
    if (head > 0) out.push({ kind: 'equal', text: join(toks.slice(0, head)) });
    out.push({ kind: 'elided' });
    if (tail > 0) out.push({ kind: 'equal', text: join(toks.slice(toks.length - tail)) });
  });
  return out;
}
