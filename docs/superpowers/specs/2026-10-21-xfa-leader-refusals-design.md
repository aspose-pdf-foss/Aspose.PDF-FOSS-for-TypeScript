# XFA: the leader and trailer shapes 164g.15 refused (`164g.31`)

164g.15 refused, by name and as unprobed, every leader or trailer shape its
probes (t73-t90) did not settle. A form using one lost the geometry of every
field it touched. This design lays each down as Adobe Reader does, measured
through 10 new probes (t177-t186).

## Evidence

Adobe Acrobat Reader 26.1, 2026-10-21, 164g.11's pipeline. The oracle field
takes 216pt of the 720pt content area on page 1; `filler` is an unsplittable
positioned block. L and T are positioned subforms 20pt tall, each holding a draw
and a field, `occur max="-1"`, in a `<proto>` inside the root. S2 is a
positioned 50pt subform carrying the break.

| Probe | Shape | Adobe |
|---|---|---|
| t177 | ROOT `<breakBefore targetType="pageArea" leader trailer>` | ignored: no L, no T, one page |
| t178 | the same, `target="P2"` | layout starts on P2; no L, no T |
| t179 | S2 `<breakBefore targetType="auto" leader trailer>` | T at 316, L at 336, S2 at 356, all on page 1: laid in place |
| t180 | S2 `<breakBefore targetType="pageArea" target="P1">` on P1 (does not move) | identical to t179 |
| t181 | S2's break trailer does not fit the 10pt left | T alone at the top of p2; the break then opens p3: L, S2 |
| t182 | S tb (D1 100, S2 with leader/trailer break, D3 100) splits at the break | p1: S holds D1, `S.T` at 100; p2: S holds `S.L` at 0, S2 20, D3 70 |
| t183 | t182, the break bare and S stating `<overflow leader trailer>` | NO overflow leader or trailer at the break |
| t184 | S tb (D1 100, C with `<breakAfter pageArea leader trailer>`), then E | p1: S holds D1, C, `S.T` at 150; p2: an S fragment of `S.L` alone (20pt), E at 20 |
| t185 | keep-none positioned P (h 600) with `<overflow leader trailer>`, 204pt left | P's first fragment is 184 (the trailer reserved); T in the content area's flow below it; p2: L at 0, P at 20 |
| t186 | the overflow on a keep-none positioned CHILD Q inside the split P | ignored: Q splits at the room with no copy and no reservation |

## Rules

- **S1. Start (t177, t178).** A leader or trailer on the break that chooses
  where layout starts is ignored, with a warning.
- **S2. A break that does not move (t179, t180).** Its trailer and then its
  leader are laid in the flow where the break stands. `targetType="auto"`
  never moves, so the template makes its copies SIBLINGS of the breaking
  subform -- trailer then leader before it for a `breakBefore`, after it for a
  `breakAfter` -- named in the parent's scope, the copy index consumed, as
  164g.29 does for a bookend. A parent that is not flowing ignores them, with
  a warning. A break that does not move only in this layout (a target that is
  the current page) is found by `applyBreak`'s dry run, which lays the two in
  place.
- **S3. A trailer that does not fit (t181).** It is ordinary content: the
  region overflows, the trailer opens the next one, and the break applies from
  there.
- **S4. A break inside a split chain (t182, t184).** Its trailer is the last
  leaf of the region the break closes and its leader the first of the region it
  opens, both children of the BREAKING subform's parent -- `flatten` records
  that container per break. A trailing `breakAfter`'s leader makes a fragment
  of its own after the chain's last region (t184).
- **S5. The container's overflow copies at a break (t183).** None: an overflow
  leader or trailer is laid at an OVERFLOW, and a break is not one.
- **S6. A positioned split's trailer (t185).** Reserved in the cut and laid in
  the content area's flow directly below the fragment it closes, mirroring
  164g.15 R6's leader. The last fragment gets none.
- **S7. A positioned child's overflow inside a split positioned subform
  (t186).** Ignored: the child splits with no copies and no reservation.

## Risks

- One producer, one version, transcribed by hand -- 164g.11's ceiling.
- Unprobed: an `auto` `breakAfter` (taken as the mirror of t179), a trailer
  that does not fit inside a split chain (taken as S3), and a non-moving break
  inside a split chain (it closes the fragment, as a bare break already does).

## Testing

Vendor t177-t186 in `test/fixtures/xfa-adobe/` with captures, goldens in
`adobe.json`, SHA-256s and a PROVENANCE section; widen `ADOBE_PROBES`. Unit
cases for what the probes cannot separate. Every existing oracle unchanged;
mutation sweep recorded in CLAUDE.md.
