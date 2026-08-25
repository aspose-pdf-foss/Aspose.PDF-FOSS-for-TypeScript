# Combo Box and List Box Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Form.AddComboBox` / `Form.AddListBox` (plus `Page` forwarders)
with `/Opt` option lists, export values distinct from displayed text, and the
Edit and MultiSelect flags — and fix the two rendering defects that authoring a
paired `/Opt` exposes.

**Architecture:** Replace `appearance.ts`'s display-only `optionLabels` with one
parse returning `{ export, display }` pairs, so the list box can match a
selection by export and the combo can draw the display text. Creation then goes
through the existing `createField` (both types are single-widget merged
field/widget dicts) and writes `/Opt`, `/V` and `/I`.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest. No runtime dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-07-27-choice-field-creation-design.md`
Issue: `aspose-pdf-foss-for-ts-dbpr.4` (already claimed)
Builds on: `dbpr.1`, `dbpr.2`, `dbpr.3` (through commit `2d979e2`)

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **Strict TypeScript.** `npm run typecheck` (`tsc --noEmit`) must be green.
- **`bd`, not TodoWrite.** Task tracking goes through `bd`; do not create markdown TODO lists.
- **Errors:** `TypeError` for a malformed argument; `RangeError` for a well-formed
  but rejected value.
- **Validation precedes mutation.** A rejected call leaves the document byte-identical.
- **`/NeedAppearances` is never set** by any code in this plan.
- **Every mutating public entry point calls `doc.markModified()`** before returning.
- **Commit after every task.** Run `npm test` (full suite) before each commit.

### Facts you will need

- **`/Opt` has two entry forms.** A plain string means export and display are
  the same. A two-element array is `[export, display]`. `Field.Options` reads
  `r[0]` (the export); the appearance code reads `r[1] ?? r[0]` (the display).
- **`/V` holds the *export* value**, which is why the display-only parse breaks
  both renderers when the two differ.
- **`Field.setChoice` deletes `/I` on every write**, so the index fallback is
  the normal path after any value change, not an edge case.
- **`/V` may be an array** on a multi-select list box. `textOf` handles only a
  single string, returning `''` for an array — a latent second bug the rewrite
  fixes.
- The fixture `test/helpers/build-form-pdf.ts` has `size` (obj 11) — a list box
  with `/Rect [10 100 100 120]`, `/Opt [(S) (M) (L)]`, `/V (M)`, `/I [1]` — and
  `tags` (obj 14) with a paired `/Opt [[(a) (Alpha)] (b) (c)]` but **no
  `/Rect`**, so `widgetGeom` skips it and it cannot carry an appearance. Tests
  that need a paired `/Opt` *and* geometry mutate `size`'s dict in place, the
  pattern `dbpr.2`'s password tests already use.
- Appearance streams are uncompressed, so
  `new TextDecoder('latin1').decode(stream.raw)` gives readable content.

---

### Task 1: Parse `/Opt` into export/display pairs and fix both renderers

**Files:**
- Modify: `src/appearance.ts` (replace `optionLabels`, rewrite `selectedIndices`,
  add `valueStrings`, change `listBox`'s signature, rewrite the `case 'choice'` arm)
- Test: `test/form-appearance.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour: a paired `/Opt` renders its display text
  in a combo, and highlights the row matching `/V`'s export in a list box.

- [ ] **Step 1: Write the failing test**

Append to `test/form-appearance.test.ts`. The file already imports `Document`,
`buildFormPdf`, `isDict`, `isStream`, `name`, `PdfDict`, `PdfObject`, and
defines `streamText` and `apText`.

