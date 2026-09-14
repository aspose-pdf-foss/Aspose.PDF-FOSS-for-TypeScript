import type { Document } from './document.js';
import type { Page } from './page.js';
import { mapRegions, visitContent, type Rect, type TextBlock, type TextLine } from './text.js';

/** Every walk in this module reads what the document SHOWS: a serializer is
 *  producing a readable document, so content on a switched-off layer belongs in
 *  it no more than it belongs in `GetText`. Spelled once here so the four
 *  exports built on this model — HTML, Markdown, DOCX, EPUB — cannot disagree
 *  about it page by page. */
const SHOWN = { skipHidden: true } as const;
import { isDict, type PdfStream } from './types.js';
import { parseAction } from './actions.js';
import type { Table } from './tablemodel.js';
import { dominantFragmentSize, headingRanks } from './textrank.js';
import { StructElement, StructTreeRoot, type StructNode, type StructTextNode } from './struct.js';
import { tableFromStruct } from './tablestruct.js';
import {
  classifyBlock, pageMetrics, parseMarkerText, splitLineLinks,
  type ClassifyContext, type LineClass, type LineSegment, type LinkSpan, type Marker,
} from './docinfer.js';

/** A reconstructed document as a tree of PDF standard structure types.
 *
 *  Deliberately NOT an HTML or Markdown tree: it names structure types
 *  ('H1', 'P', 'Span', ...) so no serializer is privileged, and so the untagged
 *  builder's output is indistinguishable in shape from the tagged one. */
export type DocNode = DocContainer | DocText | DocTable | DocFigure | DocList | DocListItem | DocCode;

/** A structure element. `type` is the resolved standard type; unknown types are
 *  kept verbatim so a serializer can decide what to do with them.
 *
 *  `href` is set only on a `Link`, and only for an external destination. It is a
 *  field rather than a node kind of its own because `/Link` IS a standard type —
 *  the same reason `/BlockQuote` earned no kind. A destination is an attribute
 *  of the element, exactly as `lang` is. */
export interface DocContainer {
  kind: 'container'; type: string; lang?: string; href?: string; children: DocNode[];
}
/** A run of text, decoded and UNESCAPED — escaping is a serializer concern, and
 *  the serializers escape differently.
 *
 *  `bold`/`italic` are DERIVED from the producing font (see `fontStyleOf`), not
 *  declared by the PDF: a PDF records a face, not an emphasis. Absent rather
 *  than false.
 *
 *  Read by ALL THREE serializers since `c3t7.8`: `docxflow.ts` as `w:b`/`w:i`,
 *  `htmlsemantic.ts` as `<b>`/`<i>`, and `mdexport.ts` as `*`/`**`. Note the
 *  Markdown path reads them INDIRECTLY, through `emphasizeMarkdown(text, node)`
 *  in `mdescape.ts` — a grep for `.bold` in `mdexport.ts` finds nothing, which
 *  is how this comment came to claim `docxflow.ts` read them alone. */
export interface DocText {
  kind: 'text'; text: string; bold?: boolean; italic?: boolean;
  /** Sub/superscript, derived from the run's size and baseline against its
   *  line (see `markScriptLevel`). Read by all three serializers like the
   *  emphasis flags, and absent rather than false. */
  script?: 'sub' | 'super';
}

/** A text node for one style run; the flags are omitted when false. */
function docText(
  text: string, style: { bold?: boolean; italic?: boolean; script?: 'sub' | 'super' },
): DocText {
  return {
    kind: 'text', text,
    ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}),
    ...(style.script ? { script: style.script } : {}),
  };
}
/** The Table model object, not markup: each serializer calls its own emitter. */
export interface DocTable { kind: 'table'; table: Table }
/** Image streams, not data: URIs, so a file-writing serializer needs no re-derivation.
 *
 *  `tagged` records provenance because the two paths legitimately differ when an
 *  image cannot be encoded: a tagged /Figure still announces itself through its
 *  /Alt, while an untagged bare page image has no alt and so nothing to announce. */
