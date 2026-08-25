# Font sourcing by name — design

Issue: `l1my.1`, under epic `l1my` (Font sourcing by name, `gap-vs-go`).
Date: 2026-08-24.

Go has `font_byname.go`, which resolves a font by family from registered
folders, the system font directories and `.ttc` collections. TS `AddFont`
accepts font **bytes** and nothing else, so a caller who wants Liberation Sans
must locate and read the file themselves.

This is the design for the first of that epic's three children: finding a font
**by family name** across folders the caller registers, and optionally the
platform's own font directories.

## What exists today

`Document.AddFont(bytes)` parses an sfnt and registers it; `AddFontFile(path)`
is `readFileSync` plus `AddFont`, already synchronous and already in
`document.ts`. Those two are the entire surface.

`sfnt.ts` reads exactly one name from the `name` table — the PostScript name,
ID 6, via `readPostScriptName`. Matching by *family* needs IDs 1 and 2, and
preferably the typographic pair 16 and 17, so a broader reader is required
whatever else this design chooses.

## Scope

**In:** a per-document registry of font folders; an opt-in registration of the
platform's font directories; a lazily built, process-wide cached index of face
names; and `LoadFontByName`, matching a family name exactly and
case-insensitively.

**Out:** `.ttc` collections (`l1my.2`) and family/style matching with a fallback
chain (`l1my.3`). Both are named in the deferral section rather than
half-built here.

## Two decisions that shape everything else

**The default search is deterministic.** A caller registers folders explicitly;
the platform's font directories are searched only after `RegisterSystemFonts()`.
Searching them by default would make `LoadFontByName('Arial')` succeed on a
developer machine and fail in a Linux container, so the same code would produce
different documents on different machines — and the failure would surface at
Save time as a missing face, not at the call. This library's whole test strategy
is byte-identity fences; a machine-dependent default is incompatible with it.
Convenience costs one extra call, and that call is a decision the caller made.

**A miss returns `undefined`, and nothing throws.** "This machine has no Arial"
is an ordinary outcome, not an unsupported feature, and the common
`try Arial, else Helvetica` pattern should not need exception handling. Falling
back to a Standard-14 face automatically was rejected outright: it substitutes
metrics and glyphs silently, so the document renders in a face the caller never
chose with no way to detect it.

## Module layout

| File | Responsibility |
|---|---|
| `src/fontnames.ts` | **new, pure leaf.** The `name` table, read cheaply. |
| `src/fontsource.ts` | **new.** Folder scanning, the index, its cache, and the platform folder list. The only new module that touches `node:fs`. |
| `src/sfnt.ts` | `readPostScriptName` delegates to `fontnames.ts`. |
| `src/document.ts` | `RegisterFontFolder`, `RegisterSystemFonts`, `LoadFontByName`. |

### `fontnames.ts`

```ts
export interface FontNames {
  /** Name ID 1. */
  family: string;
  /** Name ID 2 — 'Regular', 'Bold Italic', … */
  subfamily: string;
  /** Name ID 16, where the font states one. */
  typographicFamily?: string;
  /** Name ID 17, where the font states one. */
  typographicSubfamily?: string;
  /** Name ID 6. */
  postScriptName?: string;
  /** head.macStyle bit 0 / bit 1. */
  bold: boolean;
  italic: boolean;
  /** OS/2.usWeightClass, or 400 when the table is absent. */
  weight: number;
}

/** Read the naming and style fields of an sfnt, and nothing else.
 *  `undefined` for anything that is not a plain sfnt — a `ttcf` collection or
 *  a WOFF wrapper included. */
export function readFontNames(bytes: Uint8Array): FontNames | undefined;
```

It reads the table directory and then only `name`, `head` and `OS/2`. It never
touches `glyf`, `loca` or `cmap`, which is what makes it usable over a folder of
thousands of files.

`sfnt.ts` calls it rather than keeping its own walk of the name records. One
owner for the `name` table: the two readings cannot then disagree about
platform-ID preference or UTF-16 decoding.

### `fontsource.ts`

```ts
export interface FaceRecord {
  /** Absolute path of the file this face was read from. */
  path: string;
  names: FontNames;
}

/** The platform's font directories, in search order. Paths are returned
 *  whether or not they exist; the scan skips what is absent. */
export function systemFontFolders(): string[];

/** Every face found under `dir`, recursively. Cached per absolute path for the
 *  process lifetime. Never throws. */
export function indexFolder(dir: string): FaceRecord[];
```

`systemFontFolders()` by platform:

- **win32** — `%WINDIR%\Fonts`, `%LOCALAPPDATA%\Microsoft\Windows\Fonts`
- **darwin** — `/System/Library/Fonts`, `/Library/Fonts`, `~/Library/Fonts`
- **otherwise** — `/usr/share/fonts`, `/usr/local/share/fonts`,
  `~/.local/share/fonts`, `~/.fonts`

## The index, and its cost model

This is the part that determines the shape of the module, so it is stated
before the API rather than after.

**Registration does no I/O.** `RegisterFontFolder` records a path. The scan runs
on the first `LoadFontByName`, so registering ten folders costs nothing until
something is looked up, and a document that never loads a font by name pays
nothing at all.

**The scan is recursive, to a depth of 8.** Linux nests fonts as
`/usr/share/fonts/truetype/dejavu/…`, so a flat `readdir` would find nothing
there; 8 is far past any real layout. The bound is not tidiness -- a symlinked
cycle inside a font directory must cost a bounded walk rather than the process,
and `RegisterSystemFonts` points at directories nobody in this project controls.

**Files are filtered by extension before any read** (`.ttf`, `.otf`, `.ttc`,
`.otc`), and then validated by magic — the extension is a cheap filter, not a
trusted claim.

