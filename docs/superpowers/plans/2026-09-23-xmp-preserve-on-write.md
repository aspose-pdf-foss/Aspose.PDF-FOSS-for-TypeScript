# Preserve Unknown XMP Through SetXmp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SetXmp` and `SetMetadata` edit the parsed packet instead of rebuilding it, so anything the library does not model survives a metadata write. That covers History, qualified identifiers, custom namespaces, PDF/A extension schemas and non-default language items.

**Architecture:** `src/xmp.ts` gains `editXmpPacket(existing, update)`, which builds an `RdfPacket` from the existing bytes, applies each `XmpUpdate` field to its (namespace, name) property, and serializes it with `serializeRdfPacket`. `buildXmp` is reimplemented over the same edit starting from an empty model. `Document.installXmp` calls `editXmpPacket`; `mergeXmp` and `hasXmpField` are deleted.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-xmp-preserve-on-write-design.md`

## Global Constraints

- `editXmpPacket` lives in `src/xmp.ts`. There is no `xmpedit.ts`, because a separate module would close an import 2-cycle with `xmp.ts`.
- `xmp.ts` → `xmprdf.ts` is one-way. `xmprdf.ts` must not import `xmp.ts`.
- Every `catch` in `src/` calls `rethrowLimit(e)` first (`src/errors.ts`). `test/limits-catch.test.ts` enforces it.
- A rejected call leaves the document unchanged: `validateCustom` runs before anything is read or written.
- Setting a field replaces its property IN PLACE, or appends it when absent. `null` deletes it and `undefined` leaves it alone. A replaced property's qualifiers are dropped.
- `title`, `description` and `rights` replace only the `x-default` item of an `rdf:Alt`, or insert one first. Other languages are kept. A non-Alt existing value is replaced by a one-item Alt.
- `authors`, `subjects` and `custom` are replaced whole, and `[]` deletes them. `custom` removes exactly the TOP-LEVEL properties that `readXmp(current).custom` reports, matched by (namespace, name).
- Starting model: no packet gives an empty model. A packet `parseRdfPacket` accepts gives that model, decoded via `readXmp` so UTF-16 works. A packet it rejects gives a model rebuilt from `readXmp`'s fields.
- `editXmpPacket` returns `undefined` only when there was no packet and the result is empty.
- **Plan ruling (not in the spec):** the six built-in namespaces are always written under their standard prefixes (`dc`, `xmp`, `pdf`, `pdfaid`, `pdfuaid`, `pdfxid`). `readXmp`, `pdfaIdValue` and `xmpVersion` match those prefixes LITERALLY, so a packet binding dc under `dcx` would otherwise make `GetXmp().title` vanish after an edit.
- **Plan ruling (not in the spec):** characters XML 1.0 cannot carry are STRIPPED from every value the field mapping writes. `/Info` strings carry `\u0000` in the wild, and `serializeRdfPacket` throws `TypeError` on them, so `SetMetadata({ title })` would otherwise throw where it used to succeed.
- The output is always the canonical `serializeRdfPacket` form, in element form.
- CHANGELOG: one `### Fixed` entry under `## [Unreleased]` that names the layout change.
- Before closing: `npm run typecheck` and `npm test` green.

## Review Focus

1. **A foreign packet binding the dc URI under another prefix, or binding `dc` to another URI.** After `SetXmp({ title })`, `GetXmp().title` must return the new title, and the foreign property must survive. → Task 1, "writes the built-in namespaces under their standard prefixes".
2. **An `/Info` title containing `\u0000`.** `SetMetadata` must succeed and write the title without the NUL, rather than throwing. → Task 1, "strips characters XML cannot carry from mapped values".
3. **A packet that `parseRdfPacket` rejects** (for example a DOCTYPE or broken markup). Editing must fall back to today's behaviour and keep the fields `readXmp` can see, not throw. → Task 1, "falls back to readXmp's fields for a packet that will not parse".
4. **A UTF-16 packet.** It must be edited with its History intact, not rejected. → Task 1, "edits a UTF-16 packet".
5. **An invalid `custom` in `SetXmp`.** The document must stay byte-identical: neither `/Info` nor the packet changes. → Task 2, "leaves the document unchanged when custom is rejected".

---

## File Structure

