# JPX Multi-Layer Quality-Layer Fixture — Design

**Issue:** aspose-pdf-foss-for-ts-pol · JPX: add multi-layer quality-layer test fixture
**Date:** 2026-07-20
**Parent:** kec (Image decode: JPXDecode) — closed

## Problem

`src/jpxt2.ts` implements multi-layer packet decoding, and `README.md:780` claims
"multiple quality layers" as supported. Nothing in the test suite executes that
claim.

All six fixtures in `test/helpers/jpx-fixtures.ts` are single quality layer. With
`cs.cod.layers === 1`, the layer loop in `decodeTier2` (jpxt2.ts:178) runs exactly
once per resolution, and these branches never execute:

- **Inclusion across layers** — `sb.inclTree.decode(bio, row, col, layer + 1)`
  (jpxt2.ts:143). At one layer the threshold is always 1, so the tag tree is never
  refined against a rising threshold.
- **The already-included path** — `include = bio.getbit() === 1` (jpxt2.ts:151).
  Unreachable: `cb.included` cannot be true on the only pass.
- **`lblock` growth** (jpxt2.ts:155) and **pass accumulation** (`cb.passes +=`,
  jpxt2.ts:158) — both accumulate across layers; with one layer they are plain
  assignment.
- **Segment concatenation** (jpxt2.ts:165-170) — the `merged` copy (jpxt2.ts:167)
  that stitches a code-block's contributions together always runs with an empty
  prefix.

Grepping `layer` across all seven `test/jpx*.test.ts` files returns nothing. The
issue text describes the path as "smoke-tested"; that is not borne out.

## Why there is no off-the-shelf fixture

The premise recorded on `kec` was re-verified rather than assumed.

Unpacking `@cornerstonejs/codec-openjpeg@1.3.0` and extracting the embind symbol
table from `openjpegwasm.wasm` gives the full encoder surface:

```
setBlockDimensions  setCompressionRatio  setDecompositions  setDownSample
setImageOffset      setNumPrecincts      setPrecinct        setProgressionOrder
setQuality          setTileOffset        setTileSize
```

There is no `setNumLayers`. The wrapper pins `tcp_numlayers` to 1. `getNumLayers`
exists, but on the **decoder** — which matters later.

Other npm candidates (`openjpeg`, `OpenJPEG.js`, `@voxelmed/openjpegjs`) are
decode-oriented Emscripten builds shipping no `opj_compress`. No `opj_compress`,
`kdu_compress`, or Python/glymur is available in this environment. The ISO/IEC
15444-4 conformance codestreams that carry multiple layers also carry tiles or
sub-sampling, both of which `parseCodestream` rejects outright (jpx.ts:93, jpx.ts:89).

## Approach: an offline re-layering transcoder

Rather than encode from samples, take a codestream the WASM encoder already
produced and **redistribute its existing code-block data across N layers**. No new
runtime dependency, no toolchain build, and the output stays inside the supported
envelope (one tile, one precinct, no sub-sampling).

### Why an arbitrary split is legal

In default mode — no `TERMALL`, no bypass — all coding passes of a code-block form
a **single MQ codeword segment**. A real encoder chooses layer boundaries at
rate-distortion-optimal truncation points and knows the byte length of each pass
prefix. A transcoder splitting an already-encoded segment does not.

This does not threaten the fixture, because the decoder concatenates per-layer
chunks (jpxt2.ts:165-170) and then runs the accumulated pass count over the
reassembled bytes. **Total passes and total bytes are preserved by any split**, so
a fully-decoded multi-layer stream is bit-identical to its single-layer source
regardless of where the cuts fall.

What an arbitrary split *does* forfeit is meaning for a partially-received stream:
truncate at a non-optimal offset and the surviving passes decode to noise, not to
a coarser image. The fixture therefore asserts nothing about intermediate layers,
and the generator documents the cut points as arbitrary-but-legal.

### Scope boundary

Out of scope, deliberately: truncated-stream decode tests (no sound quality claim
available, per above), and any change to `src/`. This issue adds coverage for code
that already exists; if the tests fail, that is a separate bug to file.

## Components

### `scripts/jpx-relayer.mjs` (new)

