# AcroForm Fields (Enumerate + Fill) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enumerate AcroForm fields (name, type, value) and set values for text, checkbox, radio, and choice fields, writing the live field dicts so edits survive `Save()`.

**Architecture:** New `src/form.ts` module with a `Form` class (walks the `/Catalog /AcroForm /Fields` tree, carrying inheritable `/FT`/`/Ff`/`/V` down) and a `Field` class (a live wrapper over the terminal field dict, like `Page`). `doc.Form` rebuilds the tree per access. Setters write `/V`; button setters flip widget `/AS` to existing appearance states; text/choice setters set `/NeedAppearances true` (we never regenerate appearance streams).

**Tech Stack:** TypeScript ESM, vitest. Reuses `decodePdfText`/`encodePdfText` from `src/metadata.ts` and the `PdfObject` model from `src/types.ts`.

**Spec:** `docs/superpowers/specs/2026-06-11-acroform-fields-design.md`

**Issue:** aspose-pdf-foss-for-ts-jh9 (already claimed / in_progress)

---

## File structure

| File | Responsibility |
|---|---|
| `src/form.ts` (create) | `FieldType`, `Field`, `Form` — tree walk, classification, value get/set |
| `src/document.ts` (modify) | `get Form()` getter |
| `src/index.ts` (modify) | export `Form`, `Field`, `FieldType` |
| `test/helpers/build-form-pdf.ts` (create) | hand-built classic-xref fixture with one of every field kind |
| `test/form.test.ts` (create) | all behavior tests |
| `README.md` (modify) | Form usage section + API table rows |

Run tests with: `npx vitest run test/form.test.ts` (full suite: `npm test`).

---

### Task 1: Form fixture PDF

**Files:**
- Create: `test/helpers/build-form-pdf.ts`
- Create: `test/form.test.ts` (smoke test only)

- [ ] **Step 1: Write the fixture builder**

`test/helpers/build-form-pdf.ts`:

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** One-page classic-xref PDF with an /AcroForm containing one of every field
 *  kind this library fills:
 *    text `name` (V=Bob), checkbox `agree` (Off, AP states Yes/Off),
 *    radio group `color` (V=Red, two kid widgets Red/Green),
 *    choice `size` (Opt S/M/L, V=M, stale /I), multiselect choice `tags`
 *    (Opt with an [export display] pair), hierarchical text `parent.child`
 *    (FT and V inherited from the parent), signature `sig`,
 *    editable combo `font` (combo+edit flags).
 *  Object layout: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 AcroForm,
 *  6 text, 7 checkbox, 8 radio group, 9-10 radio kid widgets, 11 choice,
 *  12 parent field, 13 child field, 14 multiselect choice, 15 signature,
 *  16 dummy appearance stream, 17 editable combo. */
export function buildFormPdf(): Uint8Array {
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 400 400] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R /Annots [6 0 R 7 0 R 9 0 R 10 0 R 11 0 R 13 0 R] >>`;
  objects[4] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[5] = `<< /Fields [6 0 R 7 0 R 8 0 R 11 0 R 12 0 R 14 0 R 15 0 R 17 0 R] >>`;
  objects[6] = `<< /FT /Tx /T (name) /V (Bob) /Type /Annot /Subtype /Widget /Rect [10 10 200 30] >>`;
  objects[7] = `<< /FT /Btn /T (agree) /V /Off /AS /Off /Type /Annot /Subtype /Widget /Rect [10 40 30 60] /AP << /N << /Yes 16 0 R /Off 16 0 R >> >> >>`;
  objects[8] = `<< /FT /Btn /Ff 32768 /T (color) /V /Red /Kids [9 0 R 10 0 R] >>`;
  objects[9] = `<< /Parent 8 0 R /Type /Annot /Subtype /Widget /Rect [10 70 30 90] /AS /Red /AP << /N << /Red 16 0 R /Off 16 0 R >> >> >>`;
  objects[10] = `<< /Parent 8 0 R /Type /Annot /Subtype /Widget /Rect [40 70 60 90] /AS /Off /AP << /N << /Green 16 0 R /Off 16 0 R >> >> >>`;
  objects[11] = `<< /FT /Ch /T (size) /Opt [(S) (M) (L)] /V (M) /I [1] /Type /Annot /Subtype /Widget /Rect [10 100 100 120] >>`;
  objects[12] = `<< /FT /Tx /T (parent) /V (inherited) /Kids [13 0 R] >>`;
  objects[13] = `<< /T (child) /Parent 12 0 R /Type /Annot /Subtype /Widget /Rect [10 130 200 150] >>`;
  objects[14] = `<< /FT /Ch /Ff 2097152 /T (tags) /Opt [[(a) (Alpha)] (b) (c)] >>`;
  objects[15] = `<< /FT /Sig /T (sig) >>`;
  objects[16] = `<< /Length 0 >>\nstream\n\nendstream`;
  objects[17] = `<< /FT /Ch /Ff 393216 /T (font) /Opt [(Arial)] >>`;
  const maxObj = 17;

  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}
```

