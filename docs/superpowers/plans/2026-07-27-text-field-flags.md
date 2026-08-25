# Text-Field Flags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the text-field flags — Multiline, Password, Comb, MaxLen,
ReadOnly, Required — as both creation options and live setters, and stop the
appearance generator painting a password field's plaintext.

**Architecture:** Consolidate the `/Ff` bit constants (currently defined in
three modules) into one `fieldflags.ts`. Mask password values inside
`generateFieldAppearance`, so the fix reaches the read path — `GenerateAppearances`
and `FlattenForm` — and not just newly created fields. Add a `protected
setFlag` on `Field` that writes the dict *and* refreshes the cached effective
flags before regenerating the `/AP`, since `GenerateAppearance` reads that cache.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest. No runtime dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-07-27-text-field-flags-design.md`
Issue: `aspose-pdf-foss-for-ts-dbpr.2` (already claimed)
Builds on: `dbpr.1`, shipped in commits `7352e62`..`8e12a54`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **Strict TypeScript.** `npm run typecheck` (`tsc --noEmit`) must be green.
- **`bd`, not TodoWrite.** Task tracking goes through `bd`; do not create markdown TODO lists.
- **Errors:** `TypeError` for a malformed argument; `RangeError` for a well-formed
  but rejected value. This matches `src/form.ts` and `dbpr.1`.
- **Validation precedes mutation.** A rejected call leaves `/Ff` and `/MaxLen` untouched.
- **`/NeedAppearances` is never set** by any code in this plan.
- **Every mutating public entry point calls `doc.markModified()`** before returning.
- **Commit after every task.** Run `npm test` (full suite) before each commit.

### Facts you will need

- A bullet is `U+2022`. `encodeWinAnsi` maps it to byte `0x95`, and
  `serializeString` escapes any byte above 126 as **octal**, so a bullet appears
  in an `/AP` content stream as the four characters `\225`. Assertions match on
  that, not on the raw byte.
- Appearance streams are written uncompressed by `buildAppearanceXObject`, so
  `new TextDecoder('latin1').decode(stream.raw)` gives readable content.
- `Field.ff` is the *effective* `/Ff` captured during the tree walk, not a live
  read of the dict. `GenerateAppearance()` passes it to `generateFieldAppearance`.

---

### Task 1: One shared `/Ff` constants module

**Files:**
- Create: `src/fieldflags.ts`
- Modify: `src/appearance.ts:16-19` (delete local constants, import instead)
- Modify: `src/formfield.ts:10-15` (same)
- Modify: `src/formcreate.ts` (same — the `FF_READONLY`/`FF_REQUIRED` pair)
- Test: `test/fieldflags.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FF_READONLY`, `FF_REQUIRED`, `FF_MULTILINE`, `FF_PASSWORD`,
  `FF_COMB`, `FF_RADIO`, `FF_PUSHBUTTON`, `FF_COMBO`, `FF_EDIT`,
  `FF_MULTISELECT` — all `number`.

- [ ] **Step 1: Write the failing test**

Create `test/fieldflags.test.ts`. The expected values are decimal literals
transcribed independently from the specification tables — a test that recomputes
`1 << 24` cannot catch a mis-numbered bit, because it repeats the mistake.

```ts
import { describe, it, expect } from 'vitest';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB,
  FF_RADIO, FF_PUSHBUTTON, FF_COMBO, FF_EDIT, FF_MULTISELECT,
} from '../src/fieldflags.js';

