import type {
  MdBlock, MdBlockQuote, MdCodeBlock, MdDocument, MdHeading, MdHtmlBlock, MdItem, MdList,
  MdParagraph, MdTable,
} from './mdast.js';
import {
  ASCII_PUNCT, normalizeLabel, scanLinkDestination, scanLinkTitle, unescapeString,
} from './mdscan.js';
import { buildRows, scanDelimiterRow, splitRow } from './mdtable.js';

/** The block phase of the CommonMark parser, per the spec's Appendix A.
 *
 *  Per line: match the already-open blocks from the outside in, try to open new
 *  containers with what remains, then attach the rest to a leaf.
 *
 *  Leaf text is staged raw — a paragraph or heading comes back holding a single
 *  MdText whose value is the unparsed run, which mdinline.ts replaces. */

export interface LinkRef { destination: string; title: string; }
export interface BlockResult { doc: MdDocument; refs: Map<string, LinkRef>; }

/** Past this many nested containers, stop opening new ones and let the line
 *  fall through as text. Markdown is untrusted input and `>>>>>...` recurses;
 *  no spec case nests past ten. */
const MAX_DEPTH = 1000;

const CODE_INDENT = 4;

type Kind =
  | 'document' | 'block_quote' | 'list' | 'item'
  | 'paragraph' | 'heading' | 'code_block' | 'html_block' | 'thematic_break' | 'table';

/** Only these take the generic "attach the remainder" step. Everything else has
 *  already consumed whatever its opening line carried. */
const ACCEPTS_LINES = new Set<Kind>(['paragraph', 'code_block', 'html_block', 'table']);

interface ListData {
  ordered: boolean;
  start: number;
  delimiter: '-' | '+' | '*' | '.' | ')';
  padding: number;
  markerOffset: number;
}

interface Open {
  kind: Kind;
  node: MdBlock;
  parent: Open | undefined;
  children: Open[];
  open: boolean;
  lines: string[];
  startLine: number;
  lastLineBlank: boolean;
  /** Nesting depth, carried rather than walked: recomputing it per line makes
   *  a deeply nested document quadratic. */
  depth: number;
  /** Fenced code state. */
  fenced?: boolean;
  fenceChar?: string;
  fenceLen?: number;
  fenceOffset?: number;
  /** Which of the seven HTML block conditions opened this block. */
  htmlCond?: number;
  /** List and item state. */
  list?: ListData;
  tight?: boolean;
}

const HTML_BLOCK_NAMES = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe',
  'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol',
  'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
]);

const HTML_OPEN: RegExp[] = [
  /^<(?:script|pre|textarea|style)(?:[ \t>]|$)/i,
  /^<!--/,
  /^<\?/,
  /^<![A-Za-z]/,
  /^<!\[CDATA\[/,
  /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/,
];
const HTML_CLOSE: (RegExp | undefined)[] = [
  /<\/(?:script|pre|textarea|style)>/i,
  /-->/,
  /\?>/,
  />/,
  /\]\]>/,
  undefined,
];
const HTML_ATTR = '[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \\t]*=[ \\t]*(?:[^ \\t\\r\\n"\'=<>`]+|\'[^\']*\'|"[^"]*"))?';
const HTML_COND7 = new RegExp(`^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \\t]+${HTML_ATTR})*[ \\t]*\\/?>|</[A-Za-z][A-Za-z0-9-]*[ \\t]*>)[ \\t]*$`);

const THEMATIC = /^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/;
const ATX = /^#{1,6}(?:[ \t]+|$)/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^(?:`{3,}|~{3,})[ \t]*$/;
const SETEXT = /^(=+|-+)[ \t]*$/;
const BULLET = /^[*+-]/;
const ORDERED = /^(\d{1,9})([.)])/;
const NON_SPACE = /[^ \t]/;
/** Characters that can begin a block. A cheap gate: a line starting with
 *  anything else cannot open one, so tryStart is not worth calling. GFM adds
 *  `|` and `:` for a table's delimiter row. */