```ts
describe('choice fields with distinct export and display values', () => {
  /** Give the fixture's `size` list box a paired /Opt. It is the only choice
   *  field in the fixture with a /Rect, so it is the only one that can carry
   *  an appearance at all. */
  const paired = (doc: Document, opts: { combo?: boolean; value?: PdfObject } = {}) => {
    const d = doc.Form.Get('size')!.Dict;
    d.set('Opt', [
      [{ kind: 'string', bytes: new TextEncoder().encode('us') },
       { kind: 'string', bytes: new TextEncoder().encode('United States') }],
      [{ kind: 'string', bytes: new TextEncoder().encode('gb') },
       { kind: 'string', bytes: new TextEncoder().encode('United Kingdom') }],
    ] as PdfObject);
    d.delete('I');                       // force the fallback path
    d.set('V', opts.value ?? { kind: 'string', bytes: new TextEncoder().encode('gb') });
    if (opts.combo) d.set('Ff', 131072); // spec bit 18, Combo
    return d;
  };

  it('draws the display text in a combo box, not the export value', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, { combo: true });
    doc.Form.GenerateAppearances();
    const content = apText(doc, d);
    expect(content).toContain('United Kingdom');
    expect(content).not.toContain('(gb)');
  });

  it('renders an editable combo box’s free text as typed', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, {
      combo: true,
      value: { kind: 'string', bytes: new TextEncoder().encode('Freeform') },
    });
    d.set('Ff', 131072 | 262144);        // Combo + Edit
    doc.Form.GenerateAppearances();
    expect(apText(doc, d)).toContain('Freeform');
  });

  it('highlights the list-box row whose export matches /V', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc);
    doc.Form.GenerateAppearances();
    const content = apText(doc, d);
    // listBox paints one grey rectangle per selected row before the text.
    expect(content.split('0.6 0.6 0.6 rg').length - 1).toBe(1);
    expect(content).toContain('United Kingdom');
  });

  it('still matches by display text, for producers that store it in /V', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, {
      value: { kind: 'string', bytes: new TextEncoder().encode('United States') },
    });
    doc.Form.GenerateAppearances();
    expect(apText(doc, d).split('0.6 0.6 0.6 rg').length - 1).toBe(1);
  });

  it('highlights every selected row of a multi-select list box', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc, {
      value: [
        { kind: 'string', bytes: new TextEncoder().encode('us') },
        { kind: 'string', bytes: new TextEncoder().encode('gb') },
      ] as PdfObject,
    });
    d.set('Ff', 2097152);                // spec bit 22, MultiSelect
    doc.Form.GenerateAppearances();
    expect(apText(doc, d).split('0.6 0.6 0.6 rg').length - 1).toBe(2);
  });

  it('still honours /I when present', () => {
    const doc = Document.Open(buildFormPdf());
    const d = paired(doc);
    d.set('I', [0]);                     // contradicts /V (gb) on purpose
    doc.Form.GenerateAppearances();
    expect(apText(doc, d).split('0.6 0.6 0.6 rg').length - 1).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-appearance.test.ts -t "distinct export and display"`

Expected: exactly three of the six fail.

| Test | Pre-fix | Why |
|---|---|---|
| draws the display text in a combo box | **FAIL** | renders `/V` verbatim, so the stream contains `(gb)` |
| highlights the list-box row whose export matches | **FAIL** | `labels.indexOf('gb')` is `-1` against display labels |
| highlights every selected row of a multi-select | **FAIL** | `textOf` returns `''` for an array `/V` |
| renders an editable combo's free text as typed | pass | free text is already drawn verbatim |
| still matches by display text | pass | that is the only match the old code does |
| still honours `/I` when present | pass | `/I` short-circuits before any matching |

The three that pass are controls: they prove the other three are about the new
matching rather than about the fixture being broken, and they guard against a
fix that trades one behaviour for another.

- [ ] **Step 3: Replace `optionLabels` with a pair parse**

In `src/appearance.ts`, replace the whole `optionLabels` function (currently at
line 366) with:

```ts
/** One parsed /Opt entry: the export value stored in /V, and the text shown to
 *  the user. A plain-string entry uses the same text for both. */
interface ChoiceEntry { export: string; display: string }

/** Parse /Opt. An entry is either a string (both roles) or an
 *  [export, display] array. Keeping both halves is what lets the renderers
 *  match on the export — which is what /V holds — while drawing the display. */
function choiceEntries(doc: Document, fieldDict: PdfDict): ChoiceEntry[] {
  const opt = doc.resolve(fieldDict.get('Opt'));
  if (!isArray(opt)) return [];
  const out: ChoiceEntry[] = [];
  for (const e of opt) {
    const r = doc.resolve(e);
    if (isArray(r)) {
      const ex = doc.resolve(r[0]);
      if (!isString(ex)) continue;
      const exs = decodePdfText(ex.bytes);
      const disp = doc.resolve(r[1] ?? r[0]);
      out.push({ export: exs, display: isString(disp) ? decodePdfText(disp.bytes) : exs });
    } else if (isString(r)) {
      const s = decodePdfText(r.bytes);
      out.push({ export: s, display: s });
    }
  }
  return out;
}

/** /V as a list of strings: one entry for a single value, one per element for a
 *  multi-select list box's array. */
function valueStrings(doc: Document, value: PdfObject): string[] {
  if (isArray(value)) {
    const out: string[] = [];
    for (const e of value) {
      const r = doc.resolve(e);
      if (isString(r)) out.push(decodePdfText(r.bytes));
    }
    return out;
  }
  const s = textOf(value);
  return s ? [s] : [];
}
```

- [ ] **Step 4: Rewrite `selectedIndices`**

Replace the whole `selectedIndices` function with:

