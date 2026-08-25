# JBIG2 completeness (utax)

`JBIG2Decode` today decodes the mainstream of a scanned document: generic
regions (arithmetic templates 0–3, TPGDON, and MMR through `ccitt.ts`), symbol
dictionaries, text regions, and the MQ arithmetic coder shared with JPEG 2000.
That is 383 lines across five modules, and it is enough for the output of every
common bilevel encoder.

It is not enough for T.88. Five segment types throw `UnsupportedFeatureError`
outright, and three optional paths inside the types we *do* handle throw as
well. This design closes all of it: after the seven children below the decoder
raises no `UnsupportedFeatureError` at all, and its one remaining refusal is the
`0xffffffff` unknown-length `PdfParseError` — a limit of the container
organization rather than a coding feature it cannot read.

## The gap, segment by segment

| Type | Segment | Today | Closed by |
|---|---|---|---|
| 0 | symbol dictionary | arithmetic only | Huffman + REFAGG paths |
| 4 / 6 / 7 | text region | arithmetic, no SBREFINE | Huffman + SBREFINE paths |
| 16 | pattern dictionary | throws | halftone |
| 20 / 22 / 23 | halftone region | throws | halftone |
| 36 / 38 / 39 | generic region | works | 36 corrected to intermediate |
| 40 / 42 / 43 | refinement region | throws | GRRD |
| 52 | profiles | throws via `default:` | skipped, with 48–51 |
| 53 | custom Huffman table | throws via `default:` | Huffman infrastructure |

Type 52 is not a feature. It carries no bitmap and belongs on the
`case 48: case 49: … break;` line beside the page-information and end-of-*
segments; it reaches `default:` only because nobody has met one.

## Architecture

Four new modules, following the existing one-file-per-concern split and the
leaf-module habit `bordersides.ts` and `choiceopt.ts` already set.

- **`jbig2refine.ts`** — generic refinement region decoding (§6.3): templates 0
  and 1, the two AT pixels, TPGRON. Pure over `Bitmap` and an `MqDecoder`. It
  takes the reference bitmap and its `(dx, dy)` as arguments and knows nothing
  about segments, which is what lets one procedure serve three callers.
- **`jbig2halftone.ts`** — the pattern dictionary (§6.7), the grayscale-plane
  decode (Annex C.5) and halftone region placement (§6.6).
- **`jbig2huffman.ts`** — the bit reader, the `HuffmanTable` model and B.3's
  code assignment, the fifteen standard tables B.1–B.15, custom-table segment
  parsing (§B.2.3), and the runcode symbol-ID table (§7.4.3.1.7).
- **`jbig2ints.ts`** — the `IntSource` interface and its two implementations,
  one over `decodeInt`/`decodeIaid`, one over Huffman tables. A leaf, so
  `jbig2symbol.ts` and `jbig2text.ts` depend on the interface rather than on
  both entropy stacks.

Table *selection* stays in `jbig2.ts` with the rest of the header parsing. A
symbol dictionary picks four tables from its flag bits and a text region eight,
each resolving to a standard table or to a referred type-53 segment;
`jbig2ints.ts` receives concrete tables and never sees a flag word. This
preserves the division the module already has — `jbig2.ts` parses headers, the
other modules decode bodies.

## Page assembly and intermediate regions

`decodeJbig2`'s loop grows from one lookup map to four, all keyed by segment
number:

```
symbolsBySeg   Map<number, Bitmap[]>       exists today
patternsBySeg  Map<number, Bitmap[]>       pattern dictionaries
tablesBySeg    Map<number, HuffmanTable>   type-53 custom tables
buffersBySeg   Map<number, Buffered>       intermediate regions + their RegionInfo
```

Four typed maps rather than one map to a tagged union. Every reference resolves
by kind — a text region wants symbol dictionaries and tables, a refinement
region wants a buffer — so a wrong-kind reference is a lookup miss rather than a
runtime type test, and the reader can see at each call site what a referred-to
segment is expected to be.

