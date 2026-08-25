import type { Document } from './document.js';
import { escapeHtml } from './html.js';
import { imageHref } from './imagehref.js';
import type { DocFigure, DocListItem, DocNode, DocText } from './docmodel.js';
import { styledChildren } from './docmodel.js';
import type { PdfStream } from './types.js';

/** Resolves a figure's image to an href. Omitted, images inline as data: URIs.
 *
 *  The seam EPUB needs: an EPUB carries its images as package parts, so its
 *  manifest must name a file that exists rather than a data: URI inlined into
 *  the markup. Same shape as docxflow.ts's DocxImageSink, for the same reason. */
export interface HtmlImageSink { href(stream: PdfStream): string | undefined }

/** Standard structure type → HTML tag. Types absent here fall back to <div>. */
const TAG_FOR: Record<string, string> = {
  P: 'p', H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', H5: 'h5', H6: 'h6',
  L: 'ul', LI: 'li', Span: 'span', Link: 'a', BlockQuote: 'blockquote', Code: 'code',
  Document: 'div', Part: 'div', Sect: 'div', Div: 'div', Art: 'div', TOC: 'div', TOCI: 'div',
};

function figureHtml(doc: Document, fig: DocFigure, images?: HtmlImageSink): string {
  const alt = escapeHtml(fig.alt);
  const hrefs: string[] = [];
  for (const s of fig.images) {
    const href = images ? images.href(s) : imageHref(doc, s, [0, 0, 0]);
    if (href) hrefs.push(href);
  }
  // A tagged /Figure announces itself even with nothing to show — the /Alt is
  // the accessible content. An untagged page image has no alt, so an image that
  // will not encode leaves nothing behind.
  if (!hrefs.length) return fig.tagged ? `<img alt="${alt}"/>` : '';
  // A figure is described once. Repeating /Alt on each part of a composite
  // would have a screen reader announce the same description N times.
  return hrefs.map((h, i) => `<img src="${h}" alt="${i === 0 ? alt : ''}"/>`).join('');
}

/** One list item. A task's state is CONTENT rather than a marker — it is the one
 *  place the marker-suppression rule does not apply — so it survives as a
 *  checkbox, disabled because an exported document is not a form. */
function listItemHtml(doc: Document, item: DocListItem, images?: HtmlImageSink): string {
  const inner = item.blocks.map((b) => nodeHtml(doc, b, images)).filter((s) => s).join('');
  const box = item.checked === undefined ? ''
    : `<input type="checkbox" disabled="disabled"${item.checked ? ' checked="checked"' : ''}/>`;
  return inner || box ? `<li>${box}${inner}</li>` : '';
}

/** Wrap a text run in the elements its derived style calls for.
 *
 *  `<b>`/`<i>` rather than `<strong>`/`<em>`: HTML5 defines `<b>` as
 *  stylistically offset WITHOUT conveying importance, which is exactly what a
 *  face-derived style is — `CLAUDE.md` records that a PDF states a face and
 *  never an emphasis. Script nests outermost, matching the Markdown emitter.
 *
 *  **Invariant:** surrounding whitespace is hoisted outside the elements, as
 *  the `Link` case below already does for the anchor and `emphasizeMarkdown`
 *  does for its delimiters. Not forced here the way it is in Markdown — HTML
 *  has no flanking rules — but a run owns the separator space that follows it
 *  (see the `layout.ts` invariant), so without it a bold word emits
 *  `<b>bold </b>` where Markdown emits `**bold**`, and the two exports would
 *  disagree about where the emphasis ends. */
function emphasizeHtml(inner: string, node: DocText): string {
  if (!node.bold && !node.italic && !node.script) return inner;
  const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
  if (!core) return inner;
  let out = core;
  if (node.italic) out = `<i>${out}</i>`;
  if (node.bold) out = `<b>${out}</b>`;
  if (node.script) out = `<${node.script === 'super' ? 'sup' : 'sub'}>${out}</${node.script === 'super' ? 'sup' : 'sub'}>`;
  return `${lead}${out}${tail}`;
}

function nodeHtml(doc: Document, node: DocNode, images?: HtmlImageSink): string {
  if (node.kind === 'text') return emphasizeHtml(escapeHtml(node.text), node);
  if (node.kind === 'table') return node.table.toHtml();
  if (node.kind === 'figure') return figureHtml(doc, node, images);
  if (node.kind === 'code') return `<pre><code>${escapeHtml(node.text)}</code></pre>`;
  if (node.kind === 'listItem') return listItemHtml(doc, node, images);
  if (node.kind === 'list') {
    const tag = node.ordered ? 'ol' : 'ul';
    const start = node.ordered && node.start !== undefined ? ` start="${node.start}"` : '';
    const items = node.items.map((it) => listItemHtml(doc, it, images)).filter((s) => s).join('');
    return items ? `<${tag}${start}>${items}</${tag}>` : '';
  }

  // styledChildren, not node.children: it merges adjacent same-style runs and
  // drops a heading's uniform bold, and both serializers must apply both.
  const inner = styledChildren(node).map((c) => nodeHtml(doc, c, images)).filter((s) => s).join('');
  if (!inner) return '';
  const tag = TAG_FOR[node.type] ?? 'div';
  const lang = node.lang ? ` lang="${escapeHtml(node.lang)}"` : '';
  // An <a> with no href is markup that looks like a link and does nothing, so a
  // Link whose destination could not be recovered (an internal GoTo) renders as
  // its text rather than as a dead anchor.
  if (node.type === 'Link') {
    if (!node.href) return inner;
    // Whitespace the link's own run drew sits outside the anchor, so the
    // clickable text is the words and not the gap after them.
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner)!;
    if (!core) return inner;
    return `${lead}<a${lang} href="${escapeHtml(node.href)}">${core}</a>${tail}`;
  }
  return `<${tag}${lang}>${inner}</${tag}>`;
}

/** Serialize a document model as reflowable semantic HTML. */
export function semanticBody(
  doc: Document, nodes: DocNode[], images?: HtmlImageSink,
): string {
  return nodes.map((n) => nodeHtml(doc, n, images)).filter((s) => s).join('\n');
}
