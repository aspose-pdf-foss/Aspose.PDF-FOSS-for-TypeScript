# Cross-reference recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a PDF whose cross-reference structure is damaged, by sweeping the
buffer for `N G obj` headers and merging what is found with whatever the xref
still gave us.

**Architecture:** A new pure module `src/recover.ts` scans bytes and returns
every object-header candidate it finds. `src/xref.ts` is untouched and stays the
strict fast path. `Document.Open` gains a two-pass structure: build once, and if
any damage signal fired, sweep, merge the swept offsets over the surviving xref
entries, and build again.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-08-07-xref-recovery-design.md`.
Issue: `aspose-pdf-foss-for-ts-dxfk.1`.

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `npm run typecheck` and `npm test` must both be green before closing the issue.
- Errors thrown to callers are `PdfParseError` from `src/errors.ts`.
- `src/xref.ts` is not modified by any task in this plan. `XrefEntry` keeps its
  current shape: a single offset, no alternates array.
- No behaviour change for structurally sound files: if `readXref` succeeded and
  `/Root` resolved to a `/Type /Catalog`, a still-unparsable object throws
  exactly as today.
- Tests are hermetic — PDFs come from the builders in `test/helpers/`. Real-world
  damaged binaries belong to issue `dxfk.4`, not this plan.

---

### Task 1: The sweep — `src/recover.ts`

Pure byte scanning. No object parsing, no `Document`, no imports from the rest of
the library. This is what makes it testable on hand-built buffers.

**Files:**
- Create: `src/recover.ts`
- Test: `test/recover.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ObjCandidate { offset: number; gen: number; }
  export interface SweepResult {
    candidates: Map<number, ObjCandidate[]>;  // ascending by offset
    trailerOffsets: number[];                 // just past each `trailer`, latest first
  }
  export function sweepObjects(buf: Uint8Array): SweepResult;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/recover.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sweepObjects } from '../src/recover.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sweepObjects', () => {
  it('finds a header at offset 0', () => {
    const { candidates } = sweepObjects(enc('1 0 obj\n<< >>\nendobj\n'));
    expect(candidates.get(1)).toEqual([{ offset: 0, gen: 0 }]);
  });

  it('finds headers after CRLF and after a bare CR', () => {
    const { candidates } = sweepObjects(enc('%PDF\r\n7 0 obj\nx\rendobj\r12 3 obj\n'));
    expect(candidates.get(7)?.[0].gen).toBe(0);
    expect(candidates.get(12)?.[0].gen).toBe(3);
  });

  it('rejects an obj-shaped run whose number is not preceded by whitespace', () => {
    // "99 0 obj" glued to a preceding digit: part of stream data, not a header.
    const { candidates } = sweepObjects(enc('stream\n1234599 0 obj\nendstream'));
    expect(candidates.size).toBe(0);
  });

  it('rejects a run where obj is glued to a following letter', () => {
    const { candidates } = sweepObjects(enc('1 0 object\n'));
    expect(candidates.size).toBe(0);
  });

  it('returns every candidate for one object number, ascending by offset', () => {
    const buf = enc('5 0 obj\nA\nendobj\n5 0 obj\nB\nendobj\n');
    const list = sweepObjects(buf).candidates.get(5)!;
    expect(list.length).toBe(2);
    expect(list[0].offset).toBeLessThan(list[1].offset);
  });

  it('records trailer keyword offsets, latest first', () => {
    const buf = enc('trailer\n<< /A 1 >>\nxx\ntrailer\n<< /B 2 >>\n');
    const { trailerOffsets } = sweepObjects(buf);
    expect(trailerOffsets.length).toBe(2);
    expect(trailerOffsets[0]).toBeGreaterThan(trailerOffsets[1]);
    // offset points just past the keyword, at the whitespace before the dict
    expect(new TextDecoder('latin1').decode(buf.subarray(trailerOffsets[0], trailerOffsets[0] + 3)))
      .toBe('\n<<');
  });

  it('rejects an absurdly long digit run', () => {
    const { candidates } = sweepObjects(enc(`${'9'.repeat(12)} 0 obj\n`));
    expect(candidates.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/recover.test.ts`
Expected: FAIL — cannot resolve `../src/recover.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/recover.ts`:

```ts
// Brute-force recovery scan: find every `N G obj` header in a buffer, without
// trusting (or reading) the cross-reference structure. Pure byte work — no
// object parsing, so it stays testable on hand-built buffers.

/** One `N G obj` header found in the file. */
export interface ObjCandidate {
  /** Byte offset of the object number — where an xref entry would point. */
  offset: number;
  gen: number;
}

export interface SweepResult {
  /** Object number -> every candidate found, ascending by file offset. */
  candidates: Map<number, ObjCandidate[]>;
  /** Byte offsets just past each `trailer` keyword, latest first. */
  trailerOffsets: number[];
}

const isWs = (b: number) =>
  b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
const isDigit = (b: number) => b >= 48 && b <= 57;
const isDelim = (b: number) =>
  b === 40 || b === 41 || b === 60 || b === 62 || b === 91 ||
  b === 93 || b === 123 || b === 125 || b === 47 || b === 37;

/** Object and generation numbers longer than this are not plausible and are
 *  rejected, so a long digit run in stream data cannot become a candidate. */
const MAX_DIGITS = 10;

const TRAILER = [0x74, 0x72, 0x61, 0x69, 0x6C, 0x65, 0x72]; // 'trailer'

function digits(buf: Uint8Array, start: number, end: number): number {
  let v = 0;
  for (let i = start; i <= end; i++) v = v * 10 + (buf[i] - 48);
  return v;
}

/** Backtrack from the `obj` keyword at `objAt` over `N G `. */
function matchHeader(buf: Uint8Array, objAt: number): ObjCandidate & { num: number } | undefined {
  let p = objAt - 1;
  while (p >= 0 && isWs(buf[p])) p--;
  if (p < 0 || !isDigit(buf[p])) return undefined;
  const genEnd = p;
  while (p >= 0 && isDigit(buf[p])) p--;
  const genStart = p + 1;
  if (genEnd - genStart + 1 > MAX_DIGITS) return undefined;
  if (p < 0 || !isWs(buf[p])) return undefined;          // need whitespace between N and G
  while (p >= 0 && isWs(buf[p])) p--;
  if (p < 0 || !isDigit(buf[p])) return undefined;
  const numEnd = p;
  while (p >= 0 && isDigit(buf[p])) p--;
  const numStart = p + 1;
  if (numEnd - numStart + 1 > MAX_DIGITS) return undefined;
  // The object number must start the token: whitespace before it, or start of file.
  if (p >= 0 && !isWs(buf[p])) return undefined;
  const num = digits(buf, numStart, numEnd);
  if (num <= 0) return undefined;
  return { num, gen: digits(buf, genStart, genEnd), offset: numStart };
}

function matches(buf: Uint8Array, at: number, kw: number[]): boolean {
  if (at + kw.length > buf.length) return false;
  for (let i = 0; i < kw.length; i++) if (buf[at + i] !== kw[i]) return false;
  return true;
}

/** Scan the whole buffer for object headers and `trailer` keywords. O(n). */
export function sweepObjects(buf: Uint8Array): SweepResult {
  const candidates = new Map<number, ObjCandidate[]>();
  const trailerOffsets: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0x6F && buf[i + 1] === 0x62 && buf[i + 2] === 0x6A) { // 'obj'
      const after = i + 3;
      if (after < buf.length && !isWs(buf[after]) && !isDelim(buf[after])) continue;
      const hit = matchHeader(buf, i);
      if (!hit) continue;
      let list = candidates.get(hit.num);
      if (!list) { list = []; candidates.set(hit.num, list); }
      list.push({ offset: hit.offset, gen: hit.gen });
      continue;
    }
    if (b === 0x74 && matches(buf, i, TRAILER)) trailerOffsets.push(i + TRAILER.length);
  }
  for (const list of candidates.values()) list.sort((a, b) => a.offset - b.offset);
  trailerOffsets.reverse();
  return { candidates, trailerOffsets };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/recover.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/recover.ts test/recover.test.ts
git commit -m "feat(recover): sweep a buffer for N G obj headers"
```

---

### Task 2: Damage helpers — `test/helpers/damage-pdf.ts`

Test infrastructure for every later task. Its own task because the helpers carry
a load-bearing assertion of their own: **each damage function must actually break
`Document.Open` today**. A recovery test that passes because the file was never
really damaged is the failure mode CLAUDE.md warns about, and this is where it
gets ruled out.

**Files:**
- Create: `test/helpers/damage-pdf.ts`
- Test: `test/damage-helpers.test.ts`

**Interfaces:**
- Consumes: `buildClassicPdf` from `test/helpers/build-pdf.ts`.
- Produces:
  ```ts
  export function corruptStartxref(pdf: Uint8Array): Uint8Array;
  export function destroyTrailer(pdf: Uint8Array): Uint8Array;
  export function prependBytes(pdf: Uint8Array, text: string,
                               opts?: { fixStartxref?: boolean }): Uint8Array;
  export function corruptObjectBody(pdf: Uint8Array, objNum: number): Uint8Array;
  export function appendTruncatedCopy(pdf: Uint8Array, objNum: number): Uint8Array;
  export function truncateTail(pdf: Uint8Array, bytes: number): Uint8Array;
  ```

**Deviation from the spec, deliberate:** the spec listed `truncateMidObject`.
It is dropped as redundant — `truncateTail` already truncates the final object
along with the xref. `corruptObjectBody` and `appendTruncatedCopy` are added
because two spec requirements (the merge test and the duplicate-candidate
fallback) cannot be exercised without them.

- [ ] **Step 1: Write the failing test**

Create `test/damage-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import {
  corruptStartxref, destroyTrailer, prependBytes, corruptObjectBody,
  appendTruncatedCopy, truncateTail,
} from './helpers/damage-pdf.js';

const good = () => buildClassicPdf(2);

describe('damage helpers are load-bearing', () => {
  it('the undamaged fixture opens', () => {
    expect(Document.Open(good()).Pages.length).toBe(2);
  });

  it.each([
    ['corruptStartxref', (p: Uint8Array) => corruptStartxref(p)],
    ['destroyTrailer', (p: Uint8Array) => destroyTrailer(p)],
    ['prependBytes', (p: Uint8Array) => prependBytes(p, 'X-Junk: 1\r\n')],
    ['corruptObjectBody', (p: Uint8Array) => corruptObjectBody(p, 3)],
    ['truncateTail', (p: Uint8Array) => truncateTail(p, 40)],
  ])('%s breaks Open today', (_name, damage) => {
    expect(() => Document.Open(damage(good()))).toThrow();
  });

  it('prependBytes with fixStartxref keeps the xref readable but the offsets stale', () => {
    const pdf = prependBytes(good(), 'X-Junk: 1\r\n', { fixStartxref: true });
    // startxref now resolves, so the failure comes from object parsing, not readXref
    expect(() => Document.Open(pdf)).toThrow();
  });

  it('a damage function that changes nothing else preserves file length', () => {
    // Guards the latin1/UTF-8 trap: re-encoding through TextEncoder would
    // silently inflate the binary marker comment and every high byte with it.
    const pdf = good();
    expect(corruptObjectBody(pdf, 3).length).toBe(pdf.length);
    expect(destroyTrailer(pdf).length).toBe(pdf.length);
  });

  it('appendTruncatedCopy adds a second, unparsable copy of the object', () => {
    const pdf = appendTruncatedCopy(good(), 3);
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.match(/(^|\s)3 0 obj/g)?.length).toBe(2);
    // the original file still opens: the appended copy is past %%EOF and unreferenced
    expect(Document.Open(pdf).Pages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/damage-helpers.test.ts`
Expected: FAIL — cannot resolve `./helpers/damage-pdf.js`.

- [ ] **Step 3: Write minimal implementation**

Create `test/helpers/damage-pdf.ts`:

```ts
// Programmatic damage applied to builder-made PDFs. Every function here must
// produce a file that Document.Open rejects today — see damage-helpers.test.ts.

const dec = new TextDecoder('latin1');

/** latin1, NOT TextEncoder: TextEncoder emits UTF-8, so every byte above 127 —
 *  including the `%\xE2\xE3\xCF\xD3` binary marker every builder writes — would
 *  inflate to two bytes and corrupt the file in a way unrelated to the damage
 *  being applied. One char in, one byte out. */
const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

const asText = (pdf: Uint8Array) => dec.decode(pdf);
const asBytes = (s: string) => enc(s);

/** Point startxref at an offset past the end of the file. */
export function corruptStartxref(pdf: Uint8Array): Uint8Array {
  const text = asText(pdf);
  const i = text.lastIndexOf('startxref');
  if (i < 0) throw new Error('fixture has no startxref');
  const replaced = text.slice(0, i) + text.slice(i).replace(/startxref\s+\d+/, `startxref\n${pdf.length + 5000}`);
  return asBytes(replaced);
}

/** Overwrite the `trailer` keyword so the classic table reader never finds it. */
export function destroyTrailer(pdf: Uint8Array): Uint8Array {
  const text = asText(pdf);
  const i = text.lastIndexOf('trailer');
  if (i < 0) throw new Error('fixture has no trailer keyword');
  return asBytes(text.slice(0, i) + '#######' + text.slice(i + 7));
}

/** Prepend bytes, shifting every offset in the file by text.length.
 *  With { fixStartxref: true } the startxref value is corrected, so the xref
 *  still parses and only the object offsets are stale. */
export function prependBytes(
  pdf: Uint8Array, text: string, opts: { fixStartxref?: boolean } = {},
): Uint8Array {
  const shift = enc(text).length;
  let body = asText(pdf);
  if (opts.fixStartxref) {
    body = body.replace(/startxref\s+(\d+)/, (_m, n: string) =>
      `startxref\n${parseInt(n, 10) + shift}`);
  }
  return asBytes(text + body);
}

/** Overwrite an object's body in place with filler, preserving byte length so
 *  the xref stays valid and only that object fails to parse. */
export function corruptObjectBody(pdf: Uint8Array, objNum: number): Uint8Array {
  const text = asText(pdf);
  const start = text.search(new RegExp(`(^|\\s)${objNum} 0 obj`));
  if (start < 0) throw new Error(`fixture has no object ${objNum}`);
  const headerEnd = text.indexOf('obj', start) + 3;
  const end = text.indexOf('endobj', headerEnd);
  if (end < 0) throw new Error(`object ${objNum} has no endobj`);
  return asBytes(text.slice(0, headerEnd) + '#'.repeat(end - headerEnd) + text.slice(end));
}

/** Append a second, truncated copy of an object after %%EOF. The sweep finds
 *  both; the later one does not parse. */
export function appendTruncatedCopy(pdf: Uint8Array, objNum: number): Uint8Array {
  return asBytes(asText(pdf) + `\n${objNum} 0 obj\n<< /Type /Page /Parent `);
}

/** Cut bytes off the end, destroying the xref, the trailer and the last object. */
export function truncateTail(pdf: Uint8Array, bytes: number): Uint8Array {
  return pdf.subarray(0, Math.max(0, pdf.length - bytes));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/damage-helpers.test.ts`
Expected: PASS. If any `%s breaks Open today` case does **not** throw, that
helper is not damaging the file — fix the helper, do not weaken the assertion.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add test/helpers/damage-pdf.ts test/damage-helpers.test.ts
git commit -m "test: damage helpers, each proven to break Open"
```

---

### Task 3: Recursion guard in `parseEntry`

A latent bug the sweep would expose: `parseEntry` recurses for an indirect
`/Length` and memoizes only *after* parsing returns, so a self-referential
`/Length` recurses forever. Today the xref is trusted and this cannot arise; a
swept offset map can produce it. Fix before wiring recovery.

**Files:**
- Modify: `src/document.ts` — the `parseEntry` closure inside `Document.Open`
- Test: `test/xref-recovery.test.ts` (created here, extended by later tasks)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. Behaviour only.

- [ ] **Step 1: Write the failing test**

Create `test/xref-recovery.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PdfParseError } from '../src/errors.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** A hand-built PDF whose object 4 has a /Length pointing at itself. */
function selfReferentialLength(): Uint8Array {
  const objs = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 4 0 R >>',
    '<< /Length 4 0 R >>\nstream\n\nendstream',
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [0];
  for (let n = 1; n <= 4; n++) {
    offsets[n] = enc(body).length;
    body += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xrefAt = enc(body).length;
  let xref = `xref\n0 5\n0000000000 65535 f \n`;
  for (let n = 1; n <= 4; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  return enc(body + xref + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
}

describe('parseEntry recursion guard', () => {
  it('does not hang on a self-referential /Length', () => {
    // Must terminate. Either outcome is acceptable; hanging is not.
    try {
      Document.Open(selfReferentialLength());
    } catch (e) {
      expect(e).toBeInstanceOf(PdfParseError);
    }
  }, 5000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: FAIL — the test times out at 5000ms (infinite recursion or stack
overflow), rather than completing.

- [ ] **Step 3: Write minimal implementation**

In `src/document.ts`, inside `Open`, add an in-progress set beside
`objects`/`objStmCache` and check it at the top of `parseEntry`:

```ts
    const objects = new Map<number, PdfObject>();
    const objStmCache = new Map<number, Map<number, PdfObject>>();
    // Objects currently being parsed. A swept offset map can produce a
    // self-referential indirect /Length, which would otherwise recurse forever
    // (parseEntry memoizes only after parsing returns).
    const inProgress = new Set<number>();

    const parseEntry = (num: number): PdfObject => {
      const existing = objects.get(num);
      if (existing !== undefined) return existing;
      if (inProgress.has(num)) return null;
      const entry = entries.get(num);
      if (!entry) return null;
      inProgress.add(num);
      try {
        // ... existing body unchanged, ending with:
        // objects.set(num, value);
        // return value;
      } finally {
        inProgress.delete(num);
      }
    };
```

Keep the existing body verbatim inside the `try`. Do not change what it does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: PASS, terminating well under the timeout.

Run: `npm test`
Expected: the whole suite green — this change must not alter any existing
behaviour.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/document.ts test/xref-recovery.test.ts
git commit -m "fix(open): guard parseEntry against a self-referential /Length"
```

---

### Task 4: Extract a collecting builder from `Open`

Pure refactor, no behaviour change. `Open` currently does xref reading,
decryptor setup, eager parsing and `Document` construction in one body. Recovery
needs to run the middle part twice, so it moves into a private static that
reports which objects failed instead of throwing on the first one.

**Files:**
- Modify: `src/document.ts:376-470` — `Document.Open`

**Interfaces:**
- Consumes: `XrefEntry`, `XrefResult` from `src/xref.js` (unchanged).
- Produces:
  ```ts
  interface BuildResult {
    objects: Map<number, PdfObject>;
    failed: Set<number>;                  // objects whose parse threw
    repaired: number[];                   // always [] in this task; filled by Task 5
    permissions: Permissions | undefined;
  }
  // private static on Document
  private static build(
    buf: Uint8Array,
    entries: Map<number, XrefEntry>,
    trailer: PdfDict,
    opts: OpenOptions,
    alternates?: Map<number, ObjCandidate[]>,
  ): BuildResult;
  ```
  `alternates` is unused in this task — declared now so Task 5 does not have to
  change the signature. Pass `undefined`.

- [ ] **Step 1: Run the existing suite to establish the baseline**

Run: `npm test`
Expected: PASS. Record the test count; it must be identical after this task.

- [ ] **Step 2: Move the body into `Document.build`**

Cut everything in `Open` from `// Raw (un-decrypted) resolver...` through the
`ObjStm` container cleanup loop into a new private static `build` with the
signature above. Two changes to the moved code, and nothing else:

1. Replace the eager loop
   ```ts
   for (const num of entries.keys()) parseEntry(num);
   ```
   with a collecting one:
   ```ts
   const failed = new Set<number>();
   const repaired: number[] = [];
   for (const num of entries.keys()) {
     try {
       parseEntry(num);
     } catch {
       failed.add(num);
       objects.delete(num);
     }
   }
   ```
2. Return `{ objects, failed, repaired, permissions }` instead of constructing
   `Document`. `repaired` stays empty here; Task 5 fills it.

`Open` becomes:

```ts
  static Open(buf: Uint8Array, opts: OpenOptions = {}): Document {
    const { entries, trailer } = readXref(buf);
    const { objects, failed, permissions } = Document.build(buf, entries, trailer, opts, undefined);
    // `repaired` is destructured only from Task 5 onward.
    if (failed.size > 0) {
      const first = [...failed][0];
      throw new PdfParseError(`object ${first} could not be parsed`);
    }
    const doc = new Document(objects, trailer);
    doc.originalBytes = buf;
    doc.permissions = permissions;
    return doc;
  }
```

The `failed.size > 0` throw is what preserves today's contract through this
refactor. Task 7 replaces it with the two-branch strictness rule.

- [ ] **Step 3: Run the suite to verify nothing changed**

Run: `npm test`
Expected: PASS, same test count as Step 1. Any change here is a refactor bug,
not an improvement — fix it rather than updating a test.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/document.ts
git commit -m "refactor(open): extract a failure-collecting object builder"
```

---

### Task 5: Detect damage, sweep, merge, retry

The core. Covers the case where `readXref` succeeds but objects are unparsable —
a file with prepended bytes and a corrected `startxref`. Trailer recovery for the
case where `readXref` itself throws is Task 6.

**Files:**
- Modify: `src/document.ts` — `Open`, `build`
- Test: `test/xref-recovery.test.ts`

**Interfaces:**
- Consumes: `sweepObjects`, `ObjCandidate`, `SweepResult` from `src/recover.js`.
- Produces:
  ```ts
  export interface RecoveryReport {
    reason: 'startxref-unreadable' | 'xref-unparsable'
          | 'object-parse-failure' | 'root-not-catalog';
    detail: string;
    repaired: number[];
    lost: number[];
  }
  // on Document
  readonly recovery?: RecoveryReport;
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/xref-recovery.test.ts`:

```ts
import { buildClassicPdf } from './helpers/build-pdf.js';
import { prependBytes } from './helpers/damage-pdf.js';

describe('recovery: stale offsets with a readable xref', () => {
  it('opens a file whose offsets are shifted by prepended bytes', () => {
    const good = buildClassicPdf(2);
    const damaged = prependBytes(good, 'X-Junk: 1\r\n', { fixStartxref: true });
    const doc = Document.Open(damaged);
    expect(doc.Pages.length).toBe(Document.Open(good).Pages.length);
    expect(doc.Pages[0].GetText()).toBe(Document.Open(good).Pages[0].GetText());
  });

  it('reports the repair', () => {
    const damaged = prependBytes(buildClassicPdf(2), 'X-Junk: 1\r\n', { fixStartxref: true });
    const doc = Document.Open(damaged);
    expect(doc.recovery?.reason).toBe('object-parse-failure');
    expect(doc.recovery!.repaired.length).toBeGreaterThan(0);
    expect(doc.recovery!.lost).toEqual([]);
  });

  it('a healthy file never sweeps', () => {
    expect(Document.Open(buildClassicPdf(2)).recovery).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: FAIL — the first two cases throw `PdfParseError`, and
`doc.recovery` does not exist.

- [ ] **Step 3: Write minimal implementation**

Add the report type near `OpenOptions` in `src/document.ts`:

```ts
/** How Document.Open obtained its cross-reference data. Absent on a clean parse. */
export interface RecoveryReport {
  reason: 'startxref-unreadable' | 'xref-unparsable'
        | 'object-parse-failure' | 'root-not-catalog';
  /** e.g. 'startxref pointed at offset 91234, past end of file' */
  detail: string;
  /** Objects whose offset came from the sweep rather than the xref. */
  repaired: number[];
  /** Objects that never parsed; null in the model. */
  lost: number[];
}
```

Add the field to the class beside `permissions`:

```ts
  /** Set when Open had to recover from a damaged cross-reference structure. */
  recovery?: RecoveryReport;
```

In `build`, use `alternates` when an entry's offset fails: on a parse failure for
object `num`, walk that object's candidate list from the highest offset below the
failing one and retry, recording success. Replace the collecting loop from Task 4
with:

```ts
    const failed = new Set<number>();
    const repaired: number[] = [];
    for (const num of entries.keys()) {
      try {
        parseEntry(num);
      } catch {
        objects.delete(num);
        const list = alternates?.get(num);
        let ok = false;
        for (let i = (list?.length ?? 0) - 1; i >= 0 && !ok; i--) {
          entries.set(num, { type: 'offset', offset: list![i].offset, gen: list![i].gen });
          objects.delete(num);
          try { parseEntry(num); ok = true; repaired.push(num); } catch { /* next candidate */ }
        }
        if (!ok) failed.add(num);
      }
    }
```

and return `repaired` alongside `failed`.

Add a catalog check helper next to `build`:

```ts
  /** True when the trailer's /Root resolves to a /Type /Catalog in `objects`. */
  private static rootIsCatalog(objects: Map<number, PdfObject>, trailer: PdfDict): boolean {
    const r = trailer.get('Root');
    const root = isRef(r) ? objects.get(r.num) : r;
    if (!isDict(root)) return false;
    const t = root.get('Type');
    return isName(t) && t.name === 'Catalog';
  }
```

Rewrite `Open` to two passes:

```ts
  static Open(buf: Uint8Array, opts: OpenOptions = {}): Document {
    const { entries, trailer } = readXref(buf);
    let pass = Document.build(buf, entries, trailer, opts, undefined);

    let report: RecoveryReport | undefined;
    if (pass.failed.size > 0) {
      report = {
        reason: 'object-parse-failure',
        detail: `object ${[...pass.failed][0]} could not be parsed at its xref offset`,
        repaired: [], lost: [],
      };
    } else if (!Document.rootIsCatalog(pass.objects, trailer)) {
      report = {
        reason: 'root-not-catalog',
        detail: 'the trailer /Root did not resolve to a /Type /Catalog',
        repaired: [], lost: [],
      };
    }

    if (report) {
      const sweep = sweepObjects(buf);
      const merged = new Map(entries);
      for (const [num, list] of sweep.candidates)
        if (!merged.has(num)) merged.set(num, { type: 'offset', ...list[list.length - 1] });
      pass = Document.build(buf, merged, trailer, opts, sweep.candidates);
      report.repaired = pass.repaired;
      report.lost = [...pass.failed];
      if (pass.failed.size > 0) throw new PdfParseError(report.detail);
    }

    const doc = new Document(pass.objects, trailer);
    doc.originalBytes = buf;
    doc.permissions = pass.permissions;
    doc.recovery = report;
    return doc;
  }
```

Note the merge: entries the xref already had — including every `compressed`
one — are kept, and swept offsets fill only the gaps. Alternates drive the
per-object fallback inside `build`.

Import `sweepObjects`, `ObjCandidate` and `SweepResult` at the top of
`document.ts` (`SweepResult` is used by Task 6), and make sure `isName` is among
the `./types.js` imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: PASS.

Run: `npm test`
Expected: the whole suite green.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/document.ts test/xref-recovery.test.ts
git commit -m "feat(open): sweep and merge when objects fail at their xref offsets"
```

---

### Task 6: Trailer recovery when `readXref` throws

Covers the headline acceptance criterion: a corrupted `startxref`. `readXref`
throws, so there is no trailer and no entries at all — both must come from the
sweep.

**Files:**
- Modify: `src/document.ts` — `Open`
- Test: `test/xref-recovery.test.ts`

**Interfaces:**
- Consumes: `SweepResult.trailerOffsets` from Task 1; `ObjectParser`, `Lexer`
  (already imported by `document.ts`).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `test/xref-recovery.test.ts`:

```ts
import { corruptStartxref, destroyTrailer } from './helpers/damage-pdf.js';
import { buildXrefStreamPdf } from './helpers/build-pdf.js';

describe('recovery: unreadable xref', () => {
  it('opens a file with a corrupted startxref, matching the original', () => {
    const good = buildClassicPdf(2);
    const doc = Document.Open(corruptStartxref(good));
    const ref = Document.Open(good);
    expect(doc.Pages.length).toBe(ref.Pages.length);
    expect(doc.Pages[0].GetText()).toBe(ref.Pages[0].GetText());
    expect(doc.recovery?.reason).toBe('startxref-unreadable');
  });

  it('recovers the trailer from the trailer keyword when the table is gone', () => {
    const doc = Document.Open(destroyTrailer(buildClassicPdf(2)));
    expect(doc.Pages.length).toBe(2);
  });

  it('recovers the trailer from a /Type /XRef dict when there is no trailer keyword', () => {
    const good = buildXrefStreamPdf();
    const doc = Document.Open(corruptStartxref(good));
    expect(doc.Pages.length).toBe(Document.Open(good).Pages.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xref-recovery.test.ts -t 'unreadable xref'`
Expected: FAIL — `readXref` throws out of `Open` before recovery is reached.

- [ ] **Step 3: Write minimal implementation**

Wrap the `readXref` call and add trailer recovery. Replace the head of `Open`:

```ts
    let entries = new Map<number, XrefEntry>();
    let trailer: PdfDict | undefined;
    let xrefFailure: RecoveryReport | undefined;
    try {
      const r = readXref(buf);
      entries = r.entries;
      trailer = r.trailer;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      xrefFailure = {
        reason: detail.includes('startxref') ? 'startxref-unreadable' : 'xref-unparsable',
        detail, repaired: [], lost: [],
      };
    }
```

When `xrefFailure` is set, skip the first pass entirely, sweep, and recover a
trailer before building:

```ts
    if (xrefFailure) {
      const sweep = sweepObjects(buf);
      const merged = new Map<number, XrefEntry>();
      for (const [num, list] of sweep.candidates)
        merged.set(num, { type: 'offset', ...list[list.length - 1] });
      trailer = Document.recoverTrailer(buf, sweep, merged, opts);
      const pass = Document.build(buf, merged, trailer, opts, sweep.candidates);
      xrefFailure.repaired = [...merged.keys()];
      xrefFailure.lost = [...pass.failed];
      const doc = new Document(pass.objects, trailer);
      doc.originalBytes = buf;
      doc.permissions = pass.permissions;
      doc.recovery = xrefFailure;
      return doc;
    }
```

and add:

```ts
  /** Find a trailer that still exists in the file: a `trailer` keyword first,
   *  then the dict of a /Type /XRef stream (the only route for an xref-stream
   *  file, which has no trailer keyword). Synthesis is dxfk.2's job. */
  private static recoverTrailer(
    buf: Uint8Array, sweep: SweepResult,
    entries: Map<number, XrefEntry>, opts: OpenOptions,
  ): PdfDict {
    for (const at of sweep.trailerOffsets) {
      try {
        const d = new ObjectParser(new Lexer(buf, at)).parseObject();
        if (isDict(d) && d.get('Root') !== undefined) return d;
      } catch { /* try the next one */ }
    }
    for (const [, e] of entries) {
      if (e.type !== 'offset') continue;
      try {
        const v = new ObjectParser(new Lexer(buf, e.offset)).parseIndirectObject().value;
        if (!isStream(v)) continue;
        const t = v.dict.get('Type');
        if (isName(t) && t.name === 'XRef' && v.dict.get('Root') !== undefined) return v.dict;
      } catch { /* try the next one */ }
    }
    throw new PdfParseError(
      sweep.candidates.size === 0
        ? 'no indirect objects found'
        : 'objects found but no trailer with a /Root',
    );
  }
```

`opts` is accepted but unused here — the trailer is read before any decryptor
exists, exactly as `Open`'s existing `resolveRaw` does.

**Type note.** `trailer` is now declared `PdfDict | undefined`, so Task 5's code
further down no longer narrows automatically. That path runs only when
`xrefFailure` is undefined, where `readXref` did produce a trailer, so add one
narrowing guard immediately after the `if (xrefFailure) { ... return doc; }`
block rather than sprinkling non-null assertions:

```ts
    if (!trailer) throw new PdfParseError('no trailer found');
```

This is unreachable in practice — it exists to give TypeScript the narrowing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: PASS.

Run: `npm test`
Expected: green.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/document.ts test/xref-recovery.test.ts
git commit -m "feat(open): recover a trailer from the file when the xref is unreadable"
```

---

### Task 7: The strictness rule and duplicate fallback

Two behaviours the spec singles out, tested together because they are the two
ways a still-broken object is resolved.

**Files:**
- Modify: `src/document.ts` — `Open`
- Test: `test/xref-recovery.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5 and 6.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `test/xref-recovery.test.ts`:

```ts
import { corruptObjectBody, appendTruncatedCopy, truncateTail } from './helpers/damage-pdf.js';

describe('strictness', () => {
  it('throws for a structurally sound file with one corrupted object', () => {
    // xref reads, /Root resolves, object 3 is garbage and the sweep cannot repair it.
    const pdf = corruptObjectBody(buildClassicPdf(2), 3);
    expect(() => Document.Open(pdf)).toThrow(PdfParseError);
  });

  it('degrades to null for an already-damaged file', () => {
    const pdf = truncateTail(buildClassicPdf(2), 40);
    const doc = Document.Open(pdf);
    expect(doc.recovery!.lost.length).toBeGreaterThan(0);
  });
});

describe('duplicate candidates', () => {
  it('falls back to the earlier good copy when the last one does not parse', () => {
    const good = buildClassicPdf(2);
    const doc = Document.Open(corruptStartxref(appendTruncatedCopy(good, 3)));
    // object 3 is a page: it must have come from the intact earlier copy
    expect(doc.Pages.length).toBe(2);
    expect(doc.recovery).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/xref-recovery.test.ts -t 'strictness'`
Expected: FAIL — `degrades to null` throws, because Task 5's code throws on any
remaining failure regardless of which signal fired.

- [ ] **Step 3: Write minimal implementation**

In `Open`, replace the unconditional throw in the recovery branch from Task 5:

```ts
      if (pass.failed.size > 0) throw new PdfParseError(report.detail);
```

with the two-branch rule. This branch is only reached when `readXref` succeeded,
so soundness turns on the catalog alone:

```ts
      // The xref read and, if /Root resolved, the document is structurally
      // sound: an object that still will not parse is a genuine error, exactly
      // as before this feature existed. The sweep was a repair attempt, not a
      // licence to degrade. Only an already-damaged file degrades to null.
      if (pass.failed.size > 0 && report.reason === 'object-parse-failure'
          && Document.rootIsCatalog(pass.objects, trailer)) {
        throw new PdfParseError(report.detail);
      }
```

The Task 6 branch already degrades to null, which is correct — `readXref`
throwing means the file was known-damaged before any object was read.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/xref-recovery.test.ts`
Expected: PASS.

Run: `npm test`
Expected: green.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/document.ts test/xref-recovery.test.ts
git commit -m "feat(open): keep Open strict for structurally sound files"
```

---

### Task 8: The merge test, the signing guard, and the public surface

The assertion that protects the merge decision, plus the two consequences the
spec calls out and the exports.

**Files:**
- Modify: `src/document.ts` — `Sign`, `Certify`
- Modify: `src/index.ts`
- Modify: `README.md`
- Test: `test/xref-recovery.test.ts`

**Interfaces:**
- Consumes: `RecoveryReport` from Task 5.
- Produces: `RecoveryReport` exported from `src/index.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/xref-recovery.test.ts`:

```ts
import { buildBlankPage } from './helpers/build-blank-page.js';

describe('merge preserves object-stream entries', () => {
  it('keeps compressed objects when a swept offset repairs the container', () => {
    const compressed = Document.Open(buildBlankPage()).Save({ compressed: true });
    const damaged = prependBytes(compressed, 'X-Junk: 1\r\n', { fixStartxref: true });
    const doc = Document.Open(damaged);
    // /Root and /Pages live inside an /ObjStm. If the merge replaced the xref
    // entries instead of overlaying them, those entries would be gone and the
    // page tree would be unreachable.
    expect(doc.Pages.length).toBe(1);
    expect(doc.recovery).toBeDefined();
  });
});

describe('signing a recovered document', () => {
  it('throws rather than appending onto damaged bytes', () => {
    const doc = Document.Open(corruptStartxref(buildClassicPdf(2)));
    expect(() => doc.Sign({} as never)).toThrow(/recovered/i);
  });
});

describe('saving a recovered document repairs it', () => {
  it('round-trips to a file that opens cleanly', () => {
    const doc = Document.Open(corruptStartxref(buildClassicPdf(2)));
    const reopened = Document.Open(doc.Save());
    expect(reopened.recovery).toBeUndefined();
    expect(reopened.Pages.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/xref-recovery.test.ts -t 'signing a recovered'`
Expected: FAIL — `Sign` does not reject a recovered document.

- [ ] **Step 3: Write minimal implementation**

Add a guard as the first statement of both `Sign` and `Certify` in
`src/document.ts`:

```ts
    if (this.recovery) {
      throw new PdfParseError(
        'cannot sign a recovered document: incremental signing appends to the '
        + 'original bytes, which are damaged. Save() first, then sign the result.',
      );
    }
```

Export the type from `src/index.ts`, beside the existing `OpenOptions` export:

```ts
export type { SplitOptions, ExtractPagesOptions, InsertPagesOptions, OpenOptions, SaveOptions, PubSecRecipient, RecoveryReport } from './document.js';
```

In `README.md`, under Limitations or a neighbouring section, add:

```markdown
### Damaged files

`Document.Open` recovers from a damaged cross-reference structure by scanning
the file for objects. When it does, `doc.recovery` describes what was repaired
and what was lost; on a clean parse it is `undefined`. A file whose xref reads
and whose `/Root` resolves is still strict — a malformed object throws.

`Save()` rewrites the whole reachable object graph, so saving a recovered
document produces a clean file. Signing one throws: incremental signing appends
to the original bytes, which are by definition damaged.
```

- [ ] **Step 4: Run everything**

Run: `npm test`
Expected: green.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Prove the assertions load-bearing**

Per CLAUDE.md: a recovery test that passes because the file was never really
damaged is the failure mode here. Break the code and confirm the suite goes red.

1. In `src/recover.ts`, make `sweepObjects` return empty results
   (`return { candidates: new Map(), trailerOffsets: [] }` at the top).
   Run `npm test`. Expected: the recovery tests FAIL. Revert.
2. In `Open`'s recovery branch, change the merge to a replacement
   (`const merged = new Map<number, XrefEntry>();` — dropping `entries`).
   Run `npx vitest run test/xref-recovery.test.ts`. Expected: the
   `merge preserves object-stream entries` test FAILS. Revert.
3. In Task 7's guard, delete the `rootIsCatalog` condition so both cases
   degrade. Run `npx vitest run test/xref-recovery.test.ts`. Expected: the
   `throws for a structurally sound file` test FAILS. Revert.

Record the three results in a comment on the issue.

- [ ] **Step 6: Commit and close**

```bash
git add src/document.ts src/index.ts README.md test/xref-recovery.test.ts
git commit -m "feat(open): guard signing, export RecoveryReport, document recovery"
bd close aspose-pdf-foss-for-ts-dxfk.1
bd dolt push
git push
```

---

## Notes for the implementer

- Tasks 5–8 each append a `describe` block to `test/xref-recovery.test.ts` and
  show the imports that block needs. **Imports accumulate at the top of the
  file** — merge each new one into the existing import list rather than pasting a
  second `import` statement mid-file. By Task 8 the file imports
  `buildClassicPdf`, `buildXrefStreamPdf`, `buildBlankPage`, and the six damage
  helpers.

- `dxfk.2` (synthesizing a trailer by finding the `/Type /Catalog` object) is
  deliberately out of scope. When no trailer exists anywhere in the file,
  `recoverTrailer` throws. Do not extend it.
- `dxfk.3` (per-object `/ObjStm` degradation) is out of scope. A corrupt object
  stream still takes down everything inside it; that is the known-lossy case.
- Objects inside an `/ObjStm` carry no `N G obj` header and can never be found by
  the sweep. This is why the merge keeps `compressed` entries rather than
  replacing them, and it is the single most important property to preserve.
