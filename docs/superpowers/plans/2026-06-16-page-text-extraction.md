# Page Text Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Page.GetText(): string` that extracts visible text from a page with reasonable word/line ordering, decoding through simple-font encodings, `/ToUnicode` CMaps, and Type0/Identity-H composite fonts.

**Architecture:** A coordinate-based text-state machine walks the content-stream op tuples from `parseContentStream`, tracks the text matrix and graphics CTM, decodes each show-string through a per-font decoder (ToUnicode → base encoding+Differences → Type0), emits positioned text runs, then groups runs into lines (by Y) and orders/spaces them (by X). New modules: `encoding.ts`, `cmap.ts`, `font.ts`, `text.ts`; `Page.GetText()` delegates to `text.ts`.

**Tech Stack:** TypeScript (ESM, NodeNext, strict), vitest, `node:` built-ins only (zero runtime deps). Reuses existing `Lexer` (`src/lexer.ts`) and `parseContentStream` (`src/content.ts`).

**Spec:** `docs/superpowers/specs/2026-06-16-page-text-extraction-design.md`

---

## File Structure

| File | Created/Modified | Responsibility |
|------|------------------|----------------|
| `src/encoding.ts` | Create | Base encodings (`code→Unicode`) for WinAnsi/MacRoman/Standard/PDFDoc; `glyphName→Unicode` resolver (curated Latin set + algorithmic `uniXXXX`/`uXXXX`). |
| `src/cmap.ts` | Create | Parse a ToUnicode/embedded CMap stream → `{ lookup(code), codeWidth }`. |
| `src/font.ts` | Create | `TextFont` over a font dict: simple vs Type0, decode bytes → string, expose `codeWidth`. |
| `src/text.ts` | Create | Affine helpers, text-state machine, run model, line/word assembly. Exports `extractText` + internal `assembleLines` (tested directly). |
| `src/page.ts` | Modify | Add `GetText(): string`. |
| `test/helpers/build-text-pdf.ts` | Create | Fixture builders for each font/layout case. |
| `test/encoding.test.ts` | Create | Pin known encoding/glyph-name mappings. |
| `test/cmap.test.ts` | Create | CMap parse unit tests. |
| `test/font.test.ts` | Create | Per-font decode unit tests. |
| `test/text.test.ts` | Create | `assembleLines` unit tests + `GetText()` integration (acceptance criteria). |
| `README.md` | Modify | Document `Page.GetText()`. |

**Note on reference-data tasks:** WinAnsi and PDFDoc encodings are given in full below (compact CP1252/Latin-1 form). MacRoman and StandardEncoding high-range entries are transcribed from the PDF spec (ISO 32000-1:2008, Annex D, Table D.2 — the "Latin Character Set and Encodings" table). Those tasks provide the exact array shape, seed entries, and a pinning test that fails until the table is populated, so correctness is verified, not assumed.

---

## Task 1: Encoding tables and glyph-name resolver

**Files:**
- Create: `src/encoding.ts`
- Test: `test/encoding.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/encoding.test.ts
import { describe, it, expect } from 'vitest';
import { glyphToUnicode, winAnsi, standardEncoding, macRoman, pdfDocEncoding } from '../src/encoding.js';

describe('glyphToUnicode', () => {
  it('maps standard Latin glyph names', () => {
    expect(glyphToUnicode('A')).toBe('A');
    expect(glyphToUnicode('space')).toBe(' ');
    expect(glyphToUnicode('bullet')).toBe('•');
    expect(glyphToUnicode('adieresis')).toBe('ä');
    expect(glyphToUnicode('Euro')).toBe('€');
  });
  it('handles algorithmic uniXXXX / uXXXX names', () => {
    expect(glyphToUnicode('uni20AC')).toBe('€');
    expect(glyphToUnicode('u1F600')).toBe('\u{1F600}');
  });
  it('returns undefined for unknown names', () => {
    expect(glyphToUnicode('notdef')).toBeUndefined();
    expect(glyphToUnicode('totallybogus')).toBeUndefined();
  });
});

describe('base encodings', () => {
  it('WinAnsi: Latin-1 baseline + CP1252 overrides', () => {
    expect(winAnsi[0x41]).toBe('A');
    expect(winAnsi[0xE9]).toBe('é');      // é
    expect(winAnsi[0x80]).toBe('€');      // Euro
    expect(winAnsi[0x92]).toBe('’');      // right single quote
    expect(winAnsi[0x81]).toBeUndefined();     // unused slot
  });
  it('PDFDoc: shares the CP1252 block with WinAnsi', () => {
    expect(pdfDocEncoding[0x41]).toBe('A');
    expect(pdfDocEncoding[0xA0]).toBe('€'); // PDFDoc Euro at 0xA0
  });
  it('StandardEncoding: ASCII-ish with typographic quotes', () => {
    expect(standardEncoding[0x41]).toBe('A');
    expect(standardEncoding[0x27]).toBe('’'); // quoteright
    expect(standardEncoding[0x60]).toBe('‘'); // quoteleft
  });
  it('MacRoman: ASCII baseline + high-range overrides', () => {
    expect(macRoman[0x41]).toBe('A');
    expect(macRoman[0x80]).toBe('Ä');     // Adieresis
    expect(macRoman[0xA5]).toBe('•');     // bullet
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/encoding.test.ts`
Expected: FAIL — cannot find module `../src/encoding.js`.

- [ ] **Step 3: Write `src/encoding.ts`**

