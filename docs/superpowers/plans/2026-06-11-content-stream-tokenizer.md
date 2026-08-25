# Content-stream tokenizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `src/content.ts` — a tokenizer that turns decoded content-stream bytes into a faithful, re-serializable `ContentOp[]` stream, plus the inverse serializer.

**Architecture:** Drive the existing `Lexer` (`src/lexer.ts`) over the bytes; accumulate operand values (reusing the `PdfObject` union) and flush an op each time an operator keyword appears. Inline images (`BI`/`ID`/`EI`) are captured as a synthetic `BI` op carrying the image dict + raw data. The serializer reuses `serializeValue` (`src/serialize.ts`). No semantic interpretation; unknown operators pass through verbatim.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest. Run a single test file with `npx vitest run test/content.test.ts`.

Spec: `docs/superpowers/specs/2026-06-11-content-stream-tokenizer-design.md`

---

## File Structure

- **Create `src/content.ts`** — the whole subsystem: `ContentOp` interface, `parseContentStream`, `serializeContentStream`, and private helpers (operand reader, inline-image reader, byte concat).
- **Create `test/content.test.ts`** — all tests.
- **Modify `src/index.ts`** — re-export the public API.

---

## Task 1: Tokenizer core — operands + operators

Parses scalar operands (numbers, names, strings), array/dict operands, booleans/null, and flushes an op on each operator keyword. Zero-operand operators (`q`, `Q`, `BT`, `ET`) produce `operands: []`. Inline images and serialization come later.

**Files:**
- Create: `src/content.ts`
- Test: `test/content.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/content.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseContentStream } from '../src/content.js';
import { PdfDict } from '../src/types.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

describe('parseContentStream', () => {
  it('tokenizes a text block into ops with operands', () => {
    const ops = parseContentStream(enc('BT /F1 24 Tf 100 700 Td (Hello World) Tj ET'));
    expect(ops.map(o => o.operator)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET']);
    expect(ops[0].operands).toEqual([]);                       // BT
    expect(ops[1].operands).toEqual([{ kind: 'name', name: 'F1' }, 24]); // Tf
    expect(ops[2].operands).toEqual([100, 700]);               // Td
    expect(ops[3].operands.length).toBe(1);                    // Tj
    expect(dec((ops[3].operands[0] as any).bytes)).toBe('Hello World');
    expect(ops[4].operands).toEqual([]);                       // ET
  });

  it('handles zero-operand graphics operators', () => {
    const ops = parseContentStream(enc('q 1 0 0 1 50 50 cm Q'));
    expect(ops.map(o => o.operator)).toEqual(['q', 'cm', 'Q']);
    expect(ops[1].operands).toEqual([1, 0, 0, 1, 50, 50]);
  });

  it('parses a TJ array operand', () => {
    const ops = parseContentStream(enc('[(A) -250 (B)] TJ'));
    expect(ops.length).toBe(1);
    expect(ops[0].operator).toBe('TJ');
    const arr = ops[0].operands[0] as any[];
    expect(dec(arr[0].bytes)).toBe('A');
    expect(arr[1]).toBe(-250);
    expect(dec(arr[2].bytes)).toBe('B');
  });

  it('parses a dict operand (marked content) and hex strings', () => {
    const ops = parseContentStream(enc('/Span <</MCID 0>> BDC <48656C6C6F> Tj EMC'));
    expect(ops.map(o => o.operator)).toEqual(['BDC', 'Tj', 'EMC']);
    const d = ops[0].operands[1] as PdfDict;
    expect(d.get('MCID')).toBe(0);
    expect(dec((ops[1].operands[0] as any).bytes)).toBe('Hello');
  });

  it('treats true/false/null as operands, not operators', () => {
    const ops = parseContentStream(enc('true /GS1 gs'));
    expect(ops.length).toBe(1);
    expect(ops[0].operator).toBe('gs');
    expect(ops[0].operands).toEqual([true, { kind: 'name', name: 'GS1' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseContentStream(enc('   '))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/content.test.ts`
