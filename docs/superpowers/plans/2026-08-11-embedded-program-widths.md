# Embedded-Program Glyph Widths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `/Widths` cannot answer, take a simple font's advances from its embedded program (Type 1, TrueType or CFF) instead of guessing a Standard-14 face or advancing by zero.

**Architecture:** A new pure module `src/glyphprogram.ts` owns program loading, code→gid, and the unit-normalised advance. `raster.ts` delegates its existing `buildGlyphSource`/`gidForCode` to it rather than keeping a second copy, and `font.ts` calls it lazily on the first code `/Widths` cannot cover.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime dependencies.

**Spec:** [docs/superpowers/specs/2026-08-11-embedded-program-widths-design.md](../specs/2026-08-11-embedded-program-widths-design.md)
**Issue:** `aspose-pdf-foss-for-ts-imxw.4`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Relative imports carry the `.js` extension.
- **`strict` TypeScript.** `npm run typecheck` must be clean.
- **`src/glyphprogram.ts` never imports `font.ts`, `raster.ts` or `document.ts`.** It takes `resolve`/`inflate` callbacks and a name resolver as arguments. This is what keeps `font.ts → glyphprogram.ts` out of a dependency cycle, and it is a review gate, not a preference.
- **Task 3 is a pure refactor.** No behaviour change, no test changes. The full suite must pass untouched.
- **Every advance crosses module boundaries in 1/1000 em.** `programAdvance` divides out `unitsPerEm`; nothing downstream re-scales.
- **`/Widths` always wins.** The program is consulted only where `/Widths` and an explicit `/MissingWidth` are both silent.
- **Both gates before closing:** `npm run typecheck` and `npm test`.
- **Task tracking is `bd`, not TodoWrite** (CLAUDE.md).
- **Commit after every task**, ending the message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `src/cff.ts` (modify) | expose `glyphWidth(gid)` from the width the Type 2 interpreter already computes |
| `src/glyphprogram.ts` (create) | load `/FontFile*`; code→gid; normalised advance |
| `src/raster.ts` (modify) | `buildGlyphSource`/`gidForCode` delegate; Type 0 + substitute face stay |
| `src/font.ts` (modify) | `/MissingWidth` presence; the four-rung `advance`; lazy program thunk |
| `test/helpers/build-cff.ts` (modify) | `buildWidthCff()` — a CFF exercising both width paths |
| `test/helpers/build-sfnt.ts` (modify) | `buildHead(upem)` + `buildMinimalTtf({ head })` for a 2048/em font |
| `test/cff.test.ts` (modify) | `glyphWidth` |
| `test/glyphprogram.test.ts` (create) | loading, code→gid, normalisation |
| `test/font-program-widths.test.ts` (create) | the four rungs |
| `test/type1-real.test.ts` (modify) | real-font width cross-checks + the acceptance render |
| `CLAUDE.md`, `README.md` (modify) | invariants and user-facing coverage |

---

### Task 1: Expose the CFF charstring width

**Files:**
- Modify: `src/cff.ts` — add `glyphWidth`, beside `glyphPath` (around line 145)
- Modify: `test/helpers/build-cff.ts` — add `buildWidthCff`
- Test: `test/cff.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `CffFont.glyphWidth(gid: number): number | undefined` — the charstring width in the font's own units (**not** normalised; Task 2 does that).
- Test helper: `buildWidthCff(): Uint8Array`.

**Background the implementer needs.** A Type 2 charstring encodes its width as an *optional* leading operand on the first stack-clearing operator. When present the width is `nominalWidthX + operand`; when absent it is `defaultWidthX`. Both come from the Private DICT (operators 21 and 20). `cff.ts` already computes this into `T2Ctx.width` via `maybeWidth`/`countStems` — `glyphPath` simply discards it.

- [ ] **Step 1: Add the fixture**

Append to `test/helpers/build-cff.ts`:

```ts
/** A 2-glyph name-keyed CFF whose Private DICT carries defaultWidthX 250 and
 *  nominalWidthX 400, exercising BOTH Type 2 width paths:
 *  gid 0 omits the width operand (-> 250), gid 1 supplies one (-> 400 + 100). */