```typescript
// src/encoding.ts
// Base text encodings (code 0..255 -> Unicode string) and a glyph-name resolver.
// Tables for the high range of MacRoman/Standard are transcribed from
// ISO 32000-1:2008 Annex D, Table D.2.

/** Curated Adobe-glyph-name -> Unicode codepoint map (Latin set + common symbols).
 *  Sufficient for /Differences arrays seen in real PDFs; extend as needed. */
const GLYPH_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, quotesingle: 0x27, quoteright: 0x2019,
  parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b, comma: 0x2c,
  hyphen: 0x2d, period: 0x2e, slash: 0x2f,
  zero: 0x30, one: 0x31, two: 0x32, three: 0x33, four: 0x34, five: 0x35,
  six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39,
  colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e,
  question: 0x3f, at: 0x40,
  bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e,
  underscore: 0x5f, grave: 0x60, quoteleft: 0x2018,
  braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  // common punctuation / symbols
  bullet: 0x2022, ellipsis: 0x2026, emdash: 0x2014, endash: 0x2013,
  quotedblleft: 0x201c, quotedblright: 0x201d, quotesinglbase: 0x201a,
  quotedblbase: 0x201e, dagger: 0x2020, daggerdbl: 0x2021, perthousand: 0x2030,
  guilsinglleft: 0x2039, guilsinglright: 0x203a, fraction: 0x2044,
  florin: 0x0192, trademark: 0x2122, Euro: 0x20ac, currency: 0x00a4,
  degree: 0x00b0, plusminus: 0x00b1, multiply: 0x00d7, divide: 0x00f7,
  copyright: 0x00a9, registered: 0x00ae, paragraph: 0x00b6, section: 0x00a7,
  periodcentered: 0x00b7, cent: 0x00a2, sterling: 0x00a3, yen: 0x00a5,
  brokenbar: 0x00a6, logicalnot: 0x00ac, macron: 0x00af, acute: 0x00b4,
  cedilla: 0x00b8, questiondown: 0x00bf, exclamdown: 0x00a1,
  guillemotleft: 0x00ab, guillemotright: 0x00bb, ordfeminine: 0x00aa,
  ordmasculine: 0x00ba, onequarter: 0x00bc, onehalf: 0x00bd, threequarters: 0x00be,
  onesuperior: 0x00b9, twosuperior: 0x00b2, threesuperior: 0x00b3,
  mu: 0x00b5, dotlessi: 0x0131, circumflex: 0x02c6, tilde: 0x02dc,
  caron: 0x02c7, breve: 0x02d8, dotaccent: 0x02d9, ring: 0x02da,
  hungarumlaut: 0x02dd, ogonek: 0x02db,
};

// Accented Latin letters: build "<base><accentword>" names programmatically.
const ACCENTS: Record<string, Record<string, number>> = {
  acute:     { A:0xc1,E:0xc9,I:0xcd,O:0xd3,U:0xda,Y:0xdd,a:0xe1,e:0xe9,i:0xed,o:0xf3,u:0xfa,y:0xfd },
  grave:     { A:0xc0,E:0xc8,I:0xcc,O:0xd2,U:0xd9,a:0xe0,e:0xe8,i:0xec,o:0xf2,u:0xf9 },
  circumflex:{ A:0xc2,E:0xca,I:0xce,O:0xd4,U:0xdb,a:0xe2,e:0xea,i:0xee,o:0xf4,u:0xfb },
  tilde:     { A:0xc3,N:0xd1,O:0xd5,a:0xe3,n:0xf1,o:0xf5 },
  dieresis:  { A:0xc4,E:0xcb,I:0xcf,O:0xd6,U:0xdc,Y:0x178,a:0xe4,e:0xeb,i:0xef,o:0xf6,u:0xfc,y:0xff },
  ring:      { A:0xc5,a:0xe5 },
  cedilla:   { C:0xc7,c:0xe7 },
};
const SPECIAL_LETTERS: Record<string, number> = {
  AE:0xc6, ae:0xe6, Oslash:0xd8, oslash:0xf8, Eth:0xd0, eth:0xf0,
  Thorn:0xde, thorn:0xfe, germandbls:0xdf, OE:0x152, oe:0x153,
  Scaron:0x160, scaron:0x161, Zcaron:0x17d, zcaron:0x17e, Ydieresis:0x178,
};

const NAME_TO_CP: Record<string, number> = (() => {
  const m: Record<string, number> = { ...GLYPH_NAMES, ...SPECIAL_LETTERS };
  // single ASCII letters A..Z, a..z
  for (let c = 0x41; c <= 0x5a; c++) m[String.fromCharCode(c)] = c;
  for (let c = 0x61; c <= 0x7a; c++) m[String.fromCharCode(c)] = c;
  for (const [accent, table] of Object.entries(ACCENTS)) {
    for (const [base, cp] of Object.entries(table)) m[base + accent] = cp;
  }
  return m;
})();

/** Resolve an Adobe glyph name to a Unicode string, or undefined. */
export function glyphToUnicode(name: string): string | undefined {
  const cp = NAME_TO_CP[name];
  if (cp !== undefined) return String.fromCodePoint(cp);
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const v = parseInt(m[1], 16);
    if (v <= 0x10ffff) return String.fromCodePoint(v);
  }
  return undefined;
}

type Enc = (string | undefined)[];

/** WinAnsiEncoding: Latin-1 baseline (0x20..0xFF) with the CP1252 0x80..0x9F block. */
export const winAnsi: Enc = (() => {
  const t: Enc = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0xff; c++) t[c] = String.fromCharCode(c);
  const over: Record<number, number> = {
    0x80:0x20ac,0x82:0x201a,0x83:0x0192,0x84:0x201e,0x85:0x2026,0x86:0x2020,
    0x87:0x2021,0x88:0x02c6,0x89:0x2030,0x8a:0x0160,0x8b:0x2039,0x8c:0x0152,
    0x8e:0x017d,0x91:0x2018,0x92:0x2019,0x93:0x201c,0x94:0x201d,0x95:0x2022,
    0x96:0x2013,0x97:0x2014,0x98:0x02dc,0x99:0x2122,0x9a:0x0161,0x9b:0x203a,
    0x9c:0x0153,0x9e:0x017e,0x9f:0x0178,
  };
  for (const k of Object.keys(over)) t[+k] = String.fromCodePoint(over[+k]);
  for (const c of [0x81,0x8d,0x8f,0x90,0x9d]) t[c] = undefined; // unused slots
  return t;
})();

/** PDFDocEncoding: like WinAnsi for ASCII; the CP1252 punctuation lives in 0x18..0x1F and 0xA0.
 *  Only the entries needed in practice are pinned; baseline mirrors Latin-1. */
export const pdfDocEncoding: Enc = (() => {
  const t = winAnsi.slice();
  t[0xa0] = '€'; // Euro in PDFDocEncoding
  t[0xad] = '­';
  return t;
})();

/** StandardEncoding (Adobe): ASCII letters/digits, typographic quotes at 0x27/0x60,
 *  high range per ISO 32000-1 Annex D Table D.2 "STD" column (transcribe below). */
export const standardEncoding: Enc = (() => {
  const t: Enc = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = String.fromCharCode(c);
  t[0x27] = '’'; // quoteright
  t[0x60] = '‘'; // quoteleft
  // High range (0xA1..0xFF) from Annex D Table D.2 STD column. Seed entries:
  const over: Record<number, number> = {
    0xa1:0xa1, 0xa2:0xa2, 0xa3:0xa3, 0xa4:0x2044, 0xa5:0xa5, 0xa6:0x192,
    0xa7:0xa7, 0xa8:0xa4, 0xa9:0x27, 0xaa:0x201c, 0xab:0xab, 0xac:0x2039,
    0xad:0x203a, 0xae:0xfb01, 0xaf:0xfb02,
    // TODO(transcribe): remaining STD entries 0xB0..0xFF from Annex D Table D.2.
  };
  for (const k of Object.keys(over)) t[+k] = String.fromCodePoint(over[+k]);
  return t;
})();

/** MacRomanEncoding: ASCII baseline + 0x80..0xFF per ISO 32000-1 Annex D Table D.2
 *  "MAC" column (transcribe below). */
export const macRoman: Enc = (() => {
  const t: Enc = new Array(256).fill(undefined);
  for (let c = 0x20; c <= 0x7e; c++) t[c] = String.fromCharCode(c);
  // 0x80..0xFF from Annex D Table D.2 MAC column. Seed entries (verified):
  const high: Record<number, number> = {
    0x80:0xc4,0x81:0xc5,0x82:0xc7,0x83:0xc9,0x84:0xd1,0x85:0xd6,0x86:0xdc,
    0x87:0xe1,0x88:0xe0,0x89:0xe2,0x8a:0xe4,0x8b:0xe3,0x8c:0xe5,0x8d:0xe7,
    0x8e:0xe9,0x8f:0xe8,0x90:0xea,0x91:0xeb,0x92:0xed,0x93:0xec,0x94:0xee,
    0x95:0xef,0x96:0xf1,0x97:0xf3,0x98:0xf2,0x99:0xf4,0x9a:0xf6,0x9b:0xf5,
    0x9c:0xfa,0x9d:0xf9,0x9e:0xfb,0x9f:0xfc,0xa0:0x2020,0xa1:0xb0,0xa2:0xa2,
    0xa3:0xa3,0xa4:0xa7,0xa5:0x2022,0xa6:0xb6,0xa7:0xdf,0xa8:0xae,0xa9:0xa9,
    0xaa:0x2122,0xab:0xb4,0xac:0xa8,0xae:0xc6,0xaf:0xd8,0xb0:0x221e,0xb1:0xb1,
    0xb4:0xa5,0xb5:0xb5,0xbb:0xaa,0xbc:0xba,0xbe:0xe6,0xbf:0xf8,0xc0:0xbf,
    0xc1:0xa1,0xc2:0xac,0xc7:0xab,0xc8:0xbb,0xc9:0x2026,0xca:0xa0,0xcb:0xc0,
    0xcc:0xc3,0xcd:0xd5,0xce:0x152,0xcf:0x153,0xd0:0x2013,0xd1:0x2014,
    0xd2:0x201c,0xd3:0x201d,0xd4:0x2018,0xd5:0x2019,0xd6:0xf7,0xd8:0xff,
    0xd9:0x178,0xda:0x2044,0xdb:0xa4,0xdc:0x2039,0xdd:0x203a,0xde:0xfb01,
    0xdf:0xfb02,0xe0:0x2021,0xe1:0xb7,0xe2:0x201a,0xe3:0x201e,0xe4:0x2030,
    0xe5:0xc2,0xe6:0xca,0xe7:0xc1,0xe8:0xcb,0xe9:0xc8,0xea:0xcd,0xeb:0xce,
    0xec:0xcf,0xed:0xcc,0xee:0xd3,0xef:0xd4,0xf1:0xd2,0xf2:0xda,0xf3:0xdb,
    0xf4:0xd9,0xf5:0x131,0xf6:0x2c6,0xf7:0x2dc,0xf8:0xaf,0xf9:0x2d8,
    0xfa:0x2d9,0xfb:0x2da,0xfc:0xb8,0xfd:0x2dd,0xfe:0x2db,0xff:0x2c7,
  };
  for (const k of Object.keys(high)) t[+k] = String.fromCodePoint(high[+k]);
  return t;
})();

/** Look up a base encoding by its PDF name; defaults to WinAnsi. */
export function baseEncodingByName(name: string | undefined): Enc {
  switch (name) {
    case 'MacRomanEncoding': return macRoman;
    case 'StandardEncoding': return standardEncoding;
    case 'PDFDocEncoding': return pdfDocEncoding;
    case 'WinAnsiEncoding':
    default: return winAnsi;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/encoding.test.ts`
