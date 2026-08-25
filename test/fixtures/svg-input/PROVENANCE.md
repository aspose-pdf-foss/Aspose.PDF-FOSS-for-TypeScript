# SVG Input Fixtures — Provenance

## What these are, and what they are not

Third-party **SVG going in**: files fed to `page.AddSVGObject`, i.e. the
SVG→PDF direction.

They are **not** `test/fixtures/svg/`, which holds browser-rendered goldens for
`Page.ToSvg()` output — the PDF→SVG direction. Same format, opposite direction,
different bug class. Read the directory name before adding to either.

## Why they exist

`test/svg-*.test.ts` builds every input programmatically, so `src/svgpath.ts`
and the builders in `test/helpers/` can agree with each other while both
disagree with the SVG grammar: shorthand commands (`h`/`v`/`s`/`t`), implicit
command repeats, omitted separators (`.5.5`, `0 1-40`), comma-separated arc
flags, and transform functions written with no separator between them. Our
builders write none of those, so no in-tree test can see a bug in them. These
fixtures are bytes we did not produce.

## Fixtures

| File | Producer | Version | Exists for |
|---|---|---|---|
| `showcase.svg` | this repository (hand-authored) | — | The readable half of the pair: every feature the 1gg0 epic shipped, one command per idea, explicit separators, no shorthand. |
| `showcase.min.svg` | svgo | 4.0.2 | The compact half. Same drawing, spelled the way real-world SVG is spelled. |
| `icon.svg` | bootstrap-icons (`arrow-through-heart-fill.svg`) | 1.13.1 | Genuine design-tool output, vendored verbatim: `fill-rule="evenodd"`, `zM` subpath continuation, arcs in both cases, `.5.5` omitted separators. |
| `icon.png` | @resvg/resvg-js | 2.6.2 | Independent-engine golden for `icon.svg`. |
| `chart.svg` | d3-shape | 3.2.0 | Machine-generated donut + Catmull–Rom line: long decimals, computed arc flags, `C` runs, and every argument comma-separated (`A70,70,0,0,1`). |
| `chart.png` | @resvg/resvg-js | 2.6.2 | Independent-engine golden for `chart.svg`. |

`showcase.min.svg` is checked against `showcase.svg` rather than against a
golden. That comparison is the strongest one in the SVG stack: the ground truth
is SVGO's claim that the two files are equivalent, and because **both sides
render through our own rasterizer** the antialiasing is bit-identical, so no
tolerance is in play. A mismatch there is a real geometric difference and
therefore a parser bug. **Never widen that budget** (`MAX_FAIL_FRACTION`,
0.5%) — fix the parser or file the bug.

`icon.svg` is copied byte-for-byte from the package, `class` attribute and all.
Do not reformat it; the compact spelling is the entire point of having it.

## Regenerating

```bash
npm i --no-save svgo bootstrap-icons d3-shape @resvg/resvg-js
node scripts/gen-svg-input-fixtures.mjs
```

The packages are installed **without** being recorded in `package.json`, so the
library's dependency tree is unchanged and a later `npm install` / `npm ci`
prunes them; re-run the first line to restore. Install them in **one** command:
`npm i --no-save` reconciles the tree against `package.json` each time, so a
second `--no-save` install removes what the first one added.

`npm test` never runs the generator. The suite reads only the committed bytes
and stays hermetic and offline.

The generator runs SVGO's plain `preset-default`. svgo 4 dropped `removeViewBox`
from that preset (configuring it there is now an error), and `showcase.svg`
declares `viewBox` with **no** `width`/`height`, so the plugin could not strip
the viewBox even if it were re-added. That matters: losing the viewBox would
reframe the optimized copy, and the pair would compare two framings instead of
two spellings.

## Bytes

| File | Size | SHA-256 |
|---|---|---|
| `showcase.svg` | 1870 | `c499abb8a3dfaab028954bf1a860312120763f56cd55817518a0f06c453bdc7e` |
| `showcase.min.svg` | 1310 | `b9e97b3255af6d1d9f9efbc713cc8c4cd17c6363e8d1504021c792e96c41dcee` |
| `icon.svg` | 742 | `98f7f307b8adf2208b76272eafa4ba45dc3f29c70665ced8667023a4d4e8d69b` |
| `icon.png` | 3614 | `38895f918d4f2880c65b8f1870c51f9369e5246c744e42e32f1ce085bb211c0a` |
| `chart.svg` | 956 | `34862b5d443f9177c464d6ad8468608f5e68f817a99fbd6b6845682c4fd6c1b3` |
| `chart.png` | 6300 | `6b15aa644ebfd65605f46533d4c69381dbb9a03f3ace88ba31750b83eaf45de1` |

## Environment

| | |
|---|---|
| Node | v24.16.0 |
| OS | Windows 11 Pro, 10.0.26200 |
| Date | 2026-07-30 |
| svgo | 4.0.2 |
| bootstrap-icons | 1.13.1 |
| d3-shape | 3.2.0 |
| @resvg/resvg-js | 2.6.2 |

## Observed results

