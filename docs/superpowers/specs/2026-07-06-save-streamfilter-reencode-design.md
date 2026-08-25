# Save({ streamFilter }): document-wide re-encode pass

**Issue:** aspose-pdf-foss-for-ts-3jf
**Date:** 2026-07-06
**Depends on:** aspose-pdf-foss-for-ts-ox6 (filter encoders + `encodeStream` helper, shipped)

## Context

`ox6` landed the four missing byte-filter *encoders* (`ascii85Encode`,
`asciiHexEncode`, `runLengthEncode`, `lzwEncode`) plus `encodeFilter` /
`encodeStream` in `src/filters.ts`, as exact inverses of the existing decoders.
Those are primitives only — nothing in the `Save` path uses them yet.

This issue adds a `Save` option that re-encodes eligible data streams with a
chosen byte-filter across the whole document, sequenced correctly with the
encrypt pass. The primary use is 7-bit-ASCII-clean stream output via
ASCII85/ASCIIHex.

`serializeDocument` (`src/serializer.ts`) is the single serialization funnel:
`planDocument` mark-sweeps from `/Root` (+`/Info`), renumbers reachable objects
`1..N` into remapped **copies** (`plan.objs`), and the classic / compressed /
encrypted / compressed-encrypted writers all consume that `plan`. The encrypt
pass (`encryptor.encryptObject` over `plan.objs`) runs *inside* those writers.
`serializeStream` writes each stream's `raw` verbatim and recomputes `/Length`.

## API

Add to `SerializeOptions` (and therefore `SaveOptions`, which aliases it):

```ts
export type StreamFilterName =
  | 'ASCII85Decode' | 'ASCIIHexDecode' | 'LZWDecode' | 'RunLengthDecode';

export interface SerializeOptions {
  // ...existing...
  /** Re-encode eligible data streams with this byte-filter on Save. ASCII
   *  targets armor over any existing compression (7-bit-clean output); LZW /
   *  RunLength replace the existing byte-filters. Image-codec and structural
   *  streams are left untouched. Not supported with `linearized`. */
  streamFilter?: StreamFilterName;
}
```

`Document.Save` needs no change — it already forwards `SaveOptions` to
`serializeDocument`.

## Hook point

In `serializeDocument`, immediately after `const plan = planDocument(...)` (i.e.
after the `linearized` early-return, before choosing a writer), call:

```ts
if (options.streamFilter) applyStreamFilter(plan.objs, options.streamFilter);
```

Because `plan.objs` are already remapped copies and the encrypt pass runs
afterward inside the writers, this yields correct **filter-then-encrypt**
ordering for free and covers classic / compressed / encrypted /
compressed-encrypted in one place. The document inputs (`objects`, `trailer`)
are never mutated.

## Module: `src/streamfilter.ts`

Exports `StreamFilterName` and:

```ts
export function applyStreamFilter(objs: PdfObject[], filter: StreamFilterName): void
```

which walks `objs` and replaces each eligible stream **entry** with a re-encoded
copy (replacing the array slot, not mutating the shared `raw`).

`filters.ts` exports its existing `filterList(s)` reader
(`{ names: string[]; parms: (PdfDict | undefined)[] }`, both normalized to
per-filter arrays) for reuse here.

### Filter classification

```ts
const BYTE_FILTERS = new Set([
  'FlateDecode','Fl','LZWDecode','LZW',
  'ASCII85Decode','A85','ASCIIHexDecode','AHx','RunLengthDecode','RL',
]);
```

(`IMAGE_CODECS` already exists in `filters.ts`.)

### Eligibility

A stream object is eligible iff **all** hold:

1. It is a `PdfStream`.
2. Its `/Type` is not `XRef`, `ObjStm`, or `Metadata` (XMP metadata exempt;
   structural streams are synthesized by the writer and never appear in
   `plan.objs`, but the check is cheap defense).
3. Every name in its filter chain is in `BYTE_FILTERS` (an empty chain —
   uncompressed — qualifies). Any image codec or unrecognized filter →
   ineligible, left byte-identical.
4. Not already in target form (see "redundant" below).

### Transform — two modes

**ASCII targets (`ASCII85Decode`, `ASCIIHexDecode`) → armor.**
Do not decode. Wrap the existing raw payload, preserving inner filters:

- `newRaw = encodeFilter(target, s.raw)`
- `newNames = [target, ...names]`
- `/Filter` = single `name(target)` if `newNames.length === 1` (uncompressed
  input), else the array of names.
- `/DecodeParms`: if any existing filter had parms, set an array
  `[null, ...parms]` (leading `null` for the parm-less ASCII filter; each entry
  a `PdfDict` or `null`); otherwise omit `/DecodeParms` (and `/DP`) entirely.