export interface DocFigure {
  kind: 'figure'; alt: string; images: PdfStream[];
  /** Each image's DRAWN size in points, parallel to `images`.
   *
   *  **Invariant:** the same length as `images` whenever present, and an entry
   *  whose size could not be determined is `{ width: 0, height: 0 }` rather than
   *  omitted — omitting it shifts every later index and silently mis-sizes the
   *  rest of a composite figure.
   *
   *  **Invariant:** the DRAWN size, not the pixel count. A producer that placed
   *  a 2400px scan two inches wide said what it meant; reading the pixels as
   *  96 DPI arrives at 25 inches. */
  sizes?: { width: number; height: number }[];
  tagged: boolean;
}

/** One image as it was actually placed on a page. */
interface PlacedImage { stream: PdfStream; width: number; height: number }

/** The drawn box of an image event, in points. */
function placedSize(quad: [number, number, number, number]): { width: number; height: number } {
  return { width: Math.abs(quad[2] - quad[0]), height: Math.abs(quad[3] - quad[1]) };
}

/** A list. `ordered` and `start` are decisions rather than structure types,
 *  which is why this is a kind of its own: the model otherwise speaks only
 *  standard types, and no type records whether a list is numbered. */
export interface DocList { kind: 'list'; ordered: boolean; start?: number; items: DocListItem[] }
/** One item. `blocks` are block-level nodes, so a nested list is just a block. */
export interface DocListItem { kind: 'listItem'; blocks: DocNode[]; checked?: boolean }
/** Preformatted text, newline-separated, unescaped and unfenced. */
export interface DocCode { kind: 'code'; text: string }

/** Every text node under `nodes`, depth first. */
function textNodesUnder(nodes: DocNode[], out: DocText[] = []): DocText[] {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n);
    else if (n.kind === 'container') textNodesUnder(n.children, out);
    else if (n.kind === 'listItem') textNodesUnder(n.blocks, out);
  }
  return out;
}

/** `node` with `bold` removed from every text run beneath it. */
function withoutBold(node: DocNode): DocNode {
  if (node.kind === 'text') {
    if (!node.bold) return node;
    const { bold, ...rest } = node;
    return rest;
  }
  if (node.kind === 'container') return { ...node, children: node.children.map(withoutBold) };
  if (node.kind === 'listItem') return { ...node, blocks: node.blocks.map(withoutBold) };
  return node;
}

/** True when two text runs would emit identical markup. */
function sameStyle(a: DocText, b: DocText): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.script === b.script;
}

/** Adjacent text siblings sharing a style, merged into one run. */
function mergeAdjacentText(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.kind === 'text' && prev !== undefined && prev.kind === 'text' && sameStyle(prev, n)) {
      out[out.length - 1] = { ...prev, text: prev.text + n.text };
      continue;
    }
    out.push(n);
  }
  return out;
}

const HEADING = /^H[1-6]$/;

/**
 * A container's children, prepared for an inline serializer. Two rules, in one
 * place so `htmlsemantic.ts` and `mdexport.ts` cannot drift on either.
 *
 * **Invariant:** adjacent text siblings sharing `(bold, italic, script)` are
 * MERGED, and that is required rather than tidy. `struct.ts` splits a run per
 * MCID and per style, so adjacent same-style siblings are the normal case — and
 * two bold runs emitted separately give Markdown `**a****b**`, a four-asterisk
 * delimiter run that does not reparse as two strong spans.
 *
 * **Invariant:** a heading's UNIFORM bold is dropped, throughout its subtree.
 * That is the heading's baseline typography rather than an inline distinction,
 * and both formats already render headings bold themselves; without it our own
 * `# Title` round-trips as `# **Title**`, since `mdstyle.ts` defaults headings
 * to Helvetica-Bold. Narrow in three directions on purpose: headings only (a
 * bold paragraph IS a distinction, and no format supplies it), bold only
 * (nothing supplies a heading's italic), and uniform only (one bold word among
 * plain ones survives).
 *
 * **Invariant:** the builder never calls this. `test/docx-flow-identity.test.ts`
 * pins the sha256 of DOCX flow output and `docxflow.ts` emits one `w:r` per
 * `DocText`, so merging runs in `buildDocModel` would move that hash. These
 * rules are serializer-local by necessity, not by preference.
 */
export function styledChildren(node: DocContainer): DocNode[] {
  let kids = node.children;
  if (HEADING.test(node.type)) {
    const texts = textNodesUnder(kids);
    // `every` is vacuously true on an empty set, so require at least one run.
    if (texts.length > 0 && texts.every((t) => t.bold)) kids = kids.map(withoutBold);
  }
  return mergeAdjacentText(kids);
}