```ts
/** Zero-based /Opt indices to highlight: /I when present, else the entries
 *  matching the value. Export first, then display — /V holds the export, and
 *  Field.setChoice deletes /I on every write, so this fallback is the normal
 *  path rather than an edge case. */
function selectedIndices(
  doc: Document, fieldDict: PdfDict, entries: ChoiceEntry[], value: PdfObject,
): Set<number> {
  const sel = new Set<number>();
  const iArr = doc.resolve(fieldDict.get('I'));
  if (isArray(iArr)) {
    for (const e of iArr) { const v = doc.resolve(e); if (typeof v === 'number') sel.add(v); }
    if (sel.size > 0) return sel;
  }
  for (const want of valueStrings(doc, value)) {
    let idx = entries.findIndex((e) => e.export === want);
    if (idx < 0) idx = entries.findIndex((e) => e.display === want);
    if (idx >= 0) sel.add(idx);
  }
  return sel;
}
```

- [ ] **Step 5: Take the entries as a parameter in `listBox`**

Change `listBox`'s signature and its first two lines. Replace:

```ts
function listBox(
  doc: Document, fieldDict: PdfDict, da: ResolvedDA, g: WidgetGeom, inset: number, value: PdfObject,
): string {
  const labels = optionLabels(doc, fieldDict);
```

with:

```ts
function listBox(
  doc: Document, fieldDict: PdfDict, da: ResolvedDA, g: WidgetGeom, inset: number,
  value: PdfObject, entries: ChoiceEntry[],
): string {
  const labels = entries.map((e) => e.display);
```

and change the `selectedIndices` call inside it from
`selectedIndices(doc, fieldDict, labels, value)` to
`selectedIndices(doc, fieldDict, entries, value)`. The rest of the body, which
draws `labels`, is unchanged.

- [ ] **Step 6: Rewrite the choice arm of `generateFieldAppearance`**

Replace:

```ts
      case 'choice':
        body = (ff & FF_COMBO)
          ? singleLineText(textOf(value), da, g, q, mk.inset)
          : listBox(doc, fieldDict, da, g, mk.inset, value);
        break;
```

with:

```ts
      case 'choice': {
        const entries = choiceEntries(doc, fieldDict);
        if (ff & FF_COMBO) {
          // Draw the display text for the selected export. A value matching no
          // option is an editable combo's free text and renders as typed.
          const raw = textOf(value);
          const hit = entries.find((e) => e.export === raw);
          body = singleLineText(hit ? hit.display : raw, da, g, q, mk.inset);
        } else {
          body = listBox(doc, fieldDict, da, g, mk.inset, value, entries);
        }
        break;
      }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run test/form-appearance.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Prove both fixes are load-bearing**

First, revert the list-box matching to display-only: in `selectedIndices`,
delete the export line so only the display line remains:

```ts
    const idx = entries.findIndex((e) => e.display === want);
    if (idx >= 0) sel.add(idx);
```

Run: `npx vitest run test/form-appearance.test.ts -t "export matches"`
Expected: FAIL — no highlight. **Revert.**

Then make the combo draw the raw value again: in the choice arm, replace
`body = singleLineText(hit ? hit.display : raw, …)` with
`body = singleLineText(raw, …)`.

Run: `npx vitest run test/form-appearance.test.ts -t "display text in a combo"`
Expected: FAIL — the appearance contains `(gb)`. **Revert** and confirm green.

- [ ] **Step 9: Run the full suite and commit**

```bash
npm test
git add src/appearance.ts test/form-appearance.test.ts
git commit -m "fix(form): match choice selections by export value and draw display text (dbpr.4)"
```

---

### Task 2: Combo box and list box creation

**Files:**
- Modify: `src/formcreate.ts` (append the types and adders)
- Modify: `src/form.ts` (`AddComboBox`, `AddListBox`)
- Modify: `src/page.ts` (both forwarders)
- Modify: `src/index.ts` (export the new types)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `createField`, `FieldInit`, `pdfText` (in `formcreate.ts`);
  `FF_COMBO`, `FF_EDIT`, `FF_MULTISELECT` (from `fieldflags.ts`); `ChoiceField`
  (from `formfield.ts`).
- Produces:
  - `type ChoiceOption = string | { export: string; display?: string }`
  - `interface ChoiceInit extends FieldInit { options: ChoiceOption[]; value?: string | string[] }`
  - `interface ComboBoxInit extends ChoiceInit { editable?: boolean }`
  - `interface ListBoxInit extends ChoiceInit { multiSelect?: boolean }`
  - `function addComboBox(doc: Document, init: ComboBoxInit): ChoiceField`
  - `function addListBox(doc: Document, init: ListBoxInit): ChoiceField`
  - `Form.AddComboBox`, `Form.AddListBox`, `Page.AddComboBox`, `Page.AddListBox`

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`. Add `ChoiceField` to the existing
`../src/formfield.js` import, and `FF_COMBO`, `FF_EDIT`, `FF_MULTISELECT` to the
`../src/fieldflags.js` import.

