# Real Glyph-Width Spacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 0.5em-per-char glyph-advance estimate in `Page.GetText()` with real font metrics (`/Widths` for simple fonts, descendant `/W`+`/DW` for Type0), falling back to the estimate only when a font has no embedded widths.

**Architecture:** `TextFont` parses width tables in its constructor and gains `decodeRun(bytes) → { text, width, ncodes, nWordSpaces }` that measures advance per character code (decoupled from decoded string length). `text.ts` uses that per-run advance for `Tm` advancement, and derives run `endX` from the actual start/end text-matrix positions instead of `text.length`.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, `node:` built-ins only. Touches only `src/font.ts` and `src/text.ts`; tests in `test/font.test.ts` and `test/text.test.ts`; README note.

**Spec:** `docs/superpowers/specs/2026-06-16-glyph-width-spacing-design.md`

---

## File Structure

| File | Change |
|------|--------|
| `src/font.ts` | Parse `/Widths`+`/FirstChar`+`/MissingWidth` (simple) and descendant `/W`+`/DW` (Type0); add `decodeRun`; `decode` becomes a wrapper. |
| `src/text.ts` | `show`/`showArray` use `decodeRun`; new `emitRunBetween` derives `endX` from start/end matrices; `advance` takes a text-space delta; remove `text.length`-based width. |
| `test/font.test.ts` | `decodeRun` width assertions + `decode` regression guard. |
| `test/text.test.ts` | Integration fixture where real `/Widths` change space inference. |
| `README.md` | Update the "glyph advances are estimated" note. |

---

## Task 1: Width tables + `decodeRun` in `font.ts`

**Files:**
- Modify: `src/font.ts`
- Test: `test/font.test.ts`

- [ ] **Step 1: Add failing tests (append to `test/font.test.ts`)**

```typescript
// append to test/font.test.ts

describe('TextFont decodeRun widths', () => {
  it('sums real /Widths (em units) for a simple font', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
      FirstChar: 65, Widths: [500, 250], // 'A'=500, 'B'=250 (glyph units)
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(65, 66)); // "AB"
    expect(r.text).toBe('AB');
    expect(r.width).toBeCloseTo(0.75); // (500+250)/1000
    expect(r.ncodes).toBe(2);
    expect(r.nWordSpaces).toBe(0);
  });

  it('uses /MissingWidth for codes outside /Widths', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
      FirstChar: 65, Widths: [500],
      FontDescriptor: dict({ MissingWidth: 100 }),
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(65, 90)); // 'A' in range, 'Z' out
    expect(r.width).toBeCloseTo(0.6); // (500 + 100)/1000
  });

  it('counts single-byte space codes for word spacing', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
      FirstChar: 32, Widths: [250, 0, 0, 0, 0, 0, 0, 0, 0, 500], // 32=space, 41='A'
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(32, 41)); // space + 'A'(code 41)
    expect(r.nWordSpaces).toBe(1);
  });

  it('falls back to 0.5em estimate when no /Widths', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(65, 66, 67)); // 3 codes
    expect(r.width).toBeCloseTo(1.5); // 3 * 0.5
  });

  it('reads Type0 /W (both forms) and /DW default', () => {
    const cid = dict({
      Subtype: name('CIDFontType2'),
      DW: 600,
      // 3 -> 1000 ; 5..6 -> 400
      W: [3, [1000], 5, 6, 400],
    });
    const f = new TextFont(dict({
      Subtype: name('Type0'), Encoding: name('Identity-H'),
      DescendantFonts: [cid],
    }), id, noInflate);
    const r = f.decodeRun(Uint8Array.of(0x00, 0x03, 0x00, 0x05, 0x00, 0x09));
    // cid 3 -> 1000, cid 5 -> 400, cid 9 -> DW 600
    expect(r.width).toBeCloseTo(2.0); // (1000+400+600)/1000
    expect(r.ncodes).toBe(3);
  });

  it('decode() still returns just the text', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'),
    }), id, noInflate);
    expect(f.decode(Uint8Array.of(65, 66))).toBe('AB');
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/font.test.ts`
Expected: FAIL — `f.decodeRun is not a function`.

- [ ] **Step 3: Implement width parsing + `decodeRun` in `src/font.ts`**

Update imports at the top of `src/font.ts` (add `isArray` — already imported; no change needed). Add the small numeric helper and width-table fields.

Replace the class body's fields and constructor, and add the methods, as follows.

Change the field block (currently `isType0`, `toUnicode`, `simple`) to add three width fields:

```typescript
export class TextFont {
  /** Bytes per character code (1 for simple fonts, 2 for Identity-H/Type0). */
  readonly codeWidth: number;
  private readonly isType0: boolean;
  private readonly toUnicode?: CMap;
  private readonly simple?: (string | undefined)[]; // code(0..255) -> Unicode
  private readonly widths?: Map<number, number>;     // code/cid -> glyph-space width
  private readonly defaultWidth = 0;                  // width for codes absent from `widths`
  private readonly hasWidths: boolean;                // false -> use 0.5em estimate
```

Replace the constructor with:

```typescript
  constructor(dict: PdfDict, resolve: Resolve, inflate: Inflate) {
    const subtype = resolve(dict.get('Subtype'));
    this.isType0 = isName(subtype) && subtype.name === 'Type0';

    const tu = resolve(dict.get('ToUnicode'));
    if (isStream(tu)) this.toUnicode = parseCMap(inflate(tu));

    if (this.isType0) {
      this.codeWidth = this.toUnicode?.codeWidth ?? 2;
      const wt = parseType0Widths(dict, resolve);
      this.widths = wt.widths;
      this.defaultWidth = wt.dw;
      this.hasWidths = true; // /DW always provides a default
    } else {
      this.codeWidth = 1;
      this.simple = buildSimpleEncoding(dict, resolve);
      const wt = parseSimpleWidths(dict, resolve);
      if (wt) { this.widths = wt.widths; this.defaultWidth = wt.missing; this.hasWidths = true; }
      else { this.hasWidths = false; }
    }
  }
```

Replace `decode` with `decodeRun` + a thin `decode` wrapper:

```typescript
  /** Decode bytes into text plus the run's advance metrics.
   *  `width` is in em units (glyph-space sum / 1000), excluding Tc/Tw. */
  decodeRun(bytes: Uint8Array): { text: string; width: number; ncodes: number; nWordSpaces: number } {
    let text = '';
    let width = 0;
    let ncodes = 0;
    let nWordSpaces = 0;
    const w = this.codeWidth;
    for (let i = 0; i + w <= bytes.length || (w === 1 && i < bytes.length); i += w) {
      let code = 0;
      for (let k = 0; k < w; k++) code = (code << 8) | (bytes[i + k] ?? 0);
      const u = this.toUnicode?.lookup(code);
      if (u !== undefined) text += u;
      else if (!this.isType0 && this.simple) {
        const s = this.simple[code & 0xff];
        if (s !== undefined) text += s;
      }
      width += this.hasWidths ? (this.widths?.get(code) ?? this.defaultWidth) / 1000 : 0.5;
      ncodes++;
      if (w === 1 && code === 0x20) nWordSpaces++;
    }
    return { text, width, ncodes, nWordSpaces };
  }

  /** Decode a show-string's bytes into Unicode text. */
  decode(bytes: Uint8Array): string {
    return this.decodeRun(bytes).text;
  }
```

Add these helpers at the end of the file (after `buildSimpleEncoding`):

```typescript
function asNum(o: PdfObject): number | undefined {
  return typeof o === 'number' ? o : undefined;
}

/** Parse /FirstChar + /Widths (+ /FontDescriptor /MissingWidth) for a simple font.
 *  Returns undefined when the font carries no /Widths (estimate path). */
function parseSimpleWidths(
  dict: PdfDict, resolve: Resolve,
): { widths: Map<number, number>; missing: number } | undefined {
  const arr = resolve(dict.get('Widths'));
  if (!isArray(arr)) return undefined;
  const firstChar = asNum(resolve(dict.get('FirstChar'))) ?? 0;
  const fd = resolve(dict.get('FontDescriptor'));
  const missing = (isDict(fd) ? asNum(resolve(fd.get('MissingWidth'))) : undefined) ?? 0;
  const widths = new Map<number, number>();
  arr.forEach((w, i) => {
    const n = asNum(resolve(w));
    if (n !== undefined) widths.set(firstChar + i, n);
  });
  return { widths, missing };
}

/** Parse the descendant CIDFont's /W array (+ /DW default) for a Type0 font.
 *  Assumes Identity (CID = code). */
function parseType0Widths(dict: PdfDict, resolve: Resolve): { widths: Map<number, number>; dw: number } {
  const widths = new Map<number, number>();
  const desc = resolve(dict.get('DescendantFonts'));
  const cidFont = isArray(desc) ? resolve(desc[0]) : undefined;
  if (!isDict(cidFont)) return { widths, dw: 1000 };
  const dw = asNum(resolve(cidFont.get('DW'))) ?? 1000;
  const w = resolve(cidFont.get('W'));
  if (isArray(w)) {
    for (let i = 0; i < w.length; ) {
      const c = asNum(resolve(w[i]));
      const next = resolve(w[i + 1]);
      if (c !== undefined && isArray(next)) {
        next.forEach((wi, j) => {
          const n = asNum(resolve(wi));
          if (n !== undefined) widths.set(c + j, n);
        });
        i += 2;
      } else {
        const cLast = asNum(next);
        const ww = asNum(resolve(w[i + 2]));
        if (c !== undefined && cLast !== undefined && ww !== undefined) {
          for (let cid = c; cid <= cLast; cid++) widths.set(cid, ww);
          i += 3;
        } else { i += 1; } // malformed entry: skip one token
      }
    }
  }
  return { widths, dw };
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run test/font.test.ts`
Expected: PASS (original 4 + new 6).