export function buildWidthCff(): Uint8Array {
  const notdef = Uint8Array.from([14]);                       // endchar, no width operand
  // 100 0 0 rmoveto : three operands where rmoveto needs two, so the leading
  // 100 is the width delta -> nominalWidthX + 100 = 500.
  const wide = Uint8Array.from([239, 139, 139, 21, 14]);
  const charStrings = index([notdef, wide]);

  const privateDict = concat([dictInt5(250), [20], dictInt5(400), [21]]);
  const privLen = privateDict.length;

  const header = Uint8Array.from([1, 0, 4, 2]);
  const nameIndex = index([new TextEncoder().encode('WidthTest')]);
  const stringIndex = index([]);
  const gsubrIndex = index([]);

  // Top DICT: charset(15), CharStrings(17), Private(18) — each a 5-byte int, so
  // the body length is fixed at 23 regardless of the offsets it will carry.
  const topBodyLen = (5 + 1) + (5 + 1) + (5 + 5 + 1);
  const fixed = header.length + nameIndex.length;
  // INDEX = count(2) + offSize(1) + (count+1) offsets + data. One item, and
  // 23+1 fits a byte, so offSize is 1 and the two offsets cost 2 bytes.
  const topIndexLen = 2 + 1 + 2 + topBodyLen;
  const csOff = fixed + topIndexLen + stringIndex.length + gsubrIndex.length;
  const charsetOff = csOff + charStrings.length;
  const charset = Uint8Array.from([0, 0, 1]);                 // format 0, one SID: gid1 -> SID 1
  const privOff = charsetOff + charset.length;

  const topDict = concat([
    dictInt5(charsetOff), [15],
    dictInt5(csOff), [17],
    dictInt5(privLen), dictInt5(privOff), [18],
  ]);
  if (topDict.length !== topBodyLen) throw new Error('buildWidthCff: Top DICT length mismatch');
  const topIndex = index([topDict]);
  // Both assertions are load-bearing: every offset above was computed from
  // these two lengths, and a mismatch produces a CFF that still parses but
  // reads the wrong bytes.
  if (topIndex.length !== topIndexLen) throw new Error('buildWidthCff: Top INDEX length mismatch');

  return concat([header, nameIndex, topIndex, stringIndex, gsubrIndex,
    charStrings, charset, privateDict]);
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/cff.test.ts`, adding `buildWidthCff` to its import from
`./helpers/build-cff.js`:

```ts
describe('CffFont — charstring widths', () => {
  const cff = new CffFont(buildWidthCff());

  it('uses defaultWidthX when the charstring omits the width operand', () => {
    expect(cff.glyphWidth(0)).toBe(250);
  });

  it('uses nominalWidthX + the operand when the charstring supplies one', () => {
    // The trap: the operand is a DELTA from nominalWidthX, not the width. An
    // implementation that returns the operand gives 100 here, which looks like
    // a plausible narrow glyph.
    expect(cff.glyphWidth(1)).toBe(500);
  });

  it('answers undefined for a gid the font does not have', () => {
    expect(cff.glyphWidth(2)).toBeUndefined();
    expect(cff.glyphWidth(-1)).toBeUndefined();
  });

  it('leaves glyphPath unchanged', () => {
    expect(cff.glyphPath(1)).toEqual([{ op: 'M', x: 0, y: 0 }, { op: 'Z' }]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/cff.test.ts`
Expected: FAIL — `cff.glyphWidth is not a function`.

- [ ] **Step 4: Add the accessor**

In `src/cff.ts`, add a cache field beside the other private fields:

```ts
  /** gid -> charstring width, computed on demand. */
  private readonly widthCache = new Map<number, number>();
```

and add this method immediately after `glyphPath`:

```ts
  /**
   * The advance width `gid`'s charstring declares, in the font's own units.
   *
   * A Type 2 charstring encodes its width as an *optional* leading operand on
   * the first stack-clearing operator: present means `nominalWidthX + operand`,
   * absent means `defaultWidthX`. The interpreter already resolves that into
   * `T2Ctx.width`; this exposes it. Callers must divide out
   * {@link unitsPerEm} — see `glyphprogram.ts`.
   *
   * Deliberately re-runs the charstring rather than caching the whole context
   * alongside {@link glyphPath}: sharing one `Path` array between callers would
   * make a mutation by any of them visible to all.
   */
  glyphWidth(gid: number): number | undefined {
    if (gid < 0 || gid >= this.charStrings.length) return undefined;
    const hit = this.widthCache.get(gid);
    if (hit !== undefined) return hit;
    const fd = this.fdSelect(gid);
    const ctx: T2Ctx = {
      path: [], x: 0, y: 0, stack: [], nStems: 0, haveWidth: false, open: false,
      localSubrs: this.fdLocalSubrs[fd] ?? [], localBias: this.fdBias[fd] ?? 107,
      globalSubrs: this.globalSubrs, globalBias: this.globalBias,
      width: this.fdWidths[fd]?.default ?? 0, nominalWidth: this.fdWidths[fd]?.nominal ?? 0,
      depth: 0,
    };
    try { runCharString(this.charStrings[gid], ctx); } catch { /* keep what was resolved */ }
    this.widthCache.set(gid, ctx.width);
    return ctx.width;
  }
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/cff.test.ts test/fontshrink.test.ts test/optimize.test.ts && npm run typecheck`
Expected: PASS. The last two exercise `CffFont` heavily and must be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/cff.ts test/helpers/build-cff.ts test/cff.test.ts
git commit -m "$(cat <<'EOF'
feat(font): expose the CFF charstring width (imxw.4)

The Type 2 interpreter already resolves each glyph's width — the optional
leading operand is a delta from nominalWidthX, and its absence means
defaultWidthX — but glyphPath discarded it.

Re-runs the charstring rather than caching the context beside glyphPath:
sharing one Path array between callers would make any mutation visible to all.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `src/glyphprogram.ts`

**Files:**
- Create: `src/glyphprogram.ts`
- Modify: `test/helpers/build-sfnt.ts` — `buildHead(upem)` and `buildMinimalTtf({ head })`
- Test: `test/glyphprogram.test.ts` (create)

**Interfaces:**
- Consumes: `CffFont.glyphWidth` (Task 1); `SfntFont.advanceWidth`/`unitsPerEm`, `Type1Font.glyphWidth`/`unitsPerEm`/`gidForName` (all existing).
- Produces:

```ts
export interface EmbeddedProgram { sfnt?: SfntFont; cff?: CffFont; type1?: Type1Font; }
export function loadEmbeddedProgram(
  fdObj: PdfObject | undefined,
  resolve: (o: PdfObject | undefined) => PdfObject,
  inflate: (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array,
): EmbeddedProgram;
export function gidForProgram(
  prog: EmbeddedProgram, code: number, text: string,
  nameForCode: ((code: number) => string | undefined) | undefined,
): number | undefined;
export function programAdvance(prog: EmbeddedProgram, gid: number): number | undefined;
```

- [ ] **Step 1: Make the sfnt fixture parameterisable**

In `test/helpers/build-sfnt.ts`, change `buildHead` to take an optional
units-per-em (default unchanged, so every existing caller is untouched):

```ts
export function buildHead(unitsPerEm = 1000): Uint8Array {
  const b = new Uint8Array(54); const v = new DataView(b.buffer);
  v.setUint32(0, 0x00010000);   // version 1.0
  v.setUint32(12, 0x5F0F3CF5);  // magicNumber
  v.setUint16(18, unitsPerEm);
  v.setInt16(36, 0); v.setInt16(38, -200); v.setInt16(40, 700); v.setInt16(42, 800); // bbox
  v.setInt16(50, 0);            // indexToLocFormat = 0 (short)
  return b;
}
```

and let `buildMinimalTtf` accept an override for it — change its signature and
the one `head` line:

```ts
export function buildMinimalTtf(
  over: { cmap?: Uint8Array; post?: Uint8Array; head?: Uint8Array } = {},
): Uint8Array {
```
```ts
    { tag: 'head', data: over.head ?? buildHead() },
```

- [ ] **Step 2: Write the failing test**

Create `test/glyphprogram.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadEmbeddedProgram, gidForProgram, programAdvance } from '../src/glyphprogram.js';
import { PdfDict, PdfObject, PdfStream, name } from '../src/types.js';
import { buildMinimalTtf, buildHead } from './helpers/build-sfnt.js';
import { buildWidthCff, buildNameKeyedCff } from './helpers/build-cff.js';
import { buildType1, t1num, t1cs } from './helpers/build-type1.js';

const id = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const inflate = (s: { raw: Uint8Array }) => s.raw;
const dict = (entries: Record<string, PdfObject>): PdfDict => new Map(Object.entries(entries));
const stream = (raw: Uint8Array): PdfStream => ({ kind: 'stream', dict: new Map(), raw });

describe('loadEmbeddedProgram', () => {
  it('loads a TrueType program from /FontFile2', () => {
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(buildMinimalTtf()) }), id, inflate);
    expect(p.sfnt).toBeDefined();
    expect(p.cff).toBeUndefined();
    expect(p.type1).toBeUndefined();
  });

  it('loads a bare CFF program from /FontFile3', () => {
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildWidthCff()) }), id, inflate);
    expect(p.cff).toBeDefined();
    expect(p.sfnt).toBeUndefined();
  });

  it('loads a Type 1 program from /FontFile', () => {
    const prog = buildType1({ charstrings: { '.notdef': t1cs(14), A: t1cs(t1num(0), t1num(600), 13, 14) } });
    const p = loadEmbeddedProgram(dict({ FontFile: stream(prog) }), id, inflate);
    expect(p.type1).toBeDefined();
  });

  it('returns nothing for a descriptor with no program, and never throws', () => {
    expect(loadEmbeddedProgram(dict({}), id, inflate)).toEqual({});
    expect(loadEmbeddedProgram(undefined, id, inflate)).toEqual({});
    // A corrupt program is a broken font, not a broken document.
    expect(loadEmbeddedProgram(
      dict({ FontFile2: stream(Uint8Array.from([1, 2, 3, 4])) }), id, inflate,
    )).toEqual({});
  });
});