```ts
describe('AddComboBox / AddListBox', () => {
  const optOf = (doc: Document, f: { Dict: PdfDict }) =>
    doc.resolve(f.Dict.get('Opt')) as unknown[];
  const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);

  it('writes a plain /Opt string when export and display are the same', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'size', options: ['S', 'M', 'L'],
    });
    expect(f).toBeInstanceOf(ChoiceField);
    expect(f.Type).toBe('choice');
    expect(optOf(doc, f).map((e) => str(doc.resolve(e as never)))).toEqual(['S', 'M', 'L']);
    expect(f.Options).toEqual(['S', 'M', 'L']);
  });

  it('writes an [export, display] pair when they differ', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'country',
      options: [
        { export: 'us', display: 'United States' },
        { export: 'gb', display: 'United Kingdom' },
        { export: 'plain' },
      ],
    });
    const opt = optOf(doc, f);
    const first = doc.resolve(opt[0] as never) as unknown[];
    expect(Array.isArray(first)).toBe(true);
    expect(first.map((e) => str(doc.resolve(e as never)))).toEqual(['us', 'United States']);
    // { export } with no display collapses to the plain string form.
    expect(Array.isArray(doc.resolve(opt[2] as never))).toBe(false);
    expect(f.Options).toEqual(['us', 'gb', 'plain']);
  });

  it('sets the combo and edit flags', () => {
    const doc = blank();
    const plain = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    expect(doc.resolve(plain.Dict.get('Ff'))).toBe(131072);            // Combo
    const editable = doc.Form.AddComboBox({
      page: 1, rect: [10, 40, 210, 60], name: 'b', options: ['x'], editable: true,
    });
    expect(doc.resolve(editable.Dict.get('Ff'))).toBe(131072 | 262144); // + Edit
  });

  it('sets no flag for a plain list box and MultiSelect when asked', () => {
    const doc = blank();
    const plain = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    expect(plain.Dict.has('Ff')).toBe(false);
    const multi = doc.Form.AddListBox({
      page: 1, rect: [10, 100, 210, 180], name: 'b', options: ['x'], multiSelect: true,
    });
    expect(doc.resolve(multi.Dict.get('Ff'))).toBe(2097152);           // MultiSelect
  });

  it('writes /V and an ascending /I for a single selection', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x', 'y', 'z'], value: 'y',
    });
    expect(str(doc.resolve(f.Dict.get('V')))).toBe('y');
    expect(doc.resolve(f.Dict.get('I'))).toEqual([1]);
    expect(f.Value).toBe('y');
  });

  it('writes an array /V and a sorted /I for a multi-selection', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a',
      options: ['x', 'y', 'z'], multiSelect: true, value: ['z', 'x'],
    });
    expect((doc.resolve(f.Dict.get('V')) as unknown[]).map((e) => str(doc.resolve(e as never))))
      .toEqual(['z', 'x']);
    expect(doc.resolve(f.Dict.get('I'))).toEqual([0, 2]);   // ascending, per spec
    expect(f.Value).toEqual(['z', 'x']);
  });

  it('omits /V and /I when nothing is selected', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    expect(f.Dict.has('V')).toBe(false);
    expect(f.Dict.has('I')).toBe(false);
  });

  it('accepts free text on an editable combo and omits /I for it', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a',
      options: ['x'], editable: true, value: 'typed',
    });
    expect(str(doc.resolve(f.Dict.get('V')))).toBe('typed');
    expect(f.Dict.has('I')).toBe(false);
  });

  it('allows an empty option list on an editable combo', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: [], editable: true,
    });
    expect(f.Options).toEqual([]);
  });

  it('forwards from the page', () => {
    const doc = blank();
    const a = doc.Pages[0].AddComboBox({ rect: [10, 10, 210, 30], name: 'a', options: ['x'] });
    const b = doc.Pages[0].AddListBox({ rect: [10, 40, 210, 120], name: 'b', options: ['x'] });
    expect(doc.resolve(a.Dict.get('P'))).toBe(doc.Pages[0].Dict);
    expect(doc.resolve(b.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('survives a Save/Open round-trip with both /Opt halves intact', () => {
    const doc = blank();
    doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'country',
      options: [{ export: 'us', display: 'United States' }, { export: 'gb', display: 'United Kingdom' }],
      value: 'gb',
    });
    const back = Document.Open(doc.Save());
    const f = back.Form.Get('country')!;
    expect(f.Options).toEqual(['us', 'gb']);
    expect(f.Value).toBe('gb');
    const first = back.resolve((back.resolve(f.Dict.get('Opt')) as unknown[])[0] as never) as unknown[];
    expect(first.map((e) => str(back.resolve(e as never)))).toEqual(['us', 'United States']);
  });

  it('drives the existing Value setter', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a',
      options: ['x', 'y'], multiSelect: true, value: 'x',
    });
    f.Value = ['x', 'y'];
    expect(f.Value).toEqual(['x', 'y']);
    expect(f.Dict.has('I')).toBe(false);   // setChoice drops the stale indices
    expect(() => { f.Value = 'zzz'; }).toThrow(RangeError);
  });

  it('rejects bad input without mutating the document', () => {
    type Adder = 'AddComboBox' | 'AddListBox';
    const cases: Array<[Adder, Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      ['AddComboBox', { options: 'nope' }, TypeError],
      ['AddComboBox', { options: [42] }, TypeError],
      ['AddComboBox', { options: [{ display: 'no export' }] }, TypeError],
      ['AddComboBox', { options: [''] }, TypeError],
      ['AddComboBox', { options: [{ export: 'a', display: 7 }] }, TypeError],
      ['AddComboBox', { options: ['a', 'a'] }, RangeError],
      ['AddComboBox', { options: ['a'], value: 'zzz' }, RangeError],
      ['AddComboBox', { options: ['a'], value: ['a'] }, TypeError],
      ['AddComboBox', { options: ['a'], multiSelect: true }, RangeError],
      ['AddListBox', { options: ['a'], editable: true }, RangeError],
      ['AddListBox', { options: ['a'], value: ['a'] }, TypeError],
    ];
    for (const [adder, extra, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form[adder]({
        page: 1, rect: [10, 10, 210, 30], name: 'a', ...extra,
      } as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "AddComboBox"`
