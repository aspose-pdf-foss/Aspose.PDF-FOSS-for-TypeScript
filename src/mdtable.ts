import type { MdAlign, MdTableCell, MdTableRow } from './mdast.js';

/** The GFM table block grammar: delimiter row, cell splitting, row building.
 *
 *  Pure — strings in, data out. It never sees a Document and never parses an
 *  inline: a cell's text is staged raw and mdinline.ts replaces it, exactly as
 *  a paragraph's is.
 *
 *  Transcribed from cmark-gfm's ext_scanners.re and row_from_string:
 *
 *    spacechar    = [ \t\v\f]
 *    escaped_char = \\ followed by an ASCII punctuation character
 *    table_marker = spacechar* :? -+ :? spacechar*
 *    table_cell   = (escaped_char | [^|\r\n])+
 *    delimiter row = |? table_marker (| table_marker)* |? spacechar*
 */

const SPACE = '[ \\t\\v\\f]';
const MARKER = `${SPACE}*:?-+:?${SPACE}*`;
const DELIMITER_ROW = new RegExp(`^\\|?${MARKER}(?:\\|${MARKER})*\\|?${SPACE}*$`);

/** The alignment of each column, or undefined when this is not a delimiter row.
 *
 *  A single-column row must carry a pipe: without one, `---` under a paragraph
 *  is a setext heading and `- - -` is a thematic break, and both outrank a
 *  table. The regex allows a bare marker, so the pipe is checked here. */
export function scanDelimiterRow(line: string): (MdAlign | null)[] | undefined {
  if (!DELIMITER_ROW.test(line)) return undefined;
  if (!line.includes('|')) return undefined;
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  });
}

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\v' || c === '\f';

/** Split a row into trimmed cell texts.
 *
 *  Leading and trailing pipes are optional. `\|` is a literal pipe and does not
 *  split — and the unescape happens HERE, before any inline parsing, which is
 *  why a code span in a cell can contain a pipe at all (``b `\|` az`` renders as
 *  `<code>|</code>`). A line with no pipe is one cell, which is what makes a
 *  bare `bar` line continue a table rather than end it. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let i = 0;
  // Skip one leading pipe, and the spaces after it.
  if (line[i] === '|') { i++; while (isSpace(line[i])) i++; }
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += c + line[i + 1]; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  // A trailing pipe closes the last cell rather than opening an empty one.
  if (cur.trim() !== '' || cells.length === 0) cells.push(cur.trim());
  return cells;
}

/** Build the table's rows. `lines[0]` is the header; every body row is padded
 *  with empty cells when short and truncated when long, which is the one place
 *  the header and the body differ (a header whose width disagrees with the
 *  delimiter row is not a table at all — that check lives in mdblock.ts). */
export function buildRows(lines: string[], columns: number): MdTableRow[] {
  return lines.map((line, i) => {
    const cells = splitRow(line);
    const children: MdTableCell[] = [];
    for (let c = 0; c < columns; c++) {
      const raw = cells[c] ?? '';
      children.push({
        type: 'table_cell',
        children: raw === '' ? [] : [{ type: 'text', value: raw }],
      });
    }
    return { type: 'table_row', header: i === 0, children };
  });
}
