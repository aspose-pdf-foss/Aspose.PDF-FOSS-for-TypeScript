# AF* Form-Call Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recognise Acrobat's standard AForm calls in field scripts (calculate, format, keystroke, validate) and implement their semantics natively, so a form filled in code gets correct totals, formatted appearances and rule checks, while no JavaScript is ever executed.

**Architecture:** A pure recogniser (`afcall.ts`) turns a script into `{ name, args }` or `undefined`. Four pure semantics leaves (`afnumber.ts`, `afdate.ts`, `afspecial.ts`, `afcalc.ts`) transcribe pdf.js's AForm at a pinned commit, and `afrules.ts` dispatches to them. `afform.ts` is the one new module holding a `Document`. It runs `Recalculate` and `CheckValues`; `Field`, `Form` and `Document` gain opt-in entry points. Exactness is anchored by goldens generated from pdf.js by a script outside the suite.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), vitest, Node >= 22. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-aform-recognition-design.md` (read it first, including the amendments).

**Tracking:** beads issue `aspose-pdf-foss-for-ts-jzn8` (already claimed).

## Global Constraints

- Zero runtime dependencies. `src/` may import only `node:` built-ins and its own modules.
- `src/` never executes JavaScript: no `eval`, no `new Function`, no `Function(` constructor, no `node:vm`. Task 12 adds a test that enforces this.
- ESM import specifiers carry `.js` (`import { x } from './afcall.js'`).
- Every `catch` in `src/` calls `rethrowLimit(caught)` first (`test/limits-catch.test.ts`). The plan's code needs no `try`.
- The oracle is pdf.js at commit `d52fdf411a6e4d338180687456e0df019e28475e`, files `src/scripting_api/{aform,util,constants,pdf_object}.js` and `src/shared/{scripting_utils,math_clamp}.js`.
- Opt-in only. A call that passes none of the new options must produce the same bytes as before.
- Errors: `TypeError` for an argument of the wrong kind; `RangeError` for a value a rule rejects under `EnforceRules`.
- No new 2-cycles between modules (`test/import-cycles.test.ts`). `afform.ts` imports `Document`, `Form` and `Field` as types only.
- Run `npm run typecheck` and `npm test` before the final commit; both must be green.

## Review Focus

These inputs are implied by the spec but easy to miss. Each has its test in the owning task.

1. **The literal spelling Acrobat writes:** `AFSimple_Calculate("SUM", new Array ("Text1", "Text2"));`, with `new Array` and a space before its parenthesis, plus a trailing `;`. A user expects this to be recognised (Task 1).
2. **Field-list edges:** a comma-separated name list with and without a space (`"a,b"`, `"a, b"`), and a name that is a string prefix of another (`a` versus `ab`). `a` must not sum `ab` (Task 9).
3. **A custom calculate script listed in `/CO`:** for example `event.value = this.getField("a").value * 2;`. That field keeps its value and is reported `unrecognised`; it is never cleared (Task 9).
4. **A password field carrying a format script,** under `format: true`: the appearance stays masked. The formatted value must never reach the content stream (Task 8).
5. **A no-op `Recalculate()`** on an opened document whose totals are already right, followed by `Sign()`: the signature appends incrementally, so the original bytes survive as a prefix (Task 9).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/afcall.ts` (new) | The recogniser: `parseAfCall`, the signature table, `AfName`, `AfArg`, `AfCall`. Imports nothing. |
| `src/afnumber.ts` (new) | `makeNumber`, `printfFixed`, `numberFormat`, `numberKeystroke`, `percentFormat`. |
| `src/afdate.ts` (new) | `DATE_FORMATS`, `TIME_FORMATS`, `printd`, `scandStrict`, `dateFormat`, `dateKeystroke`. |
| `src/afspecial.ts` (new) | `printx`, `specialFormat`, `specialKeystroke`, `specialKeystrokeEx`. |
| `src/afcalc.ts` (new) | `exactSum`, `simpleCalculate`, `rangeValidate`. |
| `src/afrules.ts` (new) | Dispatch: `formatValue`, `checkValue`, `evaluateRules`, and the public report types. Pure. |
| `src/afform.ts` (new) | `recalculate(doc, fields)` and `checkValues(fields)`. The only new module holding a `Document`. |
| `src/formfield.ts` | `FormattedValue`, `GenerateAppearance(opts)`, `Flatten(opts)`, the `EnforceRules` check in the `Value` setter, and `storeValue`. |
| `src/form.ts` | `GenerateAppearances(opts)`, `Recalculate()`, `CheckValues()`, `EnforceRules`. |
| `src/flatten.ts`, `src/document.ts` | `FlattenForm(opts)`, and the `formEnforceRules` flag. |
| `src/index.ts` | Public type exports. |
| `scripts/gen-aform-goldens.mjs` (new) | The golden generator. Not run by `npm test`. |
| `test/fixtures/aform/*.json`, `PROVENANCE.md` (new) | The goldens and their provenance. |
| `test/helpers/aform-goldens.ts` (new) | Golden loader. |
| `test/afcall.test.ts`, `test/afnumber.test.ts`, `test/afdate.test.ts`, `test/afspecial.test.ts`, `test/afcalc.test.ts`, `test/afrules.test.ts`, `test/aform-appearance.test.ts`, `test/aform-recalc.test.ts`, `test/aform-enforce.test.ts`, `test/aform-noexec.test.ts` (new) | Tests. |

---

### Task 1: The recogniser, `afcall.ts`

**Files:**
- Create: `src/afcall.ts`
- Test: `test/afcall.test.ts`

**Interfaces:**
- Produces: `parseAfCall(script: string): AfCall | undefined`; `type AfName` (the 17 names); `type AfArg = number | string | boolean | readonly string[]`; `interface AfCall { readonly name: AfName; readonly args: readonly AfArg[] }`; `AF_SIGNATURES`.

- [ ] **Step 1: Write the failing test**

```ts
// test/afcall.test.ts
import { describe, it, expect } from 'vitest';
import { parseAfCall, AF_SIGNATURES } from '../src/afcall.js';

describe('parseAfCall accepts one call with literal arguments', () => {
  it('reads a number format call as Acrobat writes it', () => {
    expect(parseAfCall('AFNumber_Format(2, 0, 0, 0, "$", true);'))
      .toEqual({ name: 'AFNumber_Format', args: [2, 0, 0, 0, '$', true] });
  });

  it('accepts the calculation script Acrobat writes, new Array and all', () => {
    // Review Focus 1: Acrobat spells the list as `new Array (...)`, with a space.
    expect(parseAfCall('AFSimple_Calculate("SUM", new Array ("Text1", "Text2"));'))
      .toEqual({ name: 'AFSimple_Calculate', args: ['SUM', ['Text1', 'Text2']] });
  });

  it('accepts an array literal and a comma-separated string list', () => {
    expect(parseAfCall("AFSimple_Calculate('AVG', ['a', 'b'])")?.args).toEqual(['AVG', ['a', 'b']]);
    expect(parseAfCall('AFSimple_Calculate("SUM", "a, b")')?.args).toEqual(['SUM', 'a, b']);
  });

  it('tolerates whitespace, comments and a missing semicolon', () => {
    const s = '  /* fmt */\n AFDate_FormatEx ( "mm/dd/yyyy" ) // done\n';
    expect(parseAfCall(s)).toEqual({ name: 'AFDate_FormatEx', args: ['mm/dd/yyyy'] });
  });

  it('decodes the simple escapes', () => {
    expect(parseAfCall('AFSpecial_KeystrokeEx("a\\"b\\\\c\\n")')?.args).toEqual(['a"b\\c\n']);
  });

  it('reads negative and decimal numbers', () => {
    expect(parseAfCall('AFRange_Validate(true, -5.5, true, .5)')?.args).toEqual([true, -5.5, true, 0.5]);
  });

  it('allows an optional trailing argument to be omitted', () => {
    expect(parseAfCall('AFPercent_Format(2, 0)')?.args).toEqual([2, 0]);
    expect(parseAfCall('AFPercent_Format(2, 0, true)')?.args).toEqual([2, 0, true]);
  });

  it('knows all seventeen names', () => {
    expect(Object.keys(AF_SIGNATURES)).toHaveLength(17);
  });
});