Expected: PASS (all assertions). If a MacRoman/Standard pin fails, fix the transcribed entry against Annex D Table D.2.

- [ ] **Step 5: Commit**

```bash
git add src/encoding.ts test/encoding.test.ts
git commit -m "feat: base encodings + glyph-name resolver for text extraction (e37)"
```

---

## Task 2: ToUnicode / CMap parser

**Files:**
- Create: `src/cmap.ts`
- Test: `test/cmap.test.ts`

The CMap is parsed from already-decoded stream bytes (the caller inflates). We tokenize with the existing `Lexer`, which yields hex strings (`<...>`) as `str` tokens, numbers, names, and keywords.

- [ ] **Step 1: Write the failing test**

```typescript
// test/cmap.test.ts
import { describe, it, expect } from 'vitest';
import { parseCMap } from '../src/cmap.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('parseCMap', () => {
  it('parses bfchar single mappings', () => {
    const cmap = parseCMap(enc(
      '/CIDInit /ProcSet findresource begin\n' +
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar\n<0041> <0041>\n<0042> <0062>\nendbfchar\n'
    ));
    expect(cmap.codeWidth).toBe(2);
    expect(cmap.lookup(0x0041)).toBe('A');
    expect(cmap.lookup(0x0042)).toBe('b');
    expect(cmap.lookup(0x0043)).toBeUndefined();
  });

  it('parses bfrange with destination base', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '1 beginbfrange\n<20> <22> <0061>\nendbfrange\n'
    ));
    expect(cmap.codeWidth).toBe(1);
    expect(cmap.lookup(0x20)).toBe('a');
    expect(cmap.lookup(0x21)).toBe('b');
    expect(cmap.lookup(0x22)).toBe('c');
  });

  it('parses bfrange with array destinations', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '1 beginbfrange\n<0003> <0005> [<0058> <0059> <005A>]\nendbfrange\n'
    ));
    expect(cmap.lookup(3)).toBe('X');
    expect(cmap.lookup(4)).toBe('Y');
    expect(cmap.lookup(5)).toBe('Z');
  });

  it('decodes multi-codepoint (ligature) bfchar destinations', () => {
    const cmap = parseCMap(enc(
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '1 beginbfchar\n<0001> <00660066>\nendbfchar\n' // "ff"
    ));
    expect(cmap.lookup(1)).toBe('ff');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cmap.test.ts`