const MAYBE_START = /^[#`~*+_=<>0-9-]/;
const MAYBE_START_GFM = /^[#`~*+_=<>0-9|:-]/;

function canContain(parent: Kind, child: Kind): boolean {
  if (parent === 'list') return child === 'item';
  if (parent === 'document' || parent === 'block_quote' || parent === 'item') return child !== 'item';
  return false;
}

const isSpaceOrTab = (c: string | undefined): boolean => c === ' ' || c === '\t';

class BlockParser {
  doc: Open;
  tip: Open;
  oldTip: Open;
  refs = new Map<string, LinkRef>();
  /** Whether the GFM extensions are enabled. Off leaves every hook dead. */
  gfm: boolean;

  line = '';
  lineNumber = 0;
  /** Character offset into `line`. */
  pos = 0;
  /** Column, which is not the offset: a tab advances to the next multiple of 4. */
  col = 0;
  /** Set when a tab straddles the cursor and only part of it is consumed. */
  partialTab = false;
  nextNonspace = 0;
  nextNonspaceCol = 0;
  indent = 0;
  indented = false;
  blank = false;
  allClosed = true;
  lastMatched: Open;

  constructor(gfm: boolean) {
    this.gfm = gfm;
    const node: MdDocument = { type: 'document', children: [] };
    this.doc = {
      kind: 'document', node, parent: undefined, children: [], open: true,
      lines: [], startLine: 0, lastLineBlank: false, depth: 0,
    };
    this.tip = this.doc;
    this.oldTip = this.doc;
    this.lastMatched = this.doc;
  }

  // ---- line cursor -------------------------------------------------------

  findNextNonspace(): void {
    let i = this.pos;
    let c = this.col;
    for (;;) {
      const ch = this.line[i];
      if (ch === ' ') { i++; c++; }
      else if (ch === '\t') { i++; c += 4 - (c % 4); }
      else break;
    }
    this.blank = this.line[i] === undefined;
    this.nextNonspace = i;
    this.nextNonspaceCol = c;
    this.indent = c - this.col;
    this.indented = this.indent >= CODE_INDENT;
  }

  /** Advance by `count` characters, or by `count` columns when `cols` is set —
   *  splitting a tab that straddles the boundary, so its remainder survives as
   *  spaces. That split is what the Tabs section tests. */
  advance(count: number, cols: boolean): void {
    let remaining = count;
    while (remaining > 0) {
      const ch = this.line[this.pos];
      if (ch === undefined) break;
      if (ch === '\t') {
        const width = 4 - (this.col % 4);
        if (cols) {
          if (width > remaining) {
            this.partialTab = true;
            this.col += remaining;
            remaining = 0;
          } else {
            this.partialTab = false;
            this.col += width;
            this.pos++;
            remaining -= width;
          }
        } else {
          this.partialTab = false;
          this.pos++;
          this.col += width;
          remaining--;
        }
      } else {
        this.partialTab = false;
        this.pos++;
        this.col++;
        remaining--;
      }
    }
  }

  advanceNextNonspace(): void {
    this.pos = this.nextNonspace;
    this.col = this.nextNonspaceCol;
    this.partialTab = false;
  }

  /** The rest of the line, with a straddled tab's remainder expanded. */
  rest(): string {
    if (!this.partialTab) return this.line.slice(this.pos);
    const width = 4 - (this.col % 4);
    return ' '.repeat(width) + this.line.slice(this.pos + 1);
  }

  // ---- block tree --------------------------------------------------------

  addChild(kind: Kind, node: MdBlock): Open {
    while (!canContain(this.tip.kind, kind)) this.finalize(this.tip);
    const child: Open = {
      kind, node, parent: this.tip, children: [], open: true,
      lines: [], startLine: this.lineNumber, lastLineBlank: false, depth: this.tip.depth + 1,
    };
    this.tip.children.push(child);
    this.tip = child;
    return child;
  }

  closeUnmatched(): void {
    if (this.allClosed) return;
    while (this.oldTip !== this.lastMatched) {
      // Capture the parent first: finalize moves `tip`, not `oldTip`, so
      // failing to walk up here spins forever.
      const parent = this.oldTip.parent;
      this.finalize(this.oldTip);
      if (parent === undefined) break;
      this.oldTip = parent;
    }
    this.allClosed = true;
  }

  finalize(block: Open): void {
    const above = block.parent;
    block.open = false;

    switch (block.kind) {
      case 'paragraph': {
        const raw = this.stripRefs(block.lines.join('\n'));
        stageText(block.node as MdParagraph, raw);
        break;
      }
      case 'heading':
        stageText(block.node as MdHeading, block.lines.join('\n'));
        break;
      case 'code_block': {
        const n = block.node as MdCodeBlock;
        if (block.fenced === true) {
          // The first content line is the info string, per Appendix A.
          const content = block.lines.length === 0 ? '' : `${block.lines.join('\n')}\n`;
          const nl = content.indexOf('\n');
          n.info = unescapeString(content.slice(0, nl < 0 ? content.length : nl).trim());
          n.literal = nl < 0 ? '' : content.slice(nl + 1);
        } else {
          const lines = block.lines.slice();
          while (lines.length > 0 && !NON_SPACE.test(lines[lines.length - 1])) lines.pop();
          n.literal = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
        }
        break;
      }
      case 'html_block':
        (block.node as MdHtmlBlock).literal = `${block.lines.join('\n')}\n`;
        break;
      case 'list':
        (block.node as MdList).tight = computeTight(block);
        break;
      case 'item':
        if (this.gfm) applyTaskMarker(block);
        break;
      case 'table': {
        const n = block.node as MdTable;
        // The opening line contributes an empty string: 'table' is in
        // ACCEPTS_LINES, so incorporateLine attaches the remainder of the
        // delimiter row — which tryStart has already consumed — as a line. A
        // blank line closes the table rather than joining it, so this filter can
        // only ever drop that artifact.
        n.children = buildRows(block.lines.filter((l) => NON_SPACE.test(l)), n.align.length);
        break;
      }
      default:
        break;
    }

    if (above !== undefined) this.tip = above;
  }

  /** Consume link reference definitions off the front of a paragraph. Returns
   *  what is left, which may be empty — in which case `assemble` drops the
   *  paragraph entirely. */
  stripRefs(raw: string): string {
    let s = raw;
    while (s[0] === '[') {
      const n = parseReference(s, this.refs);
      if (n === 0) break;
      s = s.slice(n);
    }
    return s;
  }

  // ---- the per-line algorithm -------------------------------------------

  incorporateLine(line: string): void {
    this.line = line;
    this.lineNumber++;
    this.pos = 0;
    this.col = 0;
    this.partialTab = false;
    this.oldTip = this.tip;

    let container = this.doc;

    // 1. Match already-open blocks, outermost first.
    for (;;) {
      const child = lastChild(container);
      if (child === undefined || !child.open) break;
      container = child;
      this.findNextNonspace();
      const r = this.matchContinuation(container);
      if (r === 'done') return;
      if (r === 'closed') { container = container.parent!; break; }
    }

    this.allClosed = container === this.oldTip;
    this.lastMatched = container;

    // A table takes lines like a paragraph does, but must still let a new block
    // start on the next line — `# x` after a table is a heading, not a row.
    let matchedLeaf = container.kind !== 'paragraph' && container.kind !== 'table'
      && ACCEPTS_LINES.has(container.kind);

    // 2. Try new block starts.
    while (!matchedLeaf) {
      this.findNextNonspace();
      const maybeStart = this.gfm ? MAYBE_START_GFM : MAYBE_START;
      if (!this.indented && !maybeStart.test(this.line.slice(this.nextNonspace))) {
        this.advanceNextNonspace();
        break;
      }
      if (this.tip.depth > MAX_DEPTH) { this.advanceNextNonspace(); break; }
      const started = this.tryStart(container);
      if (started === undefined) { this.advanceNextNonspace(); break; }
      container = started.block;
      if (started.leaf) { matchedLeaf = true; break; }
    }

    // 3. Attach the remainder.
    if (!this.allClosed && !this.blank && this.tip.kind === 'paragraph') {
      // Lazy continuation: a paragraph line needs no container prefix at all.
      this.addLine();
      return;
    }

    this.closeUnmatched();

    // The block that just closed on this blank line also ends with one. Without
    // this, a blank line BETWEEN two blocks inside one list item is invisible
    // and the list is wrongly called tight.
    if (this.blank) {
      const kid = lastChild(container);
      if (kid !== undefined) kid.lastLineBlank = true;
    }

    // A blank line is remembered so that list tightness can be decided later.
    const lastLineBlank = this.blank && !(
      container.kind === 'block_quote'
      || (container.kind === 'code_block' && container.fenced === true)
      || (container.kind === 'item' && container.children.length === 0 && container.startLine === this.lineNumber)
    );
    for (let b: Open | undefined = container; b !== undefined; b = b.parent) b.lastLineBlank = lastLineBlank;

    if (ACCEPTS_LINES.has(container.kind)) {
      this.tip = container;
      this.addLine();
      if (container.kind === 'html_block' && (container.htmlCond ?? 7) <= 5) {
        const close = HTML_CLOSE[(container.htmlCond ?? 1) - 1];
        if (close !== undefined && close.test(this.rest())) this.finalize(container);
      }
      return;
    }
    // Nothing left on the line — an ATX heading, setext underline or thematic
    // break consumed it all. Testing `blank` here instead invents a paragraph
    // after every one of them.
    if (this.pos >= this.line.length || this.blank) return;

    const node: MdParagraph = { type: 'paragraph', children: [] };
    const p = this.addChild('paragraph', node);
    this.advanceNextNonspace();
    p.lines.push(this.rest());
  }

  addLine(): void {
    this.tip.lines.push(this.rest());
  }

  /** Whether `block` continues on this line, advancing the cursor past its own
   *  prefix when it does. */
  matchContinuation(block: Open): 'matched' | 'closed' | 'done' {
    switch (block.kind) {
      // Only a blank line ends a table from here; another block start is handled
      // by the matchedLeaf test in incorporateLine.
      case 'table':
        return this.blank ? 'closed' : 'matched';
      case 'document':
      case 'list':
        return 'matched';

      case 'block_quote': {
        if (this.indented || this.line[this.nextNonspace] !== '>') return 'closed';
        this.advanceNextNonspace();
        this.advance(1, false);
        if (isSpaceOrTab(this.line[this.pos])) this.advance(1, true);
        return 'matched';
      }

      case 'item': {
        const data = block.list!;
        if (this.blank) {
          if (block.children.length === 0) return 'closed';
          this.advanceNextNonspace();
          return 'matched';
        }
        if (this.indent >= data.markerOffset + data.padding) {
          this.advance(data.markerOffset + data.padding, true);
          return 'matched';
        }
        return 'closed';
      }

      case 'paragraph':
        return this.blank ? 'closed' : 'matched';

      case 'heading':
      case 'thematic_break':
        return 'closed';

      case 'code_block': {
        if (block.fenced === true) {
          const rest = this.line.slice(this.nextNonspace);
          if (!this.indented && rest[0] === block.fenceChar && CLOSING_FENCE.test(rest)
              && rest.replace(/[ \t]+$/, '').length >= (block.fenceLen ?? 3)) {
            // The closing fence consumes the whole line and produces nothing.
            this.finalize(block);
            return 'done';
          }
          let skip = block.fenceOffset ?? 0;
          while (skip > 0 && isSpaceOrTab(this.line[this.pos])) { this.advance(1, true); skip--; }
          return 'matched';
        }
        if (this.indent >= CODE_INDENT) { this.advance(CODE_INDENT, true); return 'matched'; }
        if (this.blank) { this.advanceNextNonspace(); return 'matched'; }
        return 'closed';
      }

      case 'html_block':
        return this.blank && ((block.htmlCond ?? 7) === 6 || (block.htmlCond ?? 7) === 7)
          ? 'closed' : 'matched';
    }
  }

  /** Try to open a new block at the current position. */
  tryStart(container: Open): { block: Open; leaf: boolean } | undefined {
    this.findNextNonspace();
    const rest = this.line.slice(this.nextNonspace);

    // Block quote
    if (!this.indented && rest[0] === '>') {
      this.advanceNextNonspace();
      this.advance(1, false);
      if (isSpaceOrTab(this.line[this.pos])) this.advance(1, true);
      this.closeUnmatched();
      const node: MdBlockQuote = { type: 'block_quote', children: [] };
      return { block: this.addChild('block_quote', node), leaf: false };
    }

    if (!this.indented) {
      // ATX heading
      const atx = ATX.exec(rest);
      if (atx !== null) {
        this.advanceNextNonspace();
        this.advance(atx[0].length, false);
        this.closeUnmatched();
        const node: MdHeading = { type: 'heading', level: atx[0].trim().length, children: [] };
        const h = this.addChild('heading', node);
        h.lines.push(stripAtxClose(rest.slice(atx[0].length)));
        this.advance(this.line.length - this.pos, false);
        return { block: h, leaf: true };
      }

      // Fenced code block
      const fence = FENCE.exec(rest);
      if (fence !== null && (fence[1][0] !== '`' || !fence[2].includes('`'))) {
        const indent = this.indent;
        this.advanceNextNonspace();
        this.advance(fence[1].length, false);
        this.closeUnmatched();
        const node: MdCodeBlock = { type: 'code_block', fenced: true, info: '', literal: '' };
        const c = this.addChild('code_block', node);
        c.fenced = true;
        c.fenceChar = fence[1][0];
        c.fenceLen = fence[1].length;
        c.fenceOffset = indent;
        return { block: c, leaf: true };
      }

      // HTML block
      for (let cond = 1; cond <= 7; cond++) {
        if (!this.htmlStarts(rest, cond, container)) continue;
        this.closeUnmatched();
        const node: MdHtmlBlock = { type: 'html_block', literal: '' };
        const h = this.addChild('html_block', node);
        h.htmlCond = cond;
        return { block: h, leaf: true };
      }

      // Setext heading underline
      const setext = SETEXT.exec(rest);
      if (setext !== null && container.kind === 'paragraph') {
        this.closeUnmatched();
        // Reference definitions resolve BEFORE the promotion: a paragraph that
        // is nothing but definitions leaves no heading, and the underline falls
        // through to become ordinary text.
        const content = this.stripRefs(container.lines.join('\n'));
        if (content === '') return undefined;
        const node: MdHeading = { type: 'heading', level: setext[1][0] === '=' ? 1 : 2, children: [] };
        const h: Open = {
          kind: 'heading', node, parent: container.parent, children: [], open: false,
          lines: [content], startLine: container.startLine, lastLineBlank: false, depth: container.depth,
        };
        replaceChild(container, h);
        this.tip = h;
        this.finalize(h);
        this.advance(this.line.length - this.pos, false);
        return { block: h, leaf: true };
      }

      // GFM table. Structurally the same move as the setext heading above: the
      // open paragraph's last line is the header, and the paragraph is replaced
      // by the table. Any earlier paragraph lines stay behind as a paragraph.
      //
      // It sits after setext for reading order, not for correctness: what keeps
      // `foo\n---` a heading is scanDelimiterRow's pipe requirement, and with
      // that in place the two branches are disjoint in either order (measured —
      // moving this above setext leaves all 652 CommonMark cases green). Drop
      // the pipe requirement and the ordering becomes load-bearing, silently.
      if (this.gfm && container.kind === 'paragraph') {
        const align = scanDelimiterRow(rest);
        const header = container.lines[container.lines.length - 1];
        if (align !== undefined && header !== undefined && splitRow(header).length === align.length) {
          this.closeUnmatched();
          const node: MdTable = { type: 'table', align, children: [] };
          const t: Open = {
            kind: 'table', node, parent: container.parent, children: [], open: true,
            lines: [header], startLine: container.startLine, lastLineBlank: false,
            depth: container.depth,
          };
          const above = container.lines.slice(0, -1);
          if (above.length > 0) {
            // The lead-in paragraph keeps its own Open and the table becomes its
            // next sibling, so the two arrive in source order.
            container.lines = above;
            this.tip = container;
            this.finalize(container);
            container.parent?.children.push(t);
          } else {
            replaceChild(container, t);
          }
          this.tip = t;
          this.advance(this.line.length - this.pos, false);
          return { block: t, leaf: true };
        }
      }

      // Thematic break
      if (THEMATIC.test(rest)) {
        this.closeUnmatched();
        const t = this.addChild('thematic_break', { type: 'thematic_break' });
        this.finalize(t);
        this.advance(this.line.length - this.pos, false);
        return { block: t, leaf: true };
      }
    }

    // List item
    if (!this.indented || container.kind === 'list') {
      const data = this.parseListMarker(container);
      if (data !== undefined) {
        this.closeUnmatched();
        let list = container;
        if (this.tip.kind !== 'list' || !listsMatch(this.tip.list, data)) {
          const node: MdList = {
            type: 'list', ordered: data.ordered, start: data.start,
            delimiter: data.delimiter, tight: true, children: [],
          };
          list = this.addChild('list', node);
          list.list = data;
        }
        const item = this.addChild('item', { type: 'item', children: [] });
        item.list = data;
        return { block: item, leaf: false };
      }
    }

    // Indented code block
    if (this.indented && this.tip.kind !== 'paragraph' && !this.blank) {
      this.advance(CODE_INDENT, true);
      this.closeUnmatched();
      const node: MdCodeBlock = { type: 'code_block', fenced: false, info: '', literal: '' };
      const c = this.addChild('code_block', node);
      c.fenced = false;
      return { block: c, leaf: true };
    }

    return undefined;
  }

  htmlStarts(rest: string, cond: number, container: Open): boolean {
    if (cond === 7) {
      // Condition 7 cannot interrupt a paragraph.
      if (container.kind === 'paragraph') return false;
      return HTML_COND7.test(rest);
    }
    if (!HTML_OPEN[cond - 1].test(rest)) return false;
    if (cond === 6) {
      const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
      if (m === null || !HTML_BLOCK_NAMES.has(m[1].toLowerCase())) return false;
    }
    return true;
  }

  parseListMarker(container: Open): ListData | undefined {
    if (this.indent >= CODE_INDENT) return undefined;
    const rest = this.line.slice(this.nextNonspace);
    let markerLen: number;
    let data: ListData;

    const bullet = BULLET.exec(rest);
    const ordered = ORDERED.exec(rest);
    if (bullet !== null) {
      markerLen = 1;
      data = {
        ordered: false, start: 1, delimiter: bullet[0] as '-' | '+' | '*',
        padding: 0, markerOffset: this.indent,
      };
    } else if (ordered !== null && (container.kind !== 'paragraph' || ordered[1] === '1')) {
      markerLen = ordered[0].length;
      data = {
        ordered: true, start: parseInt(ordered[1], 10), delimiter: ordered[2] as '.' | ')',
        padding: 0, markerOffset: this.indent,
      };
    } else {
      return undefined;
    }

    // A marker must be followed by whitespace or end of line.
    const after = this.line[this.nextNonspace + markerLen];
    if (after !== undefined && after !== ' ' && after !== '\t') return undefined;
    // Interrupting a paragraph requires a non-blank first line.
    if (container.kind === 'paragraph' && !NON_SPACE.test(this.line.slice(this.nextNonspace + markerLen))) {
      return undefined;
    }

    this.advanceNextNonspace();
    this.advance(markerLen, true);
    const spacesStartCol = this.col;
    const spacesStartPos = this.pos;
    do {
      this.advance(1, true);
    } while (this.col - spacesStartCol < 5 && isSpaceOrTab(this.line[this.pos]));

    const blankItem = this.line[this.pos] === undefined;
    const spacesAfter = this.col - spacesStartCol;
    if (spacesAfter >= 5 || spacesAfter < 1 || blankItem) {
      data.padding = markerLen + 1;
      this.col = spacesStartCol;
      this.pos = spacesStartPos;
      this.partialTab = false;
      if (isSpaceOrTab(this.line[this.pos])) this.advance(1, true);
    } else {
      data.padding = markerLen + spacesAfter;
    }
    return data;
  }

  finish(): BlockResult {
    while (this.tip !== this.doc) this.finalize(this.tip);
    this.finalize(this.doc);
    assemble(this.doc);
    return { doc: this.doc.node as MdDocument, refs: this.refs };
  }
}

// ---- helpers -------------------------------------------------------------

function lastChild(b: Open): Open | undefined {
  return b.children.length === 0 ? undefined : b.children[b.children.length - 1];
}

function replaceChild(oldChild: Open, newChild: Open): void {
  const parent = oldChild.parent;
  if (parent === undefined) return;
  const i = parent.children.indexOf(oldChild);
  if (i >= 0) parent.children[i] = newChild;
}

function listsMatch(a: ListData | undefined, b: ListData): boolean {
  return a !== undefined && a.ordered === b.ordered && a.delimiter === b.delimiter;
}

function endsWithBlankLine(b: Open): boolean {
  if (b.lastLineBlank) return true;
  if (b.kind !== 'list' && b.kind !== 'item') return false;
  const last = lastChild(b);
  return last !== undefined && endsWithBlankLine(last);
}

/** A list is loose if a blank line separates two of its items, or falls between
 *  two blocks inside one item. A trailing blank line before the list ends does
 *  not count. */
function computeTight(list: Open): boolean {
  for (let i = 0; i < list.children.length; i++) {
    const item = list.children[i];
    const hasNextItem = i < list.children.length - 1;
    if (endsWithBlankLine(item) && hasNextItem) return false;
    for (let j = 0; j < item.children.length; j++) {
      const sub = item.children[j];
      if (endsWithBlankLine(sub) && (hasNextItem || j < item.children.length - 1)) return false;
    }
  }
  return true;
}

/** A bracketed label, with escapes preserved. Undefined when it is unclosed,
 *  contains an unescaped '[', or is longer than the spec's 999-character cap. */
function scanLabel(s: string, i: number): { raw: string; end: number } | undefined {
  if (s[i] !== '[') return undefined;
  let j = i + 1;
  let raw = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && ASCII_PUNCT.includes(s[j + 1] ?? '')) { raw += c + s[j + 1]; j += 2; continue; }
    if (c === ']') return raw.length > 999 ? undefined : { raw, end: j + 1 };
    if (c === '[') return undefined;
    raw += c;
    j++;
  }
  return undefined;
}

