# XFA `<overflow target>`: continue an overflow in a named area (164g.30)

## Intent

`<overflow target="…">` names the content area or page area a container
continues in when it overflows, in place of the one pagination would reach
next (XFA 3.3 p. 366-367, p. 791; the deprecated `<break overflowTarget>`,
p. 634). 164g.15 implemented overflow leaders and trailers but REFUSES, by
name, any split whose continuing container states a target (`targetRefusal`)
— so every field below such a container loses its geometry. This makes the
target take effect, the way Adobe Reader 26.1 lays it out.

## Sources

- XFA Specification 3.3 (`xfa_spec_3_3.pdf`, SHA-256
  `a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`):
  "Break on Overflow", p. 366-367 (Example 9.28; error condition "Invalid
  break target"); the `overflow` element, p. 791; `overflowTarget`, p. 634.
- 17 Adobe Reader probes, t143-t159, built by
  `scripts/gen-xfa-adobe-probes.ts` and run by
  `scripts/run-xfa-adobe-probe.ps1` on 2026-10-21 (captures read by hand).
  The generator gained one hook for them: an `<overflow …/>` followed by
  `<!-- root -->` goes on the ROOT subform.

Every probe uses one of two page sets: P1 = { C1 (5in, 360pt, 144pt left on
page 1 after the 3in oracle), C2 (3in, 216pt) } with P2 = { F (10in) }; or
P1 = { C1 } with P2 = { G1 (2.5in), G2 (5in) }. Content is 72pt draws.

## What Reader does (each rule names its probes)

**R1 — the target replaces the natural next region (t143, Example 9.28).** A
root target `#F` sends S's continuation to F on a P2 page; C2, the natural
next, is never used.

**R2 — it governs EVERY overflow of the container stating it, not just the
first (t144, t149, t150, t153).** Under a root target `#C1` all four pages are
C1 only. That holds for a split subform's continuations, for a root child that
does not fit and moves whole (t150, root draws; t153, e3), and for a root field
split by 164g.27 (t153).

**R3 — a content-area target is a content-area break with `startNew`
(t144, t157).** A target later on the current page is reached on this page
(t157: C1 → C2 on page 1); the current content area, or an earlier one, is
reached on a NEW page (t144: C1 → C1 of page 2; t157: C2 → C2 of the next
page, C1 skipped). That is exactly `Paginator.apply` for
`targetType="contentArea"` with `startNew`.

**R4 — a page-area target opens a NEW page of it every time, at its first
content area (t147).** Under `#P2` each overflow starts a new P2 page in G1;
G2 is never used. `Paginator.apply` for `targetType="pageArea"` with
`startNew`.

**R5 — scoped and inherited like a leader (t145, t146, t158).** The target in
force is that of the INNERMOST continuing container stating one, the root
last: a subform's own target holds only while IT continues (t145: the
following N overflows naturally into C2), a descendant inherits it (t146), and
a stated EMPTY `target=""` BLOCKS inheritance — S with `target=""` under a
root `#C1` overflows naturally into C2 (t158). (p. 366 calls the empty string
"no effect"; Reader reads it as no effect on S, i.e. natural, which is the
block.) An absent target inherits.

**R6 — a positioned subform's OWN target is ignored; an inherited one is not
(t151, t159).** A keep-none positioned subform with `<overflow target="#C1"/>`
splits into C2 exactly as the no-target control does (t151 = t154); the same
subform under a ROOT `#C1` follows the root's (t159). Its own leaders are still
its own (164g.15 R6, t83) — the asymmetry is measured, not chosen.

**R7 — a target naming nothing opens a new page (t148).** p. 367 recommends a
warning and "the next available pageArea or contentArea". Reader goes to the
next PAGE every time — C2 is never used, where the no-target control (t154)
uses it. We warn and do the same. A bare name resolves like `#id` against
`name` (t149); a SOM expression we do not resolve (one containing `.`, `[`,
…) and a value naming more than one area — two content areas, or a content
area and a page area — are treated as naming nothing, with the warning.

