# Degrading a corrupt /ObjStm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a PDF whose `/ObjStm` payload is damaged, keeping every object
that survives the damage and reporting the ones that do not, instead of throwing
away the whole container — and with it, on a compressed file, most of the
document.

**Architecture:** `decodeObjStm` stops decoding as a unit. It inflates what it
can (`Z_SYNC_FLUSH` returns the prefix zlib produced before the damage), reads
as many header pairs as the data holds, recovers `/First` from the header end
when the declared value is unusable, and parses each object in its own `try`.
It returns `{ objects, damage? }` rather than throwing. `Document.build` collects
those damage records, and `Document.Open` surfaces them on `doc.recovery`. The
existing rethrow for a structurally sound file is untouched: it reads a `failed`
set that no longer contains objects lost inside a container.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

Spec: `docs/superpowers/specs/2026-08-10-objstm-degradation-design.md`.
Issue: `aspose-pdf-foss-for-ts-dxfk.3`.

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every relative import specifier carries the `.js` extension.
- `npm run typecheck` and `npm test` must both be green before closing the issue.
- Errors thrown to callers are `PdfParseError` from `src/errors.ts`.
- **No behaviour change for undamaged files.** A container that decodes whole
  produces `damage === undefined`, and a healthy document keeps
  `doc.recovery === undefined`. Task 7 asserts this directly.
- **The strictness rule at `src/document.ts` is not relaxed.** An object that
  will not parse at an offset on a file with a readable xref and a catalog
  `/Root` still throws. Only an object declared by a damaged `/ObjStm` is
  exempt, because it has no `N G obj` header and therefore no repair to fail.
- Tests are hermetic — PDFs come from the builders in `test/helpers/`.
  Real-world damaged binaries belong to issue `dxfk.4`, not this plan.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/filters.ts` | stream decode filters | Modify: `decodeStream`/`applyDecodeFilters` take a `partial` option; `FlateDecode` uses `Z_SYNC_FLUSH` under it |
| `src/flate.ts` | named re-export | Modify: re-export the option type so `objstm.ts` keeps importing from here |
| `src/objstm.ts` | `/ObjStm` decoding | Rewrite: per-object degradation, `ObjStmDamage`, new return shape |
| `src/rebuild.ts` | recovery-path parsing | Modify: `expandObjectStreams` registers partial contents and returns damage |
| `src/document.ts` | `Open`/`build` | Modify: `BuildResult.lostInObjStm`, collect damage, `RecoveryReport.objectStreams` + new reason |
| `src/index.ts` | public exports | Modify: export `ObjStmDamage` |
| `test/helpers/damage-pdf.ts` | damage helpers | Modify: add `corruptObjStmPayload` |
| `test/objstm.test.ts` | decoder unit tests | Create |
| `test/objstm-recovery.test.ts` | end-to-end recovery | Create |
| `test/damage-helpers.test.ts` | helper load-bearing list | Modify: add the new helper |
| `README.md`, `CLAUDE.md` | docs | Modify |

---

### Task 1: Partial inflate in the filter pipeline

`src/filters.ts` is the only place that calls `inflateSync`. Node throws
`Z_BUF_ERROR` on a truncated or corrupt payload; with
`finishFlush: Z_SYNC_FLUSH` it returns the bytes it produced before hitting the
damage. A well-formed payload decodes identically either way, so the option is
inert on the healthy path.

Both predictor implementations in `src/predictor.ts` already tolerate a short
buffer — `pngPredictor` floors to whole rows and `tiffPredictor` stops at
`r + rowLen <= length` — so no predictor change is needed.

**Files:**
- Modify: `src/filters.ts`
- Modify: `src/flate.ts`
- Test: `test/flate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `decodeStream(s: PdfStream, opts?: DecodeOptions): Uint8Array` and
  `export interface DecodeOptions { partial?: boolean }`, both exported from
  `src/filters.ts` and re-exported from `src/flate.ts` as `inflateStream` and
  `DecodeOptions`.

- [ ] **Step 1: Write the failing test**

Append to `test/flate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeStream } from '../src/filters.js';
import { PdfStream, name } from '../src/types.js';

function flateStream(raw: Uint8Array): PdfStream {
  return {
    kind: 'stream',
    dict: new Map<string, any>([['Filter', name('FlateDecode')], ['Length', raw.length]]),
    raw,
  };
}

describe('partial inflate', () => {
  const source = new TextEncoder().encode('A'.repeat(300));

  it('returns the prefix of a payload cut short', () => {
    const full = new Uint8Array(deflateSync(Buffer.from(source)));
    const cut = flateStream(full.subarray(0, full.length - 5));

    expect(() => decodeStream(cut)).toThrow();
    const partial = decodeStream(cut, { partial: true });
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(source.length);
    // What did come out is correct, not merely present.
    expect(partial).toEqual(source.subarray(0, partial.length));
  });

  it('decodes an undamaged payload identically with and without the option', () => {
    const s = flateStream(new Uint8Array(deflateSync(Buffer.from(source))));
    expect(decodeStream(s, { partial: true })).toEqual(decodeStream(s));
    expect(decodeStream(s)).toEqual(source);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/flate.test.ts`
Expected: FAIL — `decodeStream` takes one argument, so `{ partial: true }` is a
type error and the truncated case throws.

- [ ] **Step 3: Thread the option through `src/filters.ts`**

Change the zlib import on line 1:

```ts
import { inflateSync, deflateSync, constants } from 'node:zlib';
```

Add the option type next to `TerminalFilter`:

```ts
/** Decode-time options. `partial` makes FlateDecode return the bytes produced
 *  before a truncated or corrupt payload stopped it, instead of throwing. Only
 *  the damaged-file paths pass it; a well-formed payload decodes identically. */
export interface DecodeOptions { partial?: boolean }
```

Give `decodeOne` the flag and use it for the two Flate spellings:

```ts
function decodeOne(
  filter: string, input: Uint8Array, parms: PdfDict | undefined, partial = false,
): Uint8Array {
  switch (filter) {
    case 'FlateDecode': case 'Fl':
      return withPredictor(parms, new Uint8Array(inflateSync(
        Buffer.from(input),
        partial ? { finishFlush: constants.Z_SYNC_FLUSH } : undefined,
      )));
```

Leave the other cases untouched, then thread it through the two callers:

```ts
export function applyDecodeFilters(
  raw: Uint8Array, names: string[], parms: (PdfDict | undefined)[],
  opts?: DecodeOptions,
): { bytes: Uint8Array; terminal?: TerminalFilter } {
  let bytes = raw;
  for (let k = 0; k < names.length; k++) {
    const nm = names[k];
    if (IMAGE_CODECS.has(nm)) return { bytes, terminal: { name: nm, parms: parms[k] } };
    bytes = decodeOne(nm, bytes, parms[k], opts?.partial);
  }
  return { bytes };
}

export function decodeStream(s: PdfStream, opts?: DecodeOptions): Uint8Array {
  const { names, parms } = filterList(s);
  if (names.length === 0) return s.raw;
  const { bytes, terminal } = applyDecodeFilters(s.raw, names, parms, opts);
  if (terminal) throw new UnsupportedFeatureError(`unsupported filter for stream decode: ${terminal.name}`);
  return bytes;
}
```

- [ ] **Step 4: Re-export the type from `src/flate.ts`**

```ts
// FlateDecode + predictor now live in the generalized filter pipeline.
// Kept as a named re-export so existing callers (xref/objstm/XMP/content/
// embedded-file) transparently gain LZW + ASCII filter support.
export { decodeStream as inflateStream } from './filters.js';
export type { DecodeOptions } from './filters.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/flate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/filters.ts src/flate.ts test/flate.test.ts
git commit -m "feat(filters): optional partial inflate for damaged payloads (dxfk.3)"
```

---

### Task 2: `decodeObjStm` degrades per object

The whole rewrite of `src/objstm.ts`. Four faults, each degraded; see the spec
for why each one matters.

One honesty constraint to keep in mind while writing `damage.lost`: it can only
name object numbers the header actually yielded. On the common truncation the
header is intact — it sits at the front of the payload — so every number is
known. When the header itself is short, the missing numbers are unrecoverable
and only the count discrepancy can be reported, which is what `detail` is for.

**Files:**
- Modify: `src/objstm.ts` (full rewrite of `decodeObjStm`)
- Test: `test/objstm.test.ts` (create)

**Interfaces:**
- Consumes: `inflateStream(s, { partial: true })` from Task 1.
- Produces:

```ts
export interface ObjStmDamage {
  container: number;
  recovered: number[];
  lost: number[];
  detail: string;
}
export interface ObjStmResult {
  objects: Map<number, PdfObject>;
  damage?: ObjStmDamage;
}
export function decodeObjStm(s: PdfStream, container: number): ObjStmResult;
```

- [ ] **Step 1: Write the failing tests**

Create `test/objstm.test.ts`. Every fixture is built by hand so each fault is
isolated and the object numbering is predictable — do not use
`Save({ compressed: true })` here, that is Task 7's job.