describe('programAdvance — normalisation to 1/1000 em', () => {
  it('divides out a TrueType unitsPerEm of 2048', () => {
    // buildHmtx gives gid1 an advance of 600 font units. At 2048/em that is
    // 600 * 1000 / 2048 = 292.97 em-thousandths. Skipping the division reports
    // 600, which is 2.048x too wide — and looks entirely plausible.
    const ttf = buildMinimalTtf({ head: buildHead(2048) });
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(ttf) }), id, inflate);
    expect(programAdvance(p, 1)).toBeCloseTo(292.969, 2);
  });

  it('leaves a 1000/em TrueType alone', () => {
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(buildMinimalTtf()) }), id, inflate);
    expect(programAdvance(p, 1)).toBeCloseTo(600, 6);
  });

  it('reports CFF charstring widths', () => {
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildWidthCff()) }), id, inflate);
    expect(programAdvance(p, 0)).toBeCloseTo(250, 6);
    expect(programAdvance(p, 1)).toBeCloseTo(500, 6);
  });

  it('reports Type 1 hsbw widths', () => {
    const prog = buildType1({
      charstrings: {
        '.notdef': t1cs(t1num(0), t1num(300), 13, 14),
        A: t1cs(t1num(0), t1num(742), 13, 14),
      },
    });
    const p = loadEmbeddedProgram(dict({ FontFile: stream(prog) }), id, inflate);
    expect(programAdvance(p, p.type1!.gidForName('A')!)).toBeCloseTo(742, 6);
  });

  it('answers undefined with no program at all', () => {
    expect(programAdvance({}, 0)).toBeUndefined();
  });
});