// ---------- tagged: structure-tree driven ----------

function isText(n: StructNode): n is StructTextNode {
  return !(n instanceof StructElement);
}

/** Walk state. `images` memoizes each page's MCID→image map, because a page with
 *  N figures would otherwise re-walk its whole content stream N times. Unlike a
 *  positional pairing this is keyed lookup, so it cannot drift out of step. */
interface Ctx {
  doc: Document;
  only: Page | undefined;
  images: Map<Page, Map<number, PlacedImage[]>>;
}

/** The image XObjects drawn under each MCID on `page`, in content order.
 *  Inline images are absent: their samples live in the content op, not an
 *  object, so there is nothing for a serializer to encode. */
function pageMcidImages(ctx: Ctx, page: Page): Map<number, PlacedImage[]> {
  let map = ctx.images.get(page);
  if (map) return map;
  map = new Map<number, PlacedImage[]>();
  visitContent(ctx.doc, page, {
    image: (e) => {
      if (e.mcid === undefined || !e.stream) return;
      const placed: PlacedImage = { stream: e.stream, ...placedSize(e.quad) };
      const list = map!.get(e.mcid);
      if (list) list.push(placed);
      else map!.set(e.mcid, [placed]);
    },
  }, SHOWN);
  ctx.images.set(page, map);
  return map;
}

/** Every image this element's marked content draws.
 *
 *  Recurses: a Figure's content is normally its own /K MCIDs, but nothing
 *  forbids nesting it under intermediate elements, and elementNode never
 *  descends into a Figure — so an image reached only that way would be lost. */
function figureStreams(ctx: Ctx, el: StructElement, out: PlacedImage[]): void {
  for (const item of el.ContentItems) {
    if (item.kind !== 'mcid' || !item.page) continue;
    if (ctx.only && item.page !== ctx.only) continue; // another page's half of a split figure
    for (const s of pageMcidImages(ctx, item.page).get(item.mcid) ?? []) out.push(s);
  }
  for (const child of el.Children) figureStreams(ctx, child, out);
}

/** True when this element contributes any content on `only` (or `only` is undefined). */
function onPage(el: StructElement, only: Page | undefined): boolean {
  if (!only) return true;
  const nodes = el.Nodes;
  if (!nodes.length) return el.Page === only;      // e.g. a Figure whose /K is an OBJR
  return nodes.some((n) => (isText(n) ? n.page === only : onPage(n, only)));
}

/** The blocks under an /LBody (or, for a malformed /LI, under the item itself).
 *
 *  Text runs directly under the body become a P, because DocListItem.blocks is
 *  block level: a bare DocText there would leave each serializer to decide what
 *  wraps it, which is the disagreement this model exists to prevent. */
function itemBlocks(ctx: Ctx, el: StructElement): DocNode[] {
  const out: DocNode[] = [];
  let texts: DocText[] = [];
  const flush = (): void => {
    const runs = texts;
    texts = [];
    // One P per run of text, but one DocText PER STYLE RUN inside it: struct.ts
    // already split where the emphasis changed, and joining them back into one
    // string is what would lose it.
    if (runs.some((r) => r.text)) out.push({ kind: 'container', type: 'P', children: runs });
  };
  const actual = el.ActualText;
  if (actual !== undefined) {
    if (actual !== '') out.push({ kind: 'container', type: 'P', children: [{ kind: 'text', text: actual }] });
    return out;
  }
  for (const n of el.Nodes) {
    if (isText(n)) {
      if (ctx.only && n.page !== ctx.only) continue;
      if (n.text !== '') texts.push(docText(n.text, n));
    } else {
      flush();
      const child = elementNode(ctx, n);
      if (child) out.push(child);
    }
  }
  flush();
  return out;
}