```ts
import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodeObjStm } from '../src/objstm.js';
import { PdfStream, PdfObject, name, isDict } from '../src/types.js';
import { PdfParseError } from '../src/errors.js';

/** Build a well-formed /ObjStm payload: "num off num off ..." then the bodies.
 *  Returns the payload and the /First value that goes with it. */
function objStmPayload(bodies: Array<{ num: number; body: string }>) {
  let offsets = '';
  let data = '';
  for (const { num, body } of bodies) {
    offsets += `${num} ${data.length} `;
    data += `${body} `;
  }
  return { text: offsets + data, first: offsets.length };
}

function objStm(
  bodies: Array<{ num: number; body: string }>,
  over: Partial<{ N: number; First: number; payload: Uint8Array }> = {},
): PdfStream {
  const { text, first } = objStmPayload(bodies);
  const raw = over.payload
    ?? new Uint8Array(deflateSync(Buffer.from(text, 'latin1')));
  return {
    kind: 'stream',
    dict: new Map<string, PdfObject>([
      ['Type', name('ObjStm')],
      ['N', over.N ?? bodies.length],
      ['First', over.First ?? first],
      ['Filter', name('FlateDecode')],
      ['Length', raw.length],
    ]),
    raw,
  };
}

const THREE = [
  { num: 5, body: '<< /Type /Catalog /Pages 6 0 R >>' },
  { num: 6, body: '<< /Type /Pages /Count 1 /Kids [7 0 R] >>' },
  { num: 7, body: '<< /Type /Page /Parent 6 0 R >>' },
];

describe('decodeObjStm', () => {
  it('decodes an undamaged container and reports no damage', () => {
    const { objects, damage } = decodeObjStm(objStm(THREE), 4);
    expect([...objects.keys()]).toEqual([5, 6, 7]);
    expect(damage).toBeUndefined();
    const cat = objects.get(5);
    expect(isDict(cat) && (cat.get('Type') as any).name).toBe('Catalog');
  });

  it('keeps the objects a truncated payload did not reach', () => {
    const full = new Uint8Array(deflateSync(
      Buffer.from(objStmPayload(THREE).text, 'latin1')));
    const s = objStm(THREE, { payload: full.subarray(0, Math.floor(full.length * 0.6)) });

    const { objects, damage } = decodeObjStm(s, 4);
    expect(objects.get(5)).toBeTruthy();          // before the damage
    expect(damage).toBeDefined();
    expect(damage!.container).toBe(4);
    expect(damage!.recovered.length).toBeGreaterThan(0);
    expect(damage!.lost.length).toBeGreaterThan(0);
    // Every declared object is accounted for in exactly one of the two lists.
    expect([...damage!.recovered, ...damage!.lost].sort()).toEqual([5, 6, 7]);
  });

  it('reads what the header holds when /N overstates it', () => {
    const { objects, damage } = decodeObjStm(objStm(THREE, { N: 9 }), 4);
    expect([...objects.keys()]).toEqual([5, 6, 7]);
    expect(damage).toBeDefined();
    expect(damage!.detail).toContain('9');
  });

  it('recovers /First from the header end when the declared value is unusable', () => {
    for (const First of [0, 999999]) {
      const { objects, damage } = decodeObjStm(objStm(THREE, { First }), 4);
      expect([...objects.keys()]).toEqual([5, 6, 7]);
      expect(damage).toBeDefined();
    }
  });

  it('drops only the entry that will not parse', () => {
    const bodies = [
      { num: 5, body: '<< /Type /Catalog /Pages 6 0 R >>' },
      { num: 6, body: '<< /Type /Pages /Count' },   // unterminated dict
      { num: 7, body: '<< /Type /Page /Parent 6 0 R >>' },
    ];
    const { objects, damage } = decodeObjStm(objStm(bodies), 4);
    expect([...objects.keys()]).toEqual([5, 7]);
    expect(damage!.lost).toEqual([6]);
  });

  it('bounds the header loop by the data, not by /N', () => {
    // A 30-byte dict must not be able to demand 2^31 iterations. Assert the
    // bound directly: nothing beyond what the payload could hold comes back.
    const s = objStm(THREE, { N: 2 ** 31 });
    const { objects, damage } = decodeObjStm(s, 4);
    expect(objects.size).toBeLessThanOrEqual(3);
    expect(damage).toBeDefined();
  });

  it('throws when the container yields nothing to work with', () => {
    const s = objStm(THREE, { payload: Uint8Array.of(0x5a, 0x5a, 0x5a, 0x5a) });
    expect(() => decodeObjStm(s, 4)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/objstm.test.ts`
Expected: FAIL — `decodeObjStm` takes one argument and returns a bare `Map`, so
every destructure of `{ objects, damage }` is a type error.

- [ ] **Step 3: Rewrite `src/objstm.ts`**

Replace the file contents entirely:

```ts
import { Lexer } from './lexer.js';
import { ObjectParser } from './object-parser.js';
import { inflateStream } from './flate.js';
import { PdfObject, PdfStream } from './types.js';
import { PdfParseError } from './errors.js';

/** What one /ObjStm container yielded, and what it cost. Surfaced verbatim as
 *  RecoveryReport.objectStreams.
 *
 *  `lost` can only name numbers the header actually yielded. A truncation
 *  leaves the header intact — it sits at the front of the payload — so the
 *  numbers are known; a container whose header is itself short can only report
 *  the count discrepancy, which is what `detail` carries. */
export interface ObjStmDamage {
  /** Object number of the container itself. */
  container: number;
  /** Objects the container declared and this decode produced. */
  recovered: number[];
  /** Objects the container declared that did not survive the damage. */
  lost: number[];
  detail: string;
}

export interface ObjStmResult {
  objects: Map<number, PdfObject>;
  /** Undefined when the container decoded whole. */
  damage?: ObjStmDamage;
}

/** Shortest possible header pair, "0 0 ", so the payload length caps how many
 *  pairs can exist however large /N claims to be. */
const MIN_PAIR_BYTES = 4;

/** Decode an /ObjStm into objectNumber -> PdfObject, degrading per object: an
 *  object wholly inside the surviving payload is recovered even when the
 *  container is damaged. Throws only when there is nothing to work with. */
export function decodeObjStm(s: PdfStream, container: number): ObjStmResult {
  const declaredN = s.dict.get('N');
  const declaredFirst = s.dict.get('First');
  const notes: string[] = [];

  // Inflate strictly first: the healthy path must stay exactly as it was, and
  // a partial inflate silently returns 0 bytes for a payload that is simply
  // not DEFLATE at all, which would turn a hard error into an empty container.
  let data: Uint8Array;
  try {
    data = inflateStream(s);
  } catch {
    data = inflateStream(s, { partial: true });
    notes.push(`payload inflated to ${data.length} bytes before it stopped`);
  }
  if (data.length === 0)
    throw new PdfParseError(`object stream ${container} payload did not decode`);

  // Header: pairs of "objNum offset". Read what is there rather than what /N
  // claims, and never let /N alone decide how many iterations to run.
  const cap = Math.ceil(data.length / MIN_PAIR_BYTES);
  const want = typeof declaredN === 'number' && declaredN >= 0
    ? Math.min(declaredN, cap) : cap;
  if (typeof declaredN !== 'number') notes.push('no usable /N');
  const lx = new Lexer(data, 0);
  const pairs: Array<{ num: number; off: number }> = [];
  let headerEnd = 0;
  for (let i = 0; i < want; i++) {
    const a = lx.next(); const b = lx.next();
    if (a.t !== 'num' || b.t !== 'num') break;
    pairs.push({ num: a.v, off: b.v });
    headerEnd = lx.pos;
  }
  if (typeof declaredN === 'number' && pairs.length !== declaredN)
    notes.push(`header yielded ${pairs.length} of ${declaredN} declared pairs`);
  if (pairs.length === 0)
    throw new PdfParseError(`object stream ${container} has no readable header`);

  // Every object offset is relative to /First, so a wrong one lands every parse
  // in the middle of something else. The header's own end is a lower bound and
  // is already computed.
  let first = headerEnd;
  if (typeof declaredFirst === 'number'
    && declaredFirst >= headerEnd && declaredFirst <= data.length) {
    first = declaredFirst;
  } else {
    notes.push(`/First ${String(declaredFirst)} unusable, using header end ${headerEnd}`);
  }

  const objects = new Map<number, PdfObject>();
  const lost: number[] = [];
  for (const { num, off } of pairs) {
    const at = first + off;
    if (!Number.isFinite(at) || at < 0 || at >= data.length) { lost.push(num); continue; }
    try {
      objects.set(num, new ObjectParser(new Lexer(data, at)).parseObject());
    } catch {
      lost.push(num);
    }
  }
  if (lost.length > 0) notes.push(`${lost.length} of ${pairs.length} objects did not parse`);

  if (notes.length === 0) return { objects };
  return {
    objects,
    damage: {
      container,
      recovered: [...objects.keys()],
      lost,
      detail: notes.join('; '),
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/objstm.test.ts`
Expected: PASS, all eight.