- Modify `src/xmprdf.ts`: export `stripNonXmlChars`.
- Modify `src/xmp.ts`: add `editXmpPacket`; reimplement `buildXmp`; delete `mergeXmp`.
- Modify `src/document.ts`: replace `installXmp`; update `SetXmp` and `SetMetadata`; delete `hasXmpField`.
- Modify `test/helpers/build-pdfa-pdf.ts`: add an `xmpExtra` option.
- Tests: create `test/xmp-edit.test.ts` (unit) and `test/xmp-preserve.test.ts` (document level); edit `test/xmp.test.ts` (two element-form assertions, drop the `mergeXmp` block).
- Docs: `CHANGELOG.md`, `CLAUDE.md` (`xmp.ts` entry).

---

### Task 1: `editXmpPacket` and `buildXmp` over the model

**Files:**
- Modify: `src/xmprdf.ts` (next to `NOT_XML_CHAR`), `src/xmp.ts`
- Test: `test/xmp-edit.test.ts` (create), `test/xmp.test.ts` (2 assertions)

**Interfaces:**
- Consumes: `parseRdfPacket`, `serializeRdfPacket`, `RdfPacket`, `RdfProperty`, `RdfValue` from `./xmprdf.js`; `rethrowLimit` from `./errors.js`.
- Produces:
  - `export function stripNonXmlChars(s: string): string` (xmprdf.ts)
  - `export function editXmpPacket(existing: Uint8Array | undefined, update: XmpUpdate): string | undefined` (xmp.ts)
  - `buildXmp(meta: XmpMetadata): string`, same signature, now canonical output.

- [ ] **Step 1: Write the failing tests**

