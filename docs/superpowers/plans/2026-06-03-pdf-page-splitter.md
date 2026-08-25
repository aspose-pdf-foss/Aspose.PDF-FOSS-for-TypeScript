# PDF Page Splitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a from-scratch TypeScript PDF parser + writer exposing `splitPdf(bytes)` that turns an N-page PDF into N self-contained single-page PDFs, with no PDF-library dependencies.

**Architecture:** Layered byte-oriented core: lexer → object-parser → xref (classic + stream) → object-stream decoder → lazy document model → page-tree walker → per-page reachability extractor (policy-driven pruning) → classic-xref writer. Node `zlib` is used only to inflate xref/object streams; content streams are copied verbatim.

**Tech Stack:** Node.js (ESM), TypeScript, Vitest, Node built-in `zlib`. State tracked in beads (`bd`).

---

## File Structure

```
package.json            ESM, type:module, vitest + tsc scripts, no runtime deps
tsconfig.json           strict, NodeNext, outDir dist
vitest.config.ts        node environment
src/
  errors.ts             PdfParseError, UnsupportedFeatureError
  types.ts              PdfObject union + type guards + PdfRef, PdfStream, PdfName
  lexer.ts              Lexer: bytes -> tokens
  object-parser.ts      ObjectParser: tokens -> PdfObject
  predictor.ts          reverse PNG/TIFF predictors
  flate.ts              inflate (zlib) + optional predictor un-application
  xref.ts               parse classic tables and xref streams, follow /Prev,/XRefStm
  objstm.ts             decode /ObjStm into number->object map
  document.ts           Document: lazy getObject, trailer, catalog, /Encrypt guard
  pagetree.ts           walk Pages tree in order, materialize inherited attrs
  extractor.ts          per-page reachable set + PrunePolicy
  writer.ts             serialize object set -> single-page PDF (classic xref)
  split.ts              splitPdf(input) public core
  node.ts               splitPdfFile(inputPath, outDir) wrapper
  index.ts              public exports
test/
  helpers/build-pdf.ts  hand-rolled fixture builder (uses zlib freely; test-only)
  *.test.ts             colocated per module under test/
```

Each `src/*.ts` has one responsibility. Files that change together (a module and the types it owns) stay together.

---

## Conventions used throughout

- All source is ESM TypeScript, `strict: true`.
- Bytes are `Uint8Array`. Offsets are byte indices into the original buffer.
- The PDF object model (`src/types.ts`):

```ts
export type PdfNull = null;
export type PdfBool = boolean;
export type PdfNumber = number;
export interface PdfName { readonly kind: 'name'; readonly name: string }
export interface PdfString { readonly kind: 'string'; readonly bytes: Uint8Array }
export interface PdfRef { readonly kind: 'ref'; readonly num: number; readonly gen: number }
export type PdfArray = PdfObject[];
export type PdfDict = Map<string, PdfObject>; // keys are name strings without leading '/'
export interface PdfStream { readonly kind: 'stream'; readonly dict: PdfDict; readonly raw: Uint8Array }
export type PdfObject =
  | PdfNull | PdfBool | PdfNumber
  | PdfName | PdfString | PdfRef
  | PdfArray | PdfDict | PdfStream;

export const name = (n: string): PdfName => ({ kind: 'name', name: n });
export const ref = (num: number, gen = 0): PdfRef => ({ kind: 'ref', num, gen });
export const isRef = (o: PdfObject): o is PdfRef => !!o && typeof o === 'object' && (o as any).kind === 'ref';
export const isName = (o: PdfObject): o is PdfName => !!o && typeof o === 'object' && (o as any).kind === 'name';
export const isDict = (o: PdfObject): o is PdfDict => o instanceof Map;
export const isStream = (o: PdfObject): o is PdfStream => !!o && typeof o === 'object' && (o as any).kind === 'stream';
export const isArray = (o: PdfObject): o is PdfArray => Array.isArray(o);
```

> Note: a stream's `dict` is the stream dictionary; `raw` is the **undecoded** bytes between `stream`/`endstream`. We never decode content streams; we only decode xref/object streams explicitly.

---

## Task 0: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/index.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@esopsa/pdf-foss",
  "version": "0.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'] } });
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
```

- [ ] **Step 5: Create placeholder `src/index.ts`**

```ts
export {};
```

- [ ] **Step 6: Install and verify**

Run: `npm install && npx tsc --noEmit`
Expected: install succeeds; tsc exits 0 (no errors).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/index.ts
git commit -m "chore: scaffold TS project with vitest"
```

---

## Task 1: Errors and types

**Files:**
- Create: `src/errors.ts`, `src/types.ts`, `test/types.test.ts`

- [ ] **Step 1: Write failing test** — `test/types.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { ref, name, isRef, isName, isDict, isStream } from '../src/types.js';

describe('type guards', () => {
  it('identifies refs and names', () => {
    expect(isRef(ref(5, 0))).toBe(true);
    expect(isName(name('Type'))).toBe(true);
    expect(isRef(name('Type'))).toBe(false);
  });
  it('identifies dicts and streams', () => {
    expect(isDict(new Map())).toBe(true);
    expect(isStream({ kind: 'stream', dict: new Map(), raw: new Uint8Array() })).toBe(true);
    expect(isDict([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/types.test.ts`
Expected: FAIL — cannot find module `../src/types.js`.

- [ ] **Step 3: Create `src/errors.ts`**

```ts
export class PdfParseError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} (at byte ${offset})`);
    this.name = 'PdfParseError';
  }
}
export class UnsupportedFeatureError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsupportedFeatureError'; }
}
```

- [ ] **Step 4: Create `src/types.ts`** (use the full block from "Conventions used throughout" above).

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/types.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/types.ts test/types.test.ts
git commit -m "feat: pdf object model types and errors"
```

---

## Task 2: Lexer (tokenizer)

**Files:**
- Create: `src/lexer.ts`, `test/lexer.test.ts`

The lexer turns bytes into a token stream. Tokens:

```ts
export type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'str'; v: Uint8Array; pos: number }     // literal or hex string, decoded to bytes
  | { t: 'delim'; v: '[' | ']' | '<<' | '>>'; pos: number }
  | { t: 'kw'; v: string; pos: number }          // obj endobj stream endstream R true false null xref trailer startxref
  | { t: 'eof'; pos: number };
```

- [ ] **Step 1: Write failing test** — `test/lexer.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Lexer } from '../src/lexer.js';

const enc = (s: string) => new TextEncoder().encode(s);
function toks(s: string) {
  const lx = new Lexer(enc(s));
  const out: any[] = [];
  for (;;) { const t = lx.next(); out.push(t); if (t.t === 'eof') break; }
  return out;
}

describe('Lexer', () => {
  it('tokenizes numbers, names, keywords', () => {
    const t = toks('10 0 obj /Type true');
    expect(t.map(x => x.t)).toEqual(['num','num','kw','name','kw','eof']);
    expect(t[0].v).toBe(10);
    expect(t[3].v).toBe('Type');
    expect(t[4].v).toBe('true');
  });
  it('tokenizes dict delimiters and arrays', () => {
    expect(toks('<< /A [1 2] >>').map(x => x.t))
      .toEqual(['delim','name','delim','num','num','delim','delim','eof']);
  });
  it('decodes literal strings with escapes', () => {
    const t = toks('(a\\)b)');
    expect(t[0].t).toBe('str');
    expect(new TextDecoder().decode(t[0].v)).toBe('a)b');
  });
  it('decodes hex strings', () => {
    const t = toks('<48656C6C6F>');
    expect(new TextDecoder().decode(t[0].v)).toBe('Hello');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/lexer.test.ts`
Expected: FAIL — cannot find `../src/lexer.js`.

- [ ] **Step 3: Implement `src/lexer.ts`**

