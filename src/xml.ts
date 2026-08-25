import { PdfParseError } from './errors.js';

/** A parsed XML element. `text` is the concatenated direct text content
 *  (CDATA included, entities resolved); `raw` is the verbatim source between
 *  the start and end tags, so markup-bearing content can be carried through
 *  untouched. */
export interface XmlNode {
  /** Local name, namespace prefix stripped. */
  name: string;
  attrs: Map<string, string>;
  children: XmlNode[];
  text: string;
  /** Text chunks and child elements in source order. `children` and `text` keep
   *  their own meanings — all children, and all text concatenated — but neither
   *  records the interleaving between them, which mixed content (SVG <text>)
   *  needs. Populated by parseXml; hand-built writer trees leave it empty. */
  nodes: (XmlNode | string)[];
  raw?: string;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/g, (m, body: string) => {
    if (body[0] !== '#') return NAMED[body] ?? m;
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;');
}

/** Parse an XML document and return its root element. Throws PdfParseError on
 *  malformed input. Deliberately minimal: no DTD internal subsets, no
 *  namespace resolution (prefixes are stripped), no entity declarations. */
export function parseXml(bytes: Uint8Array): XmlNode {
  const src = new TextDecoder('utf-8').decode(bytes);
  let i = 0;

  const fail = (msg: string): never => { throw new PdfParseError(`XML: ${msg}`, i); };

  const skipSpace = (): void => { while (i < src.length && /\s/.test(src[i])) i++; };

  const skipTo = (close: string, what: string): void => {
    const e = src.indexOf(close, i);
    if (e < 0) fail(`unterminated ${what}`);
    i = e + close.length;
  };

  /** Comments, processing instructions and declarations, in any order. */
  const skipMisc = (): boolean => {
    if (src.startsWith('<!--', i)) { skipTo('-->', 'comment'); return true; }
    if (src.startsWith('<?', i)) { skipTo('?>', 'processing instruction'); return true; }
    if (src.startsWith('<!', i) && !src.startsWith('<![CDATA[', i)) { skipTo('>', 'declaration'); return true; }
    return false;
  };

  const readName = (): string => {
    const start = i;
    while (i < src.length && !/[\s/>=]/.test(src[i])) i++;
    if (i === start) fail('expected a name');
    const n = src.slice(start, i);
    const c = n.indexOf(':');
    return c < 0 ? n : n.slice(c + 1);
  };

  const parseElement = (): XmlNode => {
    if (src[i] !== '<') fail('expected <');
    i++;
    const name = readName();
    const attrs = new Map<string, string>();
    for (;;) {
      skipSpace();
      if (i >= src.length) fail(`unterminated start tag <${name}`);
      if (src.startsWith('/>', i)) { i += 2; return { name, attrs, children: [], text: '', nodes: [] }; }
      if (src[i] === '>') { i++; break; }
      const an = readName();
      skipSpace();
      if (src[i] !== '=') fail(`expected = after attribute ${an}`);
      i++;
      skipSpace();
      const q = src[i];
      if (q !== '"' && q !== "'") fail(`expected a quoted value for attribute ${an}`);
      i++;
      const e = src.indexOf(q, i);
      if (e < 0) fail(`unterminated value for attribute ${an}`);
      attrs.set(an, unescapeXml(src.slice(i, e)));
      i = e + 1;
    }

    const contentStart = i;
    const children: XmlNode[] = [];
    const nodes: (XmlNode | string)[] = [];
    let text = '';
    for (;;) {
      if (i >= src.length) fail(`unterminated element <${name}>`);
      if (src.startsWith('</', i)) {
        const contentEnd = i;
        i += 2;
        const close = readName();
        skipSpace();
        if (src[i] !== '>') fail(`unterminated end tag </${close}`);
        i++;
        if (close !== name) fail(`</${close}> closes <${name}>`);
        return { name, attrs, children, text, nodes, raw: src.slice(contentStart, contentEnd) };
      }
      if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i);
        if (e < 0) fail('unterminated CDATA');
        const chunk = src.slice(i + 9, e);
        text += chunk;
        nodes.push(chunk);
        i = e + 3;
        continue;
      }
      if (skipMisc()) continue;
      if (src[i] === '<') { const c = parseElement(); children.push(c); nodes.push(c); continue; }
      const nx = src.indexOf('<', i);
      const end = nx < 0 ? src.length : nx;
      const chunk = unescapeXml(src.slice(i, end));
      text += chunk;
      nodes.push(chunk);
      i = end;
    }
  };

  for (;;) { skipSpace(); if (!skipMisc()) break; }
  if (i >= src.length || src[i] !== '<') fail('no root element');
  return parseElement();
}

/** Serialize an element tree, with an XML declaration and two-space indent. */
export function writeXml(root: XmlNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>\n'];
  const emit = (n: XmlNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    let open = `${pad}<${n.name}`;
    for (const [k, v] of n.attrs) open += ` ${k}="${escapeXml(v)}"`;
    if (n.raw !== undefined) { out.push(`${open}>${n.raw}</${n.name}>\n`); return; }
    if (n.children.length === 0 && n.text === '') { out.push(`${open}/>\n`); return; }
    if (n.children.length === 0) { out.push(`${open}>${escapeXml(n.text)}</${n.name}>\n`); return; }
    out.push(`${open}>\n`);
    if (n.text.trim() !== '') out.push(`${'  '.repeat(depth + 1)}${escapeXml(n.text.trim())}\n`);
    for (const c of n.children) emit(c, depth + 1);
    out.push(`${pad}</${n.name}>\n`);
  };
  emit(root, 0);
  return out.join('');
}
