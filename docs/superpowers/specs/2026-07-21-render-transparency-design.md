# Render fidelity: tiling patterns, soft masks, blend modes, transparency groups

Issue: `aspose-pdf-foss-for-ts-a6i`. Follows `57b` (annotation-appearance rendering), which is closed.

## Problem

`page.ToImage()` and `page.ToSvg()` approximate four transparency-related
constructs as mid-gray or a BBox fill:

| Construct | Current behavior |
|---|---|
| Tiling patterns (PatternType 1) | `resolveShadingPattern` (pagerender.ts) rejects `PatternType != 2`; the fill becomes `[128, 128, 128]` |
| Soft masks (ExtGState `/SMask`) | Unhandled |
| Blend modes (`/BM`) | Unhandled; `Canvas.blend` is hardcoded source-over |
| Transparency groups (`/Group`) | `drawForm` ignores `/Group`; forms draw inline |

Underneath all four sits a gap the issue does not mention: **the `gs` operator is
not implemented at all.** There is no `case 'gs'` in the interpreter's op switch,
so `/ExtGState` is never consulted and constant alpha (`ca`/`CA`) is silently
ignored along with `/BM` and `/SMask`. Nothing in the acceptance criteria can be
built without it.

Also currently approximated and in scope by adjacency: `SCN` stroke patterns.

## Scope

In scope: both backends — the rasterizer (`raster.ts`) and the SVG sink
(`svgrender.ts`).

Out of scope, documented as limitations rather than implemented:

- **Knockout groups** (`/K true`) — rare in real files; the compositing rules do
  not fold into the model below.
- **Backdrop removal for non-isolated groups** — see Stage 5.

## Approach

Two properties of the existing code determine the design.

**A soft mask is a clip mask.** `ClipMask` in raster.ts already stores fractional
per-pixel coverage, and every paint path (`rasterizeFill`, `rasterizeStroke`,
`rasterizeImage`, `rasterizeGlyphRun`, `rasterizeShading`) already multiplies
through it via `clip.at(x, y)`. A luminosity soft mask is the same array with a
different provenance; constant alpha is the same idea as a scalar. Three of the
five features therefore need no new compositing machinery.

**Tiling does not need N interpreter replays.** Rendering the cell once into a
small offscreen and blitting it across the clip bbox turns a 2pt cell over a
letter page from ~300,000 interpretations into one interpretation plus cheap
blits — and makes the budgeted fallback nearly free, since the cell's mean color
is already in hand.

Both collapse into one mechanism: **a redirectable output target with a
disposition on close.** Raster redirects into an offscreen `Canvas`; SVG
redirects emitted markup into a `<defs>` entry. Same lifecycle, native idiom per
backend.

## Architecture

Three files, in their existing roles. The interpreter stays the only place that
interprets PDF semantics; sinks stay the only place that know about buffers.
This is the boundary that already exists — `drawForm` recurses interpreter-side
while sinks see a flat op stream.

- **pagerender.ts** — `gs` handling, the extended `GState`, and the recursion
  that drives offscreen capture.
- **raster.ts** — offscreen as a nested `Canvas`; a blend mode on `Canvas.blend`;
  a soft-mask slot alongside the clip.
- **svgrender.ts** — offscreen as buffered markup landing in `<defs>` as
  `<mask>`, `<pattern>`, or `<g>`.

### Graphics state

`GState` gains four fields:

```ts
fillAlpha: number;        // ca,  default 1
strokeAlpha: number;      // CA,  default 1
blend: BlendMode;         // BM,  default 'Normal'
softMask?: SoftMaskRef;   // SMask dict + the CTM in force when gs ran
```

and `fillPattern` widens from `ShadingPattern` to
`ShadingPattern | TilingPattern`.

**Every ExtGState key is read through `dict.has(k)`, never through the resolved
value.** CLAUDE.md records this invariant (`doc.resolve(undefined)` returns
`null`, so `R(d.get(k)) !== undefined` is true for *every* absent key), and
ExtGState is precisely the shape that fires it: `/SMask` absent means "inherit"
while `/SMask /None` means "clear". Getting that backwards clears masks that
should persist.

### Sink interface

Alpha and blend are **sink state**, not per-call parameters, so the seven
existing methods keep their signatures and the existing `save()`/`restore()`
stack scopes them for free — mirroring PDF's own gstate model.

```ts
setAlpha(fill: number, stroke: number): void;
setBlend(mode: BlendMode): void;
beginOffscreen(): void;
endOffscreen(use: OffscreenUse): void;

type OffscreenUse =
  | { kind: 'softmask'; luminosity: boolean; backdrop?: Rgb }
  | { kind: 'tile'; bbox: number[]; xstep: number; ystep: number; matrix: Matrix }
  | { kind: 'group'; alpha: number; blend: BlendMode; isolated: boolean };
```

### Routing

| Feature | Interpreter | Raster sink |
|---|---|---|
| `ca`/`CA` | `setAlpha` on `gs` | scalar into coverage |
| Soft mask | `beginOffscreen` → draw `/G` → `endOffscreen({kind:'softmask'})` | luminance → coverage, held in a slot separate from the clip |
| Tiling | clip to path → `beginOffscreen` → interpret cell once → `endOffscreen({kind:'tile'})` | blit across the clip bbox |
| Blend | `setBlend` on `gs` | mode parameter in `Canvas.blend` |
| Group | `/Group /S /Transparency` in `drawForm`, offscreen only when it changes the result | composite buffer down |

**The soft mask occupies a slot separate from the clip.** Folding it into the
clip is tempting since both are coverage, but wrong: a soft mask is *replaced* by
the next `gs` and *cleared* by `/SMask /None`, whereas a clip only ever narrows.
Merged, `/None` could not undo the mask without also discarding the clip.
Paint-time coverage is three independent factors:

```
clip.at(x, y) × softMask.at(x, y) × alpha
```

**Groups take the offscreen path only when it changes the result.** A group at
alpha 1, Normal blend, no active mask composites identically inline. That
describes most `/Group` forms in real files, so the expensive path stays rare
rather than firing on every tagged or annotated PDF.

## Stages

Each stage lands green independently and is a shippable increment.

### Stage 1 — `gs` and constant alpha

Add `case 'gs'`: resolve the `/ExtGState` resource by name and apply `ca`, `CA`,
`BM`, `SMask`. `/BM` accepts both a name and an array of names (first recognized
wins) — Illustrator emits the array form. Raster multiplies alpha into coverage
at the five paint sites; SVG emits `fill-opacity` / `stroke-opacity`.

### Stage 2 — Soft masks

`/S /Luminosity` or `/S /Alpha`, with `/G` (group), `/BC` (backdrop), `/TR`
(transfer function). Luminosity renders `/G` offscreen and takes luminance; alpha
takes the offscreen's alpha channel, which the straight-alpha `Canvas` already
carries. `/TR` evaluates through the existing `pdffunction.ts` evaluator. `/BC`
initializes the offscreen to the backdrop color instead of transparent. SVG emits
`<mask>`, with `mask-type="alpha"` for the alpha flavor.

### Stage 3 — Tiling patterns

`/BBox`, `/XStep`, `/YStep`, `/Matrix`, `/Resources`, `/PaintType`. Colored
(PaintType 1) renders its own colors; uncolored (PaintType 2) draws in the
current fill color and ignores color operators in the cell. Degenerate steps
(≤ 0 or non-finite) fall back to the BBox extent, then to a single stamp. SVG
emits `<pattern patternUnits="userSpaceOnUse">`.

`SCN` stroke patterns land in this stage. The rasterizer already outlines strokes
in user space and fills the outline, so a stroke pattern is the same tile-blit
against the outline path — a few lines, not a new mechanism.

### Stage 4 — Blend modes

All twelve separable modes plus the four non-separable ones (Hue, Saturation,
Color, Luminosity), per ISO 32000 §11.3.5. The non-separable set needs full
backdrop RGB rather than per-channel math, but is ~40 lines and completes the
set. `Canvas.blend` takes a mode. SVG uses `mix-blend-mode`.

Between stages 4 and 5 blend modes inside an isolated group are subtly wrong:
they blend against the page rather than a transparent backdrop. This is strictly
better than ignoring `/BM`, but the README must not claim full blend-mode support
until stage 5 lands.

### Stage 5 — Transparency groups

Isolated groups are the *easy* case. An isolated group composites against a
transparent backdrop, which is exactly a fresh offscreen. A non-isolated group
sees the page backdrop, and correctness requires initializing the buffer with
that backdrop and subtracting it back out at composite time.

- **Isolated** (`/I true`) — real offscreen, composited with group alpha and
  blend. Correct.
- **Non-isolated** — drawn inline. Exactly correct at alpha 1 / Normal, a good
  approximation otherwise, and no backdrop-removal arithmetic.
- **Knockout** (`/K`) — not implemented; documented.

This satisfies "isolation approximated better than flat gray" without
backdrop-removal machinery.

## Budgets and degradation

Fixed constants in the renderer, not exposed on `ImageOptions`/`SvgOptions`.
Every overage degrades that one construct and leaves the rest of the page at full
fidelity; `renderPageToPng`'s "never throws — unsupported content degrades"
contract is unchanged.

| Cap | Value | Fallback on breach |
|---|---|---|
| Offscreen nest depth | 8 | draw inline, no isolation |
| Tile blits per fill | 65,536 | solid fill with the cell's mean color |
| Offscreen extent | current clip bbox, not the page | — |

The extent rule is an optimization as much as a guard: a small masked logo costs
a few KB instead of the ~30 MB a full-page `Float32Array` would take at scale 4,
which is what keeps nesting affordable.

## Testing

Fixtures are built programmatically in a new
`test/helpers/build-transparency-fixtures.ts`, mirroring the existing
`build-svg-fixtures.ts` style.

**Raster** — hand-computed exact pixel probes, the style already used in
`raster-shading.test.ts`. 0.5 red over white is `(255, 128, 128)`; a multiply of
known operands has one right answer. These are computed from the ISO formulas
independently of the implementation, satisfying CLAUDE.md's rule that an
assertion must come from outside the interpreter under test.

**SVG** — structural markup assertions only. Without a runtime dependency there
is no way to rasterize our own SVG output, so these verify that we emitted the
markup we intended; they do **not** verify that a browser paints it as Acrobat
would. The README states this limitation plainly rather than implying coverage.

**The load-bearing test.** Group alpha over two overlapping opaque shapes: drawn
inline the overlap double-darkens, composited through a real offscreen it does
not. That single probe is the only assertion in the suite that distinguishes
stage 5 working from stage 5 being a no-op.

Per CLAUDE.md, a fixture passing on first run is not evidence. Each stage's paint
path is deliberately broken to confirm the suite goes red before that stage
closes. Existing render tests stay green throughout.

No third-party real-world fixture is warranted. CLAUDE.md reserves those for
shared-convention bugs, where our reader and our builder could agree with each
other and both disagree with the format. Blend math is arithmetic verified
against the spec formula independently — not a convention we could collectively
misread.

## Documentation

README updates land with the stages that earn them: the *Rendering (page → PNG)*
bullet, the SVG preview-grade limitation bullet, and the annotation blend-mode
note. Knockout groups, non-isolated group approximation, and the untested-SVG
caveat are recorded as limitations.
