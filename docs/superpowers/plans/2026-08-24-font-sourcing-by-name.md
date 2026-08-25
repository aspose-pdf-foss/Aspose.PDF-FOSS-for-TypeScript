# Font sourcing by name Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.LoadFontByName('Liberation Sans')` finds and embeds a font by family name from folders the caller registered, and optionally from the platform's own font directories.

**Architecture:** A pure leaf reads an sfnt's `name`/`head`/`OS/2` fields and nothing else; a second module scans folders and builds a cached index using *partial* file reads, so indexing thousands of system fonts costs kilobytes each rather than whole files; `document.ts` gains three methods over that index.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, `node:fs`/`node:path`/`node:os` only.

**Spec:** `docs/superpowers/specs/2026-08-24-font-sourcing-by-name-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries `.js`.
- **`fontnames.ts` is a PURE leaf** — it imports nothing but `./types.js`-free primitives (in practice, nothing at all). No `node:fs`, no PDF objects.
- **`fontsource.ts` is the only new module touching `node:fs`.**
- **Nothing in this feature throws.** A missing folder, an unreadable file, a malformed sfnt and a `.ttc` are each skipped, and the lookup continues.
- **A miss returns `undefined`**, never a substituted face and never an exception.
- **System font directories are opt-in**, via `RegisterSystemFonts()`.
- **Matching is exact family name, case-insensitive, whitespace-trimmed.** No style parsing — that is `l1my.3`.
- **Always run `npm run typecheck` and `npm test` before closing.**
- **CHANGELOG.md** under `## [Unreleased]` in the same commit as any user-visible change.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/fontnames.ts` | **new, pure leaf.** Parse an sfnt table directory; read `name` + `head` + `OS/2` into a `FontNames`. Three exports so the indexer can read tables piecemeal and `sfnt.ts` can read a whole buffer. |
| `src/fontsource.ts` | **new.** `systemFontFolders()`, and `indexFolder()` — recursive scan, partial reads, process-wide cache. |
| `src/sfnt.ts` | `readPostScriptName` deleted; `parseSfnt` uses `fontnames.ts`. |
| `src/document.ts` | `RegisterFontFolder`, `RegisterSystemFonts`, `LoadFontByName`. |
| `test/helpers/build-sfnt.ts` | gains `buildNameRecords` (an arbitrary `name` table) and `buildNamedFont` (a whole sfnt with chosen names/style). |
| `test/fontnames.test.ts` | **new.** The reader, from hand-built bytes. |
| `test/fontsource.test.ts` | **new.** The scan, over `mkdtempSync` folders. |
| `test/font-byname.test.ts` | **new.** The three `Document` methods end to end. |

---

## Task 1: `fontnames.ts` — the cheap name reader

**Files:**
- Create: `src/fontnames.ts`
- Modify: `test/helpers/build-sfnt.ts` (add `buildNameRecords`, `buildNamedFont`)
- Test: `test/fontnames.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface FontNames { family: string; subfamily: string; typographicFamily?: string; typographicSubfamily?: string; postScriptName?: string; bold: boolean; italic: boolean; weight: number }`
  - `interface TableRange { offset: number; length: number }`
  - `parseTableDirectory(header: Uint8Array): Map<string, TableRange> | undefined`
  - `namesFromTables(t: { name?: Uint8Array; head?: Uint8Array; os2?: Uint8Array }): FontNames | undefined`
  - `readFontNames(bytes: Uint8Array): FontNames | undefined`

  Task 2 calls `readFontNames`; Task 4 calls `parseTableDirectory` and `namesFromTables`.

- [ ] **Step 1: Add the test-helper builders**

Append to `test/helpers/build-sfnt.ts`:

```ts
/** A `name` table from arbitrary records. `plat` 3 encodes UTF-16BE (the
 *  Windows convention), any other value ASCII. */
export function buildNameRecords(
  records: { plat: number; nameID: number; text: string }[],
): Uint8Array {
  const encoded = records.map((r) => {
    if (r.plat === 3) {
      const b = new Uint8Array(r.text.length * 2);
      for (let i = 0; i < r.text.length; i++) {
        b[i * 2] = r.text.charCodeAt(i) >> 8;
        b[i * 2 + 1] = r.text.charCodeAt(i) & 0xff;
      }
      return b;
    }
    return new TextEncoder().encode(r.text);
  });
  const stringOffset = 6 + records.length * 12;
  const parts: Uint8Array[] = [concat([u16(0), u16(records.length), u16(stringOffset)])];
  let off = 0;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    parts.push(concat([
      u16(r.plat), u16(r.plat === 3 ? 1 : 0), u16(0), u16(r.nameID),
      u16(encoded[i].length), u16(off),
    ]));
    off += encoded[i].length;
  }
  return concat([...parts, ...encoded]);
}

/**
 * A whole glyf sfnt carrying the given names and style.
 *
 * `padGlyf` inflates the `glyf` table so the `name` table lands well past any
 * fixed prefix a reader might optimistically grab — the shape Task 4's partial
 * reads must survive.
 */
export function buildNamedFont(opts: {
  family: string; subfamily?: string;
  typographicFamily?: string;
  bold?: boolean; italic?: boolean; weight?: number;
  padGlyf?: number;
}): Uint8Array {
  const recs = [
    { plat: 3, nameID: 1, text: opts.family },
    { plat: 3, nameID: 2, text: opts.subfamily ?? 'Regular' },
    { plat: 3, nameID: 6, text: opts.family.replace(/\s+/g, '') },
  ];
  if (opts.typographicFamily) recs.push({ plat: 3, nameID: 16, text: opts.typographicFamily });

  const head = buildHead();
  new DataView(head.buffer, head.byteOffset).setUint16(
    44, (opts.bold ? 1 : 0) | (opts.italic ? 2 : 0));

  const os2 = buildOS2();
  new DataView(os2.buffer, os2.byteOffset).setUint16(4, opts.weight ?? 400);

  // TWO glyphs (.notdef + one box), then padding so `glyf` can be made
  // arbitrarily large. The maxp/hhea/hmtx below are built locally rather than
  // taken from the exported buildMaxp/buildHhea/buildHmtx: those declare THREE
  // glyphs, and parseSfnt reads numGlyphs+1 loca entries, so a 3-entry loca
  // would be read one entry past its end. `assembleGlyfFont` in this file
  // builds its own tables for exactly that reason.
  const g1 = buildSimpleGlyph([[100, 0, 900, 0, 900, 700, 100, 700]]);
  const pad = (opts.padGlyf ?? 0) & ~1;         // even: loca stores offset/2
  const glyf = concat([g1, new Uint8Array(pad)]);
  const loca = concat([u16(0), u16(0), u16((g1.length + pad) / 2)]);
  const maxp = new Uint8Array(32);
  { const v = new DataView(maxp.buffer); v.setUint32(0, 0x00010000); v.setUint16(4, 2); }
  const hhea = new Uint8Array(36);
  { const v = new DataView(hhea.buffer); v.setUint32(0, 0x00010000); v.setInt16(4, 800); v.setInt16(6, -200); v.setUint16(34, 2); }
  const hmtx = concat([u16(1000), i16(0), u16(1000), i16(0)]);

  const tables = [
    { tag: 'OS/2', data: os2 }, { tag: 'cmap', data: buildCmap() },
    { tag: 'glyf', data: glyf }, { tag: 'head', data: head },
    { tag: 'hhea', data: hhea }, { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: loca }, { tag: 'maxp', data: maxp },
    { tag: 'name', data: buildNameRecords(recs) }, { tag: 'post', data: buildPost() },
  ];
  // `name` LAST in the file body, after the padded glyf, which is the layout
  // the partial-read test needs. The directory stays tag-sorted as required.
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  let offset = 12 + tables.length * 16;
  const order = [...tables].sort((a, b) => (a.tag === 'name' ? 1 : b.tag === 'name' ? -1 : 0));
  const at = new Map<string, number>();
  const bodies: Uint8Array[] = [];
  for (const t of order) { at.set(t.tag, offset); const p = pad4(t.data); offset += p.length; bodies.push(p); }
  const dir = concat(tables.map((t) => concat([
    new TextEncoder().encode(t.tag), u32(0), u32(at.get(t.tag)!), u32(t.data.length),
  ])));
  return concat([concat([u32(0x00010000), u16(tables.length), u16(0), u16(0), u16(0)]), dir, ...bodies]);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/fontnames.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFontNames, parseTableDirectory, namesFromTables } from '../src/fontnames.js';
import { buildNamedFont, buildNameRecords } from './helpers/build-sfnt.js';

describe('readFontNames', () => {
  it('reads family, subfamily and PostScript name', () => {
    const n = readFontNames(buildNamedFont({ family: 'Liberation Sans' }));
    expect(n).toBeDefined();
    expect(n!.family).toBe('Liberation Sans');
    expect(n!.subfamily).toBe('Regular');
    expect(n!.postScriptName).toBe('LiberationSans');
  });

  it('reads the typographic family (ID 16) when the font states one', () => {
    // ID 16 exists because ID 1 is capped at four styles per family: a font
    // with nine weights states 'Foo' in 16 and 'Foo Semibold' in 1, so a
    // reader using only ID 1 splits one family into several.
    const n = readFontNames(buildNamedFont({
      family: 'Foo Semibold', typographicFamily: 'Foo',
    }));
    expect(n!.family).toBe('Foo Semibold');
    expect(n!.typographicFamily).toBe('Foo');
  });

  it('reads style from head.macStyle and weight from OS/2', () => {
    const n = readFontNames(buildNamedFont({
      family: 'Foo', bold: true, italic: true, weight: 700,
    }));
    expect(n!.bold).toBe(true);
    expect(n!.italic).toBe(true);
    expect(n!.weight).toBe(700);
  });

  it('decodes a platform-1 ASCII record as well as platform-3 UTF-16BE', () => {
    const name = buildNameRecords([
      { plat: 1, nameID: 1, text: 'MacFamily' },
      { plat: 1, nameID: 2, text: 'Bold' },
    ]);
    const n = namesFromTables({ name });
    expect(n!.family).toBe('MacFamily');
    expect(n!.subfamily).toBe('Bold');
  });

  it('prefers a platform-3 record over a platform-1 one for the same ID', () => {
    // Both spellings are legal and a font may carry both. Windows records are
    // the ones real tooling reads, so a reader that took whichever came first
    // would disagree with every other consumer on some fonts and not others.
    const name = buildNameRecords([
      { plat: 1, nameID: 1, text: 'MacName' },
      { plat: 3, nameID: 1, text: 'WinName' },
    ]);
    expect(namesFromTables({ name })!.family).toBe('WinName');
  });

  it('declines a ttcf collection, a WOFF wrapper and garbage', () => {
    const ttcf = new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0]);
    const woff = new Uint8Array([0x77, 0x4f, 0x46, 0x46, 0, 1, 0, 0]);
    expect(readFontNames(ttcf)).toBeUndefined();
    expect(readFontNames(woff)).toBeUndefined();
    expect(readFontNames(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe('parseTableDirectory', () => {
  it('locates every table by tag, offset and length', () => {
    const font = buildNamedFont({ family: 'Foo' });
    const dir = parseTableDirectory(font)!;
    expect(dir.get('name')).toBeDefined();
    const { offset, length } = dir.get('name')!;
    // The slice the directory names must itself parse as a name table.
    expect(namesFromTables({ name: font.subarray(offset, offset + length) })!.family).toBe('Foo');
  });

  it('declines a header too short to hold its own directory', () => {
    expect(parseTableDirectory(new Uint8Array(8))).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/fontnames.test.ts`
Expected: FAIL — cannot resolve `../src/fontnames.js`.

- [ ] **Step 4: Write `src/fontnames.ts`**