- Redundant skip: if `names[0] === target` (already armored on top), skip.

Example: `/Filter /FlateDecode` → `/Filter [/ASCII85Decode /FlateDecode]`,
`raw` = ASCII85-encoded original Flate bytes → compression preserved, raw is
7-bit clean.

**Binary targets (`LZWDecode`, `RunLengthDecode`) → replace.**
Armoring a binary filter buys nothing, so fully decode and re-encode:

- `plain = decodeStream(s)` (eligibility guarantees no terminal codec, so this
  never throws for an eligible stream)
- `newRaw = encodeFilter(target, plain)`
- `/Filter` = single `name(target)`; delete `/DecodeParms` and `/DP`.
- Redundant skip: if `names.length === 1 && names[0] === target`, skip.

Both modes rebuild the stream dict as a copy of `s.dict` with the above
`/Filter` / `/DecodeParms` edits and `/Length = newRaw.length`, preserving all
other entries (`/Type`, `/Subtype`, `/Length1..3`, etc.). The serializer also
recomputes `/Length`, so this is belt-and-suspenders.

### Idempotent / round-trip guarantee

For every eligible stream, `decodeStream(reencoded)` deep-equals the original
`decodeStream(s)`. Armor mode wraps already-encoded bytes; replace mode is the
`ox6` `decode(encode(x)) === x` guarantee.

## Sequencing & unsupported combos

- **encrypt** — supported. The re-encode runs on `plan.objs` *before*
  `encryptObject`, so the filter is applied to plaintext and then encrypted; on
  open the reader decrypts, then decodes the filter chain. Required interaction.
- **compressed** — supported. Streams stay direct and get re-encoded; non-stream
  objects pack into the (binary, Flate) `ObjStm`, and the `XRef` stream stays
  binary. So full 7-bit cleanliness is a **classic-output** property; documented.
- **linearized** — unsupported: throw `UnsupportedFeatureError` when
  `streamFilter` is combined with `linearized`, guarded at the top of
  `serializeDocument` before the linearize early-return.
- **sign-on-save** (`serializeSignedDocument`) — unsupported: throw
  `UnsupportedFeatureError` if `streamFilter` is present. Out of scope; the
  normal `Save` signing flow returns fixed `pendingSignedBytes` anyway.
- **invalid filter name** — a JS caller passing anything outside the four
  `StreamFilterName` values (e.g. `'FlateDecode'` or garbage) throws
  `UnsupportedFeatureError` from `applyStreamFilter`'s validation.

The binary `%âãÏÓ` header comment is intentional and unaffected; "7-bit clean"
is a property of stream *contents*, not the whole file.

## Testing (`test/streamfilter.test.ts`)

Fixture builder in `test/helpers/` produces a document containing: an
uncompressed content stream, a `FlateDecode` content stream, a `FlateDecode`
stream with a predictor `/DecodeParms`, a `DCTDecode` image XObject, and a
`/Type /Metadata` XMP stream.

For each of the four targets:

- Save → reopen → every **eligible** stream `decodeStream`s byte-identical to
  its original decoded bytes.
- The `DCTDecode` image and the `/Metadata` stream are untouched (`/Filter` and
  `raw` unchanged).

Plus:

- **Armor preserves compression**: after `streamFilter: 'ASCII85Decode'`, the
  Flate stream's `/Filter` is `[/ASCII85Decode /FlateDecode]` and its `raw` is
  7-bit clean (every byte in the ASCII85 alphabet / `~>` terminator). The
  predictor stream keeps its `/DecodeParms` (now array `[null, <parms>]`).
- **Replace drops parms**: after `streamFilter: 'LZWDecode'`, an eligible
  stream's `/Filter` is `/LZWDecode` with no `/DecodeParms`.
- **encrypt interaction**: `Save({ streamFilter: 'ASCII85Decode', encrypt })` →
  reopen with password → streams decode byte-identical (proves filter-then-
  encrypt order).
- **linearized guard**: `Save({ streamFilter, linearized: true })` throws
  `UnsupportedFeatureError`.
- **invalid name guard**: `applyStreamFilter(objs, 'FlateDecode' as any)` (or via
  `Save`) throws `UnsupportedFeatureError`.

## README

- API overview: document `Save({ streamFilter })` with the ASCII-armor vs.
  LZW/RunLength-replace behavior and the classic-vs-compressed 7-bit caveat.
- Limitations/codec bullet: the document-wide re-encode pass now exists
  (previously "still pending"); note image-codec and metadata streams are left
  as-is.