/** One /LI: its /Lbl read for evidence, its /LBody read for content. */
function listItemNode(
  ctx: Ctx, el: StructElement,
): { item: DocListItem; marker?: Marker } | undefined {
  if (!onPage(el, ctx.only)) return undefined;
  const children = el.Children;
  const lbl = children.find((c) => c.StandardType === 'Lbl');
  const body = children.find((c) => c.StandardType === 'LBody');
  // A bullet /Lbl carries its glyph as /ActualText, since flow.ts draws the
  // bullet as vector geometry and there is no text to extract.
  const label = lbl ? (lbl.ActualText ?? lbl.GetText()).trim() : '';
  const marker = label ? parseMarkerText(label)?.marker : undefined;
  const blocks = body ? itemBlocks(ctx, body) : itemBlocks(ctx, el);
  if (!blocks.length) return undefined;
  const item: DocListItem = { kind: 'listItem', blocks };
  if (marker?.checked !== undefined) item.checked = marker.checked;
  return { item, marker };
}

/** An /L. Ordered-ness comes from /ListNumbering when the producer set one, and
 *  from the labels otherwise — which is the path our own authoring takes, since
 *  flow.ts appends a bare /L with no attributes. */
function listNode(ctx: Ctx, el: StructElement): DocNode[] {
  const items: DocListItem[] = [];
  const extra: DocNode[] = [];
  let labelled: Marker | undefined;
  let start: number | undefined;
  for (const child of el.Children) {
    if (child.StandardType !== 'LI') {
      const n = elementNode(ctx, child);      // a non-/LI kid stays a sibling block
      if (n) extra.push(n);
      continue;
    }
    const built = listItemNode(ctx, child);
    if (!built) continue;
    items.push(built.item);
    if (built.marker && !labelled) {
      labelled = built.marker;
      if (built.marker.ordinal !== undefined && built.marker.ordinal !== 1)
        start = built.marker.ordinal;
    }
  }
  if (!items.length) return extra;

  const numbering = el.ListAttributes?.listNumbering;
  const ordered = numbering !== undefined
    ? !['None', 'Disc', 'Circle', 'Square'].includes(numbering)
    : (labelled?.ordered ?? false);
  const list: DocList = { kind: 'list', ordered, items };
  if (ordered && start !== undefined) list.start = start;
  return [list, ...extra];
}

/** A /Code element's text, page-filtered, its MCID runs joined by a newline.
 *
 *  **Invariant:** U+00A0 maps back to U+0020. That substitution is preformat's,
 *  made because layoutRuns collapses runs of spaces and a code block's
 *  indentation would not otherwise survive being drawn; undoing it here is what
 *  makes the indentation survive being read back. Confined to code, where the
 *  character is provably a substitution rather than an author's choice. */
function codeText(ctx: Ctx, el: StructElement): string {
  const parts: string[] = [];
  const walk = (e: StructElement): void => {
    for (const n of e.Nodes) {
      if (isText(n)) {
        if (ctx.only && n.page !== ctx.only) continue;
        if (n.text !== '') parts.push(n.text);
      } else walk(n);
    }
  };
  walk(el);
  return parts.join('\n').replace(/\u00A0/g, ' ');
}

/** The /Code that is this element's only element child, if any. /Code is inline
 *  level and needs a block-level element around it (32000-1 14.8.4.3), so the
 *  wrapping /P carries no content of its own and collapses away. */
function loneCode(el: StructElement): StructElement | undefined {
  const kids = el.Children;
  if (kids.length !== 1 || kids[0].StandardType !== 'Code') return undefined;
  return el.Nodes.every((n) => (isText(n) ? n.text.trim() === '' : true)) ? kids[0] : undefined;
}

/** The external destination of a `/Link` element, via the `/OBJR` naming its
 *  annotation.
 *
 *  **Invariant:** only a URI action yields an href. A `GoTo` — whether spelled
 *  as an action or as a bare `/Dest` — names a page object inside this file, and
 *  once the PDF is gone there is no address for it to become; a serializer that
 *  invented one would emit a link that resolves nowhere. The element's text is
 *  emitted either way, so an internal link degrades to the words it was on. */
function linkHref(ctx: Ctx, el: StructElement): string | undefined {
  for (const item of el.ContentItems) {
    if (item.kind !== 'objr') continue;
    const annot = ctx.doc.resolve(item.ref);
    if (!isDict(annot)) continue;
    const action = parseAction(ctx.doc, annot);
    if (action?.type === 'uri' && action.uri) return action.uri;
  }
  return undefined;
}