describe('gidForProgram', () => {
  it('routes a TrueType through its cmap, by Unicode then by code', () => {
    const p = loadEmbeddedProgram(dict({ FontFile2: stream(buildMinimalTtf()) }), id, inflate);
    expect(gidForProgram(p, 0x41, 'A', undefined)).toBe(1);
    expect(gidForProgram(p, 0x42, '', undefined)).toBe(2);
    expect(gidForProgram(p, 0x5a, 'Z', undefined)).toBeUndefined();
  });

  it('routes a Type 1 program by glyph name, and answers undefined for a name it lacks', () => {
    const prog = buildType1({
      charstrings: { '.notdef': t1cs(14), A: t1cs(t1num(0), t1num(600), 13, 14) },
    });
    const p = loadEmbeddedProgram(dict({ FontFile: stream(prog) }), id, inflate);
    const nameFor = (c: number) => (c === 0x41 ? 'A' : 'nosuchglyph');
    expect(gidForProgram(p, 0x41, 'A', nameFor)).toBe(p.type1!.gidForName('A'));
    // No substitute exists for a Type 1 name the program does not define.
    expect(gidForProgram(p, 0x42, 'B', nameFor)).toBeUndefined();
  });

  it('routes a name-keyed CFF through its charset', () => {
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildNameKeyedCff()) }), id, inflate);
    const names = p.cff!.charsetNames();
    const target = names[1]!;
    expect(gidForProgram(p, 0x41, 'A', () => target)).toBe(1);
  });

  it('keeps the gid = code guess only for a charset it could not read', () => {
    // A CFF whose charset yields no names has no better answer available. This
    // is behaviour raster.ts already had; the refactor must not change it.
    const p = loadEmbeddedProgram(dict({ FontFile3: stream(buildWidthCff()) }), id, inflate);
    const namesEmpty = p.cff!.charsetNames().every((n) => n === undefined);
    if (namesEmpty) expect(gidForProgram(p, 7, '', () => 'zzz')).toBe(7);
    else expect(gidForProgram(p, 7, '', () => 'zzz')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/glyphprogram.test.ts`
Expected: FAIL — cannot resolve `../src/glyphprogram.js`.

- [ ] **Step 4: Write the module**

Create `src/glyphprogram.ts`:

```ts
import { PdfDict, PdfObject, isDict, isStream } from './types.js';
import { SfntFont, parseSfnt } from './sfnt.js';
import { CffFont } from './cff.js';
import { Type1Font } from './type1.js';

type Resolve = (o: PdfObject | undefined) => PdfObject;
type Inflate = (s: { dict: PdfDict; raw: Uint8Array }) => Uint8Array;

/**
 * Whichever font program a `/FontDescriptor` embeds.
 *
 * This module is the single owner of three questions that both the renderer and
 * the extraction path ask: what program does this descriptor carry, which glyph
 * does a code select in it, and how wide is that glyph. `raster.ts` asked all
 * three already; `font.ts` needs the third and cannot import `raster.ts`, so a
 * second copy was the alternative — the same one-owner reasoning that put
 * code → glyph *name* in one place.
 *
 * Takes `resolve`/`inflate` rather than a `Document`, and takes the name
 * resolver as an argument rather than importing `font.ts`. That is what keeps
 * `font.ts -> glyphprogram.ts` free of a dependency cycle.
 */
export interface EmbeddedProgram {
  sfnt?: SfntFont;
  cff?: CffFont;
  type1?: Type1Font;
}

/** True when `raw` begins with an sfnt version tag (OTTO / TrueType / collection). */
function isSfnt(raw: Uint8Array): boolean {
  if (raw.length < 4) return false;
  const tag = ((raw[0] << 24) | (raw[1] << 16) | (raw[2] << 8) | raw[3]) >>> 0;
  return tag === 0x4f54544f || tag === 0x00010000 || tag === 0x74727565 || tag === 0x74746366;
}

/**
 * Load `/FontFile2` (TrueType), `/FontFile3` (CFF / OpenType-CFF) or
 * `/FontFile` (Type 1), in that precedence.
 *
 * A malformed program is a broken font, not a broken document: every parse is
 * guarded, and an unreadable one simply leaves its slot empty.
 */
export function loadEmbeddedProgram(
  fdObj: PdfObject | undefined, resolve: Resolve, inflate: Inflate,
): EmbeddedProgram {
  const fd = resolve(fdObj);
  if (!isDict(fd)) return {};
  const inf = (s: PdfObject): Uint8Array => inflate(s as { dict: PdfDict; raw: Uint8Array });

  let sfnt: SfntFont | undefined;
  let cff: CffFont | undefined;
  let type1: Type1Font | undefined;

  const ff2 = resolve(fd.get('FontFile2'));
  if (isStream(ff2)) { try { sfnt = parseSfnt(inf(ff2)); } catch { sfnt = undefined; } }
  if (sfnt?.outlines === 'cff') {
    const t = sfnt.table('CFF ', false);
    if (t) { try { cff = new CffFont(t); } catch { /* keep sfnt for its cmap */ } }
  }

  if (!cff) {
    const ff3 = resolve(fd.get('FontFile3'));
    if (isStream(ff3)) {
      try {
        const raw = inf(ff3);
        if (isSfnt(raw)) {
          const s = parseSfnt(raw);
          sfnt = sfnt ?? s;
          const t = s.table('CFF ', false);
          if (t) cff = new CffFont(t);
        } else cff = new CffFont(raw);
      } catch { /* undecodable */ }
    }
  }

  if (!cff && !sfnt) {
    const ff1 = resolve(fd.get('FontFile'));
    if (isStream(ff1)) { try { type1 = new Type1Font(inf(ff1)); } catch { type1 = undefined; } }
  }

  const out: EmbeddedProgram = {};
  if (sfnt) out.sfnt = sfnt;
  if (cff) out.cff = cff;
  if (type1) out.type1 = type1;
  return out;
}

/**
 * Resolve a *simple* font's character code to a glyph id in `prog`.
 *
 * `nameForCode` is the name-keyed route and is supplied by the caller — a Type 1
 * program has no other route, and a CFF with no usable `cmap` has none either.
 * `text` is the Unicode the code decodes to, which a TrueType `cmap` prefers
 * over the raw code.
 */
export function gidForProgram(
  prog: EmbeddedProgram, code: number, text: string,
  nameForCode: ((code: number) => string | undefined) | undefined,
): number | undefined {
  if (nameForCode) {
    const n = nameForCode(code);
    // A Type 1 program has no cmap and no substitute: a name it does not define
    // simply has no glyph.
    if (prog.type1) return n === undefined ? undefined : prog.type1.gidForName(n);
    const names = prog.cff?.charsetNames() ?? [];
    if (n !== undefined) {
      const gid = names.indexOf(n);
      if (gid > 0) return gid;
    }
    const bg = prog.cff?.builtinEncoding()?.get(code);
    if (bg !== undefined) return bg;
    // A charset we could read that does not name this glyph: no answer. Only a
    // charset we could not read at all falls through to the guess below.
    if (names.length) return undefined;
  }

  const sf = prog.sfnt;
  if (sf?.cmap.size) {
    if (text) { const g = sf.cmapLookup(text.codePointAt(0)!); if (g) return g; }
    const gc = sf.cmapLookup(code); if (gc) return gc;
    const gs = sf.cmapLookup(0xf000 + code); if (gs) return gs;   // symbol cmap
    return undefined;
  }
  return code;                                     // no cmap (bare subset): assume gid = code
}

/**
 * The program's own advance for `gid`, **normalised to 1/1000 em**.
 *
 * The three programs report in three different spaces — `hsbw` in glyph space,
 * a CFF charstring width in charstring units, `hmtx` in font units — and only
 * the first two are reliably 1000/em. A TrueType is commonly 2048/em, so
 * skipping the division reports an advance 2.048x too wide while the other two
 * kinds keep looking correct.
 *
 * `hmtx` wins over the CFF charstring width when both exist, which is the
 * OpenType-CFF case: `hmtx` is the authority there.
 */
export function programAdvance(prog: EmbeddedProgram, gid: number): number | undefined {
  const em = (raw: number, upm: number): number => (raw * 1000) / (upm || 1000);
  if (prog.sfnt) return em(prog.sfnt.advanceWidth(gid), prog.sfnt.unitsPerEm);
  if (prog.cff) {
    const w = prog.cff.glyphWidth(gid);
    return w === undefined ? undefined : em(w, prog.cff.unitsPerEm);
  }
  if (prog.type1) return em(prog.type1.glyphWidth(gid), prog.type1.unitsPerEm);
  return undefined;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/glyphprogram.test.ts test/sfnt.test.ts && npm run typecheck`
Expected: PASS. `test/sfnt.test.ts` guards the `buildHead` default.

**If typecheck reports a circular import**, do not duplicate code to escape it.
Move `Path`/`Seg` out of `pagerender.ts` into a new `src/path.ts` and re-export
them from `pagerender.ts`, which breaks the only edge back into `font.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/glyphprogram.ts test/helpers/build-sfnt.ts test/glyphprogram.test.ts
git commit -m "$(cat <<'EOF'
feat(font): one owner for the embedded-program glyph questions (imxw.4)

What program does this descriptor carry, which glyph does a code select, and
how wide is it. raster.ts asked all three; font.ts needs the third and cannot
import raster.ts, so the alternative was a second copy — the same reasoning
that put code -> glyph name in one place.

programAdvance normalises to 1/1000 em. The three programs report in three
different spaces and only Type 1 and CFF are reliably 1000/em; a TrueType is
commonly 2048, where an unnormalised advance is 2.048x too wide and looks
entirely plausible.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Delegate `raster.ts` to the new module

**Files:**
- Modify: `src/raster.ts` — `buildGlyphSource` (from `let sfnt` to the substitute-face block) and `gidForCode`'s simple-font half

**Interfaces:**
- Consumes: `loadEmbeddedProgram`, `gidForProgram` (Task 2).
- Produces: no signature changes. `GlyphSource` and `gidForCode` keep their shapes.

**This task is a pure refactor.** No test file changes. The whole suite must
pass exactly as before — that is the deliverable.

- [ ] **Step 1: Confirm the baseline is green**

Run: `npm test`
Expected: all green. Record the counts; Step 4 must match them.

- [ ] **Step 2: Replace the loading block**

In `src/raster.ts`, add to the imports:

```ts
import { gidForProgram, loadEmbeddedProgram } from './glyphprogram.js';
```

In `buildGlyphSource`, replace everything from `let sfnt: SfntFont | undefined;`
down to (but not including) the `// Non-embedded simple font:` comment with:

```ts
  const prog = loadEmbeddedProgram(fd, (o) => doc.resolve(o),
    (s) => inflateStream(s as Parameters<typeof inflateStream>[0]));
  let sfnt = prog.sfnt;
  const cff = prog.cff;
  const type1 = prog.type1;
```

Delete the now-unused local `inflate` helper and the module-level `isSfnt`
function (it moved to `glyphprogram.ts`); leave `parseSfnt` imported only if
something else still uses it — if `npm run typecheck` reports it unused, remove
it from the import list.

`sfnt` stays `let` because the substitute-face block below reassigns it.

- [ ] **Step 3: Delegate the simple-font half of `gidForCode`**

Replace everything in `gidForCode` after the `if (src.isType0) { … }` block with:

```ts
  return gidForProgram(src, code, text, src.nameForCode);
```

`GlyphSource` structurally satisfies `EmbeddedProgram` — it has the same three
optional program fields — so it can be passed directly.

- [ ] **Step 4: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: identical counts to Step 1, all green. A refactor that changes a
number here has changed behaviour and must be reconciled before committing.

- [ ] **Step 5: Commit**

```bash
git add src/raster.ts
git commit -m "$(cat <<'EOF'
refactor(render): route buildGlyphSource through glyphprogram.ts (imxw.4)

No behaviour change — the suite passes untouched. Moves program loading and
the simple-font code -> gid route into the module font.ts can also reach,
rather than leaving font.ts to grow a second copy.

Preserves both rules imxw.2 established: a Type 1 program answers undefined
for a name it does not define, and a CFF whose charset could not be read at all
still falls through to "assume gid = code".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The four-rung `advance` in `font.ts`

**Files:**
- Modify: `src/font.ts` — `parseSimpleWidths` (around line 717), the simple-font branch of the constructor (around line 225), and `advance` (around line 247)
- Test: `test/font-program-widths.test.ts` (create)

**Interfaces:**
- Consumes: `loadEmbeddedProgram`, `gidForProgram`, `programAdvance` (Task 2); `glyphNameResolver`, `resolveSimpleEncoding` (already in `font.ts`).
- Produces: no new exports. `TextFont`'s public surface is unchanged.

- [ ] **Step 1: Write the failing test**

Create `test/font-program-widths.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TextFont } from '../src/font.js';
import { PdfDict, PdfObject, PdfStream, name } from '../src/types.js';
import { buildMinimalTtf } from './helpers/build-sfnt.js';
import { buildType1, t1num, t1cs } from './helpers/build-type1.js';

const id = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const inflate = (s: { raw: Uint8Array }) => s.raw;
const dict = (entries: Record<string, PdfObject>): PdfDict => new Map(Object.entries(entries));
const stream = (raw: Uint8Array): PdfStream => ({ kind: 'stream', dict: new Map(), raw });

/** A Type 1 program where /A advances 742 and /B advances 333. */
const t1Program = buildType1({
  charstrings: {
    '.notdef': t1cs(t1num(0), t1num(300), 13, 14),
    A: t1cs(t1num(0), t1num(742), 13, 14),
    B: t1cs(t1num(0), t1num(333), 13, 14),
  },
  encoding: { 0x41: 'A', 0x42: 'B' },
});

/** Em-width of one code, via the public decode path. */
function widthOf(font: TextFont, code: number): number {
  const g = font.decodeGlyphs(Uint8Array.from([code]));
  return g[0].width;
}

describe('advance resolution order', () => {
  it('prefers /Widths over the program, even when they disagree', () => {
    // /Widths says 900 where the program says 742. A producer that states a
    // width has said what it means, so the program must not win.
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('TestFont'),
      FirstChar: 0x41, LastChar: 0x41, Widths: [900],
      FontDescriptor: dict({ FontFile: stream(t1Program) }),
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.9, 6);
  });

  it('takes the program width for a code past LastChar with no /MissingWidth', () => {
    // Without this the code gets /MissingWidth's default of 0 and every such
    // glyph piles up on the previous one.
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('TestFont'),
      FirstChar: 0x41, LastChar: 0x41, Widths: [900],
      FontDescriptor: dict({ FontFile: stream(t1Program) }),
    }), id, inflate);
    expect(widthOf(f, 0x42)).toBeCloseTo(0.333, 6);
  });

  it('honours an explicit /MissingWidth over the program, including zero', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('TestFont'),
      FirstChar: 0x41, LastChar: 0x41, Widths: [900],
      FontDescriptor: dict({ FontFile: stream(t1Program), MissingWidth: 0 }),
    }), id, inflate);
    expect(widthOf(f, 0x42)).toBe(0);
  });

  it('uses the program throughout when the font carries no /Widths', () => {
    // Today this measures as Helvetica, because normalizeFont maps an unknown
    // /BaseFont onto it: 'A' would be 0.667.
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('AAAAAB+TestFont'),
      FontDescriptor: dict({ FontFile: stream(t1Program) }),
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.742, 6);
    expect(widthOf(f, 0x42)).toBeCloseTo(0.333, 6);
  });

  it('normalises a 2048/em TrueType through the same path', () => {
    const f = new TextFont(dict({
      Subtype: name('TrueType'), BaseFont: name('AAAAAB+TestTtf'),
      FontDescriptor: dict({ FontFile2: stream(buildMinimalTtf()) }),
    }), id, inflate);
    // buildMinimalTtf is 1000/em and gives 'A' (gid 1) an advance of 600.
    expect(widthOf(f, 0x41)).toBeCloseTo(0.6, 6);
  });

  it('degrades to the Standard-14 guess when the program is unreadable', () => {
    const f = new TextFont(dict({
      Subtype: name('Type1'), BaseFont: name('Helvetica'),
      FontDescriptor: dict({ FontFile: stream(Uint8Array.from([1, 2, 3, 4])) }),
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.667, 3);   // Helvetica 'A'
  });

  it('leaves a Type 3 font measuring through its /FontMatrix', () => {
    // Regression guard for imxw.1: a Type 3 font has no /FontFile* and must not
    // reach the program path at all.
    const f = new TextFont(dict({
      Subtype: name('Type3'),
      FontMatrix: [0.01, 0, 0, 0.01, 0, 0],
      CharProcs: dict({}), Encoding: dict({}),
      FirstChar: 0x41, LastChar: 0x41, Widths: [50],
    }), id, inflate);
    expect(widthOf(f, 0x41)).toBeCloseTo(0.5, 6);     // 50 * 0.01
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/font-program-widths.test.ts`
Expected: FAIL on the second, fourth and fifth cases (0 instead of 0.333;
Helvetica's widths instead of the program's).

- [ ] **Step 3: Report `/MissingWidth` presence**

In `src/font.ts`, change `parseSimpleWidths` to distinguish "the font says zero"
from "the font says nothing":

```ts
/** Parse /FirstChar + /Widths (+ /FontDescriptor /MissingWidth) for a simple font.
 *  Returns undefined when the font carries no /Widths (estimate path).
 *  `hasMissing` records whether /MissingWidth was actually present: its default
 *  of 0 is indistinguishable from a deliberate 0 otherwise, and the two want
 *  opposite treatment when the embedded program could answer instead. */
function parseSimpleWidths(
  dict: PdfDict, resolve: Resolve,
): { widths: Map<number, number>; missing: number; hasMissing: boolean } | undefined {
  const arr = resolve(dict.get('Widths'));
  if (!isArray(arr)) return undefined;
  const firstChar = asNum(resolve(dict.get('FirstChar'))) ?? 0;
  const fd = resolve(dict.get('FontDescriptor'));
  const mw = isDict(fd) ? asNum(resolve(fd.get('MissingWidth'))) : undefined;
  const widths = new Map<number, number>();
  arr.forEach((w, i) => {
    const n = asNum(resolve(w));
    if (n !== undefined) widths.set(firstChar + i, n);
  });
  return { widths, missing: mw ?? 0, hasMissing: mw !== undefined };
}
```

- [ ] **Step 4: Add the lazy program source**

Add to `font.ts`'s imports:

```ts
import { gidForProgram, loadEmbeddedProgram, programAdvance } from './glyphprogram.js';
```

Add these fields to `TextFont`, beside `widthScale`:

```ts
  private hasMissingWidth = false;
  /** Built on the first code /Widths cannot cover, so a font with complete
   *  /Widths never parses its /FontFile*. */
  private readonly loadProgramWidths?: () => ((code: number) => number | undefined) | undefined;
  private programWidthFn?: (code: number) => number | undefined;
  private programWidthInit = false;
```

In the simple-font branch of the constructor, replace:

```ts
      const wt = parseSimpleWidths(dict, resolve);
      if (wt) { this.widths = wt.widths; this.defaultWidth = wt.missing; this.hasWidths = true; }
      else { this.hasWidths = false; this.stdWidths = std14Widths(this.name, this.simple); }
```

with:

```ts
      const wt = parseSimpleWidths(dict, resolve);
      if (wt) {
        this.widths = wt.widths; this.defaultWidth = wt.missing;
        this.hasWidths = true; this.hasMissingWidth = wt.hasMissing;
      } else { this.hasWidths = false; this.stdWidths = std14Widths(this.name, this.simple); }
      const simple = this.simple;
      this.loadProgramWidths = () => buildProgramWidths(dict, resolve, inflate, simple);
```

and add this module-level function beside `std14Widths`:

```ts
/**
 * Per-code advances from the embedded font program, in glyph space, or
 * `undefined` when the descriptor embeds none we can read.
 *
 * Consulted only where `/Widths` and an explicit `/MissingWidth` are both
 * silent. The name route is the one `imxw.2` built — `glyphNameResolver` over
 * the font's `/Encoding`, with the program's own encoding beneath it.
 */
function buildProgramWidths(
  dict: PdfDict, resolve: Resolve, inflate: Inflate, simple: (string | undefined)[] | undefined,
): ((code: number) => number | undefined) | undefined {
  const prog = loadEmbeddedProgram(dict.get('FontDescriptor'), resolve, inflate);
  if (!prog.sfnt && !prog.cff && !prog.type1) return undefined;
  const nameForCode = glyphNameResolver(
    resolveSimpleEncoding(dict, resolve), prog.type1?.builtinEncodingNames(),
  );
  const cache = new Map<number, number | undefined>();
  return (code) => {
    if (cache.has(code)) return cache.get(code);
    const gid = gidForProgram(prog, code, simple?.[code & 0xff] ?? '', nameForCode);
    const w = gid === undefined ? undefined : programAdvance(prog, gid);
    cache.set(code, w);
    return w;
  };
}
```

- [ ] **Step 5: Rewrite `advance`**

Replace `TextFont.advance` with:

```ts
  /**
   * Advance of one glyph in em units (glyph-space / 1000).
   *
   * **Invariant:** a composite font's `/W` array is keyed by **CID**, a simple
   * font's `/Widths` by character code. They coincide only under Identity
   * encoding, so this takes whichever key the font's own metrics use — pass a
   * code for a simple font and a CID for a composite one.
   *
   * **Invariant:** `/Widths` always wins, and an explicit `/MissingWidth` wins
   * over the embedded program. Both are statements the producer made. The
   * program answers only where the font is silent — which is where the
   * alternatives are a Standard-14 face the font is not, or an advance of zero.
   */
  private advance(key: number): number {
    if (this.hasWidths) {
      const w = this.widths?.get(key);
      if (w !== undefined) return w * this.widthScale;
      if (this.hasMissingWidth) return this.defaultWidth * this.widthScale;
      const pw = this.programWidth(key);
      if (pw !== undefined) return pw * this.widthScale;
      return this.defaultWidth * this.widthScale;
    }
    const pw = this.programWidth(key);
    if (pw !== undefined) return pw * this.widthScale;
    // The AFM fallback is a Standard-14 table, always at 1/1000 — a Type 3 font
    // with no /Widths is malformed and gets the same guess as any other font.
    return (this.stdWidths?.[key & 0xff] ?? ESTIMATED_WIDTH) / 1000;
  }

  /** The embedded program's advance for `code`, loading the program on first use. */
  private programWidth(code: number): number | undefined {
    if (!this.programWidthInit) {
      this.programWidthInit = true;
      this.programWidthFn = this.loadProgramWidths?.();
    }
    return this.programWidthFn?.(code);
  }
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/font-program-widths.test.ts test/font.test.ts test/text.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: green. This changes measured widths for any fixture whose `/Widths`
does not cover every code it shows, so a failure here is real information —
check whether the new width is the *correct* one before changing anything.

- [ ] **Step 8: Commit**

```bash
git add src/font.ts test/font-program-widths.test.ts
git commit -m "$(cat <<'EOF'
feat(font): take glyph widths from the embedded program when /Widths cannot (imxw.4)

Two failures, both silent. With no /Widths a font measured from the Standard-14
AFM table for whichever face /BaseFont normalises onto, so an embedded
/AAAAAB+MyCustomFont measured as Helvetica while the renderer drew its real
outlines. With /Widths present but short, a code past LastChar took
/MissingWidth's default of zero and the glyphs piled up.

/Widths still always wins, and an explicit /MissingWidth still wins over the
program — both are statements the producer made. parseSimpleWidths now reports
whether /MissingWidth was present, which it previously collapsed into ?? 0.

The program loads on the first code that needs it, so a font with complete
/Widths never touches its /FontFile*.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Real-font cross-checks and acceptance

**Files:**
- Modify: `test/type1-real.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the width cross-checks**

Append to `test/type1-real.test.ts`, adding these imports at the top:

```ts
import { TextFont } from '../src/font.js';
import { loadEmbeddedProgram, programAdvance, gidForProgram } from '../src/glyphprogram.js';
import { PdfDict, PdfObject, PdfStream, name as pdfName } from '../src/types.js';
```

```ts
describe('embedded-program widths against the AFM', () => {
  const id = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
  const inflate = (s: { raw: Uint8Array }) => s.raw;
  const dict = (e: Record<string, PdfObject>): PdfDict => new Map(Object.entries(e));
  const stream = (raw: Uint8Array): PdfStream => ({ kind: 'stream', dict: new Map(), raw });
  const t1Bytes = new Uint8Array(readFileSync(new URL('NimbusSans-Regular.t1', DIR)));
  const otfBytes = new Uint8Array(readFileSync(new URL('NimbusSans-Regular.otf', DIR)));

  it('reports the AFM advance for every Type 1 glyph, normalised', () => {
    const prog = loadEmbeddedProgram(dict({ FontFile: stream(t1Bytes) }), id, inflate);
    const bad: string[] = [];
    for (const [name, m] of metrics) {
      const gid = prog.type1!.gidForName(name);
      if (gid === undefined) continue;
      const w = programAdvance(prog, gid)!;
      if (Math.abs(w - m.wx) > 0.5) bad.push(`${name}: ${w} != AFM ${m.wx}`);
    }
    expect(bad).toEqual([]);
  });

  it('reports the AFM advance through the CFF path too', () => {
    // The same design, same metrics, read through the charstring width prefix
    // rather than hsbw — a second program kind against one oracle.
    const prog = loadEmbeddedProgram(dict({ FontFile3: stream(otfBytes) }), id, inflate);
    const names = prog.cff!.charsetNames();
    const bad: string[] = [];
    let checked = 0;
    for (let gid = 1; gid < names.length; gid++) {
      const n = names[gid];
      const m = n ? metrics.get(n) : undefined;
      if (!m) continue;
      checked++;
      const w = programAdvance(prog, gid)!;
      if (Math.abs(w - m.wx) > 0.5) bad.push(`${n}: ${w} != AFM ${m.wx}`);
    }
    expect(checked).toBeGreaterThan(600);
    expect(bad).toEqual([]);
  });

  it('measures a /Widths-less font dict at the AFM advances', () => {
    // The acceptance case: the whole chain, from font dict to em width.
    const font = new TextFont(dict({
      Subtype: pdfName('Type1'), BaseFont: pdfName('AAAAAB+NimbusSans-Regular'),
      FontDescriptor: dict({ FontFile: stream(t1Bytes) }),
    }), id, inflate);
    for (const ch of ['A', 'i', 'W', 'space']) {
      const code = ch === 'space' ? 0x20 : ch.charCodeAt(0);
      const expected = metrics.get(ch === 'space' ? 'space' : ch)!.wx / 1000;
      expect(font.decodeGlyphs(Uint8Array.from([code]))[0].width).toBeCloseTo(expected, 5);
    }
  });
});
```

- [ ] **Step 2: Add the end-to-end acceptance case**

The issue's criterion names `GetTextFragments`, so the chain must be asserted at
that level too, not only at `TextFont`. `buildType1Pdf` from `imxw.2` always
writes a `/Widths` array; give it an option not to.

In `test/helpers/build-type1-pdf.ts`, add to `Type1PdfOptions`:

```ts
  /** Omit /Widths entirely, so the font must measure from its own program. */
  omitWidths?: boolean;
```

and replace the object-4 line with:

```ts
  const widths = opts.omitWidths
    ? ''
    : ` /FirstChar 65 /LastChar 90 /Widths [${Array(26).fill(1000).join(' ')}]`;
  objs[4] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /TestFont'
    + `${encEntry}${widths} /FontDescriptor 6 0 R >>`);
```

Then append to `test/type1-real.test.ts`:

```ts
  it('spaces GetTextFragments by the program advances, with no /Widths', () => {
    // The issue's acceptance criterion, end to end. 'AVA' at 20pt: each gap is
    // the AFM advance of the preceding glyph, scaled by the font size.
    const pdf = buildType1Pdf(t1Bytes, { text: 'AVA', size: 20, omitWidths: true });
    const frags = Document.Open(pdf).Pages[0].GetTextFragments();
    const glyphs = frags.flatMap((f) => f.text.split('').map((ch, i) => ({ ch, f, i })));
    expect(glyphs.length).toBeGreaterThanOrEqual(3);
    // Fragment x positions advance by the AFM widths of A then V.
    const xs = frags.map((f) => f.x);
    const total = frags[frags.length - 1].x - frags[0].x;
    const expected = ((metrics.get('A')!.wx + metrics.get('V')!.wx) / 1000) * 20;
    // One fragment per run is the common shape; if the run is not split, the
    // width of the single fragment carries the same information.
    if (frags.length > 1) expect(total).toBeCloseTo(expected, 1);
    else expect(frags[0].width).toBeCloseTo(
      ((metrics.get('A')!.wx * 2 + metrics.get('V')!.wx) / 1000) * 20, 1);
    expect(xs[0]).toBeCloseTo(10, 1);            // the Td in buildType1Pdf
  });
```

Add `Document` and `buildType1Pdf` to the file's imports:

```ts
import { Document } from '../src/document.js';
import { buildType1Pdf } from './helpers/build-type1-pdf.js';
```

Before writing the assertions, run the test once and print `frags` to see
whether `GetTextFragments` splits `AVA` into one fragment or three — the shape
decides which branch above is live, and the other should then be deleted rather
than left as dead cover.

- [ ] **Step 3: Run it**

Run: `npx vitest run test/type1-real.test.ts`
Expected: PASS.

If the CFF case reports a handful of mismatches, check whether those glyphs are
`seac` composites before touching the tolerance — record the exception in
`PROVENANCE.md` rather than widening `0.5`.

- [ ] **Step 4: Prove the new assertions load-bearing**

Break each, confirm red, revert:

| Mutation | Must fail |
|---|---|
| `programAdvance` drops `* 1000 / upm` | the 2048/em case in `glyphprogram.test.ts` |
| `advance` consults the program before `/Widths` | the precedence case |
| `parseSimpleWidths` sets `hasMissing: true` always | the past-LastChar case |
| `CffFont.glyphWidth` returns the raw operand, not `nominal + operand` | the CFF AFM case |

- [ ] **Step 5: Record the fixture's new role**

Append to the `NimbusSans-Regular.t1 + .afm` section of
`test/fixtures/fonts/PROVENANCE.md`, under a `### Also covers` heading: the AFM
now serves a second consumer — `glyphprogram.ts`'s normalised advance for the
Type 1 *and* CFF paths — and the `.otf` beside it is checked against the same
AFM, so one oracle validates two independent width readers.

- [ ] **Step 6: Commit**

```bash
git add test/type1-real.test.ts test/helpers/build-type1-pdf.ts test/fixtures/fonts/PROVENANCE.md
git commit -m "$(cat <<'EOF'
test(font): embedded-program widths against the AFM (imxw.4)

One oracle, two independent width readers: hsbw for the Type 1 program and the
Type 2 charstring width prefix for the CFF of the same design. Neither path
reads the AFM, so neither can cancel out an error in it.

Plus the acceptance case end to end — a font dict with no /Widths measuring at
the AFM advances rather than at Helvetica's.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Documentation and close-out

**Files:**
- Modify: `CLAUDE.md` (the `text.ts`/`font.ts` bullet), `README.md`

- [ ] **Step 1: Record the invariants in CLAUDE.md**

Add `glyphprogram.ts` to the architecture list beside `font.ts`, and record:

```markdown
  **Invariant:** "what program does this descriptor embed, which glyph does a
  code select in it, and how wide is that glyph" has one owner,
  **glyphprogram.ts**. `raster.ts` asked all three for rendering and `font.ts`
  needs the third for measurement, but `raster.ts` imports `font.ts`, so the
  alternative was a second copy — which is how `gidForCode`'s two callers would
  come to disagree about a glyph. The module takes `resolve`/`inflate` and the
  name resolver as *arguments* rather than importing `font.ts` or `document.ts`;
  that is what keeps `font.ts -> glyphprogram.ts` free of a cycle.
  **Invariant:** `programAdvance` returns 1/1000 em, never font units. The three
  programs report in three different spaces — `hsbw` in glyph space, a CFF
  charstring width in charstring units, `hmtx` in font units — and only the
  first two are reliably 1000/em. A TrueType is commonly 2048, so an
  unnormalised advance is 2.048x too wide, which looks like a plausible wide
  face rather than a bug. `hmtx` outranks the CFF charstring width when both
  exist, which is the OpenType-CFF case.
  **Invariant:** `/Widths` always wins, and an explicit `/MissingWidth` wins
  over the embedded program; both are statements the producer made, including a
  deliberate `/MissingWidth 0` for codes that should not advance. The program
  answers only where the font is silent. `parseSimpleWidths` therefore reports
  whether `/MissingWidth` was *present*, which it used to collapse into `?? 0` —
  losing the difference between "the font says zero" and "the font says
  nothing", which want opposite treatment.
  **Invariant:** the program is loaded on the first code `/Widths` cannot cover,
  never at construction. Nearly every font carries complete `/Widths`, and those
  must not pay to parse a `/FontFile2` that will never be consulted.
  **Note:** a Type 3 font's `/FontMatrix` skew terms `b` and `c` are correctly
  absent from the advance while `drawType3Run` applies them to the ink. 32000-1
  9.4.4 makes the displacement a scalar along the writing direction, so only the
  `a` term reaches the pen. This is settled, not an outstanding gap.
```

- [ ] **Step 2: Update README.md**

In the `Rendering (page → PNG)` paragraph at line 58, the substitute-face
sentence currently ends:

> resolved by Unicode through each substitute's cmap while advances still follow the PDF's own widths; any glyph the substitute cannot resolve falls back to a low-coverage placeholder box.

Append a sentence after it:

> When a simple font's `/Widths` cannot answer — absent entirely, or short of the codes actually shown with no `/MissingWidth` — advances come from the embedded program itself (Type 1 `hsbw`, the CFF charstring width, or TrueType `hmtx`, each normalised out of its own units-per-em) rather than from a Standard-14 face the font is not.

- [ ] **Step 3: Run both gates**

```bash
npm run typecheck
npm test
```
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs(font): embedded-program width invariants (imxw.4)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Close the issue and the epic, then push**

```bash
bd close aspose-pdf-foss-for-ts-imxw.4
bd show aspose-pdf-foss-for-ts-imxw      # 4/4 — close the epic if bd does not
git add .beads/
git commit -m "chore(beads): sync interactions log for imxw.4

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status                               # MUST show up to date with origin
```

- [ ] **Step 6: File the follow-up**

```bash
bd create "Composite-font widths from the embedded program" -t feature -p 3 -d "imxw.4 gives simple fonts their advances from the embedded program when /Widths cannot answer. A composite font is unaffected: /W is keyed by CID and /DW supplies a real default of 1000, so neither failure mode applies — but a CIDFont whose /W omits a CID it shows still advances by /DW rather than by what the program says. Lower value than the simple-font case and untested against any real file; filed so the asymmetry is recorded rather than forgotten."
```

---

## Verification checklist

- [ ] `npm run typecheck` clean
- [ ] `npm test` green, and Task 3's counts identical to its own baseline
- [ ] All four Task 5 Step 3 mutations confirmed failing, and reverted
- [ ] `test/fixtures/fonts/PROVENANCE.md` records the AFM's second role
- [ ] `git status` shows the branch up to date with origin
- [ ] `aspose-pdf-foss-for-ts-imxw.4` closed; epic `imxw` at 4/4