/** Skip spaces and tabs, then at most one newline, then spaces and tabs again.
 *  Returns -1 when a second newline is reached — a definition may not span a
 *  blank line. */
function skipSpaceOneNewline(s: string, i: number): number {
  let j = i;
  let newlines = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === ' ' || c === '\t') { j++; continue; }
    if (c === '\n') { if (++newlines > 1) return -1; j++; continue; }
    break;
  }
  return j;
}

/** Try to read one link reference definition off the front of `s`. Returns the
 *  number of characters consumed, or 0.
 *
 *  The first definition of a label wins; a later one with the same normalized
 *  label is discarded rather than overwriting. */
function parseReference(s: string, refs: Map<string, LinkRef>): number {
  const label = scanLabel(s, 0);
  if (label === undefined || s[label.end] !== ':') return 0;

  let i = skipSpaceOneNewline(s, label.end + 1);
  if (i < 0) return 0;
  const dest = scanLinkDestination(s, i);
  if (dest === undefined) return 0;
  const afterDest = dest.end;

  // A title is part of the definition only when nothing but whitespace follows
  // it on its line; otherwise the definition ends at the destination.
  let title = '';
  let end = -1;
  const beforeTitle = skipSpaceOneNewline(s, afterDest);
  if (beforeTitle > afterDest) {
    const t = scanLinkTitle(s, beforeTitle);
    if (t !== undefined) {
      let k = t.end;
      while (s[k] === ' ' || s[k] === '\t') k++;
      if (k >= s.length || s[k] === '\n') { title = t.title; end = k; }
    }
  }
  if (end < 0) {
    let k = afterDest;
    while (s[k] === ' ' || s[k] === '\t') k++;
    if (k < s.length && s[k] !== '\n') return 0;
    end = k;
  }
  if (s[end] === '\n') end++;

  const key = normalizeLabel(label.raw);
  if (key === '') return 0;
  if (!refs.has(key)) refs.set(key, { destination: dest.dest, title });
  return end;
}

