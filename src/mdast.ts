/** The CommonMark abstract syntax tree, per CommonMark 0.31.2.
 *
 *  Pure data: this module imports nothing and allocates no PDF objects. Nodes
 *  carry no source positions — see
 *  docs/superpowers/specs/2026-08-11-commonmark-parser-design.md. */

export interface MdDocument { type: 'document'; children: MdBlock[]; }
export interface MdBlockQuote { type: 'block_quote'; children: MdBlock[]; }

/** `tight` decides whether an item's paragraphs render as paragraphs (loose) or
 *  as bare content (tight). It is invisible in most HTML renderings but drives
 *  paragraph spacing in Flow, so gl6o.3 depends on it. */
export interface MdList {
  type: 'list';
  ordered: boolean;
  /** The first ordered item's number; 1 for a bullet list. */
  start: number;
  /** The marker character: `-`, `+`, `*` for bullets; `.` or `)` for ordered. */
  delimiter: '-' | '+' | '*' | '.' | ')';
  tight: boolean;
  children: MdItem[];
}
export interface MdItem {
  type: 'item';
  /** GFM task list marker: absent on an ordinary item, false for `[ ]`, true
   *  for `[x]`. The marker itself is stripped from the item's content. */
  checked?: boolean;
  children: MdBlock[];
}

export interface MdParagraph { type: 'paragraph'; children: MdInline[]; }
/** Level 1..6, identical for the ATX (`# x`) and setext (`x\n=`) spellings. */
export interface MdHeading { type: 'heading'; level: number; children: MdInline[]; }
export interface MdThematicBreak { type: 'thematic_break'; }
/** `info` is the raw info string of a fenced block, entity-decoded and
 *  backslash-unescaped but not split on whitespace; '' for an indented block. */
export interface MdCodeBlock { type: 'code_block'; fenced: boolean; info: string; literal: string; }
/** Raw HTML, verbatim. gl6o.3 will drop these; the spec suite renders them. */
export interface MdHtmlBlock { type: 'html_block'; literal: string; }

/** GFM table alignment, from the `:` markers on the delimiter row. */
export type MdAlign = 'left' | 'center' | 'right';
/** `align` carries one entry per column, null where the delimiter row gave
 *  none — which is not the same as 'left', since a renderer may have its own
 *  default. */
export interface MdTable { type: 'table'; align: (MdAlign | null)[]; children: MdTableRow[]; }
export interface MdTableRow { type: 'table_row'; header: boolean; children: MdTableCell[]; }
/** Holds inlines, like a paragraph does. */
export interface MdTableCell { type: 'table_cell'; children: MdInline[]; }

export interface MdText { type: 'text'; value: string; }
export interface MdSoftBreak { type: 'softbreak'; }
export interface MdHardBreak { type: 'linebreak'; }
export interface MdEmph { type: 'emph'; children: MdInline[]; }
export interface MdStrong { type: 'strong'; children: MdInline[]; }
export interface MdCode { type: 'code'; value: string; }
/** GFM strikethrough. Wraps inlines exactly as emph and strong do. */
export interface MdStrikethrough { type: 'strikethrough'; children: MdInline[]; }
/** Inline and reference links are indistinguishable here: both carry a resolved
 *  destination and title, which is what gl6o.3 wants. */
export interface MdLink { type: 'link'; destination: string; title: string; children: MdInline[]; }
export interface MdImage { type: 'image'; destination: string; title: string; children: MdInline[]; }
export interface MdHtmlInline { type: 'html_inline'; literal: string; }

export type MdBlock =
  | MdDocument | MdBlockQuote | MdList | MdItem
  | MdParagraph | MdHeading | MdThematicBreak | MdCodeBlock | MdHtmlBlock
  | MdTable | MdTableRow | MdTableCell;

export type MdInline =
  | MdText | MdSoftBreak | MdHardBreak
  | MdEmph | MdStrong | MdCode | MdLink | MdImage | MdHtmlInline
  | MdStrikethrough;

export type MdNode = MdBlock | MdInline;

const BLOCK_TYPES = new Set<string>([
  'document', 'block_quote', 'list', 'item',
  'paragraph', 'heading', 'thematic_break', 'code_block', 'html_block',
  'table', 'table_row', 'table_cell',
]);
/** Blocks whose children are themselves blocks. A cell is not one: like a
 *  paragraph, its children are inlines. */
const CONTAINER_TYPES = new Set<string>([
  'document', 'block_quote', 'list', 'item', 'table', 'table_row',
]);

export function isMdBlock(n: { type: string }): n is MdBlock { return BLOCK_TYPES.has(n.type); }
export function isMdInline(n: { type: string }): n is MdInline { return !BLOCK_TYPES.has(n.type); }
export function isMdContainer(n: { type: string }): boolean { return CONTAINER_TYPES.has(n.type); }
