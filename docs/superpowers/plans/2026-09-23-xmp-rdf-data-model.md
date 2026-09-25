# XMP RDF Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse an XMP packet into a namespace-resolved RDF data model (simple values, Bag/Seq/Alt arrays, `xml:lang`, structs) and serialize that model back to a canonical packet, over the existing `xml.ts` reader.

**Architecture:** `xml.ts` gains an opt-in `{ qnames: true }` option that keeps prefixes on element names and attribute keys (default unchanged). A new pure leaf `src/xmprdf.ts` resolves namespaces with its own scope stack, dispatches on RDF syntax to build `RdfProperty[]`, and writes a canonical single-Description packet. Internal only — not exported, not wired into `xmp.ts` (that is `o6uu.3`).

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, tsx for scripts. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-xmp-rdf-data-model-design.md`

## Global Constraints

- Zero runtime dependencies; `node:` built-ins only.
- Import specifiers carry `.js`.
- Errors: malformed/unsupported input → `PdfParseError` (from `src/errors.ts`), message prefixed `XMP: `; an unwritable model in the serializer → `TypeError`.
- `parseXml` without the new option must behave byte-identically for every existing caller.
- `src/xmprdf.ts` imports only `./xml.js`, `./errors.js`, `./loadlimits.js`.
- Not exported from `src/index.ts`; no CHANGELOG entry (no user-visible change).
- Round-trip contract: `parse(serialize(m)).properties` deep-equals `m.properties`; output is canonical, not byte-identical to foreign input.
- Before closing: `npm run typecheck` and `npm test` both green.

## Review Focus

1. **A packet with a UTF-8 BOM, xpacket PIs and kilobytes of trailing padding** (every real packet embedded in a PDF) must parse. → Task 2 test "accepts BOM, xpacket PIs and trailing padding".
2. **Values carrying `&`, `<`, `>`, `"`, a newline, and leading/trailing spaces** must survive serialize→parse exactly. → Task 3 test "escapes text, attribute and namespace values".
3. **A namespace URI containing `&` or `"`** must be escaped in its `xmlns:` declaration. → same Task 3 test.
4. **A foreign packet that binds a well-known prefix (`dc`) to a different URI while also using the real dc namespace** must not produce two namespaces under one prefix. → Task 3 test "renames a colliding prefix".
5. **A property name outside ASCII** (Adobe's `Formↂ0020fields`) must be readable and writable — an ASCII-only NCName check would throw on a real IRS packet. → Task 3 test "accepts a non-ASCII NCName" and Task 4's IRS test.

---

## File Structure

- Modify `src/xml.ts` — add `ParseXmlOptions` and the `qnames` switch in `readName`.
- Create `src/xmprdf.ts` — model types, `parseRdfPacket`, `serializeRdfPacket`.
- Create `scripts/gen-xmp-acrobat-fixture.ts` — builds the Acrobat input PDF; extracts the packet from the re-saved PDF.
- Modify `package.json` — `gen:xmp` script.
- Create `test/fixtures/xmp/` — `acrobat-input.pdf`, `acrobat-resaved.pdf`, `acrobat-resaved.xmp`, `PROVENANCE.md`.
- Tests: `test/xml.test.ts` (extend), `test/xmprdf.test.ts`, `test/xmprdf-real.test.ts`.
- Modify `CLAUDE.md` — Source-list entry for `xmprdf.ts`, fixtures table row, gen-script tool list.

---

### Task 1: Acrobat input PDF (started first so the manual re-save can run in parallel)

**Files:**
- Create: `scripts/gen-xmp-acrobat-fixture.ts`
- Modify: `package.json` (scripts)
- Create: `test/fixtures/xmp/acrobat-input.pdf` (generated)

**Interfaces:**
- Consumes: `buildXmpPdf(packet: string): Uint8Array` from `test/helpers/build-xmp-pdf.ts`; `Document.Open(buf)` and `doc.GetXmp().raw` from `src/document.ts`.
- Produces: `npm run gen:xmp -- input` writes `test/fixtures/xmp/acrobat-input.pdf`; `npm run gen:xmp -- extract` reads `test/fixtures/xmp/acrobat-resaved.pdf` and writes `test/fixtures/xmp/acrobat-resaved.xmp`. Both print SHA-256 of what they read and wrote.

- [ ] **Step 1: Write the script**

```ts
// Build and extract the Acrobat XMP fixture `test/fixtures/xmp/` holds.
//
// WHY THIS EXISTS. `src/xmprdf.ts` parses RDF/XML, and its unit tests are
// packets we wrote — the shared-convention class `test/fixtures/` guards
// against. Adobe XMP Core is a serializer we did not write: Acrobat re-writes
// the WHOLE packet through its own data model on save. So this builds a PDF
// whose packet holds the shapes the model must carry (a Seq of structs in two
// syntaxes, an attribute-form struct, a two-language Alt), a person re-saves it
// in Acrobat DC, and the packet Acrobat wrote is extracted.
//
// WHY NOT VENDOR AN ADOBE PDF. Acrobat's own TutorialSample.pdf carries a
// History, but it is Adobe copyright — the RSWOP.icm objection. Here the input
// is ours and only the serialization is Adobe's.
//
// Not run by `npm test`. Needs Acrobat DC for the manual step.
//
// Usage:
//   npm run gen:xmp -- input     # writes acrobat-input.pdf
//   (open it in Acrobat DC, File > Properties > Description > Subject:
//    "resaved by Acrobat", OK, File > Save As > acrobat-resaved.pdf)
//   npm run gen:xmp -- extract   # writes acrobat-resaved.xmp
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildXmpPdf } from '../test/helpers/build-xmp-pdf.js';
import { Document } from '../src/document.js';

const DIR = 'test/fixtures/xmp';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const PACKET = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
    xmlns:stRef="http://ns.adobe.com/xap/1.0/sType/ResourceRef#"
    xmlns:o6uu="http://example.com/ns/o6uu/1.0/"
    xmp:CreatorTool="aspose-pdf-foss-for-ts gen-xmp-acrobat-fixture"
    o6uu:marker="attribute-form">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP round trip input</rdf:li><rdf:li xml:lang="de-DE">XMP-Rundreise</rdf:li></rdf:Alt></dc:title>
   <dc:subject><rdf:Bag><rdf:li>xmp</rdf:li><rdf:li>fixture</rdf:li></rdf:Bag></dc:subject>
   <dc:creator><rdf:Seq><rdf:li>First Author</rdf:li><rdf:li>Second Author</rdf:li></rdf:Seq></dc:creator>
   <xmpMM:DocumentID>xmp.did:o6uu-input</xmpMM:DocumentID>
   <xmpMM:DerivedFrom stRef:documentID="xmp.did:o6uu-original" stRef:instanceID="xmp.iid:o6uu-original"/>
   <xmpMM:History>
    <rdf:Seq>
     <rdf:li rdf:parseType="Resource">
      <stEvt:action>created</stEvt:action>
      <stEvt:when>2026-09-23T10:00:00Z</stEvt:when>
      <stEvt:softwareAgent>o6uu fixture</stEvt:softwareAgent>
     </rdf:li>
     <rdf:li><rdf:Description stEvt:action="saved" stEvt:when="2026-09-23T10:05:00Z"><stEvt:changed>/metadata</stEvt:changed></rdf:Description></rdf:li>
    </rdf:Seq>
   </xmpMM:History>
   <o6uu:note>value with &amp; and &lt;angle&gt; brackets</o6uu:note>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const mode = process.argv[2];
mkdirSync(DIR, { recursive: true });
if (mode === 'input') {
  const pdf = buildXmpPdf(PACKET);
  writeFileSync(`${DIR}/acrobat-input.pdf`, pdf);
  console.log(`acrobat-input.pdf  ${pdf.length} bytes  sha256 ${sha(pdf)}`);
} else if (mode === 'extract') {
  const pdf = readFileSync(`${DIR}/acrobat-resaved.pdf`);
  const raw = Document.Open(pdf).GetXmp().raw;
  if (raw === undefined) throw new Error('acrobat-resaved.pdf carries no /Metadata packet');
  const out = new TextEncoder().encode(raw);
  writeFileSync(`${DIR}/acrobat-resaved.xmp`, out);
  console.log(`acrobat-resaved.pdf  sha256 ${sha(pdf)}`);
  console.log(`acrobat-resaved.xmp  ${out.length} bytes  sha256 ${sha(out)}`);
} else {
  console.error('usage: gen-xmp-acrobat-fixture.ts input|extract');
  process.exit(2);
}
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, after `"gen:dfont"`, add:

```json
    "gen:xmp": "tsx scripts/gen-xmp-acrobat-fixture.ts",
```

- [ ] **Step 3: Generate the input and sanity-check it**

Run: `npm run gen:xmp -- input`
Expected: prints `acrobat-input.pdf  N bytes  sha256 …`.

Run: `node -e "const b=require('fs').readFileSync('test/fixtures/xmp/acrobat-input.pdf','latin1');console.log(b.includes('stEvt:action'), b.includes('de-DE'))"`
Expected: `true true`.

- [ ] **Step 4: Hand the manual step to the user (do not wait on it — continue with Task 2)**

Tell the user: open `test/fixtures/xmp/acrobat-input.pdf` in Acrobat DC → File > Properties > Description → set **Subject** to `resaved by Acrobat` (Subject only — it maps to `dc:description` and leaves `dc:title` alone) → OK → File > Save As → `test/fixtures/xmp/acrobat-resaved.pdf`. Ask them to report the Acrobat version from Help > About.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-xmp-acrobat-fixture.ts package.json test/fixtures/xmp/acrobat-input.pdf
git commit -m "test(o6uu.1): Acrobat XMP fixture input and generator"
```

---

### Task 2: `xml.ts` qnames option + RDF parser

**Files:**
- Modify: `src/xml.ts:47` (signature), `src/xml.ts:70-77` (`readName`)
- Create: `src/xmprdf.ts`
- Test: `test/xml.test.ts` (append), `test/xmprdf.test.ts` (create)

**Interfaces:**
- Produces (xml.ts): `export interface ParseXmlOptions { qnames?: boolean }`; `parseXml(bytes: Uint8Array, limits?: LoadLimits, opts?: ParseXmlOptions): XmlNode`.
- Produces (xmprdf.ts):
  ```ts
  export const RDF_NS: string;
  export interface RdfProperty { ns: string; name: string; value: RdfValue; lang?: string }
  export type RdfValue =
    | { kind: 'simple'; value: string }
    | { kind: 'array'; form: 'Bag' | 'Seq' | 'Alt'; items: RdfItem[] }
    | { kind: 'struct'; fields: RdfProperty[] };
  export interface RdfItem { value: RdfValue; lang?: string }
  export interface RdfPacket { properties: RdfProperty[]; prefixes: Map<string, string> }
  export function parseRdfPacket(bytes: Uint8Array, limits?: LoadLimits): RdfPacket;
  ```

- [ ] **Step 1: Write the failing xml.ts tests**

Append to `test/xml.test.ts`:

```ts
describe('parseXml qnames option', () => {
  const src = enc('<a:root xmlns:a="u" a:x="1" y="2"><a:kid xml:lang="en"/></a:root>');

  it('keeps prefixes on element names and attribute keys when asked', () => {
    const r = parseXml(src, undefined, { qnames: true });
    expect(r.name).toBe('a:root');
    expect([...r.attrs.keys()]).toEqual(['xmlns:a', 'a:x', 'y']);
    expect(r.children[0].name).toBe('a:kid');
    expect(r.children[0].attrs.get('xml:lang')).toBe('en');
  });

  it('strips prefixes by default, exactly as before', () => {
    const r = parseXml(src);
    expect(r.name).toBe('root');
    expect([...r.attrs.keys()]).toEqual(['a', 'x', 'y']);
    expect(r.children[0].attrs.get('lang')).toBe('en');
  });

  it('matches an end tag by its qualified name in qnames mode', () => {
    const mismatched = enc('<a:r xmlns:a="u" xmlns:b="u"></b:r>');
    expect(() => parseXml(mismatched, undefined, { qnames: true })).toThrow(PdfParseError);
    expect(parseXml(mismatched).name).toBe('r');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xml.test.ts`
Expected: the first and third new cases FAIL (`r.name` is `root`; no throw).

- [ ] **Step 3: Implement the option**

In `src/xml.ts`, add above `parseXml`:

```ts
/** Options for {@link parseXml}. */
export interface ParseXmlOptions {
  /** Keep namespace prefixes on element names and attribute keys (`rdf:li`,
   *  `xmlns:dc`, `xml:lang`) instead of stripping them. Off by default, which
   *  is what every pre-existing caller gets. `xmprdf.ts` needs it because RDF
   *  names a property by namespace URI, and a stripped prefix cannot be
   *  resolved to one. No namespace resolution happens here either way. */
  qnames?: boolean;
}
```

Change the signature line to:

```ts
export function parseXml(bytes: Uint8Array, limits: LoadLimits = LoadLimits.defaults, opts: ParseXmlOptions = {}): XmlNode {
```

and in `readName` replace `return c < 0 ? n : n.slice(c + 1);` with:

```ts
    return opts.qnames || c < 0 ? n : n.slice(c + 1);
```

Also update the doc comment's "no namespace resolution (prefixes are stripped)" to "no namespace resolution (prefixes are stripped unless `opts.qnames`)".

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/xml.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing xmprdf parse tests**

Create `test/xmprdf.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseRdfPacket, RDF_NS } from '../src/xmprdf.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';
const REF = 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#';
const NS = `xmlns:dc="${DC}" xmlns:xmpMM="${MM}" xmlns:stEvt="${EVT}" xmlns:stRef="${REF}"`;
const wrap = (body: string) =>
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF></x:xmpmeta>`;
const desc = (inner: string, attrs = '') => `<rdf:Description rdf:about="" ${NS}${attrs}>${inner}</rdf:Description>`;
const props = (inner: string, attrs = '') => parseRdfPacket(enc(wrap(desc(inner, attrs)))).properties;
const simple = (value: string) => ({ kind: 'simple' as const, value });

describe('parseRdfPacket: simple values', () => {
  it('reads a simple property element', () => {
    expect(props('<dc:format>application/pdf</dc:format>'))
      .toEqual([{ ns: DC, name: 'format', value: simple('application/pdf') }]);
  });

  it('reads a property written as a Description attribute', () => {
    expect(props('', ' dc:format="application/pdf"'))
      .toEqual([{ ns: DC, name: 'format', value: simple('application/pdf') }]);
  });

  it('keeps a simple value as written, whitespace included', () => {
    expect(props('<dc:format>  a b \n</dc:format>')[0].value).toEqual(simple('  a b \n'));
  });

  it('reads an empty element as the empty string', () => {
    expect(props('<dc:format/>')[0].value).toEqual(simple(''));
  });

  it('reads xml:lang on a property element', () => {
    expect(props('<dc:format xml:lang="en">x</dc:format>')[0])
      .toEqual({ ns: DC, name: 'format', value: simple('x'), lang: 'en' });
  });

  it('reads rdf:resource as a simple value (interim until o6uu.2)', () => {
    expect(props('<dc:source rdf:resource="http://e.com/a"/>')[0].value).toEqual(simple('http://e.com/a'));
  });
});

describe('parseRdfPacket: arrays', () => {
  it('reads Bag, Seq and Alt with their items in order', () => {
    const p = props(
      '<dc:subject><rdf:Bag><rdf:li>a</rdf:li><rdf:li>b</rdf:li></rdf:Bag></dc:subject>'
      + '<dc:creator><rdf:Seq><rdf:li>c</rdf:li></rdf:Seq></dc:creator>'
      + '<dc:rights><rdf:Alt><rdf:li>d</rdf:li></rdf:Alt></dc:rights>');
    expect(p.map((x) => x.value)).toEqual([
      { kind: 'array', form: 'Bag', items: [{ value: simple('a') }, { value: simple('b') }] },
      { kind: 'array', form: 'Seq', items: [{ value: simple('c') }] },
      { kind: 'array', form: 'Alt', items: [{ value: simple('d') }] },
    ]);
  });

  it('reads an empty container as an empty array', () => {
    expect(props('<dc:creator><rdf:Bag/></dc:creator>')[0].value)
      .toEqual({ kind: 'array', form: 'Bag', items: [] });
  });

  it('reads a language alternative with xml:lang on each item', () => {
    expect(props('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">T</rdf:li>'
      + '<rdf:li xml:lang="de-DE">Titel</rdf:li></rdf:Alt></dc:title>')[0].value).toEqual({
      kind: 'array', form: 'Alt',
      items: [{ value: simple('T'), lang: 'x-default' }, { value: simple('Titel'), lang: 'de-DE' }],
    });
  });
});

describe('parseRdfPacket: structs', () => {
  const derived = { kind: 'struct', fields: [
    { ns: REF, name: 'documentID', value: simple('d') },
    { ns: REF, name: 'instanceID', value: simple('i') },
  ] };

  it('reads rdf:parseType="Resource" on a property element', () => {
    expect(props('<xmpMM:DerivedFrom rdf:parseType="Resource"><stRef:documentID>d</stRef:documentID>'
      + '<stRef:instanceID>i</stRef:instanceID></xmpMM:DerivedFrom>')[0].value).toEqual(derived);
  });

  it('reads a nested rdf:Description, its attributes before its elements', () => {
    expect(props('<xmpMM:DerivedFrom><rdf:Description stRef:documentID="d">'
      + '<stRef:instanceID>i</stRef:instanceID></rdf:Description></xmpMM:DerivedFrom>')[0].value).toEqual(derived);
  });

  it('reads an empty property element carrying property attributes as a struct', () => {
    expect(props('<xmpMM:DerivedFrom stRef:documentID="d" stRef:instanceID="i"/>')[0].value).toEqual(derived);
  });

  it('reads a Seq of structs in both item syntaxes', () => {
    const v = props('<xmpMM:History><rdf:Seq>'
      + '<rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action></rdf:li>'
      + '<rdf:li><rdf:Description stEvt:action="saved"/></rdf:li>'
      + '</rdf:Seq></xmpMM:History>')[0].value;
    expect(v).toEqual({ kind: 'array', form: 'Seq', items: [
      { value: { kind: 'struct', fields: [{ ns: EVT, name: 'action', value: simple('created') }] } },
      { value: { kind: 'struct', fields: [{ ns: EVT, name: 'action', value: simple('saved') }] } },
    ] });
  });
});

describe('parseRdfPacket: namespaces and packet shape', () => {
  it('resolves a property by namespace URI, not by prefix', () => {
    expect(props(`<foo:format xmlns:foo="${DC}">x</foo:format>`)[0])
      .toEqual({ ns: DC, name: 'format', value: simple('x') });
  });

  it('honours a prefix rebound on an inner element', () => {
    const p = props('<dc:format xmlns:dc="http://other/">x</dc:format><dc:type>t</dc:type>');
    expect(p.map((x) => x.ns)).toEqual(['http://other/', DC]);
  });

  it('merges several rdf:Description elements in document order', () => {
    const p = parseRdfPacket(enc(wrap(desc('<dc:format>f</dc:format>') + desc('', ' dc:type="t"')))).properties;
    expect(p.map((x) => x.name)).toEqual(['format', 'type']);
  });

  it('keeps the first of two duplicate properties and drops the rest', () => {
    const p = parseRdfPacket(enc(wrap(desc('<dc:format>first</dc:format>') + desc('<dc:format>second</dc:format>')))).properties;
    expect(p).toEqual([{ ns: DC, name: 'format', value: simple('first') }]);
  });

  it('accepts a bare rdf:RDF root and the legacy x:xapmeta root', () => {
    const body = desc('<dc:format>f</dc:format>');
    expect(parseRdfPacket(enc(`<rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF>`)).properties).toHaveLength(1);
    expect(parseRdfPacket(enc(`<x:xapmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">${body}</rdf:RDF></x:xapmeta>`)).properties).toHaveLength(1);
  });

  it('accepts BOM, xpacket PIs and trailing padding', () => {
    const text = `﻿<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${wrap(desc('<dc:format>f</dc:format>'))}\n${' '.repeat(2048)}\n<?xpacket end="w"?>`;
    expect(parseRdfPacket(enc(text)).properties).toHaveLength(1);
  });

  it('records the prefix each namespace was written under', () => {
    const r = parseRdfPacket(enc(wrap(desc('<dc:format>f</dc:format>'))));
    expect(r.prefixes.get(DC)).toBe('dc');
    expect(r.prefixes.get(MM)).toBe('xmpMM');
  });
});

describe('parseRdfPacket: refusals', () => {
  const refuses = (src: string, what: RegExp) => {
    expect(() => parseRdfPacket(enc(src))).toThrow(PdfParseError);
    expect(() => parseRdfPacket(enc(src))).toThrow(what);
  };

  it('refuses a DOCTYPE and an ENTITY declaration', () => {
    refuses(`<!DOCTYPE x [<!ENTITY e "boom">]>${wrap(desc(''))}`, /DTD/);
    refuses(`<!ENTITY e "boom">${wrap(desc(''))}`, /DTD/);
  });

  it('refuses a root that is not an XMP packet', () => {
    refuses('<html/>', /not an XMP packet root/);
  });

  it('refuses an xmpmeta with no rdf:RDF', () => {
    refuses('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', /no rdf:RDF/);
  });

  it('refuses an unbound prefix', () => {
    refuses(wrap(desc('<zz:format>f</zz:format>')), /prefix "zz" is not bound/);
  });

  it('refuses text mixed with elements', () => {
    refuses(wrap(desc('<dc:subject>oops<rdf:Bag/></dc:subject>')), /both text and elements/);
  });

  it('refuses an unknown rdf:parseType', () => {
    refuses(wrap(desc('<dc:subject rdf:parseType="Literal">x</dc:subject>')), /parseType="Literal"/);
  });

  it('refuses a non-Description child of rdf:RDF', () => {
    refuses(wrap('<dc:format xmlns:dc="u">f</dc:format>'), /expected rdf:Description/);
  });

  it('refuses a non-li element inside an array', () => {
    refuses(wrap(desc('<dc:subject><rdf:Bag><dc:x>a</dc:x></rdf:Bag></dc:subject>')), /expected rdf:li/);
  });

  it('refuses a property holding a non-RDF node or two nodes', () => {
    refuses(wrap(desc('<dc:subject><dc:x>a</dc:x></dc:subject>')), /not an RDF node/);
    refuses(wrap(desc('<dc:subject><rdf:Bag/><rdf:Bag/></dc:subject>')), /more than one node/);
  });
});
```

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run test/xmprdf.test.ts`
Expected: FAIL — `Cannot find module '../src/xmprdf.js'`.

- [ ] **Step 7: Implement the parser**

Create `src/xmprdf.ts`:

```ts
import { parseXml, type XmlNode } from './xml.js';
import { PdfParseError } from './errors.js';
import { LoadLimits } from './loadlimits.js';

// The XMP data model: RDF/XML parsed into namespace-resolved properties, and
// written back in one canonical form (`o6uu.1`). Internal — `o6uu.3` puts it
// under `readXmp`/`buildXmp`, `o6uu.2` adds qualifiers and URI values.

export const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const X_NS = 'adobe:ns:meta/';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** A property: a value under (namespace URI, local name). `lang` is its
 *  `xml:lang`, the one qualifier modelled so far. */
export interface RdfProperty { ns: string; name: string; value: RdfValue; lang?: string }

/** A language alternative is an `Alt` whose items carry `lang`; it has no kind
 *  of its own. */
export type RdfValue =
  | { kind: 'simple'; value: string }
  | { kind: 'array'; form: 'Bag' | 'Seq' | 'Alt'; items: RdfItem[] }
  | { kind: 'struct'; fields: RdfProperty[] };

export interface RdfItem { value: RdfValue; lang?: string }

export interface RdfPacket {
  properties: RdfProperty[];
  /** namespace URI → the prefix the source first bound it to; the serializer's
   *  preference, never part of the model's meaning. */
  prefixes: Map<string, string>;
}

type Scope = ReadonlyMap<string, string>;
const BASE_SCOPE: Scope = new Map([['xml', XML_NS]]);

function fail(msg: string): never {
  throw new PdfParseError(`XMP: ${msg}`);
}

/** Namespace resolution and the RDF syntax dispatch. One instance per parse,
 *  so `prefixes` collects every binding the packet makes. */
class Reader {
  readonly prefixes = new Map<string, string>();

  /** The scope in force inside `el`: its parent's plus its own `xmlns`
   *  declarations. Copies only when `el` declares something. */
  bind(el: XmlNode, parent: Scope): Scope {
    let scope: Map<string, string> | undefined;
    for (const [k, v] of el.attrs) {
      let p: string;
      if (k === 'xmlns') p = '';
      else if (k.startsWith('xmlns:')) p = k.slice(6);
      else continue;
      scope ??= new Map(parent);
      scope.set(p, v);
      if (p !== '' && v !== '' && !this.prefixes.has(v)) this.prefixes.set(v, p);
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
      fail(c < 0 ? `<${qname}> has no namespace` : `prefix "${qname.slice(0, c)}" is not bound`);
    }
    return q;
  }

  /** An element's attributes split three ways: RDF control attributes by local
   *  name, its `xml:lang`, and property attributes. Namespace declarations and
   *  unprefixed attributes (deprecated in RDF) are ignored. */
  attrs(el: XmlNode, scope: Scope): { rdf: Map<string, string>; lang: string | undefined; props: RdfProperty[] } {
    const rdf = new Map<string, string>();
    const props: RdfProperty[] = [];
    let lang: string | undefined;
    for (const [k, v] of el.attrs) {
      if (k === 'xmlns' || k.startsWith('xmlns:') || !k.includes(':')) continue;
      const { ns, local } = this.resolve(k, scope);
      if (ns === RDF_NS) rdf.set(local, v);
      else if (ns === XML_NS) { if (local === 'lang') lang = v; }
      else props.push({ ns, name: local, value: { kind: 'simple', value: v } });
    }
    return { rdf, lang, props };
  }

  /** The properties of an `rdf:Description`: attributes first, then elements.
   *  `scope` already includes `el`'s own bindings. */
  description(el: XmlNode, scope: Scope): RdfProperty[] {
    const a = this.attrs(el, scope);
    for (const k of a.rdf.keys()) if (k !== 'about') fail(`rdf:${k} is not supported on rdf:Description`);
    if (el.text.trim() !== '') fail('rdf:Description holds text');
    return [...a.props, ...el.children.map((c) => this.property(c, scope))];
  }

  property(el: XmlNode, parent: Scope): RdfProperty {
    const scope = this.bind(el, parent);
    const { ns, local } = this.resolve(el.name, scope);
    if (ns === RDF_NS) fail(`<${el.name}> is not a property`);
    const { value, lang } = this.value(el, scope);
    return lang === undefined ? { ns, name: local, value } : { ns, name: local, value, lang };
  }

  item(el: XmlNode, parent: Scope): RdfItem {
    const scope = this.bind(el, parent);
    const { ns, local } = this.resolve(el.name, scope);
    if (ns !== RDF_NS || local !== 'li') fail(`<${el.name}> inside an array; expected rdf:li`);
    const { value, lang } = this.value(el, scope);
    return lang === undefined ? { value } : { value, lang };
  }

  /** What a property element or `rdf:li` holds. `scope` already includes
   *  `el`'s own bindings. The dispatch order is the RDF/XML grammar's:
   *  parseType, then rdf:resource, then empty-or-text, then one child node. */
  value(el: XmlNode, scope: Scope): { value: RdfValue; lang: string | undefined } {
    const a = this.attrs(el, scope);
    const ret = (value: RdfValue) => ({ value, lang: a.lang });
    const hasText = el.text.trim() !== '';
    const parseType = a.rdf.get('parseType');
    const resource = a.rdf.get('resource');
    for (const k of a.rdf.keys())
      if (k !== 'parseType' && k !== 'resource') fail(`rdf:${k} is not supported on <${el.name}>`);

    if (parseType !== undefined) {
      if (parseType !== 'Resource') fail(`rdf:parseType="${parseType}" is not supported`);
      if (hasText) fail(`<${el.name}> with rdf:parseType="Resource" holds text`);
      return ret({ kind: 'struct', fields: [...a.props, ...el.children.map((c) => this.property(c, scope))] });
    }
    if (resource !== undefined) {
      if (el.children.length || hasText || a.props.length) fail(`<${el.name}> with rdf:resource has content`);
      return ret({ kind: 'simple', value: resource });
    }
    if (el.children.length === 0) {
      if (a.props.length === 0) return ret({ kind: 'simple', value: el.text });
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
      return ret({ kind: 'array', form: local, items: node.children.map((li) => this.item(li, nscope)) });
    }
    if (local === 'Description') return ret({ kind: 'struct', fields: this.description(node, nscope) });
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
  const root = parseXml(bytes, limits, { qnames: true });
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
  const properties: RdfProperty[] = [];
  const seen = new Set<string>();
  for (const d of rdf.children) {
    const s = r.bind(d, rdfScope);
    const q = r.resolve(d.name, s);
    if (q.ns !== RDF_NS || q.local !== 'Description') fail(`<${d.name}> inside rdf:RDF; expected rdf:Description`);
    for (const p of r.description(d, s)) {
      const key = `${p.ns}\u0000${p.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      properties.push(p);
    }
  }
  return { properties, prefixes: r.prefixes };
}
```

- [ ] **Step 8: Run to verify they pass**

Run: `npx vitest run test/xmprdf.test.ts test/xml.test.ts`
Expected: PASS. Then `npm run typecheck` — expected clean.

- [ ] **Step 9: Commit**

```bash
git add src/xml.ts src/xmprdf.ts test/xml.test.ts test/xmprdf.test.ts
git commit -m "feat(o6uu.1): parse XMP packets into an RDF data model"
```

---

### Task 3: Canonical serializer

**Files:**
- Modify: `src/xmprdf.ts` (append)
- Test: `test/xmprdf.test.ts` (append)

**Interfaces:**
- Consumes: the Task 2 model types, `escapeXml` from `./xml.js`.
- Produces: `export function serializeRdfPacket(packet: RdfPacket): string`.

- [ ] **Step 1: Write the failing tests**

Change the first import in `test/xmprdf.test.ts` to `import { parseRdfPacket, serializeRdfPacket, RDF_NS, type RdfProperty } from '../src/xmprdf.js';` and append:

```ts
const write = (properties: RdfProperty[], prefixes = new Map<string, string>()) =>
  serializeRdfPacket({ properties, prefixes });