Expected: FAIL — cannot resolve `../src/content.js`.

- [ ] **Step 3: Write the implementation**

Create `src/content.ts`:

```ts
import { Lexer, Token } from './lexer.js';
import { PdfObject, PdfDict } from './types.js';

export interface ContentOp {
  readonly operator: string;
  readonly operands: PdfObject[];
  /** Present only when operator === 'BI' (inline image). */
  readonly inlineImage?: { readonly dict: PdfDict; readonly data: Uint8Array };
}

const WS = new Set([0, 9, 10, 12, 13, 32]);

/** Tokenize decoded content-stream bytes into an op stream. */
export function parseContentStream(buf: Uint8Array): ContentOp[] {
  const lx = new Lexer(buf);
  const ops: ContentOp[] = [];
  let operands: PdfObject[] = [];
  for (;;) {
    const tok = lx.next();
    if (tok.t === 'eof') break;
    if (tok.t === 'kw') {
      if (tok.v === 'true') { operands.push(true); continue; }
      if (tok.v === 'false') { operands.push(false); continue; }
      if (tok.v === 'null') { operands.push(null); continue; }
      // (inline images handled in a later task)
      ops.push({ operator: tok.v, operands });
      operands = [];
      continue;
    }
    if (tok.t === 'delim' && (tok.v === ']' || tok.v === '>>')) continue; // stray close
    operands.push(valueFromToken(lx, tok));
  }
  return ops;
}

/** Build an operand value from an already-read token. No indirect-ref
 *  detection: content streams contain none. */
function valueFromToken(lx: Lexer, tok: Token): PdfObject {
  switch (tok.t) {
    case 'num': return tok.v;
    case 'name': return { kind: 'name', name: tok.v };
    case 'str': return { kind: 'string', bytes: tok.v };
    case 'delim':
      if (tok.v === '[') return readArray(lx);
      if (tok.v === '<<') return readDict(lx);
      return null;
    case 'kw':
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      return null; // 'null' and anything unexpected
    default: return null;
  }
}

function readArray(lx: Lexer): PdfObject[] {
  const arr: PdfObject[] = [];
  for (;;) {
    const tok = lx.next();
    if (tok.t === 'eof') break;
    if (tok.t === 'delim' && tok.v === ']') break;
    arr.push(valueFromToken(lx, tok));
  }
  return arr;
}

function readDict(lx: Lexer): PdfDict {
  const d: PdfDict = new Map();
  for (;;) {
    const k = lx.next();
    if (k.t === 'eof') break;
    if (k.t === 'delim' && k.v === '>>') break;
    if (k.t !== 'name') continue; // skip malformed
    d.set(k.v, valueFromToken(lx, lx.next()));
  }
  return d;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/content.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content.ts test/content.test.ts
git commit -m "feat: content-stream tokenizer core (6lc)"
```

---

## Task 2: Inline images (BI / ID / EI)

Capture an inline image as a synthetic `BI` op carrying the image dict (entries between `BI` and `ID`) and the raw data bytes (between `ID` and `EI`).

**Files:**
- Modify: `src/content.ts`
- Test: `test/content.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('parseContentStream', ...)` block in `test/content.test.ts`:

```ts
  it('captures an inline image as a BI op with dict + data', () => {
    const data = '\x01\x02\x03\x04';
    const ops = parseContentStream(enc(`q BI /W 2 /H 2 /CS /RGB /BPC 8 ID ${data}\nEI Q`));
    expect(ops.map(o => o.operator)).toEqual(['q', 'BI', 'Q']);
    const img = ops[1].inlineImage!;
    expect(img.dict.get('W')).toBe(2);
    expect(img.dict.get('H')).toBe(2);
    expect((img.dict.get('CS') as any).name).toBe('RGB');
    expect(dec(img.data)).toBe(data);
  });

  it('handles inline-image data that contains the bytes "EI"', () => {
    // 'EI' appears mid-data but is NOT whitespace-delimited, so it is not the terminator.
    const data = 'xEIx';
    const ops = parseContentStream(enc(`BI /W 1 /H 1 ID ${data}\nEI`));
    expect(ops.length).toBe(1);
    expect(dec(ops[0].inlineImage!.data)).toBe(data);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/content.test.ts`
