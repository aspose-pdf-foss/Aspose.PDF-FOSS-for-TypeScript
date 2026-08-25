# ToSvg: clips as leaf attributes, not wrapper groups

`aspose-pdf-foss-for-ts-7wg`. Split out of `aspose-pdf-foss-for-ts-bbu`, which
keeps the raster half (backdrop removal for non-isolated groups).

## The bug

`ToSvg` composites a non-isolated `/Group` as if it were isolated, so a blend
mode used *inside* the group never reaches the page backdrop. `ToImage` is
correct. Measured with `isolatedBlendGroupPdf` — cyan multiplying over a yellow
page, where isolated reads `(0,255,255)` and non-isolated reads `(0,255,0)`:

| `/I` | Correct | `ToImage` | `ToSvg` → resvg |
|---|---|---|---|
| `true` | isolated | isolated ✓ | isolated ✓ |
| `false` | non-isolated | non-isolated ✓ | **isolated ✗** |

`drawFormBody` (`pagerender.ts`) wraps every form XObject body in a clip for its
`/BBox`, which `SvgSink.addClip` emits as `<g clip-path="url(#id)">`. `clip-path`
establishes a CSS stacking context, and a stacking context isolates: the inner
`mix-blend-mode` composites against the wrapper's own transparent backdrop
instead of the page.

Two things make this worse than it first looks:

- The wrapper is emitted on the **inline (unbuffered) path too**, so the output
  is wrong even at group alpha 1 with a Normal group blend — precisely the case
  `bbu` describes as exact. The raster backend *is* exact there; only SVG is not.
- It is **incidental**, not chosen. Nothing in the emitter intends isolation
  here; it falls out of how the BBox clip happens to be expressed. The same
  accident is why `isolated-blend-group.png` was green while our
  `isolation="isolate"` markup was inert (`k01`) — the clip was silently
  supplying the isolation the attribute was failing to.

## What was measured first

Both engines (Chrome 150 via puppeteer 25.3.0, `@resvg/resvg-js` 2.6.2) agree on
every row. The fix is designed around these, so they are recorded here rather
than left as assumptions:

| Markup | Inside clip | Outside chained clip |
|---|---|---|
| leaf: `mix-blend-mode` only | blends with page | blends with page |
| leaf: `mix-blend-mode` + `clip-path` | **blends with page** | blends with page |
| leaf: `mix-blend-mode` + chained `clipPath` | **blends with page** | **clipped away** |
| `<g clip-path>` wrapper | **isolated** | isolated |

1. A leaf's own stacking context does **not** suppress that leaf's own blend.
   Isolation is a property of the *parent*, so moving a clip down onto the
   element it clips removes the isolation without removing the clipping.
2. `<clipPath clip-path="url(#other)">` **intersects**, which is what lets nested
   clips compose without a wrapper element.
3. The wrapper isolates — the bug, reproduced directly in both engines.

## Design

Clips stop being elements and become attributes.

**Clip stack.** `SvgSink` holds a stack of clip ids. `addClip` and `clipToStroke`
no longer emit `<g>` or touch `groupDepth`; they allocate `cN`, emit

```xml
<clipPath id="cN" clip-path="url(#cPrev)"><path d="…"/></clipPath>
```

into `<defs>` — omitting `clip-path` when the stack is empty — and push `cN`.
The chain expresses intersection, so the innermost id alone denotes the full
active clip.

**Leaf attribution.** Every painted leaf carries `clip-path="url(#current)"` when
the stack is non-empty: fills, strokes, text, images, shadings, and the viewport
rects that `fillViewportRect` emits for shading and tiling-pattern paint. This
belongs next to the existing `paintAttrs` so no paint site can forget it.

**Scope boundary.** Only clip wrappers change. `<g mask>` and the group
`<g opacity … style="isolation:isolate">` stay wrappers: those correspond to real
PDF constructs where a stacking context is exactly what we want. This is not a
general "remove the wrappers" refactor, and `groupDepth`/`save`/`restore` keep
their current job for those.

**`restore()`** pops the clip stack to the depth recorded by `save()`, in
addition to closing the mask/group wrappers it already closes.

**Captures must not inherit the outer clip.** This is the one place where moving
clips onto leaves changes behaviour rather than preserving it, and it has to be
handled explicitly. Today an outer `<g clip-path>` wrapper is emitted into the
body *before* `beginCapture`, so content captured for a `<pattern>` or `<mask>`
definition does not inherit it — the wrapper stays in the body and wraps the
element that *references* the def. With clips as leaf attributes, leaves emitted
during a capture would silently pick up `url(#current)` and bake the outer clip
into the definition, which for a tiling pattern means baking it into every cell.

So `beginOffscreen` saves and clears the clip stack, and `endOffscreen` restores
it. That mirrors what the raster backend already does — `beginOffscreen` there
resets to `new Paint()`, with the comment that contents render unclipped because
the outer clip applies when the buffer composites down, and that a tiling cell in
particular lives outside the region it fills. `tiling-pattern-offset-clip` is the
golden that fails if this is missed.

### Rejected alternative

Drop the BBox clip for non-isolated groups whose contents blend. Cheaper — a
flag through `drawForm` — but it trades a guaranteed wrongness for a rarer one:
content that overflows its `/BBox` would leak instead of being clipped. Chaining
is exact in both directions, so there is no reason to accept that trade.

## Testing

**The load-bearing check is that nothing moves.** All 14 goldens in
`test/fixtures/svg/` must regenerate **byte-identical**. The emitted markup
changes substantially and the rasterized pixels must not change at all; that is
a far stronger statement than any assertion about the markup itself.
`tiling-pattern-offset-clip` exercises clip/pattern interaction and
`stroke-pattern` exercises stroke-shaped clips, so both clip entry points are
covered by existing goldens.

**A new fixture proves the bug is fixed rather than moved.**
`non-isolated-blend-group` — `isolatedBlendGroupPdf(false)`, 200×200, probes
`(0,255,0)` inside the group and `(255,255,0)` on the page outside it.
Registered *before* the fix it must be skipped by the generator with the
`engines agree with each other but not with PDF semantics` signature — the same
signature that caught the tiling-pattern and stroke-clip bugs. That is the
evidence the fixture discriminates; a fixture that only ever passes proves
nothing (see `PROVENANCE.md`, Mutation checks).

**Hermetic tests** in `test/svgrender.test.ts`: clips emit no `<g>` wrapper;
nested clips chain via `clip-path` on the `clipPath`; a leaf under two clips
carries the innermost id; `restore()` pops to the right depth.

**Mutation checks** to run and record, since a green first run is not evidence:

| Mutation | Expected |
|---|---|
| Emit the clip wrapper again | `non-isolated-blend-group` skips (isolated result) |
| Drop `clip-path` from the chained `clipPath` def | `tiling-pattern-offset-clip` red — outer clip lost |
| Omit the leaf `clip-path` attribute | several goldens red — clipping gone entirely |
| Don't clear the clip stack in `beginOffscreen` | `tiling-pattern-offset-clip` red — outer clip baked into every cell |

## Out of scope

- **Raster backdrop removal** for non-isolated groups (`bbu`): the ISO 32000-1
  §11.4.6 removal formula, via rendering the group twice to obtain the group-only
  alpha α_gn. Independent of this change.
- **Knockout groups** (`/K true`), unimplemented in both backends.
- **Verifying `isolation:isolate` itself.** Still redundant in our output even
  after this change, because a group that is *isolated* keeps a wrapper. The gap
  recorded in `PROVENANCE.md` — it needs a group with no BBox clip — is unchanged
  by this work.