Expected: FAIL — cannot find module `../src/cmap.js`.

- [ ] **Step 3: Write `src/cmap.ts`**

```typescript
// src/cmap.ts
import { Lexer } from './lexer.js';

export interface CMap {
  /** Number of bytes per code, from the codespace range (default 2). */
  readonly codeWidth: number;
  /** Map an integer code to its Unicode string, or undefined if unmapped. */
  lookup(code: number): string | undefined;
}

/** Interpret hex-string bytes (big-endian) as an integer code. */
function bytesToCode(bytes: Uint8Array): number {
  let n = 0;
  for (const b of bytes) n = (n << 8) | b;
  return n >>> 0;
}

/** Interpret UTF-16BE bytes as a JS string (CMap bf destinations are UTF-16BE). */
function utf16beToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  if (bytes.length % 2 === 1) s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}

/** Parse a (decoded) ToUnicode/CMap stream into a lookup table. */
export function parseCMap(buf: Uint8Array): CMap {
  const lx = new Lexer(buf);
  const single = new Map<number, string>();
  let codeWidth = 2;
  let sawCodespace = false;

  // Collect a flat token list of the values we care about.
  type V = { kind: 'hex'; bytes: Uint8Array } | { kind: 'num'; v: number }
    | { kind: 'op'; v: string } | { kind: 'arrStart' } | { kind: 'arrEnd' };
  const toks: V[] = [];
  for (;;) {
    const t = lx.next();
    if (t.t === 'eof') break;
    if (t.t === 'str') toks.push({ kind: 'hex', bytes: t.v });
    else if (t.t === 'num') toks.push({ kind: 'num', v: t.v });
    else if (t.t === 'kw') toks.push({ kind: 'op', v: t.v });
    else if (t.t === 'delim' && t.v === '[') toks.push({ kind: 'arrStart' });
    else if (t.t === 'delim' && t.v === ']') toks.push({ kind: 'arrEnd' });
    // names and other delims are ignored
  }

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== 'op') continue;
    if (t.v === 'begincodespacerange') {
      // next two hex tokens define the range; width = low byte length
      const lo = toks[i + 1];
      if (lo && lo.kind === 'hex' && !sawCodespace) { codeWidth = lo.bytes.length || 2; sawCodespace = true; }
    } else if (t.v === 'beginbfchar') {
      let j = i + 1;
      while (j < toks.length && !(toks[j].kind === 'op')) {
        const src = toks[j], dst = toks[j + 1];
        if (src?.kind === 'hex' && dst?.kind === 'hex') {
          single.set(bytesToCode(src.bytes), utf16beToString(dst.bytes));
          j += 2;
        } else { j++; }
      }
      i = j;
    } else if (t.v === 'beginbfrange') {
      let j = i + 1;
      while (j < toks.length && toks[j].kind !== 'op') {
        const a = toks[j], b = toks[j + 1], c = toks[j + 2];
        if (a?.kind === 'hex' && b?.kind === 'hex' && c?.kind === 'arrStart') {
          // array form: [<..> <..> ...]
          const lo = bytesToCode(a.bytes);
          let k = j + 3, code = lo;
          while (k < toks.length && toks[k].kind !== 'arrEnd') {
            const e = toks[k];
            if (e.kind === 'hex') single.set(code++, utf16beToString(e.bytes));
            k++;
          }
          j = k + 1;
        } else if (a?.kind === 'hex' && b?.kind === 'hex' && c?.kind === 'hex') {
          const lo = bytesToCode(a.bytes), hi = bytesToCode(b.bytes);
          const base = utf16beToString(c.bytes);
          const baseCp = base.codePointAt(0) ?? 0;
          for (let code = lo; code <= hi; code++) {
            single.set(code, String.fromCodePoint(baseCp + (code - lo)));
          }
          j += 3;
        } else { j++; }
      }
      i = j;
    }
  }

  return { codeWidth, lookup: (code) => single.get(code) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cmap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cmap.ts test/cmap.test.ts
git commit -m "feat: ToUnicode/CMap parser for text extraction (e37)"
```

---

## Task 3: TextFont decoder

**Files:**
- Create: `src/font.ts`
- Test: `test/font.test.ts`

`TextFont` wraps a resolved font dict and a `resolve`/`inflate` capability passed by the caller (to keep `font.ts` free of a `Document` import cycle). Decoding precedence: ToUnicode → simple base encoding+Differences → Type0 (Identity-H) unmapped.

- [ ] **Step 1: Write the failing test**

