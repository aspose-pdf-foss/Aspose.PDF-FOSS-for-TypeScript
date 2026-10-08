/** The computed style of the first `<tag>` in `html` (v9j3.4) — the
 *  computeStyles walk test/csscompute.test.ts uses, as a shared helper. */
import { parseHtml } from '../../src/htmltree.js';
import { computeStyles } from '../../src/csscompute.js';
import type { ComputedStyle } from '../../src/cssprop.js';
import type { HtmlElement, HtmlNode } from '../../src/htmldom.js';

export function cascadeStyleOf(html: string, tag: string): ComputedStyle {
  const doc = parseHtml(html);
  const r = computeStyles(doc);
  let found: HtmlElement | undefined;
  const walk = (x: HtmlNode): void => {
    if (found) return;
    if (x.kind === 'element' && x.name === tag) { found = x; return; }
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') for (const c of x.children) walk(c);
  };
  walk(doc);
  const s = found && r.styles.get(found);
  if (s === undefined) throw new Error(`no style for <${tag}>`);
  return s;
}
