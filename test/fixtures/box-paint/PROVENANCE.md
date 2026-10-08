# Box Painting Goldens — Provenance

Headless-Chrome renderings of the TEXT-FREE boxes in
`test/helpers/box-paint-fixtures.ts`: rounded corners (`border-radius`),
rounded borders of differing widths and colours, `background-image` with
`url()` tiles (size, repeat, position) and `linear-gradient()` /
`radial-gradient()`. They are the oracle for v9j3.4's box painting
(`boxpaint.ts`, `boxdraw.ts`, `cssframe.ts`), which no hand-built fixture can
check: our renderer works from the CSS we lower into PDF paths, clips,
shadings and image XObjects, and Chrome works from the CSS directly, so the
two are independent and agreement is evidence.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-box-paint-goldens.ts` (not run by `npm test`) |
| Committed bytes from | headless Chrome/152.0.7977.54, via puppeteer 25.9.0 |
| Runner | tsx 4.23.13 |
| Node | v24.16.0 |
| OS | Windows 11 Pro, 10.0.26300 |
| Date | 2026-10-08 |

```bash
npm i --no-save tsx puppeteer
npx tsx scripts/gen-box-paint-goldens.ts
```

Chrome runs with `--force-color-profile=srgb --disable-lcd-text
--disable-font-subpixel-positioning`, at `deviceScaleFactor: 1`, so one CSS px
is one device pixel. Re-running the generator on 2026-10-08 reproduced every
file byte for byte.

## The comparison

`test/box-paint-oracle.test.ts` lays each fixture out through `doc.AddHtml`
on a page of exactly `width x height` CSS px (`x 0.75` points) with zero page
margins, renders it at `scale: 96/72` so the grids coincide, and compares with
`test/helpers/compare-image.ts`'s `diffImages`. The bound is on the FRACTION of
pixels whose worst channel differs by more than `DIFF_PIXEL_TOL` (12), and it
is 1%. Antialiasing differs along every curve, so the bound is not zero.

The bodies are padded rather than margined: a root's escaped top margin is
dropped by `cssflow.ts` by design, where Chrome keeps it.

Measured on 2026-10-08 (fraction over tolerance, worst channel delta):

| Fixture | Fail fraction | Max delta |
|---|---|---|
| radius-uniform | 0.06% | 14 |
| radius-per-corner | 0.11% | 28 |
| radius-elliptical-slash | 0.09% | 21 |
| radius-50pct-nonsquare | 0.03% | 14 |
| radius-overlap-pill | 0.03% | 15 |
| border-widths-rounded | 0.21% | 46 |
| border-colors-rounded | 0.05% | 53 |
| image-no-repeat | 0.00% | 0 |
| image-repeat-x | 0.00% | 0 |
| image-cover | 0.00% | 1 |
| image-contain-center | 0.00% | 1 |
| image-position-right-bottom | 0.00% | 0 |
| linear-to-right | 0.00% | 1 |
| linear-to-top-right-nonsquare | 0.00% | 2 |
| linear-angle-stops-outside | 0.00% | 1 |
| radial-ellipse-default | 0.00% | 2 |
| radial-circle-closest-side-at | 0.00% | 1 |
| gradient-transparent-stop | 0.00% | 1 |

The oracle found one defect on its first measurement.
`border-colors-rounded` measured 0.89% — under the bound, but with a 255
delta — and the residue was a wedge at each INNER corner, inside the border
ring, that we left unpainted. Rounded, the ring at a corner reaches inside the
inner rectangle, and the colour joins (`boxpaint.ts`'s `edgeWedges`) stopped
at the inner rectangle corner, so that part of the ring lay in no edge's
wedge. The joins now run on along their diagonals past the inner arc, and the
fixture measures 0.05% (after the final review made the joins meet the inner arc exactly). A single-colour border never uses the wedges, which is
why `border-widths-rounded` could not see it. The pixel case beside the oracle
in `test/box-paint-oracle.test.ts` holds it — a 1% bound alone would have
accepted the defect.

## Load-bearing, measured

- Making `premultiplyTransparent` the identity reddens exactly
  `gradient-transparent-stop` (the ramp darkens toward transparent's black).
- Making `hasRadius` always false reddens all seven `radius-*` and
  `border-*-rounded` fixtures and nothing else.

## What this does NOT cover

- One engine, one version, with no second renderer to arbitrate.
- No text: font substitution would dominate the difference, so every fixture
  is decoration only.
- A box split across a column or page, a box inside a float, and
  `background-attachment`, `background-clip` and `background-origin` (not
  implemented) are outside the corpus. Splitting is held by
  `test/cssframe-slices.test.ts` and `test/html-background.test.ts` alone.
- Partially transparent gradient stops: a PDF function interpolates colour and
  alpha separately, which equals CSS's premultiplied interpolation only at a
  fully transparent stop. `gradient-transparent-stop` uses `transparent`.

## Files

SHA-256 of each committed PNG:

```
A573D22B8FF48C08137DF9F2F38A9D6DB6246BC188A71D33645EF207E50BE142  border-colors-rounded.png
934807A94BB47F4E2614FB2DEEAF5E4D2C36009B3A77A94A3607245C87DFA126  border-widths-rounded.png
9287CB1DBD4825398549D9A1F7F2680F429600E7214F951527F1A34294E2A98B  gradient-transparent-stop.png
8FA3EE720D9222F03622BC5FC11CB4DD2C9B14C311ADE084DEBAE44DD1510371  image-contain-center.png
D026F2441B39529C091045544FBECE03EA7AEA1A7350C0A09FF72AFF4CE2117E  image-cover.png
1E02409CCDAAE20298F5E9218FD3F1CDFE2BEC9C7A013DFF0C8BF3C3A40345BE  image-no-repeat.png
407EA054DD735E02D70BD86CBDD151D71625E0E8AF02335BA85D8BC607AFA482  image-position-right-bottom.png
7A1B9D32EF05796878C4E5786E281923B718453E784B509CA9F77652590FA5AF  image-repeat-x.png
E741B7284C64579CF747F8073848F5EE860F64227B391F35FE0632E458C4CF00  linear-angle-stops-outside.png
6F5B445E3E5D47F9FBBD3E292A992FD177F35EB1738C240220DBFE5436E67799  linear-to-right.png
BD725854D04C5AFE33BCEEE327819073EF7AD9D2ADF8AC57A073FF858BD9EE16  linear-to-top-right-nonsquare.png
55782F22AB046B0FEFAA27C55B67A576526845EE07557738E4A10874D20973BD  radial-circle-closest-side-at.png
D93083DBF53520A6515CA6862847BE914DB5014F6EC1BA5B9D5705CBB54C003F  radial-ellipse-default.png
275DB9A73A06D1F55FAFA8AF69B101B0AD5E493D03F488449E988BE314456392  radius-50pct-nonsquare.png
CD53FEAFF6A6B45E9DA0B928D9210C5333622DCB19CF21525B51FD051094D87F  radius-elliptical-slash.png
73FABB306069F5E8436F88D3DA6A7C43193165276881AAE704D9A717DA1CE817  radius-overlap-pill.png
D35137ADA61A73EAEEAC85884C7AB47AC7A738A561EE940C96DC06CA8C329EA0  radius-per-corner.png
DFC4FFA9FAA08196C524CAB25F013AC5AD72B2F05001DC209198311ED8917F51  radius-uniform.png
```
