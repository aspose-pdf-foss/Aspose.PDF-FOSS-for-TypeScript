# Type 1 embedding and indexing (`l1my.5`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `AddFont`/`AddFontFile` embed a Type 1 (`.pfb`/`.pfa`) program, and let `LoadFontByName` find one in a registered folder.

**Architecture:** `type1charstring.ts` already interprets a Type 1 charstring into a `Path` of `M`/`L`/`C`/`Z` cubics in glyph units — exactly the Type 2 charstring vocabulary — so the conversion needs no charstring transcoder, only a re-emit as deltas. A new pure `type1cff.ts` runs the existing interpreter, emits Type 2 charstrings, assembles a CID-keyed CFF via `cffsubset.ts`'s `assembleCidCff`, and wraps it as an `OTTO` sfnt via `sfntwrite.ts`'s `otfFromCff`. `parseSfnt` dispatches to it on Type 1 magic, so every downstream consumer — subsetting, `/FontFile3`, Identity-H, `/ToUnicode`, `fontmatch.ts` — is untouched. A second new pure leaf, `type1header.ts`, reads the cleartext header for both the converter and the folder index.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-type1-embedding-design.md` — read it before Task 1. The plan argues from the spec.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Neither new module imports any.
- **ESM + NodeNext:** every import specifier carries `.js` (`import { Type1Font } from './type1.js';`).
- **Strict TypeScript.** `npm run typecheck` green before any commit.
- **No import cycles.** Verified before writing: `sfntwrite.ts` imports only `errors.js`; `cffsubset.ts` imports `cff.js` + `errors.js`; `cff.ts` imports `cffstrings.js` + `errors.js` + a type-only `pagerender.js`; `encoding.ts` imports nothing. So `sfnt.ts → type1cff.ts → {type1.js, type1header.js, sfntwrite.js, cffsubset.js, encoding.js}` closes no cycle. **Do not import `glyphoutline.ts` or `raster.ts` from either new module** — those reach `sfnt.ts` and would close one.
- **Nothing in the folder scan throws.** A `.pfb` that will not parse yields no face and is skipped. `AddFont` on a malformed Type 1 may throw `PdfParseError`, as it does for a malformed sfnt.
- **Hints are dropped**, by decision, not oversight. Do not add a hint path; do not file a follow-up for one.
- **Commit style:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` as the last line. Cite `l1my.5` in the subject scope.

### The exact header grammar, read off the real fixture

`test/fixtures/fonts/NimbusSans-Regular.t1` contains, verbatim:

```
/FullName (Nimbus Sans) readonly def
/FamilyName (Nimbus Sans) readonly def
/Weight (Regular) readonly def
/ItalicAngle 0.0 def
/FontName /NimbusSans-Regular def
/FontBBox {-210 -299 1032 1075} readonly def
```

Three different value syntaxes, and getting them wrong is silent: `/FontName` is a **PostScript name** (slash-prefixed, ends at whitespace), `/FamilyName` and `/Weight` are **parenthesised strings**, `/FontBBox` is four numbers in **braces** — and `test/helpers/build-type1.ts` also writes braces, while some real fonts use brackets, so accept both.

---

### Task 1: `type1header.ts` — the cleartext header

**Files:**
- Create: `src/type1header.ts`
- Modify: `test/helpers/build-type1.ts` (add header fields to `Type1Spec`)
- Test: `test/type1-header.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface Type1Header { fontName?: string; familyName?: string; weight?: string; italicAngle: number; bbox?: [number, number, number, number]; unitsPerEm: number }`
  - `export function isType1(bytes: Uint8Array): boolean`
  - `export function readType1Header(bytes: Uint8Array): Type1Header`
  - `buildType1` gains optional `fontName`, `familyName`, `weight`, `italicAngle`, `fontBBox`.

- [ ] **Step 1: Extend the fixture builder**

In `test/helpers/build-type1.ts`, add to `Type1Spec`:

```ts
  /** /FontName. Default 'TestFont'. */
  fontName?: string;
  /** /FamilyName. Omit => the header states none. */
  familyName?: string;
  /** /Weight. Omit => the header states none. */
  weight?: string;
  /** /ItalicAngle. Omit => the header states none. */
  italicAngle?: number;
  /** /FontBBox, in braces as real fonts write it. Default [0, 0, 1000, 1000]. */
  fontBBox?: [number, number, number, number];
```

and replace the `clear` block's fixed lines with:

```ts
  const bbox = spec.fontBBox ?? [0, 0, 1000, 1000];
  const info: string[] = [];
  if (spec.familyName !== undefined) info.push(`/FamilyName (${spec.familyName}) readonly def`);
  if (spec.weight !== undefined) info.push(`/Weight (${spec.weight}) readonly def`);
  if (spec.italicAngle !== undefined) info.push(`/ItalicAngle ${spec.italicAngle} def`);

  const clear = bytes([
    '%!PS-AdobeFont-1.0: TestFont 001.000',
    ...info,
    `/FontName /${spec.fontName ?? 'TestFont'} def`,
    `/FontMatrix [${fm.join(' ')}] readonly def`,
    '/FontType 1 def',
    `/FontBBox {${bbox.join(' ')}} readonly def`,
    ...encLines,
    'currentdict end',
    'currentfile eexec',
    '',
  ].join('\n'));
```

- [ ] **Step 2: Write the failing test**

Create `test/type1-header.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isType1, readType1Header } from '../src/type1header.js';
import { buildType1 } from './helpers/build-type1.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';

/** One charstring is enough — this module never looks past `eexec`. */
const CS = { '.notdef': Uint8Array.from([139, 139, 13, 14]) };

describe('isType1', () => {
  it('accepts a PFA and a PFB, and rejects an sfnt', () => {
    expect(isType1(buildType1({ charstrings: CS }))).toBe(true);
    expect(isType1(buildType1({ charstrings: CS, pfb: true }))).toBe(true);
    expect(isType1(buildMinimalTtf())).toBe(false);
  });

  it('rejects bytes too short to judge', () => {
    expect(isType1(new Uint8Array(0))).toBe(false);
    expect(isType1(Uint8Array.from([0x25]))).toBe(false);
  });
});

describe('readType1Header', () => {
  it('reads the three value syntaxes off the real fixture', () => {
    // /FontName is a NAME, /FamilyName and /Weight are parenthesised STRINGS,
    // /FontBBox is four numbers in BRACES. Confusing them is silent.
    const bytes = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));
    const h = readType1Header(bytes);
    expect(h.fontName).toBe('NimbusSans-Regular');
    expect(h.familyName).toBe('Nimbus Sans');
    expect(h.weight).toBe('Regular');
    expect(h.italicAngle).toBe(0);
    expect(h.bbox).toEqual([-210, -299, 1032, 1075]);
    expect(h.unitsPerEm).toBe(1000);
  });

  it('reads a PFB without needing the segment headers stripped by the caller', () => {
    const h = readType1Header(buildType1({ charstrings: CS, pfb: true, fontName: 'PfbFont' }));
    expect(h.fontName).toBe('PfbFont');
  });

  it('accepts a bracketed /FontBBox as well as a braced one', () => {
    const braced = readType1Header(buildType1({ charstrings: CS, fontBBox: [1, 2, 3, 4] }));
    expect(braced.bbox).toEqual([1, 2, 3, 4]);
    // Some real fonts write brackets; the builder only writes braces, so this
    // half is exercised by patching the bytes directly.
    const raw = buildType1({ charstrings: CS, fontBBox: [1, 2, 3, 4] });
    const text = Buffer.from(raw).toString('latin1').replace('{1 2 3 4}', '[1 2 3 4]');
    expect(readType1Header(new Uint8Array(Buffer.from(text, 'latin1'))).bbox).toEqual([1, 2, 3, 4]);
  });

  it('leaves absent fields undefined rather than inventing them', () => {
    const h = readType1Header(buildType1({ charstrings: CS }));
    expect(h.familyName).toBeUndefined();
    expect(h.weight).toBeUndefined();
    expect(h.italicAngle).toBe(0);       // 0 is the documented default, not a miss
  });

  it('reads a non-1000 unitsPerEm from /FontMatrix', () => {
    const h = readType1Header(buildType1({
      charstrings: CS, fontMatrix: [1 / 2048, 0, 0, 1 / 2048, 0, 0],
    }));
    expect(h.unitsPerEm).toBe(2048);
  });

  it('does not throw on bytes that open like PostScript but are not a font', () => {
    const junk = new Uint8Array(Buffer.from('%!PS-Adobe-3.0\nnothing here\n', 'latin1'));
    expect(() => readType1Header(junk)).not.toThrow();
    expect(readType1Header(junk).fontName).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/type1-header.test.ts`
