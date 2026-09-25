import { parseXml, escapeXml, type XmlNode } from './xml.js';
import { PdfParseError } from './errors.js';
import { LoadLimits } from './loadlimits.js';

// The XMP data model: RDF/XML parsed into namespace-resolved properties, and
// written back in one canonical form (`o6uu.1`). Internal — `o6uu.3` puts it
// under `readXmp`/`buildXmp`, `o6uu.2` adds qualifiers and URI values.

export const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const X_NS = 'adobe:ns:meta/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** A property: a value under (namespace URI, local name). `lang` is its
 *  `xml:lang`; `qualifiers` are the general qualifiers of the `rdf:value` form
 *  (`o6uu.2`), themselves properties, so a qualifier may carry qualifiers. Both
 *  are absent, never empty, when the source states none. */
export interface RdfProperty { ns: string; name: string; value: RdfValue; lang?: string; qualifiers?: RdfProperty[] }

/** A language alternative is an `Alt` whose items carry `lang`; it has no kind
 *  of its own. A `uri` simple value was written as `rdf:resource` and is written
 *  back as one — a URI and a string that looks like one are different values. */
export type RdfValue =
  | { kind: 'simple'; value: string; uri?: true }
  | { kind: 'array'; form: 'Bag' | 'Seq' | 'Alt'; items: RdfItem[] }
  | { kind: 'struct'; fields: RdfProperty[] };

export interface RdfItem { value: RdfValue; lang?: string; qualifiers?: RdfProperty[] }

/** What a node holds once its syntax is read: the value and its qualification. */
interface NodeValue { value: RdfValue; lang: string | undefined; qualifiers?: RdfProperty[] }

export interface RdfPacket {
  properties: RdfProperty[];
  /** The Descriptions' `rdf:about` (`o6uu.5`) — which resource the packet
   *  describes. ABSENT when every Description stated it empty or not at all,
   *  which is what nearly every packet does. */
  about?: string;
  /** namespace URI → the prefix the source first bound it to; the serializer's
   *  preference, never part of the model's meaning. */
  prefixes: Map<string, string>;
}

type Scope = ReadonlyMap<string, string>;

/** The scope key holding the `xml:lang` in force (`o6uu.5`). A space cannot
 *  occur in a prefix, so it cannot collide with a namespace binding — which is
 *  what lets inheritance ride the scope `bind` already threads everywhere. */
const LANG = ' lang';

/** The language in force: RDF/XML inherits `xml:lang` into every literal
 *  below it, and `xml:lang=""` cancels an inherited one. */
const langIn = (scope: Scope): string | undefined => scope.get(LANG) || undefined;
const BASE_SCOPE: Scope = new Map([['xml', XML_NS]]);

function fail(msg: string): never {
  throw new PdfParseError(`XMP: ${msg}`);
}

/** Namespace resolution and the RDF syntax dispatch. One instance per parse,
 *  so `prefixes` collects every binding the packet makes. */
class Reader {
  readonly prefixes = new Map<string, string>();

  /** The scope in force inside `el`: its parent's plus its own `xmlns`
   *  declarations and `xml:lang`. Copies only when `el` declares something. */
  bind(el: XmlNode, parent: Scope): Scope {
    let scope: Map<string, string> | undefined;
    for (const [k, v] of el.attrs) {
      let p: string;
      if (k === 'xml:lang') p = LANG;
      else if (k === 'xmlns') p = '';
      else if (k.startsWith('xmlns:')) p = k.slice(6);
      else continue;
      scope ??= new Map(parent);
      scope.set(p, v);
      if (p !== '' && p !== LANG && v !== '' && !this.prefixes.has(v)) this.prefixes.set(v, p);
    }
    return scope ?? parent;
  }

  /** `qname` resolved, or undefined when its prefix is unbound. Used where an
   *  unbound name is "not the element we want" rather than an error — the
   *  packet root and the children of `x:xmpmeta`. */
  lookup(qname: string, scope: Scope): { ns: string; local: string } | undefined {
    const c = qname.indexOf(':');
    const ns = scope.get(c < 0 ? '' : qname.slice(0, c));
    return ns === undefined || ns === '' ? undefined : { ns, local: c < 0 ? qname : qname.slice(c + 1) };
  }