Expected: FAIL — `BI` is currently emitted as a plain operator, so `ops[1].inlineImage` is `undefined` and the operator list is wrong.

- [ ] **Step 3: Implement inline-image handling**

In `src/content.ts`, replace the comment line `// (inline images handled in a later task)` inside `parseContentStream` with:

```ts
      if (tok.v === 'BI') { ops.push(readInlineImage(lx)); operands = []; continue; }
```

Then add these helpers at the end of `src/content.ts`:

```ts
function matches(buf: Uint8Array, p: number, s: string): boolean {
  for (let i = 0; i < s.length; i++) if (buf[p + i] !== s.charCodeAt(i)) return false;
  return true;
}

/** Find the terminating `EI` for inline-image data starting at `start`.
 *  Heuristic: an `EI` preceded by whitespace and followed by whitespace/EOF
 *  (raw image bytes can legitimately contain "EI"). Returns the data end
 *  (excluding the single delimiter whitespace) and the position just past EI. */
function findEI(buf: Uint8Array, start: number): { end: number; after: number } {
  for (let p = start + 1; p < buf.length - 1; p++) {
    if (buf[p] === 0x45 /*E*/ && buf[p + 1] === 0x49 /*I*/ && WS.has(buf[p - 1])) {
      const next = buf[p + 2];
      if (next === undefined || WS.has(next)) return { end: p - 1, after: p + 2 };
    }
  }
  return { end: buf.length, after: buf.length };
}

function readInlineImage(lx: Lexer): ContentOp {
  const dict: PdfDict = new Map();
  for (;;) {
    const k = lx.next();
    if (k.t === 'eof' || (k.t === 'kw' && k.v === 'ID')) break;
    if (k.t !== 'name') continue; // skip malformed
    dict.set(k.v, valueFromToken(lx, lx.next()));
  }
  const buf = lx.buf;
  let start = lx.pos;
  if (start < buf.length && WS.has(buf[start])) start++; // single whitespace after ID
  // Honor an explicit length (/L or /Length) when it lands on a whitespace-delimited EI.
  const len = dict.get('L') ?? dict.get('Length');
  if (typeof len === 'number' && len >= 0) {
    let q = start + len;
    while (q < buf.length && WS.has(buf[q])) q++;
    if (matches(buf, q, 'EI')) {
      lx.pos = q + 2;
      return { operator: 'BI', operands: [], inlineImage: { dict, data: buf.slice(start, start + len) } };
    }
  }
  const { end, after } = findEI(buf, start);
  lx.pos = after;
  return { operator: 'BI', operands: [], inlineImage: { dict, data: buf.slice(start, end) } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/content.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/content.ts test/content.test.ts
git commit -m "feat: capture inline images in content tokenizer (6lc)"
```

---

## Task 3: Serializer + round-trip property

Add `serializeContentStream` and prove `parse(serialize(ops))` preserves operators and operands.

**Files:**
- Modify: `src/content.ts`
- Test: `test/content.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `test/content.test.ts`:

```ts
import { serializeContentStream } from '../src/content.js';

