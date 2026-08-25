# Filter & Image-Format Coverage — Design

**Date:** 2026-06-30
**Status:** Approved (ready for implementation plan)

## Goal

Broaden the library's codec coverage on both the read and write sides:

- **Decode filters (read):** add `LZWDecode`, `ASCII85Decode`, `ASCIIHexDecode`,
  and `RunLengthDecode` so content streams, object/xref streams, embedded files,
  XMP packets, and images that use these filters parse instead of throwing.
  Today only `FlateDecode` decodes (README *Limitations*: "FlateDecode is the
  only supported stream filter for content decoding").
- **Image read:** route `Image.Decode()` through the new pipeline and add a
  `CCITTFaxDecode` (Group 3/4) decoder for scanned/fax images. LZW-coded images
  decode for free.
- **Image write:** broaden `AddImage` to accept **CMYK JPEG**, **interlaced
  PNG** (Adam7), and **palette `tRNS` PNG** (transparency → `/SMask`).

## Non-goals (explicitly out of scope)

- **Encoding filters on `Save()`** — output stays `FlateDecode`/raw. We add no
  ASCII85/Hex/LZW/RunLength *encoders* to the serializer.
- **`JBIG2Decode` / `JPXDecode`** — remain `UnsupportedFeatureError` in
  `Image.Decode()`.
- **16-bit-with-alpha PNG** — still unsupported in `AddImage`.
- **Grayscale / truecolor `tRNS`** (single transparent colour → color-key
  `/Mask`) — only palette (`colorType 3`) `tRNS` is in scope.
- Rendering/rasterization of any kind.

## Current state

`src/flate.ts` exposes `inflateStream(s: PdfStream): Uint8Array`, which handles
**one** filter — `FlateDecode` (or `Fl`) — plus an optional predictor, and
throws `UnsupportedFeatureError` for anything else. It is the single decode entry
point, reused by:

- content streams (`page.ts` line ~173),
- object streams / xref streams (`objstm.ts`, `xref.ts`),
- XMP (`document.ts` line ~449),
- embedded files (`embeddedfile.ts`),
- images — `Image.Decode()` (`image.ts` line ~68): `DCTDecode` passthrough,
  else `inflateStream`.

`src/imageembed.ts`:

- `buildJpegXObject` throws on any JPEG with `nc !== 1 && nc !== 3` ("CMYK not
  supported").
- `buildPngXObject` throws on interlaced PNG (`IHDR` byte 12 ≠ 0); ignores the
  `tRNS` chunk entirely; supports alpha only at 8-bit depth.

## Architecture

The unifying change: replace the single-filter `inflateStream` with a
**filter-chain decoder** that walks `/Filter` (name or array) and `/DecodeParms`
(dict or positional array) in order. "Byte" filters fully decode their input;
"image-codec" terminal filters stop the chain and hand the remaining bytes to the
image layer.

### Module map

New modules:

- **`src/filters.ts`** — orchestrator and codec registry.
  - `decodeStream(s: PdfStream): Uint8Array` — fully decode a stream; throws
    `UnsupportedFeatureError` if an image-codec filter remains in the chain
    (these are not valid for non-image streams anyway).
  - `applyDecodeFilters(raw, filters, parms) → { bytes, terminal? }` — apply the
    leading byte-filters in order; stop at the first image-codec filter and
    return the partially-decoded `bytes` plus the `terminal` filter name and its
    parms (for the image layer to handle).
  - A registry mapping filter name + abbreviation to a
    `(input: Uint8Array, parms: PdfDict | undefined) => Uint8Array` decoder.
- **`src/lzw.ts`** — `LZWDecode` (`LZW`): variable-width 9–12 bit codes, clear
  (256) / EOD (257) codes, `EarlyChange` (default 1), followed by predictor when
  `/DecodeParms` requests one.
- **`src/ascii.ts`** — `ASCII85Decode` (`A85`, `~>` EOD, `z` = four zero bytes,
  whitespace skipped), `ASCIIHexDecode` (`AHx`, `>` EOD, whitespace skipped, odd
  trailing nibble padded with `0`), `RunLengthDecode` (`RL`, PackBits: length
  byte 0–127 → copy n+1 literals, 129–255 → repeat next byte 257−n times, 128 =
  EOD).
- **`src/ccitt.ts`** — CCITT Group 3 (1D / 2D) and Group 4 (T.6) decoder
  producing 1-bit-per-pixel packed rows. Honors `CCITTFaxDecodeParms`: `K`
  (< 0 → G4, 0 → G3 1D, > 0 → G3 2D mixed), `Columns` (default 1728), `Rows`,
  `BlackIs1` (default false), `EncodedByteAlign` (default false), `EndOfBlock`
  (default true). `EndOfLine` tolerated.

Changed modules:

- **`src/flate.ts`** — keeps the zlib inflate + predictor codec. `inflateStream`
  becomes a thin back-compat wrapper that delegates to `decodeStream`, so every
  existing caller (xref/objstm/XMP/content/embedded-file) transparently gains
  LZW + ASCII filter support.
- **`src/image.ts`** — `Decode()` routes through `applyDecodeFilters`, then
  dispatches on the terminal filter.
- **`src/imageembed.ts`** — extend `buildJpegXObject` (CMYK) and
  `buildPngXObject` (Adam7 + palette `tRNS`).

### Decode pipeline (read)

Each codec is `(input, parms) => output`. Predictor handling stays attached to
**Flate** and **LZW** (both legal with `/Predictor` in `/DecodeParms`);
ASCII85/Hex/RunLength take no predictor. `decodeStream` resolves the parms array
positionally against the filter array and tolerates a single shared dict applied
to a single-filter chain. An empty / missing `/Filter` returns `s.raw`.

`applyDecodeFilters` classifies each filter:

- **byte filters** — `FlateDecode`/`Fl`, `LZWDecode`/`LZW`, `ASCII85Decode`/`A85`,
  `ASCIIHexDecode`/`AHx`, `RunLengthDecode`/`RL` → decode and continue.
- **image-codec (terminal) filters** — `DCTDecode`/`DCT`, `CCITTFaxDecode`/`CCF`,
  `JBIG2Decode`, `JPXDecode` → stop; return `{ bytes, terminal: { name, parms } }`.

`decodeStream` calls `applyDecodeFilters` and throws if `terminal` is set.

### Image read — `Image.Decode()`

```
const { bytes, terminal } = applyDecodeFilters(stream.raw, filters, parms);
if (!terminal) return bytes;                       // Flate/LZW/etc. → samples
switch (terminal.name) {
  DCTDecode  → return bytes;                        // JPEG passthrough (unchanged)
  CCITTFaxDecode → return decodeCcitt(bytes, terminal.parms, width, height);
  JBIG2Decode / JPXDecode → throw UnsupportedFeatureError;
}
```

This makes LZW-coded images decode (previously threw) and adds CCITT G3/G4.

### Image write — `AddImage` (`imageembed.ts`)

- **CMYK JPEG** (`buildJpegXObject`): when `nc === 4`, set `ColorSpace` to
  `DeviceCMYK`, keep `BitsPerComponent` = SOF precision. Scan for an Adobe
  `APP14` marker (`FF EE`, "Adobe"); when present (the common Photoshop case the
  bytes are stored inverted), emit `/Decode [1 0 1 0 1 0 1 0]` so colours render
  correctly. No APP14 → no `/Decode`.
- **Interlaced PNG** (`buildPngXObject`): implement Adam7 de-interlacing —
  inflate the IDAT stream once, then for each of the 7 passes compute the pass
  sub-image dimensions, unfilter its rows with the predictor at that pass width,
  and scatter the pixels into the full raster at the pass's (x,y) stride/offset.
  After assembly, the existing palette / alpha-split / colour-space logic runs
  unchanged.
- **Palette `tRNS`** (`buildPngXObject`, `colorType === 3`): read the `tRNS`
  chunk (a list of per-palette-index alpha bytes). Build an 8-bit `DeviceGray`
  `/SMask` plane by mapping each pixel's palette index to its alpha (indices at
  or beyond the `tRNS` length are fully opaque, 255). Keep the `/Indexed` colour
  image and attach the `/SMask`. When no `tRNS` is present, behaviour is
  unchanged.

## Error handling

- `decodeStream` on a non-image stream carrying an image-codec filter →
  `UnsupportedFeatureError` (name in message).
- `Image.Decode()` on `JBIG2Decode`/`JPXDecode` → `UnsupportedFeatureError`
  (unchanged contract).
- Malformed filter input (bad LZW code, truncated ASCII85 group, odd-length
  issues already covered) → `PdfParseError`.
- `AddImage` keeps throwing `UnsupportedFeatureError` for 16-bit-with-alpha PNG
  and for unrecognized formats; CMYK JPEG and interlaced/`tRNS` PNG now succeed.

## Testing (TDD, vitest)

Fixtures are built programmatically in `test/helpers/` wherever an encoder is
cheap; small binary goldens are checked in where an encoder is not:

- **ASCII85 / ASCIIHex / RunLength / LZW** — write tiny encoders in a test helper
  to produce inputs, then assert `decodeStream` round-trips arbitrary byte
  buffers (including edge cases: `z`/whitespace/`~>` for A85, odd nibble +
  whitespace for AHx, runs/literals/EOD for RL, clear-code table reset + 12-bit
  rollover + EarlyChange for LZW). Also assert filter **chains** (e.g.
  `[ASCII85Decode, FlateDecode]`) decode in order, and that
  `LZWDecode` + predictor matches the Flate+predictor result on the same source.
- **CCITT G3/G4** — uniform all-white / all-black images can be produced by a
  trivial encoder; a few small mixed-pattern bitmaps ship as checked-in golden
  vectors. Verify `K<0` (G4), `K=0` (G3 1D), `BlackIs1`, and `EncodedByteAlign`.
- **CMYK JPEG** — small checked-in golden `.jpg` fixtures (one Adobe-APP14
  inverted, one without); assert `ColorSpace = DeviceCMYK` and the `/Decode`
  array presence/absence.
- **Interlaced PNG** — build an Adam7-interlaced PNG programmatically (zlib +
  pass layout) and assert the embedded image's samples equal the same image
  embedded from its non-interlaced twin.
- **Palette `tRNS` PNG** — build an indexed PNG with a `tRNS` chunk; assert an
  `/SMask` is attached and its alpha plane matches the per-index alpha.
- **Regression** — existing xref/objstm/XMP/content/embedded-file decode tests
  must stay green through the `inflateStream → decodeStream` delegation.

README **Features** and **Limitations** (the "FlateDecode is the only supported
stream filter" line, the `AddImage` JPEG/PNG limitation line, and the
`Image.Decode()` filter note) are updated to match.

## Implementation phasing

One spec, two landable phases:

- **Phase A — decode pipeline + image read routing**
  `filters.ts`, `lzw.ts`, `ascii.ts`; `inflateStream` delegation; `Image.Decode()`
  routed through the pipeline (LZW images decode); JBIG2/JPX still throw. No new
  image-codec decoder yet (CCITT terminal filter throws a clear
  `UnsupportedFeatureError` until Phase B).
- **Phase B — CCITT + image-embed formats**
  `ccitt.ts` and wiring into `Image.Decode()`; `buildJpegXObject` CMYK;
  `buildPngXObject` Adam7 + palette `tRNS`.

Each phase ships with its own tests and is independently green
(`npm run typecheck` + `npm test`).