Expected: FAIL — `doc.Form.AddComboBox is not a function`.

- [ ] **Step 3: Implement the option normaliser and the two adders**

Append to `src/formcreate.ts`:

```ts
/** One option of a choice field. A bare string is an option whose export value
 *  and displayed text are the same. */
export type ChoiceOption = string | { export: string; display?: string };

/** Options common to both choice field types. */
export interface ChoiceInit extends FieldInit {
  /** The option list. May be empty — an editable combo with no predefined
   *  options is a legitimate free-text dropdown. */
  options: ChoiceOption[];
  /** Initially selected export value(s). An array requires multiSelect. */
  value?: string | string[];
}

/** Options for Form.AddComboBox / Page.AddComboBox. */
export interface ComboBoxInit extends ChoiceInit {
  /** /Ff Edit (spec bit 19): the user may type a value not in the list. */
  editable?: boolean;
}

/** Options for Form.AddListBox / Page.AddListBox. */
export interface ListBoxInit extends ChoiceInit {
  /** /Ff MultiSelect (spec bit 22): more than one option may be selected. */
  multiSelect?: boolean;
}

interface NormalizedOption { export: string; display?: string }

/** Validate and normalise the option list. Rejects everything before any
 *  object is allocated. */
function normalizeOptions(options: ChoiceOption[]): NormalizedOption[] {
  if (!Array.isArray(options)) throw new TypeError('options must be an array');
  const seen = new Set<string>();
  const out: NormalizedOption[] = [];
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    let ex: string;
    let disp: string | undefined;
    if (typeof o === 'string') {
      ex = o;
    } else if (o !== null && typeof o === 'object' && typeof o.export === 'string') {
      ex = o.export;
      if (o.display !== undefined && typeof o.display !== 'string')
        throw new TypeError(`option ${i}: display must be a string`);
      disp = o.display;
    } else {
      throw new TypeError(`option ${i}: must be a string or { export, display? }`);
    }
    if (ex === '') throw new TypeError(`option ${i}: export must be a non-empty string`);
    if (seen.has(ex)) throw new RangeError(`option ${i}: duplicate export '${ex}'`);
    seen.add(ex);
    out.push({ export: ex, display: disp });
  }
  return out;
}

/** The /Opt array: a plain string when the display matches the export, else an
 *  [export, display] pair. */
function optArray(options: NormalizedOption[]): PdfObject[] {
  return options.map((o) => (
    o.display === undefined || o.display === o.export
      ? pdfText(o.export)
      : [pdfText(o.export), pdfText(o.display)] as PdfObject
  ));
}

/** Shared body of AddComboBox and AddListBox. `editable` exempts the value from
 *  the /Opt membership check, matching Field.setChoice. */
function addChoice(
  doc: Document, init: ChoiceInit, ff: number, editable: boolean,
): ChoiceField {
  const options = normalizeOptions(init.options);
  const multi = (ff & FF_MULTISELECT) !== 0;

  const raw = init.value;
  let values: string[];
  if (raw === undefined) values = [];
  else if (typeof raw === 'string') values = [raw];
  else if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) {
    if (!multi) throw new TypeError('an array value requires a multi-select list box');
    values = raw;
  } else {
    throw new TypeError('value must be a string or string[]');
  }

  const exports = options.map((o) => o.export);
  if (!editable)
    for (const v of values)
      if (!exports.includes(v)) throw new RangeError(`choice field has no option '${v}'`);

  const entries: Array<[string, PdfObject]> = [['Opt', optArray(options)]];
  if (values.length === 1) entries.push(['V', pdfText(values[0])]);
  else if (values.length > 1) entries.push(['V', values.map((v) => pdfText(v))]);
  // /I is ascending zero-based /Opt indices (PDF 32000-1 table 231). Free text
  // on an editable combo matches nothing and contributes no index.
  const idx = values.map((v) => exports.indexOf(v)).filter((i) => i >= 0).sort((a, b) => a - b);
  if (idx.length > 0) entries.push(['I', idx]);

  const c = createField(doc, init, { ft: 'Ch', ff, entries });
  return new ChoiceField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'choice', c.ff, c.dict.get('V') ?? null,
  );
}

/** Create a combo box (`/FT /Ch` with the Combo flag) and return its handle. */
export function addComboBox(doc: Document, init: ComboBoxInit): ChoiceField {
  if ((init as ListBoxInit).multiSelect)
    throw new RangeError('multiSelect applies to a list box, not a combo box');
  let ff = FF_COMBO;
  if (init.editable) ff |= FF_EDIT;
  return addChoice(doc, init, ff, init.editable === true);
}

/** Create a list box (`/FT /Ch` without the Combo flag) and return its handle. */
export function addListBox(doc: Document, init: ListBoxInit): ChoiceField {
  if ((init as ComboBoxInit).editable)
    throw new RangeError('editable applies to a combo box, not a list box');
  let ff = 0;
  if (init.multiSelect) ff |= FF_MULTISELECT;
  return addChoice(doc, init, ff, false);
}
```

