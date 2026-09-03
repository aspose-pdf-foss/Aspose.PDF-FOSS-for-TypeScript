/** The Markdown AST to a flat list of Flow elements.
 *
 *  This module owns the MAPPING and nothing else: it knows about columns,
 *  rects and pagination not at all. Both consumers — Flow's column engine and
 *  flowplace.ts's rect placer — take the `FlowElement[]` it returns, which is
 *  what makes three entry points cost one implementation.
 *
 *  Nothing here throws on document content. Every string is a valid CommonMark
 *  document (see markdown.ts), so damage shows up as literal text; the only
 *  TypeErrors come from the caller's own options. */

import { parseMarkdown, type MarkdownOptions } from './markdown.js';
import type {
  MdBlock, MdCodeBlock, MdDocument, MdHeading, MdImage, MdInline, MdItem, MdList, MdParagraph,
  MdTable,
} from './mdast.js';
import type { FlowElement } from './flowelement.js';
import {
  paragraph, heading, list, image, type FlowListItem, type FlowListNode,
} from './flow.js';
import { codeBlock, quote, rule } from './flowblock.js';
import type { Undrawable } from './textcoverage.js';
import { table } from './flowtable.js';
import { createTable, type TableBuilder } from './tableauthor.js';
import { inlineRuns, plainText } from './mdruns.js';
import { decodeDataUri } from './datauri.js';
import { resolveMarkdownStyle, type MarkdownStyle, type ResolvedMarkdownStyle } from './mdstyle.js';

/** Options for the Markdown entry points. Extends {@link MarkdownOptions}, so
 *  `{ gfm: true }` reaches the parser unchanged. */
export interface MarkdownFlowOptions extends MarkdownOptions {
  /** How it renders. Every field optional; see {@link MarkdownStyle}. */
  style?: MarkdownStyle;
  /** Supply the bytes for an image destination. `data:` URIs are decoded
   *  without it, since that needs no I/O and this library's core never touches
   *  `fs`. Return `undefined` for a destination you cannot resolve: the image
   *  falls back to its alt text and names itself in `skipped`. */
  resolveImage?: (destination: string, title: string) => Uint8Array | undefined;
}

/** What a Markdown entry point reports. */
export interface MarkdownResult {
  /** Every construct that did not render, in document order: `'table'`,
   *  `'html_block'`, `'html_inline'`, `'image:<destination>'`. Without this a
   *  caller cannot distinguish a dropped table from an empty document. */
  skipped: string[];
}

/** What {@link Page.AddMarkdown} reports. */
export interface AddMarkdownResult extends MarkdownResult {
  /** Vertical space consumed, from the rect's top edge. */
  usedHeight: number;
  /** Elements that did not fit, ready to pass to another `AddMarkdown` (via
   *  `placeElements`) — `[]` when everything fit. */
  remainder: FlowElement[];
}

/** What {@link markdownElements} produced. */
export interface MarkdownElements extends MarkdownResult {
  /** The mapped elements, ready for a Flow or for `placeElements`. */
  elements: FlowElement[];
}

/** @internal Everything the per-node builders need. */
interface Ctx {
  st: ResolvedMarkdownStyle;
  opts: MarkdownFlowOptions;
  skipped: string[];
}

/** The Markdown presentation of an undrawable block. `skipped` is a flat
 *  string list by decision (zch2.7 kept it that way), so the dropped/degraded
 *  distinction becomes two strings rather than a `kind` field. */
function undrawableSink(c: Ctx): (u: Undrawable) => void {
  return (u) => { c.skipped.push(u.all ? 'text' : 'text:partial'); };
}

/** The single image a paragraph consists of, ignoring surrounding whitespace and
 *  soft breaks; undefined for a paragraph that holds anything else. This is the
 *  shape every Markdown author means as a figure. */
function loneImage(children: MdInline[]): MdImage | undefined {
  const meaningful = children.filter((n) =>
    n.type !== 'softbreak' && !(n.type === 'text' && n.value.trim() === ''));
  return meaningful.length === 1 && meaningful[0].type === 'image'
    ? meaningful[0] : undefined;
}

/** An image block for `n`, or undefined when its bytes cannot be had or decoded.
 *  Never throws: a figure that will not render must cost its own ink, not the
 *  document. */
function imageElement(n: MdImage, c: Ctx, extraBefore: number): FlowElement[] | undefined {
  const data = decodeDataUri(n.destination)
    ?? c.opts.resolveImage?.(n.destination, n.title);
  if (data === undefined) return undefined;
  const alt = plainText(n.children);
  try {
    return image(data, {
      align: c.st.image.align,
      alt: alt === '' ? undefined : alt,
      spaceBefore: c.st.image.spaceBefore + extraBefore,
      spaceAfter: c.st.image.spaceAfter + c.st.paragraphSpacing,
    });
  } catch {
    // buildImageXObject rejects anything that is not JPEG or PNG.
    return undefined;
  }
}