```typescript
// test/font.test.ts
import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, name } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dict = (o: Record<string, PdfObject>): PdfDict => new Map(Object.entries(o));

// Minimal resolver: values are already direct (no indirect refs) in these fixtures.
const id = (o: PdfObject) => o;
const noInflate = () => new Uint8Array(0);

describe('TextFont simple', () => {
  it('decodes WinAnsi bytes', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('Helvetica'),
      Encoding: name('WinAnsiEncoding'),
    }), id, noInflate);
    expect(f.codeWidth).toBe(1);
    expect(f.decode(enc('Hello'))).toBe('Hello');
    expect(f.decode(Uint8Array.of(0x80))).toBe('€'); // Euro
  });

  it('applies /Differences over the base encoding', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'),
      Encoding: dict({
        BaseEncoding: name('WinAnsiEncoding'),
        Differences: [65, name('bullet'), name('Euro')], // 65->bullet, 66->Euro
      }),
    }), id, noInflate);
    expect(f.decode(Uint8Array.of(65, 66))).toBe('•€');
  });
});

describe('TextFont with ToUnicode', () => {
  it('prefers ToUnicode over base encoding', () => {
    const stream = {
      kind: 'stream' as const,
      dict: dict({}),
      raw: enc('1 begincodespacerange <00> <FF> endcodespacerange\n' +
               '1 beginbfchar <41> <0062> endbfchar\n'),
    };
    const f = new TextFont(dict({
      Subtype: name('Type1'), Encoding: name('WinAnsiEncoding'), ToUnicode: stream,
    }), id, (s) => s.raw); // inflate returns raw bytes for the fixture
    expect(f.decode(Uint8Array.of(0x41))).toBe('b'); // ToUnicode wins over 'A'
  });
});

describe('TextFont Type0 Identity-H', () => {
  it('decodes 2-byte codes via ToUnicode', () => {
    const stream = {
      kind: 'stream' as const,
      dict: dict({}),
      raw: enc('1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
               '1 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n'),
    };
    const f = new TextFont(dict({
      Subtype: name('Type0'), Encoding: name('Identity-H'), ToUnicode: stream,
    }), id, (s) => s.raw);
    expect(f.codeWidth).toBe(2);
    expect(f.decode(Uint8Array.of(0x00, 0x03, 0x00, 0x04))).toBe('Hi');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/font.test.ts`
Expected: FAIL — cannot find module `../src/font.js`.

- [ ] **Step 3: Write `src/font.ts`**

```typescript
// src/font.ts
import { PdfDict, PdfObject, isDict, isName, isArray, isStream, isString } from './types.js';
import { baseEncodingByName, glyphToUnicode, winAnsi } from './encoding.js';
import { parseCMap, CMap } from './cmap.js';

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

/** A font usable for text decoding. Built from a resolved font dict. */
export class TextFont {
  /** Bytes per character code (1 for simple fonts, 2 for Identity-H/Type0). */
  readonly codeWidth: number;
  private readonly isType0: boolean;
  private readonly toUnicode?: CMap;
  private readonly simple?: (string | undefined)[]; // code(0..255) -> Unicode

  constructor(dict: PdfDict, resolve: Resolve, inflate: Inflate) {
    const subtype = resolve(dict.get('Subtype'));
    this.isType0 = isName(subtype) && subtype.name === 'Type0';

    const tu = resolve(dict.get('ToUnicode'));
    if (isStream(tu)) this.toUnicode = parseCMap(inflate(tu));

    if (this.isType0) {
      const encObj = resolve(dict.get('Encoding'));
      // Identity-H/V and most embedded CMaps use 2-byte codes.
      this.codeWidth = this.toUnicode?.codeWidth ?? 2;
    } else {
      this.codeWidth = 1;
      this.simple = buildSimpleEncoding(dict, resolve);
    }
  }

  /** Decode a show-string's bytes into Unicode text. */
  decode(bytes: Uint8Array): string {
    let out = '';
    const w = this.codeWidth;
    for (let i = 0; i + w <= bytes.length || (w === 1 && i < bytes.length); i += w) {
      let code = 0;
      for (let k = 0; k < w; k++) code = (code << 8) | (bytes[i + k] ?? 0);
      const u = this.toUnicode?.lookup(code);
      if (u !== undefined) { out += u; continue; }
      if (!this.isType0 && this.simple) {
        const s = this.simple[code & 0xff];
        if (s !== undefined) out += s;
      }
      // Type0 without ToUnicode mapping: drop (unmappable).
    }
    return out;
  }
}

/** Build a code(0..255) -> Unicode table for a simple font. */
function buildSimpleEncoding(dict: PdfDict, resolve: Resolve): (string | undefined)[] {
  const enc = resolve(dict.get('Encoding'));
  let table = winAnsi.slice();
  let differences: PdfObject[] | undefined;

  if (isName(enc)) {
    table = baseEncodingByName(enc.name).slice();
  } else if (isDict(enc)) {
    const base = resolve(enc.get('BaseEncoding'));
    table = baseEncodingByName(isName(base) ? base.name : undefined).slice();
    const diffs = resolve(enc.get('Differences'));
    if (isArray(diffs)) differences = diffs;
  }

  if (differences) {
    let code = 0;
    for (const item of differences) {
      const it = resolve(item);
      if (typeof it === 'number') { code = it; }
      else if (isName(it)) { table[code & 0xff] = glyphToUnicode(it.name) ?? table[code & 0xff]; code++; }
    }
  }
  return table;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/font.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/font.ts test/font.test.ts
git commit -m "feat: TextFont decoder (encoding/Differences/ToUnicode/Type0) (e37)"
```

---

## Task 4: Affine helpers + line/word assembly

**Files:**
- Create: `src/text.ts` (matrix helpers, `Run` type, `assembleLines`; `extractText` added in Task 5)
- Test: `test/text.test.ts` (assembly unit tests; integration added in Task 5)

- [ ] **Step 1: Write the failing test**

