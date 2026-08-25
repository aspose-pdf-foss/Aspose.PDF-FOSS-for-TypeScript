# Push Button Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Form.AddPushButton` / `Page.AddPushButton` with `/MK`
characteristics, three appearance streams (`/N`, `/R`, `/D`), an optional icon
and four `/TP` layouts — and extract the `/A` action model into a module shared
with `LinkAnnotation`.

**Architecture:** A new `src/actions.ts` owns one `PdfAction` union with
`encodeAction`/`parseAction`; `annotation.ts`'s two inline copies are deleted.
A new `src/buttonap.ts` owns push-button appearance, built from the primitives
already exported by `appearance.ts`. Creation goes through the existing
`createField` and its `buildAP` hook.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest. No runtime dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-07-27-push-button-creation-design.md`
Issue: `aspose-pdf-foss-for-ts-dbpr.5` (already claimed)
Builds on: `dbpr.1`–`dbpr.4` (through commit `74e7f63`)

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

- `buildImageXObject(data: Uint8Array, format?: 'jpeg' | 'png'): BuiltImage`
  sniffs the format from magic bytes and returns `{ stream, smask? }`. The
  `smask` must be allocated and wired as the image stream's `/SMask` when
  present, or a transparent PNG renders with a black box.
- The image's pixel dimensions are `/Width` and `/Height` on `stream.dict`.
- `mkOps(doc, widget, g)` already paints `/MK /BG` and `/BC` and returns the
  border inset. Every field type shares it.
- `createField`'s `buildAP` hook currently has signature
  `(doc: Document, dict: PdfDict) => void`. Task 4 widens it to take the
  AcroForm dict as a third parameter, which push buttons need for `resolveDA`.
- Appearance streams are uncompressed, so
  `new TextDecoder('latin1').decode(stream.raw)` gives readable content.
- `doc.pageNumberOf(obj)` maps a page ref to its 1-based number;
  `parseDest(doc, annotDict, pageOf)` reads a destination from `/Dest` **or**
  `/A /D`, which is why `parseAction` takes the annotation rather than the
  action dict.

---

### Task 1: `src/actions.ts` — the shared action model

**Files:**
- Create: `src/actions.ts`
- Test: `test/actions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type GoToAction = { type: 'goto'; page: number; view?: OutlineView }`
  - `type UriAction = { type: 'uri'; uri: string }`
  - `type SubmitAction = { type: 'submit'; url: string; fields?: string[]; exclude?: boolean; format?: 'fdf' | 'html' | 'xfdf' | 'pdf' }`
  - `type ResetAction = { type: 'reset'; fields?: string[]; exclude?: boolean }`
  - `type JavaScriptAction = { type: 'javascript'; script: string }`
  - `type PdfAction = GoToAction | UriAction | SubmitAction | ResetAction | JavaScriptAction`
  - `function encodeAction(doc: Document, a: PdfAction): PdfDict`
  - `function parseAction(doc: Document, annot: PdfDict): PdfAction | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/actions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { isDict, isName, PdfDict, PdfObject } from '../src/types.js';
import { encodeAction, parseAction, type PdfAction } from '../src/actions.js';

const blank = () => Document.Open(buildBlankPage());
const nameOf = (o: unknown) => (o as { name: string }).name;
const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);
/** Wrap an action dict in a throwaway annotation, which is what parseAction reads. */
const annotWith = (a: PdfDict): PdfDict => new Map<string, PdfObject>([['A', a]]);

describe('encodeAction', () => {
  it('encodes a URI action', () => {
    const d = encodeAction(blank(), { type: 'uri', uri: 'https://example.com' });
    expect(nameOf(d.get('S'))).toBe('URI');
    expect(str(d.get('URI'))).toBe('https://example.com');
  });

  it('encodes a GoTo action with a destination array', () => {
    const doc = blank();
    const d = encodeAction(doc, { type: 'goto', page: 1 });
    expect(nameOf(d.get('S'))).toBe('GoTo');
    expect(Array.isArray(d.get('D'))).toBe(true);
  });

  it('encodes SubmitForm with a URL filespec and no flags by default', () => {
    const d = encodeAction(blank(), { type: 'submit', url: 'https://example.com/post' });
    expect(nameOf(d.get('S'))).toBe('SubmitForm');
    const fs = d.get('F') as PdfDict;
    expect(isDict(fs)).toBe(true);
    expect(nameOf(fs.get('FS'))).toBe('URL');
    expect(str(fs.get('F'))).toBe('https://example.com/post');
    expect(d.has('Flags')).toBe(false);
    expect(d.has('Fields')).toBe(false);
  });

  it('maps each submit format to its specification flag bit', () => {
    const doc = blank();
    const flagsFor = (format: 'fdf' | 'html' | 'xfdf' | 'pdf') =>
      encodeAction(doc, { type: 'submit', url: 'u', format }).get('Flags');
    expect(flagsFor('fdf')).toBeUndefined();   // no bit set
    expect(flagsFor('html')).toBe(4);          // bit 3, ExportFormat
    expect(flagsFor('xfdf')).toBe(32);         // bit 6, XFDF
    expect(flagsFor('pdf')).toBe(256);         // bit 9, SubmitPDF
  });

  it('sets IncludeExclude and writes the field-name list', () => {
    const d = encodeAction(blank(), {
      type: 'submit', url: 'u', fields: ['a', 'b'], exclude: true,
    });
    expect(d.get('Flags')).toBe(1);            // bit 1
    expect((d.get('Fields') as unknown[]).map(str)).toEqual(['a', 'b']);
  });

  it('encodes ResetForm', () => {
    const bare = encodeAction(blank(), { type: 'reset' });
    expect(nameOf(bare.get('S'))).toBe('ResetForm');
    expect(bare.has('Flags')).toBe(false);
    const scoped = encodeAction(blank(), { type: 'reset', fields: ['a'], exclude: true });
    expect(scoped.get('Flags')).toBe(1);
    expect((scoped.get('Fields') as unknown[]).map(str)).toEqual(['a']);
  });

  it('encodes JavaScript', () => {
    const d = encodeAction(blank(), { type: 'javascript', script: 'app.alert(1)' });
    expect(nameOf(d.get('S'))).toBe('JavaScript');
    expect(str(d.get('JS'))).toBe('app.alert(1)');
  });

  it('rejects malformed actions', () => {
    const doc = blank();
    expect(() => encodeAction(doc, { type: 'uri', uri: '' })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'submit', url: '' })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'javascript', script: '' })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'goto', page: 9 })).toThrow(RangeError);
    expect(() => encodeAction(doc, { type: 'goto', page: 0 })).toThrow(RangeError);
    expect(() => encodeAction(doc, {
      type: 'submit', url: 'u', fields: [1] as never,
    })).toThrow(TypeError);
    expect(() => encodeAction(doc, { type: 'nope' } as never)).toThrow(TypeError);
  });
});

