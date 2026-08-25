import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  buildDocModel, styledChildren,
  type DocFigure, type DocList, type DocListItem, type DocNode,
} from './docmodel.js';
import { createHash } from 'node:crypto';
import type { PdfStream } from './types.js';
import { encodeImage, imageExtension } from './imagehref.js';
import { emphasizeMarkdown, escapeLinkDestination, escapeMarkdown } from './mdescape.js';

export { escapeMarkdown } from './mdescape.js';

/** Options for {@link Page.ToMarkdown} and {@link Document.ToMarkdown}.
 *
 *  NOT `MarkdownOptions`, which `markdown.ts` exports for the opposite
 *  direction — and for the same reason the result type below is
 *  `MarkdownExportResult`, since `mdflow.ts` already owns `MarkdownResult` for
 *  Markdown→PDF. Two directions, two vocabularies, no shared names. */
export interface MarkdownExportOptions {
  /** `'inline'` (default) embeds every image as a `data:` URI. `'external'`
   *  references a file per image and returns the bytes — use
   *  {@link Document.ToMarkdownAssets}, since `ToMarkdown` has nowhere to put
   *  them. */
  images?: 'inline' | 'external';
  /** Directory prefix for external image paths. Default `'images'`. */
  imageDir?: string;
}

/** One image file an external-image export expects to be written. */
export interface MarkdownAsset {
  /** Path as referenced from the Markdown, e.g. `images/img-1.png`. */
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

/** Markdown plus the image files it references. `images` is empty for an
 *  inline export, whose images live in the text. */
export interface MarkdownExportResult { markdown: string; images: MarkdownAsset[] }

/** Per-render image state: the href chosen for each distinct image, and the
 *  assets an external render accumulated.
 *
 *  **Invariant:** identity is the ENCODED BYTES, hashed — not the PdfStream
 *  object. A merged document holds distinct stream objects with identical
 *  content, and keying on identity would encode each of them and, in external
 *  mode, write the same picture to several files. */
interface ImageCtx {
  mode: 'inline' | 'external';
  dir: string;
  seen: Map<string, string>;      // content hash -> href
  assets: MarkdownAsset[];
}

function imageCtx(opts: MarkdownExportOptions): ImageCtx {
  return {
    mode: opts.images ?? 'inline',
    dir: opts.imageDir ?? 'images',
    seen: new Map(),
    assets: [],
  };
}

/** The href for `stream`, encoding it at most once per render. */
function imageRef(doc: Document, ctx: ImageCtx, stream: PdfStream): string | undefined {
  const enc = encodeImage(doc, stream, [0, 0, 0]);
  if (!enc) return undefined;
  const key = createHash('sha256').update(enc.bytes).digest('hex');
  const hit = ctx.seen.get(key);
  if (hit !== undefined) return hit;

  let href: string;
  if (ctx.mode === 'inline') {
    href = `data:${enc.mediaType};base64,${Buffer.from(enc.bytes).toString('base64')}`;
  } else {
    const name = `img-${ctx.assets.length + 1}.${imageExtension(enc.mediaType)}`;
    href = ctx.dir ? `${ctx.dir}/${name}` : name;
    ctx.assets.push({ path: href, bytes: enc.bytes, mediaType: enc.mediaType });
  }
  ctx.seen.set(key, href);
  return href;
}

/** Structure types that concatenate into the enclosing block rather than
 *  starting one. A Link renders as its text until no93.4 recovers the URI.
 *
 *  Deliberately short. An inline type nested inside a P never reaches this set
 *  — inlineText recurses through every container — so it matters only for one
 *  appearing at block level, where a container holding a single text run gives
 *  the same result either way. */
const INLINE_TYPES = new Set(['Span', 'Link', 'Code']);

/** Heading level, or 0 for anything else. */
function headingLevel(type: string): number {
  const m = /^H([1-6])$/.exec(type);
  return m ? Number(m[1]) : 0;
}

/** All text under a node, concatenated and escaped — the inline projection.
 *
 *  A Link carrying a destination becomes `[text](dest)`; one without becomes its
 *  text, which is what an internal GoTo degrades to. */
function inlineText(node: DocNode): string {
  if (node.kind === 'text') return emphasizeMarkdown(escapeMarkdown(node.text), node);
  if (node.kind === 'container') {
    // styledChildren, not node.children: it merges adjacent same-style runs and
    // drops a heading's uniform bold, and both serializers must apply both.
    const inner = styledChildren(node).map(inlineText).join('');
    if (node.type === 'Link' && node.href && inner.trim()) {
      // Whitespace the link's own run happened to draw belongs OUTSIDE the
      // label: `[the docs ](url)` renders a label with a trailing space, which
      // is not what the page shows.
      const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
      return `${lead}[${core}](${escapeLinkDestination(node.href)})${tail}`;
    }
    return inner;
  }
  return '';   // a table or figure nested inside an inline run has no inline form
}

function figureMarkdown(doc: Document, ctx: ImageCtx, fig: DocFigure): string[] {
  const alt = escapeMarkdown(fig.alt);
  const hrefs: string[] = [];
  for (const s of fig.images) {
    const href = imageRef(doc, ctx, s);
    if (href) hrefs.push(href);
  }
  // Mirrors the HTML serializer: a tagged /Figure still announces itself
  // through its /Alt when there is nothing to show, an untagged page image
  // leaves nothing behind.
  if (!hrefs.length) return fig.tagged ? [`![${alt}]()`] : [];
  return hrefs.map((h, i) => `![${i === 0 ? alt : ''}](${h})`);
}

/** Render `nodes` as a block string — the same joining `render` uses, so a
 *  nested construct reads exactly as it would at the top level. */
function blocksText(doc: Document, ctx: ImageCtx, nodes: DocNode[], sep = '\n\n'): string {
  const out: string[] = [];
  for (const n of nodes) nodeBlocks(doc, ctx, n, out);
  return out.join(sep);
}

/** An item's blocks. A list or a code block follows its introducing text with a
 *  single newline: a blank line there makes the parser read the whole list as
 *  loose, which changes how it renders. */
function itemText(doc: Document, ctx: ImageCtx, item: DocListItem): string {
  const parts: string[] = [];
  for (const b of item.blocks) {
    const chunk: string[] = [];
    nodeBlocks(doc, ctx, b, chunk);
    const text = chunk.join('\n\n');
    if (!text) continue;
    if (!parts.length) parts.push(text);
    else parts.push((b.kind === 'list' || b.kind === 'code' ? '\n' : '\n\n') + text);
  }
  return parts.join('');
}

function listMarkdown(doc: Document, ctx: ImageCtx, node: DocList): string {
  // Loose means an item holds more than one block that is NOT a nested list:
  // counting the sub-list would make every nesting parent loose, and the blank
  // lines that follow would make it loose for the parser too.
  const loose = node.items.some(
    (it) => it.blocks.filter((b) => b.kind !== 'list').length > 1);
  let n = node.start ?? 1;
  const items: string[] = [];
  for (const item of node.items) {
    const marker = node.ordered ? `${n++}. `
      : item.checked === undefined ? '- ' : item.checked ? '- [x] ' : '- [ ] ';
    const body = itemText(doc, ctx, item);
    if (!body) continue;
    const indent = ' '.repeat(marker.length);
    const [first, ...rest] = body.split('\n');
    items.push([marker + first, ...rest.map((l) => (l ? indent + l : ''))].join('\n'));
  }
  return items.join(loose ? '\n\n' : '\n');
}

/** **Invariant:** the fence is one backtick longer than the longest run inside.
 *  A fixed three-backtick fence lets a block containing a fenced example break
 *  out of itself, producing valid Markdown that says something else. There is no
 *  info string: a PDF records no language, and guessing one lexically would be a
 *  claim the document does not make. */
function codeMarkdown(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function quoteMarkdown(inner: string): string {
  return inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
}

/** Append `node`'s blocks to `out`. */
function nodeBlocks(doc: Document, ctx: ImageCtx, node: DocNode, out: string[]): void {
  if (node.kind === 'text') {
    const t = emphasizeMarkdown(escapeMarkdown(node.text), node);
    if (t) out.push(t);
    return;
  }
  // Same shape as the list and quote cases below. A Table with no rows
  // serializes to '' and would otherwise contribute a blank block; note that no
  // in-repo producer emits one (tablestruct.ts rejects a rowless /Table, and
  // geometry detection needs an interior rule), so this guard is UNPINNED —
  // reachable only through the public `new Table(...)`. Do not read the green
  // suite as covering it.
  if (node.kind === 'table') { const t = node.table.toMarkdown(); if (t) out.push(t); return; }
  if (node.kind === 'figure') { out.push(...figureMarkdown(doc, ctx, node)); return; }
  if (node.kind === 'list') { const t = listMarkdown(doc, ctx, node); if (t) out.push(t); return; }
  if (node.kind === 'listItem') { const t = itemText(doc, ctx, node); if (t) out.push(t); return; }
  if (node.kind === 'code') { out.push(codeMarkdown(node.text)); return; }

  if (node.type === 'BlockQuote') {
    const inner = blocksText(doc, ctx, node.children);
    if (inner) out.push(quoteMarkdown(inner));
    return;
  }

  const level = headingLevel(node.type);
  if (level) {
    // styledChildren reads node.type, so this is the call site that gets the
    // heading's uniform bold dropped.
    const t = styledChildren(node).map(inlineText).join('').trim();
    if (t) out.push(`${'#'.repeat(level)} ${t}`);
    return;
  }
  if (node.type === 'P' || INLINE_TYPES.has(node.type)) {
    const t = styledChildren(node).map(inlineText).join('').trim();
    if (t) out.push(t);
    return;
  }
  // Transparent: an unknown type emits its children as sibling blocks rather
  // than vanishing. Visible content beats a silently dropped subtree — the rule
  // svgdraw.ts already sets — and it is what keeps no93.2's L/LI readable
  // before that issue lands.
  for (const child of node.children) nodeBlocks(doc, ctx, child, out);
}

function render(doc: Document, pages: Page[], opts: MarkdownExportOptions): MarkdownExportResult {
  const ctx = imageCtx(opts);
  const blocks: string[] = [];
  try {
    for (const node of buildDocModel(doc, pages)) nodeBlocks(doc, ctx, node, blocks);
  } catch {
    // Degrade: emit whatever was produced. Matches ToHtml and renderPageToSvg,
    // neither of which throws on a document we could not fully reconstruct.
  }
  return {
    markdown: blocks.length ? `${blocks.join('\n\n')}\n` : '',
    images: ctx.assets,
  };
}

/** Reject the one option combination that can only produce a broken document.
 *
 *  External images make the Markdown reference files the caller must write, and
 *  `ToMarkdown` returns a string with nowhere to hand the bytes back. Emitting
 *  links to files nobody wrote looks fine and is broken, so the call is refused
 *  the way every authoring entry point refuses a bad argument. */
function rejectExternal(opts: MarkdownExportOptions): void {
  if (opts.images === 'external')
    throw new TypeError(
      "images: 'external' returns image bytes — use ToMarkdownAssets, which returns them");
}

/** Render one page to GFM Markdown. Never throws, except on an option that
 *  cannot be honoured (see `rejectExternal`). */
export function renderPageToMarkdown(
  doc: Document, page: Page, opts: MarkdownExportOptions = {}): string {
  rejectExternal(opts);
  return render(doc, [page], opts).markdown;
}

/** Render every page to one Markdown document. Never throws, except on an
 *  option that cannot be honoured (see `rejectExternal`). */
export function renderDocumentToMarkdown(
  doc: Document, opts: MarkdownExportOptions = {}): string {
  rejectExternal(opts);
  return render(doc, doc.Pages, opts).markdown;
}

/** Render one page to Markdown plus the image files it references. */
export function renderPageToMarkdownAssets(
  doc: Document, page: Page, opts: MarkdownExportOptions = {}): MarkdownExportResult {
  return render(doc, [page], opts);
}

/** Render every page to Markdown plus the image files it references. */
export function renderDocumentToMarkdownAssets(
  doc: Document, opts: MarkdownExportOptions = {}): MarkdownExportResult {
  return render(doc, doc.Pages, opts);
}