// PDF 32000-1 tables 226 (common), 228 (text), 229 (button), 230 (choice).
// Spec bit N has value 2^(N-1); these are those values written out.
describe('field flag bits', () => {
  it('matches the specification tables', () => {
    expect(FF_READONLY).toBe(1);            // bit 1
    expect(FF_REQUIRED).toBe(2);            // bit 2
    expect(FF_MULTILINE).toBe(4096);        // bit 13
    expect(FF_PASSWORD).toBe(8192);         // bit 14
    expect(FF_RADIO).toBe(32768);           // bit 16
    expect(FF_PUSHBUTTON).toBe(65536);      // bit 17
    expect(FF_COMBO).toBe(131072);          // bit 18
    expect(FF_EDIT).toBe(262144);           // bit 19
    expect(FF_MULTISELECT).toBe(2097152);   // bit 22
    expect(FF_COMB).toBe(16777216);         // bit 25
  });

  it('gives every flag a distinct bit', () => {
    const all = [
      FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB,
      FF_RADIO, FF_PUSHBUTTON, FF_COMBO, FF_EDIT, FF_MULTISELECT,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(f & (f - 1)).toBe(0); // exactly one bit set
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fieldflags.test.ts`
Expected: FAIL — `Failed to resolve import "../src/fieldflags.js"`.

- [ ] **Step 3: Create `src/fieldflags.ts`**

```ts
/** AcroForm field flags (`/Ff`), PDF 32000-1 §12.7.4.
 *
 *  Each constant is commented with the specification's **1-based** bit number,
 *  because that is the number the tables use and the one that is easy to get
 *  wrong: spec bit N is `1 << (N - 1)`. An off-by-one here produces a flag that
 *  is silently the wrong flag rather than an obvious break. */

// Table 226 — common to every field type.
export const FF_READONLY = 1 << 0;      // bit 1
export const FF_REQUIRED = 1 << 1;      // bit 2

// Table 228 — text fields.
export const FF_MULTILINE = 1 << 12;    // bit 13
export const FF_PASSWORD = 1 << 13;     // bit 14
export const FF_COMB = 1 << 24;         // bit 25

// Table 229 — button fields.
export const FF_RADIO = 1 << 15;        // bit 16
export const FF_PUSHBUTTON = 1 << 16;   // bit 17

// Table 230 — choice fields.
export const FF_COMBO = 1 << 17;        // bit 18
export const FF_EDIT = 1 << 18;         // bit 19
export const FF_MULTISELECT = 1 << 21;  // bit 22
```

- [ ] **Step 4: Rewire the three modules**

In `src/appearance.ts`, delete these three lines (currently at 17-19):

```ts
const FF_MULTILINE = 1 << 12;
const FF_COMB = 1 << 24;
const FF_COMBO = 1 << 17;
```

and add to its imports:

```ts
import { FF_MULTILINE, FF_COMB, FF_COMBO } from './fieldflags.js';
```

In `src/formfield.ts`, delete the five local constants under the comment
`// Field-flag bits (/Ff), PDF 32000-1 §12.7.4.` (`FF_RADIO`, `FF_PUSHBUTTON`,
`FF_COMBO`, `FF_EDIT`, `FF_MULTISELECT`) together with that comment, and add:

```ts
import {
  FF_RADIO, FF_PUSHBUTTON, FF_COMBO, FF_EDIT, FF_MULTISELECT,
} from './fieldflags.js';
```

In `src/formcreate.ts`, delete:

```ts
// Field flag bits (/Ff), PDF 32000-1 §12.7.3.1.
const FF_READONLY = 1 << 0;
const FF_REQUIRED = 1 << 1;
```

keeping the `ANNOT_PRINT` constant that follows, and add:

```ts
import { FF_READONLY, FF_REQUIRED } from './fieldflags.js';
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/fieldflags.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS. This is a pure refactor — any failure means a constant changed
value during the move.

- [ ] **Step 7: Commit**

```bash
git add src/fieldflags.ts src/appearance.ts src/formfield.ts src/formcreate.ts test/fieldflags.test.ts
git commit -m "refactor(form): consolidate /Ff bit constants into fieldflags.ts (dbpr.2)"
```

---

### Task 2: Password masking in the appearance generator

**Files:**
- Modify: `src/appearance.ts` (the `case 'text'` arm of `generateFieldAppearance`, ~line 406)
- Test: `test/form-appearance.test.ts` (append)

**Interfaces:**
- Consumes: `FF_PASSWORD` (Task 1).
- Produces: no new exports. Behaviour: `generateFieldAppearance` paints bullets
  for a field whose `/Ff` has the Password bit.

- [ ] **Step 1: Write the failing test**

Append to `test/form-appearance.test.ts`, and add these imports at the top of
the file:

```ts
import { FF_PASSWORD } from '../src/fieldflags.js';
import { isStream } from '../src/types.js';

const streamText = (o: unknown) =>
  isStream(o as never) ? new TextDecoder('latin1').decode((o as { raw: Uint8Array }).raw) : '';
const apText = (doc: Document, dict: PdfDict) =>
  streamText(doc.resolve((doc.resolve(dict.get('AP')) as PdfDict).get('N')));
```

```ts
describe('password field appearance', () => {
  // A bullet is U+2022 -> WinAnsi 0x95, which serializeString escapes as octal.
  const BULLET = '\\225';

  it('paints the plaintext when the Password flag is absent', () => {
    const doc = Document.Open(buildFormPdf());
    const f = doc.Form.Get('name')!;
    f.Value = 'hunter2';
    expect(apText(doc, f.Dict)).toContain('hunter2');
  });

  it('masks the value: no plaintext, one bullet per character', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Dict.set('Ff', FF_PASSWORD);
    const f = doc.Form.Get('name')!;   // re-walk, so the flag is in effect
    f.Value = 'hunter2';
    const content = apText(doc, f.Dict);
    expect(content).not.toContain('hunter2');
    expect(content.split(BULLET).length - 1).toBe(7);
  });

  it('counts by code point, so an astral character masks as one bullet', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Dict.set('Ff', FF_PASSWORD);
    const f = doc.Form.Get('name')!;
    f.Value = 'a\u{1F600}b';           // 3 code points, 4 UTF-16 units
    expect(apText(doc, f.Dict).split(BULLET).length - 1).toBe(3);
  });

  it('masks on the read path too, via GenerateAppearances', () => {
    const doc = Document.Open(buildFormPdf());
    const dict = doc.Form.Get('name')!.Dict;
    dict.set('Ff', FF_PASSWORD);
    doc.Form.GenerateAppearances();
    const content = apText(doc, dict);
    expect(content).not.toContain('Bob');   // the fixture's /V
    expect(content).toContain(BULLET);
  });

  it('does not bake plaintext into page content when the form is flattened', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Dict.set('Ff', FF_PASSWORD);
    doc.FlattenForm();
    const page = doc.Pages[0];
    const xo = doc.resolve((doc.resolve(page.Dict.get('Resources')) as PdfDict).get('XObject'));
    const bodies = isDict(xo)
      ? [...(xo as PdfDict).values()].map((v) => streamText(doc.resolve(v)))
      : [];
    const all = bodies.join('\n') + streamText(doc.resolve(page.Dict.get('Contents')));
    expect(all).not.toContain('Bob');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-appearance.test.ts -t "password field appearance"`
Expected: FAIL on the four masking cases — the plaintext is still painted. The
first case ("paints the plaintext when the Password flag is absent") passes
already; that is deliberate, it is the control that proves the later assertions
are about masking and not about the value being missing for some other reason.

- [ ] **Step 3: Implement the mask**

In `src/appearance.ts`, add next to `textOf` (around line 285):

```ts
/** A password field must never paint its value. One WinAnsi bullet (0x95) per
 *  character, counted by code point so an astral character masks as one bullet
 *  rather than two. Masking here rather than at the call sites means the read
 *  path gets it too: GenerateAppearances and FlattenForm both route through
 *  generateFieldAppearance, and flattening previously baked the plaintext into
 *  permanent page content. */
function maskIfPassword(text: string, ff: number): string {
  return (ff & FF_PASSWORD) ? '•'.repeat([...text].length) : text;
}
```

Add `FF_PASSWORD` to the `./fieldflags.js` import added in Task 1.

Then rewrite the `case 'text'` arm of `generateFieldAppearance` so all three
renderers receive the masked string:

```ts
      case 'text': {
        const maxLenRaw = doc.resolve(fieldDict.get('MaxLen'));
        const maxLen = typeof maxLenRaw === 'number' ? maxLenRaw : 0;
        const shown = maskIfPassword(textOf(value), ff);
        if ((ff & FF_COMB) && maxLen > 0 && !(ff & FF_MULTILINE))
          body = combText(shown, da, g, maxLen, mk.inset);
        else if (ff & FF_MULTILINE)
          body = multilineText(shown, da, g, mk.inset);
        else
          body = singleLineText(shown, da, g, q, mk.inset);
        break;
      }
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-appearance.test.ts && npm run typecheck`
Expected: PASS (all five cases).

- [ ] **Step 5: Prove the mask is load-bearing**

Temporarily change `maskIfPassword`'s body to `return text;`, then run:

Run: `npx vitest run test/form-appearance.test.ts -t "password field appearance"`
Expected: FAIL on all four masking cases, PASS on the control. **Revert** and
confirm green.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add src/appearance.ts test/form-appearance.test.ts
git commit -m "fix(form): mask password field values in generated appearances (dbpr.2)"
```

---

### Task 3: `setFlag` and the type-neutral `ReadOnly` / `Required`

**Files:**
- Modify: `src/formfield.ts` (`Field`: drop `readonly` on `ff`, add `setFlag` and two accessors)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `FF_READONLY`, `FF_REQUIRED` (Task 1).
- Produces:
  - `protected setFlag(bit: number, on: boolean): void` on `Field`
  - `Field.ReadOnly: boolean` (get/set), `Field.Required: boolean` (get/set)

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`, adding to the top-of-file imports:

```ts
import { FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB } from '../src/fieldflags.js';
```

```ts
describe('Field.ReadOnly / Field.Required', () => {
  it('reads the flags off an existing field', () => {
    const f = Document.Open(buildFormPdf()).Form.Get('name')!;
    expect(f.ReadOnly).toBe(false);
    expect(f.Required).toBe(false);
  });

  it('sets and clears each bit independently', () => {
    const doc = Document.Open(buildFormPdf());
    const f = doc.Form.Get('name')!;
    f.ReadOnly = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_READONLY);
    f.Required = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_READONLY | FF_REQUIRED);
    f.ReadOnly = false;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_REQUIRED);
    expect(f.Required).toBe(true);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a' }).Required = true;
    expect(Document.Open(doc.Save()).Form.Get('a')!.Required).toBe(true);
  });

  it('keeps the cached effective flags in step with the dict', () => {
    // The trap: GenerateAppearance() reads Field.ff, not the dict. A setter that
    // writes only the dict regenerates the appearance from the *old* flags.
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'a', value: 'secret',
    });
    f.setFlagForTest(FF_PASSWORD, true);
    f.GenerateAppearance();
    const ap = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    expect(new TextDecoder('latin1').decode(ap.raw)).not.toContain('secret');
  });
});
```

`setFlag` is `protected`, so the test needs a way in. `TextField` is currently
the one-line declaration

```ts
export class TextField extends Field { declare readonly Type: 'text'; }
```

Replace it with the expanded form carrying a test seam — the narrowest opening
that still exercises the real code path (Task 4 fills the rest of this body in):

```ts
/** A text field (`/FT /Tx`). */
export class TextField extends Field {
  declare readonly Type: 'text';

