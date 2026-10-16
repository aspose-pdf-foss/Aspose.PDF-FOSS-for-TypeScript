# XFA: adhesion and `keep intact="pageArea"` (`164g.14`)

`keep next` / `keep previous` (adhesion, XFA 3.3 p. 311-314, 357-358) is
ignored between root children today, and inside a subform being split it
refuses the split, so the root child falls back to whole placement (164g.8).
`keep intact="pageArea"` (p. 291) is treated as `contentArea` at the root and
refuses a split inside a chain. This design pages both the way Adobe Reader
does, measured through 18 new probes.

## Decisions taken in brainstorming

| # | Question | Decision |
|---|---|---|
| 1 | Scope | **Both** in one issue, adhesion first. |
| 2 | Which oracle? | **New Adobe Reader probes** t55-t72, the 164g.11 pipeline. None of the ten vendored real forms states `keep next`, `keep previous` or `intact="pageArea"` (scanned 2026-10-16: only `none` and `contentArea` occur), so those forms are a fence, not evidence. |
| 3 | Architecture | **Lookahead fit**: the existing fit tests also ask that the adhering next sibling put something into the room left. Grouping cannot say "only the first fragment adheres" (p. 313); backtracking through `placeSplit`'s region state is fragile. |

## Evidence

Adobe Acrobat Reader 26.1, 2026-10-16. Every probe places the 216pt oracle
field first, so page 1 has 504pt left of a 720pt content area; "filler" is an
unsplittable positioned block. Blocks named with a capital letter are
positioned subforms with a stated `h` (unsplittable); lower-case names are
draws. `next` means `<keep next="contentArea"/>`.

| Probe | Template after the oracle | Adobe |
|---|---|---|
| t55 | filler 400; C 60 next; D 60 next; E 60 | C, D, E on page 2 at 0, 60, 120 |
| t56 | as t55, written as `previous` on D and E | identical to t55 |
| t57 | filler 400; C 40 next; D 40; E 60 | C, D page 1 at 616, 656; E page 2 |
| t58 | filler 400; C 60 next; D tb of six 30pt draws, next; E 60 | C p1 616; D1 p1; D2-D6 p2; E p2 at 150 |
| t59 | filler 400; C 500 next; D 500 | C p2 at 0; D p2 at 500, running to 1000 (past 720) |
| t60 | S tb: s1 400, s2 60 next, s3 60, s4 60 | s1 p1; s2, s3, s4 p2 at 0, 60, 120 |
| t61 | filler 400; S tb (s1 40, s2 40) next; N 60 | S WHOLE on p2 (s1 0, s2 40); N p2 at 80 |
| t62 | filler 400; C 60; X tb holding D 60 `previous` | C p1; D p2 -- no adhesion between non-siblings |
| t63 | filler 400; C 60 next; H 60 hidden; D 60 | C, D p2 at 0, 60 -- the hidden sibling is skipped |
| t64 | filler 400; C 60 `next="pageArea"`; D 60 | C p1; D p2 -- `pageArea` adhesion is none |
| t65 | filler 400; draw C 60 next; empty field D 60 | C p1 616; D split 44 / 16 (p1 / p2) |
| t66 | two content areas of 360pt (A above B); S tb of six 50pt draws, `intact="pageArea"` | S split across A (2 draws) and B (4), one page |
| t67 | as t66, twelve draws | 2 in A, 7 in B on p1; 3 on p2 -- split ACROSS pages |
| t68 | filler 400; S tb of four 50pt draws, `intact="pageArea"` | s1, s2 p1; s3, s4 p2 |
| t69 | filler 100; C 300 next; D 500 | ONE page: C at 316, D at 616, running to 1116 |
| t70 | filler 400; S tb (40, 40, 40) next; N 60 | s1, s2 p1; s3 p2 at 0; N p2 at 40 |
| t71 | t5 with `<keep intact="pageArea"/>` (positioned, 4in) | moves WHOLE to p2 (t5, with `none`, splits) |
| t72 | filler 400; table of four 40pt rows, r2 next | r1 p1; r2, r3, r4 p2 |

## Design

### 1. The rules

- **R1 (t55-t57).** Two adjacent siblings ADHERE when the first states
  `keep next="contentArea"` or the second `keep previous="contentArea"` (p.
  312: "In all three cases the effect is the same"). An object whose region
  cannot hold it plus something of the adhering next sibling waits for the next
  region. Chains compose: something of an unsplittable member is the member
  whole plus something of ITS adhering next.
- **R2 (t58, t65, t70).** "Something" of a splittable sibling is its first
  piece: a splittable subform's first leaf (with its containers' margins), a
  field's first piece by `fieldCut` (164g.13). When the current object splits,
  only its LAST piece adheres.
- **R3 (t61).** An object -- or a split object's remaining piece -- that fits
  whole but not with the next sibling's lead waits for the next region WHOLE.
  It is not split to make room.