Expected: FAIL — `Failed to load url ../src/type1header.js`.

- [ ] **Step 4: Write the implementation**

Create `src/type1header.ts`:

```ts
/**
 * A Type 1 program's cleartext header, read as cheaply as possible.
 *
 * A pure leaf with no imports. Three unrelated callers want it and only one of
 * them wants the charstring interpreter: `fontsource.ts` indexes thousands of
 * files and must not pull in an engine to read a family name, `type1cff.ts`
 * wants `/FontName` and `/FontBBox`, and `type1.ts` wants `/FontMatrix`.
 *
 * Everything here lives BEFORE the `eexec` keyword, so a few hundred bytes of
 * prefix suffice — which is what keeps the folder index's partial-read cost
 * model intact when a `.pfb` is indexed.
 */

/** The header fields anything outside this module needs. */
export interface Type1Header {
  /** /FontName — becomes the sfnt PostScript name, and hence /BaseFont. */
  fontName?: string;
  /** /FamilyName. */
  familyName?: string;
  /** /Weight — 'Bold', 'Light', ... the words fontmatch.ts already parses. */
  weight?: string;
  /** /ItalicAngle; 0 when the header states none. */
  italicAngle: number;
  /** /FontBBox, or undefined when the header states none. */
  bbox?: [number, number, number, number];
  /** Units per em from /FontMatrix; 1000 when it states none. */
  unitsPerEm: number;
}

/** PFB segment marker, then a binary-segment type byte. */
const isPfb = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x80 && b[1] === 0x01;
/** '%!' — a PostScript program, which is how a PFA and a /FontFile body open. */
const isPs = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x25 && b[1] === 0x21;

/**
 * Whether `bytes` opens as a Type 1 program. A prefix is enough.
 *
 * Deliberately loose: a PostScript file that is not a font passes here and is
 * rejected later, by `readType1Header` reporting no `/FontName` or by
 * `Type1Font` finding no `/CharStrings`. A tighter test would have to parse,
 * which is the thing this exists to avoid.
 */
export function isType1(bytes: Uint8Array): boolean {
  return isPfb(bytes) || isPs(bytes);
}

/** Concatenate a PFB's segments, or return `bytes` unchanged. Mirrors
 *  `stripPfb` in type1.ts, kept local so this module imports nothing. */
function stripPfb(bytes: Uint8Array): Uint8Array {
  if (!isPfb(bytes)) return bytes;
  const parts: Uint8Array[] = [];
  let p = 0;
  while (p + 6 <= bytes.length && bytes[p] === 0x80) {
    if (bytes[p + 1] === 3) break;                 // EOF segment
    const len = bytes[p + 2] | (bytes[p + 3] << 8) | (bytes[p + 4] << 16) | (bytes[p + 5] << 24);
    if (len < 0 || p + 6 + len > bytes.length) break;
    parts.push(bytes.subarray(p + 6, p + 6 + len));
    p += 6 + len;
  }
  if (parts.length === 0) return bytes;
  const out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

const asciiOf = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};

function indexOfAscii(b: Uint8Array, s: string): number {
  outer: for (let i = 0; i + s.length <= b.length; i++) {
    for (let j = 0; j < s.length; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** The text following `key`, capped — every value here is short. */
function after(b: Uint8Array, key: string): string | undefined {
  const at = indexOfAscii(b, key);
  if (at < 0) return undefined;
  return asciiOf(b, at + key.length, at + key.length + 256);
}

/** `/Key (value) readonly def` — a parenthesised PostScript string. */
function psString(b: Uint8Array, key: string): string | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const open = tail.indexOf('(');
  if (open < 0) return undefined;
  const close = tail.indexOf(')', open + 1);
  return close < 0 ? undefined : tail.slice(open + 1, close);
}

/** `/FontName /Value def` — a PostScript NAME, not a string. */
function psName(b: Uint8Array, key: string): string | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const slash = tail.indexOf('/');
  if (slash < 0) return undefined;
  const m = /^[^\s/(){}[\]<>%]+/.exec(tail.slice(slash + 1));
  return m ? m[0] : undefined;
}

/** `/Key 0.0 def` — a bare number. */
function psNumber(b: Uint8Array, key: string): number | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const m = /^\s*([-+]?[0-9]*\.?[0-9]+)/.exec(tail);
  return m ? Number(m[1]) : undefined;
}

/** Four numbers in `{...}` or `[...]`. Real fonts use both. */
function psNumbers(b: Uint8Array, key: string): number[] | undefined {
  const tail = after(b, key);
  if (tail === undefined) return undefined;
  const m = /[{[]([^}\]]*)[}\]]/.exec(tail);
  if (!m) return undefined;
  const out = m[1].trim().split(/\s+/).map(Number);
  return out.every((n) => Number.isFinite(n)) ? out : undefined;
}

/**
 * Read the cleartext header.
 *
 * Never throws: a PostScript file that is not a font yields a header stating
 * nothing, which every caller already treats as unusable. One unreadable file
 * in a system font directory must not break every lookup on the machine.
 */
export function readType1Header(bytes: Uint8Array): Type1Header {
  const b = stripPfb(bytes);
  const at = indexOfAscii(b, 'eexec');
  const clear = at < 0 ? b : b.subarray(0, at);

  const fm = psNumbers(clear, '/FontMatrix');
  const first = fm && fm.length > 0 ? fm[0] : undefined;
  const unitsPerEm = first !== undefined && Number.isFinite(first) && first !== 0
    ? Math.round(1 / first)
    : 1000;

  const box = psNumbers(clear, '/FontBBox');
  return {
    fontName: psName(clear, '/FontName'),
    familyName: psString(clear, '/FamilyName'),
    weight: psString(clear, '/Weight'),
    italicAngle: psNumber(clear, '/ItalicAngle') ?? 0,
    bbox: box && box.length === 4 ? [box[0], box[1], box[2], box[3]] : undefined,
    unitsPerEm,
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/type1-header.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Point `type1.ts` at the shared reader**

One owner for `/FontMatrix`. In `src/type1.ts`, add `import { readType1Header } from './type1header.js';`, replace the constructor line

```ts
    this.unitsPerEm = readFontMatrixUpm(clear);
```

with

```ts
    // One owner for the cleartext header — see type1header.ts.
    this.unitsPerEm = readType1Header(bytes).unitsPerEm;
