import { isXmlNcName, RDF_NS, wellKnownNamespace, stripNonXmlChars, type RdfValue } from './xmprdf.js';

/** A typed XMP value for `doc.SetXmpValue` (`o6uu.8`): plain JavaScript for
 *  scalars, a tagged object for everything plain values cannot say — an
 *  ordered Seq and an unordered Bag are both "an array", and a URI and a
 *  string that looks like one are different values (`o6uu.2`). A leaf over
 *  `xmprdf.ts`; it never touches a `Document`. */
export type XmpValueInput =
  | string | number | boolean | Date
  | { seq: XmpValueInput[] } | { bag: XmpValueInput[] } | { alt: XmpValueInput[] }
  | { lang: Record<string, string> }
  | { uri: string }
  | { struct: { namespace: string; name: string; value: XmpValueInput }[] };

export interface XmpWriteOptions {
  /** The prefix to write the namespace under. It wins over a foreign
   *  namespace already holding it (`o6uu.7`'s rule). */
  prefix?: string;
}

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Prefixes XML itself binds; `xmlns` is bound to none and so is refused for
 *  every namespace. */
const XML_RESERVED: ReadonlyMap<string, string> = new Map([
  ['rdf', RDF_NS], ['x', 'adobe:ns:meta/'], ['xml', XML_NS], ['xmlns', ''],
]);

/** The namespace `prefix` is reserved for: XML's own, or one the serializer
 *  gives a well-known namespace. A caller claiming such a prefix for another
 *  namespace would lose it to the real one — or push the real one to nsN. */
const reservedFor = (prefix: string): string | undefined => XML_RESERVED.get(prefix) ?? wellKnownNamespace(prefix);

/** XMP dates are four-digit years (ISO 8601 as XMP profiles it); outside
 *  0..9999 `toISOString` writes an expanded ±YYYYYY year no reader accepts. */
const MAX_YEAR = 9999;

const TAGS = ['seq', 'bag', 'alt', 'lang', 'uri', 'struct'] as const;
type Tag = (typeof TAGS)[number];

function tagOf(v: object): Tag {
  const keys = Object.keys(v);
  const tag = keys[0] as Tag;
  if (keys.length !== 1 || !TAGS.includes(tag))
    throw new TypeError(`XMP value must be a string, number, boolean, Date or one of { ${TAGS.join(' | ')} }`);
  return tag;
}

/** A language tag's SYNTAX: subtags of letters and digits joined by single
 *  hyphens — RFC 5646's alphabet, which is what `xml:lang` carries and what
 *  `langmatch.ts` compares on. Not a registry check; `x-default` passes. */
const LANG_TAG = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

function checkNamespace(ns: unknown, what: string): void {
  if (typeof ns !== 'string' || ns === '') throw new TypeError(`${what} namespace must be a non-empty string`);
  // The serializer strips what XML cannot carry, so such a namespace would be
  // written as a DIFFERENT URI and GetXmpValue(ns) would miss it (`o6uu.12`).
  if (stripNonXmlChars(ns) !== ns) throw new TypeError(`${what} namespace holds a character XML cannot carry`);
  if (ns === RDF_NS || ns === XML_NS) throw new TypeError(`${what} may not be in the ${ns} namespace`);
}