Flag values used: radio `/Ff 32768` = 1<<15, multiselect `/Ff 2097152` = 1<<21, editable combo `/Ff 393216` = (1<<17)|(1<<18).

- [ ] **Step 2: Write a smoke test that the fixture opens**

`test/form.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isDict } from '../src/types.js';

const open = () => Document.Open(buildFormPdf());

describe('form fixture', () => {
  it('opens with one page and an /AcroForm dict', () => {
    const doc = open();
    expect(doc.Pages.length).toBe(1);
    expect(isDict(doc.resolve(doc.catalog().get('AcroForm')))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the smoke test**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (1 test)

- [ ] **Step 4: Commit**

```bash
git add test/helpers/build-form-pdf.ts test/form.test.ts
git commit -m "test: AcroForm fixture PDF for jh9"
```

---

### Task 2: Field enumeration (Form, Field, classification, doc.Form)

**Files:**
- Create: `src/form.ts`
- Modify: `src/document.ts` (add `get Form()`)
- Modify: `src/index.ts` (exports)
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing enumeration tests**

Append to `test/form.test.ts` (and extend the import from `../src/types.js` with `MaybeObj`, `PdfDict`, `PdfObject`, `isName` — added now so later tasks compile):

```ts
import { isDict, isName, MaybeObj, PdfDict, PdfObject } from '../src/types.js';

