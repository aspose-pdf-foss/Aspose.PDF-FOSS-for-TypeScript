/** An inline <svg> subtree back to XML markup, so the existing importer — which
 *  takes SOURCE BYTES — can render it (zch2.12).
 *
 *  The round trip through parseXml is the real check: it is strict, so it
 *  rejects anything the serializer got wrong. */
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { parseXml } from '../src/xml.js';
import { serializeSvg } from '../src/svgserialize.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

/** The <svg> element of a parsed document. */
function svgOf(src: string): HtmlElement {
  const found: HtmlElement[] = [];
  const walk = (n: HtmlNode): void => {
    if (n.kind === 'element') {
      if (n.ns === 'svg' && n.name === 'svg') found.push(n);
      for (const k of n.children) walk(k);
    }
  };
  for (const n of parseHtml(src).children) walk(n);
  if (found.length === 0) throw new Error('no <svg> in fixture');
  return found[0];
}

const xml = (s: string): ReturnType<typeof parseXml> =>
  parseXml(new TextEncoder().encode(s));

describe('serializeSvg', () => {
  it('round-trips through the strict XML parser', () => {
    const out = serializeSvg(svgOf('<svg viewBox="0 0 10 10"><rect/></svg>'));
    expect(() => xml(out)).not.toThrow();
  });

  it('PRESERVES camelCase the parser already adjusted', () => {
    // linearGradient and viewBox are case-adjusted during parsing; lower-casing
    // them here — the obvious defensive move when writing XML from an HTML DOM
    // — breaks every gradient and every viewBox in every document.
    const out = serializeSvg(svgOf(
      '<svg viewBox="0 0 10 10"><lineargradient id="g"></lineargradient></svg>'));
    expect(out).toContain('viewBox=');
    expect(out).toContain('linearGradient');
  });

  it('turns an adjusted attribute display key back into a colon name', () => {
    // htmlforeign.ts stores xlink:href as `xlink href`, with a SPACE. Emitted
    // verbatim that is not a name parseXml can read.
    const out = serializeSvg(svgOf('<svg><use xlink:href="#a"/></svg>'));
    expect(out).toContain('xlink:href="#a"');
    expect(out).not.toContain('xlink href');
    expect(() => xml(out)).not.toThrow();
  });

  it('escapes attribute values and text', () => {
    const out = serializeSvg(svgOf(
      '<svg><title>a &amp; b &lt; c</title><rect id="q&quot;t"/></svg>'));
    expect(() => xml(out)).not.toThrow();
    expect(out).toContain('&amp;');
    expect(out).toContain('&lt;');
  });

  it('self-closes an empty element and keeps a non-empty one open', () => {
    const out = serializeSvg(svgOf('<svg><rect/><g><rect/></g></svg>'));
    expect(out).toContain('<rect/>');
    expect(out).toContain('</g>');
  });

  it('carries the whole subtree, nested', () => {
    const out = serializeSvg(svgOf(
      '<svg viewBox="0 0 4 4"><g><g><circle r="1"/></g></g></svg>'));
    const root = xml(out);
    expect(root.name).toBe('svg');
    expect(root.children[0].name).toBe('g');
  });

  it('drops a comment rather than emitting one', () => {
    // A comment carries no ink; the simplest correct thing is to leave it out.
    const out = serializeSvg(svgOf('<svg><!--note--><rect/></svg>'));
    expect(out).not.toContain('note');
    expect(() => xml(out)).not.toThrow();
  });
});