- **R4 (t59, t69), and it overrules the obvious reading of p. 312.** When the
  pair cannot fit even an EMPTY region, nothing waits: the first object goes
  where it would alone, and the next is placed immediately after it in the SAME
  region, running past its end. A chain does not move to a fresh region. We
  place the runaway member only when nothing it draws lies past the content
  area (p. 295's existing posture); otherwise it is refused by name.
- **R5 (t60, t72).** Adhesion holds between siblings inside a subform being
  split, table rows included.
- **R6 (t62, t63).** Only SIBLINGS adhere (p. 314), and a hidden sibling (no
  layout space) is skipped: C adheres to D across a hidden H.
- **R7 (t64).** `keep next/previous="pageArea"` is no adhesion -- the spec's
  own note says Adobe does not support it.
- **R8 (t66-t68, t71), and it overrules p. 291.** A FLOWED subform (`tb`,
  `lr-tb`, `table`) with `intact="pageArea"` splits exactly as `none` does,
  across pages included. A POSITIONED one does not split: Adobe splits a
  positioned subform only when it states `none` (164g.11), and `pageArea` is
  not `none` there.

### 2. `src/xfakeep.ts` (new, pure leaf)

The keep vocabulary, so the root loop and `placeSplit` cannot disagree:

- `adheres(a: LayoutNode, b: LayoutNode): boolean` -- R1 and R7 for two
  adjacent visible siblings.
- `nextAdhering(siblings, i): LayoutNode | undefined` -- the next VISIBLE
  sibling after index `i` when `i` adheres to it (R6's hidden-sibling skip).
- `intactSplits(n): boolean` -- `none`, or `pageArea` on a flowed subform (R8).

A leaf over `xfaflow.js` TYPES that never throws.

### 3. Pagination (`xfapage.ts`)

- `splittable()` reads `intactSplits`. `chainRefusal` loses both 164g.14
  refusals; the `breakAfter` one (164g.16) stays.
- **`leadFits(y, room, hooks, height)`** answers "would `y` put something into
  `room`": `y` fits whole; else, for a splittable subform, its first leaf's
  fragment fits; else, for a field, `fieldCut(y, room)` returns a cut; and an
  unsplittable `y` that adheres onward needs its whole height plus
  `leadFits(z, room - h(y))`. It measures through the same `height` and
  `fragmentOf` as the fit test, so the two cannot disagree.
- **Root loop.** Before committing child `c` whole, when `c` adheres to its
  next sibling `y`: the fit becomes `fits(c) && leadFits(y, room - h(c))`. On a
  failure in a non-empty region the child advances (R3). On a failure in an
  EMPTY region, R4: if `c` plus `y`'s lead cannot fit an empty region either,
  `c` is placed and `y` is FORCED into the same region next (below).
- **`placeSplit`.** Between consecutive leaves `j`, `j+1`, adhesion is decided
  at the level where their paths diverge, by `adheres` on the two siblings
  there (R5); the root child's last leaf adheres to the root's next sibling
  when the root child does. When leaf `j` would close a region but the adhering
  lead of `j+1` does not fit after it, leaf `j` is held off whole to the next
  region (R3) -- the region before it is flushed as today.
- **Forced placement (R4).** The next sibling is placed in the same region
  after the first; when it is unsplittable and draws nothing past the content
  area it is placed, otherwise it is refused naming R4.

### 4. Refused by name (not probed)

- adhesion between the ITEMS of an `lr-tb` line (an `lr-tb` item and its next);
- an R4 chain whose runaway member is splittable;
- adhesion into a sibling that states a `breakBefore`;
- adhesion into a keep-none POSITIONED sibling (its first piece is 164g.11's
  split consensus, which `leadFits` does not reproduce).

Each falls back to TODAY's behaviour, so no form that converts now loses a
field: between root children the adhesion is ignored, as 164g.3 did, with a
warning in `XfaConvertReport.warnings` naming the shape; inside a split chain
`placeSplit` returns `unsplittable`, as `chainRefusal` does today, and the root
child falls back to whole placement, refused by name only if it then does not
fit.

## Risks

- **The oracle is one producer, one version, transcribed by hand** -- the
  164g.11 ceiling. All probes use draws and empty fields: where adhesion meets
  text measurement differences is unmeasured.
- **R4 depends on ink-past.** A runaway member whose fields lie past the
  content area is refused, where Adobe draws it outside the page. That is the
  existing p. 295 posture, chosen over approximating.
- **No real form** in the corpus uses these keeps, so nothing outside the
  probes confirms the rules on Designer output.

## Testing

- `test/fixtures/xfa-adobe/`: vendor t55-t72 (`.xml`, `.pdf`, `captures/`),
  transcribe Adobe's pages and boxes into `adobe.json`, SHA-256s and a new
  section in `PROVENANCE.md`. `test/xfa-adobe-oracle.test.ts` lands every
  field, draw and subform fragment on Reader's page and box for all 18.
- `test/xfakeep.test.ts`: `adheres` (both spellings, `pageArea`, absent),
  `nextAdhering` (hidden skip, last sibling), `intactSplits` (flowed vs
  positioned).
- `test/xfapage-keep.test.ts`: builder cases per rule, including the ones the
  probes cannot separate -- a chain of three where only the middle fails, a
  split's held-off last leaf, every refusal in section 4.
- Fences: every existing oracle (`xfa-real`, `xfa-adobe`, `xfa-dynamic`,
  `xfa-master`, qualified) must not move.
- Mutation sweep, recorded in CLAUDE.md.

## Documentation

CHANGELOG under `[Unreleased]`; CLAUDE.md entries for `xfakeep.ts` and the
pagination invariants, plus the `fixtures/xfa-adobe/` row (52 -> 70 probes);
README's XFA limitation bullet.

## Child issues

None planned; section 4's refusals get one issue each only if a real form
needs them.
