# HTML Form Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn AcroForm widgets into real fillable HTML controls in `ToHtml({ mode: 'fixed', forms: true })`, with the converted widgets' painted appearances suppressed so nothing is drawn twice.

**Architecture:** A new pure module `htmlforms.ts` maps fields to markup and reports which widget dicts it claimed; that set is threaded into `interpret` (vector sink and spans) and into `raster.ts` (both backdrops), which is the whole double-draw defence.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-18-html-form-controls-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every relative import carries the `.js` extension.
- **`forms` absent must be byte-identical to today**, in all three backdrops. Task 6 is the fence.
- **`htmlforms.ts` is pure.** No renderer, no sink, no content stream, no ink. It may read the `Document` object graph. If you find yourself importing `pagerender.ts` or `svgrender.ts` there, stop — the shape is wrong.
- **`page.ToImage` and `ImageOptions` do not change.** New rasterizer capability goes on the internal entry.
- **The spec says `choiceEntries`; that function does not exist.** The real API is `parseOptions(doc, fieldDict): NormalizedOption[]` and `displayOf(o): string`, both in `choiceopt.ts`. `CLAUDE.md` also names `choiceEntries` and is stale — Task 7 fixes it.
- Run `npm run typecheck` and `npm test` before closing. Target one file with `npx vitest run test/<name>.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/formfield.ts` (modify) | `widgets()` becomes a public `Widgets` accessor. |
| `src/htmlforms.ts` (create) | The whole mapping: field → markup, plus the claimed-widget set. Pure. |
| `src/pagerender.ts` (modify) | `InterpretOptions.hideWidgets`; `drawAnnots` skips them. |
| `src/raster.ts` (modify) | `renderPageBackdropToPng`; the two existing exports become wrappers. |
| `src/html.ts` (modify) | `HtmlOptions.forms`; the `mode: 'semantic'` refusal; control CSS. |
| `src/htmlfixed.ts` (modify) | Calls `pageFormControls`, threads the set, emits the `<form>` envelope. |
| `test/html-forms.test.ts` (create) | The mapping, per field type, over `buildFormPdf()`. |
| `test/html-forms-suppress.test.ts` (create) | The double-draw guards, including the `backdrop: 'page'` pixel probe. |
| `test/html.test.ts` (modify) | The byte-identity fence and the `semantic` refusal. |

**Fixture note:** `test/helpers/build-form-pdf.ts`'s `buildFormPdf()` already
supplies a text field (`name`, `/V (Bob)`), a checkbox (`agree`), a radio group
(`color`, two kid widgets), two choice fields (`size` with plain `/Opt`, `tags`
with an `[export, display]` pair), a combo (`font`) and a signature (`sig`).
Task 4 adds a small separate fixture for push buttons, which it lacks.

---

### Task 1: `Field.Widgets`

**Files:**
- Modify: `src/formfield.ts` (`protected widgets()` at ~83)

**Interfaces:**
- Produces, relied on by Task 2: `Field.Widgets: PdfDict[]` (getter).

- [ ] **Step 1: Implement**

In `src/formfield.ts`, replace the `protected widgets()` method's declaration
line with a public getter, keeping the body and doc comment exactly as they are:

```ts
  /** The field's widget annotations: a merged field/widget dict is its own
   *  widget; otherwise the resolved dict entries of /Kids.
   *
   *  Public because `htmlforms.ts` needs each widget's own /Rect and /AP, and a
   *  second copy of this rule is how two readers come to disagree about one
   *  document — `CLAUDE.md` records that terminal-ness cannot be read off
   *  /Kids alone. */
  get Widgets(): PdfDict[] {
```

Then update every in-file caller from `this.widgets()` to `this.Widgets`:

```bash
grep -n "widgets()" src/*.ts
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck` — no output, exit 0. A missed call site is a compile
error.
Run: `npx vitest run test/form.test.ts test/formfield.test.ts` (use
`ls test/ | grep -i "form"` to find the actual set) — PASS unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/formfield.ts
git commit -m "$(cat <<'EOF'
refactor(formfield): expose Field.Widgets

htmlforms.ts needs each widget's own /Rect and /AP. Made public rather than
re-derived there: "a merged field/widget dict is its own widget, otherwise
/Kids" is a rule CLAUDE.md already records as easy to get wrong, and two copies
disagree eventually.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `htmlforms.ts` — geometry, styling and the input-like fields

**Files:**
- Create: `src/htmlforms.ts`
- Create: `test/html-forms.test.ts`

**Interfaces:**
- Consumes: `Field.Widgets` (Task 1); `resolveDA(doc, fieldDict, acroForm): ResolvedDA` from `da.ts` (`{ fontName, std, size, color }`); `parseOptions(doc, fieldDict): NormalizedOption[]` and `displayOf(o)` from `choiceopt.ts`; `escapeHtml` from `html.ts`.
- Produces, relied on by Tasks 3 and 4:
  - `pageFormControls(doc, page, form, nextTabIndex): { html: string; converted: Set<PdfDict>; submits: boolean }`

- [ ] **Step 1: Write the failing test**

