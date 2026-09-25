import type { MetadataUpdate } from './metadata.js';
import { parseRdfPacket, serializeRdfPacket, stripNonXmlChars, type RdfPacket, type RdfProperty, type RdfValue } from './xmprdf.js';
import { rethrowLimit } from './errors.js';
import { LoadLimits } from './loadlimits.js';
import { pdfDateToIso, isoToPdfDate } from './pdfdate.js';

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
  pdfaRev?: number;               // pdfaid:rev (PDF/A-4 identification; 2020)
  pdfuaPart?: number;             // pdfuaid:part (PDF/UA identification)
  pdfuaRev?: number;              // pdfuaid:rev (PDF/UA-2 identification; 2024)
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

/** An identification property's value: the attribute form, else the element
 *  form. `prop` is a controlled schema literal (e.g. 'pdfaid:part'), so no
 *  regex-escaping — the rule `matchBlock` already follows.
 *
 *  Note the `*` rather than `+`, and it is the whole of `ugxr`: an EMPTY value
 *  is a present property with an invalid value, not a missing one, and a `+`
 *  made the two indistinguishable. `scalar` has always matched `([^"]*)` for
 *  every other property, so the five identification fields were the outliers
 *  in their own module — which is how a packet declaring pdfaid:conformance=""
 *  read back as conformant. */
function idValue(xml: string, prop: string): string | undefined {
  const m = new RegExp(`${prop}\\s*=\\s*["']([^"']*)["']`).exec(xml)
    ?? new RegExp(`<${prop}>\\s*([^<]*?)\\s*</${prop}>`).exec(xml);
  return m ? m[1].trim() : undefined;
}

/** An identification property typed as a number. An empty or blank value is
 *  NaN, never `Number('')`'s 0 — a 0 reads as a document CLAIMING part 0,
 *  where NaN says "present, not a number" and is what junk (part="x") already
 *  yields. One rule for empty and junk rather than two. */