/** One element, or undefined when it contributes nothing.
 *
 *  Page filtering and empty-node pruning live HERE, not in a serializer: two
 *  serializers deciding independently whether a node is empty is how the HTML
 *  and Markdown exports come to disagree about a document. */
function elementNode(ctx: Ctx, el: StructElement): DocNode | undefined {
  if (!onPage(el, ctx.only)) return undefined;
  const type = el.StandardType;

  if (type === 'Table') {
    // Built from this element, not looked up by page position: a Table element
    // need not carry /Pg, and the walk must not depend on one.
    const table = tableFromStruct(el);
    return table ? { kind: 'table', table } : undefined;
  }
  if (type === 'Figure') {
    const placed: PlacedImage[] = [];
    figureStreams(ctx, el, placed);
    return {
      kind: 'figure', alt: el.Alt ?? el.ActualText ?? '',
      images: placed.map((p) => p.stream),
      sizes: placed.map((p) => ({ width: p.width, height: p.height })),
      tagged: true,
    };
  }
  if (type === 'L') {
    const nodes = listNode(ctx, el);
    // A single node returns itself; several mean the /L had non-/LI kids, which
    // the transparency rule keeps as siblings — wrap them so one node comes back.
    if (!nodes.length) return undefined;
    return nodes.length === 1 ? nodes[0]
      : { kind: 'container', type: 'Div', children: nodes };
  }
  if (type === 'Code') {
    const text = codeText(ctx, el);
    return text ? { kind: 'code', text } : undefined;
  }
  if (type === 'P') {
    const code = loneCode(el);
    if (code) {
      const text = codeText(ctx, code);
      if (text) return { kind: 'code', text };
    }
  }

  const children: DocNode[] = [];
  const actual = el.ActualText;
  if (actual !== undefined) {
    // ActualText replaces the subtree's own text entirely.
    if (actual !== '') children.push({ kind: 'text', text: actual });
  } else {
    for (const n of el.Nodes) {
      if (isText(n)) {
        if (ctx.only && n.page !== ctx.only) continue;
        if (n.text !== '') children.push(docText(n.text, n));
      } else {
        const child = elementNode(ctx, n);
        if (child) children.push(child);
      }
    }
  }
  if (!children.length) return undefined;

  const node: DocContainer = { kind: 'container', type, children };
  if (el.Lang) node.lang = el.Lang;
  if (type === 'Link') {
    const href = linkHref(ctx, el);
    if (href) node.href = href;
  }
  return node;
}

function taggedModel(doc: Document, root: StructTreeRoot, only: Page | undefined): DocNode[] {
  const ctx: Ctx = { doc, only, images: new Map() };
  const out: DocNode[] = [];
  for (const child of root.Children) {
    const node = elementNode(ctx, child);
    if (node) out.push(node);
  }
  return out;
}

// ---------- untagged: geometry + font-size heuristics ----------

/** True when the center of `box` lies inside `region`. */
function centerInside(box: Rect, region: Rect): boolean {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const x0 = Math.min(region[0], region[2]), x1 = Math.max(region[0], region[2]);
  const y0 = Math.min(region[1], region[3]), y1 = Math.max(region[1], region[3]);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

/** A run of item and continuation lines as one (possibly nested) list.
 *
 *  A nested list is pushed into the PREVIOUS item's blocks, which is why the
 *  open item is closed before the stack is adjusted: its own paragraph must
 *  already be in place, or the sub-list lands ahead of the text that introduces
 *  it. Returns the index one past the run. */
function buildList(
  lines: TextLine[], classes: LineClass[], start: number,
): { node: DocList; end: number } {
  const stack: { depth: number; list: DocList }[] = [];
  let item: DocListItem | undefined;
  let texts: string[] = [];
  const closeItem = (): void => {
    if (!item) return;
    const text = texts.join(' ').replace(/\s+/g, ' ').trim();
    if (text)
      item.blocks.unshift({ kind: 'container', type: 'P', children: [{ kind: 'text', text }] });
    texts = [];
    item = undefined;
  };

  let i = start;
  for (; i < lines.length; i++) {
    const c = classes[i];
    if (c.kind === 'continuation') { texts.push(lines[i].text); continue; }
    if (c.kind !== 'item') break;
    closeItem();
    while (stack.length && stack[stack.length - 1].depth > c.depth) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.depth < c.depth) {
      const list: DocList = { kind: 'list', ordered: c.marker.ordered, items: [] };
      if (c.marker.ordered && c.marker.ordinal !== undefined && c.marker.ordinal !== 1)
        list.start = c.marker.ordinal;
      const parentItem = top?.list.items[top.list.items.length - 1];
      if (top) {
        if (parentItem) parentItem.blocks.push(list);
        else top.list.items.push({ kind: 'listItem', blocks: [list] });
      }
      stack.push({ depth: c.depth, list });
      top = stack[stack.length - 1];
    }
    item = { kind: 'listItem', blocks: [] };
    if (c.marker.checked !== undefined) item.checked = c.marker.checked;
    top.list.items.push(item);
    texts.push(lines[i].text.slice(c.marker.textStart));
  }
  closeItem();
  return { node: stack[0].list, end: i };
}