  /** @internal Test seam for `setFlag`, which is protected. */
  setFlagForTest(bit: number, on: boolean): void { this.setFlag(bit, on); }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "ReadOnly"`
Expected: FAIL — `f.ReadOnly` is `undefined`, and assigning to it does nothing.

- [ ] **Step 3: Make `ff` mutable and add `setFlag`**

In `src/formfield.ts`, change the constructor parameter:

```ts
    /** Effective /Ff (own or inherited at walk time). */
    protected ff: number,
```

(drop `readonly` — it was `protected readonly ff: number`).

Add to the `Field` class, next to `GenerateAppearance`:

```ts
  /** Set or clear one /Ff bit. Writes the dict *and* refreshes the cached
   *  effective flags, because GenerateAppearance() reads the cache — updating
   *  only the dict would store the new flag and draw the old one. */
  protected setFlag(bit: number, on: boolean): void {
    this.ff = on ? (this.ff | bit) : (this.ff & ~bit);
    this.Dict.set('Ff', this.ff);
    this.GenerateAppearance();
    this.doc.markModified();
  }

  /** /Ff ReadOnly (spec bit 1): the field cannot be edited in a viewer. */
  get ReadOnly(): boolean { return (this.ff & FF_READONLY) !== 0; }
  set ReadOnly(v: boolean) { this.setFlag(FF_READONLY, v); }