const back = (properties: RdfProperty[]) => parseRdfPacket(enc(write(properties))).properties;

describe('serializeRdfPacket', () => {
  const model: RdfProperty[] = [
    { ns: DC, name: 'format', value: simple('application/pdf') },
    { ns: DC, name: 'title', value: { kind: 'array', form: 'Alt', items: [
      { value: simple('T'), lang: 'x-default' }, { value: simple('Titel'), lang: 'de-DE' }] } },
    { ns: DC, name: 'creator', value: { kind: 'array', form: 'Bag', items: [] } },
    { ns: MM, name: 'DerivedFrom', value: { kind: 'struct', fields: [
      { ns: REF, name: 'documentID', value: simple('d') }] } },
    { ns: MM, name: 'History', value: { kind: 'array', form: 'Seq', items: [
      { value: { kind: 'struct', fields: [
        { ns: EVT, name: 'action', value: simple('created') },
        { ns: EVT, name: 'tags', value: { kind: 'array', form: 'Bag', items: [{ value: simple('x') }] } }] } },
      { value: { kind: 'struct', fields: [] } }] } },
    { ns: DC, name: 'description', value: simple(''), lang: 'en' },
  ];

  it('round-trips every shape of the model', () => {
    expect(back(model)).toEqual(model);
  });

  it('writes one rdf:Description declaring every namespace used, struct fields included', () => {
    const s = write(model);
    expect(s.match(/<rdf:Description/g)).toHaveLength(1);
    for (const decl of [`xmlns:dc="${DC}"`, `xmlns:xmpMM="${MM}"`, `xmlns:stRef="${REF}"`, `xmlns:stEvt="${EVT}"`])
      expect(s).toContain(decl);
    expect(s.startsWith('<?xpacket begin="﻿"')).toBe(true);
    expect(s.endsWith('<?xpacket end="w"?>')).toBe(true);
  });

  it('escapes text, attribute and namespace values', () => {
    const odd = 'http://e.com/?a=1&b="2"';
    const m: RdfProperty[] = [
      { ns: odd, name: 'v', value: simple(' a & <b> "c" ]]>\nd '), lang: 'x"y' },
    ];
    expect(back(m)).toEqual(m);
  });

  it('prefers the prefix the source used, then a well-known one, then nsN', () => {
    const s = write(
      [{ ns: 'http://a/', name: 'p', value: simple('1') }, { ns: MM, name: 'q', value: simple('2') },
        { ns: 'http://b/', name: 'r', value: simple('3') }],
      new Map([['http://a/', 'mine']]));
    expect(s).toContain('xmlns:mine="http://a/"');
    expect(s).toContain(`xmlns:xmpMM="${MM}"`);
    expect(s).toContain('xmlns:ns1="http://b/"');
  });

  it('renames a colliding prefix', () => {
    const m: RdfProperty[] = [
      { ns: 'http://fake-dc/', name: 'p', value: simple('1') },
      { ns: DC, name: 'format', value: simple('2') },
    ];
    const s = write(m, new Map([['http://fake-dc/', 'dc']]));
    expect(s).toContain('xmlns:dc="http://fake-dc/"');
    expect(s).toContain(`xmlns:ns1="${DC}"`);
    expect(back(m)).toEqual(m);
  });

  it('never assigns a reserved prefix', () => {
    const s = write([{ ns: 'http://a/', name: 'p', value: simple('1') }], new Map([['http://a/', 'rdf']]));
    expect(s).toContain('xmlns:ns1="http://a/"');
  });

  it('accepts a non-ASCII NCName', () => {
    const m: RdfProperty[] = [{ ns: 'http://a/', name: 'Formↂ0020fields', value: simple('fillable') }];
    expect(back(m)).toEqual(m);
  });

  it('refuses a model it cannot write', () => {
    expect(() => write([{ ns: '', name: 'p', value: simple('') }])).toThrow(TypeError);
    expect(() => write([{ ns: 'http://a/', name: 'a b', value: simple('') }])).toThrow(TypeError);
    expect(() => write([{ ns: RDF_NS, name: 'li', value: simple('') }])).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xmprdf.test.ts`
Expected: FAIL — `serializeRdfPacket` is not exported.

- [ ] **Step 3: Implement the serializer**

In `src/xmprdf.ts` change the xml import to `import { parseXml, escapeXml, type XmlNode } from './xml.js';` and append:

```ts
/** An XML NCName, Unicode ranges included: Adobe writes a space in a property
 *  name as U+2182 plus hex (`Formↂ0020fields`), and an ASCII-only test would
 *  refuse a real IRS packet. */
const NCNAME = /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}.\-·]*$/u;

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

/** Write the model as one canonical packet: a single `rdf:Description`
 *  declaring every namespace, properties in model order, arrays and structs in
 *  element form. Throws `TypeError` on a model no packet can express. */
export function serializeRdfPacket(packet: RdfPacket): string {
  const used: string[] = [];
  const seen = new Set<string>();
  const visitValue = (v: RdfValue): void => {
    if (v.kind === 'array') for (const it of v.items) visitValue(it.value);
    else if (v.kind === 'struct') for (const f of v.fields) visitProp(f);
  };
  const visitProp = (p: RdfProperty): void => {
    if (typeof p.ns !== 'string' || p.ns === '') throw new TypeError('XMP property namespace must be a non-empty string');
    if (p.ns === RDF_NS || p.ns === XML_NS) throw new TypeError(`XMP property ${p.name} may not be in the ${p.ns} namespace`);
    if (typeof p.name !== 'string' || !NCNAME.test(p.name))
      throw new TypeError(`XMP property name "${String(p.name)}" is not an XML NCName`);
    if (!seen.has(p.ns)) { seen.add(p.ns); used.push(p.ns); }
    visitValue(p.value);
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
  const langAttr = (lang: string | undefined) => (lang === undefined ? '' : ` xml:lang="${escapeXml(lang)}"`);
  const qname = (p: RdfProperty) => `${prefixOf.get(p.ns)}:${p.name}`;
  const emit = (tag: string, attrs: string, v: RdfValue, pad: string): void => {
    if (v.kind === 'simple') { out.push(`${pad}<${tag}${attrs}>${escapeXml(v.value)}</${tag}>`); return; }
    if (v.kind === 'array') {
      if (v.items.length === 0) { out.push(`${pad}<${tag}${attrs}><rdf:${v.form}/></${tag}>`); return; }
      out.push(`${pad}<${tag}${attrs}>`, `${pad} <rdf:${v.form}>`);
      for (const it of v.items) emit('rdf:li', langAttr(it.lang), it.value, `${pad}  `);
      out.push(`${pad} </rdf:${v.form}>`, `${pad}</${tag}>`);
      return;
    }
    if (v.fields.length === 0) { out.push(`${pad}<${tag}${attrs} rdf:parseType="Resource"/>`); return; }
    out.push(`${pad}<${tag}${attrs} rdf:parseType="Resource">`);
    for (const f of v.fields) emit(qname(f), langAttr(f.lang), f.value, `${pad} `);
    out.push(`${pad}</${tag}>`);
  };
  for (const p of packet.properties) emit(qname(p), langAttr(p.lang), p.value, '   ');

  const decls = used.map((ns) => `\n    xmlns:${prefixOf.get(ns)}="${escapeXml(ns)}"`).join('');
  const body = out.length ? `${out.join('\n')}\n` : '';
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="${RDF_NS}">
  <rdf:Description rdf:about=""${decls}>
${body}  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/xmprdf.test.ts`
Expected: PASS. Then `npm run typecheck` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/xmprdf.ts test/xmprdf.test.ts
git commit -m "feat(o6uu.1): serialize the RDF data model to a canonical packet"
```

---

### Task 4: Real-world packets already vendored (IRS, Ghostscript)

**Files:**
- Test: `test/xmprdf-real.test.ts` (create)

**Interfaces:**
- Consumes: `parseRdfPacket`, `serializeRdfPacket`, `RdfProperty` (Tasks 2–3); `Document.Open(buf).GetXmp().raw` (existing).

- [ ] **Step 1: Write the tests**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRdfPacket, serializeRdfPacket, type RdfPacket } from '../src/xmprdf.js';
import { Document } from '../src/document.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const PDFX = 'http://ns.adobe.com/pdfx/1.3/';
const packetOf = (path: string) => enc(Document.Open(readFileSync(path)).GetXmp().raw!);
const roundTrip = (p: RdfPacket) => parseRdfPacket(enc(serializeRdfPacket(p))).properties;

describe('xmprdf over real packets', () => {
  it('IRS f1040 (LiveCycle): language alternative, Seq, and a U+2182-encoded name', () => {
    const p = parseRdfPacket(packetOf('test/fixtures/xfa/irs-f1040.pdf'));
    const title = p.properties.find((x) => x.ns === DC && x.name === 'title');
    expect(title?.value).toEqual({ kind: 'array', form: 'Alt',
      items: [{ value: { kind: 'simple', value: '2025 Form 1040' }, lang: 'x-default' }] });
    const odd = p.properties.find((x) => x.ns === PDFX && x.name === 'Formↂ0020fields');
    expect(odd?.value).toEqual({ kind: 'simple', value: 'fillable' });
    expect(roundTrip(p)).toEqual(p.properties);
    expect(serializeRdfPacket(p)).toContain(`xmlns:pdfx="${PDFX}"`);
  });

  it('IRS fw9 (LiveCycle) round-trips its data model', () => {
    const p = parseRdfPacket(packetOf('test/fixtures/xfa/irs-fw9.pdf'));
    expect(p.properties.length).toBeGreaterThan(10);
    expect(roundTrip(p)).toEqual(p.properties);
  });

  it('Ghostscript PDF/X-4: seven Descriptions and the attribute form merge in order', () => {
    const p = parseRdfPacket(packetOf('test/fixtures/pdfx/ghostscript-x4.pdf'));
    expect(p.properties.map((x) => x.name)).toEqual([
      'Producer', 'Trapped', 'ModifyDate', 'CreateDate', 'MetadataDate', 'CreatorTool',
      'DocumentID', 'RenditionClass', 'VersionID', 'format', 'title', 'GTS_PDFXVersion',
    ]);
    expect(roundTrip(p)).toEqual(p.properties);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/xmprdf-real.test.ts`
Expected: PASS. If the Ghostscript order differs, read the packet (Task-4 order is Description attributes before its elements, Descriptions in document order) and fix the CODE if it violates that rule, the expectation only if the packet does.

- [ ] **Step 3: Commit**

```bash
git add test/xmprdf-real.test.ts
git commit -m "test(o6uu.1): round-trip the vendored IRS and Ghostscript XMP packets"
```

---

### Task 5: Acrobat fixture — the acceptance criterion

Blocked on the user's re-save from Task 1 Step 4. If `test/fixtures/xmp/acrobat-resaved.pdf` does not exist yet, ask the user for it and stop here.

**Files:**
- Create: `test/fixtures/xmp/acrobat-resaved.pdf` (from the user), `test/fixtures/xmp/acrobat-resaved.xmp` (extracted), `test/fixtures/xmp/PROVENANCE.md`
- Test: `test/xmprdf-real.test.ts` (append)

- [ ] **Step 1: Extract and read the packet**

Run: `npm run gen:xmp -- extract`, then read `test/fixtures/xmp/acrobat-resaved.xmp` in full. Confirm it carries an `xmpMM:History` Seq of structs and a `dc:title` Alt. Note every way Adobe changed our input (syntax chosen for each struct, added properties, dropped anything, new History entries). If History or the two-language title did NOT survive, stop and report to the user — the acceptance criterion needs both.

- [ ] **Step 2: Write the test**

Append to `test/xmprdf-real.test.ts` (adjust only the `>=` counts to what Step 1 observed; never weaken a shape assertion):

```ts
describe('xmprdf over Acrobat DC output (acceptance)', () => {
  const MM = 'http://ns.adobe.com/xap/1.0/mm/';
  const EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';
  const REF = 'http://ns.adobe.com/xap/1.0/sType/ResourceRef#';
  const p = parseRdfPacket(readFileSync('test/fixtures/xmp/acrobat-resaved.xmp'));
  const get = (ns: string, name: string) => p.properties.find((x) => x.ns === ns && x.name === name)?.value;

  it('reads History as a Seq of structs carrying our two events', () => {
    const h = get(MM, 'History');
    if (h?.kind !== 'array') throw new Error('History is not an array');
    expect(h.form).toBe('Seq');
    expect(h.items.length).toBeGreaterThanOrEqual(2);
    const actions = h.items.map((it) => it.value.kind === 'struct'
      ? it.value.fields.find((f) => f.ns === EVT && f.name === 'action')?.value : undefined);
    expect(actions).toEqual(expect.arrayContaining([
      { kind: 'simple', value: 'created' }, { kind: 'simple', value: 'saved' }]));
  });

  it('reads the two-language title as a language alternative', () => {
    const t = get(DC, 'title');
    if (t?.kind !== 'array') throw new Error('title is not an array');
    expect(t.form).toBe('Alt');
    expect(t.items.map((it) => it.lang)).toEqual(expect.arrayContaining(['x-default', 'de-DE']));
  });

  it('reads DerivedFrom as a struct', () => {
    const d = get(MM, 'DerivedFrom');
    if (d?.kind !== 'struct') throw new Error('DerivedFrom is not a struct');
    expect(d.fields).toContainEqual({ ns: REF, name: 'documentID', value: { kind: 'simple', value: 'xmp.did:o6uu-original' } });
  });

  it('parse -> serialize -> parse preserves the data model', () => {
    expect(roundTrip(p)).toEqual(p.properties);
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run test/xmprdf-real.test.ts`
Expected: PASS.

- [ ] **Step 4: Write `test/fixtures/xmp/PROVENANCE.md`**

Record, with real values from Step 1 and the script output:
- Producer: Adobe Acrobat DC `<version the user reported>`, Adobe XMP Core as named in the packet's `x:xmptk`.
- Input: `acrobat-input.pdf`, built by `npm run gen:xmp -- input` (SHA-256).
- Manual step, verbatim: Properties > Description > Subject = `resaved by Acrobat`, Save As.
- Output: `acrobat-resaved.pdf` and `acrobat-resaved.xmp` (SHA-256 each).
- What Adobe changed (from Step 1): struct syntax it chose, properties it added (`InstanceID`, dates, `dc:description`, …), anything dropped.
- Covers: Adobe's serialization of a Seq of structs (two input syntaxes), an attribute-form struct, a two-language Alt, a Bag, escaped text.
- Does NOT cover (the ceiling): one producer; Adobe re-wrote OUR model, so shapes Adobe itself would choose (e.g. PDF/A extension schemas, qualifiers) are not here; UTF-16 packets; `rdf:resource`.
- Why not a vendored Adobe PDF: `TutorialSample.pdf` is Adobe copyright (the `RSWOP.icm` objection).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/xmp/acrobat-resaved.pdf test/fixtures/xmp/acrobat-resaved.xmp test/fixtures/xmp/PROVENANCE.md test/xmprdf-real.test.ts
git commit -m "test(o6uu.1): Acrobat DC re-saved packet round-trips the data model"
```

---

### Task 6: Mutation checks, docs, close

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Prove the load-bearing rules**

For each mutation: apply it, confirm the diff is real (`git diff src/xmprdf.ts` non-empty), run `npx vitest run test/xmprdf.test.ts test/xmprdf-real.test.ts`, record the red count, then `git checkout src/xmprdf.ts`.

| # | Mutation in `src/xmprdf.ts` | Must redden |
|---|---|---|
| M1 | `lookup`: return the prefix as `ns` instead of the bound URI | namespace tests, real tests |
| M2 | `item`: always `return { value }` (drop lang) | language-alternative, round-trip |
| M3 | `value`: parseType branch returns `ret({ kind: 'simple', value: el.text })` | parseType struct, History |
| M4 | delete the DOCTYPE/ENTITY check in `parseRdfPacket` | DTD refusal |
| M5 | delete `if (seen.has(key)) continue;` | duplicate-first-wins |
| M6 | `description`: return only `el.children.map(...)` (drop attribute props) | attribute form, Ghostscript |
| M7 | serializer: skip `packet.prefixes.get(ns)` (start from well-known) | prefix preference, collision |
| M8 | `NCNAME` → `/^[A-Za-z_][A-Za-z0-9_.-]*$/` | non-ASCII NCName, IRS f1040 |

Any mutation that stays green: find the missing case, add it, and re-run — or record in the CLAUDE.md entry why it cannot redden.

- [ ] **Step 2: CLAUDE.md**

1. Source list — insert after the `xmp.ts` entry:

```markdown
- **xmprdf.ts** — the XMP data model (`o6uu.1`): `parseRdfPacket` turns a
  packet into namespace-resolved `RdfProperty[]` (simple values, Bag/Seq/Alt
  arrays, `xml:lang`, structs in all three RDF spellings) and
  `serializeRdfPacket` writes one canonical packet back. A pure leaf over
  `xml.js`; internal until `o6uu.3` puts it under `readXmp`/`buildXmp`.
  **Invariant:** it rides `xml.ts`'s opt-in `{ qnames: true }`, never a second
  parser. `parseXml` STRIPS prefixes by default — `xmlns:dc` arrives as `dc`,
  `rdf:about` as `about` — and RDF names a property by namespace URI, so the
  stripped form cannot be resolved. The option is off for every other caller,
  so they are byte-identical by construction.
  **Invariant:** a property is (namespace URI, local name) and the prefix is a
  serialization PREFERENCE only (`RdfPacket.prefixes`) — resolved per element
  through an `xmlns` scope stack, so a rebound prefix is honoured.
  **Invariant:** DTDs are refused HERE. `xml.ts` SKIPS `<!DOCTYPE>` rather than
  rejecting it (the issue text assumed otherwise), and mis-skips one with an
  internal subset.
  **Invariant:** the round-trip contract is the MODEL, not the bytes —
  `parse(serialize(m))` deep-equals `m`; output is one `rdf:Description` in
  element form whatever the input used.
  **Invariant:** names are Unicode NCNames. Adobe writes a space in a property
  name as U+2182 + hex (`pdfx:Formↂ0020fields`, IRS f1040); an ASCII-only test
  throws on a real packet.
  **Note:** a duplicate property keeps its FIRST occurrence; `rdf:resource`
  reads as a simple value until `o6uu.2`; UTF-16 packets are `readXmp`'s
  decoding problem, not this module's.
  **Note, measured:** <record the mutation results from Step 1>.
```

2. Fixtures table — add a row after `fixtures/xfdf/`:

```markdown
| `fixtures/xmp/` | `PROVENANCE.md` | An XMP packet written by **Adobe Acrobat DC** re-saving a PDF we built (`npm run gen:xmp`): a History Seq of structs, an attribute-form struct and a two-language Alt, re-serialized by Adobe XMP Core. Adobe re-wrote OUR model, so it anchors our parse of Adobe's serialization, not shapes Adobe would choose (`test/xmprdf-real.test.ts`) |
```

3. Build & Test section — in "Each needs a tool that is NOT a dependency: headless Chrome, `mscms.dll`, FontForge." append `, Acrobat DC (`gen:xmp`, manually)`.

- [ ] **Step 3: Full gates**

Run: `npm run typecheck` then `npm test`
Expected: both green (including `test/import-cycles.test.ts`, `test/limits-catch.test.ts`, `test/readme-api.test.ts` — the module adds no cycle, no catch, no export).

Run the module sweep from CLAUDE.md Conventions; expected output empty.

- [ ] **Step 4: Commit, close, push**

```bash
git add CLAUDE.md
git commit -m "docs(o6uu.1): record the XMP data model module"
bd close aspose-pdf-foss-for-ts-o6uu.1
git pull --rebase
git push
git status
```

Expected: `git status` reports up to date with origin. No CHANGELOG entry — nothing user-visible changed.