Create `test/html-forms.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { pageFormControls } from '../src/htmlforms.js';

/** The controls for page 1 of the standard form fixture. */
function controls(): string {
  const doc = Document.Open(buildFormPdf());
  let n = 0;
  return pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n).html;
}

describe('pageFormControls — text', () => {
  it('emits an input carrying the field name and value', () => {
    const html = controls();
    expect(html).toContain('type="text"');
    expect(html).toContain('name="name"');
    expect(html).toContain('value="Bob"');
  });

  it('positions it absolutely, in points, from /Rect', () => {
    // Fixed mode places everything in pt; a control that is not positioned
    // lands at the top of the page rather than on its field.
    expect(controls()).toMatch(/left:[\d.]+pt;top:[\d.]+pt;width:[\d.]+pt;height:[\d.]+pt/);
  });
});

describe('pageFormControls — checkbox and radio', () => {
  it('emits a checkbox whose value is its export name', () => {
    // NOT "on": the export name is what /V carries, and a checkbox posting the
    // wrong token is a form that submits a value the PDF never had.
    const html = controls();
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="agree"');
  });

  it('emits one radio per widget, sharing the field name', () => {
    // The `color` field has two kid widgets.
    const radios = controls().match(/type="radio"/g) ?? [];
    expect(radios).toHaveLength(2);
    expect((controls().match(/name="color"/g) ?? []).length).toBe(2);
  });

  it('takes each radio value from that widget\'s own /AP /N key', () => {
    // Not synthOnState, which GUESSES an on-state for documents we did not
    // author by reading /AS, /Opt, /V and finally 'Yes'. Here the widget's own
    // appearance dictionary states it.
    const html = controls();
    expect(html).toContain('value="Red"');
    expect(html).not.toContain('value="Off"');
  });
});

describe('pageFormControls — choice', () => {
  it('emits a select with one option per entry', () => {
    const html = controls();
    expect(html).toContain('<select');
    expect(html).toContain('name="size"');
    expect(html).toContain('<option value="M" selected>M</option>');
  });

  it('splits an [export, display] entry into value and text', () => {
    // CLAUDE.md's invariant: /V holds the EXPORT and the display is what is
    // drawn. Every consumer that kept only one half got it wrong — a list box
    // that highlights nothing, a combo that draws the export value.
    // The `tags` field's /Opt is [[(a) (Alpha)] (b) (c)].
    expect(controls()).toContain('<option value="a">Alpha</option>');
  });
});

describe('pageFormControls — styling', () => {
  it('takes font size and colour from /DA', () => {
    expect(controls()).toMatch(/font-size:[\d.]+pt/);
  });
});

describe('pageFormControls — the claimed set', () => {
  it('reports every widget it converted', () => {
    const doc = Document.Open(buildFormPdf());
    let n = 0;
    const { converted } = pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n);
    // Every control emitted claims exactly one widget; the count is what the
    // suppression pass will hide.
    expect(converted.size).toBeGreaterThan(0);
  });

  it('gives each control a tabindex from the injected counter', () => {
    expect(controls()).toContain('tabindex="1"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-forms.test.ts`
Expected: FAIL — cannot resolve `../src/htmlforms.js`.

- [ ] **Step 3: Implement**

Create `src/htmlforms.ts`:

```ts
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { Form } from './form.js';
import type { Field } from './formfield.js';
import { TextField } from './formfield.js';
import { isArray, isDict, isName, isNumber, type PdfDict } from './types.js';
import { resolveDA } from './da.js';
import { parseOptions, displayOf } from './choiceopt.js';
import { escapeHtml } from './html.js';

/** What one page's fields became.
 *
 *  `converted` is the double-draw defence: every widget in it must be hidden
 *  from the page render, or its painted appearance shows through behind the
 *  control and its value arrives twice. */
export interface PageFormControls {
  html: string;
  converted: Set<PdfDict>;
  /** True when a submit or reset button was converted — the caller needs it to
   *  decide whether to emit the document's `<form>` envelope. */
  submits: boolean;
}

/** A widget's /Rect as [x0, y0, x1, y1], normalized; undefined when absent. */
function rectOf(doc: Document, w: PdfDict): [number, number, number, number] | undefined {
  const r = doc.resolve(w.get('Rect'));
  if (!isArray(r) || r.length < 4) return undefined;
  const v = r.map((e) => { const n = doc.resolve(e); return isNumber(n) ? n : NaN; });
  if (v.some((n) => !Number.isFinite(n))) return undefined;
  return [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
}

/** A /MK colour array as a CSS colour; undefined when absent or unusable.
 *  1 component is gray, 3 RGB, 4 CMYK (32000-1 12.5.6.19). */
function mkColor(doc: Document, mk: PdfDict | undefined, key: string): string | undefined {
  if (!mk) return undefined;
  const a = doc.resolve(mk.get(key));
  if (!isArray(a) || a.length === 0) return undefined;
  const v = a.map((e) => { const n = doc.resolve(e); return isNumber(n) ? n : 0; });
  const to255 = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  let rgb: [number, number, number];
  if (v.length === 1) rgb = [to255(v[0]), to255(v[0]), to255(v[0])];
  else if (v.length === 3) rgb = [to255(v[0]), to255(v[1]), to255(v[2])];
  else if (v.length === 4) rgb = [
    to255((1 - v[0]) * (1 - v[3])), to255((1 - v[1]) * (1 - v[3])), to255((1 - v[2]) * (1 - v[3])),
  ];
  else return undefined;
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** The inline style for one widget: position from /Rect, chrome from /MK+/BS,
 *  type from /DA.
 *
 *  **Invariant:** a /DA size of 0 means AUTO-SIZE and must never become
 *  `font-size:0`, which renders an invisible value. The widget's height less
 *  its padding is what the PDF's own appearance generator uses. */
function styleFor(
  doc: Document, field: Field, w: PdfDict, acro: PdfDict, pageHeight: number,
): string {
  const r = rectOf(doc, w);
  if (!r) return '';
  const [x0, y0, x1, y1] = r;
  const width = x1 - x0, height = y1 - y0;
  // CSS y runs down from the page top; PDF y runs up from the bottom.
  const parts = [
    `left:${fmtPt(x0)}pt`, `top:${fmtPt(pageHeight - y1)}pt`,
    `width:${fmtPt(width)}pt`, `height:${fmtPt(height)}pt`,
  ];

  const mk = doc.resolve(w.get('MK'));
  const border = mkColor(doc, isDict(mk) ? mk : undefined, 'BC');
  const bg = mkColor(doc, isDict(mk) ? mk : undefined, 'BG');
  if (border) {
    const bs = doc.resolve(w.get('BS'));
    const bw = isDict(bs) ? doc.resolve(bs.get('W')) : undefined;
    parts.push(`border:${isNumber(bw) ? fmtPt(bw) : 1}pt solid ${border}`);
  } else parts.push('border:none');
  if (bg) parts.push(`background:${bg}`);

  const da = resolveDA(doc, field.Dict, acro);
  // Auto-size: the appearance generator fits the value to the box, so the box
  // height less a little padding is the closest single number.
  const size = da.size > 0 ? da.size : Math.max(4, height * 0.66);
  parts.push(`font-size:${fmtPt(size)}pt`);
  parts.push(`color:rgb(${da.color.map((c) => Math.round(c * 255)).join(',')})`);
  return parts.join(';');
}

/** Trim a number for CSS, as svgrender's `fmt` does for markup. */
function fmtPt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** The widget's on-state: the /AP /N key that is not Off.
 *
 *  **Invariant:** never `synthOnState`. That helper guesses for documents we did
 *  not author — /AS, then /Opt[i], then /V, then 'Yes' — and every one of its
 *  inputs reads `Off` for an unchecked box with a custom export value. The
 *  widget in front of us states its own on-state in its appearance dictionary. */
function onState(doc: Document, w: PdfDict): string | undefined {
  const ap = doc.resolve(w.get('AP'));
  if (!isDict(ap)) return undefined;
  const n = doc.resolve(ap.get('N'));
  if (!isDict(n)) return undefined;
  for (const k of n.keys()) if (k !== 'Off') return k;
  return undefined;
}

/** True when this widget is currently on (its /AS, else the field's /V). */
function isOn(doc: Document, w: PdfDict, state: string, value: unknown): boolean {
  const as = doc.resolve(w.get('AS'));
  if (isName(as)) return as.name === state;
  return value === state;
}

const ATTR = (name: string, v: string | undefined) =>
  v === undefined ? '' : ` ${name}="${escapeHtml(v)}"`;

/** Every control for one page, plus the widgets they claim. */
export function pageFormControls(
  doc: Document, page: Page, form: Form, nextTabIndex: () => number,
): PageFormControls {
  const converted = new Set<PdfDict>();
  const out: string[] = [];
  let submits = false;
  const acro = form.Dict;
  const [, , , pageTop] = page.CropBox;
  const pageHeight = pageTop;

  for (const field of form.Fields) {
    for (const w of field.Widgets) {
      if (!onThisPage(doc, page, w)) continue;
      try {
        const emitted = controlFor(doc, field, w, acro, pageHeight, nextTabIndex);
        if (!emitted) continue;
        out.push(emitted.html);
        converted.add(w);
        if (emitted.submits) submits = true;
      } catch {
        // **Invariant:** a field that will not convert is NOT claimed, so its
        // /AP still renders. Never leave a hole where content used to be.
      }
    }
  }
  return { html: out.join(''), converted, submits };
}
```

Then implement the two remaining private functions in the same file:

```ts
/** True when `w` is in `page`'s /Annots. A field's widgets may sit on several
 *  pages, so this is per widget rather than per field. */
function onThisPage(doc: Document, page: Page, w: PdfDict): boolean {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return false;
  for (const e of annots) if (doc.resolve(e) === w) return true;
  return false;
}

/** One widget's control, or undefined when this field type does not convert. */
function controlFor(
  doc: Document, field: Field, w: PdfDict, acro: PdfDict,
  pageHeight: number, nextTabIndex: () => number,
): { html: string; submits: boolean } | undefined {
  const style = styleFor(doc, field, w, acro, pageHeight);
  if (!style) return undefined;                    // no /Rect: nowhere to put it
  const tab = ` tabindex="${nextTabIndex()}"`;
  const name = ATTR('name', field.FullName);
  const ro = field.ReadOnly ? ' readonly' : '';
  const req = field.Required ? ' required' : '';
  const s = ` style="${style}"`;

  if (field.Type === 'text') {
    const tf = field as TextField;
    const v = typeof field.Value === 'string' ? field.Value : '';
    if (tf.Multiline)
      return { html: `<textarea${name}${s}${tab}${ro}${req}>${escapeHtml(v)}</textarea>`, submits: false };
    const type = tf.Password ? 'password' : 'text';
    const max = tf.MaxLen > 0 ? ` maxlength="${tf.MaxLen}"` : '';
    return {
      html: `<input type="${type}"${name}${ATTR('value', v)}${max}${s}${tab}${ro}${req}>`,
      submits: false,
    };
  }

  if (field.Type === 'checkbox' || field.Type === 'radio') {
    const state = onState(doc, w);
    if (state === undefined) return undefined;
    const type = field.Type === 'checkbox' ? 'checkbox' : 'radio';
    const on = isOn(doc, w, state, field.Value) ? ' checked' : '';
    const dis = field.ReadOnly ? ' disabled' : '';
    return {
      html: `<input type="${type}"${name}${ATTR('value', state)}${on}${s}${tab}${dis}${req}>`,
      submits: false,
    };
  }

  if (field.Type === 'choice') {
    const opts = parseOptions(doc, field.Dict);
    const v = field.Value;
    const chosen = new Set(Array.isArray(v) ? v : typeof v === 'string' ? [v] : []);
    const options = opts.map((o) =>
      `<option value="${escapeHtml(o.export)}"${chosen.has(o.export) ? ' selected' : ''}>`
      + `${escapeHtml(displayOf(o))}</option>`).join('');
    const dis = field.ReadOnly ? ' disabled' : '';
    return { html: `<select${name}${s}${tab}${dis}${req}>${options}</select>`, submits: false };
  }

  return undefined;   // pushbutton and signature: Task 3
}
```

