# AcroForm Field Creation Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the shared machinery to *create* AcroForm fields — `/AcroForm`
bootstrap, `/DR`+`/DA` defaults, hierarchical field-tree wiring, widget
construction — and prove it end to end with `AddTextField`.

**Architecture:** Split `src/form.ts` into three modules: `formfield.ts` (the
`Field` base class, moved verbatim, plus typed subclasses and a `wrapField`
dispatcher), `formcreate.ts` (all creation machinery), and a slimmed `form.ts`
(the `Form` facade). Creation validates every argument and the whole field path
*before* allocating any object, so a throw leaves the document byte-identical.
Appearance streams are generated at creation through the existing
`generateFieldAppearance`, so `/NeedAppearances` is never set.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest. No runtime dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-07-27-form-field-creation-design.md`
Issue: `aspose-pdf-foss-for-ts-dbpr.1` (already claimed)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **Strict TypeScript.** `npm run typecheck` (`tsc --noEmit`) must be green.
- **`bd`, not TodoWrite.** Task tracking goes through `bd`; do not create markdown TODO lists.
- **Errors:** `TypeError` for a malformed argument; `RangeError` for a well-formed
  but rejected value (duplicate name, terminal conflict, page out of range).
  This matches the convention already in `src/form.ts`.
- **`/NeedAppearances` is never set** by any code in this plan.
- **Every mutating public entry point calls `doc.markModified()`** before returning.
- **Commit after every task.** Run `npm test` (full suite) before each commit.

---

### Task 1: Split the field model into `formfield.ts` with typed subclasses

**Files:**
- Create: `src/formfield.ts`
- Modify: `src/form.ts` (remove the moved code, re-export, use `wrapField`)
- Modify: `src/appearance.ts:2` (import `FieldType` from `formfield.js`)
- Modify: `src/index.ts:12-13`
- Test: `test/form.test.ts` (append a new `describe` block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type FieldType = 'text' | 'checkbox' | 'radio' | 'choice' | 'pushbutton' | 'signature' | 'unknown'`
  - `class Field` — constructor `(doc: Document, acroForm: PdfDict, Dict: PdfDict, Name: string, FullName: string, Type: FieldType, ff: number, initialV: PdfObject)`
  - `class TextField extends Field`, `CheckboxField`, `RadioField`, `ChoiceField`, `ButtonField`
  - `function classify(ft: string | undefined, ff: number): FieldType`
  - `function wrapField(doc: Document, acroForm: PdfDict, dict: PdfDict, partial: string, fullName: string, type: FieldType, ff: number, v: PdfObject): Field`

- [ ] **Step 1: Write the failing test**

Append to `test/form.test.ts`:

```ts
import {
  Field, TextField, CheckboxField, RadioField, ChoiceField,
} from '../src/formfield.js';

describe('typed field handles', () => {
  it('returns a subclass per field type from Form.Fields', () => {
    const form = open().Form;
    expect(form.Get('name')).toBeInstanceOf(TextField);
    expect(form.Get('agree')).toBeInstanceOf(CheckboxField);
    expect(form.Get('color')).toBeInstanceOf(RadioField);
    expect(form.Get('size')).toBeInstanceOf(ChoiceField);
    expect(form.Get('parent.child')).toBeInstanceOf(TextField);
  });

  it('returns the base Field for signature fields, which are not creatable', () => {
    const sig = open().Form.Get('sig')!;
    expect(sig).toBeInstanceOf(Field);
    expect(sig).not.toBeInstanceOf(TextField);
    expect(sig.Type).toBe('signature');
  });

  it('keeps every subclass a Field, so existing readers are unaffected', () => {
    for (const f of open().Form.Fields) expect(f).toBeInstanceOf(Field);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form.test.ts -t "typed field handles"`
Expected: FAIL — `Failed to resolve import "../src/formfield.js"`.

- [ ] **Step 3: Create `src/formfield.ts`**

Move the following out of `src/form.ts` **verbatim**, changing only the access
modifiers noted below: the `FieldType` type alias, the five `FF_*` constants,
`classify`, and the whole `Field` class (lines 7–220 of the current file).

Then apply exactly these changes to the moved `Field` class, so the subclasses
that Tasks in `dbpr.3`–`.5` add can reach what they need:

- `private readonly doc` → `protected readonly doc`
- `private readonly acroForm` → `protected readonly acroForm`
- `private readonly ff` → `protected readonly ff`
- `private widgets()` → `protected widgets()`
- `private hasState()` → `protected hasState()`
- `private onState()` → `protected onState()`
- `private rawValue()` → `protected rawValue()`

Leave `Field.Value`'s getter and setter exactly as they are. Do **not** push the
type-switch into the subclasses.

The file header:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString, name } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { UnsupportedFeatureError } from './errors.js';
import { generateFieldAppearance } from './appearance.js';
```

Append the subclasses and the dispatcher at the end of the file:

```ts
// The subclasses narrow `Type` with `declare`, which re-types the inherited
// property without emitting a field initializer that would clobber it. That
// narrowing is what makes them structurally distinct — without it TypeScript
// would treat every empty subclass as interchangeable with `Field`.

/** A text field (`/FT /Tx`). */
export class TextField extends Field { declare readonly Type: 'text'; }

/** A checkbox (`/FT /Btn`, neither Pushbutton nor Radio). */
export class CheckboxField extends Field { declare readonly Type: 'checkbox'; }

/** A radio group (`/FT /Btn` with the Radio flag). */
export class RadioField extends Field { declare readonly Type: 'radio'; }

/** A combo box or list box (`/FT /Ch`). */
export class ChoiceField extends Field { declare readonly Type: 'choice'; }

/** A push button (`/FT /Btn` with the Pushbutton flag). */
export class ButtonField extends Field { declare readonly Type: 'pushbutton'; }

/** Build the handle matching `type`. Signature and unrecognised fields get the
 *  base class: neither is creatable, and `SignatureField` is already the name of
 *  an unrelated export in signature.ts. */
export function wrapField(
  doc: Document, acroForm: PdfDict, dict: PdfDict,
  partial: string, fullName: string, type: FieldType, ff: number, v: PdfObject,
): Field {
  switch (type) {
    case 'text': return new TextField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'checkbox': return new CheckboxField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'radio': return new RadioField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'choice': return new ChoiceField(doc, acroForm, dict, partial, fullName, type, ff, v);
    case 'pushbutton': return new ButtonField(doc, acroForm, dict, partial, fullName, type, ff, v);
    default: return new Field(doc, acroForm, dict, partial, fullName, type, ff, v);
  }
}
```

Also export `classify` (add the `export` keyword to the moved function) — Task 4
needs it.

- [ ] **Step 4: Rewire `src/form.ts`**

Delete the moved code. The new header and re-export:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString } from './types.js';
import { decodePdfText } from './metadata.js';
import { Field, classify, wrapField } from './formfield.js';

// Re-exported so existing import sites (appearance.ts, formdata.ts, index.ts)
// and downstream consumers keep working after the split.
export { Field, wrapField } from './formfield.js';
export type { FieldType } from './formfield.js';
export {
  TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
} from './formfield.js';
```