function paragraphElements(n: MdParagraph, c: Ctx, extraBefore: number): FlowElement[] {
  const img = loneImage(n.children);
  if (img !== undefined) {
    const els = imageElement(img, c, extraBefore);
    if (els !== undefined) return els;
    // Unresolvable: report it once HERE and render the alt text below.
    // inlineRuns would otherwise report the same destination a second time.
    c.skipped.push(`image:${img.destination}`);
    return paragraph(
      inlineRuns(img.children, c.st, { family: c.st.family, fontSize: c.st.fontSize }, c.skipped),
      {
        font: c.st.family.regular, fontSize: c.st.fontSize, color: c.st.color,
        leading: c.st.leading, align: c.st.align,
        spaceBefore: extraBefore, spaceAfter: c.st.paragraphSpacing,
        onUndrawable: undrawableSink(c),
      });
  }
  const runs = inlineRuns(n.children, c.st, { family: c.st.family, fontSize: c.st.fontSize },
    c.skipped);
  return paragraph(runs, {
    font: c.st.family.regular,
    fontSize: c.st.fontSize,
    color: c.st.color,
    leading: c.st.leading,
    align: c.st.align,
    spaceBefore: extraBefore,
    spaceAfter: c.st.paragraphSpacing,
    onUndrawable: undrawableSink(c),
  });
}

function headingElements(n: MdHeading, c: Ctx, extraBefore: number): FlowElement[] {
  const size = c.st.heading.sizes[n.level - 1];
  const runs = inlineRuns(n.children, c.st, { family: c.st.heading.family, fontSize: size },
    c.skipped);
  return heading(n.level, runs, {
    font: c.st.heading.family.regular,
    fontSize: size,
    color: c.st.heading.color,
    align: c.st.align === 'justify' ? 'left' : c.st.align,
    spaceBefore: c.st.heading.spaceBefore + extraBefore,
    spaceAfter: c.st.heading.spaceAfter,
    onUndrawable: undrawableSink(c),
  });
}

function codeElements(n: MdCodeBlock, c: Ctx, extraBefore: number): FlowElement[] {
  // The AST's literal ends with the newline that closed its last line; emitting
  // it would add a blank line at the bottom of every code block.
  const literal = n.literal.endsWith('\n') ? n.literal.slice(0, -1) : n.literal;
  return codeBlock(literal, {
    font: c.st.code.font,
    fontSize: c.st.code.fontSize,
    color: c.st.code.color,
    background: c.st.code.background,
    padding: c.st.code.padding,
    spaceBefore: c.st.code.spaceBefore + extraBefore,
    spaceAfter: c.st.code.spaceAfter + c.st.paragraphSpacing,
    onUndrawable: undrawableSink(c),
  });
}

/** One Markdown item as a Flow list node.
 *
 *  The item's leading paragraph becomes the body text so it shares the marker's
 *  line; everything after it — further paragraphs, a code block, a quote, a
 *  NESTED LIST — becomes `blocks`, placed at the item's own indent under its
 *  `/LBody`. A nested list is not special-cased: it is a block like any other,
 *  so its indent composes with its parent's and its `/L` lands under the parent
 *  item's `/LBody` through the same path. */
function itemNode(item: MdItem, parent: MdList, c: Ctx): FlowListItem {
  const kids = item.children;
  const leading = kids.length > 0 && kids[0].type === 'paragraph'
    ? (kids[0] as MdParagraph) : undefined;
  const text = leading
    ? inlineRuns(leading.children, c.st, { family: c.st.family, fontSize: c.st.fontSize },
      c.skipped)
    : undefined;
  // A loose item opens a gap above its second block; a tight one does not.
  const gap = parent.tight ? 0 : c.st.paragraphSpacing;
  const blocks = blockElements(leading ? kids.slice(1) : kids, c, gap);

  const node: FlowListItem = {};
  // An item with neither text nor blocks (`- ` on its own) still needs a body:
  // an empty run list draws nothing and the engine discards it.
  if (text !== undefined) node.text = text;
  else if (blocks.length === 0) node.text = [];
  if (blocks.length > 0) node.blocks = blocks;
  if (item.checked !== undefined) node.marker = item.checked ? 'checked' : 'checkbox';
  return node;
}

function listElements(n: MdList, c: Ctx, extraBefore: number): FlowElement[] {
  const items: FlowListNode[] = n.children.map((it) => itemNode(it, n, c));
  return list(items, {
    ordered: n.ordered,
    start: n.start,
    bullet: c.st.list.bullet,
    font: c.st.family.regular,
    fontSize: c.st.fontSize,
    color: c.st.color,
    leading: c.st.leading,
    align: c.st.align,
    indent: c.st.list.indent,
    // Tightness is the one mapping decision no HTML rendering can see.
    itemSpacing: n.tight ? c.st.list.itemSpacing : c.st.paragraphSpacing,
    spaceBefore: c.st.list.spaceBefore + extraBefore,
    spaceAfter: c.st.list.spaceAfter + c.st.paragraphSpacing,
    onUndrawable: undrawableSink(c),
  });
}

