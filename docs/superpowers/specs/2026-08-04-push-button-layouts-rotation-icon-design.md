# Push button: the remaining /TP layouts, /MK /R rotation, /MK /I icon

Closes `26w0`. Picks up the three things `dbpr.5` deferred (see
`2026-07-27-push-button-creation-design.md`): the `/TP` layouts 3, 4 and 5,
`/MK /R` caption rotation, and exposing the icon as a `/MK /I` form XObject.

## 1. The remaining three /TP layouts

`buttonRegions` covered four of the seven layouts PDF 32000-1 table 189
defines. The other three are now modelled.

### Naming

The specification names each layout after the **caption** ("caption above the
icon"), but the shipped member for `/TP` 2 is `'icon-above-caption'` — named
after the icon. The three new members follow the shipped name, so all seven
read the same way round:

| `ButtonIconPosition` | `/TP` | Table 189 wording |
|---|---|---|
| `'caption-only'` | 0 | no icon; caption only |
| `'icon-only'` | 1 | no caption; icon only |
| `'icon-above-caption'` | 2 | caption below the icon |
| `'icon-below-caption'` | 3 | caption above the icon |
| `'icon-left-of-caption'` | 4 | caption to the right of the icon |
| `'icon-right-of-caption'` | 5 | caption to the left of the icon |
| `'caption-over-icon'` | 6 | caption overlaid on the icon |

### Geometry

Two rules, each shared by a pair of layouts, so the members of a pair cannot
drift apart:

- **Vertical split** (2 and 3): a caption strip of `min(0.3·h, 14)` points at
  one end, the icon taking the rest. The cap is what stops a tall button giving
  the caption more room than a single line can use.
- **Horizontal split** (4 and 5): the icon takes a column of
  `min(h, 0.5·w)` — a square at most, and never more than half the width. The
  half-width cap is load-bearing: without it a narrow button hands the icon the
  entire box and the caption gets a zero-width region.

Validation is unchanged and already generic — every layout other than
`'caption-only'` requires an icon, and `'caption-only'` rejects one.

## 2. /MK /R rotation

`widgetGeom` already *read* `/MK /R` and `buildAppearanceXObject` already
emitted a rotating `/Matrix`, but nothing wrote `/MK /R` and the rotation was
wrong when something else did.

### The bug

For a quarter turn the appearance was still composed in the `/Rect`'s own
dimensions. A viewer transforms `/BBox` by `/Matrix`, takes the bounding box of
the result and maps *that* onto `/Rect` (12.5.5), so a 200×50 widget at 90°
produced a 50×200 transformed box, offset to `x = 150`, which the viewer then
stretched onto the 200×50 rect. Text also wrapped and centred against the wrong
edges.

### The fix

`WidgetGeom.w`/`.h` are now the **layout** box: the `/Rect` transposed under a
quarter turn. Every body composes into it unchanged, and `matrixFor` translates
by the box extent that the rotation sweeps onto the negative axis (`g.h` at
90°, `g.w` at 270°). The transformed `/BBox` then covers the `/Rect` exactly at
all four rotations — which is what the test asserts, by running the viewer's own
algorithm rather than by pinning matrix literals.

This is one fix for every field type, not just push buttons.

### The API

`rotate?: 0 | 90 | 180 | 270` joins `WidgetStyle`, beside the border and
background keys — `/MK /R` is a widget characteristic, not a button one, so it
belongs to the vocabulary every field type and both `Add*` and `SetStyle`
already share. Validated in `checkWidgetStyle` (anything but a quarter turn is a
`TypeError`, since a viewer may ignore it and then show something other than
what we drew) and written in `applyWidgetStyle`. `0` is written rather than
deleted, so a caller can turn a rotation back off.

## 3. /MK /I icon exposure

Table 189's `/I` is a **form** XObject, not the image. The icon is therefore
wrapped in a form whose `/BBox` is the image's natural size, and *that* one
object is referenced from both `/MK /I` and the appearance streams'
`/Resources /XObject /BtnIco` — one object, so a save never carries the icon
twice. `/MK /IF` records `/SW /A`, `/S /P`, `/A [0.5 0.5]`, which is exactly
what `iconOps` draws: always scale, proportionally, centred.

**Invariant:** the icon object may be either kind. A form is already its own
size and is only *scaled* by the placing `cm`; an image draws into the unit
square, so the same `cm` must also carry the drawn size. `iconSize` reports
which kind it found, because a button written before this change stored the
image directly and restyling one must still place it correctly — reading `/BBox`
off an image finds nothing and drops the icon, and scaling a form as if it were
an image draws a speck.

`existingIconRef` also falls back to `/MK /I` when there is no `/AP` to read
from. A producer that wrote `/MK` and left the appearance to the viewer would
otherwise have its icon decided nonexistent and the button rebuilt as
caption-only.

## Still deferred

Nothing from `26w0`. Named actions (`/S /Named`) remain out of scope, as in the
original design.
