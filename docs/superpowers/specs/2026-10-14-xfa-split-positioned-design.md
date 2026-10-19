# XFA: splitting a positioned subform (`164g.11`)

164g.8 splits a `tb` subform between its children and places every other unit
WHOLE. A positioned subform that does not fit the room left is deferred to the
next region; one taller than an empty region is refused. This design splits a
positioned subform the way Adobe does, and only where Adobe does.

The issue was filed on XFA 3.3 p. 292's default -- a subform under a flowing
parent is `keep intact="none"` -- and on split consensus (p. 293-294). Its own
text said no oracle existed. This design rests on one built for it: Adobe's
layout engine, read out of Acrobat Reader through XFA scripting.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Oracle | **Adobe Reader**, not pdf.js. pdf.js 6.3.289's `Subform.isSplittable()` returns false for `layout="position"`, so it never splits one and cannot be the oracle. |
| 2 | Which positioned subforms split | Only those stating `<keep intact="none"/>` under a flowing parent (R1). Adobe treats the default as unsplittable, contradicting the issue's premise. |
| 3 | A field straddling the cut that Adobe would split (R4) | **Refused**, naming 164g.13. Adobe's bottom-piece rule is not pinned (t21). |
| 4 | Margins on a splitting subform (R7) | **Refused.** Adobe's margin behaviour across a split is unresolved (t14). Since 164g.20 we split it as Adobe does (t96-t104). |
| 5 | A default positioned subform taller than an empty region | **Out of scope**, filed as its own issue. Adobe overflows it onto the current page (t4); we keep refusing it. Since 164g.19 we place it as Adobe does. |

## The oracle

Acrobat Reader 26.1.21691.0 (Acrobat DC, Reader mode, Protected Mode on) lays
out a dynamic XFA form with its own engine. A `docReady` script in the probe
walks `xfa.form` and writes, for every subform, field and draw, its SOM
expression and, per fragment `k < xfa.layout.pageSpan(node)`, the page and
`xfa.layout.x/y/w/h(node, "pt", k)`, into a 3in multi-line field at the top of
page 1.

- **The output is read off the screen.** Reader will not save data typed into
  these forms, and a folder-level trusted function is invisible to XFA scripts
  (`typeof spikeSave` reports `undefined`). The runner captures the Reader window
  with `PrintWindow`, and the numbers are transcribed by hand into
  `adobe.json`, the captures vendored beside it.
- **Coordinates are relative to the parent's content box.** t23 settles it: a
  growable positioned subform with insets 18/12 measures 130pt for a field at
  y 80 h 20 (80 + 20 + 18 + 12), so Adobe honours margins, while the field still
  reports y 80. A root child's coordinates are relative to the content area.
- **Probe frame.** Every probe is US Letter with one content area
  `x=0.5in y=0.5in w=7.5in h=10in` (540 x 720pt), the 216pt output field first.
  A 5in filler then leaves exactly 144pt of room on page 1, the positioned
  subform `pos` starting at y 576. Fields carry the default font, Courier 10pt.
- **Its ceiling:** one producer, one version, hand transcription. Evidence, not
  conformance.

## Evidence

Fragments are `page:(x, y, w, h)`; `;` separates fragments. Template positions
are given in the probe column.