If the "bounds the header loop" test is slow (over a second), the bound is not
being applied — check that `want` is `Math.min(declaredN, cap)` and not
`declaredN`.

- [ ] **Step 5: Prove the bound is load-bearing**

Temporarily change `want` to use `declaredN` directly, run
`npx vitest run test/objstm.test.ts -t 'bounds the header loop'`, and confirm it
hangs or dies rather than passing. Restore the line afterwards. Record the
result in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/objstm.ts test/objstm.test.ts
git commit -m "feat(objstm): decode per object and report the damage (dxfk.3)"
```

---

### Task 3: `expandObjectStreams` registers partial contents

`src/rebuild.ts` skips a container that will not decode with a bare `continue`
— its own comment names dxfk.3 as the fix. It now registers whatever the
container yielded and hands the damage back to its caller.

**Files:**
- Modify: `src/rebuild.ts` (lines 26-53, `expandObjectStreams`)
- Test: `test/rebuild.test.ts`

**Interfaces:**
- Consumes: `decodeObjStm(s, container): ObjStmResult` and `ObjStmDamage` from
  Task 2.
- Produces:
  `expandObjectStreams(entries, load): { added: number[]; damaged: ObjStmDamage[] }`
  — a shape change from the current `number[]`. Task 4 updates the one caller.

- [ ] **Step 1: Write the failing test**

Append to `test/rebuild.test.ts`, following the fixture style already in that
file for `expandObjectStreams`:

```ts
describe('expandObjectStreams on a damaged container', () => {
  it('registers what the container yielded and reports the loss', () => {
    // Same hand-built container as test/objstm.test.ts, truncated.
    const bodies = [
      { num: 5, body: '<< /Type /Catalog /Pages 6 0 R >>' },
      { num: 6, body: '<< /Type /Pages /Count 1 /Kids [7 0 R] >>' },
      { num: 7, body: '<< /Type /Page /Parent 6 0 R >>' },
    ];
    let offsets = ''; let data = '';
    for (const { num, body } of bodies) {
      offsets += `${num} ${data.length} `;
      data += `${body} `;
    }
    const full = new Uint8Array(deflateSync(Buffer.from(offsets + data, 'latin1')));
    const raw = full.subarray(0, Math.floor(full.length * 0.6));
    const container: PdfStream = {
      kind: 'stream',
      dict: new Map<string, PdfObject>([
        ['Type', name('ObjStm')], ['N', 3], ['First', offsets.length],
        ['Filter', name('FlateDecode')], ['Length', raw.length],
      ]),
      raw,
    };

    const entries = new Map<number, XrefEntry>([
      [4, { type: 'offset', offset: 0, gen: 0 }],
    ]);
    const { added, damaged } = expandObjectStreams(entries, () => container);

    expect(added.length).toBeGreaterThan(0);
    expect(entries.get(added[0])).toMatchObject({ type: 'compressed', streamObj: 4 });
    expect(damaged.length).toBe(1);
    expect(damaged[0].container).toBe(4);
    expect(damaged[0].lost.length).toBeGreaterThan(0);
  });
});
```

Add whatever imports that file is missing: `deflateSync` from `node:zlib`,
`PdfStream`/`PdfObject`/`name` from `../src/types.js`, `XrefEntry` from
`../src/xref.js`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/rebuild.test.ts`
Expected: FAIL — `expandObjectStreams` returns an array, so destructuring
`{ added, damaged }` yields `undefined`.

- [ ] **Step 3: Update `expandObjectStreams`**

Change the import at the top of `src/rebuild.ts`:

```ts
import { decodeObjStm, ObjStmDamage } from './objstm.js';
```

Replace the function body (keep the existing doc comment above it, minus its
last sentence about dxfk.3, which this task resolves):