```ts
/**
 * An sfnt's naming and style fields, read as cheaply as possible.
 *
 * A pure leaf, imported by `sfnt.ts` (which wants the PostScript name) and by
 * `fontsource.ts` (which wants family names for thousands of files at a time).
 * That second caller is why the module is split three ways: it reads the table
 * directory, then only the byte ranges `name`, `head` and `OS/2` occupy, and
 * never the whole file.
 */

export interface FontNames {
  /** Name ID 1. */
  family: string;
  /** Name ID 2 -- 'Regular', 'Bold Italic', ... */
  subfamily: string;
  /** Name ID 16, where the font states one. */
  typographicFamily?: string;
  /** Name ID 17, where the font states one. */
  typographicSubfamily?: string;
  /** Name ID 6. */
  postScriptName?: string;
  /** head.macStyle bit 0. */
  bold: boolean;
  /** head.macStyle bit 1. */
  italic: boolean;
  /** OS/2.usWeightClass; 400 when the table is absent or says 0. */
  weight: number;
}

export interface TableRange { offset: number; length: number }

/** sfnt signatures this module accepts. `ttcf` is a COLLECTION, not a font --
 *  its faces are addressed through an offset table (`l1my.2`) -- and the two
 *  WOFF wrappers must be reconstructed before anything can be read. */
const SFNT_SIGS = new Set([0x00010000, 0x4f54544f /* OTTO */, 0x74727565 /* true */]);

const u16 = (d: Uint8Array, o: number): number => (d[o] << 8) | d[o + 1];
const u32 = (d: Uint8Array, o: number): number =>
  ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

/**
 * Map every table tag to its byte range.
 *
 * `header` need only be long enough to hold the 12-byte offset table plus
 * `numTables` 16-byte entries -- the indexer reads exactly that much and no
 * more. Returns undefined for a non-sfnt or a truncated directory.
 */
export function parseTableDirectory(header: Uint8Array): Map<string, TableRange> | undefined {
  if (header.length < 12) return undefined;
  if (!SFNT_SIGS.has(u32(header, 0))) return undefined;
  const numTables = u16(header, 4);
  if (header.length < 12 + numTables * 16) return undefined;
  const out = new Map<string, TableRange>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(header[rec], header[rec + 1], header[rec + 2], header[rec + 3]);
    out.set(tag, { offset: u32(header, rec + 8), length: u32(header, rec + 12) });
  }
  return out;
}

/** One decoded name record: its text plus whether it came from platform 3. */
interface NameRec { text: string; win: boolean }

/** Decode the name table into nameID -> best record. */
function readNameTable(data: Uint8Array): Map<number, NameRec> {
  const out = new Map<number, NameRec>();
  if (data.length < 6) return out;
  const count = u16(data, 2), stringOffset = u16(data, 4);
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > data.length) break;
    const plat = u16(data, rec);
    const nameID = u16(data, rec + 6);
    const len = u16(data, rec + 8), off = u16(data, rec + 10);
    const start = stringOffset + off;
    if (start + len > data.length) continue;
    const bytes = data.subarray(start, start + len);
    let text: string;
    if (plat === 3) {                       // UTF-16BE
      text = '';
      for (let j = 0; j + 1 < bytes.length; j += 2) {
        text += String.fromCharCode((bytes[j] << 8) | bytes[j + 1]);
      }
    } else {
      text = String.fromCharCode(...bytes); // platform 1 / 0, ASCII
    }
    const prev = out.get(nameID);
    // A font may carry BOTH spellings of one ID. Windows records are what real
    // tooling reads, so preferring them keeps this reader agreeing with every
    // other consumer -- taking whichever came first would agree on some fonts
    // and not others.
    if (!prev || (plat === 3 && !prev.win)) out.set(nameID, { text, win: plat === 3 });
  }
  return out;
}

/** Assemble a `FontNames` from the three tables that carry it. Any may be
 *  absent: a font with no `name` table has no family and is declined; missing
 *  `head` or `OS/2` only cost the style fields their defaults. */
export function namesFromTables(
  t: { name?: Uint8Array; head?: Uint8Array; os2?: Uint8Array },
): FontNames | undefined {
  if (!t.name) return undefined;
  const recs = readNameTable(t.name);
  const family = recs.get(1)?.text;
  if (!family) return undefined;

  const macStyle = t.head && t.head.length >= 46 ? u16(t.head, 44) : 0;
  const weight = t.os2 && t.os2.length >= 6 ? u16(t.os2, 4) || 400 : 400;

  return {
    family,
    subfamily: recs.get(2)?.text ?? 'Regular',
    typographicFamily: recs.get(16)?.text,
    typographicSubfamily: recs.get(17)?.text,
    postScriptName: recs.get(6)?.text,
    bold: (macStyle & 1) !== 0,
    italic: (macStyle & 2) !== 0,
    weight,
  };
}

/** Read the naming and style fields from a whole sfnt buffer. */
export function readFontNames(bytes: Uint8Array): FontNames | undefined {
  const dir = parseTableDirectory(bytes);
  if (!dir) return undefined;
  const slice = (tag: string): Uint8Array | undefined => {
    const r = dir.get(tag);
    if (!r || r.offset + r.length > bytes.length) return undefined;
    return bytes.subarray(r.offset, r.offset + r.length);
  };
  return namesFromTables({ name: slice('name'), head: slice('head'), os2: slice('OS/2') });
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/fontnames.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/fontnames.ts test/fontnames.test.ts test/helpers/build-sfnt.ts
git commit -m "feat(l1my.1): fontnames.ts, an sfnt name reader that reads nothing else

Matching a font by family needs name IDs 1, 2 and 16; sfnt.ts reads only
ID 6. This is a pure leaf that parses the table directory and then only
the name, head and OS/2 ranges -- split three ways so a folder indexer can
read those ranges out of a file without loading the whole font.

A platform-3 record outranks a platform-1 one for the same ID: a font may
carry both, and taking whichever came first would agree with other tooling
on some fonts and not others.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `sfnt.ts` reads names through the new owner

**Files:**
- Modify: `src/sfnt.ts` (delete `readPostScriptName` at lines 357-374; change its call site)
- Test: the existing suite is the fence — no new test.

**Interfaces:**
- Consumes: `readFontNames` from `./fontnames.js` (Task 1).
- Produces: nothing new. `SfntFont.postScriptName` keeps its meaning.

- [ ] **Step 1: Delete the private reader**

Remove the whole `readPostScriptName` function from `src/sfnt.ts` — the block beginning `/** Read the PostScript name (nameID 6) from the name table, if present. */` and ending with its closing `}`.

- [ ] **Step 2: Point `parseSfnt` at the shared reader**

In `parseSfnt`, replace:

```ts
  const name = f.table('name', false);
  if (name) f.postScriptName = readPostScriptName(name);