Extend the imports at the top of `src/formcreate.ts`:

```ts
import {
  classify, TextField, CheckboxField, RadioField, ChoiceField, type FieldType,
} from './formfield.js';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB, FF_RADIO,
  FF_COMBO, FF_EDIT, FF_MULTISELECT,
} from './fieldflags.js';
```

- [ ] **Step 4: Add the public entry points**

In `src/form.ts`, extend the `formcreate.js` import with `addComboBox`,
`addListBox`, `type ComboBoxInit` and `type ListBoxInit`, and the `formfield.js`
type import with `ChoiceField`. Then add to the `Form` class after
`AddRadioGroup`:

```ts
  /** Create a combo box (a dropdown) on `init.page` and return its handle.
   *  With `editable`, the user may type a value outside `init.options`. Throws
   *  without mutating the document on a malformed or duplicated option, a value
   *  matching no option on a non-editable field, or `multiSelect`. */
  AddComboBox(init: ComboBoxInit): ChoiceField {
    const field = addComboBox(this.doc, init);
    this.build();
    return field;
  }

  /** Create a list box on `init.page` and return its handle. With
   *  `multiSelect`, `init.value` may be a string[]. Throws without mutating the
   *  document on a malformed or duplicated option, a value matching no option,
   *  or `editable`. */
  AddListBox(init: ListBoxInit): ChoiceField {
    const field = addListBox(this.doc, init);
    this.build();
    return field;
  }
```

In `src/page.ts`, extend the same two imports and add after `AddCheckbox`:

```ts
  /** Create an AcroForm combo box whose widget lands on this page.
   *  A thin forwarder to Form.AddComboBox with `page` bound to this page. */
  AddComboBox(init: Omit<ComboBoxInit, 'page'>): ChoiceField {
    return addComboBox(this.doc, { ...init, page: this.Number });
  }

  /** Create an AcroForm list box whose widget lands on this page.
   *  A thin forwarder to Form.AddListBox with `page` bound to this page. */
  AddListBox(init: Omit<ListBoxInit, 'page'>): ChoiceField {
    return addListBox(this.doc, { ...init, page: this.Number });
  }
```

In `src/index.ts`, extend the `formcreate.js` type export:

```ts
export type {
  FieldInit, TextFieldInit, CheckboxInit, RadioOption, RadioGroupInit,
  ChoiceOption, ChoiceInit, ComboBoxInit, ListBoxInit,
} from './formcreate.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add src/formcreate.ts src/form.ts src/page.ts src/index.ts test/form-create.test.ts
git commit -m "feat(form): combo box and list box creation (dbpr.4)"
```

