# SVG Filter Goldens — Provenance

Browser-rendered rasterizations of five filter fixtures, for `AddSVGObject`'s
`<filter>` support (issue `1gg0.10.4`).

They exist because `feTurbulence` and the lighting primitives are **ports of
published reference implementations**. Asserting a port against values derived
from the same reference proves nothing — the transcription error cancels out —
so the expectations have to come from engines that share no code with ours.

Distinct from `fixtures/svg/`, which holds PDF→SVG **output** goldens; these are
SVG→PDF **input** rendered through `AddSVGObject` → `ToImage`.

## Producer

| | |
|---|---|
| Generator | `scripts/gen-filter-goldens.ts` (not run by `npm test`) |
| Committed bytes from | headless Chrome 151.0.7922.47, via puppeteer 25.4.0 |
| Cross-checked against | `@resvg/resvg-js` 2.6.2 — **turbulence fixtures only** |
| Runner | tsx 4.23.1 |
| Node | v24.16.0 |
| OS | Windows 11 Pro, 10.0.26200 |
| Date | 2026-07-31 |

Chrome is pinned to sRGB with LCD text and subpixel positioning disabled
(`--force-color-profile=srgb --disable-lcd-text
--disable-font-subpixel-positioning`), matching `gen-svg-goldens.ts`.

The packages are installed **without** being recorded in `package.json`, so the
library's dependency tree is unchanged. A later `npm install` / `npm ci` prunes
them; re-run the first line to restore. All three must be installed in **one**
command — `npm i --no-save` prunes any other un-saved package:

```bash
npm i --no-save tsx puppeteer @resvg/resvg-js
npx tsx scripts/gen-filter-goldens.ts
```

Each `.png` has its `.svg` source committed beside it, so a regeneration is
reproducible and the test renders exactly the markup the browser did.

## What these cover

| File | Size | Cross-checked | Chrome vs resvg | SHA-256 |
|---|---|---|---|---|
| `turbulence-fractal.png` | 64×64 | yes | maxDelta 6 | `672a12c5a4e80df0d13ac1bea472166ab3b9a01817e3722e9aa2a3d638fc484e` |
| `turbulence-turb.png` | 64×64 | yes | maxDelta 9 | `c5b789f7ca8b4b5ee52e68f79511c161268a5e62a05404bf90982cb556923caa` |
| `diffuse-distant.png` | 64×64 | **no** | n/a (resvg panics) | `3f0e838bd58544606cbcb8bc0422fd5233781491fd1b536e6b4a57b5e0de7d62` |
| `diffuse-point.png` | 64×64 | **no** | n/a (resvg panics) | `530530c336897ec07212f4f45c26312a82fdb92a155550aee045cfa132992672` |
| `specular-spot.png` | 64×64 | **no** | n/a (resvg panics) | `4f852cfe622067e2872424c8add5d3977db6b7d6ad84a6329f288f6d7da566fa` |

| Fixture | Exercises |
|---|---|
| `turbulence-fractal` | `type="fractalNoise"`, 2 octaves — the signed accumulation and the [-1,1] → [0,1] remap, the lattice shuffle, the gradient table |
| `turbulence-turb` | `type="turbulence"`, 2 octaves — the absolute-value accumulation |
| `diffuse-distant` | `feDiffuseLighting` + `feDistantLight`, N·L over a rounded-rect alpha edge |
| `diffuse-point` | `fePointLight`'s per-pixel light vector, and a coloured `lighting-color` |
| `specular-spot` | `feSpecularLighting` + `feSpotLight` — cone falloff, and alpha = max(r,g,b) |

## Limitations — measured, not assumed

Both were measured on 2026-07-31 against the versions above. Do not "fix" a
fixture by relaxing these; re-measure instead.

### 1. The turbulence fixtures are deliberately LOW frequency

Chrome and resvg diverge sharply on high-frequency noise. Mean absolute channel
difference over a 64×64 `fractalNoise` field:

| `baseFrequency` | 0.5 | 0.15 | 0.05 | 0.02 |
|---|---|---|---|---|
| mean difference /255 | 30.9 | 12.0 | 3.8 | 1.7 |

Both engines implement the same function; they sample it at different sub-pixel
offsets, and high-frequency noise magnifies that difference without bound. Note
that **octaves multiply the effective frequency** — the first attempt at
`baseFrequency="0.04" numOctaves="3"` put the top octave at 0.16 and tripped the
generator's cross-engine gate at `failFraction` 0.029.

`type="turbulence"` is more sensitive than `fractalNoise` at equal frequency,
because `|noise|` creases sharply at every zero crossing; it needed 0.012 where
`fractalNoise` was fine at 0.02.

**What these fixtures therefore prove:** the lattice, the gradient table, the
shuffle, the s-curve interpolation and both accumulation rules — everything a
wrong port gets wrong, all of which change the large-scale structure. Mutating
`RAND_a`, swapping the two accumulation rules, or removing the s-curve each
turns them red.

**What they do not prove:** sub-pixel sampling agreement with any particular
engine. Our render currently sits at mean 0.65 (fractal) and 0.70 (turbulence)
against these goldens, i.e. essentially exact.

### 2. The lighting fixtures have no second engine

resvg panics inside `resvg/src/filter/lighting.rs:141`
(`assertion failed: src.width == dest.width && src.height == dest.height`) on
every lighting input tried, and the panic **aborts the process** rather than
raising, so it cannot be caught and the generator must not construct a `Resvg`
for those fixtures at all.

Their goldens come from Chrome alone. That is a real reduction in independence
and is recorded here rather than papered over: a Chrome bug in these primitives
would be baked into our expectations.

### 3. Fixture constants are chosen to stay discriminating

An earlier `feSpecularLighting` attempt at `specularExponent="20"` with a white
light produced only **two distinct output levels** across the whole surface — a
golden that would pass against almost any implementation. The committed fixture
uses `specularConstant="0.8" specularExponent="4"` to keep a visible gradient.

The lit shapes are rounded rectangles running to the **filter-region edge**, not
circles floating inside it: the nine surface-normal kernels differ only on the
one-pixel border, so a shape clear of the edge would pass with the interior
kernel used everywhere.