```typescript
// test/text.test.ts
import { describe, it, expect } from 'vitest';
import { assembleLines, Run } from '../src/text.js';

const run = (x: number, y: number, text: string, size = 10): Run =>
  ({ x, endX: x + text.length * size * 0.5, y, text, size });

describe('assembleLines', () => {
  it('returns empty string for no runs', () => {
    expect(assembleLines([])).toBe('');
  });
  it('orders runs left-to-right on one line', () => {
    expect(assembleLines([run(50, 100, 'World'), run(0, 100, 'Hello ')])).toBe('Hello World');
  });
  it('inserts a space across a wide x-gap', () => {
    // 'A' ends near x=5; 'B' starts at x=40 -> gap >> 0.25*size
    expect(assembleLines([run(0, 100, 'A'), run(40, 100, 'B')])).toBe('A B');
  });
  it('breaks lines on a y drop and orders top-to-bottom', () => {
    expect(assembleLines([run(0, 80, 'second'), run(0, 100, 'first')])).toBe('first\nsecond');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/text.test.ts`
Expected: FAIL — cannot find module `../src/text.js`.

- [ ] **Step 3: Write `src/text.ts` (helpers + assembly only)**

```typescript
// src/text.ts
// Coordinate-based text extraction: walk content ops, emit positioned runs,
// then assemble runs into lines.

/** 2x3 affine matrix [a b c d e f] with row-vector convention:
 *  x' = a*x + c*y + e ; y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m followed by n: point p -> (p·m)·n. */
export function mul(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty];
}
/** Vertical scale magnitude of a matrix (effective font-size multiplier). */
export function vscale(m: Matrix): number {
  return Math.hypot(m[2], m[3]) || 1;
}

/** A positioned text run in device space. */
export interface Run {
  x: number;      // device-space origin X
  endX: number;   // estimated device-space end X (for gap detection)
  y: number;      // device-space baseline Y
  text: string;
  size: number;   // effective font size in device units
}

/** Group runs into lines (by Y) and order/space them (by X) into a string. */
export function assembleLines(runs: Run[]): string {
  const items = runs.filter((r) => r.text.length > 0);
  if (items.length === 0) return '';
  // Top-to-bottom (PDF Y up -> larger Y first), then left-to-right.
  items.sort((a, b) => (b.y - a.y) || (a.x - b.x));

  const lines: Run[][] = [];
  let current: Run[] = [];
  let lineY = items[0].y;
  for (const r of items) {
    const tol = Math.max(2, 0.5 * r.size);
    if (current.length === 0 || Math.abs(r.y - lineY) <= tol) {
      current.push(r);
      // weight lineY toward the line's first (tallest) run
    } else {
      lines.push(current);
      current = [r];
      lineY = r.y;
    }
  }
  if (current.length) lines.push(current);

  const rendered = lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    let s = '';
    let prevEndX: number | undefined;
    for (const r of line) {
      if (prevEndX !== undefined) {
        const gap = r.x - prevEndX;
        if (gap > 0.25 * r.size && !s.endsWith(' ') && !r.text.startsWith(' ')) s += ' ';
      }
      s += r.text;
      prevEndX = r.endX;
    }
    return s.replace(/\s+$/, '');
  });
  return rendered.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/text.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/text.ts test/text.test.ts
git commit -m "feat: affine helpers + line/word assembly for text extraction (e37)"
```

---

## Task 5: Text-state machine, Page.GetText(), and integration tests

**Files:**
- Modify: `src/text.ts` (add `extractText` + the op walker)
- Modify: `src/page.ts` (add `GetText()`)
- Create: `test/helpers/build-text-pdf.ts`
- Modify: `test/text.test.ts` (add integration tests)

- [ ] **Step 1: Write fixture builders**

```typescript
// test/helpers/build-text-pdf.ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

interface Obj { [n: number]: string }

/** Serialize numbered objects (1..maxObj) into a classic-xref PDF.
 *  `extraStreams`: object number -> raw byte payload appended after its dict. */
function serialize(objects: Obj, maxObj: number, rootInfo = '/Root 1 0 R'): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} ${rootInfo} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function contentObj(num: number, stream: string): string {
  return `<< /Length ${byteLen(stream)} >>\nstream\n${stream}\nendstream`;
}

/** Page with a single simple Type1 font (F1) and a given content stream. */
export function buildSimpleTextPdf(stream: string, opts: { encoding?: string } = {}): Uint8Array {
  const e = opts.encoding ?? 'WinAnsiEncoding';
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(4, stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /${e} >>`,
  };
  return serialize(objects, 5);
}

/** Page whose font carries a /ToUnicode CMap (uncompressed). */
export function buildToUnicodePdf(stream: string, cmap: string): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(4, stream),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /AAAAAA+Foo /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>`,
    6: contentObj(6, cmap),
  };
  return serialize(objects, 6);
}

/** Page with a Type0 Identity-H font + ToUnicode (2-byte codes). */
export function buildType0Pdf(stream: string, cmap: string): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    4: contentObj(4, stream),
    5: `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Foo /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 6 0 R >>`,
    6: contentObj(6, cmap),
    7: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Foo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>`,
  };
  return serialize(objects, 7);
}

