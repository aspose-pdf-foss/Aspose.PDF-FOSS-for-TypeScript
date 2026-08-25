import type { MetadataUpdate } from './metadata.js';

/** Structured view of a document's XMP packet (read side). */
export interface XmpMetadata {
  title?: string;                 // dc:title
  authors?: string[];             // dc:creator (ordered)
  description?: string;           // dc:description
  subjects?: string[];            // dc:subject
  keywords?: string;              // pdf:Keywords
  creatorTool?: string;           // xmp:CreatorTool
  producer?: string;              // pdf:Producer
  createDate?: Date | string;     // xmp:CreateDate
  modifyDate?: Date | string;     // xmp:ModifyDate
  rights?: string;                // dc:rights
  pdfaPart?: number;              // pdfaid:part (PDF/A identification)
  pdfaConformance?: string;       // pdfaid:conformance (A/B/U)
  pdfuaPart?: number;             // pdfuaid:part (PDF/UA identification)
  pdfxVersion?: string;           // pdfxid:GTS_PDFXVersion (PDF/X identification)
  /** Namespaced properties outside the schemas above — how a product stamps its
   *  own provenance, and how a PDF/A custom schema is carried. Simple literal
   *  values only: arrays, structs and language alternatives are not modelled. */
  custom?: XmpProperty[];
  /** Original decoded packet text, preserved for round-tripping. */
  raw?: string;
}

/** One custom XMP property: a value under `prefix:name`, with `prefix` bound to
 *  `namespace` on the packet. */
export interface XmpProperty {
  namespace: string;
  prefix: string;
  name: string;
  value: string;
}

/** Prefixes this module already binds; a custom property may not reuse one, and
 *  a custom-property scan must skip them. */
const RESERVED_PREFIXES = new Set([
  'rdf', 'x', 'xml', 'xmlns', 'dc', 'xmp', 'pdf', 'pdfaid', 'pdfuaid', 'pdfxid',
]);

/** An XML NCName: a element/prefix name with no colon. */
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Validate the custom property list; throws before anything is emitted. */
function validateCustom(props: XmpProperty[]): void {
  if (!Array.isArray(props)) throw new TypeError('custom property list must be an array');
  for (const p of props) {
    if (typeof p !== 'object' || p === null)
      throw new TypeError('custom property must be a { namespace, prefix, name, value } object');
    for (const k of ['namespace', 'prefix', 'name', 'value'] as const)
      if (typeof p[k] !== 'string')
        throw new TypeError(`custom property ${k} must be a string`);
    if (p.namespace === '') throw new TypeError('custom property namespace must be non-empty');
    if (!NCNAME.test(p.prefix)) throw new TypeError('custom property prefix must be an XML NCName');
    if (!NCNAME.test(p.name)) throw new TypeError('custom property name must be an XML NCName');
    if (RESERVED_PREFIXES.has(p.prefix))
      throw new TypeError(`custom property prefix "${p.prefix}" is reserved by a built-in schema`);
  }
}

/** Decode packet bytes to text, honoring a UTF-8 or UTF-16 BOM (default UTF-8). */
function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return s;
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Unescape the five XML predefined entities plus numeric character references.
 *  `&amp;` is resolved last so escaped entities are not double-decoded. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** Inner text of the first `<prop ...>…</prop>` element, or undefined. `prop`
 *  is a controlled schema literal (e.g. 'dc:title'), so no regex-escaping. */
function matchBlock(xml: string, prop: string): string | undefined {
  const m = new RegExp(`<${prop}(?:\\s[^>]*)?>([\\s\\S]*?)</${prop}>`).exec(xml);
  return m ? m[1] : undefined;
}

/** All `<rdf:li>…</rdf:li>` item texts within a container block. */
function liItems(block: string): string[] {
  const re = /<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(unescapeXml(m[1].trim()));
  return out;
}

/** First item of an rdf:Alt-style language container (falls back to bare text). */
function altText(xml: string, prop: string): string | undefined {
  const block = matchBlock(xml, prop);
  if (block === undefined) return undefined;
  const items = liItems(block);
  if (items.length) return items[0];
  const inner = block.trim();
  return inner.length && !inner.includes('<') ? unescapeXml(inner) : undefined;
}

/** All items of an rdf:Seq/rdf:Bag container, or undefined. */
function listItems(xml: string, prop: string): string[] | undefined {
  const block = matchBlock(xml, prop);
  if (block === undefined) return undefined;
  const items = liItems(block);
  return items.length ? items : undefined;
}

/** A scalar property: element text (no child markup), else a compact attribute. */
function scalar(xml: string, prop: string): string | undefined {
  const block = matchBlock(xml, prop);
  if (block !== undefined && !block.includes('<')) return unescapeXml(block.trim());
  const m = new RegExp(`\\b${prop}\\s*=\\s*"([^"]*)"|\\b${prop}\\s*=\\s*'([^']*)'`).exec(xml);
  if (m) return unescapeXml(m[1] ?? m[2] ?? '');
  return undefined;
}

