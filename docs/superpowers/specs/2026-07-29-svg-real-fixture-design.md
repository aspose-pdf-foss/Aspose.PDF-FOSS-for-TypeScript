# Real-world SVG input fixtures — design

Issue: `aspose-pdf-foss-for-ts-1gg0.13` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-29. Deferred from `1gg0.3`; its value rose as
`1gg0.7`, `1gg0.8`, `1gg0.11` and `1gg0.19` each added parser surface with no
third-party bytes behind any of it.

## The gap

`test/svg-*.test.ts` builds every input programmatically. That suite cannot see
the one class CLAUDE.md's third-party fixture rule exists for: a
**shared-convention bug**, where `src/svgpath.ts` and the test builders agree
with each other and both disagree with the format.

SVG path data is the canonical case. A `d` attribute written by a design tool
uses lexical forms a hand-written test rarely does:

- implicit repeated commands — `M0 0 10 10 20 20` continues as `L`
- shorthand — `H`, `V`, `S`, `T` and their relative forms
- omitted separators — `M.5.5` is two numbers, `1e-3-4` is two more
- exponent notation for values a tool computed rather than typed

`1gg0.11` made the gap concrete: CSS had **no** independent reader in this
repository, so its cascade could only be mutation-proved. A real fixture is the
outstanding answer.

## Scope

Three fixtures under `test/fixtures/svg-input/`, from three producers, because
no single producer covers the risk:

| Fixture | Producer | Exists for |
|---|---|---|
| `showcase.svg` + `showcase.min.svg` | SVGO 4.0.2 | the lexical forms above — SVGO's whole purpose is emitting them |
| `icon.svg` | bootstrap-icons, pinned (MIT) | genuine design-tool authoring: compact multi-subpath `d`, arcs, `fill-rule` |
| `chart.svg` | d3-shape, pinned | machine-generated arc and area data — long decimals, many segments |

Mirrors `test/fixtures/fonts/PROVENANCE.md`, which committed three fixtures from
two encoders for the same reason.

### Directory naming

**`test/fixtures/svg-input/`, not `test/fixtures/svg/`.** The latter is already
the PDF→**SVG output** goldens from the transparency work: browser-rendered
rasterizations of `Page.ToSvg()`. These are SVG→**PDF input**. Same format,
opposite direction, and one directory holding both would be a trap. Each
PROVENANCE.md cross-references the other.

### Text appears only in the SVGO pair

resvg resolves fonts from the system; `AddSVGObject` substitutes Standard-14
silently by design (`1gg0.8`). Text in a resvg-compared fixture would therefore
produce a guaranteed glyph mismatch that only a widened tolerance could hide —
and a tolerance wide enough to hide it is wide enough to hide a real error.

In the paired check both sides are our own renderer, so text costs nothing
there.

## What each fixture proves

### `showcase.svg` ↔ `showcase.min.svg` — a paired input

Render both through `AddSVGObject` → `ToImage`; require they match.

The external ground truth is **SVGO's claim that the two files are equivalent**.
We author one side and SVGO produces the other; we supply neither half of the
equivalence. A mishandled `v`/`H` shorthand, a missed implicit repeat or a
mis-lexed `.5.5` shows up as a geometric mismatch.

This is the strongest check available, because **no renderer tolerance is in
play**: both sides share our rasterizer, so antialiasing is identical and a
mismatch cannot be explained away.

`showcase.svg` is a regression board for the whole epic — every path command
including arcs and quadratics, all shape elements, transform lists, `clipPath`,
`use`, both gradient types, a `<pattern>`, `<text>`/`<tspan>`, and a `<style>`
block. It is the first fixture to cover `1gg0.3`, `.7`, `.8`, `.11` and `.19`
together.

**Caveat, recorded rather than papered over.** SVGO's default preset rewrites
aggressively: shapes become paths, CSS inlines into attributes, unused defs
vanish. PROVENANCE.md therefore records what SVGO **actually did**, and the
coverage claim describes `showcase.min.svg` as it exists. If SVGO inlines the
`<style>` away, the pair stops exercising the CSS engine and the document says
so rather than implying coverage it does not have.

### `icon.svg` and `chart.svg` — resvg goldens

No paired input exists, so ground truth comes from an independent SVG
implementation: `@resvg/resvg-js`, already used by `scripts/gen-svg-goldens.ts`.

Committed PNGs, compared with the existing two-tier method from
`test/svg-golden.test.ts`:

- `samplesMatch` on probe points chosen inside flat interiors — **tight**,
  because antialiasing cannot explain a miss there;
- `diffImages` across the whole page — **loose**, sized for edge antialiasing
  and not for a wrong shape.

Both helpers already exist in `test/helpers/compare-image.ts`. Nothing new is
invented for comparison.

## Generation

`scripts/gen-svg-input-fixtures.mjs`, following `gen-svg-goldens.ts`:

- packages installed with `--no-save`, so `package.json` and the dependency tree
  are unchanged and a later `npm install` prunes them;
- the script is **not** run by `npm test` — the suite stays hermetic and offline,
  needing only the committed bytes;
- the exact commands are recorded in PROVENANCE.md so the bytes are
  reproducible.

## Provenance

Per CLAUDE.md, for each fixture: producer and version, the exact command,
SHA-256 of input **and** output, and what it does **not** cover.

Plus, for `icon.svg`, the bootstrap-icons MIT notice and copyright line — it is
third-party licensed content being vendored, and the licence travels with it.

## The failure protocol

Decided now, so it is not decided under pressure later.

**The SVGO pair mismatches.** That is a parser bug, found exactly as intended.
Fix `svgpath.ts`. Do **not** add tolerance: both sides share our rasterizer, so
there is no antialiasing excuse available, and a mismatch is a real geometric
difference.

**resvg disagrees.** Investigate and attribute the cause. If it is ours, fix it.
If it is a genuine engine difference, **the golden is not committed** — the
divergence is recorded in PROVENANCE.md with its cause, following the rule the
existing goldens already set: *"skipping here keeps the suite honest about what
is verified."* A tolerance is never widened until a comparison passes.

`test/svg-input-fixtures.test.ts` guards each golden with the same `existsSync`
check the current golden suite uses, so an uncommitted golden skips visibly
rather than passing silently.

## This task can legitimately find nothing

Worth stating, because it changes how the result should be read.

If all three fixtures round-trip cleanly on the first run, the fixtures have
proved the parser correct against bytes it did not produce — which is the
deliverable, even though nothing was fixed. That is a **pass**, not a wasted
task.

If one of them does find a bug, the fix may be larger than this task. A
discovered bug is filed as its own issue rather than silently expanding this
one; this issue delivers the fixture and the failing test that proves the bug.

## Documentation

`CLAUDE.md`: extend the third-party fixture table (`fixtures/fonts/`,
`fixtures/jpeg/`, `fixtures/xfdf/`, `fixtures/unicode/`) with
`fixtures/svg-input/` and what it covers. That table is the inventory an agent
reads to know which fixtures exist and why, so leaving it stale would defeat the
point of adding one.

No public API changes, so `README.md` needs nothing.

## Follow-ups

None proposed. Any parser bug the fixtures expose is filed when found.