| Probe | Setup | Adobe |
|---|---|---|
| t3 | `pos` 288pt, default keep; fields a/b/c at y 36/108/216 | `pos` 2:(0,0,540,288), whole; a/b/c on page 2 at 36/108/216 |
| t4 | `pos` 864pt (taller than the region), default keep, no filler | 1 page; `pos` 1:(0,216,540,864) overflowing; d at 1:(0,792) |
| t5 | t3 + `keep none` | `pos` 1:(0,576,540,144); 2:(0,0,540,144). a 1:36, b 1:108, c 2:72 |
| t6 | t5, field b y 108 h 72 straddles | `pos` 144;144. b 1:(0,108,144,36); 2:(0,0,144,36) -- the field splits |
| t7 | `pos` 864pt + keep none, no filler (room 504); c y 496.8 h 21.6 straddles | `pos` 1:(0,216,540,496.8); 2:(0,0,540,367.2). c 2:(0,0); d 2:(0,295.2) |
| t8 | field f y 138 h 48 (top piece 6) | cut 138: `pos` 138;150. f 2:(0,0,144,48) |
| t9 | f y 133 (top piece 11) | f 1:(0,133,144,11); 2:(0,0,144,37); `pos` 144;144 |
| t10 | f y 132 (12) | f 12;36 |
| t11 | f y 120 (24) | f 24;24 |
| t12 | draw y 120 h 48 | cut 120: `pos` 120;168. draw 2:(0,0,144,48) |
| t13 | default positioned child y 120 h 48 | cut 120: `pos` 120;168. child 2:(0,0,216,48) |
| t14 | `pos` insets top 18 bottom 12; f y 80, h y 200 | `pos` 144;144. f 1:(0,80); h 2:(0,56) -- explained by 164g.20 (R7) |
| t15 | `pos` 1800pt + keep none; f/h/k at 100/900/1700 | 4 fragments 144;720;720;216. f 1:100, h 3:36, k 4:116 |
| t16 | t14's insets, fits | `pos` 1:(0,288,540,288); f (0,80) |
| t17-t19 | f top piece 7, 8, 9 | cut 137, 136, 135; f whole on page 2 |
| t20 | f top piece 10 | f 1:(0,134,144,10); 2:(0,0,144,38) |
| t21 | f y 104 h 46 (top 40, bottom 6) | f 1:(0,104,144,30); 2:(0,0,144,16); `pos` 134;154 |
| t22 | f 20pt font, y 129 h 60 (top 15) | cut 129; f whole on page 2 |
| t23 | growable `pos`, insets 18/12/6, f y 80 h 20 | `pos` h 130; f (0,80) |
| t24 | keep-none positioned child y 100 h 120 straddles; its fields at 0 and 80 | `pos` 144;144. child 1:(0,100,216,44); 2:(0,0,216,76). k 2:(0,36) |
| t25 | draw y 0 h 200 (cut forced to 0) | `pos` 2:(0,0,540,288), whole |
| t26 | only field g y 200, below the cut | `pos` 144;144, fragment 1 empty. g 2:(0,56) |

## Rules

**R1. What splits.** A subform splits geometrically when its layout is
`position`, it states `<keep intact="none"/>` (a direct `<keep>` child), and its
parent's layout is `tb` or `lr-tb`. Every other positioned subform is placed
whole, as today (t3, t5, t13).

**R2. Where the cut falls.** The cut starts at the room left. Any child whose
box straddles it -- top above, bottom below -- and will not split moves the cut
up to that child's top: a draw (t12), a subform R1 does not split (t13), and a
field whose top piece is smaller than its font size (t8, t17-t19, t22). The
search repeats from the new cut until no child straddles it (t7). A child's box
is its laid-out extent in the positioned parent (`measureExtent`).

**R3. Recursion.** A straddling child that R1 splits is split at the same cut
in its own coordinates, `cut - child.y`, by the same rules (t24).

**R4. Fields Adobe splits.** A straddling field whose top piece is at least its
font size is split by Adobe (t6, t9-t11, t20), and the bottom piece obeys a
rule t21 shows exists but does not pin. Such a split is **refused**: the field,
and every later leaf in the flow, are reported with the reason naming 164g.13.
The font size is the field's base run size (`leafText`), default 10.

**R5. Nothing above the cut.** A cut at 0 is no split. The subform is placed
whole by today's rules (t25).

**R6. Fragments.** The first fragment is `cut` tall; a middle fragment is the
next region's full height; the last is what remains. Each is a shallow copy of
the subform with `h` set, holding the children whose top falls in it, each at
its template y minus the height of the fragments before it (t5, t15). After R2
no child straddles a cut, so each leaf lands in exactly one fragment and keeps
its SOM name; a child split by R3 is represented by its own fragment copies. A
fragment may hold no children (t26). Remaining height is split again in the
next region by the same rules.

**R7. Margins.** A subform R1 would split that states a non-zero top or bottom
inset is refused, the reason naming 164g.20. Left and right insets do not
affect a vertical cut and are allowed.

*Superseded by 164g.20 (probes t96-t104):* the cut is the room taken in the
subform's CONTENT coordinates, its top and bottom insets ignored, and every
fragment draws its top inset. A child up to the room below the content top
stays in the first fragment, which Adobe draws past the content area (t102: a
bar 12pt past it, read from the capture). A straddler still moves the cut
(t104), and a nested keep-none subform applies the same rule in its own content
coordinates (t103). Fragment heights are the cut and the rest of the box.

