# Text Stamping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Page.AddText(text, x, y, options)` to stamp Helvetica text (watermarks, page numbers) onto a page without disturbing existing content, plus `Page.MeasureText` for width-aware alignment.

**Architecture:** A new `stamp.ts` orchestrates: encode text to WinAnsi bytes, register a Standard-14 Helvetica font (and an optional `/ExtGState` for opacity) into the page's own `/Resources` with dedup, build an uncompressed content stream, and splice it into `/Contents` wrapped in `q`/`Q`. Helvetica AFM widths live in `metrics.ts`; WinAnsi encoding reuses the existing `winAnsi` table in `encoding.ts`. A one-line `Document.allocObject` internal helper allocates indirect objects.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest, zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-06-17-text-stamping-design.md`

---

## File Structure

- **Create `src/metrics.ts`** — Helvetica AFM width table (WinAnsi-code indexed) + `measureWinAnsi`.
- **Modify `src/encoding.ts`** — add `encodeWinAnsi(text): Uint8Array`.
- **Create `src/stamp.ts`** — `StampOptions`, `measureText`, `stampText` and private helpers.
- **Modify `src/document.ts`** — add `@internal allocObject`.
- **Modify `src/page.ts`** — add `AddText`, `MeasureText`.
- **Modify `src/index.ts`** — export `StampOptions` type.
- **Modify `README.md`** — document the new API.
- **Create `test/helpers/build-stamp-target.ts`** — fixtures (own-resources and inherited-resources pages).
- **Create `test/metrics.test.ts`, `test/stamp.test.ts`** — and extend `test/encoding.test.ts`.

---

## Task 1: Helvetica metrics module

**Files:**
- Create: `src/metrics.ts`
- Test: `test/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/metrics.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { HELVETICA_WIDTHS, measureWinAnsi } from '../src/metrics.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('Helvetica metrics', () => {
  it('has a 256-entry width table', () => {
    expect(HELVETICA_WIDTHS).toHaveLength(256);
  });

  it('measures "Hello" at 12pt from AFM widths', () => {
    // H722 e556 l222 l222 o556 = 2278 /1000 * 12 = 27.336
    expect(measureWinAnsi(enc('Hello'), 12)).toBeCloseTo(27.336, 3);
  });

  it('scales linearly with font size', () => {
    expect(measureWinAnsi(enc('Hello'), 24)).toBeCloseTo(54.672, 3);
  });

  it('treats control-range bytes as zero width', () => {
    expect(measureWinAnsi(Uint8Array.of(0x00, 0x09), 12)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/metrics.test.ts`
Expected: FAIL — cannot find module `../src/metrics.js`.

- [ ] **Step 3: Write the implementation**

Create `src/metrics.ts`:

```typescript
// Adobe Core-14 Helvetica glyph advance widths (1000-unit em), indexed by
// WinAnsiEncoding byte code. Transcribed from the Helvetica AFM; codes with no
// glyph (control range, unused CP1252 slots) are 0.
export const HELVETICA_WIDTHS: readonly number[] = [
  // 0x00..0x0F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // 0x10..0x1F
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  // 0x20..0x2F  space ! " # $ % & ' ( ) * + , - . /
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  // 0x30..0x3F  0-9 : ; < = > ?
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  // 0x40..0x4F  @ A-O
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  // 0x50..0x5F  P-Z [ \ ] ^ _
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  // 0x60..0x6F  ` a-o
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  // 0x70..0x7F  p-z { | } ~ (del)
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  // 0x80..0x8F  Euro . quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE . Zcaron .
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  // 0x90..0x9F  . quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe . zcaron Ydieresis
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  // 0xA0..0xAF  nbsp exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot sfthyphen registered macron
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  // 0xB0..0xBF  degree plusminus 2 3 acute mu paragraph periodcentered cedilla 1 ordmasculine guillemotright 1/4 1/2 3/4 questiondown
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  // 0xC0..0xCF  Agrave..Aring AE Ccedilla Egrave..Edieresis Igrave..Idieresis
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  // 0xD0..0xDF  Eth Ntilde Ograve..Odieresis multiply Oslash Ugrave..Udieresis Yacute Thorn germandbls
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  // 0xE0..0xEF  agrave..aring ae ccedilla egrave..edieresis igrave..idieresis
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  // 0xF0..0xFF  eth ntilde ograve..odieresis divide oslash ugrave..udieresis yacute thorn ydieresis
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** Width of WinAnsi-encoded `bytes` in points at `fontSize`. */
export function measureWinAnsi(bytes: Uint8Array, fontSize: number): number {
  let units = 0;
  for (const b of bytes) units += HELVETICA_WIDTHS[b] ?? 0;
  return (units / 1000) * fontSize;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/metrics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "feat: Helvetica AFM width table and measureWinAnsi (b3y)"
```

---

## Task 2: WinAnsi encoder

**Files:**
- Modify: `src/encoding.ts` (append a new export; reuse the existing `winAnsi` table)
- Test: `test/encoding.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**

Append to `test/encoding.test.ts` (add `encodeWinAnsi` to the existing import from `../src/encoding.js`):

```typescript
import { encodeWinAnsi } from '../src/encoding.js';

describe('encodeWinAnsi', () => {
  it('encodes ASCII to identical byte codes', () => {
    expect(Array.from(encodeWinAnsi('Hi!'))).toEqual([0x48, 0x69, 0x21]);
  });

  it('maps CP1252 punctuation into the 0x80..0x9F block', () => {
    // U+2019 right single quote -> 0x92, U+2014 em dash -> 0x97
    expect(Array.from(encodeWinAnsi('’—'))).toEqual([0x92, 0x97]);
  });

  it('drops codepoints with no WinAnsi slot', () => {
    expect(Array.from(encodeWinAnsi('A\u{1F600}B'))).toEqual([0x41, 0x42]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/encoding.test.ts`
Expected: FAIL — `encodeWinAnsi` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/encoding.ts` (after the `winAnsi` definition; it references that table):

```typescript
/** Reverse of the WinAnsi table: Unicode codepoint -> byte code. Built once.
 *  Lower codes win when two slots share a codepoint (none do in WinAnsi). */
const WINANSI_REVERSE: Map<number, number> = (() => {
  const m = new Map<number, number>();
  for (let code = 0; code < 256; code++) {
    const ch = winAnsi[code];
    if (ch === undefined) continue;
    const cp = ch.codePointAt(0)!;
    if (!m.has(cp)) m.set(cp, code);
  }
  return m;
})();

/** Encode a JS string to WinAnsiEncoding bytes, dropping unrepresentable
 *  codepoints (so callers never throw on a stray glyph). */
export function encodeWinAnsi(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const code = WINANSI_REVERSE.get(ch.codePointAt(0)!);
    if (code !== undefined) out.push(code);
  }
  return Uint8Array.from(out);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/encoding.test.ts`
Expected: PASS (existing tests plus the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/encoding.ts test/encoding.test.ts
git commit -m "feat: encodeWinAnsi (string -> WinAnsi bytes) (b3y)"
```

---

## Task 3: MeasureText (stamp.ts scaffold + Page wiring + fixtures)

**Files:**
- Create: `src/stamp.ts`
- Create: `test/helpers/build-stamp-target.ts`
- Modify: `src/page.ts` (add `MeasureText`; import from `./stamp.js`)
- Modify: `src/index.ts` (export `StampOptions` type)
- Test: `test/stamp.test.ts`

- [ ] **Step 1: Create the fixture builder**

Create `test/helpers/build-stamp-target.ts`:

```typescript
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

/** Assemble a classic-xref PDF from a 1-based array of object bodies. */
function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

/** Single page with its OWN /Resources, existing content showing "Original"
 *  in Courier (a non-Helvetica font, so stamping adds a distinct Helvetica). */
export function buildStampTarget(): Uint8Array {
  const content = 'BT /F0 12 Tf 10 100 Td (Original) Tj ET';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F0 5 0 R >> >> /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}

/** Single page that INHERITS /Resources from the /Pages node (no own /Resources),
 *  existing content showing "Inherited" in Courier. */
export function buildInheritedResourcesTarget(): Uint8Array {
  const content = 'BT /F0 12 Tf 10 100 Td (Inherited) Tj ET';
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 200] /Resources << /Font << /F0 5 0 R >> >> >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>`;
  objects[4] = streamObj(content);
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/stamp.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

describe('Page.MeasureText', () => {
  it('measures Helvetica width in points', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(page.MeasureText('Hello', 12)).toBeCloseTo(27.336, 3);
  });

  it('defaults to 12pt', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(page.MeasureText('Hello')).toBeCloseTo(27.336, 3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/stamp.test.ts`
Expected: FAIL — `page.MeasureText is not a function` (and `../src/stamp.js` missing).

- [ ] **Step 4: Create `src/stamp.ts` with the scaffold**

Create `src/stamp.ts`:

```typescript
import { encodeWinAnsi } from './encoding.js';
import { measureWinAnsi } from './metrics.js';

/** Options for stamping text onto a page. */
export interface StampOptions {
  /** Font size in points. Default 12. */
  fontSize?: number;
  /** Fill color as RGB components in 0..1. Default [0, 0, 0]. */
  color?: [number, number, number];
  /** Rotation in degrees, counter-clockwise about (x, y). Default 0. */
  rotate?: number;
  /** Fill opacity in 0..1. Default 1 (no /ExtGState emitted). */
  opacity?: number;
  /** Which point of the baseline (x, y) anchors. Default 'left'. */
  align?: 'left' | 'center' | 'right';
}

/** Rendered width of `text` in points for the stamping font at `fontSize`. */
export function measureText(text: string, fontSize: number): number {
  return measureWinAnsi(encodeWinAnsi(text), fontSize);
}
```

- [ ] **Step 5: Wire `Page.MeasureText`**

In `src/page.ts`, add the import near the other feature imports:

```typescript
import { measureText, stampText, StampOptions } from './stamp.js';
```

Then add this method to the `Page` class, after `GetText()`:

```typescript
  /** Rendered width of `text` in points at `fontSize` (default 12) for the
   *  Helvetica stamping font. */
  MeasureText(text: string, fontSize = 12): number {
    return measureText(text, fontSize);
  }
```

Note: `stampText` is imported now (used in Task 4). If your linter rejects the
unused import at this step, add the `AddText` method from Task 4 Step 5 in the
same edit — both live on `Page`.

- [ ] **Step 6: Export the type**

In `src/index.ts`, add:

```typescript
export type { StampOptions } from './stamp.js';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run test/stamp.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add src/stamp.ts src/page.ts src/index.ts test/stamp.test.ts test/helpers/build-stamp-target.ts
git commit -m "feat: Page.MeasureText and stamp fixtures (b3y)"
```

---

## Task 4: AddText core (font registration, content assembly, alignment, rotation, validation)

**Files:**
- Modify: `src/document.ts` (add `allocObject`)
- Modify: `src/stamp.ts` (add `stampText` and private helpers)
- Modify: `src/page.ts` (add `AddText`)
- Test: `test/stamp.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/stamp.test.ts` (extend the imports as shown):

```typescript
import { isDict, isName } from '../src/types.js';
import { buildInheritedResourcesTarget } from './helpers/build-stamp-target.js';

const decoded = (page: import('../src/page.js').Page) =>
  new TextDecoder('latin1').decode(page.Contents);

function helveticaCount(fonts: Map<string, any>, resolve: (o: any) => any): number {
  let n = 0;
  for (const v of fonts.values()) {
    const d = resolve(v);
    if (isDict(d)) {
      const bf = resolve(d.get('BaseFont'));
      const en = resolve(d.get('Encoding'));
      if (isName(bf) && bf.name === 'Helvetica' && isName(en) && en.name === 'WinAnsiEncoding') n++;
    }
  }
  return n;
}

describe('Page.AddText', () => {
  it('round-trips: existing content and stamped text both survive Save', () => {
    const doc = Document.Open(buildStampTarget());
    doc.Pages[0].AddText('Stamped', 20, 50);
    const reopened = Document.Open(doc.Save());
    const text = reopened.Pages[0].GetText();
    expect(text).toContain('Original');
    expect(text).toContain('Stamped');
  });

  it('emits a Helvetica font and an isolating q/Q stamp', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 100);
    const c = decoded(page);
    expect(c).toContain('BT');
    expect(c).toContain('Tj');
    expect(c).toContain(' Tm');
    expect(c).toMatch(/q[\s\S]*Q/);
  });

  it('registers the Helvetica font only once across two calls', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('A', 10, 10);
    page.AddText('B', 10, 30);
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(helveticaCount(fonts, (o) => doc.resolve(o))).toBe(1);
  });

  it('left align places the baseline origin exactly at (x, y)', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 50);
    expect(decoded(page)).toContain('1 0 0 1 100 50 Tm');
  });

  it('center align shifts the origin left by half the width', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    // "Hi": H722 i222 = 944 -> 12pt width 11.328; half = 5.664; tx = 94.336
    page.AddText('Hi', 100, 50, { align: 'center' });
    expect(decoded(page)).toContain('1 0 0 1 94.336 50 Tm');
  });

  it('rotation writes the rotation matrix', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Hi', 100, 50, { rotate: 90 });
    expect(decoded(page)).toContain('0 1 -1 0 100 50 Tm');
  });

  it('preserves inherited resources (no shadowing)', () => {
    const doc = Document.Open(buildInheritedResourcesTarget());
    doc.Pages[0].AddText('Stamped', 20, 50);
    const reopened = Document.Open(doc.Save());
    const page = reopened.Pages[0];
    expect(page.GetText()).toContain('Inherited');
    expect(page.GetText()).toContain('Stamped');
    // The page now owns a /Resources/Font with both Courier (F0) and Helvetica.
    const fonts = page.Resources!.get('Font') as Map<string, any>;
    expect(fonts.size).toBeGreaterThanOrEqual(2);
  });

  it('drops unencodable characters and no-ops on empty text', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    const before = page.Contents.length;
    page.AddText('', 10, 10);
    expect(page.Contents.length).toBe(before); // empty -> no change
    page.AddText('\u{1F600}', 10, 10); // all dropped -> no change
    expect(page.Contents.length).toBe(before);
  });

  it('rejects invalid options with TypeError', () => {
    const page = Document.Open(buildStampTarget()).Pages[0];
    expect(() => page.AddText('x', 0, 0, { opacity: 2 })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { fontSize: 0 })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { color: [2, 0, 0] })).toThrow(TypeError);
    expect(() => page.AddText('x', 0, 0, { rotate: Infinity })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stamp.test.ts`
Expected: FAIL — `page.AddText is not a function`.

- [ ] **Step 3: Add `Document.allocObject`**

In `src/document.ts`, add this method to the `Document` class (e.g. right after the private `maxObjNum()`):

```typescript
  /** @internal Allocate a fresh indirect object, returning its ref. */
  allocObject(obj: PdfObject): PdfRef {
    const n = this.maxObjNum() + 1;
    this.objects.set(n, obj);
    return ref(n);
  }
```

(`PdfObject`, `PdfRef`, and `ref` are already imported in `document.ts`.)

- [ ] **Step 4: Implement `stampText` and helpers in `src/stamp.ts`**

Replace the import block at the top of `src/stamp.ts` with:

```typescript
import type { Document } from './document.js';
import type { Page } from './page.js';
import {
  PdfObject, PdfDict, PdfRef, PdfStream,
  isDict, isArray, isStream, isRef, isName, name, ref,
} from './types.js';
import { encodeWinAnsi } from './encoding.js';
import { measureWinAnsi } from './metrics.js';
import { enc, serializeString } from './serialize.js';
```

Then append the implementation (keep the existing `StampOptions` and `measureText`):

```typescript
interface NormalizedOptions {
  fontSize: number;
  color: [number, number, number];
  rotate: number;
  opacity: number;
  align: 'left' | 'center' | 'right';
}

function normalizeOptions(o: StampOptions): NormalizedOptions {
  const fontSize = o.fontSize ?? 12;
  if (!Number.isFinite(fontSize) || fontSize <= 0)
    throw new TypeError('fontSize must be a positive finite number');
  const rotate = o.rotate ?? 0;
  if (!Number.isFinite(rotate)) throw new TypeError('rotate must be a finite number');
  const opacity = o.opacity ?? 1;
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
    throw new TypeError('opacity must be in 0..1');
  const color = o.color ?? [0, 0, 0];
  if (!Array.isArray(color) || color.length !== 3 ||
      !color.every((c) => Number.isFinite(c) && c >= 0 && c <= 1))
    throw new TypeError('color must be [r, g, b] with each component in 0..1');
  const align = o.align ?? 'left';
  if (align !== 'left' && align !== 'center' && align !== 'right')
    throw new TypeError("align must be 'left', 'center', or 'right'");
  return { fontSize, color, rotate, opacity, align };
}

/** Format a number compactly for a content stream (no exponent, no float noise). */
function num(n: number): string {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

function streamOf(bytes: Uint8Array): PdfStream {
  return { kind: 'stream', dict: new Map(), raw: bytes };
}

function freshKey(d: PdfDict, prefix: string): string {
  for (let i = 0; ; i++) {
    const k = `${prefix}${i}`;
    if (!d.has(k)) return k;
  }
}

/** The page's own /Resources, shallow-copying an inherited one onto the page so
 *  we never shadow it (which would hide fonts the existing content depends on). */
function ensureOwnResources(doc: Document, page: Page): PdfDict {
  const own = page.Dict.get('Resources');
  if (own !== undefined) {
    const d = doc.resolve(own);
    if (isDict(d)) return d;
  }
  const inherited = page.Resources; // resolved inherited dict or undefined
  const copy: PdfDict = new Map(inherited ?? []);
  page.Dict.set('Resources', copy);
  return copy;
}

/** A fresh own sub-dict (e.g. Font), shallow-copying any existing entries so we
 *  mutate only structures this page owns. */
function ensureOwnSubdict(doc: Document, resources: PdfDict, key: string): PdfDict {
  const d = doc.resolve(resources.get(key));
  const copy: PdfDict = isDict(d) ? new Map(d) : new Map();
  resources.set(key, copy);
  return copy;
}

function isHelveticaWinAnsi(doc: Document, d: PdfDict): boolean {
  const bf = doc.resolve(d.get('BaseFont'));
  const en = doc.resolve(d.get('Encoding'));
  return isName(bf) && bf.name === 'Helvetica' && isName(en) && en.name === 'WinAnsiEncoding';
}

/** Register (or reuse) the Helvetica WinAnsi font; returns its resource key. */
function registerFont(doc: Document, page: Page): string {
  const res = ensureOwnResources(doc, page);
  const fonts = ensureOwnSubdict(doc, res, 'Font');
  for (const [k, v] of fonts) {
    const d = doc.resolve(v);
    if (isDict(d) && isHelveticaWinAnsi(doc, d)) return k;
  }
  const fontDict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type1')],
    ['BaseFont', name('Helvetica')],
    ['Encoding', name('WinAnsiEncoding')],
  ]);
  const key = freshKey(fonts, 'F');
  fonts.set(key, doc.allocObject(fontDict));
  return key;
}

