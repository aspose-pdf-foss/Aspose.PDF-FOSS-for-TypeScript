# Form Appearance Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate AcroForm field appearance streams (`widget /AP /N`) so filled forms render identically in every viewer and `/NeedAppearances` can be dropped.

**Architecture:** A dedicated `appearance.ts` generator builds a form XObject for each widget, driven by a `/DA` parser (`da.ts`) and Standard-14 font metrics (extended `metrics.ts`). The `form.ts` field setters and two new explicit methods call the generator. Low-level content builders are reused from `serialize.ts`/`pagecontent.ts`; appearances are XObjects, not page content, so `appendContent` is **not** reused.

**Tech Stack:** TypeScript (strict, NodeNext ESM, `.js` import specifiers), vitest, zero runtime deps (`node:` built-ins only).

## Global Constraints

- Zero runtime dependencies — only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier ends in `.js`.
- `PdfDict` is a `Map<string, PdfObject>` keyed by name without leading `/`.
- Tagged objects via guards from `types.ts`: `isDict`/`isArray`/`isName`/`isString`/`isRef`/`isStream`; construct names with `name('Foo')`, strings as `{ kind: 'string', bytes }`, streams as `{ kind: 'stream', dict, raw }`.
- Live-mutation model: mutate live dicts; allocate new objects with `doc.allocObject(obj): PdfRef`; never mutate during `Save`. Generated streams hold uncompressed `raw` bytes.
- Throw only the public error types from `errors.ts` (`PdfParseError`, `UnsupportedFeatureError`, `InvalidPasswordError`) when throwing at all; appearance generation is otherwise best-effort per widget (skip, don't throw).
- Run `npm run typecheck` and `npm test` green before completing any task. Target one file with `npx vitest run test/<name>.test.ts`.
- Keep `README.md` in sync when public API changes.

---

### Task 1: Standard-14 font metrics

Extend `metrics.ts` from Helvetica-only to all 14 standard fonts, adding a per-font width lookup and a generalized `measure`. Keep `measureWinAnsi` working unchanged so `stamp.ts` is untouched.

**Files:**
- Modify: `src/metrics.ts`
- Test: `test/metrics.test.ts` (create)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `type StdFont = 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique' | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic' | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique' | 'Symbol' | 'ZapfDingbats'`
  - `function normalizeFont(baseFont: string): StdFont` — maps a `/BaseFont` or `/DA` font name (incl. abbreviations `Helv`, `HeBo`, `Cour`, `TiRo`, `Symb`, `ZaDb`) to a `StdFont`, defaulting to `'Helvetica'`.
  - `function glyphWidth(font: StdFont, code: number): number` — advance in 1000-unit em for a byte `code` (WinAnsi index for the text families; built-in encoding index for Symbol/ZapfDingbats), `0` if no glyph.
  - `function measure(font: StdFont, bytes: Uint8Array, fontSize: number): number` — sum of `glyphWidth` scaled to points.
  - `function measureWinAnsi(bytes, fontSize)` retained as `measure('Helvetica', bytes, fontSize)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/metrics.test.ts
import { describe, it, expect } from 'vitest';
import {
  measure, measureWinAnsi, glyphWidth, normalizeFont, type StdFont,
} from '../src/metrics.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('Standard-14 metrics', () => {
  it('keeps the Helvetica shim stable', () => {
    // 'A' is 667 units; at 12pt -> 8.004
    expect(measureWinAnsi(enc('A'), 12)).toBeCloseTo(8.004, 3);
    expect(measure('Helvetica', enc('A'), 12)).toBe(measureWinAnsi(enc('A'), 12));
  });

  it('has canonical per-family widths', () => {
    expect(glyphWidth('Helvetica', 0x20)).toBe(278);     // space
    expect(glyphWidth('Helvetica-Bold', 0x41)).toBe(722); // A
    expect(glyphWidth('Times-Roman', 0x20)).toBe(250);    // space
    expect(glyphWidth('Times-Roman', 0x41)).toBe(722);    // A
    expect(glyphWidth('Courier', 0x41)).toBe(600);        // monospace
    expect(glyphWidth('Courier-Bold', 0x20)).toBe(600);
    expect(glyphWidth('ZapfDingbats', 0x34)).toBeGreaterThan(0); // '4' check glyph
  });

  it('measure is additive', () => {
    const ab = measure('Times-Roman', enc('AB'), 10);
    const a = measure('Times-Roman', enc('A'), 10);
    const b = measure('Times-Roman', enc('B'), 10);
    expect(ab).toBeCloseTo(a + b, 6);
  });

  it('normalizes names and abbreviations', () => {
    expect(normalizeFont('Helvetica')).toBe('Helvetica');
    expect(normalizeFont('Helv')).toBe('Helvetica');
    expect(normalizeFont('HeBo')).toBe('Helvetica-Bold');
    expect(normalizeFont('TiRo')).toBe('Times-Roman');
    expect(normalizeFont('Cour')).toBe('Courier');
    expect(normalizeFont('ZaDb')).toBe('ZapfDingbats');
    expect(normalizeFont('ABCDEF+Helvetica-Bold')).toBe('Helvetica-Bold'); // subset prefix stripped
    expect(normalizeFont('SomethingWeird')).toBe('Helvetica'); // fallback
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metrics.test.ts`
Expected: FAIL — `measure`, `glyphWidth`, `normalizeFont`, `StdFont` not exported.

- [ ] **Step 3: Implement the width tables and helpers**

In `src/metrics.ts`, keep the existing `HELVETICA_WIDTHS` array and `measureWinAnsi`. Add the remaining 13 width arrays and the new helpers. **The width arrays are transcribed from the Adobe Core-14 AFM files** (the canonical public source; the same source and the same WinAnsi-indexing the existing `HELVETICA_WIDTHS` was transcribed from). Mirror the existing 16-per-row comment layout.

Method per font:
- **Courier family** (`Courier`, `Courier-Bold`, `Courier-Oblique`, `Courier-BoldOblique`): monospaced — every code that has a glyph in WinAnsi is `600`; codes that are `0` in `HELVETICA_WIDTHS` (control/unused slots) stay `0`. Derive programmatically: `COURIER_WIDTHS = HELVETICA_WIDTHS.map((w) => (w === 0 ? 0 : 600))`. All four Courier variants share this array.
- **Helvetica family** (`Helvetica-Bold`, `Helvetica-Oblique`, `Helvetica-BoldOblique`) and **Times family** (`Times-Roman`, `Times-Bold`, `Times-Italic`, `Times-BoldItalic`): transcribe each AFM’s WinAnsi widths into a 256-entry array, same shape as `HELVETICA_WIDTHS`. (Oblique/Italic share widths with their upright variant in the AFMs; Bold differs.)
- **Symbol** and **ZapfDingbats**: these use their own built-in encodings, not WinAnsi. Transcribe their AFM widths indexed by the built-in encoding code. Coverage need only be correct for the codes v1 emits (ZapfDingbats `0x34` `4` check, `0x6C` `l` circle) and otherwise canonical where transcribed; unfilled slots are `0`.

Then:

```ts
export type StdFont =
  | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique' | 'Helvetica-BoldOblique'
  | 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Times-BoldItalic'
  | 'Courier' | 'Courier-Bold' | 'Courier-Oblique' | 'Courier-BoldOblique'
  | 'Symbol' | 'ZapfDingbats';

const COURIER_WIDTHS: readonly number[] = HELVETICA_WIDTHS.map((w) => (w === 0 ? 0 : 600));

const WIDTHS: Record<StdFont, readonly number[]> = {
  'Helvetica': HELVETICA_WIDTHS,
  'Helvetica-Bold': HELVETICA_BOLD_WIDTHS,
  'Helvetica-Oblique': HELVETICA_WIDTHS,
  'Helvetica-BoldOblique': HELVETICA_BOLD_WIDTHS,
  'Times-Roman': TIMES_ROMAN_WIDTHS,
  'Times-Bold': TIMES_BOLD_WIDTHS,
  'Times-Italic': TIMES_ITALIC_WIDTHS,
  'Times-BoldItalic': TIMES_BOLDITALIC_WIDTHS,
  'Courier': COURIER_WIDTHS,
  'Courier-Bold': COURIER_WIDTHS,
  'Courier-Oblique': COURIER_WIDTHS,
  'Courier-BoldOblique': COURIER_WIDTHS,
  'Symbol': SYMBOL_WIDTHS,
  'ZapfDingbats': ZAPF_WIDTHS,
};

// Abbreviated /DA font names (PDF 32000-1 Annex used by Acrobat) -> StdFont.
const ABBREV: Record<string, StdFont> = {
  Helv: 'Helvetica', HeBo: 'Helvetica-Bold', HeOb: 'Helvetica-Oblique', HeBO: 'Helvetica-BoldOblique',
  Cour: 'Courier', CoBo: 'Courier-Bold', CoOb: 'Courier-Oblique', CoBO: 'Courier-BoldOblique',
  TiRo: 'Times-Roman', TiBo: 'Times-Bold', TiIt: 'Times-Italic', TiBI: 'Times-BoldItalic',
  Symb: 'Symbol', ZaDb: 'ZapfDingbats',
};

const STD: readonly StdFont[] = Object.keys(WIDTHS) as StdFont[];

export function normalizeFont(baseFont: string): StdFont {
  const raw = baseFont.includes('+') ? baseFont.slice(baseFont.indexOf('+') + 1) : baseFont;
  if (raw in ABBREV) return ABBREV[raw];
  for (const f of STD) if (f === raw) return f;
  // common aliases
  if (raw === 'Arial') return 'Helvetica';
  if (raw === 'Arial-Bold' || raw === 'Arial,Bold') return 'Helvetica-Bold';
  if (raw === 'Times' || raw === 'TimesNewRoman') return 'Times-Roman';
  return 'Helvetica';
}

export function glyphWidth(font: StdFont, code: number): number {
  return WIDTHS[font][code] ?? 0;
}

export function measure(font: StdFont, bytes: Uint8Array, fontSize: number): number {
  let units = 0;
  for (const b of bytes) units += WIDTHS[font][b] ?? 0;
  return (units / 1000) * fontSize;
}
```

Update the existing `measureWinAnsi` to delegate:

```ts
export function measureWinAnsi(bytes: Uint8Array, fontSize: number): number {
  return measure('Helvetica', bytes, fontSize);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/metrics.test.ts`
Expected: PASS. Then `npx vitest run test/stamp.test.ts` — still green (shim unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "feat: Standard-14 font metrics (measure/glyphWidth/normalizeFont)"
```

---

### Task 2: `/DA` string parser

Parse a default-appearance string into font name, size, and RGB color.

**Files:**
- Create: `src/da.ts`
- Test: `test/da.test.ts`

**Interfaces:**
- Consumes: `Lexer` from `./lexer.js` (token stream); existing token kinds.
- Produces:
  - `interface DA { fontName: string; size: number; color: [number, number, number] }`
  - `function parseDA(s: string): DA` — last-wins scan; size `0` means auto; default color black `[0,0,0]`; default font `'Helv'`, size `0`.

- [ ] **Step 1: Write the failing test**

```ts
// test/da.test.ts
import { describe, it, expect } from 'vitest';
import { parseDA } from '../src/da.js';

describe('parseDA', () => {
  it('reads font, size and rgb', () => {
    expect(parseDA('/Helv 12 Tf 1 0 0 rg')).toEqual({
      fontName: 'Helv', size: 12, color: [1, 0, 0],
    });
  });
  it('reads gray', () => {
    expect(parseDA('/TiRo 0 Tf 0.25 g')).toEqual({
      fontName: 'TiRo', size: 0, color: [0.25, 0.25, 0.25],
    });
  });
  it('converts cmyk to rgb', () => {
    // 0 0 0 1 k -> black
    expect(parseDA('/Cour 8 Tf 0 0 0 1 k').color).toEqual([0, 0, 0]);
  });
  it('uses defaults for an empty/garbage string', () => {
    expect(parseDA('')).toEqual({ fontName: 'Helv', size: 0, color: [0, 0, 0] });
    expect(parseDA('garbage here')).toEqual({ fontName: 'Helv', size: 0, color: [0, 0, 0] });
  });
  it('keeps the last of repeated operators', () => {
    expect(parseDA('/Helv 6 Tf /Cour 10 Tf')).toMatchObject({ fontName: 'Cour', size: 10 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/da.test.ts`
Expected: FAIL — `../src/da.js` not found.

- [ ] **Step 3: Implement `parseDA`**

Use the existing `Lexer` to tokenize, collecting a flat list of operands (numbers and names) and operator keywords, applying operators against the preceding operands (a tiny content-stream interpreter limited to `Tf`/`g`/`rg`/`k`). Check `lexer.ts` for the exact token shape and adapt the operand collection accordingly.

```ts
// src/da.ts
import { Lexer } from './lexer.js';

export interface DA {
  fontName: string;
  size: number;
  color: [number, number, number];
}

export function parseDA(s: string): DA {
  const da: DA = { fontName: 'Helv', size: 0, color: [0, 0, 0] };
  const operands: Array<number | string> = []; // numbers, or names (font keys without '/')
  const lex = new Lexer(new TextEncoder().encode(s));
  for (;;) {
    const tok = lex.next();
    if (tok === undefined || tok.kind === 'eof') break;
    switch (tok.kind) {
      case 'number': operands.push(tok.value); break;
      case 'name': operands.push(tok.name); break; // font name token, e.g. 'Helv'
      case 'keyword': {
        const op = tok.value;
        if (op === 'Tf' && operands.length >= 2) {
          const size = operands[operands.length - 1];
          const fn = operands[operands.length - 2];
          if (typeof size === 'number') da.size = size;
          if (typeof fn === 'string') da.fontName = fn;
        } else if (op === 'g' && operands.length >= 1) {
          const v = operands[operands.length - 1];
          if (typeof v === 'number') da.color = [v, v, v];
        } else if (op === 'rg' && operands.length >= 3) {
          const [r, g, b] = operands.slice(-3);
          if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number')
            da.color = [r, g, b];
        } else if (op === 'k' && operands.length >= 4) {
          const [c, m, y, kk] = operands.slice(-4);
          if ([c, m, y, kk].every((n) => typeof n === 'number')) {
            const cc = c as number, mm = m as number, yy = y as number, kv = kk as number;
            da.color = [(1 - cc) * (1 - kv), (1 - mm) * (1 - kv), (1 - yy) * (1 - kv)];
          }
        }
        operands.length = 0;
        break;
      }
      default: break;
    }
  }
  return da;
}
```

> Note: token kind/field names (`tok.kind`, `tok.value`, `tok.name`) must match `lexer.ts`. If they differ, adjust the `switch` accordingly — the logic (operands → operator, last wins) is unchanged. Verify against `src/lexer.ts` before writing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/da.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/da.ts test/da.test.ts
git commit -m "feat: /DA default-appearance string parser"
```

---

### Task 3: `resolveDA` — field DA resolution + font mapping

Resolve the effective `DA` for a field (field → AcroForm → default) and map its font name to a `StdFont` via the AcroForm `/DR /Font` `/BaseFont`.

**Files:**
- Modify: `src/da.ts`
- Test: `test/da.test.ts` (append)

**Interfaces:**
- Consumes: `parseDA`, `DA` (Task 2); `normalizeFont`, `StdFont` (Task 1); `Document` (`resolve`, dict access); guards from `types.ts`.
- Produces:
  - `interface ResolvedDA { fontName: string; std: StdFont; size: number; color: [number, number, number] }`
  - `function resolveDA(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): ResolvedDA` — picks the DA string (field `/DA`, else AcroForm `/DA`, else `'/Helv 0 Tf 0 g'`), parses it, then resolves `fontName` to a `StdFont` by reading `acroForm /DR /Font /<fontName> /BaseFont`; if absent, `normalizeFont(fontName)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/da.test.ts (append)
import { resolveDA } from '../src/da.js';
import { Document } from '../src/document.js';
import { name } from '../src/types.js';

function str(s: string) { return { kind: 'string' as const, bytes: new TextEncoder().encode(s) }; }

describe('resolveDA', () => {
  it('prefers the field DA and maps DR font to a StdFont', () => {
    const doc = Document.New(); // empty doc with a catalog
    const fontDict = new Map<string, any>([['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('Times-Bold')]]);
    const dr = new Map<string, any>([['Font', new Map([['F1', fontDict]])]]);
    const acro = new Map<string, any>([['DR', dr], ['DA', str('/Helv 10 Tf 0 g')]]);
    const field = new Map<string, any>([['DA', str('/F1 14 Tf 0 0 1 rg')]]);
    const r = resolveDA(doc, field, acro);
    expect(r).toMatchObject({ fontName: 'F1', std: 'Times-Bold', size: 14, color: [0, 0, 1] });
  });

  it('falls back to AcroForm DA then default', () => {
    const doc = Document.New();
    const acro = new Map<string, any>([['DA', str('/Cour 9 Tf 0.5 g')]]);
    const field = new Map<string, any>();
    expect(resolveDA(doc, field, acro)).toMatchObject({ std: 'Courier', size: 9 });

    const bare = resolveDA(doc, new Map(), new Map());
    expect(bare).toMatchObject({ std: 'Helvetica', size: 0, color: [0, 0, 0] });
  });
});
```

> If `Document.New()` is not the actual constructor for an empty doc, use whatever `document.ts` exposes (check `document.ts`; e.g. there is a factory around line 124 that builds a catalog). `resolveDA` only calls `doc.resolve`, so any `Document` with a working `resolve` suffices.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/da.test.ts`
Expected: FAIL — `resolveDA` not exported.

- [ ] **Step 3: Implement `resolveDA`**

```ts
// src/da.ts (append)
import type { Document } from './document.js';
import { PdfDict, isDict, isName, isString } from './types.js';
import { normalizeFont, type StdFont } from './metrics.js';

export interface ResolvedDA {
  fontName: string;
  std: StdFont;
  size: number;
  color: [number, number, number];
}

function daString(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): string {
  const fv = doc.resolve(fieldDict.get('DA'));
  if (isString(fv)) return new TextDecoder('latin1').decode(fv.bytes);
  const av = doc.resolve(acroForm.get('DA'));
  if (isString(av)) return new TextDecoder('latin1').decode(av.bytes);
  return '/Helv 0 Tf 0 g';
}

function drBaseFont(doc: Document, acroForm: PdfDict, fontName: string): string | undefined {
  const dr = doc.resolve(acroForm.get('DR'));
  if (!isDict(dr)) return undefined;
  const fonts = doc.resolve(dr.get('Font'));
  if (!isDict(fonts)) return undefined;
  const fd = doc.resolve(fonts.get(fontName));
  if (!isDict(fd)) return undefined;
  const bf = doc.resolve(fd.get('BaseFont'));
  return isName(bf) ? bf.name : undefined;
}

export function resolveDA(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): ResolvedDA {
  const da = parseDA(daString(doc, fieldDict, acroForm));
  const baseFont = drBaseFont(doc, acroForm, da.fontName);
  const std = normalizeFont(baseFont ?? da.fontName);
  return { fontName: da.fontName, std, size: da.size, color: da.color };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/da.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/da.ts test/da.test.ts
git commit -m "feat: resolveDA field/AcroForm DA resolution + DR font mapping"
```

---

### Task 4: Appearance envelope + MK painting

The shared form-XObject builder: BBox/Matrix/Resources assembly, font registration, MK background/border painting, and installing the stream at `widget /AP /N`. This task produces the scaffolding plus a trivial empty body so it is independently testable; per-type bodies come in Tasks 5–8.

**Files:**
- Create: `src/appearance.ts`
- Test: `test/appearance.test.ts`

**Interfaces:**
- Consumes: `ResolvedDA` (Task 3); `num`, `streamOf`, `freshKey` from `./pagecontent.js`; `enc`, `serializeString` from `./serialize.js`; `Document`; `types.ts` guards; `parseContentStream` from `./content.js` (tests only).
- Produces (module-internal, used by later tasks within `appearance.ts`):
  - `interface WidgetGeom { w: number; h: number; rotate: 0 | 90 | 180 | 270 }`
  - `function widgetGeom(doc, widget): WidgetGeom | undefined` — from `/Rect` (normalized abs) and `/MK /R`; `undefined` for missing/zero-area rect.
  - `function fontResources(doc, std: StdFont, key: string): PdfDict` — `<< /Font << <key> <type1dict> >> >>`.
  - `function mkOps(doc, widget, g: WidgetGeom): { ops: string; inset: number }` — content string painting `/MK /BG` fill + `/BC` border; `inset` = border width (0 if none).
  - `function buildAppearanceXObject(doc, g, std, fontKey, body): PdfStream` — assembles `/Type/XObject /Subtype/Form /FormType 1 /BBox /Matrix /Resources` + content (`q` MK + body `Q`).
  - `function installAP(doc, widget, stream): void` — sets `widget /AP /N` to a fresh stream ref (single state).
  - `function installAPState(doc, widget, state, stream): void` — sets `widget /AP /N /<state>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/appearance.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { parseContentStream } from '../src/content.js';
import { isStream, isDict, isName } from '../src/types.js';
import {
  widgetGeom, buildAppearanceXObject, fontResources, mkOps, installAP,
} from '../src/appearance.js';

function widget(doc: Document, objNum: number) {
  return doc.resolve({ kind: 'ref', num: objNum, gen: 0 }) as Map<string, any>;
}

describe('appearance envelope', () => {
  it('computes geometry from /Rect', () => {
    const doc = Document.Open(buildFormPdf());
    const g = widgetGeom(doc, widget(doc, 6)); // Rect [10 10 200 30]
    expect(g).toEqual({ w: 190, h: 20, rotate: 0 });
  });

  it('returns undefined for a zero-area/missing rect', () => {
    const doc = Document.Open(buildFormPdf());
    const w = new Map<string, any>(); // no /Rect
    expect(widgetGeom(doc, w)).toBeUndefined();
  });

  it('builds a /Form XObject with BBox, Matrix and Resources', () => {
    const doc = Document.Open(buildFormPdf());
    const g = { w: 190, h: 20, rotate: 0 as const };
    const res = fontResources(doc, 'Helvetica', 'Helv');
    const xobj = buildAppearanceXObject(doc, g, 'Helvetica', 'Helv', 'BT /Helv 12 Tf ET');
    expect(isStream(xobj)).toBe(true);
    expect(isName(xobj.dict.get('Subtype')) && (xobj.dict.get('Subtype') as any).name).toBe('Form');
    expect(xobj.dict.get('BBox')).toEqual([0, 0, 190, 20]);
    expect(isDict(xobj.dict.get('Resources'))).toBe(true);
    const text = new TextDecoder().decode(xobj.raw);
    expect(text).toContain('/Helv 12 Tf');
  });

  it('installs /AP /N as a stream ref on the widget', () => {
    const doc = Document.Open(buildFormPdf());
    const w = widget(doc, 6);
    const g = { w: 190, h: 20, rotate: 0 as const };
    const xobj = buildAppearanceXObject(doc, g, 'Helvetica', 'Helv', '');
    installAP(doc, w, xobj);
    const ap = doc.resolve(w.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N'));
    expect(isStream(n)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/appearance.test.ts`
Expected: FAIL — `../src/appearance.js` not found.

- [ ] **Step 3: Implement the envelope**

```ts
// src/appearance.ts
import type { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfStream, isDict, isArray, name,
} from './types.js';
import { num, streamOf, freshKey } from './pagecontent.js';
import { enc } from './serialize.js';
import type { StdFont } from './metrics.js';

export interface WidgetGeom { w: number; h: number; rotate: 0 | 90 | 180 | 270 }

function nums(doc: Document, o: PdfObject | undefined, n: number): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a) || a.length < n) return undefined;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = doc.resolve(a[i]);
    if (typeof v !== 'number') return undefined;
    out.push(v);
  }
  return out;
}

export function widgetGeom(doc: Document, widget: PdfDict): WidgetGeom | undefined {
  const r = nums(doc, widget.get('Rect'), 4);
  if (!r) return undefined;
  const w = Math.abs(r[2] - r[0]);
  const h = Math.abs(r[3] - r[1]);
  if (w < 1e-3 || h < 1e-3) return undefined;
  let rotate: 0 | 90 | 180 | 270 = 0;
  const mk = doc.resolve(widget.get('MK'));
  if (isDict(mk)) {
    const rr = doc.resolve(mk.get('R'));
    if (rr === 90 || rr === 180 || rr === 270) rotate = rr;
  }
  return { w, h, rotate };
}

export function fontResources(doc: Document, std: StdFont, key: string): PdfDict {
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name(std)],
    ['Encoding', name('WinAnsiEncoding')],
  ]);
  const fonts: PdfDict = new Map([[key, doc.allocObject(fontDict)]]);
  return new Map<string, PdfObject>([['Font', fonts]]);
}

function colorArr(doc: Document, o: PdfObject | undefined): number[] | undefined {
  const a = doc.resolve(o);
  if (!isArray(a)) return undefined;
  const out: number[] = [];
  for (const e of a) { const v = doc.resolve(e); if (typeof v === 'number') out.push(v); }
  return out.length ? out : undefined;
}

function setColorOp(c: number[], stroke: boolean): string {
  if (c.length === 1) return `${num(c[0])} ${stroke ? 'G' : 'g'}`;
  if (c.length === 4)
    return `${num(c[0])} ${num(c[1])} ${num(c[2])} ${num(c[3])} ${stroke ? 'K' : 'k'}`;
  return `${num(c[0] ?? 0)} ${num(c[1] ?? 0)} ${num(c[2] ?? 0)} ${stroke ? 'RG' : 'rg'}`;
}

export function mkOps(doc: Document, widget: PdfDict, g: WidgetGeom): { ops: string; inset: number } {
  const mk = doc.resolve(widget.get('MK'));
  if (!isDict(mk)) return { ops: '', inset: 0 };
  let ops = '';
  const bg = colorArr(doc, mk.get('BG'));
  if (bg) ops += `${setColorOp(bg, false)} 0 0 ${num(g.w)} ${num(g.h)} re f\n`;
  let inset = 0;
  const bc = colorArr(doc, mk.get('BC'));
  if (bc) {
    let bw = 1;
    const bs = doc.resolve(widget.get('BS'));
    if (isDict(bs)) { const wv = doc.resolve(bs.get('W')); if (typeof wv === 'number') bw = wv; }
    if (bw > 0) {
      inset = bw;
      const half = bw / 2;
      ops += `${setColorOp(bc, true)} ${num(bw)} w ` +
        `${num(half)} ${num(half)} ${num(g.w - bw)} ${num(g.h - bw)} re S\n`;
    }
  }
  return { ops, inset };
}

// `body` is the already-composed content: callers pass `mk.ops + typeBody`.
export function buildAppearanceXObject(
  doc: Document, g: WidgetGeom, std: StdFont, fontKey: string, body: string,
): PdfStream {
  const content = `q\n${body}\nQ`;
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('XObject')],
    ['Subtype', name('Form')],
    ['FormType', 1],
    ['BBox', [0, 0, g.w, g.h]],
    ['Matrix', matrixFor(g)],
    ['Resources', fontResources(doc, std, fontKey)],
  ]);
  return { kind: 'stream', dict, raw: enc(content) };
}

function matrixFor(g: WidgetGeom): number[] {
  switch (g.rotate) {
    case 90: return [0, 1, -1, 0, g.w, 0];
    case 180: return [-1, 0, 0, -1, g.w, g.h];
    case 270: return [0, -1, 1, 0, 0, g.h];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

export function installAP(doc: Document, widget: PdfDict, stream: PdfStream): void {
  const ref = doc.allocObject(stream);
  widget.set('AP', new Map<string, PdfObject>([['N', ref]]));
}

export function installAPState(doc: Document, widget: PdfDict, state: string, stream: PdfStream): void {
  const ref = doc.allocObject(stream);
  let ap = doc.resolve(widget.get('AP'));
  if (!isDict(ap)) { ap = new Map<string, PdfObject>(); widget.set('AP', ap); }
  let n = doc.resolve((ap as PdfDict).get('N'));
  if (!isDict(n)) { n = new Map<string, PdfObject>(); (ap as PdfDict).set('N', n); }
  (n as PdfDict).set(state, ref);
}
```

> **Note:** `buildAppearanceXObject` takes the **already-composed** body — callers build `mk.ops + typeBody` and pass it in (the dispatcher in Task 5 does exactly this). `num`, `streamOf`, `freshKey` are exported from `pagecontent.ts`; `streamOf`/`freshKey` are imported for use by later tasks. Keep `matrixFor`/`installAP`/`installAPState` as shown.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/appearance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/appearance.ts test/appearance.test.ts
git commit -m "feat: appearance XObject envelope + MK background/border painting"
```

---

### Task 5: Single-line text field appearance

Generate the text body for single-line `Tx` fields: `/Q` alignment, vertical centering, DA color/size, and auto-size when size is 0.

**Files:**
- Modify: `src/appearance.ts`
- Test: `test/appearance.test.ts` (append)

**Interfaces:**
- Consumes: `ResolvedDA` (Task 3); `measure` (Task 1); `encodeWinAnsi` from `./encoding.js`; `serializeString` from `./serialize.js`; envelope helpers (Task 4).
- Produces:
  - `function generateFieldAppearance(doc: Document, acroForm: PdfDict, fieldDict: PdfDict, type: FieldType, ff: number, value: PdfObject): void` — the public entry the form module calls. This task implements the single-line `text` branch; later tasks extend the `switch`.
  - `type FieldType` imported from `./form.js` (avoid a cycle: `form.ts` imports `appearance.ts`, so `appearance.ts` must import only the **type** `FieldType` — `import type { FieldType } from './form.js'`).

- [ ] **Step 1: Write the failing test**

```ts
// test/appearance.test.ts (append)
import { generateFieldAppearance } from '../src/appearance.js';
import { parseContentStream } from '../src/content.js';

function apStreamText(doc: Document, widget: Map<string, any>): string {
  const ap = doc.resolve(widget.get('AP')) as Map<string, any>;
  const n = doc.resolve(ap.get('N')) as any;
  return new TextDecoder().decode(n.raw);
}

describe('single-line text appearance', () => {
  it('emits BT/Tf/Tj/ET with the value', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    const field = doc.resolve({ kind: 'ref', num: 6, gen: 0 }) as Map<string, any>; // text 'Bob'
    generateFieldAppearance(doc, acro, field, 'text', 0, doc.resolve(field.get('V')));
    const t = apStreamText(doc, field);
    const ops = parseContentStream(new TextEncoder().encode(t)).map((o) => o.operator);
    expect(ops).toEqual(expect.arrayContaining(['BT', 'Tf', 'Td', 'Tj', 'ET']));
    expect(t).toContain('(Bob)');
  });

  it('right-aligns when /Q is 2', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    const field = doc.resolve({ kind: 'ref', num: 6, gen: 0 }) as Map<string, any>;
    field.set('Q', 2);
    generateFieldAppearance(doc, acro, field, 'text', 0, doc.resolve(field.get('V')));
    // Td x-offset should be > half the box width for right alignment of a short string
    const t = apStreamText(doc, field);
    const m = t.match(/([\d.]+) [\d.]+ Td/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(90); // box width 190
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/appearance.test.ts -t "single-line text"`
Expected: FAIL — `generateFieldAppearance` not exported.

- [ ] **Step 3: Implement the text branch + dispatcher**

```ts
// src/appearance.ts (append)
import type { FieldType } from './form.js';
import { isString, isName } from './types.js';
import { encodeWinAnsi } from './encoding.js';
import { serializeString } from './serialize.js';
import { measure } from './metrics.js';
import { resolveDA, type ResolvedDA } from './da.js';
import { decodePdfText } from './metadata.js';

const PAD = 2; // internal horizontal padding, points

function autoSize(text: Uint8Array, std: StdFont, boxW: number, boxH: number): number {
  // Largest size that fits height (~0.85*h capped at 12) and width.
  let size = Math.min(12, boxH * 0.85);
  const w = measure(std, text, size);
  const avail = boxW - 2 * PAD;
  if (w > avail && w > 0) size = Math.max(4, (size * avail) / w);
  return size;
}

function singleLineText(
  text: string, da: ResolvedDA, g: WidgetGeom, q: number, inset: number,
): string {
  const bytes = encodeWinAnsi(text);
  const size = da.size > 0 ? da.size : autoSize(bytes, da.std, g.w, g.h);
  const tw = measure(da.std, bytes, size);
  const avail = g.w - 2 * (PAD + inset);
  let x = PAD + inset;
  if (q === 1) x = inset + (g.w - 2 * inset - tw) / 2;
  else if (q === 2) x = g.w - inset - PAD - tw;
  if (x < inset + PAD) x = inset + PAD;
  const y = (g.h - size * 0.7) / 2 + size * 0.2 < inset ? inset + 2 : (g.h - size) / 2 + size * 0.2;
  const [r, gg, b] = da.color;
  return `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n` +
    `${num(x)} ${num(y)} Td\n${serializeString(bytes)} Tj\nET`;
}

function qOf(doc: Document, fieldDict: PdfDict, acroForm: PdfDict): number {
  const q = doc.resolve(fieldDict.get('Q'));
  if (typeof q === 'number') return q;
  const aq = doc.resolve(acroForm.get('Q'));
  return typeof aq === 'number' ? aq : 0;
}

function textOf(doc: Document, value: PdfObject): string {
  if (isString(value)) return decodePdfText(value.bytes);
  if (isName(value)) return value.name;
  return '';
}

function widgetsOf(doc: Document, fieldDict: PdfDict): PdfDict[] {
  const kids = doc.resolve(fieldDict.get('Kids'));
  if (!isArray(kids)) return [fieldDict];
  const out: PdfDict[] = [];
  for (const k of kids) { const d = doc.resolve(k); if (isDict(d)) out.push(d); }
  return out.length ? out : [fieldDict];
}

export function generateFieldAppearance(
  doc: Document, acroForm: PdfDict, fieldDict: PdfDict,
  type: FieldType, ff: number, value: PdfObject,
): void {
  const da = resolveDA(doc, fieldDict, acroForm);
  const q = qOf(doc, fieldDict, acroForm);
  for (const widget of widgetsOf(doc, fieldDict)) {
    const g = widgetGeom(doc, widget);
    if (!g) continue;
    const mk = mkOps(doc, widget, g);
    let body: string | undefined;
    switch (type) {
      case 'text':
        body = singleLineText(textOf(doc, value), da, g, q, mk.inset);
        break;
      default:
        body = undefined; // other types handled in later tasks
    }
    if (body === undefined) continue;
    const stream = buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops + body);
    installAP(doc, widget, stream);
  }
}
```

> The font resource key is always `'Helv'` and the font dict is the resolved `da.std` BaseFont (so `/Helv` in the content maps to e.g. Times-Bold). This keeps the content-stream `Tf` operator name stable while honoring the resolved font.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/appearance.test.ts -t "single-line text"`
Expected: PASS. Then run the whole file: `npx vitest run test/appearance.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/appearance.ts test/appearance.test.ts
git commit -m "feat: single-line text field appearance generation"
```

---

### Task 6: Multiline word-wrap + auto-size

Add the multiline `Tx` branch (Ff bit 13, `1 << 12`): greedy word-wrap, top-aligned, with auto-size shrinking to fit all lines.

**Files:**
- Modify: `src/appearance.ts`
- Test: `test/appearance.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 helpers (`measure`, `encodeWinAnsi`, `serializeString`, `num`).
- Produces: extends `generateFieldAppearance`’s `text` branch to dispatch on the multiline flag; internal `function multilineText(text, da, g, inset): string`.

- [ ] **Step 1: Write the failing test**

```ts
// test/appearance.test.ts (append)
describe('multiline text appearance', () => {
  const FF_MULTILINE = 1 << 12;
  it('wraps into multiple Tj lines via TL/T* or multiple Td', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    const field = doc.resolve({ kind: 'ref', num: 6, gen: 0 }) as Map<string, any>;
    const long = 'the quick brown fox jumps over the lazy dog again and again';
    field.set('V', { kind: 'string', bytes: new TextEncoder().encode(long) });
    field.set('Ff', FF_MULTILINE);
    generateFieldAppearance(doc, acro, field, 'text', FF_MULTILINE, doc.resolve(field.get('V')));
    const ap = doc.resolve(field.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const t = new TextDecoder().decode(n.raw);
    const tjCount = (t.match(/Tj/g) ?? []).length;
    expect(tjCount).toBeGreaterThan(1); // wrapped onto several lines
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/appearance.test.ts -t "multiline text"`
Expected: FAIL — single `Tj` only (multiline not yet branched).

- [ ] **Step 3: Implement multiline**

Add the flag constant and the wrap helper, and branch in the dispatcher:

```ts
// src/appearance.ts — add near the top-level constants
const FF_MULTILINE = 1 << 12;

// src/appearance.ts — add helper
function wrapLines(words: string[], std: StdFont, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (measure(std, encodeWinAnsi(trial), size) <= maxW || cur === '') cur = trial;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function multilineText(text: string, da: ResolvedDA, g: WidgetGeom, inset: number): string {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const maxW = g.w - 2 * (PAD + inset);
  let size = da.size > 0 ? da.size : 12;
  const leading = () => size * 1.15;
  // Auto-size: shrink until all wrapped lines fit the box height.
  for (;;) {
    const lines = wrapLines(words, da.std, size, maxW);
    if (lines.length * leading() <= g.h - 2 * inset || size <= 4) {
      const [r, gg, b] = da.color;
      const top = g.h - inset - PAD - size * 0.8;
      let s = `BT\n/Helv ${num(size)} Tf\n${num(leading())} TL\n` +
        `${num(r)} ${num(gg)} ${num(b)} rg\n${num(PAD + inset)} ${num(top)} Td\n`;
      lines.forEach((ln, i) => {
        if (i > 0) s += 'T*\n';
        s += `${serializeString(encodeWinAnsi(ln))} Tj\n`;
      });
      return s + 'ET';
    }
    size = Math.max(4, size - 0.5);
  }
}
```

Branch in `generateFieldAppearance`’s `text` case:

```ts
      case 'text':
        body = (ff & FF_MULTILINE)
          ? multilineText(textOf(doc, value), da, g, mk.inset)
          : singleLineText(textOf(doc, value), da, g, q, mk.inset);
        break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/appearance.test.ts -t "multiline text"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/appearance.ts test/appearance.test.ts
git commit -m "feat: multiline word-wrap text appearance with auto-size"
```

---

### Task 7: Comb fields

Add the comb branch (Ff bit 25, `1 << 24`, needs `/MaxLen`): one glyph centered per evenly-spaced cell.

**Files:**
- Modify: `src/appearance.ts`
- Test: `test/appearance.test.ts` (append)

**Interfaces:**
- Consumes: Task 5/6 helpers.
- Produces: extends the `text` branch with a comb sub-branch; internal `function combText(text, da, g, maxLen, inset): string`.

- [ ] **Step 1: Write the failing test**

```ts
// test/appearance.test.ts (append)
describe('comb text appearance', () => {
  const FF_COMB = 1 << 24;
  it('emits one Tj per character positioned in cells', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    const field = doc.resolve({ kind: 'ref', num: 6, gen: 0 }) as Map<string, any>;
    field.set('V', { kind: 'string', bytes: new TextEncoder().encode('ABCD') });
    field.set('Ff', FF_COMB);
    field.set('MaxLen', 5);
    generateFieldAppearance(doc, acro, field, 'text', FF_COMB, doc.resolve(field.get('V')));
    const ap = doc.resolve(field.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const t = new TextDecoder().decode(n.raw);
    expect((t.match(/Tj/g) ?? []).length).toBe(4); // one per char
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/appearance.test.ts -t "comb text"`
Expected: FAIL — comb not branched (single `Tj`).

- [ ] **Step 3: Implement comb**

```ts
// src/appearance.ts — add constant + helper
const FF_COMB = 1 << 24;

function combText(text: string, da: ResolvedDA, g: WidgetGeom, maxLen: number, inset: number): string {
  const chars = [...text].slice(0, maxLen);
  const cellW = (g.w - 2 * inset) / maxLen;
  const size = da.size > 0 ? da.size : Math.min(g.h * 0.7, cellW * 0.9);
  const [r, gg, b] = da.color;
  const y = (g.h - size) / 2 + size * 0.2;
  let s = `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n`;
  let prevX = 0;
  chars.forEach((ch, i) => {
    const bytes = encodeWinAnsi(ch);
    const cw = measure(da.std, bytes, size);
    const cellCenter = inset + cellW * (i + 0.5);
    const x = cellCenter - cw / 2;
    const dx = x - prevX;
    const dy = i === 0 ? y : 0;
    s += `${num(dx)} ${num(dy)} Td\n${serializeString(bytes)} Tj\n`;
    prevX = x;
  });
  return s + 'ET';
}
```

Branch in the `text` case (comb takes priority when flagged and `/MaxLen` present):

```ts
      case 'text': {
        const maxLenRaw = doc.resolve(fieldDict.get('MaxLen'));
        const maxLen = typeof maxLenRaw === 'number' ? maxLenRaw : 0;
        if ((ff & FF_COMB) && maxLen > 0 && !(ff & FF_MULTILINE))
          body = combText(textOf(doc, value), da, g, maxLen, mk.inset);
        else if (ff & FF_MULTILINE)
          body = multilineText(textOf(doc, value), da, g, mk.inset);
        else
          body = singleLineText(textOf(doc, value), da, g, q, mk.inset);
        break;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/appearance.test.ts -t "comb text"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/appearance.ts test/appearance.test.ts
git commit -m "feat: comb field appearance generation"
```

---

### Task 8: Checkbox/radio synthesis + choice fields

Add the `checkbox`, `radio`, and `choice` branches. Buttons: preserve existing `/AP /N` states, synthesize only when missing. Choice: combo renders like single-line text; list renders the option list with highlighted selection.

**Files:**
- Modify: `src/appearance.ts`
- Test: `test/appearance.test.ts` (append)

**Interfaces:**
- Consumes: Task 4–6 helpers; `installAPState`; `measure`.
- Produces: button + choice branches in `generateFieldAppearance`; internal `function buttonStates(...)`, `function comboText(...)`, `function listBox(...)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/appearance.test.ts (append)
describe('button + choice appearance', () => {
  const FF_COMBO = 1 << 17;
  it('preserves existing checkbox AP states', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    const field = doc.resolve({ kind: 'ref', num: 7, gen: 0 }) as Map<string, any>; // has AP Yes/Off
    const before = doc.resolve(field.get('AP'));
    generateFieldAppearance(doc, acro, field, 'checkbox', 0, doc.resolve(field.get('V')));
    expect(doc.resolve(field.get('AP'))).toBe(before); // untouched
  });

  it('renders a combo box selected value', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    // editable combo `font` obj 17 has no Rect/widget; give it one
    const field = doc.resolve({ kind: 'ref', num: 11, gen: 0 }) as Map<string, any>; // choice 'size' V=M
    field.set('Ff', FF_COMBO);
    generateFieldAppearance(doc, acro, field, 'choice', FF_COMBO, doc.resolve(field.get('V')));
    const ap = doc.resolve(field.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    expect(new TextDecoder().decode(n.raw)).toContain('(M)');
  });

  it('renders a list box with a highlight rect for the selection', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    const field = doc.resolve({ kind: 'ref', num: 11, gen: 0 }) as Map<string, any>; // list (no combo flag)
    field.set('Ff', 0);
    generateFieldAppearance(doc, acro, field, 'choice', 0, doc.resolve(field.get('V')));
    const ap = doc.resolve(field.get('AP')) as Map<string, any>;
    const n = doc.resolve(ap.get('N')) as any;
    const t = new TextDecoder().decode(n.raw);
    expect(t).toContain(' re'); // highlight rectangle
    expect(t).toContain('(M)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/appearance.test.ts -t "button + choice"`
Expected: FAIL — branches return `undefined`.

- [ ] **Step 3: Implement button + choice branches**

```ts
// src/appearance.ts — constants
const FF_COMBO = 1 << 17;
const ZADB_CHECK = '4'; // ZapfDingbats check
const ZADB_CIRCLE = 'l'; // ZapfDingbats circle (radio)

function hasNStates(doc: Document, widget: PdfDict): boolean {
  const ap = doc.resolve(widget.get('AP'));
  if (!isDict(ap)) return false;
  const n = doc.resolve(ap.get('N'));
  return isDict(n) && n.size > 0;
}

function onStateName(doc: Document, fieldDict: PdfDict, widget: PdfDict): string {
  const opt = doc.resolve(fieldDict.get('Opt'));
  void opt;
  return 'On'; // synthesized default when no states exist
}

function glyphBody(glyph: string, g: WidgetGeom, inset: number): string {
  const size = Math.min(g.w, g.h) * 0.8;
  const bytes = encodeWinAnsi(glyph);
  const w = measure('ZapfDingbats', bytes, size);
  const x = (g.w - w) / 2;
  const y = (g.h - size) / 2 + size * 0.2;
  return `BT\n/ZaDb ${num(size)} Tf\n0 g\n${num(x)} ${num(y)} Td\n${serializeString(bytes)} Tj\nET`;
}

function zapfResources(doc: Document): PdfDict {
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type1')], ['BaseFont', name('ZapfDingbats')],
  ]);
  return new Map<string, PdfObject>([['Font', new Map([['ZaDb', doc.allocObject(fontDict)]])]]);
}

function comboText(doc: Document, value: PdfObject, da: ResolvedDA, g: WidgetGeom, inset: number): string {
  return singleLineText(textOf(doc, value), da, g, 0, inset);
}

function optionLabels(doc: Document, fieldDict: PdfDict): string[] {
  const opt = doc.resolve(fieldDict.get('Opt'));
  if (!isArray(opt)) return [];
  const out: string[] = [];
  for (const e of opt) {
    const r = doc.resolve(e);
    if (isArray(r)) { const disp = doc.resolve(r[1] ?? r[0]); if (isString(disp)) out.push(decodePdfText(disp.bytes)); }
    else if (isString(r)) out.push(decodePdfText(r.bytes));
  }
  return out;
}

function selectedIndices(doc: Document, fieldDict: PdfDict, labels: string[], value: PdfObject): Set<number> {
  const sel = new Set<number>();
  const iArr = doc.resolve(fieldDict.get('I'));
  if (isArray(iArr)) { for (const e of iArr) { const v = doc.resolve(e); if (typeof v === 'number') sel.add(v); } }
  if (sel.size === 0) {
    const v = textOf(doc, value);
    const idx = labels.indexOf(v);
    if (idx >= 0) sel.add(idx);
  }
  return sel;
}

function listBox(
  doc: Document, fieldDict: PdfDict, da: ResolvedDA, g: WidgetGeom, inset: number, value: PdfObject,
): string {
  const labels = optionLabels(doc, fieldDict);
  const size = da.size > 0 ? da.size : 12;
  const line = size * 1.15;
  const tiRaw = doc.resolve(fieldDict.get('TI'));
  const top = typeof tiRaw === 'number' ? tiRaw : 0;
  const sel = selectedIndices(doc, fieldDict, labels, value);
  const [r, gg, b] = da.color;
  let s = '';
  // highlight rects first (behind text)
  labels.forEach((_, i) => {
    if (i < top || !sel.has(i)) return;
    const row = i - top;
    const yTop = g.h - inset - row * line;
    s += `0.6 0.6 0.6 rg\n${num(inset)} ${num(yTop - line)} ${num(g.w - 2 * inset)} ${num(line)} re f\n`;
  });
  s += `BT\n/Helv ${num(size)} Tf\n${num(r)} ${num(gg)} ${num(b)} rg\n${num(line)} TL\n`;
  s += `${num(PAD + inset)} ${num(g.h - inset - size * 0.85)} Td\n`;
  labels.forEach((label, i) => {
    if (i < top) return;
    if (i > top) s += 'T*\n';
    s += `${serializeString(encodeWinAnsi(label))} Tj\n`;
  });
  return s + 'ET';
}
```

Extend the dispatcher’s `switch`. Note buttons need their own resources handling (ZapfDingbats) and per-state install, so they short-circuit the common single-stream install:

```ts
      case 'checkbox':
      case 'radio': {
        // Preserve author-supplied appearances; synthesize only when entirely missing.
        if (hasNStates(doc, widget)) { body = undefined; break; }
        const on = onStateName(doc, fieldDict, widget);
        const glyph = type === 'radio' ? ZADB_CIRCLE : ZADB_CHECK;
        const onStream = buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops + glyphBody(glyph, g, mk.inset));
        (onStream.dict.get('Resources') as PdfDict).set('Font',
          (zapfResources(doc).get('Font') as PdfDict));
        const offStream = buildAppearanceXObject(doc, g, da.std, 'Helv', mk.ops);
        installAPState(doc, widget, on, onStream);
        installAPState(doc, widget, 'Off', offStream);
        body = undefined; // already installed
        break;
      }
      case 'choice':
        body = (ff & FF_COMBO)
          ? comboText(doc, value, da, g, mk.inset)
          : listBox(doc, fieldDict, da, g, mk.inset, value);
        break;
```

> The button branch installs its own states and sets `body = undefined` so the common `installAP` at the end is skipped. The glyph stream merges a ZapfDingbats font into its `/Resources /Font` (alongside the inherited `/Helv`). Keep `onStateName` simple for v1 (returns `'On'`); when an existing partial state name is known from `form.ts`, callers in Task 9 pass the real value via `/AS` already.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/appearance.test.ts -t "button + choice"`
Expected: PASS. Then full file: `npx vitest run test/appearance.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/appearance.ts test/appearance.test.ts
git commit -m "feat: checkbox/radio synthesis + choice combo/list appearances"
```

---

### Task 9: Wire `form.ts` setters + `GenerateAppearance(s)`

Replace `NeedAppearances` flagging in the setters with appearance generation, and add the two public methods. This is where the live form model meets the generator.

**Files:**
- Modify: `src/form.ts`
- Modify: `README.md`
- Test: `test/form-appearance.test.ts` (create)

**Interfaces:**
- Consumes: `generateFieldAppearance` (Tasks 5–8); `Field`’s private `doc`, `acroForm`, `Dict`, `Type`, `ff` (already present).
- Produces:
  - `Field.GenerateAppearance(): void`
  - `Form.GenerateAppearances(): void`
  - Setters call `this.regen()` instead of `this.needAppearances()`.

- [ ] **Step 1: Write the failing test**

```ts
// test/form-appearance.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isStream, isDict } from '../src/types.js';

describe('form appearance integration', () => {
  it('setter generates /AP and does not set NeedAppearances', () => {
    const doc = Document.Open(buildFormPdf());
    const field = doc.Form.Get('name')!;
    field.Value = 'Alice';
    const apN = doc.resolve((field.Dict.get('AP') as any));
    expect(isDict(apN)).toBe(true);
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    expect(acro.has('NeedAppearances')).toBe(false);
  });

  it('GenerateAppearances builds all and clears the global flag', () => {
    const doc = Document.Open(buildFormPdf());
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, any>;
    acro.set('NeedAppearances', true);
    doc.Form.GenerateAppearances();
    expect(acro.has('NeedAppearances')).toBe(false);
    const name = doc.Form.Get('name')!;
    expect(isDict(doc.resolve(name.Dict.get('AP')))).toBe(true);
  });

  it('round-trips through Save', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Value = 'Roundtrip';
    const out = doc.Save();
    const re = Document.Open(out);
    const fld = re.Form.Get('name')!;
    expect(fld.Value).toBe('Roundtrip');
    expect(isDict(re.resolve(fld.Dict.get('AP')))).toBe(true);
  });

  it('round-trips compressed', () => {
    const doc = Document.Open(buildFormPdf());
    doc.Form.Get('name')!.Value = 'Zipped';
    const re = Document.Open(doc.Save({ compressed: true }));
    expect(re.Form.Get('name')!.Value).toBe('Zipped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/form-appearance.test.ts`
Expected: FAIL — `Form.GenerateAppearances` missing; setter still sets `NeedAppearances`.

- [ ] **Step 3: Wire `form.ts`**

In `src/form.ts`:

1. Add the import:

```ts
import { generateFieldAppearance } from './appearance.js';
```

2. Add a private `regen()` on `Field` and a public `GenerateAppearance()`; replace the body of `needAppearances()` usages:

```ts
  /** Regenerate this field's appearance stream(s) from its current value. */
  GenerateAppearance(): void {
    generateFieldAppearance(this.doc, this.acroForm, this.Dict, this.Type, this.ff, this.rawValue());
  }

  private regen(): void {
    this.GenerateAppearance();
  }
```

3. In `setText`, `setCheckbox`, `setRadio`, `setChoice`: remove the `this.needAppearances()` calls and replace with `this.regen()` at the end of each (checkbox/radio already mutate `/AS`; call `regen()` after). Delete the now-unused `needAppearances()` method. For checkbox/radio, `regen()` is a no-op when widgets already carry `/AP` states (Task 8), which is the common case — `/AS` flipping still does the visible work.

Example `setText`:

```ts
  private setText(v: string | string[] | boolean): void {
    if (typeof v !== 'string') throw new TypeError('text field value must be a string');
    this.Dict.set('V', { kind: 'string', bytes: encodePdfText(v) });
    this.regen();
  }
```

Apply the same change (swap `needAppearances()` → `regen()`) in `setCheckbox` (add `this.regen()` before returning in both branches), `setRadio` (after the AS loop), and `setChoice` (replace the trailing `this.needAppearances()`).

4. Add to `Form`:

```ts
  /** Generate appearance streams for every field and drop /NeedAppearances. */
  GenerateAppearances(): void {
    for (const f of this.Fields) f.GenerateAppearance();
    const acro = this.doc.resolve(this.doc.catalog().get('AcroForm'));
    if (isDict(acro)) acro.delete('NeedAppearances');
  }
```

This needs `Form` to hold a `doc` reference. The constructor already receives `doc`; store it: add `private readonly doc: Document;` and assign `this.doc = doc;` at the top of the constructor (import `Document` type is already present via `import type { Document }`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/form-appearance.test.ts test/form.test.ts`
Expected: PASS. The existing `form.test.ts` assertions that checked for `NeedAppearances` being set must be updated — change them to assert `/AP` is generated instead (locate with `grep -n NeedAppearances test/form.test.ts` and fix each to the new contract). Re-run until green.

- [ ] **Step 5: Update README + commit**

In `README.md`, under the AcroForm/forms section, document that setting a field value now generates its appearance (no viewer `NeedAppearances` reliance) and add `Form.GenerateAppearances()` / `Field.GenerateAppearance()` to the API overview. Note the v1 limitations (Standard-14 substitution for embedded fonts).

```bash
git add src/form.ts test/form-appearance.test.ts test/form.test.ts README.md
git commit -m "feat: generate field appearances on set; Form.GenerateAppearances API"
```

---

### Task 10: Export, full-suite gate, and docs

Export the new public surface, run the whole suite + typecheck + build, and update the roadmap memory.

**Files:**
- Modify: `src/index.ts`
- Test: full suite

**Interfaces:**
- Consumes: everything above.
- Produces: public exports for any new types worth surfacing (none required — `Form`/`Field` already exported; the new methods ride along). Optionally export `parseDA`/`resolveDA`? No — keep them internal (YAGNI).

- [ ] **Step 1: Confirm no new exports needed**

`Form` and `Field` are already exported from `index.ts`; the new methods are members, so no `index.ts` change is required unless a test imports an internal. Verify:

Run: `grep -n "Form\|Field" src/index.ts`
Expected: existing `export { Form, Field } from './form.js';` present. No change needed.

- [ ] **Step 2: Run the full suite + typecheck + build**

Run: `npm run typecheck && npm test && npm run build`
Expected: all green; `dist/` emits `appearance.js`, `da.js`, updated `metrics.js`, `form.js` with `.d.ts`.

- [ ] **Step 3: Fix any fallout**

If `typecheck` flags the `appearance.ts` ↔ `form.ts` cycle, confirm `appearance.ts` imports `FieldType` with `import type` only (erased at compile time, no runtime cycle). Fix any remaining type errors.

- [ ] **Step 4: Update roadmap memory**

```bash
bd remember --key content-authoring-roadmap "Content-authoring roadmap (spec: docs/superpowers/specs/2026-06-17-content-authoring-design.md). SHIPPED on main: Phase 1 (graphics/imageembed/pagecontent); Phase 1b text stamping (src/stamp.ts); Phase 2a encrypted Save (src/encrypt.ts); Phase 2b form appearance generation (src/appearance.ts + src/da.ts + Standard-14 metrics in src/metrics.ts; Form.GenerateAppearances()/Field.GenerateAppearance(); setters drop NeedAppearances; spec docs/superpowers/specs/2026-06-17-form-appearance-generation-design.md). REMAINING: Phase 3 annotations create/edit + XMP metadata; Phase 4 redaction & editing. Plans dir: docs/superpowers/plans/."
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "chore: Phase 2b form appearance generation — suite green, roadmap updated" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- Text single-line/multiline/comb → Tasks 5, 6, 7. ✓
- Checkbox/radio synthesis-when-missing → Task 8. ✓
- Choice combo + list highlight → Task 8. ✓
- `/MK` BG/BC border + clip → Task 4 (`mkOps`). ✓ (clipping: border inset is applied via `inset` offsets in text helpers; an explicit `W n` clip op may be added if a viewer test shows overflow — noted as best-effort.)
- Widget rotation `/MK /R` → Task 4 (`matrixFor`). ✓
- `/DA` parse + resolve + DR mapping → Tasks 2, 3. ✓
- Standard-14 metrics → Task 1. ✓
- `NeedAppearances` lifecycle (setter no-flag; GenerateAppearances clears; GenerateAppearance leaves) → Task 9. ✓
- Best-effort per-widget skip on bad `/Rect` → Task 4 (`widgetGeom` → undefined, dispatcher `continue`). ✓
- Live-mutation / uncompressed streams / compressed round-trip → Task 9 tests. ✓
- Testing strategy (da/metrics/appearance/integration) → Tasks 1–9 tests. ✓

**Placeholder scan:** Task 1 references AFM-transcribed width arrays (`HELVETICA_BOLD_WIDTHS`, `TIMES_*_WIDTHS`, `SYMBOL_WIDTHS`, `ZAPF_WIDTHS`) — these are bulk data tables transcribed from the canonical Adobe Core-14 AFMs (same source/method as the existing `HELVETICA_WIDTHS`), verified by the `metrics.test.ts` spot-checks; not a logic placeholder. No other placeholders — every code step shows complete, compilable code.

**Type consistency:** `generateFieldAppearance(doc, acroForm, fieldDict, type, ff, value)` signature is identical across Tasks 5–9. `WidgetGeom`/`ResolvedDA`/`StdFont`/`DA` names are stable. `installAP`/`installAPState` used consistently. `measure(font, bytes, size)` and `normalizeFont` signatures match between Tasks 1 and 3/5/8.

**Known follow-ups (file as issues, not blockers):** explicit `W n` clip rectangle if overflow shows in a real viewer; richer `onStateName` derivation for synthesized buttons; broader Symbol coverage.