**R8. Anchors.** A subform R1 would split holding a child whose `anchorType`
is not `topLeft` is refused: fragments rewrite each child's `y`, and no probe
covers an anchored child. (Amendment, found while planning.)

**Scope (amendment, found while planning).** Only a ROOT child is split. A
positioned subform reached as an atom of a 164g.8 `tb` split chain is still
placed whole, as today; no probe covers that case, and it is 164g.21.

*Done by 164g.21 (probes t105-t110):* Adobe splits a keep-none positioned
subform inside a split `tb` by the same consensus, against the room left inside
the chain -- the `tb`'s bottom inset excluded (t110) -- and the `tb` fragment
shrinks to what it holds (t109: 130, not 144). Without keep-none it moves whole
(t106). Nested `tb`s change nothing (t108). `straddle` does it; a split the
rules refuse moves whole, as a refused field in a `tb` does.

## Design

### `xfapage.ts`

Where a root child does not fit the room left, a positioned subform passing R1
is handed to a new pure function (164g.21 extends this to split-chain atoms):

```ts
positionedCut(node, room, measure): number | { refusal: string }
```

It applies R2, R3, R4 and R7 and returns the cut. Pagination then:

- on a refusal, refuses as 164g.8 does from the failing leaf on;
- on `0`, places the unit whole (R5);
- otherwise emits fragment one into the current region and continues with the
  remainder as a unit of height `H - cut`, which may split again.

The p. 295 override is untouched: a unit that splits never reaches it, and one
that does not split reaches it exactly as today.

### Fragments

`fragmentPositioned(node, from, to)` builds the copy for one fragment: `h = to -
from`, children whose top lies in `[from, to)` shifted by `-from`, and an R3
child replaced by its own fragment copy. `xfaflow.ts` lays fragments out
unchanged; it already places a positioned subform's children by their `y`.

### Template reading

Nothing new: `LayoutNode.keep` (164g.8) carries `intact`, and a field's font
size is read from the leaf text the template already builds.

## Testing

- **Oracle** `test/xfa-adobe-oracle.test.ts`: converts each probe in
  `test/fixtures/xfa-adobe/` and compares every field's page and rect with
  Adobe's, page coordinates derived from `adobe.json` by chaining each node's
  parent offsets from the content-area origin (36, 36). Within 0.05pt. The
  refused probes (t6, t9-t11, t14, t20, t21) assert the refusal and its reason;
  t4 asserted today's refusal, the filed divergence, until 164g.19 matched it.
- **Builder cases** in `test/xfapage.test.ts`: `positionedCut` over hand-built
  nodes for each of R2's three kinds, the repeat (t7's shape), R3, R4, R5 and
  R7; fragments for t15's three-region case and t26's empty fragment.
- **Mutations**, each expected to redden: split a default positioned subform;
  skip the R2 repeat; compare the top piece with `<=` instead of `<`; ignore
  R3 and move the cut to the child's top instead; forbid an empty fragment;
  drop the `-from` shift; allow margins.

## Files

- `scripts/gen-xfa-adobe-probes.ts`: the probe generator (template bodies,
  the `docReady` script, the `config` packet with
  `acrobat/acrobat7/dynamicRender=required` that makes Reader render it
  dynamically) -- promoted from the spike. Not run by `npm test`.
- `test/fixtures/xfa-adobe/`: the probe PDFs, `adobe.json`, the window
  captures, and `PROVENANCE.md`: Reader version, the screen channel, manual
  transcription, how to re-run (`run.ps1`-style runner, Reader installed), and
  the ceiling.
- `test/helpers/build-xfa-pdf.ts` already supports `singleStream` and `extra`;
  the generator uses those.

## Child issues (filed while planning)

- 164g.19: a default positioned subform taller than an empty region. Adobe
  places it whole on the current page, overflowing (t4); we refuse it.
- 164g.20: margins across a positioned split (t14). Done: R7 above.
- 164g.21: a positioned subform inside a split `tb` chain. Done: see Scope above.
- Field splitting's bottom-piece rule (t21) is recorded on 164g.13.

## Documentation

- CHANGELOG **Added**: `ConvertXfaToAcroForm` splits a positioned subform that
  states `keep intact="none"` across pages, as Adobe Reader does, checked
  against Reader's own layout.
- CLAUDE.md: the `xfapage.ts` entry (R1-R7, the refusals), and a new entry on
  the Adobe oracle, its screen channel and its ceiling.