```ts
import { PdfParseError } from './errors.js';

export type Token =
  | { t: 'num'; v: number; pos: number }
  | { t: 'name'; v: string; pos: number }
  | { t: 'str'; v: Uint8Array; pos: number }
  | { t: 'delim'; v: '[' | ']' | '<<' | '>>'; pos: number }
  | { t: 'kw'; v: string; pos: number }
  | { t: 'eof'; pos: number };

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]); // ()<>[]{}/%
const isWs = (b: number) => WS.has(b);
const isDelim = (b: number) => DELIM.has(b);
const isReg = (b: number) => !isWs(b) && !isDelim(b);

export class Lexer {
  pos = 0;
  constructor(private readonly buf: Uint8Array, start = 0) { this.pos = start; }

  private skipWsAndComments() {
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos];
      if (isWs(b)) { this.pos++; continue; }
      if (b === 37) { // % comment to EOL
        while (this.pos < this.buf.length && this.buf[this.pos] !== 10 && this.buf[this.pos] !== 13) this.pos++;
        continue;
      }
      break;
    }
  }

  next(): Token {
    this.skipWsAndComments();
    const pos = this.pos;
    if (this.pos >= this.buf.length) return { t: 'eof', pos };
    const b = this.buf[this.pos];

    if (b === 91) { this.pos++; return { t: 'delim', v: '[', pos }; }
    if (b === 93) { this.pos++; return { t: 'delim', v: ']', pos }; }
    if (b === 60) {
      if (this.buf[this.pos + 1] === 60) { this.pos += 2; return { t: 'delim', v: '<<', pos }; }
      return { t: 'str', v: this.readHexString(), pos };
    }
    if (b === 62) {
      if (this.buf[this.pos + 1] === 62) { this.pos += 2; return { t: 'delim', v: '>>', pos }; }
      throw new PdfParseError('unexpected >', pos);
    }
    if (b === 40) return { t: 'str', v: this.readLiteralString(), pos };
    if (b === 47) return { t: 'name', v: this.readName(), pos };
    if (b === 43 || b === 45 || b === 46 || (b >= 48 && b <= 57)) {
      const r = this.readRegular();
      const n = Number(r);
      if (!Number.isNaN(n) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(r)) return { t: 'num', v: n, pos };
      return { t: 'kw', v: r, pos };
    }
    return { t: 'kw', v: this.readRegular(), pos };
  }

  private readRegular(): string {
    const start = this.pos;
    while (this.pos < this.buf.length && isReg(this.buf[this.pos])) this.pos++;
    return new TextDecoder('latin1').decode(this.buf.subarray(start, this.pos));
  }

  private readName(): string {
    this.pos++; // skip '/'
    const out: number[] = [];
    while (this.pos < this.buf.length && isReg(this.buf[this.pos])) {
      let b = this.buf[this.pos++];
      if (b === 35 && this.pos + 1 < this.buf.length) { // # hex escape
        b = parseInt(new TextDecoder('latin1').decode(this.buf.subarray(this.pos, this.pos + 2)), 16);
        this.pos += 2;
      }
      out.push(b);
    }
    return new TextDecoder('latin1').decode(Uint8Array.from(out));
  }

  private readLiteralString(): Uint8Array {
    this.pos++; // skip '('
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.buf.length) {
      let b = this.buf[this.pos++];
      if (b === 92) { // backslash escape
        const e = this.buf[this.pos++];
        switch (e) {
          case 110: out.push(10); break; // n
          case 114: out.push(13); break; // r
          case 116: out.push(9); break;  // t
          case 98: out.push(8); break;   // b
          case 102: out.push(12); break; // f
          case 40: out.push(40); break;
          case 41: out.push(41); break;
          case 92: out.push(92); break;
          case 13: if (this.buf[this.pos] === 10) this.pos++; break; // line continuation
          case 10: break;
          default:
            if (e >= 48 && e <= 55) { // up to 3 octal digits
              let oct = e - 48;
              for (let i = 0; i < 2 && this.buf[this.pos] >= 48 && this.buf[this.pos] <= 55; i++)
                oct = oct * 8 + (this.buf[this.pos++] - 48);
              out.push(oct & 0xff);
            } else out.push(e);
        }
        continue;
      }
      if (b === 40) { depth++; out.push(b); continue; }
      if (b === 41) { depth--; if (depth === 0) break; out.push(b); continue; }
      out.push(b);
    }
    return Uint8Array.from(out);
  }

  private readHexString(): Uint8Array {
    this.pos++; // skip '<'
    const digits: number[] = [];
    while (this.pos < this.buf.length && this.buf[this.pos] !== 62) {
      const b = this.buf[this.pos++];
      if (isWs(b)) continue;
      digits.push(b);
    }
    this.pos++; // skip '>'
    if (digits.length % 2 === 1) digits.push(48); // pad with '0'
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++)
      out[i] = parseInt(String.fromCharCode(digits[2 * i], digits[2 * i + 1]), 16);
    return out;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/lexer.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lexer.ts test/lexer.test.ts
git commit -m "feat: pdf lexer"
```

---

## Task 3: Object parser

**Files:**
- Create: `src/object-parser.ts`, `test/object-parser.test.ts`

Parses one `PdfObject` from a `Lexer`. Handles `n g R` references, `n g obj ... endobj` indirect objects, and `<< >> stream ... endstream`. Stream `Length` may be an indirect ref, so the parser accepts an optional resolver to find the stream end; if no resolver or indirect length, it falls back to scanning for `endstream`.

- [ ] **Step 1: Write failing test** — `test/object-parser.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Lexer } from '../src/lexer.js';
import { ObjectParser } from '../src/object-parser.js';
import { isDict, isStream, isRef } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const parse = (s: string) => new ObjectParser(new Lexer(enc(s))).parseObject();

describe('ObjectParser', () => {
  it('parses scalars and arrays', () => {
    expect(parse('42')).toBe(42);
    expect(parse('true')).toBe(true);
    expect(parse('null')).toBe(null);
    expect(parse('[1 2 3]')).toEqual([1, 2, 3]);
  });
  it('parses references vs numbers', () => {
    const r = parse('5 0 R');
    expect(isRef(r) && r.num).toBe(5);
  });
  it('parses dicts with nested values', () => {
    const d = parse('<< /Type /Page /Count 3 >>');
    expect(isDict(d)).toBe(true);
    if (isDict(d)) { expect((d.get('Count'))).toBe(3); }
  });
  it('parses streams', () => {
    const s = parse('<< /Length 5 >>\nstream\nHello\nendstream');
    expect(isStream(s)).toBe(true);
    if (isStream(s)) expect(new TextDecoder().decode(s.raw)).toBe('Hello');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/object-parser.test.ts`
Expected: FAIL — cannot find `../src/object-parser.js`.

- [ ] **Step 3: Implement `src/object-parser.ts`**