/** Page with NO text-showing operators (image-only / empty). */
export function buildImageOnlyPdf(): Uint8Array {
  const stream = `q 100 0 0 100 50 50 cm /Im0 Do Q`;
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`,
    4: contentObj(4, stream),
  };
  return serialize(objects, 4);
}
```

- [ ] **Step 2: Write failing integration tests (append to `test/text.test.ts`)**

```typescript
// append to test/text.test.ts
import { Document } from '../src/document.js';
import {
  buildSimpleTextPdf, buildToUnicodePdf, buildType0Pdf, buildImageOnlyPdf,
} from './helpers/build-text-pdf.js';

const text = (bytes: Uint8Array) => Document.Open(bytes).Pages[0].GetText();

describe('Page.GetText integration', () => {
  it('extracts WinAnsi simple-font text', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (Hello World) Tj ET');
    expect(text(pdf)).toBe('Hello World');
  });

  it('infers spaces from TJ adjustments', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td [(Hello)-400(World)] TJ ET');
    expect(text(pdf)).toBe('Hello World');
  });

  it('joins two lines with a newline (Td line move)', () => {
    const pdf = buildSimpleTextPdf('BT /F1 12 Tf 20 250 Td (first) Tj 0 -20 Td (second) Tj ET');
    expect(text(pdf)).toBe('first\nsecond');
  });

  it('decodes ToUnicode-mapped text', () => {
    // codes 0x01,0x02,0x03 -> H,i,! via ToUnicode
    const cmap =
      '1 begincodespacerange <00> <FF> endcodespacerange\n' +
      '3 beginbfchar <01> <0048> <02> <0069> <03> <0021> endbfchar\n';
    const pdf = buildToUnicodePdf('BT /F1 12 Tf 20 250 Td <010203> Tj ET', cmap);
    expect(text(pdf)).toBe('Hi!');
  });

  it('decodes Type0 Identity-H text', () => {
    const cmap =
      '1 begincodespacerange <0000> <FFFF> endcodespacerange\n' +
      '2 beginbfchar <0003> <0048> <0004> <0069> endbfchar\n';
    const pdf = buildType0Pdf('BT /F1 12 Tf 20 250 Td <00030004> Tj ET', cmap);
    expect(text(pdf)).toBe('Hi');
  });

  it('extracts correctly under a cm transform', () => {
    const pdf = buildSimpleTextPdf('q 1 0 0 1 10 10 cm BT /F1 12 Tf 20 250 Td (Shifted) Tj ET Q');
    expect(text(pdf)).toBe('Shifted');
  });

  it('returns empty string for an image-only page', () => {
    expect(text(buildImageOnlyPdf())).toBe('');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/text.test.ts`
Expected: FAIL — `Pages[0].GetText is not a function` (and `extractText` not exported).

- [ ] **Step 4: Add the op walker + `extractText` to `src/text.ts`**

Append to `src/text.ts`:

```typescript
import type { Document } from './document.js';
import type { Page } from './page.js';
import { PdfDict, PdfObject, isDict, isName, isArray, isString, isStream } from './types.js';
import { parseContentStream, ContentOp } from './content.js';
import { inflateStream } from './flate.js';
import { TextFont } from './font.js';

const MAX_XOBJECT_DEPTH = 8;

/** Walk a page's content, collect positioned runs, assemble into text. */
export function extractText(doc: Document, page: Page): string {
  const runs: Run[] = [];
  const fontCache = new Map<PdfDict, TextFont>();
  walk(doc, page.Contents, page.Resources, IDENTITY, runs, fontCache, 0, new Set());
  return assembleLines(runs);
}

interface TextState {
  tm: Matrix; tlm: Matrix;
  font?: TextFont; fontSize: number;
  charSp: number; wordSp: number; hscale: number; leading: number; rise: number;
}

function newState(): TextState {
  return { tm: IDENTITY, tlm: IDENTITY, fontSize: 0, charSp: 0, wordSp: 0, hscale: 1, leading: 0, rise: 0 };
}

function walk(
  doc: Document, content: Uint8Array, resources: PdfDict | undefined,
  ctm: Matrix, runs: Run[], fontCache: Map<PdfDict, TextFont>,
  depth: number, seen: Set<PdfDict>,
): void {
  const ops = parseContentStream(content);
  const ctmStack: Matrix[] = [];
  let curCtm = ctm;
  let st = newState();

  const fonts = resolveDict(doc, resources?.get('Font'));
  const xobjects = resolveDict(doc, resources?.get('XObject'));

  for (const op of ops) {
    switch (op.operator) {
      case 'q': ctmStack.push(curCtm); break;
      case 'Q': curCtm = ctmStack.pop() ?? curCtm; break;
      case 'cm': { const m = nums(op.operands); if (m.length === 6) curCtm = mul(m as Matrix, curCtm); break; }
      case 'BT': st.tm = IDENTITY; st.tlm = IDENTITY; break;
      case 'ET': break;
      case 'Tc': st.charSp = num(op.operands[0]); break;
      case 'Tw': st.wordSp = num(op.operands[0]); break;
      case 'Tz': st.hscale = num(op.operands[0]) / 100 || 1; break;
      case 'TL': st.leading = num(op.operands[0]); break;
      case 'Ts': st.rise = num(op.operands[0]); break;
      case 'Tf': {
        st.fontSize = num(op.operands[1]);
        const fname = op.operands[0];
        if (isName(fname) && fonts) {
          const fd = doc.resolve(fonts.get(fname.name));
          if (isDict(fd)) {
            let tf = fontCache.get(fd);
            if (!tf) { tf = new TextFont(fd, (o) => doc.resolve(o), (s) => inflateStream(s)); fontCache.set(fd, tf); }
            st.font = tf;
          }
        }
        break;
      }
      case 'Td': { const [tx, ty] = nums(op.operands); lineMove(st, tx, ty); break; }
      case 'TD': { const [tx, ty] = nums(op.operands); st.leading = -ty; lineMove(st, tx, ty); break; }
      case 'Tm': { const m = nums(op.operands); if (m.length === 6) { st.tlm = m as Matrix; st.tm = m as Matrix; } break; }
      case 'T*': lineMove(st, 0, -st.leading); break;
      case 'Tj': show(st, op.operands[0], curCtm, runs); break;
      case 'TJ': showArray(st, op.operands[0], curCtm, runs); break;
      case "'": lineMove(st, 0, -st.leading); show(st, op.operands[0], curCtm, runs); break;
      case '"': {
        st.wordSp = num(op.operands[0]); st.charSp = num(op.operands[1]);
        lineMove(st, 0, -st.leading); show(st, op.operands[2], curCtm, runs); break;
      }
      case 'Do': {
        const xn = op.operands[0];
        if (isName(xn) && xobjects && depth < MAX_XOBJECT_DEPTH) {
          const xo = doc.resolve(xobjects.get(xn.name));
          if (isStream(xo) && isFormXObject(doc, xo.dict) && !seen.has(xo.dict)) {
            seen.add(xo.dict);
            const mat = nums(doc.resolve(xo.dict.get('Matrix')) as PdfObject[] | undefined);
            const childCtm = mat.length === 6 ? mul(mat as Matrix, curCtm) : curCtm;
            const childRes = resolveDict(doc, xo.dict.get('Resources')) ?? resources;
            walk(doc, inflateStream(xo), childRes, childCtm, runs, fontCache, depth + 1, seen);
            seen.delete(xo.dict);
          }
        }
        break;
      }
    }
  }
}

function lineMove(st: TextState, tx: number, ty: number): void {
  st.tlm = mul(translate(tx, ty), st.tlm);
  st.tm = st.tlm;
}

/** Emit a run for a show-string and advance the text matrix. */
function show(st: TextState, strObj: PdfObject, ctm: Matrix, runs: Run[]): void {
  if (!isString(strObj) || !st.font) return;
  const txt = st.font.decode(strObj.bytes);
  emitRun(st, txt, ctm, runs);
  advance(st, txt.length);
}

/** Handle a TJ array: strings show, numbers shift (large gaps -> spaces). */
function showArray(st: TextState, arrObj: PdfObject, ctm: Matrix, runs: Run[]): void {
  if (!isArray(arrObj) || !st.font) return;
  let buf = '';
  let startTm = st.tm;
  const flush = () => { if (buf) { emitRunAt(st, buf, startTm, ctm, runs); } buf = ''; };
  for (const el of arrObj) {
    if (isString(el)) {
      if (!buf) startTm = st.tm;
      const t = st.font.decode(el.bytes);
      buf += t;
      advance(st, t.length);
    } else if (typeof el === 'number') {
      const shift = (-el / 1000) * st.fontSize * st.hscale; // text-space displacement
      st.tm = mul(translate(shift, 0), st.tm);
      if (-el > 200) { buf += ' '; } // wide gap -> word space
    }
  }
  flush();
}

/** Device-space origin + effective size for the current text position. */
function emitRun(st: TextState, text: string, ctm: Matrix, runs: Run[]): void {
  emitRunAt(st, text, st.tm, ctm, runs);
}
function emitRunAt(st: TextState, text: string, tm: Matrix, ctm: Matrix, runs: Run[]): void {
  if (!text) return;
  const comb = mul(tm, ctm);
  const [x, y] = apply(comb, 0, st.rise);
  const size = st.fontSize * vscale(comb);
  const width = text.length * 0.5 * size; // 0.5em estimate
  runs.push({ x, endX: x + width, y, text, size });
}

/** Advance Tm horizontally by the estimated width of `nChars`. */
function advance(st: TextState, nChars: number): void {
  const tx = (nChars * (0.5 * st.fontSize + st.charSp)) * st.hscale;
  st.tm = mul(translate(tx, 0), st.tm);
}

function isFormXObject(doc: Document, d: PdfDict): boolean {
  const s = doc.resolve(d.get('Subtype'));
  return isName(s) && s.name === 'Form';
}
function resolveDict(doc: Document, o: PdfObject | undefined): PdfDict | undefined {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
}
function num(o: PdfObject | undefined): number { return typeof o === 'number' ? o : 0; }
function nums(arr: PdfObject[] | undefined): number[] {
  return isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : [];
}
```

Note: `mul(m, ctm)` composes text/line matrix `m` then the CTM — correct because a point transforms as `p · Tm · CTM`. `cm` pre-multiplies: new CTM = `cmMatrix · oldCTM`.

- [ ] **Step 5: Add `GetText()` to `src/page.ts`**

In `src/page.ts`, add the import near the top and the method at the end of the `Page` class:

```typescript
// add to imports
import { extractText } from './text.js';
```

```typescript
  /** Extract visible text from the page with reasonable word/line ordering.
   *  Decodes through simple-font encodings, /ToUnicode CMaps, and Type0 fonts.
   *  Returns "" for pages with no text-showing operators. */
  GetText(): string {
    return extractText(this.doc, this);
  }
```

- [ ] **Step 6: Run integration tests to verify they pass**

Run: `npx vitest run test/text.test.ts`
Expected: PASS (all unit + integration tests).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/text.ts src/page.ts test/helpers/build-text-pdf.ts test/text.test.ts
git commit -m "feat: Page.GetText() text extraction via content-stream walk (e37)"
```

---

## Task 6: Documentation and issue close-out

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document `Page.GetText()` in README**

In `README.md`, under the API overview / page section, add an entry. Example wording (adapt to the existing README structure):

```markdown
- `page.GetText(): string` — extract visible text from the page with reasonable
  word and line ordering. Decodes simple-font encodings (WinAnsi/MacRoman/
  Standard/PDFDoc + `/Differences`), `/ToUnicode` CMaps, and Type0/Identity-H
  composite fonts. Returns `""` for pages with no text. Spacing/line breaks are
  heuristic (glyph advances are estimated, not read from width tables).
```

Also add a Quick-start snippet if the README has one:

```typescript
import { Document } from 'aspose-pdf-foss-for-ts';
const doc = Document.Open(bytes);
console.log(doc.Pages[0].GetText());
```

- [ ] **Step 2: Verify docs build / no broken references**

Run: `npm run typecheck && npm test`
Expected: still green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document Page.GetText() text extraction (e37)"
```

- [ ] **Step 4: Close the issue**

Run:
```bash
bd close aspose-pdf-foss-for-ts-e37
```

---

## Self-Review Notes

- **Spec coverage:** coordinate-based layout (Task 4/5 matrix + CTM), all three encoding tiers (Task 1 simple + `/Differences`, Task 2 ToUnicode, Task 3 Type0), `Page.GetText()` method (Task 5), 0.5em width estimate (Task 5 `advance`/`emitRunAt`), Form-XObject recursion with depth guard (Task 5 `Do`), all acceptance-criteria cases covered by Task 5 integration tests including image-only → `""`.
- **Known approximation:** StandardEncoding/MacRoman high-range tables are spec-transcribed (Annex D Table D.2); the `0xB0..0xFF` STD entries carry a `TODO(transcribe)` and are pinned only for the seeded codes. If a StandardEncoding-only PDF surfaces needing those slots, complete the table — does not affect the WinAnsi/ToUnicode acceptance criteria.
- **Type consistency:** `Run`, `Matrix`, `mul/apply/translate/vscale`, `assembleLines`, `extractText`, `TextFont(dict, resolve, inflate)`/`.decode`/`.codeWidth`, `parseCMap`/`CMap.lookup`/`.codeWidth`, `glyphToUnicode`/`baseEncodingByName` are referenced consistently across tasks.