```

with:

```ts
  // Through fontnames.ts, the one owner of the name table: two readings would
  // otherwise be free to disagree about platform preference or UTF-16 decoding.
  f.postScriptName = readFontNames(bytes)?.postScriptName;
```

and add to the imports at the top of the file:

```ts
import { readFontNames } from './fontnames.js';
```

Note `readFontNames` takes the WHOLE buffer, and `bytes` at that point is already the reconstructed sfnt (WOFF has been unwrapped above), so it parses the same directory `f.tables` holds.

- [ ] **Step 3: Run the fence**

Run:

```bash
npx vitest run test/sfnt.test.ts test/embed-font.test.ts test/fontembed.test.ts test/woff.test.ts test/fontnames.test.ts
```

Expected: PASS. `fontembed.ts` uses `font.postScriptName` for the embedded font's `/BaseFont`, so a regression here shows up as a wrong or missing name in those tests.

If a test file in that list does not exist, run `npx vitest run` over the whole suite instead and rely on it.

- [ ] **Step 4: Full suite**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add src/sfnt.ts
git commit -m "refactor(l1my.1): sfnt.ts reads the name table through fontnames.ts

It walked the name records itself for ID 6 alone. One owner for that table
means the two readings cannot disagree about platform-ID preference or
UTF-16 decoding -- which they were free to do, since fontnames.ts prefers
a platform-3 record and the deleted code took the first match.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `fontsource.ts` — the platform folder list

**Files:**
- Create: `src/fontsource.ts`
- Test: `test/fontsource.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `systemFontFolders(): string[]`. Task 5 calls it.

- [ ] **Step 1: Write the failing test**

Create `test/fontsource.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { systemFontFolders } from '../src/fontsource.js';

describe('systemFontFolders', () => {
  it('names the current platform’s font directories', () => {
    // Asserted by SHAPE, never by contents: a test that checked which folders
    // exist would pass or fail on what the machine happens to have installed,
    // which is the machine-dependence this whole feature is designed to keep
    // out of the default path.
    const dirs = systemFontFolders();
    expect(dirs.length).toBeGreaterThan(0);
    expect(new Set(dirs).size).toBe(dirs.length);      // no duplicates
    for (const d of dirs) expect(typeof d).toBe('string');

    if (process.platform === 'win32') {
      expect(dirs.some((d) => /[\\/]Fonts$/i.test(d))).toBe(true);
    } else if (process.platform === 'darwin') {
      expect(dirs).toContain('/System/Library/Fonts');
      expect(dirs).toContain('/Library/Fonts');
    } else {
      expect(dirs).toContain('/usr/share/fonts');
      expect(dirs.some((d) => d.endsWith('.fonts'))).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fontsource.test.ts`
Expected: FAIL — cannot resolve `../src/fontsource.js`.

- [ ] **Step 3: Write the module's first half**

Create `src/fontsource.ts`:

```ts
/**
 * Finding font files on disk, and reading just enough of each to know what
 * family it is.
 *
 * The only module in this feature that touches the filesystem. Its shape is
 * driven by cost: a system font directory holds thousands of faces and a CJK
 * font runs to tens of megabytes, so an index that read whole files would turn
 * one lookup into hundreds of megabytes of I/O.
 */
import { openSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseTableDirectory, namesFromTables, type FontNames } from './fontnames.js';

/** A face found on disk. */
export interface FaceRecord {
  /** Path of the file this face was read from. */
  path: string;
  names: FontNames;
}

/**
 * The platform's font directories, in search order.
 *
 * Returned whether or not they exist -- no machine has every directory named
 * here, and `indexFolder` skips what is absent rather than treating it as an
 * error.
 */
export function systemFontFolders(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const win = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
    const local = process.env.LOCALAPPDATA;
    const dirs = [join(win, 'Fonts')];
    if (local) dirs.push(join(local, 'Microsoft', 'Windows', 'Fonts'));
    return dirs;
  }
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library', 'Fonts')];
  }
  return [
    '/usr/share/fonts', '/usr/local/share/fonts',
    join(home, '.local', 'share', 'fonts'), join(home, '.fonts'),
  ];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/fontsource.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add src/fontsource.ts test/fontsource.test.ts
git commit -m "feat(l1my.1): systemFontFolders, the platform font directory list

Returned whether or not they exist: no machine has every directory named,
and the scan skips what is absent rather than calling it an error. The
test asserts SHAPE only -- checking which folders exist would make the
suite depend on what the machine has installed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `fontsource.ts` — the scan, the partial reads and the cache

**Files:**
- Modify: `src/fontsource.ts` (append)
- Test: `test/fontsource.test.ts` (append)

**Interfaces:**
- Consumes: `parseTableDirectory`, `namesFromTables` from `./fontnames.js` (Task 1).
- Produces: `indexFolder(dir: string): FaceRecord[]`. Task 5 calls it.

- [ ] **Step 1: Write the failing tests**

Append to `test/fontsource.test.ts`, extending its imports to
`import { systemFontFolders, indexFolder } from '../src/fontsource.js';`
plus:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNamedFont } from './helpers/build-sfnt.js';
```

and then:

```ts
/** A throwaway folder holding the given files. */
function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-fonts-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
  }
  return dir;
}

describe('indexFolder', () => {
  it('finds a font and reports its family', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const faces = indexFolder(dir);
    expect(faces).toHaveLength(1);
    expect(faces[0].names.family).toBe('Alpha Sans');
    expect(faces[0].path).toBe(join(dir, 'a.ttf'));
  });

  it('descends into subdirectories', () => {
    // Linux nests fonts as /usr/share/fonts/truetype/dejavu/..., so a flat
    // readdir finds nothing at all on that platform.
    const dir = folderWith({
      'truetype/vendor/b.ttf': buildNamedFont({ family: 'Beta Sans' }),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Beta Sans']);
  });

  it('reads a font whose name table sits past a large glyf table', () => {
    // The partial-read scheme's sharp edge: a reader that optimistically
    // grabbed a fixed prefix would find no name here and the font would look
    // simply absent rather than unreadable.
    const dir = folderWith({
      'big.ttf': buildNamedFont({ family: 'Gamma Sans', padGlyf: 200_000 }),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Gamma Sans']);
  });

  it('skips what it cannot use and keeps going', () => {
    // Each skip is paired with a VALID face in the same folder: a skip test
    // that does not prove the scan continued is worth very little.
    const dir = folderWith({
      'good.ttf': buildNamedFont({ family: 'Delta Sans' }),
      'truncated.ttf': buildNamedFont({ family: 'Nope' }).subarray(0, 40),
      'garbage.otf': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      'collection.ttc': new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0]),
      'notes.txt': new TextEncoder().encode('not a font'),
    });
    expect(indexFolder(dir).map((f) => f.names.family)).toEqual(['Delta Sans']);
  });

  it('returns an empty list for a folder that does not exist', () => {
    // The normal case for RegisterSystemFonts: no machine has every directory.
    expect(indexFolder(join(tmpdir(), 'pdf4ts-no-such-folder-xyz'))).toEqual([]);
  });

  it('caches by path: a second call does not re-read the folder', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Epsilon Sans' }) });
    const first = indexFolder(dir);
    // A file added after the first scan is deliberately NOT seen -- the cache
    // lives for the process, and stat-polling every file per lookup would cost
    // most of what it saves.
    writeFileSync(join(dir, 'b.ttf'), buildNamedFont({ family: 'Zeta Sans' }));
    const second = indexFolder(dir);
    expect(second).toBe(first);
    expect(second.map((f) => f.names.family)).toEqual(['Epsilon Sans']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/fontsource.test.ts`
Expected: FAIL — `indexFolder is not a function` on all six new cases.

- [ ] **Step 3: Implement the scan**

Append to `src/fontsource.ts`:

```ts
/** Extensions worth opening. A cheap filter, not a trusted claim -- the magic
 *  is checked afterwards. */
const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc']);

/**
 * Recursion bound for the folder walk.
 *
 * Real layouts nest three or four deep; 8 is far past any of them. Note what
 * actually prevents a symlinked cycle is that the walk does NOT follow
 * symlinks -- `Dirent.isDirectory()` is false for one -- and this bound is
 * defence behind that, for directories nobody in this project controls.
 */
const MAX_DEPTH = 8;

/** Read exactly `length` bytes at `offset`, or as many as the file holds. */
function readAt(fd: number, offset: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
}

/**
 * The naming fields of the font at `path`, read through PARTIAL file reads.
 *
 * Twelve bytes of header, then the table directory, then only the ranges the
 * `name`, `head` and `OS/2` tables occupy -- a few kilobytes rather than the
 * whole file. Undefined for anything unreadable or not a plain sfnt; this
 * never throws, because one corrupt file in a system font directory must not
 * break every lookup on the machine.
 */
function peekNames(path: string): FontNames | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const head12 = readAt(fd, 0, 12);
    if (head12.length < 12) return undefined;
    const numTables = (head12[4] << 8) | head12[5];
    if (numTables === 0 || numTables > 512) return undefined;
    const dirBytes = readAt(fd, 0, 12 + numTables * 16);
    const dir = parseTableDirectory(dirBytes);
    if (!dir) return undefined;

    const table = (tag: string): Uint8Array | undefined => {
      const r = dir.get(tag);
      if (!r || r.length === 0 || r.length > 4 * 1024 * 1024) return undefined;
      const b = readAt(fd!, r.offset, r.length);
      return b.length === r.length ? b : undefined;
    };
    return namesFromTables({ name: table('name'), head: table('head'), os2: table('OS/2') });
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/** Every candidate file under `dir`, depth-bounded, not following symlinks. */
function* walk(dir: string, depth: number): Generator<string> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { yield* walk(full, depth + 1); continue; }
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf('.');
    if (dot < 0) continue;
    if (FONT_EXT.has(e.name.slice(dot).toLowerCase())) yield full;
  }
}

/** Indexed folders, keyed by the path as given. Process-wide by design: a
 *  second Document pays nothing for a folder the first one scanned. */
const cache = new Map<string, FaceRecord[]>();

/**
 * Every face found under `dir`, recursively.
 *
 * Cached for the process lifetime, so a font file ADDED to the folder later is
 * not seen -- documented rather than engineered around, since stat-polling
 * every file on every lookup would cost most of what the cache saves.
 * Never throws: a missing folder yields an empty list.
 */
export function indexFolder(dir: string): FaceRecord[] {
  const hit = cache.get(dir);
  if (hit) return hit;
  const out: FaceRecord[] = [];
  for (const path of walk(dir, 0)) {
    const names = peekNames(path);
    if (names) out.push({ path, names });
  }
  cache.set(dir, out);
  return out;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/fontsource.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the partial-read case is load-bearing**

Temporarily replace the body of `table` in `peekNames` with a fixed-prefix read, which is the mistake the case exists to catch:

```ts
    const table = (tag: string): Uint8Array | undefined => {
      const r = dir.get(tag);
      if (!r) return undefined;
      const prefix = readAt(fd!, 0, 65536);            // MUTATION
      if (r.offset + r.length > prefix.length) return undefined;
      return prefix.subarray(r.offset, r.offset + r.length);
    };