  /** /Ff Required (spec bit 2): the field must be filled before submit. */
  get Required(): boolean { return (this.ff & FF_REQUIRED) !== 0; }
  set Required(v: boolean) { this.setFlag(FF_REQUIRED, v); }
```

Add `FF_READONLY, FF_REQUIRED` to the `./fieldflags.js` import in this file.

Note that `setFlag` always writes `/Ff`, even when the result is `0`. That is
deliberate: an explicit `/Ff 0` overrides a value inherited from a parent field,
whereas deleting the key would silently re-inherit it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the cache refresh is load-bearing**

Temporarily remove the `this.ff = ...` line from `setFlag`, replacing it with a
direct dict write only:

```ts
  protected setFlag(bit: number, on: boolean): void {
    this.Dict.set('Ff', on ? (this.ff | bit) : (this.ff & ~bit));
    this.GenerateAppearance();
    this.doc.markModified();
  }
```

Run: `npx vitest run test/form-create.test.ts -t "cached effective flags"`
Expected: FAIL — the appearance still contains `secret`, because the mask was
chosen from the stale `ff`. **Revert** and confirm green.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm test
git add src/formfield.ts test/form-create.test.ts
git commit -m "feat(form): Field.setFlag with ReadOnly/Required accessors (dbpr.2)"
```

---

### Task 4: `TextField` flag accessors and their validation

**Files:**
- Modify: `src/formfield.ts` (`TextField` body)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `setFlag` (Task 3); `FF_MULTILINE`, `FF_PASSWORD`, `FF_COMB` (Task 1).
- Produces: `TextField.Multiline`, `.Password`, `.Comb` (all `boolean` get/set),
  `TextField.MaxLen` (`number` get/set).

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`:

```ts
describe('TextField flag accessors', () => {
  const mk = (doc: Document) =>
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 60], name: 'a', value: 'x' });

  it('round-trips each flag as the right /Ff bit', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.Multiline).toBe(false);
    f.Multiline = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_MULTILINE);
    expect(f.Multiline).toBe(true);
    f.Multiline = false;
    f.Password = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_PASSWORD);
    expect(f.Password).toBe(true);
  });

  it('reads MaxLen as 0 when absent and deletes the entry when set to 0', () => {
    const doc = blank();
    const f = mk(doc);
    expect(f.MaxLen).toBe(0);
    f.MaxLen = 12;
    expect(doc.resolve(f.Dict.get('MaxLen'))).toBe(12);
    f.MaxLen = 0;
    expect(f.Dict.has('MaxLen')).toBe(false);
    expect(f.MaxLen).toBe(0);
  });

  it('accepts Comb once MaxLen is set', () => {
    const doc = blank();
    const f = mk(doc);
    f.MaxLen = 9;
    f.Comb = true;
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMB);
  });

  it('rejects Comb without MaxLen, and leaves /Ff untouched', () => {
    const doc = blank();
    const f = mk(doc);
    expect(() => { f.Comb = true; }).toThrow(RangeError);
    expect(f.Dict.has('Ff')).toBe(false);
    expect(f.Comb).toBe(false);
  });

  it('rejects the pairs the specification forbids, from either side', () => {
    const doc = blank();
    const f = mk(doc);
    f.MaxLen = 9;
    f.Comb = true;
    expect(() => { f.Multiline = true; }).toThrow(RangeError);
    expect(() => { f.Password = true; }).toThrow(RangeError);
    expect(() => { f.MaxLen = 0; }).toThrow(RangeError);
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMB);
    expect(f.MaxLen).toBe(9);

    const g = doc.Form.AddTextField({ page: 1, rect: [10, 70, 210, 120], name: 'b' });
    g.Multiline = true;
    g.MaxLen = 9;
    expect(() => { g.Comb = true; }).toThrow(RangeError);
  });

  it('rejects a non-integer or negative MaxLen', () => {
    const doc = blank();
    const f = mk(doc);
    for (const bad of [-1, 1.5, NaN]) expect(() => { f.MaxLen = bad; }).toThrow(TypeError);
    expect(f.Dict.has('MaxLen')).toBe(false);
  });

  it('regenerates the appearance when a flag changes', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'a', value: 'one two three four five',
    });
    const apOf = () => {
      const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
      return new TextDecoder('latin1').decode(n.raw);
    };
    const before = apOf();
    f.Multiline = true;
    expect(apOf()).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "TextField flag accessors"`
Expected: FAIL — `f.Multiline` is `undefined`.

- [ ] **Step 3: Implement the accessors**

Replace the one-line `TextField` declaration in `src/formfield.ts` with:

```ts
/** A text field (`/FT /Tx`). */
export class TextField extends Field {
  declare readonly Type: 'text';

