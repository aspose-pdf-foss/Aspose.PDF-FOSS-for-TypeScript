/**
 * Rich text (an XHTML fragment) reduced to searchable plain text.
 *
 * Two PDF entries carry markup rather than text: a markup annotation's `/RC`
 * (32000-1 12.5.6.2) and a form field's `/RV`. Anything that reads either AS
 * TEXT — a search, an export — needs this; anything that round-trips them —
 * `formdata.ts` into FDF/XFDF, `xfdfannot.ts` into `contents-richtext` — needs
 * the markup verbatim and must NOT come through here.
 *
 * A pure leaf over `xml.ts`. It parses rather than stripping angle brackets,
 * because a regex mishandles CDATA, comments, and a `>` inside an attribute
 * value — all three of which appear in real rich text.
 */
import { parseXml, type XmlNode } from './xml.js';

/**
 * Elements after which a line break belongs. Everything else concatenates.
 *
 * The rule has to be stated because BOTH failure modes are silent and they are
 * opposites. Concatenating everything turns `<p>a</p><p>b</p>` into `ab`, so a
 * query for `ab` matches text that never appeared; separating every sibling
 * turns `<p>a<b>x</b>y</p>` into `a x y`, so a query for `axy` stops matching
 * text that is there. A small block list is the only rule that gets both right.
 */
const BLOCK = new Set([
  'body', 'p', 'div', 'br', 'li', 'ul', 'ol', 'dl', 'dt', 'dd',
  'tr', 'td', 'th', 'table', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * Marks a block boundary while walking.
 *
 * A sentinel rather than a literal newline, because the whitespace-collapsing
 * pass below could not then tell a break this inserted from a newline that was
 * only layout in the source markup. U+0000 is the choice for being the one
 * character real rich text will not contain.
 */
const SEP = '\u0000';

function walk(node: XmlNode, out: string[]): void {
  for (const n of node.nodes) {
    if (typeof n === 'string') { out.push(n); continue; }
    const block = BLOCK.has(n.name.toLowerCase());
    if (block) out.push(SEP);
    walk(n, out);
    if (block) out.push(SEP);
  }
}

/**
 * The plain text of an XHTML rich-text fragment, or `undefined` when it will
 * not parse.
 *
 * **Never throws.** `parseXml` raises `PdfParseError` on malformed input and
 * real-world `/RC` is not guaranteed well formed, so a caller reducing one
 * inside a search must not be taken down by it.
 *
 * **A parse failure yields `undefined`, never the markup.** Falling back to the
 * raw source would reinstate exactly the defect this exists to fix — a caller
 * searching for `p` matching the tag name — and a regex strip would be a second
 * grammar to get wrong. One unreadable entry contributes nothing instead.
 */
export function richTextToPlain(markup: string): string | undefined {
  // parseXml returns ONE root, and a fragment legitimately has several — a bare
  // `<p>a</p><p>b</p>` would otherwise yield only the first, dropping content
  // silently, which is worse than reporting nothing. The wrapper also lets the
  // fragment keep its own XML declaration: `skipMisc` runs inside the child
  // loop, so a declaration among children is tolerated.
  let root: XmlNode;
  try {
    root = parseXml(new TextEncoder().encode(`<pdf4ts-rich>${markup}</pdf4ts-rich>`));
  } catch {
    return undefined;
  }

  const out: string[] = [];
  walk(root, out);
  return out.join('')
    // XHTML collapses whitespace: the newlines and indentation between tags are
    // layout, not content.
    .replace(/[ \t\r\n\f\v]+/g, ' ')
    // Then every run of block boundaries, with any spaces around it, is ONE break.
    .replace(/ ?\u0000[\u0000 ]*/g, '\n')
    .trim();
}
