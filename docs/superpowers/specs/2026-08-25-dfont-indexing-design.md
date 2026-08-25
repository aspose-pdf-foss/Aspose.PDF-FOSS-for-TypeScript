# `.dfont` indexing and embedding — design

Issue: `l1my.6`, under epic `l1my` (Font sourcing by name, `gap-vs-go`).
Date: 2026-08-25.

A `.dfont` holds ordinary sfnt faces inside a Macintosh **resource fork**
structure rather than as a bare sfnt. `parseTableDirectory` therefore rejects
one outright, `RegisterFontFolder` finds nothing in a folder of them, and
`AddFont` cannot embed one. There is no resource-fork reader anywhere in `src/`.

This is the design for both halves: reading a face out of the container, and
indexing one by family name.

## Two findings that shape everything

**The name is a false friend, in our favour.** A `.dfont` is a *data-fork*
font: it holds resource-fork-*format* bytes in the ordinary data fork, which is
the entire reason the format was invented. So there is no macOS-specific
`..namedfork/rsrc` path to handle and no platform branch anywhere — `readdirSync`
and `openSync` see it as a plain file, exactly as they see a `.ttf`.

**A face needs no rebuild.** The issue text assumed an `assembleSfnt` step of
the shape `ttc.ts` uses, on the grounds that the tables are not contiguous file
ranges. That is true of the *file* and false of the *resource*: each `sfnt`
resource is a complete, self-consistent sfnt whose table offsets are relative to
its own start. Extraction is therefore a `subarray`, not a reassembly.

`SfntFont` is safe on one — [`sfnt.ts:21`](../../../src/sfnt.ts) builds its
`DataView` as `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)`,
and every table read threads `byteOffset` the same way. So `dfont.ts` imports
`errors.js` and nothing else. It is a strictly smaller module than `ttc.ts`.

## The decision that is not forced: detection

**A `.dfont` carries no signature.** Every other container this library reads
announces itself in its first four bytes — `wOFF`, `wOF2`, `ttcf`, `%!` or
`0x80 0x01`, `0x00010000` or `OTTO`. A resource fork opens with a raw `u32`
data offset, conventionally 256, and nothing else. There is no byte sequence to
test for.

Detection is therefore **structural**: the walk that finds the faces *is* the
test that the file is a `.dfont`. `dfontSfntRanges` returns `undefined` for
anything whose header offsets do not cohere with the file length, whose map does
not parse, or whose type list holds no `sfnt` type — precisely the shape
`ttcFaceOffsets` already has, and for the same reason.

Requiring the map's 16-byte copy of the header to match was considered and
**rejected**. Inside Macintosh reserves those bytes for a header copy and Apple's
own files carry one, but nothing enforces it and a tool that zeroes the field
would produce a font we refuse for no benefit. The `sfnt` type tag plus a
coherent structure is already four bytes of exact agreement inside a chain of
offsets that must all land in range; a non-font file passing that is not a
realistic concern, and a false positive costs one wasted partial read and a
`return []`.

The payoff is that this keeps `l1my.4`'s spirit intact one format further: a
classic Mac font that lost its extension is found by structure, and
`sniff: true` reaches a `.dfont` stored under any name at all. An
extension-only test would have made `.dfont` the one format invisible to the
mechanism `l1my.4` exists to provide.

**Cost is contained by dispatch ORDER.** The structural walk is not a `u32`
compare, so it goes **last** in `parseSfnt`, after the three cheap signature
tests. No existing format pays anything for it.

## Module layout

### `src/dfont.ts` — the container

A pure leaf. Imports `errors.js`. Imports **not** `sfntwrite.js` (nothing to
assemble), **not** `sfnt.js`, **not** `document.js`.

```ts
/** Reads `length` bytes at `offset`, or fewer at end of file. */
export type ByteReader = (offset: number, length: number) => Uint8Array;

/** Byte range of each `sfnt` resource, or `undefined` when not a .dfont. */
export function dfontSfntRanges(
  read: ByteReader, fileLength: number,
): { offset: number; length: number }[] | undefined;

/** Whether `bytes` opens as a .dfont. Thin wrapper over the walk. */
export function isDfont(bytes: Uint8Array): boolean;

/** Face `index` as a standalone sfnt. Throws `PdfParseError`. */
export function extractDfontFace(bytes: Uint8Array, index: number): Uint8Array;
```

