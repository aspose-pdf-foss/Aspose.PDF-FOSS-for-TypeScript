# XFA: bookend leaders and trailers (`164g.29`)

A subform's `<bookend leader trailer>` (XFA 3.3 p. 317-318, 326, 625) and the
deprecated `<break bookendLeader bookendTrailer>` (p. 634) are not read at
all: the bookend subforms are silently dropped. This design lays them down as
Adobe Reader does, measured through 17 new probes (t160-t176).

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Oracle | **New Adobe Reader probes t160-t176**, 164g.11's pipeline. No vendored form states a bookend (164g.15's scan). |
| 2 | Model | A bookend leader is the subform's FIRST child and its trailer its LAST, made once at template time. Every probe agrees, so pagination needs no change: a split puts the leader in the first fragment and the trailer in the last for free (p. 318). |
| 3 | Copies | Reuse 164g.15's `specOf`: target resolution, ignoring and refusals are R1 of that design, and a copy is a FORM instance named in the asserting subform's scope. |

## Evidence

Adobe Acrobat Reader 26.1, 2026-10-21. The oracle field takes 216pt of the
720pt content area on page 1; `filler` is an unsplittable positioned block. L
and T are positioned subforms 20pt tall, each holding a draw and a field, in a
`<proto>` inside the root subform unless noted. `D` are draws in `S`.

| Probe | Template | Adobe |
|---|---|---|
| t160 | S tb `<bookend leader="#L_ID" trailer="#T_ID">`, D1 50, D2 50 | `S.L` at 0, D1 20, D2 70, `S.T` 120; S 140 tall. `S.L.Lf` is a form field |
| t161 | t160, then S2 with the same bookend | S2 gets its own `S2.L`, `S2.T`: L's default `occur max` 1 does not limit bookends |
| t162 | S with a bookend and no other content | L at 0, T at 20 |
| t163 | S tb, D 100 x6, splits | p1 L, D1-D4; p2 D5, D6, T at 200 |
| t164 | bookend L/T plus overflow X/Y (`max -1`), D 100 x10 (Example 8.46) | p1: L, D1-D4, Y at 420; p2: X, D5-D10, T at 620 |
| t165 | t160 with the proto at TEMPLATE level | ignored, as an overflow target is (164g.15 R1) |
| t166 | ROOT subform's bookend, S of D 100 x8 | `L` at 0 above the oracle on p1, `T` after S on p2 (p. 318: start and end of the document) |
| t167 | S `occur initial=3` with a bookend | `S`, `S[1]`, `S[2]` each get their own `L` and `T` |
| t168 | POSITIONED S with a bookend | ignored: S holds D1, D2 only |
| t169 | lr-tb S, four 3in items | L is the first item (its own line), T the last |
| t170 | t160 through `<break bookendLeader bookendTrailer>` | identical to t160 |
| t171 | S with breakBefore pageArea leader B, breakAfter trailer A, and a bookend | p2: B 0, S 20 (L 0, D1 20, D2 70, T 120), A 160; E on p3 (p. 364, 366) |
| t172 | `bookend leader="H"`, H an in-flow child of S | the copy `S.H[1]` at 0, the in-flow `S.H` at 30: named after the instances the walk counted |
| t173 | leader naming a `<draw>` | ignored; the trailer is laid |
| t174 | t167 with L and T `occur max="-1"` | identical to t167 |
| t175 | S of L + D1 fits, the trailer does not | T alone on p2: a trailer is ordinary content, with no reservation |
| t176 | TABLE S, bookend rows R and Q | R the first row, Q the last |

## Design

### Template (`xfatemplate.ts`)

- `bookendOf(el)` reads `<bookend leader trailer>`, else the deprecated
  `<break bookendLeader bookendTrailer>`. Each value names ONE target (p. 625);
  several, a SOM expression, an unnamed or `subformSet` target refuse exactly
  as an overflow target does, and an invalid one is ignored with a warning.
- In `walk`, AFTER a subform's children are walked (t172's `H[1]` follows the
  walk's `H[0]`), a bookend on a subform whose layout is `tb`, `lr-tb` or
  `table` -- the root subform included -- is resolved through `specOf` with the
  subform's own home and made at index 0. The leader node is prepended and the
  trailer appended to the subform's layout children, and each copy's fields
  join the walk's `fields` as ordinary fields (not `copyFields`: a bookend is
  always placed). The copy's index is consumed in the scope, so a later
  overflow copy of the same name follows it (unprobed; the natural reading).
- A bookend on a POSITIONED subform is ignored with a warning (t168). A refused
  target becomes a refused child node in its place, so the flow names why.
- A hidden subform's bookend is made all the same: presence hides the subtree.

### Pagination, converter

No change. The leader and trailer are children like any other; break leaders
and trailers already sit outside the subform (t171), and an overflow trailer
is already left off the last fragment (t164).

## Risks

- **One producer, one version, transcribed by hand**, 164g.11's ceiling.
- **Unprobed:** a bookend copy and an overflow copy of the same name in one
  scope (the index order), a bookend on an `rl-tb` or `rl-row` layout, and a
  bookend target that itself states a bookend (it is walked like any subform,
  so it gets its own).

## Testing

- Vendor t160-t176 (`.xml`, `.pdf`, `captures/`, `adobe.json`, SHA-256s, a
  PROVENANCE section) and widen `ADOBE_PROBES`; the existing harness compares
  fields by SOM name and draws by label.
- Unit cases in `test/xfatemplate-bookend.test.ts` for what the probes cannot
  separate: the refusals, the index consumed for a later instance, and the
  positioned warning.
- Fences: every existing oracle unchanged. Mutation sweep, recorded in
  CLAUDE.md.