```

Run: `npx vitest run test/fontsource.test.ts`
Expected: **FAIL** on "reads a font whose name table sits past a large glyf table", and PASS on the others — which is exactly the asymmetry that case exists for.

Revert the mutation (`git checkout -- src/fontsource.ts` would discard the whole task, so undo it by hand) and re-run.
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/fontsource.ts test/fontsource.test.ts
git commit -m "feat(l1my.1): indexFolder, a font folder index built from partial reads

Each candidate is opened and read in three pieces -- 12-byte header, table
directory, then only the name/head/OS-2 ranges -- so indexing costs a few
kilobytes per font. readFileSync is the obvious reach and is wrong: a
system folder holds thousands of faces and CJK fonts run to tens of
megabytes.

Measured load-bearing: swapping the ranged reads for a fixed 64 KB prefix
reddens the large-glyf case alone, which is the file layout where the name
table sits past any prefix a reader might optimistically grab.

Nothing throws. A missing folder, an unreadable file, a truncated sfnt and
a .ttc are each skipped, and every skip case is paired with a valid face in
the same folder so the test proves the scan continued.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The three `Document` methods

**Files:**
- Modify: `src/document.ts` (near `AddFont`/`AddFontFile`, around line 1449)
- Test: `test/font-byname.test.ts`

**Interfaces:**
- Consumes: `systemFontFolders`, `indexFolder`, `FaceRecord` from `./fontsource.js` (Tasks 3-4).
- Produces: `RegisterFontFolder(dir: string): void`, `RegisterSystemFonts(): void`, `LoadFontByName(family: string, opts?: AddFontOptions): EmbeddedFont | undefined`.

- [ ] **Step 1: Write the failing test**

Create `test/font-byname.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildNamedFont } from './helpers/build-sfnt.js';

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-byname-'));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, bytes);
  }
  return dir;
}

describe('Document.LoadFontByName', () => {
  it('finds a face by family name', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Alpha Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.postScriptName).toBe('AlphaSans');
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('  alpha SANS ')).toBeDefined();
  });

  it('matches the typographic family (ID 16) as well as ID 1', () => {
    const dir = folderWith({
      'a.ttf': buildNamedFont({ family: 'Foo Semibold', typographicFamily: 'Foo' }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Foo')).toBeDefined();
    expect(doc.LoadFontByName('Foo Semibold')).toBeDefined();
  });

  it('returns undefined when no registered folder holds the family', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Nonexistent Grotesk')).toBeUndefined();
  });

  it('returns undefined rather than throwing when nothing is registered', () => {
    expect(Document.New().LoadFontByName('Alpha Sans')).toBeUndefined();
  });

  it('prefers the regular face over bold and italic siblings', () => {
    // A TIE-BREAK, not style selection: LoadFontByName('Alpha Sans') returning
    // the bold face would be surprising. Choosing BETWEEN weights on request is
    // l1my.3's fallback chain, deliberately not built here.
    const dir = folderWith({
      'bold.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', bold: true }),
      'italic.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Italic', italic: true }),
      'regular.ttf': buildNamedFont({ family: 'Alpha Sans' }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const font = doc.LoadFontByName('Alpha Sans');
    expect(font).toBeDefined();
    expect(font!.sfnt.raw).toEqual(buildNamedFont({ family: 'Alpha Sans' }));
  });

  it('returns the SAME handle for a family requested twice', () => {
    // Identity, not equality: two AddText calls naming one family must share a
    // handle, or the font is subset and embedded into the file twice.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')).toBe(doc.LoadFontByName('alpha sans'));
  });

  it('registers a folder once however often it is named', () => {
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    doc.RegisterFontFolder(dir);
    doc.RegisterFontFolder(dir);
    expect(doc.LoadFontByName('Alpha Sans')).toBeDefined();
  });

  it('searches registered folders in registration order', () => {
    const first = folderWith({ 'a.ttf': buildNamedFont({ family: 'Shared', padGlyf: 0 }) });
    const second = folderWith({ 'b.ttf': buildNamedFont({ family: 'Shared', padGlyf: 64 }) });
    const doc = Document.New();
    doc.RegisterFontFolder(first);
    doc.RegisterFontFolder(second);
    // The first folder's face wins; the two differ only in glyf padding, which
    // makes the raw bytes distinguishable without changing the family.
    expect(doc.LoadFontByName('Shared')!.sfnt.raw.length)
      .toBe(buildNamedFont({ family: 'Shared', padGlyf: 0 }).length);
  });

  it('draws with a font found by name', () => {
    // End to end: the handle must be usable exactly as an AddFont handle is.
    const dir = folderWith({ 'a.ttf': buildNamedFont({ family: 'Alpha Sans' }) });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const { page } = doc.AddPage(PageFormat.A4);
    const font = doc.LoadFontByName('Alpha Sans');
    page.AddText('A', { x: 50, y: 700, size: 24, font });
    expect(doc.Save().length).toBeGreaterThan(0);
  });
});

