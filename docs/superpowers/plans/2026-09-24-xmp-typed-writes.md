# Typed XMP Writes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.SetXmpValue(namespaceUri, name, value, opts?)` writes any top-level XMP property from a typed input, mirroring the eight /Info-shared properties, all-or-nothing.

**Architecture:** `src/xmpwrite.ts` is a leaf that validates an `XmpValueInput` and converts it to an `RdfValue`. `xmp.ts` gains `editXmpPacketWith`, the model-edit path `editXmpPacket` already runs, and `claimPrefix`, the o6uu.7 prefix rule, now shared. `Document.SetXmpValue` validates, computes the new packet text, mirrors /Info through `metasync.ts`'s own readers, and then installs the text.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-xmp-typed-writes-design.md`

## Global Constraints

- No runtime dependencies. Every `catch` in `src/` calls `rethrowLimit(e)` first.
- A rejected call leaves the document byte-identical: validate before any mutation.
- `TypeError` for the wrong kind of thing, `RangeError` for a prefix reserved for a different namespace.
- Every name exported from `index.ts` needs a README API Reference row, and the README count sentence must match `test/readme-api.test.ts`.
- CHANGELOG **Added** under `[Unreleased]`, citing `(o6uu.8)`, in the same commit as the change.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Before closing: `npm run typecheck` and `npm test` green.

## Review Focus

1. A number whose `String()` uses exponent notation (`1e21`, `1e-7`) must be refused. Otherwise the written text is something `asReal()` cannot read back. Pinned in Task 1.
2. A `lang` map with no `x-default`, or with `x-default` not first, must still read back sensibly: `x-default` is written first, and the mirror reads the first item. Pinned in Tasks 1 and 2.
3. Replacing an existing property must keep every other property (History, other schemas). Pinned in Task 2.
4. Deleting an absent property must leave the document unmodified, so a later `Sign()` stays incremental. Pinned in Task 2 through the sign path.
5. A reserved prefix naming its own namespace (`dc` for Dublin Core) must be allowed, and the same prefix for a different namespace refused. Pinned in Task 1.

---

### Task 1: `src/xmpwrite.ts` — validate and convert

**Files:**
- Create: `src/xmpwrite.ts`
- Modify: `src/xmprdf.ts` (export `isXmlNcName`)
- Test: `test/xmpwrite.test.ts`