/** A block's lines as heading, paragraph, list and code nodes.
 *
 *  Ranking is per line, not per block: the block grouper clusters a heading with
 *  the body paragraph beneath it whenever they are left-aligned and close (the
 *  ordinary case), and ranking such a block as a whole would let the longer body
 *  text outvote the heading and demote it to P. Consecutive lines of equal rank
 *  merge into one container, so a wrapped paragraph stays a single P and a
 *  two-line heading stays a single H1. */
function blockNodes(
  block: TextBlock, ranks: Map<number, number>, ctx: ClassifyContext, out: DocNode[],
  links: LinkSpan[] = [],
): void {
  const classes = classifyBlock(block.lines, ctx);
  let level: number | undefined;
  let segs: LineSegment[] = [];
  const flush = (): void => {
    const taken = segs;
    segs = [];
    if (!taken.length) return;
    const children = segmentChildren(taken);
    if (!children.length) return;
    out.push({
      kind: 'container',
      type: level ? `H${level}` : 'P',
      children,
    });
  };

  let i = 0;
  while (i < block.lines.length) {
    const c = classes[i];
    if (c.kind === 'code') {
      flush();
      const from = i;
      while (i < block.lines.length && classes[i].kind === 'code') i++;
      const text = block.lines.slice(from, i)
        .map((l) => l.text.replace(/\u00A0/g, ' ')).join('\n');
      if (text.trim()) out.push({ kind: 'code', text });
      continue;
    }
    if (c.kind === 'item') {
      flush();
      const { node, end } = buildList(block.lines, classes, i);
      out.push(node);
      i = end;
      continue;
    }
    const line = block.lines[i];
    // A size-derived rank wins; the signals promote only at body size, and the
    // fallback level sits one below the smallest size-derived heading.
    const sized = ranks.get(dominantFragmentSize(line.fragments));
    const lineLevel = sized ?? (c.kind === 'heading' ? Math.min(ranks.size + 1, 6) : undefined);
    if (segs.length && lineLevel !== level) flush();
    level = lineLevel;
    if (segs.length) segs.push({ text: ' ' });     // the join between wrapped lines
    segs.push(...splitLineLinks(line, links));
    i++;
  }
  flush();
}

/** Segments as inline children: a run of plain text, or a Link carrying it.
 *
 *  Adjacent plain segments are merged and the whole is trimmed at the ends, so a
 *  block with no links produces exactly one DocText holding what the old
 *  `texts.join(' ').trim()` produced — byte for byte. */
function segmentChildren(segs: LineSegment[]): DocNode[] {
  const merged: LineSegment[] = [];
  for (const s of segs) {
    const prev = merged[merged.length - 1];
    // Emphasis joins the destination in a segment's identity: merging a bold
    // piece into the plain one beside it loses the emphasis exactly as merging
    // two destinations loses the first link.
    if (prev && prev.href === s.href && !!prev.bold === !!s.bold && !!prev.italic === !!s.italic
        && prev.script === s.script)
      prev.text += s.text;
    else merged.push({ ...s });
  }
  if (merged.length) {
    merged[0].text = merged[0].text.replace(/^\s+/, '');
    merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/\s+$/, '');
  }
  const out: DocNode[] = [];
  for (const s of merged) {
    if (!s.text) continue;
    if (s.href === undefined) out.push(docText(s.text, s));
    else out.push({ kind: 'container', type: 'Link', href: s.href, children: [docText(s.text, s)] });
  }
  return out;
}

