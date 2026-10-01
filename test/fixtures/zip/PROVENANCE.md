# ZIP test fixtures — provenance

ZIP archives written by three writers that are not ours, here to validate
`src/zipread.ts` against bytes it did not produce. Issue `m2fp.1`; design
`docs/superpowers/specs/2026-09-29-zip-reader-design.md`.

**Read this first: the oracle is outside the reader.** `manifest.json`'s
hashes are computed by `scripts/gen-zip-fixtures.mjs` from the INPUT files it
handed each writer — and for `git.zip` from `git show <commit>:<path>` — never
by reading an archive. `test/zipread-real.test.ts` then asserts each entry our
reader returns against those hashes, and cross-checks against
`test/helpers/unzip.ts`, the independent APPNOTE reader.

## What each archive is here for

| Archive | Producer | What it carries that no builder fixture does |
|---|---|---|
| `tar.zip` | Windows `tar.exe`: `bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley` | Flag bit 3 (data descriptor) on every entry, with a local-header compressed size of **0**; a **32-byte local extra field against a 24-byte central one** |
| `net.zip` | .NET Framework `4.0.30319.42000`, `System.IO.Compression.ZipFile.CreateFromDirectory` | A UTF-8 name **with flag bit 11** (`café.txt`); a name with a **backslash** separator (`sub\b.txt`) |
| `git.zip` | `git version 2.55.0.windows.5`, `git archive --format=zip` | A **40-byte archive comment** (the commit id); 9-byte extended-timestamp extras in both headers; a stored directory entry (`src/`) |

## How they were made

`npm run gen:zip` (`scripts/gen-zip-fixtures.mjs`), on Windows 11 with git
installed. Inputs, written by the script to a temporary directory:

| Path | Content |
|---|---|
| `a.txt` | `'hello zip '` × 200, then `\n` |
| `sub/b.txt` | `x\n` |
| `bin.dat` | the 256 bytes 0x00..0xFF |
| `café.txt` | `café\n` (UTF-8) — .NET only; `tar.exe` transliterates `é` to `e`, so it is left out of `tar.zip` |

Commands (the script runs these; paths shortened):

```
%SystemRoot%\System32\tar.exe -a -cf tar.zip a.txt sub/b.txt bin.dat
powershell -NoProfile -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('<inputs>', 'net.zip')"
git archive --format=zip -o git.zip f6f49fa5f4376f7dde084e83020d539d19dd2234 -- src/crc32.ts src/zip.ts
```

`tar.exe` is named by full path on purpose: under Git Bash a bare `tar` is GNU
tar, which writes no ZIP and reads a drive letter as a remote host.

The script refuses to write a manifest unless `tar.zip` has a data descriptor,
`net.zip` a bit-11 name and `git.zip` a comment — the properties each archive
is vendored for.

SHA-256 of the archives:

```
dd44cfe2895f66f06ab490c6f5dbdcf9a176e21f8e767230f5b54c1ac791fb6e  tar.zip
75cc4a0e6a2fce3b8cc741d306a8a1c8f73c52d19a0a7a630aa7ea0af60e34f2  net.zip
09de859cbbccaf6e8d37f18100d1214daa0567b38f309dbfd11c3116dea56df9  git.zip
```

## What they pin, measured by mutation

| Mutation to `src/zipread.ts` | Result here |
|---|---|
| locate the data by the CENTRAL extra length | RED (`tar.zip`: 32 vs 24) |
| take the compressed size from the LOCAL header | RED (`tar.zip`: local size 0) |
| ignore flag bit 11 (always CP437) | RED (`net.zip`) |
| drop the exact-comment preference in the end-record search | GREEN — git's comment holds no signature; the rule is held by a builder case in `test/zipread.test.ts` |

## The ceiling

- No producer here writes a **CP437** name, so that table is covered by
  hand-built archives only.
- No producer writes an **encrypted** entry, a **method other than 0 or 8**,
  **ZIP64** or a **multi-disk** set: every refusal is builder-covered only.
- `tar.exe` transliterates non-ASCII names, so libarchive's own UTF-8
  behaviour is not captured.
- The archives are small; nothing here exercises a `LoadLimits` bound on
  real bytes.
- This is ZIP-container evidence, not DOCX evidence. The DOCX corpus is
  `m2fp.4`.