```ts
export function expandObjectStreams(
  entries: Map<number, XrefEntry>,
  load: (num: number) => PdfObject,
): { added: number[]; damaged: ObjStmDamage[] } {
  const added: number[] = [];
  const damaged: ObjStmDamage[] = [];
  for (const [num, e] of [...entries]) {
    if (e.type !== 'offset') continue;
    let contents: Map<number, PdfObject>;
    try {
      const s = load(num);
      if (!isStream(s)) continue;
      const t = s.dict.get('Type');
      if (!isName(t) || t.name !== 'ObjStm') continue;
      const r = decodeObjStm(s, num);
      contents = r.objects;
      // A container that yielded something still yielded it: register the
      // partial contents rather than dropping every object it declared.
      if (r.damage) damaged.push(r.damage);
    } catch {
      continue;
    }
    let index = 0;
    for (const inner of contents.keys()) {
      if (!entries.has(inner)) {
        entries.set(inner, { type: 'compressed', streamObj: num, index });
        added.push(inner);
      }
      index++;
    }
  }
  return { added, damaged };
}
```

- [ ] **Step 4: Fix the caller so the build compiles**

In `src/document.ts`, the line currently reading
`if (alternates) repaired.push(...expandObjectStreams(entries, parseEntry));`
becomes:

```ts
    if (alternates) {
      const ex = expandObjectStreams(entries, parseEntry);
      repaired.push(...ex.added);
      for (const d of ex.damaged) damagedStreams.set(d.container, d);
    }
```

`damagedStreams` does not exist yet — declare it beside `objStmCache` so this
task compiles on its own; Task 4 gives it its purpose. It is keyed by container
number so that the two decode sites (here and `parseEntry`) cannot record the
same container twice:

```ts
    const damagedStreams = new Map<number, ObjStmDamage>();
```

with `import { decodeObjStm, ObjStmDamage } from './objstm.js';` updated at the
top of `src/document.ts`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/rebuild.test.ts && npm run typecheck`
Expected: PASS, and a clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add src/rebuild.ts src/document.ts test/rebuild.test.ts
git commit -m "feat(recover): expand the contents a damaged /ObjStm still yields (dxfk.3)"
```

---

### Task 4: `Document.build` separates the two kinds of loss

The narrow exemption. `failed` keeps its meaning — "would not parse at an
offset, still fatal on a sound file" — and a new set carries objects a damaged
container declared but did not produce.

**Files:**
- Modify: `src/document.ts` (`BuildResult` interface; `parseEntry`'s compressed
  branch; the `return` at the end of `build`)
- Test: covered end-to-end by Task 7; no separate test here, because
  `BuildResult` is private to `document.ts` and has no public surface of its own.

**Interfaces:**
- Consumes: `decodeObjStm(s, container): ObjStmResult` (Task 2), the
  `objStmDamage` map declared in Task 3.
- Produces: `BuildResult.lostInObjStm: Set<number>` and
  `BuildResult.objStmDamage: ObjStmDamage[]`, read by Task 5.

- [ ] **Step 1: Extend `BuildResult`**

```ts
/** One object-building pass over an entry map, from {@link Document.build}. */
interface BuildResult {
  objects: Map<number, PdfObject>;
  /** Object numbers whose parse threw, after any fallback candidates. Still
   *  fatal on a structurally sound file — see the rethrow in Open. */
  failed: Set<number>;
  /** Object numbers a damaged /ObjStm declared but did not produce. Reported,
   *  never fatal: an object inside a container has no `N G obj` header, so the
   *  sweep can never find it and there is no repair that failed. */
  lostInObjStm: Set<number>;
  /** Per-container damage records, in container order. */
  objStmDamage: ObjStmDamage[];
  /** Object numbers whose offset came from the sweep rather than the xref. */
  repaired: number[];
  permissions: Permissions | undefined;
}
```

- [ ] **Step 2: Collect damage in `parseEntry`'s compressed branch**

Replace the `else` branch of `parseEntry` (the `entry.type !== 'offset'` case):

```ts
        } else {
          let map = objStmCache.get(entry.streamObj);
          if (!map) {
            const s = parseEntry(entry.streamObj);
            if (!isStream(s)) throw new PdfParseError(`object stream ${entry.streamObj} is not a stream`);
            const r = decodeObjStm(s, entry.streamObj);
            if (r.damage) damagedStreams.set(entry.streamObj, r.damage);
            map = r.objects;
            objStmCache.set(entry.streamObj, map);
          }
          // A number the container declared but did not produce resolves to
          // null, per the spec rule for a reference to a non-existent object.
          value = map.get(num) ?? null;
          // Objects from an object stream are already plaintext — do not decrypt.
        }
```

- [ ] **Step 3: Derive `lostInObjStm` and return it**

Replace the final `return` of `build`:

```ts
    // Every number a damaged container declared but did not produce. Derived
    // from the damage records rather than from a throw, because a missing entry
    // resolves to null quietly — which is exactly why it must be reported.
    const lostInObjStm = new Set<number>();
    for (const d of damagedStreams.values()) for (const n of d.lost) lostInObjStm.add(n);

    return {
      objects, failed, lostInObjStm,
      objStmDamage: [...damagedStreams.values()],
      repaired, permissions,
    };
```

- [ ] **Step 4: Verify the build compiles**

Run: `npm run typecheck`
Expected: clean. If `BuildResult` is constructed anywhere else in the file, add
the two new fields there too.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Nothing reads the new fields yet, so this is a no-op refactor —
if anything goes red here, it is a mistake in Step 2, not an expected change.

- [ ] **Step 6: Commit**

```bash
git add src/document.ts
git commit -m "feat(recover): separate /ObjStm loss from a failed parse in BuildResult (dxfk.3)"
```

---

### Task 5: `Open` reports the damage