**Interfaces:**
- Produces:
  - `export type XmpValueInput`, `export interface XmpWriteOptions { prefix?: string }`
  - `checkXmpWrite(namespaceUri: string, name: string, value: XmpValueInput | null, opts: XmpWriteOptions): void`
  - `toRdfValue(value: XmpValueInput): RdfValue`
  - `src/xmprdf.ts`: `isXmlNcName(s: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// test/xmpwrite.test.ts
import { describe, it, expect } from 'vitest';
import { checkXmpWrite, toRdfValue, type XmpValueInput } from '../src/xmpwrite.js';
import { XmpValue } from '../src/xmpvalue.js';
import { RDF_NS } from '../src/xmprdf.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const ACME = 'http://acme.example/ns/1.0/';
const read = (v: XmpValueInput) => new XmpValue(toRdfValue(v));
const ok = (v: XmpValueInput | null, prefix?: string) => () => checkXmpWrite(ACME, 'P', v, prefix === undefined ? {} : { prefix });

describe('toRdfValue round-trips through XmpValue', () => {
  it('scalars', () => {
    expect(read('hi').asText()).toBe('hi');
    expect(read(42).asInt()).toBe(42);
    expect(read(-2.5).asReal()).toBe(-2.5);
    expect(read(true).asBool()).toBe(true);
    expect(read(false).asBool()).toBe(false);
    const at = new Date(Date.UTC(2024, 5, 3, 12, 30, 45));
    expect(read(at).asDate()!.date).toEqual(at);
  });

  it('arrays keep their form and convert items recursively', () => {
    const seq = toRdfValue({ seq: ['a', 1] });
    expect(seq).toMatchObject({ kind: 'array', form: 'Seq' });
    expect(read({ bag: ['a', 'b'] }).asArray()!.map((x) => x.asText())).toEqual(['a', 'b']);
    expect(toRdfValue({ alt: ['x'] })).toMatchObject({ kind: 'array', form: 'Alt' });
    expect(read({ seq: [{ bag: ['n'] }] }).asArray()![0].asArray()![0].asText()).toBe('n');
  });

  it('a lang map writes x-default FIRST, whatever order it was given in', () => {
    const v = toRdfValue({ lang: { de: 'Hallo', 'x-default': 'Hello', fr: 'Bonjour' } });
    expect(v.kind === 'array' && v.items.map((i) => i.lang)).toEqual(['x-default', 'de', 'fr']);
    expect(read({ lang: { de: 'Hallo', 'x-default': 'Hello' } }).asText('de')).toBe('Hallo');
    expect(read({ lang: { de: 'Hallo', 'x-default': 'Hello' } }).asText()).toBe('Hello');
  });

  it('uri and struct', () => {
    expect(read({ uri: 'http://x' }).asUri()).toBe('http://x');
    expect(read({ uri: 'http://x' }).asText()).toBeUndefined();
    expect(toRdfValue({ struct: [{ namespace: ACME, name: 'a', value: 1 }] }))
      .toEqual({ kind: 'struct', fields: [{ ns: ACME, name: 'a', value: { kind: 'simple', value: '1' } }] });
  });
});

describe('checkXmpWrite', () => {
  it('accepts every shape, and null', () => {
    for (const v of ['s', 1, true, new Date(0), { seq: [] }, { bag: ['a'] }, { alt: ['a'] },
      { lang: { 'x-default': 'a' } }, { uri: 'u' }, { struct: [{ namespace: ACME, name: 'f', value: 'v' }] }, null] as const)
      expect(ok(v as XmpValueInput | null)).not.toThrow();
  });

  it('refuses the wrong kind of thing with TypeError', () => {
    for (const bad of [Number.NaN, Infinity, new Date(Number.NaN), ['bare array'], {}, { seq: [], bag: [] },
      { seq: 'x' }, { lang: {} }, { lang: { de: 1 } }, { uri: 1 }, { struct: [{ namespace: '', name: 'f', value: 'v' }] },
      { struct: [{ namespace: ACME, name: 'no space', value: 'v' }] }, { nope: 1 }, { seq: [null] }] as unknown[])
      expect(ok(bad as XmpValueInput), JSON.stringify(bad)).toThrow(TypeError);
  });

  it('refuses a number written in exponent notation, which asReal could not read back', () => {
    expect(ok(1e21)).toThrow(TypeError);
    expect(ok(1e-7)).toThrow(TypeError);
    expect(ok(123456789012345)).not.toThrow();
  });

  it('refuses a bad namespace, name or prefix with TypeError', () => {
    expect(() => checkXmpWrite('', 'P', 'v', {})).toThrow(TypeError);
    expect(() => checkXmpWrite(RDF_NS, 'P', 'v', {})).toThrow(TypeError);
    expect(() => checkXmpWrite('http://www.w3.org/XML/1998/namespace', 'P', 'v', {})).toThrow(TypeError);
    expect(() => checkXmpWrite(ACME, 'a b', 'v', {})).toThrow(TypeError);
    expect(ok('v', 'no:colon')).toThrow(TypeError);
  });

  it('refuses a reserved prefix for a DIFFERENT namespace with RangeError, and allows its own', () => {
    expect(ok('v', 'dc')).toThrow(RangeError);
    expect(ok('v', 'rdf')).toThrow(RangeError);
    expect(ok('v', 'xmlns')).toThrow(RangeError);
    expect(() => checkXmpWrite(DC, 'coverage', 'v', { prefix: 'dc' })).not.toThrow();
    expect(ok('v', 'acme')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmpwrite.test.ts`