**R8 — a leader follows the target (t152, t155, t156).** A root or subform
leader opens the target region exactly as it opens a natural one (164g.15 R4),
whether the target is the root's or S's own. (Note: the first t152/t155/t156
runs put the leader's `<proto>` at template level, which Reader ignores
(164g.15 R1, t74/t75); the vendored ones put it in the root.)

## Design

- **`xfatemplate.ts` `overflowOf`:** keep a STATED target even when blank, as
  `target: ''` (R5's block). Absent stays absent. The legacy `overflowTarget`
  attribute is read the same way.
- **`XfaOverflow.target`:** documented as `''` = stated blank, which blocks
  inheritance; otherwise an id (`#x`), a name, or a SOM expression.
- **`xfapage.ts`: one owner for "where does an overflow go".** A
  `Paginator.overflow(path)` replaces every `p.advance()` that moves content
  because it does not fit, and every probe of the next region's capacity
  (`nextCapacity`, `keepWith`, `fitsNextEmpty`):
  1. the effective target is the innermost of `[root, ...path]` whose
     `overflow.target` is defined;
  2. none, or `''` → `advance()` (today's behaviour, unchanged);
  3. otherwise resolve against BOTH content areas and page areas (no
     `targetType` on overflow, p. 366): exactly one content area →
     `apply({ targetType: 'contentArea', target, startNew: true })`; exactly
     one page area → `apply({ targetType: 'pageArea', … startNew: true })`;
     anything else → warn once and `nextPage()` (R7).
  Explicit breaks keep `apply`; they are not overflows.
- **The paths.** Root-loop moves (a child that does not fit, `keepWith`'s
  advance, `emptyRegion`'s advance, `rootFieldPiece`'s continuation) pass `[]`
  — the root's target (R2). `placeSplit`'s `continueTo` passes the common path
  it already computes; when the region holds nothing visible it passes the
  path of the last continuation in this call, else `[]` (the child has not
  begun, so only the root overflows). `placePositioned` passes `[]` — its own
  target excluded (R6). A positioned subform split inside a tb chain is a
  LEAF, so its own target is never in a path either.
- **`targetRefusal` goes**, and `rootFieldPiece` no longer refuses on a root
  target (it keeps its leader/trailer guard, unprobed for a root field).
- **Warnings:** the Paginator gets the run's `warn` sink; a rerun or snapshot
  probe repeating a warning is harmless, `warn` dedupes.

## The oracle

`test/fixtures/xfa-adobe/adobe-target.json`: per probe, the page area of each
page (read from `areas=`) and every draw's and field's fragments as
`[page, pageY, h]`, pageY being the top in PAGE coordinates from the top edge,
derived from the reported y, the parent fragment, and the content area's
origin. Derived rather than read because Reader's `pageSpan` counts pages, so
a fragment in C2 is reported under the next page number (the t67 trap); each
draw's own `xfa.layout.page` is reliable and fixes which page, and y within the
parent's fragment fixes which content area. `test/xfa-adobe-target-oracle.test.ts`
lays each probe out through `layoutPages` and compares. t154 (no target) and
t155 (leader only) are the controls.

## Non-goals

- Resolving SOM-expression targets (R7 treats one as naming nothing).
- A target on a non-subform, `<subformSet>` targets.
- Trailers combined with a target: no probe; the existing trailer logic runs
  unchanged before the move.
- A root field split under a root leader or trailer (164g.27's guard stays).

## Calls I made (not settled by a probe)

- `keepWith`'s and `emptyRegion`'s advances count as overflows (R2 covers a
  child that does not fit; adhesion moving a pair is the same move).
- A value naming both a content area and a page area is "naming nothing".
- `fitsNextEmpty` and `nextCapacity` probe the TARGET region, so adhesion and
  p. 295 decide against where content would actually go.