  resolve(qname: string, scope: Scope): { ns: string; local: string } {
    const q = this.lookup(qname, scope);
    if (q === undefined) {
      const c = qname.indexOf(':');
      const prefix = qname.slice(0, c);
      fail(c < 0 ? `<${qname}> has no namespace`
        : scope.get(prefix) === '' ? `prefix "${prefix}" is bound to the empty namespace, which XML Namespaces 1.0 does not allow`
          : `prefix "${prefix}" is not bound`);
    }
    // `parseXml` reads a name as any run up to a delimiter, so `a$b` gets
    // through. Refused here rather than at serialization, so a packet that
    // parses is always one the serializer can write back.
    if (!NCNAME.test(q.local)) fail(`${qname} is not an XML NCName`);
    return q;
  }

  /** An element's attributes split three ways: RDF control attributes by local
   *  name, its OWN `xml:lang` (a stated empty one reads as none), and property
   *  attributes — literals, so they take the language in force. Namespace
   *  declarations and unprefixed attributes (deprecated in RDF) are ignored. */
  attrs(el: XmlNode, scope: Scope): { rdf: Map<string, string>; lang: string | undefined; props: RdfProperty[] } {
    const rdf = new Map<string, string>();
    const props: RdfProperty[] = [];
    let lang: string | undefined;
    const inForce = langIn(scope);
    for (const [k, v] of el.attrs) {
      if (k === 'xmlns' || k.startsWith('xmlns:') || !k.includes(':')) continue;
      const { ns, local } = this.resolve(k, scope);
      if (ns === RDF_NS) rdf.set(local, v);
      else if (ns === XML_NS) { if (local === 'lang') lang = v || undefined; }
      else {
        const p: RdfProperty = { ns, name: local, value: { kind: 'simple', value: v } };
        if (inForce !== undefined) p.lang = inForce;
        props.push(p);
      }
    }
    return { rdf, lang, props };
  }

  /** The properties of an `rdf:Description`: attributes first, then elements.
   *  `scope` already includes `el`'s own bindings. */
  description(el: XmlNode, scope: Scope): { about: string; props: RdfProperty[] } {
    const a = this.attrs(el, scope);
    for (const k of a.rdf.keys()) if (k !== 'about') fail(`rdf:${k} is not supported on rdf:Description`);
    if (el.text.trim() !== '') fail('rdf:Description holds text');
    return { about: a.rdf.get('about') ?? '', props: [...a.props, ...el.children.map((c) => this.property(c, scope))] };
  }

  property(el: XmlNode, parent: Scope): RdfProperty {
    const scope = this.bind(el, parent);
    const { ns, local } = this.resolve(el.name, scope);
    if (ns === RDF_NS) fail(`<${el.name}> is not a property`);
    const n = this.value(el, scope);
    const p: RdfProperty = { ns, name: local, value: n.value };
    if (n.lang !== undefined) p.lang = n.lang;
    if (n.qualifiers?.length) p.qualifiers = n.qualifiers;
    return p;
  }

  item(el: XmlNode, parent: Scope): RdfItem {
    const scope = this.bind(el, parent);
    const { ns, local } = this.resolve(el.name, scope);
    if (ns !== RDF_NS || local !== 'li') fail(`<${el.name}> inside an array; expected rdf:li`);
    const n = this.value(el, scope);
    const it: RdfItem = { value: n.value };
    if (n.lang !== undefined) it.lang = n.lang;
    if (n.qualifiers?.length) it.qualifiers = n.qualifiers;
    return it;
  }

