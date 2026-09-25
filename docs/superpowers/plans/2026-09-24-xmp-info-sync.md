# /Info ↔ XMP Sync and Typed XMP Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `doc.SyncMetadata(direction)`, drift-free `D:` ↔ ISO-8601 date conversion (also fixing the `SetMetadata`/`SetXmp` mirrors), and read-only typed XMP accessors (`doc.GetXmpValue`).

**Architecture:** Three new pure modules — `pdfdate.ts` (text-to-text date conversion, a leaf), `xmpvalue.ts` (typed view over an `RdfValue`), `metasync.ts` (reads both sides as raw text and plans a minimal update) — plus thin `Document` methods that apply them. Writes reuse the existing `installXmp` (edit-on-write, o6uu.3) and `applyUpdate`.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-xmp-info-sync-design.md`

## Global Constraints

- No runtime dependencies; only `node:` built-ins. Import specifiers carry `.js`.
- Every `catch` in `src/` calls `rethrowLimit(e)` as its first statement (`test/limits-catch.test.ts` enforces it); a bindingless `catch {` must be `catch (e) {`.
- Every name `index.ts` exports needs a README API Reference row whose first cell opens a backticked span with that name, and the README intro count sentence must match the compiler (`test/readme-api.test.ts`). Copy the counts from that test's failure message.
- CHANGELOG entries go under `## [Unreleased]`, in the same commit as the change: bold lead-in, prose saying what/why, issue id `(o6uu.4)` at the end.
- Before closing: `npm run typecheck` and `npm test` both green.
- A `Date` object passed to `SetMetadata`/`SetXmp` must produce byte-identical output to today.
- `SyncMetadata` must NOT call `markModified()` when nothing changed, and `infoToXmp` must never create `/Info`.
- Every converter in `pdfdate.ts` and `xmpvalue.ts` returns `undefined` on bad input and never throws.

## Review Focus

1. A document our OWN `SetMetadata(Date)` wrote (`/CreationDate D:…+00'00'` beside `xmp:CreateDate …T…:…:….000Z`) must sync as a no-op in both directions — different spellings of one instant. Pinned in Task 5 (sign-path test).
2. A `dc:title` Alt with translations: `infoToXmp` must replace only `x-default` and keep `de-DE`. Pinned in Task 5.
3. An XMP packet that will not parse must not make `xmpToInfo` wipe `/Info` — it falls back to `readXmp`'s fields. Pinned in Task 4.
4. `D:` dates with the PDF 2.0 offset spelling `+02'00` (no trailing apostrophe) and bare `+02`, and `Z00'00'` from older producers. Pinned in Task 1.
5. Two-digit years and year < 100 in `isoInstant` (`Date.UTC` maps 0–99 to 1900s). Pinned in Task 1.

---

### Task 1: `pdfdate.ts` — text-to-text date conversion

**Files:**
- Create: `src/pdfdate.ts`
- Test: `test/pdfdate.test.ts`

**Interfaces:**
- Produces:
  - `pdfDateToIso(s: string): string | undefined`
  - `isoToPdfDate(s: string): string | undefined`
  - `isoInstant(s: string): number | undefined` — epoch ms of an ISO date; no TZD reads as UTC
  - `sameInstant(a: string, b: string): boolean` — both ISO, equal to the second

- [ ] **Step 1: Write the failing tests**

```ts
// test/pdfdate.test.ts
import { describe, it, expect } from 'vitest';
import { pdfDateToIso, isoToPdfDate, isoInstant, sameInstant } from '../src/pdfdate.js';

describe('pdfDateToIso', () => {
  it.each([
    ['D:2024', '2024'],
    ['D:202406', '2024-06'],
    ['D:20240603', '2024-06-03'],
    ['D:2024060312', '2024-06-03T12:00'],
    ['D:202406031230', '2024-06-03T12:30'],
    ['D:20240603123045', '2024-06-03T12:30:45'],
    ['D:20240603123045Z', '2024-06-03T12:30:45Z'],
    ['D:20240603123045Z00\'00\'', '2024-06-03T12:30:45Z'],
    ["D:20240603123045+02'00'", '2024-06-03T12:30:45+02:00'],
    ["D:20240603123045+02'00", '2024-06-03T12:30:45+02:00'],
    ['D:20240603123045+02', '2024-06-03T12:30:45+02:00'],
    ["D:20240603123045-05'30'", '2024-06-03T12:30:45-05:30'],
    ['20240603123045Z', '2024-06-03T12:30:45Z'],
  ])('%s -> %s', (pdf, iso) => {
    expect(pdfDateToIso(pdf)).toBe(iso);
  });

  it.each([
    'garbage', 'D:', 'D:24', 'D:20241303', 'D:20240632', 'D:20240603250000',
    'D:20240603126000', 'D:20240603123060', "D:20240603123045+24'00'",
    "D:20240603123045+02'60'", 'D:2024Z', '2024-06-03',
  ])('refuses %s', (s) => {
    expect(pdfDateToIso(s)).toBeUndefined();
  });
});

describe('isoToPdfDate', () => {
  it.each([
    ['2024', 'D:2024'],
    ['2024-06', 'D:202406'],
    ['2024-06-03', 'D:20240603'],
    ['2024-06-03T12:30', 'D:202406031230'],
    ['2024-06-03T12:30:45', 'D:20240603123045'],
    ['2024-06-03T12:30:45Z', 'D:20240603123045Z'],
    ['2024-06-03T12:30:45.123Z', 'D:20240603123045Z'],
    ['2024-06-03T12:30:45+02:00', "D:20240603123045+02'00'"],
    ['2024-06-03T12:30-05:30', "D:202406031230-05'30'"],
  ])('%s -> %s', (iso, pdf) => {
    expect(isoToPdfDate(iso)).toBe(pdf);
  });

  it.each(['garbage', '2024-13', '2024-06-03T24:00', '2024-06-03T12', '2024-06-03Z',
    '2024-06-03T12:30:45+02', 'D:20240603'])('refuses %s', (s) => {
    expect(isoToPdfDate(s)).toBeUndefined();
  });
});

describe('round trip', () => {
  it.each([
    'D:20240603123045Z', "D:20240603123045+02'00'", "D:19991231235959-11'45'",
    'D:20240603123045', 'D:202406031230', 'D:20240603', 'D:2024',
  ])('D -> ISO -> D is exact for %s', (d) => {
    expect(isoToPdfDate(pdfDateToIso(d)!)).toBe(d);
  });
});

describe('isoInstant / sameInstant', () => {
  it('reads a TZD-less time as UTC and applies an offset', () => {
    expect(isoInstant('2024-06-03T12:30:45')).toBe(Date.UTC(2024, 5, 3, 12, 30, 45));
    expect(isoInstant('2024-06-03T14:30:45+02:00')).toBe(Date.UTC(2024, 5, 3, 12, 30, 45));
    expect(isoInstant('2024')).toBe(Date.UTC(2024, 0, 1));
  });

  it('keeps a year below 100 as written', () => {
    expect(new Date(isoInstant('0050-01-01')!).getUTCFullYear()).toBe(50);
  });

  it('treats one instant spelled two ways as the same, to the second', () => {
    expect(sameInstant('2024-06-03T12:30:45.000Z', '2024-06-03T12:30:45+00:00')).toBe(true);
    expect(sameInstant('2024-06-03T14:30:45+02:00', '2024-06-03T12:30:45Z')).toBe(true);
    expect(sameInstant('2024-06-03T12:30:45.900Z', '2024-06-03T12:30:45Z')).toBe(true);
    expect(sameInstant('2024-06-03T12:30:46Z', '2024-06-03T12:30:45Z')).toBe(false);
    expect(sameInstant('junk', '2024-06-03T12:30:45Z')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/pdfdate.test.ts`
Expected: FAIL — cannot resolve `../src/pdfdate.js`.

- [ ] **Step 3: Implement**

```ts
// src/pdfdate.ts
/** PDF dates (32000-1 7.9.4, `D:YYYYMMDDHHmmSSOHH'mm'`) and XMP dates (the
 *  W3C-DTF profile of ISO 8601) converted TEXT TO TEXT (`o6uu.4`).
 *
 *  A leaf importing nothing. The conversion never passes through a JS `Date`,
 *  which keeps an instant but loses the offset it was written in — so
 *  `D:20240603123045+02'00'` and `2024-06-03T12:30:45+02:00` convert into
 *  each other exactly, precision and offset intact. Nothing here throws: a
 *  string that does not read is `undefined`. */

interface DateParts {
  y: string; mo?: string; d?: string; h?: string; mi?: string; s?: string;
  /** ISO fractional seconds including the dot; PDF dates cannot carry one. */
  frac?: string;
  tz?: { z: true } | { z: false; sign: '+' | '-'; h: string; m: string };
}

// The D: prefix is required by PDF 2.0 and optional in 1.x, so it is optional
// here. The offset is `+HH'mm'`, `+HH'mm` (PDF 2.0), `+HH'` or `+HH`; older
// producers write `Z00'00'`.
const PDF_RE = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)(?:00'?00'?)?|([+-])(\d{2})(?:'(\d{2})?'?)?)?$/;
const ISO_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;

const within = (v: string | undefined, lo: number, hi: number) => v === undefined || (+v >= lo && +v <= hi);

function valid(p: DateParts): DateParts | undefined {
  if (!within(p.mo, 1, 12) || !within(p.d, 1, 31) || !within(p.h, 0, 23)
    || !within(p.mi, 0, 59) || !within(p.s, 0, 59)) return undefined;
  if (p.tz && !p.tz.z && (!within(p.tz.h, 0, 23) || !within(p.tz.m, 0, 59))) return undefined;
  // A zone designator means nothing without a time of day, in either grammar.
  if (p.tz && p.h === undefined) return undefined;
  return p;
}

function parsePdf(s: string): DateParts | undefined {
  const m = PDF_RE.exec(s.trim());
  if (!m) return undefined;
  const tz: DateParts['tz'] = m[7] ? { z: true }
    : m[8] ? { z: false, sign: m[8] as '+' | '-', h: m[9], m: m[10] ?? '00' } : undefined;
  return valid({ y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6], tz });
}

function parseIso(s: string): DateParts | undefined {
  const m = ISO_RE.exec(s.trim());
  if (!m) return undefined;
  const tz: DateParts['tz'] = m[8] === undefined ? undefined : m[8] === 'Z' ? { z: true }
    : { z: false, sign: m[8][0] as '+' | '-', h: m[8].slice(1, 3), m: m[8].slice(4, 6) };
  return valid({ y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6], frac: m[7], tz });
}

/** `D:` text to ISO 8601 text, or `undefined`. A `D:` date stating an hour
 *  and no minutes gains `:00`, since ISO requires minutes with an hour. */
export function pdfDateToIso(s: string): string | undefined {
  const p = parsePdf(s);
  if (!p) return undefined;
  let out = p.y;
  if (p.mo) out += `-${p.mo}`;
  if (p.d) out += `-${p.d}`;
  if (p.h) {
    out += `T${p.h}:${p.mi ?? '00'}`;
    if (p.s) out += `:${p.s}`;
    if (p.tz) out += p.tz.z ? 'Z' : `${p.tz.sign}${p.tz.h}:${p.tz.m}`;
  }
  return out;
}

/** ISO 8601 text to `D:` text, or `undefined`. Fractional seconds are dropped
 *  — a PDF date has no field for them. The offset is written `+HH'mm'`, the
 *  spelling `formatPdfDate` already uses. */
export function isoToPdfDate(s: string): string | undefined {
  const p = parseIso(s);
  if (!p) return undefined;
  let out = `D:${p.y}${p.mo ?? ''}${p.d ?? ''}${p.h ?? ''}${p.mi ?? ''}${p.s ?? ''}`;
  if (p.tz) out += p.tz.z ? 'Z' : `${p.tz.sign}${p.tz.h}'${p.tz.m}'`;
  return out;
}

/** Epoch milliseconds of an ISO date, or `undefined`. A time with no zone
 *  designator is read as UTC — both sides of a comparison get the same
 *  reading, and XMP gives no other. */
export function isoInstant(s: string): number | undefined {
  const p = parseIso(s);
  if (!p) return undefined;
  const d = new Date(Date.UTC(2000, +(p.mo ?? '1') - 1, +(p.d ?? '1'), +(p.h ?? '0'), +(p.mi ?? '0'), +(p.s ?? '0')));
  d.setUTCFullYear(+p.y); // Date.UTC maps years 0-99 onto the 1900s
  let ms = d.getTime() + (p.frac ? Math.floor(Number(`0${p.frac}`) * 1000) : 0);
  if (p.tz && !p.tz.z) ms -= (p.tz.sign === '-' ? -1 : 1) * (+p.tz.h * 60 + +p.tz.m) * 60000;
  return ms;
}

/** Do two ISO dates name the same instant, to the second? Seconds, because a
 *  `D:` date can hold nothing finer — a `.000Z` and a `+00:00` spelling of one
 *  moment must compare equal or every sync of our own output rewrites it. */
export function sameInstant(a: string, b: string): boolean {
  const x = isoInstant(a), y = isoInstant(b);
  return x !== undefined && y !== undefined && Math.floor(x / 1000) === Math.floor(y / 1000);
}
```

Note for `setUTCFullYear` after `Date.UTC(2000, …)`: a Feb 29 kept on a non-leap target year rolls to Mar 1. That is acceptable for a comparison helper; do not add special-casing.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/pdfdate.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/pdfdate.ts test/pdfdate.test.ts
git commit -m "feat(o6uu.4): text-to-text D: <-> ISO-8601 date conversion"
```
(End every commit message with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer.)

---

### Task 2: Fix the `SetMetadata` / `SetXmp` date mirrors

**Files:**
- Modify: `src/xmp.ts` (`mirrorMetaToXmp`, `mirrorXmpToMeta`, export `splitAuthors` and `NS`)
- Test: `test/xmp-mirror-dates.test.ts`
- Modify: `CHANGELOG.md` (`### Fixed` under `[Unreleased]`)

**Interfaces:**
- Consumes: `pdfDateToIso`, `isoToPdfDate` from Task 1.
- Produces (for Task 4): `export function splitAuthors(s: string): string[]` and `export const NS` (the existing namespace table) in `src/xmp.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/xmp-mirror-dates.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { decodePdfText } from '../src/metadata.js';
import { inflateStream } from '../src/flate.js';
import { isStream, isString } from '../src/types.js';
import { parseRdfPacket } from '../src/xmprdf.js';

const XMP = 'http://ns.adobe.com/xap/1.0/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
const xmpText = (d: Document, name: string): string | undefined => {
  const md = d.resolve(d.catalog().get('Metadata'));
  if (!isStream(md)) return undefined;
  const p = parseRdfPacket(inflateStream(md)).properties.find((q) => q.ns === XMP && q.name === name);
  return p?.value.kind === 'simple' ? p.value.value : undefined;
};
const infoText = (d: Document, key: string): string | undefined => {
  const v = d.resolve(d.ensureInfo().get(key));
  return isString(v) ? decodePdfText(v.bytes) : undefined;
};

describe('date mirrors', () => {
  it('SetMetadata converts a D: string before writing it to XMP', () => {
    const d = doc1();
    d.SetMetadata({ creationDate: "D:20240603123045+02'00'", modDate: 'D:20240603Z' });
    expect(xmpText(d, 'CreateDate')).toBe('2024-06-03T12:30:45+02:00');
    // A zone with no time does not read, so it passes through as before.
    expect(xmpText(d, 'ModifyDate')).toBe('D:20240603Z');
  });

  it('SetXmp converts an ISO string before writing it to /Info', () => {
    const d = doc1();
    d.SetXmp({ createDate: '2024-06-03T12:30:45-05:30' });
    expect(infoText(d, 'CreationDate')).toBe("D:20240603123045-05'30'");
  });

  it('leaves the Date-object path byte-identical', () => {
    const at = new Date(Date.UTC(2024, 5, 3, 12, 30, 45));
    const d = doc1();
    d.SetMetadata({ creationDate: at });
    expect(xmpText(d, 'CreateDate')).toBe('2024-06-03T12:30:45.000Z');
    expect(infoText(d, 'CreationDate')).toBe("D:20240603123045+00'00'");
    const e = doc1();
    e.SetXmp({ modifyDate: at });
    expect(infoText(e, 'ModDate')).toBe("D:20240603123045+00'00'");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmp-mirror-dates.test.ts`
Expected: FAIL — first two cases write the string verbatim (`D:20240603123045+02'00'` in XMP; the ISO string in `/Info`). The third passes already.

- [ ] **Step 3: Implement**

In `src/xmp.ts`:

1. Add the import: `import { pdfDateToIso, isoToPdfDate } from './pdfdate.js';`
2. Change `const NS = {` to `export const NS = {`.
3. Change `function splitAuthors(` to `export function splitAuthors(`.
4. Add, above `mirrorMetaToXmp`:

```ts
/** A STRING date is re-spelled in the other side's syntax (`o6uu.4`); one that
 *  does not read passes through as it always did. A `Date` is untouched, so
 *  every caller passing one writes the same bytes as before. */
function toIsoDate(v: Date | string | null): Date | string | null {
  return typeof v === 'string' ? pdfDateToIso(v) ?? v : v;
}
function toPdfDate(v: Date | string | null): Date | string | null {
  return typeof v === 'string' ? isoToPdfDate(v) ?? v : v;
}
```

5. In `mirrorMetaToXmp` replace the two date lines with:

```ts
  if (u.creationDate !== undefined) out.createDate = toIsoDate(u.creationDate);
  if (u.modDate !== undefined) out.modifyDate = toIsoDate(u.modDate);
```

6. In `mirrorXmpToMeta` replace the two date lines with:

```ts
  if (u.createDate !== undefined) out.creationDate = toPdfDate(u.createDate);
  if (u.modifyDate !== undefined) out.modDate = toPdfDate(u.modifyDate);
```

- [ ] **Step 4: Run to verify pass, and the existing XMP suites**

Run: `npx vitest run test/xmp-mirror-dates.test.ts test/xmp.test.ts test/xmp-edit.test.ts test/xmp-preserve.test.ts test/document-metadata.test.ts test/metadata.test.ts`
Expected: PASS. If an existing case asserted a verbatim `D:` string inside XMP, it asserted the bug — update it to the converted form and say so in the commit message.

- [ ] **Step 5: CHANGELOG**

Under `## [Unreleased]` → `### Fixed` (create the heading below `### Security` if absent — it exists at line ~168), add at the top of that section:

```markdown
- **A date passed as a string no longer lands in the wrong syntax on the other
  side.** `SetMetadata({ creationDate: "D:20240603123045+02'00'" })` copied
  that `D:` text verbatim into `xmp:CreateDate`, and `SetXmp` copied an
  ISO-8601 string verbatim into `/CreationDate` — each a value the other
  side's grammar does not accept, which PDF/A readers reject. A string date is
  now converted text to text, keeping its precision and its UTC offset; one
  that does not read passes through as before, and a `Date` object is
  written exactly as it always was (o6uu.4).
```

- [ ] **Step 6: Commit**

```bash
git add src/xmp.ts test/xmp-mirror-dates.test.ts CHANGELOG.md
git commit -m "fix(o6uu.4): convert string dates in the /Info <-> XMP mirrors"
```

---

### Task 3: `xmpvalue.ts` and `doc.GetXmpValue`

**Files:**
- Create: `src/xmpvalue.ts`
- Modify: `src/document.ts` (add `GetXmpValue`), `src/index.ts`, `README.md`, `CHANGELOG.md`
- Test: `test/xmpvalue.test.ts`

**Interfaces:**
- Consumes: `isoInstant` (Task 1); `RdfValue`, `RdfPacket`, `parseRdfPacket` from `src/xmprdf.ts`; `langMatches` from `src/langmatch.ts`.
- Produces:
  - `export class XmpValue { readonly raw: RdfValue; asText(lang?: string): string | undefined; asDate(): { iso: string; date: Date } | undefined; asBool(): boolean | undefined; asInt(): number | undefined; asReal(): number | undefined; asUri(): string | undefined; asArray(): XmpValue[] | undefined }`
  - `export function findXmpValue(packet: RdfPacket, namespaceUri: string, name: string): XmpValue | undefined`
  - `Document.GetXmpValue(namespaceUri: string, propName: string): XmpValue | undefined`

- [ ] **Step 1: Write the failing tests**

```ts
// test/xmpvalue.test.ts
import { describe, it, expect } from 'vitest';
import { XmpValue, findXmpValue } from '../src/xmpvalue.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS, type RdfValue } from '../src/xmprdf.js';

const s = (value: string): RdfValue => ({ kind: 'simple', value });
const alt = (...items: [string, string][]): RdfValue =>
  ({ kind: 'array', form: 'Alt', items: items.map(([lang, v]) => ({ lang, value: s(v) })) });
const v = (raw: RdfValue) => new XmpValue(raw);

describe('XmpValue.asText', () => {
  it('reads a simple value and refuses a URI, a struct and a Seq', () => {
    expect(v(s('hi')).asText()).toBe('hi');
    expect(v({ kind: 'simple', value: 'http://x', uri: true }).asText()).toBeUndefined();
    expect(v({ kind: 'struct', fields: [] }).asText()).toBeUndefined();
    expect(v({ kind: 'array', form: 'Seq', items: [{ value: s('a') }] }).asText()).toBeUndefined();
  });

  it('picks from an Alt: exact tag, then RFC 4647 match, then x-default, then first', () => {
    const t = alt(['en', 'Colour'], ['x-default', 'Default'], ['de-DE', 'Farbe'], ['en-US', 'Color']);
    expect(t.kind).toBe('array');
    expect(v(t).asText('en-US')).toBe('Color');       // exact beats the earlier range match
    expect(v(t).asText('de')).toBe('Farbe');          // range 'de' matches tag 'de-DE'
    expect(v(t).asText('fr')).toBe('Default');
    expect(v(t).asText()).toBe('Default');
    expect(v(alt(['en', 'A'], ['de', 'B'])).asText()).toBe('A');
    expect(v(alt()).asText()).toBeUndefined();
  });
});

describe('XmpValue scalar converters', () => {
  it('asBool reads True/False case-insensitively and nothing else', () => {
    expect(v(s('True')).asBool()).toBe(true);
    expect(v(s('false')).asBool()).toBe(false);
    expect(v(s('1')).asBool()).toBeUndefined();
    expect(v(s(' True')).asBool()).toBeUndefined();
  });

  it('asInt is strict and safe-integer only', () => {
    expect(v(s('-42')).asInt()).toBe(-42);
    expect(v(s('+7')).asInt()).toBe(7);
    expect(v(s('12abc')).asInt()).toBeUndefined();
    expect(v(s('1.5')).asInt()).toBeUndefined();
    expect(v(s('9007199254740993')).asInt()).toBeUndefined();
  });

  it('asReal takes decimals, no exponent, NaN or Infinity', () => {
    expect(v(s('3.25')).asReal()).toBe(3.25);
    expect(v(s('-.5')).asReal()).toBe(-0.5);
    expect(v(s('7')).asReal()).toBe(7);
    expect(v(s('1e3')).asReal()).toBeUndefined();
    expect(v(s('NaN')).asReal()).toBeUndefined();
    expect(v(s('Infinity')).asReal()).toBeUndefined();
    expect(v(s('')).asReal()).toBeUndefined();
  });

  it('asDate keeps the ISO text beside the instant', () => {
    expect(v(s('2024-06-03T14:30:45+02:00')).asDate())
      .toEqual({ iso: '2024-06-03T14:30:45+02:00', date: new Date(Date.UTC(2024, 5, 3, 12, 30, 45)) });
    expect(v(s('D:20240603')).asDate()).toBeUndefined();
  });

  it('asUri reads only an rdf:resource value', () => {
    expect(v({ kind: 'simple', value: 'http://x', uri: true }).asUri()).toBe('http://x');
    expect(v(s('http://x')).asUri()).toBeUndefined();
  });

  it('asArray wraps the items of any container, and nothing else', () => {
    const bag: RdfValue = { kind: 'array', form: 'Bag', items: [{ value: s('a') }, { value: s('b') }] };
    expect(v(bag).asArray()!.map((x) => x.asText())).toEqual(['a', 'b']);
    expect(v(s('a')).asArray()).toBeUndefined();
  });
});

describe('findXmpValue', () => {
  it('finds a top-level property by namespace URI and name', () => {
    const packet = { properties: [{ ns: 'urn:a', name: 'p', value: s('x') }], prefixes: new Map() };
    expect(findXmpValue(packet, 'urn:a', 'p')!.asText()).toBe('x');
    expect(findXmpValue(packet, 'urn:b', 'p')).toBeUndefined();
  });
});

describe('doc.GetXmpValue', () => {
  const ACME = 'http://acme.example/ns/1.0/';
  const seed = (d: Document, body: string) => {
    const text = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}">`
      + `<rdf:Description rdf:about="" xmlns:acme="${ACME}">${body}</rdf:Description></rdf:RDF></x:xmpmeta>`;
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
  };
  const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };

  it('reads typed values from the document packet', () => {
    const d = doc1();
    seed(d, '<acme:Count>12</acme:Count><acme:Ok>True</acme:Ok>');
    expect(d.GetXmpValue(ACME, 'Count')!.asInt()).toBe(12);
    expect(d.GetXmpValue(ACME, 'Ok')!.asBool()).toBe(true);
    expect(d.GetXmpValue(ACME, 'Missing')).toBeUndefined();
  });

  it('is undefined with no packet, and for a packet that will not parse', () => {
    const d = doc1();
    expect(d.GetXmpValue(ACME, 'Count')).toBeUndefined();
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode('<not xml') }));
    expect(d.GetXmpValue(ACME, 'Count')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/xmpvalue.test.ts`
Expected: FAIL — cannot resolve `../src/xmpvalue.js`.

- [ ] **Step 3: Implement the module**

```ts
// src/xmpvalue.ts
import type { RdfPacket, RdfValue } from './xmprdf.js';
import { langMatches } from './langmatch.js';
import { isoInstant } from './pdfdate.js';

/** One XMP property value, read through the XMP value types (`o6uu.4`).
 *
 *  A view over the `xmprdf.ts` model, which already holds every value —
 *  simple values, URIs, Alt/Seq/Bag arrays, structs and qualifiers. Every
 *  converter is LENIENT: a value that does not read as the type asked for is
 *  `undefined`, never a throw, the posture `GetXmp` takes for a packet a
 *  producer wrote. Read-only; writing is `o6uu.8`. */
export class XmpValue {
  constructor(readonly raw: RdfValue) {}

  /** The text of a simple, non-URI value. For a language alternative, the
   *  item whose tag equals `lang` (case-insensitive), else the first whose tag
   *  matches `lang` as an RFC 4647 range, else `x-default`, else the first. */
  asText(lang?: string): string | undefined {
    const r = this.raw;
    if (r.kind === 'simple') return r.uri ? undefined : r.value;
    if (r.kind !== 'array' || r.form !== 'Alt' || r.items.length === 0) return undefined;
    const tagOf = (i: number) => r.items[i].lang ?? '';
    let pick = -1;
    if (lang !== undefined) {
      pick = r.items.findIndex((_, i) => tagOf(i).toLowerCase() === lang.toLowerCase());
      if (pick < 0) pick = r.items.findIndex((_, i) => langMatches(tagOf(i), lang));
    }
    if (pick < 0) pick = r.items.findIndex((_, i) => tagOf(i).toLowerCase() === 'x-default');
    if (pick < 0) pick = 0;
    const item = r.items[pick].value;
    return item.kind === 'simple' && !item.uri ? item.value : undefined;
  }

  /** An XMP date: the ISO text as written beside the instant it names. A time
   *  with no zone designator is read as UTC. */
  asDate(): { iso: string; date: Date } | undefined {
    const t = this.asText();
    if (t === undefined || this.raw.kind !== 'simple') return undefined;
    const ms = isoInstant(t);
    return ms === undefined ? undefined : { iso: t, date: new Date(ms) };
  }

  /** XMP spells a Boolean `True` / `False`; case is not significant here. */
  asBool(): boolean | undefined {
    const t = this.scalar();
    if (t === undefined) return undefined;
    if (/^true$/i.test(t)) return true;
    if (/^false$/i.test(t)) return false;
    return undefined;
  }

  asInt(): number | undefined {
    const t = this.scalar();
    if (t === undefined || !/^[+-]?\d+$/.test(t)) return undefined;
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : undefined;
  }

  /** A decimal real; no exponent, `NaN` or `Infinity` — those are
   *  JavaScript's spellings, not XMP's. */
  asReal(): number | undefined {
    const t = this.scalar();
    if (t === undefined || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined;
    return Number(t);
  }

  /** A URI value — written `rdf:resource`, not a string that looks like one. */
  asUri(): string | undefined {
    return this.raw.kind === 'simple' && this.raw.uri ? this.raw.value : undefined;
  }

  /** The items of a Seq, Bag or Alt. */
  asArray(): XmpValue[] | undefined {
    return this.raw.kind === 'array' ? this.raw.items.map((i) => new XmpValue(i.value)) : undefined;
  }

  private scalar(): string | undefined {
    return this.raw.kind === 'simple' && !this.raw.uri ? this.raw.value : undefined;
  }
}

/** The top-level property `(namespaceUri, name)` of `packet`, or `undefined`. */
export function findXmpValue(packet: RdfPacket, namespaceUri: string, name: string): XmpValue | undefined {
  const p = packet.properties.find((q) => q.ns === namespaceUri && q.name === name);
  return p === undefined ? undefined : new XmpValue(p.value);
}
```

- [ ] **Step 4: Add `Document.GetXmpValue`**

In `src/document.ts`:
- Add imports: `import { XmpValue, findXmpValue } from './xmpvalue.js';` and `import { parseRdfPacket } from './xmprdf.js';` (merge into an existing `./xmprdf.js` import if one exists — `grep -n "xmprdf" src/document.ts`).
- Directly after `GetXmp()` (around line 1181–1186), add:

```ts
  /** One XMP property as a typed value (`o6uu.4`), found by namespace URI and
   *  local name among the packet's top-level properties; `undefined` when
   *  there is no packet, the property is absent, or the packet will not parse.
   *  Parsed under this document's `loadLimits`. */
  GetXmpValue(namespaceUri: string, propName: string): XmpValue | undefined {
    const md = this.resolve(this.catalog().get('Metadata'));
    if (!isStream(md)) return undefined;
    try {
      return findXmpValue(parseRdfPacket(inflateStream(md), this.loadLimits), namespaceUri, propName);
    } catch (e) {
      rethrowLimit(e);
      return undefined;
    }
  }
```

(The parameter is `propName`, not `name`: `document.ts` imports a `name()` helper from `types.js`.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run test/xmpvalue.test.ts`
Expected: PASS.

- [ ] **Step 6: Export and document**

In `src/index.ts`, next to line 209 (`export type { XmpMetadata, XmpUpdate } from './xmp.js';`), add:

```ts
export type { XmpValue } from './xmpvalue.js';
```

In `README.md`:
- API Reference — directly after the `| \`doc.SetXmp(update)\` | … |` row (~line 3371), add:

```markdown
| `doc.GetXmpValue(namespaceUri, name)` | One top-level XMP property as a typed `XmpValue` (`undefined` when absent or no packet) |
```

- Types table — directly after the `| \`XmpMetadata\` | … |` row (~line 3127), add:

```markdown
| `XmpValue` | A read-only XMP property value: `asText(lang?)`, `asDate()`, `asBool()`, `asInt()`, `asReal()`, `asUri()`, `asArray()`, each `undefined` when the value does not read as that type; `raw` is the underlying model. |
```

- In the "Read and Write XMP Metadata" section (~line 2429), after the paragraph ending "…is rejected.", add:

````markdown
`GetXmpValue(namespaceUri, name)` reads any top-level property through the XMP
value types, including arrays, language alternatives and URIs that `GetXmp`
does not model:

```ts
const XMP = 'http://ns.adobe.com/xap/1.0/';
const rating = doc.GetXmpValue(XMP, 'Rating')?.asInt();
const title = doc.GetXmpValue('http://purl.org/dc/elements/1.1/', 'title')?.asText('de');
const created = doc.GetXmpValue(XMP, 'CreateDate')?.asDate(); // { iso, date }
```

Every converter returns `undefined` rather than throwing when the value does
not read as that type. `asText(lang)` picks from a language alternative by
exact tag, then RFC 4647 range, then `x-default`. Typed writes are not yet
available.
````

- Also fix the stale limitation at ~line 3766 (`- **XMP covers the known schemas** — … not surgically preserved.`): since `o6uu.3` `SetXmp` edits the packet, so replace that bullet with:

```markdown
- **XMP typed writes are not available** — `GetXmpValue` reads any top-level property through the XMP value types, but writing is limited to `SetXmp`'s named fields and simple custom literals. Unknown schemas already in a packet survive `SetXmp`.
```

Run: `npx vitest run test/readme-api.test.ts`
If "states the counts the compiler reports" fails, edit the README intro count sentence to the numbers in the failure message (the test prints expected vs received). Re-run until PASS.

- [ ] **Step 7: CHANGELOG**

Under `## [Unreleased]` → `### Added` (the first `### Added`, ~line 397), add at its top:

```markdown
- **Typed XMP reads.** `doc.GetXmpValue(namespaceUri, name)` returns any
  top-level XMP property as an `XmpValue` with `asText(lang?)`, `asDate()`,
  `asBool()`, `asInt()`, `asReal()`, `asUri()` and `asArray()`. It reaches
  what `GetXmp()`'s fifteen named fields never modelled — arrays, language
  alternatives chosen by RFC 4647 range, and `rdf:resource` URIs — over the
  data model `SetXmp` already edits. Every converter answers `undefined`
  rather than throwing, so a producer's malformed value costs that value and
  nothing else; `asDate()` keeps the ISO text beside the instant, since a JS
  `Date` drops the offset it was written in (o6uu.4).
```

- [ ] **Step 8: Commit**

```bash
git add src/xmpvalue.ts src/document.ts src/index.ts test/xmpvalue.test.ts README.md CHANGELOG.md
git commit -m "feat(o6uu.4): typed XMP reads through doc.GetXmpValue"
```

---

### Task 4: `metasync.ts` — read both sides, plan the sync

**Files:**
- Create: `src/metasync.ts`
- Test: `test/metasync.test.ts`

**Interfaces:**
- Consumes: `pdfDateToIso`, `isoToPdfDate`, `sameInstant` (Task 1); `splitAuthors`, `NS`, `readXmp`, `XmpUpdate` from `src/xmp.ts` (Task 2 exports); `decodePdfText`, `MetadataUpdate` from `src/metadata.ts`; `parseRdfPacket`, `RdfValue` from `src/xmprdf.ts`; `LoadLimits` type from `src/loadlimits.ts`.
- Produces:
  - `export type MetadataField = 'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer' | 'creationDate' | 'modDate'`
  - `export type SyncDirection = 'infoToXmp' | 'xmpToInfo'`
  - `export interface MetadataSyncReport { changed: MetadataField[]; skipped: MetadataField[] }`
  - `export type SideText = Partial<Record<MetadataField, string>>`
  - `export interface SyncPlan extends MetadataSyncReport { info: MetadataUpdate; xmp: XmpUpdate }`
  - `export function infoSide(info: PdfDict | undefined, resolve: (o: PdfObject | undefined) => PdfObject): SideText`
  - `export function xmpSide(bytes: Uint8Array | undefined, limits: LoadLimits): SideText`
  - `export function planSync(info: SideText, xmp: SideText, direction: SyncDirection): SyncPlan`

- [ ] **Step 1: Write the failing tests**

```ts
// test/metasync.test.ts
import { describe, it, expect } from 'vitest';
import { planSync, infoSide, xmpSide } from '../src/metasync.js';
import { encodePdfText } from '../src/metadata.js';
import { LoadLimits } from '../src/loadlimits.js';
import { RDF_NS } from '../src/xmprdf.js';
import type { PdfDict, PdfObject } from '../src/types.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMPNS = 'http://ns.adobe.com/xap/1.0/';
const PDF = 'http://ns.adobe.com/pdf/1.3/';
const packet = (body: string) => new TextEncoder().encode(
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""`
  + ` xmlns:dc="${DC}" xmlns:xmp="${XMPNS}" xmlns:pdf="${PDF}">${body}</rdf:Description></rdf:RDF></x:xmpmeta>`);

describe('planSync infoToXmp', () => {
  it('copies a differing field, deletes one the source lacks, leaves agreement alone', () => {
    const p = planSync({ title: 'New', producer: 'P' }, { title: 'Old', keywords: 'k', producer: 'P' }, 'infoToXmp');
    expect(p.xmp).toEqual({ title: 'New', keywords: null });
    expect(p.changed).toEqual(['title', 'keywords']);
    expect(p.info).toEqual({});
  });

  it('splits /Author into dc:creator and compares the joined form', () => {
    expect(planSync({ author: 'A, B' }, { author: 'A, B' }, 'infoToXmp').changed).toEqual([]);
    expect(planSync({ author: 'A,B' }, {}, 'infoToXmp').xmp).toEqual({ authors: ['A', 'B'] });
    // An /Author of only separators is no author at all.
    expect(planSync({ author: ' , ' }, {}, 'infoToXmp').changed).toEqual([]);
  });

  it('converts a date and treats one instant spelled two ways as agreement', () => {
    expect(planSync({ creationDate: "D:20240603123045+00'00'" },
      { creationDate: '2024-06-03T12:30:45.000Z' }, 'infoToXmp').changed).toEqual([]);
    expect(planSync({ modDate: "D:20240603123045+02'00'" }, {}, 'infoToXmp').xmp)
      .toEqual({ modifyDate: '2024-06-03T12:30:45+02:00' });
  });

  it('skips an unreadable source date and leaves the target alone', () => {
    const p = planSync({ creationDate: 'last Tuesday' }, { creationDate: '2024-06-03' }, 'infoToXmp');
    expect(p.skipped).toEqual(['creationDate']);
    expect(p.changed).toEqual([]);
    expect(p.xmp).toEqual({});
  });

  it('lists fields in table order', () => {
    const p = planSync({ modDate: 'D:2024', title: 'T', creator: 'C' }, {}, 'infoToXmp');
    expect(p.changed).toEqual(['title', 'creator', 'modDate']);
  });
});

describe('planSync xmpToInfo', () => {
  it('mirrors every field kind into /Info syntax', () => {
    const p = planSync({ subject: 'gone' },
      { title: 'T', author: 'A, B', creationDate: '2024-06-03T12:30:45-05:30' }, 'xmpToInfo');
    expect(p.info).toEqual({ title: 'T', author: 'A, B', subject: null,
      creationDate: "D:20240603123045-05'30'" });
    expect(p.xmp).toEqual({});
  });

  it('compares dates by instant against an /Info D: string', () => {
    expect(planSync({ modDate: 'D:20240603143045+02\'00\'' }, { modDate: '2024-06-03T12:30:45Z' },
      'xmpToInfo').changed).toEqual([]);
  });
});

describe('infoSide', () => {
  it('decodes string entries and ignores everything else', () => {
    const info: PdfDict = new Map<string, PdfObject>([
      ['Title', { kind: 'string', bytes: encodePdfText('Tïtle') }],
      ['Author', 42],
      ['CreationDate', { kind: 'string', bytes: encodePdfText('D:2024') }],
    ]);
    expect(infoSide(info, (o) => o ?? null)).toEqual({ title: 'Tïtle', creationDate: 'D:2024' });
    expect(infoSide(undefined, (o) => o ?? null)).toEqual({});
  });
});

describe('xmpSide', () => {
  it('reads raw text from the model: x-default, joined creators, dates as written', () => {
    const side = xmpSide(packet(
      '<dc:title><rdf:Alt><rdf:li xml:lang="de">Titel</rdf:li><rdf:li xml:lang="x-default">Title</rdf:li></rdf:Alt></dc:title>'
      + '<dc:creator><rdf:Seq><rdf:li>A</rdf:li><rdf:li>B</rdf:li></rdf:Seq></dc:creator>'
      + '<dc:description><rdf:Alt><rdf:li xml:lang="en">Only</rdf:li></rdf:Alt></dc:description>'
      + '<xmp:CreateDate>2024-06-03T12:30:45+02:00</xmp:CreateDate><pdf:Producer>P</pdf:Producer>'), LoadLimits.defaults);
    expect(side).toEqual({ title: 'Title', author: 'A, B', subject: 'Only',
      creationDate: '2024-06-03T12:30:45+02:00', producer: 'P' });
  });

  it('falls back to readXmp for a packet that will not parse, rather than reading nothing', () => {
    // Unclosed element: parseRdfPacket throws, readXmp's scan still finds the title.
    const bad = new TextEncoder().encode(
      '<rdf:RDF><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Kept</rdf:li></rdf:Alt></dc:title><oops>');
    expect(xmpSide(bad, LoadLimits.defaults).title).toBe('Kept');
  });

  it('is empty with no packet', () => {
    expect(xmpSide(undefined, LoadLimits.defaults)).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/metasync.test.ts`
Expected: FAIL — cannot resolve `../src/metasync.js`.

- [ ] **Step 3: Implement**

```ts
// src/metasync.ts
import { isString, type PdfDict, type PdfObject } from './types.js';
import { decodePdfText, type MetadataUpdate } from './metadata.js';
import { NS, readXmp, splitAuthors, type XmpUpdate } from './xmp.js';
import { parseRdfPacket, type RdfValue } from './xmprdf.js';
import { pdfDateToIso, isoToPdfDate, sameInstant } from './pdfdate.js';
import { rethrowLimit } from './errors.js';
import type { LoadLimits } from './loadlimits.js';

/** `/Info` ↔ XMP synchronisation (`o6uu.4`): read both sides as RAW TEXT and
 *  plan the smallest update that makes the target agree with the source.
 *
 *  Pure — no `Document`: the two sides arrive as `SideText` records, so every
 *  comparison rule is drivable from plain strings. Raw text rather than
 *  `GetMetadata()`, whose dates are JS `Date`s that have lost their offset.
 *  The sync is an EXACT MIRROR: a field absent on the source is deleted on
 *  the target. The one exception is a source DATE that does not read — the
 *  target is left alone and the field reported in `skipped`, since deleting a
 *  good date or copying garbage are both worse. */

export type MetadataField =
  'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer' | 'creationDate' | 'modDate';
export type SyncDirection = 'infoToXmp' | 'xmpToInfo';
export interface MetadataSyncReport { changed: MetadataField[]; skipped: MetadataField[] }
export type SideText = Partial<Record<MetadataField, string>>;
export interface SyncPlan extends MetadataSyncReport { info: MetadataUpdate; xmp: XmpUpdate }

type Kind = 'text' | 'author' | 'date';
/** Field, /Info key, XmpUpdate key, XMP (ns, name), kind — in report order. */
const MAP: readonly (readonly [MetadataField, string, keyof XmpUpdate, string, string, Kind])[] = [
  ['title', 'Title', 'title', NS.dc, 'title', 'text'],
  ['author', 'Author', 'authors', NS.dc, 'creator', 'author'],
  ['subject', 'Subject', 'description', NS.dc, 'description', 'text'],
  ['keywords', 'Keywords', 'keywords', NS.pdf, 'Keywords', 'text'],
  ['creator', 'Creator', 'creatorTool', NS.xmp, 'CreatorTool', 'text'],
  ['producer', 'Producer', 'producer', NS.pdf, 'Producer', 'text'],
  ['creationDate', 'CreationDate', 'createDate', NS.xmp, 'CreateDate', 'date'],
  ['modDate', 'ModDate', 'modifyDate', NS.xmp, 'ModifyDate', 'date'],
];

/** The eight /Info entries as decoded text; a non-string entry says nothing. */
export function infoSide(info: PdfDict | undefined, resolve: (o: PdfObject | undefined) => PdfObject): SideText {
  const out: SideText = {};
  if (!info) return out;
  for (const [field, key] of MAP) {
    const v = resolve(info.get(key));
    if (isString(v)) out[field] = decodePdfText(v.bytes);
  }
  return out;
}

const simpleText = (v: RdfValue): string | undefined => (v.kind === 'simple' ? v.value : undefined);

/** An Alt's `x-default` item, else its first — `readXmp`'s own reading, so
 *  the sync and `GetXmp` agree about what the title is. */
function altText(v: RdfValue): string | undefined {
  if (v.kind === 'simple') return v.value;
  if (v.kind !== 'array' || v.items.length === 0) return undefined;
  const item = v.items.find((i) => i.lang?.toLowerCase() === 'x-default') ?? v.items[0];
  return simpleText(item.value);
}

function creatorText(v: RdfValue): string | undefined {
  if (v.kind === 'simple') return v.value;
  if (v.kind !== 'array') return undefined;
  const names = v.items.map((i) => simpleText(i.value)).filter((s): s is string => s !== undefined);
  return names.length > 0 ? names.join(', ') : undefined;
}

/** The eight XMP properties as raw text. A packet that will not parse falls
 *  back to `readXmp`'s scan — exactly what `SetXmp` edits from in that case
 *  — so an unparseable packet never reads as an EMPTY one, which an exact
 *  mirror would then copy over /Info as eight deletions. */
export function xmpSide(bytes: Uint8Array | undefined, limits: LoadLimits): SideText {
  const out: SideText = {};
  if (bytes === undefined) return out;
  try {
    const props = parseRdfPacket(bytes, limits).properties;
    for (const [field, , , ns, name, kind] of MAP) {
      const p = props.find((q) => q.ns === ns && q.name === name);
      if (!p) continue;
      const text = kind === 'author' ? creatorText(p.value)
        : field === 'title' || field === 'subject' ? altText(p.value) : simpleText(p.value);
      if (text !== undefined) out[field] = text;
    }
    return out;
  } catch (e) {
    rethrowLimit(e);
    const m = readXmp(bytes);
    const date = (d: Date | string | undefined) => (d instanceof Date ? d.toISOString() : d);
    const fallback: SideText = {
      title: m.title, author: m.authors?.join(', '), subject: m.description, keywords: m.keywords,
      creator: m.creatorTool, producer: m.producer, creationDate: date(m.createDate), modDate: date(m.modifyDate),
    };
    for (const [k, v] of Object.entries(fallback)) if (v !== undefined) out[k as MetadataField] = v;
    return out;
  }
}

/** The update that makes the target side agree with the source side. */
export function planSync(info: SideText, xmp: SideText, direction: SyncDirection): SyncPlan {
  const plan: SyncPlan = { changed: [], skipped: [], info: {}, xmp: {} };
  const toXmp = direction === 'infoToXmp';
  const write = (field: MetadataField, xkey: keyof XmpUpdate, v: string | string[] | null) => {
    plan.changed.push(field);
    if (toXmp) (plan.xmp as Record<string, unknown>)[xkey] = v;
    else (plan.info as Record<string, unknown>)[field] = v;
  };
  for (const [field, , xkey, , , kind] of MAP) {
    let src = toXmp ? info[field] : xmp[field];
    const tgt = toXmp ? xmp[field] : info[field];
    // An /Author of nothing but separators names no author.
    if (toXmp && kind === 'author' && src !== undefined && splitAuthors(src).length === 0) src = undefined;
    if (src === undefined) {
      if (tgt !== undefined) write(field, xkey, null);
      continue;
    }
    if (kind === 'date') {
      const want = toXmp ? pdfDateToIso(src) : isoToPdfDate(src);
      if (want === undefined) { plan.skipped.push(field); continue; }
      const srcIso = toXmp ? want : src;
      const tgtIso = tgt === undefined ? undefined : toXmp ? tgt : pdfDateToIso(tgt);
      if (tgtIso !== undefined && sameInstant(srcIso, tgtIso)) continue;
      write(field, xkey, want);
    } else if (kind === 'author' && toXmp) {
      const list = splitAuthors(src);
      if (tgt === list.join(', ')) continue;
      write(field, xkey, list);
    } else {
      if (tgt === src) continue;
      write(field, xkey, src);
    }
  }
  return plan;
}
```

If `readXmp`'s scan does NOT recover `Kept` from the malformed packet in the fallback test (its regexes need `dc:title` with an `rdf:li xml:lang="x-default"`), adjust only the fixture — keep the assertion that the fallback returns a non-empty side.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/metasync.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/metasync.ts test/metasync.test.ts
git commit -m "feat(o6uu.4): plan an /Info <-> XMP sync from raw text on both sides"
```

---

### Task 5: `doc.SyncMetadata`

**Files:**
- Modify: `src/document.ts` (add `SyncMetadata`), `src/index.ts`, `README.md`, `CHANGELOG.md`
- Test: `test/metadata-sync.test.ts`

**Interfaces:**
- Consumes: `planSync`, `infoSide`, `xmpSide`, `MetadataSyncReport`, `SyncDirection` (Task 4); existing private `installXmp`, `currentInfo`, `ensureInfo`, `applyUpdate`.
- Produces: `Document.SyncMetadata(direction: SyncDirection): MetadataSyncReport`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/metadata-sync.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { encodePdfText } from '../src/metadata.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { RDF_NS } from '../src/xmprdf.js';
import { buildSigner } from './helpers/build-signer.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const doc1 = () => { const d = Document.New(); d.AddPage(PageFormat.A4); return d; };
/** Write an /Info entry behind the mirror, so the two sides disagree. */
const setInfo = (d: Document, key: string, v: string) =>
  d.ensureInfo().set(key, { kind: 'string', bytes: encodePdfText(v) });

describe('SyncMetadata infoToXmp', () => {
  it('makes XMP agree with /Info, deleting what /Info lacks', () => {
    const d = doc1();
    d.SetXmp({ title: 'Old', keywords: 'k' });
    setInfo(d, 'Title', 'New');
    d.ensureInfo().delete('Keywords');
    setInfo(d, 'CreationDate', "D:20240603123045+02'00'");
    const r = d.SyncMetadata('infoToXmp');
    expect(r).toEqual({ changed: ['title', 'keywords', 'creationDate'], skipped: [] });
    const x = d.GetXmp();
    expect(x.title).toBe('New');
    expect(x.keywords).toBeUndefined();
    expect(d.GetXmpValue(XMP, 'CreateDate')!.asText()).toBe('2024-06-03T12:30:45+02:00');
  });

  it('replaces only the x-default title and keeps translations and foreign schemas', () => {
    const d = doc1();
    // Seeded raw so the translation is real — SetXmp writes x-default only.
    const text = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${RDF_NS}"><rdf:Description rdf:about=""`
      + ` xmlns:dc="${DC}" xmlns:acme="http://acme.example/ns/1.0/"><dc:title><rdf:Alt>`
      + '<rdf:li xml:lang="x-default">Old</rdf:li><rdf:li xml:lang="de-DE">Alt</rdf:li></rdf:Alt></dc:title>'
      + '<acme:Batch>B1</acme:Batch></rdf:Description></rdf:RDF></x:xmpmeta>';
    const dict: PdfDict = new Map<string, PdfObject>([['Type', name('Metadata')], ['Subtype', name('XML')]]);
    d.catalog().set('Metadata', d.allocObject({ kind: 'stream', dict, raw: new TextEncoder().encode(text) }));
    setInfo(d, 'Title', 'New');
    expect(d.SyncMetadata('infoToXmp').changed).toEqual(['title']);
    expect(d.GetXmpValue(DC, 'title')!.asText()).toBe('New');
    expect(d.GetXmpValue(DC, 'title')!.asText('de')).toBe('Alt');
    expect(d.GetXmpValue('http://acme.example/ns/1.0/', 'Batch')!.asText()).toBe('B1');
  });

  it('never creates /Info', () => {
    const d = doc1();
    d.SetXmp({ title: 'T' });
    d.trailer.delete('Info');
    const r = d.SyncMetadata('infoToXmp');
    expect(r.changed).toEqual(['title']);
    expect(d.trailer.has('Info')).toBe(false);
  });

  it('reports an unreadable /Info date as skipped and leaves XMP alone', () => {
    const d = doc1();
    d.SetXmp({ createDate: '2024-06-03' });
    setInfo(d, 'CreationDate', 'yesterday');
    expect(d.SyncMetadata('infoToXmp').skipped).toEqual(['creationDate']);
    expect(d.GetXmpValue(XMP, 'CreateDate')!.asText()).toBe('2024-06-03');
  });
});

describe('SyncMetadata xmpToInfo', () => {
  it('makes /Info agree with XMP, converting dates', () => {
    const d = doc1();
    d.SetXmp({ modifyDate: '2024-06-03T12:30:45-05:30' });
    setInfo(d, 'Subject', 'stale');            // /Info only: XMP has no dc:description
    setInfo(d, 'ModDate', 'D:1999');
    const r = d.SyncMetadata('xmpToInfo');
    expect(r.changed).toEqual(['subject', 'modDate']);
    const m = d.GetMetadata();
    expect(m.subject).toBeUndefined();
    expect(m.modDate).toEqual(new Date(Date.UTC(2024, 5, 3, 18, 0, 45)));
  });

  it('does not create /Info when XMP has nothing to write', () => {
    const d = doc1();
    expect(d.SyncMetadata('xmpToInfo')).toEqual({ changed: [], skipped: [] });
    expect(d.trailer.has('Info')).toBe(false);
  });
});

describe('SyncMetadata no-op', () => {
  it('writes nothing and marks nothing when our own SetMetadata output already agrees', async () => {
    // SetMetadata(Date) writes D:…+00'00' into /Info and …T…:….000Z into XMP:
    // one instant spelled two ways. A sync must see agreement — and must not
    // markModified(), or a later Sign() silently turns into a full rewrite.
    // A save alone cannot see that, so the fixture signs and checks the base
    // survives as a byte-identical prefix.
    const d0 = doc1();
    d0.SetMetadata({ title: 'T', author: 'A, B', creationDate: new Date(Date.UTC(2024, 5, 3, 12, 30, 45)) });
    const base = d0.Save();
    for (const dir of ['infoToXmp', 'xmpToInfo'] as const) {
      const d = Document.Open(base);
      expect(d.SyncMetadata(dir)).toEqual({ changed: [], skipped: [] });
      const s = buildSigner();
      await d.Sign({ certificate: s.certificate, privateKey: s.privateKey }, {});
      expect(d.Save().subarray(0, base.length)).toEqual(base);
    }
  });

  it('refuses an unknown direction before doing anything', () => {
    const d = doc1();
    expect(() => d.SyncMetadata('both' as never)).toThrow(RangeError);
  });
});

describe('SyncMetadata and PDF/A', () => {
  it('clears XmpInfoConsistency after /Info is edited behind the mirror', () => {
    const d = doc1();
    d.ConvertToPdfA('2b');
    d.SetMetadata({ title: 'Report' });
    setInfo(d, 'Title', 'Changed');
    const rule = (x: ReturnType<Document['ValidatePdfA']>) => x.Issues.map((i) => i.rule);
    expect(rule(d.ValidatePdfA('2b'))).toContain('XmpInfoConsistency');
    d.SyncMetadata('infoToXmp');
    expect(rule(d.ValidatePdfA('2b'))).not.toContain('XmpInfoConsistency');
  });
});
```

`d.trailer` is a public field (tests such as `test/docmdp-verify.test.ts` already read it), so the `/Info`-absence assertions use it directly.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/metadata-sync.test.ts`
Expected: FAIL — `d.SyncMetadata is not a function`.

- [ ] **Step 3: Implement**

In `src/document.ts`:
- Add import: `import { planSync, infoSide, xmpSide, type MetadataSyncReport, type SyncDirection } from './metasync.js';`
- Directly after `SetXmp(...)` (~line 1760), add:

```ts
  /** Make /Info and the XMP packet agree on the eight fields they share
   *  (`o6uu.4`): `'infoToXmp'` rewrites XMP from /Info, `'xmpToInfo'` the
   *  reverse. An exact mirror — a field the source lacks is deleted on the
   *  target — with dates converted between `D:` and ISO 8601 text, offset
   *  intact. Only differing fields are written; when the sides already agree
   *  nothing is touched and the document is NOT marked modified, so a later
   *  `Sign()` keeps its incremental path. `'infoToXmp'` never creates /Info
   *  and edits the packet in place, so foreign schemas survive. A source date
   *  that does not read leaves its target alone and is named in `skipped`. */
  SyncMetadata(direction: SyncDirection): MetadataSyncReport {
    if (direction !== 'infoToXmp' && direction !== 'xmpToInfo') {
      throw new RangeError(`SyncMetadata: direction must be 'infoToXmp' or 'xmpToInfo', got ${String(direction)}`);
    }
    const md = this.resolve(this.catalog().get('Metadata'));
    const plan = planSync(
      infoSide(this.currentInfo(), (o) => this.resolve(o)),
      xmpSide(isStream(md) ? inflateStream(md) : undefined, this.loadLimits),
      direction,
    );
    if (plan.changed.length > 0) {
      if (direction === 'infoToXmp') this.installXmp(plan.xmp);
      else applyUpdate(this.ensureInfo(), plan.info);
    }
    return { changed: plan.changed, skipped: plan.skipped };
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/metadata-sync.test.ts`
Expected: PASS. If the PDF/A case finds `XmpInfoConsistency` absent BEFORE the sync, the `setInfo` edit did not diverge the sides — check `d.GetMetadata().title` is `'Changed'` and `d.GetXmp().title` is `'Report'`.

- [ ] **Step 5: Export and document**

In `src/index.ts`, next to the `XmpValue` export from Task 3:

```ts
export type { MetadataField, MetadataSyncReport, SyncDirection } from './metasync.js';
```

In `README.md`:
- API Reference, directly after the `doc.GetXmpValue` row:

```markdown
| `doc.SyncMetadata(direction)` | Make `/Info` and XMP agree on the eight shared fields (`'infoToXmp'` / `'xmpToInfo'`), converting dates; returns `MetadataSyncReport` |
```

- Types table, beside the `XmpValue` row (keep each row in the alphabetical run it lands in — `MetadataField`/`MetadataSyncReport` go after the `Metadata`/`MetadataUpdate` rows if present, `grep -n "^| \`Metadata" README.md`; `SyncDirection` beside other `S…` rows in the same run):

```markdown
| `MetadataField` | One of the eight fields `/Info` and XMP share: `'title' \| 'author' \| 'subject' \| 'keywords' \| 'creator' \| 'producer' \| 'creationDate' \| 'modDate'`. |
| `MetadataSyncReport` | What `SyncMetadata` did: `changed` (fields written or deleted on the target) and `skipped` (source dates that did not read), both in field order. |
| `SyncDirection` | `'infoToXmp' \| 'xmpToInfo'` — which side `SyncMetadata` treats as the source. |
```

- In the XMP section, after the `GetXmpValue` example added in Task 3:

````markdown
`/Info` and XMP drift apart when one is edited without the other — by another
tool, or through `ensureInfo()`. `SyncMetadata` makes them agree again:

```ts
const report = doc.SyncMetadata('infoToXmp'); // or 'xmpToInfo'
console.log(report.changed, report.skipped);
```

It is an exact mirror over title, author, subject, keywords, creator (tool),
producer and the two dates: a field the source lacks is deleted on the target.
Dates are converted text to text (`D:20240603123045+02'00'` ↔
`2024-06-03T12:30:45+02:00`), keeping precision and offset, and one instant
spelled two ways counts as agreement. Only the `x-default` title and
description are written, so translations survive. A source date that does not
read is left alone and reported in `skipped`. When nothing differs the
document is left untouched, so a later `Sign()` still appends incrementally.
````

Run: `npx vitest run test/readme-api.test.ts` — update the intro count sentence to the compiler's numbers if it fails, re-run until PASS.

- [ ] **Step 6: CHANGELOG**

Under `### Added`, directly above the typed-reads entry from Task 3:

```markdown
- **`doc.SyncMetadata(direction)` makes `/Info` and XMP agree.** The two
  drift whenever one is edited without the other, and PDF/A-1 reports the
  disagreement as an error. `'infoToXmp'` or `'xmpToInfo'` names the source;
  the sync is an exact mirror over the eight shared fields, deleting on the
  target what the source lacks. Both sides are read as raw text rather than
  through `GetMetadata()`, whose `Date` loses the offset, so dates convert
  `D:` ↔ ISO 8601 with precision and offset intact and a `D:…+00'00'` beside
  a `….000Z` of the same instant counts as agreement — which is what our own
  `SetMetadata(Date)` writes. Only differing fields are written and a no-op
  sync marks nothing modified, so a later `Sign()` stays an incremental
  append; `'infoToXmp'` edits the packet in place, keeping foreign schemas and
  title translations, and never creates `/Info` (o6uu.4).
```

- [ ] **Step 7: Commit**

```bash
git add src/document.ts src/index.ts test/metadata-sync.test.ts README.md CHANGELOG.md
git commit -m "feat(o6uu.4): doc.SyncMetadata mirrors /Info and XMP in either direction"
```

---

### Task 6: CLAUDE.md entries, mutation pass, full suite, close

**Files:**
- Modify: `CLAUDE.md` (Source list)

- [ ] **Step 1: Mutation pass**

For each mutation, apply it, run the named test file, confirm it goes RED, then `git checkout -- <file>`. Verify each mutation actually applied (`git diff --stat`) before trusting a green result. Record the result (red count, or GREEN) for Step 2.

| # | File | Mutation | Test file |
|---|---|---|---|
| 1 | `src/pdfdate.ts` | in `valid`, delete the `p.tz && p.h === undefined` line | `test/pdfdate.test.ts` |
| 2 | `src/pdfdate.ts` | in `isoInstant`, delete `d.setUTCFullYear(+p.y);` and use `Date.UTC(+p.y, …)` | `test/pdfdate.test.ts` |
| 3 | `src/pdfdate.ts` | in `sameInstant`, compare raw ms instead of `Math.floor(… / 1000)` | `test/pdfdate.test.ts`, `test/metadata-sync.test.ts` |
| 4 | `src/pdfdate.ts` | in `isoToPdfDate`, emit offset as `${sign}${h}${m}` (no apostrophes) | `test/pdfdate.test.ts` |
| 5 | `src/xmp.ts` | `toIsoDate` returns `v` unchanged | `test/xmp-mirror-dates.test.ts` |
| 6 | `src/xmpvalue.ts` | `asText` drop the exact-tag pass | `test/xmpvalue.test.ts` |
| 7 | `src/xmpvalue.ts` | `asReal` use `Number(t)` with no regex | `test/xmpvalue.test.ts` |
| 8 | `src/metasync.ts` | `planSync`: when `src === undefined`, `continue` without writing null | `test/metasync.test.ts` |
| 9 | `src/metasync.ts` | date branch: compare `tgt === want` instead of `sameInstant` | `test/metadata-sync.test.ts` (no-op sign case) |
| 10 | `src/metasync.ts` | `xmpSide` catch returns `{}` instead of the `readXmp` fallback | `test/metasync.test.ts` |
| 11 | `src/metasync.ts` | `altText` returns `items[0]` always | `test/metasync.test.ts` |
| 12 | `src/document.ts` | `SyncMetadata` calls `installXmp`/`applyUpdate` even when `changed` is empty | `test/metadata-sync.test.ts` |
| 13 | `src/document.ts` | `SyncMetadata` `xmpToInfo` path uses `this.ensureInfo()` unconditionally before planning | `test/metadata-sync.test.ts` |

A mutation that stays GREEN is either a real coverage gap (add a test that reddens it) or a redundant defence (record it as such in Step 2 — do not delete the code).

- [ ] **Step 2: CLAUDE.md**

Add to the Source list, directly after the `**xmprdf.ts**` entry:

```markdown
- **pdfdate.ts** — `D:` dates (32000-1 7.9.4) and XMP dates (W3C-DTF ISO 8601)
  converted TEXT TO TEXT (`o6uu.4`): `pdfDateToIso`, `isoToPdfDate`,
  `isoInstant`, `sameInstant`. A leaf importing nothing; never throws.
  **Invariant:** nothing here passes through a JS `Date` on the way from one
  syntax to the other. A `Date` keeps the instant and drops the offset it was
  written in, and `readMetadata` already hands one back — which is why the
  sync reads raw text rather than `GetMetadata()`. D→ISO→D is byte-exact for
  every full-form `D:` string; the two lossy steps are STATED — an hour with
  no minutes gains `:00` (ISO requires minutes), and ISO fractional seconds are
  dropped (PDF has no field for them).
  **Invariant:** `sameInstant` compares to the SECOND. Our own
  `SetMetadata(Date)` writes `D:…+00'00'` into /Info and `….000Z` into XMP;
  compared as text, or to the millisecond, every sync of our own output would
  rewrite it.
  **Note:** `isoInstant` builds from `Date.UTC(2000, …)` and then
  `setUTCFullYear`, because `Date.UTC` maps years 0–99 onto the 1900s.
- **metasync.ts** — `/Info` ↔ XMP synchronisation (`o6uu.4`), behind
  `doc.SyncMetadata`. Pure: `infoSide` and `xmpSide` read each side as raw
  text, `planSync` decides the update, and `document.ts` alone applies it.
  **Invariant:** an EXACT MIRROR — a field absent on the source is deleted on
  the target — except a source date that does not read, which leaves the
  target alone and is reported in `skipped`.
  **Invariant:** an XMP packet that will not parse falls back to `readXmp`'s
  scan, never to an empty side. Read as empty, an exact mirror copies it over
  /Info as eight deletions.
  **Invariant:** only differing fields are written and a no-op sync calls
  nothing that marks the document modified — pinned through the SIGN path in
  `test/metadata-sync.test.ts`, since a save alone cannot see a spurious
  modified flag (`pagemode.ts`'s trap). `'infoToXmp'` never creates /Info.
  **Note:** the title and description are read as the `x-default` item, else
  the first — `readXmp`'s reading, so the sync and `GetXmp` (and hence the
  PDF/A consistency rule) agree about what the title is — and written to
  `x-default` alone, so translations survive.
  **Note:** it depends on `xmp.ts` exporting `NS` and `splitAuthors`; one
  namespace table and one author split, not two.
- **xmpvalue.ts** — `XmpValue`, a read-only typed view over one `RdfValue`
  (`o6uu.4`), behind `doc.GetXmpValue`. A leaf over `xmprdf.ts` types,
  `langmatch.ts` and `pdfdate.ts`.
  **Invariant:** every converter answers `undefined` rather than throwing.
  `asInt`/`asReal` are strict grammars (no `"12abc"`, no exponent, no
  `NaN`/`Infinity`) and `asBool` reads XMP's `True`/`False` only.
  **Invariant:** `asText(lang)` picks from an Alt by exact tag, then RFC 4647
  range through `langMatches`, then `x-default`, then the first item — exact
  first, because `en` as a range also matches an earlier `en-GB`.
  **Note:** writing (`SetXmpValue`) is `o6uu.8`.
```

Append to each entry a `**Note, measured:**` line summarising Step 1's results for that module (e.g. "all N mutations redden" or naming a green one and why).

- [ ] **Step 3: Full verification**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: all files pass. If `test/limits-catch.test.ts` fails, a new `catch` lacks `rethrowLimit(e)` as its first statement — fix it. If `test/import-cycles.test.ts` fails, a new value import closed a 2-cycle — `metasync.ts` → `xmp.ts` is one-way and must stay so.

- [ ] **Step 4: Commit, close, push**

```bash
git add CLAUDE.md
git commit -m "docs(o6uu.4): record pdfdate, metasync and xmpvalue invariants"
bd close aspose-pdf-foss-for-ts-o6uu.4
git pull --rebase
git push
git status
```
Expected: `git status` reports "up to date with origin".