**Files:**
- Modify: `src/document.ts` (`RecoveryReport`; the report block in `Open`)
- Modify: `src/index.ts`
- Test: covered end-to-end by Task 7.

**Interfaces:**
- Consumes: `BuildResult.lostInObjStm` / `.objStmDamage` (Task 4),
  `ObjStmDamage` (Task 2).
- Produces: `RecoveryReport.objectStreams?: ObjStmDamage[]` and the
  `'objstm-undecodable'` reason, both public.

- [ ] **Step 1: Extend `RecoveryReport`**

```ts
export interface RecoveryReport {
  reason: 'startxref-unreadable' | 'xref-unparsable'
        | 'object-parse-failure' | 'root-not-catalog'
        | 'objstm-undecodable';
  /** e.g. 'startxref pointed at offset 91234, past end of file' */
  detail: string;
  /** Objects whose offset came from the sweep rather than the xref. */
  repaired: number[];
  /** Objects that never parsed; null in the model. Carries both a failed parse
   *  and an object a damaged /ObjStm declared but did not produce. */
  lost: number[];
  /** Present only when no trailer survived and one was rebuilt from the
   *  objects; describes what synthesis chose. */
  trailer?: TrailerChoice;
  /** Present when any /ObjStm container decoded only partially; one record per
   *  damaged container. */
  objectStreams?: ObjStmDamage[];
}
```

- [ ] **Step 2: Add the reason and skip the pointless sweep**

Replace the report block in `Open` (currently the `if (pass.failed.size > 0)`
chain through the closing brace of `if (report) { ... }`):

```ts
    // Three damage signals reachable from here: an object that would not parse
    // at the offset the xref gave, a /Root that is not a catalog (a byte shift
    // that happened to land on a valid but wrong object), or an /ObjStm that
    // decoded only partially.
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
    } else if (pass.objStmDamage.length > 0) {
      const d = pass.objStmDamage[0];
      report = {
        reason: 'objstm-undecodable',
        detail: `object stream ${d.container} decoded ${d.recovered.length} of `
          + `${d.recovered.length + d.lost.length} objects`,
        repaired: [], lost: [],
      };
    }

    // A damaged container is the one signal the sweep cannot answer: an object
    // inside an /ObjStm has no `N G obj` header, so there is nothing to find.
    // Sweeping anyway would be pure cost on a file whose xref read cleanly.
    if (report && report.reason !== 'objstm-undecodable') {
      const sweep = sweepObjects(buf);
      // Merge, never replace: entries the xref already had — including every
      // `compressed` one, which a sweep can never find — are kept, and swept
      // offsets fill only the gaps.
      const merged = new Map(entries);
      for (const [num, list] of sweep.candidates) {
        if (!merged.has(num)) {
          const c = list[list.length - 1];
          merged.set(num, { type: 'offset', offset: c.offset, gen: c.gen });
        }
      }
      pass = Document.build(buf, merged, trailer, opts, sweep.candidates);
      report.repaired = pass.repaired;
      // Strictness: reaching here means readXref succeeded, and the reason being
      // `object-parse-failure` means /Root resolved to a catalog (otherwise the
      // reason would be `root-not-catalog`). So the document is structurally
      // sound and an object that still will not parse is a genuine error —
      // exactly as before this feature existed. The sweep was a repair attempt,
      // not a licence to degrade. Only an already-damaged file degrades to null.
      //
      // `lostInObjStm` is deliberately not consulted here: an object inside a
      // container never had a repair to fail, so the rule this guard states does
      // not reach it. That is the whole of dxfk.3's exemption.
      //
      // Testing `rootIsCatalog` again here would be dead code: a document whose
      // /Root is not a catalog fails in the Document constructor regardless, so
      // the condition can never change the outcome. Verified by mutation.
      if (pass.failed.size > 0 && report.reason === 'object-parse-failure') {
        throw new PdfParseError(report.detail);
      }
    }

    if (report) {
      report.lost = [...pass.failed, ...pass.lostInObjStm];
      if (pass.objStmDamage.length > 0) report.objectStreams = pass.objStmDamage;
    }
```

- [ ] **Step 3: Carry the damage on the sweep-only path too**

The `xrefFailure` branch earlier in `Open` builds its own report. After the line
`xrefFailure.lost = [...pass.failed];` add:

```ts
      xrefFailure.lost = [...pass.failed, ...pass.lostInObjStm];
      if (pass.objStmDamage.length > 0) xrefFailure.objectStreams = pass.objStmDamage;
```

(replacing the existing `xrefFailure.lost` assignment).

- [ ] **Step 4: Export the type**

`RecoveryReport` and `TrailerChoice` are exported from `src/index.ts` in a
grouped `export type { ... } from './document.js';` block on lines 9-11.
`ObjStmDamage` lives in `objstm.ts`, not `document.ts`, so it needs its own line
directly after that block:

```ts
export type {
  SplitOptions, ExtractPagesOptions, InsertPagesOptions, OpenOptions, SaveOptions,
  PubSecRecipient, RecoveryReport, TrailerChoice,
} from './document.js';
export type { ObjStmDamage } from './objstm.js';
```

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS. No existing test builds a damaged container, so behaviour for
every current fixture is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/document.ts src/index.ts
git commit -m "feat(recover): surface partial /ObjStm decoding on doc.recovery (dxfk.3)"
```

---

### Task 6: The damage helper

**Files:**
- Modify: `test/helpers/damage-pdf.ts`
- Modify: `test/damage-helpers.test.ts`

**Interfaces:**
- Produces: `corruptObjStmPayload(pdf: Uint8Array, keepFraction?: number): Uint8Array`

- [ ] **Step 1: Add the helper**

Append to `test/helpers/damage-pdf.ts`:

```ts
/** Overwrite the tail of the first /ObjStm payload in place. Byte length is
 *  preserved, so every xref offset stays valid and the container is the only
 *  damage in the file — which is what makes an assertion about it an assertion
 *  about /ObjStm recovery rather than about the sweep. `keepFraction` is the
 *  share of the payload left intact. */
