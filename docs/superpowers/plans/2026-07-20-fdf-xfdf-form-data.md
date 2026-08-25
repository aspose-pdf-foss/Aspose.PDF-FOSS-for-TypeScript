# FDF / XFDF Form-Data Import & Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round-trip AcroForm field values through FDF and XFDF data files, so a form can be filled, exported, and re-imported without loss.

**Architecture:** Three new modules with a strict one-way dependency. `formdata.ts` holds a format-neutral intermediate model and is the *only* module that touches `Document`/`Field`; `fdf.ts` and `xfdf.ts` convert bytes ↔ that model and know nothing about the form. Import assigns through the existing `Field.Value` setter, which already validates options and regenerates appearance streams.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-fdf-xfdf-form-data-design.md`
**Issue:** `aspose-pdf-foss-for-ts-e1p`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension, e.g. `import { Field } from './form.js';`.
- **strict TypeScript.** `npm run typecheck` must be clean. No `any` without a comment justifying it.
- **Errors** are `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `src/errors.ts`. Do not introduce new error classes.
- **Both gates green before any task is considered done:** `npm run typecheck` and `npm test`.
- **Commit after every task.** Message prefix `feat(fdf):`, `test(fdf):`, or `docs(fdf):`.
- Field-level import problems are **reported, never thrown**. Only an unreadable container throws.

## File Structure

| File | Responsibility | Status |
|---|---|---|
| `src/xml.ts` | Minimal XML reader/writer (node tree, escaping, raw-content passthrough). Knows nothing about XFDF. | Create |
| `src/formdata.ts` | `FormData` model; `collectFormData` (read the form) and `applyFormData` (write it, returning `ImportReport`). | Create |
| `src/xfdf.ts` | `readXfdf` / `writeXfdf` — bytes ↔ `FormData` over `xml.ts`. | Create |
| `src/fdf.ts` | `readFdf` / `writeFdf` — bytes ↔ `FormData` in PDF object syntax. | Create |
| `src/document.ts` | The four public methods. | Modify |
| `src/node.ts` | Four file-path convenience wrappers. | Modify |
| `src/index.ts` | Public type exports. | Modify |
| `README.md` | Forms section + Limitations. | Modify |
| `test/xml.test.ts`, `test/formdata.test.ts`, `test/xfdf.test.ts`, `test/fdf.test.ts`, `test/formdata-roundtrip.test.ts` | Tests. | Create |

**Deviation from the spec, applied deliberately:** the spec placed the XML reader inside `xfdf.ts`. It lives in its own `src/xml.ts` instead — it has a single responsibility, is testable without any XFDF concepts, and issue 73p (annotation round-trip) will reuse it. Note this in the spec when the work lands.

**Second deviation:** `node.ts` wrappers are **async** (`Promise`-returning), matching every existing helper in that file. The spec wrote them as synchronous.

## Existing code this plan relies on

Read these before starting; the plan assumes their exact shapes.

- `src/form.ts` — `Form` (`.Fields: Field[]`, `.Get(fullName)`), `Field` (`.FullName`, `.Type: FieldType`, `.Dict: PdfDict`, `.Options: string[]`, `.Value` getter/setter). The setter validates *before* mutating, so a throw leaves the document untouched, and it calls `GenerateAppearance()` on success.
- `src/lexer.ts` — `new Lexer(buf: Uint8Array, start = 0)`.
- `src/object-parser.ts` — `new ObjectParser(lx)`, `.parseObject(): PdfObject`, `.parseIndirectObject(): { num, gen, value }`.
- `src/serialize.ts` — `serializeValue(o: PdfObject): string`, `enc(s: string): Uint8Array`.
- `src/types.ts` — `PdfObject`, `PdfDict`, `isDict`, `isArray`, `isName`, `isString`, `isRef`, `isStream`, `name(s)`.
- `src/metadata.ts` — `decodePdfText(bytes): string`, `encodePdfText(s): Uint8Array`.
- `src/filters.ts` — `decodeStream(s: PdfStream): Uint8Array`.
- `src/document.ts` — `doc.Form`, `doc.resolve(o)`, `doc.catalog()`, `doc.trailer: PdfDict`.
- `test/helpers/build-form-pdf.ts` — `buildFormPdf(): Uint8Array`. Already contains one of every field kind: text `name` (V=Bob), checkbox `agree` (Off; AP states Yes/Off), radio `color` (V=Red; states Red/Green), choice `size` (Opt S/M/L, V=M), multi-select choice `tags` (Opt `[[(a) (Alpha)] (b) (c)]`, no V), hierarchical text `parent.child`, signature `sig`, editable combo `font`.

---

### Task 1: Minimal XML reader and writer

**Files:**
- Create: `src/xml.ts`
- Test: `test/xml.test.ts`

**Interfaces:**
- Consumes: `PdfParseError` from `src/errors.ts`.
- Produces:
  - `interface XmlNode { name: string; attrs: Map<string, string>; children: XmlNode[]; text: string; raw?: string }`
  - `parseXml(bytes: Uint8Array): XmlNode` — returns the root element
  - `writeXml(root: XmlNode): string`
  - `escapeXml(s: string): string`
  - `unescapeXml(s: string): string`

`raw` is the verbatim source between an element's `>` and its `</name>`, recorded on every parsed element. The writer emits `raw` unescaped when present, in preference to `text`/`children`. This is how rich-text XHTML survives a round trip without being parsed.

- [ ] **Step 1: Write the failing test**

Create `test/xml.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseXml, writeXml, escapeXml, unescapeXml, XmlNode } from '../src/xml.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const node = (name: string, attrs: Record<string, string> = {}, children: XmlNode[] = [], text = ''): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children, text });

describe('parseXml', () => {
  it('parses elements, attributes and text', () => {
    const r = parseXml(enc('<a x="1" y=\'2\'><b>hi</b></a>'));
    expect(r.name).toBe('a');
    expect(r.attrs.get('x')).toBe('1');
    expect(r.attrs.get('y')).toBe('2');
    expect(r.children).toHaveLength(1);
    expect(r.children[0].name).toBe('b');
    expect(r.children[0].text).toBe('hi');
  });

  it('skips the declaration, comments and processing instructions', () => {
    const r = parseXml(enc('<?xml version="1.0"?>\n<!-- note --><a><!--x--><b/></a>'));
    expect(r.name).toBe('a');
    expect(r.children).toHaveLength(1);
    expect(r.children[0].name).toBe('b');
  });

  it('handles self-closing elements', () => {
    const r = parseXml(enc('<a><b n="1"/></a>'));
    expect(r.children[0].attrs.get('n')).toBe('1');
    expect(r.children[0].children).toHaveLength(0);
  });

  it('strips namespace prefixes from element names', () => {
    const r = parseXml(enc('<x:a xmlns:x="urn:z"><x:b>v</x:b></x:a>'));
    expect(r.name).toBe('a');
    expect(r.children[0].name).toBe('b');
  });

  it('unescapes entities in text and attributes', () => {
    const r = parseXml(enc('<a t="&lt;&amp;&quot;&#65;"> &gt;&#x42; </a>'));
    expect(r.attrs.get('t')).toBe('<&"A');
    expect(r.text).toBe(' >B ');
  });

  it('reads CDATA as literal text', () => {
    const r = parseXml(enc('<a><![CDATA[<b>&raw]]></a>'));
    expect(r.text).toBe('<b>&raw');
  });

  it('records raw inner source', () => {
    const r = parseXml(enc('<a><b><i>x</i> y</b></a>'));
    expect(r.children[0].raw).toBe('<i>x</i> y');
  });

  it('throws PdfParseError on mismatched tags', () => {
    expect(() => parseXml(enc('<a><b></a></b>'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError on an unterminated element', () => {
    expect(() => parseXml(enc('<a><b>'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError when there is no root element', () => {
    expect(() => parseXml(enc('<?xml version="1.0"?>'))).toThrow(PdfParseError);
  });
});

describe('writeXml', () => {
  it('emits a declaration, attributes and nested elements', () => {
    const out = writeXml(node('a', { x: '1' }, [node('b', {}, [], 'hi')]));
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('<a x="1">');
    expect(out).toContain('<b>hi</b>');
  });

  it('self-closes empty elements', () => {
    expect(writeXml(node('a', {}, [node('b')]))).toContain('<b/>');
  });

  it('escapes attribute values and text', () => {
    const out = writeXml(node('a', { t: '<&">' }, [], ''));
    expect(out).toContain('t="&lt;&amp;&quot;&gt;"');
  });

  it('emits raw content unescaped', () => {
    const n = node('a');
    n.raw = '<i>x</i>';
    expect(writeXml(n)).toContain('<a><i>x</i></a>');
  });

  it('round-trips through parseXml', () => {
    const src = node('a', { k: 'v&w' }, [node('b', {}, [], 'te<xt')]);
    const back = parseXml(new TextEncoder().encode(writeXml(src)));
    expect(back.attrs.get('k')).toBe('v&w');
    expect(back.children[0].text).toBe('te<xt');
  });
});

describe('escape helpers', () => {
  it('escapes and unescapes symmetrically', () => {
    expect(unescapeXml(escapeXml('a<b>&"c'))).toBe('a<b>&"c');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xml.test.ts`
