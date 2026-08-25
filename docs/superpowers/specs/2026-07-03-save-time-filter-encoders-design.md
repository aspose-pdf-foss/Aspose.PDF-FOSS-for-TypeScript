# Save-time Filter Encoders: ASCII85 / ASCIIHex / LZW / RunLength

**Issue:** aspose-pdf-foss-for-ts-ox6
**Date:** 2026-07-03

## Context

The library decodes five byte-filters on `Open` — `FlateDecode`, `LZWDecode`,
`ASCII85Decode`, `ASCIIHexDecode`, `RunLengthDecode` (decoders in
`src/ascii.ts` and `src/lzw.ts`, dispatched by `decodeOne` in `src/filters.ts`).
On output only `FlateDecode` (via `node:zlib` `deflateSync`) and raw exist; there
are no ASCII/LZW/RunLength *encoders* (README Limitations, "Stream decoding
covers the byte filters; encoding on `Save()` does not").

`serializeStream` (`src/serialize.ts`) writes each stream's `raw` verbatim and
recomputes `/Length`, honoring whatever `/Filter` the stream dict already
declares. So a stream's `raw` is expected to already be the encoded payload for
its declared filter — encoding happens when a stream is *built*, not at
serialize time.

## Scope

Add the four missing byte-filter encoders as the exact inverses of the existing
decoders, plus an `encodeStream` helper that builds a `PdfStream` carrying the
chosen `/Filter`. Round-trip tested against the existing decoders. Export the
encoders + helper publicly. README codec note updated.

**Out of scope (follow-up issue):** a document-wide `Save({ streamFilter })`
re-encode pass that walks eligible data streams, decodes them, and re-encodes
them in a chosen filter — together with its interactions with encryption,
linearization, compressed output, and signing. This spec ships the primitives
that pass will reuse.

## Encoders

Each encoder lives beside its decoder and is its exact inverse
(`decode(encode(x)) === x` for all `x`).

### `ascii85Encode(input: Uint8Array): Uint8Array` (`src/ascii.ts`)
Base-85, 4 bytes → 5 chars in `0x21..0x75` (`!`..`u`). An all-zero 4-byte group
emits `z`. A partial final group of `k` bytes (1..3) emits `k+1` chars (pad the
group with zero bytes, drop the trailing chars). Terminate with `~>`. No `<~`
prefix and no line wrapping — the decoder skips whitespace, so this stays
round-trip-exact and keeps the encoder simple.

### `asciiHexEncode(input: Uint8Array): Uint8Array` (`src/ascii.ts`)
Each byte → two uppercase hex digits; terminate with `>`.

### `runLengthEncode(input: Uint8Array): Uint8Array` (`src/ascii.ts`)
PackBits, the inverse of `runLengthDecode`:
- A run of `n` identical bytes (2 ≤ n ≤ 128) → length byte `257 − n` then the
  byte.
- A literal span of `n` non-repeating bytes (1 ≤ n ≤ 128) → length byte `n − 1`
  then the `n` bytes.
- Terminate with the EOD byte `128`.

Greedy: prefer encoding a run of ≥ 2 as a run; accumulate literals otherwise,
flushing at 128 or when a run starts. (Runs of length 2 are encoded as runs; a
2-byte run costs the same either way, and this keeps the flush logic simple.)

### `lzwEncode(input: Uint8Array, earlyChange = 1): Uint8Array` (`src/lzw.ts`)
Variable-width (9..12-bit) LZW, inverse of `lzwDecode`:
- Emit `CLEAR` (256) first; initialize the string table with the 256 singletons
  (next code 258, width 9).
- Standard LZW: grow the current match while `table` contains it; on a miss emit
  the current match's code, add `match + nextByte` at `next++`, and restart the
  match at `nextByte`.
- Bump the code width when `next` reaches `(1 << width) − earlyChange`
  (mirroring the decoder), capped at 12.
- When the table is full (`next` would exceed 4095 given the width cap), emit
  `CLEAR` and reset table/width/next.
- At end, emit the final pending match code, then `EOD` (257). Codes are packed
  MSB-first, matching the decoder's bit reader.

`earlyChange = 1` is the PDF default and the value the decoder uses; the
parameter exists for symmetry.

## Dispatch + stream helper (`src/filters.ts`)

- `encodeFilter(name: string, input: Uint8Array): Uint8Array` — mirror of
  `decodeOne`, switching on the canonical filter name (`FlateDecode` via
  `deflateSync`, `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode`,
  `RunLengthDecode`); throws `UnsupportedFeatureError` for anything else
  (including terminal image codecs and predictors — predictors are not applied
  on encode in this scope).
- `encodeStream(bytes: Uint8Array, filter: string, extraDict?: PdfDict): PdfStream`
  — build a `PdfStream` whose `dict` sets `/Filter` (and merges any `extraDict`),
  with `raw` = `encodeFilter(filter, bytes)`. Guarantees
  `decodeStream(encodeStream(x, f)) === x`.

## Public surface (`src/index.ts`)

Export `ascii85Encode`, `asciiHexEncode`, `runLengthEncode`, `lzwEncode`, and
`encodeStream`. These are the deliverable and the primitives the future
`streamFilter` Save pass will reuse.

## Errors

`encodeFilter` throws `UnsupportedFeatureError` for unknown/unsupported filter
names, matching `decodeOne`. The individual encoders do not throw on any byte
input (they encode arbitrary bytes, including empty input).

## Testing (`test/filter-encode.test.ts`)

- **Round-trip**: for each of the four filters, `decode(encode(x)) === x` over
  edge-case buffers — empty, 1..8 bytes, all-zeros (64 B), a 0..255 ramp, a long
  repetitive run (e.g. 5000× one byte), a mixed run/literal pattern, and a
  pseudo-random binary buffer.
- **Format assertions**: ASCII85 emits `z` for an all-zero group and ends with
  `~>`; ASCIIHex ends with `>`; RunLength compresses a long identical run to a
  handful of bytes and ends with `128`; LZW output begins with the packed
  `CLEAR` code and round-trips across the 9→10→11→12-bit width boundaries.
- **`encodeStream`**: `decodeStream(encodeStream(bytes, 'ASCII85Decode'))`
  returns `bytes` and the produced stream's dict has `/Filter /ASCII85Decode`;
  same for `LZWDecode` and `RunLengthDecode`.

## README

Update the "Stream decoding covers the byte filters; encoding on `Save()` does
not" Limitations bullet: the four encoders now exist (`ascii85Encode`,
`asciiHexEncode`, `lzwEncode`, `runLengthEncode`, plus `encodeStream`); note that
a document-wide `Save` re-encode pass is still pending (tracked as the follow-up
issue). Mention the encoders in the Features codec line.