/** Stage a leaf's raw text as a single text node for the inline phase. */
function stageText(node: MdParagraph | MdHeading, raw: string): void {
  node.children = raw === '' ? [] : [{ type: 'text', value: raw }];
}

/** GFM task list items.
 *
 *  The marker is `[ ]`, `[x]` or `[X]` at the very start of the item's first
 *  paragraph, followed by at least one space or tab. It is stripped from the
 *  content and recorded on the node, so no consumer has to know the syntax —
 *  and so a renderer cannot accidentally draw the brackets.
 *
 *  Runs at item finalize, by which point the paragraph has already been
 *  finalized and staged: finalize always walks inner blocks first.
 *
 *  Note `[X]`: cmark-gfm's own scanner matches only the lowercase form, but the
 *  spec's prose says "either lowercase or uppercase" and its own strstr check
 *  looks for both. The prose wins; the two examples use neither. */
const TASK_MARKER = /^\[([ xX])\][ \t\v\f]+/;

function applyTaskMarker(item: Open): void {
  const first = item.children[0];
  if (first === undefined || first.kind !== 'paragraph') return;
  const p = first.node as MdParagraph;
  const raw = p.children.length === 1 && p.children[0].type === 'text' ? p.children[0].value : '';
  const m = TASK_MARKER.exec(raw);
  if (m === null) return;
  (item.node as MdItem).checked = m[1] !== ' ';
  // An item that was nothing but a marker leaves an empty paragraph, which
  // assemble() then drops.
  stageText(p, raw.slice(m[0].length));
}

/** Strip an ATX heading's optional closing run of '#'. */
function stripAtxClose(s: string): string {
  const t = s.replace(/[ \t]+$/, '');
  const m = /(^|[ \t])#+$/.exec(t);
  if (m === null) return t.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return t.slice(0, m.index).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Copy the Open tree's shape onto the AST nodes, dropping emptied paragraphs. */
function assemble(b: Open): MdBlock[] {
  const kids: MdBlock[] = [];
  for (const c of b.children) {
    const inner = assemble(c);
    if (c.kind === 'paragraph' && (c.node as MdParagraph).children.length === 0) continue;
    switch (c.node.type) {
      case 'document':
      case 'block_quote':
      case 'item':
        c.node.children = inner;
        break;
      case 'list':
        c.node.children = inner as MdItem[];
        break;
      default:
        break;
    }
    kids.push(c.node);
  }
  if (b.node.type === 'document') b.node.children = kids;
  return kids;
}

/** Parse `lines` (already newline-normalized and NUL-scrubbed) into blocks. */
export function parseBlocks(lines: string[], gfm = false): BlockResult {
  const p = new BlockParser(gfm);
  for (const line of lines) p.incorporateLine(line);
  return p.finish();
}