Expected: FAIL — `Cannot find module '../src/xml.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/xml.ts`:

```ts
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
      if (src.startsWith('/>', i)) { i += 2; return { name, attrs, children: [], text: '' }; }
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
        return { name, attrs, children, text, raw: src.slice(contentStart, contentEnd) };
      }
      if (src.startsWith('<![CDATA[', i)) {
        const e = src.indexOf(']]>', i);
        if (e < 0) fail('unterminated CDATA');
        text += src.slice(i + 9, e);
        i = e + 3;
        continue;
      }
      if (skipMisc()) continue;
      if (src[i] === '<') { children.push(parseElement()); continue; }
      const nx = src.indexOf('<', i);
      const end = nx < 0 ? src.length : nx;
      text += unescapeXml(src.slice(i, end));
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/xml.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck clean.

Note: the `round-trips through parseXml` test relies on the writer emitting
`raw`-free nodes built by the test helper (which never sets `raw`).

- [ ] **Step 5: Commit**

```bash
git add src/xml.ts test/xml.test.ts
git commit -m "feat(fdf): minimal XML reader and writer for XFDF"
```

---

### Task 2: The form-data model and `collectFormData`

**Files:**
- Create: `src/formdata.ts`
- Test: `test/formdata.test.ts`

**Interfaces:**
- Consumes: `Document` (`.Form`, `.resolve`, `.catalog()`, `.trailer`), `Field`, `FieldType` from `src/form.ts`; `decodePdfText` from `src/metadata.ts`; `decodeStream` from `src/filters.ts`.
- Produces:
  - `interface FormDataField { name: string; type: FieldType; values: string[]; richText?: string }`
  - `interface FormData { fields: FormDataField[]; file?: string; id?: [string, string] }`
  - `interface ExportFormDataOptions { includeEmpty?: boolean; file?: string }`
  - `interface ImportReport { imported: string[]; skipped: { name: string; reason: string }[]; sourceFile?: string; sourceId?: [string, string] }`
  - `collectFormData(doc: Document, opts?: ExportFormDataOptions): FormData`
  - `SETTABLE: ReadonlySet<FieldType>` (internal, used by Task 3)

- [ ] **Step 1: Write the failing test**

Create `test/formdata.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { collectFormData } from '../src/formdata.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

const open = () => Document.Open(buildFormPdf());
const byName = (fields: { name: string }[], n: string) => fields.find((f) => f.name === n);

