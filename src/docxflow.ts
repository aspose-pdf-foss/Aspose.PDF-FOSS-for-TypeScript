import { escapeXml } from './xml.js';
import { rgbHex, type Rgb } from './colorspace.js';
import type { DocListItem, DocNode } from './docmodel.js';
import type { PdfStream } from './types.js';
import { EMU_PER_PT, STYLE, type DocxNumbering } from './docxstyles.js';
import { docxTable } from './docxtable.js';

/** An image registered with the package: its relationship id and, as a size of
 *  last resort, the encoded picture's own pixel dimensions. */
export interface DocxImage { rid: string; pxWidth: number; pxHeight: number }

/** Registers an image with the package. Returns undefined when it cannot be
 *  encoded, which is the mapper's cue to fall back to the alt text. */
export interface DocxImageSink { add(stream: PdfStream): DocxImage | undefined }

/** Registers an external hyperlink target, returning its relationship id. */
export interface DocxLinkSink { add(href: string): string }

/** A positioned frame, in twips, anchored to the page. Textbox mode's only
 *  positioning construct — see `docxtextbox.ts`. */
export interface FrameProps { x: number; y: number; w: number; h: number }

export interface RunFmt {
  bold?: boolean; italic?: boolean; style?: string;
  /** Sub/superscript. Emitted as `w:vertAlign`, which CT_RPr orders AFTER
   *  `w:szCs` — so appending is correct here, unlike `w:framePr` in `w:pPr`. */
  script?: 'sub' | 'super';
  /** Font size in points. Emitted as `w:sz`, which is in HALF-points. */
  size?: number;
  /** Text colour. Omitted for black, matching `GlyphEvent.color`'s fence. */
  color?: Rgb;
}
export interface ParaProps {
  style?: string; numId?: number; ilvl?: number; indent?: number;
  frame?: FrameProps;
}

/** Drop the characters XML 1.0 forbids, keeping tab, newline and return.
 *
 *  **Invariant:** this runs before escaping and on every string that reaches a
 *  `w:t`. `escapeXml` handles `& < > "` and nothing else, and extracted PDF text
 *  can carry a NUL or a C0 control. One such byte does not corrupt a paragraph —
 *  it makes `document.xml` unparseable, so Word rejects the entire file with no
 *  indication of where the fault is. */
export function sanitizeXml(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const ok = c === 0x09 || c === 0x0a || c === 0x0d
      || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd)
      || (c >= 0x10000 && c <= 0x10ffff);
    if (ok) out += ch;
  }
  return out;
}

/** Text as `w:t` segments, line breaks as `w:br`.
 *
 *  **Invariant:** every `w:t` carries `xml:space="preserve"`. A `/Link` draws
 *  `(the docs )` inside its own marked content, and without the attribute Word
 *  collapses that trailing space, rejoining the words either side.
 *
 *  **Invariant:** a newline becomes `<w:br/>`, matching what `Table.toHtml`
 *  already does with `<br>`. A raw newline in `w:t` is legal XML and renders as
 *  a space, silently joining lines the document showed separately. */
function textXml(text: string): string {
  return sanitizeXml(text).split('\n')
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join('<w:br/>');
}

/** `w:color`'s value is BARE hex — `rgbHex` returns `'#rrggbb'` lowercase. */
const colorVal = (c: Rgb): string => rgbHex(c).slice(1).toUpperCase();