describe('parseAction', () => {
  const roundTrip = (doc: Document, a: PdfAction) =>
    parseAction(doc, annotWith(encodeAction(doc, a)));

  it('round-trips every action type', () => {
    const doc = blank();
    expect(roundTrip(doc, { type: 'uri', uri: 'https://x' }))
      .toEqual({ type: 'uri', uri: 'https://x' });
    expect(roundTrip(doc, { type: 'javascript', script: 's' }))
      .toEqual({ type: 'javascript', script: 's' });
    expect(roundTrip(doc, { type: 'reset' })).toEqual({ type: 'reset' });
    expect(roundTrip(doc, { type: 'reset', fields: ['a'], exclude: true }))
      .toEqual({ type: 'reset', fields: ['a'], exclude: true });
    expect(roundTrip(doc, { type: 'submit', url: 'u', format: 'xfdf' }))
      .toEqual({ type: 'submit', url: 'u', format: 'xfdf' });
    expect(roundTrip(doc, { type: 'submit', url: 'u', fields: ['a'], exclude: true }))
      .toEqual({ type: 'submit', url: 'u', fields: ['a'], exclude: true, format: 'fdf' });
  });

  it('reports fdf when no format bit is set', () => {
    const doc = blank();
    expect(roundTrip(doc, { type: 'submit', url: 'u' }))
      .toEqual({ type: 'submit', url: 'u', format: 'fdf' });
  });

  it('accepts a bare string /F, which some producers write', () => {
    const doc = blank();
    const a: PdfDict = new Map<string, PdfObject>([
      ['S', { kind: 'name', name: 'SubmitForm' } as PdfObject],
      ['F', { kind: 'string', bytes: new TextEncoder().encode('https://bare') }],
    ]);
    expect(parseAction(doc, annotWith(a))).toEqual({
      type: 'submit', url: 'https://bare', format: 'fdf',
    });
  });

  it('returns undefined with no /A, a non-dict /A, or an unmodelled /S', () => {
    const doc = blank();
    expect(parseAction(doc, new Map())).toBeUndefined();
    const named: PdfDict = new Map<string, PdfObject>([
      ['S', { kind: 'name', name: 'Named' } as PdfObject],
    ]);
    expect(parseAction(doc, annotWith(named))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/actions.test.ts`
Expected: FAIL — `Failed to resolve import "../src/actions.js"`.

- [ ] **Step 3: Create `src/actions.ts`**

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString, name } from './types.js';
import { decodePdfText, encodePdfText } from './metadata.js';
import { encodeDest, parseDest, type OutlineView } from './outline.js';

/** A GoTo action: jump to a page in this document. */
export type GoToAction = { type: 'goto'; page: number; view?: OutlineView };
/** A URI action: open an external URL. */
export type UriAction = { type: 'uri'; uri: string };
/** A SubmitForm action: send the form's field values to `url`. */
export type SubmitAction = {
  type: 'submit';
  url: string;
  /** Fully-qualified field names. Omit to submit every field. */
  fields?: string[];
  /** Treat `fields` as an exclusion list (/Flags IncludeExclude). */
  exclude?: boolean;
  /** Wire format. Default 'fdf'. */
  format?: 'fdf' | 'html' | 'xfdf' | 'pdf';
};
/** A ResetForm action: clear the named fields, or every field. */
export type ResetAction = { type: 'reset'; fields?: string[]; exclude?: boolean };
/** A JavaScript action. */
export type JavaScriptAction = { type: 'javascript'; script: string };

/** Any action this library models, for an annotation's /A. */
export type PdfAction =
  GoToAction | UriAction | SubmitAction | ResetAction | JavaScriptAction;

// SubmitForm /Flags, PDF 32000-1 table 237, commented with the 1-based
// specification bit — bit N is 1 << (N - 1), and an off-by-one here silently
// selects a different behaviour rather than failing.
const SUBMIT_INCLUDE_EXCLUDE = 1 << 0; // bit 1
const SUBMIT_EXPORT_FORMAT = 1 << 2;   // bit 3  (HTML)
const SUBMIT_XFDF = 1 << 5;            // bit 6
const SUBMIT_PDF = 1 << 8;             // bit 9
// ResetForm /Flags, table 239.
const RESET_INCLUDE_EXCLUDE = 1 << 0;  // bit 1

function pdfText(s: string): PdfObject {
  return { kind: 'string', bytes: encodePdfText(s) };
}

function fieldNames(fields: unknown): PdfObject[] | undefined {
  if (fields === undefined) return undefined;
  if (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string'))
    throw new TypeError('action.fields must be an array of strings');
  return fields.map((f) => pdfText(f as string));
}

/** Build the /A dict for `a`. Validates everything before returning, so a
 *  caller that lets this throw has allocated nothing. */
export function encodeAction(doc: Document, a: PdfAction): PdfDict {
  switch (a?.type) {
    case 'goto': {
      const p = a.page;
      if (!Number.isInteger(p) || p < 1 || p > doc.Pages.length)
        throw new RangeError(`action page ${String(p)} out of range 1..${doc.Pages.length}`);
      return new Map<string, PdfObject>([
        ['S', name('GoTo')], ['D', encodeDest(doc.pageRef(p), a.view)],
      ]);
    }
    case 'uri': {
      if (typeof a.uri !== 'string' || a.uri.length === 0)
        throw new TypeError('action.uri must be a non-empty string');
      return new Map<string, PdfObject>([['S', name('URI')], ['URI', pdfText(a.uri)]]);
    }
    case 'submit': {
      if (typeof a.url !== 'string' || a.url.length === 0)
        throw new TypeError('action.url must be a non-empty string');
      const names = fieldNames(a.fields);
      let flags = 0;
      if (a.exclude) flags |= SUBMIT_INCLUDE_EXCLUDE;
      switch (a.format ?? 'fdf') {
        case 'fdf': break;
        case 'html': flags |= SUBMIT_EXPORT_FORMAT; break;
        case 'xfdf': flags |= SUBMIT_XFDF; break;
        case 'pdf': flags |= SUBMIT_PDF; break;
        default: throw new TypeError("action.format must be 'fdf', 'html', 'xfdf' or 'pdf'");
      }
      // A URL needs the /FS /URL file-specification form, not a bare string.
      const fs: PdfDict = new Map<string, PdfObject>([['FS', name('URL')], ['F', pdfText(a.url)]]);
      const d: PdfDict = new Map<string, PdfObject>([['S', name('SubmitForm')], ['F', fs]]);
      if (names) d.set('Fields', names);
      if (flags !== 0) d.set('Flags', flags);
      return d;
    }
    case 'reset': {
      const names = fieldNames(a.fields);
      const d: PdfDict = new Map<string, PdfObject>([['S', name('ResetForm')]]);
      if (names) d.set('Fields', names);
      if (a.exclude) d.set('Flags', RESET_INCLUDE_EXCLUDE);
      return d;
    }
    case 'javascript': {
      if (typeof a.script !== 'string' || a.script.length === 0)
        throw new TypeError('action.script must be a non-empty string');
      return new Map<string, PdfObject>([['S', name('JavaScript')], ['JS', pdfText(a.script)]]);
    }
    default:
      throw new TypeError(
        "action.type must be 'goto', 'uri', 'submit', 'reset' or 'javascript'",
      );
  }
}

function strings(doc: Document, o: PdfObject | undefined): string[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a)) return undefined;
  const out: string[] = [];
  for (const e of a) { const r = doc.resolve(e); if (isString(r)) out.push(decodePdfText(r.bytes)); }
  return out;
}

/** The URL from a SubmitForm /F: a /FS /URL filespec, or a bare string, which
 *  some producers write. */
function urlOf(doc: Document, o: PdfObject | undefined): string | undefined {
  const f = doc.resolve(o);
  if (isString(f)) return decodePdfText(f.bytes);
  if (isDict(f)) {
    const inner = doc.resolve((f as PdfDict).get('F'));
    if (isString(inner)) return decodePdfText(inner.bytes);
  }
  return undefined;
}

/** Parse `annot`'s /A action, or undefined when absent or unmodelled. Takes the
 *  annotation rather than the action dict because a GoTo destination may live
 *  in the annotation's own /Dest. */
export function parseAction(doc: Document, annot: PdfDict): PdfAction | undefined {
  const a = doc.resolve(annot.get('A'));
  if (!isDict(a)) return undefined;
  const s = doc.resolve((a as PdfDict).get('S'));
  if (!isName(s)) return undefined;
  switch (s.name) {
    case 'URI': {
      const u = doc.resolve((a as PdfDict).get('URI'));
      return isString(u) ? { type: 'uri', uri: decodePdfText(u.bytes) } : undefined;
    }
    case 'GoTo': {
      const d = parseDest(doc, annot, (o) => doc.pageNumberOf(o));
      return d ? { type: 'goto', page: d.page, view: d.view } : undefined;
    }
    case 'SubmitForm': {
      const url = urlOf(doc, (a as PdfDict).get('F'));
      if (url === undefined) return undefined;
      const flagsRaw = doc.resolve((a as PdfDict).get('Flags'));
      const flags = typeof flagsRaw === 'number' ? flagsRaw : 0;
      const out: SubmitAction = { type: 'submit', url };
      const names = strings(doc, (a as PdfDict).get('Fields'));
      if (names) out.fields = names;
      if (flags & SUBMIT_INCLUDE_EXCLUDE) out.exclude = true;
      if (flags & SUBMIT_PDF) out.format = 'pdf';
      else if (flags & SUBMIT_XFDF) out.format = 'xfdf';
      else if (flags & SUBMIT_EXPORT_FORMAT) out.format = 'html';
      else out.format = 'fdf';
      return out;
    }
    case 'ResetForm': {
      const out: ResetAction = { type: 'reset' };
      const names = strings(doc, (a as PdfDict).get('Fields'));
      if (names) out.fields = names;
      const flagsRaw = doc.resolve((a as PdfDict).get('Flags'));
      if (typeof flagsRaw === 'number' && (flagsRaw & RESET_INCLUDE_EXCLUDE)) out.exclude = true;
      return out;
    }
    case 'JavaScript': {
      const js = doc.resolve((a as PdfDict).get('JS'));
      return isString(js) ? { type: 'javascript', script: decodePdfText(js.bytes) } : undefined;
    }
    default:
      return undefined;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/actions.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

```bash
npm test
git add src/actions.ts test/actions.test.ts
git commit -m "feat(actions): shared /A action model for links and buttons (dbpr.5)"
```

---

### Task 2: Rewire `annotation.ts` onto `actions.ts`

**Files:**
- Modify: `src/annotation.ts` (delete the inline encode in `addLink` and the
  inline parse in `LinkAnnotation.Action`; widen `LinkAction` and `LinkOptions`)
- Modify: `src/index.ts` (export the new action types)
- Test: `test/actions.test.ts` (append)

**Interfaces:**
- Consumes: `encodeAction`, `parseAction`, `PdfAction` (Task 1).
- Produces: `LinkAction` is now an alias of `PdfAction`;
  `LinkOptions.action: PdfAction`; `LinkAnnotation.Action: PdfAction | undefined`.

- [ ] **Step 1: Write the failing test**

Append to `test/actions.test.ts` (add
`import { buildClassicPdf } from './helpers/build-pdf.js';` at the top):

```ts
describe('LinkAnnotation over the shared action model', () => {
  it('still round-trips a URI link', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const link = doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'uri', uri: 'https://example.com' },
    });
    expect(link.Action).toEqual({ type: 'uri', uri: 'https://example.com' });
  });

  it('still round-trips a GoTo link', () => {
    const doc = Document.Open(buildClassicPdf(2));
    const link = doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'goto', page: 2 },
    });
    expect(link.Action?.type).toBe('goto');
    expect((link.Action as { page: number }).page).toBe(2);
  });

  it('now parses a submit action that previously read back as undefined', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const link = doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30],
      action: { type: 'submit', url: 'https://example.com/post', format: 'html' },
    });
    expect(link.Action).toEqual({
      type: 'submit', url: 'https://example.com/post', format: 'html',
    });
  });

  it('keeps rejecting a malformed link action', () => {
    const doc = Document.Open(buildClassicPdf(1));
    expect(() => doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'goto', page: 99 },
    })).toThrow(RangeError);
    expect(() => doc.Pages[0].AddLink({
      rect: [10, 10, 100, 30], action: { type: 'bogus' } as never,
    })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/actions.test.ts -t "shared action model"`
Expected: FAIL on the submit case — `link.Action` is `undefined`, because
`addLink` rejects the type. The other three pass, and are the controls proving
the rewire preserves existing behaviour.

- [ ] **Step 3: Replace the inline parse**

In `src/annotation.ts`, replace the whole `get Action()` body in
`LinkAnnotation` with a delegation:

```ts
export class LinkAnnotation extends Annotation {
  /** The link's /A action as structured data; undefined when absent or of an
   *  unmodelled action type. */
  get Action(): PdfAction | undefined {
    return parseAction(this.doc, this.Dict);
  }
```

Leave the `Dest` getter below it untouched.

- [ ] **Step 4: Replace the inline encode**

Replace the whole action-encoding block at the top of `addLink` — everything
from `let aDict: PdfDict;` through the `else { throw ... }` — with one call:

```ts
export function addLink(doc: Document, page: Page, opts: LinkOptions): LinkAnnotation {
  const border = opts.border ?? 0;
  if (typeof border !== 'number' || !Number.isFinite(border) || border < 0)
    throw new TypeError('border must be a non-negative finite number');
  // Validates before anything is allocated, exactly as the inline copy did.
  const aDict = encodeAction(doc, opts.action);

  const dict = createAnnotation(doc, page, { subtype: 'Link', rect: opts.rect });
  dict.set('A', aDict);
  dict.set('Border', [0, 0, border]);
  return new LinkAnnotation(doc, dict);
}
```

- [ ] **Step 5: Widen the types and re-export**

In `src/annotation.ts`, delete the three local type declarations
(`export type GoToAction = …`, `export type UriAction = …`,
`export type LinkAction = …`) and replace them with a re-export plus the alias:

```ts
export type {
  GoToAction, UriAction, SubmitAction, ResetAction, JavaScriptAction, PdfAction,
} from './actions.js';
/** @deprecated Use PdfAction. Retained so existing imports keep working. */
export type LinkAction = PdfAction;
```

and add to the file's imports:

```ts
import { encodeAction, parseAction, type PdfAction } from './actions.js';
```

Widen `LinkOptions.action`, so link creation accepts what link reading returns:

```ts
export interface LinkOptions {
  rect: [number, number, number, number];
  /** The link's action. Any modelled action type; a link most often carries a
   *  GoTo or URI, but a submit or reset action is equally legal. */
  action: PdfAction;
  /** /Border width in points; default 0 (invisible). */
  border?: number;
}
```

In `src/index.ts`, replace the `LinkAction, GoToAction, UriAction` names in the
`annotation.js` type export with a dedicated line:

```ts
export type {
  PdfAction, GoToAction, UriAction, SubmitAction, ResetAction, JavaScriptAction,
} from './actions.js';
```

and leave `LinkOptions` and the deprecated `LinkAction` exported from
`annotation.js` as they are.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/actions.test.ts test/annotation.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/annotation.ts src/index.ts test/actions.test.ts
git commit -m "refactor(annot): route link actions through the shared model (dbpr.5)"
```

---

### Task 3: `mkOps` darkening and the button layout function

**Files:**
- Modify: `src/appearance.ts` (`mkOps` gains a `darken` parameter)
- Create: `src/buttonap.ts` (the layout function only; Task 4 fills in the rest)
- Test: `test/buttonap.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `mkOps(doc, widget, g, darken?: number)` — `darken` defaults to 1
  - `type ButtonIconPosition = 'caption-only' | 'icon-only' | 'icon-above-caption' | 'caption-over-icon'`
  - `const BUTTON_POSITIONS: readonly ButtonIconPosition[]`
  - `const TP_FOR: Record<ButtonIconPosition, number>`
  - `interface ButtonRegions { icon?: [number, number, number, number]; caption?: [number, number, number, number] }`
  - `function buttonRegions(pos: ButtonIconPosition, w: number, h: number, inset: number): ButtonRegions`

- [ ] **Step 1: Write the failing test**

Create `test/buttonap.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  buttonRegions, BUTTON_POSITIONS, TP_FOR, type ButtonIconPosition,
} from '../src/buttonap.js';

describe('buttonRegions', () => {
  it('gives caption-only the whole inset box and no icon', () => {
    const r = buttonRegions('caption-only', 100, 40, 2);
    expect(r.icon).toBeUndefined();
    expect(r.caption).toEqual([2, 2, 96, 36]);
  });

  it('gives icon-only the whole inset box and no caption', () => {
    const r = buttonRegions('icon-only', 100, 40, 2);
    expect(r.caption).toBeUndefined();
    expect(r.icon).toEqual([2, 2, 96, 36]);
  });

  it('overlays both on the whole box for caption-over-icon', () => {
    const r = buttonRegions('caption-over-icon', 100, 40, 2);
    expect(r.icon).toEqual([2, 2, 96, 36]);
    expect(r.caption).toEqual([2, 2, 96, 36]);
  });

  it('stacks the icon above a caption strip', () => {
    const r = buttonRegions('icon-above-caption', 100, 40, 2);
    // The caption sits at the bottom, the icon fills what is left above it.
    expect(r.caption![1]).toBe(2);
    expect(r.icon![1]).toBe(2 + r.caption![3]);
    expect(r.caption![3] + r.icon![3]).toBeCloseTo(36, 6);
    expect(r.icon![3]).toBeGreaterThan(r.caption![3]);
  });

  it('never returns a negative extent for a box smaller than its border', () => {
    for (const pos of BUTTON_POSITIONS) {
      const r = buttonRegions(pos, 4, 4, 10);
      for (const rect of [r.icon, r.caption]) {
        if (!rect) continue;
        expect(rect[2]).toBeGreaterThanOrEqual(0);
        expect(rect[3]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('maps each position to its specification /TP value', () => {
    // PDF 32000-1 table 189.
    expect(TP_FOR['caption-only']).toBe(0);
    expect(TP_FOR['icon-only']).toBe(1);
    expect(TP_FOR['icon-above-caption']).toBe(2);   // "caption below the icon"
    expect(TP_FOR['caption-over-icon']).toBe(6);
  });

  it('lists exactly the four supported positions', () => {
    expect([...BUTTON_POSITIONS].sort()).toEqual(
      ['caption-only', 'caption-over-icon', 'icon-above-caption', 'icon-only'],
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/buttonap.test.ts`
Expected: FAIL — `Failed to resolve import "../src/buttonap.js"`.

- [ ] **Step 3: Create `src/buttonap.ts` with the layout**

```ts
/** Where a push button's icon sits relative to its caption. The four layouts
 *  PDF 32000-1 table 189 defines that this library draws; /TP 3, 4 and 5
 *  (caption above / right of / left of the icon) are not modelled. */
export type ButtonIconPosition =
  | 'caption-only' | 'icon-only' | 'icon-above-caption' | 'caption-over-icon';

/** Every supported position, for validation and exhaustive tests. */
export const BUTTON_POSITIONS: readonly ButtonIconPosition[] = [
  'caption-only', 'icon-only', 'icon-above-caption', 'caption-over-icon',
];

/** The /MK /TP value for each position (table 189). */
export const TP_FOR: Record<ButtonIconPosition, number> = {
  'caption-only': 0,
  'icon-only': 1,
  'icon-above-caption': 2,   // the specification calls this "caption below the icon"
  'caption-over-icon': 6,
};

/** Where the icon and caption go, in form space (origin at the box's lower-left),
 *  each as [x, y, w, h]. An absent region means that element is not drawn. */
export interface ButtonRegions {
  icon?: [number, number, number, number];
  caption?: [number, number, number, number];
}

/** Lay out a push button's face. Pure: box size and mode in, rectangles out,
 *  which is what makes the four modes testable without reading content streams. */
export function buttonRegions(
  pos: ButtonIconPosition, w: number, h: number, inset: number,
): ButtonRegions {
  const x = inset;
  const y = inset;
  const bw = Math.max(0, w - 2 * inset);
  const bh = Math.max(0, h - 2 * inset);
  const whole: [number, number, number, number] = [x, y, bw, bh];
  switch (pos) {
    case 'caption-only':
      return { caption: whole };
    case 'icon-only':
      return { icon: whole };
    case 'caption-over-icon':
      return { icon: whole, caption: whole };
    case 'icon-above-caption': {
      // A caption strip along the bottom, capped so a tall button does not give
      // the caption more room than it can use.
      const capH = Math.min(bh * 0.3, 14);
      return {
        icon: [x, y + capH, bw, bh - capH],
        caption: [x, y, bw, capH],
      };
    }
  }
}
```

- [ ] **Step 4: Add the `darken` parameter to `mkOps`**

In `src/appearance.ts`, add this helper immediately above `mkOps`:

```ts
/** Scale a fill colour toward black by `k` (k < 1 darkens). Grey and RGB scale
 *  their components; CMYK instead raises the black channel, because scaling ink
 *  values down would *lighten* it. */
function darkenColor(c: number[], k: number): number[] {
  if (k === 1) return c;
  if (c.length === 4) return [c[0], c[1], c[2], Math.min(1, c[3] + (1 - k))];
  return c.map((v) => Math.max(0, Math.min(1, v * k)));
}
```

Change `mkOps`'s signature and its `/BG` line — everything else in the function
stays as it is:

```ts
export function mkOps(
  doc: Document, widget: PdfDict, g: WidgetGeom, darken = 1,
): { ops: string; inset: number } {
  const mk = doc.resolve(widget.get('MK'));
  if (!isDict(mk)) return { ops: '', inset: 0 };
  let ops = '';
  const bg = colorArr(doc, (mk as PdfDict).get('BG'));
  if (bg) ops += `${setColorOp(darkenColor(bg, darken), false)} 0 0 ${num(g.w)} ${num(g.h)} re f\n`;
```

The border (`/BC`) is deliberately not darkened: a pressed button darkens its
face, not its outline.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/buttonap.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

`darken` defaults to 1, so every existing caller is unaffected.

```bash
npm test
git add src/appearance.ts src/buttonap.ts test/buttonap.test.ts
git commit -m "feat(form): button face layout and a darken factor for mkOps (dbpr.5)"
```

---

### Task 4: Build the three push-button appearance streams

**Files:**
- Modify: `src/buttonap.ts` (append the builder)
- Modify: `src/formcreate.ts` (widen the `buildAP` hook to pass the AcroForm dict)
- Test: `test/buttonap.test.ts` (append)

**Interfaces:**
- Consumes: `buttonRegions`, `ButtonIconPosition` (Task 3); `widgetGeom`,
  `mkOps`, `buildAppearanceXObject` from `appearance.ts`; `buildImageXObject`
  from `imageembed.ts`; `resolveDA` from `da.ts`.
- Produces:
  - `interface PushButtonFace { caption: string; rolloverCaption: string; downCaption: string; icon?: BuiltImage; position: ButtonIconPosition }`
  - `function buildPushButtonAP(doc: Document, widget: PdfDict, acro: PdfDict, face: PushButtonFace): void`
  - `FieldSpec.buildAP` becomes `(doc: Document, dict: PdfDict, acro: PdfDict) => void`

- [ ] **Step 1: Write the failing test**

First create `test/helpers/make-png.ts`, so both this task's tests and Task 5's
can build an icon without carrying a binary fixture:

```ts
import { deflateSync } from 'node:zlib';

/** A 2x2 opaque red PNG, assembled here so tests carry no binary fixture. */
export function makePng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n: number) =>
    Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, data: Uint8Array) => {
    const body = Uint8Array.from([...new TextEncoder().encode(type), ...data]);
    return Uint8Array.from([...be32(data.length), ...body, ...be32(crc(body))]);
  };
  const ihdr = Uint8Array.from([...be32(2), ...be32(2), 8, 2, 0, 0, 0]); // 2x2, 8-bit RGB
  // Two rows, each prefixed with filter byte 0: red, red / red, blue.
  const raw = Uint8Array.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(deflateSync(raw))),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}
```

Then append to `test/buttonap.test.ts` (add these imports at the top):

```ts
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { makePng } from './helpers/make-png.js';
import { buildImageXObject } from '../src/imageembed.js';
import { buildPushButtonAP } from '../src/buttonap.js';
import { isDict, name, PdfDict, PdfObject } from '../src/types.js';
```

```ts
describe('buildPushButtonAP', () => {
  const widget = (): PdfDict => new Map<string, PdfObject>([
    ['Type', name('Annot')],
    ['Subtype', name('Widget')],
    ['Rect', [0, 0, 100, 40]],
    ['DA', { kind: 'string', bytes: new TextEncoder().encode('/Helv 0 Tf 0 0 0 rg') }],
    ['MK', new Map<string, PdfObject>([
      ['BG', [0.86, 0.86, 0.86]],
      ['BC', [0.5, 0.5, 0.5]],
    ])],
  ]);
  const ap = (doc: Document, w: PdfDict) => doc.resolve(w.get('AP')) as PdfDict;
  const body = (doc: Document, w: PdfDict, key: 'N' | 'R' | 'D') =>
    new TextDecoder('latin1').decode(
      (doc.resolve(ap(doc, w).get(key)) as { raw: Uint8Array }).raw,
    );
  const face = (over: Partial<Parameters<typeof buildPushButtonAP>[3]> = {}) => ({
    caption: 'Go', rolloverCaption: 'Go', downCaption: 'Go',
    position: 'caption-only' as ButtonIconPosition, ...over,
  });

  it('installs three sibling appearance streams', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face());
    expect([...ap(doc, w).keys()].sort()).toEqual(['D', 'N', 'R']);
  });

  it('draws each state its own caption', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face({
      caption: 'Normal', rolloverCaption: 'Hover', downCaption: 'Press',
    }));
    expect(body(doc, w, 'N')).toContain('Normal');
    expect(body(doc, w, 'R')).toContain('Hover');
    expect(body(doc, w, 'D')).toContain('Press');
  });

  it('darkens the face on the down state only', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    buildPushButtonAP(doc, w, new Map(), face());
    // mkOps writes the background as "<r> <g> <b> rg" before the box fill.
    const grey = (s: string) => Number(/([\d.]+) [\d.]+ [\d.]+ rg\n0 0 /.exec(s)![1]);
    expect(grey(body(doc, w, 'N'))).toBeCloseTo(0.86, 3);
    expect(grey(body(doc, w, 'R'))).toBeCloseTo(0.86, 3);
    expect(grey(body(doc, w, 'D'))).toBeLessThan(0.86);
  });

  it('registers the icon and draws it', () => {
    const doc = Document.Open(buildBlankPage());
    const w = widget();
    const icon = buildImageXObject(makePng());
    buildPushButtonAP(doc, w, new Map(), face({ position: 'icon-only', icon }));
    const n = doc.resolve(ap(doc, w).get('N')) as { dict: PdfDict; raw: Uint8Array };
    const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
    const xo = doc.resolve(res.get('XObject'));
    expect(isDict(xo)).toBe(true);
    expect([...(xo as PdfDict).keys()].length).toBe(1);
    expect(new TextDecoder('latin1').decode(n.raw)).toContain(' Do');
  });

  it('gives each layout a different stream', () => {
    const doc = Document.Open(buildBlankPage());
    const icon = buildImageXObject(makePng());
    const bodies = new Map<ButtonIconPosition, string>();
    for (const position of BUTTON_POSITIONS) {
      const w = widget();
      buildPushButtonAP(doc, w, new Map(), face({
        position, icon: position === 'caption-only' ? undefined : icon,
      }));
      bodies.set(position, body(doc, w, 'N'));
    }
    const seen = [...bodies.values()];
    // Pairwise distinct: a layout function that ignores the mode fails here.
    expect(new Set(seen).size).toBe(seen.length);
  });
});
```

`makePng` comes from the helper created at the start of this step, so the tests
carry no binary fixture and Task 5 reuses the same builder.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/buttonap.test.ts -t "buildPushButtonAP"`
Expected: FAIL — `buildPushButtonAP is not a function`.

- [ ] **Step 3: Append the builder to `src/buttonap.ts`**

Add these imports at the top of `src/buttonap.ts`:

```ts
import type { Document } from './document.js';
import { PdfDict, PdfObject, isDict, name } from './types.js';
import { num } from './pagecontent.js';
import { enc, serializeString } from './serialize.js';
import { encodeWinAnsi } from './encoding.js';
import { measure, type StdFont } from './metrics.js';
import { resolveDA } from './da.js';
import { widgetGeom, mkOps, buildAppearanceXObject } from './appearance.js';
import type { BuiltImage } from './imageembed.js';
```

and append:

```ts
/** What a push button's three appearance streams draw. */
export interface PushButtonFace {
  caption: string;
  rolloverCaption: string;
  downCaption: string;
  /** Already-built image XObject; omit for a caption-only button. */
  icon?: BuiltImage;
  position: ButtonIconPosition;
}

/** How much the pressed state darkens the face. */
const DOWN_DARKEN = 0.85;
/** Resource name the icon is registered under inside the appearance streams. */
const ICON_KEY = 'BtnIco';

/** Ops drawing `text` centred in [x, y, w, h] at `size`, in `color`. */
function centredCaption(
  text: string, rect: [number, number, number, number],
  std: StdFont, size: number, color: [number, number, number],
): string {
  if (text === '') return '';
  const [x, y, w, h] = rect;
  const bytes = encodeWinAnsi(text);
  const tw = measure(std, bytes, size);
  const tx = x + Math.max(0, (w - tw) / 2);
  const ty = y + Math.max(0, (h - size) / 2) + size * 0.2;
  const [r, g, b] = color;
  return `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(g)} ${num(b)} rg\n` +
    `${num(tx)} ${num(ty)} Td\n${serializeString(bytes)} Tj\nET\n`;
}

/** Ops drawing the icon aspect-fit and centred in [x, y, w, h]. */
function iconOps(
  doc: Document, icon: BuiltImage, rect: [number, number, number, number],
): string {
  const [x, y, w, h] = rect;
  const iw = doc.resolve(icon.stream.dict.get('Width'));
  const ih = doc.resolve(icon.stream.dict.get('Height'));
  if (typeof iw !== 'number' || typeof ih !== 'number' || iw <= 0 || ih <= 0) return '';
  const scale = Math.min(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  return `q\n${num(dw)} 0 0 ${num(dh)} ${num(dx)} ${num(dy)} cm\n/${ICON_KEY} Do\nQ\n`;
}

/** Build and install a push button's /N, /R and /D appearance streams.
 *  No-op when the widget has no usable geometry.
 *
 *  The three states differ only in caption and face darkness, so they share one
 *  body builder — a viewer picks the stream, and every one must be complete. */
export function buildPushButtonAP(
  doc: Document, widget: PdfDict, acro: PdfDict, face: PushButtonFace,
): void {
  const g = widgetGeom(doc, widget);
  if (!g) return;
  const da = resolveDA(doc, widget, acro);
  const size = da.size > 0 ? da.size : Math.min(12, g.h * 0.5);

  // The icon is one object shared by all three streams rather than three copies.
  let iconRef: PdfObject | undefined;
  if (face.icon) {
    if (face.icon.smask) face.icon.stream.dict.set('SMask', doc.allocObject(face.icon.smask));
    iconRef = doc.allocObject(face.icon.stream);
  }

  const build = (caption: string, darken: number) => {
    const mk = mkOps(doc, widget, g, darken);
    const regions = buttonRegions(face.position, g.w, g.h, mk.inset);
    let body = mk.ops;
    if (regions.icon && face.icon) body += iconOps(doc, face.icon, regions.icon);
    if (regions.caption) body += centredCaption(caption, regions.caption, da.std, size, da.color);
    const stream = buildAppearanceXObject(doc, g, da.std, 'Helv', body);
    if (iconRef) {
      const res = stream.dict.get('Resources') as PdfDict;
      res.set('XObject', new Map<string, PdfObject>([[ICON_KEY, iconRef]]));
    }
    return doc.allocObject(stream);
  };

  widget.set('AP', new Map<string, PdfObject>([
    ['N', build(face.caption, 1)],
    ['R', build(face.rolloverCaption, 1)],
    ['D', build(face.downCaption, DOWN_DARKEN)],
  ]));
}
```

Note `isDict` may be unused in this file; remove it from the import if `tsc`
or your editor flags it.

- [ ] **Step 4: Widen the `buildAP` hook**

In `src/formcreate.ts`, change the `FieldSpec` member and the call site so a
field type can reach the AcroForm dict — push buttons need it for `resolveDA`:

```ts
  /** Build this field's /AP instead of the default value-driven generation.
   *  Buttons use it so the on-state carries the export name the caller chose,
   *  rather than the one generateFieldAppearance would guess. */
  buildAP?: (doc: Document, dict: PdfDict, acro: PdfDict) => void;
```

and in `createField`:

```ts
  if (spec.buildAP) spec.buildAP(doc, dict, acro);
  else generateFieldAppearance(doc, acro, dict, type, ff, dict.get('V') ?? null);
```

The checkbox closure added in `dbpr.3` ignores the new third argument, so it
needs no change.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/buttonap.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Prove the darkening is load-bearing**

Temporarily change the `/D` entry to `build(face.downCaption, 1)`.

Run: `npx vitest run test/buttonap.test.ts -t "darkens the face"`
Expected: FAIL — the down grey equals 0.86. **Revert.**

- [ ] **Step 7: Prove the layout is load-bearing**

Temporarily make `buttonRegions` ignore its mode by returning the caption-only
result for every case — put `return { caption: whole };` immediately after
`whole` is computed, above the `switch`.

Run: `npx vitest run test/buttonap.test.ts -t "different stream"`
Expected: FAIL — every layout produces the same body. **Revert** and confirm
green.

- [ ] **Step 8: Run the full suite and commit**

```bash
npm test
git add src/buttonap.ts src/formcreate.ts test/buttonap.test.ts
git commit -m "feat(form): push-button /N, /R and /D appearance streams (dbpr.5)"
```

---

### Task 5: Push button creation

**Files:**
- Modify: `src/formcreate.ts` (`PushButtonInit`, `addPushButton`)
- Modify: `src/formfield.ts` (`ButtonField.Action`)
- Modify: `src/form.ts`, `src/page.ts`, `src/index.ts`
- Test: `test/form-create.test.ts` (append)

**Interfaces:**
- Consumes: `PdfAction`, `encodeAction`, `parseAction` (Tasks 1–2);
  `buildPushButtonAP`, `ButtonIconPosition`, `BUTTON_POSITIONS`, `TP_FOR`
  (Tasks 3–4); `createField`, `pdfText` (`formcreate.ts`); `FF_PUSHBUTTON`.
- Produces:
  - `interface PushButtonInit extends FieldInit { caption?: string; rolloverCaption?: string; downCaption?: string; icon?: Uint8Array; iconPosition?: ButtonIconPosition; action?: PdfAction }`
  - `function addPushButton(doc: Document, init: PushButtonInit): ButtonField`
  - `Form.AddPushButton`, `Page.AddPushButton`
  - `ButtonField.Action: PdfAction | undefined` (get/set)

- [ ] **Step 1: Write the failing test**

Append to `test/form-create.test.ts`. Add `ButtonField` to the
`../src/formfield.js` import, and add
`import { makePng } from './helpers/make-png.js';` — the helper Task 4 created.

```ts
describe('AddPushButton', () => {
  const mkOf = (doc: Document, f: { Dict: PdfDict }) => doc.resolve(f.Dict.get('MK')) as PdfDict;
  const str = (o: unknown) => new TextDecoder('latin1').decode((o as { bytes: Uint8Array }).bytes);

  it('creates a pushbutton with /MK characteristics and no value', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
    });
    expect(f).toBeInstanceOf(ButtonField);
    expect(f.Type).toBe('pushbutton');
    expect(doc.resolve(f.Dict.get('Ff'))).toBe(65536);   // spec bit 17
    expect(f.Dict.has('V')).toBe(false);
    const mk = mkOf(doc, f);
    expect(str(mk.get('CA'))).toBe('Go');
    expect(str(mk.get('RC'))).toBe('Go');                // falls back to the caption
    expect(str(mk.get('AC'))).toBe('Go');
    expect(doc.resolve(mk.get('TP'))).toBe(0);
    expect(doc.resolve(mk.get('BG'))).toEqual([0.86, 0.86, 0.86]);
    expect(doc.resolve(mk.get('BC'))).toEqual([0.5, 0.5, 0.5]);
  });

  it('keeps distinct rollover and down captions', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go',
      caption: 'Go', rolloverCaption: 'Hover', downCaption: 'Press',
    });
    const mk = mkOf(doc, f);
    expect(str(mk.get('RC'))).toBe('Hover');
    expect(str(mk.get('AC'))).toBe('Press');
  });

  it('installs all three appearance streams', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
    });
    expect([...(doc.resolve(f.Dict.get('AP')) as PdfDict).keys()].sort())
      .toEqual(['D', 'N', 'R']);
  });

  it('writes the /TP value for the chosen layout and embeds the icon', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
      icon: makePng(), iconPosition: 'icon-above-caption',
    });
    expect(doc.resolve(mkOf(doc, f).get('TP'))).toBe(2);
    const n = doc.resolve((doc.resolve(f.Dict.get('AP')) as PdfDict).get('N')) as { dict: PdfDict };
    const res = doc.resolve(n.dict.get('Resources')) as PdfDict;
    expect(isDict(doc.resolve(res.get('XObject')))).toBe(true);
  });

  it('defaults to icon-only when an icon is given with no caption', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', icon: makePng(),
    });
    expect(doc.resolve(mkOf(doc, f).get('TP'))).toBe(1);
  });

  it('writes the action and reads it back', () => {
    const doc = blank();
    const f = doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Submit',
      action: { type: 'submit', url: 'https://example.com/post', format: 'html' },
    });
    expect(f.Action).toEqual({
      type: 'submit', url: 'https://example.com/post', format: 'html',
    });
    f.Action = { type: 'reset' };
    expect(f.Action).toEqual({ type: 'reset' });
    f.Action = undefined;
    expect(f.Dict.has('A')).toBe(false);
    expect(f.Action).toBeUndefined();
  });

  it('forwards from the page', () => {
    const doc = blank();
    const f = doc.Pages[0].AddPushButton({ rect: [10, 10, 110, 40], name: 'go', caption: 'Go' });
    expect(doc.resolve(f.Dict.get('P'))).toBe(doc.Pages[0].Dict);
  });

  it('survives a Save/Open round-trip', () => {
    const doc = blank();
    doc.Form.AddPushButton({
      page: 1, rect: [10, 10, 110, 40], name: 'go', caption: 'Go',
      action: { type: 'uri', uri: 'https://example.com' },
    });
    const f = Document.Open(doc.Save()).Form.Get('go')!;
    expect(f.Type).toBe('pushbutton');
    expect((f as ButtonField).Action).toEqual({ type: 'uri', uri: 'https://example.com' });
  });

  it('rejects bad input without mutating the document', () => {
    // Each case is a complete options object, so nothing depends on a
    // conditional spread and each rejection is readable on its own line.
    const cases: Array<[Record<string, unknown>, typeof TypeError | typeof RangeError]> = [
      [{ caption: 7 }, TypeError],
      [{ rolloverCaption: 7 }, TypeError],
      [{ downCaption: 7 }, TypeError],
      [{ iconPosition: 'sideways' }, TypeError],
      // An icon-bearing layout with no icon.
      [{ caption: 'x', iconPosition: 'icon-only' }, RangeError],
      [{ caption: 'x', iconPosition: 'icon-above-caption' }, RangeError],
      [{ caption: 'x', iconPosition: 'caption-over-icon' }, RangeError],
      // An icon that would never be drawn.
      [{ caption: 'x', iconPosition: 'caption-only', icon: makePng() }, RangeError],
      [{ action: { type: 'uri', uri: '' } }, TypeError],
      [{ action: { type: 'goto', page: 9 } }, RangeError],
      [{ action: { type: 'bogus' } }, TypeError],
    ];
    for (const [extra, err] of cases) {
      const doc = blank();
      const before = doc.Save().length;
      expect(() => doc.Form.AddPushButton({
        page: 1, rect: [10, 10, 110, 40], name: 'go', ...extra,
      } as never)).toThrow(err as never);
      expect(doc.catalog().has('AcroForm')).toBe(false);
      expect(doc.Save().length).toBe(before);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/form-create.test.ts -t "AddPushButton"`
Expected: FAIL — `doc.Form.AddPushButton is not a function`.

- [ ] **Step 3: Add `ButtonField.Action`**

In `src/formfield.ts`, replace the one-line `ButtonField` declaration

```ts
export class ButtonField extends Field { declare readonly Type: 'pushbutton'; }
```

with:

```ts
/** A push button (`/FT /Btn` with the Pushbutton flag). It has no value — only
 *  an appearance and an activation action. */
export class ButtonField extends Field {
  declare readonly Type: 'pushbutton';

  /** The widget's /A activation action; undefined when absent or unmodelled. */
  get Action(): PdfAction | undefined {
    return parseAction(this.doc, this.Dict);
  }
  set Action(a: PdfAction | undefined) {
    if (a === undefined) this.Dict.delete('A');
    else this.Dict.set('A', encodeAction(this.doc, a));   // validates before writing
    this.doc.markModified();
  }
}
```

and add to the file's imports:

```ts
import { encodeAction, parseAction, type PdfAction } from './actions.js';
```

- [ ] **Step 4: Implement `addPushButton`**

Append to `src/formcreate.ts`:

```ts
/** Options for Form.AddPushButton / Page.AddPushButton. */
export interface PushButtonInit extends FieldInit {
  /** /MK /CA — the normal-state caption. */
  caption?: string;
  /** /MK /RC — the caption while hovered. Defaults to `caption`. */
  rolloverCaption?: string;
  /** /MK /AC — the caption while pressed. Defaults to `caption`. */
  downCaption?: string;
  /** JPEG or PNG bytes, drawn into the appearance streams. */
  icon?: Uint8Array;
  /** /MK /TP layout. Default 'caption-only', or 'icon-only' when an icon is
   *  given without a caption. */
  iconPosition?: ButtonIconPosition;
  /** The activation action, written to /A. */
  action?: PdfAction;
}

/** Create a push button (`/FT /Btn` with the Pushbutton flag) and return its
 *  handle. A push button has no /V — it exists to have an appearance and an
 *  action. */
export function addPushButton(doc: Document, init: PushButtonInit): ButtonField {
  for (const key of ['caption', 'rolloverCaption', 'downCaption'] as const) {
    const v = init[key];
    if (v !== undefined && typeof v !== 'string') throw new TypeError(`${key} must be a string`);
  }
  const caption = init.caption ?? '';
  const hasIcon = init.icon !== undefined;
  const position = init.iconPosition
    ?? (hasIcon && caption === '' ? 'icon-only' : 'caption-only');
  if (!BUTTON_POSITIONS.includes(position))
    throw new TypeError(`iconPosition must be one of ${BUTTON_POSITIONS.join(', ')}`);
  // Reject the pairings that would silently render as something else: an icon
  // that is embedded but never drawn, or a layout with nothing to draw.
  if (position !== 'caption-only' && !hasIcon)
    throw new RangeError(`iconPosition '${position}' needs an icon`);
  if (position === 'caption-only' && hasIcon)
    throw new RangeError("an icon needs an iconPosition other than 'caption-only'");

  // Both of these validate without mutating the document.
  const aDict = init.action === undefined ? undefined : encodeAction(doc, init.action);
  const icon = hasIcon ? buildImageXObject(init.icon!) : undefined;

  const rollover = init.rolloverCaption ?? caption;
  const down = init.downCaption ?? caption;
  const mk: PdfDict = new Map<string, PdfObject>([
    ['CA', pdfText(caption)],
    ['RC', pdfText(rollover)],
    ['AC', pdfText(down)],
    ['TP', TP_FOR[position]],
    // Defaults so a created button looks like a button. dbpr.6 overwrites these
    // same keys, so there is no separate colour API here.
    ['BG', [0.86, 0.86, 0.86]],
    ['BC', [0.5, 0.5, 0.5]],
  ]);
  const entries: Array<[string, PdfObject]> = [['MK', mk]];
  if (aDict) entries.push(['A', aDict]);

  const c = createField(doc, init, {
    ft: 'Btn',
    ff: FF_PUSHBUTTON,
    entries,
    buildAP: (d, dict, acro) => {
      buildPushButtonAP(d, dict, acro, {
        caption, rolloverCaption: rollover, downCaption: down, icon, position,
      });
    },
  });
  return new ButtonField(
    doc, c.acro, c.dict, c.partial, c.fullName, 'pushbutton', c.ff, null,
  );
}
```

Extend the imports in `src/formcreate.ts`:

```ts
import {
  classify, TextField, CheckboxField, RadioField, ChoiceField, ButtonField,
  type FieldType,
} from './formfield.js';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB, FF_RADIO,
  FF_COMBO, FF_EDIT, FF_MULTISELECT, FF_PUSHBUTTON,
} from './fieldflags.js';
import { encodeAction, type PdfAction } from './actions.js';
import { buildImageXObject } from './imageembed.js';
import {
  buildPushButtonAP, buttonRegions, BUTTON_POSITIONS, TP_FOR,
  type ButtonIconPosition,
} from './buttonap.js';
```

`buttonRegions` is imported only if you use it directly; drop it from the import
if `tsc` flags it as unused.

- [ ] **Step 5: Add the public entry points**

In `src/form.ts`, extend the `formcreate.js` import with `addPushButton` and
`type PushButtonInit`, the `formfield.js` type import with `ButtonField`, and
add to the `Form` class after `AddListBox`:

```ts
  /** Create a push button on `init.page` and return its handle. A push button
   *  has no value — give it a `caption`, an `icon`, or both, and an `action`.
   *  Throws without mutating the document on a malformed caption, an unknown
   *  `iconPosition`, an icon-bearing layout with no icon (or the reverse), or a
   *  malformed action. */
  AddPushButton(init: PushButtonInit): ButtonField {
    const field = addPushButton(this.doc, init);
    this.build();
    return field;
  }
```

In `src/page.ts`, extend the same two imports and add after `AddListBox`:

```ts
  /** Create an AcroForm push button whose widget lands on this page.
   *  A thin forwarder to Form.AddPushButton with `page` bound to this page. */
  AddPushButton(init: Omit<PushButtonInit, 'page'>): ButtonField {
    return addPushButton(this.doc, { ...init, page: this.Number });
  }
```

In `src/index.ts`, extend the `formcreate.js` type export with `PushButtonInit`
and add the layout type:

```ts
export type {
  FieldInit, TextFieldInit, CheckboxInit, RadioOption, RadioGroupInit,
  ChoiceOption, ChoiceInit, ComboBoxInit, ListBoxInit, PushButtonInit,
} from './formcreate.js';
export type { ButtonIconPosition } from './buttonap.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/form-create.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm test
git add src/formcreate.ts src/formfield.ts src/form.ts src/page.ts src/index.ts \
  test/form-create.test.ts test/buttonap.test.ts test/helpers/make-png.ts
git commit -m "feat(form): push button creation with captions, icon and action (dbpr.5)"
```

---

### Task 6: Documentation, follow-up, and close

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update `README.md`**

In the "Form fields (AcroForm)" section, after the paragraph ending "...setting
either on the wrong type throws.", add:

````markdown
Push buttons have no value — they carry an appearance and an action:

```ts
const submit = doc.Form.AddPushButton({
  page: 1, rect: [72, 400, 172, 428], name: 'submit',
  caption: 'Submit',
  rolloverCaption: 'Send it',      // shown while hovered
  downCaption: 'Sending…',         // shown while pressed
  icon: pngOrJpegBytes,            // optional
  iconPosition: 'icon-above-caption',
  action: {
    type: 'submit',
    url: 'https://example.com/post',
    format: 'fdf',                 // or 'html' | 'xfdf' | 'pdf'
    fields: ['name', 'email'],     // omit to submit every field
  },
});
submit.Action;                     // read it back
submit.Action = { type: 'reset' }; // or undefined to clear
```

Three appearance streams are generated — `/N`, `/R` (hover) and `/D` (pressed,
on a darkened face) — so the button reacts in any viewer. `iconPosition` is one
of `'caption-only'`, `'icon-only'`, `'icon-above-caption'` or
`'caption-over-icon'`.

The same action model drives link annotations, so a link may carry any of
`goto`, `uri`, `submit`, `reset` or `javascript`:

```ts
page.AddLink({ rect: [10, 10, 110, 30], action: { type: 'javascript', script: 'app.alert(1)' } });
```
````

- [ ] **Step 2: Update the API-overview table in `README.md`**

After the `AddListBox` row, add:

```markdown
| `doc.Form.AddPushButton(init)` / `page.AddPushButton(init)` | Create a push button → `ButtonField` |
| `ButtonField.Action` | Read/write the `/A` action (`goto`, `uri`, `submit`, `reset`, `javascript`) |
```

- [ ] **Step 3: Update `CLAUDE.md`**

Add `actions.ts` and `buttonap.ts` to the AcroForm bullet's module list by
replacing its first line:

```markdown
- **form.ts**, **formfield.ts**, **formcreate.ts**, **fieldflags.ts**,
  **actions.ts**, **buttonap.ts** — AcroForm: `form.ts` is the
```

and append this invariant to the end of that bullet:

```markdown
  **Invariant:** `/A` actions have exactly one encoder and one parser, in
  `actions.ts`, shared by link annotations and push buttons. They were inline in
  `addLink` and `LinkAnnotation.Action` and reusable from neither, which is why
  a link carrying a submit action used to read back as `undefined`. A
  SubmitForm `/F` is a `/FS /URL` filespec, not a bare string.
```

- [ ] **Step 4: File the follow-up the spec defers**

```bash
bd create "Push button: /TP 3, 4 and 5 icon layouts" \
  -t feature -p 3 \
  -d "dbpr.5 draws four of the seven /TP layouts (PDF 32000-1 table 189): caption-only (0), icon-only (1), icon-above-caption (2) and caption-over-icon (6), matching Aspose-PDF-FOSS-for-Go. The remaining three are caption above the icon (3), caption to the right (4) and caption to the left (5); each needs new geometry in buttonRegions. Also deferred: /MK /R caption rotation, and exposing the icon as a /MK /I Form XObject for viewer-side regeneration. Deferred from dbpr.5 (see docs/superpowers/specs/2026-07-27-push-button-creation-design.md)."
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
git commit -m "docs(form): document push buttons and the shared action model (dbpr.5)"

bd close aspose-pdf-foss-for-ts-dbpr.5
bd remember --key push-button-creation-shipped \
  "push-button-creation-shipped (dbpr.5): src/actions.ts owns the ONE /A encoder+parser (PdfAction = goto|uri|submit|reset|javascript), shared by LinkAnnotation and push buttons; both inline copies in annotation.ts are gone. LinkAction is now an alias of PdfAction and LinkOptions.action widened, so a link may carry any action — previously a submit-action link read back as undefined. SubmitForm /F is a /FS /URL filespec, not a bare string; /Flags bits are IncludeExclude=1, ExportFormat(HTML)=4, XFDF=32, SubmitPDF=256. src/buttonap.ts owns push-button appearance: buttonRegions (pure layout for the four /TP modes 0/1/2/6) and buildPushButtonAP, which installs /AP /N, /R and /D — the down state darkens /MK /BG via a new optional `darken` param on mkOps (CMYK raises /K instead of scaling ink down). Public: Form/Page.AddPushButton(PushButtonInit{caption?,rolloverCaption?,downCaption?,icon?,iconPosition?,action?}) -> ButtonField, plus ButtonField.Action get/set. No /V — a push button has no value. Colours are dbpr.6's; creation writes default /MK /BG and /BC that dbpr.6 overwrites. FieldSpec.buildAP widened to (doc, dict, acro) so buttons can resolveDA. Spec: docs/superpowers/specs/2026-07-27-push-button-creation-design.md"

git add .beads/
git commit -m "chore(bd): close dbpr.5 (push button creation + appearance/actions)"
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Notes for the implementer

- **Do not reintroduce a second `/A` encoder.** If push-button code needs an
  action dict, call `encodeAction`. The whole point of Task 1 is that there is
  one.
- **A push button has no `/V`.** Do not add one "for symmetry" — `Field.Value`'s
  setter already refuses this type, and a `/V` on a push button is meaningless.
- **The icon is allocated once** and referenced by all three streams. Building it
  three times would triple the file size for no benefit.
- **`/BC` is not darkened** on the pressed state — a pressed button darkens its
  face, not its outline. The test only checks the fill.
- **`mkOps`'s `darken` defaults to 1**, so every existing caller is unaffected.
  Do not thread it through the other field types.
- **Colours belong to `dbpr.6`.** This issue writes default `/BG` and `/BC`
  values into `/MK`; it must not add a colour option to `PushButtonInit`.