Expected: FAIL — cannot resolve `../src/xmpwrite.js`.

- [ ] **Step 3: Export `isXmlNcName` from `src/xmprdf.ts`**

Directly after the `NCNAME` constant, add:

```ts
/** Is `s` an XML NCName — Unicode ranges included? One owner of the test the
 *  parser and serializer apply, for callers that validate before writing
 *  (`xmpwrite.ts`, `o6uu.8`). */
export const isXmlNcName = (s: string): boolean => NCNAME.test(s);
```

- [ ] **Step 4: Implement `src/xmpwrite.ts`**

```ts
import { isXmlNcName, RDF_NS, type RdfValue } from './xmprdf.js';

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

/** Prefixes bound to a fixed namespace; `xmlns` is bound to none and so is
 *  refused for every namespace. The built-ins are `xmp.ts`'s six. */
const RESERVED: ReadonlyMap<string, string> = new Map([
  ['rdf', RDF_NS], ['x', 'adobe:ns:meta/'], ['xml', XML_NS], ['xmlns', ''],
  ['dc', 'http://purl.org/dc/elements/1.1/'], ['xmp', 'http://ns.adobe.com/xap/1.0/'],
  ['pdf', 'http://ns.adobe.com/pdf/1.3/'], ['pdfaid', 'http://www.aiim.org/pdfa/ns/id/'],
  ['pdfuaid', 'http://www.aiim.org/pdfua/ns/id/'], ['pdfxid', 'http://www.npes.org/pdfx/ns/id/'],
]);

const TAGS = ['seq', 'bag', 'alt', 'lang', 'uri', 'struct'] as const;
type Tag = (typeof TAGS)[number];

function tagOf(v: object): Tag {
  const keys = Object.keys(v);
  const tag = keys[0] as Tag;
  if (keys.length !== 1 || !TAGS.includes(tag))
    throw new TypeError(`XMP value must be a string, number, boolean, Date or one of { ${TAGS.join(' | ')} }`);
  return tag;
}

function checkNamespace(ns: unknown, what: string): void {
  if (typeof ns !== 'string' || ns === '') throw new TypeError(`${what} namespace must be a non-empty string`);
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
      for (const [tagName, text] of entries)
        if (tagName === '' || typeof text !== 'string') throw new TypeError(`${at}: { lang } maps a tag to text`);
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
    const owner = RESERVED.get(opts.prefix);
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/xmpwrite.test.ts test/xmprdf.test.ts`
Expected: PASS. (`Array.prototype.sort` is stable, so the non-`x-default` tags keep their given order.)

- [ ] **Step 6: Commit**

```bash
git add src/xmpwrite.ts src/xmprdf.ts test/xmpwrite.test.ts
git commit -m "feat(o6uu.8): validate and convert typed XMP values"
```

---

### Task 2: `doc.SetXmpValue`

**Files:**
- Modify: `src/xmp.ts` (`claimPrefix`, `editXmpPacketWith`), `src/metasync.ts` (`mirroredField`), `src/document.ts`, `src/index.ts`, `README.md`, `CHANGELOG.md`
- Test: `test/xmp-set-value.test.ts`

**Interfaces:**
- Consumes: Task 1's `checkXmpWrite`, `toRdfValue`, `XmpValueInput`, `XmpWriteOptions`; `metasync.ts`'s `planSync`, `infoSide`, `xmpSide`, `MetadataField`.
- Produces:
  - `src/xmp.ts`: `claimPrefix(packet: RdfPacket, ns: string, prefix: string): void`; `editXmpPacketWith(existing: Uint8Array | undefined, edit: (p: RdfPacket) => boolean, limits?: LoadLimits): string | undefined`
  - `src/metasync.ts`: `mirroredField(ns: string, name: string): MetadataField | undefined`
  - `Document.SetXmpValue(namespaceUri: string, propName: string, value: XmpValueInput | null, opts?: XmpWriteOptions): void`

- [ ] **Step 1: Write the failing tests**