  /** @internal Test seam for `setFlag`, which is protected. */
  setFlagForTest(bit: number, on: boolean): void { this.setFlag(bit, on); }

  /** /Ff Multiline (spec bit 13): the value wraps across lines. */
  get Multiline(): boolean { return (this.ff & FF_MULTILINE) !== 0; }
  set Multiline(v: boolean) {
    if (v && (this.ff & FF_COMB)) throw new RangeError('a comb field cannot be multiline');
    this.setFlag(FF_MULTILINE, v);
  }

  /** /Ff Password (spec bit 14): the appearance shows bullets, not the value. */
  get Password(): boolean { return (this.ff & FF_PASSWORD) !== 0; }
  set Password(v: boolean) {
    if (v && (this.ff & FF_COMB)) throw new RangeError('a comb field cannot be a password field');
    this.setFlag(FF_PASSWORD, v);
  }

  /** /Ff Comb (spec bit 25): the value is laid out in `MaxLen` even cells.
   *  Requires MaxLen > 0, and is forbidden with Multiline or Password. */
  get Comb(): boolean { return (this.ff & FF_COMB) !== 0; }
  set Comb(v: boolean) {
    if (v) {
      if (this.MaxLen <= 0) throw new RangeError('a comb field requires MaxLen > 0');
      if (this.ff & FF_MULTILINE) throw new RangeError('a comb field cannot be multiline');
      if (this.ff & FF_PASSWORD) throw new RangeError('a comb field cannot be a password field');
    }
    this.setFlag(FF_COMB, v);
  }

