# Caret annotation: page.AddCaret

Closes `0pvw.2`, the last child of epic `0pvw` (annotation coverage completion).
Parity target: `Aspose-PDF-FOSS-for-Go` `_examples/feature_showcase/main.go`.

`/Caret` (PDF 32000-1 §12.5.6.11) marks a point where text should be inserted.
The name is already known to the library — it appears in the FDF and XFDF
subtype tables (`annotdata.ts`, `xfdfannot.ts`) — but there is no typed class, no
builder, and `regenerateAppearance` lists it among the subtypes it declines to
draw. This adds all three.

This is a small feature that follows an established pattern. It introduces no new
module and no new rendering primitive.

## API

```ts
// page.ts
AddCaret(opts: CaretOptions): CaretAnnotation
```

| Option | Writes | Default |
|---|---|---|
| `rect` | `/Rect` | required |
| `symbol` | `/Sy` — `'none'` → `/None`, `'paragraph'` → `/P` | `'none'` |
| `color` | `/C` | `[0, 0, 0]` black |
| `contents` | `/Contents` | absent |
| `author` | `/T` | absent |
| `opacity` | `/CA` | absent |
| `popup` | `/Popup` | absent |

Black matches `AddSquare`/`AddCircle`, the nearest neighbours in the file.

`CaretAnnotation extends Annotation` with `Symbol: 'none' | 'paragraph'` and
`Author: string | undefined`. An unrecognised `/Sy` name reads back as `'none'`
rather than throwing — the same tolerance `FreeTextAnnotation.Alignment` shows
for an out-of-range `/Q`.

### /RD is read, never written

`/RD` records the difference between `/Rect` and the caret's actual boundary. Our
caret fills its `/Rect`, so an authored `/RD` would always be `[0, 0, 0, 0]` —
exactly what absent already means. There is no `/RD` accessor and no `/RD` in the
output.

It is still *read*, because a caret from another producer may carry one: see
Regeneration below.

## Drawing

One function in `annotdraw.ts`, used by both the builder and regeneration:

```ts
export function caretBody(
  g: WidgetGeom, color: [number, number, number],
  symbol: 'none' | 'paragraph', rd?: number[],
): string
```

A filled wedge: apex at the top centre, a flat baseline, and two sides curving
*inward* via `c` operators — the proofreader's insertion caret, not a plain
triangle. `drawEllipse` already emits `c`, so this needs no new primitive.

With `symbol: 'paragraph'` the box splits at 40/60: the ¶ occupies the leftmost
40% of the width and the caret the remaining 60%, both scaled to the box. With
`symbol: 'none'` the caret spans the full width. The ¶ is WinAnsi `0xB6`, emitted
through the same `encodeWinAnsi` + `serializeString` path every other text body
uses.

**The glyph must name the font key `installShapeAP` actually registers.**
`installShapeAP` calls `buildAppearanceXObject(doc, g, 'Helvetica', 'F0', body)`
and `fontResources` registers exactly one key, so the operator is `/F0 <size> Tf`.
Emitting `/Helv` instead would name a resource that is not in the form — which is
precisely the pre-existing bug filed as `cu3b`, where `wrapTextBody` hardcodes
`/Helv` while its caller registers `F0`. Fixing `cu3b` is out of scope here; not
reproducing it is not.

`rd` is the optional `/RD` inset, applied inside this function. Keeping it a
parameter here means the `/RD` rule lives in one place instead of being
re-derived at the regeneration call site.

## Regeneration

A `case 'Caret'` in `regenerateAppearance`, reading `/Sy` and `/RD` off the dict
and calling `caretBody`. A `/Caret` arriving through `ImportXfdf`/`ImportFdf`
with an `<appearance>` we cannot decode is then drawn from its properties instead
of importing without an appearance.

Two documents currently name `/Caret` as having no generator and must both drop
it:

- the `regenerateAppearance` doc comment, `annotdraw.ts` (~line 427)
- the XFDF appearance limitation bullet, `README.md` (~line 1695)

## Shared accessor cleanup

`Author` (`/T`) is duplicated on `TextAnnotation` and `RedactAnnotation`;
`CaretAnnotation` would make three. The read/write pair moves to module-private
`readTextString(doc, dict, key)` / `writeTextString(dict, key, v, label)` helpers
in `annotation.ts` and all three delegate.

This is the same consolidation `QuadPoints`, `Alignment`, `InteriorColor` and the
`/DA` read went through for `0pvw.1`, now justified on `/T` by a third copy.

## Modules

No new module.

| File | Change |
|---|---|
| `src/annotation.ts` | `CaretAnnotation`, `CaretOptions`, `addCaret`, the `wrapAnnotation` case, the `/T` helpers |
| `src/annotdraw.ts` | `caretBody`, the `regenerateAppearance` case, the doc comment |
| `src/page.ts`, `src/index.ts` | wiring and exports |
| `README.md`, `CLAUDE.md` | user-facing docs, architecture note |

## Errors

Validation runs before `createAnnotation` allocates, so a rejected call leaves the
document byte-identical — the rule the whole `Add*` family follows.

| Case | Behaviour |
|---|---|
| Malformed `rect` | `TypeError`; no annotation added |
| `color` component outside 0..1 | `TypeError`; no annotation added |
| `symbol` not `'none'` or `'paragraph'` | `TypeError`; no annotation added |
| `opacity` outside 0..1 | `TypeError`; no annotation added |
| Degenerate `rect` (zero width or height) | Annotation created, no `/AP` — matches `addSquareCircle`'s `if (g)` guard |
| Unrecognised `/Sy` on a foreign dict | Reads as `'none'`; never throws |

## Testing

Tests go in the existing `test/annotation.test.ts` (builder) and
`test/annotdraw.test.ts` (body and regeneration), where `AddSquare` and its
regeneration case are already covered. There is no per-subtype test file to
follow, and adding two would break that grouping.

1. `AddCaret` writes `/Subtype /Caret`, `/Rect`, `/Sy`, `/C`, installs an `/AP`,
   and round-trips through `wrapAnnotation` as a `CaretAnnotation`.
2. The default symbol is `'none'` and writes `/Sy /None`.
3. `symbol: 'paragraph'` writes `/Sy /P` and its `/AP` contains a `Tj`; `'none'`
   contains none.
4. The `/AP` body is curved and filled — it contains `c` and `f`, distinguishing
   the intended caret from a plain triangle.
5. The `Tj` names the registered font key: the body contains `/F0` and the form's
   `/Resources /Font` has an `F0` entry. This is the `cu3b` trap; assert the two
   agree rather than assuming.
6. Each validation row above throws and adds no annotation.
7. A degenerate `/Rect` creates the annotation without an `/AP`.
8. `regenerateAppearance` on a hand-built `/Caret` dict returns `true`, installs
   an `/AP`, and honours `/Sy /P`.
9. `regenerateAppearance` honours `/RD` — a caret with a non-zero `/RD` draws
   inside a smaller box than one without.
10. An unrecognised `/Sy` name reads back as `'none'`.

Assertion 5 is the one to mutation-check: swap the emitted key for `/Helv` and it
must go red. It passes trivially on a correct implementation and covers a failure
that is invisible in any viewer that silently falls back to a default font.
