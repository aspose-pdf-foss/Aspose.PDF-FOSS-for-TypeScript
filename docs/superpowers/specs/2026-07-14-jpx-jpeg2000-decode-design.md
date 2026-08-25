# JPXDecode (JPEG 2000) image decoding — design

**Issue:** `aspose-pdf-foss-for-ts-kec` — Image decode: JPXDecode (JPEG 2000)
**Date:** 2026-07-14
**Status:** Approved design, pending implementation plan

## Goal

Decode JPEG 2000 (`JPXDecode`) codestreams embedded in PDF image XObjects to
8-bit interleaved samples, so `ImageInfo.Decode()` returns pixels (today it
throws `UnsupportedFeatureError`) and `ToImage`/`ToSvg` render JPX images.

Acceptance (from the issue): `Image.Decode()` returns samples for a baseline
JP2/J2K fixture; documented coverage boundaries; vitest; README.

## Scope boundary

### Supported this pass
- Container: JP2 box format (signature/`ftyp`/`jp2h`/`jp2c`) **and** a bare J2K
  codestream (leading `SOC` marker). Detect and handle both.
- **Single tile** covering the whole image.
- **Multiple quality layers.**
- **All five progression orders**: LRCP, RLCP, RPCL, PCRL, CPRL — with the
  default (maximal) single-precinct-per-resolution partition.
- Wavelets: 5/3 reversible (lossless) and 9/7 irreversible (lossy).
- Arbitrary number of decomposition (resolution) levels.
- Components: 1 (grayscale) and 3 (RGB) with RCT (reversible) / ICT
  (irreversible) multiple-component transforms.
- Component bit depths ≤ 16, **downshifted to 8-bit** on output.

### Out of scope → throw `UnsupportedFeatureError`
- Multiple tiles (tile grid finer than one tile over the image).
- Custom precinct partitions (non-default `Sprec`).
- Region of interest (`RGN`).
- More than 3 components; opacity/palette/channel-definition boxes.
- Component sub-sampling ≠ 1 in either axis.

Malformed / truncated data → `PdfParseError`.

Rationale for the throw contract: `raster.ts`/`pagerender.ts` already wrap image
decode in `try/catch` and degrade gracefully, so throwing on unsupported inputs
is safe for the render path; `Image.Decode()` surfaces the typed error to
callers.

## Architecture

New modules, mirroring the granularity of `jpeg.ts` but split because the EBCOT
entropy path is large. Each has one clear purpose and a narrow interface.

| Module | Responsibility | Isolated test |
|---|---|---|
| `jpx.ts` | Public `decodeJpx(bytes) → JpxImage`. Parses JP2 boxes + codestream markers (`SIZ`/`COD`/`COC`/`QCD`/`QCC`/`SOT`/`SOD`/`EOC`/`COM`) into a `Codestream` model, then orchestrates the decode pipeline. | marker parser unit |
| `jpxmq.ts` | MQ arithmetic decoder (ISO/IEC 15444-1 Annex C): Qe probability table (47 states), `INITDEC`/`DECODE`/`RENORMD`/`BYTEIN`. | ISO Annex test vector |
| `jpxt1.ts` | EBCOT Tier-1: code-block bit-plane decode — significance-propagation, magnitude-refinement, and cleanup passes; context formation, sign coding, run-length in cleanup. Produces quantized subband coefficients. | synthetic code-block |
| `jpxt2.ts` | EBCOT Tier-2: tag-tree (quad-tree) decode, packet-header parsing (code-block inclusion + zero-bit-plane trees, pass counts, length signalling), and the packet iterator over the five progression orders across layers/resolutions/subbands/precincts. | tag-tree + iterator units |
| `jpxwavelet.ts` | Inverse DWT: 5/3 and 9/7 lifting, applied 2D per resolution level, with LL/HL/LH/HH subband reassembly. | lifting round-trip |

### Public output type

```ts
export interface JpxImage {
  width: number;
  height: number;
  comps: number;       // 1 (gray) or 3 (RGB)
  data: Uint8Array;    // component-interleaved 8-bit samples, row-major
  bitDepth: number;    // native component precision (informational; data is 8-bit)
}
```

`data` layout matches the interleaved-sample convention already produced by
`decodeJpeg().data`, so downstream color handling in `raster.ts` is uniform.

## Data flow

```
PDF stream bytes (JPXDecode is terminal; no prior sample filter)
  │
  ▼  jpx.ts: detect JP2 box wrapper vs bare codestream → extract codestream
  ▼  jpx.ts: parse markers → Codestream { image size, component precision/sign,
  │          COD/COC (progression, #layers, #levels, code-block size, wavelet,
  │          precincts), QCD/QCC (quantization) }
  │
  ▼  jpxt2.ts: iterate packets (progression order) → per code-block:
  │            coded byte segment, coding-pass count, zero bit planes
  ▼  jpxt1.ts: MQ-decode each code-block → quantized coefficients per subband
  ▼  dequantize (9/7: reconstruction step sizes from QCD/QCC; 5/3: none)
  ▼  jpxwavelet.ts: inverse DWT per component → component sample planes
  ▼  inverse multiple-component transform (RCT / ICT) when COD signals it
  ▼  DC level shift (+2^(bitDepth-1) for unsigned components)
  ▼  clamp + downshift to 8-bit, interleave components
  │
  ▼  JpxImage { width, height, comps, data, bitDepth }
```