describe('collectFormData', () => {
  it('exports non-empty values with their field types', () => {
    const d = collectFormData(open());
    expect(byName(d.fields, 'name')).toEqual({ name: 'name', type: 'text', values: ['Bob'] });
    expect(byName(d.fields, 'color')).toEqual({ name: 'color', type: 'radio', values: ['Red'] });
    expect(byName(d.fields, 'size')).toEqual({ name: 'size', type: 'choice', values: ['M'] });
  });

  it('omits empty and Off fields by default', () => {
    const d = collectFormData(open());
    expect(byName(d.fields, 'agree')).toBeUndefined(); // checkbox at Off
    expect(byName(d.fields, 'tags')).toBeUndefined();  // multi-select, no /V
  });

  it('includes empty fields when asked', () => {
    const d = collectFormData(open(), { includeEmpty: true });
    expect(byName(d.fields, 'agree')).toEqual({ name: 'agree', type: 'checkbox', values: ['Off'] });
    expect(byName(d.fields, 'tags')?.values).toEqual(['']);
  });

  it('exports a checked checkbox as its on-state name', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    expect(byName(collectFormData(doc).fields, 'agree')?.values).toEqual(['Yes']);
  });

  it('exports a multi-select choice as several values', () => {
    const doc = open();
    doc.Form.Get('tags')!.Value = ['a', 'b'];
    expect(byName(collectFormData(doc).fields, 'tags')?.values).toEqual(['a', 'b']);
  });

  it('uses fully-qualified names for nested fields', () => {
    const doc = open();
    doc.Form.Get('parent.child')!.Value = 'kid';
    expect(byName(collectFormData(doc).fields, 'parent.child')?.values).toEqual(['kid']);
  });

  it('never exports signature or pushbutton fields', () => {
    const d = collectFormData(open(), { includeEmpty: true });
    expect(byName(d.fields, 'sig')).toBeUndefined();
  });

  it('carries the /F reference only when given', () => {
    expect(collectFormData(open()).file).toBeUndefined();
    expect(collectFormData(open(), { file: 'form.pdf' }).file).toBe('form.pdf');
  });

  it('exports /RV rich text when the field has it', () => {
    const doc = open();
    const f = doc.Form.Get('name')!;
    f.Dict.set('RV', { kind: 'string', bytes: new TextEncoder().encode('<body><b>Bob</b></body>') });
    expect(byName(collectFormData(doc).fields, 'name')?.richText).toBe('<body><b>Bob</b></body>');
  });

  it('returns an empty field list for a document with no form', () => {
    const doc = Document.Open(buildFormPdf());
    doc.catalog().delete('AcroForm');
    expect(collectFormData(doc).fields).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/formdata.test.ts`
Expected: FAIL — `Cannot find module '../src/formdata.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/formdata.ts`:

```ts
import type { Document } from './document.js';
import type { Field, FieldType } from './form.js';
import { isArray, isDict, isStream, isString } from './types.js';
import { decodePdfText } from './metadata.js';
import { decodeStream } from './filters.js';

/** One field's data, format-neutral. Values are always strings — XFDF has no
 *  boolean type, so a checkbox travels as its appearance-state name. */
export interface FormDataField {
  /** Fully-qualified field name, segments joined with '.'. */
  name: string;
  /** Source field type; 'unknown' on the import path, where the format
   *  modules cannot know it and applyFormData resolves it from the form. */
  type: FieldType;
  /** Length > 1 only for multi-select choice. */
  values: string[];
  /** Verbatim XHTML from /RV, when present. */
  richText?: string;
}

export interface FormData {
  fields: FormDataField[];
  /** /F — the file the data was exported from. */
  file?: string;
  /** The originating document's trailer /ID pair, hex-encoded. */
  id?: [string, string];
}

export interface ExportFormDataOptions {
  /** Emit fields whose value is empty or Off. Default false. */
  includeEmpty?: boolean;
  /** Value for the /F source-file reference. Omitted when absent. */
  file?: string;
}

export interface ImportReport {
  /** Fully-qualified names of fields that were set. */
  imported: string[];
  /** Fields present in the data file that were not applied. */
  skipped: { name: string; reason: string }[];
  /** /F from the data file, when present. */
  sourceFile?: string;
  /** /ID from the data file, when present. */
  sourceId?: [string, string];
}

/** The field types that carry an exportable, settable value. */
export const SETTABLE: ReadonlySet<FieldType> =
  new Set<FieldType>(['text', 'checkbox', 'radio', 'choice']);

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The document's trailer /ID as a hex pair, or undefined. */
function readDocId(doc: Document): [string, string] | undefined {
  const id = doc.resolve(doc.trailer.get('ID'));
  if (!isArray(id) || id.length < 2) return undefined;
  const a = doc.resolve(id[0]);
  const b = doc.resolve(id[1]);
  if (!isString(a) || !isString(b)) return undefined;
  return [hex(a.bytes), hex(b.bytes)];
}

/** A field's /RV rich text, from either the string or the stream form. */
function readRichText(doc: Document, field: Field): string | undefined {
  const rv = doc.resolve(field.Dict.get('RV'));
  if (isString(rv)) return decodePdfText(rv.bytes);
  if (isStream(rv)) return new TextDecoder('utf-8').decode(decodeStream(rv));
  return undefined;
}

/** A checked checkbox exports as its widget's on-state name. */
function checkedState(field: Field): string {
  return field.Options[0] ?? 'Yes';
}

/** True when the value carries no information: empty text/choice, or Off. */
function isEmpty(values: string[]): boolean {
  return values.length === 0 || (values.length === 1 && (values[0] === '' || values[0] === 'Off'));
}

/** Read the document's form into the format-neutral model. */
export function collectFormData(doc: Document, opts: ExportFormDataOptions = {}): FormData {
  const fields: FormDataField[] = [];
  for (const f of doc.Form.Fields) {
    if (!SETTABLE.has(f.Type)) continue; // signature, pushbutton, unknown
    const v = f.Value;
    const values = typeof v === 'boolean' ? [v ? checkedState(f) : 'Off']
      : Array.isArray(v) ? v
      : [v];
    if (isEmpty(values) && !opts.includeEmpty) continue;
    const entry: FormDataField = { name: f.FullName, type: f.Type, values };
    const rv = readRichText(doc, f);
    if (rv !== undefined) entry.richText = rv;
    fields.push(entry);
  }

  const out: FormData = { fields };
  if (opts.file !== undefined) out.file = opts.file;
  const id = readDocId(doc);
  if (id !== undefined) out.id = id;
  return out;
}

/** True when the catalog has an /AcroForm dictionary at all. */
export function hasAcroForm(doc: Document): boolean {
  return isDict(doc.resolve(doc.catalog().get('AcroForm')));
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/formdata.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck clean.

If `includes empty fields when asked` fails on `tags`, check what `Field.Value` returns for a multi-select choice with no `/V`: the getter falls through to `isString(v) ? … : ''`, so the expected value is `['']`.

- [ ] **Step 5: Commit**

```bash
git add src/formdata.ts test/formdata.test.ts
git commit -m "feat(fdf): format-neutral form-data model and export collection"
```

---

### Task 3: `applyFormData` and the import report

**Files:**
- Modify: `src/formdata.ts` (append)
- Test: `test/formdata.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `applyFormData(doc: Document, data: FormData): ImportReport`

Multi-select is inferred from `values.length > 1` rather than from the field's
flags: a single value is always passed as a string, which is valid `/V` for a
multi-select field too. An array against a non-multi-select field makes the
existing setter throw, which becomes a `skipped` entry — the correct outcome.

- [ ] **Step 1: Write the failing test**

Append to `test/formdata.test.ts`:

```ts
import { applyFormData } from '../src/formdata.js';
import type { FormData } from '../src/formdata.js';

const data = (fields: FormData['fields'], extra: Partial<FormData> = {}): FormData =>
  ({ fields, ...extra });
const entry = (name: string, values: string[]) => ({ name, type: 'unknown' as const, values });

describe('applyFormData', () => {
  it('sets each field type from string values', () => {
    const doc = open();
    const r = applyFormData(doc, data([
      entry('name', ['Ada']),
      entry('agree', ['Yes']),
      entry('color', ['Green']),
      entry('size', ['L']),
      entry('tags', ['a', 'b']),
    ]));
    expect(r.skipped).toEqual([]);
    expect(r.imported).toHaveLength(5);
    const form = doc.Form;
    expect(form.Get('name')!.Value).toBe('Ada');
    expect(form.Get('agree')!.Value).toBe(true);
    expect(form.Get('color')!.Value).toBe('Green');
    expect(form.Get('size')!.Value).toBe('L');
    expect(form.Get('tags')!.Value).toEqual(['a', 'b']);
  });

  it('treats Off and an absent value as unchecked', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    applyFormData(doc, data([entry('agree', ['Off'])]));
    expect(doc.Form.Get('agree')!.Value).toBe(false);

    doc.Form.Get('agree')!.Value = true;
    applyFormData(doc, data([entry('agree', [])]));
    expect(doc.Form.Get('agree')!.Value).toBe(false);
  });

  it('skips an unknown field name without throwing', () => {
    const doc = open();
    const r = applyFormData(doc, data([entry('ghost', ['x']), entry('name', ['Ada'])]));
    expect(r.imported).toEqual(['name']);
    expect(r.skipped).toEqual([{ name: 'ghost', reason: 'no such field' }]);
  });

  it('skips a rejected value and leaves the field unchanged', () => {
    const doc = open();
    const r = applyFormData(doc, data([entry('size', ['XXL'])]));
    expect(r.imported).toEqual([]);
    expect(r.skipped[0].name).toBe('size');
    expect(r.skipped[0].reason).toContain('XXL');
    expect(doc.Form.Get('size')!.Value).toBe('M'); // untouched
  });

  it('skips field types that carry no settable value', () => {
    const doc = open();
    const r = applyFormData(doc, data([entry('sig', ['x'])]));
    expect(r.skipped).toEqual([{ name: 'sig', reason: 'field type is not settable' }]);
  });

  it('skips everything when the document has no form', () => {
    const doc = open();
    doc.catalog().delete('AcroForm');
    const r = applyFormData(doc, data([entry('name', ['Ada'])]));
    expect(r.imported).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'name', reason: 'document has no form' }]);
  });

  it('surfaces the source file and id without enforcing them', () => {
    const doc = open();
    const r = applyFormData(doc, data([], { file: 'other.pdf', id: ['aa', 'bb'] }));
    expect(r.sourceFile).toBe('other.pdf');
    expect(r.sourceId).toEqual(['aa', 'bb']);
  });

  it('applies rich text alongside the plain value', () => {
    const doc = open();
    applyFormData(doc, data([{ name: 'name', type: 'unknown', values: ['Ada'], richText: '<body>A</body>' }]));
    const rv = doc.Form.Get('name')!.Dict.get('RV') as { kind: 'string'; bytes: Uint8Array };
    expect(new TextDecoder().decode(rv.bytes)).toContain('<body>A</body>');
  });

  it('regenerates the appearance stream on import', () => {
    const doc = open();
    applyFormData(doc, data([entry('name', ['Ada'])]));
    const ap = doc.resolve(doc.Form.Get('name')!.Dict.get('AP'));
    expect(ap).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/formdata.test.ts`
Expected: the new `describe('applyFormData')` block FAILS — `applyFormData is not a function`. The Task 2 block still passes.

- [ ] **Step 3: Write the implementation**

Append to `src/formdata.ts` (and add `encodePdfText` to the existing
`./metadata.js` import):

```ts
/** The typed value to hand the Field.Value setter, given the live field type. */
function typedValue(type: FieldType, values: string[]): string | string[] | boolean {
  switch (type) {
    case 'checkbox':
      // An absent or empty value is unchecked, not checked.
      return values.length > 0 && values[0] !== 'Off' && values[0] !== '';
    case 'choice':
      // More than one value means multi-select; the setter rejects an array
      // against a single-select field, which becomes a skip.
      return values.length > 1 ? values : values[0] ?? '';
    default:
      return values[0] ?? '';
  }
}

/** Apply form data to the document, reporting what landed and what did not.
 *  Values go through the Field.Value setter, which validates before mutating
 *  and regenerates appearance streams, so a rejected field leaves the
 *  document untouched. */
export function applyFormData(doc: Document, data: FormData): ImportReport {
  const report: ImportReport = { imported: [], skipped: [] };
  if (data.file !== undefined) report.sourceFile = data.file;
  if (data.id !== undefined) report.sourceId = data.id;

  if (!hasAcroForm(doc)) {
    for (const e of data.fields) report.skipped.push({ name: e.name, reason: 'document has no form' });
    return report;
  }

  const form = doc.Form;
  for (const e of data.fields) {
    const field = form.Get(e.name);
    if (field === undefined) {
      report.skipped.push({ name: e.name, reason: 'no such field' });
      continue;
    }
    if (!SETTABLE.has(field.Type)) {
      report.skipped.push({ name: e.name, reason: 'field type is not settable' });
      continue;
    }
    try {
      field.Value = typedValue(field.Type, e.values);
    } catch (err) {
      report.skipped.push({ name: e.name, reason: (err as Error).message });
      continue;
    }
    if (e.richText !== undefined)
      field.Dict.set('RV', { kind: 'string', bytes: encodePdfText(e.richText) });
    report.imported.push(e.name);
  }
  return report;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/formdata.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/formdata.ts test/formdata.test.ts
git commit -m "feat(fdf): apply form data with a skip-reporting import"
```

---

### Task 4: XFDF read and write

**Files:**
- Create: `src/xfdf.ts`
- Test: `test/xfdf.test.ts`

**Interfaces:**
- Consumes: `XmlNode`, `parseXml`, `writeXml` from `src/xml.ts`; `FormData`, `FormDataField` from `src/formdata.ts`; `PdfParseError`.
- Produces: `writeXfdf(data: FormData): Uint8Array`, `readXfdf(bytes: Uint8Array): FormData`

- [ ] **Step 1: Write the failing test**

Create `test/xfdf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readXfdf, writeXfdf } from '../src/xfdf.js';
import type { FormData } from '../src/formdata.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const f = (name: string, values: string[], richText?: string) =>
  ({ name, type: 'text' as const, values, ...(richText !== undefined ? { richText } : {}) });
const byName = (d: FormData, n: string) => d.fields.find((x) => x.name === n);

describe('writeXfdf', () => {
  it('emits the xfdf root with the Adobe namespace', () => {
    const out = dec(writeXfdf({ fields: [] }));
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('xmlns="http://ns.adobe.com/xfdf/"');
  });

  it('nests fields by dotted name segment', () => {
    const out = dec(writeXfdf({ fields: [f('parent.child', ['kid'])] }));
    expect(out).toMatch(/<field name="parent">[\s\S]*<field name="child">/);
    expect(out).toContain('<value>kid</value>');
  });

  it('shares a parent element between sibling fields', () => {
    const out = dec(writeXfdf({ fields: [f('a.x', ['1']), f('a.y', ['2'])] }));
    expect(out.match(/<field name="a">/g)).toHaveLength(1);
  });

  it('emits one value element per multi-select value', () => {
    const out = dec(writeXfdf({ fields: [f('tags', ['a', 'b'])] }));
    expect(out.match(/<value>/g)).toHaveLength(2);
  });

  it('escapes text and attribute content', () => {
    const out = dec(writeXfdf({ fields: [f('a&b', ['<x>'])] }));
    expect(out).toContain('name="a&amp;b"');
    expect(out).toContain('<value>&lt;x&gt;</value>');
  });

  it('emits rich text as unescaped markup', () => {
    const out = dec(writeXfdf({ fields: [f('n', ['A'], '<body><b>A</b></body>')] }));
    expect(out).toContain('<value-richtext><body><b>A</b></body></value-richtext>');
  });

  it('emits f and ids only when present', () => {
    expect(dec(writeXfdf({ fields: [] }))).not.toContain('<f ');
    const out = dec(writeXfdf({ fields: [], file: 'form.pdf', id: ['aa', 'bb'] }));
    expect(out).toContain('<f href="form.pdf"/>');
    expect(out).toContain('<ids original="aa" modified="bb"/>');
  });
});

describe('readXfdf', () => {
  it('reads flat and nested fields into dotted names', () => {
    const d = readXfdf(enc(
      '<xfdf xmlns="http://ns.adobe.com/xfdf/"><fields>' +
      '<field name="name"><value>Ada</value></field>' +
      '<field name="parent"><field name="child"><value>kid</value></field></field>' +
      '</fields></xfdf>'));
    expect(byName(d, 'name')?.values).toEqual(['Ada']);
    expect(byName(d, 'parent.child')?.values).toEqual(['kid']);
    expect(byName(d, 'parent')).toBeUndefined(); // container only, no value
  });

  it('collects repeated values in document order', () => {
    const d = readXfdf(enc('<xfdf><fields><field name="t"><value>a</value><value>b</value></field></fields></xfdf>'));
    expect(byName(d, 't')?.values).toEqual(['a', 'b']);
  });

  it('reads without the namespace declaration and through a prefix', () => {
    const d = readXfdf(enc('<x:xfdf xmlns:x="http://ns.adobe.com/xfdf/"><x:fields><x:field name="n"><x:value>v</x:value></x:field></x:fields></x:xfdf>'));
    expect(byName(d, 'n')?.values).toEqual(['v']);
  });

  it('reads CDATA values', () => {
    const d = readXfdf(enc('<xfdf><fields><field name="n"><value><![CDATA[a<b]]></value></field></fields></xfdf>'));
    expect(byName(d, 'n')?.values).toEqual(['a<b']);
  });

  it('reads rich text as raw markup', () => {
    const d = readXfdf(enc('<xfdf><fields><field name="n"><value>A</value><value-richtext><body><b>A</b></body></value-richtext></field></fields></xfdf>'));
    expect(byName(d, 'n')?.richText).toBe('<body><b>A</b></body>');
  });

  it('reads f and ids', () => {
    const d = readXfdf(enc('<xfdf><f href="form.pdf"/><ids original="aa" modified="bb"/><fields/></xfdf>'));
    expect(d.file).toBe('form.pdf');
    expect(d.id).toEqual(['aa', 'bb']);
  });

  it('tolerates a document with no fields element', () => {
    expect(readXfdf(enc('<xfdf/>')).fields).toEqual([]);
  });

  it('throws PdfParseError on a wrong root element', () => {
    expect(() => readXfdf(enc('<fdf/>'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError on malformed XML', () => {
    expect(() => readXfdf(enc('<xfdf><fields>'))).toThrow(PdfParseError);
  });

  it('round-trips through writeXfdf', () => {
    const src: FormData = {
      fields: [f('name', ['Ada']), f('parent.child', ['kid']), f('tags', ['a', 'b']), f('rt', ['A'], '<body>A</body>')],
      file: 'form.pdf',
      id: ['aa', 'bb'],
    };
    const back = readXfdf(writeXfdf(src));
    expect(back.file).toBe('form.pdf');
    expect(back.id).toEqual(['aa', 'bb']);
    for (const want of src.fields) {
      const got = byName(back, want.name);
      expect(got?.values).toEqual(want.values);
      expect(got?.richText).toBe(want.richText);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xfdf.test.ts`
Expected: FAIL — `Cannot find module '../src/xfdf.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/xfdf.ts`:

```ts
import { PdfParseError } from './errors.js';
import { parseXml, writeXml, XmlNode } from './xml.js';
import type { FormData, FormDataField } from './formdata.js';

const XFDF_NS = 'http://ns.adobe.com/xfdf/';

const el = (name: string, attrs: Record<string, string> = {}): XmlNode =>
  ({ name, attrs: new Map(Object.entries(attrs)), children: [], text: '' });

/** Find or create the `<field name="seg">` child of `parent`. */
function fieldChild(parent: XmlNode, seg: string): XmlNode {
  for (const c of parent.children)
    if (c.name === 'field' && c.attrs.get('name') === seg) return c;
  const made = el('field', { name: seg });
  parent.children.push(made);
  return made;
}

/** Serialize form data as an XFDF document. */
export function writeXfdf(data: FormData): Uint8Array {
  const root = el('xfdf', { xmlns: XFDF_NS });
  if (data.file !== undefined) root.children.push(el('f', { href: data.file }));
  if (data.id !== undefined)
    root.children.push(el('ids', { original: data.id[0], modified: data.id[1] }));

  const fields = el('fields');
  for (const f of data.fields) {
    let target = fields;
    for (const seg of f.name.split('.')) target = fieldChild(target, seg);
    for (const v of f.values) {
      const value = el('value');
      value.text = v;
      target.children.push(value);
    }
    if (f.richText !== undefined) {
      const rt = el('value-richtext');
      rt.raw = f.richText; // markup, emitted verbatim
      target.children.push(rt);
    }
  }
  root.children.push(fields);
  return new TextEncoder().encode(writeXml(root));
}

/** Walk nested <field> elements, emitting an entry for each one that has a
 *  value. Elements that only nest children are containers, not fields. */
function walkFields(node: XmlNode, path: string, out: FormDataField[]): void {
  for (const child of node.children) {
    if (child.name !== 'field') continue;
    const seg = child.attrs.get('name') ?? '';
    const full = path === '' ? seg : `${path}.${seg}`;
    const values: string[] = [];
    let richText: string | undefined;
    for (const c of child.children) {
      if (c.name === 'value') values.push(c.text);
      else if (c.name === 'value-richtext') richText = c.raw ?? c.text;
    }
    if (values.length > 0 || richText !== undefined) {
      const entry: FormDataField = { name: full, type: 'unknown', values };
      if (richText !== undefined) entry.richText = richText;
      out.push(entry);
    }
    walkFields(child, full, out);
  }
}

/** Parse an XFDF document into the format-neutral model. */
export function readXfdf(bytes: Uint8Array): FormData {
  const root = parseXml(bytes);
  if (root.name !== 'xfdf')
    throw new PdfParseError(`XFDF: root element is <${root.name}>, expected <xfdf>`);

  const data: FormData = { fields: [] };
  const f = root.children.find((c) => c.name === 'f');
  const href = f?.attrs.get('href');
  if (href !== undefined) data.file = href;

  const ids = root.children.find((c) => c.name === 'ids');
  const orig = ids?.attrs.get('original');
  const mod = ids?.attrs.get('modified');
  if (orig !== undefined && mod !== undefined) data.id = [orig, mod];

  const fields = root.children.find((c) => c.name === 'fields');
  if (fields !== undefined) walkFields(fields, '', data.fields);
  return data;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/xfdf.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/xfdf.ts test/xfdf.test.ts
git commit -m "feat(fdf): XFDF read and write"
```

---

### Task 5: FDF read and write

**Files:**
- Create: `src/fdf.ts`
- Test: `test/fdf.test.ts`

**Interfaces:**
- Consumes: `Lexer`, `ObjectParser`, `serializeValue`, `enc`, type guards from `src/types.ts`, `decodePdfText`/`encodePdfText`, `FormData`/`FormDataField`.
- Produces: `writeFdf(data: FormData): Uint8Array`, `readFdf(bytes: Uint8Array): FormData`

- [ ] **Step 1: Write the failing test**

Create `test/fdf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFdf, writeFdf } from '../src/fdf.js';
import type { FormData } from '../src/formdata.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const byName = (d: FormData, n: string) => d.fields.find((x) => x.name === n);

describe('writeFdf', () => {
  it('emits a header, a trailer and no xref', () => {
    const out = dec(writeFdf({ fields: [] }));
    expect(out.startsWith('%FDF-1.2')).toBe(true);
    expect(out).toContain('trailer');
    expect(out.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(out).not.toContain('xref');
  });

  it('writes checkbox and radio values as names, text as a string', () => {
    const out = dec(writeFdf({ fields: [
      { name: 'agree', type: 'checkbox', values: ['Yes'] },
      { name: 'color', type: 'radio', values: ['Red'] },
      { name: 'name', type: 'text', values: ['Bob'] },
    ] }));
    expect(out).toContain('/V /Yes');
    expect(out).toContain('/V /Red');
    expect(out).toContain('/V (Bob)');
  });

  it('writes a multi-value choice as an array', () => {
    const out = dec(writeFdf({ fields: [{ name: 'tags', type: 'choice', values: ['a', 'b'] }] }));
    expect(out).toContain('/V [(a) (b)]');
  });

  it('writes full dotted names in a flat field list', () => {
    const out = dec(writeFdf({ fields: [{ name: 'parent.child', type: 'text', values: ['kid'] }] }));
    expect(out).toContain('/T (parent.child)');
  });

  it('writes f and ids only when present', () => {
    expect(dec(writeFdf({ fields: [] }))).not.toContain('/F (');
    expect(dec(writeFdf({ fields: [] }))).not.toContain('/ID');
    const out = dec(writeFdf({ fields: [], file: 'form.pdf', id: ['aabb', 'ccdd'] }));
    expect(out).toContain('/F (form.pdf)');
    // serializeValue emits PDF *literal* strings, so the id bytes 0xaa 0xbb
    // come out octal-escaped, not as <aabb>. readFdf hex-encodes them back;
    // the round-trip test below is what pins the actual value.
    expect(out).toContain('/ID [');
  });

  it('writes rich text as /RV', () => {
    const out = dec(writeFdf({ fields: [{ name: 'n', type: 'text', values: ['A'], richText: '<body>A</body>' }] }));
    expect(out).toContain('/RV (<body>A</body>)');
  });
});

describe('readFdf', () => {
  const doc = (fdfDict: string) =>
    enc(`%FDF-1.2\n1 0 obj\n<< /FDF ${fdfDict} >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

  it('reads names, strings and arrays as string values', () => {
    const d = readFdf(doc('<< /Fields [<< /T (name) /V (Bob) >> << /T (agree) /V /Yes >> << /T (tags) /V [(a) (b)] >>] >>'));
    expect(byName(d, 'name')?.values).toEqual(['Bob']);
    expect(byName(d, 'agree')?.values).toEqual(['Yes']);
    expect(byName(d, 'tags')?.values).toEqual(['a', 'b']);
  });

  it('always reports type unknown, for the form to resolve', () => {
    const d = readFdf(doc('<< /Fields [<< /T (name) /V (Bob) >>] >>'));
    expect(byName(d, 'name')?.type).toBe('unknown');
  });

  it('flattens a /Kids tree into dotted names', () => {
    const d = readFdf(doc('<< /Fields [<< /T (parent) /Kids [<< /T (child) /V (kid) >>] >>] >>'));
    expect(byName(d, 'parent.child')?.values).toEqual(['kid']);
    expect(byName(d, 'parent')).toBeUndefined();
  });

  it('reads /RV rich text', () => {
    const d = readFdf(doc('<< /Fields [<< /T (n) /V (A) /RV (<body>A</body>) >>] >>'));
    expect(byName(d, 'n')?.richText).toBe('<body>A</body>');
  });

  it('reads /F and /ID', () => {
    const d = readFdf(doc('<< /Fields [] /F (form.pdf) /ID [<aabb> <ccdd>] >>'));
    expect(d.file).toBe('form.pdf');
    expect(d.id).toEqual(['aabb', 'ccdd']);
  });

  it('follows indirect references', () => {
    const src = enc('%FDF-1.2\n1 0 obj\n<< /FDF 2 0 R >>\nendobj\n2 0 obj\n<< /Fields [3 0 R] >>\nendobj\n3 0 obj\n<< /T (name) /V (Bob) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
    expect(byName(readFdf(src), 'name')?.values).toEqual(['Bob']);
  });

  it('tolerates an xref table when present', () => {
    const src = enc('%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [<< /T (n) /V (v) >>] >> >>\nendobj\nxref\n0 2\n0000000000 65535 f \n0000000009 00000 n \ntrailer\n<< /Root 1 0 R /Size 2 >>\nstartxref\n0\n%%EOF\n');
    expect(byName(readFdf(src), 'n')?.values).toEqual(['v']);
  });

  it('throws PdfParseError without an %FDF- header', () => {
    expect(() => readFdf(enc('%PDF-1.7\ntrailer\n<< /Root 1 0 R >>\n'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError with no trailer', () => {
    expect(() => readFdf(enc('%FDF-1.2\n1 0 obj\n<< >>\nendobj\n'))).toThrow(PdfParseError);
  });

  it('throws PdfParseError when /Root has no /FDF dictionary', () => {
    expect(() => readFdf(enc('%FDF-1.2\n1 0 obj\n<< >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n'))).toThrow(PdfParseError);
  });

  it('round-trips through writeFdf', () => {
    const src: FormData = {
      fields: [
        { name: 'name', type: 'text', values: ['Bob'] },
        { name: 'agree', type: 'checkbox', values: ['Yes'] },
        { name: 'parent.child', type: 'text', values: ['kid'] },
        { name: 'tags', type: 'choice', values: ['a', 'b'] },
        { name: 'rt', type: 'text', values: ['A'], richText: '<body>A</body>' },
      ],
      file: 'form.pdf',
      id: ['aabb', 'ccdd'],
    };
    const back = readFdf(writeFdf(src));
    expect(back.file).toBe('form.pdf');
    expect(back.id).toEqual(['aabb', 'ccdd']);
    for (const want of src.fields) {
      const got = byName(back, want.name);
      expect(got?.values).toEqual(want.values);
      expect(got?.richText).toBe(want.richText);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fdf.test.ts`
Expected: FAIL — `Cannot find module '../src/fdf.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/fdf.ts`:

```ts
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { PdfParseError } from './errors.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isRef, isString, name } from './types.js';
import { enc, serializeValue } from './serialize.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import type { FormData, FormDataField } from './formdata.js';

const str = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });
const latin1 = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);

/** /V for one field: a name for the button types, a string for text and
 *  single-select choice, an array of strings for multi-select. */
function fieldValue(f: FormDataField): PdfObject {
  if (f.type === 'checkbox' || f.type === 'radio') return name(f.values[0] ?? 'Off');
  if (f.values.length > 1) return f.values.map(str);
  return str(f.values[0] ?? '');
}

/** Serialize form data as an FDF file. The field list is flat, with each
 *  entry's /T carrying the full dotted name — legal, and what most producers
 *  emit. No cross-reference table is written; FDF permits its absence. */
export function writeFdf(data: FormData): Uint8Array {
  const fields: PdfObject[] = data.fields.map((f) => {
    const d: PdfDict = new Map<string, PdfObject>();
    d.set('T', str(f.name));
    d.set('V', fieldValue(f));
    if (f.richText !== undefined) d.set('RV', str(f.richText));
    return d;
  });

  const fdf: PdfDict = new Map<string, PdfObject>();
  fdf.set('Fields', fields);
  if (data.file !== undefined) fdf.set('F', str(data.file));
  if (data.id !== undefined)
    fdf.set('ID', [hexString(data.id[0]), hexString(data.id[1])]);

  const root: PdfDict = new Map<string, PdfObject>([['FDF', fdf]]);
  return enc(
    '%FDF-1.2\n' +
    `1 0 obj\n${serializeValue(root)}\nendobj\n` +
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n');
}

/** A hex-digit string, serialized as a PDF hex string rather than a literal. */
function hexString(hex: string): PdfObject {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { kind: 'string', bytes };
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Values as strings, whatever PDF type they arrived as. */
function valueStrings(v: PdfObject, resolve: (o: PdfObject) => PdfObject): string[] {
  if (isString(v)) return [decodePdfText(v.bytes)];
  if (isName(v)) return [v.name];
  if (isArray(v)) {
    const out: string[] = [];
    for (const e of v) {
      const r = resolve(e);
      if (isString(r)) out.push(decodePdfText(r.bytes));
      else if (isName(r)) out.push(r.name);
    }
    return out;
  }
  return [];
}

/** Flatten the /Fields tree, joining /T segments with '.'. Only nodes that
 *  carry a value become entries; the rest are containers. */
function walkFields(
  node: PdfObject,
  path: string,
  resolve: (o: PdfObject) => PdfObject,
  out: FormDataField[],
): void {
  const d = resolve(node);
  if (!isDict(d)) return;
  const t = resolve(d.get('T') ?? null);
  const seg = isString(t) ? decodePdfText(t.bytes) : '';
  const full = seg === '' ? path : path === '' ? seg : `${path}.${seg}`;

  if (d.has('V') || d.has('RV')) {
    const entry: FormDataField = {
      name: full,
      type: 'unknown',
      values: valueStrings(resolve(d.get('V') ?? null), resolve),
    };
    const rv = resolve(d.get('RV') ?? null);
    if (isString(rv)) entry.richText = decodePdfText(rv.bytes);
    out.push(entry);
  }

  const kids = resolve(d.get('Kids') ?? null);
  if (isArray(kids)) for (const k of kids) walkFields(k, full, resolve, out);
}

/** Parse an FDF file into the format-neutral model. Objects are scanned
 *  sequentially rather than through an xref, which FDF need not carry. */
export function readFdf(bytes: Uint8Array): FormData {
  if (!latin1(bytes.subarray(0, 5)).startsWith('%FDF-'))
    throw new PdfParseError('FDF: missing %FDF- header');

  const src = latin1(bytes);
  const objects = new Map<number, PdfObject>();
  for (const m of src.matchAll(/(\d+)[\s]+(\d+)[\s]+obj\b/g)) {
    try {
      const { num, value } = new ObjectParser(new Lexer(bytes, m.index ?? 0)).parseIndirectObject();
      objects.set(num, value);
    } catch {
      // A stray "n g obj" inside a string or comment: not an object, skip it.
    }
  }

  const ti = src.lastIndexOf('trailer');
  if (ti < 0) throw new PdfParseError('FDF: no trailer');
  const trailer = new ObjectParser(new Lexer(bytes, ti + 'trailer'.length)).parseObject();
  if (!isDict(trailer)) throw new PdfParseError('FDF: trailer is not a dictionary');

  const resolve = (o: PdfObject): PdfObject => (isRef(o) ? objects.get(o.num) ?? null : o);
  const root = resolve(trailer.get('Root') ?? null);
  if (!isDict(root)) throw new PdfParseError('FDF: no /Root dictionary');
  const fdf = resolve(root.get('FDF') ?? null);
  if (!isDict(fdf)) throw new PdfParseError('FDF: /Root has no /FDF dictionary');

  const data: FormData = { fields: [] };
  const f = resolve(fdf.get('F') ?? null);
  if (isString(f)) data.file = decodePdfText(f.bytes);
  const id = resolve(fdf.get('ID') ?? null);
  if (isArray(id) && id.length >= 2) {
    const a = resolve(id[0]);
    const b = resolve(id[1]);
    if (isString(a) && isString(b)) data.id = [toHex(a.bytes), toHex(b.bytes)];
  }
  const fields = resolve(fdf.get('Fields') ?? null);
  if (isArray(fields)) for (const e of fields) walkFields(e, '', resolve, data.fields);
  return data;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/fdf.test.ts && npm run typecheck`
Expected: all tests PASS, typecheck clean.

One thing to watch: `String.prototype.substr` is deprecated. Use
`parseInt(hex.slice(i * 2, i * 2 + 2), 16)` in `hexString` if the compiler or
linter objects.

- [ ] **Step 5: Commit**

```bash
git add src/fdf.ts test/fdf.test.ts
git commit -m "feat(fdf): FDF read and write"
```

---

### Task 6: Document methods, public exports, and end-to-end round trips

**Files:**
- Modify: `src/document.ts` (imports at top; methods near the existing `get Form()` at ~line 510)
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/formdata-roundtrip.test.ts`

**Interfaces:**
- Consumes: `collectFormData`, `applyFormData`, `ExportFormDataOptions`, `ImportReport`, `readFdf`, `writeFdf`, `readXfdf`, `writeXfdf`.
- Produces: `Document.ExportFdf`, `Document.ExportXfdf`, `Document.ImportFdf`, `Document.ImportXfdf`.

- [ ] **Step 1: Write the failing test**

Create `test/formdata-roundtrip.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

const open = () => Document.Open(buildFormPdf());

/** Fill every settable field, export, then import into a fresh document. */
function roundTrip(kind: 'fdf' | 'xfdf'): Document {
  const src = open();
  const form = src.Form;
  form.Get('name')!.Value = 'Ada';
  form.Get('agree')!.Value = true;
  form.Get('color')!.Value = 'Green';
  form.Get('size')!.Value = 'L';
  form.Get('tags')!.Value = ['a', 'b'];
  form.Get('parent.child')!.Value = 'kid';

  const bytes = kind === 'fdf' ? src.ExportFdf() : src.ExportXfdf();
  const dst = open();
  const report = kind === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
  expect(report.skipped).toEqual([]);
  expect(report.imported).toHaveLength(6);
  return dst;
}

describe.each(['fdf', 'xfdf'] as const)('%s round trip', (kind) => {
  it('preserves every settable field value', () => {
    const form = roundTrip(kind).Form;
    expect(form.Get('name')!.Value).toBe('Ada');
    expect(form.Get('agree')!.Value).toBe(true);
    expect(form.Get('color')!.Value).toBe('Green');
    expect(form.Get('size')!.Value).toBe('L');
    expect(form.Get('tags')!.Value).toEqual(['a', 'b']);
    expect(form.Get('parent.child')!.Value).toBe('kid');
  });

  it('survives a save and reopen', () => {
    const reopened = Document.Open(roundTrip(kind).Save());
    expect(reopened.Form.Get('name')!.Value).toBe('Ada');
    expect(reopened.Form.Get('color')!.Value).toBe('Green');
  });

  it('generates appearances for imported fields', () => {
    const doc = roundTrip(kind);
    expect(doc.resolve(doc.Form.Get('name')!.Dict.get('AP'))).not.toBeNull();
  });

  it('ignores unknown fields gracefully', () => {
    const src = open();
    src.Form.Get('name')!.Value = 'Ada';
    const bytes = kind === 'fdf' ? src.ExportFdf() : src.ExportXfdf();

    const dst = open();
    dst.Form.Get('name')!.Dict.set('T', { kind: 'string', bytes: new TextEncoder().encode('renamed') });
    const report = kind === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([{ name: 'name', reason: 'no such field' }]);
  });

  it('exports only non-empty fields by default and all with includeEmpty', () => {
    const src = open();
    const lean = kind === 'fdf' ? src.ExportFdf() : src.ExportXfdf();
    const full = kind === 'fdf'
      ? src.ExportFdf({ includeEmpty: true })
      : src.ExportXfdf({ includeEmpty: true });
    expect(full.length).toBeGreaterThan(lean.length);
  });

  it('exports a well-formed empty file from a document with no form', () => {
    const doc = open();
    doc.catalog().delete('AcroForm');
    const bytes = kind === 'fdf' ? doc.ExportFdf() : doc.ExportXfdf();
    expect(bytes.length).toBeGreaterThan(0);
    // and it reads back as an empty data set rather than throwing
    const back = open();
    const report = kind === 'fdf' ? back.ImportFdf(bytes) : back.ImportXfdf(bytes);
    expect(report.imported).toEqual([]);
    expect(report.skipped).toEqual([]);
  });

  it('carries the /F reference into the import report', () => {
    const src = open();
    src.Form.Get('name')!.Value = 'Ada';
    const bytes = kind === 'fdf'
      ? src.ExportFdf({ file: 'form.pdf' })
      : src.ExportXfdf({ file: 'form.pdf' });
    const dst = open();
    const report = kind === 'fdf' ? dst.ImportFdf(bytes) : dst.ImportXfdf(bytes);
    expect(report.sourceFile).toBe('form.pdf');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/formdata-roundtrip.test.ts`
Expected: FAIL — `src.ExportFdf is not a function`.

- [ ] **Step 3: Add the methods**

In `src/document.ts`, add to the import block at the top:

```ts
import {
  collectFormData, applyFormData, type ExportFormDataOptions, type ImportReport,
} from './formdata.js';
import { readFdf, writeFdf } from './fdf.js';
import { readXfdf, writeXfdf } from './xfdf.js';
```

Then, immediately after the existing `get Form(): Form { … }` accessor, insert:

```ts
  /** Export the current form-field values as an FDF data file. */
  ExportFdf(opts: ExportFormDataOptions = {}): Uint8Array {
    return writeFdf(collectFormData(this, opts));
  }

  /** Export the current form-field values as an XFDF data file. */
  ExportXfdf(opts: ExportFormDataOptions = {}): Uint8Array {
    return writeXfdf(collectFormData(this, opts));
  }

  /** Import field values from an FDF data file. Fields with no match in this
   *  document, and values the field rejects, are reported rather than thrown.
   *  Appearance streams are regenerated for every field that is set. */
  ImportFdf(bytes: Uint8Array): ImportReport {
    return applyFormData(this, readFdf(bytes));
  }

  /** Import field values from an XFDF data file. See ImportFdf. */
  ImportXfdf(bytes: Uint8Array): ImportReport {
    return applyFormData(this, readXfdf(bytes));
  }
```

In `src/index.ts`, add next to the existing `Form, Field` export line:

```ts
export type { FormData, FormDataField, ExportFormDataOptions, ImportReport } from './formdata.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/formdata-roundtrip.test.ts && npm run typecheck && npm test`
Expected: the new file passes, typecheck clean, and the **full** suite is green — this is the first task that touches `document.ts`, so a regression elsewhere would show up here.

- [ ] **Step 5: Update the README**

In `README.md`, find the AcroForm/forms section and add after the existing field-filling example:

````markdown
### Form data: FDF and XFDF

Export the current field values to a data file, and import them back:

```ts
const doc = Document.OpenFile('form.pdf');
doc.Form.Get('name')!.Value = 'Ada';

const xfdf = doc.ExportXfdf({ file: 'form.pdf' });   // or ExportFdf()

const other = Document.OpenFile('form.pdf');
const report = other.ImportXfdf(xfdf);               // or ImportFdf()
report.imported;  // ['name']
report.skipped;   // [{ name, reason }] — unknown fields and rejected values
```

Export omits fields with no value; pass `{ includeEmpty: true }` for a complete
snapshot. Import sets values through the same path as `Field.Value`, so
appearance streams are regenerated and invalid values are rejected — a rejected
field is reported in `skipped` and left untouched rather than throwing.
````

Add to the Limitations section:

```markdown
- FDF/XFDF carries form-field values only. Annotations are not yet imported or
  exported. Rich text (`/RV`) is transported verbatim but is not rendered into
  the generated appearance, which is built from the plain value.
```

- [ ] **Step 6: Commit**

```bash
git add src/document.ts src/index.ts README.md test/formdata-roundtrip.test.ts
git commit -m "feat(fdf): Document ExportFdf/ExportXfdf/ImportFdf/ImportXfdf"
```

---

### Task 7: Node file-path wrappers

**Files:**
- Modify: `src/node.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/node-formdata.test.ts`

**Interfaces:**
- Consumes: `Document`, `ExportFormDataOptions`, `ImportReport`.
- Produces: `exportFdfFile`, `exportXfdfFile`, `importFdfFile`, `importXfdfFile` — all async, matching the existing helpers in `node.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/node-formdata.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { exportFdfFile, exportXfdfFile, importFdfFile, importXfdfFile } from '../src/node.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

async function fixture(): Promise<{ dir: string; pdf: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'fdf-'));
  const pdf = join(dir, 'form.pdf');
  const doc = Document.Open(buildFormPdf());
  doc.Form.Get('name')!.Value = 'Ada';
  await writeFile(pdf, doc.Save());
  return { dir, pdf };
}

describe('node form-data wrappers', () => {
  it('exports and re-imports XFDF through the filesystem', async () => {
    const { dir, pdf } = await fixture();
    const data = join(dir, 'out.xfdf');
    await exportXfdfFile(pdf, data);
    expect(new TextDecoder().decode(await readFile(data))).toContain('<value>Ada</value>');

    const target = join(dir, 'blank.pdf');
    await writeFile(target, buildFormPdf());
    const report = await importXfdfFile(target, data);
    expect(report.imported).toEqual(['name']);
    expect(Document.Open(new Uint8Array(await readFile(target))).Form.Get('name')!.Value).toBe('Ada');
  });

  it('exports and re-imports FDF through the filesystem', async () => {
    const { dir, pdf } = await fixture();
    const data = join(dir, 'out.fdf');
    await exportFdfFile(pdf, data);
    expect(new TextDecoder('latin1').decode(await readFile(data))).toContain('%FDF-');

    const target = join(dir, 'blank.pdf');
    await writeFile(target, buildFormPdf());
    await importFdfFile(target, data);
    expect(Document.Open(new Uint8Array(await readFile(target))).Form.Get('name')!.Value).toBe('Ada');
  });

  it('writes to outPath when given, leaving the source untouched', async () => {
    const { dir, pdf } = await fixture();
    const data = join(dir, 'out.xfdf');
    await exportXfdfFile(pdf, data);

    const source = join(dir, 'blank.pdf');
    const out = join(dir, 'filled.pdf');
    await writeFile(source, buildFormPdf());
    await importXfdfFile(source, data, out);
    expect(Document.Open(new Uint8Array(await readFile(source))).Form.Get('name')!.Value).toBe('Bob');
    expect(Document.Open(new Uint8Array(await readFile(out))).Form.Get('name')!.Value).toBe('Ada');
  });

  it('passes export options through', async () => {
    const { dir, pdf } = await fixture();
    const lean = join(dir, 'lean.xfdf');
    const full = join(dir, 'full.xfdf');
    await exportXfdfFile(pdf, lean);
    await exportXfdfFile(pdf, full, { includeEmpty: true });
    expect((await readFile(full)).length).toBeGreaterThan((await readFile(lean)).length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/node-formdata.test.ts`
Expected: FAIL — `exportXfdfFile is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/node.ts` (and add `ExportFormDataOptions`, `ImportReport` to the imports):

```ts
import type { ExportFormDataOptions, ImportReport } from './formdata.js';

/** Read a PDF from disk and write its form-field values to `fdfPath` as FDF. */
export async function exportFdfFile(
  pdfPath: string,
  fdfPath: string,
  options?: ExportFormDataOptions,
): Promise<void> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  await writeFile(fdfPath, doc.ExportFdf(options));
}

/** Read a PDF from disk and write its form-field values to `xfdfPath` as XFDF. */
export async function exportXfdfFile(
  pdfPath: string,
  xfdfPath: string,
  options?: ExportFormDataOptions,
): Promise<void> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  await writeFile(xfdfPath, doc.ExportXfdf(options));
}

/** Import FDF field values into a PDF on disk. Writes to `outPath`, which
 *  defaults to `pdfPath` (in-place rewrite). */
export async function importFdfFile(
  pdfPath: string,
  fdfPath: string,
  outPath = pdfPath,
): Promise<ImportReport> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  const report = doc.ImportFdf(new Uint8Array(await readFile(fdfPath)));
  await writeFile(outPath, doc.Save());
  return report;
}

/** Import XFDF field values into a PDF on disk. See importFdfFile. */
export async function importXfdfFile(
  pdfPath: string,
  xfdfPath: string,
  outPath = pdfPath,
): Promise<ImportReport> {
  const doc = Document.Open(new Uint8Array(await readFile(pdfPath)));
  const report = doc.ImportXfdf(new Uint8Array(await readFile(xfdfPath)));
  await writeFile(outPath, doc.Save());
  return report;
}
```

In `src/index.ts`, extend the existing `./node.js` export line to include the
four new names:

```ts
export {
  splitPdfFile, readMetadataFile, updateMetadataFile, clearMetadataFile, savePageImageFile,
  exportFdfFile, exportXfdfFile, importFdfFile, importXfdfFile,
} from './node.js';
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/node-formdata.test.ts && npm run typecheck && npm test`
Expected: all PASS, typecheck clean, full suite green.

- [ ] **Step 5: Update the README**

In the section listing the `node.ts` file helpers, add:

```ts
await exportXfdfFile('form.pdf', 'data.xfdf');
const report = await importXfdfFile('form.pdf', 'data.xfdf', 'filled.pdf');
```

- [ ] **Step 6: Commit**

```bash
git add src/node.ts src/index.ts README.md test/node-formdata.test.ts
git commit -m "feat(fdf): file-path wrappers for form-data import and export"
```

---

### Task 8: Close out

- [ ] **Step 1: Run both gates one final time**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, whole suite green. Do not proceed past a failure —
fix it, or file a bd issue if it is out of scope and pre-existing.

- [ ] **Step 2: Record the two spec deviations**

Edit `docs/superpowers/specs/2026-07-20-fdf-xfdf-form-data-design.md`:
- In the Architecture table, add the `src/xml.ts` row and note that the XML
  reader lives there rather than inside `xfdf.ts`.
- In the "Node convenience wrappers" block, make the four signatures async
  (`Promise<void>` / `Promise<ImportReport>`).

- [ ] **Step 3: Commit and close the issue**

```bash
git add docs/superpowers/specs/2026-07-20-fdf-xfdf-form-data-design.md
git commit -m "docs(fdf): record XML-module and async-wrapper deviations"
bd close aspose-pdf-foss-for-ts-e1p
```

- [ ] **Step 4: Push**

```bash
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

Issue `aspose-pdf-foss-for-ts-73p` (annotation round-trip) is unblocked by this
work and stays open.
