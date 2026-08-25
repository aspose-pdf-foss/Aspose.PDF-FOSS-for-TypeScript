# Booklet (saddle-stitch) imposition (`doc.Booklet`) — design

Issue: `aspose-pdf-foss-for-ts-1gg0.2` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-28.

Parity target: saddle-stitch booklet imposition in
[Aspose-PDF-FOSS-for-Go](https://github.com/aspose-pdf-foss/Aspose-PDF-FOSS-for-Go/blob/main/_examples/feature_showcase/main.go).

## Scope

Impose a document's pages as a saddle-stitch booklet into a **new** Document:
pages padded to a multiple of 4, reordered so that folding the printed stack down
the middle yields a correctly-sequenced booklet, two source pages per printed
side, with optional creep compensation.

No new rendering primitives. Each source page is imported once as a shared Form
XObject and placed through `placeFitted` (compose.ts) — the same call `NUp` uses.
This is an imposition layer over existing composition machinery.

Out of scope, deliberately:

- **Multiple signatures.** One signature only: every sheet nests in a single
  fold. `sheetsPerSignature` is filed as a follow-up issue.
- **Trim/bleed marks, fold marks, colour bars.** Bindery furniture, not
  imposition.
- **Mixed page sizes as a first-class feature.** Cell size derives from the first
  page's CropBox and `placeFitted` scales each source to fit its cell, so mixed
  sizes degrade gracefully rather than being rejected — but no per-page sizing
  control is offered.
- **Duplex/flip metadata.** The output is a plain page sequence in print order;
  how it reaches a printer is the caller's concern.

## Modules

Mirrors the `toc.ts` / `tocrender.ts` and `tableauthor.ts` / `tablerender.ts`
split: a pure model module plus assembly in the facade.

- **`src/booklet.ts`** (new) — the pure model. Imports no `Document` and touches
  no PDF objects: padding, the sheet ordering permutation, and cell geometry
  including creep. This is where the arithmetic that can be silently wrong lives,
  so it is unit-testable without building a PDF.
- **`src/document.ts`** — `Document.Booklet`, beside `NUp`: option validation,
  metrics from the first page, sheet assembly via `placeFitted`.
- **`src/index.ts`** — exports `BookletOptions`.

## API

```ts
/** Options for {@link Document.Booklet}. */
export interface BookletOptions {
  /** Binding edge. 'right' mirrors every side for an RTL book. Default 'left'. */
  binding?: 'left' | 'right';
  /** Output sheet size [w, h]; default = [2*W + 2*margin + gutter, H + 2*margin]
   *  from the first source page's CropBox. */
  pageSize?: [number, number];
  /** Outer margin in points around both cells. Default 0. */
  margin?: number;
  /** Spacing in points between the two cells (across the spine). Default 0. */
  gutter?: number;
  /** Creep compensation in points per nesting level; see "Creep" below.
   *  Default 0 (no compensation). */
  creep?: number;
}

/** Impose this document's pages as a saddle-stitch booklet into a new Document
 *  (this one is unmodified, like NUp/Split/ExtractPages). */
Booklet(opts?: BookletOptions): Document
```

`Booklet` returns a new Document and never mutates the receiver — the same
contract as `NUp`, `Split` and `ExtractPages`.

### `src/booklet.ts`

```ts
/** One printed side of a folded sheet. */
export interface BookletSide {
  /** Nesting level of the physical sheet: 0 = outermost. Drives creep. */
  sheet: number;
  /** 1-based source page number in the left cell, or null for a pad blank. */
  left: number | null;
  /** 1-based source page number in the right cell, or null for a pad blank. */
  right: number | null;
}

/** The printed sides of a saddle-stitch booklet of `pageCount` pages, in duplex
 *  print order (sheet 0 front, sheet 0 back, sheet 1 front, ...). */
export function bookletSides(
  pageCount: number, binding: 'left' | 'right',
): BookletSide[];

/** Resolved sheet geometry, shared by every side. */
export interface BookletMetrics {
  sheetW: number; sheetH: number;
  cellW: number; cellH: number;
  margin: number; gutter: number; creep: number;
}

/** The two cell rects [x0, y0, x1, y1] of a sheet at nesting level `sheet`,
 *  with creep applied. */
export function bookletCells(
  m: BookletMetrics, sheet: number,
): { left: [number, number, number, number]; right: [number, number, number, number] };
```

## Ordering

For `n` source pages, pad to `N = ceil(n / 4) * 4`. Then:

- sheets = `N / 4`
- printed sides (output pages) = `N / 2`

Sheet `s` (0 = outermost) carries:

| side | left cell | right cell |
|---|---|---|
| front | `N - 2s` | `2s + 1` |
| back | `2s + 2` | `N - 2s - 1` |

`binding: 'right'` swaps the two cells on every side. Any page number greater
than `n` is a pad blank: its cell is `null` and nothing is placed there, exactly
as `NUp` leaves the unused cells of a partial last sheet empty.

Worked example, 8 pages, left binding:

```
  side 1 (sheet 0 front):  [ 8 | 1 ]
  side 2 (sheet 0 back):   [ 2 | 7 ]
  side 3 (sheet 1 front):  [ 6 | 3 ]
  side 4 (sheet 1 back):   [ 4 | 5 ]
```

Printed duplex and folded down the middle, this reads 1..8 in order.

## Geometry

From the first source page's CropBox `W x H` (CropBox falls back to MediaBox):

```
sheetW = 2*W + 2*margin + gutter        (unless pageSize overrides)
sheetH = H + 2*margin
cellW  = (sheetW - 2*margin - gutter) / 2
cellH  = sheetH - 2*margin
```

This is exactly `NUp(2, 1)`'s formula, so the two features stay dimensionally
consistent.

Each printed side becomes one output page built the way `NUp` builds a sheet:
`/Type /Page`, `/Parent` the new root, `/MediaBox` **and** `/CropBox` both
`[0, 0, sheetW, sheetH]`, and an empty `/Resources` that `placeFitted` then
populates. Pages are allocated and `syncPages`-d before anything is placed.

Cell rects at nesting level `s`, with `d = s * creep`:

```
left  = [margin + d,                    margin, margin + cellW + d,                    margin + cellH]
right = [margin + cellW + gutter - d,   margin, margin + 2*cellW + gutter - d,         margin + cellH]
```

## Creep

Creep compensation is the one part of this design that is invisible until
something is physically folded, so the direction is stated explicitly.

Nested sheets protrude at the fore edge when folded — the innermost sheet sticks
out furthest. The stack is then trimmed flush, so **inner** pages lose more
fore-edge paper than outer ones, and their content ends up sitting closer to the
trimmed fore edge. Compensation therefore moves inner sheets' content **toward
the spine**: the left cell by `+s * creep`, the right cell by `-s * creep`.

Sheet 0 is never shifted. The outermost page keeps its nominal position and every
inner sheet pulls inward from it — predictable, and it means `creep: 0` is
byte-identical to omitting the option.

Creep offsets the whole **cell rect**, not the content within a fixed cell. Since
`placeFitted` scales-to-fit and centres within whatever rect it is given, the
placed content translates and does not change size.

`creep` is validated as a finite number `>= 0`. A large enough `creep` (or
`margin`) can drive the two cells into overlap; like `NUp`, that arithmetic is
the caller's and is documented rather than guarded — guarding it would mean
inventing a policy for a case no real bindery value reaches.

## Errors

Mirrors `NUp`'s vocabulary. All validation runs before anything is allocated.

| Condition | Error |
|---|---|
| document has no pages | `RangeError` |
| `margin` / `gutter` / `creep` not finite, or negative | `TypeError` |
| `pageSize` not `[w, h]` of two positive finite numbers | `TypeError` |
| `binding` not `'left'` or `'right'` | `TypeError` |

Because `Booklet` builds a new Document, a rejected call cannot corrupt the
source; validating up front keeps it from leaving a half-built output either.

## Testing

`test/booklet.test.ts`, reusing the existing `test/helpers/build-nup-source.ts`.
Its pages show `P1`..`Pn`, so a test can decode a placed Form XObject's stream
body and assert *which* source page landed in *which* cell — not merely that two
XObjects exist.

- **Ordering, pure.** Table tests on `bookletSides` for 4, 8 and 12 pages across
  both bindings, and padding behaviour for 5, 6 and 7 pages (blank cells in the
  right places). No PDF is built.
- **Ordering, end-to-end.** 8 pages: side 1 is `[P8 | P1]`, side 2 is `[P2 | P7]`,
  read back from the placed XObjects.
- **Geometry.** Default MediaBox, growth by `margin`/`gutter`, explicit
  `pageSize` — mirroring the equivalent assertions in `test/nup.test.ts`.
- **Creep.** With `creep: 2`, sheet 1's left-cell `e` is `+2` and its right-cell
  `e` is `-2` relative to sheet 0, parsed from the `cm` placements the way
  `nup.test.ts` does. Also assert `creep: 0` matches the no-creep output.
- **Blanks.** A 5-page source yields 2 sheets / 4 sides, and the three pad cells
  carry no XObject at all.
- **Invariants.** The source Document is unchanged; the output survives a
  `Save()` / `Open()` round-trip.
- **Errors.** One case per row of the table above.

Per the repo rule, any assertion that passes on its first run is proved
load-bearing by mutation before being accepted — in particular the creep
direction, which a sign flip would otherwise leave green.

## Documentation

`README.md`: a feature bullet beside the `NUp` composition text, and a row in the
API table.

## Follow-up

`sheetsPerSignature` — splitting a long book into several separately-folded
signatures — is deferred to its own issue under epic `1gg0`, agreed during
design. Folding 40 sheets as a single signature is not physically possible, so
this matters for real books; it is simply not needed for parity today.