## Integration points

- `src/image.ts` — `ImageInfo.Decode()`: add a terminal-`JPXDecode` branch that
  calls `decodeJpx(bytes)` and returns `data`. Update the method doc comment
  (currently states JPX throws). JPX becomes samples, unlike the DCT passthrough.
- `src/raster.ts` — remove `JPXDecode` from `NO_RASTER_DECODER`; add a JPX branch
  parallel to the `decodeJpeg` branches (`try { decodeJpx(...) } catch { return
  undefined }` to keep the degrade-on-failure behavior).
- `src/pagerender.ts` — same JPX branch for the render/`ToImage`/`ToSvg` path.
- `src/pdfavalidate.ts` — no change (JPX already prohibited in PDF/A-1; the new
  decoder does not alter validation).
- `src/index.ts` — no change. Codec entry points (`decodeJpeg`, `decodeCcitt`)
  are internal, not part of the public surface; `decodeJpx` stays internal too,
  consumed via `Image.Decode()` and the render path.

## Error handling

- Unsupported-but-valid features (multi-tile, precincts, ROI, >3 comps,
  sub-sampling): `UnsupportedFeatureError` with a specific message naming the
  feature.
- Structurally invalid / truncated codestreams and boxes: `PdfParseError`.
- Internal invariant violations degrade to `PdfParseError` rather than throwing
  raw `Error`, keeping the public error surface to the three documented types.

## Testing

### Unit (hand-computed / spec vectors, no external fixtures)
- `jpxmq`: decode the ISO/IEC 15444-1 Annex C test byte sequence, assert the
  documented decoded-bit output.
- `jpxt2` tag-tree: encode-free structural cases with known packet headers.
- `jpxwavelet`: forward (simple reference in the test) → inverse round-trip for
  both 5/3 and 9/7 recovers the input within tolerance (5/3 exactly).
- `jpx` marker parser: a hand-built `SIZ`/`COD`/`QCD` byte blob parses to the
  expected `Codestream` fields.

### Integration (embedded base64 fixtures)
`test/helpers/jpx-fixtures.ts` holds base64 codestreams. Cases:
1. 5/3 lossless grayscale → **exact** sample match.
2. 9/7 lossy RGB → match within a tolerance.
3. Multi-layer codestream → decodes to full quality.
4. An alternate progression order (e.g. RPCL) → same image as the LRCP variant.
5. JP2 box wrapper vs bare codestream of the same image → identical samples.

### PDF-level
- `test/helpers/build-jpx-pdf.ts` builds a PDF embedding a JPX image XObject.
- Assert `img.Decode()` returns the right length + plausible samples.
- `ToImage` render smoke test on that page.

### Fixture generation pipeline (offline, one-time; preserves zero runtime deps)
- `scripts/gen-jpx-fixtures.mjs`: uses a WASM OpenJPEG **devDependency**
  (`openjpeg` on npm, registry-reachable and confirmed) to encode known rasters
  into the variants above, then writes base64 into `test/helpers/jpx-fixtures.ts`.
- The devDependency is added only for generation and removed afterward (or kept
  strictly under `devDependencies`); it never becomes a runtime dependency.
- The regeneration command is documented in a header comment of the generated
  file and in the script.
- Contingency if the WASM encoder proves unusable during the spike: fall back to
  committing a few tiny externally-produced reference `.jp2`/`.j2k` files as
  base64 (still decoder-only work).

## Documentation

- `README.md`: move JPXDecode from Limitations to Features; document the
  supported subset and the throw boundaries listed above.
- Update the `ImageInfo.Decode()` doc comment in `src/image.ts`.

## Effort & phasing

Estimated ~2,500–3,500 lines including tests. The implementation plan will phase
bottom-up, each phase independently testable before the next:

1. `jpxmq` — MQ decoder + ISO vector test.
2. `jpxwavelet` — inverse 5/3 and 9/7 + round-trip tests.
3. `jpxt1` — Tier-1 code-block decode + synthetic tests.
4. `jpxt2` — tag-trees, packet parsing, progression iterator + unit tests.
5. `jpx` — container + marker parse + pipeline orchestration; first end-to-end
   fixture (5/3 lossless gray).
6. Remaining fixtures (lossy, multi-layer, progression, JP2 vs raw).
7. Integration: `image.ts`, `raster.ts`, `pagerender.ts`, PDF-level test, README.

Each phase is a candidate bd sub-issue under `kec`.
