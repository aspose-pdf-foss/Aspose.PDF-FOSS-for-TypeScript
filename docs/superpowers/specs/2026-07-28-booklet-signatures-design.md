# Booklet: `sheetsPerSignature` (multi-signature imposition) — design

Issue: `aspose-pdf-foss-for-ts-1gg0.6` (epic `1gg0`, page-furniture & text-authoring
parity gaps). Date: 2026-07-28. Deferred from `1gg0.2`; see
`2026-07-28-booklet-imposition-design.md`, whose "Follow-up" section filed it.

## Scope

`doc.Booklet` imposes one signature: every sheet nests in a single fold. Folding
40 nested sheets is not physical, so a long book is bound as several signatures,
each folded and stapled separately. This splits the padded page list into chunks
and runs the existing per-signature ordering over each chunk.

No new geometry and no new rendering. Sheet size, cell rects, creep direction and
placement are untouched; only *which* source pages land on *which* sheet changes,
plus the nesting level that creep reads.

Out of scope, deliberately:

- **Per-signature sheet counts.** One count for the whole book. A bindery that
  wants 4-sheet signatures then a 3-sheet one can call `Booklet` twice on split
  documents.
- **Perfect binding / cut-stack imposition.** A different imposition entirely,
  not a variant of saddle stitch.
- **Bindery furniture** (fold marks, collation marks, signature numbering). Out
  of scope for `1gg0.2` and still out of scope here.

## API

```ts
// booklet.ts
export interface BookletOptions {
  // … binding, pageSize, margin, gutter, creep unchanged …

  /** Sheets per folded signature. Integer >= 1. Default: the whole book is one
   *  signature — today's behaviour, and byte-identical output. */
  sheetsPerSignature?: number;
  /** Pad the book so every signature holds exactly `sheetsPerSignature` sheets.
   *  Default false: the last signature is short. Requires `sheetsPerSignature`. */
  padSignatures?: boolean;
}
```

`padSignatures` without `sheetsPerSignature` throws `TypeError` rather than being
ignored — the same rule `structParent requires tagged: true` follows in
`toc.ts`: an option that cannot do anything must never be silently accepted.

### Model signature

```ts
/** @internal One printed side of a folded sheet. */
export interface BookletSide {
  /** Nesting level WITHIN its signature: 0 = that signature's outermost sheet.
   *  Drives creep. */
  sheet: number;
  /** 0-based signature index. */
  signature: number;
  left: number | null;
  right: number | null;
}

/** @internal Options that affect page ordering (not geometry). */
export type BookletOrderOptions =
  Pick<BookletOptions, 'binding' | 'sheetsPerSignature' | 'padSignatures'>;

export function bookletSides(
  pageCount: number, opts?: BookletOrderOptions,
): BookletSide[];
```

`bookletSides(pageCount, binding)` becomes `bookletSides(pageCount, opts)`. Four
positional parameters — two of them an optional number and an optional boolean —
is where call sites stop being readable. The function is `@internal` with exactly
two callers, `document.ts` and `test/booklet.test.ts`.

`bookletCells` and `BookletMetrics` are **unchanged**: cells take a nesting level
and know nothing about signatures.

## Ordering

For `n` source pages:

```
N = ceil(n / 4) * 4                    // today's global padding
P = 4 * sheetsPerSignature             // pages per full signature
if padSignatures:  N = ceil(n / P) * P // every signature full

signature k:  offset = k * P,  M = min(P, N - offset)
  sheet s of that signature (s = 0 .. M/4 - 1):
    front  [ offset + M - 2s   |  offset + 2s + 1     ]
    back   [ offset + 2s + 2   |  offset + M - 2s - 1 ]
```

`M` is always a multiple of 4: `N` and `P` both are, so every chunk — including a
short last one — is a whole number of sheets. Any page number greater than `n` is
a pad blank and comes back as `null`. `binding: 'right'` swaps the two cells on
every side, as today.

Without `sheetsPerSignature` this reduces to `k = 0, M = N` — literally today's
formula, so the default path cannot drift from current output.