- [ ] **Step 5: Commit**

```bash
git add src/font.ts test/font.test.ts
git commit -m "feat: parse glyph widths + decodeRun in TextFont (722)"
```

---

## Task 2: Use real advances in `text.ts`

**Files:**
- Modify: `src/text.ts`
- Test: `test/text.test.ts`

The run `endX` is derived from the actual start/end text-matrix positions, so it
naturally accounts for both real glyph widths and TJ shifts.

- [ ] **Step 1: Add a failing integration test (append to `test/text.test.ts`)**

Uses absolute `Tm` for the second glyph (note: `Td` is *relative* to the line
matrix and would accumulate, so it is unsuitable for placing a glyph at an
absolute X). Both glyphs sit on the same line (y=250); space inference depends on
run1's `endX`, which is driven by the glyph width. Threshold is `0.25 × size =
0.25 × 12 = 3` device units.

```typescript
// append inside test/text.test.ts, after the existing integration describe block.
// (Add buildSimpleTextPdfWithWidths to the existing build-text-pdf.js import at
//  the top of the file — do not add a second import line.)

describe('Page.GetText real-width spacing', () => {
  it('does NOT insert a space when a wide glyph closes the gap', () => {
    // 'A' width 1000u @12pt = 12 units -> ends at x=32; 'B' starts at x=30
    // (inside the first glyph) -> gap = -2 -> no space -> "AB".
    // Old 0.5em estimate ends 'A' at x=26 -> gap 30-26=4 > 3 -> would insert a
    // space ("A B"), so this case fails before the refactor and passes after.
    const pdf = buildSimpleTextPdfWithWidths(
      'BT /F1 12 Tf 1 0 0 1 20 250 Tm (A) Tj 1 0 0 1 30 250 Tm (B) Tj ET',
      65, [1000, 1000], // A,B both 1000 glyph units
    );
    expect(Document.Open(pdf).Pages[0].GetText()).toBe('AB');
  });

  it('inserts a space when a narrow glyph leaves a gap', () => {
    // 'A' width 200u @12pt = 2.4 units -> ends at x=22.4; 'B' starts at x=26 ->
    // gap = 3.6 > 3 -> space -> "A B".
    // Old estimate ends 'A' at x=26 -> gap 0 -> no space ("AB"), so this case
    // also fails before the refactor and passes after.
    const pdf = buildSimpleTextPdfWithWidths(
      'BT /F1 12 Tf 1 0 0 1 20 250 Tm (A) Tj 1 0 0 1 26 250 Tm (B) Tj ET',
      65, [200, 200],
    );
    expect(Document.Open(pdf).Pages[0].GetText()).toBe('A B');
  });
});
```

Add the fixture helper to `test/helpers/build-text-pdf.ts`:

```typescript
/** Simple Type1 font (F1) carrying /FirstChar + /Widths. */
export function buildSimpleTextPdfWithWidths(
  stream: string, firstChar: number, widths: number[],
): Uint8Array {
  const objects: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding ` +
       `/FirstChar ${firstChar} /Widths [${widths.join(' ')}] >>`,
  };
  return serialize(objects, 5);
}
```

> The test references `buildSimpleTextPdfWithWidths`; import it alongside the
> existing `build-text-pdf.js` import at the top of `test/text.test.ts` (extend
> the existing import list rather than adding a duplicate import line).

- [ ] **Step 2: Run to verify the new test fails**

Run: `npx vitest run test/text.test.ts`
Expected: FAIL — `buildSimpleTextPdfWithWidths` import resolves, but the first
case fails because the current `text.length`/0.5em advance ignores `/Widths`.

- [ ] **Step 3: Refactor `show`, `showArray`, `emitRunAt`, `advance` in `src/text.ts`**

Replace the four functions (`show`, `showArray`, `emitRunAt`, `advance`) with:

```typescript
/** Emit a run for a show-string and advance the text matrix. */
function show(st: TextState, strObj: PdfObject, ctm: Matrix, runs: Run[]): void {
  if (!isString(strObj) || !st.font) return;
  const { text, width, ncodes, nWordSpaces } = st.font.decodeRun(strObj.bytes);
  const startTm = st.tm;
  advance(st, runAdvance(st, width, ncodes, nWordSpaces));
  emitRunBetween(st, text, startTm, st.tm, ctm, runs);
}

/** Handle a TJ array: strings show, numbers shift (large gaps -> spaces). */
function showArray(st: TextState, arrObj: PdfObject, ctm: Matrix, runs: Run[]): void {
  if (!isArray(arrObj) || !st.font) return;
  let buf = '';
  let startTm = st.tm;
  for (const el of arrObj) {
    if (isString(el)) {
      if (!buf) startTm = st.tm;
      const { text, width, ncodes, nWordSpaces } = st.font.decodeRun(el.bytes);
      buf += text;
      advance(st, runAdvance(st, width, ncodes, nWordSpaces));
    } else if (typeof el === 'number') {
      const shift = (-el / 1000) * st.fontSize * st.hscale; // text-space displacement
      st.tm = mul(translate(shift, 0), st.tm);
      if (-el > 200) buf += ' '; // wide gap -> word space
    }
  }
  if (buf) emitRunBetween(st, buf, startTm, st.tm, ctm, runs);
}

/** Text-space horizontal advance for a decoded run. */
function runAdvance(st: TextState, width: number, ncodes: number, nWordSpaces: number): number {
  return (width * st.fontSize + ncodes * st.charSp + nWordSpaces * st.wordSp) * st.hscale;
}

/** Emit a run spanning text matrices `startTm`..`endTm` (device-space x/endX). */
function emitRunBetween(st: TextState, text: string, startTm: Matrix, endTm: Matrix, ctm: Matrix, runs: Run[]): void {
  if (!text) return;
  const startComb = mul(startTm, ctm);
  const [x, y] = apply(startComb, 0, st.rise);
  const [endX] = apply(mul(endTm, ctm), 0, st.rise);
  const size = st.fontSize * vscale(startComb);
  runs.push({ x, endX, y, text, size });
}

/** Advance Tm horizontally by a text-space delta. */
function advance(st: TextState, tx: number): void {
  st.tm = mul(translate(tx, 0), st.tm);
}
```

Note: `emitRunAt` is removed (replaced by `emitRunBetween`); confirm no other
references to `emitRunAt` remain in `src/text.ts`.

- [ ] **Step 4: Run the text suite**

Run: `npx vitest run test/text.test.ts`
Expected: PASS — new real-width cases pass; all prior cases (Helvetica without
`/Widths` → estimate path) stay green.

- [ ] **Step 5: Full typecheck + suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/text.ts test/text.test.ts test/helpers/build-text-pdf.ts
git commit -m "feat: use real glyph advances for GetText spacing (722)"
```

---

## Task 3: Docs + close-out

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the spacing note in README**

In `README.md`, the Text-extraction Features bullet and the Text-extraction
section say spacing is heuristic because "glyph advances are estimated rather than
read from font width tables". Update that wording to reflect that widths are now
used when present. Replace the relevant sentence in the **Text extraction**
section with:

```markdown
Spacing and line breaks are heuristic: glyph advances come from embedded width
tables (`/Widths`, CID `/W`/`/DW`) when present and fall back to a per-em estimate
otherwise; vertical writing modes are out of scope. Image-only pages return `""`.
```

And in the Features list bullet, change "with reasonable word/line ordering" tail
so it no longer implies advances are always estimated — drop any "(estimated)"
qualifier if present; the bullet should read that it decodes through encodings,
ToUnicode, and Type0 fonts (no change to that part is required if it doesn't
mention estimation).

- [ ] **Step 2: Verify build still green**

Run: `npm run typecheck && npm test`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note width-table-based spacing in GetText (722)"
```

- [ ] **Step 4: Close the issue**

Run:
```bash
bd close aspose-pdf-foss-for-ts-722
```

---

## Self-Review Notes

- **Spec coverage:** simple `/Widths`+`/FirstChar`+`/MissingWidth` (Task 1 `parseSimpleWidths`), Type0 `/W` both forms + `/DW` (Task 1 `parseType0Widths`), `decodeRun` per-code measurement decoupled from text length (Task 1), real advances feeding `Tm` and `endX` (Task 2 `runAdvance`/`emitRunBetween`), estimate fallback when no widths (Task 1 `hasWidths`), non-breaking (existing Helvetica fixtures have no `/Widths`), README note (Task 3).
- **Placeholder scan:** none — all steps contain concrete code/commands.
- **Type consistency:** `decodeRun` returns `{ text, width, ncodes, nWordSpaces }` and is consumed with those exact names in `show`/`showArray`; `runAdvance`, `emitRunBetween`, `advance(st, tx)` signatures match their call sites; `parseSimpleWidths` returns `{ widths, missing }`, `parseType0Widths` returns `{ widths, dw }`, both consumed accordingly in the constructor.
- **Known approximation:** Type0 width assumes Identity (CID = code), matching the existing decode path; non-Identity CID maps remain out of scope per the spec.