**Invariant:** an intermediate region segment (4, 20, 36, 40) is stored for a
later segment to consume and is **invisible to the page** until something
consumes it. Only the immediate forms (6/7, 22/23, 38/39, 42/43) composite.
`jbig2.ts` composites types 36 and 4 today, which is wrong by §7.4 — and it is
wrong in the direction that looks right, because in a file where the
intermediate region is subsequently refined onto the same spot, the page ends up
with approximately the intended ink. Every fixture we have passes either way.

## Generic refinement (GRRD)

One procedure, §6.3, three callers, each supplying a different reference:

| Caller | Reference bitmap | Offsets from |
|---|---|---|
| refinement region segment | the referred buffer, else the page under the rect | segment header |
| symbol dictionary, REFAGG=1, NINST=1 | a symbol already in the dictionary | decoded RDX/RDY |
| text region, SBREFINE, RI≠0 | the symbol being placed | decoded RDX/RDY |

Template 0 builds a 13-bit context from three coding pixels, eight reference
pixels and the two AT pixels; template 1 a 10-bit context from four coding and
six reference pixels and no AT. TPGRON adds an LTP bit per row, decoded against
a fixed context, and where LTP is set each pixel whose 3×3 reference
neighbourhood is uniform takes that value directly instead of being decoded.

**Invariant:** a refinement region whose referred-to set contains no
intermediate region refines **the page itself** — the reference is the page's
current pixels under the region rectangle, and the result **replaces** them.
The region segment's external combination operator does not apply to that case.
Combining instead of replacing is the failure that hides: refinement output
OR-ed onto its own input is more ink in roughly the right places, which renders
as a slightly bold page rather than as a fault.

**Invariant:** GRRD is arithmetic-only. T.88 defines no MMR refinement, which
is why a Huffman text region has to alternate entropy coders within one stream
(below) rather than refining in its own coding.

REFAGG with `REFAGGNINST > 1` is decoded as a **text region** over the
dictionary's current symbols (§6.5.8.2), so `jbig2symbol.ts` gains a dependency
on `jbig2text.ts`. That edge does not exist today and closes no cycle —
`jbig2text.ts` imports only `jbig2.ts` and `jbig2arith.ts` — but it does require
`decodeTextRegion` to accept a caller-supplied `MqDecoder` and context set, the
way `decodeGeneric` already accepts `mqIn`/`cxIn` for exactly this reason.

## Halftone

The pattern dictionary is the simple half: flags, `HDPW`, `HDPH`, `GRAYMAX`,
then **one** collective bitmap decoded as a generic region `(GRAYMAX+1)·HDPW`
wide and `HDPH` tall with AT1 pinned at `(-HDPW, 0)`, sliced into `GRAYMAX+1`
patterns. `decodeGeneric` serves it unchanged.

The halftone region decodes a **grayscale image**, not a bitmap:
`ceil(log2(HNUMPATS))` bitplanes, each a generic region of `HGW × HGH`, all
sharing one arithmetic decoder and one context set, MSB plane first; then the
Gray-code fold `plane[j] ^= plane[j+1]` downward; then the value at each grid
cell is the assembled bits. Each cell stamps `patterns[value]` at

```
x = HGX + mg·HRY + ng·HRX        y = HGY + mg·HRX − ng·HRY
```

both `>> 8`, since the grid vectors are 8.8 fixed point, combined with
`HCOMBOP`. The cross terms are why a transposed pair does not fail loudly: the
screen renders sheared, which reads as an unusual halftone rather than a bug.

Two requirements outside the module:

**`decodeGeneric` gains an optional `skip` bitmap** for HENABLESKIP.
**Invariant:** a skipped pixel is set to 0 and is **not decoded** — it consumes
no arithmetic decision. Implemented as a post-filter over a fully decoded plane
it desynchronises the bitstream from the first skipped pixel onward, so the
whole plane is wrong, but only for streams that set the flag.