Worked example, 12 pages, `sheetsPerSignature: 1`, left binding:

```
  signature 0, sheet 0:  [ 4 | 1 ]   [ 2 | 3 ]
  signature 1, sheet 0:  [ 8 | 5 ]   [ 6 | 7 ]
  signature 2, sheet 0:  [12 | 9 ]   [10 |11 ]
```

Three separately folded 4-page signatures which, collated in order, read 1..12.

Worked example, 10 pages, `sheetsPerSignature: 2` (P = 8):

| | `padSignatures: false` (default) | `padSignatures: true` |
|---|---|---|
| padded N | 12 | 16 |
| signature 0 | 2 sheets, pages 1–8 | 2 sheets, pages 1–8 |
| signature 1 | **1 sheet**, pages 9–12 | 2 sheets, pages 9–16 |
| blanks | 11, 12 | 11–16 |

`padSignatures` applies uniformly, including when the book is shorter than one
signature: 6 pages at `sheetsPerSignature: 4` pads to 16. That is the option
doing exactly what it says — the caller asked for uniform signatures.

## Creep

**This is the load-bearing change.** `BookletSide.sheet` drives creep, and each
signature is folded separately, so its nesting level restarts at 0 for every
signature. A globally increasing level would shift the last sheet of a 40-sheet
book at `creep: 2` by 78pt instead of 2pt — an error that is invisible on screen
and ruins the print.

Creep direction, magnitude and the "sheet 0 never moves" rule are unchanged from
`1gg0.2`; they now simply apply within each fold.

## Errors

Added to `Document.Booklet`'s existing up-front validation, which runs before
anything is allocated:

| Condition | Error |
|---|---|
| `sheetsPerSignature` present and not an integer `>= 1` | `TypeError` |
| `padSignatures` present and not a boolean | `TypeError` |
| `padSignatures` present without `sheetsPerSignature` | `TypeError` |

The existing five rows (no pages, `margin`/`gutter`/`creep`, `pageSize`,
`binding`) are unchanged.

## Testing

`test/booklet.test.ts`, extending the existing suite; the existing
`bookletSides(n, 'left')` call sites move to the options object.

- **Chunking, pure.** 12 pages at `sheetsPerSignature: 1` gives
  `[4|1],[2|3],[8|5],[6|7],[12|9],[10|11]`, with `signature` running 0,0,1,1,2,2
  and `sheet` staying 0 throughout. 16 pages at `sheetsPerSignature: 2` gives two
  signatures of two sheets.
- **Short last signature.** 10 pages at `sheetsPerSignature: 2`: signature 1 has
  one sheet, and pages 11–12 are `null`.
- **`padSignatures`.** The same 10 pages with `padSignatures: true` produce 16
  padded pages / 8 sides, with cells 11–16 `null`; a 6-page book at
  `sheetsPerSignature: 4` pads to 16.
- **Creep resets per signature.** 16 pages at `sheetsPerSignature: 2` and
  `creep: 2` — two signatures of two sheets each, so signature 1's sheet 1 is the
  fourth physical sheet. Its left cell is offset by `1*creep`, not `3*creep`,
  read from the `cm` placements the way `nup.test.ts` parses them. This is the
  assertion the feature exists to protect.
- **Default unchanged.** Omitting `sheetsPerSignature` yields output identical to
  the pre-change `Booklet` for the same input.
- **End-to-end.** 8 pages at `sheetsPerSignature: 1` places `P4|P1`, `P2|P3`,
  `P8|P5`, `P6|P7`, read back from the placed Form XObjects via
  `build-nup-source.ts` — not merely counted.
- **Errors.** One case per new row above.

Per the repo rule, an assertion that passes on its first run is proved
load-bearing by mutation before being accepted. Two mutations are mandatory here:
making `sheet` count globally (the creep-reset test must go red) and dropping the
`offset` from the ordering formula (the chunking tests must go red).

## Documentation

`README.md`: extend the `Booklet` prose and API-table row with
`sheetsPerSignature` / `padSignatures`, noting that the default is a single
signature.