```ts
// test/xmp-set-value.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';
import { buildSigner } from './helpers/build-signer.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const ACME = 'http://acme.example/ns/1.0/';
const OTHER = 'http://other.example/ns/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const withXmp = (body: string, ns = '') => {
  const d = doc1();
  const text = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""`
    + ` xmlns:dc="${DC}" xmlns:xmpMM="${MM}" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"${ns}>`
    + `${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
  const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
  d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
  return d;
};
const HISTORY = '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action>'
  + '</rdf:li></rdf:Seq></xmpMM:History>';

describe('SetXmpValue writes and reads back', () => {
  it('writes each shape to a document with no packet yet', () => {
    const d = doc1();
    d.SetXmpValue(ACME, 'Count', 12);
    d.SetXmpValue(ACME, 'Ok', true);
    d.SetXmpValue(ACME, 'Tags', { bag: ['a', 'b'] });
    d.SetXmpValue(ACME, 'Home', { uri: 'http://acme.example/' });
    d.SetXmpValue(ACME, 'Where', { struct: [{ namespace: ACME, name: 'City', value: 'Oslo' }] });
    expect(d.GetXmpValue(ACME, 'Count')!.asInt()).toBe(12);
    expect(d.GetXmpValue(ACME, 'Ok')!.asBool()).toBe(true);
    expect(d.GetXmpValue(ACME, 'Tags')!.asArray()!.map((v) => v.asText())).toEqual(['a', 'b']);
    expect(d.GetXmpValue(ACME, 'Home')!.asUri()).toBe('http://acme.example/');
    expect(d.GetXmpValue(ACME, 'Where')!.raw).toEqual({ kind: 'struct', fields: [{ ns: ACME, name: 'City', value: { kind: 'simple', value: 'Oslo' } }] });
  });

  it('replaces an existing property and keeps everything it does not name', () => {
    const d = withXmp(HISTORY + '<dc:format>application/pdf</dc:format>');
    d.SetXmpValue(DC, 'format', 'text/plain');
    expect(d.GetXmpValue(DC, 'format')!.asText()).toBe('text/plain');
    expect(d.GetXmpValue(MM, 'History')!.asArray()).toHaveLength(1);
  });

  it('writes title translations, x-default first, and mirrors x-default to /Title', () => {
    const d = doc1();
    d.SetXmpValue(DC, 'title', { lang: { de: 'Bericht', 'x-default': 'Report' } });
    expect(d.GetXmpValue(DC, 'title')!.asText('de')).toBe('Bericht');
    expect(d.GetMetadata().title).toBe('Report');
    expect(d.GetXmp().title).toBe('Report');
  });

  it('deletes with null, and deleting an absent property marks nothing modified', async () => {
    const d0 = withXmp('<dc:format>application/pdf</dc:format>');
    d0.SetXmpValue(DC, 'format', null);
    expect(d0.GetXmpValue(DC, 'format')).toBeUndefined();
    const base = doc1().Save();
    const d = Document.Open(base);
    d.SetXmpValue(ACME, 'Absent', null);
    const s = buildSigner();
    await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(d.Save().subarray(0, base.length)).toEqual(base);
  });
});

describe('prefixes', () => {
  it('the caller\'s prefix wins over a foreign namespace that held it', () => {
    const d = withXmp('<acme:Old><rdf:Bag><rdf:li>o</rdf:li></rdf:Bag></acme:Old>', ` xmlns:acme="${OTHER}"`);
    d.SetXmpValue(ACME, 'Batch', 'B1', { prefix: 'acme' });
    expect(d.GetXmp().custom?.find((c) => c.namespace === ACME)?.prefix).toBe('acme');
  });

  it('without a prefix, the packet\'s own binding stands', () => {
    const d = withXmp('<acme:Old>o</acme:Old>', ` xmlns:acme="${ACME}"`);
    d.SetXmpValue(ACME, 'Batch', 'B1');
    expect(d.GetXmp().custom?.find((c) => c.name === 'Batch')?.prefix).toBe('acme');
  });
});

describe('the eight mirrored properties', () => {
  it('update /Info through the sync rules', () => {
    const d = doc1();
    d.SetXmpValue(DC, 'creator', { seq: ['A', 'B'] });
    d.SetXmpValue(DC, 'description', 'About');
    d.SetXmpValue(PDF, 'Keywords', 'k1, k2');
    d.SetXmpValue(XMP, 'CreatorTool', 'Tool');
    d.SetXmpValue(PDF, 'Producer', 'Prod');
    const at = new Date(Date.UTC(2024, 5, 3, 12, 30, 45));
    d.SetXmpValue(XMP, 'CreateDate', at);
    d.SetXmpValue(XMP, 'ModifyDate', '2024-06-03T14:30:45+02:00');
    const m = d.GetMetadata();
    expect(m).toMatchObject({ author: 'A, B', subject: 'About', keywords: 'k1, k2', creator: 'Tool', producer: 'Prod' });
    expect(m.creationDate).toEqual(at);
    expect(m.modDate).toEqual(at);
  });

  it('deletes the /Info key when the value cannot be represented there', () => {
    const d = doc1();
    d.SetMetadata({ title: 'Old' });
    d.SetXmpValue(DC, 'title', { struct: [{ namespace: ACME, name: 'x', value: 'y' }] });
    expect(d.GetMetadata().title).toBeUndefined();
  });

  it('deletes /Info alongside the property', () => {
    const d = doc1();
    d.SetMetadata({ producer: 'P' });
    d.SetXmpValue(PDF, 'Producer', null);
    expect(d.GetMetadata().producer).toBeUndefined();
  });

  it('leave /Info alone for a non-mirrored property', () => {
    const d = doc1();
    d.SetXmpValue(DC, 'coverage', 'Europe');
    expect(d.trailer.has('Info')).toBe(false);
  });
});

describe('all-or-nothing', () => {
  it('a rejected value leaves the saved bytes identical', () => {
    const d = withXmp('<dc:format>application/pdf</dc:format>');
    d.SetMetadata({ title: 'T' });
    const before = d.Save();
    expect(() => d.SetXmpValue(DC, 'title', Number.NaN)).toThrow(TypeError);
    expect(() => d.SetXmpValue(ACME, 'P', 'v', { prefix: 'dc' })).toThrow(RangeError);
    expect(d.Save()).toEqual(before);
  });

  it('a ResourceLimitError leaves /Info untouched', () => {
    const deep = '<acme:a rdf:parseType="Resource">'.repeat(300) + '<acme:v>x</acme:v>' + '</acme:a>'.repeat(300);
    const d = withXmp(deep, ` xmlns:acme="${ACME}"`);
    expect(() => d.SetXmpValue(PDF, 'Producer', 'P')).toThrow(ResourceLimitError);
    expect(d.GetMetadata().producer).toBeUndefined();
    const loose = Document.Open(d.Save(), { limits: LoadLimits.defaults.with({ maxNestingDepth: 2000 }) });
    loose.SetXmpValue(PDF, 'Producer', 'P');
    expect(loose.GetMetadata().producer).toBe('P');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmp-set-value.test.ts`
