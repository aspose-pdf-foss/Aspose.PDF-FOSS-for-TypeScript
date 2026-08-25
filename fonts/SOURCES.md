# Bundled Standard-14 substitute fonts

These font files are the source input to `scripts/gen-std14-fonts.mjs`, which
deflate-compresses and base64-embeds them into the generated `src/std14data.ts`
(the module that actually ships in `dist/`). The raw files here are **excluded
from the npm package** via `package.json` `files`; they live in the repo only so
the embedded data is fully regenerable.

All 14 files are TrueType (`glyf` outlines), so the runtime loader parses them
uniformly via `parseSfnt`.

## Latin faces — Liberation 2.1.5 (SIL OFL 1.1)

Metric-compatible substitutes for the Helvetica / Times / Courier families.

- Source: https://github.com/liberationfonts/liberation-fonts release 2.1.5
- Tarball: https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz
- License: `LICENSE-OFL.txt`

| File                              | Standard-14 face      |
| --------------------------------- | --------------------- |
| LiberationSans-Regular.ttf        | Helvetica             |
| LiberationSans-Bold.ttf           | Helvetica-Bold        |
| LiberationSans-Italic.ttf         | Helvetica-Oblique     |
| LiberationSans-BoldItalic.ttf     | Helvetica-BoldOblique |
| LiberationSerif-Regular.ttf       | Times-Roman           |
| LiberationSerif-Bold.ttf          | Times-Bold            |
| LiberationSerif-Italic.ttf        | Times-Italic          |
| LiberationSerif-BoldItalic.ttf    | Times-BoldItalic      |
| LiberationMono-Regular.ttf        | Courier               |
| LiberationMono-Bold.ttf           | Courier-Bold          |
| LiberationMono-Italic.ttf         | Courier-Oblique       |
| LiberationMono-BoldItalic.ttf     | Courier-BoldOblique   |

## Symbol / Dingbats — URW base35 (AGPLv3 + font exception)

Canonical Ghostscript substitutes for Symbol and ZapfDingbats.

- Source: https://github.com/ArtifexSoftware/urw-base35-fonts (`fonts/`, branch `master`)
- License: `LICENSE-URW-AGPL.txt`

| File                    | Standard-14 face |
| ----------------------- | ---------------- |
| StandardSymbolsPS.ttf   | Symbol           |
| D050000L.ttf            | ZapfDingbats     |

## Integrity

SHA-256 checksums of the fetched files are recorded in `SHA256SUMS.txt`.

## Regenerating the embedded data

```bash
node scripts/gen-std14-fonts.mjs   # reads fonts/*.ttf -> writes src/std14data.ts
```
