# Checkbox and Radio-Group Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Form.AddCheckbox` / `Page.AddCheckbox` and `Form.AddRadioGroup`,
with `/AP` states keyed by the export name the caller gave rather than by a
heuristic's guess.

**Architecture:** Extract `buildButtonAP` out of `generateFieldAppearance`'s
synth branch so creation and regeneration share the ZapfDingbats drawing without
sharing `synthOnState`'s guesswork. Add a `buildAP` hook to `FieldSpec` so a
field type can supply its own appearance. Checkboxes go through the existing
`createField`; radio groups compose the pieces `dbpr.1` exported for the
non-merged parent/kids shape.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest. No runtime dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-07-27-checkbox-radio-creation-design.md`
Issue: `aspose-pdf-foss-for-ts-dbpr.3` (already claimed)
Builds on: `dbpr.1` (`7352e62`..`8e12a54`), `dbpr.2` (`c50d139`..`9528e02`)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **Strict TypeScript.** `npm run typecheck` (`tsc --noEmit`) must be green.
- **`bd`, not TodoWrite.** Task tracking goes through `bd`; do not create markdown TODO lists.
- **Errors:** `TypeError` for a malformed argument; `RangeError` for a well-formed
  but rejected value. This matches `src/form.ts`, `dbpr.1` and `dbpr.2`.
- **Validation precedes mutation.** A rejected call leaves the document byte-identical.
- **`/NeedAppearances` is never set** by any code in this plan.
- **Every mutating public entry point calls `doc.markModified()`** before returning.
- **Commit after every task.** Run `npm test` (full suite) before each commit.

### Facts you will need

- **`'Off'` is reserved.** It names every button's unselected appearance state,
  so an export value of `'Off'` would collide with its own off state.
- **A radio parent is not an annotation.** It carries `/FT`, `/Ff`, `/T`, `/Kids`
  and `/V`, but no `/Subtype` and no `/Rect`. Its kids carry no `/T`, which is
  what makes the `Form` walk treat the parent as a terminal field whose `/Kids`
  are widgets. The existing `color` field in `test/helpers/build-form-pdf.ts` has
  exactly this shape, and `test/form.test.ts` already asserts it reads back as a
  radio group.
- **`buildAppearanceXObject`'s `std` argument barely matters here.** The *on*
  stream has its whole `/Font` resource replaced by the ZapfDingbats one, so
  `std` is discarded. The *off* stream keeps a `/Helv` entry bound to `std`,
  unused but written to the file. `buildButtonAP` therefore takes `std` as an
  optional parameter: the read path passes `da.std` so output bytes stay
  identical, and creation omits it.
- Appearance streams are uncompressed, so
  `new TextDecoder('latin1').decode(stream.raw)` gives readable content.

---

### Task 1: Extract `buildButtonAP` from the appearance generator

**Files:**
- Modify: `src/appearance.ts` (add the export; rewrite the `case 'checkbox'`/`case 'radio'` arm)
- Test: `test/form-appearance.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function buildButtonAP(doc: Document, widget: PdfDict, onState: string, kind: 'checkbox' | 'radio', std?: StdFont): void`

- [ ] **Step 1: Write the failing test**

Append to `test/form-appearance.test.ts`. The file already imports `Document`,
`isDict`, `isStream`, `PdfDict` and defines `streamText`; add
`import { buildButtonAP } from '../src/appearance.js';` and
`import { buildBlankPage } from './helpers/build-blank-page.js';` and
`import { PdfObject, name } from '../src/types.js';` at the top.

```ts
describe('buildButtonAP', () => {
  const widgetWithRect = (): PdfDict => new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name('Widget')],
    ['Rect', [10, 10, 30, 30]],
  ]);

  const states = (doc: Document, w: PdfDict) =>
    doc.resolve((doc.resolve(w.get('AP')) as PdfDict).get('N')) as PdfDict;

  it('installs exactly the named on-state and Off', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widgetWithRect();
    buildButtonAP(doc, w, 'On', 'checkbox');
    expect([...states(doc, w).keys()].sort()).toEqual(['Off', 'On']);
  });

  it('honours the name it is given rather than defaulting to Yes', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widgetWithRect();
    buildButtonAP(doc, w, 'Approved', 'checkbox');
    const keys = [...states(doc, w).keys()];
    expect(keys).toContain('Approved');
    expect(keys).not.toContain('Yes');
  });

  it('draws a ZapfDingbats mark on the on-state only', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widgetWithRect();
    buildButtonAP(doc, w, 'On', 'checkbox');
    const n = states(doc, w);
    expect(streamText(doc.resolve(n.get('On')))).toContain('/ZaDb');
    expect(streamText(doc.resolve(n.get('Off')))).not.toContain('/ZaDb');
  });

  it('uses a different glyph for radio than for checkbox', () => {
    const doc = Document.Open(buildBlankPage());
    const check = widgetWithRect();
    const radio = widgetWithRect();
    buildButtonAP(doc, check, 'On', 'checkbox');
    buildButtonAP(doc, radio, 'On', 'radio');
    const body = (w: PdfDict) => streamText(doc.resolve(states(doc, w).get('On')));
    expect(body(check)).not.toBe(body(radio));
  });

  it('does nothing when the widget has no usable geometry', () => {
    const doc = Document.Open(buildBlankPage());
    const w: PdfDict = new Map<string, PdfObject>([['Type', name('Annot')]]);
    buildButtonAP(doc, w, 'On', 'checkbox');
    expect(w.has('AP')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-appearance.test.ts -t "buildButtonAP"`
Expected: FAIL — `buildButtonAP is not a function`.

- [ ] **Step 3: Add the export**

In `src/appearance.ts`, add immediately after `synthOnState` (around line 337):

```ts
/** Build and install a button widget's two normal appearances: `onState` and
 *  'Off'. No-op when the widget has no usable geometry.
 *
 *  Separated from generateFieldAppearance so creation can name the on-state
 *  outright — synthOnState exists to *guess* it for documents we did not
 *  author, and that guess defaults to 'Yes'.
 *
 *  `std` reaches only the off stream's unused /Helv font resource (the on
 *  stream's whole /Font is replaced by the ZapfDingbats one), so callers with
 *  no /DA in hand may omit it. */
export function buildButtonAP(
  doc: Document, widget: PdfDict, onState: string,
  kind: 'checkbox' | 'radio', std: StdFont = 'Helvetica',
): void {
  const g = widgetGeom(doc, widget);
  if (!g) return;
  const mk = mkOps(doc, widget, g);
  const glyph = kind === 'radio' ? ZADB_CIRCLE : ZADB_CHECK;
  const onStream = buildAppearanceXObject(doc, g, std, 'Helv', mk.ops + glyphBody(glyph)(g));
  (onStream.dict.get('Resources') as PdfDict).set(
    'Font', (zapfResources(doc) as PdfDict).get('Font')!,
  );
  const offStream = buildAppearanceXObject(doc, g, std, 'Helv', mk.ops);
  installAPState(doc, widget, onState, onStream);
  installAPState(doc, widget, 'Off', offStream);
}
```

- [ ] **Step 4: Rewrite the button arm to call it**

In `generateFieldAppearance`, replace the whole `case 'checkbox': case 'radio':`
block with:

```ts
      case 'checkbox':
      case 'radio': {
        // Preserve author-supplied appearances; synthesize only when missing.
        if (hasNStates(doc, widget)) { body = undefined; break; }
        buildButtonAP(doc, widget, synthOnState(doc, widget, fieldDict, wi, value), type, da.std);
        body = undefined; // already installed per state
        break;
      }
```

The two `case` labels narrow `type` to `'checkbox' | 'radio'`, so it satisfies
the `kind` parameter without a cast.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-appearance.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. This is a pure refactor of the drawing path — the existing
checkbox and radio appearance tests must still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/appearance.ts test/form-appearance.test.ts
git commit -m "refactor(form): extract buildButtonAP from the appearance generator (dbpr.3)"
```

---

### Task 2: Checkbox creation

**Files:**
- Modify: `src/formcreate.ts` (`FieldSpec.buildAP`, `createField`, `CheckboxInit`, `addCheckbox`)
- Modify: `src/form.ts` (`AddCheckbox`)
- Modify: `src/page.ts` (`AddCheckbox` forwarder)
- Modify: `src/index.ts` (export `CheckboxInit`)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `buildButtonAP` (Task 1); `createField`, `FieldInit`, `pdfText`,
  `pageOf` (already in `formcreate.ts`); `CheckboxField` (from `formfield.ts`).
- Produces:
  - `FieldSpec.buildAP?: (doc: Document, dict: PdfDict) => void`
  - `interface CheckboxInit extends FieldInit { exportValue?: string; checked?: boolean }`
  - `function addCheckbox(doc: Document, init: CheckboxInit): CheckboxField`
  - `Form.AddCheckbox(init: CheckboxInit): CheckboxField`
  - `Page.AddCheckbox(init: Omit<CheckboxInit, 'page'>): CheckboxField`

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`. Add `CheckboxField` to the existing
`../src/formfield.js` import.

```ts
describe('AddCheckbox', () => {
  const apStates = (doc: Document, f: { Dict: PdfDict }) =>
    doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as PdfDict;

  it('creates an unchecked checkbox with both appearance states', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({ page: 1, rect: [10, 10, 30, 30], name: 'agree' });
    expect(f).toBeInstanceOf(CheckboxField);
    expect(f.Type).toBe('checkbox');
    expect((doc.resolve(f.Dict.get('FT')) as { name: string }).name).toBe('Btn');
    expect(f.Dict.has('Ff')).toBe(false);          // no radio, no pushbutton bit
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('Off');
    expect((doc.resolve(f.Dict.get('AS')) as { name: string }).name).toBe('Off');
    expect([...apStates(doc, f).keys()].sort()).toEqual(['Off', 'Yes']);
    expect(f.Value).toBe(false);
    expect(f.Options).toEqual(['Yes']);
  });

  it('sets /V and /AS to the export name when checked', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', checked: true,
    });
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('Yes');
    expect((doc.resolve(f.Dict.get('AS')) as { name: string }).name).toBe('Yes');
    expect(f.Value).toBe(true);
  });

  it('keys the /AP by a custom export value even when unchecked', () => {
    // The regression this guards: an unchecked box has /AS /Off and /V /Off and
    // no /Opt, so synthOnState would fall through to its 'Yes' default and build
    // the appearance under the wrong key.
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', exportValue: 'On',
    });
    expect([...apStates(doc, f).keys()].sort()).toEqual(['Off', 'On']);
    expect(f.Options).toEqual(['On']);
  });

  it('attaches the widget to its page exactly once', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({ page: 1, rect: [10, 10, 30, 30], name: 'a' });
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots')) as unknown[];
    expect(annots.length).toBe(1);
    expect(doc.resolve(annots[0] as never)).toBe(f.Dict);
  });

  it('drives the existing Value setter', () => {
    const doc = blank();
    const f = doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'a', exportValue: 'On',
    });
    f.Value = true;
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('On');
    expect((doc.resolve(f.Dict.get('AS')) as { name: string }).name).toBe('On');
    f.Value = false;
    expect((doc.resolve(f.Dict.get('V')) as { name: string }).name).toBe('Off');
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    doc.Form.AddCheckbox({
      page: 1, rect: [10, 10, 30, 30], name: 'agree', exportValue: 'On', checked: true,
    });
    const f = Document.Open(doc.Save()).Form.Get('agree')!;
    expect(f.Type).toBe('checkbox');
    expect(f.Value).toBe(true);
    expect(f.Options).toEqual(['On']);
  });

  it('forwards from the page', () => {
    const doc = blank();
    const f = doc.Pages[0].AddCheckbox({ rect: [10, 10, 30, 30], name: 'a' });
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('rejects a bad export value without mutating the document', () => {
    for (const bad of ['Off', '', 42]) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddCheckbox({
        page: 1, rect: [10, 10, 30, 30], name: 'a', exportValue: bad as never,
      })).toThrow();
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "AddCheckbox"`
Expected: FAIL — `doc.Form.AddCheckbox is not a function`.

- [ ] **Step 3: Add the `buildAP` hook to `FieldSpec` and `createField`**

In `src/formcreate.ts`, extend the interface:

```ts
/** The per-type half of a field: its /FT, any type-specific /Ff bits, extra
 *  dict entries (/V, /MaxLen, /Opt, …), and optionally its own appearance. */
export interface FieldSpec {
  ft: string;
  ff?: number;
  entries?: Array<[string, PdfObject]>;
  /** Build this field's /AP instead of the default value-driven generation.
   *  Buttons use it so the on-state carries the export name the caller chose,
   *  rather than the one generateFieldAppearance would guess. */
  buildAP?: (doc: Document, dict: PdfDict) => void;
}
```

and in `createField`, replace the single `generateFieldAppearance(...)` call
with:

```ts
  const type = classify(spec.ft, ff);
  // A real /AP either way, so /NeedAppearances is never needed. Dispatch
  // explicitly rather than relying on generateFieldAppearance no-op'ing on an
  // /AP we just installed — that coupling would be invisible.
  if (spec.buildAP) spec.buildAP(doc, dict);
  else generateFieldAppearance(doc, acro, dict, type, ff, dict.get('V') ?? null);
  doc.markModified();
```

- [ ] **Step 4: Implement `addCheckbox`**

Append to `src/formcreate.ts`:

```ts
/** Options for Form.AddCheckbox / Page.AddCheckbox. */
export interface CheckboxInit extends FieldInit {
  /** /AP on-state name, which is also the export value. Default 'Yes'. */
  exportValue?: string;
  /** Initial state. Default false. */
  checked?: boolean;
}

/** Create a checkbox (`/FT /Btn`, neither Radio nor Pushbutton) and return its
 *  live handle. The widget carries both appearance states from the start. */
export function addCheckbox(doc: Document, init: CheckboxInit): CheckboxField {
  const on = init.exportValue ?? 'Yes';
  if (typeof on !== 'string' || on === '')
    throw new TypeError('exportValue must be a non-empty string');
  // 'Off' names every button's unselected appearance, so an export value of
  // 'Off' would collide with the field's own off state.
  if (on === 'Off') throw new RangeError("'Off' is reserved for the unselected state");
  const checked = init.checked === true;
  const state = checked ? on : 'Off';

  const c = createField(doc, init, {
    ft: 'Btn',
    entries: [['V', name(state)], ['AS', name(state)]],
    buildAP: (d, dict) => { buildButtonAP(d, dict, on, 'checkbox'); },
  });
  return new CheckboxField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'checkbox', c.ff, c.dict.get('V') ?? null,
  );
}
```

Extend the existing imports in this file:

```ts
import { classify, TextField, CheckboxField, type FieldType } from './formfield.js';
import { generateFieldAppearance, buildButtonAP } from './appearance.js';
```

- [ ] **Step 5: Add the public entry points**

In `src/form.ts`, extend the `formcreate.js` import to
`import { addTextField, addCheckbox, type TextFieldInit, type CheckboxInit } from './formcreate.js';`
and the `formfield.js` type import to include `CheckboxField`. Then add to the
`Form` class after `AddTextField`:

```ts
  /** Create a checkbox on `init.page` and return its handle. The widget carries
   *  both /AP states from the start, keyed by `init.exportValue` (default
   *  'Yes'). Throws without mutating the document on a malformed argument, an
   *  out-of-range page, a duplicate name, or an export value of 'Off'. */
  AddCheckbox(init: CheckboxInit): CheckboxField {
    const field = addCheckbox(this.doc, init);
    this.build();
    return field;
  }
```

In `src/page.ts`, extend the same two imports and add after `AddTextField`:

```ts
  /** Create an AcroForm checkbox whose widget lands on this page.
   *  A thin forwarder to Form.AddCheckbox with `page` bound to this page. */
  AddCheckbox(init: Omit<CheckboxInit, 'page'>): CheckboxField {
    return addCheckbox(this.doc, { ...init, page: this.Number });
  }
```

In `src/index.ts`, extend the `formcreate.js` type export:

```ts
export type { FieldInit, TextFieldInit, CheckboxInit } from './formcreate.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Prove the export name is load-bearing**

Temporarily change `addCheckbox`'s `buildAP` to hardcode the default:

```ts
    buildAP: (d, dict) => { buildButtonAP(d, dict, 'Yes', 'checkbox'); },
```

Run: `npx vitest run test/form-create.test.ts -t "custom export value"`
Expected: FAIL — the `/AP /N` keys come back as `Off`,`Yes` instead of
`Off`,`On`. This is exactly the bug `synthOnState`'s default would have caused.
**Revert** and confirm green.

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test
git add src/formcreate.ts src/form.ts src/page.ts src/index.ts test/form-create.test.ts
git commit -m "feat(form): checkbox creation with an explicit export value (dbpr.3)"
```

---

### Task 3: Radio-group creation

**Files:**
- Modify: `src/formcreate.ts` (`RadioOption`, `RadioGroupInit`, `addRadioGroup`)
- Modify: `src/form.ts` (`AddRadioGroup`)
- Modify: `src/index.ts` (export the two types)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `buildButtonAP` (Task 1); `ensureAcroForm`, `nameParts`,
  `resolvePath`, `buildWidgetDict`, `attachWidget`, `pageOf`, `pdfText`
  (already in `formcreate.ts`); `FF_RADIO`, `FF_READONLY`, `FF_REQUIRED`;
  `RadioField` (from `formfield.ts`).
- Produces:
  - `interface RadioOption { page: number; rect: [number, number, number, number]; export: string }`
  - `interface RadioGroupInit { name: string; options: RadioOption[]; selected?: string; readOnly?: boolean; required?: boolean }`
  - `function addRadioGroup(doc: Document, init: RadioGroupInit): RadioField`
  - `Form.AddRadioGroup(init: RadioGroupInit): RadioField`

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`. Add `RadioField` to the
`../src/formfield.js` import, and `buildBlankPage` is already imported; add a
two-page helper next to `blank()` near the top of the file:

```ts
const twoPages = () => {
  const doc = blank();
  doc.AddPage();            // appends a blank A4 page; see document.ts:1587
  return doc;
};
```

```ts
describe('AddRadioGroup', () => {
  const opts = () => [
    { page: 1, rect: [10, 700, 26, 716] as [number, number, number, number], export: 'red' },
    { page: 1, rect: [10, 680, 26, 696] as [number, number, number, number], export: 'green' },
  ];
  const kidsOf = (doc: Document, f: { Dict: PdfDict }) =>
    (doc.resolve(f.Dict.get('Kids')) as unknown[]).map((k) => doc.resolve(k as never) as PdfDict);
  const nameOf = (o: unknown) => (o as { name: string }).name;

  it('builds a parent field that is not itself a widget', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    expect(f).toBeInstanceOf(RadioField);
    expect(f.Type).toBe('radio');
    expect(nameOf(doc.resolve(f.Dict.get('FT')))).toBe('Btn');
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(32768);   // spec bit 16, Radio
    expect(f.Dict.has('Subtype')).toBe(false);
    expect(f.Dict.has('Rect')).toBe(false);
    expect(kidsOf(doc, f).length).toBe(2);
  });

  it('gives each kid a /Parent back-link and its own two /AP states', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    const kids = kidsOf(doc, f);
    const wanted = ['red', 'green'];
    kids.forEach((k, i) => {
      expect(doc.resolve(k.get('Parent'))).toBe(f.Dict);
      expect(nameOf(doc.resolve(k.get('Subtype')))).toBe('Widget');
      const n = doc.resolve((doc.resolve(k.get('AP')) as PdfDict).get('N')) as PdfDict;
      expect([...n.keys()].sort()).toEqual(['Off', wanted[i]].sort());
    });
    expect(f.Options).toEqual(wanted);
  });

  it('defaults to nothing selected', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    expect(nameOf(doc.resolve(f.Dict.get('V')))).toBe('Off');
    for (const k of kidsOf(doc, f)) expect(nameOf(doc.resolve(k.get('AS')))).toBe('Off');
    expect(f.Value).toBe('');
  });

  it('sets /V and exactly one kid /AS when selected', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts(), selected: 'green' });
    expect(nameOf(doc.resolve(f.Dict.get('V')))).toBe('green');
    const as = kidsOf(doc, f).map((k) => nameOf(doc.resolve(k.get('AS'))));
    expect(as).toEqual(['Off', 'green']);
    expect(f.Value).toBe('green');
  });

  it('drives the existing Value setter', () => {
    const doc = blank();
    const f = doc.Form.AddRadioGroup({ name: 'color', options: opts() });
    f.Value = 'red';
    expect(nameOf(doc.resolve(f.Dict.get('V')))).toBe('red');
    expect(kidsOf(doc, f).map((k) => nameOf(doc.resolve(k.get('AS'))))).toEqual(['red', 'Off']);
    expect(() => { f.Value = 'purple'; }).toThrow(RangeError);
  });

  it('places each widget on its own page and nowhere else', () => {
    const doc = twoPages();
    const f = doc.Form.AddRadioGroup({
      name: 'color',
      options: [
        { page: 1, rect: [10, 700, 26, 716], export: 'red' },
        { page: 2, rect: [10, 700, 26, 716], export: 'blue' },
      ],
    });
    const annots = (i: number) => doc.resolve(doc.Pages[i].Dict.get('Annots')) as unknown[];
    expect(annots(0).length).toBe(1);
    expect(annots(1).length).toBe(1);
    const kids = kidsOf(doc, f);
    expect(doc.resolve(annots(0)[0] as never)).toBe(kids[0]);
    expect(doc.resolve(annots(1)[0] as never)).toBe(kids[1]);
  });

  it('survives a Save/Open round-trip across pages', () => {
    const doc = twoPages();
    doc.Form.AddRadioGroup({
      name: 'color', selected: 'blue',
      options: [
        { page: 1, rect: [10, 700, 26, 716], export: 'red' },
        { page: 2, rect: [10, 700, 26, 716], export: 'blue' },
      ],
    });
    const f = Document.Open(doc.Save()).Form.Get('color')!;
    expect(f.Type).toBe('radio');
    expect(f.Options).toEqual(['red', 'blue']);
    expect(f.Value).toBe('blue');
  });

  it('supports a hierarchical name', () => {
    const doc = blank();
    doc.Form.AddRadioGroup({ name: 'prefs.color', options: opts() });
    const back = Document.Open(doc.Save());
    expect(back.Form.Get('prefs.color')!.Type).toBe('radio');
  });

  it('rejects bad input and leaves the document untouched', () => {
    const cases: Array<[Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      [{ options: [] }, TypeError],
      [{ options: [{ page: 1, rect: [0, 0, 1, 1], export: '' }] }, TypeError],
      [{ options: [{ page: 1, rect: [0, 0, 1, 1], export: 'Off' }] }, RangeError],
      [{ options: [
        { page: 1, rect: [0, 0, 1, 1], export: 'a' },
        { page: 1, rect: [0, 2, 1, 3], export: 'a' },
      ] }, RangeError],
      [{ options: [{ page: 9, rect: [0, 0, 1, 1], export: 'a' }] }, RangeError],
      [{ options: [{ page: 1, rect: [0, 0, 1], export: 'a' }] }, TypeError],
      [{ options: [{ page: 1, rect: [0, 0, 1, 1], export: 'a' }], selected: 'zzz' }, RangeError],
    ];
    for (const [extra, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddRadioGroup({ name: 'color', ...extra } as never))
        .toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });

  it('leaves no orphan parent when a later option is rejected', () => {
    // The atomicity that matters: validating item 3 only after the parent and
    // two kids are wired would strand all three.
    const doc = blank();
    const before = doc.Save().length;
    expect(() => doc.Form.AddRadioGroup({
      name: 'color',
      options: [
        { page: 1, rect: [10, 700, 26, 716], export: 'red' },
        { page: 1, rect: [10, 680, 26, 696], export: 'green' },
        { page: 1, rect: [10, 660, 26, 676], export: 'red' },   // duplicate
      ],
    })).toThrow(RangeError);
    expect(doc.catalog().has('AcroForm')).toBe(false);
    expect(doc.Pages[0].Dict.has('Annots')).toBe(false);
    expect(doc.Save().length).toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "AddRadioGroup"`
Expected: FAIL — `doc.Form.AddRadioGroup is not a function`.

- [ ] **Step 3: Implement `addRadioGroup`**

Append to `src/formcreate.ts`:

```ts
/** One button of a radio group. */
export interface RadioOption {
  /** 1-based page number carrying this widget. */
  page: number;
  rect: [number, number, number, number];
  /** /AP on-state name for this kid, and its export value. */
  export: string;
}

/** Options for Form.AddRadioGroup. Deliberately not a FieldInit: page and rect
 *  are per-option, and a button draws no /DA text. */
export interface RadioGroupInit {
  /** Fully-qualified field name; '.' separates hierarchy levels. */
  name: string;
  /** At least one option. */
  options: RadioOption[];
  /** Initially selected export value. Default: nothing selected. */
  selected?: string;
  readOnly?: boolean;
  required?: boolean;
}

/** Create a radio group: a parent field carrying one kid widget per option,
 *  each on its own page. Returns the parent's live handle.
 *
 *  Every option is validated before the first object is allocated. Rejecting
 *  option 3 after wiring the parent and two kids would strand all three, so the
 *  up-front pass is what makes a failed call leave the document unchanged. */
export function addRadioGroup(doc: Document, init: RadioGroupInit): RadioField {
  nameParts(init.name);
  const options = init.options;
  if (!Array.isArray(options) || options.length === 0)
    throw new TypeError('a radio group needs at least one option');

  const seen = new Set<string>();
  const pages: Page[] = [];
  const rects: Array<[number, number, number, number]> = [];
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    if (typeof o?.export !== 'string' || o.export === '')
      throw new TypeError(`radio option ${i}: export must be a non-empty string`);
    // 'Off' names every button's unselected appearance state.
    if (o.export === 'Off')
      throw new RangeError(`radio option ${i}: 'Off' is reserved for the unselected state`);
    if (seen.has(o.export))
      throw new RangeError(`radio option ${i}: duplicate export '${o.export}'`);
    seen.add(o.export);
    pages.push(pageOf(doc, o.page));
    rects.push(checkNums(`radio option ${i} rect`, o.rect, 4) as [number, number, number, number]);
  }
  if (init.selected !== undefined && !seen.has(init.selected))
    throw new RangeError(`radio group has no option '${init.selected}'`);

  const acro = ensureAcroForm(doc);
  resolvePath(doc, acro, init.name, false);
  const path = resolvePath(doc, acro, init.name, true);

  let ff = FF_RADIO;
  if (init.readOnly) ff |= FF_READONLY;
  if (init.required) ff |= FF_REQUIRED;

  // The parent is a field, not an annotation: no /Subtype and no /Rect. Its
  // kids carry no /T, which is what makes the Form walk treat this node as a
  // terminal radio field whose /Kids are widgets.
  const kids: PdfObject[] = [];
  const parent: PdfDict = new Map<string, PdfObject>([
    ['FT', name('Btn')],
    ['Ff', ff],
    ['T', pdfText(path.partial)],
    ['V', name(init.selected ?? 'Off')],
    ['Kids', kids],
  ]);
  if (path.parent) parent.set('Parent', path.parent);
  const parentRef = doc.allocObject(parent);
  path.container.push(parentRef);

  for (let i = 0; i < options.length; i++) {
    const on = options[i].export;
    const widget = buildWidgetDict(doc, pages[i], rects[i]);
    widget.set('Parent', parentRef);
    widget.set('AS', name(init.selected === on ? on : 'Off'));
    const widgetRef = doc.allocObject(widget);
    kids.push(widgetRef);
    attachWidget(doc, pages[i], widgetRef);
    buildButtonAP(doc, widget, on, 'radio');
  }

  doc.markModified();
  return new RadioField(
    doc, acro, parent, path.partial, init.name, 'radio', ff, parent.get('V') ?? null,
  );
}
```

Extend the imports in this file:

```ts
import { classify, TextField, CheckboxField, RadioField, type FieldType } from './formfield.js';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB, FF_RADIO,
} from './fieldflags.js';
```

- [ ] **Step 4: Add the public entry point**

In `src/form.ts`, extend the `formcreate.js` import with `addRadioGroup` and
`type RadioGroupInit`, the `formfield.js` type import with `RadioField`, and add
to the `Form` class:

```ts
  /** Create a radio group whose kid widgets may sit on different pages, and
   *  return the parent field's handle. There is no Page.AddRadioGroup: a group
   *  is not bound to one page. Throws without mutating the document on an empty
   *  options array, an empty, duplicated or 'Off' export value, a `selected`
   *  matching no option, or an out-of-range page. */
  AddRadioGroup(init: RadioGroupInit): RadioField {
    const field = addRadioGroup(this.doc, init);
    this.build();
    return field;
  }
```

In `src/index.ts`:

```ts
export type {
  FieldInit, TextFieldInit, CheckboxInit, RadioOption, RadioGroupInit,
} from './formcreate.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Prove the up-front validation is load-bearing**

Temporarily delete the whole pre-pass — the `seen`/`pages`/`rects` loop and the
`selected` check — and fold that work into the widget loop, which is exactly
what a fused implementation would look like:

```ts
export function addRadioGroup(doc: Document, init: RadioGroupInit): RadioField {
  nameParts(init.name);
  const options = init.options;
  if (!Array.isArray(options) || options.length === 0)
    throw new TypeError('a radio group needs at least one option');

  const acro = ensureAcroForm(doc);
  resolvePath(doc, acro, init.name, false);
  const path = resolvePath(doc, acro, init.name, true);

  let ff = FF_RADIO;
  if (init.readOnly) ff |= FF_READONLY;
  if (init.required) ff |= FF_REQUIRED;

  const kids: PdfObject[] = [];
  const parent: PdfDict = new Map<string, PdfObject>([
    ['FT', name('Btn')],
    ['Ff', ff],
    ['T', pdfText(path.partial)],
    ['V', name(init.selected ?? 'Off')],
    ['Kids', kids],
  ]);
  if (path.parent) parent.set('Parent', path.parent);
  const parentRef = doc.allocObject(parent);
  path.container.push(parentRef);

  const seen = new Set<string>();                       // MUTATION: validate late
  for (let i = 0; i < options.length; i++) {
    const on = options[i].export;
    if (seen.has(on)) throw new RangeError(`radio option ${i}: duplicate export '${on}'`);
    seen.add(on);
    const page = pageOf(doc, options[i].page);
    const rect = checkNums(`radio option ${i} rect`, options[i].rect, 4) as
      [number, number, number, number];
    const widget = buildWidgetDict(doc, page, rect);
    widget.set('Parent', parentRef);
    widget.set('AS', name(init.selected === on ? on : 'Off'));
    const widgetRef = doc.allocObject(widget);
    kids.push(widgetRef);
    attachWidget(doc, page, widgetRef);
    buildButtonAP(doc, widget, on, 'radio');
  }

  doc.markModified();
  return new RadioField(
    doc, acro, parent, path.partial, init.name, 'radio', ff, parent.get('V') ?? null,
  );
}
```

Run: `npx vitest run test/form-create.test.ts -t "orphan parent"`
Expected: FAIL — `/AcroForm` now exists and the saved length has grown, because
the parent was allocated before the duplicate was noticed. **Revert** and
confirm green.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/formcreate.ts src/form.ts src/index.ts test/form-create.test.ts
git commit -m "feat(form): radio-group creation with per-option pages (dbpr.3)"
```

---

### Task 4: Documentation, gates, and close

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md`**

In the "Form fields (AcroForm)" section, after the paragraph ending "...rather
than silently rendering as something else.", add:

````markdown
Checkboxes and radio groups are created the same way. A radio group's buttons
each carry their own page, so one group may span pages:

```ts
const agree = doc.Form.AddCheckbox({
  page: 1, rect: [72, 700, 88, 716], name: 'agree',
  exportValue: 'On',   // the /AP on-state name and the export value; default 'Yes'
  checked: true,
});

const color = doc.Form.AddRadioGroup({
  name: 'color',
  selected: 'green',
  options: [
    { page: 1, rect: [72, 660, 88, 676], export: 'red' },
    { page: 1, rect: [72, 640, 88, 656], export: 'green' },
    { page: 2, rect: [72, 660, 88, 676], export: 'blue' },
  ],
});
color.Options;   // ['red', 'green', 'blue']
color.Value;     // 'green'
color.Value = 'red';
```

Both get real `/AP` appearance states at creation — a ZapfDingbats check or
filled circle — keyed by the export value you chose. `'Off'` is reserved for
the unselected state and is rejected as an export value. There is no
`page.AddRadioGroup`, since a group is not bound to a single page.
````

- [ ] **Step 2: Update the API-overview table in `README.md`**

After the `TextField` row added by `dbpr.2`, add:

```markdown
| `doc.Form.AddCheckbox(init)` / `page.AddCheckbox(init)` | Create a checkbox → `CheckboxField` |
| `doc.Form.AddRadioGroup(init)` | Create a radio group, one option per page/rect/export → `RadioField` |
```

- [ ] **Step 3: Update `CLAUDE.md`**

Append these invariants to the end of the
`form.ts`/`formfield.ts`/`formcreate.ts`/`fieldflags.ts` bullet:

```markdown
  **Invariant:** `synthOnState` guesses a button's on-state name (`/AS`, then
  `/Opt[i]`, then `/V`, then `'Yes'`) and exists only for documents we did not
  author. Creation must never route through it — it calls `buildButtonAP` with
  the export name outright, via the `buildAP` hook on `FieldSpec`. An unchecked
  checkbox with a custom export value is the case that exposes the difference:
  every input the guess reads is `Off`, so it would key the appearance `Yes`.
  **Invariant:** a radio group validates every option before allocating
  anything. Rejecting option 3 after the parent and two kids are wired strands
  all three — the parent in `/AcroForm /Fields` and the widgets in page
  `/Annots`.
```

- [ ] **Step 4: Run the full gates**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. Per `superpowers:verification-before-completion`, do not
claim completion without this output in hand.

- [ ] **Step 5: Commit, close and push**

```bash
git add README.md CLAUDE.md
git commit -m "docs(form): document checkbox and radio-group creation (dbpr.3)"

bd close aspose-pdf-foss-for-ts-dbpr.3
bd remember --key checkbox-radio-creation-shipped \
  "checkbox-radio-creation-shipped (dbpr.3): appearance.ts exports buildButtonAP(doc,widget,onState,kind,std?) — extracted from generateFieldAppearance's synth branch so creation names the on-state outright; synthOnState's guess (AS, Opt[i], V, then 'Yes') is now read-path only. FieldSpec gains buildAP?(doc,dict) which createField calls INSTEAD of generateFieldAppearance. Public: Form.AddCheckbox/Page.AddCheckbox(CheckboxInit{exportValue?,checked?}) -> CheckboxField, Form.AddRadioGroup(RadioGroupInit{name,options:[{page,rect,export}],selected?}) -> RadioField (no Page.AddRadioGroup — a group may span pages). Radio parent has NO /Subtype and NO /Rect; kids have no /T, which is what makes the Form walk see a terminal radio field with widget kids. 'Off' rejected as an export value. No new members on CheckboxField/RadioField: Field.Value and Field.Options already cover them. Spec: docs/superpowers/specs/2026-07-27-checkbox-radio-creation-design.md"

git add .beads/
git commit -m "chore(bd): close dbpr.3 (checkbox & radio-group creation)"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **Do not let creation call `synthOnState`.** The whole point of Task 1 is that
  the export name is known at creation. If you find yourself seeding `/Opt` or
  `/AP` placeholders so the guess finds the right name, stop — that is the Go
  workaround this design rejects.
- **The radio parent must not get `/Subtype` or `/Rect`.** `buildWidgetDict` is
  for the kids only. A parent with `/Subtype /Widget` would be picked up as an
  annotation and double-counted.
- **Kids must not get `/T`.** A kid with `/T` becomes a child *field*, and the
  group stops being a terminal radio field.
- **`checkNums` returns a fresh array**, so the rects captured during validation
  are safe to reuse when building the widgets.
- **`Field.Value` for a radio group returns `''` when nothing is selected**,
  because `/V` is `/Off` and the getter maps that to the empty string. That is
  existing behaviour; do not change it.