Expected: FAIL — `d.SetXmpValue is not a function`.

- [ ] **Step 3: `claimPrefix` and `editXmpPacketWith` in `src/xmp.ts`**

Add below `writeXmpPacket`:

```ts
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
  if (!edit(packet)) return undefined;
  return writeXmpPacket(packet);
}
```

In `applyXmpUpdate`'s custom loop, replace the two statements

```ts
      for (const [other, p] of [...packet.prefixes]) if (p === c.prefix && other !== c.namespace) packet.prefixes.delete(other);
      packet.prefixes.set(c.namespace, c.prefix);
```

with

```ts
      claimPrefix(packet, c.namespace, c.prefix);
```

(`claimPrefix` is a function declaration, so it is hoisted above its use.)

- [ ] **Step 4: `mirroredField` in `src/metasync.ts`**

Add below `MAP`:

```ts
/** The /Info-mirrored field a top-level XMP property is, if any (`o6uu.8`). */
export function mirroredField(ns: string, name: string): MetadataField | undefined {
  return MAP.find(([, , , n, m]) => n === ns && m === name)?.[0];
}
```

- [ ] **Step 5: `Document.SetXmpValue`**

In `src/document.ts`:
- Extend the `./xmp.js` import with `editXmpPacketWith, claimPrefix`.
- Extend the `./metasync.js` import with `mirroredField`.
- Add `import { checkXmpWrite, toRdfValue, type XmpValueInput, type XmpWriteOptions } from './xmpwrite.js';`
- Add `import type { MetadataUpdate } from './metadata.js';` if `MetadataUpdate` is not already imported (`grep -n "MetadataUpdate" src/document.ts | head -2`).
- Directly after `GetXmpValue`, add:

```ts
  /** Write one top-level XMP property from a typed value (`o6uu.8`); `null`
   *  deletes it. Everything the write does not name survives. The eight
   *  properties /Info shares are mirrored through `SyncMetadata`'s own rules,
   *  and a value /Info cannot represent deletes the /Info key rather than
   *  leaving it describing the old one. Validated before anything is touched
   *  (`TypeError`, `RangeError`), and the packet text is computed before /Info
   *  is edited, so a refusal changes nothing. */
  SetXmpValue(namespaceUri: string, propName: string, value: XmpValueInput | null, opts: XmpWriteOptions = {}): void {
    checkXmpWrite(namespaceUri, propName, value, opts);
    const md = this.resolve(this.catalog().get('Metadata'));
    const text = editXmpPacketWith(isStream(md) ? inflateStream(md) : undefined, (p) => {
      const i = p.properties.findIndex((q) => q.ns === namespaceUri && q.name === propName);
      if (value === null) {
        if (i < 0) return false;
        p.properties.splice(i, 1);
        return true;
      }
      const prop = { ns: namespaceUri, name: propName, value: toRdfValue(value) };
      if (i < 0) p.properties.push(prop); else p.properties[i] = prop;
      if (opts.prefix !== undefined) claimPrefix(p, namespaceUri, opts.prefix);
      return true;
    }, this.loadLimits);
    if (text === undefined) return;
    const field = mirroredField(namespaceUri, propName);
    if (field !== undefined) {
      const plan = planSync(infoSide(this.currentInfo(), (o) => this.resolve(o)),
        xmpSide(new TextEncoder().encode(text), this.loadLimits), 'xmpToInfo');
      const info: MetadataUpdate = {};
      // Unreadable for /Info (a struct title, a date that will not convert):
      // delete rather than keep /Info describing the value just replaced.
      if (plan.skipped.includes(field)) (info as Record<string, unknown>)[field] = null;
      else if (plan.changed.includes(field)) (info as Record<string, unknown>)[field] = plan.info[field];
      if (Object.keys(info).length > 0) applyUpdate(this.ensureInfo(), info);
    }
    this.installXmpText(text);
  }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/xmp-set-value.test.ts test/xmp-edit.test.ts test/xmp-edit-residue.test.ts test/metasync.test.ts test/import-cycles.test.ts`
Expected: PASS. If `import-cycles` fails, `document.ts` → `xmpwrite.ts` closed a cycle: `xmpwrite.ts` must import only `xmprdf.js`.

- [ ] **Step 7: Export, README, CHANGELOG**

In `src/index.ts`, next to `export type { XmpValue } from './xmpvalue.js';`, add:

```ts
export type { XmpValueInput, XmpWriteOptions } from './xmpwrite.js';
```

In `README.md`:
- API Reference, after the `doc.GetXmpValue(namespaceUri, name)` row:

```markdown
| `doc.SetXmpValue(namespaceUri, name, value, opts?)` | Write one top-level XMP property from a typed `XmpValueInput` (`null` deletes); mirrors the eight `/Info`-shared properties |
```

