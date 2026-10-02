# MakeSearchable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.MakeSearchable(engine, opts?)` adds an invisible, exactly positioned text layer to image-only pages, using a caller-supplied `OcrEngine`, plus `aiOcrEngine(model)` built on `AiModel`.

**Architecture:** Two pure modules carry the hard parts — `glyphless.ts` (an embedded one-empty-glyph TrueType, a code assigner, and the Type0 font objects) and `ocrlayer.ts` (spans + the renderer's device matrix → invisible-text content bytes). `makesearchable.ts` is the only module touching a `Document`. `aiocr.ts` adapts an `AiModel` to the `OcrEngine` seam in `ocr.ts`.

**Tech Stack:** TypeScript (strict, ESM, NodeNext — specifiers end in `.js`), `node:zlib`, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-make-searchable-design.md` — read it before Task 1.

## Global Constraints

- Zero runtime dependencies.
- The device matrix is `mul(baseMatrix(page, 'crop').matrix, [s, 0, 0, s, 0, 0])` with `s = dpi / 72` — `renderCanvas`'s exact composition. Computed in ONE place (`ocrDeviceMatrix` in `makesearchable.ts`).
- Glyphless font: `unitsPerEm` 1000, two glyphs (0 `.notdef`, 1 empty), advance 500, `/DW 500`, `/BaseFont /GlyphLessFont` (no subset tag), `/Encoding /Identity-H`, `/CIDSystemInfo (Adobe)(Identity) 0`. Every code ≥ 1 maps to GID 1, never 0.
- Codes are 2-byte, assigned from 1 in order of first use, one per code point; at most 65,535 distinct characters, and an `encode` that would exceed it assigns NOTHING and throws `RangeError`.
- Content per page: `BT /<key> 1 Tf 3 Tr` … `<a b c d e f> Tm <hex> Tj` per span … `ET`; wrapped in `wrapArtifact` iff `doc.GetStructTree() !== null`.
- `dpi` default 200, valid range `(0, 1200]`. `aiOcrEngine` `maxTokens` default 4096; its boxes are on a 0–1000 grid.
- Signed documents (`hasSignatureField(doc)`) are refused with `UnsupportedFeatureError`, matching `ConvertColors`.
- **Every `catch` in `src/` calls `rethrowLimit(caught)` as its first statement** and binds the error (`catch (caught) {`). `test/limits-catch.test.ts` enforces it.
- Every name exported from `src/index.ts` gets a README API Reference row and the README count sentence states the compiler's counts (`test/readme-api.test.ts`).
- `npm run typecheck` and the task's tests green before a task is done.
- **Refinement of the spec, deliberate:** the glyphless font objects are allocated LAZILY, on the first page that writes a span, and finished in a `finally` — so a run that writes nothing allocates nothing (rather than leaving objects for the sweep), and an aborted run still gets a complete `/ToUnicode` for the pages it did write.
- **Known limit, documented not fixed:** this library's extraction orders glyphs by x and does no bidi reordering, so right-to-left text written in logical order extracts in logical order here; other viewers may reorder it.

## Review Focus

1. **Save and reopen** — a reasonable person saves the result; the layer, its font and `/ToUnicode` must survive `Save()`/`Open()` and still extract and position correctly. Pinned in Task 4.
2. **A page whose content leaves the CTM changed** (`2 0 0 2 0 0 cm` with no `q`/`Q`) — the layer must still land on the picture's words, not be scaled with the leftover CTM. Pinned in Task 4.
3. **Decomposed input** (`e` + U+0301) from an engine — extraction yields the composed `é` (NFC), so a search for `é` finds it. Pinned in Task 4.
4. **A page whose OCR exceeds 65,535 distinct characters** — that page fails and is reported; the NEXT page still succeeds (the assigner is not poisoned). Pinned in Task 1 (atomic `encode`) and Task 3.
5. **A non-default `dpi`** — at 144 dpi the pixel→point mapping halves; boxes still land correctly. Pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/fontembed.ts` (modify) | export the existing `buildToUnicode` and `flateStream` so `glyphless.ts` reuses them |
| `src/glyphless.ts` (create) | glyphless TrueType program, `GlyphlessCodes`, `createGlyphlessFont` |
| `src/ocr.ts` (create) | `OcrImage`, `OcrSpan`, `OcrEngine` |
| `src/ocrlayer.ts` (create) | `buildOcrLayer` — pure span → content bytes |
| `src/makesearchable.ts` (create) | `makeSearchable`, `ocrDeviceMatrix`, option/report types |
| `src/aiocr.ts` (create) | `aiOcrEngine`, `AiOcrOptions` |
| `src/document.ts`, `src/index.ts` (modify) | `Document.MakeSearchable`; exports |
| `test/glyphless.test.ts`, `test/ocrlayer.test.ts`, `test/make-searchable.test.ts`, `test/make-searchable-geometry.test.ts`, `test/aiocr.test.ts` (create) | tests |
| `test/helpers/fake-ocr.ts` (create) | a scripted `OcrEngine` |
| `README.md`, `CLAUDE.md`, `CHANGELOG.md` (modify) | docs |

---

### Task 1: The glyphless font

**Files:**
- Modify: `src/fontembed.ts` (lines 17 and 63: add `export` to `flateStream` and `buildToUnicode`)
- Create: `src/glyphless.ts`
- Test: `test/glyphless.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const GLYPHLESS_ADVANCE: 500;               // 1/1000 em
  export function glyphlessProgram(): Uint8Array;     // the TrueType bytes, built once
  export class GlyphlessCodes {
    encode(text: string): number[];                  // one code per code point; atomic
    get maxCode(): number;                           // 0 when nothing assigned
    entries(): [number, string][];                   // [code, char], ascending
  }
  export interface GlyphlessFont { font: PdfRef; finish(codes: GlyphlessCodes): void }
  export function createGlyphlessFont(
    alloc: (o: PdfObject) => PdfRef,
    replace: (r: PdfRef, o: PdfObject) => void,
  ): GlyphlessFont;
  ```

- [ ] **Step 1: Export the two fontembed helpers**

In `src/fontembed.ts` change `function flateStream(` to `export function flateStream(` and `function buildToUnicode(` to `export function buildToUnicode(`. No other change. Run `npx vitest run test/html-identity.test.ts test/font-embed*.test.ts` — expected: PASS (exports move no bytes).

- [ ] **Step 2: Write the failing tests** — `test/glyphless.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { parseSfnt } from '../src/sfnt.js';
import { parseCMap } from '../src/cmap.js';
import { GlyphlessCodes, glyphlessProgram, createGlyphlessFont, GLYPHLESS_ADVANCE } from '../src/glyphless.js';
import { isDict, isRef, isStream, isArray, isName, type PdfObject, type PdfRef } from '../src/types.js';

describe('glyphless program (3ywf.3)', () => {
  it('is a two-glyph TrueType our own parser reads', () => {
    const f = parseSfnt(glyphlessProgram());
    expect(f.numGlyphs).toBe(2);
    expect(f.unitsPerEm).toBe(1000);
    expect(f.postScriptName).toBe('GlyphLessFont');
    expect(f.advanceWidth(1)).toBe(GLYPHLESS_ADVANCE);
    expect(f.glyphOutline(1)).toEqual([]);
  });

  it('is built once and reused', () => {
    expect(glyphlessProgram()).toBe(glyphlessProgram());
  });
});

describe('GlyphlessCodes (3ywf.3)', () => {
  it('assigns codes from 1 in order of first use and reuses them', () => {
    const c = new GlyphlessCodes();
    expect(c.encode('abca')).toEqual([1, 2, 3, 1]);
    expect(c.encode('db')).toEqual([4, 2]);
    expect(c.maxCode).toBe(4);
    expect(c.entries()).toEqual([[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);
  });

  it('gives an astral character ONE code', () => {
    const c = new GlyphlessCodes();
    expect(c.encode('𝐀x')).toEqual([1, 2]);
    expect(c.entries()[0]).toEqual([1, '𝐀']);
  });

  it('refuses past 65,535 distinct characters WITHOUT assigning any (Review Focus 4)', () => {
    const c = new GlyphlessCodes();
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_535; cp++) big += String.fromCodePoint(cp);
    c.encode(big);
    expect(c.maxCode).toBe(65_535);
    expect(() => c.encode('A')).toThrow(RangeError);
    expect(c.maxCode).toBe(65_535);
    expect(c.encode('𐀀')).toEqual([1]); // an existing character still encodes
  });

  it('is atomic: a string that would overflow assigns nothing', () => {
    const c = new GlyphlessCodes();
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_534; cp++) big += String.fromCodePoint(cp);
    c.encode(big);
    expect(() => c.encode('AB')).toThrow(RangeError); // needs 2, has room for 1
    expect(c.maxCode).toBe(65_534);
    expect(c.encode('A')).toEqual([65_535]);
  });
});

describe('createGlyphlessFont (3ywf.3)', () => {
  function store() {
    const objs = new Map<number, PdfObject>();
    let next = 1;
    const alloc = (o: PdfObject): PdfRef => { const r = { kind: 'ref' as const, num: next++, gen: 0 }; objs.set(r.num, o); return r; };
    const replace = (r: PdfRef, o: PdfObject): void => { objs.set(r.num, o); };
    const get = (o: PdfObject | undefined): PdfObject | undefined => (isRef(o) ? objs.get(o.num) : o);
    return { objs, alloc, replace, get };
  }

  it('builds a Type0 / CIDFontType2 font over the embedded program', () => {
    const s = store();
    const { font } = createGlyphlessFont(s.alloc, s.replace);
    const t0 = s.get(font);
    expect(isDict(t0)).toBe(true);
    if (!isDict(t0)) return;
    expect((t0.get('Subtype') as { name: string }).name).toBe('Type0');
    expect((t0.get('BaseFont') as { name: string }).name).toBe('GlyphLessFont');
    expect((t0.get('Encoding') as { name: string }).name).toBe('Identity-H');
    const desc = t0.get('DescendantFonts');
    expect(isArray(desc)).toBe(true);
    const cid = s.get((desc as PdfObject[])[0]);
    if (!isDict(cid)) throw new Error('no CIDFont');
    expect((cid.get('Subtype') as { name: string }).name).toBe('CIDFontType2');
    expect(cid.get('DW')).toBe(500);
    const fd = s.get(cid.get('FontDescriptor'));
    if (!isDict(fd)) throw new Error('no descriptor');
    const ff2 = s.get(fd.get('FontFile2'));
    expect(isStream(ff2)).toBe(true);
    if (isStream(ff2)) expect(new Uint8Array(inflateSync(ff2.raw))).toEqual(glyphlessProgram());
  });

  it('finish() maps every code to GID 1 and writes /ToUnicode for each character', () => {
    const s = store();
    const { font, finish } = createGlyphlessFont(s.alloc, s.replace);
    const codes = new GlyphlessCodes();
    codes.encode('Aж𝐀');
    finish(codes);
    const t0 = s.get(font) as Map<string, PdfObject>;
    const cid = s.get((t0.get('DescendantFonts') as PdfObject[])[0]) as Map<string, PdfObject>;
    const map = s.get(cid.get('CIDToGIDMap'));
    if (!isStream(map)) throw new Error('no CIDToGIDMap stream');
    const bytes = new Uint8Array(inflateSync(map.raw));
    expect(bytes.length).toBe(2 * 4); // codes 0..3
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    expect([0, 1, 2, 3].map((c) => dv.getUint16(c * 2))).toEqual([0, 1, 1, 1]);
    const tu = s.get(t0.get('ToUnicode'));
    if (!isStream(tu)) throw new Error('no ToUnicode');
    const cmap = parseCMap(new Uint8Array(inflateSync(tu.raw)));
    expect([1, 2, 3].map((c) => cmap.lookup(c))).toEqual(['A', 'ж', '𝐀']);
  });

  it('allocates its objects once; finish() replaces in place', () => {
    const s = store();
    const { finish } = createGlyphlessFont(s.alloc, s.replace);
    const n = s.objs.size;
    finish(new GlyphlessCodes());
    expect(s.objs.size).toBe(n);
  });

  it('names its descriptor font and flags it symbolic', () => {
    const s = store();
    const { font } = createGlyphlessFont(s.alloc, s.replace);
    const t0 = s.get(font) as Map<string, PdfObject>;
    const cid = s.get((t0.get('DescendantFonts') as PdfObject[])[0]) as Map<string, PdfObject>;
    const fd = s.get(cid.get('FontDescriptor')) as Map<string, PdfObject>;
    expect(isName(fd.get('FontName'))).toBe(true);
    expect(fd.get('Flags')).toBe(4);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/glyphless.test.ts`
Expected: FAIL — cannot resolve `../src/glyphless.js`.

- [ ] **Step 4: Create `src/glyphless.ts`**

```ts
/** The glyphless font behind `MakeSearchable`'s invisible text (`3ywf.3`).
 *
 *  OCR text is drawn in render mode 3 — never painted — so its glyph SHAPES
 *  are irrelevant, and what matters is that any script extracts and that
 *  validators accept the font. Tesseract and OCRmyPDF answer this with a
 *  "glyphless" font, and so does this module: a two-glyph TrueType (`.notdef`
 *  and one EMPTY glyph), embedded as a composite Identity-H font, where each
 *  distinct character the run meets gets its own code and `/ToUnicode` maps
 *  the code back.
 *
 *  **Invariant:** every code ≥ 1 maps to GID 1, NEVER 0. ISO 14289-2
 *  8.4.5's `NotdefUsed` does NOT exempt render mode 3 (`uafont.ts`).
 *
 *  **Invariant:** `/BaseFont` carries NO subset tag, so PDF/A's `/CIDSet` rule
 *  (subset fonts only) does not apply — the program genuinely is the whole font.
 *
 *  **Invariant:** `/ToUnicode` and `/CIDToGIDMap` are written ONCE, by
 *  `finish`, from the final assigner — every page shares one font object.
 *
 *  A near-LEAF: no `Document`; objects arrive through `alloc`/`replace`. */
import { name, type PdfDict, type PdfObject, type PdfRef, type PdfStream } from './types.js';
import { assembleSfnt, buildCmap } from './sfntwrite.js';
import { buildToUnicode, flateStream } from './fontembed.js';

/** The one advance every code has, in 1/1000 em. */
export const GLYPHLESS_ADVANCE = 500;
const FONT_NAME = 'GlyphLessFont';
const MAX_CODES = 0xffff;

let program: Uint8Array | undefined;

/** The glyphless TrueType program, built once per process. */
export function glyphlessProgram(): Uint8Array {
  program ??= buildProgram();
  return program;
}

function table(len: number, fill: (v: DataView) => void): Uint8Array {
  const b = new Uint8Array(len);
  fill(new DataView(b.buffer));
  return b;
}

function nameTable(): Uint8Array {
  const recs: [number, string][] = [[1, FONT_NAME], [2, 'Regular'], [4, FONT_NAME], [6, FONT_NAME]];
  const strings = recs.map(([, s]) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[i * 2] = s.charCodeAt(i) >> 8; b[i * 2 + 1] = s.charCodeAt(i) & 0xff; }
    return b;
  });
  const header = 6 + 12 * recs.length;
  const total = header + strings.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0); v.setUint16(2, recs.length); v.setUint16(4, header);
  let off = 0;
  recs.forEach(([id], i) => {
    const r = 6 + 12 * i;
    v.setUint16(r, 3); v.setUint16(r + 2, 1); v.setUint16(r + 4, 0x409);
    v.setUint16(r + 6, id); v.setUint16(r + 8, strings[i]!.length); v.setUint16(r + 10, off);
    out.set(strings[i]!, header + off);
    off += strings[i]!.length;
  });
  return out;
}

function buildProgram(): Uint8Array {
  const head = table(54, (v) => {
    v.setUint32(0, 0x00010000); v.setUint32(4, 0x00010000); v.setUint32(8, 0);
    v.setUint32(12, 0x5f0f3cf5); v.setUint16(16, 0x000b); v.setUint16(18, 1000);
    // created/modified (20..35) zero; bbox (36..43) zero: both glyphs are empty.
    v.setUint16(44, 0); v.setUint16(46, 8); v.setInt16(48, 2);
    v.setInt16(50, 0); v.setInt16(52, 0); // short loca, glyph data format 0
  });
  const hhea = table(36, (v) => {
    v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setInt16(8, 0);
    v.setUint16(10, GLYPHLESS_ADVANCE); v.setInt16(18, 1); v.setUint16(34, 2);
  });
  const maxp = table(32, (v) => { v.setUint32(0, 0x00010000); v.setUint16(4, 2); v.setUint16(14, 2); });
  const hmtx = table(8, (v) => { v.setUint16(0, GLYPHLESS_ADVANCE); v.setUint16(4, GLYPHLESS_ADVANCE); });
  const loca = new Uint8Array(6); // three zero offsets: both glyphs empty
  const glyf = new Uint8Array(0);
  const post = table(32, (v) => { v.setUint32(0, 0x00030000); v.setInt16(8, -100); v.setInt16(10, 50); });
  return assembleSfnt(0x00010000, [
    { tag: 'head', data: head }, { tag: 'hhea', data: hhea }, { tag: 'maxp', data: maxp },
    { tag: 'hmtx', data: hmtx }, { tag: 'loca', data: loca }, { tag: 'glyf', data: glyf },
    { tag: 'cmap', data: buildCmap(new Map([[0x20, 1]])) }, { tag: 'name', data: nameTable() },
    { tag: 'post', data: post },
  ]);
}

/** One code per distinct character (code point), assigned from 1. */
export class GlyphlessCodes {
  private readonly byChar = new Map<string, number>();
  private readonly chars: string[] = [];

  /** The codes for `text`, one per code point. ATOMIC: a string that would push
   *  the font past 65,535 characters assigns nothing and throws `RangeError`,
   *  so one oversized page cannot poison the pages after it. */
  encode(text: string): number[] {
    const fresh = new Set<string>();
    for (const ch of text) if (!this.byChar.has(ch)) fresh.add(ch);
    if (this.chars.length + fresh.size > MAX_CODES)
      throw new RangeError(`glyphless font: more than ${MAX_CODES} distinct characters`);
    for (const ch of fresh) { this.chars.push(ch); this.byChar.set(ch, this.chars.length); }
    return [...text].map((ch) => this.byChar.get(ch)!);
  }

  get maxCode(): number { return this.chars.length; }

  entries(): [number, string][] { return this.chars.map((ch, i) => [i + 1, ch]); }
}

export interface GlyphlessFont {
  /** The Type0 font dictionary, to register in a page's `/Resources /Font`. */
  font: PdfRef;
  /** Write `/CIDToGIDMap` and `/ToUnicode` from the final assigner. */
  finish(codes: GlyphlessCodes): void;
}

const pstr = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const empty = (): PdfStream => ({ kind: 'stream', dict: new Map(), raw: new Uint8Array(0) });

/** Allocate the glyphless font's objects. `/CIDToGIDMap` and `/ToUnicode` are
 *  placeholders until {@link GlyphlessFont.finish} replaces them in place. */
export function createGlyphlessFont(
  alloc: (o: PdfObject) => PdfRef,
  replace: (r: PdfRef, o: PdfObject) => void,
): GlyphlessFont {
  const bytes = glyphlessProgram();
  const descriptor: PdfDict = new Map<string, PdfObject>([
    ['Type', name('FontDescriptor')], ['FontName', name(FONT_NAME)], ['Flags', 4],
    ['FontBBox', [0, -200, GLYPHLESS_ADVANCE, 800]], ['ItalicAngle', 0],
    ['Ascent', 800], ['Descent', -200], ['CapHeight', 700], ['StemV', 80],
    ['FontFile2', alloc(flateStream(bytes, { Length1: bytes.length }))],
  ]);
  const cidToGid = alloc(empty());
  const toUnicode = alloc(empty());
  const cidFont: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('CIDFontType2')], ['BaseFont', name(FONT_NAME)],
    ['CIDSystemInfo', new Map<string, PdfObject>([
      ['Registry', pstr('Adobe')], ['Ordering', pstr('Identity')], ['Supplement', 0],
    ])],
    ['FontDescriptor', alloc(descriptor)], ['CIDToGIDMap', cidToGid], ['DW', GLYPHLESS_ADVANCE],
  ]);
  const font = alloc(new Map<string, PdfObject>([
    ['Type', name('Font')], ['Subtype', name('Type0')], ['BaseFont', name(FONT_NAME)],
    ['Encoding', name('Identity-H')], ['DescendantFonts', [alloc(cidFont)]], ['ToUnicode', toUnicode],
  ]));
  return {
    font,
    finish(codes: GlyphlessCodes): void {
      const max = codes.maxCode;
      const map = new Uint8Array((max + 1) * 2);
      const v = new DataView(map.buffer);
      for (let c = 1; c <= max; c++) v.setUint16(c * 2, 1);
      replace(cidToGid, flateStream(map));
      replace(toUnicode, flateStream(buildToUnicode(codes.entries())));
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/glyphless.test.ts`
Expected: PASS. If `parseSfnt` refuses the zero-length `glyf`, that is a finding about the program, not the test: give `glyf` 4 zero bytes (`new Uint8Array(4)`) — `loca`'s zero offsets still make both glyphs empty — and ledger the ruling.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — no errors.
```bash
git add src/fontembed.ts src/glyphless.ts test/glyphless.test.ts
git commit -m "feat(3ywf.3): the glyphless font"
```

---

### Task 2: The OCR seam and the text layer

**Files:**
- Create: `src/ocr.ts`, `src/ocrlayer.ts`
- Test: `test/ocrlayer.test.ts`

**Interfaces:**
- Consumes: `GlyphlessCodes`, `GLYPHLESS_ADVANCE` from `src/glyphless.ts`; `Matrix`, `apply`, `invert` from `src/text.ts`; `num` from `src/pagecontent.ts`.
- Produces:
  ```ts
  // src/ocr.ts
  export interface OcrImage { bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number }
  export interface OcrSpan { text: string; box: [x0: number, y0: number, x1: number, y1: number] }
  export interface OcrEngine { recognize(image: OcrImage, opts: { signal?: AbortSignal }): Promise<OcrSpan[]> }
  // src/ocrlayer.ts
  export interface OcrLayer { body: Uint8Array; written: number; dropped: number }
  export function buildOcrLayer(
    spans: readonly OcrSpan[], device: Matrix, image: { width: number; height: number },
    codes: GlyphlessCodes, fontKey: string,
  ): OcrLayer;
  ```

- [ ] **Step 1: Write the failing tests** — `test/ocrlayer.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildOcrLayer } from '../src/ocrlayer.js';
import { GlyphlessCodes } from '../src/glyphless.js';
import type { Matrix } from '../src/text.js';

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
/** Device matrix of a 200x100 page at scale 1, Rotate 0: page → pixels. */
const FLIP: Matrix = [1, 0, 0, -1, 0, 100];
const IMG = { width: 200, height: 100 };

/** The numbers of the one `Tm` in a single-span layer. */
function tm(body: Uint8Array): number[] {
  const m = /([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) ([-\d.e]+) Tm/.exec(dec(body));
  if (!m) throw new Error('no Tm');
  return m.slice(1).map(Number);
}

describe('buildOcrLayer (3ywf.3)', () => {
  it('writes one invisible text object in the named font', () => {
    const l = buildOcrLayer([{ text: 'Hi', box: [10, 20, 50, 40] }], FLIP, IMG, new GlyphlessCodes(), 'OCR0');
    const s = dec(l.body);
    expect(s.startsWith('BT\n/OCR0 1 Tf\n3 Tr\n')).toBe(true);
    expect(s.endsWith('ET')).toBe(true);
    expect(s).toContain('<00010002> Tj');
    expect(l).toMatchObject({ written: 1, dropped: 0 });
  });

  it('maps the box bottom-left to the origin and stretches the natural width onto the box', () => {
    // box x 10..50 (40px), y 20..40 (20px) at scale 1 on a flipped page:
    // origin = (10, 100-40) = (10, 60); two glyphs of 0.5 em → natural 1.0,
    // so a = 40 / 1.0; up = (0, 20).
    const l = buildOcrLayer([{ text: 'Hi', box: [10, 20, 50, 40] }], FLIP, IMG, new GlyphlessCodes(), 'F');
    expect(tm(l.body)).toEqual([40, 0, 0, 20, 10, 60]);
  });

  it('follows a rotated device matrix with no special case', () => {
    // Rotate 90, 200x100 page: device maps page (x, y) to pixel (y, x).
    const ROT90: Matrix = [0, 1, 1, 0, 0, 0];
    const l = buildOcrLayer([{ text: 'Hi', box: [10, 20, 50, 40] }], ROT90, { width: 100, height: 200 }, new GlyphlessCodes(), 'F');
    // origin pixel (10, 40) → page (40, 10); along pixel +x → page +y; up pixel −y → page −x.
    expect(tm(l.body)).toEqual([0, 40, -20, 0, 40, 10]);
  });

  it('NFC-normalizes text before encoding', () => {
    const codes = new GlyphlessCodes();
    buildOcrLayer([{ text: 'é', box: [0, 0, 10, 10] }], FLIP, IMG, codes, 'F');
    expect(codes.entries()).toEqual([[1, 'é']]);
  });

  it('drops and counts bad spans', () => {
    const bad = [
      { text: '   ', box: [0, 0, 10, 10] },                 // whitespace only
      { text: '', box: [0, 0, 10, 10] },                    // empty
      { text: 'a', box: [10, 10, 10, 20] },                 // zero width
      { text: 'a', box: [20, 10, 10, 20] },                 // inverted
      { text: 'a', box: [0, Number.NaN, 10, 20] },          // non-finite
      { text: 'a', box: [300, 10, 400, 20] },               // wholly outside
    ] as const;
    const l = buildOcrLayer(bad as never, FLIP, IMG, new GlyphlessCodes(), 'F');
    expect(l).toMatchObject({ written: 0, dropped: 6 });
  });

  it('clamps a box partly outside the image', () => {
    const l = buildOcrLayer([{ text: 'Hi', box: [-10, 20, 30, 40] }], FLIP, IMG, new GlyphlessCodes(), 'F');
    expect(tm(l.body)).toEqual([30, 0, 0, 20, 0, 60]);
  });

  it('lets an encode overflow propagate (the page fails, the caller decides)', () => {
    const codes = new GlyphlessCodes();
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_535; cp++) big += String.fromCodePoint(cp);
    codes.encode(big);
    expect(() => buildOcrLayer([{ text: 'A', box: [0, 0, 10, 10] }], FLIP, IMG, codes, 'F')).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/ocrlayer.test.ts`
Expected: FAIL — cannot resolve `../src/ocrlayer.js`.

- [ ] **Step 3: Create `src/ocr.ts`**

```ts
/** The OCR seam (`3ywf.3`): pixels in, positioned text out.
 *
 *  `MakeSearchable` renders each page and hands the image to an
 *  {@link OcrEngine} the caller supplies — `aiOcrEngine` over an `AiModel`, or
 *  a few-line adapter over Tesseract or a cloud OCR service. Vision LLMs read
 *  well and box poorly; dedicated OCR boxes well. The seam lets the caller
 *  choose. A LEAF importing nothing. */

/** A rendered page. */
export interface OcrImage {
  bytes: Uint8Array;
  mediaType: 'image/png' | 'image/jpeg';
  /** Pixels. */
  width: number;
  height: number;
}

/** One recognized run of text — a word or a whole line — and where it sits:
 *  `box` is `[x0, y0, x1, y1]` in image PIXELS, origin top-left, y downward. */
export interface OcrSpan {
  text: string;
  box: [x0: number, y0: number, x1: number, y1: number];
}

/** Recognizes the text in a page image. */
export interface OcrEngine {
  recognize(image: OcrImage, opts: { signal?: AbortSignal }): Promise<OcrSpan[]>;
}
```

- [ ] **Step 4: Create `src/ocrlayer.ts`**

```ts
/** The invisible text layer one page's OCR spans become (`3ywf.3`).
 *
 *  PURE: spans, the renderer's page→pixel matrix and the code assigner in;
 *  content-stream bytes out. No `Document`.
 *
 *  **Invariant:** the stretch lives in `Tm`, not `Tz`. With font size 1 and a
 *  uniform advance, each span's natural width is `0.5 × codes`; the text
 *  matrix maps that onto the box's along-vector, the box height onto its
 *  up-vector, and the box's bottom-left onto the origin — all through the
 *  INVERSE of the device matrix, so a rotated page needs no special case.
 *
 *  **Invariant:** a span is refused rather than guessed: non-finite, inverted,
 *  zero-area or wholly-outside boxes and whitespace-only text are dropped and
 *  counted; a box partly outside the image is clamped to it. */
import type { OcrSpan } from './ocr.js';
import { GLYPHLESS_ADVANCE, type GlyphlessCodes } from './glyphless.js';
import { apply, invert, type Matrix } from './text.js';
import { num } from './pagecontent.js';

export interface OcrLayer {
  /** `BT … ET`, or an empty text object when nothing was written. */
  body: Uint8Array;
  written: number;
  dropped: number;
}

export function buildOcrLayer(
  spans: readonly OcrSpan[], device: Matrix, image: { width: number; height: number },
  codes: GlyphlessCodes, fontKey: string,
): OcrLayer {
  const inv = invert(device);
  const [ox, oy] = apply(inv, 0, 0);
  const linear = (dx: number, dy: number): [number, number] => {
    const [x, y] = apply(inv, dx, dy);
    return [x - ox, y - oy];
  };
  let out = `BT\n/${fontKey} 1 Tf\n3 Tr\n`;
  let written = 0;
  let dropped = 0;
  for (const s of spans) {
    const text = typeof s.text === 'string' ? s.text.normalize('NFC') : '';
    const b = s.box;
    if (text.trim() === '' || !Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) { dropped++; continue; }
    const x0 = Math.max(0, b[0]); const y0 = Math.max(0, b[1]);
    const x1 = Math.min(image.width, b[2]); const y1 = Math.min(image.height, b[3]);
    if (!(x1 > x0 && y1 > y0)) { dropped++; continue; }
    const cs = codes.encode(text);
    const natural = (GLYPHLESS_ADVANCE / 1000) * cs.length;
    const [ax, ay] = linear((x1 - x0) / natural, 0);
    const [ux, uy] = linear(0, -(y1 - y0));
    const [px, py] = apply(inv, x0, y1);
    const hex = cs.map((c) => c.toString(16).toUpperCase().padStart(4, '0')).join('');
    out += `${num(ax)} ${num(ay)} ${num(ux)} ${num(uy)} ${num(px)} ${num(py)} Tm\n<${hex}> Tj\n`;
    written++;
  }
  out += 'ET';
  return { body: new TextEncoder().encode(out), written, dropped };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/ocrlayer.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck, cycles, commit**

Run: `npm run typecheck`, then `npx vitest run test/import-cycles.test.ts` — both clean.
```bash
git add src/ocr.ts src/ocrlayer.ts test/ocrlayer.test.ts
git commit -m "feat(3ywf.3): OcrEngine seam and the invisible text layer"
```

---

### Task 3: `MakeSearchable` orchestration

**Files:**
- Create: `src/makesearchable.ts`, `test/helpers/fake-ocr.ts`
- Modify: `src/document.ts` (import line 11 area; method before the `ValidatePdfUa` JSDoc), `src/index.ts`, `README.md`
- Test: `test/make-searchable.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `baseMatrix` (`src/pagerender.ts`), `mul` (`src/text.ts`), `resolvePages` (`src/pagerange.ts`), `appendContent`, `ensureOwnResources`, `ensureOwnSubdict`, `freshKey`, `wrapArtifact` (`src/pagecontent.ts`), `hasSignatureField` (`src/signature.ts`).
- Produces:
  ```ts
  export interface MakeSearchableOptions { pages?: number[] | string; force?: boolean; dpi?: number; signal?: AbortSignal; onPage?: (r: MakeSearchablePage) => void }
  export interface MakeSearchablePage { page: number; status: 'ocr' | 'skipped' | 'failed'; reason?: string; spans: number; dropped: number }
  export interface MakeSearchableReport { pages: MakeSearchablePage[] }
  export function ocrDeviceMatrix(page: Page, dpi: number): Matrix;
  export function makeSearchable(doc: Document, engine: OcrEngine, opts?: MakeSearchableOptions): Promise<MakeSearchableReport>;
  // Document
  MakeSearchable(engine: OcrEngine, opts?: MakeSearchableOptions): Promise<MakeSearchableReport>;
  // test/helpers/fake-ocr.ts
  export function fakeOcr(byPage: (n: number, image: OcrImage) => OcrSpan[] | Promise<OcrSpan[]>): OcrEngine & { calls: OcrImage[] };
  ```

- [ ] **Step 1: Create the fake engine** — `test/helpers/fake-ocr.ts`

```ts
import type { OcrEngine, OcrImage, OcrSpan } from '../../src/ocr.js';

/** A scripted OcrEngine: `byPage(n, image)` answers the n-th call (1-based). */
export function fakeOcr(
  byPage: (n: number, image: OcrImage) => OcrSpan[] | Promise<OcrSpan[]>,
): OcrEngine & { calls: OcrImage[] } {
  const calls: OcrImage[] = [];
  return {
    calls,
    async recognize(image: OcrImage): Promise<OcrSpan[]> {
      calls.push(image);
      return byPage(calls.length, image);
    },
  };
}
```

- [ ] **Step 2: Write the failing tests** — `test/make-searchable.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { isDict, isRef, type PdfObject } from '../src/types.js';
import { fakeOcr } from './helpers/fake-ocr.js';
import type { OcrSpan } from '../src/ocr.js';

const span = (text: string): OcrSpan[] => [{ text, box: [20, 30, 100, 50] }];
const blank = (pages = 1): Document => {
  const doc = Document.New(PageFormat.custom(200, 100));
  for (let i = 1; i < pages; i++) doc.AddPage(PageFormat.custom(200, 100));
  return doc;
};
const fontRefOf = (doc: Document, n: number): PdfObject | undefined => {
  const fonts = doc.resolve(doc.Pages[n - 1]!.Resources?.get('Font'));
  return isDict(fonts) ? [...fonts.values()][0] : undefined;
};

describe('MakeSearchable (3ywf.3)', () => {
  it('writes the recognized text so GetText and Search find it', async () => {
    const doc = blank();
    const r = await doc.MakeSearchable(fakeOcr(() => span('Hello world')));
    expect(r.pages).toEqual([{ page: 1, status: 'ocr', spans: 1, dropped: 0 }]);
    expect(doc.Pages[0]!.GetText()).toContain('Hello world');
    expect(doc.Pages[0]!.Search('world')).toHaveLength(1);
  });

  it('renders at dpi/72 and hands the engine the real pixel size', async () => {
    const doc = blank();
    const eng = fakeOcr(() => []);
    await doc.MakeSearchable(eng, { dpi: 144 });
    expect(eng.calls[0]).toMatchObject({ mediaType: 'image/png', width: 400, height: 200 });
  });

  it('skips a page that already has text, reports it, and does not call the engine', async () => {
    const doc = blank(2);
    doc.Pages[0]!.AddText('Existing', 50, 50);
    const eng = fakeOcr(() => span('New'));
    const r = await doc.MakeSearchable(eng);
    expect(r.pages[0]).toEqual({ page: 1, status: 'skipped', reason: 'has-text', spans: 0, dropped: 0 });
    expect(r.pages[1]!.status).toBe('ocr');
    expect(eng.calls).toHaveLength(1);
  });

  it('OCRs a page with text anyway under force', async () => {
    const doc = blank();
    doc.Pages[0]!.AddText('Existing', 50, 50);
    const r = await doc.MakeSearchable(fakeOcr(() => span('Added')), { force: true });
    expect(r.pages[0]!.status).toBe('ocr');
    expect(doc.Pages[0]!.GetText()).toContain('Added');
  });

  it('limits the run to the selected pages', async () => {
    const doc = blank(3);
    const eng = fakeOcr(() => span('x'));
    const r = await doc.MakeSearchable(eng, { pages: '2' });
    expect(r.pages.map((p) => p.page)).toEqual([2]);
    expect(eng.calls).toHaveLength(1);
  });

  it('records a failing page and carries on', async () => {
    const doc = blank(3);
    const eng = fakeOcr((n) => { if (n === 2) throw new Error('engine down'); return span(`p${n}`); });
    const r = await doc.MakeSearchable(eng);
    expect(r.pages.map((p) => p.status)).toEqual(['ocr', 'failed', 'ocr']);
    expect(r.pages[1]!.reason).toBe('engine down');
    expect(doc.Pages[2]!.GetText()).toContain('p3');
  });

  it('fails a page whose engine returns something that is not spans', async () => {
    const doc = blank();
    const r = await doc.MakeSearchable(fakeOcr(() => 'nope' as never));
    expect(r.pages[0]!.status).toBe('failed');
  });

  it('fails a page past 65,535 distinct characters and the next page still works (Review Focus 4)', async () => {
    const doc = blank(2);
    let big = '';
    for (let cp = 0x10000; cp < 0x10000 + 65_536; cp++) big += String.fromCodePoint(cp);
    const r = await doc.MakeSearchable(fakeOcr((n) => (n === 1 ? span(big) : span('AB'))));
    expect(r.pages.map((p) => p.status)).toEqual(['failed', 'ocr']);
    expect(doc.Pages[1]!.GetText()).toContain('AB');
  });

  it('shares ONE font object across pages', async () => {
    const doc = blank(2);
    await doc.MakeSearchable(fakeOcr((n) => span(`page ${n}`)));
    const a = fontRefOf(doc, 1); const b = fontRefOf(doc, 2);
    expect(isRef(a) && isRef(b) && a.num === b.num).toBe(true);
  });

  it('allocates no font when nothing is written', async () => {
    const doc = blank();
    await doc.MakeSearchable(fakeOcr(() => []));
    expect(new TextDecoder('latin1').decode(doc.Save())).not.toContain('GlyphLessFont');
  });

  it('stops on abort, keeping the finished page and its complete /ToUnicode', async () => {
    const doc = blank(2);
    const ctrl = new AbortController();
    const eng = fakeOcr((n) => { if (n === 1) ctrl.abort(new Error('stop')); return span(`p${n}`); });
    await expect(doc.MakeSearchable(eng, { signal: ctrl.signal })).rejects.toThrow('stop');
    expect(eng.calls).toHaveLength(1);
    expect(doc.Pages[0]!.GetText()).toContain('p1');
  });

  it('reports progress after each page', async () => {
    const doc = blank(2);
    const seen: number[] = [];
    await doc.MakeSearchable(fakeOcr(() => span('x')), { onPage: (p) => seen.push(p.page) });
    expect(seen).toEqual([1, 2]);
  });

  it('refuses a document with signature fields', async () => {
    const doc = blank();
    doc.Form.AddSignatureField({ page: 1, rect: [10, 10, 60, 30], name: 'S' });
    await expect(doc.MakeSearchable(fakeOcr(() => span('x')))).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it('validates its arguments', async () => {
    const doc = blank();
    await expect(doc.MakeSearchable({} as never)).rejects.toThrow(TypeError);
    await expect(doc.MakeSearchable(fakeOcr(() => []), { dpi: 0 })).rejects.toThrow(RangeError);
    await expect(doc.MakeSearchable(fakeOcr(() => []), { dpi: 1201 })).rejects.toThrow(RangeError);
    await expect(doc.MakeSearchable(fakeOcr(() => []), { pages: [9] })).rejects.toThrow(RangeError);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/make-searchable.test.ts`
Expected: FAIL — `doc.MakeSearchable is not a function`.

- [ ] **Step 4: Create `src/makesearchable.ts`**

```ts
/** `doc.MakeSearchable` (`3ywf.3`): an invisible, exactly placed text layer
 *  over image-only pages, from an {@link OcrEngine} the caller supplies.
 *
 *  The only module of the feature touching a `Document`. It renders each page,
 *  asks the engine, and splices `ocrlayer.ts`'s bytes in with `appendContent`,
 *  which wraps the existing content in `q … Q` so a CTM the page leaves changed
 *  cannot move the layer.
 *
 *  **Invariant:** the page→pixel matrix is {@link ocrDeviceMatrix}, which is
 *  `renderCanvas`'s own composition — the render and the layer cannot disagree
 *  about where a pixel is.
 *
 *  **Invariant:** a failing page is RECORDED and the run continues; a caller
 *  abort stops it and throws. Pages already written keep their layer, and the
 *  font is finished in a `finally`, so an aborted run leaves a complete
 *  `/ToUnicode` behind rather than a placeholder.
 *
 *  **Invariant:** the font is allocated LAZILY, on the first page that writes
 *  a span, so a run that writes nothing changes nothing. */
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { OcrEngine, OcrSpan } from './ocr.js';
import { baseMatrix } from './pagerender.js';
import { mul, type Matrix } from './text.js';
import { resolvePages } from './pagerange.js';
import { appendContent, ensureOwnResources, ensureOwnSubdict, freshKey, wrapArtifact } from './pagecontent.js';
import { createGlyphlessFont, GlyphlessCodes, type GlyphlessFont } from './glyphless.js';
import { buildOcrLayer } from './ocrlayer.js';
import { hasSignatureField } from './signature.js';
import { UnsupportedFeatureError, rethrowLimit } from './errors.js';
import { isDict } from './types.js';

export interface MakeSearchableOptions {
  /** Pages to consider: `[1, 3]` or `"1-5,8"`. Default all. */
  pages?: number[] | string;
  /** OCR pages that already have text. Adds a layer; removes none. Default false. */
  force?: boolean;
  /** Render resolution handed to the engine. Default 200; at most 1200. */
  dpi?: number;
  signal?: AbortSignal;
  /** Called after each page with that page's record. */
  onPage?: (r: MakeSearchablePage) => void;
}

export interface MakeSearchablePage {
  /** 1-based. */
  page: number;
  status: 'ocr' | 'skipped' | 'failed';
  /** `'has-text'` for a skipped page; the error message for a failed one. */
  reason?: string;
  /** Spans written. */
  spans: number;
  /** Spans refused: a bad box, or empty text. */
  dropped: number;
}

export interface MakeSearchableReport { pages: MakeSearchablePage[] }

/** Page space → rendered pixels at `dpi`: `renderCanvas`'s composition. */
export function ocrDeviceMatrix(page: Page, dpi: number): Matrix {
  const s = dpi / 72;
  return mul(baseMatrix(page, 'crop').matrix, [s, 0, 0, s, 0, 0]);
}

/** Width and height from a PNG's IHDR. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

function isSpans(v: unknown): v is OcrSpan[] {
  return Array.isArray(v) && v.every((s) =>
    s !== null && typeof s === 'object' && typeof (s as OcrSpan).text === 'string'
    && Array.isArray((s as OcrSpan).box) && (s as OcrSpan).box.length === 4
    && (s as OcrSpan).box.every((n) => typeof n === 'number'));
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function makeSearchable(
  doc: Document, engine: OcrEngine, opts: MakeSearchableOptions = {},
): Promise<MakeSearchableReport> {
  if (engine === null || typeof engine !== 'object' || typeof engine.recognize !== 'function')
    throw new TypeError('engine must have a recognize(image, opts) method');
  if (opts === null || typeof opts !== 'object') throw new TypeError('options must be an object');
  const dpi = opts.dpi ?? 200;
  if (typeof dpi !== 'number') throw new TypeError('dpi must be a number');
  if (!(dpi > 0 && dpi <= 1200)) throw new RangeError(`dpi must be in (0, 1200]: ${dpi}`);
  if (opts.onPage !== undefined && typeof opts.onPage !== 'function') throw new TypeError('onPage must be a function');
  const selected = resolvePages(opts.pages, doc.Pages.length);
  if (hasSignatureField(doc))
    throw new UnsupportedFeatureError('MakeSearchable: the document has signature fields; a text layer on every page would invalidate them');

  const tagged = doc.GetStructTree() !== null;
  const codes = new GlyphlessCodes();
  const pages: MakeSearchablePage[] = [];
  let font: GlyphlessFont | undefined;
  const record = (r: MakeSearchablePage): void => { pages.push(r); opts.onPage?.(r); };

  try {
    for (const n of selected) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const page = doc.Pages[n - 1]!;
      if (!opts.force && page.GetText().trim() !== '') {
        record({ page: n, status: 'skipped', reason: 'has-text', spans: 0, dropped: 0 });
        continue;
      }
      const failed = (reason: string): void => record({ page: n, status: 'failed', reason, spans: 0, dropped: 0 });
      let spans: unknown;
      let size: { width: number; height: number };
      try {
        const png = page.ToImage({ format: 'png', scale: dpi / 72 });
        size = pngSize(png);
        spans = await engine.recognize({ bytes: png, mediaType: 'image/png', ...size }, { signal: opts.signal });
      } catch (caught) {
        rethrowLimit(caught);
        if (opts.signal?.aborted) throw opts.signal.reason;
        failed(message(caught));
        continue;
      }
      if (!isSpans(spans)) { failed('engine returned something other than an array of { text, box } spans'); continue; }

      const existing = doc.resolve(page.Resources?.get('Font'));
      const key = freshKey(isDict(existing) ? existing : new Map(), 'OCR');
      let layer;
      try {
        layer = buildOcrLayer(spans, ocrDeviceMatrix(page, dpi), size, codes, key);
      } catch (caught) {
        rethrowLimit(caught);
        failed(message(caught));
        continue;
      }
      if (layer.written > 0) {
        font ??= createGlyphlessFont((o) => doc.allocObject(o), (r, o) => doc.replaceObject(r.num, o));
        const fonts = ensureOwnSubdict(doc, ensureOwnResources(doc, page), 'Font');
        fonts.set(key, font.font);
        appendContent(doc, page, tagged ? wrapArtifact(layer.body) : layer.body);
      }
      record({ page: n, status: 'ocr', spans: layer.written, dropped: layer.dropped });
    }
  } finally {
    if (font) { font.finish(codes); doc.markModified(); }
  }
  return { pages };
}
```

- [ ] **Step 5: Wire `Document.MakeSearchable`**

In `src/document.ts`, directly below line 11 (`import { PdfParseError, … } from './errors.js';`), add:
```ts
import { makeSearchable, type MakeSearchableOptions, type MakeSearchableReport } from './makesearchable.js';
import type { OcrEngine } from './ocr.js';
```
Then insert immediately before the line `  /** Validate the document against a curated, machine-checkable subset of` (the `ValidatePdfUa` JSDoc):
```ts
  /** Add an invisible, exactly placed text layer to image-only pages so text
   *  extraction, search and copy-paste find their words (`3ywf.3`). Each
   *  selected page is rendered at `dpi` and handed to `engine`; the spans it
   *  returns are written in render mode 3 over a built-in glyphless font, so
   *  the page looks unchanged. Pages that already have text are skipped unless
   *  `force`. A failing page is reported and the run continues; an abort
   *  stops it. Refuses a document with signature fields. */
  MakeSearchable(engine: OcrEngine, opts?: MakeSearchableOptions): Promise<MakeSearchableReport> {
    return makeSearchable(this, engine, opts);
  }

```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/make-searchable.test.ts`
Expected: PASS (14 tests). If `doc.markModified` is not callable from outside the class (private), call it the way other modules do — `grep -n "markModified()" src/*.ts | head` — and ledger the ruling.

- [ ] **Step 7: Exports and README rows**

In `src/index.ts`, after the `aiopenai.js` export lines, add:
```ts
export type { OcrEngine, OcrImage, OcrSpan } from './ocr.js';
export type { MakeSearchableOptions, MakeSearchablePage, MakeSearchableReport } from './makesearchable.js';
```
In README's `### AI` table, after the `OpenAiModelOptions` row, add:
```markdown
| `OcrEngine` | Recognizes the text in a page image: `recognize(image, { signal })` returns `OcrSpan`s. Implement it over Tesseract or a cloud OCR service, or use `aiOcrEngine`. |
| `OcrImage` | A rendered page handed to an `OcrEngine`: PNG or JPEG `bytes`, `mediaType`, and its `width` and `height` in pixels. |
| `OcrSpan` | One recognized run of text — a word or a line — with its `box` `[x0, y0, x1, y1]` in image pixels, origin top-left. |
| `MakeSearchableOptions` | Options for `MakeSearchable`: `pages`, `force` (OCR pages that already have text), `dpi` (default 200), `signal`, `onPage`. |
| `MakeSearchablePage` | One page's outcome: `status` `ocr`, `skipped` (`reason: 'has-text'`) or `failed` (`reason` the error), with `spans` written and `dropped`. |
| `MakeSearchableReport` | What `MakeSearchable` did: one `MakeSearchablePage` per selected page. |
```
Run `npx vitest run test/readme-api.test.ts` and update the count sentence to the numbers it reports.

- [ ] **Step 8: Gates and commit**

Run: `npm run typecheck`, then `npx vitest run test/make-searchable.test.ts test/glyphless.test.ts test/ocrlayer.test.ts test/readme-api.test.ts test/limits-catch.test.ts test/import-cycles.test.ts` — all PASS.
```bash
git add src/makesearchable.ts src/document.ts src/index.ts test/helpers/fake-ocr.ts test/make-searchable.test.ts README.md
git commit -m "feat(3ywf.3): Document.MakeSearchable"
```

---

### Task 4: Geometry and conformance — the integration oracle

These tests pin Task 3's output against things it does not compute: hand-derived page coordinates, the extractor's own glyph positions, the renderer, and the validators. They may pass on first run; Task 6's mutations prove they can fail.

**Files:**
- Test: `test/make-searchable-geometry.test.ts`
- Modify: `src/*` only if a test exposes a defect

**Interfaces:**
- Consumes: `Document.MakeSearchable`; `visitContent`, `GlyphEvent` (`src/text.ts`); `fakeOcr`; `buildPdfaPdf` (`test/helpers/build-pdfa-pdf.ts`); `buildTaggedPdf` (`test/helpers/build-tagged-pdf.ts`); `streamOf` (`src/pagecontent.ts`).

- [ ] **Step 1: Write the tests** — `test/make-searchable-geometry.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { PageFormat } from '../src/pageformat.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { streamOf } from '../src/pagecontent.js';
import { fakeOcr } from './helpers/fake-ocr.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';

const BOX: [number, number, number, number] = [20, 30, 100, 50]; // pixels
const TEXT = 'ABCD';

function glyphs(doc: Document, page: Page): GlyphEvent[] {
  const out: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: (e) => { out.push(e); } });
  return out;
}

/** Page point of pixel (px, py) on a 200x100 page at scale 1 — derived by hand
 *  from PDF 32000-1 8.3 and /Rotate, NOT from baseMatrix. */
const PAGE_OF: Record<number, (px: number, py: number) => [number, number]> = {
  0: (px, py) => [px, 100 - py],
  90: (px, py) => [py, px],
  180: (px, py) => [200 - px, py],
  270: (px, py) => [200 - py, 100 - px],
};
/** Direction of the text baseline in page space. */
const ANGLE: Record<number, number> = { 0: 0, 90: Math.PI / 2, 180: Math.PI, 270: -Math.PI / 2 };

function expectSpanAt(g: GlyphEvent[], at: (px: number, py: number) => [number, number], angle: number, height: number): void {
  expect(g.map((e) => e.text).join('')).toBe(TEXT);
  const [x0, , x1, y1] = BOX;
  const step = (x1 - x0) / TEXT.length;
  for (let i = 0; i < TEXT.length; i++) {
    const [ex, ey] = at(x0 + step * i, y1);
    expect(g[i]!.quad[0]).toBeCloseTo(ex, 3);
    expect(g[i]!.quad[1]).toBeCloseTo(ey, 3);
  }
  expect(Math.cos(g[0]!.angle)).toBeCloseTo(Math.cos(angle), 6);
  expect(Math.sin(g[0]!.angle)).toBeCloseTo(Math.sin(angle), 6);
  expect(g[0]!.fontSize).toBeCloseTo(height, 3);
  expect(g.every((e) => e.renderMode === 3)).toBe(true); // invisible by MODE, not by an empty glyph
}

async function ocrOne(doc: Document, dpi = 72, box = BOX): Promise<void> {
  const r = await doc.MakeSearchable(fakeOcr(() => [{ text: TEXT, box }]), { dpi, force: true });
  expect(r.pages[0]!.status).toBe('ocr');
}

describe('MakeSearchable geometry (3ywf.3)', () => {
  for (const rot of [0, 90, 180, 270]) {
    it(`places each glyph over its pixels on a /Rotate ${rot} page`, async () => {
      const doc = Document.New(PageFormat.custom(200, 100));
      doc.Pages[0]!.Rotate = rot;
      await ocrOne(doc);
      expectSpanAt(glyphs(doc, doc.Pages[0]!), PAGE_OF[rot]!, ANGLE[rot]!, 20);
    });
  }

  it('honours an offset CropBox', async () => {
    const doc = Document.New(PageFormat.custom(300, 300));
    doc.Pages[0]!.CropBox = [50, 60, 250, 160];
    await ocrOne(doc);
    expectSpanAt(glyphs(doc, doc.Pages[0]!), (px, py) => [px + 50, 160 - py], 0, 20);
  });

  it('maps pixels at a non-default dpi (Review Focus 5)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    await ocrOne(doc, 144, [40, 60, 200, 100]); // the same box, doubled
    expectSpanAt(glyphs(doc, doc.Pages[0]!), (px, py) => [px, 100 - py], 0, 20);
  });

  it('is not moved by a CTM the page content leaves changed (Review Focus 2)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    const page = doc.Pages[0]!;
    page.Dict.set('Contents', doc.allocObject(streamOf(new TextEncoder().encode('2 0 0 2 0 0 cm'))));
    await ocrOne(doc);
    expectSpanAt(glyphs(doc, page), PAGE_OF[0]!, 0, 20);
  });

  it('survives Save and Open (Review Focus 1)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    doc.Pages[0]!.Rotate = 90;
    await ocrOne(doc);
    const back = Document.Open(doc.Save());
    expectSpanAt(glyphs(back, back.Pages[0]!), PAGE_OF[90]!, ANGLE[90]!, 20);
    expect(back.Pages[0]!.GetText()).toContain(TEXT);
  });
});

