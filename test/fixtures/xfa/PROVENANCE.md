# XFA test fixtures — provenance

Hybrid XFA forms from a third-party producer, here to validate the
`xfa*.ts` conversion against bytes this repo did not produce. Tests in
`test/xfa-real.test.ts`.

| Fixture | Source | Pages | AcroForm fields | XFA | Shape |
|---|---|---|---|---|---|
| `irs-f1040.pdf` | <https://www.irs.gov/pub/irs-pdf/f1040.pdf> | 2 | 199 | yes | **hybrid**, mostly positioned |
| `irs-fw9.pdf` | <https://www.irs.gov/pub/irs-pdf/fw9.pdf> | 6 | 23 | yes | **hybrid**, one declared `<pageArea>` |

- Producer, from each file's own `/Info`: **`Designer 6.5`** — Adobe LiveCycle
  Designer, which is the authoring tool this feature was designed around.
- Fetched **2026-09-09**.
- SHA-256:
  - `irs-f1040.pdf` — `3d31c226df0d189ced80e039d01cf0f8820c1019681a0f0ca6264de277b7e982` (220,237 bytes)
  - `irs-fw9.pdf` — `2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53` (140,815 bytes)
- **Licence:** works of the United States federal government, not subject to
  copyright in the US (17 U.S.C. § 105), so they can be committed. The suite
  stays hermetic: no network, no Acrobat, nothing to install.

## Why a hybrid form is an oracle

A static XFA form carries **two independent descriptions of one field set** —
the XFA `template` packet, and the `/AcroForm` LiveCycle generated from it. The
test strips `/AcroForm /Fields` in a copy, leaving `/XFA` intact, converts from
the template **alone**, and compares the result against what Adobe wrote. The
code under test cannot see the answer.

That is the `cff.ts`-charstrings-checked-against-`hmtx` arrangement, and it
validates the SOM naming, the type mapping and the whole geometry pipeline —
units, anchors, offset accumulation, the y-flip, page identity, the medium
check — against numbers we did not compute.

## What it found

**It found a real bug on its first run, which is the whole reason it exists.**
The design never mentioned `<caption>`. An XFA field's box includes its label,
and the AcroForm widget covers only the **edit region** — the box minus the
caption's `reserve`, on the side its `placement` names. `f1_01` is 280.8pt wide
with `reserve="68.0156mm"` (192.8pt); Adobe's rect is exactly 88pt. Before the
fix the worst rect error across 151 placed fields was **229pt**; after it,
**12pt**, with 100 of 151 inside 1pt.

It then found a **second** rule the design missed, and **corrected the guess the
bug for it had been filed on**: the remaining point-or-two is the field's own
`<margin>` insets, and the `<border>` contributes nothing whatever. That bug
supposed the half-point was "a 1pt border the widget is inset by half of"; it is
`topInset="0.1764mm"` read literally. What settles it is a sweep rather than a
single field — over all **54 distinct `textEdit` declaration shapes** in `f1040`
the width error was exactly `leftInset + rightInset` and the height error exactly
`topInset + bottomInset`, with **no exception**, while the border edge thickness
varied independently across those same rows and moved nothing (`f2_01` carries a
visible `0.3528mm` edge and matches Adobe exactly). Worst error **12pt → 6.4pt**,
and the count matching Adobe *exactly* went **53 → 105 of 151**.

**What the corpus cannot say** is the ORDER of the two subtractions: both take
fixed amounts off named edges, so the resulting rect is identical either way, and
`f1040` never pairs a caption with an inset on the same edge. Only the two
refusal guards differ.

It then found a **third** rule, and this one was settled by the form we do
**not** place. A `<checkButton size="...">` states the button's own box, not the
field's: every one of Adobe's 54 button rects across *both* files is exactly 8×8
for `size="2.8222mm"`, where the reduced field box is commonly 12×12. The
placement default is the interesting half — no field in either form states
`hAlign`, so every observed case is the default, and it turns out to be **two**
defaults: a caption on the **right** puts the button flush **left**, while a
caption on the left, or none at all, puts it flush **right**. `fw9` is what
settles it. We decline to place that form, so no test compares our rects
there — but Adobe's are still in its `/AcroForm`, and three of its buttons share
`x="14.4"` while all three rects begin at exactly 73.0. Of the four possible
pairings only this one makes a caption-right field and a caption-less one land
on the same edge, and it then reproduces **all 8** of that form's buttons on both
axes from a single page origin of 57.6. **A form in the `dataOnly` path is still
evidence about the arithmetic.**

It also **confirmed the one interpretation this feature adds beyond its
design** — that the layout chain starts *below* the subform carrying the
`<pageSet>`. `f1040`'s root subform is `layout="tb"`; read from the document
root, "every ancestor must be `position`" would place **zero** fields and the
whole positioned route would be dead code. It places 151.

## What it does NOT cover — read this before trusting a green run

- **No second XFA implementation arbitrates our output.** This compares against
  one producer's `/AcroForm`, which is strong evidence for the forms it covers
  and is **not** conformance evidence. No XFA implementation is installed and
  none can be.
- **Positioned layout only.** A flow-laid field has no Adobe rect to compare
  against either, so the flow degrade is checked for *presence*, never for
  correctness.
- **No residual geometry rule remains**, so `xfa-real.test.ts` asserts an
  **equality**: all 151 placed rects reproduce Adobe's to within a hundredth of
  a point, worst 0.0006pt — floating-point residue from the mm→pt conversions
  and nothing else.

  That assertion is a **regression fence for three rules at once**: disable the
  caption rule and the count collapses to about 1; disable the margin rule and
  it falls to 53 with the worst error at 12pt; disable the check-button rule
  and it falls to 105 with the worst error at 6.4pt.
- **Three check-button configurations appear in neither fixture**, so they are
  covered by `test/xfageom.test.ts` alone and are not measured against Adobe: a
  stated `<para hAlign>` (honoured, and it outranks the caption-derived
  default), a caption placed `top` or `bottom`, and a **left** caption with a
  non-zero reserve. The last two fall under the `right` default by the same
  rule.
- **`px`, `pc` and `em` measurements appear in neither fixture**, so their
  refusal is covered by `test/xfageom.test.ts` alone.
- **No non-`topLeft` `anchorType` appears in either fixture**, so the anchor
  arithmetic is builder-covered only (`test/xfageom.test.ts`).
- **No dynamic XFA form is vendored.** `irs-fw9.pdf` reaches the `dataOnly`
  path by a different route — a single declared `<pageArea>` against six pages,
  which the page-count rule refuses to align by guess — so what is covered is
  that rule, not a genuinely geometry-less dynamic template.
- **`<occur>` repeating subforms** are not exercised by either fixture, so
  Interpretation 3 (a repeating subform is flow-laid) is builder-covered only.

## Reproducing

```bash
curl -o test/fixtures/xfa/irs-f1040.pdf https://www.irs.gov/pub/irs-pdf/f1040.pdf
curl -o test/fixtures/xfa/irs-fw9.pdf   https://www.irs.gov/pub/irs-pdf/fw9.pdf
```

The IRS revises these forms annually and does not version the URL, so a later
fetch will **not** match the hashes above. That is why the bytes are committed
rather than downloaded by the suite.
