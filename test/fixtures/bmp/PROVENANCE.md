# BMP test fixtures — provenance

BMPs written by GDI+, here to validate `src/bmp.ts` against bytes it did not
produce. Issue `10u9.8`; the decoder itself is `10u9.2`, whose design is
`docs/superpowers/specs/2026-08-21-bmp-decode-design.md`.

**Read this first: what these do and do not add.** `test/bmp.test.ts` is *not*
unanchored. It transcribes two published Wikipedia hex dumps byte for byte,
which genuinely pin the 24-bit `BITMAPINFOHEADER` and the `BITMAPCOREHEADER`
cases against something outside this repo. What was builder-anchored is
everything past those two dumps — the palettes, the 16-bit forms, 32-bit — and
that remainder is what this directory covers.

Measured honestly, and unlike `test/fixtures/tiff/`, **no mutation is caught
here that `test/bmp.test.ts` misses**:

| Mutation to `src/bmp.ts` | `bmp-real` | `bmp.test` |
|---|---|---|
| no row flip | 10 | 7 |
| palette size assumed full (`clrUsed` ignored) | 2 | 5 |
| channel expansion truncates instead of rounds | **0** | 1 |

So the value is corroboration, not coverage: paths previously checked only
against our own builder are now checked against the format owner's bytes, which
is what catches a misreading our writer and reader would share. Two real-world
shapes came along that a builder would not have thought to emit — see
**What these files caught that a builder would not**.

**Do not read these fixtures as covering the rounding rule.** `Math.floor` and
`Math.round` agree on most 5-bit inputs (v=5 → 41.13 either way) and diverge
only where the fraction crosses a half, such as v=3 → 24.68. `test/bmp.test.ts`
pins that with a purpose-chosen channel value; the quantized source here never
lands on one.

---

## Producer

**GDI+ (`System.Drawing`)**, via Windows PowerShell — the imaging stack Windows
itself uses, and the closest thing BMP has to a reference implementation, the
format being Microsoft's own. It is also the only writer available on this box
that emits sub-8-bit palettes, `BI_BITFIELDS`, or a partial palette at all:
`magick`, `python`, `ffmpeg` and GIMP are absent, `sharp`/libvips cannot write
BMP, and no npm package writes those shapes.

**Reader (the oracle): `bmp-js` 0.1.0** (MIT), an unrelated pure-JS decoder, not
a dependency of this repo — installed once outside it and uninstalled, the
pattern `test/fixtures/jpeg/PROVENANCE.md` records.

Two parties matter here for a specific reason: **for a palette file the ground
truth cannot be the source image**, because GDI+ picks its own adaptive palette.
Only something that reads the file can say what it holds, and using GDI+ for
both halves would put one stack on both sides of the comparison.

Regenerate (Windows only — GDI+ is the producer):

```
mkdir /tmp/bmpgen && cd /tmp/bmpgen && npm init -y && npm install bmp-js@0.1.0
node <repo>/scripts/gen-bmp-fixtures.mjs --modules /tmp/bmpgen
```

`scripts/gen-bmp-fixtures.mjs` drives `scripts/gen-bmp-fixtures.ps1`; neither is
run by `npm test`.

## The image is ours; only the bytes are third-party

`source-rgb.raw` is 20×12 interleaved RGB, frozen as GDI+ received it. It is
asymmetric against the three traps `test/bmp.test.ts` names — **not square** (a
transposition would show), **no two rows alike** (a row flip would show), **no
two channels alike** (a BGR swap would show).

Every value is **mid-range, 40..214**, and that is load-bearing rather than
incidental. The first draft used a near-black corner (`7,3,0`), which quantizes
to index 0 or to black in *every* reduced format — so an assertion on it passes
whatever the code does. Staying clear of both clipping ends is what keeps the
1-, 4-, 8- and 16-bit files informative.

---

## The files

All are `BITMAPINFOHEADER` (DIB size 40), bottom-up, 20×12.

