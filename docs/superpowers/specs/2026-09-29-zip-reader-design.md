# ZIP reader under LoadLimits — design (`m2fp.1`)

Epic `m2fp` imports DOCX over the flow engine. A `.docx` is a ZIP package, and
`src/` has a ZIP **writer** (`zip.ts`) and no reader. `test/helpers/unzip.ts` is
test-only and must stay independent of `src/`, since it is what checks the
writer. This issue adds the reader; `m2fp.2` (OPC package reading) is its only
consumer.

## Decisions taken in brainstorming

1. **Lazy, not eager.** Opening reads the central directory only; an entry is
   inflated, charged and CRC-checked when it is READ. A DOCX pays only for the
   parts the importer opens, and a bomb in an unread entry costs nothing.
2. **Entry count against `maxContainerItems`**, counted as records are
   PRODUCED from the central directory, never from the count the end record
   declares (`ibzo.2`'s rule).
3. **Unsupported features refuse per ENTRY, at `read()`.** An archive holding
   one unusual part stays usable for the rest, which is what lets `m2fp.5`
   report that part in `skipped`. Archive-level ZIP64 and multi-disk refuse at
   open, because without them the entry list cannot be found at all.

## Module and API

A new leaf, `src/zipread.ts`, over `inflatebound.js`, `crc32.js`,
`loadlimits.js` and `errors.js`. No `Document`, no `node:fs`. Not exported from
`index.ts`. The name is not `unzip.ts`, to keep it visibly apart from the test
helper.

```ts
export interface ZipArchiveEntry {
  readonly path: string;
  readonly method: number;          // raw APPNOTE method number
  readonly compressedSize: number;
  readonly size: number;            // declared uncompressed size
  readonly encrypted: boolean;
}
export interface ZipArchive {
  readonly entries: readonly ZipArchiveEntry[];   // central-directory order
  has(path: string): boolean;
  read(path: string): Uint8Array;
}
export function openZip(bytes: Uint8Array, limits?: LoadLimits): ZipArchive;
```

- **One `InputDecoder` per archive**, so every `read()` is charged to one
  `maxTotalDecodedBytes` total. No result cache: reading a part twice decodes
  and charges it twice; `m2fp.2` decides what to keep.
- **`InputDecoder` gains `inflateRaw(input, declared?)`** — a ZIP entry is raw
  DEFLATE (RFC 1951), not zlib. The entry's declared uncompressed size is passed
  as `declared`, so a header claiming more than the bounds is refused before
  inflating and output past a smaller declaration is damage — the WOFF table
  rule, unchanged.
- **A stored entry** is still charged, and checked against its declared size.
- Paths are looked up through a `Map`.

## Parsing rules

**End record.** Search backwards for `PK\x05\x06` within the last
22 + 65,535 bytes. Prefer a candidate whose comment length ends exactly at the
end of the buffer, so a signature inside a comment cannot win; failing that,
take the candidate nearest the end, so trailing junk costs the junk. A ZIP64
end-record locator (`PK\x06\x07`) immediately before it, a 0xFFFFFFFF
sentinel in the directory size or offset, or a non-zero disk number is
`UnsupportedFeatureError`. *(Amended in planning:)* a count of 0xFFFF alone is
a REAL count, not a ZIP64 sentinel — `writeZip` writes exactly that for 65,535
entries.

*(Amended in planning:)* `writeZip` sets flag bit 11 for a non-ASCII name,
fixed in this issue. Without it, this reader — conforming to APPNOTE 4.4.4 —
would decode a UTF-8 name our own writer produced as CP437.

**Central directory.** Read records from the stated offset, bounds-checking
every offset and length. Each record is counted against `maxContainerItems`
before it is kept. A record running off the buffer, a bad signature, or a
directory holding a different number of records than the end record declares
is `PdfParseError`. An archive with bytes PREPENDED (a self-extractor) is out of
scope: its offsets are wrong, which reads as damage.

**Names.** Flag bit 11 → UTF-8; otherwise CP437 (APPNOTE Appendix D, a
128-entry table for the high half). Returned VERBATIM, never normalised —
nothing touches a filesystem, so `../../x` is only a string. A DUPLICATE name is
`PdfParseError` at open: two entries under one name are the ZIP-confusion shape
in which two readers pick different bytes. Case-insensitive collisions are an
OPC rule and belong to `m2fp.2`.

**Reading.** Sizes, CRC and flags come from the CENTRAL directory, never the
local header — that is what makes data descriptors (flag bit 3) work, whose
local header carries zeros. The local header is still validated: its signature
must be present and its name must EQUAL the central name (the other confusion
shape). The local header's OWN name and extra lengths locate the data, since the
local extra field legitimately differs from the central one. The result must
match the declared size and the CRC-32. A directory entry (name ending `/`)
reads as empty bytes.

## Errors and limits

| Situation | When | Error |
|---|---|---|
| No end record / not a ZIP; OLE signature `D0 CF 11 E0` named in the message as a likely encrypted Office file | open | `PdfParseError` |
| ZIP64 archive, multi-disk | open | `UnsupportedFeatureError` |
| Entry count past `maxContainerItems` | open, as produced | `ResourceLimitError` |
| Truncated or inconsistent directory, duplicate name | open | `PdfParseError` |
| Encrypted entry (bit 0), method not 0/8, per-entry ZIP64 sentinel | `read()` | `UnsupportedFeatureError` |
| Declared size past bounds, inflate reaching the cap, total past `maxTotalDecodedBytes` | `read()` | `ResourceLimitError` |
| Output past a smaller declaration, CRC mismatch, bad local header, name mismatch, corrupt DEFLATE data | `read()` | `PdfParseError` |
| Unknown path | `read()` | `RangeError` (caller error, not damage) |

No other error escapes: zlib's own data error is wrapped as `PdfParseError`,
and every `catch` calls `rethrowLimit` first (`test/limits-catch.test.ts`). No
new limit field; `maxFileBytes` stays the caller's, as for every input decoder.
A per-entry refusal leaves every other entry readable.

## Testing

`test/zipread.test.ts`, over `writeZip` output plus hand-patched bytes:

- Round trip of everything `writeZip` produces — stored, deflate, empty,
  directory entries, UTF-8 names.
- One case per row of the error table, and after each per-entry refusal an
  assertion that a sibling entry still reads.
- Bombs: a deflate bomb under an honest declaration → `ResourceLimitError`; a
  declaration lying SMALL → `PdfParseError` at the declared length; a
  declaration past the bounds → refused before inflating; several entries each
  under the stream cap and together over `maxTotalDecodedBytes` → refused (pins
  one decoder per archive).
- Entry count: exactly `maxContainerItems` opens, one more is refused.
- Data descriptor: local sizes zeroed, entry still reads.
- A traversal name comes back verbatim, with a static check that
  `zipread.ts` imports no `fs` *(amended in planning: replaces a spy, which
  an ESM `node:fs` import makes awkward and which proves less)*.

Every rule is mutation-checked. Expected to need care: the exact-comment
preference (needs a fake signature inside a comment), central-over-local sizes
(needs the data-descriptor fixture), and the name-equality check.

**Third-party fixtures**, `test/fixtures/zip/` with `PROVENANCE.md` (commands,
SHA-256 of inputs and outputs, and what each does NOT cover):

| Producer | Covers |
|---|---|
| libarchive, Windows `tar.exe -a -cf` | Data descriptors (local sizes 0); a 32-byte local extra against a 24-byte central one |
| .NET Framework `ZipFile.CreateFromDirectory` | A bit-11 UTF-8 name; a backslash separator (`sub\b.txt`) |
| `git archive --format=zip` | An archive comment (the commit id), on real bytes |

*(Amended in planning, from a probe of the three producers:)* the first draft
credited .NET with data descriptors. It writes none; libarchive does.

`test/zipread-real.test.ts` asserts each entry against a SHA-256 recorded in
PROVENANCE from the source files — an oracle outside our reader — and
cross-checks against `test/helpers/unzip.ts`. PROVENANCE records the ceiling:
no producer here writes CP437 names, so that table is builder-covered only.

## Docs

A CLAUDE.md Source-list entry for `zipread.ts`. No CHANGELOG entry: nothing
public changes until `AddDocx` ships in `m2fp.5`.