/** A GFM table as a `TableBuilder`.
 *
 *  Cells go through `inlineRuns`, the same function a paragraph uses, so bold,
 *  code spans, strikethrough and links behave identically inside a cell. A
 *  second inline mapper is how a cell comes to render bold where a paragraph
 *  renders code.
 *
 *  Note what `setRepeatingRowsCount` makes unnecessary: `CellOptions.header`
 *  already defaults to "cells in the repeating-header rows are column headers",
 *  so setting `header: 'column'` here would restate the documented default —
 *  one statement, not two that can drift apart. */
function mdTable(n: MdTable, c: Ctx): TableBuilder {
  const st = c.st.table;
  const border = { width: st.border.thickness, color: st.border.color };
  const t = createTable({
    font: c.st.family.regular,
    fontSize: st.fontSize,
    leading: st.fontSize * 1.2,
    color: c.st.color,
    padding: st.padding,
    border,
    outerBorder: border,
  });
  const body = { family: c.st.family, fontSize: st.fontSize };
  // A header cell selects from the heading family, so its bold face matches
  // every other heading in the document rather than the body's.
  const header = { family: c.st.heading.family, fontSize: st.fontSize };
  let hasHeader = false;
  for (const row of n.children) {
    if (row.header) hasHeader = true;
    const r = t.addRow(undefined, row.header && st.headerBackground !== false
      ? { background: st.headerBackground }
      : {});
    row.children.forEach((cell, i) => {
      r.addCell(inlineRuns(cell.children, c.st, row.header ? header : body, c.skipped),
        { align: n.align[i] ?? 'left' });
    });
  }
  // GFM puts the header at row 0 and nowhere else, so repeating one row is
  // exactly "reprint the header on every continuation".
  if (hasHeader) t.setRepeatingRowsCount(1);
  // GFM declares no column widths, so equal fractions would give a
  // two-character 'Qty' column the same share as a paragraph of description.
  t.autoFitColumns();
  return t;
}

/** Map one block. `extraBefore` is added to the element's own `spaceBefore`,
 *  which is how a loose list item opens a gap above its first extra block.
 *  @internal */
function blockToElements(n: MdBlock, c: Ctx, extraBefore: number): FlowElement[] {
  switch (n.type) {
    case 'paragraph': return paragraphElements(n, c, extraBefore);
    case 'heading': return headingElements(n, c, extraBefore);
    case 'code_block': return codeElements(n, c, extraBefore);
    case 'list': return listElements(n, c, extraBefore);
    case 'thematic_break':
      return rule({
        thickness: c.st.rule.thickness,
        color: c.st.rule.color,
        spaceBefore: c.st.rule.spaceBefore + extraBefore,
        spaceAfter: c.st.rule.spaceAfter,
      });
    case 'block_quote':
      return quote(blockElements(n.children, c, 0), {
        indent: c.st.quote.indent,
        bar: c.st.quote.bar,
        spaceBefore: c.st.quote.spaceBefore + extraBefore,
        spaceAfter: c.st.quote.spaceAfter + c.st.paragraphSpacing,
      });
    case 'table': {
      return table(mdTable(n, c), {
        spaceBefore: c.st.table.spaceBefore + extraBefore,
        spaceAfter: c.st.table.spaceAfter,
        onUndrawable: undrawableSink(c),
      });
    }
    // Raw HTML is out of scope by design (mdast.ts has recorded that since
    // gl6o.1); it names itself rather than vanishing.
    case 'html_block': c.skipped.push('html_block'); return [];
    default: return [];
  }
}

/** Map a run of sibling blocks. `spaceBeforeFirst` applies to the first element
 *  produced, and to nothing else.
 *
 *  NOT exported: its `Ctx` parameter is module-private, and an exported function
 *  naming a private type fails `.d.ts` emit (`npm run build`). @internal */
function blockElements(
  blocks: MdBlock[], c: Ctx, spaceBeforeFirst: number,
): FlowElement[] {
  const out: FlowElement[] = [];
  for (const b of blocks) {
    out.push(...blockToElements(b, c, out.length === 0 ? spaceBeforeFirst : 0));
  }
  return out;
}

/** Lower a Markdown document to Flow elements.
 *
 *  `src` may be source text (parsed here, with `options` forwarded to
 *  `parseMarkdown`) or an already parsed tree, so a caller that wants to inspect
 *  or rewrite the AST first is not forced to re-parse. */
export function markdownElements(
  src: string | MdDocument, options: MarkdownFlowOptions = {},
): MarkdownElements {
  if (options.resolveImage !== undefined && typeof options.resolveImage !== 'function')
    throw new TypeError('resolveImage must be a function');
  // Validate the whole style before building anything, so a rejected call
  // leaves the document byte-identical.
  const st = resolveMarkdownStyle(options.style);
  const doc = typeof src === 'string' ? parseMarkdown(src, options) : src;
  const c: Ctx = { st, opts: options, skipped: [] };
  return { elements: blockElements(doc.children, c, 0), skipped: c.skipped };
}