**`ccitt.ts` gains an entry that reports bytes consumed.** Under HMMR the
bitplanes are not separate streams: they are decoded consecutively from one MMR
datastream with EOFB between them, and `decodeCcitt` takes a byte range and
returns an image with no way to say where it stopped. The existing signature has
callers throughout the filter stack and stays untouched; the new entry returns
`{ data, consumed }`. It is the only change this epic makes outside `jbig2*.ts`
and earns its own test in the CCITT suite rather than being validated solely
through a halftone fixture.

## Huffman

`jbig2huffman.ts` holds four things: an MSB-first bit reader with an explicit
`align()`; the table model (`{ prefixLen, rangeLen, rangeLow }` lines plus the
lower-range, upper-range and OOB lines) with B.3's canonical code assignment;
the fifteen standard tables as literal data; and custom-table parsing, where the
flags carry `HTOOB` and the prefix/range field widths and `HTLOW`/`HTHIGH` bound
a bit-packed run of lines.

Selection is per field and lives in `jbig2.ts`: `SDHUFFDH` → B.4/B.5/custom,
`SDHUFFDW` → B.2/B.3/custom, `SDHUFFBMSIZE` and `SDHUFFAGGINST` → B.1/custom;
`SBHUFFFS` → B.6/B.7/custom, `SBHUFFDS` → B.8/B.9/B.10/custom, `SBHUFFDT` →
B.11/B.12/B.13/custom, the four refinement fields → B.14/B.15/custom, and
`SBHUFFRSIZE` → B.1/custom.

### The three alignment points

Every Huffman bug we are likely to write lives at one of these, so they are
named rather than left to be rediscovered.

**Collective bitmaps (§6.5.9).** A Huffman symbol dictionary with REFAGG=0 does
not decode a bitmap per symbol. It decodes the widths of a whole height class,
reads `BMSIZE`, aligns, and reads one bitmap for the entire class — MMR-coded,
or, when `BMSIZE` is 0, stored uncompressed with each row padded to a byte —
then slices it by the widths already decoded.

**Invariant:** a Huffman symbol dictionary decodes one bitmap per **height
class**, not per symbol. This is the seam where the `IntSource` abstraction
genuinely stops: the outer height-class walk is shared with the arithmetic path,
the inner bitmap production is not, so it is injected as a separate per-class
producer rather than folded into the integer interface.

**The symbol-ID code table (§7.4.3.1.7).** A Huffman text region does not read
symbol IDs at a fixed width. It reads 35 four-bit runcode lengths, builds a
runcode table, decodes the per-symbol code lengths through it, builds the
symbol-ID table from those, and then aligns. There is no simpler fallback — this
runs for every Huffman text region.

**Refinement inside a Huffman text region (§6.4.11).** Since GRRD is
arithmetic-only, the region reads `RSIZE` with a Huffman table, aligns, runs an
`MqDecoder` over exactly those `RSIZE` bytes, and resumes reading Huffman bits
after them. One stream, two entropy coders, alternating.

## The IntSource seam

T.88 writes the symbol dictionary (§6.5) and the text region (§6.4) as one
procedure each with the entropy source swapped: every step reads "decode DT
using SBHUFFDT or IADT". `jbig2text.ts` hard-wires the arithmetic half of that
sentence today.

`IntSource` is the interface for the per-instance integers — `dt fs ds it id ri
rdw rdh rdx rdy`, each returning `number | null` so OOB survives — implemented
once over `decodeInt`/`decodeIaid` and once over Huffman tables. Once the
collective bitmap and the symbol-ID table are pulled out as their own producers,
what remains behind the interface is exactly the part where the two paths are
the same algorithm.

**Invariant:** there is ONE strip walk and ONE height-class walk, and the
entropy source is injected. A second copy of either — which is how Go arranges
it, in `jbig2_huffsym.go` and `jbig2_hufftext.go` — is how the Huffman and
arithmetic paths come to disagree about one document, the duplication this repo
records as the origin of half a dozen past defects.