---

### Task 3: `ChoiceField` flag accessors

**Files:**
- Modify: `src/formfield.ts` (`ChoiceField` body)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `setFlag` (added in `dbpr.2`); `FF_COMBO`, `FF_EDIT`,
  `FF_MULTISELECT` (already imported in `formfield.ts`).
- Produces: `ChoiceField.Combo` (get only), `.Editable` (get/set),
  `.MultiSelect` (get/set).

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`:

```ts
describe('ChoiceField flag accessors', () => {
  it('reports Combo without allowing it to be changed', () => {
    const doc = blank();
    const combo = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    const list = doc.Form.AddListBox({
      page: 1, rect: [10, 40, 210, 120], name: 'b', options: ['x'],
    });
    expect(combo.Combo).toBe(true);
    expect(list.Combo).toBe(false);
    // Read-only: no setter exists, so this is a no-op at runtime.
    expect(Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(combo), 'Combo',
    )!.set).toBeUndefined();
  });

  it('toggles Editable on a combo box', () => {
    const doc = blank();
    const f = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    expect(f.Editable).toBe(false);
    f.Editable = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMBO | FF_EDIT);
    expect(f.Editable).toBe(true);
    f.Editable = false;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMBO);
  });

  it('toggles MultiSelect on a list box', () => {
    const doc = blank();
    const f = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    expect(f.MultiSelect).toBe(false);
    f.MultiSelect = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_MULTISELECT);
    expect(f.MultiSelect).toBe(true);
  });

  it('rejects each flag on the wrong field type, from either side', () => {
    const doc = blank();
    const combo = doc.Form.AddComboBox({
      page: 1, rect: [10, 10, 210, 30], name: 'a', options: ['x'],
    });
    const list = doc.Form.AddListBox({
      page: 1, rect: [10, 40, 210, 120], name: 'b', options: ['x'],
    });
    expect(() => { combo.MultiSelect = true; }).toThrow(RangeError);
    expect(() => { list.Editable = true; }).toThrow(RangeError);
    expect(doc.resolve(combo.Dict.get('Ff'))).toBe(FF_COMBO);
    expect(list.Dict.has('Ff')).toBe(false);
  });

  it('allows clearing a flag on the wrong type, which is a no-op', () => {
    const doc = blank();
    const list = doc.Form.AddListBox({
      page: 1, rect: [10, 10, 210, 90], name: 'a', options: ['x'],
    });
    // Only *setting* is rejected; clearing an already-clear flag is harmless.
    expect(() => { list.Editable = false; }).not.toThrow();
    expect(list.Editable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "ChoiceField flag accessors"`
Expected: FAIL — `combo.Combo` is `undefined`.

- [ ] **Step 3: Implement the accessors**

In `src/formfield.ts`, replace the one-line `ChoiceField` declaration

```ts
export class ChoiceField extends Field { declare readonly Type: 'choice'; }
```

with:

```ts
/** A combo box or list box (`/FT /Ch`). The two differ only by the Combo flag,
 *  which is why one class covers both — as the Form walk already does. */
export class ChoiceField extends Field {
  declare readonly Type: 'choice';

  /** /Ff Combo (spec bit 18): renders as a dropdown rather than a list.
   *  Read-only: turning a populated list box into a dropdown is a different
   *  field, not a property change. */
  get Combo(): boolean { return (this.ff & FF_COMBO) !== 0; }

  /** /Ff Edit (spec bit 19): the user may type a value not in /Opt. The
   *  specification makes this meaningful only on a combo box, so setting it on
   *  a list box is rejected rather than written and ignored. */
  get Editable(): boolean { return (this.ff & FF_EDIT) !== 0; }
  set Editable(v: boolean) {
    if (v && !(this.ff & FF_COMBO))
      throw new RangeError('Editable applies to a combo box, not a list box');
    this.setFlag(FF_EDIT, v);
  }

  /** /Ff MultiSelect (spec bit 22): more than one option may be selected.
   *  Meaningful only on a list box. */
  get MultiSelect(): boolean { return (this.ff & FF_MULTISELECT) !== 0; }
  set MultiSelect(v: boolean) {
    if (v && (this.ff & FF_COMBO))
      throw new RangeError('MultiSelect applies to a list box, not a combo box');
    this.setFlag(FF_MULTISELECT, v);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/formfield.ts test/form-create.test.ts
git commit -m "feat(form): ChoiceField Combo/Editable/MultiSelect accessors (dbpr.4)"
```

---

### Task 4: Documentation, follow-up, and close

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md`**

In the "Form fields (AcroForm)" section, after the paragraph ending
"...since a group is not bound to a single page.", add:

````markdown
Choice fields carry an option list. An option is a bare string when its export
value and displayed text are the same, or `{ export, display }` when they
differ:

```ts
const size = doc.Form.AddComboBox({
  page: 1, rect: [72, 600, 272, 620], name: 'size',
  options: ['Small', 'Medium', 'Large'],
  value: 'Medium',
  editable: true,          // the user may type a value outside the list
});

const country = doc.Form.AddListBox({
  page: 1, rect: [72, 500, 272, 580], name: 'country',
  options: [
    { export: 'us', display: 'United States' },
    { export: 'gb', display: 'United Kingdom' },
  ],
  multiSelect: true,
  value: ['us', 'gb'],
});
country.Options;   // ['us', 'gb'] — the export values
country.Value;     // ['us', 'gb']
```

`/V` holds the **export** value, and the generated appearance draws the
**display** text. `Editable` applies only to a combo box and `MultiSelect` only
to a list box; setting either on the wrong type throws.
````

- [ ] **Step 2: Update the API-overview table in `README.md`**

After the `AddRadioGroup` row, add:

```markdown
| `doc.Form.AddComboBox(init)` / `page.AddComboBox(init)` | Create a dropdown → `ChoiceField` |
| `doc.Form.AddListBox(init)` / `page.AddListBox(init)` | Create a list box → `ChoiceField` |
```

- [ ] **Step 3: Update `CLAUDE.md`**

Append this invariant to the end of the
`form.ts`/`formfield.ts`/`formcreate.ts`/`fieldflags.ts` bullet:

```markdown
  **Invariant:** a `/Opt` entry may be a plain string or an `[export, display]`
  pair, and `/V` holds the **export**. Any appearance code that keeps only the
  display half silently mismatches — a list box highlights nothing and a combo
  draws the export value. `choiceEntries` parses both halves; match on export
  first, then display, and draw the display.
```

- [ ] **Step 4: File the follow-up the spec defers**

```bash
bd create "Choice field option-list mutation: AddOption / RemoveOption" \
  -t feature -p 3 \
  -d "Go has ComboBoxField.AddOption/RemoveOption and ListBoxField equivalents (form_fields.go). dbpr.4 sets the option list at creation only. Mutation must also keep /V and /I consistent when a selected option is removed. Deferred from dbpr.4 (see docs/superpowers/specs/2026-07-27-choice-field-creation-design.md)."
```

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. Per `superpowers:verification-before-completion`, do not
claim completion without this output in hand.

- [ ] **Step 6: Commit, close and push**

```bash
git add README.md CLAUDE.md
git commit -m "docs(form): document combo box and list box creation (dbpr.4)"

bd close aspose-pdf-foss-for-ts-dbpr.4
bd remember --key choice-field-creation-shipped \
  "choice-field-creation-shipped (dbpr.4): Form/Page.AddComboBox(ComboBoxInit{options,value?,editable?}) and AddListBox(ListBoxInit{options,value?,multiSelect?}) -> ChoiceField (one class for both; they differ only by /Ff Combo, as the Form walk already assumes). ChoiceOption = string | {export, display?}; a bare string or a display equal to the export writes a plain /Opt string, otherwise an [export, display] pair. Creation writes /V (string or array) and /I (ascending indices, omitted for editable free text). ChoiceField gains Combo (read-only), Editable (combo only), MultiSelect (list only) — setting either on the wrong type throws. FIXED TWO RENDERING BUGS in appearance.ts: optionLabels kept only the display half while /V holds the export, so a list box highlighted nothing and a combo drew the export value; replaced by choiceEntries -> {export,display}[], selectedIndices matches export then display, and valueStrings handles an array /V (multi-select, which previously never highlighted). Field.setChoice deletes /I on every write, so the fallback is the normal path. Spec: docs/superpowers/specs/2026-07-27-choice-field-creation-design.md"

git add .beads/
git commit -m "chore(bd): close dbpr.4 (combo box & list box creation)"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **`/V` holds the export, never the display.** Every comparison against `/V`
  must try the export first. The display fallback exists only for producers that
  wrote the display text into `/V`, which some do.
- **Do not write `/I` and then rely on it.** `Field.setChoice` deletes it on
  every value change, by design — the indices would otherwise be stale. `/I` is
  a fast path, and `selectedIndices` must work without it.
- **An empty `options` array is legal**, not an error to guard against. An
  editable combo with no predefined options is a free-text dropdown.
- **`textOf` returns `''` for an array**, which is why `valueStrings` exists.
  Do not reintroduce `textOf(value)` in the list-box path.
- **`ChoiceField.Combo` has no setter.** The test asserts that via
  `Object.getOwnPropertyDescriptor`, so adding one will fail the suite.