| File | SHA-256 | Bytes | bpp | Compression | Palette | Oracle |
|---|---|---|---|---|---|---|
| `gdi-1bpp-indexed.bmp` | `44212036…0590e73b` | 110 | 1 | BI_RGB | 2 | bmp-js |
| `gdi-4bpp-indexed.bmp` | `be3f2bfc…1f28c9c9` | 262 | 4 | BI_RGB | 16 | bmp-js |
| `gdi-8bpp-indexed.bmp` | `f72237ba…37c0e2a4` | 1190 | 8 | BI_RGB | **224** | bmp-js |
| `gdi-16bpp-555.bmp` | `5dc1ba79…6fd7b2f4` | 534 | 16 | BI_RGB (555 implied) | — | bmp-js, with a recorded divergence |
| `gdi-16bpp-565.bmp` | `2f4afbeb…3ff73251` | 546 | 16 | **BI_BITFIELDS** `f800/07e0/001f` | — | **none** — see below |
| `gdi-24bpp.bmp` | `f0dd7fe6…b921e5f3` | 774 | 24 | BI_RGB | — | source, exactly |
| `gdi-32bpp.bmp` | `711d5f91…0414ec49` | 1014 | 32 | BI_RGB, **no alpha declared** | — | source, exactly |

## What these files caught that a builder would not

**An 8-bit palette with 224 entries, not 256.** GDI+ emits only what its
quantizer used. A decoder assuming a full palette reads pixel data as palette
bytes and every offset after it is wrong — a plausible mistake nobody would
think to build a fixture for.

**`Format32bppArgb` saved with no alpha at all.** Windows writes it as plain
`BI_RGB` with a 40-byte header, so the fourth byte of each pixel is padding. That
is the negative half of the rule `10u9.2` documented — the fourth byte becomes an
`/SMask` only when the header *declares* alpha — now pinned by a file from the
format's owner rather than by our own builder's opinion of one.

**bmp-js expands 5-bit channels wrongly, and we do not.** Widening a 5-bit
channel to 8 bits must reach full scale: bit replication `(v << 3) | (v >> 2)`
and rounding `v * 255 / 31` agree everywhere and both map 31 → 255. bmp-js
truncates to `v << 3`, which caps at 248, so its whole raster is systematically
dark — measured on `gdi-16bpp-555.bmp`, our largest sample is 214 against its
208, with not one channel reading lower. The test asserts that *direction*
rather than equality, because an equality would have to be written against the
wrong convention and a bare tolerance would pass just as happily if the two
decoders swapped roles.

## No oracle for the BI_BITFIELDS file

`gdi-16bpp-565.bmp` has no `.expected.raw`: bmp-js throws on `BI_BITFIELDS`, so
there is no independent decoder here to compare against. Its anchors are the
file's own header — the three masks are asserted literally — and the source,
within the loss the format guarantees (5-bit R and B lose at most ~4 counts,
6-bit G at most ~2; the test bounds it at 8). A channel swap or a mask misread
blows straight through that. Stated plainly because it is a genuine hole in the
two-party arrangement every other file here enjoys.

## What these fixtures do NOT anchor

GDI+ writes none of these, and no available tool does:

- **RLE4 and RLE8.** Worth being explicit about why this is not a shortfall to
  be fixed later with more effort: the bug class these fixtures exist for is
  *our writer and our reader agreeing with each other and both disagreeing with
  the format*. A fixture we RLE-encoded ourselves could not catch it by
  construction. RLE stays builder-anchored **in principle**, not by omission.
- **`BITMAPV4HEADER` / `BITMAPV5HEADER`**, and therefore a 32-bit file that
  *declares* alpha — the positive half of the `/SMask` rule.
- **OS/2 v2 headers**, `BI_JPEG` and `BI_PNG` payloads.
- **Top-down rows** (negative height). GDI+ always writes bottom-up.
- **`BITMAPCOREHEADER`** — already anchored, by the second Wikipedia hex dump in
  `test/bmp.test.ts`, which is the only thing covering the 3-byte palette entry.