export function corruptObjStmPayload(pdf: Uint8Array, keepFraction = 0.6): Uint8Array {
  const text = asText(pdf);
  const t = text.indexOf('/ObjStm');
  if (t < 0) throw new Error('fixture has no /ObjStm');
  const kw = text.indexOf('stream', t);
  if (kw < 0) throw new Error('/ObjStm has no stream keyword');
  let start = kw + 'stream'.length;
  if (text[start] === '\r') start++;
  if (text[start] === '\n') start++;
  const end = text.indexOf('endstream', start);
  if (end < 0) throw new Error('/ObjStm has no endstream');
  const len = end - start;
  const keep = Math.max(1, Math.floor(len * keepFraction));
  return asBytes(text.slice(0, start + keep) + 'Z'.repeat(len - keep) + text.slice(end));
}
```

- [ ] **Step 2: Add it to the load-bearing list**

In `test/damage-helpers.test.ts`, import `corruptObjStmPayload` and add a case
to the `it.each` table. The fixture there is `buildClassicPdf(2)`, which is
uncompressed and has no `/ObjStm`, so this case needs its own compressed
fixture — add it as a separate `it` rather than a table row:

```ts
  it('corruptObjStmPayload damages the file', () => {
    const compressed = Document.Open(good()).Save({ compressed: true });
    expect(notCleanlyOpenable(corruptObjStmPayload(compressed))).toBe(true);
  });
```

- [ ] **Step 3: Run the test**

Run: `npx vitest run test/damage-helpers.test.ts`
Expected: PASS. Tasks 1-5 are already in place, so `Open` recovers and
`notCleanlyOpenable` sees a `recovery` report.

This is the one test in the plan that is not written red-first, because it
asserts a property of the *helper* (that it damages the file), not of the code
under development.

- [ ] **Step 4: Confirm the helper produces the intended damage**

The helper is only useful if it damages the container and nothing else. Verify
the reason directly with a throwaway assertion before moving on — temporarily
add to the test:

```ts
    expect(Document.Open(corruptObjStmPayload(compressed)).recovery!.reason)
      .toBe('objstm-undecodable');
```

Run the file. If it throws instead, `keepFraction` is low enough that `/Root`
was lost — raise the default. If `recovery` is `undefined`, the payload still
inflates whole — lower it. Once the default lands on `objstm-undecodable`,
remove the temporary assertion; Task 7 asserts it properly.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/damage-pdf.ts test/damage-helpers.test.ts
git commit -m "test(recover): helper that corrupts an /ObjStm payload in place (dxfk.3)"
```

---

### Task 7: The acceptance criteria, end to end

The issue's acceptance criteria, asserted on a real compressed document: *"A PDF
with a deliberately truncated /ObjStm opens; objects stored before the
truncation point are present and correct; the document surfaces the dropped
objects rather than failing or silently returning an incomplete graph."*

**Files:**
- Test: `test/objstm-recovery.test.ts` (create)

**Interfaces:**
- Consumes: everything from Tasks 1-6.

- [ ] **Step 1: Write the tests**

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { ref } from '../src/types.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { corruptObjStmPayload, corruptObjectBody } from './helpers/damage-pdf.js';

const compressed = (pages = 3) =>
  Document.Open(buildClassicPdf(pages)).Save({ compressed: true });