**The walk takes a reader callback rather than bytes, and that is the load-bearing
choice in this module.** Two callers want the same format walk over different
access strategies: `parseSfnt` holds the whole buffer, and `fontsource.ts` holds
a file descriptor and must not read one. A bytes-only signature forces
`fontsource.ts` to keep its own copy of the map parse — which is exactly how the
index and the loader come to disagree about how many faces a file has, silently,
on a file nobody looks at closely. The callback is the same seam
`grayimage.ts` and `grayshading.ts` take `resolve`/`inflate` through, and that
`glyphprogram.ts` takes its name resolver through.

`extractDfontFace` builds a slicer over `bytes` and calls the same walk, so the
whole-buffer path is a special case of the reader path rather than a second
implementation.

`isDfont` walks the container a second time, and that is accepted rather than
optimised away. The walk touches the 16-byte header and the map and reads no
glyph data, so the cost is a few hundred bytes; what it buys is a dispatch chain
that reads uniformly — `isType1(bytes)` sits directly above it — and an
`extractDfontFace` that can throw a diagnostic `PdfParseError` for an
out-of-range index instead of returning `undefined` and losing the distinction
between "not a suitcase" and "no such face in this suitcase".

## The format, and the four details that are silent when wrong

Header, 16 bytes at offset 0 — `dataOffset`, `mapOffset`, `dataLength`,
`mapLength`, all `u32`. Data area: `u32`-length-prefixed blobs. Map at
`mapOffset`: 16 reserved bytes, 8 more reserved, then `u16` offset to the type
list and `u16` offset to the name list, both from the map start.

Four details produce a plausible wrong answer rather than a failure, so each
gets an invariant and a mutation check:

**Both counts are stored MINUS ONE.** The type list opens with "number of types
minus 1" and each type entry carries "number of resources minus 1". A suitcase
holding a single face stores `0`. Read either raw and every single-face `.dfont`
in existence yields no faces at all — the font simply vanishes, with no error
anywhere to say why.

**The reference-list offset is from the TYPE LIST start**, while the type-list
offset is from the MAP start. The two bases differ by the map's 30-byte prologue,
so mixing them lands inside a real structure and reads a plausible wrong list.

**A resource's data offset is a `u24`, and points at a length, not at data.**
It is relative to `dataOffset`, and the four bytes it addresses are the `u32`
resource length; the sfnt begins **four bytes later**. Omit the skip and every
face is offset by four — which fails the sfnt version check, so it degrades to
"no faces found" rather than to garbage, but from a cause nothing reports.

**Non-`sfnt` types share the map.** A real suitcase carries `FOND` family
records, and often `NFNT` bitmap strikes or `POST` Type 1 fragments, in the same
type list. Faces must be selected **by type tag**, never by position in the map:
indexing positionally returns a `FOND` as though it were a font.

## The index half

`FONT_EXT` gains `.dfont`, so a suitcase is found by DEFAULT with no `l1my.4`
sniff — the rule `.pfb` and `.pfa` got in `l1my.5`.

`peekNames` branches after the `ttcf` test. The partial-read cost model survives
one more format: the 16-byte header, then the map, then only the `name`, `head`
and `OS/2` ranges of each face. A map is small even for a large suitcase, and is
read under a bound rather than trusted — `mapLength` is a `u32` in a file we did
not write.

**One shared-code change.** `faceAt(dirOffset)` currently reads the table
directory at an absolute offset and then reads each table at the absolute offset
its record states. That is right for a bare sfnt and for a `.ttc`, whose table
offsets are absolute into the file — and wrong for a `.dfont`, whose are
relative to its resource. `faceAt` therefore gains a `base` parameter added to
each table offset. Both existing callers pass `0`, so their behaviour is
unmoved; the `.dfont` caller passes the resource's sfnt start.

`faceIndex` addresses `sfnt` resources in reference-list order, exactly as it
addresses collection faces. That is what gives multi-face suitcases — the common
Mac shape, with regular, bold, italic and bold-italic in one file — to
`LoadFontByName`, `LoadFontFamily` and `fontmatch.ts` for free.

## Both halves land together

Index and `AddFont` ship in one piece. `l1my.5` recorded what the front half
alone does: a name reader without a loader lets `ResolveFontByName` report a
family that `LoadFontByName` then fails to load, which is an inconsistency
between two entry points `l1my.3` shipped as one selection.