/** Parse an ISO-8601 date, or keep the raw string when unparseable. */
function parseXmpDate(s: string): Date | string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d;
}

/** Parse an XMP packet's bytes into a structured XmpMetadata. Lenient: missing
 *  or malformed fields are skipped, never thrown; `raw` holds the packet text. */
export function readXmp(bytes: Uint8Array): XmpMetadata {
  const raw = decodeText(bytes);
  const meta: XmpMetadata = { raw };

  const title = altText(raw, 'dc:title'); if (title !== undefined) meta.title = title;
  const authors = listItems(raw, 'dc:creator'); if (authors) meta.authors = authors;
  const description = altText(raw, 'dc:description'); if (description !== undefined) meta.description = description;
  const subjects = listItems(raw, 'dc:subject'); if (subjects) meta.subjects = subjects;
  const rights = altText(raw, 'dc:rights'); if (rights !== undefined) meta.rights = rights;
  const keywords = scalar(raw, 'pdf:Keywords'); if (keywords !== undefined) meta.keywords = keywords;
  const producer = scalar(raw, 'pdf:Producer'); if (producer !== undefined) meta.producer = producer;
  const creatorTool = scalar(raw, 'xmp:CreatorTool'); if (creatorTool !== undefined) meta.creatorTool = creatorTool;
  const createDate = scalar(raw, 'xmp:CreateDate'); if (createDate !== undefined) meta.createDate = parseXmpDate(createDate);
  const modifyDate = scalar(raw, 'xmp:ModifyDate'); if (modifyDate !== undefined) meta.modifyDate = parseXmpDate(modifyDate);

  const partAttr = /pdfaid:part\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfaid:part>\s*([^<]+?)\s*<\/pdfaid:part>/.exec(raw);
  if (partAttr) meta.pdfaPart = Number(partAttr[1].trim());
  const confAttr = /pdfaid:conformance\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfaid:conformance>\s*([^<]+?)\s*<\/pdfaid:conformance>/.exec(raw);
  if (confAttr) meta.pdfaConformance = confAttr[1].trim();
  const uaPart = /pdfuaid:part\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfuaid:part>\s*([^<]+?)\s*<\/pdfuaid:part>/.exec(raw);
  if (uaPart) meta.pdfuaPart = Number(uaPart[1].trim());
  const xVersion = /pdfxid:GTS_PDFXVersion\s*=\s*["']([^"']+)["']/.exec(raw)
    ?? /<pdfxid:GTS_PDFXVersion>\s*([^<]+?)\s*<\/pdfxid:GTS_PDFXVersion>/.exec(raw);
  if (xVersion) meta.pdfxVersion = xVersion[1].trim();

  const custom = readCustom(raw);
  if (custom.length) meta.custom = custom;

  return meta;
}

/** Read every literal property whose prefix is not one of the built-in schemas,
 *  in document order. The prefix→namespace bindings come from the packet's own
 *  `xmlns:` declarations, so a property is reported with the namespace it was
 *  actually written under rather than one we assumed. */