| Check | Budget | Observed |
|---|---|---|
| `showcase.min.svg` vs `showcase.svg` | 0.5% failing pixels | **0 failing pixels**, maxDelta 1 (rounding) |
| `icon.svg` vs `icon.png` | 5% failing pixels | 0.41%, maxDelta 38 |
| `chart.svg` vs `chart.png` | 6% failing pixels | 0.76%, maxDelta 118 |

The two cross-engine `maxDelta` figures are edge placement, not shape error. On
the chart the failing pixels trace every colour boundary as a thin outline whose
longest horizontal run is 4 pixels, with no contiguous filled region anywhere —
which is what a half-pixel disagreement on a curve looks like, and what the
whole-page budget exists to absorb. The probes are what verify the shapes.

The SVGO pair was checked for load-bearingness by mutation rather than by
watching it go green: making `H` ignore the relative offset drives it to 8.8%,
and requiring a separator between transform functions — the optimized copy
writes `rotate(15 -566.65 538.245)scale(1.5)` — drives it to 0.86%, both against
the 0.5% budget.

## Coverage

Lexical forms SVGO **actually** produced in `showcase.min.svg`, all absent from
the readable source:

- horizontal/vertical shorthand: `M10 110h80v40H10z`;
- smooth-curve shorthand: `c10-10 30-10 40 0s30 20 40 0`, `q20-15 40 0t0 30`;
- **implicit command repeat** — one `a` letter for two arcs:
  `a20 20 0 0 1 40 0 20 20 0 0 1-40 0`;
- omitted separators, negative sign acting as the separator: `1-40`, `20-15`,
  `10-10`;
- leading-dot decimals: `opacity=".4"`;
- transform functions with **no separator between them**, and `rotate` rewritten
  into its three-argument centre form: `rotate(15 -566.65 538.245)scale(1.5)`;
- shortened colours, including a named one: `red`, `#fff`, `#00f`, `#080`, `#f80`.

From `icon.svg` (bootstrap-icons): `fill-rule="evenodd"`, `zM`/`zm` subpath
continuation, absolute and relative arcs in one `d`, `.5.5` run-together
decimals, `fill="currentColor"` on the root. From `chart.svg` (d3-shape):
comma-separated arguments including arc flags, 3-decimal coordinates, and `C`
runs from a Catmull–Rom curve.

The probes chosen for the two goldens are deliberately load-bearing rather than
merely inside a filled area:

- `icon.png` (62,120) sits inside the arrow shaft, which is a hole **only**
  under `fill-rule="evenodd"` — drop the rule and that probe turns black;
- `chart.png` (100,80) sits in the donut hole, which exists only because d3
  walks the inner arc back the other way — mis-decode the sweep flag and the
  hole fills.

### What SVGO removed, and what that costs

SVGO **inlined the `<style>` block away**, rewriting `class="accent"` and the
`g .viaDescendant` descendant rule into `style="fill:#24c"` and
`style="stroke:#c22;stroke-width:2"` presentation attributes. So the pair does
**not** exercise the CSS engine on the optimized side — it exercises the `style`
attribute instead. The selector engine is covered by `showcase.svg` (which the
suite renders and requires to skip nothing) and by `test/svg-css.test.ts`.

SVGO also collapsed `<g id="reused"><circle/></g>` to a bare `<circle id="e">`
and hoisted the `<use>` out of its wrapping `<g>`, folding the group's
`translate`+`rotate`+`scale` into the single fused transform above. The `<use>`
indirection survives; the group nesting around it does not.

## What these do NOT cover

Every fixture here is small, square and static. None of them exercise:

- `<image>`, filters, masks, or `textPath`;
- SMIL or CSS animation;
- non-Latin text, or any text at all in the two golden fixtures (deliberately:
  cross-engine text comparison would measure font substitution, not our parser);
- `patternUnits="objectBoundingBox"`, `spreadMethod`, or gradient transforms;
- viewport units, `em`/`ex`/`%` lengths, or a non-`meet` `preserveAspectRatio`
  from the file itself (the tests force `fit: 'fill'`);
- stroke joins, caps, dashing, or `stroke-linejoin` beyond the defaults;
- documents large enough to stress performance.

## Licence — bootstrap-icons

`icon.svg` is `icons/arrow-through-heart-fill.svg` from bootstrap-icons 1.13.1,
vendored unmodified under:

> The MIT License (MIT)
>
> Copyright (c) 2019-2024 The Bootstrap Authors

The full text is in the package's `LICENSE` file. `showcase.svg` and
`chart.svg` are generated by this repository and carry the repository's licence;
`chart.svg`'s path data is computed by d3-shape (ISC), which is a tool, not
vendored content.

## Divergences

None. All three checks passed on first run, so a golden is committed for both
cross-engine fixtures.

The rule this section exists to record, kept from `test/fixtures/svg/`: a golden
is committed **only** where resvg and we agree. A genuine engine difference is
written up here with its cause instead, and the `has a committed golden` test in
`test/svg-input-fixtures.test.ts` fails loudly if a golden simply goes missing,
so an absent golden can never read as a silent pass.