describe('Document.RegisterSystemFonts', () => {
  it('does not throw on any platform, whatever is installed', () => {
    // The only honest assertion: which fonts a machine has is not this suite's
    // business, and every named directory may legitimately be absent.
    const doc = Document.New();
    expect(() => doc.RegisterSystemFonts()).not.toThrow();
    expect(() => doc.LoadFontByName('Definitely Not A Real Family')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/font-byname.test.ts`
Expected: FAIL — `doc.RegisterFontFolder is not a function` on every case.

- [ ] **Step 3: Add the state**

In `src/document.ts`, beside the existing `embeddedFonts` field (near line 306), add:

```ts
  /** Folders to search for LoadFontByName, in registration order. */
  private fontFolders: string[] = [];
  /** Fonts already loaded by name, keyed by resolved file path. */
  private fontsByPath = new Map<string, EmbeddedFont>();
```

- [ ] **Step 4: Add the three methods**

In `src/document.ts`, immediately after `AddFontFile` (around line 1460), add:

```ts
  /**
   * Search `dir`, recursively, when resolving a font by name.
   *
   * No I/O happens here: the folder is scanned on the first
   * {@link LoadFontByName} that needs it, so registering folders a document
   * never draws from costs nothing. Registering a path this document already
   * holds is a no-op, so a helper that registers on every call neither grows
   * the search list nor perturbs the order lookups depend on.
   */
  RegisterFontFolder(dir: string): void {
    if (!this.fontFolders.includes(dir)) this.fontFolders.push(dir);
  }

  /**
   * Also search the platform's own font directories.
   *
   * Opt-in, and deliberately so: searching them by default would let
   * `LoadFontByName('Arial')` succeed on a developer machine and fail in a
   * container, so the same code would build different documents on different
   * machines — surfacing at Save as a missing face rather than at the call.
   */
  RegisterSystemFonts(): void {
    for (const dir of systemFontFolders()) this.RegisterFontFolder(dir);
  }

  /**
   * The face whose family matches `family`, registered and ready to draw with.
   *
   * Matching is exact, case-insensitive and whitespace-trimmed, against the
   * typographic family (name ID 16) where the font states one and the family
   * (ID 1) otherwise. No style parsing: `'Arial Bold'` matches a family called
   * exactly that and nothing else. Where several faces share a family the
   * tie-break prefers one that is neither bold nor italic, then registration
   * and directory order — a TIE-BREAK, not style selection, which is
   * `l1my.3`'s job.
   *
   * Returns `undefined` when no registered folder holds the family: a machine
   * without a given face is an ordinary outcome, not an unsupported feature,
   * and substituting a Standard-14 face silently would render the document in
   * something the caller never chose. Never throws — an unreadable file, a
   * malformed font, a `.ttc` and a folder that does not exist are all skipped.
   *
   * Requesting one family twice returns the SAME handle, so the font is
   * embedded once however many times it is drawn with.
   */
  LoadFontByName(family: string, opts: AddFontOptions = {}): EmbeddedFont | undefined {
    const want = family.trim().toLowerCase();
    if (want === '') return undefined;

    let best: FaceRecord | undefined;
    for (const dir of this.fontFolders) {
      for (const face of indexFolder(dir)) {
        const n = face.names;
        const matches = (n.typographicFamily ?? n.family).trim().toLowerCase() === want
          || n.family.trim().toLowerCase() === want;
        if (!matches) continue;
        // First match wins, except that a plain face displaces a bold or
        // italic one found earlier.
        if (!best) { best = face; continue; }
        const bestPlain = !best.names.bold && !best.names.italic;
        if (!bestPlain && !n.bold && !n.italic) best = face;
      }
    }
    if (!best) return undefined;

    const already = this.fontsByPath.get(best.path);
    if (already) return already;
    let font: EmbeddedFont;
    try {
      font = this.AddFont(new Uint8Array(readFileSync(best.path)), opts);
    } catch {
      return undefined;   // readable enough to index, not enough to parse
    }
    this.fontsByPath.set(best.path, font);
    return font;
  }
```

Add to the imports at the top of `src/document.ts`:

```ts
import { systemFontFolders, indexFolder, type FaceRecord } from './fontsource.js';
```

`readFileSync` and `EmbeddedFont` are already imported (lines 125 and 123).

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/font-byname.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Prove the two subtle rules are load-bearing**

Two mutations, each run against `npx vitest run test/font-byname.test.ts` and reverted before the next:

1. Delete the memo — replace `const already = this.fontsByPath.get(best.path); if (already) return already;` with nothing, and drop the `this.fontsByPath.set(...)` line.
   Expected: **FAIL** on "returns the SAME handle for a family requested twice", and nothing else.
2. Delete the tie-break — replace the `if (!best) { best = face; continue; }` block and the two lines after it with `if (!best) best = face;`.
   Expected: **FAIL** on "prefers the regular face over bold and italic siblings". Note this depends on directory order putting `bold.ttf` first; if the case passes, the fixture is not exercising the rule — sort the folder's files or rename them so a non-regular face is found first, and say so in the test.

- [ ] **Step 7: Full suite**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 8: Commit**

```bash
git add src/document.ts test/font-byname.test.ts
git commit -m "feat(l1my.1): RegisterFontFolder, RegisterSystemFonts, LoadFontByName

AddFont took bytes and nothing else, so a caller who wanted a font by name
had to locate and read the file themselves.

System directories are opt-in: searching them by default would let one
program build different documents on different machines, surfacing at Save
as a missing face rather than at the call. A miss returns undefined --
'this machine has no Arial' is an ordinary outcome, and substituting a
Standard-14 face silently renders the document in something the caller
never chose.

Two rules measured load-bearing by mutation: the per-path memo, without
which one family drawn twice embeds the font twice; and the
prefer-the-plain-face tie-break, without which LoadFontByName('Alpha Sans')
can return the bold face. That tie-break is deliberately NOT style
selection, which is l1my.3.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Documentation and close-out

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: CHANGELOG**

Insert as the first bullet under `### Added` in `## [Unreleased]`:

```markdown
- **A font can be loaded by family name** — `doc.RegisterFontFolder(dir)` and `doc.LoadFontByName('Liberation Sans')`, with `doc.RegisterSystemFonts()` adding the platform's own font directories. Until now `AddFont` took font **bytes** and nothing else, so a caller who wanted a named face had to locate and read the file themselves. Matching is exact, case-insensitive and whitespace-trimmed, against the typographic family (name ID 16) where a font states one and the family (ID 1) otherwise; where several faces share a family, one that is neither bold nor italic wins, then registration and directory order. That last rule is a **tie-break, not style selection** — choosing between weights on request is a separate piece of work — so `LoadFontByName('Arial')` will not hand back Arial Bold. Two decisions are worth knowing because a caller would otherwise meet them by surprise. The system directories are **opt-in**: searching them by default would let one program build different documents on different machines, and the failure would surface at `Save` as a missing face rather than at the call. And a miss returns **`undefined`** rather than throwing or quietly substituting a Standard-14 face, because "this machine has no Arial" is an ordinary outcome and a silent substitution renders the document in metrics and glyphs the caller never chose. Nothing here throws: an unreadable file, a malformed font, a `.ttc` collection and a registered folder that does not exist are all skipped. Underneath, folders are indexed lazily on first lookup and cached for the process, and each candidate is read **partially** — header, table directory, then only the `name`/`head`/`OS/2` byte ranges — because a system font folder holds thousands of faces and reading whole files would turn one lookup into hundreds of megabytes of I/O. Requesting one family twice returns the same handle, so the font is embedded once however often it is drawn. `.ttc` collections are not yet read. (`l1my.1`)
```

- [ ] **Step 2: README — API overview**

In the API overview table, immediately after the `AddFontFile` row, add:

```markdown
| `doc.RegisterFontFolder(dir)` | Search `dir` recursively when resolving a font by name (lazy; no I/O until a lookup) |
| `doc.RegisterSystemFonts()` | Also search the platform's font directories (opt-in) |
| `doc.LoadFontByName(family, opts?)` | The face whose family matches, ready to draw with — `undefined` when no registered folder holds it |
```

If the table's `AddFontFile` row cannot be found, add the three rows at the end of the font-related section of that table instead.

- [ ] **Step 3: README — prose**

In the section describing font embedding, add:

```markdown
A font can also be found by **family name** rather than by path. Register the
folders to search — and, if you want them, the platform's own font directories —
then ask for a family:

```ts
doc.RegisterFontFolder('./assets/fonts');
doc.RegisterSystemFonts();                       // opt-in

const font = doc.LoadFontByName('Liberation Sans');
if (font) page.AddText('Hello', { x: 50, y: 700, size: 24, font });
```

Two things are deliberate. The system directories are **opt-in**, because
searching them by default lets the same code build different documents on
different machines — a face found on your laptop and missing in a container,
failing at `Save` rather than at the call. And a name nothing matches returns
**`undefined`** rather than throwing or substituting a default face: a silent
substitution would render the document in metrics and glyphs you did not
choose. Matching is exact on the family name, case-insensitive; where a family
has several faces, the one that is neither bold nor italic is preferred.
```

- [ ] **Step 4: CLAUDE.md**

Add after the `embeddedfont.ts` / `subset.ts` entry in the Source list:

```markdown
- **fontnames.ts**, **fontsource.ts** — finding a font by FAMILY NAME
  (`doc.RegisterFontFolder`, `doc.RegisterSystemFonts`, `doc.LoadFontByName`).
  `fontnames.ts` is a pure leaf reading an sfnt's `name`, `head` and `OS/2`
  fields and nothing else; `fontsource.ts` scans folders and holds the index.
  **Invariant:** `fontnames.ts` is the ONE owner of the `name` table. `sfnt.ts`
  walked the records itself for ID 6 alone and was free to disagree with this
  one about platform preference — a font may carry both a platform-1 and a
  platform-3 record for the same ID, and platform 3 wins here because that is
  what other tooling reads.
  **Invariant:** indexing reads each candidate PARTIALLY, through
  `openSync`/`readSync` — 12-byte header, table directory, then only the byte
  ranges the three tables occupy. `readFileSync` is the obvious reach and is
  wrong: a system font folder holds thousands of faces and a CJK font runs to
  tens of megabytes. Measured — swapping the ranged reads for a fixed 64 KB
  prefix reddens exactly the fixture whose `name` table sits past a large
  `glyf`, and nothing else.
  **Invariant:** the system font directories are OPT-IN. Searching them by
  default makes the same code build different documents on different machines,
  and the failure surfaces at `Save` as a missing face rather than at the call
  — which is incompatible with a library whose test strategy is byte-identity
  fences.
  **Invariant:** a miss returns `undefined` and NOTHING here throws. A missing
  folder is the normal case for `RegisterSystemFonts` (no machine has every
  directory it names), and one corrupt file in a system font directory must not
  break every lookup on that machine.
  **Invariant:** `LoadFontByName` memoizes per document by resolved file PATH,
  not by the requested name, so two names resolving to one file share a handle.
  Without it a family drawn twice is subset and embedded twice.
  **Note:** the prefer-a-plain-face rule is a TIE-BREAK, not style selection.
  Choosing between weights on request is `l1my.3`; building its front half here
  would leave that issue rewriting this rule or inheriting an undocumented one.
  `.ttc` collections are skipped until `l1my.2`.
```

- [ ] **Step 5: Final gates**

Run: `npm run typecheck && npm test`
Expected: both green.

- [ ] **Step 6: Commit, close, push**

```bash
git add CHANGELOG.md README.md CLAUDE.md
git commit -m "docs(l1my.1): font sourcing by name in CHANGELOG, README and CLAUDE.md

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

bd close aspose-pdf-foss-for-ts-l1my.1 --reason "..."
bd export
git add .beads/interactions.jsonl && git commit -m "chore(l1my.1): sync beads export"

git pull --rebase && git push && git status -sb
bd dolt push && git ls-remote origin 'refs/dolt/*'
```

`bd dolt push` is not optional — tracker state does not reach the remote via `git push` in this repo.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: `fontnames.ts` → Task 1; the `sfnt.ts` delegation → Task 2; `systemFontFolders` → Task 3; the index, partial reads, cache, depth bound, extension filter and degradation → Task 4; the three methods, matching, tie-break, memo and idempotent registration → Task 5; documentation → Task 6. The spec's "out of scope" list adds no tasks by construction.

**One correction to the spec's reasoning, carried into the plan.** The spec says the depth bound is what keeps a symlinked cycle from costing the process. That is not quite right: `Dirent.isDirectory()` is false for a symlink, so the walk does not follow one and a cycle cannot arise. The bound is defence behind that, and Task 4's comment says so rather than repeating the spec's claim.

**Type consistency.** `FontNames`, `TableRange` and `FaceRecord` are defined in Tasks 1 and 3-4 and consumed with the same field names in Tasks 4-5. `parseTableDirectory(header)` returns `Map<string, TableRange> | undefined` everywhere; `namesFromTables({ name, head, os2 })` takes those three optional keys in both callers; `indexFolder(dir)` returns `FaceRecord[]` in Task 4 and is iterated as `face.names` / `face.path` in Task 5.

**Two steps are mutation checks rather than test runs** (Task 4 Step 5, Task 5 Step 6), because each guards a rule whose failure produces a plausible result: a font that looks simply absent, a font embedded twice, and a bold face returned for a plain request.

**One defect found in this plan's own fixture builder while reviewing it.** The
first draft of `buildNamedFont` used the exported `buildMaxp`/`buildHhea`/
`buildHmtx`, which declare **three** glyphs, while building only two — and
`parseSfnt` reads `numGlyphs + 1` loca entries, so it would have read one entry
past the end of a 3-entry table. Task 5 calls `AddFont` on these fonts, so every
case there would have failed on a fixture bug rather than on the code under
test. `assembleGlyfFont` in the same helper file builds its own tables for
precisely this reason; `buildNamedFont` now does the same, and the comment says
why so the next person does not reach for the exported ones again.