describe('Form enumeration', () => {
  it('lists terminal fields in tree order with Name/FullName/Type', () => {
    const form = open().Form;
    expect(form.Fields.map((f) => [f.FullName, f.Type])).toEqual([
      ['name', 'text'],
      ['agree', 'checkbox'],
      ['color', 'radio'],
      ['size', 'choice'],
      ['parent.child', 'text'],
      ['tags', 'choice'],
      ['sig', 'signature'],
      ['font', 'choice'],
    ]);
  });

  it('Get finds a field by FullName; Name is the partial name', () => {
    const form = open().Form;
    const child = form.Get('parent.child');
    expect(child).toBeDefined();
    expect(child!.Name).toBe('child');
    expect(form.Get('nope')).toBeUndefined();
  });

  it('Dict is the live terminal field dict', () => {
    const doc = open();
    const f = doc.Form.Get('name')!;
    expect(isDict(f.Dict)).toBe(true);
    expect(isName(f.Dict.get('FT') as MaybeObj)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — `doc.Form` does not exist / `form.js` not found.

- [ ] **Step 3: Create src/form.ts with enumeration (Value/Options stubbed for later tasks)**

`src/form.ts`:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString } from './types.js';
import { decodePdfText } from './metadata.js';

export type FieldType =
  'text' | 'checkbox' | 'radio' | 'choice' | 'pushbutton' | 'signature' | 'unknown';

// Field-flag bits (/Ff), PDF 32000-1 §12.7.4.
const FF_RADIO = 1 << 15;
const FF_PUSHBUTTON = 1 << 16;
const FF_COMBO = 1 << 17;
const FF_EDIT = 1 << 18;
const FF_MULTISELECT = 1 << 21;

function classify(ft: string | undefined, ff: number): FieldType {
  switch (ft) {
    case 'Tx': return 'text';
    case 'Ch': return 'choice';
    case 'Sig': return 'signature';
    case 'Btn':
      if (ff & FF_PUSHBUTTON) return 'pushbutton';
      if (ff & FF_RADIO) return 'radio';
      return 'checkbox';
    default: return 'unknown';
  }
}

/** A terminal AcroForm field: a live, mutable handle over its field dict. */
export class Field {
  constructor(
    private readonly doc: Document,
    /** The live, resolved /AcroForm dict (target for /NeedAppearances). */
    private readonly acroForm: PdfDict,
    /** The live terminal field dict from the objects map (not a copy). */
    readonly Dict: PdfDict,
    /** Partial name (/T); '' when missing. */
    readonly Name: string,
    /** Non-empty partial names of ancestors and self, joined with '.'. */
    readonly FullName: string,
    readonly Type: FieldType,
    /** Effective /Ff (own or inherited at walk time). */
    private readonly ff: number,
    /** Effective /V seen at walk time (used when the dict has no own /V). */
    private readonly initialV: PdfObject,
  ) {}
}

/** The document's interactive form: terminal fields of the /AcroForm tree. */
export class Form {
  readonly Fields: Field[] = [];

  constructor(doc: Document) {
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
        this.Fields.push(new Field(doc, acro, d, part, full, classify(ftHere, ffHere), ffHere, vHere));
    };
    for (const f of fields) walk(f, '', undefined, 0, null);
  }

  /** The field whose FullName matches exactly, or undefined. */
  Get(fullName: string): Field | undefined {
    return this.Fields.find((f) => f.FullName === fullName);
  }
}
```

(`ff` and `initialV` are unused until Tasks 3-8; that is expected — TypeScript private-unused warnings do not fail the build here, but if `noUnusedLocals` complains, reference them in Task 3 which lands in the same session.)

- [ ] **Step 4: Add the Document.Form getter**

In `src/document.ts`, add to the imports:

```ts
import { Form } from './form.js';
```

and add this getter to the `Document` class (next to `GetMetadata`):

```ts
  /** The interactive form (AcroForm) fields, rebuilt from the live catalog on
   *  each access. A document without /AcroForm yields a Form with no Fields. */
  get Form(): Form {
    return new Form(this);
  }
```

(`form.ts` importing `Document` type-only while `document.ts` imports the `Form` value mirrors the existing `page.ts`/`document.ts` relationship — no runtime cycle.)

- [ ] **Step 5: Export from src/index.ts**

Add after the `Page` export line:

```ts
export { Form, Field } from './form.js';
export type { FieldType } from './form.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (4 tests). Also run `npm run typecheck` — expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/form.ts src/document.ts src/index.ts test/form.test.ts
git commit -m "feat: enumerate AcroForm fields via doc.Form (jh9)"
```

---

### Task 3: Value getter

**Files:**
- Modify: `src/form.ts`
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/form.test.ts`:

```ts
describe('Field.Value getter', () => {
  it('reads text, checkbox, radio, and choice values', () => {
    const form = open().Form;
    expect(form.Get('name')!.Value).toBe('Bob');
    expect(form.Get('agree')!.Value).toBe(false);   // /V /Off
    expect(form.Get('color')!.Value).toBe('Red');
    expect(form.Get('size')!.Value).toBe('M');
  });

  it('resolves /V inherited from a parent field', () => {
    expect(open().Form.Get('parent.child')!.Value).toBe('inherited');
  });

  it('returns "" for absent values', () => {
    const form = open().Form;
    expect(form.Get('tags')!.Value).toBe('');
    expect(form.Get('sig')!.Value).toBe('');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — `Value` is undefined.

- [ ] **Step 3: Implement the getter**

Add to the `Field` class in `src/form.ts`:

```ts
  /** The effective /V: own value when present, else the value inherited at walk time. */
  private rawValue(): PdfObject {
    if (this.Dict.has('V')) return this.doc.resolve(this.Dict.get('V'));
    return this.initialV;
  }

  /** Typed view of /V: text → string (''), checkbox → boolean,
   *  radio → on-state name (''), choice → string or string[] (multi-select). */
  get Value(): string | string[] | boolean {
    const v = this.rawValue();
    switch (this.Type) {
      case 'text':
        return isString(v) ? decodePdfText(v.bytes) : '';
      case 'checkbox':
        return isName(v) && v.name !== 'Off';
      case 'radio':
        return isName(v) ? v.name : '';
      case 'choice':
        if (isArray(v)) {
          const out: string[] = [];
          for (const e of v) {
            const r = this.doc.resolve(e);
            if (isString(r)) out.push(decodePdfText(r.bytes));
          }
          return out;
        }
        return isString(v) ? decodePdfText(v.bytes) : '';
      default:
        if (isString(v)) return decodePdfText(v.bytes);
        if (isName(v)) return v.name;
        return '';
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/form.ts test/form.test.ts
git commit -m "feat: typed Field.Value getter with /V inheritance (jh9)"
```

---

### Task 4: Options getter

**Files:**
- Modify: `src/form.ts`
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/form.test.ts`:

```ts
describe('Field.Options', () => {
  it('returns choice /Opt export values (pairs contribute the export element)', () => {
    const form = open().Form;
    expect(form.Get('size')!.Options).toEqual(['S', 'M', 'L']);
    expect(form.Get('tags')!.Options).toEqual(['a', 'b', 'c']);
  });

  it('returns widget on-states for radio groups and checkboxes', () => {
    const form = open().Form;
    expect(form.Get('color')!.Options).toEqual(['Red', 'Green']);
    expect(form.Get('agree')!.Options).toEqual(['Yes']);
  });

  it('returns [] for other field types', () => {
    expect(open().Form.Get('name')!.Options).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — `Options` is undefined.

- [ ] **Step 3: Implement widgets/on-state helpers and the getter**

Add to the `Field` class in `src/form.ts`:

```ts
  /** The field's widget annotations: a merged field/widget dict is its own
   *  widget; otherwise the resolved dict entries of /Kids. */
  private widgets(): PdfDict[] {
    const kids = this.doc.resolve(this.Dict.get('Kids'));
    if (!isArray(kids)) return [this.Dict];
    const out: PdfDict[] = [];
    for (const k of kids) {
      const d = this.doc.resolve(k);
      if (isDict(d)) out.push(d);
    }
    return out;
  }

  /** True when the widget's /AP /N has an appearance state named `state`. */
  private hasState(widget: PdfDict, state: string): boolean {
    const ap = this.doc.resolve(widget.get('AP'));
    if (!isDict(ap)) return false;
    const n = this.doc.resolve(ap.get('N'));
    return isDict(n) && n.has(state);
  }

  /** First non-Off key of the widget's /AP /N dict, or undefined. */
  private onState(widget: PdfDict): string | undefined {
    const ap = this.doc.resolve(widget.get('AP'));
    if (!isDict(ap)) return undefined;
    const n = this.doc.resolve(ap.get('N'));
    if (!isDict(n)) return undefined;
    for (const k of n.keys()) if (k !== 'Off') return k;
    return undefined;
  }

  /** Selectable values: choice → /Opt export values; checkbox/radio →
   *  widget on-states in widget order; other types → []. */
  get Options(): string[] {
    if (this.Type === 'choice') {
      const opt = this.doc.resolve(this.Dict.get('Opt'));
      if (!isArray(opt)) return [];
      const out: string[] = [];
      for (const e of opt) {
        const r = this.doc.resolve(e);
        const first = isArray(r) ? this.doc.resolve(r[0]) : r;
        if (isString(first)) out.push(decodePdfText(first.bytes));
      }
      return out;
    }
    if (this.Type === 'checkbox' || this.Type === 'radio') {
      const out: string[] = [];
      for (const w of this.widgets()) {
        const s = this.onState(w);
        if (s !== undefined && !out.includes(s)) out.push(s);
      }
      return out;
    }
    return [];
  }
```

(`hasState` is consumed by the radio setter in Task 7; it lands here because it shares the AP/N plumbing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/form.ts test/form.test.ts
git commit -m "feat: Field.Options for choice exports and button on-states (jh9)"
```

---

### Task 5: Text setter + NeedAppearances

**Files:**
- Modify: `src/form.ts`
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/form.test.ts` (also add the shared helpers at the top of the file, after `const open = ...`):

```ts
const reopen = (d: Document) => Document.Open(d.Save());
const acroForm = (d: Document): PdfDict => d.resolve(d.catalog().get('AcroForm')) as PdfDict;
const nameOf = (o: MaybeObj) => (isName(o) ? o.name : undefined);
```

```ts
describe('text setter', () => {
  it('sets /V, sets NeedAppearances, and round-trips through Save', () => {
    const doc = open();
    doc.Form.Get('name')!.Value = 'Алиса';            // non-ASCII → UTF-16BE path
    expect(doc.Form.Get('name')!.Value).toBe('Алиса');
    expect(acroForm(doc).get('NeedAppearances')).toBe(true);
    const re = reopen(doc);
    expect(re.Form.Get('name')!.Value).toBe('Алиса');
    expect(acroForm(re).get('NeedAppearances')).toBe(true);
  });

  it('writes the inherited-V child field without touching the parent /V', () => {
    const doc = open();
    doc.Form.Get('parent.child')!.Value = 'own';
    expect(doc.Form.Get('parent.child')!.Value).toBe('own');
    const re = reopen(doc);
    expect(re.Form.Get('parent.child')!.Value).toBe('own');
  });

  it('rejects non-string values with TypeError, leaving the dict unchanged', () => {
    const doc = open();
    const f = doc.Form.Get('name')!;
    expect(() => { f.Value = true; }).toThrow(TypeError);
    expect(f.Value).toBe('Bob');
    expect(acroForm(doc).get('NeedAppearances')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — assignment to `Value` has no setter (TypeError in strict ESM: "Cannot set property Value"), so the first test errors.

- [ ] **Step 3: Implement the setter dispatch + text branch**

Add to the imports in `src/form.ts`:

```ts
import { decodePdfText, encodePdfText } from './metadata.js';
import { UnsupportedFeatureError } from './errors.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString, name } from './types.js';
```

Add to the `Field` class:

```ts
  /** Set the field value. Validation happens before any mutation, so a throw
   *  leaves the document unmodified. */
  set Value(v: string | string[] | boolean) {
    switch (this.Type) {
      case 'text': this.setText(v); break;
      case 'checkbox': this.setCheckbox(v); break;
      case 'radio': this.setRadio(v); break;
      case 'choice': this.setChoice(v); break;
      default:
        throw new UnsupportedFeatureError(`cannot set the value of a ${this.Type} field`);
    }
  }

  private needAppearances(): void {
    this.acroForm.set('NeedAppearances', true);
  }

  private setText(v: string | string[] | boolean): void {
    if (typeof v !== 'string') throw new TypeError('text field value must be a string');
    this.Dict.set('V', { kind: 'string', bytes: encodePdfText(v) });
    this.needAppearances();
  }

  private setCheckbox(v: string | string[] | boolean): void {
    throw new UnsupportedFeatureError('not implemented yet'); // Task 6
  }

  private setRadio(v: string | string[] | boolean): void {
    throw new UnsupportedFeatureError('not implemented yet'); // Task 7
  }

  private setChoice(v: string | string[] | boolean): void {
    throw new UnsupportedFeatureError('not implemented yet'); // Task 8
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/form.ts test/form.test.ts
git commit -m "feat: text field Value setter with NeedAppearances (jh9)"
```

---

### Task 6: Checkbox setter

**Files:**
- Modify: `src/form.ts`
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/form.test.ts`:

```ts
describe('checkbox setter', () => {
  it('checks via /V + /AS using the AP on-state, and round-trips', () => {
    const doc = open();
    const f = doc.Form.Get('agree')!;
    f.Value = true;
    expect(f.Value).toBe(true);
    expect(nameOf(f.Dict.get('V'))).toBe('Yes');
    expect(nameOf(f.Dict.get('AS'))).toBe('Yes');
    expect(acroForm(doc).get('NeedAppearances')).toBeUndefined(); // buttons reuse appearances
    const re = reopen(doc);
    expect(re.Form.Get('agree')!.Value).toBe(true);
  });

  it('unchecks back to /Off', () => {
    const doc = open();
    const f = doc.Form.Get('agree')!;
    f.Value = true;
    f.Value = false;
    expect(f.Value).toBe(false);
    expect(nameOf(f.Dict.get('V'))).toBe('Off');
    expect(nameOf(f.Dict.get('AS'))).toBe('Off');
  });

  it('rejects non-boolean values with TypeError', () => {
    expect(() => { open().Form.Get('agree')!.Value = 'Yes'; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — checkbox branch throws "not implemented yet".

- [ ] **Step 3: Implement**

Replace the `setCheckbox` stub in `src/form.ts`:

```ts
  private setCheckbox(v: string | string[] | boolean): void {
    if (typeof v !== 'boolean') throw new TypeError('checkbox value must be a boolean');
    const widgets = this.widgets();
    if (!v) {
      this.Dict.set('V', name('Off'));
      for (const w of widgets) w.set('AS', name('Off'));
      return;
    }
    const on = (widgets.length ? this.onState(widgets[0]) : undefined) ?? 'Yes';
    this.Dict.set('V', name(on));
    for (const w of widgets) w.set('AS', name(this.onState(w) ?? on));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add src/form.ts test/form.test.ts
git commit -m "feat: checkbox Value setter flips /V and /AS (jh9)"
```

---

### Task 7: Radio setter

**Files:**
- Modify: `src/form.ts`
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/form.test.ts`:

```ts
const kidDicts = (doc: Document, kids: MaybeObj): PdfDict[] =>
  (doc.resolve(kids) as PdfObject[]).map((k) => doc.resolve(k) as PdfDict);

describe('radio setter', () => {
  it('sets /V on the group and /AS on the matching kid only; round-trips', () => {
    const doc = open();
    const f = doc.Form.Get('color')!;
    f.Value = 'Green';
    expect(f.Value).toBe('Green');
    const [red, green] = kidDicts(doc, f.Dict.get('Kids'));
    expect(nameOf(red.get('AS'))).toBe('Off');
    expect(nameOf(green.get('AS'))).toBe('Green');
    expect(acroForm(doc).get('NeedAppearances')).toBeUndefined();
    expect(reopen(doc).Form.Get('color')!.Value).toBe('Green');
  });

  it('accepts Off to clear the group', () => {
    const doc = open();
    const f = doc.Form.Get('color')!;
    f.Value = 'Off';
    expect(f.Value).toBe('Off');
    const [red, green] = kidDicts(doc, f.Dict.get('Kids'));
    expect(nameOf(red.get('AS'))).toBe('Off');
    expect(nameOf(green.get('AS'))).toBe('Off');
  });

  it('rejects an unknown export value with RangeError, leaving state intact', () => {
    const doc = open();
    const f = doc.Form.Get('color')!;
    expect(() => { f.Value = 'Blue'; }).toThrow(RangeError);
    expect(f.Value).toBe('Red');
  });

  it('rejects non-string values with TypeError', () => {
    expect(() => { open().Form.Get('color')!.Value = true; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — radio branch throws "not implemented yet".

- [ ] **Step 3: Implement**

Replace the `setRadio` stub in `src/form.ts`:

```ts
  private setRadio(v: string | string[] | boolean): void {
    if (typeof v !== 'string') throw new TypeError('radio group value must be a string');
    const widgets = this.widgets();
    if (v !== 'Off' && !widgets.some((w) => this.hasState(w, v)))
      throw new RangeError(`radio group has no option '${v}'`);
    this.Dict.set('V', name(v));
    for (const w of widgets) w.set('AS', name(this.hasState(w, v) ? v : 'Off'));
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add src/form.ts test/form.test.ts
git commit -m "feat: radio group Value setter with export-value validation (jh9)"
```

---

### Task 8: Choice setter

**Files:**
- Modify: `src/form.ts`
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/form.test.ts`:

```ts
describe('choice setter', () => {
  it('sets a valid option, deletes stale /I, sets NeedAppearances, round-trips', () => {
    const doc = open();
    const f = doc.Form.Get('size')!;
    f.Value = 'L';
    expect(f.Value).toBe('L');
    expect(f.Dict.has('I')).toBe(false);
    expect(acroForm(doc).get('NeedAppearances')).toBe(true);
    expect(reopen(doc).Form.Get('size')!.Value).toBe('L');
  });

  it('rejects a value outside /Opt with RangeError', () => {
    const doc = open();
    const f = doc.Form.Get('size')!;
    expect(() => { f.Value = 'XL'; }).toThrow(RangeError);
    expect(f.Value).toBe('M');
  });

  it('rejects an array on a non-multiselect field with TypeError', () => {
    expect(() => { open().Form.Get('size')!.Value = ['S', 'M']; }).toThrow(TypeError);
  });

  it('accepts string[] on a multiselect field and round-trips the array', () => {
    const doc = open();
    doc.Form.Get('tags')!.Value = ['a', 'c'];
    expect(doc.Form.Get('tags')!.Value).toEqual(['a', 'c']);
    expect(reopen(doc).Form.Get('tags')!.Value).toEqual(['a', 'c']);
  });

  it('allows free text on an editable combo (no /Opt validation)', () => {
    const doc = open();
    doc.Form.Get('font')!.Value = 'Times';
    expect(doc.Form.Get('font')!.Value).toBe('Times');
  });

  it('rejects non-string/array values with TypeError', () => {
    expect(() => { open().Form.Get('size')!.Value = true; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/form.test.ts`
Expected: FAIL — choice branch throws "not implemented yet".

- [ ] **Step 3: Implement**

Replace the `setChoice` stub in `src/form.ts`:

```ts
  private setChoice(v: string | string[] | boolean): void {
    let values: string[];
    let isMulti = false;
    if (typeof v === 'string') {
      values = [v];
    } else if (Array.isArray(v) && v.every((e) => typeof e === 'string')) {
      if (!(this.ff & FF_MULTISELECT))
        throw new TypeError('an array value requires a multi-select choice field');
      values = v;
      isMulti = true;
    } else {
      throw new TypeError('choice value must be a string or string[]');
    }
    const editable = (this.ff & FF_COMBO) !== 0 && (this.ff & FF_EDIT) !== 0;
    if (!editable && this.Dict.has('Opt')) {
      const opts = this.Options;
      for (const val of values)
        if (!opts.includes(val)) throw new RangeError(`choice field has no option '${val}'`);
    }
    const strs: PdfObject[] = values.map((s) => ({ kind: 'string', bytes: encodePdfText(s) }));
    this.Dict.set('V', isMulti ? strs : strs[0]);
    this.Dict.delete('I'); // selection indices would now be stale
    this.needAppearances();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (26 tests)

- [ ] **Step 5: Commit**

```bash
git add src/form.ts test/form.test.ts
git commit -m "feat: choice Value setter with /Opt validation and multiselect (jh9)"
```

---

### Task 9: Unsupported types and no-AcroForm edges

**Files:**
- Test: `test/form.test.ts`

- [ ] **Step 1: Write the tests (expected to pass already — verifying edges)**

Append to `test/form.test.ts` (extend the existing imports with `UnsupportedFeatureError` from `../src/errors.js` and `buildClassicPdf` from `./helpers/build-pdf.js`):

```ts
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

describe('edges', () => {
  it('throws UnsupportedFeatureError when setting a signature field', () => {
    expect(() => { open().Form.Get('sig')!.Value = 'x'; }).toThrow(UnsupportedFeatureError);
  });

  it('yields an empty Form for a document without /AcroForm', () => {
    const doc = Document.Open(buildClassicPdf(1));
    expect(doc.Form.Fields).toEqual([]);
    expect(doc.Form.Get('name')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the form suite**

Run: `npx vitest run test/form.test.ts`
Expected: PASS (28 tests). If either fails, fix `src/form.ts` (these are spec requirements, not optional).

- [ ] **Step 3: Run the FULL suite and typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all suites green, typecheck clean.

- [ ] **Step 4: Commit**

```bash
git add test/form.test.ts
git commit -m "test: signature setter and no-AcroForm edges (jh9)"
```

---

### Task 10: README + close out

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Form section to README**

Insert after the "Content streams" section (before "### File-based helpers", README.md line ~85):

````markdown
### Form fields (AcroForm)

```ts
const doc = Document.OpenFile('form.pdf');
for (const f of doc.Form.Fields) console.log(f.FullName, f.Type, f.Value);

doc.Form.Get('user.name')!.Value = 'Oleg';   // text — sets /NeedAppearances
doc.Form.Get('agree')!.Value = true;          // checkbox — flips /V + /AS
doc.Form.Get('color')!.Value = 'Red';         // radio group (validated against widget states)
doc.Form.Get('size')!.Value = 'L';            // choice (validated against /Opt)
doc.WriteTo('filled.pdf');
```

Text and choice edits set `/NeedAppearances true` rather than regenerating
appearance streams; checkbox/radio edits reuse the widgets' existing
appearance states.
````

Add to the API overview table (after the `page.Annotations` row):

```markdown
| `doc.Form` | Interactive form: `Fields: Field[]`, `Get(fullName)` |
| `field.Name` / `field.FullName` / `field.Type` | Field identity (`text`, `checkbox`, `radio`, `choice`, ...) |
| `field.Value` | Typed value; settable for text/checkbox/radio/choice |
| `field.Options` | Choice `/Opt` exports or button on-states |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README covers AcroForm field enumeration and filling"
```

- [ ] **Step 3: Quality gates**

Run: `npm test` and `npm run typecheck`
Expected: all green. Do not proceed otherwise.

- [ ] **Step 4: Close the bead and record knowledge**

```bash
bd close aspose-pdf-foss-for-ts-jh9
bd remember --key acroform-fields-shipped "acroform-fields-shipped: src/form.ts shipped (issue jh9). doc.Form (rebuilt per access) -> Form.Fields: Field[] terminal fields + Form.Get(fullName). Field: Name/FullName/Type/Value/Options/Dict; live dict handles like Page. Setters: text->/V string + NeedAppearances; checkbox->bool flips /V+/AS via AP/N on-state; radio->string validated against kid widget states; choice->string|string[] validated against /Opt unless editable combo, deletes /I, NeedAppearances. pushbutton/signature/unknown setters throw UnsupportedFeatureError. /FT//Ff//V inherited during walk (no /Parent reliance). No appearance generation. Fixture: test/helpers/build-form-pdf.ts."
```

- [ ] **Step 5: Push (MANDATORY per CLAUDE.md)**

```bash
git pull --rebase
git push
git status
```

Expected: "up to date with 'origin/main'".

---

## Self-review notes

- **Spec coverage:** enumeration + walk (Task 2), classification table (Task 2), Value getter incl. inherited V (Task 3), Options incl. /Opt pairs (Task 4), text setter + NeedAppearances (Task 5), checkbox /V+/AS (Task 6), radio validation + /AS flips (Task 7), choice multiselect//Opt/editable-combo//I (Task 8), unsupported setters + empty form (Task 9), README (Task 10). Encrypted docs need no task (decryption happens at open; spec notes this).
- **Type consistency:** `Field` constructor params fixed in Task 2 and used unchanged by Tasks 3-8; setter stubs introduced in Task 5 are replaced verbatim-compatible in Tasks 6-8; `hasState`/`onState`/`widgets` defined once in Task 4 and reused in Tasks 6-7.
- **Test count expectations** assume tasks run in order; if vitest reports different totals, trust per-test results over counts.