In the `Form` constructor's `walk`, replace the `Field` construction:

```ts
      if (!hasFieldKids)
        this.Fields.push(wrapField(doc, acro, d, part, full, classify(ftHere, ffHere), ffHere, vHere));
```

`name` and `encodePdfText` and `UnsupportedFeatureError` and
`generateFieldAppearance` are no longer used by `form.ts` — remove those imports.
If `tsc` reports any other now-unused import, remove it.

- [ ] **Step 5: Update the two import sites**

`src/appearance.ts:2`:

```ts
import type { FieldType } from './formfield.js';
```

`src/index.ts:12-13`:

```ts
export { Form } from './form.js';
export {
  Field, TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
} from './formfield.js';
export type { FieldType } from './formfield.js';
```

Leave `src/formdata.ts:2` alone — it imports from `./form.js`, which now
re-exports.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/form.test.ts && npm run typecheck`
Expected: PASS, including the three new cases.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. This is a refactor — any pre-existing test that breaks is a
regression in the move, not a test to update.

- [ ] **Step 8: Commit**

```bash
git add src/formfield.ts src/form.ts src/appearance.ts src/index.ts test/form.test.ts
git commit -m "refactor(form): split the field model into formfield.ts with typed subclasses (dbpr.1)"
```

---

### Task 2: AcroForm bootstrap and `/DR` font registration

**Files:**
- Create: `src/formcreate.ts`
- Test: `test/form-create.test.ts` (new)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `function ensureAcroForm(doc: Document): PdfDict`
  - `function ensureDRFont(doc: Document, acro: PdfDict, std: StdFont): string`
  - `function fieldDA(key: string, size: number, color: [number, number, number]): string`

- [ ] **Step 1: Write the failing test**

Create `test/form-create.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isArray, isDict, isName, PdfDict } from '../src/types.js';
import { ensureAcroForm, ensureDRFont, fieldDA } from '../src/formcreate.js';

const blank = () => Document.Open(buildBlankPage());
const acroOf = (d: Document) => d.resolve(d.catalog().get('AcroForm')) as PdfDict;
const drFonts = (d: Document, acro: PdfDict): PdfDict =>
  d.resolve((d.resolve(acro.get('DR')) as PdfDict).get('Font')) as PdfDict;
const baseFontOf = (d: Document, fonts: PdfDict, key: string): string | undefined => {
  const fd = d.resolve(fonts.get(key)) as PdfDict;
  const bf = d.resolve(fd.get('BaseFont'));
  return isName(bf) ? bf.name : undefined;
};

describe('ensureAcroForm', () => {
  it('creates an indirect /AcroForm with an empty /Fields when absent', () => {
    const doc = blank();
    expect(doc.catalog().has('AcroForm')).toBe(false);
    const acro = ensureAcroForm(doc);
    expect(isDict(acroOf(doc))).toBe(true);
    expect(acroOf(doc)).toBe(acro);
    expect(isArray(doc.resolve(acro.get('Fields')))).toBe(true);
  });

  it('is idempotent and reuses an existing /AcroForm', () => {
    const doc = Document.Open(buildFormPdf());
    const before = acroOf(doc);
    const fieldCount = (doc.resolve(before.get('Fields')) as unknown[]).length;
    expect(ensureAcroForm(doc)).toBe(before);
    expect(ensureAcroForm(doc)).toBe(before);
    expect((doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length).toBe(fieldCount);
  });
});

describe('ensureDRFont', () => {
  it("registers Helvetica under Acrobat's conventional /Helv key", () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv');
    const fonts = drFonts(doc, acro);
    expect(baseFontOf(doc, fonts, 'Helv')).toBe('Helvetica');
    const fd = doc.resolve(fonts.get('Helv')) as PdfDict;
    expect(isName(doc.resolve(fd.get('Encoding')))).toBe(true);
  });

  it('reuses an existing entry for the same face instead of duplicating it', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    ensureDRFont(doc, acro, 'Helvetica');
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv');
    expect([...drFonts(doc, acro).keys()]).toEqual(['Helv']);
  });

  it('uses a per-face key so distinct faces never collide', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv');
    expect(ensureDRFont(doc, acro, 'Helvetica-Bold')).toBe('HeBo');
    expect(ensureDRFont(doc, acro, 'Times-Roman')).toBe('TiRo');
    expect([...drFonts(doc, acro).keys()]).toEqual(['Helv', 'HeBo', 'TiRo']);
  });

  it('suffixes rather than retargeting a conventional key held by another face', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    // A producer bound /Helv to Courier — a real thing viewers emit.
    ensureDRFont(doc, acro, 'Courier');
    const fonts = drFonts(doc, acro);
    fonts.set('Helv', fonts.get('Cour')!);
    fonts.delete('Cour');
    expect(ensureDRFont(doc, acro, 'Helvetica')).toBe('Helv2');
    expect(baseFontOf(doc, fonts, 'Helv')).toBe('Courier');
    expect(baseFontOf(doc, fonts, 'Helv2')).toBe('Helvetica');
  });

  it('omits /Encoding for the symbolic faces, which have no WinAnsi mapping', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const key = ensureDRFont(doc, acro, 'ZapfDingbats');
    expect(key).toBe('ZaDb');
    expect((doc.resolve(drFonts(doc, acro).get('ZaDb')) as PdfDict).has('Encoding')).toBe(false);
  });
});