/** Normalize /Contents to an array of stream refs (allocating for any inline
 *  streams), keeping only entries that resolve to streams. */
function normalizeContents(doc: Document, c: PdfObject | undefined): PdfRef[] {
  if (c === undefined) return [];
  if (isRef(c)) return isStream(doc.resolve(c)) ? [c] : [];
  if (isStream(c)) return [doc.allocObject(c)];
  if (isArray(c)) {
    const out: PdfRef[] = [];
    for (const e of c) {
      if (isRef(e)) { if (isStream(doc.resolve(e))) out.push(e); }
      else if (isStream(e)) out.push(doc.allocObject(e));
    }
    return out;
  }
  return [];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Splice the stamp body into /Contents, wrapping existing content in q/Q. */
function appendContent(doc: Document, page: Page, stampBody: Uint8Array): void {
  const existing = normalizeContents(doc, page.Dict.get('Contents'));
  if (existing.length === 0) {
    page.Dict.set('Contents', [doc.allocObject(streamOf(stampBody))]);
    return;
  }
  const qRef = doc.allocObject(streamOf(enc('q')));
  const tailRef = doc.allocObject(streamOf(concat([enc('Q\n'), stampBody])));
  page.Dict.set('Contents', [qRef, ...existing, tailRef]);
}

function buildStampBody(
  bytes: Uint8Array, x: number, y: number, o: NormalizedOptions,
  fontKey: string, width: number,
): Uint8Array {
  const f = o.align === 'center' ? 0.5 : o.align === 'right' ? 1 : 0;
  const theta = (o.rotate * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = x - f * width * cos;
  const ty = y - f * width * sin;
  const [r, g, b] = o.color;
  let s = 'q\nBT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  s += `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)} Tm\n`;
  s += `${serializeString(bytes)} Tj\n`;
  s += 'ET\nQ';
  return enc(s);
}

/** Stamp `text` at (x, y) on `page`. Existing content is preserved. */
export function stampText(
  doc: Document, page: Page, text: string, x: number, y: number, options: StampOptions = {},
): void {
  const o = normalizeOptions(options);
  const bytes = encodeWinAnsi(text);
  if (bytes.length === 0) return; // empty or all-unencodable: no-op
  const fontKey = registerFont(doc, page);
  const width = measureWinAnsi(bytes, o.fontSize);
  appendContent(doc, page, buildStampBody(bytes, x, y, o, fontKey, width));
}
```

- [ ] **Step 5: Add `Page.AddText`**

In `src/page.ts`, add to the `Page` class (next to `MeasureText`):

```typescript
  /** Stamp `text` at (x, y) in PDF user space. Existing content is preserved. */
  AddText(text: string, x: number, y: number, options?: StampOptions): void {
    stampText(this.doc, this, text, x, y, options ?? {});
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/stamp.test.ts`
Expected: PASS (all Task 3 + Task 4 tests).

- [ ] **Step 7: Commit**

```bash
git add src/document.ts src/stamp.ts src/page.ts test/stamp.test.ts
git commit -m "feat: Page.AddText stamping with alignment and rotation (b3y)"
```

---

## Task 5: Opacity via /ExtGState

**Files:**
- Modify: `src/stamp.ts` (add `registerExtGState`; thread an optional gs key)
- Test: `test/stamp.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `test/stamp.test.ts`:

```typescript
describe('Page.AddText opacity', () => {
  it('opacity < 1 registers one /ExtGState and emits gs', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Faint', 10, 10, { opacity: 0.5 });
    const gs = page.Resources!.get('ExtGState') as Map<string, any>;
    expect(gs.size).toBe(1);
    const entry = doc.resolve([...gs.values()][0]) as Map<string, any>;
    expect(doc.resolve(entry.get('ca'))).toBe(0.5);
    expect(doc.resolve(entry.get('CA'))).toBe(0.5);
    expect(decoded(page)).toMatch(/\/GS0 gs/);
  });

  it('reuses one /ExtGState for equal opacity across calls', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('A', 10, 10, { opacity: 0.5 });
    page.AddText('B', 10, 30, { opacity: 0.5 });
    const gs = page.Resources!.get('ExtGState') as Map<string, any>;
    expect(gs.size).toBe(1);
  });

  it('opacity 1 registers no /ExtGState and emits no gs', () => {
    const doc = Document.Open(buildStampTarget());
    const page = doc.Pages[0];
    page.AddText('Solid', 10, 10);
    expect(page.Resources!.get('ExtGState')).toBeUndefined();
    expect(decoded(page)).not.toContain(' gs');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/stamp.test.ts`
Expected: FAIL — no `/ExtGState` registered, no `gs` emitted.

- [ ] **Step 3: Add `registerExtGState`**

In `src/stamp.ts`, add after `registerFont`:

```typescript
/** Register (or reuse) an /ExtGState with the given fill/stroke alpha; returns
 *  its resource key. */
function registerExtGState(doc: Document, page: Page, opacity: number): string {
  const res = ensureOwnResources(doc, page);
  const gs = ensureOwnSubdict(doc, res, 'ExtGState');
  for (const [k, v] of gs) {
    const d = doc.resolve(v);
    if (isDict(d) && doc.resolve(d.get('ca')) === opacity && doc.resolve(d.get('CA')) === opacity)
      return k;
  }
  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('ExtGState')],
    ['ca', opacity],
    ['CA', opacity],
  ]);
  const key = freshKey(gs, 'GS');
  gs.set(key, doc.allocObject(dict));
  return key;
}
```

- [ ] **Step 4: Thread the gs key through `buildStampBody` and `stampText`**

In `src/stamp.ts`, change `buildStampBody`'s signature and the `q\nBT\n` line to take an optional `gsKey`:

```typescript
function buildStampBody(
  bytes: Uint8Array, x: number, y: number, o: NormalizedOptions,
  fontKey: string, width: number, gsKey: string | undefined,
): Uint8Array {
  const f = o.align === 'center' ? 0.5 : o.align === 'right' ? 1 : 0;
  const theta = (o.rotate * Math.PI) / 180;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const tx = x - f * width * cos;
  const ty = y - f * width * sin;
  const [r, g, b] = o.color;
  let s = 'q\n';
  if (gsKey) s += `/${gsKey} gs\n`;
  s += 'BT\n';
  s += `/${fontKey} ${num(o.fontSize)} Tf\n`;
  s += `${num(r)} ${num(g)} ${num(b)} rg\n`;
  s += `${num(cos)} ${num(sin)} ${num(-sin)} ${num(cos)} ${num(tx)} ${num(ty)} Tm\n`;
  s += `${serializeString(bytes)} Tj\n`;
  s += 'ET\nQ';
  return enc(s);
}
```

And update the body of `stampText` (the last two statements):

```typescript
  const fontKey = registerFont(doc, page);
  const gsKey = o.opacity < 1 ? registerExtGState(doc, page, o.opacity) : undefined;
  const width = measureWinAnsi(bytes, o.fontSize);
  appendContent(doc, page, buildStampBody(bytes, x, y, o, fontKey, width, gsKey));
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/stamp.test.ts`
Expected: PASS (all stamp tests, including opacity).

- [ ] **Step 6: Commit**

```bash
git add src/stamp.ts test/stamp.test.ts
git commit -m "feat: stamp text opacity via /ExtGState (b3y)"
```

---

## Task 6: Docs, full verification, close issue

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the API in README.md**

In `README.md`, under the Features list add a bullet, and under the API overview
add a subsection. Match the surrounding style; example content:

```markdown
### Content stamping

Stamp text (watermarks, page numbers) onto a page. Uses the built-in Helvetica
(Standard-14) font, registered into the page resources at most once.

```ts
import { Document } from 'aspose-pdf-foss-for-ts';

const doc = Document.OpenFile('in.pdf');
const page = doc.Pages[0];

// Page number, right-aligned at the bottom-right.
const w = page.Rect[2] - page.Rect[0];
page.AddText(`Page ${page.Number}`, w - 40, 20, { fontSize: 10, align: 'right' });

// Semi-transparent diagonal watermark, centered.
page.AddText('DRAFT', page.Rect[2] / 2, page.Rect[3] / 2, {
  fontSize: 64, color: [0.7, 0.7, 0.7], opacity: 0.4, rotate: 45, align: 'center',
});

doc.WriteTo('out.pdf');
```

`MeasureText(text, fontSize?)` returns the rendered width in points. Characters
outside WinAnsiEncoding are dropped. Coordinates are PDF user space (origin
bottom-left, points).
```

Also add to the Limitations section: stamping supports only the Helvetica
Standard-14 font (no bold/italic, embedded, or non-Latin fonts) and single-line
text.

- [ ] **Step 2: Run the full quality gates**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all suites pass (including `metrics`, `encoding`, `stamp`).

- [ ] **Step 3: Commit the docs**

```bash
git add README.md
git commit -m "docs: document Page.AddText / MeasureText stamping (b3y)"
```

- [ ] **Step 4: Close the issue and run the session-close push**

```bash
bd close aspose-pdf-foss-for-ts-b3y
git pull --rebase
git push
git status   # MUST show up to date with origin
```

---

## Self-Review Notes

- **Spec coverage:** API (Task 3/4), Helvetica metrics (Task 1), WinAnsi encode (Task 2), font dedup + inherited-resources safety (Task 4), q/Q content wrapping (Task 4), alignment + rotation (Task 4), opacity/ExtGState (Task 5), validation + unencodable + empty (Task 4), tests + fixtures (all), docs (Task 6). All spec sections map to a task.
- **Manual acceptance:** "renders in a real viewer" is the human check noted on the issue; the automated suite verifies structural round-trip and resource/content invariants.
- **Type consistency:** `stampText(doc, page, text, x, y, options)`, `measureText(text, fontSize)`, `Document.allocObject(obj): PdfRef`, `Page.AddText`/`Page.MeasureText`, `StampOptions` are used identically across tasks and the spec. `buildStampBody` gains a `gsKey` parameter in Task 5 (the only signature change, shown in full).
```