Add the `Form.Dict` accessor if `form.Dict` does not exist — check with
`grep -n "Dict" src/form.ts`. If the `/AcroForm` dict is private there, expose it
as a readonly property the same way `Field.Dict` is exposed, with a one-line doc
comment saying `htmlforms.ts` needs it for `resolveDA`'s fallback.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/html-forms.test.ts`
Expected: PASS, 9 tests.

Two likely adjustments, neither of which is a reason to weaken an assertion:
- If `page.CropBox` is not a 4-number array on `Page`, get the page height from
  `baseMatrix(page, 'crop')` in `pagerender.ts`, which `htmlfixed.ts` already
  uses and which returns `{ width, height }`. Prefer that if it is available —
  it is the same number fixed mode positions everything else against.
- If the `tags` option assertion fails on ordering, print the emitted `<select>`
  and confirm `/Opt`'s pair shape parsed as `{ export: 'a', display: 'Alpha' }`
  before touching the expectation.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/htmlforms.ts test/html-forms.test.ts
git commit -m "$(cat <<'EOF'
feat(htmlforms): map text, checkbox, radio and choice fields to controls

A pure module: fields in, markup plus the set of widget dicts it claimed out.
No renderer, no sink, no ink — the split svgdraw/svgembed already make.

/Opt goes through parseOptions + displayOf, so an [export, display] entry keeps
both halves; a radio's value comes from its own /AP /N key rather than
synthOnState, which guesses for documents we did not author.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Push buttons, signatures and the form envelope

**Files:**
- Modify: `src/htmlforms.ts`
- Modify: `test/html-forms.test.ts` (append)
- Create: `test/helpers/build-form-buttons-pdf.ts`

**Interfaces:**
- Consumes: `parseAction(doc, annot): PdfAction | undefined` from `actions.js` (`SubmitAction = { type: 'submit'; url: string; format?: 'fdf'|'html'|'xfdf'|'pdf' }`, `ResetAction = { type: 'reset' }`); `parsePdfDate(s): Date | string` from `metadata.js`.
- Produces: `formEnvelope(doc, form): { action: string; method: string } | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/helpers/build-form-buttons-pdf.ts` modelled on
`test/helpers/build-form-pdf.ts` — read that file first and copy its object
layout and `serialize` usage. It must produce one page whose `/Annots` holds
three widgets, all `/FT /Btn` with `/Ff 65536` (push button):

- `submit`, `/A << /S /SubmitForm /F (https://example.com/post) >>`
- `reset`, `/A << /S /ResetForm >>`
- `plain`, no `/A` at all

Each needs a `/Rect` and an `/AP /N` stream so the unconverted one has an
appearance to keep.

Append to `test/html-forms.test.ts`:

```ts
import { buildFormButtonsPdf } from './helpers/build-form-buttons-pdf.js';

describe('pageFormControls — push buttons', () => {
  const buttons = () => {
    const doc = Document.Open(buildFormButtonsPdf());
    let n = 0;
    return pageFormControls(doc, doc.Pages[0], doc.Form, () => ++n);
  };

  it('converts a SubmitForm button to type=submit', () => {
    expect(buttons().html).toContain('type="submit"');
  });

  it('converts a ResetForm button to type=reset', () => {
    expect(buttons().html).toContain('type="reset"');
  });

  it('leaves a plain push button alone, appearance and all', () => {
    // Only submit and reset have an HTML meaning. A button whose action is a
    // JavaScript call or nothing at all would become a control that does
    // nothing, so it stays a picture — and must NOT be claimed, or its
    // appearance is suppressed and the page loses it entirely.
    const { html, converted } = buttons();
    expect(html).not.toContain('name="plain"');
    expect(converted.size).toBe(2);
  });

  it('reports that it converted a submit', () => {
    expect(buttons().submits).toBe(true);
  });
});

describe('pageFormControls — signature', () => {
  it('emits a disabled input with an aria-label', () => {
    // Disabled on purpose: a signature cannot be produced in a browser, so the
    // control takes part in tab order and is announced, and promises nothing.
    const html = controls();
    expect(html).toMatch(/<input[^>]*disabled[^>]*aria-label="[^"]*[Ss]ignature/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-forms.test.ts`
Expected: FAIL — the button cases find no `type="submit"`, and the signature
case no `aria-label`.

- [ ] **Step 3: Implement**

In `src/htmlforms.ts`, add the imports:

```ts
import { parseAction } from './actions.js';
import { parsePdfDate } from './metadata.js';
import { isString } from './types.js';
```

Replace `controlFor`'s final `return undefined;` with the two remaining cases:

```ts
  if (field.Type === 'pushbutton') {
    // Only submit and reset mean anything in HTML. Any other push button — a
    // JavaScript action, or none — would become a control that does nothing, so
    // it keeps its appearance and is deliberately NOT claimed.
    const a = parseAction(doc, w);
    if (!a || (a.type !== 'submit' && a.type !== 'reset')) return undefined;
    const caption = captionOf(doc, w) ?? (a.type === 'submit' ? 'Submit' : 'Reset');
    return {
      html: `<button type="${a.type}"${name}${s}${tab}>${escapeHtml(caption)}</button>`,
      submits: true,
    };
  }

  if (field.Type === 'signature') {
    // Converted, unlike Go, which leaves it painted — but DISABLED, because a
    // signature cannot be produced in a browser. It carries what the document
    // CLAIMS (/V /Name and /V /M), never a verification result: running
    // sigverify here would make an HTML export depend on trust stores and
    // network-fetched revocation data.
    const sig = doc.resolve(field.Dict.get('V'));
    let label = `Unsigned signature field: ${field.FullName}`;
    let value: string | undefined;
    if (isDict(sig)) {
      const who = doc.resolve(sig.get('Name'));
      const when = doc.resolve(sig.get('M'));
      const parts: string[] = [];
      if (isString(who)) parts.push(new TextDecoder('latin1').decode(who.bytes));
      if (isString(when)) {
        const d = parsePdfDate(new TextDecoder('latin1').decode(when.bytes));
        parts.push(d instanceof Date ? d.toISOString().slice(0, 10) : d);
      }
      value = parts.join(', ');
      label = `Signature field: ${field.FullName}`;
    }
    return {
      html: `<input type="text" disabled${name}${ATTR('value', value)}`
        + `${ATTR('aria-label', label)}${s}${tab}>`,
      submits: false,
    };
  }

  return undefined;
```

Add the caption reader and the envelope:

```ts
/** A push button's caption: /MK /CA. */
function captionOf(doc: Document, w: PdfDict): string | undefined {
  const mk = doc.resolve(w.get('MK'));
  if (!isDict(mk)) return undefined;
  const ca = doc.resolve(mk.get('CA'));
  return isString(ca) ? new TextDecoder('latin1').decode(ca.bytes) : undefined;
}

/** The document `<form>`'s action and method, from the first SubmitForm action
 *  found on any push button.
 *
 *  One form for the whole document, not one per page: an AcroForm is
 *  document-scoped and a field's widgets may sit on different pages, so
 *  per-page forms would each submit a fragment of the field set. */
export function formEnvelope(
  doc: Document, form: Form,
): { action: string; method: string } | undefined {
  for (const field of form.Fields) {
    if (field.Type !== 'pushbutton') continue;
    for (const w of field.Widgets) {
      const a = parseAction(doc, w);
      // 'html' is the only /Flags format a browser can post natively; the
      // others (FDF, XFDF, PDF) name a wire format only a PDF client produces.
      if (a?.type === 'submit') return { action: a.url, method: 'post' };
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/html-forms.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/htmlforms.ts test/html-forms.test.ts test/helpers/build-form-buttons-pdf.ts
git commit -m "$(cat <<'EOF'
feat(htmlforms): push buttons, signature fields and the form envelope

A push button converts only when /A parses as SubmitForm or ResetForm; any
other keeps its appearance and is deliberately not claimed, so suppression
cannot erase it. A signature becomes a DISABLED input carrying /V /Name and
/V /M — what the document claims, never a verification result, which would
make an HTML export depend on trust stores.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Widget suppression through both renderers

**Files:**
- Modify: `src/pagerender.ts` (`InterpretOptions` at 368, `drawAnnots` at ~389, `interpret` at 376)
- Modify: `src/raster.ts` (`renderPage` and its two exports)
- Create: `test/html-forms-suppress.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces, relied on by Task 5:
  - `InterpretOptions.hideWidgets?: ReadonlySet<PdfDict>`
  - `renderPageBackdropToPng(doc, page, opts, o: { skipGlyphs: boolean; hideWidgets?: ReadonlySet<PdfDict> }): Uint8Array`

- [ ] **Step 1: Write the failing test**

Create `test/html-forms-suppress.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { interpret, baseMatrix } from '../src/pagerender.js';
import { SvgSink } from '../src/svgrender.js';

/** The SVG a page renders to, with `hide` suppressed. */
function svgWith(hide?: ReadonlySet<object>): string {
  const doc = Document.Open(buildFormPdf());
  const page = doc.Pages[0];
  const { matrix, width, height } = baseMatrix(page, 'crop');
  const sink = new SvgSink(doc);
  interpret(doc, page, matrix, sink, { hideWidgets: hide as never });
  return sink.finish(width, height);
}

describe('InterpretOptions.hideWidgets', () => {
  it('draws every widget when nothing is hidden', () => {
    expect(svgWith().length).toBeGreaterThan(0);
  });

  it('drops a hidden widget\'s appearance', () => {
    // The whole double-draw defence: a converted widget must contribute no ink,
    // or its painted value sits behind the control showing the same text.
    const doc = Document.Open(buildFormPdf());
    const page = doc.Pages[0];
    const widget = doc.Form.Fields.find((f) => f.Name === 'name')!.Widgets[0];
    const before = svgWith();
    const after = svgWith(new Set([widget]));
    expect(after.length).toBeLessThan(before.length);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-forms-suppress.test.ts`
Expected: FAIL — `hideWidgets` is not a known property of `InterpretOptions`
(a typecheck error), and the two renders are the same length.

- [ ] **Step 3: Implement**

In `src/pagerender.ts`, extend `InterpretOptions`:

```ts
export interface InterpretOptions {
  /** Composite annotation /AP appearances after the page content. Default true. */
  annotations?: boolean;
  /** Widget dicts whose appearance must NOT be composited.
   *
   *  For `htmlfixed.ts`'s `forms: true`: a widget that became a real HTML
   *  control must contribute no ink, or its painted value sits behind the
   *  control showing the same text. Per WIDGET rather than per page, because a
   *  field that failed to convert keeps its appearance. */
  hideWidgets?: ReadonlySet<PdfDict>;
}
```

Thread it into `drawAnnots` — change the call at 381 and the signature, and add
the skip:

```ts
  if (opts.annotations !== false) drawAnnots(ctx, page, base, opts.hideWidgets);
```

