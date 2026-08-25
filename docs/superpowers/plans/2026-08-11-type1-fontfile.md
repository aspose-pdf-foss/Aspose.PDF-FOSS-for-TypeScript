# Type 1 `/FontFile` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render an embedded Type 1 (`/FontFile`) font program's own glyph outlines in `ToImage`, instead of silently substituting a Standard-14 face.

**Architecture:** Two new pure modules — `type1.ts` (container: PFB/PFA framing, eexec decryption, `/Subrs`, `/CharStrings`, built-in `/Encoding`) and `type1charstring.ts` (the Type 1 charstring interpreter) — plus the code→glyph-*name* route the codebase has never had, transcribed from ISO 32000-1 Annex D. `CffFont` and `Type1Font` are unified behind a structural `CharstringProgram` interface so `glyphPolys` gains one branch, and `gidForCode` gains a name route shared by Type 1 and name-keyed CFF.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime dependencies — `node:` built-ins only.

**Spec:** [docs/superpowers/specs/2026-08-11-type1-fontfile-design.md](../specs/2026-08-11-type1-fontfile-design.md)
**Issue:** `aspose-pdf-foss-for-ts-imxw.2`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { CffFont } from './cff.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be clean.
- **Errors:** throw `PdfParseError` from `./errors.js` for malformed input. Never throw out of a per-glyph path — degrade to whatever was drawn, as `CffFont.glyphPath` does.
- **Both gates green before closing:** `npm run typecheck` and `npm test`.
- **Do not export new symbols from `src/index.ts`.** `CffFont` and `SfntFont` are internal; `Type1Font` matches.
- **Task tracking is `bd`, not TodoWrite** (CLAUDE.md).
- **Commit after every task.** Message style: `feat(font): …` / `test(font): …`, body explaining the *why*. End every commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `src/encoding.ts` (modify) | + Annex D code→glyph-name tables for the three base encodings a font may name |
| `src/type1charstring.ts` (create) | Type 1 charstring → cubic `Path` + `hsbw` metrics. Pure; no PDF, no container |
| `src/type1.ts` (create) | Type 1 program container: framing, eexec, `/Subrs`, `/CharStrings`, `/Encoding`, `/FontMatrix` |
| `src/font.ts` (modify) | `/Encoding` precedence resolved to a glyph *name* per code |
| `src/glyphoutline.ts` (modify) | `CharstringProgram`; `type1` on `OutlineSource` |
| `src/raster.ts` (modify) | Load `/FontFile`; name route in `gidForCode` |
| `test/helpers/build-type1.ts` (create) | Synthetic Type 1 program + embedding PDF |
| `test/type1-charstring.test.ts` (create) | Interpreter, on hand-written charstrings |
| `test/type1.test.ts` (create) | Container + wiring + render |
| `test/type1-real.test.ts` (create) | `NimbusSans-Regular.t1` against two external oracles |
| `test/encoding-names.test.ts` (create) | Annex D tables cross-checked against the Unicode tables |

## Two refinements to the spec, found while planning

Both are recorded in the spec itself; noting them here so the implementer is not
surprised by the difference.

1. **Three name columns, not four.** The spec said Standard/WinAnsi/MacRoman/PDFDoc.
   PDFDocEncoding is a *text-string* encoding — 32000-1 Table 114 admits only
   `MacRomanEncoding`, `MacExpertEncoding` and `WinAnsiEncoding` as `/BaseEncoding`,
   with StandardEncoding as the implicit default. A PDFDoc name column would be
   dead code, and `encoding.ts`'s `pdfDocEncoding` is an approximation
   (`winAnsi.slice()` plus two entries), so cross-checking against it would fail
   for reasons that have nothing to do with this work.
2. **Per-encoding maps, not one four-column table.** Same data, organised to
   minimise transcription error: the 95 ASCII names are shared and generated,
   with two documented overrides, and each encoding's high range is its own map.

---

### Task 1: Annex D code→glyph-name tables

**Files:**
- Modify: `src/encoding.ts` (append after `baseEncodingByName`, around line 190)
- Test: `test/encoding-names.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `standardEncodingNames: (string | undefined)[]` — 256 entries
  - `macRomanEncodingNames: (string | undefined)[]` — 256 entries
  - `winAnsiEncodingNames: (string | undefined)[]` — 256 entries
  - `baseEncodingNamesByName(name: string | undefined): (string | undefined)[] | undefined`
    — returns `undefined` for a name we have no table for (including
    `MacExpertEncoding` and `PDFDocEncoding`), so a caller falls through rather
    than being handed a guess.

- [ ] **Step 1: Write the failing test**

Create `test/encoding-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  standardEncoding, macRoman, winAnsi, glyphToUnicode,
  standardEncodingNames, macRomanEncodingNames, winAnsiEncodingNames,
  baseEncodingNamesByName,
} from '../src/encoding.js';

/** The three encodings a PDF font may name, paired with the code->Unicode table
 *  encoding.ts already carried. The two were transcribed from the same Annex D
 *  rows independently, so each is a check on the other. */
const TABLES = [
  ['StandardEncoding', standardEncoding, standardEncodingNames],
  ['MacRomanEncoding', macRoman, macRomanEncodingNames],
  ['WinAnsiEncoding', winAnsi, winAnsiEncodingNames],
] as const;

/** Codes where a name and its Unicode legitimately disagree, because Annex D
 *  maps two codes onto one glyph. Not slack — an exhaustive list. */
const DUPLICATES: Record<string, number[]> = {
  StandardEncoding: [],
  MacRomanEncoding: [0xca],          // /space at the non-breaking-space code
  WinAnsiEncoding: [0xa0, 0xad],     // /space at nbsp, /hyphen at soft hyphen
};

/** Codes the Unicode table defines that Annex D Table D.2 does not name. */
const UNNAMED: Record<string, number[]> = {
  StandardEncoding: [],
  MacRomanEncoding: [0xb0],          // Apple's /infinity: MacRoman, but not PDF's
  WinAnsiEncoding: [0x7f],           // DEL, filled in by the 0x20..0xff loop
};