function readCustom(xml: string): XmpProperty[] {
  const ns = new Map<string, string>();
  for (const m of xml.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']*)["']/g))
    if (!RESERVED_PREFIXES.has(m[1])) ns.set(m[1], unescapeXml(m[2]));
  if (ns.size === 0) return [];

  const out: XmpProperty[] = [];
  // Element form only, and only with no child markup: a container (rdf:Alt,
  // rdf:Seq, a struct) is outside what this models, and reporting its raw inner
  // XML as a literal value would round-trip to something different.
  for (const m of xml.matchAll(/<([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1:\2>/g)) {
    const namespace = ns.get(m[1]);
    if (namespace === undefined) continue;
    out.push({ namespace, prefix: m[1], name: m[2], value: unescapeXml(m[3].trim()) });
  }
  return out;
}

/** A partial XMP update: each known field may be set, or `null` to delete. */
export type XmpUpdate = { [K in keyof Omit<XmpMetadata, 'raw'>]?: XmpMetadata[K] | null };

/** Escape the five XML predefined entities (`&` first to avoid double-encoding). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function dateStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : String(d);
}

/** Emit a well-formed XMP packet for the known dc / xmp / pdf properties. Absent
 *  fields are omitted; `raw` is ignored (the packet is rebuilt from fields). */
export function buildXmp(meta: XmpMetadata): string {
  const lines: string[] = [];
  const alt = (tag: string, v: string) =>
    `   <${tag}><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt></${tag}>`;
  const container = (tag: string, kind: 'Seq' | 'Bag', items: string[]) =>
    `   <${tag}><rdf:${kind}>${items.map((i) => `<rdf:li>${escapeXml(i)}</rdf:li>`).join('')}</rdf:${kind}></${tag}>`;
  const simple = (tag: string, v: string) => `   <${tag}>${escapeXml(v)}</${tag}>`;

  if (meta.title !== undefined) lines.push(alt('dc:title', meta.title));
  if (meta.authors && meta.authors.length) lines.push(container('dc:creator', 'Seq', meta.authors));
  if (meta.description !== undefined) lines.push(alt('dc:description', meta.description));
  if (meta.subjects && meta.subjects.length) lines.push(container('dc:subject', 'Bag', meta.subjects));
  if (meta.rights !== undefined) lines.push(alt('dc:rights', meta.rights));
  if (meta.keywords !== undefined) lines.push(simple('pdf:Keywords', meta.keywords));
  if (meta.producer !== undefined) lines.push(simple('pdf:Producer', meta.producer));
  if (meta.creatorTool !== undefined) lines.push(simple('xmp:CreatorTool', meta.creatorTool));
  if (meta.createDate !== undefined) lines.push(simple('xmp:CreateDate', dateStr(meta.createDate)));
  if (meta.modifyDate !== undefined) lines.push(simple('xmp:ModifyDate', dateStr(meta.modifyDate)));

  const pdfaDesc = (meta.pdfaPart !== undefined || meta.pdfaConformance !== undefined)
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"`
      + (meta.pdfaPart !== undefined ? ` pdfaid:part="${meta.pdfaPart}"` : '')
      + (meta.pdfaConformance !== undefined ? ` pdfaid:conformance="${escapeXml(meta.pdfaConformance)}"` : '')
      + `/>`
    : '';

  const pdfuaDesc = meta.pdfuaPart !== undefined
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"`
      + ` pdfuaid:part="${meta.pdfuaPart}"/>`
    : '';

  // One rdf:Description per prefix, carrying that prefix's xmlns declaration.
  // Absent or empty `custom` contributes nothing, so a packet without custom
  // properties is byte-for-byte what it was before this field existed.
  let customDesc = '';
  if (meta.custom && meta.custom.length) {
    validateCustom(meta.custom);
    const byPrefix = new Map<string, XmpProperty[]>();
    for (const p of meta.custom) {
      const group = byPrefix.get(p.prefix);
      if (group) group.push(p); else byPrefix.set(p.prefix, [p]);
    }
    for (const [prefix, props] of byPrefix) {
      customDesc += `\n  <rdf:Description rdf:about="" xmlns:${prefix}="${escapeXml(props[0].namespace)}">`
        + props.map((p) => `\n   <${prefix}:${p.name}>${escapeXml(p.value)}</${prefix}:${p.name}>`).join('')
        + `\n  </rdf:Description>`;
    }
  }

  const pdfxDesc = meta.pdfxVersion !== undefined
    ? `\n  <rdf:Description rdf:about="" xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"`
      + ` pdfxid:GTS_PDFXVersion="${escapeXml(meta.pdfxVersion)}"/>`
    : '';

  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
${lines.join('\n')}
  </rdf:Description>${pdfaDesc}${pdfuaDesc}${pdfxDesc}${customDesc}
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Merge `update` over `current`: value sets, `null` deletes; `raw` is dropped. */
export function mergeXmp(current: XmpMetadata, update: XmpUpdate): XmpMetadata {
  const out: XmpMetadata = { ...current };
  delete out.raw;
  for (const key of Object.keys(update) as (keyof XmpUpdate)[]) {
    const v = update[key];
    if (v === undefined) continue;
    if (v === null) delete (out as Record<string, unknown>)[key];
    else (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Split an /Author scalar into ordered author items (drops empty segments). */
function splitAuthors(s: string): string[] {
  return s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/** Project the shared fields of an /Info MetadataUpdate onto an XmpUpdate. */
export function mirrorMetaToXmp(u: MetadataUpdate): XmpUpdate {
  const out: XmpUpdate = {};
  if (u.title !== undefined) out.title = u.title;
  if (u.author !== undefined) out.authors = u.author === null ? null : splitAuthors(u.author);
  if (u.subject !== undefined) out.description = u.subject;
  if (u.keywords !== undefined) out.keywords = u.keywords;
  if (u.creator !== undefined) out.creatorTool = u.creator;
  if (u.producer !== undefined) out.producer = u.producer;
  if (u.creationDate !== undefined) out.createDate = u.creationDate;
  if (u.modDate !== undefined) out.modifyDate = u.modDate;
  return out;
}

/** Project the shared fields of an XmpUpdate back onto an /Info MetadataUpdate. */
export function mirrorXmpToMeta(u: XmpUpdate): MetadataUpdate {
  const out: MetadataUpdate = {};
  if (u.title !== undefined) out.title = u.title;
  if (u.authors !== undefined) out.author = u.authors === null ? null : u.authors.join(', ');
  if (u.description !== undefined) out.subject = u.description;
  if (u.keywords !== undefined) out.keywords = u.keywords;
  if (u.creatorTool !== undefined) out.creator = u.creatorTool;
  if (u.producer !== undefined) out.producer = u.producer;
  if (u.createDate !== undefined) out.creationDate = u.createDate;
  if (u.modifyDate !== undefined) out.modDate = u.modifyDate;
  return out;
}