/** The URI-bearing /Link annotations on `page`, each resolved to the text it
 *  actually covers.
 *
 *  The glyphs come from `mapRegions`, so the covered text is read off the real
 *  glyph boxes rather than interpolated within a fragment. That matters because
 *  colour is not part of a fragment's identity: a linked phrase inside a
 *  sentence is normally NOT its own fragment — a whole line is commonly one —
 *  so there is nothing to match at fragment granularity. */
function linkSpans(doc: Document, page: Page): LinkSpan[] {
  const out: LinkSpan[] = [];
  for (const a of page.Annotations) {
    if (a.Subtype !== 'Link') continue;
    const action = parseAction(doc, a.Dict);
    if (action?.type !== 'uri' || !action.uri) continue;
    const r = a.Rect;
    if (!r) continue;
    const y0 = Math.min(r[1], r[3]), y1 = Math.max(r[1], r[3]);
    const text = mapRegions(doc, page, [r]).glyphs.map((g) => g.text).join('');
    if (!text.trim()) continue;
    out.push({ text, href: action.uri, y0, y1 });
  }
  return out;
}

/** Merge adjacent lists of the same ordered-ness, so a list the block grouper
 *  split on loose spacing comes back as one list. */
function mergeLists(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.kind === 'list' && prev?.kind === 'list' && prev.ordered === n.ordered
      && n.start === undefined) {
      prev.items.push(...n.items);
      continue;
    }
    out.push(n);
  }
  return out;
}

function untaggedModel(doc: Document, pages: Page[], ranks: Map<number, number>): DocNode[] {
  const out: DocNode[] = [];
  for (const page of pages) {
    const tables: Table[] = page.GetTables();
    // Table-absorbed blocks are emitted as part of their table, not twice — and
    // they are excluded from the metrics and from the follower lookup, so a cell
    // never corroborates a heading outside the table.
    const blocks = page.GetStructuredText()
      .filter((b) => !tables.some((t) => centerInside(b.quad, t.quad)));
    const bodySize = dominantFragmentSize(blocks.flatMap((b) => b.lines.flatMap((l) => l.fragments)));
    const metrics = pageMetrics(blocks, bodySize);
    const spans = linkSpans(doc, page);

    const pageNodes: DocNode[] = [];
    blocks.forEach((block, i) => {
      const prev = blocks[i - 1]?.lines.at(-1);
      const ctx: ClassifyContext = {
        metrics,
        bodySize,
        ...(prev ? { prevBaseline: prev.quad[1] } : {}),
        ...(blocks[i + 1]?.lines[0] ? { nextLine: blocks[i + 1].lines[0] } : {}),
      };
      blockNodes(block, ranks, ctx, pageNodes, spans);
    });
    out.push(...mergeLists(pageNodes));

    for (const table of tables) out.push({ kind: 'table', table });
    // page.Images is /Resources order and says nothing about placement, so the
    // drawn box comes from a content walk keyed by the stream object. An image
    // in the resources that the page never draws keeps { 0, 0 } — the honest
    // answer, which a serializer can fall back from.
    const drawn = new Map<PdfStream, { width: number; height: number }>();
    visitContent(doc, page, {
      image: (e) => {
        if (!e.stream || drawn.has(e.stream)) return;
        drawn.set(e.stream, placedSize(e.quad));
      },
    }, SHOWN);
    for (const img of page.Images) {
      out.push({
        kind: 'figure', alt: '', images: [img.Stream],
        sizes: [drawn.get(img.Stream) ?? { width: 0, height: 0 }], tagged: false,
      });
    }
  }
  return out;
}

/** Reconstruct `pages` as a document tree: from the tagged structure tree when
 *  the document has one, and from geometry plus font-size ranking when it does
 *  not. The single walk behind every document exporter. */
export function buildDocModel(doc: Document, pages: Page[]): DocNode[] {
  const root = doc.GetStructTree();
  if (root) {
    // The tree spans pages: walk it once, restricted to a single page when that
    // is all that was asked for, so an element crossing a page break stays one
    // element.
    const only = pages.length === 1 && doc.Pages.length > 1 ? pages[0] : undefined;
    return taggedModel(doc, root, only);
  }
  return untaggedModel(doc, pages, headingRanks(doc));
}
