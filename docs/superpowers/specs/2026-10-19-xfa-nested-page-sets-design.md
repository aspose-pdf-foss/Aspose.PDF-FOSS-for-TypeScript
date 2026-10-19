# XFA nested and sibling page sets (164g.22) — design

## Goal

A dynamic XFA form whose `<pageSet>` holds another `<pageSet>`, or whose root
subform holds more than one, paginates and converts, where `xfatemplate.ts`
refuses it by name today ("more than one pageSet, or a nested one, is not
paginated"). The epic's rule holds: what cannot be laid out is refused by name.

## Sources

XFA Specification 3.3 (SHA-256
`a3344e7ef0b0da445bcce4323e689e646b31b64ecf1c318a8fc98f6b5edca01e`), p. 296-311,
read from the archived copy through our own `GetText`; and Adobe Acrobat Reader
26.1 probes `n1`-`n10` (`test/fixtures/xfa-adobe/`, harness of 164g.9).

| Probe | Shape | Reader |
|---|---|---|
| n1 | Example 8.31: outer max 1 {A max 1, inner max 2 {B max 1, C max 2}}, 10 pages of content | A,B,C,C,B,C,C; the rest discarded |
| n2 | outer {inner max 1 {B max 2}, A max 1}, unlimited | B,B,A,B,B,A,B |
| n3 | outer {A max 1, inner unlimited {B max 1}, C max 1} | A,B,B,B,B -- C never used |
| n4 | Example 8.32: simplex {A first, B rest, C last, duplex {D odd first, E rest, F last}}; 2 S, then 2 T breaking to #D | A,B,**C**,D,**F** |
| n5 | sibling sets, `relevant="simplex -duplex"` first | the first set |
| n6 | two sibling ordered sets, first {A max 1} | A,A,A,A -- the second set is never used |
| n7 | ordered outer {A, inner {B}}; breaks to #B then #A | A,B,A |
| n8 | two simplex sets nested; T x3 breaking to #D (startNew 0), U breaking to #B | A,C,D,E,D,**F (blank)**,C |
| n9 | as n4, both duplex, a blank-only area G in the inner set and H in the outer | A,B,C,**G (filler)**,D,F |
| n10 | n5 with the siblings swapped | the first set (duplex B,C,B,C) |

## Decisions

1. **Siblings: the first page set, always.** Reader does not evaluate
   `relevant` on screen (n5, n10) and never traverses to a later sibling (n6;
   p. 300 says so for occurrence exhaustion). The others are ignored with one
   warning each. No printer-mode option: there is no oracle for what a print
   path would do, and the issue's own premise was that one is needed only to
   choose -- Reader shows there is nothing to choose.
2. **Model: one flat page-area list plus a set tree.** `XfaPageSet.pageAreas`
   stays every page area in document order, so a page's `pageArea` index, the
   masters, break-target resolution and the converter are unchanged. Beside it
   `sets` (root first) holds each set's relation, max, parent and children
   (page areas and sets interleaved in document order); each page area names
   its `set`. A body built without `sets` is one set holding every area, so
   every pre-164g.22 caller is byte-identical by construction.
3. **Ordered nesting is p. 298-300's ascent, verbatim** (n1-n3): another
   instance of the current page area while its max allows; else the next
   sibling of it in its set -- a page area, or a nested set entered as a FRESH
   instance and descended into; else a new instance of the set, its whole
   subtree's counts reset; else ascend to the parent set. The root exhausted
   discards the rest (p. 300).
4. **An ordered break** to a page area forward of the current one opens it,
   entering every set on its path below the common ancestor fresh; one at or
   behind it, or exhausted, takes a new instance of the lowest common ancestor
   that has one left (n7). The single-set rule is the special case.
5. **Qualified nesting** (n4, n8, n9): the natural next page is chosen among
   the CURRENT set's own page areas only -- a nested qualified set is reached
   only by a break (p. 310). `pagePosition` counts pages since the set was
   entered. A break into another set first TERMINATES the set it leaves
   (p. 310-311) by the end-of-document rule of 164g.9: `only` for a one-page
   visit, else `last` when its preconditions hold, else a blank `last` page
   appended (n8). Termination is decided by rerun, as 164g.9's is, one exit at
   a time in document order.
6. **Parity is physical across sets** (n4, n9): a simplex page takes a sheet of
   its own, a duplex page one surface. A filler for a parity conflict is chosen
   from the ENTERED set's areas (n9's G, not the outer H).
7. **Refused by name:** a qualified set nested in an ordered one or the
   reverse (p. 310); a field on a page area of a NESTED set (its master
   instance naming is unprobed -- the page area's draws and chrome are laid
   out); occur `min` on a nested set, as on the root.

## What the probes overruled

164g.9's final review held that a page opened by a break (or by the start)
cannot be redone as `last`, and appended a blank one instead. n8's page 7 is
opened by U's break to B and Reader shows it as C: a page is redone however it
was opened. The two unit cases that encoded the old reading were reversed.

## Not covered

How Reader names a master field in a nested set; a print path; `relevant` on
anything but a page set.