Create `test/xmp-edit.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { editXmpPacket, readXmp } from '../src/xmp.js';
import { parseRdfPacket, RDF_NS, type RdfProperty } from '../src/xmprdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const PDFAID = 'http://www.aiim.org/pdfa/ns/id/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const EVT = 'http://ns.adobe.com/xap/1.0/sType/ResourceEvent#';
const ACME = 'http://acme.example/ns/1.0/';
const text = (body: string, extraNs = '') =>
  `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">`
  + `<rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about="" xmlns:dc="${DC}" xmlns:pdf="${PDF}"`
  + ` xmlns:xmpMM="${MM}" xmlns:stEvt="${EVT}" xmlns:acme="${ACME}"${extraNs}>${body}</rdf:Description>`
  + `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
const packet = (body: string, extraNs = '') => enc(text(body, extraNs));
const model = (s: string | undefined): RdfProperty[] => parseRdfPacket(enc(s!)).properties;
const find = (s: string | undefined, ns: string, name: string) => model(s).find((p) => p.ns === ns && p.name === name);
const simple = (value: string) => ({ kind: 'simple' as const, value });
const HISTORY = '<xmpMM:History><rdf:Seq><rdf:li rdf:parseType="Resource"><stEvt:action>created</stEvt:action>'
  + '</rdf:li></rdf:Seq></xmpMM:History>';
const TITLES = '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Old</rdf:li>'
  + '<rdf:li xml:lang="de-DE">Alt</rdf:li></rdf:Alt></dc:title>';

describe('editXmpPacket: what it leaves alone', () => {
  it('keeps every property it does not own, byte-for-byte in the model', () => {
    const src = packet(HISTORY + '<acme:Info rdf:parseType="Resource"><acme:x>y</acme:x></acme:Info>'
      + '<dc:format>application/pdf</dc:format>');
    const before = parseRdfPacket(src).properties;
    const after = model(editXmpPacket(src, { title: 'New' }));
    expect(after.filter((p) => !(p.ns === DC && p.name === 'title'))).toEqual(before);
  });

  it('leaves a field whose update is undefined untouched', () => {
    const src = packet('<pdf:Producer>P</pdf:Producer>');
    expect(model(editXmpPacket(src, { producer: undefined }))).toEqual(parseRdfPacket(src).properties);
  });
});

describe('editXmpPacket: setting and deleting', () => {
  it('replaces a property in place, keeping its position', () => {
    const out = editXmpPacket(packet('<pdf:Producer>old</pdf:Producer><dc:format>f</dc:format>'), { producer: 'new' });
    expect(model(out).map((p) => p.name)).toEqual(['Producer', 'format']);
    expect(find(out, PDF, 'Producer')?.value).toEqual(simple('new'));
  });

  it('appends a property that was absent', () => {
    const out = editXmpPacket(packet('<dc:format>f</dc:format>'), { keywords: 'k' });
    expect(model(out).map((p) => p.name)).toEqual(['format', 'Keywords']);
  });

  it('deletes on null and leaves the rest', () => {
    const out = editXmpPacket(packet('<pdf:Producer>P</pdf:Producer><dc:format>f</dc:format>'), { producer: null });
    expect(model(out).map((p) => p.name)).toEqual(['format']);
  });

  it("drops a replaced property's qualifiers", () => {
    const out = editXmpPacket(packet('<pdf:Producer rdf:parseType="Resource"><rdf:value>old</rdf:value>'
      + '<acme:q>1</acme:q></pdf:Producer>'), { producer: 'new' });
    expect(find(out, PDF, 'Producer')).toEqual({ ns: PDF, name: 'Producer', value: simple('new') });
  });

  it('writes lists whole and deletes them on an empty list', () => {
    const out = editXmpPacket(packet('<dc:subject><rdf:Bag><rdf:li>old</rdf:li></rdf:Bag></dc:subject>'),
      { authors: ['A', 'B'], subjects: ['x'] });
    expect(find(out, DC, 'creator')?.value).toEqual({ kind: 'array', form: 'Seq',
      items: [{ value: simple('A') }, { value: simple('B') }] });
    expect(find(out, DC, 'subject')?.value).toEqual({ kind: 'array', form: 'Bag', items: [{ value: simple('x') }] });
    expect(find(editXmpPacket(enc(out!), { subjects: [] }), DC, 'subject')).toBeUndefined();
  });

  it('writes dates as ISO strings and numbers as their decimal text', () => {
    const out = editXmpPacket(undefined, {
      createDate: new Date('2024-06-03T12:30:45.000Z'), modifyDate: '2024-06-04T08:00:00+02:00',
      pdfaPart: 2, pdfaConformance: 'B',
    });
    expect(find(out, XMP, 'CreateDate')?.value).toEqual(simple('2024-06-03T12:30:45.000Z'));
    expect(find(out, XMP, 'ModifyDate')?.value).toEqual(simple('2024-06-04T08:00:00+02:00'));
    expect(find(out, PDFAID, 'part')?.value).toEqual(simple('2'));
    expect(find(out, PDFAID, 'conformance')?.value).toEqual(simple('B'));
  });
});

describe('editXmpPacket: language alternatives', () => {
  it('replaces only the x-default item and keeps the others in order', () => {
    const out = editXmpPacket(packet(TITLES), { title: 'Neu' });
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt', items: [
      { value: simple('Neu'), lang: 'x-default' }, { value: simple('Alt'), lang: 'de-DE' }] });
  });

  it('inserts x-default first when the Alt has none', () => {
    const out = editXmpPacket(packet('<dc:title><rdf:Alt><rdf:li xml:lang="de-DE">Alt</rdf:li></rdf:Alt></dc:title>'),
      { title: 'New' });
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt', items: [
      { value: simple('New'), lang: 'x-default' }, { value: simple('Alt'), lang: 'de-DE' }] });
  });

  it('replaces a malformed non-Alt value with a one-item Alt', () => {
    const out = editXmpPacket(packet('<dc:title>plain</dc:title>'), { title: 'New' });
    expect(find(out, DC, 'title')?.value).toEqual({ kind: 'array', form: 'Alt',
      items: [{ value: simple('New'), lang: 'x-default' }] });
  });

  it('deletes the whole Alt on null', () => {
    expect(find(editXmpPacket(packet(TITLES), { title: null }), DC, 'title')).toBeUndefined();
  });
});

describe('editXmpPacket: custom', () => {
  const src = packet('<acme:BatchId>1</acme:BatchId><acme:Info rdf:parseType="Resource"><acme:x>y</acme:x></acme:Info>'
    + HISTORY);
  const op = { namespace: ACME, prefix: 'acme', name: 'Operator', value: 'jane' };

  it('replaces exactly the simple literals readXmp reports as custom', () => {
    const out = editXmpPacket(src, { custom: [op] });
    const names = model(out).map((p) => p.name);
    expect(names).not.toContain('BatchId');
    expect(names).toEqual(expect.arrayContaining(['Info', 'History', 'Operator']));
    expect(readXmp(enc(out!)).custom).toEqual(expect.arrayContaining([op]));
  });

  it('removes them on null and keeps structs and arrays', () => {
    const names = model(editXmpPacket(src, { custom: null })).map((p) => p.name);
    expect(names).toEqual(['Info', 'History']);
  });

  it('refuses an invalid custom property before doing anything', () => {
    expect(() => editXmpPacket(src, { title: 'x', custom: [{ ...op, prefix: 'rdf' }] })).toThrow(TypeError);
  });
});

describe('editXmpPacket: starting model', () => {
  it('returns undefined when there was no packet and nothing was added', () => {
    expect(editXmpPacket(undefined, {})).toBeUndefined();
    expect(editXmpPacket(undefined, { title: null })).toBeUndefined();
  });

  it('builds a fresh packet from nothing', () => {
    expect(readXmp(enc(editXmpPacket(undefined, { title: 'T' })!)).title).toBe('T');
  });

  it('still writes a packet whose last property was deleted', () => {
    const out = editXmpPacket(packet('<pdf:Producer>P</pdf:Producer>'), { producer: null });
    expect(out).toBeDefined();
    expect(model(out)).toEqual([]);
  });

  it("falls back to readXmp's fields for a packet that will not parse", () => {
    const broken = enc('<!DOCTYPE x><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title><rdf:Alt>'
      + '<rdf:li xml:lang="x-default">Kept</rdf:li></rdf:Alt></dc:title>');
    const out = editXmpPacket(broken, { producer: 'P' });
    const back = readXmp(enc(out!));
    expect(back.title).toBe('Kept');
    expect(back.producer).toBe('P');
  });

  it('edits a UTF-16 packet', () => {
    const s = text(HISTORY);
    const utf16 = new Uint8Array(2 + s.length * 2);
    utf16[0] = 0xff; utf16[1] = 0xfe;
    for (let i = 0; i < s.length; i++) { utf16[2 + 2 * i] = s.charCodeAt(i) & 0xff; utf16[3 + 2 * i] = s.charCodeAt(i) >> 8; }
    const out = editXmpPacket(utf16, { title: 'T' });
    expect(find(out, MM, 'History')).toBeDefined();
    expect(readXmp(enc(out!)).title).toBe('T');
  });
});

describe('editXmpPacket: rulings the plan added', () => {
  it('writes the built-in namespaces under their standard prefixes', () => {
    const src = enc(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
      + `<rdf:Description rdf:about="" xmlns:dcx="${DC}" xmlns:dc="http://not-dc.example/">`
      + '<dcx:format>f</dcx:format><dc:foreign>kept</dc:foreign></rdf:Description></rdf:RDF></x:xmpmeta>');
    const out = editXmpPacket(src, { title: 'New', pdfaPart: 2 });
    expect(readXmp(enc(out!)).title).toBe('New');
    expect(readXmp(enc(out!)).pdfaPart).toBe(2);
    expect(out).toContain(`xmlns:dc="${DC}"`);
    expect(find(out, 'http://not-dc.example/', 'foreign')?.value).toEqual(simple('kept'));
  });

  it('strips characters XML cannot carry from mapped values', () => {
    const out = editXmpPacket(undefined, { title: 'a\u0000b', authors: ['c\u0001d'] });
    expect(readXmp(enc(out!)).title).toBe('ab');
    expect(readXmp(enc(out!)).authors).toEqual(['cd']);
  });
});
```