  /** The body of a resource node — a `parseType="Resource"` element or a nested
   *  `rdf:Description`. With an `rdf:value` (child element or attribute) it is
   *  a QUALIFIED value and everything else in it is a qualifier, in document
   *  order; without one it is a struct. RDF has no third reading: a struct
   *  holding `rdf:value` is, by definition, a value and its qualifiers. */
  resource(props: RdfProperty[], valueAttr: string | undefined, children: XmlNode[], scope: Scope, owner: string): NodeValue {
    let valueEl: XmlNode | undefined;
    let valueScope = scope;
    const rest: RdfProperty[] = [];
    for (const c of children) {
      const s = this.bind(c, scope);
      const q = this.resolve(c.name, s);
      if (q.ns === RDF_NS && q.local === 'value') {
        if (valueEl !== undefined || valueAttr !== undefined) fail(`<${owner}> holds more than one rdf:value`);
        valueEl = c;
        valueScope = s;
      } else rest.push(this.property(c, scope));
    }
    const others = [...props, ...rest];
    if (valueAttr !== undefined) return { value: { kind: 'simple', value: valueAttr }, lang: langIn(scope), qualifiers: others };
    if (valueEl === undefined) return { value: { kind: 'struct', fields: others }, lang: undefined };
    const inner = this.value(valueEl, valueScope);
    if (inner.qualifiers?.length) fail('rdf:value may not itself be qualified');
    return { value: inner.value, lang: inner.lang, qualifiers: others };
  }

  /** What a property element, `rdf:li` or `rdf:value` holds. `scope` already
   *  includes `el`'s own bindings. The dispatch order is the RDF/XML grammar's:
   *  parseType, then rdf:resource, then empty-or-text, then one child node. */
  value(el: XmlNode, scope: Scope): NodeValue {
    const a = this.attrs(el, scope);
    // xml:lang may sit on the node or on its rdf:value; both is fine only if
    // they agree.
    const withLang = (n: NodeValue): NodeValue => {
      if (a.lang !== undefined && n.lang !== undefined && a.lang !== n.lang)
        fail(`<${el.name}> has conflicting xml:lang "${a.lang}" and "${n.lang}"`);
      return { ...n, lang: a.lang ?? n.lang };
    };
    const ret = (value: RdfValue): NodeValue => ({ value, lang: a.lang });
    const hasText = el.text.trim() !== '';
    const parseType = a.rdf.get('parseType');
    const resource = a.rdf.get('resource');
    const valueAttr = a.rdf.get('value');
    for (const k of a.rdf.keys())
      if (k !== 'parseType' && k !== 'resource' && k !== 'value') fail(`rdf:${k} is not supported on <${el.name}>`);

    if (parseType !== undefined) {
      if (parseType !== 'Resource') fail(`rdf:parseType="${parseType}" is not supported`);
      if (hasText) fail(`<${el.name}> with rdf:parseType="Resource" holds text`);
      if (resource !== undefined) fail(`<${el.name}> has both rdf:parseType and rdf:resource`);
      return withLang(this.resource(a.props, valueAttr, el.children, scope, el.name));
    }
    if (resource !== undefined) {
      if (el.children.length || hasText || a.props.length || valueAttr !== undefined)
        fail(`<${el.name}> with rdf:resource has content`);
      return ret({ kind: 'simple', value: resource, uri: true });
    }
    if (valueAttr !== undefined) {
      if (el.children.length || hasText) fail(`<${el.name}> with rdf:value has content`);
      return withLang(this.resource(a.props, valueAttr, [], scope, el.name));
    }
    if (el.children.length === 0) {
      // A literal: it takes the language in force, its own or inherited.
      if (a.props.length === 0) return { value: { kind: 'simple', value: el.text }, lang: langIn(scope) };
      if (hasText) fail(`<${el.name}> holds both text and property attributes`);
      return ret({ kind: 'struct', fields: a.props });
    }
    if (hasText) fail(`<${el.name}> holds both text and elements`);
    if (a.props.length) fail(`<${el.name}> holds both property attributes and elements`);
    if (el.children.length !== 1) fail(`<${el.name}> holds more than one node`);

    const node = el.children[0];
    const nscope = this.bind(node, scope);
    const { ns, local } = this.resolve(node.name, nscope);
    if (ns !== RDF_NS) fail(`<${el.name}> holds <${node.name}>, not an RDF node`);
    if (local === 'Bag' || local === 'Seq' || local === 'Alt') {
      if (node.text.trim() !== '') fail(`rdf:${local} holds text`);
      // Its xml:lang reaches the items through `nscope`; anything else on an
      // array node has no place in the model, and is refused as it is
      // everywhere else rather than dropped.
      const na = this.attrs(node, nscope);
      for (const k of na.rdf.keys()) fail(`rdf:${k} is not supported on rdf:${local}`);
      if (na.props.length) fail(`rdf:${local} carries property attributes`);
      return ret({ kind: 'array', form: local, items: node.children.map((li) => this.item(li, nscope)) });
    }
    if (local === 'Description') {
      const d = this.attrs(node, nscope);
      for (const k of d.rdf.keys())
        if (k !== 'about' && k !== 'value') fail(`rdf:${k} is not supported on a nested rdf:Description`);
      if (node.text.trim() !== '') fail('rdf:Description holds text');
      return withLang(this.resource(d.props, d.rdf.get('value'), node.children, nscope, node.name));
    }
    return fail(`rdf:${local} is not supported as a value`);
  }
}