```ts
function drawAnnots(
  ctx: RenderCtx, page: Page, base: Matrix, hide?: ReadonlySet<PdfDict>,
): void {
  const annots = ctx.doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return;
  for (const e of annots) {
    const annot = ctx.doc.resolve(e);
    if (!isDict(annot) || !isAnnotVisible(ctx.doc, annot)) continue;
    if (hide?.has(annot)) continue;
    // ... rest unchanged ...
```

In `src/raster.ts`, generalize the private worker and re-point the exports:

```ts
/** Options the HTML backdrop needs and `ImageOptions` deliberately does not
 *  carry, since `page.ToImage` exposes neither. */
export interface BackdropOptions {
  /** Suppress every glyph run (see `renderPageGraphicsToPng`). */
  skipGlyphs: boolean;
  /** Widget appearances to leave undrawn (see `InterpretOptions.hideWidgets`). */
  hideWidgets?: ReadonlySet<PdfDict>;
}

function renderPage(
  doc: Document, page: Page, opts: ImageOptions, o: BackdropOptions,
): Uint8Array {
  // ... body unchanged, except these two lines ...
  const sink = new RasterSink(doc, canvas, o.skipGlyphs);
  try {
    interpret(doc, page, device, sink,
      { annotations: opts.annotations, hideWidgets: o.hideWidgets });
  } catch { /* unchanged */ }
  // ...
}

export function renderPageToPng(
  doc: Document, page: Page, opts: ImageOptions = {}): Uint8Array {
  return renderPage(doc, page, opts, { skipGlyphs: false });
}

export function renderPageGraphicsToPng(
  doc: Document, page: Page, opts: ImageOptions = {}): Uint8Array {
  return renderPage(doc, page, opts, { skipGlyphs: true });
}

/** The backdrop entry `htmlfixed.ts` uses for BOTH raster kinds — the one place
 *  that can hide converted form widgets from a rendered page. */
export function renderPageBackdropToPng(
  doc: Document, page: Page, opts: ImageOptions, o: BackdropOptions,
): Uint8Array {
  return renderPage(doc, page, opts, o);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/html-forms-suppress.test.ts`
Expected: PASS, 2 tests.

Run: `npx vitest run test/html-raster-backdrop.test.ts`
Expected: PASS, 13 tests — the kf8h.2 behaviour is unchanged by the
generalization.

- [ ] **Step 5: Commit**