In `test/xmp.test.ts`, change two assertions to element form:
- `expect(xml).toContain('pdfuaid:part="1"');` → `expect(xml).toContain('<pdfuaid:part>1</pdfuaid:part>');`
- `expect(xml).toContain('pdfxid:GTS_PDFXVersion="PDF/X-4"');` → `expect(xml).toContain('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>');`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/xmp-edit.test.ts test/xmp.test.ts`
Expected: `xmp-edit.test.ts` fails because `editXmpPacket` is not exported. The two changed `xmp.test.ts` assertions fail on attribute-form output.

- [ ] **Step 3: Export `stripNonXmlChars` from `src/xmprdf.ts`**

Directly below `checkChars`:

```ts
const NOT_XML_CHARS = new RegExp(NOT_XML_CHAR.source, 'gu');

/** `s` with every character XML 1.0 cannot carry removed — for values a
 *  caller hands us (`/Info` strings carry `\u0000` in the wild), where
 *  refusing would turn a metadata write that used to succeed into a throw. */
export function stripNonXmlChars(s: string): string {
  return s.replace(NOT_XML_CHARS, '');
}
```

- [ ] **Step 4: Implement in `src/xmp.ts`**

Add imports at the top:

```ts
import { parseRdfPacket, serializeRdfPacket, stripNonXmlChars, type RdfPacket, type RdfProperty } from './xmprdf.js';
import { rethrowLimit } from './errors.js';
```

Leave `mergeXmp` in place for now; Task 2 deletes it along with its last caller. Replace the whole `buildXmp` function (its doc comment, the `escapeXml` helper above it only if nothing else uses it — `grep -n "escapeXml(" src/xmp.ts` after the edit, and keep `dateStr`) with:

```ts
const NS = {
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
      const i = items.findIndex((it) => it.lang?.toLowerCase() === 'x-default');
      if (i >= 0) items[i] = item; else items.unshift(item);
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
    // which are not properties of the packet and are not ours to remove.
    for (const c of current ?? []) del(c.namespace, c.name);
    for (const c of update.custom ?? []) {
      packet.prefixes.set(c.namespace, c.prefix);
      put({ ns: c.namespace, name: c.name, value: simpleValue(c.value) });
    }
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
  return { properties: packet.properties, prefixes };
}