Offline, dev-only, never shipped or imported by `src/`. Single entry point:

```js
relayer(j2kSingleLayer, nLayers) -> j2kMultiLayer
```

**Self-contained**, not importing `dist/jpxt2.js`. `scripts/gen-jpx-fixtures.mjs`
is standalone plain `.mjs` whose documented workflow is `npm install` the codec →
`node script` → `npm uninstall`; adding an `npm run build` prerequisite adds a
failure mode to a script run perhaps once a year. Cost is roughly 90 duplicated
lines of `Bio` and `TagTree`. Accepted.

Three stages:

1. **Parse.** Walk the main header, then run a tier-2 packet parse over the tile
   data, recovering per code-block `{ zeroBitPlanes, passes, segment }`. Mirrors
   `readPacket` (jpxt2.ts:134-173) and the geometry built by `buildComponent`
   (jpxt2.ts:90).

2. **Split.** Distribute each code-block's `passes` across `nLayers` as evenly as
   possible; cut its `segment` at the same proportional byte offsets. A block with
   fewer passes than layers contributes only to the first *k* layers. A block never
   included in the source stays excluded in every layer.

3. **Emit.** Packets in LRCP order, layer outermost, using:
   - a `Bio` bit **writer** — MSB-first, 0xFF bit-stuffing, byte-aligned at header
     end (the inverse of `Bio`, jpxt2.ts:10);
   - a tag-tree **encoder** for inclusion and zero-bit-planes (inverse of
     `TagTree`, jpxt2.ts:33), inclusion coding each block's first contributing layer;
   - the pass-count code of `readPassCount` (jpxt2.ts:112), inverted;
   - `lblock` growth 1-bits so each length fits `lblock + floor(log2(passes))` bits.

   Then the byte-aligned header followed by the layer's bodies in the same order.

**Rewrite.** Main header copied verbatim, COD layer count patched (`u16` at COD
segment offset 2 — the field read at jpx.ts:101), tile data replaced, `Psot`
recomputed, EOC re-emitted.

### `scripts/gen-jpx-fixtures.mjs` (modified)

Gains a lossless RGB **LRCP** encode (`progression: 0`) as the RGB source — the
existing lossless RGB fixture is RPCL — then calls `relayer(..., 3)` on it and on
the existing lossless gray source.

Three layers, not two: `>2` makes the already-included path and `lblock`
accumulation fire repeatedly rather than exactly once.

The header comment's "a real multi-layer fixture is tracked as a follow-up bd
issue" is removed.

### The validation gate

After transcoding, each stream is decoded through the WASM OpenJPEG **decoder**
(the generator's existing `decode()` helper) and asserted equal to the source
samples. The generator throws and writes nothing if this fails.

This is the point of leverage the decoder/encoder asymmetry gives us. The chosen
approach means our packet writer is checked by our packet reader, where a shared
misreading of Annex B.10 would pass silently. Routing the bytes through OpenJPEG
first means an independent implementation must accept them before the fixture is
ever committed.

### `test/helpers/jpx-fixtures.ts` (regenerated)

Adds `multilayer_gray_j2k`, `multilayer_rgb_j2k`, `multilayer_rgb_rgb`.
`multilayer_gray_j2k` reuses the existing `lossless_gray_rgb` as ground truth,
since re-layering is sample-preserving.

### `test/jpx.test.ts` (modified)

Two cases in the existing `decodeJpx end-to-end` block, matching its style:

- `'multi-layer (3 quality layers) grayscale decodes exactly'` — bit-exact
  `toEqual` against `lossless_gray_rgb`.
- `'multi-layer (3 quality layers) RGB decodes exactly'` — bit-exact against
  `multilayer_rgb_rgb`.

Each also asserts `parseCodestream(fixture).cod.layers === 3`. Without it, a
regeneration that silently produced a single-layer stream would leave both tests
passing while covering nothing — the exact failure this issue exists to end.

## Verification

- `npx vitest run test/jpx.test.ts` — new cases green.
- `npm test` and `npm run typecheck` — both green before close.
- Coverage claim confirmed by construction: with `cod.layers === 3` asserted, the
  branches listed under *Problem* are necessarily executed.