  /** /MaxLen: the maximum character count, 0 when absent (unlimited). Writing
   *  0 removes the entry rather than storing a meaningless limit. */
  get MaxLen(): number {
    const v = this.doc.resolve(this.Dict.get('MaxLen'));
    return typeof v === 'number' && v > 0 ? v : 0;
  }
  set MaxLen(v: number) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
      throw new TypeError('MaxLen must be a non-negative integer');
    if (v === 0 && (this.ff & FF_COMB))
      throw new RangeError('a comb field requires MaxLen > 0');
    if (v === 0) this.Dict.delete('MaxLen'); else this.Dict.set('MaxLen', v);
    this.GenerateAppearance();
    this.doc.markModified();
  }
}
```

Add `FF_MULTILINE, FF_PASSWORD, FF_COMB` to the `./fieldflags.js` import in
this file.

Note `Number.isInteger(NaN)` is `false`, so `NaN` is caught by the integer
check without a separate guard.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/formfield.ts test/form-create.test.ts
git commit -m "feat(form): TextField Multiline/Password/Comb/MaxLen accessors (dbpr.2)"
```

---

### Task 5: Creation options on `TextFieldInit`

**Files:**
- Modify: `src/formcreate.ts` (`TextFieldInit`, `addTextField`)
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `createField` and `pdfText` (already in `formcreate.ts` from `dbpr.1`);
  `FF_MULTILINE`, `FF_PASSWORD`, `FF_COMB` (Task 1).