describe('fieldDA', () => {
  it('writes the font key, size and an RGB fill colour', () => {
    expect(fieldDA('Helv', 0, [0, 0, 0])).toBe('/Helv 0 Tf 0 0 0 rg');
    expect(fieldDA('TiRo', 12, [1, 0, 0.5])).toBe('/TiRo 12 Tf 1 0 0.5 rg');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts`
Expected: FAIL — `Failed to resolve import "../src/formcreate.js"`.

- [ ] **Step 3: Create `src/formcreate.ts` with the bootstrap helpers**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, name } from './types.js';
import { num } from './pagecontent.js';
import type { StdFont } from './metrics.js';

/** Acrobat's conventional /DR /Font resource keys for the Standard-14 faces.
 *  These are the names its /DA strings expect; da.ts already reads them. */
const DR_KEY: Record<StdFont, string> = {
  'Helvetica': 'Helv', 'Helvetica-Bold': 'HeBo',
  'Helvetica-Oblique': 'HeOb', 'Helvetica-BoldOblique': 'HeBO',
  'Courier': 'Cour', 'Courier-Bold': 'CoBo',
  'Courier-Oblique': 'CoOb', 'Courier-BoldOblique': 'CoBO',
  'Times-Roman': 'TiRo', 'Times-Bold': 'TiBo',
  'Times-Italic': 'TiIt', 'Times-BoldItalic': 'TiBI',
  'Symbol': 'Symb', 'ZapfDingbats': 'ZaDb',
};

/** The document's /AcroForm dict, created as an indirect object with an empty
 *  /Fields when absent. Idempotent; also repairs a missing or non-array
 *  /Fields, since everything downstream appends to it. */
export function ensureAcroForm(doc: Document): PdfDict {
  const catalog = doc.catalog();
  const existing = doc.resolve(catalog.get('AcroForm'));
  if (isDict(existing)) {
    if (!isArray(doc.resolve(existing.get('Fields')))) existing.set('Fields', []);
    return existing;
  }
  const acro: PdfDict = new Map<string, PdfObject>([['Fields', []]]);
  catalog.set('AcroForm', doc.allocObject(acro));
  return acro;
}

/** Register `std` in the AcroForm /DR /Font and return its resource key.
 *  Reuses any key already bound to that face, so repeated calls never
 *  duplicate a font. When the conventional key is held by a *different* face,
 *  takes a suffixed key instead of retargeting it — silently repointing /Helv
 *  would change how every existing field in the document renders. */
export function ensureDRFont(doc: Document, acro: PdfDict, std: StdFont): string {
  let dr = doc.resolve(acro.get('DR'));
  if (!isDict(dr)) { dr = new Map<string, PdfObject>(); acro.set('DR', dr); }
  let fonts = doc.resolve((dr as PdfDict).get('Font'));
  if (!isDict(fonts)) { fonts = new Map<string, PdfObject>(); (dr as PdfDict).set('Font', fonts); }
  const table = fonts as PdfDict;

  for (const k of table.keys()) {
    const fd = doc.resolve(table.get(k));
    if (!isDict(fd)) continue;
    const bf = doc.resolve((fd as PdfDict).get('BaseFont'));
    if (isName(bf) && bf.name === std) return k;
  }

  const base = DR_KEY[std];
  let key = base;
  for (let i = 2; table.has(key); i++) key = `${base}${i}`;
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name(std)],
  ]);
  // Symbol and ZapfDingbats carry their own built-in encodings; forcing
  // WinAnsi on them would mis-map every glyph.
  if (std !== 'Symbol' && std !== 'ZapfDingbats')
    fontDict.set('Encoding', name('WinAnsiEncoding'));
  table.set(key, doc.allocObject(fontDict));
  return key;
}

/** A /DA string: font resource key, size (0 = auto-size to the box), and an
 *  RGB fill colour. `rg` rather than `g` even for grey, so there is one form
 *  to write and one to read back. */
export function fieldDA(key: string, size: number, color: [number, number, number]): string {
  const [r, g, b] = color;
  return `/${key} ${num(size)} Tf ${num(r)} ${num(g)} ${num(b)} rg`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS (all 9 cases).

- [ ] **Step 5: Commit**

```bash
git add src/formcreate.ts test/form-create.test.ts
git commit -m "feat(form): AcroForm bootstrap and /DR font registration (dbpr.1)"
```

---

### Task 3: Hierarchical field-path resolution

**Files:**
- Modify: `src/formcreate.ts` (append)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `ensureAcroForm` (Task 2).
- Produces:
  - `interface FieldPath { container: PdfObject[]; parent: PdfRef | undefined; partial: string }`
  - `function nameParts(fullName: string): string[]` (exported — Task 4 validates with it)
  - `function resolvePath(doc: Document, acro: PdfDict, fullName: string, create: boolean): FieldPath`

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts` (extend the existing import from
`../src/formcreate.js` to include `resolvePath` and `nameParts`, and the one
from `../src/types.js` to include `isRef` and `isString`):

```ts
describe('nameParts', () => {
  it('splits on dots', () => {
    expect(nameParts('a')).toEqual(['a']);
    expect(nameParts('address.city')).toEqual(['address', 'city']);
  });

  it('rejects a non-string, an empty name, and any empty part', () => {
    for (const bad of ['', '.', 'a.', '.a', 'a..b'])
      expect(() => nameParts(bad)).toThrow(TypeError);
    expect(() => nameParts(undefined as unknown as string)).toThrow(TypeError);
  });
});

describe('resolvePath', () => {
  it('places a flat name directly in /AcroForm /Fields with no parent', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const p = resolvePath(doc, acro, 'applicant', true);
    expect(p.partial).toBe('applicant');
    expect(p.parent).toBeUndefined();
    expect(p.container).toBe(doc.resolve(acro.get('Fields')));
  });

  it('creates an intermediate node with /T and /Kids and a /Parent back-link', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const p = resolvePath(doc, acro, 'address.city', true);
    expect(p.partial).toBe('city');
    expect(isRef(p.parent!)).toBe(true);

    const fields = doc.resolve(acro.get('Fields')) as unknown[];
    expect(fields.length).toBe(1);
    const node = doc.resolve(fields[0] as never) as PdfDict;
    const t = doc.resolve(node.get('T'));
    expect(isString(t) && new TextDecoder().decode(t.bytes)).toBe('address');
    expect(p.container).toBe(doc.resolve(node.get('Kids')));
  });

  it('reuses an existing intermediate node for a sibling', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const a = resolvePath(doc, acro, 'address.city', true);
    const b = resolvePath(doc, acro, 'address.zip', true);
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(1);
    expect(b.container).toBe(a.container);
    expect(b.parent).toEqual(a.parent);
  });

  it('nests to arbitrary depth', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const p = resolvePath(doc, acro, 'a.b.c.d', true);
    expect(p.partial).toBe('d');
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(1);
  });

  it('rejects a duplicate terminal name', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = acroOf(doc);
    expect(() => resolvePath(doc, acro, 'name', false)).toThrow(RangeError);
    expect(() => resolvePath(doc, acro, 'parent.child', false)).toThrow(RangeError);
  });

  it('descends into a genuine intermediate node from an existing document', () => {
    const doc = Document.Open(buildFormPdf());
    const p = resolvePath(doc, acroOf(doc), 'parent.sibling', false);
    expect(p.partial).toBe('sibling');
  });

  it('rejects routing through an existing terminal field', () => {
    const doc = Document.Open(buildFormPdf());
    // `name` is a terminal text field, so `name.inner` has nowhere to live.
    expect(() => resolvePath(doc, acroOf(doc), 'name.inner', false))
      .toThrow(/'name' is an existing terminal field/);
  });

  it('treats a field whose /Kids are widgets as terminal', () => {
    const doc = Document.Open(buildFormPdf());
    // `color` is a radio group: /Kids holds widgets (no /T), not child fields.
    expect(() => resolvePath(doc, acroOf(doc), 'color.inner', false)).toThrow(RangeError);
  });

  it('mutates nothing on the validation pass', () => {
    const doc = blank();
    const acro = ensureAcroForm(doc);
    const before = doc.Save().length;
    resolvePath(doc, acro, 'a.b.c', false);
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(0);
    expect(doc.Save().length).toBe(before);
  });

  it('leaves no orphan node when a deep path conflicts', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = acroOf(doc);
    const before = (doc.resolve(acro.get('Fields')) as unknown[]).length;
    expect(() => resolvePath(doc, acro, 'fresh.name.inner', false)).not.toThrow();
    expect(() => resolvePath(doc, acro, 'name.inner', false)).toThrow(RangeError);
    expect((doc.resolve(acro.get('Fields')) as unknown[]).length).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "resolvePath"`
Expected: FAIL — `resolvePath is not a function` / import error.

- [ ] **Step 3: Implement path resolution**

Append to `src/formcreate.ts` (and extend its `types.js` import with `PdfRef`,
`isRef`, `isString`, plus `decodePdfText`/`encodePdfText` from `./metadata.js`):

```ts
/** Where a new terminal field attaches: the live array to append its ref to,
 *  the enclosing node's ref (undefined at the root), and the terminal partial
 *  name. Only a `create: true` resolution may be used to mutate. */
export interface FieldPath {
  container: PdfObject[];
  parent: PdfRef | undefined;
  partial: string;
}

/** A PdfString carrying a PDF text string. */
function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

/** Split a fully-qualified field name into its parts. Rejects empty parts,
 *  which would otherwise produce a field whose FullName does not round-trip. */
export function nameParts(fullName: string): string[] {
  if (typeof fullName !== 'string' || fullName === '')
    throw new TypeError('field name must be a non-empty string');
  const parts = fullName.split('.');
  if (parts.some((p) => p === ''))
    throw new TypeError(`field name '${fullName}' has an empty part`);
  return parts;
}

/** True when `node` ends a branch: no /Kids at all, or /Kids holding widgets
 *  (entries without /T) rather than child fields. This is the same rule the
 *  Form walk uses to decide where a field ends. */
function isTerminal(doc: Document, node: PdfDict): boolean {
  const kids = doc.resolve(node.get('Kids'));
  if (!isArray(kids)) return true;
  for (const k of kids) {
    const kd = doc.resolve(k);
    if (isDict(kd) && (kd as PdfDict).has('T')) return false;
  }
  return true;
}

/** The entry in `container` whose field has partial name `partial`, with the
 *  raw entry alongside the resolved dict — the entry is what a child's
 *  /Parent must reference. */
function findChild(
  doc: Document, container: PdfObject[], partial: string,
): { entry: PdfObject; dict: PdfDict } | undefined {
  for (const entry of container) {
    const d = doc.resolve(entry);
    if (!isDict(d)) continue;
    const t = doc.resolve((d as PdfDict).get('T'));
    if (isString(t) && decodePdfText(t.bytes) === partial)
      return { entry, dict: d as PdfDict };
  }
  return undefined;
}

/** Walk (and with `create`, build) the field tree down to `fullName`'s terminal
 *  parent. Call once with `create: false` to validate the whole path without
 *  mutating, then again with `create: true` to apply it — creating intermediate
 *  nodes allocates objects, so a single fused pass would strand them when a
 *  conflict is found deeper down. */
export function resolvePath(
  doc: Document, acro: PdfDict, fullName: string, create: boolean,
): FieldPath {
  const parts = nameParts(fullName);
  const rootFields = doc.resolve(acro.get('Fields'));
  if (!isArray(rootFields)) throw new TypeError('/AcroForm /Fields is not an array');

  let container = rootFields as PdfObject[];
  let parent: PdfRef | undefined;
  const partial = parts[parts.length - 1];

  for (let i = 0; i < parts.length - 1; i++) {
    const found = findChild(doc, container, parts[i]);
    if (found) {
      if (isTerminal(doc, found.dict))
        throw new RangeError(`'${parts.slice(0, i + 1).join('.')}' is an existing terminal field`);
      let kids = doc.resolve(found.dict.get('Kids'));
      if (!isArray(kids)) { kids = []; found.dict.set('Kids', kids); }
      // A direct (non-indirect) node cannot be referenced, so children below it
      // simply carry no /Parent — the walk reads the tree top-down regardless.
      parent = isRef(found.entry) ? found.entry : undefined;
      container = kids as PdfObject[];
      continue;
    }
    // The branch is absent, so nothing below it can conflict. On the validation
    // pass there is nothing left to check.
    if (!create) return { container, parent, partial };

    const node: PdfDict = new Map<string, PdfObject>([['T', pdfText(parts[i])], ['Kids', []]]);
    if (parent) node.set('Parent', parent);
    const nodeRef = doc.allocObject(node);
    container.push(nodeRef);
    parent = nodeRef;
    container = doc.resolve(node.get('Kids')) as PdfObject[];
  }

  if (findChild(doc, container, partial))
    throw new RangeError(`field '${fullName}' already exists`);
  return { container, parent, partial };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the terminal-conflict branch is load-bearing**

Per `CLAUDE.md`, a fixture that passes first try is not evidence. Temporarily
change `isTerminal`'s first line to `return false;`, then run:

Run: `npx vitest run test/form-create.test.ts -t "terminal"`
Expected: FAIL on both "rejects routing through an existing terminal field" and
"treats a field whose /Kids are widgets as terminal". **Revert the change** and
confirm green again.

- [ ] **Step 6: Prove the two-pass validation is load-bearing**

Temporarily delete the early exit in `resolvePath` — the two lines

```ts
    if (!create) return { container, parent, partial };
```

— so the validation pass builds intermediate nodes exactly as the create pass
does (this is precisely what a single fused pass would do). Then run:

Run: `npx vitest run test/form-create.test.ts -t "resolvePath"`
Expected: FAIL on "mutates nothing on the validation pass" — `/Fields` gains the
`a` node and the saved byte length grows. **Restore the line** and confirm green.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/formcreate.ts test/form-create.test.ts
git commit -m "feat(form): hierarchical field-path resolution with two-pass validation (dbpr.1)"
```

---

### Task 4: Widget construction, `createField`, and `addTextField`

**Files:**
- Modify: `src/annotation.ts:693` (export `ownAnnots`)
- Modify: `src/formcreate.ts` (append)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `ensureAcroForm`, `ensureDRFont`, `fieldDA` (Task 2); `nameParts`,
  `resolvePath`, `FieldPath` (Task 3); `classify`, `TextField` (Task 1).
- Produces:
  - `interface FieldInit { page: number; rect: [number, number, number, number]; name: string; font?: StdFont; fontSize?: number; textColor?: [number, number, number]; readOnly?: boolean; required?: boolean }`
  - `interface TextFieldInit extends FieldInit { value?: string }`
  - `interface FieldSpec { ft: string; ff?: number; entries?: Array<[string, PdfObject]> }`
  - `interface CreatedField { acro: PdfDict; dict: PdfDict; type: FieldType; ff: number; partial: string; fullName: string }`
  - `function buildWidgetDict(doc: Document, page: Page, rect: [number, number, number, number]): PdfDict`
  - `function attachWidget(doc: Document, page: Page, widgetRef: PdfRef): void`
  - `function createField(doc: Document, init: FieldInit, spec: FieldSpec): CreatedField`
  - `function addTextField(doc: Document, init: TextFieldInit): TextField`

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts` (extend the `formcreate.js` import with
`addTextField`, and add `import { TextField } from '../src/formfield.js';`):

```ts
const annotsOf = (d: Document) => d.resolve(d.Pages[0].Dict.get('Annots')) as unknown[];

describe('addTextField', () => {
  it('creates a merged field/widget dict wired into a fresh /AcroForm', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [72, 700, 272, 722], name: 'applicant' });
    expect(f).toBeInstanceOf(TextField);
    expect(f.FullName).toBe('applicant');
    expect(f.Value).toBe('');

    const d = f.Dict;
    expect(isName(doc.resolve(d.get('Type')))).toBe(true);
    expect((doc.resolve(d.get('Subtype')) as { name: string }).name).toBe('Widget');
    expect((doc.resolve(d.get('FT')) as { name: string }).name).toBe('Tx');
    expect(doc.resolve(d.get('Rect'))).toEqual([72, 700, 272, 722]);
    expect(doc.resolve(d.get('F'))).toBe(4);
    expect(isRef(d.get('P')!)).toBe(true);
    expect((doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length).toBe(1);
  });

  it('attaches the widget to the page it names, exactly once', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    const annots = annotsOf(doc);
    expect(annots.length).toBe(1);
    expect(doc.resolve(annots[0] as never)).toBe(f.Dict);
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('writes the initial value and generates an /AP matching the rect', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [10, 10, 210, 40], name: 'a', value: 'Jane' });
    expect(f.Value).toBe('Jane');
    const ap = doc.resolve(f.Dict.get('AP')) as PdfDict;
    const n = doc.resolve(ap.get('N')) as { dict: PdfDict };
    expect(doc.resolve(n.dict.get('BBox'))).toEqual([0, 0, 200, 30]);
  });

  it('never sets /NeedAppearances, because the /AP is real', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    expect(acroOf(doc).has('NeedAppearances')).toBe(false);
  });

  it('defaults /DA to Helvetica at auto-size in black, and registers /DR', () => {
    const doc = blank();
    const f = addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/Helv 0 Tf 0 0 0 rg');
    expect(baseFontOf(doc, drFonts(doc, acroOf(doc)), 'Helv')).toBe('Helvetica');
  });

  it('honours font, fontSize and textColor in /DA', () => {
    const doc = blank();
    const f = addTextField(doc, {
      page: 1, rect: [10, 10, 110, 30], name: 'a',
      font: 'Times-Bold', fontSize: 11, textColor: [1, 0, 0],
    });
    const da = doc.resolve(f.Dict.get('DA')) as { bytes: Uint8Array };
    expect(new TextDecoder('latin1').decode(da.bytes)).toBe('/TiBo 11 Tf 1 0 0 rg');
  });

  it('sets the ReadOnly and Required /Ff bits, and omits /Ff when neither is asked for', () => {
    const doc = blank();
    const plain = addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    expect(plain.Dict.has('Ff')).toBe(false);
    const both = addTextField(doc, {
      page: 1, rect: [10, 40, 110, 60], name: 'b', readOnly: true, required: true,
    });
    expect(doc.resolve(both.Dict.get('Ff'))).toBe(3);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [72, 700, 272, 722], name: 'applicant', value: 'Jane' });
    const back = Document.Open(doc.Save());
    const f = back.Form.Get('applicant')!;
    expect(f).toBeInstanceOf(TextField);
    expect(f.Value).toBe('Jane');
    expect(back.Pages[0].Annotations.length).toBe(1);
  });

  it('round-trips a hierarchical name with the right FullName', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'address.city', value: 'Prague' });
    addTextField(doc, { page: 1, rect: [10, 40, 110, 60], name: 'address.zip', value: '11000' });
    const back = Document.Open(doc.Save());
    expect(back.Form.Fields.map((f) => f.FullName).sort())
      .toEqual(['address.city', 'address.zip']);
    expect(back.Form.Get('address.city')!.Value).toBe('Prague');
    expect((back.resolve(acroOf(back).get('Fields')) as unknown[]).length).toBe(1);
  });

  it('rejects bad arguments before touching the document', () => {
    const cases: Array<[unknown, RegExp | typeof TypeError | typeof RangeError]> = [
      [{ page: 0, rect: [0, 0, 1, 1], name: 'a' }, RangeError],
      [{ page: 2, rect: [0, 0, 1, 1], name: 'a' }, RangeError],
      [{ page: 1, rect: [0, 0, 1], name: 'a' }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: '' }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: 'a..b' }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: 'a', fontSize: -1 }, TypeError],
      [{ page: 1, rect: [0, 0, 1, 1], name: 'a', textColor: [2, 0, 0] }, TypeError],
    ];
    for (const [init, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => addTextField(doc, init as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });

  it('rejects a duplicate name and leaves the document unchanged', () => {
    const doc = blank();
    addTextField(doc, { page: 1, rect: [10, 10, 110, 30], name: 'a' });
    const fieldsBefore = (doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length;
    const bytesBefore = doc.Save().length;
    expect(() => addTextField(doc, { page: 1, rect: [10, 40, 110, 60], name: 'a' }))
      .toThrow(/already exists/);
    expect((doc.resolve(acroOf(doc).get('Fields')) as unknown[]).length).toBe(fieldsBefore);
    expect(annotsOf(doc).length).toBe(1);
    expect(doc.Save().length).toBe(bytesBefore);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "addTextField"`
Expected: FAIL — `addTextField is not a function`.

- [ ] **Step 3: Export `ownAnnots` from `src/annotation.ts`**

At `src/annotation.ts:693`, add the `export` keyword and note why:

```ts
/** The page's own live /Annots array, created and attached when absent.
 *  @internal Shared with formcreate.ts, which attaches widget annotations the
 *  same way — a widget must land on the page's *own* array, never an inherited
 *  one. */
export function ownAnnots(doc: Document, page: Page): PdfObject[] {
```

- [ ] **Step 4: Implement creation in `src/formcreate.ts`**

Append (and extend the imports at the top of the file):

```ts
import type { Page } from './page.js';
import { checkNums, ownAnnots } from './annotation.js';
import { generateFieldAppearance } from './appearance.js';
import { classify, TextField, type FieldType } from './formfield.js';
```

```ts
// Field flag bits (/Ff), PDF 32000-1 §12.7.3.1.
const FF_READONLY = 1 << 0;
const FF_REQUIRED = 1 << 1;
// Annotation flag bits (/F), §12.5.3.
const ANNOT_PRINT = 1 << 2;

/** Options common to every field-creation entry point. */
export interface FieldInit {
  /** 1-based page number carrying the widget. */
  page: number;
  /** Widget rectangle [llx, lly, urx, ury] in default user space. */
  rect: [number, number, number, number];
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** Standard-14 face for the field's /DA. Default 'Helvetica'. */
  font?: StdFont;
  /** /DA font size; 0 (the default) auto-sizes to the box. */
  fontSize?: number;
  /** /DA text colour, RGB 0..1. Default black. */
  textColor?: [number, number, number];
  /** /Ff ReadOnly (bit 1). */
  readOnly?: boolean;
  /** /Ff Required (bit 2). */
  required?: boolean;
}

/** Options for Form.AddTextField / Page.AddTextField. */
export interface TextFieldInit extends FieldInit {
  /** Initial /V. Default ''. */
  value?: string;
}

/** The per-type half of a field: its /FT, any type-specific /Ff bits, and extra
 *  dict entries (/V, /MaxLen, /Opt, …). */
export interface FieldSpec {
  ft: string;
  ff?: number;
  entries?: Array<[string, PdfObject]>;
}

/** What createField hands back so callers can build the typed handle. */
export interface CreatedField {
  acro: PdfDict;
  dict: PdfDict;
  type: FieldType;
  ff: number;
  partial: string;
  fullName: string;
}

/** A PdfString carrying a latin1/ASCII byte string (/DA and friends, which are
 *  read back with a latin1 decoder in da.ts — never UTF-16). */
function pdfLatin(s: string): PdfObject {
  return { kind: 'string', bytes: new TextEncoder().encode(s) };
}

/** The 1-based page, or a RangeError naming the valid span. */
function pageOf(doc: Document, n: number): Page {
  if (!Number.isInteger(n) || n < 1 || n > doc.Pages.length)
    throw new RangeError(`page ${String(n)} out of range [1, ${doc.Pages.length}]`);
  return doc.Pages[n - 1];
}

/** The annotation half of a widget: /Type, /Subtype, /Rect, the print flag, and
 *  the /P back-reference. Exported so radio-group creation can build the kid
 *  widgets it needs without duplicating this. */
export function buildWidgetDict(
  doc: Document, page: Page, rect: [number, number, number, number],
): PdfDict {
  return new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name('Widget')],
    ['Rect', checkNums('rect', rect, 4)],
    ['F', ANNOT_PRINT],
    ['P', doc.pageRef(page.Number)],
  ]);
}

/** Attach an allocated widget to the page's own /Annots. */
export function attachWidget(doc: Document, page: Page, widgetRef: PdfRef): void {
  ownAnnots(doc, page).push(widgetRef);
}

/** Create one terminal field as a single merged field/widget dict: validate,
 *  bootstrap the AcroForm, wire the field into the tree at `init.name`, attach
 *  its widget to the page, and generate its appearance.
 *
 *  Ordering is load-bearing. Everything that can throw runs before anything is
 *  allocated, so a rejected call leaves the document byte-identical. */
export function createField(doc: Document, init: FieldInit, spec: FieldSpec): CreatedField {
  // 1. Validate every argument against the document, mutating nothing.
  const page = pageOf(doc, init.page);
  const rect = checkNums('rect', init.rect, 4) as [number, number, number, number];
  const std: StdFont = init.font ?? 'Helvetica';
  const size = init.fontSize ?? 0;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0)
    throw new TypeError('fontSize must be a non-negative number');
  const color = checkNums('textColor', init.textColor ?? [0, 0, 0], 3) as [number, number, number];
  if (color.some((c) => c < 0 || c > 1))
    throw new TypeError('textColor components must be in 0..1');
  nameParts(init.name);

  // 2. Bootstrap. This creates /AcroForm only when it is absent — and when it is
  //    absent there are no fields, so step 3 provably cannot then throw.
  const acro = ensureAcroForm(doc);

  // 3. Validate the field path against the live tree before allocating.
  resolvePath(doc, acro, init.name, false);

  // 4. Mutate.
  const key = ensureDRFont(doc, acro, std);
  if (!acro.has('DA')) acro.set('DA', pdfLatin(fieldDA(key, 0, [0, 0, 0])));
  const path = resolvePath(doc, acro, init.name, true);

  let ff = spec.ff ?? 0;
  if (init.readOnly) ff |= FF_READONLY;
  if (init.required) ff |= FF_REQUIRED;

  const dict = buildWidgetDict(doc, page, rect);
  dict.set('FT', name(spec.ft));
  dict.set('T', pdfText(path.partial));
  if (ff !== 0) dict.set('Ff', ff);
  dict.set('DA', pdfLatin(fieldDA(key, size, color)));
  if (path.parent) dict.set('Parent', path.parent);
  for (const [k, v] of spec.entries ?? []) dict.set(k, v);

  const fieldRef = doc.allocObject(dict);
  path.container.push(fieldRef);
  attachWidget(doc, page, fieldRef);

  const type = classify(spec.ft, ff);
  // A real /AP, so /NeedAppearances is never needed.
  generateFieldAppearance(doc, acro, dict, type, ff, dict.get('V') ?? null);
  doc.markModified();

  return { acro, dict, type, ff, partial: path.partial, fullName: init.name };
}

/** Create a single-line text field (`/FT /Tx`) and return its live handle. */
export function addTextField(doc: Document, init: TextFieldInit): TextField {
  const value = init.value ?? '';
  if (typeof value !== 'string') throw new TypeError('value must be a string');
  const c = createField(doc, init, { ft: 'Tx', entries: [['V', pdfText(value)]] });
  return new TextField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'text', c.ff, c.dict.get('V') ?? null,
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

If the `/AP` `BBox` assertion fails, check `widgetGeom` in `appearance.ts` — it
derives width/height from `/Rect`, so `[10, 10, 210, 40]` must give `[0, 0, 200, 30]`.

- [ ] **Step 6: Prove the validate-before-allocate ordering is load-bearing**

Temporarily move the `nameParts(init.name)` call and the `resolvePath(..., false)`
call to *after* `ensureDRFont`, then run:

Run: `npx vitest run test/form-create.test.ts -t "before touching the document"`
Expected: FAIL — the document now carries an `/AcroForm` with a `/DR` after a
rejected call. **Revert** and confirm green.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/annotation.ts src/formcreate.ts test/form-create.test.ts
git commit -m "feat(form): widget construction and createField/addTextField (dbpr.1)"
```

---

### Task 5: Public entry points — `Form.AddTextField` and `Page.AddTextField`

**Files:**
- Modify: `src/form.ts` (`Fields` becomes a getter; add `AddTextField`)
- Modify: `src/page.ts` (add `AddTextField`)
- Modify: `src/index.ts` (export the init types)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `addTextField`, `TextFieldInit` (Task 4); `wrapField`, `TextField` (Task 1).
- Produces:
  - `Form.Fields` — now a getter returning `Field[]`, refreshed after each `Add*`
  - `Form.AddTextField(init: TextFieldInit): TextField`
  - `Page.AddTextField(init: Omit<TextFieldInit, 'page'>): TextField`

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`:

```ts
describe('Form.AddTextField', () => {
  it('refreshes Fields on the same instance, which would otherwise go stale', () => {
    const doc = blank();
    const form = doc.Form;
    expect(form.Fields.length).toBe(0);
    const f = form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a' });
    expect(form.Fields.length).toBe(1);
    expect(form.Get('a')!.Dict).toBe(f.Dict);
    form.AddTextField({ page: 1, rect: [10, 40, 110, 60], name: 'b' });
    expect(form.Fields.map((x) => x.FullName)).toEqual(['a', 'b']);
  });

  it('adds to a document that already has an /AcroForm', () => {
    const doc = Document.Open(buildFormPdf());
    const form = doc.Form;
    const before = form.Fields.length;
    form.AddTextField({ page: 1, rect: [10, 300, 110, 320], name: 'extra' });
    expect(form.Fields.length).toBe(before + 1);
    expect(Document.Open(doc.Save()).Form.Get('extra')!.Value).toBe('');
  });
});

describe('Page.AddTextField', () => {
  it('produces the same structure as Form.AddTextField with an explicit page', () => {
    const viaPage = blank();
    const a = viaPage.Pages[0].AddTextField({ rect: [10, 10, 110, 30], name: 'a', value: 'x' });
    const viaForm = blank();
    const b = viaForm.Form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a', value: 'x' });
    expect(a.FullName).toBe(b.FullName);
    expect(a.Value).toBe(b.Value);
    expect(doc0Rect(viaPage)).toEqual(doc0Rect(viaForm));
    expect(viaPage.Save().length).toBe(viaForm.Save().length);
  });

  it('binds the widget to the page it was called on', () => {
    const doc = Document.Open(buildFormPdf());
    const f = doc.Pages[0].AddTextField({ rect: [10, 300, 110, 320], name: 'onpage' });
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });
});

function doc0Rect(d: Document): unknown {
  return d.resolve((d.Form.Fields[0]).Dict.get('Rect'));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "AddTextField"`
Expected: FAIL — `form.AddTextField is not a function`.

- [ ] **Step 3: Convert `Form.Fields` to a refreshable getter**

In `src/form.ts`, replace the `Form` class's field declaration and constructor:

```ts
export class Form {
  private fields: Field[] = [];
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
    this.build();
  }

  /** The terminal fields of the /AcroForm tree, in tree order. Rebuilt in place
   *  after each Add*, so a held Form instance stays canonical. */
  get Fields(): Field[] {
    return this.fields;
  }

  /** (Re)walk the /AcroForm tree into `this.fields`. */
  private build(): void {
    this.fields = [];
    const doc = this.doc;
    const acro = doc.resolve(doc.catalog().get('AcroForm'));
    if (!isDict(acro)) return;
    const fields = doc.resolve(acro.get('Fields'));
    if (!isArray(fields)) return;

    const seen = new Set<PdfDict>();
    const walk = (node: PdfObject, path: string, ft: string | undefined, ff: number, v: PdfObject): void => {
      const d = doc.resolve(node);
      if (!isDict(d) || seen.has(d)) return;
      seen.add(d);
      const t = doc.resolve(d.get('T'));
      const part = isString(t) ? decodePdfText(t.bytes) : '';
      const full = part === '' ? path : path === '' ? part : `${path}.${part}`;
      const ftRaw = doc.resolve(d.get('FT'));
      const ftHere = isName(ftRaw) ? ftRaw.name : ft;
      const ffRaw = doc.resolve(d.get('Ff'));
      const ffHere = typeof ffRaw === 'number' ? ffRaw : ff;
      const vHere = d.has('V') ? doc.resolve(d.get('V')) : v;

      // Kids with /T are child fields; kids without /T are widgets of this field.
      let hasFieldKids = false;
      const kids = doc.resolve(d.get('Kids'));
      if (isArray(kids)) {
        for (const k of kids) {
          const kd = doc.resolve(k);
          if (isDict(kd) && kd.has('T')) {
            hasFieldKids = true;
            walk(k, full, ftHere, ffHere, vHere);
          }
        }
      }
      if (!hasFieldKids)
        this.fields.push(wrapField(doc, acro, d, part, full, classify(ftHere, ffHere), ffHere, vHere));
    };
    for (const f of fields) walk(f, '', undefined, 0, null);
  }
```

This is the existing constructor body verbatim, with three changes: it now lives
in `build()`, `this.fields = []` resets the array first, and the push target is
`this.fields` rather than `this.Fields`.

- [ ] **Step 4: Add `Form.AddTextField`**

Add to `src/form.ts`'s imports:

```ts
import { addTextField, type TextFieldInit } from './formcreate.js';
import type { TextField } from './formfield.js';
```

and to the `Form` class, after `Get`:

```ts
  /** Create a single-line text field on `init.page` and return its handle.
   *  Creates /AcroForm, its /DR font resource and any intermediate field nodes
   *  named by a dotted `init.name` as needed. Throws without mutating the
   *  document on a malformed argument, an out-of-range page, a duplicate name,
   *  or a name routed through an existing terminal field. */
  AddTextField(init: TextFieldInit): TextField {
    const field = addTextField(this.doc, init);
    this.build();
    return field;
  }
```

- [ ] **Step 5: Add `Page.AddTextField`**

In `src/page.ts`, add the import:

```ts
import { addTextField, type TextFieldInit } from './formcreate.js';
import type { TextField } from './formfield.js';
```

and the method, next to the other `Add*` methods (after `AddLink`, around
`src/page.ts:263`):

```ts
  /** Create a single-line AcroForm text field whose widget lands on this page.
   *  A thin forwarder to Form.AddTextField with `page` bound to this page. */
  AddTextField(init: Omit<TextFieldInit, 'page'>): TextField {
    return addTextField(this.doc, { ...init, page: this.Number });
  }
```

- [ ] **Step 6: Export the init types**

In `src/index.ts`, next to the form exports added in Task 1:

```ts
export type { FieldInit, TextFieldInit } from './formcreate.js';
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/form-create.test.ts test/form.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test
git add src/form.ts src/page.ts src/index.ts test/form-create.test.ts
git commit -m "feat(form): Form.AddTextField and Page.AddTextField (dbpr.1)"
```

---

### Task 6: Documentation, follow-ups, and close

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md` (the `form.ts` line of the architecture overview)

- [ ] **Step 1: Update `README.md`**

Find the AcroForm/Form section of the API overview (search for `doc.Form`). It
currently describes reading fields and setting values. Add the creation entry
points alongside, matching the surrounding style:

```markdown
Create fields (the widget lands on the named page; a dotted name creates the
intermediate field nodes):

```ts
const field = doc.Form.AddTextField({
  page: 1,
  rect: [72, 700, 272, 722],
  name: 'address.city',
  value: 'Prague',
  font: 'Helvetica',     // Standard-14 face for /DA; default Helvetica
  fontSize: 0,           // 0 auto-sizes to the box
  textColor: [0, 0, 0],
  required: true,
});
// or, equivalently, from the page:
doc.Pages[0].AddTextField({ rect: [72, 660, 272, 682], name: 'address.zip' });
```

Appearance streams are generated at creation, so the result renders without
relying on a viewer honouring `/NeedAppearances`.
```

Also add the field-creation entry to the Features list if one is present.

- [ ] **Step 2: Update the `CLAUDE.md` architecture overview**

Replace the `form.ts` mention in the feature-modules bullet with a description
covering the split:

```markdown
- **form.ts**, **formfield.ts**, **formcreate.ts** — AcroForm: `form.ts` is the
  `Form` facade (tree walk, `Get`, `GenerateAppearances`, the `Add*` entry
  points); `formfield.ts` holds the `Field` base class and its typed subclasses
  (`TextField`, `CheckboxField`, `RadioField`, `ChoiceField`, `ButtonField`)
  behind a `wrapField` dispatcher; `formcreate.ts` owns field *creation* —
  `/AcroForm` bootstrap, `/DR`+`/DA` defaults, hierarchical field-tree wiring
  and widget construction.
  **Invariant:** creation validates every argument *and* the whole field path
  before allocating any object, so a rejected call leaves the document
  byte-identical. Creating intermediate nodes allocates, so the path is walked
  twice — a single fused pass strands orphan nodes when a conflict is found
  deeper down.
```

- [ ] **Step 3: File the follow-up issues the spec calls out**

```bash
bd create "Form.RemoveField: delete a field and its widgets" \
  -t feature -p 3 \
  -d "Go has Form.RemoveField (form.go:725); no dbpr issue covers removal. Must unwire the field from /AcroForm /Fields or its parent /Kids, drop its widgets from every page /Annots, and prune now-empty intermediate nodes. Deferred from dbpr.1 (see docs/superpowers/specs/2026-07-27-form-field-creation-design.md)."

bd create "Fold document.ts attachSigWidget onto the shared AcroForm bootstrap" \
  -t chore -p 3 \
  -d "document.ts:1328 attachSigWidget duplicates the ensure-/AcroForm + append-field + attach-widget logic that now lives in formcreate.ts ensureAcroForm. It threads an incremental-update 'touched' object-number set the generic helper does not model, so folding it in needs that seam designed first. Deferred from dbpr.1."
```

- [ ] **Step 4: Run the full gates**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. Per `superpowers:verification-before-completion`, do not
claim completion without this output in hand.

- [ ] **Step 5: Commit and close**

```bash
git add README.md CLAUDE.md
git commit -m "docs(form): document field creation and the form.ts split (dbpr.1)"
bd close aspose-pdf-foss-for-ts-dbpr.1
bd remember --key form-field-creation-shipped \
  "form-field-creation-shipped (dbpr.1): src/form.ts split into form.ts (Form facade) + formfield.ts (Field base + TextField/CheckboxField/RadioField/ChoiceField/ButtonField + wrapField; no SignatureField, that name is taken by signature.ts) + formcreate.ts (ensureAcroForm, ensureDRFont per-face /DR keys with suffix-on-collision, fieldDA, nameParts, resolvePath two-pass, buildWidgetDict, attachWidget, createField, addTextField). Public: Form.AddTextField(TextFieldInit) and Page.AddTextField(Omit<...,'page'>) -> TextField. Dotted names create intermediate field nodes. /NeedAppearances never set; /AP generated at creation. Form.Fields is now a getter rebuilt after each Add*. Spec: docs/superpowers/specs/2026-07-27-form-field-creation-design.md"
```

- [ ] **Step 6: Push (mandatory per CLAUDE.md)**

```bash
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **`declare readonly Type: 'text'`** in Task 1 is not a typo. `declare` re-types
  an inherited property without emitting a field initializer — a plain
  `readonly Type = 'text'` would emit an assignment that clobbers the value the
  base constructor already set. `tsconfig.json` targets ES2022, so class fields
  use `[[Define]]` semantics and the distinction matters.
- **The `/AP` always uses the resource key `Helv` internally**, whatever the `/DA`
  key is. `appearance.ts` builds the appearance stream's own `/Resources` with
  key `Helv` bound to the face `resolveDA` produced, so a `/DA` of
  `/TiBo 11 Tf` still renders correctly. Do not "fix" this.
- **`Field.Value` is not moved into the subclasses.** Overriding an accessor pair
  with a narrowed setter type on each subclass is unsound under `strict` and buys
  nothing here. The subclasses are extension points for `dbpr.2`–`.5`.
- **Do not touch `document.ts:1328` `attachSigWidget`.** It is deliberately out of
  scope; Task 6 files the issue.