```

and delete the now-unused `readFontMatrixUpm` function.

Run: `npx vitest run test/type1.test.ts test/type1-header.test.ts`
Expected: PASS. If `test/type1.test.ts` does not exist, run `npx vitest run test/` for the Type 1 cases — the delegation must not move any existing behaviour.

- [ ] **Step 7: Mutation-check the two value syntaxes that look alike**

1. In `readType1Header`, change `familyName: psString(clear, '/FamilyName')` to `psName(clear, '/FamilyName')`. Run `npx vitest run test/type1-header.test.ts`. Expected: RED on "reads the three value syntaxes off the real fixture". **Restore it.**
2. Change `fontName: psName(clear, '/FontName')` to `psString(clear, '/FontName')`. Run again. Expected: RED on the same case. **Restore it.**

Record both in the commit body.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/type1header.ts src/type1.ts test/type1-header.test.ts test/helpers/build-type1.ts
git commit -F - <<'EOF'
feat(l1my.5): read a Type 1 program's cleartext header

A pure leaf with no imports, because three callers want it and only one
wants the charstring interpreter: fontsource.ts must not pull an engine
in to read a family name. Everything it reads lives before eexec, so a
prefix suffices and the folder index's partial-read cost model survives.

Three value syntaxes, transcribed off the real fixture rather than
guessed: /FontName is a NAME, /FamilyName and /Weight are parenthesised
STRINGS, /FontBBox is four numbers in braces (brackets accepted too,
since real fonts write both). Measured load-bearing: reading /FamilyName
as a name, or /FontName as a string, each redden the fixture case.

type1.ts now takes /FontMatrix from here rather than scanning for it
itself, so the two cannot disagree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: `type1cff.ts` — outlines to Type 2 charstrings

The conversion proper, up to a bare CFF. Wrapping as an sfnt is Task 3, so this task's deliverable is independently checkable against `cff.ts`.

**Files:**
- Create: `src/type1cff.ts`
- Test: `test/type1-cff.test.ts`

**Interfaces:**
- Consumes: `readType1Header`, `Type1Header` from Task 1. `Type1Font` from `src/type1.js` (`new Type1Font(bytes)`, `.numGlyphs`, `.unitsPerEm`, `.glyphName(gid): string | undefined`, `.glyphPath(gid): Path`, `.glyphWidth(gid): number`). `Path`/`Seg` from `src/pagerender.js` (type-only): `{ op: 'M' | 'L', x, y }`, `{ op: 'C', x1, y1, x2, y2, x, y }`, `{ op: 'Z' }`. `assembleCidCff(nameIndex: Uint8Array[], charStrings: Uint8Array[], cidOfSubsetGid: number[]): Uint8Array` from `src/cffsubset.js`.
- Produces:
  - `export interface Type1Conversion { cff: Uint8Array; order: number[]; advances: number[]; unicode: Map<number, number>; bbox: [number, number, number, number]; header: Type1Header }` — `order[newGid] = oldGid`; `unicode` maps code point → new gid.
  - `export function type1ToCff(bytes: Uint8Array): Type1Conversion`
  - `export function encodeType2(path: Path, width: number): Uint8Array` (exported for the test to reach directly)

- [ ] **Step 1: Write the failing test**

Create `test/type1-cff.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { type1ToCff } from '../src/type1cff.js';
import { Type1Font } from '../src/type1.js';
import { CffFont } from '../src/cff.js';
import { buildType1, t1num } from './helpers/build-type1.js';
import type { Path } from '../src/pagerender.js';

/** Round a path's coordinates the way the emitter does, so the comparison is
 *  against what integer Type 2 operands can represent rather than against
 *  floating-point noise. */
function rounded(p: Path): Path {
  return p.map((s) => s.op === 'C'
    ? { op: 'C' as const, x1: Math.round(s.x1), y1: Math.round(s.y1),
        x2: Math.round(s.x2), y2: Math.round(s.y2), x: Math.round(s.x), y: Math.round(s.y) }
    : s.op === 'Z' ? s : { op: s.op, x: Math.round(s.x), y: Math.round(s.y) });
}

/** Type 2 closes subpaths implicitly, so a 'Z' has no counterpart to compare. */
const noZ = (p: Path): Path => p.filter((s) => s.op !== 'Z');

const REAL = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));

describe('type1ToCff — against the real fixture', () => {
  it('agrees with the Type 1 interpreter on every glyph outline', () => {
    // The load-bearing assertion. cff.ts and type1charstring.ts are two
    // separately written interpreters, so their agreement is evidence from
    // outside the code under test -- not the self-differential this repo warns
    // about. Same anchoring habit as checking CFF widths against hmtx.
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    const cff = new CffFont(conv.cff);

    expect(conv.order.length).toBe(t1.numGlyphs);
    expect(cff.numGlyphs).toBe(t1.numGlyphs);

    for (let newGid = 0; newGid < conv.order.length; newGid++) {
      const oldGid = conv.order[newGid];
      expect(noZ(cff.glyphPath(newGid))).toEqual(noZ(rounded(t1.glyphPath(oldGid))));
    }
  });

  it('puts .notdef at gid 0 even though the font lists it LAST', () => {
    // NimbusSans-Regular.t1 lists /.notdef last -- off by 854 -- so assuming
    // gid 0 is .notdef is wrong on the one real font available.
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    expect(t1.glyphName(conv.order[0])).toBe('.notdef');
    expect(t1.glyphName(0)).not.toBe('.notdef');   // the premise of the test
  });

  it('carries each glyph advance across unchanged', () => {
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    for (let newGid = 0; newGid < conv.order.length; newGid++) {
      expect(conv.advances[newGid]).toBe(Math.round(t1.glyphWidth(conv.order[newGid])));
    }
  });

  it('maps code points to the renumbered gids, not the original ones', () => {
    const t1 = new Type1Font(REAL);
    const conv = type1ToCff(REAL);
    const gid = conv.unicode.get(0x41);           // 'A'
    expect(gid).toBeDefined();
    expect(t1.glyphName(conv.order[gid!])).toBe('A');
  });

  it('reports the header bbox and unitsPerEm', () => {
    const conv = type1ToCff(REAL);
    expect(conv.bbox).toEqual([-210, -299, 1032, 1075]);
    expect(conv.header.unitsPerEm).toBe(1000);
  });
});