- Produces: `TextFieldInit` gains `multiline?: boolean`, `password?: boolean`,
  `comb?: boolean`, `maxLen?: number`.

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`:

```ts
describe('AddTextField flags', () => {
  it('sets the flag bits and /MaxLen at creation', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'notes',
      value: 'hello', multiline: true, maxLen: 200,
    });
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_MULTILINE);
    expect(doc.resolve(f.Dict.get('MaxLen'))).toBe(200);
    expect(f.Multiline).toBe(true);
    expect(f.MaxLen).toBe(200);
  });

  it('combines flag options with the type-neutral ones', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'a',
      password: true, readOnly: true, required: true,
    });
    expect(doc.resolve(f.Dict.get('Ff')))
      .toBe(FF_PASSWORD | FF_READONLY | FF_REQUIRED);
  });

  it('omits /MaxLen when maxLen is absent or 0', () => {
    const doc = blank();
    expect(doc.Form.AddTextField({ page: 1, rect: [10, 10, 110, 30], name: 'a' })
      .Dict.has('MaxLen')).toBe(false);
    expect(doc.Form.AddTextField({ page: 1, rect: [10, 40, 110, 60], name: 'b', maxLen: 0 })
      .Dict.has('MaxLen')).toBe(false);
  });

  it('positions one glyph per character in its own comb cell', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 190, 40], name: 'ssn', value: '123456789',
      comb: true, maxLen: 9,
    });
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(FF_COMB);
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    const content = new TextDecoder('latin1').decode(n.raw);
    // combText emits one Td per character of the value, truncated to maxLen.
    // The value here is exactly 9 characters, so 9 is both counts.
    expect(content.split(' Td').length - 1).toBe(9);
    // A shorter value fills only as many cells as it has characters.
    const g = doc.Form.AddTextField({
      page: 1, rect: [10, 50, 190, 80], name: 'short', value: '123',
      comb: true, maxLen: 9,
    });
    const gn = doc.resolve((doc.resolve(g.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    expect(new TextDecoder('latin1').decode(gn.raw).split(' Td').length - 1).toBe(3);
  });

  it('masks a password field created with a value', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 40], name: 'pw', value: 'hunter2', password: true,
    });
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { raw: Uint8Array };
    const content = new TextDecoder('latin1').decode(n.raw);
    expect(content).not.toContain('hunter2');
    expect(content.split('\\225').length - 1).toBe(7);
  });

  it('rejects the forbidden combinations without mutating the document', () => {
    const bad: Array<[Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      [{ comb: true }, RangeError],                             // no maxLen
      [{ comb: true, maxLen: 0 }, RangeError],
      [{ comb: true, maxLen: 9, multiline: true }, RangeError],
      [{ comb: true, maxLen: 9, password: true }, RangeError],
      [{ maxLen: -1 }, TypeError],
      [{ maxLen: 1.5 }, TypeError],
    ];
    for (const [extra, err] of bad) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddTextField({
        page: 1, rect: [10, 10, 110, 30], name: 'a', ...extra,
      } as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });

  it('survives a Save/Open round-trip with flags intact', () => {
    const doc = blank();
    doc.Form.AddTextField({
      page: 1, rect: [10, 10, 210, 60], name: 'notes', multiline: true, maxLen: 40,
    });
    const back = Document.Open(doc.Save());
    const f = back.Form.Get('notes') as TextField;
    expect(f).toBeInstanceOf(TextField);
    expect(f.Multiline).toBe(true);
    expect(f.MaxLen).toBe(40);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "AddTextField flags"`
Expected: FAIL — the options are ignored, so `/Ff` is absent.

- [ ] **Step 3: Extend `TextFieldInit` and `addTextField`**

In `src/formcreate.ts`, replace the `TextFieldInit` interface:

```ts
/** Options for Form.AddTextField / Page.AddTextField. */
export interface TextFieldInit extends FieldInit {
  /** Initial /V. Default ''. */
  value?: string;
  /** /Ff Multiline (spec bit 13): the value wraps across lines. */
  multiline?: boolean;
  /** /Ff Password (spec bit 14): the appearance shows bullets, not the value. */
  password?: boolean;
  /** /Ff Comb (spec bit 25): `maxLen` evenly spaced cells. Requires
   *  `maxLen` > 0, and cannot be combined with `multiline` or `password`. */
  comb?: boolean;
  /** /MaxLen: maximum character count. 0 or absent means unlimited. */
  maxLen?: number;
}
```

and replace `addTextField`:

```ts
/** Create a single-line text field (`/FT /Tx`) and return its live handle. */
export function addTextField(doc: Document, init: TextFieldInit): TextField {
  const value = init.value ?? '';
  if (typeof value !== 'string') throw new TypeError('value must be a string');

  const maxLen = init.maxLen ?? 0;
  if (typeof maxLen !== 'number' || !Number.isInteger(maxLen) || maxLen < 0)
    throw new TypeError('maxLen must be a non-negative integer');
  // The specification forbids these pairings, and appearance.ts silently
  // resolves each one in favour of something the caller did not ask for.
  if (init.comb) {
    if (maxLen <= 0) throw new RangeError('a comb field requires maxLen > 0');
    if (init.multiline) throw new RangeError('a comb field cannot be multiline');
    if (init.password) throw new RangeError('a comb field cannot be a password field');
  }

  let ff = 0;
  if (init.multiline) ff |= FF_MULTILINE;
  if (init.password) ff |= FF_PASSWORD;
  if (init.comb) ff |= FF_COMB;

  const entries: Array<[string, PdfObject]> = [['V', pdfText(value)]];
  if (maxLen > 0) entries.push(['MaxLen', maxLen]);

  const c = createField(doc, init, { ft: 'Tx', ff, entries });
  return new TextField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'text', c.ff, c.dict.get('V') ?? null,
  );
}
```

Add `FF_MULTILINE, FF_PASSWORD, FF_COMB` to the `./fieldflags.js` import in
this file (which Task 1 created with `FF_READONLY, FF_REQUIRED`).

Every throw above happens before `createField` is called, so nothing has been
allocated and the document is untouched — the same guarantee `dbpr.1` documents.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/formcreate.ts test/form-create.test.ts
git commit -m "feat(form): multiline/password/comb/maxLen options on AddTextField (dbpr.2)"
```

---

### Task 6: Documentation, follow-up, and close

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md` (the `form.ts`/`formfield.ts`/`formcreate.ts` bullet)

- [ ] **Step 1: Update `README.md`**

In the "Form fields (AcroForm)" section, the `AddTextField` example added by
`dbpr.1` currently ends with `required: true,`. Extend that example and the
paragraph after it:

```markdown
const field = doc.Form.AddTextField({
  page: 1,
  rect: [72, 700, 272, 722],
  name: 'address.city',   // FullName; '.' separates hierarchy levels
  value: 'Prague',
  font: 'Helvetica',      // Standard-14 face for /DA; default Helvetica
  fontSize: 0,            // 0 (default) auto-sizes to the box
  textColor: [0, 0, 0],
  required: true,         // /Ff bits; readOnly likewise
  multiline: true,        // wrap across lines
  maxLen: 200,            // /MaxLen; 0 or absent means unlimited
});

// Flags are also live on any text field, including one read from a file:
const f = doc.Form.Get('address.city') as TextField;
f.Multiline = false;
f.MaxLen = 9;
f.Comb = true;            // MaxLen evenly spaced cells
f.Password = true;        // appearance shows bullets, never the value
```

Then add this paragraph immediately after the existing one that ends
"...leaves the document unmodified.":

```markdown
A **password** field's appearance shows one bullet per character — the value
never reaches the content stream, including when `GenerateAppearances()` or
`FlattenForm()` regenerates it. **Comb** requires `MaxLen > 0` and cannot be
combined with `multiline` or `password`; each forbidden pairing throws rather
than silently rendering as something else.
```

- [ ] **Step 2: Update the API-overview table in `README.md`**

The row added by `dbpr.1` reads:

```markdown
| `page.AddTextField(init)` | Create a text field whose widget lands on this page → `TextField` |
```

Add a row after it:

```markdown
| `TextField` | `Multiline`, `Password`, `Comb`, `MaxLen`; `ReadOnly`/`Required` on `Field` — all regenerate the `/AP` |
```

- [ ] **Step 3: Update `CLAUDE.md`**

In the `form.ts`, `formfield.ts`, `formcreate.ts` bullet, add `fieldflags.ts`
to the module list by replacing the bullet's first line:

```markdown
- **form.ts**, **formfield.ts**, **formcreate.ts**, **fieldflags.ts** — AcroForm:
```

and append this invariant to the end of that bullet:

```markdown
  **Invariant:** `Field.ff` is the effective `/Ff` captured during the tree
  walk, and `GenerateAppearance()` reads it rather than the dict. Any code that
  changes a flag must go through `setFlag`, which updates both — writing only
  the dict stores the new flag and draws the old one.
  **Invariant:** a password field's value must never reach a content stream.
  Masking lives in `generateFieldAppearance`, not at the creation call sites, so
  `GenerateAppearances` and `FlattenForm` get it too — flattening otherwise
  bakes the plaintext into permanent page content, where no viewer will ever
  mask it again.
```

- [ ] **Step 4: File the follow-up the spec defers**

```bash
bd create "Text field variants: FileSelect and RichText" \
  -t feature -p 3 \
  -d "Go exposes these as separate field types (FileSelectBoxField, RichTextBoxField in form_fields_extra.go) carrying /RV rich-text values and format /AA actions, not as bare flags — a larger surface than dbpr.2 covered. /Ff FileSelect is spec bit 21, RichText is bit 26. Deferred from dbpr.2 (see docs/superpowers/specs/2026-07-27-text-field-flags-design.md)."
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
git commit -m "docs(form): document text-field flags and password masking (dbpr.2)"

bd close aspose-pdf-foss-for-ts-dbpr.2
bd remember --key text-field-flags-shipped \
  "text-field-flags-shipped (dbpr.2): src/fieldflags.ts now holds every /Ff constant (was duplicated across appearance.ts, formfield.ts, formcreate.ts); each carries its 1-based spec bit number, since bit N is 1<<(N-1) and FF_COMB is bit 25 = 1<<24. TextFieldInit gains multiline/password/comb/maxLen; TextField gains Multiline/Password/Comb/MaxLen accessors and Field gains ReadOnly/Required, all via Field.setFlag. GOTCHA: Field.ff is a walk-time snapshot that GenerateAppearance reads, so setFlag must update ff AND the dict. Password masking lives in generateFieldAppearance (one WinAnsi bullet 0x95 per code point, serialized as octal \\\\225), so GenerateAppearances and FlattenForm mask too -- flattening previously baked plaintext into page content. Comb requires MaxLen>0 and is rejected with multiline/password from both the init and the setters. Spec: docs/superpowers/specs/2026-07-27-text-field-flags-design.md"

git add .beads/
git commit -m "chore(bd): close dbpr.2 (text field creation + flags)"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **`serializeString` escapes bytes above 126 as octal.** A bullet (`0x95`) is
  therefore the four characters `\225` in an `/AP` content stream, not a raw
  byte. Assertions match on that string.
- **Do not mask at the creation call sites.** The whole point of putting it in
  `generateFieldAppearance` is that `Form.GenerateAppearances()` and
  `FlattenForm()` route through the same function, so documents we did not
  author get the fix.
- **`setFlag` always writes `/Ff`, even when the value is `0`.** An explicit
  `/Ff 0` overrides a value inherited from a parent field; deleting the key
  would silently re-inherit it.
- **`Number.isInteger(NaN)` is `false`**, so the integer check catches `NaN`
  without a separate guard.
- **`MaxLen` has no flag bit.** It is a plain `/MaxLen` integer, so its setter
  regenerates the appearance directly instead of going through `setFlag`.