**Each candidate is read PARTIALLY, through `openSync`/`readSync`.** Twelve
bytes of header, then the table directory, then only the byte ranges the
`name`, `head` and `OS/2` tables occupy. A few kilobytes per font instead of the
whole file. `readFileSync` is the obvious thing to reach for and is wrong here:
a system folder holds thousands of faces and a CJK font runs to tens of
megabytes, so reading whole files turns a lookup into hundreds of megabytes of
I/O.

**The cache is process-wide, keyed by the absolute path, and lives for the
process.** A second `Document` pays nothing for a folder the first one scanned.
The consequence is documented rather than engineered around: **a font file added
to a registered folder mid-process is not seen.** Stat-polling every file on
every lookup would cost most of what the cache saves.

## Public API

```ts
/** Search `dir` (recursively) for fonts when resolving a name. No I/O happens
 *  here: the folder is scanned on the first LoadFontByName that needs it. */
RegisterFontFolder(dir: string): void;

/** Also search the platform's own font directories. Opt-in, because searching
 *  them by default makes the same code produce different documents on
 *  different machines. */
RegisterSystemFonts(): void;

/** The best face whose family matches `family`, registered and ready to draw
 *  with — or `undefined` when no registered folder holds one. */
LoadFontByName(family: string, opts?: AddFontOptions): EmbeddedFont | undefined;
```

`LoadFontByName` reads the matched file in full, hands the bytes to `AddFont`,
and returns the handle.

**It memoizes per document by resolved file path.** Two `AddText` calls naming
the same family must yield the *same* `EmbeddedFont`, or the font is subset and
embedded twice into the saved file. The memo key is the path rather than the
requested name, so two names resolving to one file also share a handle.

`RegisterFontFolder` is idempotent: registering a path this document already
holds is a no-op, so a helper that registers its folder on every call does not
grow the search list — and does not perturb the registration order the
tie-break below depends on.

Registered folders are per-document state. Only the *index* is shared across
documents, and an index is a fact about the disk rather than about a document —
so nothing global can change what a given document contains.

## Matching

The family is matched **case-insensitively, with surrounding whitespace
trimmed**, against the typographic family (ID 16) where the font states one and
the family (ID 1) otherwise. Nothing else: no style parsing, no decomposition of
`'Arial Bold Italic'`, no substitution.

Where several faces share a family, the tie-break is:

1. prefer a face that is neither bold nor italic;
2. otherwise the first, in folder-registration order and then directory order.

This is a **tie-break, not style selection**, and the distinction is the reason
`l1my.3` stays a clean job. `LoadFontByName('Arial')` returning Arial Bold would
be surprising, so rule 1 exists — but choosing *between* weights on request is
the fallback chain `l1my.3` is for, and building its front half here would leave
that issue either rewriting this rule or inheriting an undocumented one.

Order is stable and documented so that a lookup is reproducible: the same
folders in the same order give the same face.

## Degradation

**Nothing in this feature throws.** Each of these is skipped, and the lookup
continues:

- a registered folder that does not exist — which is the normal case for
  `RegisterSystemFonts`, since no machine has all the directories it names;
- a file that cannot be opened or read;
- a file whose bytes are not a plain sfnt, malformed or truncated;
- a `.ttc` collection, until `l1my.2`.

A single corrupt file in a system font directory must not break every lookup on
that machine. That is the failure mode this rule exists for, and it is the one
that would be discovered late.

## Testing

Hermetic: the suite must not depend on what fonts a machine has installed, and
`test/fixtures/fonts/` holds WOFF2 files and one OTF — not a directory of
faces to match among.

Tests build a temp folder with `mkdtempSync` and populate it with synthetic
sfnts from `test/helpers/build-sfnt.ts`, which gains a `buildNameTable` helper
it currently lacks. Writing temp files in tests is already precedented here -- five test files do
it, `test/node.test.ts` among them.

Cases:

- an exact family match, and the same match with the case changed;
- a name no face carries returns `undefined`;
- the regular-over-bold tie-break, over a folder holding both;
- a malformed file, a `.ttc`, and a registered folder that does not exist are
  each skipped without throwing, and a *valid* face in the same folder is still
  found — a skip test that does not prove the scan continued is worth little;
- the same family requested twice returns the SAME `EmbeddedFont`, asserted by
  identity, since the defect it guards against is a font embedded twice;
- `systemFontFolders()` asserted by SHAPE for the current platform — that it
  names a Windows/darwin/other set — never by contents, which would make the
  suite depend on the machine.

The partial-read scheme needs its own case: a font whose `name` table sits
*after* a large `glyf` table must still be indexed, since a reader that
optimistically read only a fixed prefix would find nothing and the failure would
look like "that font just isn't there".

## Out of scope

- **`.ttc` / `.otc` collections** — `l1my.2`.
- **Family and style matching with a fallback chain** — `l1my.3`.
- **WOFF/WOFF2 in a font folder.** `woff.ts` can reconstruct them, but doing so
  to read a name means reversing the whole glyph transform, which defeats the
  cost model above. System font directories do not contain them.
- **Asynchronous loading.** `Document.Open`, `Save` and `AddFontFile` are all
  synchronous; an async font load would infect `AddText`, whose caller cannot
  await. `node.ts` remains the place for async convenience wrappers if one is
  ever wanted.
- **Watching folders for change.** See the cache rule above.

## Documentation

`CHANGELOG.md` under `[Unreleased]`, as a new capability. `README.md` gains the
three methods in the API overview and a paragraph in the font section, stating
the deterministic default and the `undefined` return plainly — both are things
a caller will otherwise discover by surprise. `CLAUDE.md` gains an entry for
`fontnames.ts` and `fontsource.ts` with the cost model and the tie-break rule,
since neither is derivable from the code's shape.