describe('MakeSearchable text and appearance (3ywf.3)', () => {
  it('round-trips Latin, Cyrillic, CJK, Arabic and an astral character', async () => {
    const lines = ['Hello', 'Привет', '漢字テキスト', 'مرحبا', '𝐀𝐁𝐂'];
    const doc = Document.New(PageFormat.custom(200, 100));
    await doc.MakeSearchable(fakeOcr(() => lines.map((t, i) => ({ text: t, box: [10, 10 + i * 15, 150, 22 + i * 15] as [number, number, number, number] }))), { dpi: 72 });
    const back = Document.Open(doc.Save());
    const text = back.Pages[0]!.GetText();
    for (const t of lines) expect(text).toContain(t);
    expect(back.Pages[0]!.Search('Привет')).toHaveLength(1);
  });

  it('extracts decomposed engine text composed (Review Focus 3)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'café', box: [10, 10, 100, 30] }]), { dpi: 72 });
    expect(doc.Pages[0]!.GetText()).toContain('café');
    expect(doc.Pages[0]!.Search('café')).toHaveLength(1);
  });

  it('leaves the rendered page byte-identical', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    doc.Pages[0]!.AddText('Visible', 20, 50);
    const before = doc.Pages[0]!.ToImage();
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'Hidden layer', box: [10, 10, 190, 40] }]), { force: true, dpi: 72 });
    expect(Buffer.compare(Buffer.from(doc.Pages[0]!.ToImage()), Buffer.from(before))).toBe(0);
  });
});