```ts
import { Lexer, Token } from './lexer.js';
import { PdfParseError } from './errors.js';
import { PdfObject, PdfDict, ref } from './types.js';

export type LengthResolver = (numOrValue: PdfObject) => number | undefined;

export class ObjectParser {
  constructor(private readonly lx: Lexer, private readonly resolveLength?: LengthResolver) {}

  /** Parse a single object starting at the lexer's current position. */
  parseObject(): PdfObject {
    return this.parseValue(this.lx.next());
  }

  /** Parse an indirect object: `n g obj <value> endobj`. Returns the value. */
  parseIndirectObject(): { num: number; gen: number; value: PdfObject } {
    const a = this.expect('num');
    const b = this.expect('num');
    const kw = this.lx.next();
    if (kw.t !== 'kw' || kw.v !== 'obj') throw new PdfParseError('expected obj', kw.pos);
    const value = this.parseValue(this.lx.next());
    return { num: a.v as number, gen: b.v as number, value };
  }

  private expect(t: Token['t']): Token {
    const tok = this.lx.next();
    if (tok.t !== t) throw new PdfParseError(`expected ${t} got ${tok.t}`, tok.pos);
    return tok;
  }

  private parseValue(tok: Token): PdfObject {
    switch (tok.t) {
      case 'num': return this.maybeRef(tok.v as number);
      case 'name': return { kind: 'name', name: tok.v as string };
      case 'str': return { kind: 'string', bytes: tok.v as Uint8Array };
      case 'kw':
        if (tok.v === 'true') return true;
        if (tok.v === 'false') return false;
        if (tok.v === 'null') return null;
        throw new PdfParseError(`unexpected keyword ${tok.v}`, tok.pos);
      case 'delim':
        if (tok.v === '[') return this.parseArray();
        if (tok.v === '<<') return this.parseDictOrStream();
        throw new PdfParseError(`unexpected ${tok.v}`, tok.pos);
      default: throw new PdfParseError(`unexpected token ${tok.t}`, tok.pos);
    }
  }

  // After reading a number, peek for `g R` (reference) or `g obj`. Otherwise it's just a number.
  private maybeRef(first: number): PdfObject {
    const save = this.lx.pos;
    const t2 = this.lx.next();
    if (t2.t === 'num') {
      const t3 = this.lx.next();
      if (t3.t === 'kw' && t3.v === 'R') return ref(first, t2.v as number);
    }
    this.lx.pos = save; // rewind: it was a plain number
    return first;
  }

  private parseArray(): PdfObject[] {
    const arr: PdfObject[] = [];
    for (;;) {
      const tok = this.lx.next();
      if (tok.t === 'delim' && tok.v === ']') return arr;
      if (tok.t === 'eof') throw new PdfParseError('unterminated array', tok.pos);
      arr.push(this.parseValue(tok));
    }
  }

  private parseDictOrStream(): PdfObject {
    const dict: PdfDict = new Map();
    for (;;) {
      const k = this.lx.next();
      if (k.t === 'delim' && k.v === '>>') break;
      if (k.t !== 'name') throw new PdfParseError('expected dict key', k.pos);
      dict.set(k.v as string, this.parseValue(this.lx.next()));
    }
    // Is a stream following?
    const save = this.lx.pos;
    const maybe = this.lx.next();
    if (maybe.t === 'kw' && maybe.v === 'stream') {
      return this.readStream(dict);
    }
    this.lx.pos = save;
    return dict;
  }

  private readStream(dict: PdfDict): PdfObject {
    // After the `stream` keyword: skip a single CRLF or LF.
    const buf = (this.lx as any).buf as Uint8Array;
    let p = this.lx.pos;
    if (buf[p] === 13) p++;
    if (buf[p] === 10) p++;
    const start = p;
    let end: number;
    const lenObj = dict.get('Length');
    const len = typeof lenObj === 'number' ? lenObj : this.resolveLength?.(lenObj!);
    if (typeof len === 'number' && len >= 0 && this.looksLikeEndstream(buf, start + len)) {
      end = start + len;
    } else {
      end = this.scanEndstream(buf, start);
    }
    const raw = buf.subarray(start, end);
    // advance lexer past endstream
    this.lx.pos = this.skipToAfterEndstream(buf, end);
    return { kind: 'stream', dict, raw };
  }

  private looksLikeEndstream(buf: Uint8Array, at: number): boolean {
    let p = at;
    while (p < buf.length && (buf[p] === 13 || buf[p] === 10 || buf[p] === 32)) p++;
    return this.matches(buf, p, 'endstream');
  }
  private scanEndstream(buf: Uint8Array, start: number): number {
    for (let p = start; p < buf.length - 8; p++) {
      if (this.matches(buf, p, 'endstream')) {
        let e = p;
        if (buf[e - 1] === 10) e--;
        if (buf[e - 1] === 13) e--;
        return e;
      }
    }
    throw new PdfParseError('endstream not found', start);
  }
  private skipToAfterEndstream(buf: Uint8Array, end: number): number {
    let p = end;
    while (p < buf.length && !this.matches(buf, p, 'endstream')) p++;
    return p + 'endstream'.length;
  }
  private matches(buf: Uint8Array, p: number, s: string): boolean {
    for (let i = 0; i < s.length; i++) if (buf[p + i] !== s.charCodeAt(i)) return false;
    return true;
  }
}
```

> Note: `Lexer` must expose `buf`. Add `readonly buf` access by changing the constructor field from `private readonly buf` to `readonly buf` in `src/lexer.ts`. Update the test-visible cast accordingly. Do this as part of Step 3.

- [ ] **Step 4: Adjust `src/lexer.ts` visibility**

Change `constructor(private readonly buf: Uint8Array, start = 0)` to `constructor(readonly buf: Uint8Array, start = 0)`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/object-parser.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/object-parser.ts src/lexer.ts test/object-parser.test.ts
git commit -m "feat: pdf object parser"
```

---

## Task 4: Predictor reversal

**Files:**
- Create: `src/predictor.ts`, `test/predictor.test.ts`

Reverses PNG (predictor >= 10) and TIFF (predictor 2) row predictors used by FlateDecode `/DecodeParms`. Needed for xref streams.

- [ ] **Step 1: Write failing test** — `test/predictor.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { applyPredictor } from '../src/predictor.js';