Here the second half is nearly free anyway — a `.dfont`'s payload is an ordinary
sfnt, so `parseSfnt` needs one dispatch line and nothing downstream changes at
all. There is no conversion, no synthesized `cmap`, no `psName` threading; the
face that comes out is the face the suitcase contains, byte for byte.

## Degradation

Nothing in the folder scan throws. A `.dfont` that will not parse yields no
faces and is skipped, so one corrupt suitcase in a system font directory cannot
break every lookup on the machine — the rule `peekNames` already holds for a
malformed sfnt and a malformed Type 1.

`extractDfontFace` **does** throw `PdfParseError`, for a non-`.dfont`, an
out-of-range `faceIndex`, or a resource range that runs past the end of the
file. That asymmetry is `ttc.ts`'s and is deliberate: a caller scanning a folder
catches and skips, while a caller naming a face is being told it asked for
something that is not there.

`parseSfnt` keeps its documented rule unchanged: `faceIndex` selects a face of a
CONTAINER and is meaningless rather than erroneous elsewhere. A `.dfont` is a
container, so it behaves exactly as a `.ttc` does — naming face 3 of a two-face
suitcase throws, while naming face 3 of a bare `.ttf` is ignored. `fontsource.ts`
catches that throw and skips the file, which is why one malformed suitcase cannot
break a folder scan.

## Testing

`test/helpers/build-dfont.ts` assembles a resource fork around N sfnt payloads,
reusing `build-sfnt.ts`'s `buildNamedFont` for the payloads themselves. Knobs for
each trap: a non-`sfnt` type present in the map, a face count that straddles the
minus-one encoding, and padding before the data area so no offset is incidentally
zero.

- `test/dfont.test.ts` — the walk: ranges found, a face extracted and parsed, a
  non-`.dfont` rejected, an out-of-range index thrown on, a suitcase carrying a
  `FOND` beside its `sfnt`s, and a single-face suitcase (the minus-one case).
- `test/dfont-embed.test.ts` — `AddFontFile` on a `.dfont` embeds and the text
  extracts back through `Document.Open`.
- `test/font-byname.test.ts` — appended: found by family name; a multi-face
  suitcase resolving bold and italic separately; found by DEFAULT with no sniff;
  found by STRUCTURE when the file has no extension at all; a corrupt suitcase
  skipped while a real one beside it is still found.

**Mutations that must go red**, each recorded in the commit body: dropping either
`+ 1` on the two counts; taking the reference-list offset from the map start;
omitting the four-byte length skip; selecting resources positionally rather than
by type tag; dropping the `base` parameter from `faceAt`; and removing the
`parseSfnt` dispatch branch.

**What this suite cannot prove, stated rather than left to be discovered.**
There is no real `.dfont` in `test/fixtures/`, so our builder and our reader
share one reading of Inside Macintosh and the suite demonstrates that they agree
— not that either matches the format. That is the shared-convention class this
repo keeps real-world fixtures for, and it is uncovered here. `PROVENANCE.md`
must say so plainly, in the same voice `type1.ts` uses about
`NimbusSans-Regular.t1`'s missing flex and `seac` paths, and `jbig2.ts` uses
about its REFAGG vectors. A follow-up issue to vendor a real suitcase and
cross-check is worth filing; it is not a blocker.

## Out of scope

- **A `.dfont` whose `sfnt` resource is itself a `ttcf`.** Legal to construct and
  vanishingly rare. `faceIndex` has already been consumed by the container layer
  by the time such a payload reaches the collection test, so supporting it needs
  a two-level addressing scheme nobody has asked for. Documented, not handled.
- **`.suit` and other classic suitcases.** A `.suit` keeps its resources in a
  true resource fork, so on any non-Mac filesystem its data fork is empty or
  arbitrary. Only `.dfont` joins `FONT_EXT`; anything else that happens to hold
  resource-fork bytes in its data fork is still reachable through the structural
  test, under `sniff`.
- **`NFNT` bitmap strikes and `POST` Type 1 fragments.** Skipped by the type
  filter. Neither is an outline format this library can embed.
- **Resource IDs and resource names.** Ignored. A face is named by its own `name`
  table, like every other format here.

## Documentation

`CHANGELOG.md` under `### Added`; `README.md`'s accepted-formats sentence in the
font section, beside the Type 1 clause `l1my.5` added; and a `CLAUDE.md` bullet
for `dfont.ts` carrying the four silent-when-wrong invariants, the reader-callback
seam and why it exists, the dispatch-order rule, and the fixture gap above.