describe('MakeSearchable conformance (3ywf.3)', () => {
  const rules = (issues: { rule: string }[]): string[] => issues.map((i) => i.rule).sort();

  it('adds no PDF/A-2b issue', async () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    const before = rules(doc.ValidatePdfA('2b').Issues);
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'Scanned', box: [10, 10, 100, 30] }]), { force: true, dpi: 72 });
    expect(rules(Document.Open(doc.Save()).ValidatePdfA('2b').Issues)).toEqual(before);
  });

  it('adds no PDF/UA issue to a tagged document, at either part', async () => {
    const doc = Document.Open(buildTaggedPdf());
    const before1 = rules(doc.ValidatePdfUa(1).Issues);
    const before2 = rules(doc.ValidatePdfUa(2).Issues);
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'Scanned', box: [10, 10, 100, 30] }]), { force: true, dpi: 72 });
    const back = Document.Open(doc.Save());
    expect(rules(back.ValidatePdfUa(1).Issues)).toEqual(before1);
    expect(rules(back.ValidatePdfUa(2).Issues)).toEqual(before2);
  });

  it('marks the layer as an artifact in a tagged document only', async () => {
    const tagged = Document.Open(buildTaggedPdf());
    await tagged.MakeSearchable(fakeOcr(() => [{ text: 'Ω', box: [10, 10, 50, 30] }]), { force: true, dpi: 72 });
    const ours = glyphs(tagged, tagged.Pages[0]!).filter((g) => g.text === 'Ω');
    expect(ours.length).toBe(1);
    expect(ours[0]!.artifact).toBe(true);
    const plain = Document.New(PageFormat.custom(200, 100));
    await plain.MakeSearchable(fakeOcr(() => [{ text: 'x', box: [10, 10, 50, 30] }]), { dpi: 72 });
    expect(glyphs(plain, plain.Pages[0]!)[0]!.artifact).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them**

Run: `npx vitest run test/make-searchable-geometry.test.ts`
Expected: PASS. A failure here is a defect in Tasks 1–3 (or, for the hand-derived `PAGE_OF` table, a derivation error — re-derive it from `baseMatrix`'s documented `/Rotate` cases and say which in the ledger). Fix the code under `superpowers:systematic-debugging`; never loosen the tolerance.

- [ ] **Step 3: Commit**

```bash
git add test/make-searchable-geometry.test.ts src/
git commit -m "test(3ywf.3): pin MakeSearchable geometry, scripts, invisibility and conformance"
```

---

### Task 5: `aiOcrEngine`

**Files:**
- Create: `src/aiocr.ts`
- Modify: `src/index.ts`, `README.md`
- Test: `test/aiocr.test.ts`

**Interfaces:**
- Consumes: `AiModel`, `AiRequest` (`src/aimodel.ts`); `OcrEngine`, `OcrImage`, `OcrSpan` (`src/ocr.ts`); `AiServiceError`, `rethrowLimit` (`src/errors.ts`).
- Produces:
  ```ts
  export interface AiOcrOptions { language?: string; maxTokens?: number }
  export function aiOcrEngine(model: AiModel, opts?: AiOcrOptions): OcrEngine;
  ```

- [ ] **Step 1: Write the failing tests** — `test/aiocr.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { aiOcrEngine } from '../src/aiocr.js';
import { AiServiceError } from '../src/errors.js';
import type { AiModel, AiRequest } from '../src/aimodel.js';
import type { OcrImage } from '../src/ocr.js';

const IMAGE: OcrImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 400, height: 200 };

function stub(reply: string): AiModel & { seen: AiRequest[] } {
  const seen: AiRequest[] = [];
  return { seen, complete: async (req) => { seen.push(req); return { text: reply }; } };
}

describe('aiOcrEngine (3ywf.3)', () => {
  it('sends the page image with the ocr_lines schema', async () => {
    const m = stub('{"lines":[]}');
    await aiOcrEngine(m, { language: 'German' }).recognize(IMAGE, {});
    const req = m.seen[0]!;
    expect(req.schema?.name).toBe('ocr_lines');
    expect(req.maxTokens).toBe(4096);
    const system = req.messages[0]!;
    expect(system.role).toBe('system');
    expect(String(system.content)).toContain('German');
    const user = req.messages[1]!;
    expect(Array.isArray(user.content) && user.content.some((p) => p.type === 'image' && p.bytes === IMAGE.bytes)).toBe(true);
  });

  it('scales the 0-1000 grid to pixels and normalizes inverted boxes', async () => {
    const m = stub('{"lines":[{"text":"Hi","box":[100,500,250,100]}]}');
    const spans = await aiOcrEngine(m).recognize(IMAGE, {});
    expect(spans).toEqual([{ text: 'Hi', box: [40, 20, 100, 100] }]);
  });

  it('passes the caller signal through', async () => {
    const m = stub('{"lines":[]}');
    const ctrl = new AbortController();
    await aiOcrEngine(m).recognize(IMAGE, { signal: ctrl.signal });
    expect(m.seen[0]!.signal).toBe(ctrl.signal);
  });

  for (const [what, reply] of [
    ['not JSON', 'sorry'],
    ['no lines array', '{"words":[]}'],
    ['a line without text', '{"lines":[{"box":[0,0,1,1]}]}'],
    ['a box of three numbers', '{"lines":[{"text":"a","box":[0,0,1]}]}'],
    ['a non-finite box', '{"lines":[{"text":"a","box":[0,0,"x",1]}]}'],
  ] as const) {
    it(`throws AiServiceError on ${what}`, async () => {
      await expect(aiOcrEngine(stub(reply)).recognize(IMAGE, {})).rejects.toBeInstanceOf(AiServiceError);
    });
  }

  it('validates its arguments', () => {
    expect(() => aiOcrEngine({} as never)).toThrow(TypeError);
    expect(() => aiOcrEngine(stub(''), { language: 5 as never })).toThrow(TypeError);
    expect(() => aiOcrEngine(stub(''), { maxTokens: 0 })).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/aiocr.test.ts`
Expected: FAIL — cannot resolve `../src/aiocr.js`.

- [ ] **Step 3: Create `src/aiocr.ts`**

```ts
/** `aiOcrEngine` (`3ywf.3`): an {@link OcrEngine} over an {@link AiModel}.
 *
 *  One request per page: the image plus a JSON schema asking for LINES with a
 *  box each, on a 0–1000 grid over the image — the convention vision models
 *  localize best in — scaled to pixels here. Lines rather than words because
 *  models box whole lines far more reliably; the glyphless font's uniform
 *  advance then spreads a line's characters evenly across its box.
 *
 *  **Invariant:** the reply is parsed and its SHAPE checked here — `3ywf.2`
 *  validates no schema, and model output is input we did not write. A reply
 *  that is not `{ lines: [{ text, box: [4 finite numbers] }] }` throws
 *  `AiServiceError`, which `MakeSearchable` records as that page failing. */
import type { AiModel } from './aimodel.js';
import type { OcrEngine, OcrImage, OcrSpan } from './ocr.js';
import { AiServiceError, rethrowLimit } from './errors.js';

/** Options for {@link aiOcrEngine}. */
export interface AiOcrOptions {
  /** The expected language, as a hint in the prompt (e.g. `'German'`, `'ja'`). */
  language?: string;
  /** Upper bound on the reply. Default 4096. */
  maxTokens?: number;
}

const GRID = 1000;
const PROMPT =
  'You are an OCR engine. Transcribe every line of visible text on the page image, in reading order. ' +
  'For each line give its exact text and its bounding box [x0, y0, x1, y1] on a 0-1000 grid over the image: ' +
  'origin top-left, x to the right, y downward. Reply with JSON only.';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['text', 'box'],
        properties: {
          text: { type: 'string' },
          box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
        },
      },
    },
  },
};

/** An {@link OcrEngine} that asks `model` to read each page. */
export function aiOcrEngine(model: AiModel, opts: AiOcrOptions = {}): OcrEngine {
  if (model === null || typeof model !== 'object' || typeof model.complete !== 'function')
    throw new TypeError('model must be an AiModel');
  if (opts.language !== undefined && typeof opts.language !== 'string') throw new TypeError('language must be a string');
  const maxTokens = opts.maxTokens ?? 4096;
  if (typeof maxTokens !== 'number') throw new TypeError('maxTokens must be a number');
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new RangeError('maxTokens must be a positive integer');
  const system = opts.language ? `${PROMPT} The text is expected to be in ${opts.language}.` : PROMPT;

  return {
    async recognize(image: OcrImage, { signal }: { signal?: AbortSignal } = {}): Promise<OcrSpan[]> {
      const r = await model.complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
            { type: 'text', text: 'Transcribe this page.' },
            { type: 'image', bytes: image.bytes, mediaType: image.mediaType },
          ] },
        ],
        schema: { name: 'ocr_lines', schema: SCHEMA },
        maxTokens,
        signal,
      });
      return parseLines(r.text, image.width, image.height);
    },
  };
}

function bad(): AiServiceError {
  return new AiServiceError('OCR reply is not the requested shape');
}

function parseLines(text: string, width: number, height: number): OcrSpan[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (caught) {
    rethrowLimit(caught);
    throw bad();
  }
  const lines = json !== null && typeof json === 'object' ? (json as { lines?: unknown }).lines : undefined;
  if (!Array.isArray(lines)) throw bad();
  return lines.map((l: unknown): OcrSpan => {
    if (l === null || typeof l !== 'object') throw bad();
    const { text: t, box } = l as { text?: unknown; box?: unknown };
    if (typeof t !== 'string' || !Array.isArray(box) || box.length !== 4) throw bad();
    if (!box.every((n) => typeof n === 'number' && Number.isFinite(n))) throw bad();
    const [a, b, c, d] = box as number[];
    const sx = width / GRID; const sy = height / GRID;
    return { text: t, box: [Math.min(a!, c!) * sx, Math.min(b!, d!) * sy, Math.max(a!, c!) * sx, Math.max(b!, d!) * sy] };
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/aiocr.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Exports, README rows, commit**

In `src/index.ts`, after the `makesearchable.js` export line, add:
```ts
export { aiOcrEngine } from './aiocr.js';
export type { AiOcrOptions } from './aiocr.js';
```
In README's `### AI` table, after the `MakeSearchableReport` row, add:
```markdown
| `aiOcrEngine(model, opts?)` | An `OcrEngine` over any `AiModel`: one request per page asking for lines and boxes on a 0–1000 grid, scaled to pixels; a malformed reply throws `AiServiceError`. |
| `AiOcrOptions` | Options for `aiOcrEngine`: a `language` hint for the prompt, and `maxTokens` (default 4096). |
```
Run `npx vitest run test/readme-api.test.ts` and update the count sentence to what it reports. Then `npm run typecheck` and `npx vitest run test/aiocr.test.ts test/readme-api.test.ts test/limits-catch.test.ts test/import-cycles.test.ts` — all PASS.
```bash
git add src/aiocr.ts src/index.ts test/aiocr.test.ts README.md
git commit -m "feat(3ywf.3): aiOcrEngine over AiModel"
```

---

### Task 6: Docs, mutation checks, gates

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: README example** — insert immediately before `## API Reference` (after the `### Connect an AI Model` section):

````markdown
### Make Scanned Pages Searchable

`MakeSearchable` renders each image-only page, hands it to an OCR engine you supply, and writes the recognized text back as an invisible layer exactly over the words in the picture — so `GetText`, `Search`, copy-paste and indexers find them while the page looks unchanged:

```ts
import { Document, aiOcrEngine, openAiModel } from '@asposefoss/pdf';

const doc = Document.Open(scanBytes);
const engine = aiOcrEngine(openAiModel('https://api.openai.com/v1', {
  model: 'gpt-4o', apiKey: process.env.OPENAI_API_KEY,
}));
const report = await doc.MakeSearchable(engine, { dpi: 200 });
for (const p of report.pages) console.log(p.page, p.status, p.reason ?? '');
const out = doc.Save();
```

Vision models read well but place boxes coarsely; for exact highlights plug in a dedicated OCR engine through the same interface:

```ts
import type { OcrEngine } from '@asposefoss/pdf';

const tesseract: OcrEngine = {
  async recognize(image) {
    const words = await myTesseract(image.bytes); // your OCR call
    return words.map((w) => ({ text: w.text, box: [w.x0, w.y0, w.x1, w.y1] }));
  },
};
```

Pages that already have text are skipped and reported unless `force: true` (which adds a layer and removes none). A page the engine fails on is reported and the run continues. The layer uses a built-in glyphless font, so every script extracts with no font files, and PDF/A and PDF/UA validation are unaffected; in a tagged document the layer is marked as an artifact. A document with signature fields is refused, since a new layer on every page would invalidate them.
````

- [ ] **Step 2: CHANGELOG** — first entry under `## [Unreleased]` → `### Added`:

```markdown
- **Scanned pages become searchable.** `doc.MakeSearchable(engine, { pages?, force?, dpi?, signal?, onPage? })` renders each image-only page, hands it to an `OcrEngine` you supply, and writes the recognized text as an invisible (render mode 3) layer placed exactly over the words in the picture, so `GetText`, `Search` and copy-paste find them and the page renders byte-for-byte as before. `aiOcrEngine(model)` is an engine over any `AiModel` — one request per page asking for lines and boxes on a 0–1000 grid; a dedicated OCR engine (Tesseract, a cloud OCR API) plugs into the same `recognize(image)` interface, and is the better choice when highlight precision matters, since vision models box coarsely. Each span's box is mapped back through the renderer's own page-to-pixel matrix, so rotated pages and offset crop boxes need no special case. The text uses a built-in glyphless font — an embedded TrueType with one empty glyph, a code per distinct character and a `/ToUnicode` map — so every script, Cyrillic, CJK and Arabic included, extracts with no font files, and PDF/A-2b and PDF/UA validation report nothing new; a tagged document gets the layer as an artifact. Pages that already have text are skipped and reported unless `force`; a page the engine fails on is reported and the run continues; an abort stops it, keeping finished pages. Signed documents are refused. Right-to-left text is written in logical order: this library extracts it correctly, other viewers may reorder it. (3ywf.3)
```

- [ ] **Step 3: CLAUDE.md** — in the Source list, directly after the `**aimodel.ts**, **aiopenai.ts**` entry, add:

```markdown
- **ocr.ts**, **glyphless.ts**, **ocrlayer.ts**, **makesearchable.ts**,
  **aiocr.ts** — `doc.MakeSearchable` (`3ywf.3`): an invisible text layer over
  image-only pages. `ocr.ts` is the seam (`OcrEngine`, a types-only leaf);
  `glyphless.ts` the font; `ocrlayer.ts` the pure span → content-bytes step;
  `makesearchable.ts` the only one holding a `Document`; `aiocr.ts` the
  `AiModel` adapter.
  **Invariant:** the page→pixel matrix is `ocrDeviceMatrix`, which is
  `renderCanvas`'s composition (`baseMatrix` × scale) — one owner, so the
  rendered image and the layer cannot disagree about where a pixel is. The
  stretch lives in `Tm` (font size 1, uniform 0.5 em advance), so `/Rotate`
  needs no special case.
  **Invariant:** the glyphless font maps every code ≥ 1 to GID 1, NEVER 0 —
  `NotdefUsed` does not exempt render mode 3 — and its `/BaseFont` carries no
  subset tag, so PDF/A's `/CIDSet` rule does not apply.
  **Invariant:** `GlyphlessCodes.encode` is ATOMIC: a string that would pass
  65,535 distinct characters assigns nothing, so one oversized page fails
  alone instead of poisoning every page after it.
  **Invariant:** the font is allocated lazily and finished in a `finally`, so a
  run writing nothing changes nothing and an aborted run still leaves a
  complete `/ToUnicode` for the pages it wrote.
  **Note on the oracle:** `test/make-searchable-geometry.test.ts` checks glyph
  positions from the EXTRACTOR against a page-from-pixel table derived by hand
  per `/Rotate`, never from `baseMatrix` — the inverse is checked against
  something it does not compute.
  **Note, a stated limit:** extraction here orders glyphs by x and does no
  bidi, so right-to-left text written in logical order extracts correctly
  here; other viewers may reorder it.
```

Run the module sweep and confirm it prints nothing:
```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 4: Mutation checks** — apply each with a script that confirms the file actually changed, run the named test file, confirm RED on the named case, restore. Kill orphaned vitest workers if a run hangs.

| File | Mutation | Must redden |
|---|---|---|
| `src/ocrlayer.ts` | `const [px, py] = apply(inv, x0, y1);` → `apply(inv, x0, y0)` | geometry: every `/Rotate` case |
| `src/makesearchable.ts` | in `ocrDeviceMatrix`, `baseMatrix(page, 'crop').matrix` → `[1, 0, 0, -1, 0, page.CropBox[3]] as Matrix` (ignores `/Rotate` and the crop origin) | geometry: `/Rotate 90/180/270`, offset CropBox |
| `src/glyphless.ts` | in `finish`, `v.setUint16(c * 2, 1)` → `v.setUint16(c * 2, 0)` | `test/glyphless.test.ts` — "maps every code to GID 1" |
| `src/glyphless.ts` | `buildToUnicode(codes.entries())` → `buildToUnicode([])` | glyphless ToUnicode case; make-searchable "GetText and Search find it" |
| `src/ocrlayer.ts` | `3 Tr` → `0 Tr` | geometry: every case (the `renderMode === 3` assertion) — NOT the byte-identical render, which an empty glyph keeps green under either mode |
| `src/makesearchable.ts` | `if (!opts.force && page.GetText().trim() !== '')` → `if (false)` | make-searchable: "skips a page that already has text" |
| `src/glyphless.ts` | in `encode`, the overflow check `> MAX_CODES` → `> Infinity` | glyphless "refuses past 65,535"; make-searchable Review Focus 4 case |

A mutation that leaves its case GREEN means the mutation did not apply or the test does not pin the rule — stop, find out which, and fix the test.

- [ ] **Step 5: Full gates**

Run: `npm run typecheck` — no errors. Run: `npm test` — all green.

- [ ] **Step 6: Commit** (closing and pushing follow the final review)

```bash
git add README.md CLAUDE.md CHANGELOG.md
git commit -m "docs(3ywf.3): MakeSearchable — README, CLAUDE.md, CHANGELOG"
```