function checkValue(v: unknown, at: string): void {
  if (typeof v === 'string' || typeof v === 'boolean') return;
  if (typeof v === 'number') {
    // A non-finite number has no XMP spelling, and String() switches to
    // exponent notation past 1e21 and below 1e-6 — text asReal() refuses.
    if (!Number.isFinite(v) || /e/i.test(String(v)))
      throw new TypeError(`${at}: ${v} has no plain decimal spelling for XMP`);
    return;
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError(`${at}: invalid Date`);
    const year = v.getUTCFullYear();
    if (year < 0 || year > MAX_YEAR) throw new RangeError(`${at}: year ${year} is outside the 0-${MAX_YEAR} an XMP date can hold`);
    return;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new TypeError(`${at}: XMP value must be a string, number, boolean, Date or a tagged object`);
  const tag = tagOf(v);
  const body = (v as Record<string, unknown>)[tag];
  switch (tag) {
    case 'seq': case 'bag': case 'alt':
      if (!Array.isArray(body)) throw new TypeError(`${at}: { ${tag} } must hold an array`);
      body.forEach((item, i) => checkValue(item, `${at}[${i}]`));
      return;
    case 'lang': {
      const entries = body !== null && typeof body === 'object' && !Array.isArray(body) ? Object.entries(body) : [];
      if (entries.length === 0) throw new TypeError(`${at}: { lang } must map at least one language tag to text`);
      const seen = new Set<string>();
      for (const [tagName, text] of entries) {
        if (tagName === '' || typeof text !== 'string') throw new TypeError(`${at}: { lang } maps a tag to text`);
        if (!LANG_TAG.test(tagName)) throw new RangeError(`${at}: "${tagName}" is not a language tag`);
        // Tags compare ignoring case, so two spellings of one would write an
        // Alt holding the same language twice (`o6uu.12`).
        const key = tagName.toLowerCase();
        if (seen.has(key)) throw new RangeError(`${at}: { lang } names ${tagName} twice, ignoring case`);
        seen.add(key);
      }
      return;
    }
    case 'uri':
      if (typeof body !== 'string') throw new TypeError(`${at}: { uri } must be a string`);
      return;
    case 'struct':
      if (!Array.isArray(body)) throw new TypeError(`${at}: { struct } must hold an array of fields`);
      body.forEach((f: unknown, i) => {
        const field = f as { namespace?: unknown; name?: unknown; value?: unknown } | null;
        if (field === null || typeof field !== 'object') throw new TypeError(`${at}.struct[${i}] must be { namespace, name, value }`);
        checkNamespace(field.namespace, `${at}.struct[${i}]`);
        if (typeof field.name !== 'string' || !isXmlNcName(field.name))
          throw new TypeError(`${at}.struct[${i}] name must be an XML NCName`);
        checkValue(field.value, `${at}.struct[${i}]`);
      });
  }
}

/** Validate a whole write before anything is touched, so a rejected call
 *  leaves the document byte-identical. `value` null is a delete. */
export function checkXmpWrite(namespaceUri: string, name: string, value: XmpValueInput | null, opts: XmpWriteOptions): void {
  checkNamespace(namespaceUri, 'XMP property');
  if (typeof name !== 'string' || !isXmlNcName(name)) throw new TypeError('XMP property name must be an XML NCName');
  if (opts.prefix !== undefined) {
    if (typeof opts.prefix !== 'string' || !isXmlNcName(opts.prefix)) throw new TypeError('XMP prefix must be an XML NCName');
    const owner = reservedFor(opts.prefix);
    if (owner !== undefined && owner !== namespaceUri)
      throw new RangeError(`XMP prefix "${opts.prefix}" is reserved for ${owner === '' ? 'namespace declarations' : owner}`);
  }
  if (value !== null) checkValue(value, `${name}`);
}

/** The model value for a CHECKED input. */
export function toRdfValue(v: XmpValueInput): RdfValue {
  if (typeof v === 'string') return { kind: 'simple', value: v };
  if (typeof v === 'number') return { kind: 'simple', value: String(v) };
  if (typeof v === 'boolean') return { kind: 'simple', value: v ? 'True' : 'False' };
  if (v instanceof Date) return { kind: 'simple', value: v.toISOString() };
  if ('seq' in v) return { kind: 'array', form: 'Seq', items: v.seq.map((i) => ({ value: toRdfValue(i) })) };
  if ('bag' in v) return { kind: 'array', form: 'Bag', items: v.bag.map((i) => ({ value: toRdfValue(i) })) };
  if ('alt' in v) return { kind: 'array', form: 'Alt', items: v.alt.map((i) => ({ value: toRdfValue(i) })) };
  if ('lang' in v) {
    // x-default FIRST: readXmp's altText and every viewer read items[0].
    const entries = Object.entries(v.lang).sort(([a], [b]) =>
      Number(b.toLowerCase() === 'x-default') - Number(a.toLowerCase() === 'x-default'));
    return { kind: 'array', form: 'Alt', items: entries.map(([lang, text]) => ({ value: { kind: 'simple', value: text }, lang })) };
  }
  if ('uri' in v) return { kind: 'simple', value: v.uri, uri: true };
  return { kind: 'struct', fields: v.struct.map((f) => ({ ns: f.namespace, name: f.name, value: toRdfValue(f.value) })) };
}