describe('serializeContentStream', () => {
  it('round-trips operators and operands', () => {
    const src = 'BT /F1 24 Tf 100 700 Td [(A) -250 (B)] TJ ET q 1 0 0 1 5 5 cm /Im0 Do Q';
    const ops = parseContentStream(enc(src));
    const round = parseContentStream(serializeContentStream(ops));
    expect(round).toEqual(ops);
  });

  it('round-trips marked content with a dict operand', () => {
    const ops = parseContentStream(enc('/Span <</MCID 0>> BDC (hi) Tj EMC'));
    expect(parseContentStream(serializeContentStream(ops))).toEqual(ops);
  });

  it('round-trips an inline image', () => {
    const ops = parseContentStream(enc('BI /W 2 /H 2 /BPC 8 ID \x01\x02\x03\xFF\nEI'));
    const round = parseContentStream(serializeContentStream(ops));
    expect(round).toEqual(ops);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/content.test.ts`
Expected: FAIL — `serializeContentStream` is not exported.

- [ ] **Step 3: Implement the serializer**

Add to the imports at the top of `src/content.ts`:

```ts
import { serializeValue, escapeName, enc } from './serialize.js';
```

Append to `src/content.ts`:

```ts
/** Serialize an op stream back to content-stream bytes. Not byte-identical to
 *  the source; the guarantee is that re-parsing yields the same ops. */
export function serializeContentStream(ops: ContentOp[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const NL = enc('\n');
  for (let i = 0; i < ops.length; i++) {
    if (i > 0) chunks.push(NL);
    const op = ops[i];
    if (op.inlineImage) {
      const { dict, data } = op.inlineImage;
      let head = 'BI';
      for (const [k, v] of dict) head += ` /${escapeName(k)} ${serializeValue(v)}`;
      head += '\nID ';
      chunks.push(enc(head));
      chunks.push(data);
      chunks.push(enc('\nEI'));
    } else {
      const ops_ = op.operands.map(serializeValue).join(' ');
      chunks.push(enc(ops_ ? `${ops_} ${op.operator}` : op.operator));
    }
  }
  return concat(chunks);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/content.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/content.ts test/content.test.ts
git commit -m "feat: content-stream serializer + round-trip (6lc)"
```

---

## Task 4: Integration with a real (Flate) page + public exports

Prove the tokenizer consumes the bytes `Page.Contents` actually produces (decoded from a FlateDecode stream), and export the public API.

**Files:**
- Modify: `src/index.ts`
- Test: `test/content.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/content.test.ts`:

```ts
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { Page } from '../src/page.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { name, PdfStream } from '../src/types.js';

describe('parseContentStream on a real Page.Contents', () => {
  it('parses Flate-decoded page content', () => {
    const doc = Document.Open(buildClassicPdf(1));
    const text = 'BT /F1 12 Tf 72 720 Td (Real page) Tj ET';
    const raw = new Uint8Array(deflateSync(Buffer.from(text)));
    const stream: PdfStream = {
      kind: 'stream',
      dict: new Map<string, any>([['Filter', name('FlateDecode')], ['Length', raw.length]]),
      raw,
    };
    const pageDict = new Map<string, any>([['Type', name('Page')], ['Contents', stream]]);
    const page = new Page(doc, pageDict, 1);

    const ops = parseContentStream(page.Contents);
    expect(ops.map(o => o.operator)).toEqual(['BT', 'Tf', 'Td', 'Tj', 'ET']);
    expect(dec((ops[3].operands[0] as any).bytes)).toBe('Real page');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

The tokenizer already works on any decoded bytes, so this integration test should pass immediately. Run: `npx vitest run test/content.test.ts`
Expected: PASS (12 tests). If it fails, fix before continuing — do not adjust the test to match a bug.

- [ ] **Step 3: Add public exports**

In `src/index.ts`, after the existing `export { Page } from './page.js';` line, add:

```ts
export { parseContentStream, serializeContentStream } from './content.js';
export type { ContentOp } from './content.js';
```

- [ ] **Step 4: Typecheck and run the full suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: all tests pass (existing suite + new content tests).

- [ ] **Step 5: Commit**

```bash
git add src/content.ts test/content.test.ts src/index.ts
git commit -m "feat: integrate content tokenizer with Page.Contents + export API (6lc)"
```

---

## Wrap-up (after all tasks)

- [ ] Close the issue: `bd close aspose-pdf-foss-for-ts-6lc`
- [ ] Push: `git pull --rebase && git push && git status`