export function runXml(text: string, fmt: RunFmt = {}): string {
  // w:sz and w:szCs are in HALF-points, and both are stated: omitting w:szCs
  // leaves a mixed-script run at Word's default size.
  const sz = fmt.size !== undefined ? Math.round(fmt.size * 2) : undefined;
  const props = (fmt.style ? `<w:rStyle w:val="${fmt.style}"/>` : '')
    + (fmt.bold ? '<w:b/>' : '') + (fmt.italic ? '<w:i/>' : '')
    + (fmt.color ? `<w:color w:val="${colorVal(fmt.color)}"/>` : '')
    + (sz !== undefined ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : '')
    + (fmt.script ? `<w:vertAlign w:val="${fmt.script}script"/>` : '');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${textXml(text)}</w:r>`;
}

export function paragraphXml(runs: string, props: ParaProps = {}): string {
  // **Invariant:** `w:pPr`'s children are schema-ORDERED — `w:framePr`,
  // `w:pStyle`, `w:numPr`, `w:ind`. Wrong order is a file Word refuses
  // outright, so a new property is INSERTED at its place, never appended. Same
  // class of rule as `w:tcPr`'s ordered children in docxtable.ts.
  const frame = props.frame
    ? `<w:framePr w:w="${props.frame.w}" w:h="${props.frame.h}" w:hRule="atLeast"`
      + ` w:x="${props.frame.x}" w:y="${props.frame.y}"`
      + ' w:hAnchor="page" w:vAnchor="page" w:wrap="none"/>'
    : '';
  const numPr = props.numId !== undefined
    ? `<w:numPr><w:ilvl w:val="${props.ilvl ?? 0}"/><w:numId w:val="${props.numId}"/></w:numPr>`
    : '';
  const ind = props.indent ? `<w:ind w:left="${Math.round(props.indent)}"/>` : '';
  const pPr = frame + (props.style ? `<w:pStyle w:val="${props.style}"/>` : '') + numPr + ind;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Heading level, or 0 for anything else. Mirrors mdexport.ts. */
function headingLevel(type: string): number {
  const m = /^H([1-6])$/.exec(type);
  return m ? Number(m[1]) : 0;
}

/** Structure types that concatenate into the enclosing paragraph rather than
 *  starting one. Mirrors mdexport.ts's INLINE_TYPES. */
const INLINE_TYPES = new Set(['P', 'Span', 'Link', 'Code']);

/** Walk state: the sinks, the numbering allocated so far, the list nesting
 *  depth, and the running drawing id. */
interface Ctx {
  images: DocxImageSink;
  links: DocxLinkSink;
  nums: DocxNumbering[];
  depth: number;
  drawingId: number;
}

/** Every text run under a node, flattened — the inline projection. */
function inlineRuns(node: DocNode, fmt: RunFmt, ctx: Ctx): string {
  if (node.kind === 'text') {
    return runXml(node.text, {
      ...fmt,
      ...(node.bold ? { bold: true } : {}), ...(node.italic ? { italic: true } : {}),
      ...(node.script ? { script: node.script } : {}),
    });
  }
  if (node.kind === 'container') {
    const inner = node.children.map((c) => inlineRuns(c, fmt, ctx)).join('');
    // Only a URI destination becomes a hyperlink. A GoTo names a page object
    // that will not exist once the PDF is gone, so it degrades to its words —
    // the rule docmodel.ts sets by recording an href for a URI action alone.
    if (node.type === 'Link' && node.href && inner) {
      const rid = ctx.links.add(node.href);
      const styled = node.children
        .map((c) => inlineRuns(c, { ...fmt, style: STYLE.hyperlink }, ctx)).join('');
      return `<w:hyperlink r:id="${escapeXml(rid)}">${styled}</w:hyperlink>`;
    }
    return inner;
  }
  return '';   // a table or figure nested inside an inline run has no inline form
}

const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006';

/** One inline picture.
 *
 *  **Invariant:** `wp:docPr@id` is unique across the document and non-zero.
 *  Word tolerates a duplicate in some builds and reports the file as corrupt in
 *  others, which makes it look like a defect that depends on the reader.
 *
 *  Shared with `docxtextbox.ts`, which wraps it in a frame rather than placing
 *  it inline. Since the id must be unique across the WHOLE document, both
 *  callers draw from one counter. */
export function drawingXml(rid: string, wPt: number, hPt: number, alt: string, id: number): string {
  const cx = Math.max(1, Math.round(wPt * EMU_PER_PT));
  const cy = Math.max(1, Math.round(hPt * EMU_PER_PT));
  const descr = alt ? ` descr="${escapeXml(alt)}"` : '';
  return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${id}" name="Picture ${id}"${descr}/>`
    + `<a:graphic xmlns:a="${DRAWING_NS}/main">`
    + `<a:graphicData uri="${DRAWING_NS}/picture">`
    + `<pic:pic xmlns:pic="${DRAWING_NS}/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"${descr}/>`
    + '<pic:cNvPicPr/></pic:nvPicPr>'
    + `<pic:blipFill><a:blip r:embed="${escapeXml(rid)}"/>`
    + '<a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}

/** Append `node`'s block XML to `out`. */
function nodeBlocks(node: DocNode, ctx: Ctx, out: string[], props: ParaProps = {}): void {
  if (node.kind === 'text') {
    if (node.text) out.push(paragraphXml(inlineRuns(node, {}, ctx), props));
    return;
  }
  if (node.kind === 'code') {
    // One paragraph per line: indentation and line structure both survive, and
    // a code block is not one paragraph with soft breaks in Word's model.
    for (const line of node.text.split('\n'))
      out.push(paragraphXml(runXml(line), { ...props, style: STYLE.code }));
    return;
  }
  if (node.kind === 'container') {
    if (node.type === 'BlockQuote') {
      for (const c of node.children) nodeBlocks(c, ctx, out, { ...props, style: STYLE.quote });
      return;
    }
    const level = headingLevel(node.type);
    if (level) {
      const runs = inlineRuns(node, {}, ctx);
      if (runs) out.push(paragraphXml(runs, { ...props, style: STYLE.heading(level) }));
      return;
    }
    if (INLINE_TYPES.has(node.type)) {
      const runs = inlineRuns(node, {}, ctx);
      if (runs) out.push(paragraphXml(runs, props));
      return;
    }
    // Transparent: an unknown type emits its children as sibling blocks rather
    // than vanishing. Everything in a tagged tree hangs under a Document
    // wrapper, so dropping unknown types empties the output entirely — the rule
    // mdexport.ts already follows.
    for (const c of node.children) nodeBlocks(c, ctx, out, props);
    return;
  }
  if (node.kind === 'list') {
    // One numId per list: two sibling lists must not continue each other's
    // numbering, which sharing an id would make them do.
    const numId = ctx.nums.length + 1;
    ctx.nums.push({
      numId, ordered: node.ordered,
      ...(node.start !== undefined ? { start: node.start } : {}),
    });
    for (const it of node.items) listItemBlocks(it, ctx, out, props, numId, ctx.depth);
    return;
  }
  if (node.kind === 'listItem') {
    // A bare item outside a list: no numbering to attach, just its blocks.
    listItemBlocks(node, ctx, out, props, undefined, ctx.depth);
    return;
  }
  if (node.kind === 'figure') {
    const drawings: string[] = [];
    node.images.forEach((s, i) => {
      const img = ctx.images.add(s);
      if (!img) return;
      const drawn = node.sizes?.[i];
      // The drawn size is what the producer meant. Pixels at 96 DPI are the
      // fallback for an image the page never actually drew.
      const wPt = drawn && drawn.width > 0 ? drawn.width : img.pxWidth * 0.75;
      const hPt = drawn && drawn.height > 0 ? drawn.height : img.pxHeight * 0.75;
      // A figure is described once: repeating /Alt on each part would have a
      // screen reader announce the same description N times.
      drawings.push(drawingXml(img.rid, wPt, hPt, i === 0 ? node.alt : '', ++ctx.drawingId));
    });
    if (drawings.length) {
      for (const d of drawings) out.push(paragraphXml(`<w:r>${d}</w:r>`, props));
    } else if (node.tagged && node.alt) {
      // A tagged /Figure still has accessible content to announce; an untagged
      // page image has no alt and so leaves nothing behind.
      out.push(paragraphXml(runXml(node.alt), props));
    }
    return;
  }
  if (node.kind === 'table') {
    // The paragraph builder is handed over rather than imported: docxtable.ts
    // must not import this module back, and a second emitter there would lose
    // the xml:space attribute and the control-character strip.
    const xml = docxTable(node.table, { paragraph: (t) => paragraphXml(runXml(t)) });
    if (xml) {
      out.push(xml);
      // An empty paragraph after EVERY table: two w:tbl elements with nothing
      // between them merge into one table in Word, and a body ending in a table
      // has no paragraph mark for the section properties to attach to.
      out.push(paragraphXml(''));
    }
    return;
  }
}

/** One item: its first block carries the marker, its remaining blocks are
 *  indented siblings, and a nested list raises the level.
 *
 *  **Invariant:** only the FIRST block gets the `w:numPr`. Word restarts the
 *  marker on every paragraph that carries one, so a two-paragraph item would
 *  otherwise render as two items.
 *
 *  **Invariant:** a task's checked state is CONTENT, emitted as a literal ☐/☒
 *  at the head of the first paragraph. It is the one place the
 *  marker-suppression rule does not apply — the state is what the document
 *  says, not decoration the serializer re-derives, exactly as
 *  `htmlsemantic.ts` emits a disabled checkbox. */
function listItemBlocks(
  item: DocListItem, ctx: Ctx, out: string[], props: ParaProps,
  numId: number | undefined, depth: number,
): void {
  const box = item.checked === undefined ? '' : item.checked ? '☒ ' : '☐ ';
  let first = true;
  for (const b of item.blocks) {
    if (b.kind === 'list') {
      ctx.depth = depth + 1;
      nodeBlocks(b, ctx, out, props);
      ctx.depth = depth;
      continue;
    }
    const marker: ParaProps = first && numId !== undefined
      ? { ...props, style: STYLE.listParagraph, numId, ilvl: depth }
      : { ...props, style: STYLE.listParagraph, indent: 720 * (depth + 1) };
    if (first && box && b.kind === 'container') {
      out.push(paragraphXml(runXml(box) + inlineRuns(b, {}, ctx), marker));
    } else {
      nodeBlocks(b, ctx, out, marker);
    }
    first = false;
  }
}

/** Map a document tree to the inner XML of `<w:body>`.
 *
 *  **Invariant:** the mapper REPORTS the lists it emitted rather than a flag
 *  saying that it did. `numbering.xml` needs one `w:num` per list with that
 *  list's kind and start override, and the mapper is the only thing that knows
 *  how many ids it allocated and what each meant. */
export function docxBody(
  nodes: DocNode[], images: DocxImageSink, links: DocxLinkSink,
): { xml: string; nums: DocxNumbering[] } {
  const ctx: Ctx = { images, links, nums: [], depth: 0, drawingId: 0 };
  const out: string[] = [];
  for (const n of nodes) nodeBlocks(n, ctx, out);
  return { xml: out.join(''), nums: ctx.nums };
}