/** The model to edit: the packet's own when it parses, else a rebuild from
 *  the fields `readXmp` can see — exactly what survived before `o6uu.3`. */
function startModel(existing: Uint8Array | undefined): { packet: RdfPacket; current: XmpMetadata } {
  if (existing === undefined) return { packet: { properties: [], prefixes: new Map() }, current: {} };
  const current = readXmp(existing);
  try {
    return { packet: parseRdfPacket(new TextEncoder().encode(current.raw ?? '')), current };
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
 *  means "write nothing": there was no packet and the result is empty. */
export function editXmpPacket(existing: Uint8Array | undefined, update: XmpUpdate): string | undefined {
  if (update.custom) validateCustom(update.custom);
  const { packet, current } = startModel(existing);
  applyXmpUpdate(packet, update, current.custom);
  if (existing === undefined && packet.properties.length === 0) return undefined;
  return serializeRdfPacket(pinBuiltinPrefixes(packet));
}

/** A fresh packet for `meta`, through the same edit `SetXmp` makes — so the
 *  two cannot disagree about layout. `raw` is ignored. */
export function buildXmp(meta: XmpMetadata): string {
  if (meta.custom) validateCustom(meta.custom);
  const packet: RdfPacket = { properties: [], prefixes: new Map() };
  applyXmpUpdate(packet, meta, undefined);
  return serializeRdfPacket(pinBuiltinPrefixes(packet));
}
```

If `escapeXml` in `xmp.ts` is now unused, delete it (`tsc` with `noUnusedLocals` or a grep shows it).

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/xmp-edit.test.ts test/xmp.test.ts test/xmprdf.test.ts`
Expected: all PASS. Then `npm run typecheck`: clean. `document.ts` still uses `mergeXmp` and the old `installXmp`, and both still exist.

- [ ] **Step 6: Commit**

```bash
git add src/xmprdf.ts src/xmp.ts test/xmp-edit.test.ts test/xmp.test.ts
git commit -m "feat(o6uu.3): editXmpPacket edits the parsed XMP model"
```

---

### Task 2: Document wiring, acceptance, and fences

**Files:**
- Modify: `src/document.ts` (import line ~31; `hasXmpField` ~167; `installXmp` ~1515; `SetMetadata` ~1748; `SetXmp` ~1760)
- Modify: `test/helpers/build-pdfa-pdf.ts` (`PdfaOptions` + `xmpPacket`)
- Test: `test/xmp-preserve.test.ts` (create)

**Interfaces:**
- Consumes: `editXmpPacket(existing: Uint8Array | undefined, update: XmpUpdate): string | undefined` (Task 1).
- Produces: `PdfaOptions.xmpExtra?: string`, raw `rdf:Description` markup appended inside `rdf:RDF`.

- [ ] **Step 1: Add the builder option**

In `test/helpers/build-pdfa-pdf.ts`, add to `PdfaOptions` (in the `// metadata` group):

```ts
  xmpExtra?: string;          // raw rdf:Description markup appended inside rdf:RDF
```

Change the call `xmpPacket(pdfaPart, pdfaConf, pdfaRev, xmpTitle)` to `xmpPacket(pdfaPart, pdfaConf, pdfaRev, xmpTitle, opts.xmpExtra ?? '')`, and `xmpPacket`'s signature and last line to:

```ts
function xmpPacket(
  part: string, conformance: string | null, rev: string | null, title: string, extra: string,
): string {
```
```ts
    + `</rdf:Description>${extra}</rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
```

- [ ] **Step 2: Write the failing document-level tests**

Create `test/xmp-preserve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/index.js';
import { parseRdfPacket, type RdfProperty } from '../src/xmprdf.js';
import { buildXmpPdf } from './helpers/build-xmp-pdf.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildBlankPage } from './helpers/build-annot-target.js';

const enc = (s: string) => new TextEncoder().encode(s);
const DC = 'http://purl.org/dc/elements/1.1/';
const MM = 'http://ns.adobe.com/xap/1.0/mm/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const EXT = 'http://www.aiim.org/pdfa/ns/extension/';
const ACME = 'http://acme.example/ns/1.0/';
const reopen = (doc: Document) => Document.Open(doc.Save());
const modelOf = (doc: Document): RdfProperty[] => parseRdfPacket(enc(doc.GetXmp().raw!)).properties;
const get = (props: RdfProperty[], ns: string, name: string) => props.find((p) => p.ns === ns && p.name === name);
const without = (props: RdfProperty[], ns: string, name: string) =>
  props.filter((p) => !(p.ns === ns && p.name === name));
const adobe = readFileSync('test/fixtures/xmp/acrobat-tutorial-sample.xmp', 'utf8');
const calibre = readFileSync('test/fixtures/xmp/calibre-identifiers.xmp', 'utf8');

const EXTENSION = '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"'
  + ' xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">'
  + '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">'
  + '<pdfaSchema:schema>Acme batch schema</pdfaSchema:schema>'
  + `<pdfaSchema:namespaceURI>${ACME}</pdfaSchema:namespaceURI>`
  + '<pdfaSchema:prefix>acme</pdfaSchema:prefix>'
  + '<pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">'
  + '<pdfaProperty:name>BatchId</pdfaProperty:name><pdfaProperty:valueType>Text</pdfaProperty:valueType>'
  + '<pdfaProperty:category>external</pdfaProperty:category>'
  + '<pdfaProperty:description>Batch identifier</pdfaProperty:description>'
  + '</rdf:li></rdf:Seq></pdfaSchema:property></rdf:li></rdf:Bag></pdfaExtension:schemas></rdf:Description>'
  + `<rdf:Description rdf:about="" xmlns:acme="${ACME}"><acme:BatchId>B-4711</acme:BatchId></rdf:Description>`;

describe('SetXmp / SetMetadata preserve what they do not own (o6uu.3)', () => {
  it('keeps the Adobe History packet intact when the title is set (acceptance)', () => {
    const doc = Document.Open(buildXmpPdf(adobe));
    const before = modelOf(doc);
    doc.SetXmp({ title: 'Renamed' });
    const after = reopen(doc);
    expect(without(modelOf(after), DC, 'title')).toEqual(without(before, DC, 'title'));
    expect(after.GetXmp().title).toBe('Renamed');
    expect(get(modelOf(after), MM, 'History')).toEqual(get(before, MM, 'History'));
  });

  it("keeps calibre's qualified identifiers through SetMetadata", () => {
    const doc = Document.Open(buildXmpPdf(calibre));
    const before = get(modelOf(doc), XMP, 'Identifier');
    doc.SetMetadata({ title: 'Renamed' });
    expect(get(modelOf(reopen(doc)), XMP, 'Identifier')).toEqual(before);
  });

  it('keeps a non-default language of the title', () => {
    const doc = Document.Open(buildXmpPdf(adobe.replace('<rdf:li xml:lang="x-default">',
      '<rdf:li xml:lang="de-DE">Anleitung</rdf:li><rdf:li xml:lang="x-default">')));
    doc.SetMetadata({ title: 'Renamed' });
    const title = get(modelOf(reopen(doc)), DC, 'title');
    expect(title?.value.kind === 'array' && title.value.items.map((it) => it.lang)).toEqual(['de-DE', 'x-default']);
  });

  it('keeps a PDF/A extension schema through a metadata edit, and the document still validates (acceptance)', () => {
    const doc = Document.Open(buildPdfaPdf({ xmpExtra: EXTENSION }, 2));
    expect(doc.ValidatePdfA('2b').Passed).toBe(true);
    const schemas = get(modelOf(doc), EXT, 'schemas');
    expect(schemas).toBeDefined();
    doc.SetMetadata({ title: 'Edited' });
    const after = reopen(doc);
    expect(get(modelOf(after), EXT, 'schemas')).toEqual(schemas);
    expect(get(modelOf(after), ACME, 'BatchId')?.value).toEqual({ kind: 'simple', value: 'B-4711' });
    expect(after.ValidatePdfA('2b').Passed).toBe(true);
  });

  it('keeps History through ConvertToPdfA', () => {
    const doc = Document.Open(buildXmpPdf(adobe));
    const history = get(modelOf(doc), MM, 'History');
    doc.ConvertToPdfA('2b');
    expect(get(modelOf(reopen(doc)), MM, 'History')).toEqual(history);
  });

  it('leaves the document unchanged when custom is rejected', () => {
    const doc = Document.Open(buildXmpPdf(adobe));
    const before = doc.Save();
    expect(() => doc.SetXmp({ title: 'x', custom: [{ namespace: ACME, prefix: 'rdf', name: 'a', value: 'b' }] }))
      .toThrow(TypeError);
    expect(doc.Save()).toEqual(before);
  });

  it('writes no packet for a pure delete on a document without one', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetXmp({ title: null });
    expect(reopen(doc).GetXmp().raw).toBeUndefined();
  });

  it('survives an /Info title carrying NUL', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetMetadata({ title: 'a\u0000b' });
    expect(reopen(doc).GetXmp().title).toBe('ab');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/xmp-preserve.test.ts`
Expected: FAIL. The History, calibre, language, extension-schema and ConvertToPdfA cases fail, because `installXmp` still rebuilds the packet from `mergeXmp`'s fields. The NUL case fails too: `buildXmp` now refuses it through the serializer, which is exactly what `installXmp` must stop hitting.

- [ ] **Step 4: Wire `document.ts`**

Import line: replace `mergeXmp` with `editXmpPacket`:

```ts
import { readXmp, editXmpPacket, mirrorMetaToXmp, mirrorXmpToMeta, XmpMetadata, XmpUpdate } from './xmp.js';
```

If `buildXmp` is no longer used in `document.ts`, drop it from the import too. Delete `hasXmpField` (~167–169). In `src/xmp.ts`, delete `mergeXmp` and its doc comment. In `test/xmp.test.ts`, delete the `describe('mergeXmp', …)` block and drop `mergeXmp` from its import line. Replace `installXmp` with:

```ts
  /** Apply `update` to the document's XMP packet and install the result as
   *  the catalog's /Metadata stream (uncompressed). The packet is EDITED, not
   *  rebuilt (`o6uu.3`), so everything the update does not name survives.
   *  Writes nothing when there was no packet and the update adds nothing. */
  private installXmp(update: XmpUpdate): void {
    const md = this.resolve(this.catalog().get('Metadata'));
    const text = editXmpPacket(isStream(md) ? inflateStream(md) : undefined, update);
    if (text === undefined) return;
    const dict: PdfDict = new Map<string, PdfObject>([
      ['Type', name('Metadata')], ['Subtype', name('XML')],
    ]);
    const stream: PdfStream = { kind: 'stream', dict, raw: new TextEncoder().encode(text) };
    this.catalog().set('Metadata', this.allocObject(stream));
  }
```

`SetMetadata`: replace the lines after `if (Object.keys(xmpUpdate).length === 0) return;` with `this.installXmp(xmpUpdate);`, and delete the `merged`/`hadXmp` lines and their comment. `SetXmp`: replace `this.installXmp(mergeXmp(this.GetXmp(), update));` with `this.installXmp(update);`. It stays BEFORE the `/Info` mirror, so a `custom` rejection throws before `/Info` is touched.

- [ ] **Step 5: Run to verify it passes, then the fences**

Run: `npx vitest run test/xmp-preserve.test.ts test/xmp-edit.test.ts test/xmp.test.ts`, expected PASS. Then `npm run typecheck`, expected clean. Then `npx vitest run test/pdfaconvert.test.ts test/pdfavalidate.test.ts test/pdfa4-validate.test.ts test/pdfuaconvert.test.ts test/pdfxconvert.test.ts test/document-metadata.test.ts test/metadata.test.ts`, expected all PASS with no edits. If one fails, read it: a failure that pins attribute-form packet TEXT is updated to element form like Task 1's two; any other failure is a bug in Tasks 1–2, not a fixture to edit.

- [ ] **Step 6: Commit**

```bash
git add src/xmp.ts src/document.ts test/helpers/build-pdfa-pdf.ts test/xmp-preserve.test.ts test/xmp.test.ts
git commit -m "fix(o6uu.3): SetXmp edits the XMP packet instead of rebuilding it"
```

---

### Task 3: Mutation checks, docs, full gates, close

**Files:** `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Mutations.** For each, apply the change through a node script written with the Write tool (Bash heredocs strip backslashes on this machine). Confirm `git diff` is non-empty, run `npx vitest run test/xmp-edit.test.ts test/xmp-preserve.test.ts test/xmp.test.ts`, record the red count, and restore.

| # | Mutation in `src/xmp.ts` | Must redden |
|---|---|---|
| P1 | `put`: always `props.push(p)` (append, never in place) | "replaces a property in place" |
| P2 | alt branch: `const items = []` (drop other languages) | x-default-only cases, de-DE document case |
| P3 | custom: delete every top-level simple property instead of `current`'s | custom cases |
| P4 | `startModel` catch: `throw e` after `rethrowLimit(e)` | fallback case |
| P5 | `pinBuiltinPrefixes`: return `packet` unchanged | standard-prefixes case |
| P6 | `simpleValue`: drop `stripNonXmlChars` | NUL cases |
| P7 | `editXmpPacket`: drop the `undefined` return | "returns undefined…", pure-delete document case |
| P8 | `installXmp`: pass `undefined` as `existing` (rebuild) | History and extension-schema acceptance |

Any mutation that stays green: add the missing case, or record in the CLAUDE.md entry why it cannot redden.

- [ ] **Step 2: CHANGELOG.** Under `## [Unreleased]`, in `### Fixed` (create the heading after any `### Security`/`### Added`/`### Changed` present, following Keep a Changelog order), add:

```markdown
- **Writing metadata no longer discards XMP the library does not model.**
  `SetXmp`, `SetMetadata` and every conversion that stamps an identification
  (`ConvertToPdfA`, `ConvertToPdfUa`, `ConvertToPdfX`) rebuilt the whole XMP
  packet from its fifteen known fields, so one title edit silently dropped an
  `xmpMM:History`, a `DerivedFrom` reference, identifiers qualified by
  `xmpidq:Scheme`, every non-literal custom property, the translations of a
  title, and a PDF/A extension-schema description — leaving a PDF/A file that
  uses a custom namespace no longer describing it. The packet is now parsed
  into an RDF data model, edited field by field, and written back: a field you
  set replaces its property in place, `null` deletes it, a title replaces only
  its `x-default` language, and everything else survives. The packet is now
  written in one canonical layout (a single `rdf:Description`, properties as
  elements), so its bytes differ from before even where nothing was lost;
  every reader in this library accepts both forms. Characters XML cannot carry
  (such as a NUL in an `/Info` title) are dropped from values written into the
  packet. (o6uu.3)
```

- [ ] **Step 3: CLAUDE.md.** In the `xmp.ts` Source-list entry, after its first two lines, insert:

```markdown
  **Invariant (`o6uu.3`):** a write EDITS the parsed packet, never rebuilds it.
  `editXmpPacket` starts from `parseRdfPacket`'s model (or, when the packet will
  not parse, from `readXmp`'s fields — exactly what survived before), applies
  each field to the (namespace, name) property it owns, and serializes. Set
  replaces IN PLACE, `null` deletes, and everything the update does not name —
  History, qualified identifiers, extension schemas — survives. `buildXmp` is
  the same edit from an empty model, so the two cannot disagree about layout.
  It lives HERE, not in its own module: `buildXmp` must reach it, and a
  separate module importing `readXmp` back would close a 2-cycle.
  **Invariant:** a title, description or rights replaces the `x-default` item
  ONLY; every other language is somebody's translation.
  **Invariant:** `custom` removes the TOP-LEVEL properties `readXmp` currently
  reports as custom, and nothing else. `readXmp`'s regex also reports literal
  FIELDS of structs; those are not properties and are never removed.
  **Invariant:** the six built-in namespaces are written under their STANDARD
  prefixes whatever the source bound them to, because `readXmp`, `pdfaIdValue`
  and `xmpVersion` match `dc:`, `pdfaid:` … literally.
  **Invariant:** characters XML cannot carry are STRIPPED from values we write
  (`stripNonXmlChars`), because `serializeRdfPacket` refuses them and `/Info`
  strings carry `\u0000` in the wild.
  **Note, measured:** <P1–P8 results from Task 3 Step 1>.
```

Write the `\u0000` through a node script file, not a shell one-liner: the Bash tool strips the backslash and writes a real NUL into CLAUDE.md.

- [ ] **Step 4: File the follow-up issue**

```bash
bd create "PDF/A: validate the extension-schema description (ISO 19005-2 6.6.2.3)" --type feature --priority 2 --parent aspose-pdf-foss-for-ts-o6uu -d "ValidatePdfA has no rule requiring every non-predefined XMP namespace in the packet to be described by pdfaExtension:schemas. A file whose custom namespace lost its description validates here and fails veraPDF. o6uu.3 made the description SURVIVE a write, but nothing checks that one is present. Transcribe from veraPDF's PDF_A profiles (parts 1-3; check whether part 4 still requires it)."
```

- [ ] **Step 5: Gates, commit, close, push**

```bash
npm run typecheck
npx vitest run
git add CHANGELOG.md CLAUDE.md
git commit -m "docs(o6uu.3): record XMP edit-on-write"
bd close aspose-pdf-foss-for-ts-o6uu.3
git pull --rebase && git push && git status
```

Expected: typecheck clean, the full suite green, and `git status` up to date with origin.