function idNumber(xml: string, prop: string): number | undefined {
  const v = idValue(xml, prop);
  if (v === undefined) return undefined;
  return v === '' ? NaN : Number(v);
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

  // ISO 19005-4 6.7.3-5 requires pdfaid:rev="2020"; parts 1-3 have no rev
  // property at all, so an absent one stays absent rather than defaulting.
  const part = idNumber(raw, 'pdfaid:part'); if (part !== undefined) meta.pdfaPart = part;
  const conf = idValue(raw, 'pdfaid:conformance'); if (conf !== undefined) meta.pdfaConformance = conf;
  const rev = idNumber(raw, 'pdfaid:rev'); if (rev !== undefined) meta.pdfaRev = rev;
  const uaPart = idNumber(raw, 'pdfuaid:part'); if (uaPart !== undefined) meta.pdfuaPart = uaPart;
  const uaRev = idNumber(raw, 'pdfuaid:rev'); if (uaRev !== undefined) meta.pdfuaRev = uaRev;
  const xVersion = idValue(raw, 'pdfxid:GTS_PDFXVersion');
  if (xVersion !== undefined) meta.pdfxVersion = xVersion;

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
  // Attribute form too (`o6uu.7`): `<rdf:Description acme:Batch="B1">` is the
  // same property, and the first rewrite moves it to element form — reading
  // only elements made `custom`'s reach change after one SetXmp. Reserved
  // prefixes (rdf, xml, xmlns, …) are absent from `ns`, so they skip here too.
  for (const tag of xml.matchAll(/<rdf:Description\b([^>]*)>/g)) {
    for (const m of tag[1].matchAll(/([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const namespace = ns.get(m[1]);
      if (namespace === undefined) continue;
      out.push({ namespace, prefix: m[1], name: m[2], value: unescapeXml(m[3] ?? m[4] ?? '') });
    }
  }
  return out;
}

/** A partial XMP update: each known field may be set, or `null` to delete. */
export type XmpUpdate = { [K in keyof Omit<XmpMetadata, 'raw'>]?: XmpMetadata[K] | null };

/** A scalar's text as the packet WROTE it (`o6uu.4`): `metasync.ts`'s
 *  fallback for an unparseable packet reads dates this way, since `readXmp`'s
 *  own `Date` is built with `new Date(s)` and so depends on the local zone. */
export { scalar as xmpScalar };

/** An XMP date's text. A string that reads as a `D:` date and NOT as an XMP
 *  one is converted (`o6uu.4`) — that is a caller handing /Info syntax to the
 *  XMP side; anything else is written as given, as it always was. */
function dateStr(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  const s = String(d);
  return isoToPdfDate(s) === undefined ? pdfDateToIso(s) ?? s : s;
}

export const NS = {
  dc: 'http://purl.org/dc/elements/1.1/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  pdfaid: 'http://www.aiim.org/pdfa/ns/id/',
  pdfuaid: 'http://www.aiim.org/pdfua/ns/id/',
  pdfxid: 'http://www.npes.org/pdfx/ns/id/',
} as const;

type FieldKind = 'alt' | 'seq' | 'bag' | 'text' | 'date';

/** Every field of `XmpMetadata` but `custom`, as the property it owns. The
 *  declaration ORDER is the order fields are appended to a packet that lacks
 *  them, so a fresh packet reads in the order `buildXmp` always wrote. */
const FIELDS: [Exclude<keyof XmpUpdate, 'custom'>, string, string, FieldKind][] = [
  ['title', NS.dc, 'title', 'alt'],
  ['authors', NS.dc, 'creator', 'seq'],
  ['description', NS.dc, 'description', 'alt'],
  ['subjects', NS.dc, 'subject', 'bag'],
  ['rights', NS.dc, 'rights', 'alt'],
  ['keywords', NS.pdf, 'Keywords', 'text'],
  ['producer', NS.pdf, 'Producer', 'text'],
  ['creatorTool', NS.xmp, 'CreatorTool', 'text'],
  ['createDate', NS.xmp, 'CreateDate', 'date'],
  ['modifyDate', NS.xmp, 'ModifyDate', 'date'],
  ['pdfaPart', NS.pdfaid, 'part', 'text'],
  ['pdfaConformance', NS.pdfaid, 'conformance', 'text'],
  ['pdfaRev', NS.pdfaid, 'rev', 'text'],
  ['pdfuaPart', NS.pdfuaid, 'part', 'text'],
  ['pdfuaRev', NS.pdfuaid, 'rev', 'text'],
  ['pdfxVersion', NS.pdfxid, 'GTS_PDFXVersion', 'text'],
];

const simpleValue = (v: unknown) => ({ kind: 'simple' as const, value: stripNonXmlChars(String(v)) });

/** Apply `update` to `packet` in place. `current` is what `readXmp` reported
 *  for the packet being edited — the scope of `custom`'s removal. */
function applyXmpUpdate(packet: RdfPacket, update: XmpUpdate, current: XmpProperty[] | undefined): void {
  const props = packet.properties;
  const at = (ns: string, name: string) => props.findIndex((p) => p.ns === ns && p.name === name);
  const put = (p: RdfProperty) => { const i = at(p.ns, p.name); if (i < 0) props.push(p); else props[i] = p; };
  const del = (ns: string, name: string) => { const i = at(ns, name); if (i >= 0) props.splice(i, 1); };

  for (const [key, ns, name, kind] of FIELDS) {
    const v = update[key];
    if (v === undefined) continue;
    if (v === null) { del(ns, name); continue; }
    if (kind === 'alt') {
      // Only x-default is ours: every other language is somebody's translation.
      const old = props[at(ns, name)]?.value;
      const items = old?.kind === 'array' && old.form === 'Alt' ? [...old.items] : [];
      const item = { value: simpleValue(v), lang: 'x-default' };
      // x-default goes FIRST whether it was there or not: XMP orders it so, and
      // readXmp's altText reads items[0] — replacing it in place behind an
      // `en` item made GetXmp().title report the English text after the edit.
      const i = items.findIndex((it) => it.lang?.toLowerCase() === 'x-default');
      if (i >= 0) items.splice(i, 1);
      items.unshift(item);
      put({ ns, name, value: { kind: 'array', form: 'Alt', items } });
    } else if (kind === 'seq' || kind === 'bag') {
      const list = v as string[];
      if (list.length === 0) del(ns, name);
      else put({ ns, name, value: { kind: 'array', form: kind === 'seq' ? 'Seq' : 'Bag',
        items: list.map((s) => ({ value: simpleValue(s) })) } });
    } else if (kind === 'date') put({ ns, name, value: simpleValue(dateStr(v as Date | string)) });
    else put({ ns, name, value: simpleValue(v) });
  }

  if (update.custom !== undefined) {
    // Top-level only: readXmp's scan also reports literal FIELDS of structs,
    // which are not properties of the packet and are not ours to remove —
    // nor to ADD back: `SetXmp({ custom: [...GetXmp().custom, mine] })` is the
    // obvious way to add one property, and hoisting every History field to
    // the top level corrupts the packet we just took care to keep.
    const key = (ns: string, name: string) => `${ns}\u0000${name}`;
    const topLevel = new Set(props.map((p) => key(p.ns, p.name)));
    const nested = new Set((current ?? []).map((c) => key(c.namespace, c.name)).filter((k) => !topLevel.has(k)));
    // A property the new set keeps is replaced IN PLACE, like every field; only
    // the ones it drops are deleted.
    const keep = new Set((update.custom ?? []).map((c) => key(c.namespace, c.name)));
    for (const c of current ?? []) if (!keep.has(key(c.namespace, c.name))) del(c.namespace, c.name);
    for (const c of update.custom ?? []) {
      if (nested.has(key(c.namespace, c.name))) continue;
      // The prefix the caller asked for wins (`o6uu.7`): a surviving foreign
      // namespace holding it would otherwise take it first, and the caller's
      // namespace would be written — and read back — as nsN.
      claimPrefix(packet, c.namespace, c.prefix);
      put({ ns: c.namespace, name: c.name, value: simpleValue(c.value) });
    }
  }
}

/** Strip characters XML cannot carry from everything in the model, PRESERVED
 *  content included. `parseXml` decodes character references, so a packet
 *  holding `&#x1;` parses fine and then cannot be written back — and every
 *  metadata write, PDF/A conversion included, would throw on a file it used
 *  to handle. */
function sanitize(props: RdfProperty[]): void {
  const value = (v: RdfValue): RdfValue => {
    if (v.kind === 'simple') return { ...v, value: stripNonXmlChars(v.value) };
    if (v.kind === 'array') return { ...v, items: v.items.map((it) => {
      const out = { ...it, value: value(it.value) };
      if (it.lang !== undefined) out.lang = stripNonXmlChars(it.lang);
      if (it.qualifiers) { out.qualifiers = [...it.qualifiers]; sanitize(out.qualifiers); }
      return out;
    }) };
    const fields = [...v.fields];
    sanitize(fields);
    return { ...v, fields };
  };
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const out: RdfProperty = { ...p, ns: stripNonXmlChars(p.ns), value: value(p.value) };
    if (p.lang !== undefined) out.lang = stripNonXmlChars(p.lang);
    if (p.qualifiers) { out.qualifiers = [...p.qualifiers]; sanitize(out.qualifiers); }
    props[i] = out;
  }
}

/** The six built-in namespaces go out under their standard prefixes, whatever
 *  the source bound them to: `readXmp`, `pdfaIdValue` and `xmpVersion` match
 *  `dc:`, `pdfaid:` … LITERALLY. A foreign namespace that claimed one of those
 *  prefixes loses the claim and the serializer renames it. */
function pinBuiltinPrefixes(packet: RdfPacket): RdfPacket {
  const std = new Map<string, string>(Object.entries(NS).map(([p, ns]) => [ns, p]));
  const taken = new Set(std.values());
  const prefixes = new Map<string, string>();
  for (const [ns, p] of packet.prefixes) if (!std.has(ns) && !taken.has(p)) prefixes.set(ns, p);
  for (const [ns, p] of std) prefixes.set(ns, p);
  return { ...packet, prefixes };
}

/** The model to edit: the packet's own when it parses, else a rebuild from
 *  the fields `readXmp` can see — exactly what survived before `o6uu.3`. */
function startModel(existing: Uint8Array | undefined, limits: LoadLimits): { packet: RdfPacket; current: XmpMetadata } {
  if (existing === undefined) return { packet: { properties: [], prefixes: new Map() }, current: {} };
  const current = readXmp(existing);
  try {
    return { packet: parseRdfPacket(new TextEncoder().encode(current.raw ?? ''), limits), current };
  } catch (e) {
    rethrowLimit(e);
    const packet: RdfPacket = { properties: [], prefixes: new Map() };
    const custom = (current.custom ?? []).filter((c) => {
      try { validateCustom([c]); return true; } catch (err) { rethrowLimit(err); return false; }
    });
    applyXmpUpdate(packet, { ...current, custom }, undefined);
    return { packet, current };
  }
}

/** Apply `update` to the XMP packet `existing` and return the packet text
 *  (`o6uu.3`). Everything the update does not name survives — History,
 *  qualified identifiers, extension schemas, other languages. `undefined`
 *  means "write nothing": there was no packet and the result is empty.
 *  `limits` are the DOCUMENT's (`o6uu.7`): a document opened with looser
 *  limits must be able to write the packet it was allowed to read. */
export function editXmpPacket(existing: Uint8Array | undefined, update: XmpUpdate,
  limits: LoadLimits = LoadLimits.defaults): string | undefined {
  if (update.custom) validateCustom(update.custom);
  const { packet, current } = startModel(existing, limits);
  applyXmpUpdate(packet, update, current.custom);
  if (existing === undefined && packet.properties.length === 0) return undefined;
  return writeXmpPacket(packet);
}

/** A model packet as the text `SetXmp` writes: characters XML cannot carry
 *  stripped, the six built-in namespaces pinned to their standard prefixes.
 *  The one owner of that tail, shared by `editXmpPacket` and the PDF/A
 *  extension-schema pass (`o6uu.6`). */
export function writeXmpPacket(packet: RdfPacket): string {
  sanitize(packet.properties);
  return serializeRdfPacket(pinBuiltinPrefixes(packet));
}

/** Bind `ns` to `prefix`, taking the prefix from any other namespace that
 *  holds it — the serializer prefers the model's binding, first come first
 *  served, so without this a surviving foreign namespace keeps it and the
 *  caller's is written as nsN (`o6uu.7`). Shared by `custom` and
 *  `SetXmpValue` (`o6uu.8`). */
export function claimPrefix(packet: RdfPacket, ns: string, prefix: string): void {
  for (const [other, p] of [...packet.prefixes]) if (p === prefix && other !== ns) packet.prefixes.delete(other);
  packet.prefixes.set(ns, prefix);
}

/** `editXmpPacket`'s edit path with the edit supplied by the caller
 *  (`o6uu.8`): parse (under `limits`), apply `edit`, write. `edit` returns
 *  whether it changed anything; `undefined` means write nothing, so a no-op
 *  leaves the document unmodified. */
export function editXmpPacketWith(existing: Uint8Array | undefined, edit: (p: RdfPacket) => boolean,
  limits: LoadLimits = LoadLimits.defaults): string | undefined {
  const { packet } = startModel(existing, limits);
  // An edit that leaves the packet as it was is NO edit (`o6uu.12`): a
  // rewrite would mark the document modified, and a later Sign() would then
  // rewrite bytes an earlier signature covered instead of appending.
  const before = writeXmpPacket(packet);
  if (!edit(packet)) return undefined;
  const after = writeXmpPacket(packet);
  return after === before ? undefined : after;
}

/** A fresh packet for `meta`, through the same edit `SetXmp` makes — so the
 *  two cannot disagree about layout. `raw` is ignored. */
export function buildXmp(meta: XmpMetadata): string {
  if (meta.custom) validateCustom(meta.custom);
  const packet: RdfPacket = { properties: [], prefixes: new Map() };
  applyXmpUpdate(packet, meta, undefined);
  return serializeRdfPacket(pinBuiltinPrefixes(packet));
}

/** Split an /Author scalar into ordered author items (drops empty segments). */
export function splitAuthors(s: string): string[] {
  return s.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

/** A STRING date is re-spelled in the other side's syntax (`o6uu.4`); one that
 *  does not read passes through as it always did. A `Date` is untouched, so
 *  every caller passing one writes the same bytes as before. */
function toIsoDate(v: Date | string | null): Date | string | null {
  return typeof v === 'string' ? pdfDateToIso(v) ?? v : v;
}
function toPdfDate(v: Date | string | null): Date | string | null {
  return typeof v === 'string' ? isoToPdfDate(v) ?? v : v;
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
  if (u.creationDate !== undefined) out.createDate = toIsoDate(u.creationDate);
  if (u.modDate !== undefined) out.modifyDate = toIsoDate(u.modDate);
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
  if (u.createDate !== undefined) out.creationDate = toPdfDate(u.createDate);
  if (u.modifyDate !== undefined) out.modDate = toPdfDate(u.modifyDate);
  return out;
}