- Types table, after the `XmpValue` row:

```markdown
| `XmpValueInput` | A typed XMP value to write: `string`, `number`, `boolean`, `Date`, or `{ seq \| bag \| alt: [...] }`, `{ lang: { tag: text } }`, `{ uri }`, `{ struct: [{ namespace, name, value }] }`. |
| `XmpWriteOptions` | Options for `SetXmpValue`: `prefix`, the prefix to write the namespace under (it wins over a foreign namespace holding it). |
```

- In the XMP section, replace the sentence `Typed writes are not yet available.` with:

````markdown
`SetXmpValue(namespaceUri, name, value, opts?)` is the write half:

```ts
const ACME = 'http://acme.example/ns/1.0/';
doc.SetXmpValue(ACME, 'Rating', 4, { prefix: 'acme' });
doc.SetXmpValue(ACME, 'Tags', { bag: ['draft', 'q3'] });
doc.SetXmpValue('http://purl.org/dc/elements/1.1/', 'title', { lang: { 'x-default': 'Report', de: 'Bericht' } });
doc.SetXmpValue(ACME, 'Rating', null);   // delete
```

Scalars are plain values; arrays, language alternatives, URIs and structs are
tagged, since XMP distinguishes what plain JavaScript does not. The eight
properties `/Info` shares are mirrored, and a value `/Info` cannot hold deletes
its `/Info` key. The whole call is validated first and is all-or-nothing.
````

- Replace the Limitations bullet beginning `- **XMP typed writes are not available**` with:

```markdown
- **XMP writes are not type-checked against the predefined schemas** — `SetXmpValue` writes what it is given (a Bag to `dc:creator`, whose schema says Seq, is accepted); checking values against their schema types is a PDF/A validation layer not yet implemented.
```

Run `npx vitest run test/readme-api.test.ts`; update the README intro count sentence to the numbers its failure prints, and re-run to PASS.

In `CHANGELOG.md` under `### Added`, at the top:

```markdown
- **Typed XMP writes.** `doc.SetXmpValue(namespaceUri, name, value, opts?)`
  writes any top-level XMP property from an `XmpValueInput`: plain strings,
  numbers, booleans and `Date`s, and tagged objects for what plain values
  cannot say — `{ seq }` and `{ bag }` for XMP's ordered and unordered arrays,
  `{ lang }` for a language alternative (the only way to write title and
  description translations, since `SetXmp` writes `x-default` alone), `{ uri }`
  and `{ struct }`. `null` deletes. Every value reads back through
  `GetXmpValue`, and everything the write does not name survives. The eight
  properties `/Info` shares are mirrored through `SyncMetadata`'s own rules, so
  the two cannot disagree; a value `/Info` cannot hold deletes its key. The
  call is validated first and computes the packet before touching `/Info`, so
  a refusal changes nothing; `opts.prefix` wins over a foreign namespace
  already using it (o6uu.8).
```

- [ ] **Step 8: Commit**

```bash
git add src/xmp.ts src/metasync.ts src/document.ts src/index.ts test/xmp-set-value.test.ts README.md CHANGELOG.md
git commit -m "feat(o6uu.8): doc.SetXmpValue writes typed XMP properties"
```

---

### Task 3: CLAUDE.md, mutation pass, verification, close

- [ ] **Step 1: Mutation pass**

For each row, apply the mutation, run `npx vitest run test/xmpwrite.test.ts test/xmp-set-value.test.ts`, confirm RED, restore it with `git checkout -- <file>`, and confirm the mutation actually applied (`git diff --stat`).

