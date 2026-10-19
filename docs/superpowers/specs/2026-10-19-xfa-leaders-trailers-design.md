# XFA: overflow and break leaders and trailers (`164g.15`)

Since 164g.8, a split chain refuses as soon as a container that states an
`<overflow>` leader, trailer or target is about to continue into a second
region. The template refuses every `breakBefore`/`breakAfter` that names a
leader or trailer, and it does not read the deprecated `<break overflowLeader
overflowTrailer>` at all, so OPM 1644's tables split without their header row
and nothing reports it (164g.12's note). This design inserts leaders and
trailers the way Adobe Reader does, as measured through 18 new probes.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Oracle | **New Adobe Reader probes t73-t90**, using 164g.11's pipeline. Two real forms use the feature: DD 1494's `<overflow leader="heading1">` and OPM 1644's `<break overflowLeader="#HeaderRow_ID_copy1">`. Neither fires in any oracle layout, and none of the ten vendored forms states a trailer, a break leader or trailer, or a `<bookend>`. |
| 2 | Scope | Overflow leaders and trailers (`<overflow>` and the deprecated `<break>` form), plus break leaders and trailers between root children. `<bookend>` is NOT in scope: it is silently ignored today and gets its own issue. An `<overflow target>` stays refused, also under its own issue. |
| 3 | Where a copy's fields live | Each copy is a new FORM instance (t73's `S.H[1].Hf`, t76's `S.L[1].Lf`). It becomes ordinary converted fields named by that instance, with no special case in the converter. |

## Evidence

Adobe Acrobat Reader 26.1, 2026-10-19. As in 164g.14, the oracle field takes
216pt of the 720pt content area on page 1, and "filler" is an unsplittable
positioned block. `D` blocks are draws in a `tb` subform `S`. L and T are
positioned subforms 20pt tall, H is 30pt. `p1`/`p2` are pages, and offsets are
relative to `S`'s fragment.

| Probe | Template | Adobe |
|---|---|---|
| t73 | filler 400; S tb `<overflow leader="H">`, children H (no occur), D1 50, D2-D5 300 | p2: H[1] at 0, D2 at 30; p3: no leader. `S.H[1].Hf` is a FORM field |
| t74, t75 | proto at TEMPLATE level, trailer / leader + trailer by `#id` | ignored: no leader, no trailer, no reservation |
| t88 | t75 with the proto inside the root subform | p1: D1 0, T 100 (reserved: D2 would fit without T); p2: L 0, D2-D8 20-620, no trailer (T's default max 1 spent); p3: no leader |
| t76 | t88 with `occur max="-1"`, a field in L | p1: D1, T; p2: L, D2-D7, T[1] at 620; p3: L[1], D8-D10, no trailer (last fragment). `S.L[1].Lf` |
| t77 | table, header row Hdr `occur max -1` as `<overflow leader="#Hdr_ID">`, rows 40 | p2: Hdr[1] at 0, r2 at 30 |
| t78 | t77 with `<break overflowLeader>` | identical to t77 |
| t79 | A tb `<overflow leader>` holding a0 20 and B tb (D 50 x6), B splits | p2: L at the top of B's fragment (D2 at 20 in B), named `A.L` |
| t80 | t79, B states `<overflow leader="">` | no leader |
| t81 | `<overflow trailer="#X_ID #Y_ID #X_ID">`, X and Y max 1, D 100 x16 | p1 X, p2 Y, p3 **X[1]**, p4 none |
| t82 | S tb trailer (max -1) holding a 130pt 10-line field | p1: f head 84 (= 104 - 20), T at 84; p2: f 46 |
| t83 | keep-none positioned P (h 300) `<overflow leader>` | p2: L at 0 in the CONTENT AREA, P's continuation at 20 |
| t84 | lr-tb S of eight 3in x 50 items, leader | p2: L at 0, items from 20 |
| t85 | root child S2 `<breakBefore pageArea leader trailer>` | p1: **T** at 616; p2: **L** at 0, S2 at 20 |
| t86 | S2 `<breakAfter pageArea leader trailer>`, then E | p1: S2, **T** at 666; p2: **L** at 0, E at 20 |
| t87 | t73 with H `occur max="-1"` | H[1] p2, H[2] p3 |
| t89 | S (D1 50, D2 50 = 100) with a trailer, 104pt left | SPLIT: p1 D1, T at 50; p2 D2 |
| t90 | leader naming a draw | ignored |

## Design

### 1. The rules

- **R1. Targets (t74, t75, t88, t90).** A leader or trailer value is a
  space-separated list of targets. `#id` names an element anywhere under the
  ROOT subform, `<proto>` elements included. A target that is missing, is not a
  `<subform>`, or sits only in a template-level `<proto>` is IGNORED with a
  warning, as Adobe ignores it (p. 323). A bare name is a SOM name. It is
  resolved as a named subform child of the asserting container, then of each
  ancestor in turn, nearest first. DD 1494's `heading1` is one of these. Any
  other SOM expression, or a name that resolves to nothing, is UNRESOLVED,
  and a split that would insert it refuses by name. We do not resolve SOM, so
  we cannot claim that Adobe ignores it.
- **R2. Counts (t73, t76, t81, t87, t88).** A target's `<occur max>` limits
  its copies. An absent `occur` means max **1**, so a Designer header with no
  `occur` repeats once (t73), and -1 means no limit. The count is kept per
  list ENTRY (t81: `#X #Y #X` lays X, Y, then X again). This overrules p.
  322's per-target count. Counts belong to the asserting subform, and an
  inherited copy counts against the ancestor that asserted it (p. 323).
- **R3. Inheritance (t79, t80; p. 323-325).** A subform that states no
  leader (or no trailer) inherits its nearest asserting ancestor's.
  `leader=""` blocks inheritance. When the nearest asserting ancestor's
  entries are spent, the next one out is used (p. 325, unprobed). Leaders and
  trailers are inherited independently.
- **R4. Leader placement (t73, t77, t79, t84).** When a split chain continues
  into a new region, the leader of the innermost continuing container is
  placed as the FIRST child of that container's new fragment. That leader is
  the container's own or an inherited one. The innermost continuing container
  is the deepest container common to the last leaf placed and the next one. A
  table header copy is a row. An lr-tb leader is the first item.
- **R5. Trailer placement and reservation (t76, t81, t82, t88, t89).** When a
  region closes and the chain continues, the trailer of the innermost
  continuing container is appended as the LAST child of the closing fragment.
  While a trailer is available, every fit test reserves its height. This
  includes the chain's LAST leaf, so content that would fit whole splits
  (t89, Example 8.40). It also includes the root fit test of a splittable root
  child, and a field cut's room (t82). The last fragment gets no trailer.
- **R6. Positioned split (t83).** A keep-none positioned subform (164g.11)
  places its leader in the CONTENT AREA's flow, directly above its
  continuation. A positioned split with a TRAILER is unprobed and refuses by
  name.
- **R7. Break leaders and trailers (t85, t86): Adobe SWAPS the spec's roles.**
  Example 8.36 places the leader before the break and the trailer after it.
  Adobe does the reverse: the TRAILER goes into the current region BEFORE the
  break, and the LEADER into the new region AFTER it. This holds for
  `breakBefore` and `breakAfter` alike. Both are placed in the content area's
  flow between root children. The following shapes are unprobed and refuse by
  name: a break leader or trailer inside a split chain, on the break that
  chooses where layout STARTS, on a break that does not move, and a break
  trailer that does not fit the region it closes.
- **R8. Naming (t73, t76, t81, t85).** A copy is a new form instance. An
  overflow copy is a child of the ASSERTING subform (`S.L`, `A.L`). A break
  copy is a child of the breaking subform's PARENT (`form1.T`). Its index
  continues the name's count in that scope: `H[1]` after the in-flow `H[0]`,
  and `L[0]`, `L[1]` for a proto subform. Its data path is built the same way,
  so its fields bind like any instance.

### 2. Template (`xfatemplate.ts`)

- `LayoutNode.overflow` becomes an `XfaOverflow` model, no longer a boolean:
  `{ leader?: XfaCopySpec[]; trailer?: XfaCopySpec[]; target?: string }`. An
  absent list inherits and an EMPTY list blocks. It is read from `<overflow>`,
  or else from the deprecated `<break overflowLeader overflowTrailer>`.
- `XfaBreak` gains `leader?` and `trailer?`, as `XfaCopySpec`. The 164g.15
  refusal in `breakOf` is removed.
- `XfaCopySpec`: `{ label; max; scope: object; make(index): LayoutNode }`, or
  `{ label; refusal }` for an unresolved target. `make` walks the target as
  ONE instance with the given index under the captured scope. It is PURE and
  never mutates the walk's counters, so pagination may rerun freely.
  `XfaTemplate.copyFields(node)` returns the copy's `XfaField`s.
- A target's `scope` is the `IndexScope` of the asserting subform (overflow)
  or of its parent (break). The index base is read when `make` is called,
  after the walk has finished counting.

### 3. Pagination (`xfapage.ts`)

- `Paginator` gains copy state, which is saved and restored by
  `snapshot`/`restore`: entry counts keyed by `(spec, entry)`, copy indices
  keyed by `(scope, name)`, and the copies made. `Pagination.copies` lists the
  copy roots placed.
- `effectiveCopy(kind, path)` implements R2 and R3 over a leaf's container
  path, innermost first, and then the root subform.
- `placeSplit`: R4 prepends the leader leaf to the first region after a cut.
  R5 reserves the trailer in the fit test and in `straddle`'s room, and
  appends it at a continuing close. In a truly EMPTY region where the
  reservation alone stops the first leaf fitting, the leaf is taken without
  the reservation. That region then gets a trailer only if one still fits,
  with a warning otherwise. 164g.8's `continues` refusal remains only for
  `overflow.target`.
- Root loop: a splittable root child with an available trailer fits whole
  only with the trailer's height added (t89). `placePositioned`: R6.
- `apply` callers at the root: R7 places the trailer, applies the break, then
  places the leader. Each copy is measured by the same `height` callback.

### 4. Converter (`xfaconvert.ts`)

The fields of every placed copy (`layoutPages` returns `copies`, mapped
through `tpl.copyFields`) join `tpl.fields` for planning. They are named,
bound and placed like any field. Copy draws paint as chrome through the
existing `PlacedNode`s.

## Risks

- **The oracle is one producer, one version, transcribed by hand**, the same
  ceiling as 164g.11. Every probe uses draws, plus one field in a leader.
- **R2's per-entry count and R7's swapped roles both contradict the spec.**
  Each rests on one probe (t81; t85 and t86).
- **Inheritance past a spent ancestor (p. 325) is unprobed.**

## Testing

- Vendor t73-t90 in `test/fixtures/xfa-adobe/`: `.xml`, `.pdf`, `captures/`,
  `adobe.json`, SHA-256s and a PROVENANCE section. t74, t75 and t90 are
  matched as "ignored". `test/xfa-adobe-oracle.test.ts` learns SOM names that
  carry their own index (`H[1]`), and a `layoutParent` for t83, whose leader
  is placed outside the subform it is named under.
- Unit cases (`test/xfapage-leaders.test.ts`, `test/xfatemplate.test.ts`) for
  what the probes cannot separate: inheritance past a spent ancestor, the
  empty-region reservation fallback, and every refusal in R1, R6 and R7.
- Fences: every existing oracle must not move (`xfa-real`, `xfa-adobe`,
  `xfa-dynamic`, `xfa-master`, qualified, chrome fence).
- Mutation sweep, recorded in CLAUDE.md.

## Child issues

`164g.29` `<bookend>` leaders and trailers; `164g.30` `<overflow target>`;
`164g.31` the refusals in R1's unresolved SOM aside, R6 and R7.