describe('type1ToCff — synthetics', () => {
  /** `sbx wx hsbw` then the body. hsbw MOVES THE PEN to (sbx, 0). */
  const hsbw = (sbx: number, wx: number): number[] => [...t1num(sbx), ...t1num(wx), 13];

  /** The new gid holding `name`, resolved through the renumbering. */
  function gidOf(font: Uint8Array, conv: { order: number[] }, name: string): number {
    const t1 = new Type1Font(font);
    return conv.order.findIndex((old) => t1.glyphName(old) === name);
  }

  it('emits a width even for a glyph that draws nothing', () => {
    // With Private [0 0], nominalWidthX and defaultWidthX are both 0, so an
    // OMITTED width means an advance of zero. A blank glyph is where that
    // shows: a space would stop advancing and every line would pile up.
    const font = buildType1({
      charstrings: {
        '.notdef': Uint8Array.from([...hsbw(0, 0), 14]),
        'space': Uint8Array.from([...hsbw(0, 600), 14]),
      },
    });
    const conv = type1ToCff(font);
    const cff = new CffFont(conv.cff);
    const gid = gidOf(font, conv, 'space');
    expect(conv.advances[gid]).toBe(600);
    expect(cff.glyphPath(gid)).toEqual([]);       // draws nothing, still advances
  });

  it('survives a non-1000 unitsPerEm without rescaling the advance', () => {
    // The advance and the outline are in the same space, so the converter must
    // not normalise either -- otfFromCff is told the unitsPerEm instead. The
    // glyph is deliberately blank: this case is about the ADVANCE, and a body
    // would only add a charstring-grammar detail it does not need. (Type 1
    // opcode 4 is vmoveto, not vlineto -- 7 is vlineto -- and a body with no
    // leading moveto would yield a path starting with a line segment.)
    const font = buildType1({
      charstrings: {
        '.notdef': Uint8Array.from([...hsbw(0, 0), 14]),
        'A': Uint8Array.from([...hsbw(0, 1024), 14]),
      },
      fontMatrix: [1 / 2048, 0, 0, 1 / 2048, 0, 0],
    });
    const conv = type1ToCff(font);
    expect(conv.header.unitsPerEm).toBe(2048);
    expect(conv.advances[gidOf(font, conv, 'A')]).toBe(1024);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/type1-cff.test.ts`
Expected: FAIL — `Failed to load url ../src/type1cff.js`.

- [ ] **Step 3: Write the implementation**

Create `src/type1cff.ts`:

```ts
/**
 * Type 1 to CFF, the conversion behind embedding a `.pfb`.
 *
 * Pure: bytes in, bytes out, no PDF objects and no filesystem. It needs no
 * charstring transcoder, which is the whole reason this is small —
 * `type1charstring.ts` already interprets a Type 1 charstring into a `Path` of
 * M/L/C/Z cubics in glyph units, and that is exactly the Type 2 vocabulary
 * (`rmoveto`, `rlineto`, `rrcurveto`, close implicit). So the outlines are
 * re-emitted as deltas rather than translated operator by operator.
 *
 * HINTS ARE LOST, by decision. Outlines carry none, and preserving them would
 * mean a second charstring grammar whose divergences type1.ts already records
 * (unbiased subrs, closepath, 255 meaning a 32-bit integer rather than 16.16).
 * The cost is a little stem regularity at small sizes in third-party viewers,
 * and it is invisible to this suite: raster.ts is a scanline filler over
 * flattened outlines and ignores hints entirely.
 */
import type { Path } from './pagerender.js';
import { Type1Font } from './type1.js';
import { readType1Header, type Type1Header } from './type1header.js';
import { assembleCidCff } from './cffsubset.js';
import { glyphToUnicode } from './encoding.js';

/** What a converted program yields, before it is wrapped as an sfnt. */
export interface Type1Conversion {
  /** A CID-keyed CFF with an identity charset. */
  cff: Uint8Array;
  /** `order[newGid] = oldGid` — the renumbering that puts .notdef first. */
  order: number[];
  /** Advance per NEW gid, in glyph units. */
  advances: number[];
  /** Code point -> new gid. */
  unicode: Map<number, number>;
  bbox: [number, number, number, number];
  header: Type1Header;
}

// ---------- Type 2 charstring emission ----------

/** A Type 2 integer operand. Values outside the short forms take the 28
 *  escape and a 16-bit signed big-endian; 255 (16.16 fixed) is never needed,
 *  because every coordinate is rounded to an integer first. */
function operand(v: number, out: number[]): void {
  if (v >= -107 && v <= 107) { out.push(v + 139); return; }
  if (v >= 108 && v <= 1131) {
    const d = v - 108;
    out.push(247 + (d >> 8), d & 0xff);
    return;
  }
  if (v >= -1131 && v <= -108) {
    const d = -v - 108;
    out.push(251 + (d >> 8), d & 0xff);
    return;
  }
  const c = Math.max(-32768, Math.min(32767, v));
  out.push(28, (c >> 8) & 0xff, c & 0xff);
}

const RMOVETO = 21, RLINETO = 5, RRCURVETO = 8, ENDCHAR = 14;

/**
 * One Type 2 charstring for `path`, advancing by `width`.
 *
 * The width rides as an extra leading operand on the first stack-clearing
 * operator, which is Type 2's own convention. It is emitted ALWAYS: with
 * `Private [0 0]` both `nominalWidthX` and `defaultWidthX` are 0, so a width
 * operand is the width itself and an omitted one means an advance of zero.
 *
 * Coordinates are rounded ABSOLUTELY and then differenced, so rounding error
 * cannot accumulate along a contour.
 */
export function encodeType2(path: Path, width: number): Uint8Array {
  const out: number[] = [];
  let x = 0, y = 0, first = true;

  const move = (nx: number, ny: number): void => {
    const dx = nx - x, dy = ny - y;
    if (first) operand(Math.round(width), out);
    operand(dx, out); operand(dy, out); out.push(RMOVETO);
    x = nx; y = ny; first = false;
  };

  for (const s of path) {
    if (s.op === 'M') { move(Math.round(s.x), Math.round(s.y)); continue; }
    if (s.op === 'L') {
      const nx = Math.round(s.x), ny = Math.round(s.y);
      operand(nx - x, out); operand(ny - y, out); out.push(RLINETO);
      x = nx; y = ny;
      continue;
    }
    if (s.op === 'C') {
      const x1 = Math.round(s.x1), y1 = Math.round(s.y1);
      const x2 = Math.round(s.x2), y2 = Math.round(s.y2);
      const nx = Math.round(s.x), ny = Math.round(s.y);
      operand(x1 - x, out); operand(y1 - y, out);
      operand(x2 - x1, out); operand(y2 - y1, out);
      operand(nx - x2, out); operand(ny - y2, out);
      out.push(RRCURVETO);
      x = nx; y = ny;
      continue;
    }
    // 'Z': Type 2 closes each subpath implicitly; there is nothing to emit.
  }

  if (first) operand(Math.round(width), out);   // a glyph that draws nothing
  out.push(ENDCHAR);
  return Uint8Array.from(out);
}

// ---------- Conversion ----------

/**
 * Convert a Type 1 program to a CID-keyed CFF.
 *
 * GLYPH IDS ARE RENUMBERED so that `.notdef` is gid 0, which CFF requires.
 * `Type1Font` numbers by order of appearance in `/CharStrings` and carries none
 * of the CFF conventions — the bundled `NimbusSans-Regular.t1` lists `/.notdef`
 * LAST, so taking the font's own order puts the wrong glyph at 0 and shifts
 * every other by one.
 */
export function type1ToCff(bytes: Uint8Array): Type1Conversion {
  const t1 = new Type1Font(bytes);
  const header = readType1Header(bytes);

  // .notdef first, then every other glyph in the font's own order.
  const notdef = t1.gidForName('.notdef');
  const order: number[] = [];
  if (notdef !== undefined) order.push(notdef);
  for (let g = 0; g < t1.numGlyphs; g++) if (g !== notdef) order.push(g);

  const charStrings: Uint8Array[] = [];
  const advances: number[] = [];
  const unicode = new Map<number, number>();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let newGid = 0; newGid < order.length; newGid++) {
    const oldGid = order[newGid];
    const path = t1.glyphPath(oldGid);
    const width = Math.round(t1.glyphWidth(oldGid));
    charStrings.push(encodeType2(path, width));
    advances.push(width);

    for (const s of path) {
      const pts = s.op === 'C'
        ? [[s.x1, s.y1], [s.x2, s.y2], [s.x, s.y]]
        : s.op === 'Z' ? [] : [[s.x, s.y]];
      for (const [px, py] of pts) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
    }

    // Code point comes from the glyph NAME, through encoding.ts's resolver --
    // not from the program's built-in /Encoding, which addresses at most 256
    // codes and says nothing about the rest of /CharStrings.
    const name = t1.glyphName(oldGid);
    const u = name === undefined ? undefined : glyphToUnicode(name);
    if (u !== undefined) {
      const cps = [...u];
      if (cps.length === 1) {
        const cp = cps[0].codePointAt(0)!;
        if (!unicode.has(cp)) unicode.set(cp, newGid);   // first name wins
      }
    }
  }

  const bbox: [number, number, number, number] = header.bbox
    ?? (Number.isFinite(minX)
      ? [Math.floor(minX), Math.floor(minY), Math.ceil(maxX), Math.ceil(maxY)]
      : [0, 0, header.unitsPerEm, header.unitsPerEm]);

  const psName = header.fontName ?? 'Type1Font';
  const cff = assembleCidCff(
    [new TextEncoder().encode(psName)],
    charStrings,
    order.map((_, newGid) => newGid),     // identity charset: CID = gid
  );

  return { cff, order, advances, unicode, bbox, header };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/type1-cff.test.ts`
Expected: PASS, 7 tests.

If the outline comparison fails on a handful of glyphs, do **not** loosen it to a tolerance before diagnosing: the likely causes are a missed `Z` filter, an accumulated-rounding bug (round absolutely, then difference — never difference then round), or a `seac` composite whose merged path the interpreter produced in a different subpath order.

- [ ] **Step 5: Mutation-check the three conversion invariants**

1. **Renumbering.** Replace the `order` construction with `const order = Array.from({ length: t1.numGlyphs }, (_, g) => g);`. Run `npx vitest run test/type1-cff.test.ts`. Expected: RED on "puts .notdef at gid 0". **Restore it.**
2. **Explicit width.** In `encodeType2`, delete the trailing `if (first) operand(Math.round(width), out);` and change the `move` helper's `if (first) operand(...)` to nothing. Run again. Expected: RED on "emits a width even for a glyph that draws nothing" and on "carries each glyph advance across unchanged". **Restore it.**
3. **Name-based cmap.** Change `if (!unicode.has(cp))` to `unicode.set(cp, oldGid)` (the pre-renumbering id). Run again. Expected: RED on "maps code points to the renumbered gids". **Restore it.**

Record all three in the commit body.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/type1cff.ts test/type1-cff.test.ts
git commit -F - <<'EOF'
feat(l1my.5): convert Type 1 outlines to Type 2 charstrings

No charstring transcoder: type1charstring.ts already yields M/L/C/Z
cubics in glyph units, which is exactly the Type 2 vocabulary, so the
paths are re-emitted as deltas. Hints are lost, by decision.

Verified against cff.ts rather than against itself -- two separately
written interpreters agreeing on every glyph of NimbusSans-Regular.t1 is
evidence from outside the code under test, the same anchoring habit as
checking CFF charstring widths against hmtx.

Three invariants, each mutation-checked: glyph ids are renumbered so
.notdef is gid 0 (the fixture lists it LAST, so the font's own order puts
the wrong glyph at 0); every charstring emits its width, since Private
[0 0] makes an omitted width mean an advance of zero and a blank glyph is
where that shows; and the cmap is built from glyph NAMES through
encoding.ts, not the built-in /Encoding, which addresses only 256 codes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Wrap as an sfnt and dispatch from `parseSfnt`

After this task `AddFont`/`AddFontFile` accept a `.pfb`, and everything downstream works untouched.

**Files:**
- Modify: `src/type1cff.ts` (append `sfntFromType1`)
- Modify: `src/sfnt.ts:366-372` (the signature dispatch in `parseSfnt`)
- Test: `test/type1-embed.test.ts`

**Interfaces:**
- Consumes: `type1ToCff`, `Type1Conversion` from Task 2; `isType1` from Task 1. From `src/sfntwrite.js`: `buildCmap(map: Map<number, number>): Uint8Array` and `otfFromCff(cff: Uint8Array, cmap: Uint8Array, m: OtfMetrics): Uint8Array` where `OtfMetrics` is `{ numGlyphs: number; unitsPerEm: number; advances: number[]; bbox: [number, number, number, number]; ascent: number; descent: number }`.
- Produces: `export function sfntFromType1(bytes: Uint8Array): Uint8Array`.

- [ ] **Step 1: Write the failing test**

Create `test/type1-embed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { parseSfnt } from '../src/sfnt.js';

const REAL_PATH = 'test/fixtures/fonts/NimbusSans-Regular.t1';
const REAL = new Uint8Array(readFileSync(REAL_PATH));

describe('parseSfnt — Type 1', () => {
  it('converts a Type 1 program into a usable font', () => {
    const f = parseSfnt(REAL);
    expect(f.numGlyphs).toBeGreaterThan(100);
    expect(f.unitsPerEm).toBe(1000);
    expect(f.postScriptName).toBe('NimbusSans-Regular');   // NOT 'Embedded'
  });

  it('resolves a code point through the synthesized cmap', () => {
    const f = parseSfnt(REAL);
    const gid = f.cmapLookup(0x41);
    expect(gid).toBeDefined();
    expect(f.advanceWidth(gid!)).toBeGreaterThan(0);
  });

  it('ignores faceIndex rather than rejecting it', () => {
    // A Type 1 holds one face and a caller may not know which kind of file
    // they were handed -- ttc.ts's existing rule for a plain sfnt.
    expect(() => parseSfnt(REAL, 3)).not.toThrow();
  });
});

describe('Document.AddFontFile — Type 1', () => {
  it('embeds a Type 1 as CIDFontType0C and keeps the text extractable', () => {
    const doc = Document.New();
    const font = doc.AddFontFile(REAL_PATH);
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText('Hamburg', 72, 700, { font, fontSize: 24 });
    const out = doc.Save();

    const text = Buffer.from(out).toString('latin1');
    expect(text).toContain('/CIDFontType0C');
    expect(text).toContain('/FontFile3');
    expect(text).toContain('/NimbusSans-Regular');

    const reopened = Document.Open(out);
    expect(reopened.Pages[0].GetText()).toContain('Hamburg');
  });

  it('accepts the same program wrapped as a PFB', () => {
    // stripPfb runs inside the conversion, so a .pfb and a .pfa of one program
    // must yield the same font. Built by wrapping the real fixture's bytes in
    // a single binary segment.
    const len = REAL.length;
    const pfb = new Uint8Array(6 + len + 2);
    pfb.set([0x80, 0x01, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff]);
    pfb.set(REAL, 6);
    pfb.set([0x80, 0x03], 6 + len);

    const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-t1-'));
    const path = join(dir, 'nimbus.pfb');
    writeFileSync(path, pfb);

    const doc = Document.New();
    const font = doc.AddFontFile(path);
    expect(font.sfnt.postScriptName).toBe('NimbusSans-Regular');
    expect(font.sfnt.numGlyphs).toBe(parseSfnt(REAL).numGlyphs);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/type1-embed.test.ts`
Expected: FAIL — `parseSfnt` throws on the Type 1 bytes (no `maxp` table), and `sfntFromType1` does not exist.

- [ ] **Step 3: Append the sfnt wrapper to `src/type1cff.ts`**

Add the import beside the existing ones:

```ts
import { buildCmap, otfFromCff } from './sfntwrite.js';
```

and append:

```ts
/**
 * A Type 1 program as a standalone `OTTO` sfnt.
 *
 * This is the whole integration point: `parseSfnt` calls it on Type 1 magic and
 * every consumer downstream — subsetting, `/FontFile3`, Identity-H emission,
 * `/ToUnicode`, `fontmatch.ts` — sees an ordinary OpenType-CFF font and needs
 * no change. Same shape as `woff.ts` reconstructing a WOFF and `ttc.ts`
 * extracting a collection face: convert before anything else sees it.
 *
 * Ascent and descent come from the bounding box. A Type 1 program has no
 * `OS/2` table and states no typographic ascender, so the box is the only
 * source available; it is an approximation and deliberately so.
 */
export function sfntFromType1(bytes: Uint8Array): Uint8Array {
  const c = type1ToCff(bytes);
  return otfFromCff(c.cff, buildCmap(c.unicode), {
    numGlyphs: c.order.length,
    unitsPerEm: c.header.unitsPerEm,
    advances: c.advances,
    bbox: c.bbox,
    ascent: c.bbox[3],
    descent: c.bbox[1],
  });
}
```

- [ ] **Step 4: Carry the PostScript name into the synthesized `name` table**

`sfntwrite.ts`'s `buildName()` hardcodes `'Embedded'`, which would make every converted font's `/BaseFont` read `/Embedded`. Three edits in `src/sfntwrite.ts`, and the default must be preserved so the other caller does not move.

**(a)** Give `buildName` a parameter — change its first two lines from

```ts
function buildName(): Uint8Array {
  // Minimal name table: family=1, subfamily=2, full=4, ps=6, Windows/Unicode.
  const str = 'Embedded';
```

to

```ts
function buildName(str = 'Embedded'): Uint8Array {
  // Minimal name table: family=1, subfamily=2, full=4, ps=6, Windows/Unicode.
```

**(b)** Add the optional field to `OtfMetrics` (`src/sfntwrite.ts:146`):

```ts
export interface OtfMetrics {
  numGlyphs: number; unitsPerEm: number; advances: number[];
  bbox: [number, number, number, number]; ascent: number; descent: number;
  /** PostScript name for the synthesized `name` table. Default 'Embedded',
   *  which is right for htmlfontembed.ts, where the name is never read. */
  psName?: string;
}
```

**(c)** In `otfFromCff`'s table list, pass it through — its signature does not change:

```ts
    { tag: 'name', data: buildName(m.psName) },
```

Then in `sfntFromType1` (Step 3), add the field to the object passed to `otfFromCff`:

```ts
    psName: c.header.fontName ?? 'Type1Font',
```

- [ ] **Step 5: Dispatch from `parseSfnt`**

In `src/sfnt.ts`, add the import:

```ts
import { isType1 } from './type1header.js';
import { sfntFromType1 } from './type1cff.js';
```

and extend the existing signature dispatch at `src/sfnt.ts:366-372`:

```ts
  if (sig === 0x774f4646 /* wOFF */ || sig === 0x774f4632 /* wOF2 */) bytes = sfntFromWoff(bytes);
  // A collection is rebuilt into a standalone sfnt before anything else sees
  // it — see ttc.ts for why reading one in place would be a trap.
  else if (sig === 0x74746366 /* ttcf */) bytes = extractTtcFace(bytes, faceIndex);
  // A Type 1 is converted to OpenType-CFF for the same reason: everything
  // downstream then sees an ordinary sfnt. faceIndex is ignored — a Type 1
  // holds exactly one face.
  else if (isType1(bytes)) bytes = sfntFromType1(bytes);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/type1-embed.test.ts test/type1-cff.test.ts`
Expected: PASS.

Then run the module that Step 4 touched, since `otfFromCff` has another caller:

Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS unchanged — `psName` defaults to `'Embedded'`, so `htmlfontembed.ts`'s output must be byte-identical. **If this reddens, the default was not preserved.**

- [ ] **Step 7: Mutation-check the dispatch and the name**

1. In `parseSfnt`, delete the `else if (isType1(bytes))` branch. Run `npx vitest run test/type1-embed.test.ts`. Expected: RED on every case in the file. **Restore it.**
2. In `sfntFromType1`, delete the `psName` line so it falls back to `'Embedded'`. Run again. Expected: RED on "converts a Type 1 program into a usable font" (the `postScriptName` assertion) and on the `/NimbusSans-Regular` assertion in the embed case — **and green on everything else**, which is what shows the hardcoded name would have shipped silently. **Restore it.**

- [ ] **Step 8: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/type1cff.ts src/sfnt.ts src/sfntwrite.ts test/type1-embed.test.ts
git commit -F - <<'EOF'
feat(l1my.5): AddFont accepts a Type 1 program

parseSfnt converts on Type 1 magic, so the whole authoring stack --
subsetting, /FontFile3, Identity-H, /ToUnicode, fontmatch.ts -- sees an
ordinary OpenType-CFF font and needed no change at all. Same placement as
woff.ts reconstructing a WOFF and ttc.ts extracting a collection face:
convert before anything else sees it. faceIndex is ignored, a Type 1
holding exactly one face.

otfFromCff's synthesized name table gained an optional psName, because it
hardcoded 'Embedded' and every converted font's /BaseFont would have read
that. The default is unchanged, so htmlfontembed.ts's output stays
byte-identical -- test/html-identity.test.ts is the fence for that.

Measured: dropping psName reddens only the two name assertions and leaves
everything else green, which is exactly how the hardcoded name would have
shipped unnoticed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Index a `.pfb` by family name

**Files:**
- Modify: `src/fontsource.ts` (`FONT_EXT`, and a Type 1 branch in `peekNames`)
- Test: `test/font-byname.test.ts` (append)

**Interfaces:**
- Consumes: `isType1`, `readType1Header` from Task 1. `FontNames` from `src/fontnames.js`: `{ family, subfamily, typographicFamily?, typographicSubfamily?, postScriptName?, bold, italic, weight }`.
- Produces: no new exports — `indexFolder` simply returns faces for `.pfb`/`.pfa` files too.

- [ ] **Step 1: Write the failing test**

Append to `test/font-byname.test.ts`:

```ts
describe('Document.LoadFontByName — Type 1', () => {
  const REAL_T1 = new Uint8Array(readFileSync('test/fixtures/fonts/NimbusSans-Regular.t1'));

  it('finds a .pfb by family name and embeds it', () => {
    const dir = folderWith({ 'nimbus.pfb': REAL_T1 });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Nimbus Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.postScriptName).toBe('NimbusSans-Regular');
  });

  it('reads the style out of /Weight and /ItalicAngle', () => {
    // The mapping that lets l1my.3's rules apply with no new style logic:
    // /Weight lands in `subfamily`, and deriveStyle's corroboration -- which
    // fires exactly at the default weight of 400 -- turns 'Bold' into 700.
    const dir = folderWith({
      'r.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Fam-Regular', familyName: 'Fam', weight: 'Regular',
      }),
      'b.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Fam-Bold', familyName: 'Fam', weight: 'Bold',
      }),
      'i.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Fam-Italic', familyName: 'Fam', weight: 'Regular', italicAngle: -12,
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.ResolveFontByName('Fam', { weight: 700 })!.weight).toBe(700);
    expect(doc.ResolveFontByName('Fam', { weight: 700 })!.exact).toBe(true);
    expect(doc.ResolveFontByName('Fam', { italic: true })!.italic).toBe(true);
    expect(doc.ResolveFontByName('Fam')!.subfamily).toBe('Regular');
  });

  it('is found by DEFAULT, needing no sniff', () => {
    const dir = folderWith({ 'nimbus.pfa': REAL_T1 });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);                 // no { sniff: true }
    expect(doc.LoadFontByName('Nimbus Sans')).toBeDefined();
  });

  it('skips a .pfb that will not parse, and still finds a real one', () => {
    // One corrupt font in a system directory must not break every lookup.
    const dir = folderWith({
      'broken.pfb': new Uint8Array(Buffer.from('%!PS-AdobeFont-1.0: nope\n', 'latin1')),
      'good.pfb': REAL_T1,
    });
    const doc = Document.New();
    expect(() => doc.RegisterFontFolder(dir)).not.toThrow();
    expect(doc.LoadFontByName('Nimbus Sans')).toBeDefined();
  });

  it('skips a Type 1 stating no /FamilyName', () => {
    // Same rule an sfnt stating no name ID 1 already gets: unusable to an index
    // that exists for nothing but matching by name.
    const dir = folderWith({
      'anon.pfb': buildType1({
        charstrings: { '.notdef': Uint8Array.from([139, 139, 13, 14]) },
        fontName: 'Anon',
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Anon')).toBeUndefined();
  });
});
```

Add to the file's imports at the top: `readFileSync` from `node:fs` (it already imports `mkdtempSync`, `writeFileSync`, `mkdirSync`), and `buildType1` from `./helpers/build-type1.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-byname.test.ts`
Expected: FAIL — the Type 1 cases return `undefined`, because `.pfb` is not in `FONT_EXT`.

- [ ] **Step 3: Write the implementation**

In `src/fontsource.ts`, add the import:

```ts
import { isType1, readType1Header } from './type1header.js';
```

Extend `FONT_EXT`:

```ts
/** Extensions worth opening. A cheap filter, not a trusted claim -- the magic
 *  is checked afterwards. `.pfb`/`.pfa` are Type 1, which is a different
 *  container entirely; `peekNames` branches on the magic. */
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc', '.pfb', '.pfa']);
```

In `peekNames`, immediately after `fd = openSync(path, 'r');`, insert the Type 1 branch:

```ts
    // A Type 1's cleartext header lives at the very start of the file, ahead of
    // the eexec section, so indexing one reads a PREFIX and touches no glyph
    // data -- the same partial-read property the sfnt path has. 8 KB is far
    // past any real header.
    const head = readAt(fd, 0, 8192);
    if (isType1(head)) {
      const h = readType1Header(head);
      if (h.familyName === undefined) return [];
      return [{
        faceIndex: 0,
        names: {
          family: h.familyName,
          // /Weight is the word fontmatch.ts's weightFromSubfamily already
          // parses, and `weight` stays at 400 so deriveStyle's corroboration --
          // which fires exactly at 400 -- turns 'Bold' into 700. head.macStyle
          // has no counterpart here, so `bold` stays false and the /Weight
          // string is the positive evidence, which is how fontmatch.ts OR-s.
          subfamily: h.weight ?? 'Regular',
          typographicFamily: undefined,
          typographicSubfamily: undefined,
          postScriptName: h.fontName,
          bold: false,
          italic: h.italicAngle !== 0,
          weight: 400,
        },
      }];
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/font-byname.test.ts`
Expected: PASS — the five new cases and every pre-existing one.

- [ ] **Step 5: Mutation-check the two mappings that carry style**

1. Change `subfamily: h.weight ?? 'Regular'` to `subfamily: 'Regular'`. Run `npx vitest run test/font-byname.test.ts`. Expected: RED on "reads the style out of /Weight and /ItalicAngle" — the weight-700 resolution. **Restore it.**
2. Change `italic: h.italicAngle !== 0` to `italic: false`. Run again. Expected: RED on the same case's italic assertion. **Restore it.**
3. Change `weight: 400` to `weight: 500`. Run again. Expected: RED — the corroboration in `deriveStyle` fires only at 400, so 'Bold' would no longer resolve to 700. This is the non-obvious coupling between the two features and is worth confirming rather than assuming. **Restore it.**

- [ ] **Step 6: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/fontsource.ts test/font-byname.test.ts
git commit -F - <<'EOF'
feat(l1my.5): index a Type 1 by family name

.pfb/.pfa join FONT_EXT, so they are found by DEFAULT and need no
l1my.4 sniff, and peekNames branches on the magic. The cost model
survives: a Type 1's cleartext header sits at the very start of the file,
ahead of eexec, so indexing one reads a prefix and touches no glyph data.

The header maps onto FontNames so that l1my.3's rules apply with no new
style logic: /Weight becomes `subfamily`, the exact string
weightFromSubfamily already parses, and the numeric weight stays at 400
so deriveStyle's corroboration -- which fires only at 400 -- turns 'Bold'
into 700. /ItalicAngle drives `italic`. Measured, including that last
coupling: setting the numeric weight to 500 reddens the style case,
because the corroboration then declines to run.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Documentation

**Files:**
- Modify: `CHANGELOG.md` (an entry under the existing `### Added` in `## [Unreleased]`)
- Modify: `README.md` (the accepted-formats sentence in the font section)
- Modify: `CLAUDE.md` (entries for `type1header.ts` and `type1cff.ts`)

**Interfaces:** consumes everything from Tasks 1-4; produces no code.

- [ ] **Step 1: Add the CHANGELOG entry**

Insert as the FIRST bullet under the existing `### Added` heading in `## [Unreleased]`:

```markdown
- **A Type 1 (`.pfb`/`.pfa`) font can be embedded, and found by family name** — `AddFont` was `parseSfnt`, which accepts sfnt, WOFF, WOFF2 and a `ttcf` collection and nothing else, so a Type 1 program could not be embedded at all; and because the folder index could not read one either, a `.pfb` in `/usr/share/fonts` — which several Linux distributions still ship — was invisible to `LoadFontByName`. Both work now. The conversion turned out to need no charstring transcoder: the interpreter this library already uses to render an *embedded* Type 1 produces outlines as M/L/C/Z cubics in glyph units, which is exactly the Type 2 charstring vocabulary, so the outlines are re-emitted as deltas and assembled into an OpenType-CFF font. That happens inside `parseSfnt`, before anything else sees the bytes — the same placement WOFF reconstruction and `.ttc` face extraction already use — which is why subsetting, `/FontFile3`, Identity-H emission, `/ToUnicode` and family-and-style matching all work with no special case anywhere. **Hinting is lost**, and deliberately: outlines carry none, and preserving them would mean implementing a second charstring grammar that differs from Type 2 in every stack-clearing operator. The cost is a little stem regularity at small sizes in some viewers; it is stated here because a caller comparing output against another producer would otherwise notice and wonder. Indexing stays cheap — a Type 1's cleartext header sits at the very start of the file, so finding one by name reads a prefix and touches no glyph data. (`l1my.5`)
```

- [ ] **Step 2: Update the README**

Replace the accepted-formats sentence in the font section — currently reading "Raw sfnt (`.ttf`, `.otf`) as well as **WOFF** and **WOFF2** web fonts are accepted" — with:

```markdown
Raw sfnt (`.ttf`, `.otf`) as well as **WOFF** and **WOFF2** web fonts are
accepted, and so are **Type 1** programs (`.pfb`, `.pfa`), which are converted
to OpenType-CFF on the way in. That conversion drops the font's hinting —
outlines carry none — which costs a little stem regularity at small sizes in
some viewers; everything else about the face is preserved. A `.pfb` in a
registered folder is also findable by family name, with its `/Weight` and
`/ItalicAngle` driving style matching.
```

- [ ] **Step 3: Update CLAUDE.md**

Append after the `type1.ts`, `type1charstring.ts` bullet:

```markdown
- **type1header.ts**, **type1cff.ts** — the AUTHORING half of Type 1, added in
  `l1my.5`. Note the direction: `type1.ts` reads a program embedded in a
  document being rendered, and these turn one on disk into a font we can embed.
  **Invariant:** the conversion needs NO charstring transcoder, which is why it
  is small. `type1charstring.ts` already yields a `Path` of M/L/C/Z cubics in
  glyph units, and that is exactly the Type 2 vocabulary (`rmoveto`, `rlineto`,
  `rrcurveto`, close implicit), so `encodeType2` re-emits the path as deltas.
  **Invariant:** HINTS ARE LOST, by decision rather than oversight. Preserving
  them means a second charstring grammar whose divergences `type1.ts` already
  records — unbiased subrs, `closepath`, `255` meaning a 32-bit integer rather
  than 16.16, flex arriving through `callothersubr`. The loss is INVISIBLE to
  this suite, since `raster.ts` is a scanline filler that ignores hints
  entirely, so it is documented in README and CHANGELOG rather than left to be
  discovered. Do not add a hint path.
  **Invariant:** the conversion is EAGER, inside `parseSfnt`'s signature
  dispatch — the rule `woff.ts` and `ttc.ts` already follow. That single
  placement is what lets subsetting, `/FontFile3`, Identity-H, `/ToUnicode` and
  `fontmatch.ts` all work with no change; keeping a `Type1Font` on
  `EmbeddedFont` instead would fork every consumer of `SfntFont`.
  **Invariant:** glyph ids are RENUMBERED so `.notdef` is gid 0, which CFF
  requires. `Type1Font` numbers by order of appearance in `/CharStrings` and
  `NimbusSans-Regular.t1` lists `/.notdef` LAST — so the font's own order puts
  the wrong glyph at 0 and shifts every other by one, off by 854 on the only
  real font available.
  **Invariant:** every charstring emits its width. `assembleCidCff` writes
  `Private [0 0]`, so `nominalWidthX` and `defaultWidthX` are both 0 — a width
  operand is then the width itself, and an OMITTED one means an advance of
  zero. A blank glyph is where that shows: a space would stop advancing.
  **Invariant:** the `cmap` is built from glyph NAMES through
  `encoding.ts`'s `glyphToUnicode`, never the program's built-in `/Encoding`,
  which addresses at most 256 codes and says nothing about the rest of
  `/CharStrings`.
  **Invariant:** `type1header.ts` imports NOTHING. `fontsource.ts` indexes
  thousands of files and must not pull a charstring engine in to read a family
  name — which is also why it duplicates `stripPfb` rather than importing
  `type1.ts`. Three value syntaxes, transcribed off the real fixture: `/FontName`
  is a NAME, `/FamilyName` and `/Weight` are parenthesised STRINGS, `/FontBBox`
  is four numbers in braces (brackets accepted, since real fonts write both).
  **Invariant:** a Type 1's header sits ahead of `eexec`, so `peekNames` reads a
  PREFIX and touches no glyph data — `l1my.1`'s cost model survives one more
  format. `.pfb`/`.pfa` are in `FONT_EXT`, so they are found by default and need
  no `l1my.4` sniff.
  **Note on the mapping into `FontNames`, which is where this meets `l1my.3`:**
  `/Weight` becomes `subfamily` — the exact word `weightFromSubfamily` parses —
  and the numeric `weight` stays at **400** so that `deriveStyle`'s
  corroboration, which fires only at 400, turns `Bold` into 700. Setting it to
  anything else silently disables style matching for every Type 1. `bold` stays
  false because `head.macStyle` has no counterpart here; the `/Weight` string is
  the positive evidence, which is how `fontmatch.ts` OR-s its signals.
  **Note, and do NOT read the green suite as covering it:** `type1.ts` already
  records that `NimbusSans-Regular.t1` contains no flex, no `seac` and no `div`,
  and that all 360 of its `callsubr` calls reach a hint-replacement no-op. Those
  conversion paths are exercised by `test/helpers/build-type1.ts` synthetics
  alone. `PROVENANCE.md` records which mutations that fixture cannot catch.
  **Note:** `otfFromCff`'s `OtfMetrics` gained an optional `psName` here,
  because `buildName()` hardcoded `'Embedded'` and every converted font's
  `/BaseFont` would have read that. The default is unchanged, so
  `htmlfontembed.ts`'s output stays byte-identical —
  `test/html-identity.test.ts` is the fence.
```

- [ ] **Step 4: Verify the suite and the build**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. A docs-only task must not move a test.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md CLAUDE.md
git commit -F - <<'EOF'
docs(l1my.5): Type 1 embedding in CHANGELOG, README and CLAUDE.md

States the hint loss plainly in all three, since it is the one thing a
caller comparing output against another producer would notice and wonder
about, and it is invisible to our own suite.

CLAUDE.md records the four conversion invariants, the prefix-read
property that keeps indexing cheap, the FontNames mapping where this
meets l1my.3 -- the numeric weight staying at 400 so deriveStyle's
corroboration runs -- and the fixture gap the real Type 1 file leaves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Close out

- [ ] **Step 1: Verify**

```bash
npm run typecheck && npm test && npm run build
```

- [ ] **Step 2: File follow-ups for anything discovered.** `l1my.6` (`.dfont`) already exists and is NOT part of this work. Do NOT file a hint-transcoder issue — that was settled against, not deferred.

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-l1my.5 --reason "<what shipped, the invariants, what was measured>"
bd show aspose-pdf-foss-for-ts-l1my
```

- [ ] **Step 4: Push — work is NOT complete until this succeeds**

```bash
git pull --rebase
git push
git status          # MUST show "up to date with origin"
```

---

## Self-review notes

**Spec coverage.** Every section maps to a task: the module layout and header reader to Task 1; the conversion and its three invariants to Task 2; the eager `parseSfnt` placement, the sfnt wrapping and the `/BaseFont` fix to Task 3; the index half and the `FontNames` mapping to Task 4; documentation to Task 5. The spec's degradation section is covered by Task 1's "does not throw on bytes that open like PostScript but are not a font" and Task 4's corrupt-`.pfb` case. `faceIndex` being ignored is Task 3, Step 1. The four out-of-scope items produce no task by design.

**One thing the spec did not anticipate, added here:** `sfntwrite.ts`'s `buildName()` hardcodes `'Embedded'`, so Task 3 Step 4 threads an optional `psName` through `OtfMetrics`. The spec named the problem but not the fix; `test/html-identity.test.ts` is called out as the byte-identity fence for the other caller, since `htmlfontembed.ts` shares that function.

**Type consistency.** `Type1Header` fields are used under the same names in Tasks 2, 3 and 4. `Type1Conversion.order` is `newGid → oldGid` throughout, and every consumer indexes it that way. `encodeType2(path, width)` takes the width second in both its definition and its only call. `OtfMetrics.psName` is optional in the interface and passed in `sfntFromType1` only.

**A risk worth naming for the executor.** Task 2's outline comparison is the assertion most likely to fail first, and its failure modes are diagnostic rather than cosmetic: a missed `Z` filter, differencing before rounding instead of after, or a `seac` composite ordering. Do not weaken it to a tolerance — it is the only evidence in this feature that comes from outside the code under test.