describe('a damaged /ObjStm', () => {
  it('opens the document and keeps what survived the damage', () => {
    const doc = Document.Open(corruptObjStmPayload(compressed()));

    expect(doc.recovery!.reason).toBe('objstm-undecodable');
    expect(doc.Pages.length).toBeGreaterThan(0);
    // Present *and correct*: compare against the same page of the healthy file,
    // or this passes on a page recovered as an empty husk.
    const good = Document.Open(buildClassicPdf(3));
    expect(doc.Pages[0].GetText()).toBe(good.Pages[0].GetText());
  });

  it('surfaces the dropped objects rather than losing them silently', () => {
    const doc = Document.Open(corruptObjStmPayload(compressed()));
    const damage = doc.recovery!.objectStreams!;

    expect(damage.length).toBe(1);
    expect(damage[0].recovered.length).toBeGreaterThan(0);
    expect(damage[0].lost.length).toBeGreaterThan(0);
    expect(damage[0].detail).toBeTruthy();
    // Every dropped object reaches the caller-facing list too.
    for (const n of damage[0].lost) expect(doc.recovery!.lost).toContain(n);
  });

  it('resolves a reference to a dropped object as null', () => {
    const doc = Document.Open(corruptObjStmPayload(compressed()));
    for (const n of doc.recovery!.objectStreams![0].lost) {
      expect(doc.resolve(ref(n))).toBe(null);
    }
  });

  it('leaves an undamaged compressed file alone', () => {
    const clean = compressed();
    const doc = Document.Open(clean);
    expect(doc.recovery).toBeUndefined();
    // The partial-inflate path must cost nothing on the healthy path.
    expect(Document.Open(clean).Save({ compressed: true }))
      .toEqual(Document.Open(clean).Save({ compressed: true }));
  });

  it('still throws when a sound file has an object that will not parse', () => {
    // The exemption is narrow: it covers objects inside a damaged container and
    // nothing else. This is the assertion that catches it widening.
    expect(() => Document.Open(corruptObjectBody(buildClassicPdf(2), 3)))
      .toThrow();
  });

  it('throws when the damage reaches /Root', () => {
    // /Root is not degradable: with no catalog there is no document to return.
    // Destroying almost the whole payload is the reliable way to reach it,
    // since the catalog is written first into the container.
    expect(() => Document.Open(corruptObjStmPayload(compressed(), 0.02)))
      .toThrow();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/objstm-recovery.test.ts`
Expected: PASS. If `Open` throws, `/Root` did not survive — raise
`keepFraction` in the helper call (pass it explicitly here rather than changing
the helper default, so Task 6's fixture stays as it is).

- [ ] **Step 3: Prove the tests are load-bearing**

For each of the first three tests, break the code path it covers and confirm the
suite goes red, then restore:

| Test | Mutation | Expected |
|---|---|---|
| keeps what survived | make `decodeObjStm` rethrow instead of inflating partially | red |
| surfaces the dropped objects | return `{ objects }` with no `damage` | red |
| resolves as null | — already covered by the two above; skip |
| still throws on a sound file | change the rethrow guard to also consult `lostInObjStm` | red |

Record the outcome in the commit message. A test that stays green under its
mutation is not testing what it claims.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, with the existing `dxfk.1` and `dxfk.2` recovery tests green.

- [ ] **Step 5: Commit**

```bash
git add test/objstm-recovery.test.ts
git commit -m "test(recover): acceptance criteria for a damaged /ObjStm (dxfk.3)"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md` (the damaged-file bullet under Limitations, line ~1867)
- Modify: `CLAUDE.md` (the `objstm.ts` entry in the architecture list)

- [ ] **Step 1: Extend the README bullet**

The existing bullet already says the scan finds an `/ObjStm` container and
registers everything it declares. Add, after that sentence:

> A container whose payload is damaged is now decoded as far as it goes rather
> than dropped whole: every object stored before the damage is recovered, the
> rest are reported in `doc.recovery.objectStreams` (one record per container,
> naming what it recovered and what it cost), and a reference to a dropped
> object resolves to `null`. This is the one loss recovery cannot backfill —
> an object inside an `/ObjStm` exists nowhere else in the file.

- [ ] **Step 2: Add the CLAUDE.md invariant**

`objstm.ts` currently shares a line with `xref.ts`. Give it the invariant:

> **Invariant:** a damaged `/ObjStm` costs its unreadable objects, not the
> container. `decodeObjStm` inflates partially, bounds its header loop by the
> payload rather than by `/N`, recovers `/First` from the header end, and parses
> each object in its own `try`. The numbers it could not produce reach
> `BuildResult.lostInObjStm`, which is deliberately *not* the set the
> `object-parse-failure` rethrow reads: an object inside a container has no
> `N G obj` header, so the sweep that rule reasons about was never available to
> it. Widening the rethrow to consult it would refuse documents over damage that
> provably cannot be repaired.

- [ ] **Step 3: Verify docs match the code**

Re-read both edits against `src/objstm.ts` and `src/document.ts` as written.
Every name mentioned (`objectStreams`, `lostInObjStm`, `decodeObjStm`) must
exist with that exact spelling.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(recover): document per-object /ObjStm degradation (dxfk.3)"
```

---

### Task 9: Close out

- [ ] **Step 1: Full gates**

```bash
npm run typecheck
npm test
```

Both must be green. `npm test` should show the suite total up by 18 tests and no
failures — 2 in `flate.test.ts`, 8 in `objstm.test.ts`, 1 in `rebuild.test.ts`,
1 in `damage-helpers.test.ts`, and 6 in `objstm-recovery.test.ts`.

- [ ] **Step 2: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-dxfk.3 --reason "decodeObjStm decoded as a unit, so any fault in a container took down every object it held — and on a compressed file that made Open throw outright, since the sweep cannot find an object with no 'N G obj' header. It now inflates partially (Z_SYNC_FLUSH keeps the prefix), bounds the header loop by the payload rather than by /N, recovers /First from the header end, and parses each object in its own try. Losses reach doc.recovery.objectStreams as one record per container, and lost objects resolve to null. The object-parse-failure rethrow is unchanged: it reads 'failed', which never contains an object a container declared. Honest limit: an object inside an /ObjStm exists nowhere else in the file, so this loss is the one recovery cannot backfill."
```

- [ ] **Step 3: Push**

```bash
git add -A .beads
git commit -m "chore(beads): sync interactions log for dxfk.3"
git pull --rebase
git push
git status -sb   # must show no ahead/behind markers
```

## Notes for the implementer

**The one thing not to get wrong.** The rethrow in `Document.Open` reads
`pass.failed`. It must keep reading only that. If you find yourself wanting to
add `|| pass.lostInObjStm.size > 0` to it, stop — that inverts the entire point
of the issue. The exemption is narrow on purpose, and Task 7's last test exists
to catch exactly that mistake.

**Why the strict inflate runs first.** `decodeObjStm` tries a normal inflate and
only falls back to the partial one. Going straight to partial would be simpler
and is wrong: a payload that is not DEFLATE at all returns zero bytes under
`Z_SYNC_FLUSH` instead of throwing, which would turn a hard error into a
silently empty container.

**Object numbers in `damage.lost`.** Only numbers the header yielded can be
listed. A truncation leaves the header intact, so in practice they all are — but
do not write an assertion that assumes it for a fixture whose header is short.