describe('parseAfCall refuses everything else', () => {
  const refused = [
    ['a second statement', 'AFNumber_Format(2,0,0,0,"",true); app.alert(1)'],
    ['an identifier argument', 'AFRange_Validate(true, x, true, 100)'],
    ['an expression argument', 'AFRange_Validate(true, 1+1, true, 100)'],
    ['a \\u escape', 'AFSpecial_KeystrokeEx("\\u0041")'],
    ['a \\x escape', 'AFSpecial_KeystrokeEx("\\x41")'],
    ['an unknown name', 'AFFoo(1)'],
    ['a non-AF function', 'alert(1)'],
    ['a wrong argument type', 'AFNumber_Format("2", 0, 0, 0, "", true)'],
    ['too few arguments', 'AFNumber_Format(2, 0)'],
    ['too many arguments', 'AFDate_FormatEx("m/d", "x")'],
    ['an unterminated string', 'AFDate_FormatEx("m/d)'],
    ['an unterminated comment', 'AFDate_FormatEx("m/d") /* x'],
    ['a newline inside a string', 'AFDate_FormatEx("m\n/d")'],
    ['a number glued to an identifier', 'AFDate_Format(1x)'],
    ['a boolean spelled as an identifier prefix', 'AFRange_Validate(trueish, 0, true, 1)'],
    ['a non-string array member', 'AFSimple_Calculate("SUM", ["a", 1])'],
    ['an empty script', ''],
  ] as const;
  for (const [what, s] of refused) {
    it(`refuses ${what}`, () => { expect(parseAfCall(s)).toBeUndefined(); });
  }

  it('does not find Object.prototype names', () => {
    expect(parseAfCall('constructor()')).toBeUndefined();
    expect(parseAfCall('toString()')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/afcall.test.ts`
Expected: FAIL with "Failed to load url ../src/afcall.js" (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// src/afcall.ts
/**
 * Recognising one call to a standard Acrobat AForm function (jzn8).
 *
 * The library never executes document JavaScript (6t2v.2). What it can do is
 * recognise the SHAPE Acrobat writes for its own built-in functions — exactly
 * one call, literal arguments — and hand the name and arguments to a native
 * implementation. Anything else is `undefined`: a second statement, an
 * identifier or expression as an argument, an escape this scanner does not
 * decode, or a name outside the table. Nothing is partially understood.
 *
 * A pure leaf importing nothing.
 */

type ArgSpec = 'n' | 's' | 'b' | 'b?' | 'fields';

/** Each function's arguments, in order. 'b?' is an optional trailing boolean;
 *  'fields' is AFSimple_Calculate's list, an array or a comma-separated string. */
export const AF_SIGNATURES = {
  AFNumber_Format: ['n', 'n', 'n', 'n', 's', 'b'],
  AFNumber_Keystroke: ['n', 'n', 'n', 'n', 's', 'b'],
  AFPercent_Format: ['n', 'n', 'b?'],
  AFPercent_Keystroke: ['n', 'n'],
  AFDate_Format: ['n'],
  AFDate_FormatEx: ['s'],
  AFDate_Keystroke: ['n'],
  AFDate_KeystrokeEx: ['s'],
  AFTime_Format: ['n'],
  AFTime_FormatEx: ['s'],
  AFTime_Keystroke: ['n'],
  AFTime_KeystrokeEx: ['s'],
  AFSpecial_Format: ['n'],
  AFSpecial_Keystroke: ['n'],
  AFSpecial_KeystrokeEx: ['s'],
  AFRange_Validate: ['b', 'n', 'b', 'n'],
  AFSimple_Calculate: ['s', 'fields'],
} as const satisfies Record<string, readonly ArgSpec[]>;

export type AfName = keyof typeof AF_SIGNATURES;
export type AfArg = number | string | boolean | readonly string[];
export interface AfCall { readonly name: AfName; readonly args: readonly AfArg[] }

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENT_CHAR = /[A-Za-z0-9_$]/;
const ESCAPES: Record<string, string> = { '\\': '\\', "'": "'", '"': '"', n: '\n', r: '\r', t: '\t' };
const SPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', ' ', '﻿']);

class Scanner {
  pos = 0;
  bad = false;
  constructor(private readonly s: string) {}

  /** Skip whitespace and comments. An unterminated block comment marks the scan bad. */
  ws(): void {
    for (;;) {
      const c = this.s[this.pos];
      if (c !== undefined && SPACE.has(c)) { this.pos++; continue; }
      if (c === '/' && this.s[this.pos + 1] === '/') {
        const nl = this.s.indexOf('\n', this.pos);
        this.pos = nl < 0 ? this.s.length : nl + 1;
        continue;
      }
      if (c === '/' && this.s[this.pos + 1] === '*') {
        const end = this.s.indexOf('*/', this.pos + 2);
        if (end < 0) { this.bad = true; this.pos = this.s.length; return; }
        this.pos = end + 2;
        continue;
      }
      return;
    }
  }

  eat(ch: string): boolean {
    if (this.s[this.pos] !== ch) return false;
    this.pos++;
    return true;
  }

  sticky(re: RegExp): string | undefined {
    re.lastIndex = this.pos;
    const m = re.exec(this.s);
    if (m === null) return undefined;
    this.pos = re.lastIndex;
    return m[0];
  }

  atEnd(): boolean { return this.pos >= this.s.length; }

  string(): string | undefined {
    const q = this.s[this.pos];
    if (q !== '"' && q !== "'") return undefined;
    this.pos++;
    let out = '';
    for (;;) {
      const c = this.s[this.pos++];
      if (c === undefined || c === '\n' || c === '\r') return undefined;
      if (c === q) return out;
      if (c === '\\') {
        const e = this.s[this.pos++];
        if (e === undefined || !Object.hasOwn(ESCAPES, e)) return undefined;
        out += ESCAPES[e];
        continue;
      }
      out += c;
    }
  }

  /** A comma-separated list of strings; the opener has been consumed. */
  strings(close: string): string[] | undefined {
    const out: string[] = [];
    this.ws();
    if (this.eat(close)) return out;
    for (;;) {
      this.ws();
      const v = this.string();
      if (v === undefined) return undefined;
      out.push(v);
      this.ws();
      if (this.eat(close)) return out;
      if (!this.eat(',')) return undefined;
    }
  }

  arg(): AfArg | undefined {
    const c = this.s[this.pos];
    if (c === '"' || c === "'") return this.string();
    if (c === '[') { this.pos++; return this.strings(']'); }
    const num = this.sticky(NUMBER);
    if (num !== undefined) {
      const next = this.s[this.pos];
      if (next !== undefined && IDENT_CHAR.test(next)) return undefined;
      const v = Number(num);
      return Number.isFinite(v) ? v : undefined;
    }
    const id = this.sticky(IDENT);
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'new') {
      this.ws();
      if (this.sticky(IDENT) !== 'Array') return undefined;
      this.ws();
      if (!this.eat('(')) return undefined;
      return this.strings(')');
    }
    return undefined;
  }
}

/** One recognised AForm call, or undefined. Never throws. */
export function parseAfCall(script: string): AfCall | undefined {
  if (typeof script !== 'string') return undefined;
  const sc = new Scanner(script);
  sc.ws();
  const name = sc.sticky(IDENT);
  if (name === undefined || !Object.hasOwn(AF_SIGNATURES, name)) return undefined;
  sc.ws();
  if (!sc.eat('(')) return undefined;
  const args: AfArg[] = [];
  sc.ws();
  if (!sc.eat(')')) {
    for (;;) {
      sc.ws();
      const a = sc.arg();
      if (a === undefined) return undefined;
      args.push(a);
      sc.ws();
      if (sc.eat(')')) break;
      if (!sc.eat(',')) return undefined;
    }
  }
  sc.ws();
  sc.eat(';');
  sc.ws();
  if (sc.bad || !sc.atEnd()) return undefined;
  const call: AfCall = { name: name as AfName, args };
  return fits(call) ? call : undefined;
}

function fits({ name, args }: AfCall): boolean {
  const spec: readonly ArgSpec[] = AF_SIGNATURES[name];
  const required = spec.filter((t) => t !== 'b?').length;
  if (args.length < required || args.length > spec.length) return false;
  return args.every((a, i) => {
    switch (spec[i]) {
      case 'n': return typeof a === 'number';
      case 's': return typeof a === 'string';
      case 'b': case 'b?': return typeof a === 'boolean';
      case 'fields': return typeof a === 'string' || Array.isArray(a);
      default: return false;
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/afcall.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Mutation check (must go red, then revert)**

Make each change below, run `npx vitest run test/afcall.test.ts`, confirm at least one case fails, then revert with `git checkout src/afcall.ts`:
1. Delete `if (sc.bad || !sc.atEnd()) return undefined;`. Expect "a second statement" and "an unterminated comment" to fail.
2. Replace `Object.hasOwn(AF_SIGNATURES, name)` with `name in AF_SIGNATURES`. Expect "does not find Object.prototype names" to fail.
3. Delete the `IDENT_CHAR.test(next)` return. Expect "a number glued to an identifier" to fail.

- [ ] **Step 6: Commit**

```bash
git add src/afcall.ts test/afcall.test.ts
git commit -m "feat(jzn8): recognise one literal AForm call without executing it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The pdf.js golden generator and fixtures

**Files:**
- Create: `scripts/gen-aform-goldens.mjs`
- Create (generated): `test/fixtures/aform/number-format.json`, `percent-format.json`, `number-keystroke.json`, `date-format.json`, `date-keystroke.json`, `special-format.json`, `special-keystroke.json`, `range-validate.json`, `simple-calculate.json`, `meta.json`
- Create: `test/fixtures/aform/PROVENANCE.md`
- Create: `test/helpers/aform-goldens.ts`
- Modify: `package.json` (add a `gen:aform` script)

**Interfaces:**
- Produces: `loadGolden<T>(name: string): T[]`; `goldenMeta: { sha: string; sources: Record<string,string>; counts: Record<string, number>; strictFalse: Record<string, number> }`. Record shapes:
  - `number-format`: `{ args: [nDec, sep, neg, currStyle, currency, prepend], value, out }`
  - `percent-format`: `{ args: [nDec, sep, prepend], value, out }`
  - `number-keystroke`: `{ fn: 'AFNumber_Keystroke' | 'AFPercent_Keystroke', args, value, rc }`
  - `date-format`: `{ fn: 'AFDate_Format' | 'AFTime_Format' | 'AFDate_FormatEx', args: [index | picture], value, strict, out? }` (`out` only when `strict` is true)
  - `date-keystroke`: `{ fn: 'AFDate_Keystroke' | 'AFTime_Keystroke' | 'AFDate_KeystrokeEx', args, value, strict, rc? }`
  - `special-format`: `{ psf, value, out }`
  - `special-keystroke`: `{ fn: 'AFSpecial_Keystroke' | 'AFSpecial_KeystrokeEx', args, value, rc }`
  - `range-validate`: `{ args: [bG, nG, bL, nL], value, rc }`
  - `simple-calculate`: `{ op, values, out }`

**Why a script:** pdf.js is the independent reference. The generator is the only place any of its JavaScript runs, and it runs at development time, never in the library. Two pdf.js quirks shape the generator: `util.js` caches its date regex with the `/g` flag, so a reused `Util` alternates between matching and failing (hence a fresh `Util` per case); and its non-strict date parse defaults the year to the current year (hence `strict` recorded, and no `out` recorded for strict failures).

- [ ] **Step 1: Write the generator**

```js
// scripts/gen-aform-goldens.mjs
// Regenerates test/fixtures/aform/*.json from pdf.js's AForm implementation at
// a pinned commit (jzn8). NOT run by `npm test`; needs network access to
// raw.githubusercontent.com. Run: npm run gen:aform
//
// This is the ONLY place pdf.js's JavaScript runs, and it runs at development
// time. The library itself never executes JavaScript (6t2v.2).
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

process.env.TZ = 'UTC';
if (new Date(0).getTimezoneOffset() !== 0) {
  console.error('could not switch to UTC; run with TZ=UTC in the environment');
  process.exit(1);
}

const SHA = 'd52fdf411a6e4d338180687456e0df019e28475e';
const FILES = [
  'src/scripting_api/aform.js', 'src/scripting_api/util.js',
  'src/scripting_api/constants.js', 'src/scripting_api/pdf_object.js',
  'src/shared/scripting_utils.js', 'src/shared/math_clamp.js',
];
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'aform');

// ---- polyfills pdf.js relies on and Node 24 lacks ---------------------------
// getOrInsertComputed is the upsert proposal; semantics are trivial.
if (!Map.prototype.getOrInsertComputed) {
  Map.prototype.getOrInsertComputed = function (k, f) {
    if (!this.has(k)) this.set(k, f(k));
    return this.get(k);
  };
}
// Math.sumPrecise must be EXACTLY rounded. This one is exact BigInt arithmetic
// in units of 2^-1074 — deliberately a different algorithm from src/afcalc.ts's
// Shewchuk summation, so the golden and the implementation cannot share a bug.
function scaled(x) {
  if (x === 0) return 0n;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, x);
  const bits = dv.getBigUint64(0);
  const neg = (bits >> 63n) === 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e;
  if (exp === 0) e = -1074; else { mant |= 1n << 52n; e = exp - 1075; }
  const v = mant << BigInt(e + 1074);
  return neg ? -v : v;
}
function fromScaled(s) {
  if (s === 0n) return 0;
  const neg = s < 0n;
  let m = neg ? -s : s;
  const bl = m.toString(2).length;
  let shift = 0;
  if (bl > 53) {
    shift = bl - 53;
    const rem = m & ((1n << BigInt(shift)) - 1n);
    const half = 1n << BigInt(shift - 1);
    m >>= BigInt(shift);
    if (rem > half || (rem === half && (m & 1n) === 1n)) m += 1n;
  }
  const r = Number(m) * 2 ** (shift - 1074);
  return neg ? -r : r;
}
if (!Math.sumPrecise) {
  Math.sumPrecise = (xs) => { let acc = 0n; for (const x of xs) acc += scaled(x); return fromScaled(acc); };
}

// ---- fetch the pinned sources -----------------------------------------------
const root = mkdtempSync(join(tmpdir(), 'pdfjs-aform-'));
const sources = {};
for (const f of FILES) {
  const res = await fetch(`https://raw.githubusercontent.com/mozilla/pdf.js/${SHA}/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
  sources[f] = createHash('sha256').update(text).digest('hex');
}
const imp = (f) => import(pathToFileURL(join(root, f)).href);
const { AForm } = await imp('src/scripting_api/aform.js');
const { Util } = await imp('src/scripting_api/util.js');
const { DateFormats, TimeFormats } = await imp('src/shared/scripting_utils.js');

// A FRESH Util per case: util.js caches its scand regex with the /g flag, so a
// reused instance alternates between matching and failing on the same input.
function fresh(fields = {}) {
  const util = new Util({});
  const doc = {
    getField: (n) => (Object.hasOwn(fields, n)
      ? { getArray: () => fields[n].map((v) => ({ value: v })) } : null),
  };
  const app = { alert() {}, _eventDispatcher: { mergeChange: (e) => e.value } };
  const color = { black: ['G', 0], red: ['RGB', 1, 0, 0] };
  return { aform: new AForm(doc, app, util, color), util };
}
function run(fn, args, value, fields) {
  const { aform } = fresh(fields);
  globalThis.event = { value, willCommit: true, rc: true, target: { name: 'f', textColor: null } };
  aform[fn](...args);
  return globalThis.event;
}
const strictOk = (fmt, v) => v === '' || fresh().util._scand(fmt, v, true) !== null;

// ---- the grids ----------------------------------------------------------------
const out = {};
const NUM_VALUES = ['0', '-0', '1', '-1', '0.5', '-0.5', '1.005', '2.675', '1234567.891',
  '-1234567.891', '999.9999', '1e15', '-1e15', 'abc', '', '  42 ', '1,5', '0.0001',
  '12345678901234567890'];

out['number-format'] = [];
for (const value of NUM_VALUES) for (let nDec = 0; nDec <= 3; nDec++)
  for (let sep = 0; sep <= 4; sep++) for (let neg = 0; neg <= 3; neg++)
    for (const cur of ['', '$', '€ ']) for (const prepend of [true, false]) {
      const args = [nDec, sep, neg, 0, cur, prepend];
      out['number-format'].push({ args, value, out: String(run('AFNumber_Format', args, value).value) });
    }

out['percent-format'] = [];
for (const value of NUM_VALUES) for (let nDec = 0; nDec <= 3; nDec++)
  for (let sep = 0; sep <= 4; sep++) for (const prepend of [false, true]) {
    const args = [nDec, sep, prepend];
    out['percent-format'].push({ args, value, out: String(run('AFPercent_Format', args, value).value) });
  }

const KEY_VALUES = ['1.5', '1,5', '-2', '+3.', '  4 ', '.5', ',5', '1,234.5', 'abc', '', '1e3', '12.', '-.5', '   '];
out['number-keystroke'] = [];
for (const value of KEY_VALUES) for (let sep = 0; sep <= 4; sep++) {
  const a1 = [2, sep, 0, 0, '', true];
  out['number-keystroke'].push({ fn: 'AFNumber_Keystroke', args: a1, value, rc: run('AFNumber_Keystroke', a1, value).rc });
  const a2 = [2, sep];
  out['number-keystroke'].push({ fn: 'AFPercent_Keystroke', args: a2, value, rc: run('AFPercent_Keystroke', a2, value).rc });
}

const SEEDS = [
  Date.UTC(2024, 1, 29, 13, 5, 9), Date.UTC(1999, 11, 31, 0, 0, 0), Date.UTC(2000, 0, 1, 12, 0, 0),
  Date.UTC(2049, 5, 15, 23, 59, 59), Date.UTC(2050, 5, 15, 1, 2, 3), Date.UTC(2024, 6, 4, 0, 30, 0),
];
const MISMATCH = ['', 'garbage', '2024-13-40', '03/04/24', 'March 4, 2024', '12:30 PM', '0:00 am',
  'Feb 30, 2024', '31/12/1999', '2024-02-30'];
const PICTURES = ['yyyy-mm-dd', 'dd.mm.yyyy', 'mmmm d, yyyy HH:MM:ss', 'ddd mmm d yyyy', 'h:MM tt',
  'HH:MM:ss', 'yy/m/d', '\\Y yyyy', 'd-mmm-yyyy h:MM:ss tt'];
const printd = (fmt, t) => fresh().util.printd(fmt, new Date(t));
const valuesFor = (fmt) => [...new Set([
  ...SEEDS.map((t) => printd(fmt, t)), ...SEEDS.map((t) => printd('mm/dd/yyyy', t)), ...MISMATCH,
])];
const dateJobs = [
  ...DateFormats.map((f, i) => ({ fn: 'AFDate_Format', kfn: 'AFDate_Keystroke', args: [i], fmt: f })),
  ...TimeFormats.map((f, i) => ({ fn: 'AFTime_Format', kfn: 'AFTime_Keystroke', args: [i], fmt: f })),
  ...PICTURES.map((f) => ({ fn: 'AFDate_FormatEx', kfn: 'AFDate_KeystrokeEx', args: [f], fmt: f })),
];
out['date-format'] = [];
out['date-keystroke'] = [];
for (const job of dateJobs) for (const value of valuesFor(job.fmt)) {
  const strict = strictOk(job.fmt, value);
  out['date-format'].push(strict
    ? { fn: job.fn, args: job.args, value, strict, out: String(run(job.fn, job.args, value).value) }
    : { fn: job.fn, args: job.args, value, strict });
  out['date-keystroke'].push(strict
    ? { fn: job.kfn, args: job.args, value, strict, rc: run(job.kfn, job.args, value).rc }
    : { fn: job.kfn, args: job.args, value, strict });
}
for (const i of [-1, 14, 99]) for (const value of ['03/04/24', '']) {
  out['date-keystroke'].push({ fn: 'AFDate_Keystroke', args: [i], value, strict: true, rc: run('AFDate_Keystroke', [i], value).rc });
}

const SPECIAL_VALUES = ['12345', '123456789', '5551234', '5555551234', '555-555-1234', '123-45-6789', 'abc123', '', '1'];
out['special-format'] = [];
for (let psf = 0; psf <= 3; psf++) for (const value of SPECIAL_VALUES)
  out['special-format'].push({ psf, value, out: String(run('AFSpecial_Format', [psf], value).value) });

const SK_VALUES = ['12345', '1234', '12345-6789', '123456789', '555-1234', '5551234', '(555) 555-1234',
  '5555551234', '123-45-6789', 'abc', ''];
const MASKS = ['999-9999', 'AAA-9999', 'OOO', 'XX-99', '99999'];
const MASK_VALUES = ['555-1234', '5551234', 'ABC-1234', 'AB1-1234', 'a1B', 'a1Bc', 'Zz-12', 'Zz12', '12345', '1234', ''];
out['special-keystroke'] = [];
for (let psf = 0; psf <= 3; psf++) for (const value of SK_VALUES)
  out['special-keystroke'].push({ fn: 'AFSpecial_Keystroke', args: [psf], value, rc: run('AFSpecial_Keystroke', [psf], value).rc });
for (const mask of MASKS) for (const value of MASK_VALUES)
  out['special-keystroke'].push({ fn: 'AFSpecial_KeystrokeEx', args: [mask], value, rc: run('AFSpecial_KeystrokeEx', [mask], value).rc });

out['range-validate'] = [];
for (const [bG, bL] of [[false, false], [true, false], [false, true], [true, true]])
  for (const [nG, nL] of [[0, 100], [-5.5, 5.5]])
    for (const value of ['-1', '0', '50', '100', '101', 'abc', '', '1,5', '-5.5', '5.6']) {
      const args = [bG, nG, bL, nL];
      out['range-validate'].push({ args, value, rc: run('AFRange_Validate', args, value).rc });
    }

const CALC = [
  ['SUM', ['1', '2']], ['SUM', ['0.1', '0.2']], ['SUM', ['0.1', '0.2', '0.3']],
  ['SUM', ['1e16', '1', '-1e16']], ['SUM', ['1,5', '2']], ['SUM', ['abc', '3']], ['SUM', ['', '4']],
  ['SUM', []], ['AVG', ['1', '2', '4']], ['AVG', ['0.1', '0.2', '0.4']], ['PRD', ['1.1', '1.1', '1.1']],
  ['PRD', []], ['MIN', ['3', '-2', 'abc']], ['MAX', ['3', '-2', '7.5']],
  ['SUM', ['123456.1234567', '0.0000004']], ['AVG', ['1', 'abc']], ['SUM', ['1e300', '1e300', '-1e300']],
];
out['simple-calculate'] = CALC.map(([op, values]) => {
  const fields = Object.fromEntries(values.map((v, i) => [`f${i}`, [v]]));
  const e = run('AFSimple_Calculate', [op, values.map((_, i) => `f${i}`)], '', fields);
  return { op, values, out: e.value };
});

// ---- write --------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const counts = {};
for (const [name, recs] of Object.entries(out)) {
  counts[name] = recs.length;
  writeFileSync(join(OUT, `${name}.json`), `[\n${recs.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`);
}
const strictFalse = {
  'date-format': out['date-format'].filter((r) => !r.strict).length,
  'date-keystroke': out['date-keystroke'].filter((r) => !r.strict).length,
};
writeFileSync(join(OUT, 'meta.json'), `${JSON.stringify({ sha: SHA, sources, counts, strictFalse }, null, 2)}\n`);
console.log(JSON.stringify({ counts, strictFalse }, null, 2));
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, add after the last `gen:` entry:

```json
"gen:aform": "node scripts/gen-aform-goldens.mjs",
```

- [ ] **Step 3: Run the generator**

Run: `npm run gen:aform`
Expected: it prints counts for all nine files (`number-format` is 9120 and `percent-format` 760; every count is above 0) and writes `test/fixtures/aform/*.json` plus `meta.json`. If a fetch fails, report the HTTP status and stop; do not substitute sources.

Then run it again and confirm `git status test/fixtures/aform` shows no change. The generator must be deterministic; a changed file means a stale-state quirk leaked, so find it before continuing.

- [ ] **Step 4: Write the loader**

```ts
// test/helpers/aform-goldens.ts
import { readFileSync } from 'node:fs';

const dir = new URL('../fixtures/aform/', import.meta.url);

/** One golden file from test/fixtures/aform/, generated from pinned pdf.js. */
export function loadGolden<T>(name: string): T[] {
  return JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as T[];
}

export const goldenMeta = JSON.parse(readFileSync(new URL('meta.json', dir), 'utf8')) as {
  sha: string;
  sources: Record<string, string>;
  counts: Record<string, number>;
  strictFalse: Record<string, number>;
};
```

- [ ] **Step 5: Write `test/fixtures/aform/PROVENANCE.md`**

Fill every value from `meta.json`. Do not type the hashes by hand; copy them.

```markdown
# AForm goldens (jzn8)

**Producer:** pdf.js, `src/scripting_api/aform.js` and `util.js`, an independent
Apache-2.0 reimplementation of Acrobat's AForm functions.
**Commit:** `d52fdf411a6e4d338180687456e0df019e28475e`
**Command:** `npm run gen:aform` (`scripts/gen-aform-goldens.mjs`), run under
`TZ=UTC` (the script switches to it and refuses to run otherwise).

## Sources (SHA-256 of each file as fetched)

| File | SHA-256 |
|---|---|
| src/scripting_api/aform.js | <from meta.json> |
| src/scripting_api/util.js | <from meta.json> |
| src/scripting_api/constants.js | <from meta.json> |
| src/scripting_api/pdf_object.js | <from meta.json> |
| src/shared/scripting_utils.js | <from meta.json> |
| src/shared/math_clamp.js | <from meta.json> |

## Cases

<one row per file from meta.json `counts`, and the two `strictFalse` counts>

## How the generator drives pdf.js

- A fresh `Util` and `AForm` for every case: `util.js` caches its date regex
  with the `/g` flag, so a reused instance alternates between matching and
  failing on the same input.
- `Math.sumPrecise` and `Map.prototype.getOrInsertComputed` are polyfilled,
  since Node 24 has neither. The `sumPrecise` polyfill is exact BigInt
  arithmetic, deliberately a different algorithm from `src/afcalc.ts`'s
  Shewchuk summation, so the two cannot share a rounding bug.
- A stub `event` with `willCommit: true`: keystroke cases are commit-time
  checks only.

## What this does NOT establish

- **pdf.js is not Acrobat.** Agreement is evidence, not conformance, and where
  the two differ we match pdf.js knowingly.
- **Strict date matching only.** A date case where pdf.js's strict parse fails
  is recorded with `strict: false` and no pdf.js answer, because pdf.js's
  fallbacks default the year to the current year and call `Date.parse`. The
  suite asserts OUR behaviour for those cases (value left unformatted, rejected
  by the keystroke check), and asserts their count against `meta.json`.
- **No red text.** Negative styles 1 and 3 change the text colour in a viewer.
  That is outside what a golden records, and outside what we implement.
- **Group expansion and `/CO` order** are library behaviour, not pdf.js
  function behaviour, and are covered by `test/aform-recalc.test.ts`.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-aform-goldens.mjs package.json test/fixtures/aform test/helpers/aform-goldens.ts
git commit -m "test(jzn8): pdf.js AForm goldens and their generator" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Number and percent semantics, `afnumber.ts`

**Files:**
- Create: `src/afnumber.ts`
- Test: `test/afnumber.test.ts`

**Interfaces:**
- Consumes: goldens from Task 2.
- Produces: `makeNumber(v: string | number): number | null`; `printfFixed(sep: number, dec: number, arg: number): string`; `numberFormat(value: string, nDec: number, sepStyle: number, negStyle: number, currStyle: number, strCurrency: string, prepend: boolean): string | undefined`; `numberKeystroke(value: string, sepStyle: number): boolean`; `percentFormat(value: string, nDec: number, sepStyle: number, prepend?: boolean): string | undefined`. `undefined` means "arguments pdf.js would throw on": the call is unrecognised.

- [ ] **Step 1: Write the failing test**

```ts
// test/afnumber.test.ts
import { describe, it, expect } from 'vitest';
import { makeNumber, numberFormat, numberKeystroke, percentFormat } from '../src/afnumber.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

type NumArgs = [number, number, number, number, string, boolean];

describe('afnumber against pdf.js', () => {
  it('AFNumber_Format matches every golden case', () => {
    const cases = loadGolden<{ args: NumArgs; value: string; out: string }>('number-format');
    expect(cases.length).toBe(goldenMeta.counts['number-format']);
    expect(cases.length).toBeGreaterThan(9000);
    const bad = cases.filter((c) => numberFormat(c.value, ...c.args) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('AFPercent_Format matches every golden case', () => {
    const cases = loadGolden<{ args: [number, number, boolean]; value: string; out: string }>('percent-format');
    expect(cases.length).toBe(goldenMeta.counts['percent-format']);
    const bad = cases.filter((c) => percentFormat(c.value, ...c.args) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('the number and percent keystroke checks match every golden case', () => {
    const cases = loadGolden<{ fn: string; args: number[]; value: string; rc: boolean }>('number-keystroke');
    expect(cases.length).toBe(goldenMeta.counts['number-keystroke']);
    const bad = cases.filter((c) => numberKeystroke(c.value, c.args[1]) !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('afnumber edges pdf.js defines and a reader would not guess', () => {
  it('makeNumber replaces only the FIRST comma, so 1,234.5 reads as 1.234', () => {
    expect(makeNumber('1,234.5')).toBe(1.234);
    expect(makeNumber(' 1,5 ')).toBe(1.5);
    expect(makeNumber('abc')).toBeNull();
    expect(makeNumber('1e400')).toBeNull();
  });

  it('refuses arguments pdf.js would throw on', () => {
    expect(numberFormat('1', -1, 0, 0, 0, '', true)).toBeUndefined();
    expect(numberFormat('1', 1.5, 0, 0, 0, '', true)).toBeUndefined();
    expect(numberFormat('1', 2, 0, 0, 0, '%', true)).toBeUndefined();
    expect(percentFormat('1', -1, 0)).toBeUndefined();
    expect(percentFormat('1', 200, 0)).toBeUndefined();
  });

  it('formats a currency outside ASCII verbatim', () => {
    expect(numberFormat('1234.5', 2, 2, 0, 0, ' €', false)).toBe('1.234,50 €');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/afnumber.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/afnumber.ts
/**
 * AForm number and percent semantics (jzn8), transcribed from pdf.js
 * `src/scripting_api/aform.js` and the `%,<sep>.<dec>f` path of `util.printf`,
 * commit d52fdf411a6e4d338180687456e0df019e28475e (Apache-2.0). Checked against
 * goldens generated from that code (`test/fixtures/aform/`).
 *
 * A pure leaf. `undefined` from a formatter means the arguments are ones pdf.js
 * would throw on; the caller treats the call as unrecognised.
 */

/** util.printf's separator styles 0-4: [thousands, decimal]. */
const SEPARATORS: readonly (readonly [string, string])[] = [
  [',', '.'], ['', '.'], ['.', ','], ['', ','], ["'", '.'],
];

const clampSep = (s: number): number => Math.min(Math.max(Math.floor(s), 0), 4);

/** AFMakeNumber: trim, the FIRST comma becomes a dot, parseFloat; non-finite is null. */
export function makeNumber(v: string | number): number | null {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const n = parseFloat(v.trim().replace(',', '.'));
  return Number.isNaN(n) || !Number.isFinite(n) ? null : n;
}

/** util.printf's `%,<sep>.<dec>f`: the only conversion AForm formats numbers with. */
export function printfFixed(sep: number, dec: number, arg: number): string {
  const [thousandSep, decimalSep] = SEPARATORS[sep];
  let intPart = Math.trunc(arg);
  let decPart = Math.abs(arg - intPart).toFixed(dec);
  if (decPart.length > 2) {
    if (/^1\.0+$/.test(decPart)) {
      intPart += Math.sign(arg);
      decPart = `${decimalSep}${decPart.split('.')[1]}`;
    } else {
      decPart = `${decimalSep}${decPart.substring(2)}`;
    }
  } else {
    if (decPart === '1') intPart += Math.sign(arg);
    decPart = '';
  }
  let sign = '';
  if (intPart < 0) { sign = '-'; intPart = -intPart; }
  let ip: string;
  if (thousandSep && intPart >= 1000) {
    const buf: string[] = [];
    for (;;) {
      buf.push((intPart % 1000).toString().padStart(3, '0'));
      intPart = Math.trunc(intPart / 1000);
      if (intPart < 1000) { buf.push(intPart.toString()); break; }
    }
    ip = buf.reverse().join(thousandSep);
  } else {
    ip = intPart.toString();
  }
  return `${sign}${ip}${decPart}`;
}

/** AFNumber_Format. Negative styles 1 and 3 turn the text red in a viewer; that
 *  colour is not applied here (a stated divergence), the parentheses are. */
export function numberFormat(
  value: string, nDec: number, sepStyle: number, negStyle: number,
  _currStyle: number, strCurrency: string, prepend: boolean,
): string | undefined {
  // pdf.js splices strCurrency into a printf FORMAT string, so a '%' there is
  // read as a conversion; and toFixed throws outside 0..100.
  if (!Number.isInteger(nDec) || nDec < 0 || nDec > 100 || strCurrency.includes('%')) return undefined;
  let v = makeNumber(value);
  if (v === null) return '';
  const sign = Math.sign(v);
  let out = '';
  if (sign === -1 && prepend && negStyle === 0) out += '-';
  const paren = (negStyle === 2 || negStyle === 3) && sign === -1;
  if (paren) out += '(';
  if (prepend) out += strCurrency;
  if ((negStyle !== 0 || prepend) && sign === -1) v = -v;
  out += printfFixed(clampSep(sepStyle), nDec, v);
  if (!prepend) out += strCurrency;
  if (paren) out += ')';
  return out;
}

/** AFNumber_Keystroke (and AFPercent_Keystroke) at commit time. */
export function numberKeystroke(value: string, sepStyle: number): boolean {
  if (!value) return true;
  const v = value.trim();
  const re = sepStyle > 1 ? /^[+-]?(\d+(,\d*)?|,\d+)$/ : /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
  return re.test(v);
}

/** AFPercent_Format. */
export function percentFormat(value: string, nDec: number, sepStyle: number, prepend = false): string | undefined {
  if (nDec < 0) return undefined;
  if (nDec > 512) return '%';
  const dec = Math.floor(nDec);
  if (dec > 100) return undefined;
  const v = makeNumber(value);
  if (v === null) return '%';
  const s = printfFixed(clampSep(sepStyle), dec, v * 100);
  return prepend ? `%${s}` : `${s}%`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/afnumber.test.ts`
Expected: PASS. If a golden case fails, compare line by line with pdf.js's `AFNumber_Format`/`printf`; the goldens are the authority. Never edit a golden to match.

- [ ] **Step 5: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/afnumber.ts`:
1. `replace(',', '.')` → `replaceAll(',', '.')`: the `makeNumber` edge case fails.
2. In `printfFixed`, drop the `/^1\.0+$/` carry branch: golden cases like `999.9999` at nDec 2 fail.
3. `SEPARATORS[2]` → `['.', '.']`: golden cases fail.

- [ ] **Step 6: Commit**

```bash
git add src/afnumber.ts test/afnumber.test.ts
git commit -m "feat(jzn8): AForm number and percent semantics from pdf.js" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Date and time semantics, `afdate.ts`

**Files:**
- Create: `src/afdate.ts`
- Test: `test/afdate.test.ts`

**Interfaces:**
- Produces: `DATE_FORMATS: readonly string[]` (14 entries); `TIME_FORMATS: readonly string[]` (4 entries); `interface DateParts { year; month; day; hours; minutes; seconds; dayOfWeek }` (all numbers, month 0-based); `printd(fmt: string, d: DateParts): string`; `scandStrict(fmt: string, value: string): DateParts | null`; `dateFormat(value: string, fmt: string): string`; `dateKeystroke(value: string, fmt: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// test/afdate.test.ts
import { describe, it, expect } from 'vitest';
import { DATE_FORMATS, TIME_FORMATS, dateFormat, dateKeystroke, scandStrict } from '../src/afdate.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

const fmtOf = (fn: string, a0: number | string): string | undefined =>
  fn.startsWith('AFTime') && typeof a0 === 'number' ? TIME_FORMATS[a0]
    : typeof a0 === 'number' ? DATE_FORMATS[a0] : a0;

describe('afdate against pdf.js', () => {
  it('the tables are pdf.js\'s, by size', () => {
    expect(DATE_FORMATS).toHaveLength(14);
    expect(TIME_FORMATS).toHaveLength(4);
  });

  it('formats every strictly matching golden case exactly as pdf.js', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; strict: boolean; out?: string }>('date-format');
    expect(cases.length).toBe(goldenMeta.counts['date-format']);
    const bad = cases.filter((c) => c.strict && dateFormat(c.value, fmtOf(c.fn, c.args[0])!) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('leaves every non-matching value unformatted (the stated divergence), and counts them', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; strict: boolean }>('date-format');
    const loose = cases.filter((c) => !c.strict);
    expect(loose.length).toBe(goldenMeta.strictFalse['date-format']);
    expect(loose.length).toBeGreaterThan(0);
    const bad = loose.filter((c) => dateFormat(c.value, fmtOf(c.fn, c.args[0])!) !== c.value);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('keystroke checks agree with pdf.js where it matched strictly, and reject the rest', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; strict: boolean; rc?: boolean }>('date-keystroke');
    expect(cases.length).toBe(goldenMeta.counts['date-keystroke']);
    expect(cases.filter((c) => !c.strict).length).toBe(goldenMeta.strictFalse['date-keystroke']);
    const bad = cases.filter((c) => {
      const fmt = fmtOf(c.fn, c.args[0]);
      if (fmt === undefined) return c.rc !== true;            // out-of-range index: pdf.js does nothing
      const ours = dateKeystroke(c.value, fmt);
      return c.strict ? ours !== c.rc : ours !== false;
    });
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('afdate never reads the machine time zone', () => {
  it('parses to fixed fields', () => {
    expect(scandStrict('yyyy-mm-dd HH:MM', '2024-02-29 13:05')).toEqual(
      { year: 2024, month: 1, day: 29, hours: 13, minutes: 5, seconds: 0, dayOfWeek: 4 });
  });

  it('normalises an overflowing day the way pdf.js\'s Date does', () => {
    expect(dateFormat('02/30/2024', 'mm/dd/yyyy')).toBe('03/01/2024');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/afdate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/afdate.ts
/**
 * AForm date and time semantics (jzn8): util.printd and the STRICT half of
 * util._scand, transcribed from pdf.js `src/scripting_api/util.js` and
 * `src/shared/scripting_utils.js`, commit
 * d52fdf411a6e4d338180687456e0df019e28475e (Apache-2.0).
 *
 * **Stated divergence:** only strict matching. pdf.js falls back to
 * `#tryToGuessDate`, whose year defaults to the CURRENT year, and then to
 * `Date.parse`, which depends on the engine and the time zone. A value that
 * does not match its picture is left unformatted and rejected by the keystroke
 * check. Nothing here reads the machine's time zone: dates are fields,
 * normalised through `Date.UTC`, which is exactly pdf.js's local-time `Date`
 * under TZ=UTC (the goldens are generated under TZ=UTC), including its mapping
 * of years 0-99 onto the 1900s.
 */

export const DATE_FORMATS: readonly string[] = [
  'm/d', 'm/d/yy', 'mm/dd/yy', 'mm/yy', 'd-mmm', 'd-mmm-yy', 'dd-mmm-yy', 'yy-mm-dd',
  'mmm-yy', 'mmmm-yy', 'mmm d, yyyy', 'mmmm d, yyyy', 'm/d/yy h:MM tt', 'm/d/yy HH:MM',
];
export const TIME_FORMATS: readonly string[] = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt'];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DateParts {
  year: number; month: number; day: number;
  hours: number; minutes: number; seconds: number; dayOfWeek: number;
}

function normalize(y: number, mo: number, d: number, h: number, mi: number, s: number): DateParts {
  const t = new Date(Date.UTC(y, mo, d, h, mi, s));
  return {
    year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate(),
    hours: t.getUTCHours(), minutes: t.getUTCMinutes(), seconds: t.getUTCSeconds(),
    dayOfWeek: t.getUTCDay(),
  };
}

const PRINT = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t|\\.)/g;
const PRINTERS: Record<string, (d: DateParts) => string> = {
  mmmm: (d) => MONTHS[d.month],
  mmm: (d) => MONTHS[d.month].substring(0, 3),
  mm: (d) => (d.month + 1).toString().padStart(2, '0'),
  m: (d) => (d.month + 1).toString(),
  dddd: (d) => DAYS[d.dayOfWeek],
  ddd: (d) => DAYS[d.dayOfWeek].substring(0, 3),
  dd: (d) => d.day.toString().padStart(2, '0'),
  d: (d) => d.day.toString(),
  yyyy: (d) => d.year.toString().padStart(4, '0'),
  yy: (d) => (d.year % 100).toString().padStart(2, '0'),
  HH: (d) => d.hours.toString().padStart(2, '0'),
  H: (d) => d.hours.toString(),
  hh: (d) => (1 + ((d.hours + 11) % 12)).toString().padStart(2, '0'),
  h: (d) => (1 + ((d.hours + 11) % 12)).toString(),
  MM: (d) => d.minutes.toString().padStart(2, '0'),
  M: (d) => d.minutes.toString(),
  ss: (d) => d.seconds.toString().padStart(2, '0'),
  s: (d) => d.seconds.toString(),
  tt: (d) => (d.hours < 12 ? 'am' : 'pm'),
  t: (d) => (d.hours < 12 ? 'a' : 'p'),
};

/** util.printd with a picture string. `\x` prints `x` literally. */
export function printd(fmt: string, d: DateParts): string {
  return fmt.replace(PRINT, (tok: string) =>
    (Object.hasOwn(PRINTERS, tok) ? PRINTERS[tok](d) : tok.charAt(1)));
}

interface Scanned {
  year: number; month: number; day: number;
  hours: number; minutes: number; seconds: number; am: boolean | null;
}
type Scanner = { pattern: string; action: (v: string, d: Scanned) => void };
const int = (v: string): number => parseInt(v, 10);
const SCAN = /(mmmm|mmm|mm|m|dddd|ddd|dd|d|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t)/g;
const SCANNERS: Record<string, Scanner> = {
  mmmm: { pattern: `(${MONTHS.join('|')})`, action: (v, d) => { d.month = MONTHS.indexOf(v); } },
  mmm: {
    pattern: `(${MONTHS.map((m) => m.substring(0, 3)).join('|')})`,
    action: (v, d) => { d.month = MONTHS.findIndex((m) => m.substring(0, 3) === v); },
  },
  mm: { pattern: '(\\d{2})', action: (v, d) => { d.month = int(v) - 1; } },
  m: { pattern: '(\\d{1,2})', action: (v, d) => { d.month = int(v) - 1; } },
  // pdf.js assigns the WEEKDAY index to `day` here; transcribed as found.
  dddd: { pattern: `(${DAYS.join('|')})`, action: (v, d) => { d.day = DAYS.indexOf(v); } },
  ddd: {
    pattern: `(${DAYS.map((x) => x.substring(0, 3)).join('|')})`,
    action: (v, d) => { d.day = DAYS.findIndex((x) => x.substring(0, 3) === v); },
  },
  dd: { pattern: '(\\d{2})', action: (v, d) => { d.day = int(v); } },
  d: { pattern: '(\\d{1,2})', action: (v, d) => { d.day = int(v); } },
  yyyy: { pattern: '(\\d{4})', action: (v, d) => { d.year = int(v); } },
  yy: { pattern: '(\\d{2})', action: (v, d) => { d.year = 2000 + int(v); } },
  HH: { pattern: '(\\d{2})', action: (v, d) => { d.hours = int(v); } },
  H: { pattern: '(\\d{1,2})', action: (v, d) => { d.hours = int(v); } },
  hh: { pattern: '(\\d{2})', action: (v, d) => { d.hours = int(v); } },
  h: { pattern: '(\\d{1,2})', action: (v, d) => { d.hours = int(v); } },
  MM: { pattern: '(\\d{2})', action: (v, d) => { d.minutes = int(v); } },
  M: { pattern: '(\\d{1,2})', action: (v, d) => { d.minutes = int(v); } },
  ss: { pattern: '(\\d{2})', action: (v, d) => { d.seconds = int(v); } },
  s: { pattern: '(\\d{1,2})', action: (v, d) => { d.seconds = int(v); } },
  tt: { pattern: '([aApP][mM])', action: (v, d) => { const c = v.charAt(0); d.am = c === 'a' || c === 'A'; } },
  t: { pattern: '([aApP])', action: (v, d) => { d.am = v === 'a' || v === 'A'; } },
};

/** The strict half of util._scand: the whole value must match the picture. */
export function scandStrict(fmt: string, value: string): DateParts | null {
  const actions: Scanner['action'][] = [];
  const escaped = fmt.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');
  const re = escaped.replace(SCAN, (tok: string) => {
    const h = SCANNERS[tok];
    actions.push(h.action);
    return h.pattern;
  });
  const m = new RegExp(`^${re}$`).exec(value);
  if (m === null || m.length !== actions.length + 1) return null;
  const d: Scanned = { year: 2000, month: 0, day: 1, hours: 0, minutes: 0, seconds: 0, am: null };
  actions.forEach((a, i) => a(m[i + 1], d));
  if (d.am !== null) d.hours = (d.hours % 12) + (d.am ? 0 : 12);
  return normalize(d.year, d.month, d.day, d.hours, d.minutes, d.seconds);
}

/** AFDate_FormatEx / AFTime_FormatEx. An empty or non-matching value is left as is. */
export function dateFormat(value: string, fmt: string): string {
  if (!value) return value;
  const p = scandStrict(fmt, value);
  return p === null ? value : printd(fmt, p);
}

/** AFDate_KeystrokeEx / AFTime_KeystrokeEx at commit time. */
export function dateKeystroke(value: string, fmt: string): boolean {
  if (!value) return true;
  return scandStrict(fmt, value) !== null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/afdate.test.ts`
Expected: PASS. Also run it once with `TZ=America/New_York npx vitest run test/afdate.test.ts` and expect PASS: the module must not depend on the machine's zone.

- [ ] **Step 5: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/afdate.ts`:
1. In `normalize`, keep `Date.UTC` but read the LOCAL getters (`getHours`, `getDate`, …). Expect the `TZ=America/New_York` run to go red. (Local construction with local getters would NOT: it is self-consistent in any zone, so it proves nothing.)
2. `yy` action: `2000 + int(v)` → `1900 + int(v)`. Goldens fail.
3. `dateFormat`: return `''` instead of `value` on a mismatch. The divergence case fails.

- [ ] **Step 6: Commit**

```bash
git add src/afdate.ts test/afdate.test.ts
git commit -m "feat(jzn8): AForm date and time semantics, strict matching only" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Special-format semantics, `afspecial.ts`

**Files:**
- Create: `src/afspecial.ts`
- Test: `test/afspecial.test.ts`

**Interfaces:**
- Produces: `printx(mask: string, source: string): string`; `specialFormat(value: string, psf: number): string | undefined`; `specialKeystroke(value: string, psf: number): boolean | undefined`; `specialKeystrokeEx(value: string, mask: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// test/afspecial.test.ts
import { describe, it, expect } from 'vitest';
import { specialFormat, specialKeystroke, specialKeystrokeEx, printx } from '../src/afspecial.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

describe('afspecial against pdf.js', () => {
  it('AFSpecial_Format matches every golden case', () => {
    const cases = loadGolden<{ psf: number; value: string; out: string }>('special-format');
    expect(cases.length).toBe(goldenMeta.counts['special-format']);
    const bad = cases.filter((c) => specialFormat(c.value, c.psf) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('the special keystroke checks match every golden case', () => {
    const cases = loadGolden<{ fn: string; args: [number | string]; value: string; rc: boolean }>('special-keystroke');
    expect(cases.length).toBe(goldenMeta.counts['special-keystroke']);
    const bad = cases.filter((c) => (c.fn === 'AFSpecial_Keystroke'
      ? specialKeystroke(c.value, c.args[0] as number)
      : specialKeystrokeEx(c.value, c.args[0] as string)) !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('afspecial edges', () => {
  it('printx honours case shifts and escapes', () => {
    expect(printx('>AAA<AAA', 'abcDEF')).toBe('ABCdef');
    expect(printx('\\9-999', '123')).toBe('9-123');
  });

  it('an unknown psf with a value is unrecognised; with no value it is a no-op', () => {
    expect(specialFormat('123', 4)).toBeUndefined();
    expect(specialFormat('', 4)).toBe('');
    expect(specialKeystroke('123', 4)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/afspecial.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/afspecial.ts
/**
 * AForm special formats (jzn8): zip, zip+4, phone and SSN, and the masked
 * keystroke checks. Transcribed from pdf.js `aform.js` (AFSpecial_*) and
 * `util.js` (printx), commit d52fdf411a6e4d338180687456e0df019e28475e
 * (Apache-2.0). Keystroke checks are commit-time only; pdf.js's commit path
 * also pads the value with the rest of the mask, which is a rewrite, and this
 * module only accepts or rejects.
 */

const upper = (x: string): string => x.toUpperCase();
const lower = (x: string): string => x.toLowerCase();
const same = (x: string): string => x;
const isAlpha = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** util.printx. */
export function printx(mask: string, source: string): string {
  const src = source ?? '';
  const buf: string[] = [];
  let i = 0;
  let currCase = same;
  let escaped = false;
  for (const command of mask) {
    if (escaped) { buf.push(command); escaped = false; continue; }
    if (i >= src.length) break;
    switch (command) {
      case '?': buf.push(currCase(src.charAt(i++))); break;
      case 'X':
        while (i < src.length) { const c = src.charAt(i++); if (isAlpha(c) || isDigit(c)) { buf.push(currCase(c)); break; } }
        break;
      case 'A':
        while (i < src.length) { const c = src.charAt(i++); if (isAlpha(c)) { buf.push(currCase(c)); break; } }
        break;
      case '9':
        while (i < src.length) { const c = src.charAt(i++); if (isDigit(c)) { buf.push(c); break; } }
        break;
      case '*': while (i < src.length) buf.push(currCase(src.charAt(i++))); break;
      case '\\': escaped = true; break;
      case '>': currCase = upper; break;
      case '<': currCase = lower; break;
      case '=': currCase = same; break;
      default: buf.push(command);
    }
  }
  return buf.join('');
}

/** AFSpecial_Format. */
export function specialFormat(value: string, psf: number): string | undefined {
  if (!value) return value;
  let fmt: string;
  switch (psf) {
    case 0: fmt = '99999'; break;
    case 1: fmt = '99999-9999'; break;
    case 2: fmt = printx('9999999999', value).length >= 10 ? '(999) 999-9999' : '999-9999'; break;
    case 3: fmt = '999-99-9999'; break;
    default: return undefined;
  }
  return printx(fmt, value);
}

const CHECKERS: Record<string, (c: string) => boolean> = {
  9: isDigit,
  A: isAlpha,
  O: (c) => isAlpha(c) || isDigit(c),
  X: () => true,
};

function valid(value: string, mask: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const m = mask.charAt(i);
    const c = value.charAt(i);
    if (Object.hasOwn(CHECKERS, m)) { if (!CHECKERS[m](c)) return false; } else if (m !== c) return false;
  }
  return true;
}

/** #AFSpecial_KeystrokeEx_helper at commit time. */
function commit(mask: string, value: string): boolean {
  if (!mask || !value) return true;
  if (value.length !== mask.length) return false;
  return valid(value, mask);
}

/** AFSpecial_KeystrokeEx at commit time. */
export function specialKeystrokeEx(value: string, mask: string): boolean {
  if (commit(mask.replace(/[^9AOX]/g, ''), value)) return true;
  return commit(mask, value);
}

/** AFSpecial_Keystroke at commit time; undefined for an unknown psf. */
export function specialKeystroke(value: string, psf: number): boolean | undefined {
  let first: string;
  let second: string | undefined;
  switch (psf) {
    case 0: first = '99999'; break;
    case 1: first = '99999-9999'; break;
    case 2: first = '999-9999'; second = '(999) 999-9999'; break;
    case 3: first = '999-99-9999'; break;
    default: return undefined;
  }
  const formats = second !== undefined ? [first, second] : [first];
  for (const f of formats) if (commit(f, value)) return true;
  const re = /[-()\s]+/g;
  const stripped = value.replace(re, '');
  // pdf.js's helper falls back to the EVENT value when handed an empty string.
  for (const f of formats) if (commit(f.replace(re, ''), stripped || value)) return true;
  const digits = (second !== undefined && stripped.match(/\d/g)) || [];
  return specialKeystrokeEx(value, digits.length > 7 && second !== undefined ? second : first);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/afspecial.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/afspecial.ts`:
1. `stripped || value` → `stripped`. Golden keystroke cases fail.
2. In `specialFormat` case 2, `>= 10` → `> 10`. Golden format cases fail.

- [ ] **Step 6: Commit**

```bash
git add src/afspecial.ts test/afspecial.test.ts
git commit -m "feat(jzn8): AForm special formats and masked keystroke checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Calculation and range semantics, `afcalc.ts`

**Files:**
- Create: `src/afcalc.ts`
- Test: `test/afcalc.test.ts`

**Interfaces:**
- Consumes: `makeNumber` (Task 3).
- Produces: `exactSum(xs: readonly number[]): number`; `simpleCalculate(op: string, values: readonly string[]): number | undefined` (undefined for an unknown op); `rangeValidate(value: string, bGreater: boolean, nGreater: number, bLess: boolean, nLess: number): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// test/afcalc.test.ts
import { describe, it, expect } from 'vitest';
import { exactSum, simpleCalculate, rangeValidate } from '../src/afcalc.js';
import { loadGolden, goldenMeta } from './helpers/aform-goldens.js';

describe('afcalc against pdf.js', () => {
  it('AFSimple_Calculate matches every golden case, as the string a field stores', () => {
    const cases = loadGolden<{ op: string; values: string[]; out: number }>('simple-calculate');
    expect(cases.length).toBe(goldenMeta.counts['simple-calculate']);
    const bad = cases.filter((c) => String(simpleCalculate(c.op, c.values)) !== String(c.out));
    expect(bad).toEqual([]);
  });

  it('AFRange_Validate matches every golden case', () => {
    const cases = loadGolden<{ args: [boolean, number, boolean, number]; value: string; rc: boolean }>('range-validate');
    expect(cases.length).toBe(goldenMeta.counts['range-validate']);
    const bad = cases.filter((c) => rangeValidate(c.value, ...c.args) !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('exactSum', () => {
  it('is exactly rounded where naive addition is not', () => {
    expect(exactSum([1e16, 1, -1e16])).toBe(1);
    expect(exactSum([0.1, 0.2, 0.3])).toBe(0.6);
    expect(exactSum([])).toBe(0);
  });
});

it('an unknown operation is unrecognised', () => {
  expect(simpleCalculate('MEDIAN', ['1'])).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/afcalc.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/afcalc.ts
/**
 * AFSimple_Calculate and AFRange_Validate (jzn8), transcribed from pdf.js
 * `aform.js`, commit d52fdf411a6e4d338180687456e0df019e28475e (Apache-2.0).
 *
 * pdf.js sums with `Math.sumPrecise`, which is exactly rounded and absent from
 * Node 24. `exactSum` is Shewchuk's summation (Python's `math.fsum`): exactly
 * rounded by a DIFFERENT algorithm from the golden generator's BigInt one, so
 * the two cannot share a rounding bug.
 */
import { makeNumber } from './afnumber.js';

/** Exactly rounded sum (Shewchuk). Inputs are finite. */
export function exactSum(xs: readonly number[]): number {
  const partials: number[] = [];
  for (let x of xs) {
    let i = 0;
    for (let y of partials) {
      if (Math.abs(x) < Math.abs(y)) [x, y] = [y, x];
      const hi = x + y;
      const lo = y - (hi - x);
      if (lo !== 0) partials[i++] = lo;
      x = hi;
    }
    partials.length = i;
    partials.push(x);
  }
  let n = partials.length;
  if (n === 0) return 0;
  let hi = partials[--n];
  let lo = 0;
  while (n > 0) {
    const x = hi;
    const y = partials[--n];
    hi = x + y;
    const yr = hi - x;
    lo = y - yr;
    if (lo !== 0) break;
  }
  if (n > 0 && ((lo < 0 && partials[n - 1] < 0) || (lo > 0 && partials[n - 1] > 0))) {
    const y = lo * 2;
    const x = hi + y;
    const yr = x - hi;
    if (y === yr) hi = x;
  }
  return hi;
}

/** AFSimple_Calculate's arithmetic over the operand values. Unparseable counts
 *  as 0; no operands is 0; the result is rounded to 6 decimals. */
export function simpleCalculate(op: string, values: readonly string[]): number | undefined {
  if (op !== 'SUM' && op !== 'AVG' && op !== 'PRD' && op !== 'MIN' && op !== 'MAX') return undefined;
  if (values.length === 0) return 0;
  const nums = values.map((v) => makeNumber(v) ?? 0);
  let res: number;
  switch (op) {
    case 'AVG': res = exactSum(nums) / nums.length; break;
    case 'SUM': res = exactSum(nums); break;
    case 'PRD': res = nums.reduce((acc, v) => acc * v, 1); break;
    case 'MIN': res = Math.min(...nums); break;
    default: res = Math.max(...nums);
  }
  return Math.round(1e6 * res) / 1e6;
}

/** AFRange_Validate. Note pdf.js's final branch compares against nLess even
 *  when bLess is false; transcribed as found. */
export function rangeValidate(value: string, bGreater: boolean, nGreater: number, bLess: boolean, nLess: number): boolean {
  if (!value) return true;
  const v = makeNumber(value);
  if (v === null) return true;
  if (bGreater && bLess) return !(v < nGreater || v > nLess);
  if (bGreater) return !(v < nGreater);
  return !(v > nLess);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/afcalc.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/afcalc.ts`:
1. `exactSum`: return `xs.reduce((a, b) => a + b, 0)`. The `[1e16, 1, -1e16]` golden and unit case fail.
2. Drop `Math.round(1e6 * res) / 1e6`. The `123456.1234567` golden fails.

- [ ] **Step 6: Commit**

```bash
git add src/afcalc.ts test/afcalc.test.ts
git commit -m "feat(jzn8): AFSimple_Calculate with an exact sum, and AFRange_Validate" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The dispatch module, `afrules.ts`

**Files:**
- Create: `src/afrules.ts`
- Test: `test/afrules.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 4, 5 and 6; the `FieldActions` type from `./actions.js`.
- Produces:
  - `formatValue(script: string, value: string): string | undefined`
  - `checkValue(trigger: 'keystroke' | 'validate', script: string, value: string): { ok: boolean; rule: AfName } | undefined`
  - `evaluateRules(field: string, actions: FieldActions, value: string): ValueCheckReport`
  - `interface UnrecognisedScript { readonly field: string; readonly trigger: 'keystroke' | 'validate' | 'calculate'; readonly script: string }`
  - `interface ValueRejection { readonly field: string; readonly trigger: 'keystroke' | 'validate'; readonly rule: AfName; readonly value: string; readonly message: string }`
  - `interface ValueCheckReport { readonly rejected: readonly ValueRejection[]; readonly unrecognised: readonly UnrecognisedScript[] }`
  - `interface RecalculatedValue { readonly field: string; readonly from: string; readonly to: string }`
  - `interface RecalculateReport { readonly changed: readonly RecalculatedValue[]; readonly unrecognised: readonly UnrecognisedScript[]; readonly notInOrder: readonly string[] }`

- [ ] **Step 1: Write the failing test**

```ts
// test/afrules.test.ts
import { describe, it, expect } from 'vitest';
import { formatValue, checkValue, evaluateRules } from '../src/afrules.js';
import { loadGolden } from './helpers/aform-goldens.js';

const lit = (a: unknown): string => JSON.stringify(a);
const scriptOf = (fn: string, args: readonly unknown[]): string => `${fn}(${args.map(lit).join(', ')});`;

describe('the goldens hold through the real recognition path', () => {
  it('AFNumber_Format scripts', () => {
    const cases = loadGolden<{ args: unknown[]; value: string; out: string }>('number-format');
    const bad = cases.filter((c) => formatValue(scriptOf('AFNumber_Format', c.args), c.value) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('strict date scripts, index and picture forms', () => {
    const cases = loadGolden<{ fn: string; args: unknown[]; value: string; strict: boolean; out?: string }>('date-format');
    const bad = cases.filter((c) => c.strict && formatValue(scriptOf(c.fn, c.args), c.value) !== c.out);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it('range validate scripts', () => {
    const cases = loadGolden<{ args: unknown[]; value: string; rc: boolean }>('range-validate');
    const bad = cases.filter((c) => checkValue('validate', scriptOf('AFRange_Validate', c.args), c.value)?.ok !== c.rc);
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe('slots', () => {
  it('a keystroke function in the format slot is not a format', () => {
    expect(formatValue('AFNumber_Keystroke(2,0,0,0,"",true)', '1')).toBeUndefined();
  });

  it('a validate function in the keystroke slot is not a keystroke check', () => {
    expect(checkValue('keystroke', 'AFRange_Validate(true,0,true,1)', '5')).toBeUndefined();
  });

  it('an out-of-range date index is not a format, and is a no-op keystroke check', () => {
    expect(formatValue('AFDate_Format(99)', '03/04/24')).toBeUndefined();
    expect(checkValue('keystroke', 'AFDate_Keystroke(99)', 'garbage')).toEqual({ ok: true, rule: 'AFDate_Keystroke' });
  });
});

describe('evaluateRules', () => {
  const actions = {
    keystroke: { type: 'javascript' as const, script: 'AFNumber_Keystroke(2, 0, 0, 0, "", true);' },
    validate: { type: 'javascript' as const, script: 'AFRange_Validate(true, 0, true, 100);' },
  };

  it('rejects by each trigger that rejects', () => {
    expect(evaluateRules('amt', actions, '150').rejected).toEqual([
      { field: 'amt', trigger: 'validate', rule: 'AFRange_Validate', value: '150', message: 'AFRange_Validate rejected "150"' },
    ]);
    expect(evaluateRules('amt', actions, 'abc').rejected.map((r) => r.trigger)).toEqual(['keystroke']);
  });

  it('passes an empty value', () => {
    expect(evaluateRules('amt', actions, '')).toEqual({ rejected: [], unrecognised: [] });
  });

  it('reports a custom script as unrecognised, never as a pass or a rejection', () => {
    const custom = { validate: { type: 'javascript' as const, script: 'if (event.value > 3) event.rc = false;' } };
    expect(evaluateRules('amt', custom, '9')).toEqual({
      rejected: [],
      unrecognised: [{ field: 'amt', trigger: 'validate', script: custom.validate.script }],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/afrules.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/afrules.ts
/**
 * Which native AForm semantics a field script names (jzn8). A pure dispatch
 * over `afcall.ts`'s recognition: a script is either one recognised call in the
 * right slot, handed to its semantics module, or `undefined`. Nothing is
 * executed. The public report types for Recalculate and CheckValues live here
 * too, so `afform.ts` and `formfield.ts` share one vocabulary.
 */
import { parseAfCall, type AfName } from './afcall.js';
import { numberFormat, numberKeystroke, percentFormat } from './afnumber.js';
import { DATE_FORMATS, TIME_FORMATS, dateFormat, dateKeystroke } from './afdate.js';
import { specialFormat, specialKeystroke, specialKeystrokeEx } from './afspecial.js';
import { rangeValidate } from './afcalc.js';
import type { FieldActions } from './actions.js';

/** A field script that is not one recognised AForm call in its slot. */
export interface UnrecognisedScript {
  readonly field: string;
  readonly trigger: 'keystroke' | 'validate' | 'calculate';
  readonly script: string;
}

/** A field value its own recognised keystroke or validate rule rejects. */
export interface ValueRejection {
  readonly field: string;
  readonly trigger: 'keystroke' | 'validate';
  readonly rule: AfName;
  readonly value: string;
  readonly message: string;
}

/** What `Form.CheckValues()` found. */
export interface ValueCheckReport {
  readonly rejected: readonly ValueRejection[];
  readonly unrecognised: readonly UnrecognisedScript[];
}

/** One value `Form.Recalculate()` changed. */
export interface RecalculatedValue { readonly field: string; readonly from: string; readonly to: string }

/** What `Form.Recalculate()` did. */
export interface RecalculateReport {
  readonly changed: readonly RecalculatedValue[];
  readonly unrecognised: readonly UnrecognisedScript[];
  /** Fields with a calculate script that /AcroForm /CO does not list. Acrobat
   *  never runs those, so neither does Recalculate. */
  readonly notInOrder: readonly string[];
}

const n = (a: unknown): number => a as number;
const s = (a: unknown): string => a as string;
const b = (a: unknown): boolean => a as boolean;

/** The value as the script's recognised format function would display it, or
 *  undefined when the script is not one recognised format call. */
export function formatValue(script: string, value: string): string | undefined {
  const c = parseAfCall(script);
  if (c === undefined) return undefined;
  const a = c.args;
  switch (c.name) {
    case 'AFNumber_Format': return numberFormat(value, n(a[0]), n(a[1]), n(a[2]), n(a[3]), s(a[4]), b(a[5]));
    case 'AFPercent_Format': return percentFormat(value, n(a[0]), n(a[1]), (a[2] as boolean | undefined) ?? false);
    case 'AFDate_FormatEx': case 'AFTime_FormatEx': return dateFormat(value, s(a[0]));
    case 'AFDate_Format': { const f = DATE_FORMATS[n(a[0])]; return f === undefined ? undefined : dateFormat(value, f); }
    case 'AFTime_Format': { const f = TIME_FORMATS[n(a[0])]; return f === undefined ? undefined : dateFormat(value, f); }
    case 'AFSpecial_Format': return specialFormat(value, n(a[0]));
    default: return undefined;
  }
}

/** Whether a commit-time keystroke rule or a validate rule accepts the value,
 *  or undefined when the script is not one recognised call for that slot. */
export function checkValue(
  trigger: 'keystroke' | 'validate', script: string, value: string,
): { ok: boolean; rule: AfName } | undefined {
  const c = parseAfCall(script);
  if (c === undefined) return undefined;
  const a = c.args;
  const res = (ok: boolean | undefined): { ok: boolean; rule: AfName } | undefined =>
    (ok === undefined ? undefined : { ok, rule: c.name });
  if (trigger === 'validate') return c.name === 'AFRange_Validate' ? res(rangeValidate(value, b(a[0]), n(a[1]), b(a[2]), n(a[3]))) : undefined;
  switch (c.name) {
    case 'AFNumber_Keystroke': case 'AFPercent_Keystroke': return res(numberKeystroke(value, n(a[1])));
    case 'AFDate_KeystrokeEx': case 'AFTime_KeystrokeEx': return res(dateKeystroke(value, s(a[0])));
    case 'AFDate_Keystroke': { const f = DATE_FORMATS[n(a[0])]; return res(f === undefined ? true : dateKeystroke(value, f)); }
    case 'AFTime_Keystroke': { const f = TIME_FORMATS[n(a[0])]; return res(f === undefined ? true : dateKeystroke(value, f)); }
    case 'AFSpecial_Keystroke': return res(specialKeystroke(value, n(a[0])));
    case 'AFSpecial_KeystrokeEx': return res(specialKeystrokeEx(value, s(a[0])));
    default: return undefined;
  }
}

/** Check a value against a field's keystroke and validate scripts. Actions
 *  that are not JavaScript have nothing to evaluate and are skipped. */
export function evaluateRules(field: string, actions: FieldActions, value: string): ValueCheckReport {
  const rejected: ValueRejection[] = [];
  const unrecognised: UnrecognisedScript[] = [];
  for (const trigger of ['keystroke', 'validate'] as const) {
    const act = actions[trigger];
    if (act === undefined || act.type !== 'javascript') continue;
    const r = checkValue(trigger, act.script, value);
    if (r === undefined) { unrecognised.push({ field, trigger, script: act.script }); continue; }
    if (!r.ok) rejected.push({ field, trigger, rule: r.rule, value, message: `${r.rule} rejected "${value}"` });
  }
  return { rejected, unrecognised };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/afrules.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/afrules.ts`:
1. Let `checkValue('validate', …)` fall through to the keystroke switch. The slot case fails.
2. Drop the `f === undefined` guard in `AFDate_Format`. The out-of-range index case fails (it throws).

- [ ] **Step 6: Commit**

```bash
git add src/afrules.ts test/afrules.test.ts
git commit -m "feat(jzn8): dispatch recognised AForm calls by slot" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Formatted values and opt-in formatted appearances

**Files:**
- Modify: `src/formfield.ts` (the `Flatten()` and `GenerateAppearance()` methods near lines 217-226, plus a new getter and an exported options type)
- Modify: `src/form.ts` (the `GenerateAppearances()` method near line 197)
- Modify: `src/flatten.ts` (`flattenForm`, near line 175)
- Modify: `src/document.ts` (`FlattenForm()`, near line 3826)
- Test: `test/aform-appearance.test.ts`

**Interfaces:**
- Consumes: `formatValue` (Task 7); `encodePdfText` from `./metadata.js`.
- Produces: `interface FieldAppearanceOptions { format?: boolean }` exported from `formfield.ts`; `Field.FormattedValue: string | undefined`; `Field.GenerateAppearance(opts?)`; `Field.Flatten(opts?)`; `Form.GenerateAppearances(opts?)`; `Document.FlattenForm(opts?)`; `flattenForm(doc, opts?)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/aform-appearance.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

const FMT = { format: { type: 'javascript' as const, script: 'AFNumber_Format(2, 0, 0, 0, "$", true);' } };

function formDoc(opts: { password?: boolean; actions?: typeof FMT } = { actions: FMT }): Uint8Array {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'amt', value: '1234.5', ...opts });
  return doc.Save();
}

describe('FormattedValue', () => {
  it('is the value as the recognised format script displays it', () => {
    expect(Document.Open(formDoc()).Form.Get('amt')!.FormattedValue).toBe('$1,234.50');
  });

  it('is undefined with no format script, and never changes /V', () => {
    expect(Document.Open(formDoc({})).Form.Get('amt')!.FormattedValue).toBeUndefined();
    const f = Document.Open(formDoc()).Form.Get('amt')!;
    void f.FormattedValue;
    expect(f.Value).toBe('1234.5');
  });
});

describe('format: true is opt-in', () => {
  it('draws the formatted value only when asked', () => {
    const on = Document.Open(formDoc());
    on.FlattenForm({ format: true });
    expect(on.Pages[0].GetText()).toContain('$1,234.50');
    const off = Document.Open(formDoc());
    off.FlattenForm();
    expect(off.Pages[0].GetText()).toContain('1234.5');
    expect(off.Pages[0].GetText()).not.toContain('$');
  });

  it('leaves the default byte-identical, and format:false the same as the default', () => {
    const base = formDoc();
    const a = Document.Open(base); a.Form.GenerateAppearances();
    const b = Document.Open(base); b.Form.GenerateAppearances({ format: false });
    expect(b.Save()).toEqual(a.Save());
  });

  it('format:true on a field with no format script is the same as the default', () => {
    const base = formDoc({});
    const a = Document.Open(base); a.Form.GenerateAppearances();
    const b = Document.Open(base); b.Form.GenerateAppearances({ format: true });
    expect(b.Save()).toEqual(a.Save());
  });

  it('keeps a password field masked (Review Focus 4)', () => {
    const doc = Document.Open(formDoc({ password: true, actions: FMT }));
    doc.FlattenForm({ format: true });
    const text = doc.Pages[0].GetText();
    expect(text).not.toContain('1,234');
    expect(text).not.toContain('1234');
  });

  it('works per field through Flatten and GenerateAppearance', () => {
    const doc = Document.Open(formDoc());
    doc.Form.Get('amt')!.Flatten({ format: true });
    expect(doc.Pages[0].GetText()).toContain('$1,234.50');
  });

  it('refuses a non-boolean format', () => {
    const doc = Document.Open(formDoc());
    expect(() => doc.Form.GenerateAppearances({ format: 'yes' as unknown as boolean })).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/aform-appearance.test.ts`
Expected: FAIL (`FormattedValue` is undefined; `FlattenForm({ format: true })` draws the raw value).

- [ ] **Step 3: Implement in `formfield.ts`**

Add `encodePdfText` to the existing `./metadata.js` import (which already brings in `decodePdfText`), and add `import { formatValue } from './afrules.js';`. Then add the options type and its check near the top-level exports:

```ts
/** Options for regenerating field appearances (jzn8). */
export interface FieldAppearanceOptions {
  /** Draw the value as the field's recognised AForm format script displays it
   *  (`FormattedValue`). The stored /V is never changed. Default false. */
  format?: boolean;
}

/** @internal */
export function checkAppearanceOptions(opts: FieldAppearanceOptions): void {
  if (opts === null || typeof opts !== 'object') throw new TypeError('appearance options must be an object');
  if (opts.format !== undefined && typeof opts.format !== 'boolean') throw new TypeError('format must be a boolean');
}
```

Replace `Flatten()` and `GenerateAppearance()` in the `Field` class, and add the getter beside `Actions`:

```ts
  /** The value as this field's recognised AForm format script would display it
   *  (`AFNumber_Format`, `AFPercent_Format`, `AFDate_*`, `AFTime_*`,
   *  `AFSpecial_Format`), or undefined when there is none. Read-only; /V is
   *  unchanged. No JavaScript is executed: see README's scope. */
  get FormattedValue(): string | undefined {
    if (this.Type !== 'text') return undefined;
    const f = this.Actions.format;
    if (f === undefined || f.type !== 'javascript') return undefined;
    return formatValue(f.script, this.Value as string);
  }

  Flatten(opts: FieldAppearanceOptions = {}): number {
    this.GenerateAppearance(opts);   // a widget with no /AP has nothing to bake
    return flattenFieldWidgets(this.doc, this.Dict, this.Widgets);
  }

  /** Regenerate this field's appearance stream(s) from its current value, so the
   *  result renders without relying on a viewer honoring /NeedAppearances.
   *  `{ format: true }` draws `FormattedValue` where there is one. A password
   *  field stays masked either way: masking happens inside appearance
   *  generation, after this substitution. */
  GenerateAppearance(opts: FieldAppearanceOptions = {}): void {
    checkAppearanceOptions(opts);
    let value = this.rawValue();
    if (opts.format === true) {
      const fv = this.FormattedValue;
      if (fv !== undefined) value = { kind: 'string', bytes: encodePdfText(fv) };
    }
    generateFieldAppearance(this.doc, this.acroForm, this.Dict, this.Type, this.ff, value);
  }
```

Keep the existing doc comment on `Flatten` above the new signature. If `rawValue()`'s declared return type rejects the string object, annotate `let value: PdfObject = this.rawValue();` and import `PdfObject` as a type from `./types.js`.

- [ ] **Step 4: Implement in `form.ts`, `flatten.ts` and `document.ts`**

`form.ts`: import `{ checkAppearanceOptions, type FieldAppearanceOptions }` from `./formfield.js` (it already imports `Field` from there), and replace `GenerateAppearances`:

```ts
  /** Generate appearance streams for every field, then drop the AcroForm
   *  /NeedAppearances flag so the document renders identically everywhere.
   *  `{ format: true }` draws each field's `FormattedValue` where it has one. */
  GenerateAppearances(opts: FieldAppearanceOptions = {}): void {
    checkAppearanceOptions(opts);
    for (const f of this.Fields) f.GenerateAppearance(opts);
    const acro = this.doc.resolve(this.doc.catalog().get('AcroForm'));
    if (isDict(acro)) acro.delete('NeedAppearances');
    this.doc.markModified();
  }
```

`flatten.ts`: add `import type { FieldAppearanceOptions } from './formfield.js';`, change the signature to `export function flattenForm(doc: Document, opts: FieldAppearanceOptions = {}): number {`, and change its first line to `doc.Form.GenerateAppearances(opts);`.

`document.ts`: add `import type { FieldAppearanceOptions } from './formfield.js';` and change `FlattenForm`:

```ts
  FlattenForm(opts: FieldAppearanceOptions = {}): number {
    return flattenForm(this, opts);
  }
```

Add to its doc comment: "`{ format: true }` bakes each field's `FormattedValue` where it has one."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/aform-appearance.test.ts test/import-cycles.test.ts`
Expected: PASS. If `import-cycles` names a new pair, a value import closed a cycle; make it `import type`.

- [ ] **Step 6: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/formfield.ts`:
1. Drop `if (opts.format === true)`, so formatting always applies. The byte-identity and opt-in cases fail.
2. In `src/appearance.ts`, temporarily replace `maskIfPassword(textOf(value), ff)` with `textOf(value)`. Review Focus 4 must fail, which proves the case would see the formatted value leak. Revert with `git checkout src/appearance.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/formfield.ts src/form.ts src/flatten.ts src/document.ts test/aform-appearance.test.ts
git commit -m "feat(jzn8): FormattedValue and opt-in formatted appearances" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `Recalculate()` and `CheckValues()`

**Files:**
- Create: `src/afform.ts`
- Modify: `src/formfield.ts` (split the `Value` setter into the setter and `storeValue`)
- Modify: `src/form.ts` (add `Recalculate` and `CheckValues`)
- Test: `test/aform-recalc.test.ts`

**Interfaces:**
- Consumes: `parseAfCall` (Task 1), `simpleCalculate` (Task 6), `evaluateRules` and the report types (Task 7).
- Produces: `recalculate(doc: Document, fields: readonly Field[]): RecalculateReport`; `checkValues(fields: readonly Field[]): ValueCheckReport`; `Field.storeValue(v)` (`@internal`); `Form.Recalculate(): RecalculateReport`; `Form.CheckValues(): ValueCheckReport`.

- [ ] **Step 1: Write the failing test**

```ts
// test/aform-recalc.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfDict, PdfObject } from '../src/types.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildSigner } from './helpers/build-signer.js';

const calc = (script: string) => ({ calculate: { type: 'javascript' as const, script } });

/** Point /AcroForm /CO at the named fields, in order. */
function setCO(doc: Document, names: string[]): void {
  const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
  const refs: PdfObject[] = names.map((n) => {
    const dict = doc.Form.Get(n)!.Dict;
    // objectEntries() yields [PdfRef, PdfObject]: the key is already a reference.
    for (const [ref, obj] of doc.objectEntries()) if (obj === dict) return ref;
    throw new Error(`no object for ${n}`);
  });
  acro.set('CO', refs);
}

function build(fields: { name: string; value?: string; actions?: ReturnType<typeof calc> }[], co: string[]): Document {
  const doc = Document.Open(buildBlankPage());
  fields.forEach((f, i) => doc.Form.AddTextField({ page: 1, rect: [10, 10 + i * 40, 210, 40 + i * 40], ...f }));
  setCO(doc, co);
  return doc;
}

describe('Recalculate', () => {
  it('sums in /CO order with the script Acrobat writes', () => {
    const doc = build([
      { name: 'a', value: '1.5' }, { name: 'b', value: '2' },
      { name: 'total', actions: calc('AFSimple_Calculate("SUM", new Array ("a", "b"));') },
    ], ['total']);
    const r = doc.Form.Recalculate();
    expect(r.changed).toEqual([{ field: 'total', from: '', to: '3.5' }]);
    expect(doc.Form.Get('total')!.Value).toBe('3.5');
  });

  it('runs /CO once, in order: a field listed before its input uses the stale input', () => {
    const doc = build([
      { name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: 'sub', value: '0' },
      { name: 'total', actions: calc('AFSimple_Calculate("SUM", "sub")') },
    ], ['total', 'sub']);
    doc.Form.Get('sub')!.SetActions(calc('AFSimple_Calculate("SUM", "a, b")'));
    doc.Form.Recalculate();
    expect(doc.Form.Get('sub')!.Value).toBe('3');
    expect(doc.Form.Get('total')!.Value).toBe('0');
  });

  it('expands a group name and never matches a mere prefix (Review Focus 2)', () => {
    const doc = build([
      { name: 'items.x', value: '1' }, { name: 'items.y', value: '2' }, { name: 'itemsz', value: '100' },
      { name: 'a', value: '5' }, { name: 'ab', value: '50' },
      { name: 't1', actions: calc('AFSimple_Calculate("SUM", ["items"])') },
      { name: 't2', actions: calc('AFSimple_Calculate("SUM", "a,ab")') },
      { name: 't3', actions: calc('AFSimple_Calculate("SUM", "a")') },
    ], ['t1', 't2', 't3']);
    doc.Form.Recalculate();
    expect(doc.Form.Get('t1')!.Value).toBe('3');
    expect(doc.Form.Get('t2')!.Value).toBe('55');
    expect(doc.Form.Get('t3')!.Value).toBe('5');
  });

  it('leaves a custom calculate script untouched and reports it (Review Focus 3)', () => {
    const script = 'event.value = this.getField("a").value * 2;';
    const doc = build([{ name: 'a', value: '4' }, { name: 'dbl', value: '7', actions: calc(script) }], ['dbl']);
    const r = doc.Form.Recalculate();
    expect(r.unrecognised).toEqual([{ field: 'dbl', trigger: 'calculate', script }]);
    expect(r.changed).toEqual([]);
    expect(doc.Form.Get('dbl')!.Value).toBe('7');
  });

  it('reports a calculated field /CO does not list, and does not run it', () => {
    const doc = build([
      { name: 'a', value: '1' },
      { name: 'orphan', value: '9', actions: calc('AFSimple_Calculate("SUM", "a")') },
    ], []);
    const r = doc.Form.Recalculate();
    expect(r.notInOrder).toEqual(['orphan']);
    expect(doc.Form.Get('orphan')!.Value).toBe('9');
  });

  it('is a no-op on a document with no form', () => {
    const doc = Document.Open(buildBlankPage());
    expect(doc.Form.Recalculate()).toEqual({ changed: [], unrecognised: [], notInOrder: [] });
  });

  it('marks nothing modified when every total is already right (Review Focus 5)', async () => {
    const pre = build([
      { name: 'a', value: '1' }, { name: 'b', value: '2' },
      { name: 'total', value: '3', actions: calc('AFSimple_Calculate("SUM", new Array ("a", "b"));') },
    ], ['total']);
    const base = pre.Save();
    const doc = Document.Open(base);
    expect(doc.Form.Recalculate().changed).toEqual([]);
    const s = buildSigner();
    await doc.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
    expect(doc.Save().subarray(0, base.length)).toEqual(base);
  });
});

describe('CheckValues', () => {
  it('reports each value its own recognised rule rejects', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'pct', value: '150',
      actions: { validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100);' } } });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'ok', value: '50',
      actions: { validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100);' } } });
    const r = doc.Form.CheckValues();
    expect(r.rejected.map((x) => x.field)).toEqual(['pct']);
    expect(r.unrecognised).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/aform-recalc.test.ts`
Expected: FAIL (`Recalculate` is not a function).

- [ ] **Step 3: Split the `Value` setter in `formfield.ts`**

Replace the setter body so writing lives in `storeValue` (Task 10 adds the rule check to the setter):

```ts
  /** Set the field value. Validation happens before any mutation, so a throw
   *  leaves the document unmodified. */
  set Value(v: string | string[] | boolean) {
    this.storeValue(v);
  }

  /** @internal Write a value with no AForm rule check. Recalculate stores a
   *  calculated result through here even when the field's own validate rule
   *  rejects it: Acrobat calculates, then validates. */
  storeValue(v: string | string[] | boolean): void {
    switch (this.Type) {
      case 'text': this.setText(v); break;
      case 'checkbox': this.setCheckbox(v); break;
      case 'radio': this.setRadio(v); break;
      case 'choice': this.setChoice(v); break;
      default:
        throw new UnsupportedFeatureError(`cannot set the value of a ${this.Type} field`);
    }
    // In-place edits to live field/widget dicts: force a full rewrite on the next
    // sign so an incremental append cannot silently drop the new value.
    this.doc.markModified();
  }
```

- [ ] **Step 4: Write `src/afform.ts`**

```ts
// src/afform.ts
/**
 * Running the recognised AForm scripts over a live form (jzn8):
 * `Form.Recalculate()` and `Form.CheckValues()`. The one module of the feature
 * that holds a `Document`; `Document`, `Form` and `Field` are imported as TYPES
 * only, so this closes no import cycle. Nothing is executed: a script is one
 * recognised call or it is reported unrecognised.
 */
import type { Document } from './document.js';
import type { Field } from './formfield.js';
import { isArray, isDict } from './types.js';
import { parseAfCall } from './afcall.js';
import { simpleCalculate } from './afcalc.js';
import {
  evaluateRules,
  type RecalculateReport, type RecalculatedValue, type UnrecognisedScript,
  type ValueCheckReport, type ValueRejection,
} from './afrules.js';

const calcScript = (f: Field): string | undefined => {
  const c = f.Actions.calculate;
  return c !== undefined && c.type === 'javascript' ? c.script : undefined;
};
const textOf = (f: Field): string => { const v = f.Value; return typeof v === 'string' ? v : ''; };
/** AFMakeArrayFromList: a string splits on a comma and an optional space. */
const listOf = (v: string | readonly string[]): string[] => (typeof v === 'string' ? v.split(/, ?/g) : [...v]);

/** Recompute every /CO-listed field whose calculate script is a recognised
 *  AFSimple_Calculate, once, in /CO order — Acrobat's model. */
export function recalculate(doc: Document, fields: readonly Field[]): RecalculateReport {
  const changed: RecalculatedValue[] = [];
  const unrecognised: UnrecognisedScript[] = [];
  const notInOrder: string[] = [];

  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const co = isDict(acro) ? doc.resolve(acro.get('CO')) : undefined;
  const byDict = new Map(fields.map((f) => [f.Dict, f] as const));
  const ordered: Field[] = [];
  const listed = new Set<Field>();
  if (isArray(co)) {
    for (const e of co) {
      const d = doc.resolve(e);
      const f = isDict(d) ? byDict.get(d) : undefined;
      if (f !== undefined && !listed.has(f)) { listed.add(f); ordered.push(f); }
    }
  }
  for (const f of fields) if (!listed.has(f) && calcScript(f) !== undefined) notInOrder.push(f.FullName);

  for (const f of ordered) {
    const script = calcScript(f);
    if (script === undefined) continue;
    const call = parseAfCall(script);
    if (call === undefined || call.name !== 'AFSimple_Calculate' || f.Type !== 'text') {
      unrecognised.push({ field: f.FullName, trigger: 'calculate', script });
      continue;
    }
    const values: string[] = [];
    for (const name of listOf(call.args[1] as string | readonly string[])) {
      // A name covers itself and its subtree, never a mere string prefix.
      for (const x of fields) if (x.FullName === name || x.FullName.startsWith(`${name}.`)) values.push(textOf(x));
    }
    const result = simpleCalculate(call.args[0] as string, values);
    if (result === undefined) { unrecognised.push({ field: f.FullName, trigger: 'calculate', script }); continue; }
    const to = String(result);
    const from = textOf(f);
    if (to !== from) {
      f.storeValue(to);
      changed.push({ field: f.FullName, from, to });
    }
  }
  return { changed, unrecognised, notInOrder };
}

/** Check every text field's value against its recognised keystroke and
 *  validate rules. */
export function checkValues(fields: readonly Field[]): ValueCheckReport {
  const rejected: ValueRejection[] = [];
  const unrecognised: UnrecognisedScript[] = [];
  for (const f of fields) {
    if (f.Type !== 'text') continue;
    const r = evaluateRules(f.FullName, f.Actions, textOf(f));
    rejected.push(...r.rejected);
    unrecognised.push(...r.unrecognised);
  }
  return { rejected, unrecognised };
}
```

- [ ] **Step 5: Wire `form.ts`**

Add `import { recalculate, checkValues } from './afform.js';` and `import type { RecalculateReport, ValueCheckReport } from './afrules.js';`, then add to the `Form` class after `GenerateAppearances`:

```ts
  /** Recompute calculated fields whose calculate script is a recognised
   *  `AFSimple_Calculate`, once, in /AcroForm /CO order, as Acrobat does. No
   *  JavaScript is executed; any other script is reported, never run. A value
   *  that does not change is not written, so a no-op call marks nothing
   *  modified. */
  Recalculate(): RecalculateReport {
    return recalculate(this.doc, this.Fields);
  }

  /** Report each field value its own recognised keystroke or validate rule
   *  rejects. Reads only; changes nothing. */
  CheckValues(): ValueCheckReport {
    return checkValues(this.Fields);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/aform-recalc.test.ts test/import-cycles.test.ts test/limits-catch.test.ts`
Expected: PASS.

- [ ] **Step 7: Mutation check (must go red, then revert)**

Run the test after each change, then `git checkout src/afform.ts`:
1. `x.FullName.startsWith(\`${name}.\`)` → `x.FullName.startsWith(name)`. Review Focus 2 fails (t3 becomes 55).
2. Drop `if (to !== from)` (always write). Review Focus 5 fails (the signature becomes a full rewrite).
3. Run the `ordered` loop twice. The stale-input case fails.

- [ ] **Step 8: Commit**

```bash
git add src/afform.ts src/formfield.ts src/form.ts test/aform-recalc.test.ts
git commit -m "feat(jzn8): Form.Recalculate in /CO order and Form.CheckValues" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Opt-in enforcement, `Form.EnforceRules`

**Files:**
- Modify: `src/document.ts` (add the `formEnforceRules` flag beside `private modified = false;` near line 414)
- Modify: `src/form.ts` (the `EnforceRules` accessor)
- Modify: `src/formfield.ts` (the rule check in the `Value` setter)
- Test: `test/aform-enforce.test.ts`

**Interfaces:**
- Consumes: `evaluateRules` (Task 7); `storeValue` (Task 9).
- Produces: `Document.formEnforceRules: boolean` (`@internal`); `Form.EnforceRules: boolean` (get and set).

**Why on `Document`:** `doc.Form` builds a new `Form` on every access, so a flag on `Form` would be lost immediately. The accessor on `Form` reads and writes the document's flag.

- [ ] **Step 1: Write the failing test**

```ts
// test/aform-enforce.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfDict } from '../src/types.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

function pctDoc(): Document {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'pct', value: '10',
    actions: { validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100);' } } });
  return Document.Open(doc.Save());
}

describe('EnforceRules', () => {
  it('is off by default, and the setter accepts anything', () => {
    const doc = pctDoc();
    expect(doc.Form.EnforceRules).toBe(false);
    doc.Form.Get('pct')!.Value = '150';
    expect(doc.Form.Get('pct')!.Value).toBe('150');
  });

  it('persists across doc.Form accesses', () => {
    const doc = pctDoc();
    doc.Form.EnforceRules = true;
    expect(doc.Form.EnforceRules).toBe(true);
  });

  it('refuses a rejected value with RangeError and leaves the document byte-identical', () => {
    const doc = pctDoc();
    doc.Form.EnforceRules = true;
    const before = doc.Save();
    expect(() => { doc.Form.Get('pct')!.Value = '150'; }).toThrow(/AFRange_Validate/);
    expect(() => { doc.Form.Get('pct')!.Value = '150'; }).toThrow(RangeError);
    expect(doc.Save()).toEqual(before);
  });

  it('accepts a value the rule accepts', () => {
    const doc = pctDoc();
    doc.Form.EnforceRules = true;
    doc.Form.Get('pct')!.Value = '50';
    expect(doc.Form.Get('pct')!.Value).toBe('50');
  });

  it('does not block Recalculate from storing a result its own rule rejects', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a', value: '500' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 't', actions: {
      calculate: { type: 'javascript', script: 'AFSimple_Calculate("SUM", "a")' },
      validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100)' } } });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const dict = doc.Form.Get('t')!.Dict;
    const ref = [...doc.objectEntries()].find(([, o]) => o === dict)![0];   // already a PdfRef
    acro.set('CO', [ref]);
    doc.Form.EnforceRules = true;
    doc.Form.Recalculate();
    expect(doc.Form.Get('t')!.Value).toBe('500');
    expect(doc.Form.CheckValues().rejected.map((r) => r.field)).toEqual(['t']);
  });

  it('refuses a non-boolean', () => {
    expect(() => { (pctDoc().Form as { EnforceRules: unknown }).EnforceRules = 'yes'; }).toThrow(TypeError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/aform-enforce.test.ts`
Expected: FAIL (`EnforceRules` is undefined).

- [ ] **Step 3: Implement**

`document.ts`, beside `private modified = false;`:

```ts
  /** @internal `Form.EnforceRules` (jzn8). Lives on the Document because
   *  `doc.Form` is rebuilt per access. */
  formEnforceRules = false;
```

`form.ts`, in the `Form` class:

```ts
  /** When true, setting a text field's `Value` first checks it against the
   *  field's recognised keystroke and validate rules and throws RangeError on
   *  a rejection, leaving the document unchanged. Default false. Stored on the
   *  document, so it survives `doc.Form` being rebuilt. */
  get EnforceRules(): boolean {
    return this.doc.formEnforceRules;
  }

  set EnforceRules(v: boolean) {
    if (typeof v !== 'boolean') throw new TypeError('EnforceRules must be a boolean');
    this.doc.formEnforceRules = v;
  }
```

`formfield.ts`: add `evaluateRules` to the `./afrules.js` import, and change the setter:

```ts
  set Value(v: string | string[] | boolean) {
    if (this.doc.formEnforceRules && this.Type === 'text' && typeof v === 'string') {
      const { rejected } = evaluateRules(this.FullName, this.Actions, v);
      if (rejected.length > 0) throw new RangeError(`field "${this.FullName}": ${rejected[0].message}`);
    }
    this.storeValue(v);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/aform-enforce.test.ts test/aform-recalc.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation check (must go red, then revert)**

1. Move the flag onto `Form` (a private field initialised to false) instead of `Document`. The persistence case fails.
2. Make `recalculate` call `f.Value = to` instead of `f.storeValue(to)`. The Recalculate-under-enforcement case fails.

Revert with `git checkout src/form.ts src/afform.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/document.ts src/form.ts src/formfield.ts test/aform-enforce.test.ts
git commit -m "feat(jzn8): opt-in Form.EnforceRules refuses a value its rules reject" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: A real form from a producer we did not write

**Files:**
- Create (if a candidate qualifies): `test/fixtures/aform/real/<name>.pdf`, `test/aform-real.test.ts`
- Modify: `test/fixtures/aform/PROVENANCE.md` (a "Real form" section, whatever the outcome)

**Why:** the goldens prove the semantics; only a real file proves the recogniser accepts scripts Acrobat actually wrote. A fixture we author ourselves cannot do that.

- [ ] **Step 1: Fetch the candidate corpus**

```bash
cd "$TEMP" && git clone --filter=blob:none --no-checkout https://github.com/mozilla/pdf.js.git pdfjs-corpus \
  && cd pdfjs-corpus && git sparse-checkout set test/pdfs && git checkout d52fdf411a6e4d338180687456e0df019e28475e
```

Expected: `test/pdfs/` holds several hundred committed `.pdf` files, alongside `.link` files that are NOT committed PDFs; ignore the `.link` files.

- [ ] **Step 2: Scan for AF scripts with the library**

Write a throwaway `test/zz-scan.test.ts` (delete it after this step, never commit it):

```ts
import { it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { parseAfCall } from '../src/afcall.js';

it('scan', () => {
  const dir = join(process.env.TEMP ?? '/tmp', 'pdfjs-corpus', 'test', 'pdfs');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.pdf'))) {
    let doc: Document;
    try { doc = Document.Open(readFileSync(join(dir, f))); } catch { continue; }
    let af = 0; let ok = 0;
    for (const field of doc.Form.Fields) for (const a of Object.values(field.Actions)) {
      if (a?.type !== 'javascript' || !/\bAF[A-Za-z_]+\(/.test(a.script)) continue;
      af++; if (parseAfCall(a.script)) ok++;
    }
    if (af > 0) console.log(f, af, ok);
  }
});
```

Run: `npx vitest run test/zz-scan.test.ts`, record the output, then `rm test/zz-scan.test.ts`.

- [ ] **Step 3: Check the licence of each candidate**

For each file that printed, in the corpus checkout run `git log --format='%H %s' -- test/pdfs/<file>` and read the commit and any linked bug, plus `test/test_manifest.json`'s entry, for where the PDF came from. A file qualifies ONLY if its origin permits redistribution: a US federal government form (a work of the US government, public domain under 17 USC 105, for example an IRS, SSA or GSA form), or a file with an explicit permissive licence stated in the corpus. When in doubt, it does not qualify.

- [ ] **Step 4a (a candidate qualifies): vendor it and test it**

Copy it to `test/fixtures/aform/real/`. Add a "Real form" section to `PROVENANCE.md` with the source path, the pdf.js commit, the origin evidence (commit hash and message, or agency), the SHA-256 (`sha256sum`), and the counts from Step 2. Then write:

```ts
// test/aform-real.test.ts
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { parseAfCall } from '../src/afcall.js';

const FILE = new URL('./fixtures/aform/real/<name>.pdf', import.meta.url);

it('recognises every single-call AF script Acrobat wrote in a real form', () => {
  const doc = Document.Open(readFileSync(FILE));
  const scripts = doc.Form.Fields.flatMap((f) => Object.values(f.Actions))
    .filter((a) => a?.type === 'javascript' && /\bAF[A-Za-z_]+\(/.test(a.script))
    .map((a) => (a as { script: string }).script);
  expect(scripts.length).toBe(/* the Step 2 count for this file */ 0);
  expect(scripts.filter((s) => parseAfCall(s) !== undefined).length).toBe(/* the Step 2 recognised count */ 0);
});

it('runs Recalculate and CheckValues on it without throwing', () => {
  const doc = Document.Open(readFileSync(FILE));
  expect(() => doc.Form.Recalculate()).not.toThrow();
  expect(() => doc.Form.CheckValues()).not.toThrow();
});
```

Replace both `0` placeholders with the Step 2 numbers. If the recognised count is below the AF count, look at the unrecognised scripts. If each is more than one call, or not a literal-argument call, record them in PROVENANCE as expected refusals. If any IS a single literal call, the recogniser has a bug: fix it with a test in `test/afcall.test.ts` first.

- [ ] **Step 4b (nothing qualifies): record the gap**

Add a "Real form" section to `PROVENANCE.md`: the corpus commit, how many PDFs were scanned, which carried AF scripts, and why each was refused (its origin). State that recogniser coverage of real-world spelling rests on `test/afcall.test.ts`'s hand-written Acrobat spellings, and that a redistributable Acrobat-authored form remains the open item. Also file it: `bd create "Vendor a redistributable Acrobat-authored form with AF scripts" -t task -p 3 --silent -d "jzn8 Task 11 found no redistributable candidate in the pdf.js corpus; see test/fixtures/aform/PROVENANCE.md."`.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/aform
git add test/aform-real.test.ts 2>/dev/null || true
git commit -m "test(jzn8): real-form evidence for AF script recognition" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Exports, the no-execution guard, docs, verification

**Files:**
- Modify: `src/index.ts`
- Create: `test/aform-noexec.test.ts`
- Modify: `README.md`, `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Write the no-execution guard test**

```ts
// test/aform-noexec.test.ts
import { it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

// 6t2v.2: the library never executes JavaScript. This fails the build if any
// src module reaches for an evaluator.
it('src/ contains no JavaScript evaluator', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  expect(files.length).toBeGreaterThan(300);
  const hits = files.filter((f) => {
    const src = readFileSync(new URL(f, dir), 'utf8');
    return /\beval\s*\(|\bnew\s+Function\s*\(|(?<![.\w])Function\s*\(|['"]node:vm['"]/.test(src);
  });
  expect(hits).toEqual([]);
});
```

Run: `npx vitest run test/aform-noexec.test.ts`
Expected: PASS. If it names a file, read the match: an unrelated identifier that merely ends in `Function(` is excluded by the lookbehind, so a real hit must be investigated, not whitelisted.

- [ ] **Step 2: Export the public types**

In `src/index.ts`, next to the existing form exports, add:

```ts
export type { FieldAppearanceOptions } from './formfield.js';
export type {
  RecalculateReport, RecalculatedValue, UnrecognisedScript, ValueCheckReport, ValueRejection,
} from './afrules.js';
```

Run: `npx vitest run test/readme-api.test.ts`
Expected: FAIL, naming the five new types with no README row. That is Step 3's work.

- [ ] **Step 3: README**

- **API Reference:** add a row for each of the five types to the types table, placing each in the alphabetical run that holds its neighbours. The table is several runs concatenated, so search for the row just before where the name sorts. Add rows for `form.Recalculate()`, `form.CheckValues()`, `form.EnforceRules` and `field.FormattedValue` to the Forms table. Mention `{ format: true }` beside `GenerateAppearances`, `GenerateAppearance`, `Flatten` and `FlattenForm`.
- **Update the intro counts** to what `test/readme-api.test.ts` reports.
- **Additional Examples:** add a section "Recalculate and Format a Filled Form":

```ts
const doc = Document.Open(bytes);
doc.Form.Get('qty')!.Value = '3';
const calc = doc.Form.Recalculate();        // AFSimple_Calculate fields, in /CO order
const problems = doc.Form.CheckValues();    // values the form's own rules reject
doc.FlattenForm({ format: true });          // draw "$1,234.50", not "1234.5"
```

- **Scope and Limitations:** in the "Document JavaScript is stored, never executed" bullet, replace the sentences saying calculations are not evaluated and format scripts are not applied with: calculations and formats are **not run as JavaScript**; Acrobat's standard `AF*` calls are recognised by shape and implemented natively when you opt in (`Recalculate`, `format: true`, `CheckValues`, `EnforceRules`); any other script is reported, never run. Name the three stated divergences: strict date matching, no red negative numbers, no normalisation under `EnforceRules`. Add that `Recalculate()` is not refused on a signed or certified document: changing `/V` is form filling, which DocMDP permits, so the caller decides.

Run: `npx vitest run test/readme-api.test.ts`
Expected: PASS.

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]` → `### Added`, add an entry in the file's style:

```markdown
- **Acrobat's standard form scripts now take effect, without running any
  JavaScript.** A field's calculate, format, keystroke and validate scripts
  are recognised when they are exactly one call to one of Acrobat's 17
  standard AForm functions with literal arguments — `AFSimple_Calculate`,
  `AFNumber_Format`, `AFDate_FormatEx`, `AFRange_Validate` and the rest — and
  implemented natively. Everything is opt-in, so existing output is unchanged:
  `form.Recalculate()` recomputes totals once, in `/CO` order, as Acrobat
  does; `field.FormattedValue`, and `{ format: true }` on `GenerateAppearances`
  and `FlattenForm`, draw `$1,234.50` rather than `1234.5` while `/V` stays
  raw; `form.CheckValues()` reports values the form's own rules reject; and
  `form.EnforceRules = true` makes the `Value` setter refuse them. A script
  that is anything else is reported, never run. The semantics are transcribed
  from pdf.js's Apache-2.0 AForm and checked against <N> goldens generated
  from it; three divergences are stated in the README. (jzn8)
```

Replace `<N>` with the sum of `meta.json` `counts`.

- [ ] **Step 5: CLAUDE.md**

Add one Source-list entry naming all seven modules in bold (`**afcall.ts**`, `**afnumber.ts**`, `**afdate.ts**`, `**afspecial.ts**`, `**afcalc.ts**`, `**afrules.ts**`, `**afform.ts**`), placed after the `formdata.ts` group. Record these invariants: recognition is exactly one literal call and never partial; the pdf.js pin and why goldens use a fresh `Util` per case (the `/g` regex); strict date matching as the stated divergence; `exactSum` deliberately uses a different algorithm from the generator; `EnforceRules` lives on `Document` because `doc.Form` rebuilds; `Recalculate` stores through `storeValue`; and `test/aform-noexec.test.ts` as the guard. Under Build & Test, add `gen:aform` to the list of fixture generators, noting that it needs network access.

Then run the module-entry sweep from CLAUDE.md's Conventions section and expect empty output:

```bash
for f in src/*.ts; do b=$(basename "$f"); grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"; done
```

- [ ] **Step 6: Full verification**

Run: `npm run typecheck`, expecting no errors.
Run: `npm test`, expecting every file to pass.
If anything fails, fix it before committing; never skip a failing test.

- [ ] **Step 7: Commit, close and push**

```bash
git add src/index.ts test/aform-noexec.test.ts README.md CHANGELOG.md CLAUDE.md
git commit -m "docs(jzn8): document native AF* recognition; guard against evaluators" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-jzn8 --reason "Recognised AF* calls implemented natively (Recalculate, FormattedValue/format:true, CheckValues, EnforceRules), checked against pdf.js goldens; no JavaScript executed."
git add .beads/interactions.jsonl && git commit -m "chore: beads interaction log" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git pull --rebase --autostash && git push && git status -sb
```

Expected: `## main...origin/main` with nothing ahead.
