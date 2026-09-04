# ICC Profile Container (`85l8.7.1`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read an ICC profile's header, tag table, `XYZ ` tags and `curv` tags, as the foundation `85l8.7.2`'s CMYK transform is built on.

**Architecture:** One pure leaf, `src/icc.ts`, importing only `./errors.js`. Bytes in, structure out. It knows nothing of transforms, colour conversion, PDF objects or `Document`. Every rule is verified against the sRGB profile already vendored in `src/srgb.ts`, so this task needs no new fixture, no generator and no oracle.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-04-icc-cmyk-transform-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only; `src/icc.ts` imports nothing but `./errors.js`.
- **ESM + NodeNext:** every import specifier carries the `.js` extension.
- **Errors:** throw `PdfParseError` (from `./errors.js`) for a malformed profile. Do not invent a new error class. `UnsupportedFeatureError` is reserved for `85l8.7.2`'s v4 decline.
- **Pure leaf:** no `Document`, no `Page`, no PDF object module, no `node:` import in `src/icc.ts`.
- **All integers are big-endian.** ICC is a big-endian format throughout.
- **A parser reports what the file says.** It never corrects a value it thinks is wrong. (The vendored sRGB profile's `wtpt` is D65 where the ICC spec would want D50; that is the file's business, not the parser's.)
- Run `npm run typecheck` and `npx vitest run test/icc.test.ts` before each commit; both must be green.
- Do **not** add an entry to `CHANGELOG.md`: nothing here is reachable from `src/index.ts` yet, so no user-visible change ships. `85l8.7.2` logs the feature.

---

### Task 1: Profile header

**Files:**
- Create: `src/icc.ts`
- Test: `test/icc.test.ts`

**Interfaces:**
- Consumes: `PdfParseError` from `src/errors.ts`; `srgbIcc()` from `src/srgb.ts` (test only).
- Produces:
  ```ts
  export interface IccVersion { major: number; minor: number; bugfix: number }
  export interface IccHeader {
    size: number;            // the profile's own size field, bytes
    cmm: string;             // 4 chars, e.g. 'Lino'
    version: IccVersion;
    deviceClass: string;     // 'mntr', 'prtr', 'scnr', ...
    dataColorSpace: string;  // 'RGB ', 'CMYK', ... — always 4 chars, space padded
    pcs: string;             // 'XYZ ' or 'Lab '
    platform: string;        // 'MSFT', 'APPL', ...
    renderingIntent: number; // 0 perceptual, 1 relative, 2 saturation, 3 absolute
  }
  export interface IccProfile { header: IccHeader; tags: readonly IccTag[]; bytes: Uint8Array }
  export function parseIccProfile(bytes: Uint8Array): IccProfile
  ```
  (`IccTag` arrives in Task 2. For this task `tags` may be built as an empty array.)

- [ ] **Step 1: Write the failing test**

Create `test/icc.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseIccProfile } from '../src/icc.js';
import { srgbIcc } from '../src/srgb.js';
import { PdfParseError } from '../src/errors.js';

/**
 * The ICC profile container (85l8.7.1).
 *
 * Verified against the sRGB profile already vendored in `srgb.ts` — the HP/
 * Microsoft IEC 61966-2.1 profile, freely distributable, 3144 bytes. No new
 * fixture, no generator and no oracle are needed for this half, which is why
 * it is worth landing on its own.
 */
describe('parseIccProfile — header', () => {
  const p = parseIccProfile(srgbIcc());

  it('reads the four-character signature fields', () => {
    expect(p.header.cmm).toBe('Lino');
    expect(p.header.deviceClass).toBe('mntr');
    expect(p.header.dataColorSpace).toBe('RGB ');
    expect(p.header.pcs).toBe('XYZ ');
    expect(p.header.platform).toBe('MSFT');
  });

  // Space-padded to four characters, never trimmed: 'RGB ' and 'Lab ' are
  // four-byte signatures and a trimmed one would not compare equal to the
  // constants 85l8.7.2 matches on.
  it('keeps the trailing space of a padded signature', () => {
    expect(p.header.dataColorSpace).toHaveLength(4);
    expect(p.header.pcs).toHaveLength(4);
  });

  // Byte 8 is major; byte 9 packs minor in its high nibble and bugfix in its
  // low one. Reading byte 9 raw gives 16 for this profile rather than 1.0.
  it('unpacks the version nibbles', () => {
    expect(p.header.version).toEqual({ major: 2, minor: 1, bugfix: 0 });
  });

  it('reads the declared size and the rendering intent', () => {
    expect(p.header.size).toBe(3144);
    expect(p.header.renderingIntent).toBe(0);
  });

  it('keeps the bytes it was given, for the tag readers', () => {
    expect(p.bytes.length).toBe(3144);
  });
});

describe('parseIccProfile — refusals', () => {
  it('refuses a buffer too short to hold a header', () => {
    expect(() => parseIccProfile(new Uint8Array(127))).toThrow(PdfParseError);
  });

  // The 'acsp' signature at byte 36 is what makes a buffer an ICC profile at
  // all. Without this check any 128 bytes parse into a confident header of
  // nonsense.
  it('refuses a buffer whose acsp signature is absent', () => {
    const bad = srgbIcc();
    bad[36] = 0x78;
    expect(() => parseIccProfile(bad)).toThrow(/acsp/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icc.test.ts`
Expected: FAIL — `Failed to resolve import "../src/icc.js"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/icc.ts`:

```ts
import { PdfParseError } from './errors.js';

/**
 * The ICC profile container: header and tag table (85l8.7.1).
 *
 * A pure leaf importing nothing but `errors.js` — bytes in, structure out. It
 * knows nothing of transforms, colour conversion or PDF: `icclut.ts` builds
 * the pipeline elements on top of it and `icctransform.ts` composes them.
 *
 * Every integer here is BIG-endian; ICC is a big-endian format throughout.
 *
 * A parser reports what the file says and never corrects it. The sRGB profile
 * this is verified against declares a D65 media white point where the ICC
 * spec would want D50 — a known quirk of that particular file, and none of
 * this module's business.
 */

/** The `major.minor.bugfix` a profile declares. */
export interface IccVersion { major: number; minor: number; bugfix: number }

export interface IccHeader {
  /** The profile's own size field, in bytes. */
  size: number;
  /** Preferred CMM, four characters, e.g. `'Lino'`. */
  cmm: string;
  version: IccVersion;
  /** `'mntr'`, `'prtr'`, `'scnr'`, … */
  deviceClass: string;
  /** `'RGB '`, `'CMYK'`, … — four characters, space padded and NOT trimmed. */
  dataColorSpace: string;
  /** `'XYZ '` or `'Lab '`. */
  pcs: string;
  /** `'MSFT'`, `'APPL'`, … */
  platform: string;
  /** 0 perceptual, 1 media-relative, 2 saturation, 3 ICC-absolute. */
  renderingIntent: number;
}

export interface IccProfile {
  header: IccHeader;
  tags: readonly IccTag[];
  /** The bytes the profile was parsed from; the tag readers index into these. */
  bytes: Uint8Array;
}

/** Placeholder until Task 2; the real shape lands there. */
export interface IccTag { signature: string; offset: number; size: number }

/** The ICC header is a fixed 128 bytes, and the tag count follows it. */
const HEADER_SIZE = 128;

const u32 = (b: Uint8Array, o: number): number =>
  ((b[o] as number) << 24 | (b[o + 1] as number) << 16
    | (b[o + 2] as number) << 8 | (b[o + 3] as number)) >>> 0;

/** Four bytes as characters, space padding INCLUDED — `'RGB '` is a signature,
 *  not a word, and trimming it would stop it comparing equal to the constants
 *  callers match on. */
const sig = (b: Uint8Array, o: number): string =>
  String.fromCharCode(b[o] as number, b[o + 1] as number,
    b[o + 2] as number, b[o + 3] as number);

export function parseIccProfile(bytes: Uint8Array): IccProfile {
  if (bytes.length < HEADER_SIZE) {
    throw new PdfParseError(
      `ICC profile is ${bytes.length} bytes, too short for a ${HEADER_SIZE}-byte header`);
  }
  // Byte 36 is what makes a buffer an ICC profile at all. Without this test
  // any 128 bytes yield a confident header of nonsense.
  const signature = sig(bytes, 36);
  if (signature !== 'acsp') {
    throw new PdfParseError(
      `ICC profile signature is ${JSON.stringify(signature)}, expected "acsp"`);
  }
  // Byte 9 packs minor in its high nibble and bugfix in its low one; read raw
  // it reports 16 where the profile says 1.0.
  const version: IccVersion = {
    major: bytes[8] as number,
    minor: ((bytes[9] as number) >> 4) & 0x0f,
    bugfix: (bytes[9] as number) & 0x0f,
  };
  const header: IccHeader = {
    size: u32(bytes, 0),
    cmm: sig(bytes, 4),
    version,
    deviceClass: sig(bytes, 12),
    dataColorSpace: sig(bytes, 16),
    pcs: sig(bytes, 20),
    platform: sig(bytes, 40),
    renderingIntent: u32(bytes, 64),
  };
  return { header, tags: [], bytes };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icc.test.ts`
Expected: PASS, 7 tests.

Then run: `npm run typecheck`
Expected: no output (clean).

- [ ] **Step 5: Commit**

```bash
git add src/icc.ts test/icc.test.ts
git commit -m "feat(85l8.7.1): read an ICC profile header

Verified against the sRGB profile vendored in srgb.ts, so this needs no new
fixture. The acsp signature check is what stops any 128 bytes parsing into a
confident header of nonsense, and byte 9 packs two nibbles -- read raw it
reports version 16 where the profile says 1.0.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Tag table

**Files:**
- Modify: `src/icc.ts`
- Test: `test/icc.test.ts`

**Interfaces:**
- Consumes: `parseIccProfile`, `IccProfile`, `IccTag` from Task 1.
- Produces:
  ```ts
  export interface IccTag {
    signature: string;  // 4 chars, e.g. 'rXYZ'
    offset: number;     // from the start of the profile
    size: number;       // bytes
  }
  export function iccTag(p: IccProfile, signature: string): IccTag | undefined
  ```
  `parseIccProfile` now populates `tags`.

- [ ] **Step 1: Write the failing test**

Append to `test/icc.test.ts`:

```ts
import { iccTag } from '../src/icc.js';

describe('parseIccProfile — tag table', () => {
  const p = parseIccProfile(srgbIcc());

  it('reads every tag the profile declares', () => {
    expect(p.tags).toHaveLength(17);
    expect(p.tags.map((t) => t.signature)).toContain('rXYZ');
    expect(p.tags.map((t) => t.signature)).toContain('rTRC');
  });

  it('records each tag offset and size', () => {
    expect(iccTag(p, 'rXYZ')).toEqual({ signature: 'rXYZ', offset: 536, size: 20 });
  });

  /**
   * The hazard this fixture happens to carry, and the reason to assert it.
   * `rTRC`, `gTRC` and `bTRC` all point at offset 1084 with the same length —
   * three tags SHARING one block of data, which ICC permits and real profiles
   * use to avoid storing an identical curve three times. A reader that assumed
   * tags partition the file, or that consumed bytes as it walked, would report
   * two of the three wrongly.
   */
  it('allows several tags to share one data block', () => {
    const r = iccTag(p, 'rTRC');
    const g = iccTag(p, 'gTRC');
    const b = iccTag(p, 'bTRC');
    expect(r).toEqual({ signature: 'rTRC', offset: 1084, size: 2060 });
    expect(g?.offset).toBe(r?.offset);
    expect(b?.offset).toBe(r?.offset);
  });

  it('returns undefined for a tag the profile does not carry', () => {
    expect(iccTag(p, 'B2A0')).toBeUndefined();
  });

  // The signature comes from the file, so the lookup must not consult
  // Object.prototype — the hazard `predefcmap.ts` already records for a name a
  // document chooses.
  it('does not find a tag named for an Object property', () => {
    expect(iccTag(p, 'constructor')).toBeUndefined();
  });
});

describe('parseIccProfile — tag table refusals', () => {
  it('refuses a tag count the buffer cannot hold', () => {
    const bad = srgbIcc();
    // Tag count lives at byte 128; 0xffff entries need far more than 3144 bytes.
    bad[128] = 0; bad[129] = 0; bad[130] = 0xff; bad[131] = 0xff;
    expect(() => parseIccProfile(bad)).toThrow(PdfParseError);
  });

  /**
   * A tag whose data runs past the end of the buffer. Left unchecked this is
   * not a wrong colour but an out-of-bounds read in every later tag reader, so
   * it is refused here, once, rather than guarded at each of them.
   */
  it('refuses a tag whose data leaves the buffer', () => {
    const bad = srgbIcc();
    // First tag entry sits at 132: signature, offset, size. Push its size past
    // the end of the profile.
    bad[140] = 0xff; bad[141] = 0xff; bad[142] = 0xff; bad[143] = 0xff;
    expect(() => parseIccProfile(bad)).toThrow(/out of bounds|leaves/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icc.test.ts`
Expected: FAIL — `iccTag` is not exported; the tag-table cases report `[]` where 17 tags were expected.

- [ ] **Step 3: Write the minimal implementation**

In `src/icc.ts`, replace the placeholder `IccTag` declaration with the real one and its lookup, and populate `tags` in `parseIccProfile`:

```ts
export interface IccTag {
  /** Four characters, e.g. `'rXYZ'`. */
  signature: string;
  /** Byte offset from the start of the profile. */
  offset: number;
  /** Size of the tag's data, in bytes. */
  size: number;
}

/**
 * The tag with this signature, or undefined.
 *
 * A linear scan over an array rather than a Map lookup, and that is
 * deliberate: the signature comes from a file, so a Map keyed by it would have
 * to be probed with `hasOwnProperty` to keep `/constructor` from finding
 * `Object.prototype.constructor` — the hazard `predefcmap.ts` records for a
 * CMap name a document chooses. Seventeen tags do not need an index.
 *
 * The FIRST match wins. ICC does not forbid a repeated signature, and a
 * profile carrying one is telling us something we cannot adjudicate; taking
 * the first is the same rule `xref.ts` applies to a duplicated entry.
 */
export function iccTag(p: IccProfile, signature: string): IccTag | undefined {
  return p.tags.find((t) => t.signature === signature);
}
```

Then, in `parseIccProfile`, replace `return { header, tags: [], bytes };` with:

```ts
  // The tag count sits immediately after the 128-byte header, and each entry
  // is 12 bytes: signature, offset, size.
  if (bytes.length < HEADER_SIZE + 4) {
    throw new PdfParseError('ICC profile has no tag count');
  }
  const count = u32(bytes, HEADER_SIZE);
  const tableEnd = HEADER_SIZE + 4 + count * 12;
  if (tableEnd > bytes.length) {
    throw new PdfParseError(
      `ICC profile declares ${count} tags, which need ${tableEnd} bytes of `
      + `${bytes.length}`);
  }
  const tags: IccTag[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER_SIZE + 4 + i * 12;
    const tag: IccTag = {
      signature: sig(bytes, o), offset: u32(bytes, o + 4), size: u32(bytes, o + 8),
    };
    // Checked ONCE, here, rather than in every tag reader: a tag running past
    // the buffer is not a wrong colour downstream but an out-of-bounds read.
    if (tag.offset + tag.size > bytes.length) {
      throw new PdfParseError(
        `ICC tag ${JSON.stringify(tag.signature)} is out of bounds: `
        + `${tag.offset}+${tag.size} exceeds ${bytes.length}`);
    }
    tags.push(tag);
  }
  return { header, tags, bytes };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icc.test.ts`
Expected: PASS, 14 tests.

Then run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/icc.ts test/icc.test.ts
git commit -m "feat(85l8.7.1): read an ICC tag table

Bounds are checked once here rather than in every tag reader: a tag running
past the buffer is not a wrong colour downstream but an out-of-bounds read.

Note the sRGB profile has rTRC, gTRC and bTRC all pointing at offset 1084 --
three tags sharing one data block, which ICC permits and which a reader that
assumed tags partition the file would get wrong for two of the three.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `XYZ ` tags, checked against a published constant

**Files:**
- Modify: `src/icc.ts`
- Test: `test/icc.test.ts`

**Interfaces:**
- Consumes: `IccProfile`, `IccTag`, `iccTag` from Tasks 1-2.
- Produces:
  ```ts
  export function readXyzTag(p: IccProfile, tag: IccTag): [number, number, number]
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/icc.test.ts`:

```ts
import { readXyzTag } from '../src/icc.js';

/**
 * The `XYZ ` tag type, and the one assertion here that is anchored OUTSIDE our
 * own reader.
 *
 * s15Fixed16 is a signed 16.16 fixed-point number, so a reader that divides by
 * the wrong power of two, or treats the value as unsigned, produces plausible
 * small numbers rather than an obvious fault. The check that catches it is
 * that the three COLORANT columns must sum to the profile's PCS illuminant,
 * D50 — a published constant (0.9642, 1.0000, 0.8249) that no part of this
 * code produces.
 */
describe('readXyzTag', () => {
  const p = parseIccProfile(srgbIcc());
  const xyz = (s: string): [number, number, number] => {
    const t = iccTag(p, s);
    if (!t) throw new Error(`no ${s} tag`);
    return readXyzTag(p, t);
  };

  it('reads s15Fixed16 triples', () => {
    const [x, y, z] = xyz('rXYZ');
    expect(x).toBeCloseTo(0.436066, 5);
    expect(y).toBeCloseTo(0.222488, 5);
    expect(z).toBeCloseTo(0.013916, 5);
  });

  // The external anchor. Sum the red, green and blue colorants and you must
  // get the D50 white the ICC PCS is defined against, whatever this reader
  // does internally.
  it('gives colorants that sum to the D50 illuminant', () => {
    const r = xyz('rXYZ'), g = xyz('gXYZ'), b = xyz('bXYZ');
    expect(r[0] + g[0] + b[0]).toBeCloseTo(0.9642, 3);
    expect(r[1] + g[1] + b[1]).toBeCloseTo(1.0000, 3);
    expect(r[2] + g[2] + b[2]).toBeCloseTo(0.8249, 3);
  });

  /**
   * And the value this profile actually stores for its media white point is
   * D65, not the D50 the sum above lands on. That is a known quirk of this
   * particular file; the parser reports what the file says and does not
   * correct it. Asserted so the discrepancy reads as recorded rather than as a
   * bug in the reader.
   */
  it('reports the D65 white point this profile really declares', () => {
    const [x, y, z] = xyz('wtpt');
    expect(x).toBeCloseTo(0.9504, 3);
    expect(y).toBeCloseTo(1.0000, 3);
    expect(z).toBeCloseTo(1.0890, 3);
  });

  it('refuses a tag that is not an XYZ type', () => {
    const t = iccTag(p, 'desc');
    if (!t) throw new Error('no desc tag');
    expect(() => readXyzTag(p, t)).toThrow(PdfParseError);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icc.test.ts`
Expected: FAIL — `readXyzTag` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/icc.ts`:

```ts
/** A signed 16.16 fixed-point number, ICC's `s15Fixed16Number`. */
function s15Fixed16(b: Uint8Array, o: number): number {
  const raw = ((b[o] as number) << 24 | (b[o + 1] as number) << 16
    | (b[o + 2] as number) << 8 | (b[o + 3] as number));  // signed by <<24
  return raw / 65536;
}

/**
 * An `XYZ ` tag's first triple.
 *
 * The type is checked rather than assumed: every tag reader here takes an
 * `IccTag` the caller looked up by signature, and a profile is free to store
 * something else under a signature we expected. Reading a `desc` as an `XYZ `
 * yields three plausible small numbers.
 *
 * `s15Fixed16` is SIGNED — the `<< 24` is what makes it so. Reading it
 * unsigned, or scaling by the wrong power of two, produces numbers that look
 * like colour and are not; `test/icc.test.ts` anchors the result against the
 * D50 illuminant, which nothing in this file computes.
 */
export function readXyzTag(p: IccProfile, tag: IccTag): [number, number, number] {
  const type = sig(p.bytes, tag.offset);
  if (type !== 'XYZ ') {
    throw new PdfParseError(
      `ICC tag ${JSON.stringify(tag.signature)} is type ${JSON.stringify(type)}, `
      + 'expected "XYZ "');
  }
  if (tag.size < 20) {
    throw new PdfParseError(
      `ICC XYZ tag ${JSON.stringify(tag.signature)} is ${tag.size} bytes, expected 20`);
  }
  // 4 bytes type, 4 reserved, then three s15Fixed16 values.
  return [
    s15Fixed16(p.bytes, tag.offset + 8),
    s15Fixed16(p.bytes, tag.offset + 12),
    s15Fixed16(p.bytes, tag.offset + 16),
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icc.test.ts`
Expected: PASS, 18 tests.

Then run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Verify the external anchor is load-bearing**

Temporarily change `s15Fixed16`'s `return raw / 65536;` to `return raw / 32768;`, then run:

`npx vitest run test/icc.test.ts`

Expected: the D50 sum case and the triple case both go RED. Restore the line and confirm green again. This is the repo's rule that an assertion must be shown to catch the bug it exists for.

- [ ] **Step 6: Commit**

```bash
git add src/icc.ts test/icc.test.ts
git commit -m "feat(85l8.7.1): read an ICC XYZ tag

s15Fixed16 is signed 16.16, and getting either half wrong yields plausible
small numbers rather than an obvious fault -- so the test anchors the three
colorants against the D50 illuminant, a published constant this file does not
compute. Measured: scaling by 32768 reddens it.

The profile's own wtpt is D65 where the colorants sum to D50; that is a known
quirk of this file and is asserted so it reads as recorded rather than as a
reader bug.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `curv` tags

**Files:**
- Modify: `src/icc.ts`
- Test: `test/icc.test.ts`

**Interfaces:**
- Consumes: `IccProfile`, `IccTag`, `iccTag` from Tasks 1-2.
- Produces:
  ```ts
  export type IccCurve =
    | { kind: 'identity' }
    | { kind: 'gamma'; gamma: number }
    | { kind: 'table'; table: Uint16Array };
  export function readCurveTag(p: IccProfile, tag: IccTag): IccCurve
  export function evalCurve(curve: IccCurve, x: number): number
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/icc.test.ts`:

```ts
import { readCurveTag, evalCurve, type IccCurve } from '../src/icc.js';

/**
 * The `curv` tag type. Its COUNT field selects between three different
 * meanings, and confusing them is silent:
 *
 *   0 entries — the identity, drawn as a straight line;
 *   1 entry   — a gamma, as u8Fixed8 (so 0x0100 is gamma 1.0, not 256);
 *   n entries — a sampled table of n uint16 values.
 *
 * Reading the 1-entry form as a one-element table gives a curve that returns a
 * constant, which renders as a flat wash rather than an error.
 */
describe('readCurveTag', () => {
  const p = parseIccProfile(srgbIcc());
  const trc = (): IccCurve => {
    const t = iccTag(p, 'rTRC');
    if (!t) throw new Error('no rTRC tag');
    return readCurveTag(p, t);
  };

  it('reads a sampled table and its length', () => {
    const c = trc();
    expect(c.kind).toBe('table');
    if (c.kind !== 'table') throw new Error('not a table');
    expect(c.table).toHaveLength(1024);
    expect(c.table[0]).toBe(0);
    expect(c.table[1023]).toBe(65535);
  });

  // A TRC is a transfer function, so it must not go backwards. This is a
  // property of the DATA rather than of the reader, which is what makes it a
  // useful check on the reader: an off-by-one or a byte-order slip produces a
  // sequence that is not monotonic.
  it('reads a table that is monotonic non-decreasing', () => {
    const c = trc();
    if (c.kind !== 'table') throw new Error('not a table');
    for (let i = 1; i < c.table.length; i++) {
      expect(c.table[i]).toBeGreaterThanOrEqual(c.table[i - 1] as number);
    }
  });

  it('reads a zero-entry curve as the identity', () => {
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode('curv'), 0);
    // count stays 0
    const fake: IccProfile = { header: p.header, tags: [], bytes };
    expect(readCurveTag(fake, { signature: 'x', offset: 0, size: 12 }))
      .toEqual({ kind: 'identity' });
  });

  // u8Fixed8: 0x0100 is 1.0. Read as a plain integer it is 256, and every
  // value raised to the power 256 collapses to zero.
  it('reads a one-entry curve as a u8Fixed8 gamma', () => {
    const bytes = new Uint8Array(14);
    bytes.set(new TextEncoder().encode('curv'), 0);
    bytes[11] = 1;              // count = 1
    bytes[12] = 0x02; bytes[13] = 0x33;   // 0x0233 = 2.199…
    const fake: IccProfile = { header: p.header, tags: [], bytes };
    const c = readCurveTag(fake, { signature: 'x', offset: 0, size: 14 });
    expect(c.kind).toBe('gamma');
    if (c.kind !== 'gamma') throw new Error('not a gamma');
    expect(c.gamma).toBeCloseTo(2.199, 3);
  });

  it('refuses a curve whose entries do not fit its tag', () => {
    const bytes = new Uint8Array(14);
    bytes.set(new TextEncoder().encode('curv'), 0);
    bytes[10] = 0xff; bytes[11] = 0xff;   // count = 65535
    const fake: IccProfile = { header: p.header, tags: [], bytes };
    expect(() => readCurveTag(fake, { signature: 'x', offset: 0, size: 14 }))
      .toThrow(PdfParseError);
  });
});

describe('evalCurve', () => {
  it('passes a value straight through the identity', () => {
    expect(evalCurve({ kind: 'identity' }, 0.25)).toBe(0.25);
  });

  it('raises to the gamma', () => {
    expect(evalCurve({ kind: 'gamma', gamma: 2 }, 0.5)).toBeCloseTo(0.25, 6);
  });

  // Interpolated, not nearest: a 1024-entry table sampled at 256 input steps
  // would otherwise quantise the output visibly.
  it('interpolates between table entries', () => {
    const table = Uint16Array.from([0, 65535]);
    expect(evalCurve({ kind: 'table', table }, 0.5)).toBeCloseTo(0.5, 4);
  });

  it('clamps an input outside 0..1', () => {
    const table = Uint16Array.from([0, 65535]);
    expect(evalCurve({ kind: 'table', table }, -1)).toBe(0);
    expect(evalCurve({ kind: 'table', table }, 2)).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/icc.test.ts`
Expected: FAIL — `readCurveTag` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/icc.ts`:

```ts
/**
 * A `curv` tag, whose COUNT field selects between three different meanings.
 * Confusing them is silent: the one-entry form read as a table gives a curve
 * that returns a constant, which renders as a flat wash rather than failing.
 */
export type IccCurve =
  | { kind: 'identity' }
  | { kind: 'gamma'; gamma: number }
  | { kind: 'table'; table: Uint16Array };

const u16 = (b: Uint8Array, o: number): number =>
  ((b[o] as number) << 8) | (b[o + 1] as number);

/** Read a `curv` tag. */
export function readCurveTag(p: IccProfile, tag: IccTag): IccCurve {
  const b = p.bytes;
  const type = sig(b, tag.offset);
  if (type !== 'curv') {
    throw new PdfParseError(
      `ICC tag ${JSON.stringify(tag.signature)} is type ${JSON.stringify(type)}, `
      + 'expected "curv"');
  }
  if (tag.size < 12) {
    throw new PdfParseError(`ICC curv tag is ${tag.size} bytes, expected at least 12`);
  }
  // 4 bytes type, 4 reserved, 4 count.
  const count = u32(b, tag.offset + 8);
  if (count === 0) return { kind: 'identity' };
  if (12 + count * 2 > tag.size) {
    throw new PdfParseError(
      `ICC curv tag declares ${count} entries, needing ${12 + count * 2} bytes of ${tag.size}`);
  }
  // A single entry is a GAMMA in u8Fixed8, not a one-element table: 0x0100 is
  // 1.0, where reading it as an integer gives 256 and every value raised to
  // that power collapses to zero.
  if (count === 1) return { kind: 'gamma', gamma: u16(b, tag.offset + 12) / 256 };
  const table = new Uint16Array(count);
  for (let i = 0; i < count; i++) table[i] = u16(b, tag.offset + 12 + i * 2);
  return { kind: 'table', table };
}

/** Evaluate a curve at `x` in 0..1, returning 0..1. Input is clamped. */
export function evalCurve(curve: IccCurve, x: number): number {
  const v = x < 0 ? 0 : x > 1 ? 1 : x;
  if (curve.kind === 'identity') return v;
  if (curve.kind === 'gamma') return Math.pow(v, curve.gamma);
  const { table } = curve;
  if (table.length === 0) return v;
  if (table.length === 1) return (table[0] as number) / 65535;
  // INTERPOLATED, not nearest: a 1024-entry table sampled at 256 input steps
  // would otherwise quantise the output visibly.
  const pos = v * (table.length - 1);
  const i = Math.floor(pos);
  if (i >= table.length - 1) return (table[table.length - 1] as number) / 65535;
  const frac = pos - i;
  const lo = table[i] as number;
  const hi = table[i + 1] as number;
  return (lo + (hi - lo) * frac) / 65535;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/icc.test.ts`
Expected: PASS, 27 tests.

Then run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Verify the gamma rule is load-bearing**

Temporarily change `readCurveTag`'s gamma line to `{ kind: 'gamma', gamma: u16(b, tag.offset + 12) }` (dropping the `/ 256`), then run:

`npx vitest run test/icc.test.ts`

Expected: "reads a one-entry curve as a u8Fixed8 gamma" goes RED. Restore and confirm green.

- [ ] **Step 6: Run the whole suite and commit**

Run: `npx vitest run`
Expected: every test file passes; nothing outside `test/icc.test.ts` moves, since `src/icc.ts` is imported by nothing yet.

```bash
git add src/icc.ts test/icc.test.ts
git commit -m "feat(85l8.7.1): read an ICC curv tag

Its count field selects three different meanings and confusing them is silent:
0 is the identity, 1 is a u8Fixed8 GAMMA (0x0100 is 1.0, not 256), n is a
sampled table. The one-entry form read as a table gives a curve that returns a
constant -- a flat wash rather than a failure. Measured: dropping the /256
reddens the gamma case.

evalCurve interpolates rather than taking the nearest entry, or a 1024-entry
table sampled at 256 steps would quantise visibly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Close the issue

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the module to the Source list**

`CLAUDE.md`'s Source list gains an entry for `src/icc.ts` — the rule is that a new `src/*.ts` module earns one **when it lands**. Place it near the colour modules. Content to add:

```markdown
- **icc.ts** — the ICC profile container (`85l8.7.1`): header, tag table, and
  the `XYZ ` and `curv` tag types. A pure leaf importing only `errors.js` —
  bytes in, structure out, no `Document` and no colour conversion; `icclut.ts`
  and `icctransform.ts` (`85l8.7.2`) build the transform on top.
  **Invariant:** a parser REPORTS what the file says and never corrects it.
  The vendored sRGB profile declares a D65 media white point where its own
  colorants sum to D50 — a known quirk of that file, asserted in the suite so
  it reads as recorded rather than as a reader bug.
  **Invariant:** tag bounds are checked ONCE, in `parseIccProfile`, not in each
  tag reader: a tag running past the buffer is an out-of-bounds read rather
  than a wrong colour.
  **Invariant:** a four-character signature keeps its padding. `'RGB '` and
  `'Lab '` are signatures rather than words, and a trimmed one stops comparing
  equal to the constants `85l8.7.2` matches on.
  **Note, and each is silent when wrong:** header byte 9 packs minor and
  bugfix in two nibbles (read raw it reports version 16 for 1.0);
  `s15Fixed16` is SIGNED 16.16; and a `curv` tag's COUNT selects three
  meanings — 0 identity, 1 a u8Fixed8 GAMMA where 0x0100 is 1.0, n a table.
  **Note on the oracle:** there is none, and none is needed. Every rule is
  checked against the sRGB profile already vendored in `srgb.ts`, and the
  s15Fixed16 reader is anchored OUTSIDE this code by summing the three
  colorants to the published D50 illuminant.
```

- [ ] **Step 2: Verify the module-list sweep is clean**

Run:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `icc.ts` is NOT in the output.

- [ ] **Step 3: Commit and close**

```bash
git add CLAUDE.md
git commit -m "docs(85l8.7.1): record icc.ts in the module list

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
bd close aspose-pdf-foss-for-ts-85l8.7.1 --reason "src/icc.ts reads an ICC header, tag table, XYZ and curv tags. Pure leaf over errors.js. Verified against the sRGB profile already vendored in srgb.ts -- no new fixture, no generator, no oracle -- with s15Fixed16 anchored outside the code by summing the colorants to the published D50 illuminant. Nothing is exported from index.ts yet, so no CHANGELOG entry; 85l8.7.2 logs the feature."
git add .beads/interactions.jsonl && git commit -m "chore(85l8.7.1): close the issue"
git pull --rebase && git push
```

---

## Self-Review

**Spec coverage.** The design's `85l8.7.1` scope is "header and tag table, checked against the sRGB profile already vendored in `srgb.ts`: 3144 bytes, class `mntr`, space `RGB `, PCS `XYZ `, signature `acsp`, and its published primaries and TRC." Tasks 1-2 cover the header and tag table; Task 3 covers the primaries; Task 4 covers the TRC. The design's "no licensing question, no generator, no oracle needed" holds: no fixture file is added.

**Placeholders.** None — every step carries the code it needs, and both mutation steps name the exact edit and the exact expected failure.

**Type consistency.** `IccTag` is declared as a placeholder in Task 1 and replaced in Task 2 with the identical field names (`signature`, `offset`, `size`), so Task 1's `tags: []` stays assignable. `sig`, `u32` and `u16` are module-private helpers defined before their first use — `sig` and `u32` in Task 1, `u16` in Task 4. `IccProfile` is constructed directly in Task 4's synthetic-curve tests, which is why its three fields are all public.

**Deliberately out of this plan**, and belonging to `85l8.7.2`: `mft1`/`mft2`, CLUT interpolation, Lab encodings, intent selection, `iccCmykTransform`, the authored fixture, the generator and the WCS goldens.