| # | File | Mutation |
|---|---|---|
| 1 | `src/xmpwrite.ts` | drop the exponent test (`\|\| /e/i.test(String(v))`) |
| 2 | `src/xmpwrite.ts` | `toRdfValue` lang: drop the `.sort(...)` |
| 3 | `src/xmpwrite.ts` | `RESERVED` check: `owner !== undefined` only (ignore own namespace) |
| 4 | `src/xmpwrite.ts` | `tagOf`: accept `keys.length > 1` |
| 5 | `src/xmpwrite.ts` | boolean writes `'true'`/`'false'` |
| 6 | `src/xmpwrite.ts` | `uri` written without `uri: true` |
| 7 | `src/document.ts` | `SetXmpValue`: `if (i < 0) return false;` → `if (i < 0) return true;` |
| 8 | `src/document.ts` | skipped mirror field kept instead of deleted (drop the `skipped` branch) |
| 9 | `src/document.ts` | move the `checkXmpWrite(...)` line to just before `this.installXmpText(text)` |
| 10 | `src/document.ts` | `claimPrefix` call dropped |
| 11 | `src/document.ts` | mirror computed from the OLD packet: `xmpSide(isStream(md) ? inflateStream(md) : undefined, this.loadLimits)` in place of `xmpSide(new TextEncoder().encode(text), this.loadLimits)` |
| 12 | `src/document.ts` | `editXmpPacketWith(..., this.loadLimits)` → drop the limits argument |

A mutation that stays GREEN is a coverage gap (add a case) or a redundant defence (record it and keep the code).

- [ ] **Step 2: CLAUDE.md**

After the `**xmpvalue.ts**` entry, add:

```markdown
- **xmpwrite.ts** — typed XMP WRITES (`o6uu.8`), behind `doc.SetXmpValue`:
  `checkXmpWrite` validates, `toRdfValue` converts an `XmpValueInput` to the
  `xmprdf.ts` model. A leaf over `xmprdf.js` alone.
  **Invariant:** plain values for scalars, TAGGED objects for the rest — an
  ordered Seq and an unordered Bag are both "an array", and a URI and a string
  that looks like one are different values. A tagged object holds exactly ONE
  tag.
  **Invariant:** every value reads back through `XmpValue`: a boolean is
  written `True`/`False` (`asBool`'s spelling), a `Date` as `toISOString()`
  (what `SetXmp` writes), a `lang` map with `x-default` FIRST. A number whose
  `String()` is in exponent notation is REFUSED, since `asReal` refuses that
  grammar and the write would not read back.
  **Invariant:** validated before anything is touched — a rejected call leaves
  the document byte-identical. `TypeError` for the wrong kind of thing,
  `RangeError` for a reserved prefix naming a DIFFERENT namespace (a reserved
  prefix for its own namespace, `dc` for Dublin Core, is fine).
  **Invariant (`document.ts`):** the eight /Info-shared properties are
  mirrored through `metasync.ts`'s `xmpSide` and `planSync` on the NEW packet,
  so `SetXmpValue` and `SyncMetadata` cannot disagree about a mirror — except
  that a value /Info cannot hold DELETES the key where the sync would skip it,
  because the caller has just replaced what /Info described. The packet text
  is computed before /Info is touched (`SetMetadata`'s `o6uu.7` order), and a
  delete of an absent property writes nothing and marks nothing modified.
  **Note:** `xmp.ts`'s `claimPrefix` is now the ONE owner of "a caller's prefix
  wins over a foreign namespace", shared by `custom` and `SetXmpValue`; and
  `editXmpPacketWith` is `editXmpPacket`'s edit path with a caller-supplied
  edit, so there is one parse-edit-write path, not two.
  **Note:** no type enforcement against the predefined schemas — that is
  PDF/A value-type checking (`o6uu.10`), and a second answer here would drift.
```

Append a `**Note, measured:**` line with Step 1's result.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck` — expected exit 0.
Run: `npm test` — expected all files pass.

- [ ] **Step 4: Commit, close, push**

```bash
git add CLAUDE.md
git commit -m "docs(o6uu.8): record xmpwrite invariants"
bd close aspose-pdf-foss-for-ts-o6uu.8
git pull --rebase --autostash
git push
git status
```
Expected: "up to date with origin".