/** Parse an XMP packet (UTF-8 bytes) into its data model. Throws
 *  `PdfParseError` on anything that is not RDF this model can carry; leniency
 *  is the caller's decision.
 *
 *  DTDs are refused HERE: `parseXml` skips a `<!DOCTYPE>` rather than rejecting
 *  it, and an XMP packet has no business declaring entities. The test is on
 *  the decoded source, so a CDATA section containing that text is refused too
 *  — no real packet carries one. */
export function parseRdfPacket(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults): RdfPacket {
  const src = new TextDecoder('utf-8').decode(bytes);
  if (/<!(?:DOCTYPE|ENTITY)\b/.test(src)) fail('DTD and entity declarations are not allowed');
  const root = parseXml(bytes, limits, { qnames: true, normalize: true });
  const r = new Reader();
  const rootScope = r.bind(root, BASE_SCOPE);
  const rq = r.lookup(root.name, rootScope);

  let rdf: XmlNode | undefined;
  let rdfScope = rootScope;
  if (rq?.ns === RDF_NS && rq.local === 'RDF') rdf = root;
  else if (rq?.ns === X_NS && (rq.local === 'xmpmeta' || rq.local === 'xapmeta')) {
    for (const c of root.children) {
      const s = r.bind(c, rootScope);
      const q = r.lookup(c.name, s);
      if (q?.ns === RDF_NS && q.local === 'RDF') { rdf = c; rdfScope = s; break; }
    }
  } else fail(`<${root.name}> is not an XMP packet root`);
  if (rdf === undefined) fail('no rdf:RDF element');

  // Several Descriptions merge into one model (Ghostscript writes seven). A
  // property named twice is malformed XMP; the first occurrence is kept.
  // They must describe ONE resource: two differing non-empty rdf:about values
  // are refused, as Adobe's XMPCore refuses them; an empty or absent one is
  // compatible with any.
  const properties: RdfProperty[] = [];
  const seen = new Set<string>();
  let about = '';
  for (const d of rdf.children) {
    const s = r.bind(d, rdfScope);
    const q = r.resolve(d.name, s);
    if (q.ns !== RDF_NS || q.local !== 'Description') fail(`<${d.name}> inside rdf:RDF; expected rdf:Description`);
    const desc = r.description(d, s);
    if (desc.about !== '') {
      if (about !== '' && about !== desc.about) fail(`rdf:Description elements disagree on rdf:about ("${about}", "${desc.about}")`);
      about = desc.about;
    }
    for (const p of desc.props) {
      const key = `${p.ns}\u0000${p.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      properties.push(p);
    }
  }
  return about === '' ? { properties, prefixes: r.prefixes } : { properties, prefixes: r.prefixes, about };
}

/** An XML NCName, Unicode ranges included: Adobe writes a space in a property
 *  name as U+2182 plus hex (`Formↂ0020fields`), and an ASCII-only test would
 *  refuse a real IRS packet. */
const NCNAME = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}.\-\u00B7]*$/u;

/** Is `s` an XML NCName — Unicode ranges included? One owner of the test the
 *  parser and serializer apply, for callers that validate before writing
 *  (`xmpwrite.ts`, `o6uu.8`). */
export const isXmlNcName = (s: string): boolean => NCNAME.test(s);

/** A character outside XML 1.0's `Char` production: C0 controls other than
 *  tab/LF/CR, U+FFFE/U+FFFF, and a lone surrogate (which the `u` flag reads as
 *  its own code point). `escapeXml` cannot express one, and `parseXml`
 *  tolerates one, so without this check the round trip stays green while a
 *  conforming reader rejects the whole packet. */
const NOT_XML_CHAR = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/u;

function checkChars(s: string, what: string): void {
  if (NOT_XML_CHAR.test(s)) throw new TypeError(`XMP ${what} holds a character XML cannot carry`);
}

const NOT_XML_CHARS = new RegExp(NOT_XML_CHAR.source, 'gu');

/** `s` with every character XML 1.0 cannot carry removed — for values a
 *  caller hands us (`/Info` strings carry `\u0000` in the wild), where
 *  refusing would turn a metadata write that used to succeed into a throw. */
export function stripNonXmlChars(s: string): string {
  return s.replace(NOT_XML_CHARS, '');
}

const RESERVED_PREFIXES = new Set(['rdf', 'x', 'xml', 'xmlns']);

const WELL_KNOWN_PREFIXES = new Map<string, string>([
  ['http://purl.org/dc/elements/1.1/', 'dc'],
  ['http://ns.adobe.com/xap/1.0/', 'xmp'],
  ['http://ns.adobe.com/pdf/1.3/', 'pdf'],
  ['http://ns.adobe.com/xap/1.0/mm/', 'xmpMM'],
  ['http://ns.adobe.com/xap/1.0/sType/ResourceRef#', 'stRef'],
  ['http://ns.adobe.com/xap/1.0/sType/ResourceEvent#', 'stEvt'],
  ['http://www.aiim.org/pdfa/ns/id/', 'pdfaid'],
  ['http://www.aiim.org/pdfua/ns/id/', 'pdfuaid'],
  ['http://www.npes.org/pdfx/ns/id/', 'pdfxid'],
  ['http://www.aiim.org/pdfa/ns/extension/', 'pdfaExtension'],
  ['http://www.aiim.org/pdfa/ns/schema#', 'pdfaSchema'],
  ['http://www.aiim.org/pdfa/ns/property#', 'pdfaProperty'],
  ['http://www.aiim.org/pdfa/ns/type#', 'pdfaType'],
  ['http://www.aiim.org/pdfa/ns/field#', 'pdfaField'],
]);

/** The namespace the serializer binds a well-known `prefix` to, if any
 *  (`o6uu.8`). One table, so a caller validating a prefix before a write and
 *  the serializer choosing one cannot disagree about which are taken. */
export function wellKnownNamespace(prefix: string): string | undefined {
  for (const [ns, p] of WELL_KNOWN_PREFIXES) if (p === prefix) return ns;
  return undefined;
}

/** Element text, escaped so a conforming reader returns it exactly
 *  (`o6uu.5`): XML 2.11 turns a raw CR into LF on read, so it is written as a
 *  reference. `escapeXml` is shared with eight other writers and stays as is. */
const escText = (s: string) => escapeXml(s).replace(/\r/g, '&#xD;');

/** An attribute value, escaped likewise: XML 3.3.3 also turns a raw tab or LF
 *  in an attribute into a space, so those are written as references too. */
const escAttr = (s: string) =>
  escapeXml(s).replace(/[\t\n\r]/g, (c) => (c === '\t' ? '&#x9;' : c === '\n' ? '&#xA;' : '&#xD;'));

/** Write the model as one canonical packet: a single `rdf:Description`
 *  declaring every namespace, properties in model order, arrays and structs in
 *  element form. Throws `TypeError` on a model no packet can express. */
export function serializeRdfPacket(packet: RdfPacket): string {
  const used: string[] = [];
  const seen = new Set<string>();
  const visitValue = (v: RdfValue): void => {
    if (v.kind === 'simple') checkChars(v.value, 'value');
    else if (v.kind === 'array') for (const it of v.items) {
      if (it.lang !== undefined) checkChars(it.lang, 'xml:lang');
      visitValue(it.value);
      for (const q of it.qualifiers ?? []) visitProp(q);
    } else for (const f of v.fields) visitProp(f);
  };
  const visitProp = (p: RdfProperty): void => {
    if (typeof p.ns !== 'string' || p.ns === '') throw new TypeError('XMP property namespace must be a non-empty string');
    checkChars(p.ns, 'namespace');
    if (p.lang !== undefined) checkChars(p.lang, 'xml:lang');
    if (p.ns === RDF_NS || p.ns === XML_NS) throw new TypeError(`XMP property ${p.name} may not be in the ${p.ns} namespace`);
    if (typeof p.name !== 'string' || !NCNAME.test(p.name))
      throw new TypeError(`XMP property name "${String(p.name)}" is not an XML NCName`);
    if (!seen.has(p.ns)) { seen.add(p.ns); used.push(p.ns); }
    visitValue(p.value);
    for (const q of p.qualifiers ?? []) visitProp(q);
  };
  for (const p of packet.properties) visitProp(p);

  // First come, first served: the source's own prefix, else a well-known one,
  // else nsN — whichever is not already taken.
  const prefixOf = new Map<string, string>();
  const taken = new Set(RESERVED_PREFIXES);
  for (const ns of used) {
    let p = packet.prefixes.get(ns);
    if (p === undefined || !NCNAME.test(p) || taken.has(p)) p = WELL_KNOWN_PREFIXES.get(ns);
    if (p === undefined || taken.has(p)) {
      let i = 1;
      while (taken.has(`ns${i}`)) i++;
      p = `ns${i}`;
    }
    taken.add(p);
    prefixOf.set(ns, p);
  }

  const out: string[] = [];
  // `xml:lang` is INHERITED on read (`o6uu.5`), so every node is written
  // against the language in force above it: an attribute appears only where
  // the node's own language differs, and `xml:lang=""` where it has none
  // under an ancestor that has one. Without that, the literals inside a
  // language-bearing node come back tagged and the round trip breaks. A model
  // with no nested language writes exactly what it did before.
  const langAttr = (lang: string | undefined, inForce: string | undefined) =>
    (lang === inForce ? '' : ` xml:lang="${escAttr(lang ?? '')}"`);
  const qname = (p: RdfProperty) => `${prefixOf.get(p.ns)}:${p.name}`;
  // `lang` is the language in force INSIDE this element.
  const emit = (tag: string, attrs: string, v: RdfValue, lang: string | undefined, pad: string): void => {
    if (v.kind === 'simple') {
      if (v.uri) out.push(`${pad}<${tag}${attrs} rdf:resource="${escAttr(v.value)}"/>`);
      else out.push(`${pad}<${tag}${attrs}>${escText(v.value)}</${tag}>`);
      return;
    }
    if (v.kind === 'array') {
      if (v.items.length === 0) { out.push(`${pad}<${tag}${attrs}><rdf:${v.form}/></${tag}>`); return; }
      out.push(`${pad}<${tag}${attrs}>`, `${pad} <rdf:${v.form}>`);
      for (const it of v.items) node('rdf:li', it.lang, it.value, it.qualifiers, lang, `${pad}  `);
      out.push(`${pad} </rdf:${v.form}>`, `${pad}</${tag}>`);
      return;
    }
    if (v.fields.length === 0) { out.push(`${pad}<${tag}${attrs} rdf:parseType="Resource"/>`); return; }
    out.push(`${pad}<${tag}${attrs} rdf:parseType="Resource">`);
    for (const f of v.fields) node(qname(f), f.lang, f.value, f.qualifiers, lang, `${pad} `);
    out.push(`${pad}</${tag}>`);
  };
  // A qualified node is always written in the element form, rdf:value first
  // and xml:lang on the node itself; the parser accepts every other spelling.
  const node = (tag: string, lang: string | undefined, v: RdfValue, qualifiers: RdfProperty[] | undefined,
    inForce: string | undefined, pad: string): void => {
    if (!qualifiers?.length) { emit(tag, langAttr(lang, inForce), v, lang, pad); return; }
    out.push(`${pad}<${tag}${langAttr(lang, inForce)} rdf:parseType="Resource">`);
    emit('rdf:value', '', v, lang, `${pad} `);
    for (const q of qualifiers) node(qname(q), q.lang, q.value, q.qualifiers, lang, `${pad} `);
    out.push(`${pad}</${tag}>`);
  };
  for (const p of packet.properties) node(qname(p), p.lang, p.value, p.qualifiers, undefined, '   ');

  const decls = used.map((ns) => `\n    xmlns:${prefixOf.get(ns)}="${escAttr(ns)}"`).join('');
  const body = out.length ? `${out.join('\n')}\n` : '';
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="${RDF_NS}">
  <rdf:Description rdf:about="${escAttr(packet.about ?? '')}"${decls}>
${body}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