describe('applyPredictor', () => {
  it('returns input unchanged for predictor 1', () => {
    const d = Uint8Array.from([1, 2, 3, 4]);
    expect(Array.from(applyPredictor(d, { predictor: 1, colors: 1, bpc: 8, columns: 4 }))).toEqual([1, 2, 3, 4]);
  });
  it('reverses PNG Up filter (tag 2)', () => {
    // 2 rows, columns=3, each row prefixed by filter-tag byte.
    // row0 tag=2 (Up) data [10,20,30] -> previous row is zeros -> stays [10,20,30]
    // row1 tag=2 (Up) data [1,1,1] -> add previous row [10,20,30] -> [11,21,31]
    const input = Uint8Array.from([2, 10, 20, 30, 2, 1, 1, 1]);
    const out = applyPredictor(input, { predictor: 12, colors: 1, bpc: 8, columns: 3 });
    expect(Array.from(out)).toEqual([10, 20, 30, 11, 21, 31]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/predictor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/predictor.ts`**

```ts
export interface PredictorParams { predictor: number; colors: number; bpc: number; columns: number; }

export function applyPredictor(data: Uint8Array, p: PredictorParams): Uint8Array {
  if (p.predictor <= 1) return data;
  const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8));
  const rowLen = Math.ceil((p.colors * p.bpc * p.columns) / 8);
  if (p.predictor === 2) return tiffPredictor(data, bpp, rowLen); // TIFF
  return pngPredictor(data, bpp, rowLen); // PNG (>=10): per-row filter tag
}

function tiffPredictor(data: Uint8Array, bpp: number, rowLen: number): Uint8Array {
  const out = Uint8Array.from(data);
  for (let r = 0; r + rowLen <= out.length; r += rowLen)
    for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
  return out;
}

function pngPredictor(data: Uint8Array, bpp: number, rowLen: number): Uint8Array {
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const tag = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, r * (rowLen + 1) + 1 + rowLen);
    const cur = new Uint8Array(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;   // left
      const b = prev[i];                        // up
      const c = i >= bpp ? prev[i - bpp] : 0;   // upper-left
      let v = src[i];
      switch (tag) {
        case 0: break;                          // None
        case 1: v += a; break;                  // Sub
        case 2: v += b; break;                  // Up
        case 3: v += (a + b) >> 1; break;       // Average
        case 4: v += paeth(a, b, c); break;     // Paeth
      }
      cur[i] = v & 0xff;
    }
    out.set(cur, r * rowLen);
    prev = cur;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const pp = a + b - c;
  const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/predictor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/predictor.ts test/predictor.test.ts
git commit -m "feat: png/tiff predictor reversal"
```

---

## Task 5: Flate decode helper

**Files:**
- Create: `src/flate.ts`, `test/flate.test.ts`

Wraps Node `zlib.inflateSync` and applies predictors. Used only for xref/object streams.

- [ ] **Step 1: Write failing test** — `test/flate.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { inflateStream } from '../src/flate.js';
import type { PdfDict } from '../src/types.js';
import { name } from '../src/types.js';

describe('inflateStream', () => {
  it('inflates FlateDecode without predictor', () => {
    const raw = deflateSync(Buffer.from('hello world'));
    const dict: PdfDict = new Map([['Filter', name('FlateDecode')]]);
    const out = inflateStream({ kind: 'stream', dict, raw: new Uint8Array(raw) });
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/flate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/flate.ts`**

```ts
import { inflateSync } from 'node:zlib';
import { PdfStream, PdfObject, isName, isDict, isArray } from './types.js';
import { applyPredictor } from './predictor.js';
import { UnsupportedFeatureError } from './errors.js';

function num(o: PdfObject | undefined, dflt: number): number {
  return typeof o === 'number' ? o : dflt;
}

/** Decode a stream that uses (at most) a single FlateDecode filter + optional predictor.
 *  Throws UnsupportedFeatureError for other filters. Intended for xref/object streams. */
export function inflateStream(s: PdfStream): Uint8Array {
  const filter = s.dict.get('Filter');
  const filterName = isName(filter) ? filter.name
    : isArray(filter) && filter.length === 1 && isName(filter[0]) ? filter[0].name
    : undefined;
  if (filterName === undefined) return s.raw; // no filter
  if (filterName !== 'FlateDecode' && filterName !== 'Fl')
    throw new UnsupportedFeatureError(`unsupported filter for internal stream: ${filterName}`);

  const inflated = new Uint8Array(inflateSync(Buffer.from(s.raw)));
  const parms = s.dict.get('DecodeParms') ?? s.dict.get('DP');
  if (!isDict(parms)) return inflated;
  return applyPredictor(inflated, {
    predictor: num(parms.get('Predictor'), 1),
    colors: num(parms.get('Colors'), 1),
    bpc: num(parms.get('BitsPerComponent'), 8),
    columns: num(parms.get('Columns'), 1),
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/flate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flate.ts test/flate.test.ts
git commit -m "feat: flate inflate helper with predictors"
```

---

## Task 6: Fixture builder (test helper)

**Files:**
- Create: `test/helpers/build-pdf.ts`, `test/helpers/build-pdf.test.ts`

A hand-rolled PDF builder for tests. It writes objects and a **classic xref table**, computing offsets. It may use zlib freely (test-only). This is independent of `src/writer.ts` so writer tests aren't self-referential.

- [ ] **Step 1: Write failing test** — `test/helpers/build-pdf.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './build-pdf.js';

describe('buildClassicPdf', () => {
  it('produces a parseable 2-page PDF with valid startxref', () => {
    const pdf = buildClassicPdf(2);
    const s = new TextDecoder('latin1').decode(pdf);
    expect(s.startsWith('%PDF-1.7')).toBe(true);
    expect(s.includes('/Type /Catalog')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect((s.match(/\/Type \/Page\b/g) || []).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/helpers/build-pdf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `test/helpers/build-pdf.ts`**

```ts
const enc = (s: string) => new TextEncoder().encode(s);

/** Build a minimal classic-xref PDF with `pageCount` pages.
 *  Object layout: 1=Catalog, 2=Pages, then per page: Page dict + Contents stream. */
export function buildClassicPdf(pageCount: number): Uint8Array {
  const objects: string[] = []; // index 0 -> object 1
  const pageObjNums: number[] = [];
  let nextObj = 3 + pageCount * 0; // we will allocate explicitly
  // Allocate numbers: catalog=1, pages=2, pages start at 3.
  const firstPage = 3;
  for (let i = 0; i < pageCount; i++) pageObjNums.push(firstPage + i * 2);
  const kids = pageObjNums.map(n => `${n} 0 R`).join(' ');

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] /MediaBox [0 0 200 200] >>`;
  for (let i = 0; i < pageCount; i++) {
    const pageNum = pageObjNums[i];
    const contentNum = pageNum + 1;
    const stream = `BT /F1 24 Tf 20 100 Td (Page ${i + 1}) Tj ET`;
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${contentNum} 0 R >>`;
    objects[contentNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  const maxObj = 2 + pageCount * 2;

  // Serialize with offsets.
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function byteLen(s: string): number { return enc(s).length; }
```

> The `%PDF` header includes a binary comment line; `byteLen` uses UTF-8 encoding so offsets are correct for the high-byte comment characters.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/helpers/build-pdf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/build-pdf.ts test/helpers/build-pdf.test.ts
git commit -m "test: classic-xref pdf fixture builder"
```

---

## Task 7: Xref parser (classic tables)

**Files:**
- Create: `src/xref.ts`, `test/xref.test.ts`

Locate `startxref`, parse a classic xref table + trailer, follow `/Prev`. Produces an `XrefTable`:

```ts
export type XrefEntry =
  | { type: 'offset'; offset: number; gen: number }
  | { type: 'compressed'; streamObj: number; index: number };
export interface XrefResult { entries: Map<number, XrefEntry>; trailer: PdfDict; }
```

- [ ] **Step 1: Write failing test** — `test/xref.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { readXref } from '../src/xref.js';
import { isRef } from '../src/types.js';

describe('readXref (classic)', () => {
  it('reads entries and trailer Root', () => {
    const pdf = buildClassicPdf(2);
    const { entries, trailer } = readXref(pdf);
    expect(entries.get(1)?.type).toBe('offset');
    const root = trailer.get('Root');
    expect(isRef(root!) && root.num).toBe(1);
    // object 1 offset should point at "1 0 obj"
    const e = entries.get(1)!;
    if (e.type === 'offset') {
      const s = new TextDecoder('latin1').decode(pdf.subarray(e.offset, e.offset + 7));
      expect(s).toBe('1 0 obj');
    }
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/xref.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/xref.ts` (classic path only for now)**

```ts
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { PdfParseError } from './errors.js';
import { PdfDict, PdfObject, isDict } from './types.js';

export type XrefEntry =
  | { type: 'offset'; offset: number; gen: number }
  | { type: 'compressed'; streamObj: number; index: number };
export interface XrefResult { entries: Map<number, XrefEntry>; trailer: PdfDict; }

export function readXref(buf: Uint8Array): XrefResult {
  const start = findStartXref(buf);
  const entries = new Map<number, XrefEntry>();
  let trailer: PdfDict | undefined;
  const seen = new Set<number>();
  let pos: number | undefined = start;

  while (pos !== undefined && !seen.has(pos)) {
    seen.add(pos);
    const section = readXrefSection(buf, pos);
    // earlier sections must not overwrite newer entries
    for (const [num, e] of section.entries) if (!entries.has(num)) entries.set(num, e);
    if (!trailer) trailer = section.trailer;
    // Hybrid: /XRefStm points to a parallel xref stream
    const xrefStm = section.trailer.get('XRefStm');
    if (typeof xrefStm === 'number' && !seen.has(xrefStm)) {
      const hs = readXrefSection(buf, xrefStm);
      for (const [num, e] of hs.entries) if (!entries.has(num)) entries.set(num, e);
    }
    const prev = section.trailer.get('Prev');
    pos = typeof prev === 'number' ? prev : undefined;
  }
  if (!trailer) throw new PdfParseError('no trailer found');
  return { entries, trailer };
}

function findStartXref(buf: Uint8Array): number {
  const tail = new TextDecoder('latin1').decode(buf.subarray(Math.max(0, buf.length - 2048)));
  const idx = tail.lastIndexOf('startxref');
  if (idx < 0) throw new PdfParseError('startxref not found');
  const m = /startxref\s+(\d+)/.exec(tail.slice(idx));
  if (!m) throw new PdfParseError('malformed startxref');
  return parseInt(m[1], 10);
}

interface Section { entries: Map<number, XrefEntry>; trailer: PdfDict; }

function readXrefSection(buf: Uint8Array, pos: number): Section {
  // Classic table begins with keyword `xref`. Otherwise it's an xref stream (Task 8).
  const lx = new Lexer(buf, pos);
  const save = lx.pos;
  const first = lx.next();
  if (first.t === 'kw' && first.v === 'xref') return readClassicTable(buf, lx);
  // Not a classic table -> delegate to xref-stream reader (added in Task 8).
  return readXrefStream(buf, save);
}

function readClassicTable(buf: Uint8Array, lx: Lexer): Section {
  const entries = new Map<number, XrefEntry>();
  for (;;) {
    const save = lx.pos;
    const t = lx.next();
    if (t.t === 'kw' && t.v === 'trailer') break;
    if (t.t !== 'num') throw new PdfParseError('expected subsection start', t.pos);
    const startObj = t.v as number;
    const count = lx.next();
    if (count.t !== 'num') throw new PdfParseError('expected subsection count', count.pos);
    for (let i = 0; i < (count.v as number); i++) {
      const off = lx.next(); const gen = lx.next(); const kind = lx.next();
      if (off.t !== 'num' || gen.t !== 'num' || kind.t !== 'kw')
        throw new PdfParseError('malformed xref entry', off.pos);
      const num = startObj + i;
      if (kind.v === 'n' && !entries.has(num))
        entries.set(num, { type: 'offset', offset: off.v as number, gen: gen.v as number });
    }
    void save;
  }
  const trailer = new ObjectParser(lx).parseObject();
  if (!isDict(trailer)) throw new PdfParseError('trailer is not a dict');
  return { entries, trailer };
}

// Placeholder wired in Task 8. Declared here so Task 7 compiles & classic tests pass.
export function readXrefStream(_buf: Uint8Array, pos: number): Section {
  throw new PdfParseError('xref stream not yet supported', pos);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/xref.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/xref.ts test/xref.test.ts
git commit -m "feat: classic xref table parser with /Prev and /XRefStm wiring"
```

---

## Task 8: Xref streams + object streams

**Files:**
- Modify: `src/xref.ts` (replace `readXrefStream` placeholder)
- Create: `src/objstm.ts`, `test/xref-stream.test.ts`, `test/objstm.test.ts`
- Modify: `test/helpers/build-pdf.ts` (add `buildXrefStreamPdf`)

- [ ] **Step 1: Add xref-stream fixture to `test/helpers/build-pdf.ts`**

Append this export (uses zlib to build a compressed xref stream with a single 1-page worth of objects, no predictor for simplicity — W=[1 2 1]):

```ts
import { deflateSync } from 'node:zlib';

/** Build a PDF whose cross-reference is an xref STREAM (PDF 1.5+), 1 page, no predictor. */
export function buildXrefStreamPdf(): Uint8Array {
  const enc = (s: string) => new TextEncoder().encode(s);
  const byteLen = (s: string) => enc(s).length;
  // objs: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 = xref stream itself
  const stream = `BT /F1 24 Tf 20 100 Td (Hi) Tj ET`;
  const objs: Record<number, string> = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 200 200] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>`,
    4: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  };
  let body = '%PDF-1.5\n%âãÏÓ\n';
  const offsets: Record<number, number> = {};
  for (const n of [1, 2, 3, 4]) { offsets[n] = byteLen(body); body += `${n} 0 obj\n${objs[n]}\nendobj\n`; }
  const xrefObjNum = 5;
  const xrefOffset = byteLen(body);
  // Build W=[1 2 1] entries for objects 0..5
  const rows: number[][] = [];
  rows[0] = [0, 0, 255];                 // free head (gen 65535 truncated; fine for tests)
  for (const n of [1, 2, 3, 4]) rows[n] = [1, offsets[n], 0];
  rows[xrefObjNum] = [1, xrefOffset, 0]; // the xref stream object points to itself
  const W = [1, 2, 1];
  const bytes: number[] = [];
  for (let n = 0; n <= xrefObjNum; n++) {
    const [a, b, c] = rows[n];
    bytes.push(a & 0xff);
    bytes.push((b >> 8) & 0xff, b & 0xff);
    bytes.push(c & 0xff);
  }
  const packed = deflateSync(Buffer.from(Uint8Array.from(bytes)));
  const dict = `<< /Type /XRef /Size ${xrefObjNum + 1} /Root 1 0 R /W [1 2 1] /Filter /FlateDecode /Length ${packed.length} >>`;
  body += `${xrefObjNum} 0 obj\n${dict}\nstream\n`;
  const head = enc(body);
  const tail = enc(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`);
  const out = new Uint8Array(head.length + packed.length + tail.length);
  out.set(head, 0); out.set(packed, head.length); out.set(tail, head.length + packed.length);
  return out;
}
```

- [ ] **Step 2: Write failing test** — `test/xref-stream.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildXrefStreamPdf } from './helpers/build-pdf.js';
import { readXref } from '../src/xref.js';
import { isRef } from '../src/types.js';

describe('readXref (xref stream)', () => {
  it('parses W-formatted entries and trailer', () => {
    const pdf = buildXrefStreamPdf();
    const { entries, trailer } = readXref(pdf);
    expect(entries.get(3)?.type).toBe('offset');
    const root = trailer.get('Root');
    expect(isRef(root!) && root.num).toBe(1);
    const e = entries.get(1)!;
    if (e.type === 'offset') {
      const s = new TextDecoder('latin1').decode(pdf.subarray(e.offset, e.offset + 7));
      expect(s).toBe('1 0 obj');
    }
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `npx vitest run test/xref-stream.test.ts`
Expected: FAIL — `xref stream not yet supported`.

- [ ] **Step 4: Replace `readXrefStream` in `src/xref.ts`**

```ts
import { inflateStream } from './flate.js';
import { isStream } from './types.js';

export function readXrefStream(buf: Uint8Array, pos: number): Section {
  const parser = new ObjectParser(new Lexer(buf, pos));
  const { value } = parser.parseIndirectObject();
  if (!isStream(value)) throw new PdfParseError('xref stream object is not a stream', pos);
  const dict = value.dict;
  const data = inflateStream(value);
  const W = dict.get('W');
  if (!Array.isArray(W) || W.length !== 3) throw new PdfParseError('xref stream missing /W', pos);
  const [w0, w1, w2] = W as number[];
  const size = (dict.get('Size') as number) ?? 0;
  const indexArr = (dict.get('Index') as number[]) ?? [0, size];
  const rowLen = w0 + w1 + w2;
  const entries = new Map<number, XrefEntry>();
  let p = 0;
  const readField = (w: number): number => { let v = 0; for (let i = 0; i < w; i++) v = v * 256 + data[p++]; return v; };
  for (let s = 0; s < indexArr.length; s += 2) {
    let objNum = indexArr[s];
    const cnt = indexArr[s + 1];
    for (let i = 0; i < cnt; i++, objNum++) {
      if (p + rowLen > data.length) break;
      const f0 = w0 === 0 ? 1 : readField(w0); // default type 1 when W[0]=0
      const f1 = readField(w1);
      const f2 = readField(w2);
      if (entries.has(objNum)) continue;
      if (f0 === 1) entries.set(objNum, { type: 'offset', offset: f1, gen: f2 });
      else if (f0 === 2) entries.set(objNum, { type: 'compressed', streamObj: f1, index: f2 });
      // f0 === 0 -> free, skip
    }
  }
  return { entries, trailer: dict };
}
```

Remove the old placeholder `readXrefStream`. Move the new `import` lines to the top of the file.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/xref-stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Write failing test for object streams** — `test/objstm.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeObjStm } from '../src/objstm.js';
import { name } from '../src/types.js';

describe('decodeObjStm', () => {
  it('extracts packed objects by number', () => {
    const a = '<< /Type /Catalog /Pages 2 0 R >>';
    const b = '<< /Type /Pages /Count 0 /Kids [] >>';
    const header = `1 0 2 ${a.length + 1}`; // obj1 at off 0, obj2 after a + a space
    const payload = `${a} ${b}`;
    const first = header.length + 1;
    const body = `${header} ${payload}`;
    const raw = deflateSync(Buffer.from(body));
    const dict = new Map<string, any>([
      ['Type', name('ObjStm')], ['N', 2], ['First', first],
      ['Filter', name('FlateDecode')],
    ]);
    const objs = decodeObjStm({ kind: 'stream', dict, raw: new Uint8Array(raw) });
    expect(objs.get(1)).toBeDefined();
    expect(objs.get(2)).toBeDefined();
  });
});
```

- [ ] **Step 7: Run to verify fail**

Run: `npx vitest run test/objstm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 8: Implement `src/objstm.ts`**

```ts
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { inflateStream } from './flate.js';
import { PdfObject, PdfStream } from './types.js';
import { PdfParseError } from './errors.js';

/** Decode an /ObjStm into a map of objectNumber -> PdfObject. */
export function decodeObjStm(s: PdfStream): Map<number, PdfObject> {
  const n = s.dict.get('N'); const first = s.dict.get('First');
  if (typeof n !== 'number' || typeof first !== 'number')
    throw new PdfParseError('ObjStm missing /N or /First');
  const data = inflateStream(s);
  // Header: N pairs of "objNum offset".
  const lx = new Lexer(data, 0);
  const pairs: Array<{ num: number; off: number }> = [];
  for (let i = 0; i < n; i++) {
    const a = lx.next(); const b = lx.next();
    if (a.t !== 'num' || b.t !== 'num') throw new PdfParseError('malformed ObjStm header');
    pairs.push({ num: a.v as number, off: b.v as number });
  }
  const out = new Map<number, PdfObject>();
  for (const { num, off } of pairs) {
    const p = new ObjectParser(new Lexer(data, first + off));
    out.set(num, p.parseObject());
  }
  return out;
}
```

- [ ] **Step 9: Run to verify pass**

Run: `npx vitest run test/objstm.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/xref.ts src/objstm.ts test/xref-stream.test.ts test/objstm.test.ts test/helpers/build-pdf.ts
git commit -m "feat: xref streams and object streams"
```

---

## Task 9: Document model

**Files:**
- Create: `src/document.ts`, `test/document.test.ts`

`Document.open(bytes)` reads xref + trailer, guards `/Encrypt`, and resolves objects lazily (direct offset or via object stream), caching results.

- [ ] **Step 1: Write failing test** — `test/document.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { isDict, isName } from '../src/types.js';

describe('Document', () => {
  it('resolves catalog from classic pdf', () => {
    const doc = Document.open(buildClassicPdf(2));
    const cat = doc.catalog();
    expect(isDict(cat)).toBe(true);
    const type = cat.get('Type');
    expect(isName(type!) && type.name).toBe('Catalog');
  });
  it('resolves objects from xref-stream pdf', () => {
    const doc = Document.open(buildXrefStreamPdf());
    const cat = doc.catalog();
    const pages = doc.resolve(cat.get('Pages')!);
    expect(isDict(pages)).toBe(true);
  });
  it('throws on encrypted pdf', () => {
    const pdf = buildClassicPdf(1);
    // Inject an /Encrypt into the trailer by string surgery for the test.
    const s = new TextDecoder('latin1').decode(pdf).replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 99 0 R');
    expect(() => Document.open(new TextEncoder().encode(s))).toThrow(/encrypt/i);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/document.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/document.ts`**

```ts
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { readXref, XrefEntry } from './xref.js';
import { decodeObjStm } from './objstm.js';
import { PdfObject, PdfDict, isRef, isDict, isStream } from './types.js';
import { PdfParseError, UnsupportedFeatureError } from './errors.js';

export class Document {
  private cache = new Map<number, PdfObject>();
  private objStmCache = new Map<number, Map<number, PdfObject>>();

  private constructor(
    private readonly buf: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: PdfDict,
  ) {}

  static open(buf: Uint8Array): Document {
    const { entries, trailer } = readXref(buf);
    if (trailer.get('Encrypt') !== undefined)
      throw new UnsupportedFeatureError('encrypted PDFs are not supported');
    return new Document(buf, entries, trailer);
  }

  /** Resolve a value: if it's a ref, fetch the object; otherwise return as-is. */
  resolve(o: PdfObject | undefined): PdfObject {
    if (o === undefined) return null;
    if (isRef(o)) return this.getObject(o.num);
    return o;
  }

  catalog(): PdfDict {
    const root = this.resolve(this.trailer.get('Root'));
    if (!isDict(root)) throw new PdfParseError('catalog (Root) is not a dict');
    return root;
  }

  getObject(num: number): PdfObject {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;
    const entry = this.entries.get(num);
    if (!entry) return null;
    let value: PdfObject;
    if (entry.type === 'offset') {
      const parser = new ObjectParser(new Lexer(this.buf, entry.offset), (lenObj) => {
        const r = this.resolve(lenObj);
        return typeof r === 'number' ? r : undefined;
      });
      value = parser.parseIndirectObject().value;
    } else {
      value = this.fromObjStm(entry.streamObj, num);
    }
    this.cache.set(num, value);
    return value;
  }

  private fromObjStm(streamObj: number, wantNum: number): PdfObject {
    let map = this.objStmCache.get(streamObj);
    if (!map) {
      const s = this.getObject(streamObj);
      if (!isStream(s)) throw new PdfParseError(`object stream ${streamObj} is not a stream`);
      map = decodeObjStm(s);
      this.objStmCache.set(streamObj, map);
    }
    return map.get(wantNum) ?? null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/document.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/document.test.ts
git commit -m "feat: lazy pdf document model with encrypt guard"
```

---

## Task 10: Page tree walker

**Files:**
- Create: `src/pagetree.ts`, `test/pagetree.test.ts`

Walks the `Pages` tree depth-first, yielding each `Page` dict in order with inherited attributes (`Resources`, `MediaBox`, `CropBox`, `Rotate`) materialized onto a shallow copy. Guards against cycles.

- [ ] **Step 1: Write failing test** — `test/pagetree.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { listPages } from '../src/pagetree.js';
import { isArray } from '../src/types.js';

describe('listPages', () => {
  it('returns pages in order with inherited MediaBox', () => {
    const doc = Document.open(buildClassicPdf(3));
    const pages = listPages(doc);
    expect(pages.length).toBe(3);
    // MediaBox is defined on Pages node and must be inherited onto each page.
    const mb = pages[0].dict.get('MediaBox');
    expect(isArray(mb!) && (mb as any[]).length).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/pagetree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/pagetree.ts`**

```ts
import { Document } from './document.js';
import { PdfDict, PdfObject, isDict, isArray, isName } from './types.js';
import { PdfParseError } from './errors.js';

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

export interface PageRef { dict: PdfDict; }

export function listPages(doc: Document): PageRef[] {
  const catalog = doc.catalog();
  const pagesRoot = doc.resolve(catalog.get('Pages'));
  if (!isDict(pagesRoot)) throw new PdfParseError('catalog /Pages is not a dict');
  const out: PageRef[] = [];
  walk(doc, pagesRoot, {}, new Set(), out);
  return out;
}

function walk(
  doc: Document, node: PdfDict,
  inherited: Partial<Record<string, PdfObject>>,
  seen: Set<PdfDict>, out: PageRef[],
): void {
  if (seen.has(node)) throw new PdfParseError('cycle in page tree');
  seen.add(node);
  const merged = { ...inherited };
  for (const key of INHERITABLE) if (node.has(key)) merged[key] = node.get(key)!;

  const type = node.get('Type');
  const kids = doc.resolve(node.get('Kids'));
  if (isName(type) && type.name === 'Page') {
    out.push({ dict: materialize(node, merged) });
    return;
  }
  if (isArray(kids)) {
    for (const kid of kids) {
      const child = doc.resolve(kid);
      if (isDict(child)) walk(doc, child, merged, seen, out);
    }
    return;
  }
  // Leaf without explicit /Type but no kids: treat as page.
  out.push({ dict: materialize(node, merged) });
}

function materialize(page: PdfDict, inherited: Partial<Record<string, PdfObject>>): PdfDict {
  const copy: PdfDict = new Map(page);
  for (const key of INHERITABLE) if (!copy.has(key) && inherited[key] !== undefined)
    copy.set(key, inherited[key]!);
  return copy;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pagetree.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pagetree.ts test/pagetree.test.ts
git commit -m "feat: page tree walker with attribute inheritance"
```

---

## Task 11: Extractor (reachable set + prune policy)

**Files:**
- Create: `src/extractor.ts`, `test/extractor.test.ts`

Given a page dict (already inheritance-materialized) and the document, collect a map `oldObjNum -> resolved PdfObject` of everything the page needs, following references via BFS. Pruning is a **policy object** so future form-field work extends it. Default policy:
- Skip keys on the page dict: `Parent`, `B`, `StructParents`, `Annots` (handled specially), and never follow document-level trees (we start from the page so those aren't referenced anyway).
- For `Annots`: keep each annotation, but if its `/A` action is a same-document `GoTo`, or its `/Dest` is present (array to another page or a name), strip `/A` and `/Dest` from a copy. `URI`/`GoToR` actions are kept.

Because we start traversal at the page (not the catalog), document-level trees are naturally excluded. The explicit skips prevent climbing back up via `/Parent` or sideways via struct linkage.

- [ ] **Step 1: Write failing test** — `test/extractor.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { listPages } from '../src/pagetree.js';
import { extractPage, defaultPrunePolicy } from '../src/extractor.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { isDict } from '../src/types.js';

describe('extractPage', () => {
  it('collects page + contents, excludes /Parent', () => {
    const doc = Document.open(buildClassicPdf(2));
    const page = listPages(doc)[0];
    const { objects, pageNum } = extractPage(doc, page.dict, defaultPrunePolicy());
    // The page object itself and its contents stream must be present.
    expect(objects.size).toBeGreaterThanOrEqual(2);
    const pageObj = objects.get(pageNum);
    expect(isDict(pageObj!)).toBe(true);
    if (isDict(pageObj!)) expect(pageObj.has('Parent')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/extractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/extractor.ts`**

```ts
import { Document } from './document.js';
import {
  PdfObject, PdfDict, PdfArray, isRef, isDict, isArray, isStream, isName, PdfRef,
} from './types.js';

export interface PrunePolicy {
  /** Page-dict keys removed from the emitted page object entirely. */
  dropPageKeys: Set<string>;
  /** Sanitize the /Annots array; return a new array (resolved annotation dicts). */
  sanitizeAnnots(doc: Document, annots: PdfArray): PdfArray;
}

export function defaultPrunePolicy(): PrunePolicy {
  return {
    dropPageKeys: new Set(['Parent', 'B', 'StructParents']),
    sanitizeAnnots(doc, annots) {
      const out: PdfArray = [];
      for (const a of annots) {
        const annot = doc.resolve(a);
        if (!isDict(annot)) continue;
        const copy: PdfDict = new Map(annot);
        copy.delete('P'); // back-reference to the page object
        const action = doc.resolve(copy.get('A'));
        const subtype = isName(action) ? undefined : isDict(action) ? action.get('S') : undefined;
        const isGoTo = isDict(action) && isName(action.get('S')) && (action.get('S') as any).name === 'GoTo';
        if (isGoTo) copy.delete('A');
        if (copy.has('Dest')) copy.delete('Dest'); // dest leaves the page; strip
        void subtype;
        out.push(copy);
      }
      return out;
    },
  };
}

export interface Extraction { objects: Map<number, PdfObject>; pageNum: number; }

/** Build the self-contained object set for one page. Returns a synthetic page number
 *  (we assign the page object the next free number) and the collected objects keyed by
 *  their ORIGINAL object numbers, except the page itself which gets `pageNum`. */
export function extractPage(doc: Document, pageDict: PdfDict, policy: PrunePolicy): Extraction {
  const objects = new Map<number, PdfObject>();
  // Prepare the page object: drop unwanted keys, sanitize annots.
  const page: PdfDict = new Map(pageDict);
  for (const k of policy.dropPageKeys) page.delete(k);
  if (page.has('Annots')) {
    const annots = doc.resolve(page.get('Annots'));
    page.set('Annots', isArray(annots) ? policy.sanitizeAnnots(doc, annots) : []);
  }

  // We renumber as we go. Assign the page object number 1 conceptually here, but
  // final renumbering happens in the writer. For now use a local counter and map
  // original refs -> new numbers.
  const newNumByOld = new Map<number, number>();
  let next = 1;
  const pageNum = next++;
  objects.set(pageNum, page);

  // BFS over the page's *values* (not its dropped keys), rewriting refs in place.
  const queue: PdfObject[] = [page];
  const enqueueRef = (r: PdfRef): PdfRef => {
    let nn = newNumByOld.get(r.num);
    if (nn === undefined) {
      nn = next++;
      newNumByOld.set(r.num, nn);
      const resolved = doc.getObject(r.num);
      objects.set(nn, cloneShallow(resolved));
      queue.push(objects.get(nn)!);
    }
    return { kind: 'ref', num: nn, gen: 0 };
  };

  while (queue.length) {
    const cur = queue.shift()!;
    rewriteRefs(cur, enqueueRef);
  }
  return { objects, pageNum };
}

function cloneShallow(o: PdfObject): PdfObject {
  if (isDict(o)) return new Map(o);
  if (isArray(o)) return [...o];
  if (isStream(o)) return { kind: 'stream', dict: new Map(o.dict), raw: o.raw };
  return o;
}

/** Replace every PdfRef inside container `o` with policy-mapped refs (mutates o). */
function rewriteRefs(o: PdfObject, map: (r: PdfRef) => PdfRef): void {
  if (isArray(o)) {
    for (let i = 0; i < o.length; i++) o[i] = isRef(o[i]) ? map(o[i] as PdfRef) : passthrough(o[i], map);
  } else if (isDict(o)) {
    for (const [k, v] of o) o.set(k, isRef(v) ? map(v) : passthrough(v, map));
  } else if (isStream(o)) {
    for (const [k, v] of o.dict) o.dict.set(k, isRef(v) ? map(v) : passthrough(v, map));
  }
}

/** For nested arrays/dicts found inline, clone+rewrite so we don't mutate doc cache. */
function passthrough(v: PdfObject, map: (r: PdfRef) => PdfRef): PdfObject {
  if (isArray(v)) { const c = [...v]; rewriteRefs(c, map); return c; }
  if (isDict(v)) { const c = new Map(v); rewriteRefs(c, map); return c; }
  return v;
}
```

> Renumbering is performed here for simplicity (page = object 1, then BFS order). The writer (Task 12) consumes `objects` as already-renumbered. This keeps the writer trivial.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/extractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Add annotation-pruning test** — append to `test/extractor.test.ts`

```ts
import { name, ref } from '../src/types.js';

it('strips GoTo actions but keeps URI links', () => {
  const doc = Document.open(buildClassicPdf(1));
  const policy = defaultPrunePolicy();
  const goto = new Map<string, any>([['S', name('GoTo')]]);
  const uri = new Map<string, any>([['S', name('URI')], ['URI', { kind: 'string', bytes: new TextEncoder().encode('http://x') }]]);
  const a1 = new Map<string, any>([['Subtype', name('Link')], ['A', goto]]);
  const a2 = new Map<string, any>([['Subtype', name('Link')], ['A', uri]]);
  const out = policy.sanitizeAnnots(doc, [a1, a2]);
  expect(out[0].has('A')).toBe(false);      // GoTo stripped
  expect(out[1].has('A')).toBe(true);       // URI kept
});
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run test/extractor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add src/extractor.ts test/extractor.test.ts
git commit -m "feat: per-page extractor with policy-driven pruning"
```

---

## Task 12: Writer (serialize single-page PDF)

**Files:**
- Create: `src/writer.ts`, `test/writer.test.ts`

Takes the renumbered `objects` map + the page object number and emits a complete PDF: header, body (objects 1..N), a new Catalog and Pages node appended as the last two objects, classic xref table, trailer. Serializes every `PdfObject` back to bytes; stream payloads written verbatim with their existing dict (we must recompute `/Length` to match `raw`).

- [ ] **Step 1: Write failing test** — `test/writer.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { writeSinglePagePdf } from '../src/writer.js';
import { Document } from '../src/document.js';
import { listPages } from '../src/pagetree.js';
import { isName } from '../src/types.js';

describe('writeSinglePagePdf', () => {
  it('produces a parseable single-page pdf', () => {
    // Build a tiny object set by hand: object 1 = page, object 2 = contents stream.
    const content = new TextEncoder().encode('BT /F1 12 Tf (x) Tj ET');
    const page = new Map<string, any>([
      ['Type', { kind: 'name', name: 'Page' }],
      ['MediaBox', [0, 0, 100, 100]],
      ['Resources', new Map()],
      ['Contents', { kind: 'ref', num: 2, gen: 0 }],
    ]);
    const stream = { kind: 'stream', dict: new Map([['Length', content.length]]), raw: content };
    const objects = new Map<number, any>([[1, page], [2, stream]]);
    const pdf = writeSinglePagePdf(objects, 1);

    const doc = Document.open(pdf);
    const pages = listPages(doc);
    expect(pages.length).toBe(1);
    const type = pages[0].dict.get('Type');
    expect(isName(type!) && (type as any).name).toBe('Page');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/writer.ts`**

```ts
import { PdfObject, PdfDict, PdfArray, PdfStream, isRef, isName, isDict, isArray, isStream } from './types.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** Serialize a renumbered object set into a single-page PDF.
 *  `objects` keys are 1..N (page object = `pageObjNum`). We append a Pages node and
 *  Catalog as two new objects, then write a classic xref table + trailer. */
export function writeSinglePagePdf(objects: Map<number, PdfObject>, pageObjNum: number): Uint8Array {
  const maxExisting = Math.max(...objects.keys());
  const pagesNum = maxExisting + 1;
  const catalogNum = maxExisting + 2;

  // Ensure the page points to the new Pages node.
  const page = objects.get(pageObjNum);
  if (isDict(page)) page.set('Parent', { kind: 'ref', num: pagesNum, gen: 0 });

  const pagesNode: PdfDict = new Map<string, PdfObject>([
    ['Type', { kind: 'name', name: 'Pages' }],
    ['Count', 1],
    ['Kids', [{ kind: 'ref', num: pageObjNum, gen: 0 }]],
  ]);
  const catalog: PdfDict = new Map<string, PdfObject>([
    ['Type', { kind: 'name', name: 'Catalog' }],
    ['Pages', { kind: 'ref', num: pagesNum, gen: 0 }],
  ]);

  const all = new Map(objects);
  all.set(pagesNum, pagesNode);
  all.set(catalogNum, catalog);

  const chunks: Uint8Array[] = [];
  let length = 0;
  const push = (b: Uint8Array) => { chunks.push(b); length += b.length; };

  push(enc('%PDF-1.7\n%âãÏÓ\n'));
  const offsets = new Map<number, number>();
  for (let n = 1; n <= catalogNum; n++) {
    const obj = all.get(n);
    if (obj === undefined) continue;
    offsets.set(n, length);
    push(enc(`${n} 0 obj\n`));
    push(serializeObject(obj));
    push(enc('\nendobj\n'));
  }

  const xrefStart = length;
  let xref = `xref\n0 ${catalogNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= catalogNum; n++) {
    const off = offsets.get(n);
    xref += off === undefined ? `0000000000 65535 f \n` : `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  push(enc(xref));
  push(enc(`trailer\n<< /Size ${catalogNum + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`));

  const out = new Uint8Array(length);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function serializeObject(o: PdfObject): Uint8Array {
  if (isStream(o)) return serializeStream(o);
  return enc(serializeValue(o));
}

function serializeValue(o: PdfObject): string {
  if (o === null) return 'null';
  if (typeof o === 'boolean') return o ? 'true' : 'false';
  if (typeof o === 'number') return Number.isInteger(o) ? String(o) : String(o);
  if (isRef(o)) return `${o.num} ${o.gen} R`;
  if (isName(o)) return `/${escapeName(o.name)}`;
  if (isArray(o)) return `[${(o as PdfArray).map(serializeValue).join(' ')}]`;
  if (isDict(o)) return serializeDict(o);
  if ((o as any).kind === 'string') return serializeString((o as any).bytes);
  throw new Error('cannot serialize object');
}

function serializeDict(d: PdfDict): string {
  let s = '<<';
  for (const [k, v] of d) s += ` /${escapeName(k)} ${serializeValue(v)}`;
  return s + ' >>';
}

function serializeStream(s: PdfStream): Uint8Array {
  const dict: PdfDict = new Map(s.dict);
  dict.set('Length', s.raw.length); // recompute to match verbatim payload
  const head = enc(serializeDict(dict) + '\nstream\n');
  const tail = enc('\nendstream');
  const out = new Uint8Array(head.length + s.raw.length + tail.length);
  out.set(head, 0); out.set(s.raw, head.length); out.set(tail, head.length + s.raw.length);
  return out;
}

function escapeName(n: string): string {
  let out = '';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) out += '#' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

function serializeString(bytes: Uint8Array): string {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b === 10) s += '\\n';
    else if (b === 13) s += '\\r';
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/writer.ts test/writer.test.ts
git commit -m "feat: single-page pdf writer with classic xref"
```

---

## Task 13: Public API `splitPdf` + integration

**Files:**
- Create: `src/split.ts`, `test/split.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing integration test** — `test/split.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { splitPdf } from '../src/split.js';
import { buildClassicPdf, buildXrefStreamPdf } from './helpers/build-pdf.js';
import { Document } from '../src/document.js';
import { listPages } from '../src/pagetree.js';

function pageCount(pdf: Uint8Array): number {
  return listPages(Document.open(pdf)).length;
}

describe('splitPdf', () => {
  it('splits a 3-page classic pdf into 3 single-page pdfs', () => {
    const out = splitPdf(buildClassicPdf(3));
    expect(out.length).toBe(3);
    for (const p of out) expect(pageCount(p)).toBe(1);          // round-trip invariant
  });
  it('splits an xref-stream pdf', () => {
    const out = splitPdf(buildXrefStreamPdf());
    expect(out.length).toBe(1);
    expect(pageCount(out[0])).toBe(1);
  });
  it('preserves page content bytes', () => {
    const out = splitPdf(buildClassicPdf(2));
    const s = new TextDecoder('latin1').decode(out[1]);
    expect(s.includes('Page 2')).toBe(true);                   // 2nd output has 2nd page content
  });
  it('returns empty array for zero-page document', () => {
    // Build a catalog with an empty Pages tree by surgery on a 1-page pdf.
    const base = new TextDecoder('latin1').decode(buildClassicPdf(1));
    const zeroed = base.replace('/Count 1 /Kids [3 0 R]', '/Count 0 /Kids []');
    expect(splitPdf(new TextEncoder().encode(zeroed)).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/split.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/split.ts`**

```ts
import { Document } from './document.js';
import { listPages } from './pagetree.js';
import { extractPage, defaultPrunePolicy, PrunePolicy } from './extractor.js';
import { writeSinglePagePdf } from './writer.js';

export interface SplitOptions { prunePolicy?: PrunePolicy; }

/** Split a PDF into one self-contained single-page PDF per page, in page order. */
export function splitPdf(input: Uint8Array, options: SplitOptions = {}): Uint8Array[] {
  const doc = Document.open(input);
  const policy = options.prunePolicy ?? defaultPrunePolicy();
  const pages = listPages(doc);
  return pages.map(({ dict }) => {
    const { objects, pageNum } = extractPage(doc, dict, policy);
    return writeSinglePagePdf(objects, pageNum);
  });
}
```

- [ ] **Step 4: Update `src/index.ts`**

```ts
export { splitPdf } from './split.js';
export type { SplitOptions } from './split.js';
export { defaultPrunePolicy } from './extractor.js';
export type { PrunePolicy } from './extractor.js';
export { PdfParseError, UnsupportedFeatureError } from './errors.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/split.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/split.ts src/index.ts test/split.test.ts
git commit -m "feat: public splitPdf API + integration tests"
```

---

## Task 14: Node file wrapper

**Files:**
- Create: `src/node.ts`, `test/node.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing test** — `test/node.test.ts`

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitPdfFile } from '../src/node.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

const dir = mkdtempSync(join(tmpdir(), 'pdfsplit-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('splitPdfFile', () => {
  it('writes one file per page', async () => {
    const input = join(dir, 'in.pdf');
    writeFileSync(input, buildClassicPdf(2));
    const outDir = join(dir, 'out');
    const written = await splitPdfFile(input, outDir);
    expect(written.length).toBe(2);
    expect(readdirSync(outDir).sort()).toEqual(['page-1.pdf', 'page-2.pdf']);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/node.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/node.ts`**

```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { splitPdf, SplitOptions } from './split.js';

/** Read a PDF from disk, split it, and write `page-N.pdf` files into `outDir`. */
export async function splitPdfFile(inputPath: string, outDir: string, options?: SplitOptions): Promise<string[]> {
  const input = new Uint8Array(await readFile(inputPath));
  const pages = splitPdf(input, options);
  await mkdir(outDir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const p = join(outDir, `page-${i + 1}.pdf`);
    await writeFile(p, pages[i]);
    paths.push(p);
  }
  return paths;
}
```

- [ ] **Step 4: Add to `src/index.ts`**

Append: `export { splitPdfFile } from './node.js';`

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/node.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/node.ts src/index.ts test/node.test.ts
git commit -m "feat: splitPdfFile node wrapper"
```

---

## Task 15: Full suite + typecheck gate

**Files:** none (verification task)

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`
Expected: ALL tests pass.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 3: Build**

Run: `npx tsc -p tsconfig.json`
Expected: `dist/` produced with `.js` + `.d.ts`.

- [ ] **Step 4: Final commit (if any build config changed)**

```bash
git add -A
git commit -m "chore: verify full suite green and build clean"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** classic xref (T7), xref streams + object streams (T8), incremental/`/Prev` + hybrid `/XRefStm` (T7 chain logic), linearized (handled by following `startxref`/`/Prev` like any file — no special path needed), predictors (T4), Node `zlib` for inflate only (T5), bytes-in/bytes-out core (T13) + Node wrapper (T14), verbatim streams (T12 copies `raw`, recomputes `/Length`), classic-xref output (T12), inherited page attrs (T10), prune-cross-page keep-annotation (T11), policy-driven pruning for future form-field fidelity (T11 `PrunePolicy`), `/Encrypt` → `UnsupportedFeatureError` (T9), round-trip invariant (T13 re-parses outputs).
- **Type consistency:** `XrefEntry`, `Section`, `PdfObject`, `PrunePolicy`, `Extraction` names are used consistently across tasks. `writeSinglePagePdf(objects, pageObjNum)` matches `extractPage` output shape `{ objects, pageNum }`.
- **Staged stubs:** the `readXrefStream` placeholder in Task 7 is intentionally replaced in Task 8 (classic-xref tests pass meanwhile). No other placeholders remain.