```bash
git add src/pagerender.ts src/raster.ts test/html-forms-suppress.test.ts
git commit -m "$(cat <<'EOF'
feat(render): hideWidgets, through interpret and the raster backdrop

One suppression set reaches both sinks: drawAnnots skips a hidden widget, which
also stops its /AP glyphs reaching HtmlSink's span layer, and
renderPageBackdropToPng carries the same set into a rendered page so
backdrop:'page' can host controls too — where Go declines.

Per widget, not per page: a field that fails to convert keeps its appearance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire `forms` into fixed mode

**Files:**
- Modify: `src/html.ts` (`HtmlOptions`, `FIXED_CSS`, `render`)
- Modify: `src/htmlfixed.ts` (`fixedBody`)
- Modify: `test/html-forms-suppress.test.ts` (append)

**Interfaces:**
- Consumes: everything from Tasks 2–4.
- Produces: `HtmlOptions.forms`.

- [ ] **Step 1: Write the failing test**

Append to `test/html-forms-suppress.test.ts`:

```ts
describe('ToHtml({ forms: true })', () => {
  const withForms = (extra = {}) =>
    Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed', forms: true, ...extra });

  it('emits the controls', () => {
    expect(withForms()).toContain('type="text"');
  });

  it("does not also paint the field's value", () => {
    // THE guard. The text field's value is Bob; it must appear once, in the
    // control, and never as a <span> from the widget's own appearance. A test
    // that only checked the control exists would pass with the appearance still
    // drawn behind it.
    const html = withForms();
    expect(html).toContain('value="Bob"');
    expect(html).not.toMatch(/<span[^>]*>[^<]*Bob/);
  });

  it('emits no controls without the option', () => {
    expect(Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed' }))
      .not.toContain('type="text"');
  });

  it('refuses semantic mode rather than ignoring the option', () => {
    expect(() => Document.Open(buildFormPdf()).ToHtml({ mode: 'semantic', forms: true }))
      .toThrow(/forms/);
  });

  it('works with a raster backdrop', () => {
    expect(withForms({ backdrop: 'raster' })).toContain('type="text"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/html-forms-suppress.test.ts`
Expected: FAIL — `forms` is not a known property of `HtmlOptions`.

- [ ] **Step 3: Add the option and the refusal**

In `src/html.ts`, add to `HtmlOptions` after `backdropScale`:

```ts
  /** Turn AcroForm fields into real fillable HTML controls. Default false.
   *
   *  `fixed` mode only — reflowable output has no widget geometry to place a
   *  control at, so `semantic` with this set THROWS rather than silently
   *  ignoring it. Works with every `backdrop`: the converted widgets are
   *  suppressed from whichever backdrop is rendered, so nothing is drawn twice. */
  forms?: boolean;
```

Extend `FIXED_CSS`:

```ts
  // Controls sit above the backdrop and the text. box-sizing so the /Rect is
  // the OUTER box, which is what the PDF's rect means; the border would
  // otherwise grow the control past its field.
  '.pg>input,.pg>textarea,.pg>select,.pg>button'
    + '{position:absolute;box-sizing:border-box;margin:0;font-family:inherit}',
```

In `render` (or `bodyFor`, whichever receives `opts` before dispatching on
`mode` — read the file), refuse the bad combination before anything renders:

```ts
  if (opts.forms && (opts.mode ?? 'semantic') !== 'fixed')
    throw new TypeError("forms: true requires mode: 'fixed'");
```

- [ ] **Step 4: Wire `fixedBody`**

In `src/htmlfixed.ts`, add the imports:

```ts
import { pageFormControls, formEnvelope } from './htmlforms.js';
import { renderPageBackdropToPng } from './raster.js';
```

and drop the `renderPageGraphicsToPng` import, which the new entry replaces.

In `fixedBody`, before the page loop:

```ts
  // Tab order runs across the document, so the counter is shared by every page.
  let tabIndex = 0;
  const nextTabIndex = () => ++tabIndex;
  let anySubmit = false;
```

Inside the loop, before `interpret` runs — the pass needs the suppression set
first:

```ts
    const fc = opts.forms
      ? pageFormControls(doc, page, doc.Form, nextTabIndex)
      : undefined;
    if (fc?.submits) anySubmit = true;
```

Pass the set to `interpret`:

```ts
      interpret(doc, page, matrix, sink,
        { annotations: opts.annotations, hideWidgets: fc?.converted });
```

Replace the backdrop render so both kinds go through the new entry and carry the
set:

```ts
        const png = renderPageBackdropToPng(doc, page, img,
          { skipGlyphs: kind === 'raster', hideWidgets: fc?.converted });
```

Append the controls after the spans, so they stack above both layers:

```ts
    divs.push(`<div class="pg${sel}" style="width:${fmt(width)}px;height:${fmt(height)}px">`
      + (backdrop || sink.svgLayer(width, height)) + sink.spanLayer()
      + (fc?.html ?? '') + `</div>`);
```

And after the loop, wrap in the envelope when a submit was converted:

```ts
  let body = divs.join('\n');
  if (opts.forms && anySubmit) {
    const env = formEnvelope(doc, doc.Form);
    if (env)
      body = `<form action="${escapeHtml(env.action)}" method="${env.method}">\n`
        + `${body}\n</form>`;
  }
  return { body, css: fonts.css() + (embed?.css() ?? '') };
```

`escapeHtml` comes from `./html.js`, which `htmlfixed.ts` already imports.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/html-forms-suppress.test.ts`
Expected: PASS, 7 tests.

Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/html.ts src/htmlfixed.ts test/html-forms-suppress.test.ts
git commit -m "$(cat <<'EOF'
feat(html): forms:true — fillable controls in fixed mode (kf8h.1)

Controls are emitted after the spans so they stack above both layers, and the
widgets they claim are suppressed from whichever backdrop is rendered. A
document-level <form> wraps the pages only when a submit button was converted.

semantic + forms throws rather than silently ignoring one of two explicitly
requested options.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The fence, the pixel probe, and proving suppression load-bearing

**Files:**
- Modify: `test/html.test.ts` (append)
- Modify: `test/html-forms-suppress.test.ts` (append)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the fence**

Append to `test/html.test.ts`:

```ts
describe('forms is additive (kf8h.1)', () => {
  it('omitting forms is byte-identical to passing false', () => {
    // The fence: an existing caller's output must not move.
    const a = Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed' });
    const b = Document.Open(buildFormPdf()).ToHtml({ mode: 'fixed', forms: false });
    expect(a).toBe(b);
  });
});
```

Add `import { buildFormPdf } from './helpers/build-form-pdf.js';` to that file's
imports if it is not already there.

- [ ] **Step 2: The backdrop:'page' probe**

Append to `test/html-forms-suppress.test.ts`:

```ts
import { decodePng } from './helpers/decode-png.js';

describe("forms with backdrop: 'page'", () => {
  it('emits the control and keeps the field value out of the raster', () => {
    // Go refuses this combination outright, because its faithful raster has the
    // widget baked in. Ours does not: the same suppression set reaches the
    // rasterizer, so the value appears once — in the control.
    //
    // The pixel probe is the only assertion that can see into a baked backdrop;
    // asserting the control exists would pass with the value still painted.
    const doc = Document.Open(buildFormPdf());
    const html = doc.ToHtml({ mode: 'fixed', forms: true, backdrop: 'page', backdropScale: 1 });
    expect(html).toContain('value="Bob"');

    const b64 = /<img src="data:image\/png;base64,([^"]+)"/.exec(html)![1];
    const img = decodePng(new Uint8Array(Buffer.from(b64, 'base64')));
    const w = doc.Form.Fields.find((f) => f.Name === 'name')!.Widgets[0];
    const rect = (doc.resolve(w.get('Rect')) as number[]).map(Number);
    const [, , , pageTop] = doc.Pages[0].CropBox;
    let dark = 0;
    for (let y = Math.round(pageTop - rect[3]); y < Math.round(pageTop - rect[1]); y++)
      for (let x = Math.round(rect[0]); x < Math.round(rect[2]); x++) {
        if (y < 0 || y >= img.height || x < 0 || x >= img.width) continue;
        const [r, g] = img.at(x, y);
        if (r < 128 && g < 128) dark++;
      }
    expect(dark).toBe(0);
  });
});
```

If `CropBox` is not a plain 4-array, use `baseMatrix(page, 'crop').height`, as
Task 2 notes.

- [ ] **Step 3: Prove the suppression load-bearing**

In `src/pagerender.ts`, temporarily neuter the skip:

```ts
    if (false && hide?.has(annot)) continue;   // TEMPORARY — must go red
```

Run: `npx vitest run test/html-forms-suppress.test.ts`
Expected: FAIL on "does not also paint the field's value" (the value comes back
as a `<span>`) and on the `backdrop: 'page'` probe (dark pixels inside the
field's rect).

Restore, re-run — all green — and confirm `git diff src/pagerender.ts` is empty.

- [ ] **Step 4: Full suite**

Run: `npm test`
Expected: PASS with no expectation edits. `test/html-identity.test.ts` and
`test/docx-flow-identity.test.ts` must not move.

Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add test/html.test.ts test/html-forms-suppress.test.ts
git commit -m "$(cat <<'EOF'
test(html): fence forms, and pin suppression with a pixel probe

forms absent is byte-identical to forms:false. The backdrop:'page' case is
asserted by reading pixels inside the widget's own /Rect, the only assertion
that can see into a baked backdrop.

Confirmed load-bearing: neutering drawAnnots' skip turns both the span guard
and the pixel probe red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (the HTML entry; the `choiceEntries` correction)
- Modify: `README.md` (HTML export prose, API table, limitations)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Fix the stale `choiceEntries` reference**

```bash
grep -n "choiceEntries" CLAUDE.md
```

`CLAUDE.md` names `choiceEntries` in the `form.ts`/`choiceopt.ts` bullet and in
the appearance invariants; no such function exists in `src/`. The real API is
`parseOptions(doc, fieldDict)` returning `NormalizedOption[]`, plus `displayOf`.
Replace each mention, keeping the surrounding reasoning intact — the invariant
it states is correct and only the name is wrong.

- [ ] **Step 2: Add the invariants to CLAUDE.md**

In the `html.ts`/`htmlsemantic.ts`/`htmlfixed.ts` bullet, append:

```markdown
  **Invariant:** `forms: true` converts a widget and SUPPRESSES its appearance,
  one `hideWidgets` set reaching both the vector sink and the rasterizer. A
  widget drawn behind its own control shows the field's value twice — once
  painted, once in the control — which is `tvc4`'s defect in another export.
  Suppression is per WIDGET, so a field that fails to convert (a push button
  whose `/A` is not SubmitForm/ResetForm, a widget with no `/Rect`) keeps its
  ink and is deliberately absent from `converted`.
  **Invariant:** `htmlforms.ts` is PURE — no renderer, no sink, no ink — and
  returns the markup beside the set of widgets it claimed. The set is built by
  the same pass that builds the markup rather than predicted from the field
  list, which is what makes "a field that threw keeps its appearance" true by
  construction.
  **Invariant:** a radio's `value` comes from that widget's own `/AP /N` key,
  never `synthOnState`, and a choice's options through `parseOptions` +
  `displayOf` so an `[export, display]` entry keeps both halves.
  **Note:** unlike Go, which restricts `InteractiveForms` to its two
  non-faithful modes, `forms` works with `backdrop: 'page'` — the restriction is
  a property of Go's rasterizer, not of the format, and our raster pass takes
  the same suppression set. Pinned by a pixel probe inside the widget's `/Rect`,
  the only assertion that can see into a baked backdrop.
```

- [ ] **Step 3: Update README.md**

Locate the sites (line numbers drift — confirm each):

```bash
grep -n "backdrop\` chooses what sits behind" README.md     # feature prose
grep -n "doc.ToHtml(options?)" README.md                     # API table
grep -n "HTML export\*\* — \`ToHtml\` ships both" README.md  # limitations
```

Add to the feature prose, after the `backdrop` sentences:

> `forms: true` turns AcroForm fields into real fillable controls — `<input>`,
> `<textarea>`, `<select>`, `<button type="submit">` — positioned on their
> widgets and styled from `/MK` and `/DA`, with the converted widgets'
> appearances suppressed so nothing is drawn twice. A push button converts only
> when its action is SubmitForm or ResetForm; any other keeps its picture.
> Signature fields become disabled inputs carrying the signer and date the
> document claims. It requires `mode: 'fixed'` and throws otherwise.

Add to the API table's `ToHtml` row: `` `forms: true` for fillable controls ``.

Add to the limitations bullet:

> With `forms: true`, field values are exported as control values, so a
> password field's value is present in the markup — export it only from
> documents whose field data may be published. Field-level JavaScript (`/AA`)
> is not translated, so a form with calculated or validated fields loses that
> behaviour and keeps only its values.

- [ ] **Step 4: Full verification**

Run: `npm test` — PASS.
Run: `npm run typecheck` — no output, exit 0.

- [ ] **Step 5: Commit and close**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: fillable HTML form controls, and a stale choiceEntries reference

Records why suppression is per widget, why htmlforms.ts is pure, and why the
backdrop:'page' case needs a pixel probe. Also corrects CLAUDE.md, which named
a choiceEntries function that does not exist — the API is parseOptions +
displayOf.

Notes in README that forms:true puts field values in the markup, password
fields included.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
bd close aspose-pdf-foss-for-ts-kf8h.1
```

---

## Notes for the implementer

**The fences.** `test/html.test.ts`'s two byte-identity cases (backdrop and
forms), `test/html-identity.test.ts`'s snapshot, `test/docx-flow-identity.test.ts`'s
sha256. None should move. Never run `vitest -u`.

**The one assertion that matters most** is "does not also paint the field's
value". Everything else in this feature can be right while that is wrong, and
the page will look plausible — slightly bolder text in each field, which reads
as a font issue rather than as double-drawing.

**On `Form.Dict`.** Task 2 needs the `/AcroForm` dict for `resolveDA`'s
fallback. If `form.ts` does not already expose it, add it there rather than
re-resolving `/Root /AcroForm` in `htmlforms.ts` — two readers of one dict is
how they come to disagree about `/DA` inheritance.

**Where NOT to make changes.** `page.ToImage`, `ImageOptions`, `htmlsemantic.ts`,
and `HtmlSink.glyphRun`'s span construction. If a change seems needed there, the
shape is wrong and needs re-deciding.