describe('Annex D glyph-name tables', () => {
  for (const [label, uni, names] of TABLES) {
    it(`${label}: every name agrees with the Unicode table at the same code`, () => {
      const bad: string[] = [];
      for (let c = 0; c < 256; c++) {
        const n = names[c];
        if (n === undefined || DUPLICATES[label].includes(c)) continue;
        const u = glyphToUnicode(n);
        if (u === undefined || uni[c] === undefined) continue;
        if (u !== uni[c]) bad.push(`0x${c.toString(16)} /${n} -> ${JSON.stringify(u)} != ${JSON.stringify(uni[c])}`);
      }
      expect(bad).toEqual([]);
    });

    it(`${label}: names every code the Unicode table defines`, () => {
      const missing: number[] = [];
      for (let c = 0; c < 256; c++) {
        if (uni[c] === undefined || UNNAMED[label].includes(c)) continue;
        if (names[c] === undefined) missing.push(c);
      }
      expect(missing).toEqual([]);
    });

    it(`${label}: names no code the Unicode table leaves empty`, () => {
      const extra: number[] = [];
      for (let c = 0; c < 256; c++) if (names[c] !== undefined && uni[c] === undefined) extra.push(c);
      expect(extra).toEqual([]);
    });
  }

  it('separates the three encodings where they actually differ', () => {
    expect(standardEncodingNames[0x27]).toBe('quoteright');
    expect(winAnsiEncodingNames[0x27]).toBe('quotesingle');
    expect(macRomanEncodingNames[0x27]).toBe('quotesingle');
    expect(standardEncodingNames[0x60]).toBe('quoteleft');
    expect(winAnsiEncodingNames[0x60]).toBe('grave');
    expect(standardEncodingNames[0xa9]).toBe('quotesingle');
    expect(winAnsiEncodingNames[0xa9]).toBe('copyright');
    expect(macRomanEncodingNames[0xa9]).toBe('copyright');
    expect(standardEncodingNames[0xe1]).toBe('AE');
    expect(winAnsiEncodingNames[0xe1]).toBe('aacute');
  });

  it('answers only for encodings a font may name', () => {
    expect(baseEncodingNamesByName('WinAnsiEncoding')).toBe(winAnsiEncodingNames);
    expect(baseEncodingNamesByName('MacRomanEncoding')).toBe(macRomanEncodingNames);
    expect(baseEncodingNamesByName('StandardEncoding')).toBe(standardEncodingNames);
    // No table, and no guess: MacExpert is a different character set entirely,
    // and PDFDoc is not a font encoding at all.
    expect(baseEncodingNamesByName('MacExpertEncoding')).toBeUndefined();
    expect(baseEncodingNamesByName('PDFDocEncoding')).toBeUndefined();
    expect(baseEncodingNamesByName(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/encoding-names.test.ts`
Expected: FAIL — `standardEncodingNames` is not exported from `../src/encoding.js`.

- [ ] **Step 3: Add the tables**

Append to `src/encoding.ts`:

```ts
// ---------- Annex D Table D.2: code -> glyph name ----------
//
// The counterpart to the code -> Unicode tables above, and the only route from
// a character code to a Type 1 font's /CharStrings or a name-keyed CFF's
// charset — both of which are keyed by glyph name, not by character.
//
// Deriving these by inverting the Unicode tables through the AGL was rejected:
// the mapping is many-to-one (/quoteright and /quotesingle, /hyphen and /minus,
// /space and the two non-breaking codes below), and cidunicode.ts records what
// inverting a many-to-one mapping costs.
//
// PDFDocEncoding has no column: 32000-1 Table 114 admits only MacRoman,
// MacExpert and WinAnsi as /BaseEncoding, with Standard as the default.

/** Codes 0x20..0x7E, shared by all three encodings but for two codes. */
const ASCII_NAMES: string[] = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand',
  'quotesingle', 'parenleft', 'parenright', 'asterisk', 'plus', 'comma',
  'hyphen', 'period', 'slash', 'zero', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal',
  'greater', 'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I',
  'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X',
  'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum',
  'underscore', 'grave', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j',
  'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y',
  'z', 'braceleft', 'bar', 'braceright', 'asciitilde',
];

/** StandardEncoding's high range, 0xA1..0xFB (Annex D Table D.2, STD column). */
const STD_HIGH: Record<number, string> = {
  0xa1:'exclamdown', 0xa2:'cent', 0xa3:'sterling', 0xa4:'fraction', 0xa5:'yen',
  0xa6:'florin', 0xa7:'section', 0xa8:'currency', 0xa9:'quotesingle',
  0xaa:'quotedblleft', 0xab:'guillemotleft', 0xac:'guilsinglleft',
  0xad:'guilsinglright', 0xae:'fi', 0xaf:'fl',
  0xb1:'endash', 0xb2:'dagger', 0xb3:'daggerdbl', 0xb4:'periodcentered',
  0xb6:'paragraph', 0xb7:'bullet', 0xb8:'quotesinglbase', 0xb9:'quotedblbase',
  0xba:'quotedblright', 0xbb:'guillemotright', 0xbc:'ellipsis',
  0xbd:'perthousand', 0xbf:'questiondown',
  0xc1:'grave', 0xc2:'acute', 0xc3:'circumflex', 0xc4:'tilde', 0xc5:'macron',
  0xc6:'breve', 0xc7:'dotaccent', 0xc8:'dieresis', 0xca:'ring', 0xcb:'cedilla',
  0xcd:'hungarumlaut', 0xce:'ogonek', 0xcf:'caron', 0xd0:'emdash',
  0xe1:'AE', 0xe3:'ordfeminine', 0xe8:'Lslash', 0xe9:'Oslash', 0xea:'OE',
  0xeb:'ordmasculine', 0xf1:'ae', 0xf5:'dotlessi', 0xf8:'lslash',
  0xf9:'oslash', 0xfa:'oe', 0xfb:'germandbls',
};

/** MacRomanEncoding's high range (Annex D Table D.2, MAC column). Apple's own
 *  MacRoman additions — /infinity at 0xB0 and the other maths glyphs — are not
 *  in Table D.2 and are deliberately absent. */
const MAC_HIGH: Record<number, string> = {
  0x80:'Adieresis', 0x81:'Aring', 0x82:'Ccedilla', 0x83:'Eacute', 0x84:'Ntilde',
  0x85:'Odieresis', 0x86:'Udieresis', 0x87:'aacute', 0x88:'agrave',
  0x89:'acircumflex', 0x8a:'adieresis', 0x8b:'atilde', 0x8c:'aring',
  0x8d:'ccedilla', 0x8e:'eacute', 0x8f:'egrave', 0x90:'ecircumflex',
  0x91:'edieresis', 0x92:'iacute', 0x93:'igrave', 0x94:'icircumflex',
  0x95:'idieresis', 0x96:'ntilde', 0x97:'oacute', 0x98:'ograve',
  0x99:'ocircumflex', 0x9a:'odieresis', 0x9b:'otilde', 0x9c:'uacute',
  0x9d:'ugrave', 0x9e:'ucircumflex', 0x9f:'udieresis',
  0xa0:'dagger', 0xa1:'degree', 0xa2:'cent', 0xa3:'sterling', 0xa4:'section',
  0xa5:'bullet', 0xa6:'paragraph', 0xa7:'germandbls', 0xa8:'registered',
  0xa9:'copyright', 0xaa:'trademark', 0xab:'acute', 0xac:'dieresis',
  0xae:'AE', 0xaf:'Oslash', 0xb1:'plusminus', 0xb4:'yen', 0xb5:'mu',
  0xbb:'ordfeminine', 0xbc:'ordmasculine', 0xbe:'ae', 0xbf:'oslash',
  0xc0:'questiondown', 0xc1:'exclamdown', 0xc2:'logicalnot', 0xc4:'florin',
  0xc7:'guillemotleft', 0xc8:'guillemotright', 0xc9:'ellipsis', 0xca:'space',
  0xcb:'Agrave', 0xcc:'Atilde', 0xcd:'Otilde', 0xce:'OE', 0xcf:'oe',
  0xd0:'endash', 0xd1:'emdash', 0xd2:'quotedblleft', 0xd3:'quotedblright',
  0xd4:'quoteleft', 0xd5:'quoteright', 0xd6:'divide', 0xd8:'ydieresis',
  0xd9:'Ydieresis', 0xda:'fraction', 0xdb:'currency', 0xdc:'guilsinglleft',
  0xdd:'guilsinglright', 0xde:'fi', 0xdf:'fl', 0xe0:'daggerdbl',
  0xe1:'periodcentered', 0xe2:'quotesinglbase', 0xe3:'quotedblbase',
  0xe4:'perthousand', 0xe5:'Acircumflex', 0xe6:'Ecircumflex', 0xe7:'Aacute',
  0xe8:'Edieresis', 0xe9:'Egrave', 0xea:'Iacute', 0xeb:'Icircumflex',
  0xec:'Idieresis', 0xed:'Igrave', 0xee:'Oacute', 0xef:'Ocircumflex',
  0xf1:'Ograve', 0xf2:'Uacute', 0xf3:'Ucircumflex', 0xf4:'Ugrave',
  0xf5:'dotlessi', 0xf6:'circumflex', 0xf7:'tilde', 0xf8:'macron',
  0xf9:'breve', 0xfa:'dotaccent', 0xfb:'ring', 0xfc:'cedilla',
  0xfd:'hungarumlaut', 0xfe:'ogonek', 0xff:'caron',
};

/** WinAnsiEncoding's high range (Annex D Table D.2, WIN column). 0xA0 and 0xAD
 *  are Annex D's documented duplicates: /space and /hyphen a second time. */
const WIN_HIGH: Record<number, string> = {
  0x80:'Euro', 0x82:'quotesinglbase', 0x83:'florin', 0x84:'quotedblbase',
  0x85:'ellipsis', 0x86:'dagger', 0x87:'daggerdbl', 0x88:'circumflex',
  0x89:'perthousand', 0x8a:'Scaron', 0x8b:'guilsinglleft', 0x8c:'OE',
  0x8e:'Zcaron', 0x91:'quoteleft', 0x92:'quoteright', 0x93:'quotedblleft',
  0x94:'quotedblright', 0x95:'bullet', 0x96:'endash', 0x97:'emdash',
  0x98:'tilde', 0x99:'trademark', 0x9a:'scaron', 0x9b:'guilsinglright',
  0x9c:'oe', 0x9e:'zcaron', 0x9f:'Ydieresis',
  0xa0:'space', 0xa1:'exclamdown', 0xa2:'cent', 0xa3:'sterling',
  0xa4:'currency', 0xa5:'yen', 0xa6:'brokenbar', 0xa7:'section',
  0xa8:'dieresis', 0xa9:'copyright', 0xaa:'ordfeminine', 0xab:'guillemotleft',
  0xac:'logicalnot', 0xad:'hyphen', 0xae:'registered', 0xaf:'macron',
  0xb0:'degree', 0xb1:'plusminus', 0xb2:'twosuperior', 0xb3:'threesuperior',
  0xb4:'acute', 0xb5:'mu', 0xb6:'paragraph', 0xb7:'periodcentered',
  0xb8:'cedilla', 0xb9:'onesuperior', 0xba:'ordmasculine',
  0xbb:'guillemotright', 0xbc:'onequarter', 0xbd:'onehalf',
  0xbe:'threequarters', 0xbf:'questiondown',
  0xc0:'Agrave', 0xc1:'Aacute', 0xc2:'Acircumflex', 0xc3:'Atilde',
  0xc4:'Adieresis', 0xc5:'Aring', 0xc6:'AE', 0xc7:'Ccedilla', 0xc8:'Egrave',
  0xc9:'Eacute', 0xca:'Ecircumflex', 0xcb:'Edieresis', 0xcc:'Igrave',
  0xcd:'Iacute', 0xce:'Icircumflex', 0xcf:'Idieresis', 0xd0:'Eth',
  0xd1:'Ntilde', 0xd2:'Ograve', 0xd3:'Oacute', 0xd4:'Ocircumflex',
  0xd5:'Otilde', 0xd6:'Odieresis', 0xd7:'multiply', 0xd8:'Oslash',
  0xd9:'Ugrave', 0xda:'Uacute', 0xdb:'Ucircumflex', 0xdc:'Udieresis',
  0xdd:'Yacute', 0xde:'Thorn', 0xdf:'germandbls',
  0xe0:'agrave', 0xe1:'aacute', 0xe2:'acircumflex', 0xe3:'atilde',
  0xe4:'adieresis', 0xe5:'aring', 0xe6:'ae', 0xe7:'ccedilla', 0xe8:'egrave',
  0xe9:'eacute', 0xea:'ecircumflex', 0xeb:'edieresis', 0xec:'igrave',
  0xed:'iacute', 0xee:'icircumflex', 0xef:'idieresis', 0xf0:'eth',
  0xf1:'ntilde', 0xf2:'ograve', 0xf3:'oacute', 0xf4:'ocircumflex',
  0xf5:'otilde', 0xf6:'odieresis', 0xf7:'divide', 0xf8:'oslash',
  0xf9:'ugrave', 0xfa:'uacute', 0xfb:'ucircumflex', 0xfc:'udieresis',
  0xfd:'yacute', 0xfe:'thorn', 0xff:'ydieresis',
};

function buildNames(high: Record<number, string>, asciiOverrides: Record<number, string>): (string | undefined)[] {
  const t: (string | undefined)[] = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = ASCII_NAMES[c - 0x20];
  for (const k of Object.keys(asciiOverrides)) t[+k] = asciiOverrides[+k];
  for (const k of Object.keys(high)) t[+k] = high[+k];
  return t;
}

/** StandardEncoding as glyph names. Its two ASCII departures are the typographic
 *  quotes: 0x27 is /quoteright and 0x60 is /quoteleft, where the other two
 *  encodings carry the straight /quotesingle and /grave. */
export const standardEncodingNames = buildNames(STD_HIGH, { 0x27: 'quoteright', 0x60: 'quoteleft' });
export const macRomanEncodingNames = buildNames(MAC_HIGH, {});
export const winAnsiEncodingNames = buildNames(WIN_HIGH, {});

/**
 * Glyph names for a base encoding a font dict may name, or `undefined` when we
 * have no table for it.
 *
 * Unlike {@link baseEncodingByName} this does *not* default to WinAnsi. A
 * caller that gets `undefined` must fall through to the font program's own
 * encoding, which is a real answer; defaulting would hand it a wrong one.
 */
export function baseEncodingNamesByName(name: string | undefined): (string | undefined)[] | undefined {
  switch (name) {
    case 'StandardEncoding': return standardEncodingNames;
    case 'MacRomanEncoding': return macRomanEncodingNames;
    case 'WinAnsiEncoding': return winAnsiEncodingNames;
    default: return undefined;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/encoding-names.test.ts && npm run typecheck`
Expected: PASS, 11 tests. If the "names every code" case fails, the transcription
is short a row — add it, do not extend `UNNAMED`.

- [ ] **Step 5: Commit**

```bash
git add src/encoding.ts test/encoding-names.test.ts
git commit -m "$(cat <<'EOF'
feat(font): Annex D code -> glyph-name tables (imxw.2)

encoding.ts stored every base encoding as code -> Unicode, so there was no
route from a character code to a glyph name anywhere in the tree. A Type 1
font's /CharStrings and a name-keyed CFF's charset are both keyed by name.

Transcribed rather than inverted from the Unicode tables: the mapping is
many-to-one (/quoteright and /quotesingle collide, as do /hyphen and /minus),
and the two transcriptions now cross-check each other.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Type 1 charstring interpreter

**Files:**
- Create: `src/type1charstring.ts`
- Test: `test/type1-charstring.test.ts` (create)

**Interfaces:**
- Consumes: `Path`, `Seg` from `./pagerender.js`.
- Produces:

```ts
export interface Type1Glyph { path: Path; width: number; sbx: number; sby: number; }
export interface Type1Env {
  subrs: Uint8Array[];                                  // decrypted, indexed as the font numbers them
  seacGlyph?(stdCode: number): Uint8Array | undefined;  // decrypted charstring for a StandardEncoding code
}
export function runType1Charstring(code: Uint8Array, env: Type1Env): Type1Glyph;
```

- [ ] **Step 1: Write the failing test**

Create `test/type1-charstring.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { runType1Charstring, Type1Env } from '../src/type1charstring.js';

/** Encode an operand the way a Type 1 charstring spells it. Note 255: a Type 1
 *  32-bit *integer*, where the same byte in a Type 2 charstring introduces a
 *  16.16 fixed-point number. */
function num(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const v = n - 108; return [(v >> 8) + 247, v & 0xff]; }
  if (n <= -108 && n >= -1131) { const v = -n - 108; return [(v >> 8) + 251, v & 0xff]; }
  return [255, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
const cs = (...parts: (number[] | number)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : p)));

const noEnv: Type1Env = { subrs: [] };

describe('Type 1 charstring interpreter', () => {
  it('hsbw sets the width and moves the pen to the left sidebearing', () => {
    // 50 400 hsbw : sbx=50, width=400, current point (50,0).
    // 100 200 rmoveto then draws from (150,200), not (100,200).
    const g = runType1Charstring(cs(num(50), num(400), 13, num(100), num(200), 21, 14), noEnv);
    expect(g.width).toBe(400);
    expect(g.sbx).toBe(50);
    expect(g.path).toEqual([{ op: 'M', x: 150, y: 200 }]);
  });

  it('draws lines and closes a subpath', () => {
    const g = runType1Charstring(cs(
      num(0), num(500), 13,        // hsbw
      num(100), num(100), 21,      // rmoveto -> (100,100)
      num(300), 6,                 // hlineto -> (400,100)
      num(200), 7,                 // vlineto -> (400,300)
      num(-300), num(0), 5,        // rlineto -> (100,300)
      9,                           // closepath
      14,                          // endchar
    ), noEnv);
    expect(g.path).toEqual([
      { op: 'M', x: 100, y: 100 },
      { op: 'L', x: 400, y: 100 },
      { op: 'L', x: 400, y: 300 },
      { op: 'L', x: 100, y: 300 },
      { op: 'Z' },
    ]);
  });

  it('hlineto and vlineto take exactly one argument, unlike Type 2', () => {
    // A Type 2 interpreter alternates over the whole stack and would emit two
    // segments here. Type 1 uses the first operand and discards the rest.
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(100), num(200), 6, 14), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 }]);
  });

  it('rrcurveto, hvcurveto and vhcurveto emit cubics', () => {
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(10), num(20), num(30), num(40), num(50), num(60), 8,   // rrcurveto
      num(10), num(20), num(30), num(40), 31,                    // hvcurveto
      num(10), num(20), num(30), num(40), 30,                    // vhcurveto
      14,
    ), noEnv);
    expect(g.path).toEqual([
      { op: 'M', x: 0, y: 0 },
      { op: 'C', x1: 10, y1: 20, x2: 40, y2: 60, x: 90, y: 120 },
      { op: 'C', x1: 100, y1: 120, x2: 130, y2: 160, x: 130, y: 200 },
      { op: 'C', x1: 130, y1: 220, x2: 160, y2: 260, x: 200, y: 260 },
    ]);
  });

  it('callsubr does not bias its index', () => {
    // Type 2 would add 107 here. Index 5 and index 112 hold different drawings,
    // so a biased lookup produces the wrong one rather than nothing.
    const subrs: Uint8Array[] = [];
    for (let i = 0; i < 120; i++) subrs[i] = cs(11);
    subrs[5] = cs(num(300), 6, 11);              // hlineto 300, return
    subrs[112] = cs(num(300), 7, 11);            // vlineto 300, return
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(5), 10, 14), { subrs });
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }]);
  });

  it('div computes before the operator consumes it', () => {
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(600), num(2), 12, 12, 6,             // 600 2 div hlineto -> 300
      14,
    ), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }]);
  });

  it('assembles a flex from the OtherSubrs 0/1/2 protocol', () => {
    // 1 callothersubr opens; seven rmoveto's accumulate (the first is the
    // reference point, discarded); 0 callothersubr closes into two curves.
    const flexPt = (dx: number, dy: number): number[] =>
      [...num(0), ...num(1), 12, 16, ...num(dx), ...num(dy), 21];
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(0), num(1), 12, 16,                  // 0 args, othersubr 1: begin flex
      flexPt(50, 0).slice(4),                  // reference point (50,0)
      num(50), num(0), 21,
      num(0), num(20), 21,
      num(20), num(0), 21,
      num(20), num(0), 21,
      num(0), num(-20), 21,
      num(20), num(0), 21,
      num(50), num(0), num(3), num(0), 12, 16, // 3 args, othersubr 0: end flex
      12, 17, 12, 17,                          // pop pop
      12, 33,                                  // setcurrentpoint
      14,
    ), noEnv);
    const curves = g.path.filter((s) => s.op === 'C');
    expect(curves).toHaveLength(2);
    expect(g.path.filter((s) => s.op === 'M')).toHaveLength(1);   // no stray movetos
  });

  it('hint replacement leaves its subr number for the following pop', () => {
    const subrs: Uint8Array[] = [];
    for (let i = 0; i < 10; i++) subrs[i] = cs(11);
    subrs[7] = cs(num(300), 6, 11);
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(7), num(1), num(3), 12, 16,          // subr# 1 3 callothersubr
      12, 17,                                  // pop -> 7
      10,                                      // callsubr 7
      14,
    ), { subrs });
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }]);
  });

  it('leaves an unknown othersubr’s arguments for pop', () => {
    const g = runType1Charstring(cs(
      num(0), num(0), 13, num(0), num(0), 21,
      num(300), num(1), num(14), 12, 16,       // 1 arg, othersubr 14 (unknown)
      12, 17,                                  // pop -> 300
      6,                                       // hlineto 300
      14,
    ), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 300, y: 0 }]);
  });

  it('composes an accented glyph with seac', () => {
    const base = cs(num(0), num(500), 13, num(0), num(0), 21, num(100), 6, 14);
    const accent = cs(num(0), num(300), 13, num(0), num(0), 21, num(50), 7, 14);
    const env: Type1Env = {
      subrs: [],
      seacGlyph: (c) => (c === 65 ? base : c === 194 ? accent : undefined),   // /A, /acute
    };
    // asb=0 adx=30 ady=400 bchar=65 achar=194
    const g = runType1Charstring(cs(num(0), num(500), 13, num(0), num(30), num(400), num(65), num(194), 12, 6), env);
    expect(g.path).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 },
      { op: 'M', x: 30, y: 400 }, { op: 'L', x: 30, y: 450 },
    ]);
    expect(g.width).toBe(500);   // the composite's own width, not the accent's
  });

  it('bounds recursion instead of hanging on a self-calling subr', () => {
    const subrs = [cs(num(0), 10, 11)];        // subr 0 calls subr 0
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(0), 10, 14), { subrs });
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }]);
  });

  it('degrades to what it drew when the bytes run out mid-operator', () => {
    const g = runType1Charstring(cs(num(0), num(0), 13, num(0), num(0), 21, num(100), 6, 247), noEnv);
    expect(g.path).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 }]);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/type1-charstring.test.ts`
Expected: FAIL — cannot resolve `../src/type1charstring.js`.

- [ ] **Step 3: Write the interpreter**

Create `src/type1charstring.ts`:

```ts
import type { Path, Seg } from './pagerender.js';

/**
 * One interpreted Type 1 charstring.
 *
 * `width` and `sbx`/`sby` come from `hsbw`/`sbw`. The sidebearing is not merely
 * a metric: it is where the pen starts, so a glyph interpreted without it lands
 * displaced by its own left sidebearing — uniformly enough across a font to look
 * like a slightly wrong face rather than a bug.
 */
export interface Type1Glyph { path: Path; width: number; sbx: number; sby: number; }

/** What a charstring can reach outside itself. */
export interface Type1Env {
  /** Decrypted /Subrs, indexed exactly as the font numbers them. Type 2's
   *  subr bias is a Type 2 invention and must not be applied here. */
  subrs: Uint8Array[];
  /** Decrypted charstring for a StandardEncoding code, for `seac`. Absent when
   *  the caller cannot resolve one, which makes `seac` draw nothing. */
  seacGlyph?(stdCode: number): Uint8Array | undefined;
}

const MAX_DEPTH = 10;

interface T1Ctx {
  path: Path;
  x: number; y: number;
  stack: number[];
  /** The PostScript operand stack `callothersubr` writes and `pop` reads. */
  ps: number[];
  open: boolean;
  width: number; sbx: number; sby: number;
  haveWidth: boolean;
  env: Type1Env;
  depth: number;
  /** Non-undefined while an OtherSubrs 1 flex is being accumulated. */
  flex?: { x: number; y: number }[];
  /** Set by `seac`, consumed by the top-level caller. */
  seac?: { asb: number; adx: number; ady: number; bchar: number; achar: number };
  done: boolean;
}

function moveTo(c: T1Ctx, x: number, y: number): void {
  if (c.open) { c.path.push({ op: 'Z' }); c.open = false; }
  c.x = x; c.y = y;
  c.path.push({ op: 'M', x, y });
  c.open = true;
}
function lineTo(c: T1Ctx, x: number, y: number): void {
  c.x = x; c.y = y;
  c.path.push({ op: 'L', x, y });
}
function curveTo(c: T1Ctx, x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
  c.x = x; c.y = y;
  c.path.push({ op: 'C', x1, y1, x2, y2, x, y } as Seg);
}

/** Interpret one charstring. Never throws: a damaged charstring costs its own
 *  glyph, matching `CffFont.glyphPath`. */
export function runType1Charstring(code: Uint8Array, env: Type1Env): Type1Glyph {
  const c: T1Ctx = {
    path: [], x: 0, y: 0, stack: [], ps: [], open: false,
    width: 0, sbx: 0, sby: 0, haveWidth: false, env, depth: 0, done: false,
  };
  try { exec(code, c); } catch { /* keep whatever was drawn */ }
  if (c.seac && env.seacGlyph) applySeac(c, env);
  if (c.open) { c.path.push({ op: 'Z' }); c.open = false; }
  return { path: c.path, width: c.width, sbx: c.sbx, sby: c.sby };
}

/** Replace the composite's (empty) outline with base + translated accent.
 *  32000-1 defers to the Type 1 spec here: the accent's origin goes to
 *  `adx - asb + sbx`, which corrects for the two glyphs' differing sidebearings. */
function applySeac(c: T1Ctx, env: Type1Env): void {
  const { asb, adx, ady, bchar, achar } = c.seac!;
  const base = env.seacGlyph!(bchar);
  const accent = env.seacGlyph!(achar);
  c.path = [];
  c.open = false;
  if (base) {
    const g = runType1Charstring(base, { subrs: env.subrs });
    c.path.push(...g.path);
  }
  if (accent) {
    const g = runType1Charstring(accent, { subrs: env.subrs });
    const dx = c.sbx - asb + adx, dy = ady;
    for (const s of g.path) {
      if (s.op === 'Z') c.path.push(s);
      else if (s.op === 'C') c.path.push({ op: 'C', x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy, x: s.x + dx, y: s.y + dy });
      else c.path.push({ op: s.op, x: s.x + dx, y: s.y + dy });
    }
  }
}

function exec(code: Uint8Array, c: T1Ctx): void {
  if (c.depth > MAX_DEPTH) return;
  let i = 0;
  while (i < code.length && !c.done) {
    const b = code[i++];
    if (b >= 32) {                                            // operand
      if (b <= 246) c.stack.push(b - 139);
      else if (b <= 250) { c.stack.push((b - 247) * 256 + code[i] + 108); i += 1; }
      else if (b <= 254) { c.stack.push(-(b - 251) * 256 - code[i] - 108); i += 1; }
      else {                                                  // 255: 32-bit integer, NOT 16.16
        c.stack.push(((code[i] << 24) | (code[i + 1] << 16) | (code[i + 2] << 8) | code[i + 3]) | 0);
        i += 4;
      }
      continue;
    }
    const s = c.stack;
    switch (b) {
      case 1: case 3: s.length = 0; break;                    // hstem / vstem
      case 4: rmove(c, 0, s[0] ?? 0); s.length = 0; break;    // vmoveto
      case 5: lineTo(c, c.x + (s[0] ?? 0), c.y + (s[1] ?? 0)); s.length = 0; break;   // rlineto
      case 6: lineTo(c, c.x + (s[0] ?? 0), c.y); s.length = 0; break;                 // hlineto
      case 7: lineTo(c, c.x, c.y + (s[0] ?? 0)); s.length = 0; break;                 // vlineto
      case 8: rrcurve(c, s[0], s[1], s[2], s[3], s[4], s[5]); s.length = 0; break;    // rrcurveto
      case 9: if (c.open) { c.path.push({ op: 'Z' }); c.open = false; } s.length = 0; break;  // closepath
      case 10: {                                              // callsubr — unbiased
        const idx = s.pop() ?? 0;
        const sub = c.env.subrs[idx];
        if (sub) { c.depth++; exec(sub, c); c.depth--; }
        break;
      }
      case 11: return;                                        // return
      case 13:                                                // hsbw
        c.sbx = s[0] ?? 0; c.width = s[1] ?? 0; c.haveWidth = true;
        c.x = c.sbx; c.y = 0;
        s.length = 0; break;
      case 14: c.done = true; return;                         // endchar
      case 21: rmove(c, s[0] ?? 0, s[1] ?? 0); s.length = 0; break;   // rmoveto
      case 22: rmove(c, s[0] ?? 0, 0); s.length = 0; break;           // hmoveto
      case 30: rrcurve(c, 0, s[0], s[1], s[2], s[3], 0); s.length = 0; break;  // vhcurveto
      case 31: rrcurve(c, s[0], 0, s[1], s[2], 0, s[3]); s.length = 0; break;  // hvcurveto
      case 12: escape(c, code[i++]); break;
      default: s.length = 0; break;
    }
  }
}

/** A relative moveto — or, inside a flex, one of its seven accumulated points. */
function rmove(c: T1Ctx, dx: number, dy: number): void {
  const nx = c.x + dx, ny = c.y + dy;
  if (c.flex) { c.flex.push({ x: nx, y: ny }); c.x = nx; c.y = ny; return; }
  moveTo(c, nx, ny);
}

function rrcurve(c: T1Ctx, dx1 = 0, dy1 = 0, dx2 = 0, dy2 = 0, dx3 = 0, dy3 = 0): void {
  const x1 = c.x + dx1, y1 = c.y + dy1;
  const x2 = x1 + dx2, y2 = y1 + dy2;
  curveTo(c, x1, y1, x2, y2, x2 + dx3, y2 + dy3);
}

function escape(c: T1Ctx, b1: number): void {
  const s = c.stack;
  switch (b1) {
    case 0: case 1: case 2: s.length = 0; break;              // dotsection, vstem3, hstem3
    case 6:                                                   // seac
      c.seac = { asb: s[0] ?? 0, adx: s[1] ?? 0, ady: s[2] ?? 0, bchar: s[3] ?? 0, achar: s[4] ?? 0 };
      s.length = 0; c.done = true; break;
    case 7:                                                   // sbw
      c.sbx = s[0] ?? 0; c.sby = s[1] ?? 0; c.width = s[2] ?? 0; c.haveWidth = true;
      c.x = c.sbx; c.y = c.sby;
      s.length = 0; break;
    case 12: { const b = s.pop() ?? 1, a = s.pop() ?? 0; s.push(b === 0 ? 0 : a / b); break; }  // div
    case 16: othersubr(c); break;                             // callothersubr
    case 17: s.push(c.ps.pop() ?? 0); break;                  // pop
    case 33:                                                  // setcurrentpoint
      c.x = s[0] ?? c.x; c.y = s[1] ?? c.y; s.length = 0; break;
    default: s.length = 0; break;
  }
}

/**
 * `callothersubr`: `arg1 .. argn n othersubr# callothersubr`.
 *
 * 0/1/2 are the flex protocol and 3 is hint replacement. Anything else is a
 * font-specific PostScript procedure we cannot run, and the spec's rule is that
 * its arguments stay on the PostScript stack for the `pop`s that follow —
 * dropping them desynchronizes every operand after this point.
 */
function othersubr(c: T1Ctx): void {
  const s = c.stack;
  const idx = s.pop() ?? 0;
  const n = s.pop() ?? 0;
  const args: number[] = [];
  for (let k = 0; k < n; k++) args.unshift(s.pop() ?? 0);

  if (idx === 1) { c.flex = []; return; }                     // begin flex
  if (idx === 2) return;                                      // flex point collected by rmove
  if (idx === 0) {                                            // end flex
    const p = c.flex;
    c.flex = undefined;
    // p[0] is the reference point, which draws nothing; p[1..6] are the two
    // curves' control and end points, already absolute.
    if (p && p.length >= 7) {
      curveTo(c, p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
      curveTo(c, p[4].x, p[4].y, p[5].x, p[5].y, p[6].x, p[6].y);
    }
    // The trailing `pop pop setcurrentpoint` expects the end point back.
    c.ps.push(c.y, c.x);
    return;
  }
  if (idx === 3) { c.ps.push(args[0] ?? 3); return; }         // hint replacement: subr# back for pop
  for (let k = args.length - 1; k >= 0; k--) c.ps.push(args[k]);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/type1-charstring.test.ts && npm run typecheck`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/type1charstring.ts test/type1-charstring.test.ts
git commit -m "$(cat <<'EOF'
feat(font): Type 1 charstring interpreter (imxw.2)

A separate interpreter rather than a mode flag on cff.ts. The two grammars
share the operand encoding minus two cases and diverge in every operator that
clears the stack: 255 is a 32-bit integer here and 16.16 fixed there, callsubr
is unbiased, h/vlineto take one argument rather than alternating, hsbw has no
Type 2 counterpart, and flex arrives through callothersubr rather than as an
operator.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Type 1 container and synthetic fixture builder

**Files:**
- Create: `src/type1.ts`
- Create: `test/helpers/build-type1.ts`
- Test: `test/type1.test.ts` (create; the container half — the render half arrives in Task 5)

**Interfaces:**
- Consumes: `runType1Charstring`, `Type1Env`, `Type1Glyph` from `./type1charstring.js`; `standardEncodingNames` from `./encoding.js`; `PdfParseError` from `./errors.js`; `Path` from `./pagerender.js`.
- Produces:

```ts
export class Type1Font {
  constructor(bytes: Uint8Array);        // throws PdfParseError when unreadable
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  glyphPath(gid: number): Path;
  glyphWidth(gid: number): number;
  glyphName(gid: number): string | undefined;
  gidForName(name: string): number | undefined;
  builtinEncodingNames(): Map<number, string> | undefined;
}
```
- Test helper produces:
```ts
export interface Type1Spec {
  charstrings: Record<string, Uint8Array>;   // glyph name -> PLAINTEXT charstring
  subrs?: Uint8Array[];                      // plaintext
  encoding?: Record<number, string>;         // omit => the program says StandardEncoding
  lenIV?: number;                            // default 4
  hexEexec?: boolean;                        // default false
  pfb?: boolean;                             // default false
  fontMatrix?: number[];                     // default [0.001,0,0,0.001,0,0]
  rdToken?: 'RD' | '-|';                     // default 'RD'
}
export function buildType1(spec: Type1Spec): Uint8Array;
export function t1num(n: number): number[];       // same encoder as the interpreter test
export function t1cs(...parts: (number[] | number)[]): Uint8Array;
```

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-type1.ts`:

```ts
// Builds a Type 1 font program: clear header, eexec-encrypted private portion
// with /Subrs and /CharStrings, and the conventional 512-zero trailer. The
// encryption here is the inverse of src/type1.ts's, which is exactly why the
// real-font fixture in test/type1-real.test.ts exists as well.
const C1 = 52845, C2 = 22719;

export function t1num(n: number): number[] {
  if (n >= -107 && n <= 107) return [n + 139];
  if (n >= 108 && n <= 1131) { const v = n - 108; return [(v >> 8) + 247, v & 0xff]; }
  if (n <= -108 && n >= -1131) { const v = -n - 108; return [(v >> 8) + 251, v & 0xff]; }
  return [255, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
export const t1cs = (...parts: (number[] | number)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'number' ? [p] : p)));

function bytes(s: string): Uint8Array { return Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff); }
function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The inverse of type1.ts's `decrypt`, with `pad` leading plaintext bytes. */
function encrypt(plain: Uint8Array, r0: number, pad: number, padByte = 0x55): Uint8Array {
  const src = new Uint8Array(plain.length + pad);
  src.fill(padByte, 0, pad);
  src.set(plain, pad);
  let r = r0;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const cph = (src[i] ^ (r >> 8)) & 0xff;
    r = ((cph + r) * C1 + C2) & 0xffff;
    out[i] = cph;
  }
  return out;
}

const isHexByte = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

/** Encrypt the private portion, choosing a pad byte whose ciphertext does not
 *  open with four hex digits — that shape is how a reader tells a binary eexec
 *  section from a hex one, and a real font's random pad avoids it by luck. */
function encryptEexec(plain: Uint8Array): Uint8Array {
  for (let padByte = 0x55; padByte < 0x60; padByte++) {
    const out = encrypt(plain, 55665, 4, padByte);
    if (![0, 1, 2, 3].every((k) => isHexByte(out[k]))) return out;
  }
  throw new Error('build-type1: no pad byte yielded a non-hex-looking eexec prefix');
}

export interface Type1Spec {
  charstrings: Record<string, Uint8Array>;
  subrs?: Uint8Array[];
  encoding?: Record<number, string>;
  lenIV?: number;
  hexEexec?: boolean;
  pfb?: boolean;
  fontMatrix?: number[];
  rdToken?: 'RD' | '-|';
}

export function buildType1(spec: Type1Spec): Uint8Array {
  const lenIV = spec.lenIV ?? 4;
  const rd = spec.rdToken ?? 'RD';
  const nd = rd === 'RD' ? 'ND' : '|-';
  const np = rd === 'RD' ? 'NP' : '|';
  const fm = spec.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];

  const encLines = spec.encoding
    ? ['/Encoding 256 array', '0 1 255 {1 index exch /.notdef put} for',
       ...Object.entries(spec.encoding).map(([code, name]) => `dup ${code} /${name} put`),
       'readonly def']
    : ['/Encoding StandardEncoding def'];

  const clear = bytes([
    '%!PS-AdobeFont-1.0: TestFont 001.000',
    '/FontName /TestFont def',
    `/FontMatrix [${fm.join(' ')}] readonly def`,
    '/FontType 1 def',
    '/FontBBox {0 0 1000 1000} readonly def',
    ...encLines,
    'currentdict end',
    'currentfile eexec',
    '',
  ].join('\n'));

  // Private portion, plaintext. Binary payloads are spliced in after building
  // the surrounding text, so a length is never guessed.
  const parts: Uint8Array[] = [];
  const push = (s: string): void => { parts.push(bytes(s)); };
  push(`dup /Private 8 dict dup begin\n/lenIV ${lenIV} def\n`);

  const subrs = spec.subrs ?? [];
  if (subrs.length) {
    push(`/Subrs ${subrs.length} array\n`);
    subrs.forEach((cs, i) => {
      const enc = encrypt(cs, 4330, lenIV);
      push(`dup ${i} ${enc.length} ${rd} `);
      parts.push(enc);
      push(` ${np}\n`);
    });
    push('ND\n');
  }

  const names = Object.keys(spec.charstrings);
  push(`2 index /CharStrings ${names.length} dict dup begin\n`);
  for (const name of names) {
    const enc = encrypt(spec.charstrings[name], 4330, lenIV);
    push(`/${name} ${enc.length} ${rd} `);
    parts.push(enc);
    push(` ${nd}\n`);
  }
  push('end\nend\nmark currentfile closefile\n');

  let priv = encryptEexec(concat(parts));
  if (spec.hexEexec) {
    const hex = Array.from(priv, (b) => b.toString(16).padStart(2, '0')).join('');
    const wrapped = hex.replace(/(.{64})/g, '$1\n');
    priv = bytes(wrapped.endsWith('\n') ? wrapped : `${wrapped}\n`);
  }

  const trailer = bytes(`${'0'.repeat(64)}\n`.repeat(8) + 'cleartomark\n');
  if (!spec.pfb) return concat([clear, priv, trailer]);

  const seg = (type: number, data: Uint8Array): Uint8Array => {
    const h = new Uint8Array(6);
    h[0] = 0x80; h[1] = type;
    new DataView(h.buffer).setUint32(2, data.length, true);
    return concat([h, data]);
  };
  return concat([seg(1, clear), seg(2, priv), seg(1, trailer), Uint8Array.from([0x80, 3])]);
}

/** The three PDF /FontFile lengths for a program built above. */
export function fontFileLengths(program: Uint8Array): { l1: number; l2: number; l3: number } {
  const marker = bytes('eexec');
  let at = -1;
  outer: for (let i = 0; i + marker.length <= program.length; i++) {
    for (let k = 0; k < marker.length; k++) if (program[i + k] !== marker[k]) continue outer;
    at = i; break;
  }
  if (at < 0) throw new Error('build-type1: no eexec in program');
  let p = at + marker.length;
  while (p < program.length && (program[p] === 0x0d || program[p] === 0x0a || program[p] === 0x20 || program[p] === 0x09)) p++;
  const zeros = bytes('0'.repeat(64));
  let t = program.length;
  outer2: for (let i = p; i + zeros.length <= program.length; i++) {
    for (let k = 0; k < zeros.length; k++) if (program[i + k] !== zeros[k]) continue outer2;
    t = i; break;
  }
  return { l1: p, l2: t - p, l3: program.length - t };
}
```

- [ ] **Step 2: Write the failing container test**

Create `test/type1.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Type1Font } from '../src/type1.js';
import { PdfParseError } from '../src/errors.js';
import { buildType1, t1num, t1cs, Type1Spec } from './helpers/build-type1.js';

/** A square from (0,0) to (`side`,`side`), left sidebearing 0, width 600. */
const square = (side: number): Uint8Array => t1cs(
  t1num(0), t1num(600), 13,
  t1num(0), t1num(0), 21,
  t1num(side), 6, t1num(side), 7, t1num(-side), 6,
  9, 14,
);

const base: Type1Spec = {
  charstrings: { '.notdef': t1cs(t1num(0), t1num(600), 13, 14), A: square(700), B: square(400) },
};

describe('Type1Font — container', () => {
  it('reads the charstrings, their names, and the glyph order', () => {
    const f = new Type1Font(buildType1(base));
    expect(f.numGlyphs).toBe(3);
    expect(f.glyphName(0)).toBe('.notdef');
    expect(f.gidForName('A')).toBe(1);
    expect(f.gidForName('B')).toBe(2);
    expect(f.gidForName('C')).toBeUndefined();
  });

  it('interprets a charstring through the eexec and charstring decryption', () => {
    const f = new Type1Font(buildType1(base));
    expect(f.glyphPath(f.gidForName('A')!)).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 700, y: 0 },
      { op: 'L', x: 700, y: 700 }, { op: 'L', x: 0, y: 700 }, { op: 'Z' },
    ]);
    expect(f.glyphWidth(f.gidForName('A')!)).toBe(600);
  });

  it('reads unitsPerEm from /FontMatrix', () => {
    expect(new Type1Font(buildType1(base)).unitsPerEm).toBe(1000);
    const half = buildType1({ ...base, fontMatrix: [0.0005, 0, 0, 0.0005, 0, 0] });
    expect(new Type1Font(half).unitsPerEm).toBe(2000);
  });

  it('honours a non-default /lenIV', () => {
    const f = new Type1Font(buildType1({ ...base, lenIV: 7 }));
    expect(f.glyphPath(f.gidForName('B')!)).toHaveLength(5);
  });

  it('reads a hex-encoded eexec section', () => {
    const f = new Type1Font(buildType1({ ...base, hexEexec: true }));
    expect(f.glyphPath(f.gidForName('A')!)[1]).toEqual({ op: 'L', x: 700, y: 0 });
  });

  it('strips PFB segment headers', () => {
    const f = new Type1Font(buildType1({ ...base, pfb: true }));
    expect(f.gidForName('A')).toBe(1);
    expect(f.glyphPath(1)).toHaveLength(5);
  });

  it('accepts the -| / |- / | spellings of RD / ND / NP', () => {
    const f = new Type1Font(buildType1({ ...base, rdToken: '-|', subrs: [t1cs(11)] }));
    expect(f.glyphPath(f.gidForName('A')!)).toHaveLength(5);
  });

  it('calls a subr by the index the font gives it', () => {
    const subrs: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) subrs[i] = t1cs(11);
    subrs[9] = t1cs(t1num(250), 6, 11);
    const f = new Type1Font(buildType1({
      subrs,
      charstrings: { '.notdef': t1cs(14), S: t1cs(t1num(0), t1num(600), 13, t1num(0), t1num(0), 21, t1num(9), 10, 14) },
    }));
    expect(f.glyphPath(f.gidForName('S')!)).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'L', x: 250, y: 0 }]);
  });

  it('reports the program’s own /Encoding when it has one', () => {
    const f = new Type1Font(buildType1({ ...base, encoding: { 65: 'A', 66: 'B' } }));
    const enc = f.builtinEncodingNames()!;
    expect(enc.get(65)).toBe('A');
    expect(enc.get(66)).toBe('B');
    expect(enc.get(67)).toBeUndefined();
  });

  it('reports no built-in encoding when the program says StandardEncoding', () => {
    // Not an empty map: "predefined" and "none" are different answers, and only
    // the caller knows that the predefined one is the Annex D table.
    expect(new Type1Font(buildType1(base)).builtinEncodingNames()).toBeUndefined();
  });

  it('resolves seac through StandardEncoding names', () => {
    const f = new Type1Font(buildType1({
      charstrings: {
        '.notdef': t1cs(14),
        A: t1cs(t1num(0), t1num(600), 13, t1num(0), t1num(0), 21, t1num(100), 6, 14),
        acute: t1cs(t1num(0), t1num(300), 13, t1num(0), t1num(0), 21, t1num(50), 7, 14),
        Aacute: t1cs(t1num(0), t1num(600), 13, t1num(0), t1num(20), t1num(400), t1num(65), t1num(194), 12, 6),
      },
    }));
    expect(f.glyphPath(f.gidForName('Aacute')!)).toEqual([
      { op: 'M', x: 0, y: 0 }, { op: 'L', x: 100, y: 0 },
      { op: 'M', x: 20, y: 400 }, { op: 'L', x: 20, y: 450 },
    ]);
  });

  it('throws PdfParseError on bytes that are not a Type 1 program', () => {
    expect(() => new Type1Font(Uint8Array.from([1, 2, 3, 4]))).toThrow(PdfParseError);
  });

  it('throws PdfParseError when the eexec section holds no /CharStrings', () => {
    const good = buildType1(base);
    const wrecked = good.slice();
    wrecked.fill(0, 1200, 1400);          // corrupt inside the encrypted portion
    expect(() => new Type1Font(wrecked)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run test/type1.test.ts`
Expected: FAIL — cannot resolve `../src/type1.js`.

- [ ] **Step 4: Write the container**

Create `src/type1.ts`:

```ts
import type { Path } from './pagerender.js';
import { PdfParseError } from './errors.js';
import { standardEncodingNames } from './encoding.js';
import { runType1Charstring, Type1Env, Type1Glyph } from './type1charstring.js';

const C1 = 52845, C2 = 22719;
const EEXEC_R = 55665, CHARSTRING_R = 4330;

/**
 * A parsed Type 1 font program — the outline source for `/FontFile`.
 *
 * Accepts the three shapes the same bytes arrive in: a bare PFA/PFB file, a PFB
 * with `0x80` segment headers, and a PDF `/FontFile` stream body. The stream
 * dict's `/Length1`/`/Length2`/`/Length3` are not needed and not consulted:
 * this finds the clear/encrypted boundary itself, so a document that misstates
 * them still reads.
 *
 * Glyph ids are this parser's own numbering — order of appearance in
 * `/CharStrings`. Type 1 has no glyph-id space; the format is name-keyed
 * throughout, which is why {@link gidForName} rather than a cmap is the route in.
 */
export class Type1Font {
  readonly unitsPerEm: number;
  readonly numGlyphs: number;

  private readonly names: string[] = [];
  private readonly byName = new Map<string, Uint8Array>();
  private readonly nameToGid = new Map<string, number>();
  private readonly subrs: Uint8Array[] = [];
  private readonly encoding?: Map<number, string>;
  private readonly cache = new Map<number, Type1Glyph>();

  constructor(input: Uint8Array) {
    const bytes = stripPfb(input);
    const at = indexOfAscii(bytes, 'eexec');
    if (at < 0) throw new PdfParseError('Type1: no eexec section');

    let p = at + 5;
    while (p < bytes.length && isWhite(bytes[p])) p++;
    const cipher = looksHex(bytes, p) ? hexDecode(bytes, p) : bytes.subarray(p);
    const priv = decrypt(cipher, EEXEC_R, 4);

    const lenIV = readIntAfter(priv, '/lenIV') ?? 4;
    this.readSubrs(priv, lenIV);
    this.readCharStrings(priv, lenIV);
    if (this.names.length === 0) throw new PdfParseError('Type1: no /CharStrings');

    this.numGlyphs = this.names.length;
    const clear = bytes.subarray(0, at);
    this.unitsPerEm = readFontMatrixUpm(clear);
    this.encoding = readBuiltinEncoding(clear);
  }

  glyphName(gid: number): string | undefined { return this.names[gid]; }
  gidForName(name: string): number | undefined { return this.nameToGid.get(name); }

  /** The program's own `/Encoding`, `code -> glyph name`, or `undefined` when it
   *  declares the predefined `StandardEncoding` — which embeds no array, so the
   *  caller decides what "predefined" means rather than being handed a guess.
   *
   *  Deliberately not named `builtinEncoding`: `CffFont.builtinEncoding()`
   *  returns `code -> gid`, and two same-named methods returning different
   *  `Map<number, …>` values is a mix-up nothing would catch. */
  builtinEncodingNames(): Map<number, string> | undefined { return this.encoding; }

  glyphPath(gid: number): Path { return this.run(gid)?.path ?? []; }

  /** The advance from `hsbw`/`sbw`, in font units. Not yet consumed by the
   *  render path — PDF `/Widths` drives advances — but read by the AFM
   *  cross-check, and by `imxw.4` when extraction learns Type 1 metrics. */
  glyphWidth(gid: number): number { return this.run(gid)?.width ?? 0; }

  private run(gid: number): Type1Glyph | undefined {
    if (gid < 0 || gid >= this.names.length) return undefined;
    const hit = this.cache.get(gid);
    if (hit) return hit;
    const cs = this.byName.get(this.names[gid]);
    if (!cs) return undefined;
    const env: Type1Env = {
      subrs: this.subrs,
      seacGlyph: (code) => {
        const n = standardEncodingNames[code & 0xff];
        return n ? this.byName.get(n) : undefined;
      },
    };
    const g = runType1Charstring(cs, env);
    this.cache.set(gid, g);
    return g;
  }

  private readSubrs(priv: Uint8Array, lenIV: number): void {
    let p = indexOfAscii(priv, '/Subrs');
    if (p < 0) return;
    p += 6;
    const end = priv.length;
    while (p < end) {
      const dup = indexOfAscii(priv, 'dup ', p);
      if (dup < 0) break;
      // Stop before a `dup` belonging to a later dictionary.
      const csAt = indexOfAscii(priv, '/CharStrings');
      if (csAt >= 0 && dup > csAt) break;
      let q = dup + 4;
      const idx = readInt(priv, q); if (!idx) break; q = idx.end;
      const len = readInt(priv, q); if (!len) break; q = len.end;
      const data = afterBinaryToken(priv, q, len.value);
      if (!data) break;
      this.subrs[idx.value] = decrypt(data.bytes, CHARSTRING_R, lenIV);
      p = data.end;
    }
  }

  private readCharStrings(priv: Uint8Array, lenIV: number): void {
    let p = indexOfAscii(priv, '/CharStrings');
    if (p < 0) return;
    p = indexOfAscii(priv, 'begin', p);
    if (p < 0) return;
    p += 5;
    while (p < priv.length) {
      while (p < priv.length && priv[p] !== 0x2f) {                 // '/'
        if (matchesAscii(priv, p, 'end')) return;
        p++;
      }
      if (p >= priv.length) return;
      const name = readName(priv, p + 1);
      let q = name.end;
      const len = readInt(priv, q);
      if (!len) { p = q; continue; }
      const data = afterBinaryToken(priv, len.end, len.value);
      if (!data) return;
      if (!this.nameToGid.has(name.value)) {
        this.nameToGid.set(name.value, this.names.length);
        this.names.push(name.value);
        this.byName.set(name.value, decrypt(data.bytes, CHARSTRING_R, lenIV));
      }
      p = data.end;
    }
  }
}

// ---------- byte helpers ----------

const isWhite = (b: number): boolean => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x00 || b === 0x0c;

function decrypt(data: Uint8Array, r0: number, skip: number): Uint8Array {
  let r = r0;
  const out = new Uint8Array(Math.max(0, data.length - skip));
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const plain = (c ^ (r >> 8)) & 0xff;
    r = ((c + r) * C1 + C2) & 0xffff;
    if (i >= skip) out[i - skip] = plain;
  }
  return out;
}

/** Drop `0x80`-tagged PFB segment headers, concatenating the payloads. */
function stripPfb(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 6 || bytes[0] !== 0x80) return bytes;
  const parts: Uint8Array[] = [];
  let p = 0;
  while (p + 6 <= bytes.length && bytes[p] === 0x80) {
    const type = bytes[p + 1];
    if (type === 3) break;
    const len = bytes[p + 2] | (bytes[p + 3] << 8) | (bytes[p + 4] << 16) | (bytes[p + 5] << 24);
    if (len < 0 || p + 6 + len > bytes.length) break;
    parts.push(bytes.subarray(p + 6, p + 6 + len));
    p += 6 + len;
  }
  if (parts.length === 0) return bytes;
  const n = parts.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

const isHexDigit = (b: number): boolean =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);

/** The eexec section is hex when its first four bytes are all hex digits. That
 *  is the Type 1 spec's own test, and it works because a binary section's four
 *  random leading bytes are ~1/16^... unlikely to all be hex — encoders that
 *  write binary check this and re-roll. */
function looksHex(b: Uint8Array, p: number): boolean {
  let seen = 0;
  for (let i = p; i < b.length && seen < 4; i++) {
    if (isWhite(b[i])) continue;
    if (!isHexDigit(b[i])) return false;
    seen++;
  }
  return seen === 4;
}

function hexDecode(b: Uint8Array, p: number): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = p; i < b.length; i++) {
    const c = b[i];
    if (isWhite(c)) continue;
    if (!isHexDigit(c)) break;
    const v = c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57;
    if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
  }
  return Uint8Array.from(out);
}

function matchesAscii(b: Uint8Array, at: number, s: string): boolean {
  if (at + s.length > b.length) return false;
  for (let k = 0; k < s.length; k++) if (b[at + k] !== s.charCodeAt(k)) return false;
  return true;
}

function indexOfAscii(b: Uint8Array, s: string, from = 0): number {
  for (let i = Math.max(0, from); i + s.length <= b.length; i++) if (matchesAscii(b, i, s)) return i;
  return -1;
}

function readInt(b: Uint8Array, at: number): { value: number; end: number } | undefined {
  let p = at;
  while (p < b.length && isWhite(b[p])) p++;
  const start = p;
  if (p < b.length && (b[p] === 0x2d || b[p] === 0x2b)) p++;
  while (p < b.length && b[p] >= 0x30 && b[p] <= 0x39) p++;
  if (p === start) return undefined;
  return { value: parseInt(asciiOf(b, start, p), 10), end: p };
}

function readIntAfter(b: Uint8Array, key: string): number | undefined {
  const at = indexOfAscii(b, key);
  return at < 0 ? undefined : readInt(b, at + key.length)?.value;
}

function readName(b: Uint8Array, at: number): { value: string; end: number } {
  let p = at;
  while (p < b.length && !isWhite(b[p]) && b[p] !== 0x2f && b[p] !== 0x28 && b[p] !== 0x7b) p++;
  return { value: asciiOf(b, at, p), end: p };
}

function asciiOf(b: Uint8Array, from: number, to: number): string {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]);
  return s;
}

/**
 * Skip the `RD` token (or `-|`, or whatever the font named the procedure) and
 * the single space that follows it, then take `len` bytes.
 *
 * The token is read as "one whitespace-delimited token", not matched against a
 * list: it is a procedure the font defines in its own Private dict and may be
 * called anything. Exactly one blank separates it from the binary — a second
 * one is data.
 */
function afterBinaryToken(b: Uint8Array, at: number, len: number): { bytes: Uint8Array; end: number } | undefined {
  let p = at;
  while (p < b.length && isWhite(b[p])) p++;
  while (p < b.length && !isWhite(b[p])) p++;          // the RD-ish token
  p++;                                                  // exactly one blank
  if (len < 0 || p + len > b.length) return undefined;
  return { bytes: b.subarray(p, p + len), end: p + len };
}

function readFontMatrixUpm(clear: Uint8Array): number {
  const at = indexOfAscii(clear, '/FontMatrix');
  if (at < 0) return 1000;
  const open = clear.indexOf(0x5b, at);                 // '['
  if (open < 0) return 1000;
  const close = clear.indexOf(0x5d, open);
  if (close < 0) return 1000;
  const first = parseFloat(asciiOf(clear, open + 1, close).trim().split(/\s+/)[0]);
  return Number.isFinite(first) && first !== 0 ? Math.round(1 / first) : 1000;
}

/** `dup <code> /<name> put` entries from the clear portion, or `undefined` when
 *  the program declares the predefined StandardEncoding. */
function readBuiltinEncoding(clear: Uint8Array): Map<number, string> | undefined {
  const at = indexOfAscii(clear, '/Encoding');
  if (at < 0) return undefined;
  const head = asciiOf(clear, at, Math.min(clear.length, at + 64));
  if (/^\/Encoding\s+StandardEncoding/.test(head)) return undefined;
  const map = new Map<number, string>();
  let p = at;
  for (;;) {
    const dup = indexOfAscii(clear, 'dup ', p);
    if (dup < 0) break;
    const code = readInt(clear, dup + 4);
    if (!code) { p = dup + 4; continue; }
    let q = code.end;
    while (q < clear.length && isWhite(clear[q])) q++;
    if (clear[q] !== 0x2f) { p = code.end; continue; }
    const name = readName(clear, q + 1);
    map.set(code.value & 0xff, name.value);
    p = name.end;
  }
  return map.size ? map : undefined;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/type1.test.ts test/type1-charstring.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/type1.ts test/helpers/build-type1.ts test/type1.test.ts
git commit -m "$(cat <<'EOF'
feat(font): Type 1 program container — eexec, /Subrs, /CharStrings (imxw.2)

Finds the clear/encrypted boundary itself rather than trusting the stream
dict's /Length1 /Length2 /Length3, so a document that misstates them still
reads. Handles PFB segment headers and a hex-encoded eexec section, and reads
the RD/ND/NP tokens as tokens rather than literals — they are procedures the
font names in its own Private dict.

builtinEncodingNames() is deliberately not called builtinEncoding: CffFont's
method of that name returns code -> gid, and both are Map<number, ...>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `/Encoding` precedence to a glyph name

**Files:**
- Modify: `src/font.ts` — `SimpleEncoding` (around line 586) and `resolveSimpleEncoding` (around line 610)
- Test: `test/font-glyphnames.test.ts` (create)

**Interfaces:**
- Consumes: `baseEncodingNamesByName`, `standardEncodingNames` from `./encoding.js`.
- Produces:
```ts
export interface SimpleEncoding {
  base: (string | undefined)[];
  unicode: (string | undefined)[];
  names: (string | undefined)[];
  /** code -> glyph name from a *named* base encoding; undefined when the font
   *  names none we have a table for. */
  baseNames?: (string | undefined)[];
  implicit: boolean;
}
export function glyphNameResolver(
  enc: SimpleEncoding,
  builtin: Map<number, string> | undefined,
): (code: number) => string | undefined;
```

- [ ] **Step 1: Write the failing test**

Create `test/font-glyphnames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveSimpleEncoding, glyphNameResolver } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

const R = (o: PdfObject | undefined): PdfObject | undefined => o ?? undefined;
const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('code -> glyph name precedence', () => {
  const builtin = new Map<number, string>([[0x41, 'Aprogram'], [0x42, 'Bprogram'], [0x43, 'Cprogram']]);

  it('prefers a /Differences name over everything', () => {
    const fd = dict([['Encoding', dict([
      ['BaseEncoding', name('WinAnsiEncoding')],
      ['Differences', [0x41, name('Adiff')]],
    ])]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(glyphNameResolver(enc, builtin)(0x41)).toBe('Adiff');
  });

  it('falls to the named base encoding before the program’s own', () => {
    const fd = dict([['Encoding', name('WinAnsiEncoding')]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(glyphNameResolver(enc, builtin)(0x42)).toBe('B');
    expect(glyphNameResolver(enc, builtin)(0xe9)).toBe('eacute');
  });

  it('uses the program’s own encoding when the font dict names none', () => {
    const enc = resolveSimpleEncoding(dict([]), R);
    expect(enc.implicit).toBe(true);
    expect(glyphNameResolver(enc, builtin)(0x43)).toBe('Cprogram');
  });

  it('falls to StandardEncoding when the program has no encoding either', () => {
    const enc = resolveSimpleEncoding(dict([]), R);
    expect(glyphNameResolver(enc, undefined)(0x41)).toBe('A');
    expect(glyphNameResolver(enc, undefined)(0x27)).toBe('quoteright');
  });

  it('does not invent a name for MacExpertEncoding', () => {
    // We have no MacExpert table. Falling through to the program is a real
    // answer; defaulting to WinAnsi's names would be a wrong one.
    const fd = dict([['Encoding', name('MacExpertEncoding')]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(enc.baseNames).toBeUndefined();
    expect(glyphNameResolver(enc, builtin)(0x41)).toBe('Aprogram');
  });

  it('leaves unicode and names untouched', () => {
    const fd = dict([['Encoding', dict([['Differences', [0x41, name('uni25A1')]]])]]);
    const enc = resolveSimpleEncoding(fd, R);
    expect(enc.names[0x41]).toBe('uni25A1');
    expect(enc.unicode[0x41]).toBe('□');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run test/font-glyphnames.test.ts`
Expected: FAIL — `glyphNameResolver` is not exported from `../src/font.js`.

- [ ] **Step 3: Extend `font.ts`**

In the import from `./encoding.js` at the top of `src/font.ts`, add
`baseEncodingNamesByName` and `standardEncodingNames`.

Add to the `SimpleEncoding` interface, after `names`:

```ts
  /** code -> glyph name from the base encoding the font *named*, when we have a
   *  table for it. Undefined when the font named none, named one we have no
   *  table for, or carries no `/Encoding` at all — in each of those cases the
   *  font program's own encoding is the next authority, and substituting a
   *  default here would silently outrank it. */
  baseNames?: (string | undefined)[];
```

In `resolveSimpleEncoding`, record the named base alongside the existing `base`:

```ts
  const enc = resolve(dict.get('Encoding'));
  const implicit = !isName(enc) && !isDict(enc);
  let base = winAnsi.slice();
  let baseNames: (string | undefined)[] | undefined;
  let differences: PdfObject[] | undefined;

  if (isName(enc)) {
    base = baseEncodingByName(enc.name).slice();
    baseNames = baseEncodingNamesByName(enc.name);
  } else if (isDict(enc)) {
    const b = resolve(enc.get('BaseEncoding'));
    base = baseEncodingByName(isName(b) ? b.name : undefined).slice();
    baseNames = baseEncodingNamesByName(isName(b) ? b.name : undefined);
    const diffs = resolve(enc.get('Differences'));
    if (isArray(diffs)) differences = diffs;
  }
```

and return `{ base, unicode, names, baseNames, implicit }`.

Append the resolver:

```ts
/**
 * Resolve a character code to a glyph name, for a font whose glyph programs are
 * name-keyed — a Type 1 `/FontFile` or a name-keyed CFF charset.
 *
 * The order is 32000-1 9.6.6.2: `/Differences`, then the base encoding the font
 * named, then the font program's own encoding, then StandardEncoding. Note that
 * the program's encoding sits *below* an explicitly named base encoding but
 * *above* the default — a font dict with no `/Encoding` is exactly the case
 * where the program governs, which {@link SimpleEncoding.implicit} records.
 */
export function glyphNameResolver(
  enc: SimpleEncoding,
  builtin: Map<number, string> | undefined,
): (code: number) => string | undefined {
  return (code) => {
    const c = code & 0xff;
    return enc.names[c] ?? enc.baseNames?.[c] ?? builtin?.get(c) ?? standardEncodingNames[c];
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/font-glyphnames.test.ts test/font.test.ts && npm run typecheck`
Expected: PASS. `test/font.test.ts` must stay green — `base`, `unicode`, `names`
and `implicit` are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/font.ts test/font-glyphnames.test.ts
git commit -m "$(cat <<'EOF'
feat(font): resolve a character code to a glyph name (imxw.2)

32000-1 9.6.6.2 order: /Differences, the named base encoding, the font
program's own encoding, StandardEncoding. baseNames is left undefined for an
encoding we have no table for (MacExpert) so the program's own encoding stays
the next authority rather than being outranked by a default.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire `/FontFile` into the render path

**Files:**
- Modify: `src/glyphoutline.ts:67-93` (`OutlineSource`, `glyphPolys`)
- Modify: `src/raster.ts:579-584` (`GlyphSource`), `:597-640` (`buildGlyphSource`), `:642-661` (`gidForCode`), `:686-690` (`eachGlyph`'s guard)
- Test: `test/type1.test.ts` (extend with a render section)

**Interfaces:**
- Consumes: `Type1Font` (Task 3), `glyphNameResolver` (Task 4).
- Produces:
```ts
// glyphoutline.ts
export interface CharstringProgram { readonly unitsPerEm: number; glyphPath(gid: number): Path; }
export interface OutlineSource { sfnt?: SfntFont; cff?: CffFont; type1?: Type1Font; }
// raster.ts
export interface GlyphSource {
  sfnt?: SfntFont; cff?: CffFont; type1?: Type1Font;
  isType0: boolean; cidToGid?: Uint8Array;
  nameForCode?: (code: number) => string | undefined;
}
```

- [ ] **Step 1: Write the PDF-embedding helper**

`test/helpers/build-pdf.ts`'s `buildClassicPdf` builds its body by string
concatenation, which cannot carry the program's binary bytes. This builder is
byte-based for that reason.

Create `test/helpers/build-type1-pdf.ts`:

```ts
// A one-page PDF whose only font is an embedded Type 1 program under /FontFile.
// Byte-based rather than string-based: the program is binary, so the xref
// offsets must be counted in bytes and the stream written verbatim.
import { fontFileLengths } from './build-type1.js';

const enc = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface Type1PdfOptions {
  text: string;
  size: number;
  /** A base encoding name for the font dict's /Encoding, e.g. 'WinAnsiEncoding'.
   *  Omitted => no /Encoding, so the program's own encoding governs. */
  encoding?: string;
  /** [code, glyphName] pairs for an /Encoding /Differences array. */
  differences?: [number, string][];
}

export function buildType1Pdf(program: Uint8Array, opts: Type1PdfOptions): Uint8Array {
  const { l1, l2, l3 } = fontFileLengths(program);
  const content = `BT /F1 ${opts.size} Tf 10 20 Td (${opts.text}) Tj ET`;

  let encEntry = '';
  if (opts.differences) {
    const items = opts.differences.map(([c, n]) => `${c} /${n}`).join(' ');
    const be = opts.encoding ? ` /BaseEncoding /${opts.encoding}` : '';
    encEntry = ` /Encoding << /Type /Encoding${be} /Differences [${items}] >>`;
  } else if (opts.encoding) {
    encEntry = ` /Encoding /${opts.encoding}`;
  }

  // 1 Catalog, 2 Pages, 3 Page, 4 Font, 5 Contents, 6 FontDescriptor, 7 FontFile
  const objs: Uint8Array[] = [];
  objs[1] = enc('<< /Type /Catalog /Pages 2 0 R >>');
  objs[2] = enc('<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 240 100] >>');
  objs[3] = enc('<< /Type /Page /Parent 2 0 R '
    + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  objs[4] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /TestFont'
    + `${encEntry} /FirstChar 65 /LastChar 90 /Widths [${Array(26).fill(1000).join(' ')}] `
    + '/FontDescriptor 6 0 R >>');
  objs[5] = enc(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs[6] = enc('<< /Type /FontDescriptor /FontName /TestFont /Flags 4 '
    + '/FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 1000 /Descent 0 '
    + '/CapHeight 1000 /StemV 80 /FontFile 7 0 R >>');
  objs[7] = concat([
    enc(`<< /Length ${program.length} /Length1 ${l1} /Length2 ${l2} /Length3 ${l3} >>\nstream\n`),
    program,
    enc('\nendstream'),
  ]);

  const parts: Uint8Array[] = [enc('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')];
  let at = parts[0].length;
  const offsets: number[] = new Array(objs.length).fill(0);
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = at;
    const head = enc(`${n} 0 obj\n`);
    const tail = enc('\nendobj\n');
    parts.push(head, objs[n], tail);
    at += head.length + objs[n].length + tail.length;
  }
  let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  parts.push(enc(xref));
  parts.push(enc(`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));
  return concat(parts);
}
```

- [ ] **Step 2: Write the failing render test**

Append to `test/type1.test.ts` (adding these imports at the top of the file):

```ts
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';

/** Fraction of pixels that are substantially darker than the white page. */
function inkFraction(png: Uint8Array): number {
  const img = decodePng(png);
  let ink = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b] = img.at(x, y);
      if (r < 128 && g < 128 && b < 128) ink++;
    }
  }
  return ink / (img.width * img.height);
}

describe('Type 1 /FontFile in the render path', () => {
  // A glyph nothing in Helvetica resembles: a solid full-em block. Rendered
  // from the embedded program it floods its em square; rendered from the
  // Standard-14 substitute, 'A' is a thin outline triangle covering a fraction
  // of it. The two are separated by an order of magnitude, not by a threshold
  // that needs tuning.
  const block = t1cs(
    t1num(0), t1num(1000), 13,
    t1num(0), t1num(0), 21,
    t1num(1000), 6, t1num(1000), 7, t1num(-1000), 6,
    9, 14,
  );
  const program = buildType1({
    charstrings: { '.notdef': t1cs(t1num(0), t1num(1000), 13, 14), A: block },
    encoding: { 0x41: 'A' },
  });

  it('renders outlines from the embedded program, not the substitute face', async () => {
    const doc = await Document.Open(buildType1Pdf(program, { text: 'AAAA', size: 48 }));
    const png = await doc.Pages[0].ToImage({ scale: 1 });
    // Four 48pt solid blocks on a 240x100 page: ~4 * 48*48 / 24000 ≈ 0.38.
    expect(inkFraction(png)).toBeGreaterThan(0.25);
  });

  it('reaches the program through /Differences when the font dict names a glyph', async () => {
    const named = buildType1({
      charstrings: { '.notdef': t1cs(t1num(0), t1num(1000), 13, 14), blockglyph: block },
    });
    const doc = await Document.Open(buildType1Pdf(named, {
      text: 'AAAA', size: 48, differences: [[0x41, 'blockglyph']],
    }));
    expect(inkFraction(await doc.Pages[0].ToImage({ scale: 1 }))).toBeGreaterThan(0.25);
  });

  it('falls back to the substitute face when the program is unreadable', async () => {
    const wrecked = program.slice();
    wrecked.fill(0x20, 900, Math.min(1600, wrecked.length));
    const doc = await Document.Open(buildType1Pdf(wrecked, { text: 'AAAA', size: 48 }));
    const ink = inkFraction(await doc.Pages[0].ToImage({ scale: 1 }));
    expect(ink).toBeGreaterThan(0);        // still draws: the substitute took over
    expect(ink).toBeLessThan(0.25);        // but not solid blocks
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npx vitest run test/type1.test.ts -t 'render path'`
Expected: FAIL — the page renders the Helvetica substitute, so `darkFraction`
is below 0.15.

- [ ] **Step 4: Unify the two outline programs**

In `src/glyphoutline.ts`, add the import `import { Type1Font } from './type1.js';`
and replace the `OutlineSource` block and the `glyphPolys` CFF branch:

```ts
/** What `glyphPolys` needs from a charstring-based font program. `CffFont` and
 *  `Type1Font` both satisfy it structurally, so the two share one branch below
 *  rather than two copies of the same four lines. */
export interface CharstringProgram {
  readonly unitsPerEm: number;
  glyphPath(gid: number): Path;
}

/** Where a glyph's outline comes from. A charstring program wins over `sfnt`:
 *  an OpenType-CFF face has an sfnt wrapper whose glyf table is absent. */
export interface OutlineSource {
  sfnt?: SfntFont;
  cff?: CffFont;
  type1?: Type1Font;
}
```

and in `glyphPolys`:

```ts
  const prog: CharstringProgram | undefined = src.cff ?? src.type1;
  if (prog) {
    const path = prog.glyphPath(gid);
    if (path.length === 0) return [];
    const upm = prog.unitsPerEm || 1000;
    return flattenPath(path, mul([1 / upm, 0, 0, 1 / upm, 0, 0], m), tol);
  }
```

`Path` must be imported into `glyphoutline.ts` from `./pagerender.js` for the
interface — add it to the existing type imports.

- [ ] **Step 5: Load `/FontFile` and add the name route**

In `src/raster.ts`, add `import { Type1Font } from './type1.js';` and
`glyphNameResolver, resolveSimpleEncoding` to the existing `./font.js` import.

Extend `GlyphSource`:

```ts
export interface GlyphSource {
  sfnt?: SfntFont;             // parsed sfnt: glyf outlines and/or a cmap for gid lookup
  cff?: CffFont;               // CFF outlines (FontFile3 / OpenType-CFF)
  type1?: Type1Font;           // Type 1 outlines (/FontFile)
  isType0: boolean;            // composite font: code = CID
  cidToGid?: Uint8Array;       // /CIDToGIDMap stream (2 bytes/CID); undefined → identity
  /** code -> glyph name, for the name-keyed programs. Undefined for a composite
   *  font and for a face resolved through a cmap. */
  nameForCode?: (code: number) => string | undefined;
}
```

In `buildGlyphSource`, after the `/FontFile3` block and before the Standard-14
fallback:

```ts
  let type1: Type1Font | undefined;
  if (!cff && !sfnt) {                             // Type 1 via /FontFile
    const ff1 = isDict(fd) ? doc.resolve(fd.get('FontFile')) : undefined;
    if (isStream(ff1)) {
      // A malformed program is a broken font, not a broken document: fall
      // through to the substitute face exactly as a bad CFF does.
      try { type1 = new Type1Font(inflate(ff1)); } catch { type1 = undefined; }
    }
  }
```

Change the substitute guard to `if (!sfnt && !cff && !type1 && !isType0)`, and
build the resolver before returning:

```ts
  // The name route, for the two name-keyed program kinds. A face with a usable
  // cmap keeps the cmap: it is the font's own answer and is already proven.
  let nameForCode: ((code: number) => string | undefined) | undefined;
  if (!isType0 && (type1 || (cff && !sfnt?.cmap.size))) {
    const builtin = type1 ? type1.builtinEncodingNames() : undefined;
    nameForCode = glyphNameResolver(resolveSimpleEncoding(fontDict, (o) => doc.resolve(o)), builtin);
  }
  return { sfnt, cff, type1, isType0, cidToGid, nameForCode };
```

In `gidForCode`, insert the name route at the head of the simple-font path:

```ts
  if (src.nameForCode) {
    const n = src.nameForCode(code);
    if (n !== undefined) {
      if (src.type1) {
        // No cmap and no substitute: a name the program does not define has no
        // glyph, and the placeholder box is the honest result.
        return src.type1.gidForName(n);
      }
      const names = src.cff?.charsetNames() ?? [];
      const gid = names.indexOf(n);
      if (gid > 0) return gid;
      const builtin = src.cff?.builtinEncoding();
      const bg = builtin?.get(code);
      if (bg !== undefined) return bg;
      // A charset we could read but that does not name this glyph: no answer.
      if (names.length) return undefined;
    } else if (src.type1) return undefined;
  }
```

leaving the existing cmap block and the trailing `return code;` untouched — that
last line now only runs for a CFF whose charset is empty or unreadable, which is
where "assume gid = code" was always the only option.

Finally, extend `eachGlyph`'s guard at `src/raster.ts:686` so a Type 1 source
reaches the outline path:

```ts
    if (src?.cff || src?.sfnt || src?.type1) {
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/type1.test.ts test/raster.test.ts test/cff.test.ts test/glyphoutline.test.ts && npm run typecheck`
Expected: PASS. Then the full suite: `npm test` — the name route changes
`gidForCode` for bare-CFF simple fonts, so any existing test that relied on
`gid = code` there will surface here. If one does, the *test* was pinning the
guess; verify against the font's charset before changing either side.

- [ ] **Step 7: Commit**

```bash
git add src/glyphoutline.ts src/raster.ts test/type1.test.ts test/helpers/build-type1-pdf.ts
git commit -m "$(cat <<'EOF'
feat(render): outline Type 1 /FontFile glyphs in ToImage (imxw.2)

buildGlyphSource loaded /FontFile2 and /FontFile3 only, so an embedded Type 1
program fell through to the Standard-14 substitute and the page rendered with
the wrong shapes — silently, since /Widths still drove the advances.

The name route this needs also closes a latent guess on a path unrelated to
Type 1: a simple font with a bare /FontFile3 has no cmap, and gidForCode
answered "assume gid = code". It now goes through the CFF charset, with the
guess left only for a charset we could not read at all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Real-font fixture and its two oracles

**Files:**
- Create: `test/fixtures/fonts/NimbusSans-Regular.t1` (fetched)
- Create: `test/fixtures/fonts/NimbusSans-Regular.afm` (fetched)
- Modify: `test/fixtures/fonts/PROVENANCE.md`
- Test: `test/type1-real.test.ts` (create)

**Interfaces:**
- Consumes: `Type1Font` (Task 3), `CffFont` and `parseSfnt` (existing).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Fetch the fixtures and verify their hashes**

```bash
cd test/fixtures/fonts
curl -sL -o NimbusSans-Regular.t1 \
  https://raw.githubusercontent.com/ArtifexSoftware/urw-base35-fonts/master/fonts/NimbusSans-Regular.t1
curl -sL -o NimbusSans-Regular.afm \
  https://raw.githubusercontent.com/ArtifexSoftware/urw-base35-fonts/master/fonts/NimbusSans-Regular.afm
sha256sum NimbusSans-Regular.t1 NimbusSans-Regular.afm
```

Expected, exactly:
```
779a9c820bbe8b470d36e77bcf949eef7bf1b889184274ba0f51da4c8c883cfa  NimbusSans-Regular.t1
ed4ead49b4d090c80c1d4a8d771879153a41af262d331168dd2635508634cfa1  NimbusSans-Regular.afm
```
Sizes: 104,001 and 116,120 bytes. **If a hash differs, stop** — upstream moved,
and the assertions below were measured against these bytes.

- [ ] **Step 2: Write the oracle test**

Create `test/type1-real.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Type1Font } from '../src/type1.js';
import { CffFont } from '../src/cff.js';
import { parseSfnt } from '../src/sfnt.js';

const DIR = new URL('./fixtures/fonts/', import.meta.url);
const t1 = new Type1Font(new Uint8Array(readFileSync(new URL('NimbusSans-Regular.t1', DIR))));
const afm = readFileSync(new URL('NimbusSans-Regular.afm', DIR), 'latin1');

/** glyph name -> { wx, llx } from the AFM's CharMetrics lines. */
function afmMetrics(text: string): Map<string, { wx: number; llx: number }> {
  const out = new Map<string, { wx: number; llx: number }>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('C ')) continue;
    const wx = /WX\s+(-?\d+)/.exec(line);
    const n = /N\s+([^\s;]+)/.exec(line);
    const bb = /B\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/.exec(line);
    if (wx && n && bb) out.set(n[1], { wx: +wx[1], llx: +bb[1] });
  }
  return out;
}
const metrics = afmMetrics(afm);

describe('NimbusSans-Regular.t1 — a Type 1 program we did not produce', () => {
  it('reads the whole CharStrings dictionary', () => {
    expect(t1.numGlyphs).toBe(metrics.size + 1);   // + .notdef, which the AFM omits
    expect(t1.unitsPerEm).toBe(1000);
    expect(t1.gidForName('A')).toBeGreaterThan(0);
  });

  // Oracle 1: the AFM. Nothing in type1.ts or type1charstring.ts reads it, so
  // an interpreter bug cannot corrupt both sides. This is the analogue of the
  // hmtx lsb cross-check that was the ONLY assertion to catch the CFF subr-bias
  // mutations (see PROVENANCE.md).
  it('every hsbw width equals the AFM advance', () => {
    const bad: string[] = [];
    for (const [name, m] of metrics) {
      const gid = t1.gidForName(name);
      if (gid === undefined) { bad.push(`${name}: absent`); continue; }
      const w = t1.glyphWidth(gid);
      if (w !== m.wx) bad.push(`${name}: hsbw ${w} != AFM ${m.wx}`);
    }
    expect(bad).toEqual([]);
  });

  it('no control point starts left of the AFM bounding box', () => {
    // A charstring's control points bound its curves, so the minimum control x
    // can never exceed the true left extremum. minX > llx is impossible; minX
    // below it is ordinary curve-hull slack.
    const violations: string[] = [];
    let withOutlines = 0;
    for (const [name, m] of metrics) {
      const gid = t1.gidForName(name);
      if (gid === undefined) continue;
      const path = t1.glyphPath(gid);
      if (path.length === 0) continue;
      withOutlines++;
      let minX = Infinity;
      for (const s of path) {
        if (s.op === 'Z') continue;
        minX = Math.min(minX, s.x);
        if (s.op === 'C') minX = Math.min(minX, s.x1, s.x2);
      }
      if (minX > m.llx + 1) violations.push(`${name}: minX ${minX} > llx ${m.llx}`);
    }
    expect(violations).toEqual([]);
    expect(withOutlines).toBeGreaterThan(600);     // non-vacuity
  });

  // Oracle 2: the same design read through cff.ts's Type 2 interpreter, which
  // shares no code with the Type 1 one. PROVENANCE.md warns that a differential
  // between two copies of one font validates only the round-trip — that applies
  // when both sides run the same interpreter, which is exactly what these two
  // do not.
  it('agrees with the OTF of the same face on every shared glyph', () => {
    const otf = parseSfnt(new Uint8Array(readFileSync(new URL('NimbusSans-Regular.otf', DIR))));
    const cff = new CffFont(otf.table('CFF ', false)!);
    const cffNames = cff.charsetNames();
    let compared = 0;
    const bad: string[] = [];
    for (let gid = 1; gid < cffNames.length; gid++) {
      const name = cffNames[gid];
      if (!name) continue;
      const t1gid = t1.gidForName(name);
      if (t1gid === undefined) continue;
      const a = bbox(t1.glyphPath(t1gid));
      const b = bbox(cff.glyphPath(gid));
      if (!a || !b) continue;
      compared++;
      for (const k of [0, 1, 2, 3] as const) {
        if (Math.abs(a[k] - b[k]) > 2) { bad.push(`${name}: ${a.join(',')} vs ${b.join(',')}`); break; }
      }
    }
    expect(compared).toBeGreaterThan(600);
    expect(bad).toEqual([]);
  });
});

function bbox(path: { op: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]):
  [number, number, number, number] | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of path) {
    if (s.op === 'Z') continue;
    for (const [px, py] of [[s.x, s.y], [s.x1, s.y1], [s.x2, s.y2]] as [number | undefined, number | undefined][]) {
      if (px === undefined || py === undefined) continue;
      x0 = Math.min(x0, px); y0 = Math.min(y0, py);
      x1 = Math.max(x1, px); y1 = Math.max(y1, py);
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : undefined;
}
```

- [ ] **Step 3: Run it**

Run: `npx vitest run test/type1-real.test.ts`
Expected: PASS.

If the bbox comparison fails on a handful of glyphs, first check whether they are
`seac` composites — URW's CFF conversion may have flattened them — and record
the exception explicitly in PROVENANCE.md rather than widening the tolerance.
Do **not** raise the `2`-unit tolerance to make it pass; that tolerance exists
for control-point re-fitting, not for a wrong outline.

- [ ] **Step 4: Prove the assertions load-bearing**

A fixture that passes first time is not evidence. Break each path and confirm
red, then revert:

| Mutation in `src/type1charstring.ts` | Must be caught by |
|---|---|
| `case 10`: use `idx + 107` (Type 2's bias) | outline/bbox case |
| `case 13`: drop `c.x = c.sbx` | bbox / minX case |
| `case 13`: set `c.width = s[0]`, `c.sbx = s[1]` (swap) | AFM width case |
| `255` operand read as 16.16 (`/ 65536`) | outline/bbox case |
| `othersubr` idx 0: emit one curve instead of two | outline/bbox case |
| `src/type1.ts`: skip `lenIV` bytes as 0 rather than `lenIV` | every case |

Record the results in PROVENANCE.md. If any mutation survives, the suite has a
hole — add the assertion that closes it before moving on.

- [ ] **Step 5: Write the PROVENANCE entry**

Append a `## NimbusSans-Regular.t1 + .afm` section to
`test/fixtures/fonts/PROVENANCE.md` in the style of the three existing entries.
It must state: the upstream URL and branch; the two hashes and byte counts from
Step 1; that the file is PFA-framed with a **binary** eexec section beginning at
offset 890 and the conventional 512-zero `cleartomark` trailer; the two oracles
and why each is independent of the interpreter; the mutation table from Step 4
with its results; what the fixture does **not** cover (hex eexec, PFB framing,
non-default `lenIV`, `/Differences` precedence — all synthetic-only); and the
licence note pointing at the existing `fonts/LICENSE-URW-AGPL.txt` grant and
`package.json`'s `files: ["dist"]`.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/fonts/NimbusSans-Regular.t1 test/fixtures/fonts/NimbusSans-Regular.afm \
        test/fixtures/fonts/PROVENANCE.md test/type1-real.test.ts
git commit -m "$(cat <<'EOF'
test(font): real Type 1 program with two external oracles (imxw.2)

NimbusSans-Regular.t1 from the same URW upstream the vendored .otf comes from.
Neither oracle runs through the Type 1 interpreter: the .afm publishes the
advance that hsbw also carries, and the .otf is the same design read through
cff.ts's independent Type 2 interpreter. Both mutations that once survived the
whole suite on the CFF side are caught here.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Documentation and close-out

**Files:**
- Modify: `CLAUDE.md` (the font/rendering section)
- Modify: `README.md:58` (the rendering paragraph)

- [ ] **Step 1: Record the invariants in CLAUDE.md**

Add `type1.ts` / `type1charstring.ts` to the architecture list beside the CFF
entry, and record the three invariants this work established:

```markdown
  **Invariant:** a Type 1 charstring is interpreted by `type1charstring.ts`, not
  by `cff.ts` with a flag. The two grammars share the operand encoding minus two
  cases and differ in every operator that clears the stack: `255` is a 32-bit
  integer here and 16.16 fixed there, `callsubr` is unbiased, `hlineto`/`vlineto`
  take one argument rather than alternating over the stack, and flex arrives
  through `callothersubr` rather than as an operator. A flag would fork inside
  nearly every branch.
  **Invariant:** `hsbw` moves the pen. It sets the current point to `(sbx, 0)`
  before any drawing, so an implementation that reads only its width leaves
  every glyph displaced by its own left sidebearing — uniformly enough across a
  font to read as a slightly wrong face rather than as a bug.
  **Invariant:** code → glyph *name* has one owner. `glyphNameResolver` in
  font.ts applies 32000-1 9.6.6.2 — `/Differences`, the named base encoding, the
  font program's own `/Encoding`, StandardEncoding — and both name-keyed program
  kinds go through it. `gidForCode` used to answer "assume gid = code" for a
  simple font with a bare `/FontFile3`, which is a guess that is right only
  under a charset nobody promised. `baseEncodingNamesByName` returns `undefined`
  rather than defaulting to WinAnsi, because the *next* authority is the
  program's own encoding and a default would silently outrank it.
```

- [ ] **Step 2: Update README.md**

In the `Rendering (page → PNG)` paragraph at line 58, extend the embedded-outline
clause from

> Text is rasterized from embedded outlines — TrueType (`glyf`, simple + composite) and CFF/OpenType-CFF (Type2 charstrings, incl. CID-keyed FDArray/FDSelect) —

to name Type 1 as well:

> Text is rasterized from embedded outlines — TrueType (`glyf`, simple + composite), CFF/OpenType-CFF (Type2 charstrings, incl. CID-keyed FDArray/FDSelect), and Type 1 (`/FontFile`: eexec decryption, `/Subrs`, flex and `seac` via `callothersubr`) —

and, in the same sentence's parenthetical about gid resolution, add that a
name-keyed program (Type 1, or CFF with no `cmap`) resolves through the glyph
name that `/Differences`, the named base encoding, or the program's own
`/Encoding` gives the code.

- [ ] **Step 3: Run both gates on the whole suite**

```bash
npm run typecheck
npm test
```
Expected: both clean. Do not proceed on a single failure.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs(font): Type 1 /FontFile invariants and README coverage (imxw.2)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-imxw.2
bd ready | grep imxw          # imxw.4 should now be unblocked
git pull --rebase
git push
git status                    # MUST show "up to date with origin"
```

---

## Verification checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` green, full suite
- [ ] Every mutation in Task 6 Step 4 confirmed to fail the suite, and reverted
- [ ] `test/fixtures/fonts/PROVENANCE.md` records the hashes, oracles, mutations and gaps
- [ ] `git status` shows the branch up to date with origin
- [ ] `aspose-pdf-foss-for-ts-imxw.2` closed; `imxw.4` unblocked
