/** An inline `<svg>` subtree back to XML markup (zch2.12).
 *
 *  Invariant: a PURE LEAF over htmldom.js and htmlforeign.js. No Document, no
 *  PDF object module, no `node:` import. It never throws.
 *
 *  Why it exists at all: `addSvgObject` takes SOURCE BYTES and svgdraw.ts walks
 *  an xml.ts tree, while the HTML parser produced HtmlElements. There is no
 *  path between them, so rendering "through the existing importer" means
 *  serializing back to markup — which zch2.12's issue treated as free.
 *
 *  Note the DIRECTION: HTML DOM -> markup, so the SVG IMPORTER can read it.
 *  It shares no code with htmlsemantic.ts (PDF -> HTML) or svgrender.ts
 *  (PDF -> SVG).
 *
 *  Invariant: it UNDOES the two adjustments HTML tree construction made, and
 *  both are silent when missed. An adjusted foreign attribute is stored under a
 *  DISPLAY key with a SPACE (`xlink href`, htmlforeign.ts:87), which is not a
 *  name parseXml can read; and element and attribute names are ALREADY
 *  case-adjusted (`linearGradient`, `viewBox`), so they are emitted AS STORED
 *  rather than lower-cased.
 *
 *  Note: no `xmlns` is added. Verified against the real importer rather than
 *  assumed — `page.AddSVGObject` renders namespace-less markup, because
 *  parseXml strips namespace prefixes and svgembed.ts checks the root name
 *  only. Adding one would make this a rewrite rather than a round trip.
 *
 *  Note the output is validated by its CONSUMER: parseXml is strict — it throws
 *  PdfParseError on a mismatched end tag or an unquoted value — so a serializer
 *  bug surfaces at the parse rather than as a silently wrong drawing. */

import type { HtmlElement, HtmlNode } from './htmldom.js';
import { FOREIGN_ATTRS } from './htmlforeign.js';

/** Display key (`xlink href`) back to the XML name (`xlink:href`). */
const XML_NAME: ReadonlyMap<string, string> = new Map(
  [...FOREIGN_ATTRS].map(([xmlName, display]) => [display, xmlName]),
);

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

function emit(n: HtmlNode, out: string[]): void {
  if (n.kind === 'text') { out.push(escapeText(n.data)); return; }
  // A comment or a doctype carries no ink; leaving them out keeps the output to
  // what the importer reads.
  if (n.kind !== 'element') return;
  const attrs: string[] = [];
  for (const [k, v] of n.attrs) attrs.push(` ${XML_NAME.get(k) ?? k}="${escapeAttr(v)}"`);
  if (n.children.length === 0) {
    out.push(`<${n.name}${attrs.join('')}/>`);
    return;
  }
  out.push(`<${n.name}${attrs.join('')}>`);
  for (const k of n.children) emit(k, out);
  out.push(`</${n.name}>`);
}

/** The subtree rooted at `el` as XML markup. */
export function serializeSvg(el: HtmlElement): string {
  const out: string[] = [];
  emit(el, out);
  return out.join('');
}