## Testing

Every JBIG2 feature today is pinned by vectors minted from
`scripts/jbig2-codec.mjs`, a dev-only encoder plus reference decoder that
`gen-jbig2-fixtures.mjs` round-trips before writing `test/helpers/jbig2-*-vectors.ts`.
That approach continues, and each new feature costs an encoder half: a GRRD
encoder, a pattern-dictionary and grayscale-plane encoder, a bit writer with
table encoding, collective bitmaps and runcodes.

But an encoder written from one reading of T.88 shares that reading's mistakes,
and the repo already records the rule: *a differential test cannot validate the
parser it runs through*. So every feature also gets an anchor the round trip
cannot reach.

- **The standard tables need no encoder at all.** Annex B prints the assigned
  prefix **codes** for B.1–B.15, not merely the lengths, so asserting our B.3
  assignment against the printed codes is an outside check on the most
  mechanical and most transcription-error-prone part of the epic.
- **The Gray-code fold** (Annex C.5) is a pure function on bit patterns —
  hand-computed expectations, no bitstream.
- **Placement geometry** — the halftone grid vectors, the refinement `(dx, dy)`
  — is arithmetic over known inputs and testable with no coded data.
- **T.88's Annex H example bitstream** is the strongest anchor if its coverage
  suits: bytes written by the standard's authors with published decoded results.
  Its coverage is **unverified** at the time of writing. Sourcing it and
  recording which segment types it exercises is a task in the first child; if it
  lands, it becomes `test/fixtures/jbig2/` with a `PROVENANCE.md` in the shape
  `fixtures/jpeg/` and `fixtures/pdfx/` use. A feature it does not cover falls
  back to the anchors above plus the round trip, and says so in its own comment.

The standing rule applies throughout: prove each assertion load-bearing by
breaking the path and watching the suite go red. For a decoder this is both
unusually cheap — flip a template pixel, transpose a grid vector — and unusually
necessary, since almost any mistake still produces *an* image.

## Decomposition

Seven children in dependency order: the three existing ones rescoped, four new.

| # | Child | Scope | Size |
|---|---|---|---|
| 1 | page assembly *(new)* | four lookup maps, intermediate-region buffers, 36 and 4 corrected, 52 skipped | small |
| 2 | `utax.3` GRRD | `jbig2refine.ts`, templates 0/1, TPGRON, segments 40/42/43 | medium |
| 3 | GRRD consumers *(new)* | symbol-dict REFAGG including NINST>1, text-region SBREFINE | medium |
| 4 | `utax.1` halftone | pattern dict, grayscale planes, placement, HENABLESKIP, `ccitt.ts` consumed bytes | large |
| 5 | Huffman infrastructure *(new)* | bit reader, table model, B.1–B.15, custom table segment 53 | large |
| 6 | `utax.2` Huffman symbol dict | the `IntSource` seam, `jbig2ints.ts`, collective bitmaps | medium |
| 7 | Huffman text region *(new)* | runcode symbol-ID table, mixed-mode refinement | medium |

Each lands green on `main` with its own tests, and each **narrows** a throw
message rather than deleting it, so the decoder is never in a state where it
silently produces a wrong image instead of refusing one it cannot read.

Child 6 depends on child 3: a Huffman symbol dictionary may also set REFAGG, and
`SDHUFFAGGINST` means nothing until the aggregate path exists.

## Out of scope

- **Unknown segment data length (`0xffffffff`).** A container-organization
  feature of the embedded stream, not a coding feature; it stays a
  `PdfParseError` and keeps its own issue if anyone meets one.
- **The JBIG2 file organization** (file header, sequential/random-access
  ordering). PDF embeds the segment sequence directly; `decodeJbig2` is
  documented as embedded-only and stays that way.
- **Encoding JBIG2.** `scripts/jbig2-codec.mjs` grows, but it remains dev-only,
  unshipped, and imported by neither `src/` nor the tests.
