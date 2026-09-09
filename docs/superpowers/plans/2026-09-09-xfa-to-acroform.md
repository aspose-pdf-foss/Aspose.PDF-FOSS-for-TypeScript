# XFA read and flatten to AcroForm (`6t2v.3`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `doc.ConvertXfaToAcroForm()` turns an XFA form's `template` and
`datasets` packets into a real `/AcroForm` field tree — widgets with rects and
appearance streams wherever the template's layout chain is positioned
throughout, geometry-less field dicts everywhere else — and returns a report
naming everything that did not convert.

**Architecture:** Five new modules on this repo's usual split. Four are pure —
`xfageom.ts` (imports nothing), `xfatemplate.ts` and `xfadata.ts` (import
`xml.js` alone), `xfapacket.ts` (takes `resolve`/`inflate` as arguments, the
`colorimage.ts` seam) — and `xfaconvert.ts` alone touches a `Document`.
Conversion plans fully before it allocates anything, then applies: positioned
fields go through the existing `createField` / `addRadioGroup`, so widget dicts,
`/AP` generation and `/Annots` wiring are reused rather than rewritten.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers),
vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-xfa-to-acroform-design.md` — read
it alongside this plan. The spec is frozen; where this plan resolves one of its
"Open questions for the implementation plan" it says so under *Interpretations*
below.

---

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension
  (`import { parseXml } from './xml.js'`).
- **`strict` TypeScript.** `npm run typecheck` must be green before any commit.
- **TDD.** Write the failing test, run it and watch it fail, implement the
  minimum, run it and watch it pass, commit. Every task follows that cycle.
- **Never an approximate rect.** Every geometry failure — an unknown unit, a
  flowed ancestor, a medium mismatch, a `rotate`, an unresolvable page — yields
  a **geometry-less field plus a report entry**. There is no fallback that
  estimates a position from a sibling, a caption or a flow order. A field drawn
  in the wrong place looks right and is wrong.
- **Do not guess a unit.** `px`, `pc` and `em` ship **refused** (see
  *Interpretations*). Do not implement one from memory; only a transcription
  with the XFA clause cited in a code comment may add one.
- **Plan fully, then apply.** `xfaconvert.ts` allocates nothing until the whole
  plan is built. A form we cannot convert leaves the file byte-identical.
- **Exactly one throw:** `UnsupportedFeatureError` on a signed document.
  Everything else is a value on the report.
- **The fence:** `test/form-create.test.ts`, `test/form.test.ts`,
  `test/pdfaconvert.test.ts`, `test/pdfavalidate.test.ts`, `test/pdfx-real.test.ts`
  and `test/drprune.test.ts` must stay green **unedited**. This feature adds a
  method and five modules; it changes no existing behaviour. `git diff` on those
  files must be empty.
- **`CHANGELOG.md` is updated in the same commit as the user-visible change**
  (repo `CLAUDE.md`): a bold lead-in, then prose saying what it does, why the
  design went that way, and what was measured, with `(6t2v.3)` at the end.
- **Issue tracking is `bd`**, never TodoWrite or a markdown checklist. Run
  `bd prime` for the command reference.
- **Commit message style:** `feat(6t2v.3): <subject>` / `test(6t2v.3): …` /
  `docs(6t2v.3): …`, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **There is no runnable oracle.** No second XFA implementation arbitrates our
  output. The hybrid comparison in Task 11 is strong evidence for the forms it
  covers and nothing more; every document you write must say so.

---

## Interpretations this plan adds, and why

The spec closes with three open questions and leaves one term undefined. Each is
resolved here so that no task contains an unmade decision.

**1. `px` / `pc` / `em` are refused, not implemented.** The spec requires their
reading to be "transcribed from the XFA specification with the clause cited …
rather than guessed at". The XFA 3.3 specification is not vendored in this repo
and the suite has no network. So `measureToPt` implements `in`, `pt`, `cm` and
`mm` — each an unambiguous SI or typographic conversion — and returns
`undefined` for every other unit, which degrades the field and reports
`unsupported unit 'px'`. That is complete, shipped, testable behaviour and it
obeys *never an approximate rect*. If and only if you can cite the clause, a
follow-up commit may add the unit with the clause in a comment beside the
constant. `pc = 12pt` is *probably* right, and that is exactly why it must not
ship on recall alone.

**2. "The chain" starts at the page-owning container, not at the document
root.** The spec says a field earns geometry only when "every ancestor in its
chain is `layout="position"`", without defining where the chain begins.
LiveCycle's own output makes this decisive: its root `<subform>` — the one
carrying the `<pageSet>` — is routinely `layout="tb"`, because that flow is what
breaks pages, not what places fields. Read as starting at the document root, the
rule degrades every field of every LiveCycle form and the feature converts
nothing. So the chain is defined as **the containers between the field and its
page origin, exclusive of the subform that carries the `<pageSet>`**: a
container above the page origin contributes no in-page position, so its layout
governs pagination rather than placement. The spec's rule is then applied
verbatim to that chain. Task 4 builds the chain; Task 11's oracle is what
confirms the reading against a real form, and if it disagrees the answer is to
degrade, never to loosen the rule.

**3. `<occur>` with `max != 1` is flow-laid.** The spec's expected answer,
adopted: occurrence *count* is knowable from `initial`, but the repeat
*direction* is not, so a repeating subform contributes a synthetic `'occur'`
entry to the layout chain and every field under it degrades. Confirm against the
real fixture in Task 11 and record the finding either way.

**4. A bare field is appended through `resolvePath(...).container.push(ref)`,
not `appendField`.** The spec names `appendField`, which appends to
`/AcroForm /Fields` directly — correct only for a top-level name. A SOM path is
always hierarchical (`form1[0].Page1[0].f1_01[0]`), so the field must land in
the container `resolvePath` resolves, which is what `createField` itself does
(`formcreate.ts:344`, `formcreate.ts:362`). `ensureAcroForm` is still called
first.

**5. An `<exclGroup>` is all-or-nothing.** If any member of a radio group lacks
geometry, the **whole group** goes bare. A group with some widgets placed and
some not is not a degraded rendering, it is a broken control.

---

## File structure

| File | Responsibility |
|---|---|
| Create `src/xfageom.ts` | Pure arithmetic, imports **nothing**: measurements to points, anchor shift, offset accumulation, the y-flip, medium-versus-CropBox, the positioned-chain predicate. |
| Create `src/xfatemplate.ts` | Pure over `xml.js`: the `template` packet to `XfaField[]` + `XfaPageArea[]` — SOM names, UI kinds, items, flags, defaults, tooltips, raw geometry strings, the layout chain. |
| Create `src/xfadata.ts` | Pure over `xml.js`: the `datasets` packet to values by SOM-shaped data path, and the template↔data join. |
| Create `src/xfapacket.ts` | `/AcroForm /XFA` (single XDP stream, or the alternating name/stream array) to named, parsed packets. Takes `resolve`/`inflate`; owns the `parseXml` throw boundary. |
| Create `src/xfaconvert.ts` | The only module here that touches a `Document`. Plan, then apply. Owns the report types. |
| Modify `src/document.ts` | One method, `ConvertXfaToAcroForm`, delegating. |
| Modify `src/index.ts` | Export the entry point's option and report types only. |
| Create `test/helpers/build-xfa-pdf.ts` | Builders for the rule matrix. |
| Create `test/xfageom.test.ts`, `test/xfatemplate.test.ts`, `test/xfadata.test.ts`, `test/xfapacket.test.ts`, `test/xfaconvert.test.ts`, `test/xfa-real.test.ts` | One per module, plus the vendored-fixture oracle. |
| Create `test/fixtures/xfa/PROVENANCE.md` and its fixtures | The hybrid oracle and its stated ceiling. |
| Modify `README.md`, `CHANGELOG.md`, `CLAUDE.md` | Public surface, upgrade note, module entries. |

---

### Task 1: `xfageom.ts` — measurements, anchors and the y-flip

**Files:**
- Create: `src/xfageom.ts`
- Test: `test/xfageom.test.ts`

**Interfaces:**
- Consumes: nothing. This module imports **nothing at all** — that is its whole
  point, the `floatstack.ts` / `booklet.ts` / `tablespan.ts` split.
- Produces:
  - `type XfaAnchor = 'topLeft' | 'topCenter' | 'topRight' | 'middleLeft' | 'middleCenter' | 'middleRight' | 'bottomLeft' | 'bottomCenter' | 'bottomRight'`
  - `const XFA_ANCHORS: readonly XfaAnchor[]`
  - `interface XfaBox { x: number; y: number; w: number; h: number }` (points, XFA top-left / y-down frame)
  - `function measureToPt(s: string | undefined): number | undefined`
  - `function anchorShift(anchor: string | undefined, w: number, h: number): { dx: number; dy: number } | undefined`
  - `function rectFromBox(box: XfaBox, crop: readonly number[]): [number, number, number, number]`

- [ ] **Step 1: Write the failing test**

Create `test/xfageom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  measureToPt, anchorShift, rectFromBox, XFA_ANCHORS,
} from '../src/xfageom.js';

describe('measureToPt', () => {
  it('converts the four unambiguous units', () => {
    expect(measureToPt('1in')).toBeCloseTo(72, 9);
    expect(measureToPt('12pt')).toBeCloseTo(12, 9);
    expect(measureToPt('2.54cm')).toBeCloseTo(72, 9);
    expect(measureToPt('25.4mm')).toBeCloseTo(72, 9);
  });

  it('accepts a sign, a leading dot and whitespace around the unit', () => {
    expect(measureToPt('-0.5in')).toBeCloseTo(-36, 9);
    expect(measureToPt('  .5 in ')).toBeCloseTo(36, 9);
    expect(measureToPt('+1in')).toBeCloseTo(72, 9);
  });

  it('reads a bare number as points, which is the XFA default', () => {
    expect(measureToPt('18')).toBeCloseTo(18, 9);
  });

  // The Global Constraint: px/pc/em are refused, never guessed. A wrong px
  // reading moves an A4 edge by tens of points and still renders a plausible
  // page, so the honest answer is to decline the field entirely.
  it('refuses px, pc and em rather than guessing a conversion', () => {
    expect(measureToPt('10px')).toBeUndefined();
    expect(measureToPt('1pc')).toBeUndefined();
    expect(measureToPt('2em')).toBeUndefined();
  });

  it('refuses junk, an empty string and undefined', () => {
    expect(measureToPt('wide')).toBeUndefined();
    expect(measureToPt('1furlong')).toBeUndefined();
    expect(measureToPt('')).toBeUndefined();
    expect(measureToPt(undefined)).toBeUndefined();
    expect(measureToPt('Infinity')).toBeUndefined();
  });
});

describe('anchorShift', () => {
  it('defaults to topLeft, which shifts nothing', () => {
    expect(anchorShift(undefined, 100, 40)).toEqual({ dx: 0, dy: 0 });
    expect(anchorShift('topLeft', 100, 40)).toEqual({ dx: 0, dy: 0 });
  });

  // x/y NAME the anchor point, so the top-left corner is found by moving
  // BACK from it -- both deltas negative, never positive.
  it('moves back by half for a centre and by all for a far edge', () => {
    expect(anchorShift('middleCenter', 100, 40)).toEqual({ dx: -50, dy: -20 });
    expect(anchorShift('bottomRight', 100, 40)).toEqual({ dx: -100, dy: -40 });
    expect(anchorShift('topRight', 100, 40)).toEqual({ dx: -100, dy: 0 });
    expect(anchorShift('bottomLeft', 100, 40)).toEqual({ dx: 0, dy: -40 });
    expect(anchorShift('middleLeft', 100, 40)).toEqual({ dx: 0, dy: -20 });
    expect(anchorShift('topCenter', 100, 40)).toEqual({ dx: -50, dy: 0 });
  });

  it('covers all nine anchors and refuses anything else', () => {
    expect(XFA_ANCHORS).toHaveLength(9);
    for (const a of XFA_ANCHORS) expect(anchorShift(a, 10, 10)).toBeDefined();
    expect(anchorShift('centre', 10, 10)).toBeUndefined();
  });
});

describe('rectFromBox', () => {
  // The y-flip. A CropBox with a non-zero origin and a box near the TOP of
  // the page: the rect's ury must be just below cropTop, never just above
  // cropBottom -- the two readings agree only for a box at the page centre.
  it('flips y against the CropBox top and offsets by its origin', () => {
    const crop = [10, 20, 622, 812]; // 612 x 792, origin (10, 20)
    expect(rectFromBox({ x: 72, y: 36, w: 144, h: 18 }, crop))
      .toEqual([82, 758, 226, 776]);
  });

  it('places a box at the page top near ury, not near lly', () => {
    const crop = [0, 0, 612, 792];
    const [, lly, , ury] = rectFromBox({ x: 0, y: 0, w: 10, h: 10 }, crop);
    expect(ury).toBe(792);
    expect(lly).toBe(782);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfageom.test.ts`
Expected: FAIL — `Failed to resolve import "../src/xfageom.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/xfageom.ts`:

```ts
/**
 * XFA geometry, as pure arithmetic over numbers and the template's own
 * attribute strings.
 *
 * **Invariant: it imports NOTHING.** No `Document`, no PDF object, no `node:`
 * module -- the split `floatstack.ts`, `booklet.ts`, `tablespan.ts` and
 * `docinfer.ts` each already make, for their reason: geometry that is silently
 * wrong when reversed must be testable from numbers with no PDF built.
 *
 * **Invariant: it never throws.** Every failure is `undefined`, which the
 * caller turns into a geometry-less field plus a report entry.
 */

/** Points per unit, for the units whose conversion is unambiguous.
 *
 *  **`px`, `pc` and `em` are deliberately ABSENT and must stay absent until
 *  someone transcribes the XFA specification's own definition with the clause
 *  cited here.** `pc` is very probably 12pt and `px` very probably depends on
 *  an assumed resolution -- "very probably" is exactly the standard this repo
 *  refuses for a number that silently misplaces every field on a page. `em` is
 *  relative to a font size this leaf has no access to by construction. */
const UNIT_PT: Record<string, number> = {
  in: 72,
  pt: 1,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
};

/** A number, optionally signed, optionally fractional, optionally followed by
 *  a unit. XFA writes `1in`, `-0.5in`, `.25in` and a bare `18` alike. */
const MEASURE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([A-Za-z]*)\s*$/;

/** An XFA measurement in points, or `undefined` when it cannot be read for
 *  certain -- junk, or a unit we decline to guess at. A bare number is points,
 *  which is XFA's own default unit. */
export function measureToPt(s: string | undefined): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = MEASURE.exec(s);
  if (!m) return undefined;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return undefined;
  const unit = m[2] === '' ? 'pt' : m[2].toLowerCase();
  const scale = UNIT_PT[unit];
  return scale === undefined ? undefined : v * scale;
}

export type XfaAnchor =
  | 'topLeft' | 'topCenter' | 'topRight'
  | 'middleLeft' | 'middleCenter' | 'middleRight'
  | 'bottomLeft' | 'bottomCenter' | 'bottomRight';

export const XFA_ANCHORS: readonly XfaAnchor[] = [
  'topLeft', 'topCenter', 'topRight',
  'middleLeft', 'middleCenter', 'middleRight',
  'bottomLeft', 'bottomCenter', 'bottomRight',
];

/** A box in XFA's frame: origin top-left, y increasing DOWNWARD, in points. */
export interface XfaBox { x: number; y: number; w: number; h: number }

/** How far to move from the stated `x`/`y` to reach the box's TOP-LEFT corner.
 *
 *  `anchorType` says what `x`/`y` NAMES, so the corner is always found by
 *  moving back from it -- every delta is zero or negative, never positive.
 *  `undefined` for a value outside the nine, which degrades the field. */
export function anchorShift(
  anchor: string | undefined, w: number, h: number,
): { dx: number; dy: number } | undefined {
  const a = anchor ?? 'topLeft';
  if (!(XFA_ANCHORS as readonly string[]).includes(a)) return undefined;
  const dx = a.endsWith('Center') ? -w / 2 : a.endsWith('Right') ? -w : 0;
  const dy = a.startsWith('middle') ? -h / 2 : a.startsWith('bottom') ? -h : 0;
  return { dx, dy };
}

/** An XFA box to an annotation `/Rect` in default user space.
 *
 *  `/Rotate` needs no handling: an annotation rect is in UNROTATED default user
 *  space and the viewer applies the page rotation, which is the rule this
 *  library already states for annotation coordinates. */
export function rectFromBox(
  box: XfaBox, crop: readonly number[],
): [number, number, number, number] {
  const llx = crop[0] + box.x;
  const ury = crop[3] - box.y;
  return [llx, ury - box.h, llx + box.w, ury];
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/xfageom.test.ts` — Expected: PASS, 9 cases.
Run: `npm run typecheck` — Expected: no output, exit 0.

- [ ] **Step 5: Prove the y-flip assertion is load-bearing**

Temporarily change `rectFromBox`'s `ury` line to `const ury = crop[1] + box.y;`.
Run `npx vitest run test/xfageom.test.ts`. Expected: both `rectFromBox` cases go
RED. Revert, re-run, confirm green. Record the count in the commit message.

- [ ] **Step 6: Commit**

Write the commit message to a file rather than inlining a heredoc:

```bash
git add src/xfageom.ts test/xfageom.test.ts
git commit -F docs/superpowers/.commitmsg
```

with `docs/superpowers/.commitmsg` (delete it after committing) holding:

```
feat(6t2v.3): XFA measurements, anchor resolution and the y-flip

xfageom.ts is the pure arithmetic leaf: measurements to points, the nine
anchorType shifts, and an XFA top-left box to an annotation /Rect. It imports
NOTHING, so every rule here is drivable from numbers with no PDF built.

px, pc and em are REFUSED rather than converted. Their readings are not
transcribed from the XFA specification here, and a wrong px moves an A4 edge by
tens of points while still rendering a plausible page -- so the honest answer is
to decline the field and report it, which is the design's "never an approximate
rect".

Measured: reversing the y-flip reddens both rectFromBox cases. Its fixture puts
the box near the page TOP with a non-zero CropBox origin, because the two
readings agree exactly for a box at the page centre.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 2: `xfageom.ts` — the medium check, the chain rule and offset accumulation

The correctness anchor of the whole feature. The medium comparison asserts
against a number **we did not compute** — the page's own CropBox — so one
comparison catches a unit-conversion error, an orientation swap and a wrong page
mapping alike.

**Files:**
- Modify: `src/xfageom.ts`
- Test: `test/xfageom.test.ts` (append two `describe` blocks; the Task 1 cases
  stay green unedited)

**Interfaces:**
- Consumes: `XfaBox`, `measureToPt`, `anchorShift`, `rectFromBox` from Task 1.
- Produces:
  - `interface XfaMedium { short?: string; long?: string; orientation?: string }`
  - `function mediumSizePt(m: XfaMedium | undefined): { w: number; h: number } | undefined`
  - `const MEDIUM_TOLERANCE_PT = 1`
  - `function mediumAgrees(m: XfaMedium | undefined, crop: readonly number[]): boolean`
  - `interface XfaOffset { x?: string; y?: string }`
  - `function accumulateOrigin(offsets: readonly XfaOffset[]): { x: number; y: number } | undefined`
  - `function chainIsPositioned(layouts: readonly string[]): boolean`
  - `function boxFor(own: { x?: string; y?: string; w?: string; h?: string; anchorType?: string; rotate?: string }, offsets: readonly XfaOffset[]): XfaBox | { reason: string }`

- [ ] **Step 1: Write the failing test**

Append to `test/xfageom.test.ts`:

```ts
import {
  mediumSizePt, mediumAgrees, accumulateOrigin, chainIsPositioned, boxFor,
  MEDIUM_TOLERANCE_PT,
} from '../src/xfageom.js';

describe('mediumSizePt / mediumAgrees', () => {
  const usLetter = [0, 0, 612, 792];

  it('reads a portrait medium as short x long', () => {
    expect(mediumSizePt({ short: '8.5in', long: '11in' }))
      .toEqual({ w: 612, h: 792 });
  });

  // The swap is the whole reason orientation is read at all, and a square
  // medium could not tell the two readings apart.
  it('swaps short and long for landscape', () => {
    expect(mediumSizePt({ short: '8.5in', long: '11in', orientation: 'landscape' }))
      .toEqual({ w: 792, h: 612 });
  });

  it('agrees with a page it matches and refuses one it does not', () => {
    expect(mediumAgrees({ short: '8.5in', long: '11in' }, usLetter)).toBe(true);
    // A4 declared against a US Letter page: 17pt out on width.
    expect(mediumAgrees({ short: '210mm', long: '297mm' }, usLetter)).toBe(false);
  });

  it('absorbs a producer rounding but not a unit error', () => {
    expect(MEDIUM_TOLERANCE_PT).toBe(1);
    // 8.5in written to three decimals: 611.998pt, inside tolerance.
    expect(mediumAgrees({ short: '8.499in', long: '11in' }, usLetter)).toBe(true);
    // The same numbers with the orientation wrong: 180pt out.
    expect(mediumAgrees(
      { short: '8.5in', long: '11in', orientation: 'landscape' }, usLetter,
    )).toBe(false);
  });

  it('refuses an absent, unreadable or unit-less-than-certain medium', () => {
    expect(mediumSizePt(undefined)).toBeUndefined();
    expect(mediumSizePt({ short: '8.5in' })).toBeUndefined();
    expect(mediumSizePt({ short: '100px', long: '200px' })).toBeUndefined();
    expect(mediumAgrees(undefined, usLetter)).toBe(false);
  });
});

describe('chainIsPositioned', () => {
  it('accepts a chain of positions, including an empty one', () => {
    expect(chainIsPositioned([])).toBe(true);
    expect(chainIsPositioned(['position', 'position'])).toBe(true);
  });

  // The rule is on the WHOLE chain. A positioned subform inside a flowed one
  // has no fixed origin of its own -- precisely the case where a plausible
  // wrong answer is available.
  it('refuses a flow anywhere above, not only immediately above', () => {
    expect(chainIsPositioned(['tb', 'position'])).toBe(false);
    expect(chainIsPositioned(['position', 'lr-tb', 'position'])).toBe(false);
    expect(chainIsPositioned(['position', 'row'])).toBe(false);
    expect(chainIsPositioned(['position', 'table'])).toBe(false);
  });

  // Interpretation 3: a repeating subform's direction is unknowable, so the
  // template walker marks it and it degrades like any flow.
  it('refuses the synthetic occur marker and any layout it does not know', () => {
    expect(chainIsPositioned(['occur'])).toBe(false);
    expect(chainIsPositioned(['someFutureLayout'])).toBe(false);
  });
});

describe('accumulateOrigin', () => {
  // Three deep with a non-zero offset at EACH level -- the mutation "accumulate
  // from the immediate parent only" is invisible with fewer.
  it('sums every level of the chain, not just the last', () => {
    expect(accumulateOrigin([
      { x: '0.25in', y: '0.5in' },
      { x: '1in', y: '2in' },
      { x: '10pt', y: '20pt' },
    ])).toEqual({ x: 100, y: 200 });
  });

  it('treats an absent x or y as zero', () => {
    expect(accumulateOrigin([{ y: '1in' }, {}])).toEqual({ x: 0, y: 72 });
  });

  it('refuses the whole chain when any level is unreadable', () => {
    expect(accumulateOrigin([{ x: '1in' }, { x: '3px' }])).toBeUndefined();
  });
});

describe('boxFor', () => {
  it('adds the accumulated origin to the field own position', () => {
    expect(boxFor(
      { x: '1in', y: '2in', w: '3in', h: '0.25in' },
      [{ x: '0.5in', y: '0.5in' }],
    )).toEqual({ x: 108, y: 180, w: 216, h: 18 });
  });

  it('applies the anchor shift to the accumulated point', () => {
    expect(boxFor(
      { x: '1in', y: '1in', w: '2in', h: '1in', anchorType: 'middleCenter' },
      [],
    )).toEqual({ x: 0, y: 36, w: 144, h: 72 });
  });

  it('refuses a rotate, an unreadable measure and a bad anchor, each by name', () => {
    for (const own of [
      { x: '0', y: '0', w: '1in', h: '1in', rotate: '90' },
      { x: '0', y: '0', w: '1px', h: '1in' },
      { x: '0', y: '0', w: '1in', h: '1in', anchorType: 'centre' },
      { y: '0', w: '1in', h: '1in' },              // no x at all
    ]) {
      const r = boxFor(own, []);
      expect(r).toHaveProperty('reason');
      expect((r as { reason: string }).reason).toBeTruthy();
    }
  });

  it('accepts rotate="0", which is not a rotation', () => {
    expect(boxFor({ x: '0', y: '0', w: '1in', h: '1in', rotate: '0' }, []))
      .toEqual({ x: 0, y: 0, w: 72, h: 72 });
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfageom.test.ts`
Expected: FAIL — `mediumSizePt is not a function` (or an import error). The nine
Task 1 cases still pass.

- [ ] **Step 3: Write the implementation**

Append to `src/xfageom.ts`:

```ts
/** A `<pageArea>`'s `<medium>`: the page size the form was authored for. */
export interface XfaMedium { short?: string; long?: string; orientation?: string }

/** How far a declared medium may differ from the page's CropBox and still be
 *  believed, on either axis.
 *
 *  One point is tight enough that a unit error cannot pass -- the smallest of
 *  them moves an A4 edge by tens of points -- and loose enough to absorb a
 *  producer's rounding of `8.5in` to three decimal places. */
export const MEDIUM_TOLERANCE_PT = 1;

/** A medium's page box in points, `undefined` when either measurement is
 *  absent or a unit we decline to guess at. `orientation="landscape"` swaps
 *  short and long, which is the only reason the attribute is read. */
export function mediumSizePt(
  m: XfaMedium | undefined,
): { w: number; h: number } | undefined {
  if (!m) return undefined;
  const s = measureToPt(m.short);
  const l = measureToPt(m.long);
  if (s === undefined || l === undefined) return undefined;
  return m.orientation === 'landscape' ? { w: l, h: s } : { w: s, h: l };
}

/**
 * Does the page the form was authored for match the page we are about to place
 * fields on?
 *
 * **This is the check that makes the rest trustworthy.** It asserts against a
 * number we did not compute, so one comparison catches a unit-conversion error,
 * an orientation swap and a wrong page mapping alike -- the discipline this repo
 * states as *to check an interpreter, assert against something outside it*. An
 * absent or unreadable medium is a refusal, not a pass: without it there is
 * nothing to check against, and placing fields anyway is exactly the guess the
 * design forbids.
 */
export function mediumAgrees(
  m: XfaMedium | undefined, crop: readonly number[],
): boolean {
  const size = mediumSizePt(m);
  if (!size) return false;
  const w = Math.abs(crop[2] - crop[0]);
  const h = Math.abs(crop[3] - crop[1]);
  return Math.abs(size.w - w) <= MEDIUM_TOLERANCE_PT
    && Math.abs(size.h - h) <= MEDIUM_TOLERANCE_PT;
}

/** One ancestor container's own position, as the template spells it. */
export interface XfaOffset { x?: string; y?: string }

/** The four flow layouts, plus the synthetic marker `xfatemplate.ts` pushes for
 *  a repeating `<occur>` subform, whose repeat DIRECTION is not knowable from
 *  the template. Anything not `'position'` degrades, so this list is
 *  documentation rather than the test. */
export const XFA_FLOW_LAYOUTS: readonly string[] = ['tb', 'lr-tb', 'row', 'table', 'occur'];

/**
 * May a field under this ancestor chain be given a rect?
 *
 * **Only when EVERY entry is `position`.** The test is on the whole chain, not
 * the immediate parent: a positioned subform inside a flowed one has no fixed
 * origin of its own, which is precisely the case where a plausible wrong answer
 * is available. An unknown layout is refused for the same reason -- an
 * allowlist, the posture `content.ts`'s `NON_MARKING` takes.
 *
 * See the plan's *Interpretations* for where the chain begins: at the page
 * origin, not at the root subform that carries the `<pageSet>`.
 */
export function chainIsPositioned(layouts: readonly string[]): boolean {
  return layouts.every((l) => l === 'position');
}

/** The chain's accumulated origin in points, or `undefined` when ANY level is
 *  unreadable -- a partial sum is an approximate rect by another name. */
export function accumulateOrigin(
  offsets: readonly XfaOffset[],
): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  for (const o of offsets) {
    const ox = o.x === undefined ? 0 : measureToPt(o.x);
    const oy = o.y === undefined ? 0 : measureToPt(o.y);
    if (ox === undefined || oy === undefined) return undefined;
    x += ox;
    y += oy;
  }
  return { x, y };
}

/** A field's own geometry attributes, verbatim from the template. */
export interface XfaRawGeom {
  x?: string; y?: string; w?: string; h?: string;
  anchorType?: string; rotate?: string;
}

/**
 * A field's box in the page's XFA frame, or a `reason` naming why it has none.
 *
 * Every refusal is by name, because the caller puts it straight on the report
 * and that report is the first place a caller looks when a converted document
 * is missing a field.
 */
export function boxFor(
  own: XfaRawGeom, offsets: readonly XfaOffset[],
): XfaBox | { reason: string } {
  // A rotated field would need the widget /MK /R plus /Matrix dance
  // appearance.ts already documents as its own trap. `rotate="0"` is not a
  // rotation and must not degrade a field.
  if (own.rotate !== undefined && measureToPt(own.rotate) !== 0)
    return { reason: `rotate="${own.rotate}" is not supported` };

  const origin = accumulateOrigin(offsets);
  if (!origin) return { reason: 'an ancestor position could not be read' };

  const parts: Array<[keyof XfaRawGeom, number | undefined]> = [
    ['x', measureToPt(own.x)], ['y', measureToPt(own.y)],
    ['w', measureToPt(own.w)], ['h', measureToPt(own.h)],
  ];
  for (const [k, v] of parts)
    if (v === undefined)
      return { reason: `${k}="${own[k] ?? ''}" could not be read as a measurement` };

  const [x, y, w, h] = parts.map(([, v]) => v!);
  const shift = anchorShift(own.anchorType, w, h);
  if (!shift) return { reason: `anchorType="${own.anchorType ?? ''}" is not one of the nine` };

  return { x: origin.x + x + shift.dx, y: origin.y + y + shift.dy, w, h };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/xfageom.test.ts` — Expected: PASS, 22 cases (9 from
Task 1, 13 new).
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Prove three assertions load-bearing**

Run each mutation, confirm the named cases go RED, then revert:

| Mutation | Expected red |
|---|---|
| `mediumAgrees` returns `true` unconditionally | 2 cases in `mediumSizePt / mediumAgrees` |
| `mediumSizePt` ignores `orientation` (never swaps) | the landscape case and the orientation half of the tolerance case |
| `accumulateOrigin` reads only `offsets[offsets.length - 1]` | the three-deep case |
| `chainIsPositioned` tests only `layouts[layouts.length - 1]` | 2 of the 3 `chainIsPositioned` cases |

Record the counts in the commit message.

- [ ] **Step 6: Commit**

Message body (via `git commit -F`):

```
feat(6t2v.3): the medium-versus-CropBox check, the chain rule and offsets

mediumAgrees is the correctness anchor of this feature: a <pageArea>'s declared
<medium> is compared against the PDF page's own CropBox before any field on that
page is given a rect, and a mismatch of more than 1pt on either axis degrades
every field on that page. It asserts against a number we did not compute, so one
comparison catches a unit-conversion error, an orientation swap and a wrong page
mapping alike. An ABSENT medium is a refusal, not a pass -- there is nothing to
check against, and placing fields anyway is the guess the design forbids.

chainIsPositioned tests the WHOLE ancestor chain rather than the immediate
parent, because a positioned subform inside a flowed one has no fixed origin of
its own. Unknown layouts are refused too: an allowlist, the posture
content.ts's NON_MARKING takes.

Measured: neutering the medium check reddens 2; ignoring orientation reddens 2;
accumulating from the immediate parent only reddens 1, and its fixture is three
deep with a non-zero offset at each level because fewer cannot see it; testing
the last layout only reddens 2.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 3: `xfatemplate.ts` — SOM naming, UI kinds, flags and `<items>`

**Files:**
- Create: `src/xfatemplate.ts`
- Test: `test/xfatemplate.test.ts`

**Interfaces:**
- Consumes: `XmlNode`, `parseXml` from `src/xml.js`. Nothing else — this module
  imports `xml.js` **alone**.
- Produces:
  - `type XfaUiKind = 'text' | 'numeric' | 'dateTime' | 'password' | 'checkButton' | 'choiceList' | 'button' | 'signature' | 'imageEdit' | 'barcode' | 'unknown'`
  - `interface XfaItem { export: string; display?: string }`
  - `interface XfaField { name: string; ui: XfaUiKind; group?: string; items?: XfaItem[]; open?: string; readOnly: boolean; required: boolean; multiLine: boolean; maxChars?: number; tooltip?: string; defaultValue?: string; onState?: string; geom: XfaRawGeom; layouts: string[]; offsets: XfaOffset[]; pageIndex?: number }`
  - `interface XfaPageArea { name?: string; medium?: XfaMedium }`
  - `interface XfaTemplate { fields: XfaField[]; pages: XfaPageArea[] }`
  - `function parseXfaTemplate(root: XmlNode): XfaTemplate`
  - `function somName(parts: readonly string[]): string`

  Task 4 fills `geom`, `layouts`, `offsets` and `pageIndex`; this task leaves
  them at `{}`, `[]`, `[]` and `undefined` and its tests assert only the fields
  above. Declare the full `XfaField` shape **now** so Task 4 adds no type.

- [ ] **Step 1: Write the failing test**

Create `test/xfatemplate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate, somName, type XfaField } from '../src/xfatemplate.js';

const tpl = (inner: string) => parseXfaTemplate(parseXml(
  new TextEncoder().encode(`<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">${inner}</template>`),
));
const by = (fs: XfaField[], n: string) => fs.find((f) => f.name === n)!;

describe('somName', () => {
  it('joins parts with dots', () => {
    expect(somName(['form1[0]', 'Page1[0]', 'f1[0]'])).toBe('form1[0].Page1[0].f1[0]');
  });
});

describe('parseXfaTemplate: naming', () => {
  // The synthesized name is the SOM expression, occurrence indices included --
  // exactly what LiveCycle writes into a hybrid's /AcroForm, so reconciling the
  // two halves is name equality rather than a heuristic.
  it('names a field by its SOM path with occurrence indices', () => {
    const t = tpl(`<subform name="form1"><subform name="Page1">
      <field name="f1_01"><ui><textEdit/></ui></field></subform></subform>`);
    expect(t.fields.map((f) => f.name)).toEqual(['form1[0].Page1[0].f1_01[0]']);
  });

  it('indexes same-named siblings from zero, independently per name', () => {
    const t = tpl(`<subform name="form1">
      <field name="a"><ui><textEdit/></ui></field>
      <field name="b"><ui><textEdit/></ui></field>
      <field name="a"><ui><textEdit/></ui></field></subform>`);
    expect(t.fields.map((f) => f.name)).toEqual([
      'form1[0].a[0]', 'form1[0].b[0]', 'form1[0].a[1]',
    ]);
  });

  // SOM defines an unnamed container as transparent to the path. Wrong, every
  // field under one gets an extra level and NO name matches the AcroForm half.
  it('makes an anonymous container transparent to the path', () => {
    const t = tpl(`<subform name="form1"><subform>
      <field name="f"><ui><textEdit/></ui></field></subform></subform>`);
    expect(t.fields.map((f) => f.name)).toEqual(['form1[0].f[0]']);
  });

  it('skips a field with no name rather than inventing one', () => {
    const t = tpl(`<subform name="form1"><field><ui><textEdit/></ui></field></subform>`);
    expect(t.fields).toEqual([]);
  });
});

describe('parseXfaTemplate: UI kinds', () => {
  it('maps every <ui> child this feature knows', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit/></ui></field>
      <field name="b"><ui><numericEdit/></ui></field>
      <field name="c"><ui><dateTimeEdit/></ui></field>
      <field name="d"><ui><passwordEdit/></ui></field>
      <field name="e"><ui><checkButton/></ui></field>
      <field name="g"><ui><choiceList/></ui></field>
      <field name="h"><ui><button/></ui></field>
      <field name="i"><ui><signature/></ui></field>
      <field name="j"><ui><imageEdit/></ui></field>
      <field name="k"><ui><barcode/></ui></field>
      <field name="l"><ui><somethingElse/></ui></field>
      <field name="m"/></subform>`);
    const kinds = Object.fromEntries(t.fields.map((f) => [f.name.split('.')[1], f.ui]));
    expect(kinds).toEqual({
      'a[0]': 'text', 'b[0]': 'numeric', 'c[0]': 'dateTime', 'd[0]': 'password',
      'e[0]': 'checkButton', 'g[0]': 'choiceList', 'h[0]': 'button',
      'i[0]': 'signature', 'j[0]': 'imageEdit', 'k[0]': 'barcode',
      'l[0]': 'unknown', 'm[0]': 'unknown',
    });
  });

  it('carries choiceList open= through untouched for the caller to map', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><choiceList open="userControl"/></ui></field>
      <field name="b"><ui><choiceList open="multiSelect"/></ui></field>
      <field name="c"><ui><choiceList/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').open).toBe('userControl');
    expect(by(t.fields, 'f[0].b[0]').open).toBe('multiSelect');
    expect(by(t.fields, 'f[0].c[0]').open).toBeUndefined();
  });
});

describe('parseXfaTemplate: flags, defaults and tooltips', () => {
  it('reads readOnly from both access spellings and nowhere else', () => {
    const t = tpl(`<subform name="f">
      <field name="a" access="readOnly"><ui><textEdit/></ui></field>
      <field name="b" access="protected"><ui><textEdit/></ui></field>
      <field name="c" access="open"><ui><textEdit/></ui></field>
      <field name="d"><ui><textEdit/></ui></field></subform>`);
    expect(t.fields.map((f) => f.readOnly)).toEqual([true, true, false, false]);
  });

  it('reads required from <validate nullTest="error"> only', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit/></ui><validate nullTest="error"/></field>
      <field name="b"><ui><textEdit/></ui><validate nullTest="warning"/></field>
      <field name="c"><ui><textEdit/></ui><validate/></field>
      <field name="d"><ui><textEdit/></ui></field></subform>`);
    expect(t.fields.map((f) => f.required)).toEqual([true, false, false, false]);
  });

  it('reads multiLine and maxChars off the text sub-elements', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><textEdit multiLine="1"/></ui>
        <value><text maxChars="40">seed</text></value>
        <assist><toolTip>Your name</toolTip></assist></field>
      <field name="b"><ui><textEdit/></ui></field></subform>`);
    const a = by(t.fields, 'f[0].a[0]');
    expect(a.multiLine).toBe(true);
    expect(a.maxChars).toBe(40);
    expect(a.tooltip).toBe('Your name');
    // The template <value> is the DEFAULT (-> /DV), never the value (-> /V).
    expect(a.defaultValue).toBe('seed');
    const b = by(t.fields, 'f[0].b[0]');
    expect(b.multiLine).toBe(false);
    expect(b.maxChars).toBeUndefined();
    expect(b.tooltip).toBeUndefined();
    expect(b.defaultValue).toBeUndefined();
  });

  it('ignores a maxChars that is not a positive integer', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><textEdit/></ui>
      <value><text maxChars="-1"/></value></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').maxChars).toBeUndefined();
  });
});

describe('parseXfaTemplate: <items>', () => {
  // XFA spells the export/display pair as two parallel <items> lists, the one
  // carrying save="1" being the EXPORT side. Swap them and a list box
  // highlights nothing and a combo draws the export value -- the defect
  // choiceopt.ts exists to prevent.
  it('pairs the save="1" list as export with the other as display', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><choiceList/></ui>
      <items save="1"><text>US</text><text>CA</text></items>
      <items><text>United States</text><text>Canada</text></items>
      </field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').items).toEqual([
      { export: 'US', display: 'United States' },
      { export: 'CA', display: 'Canada' },
    ]);
  });

  it('takes a single <items> list as both halves', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><choiceList/></ui>
      <items><text>S</text><text>M</text></items></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').items).toEqual([{ export: 'S' }, { export: 'M' }]);
  });

  it('pairs only as far as the shorter list and keeps the rest export-only', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><choiceList/></ui>
      <items save="1"><text>a</text><text>b</text></items>
      <items><text>Alpha</text></items></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').items)
      .toEqual([{ export: 'a', display: 'Alpha' }, { export: 'b' }]);
  });

  it('reads a checkbox on-state from its items and defaults it to 1', () => {
    const t = tpl(`<subform name="f">
      <field name="a"><ui><checkButton/></ui>
        <items><text>Y</text><text>N</text></items></field>
      <field name="b"><ui><checkButton/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').onState).toBe('Y');
    expect(by(t.fields, 'f[0].b[0]').onState).toBe('1');
  });
});

describe('parseXfaTemplate: exclGroup', () => {
  it('records each member field and names the group on every one', () => {
    const t = tpl(`<subform name="f"><exclGroup name="colour">
      <field name="red"><ui><checkButton/></ui><items><text>R</text></items></field>
      <field name="green"><ui><checkButton/></ui><items><text>G</text></items></field>
      </exclGroup></subform>`);
    expect(t.fields.map((f) => f.name))
      .toEqual(['f[0].colour[0].red[0]', 'f[0].colour[0].green[0]']);
    expect(t.fields.every((f) => f.group === 'f[0].colour[0]')).toBe(true);
    expect(t.fields.map((f) => f.onState)).toEqual(['R', 'G']);
  });
});

describe('parseXfaTemplate: pageAreas', () => {
  it('lists pageAreas in document order with their media', () => {
    const t = tpl(`<subform name="f"><pageSet>
      <pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea>
      <pageArea name="P2"><medium short="8.5in" long="11in" orientation="landscape"/></pageArea>
      </pageSet></subform>`);
    expect(t.pages).toEqual([
      { name: 'P1', medium: { short: '8.5in', long: '11in' } },
      { name: 'P2', medium: { short: '8.5in', long: '11in', orientation: 'landscape' } },
    ]);
  });

  it('records a pageArea with no medium rather than dropping it', () => {
    const t = tpl(`<subform name="f"><pageSet><pageArea/></pageSet></subform>`);
    expect(t.pages).toHaveLength(1);
    expect(t.pages[0].medium).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfatemplate.test.ts`
Expected: FAIL — `Failed to resolve import "../src/xfatemplate.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/xfatemplate.ts`. Note `xml.ts` **strips namespace prefixes**
(`xml.ts:38`), so `<xfa:field>` arrives as `field` and nothing here may rely on
a prefix to disambiguate.

```ts
/**
 * The XFA `template` packet as a flat field model.
 *
 * **Invariant: pure, over `xml.js` alone.** No `Document`, no PDF object, no
 * `node:` import -- so every rule here is drivable from an XML string.
 *
 * **Invariant: it never throws.** `parseXml` does, and `xfapacket.ts` owns that
 * boundary; by the time a tree reaches here it parsed.
 *
 * **Note `xml.ts` strips namespace prefixes** (`xml.ts:38`), so `<xfa:field>`
 * arrives as `field`. Nothing here may rely on a prefix to disambiguate two
 * elements.
 */
import type { XmlNode } from './xml.js';
import type { XfaMedium, XfaOffset, XfaRawGeom } from './xfageom.js';

export type XfaUiKind =
  | 'text' | 'numeric' | 'dateTime' | 'password'
  | 'checkButton' | 'choiceList' | 'button'
  | 'signature' | 'imageEdit' | 'barcode' | 'unknown';

/** The `<ui>` child element name to the kind this feature maps it by. */
const UI_KIND: Record<string, XfaUiKind> = {
  textEdit: 'text',
  numericEdit: 'numeric',
  dateTimeEdit: 'dateTime',
  passwordEdit: 'password',
  checkButton: 'checkButton',
  choiceList: 'choiceList',
  button: 'button',
  signature: 'signature',
  imageEdit: 'imageEdit',
  barcode: 'barcode',
};

/** One `/Opt` entry as XFA states it: the `save="1"` list supplies `export`,
 *  the other list `display`. */
export interface XfaItem { export: string; display?: string }

export interface XfaField {
  /** The SOM expression, occurrence indices included. */
  name: string;
  ui: XfaUiKind;
  /** The enclosing `<exclGroup>`'s SOM path, for a radio member. */
  group?: string;
  items?: XfaItem[];
  /** `<choiceList open="...">`, carried through verbatim. */
  open?: string;
  readOnly: boolean;
  required: boolean;
  multiLine: boolean;
  maxChars?: number;
  tooltip?: string;
  /** The template's own `<value>` -- `/DV`, never `/V`. */
  defaultValue?: string;
  /** A button's on-state and export value. */
  onState?: string;
  /** Filled by the geometry pass (Task 4). */
  geom: XfaRawGeom;
  /** Each container's layout between the page origin and this field, outermost
   *  first. Filled by the geometry pass (Task 4). */
  layouts: string[];
  /** Each of those containers' own x/y, in the same order. Task 4. */
  offsets: XfaOffset[];
  /** 0-based `<pageArea>` index. Task 4. */
  pageIndex?: number;
}

export interface XfaPageArea { name?: string; medium?: XfaMedium }

export interface XfaTemplate { fields: XfaField[]; pages: XfaPageArea[] }

/** A SOM expression from its already-indexed parts. */
export function somName(parts: readonly string[]): string {
  return parts.join('.');
}

const child = (n: XmlNode, name: string): XmlNode | undefined =>
  n.children.find((c) => c.name === name);

const childrenNamed = (n: XmlNode, name: string): XmlNode[] =>
  n.children.filter((c) => c.name === name);

/** The `<items>` lists paired into export/display entries.
 *
 *  **The `save="1"` list is the EXPORT half.** That is the half `/V` carries;
 *  the other is what gets drawn. Every consumer in this repo that re-derived
 *  that grammar got one of the two wrong. */
function itemsOf(field: XmlNode): XfaItem[] | undefined {
  const lists = childrenNamed(field, 'items');
  if (lists.length === 0) return undefined;
  const saveList = lists.find((l) => l.attrs.get('save') === '1');
  const exp = saveList ?? lists[0];
  const disp = lists.find((l) => l !== exp);
  const texts = (l: XmlNode | undefined) =>
    l ? l.children.map((c) => c.text) : [];
  const es = texts(exp);
  const ds = texts(disp);
  if (es.length === 0) return undefined;
  return es.map((e, i) => (ds[i] === undefined ? { export: e } : { export: e, display: ds[i] }));
}

/** A positive-integer attribute, or `undefined` for anything else. */
function positiveInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** One `<field>` to the model, or `undefined` when it has no name -- an
 *  unnamed field has no SOM path, so there is nothing to call it in an
 *  AcroForm and inventing one would break the hybrid name equality. */
function fieldOf(el: XmlNode, path: string[], group: string | undefined): XfaField | undefined {
  const partial = el.attrs.get('name');
  if (partial === undefined || partial === '') return undefined;

  const uiEl = child(el, 'ui');
  const uiChild = uiEl?.children[0];
  const ui = (uiChild && UI_KIND[uiChild.name]) ?? 'unknown';

  const access = el.attrs.get('access');
  const validate = child(el, 'validate');
  const valueEl = child(el, 'value');
  const textEl = valueEl ? child(valueEl, 'text') : undefined;
  const items = itemsOf(el);

  return {
    name: somName(path),
    ui,
    ...(group ? { group } : {}),
    ...(items ? { items } : {}),
    ...(uiChild?.attrs.get('open') !== undefined ? { open: uiChild.attrs.get('open') } : {}),
    readOnly: access === 'readOnly' || access === 'protected',
    required: validate?.attrs.get('nullTest') === 'error',
    multiLine: uiChild?.name === 'textEdit' && uiChild.attrs.get('multiLine') === '1',
    ...(positiveInt(textEl?.attrs.get('maxChars')) !== undefined
      ? { maxChars: positiveInt(textEl?.attrs.get('maxChars')) } : {}),
    ...(child(child(el, 'assist') ?? { children: [] } as unknown as XmlNode, 'toolTip')?.text
      ? { tooltip: child(child(el, 'assist')!, 'toolTip')!.text } : {}),
    ...(valueEl && valueEl.text !== '' ? { defaultValue: valueEl.text } : {}),
    // A button's on-state is its first item's export half. '1' is XFA's own
    // default for a checkButton with no items; the AcroForm side turns
    // whatever this says into the /AP on-state key.
    ...(ui === 'checkButton' ? { onState: items?.[0]?.export ?? '1' } : {}),
    geom: {},
    layouts: [],
    offsets: [],
  };
}

/** Walk `<subform>` / `<exclGroup>` / `<field>` and yield one entry per
 *  terminal field. An ANONYMOUS container is transparent to the SOM path, as
 *  SOM defines it -- give it a level and no name matches the AcroForm half of a
 *  hybrid document. */
function walk(
  el: XmlNode, path: string[], group: string | undefined, out: XfaField[],
): void {
  // Occurrence indices are per NAME among siblings, so the counter is scoped to
  // this element's own children.
  const counts = new Map<string, number>();
  const indexed = (n: string): string => {
    const i = counts.get(n) ?? 0;
    counts.set(n, i + 1);
    return `${n}[${String(i)}]`;
  };

  for (const c of el.children) {
    if (c.name === 'field') {
      const partial = c.attrs.get('name');
      const sub = partial === undefined || partial === ''
        ? path : [...path, indexed(partial)];
      const f = fieldOf(c, sub, group);
      if (f) out.push(f);
      continue;
    }
    if (c.name !== 'subform' && c.name !== 'exclGroup' && c.name !== 'area') continue;
    const partial = c.attrs.get('name');
    const sub = partial === undefined || partial === ''
      ? path : [...path, indexed(partial)];
    walk(c, sub, c.name === 'exclGroup' ? somName(sub) : group, out);
  }
}

/** Every `<pageArea>` in document order, wherever the `<pageSet>` sits. Page
 *  identity is this order mapped onto the document's page index. */
function pageAreas(root: XmlNode, out: XfaPageArea[]): void {
  for (const c of root.children) {
    if (c.name === 'pageArea') {
      const m = child(c, 'medium');
      const medium: XfaMedium | undefined = m
        ? {
            ...(m.attrs.get('short') !== undefined ? { short: m.attrs.get('short') } : {}),
            ...(m.attrs.get('long') !== undefined ? { long: m.attrs.get('long') } : {}),
            ...(m.attrs.get('orientation') !== undefined
              ? { orientation: m.attrs.get('orientation') } : {}),
          }
        : undefined;
      out.push({
        ...(c.attrs.get('name') !== undefined ? { name: c.attrs.get('name') } : {}),
        ...(medium ? { medium } : {}),
      });
      continue;
    }
    pageAreas(c, out);
  }
}

/** The `template` packet's root element to the field model. */
export function parseXfaTemplate(root: XmlNode): XfaTemplate {
  const fields: XfaField[] = [];
  walk(root, [], undefined, fields);
  const pages: XfaPageArea[] = [];
  pageAreas(root, pages);
  return { fields, pages };
}
```

> **Note for the implementer:** the `tooltip` and `maxChars` spread expressions
> above are deliberately written twice for clarity of intent, which is ugly.
> Hoist each into a local `const` before the object literal — the behaviour is
> what the tests pin, not the spelling. Do not change what is computed.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/xfatemplate.test.ts` — Expected: PASS, 17 cases.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Prove three assertions load-bearing**

| Mutation | Expected red |
|---|---|
| `itemsOf` takes `lists[0]` as export and `lists[1]` as display unconditionally | the `save="1"` pairing case |
| an anonymous container pushes an empty level onto the path | the transparency case |
| the occurrence counter is one document-wide map instead of per element | the same-named-siblings case |

Revert each, re-run, confirm green. Record the counts.

- [ ] **Step 6: Commit**

```
feat(6t2v.3): the XFA template packet as a flat field model

xfatemplate.ts walks <subform>/<exclGroup>/<field> and yields one entry per
terminal: the SOM path with occurrence indices, the <ui> kind, the <items>
export/display pair, the access and nullTest flags, maxChars, the tooltip and
the template's own <value>.

Two rules carry more than they look. The synthesized name IS the SOM
expression, indices included, because that is exactly what LiveCycle writes into
a hybrid document's /AcroForm -- so reconciling the two halves later is name
equality rather than a heuristic. And the save="1" <items> list is the EXPORT
half: /V carries the export and the other list is what gets drawn, the grammar
choiceopt.ts owns and that every consumer re-deriving it has got wrong.

The template's <value> lands on defaultValue (-> /DV) and never on a value.
Conflating them destroys the difference between what a form was authored with
and what someone entered, which for the filled archived forms this feature
exists to open is the entire content.

Measured: swapping the items halves, giving an anonymous container a path level,
and sharing one occurrence counter across the document each redden exactly the
case named for them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 4: `xfatemplate.ts` — the layout chain, offsets and page identity

The pass that fills `geom`, `layouts`, `offsets` and `pageIndex`. Where the
chain **begins** is the plan's *Interpretation 2*; read it before starting.

**Files:**
- Modify: `src/xfatemplate.ts`
- Test: `test/xfatemplate.test.ts` (append; the 17 Task 3 cases stay green
  unedited)

**Interfaces:**
- Consumes: everything from Task 3, plus `XfaOffset` / `XfaRawGeom` types from
  `src/xfageom.js`.
- Produces: no new exported name. `XfaField.geom` / `.layouts` / `.offsets` /
  `.pageIndex` are now populated; Task 7 consumes them.

- [ ] **Step 1: Write the failing test**

Append to `test/xfatemplate.test.ts`:

```ts
describe('parseXfaTemplate: geometry', () => {
  it('carries the field own geometry attributes verbatim', () => {
    const t = tpl(`<subform name="f" layout="position">
      <field name="a" x="1in" y="2in" w="3in" h="0.25in"
             anchorType="middleCenter" rotate="90"><ui><textEdit/></ui></field>
      </subform>`);
    expect(by(t.fields, 'f[0].a[0]').geom).toEqual({
      x: '1in', y: '2in', w: '3in', h: '0.25in',
      anchorType: 'middleCenter', rotate: '90',
    });
  });

  it('omits an absent attribute rather than storing an empty string', () => {
    const t = tpl(`<subform name="f" layout="position">
      <field name="a" x="1in"><ui><textEdit/></ui></field></subform>`);
    expect(by(t.fields, 'f[0].a[0]').geom).toEqual({ x: '1in' });
  });
});

describe('parseXfaTemplate: the layout chain', () => {
  // Interpretation 2. The chain starts BELOW the subform carrying the
  // <pageSet>: that container's layout breaks pages, it does not place fields.
  // Read from the document root instead and every LiveCycle form -- whose root
  // is routinely layout="tb" -- degrades entirely.
  it('excludes the pageSet-carrying subform from the chain', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position" x="0in" y="0in">
        <field name="a" x="1in" y="1in" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const a = by(t.fields, 'form1[0].Page1[0].a[0]');
    expect(a.layouts).toEqual(['position']);
    expect(a.offsets).toEqual([{ x: '0in', y: '0in' }]);
  });

  it('records every container below the page origin, outermost first', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea/></pageSet>
      <subform name="P" layout="position" x="1in" y="2in">
        <subform name="Q" layout="position" x="3pt">
          <field name="a" w="1in" h="1in" x="0" y="0"><ui><textEdit/></ui></field>
        </subform></subform></subform>`);
    const a = by(t.fields, 'form1[0].P[0].Q[0].a[0]');
    expect(a.layouts).toEqual(['position', 'position']);
    expect(a.offsets).toEqual([{ x: '1in', y: '2in' }, { x: '3pt' }]);
  });

  it('defaults a stated-nothing subform layout to position', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P"><field name="a" x="0" y="0" w="1in" h="1in">
      <ui><textEdit/></ui></field></subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['position']);
  });

  it('records a flow layout so the caller degrades the field', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><subform name="Q" layout="tb">
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].Q[0].a[0]').layouts)
      .toEqual(['position', 'tb']);
  });

  // Interpretation 3: the occurrence COUNT is knowable from <occur initial>,
  // but the repeat DIRECTION is not, so a repeating subform is flow-laid.
  it('marks a repeating subform with the synthetic occur layout', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><occur max="5"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['occur']);
  });

  it('leaves occur max="1" and an unbounded-but-single occur alone', () => {
    const t = tpl(`<subform name="form1" layout="tb"><pageSet><pageArea/></pageSet>
      <subform name="P" layout="position"><occur max="1" min="1"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').layouts).toEqual(['position']);
  });

  // A <contentArea> shifts the page origin, so its own x/y joins the chain.
  it('adds a contentArea origin when the chain passes through one', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1">
        <contentArea x="0.25in" y="0.5in" w="8in" h="10in"/>
        <medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position">
        <field name="a" x="1in" y="1in" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    const a = by(t.fields, 'form1[0].Page1[0].a[0]');
    expect(a.offsets[0]).toEqual({ x: '0.25in', y: '0.5in' });
    expect(a.layouts[0]).toBe('position');
  });
});

describe('parseXfaTemplate: page identity', () => {
  it('maps each page subform to its pageArea by order', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"/><pageArea name="P2"/></pageSet>
      <subform name="Page1" layout="position">
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      <subform name="Page2" layout="position">
        <field name="b" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      </subform>`);
    expect(by(t.fields, 'form1[0].Page1[0].a[0]').pageIndex).toBe(0);
    expect(by(t.fields, 'form1[0].Page2[0].b[0]').pageIndex).toBe(1);
  });

  it('honours an explicit break to a named pageArea', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"/><pageArea name="P2"/></pageSet>
      <subform name="S1" layout="position"><breakBefore target="P2"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      </subform>`);
    expect(by(t.fields, 'form1[0].S1[0].a[0]').pageIndex).toBe(1);
  });

  it('leaves pageIndex undefined when the break names a pageArea that is not there', () => {
    const t = tpl(`<subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"/></pageSet>
      <subform name="S1" layout="position"><breakBefore target="Nowhere"/>
        <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>
      </subform>`);
    expect(by(t.fields, 'form1[0].S1[0].a[0]').pageIndex).toBeUndefined();
  });

  it('leaves pageIndex undefined when the template declares no pageArea at all', () => {
    const t = tpl(`<subform name="form1"><subform name="P" layout="position">
      <field name="a" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field>
      </subform></subform>`);
    expect(by(t.fields, 'form1[0].P[0].a[0]').pageIndex).toBeUndefined();
    expect(t.pages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfatemplate.test.ts`
Expected: FAIL — the geometry, chain and page cases all fail on `[]` / `{}` /
`undefined`; the 17 Task 3 cases still pass.

- [ ] **Step 3: Write the implementation**

Rework `walk` in `src/xfatemplate.ts` to carry a geometry context. Replace the
Task 3 `walk` and `fieldOf` signatures with these; nothing else in the file
changes.

```ts
/** What a container contributes to the fields beneath it. */
interface ChainCtx {
  /** Layouts between the page origin and here, outermost first. */
  layouts: string[];
  /** Those containers' own x/y, same order. */
  offsets: XfaOffset[];
  /** 0-based `<pageArea>` index in force, or `undefined` when unresolvable. */
  pageIndex?: number;
  /** True once the walk has passed BELOW the subform carrying the `<pageSet>`.
   *  Above it there is no page origin, so nothing is accumulated -- the plan's
   *  Interpretation 2. */
  inPage: boolean;
}

/** The geometry attributes a container or field states, absent keys omitted. */
function geomOf(el: XmlNode): XfaRawGeom {
  const g: XfaRawGeom = {};
  for (const k of ['x', 'y', 'w', 'h', 'anchorType', 'rotate'] as const) {
    const v = el.attrs.get(k);
    if (v !== undefined) g[k] = v;
  }
  return g;
}

/** A container's own x/y for the offset chain. */
function offsetOf(el: XmlNode): XfaOffset {
  const o: XfaOffset = {};
  const x = el.attrs.get('x');
  const y = el.attrs.get('y');
  if (x !== undefined) o.x = x;
  if (y !== undefined) o.y = y;
  return o;
}

/** A container's effective layout.
 *
 *  `position` is XFA's default and the one this feature can place from. A
 *  repeating `<occur>` contributes the synthetic `'occur'` instead: the
 *  occurrence COUNT is knowable from `initial`, but the repeat DIRECTION is
 *  not, so such a subform is flow-laid (plan Interpretation 3). */
function layoutOf(el: XmlNode): string {
  const occur = el.children.find((c) => c.name === 'occur');
  if (occur) {
    const max = occur.attrs.get('max');
    if (max !== undefined && max !== '1') return 'occur';
  }
  return el.attrs.get('layout') ?? 'position';
}

/** The `<contentArea>` a `<pageArea>` declares, as one more level of origin. */
function contentAreaOffset(pageArea: XmlNode | undefined): XfaOffset | undefined {
  const ca = pageArea?.children.find((c) => c.name === 'contentArea');
  return ca ? offsetOf(ca) : undefined;
}
```

Then the walk. It threads `ChainCtx`, and the *only* subtlety is `inPage`:

```ts
function walk(
  el: XmlNode, path: string[], group: string | undefined,
  ctx: ChainCtx, pages: XmlNode[], out: XfaField[],
): void {
  const counts = new Map<string, number>();
  const indexed = (n: string): string => {
    const i = counts.get(n) ?? 0;
    counts.set(n, i + 1);
    return `${n}[${String(i)}]`;
  };
  // A subform carrying a <pageSet> IS the page container: everything below it
  // sits on a page, and its own layout breaks pages rather than placing fields.
  const carriesPageSet = el.children.some((c) => c.name === 'pageSet');
  // Page index advances across the page-container's own subform children.
  let nextPage = 0;

  for (const c of el.children) {
    if (c.name === 'field') {
      const partial = c.attrs.get('name');
      const sub = partial === undefined || partial === ''
        ? path : [...path, indexed(partial)];
      const f = fieldOf(c, sub, group);
      if (f) {
        f.geom = geomOf(c);
        f.layouts = [...ctx.layouts];
        f.offsets = [...ctx.offsets];
        if (ctx.pageIndex !== undefined) f.pageIndex = ctx.pageIndex;
        out.push(f);
      }
      continue;
    }
    if (c.name !== 'subform' && c.name !== 'exclGroup' && c.name !== 'area') continue;

    const partial = c.attrs.get('name');
    const sub = partial === undefined || partial === ''
      ? path : [...path, indexed(partial)];

    let next: ChainCtx;
    if (carriesPageSet) {
      // Entering a page. Its index is its ordinal among these siblings unless a
      // <breakBefore target> names a pageArea, and a target naming no pageArea
      // leaves it UNRESOLVED rather than guessing -- an unresolvable page
      // degrades every field on it.
      const brk = c.children.find((b) => b.name === 'breakBefore' || b.name === 'break');
      const target = brk?.attrs.get('target');
      let idx: number | undefined;
      if (target !== undefined && target !== '') {
        const t = target.replace(/^#/, '');
        const found = pages.findIndex((p) => p.attrs.get('name') === t);
        idx = found < 0 ? undefined : found;
        if (found >= 0) nextPage = found + 1;
      } else {
        idx = nextPage < pages.length ? nextPage : undefined;
        nextPage += 1;
      }
      const ca = idx === undefined ? undefined : contentAreaOffset(pages[idx]);
      next = {
        layouts: [...(ca ? ['position'] : []), layoutOf(c)],
        offsets: [...(ca ? [ca] : []), offsetOf(c)],
        ...(idx !== undefined ? { pageIndex: idx } : {}),
        inPage: true,
      };
    } else if (!ctx.inPage) {
      // Still above any page origin: accumulate nothing.
      next = { layouts: [], offsets: [], inPage: false };
    } else {
      next = {
        layouts: [...ctx.layouts, layoutOf(c)],
        offsets: [...ctx.offsets, offsetOf(c)],
        ...(ctx.pageIndex !== undefined ? { pageIndex: ctx.pageIndex } : {}),
        inPage: true,
      };
    }
    walk(c, sub, c.name === 'exclGroup' ? somName(sub) : group, next, pages, out);
  }
}
```

`parseXfaTemplate` collects the `<pageArea>` **elements** first (it already
collects their models) and seeds the walk:

```ts
function pageAreaElements(root: XmlNode, out: XmlNode[]): void {
  for (const c of root.children) {
    if (c.name === 'pageArea') { out.push(c); continue; }
    pageAreaElements(c, out);
  }
}

export function parseXfaTemplate(root: XmlNode): XfaTemplate {
  const pageEls: XmlNode[] = [];
  pageAreaElements(root, pageEls);
  const fields: XfaField[] = [];
  walk(root, [], undefined, { layouts: [], offsets: [], inPage: false }, pageEls, fields);
  const pages: XfaPageArea[] = [];
  pageAreas(root, pages);
  return { fields, pages };
}
```

> **Note:** `pageAreas` (Task 3) and `pageAreaElements` walk the same tree for
> the same nodes. Collapse them into one traversal that returns the elements,
> and derive `XfaPageArea` from each element — two walks is how the model and
> the index come to disagree about how many pages there are.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/xfatemplate.test.ts` — Expected: PASS, 30 cases.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Prove three assertions load-bearing**

| Mutation | Expected red |
|---|---|
| drop the `carriesPageSet` branch, so the root subform joins the chain | the pageSet-exclusion case and the contentArea case |
| `layoutOf` ignores `<occur>` | the occur case |
| a `breakBefore` naming no pageArea falls back to `nextPage` | the unresolvable-target case |

Revert each and confirm green.

- [ ] **Step 6: Commit**

```
feat(6t2v.3): the XFA layout chain, offset accumulation and page identity

Each field now carries its own geometry attributes verbatim, the layout of every
container between it and its page origin, those containers' own x/y in the same
order, and the 0-based <pageArea> index it sits on.

Where the CHAIN BEGINS is the one interpretation this work adds beyond the
design, and it is decisive: LiveCycle's root <subform> -- the one carrying the
<pageSet> -- is routinely layout="tb", because that flow breaks pages rather
than placing fields. Read from the document root, "every ancestor must be
position" degrades every field of every LiveCycle form and the feature converts
nothing. So the chain starts BELOW the page-carrying subform, and the design's
rule is then applied to it verbatim. The oracle in a later task is what confirms
this against a real form.

A repeating <occur max> subform contributes the synthetic layout 'occur' and so
degrades: the occurrence count is knowable from the template, the repeat
direction is not. A <breakBefore> naming a pageArea that is not there leaves the
page UNRESOLVED rather than falling back to the running ordinal -- a wrong page
is a field placed perfectly on the wrong sheet.

Measured: folding the root subform into the chain reddens 2; ignoring <occur>
reddens 1; guessing past an unresolvable break target reddens 1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 5: `xfadata.ts` — the `datasets` packet and the template↔data join

**Files:**
- Create: `src/xfadata.ts`
- Test: `test/xfadata.test.ts`

**Interfaces:**
- Consumes: `XmlNode` from `src/xml.js` (type only), `XfaField` from
  `src/xfatemplate.js` (type only).
- Produces:
  - `type XfaValues = ReadonlyMap<string, string | string[]>`
  - `function parseXfaDatasets(root: XmlNode): XfaValues`
  - `function bindFieldValue(field: XfaField, values: XfaValues): string | string[] | undefined`

- [ ] **Step 1: Write the failing test**

Create `test/xfadata.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaDatasets, bindFieldValue } from '../src/xfadata.js';
import type { XfaField } from '../src/xfatemplate.js';

const ds = (inner: string) => parseXfaDatasets(parseXml(
  new TextEncoder().encode(`<datasets><data>${inner}</data></datasets>`),
));

/** A minimal template field; only `name` matters to the join. */
const field = (name: string, extra: Partial<XfaField> = {}): XfaField => ({
  name, ui: 'text', readOnly: false, required: false, multiLine: false,
  geom: {}, layouts: [], offsets: [], ...extra,
});

describe('parseXfaDatasets', () => {
  // The data path is SOM-shaped -- occurrence indices and all -- so the join is
  // a Map lookup on the field's own name rather than a second path grammar.
  it('keys leaf values by their SOM-shaped path', () => {
    const v = ds(`<form1><Page1><f1_01>Bob</f1_01></Page1></form1>`);
    expect(v.get('form1[0].Page1[0].f1_01[0]')).toBe('Bob');
  });

  it('indexes repeated elements from zero, per name', () => {
    const v = ds(`<form1><row><c>a</c></row><row><c>b</c></row></form1>`);
    expect(v.get('form1[0].row[0].c[0]')).toBe('a');
    expect(v.get('form1[0].row[1].c[0]')).toBe('b');
  });

  it('records an empty leaf as an empty string, not as absent', () => {
    const v = ds(`<form1><a/></form1>`);
    expect(v.has('form1[0].a[0]')).toBe(true);
    expect(v.get('form1[0].a[0]')).toBe('');
  });

  // A multi-select list box's value is an array. XFA writes it as repeated
  // <value> children of the leaf.
  it('reads repeated <value> children as an array', () => {
    const v = ds(`<form1><tags><value>a</value><value>b</value></tags></form1>`);
    expect(v.get('form1[0].tags[0]')).toEqual(['a', 'b']);
  });

  it('is empty for a datasets packet with no <data>', () => {
    const v = parseXfaDatasets(parseXml(new TextEncoder().encode('<datasets/>')));
    expect(v.size).toBe(0);
  });

  it('records a leaf whose parent also has element children only at the leaf', () => {
    const v = ds(`<form1><a>text<b>inner</b></a></form1>`);
    expect(v.get('form1[0].a[0].b[0]')).toBe('inner');
    expect(v.has('form1[0].a[0]')).toBe(false);
  });
});

describe('bindFieldValue', () => {
  const values = ds(`<form1><Page1><f1_01>Bob</f1_01><f1_02/></Page1>
    <alt>Other</alt></form1>`);

  it('binds by implicit name match on the SOM path', () => {
    expect(bindFieldValue(field('form1[0].Page1[0].f1_01[0]'), values)).toBe('Bob');
  });

  it('binds an empty datum, which is a value someone cleared', () => {
    expect(bindFieldValue(field('form1[0].Page1[0].f1_02[0]'), values)).toBe('');
  });

  it('binds nothing when no datum matches', () => {
    expect(bindFieldValue(field('form1[0].Page1[0].nope[0]'), values)).toBeUndefined();
  });

  it('follows an explicit bind ref, indices supplied where absent', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindRef: 'form1.alt' }), values,
    )).toBe('Other');
  });

  // match="none" says this field is deliberately unbound. Binding it anyway
  // puts the wrong person's answer in the box.
  it('binds nothing for match="none", even when a datum matches by name', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindMatch: 'none' }), values,
    )).toBeUndefined();
  });

  it('falls back to the implicit match when an explicit ref resolves to nothing', () => {
    expect(bindFieldValue(
      field('form1[0].Page1[0].f1_01[0]', { bindRef: 'form1.missing' }), values,
    )).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfadata.test.ts`
Expected: FAIL — `Failed to resolve import "../src/xfadata.js"`, plus a
typecheck error on `bindRef` / `bindMatch`, which Task 5 adds to `XfaField`.

- [ ] **Step 3: Add the two `<bind>` fields to `XfaField`**

In `src/xfatemplate.ts`, add to the interface and to `fieldOf`:

```ts
  /** `<bind ref="...">`, verbatim. An explicit data path, which outranks the
   *  implicit name match. */
  bindRef?: string;
  /** `<bind match="...">`. `'none'` means deliberately unbound. */
  bindMatch?: string;
```

```ts
  const bind = child(el, 'bind');
  // ... in the returned object:
    ...(bind?.attrs.get('ref') !== undefined ? { bindRef: bind.attrs.get('ref') } : {}),
    ...(bind?.attrs.get('match') !== undefined ? { bindMatch: bind.attrs.get('match') } : {}),
```

Add one case to `test/xfatemplate.test.ts` so the new fields are pinned where
they are produced, not only where they are read:

```ts
  it('carries an explicit <bind> ref and match', () => {
    const t = tpl(`<subform name="f"><field name="a"><ui><textEdit/></ui>
      <bind ref="$record.other" match="dataRef"/></field>
      <field name="b"><ui><textEdit/></ui></field></subform>`);
    const a = by(t.fields, 'f[0].a[0]');
    expect(a.bindRef).toBe('$record.other');
    expect(a.bindMatch).toBe('dataRef');
    expect(by(t.fields, 'f[0].b[0]').bindRef).toBeUndefined();
  });
```

- [ ] **Step 4: Write the implementation**

Create `src/xfadata.ts`:

```ts
/**
 * The XFA `datasets` packet as values by data path, and the rule that joins a
 * template field to a datum.
 *
 * **Invariant: pure, over `xml.js` alone**, and it never throws.
 *
 * **Invariant: the data path is SOM-SHAPED** -- occurrence indices included,
 * built by the same per-name sibling ordinal `xfatemplate.ts` uses. That is
 * what makes the implicit join a Map lookup on the field's own name rather
 * than a second path grammar that could disagree with the first.
 */
import type { XmlNode } from './xml.js';
import type { XfaField } from './xfatemplate.js';

export type XfaValues = ReadonlyMap<string, string | string[]>;

/** A leaf's value: repeated `<value>` children are an array (a multi-select
 *  list box), anything else is the element's own text. */
function leafValue(el: XmlNode): string | string[] {
  const vs = el.children.filter((c) => c.name === 'value');
  if (vs.length > 1) return vs.map((v) => v.text);
  if (vs.length === 1) return vs[0].text;
  return el.text;
}

function collect(el: XmlNode, path: string[], out: Map<string, string | string[]>): void {
  const counts = new Map<string, number>();
  for (const c of el.children) {
    const i = counts.get(c.name) ?? 0;
    counts.set(c.name, i + 1);
    const sub = [...path, `${c.name}[${String(i)}]`];
    // A node with element children other than <value> is a container, and a
    // container carries no value of its own -- recording its concatenated text
    // would invent a datum spanning every field beneath it.
    const containers = c.children.filter((g) => g.name !== 'value');
    if (containers.length === 0) out.set(sub.join('.'), leafValue(c));
    else collect(c, sub, out);
  }
}

/** The `datasets` packet's root to values by SOM-shaped data path. */
export function parseXfaDatasets(root: XmlNode): XfaValues {
  const out = new Map<string, string | string[]>();
  const data = root.name === 'data' ? root : root.children.find((c) => c.name === 'data');
  if (data) collect(data, [], out);
  return out;
}

/** Supply `[0]` for any path step that states no occurrence index, so an
 *  explicit `<bind ref>` written in SOM's abbreviated form still resolves. */
function indexed(path: string): string {
  return path.split('.')
    .map((p) => (p.endsWith(']') ? p : `${p}[0]`))
    .join('.');
}

/**
 * The value a template field takes from the data.
 *
 * `match="none"` is deliberately unbound and binds NOTHING even when a datum
 * matches by name -- binding it anyway puts the wrong answer in the box. An
 * explicit `<bind ref>` outranks the implicit name match, and one that resolves
 * to nothing binds nothing rather than silently falling back: the form stated
 * where this field's data lives, and it is not there.
 */
export function bindFieldValue(
  field: XfaField, values: XfaValues,
): string | string[] | undefined {
  if (field.bindMatch === 'none') return undefined;
  if (field.bindRef !== undefined && field.bindRef !== '') {
    // A leading '$record.' / '$data.' / '$.' names the data root, which is what
    // the paths in `values` are already relative to.
    const ref = field.bindRef.replace(/^\$(?:record|data)?\./, '');
    return values.get(indexed(ref));
  }
  return values.get(field.name);
}
```

> **Note:** the last test in `bindFieldValue` asserts that an unresolvable
> explicit `ref` binds nothing rather than falling back to the name match. The
> function's shape above already does that; do not add a fallback.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/xfadata.test.ts test/xfatemplate.test.ts`
Expected: PASS — 13 in `xfadata`, 31 in `xfatemplate`.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 6: Prove two assertions load-bearing**

| Mutation | Expected red |
|---|---|
| `collect` records a container's own text as well as its leaves | the container case |
| `bindFieldValue` ignores `bindMatch` | the `match="none"` case |

Revert each, confirm green.

- [ ] **Step 7: Commit**

```
feat(6t2v.3): the XFA datasets packet and the template-to-data join

Values are keyed by a SOM-SHAPED data path -- occurrence indices included, built
by the same per-name sibling ordinal xfatemplate.ts uses -- so the implicit join
is a Map lookup on the field's own name rather than a second path grammar that
could disagree with the first.

match="none" binds nothing even when a datum matches by name, because that
attribute is the form saying this field is deliberately unbound; binding it
anyway puts the wrong answer in the box. An explicit <bind ref> outranks the
implicit match and, when it resolves to nothing, binds nothing rather than
falling back -- the form stated where its data lives and it is not there.

A container node records no value of its own: XmlNode.text is the concatenation
of a subtree's text, so recording it would invent a datum spanning every field
beneath it.

Measured: recording container text reddens 1; ignoring match="none" reddens 1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 6: `xfapacket.ts` — `/AcroForm /XFA` to named, parsed packets

This module owns the `parseXml` throw boundary. `parseXml` throws
`PdfParseError` and four other callers depend on that strictness, so the damage
is turned into a value **here** rather than by changing `xml.ts` —
`markdown.ts`'s and `htmltoken.ts`'s "damage is a value, never control flow",
applied at the boundary.

**Files:**
- Create: `src/xfapacket.ts`
- Test: `test/xfapacket.test.ts`

**Interfaces:**
- Consumes: `PdfDict`/`PdfObject` and the guards from `src/types.js`;
  `parseXml`/`XmlNode` from `src/xml.js`; `Resolve` and `Inflate` **types** from
  `src/colorimage.js`. It does **not** import `document.js`.
- Produces:
  - `interface XfaPacketSet { packets: Map<string, XmlNode>; names: string[]; skipped: Array<{ name: string; reason: string }> }`
  - `function decodeXfaPackets(acro: PdfDict | undefined, resolve: Resolve, inflate: Inflate): XfaPacketSet | { reason: string }`

- [ ] **Step 1: Write the failing test**

Create `test/xfapacket.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decodeXfaPackets } from '../src/xfapacket.js';
import {
  isStream, type PdfDict, type PdfObject, type PdfStream,
} from '../src/types.js';

const stream = (s: string): PdfStream => ({
  kind: 'stream', dict: new Map(), raw: new TextEncoder().encode(s),
});
const resolve = (o: PdfObject | undefined): PdfObject => (o ?? null) as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;
const acroWith = (xfa: PdfObject): PdfDict =>
  new Map<string, PdfObject>([['Fields', []], ['XFA', xfa]]);

const TEMPLATE = '<template><subform name="f"/></template>';
const DATASETS = '<xfa:datasets><xfa:data><f/></xfa:data></xfa:datasets>';

describe('decodeXfaPackets: the two /XFA shapes', () => {
  // Shape 1: one stream holding a whole XDP. Its packets are the root's own
  // children, keyed by local name -- xml.ts strips the xfa: prefix.
  it('splits a single XDP stream into its child packets', () => {
    const r = decodeXfaPackets(
      acroWith(stream(`<xdp:xdp>${TEMPLATE}${DATASETS}</xdp:xdp>`)), resolve, inflate,
    );
    expect(r).not.toHaveProperty('reason');
    const set = r as Exclude<typeof r, { reason: string }>;
    expect(set.names).toEqual(['template', 'datasets']);
    expect(set.packets.get('template')!.children[0].attrs.get('name')).toBe('f');
    expect(set.packets.has('datasets')).toBe(true);
  });

  // Shape 2: an array of alternating name/stream pairs, each stream a single
  // well-formed element.
  it('reads the alternating name/stream array', () => {
    const r = decodeXfaPackets(acroWith([
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
      { kind: 'name', name: 'datasets' }, stream(DATASETS),
    ] as PdfObject), resolve, inflate);
    const set = r as Exclude<typeof r, { reason: string }>;
    expect(set.names).toEqual(['template', 'datasets']);
    expect(set.packets.size).toBe(2);
  });

  it('accepts a PdfString name as well as a PdfName', () => {
    const r = decodeXfaPackets(acroWith([
      { kind: 'string', bytes: new TextEncoder().encode('template') }, stream(TEMPLATE),
    ] as PdfObject), resolve, inflate);
    expect((r as { names: string[] }).names).toEqual(['template']);
  });
});

describe('decodeXfaPackets: damage is a value', () => {
  // The XDP wrapper's preamble/postamble are text fragments, not elements.
  // parseXml throws on them; a per-packet failure must cost that packet only.
  it('skips an unparseable packet by name and keeps the rest', () => {
    const r = decodeXfaPackets(acroWith([
      { kind: 'name', name: 'preamble' }, stream('<?xml version="1.0"?><xdp:xdp>'),
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
      { kind: 'name', name: 'postamble' }, stream('</xdp:xdp>'),
    ] as PdfObject), resolve, inflate);
    const set = r as Exclude<typeof r, { reason: string }>;
    expect(set.packets.has('template')).toBe(true);
    expect(set.names).toEqual(['preamble', 'template', 'postamble']);
    expect(set.skipped.map((s) => s.name).sort()).toEqual(['postamble', 'preamble']);
  });

  it('refuses the whole /XFA when the single stream will not parse', () => {
    const r = decodeXfaPackets(acroWith(stream('<xdp:xdp>')), resolve, inflate);
    expect(r).toHaveProperty('reason');
    expect((r as { reason: string }).reason).toMatch(/XFA/i);
  });

  it('refuses an absent /AcroForm, an absent /XFA and an /XFA of the wrong type', () => {
    expect(decodeXfaPackets(undefined, resolve, inflate)).toHaveProperty('reason');
    expect(decodeXfaPackets(new Map([['Fields', []]]), resolve, inflate))
      .toHaveProperty('reason');
    expect(decodeXfaPackets(acroWith(42), resolve, inflate)).toHaveProperty('reason');
  });

  it('skips an array entry whose stream is missing rather than shifting the pairs', () => {
    const r = decodeXfaPackets(acroWith([
      { kind: 'name', name: 'config' }, { kind: 'name', name: 'notAStream' },
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
    ] as PdfObject), resolve, inflate);
    const set = r as Exclude<typeof r, { reason: string }>;
    expect(set.packets.has('template')).toBe(true);
    expect(set.skipped.some((s) => s.name === 'config')).toBe(true);
  });

  it('takes the FIRST of two packets sharing a name and reports the second', () => {
    const r = decodeXfaPackets(acroWith([
      { kind: 'name', name: 'template' }, stream(TEMPLATE),
      { kind: 'name', name: 'template' }, stream('<template><subform name="g"/></template>'),
    ] as PdfObject), resolve, inflate);
    const set = r as Exclude<typeof r, { reason: string }>;
    expect(set.packets.get('template')!.children[0].attrs.get('name')).toBe('f');
    expect(set.skipped).toHaveLength(1);
  });

  it('routes every stream through inflate, never through raw', () => {
    let asked = 0;
    const counting = (s: PdfStream): Uint8Array => { asked += 1; return s.raw; };
    decodeXfaPackets(acroWith(stream(`<xdp:xdp>${TEMPLATE}</xdp:xdp>`)), resolve, counting);
    expect(asked).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfapacket.test.ts`
Expected: FAIL — `Failed to resolve import "../src/xfapacket.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/xfapacket.ts`:

```ts
/**
 * `/AcroForm /XFA` decoded to named packets.
 *
 * `/XFA` is either a SINGLE stream holding a whole XDP document, or an ARRAY of
 * alternating name/stream pairs (`config`, `template`, `datasets`, and the
 * `preamble`/`postamble` fragments of the XDP wrapper). This module owns that
 * duality and nothing else does.
 *
 * **Invariant: it takes `resolve` and `inflate` as ARGUMENTS** rather than
 * importing `document.js` -- the seam `colorimage.ts` and `dfont.ts` already
 * use -- so every rule here is drivable from a hand-built dict.
 *
 * **Invariant: it owns the `parseXml` throw boundary.** `parseXml` throws
 * `PdfParseError` and four other callers depend on that strictness, so damage
 * becomes a value HERE rather than by loosening `xml.ts`. A damaged packet must
 * cost the conversion, never the open.
 *
 * **Invariant: a per-packet failure costs that packet alone.** The XDP
 * wrapper's `preamble` and `postamble` are text fragments rather than elements,
 * so they NEVER parse and are skipped on every array-form document -- refusing
 * the whole `/XFA` for them would refuse every such file.
 */
import { isArray, isName, isStream, isString, type PdfDict, type PdfObject } from './types.js';
import { parseXml, type XmlNode } from './xml.js';
import type { Inflate, Resolve } from './colorimage.js';
import { decodePdfText } from './metadata.js';

export interface XfaPacketSet {
  /** Parsed packets by local name. First wins on a duplicate. */
  packets: Map<string, XmlNode>;
  /** Every packet NAME the /XFA declared, in order, parsed or not. This is what
   *  the report's `packets` field carries: it says what the document holds. */
  names: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/** A packet name from a /XFA array entry: a name object or a string. */
function entryName(o: PdfObject): string | undefined {
  if (isName(o)) return o.name;
  if (isString(o)) return decodePdfText(o.bytes);
  return undefined;
}

/** Parse, or say why not. The one place `parseXml`'s throw is caught. */
function parse(bytes: Uint8Array): XmlNode | { reason: string } {
  try {
    return parseXml(bytes);
  } catch (e) {
    return { reason: e instanceof Error ? e.message : 'XML could not be parsed' };
  }
}

export function decodeXfaPackets(
  acro: PdfDict | undefined, resolve: Resolve, inflate: Inflate,
): XfaPacketSet | { reason: string } {
  if (!acro) return { reason: 'the document has no /AcroForm' };
  const xfa = resolve(acro.get('XFA'));

  const packets = new Map<string, XmlNode>();
  const names: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  const add = (name: string, node: XmlNode | { reason: string }): void => {
    names.push(name);
    if ('reason' in node) { skipped.push({ name, reason: node.reason }); return; }
    if (packets.has(name)) {
      skipped.push({ name, reason: `a second '${name}' packet; the first one is used` });
      return;
    }
    packets.set(name, node);
  };

  if (isStream(xfa)) {
    // One stream, one whole XDP. Its packets are the root's own children --
    // xml.ts strips the xfa: prefix, so <xfa:datasets> arrives as `datasets`.
    const root = parse(inflate(xfa));
    if ('reason' in root)
      return { reason: `the /XFA packet could not be parsed: ${root.reason}` };
    for (const c of root.children) add(c.name, c);
    if (packets.size === 0) return { reason: 'the /XFA packet declares no packets' };
    return { packets, names, skipped };
  }

  if (isArray(xfa)) {
    for (let i = 0; i + 1 < xfa.length; i += 2) {
      const name = entryName(resolve(xfa[i]));
      const s = resolve(xfa[i + 1]);
      if (name === undefined) continue;
      if (!isStream(s)) { names.push(name); skipped.push({ name, reason: 'not a stream' }); continue; }
      add(name, parse(inflate(s)));
    }
    if (names.length === 0) return { reason: 'the /XFA array declares no packets' };
    return { packets, names, skipped };
  }

  return { reason: xfa === null || xfa === undefined
    ? 'the /AcroForm has no /XFA'
    : '/AcroForm /XFA is neither a stream nor an array' };
}
```

> **Note on the duplicate rule:** `add` reports the *second* packet and keeps
> the first. That is arbitrary only in appearance — a document with two
> `template` packets is damaged, and taking the later one would mean the answer
> depends on array order in a file that has already contradicted itself.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run test/xfapacket.test.ts` — Expected: PASS, 9 cases.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Prove two assertions load-bearing**

| Mutation | Expected red |
|---|---|
| let `parse`'s throw escape (remove the `try`) | the preamble/postamble case and the unparseable-single-stream case |
| `add` overwrites on a duplicate name | the two-templates case |

Revert each, confirm green.

- [ ] **Step 6: Commit**

```
feat(6t2v.3): decode /AcroForm /XFA into named packets

/XFA is either a single stream holding a whole XDP or an array of alternating
name/stream pairs; xfapacket.ts owns that duality and nothing else does. It
takes resolve and inflate as arguments rather than importing document.js -- the
colorimage.ts seam -- so every rule is drivable from a hand-built dict.

It also owns the parseXml throw boundary. parseXml throws PdfParseError and four
other callers depend on that strictness, so damage becomes a value here rather
than by loosening xml.ts: a damaged XFA packet costs the conversion, never the
open. And the failure is PER PACKET, which is not a nicety -- the XDP wrapper's
preamble and postamble are text fragments rather than elements, so they never
parse, and refusing the whole /XFA for them would refuse every array-form
document in existence.

Measured: letting the throw escape reddens 2; overwriting on a duplicate packet
name reddens 1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 7: `xfaconvert.ts` — the report types and the plan phase

The plan phase **allocates nothing**. It is `formcreate.ts`'s own rule scaled
from one field to a document: creation validates the whole field path before
allocating any object, so a rejected call leaves the file byte-identical. This
task builds the whole classification and mutates not one byte.

**Files:**
- Create: `src/xfaconvert.ts`
- Create: `test/helpers/build-xfa-pdf.ts`
- Test: `test/xfaconvert.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–6; `Document` (type and value) from
  `src/document.js`; `FieldType`/`classify` from `src/formfield.js`;
  `normalizeOptions`/`NormalizedOption` from `src/choiceopt.js`; the `FF_*`
  constants from `src/fieldflags.js`.
- Produces:
  - `interface XfaConvertOptions { removeXfa?: boolean }`
  - `interface XfaFieldResult { name: string; type: FieldType; route: 'positioned' | 'bare' | 'reconciled'; page?: number }`
  - `interface XfaSkipped { what: 'document' | 'packet' | 'page' | 'field'; name?: string; reason: string }`
  - `interface XfaConvertReport { packets: string[]; fields: XfaFieldResult[]; skipped: XfaSkipped[]; xfaRemoved: boolean; dataOnly: boolean }`
  - `interface XfaPlan { report: XfaConvertReport; entries: PlanEntry[]; groups: GroupPlan[] }` (internal, exported for the test)
  - `function buildXfaPlan(doc: Document, opts: XfaConvertOptions): XfaPlan`

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-xfa-pdf.ts`. One builder, parameterised by the XFA
packets, so every rule-matrix case is one call:

```ts
/** Build a one- or two-page PDF whose /AcroForm carries an /XFA array of
 *  uncompressed packets. The pages are US Letter (612 x 792), which is what
 *  `<medium short="8.5in" long="11in"/>` declares -- so the medium check
 *  passes unless a case deliberately disagrees with it. */
export interface XfaPdfSpec {
  template: string;
  datasets?: string;
  /** Extra packets, name -> body. */
  extra?: Record<string, string>;
  /** Default 1. */
  pages?: number;
  /** Page box; default US Letter. */
  mediaBox?: [number, number, number, number];
  /** Existing /AcroForm /Fields entries, each a complete object body with
   *  refs written by hand. The hybrid case. The single-element shorthand
   *  `['{HYBRID}']` expands to the two-level tree form1[0] -> Page1[0] ->
   *  f1_01[0], the terminal being a real widget with /FT /Tx, a /Rect and a
   *  page /Annots entry -- the shape LiveCycle writes. */
  acroFieldObjects?: string[];
  /** Emit /XFA as a SINGLE XDP stream rather than the name/stream array. */
  singleStream?: boolean;
  /** Set the catalog's /NeedsRendering. */
  needsRendering?: boolean;
}

export function buildXfaPdf(spec: XfaPdfSpec): Uint8Array;
```

Write it in the style of `test/helpers/build-form-pdf.ts`: a `string[]` of
object bodies, byte offsets computed with a `TextEncoder`, a classic xref and a
trailer. Two details are load-bearing and easy to get wrong:

- **`/Length` must be the byte length of the stream payload**, computed with
  `new TextEncoder().encode(s).length`, not `s.length` — XFA packets carry
  non-ASCII often enough that a character count silently truncates them.
- **The pages must be real `/Type /Page` objects with a `/MediaBox`**, because
  the medium check reads `page.CropBox`, which falls back to `MediaBox`.

Also export the three template fragments the rule matrix reuses:

```ts
/** A positioned, single-page template with one text field at 1in, 2in. */
export const POSITIONED_TEMPLATE: string;
/** The same field under a layout="tb" subform, so it must degrade. */
export const FLOWED_TEMPLATE: string;
/** The same page declaring A4 against a US Letter page: the medium mismatch. */
export const WRONG_MEDIUM_TEMPLATE: string;
```

- [ ] **Step 2: Write the failing test**

Create `test/xfaconvert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildXfaPlan } from '../src/xfaconvert.js';
import {
  buildXfaPdf, POSITIONED_TEMPLATE, FLOWED_TEMPLATE, WRONG_MEDIUM_TEMPLATE,
} from './helpers/build-xfa-pdf.js';

const planOf = (bytes: Uint8Array) => buildXfaPlan(Document.Open(bytes), {});

describe('buildXfaPlan: classification', () => {
  it('routes a positioned field to a widget with a rect on its page', () => {
    const p = planOf(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    expect(p.report.fields).toEqual([{
      name: 'form1[0].Page1[0].f1_01[0]', type: 'text', route: 'positioned', page: 1,
    }]);
    expect(p.report.skipped).toEqual([]);
    expect(p.report.dataOnly).toBe(false);
  });

  it('degrades a flow-laid field to bare and says why', () => {
    const p = planOf(buildXfaPdf({ template: FLOWED_TEMPLATE }));
    expect(p.report.fields[0].route).toBe('bare');
    expect(p.report.fields[0].page).toBeUndefined();
    expect(p.report.skipped).toEqual([{
      what: 'field', name: 'form1[0].Page1[0].f1_01[0]',
      reason: expect.stringMatching(/layout/i),
    }]);
    // At least one field converted and NONE got geometry.
    expect(p.report.dataOnly).toBe(true);
  });

  // The correctness anchor: one comparison against a number we did not compute.
  it('degrades EVERY field on a page whose medium disagrees, and reports the page', () => {
    const p = planOf(buildXfaPdf({ template: WRONG_MEDIUM_TEMPLATE }));
    expect(p.report.fields.every((f) => f.route === 'bare')).toBe(true);
    expect(p.report.skipped.filter((s) => s.what === 'page')).toHaveLength(1);
    // One PAGE entry, not one per field: the page is what failed.
    expect(p.report.skipped.filter((s) => s.what === 'field')).toHaveLength(0);
  });

  it('degrades the whole document when the pageArea count disagrees with the pages', () => {
    const p = planOf(buildXfaPdf({ template: POSITIONED_TEMPLATE, pages: 2 }));
    expect(p.report.fields.every((f) => f.route === 'bare')).toBe(true);
    expect(p.report.skipped.some(
      (s) => s.what === 'document' && /pageArea/i.test(s.reason),
    )).toBe(true);
  });

  it('reports dataOnly false for a document that converted nothing at all', () => {
    const p = planOf(buildXfaPdf({ template: '<template/>' }));
    expect(p.report.fields).toEqual([]);
    expect(p.report.dataOnly).toBe(false);
  });
});

describe('buildXfaPlan: types, values and options', () => {
  it('maps each UI kind to its /FT and flags', () => {
    const p = planOf(buildXfaPdf({ template: `<template><subform name="f" layout="position">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="P1" layout="position">
        <field name="t" x="0" y="0" w="1in" h="20pt"><ui><textEdit multiLine="1"/></ui></field>
        <field name="p" x="0" y="1in" w="1in" h="20pt"><ui><passwordEdit/></ui></field>
        <field name="c" x="0" y="2in" w="20pt" h="20pt"><ui><checkButton/></ui></field>
        <field name="l" x="0" y="3in" w="1in" h="20pt"><ui><choiceList/></ui>
          <items save="1"><text>S</text></items><items><text>Small</text></items></field>
        <field name="e" x="0" y="4in" w="1in" h="20pt">
          <ui><choiceList open="userControl"/></ui><items><text>A</text></items></field>
        <field name="m" x="0" y="5in" w="1in" h="20pt">
          <ui><choiceList open="multiSelect"/></ui><items><text>A</text></items></field>
        <field name="b" x="0" y="6in" w="1in" h="20pt"><ui><button/></ui></field>
      </subform></subform></template>` }));
    const by = (n: string) => p.entries.find((e) => e.name === `f[0].P1[0].${n}[0]`)!;
    expect(by('t').ft).toBe('Tx');
    expect(by('t').ff & 0x1000).toBeTruthy();   // FF_MULTILINE
    expect(by('p').ff & 0x2000).toBeTruthy();   // FF_PASSWORD
    expect(by('c').ft).toBe('Btn');
    expect(by('l').ft).toBe('Ch');
    expect(by('l').options).toEqual([{ export: 'S', display: 'Small' }]);
    expect(by('e').ff & 0x20000).toBeTruthy();  // FF_COMBO
    expect(by('e').ff & 0x40000).toBeTruthy();  // FF_EDIT
    expect(by('m').ff & 0x200000).toBeTruthy(); // FF_MULTISELECT
    expect(by('b').ff & 0x10000).toBeTruthy();  // FF_PUSHBUTTON
  });

  it('refuses signature, imageEdit and barcode by name and creates nothing', () => {
    const p = planOf(buildXfaPdf({ template: `<template><subform name="f">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="P1" layout="position">
        <field name="s" x="0" y="0" w="1in" h="20pt"><ui><signature/></ui></field>
        <field name="i" x="0" y="1in" w="1in" h="20pt"><ui><imageEdit/></ui></field>
        <field name="k" x="0" y="2in" w="1in" h="20pt"><ui><barcode/></ui></field>
      </subform></subform></template>` }));
    expect(p.report.fields).toEqual([]);
    expect(p.report.skipped.map((s) => s.name).sort())
      .toEqual(['f[0].P1[0].i[0]', 'f[0].P1[0].k[0]', 'f[0].P1[0].s[0]']);
  });

  // The design's invariant: values come from datasets, the template <value>
  // is /DV. A datum that DIFFERS from the default is what measures it.
  it('takes /V from datasets and /DV from the template default', () => {
    const p = planOf(buildXfaPdf({
      template: `<template><subform name="form1">
        <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
        <subform name="Page1" layout="position">
          <field name="f1_01" x="1in" y="2in" w="3in" h="20pt"><ui><textEdit/></ui>
            <value><text>AUTHORED</text></value></field>
        </subform></subform></template>`,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const e = p.entries[0];
    expect(e.value).toBe('ENTERED');
    expect(e.defaultValue).toBe('AUTHORED');
  });

  it('lists the packets the document holds', () => {
    const p = planOf(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: '<xfa:datasets><xfa:data/></xfa:datasets>',
      extra: { config: '<config/>' },
    }));
    expect(p.report.packets).toEqual(['template', 'datasets', 'config']);
  });

  it('refuses the document with a packet skip when there is no template', () => {
    const p = planOf(buildXfaPdf({ template: '', extra: { config: '<config/>' } }));
    expect(p.entries).toEqual([]);
    expect(p.report.skipped.some((s) => s.what === 'packet')).toBe(true);
  });
});

describe('buildXfaPlan: exclGroup and reconciliation', () => {
  const GROUP = `<template><subform name="form1">
    <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
    <subform name="Page1" layout="position"><exclGroup name="colour">
      <field name="r" x="0" y="0" w="20pt" h="20pt"><ui><checkButton/></ui>
        <items><text>Red</text></items></field>
      <field name="g" x="0" y="1in" w="20pt" h="20pt"><ui><checkButton/></ui>
        <items><text>Green</text></items></field>
    </exclGroup></subform></subform></template>`;

  it('plans one radio group carrying one option per member', () => {
    const p = planOf(buildXfaPdf({ template: GROUP }));
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0].name).toBe('form1[0].Page1[0].colour[0]');
    expect(p.groups[0].options.map((o) => o.export)).toEqual(['Red', 'Green']);
    expect(p.report.fields.map((f) => f.name))
      .toEqual(['form1[0].Page1[0].colour[0]']);
  });

  // Interpretation 5: all-or-nothing. A group with some widgets placed and some
  // not is not a degraded control, it is a broken one.
  it('sends the WHOLE group bare when any member lacks geometry', () => {
    const p = planOf(buildXfaPdf({
      template: GROUP.replace('<field name="g" x="0" y="1in"', '<field name="g" x="0" y="1px"'),
    }));
    expect(p.groups).toEqual([]);
    expect(p.report.fields).toEqual([
      { name: 'form1[0].Page1[0].colour[0]', type: 'radio', route: 'bare' },
    ]);
  });

  it('reconciles a field the AcroForm already has instead of creating one', () => {
    const p = planOf(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
      acroFieldObjects: ['{HYBRID}'],
    }));
    expect(p.report.fields[0].route).toBe('reconciled');
    expect(p.entries[0].value).toBe('ENTERED');
  });
});

describe('buildXfaPlan: it allocates nothing', () => {
  it('leaves the document byte-identical', () => {
    const bytes = buildXfaPdf({ template: POSITIONED_TEMPLATE });
    const a = Document.Open(bytes);
    const before = a.Save();
    buildXfaPlan(a, {});
    expect(a.Save()).toEqual(before);
  });
});
```

> The `acroFieldObjects` case above needs the builder to emit a real nested
> field tree. What it must produce is an existing terminal field whose **full
> name is exactly the SOM path** `form1[0].Page1[0].f1_01[0]`, carrying a
> `/Rect` — so that Task 8 can assert that reconciliation leaves that rect
> alone. Implement `{HYBRID}` as a substitution inside `buildXfaPdf`, so the
> object numbers stay the builder’s business.

- [ ] **Step 3: Run the test and verify it fails**

Run: `npx vitest run test/xfaconvert.test.ts`
Expected: FAIL — `Failed to resolve import "../src/xfaconvert.js"`.

- [ ] **Step 4: Write the implementation**

Create `src/xfaconvert.ts` with the report types and `buildXfaPlan`. The plan
entry shapes:

```ts
/** One field the plan will create or update. Nothing here is allocated. */
export interface PlanEntry {
  name: string;
  type: FieldType;
  ft: string;
  ff: number;
  /** Present only for a positioned field. */
  page?: number;
  rect?: [number, number, number, number];
  value?: string | string[];
  defaultValue?: string;
  options?: NormalizedOption[];
  maxLen?: number;
  tooltip?: string;
  onState?: string;
  /** True when this field already exists in the AcroForm: update /V, create
   *  nothing, leave its geometry alone. */
  reconcile: boolean;
}

/** One `<exclGroup>` planned as a radio group. Present only when EVERY member
 *  earned geometry -- see plan Interpretation 5. */
export interface GroupPlan {
  name: string;
  options: Array<{ page: number; rect: [number, number, number, number]; export: string }>;
  selected?: string;
  readOnly: boolean;
  required: boolean;
  reconcile: boolean;
}

export interface XfaPlan {
  report: XfaConvertReport;
  entries: PlanEntry[];
  groups: GroupPlan[];
}
```

The body, in order — each step appends to `report.skipped` and returns early
only where there is nothing left to plan:

1. `decodeXfaPackets(doc.resolve(doc.catalog().get('AcroForm')) as PdfDict, o => doc.resolve(o), s => inflateStream(s))`.
   A `reason` becomes one `{ what: 'document', reason }` and an empty plan.
   Otherwise `report.packets = names`, and each `skipped` packet becomes
   `{ what: 'packet', name, reason }`.
2. No `template` packet → `{ what: 'packet', name: 'template', reason: 'no template packet' }`, empty plan.
3. `parseXfaTemplate(templateNode)`; `parseXfaDatasets(datasetsNode)` or an
   empty map when there is no `datasets` packet.
4. **Page identity.** If `tpl.pages.length !== doc.Pages.length`, record
   `{ what: 'document', reason: \`the template declares ${n} pageArea(s) and the document has ${m} page(s)\` }`
   and set a document-wide `noGeometry` flag. **Do not align them by guess.**
5. **Per-page medium.** For each `i` where geometry is still possible, compute
   `mediumAgrees(tpl.pages[i].medium, doc.Pages[i].CropBox)`. A page that
   disagrees records ONE `{ what: 'page', reason }` — never one per field — and
   joins a `badPages` set.
6. **Per field.** Skip and report `signature`/`imageEdit`/`barcode`/`unknown`.
   Map the UI kind to `{ ft, ff }` per the spec's table, OR in `FF_READONLY` /
   `FF_REQUIRED`. Bind the value. Normalize `items` through
   `normalizeOptions`. Then geometry: bare when `noGeometry`, when
   `pageIndex === undefined`, when the page is in `badPages`, when
   `!chainIsPositioned(f.layouts)`, or when `boxFor` returns a `reason` —
   each recording `{ what: 'field', name, reason }` **except** the
   `badPages` case, whose page already reported. Otherwise
   `rect = rectFromBox(box, doc.Pages[pageIndex].CropBox)`.
7. **Groups.** Collect fields carrying `group`. A group whose members all have
   rects becomes a `GroupPlan`; otherwise it becomes ONE bare `PlanEntry` of
   type `radio` and its members contribute no entries of their own.
8. **Reconcile.** Build `new Map(doc.Form.Fields.map((f) => [f.FullName, f]))`
   once, and set `reconcile` on any entry or group whose name is in it.
9. `report.dataOnly = report.fields.length > 0 && report.fields.every((f) => f.route !== 'positioned')`.

Two details that are easy to get wrong and are pinned by the tests above:

- **`dataOnly` is `false` for a document that converted nothing.** "Converted to
  data and renders nothing" and "converted nothing at all" are different
  answers and must not read as the same one.
- **A `reconciled` field is reported with `route: 'reconciled'` and no `page`**,
  whatever geometry the template gave it — its geometry is left alone.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `npx vitest run test/xfaconvert.test.ts` — Expected: PASS, 13 cases.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 6: Prove four assertions load-bearing**

| Mutation | Expected red |
|---|---|
| skip the `mediumAgrees` check entirely | the medium case |
| align a mismatched pageArea count by `Math.min` instead of degrading | the page-count case |
| a partly-positioned `exclGroup` keeps its placed members | the all-or-nothing case |
| `dataOnly = report.fields.every(...)` without the `length > 0` guard | the converted-nothing case |

Revert each, confirm green.

- [ ] **Step 7: Commit**

```
feat(6t2v.3): the XFA conversion plan, built before anything is allocated

buildXfaPlan decodes the packets, models the template, binds the data, computes
every rect and classifies every field as positioned / bare / reconciled /
refused -- ALLOCATING NOTHING. That is formcreate.ts's own rule scaled from one
field to a document: a form we cannot convert leaves the file byte-identical,
which is asserted directly by saving before and after.

A page whose <medium> disagrees with its CropBox by more than 1pt degrades EVERY
field on it and reports ONCE, as a page rather than as a field per field: the
page is what failed. A pageArea count that disagrees with the document's page
count degrades the whole document's geometry rather than aligning the two by
guess -- a field placed perfectly on the wrong sheet looks right and is wrong.

An exclGroup is all-or-nothing: if any member lacks geometry the whole group
goes bare, because a radio group with some widgets placed and some not is not a
degraded control but a broken one.

dataOnly distinguishes "converted to data and renders nothing" from "converted
nothing at all", which are different answers and must not read as the same one.

Measured: neutering the medium check, aligning a mismatched page count,
half-placing a group, and dropping dataOnly's length guard each redden exactly
the case named for them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 8: `xfaconvert.ts` — apply: reconciles and bare fields

**Files:**
- Modify: `src/xfaconvert.ts`
- Test: `test/xfaconvert.test.ts` (append; the 13 Task 7 cases stay green
  unedited)

**Interfaces:**
- Consumes: Task 7's `XfaPlan` / `PlanEntry` / `GroupPlan`;
  `ensureAcroForm` / `resolvePath` / `nameParts` from `src/formcreate.js`;
  `optArray` from `src/choiceopt.js`; `encodePdfText` from `src/metadata.js`.
- Produces:
  - `function convertXfaToAcroForm(doc: Document, opts?: XfaConvertOptions): XfaConvertReport`

  Task 9 extends the same function with the positioned route and the `/XFA`
  removal; this task ships it handling reconciles and bare fields only, with
  positioned entries applied **as bare** and re-reported as `'bare'` so the
  suite is honest at every commit. Task 9's first step is to delete that
  temporary downgrade.

- [ ] **Step 1: Write the failing test**

Append to `test/xfaconvert.test.ts`:

```ts
import { convertXfaToAcroForm } from '../src/xfaconvert.js';

describe('convertXfaToAcroForm: bare fields', () => {
  const bare = () => {
    const doc = Document.Open(buildXfaPdf({
      template: FLOWED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    return { doc, report };
  };

  it('creates a field the Form walk finds, at its full SOM name', () => {
    const { doc } = bare();
    const f = doc.Form.Get('form1[0].Page1[0].f1_01[0]');
    expect(f).toBeDefined();
    expect(f!.Type).toBe('text');
    expect(f!.Value).toBe('ENTERED');
  });

  // A bare field is a FIELD, not an annotation. A /Subtype /Widget with no
  // /Rect is a malformed annotation; no widget at all is a perfectly legal
  // geometry-less field.
  it('gives it no /Subtype, no /Rect, no /P and no page /Annots entry', () => {
    const { doc } = bare();
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    expect(d.has('Subtype')).toBe(false);
    expect(d.has('Rect')).toBe(false);
    expect(d.has('P')).toBe(false);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots'));
    expect(Array.isArray(annots) ? annots.length : 0).toBe(0);
  });

  it('builds the intermediate nodes the SOM path names', () => {
    const { doc } = bare();
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    const roots = doc.resolve(acro.get('Fields') as never) as unknown[];
    expect(roots).toHaveLength(1);
    const top = doc.resolve(roots[0] as never) as Map<string, unknown>;
    expect(doc.resolve(top.get('T') as never)).toBeDefined();
  });

  it('survives a save and reopen', () => {
    const { doc } = bare();
    const again = Document.Open(doc.Save());
    expect(again.Form.Get('form1[0].Page1[0].f1_01[0]')!.Value).toBe('ENTERED');
  });

  it('writes /DV from the template default and /V from the data', () => {
    const doc = Document.Open(buildXfaPdf({
      template: FLOWED_TEMPLATE.replace('<ui><textEdit/></ui>',
        '<ui><textEdit/></ui><value><text>AUTHORED</text></value>'),
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    const str = (o: unknown) => new TextDecoder().decode((o as { bytes: Uint8Array }).bytes);
    expect(str(doc.resolve(d.get('V') as never))).toBe('ENTERED');
    expect(str(doc.resolve(d.get('DV') as never))).toBe('AUTHORED');
  });

  it('writes /Opt through choiceopt so both halves of a pair survive', () => {
    const doc = Document.Open(buildXfaPdf({ template: `<template><subform name="f">
      <subform name="P" layout="tb"><field name="c"><ui><choiceList/></ui>
        <items save="1"><text>S</text></items>
        <items><text>Small</text></items></field></subform></subform></template>` }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const opt = doc.resolve(doc.Form.Get('f[0].P[0].c[0]')!.Dict.get('Opt') as never);
    expect(Array.isArray(opt)).toBe(true);
    expect((opt as unknown[])).toHaveLength(1);
    // An [export, display] pair, not a bare string.
    expect(Array.isArray(doc.resolve((opt as unknown[])[0] as never))).toBe(true);
  });
});

describe('convertXfaToAcroForm: reconciliation', () => {
  it('updates an existing field /V and creates nothing', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
      acroFieldObjects: ['{HYBRID}'],
    }));
    const before = doc.Form.Fields.length;
    const rect = [...(doc.resolve(
      doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict.get('Rect') as never,
    ) as number[])];
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields[0].route).toBe('reconciled');
    expect(doc.Form.Fields).toHaveLength(before);
    expect(doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Value).toBe('ENTERED');
    // Its geometry is LEFT ALONE -- the AcroForm half is already authoritative.
    expect(doc.resolve(
      doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict.get('Rect') as never,
    )).toEqual(rect);
  });

  it('leaves an existing field with no matching datum untouched', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE, acroFieldObjects: ['{HYBRID}'],
    }));
    const before = doc.Save();
    convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Save()).toEqual(before);
  });
});

describe('convertXfaToAcroForm: refusals', () => {
  it('returns a report rather than throwing for a document with no /XFA', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    const before = doc.Save();
    const report = convertXfaToAcroForm(doc);
    expect(report.fields).toEqual([]);
    expect(report.skipped[0].what).toBe('document');
    expect(report.xfaRemoved).toBe(false);
    // The byte-identity fence: a call that converts nothing changes nothing.
    expect(doc.Save()).toEqual(before);
  });

  it('throws UnsupportedFeatureError on a signed document', () => {
    // Sign first, then attempt the conversion.
    const doc = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    // ... sign with test/helpers/build-signer.ts, save, reopen ...
    expect(() => convertXfaToAcroForm(signed)).toThrow(UnsupportedFeatureError);
  });
});
```

Add the two imports the new cases need at the top of the file:
`PageFormat` from `../src/pageformat.js` and `UnsupportedFeatureError` from
`../src/errors.js`, plus `buildSigner` from `./helpers/build-signer.js` — copy
the signing lines from `test/page-mode.test.ts`, which already signs a document
to prove a no-op does not perturb the incremental path.

`acroFieldObjects` and its `{HYBRID}` shorthand were added to `buildXfaPdf` in
Task 7; nothing new is needed here.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfaconvert.test.ts`
Expected: FAIL — `convertXfaToAcroForm is not a function`. The 13 plan cases
still pass.

- [ ] **Step 3: Write the implementation**

Append to `src/xfaconvert.ts`:

```ts
/** A PdfString carrying a PDF text string. */
const pdfText = (s: string): PdfObject => ({ kind: 'string', bytes: encodePdfText(s) });

/** A plan entry's value and default as dict entries. `/V` comes from the data
 *  and `/DV` from the template -- conflating them destroys the difference
 *  between what a form was authored with and what someone entered. */
function valueEntries(e: PlanEntry): Array<[string, PdfObject]> {
  const out: Array<[string, PdfObject]> = [];
  if (e.value !== undefined)
    out.push(['V', Array.isArray(e.value) ? e.value.map(pdfText) : pdfText(e.value)]);
  if (e.defaultValue !== undefined) out.push(['DV', pdfText(e.defaultValue)]);
  return out;
}

/**
 * A geometry-less field: a field dict with NO `/Subtype /Widget`, no `/Rect`
 * and no `/P`, wired into the tree at its SOM path.
 *
 * It is appended through `resolvePath(...).container.push(ref)` -- what
 * `createField` itself does -- and NOT through `appendField`, which appends to
 * `/AcroForm /Fields` directly and so would flatten every hierarchical SOM
 * path onto the root.
 */
function applyBare(doc: Document, acro: PdfDict, e: PlanEntry): boolean {
  // Validate the whole path first, then apply -- creating intermediate nodes
  // allocates, and a fused pass strands orphan nodes on a conflict found deeper.
  try {
    resolvePath(doc, acro, e.name, false);
  } catch {
    return false;
  }
  const path = resolvePath(doc, acro, e.name, true);
  const dict: PdfDict = new Map<string, PdfObject>([
    ['FT', name(e.ft)], ['T', pdfText(path.partial)],
  ]);
  if (e.ff !== 0) dict.set('Ff', e.ff);
  if (path.parent) dict.set('Parent', path.parent);
  for (const [k, v] of valueEntries(e)) dict.set(k, v);
  if (e.options) dict.set('Opt', optArray(e.options));
  if (e.maxLen !== undefined) dict.set('MaxLen', e.maxLen);
  if (e.tooltip !== undefined) dict.set('TU', pdfText(e.tooltip));
  path.container.push(doc.allocObject(dict));
  return true;
}

/** Update an existing field's `/V` from the data and touch nothing else. Its
 *  geometry and appearance are already authoritative -- that is what makes the
 *  hybrid case fall out of name equality rather than a second code path. */
function applyReconcile(doc: Document, e: PlanEntry): void {
  if (e.value === undefined) return;
  const f = doc.Form.Get(e.name);
  if (!f) return;
  f.Value = e.value;
}
```

and the entry point:

```ts
export function convertXfaToAcroForm(
  doc: Document, opts: XfaConvertOptions = {},
): XfaConvertReport {
  // The one throw. docmdp.ts permits /AcroForm /Fields to change for FILLING,
  // and adding two hundred fields is not filling -- a certification would read
  // as violated, so refusing is honest where producing a document whose
  // signature silently fails is not.
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'ConvertXfaToAcroForm: the document is signed; adding fields would '
      + 'invalidate the signature');
  }

  const plan = buildXfaPlan(doc, opts);
  if (plan.entries.length === 0 && plan.groups.length === 0) return plan.report;

  const acro = ensureAcroForm(doc);
  for (const e of plan.entries) {
    if (e.reconcile) { applyReconcile(doc, e); continue; }
    if (!applyBare(doc, acro, e)) {
      plan.report.skipped.push({
        what: 'field', name: e.name, reason: 'the field name conflicts with the existing tree',
      });
      const i = plan.report.fields.findIndex((f) => f.name === e.name);
      if (i >= 0) plan.report.fields.splice(i, 1);
    }
  }
  doc.markModified();
  return plan.report;
}
```

> **Note:** the signed check runs **before** `buildXfaPlan`, so a rejected call
> does no work at all — the ordering `convertColors` uses.
>
> **Note:** `applyBare` calls `resolvePath` twice on purpose. The validation
> pass mutates nothing; the create pass allocates the intermediate nodes. A
> single fused pass strands orphan nodes when a conflict is found deeper down,
> which is `formcreate.ts`'s own recorded rule.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/xfaconvert.test.ts` — Expected: PASS, 23 cases.
Run: `npm test` — Expected: the whole suite green; `git diff` on the fence
files empty.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Prove three assertions load-bearing**

| Mutation | Expected red |
|---|---|
| `applyBare` sets `/Subtype /Widget` and a `[0 0 0 0]` `/Rect` | the no-Subtype case |
| replace `resolvePath(...).container.push` with `appendField(doc, acro, ref)` | the intermediate-nodes case and the `Form.Get` case |
| `applyReconcile` also rewrites the field's `/Rect` from the plan | the geometry-left-alone case |

Revert each, confirm green.

- [ ] **Step 6: Commit**

```
feat(6t2v.3): apply the XFA plan for reconciled and geometry-less fields

A flow-laid field becomes a real /AcroForm field dict at its full SOM name, with
no /Subtype /Widget, no /Rect, no /P and no page /Annots entry -- a widget with
no rect is a malformed annotation, while no widget at all is a perfectly legal
geometry-less field that doc.Form finds, fills and exports.

It is appended through resolvePath(...).container.push, which is what
createField itself does, and NOT through appendField: that one appends to
/AcroForm /Fields directly and would flatten every hierarchical SOM path onto
the root. resolvePath is called twice -- validate, then create -- because
creating intermediate nodes allocates and a fused pass strands orphans on a
conflict found deeper down.

The hybrid case falls out of name equality: where a field of that full name
already exists, its /V is updated from the datasets packet and its geometry is
left entirely alone, because the AcroForm half of a static form is already
authoritative.

The signed refusal runs BEFORE the plan is built, so a rejected call does no
work at all.

Measured: giving a bare field a widget subtype and rect, appending through
appendField, and letting reconciliation rewrite a rect each redden exactly the
cases named for them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 9: `xfaconvert.ts` — apply: positioned widgets, radio groups and `/XFA` removal

**Files:**
- Modify: `src/xfaconvert.ts`
- Test: `test/xfaconvert.test.ts` (append; Tasks 7–8's 23 cases stay green
  unedited, except that the temporary downgrade of Task 8 is now gone, so any
  case asserting `'bare'` for a *positioned* template must already have been
  written against `FLOWED_TEMPLATE` — check that first)

**Interfaces:**
- Consumes: Task 8's apply half; `createField` / `addRadioGroup` /
  `RadioOption` / `FieldSpec` / `FieldInit` from `src/formcreate.js`.
- Produces: no new exported name. `convertXfaToAcroForm` is complete after this
  task.

- [ ] **Step 1: Delete the Task 8 downgrade**

Remove the temporary "apply a positioned entry as bare" branch and its
`route: 'bare'` re-report. Run `npx vitest run test/xfaconvert.test.ts` and
confirm the positioned cases now fail rather than silently passing as bare —
that failure is the starting point for this task.

- [ ] **Step 2: Write the failing test**

Append to `test/xfaconvert.test.ts`:

```ts
describe('convertXfaToAcroForm: positioned widgets', () => {
  const placed = () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    return { doc, report };
  };

  // POSITIONED_TEMPLATE places its field at x=1in, y=2in, w=3in, h=20pt on a
  // 612 x 792 page, so the rect is [72, 700, 288, 720] after the y-flip.
  it('creates a widget with the rect the template states', () => {
    const { doc, report } = placed();
    expect(report.fields[0]).toEqual({
      name: 'form1[0].Page1[0].f1_01[0]', type: 'text', route: 'positioned', page: 1,
    });
    const d = doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict;
    expect(doc.resolve(d.get('Rect') as never)).toEqual([72, 700, 288, 720]);
    expect((doc.resolve(d.get('Subtype') as never) as { name: string }).name)
      .toBe('Widget');
  });

  it('wires the widget into the page /Annots and generates an /AP', () => {
    const { doc } = placed();
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots') as never) as unknown[];
    expect(annots).toHaveLength(1);
    expect(doc.Form.Get('form1[0].Page1[0].f1_01[0]')!.Dict.has('AP')).toBe(true);
  });

  it('draws the datasets value, not the template default', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE.replace('<ui><textEdit/></ui>',
        '<ui><textEdit/></ui><value><text>AUTHORED</text></value>'),
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f1_01>ENTERED</f1_01>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    const svg = doc.Pages[0].ToSvg();
    expect(svg).toContain('ENTERED');
    expect(svg).not.toContain('AUTHORED');
  });

  it('a rejected field costs itself and the rest still convert', () => {
    const doc = Document.Open(buildXfaPdf({ template: `<template><subform name="form1">
      <pageSet><pageArea name="P"><medium short="8.5in" long="11in"/></pageArea></pageSet>
      <subform name="Page1" layout="position">
        <field name="ok" x="1in" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
        <field name="bad" x="1px" y="1in" w="1in" h="20pt"><ui><textEdit/></ui></field>
      </subform></subform></template>` }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields.find((f) => f.name.endsWith('ok[0]'))!.route).toBe('positioned');
    expect(report.fields.find((f) => f.name.endsWith('bad[0]'))!.route).toBe('bare');
    expect(report.skipped.some((s) => /unit|measurement/i.test(s.reason))).toBe(true);
  });
});

describe('convertXfaToAcroForm: radio groups', () => {
  it('creates one radio field with one kid widget per option', () => {
    const doc = Document.Open(buildXfaPdf({ template: GROUP_TEMPLATE }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields).toEqual([{
      name: 'form1[0].Page1[0].colour[0]', type: 'radio', route: 'positioned', page: 1,
    }]);
    const f = doc.Form.Get('form1[0].Page1[0].colour[0]')!;
    expect(f.Type).toBe('radio');
    expect(f.Options).toEqual(['Red', 'Green']);
    const annots = doc.resolve(doc.Pages[0].Dict.get('Annots') as never) as unknown[];
    expect(annots).toHaveLength(2);
  });

  it('selects the option the data names', () => {
    const doc = Document.Open(buildXfaPdf({
      template: GROUP_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><colour>Green</colour>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Form.Get('form1[0].Page1[0].colour[0]')!.Value).toBe('Green');
  });

  it('degrades to bare rather than throwing when the data names no option', () => {
    const doc = Document.Open(buildXfaPdf({
      template: GROUP_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><colour>Purple</colour>
        </Page1></form1></xfa:data></xfa:datasets>`,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.fields[0].route).toBe('positioned');
    // The group is created with nothing selected and the loss is reported.
    expect(doc.Form.Get('form1[0].Page1[0].colour[0]')!.Value).toBe('Off');
    expect(report.skipped.some((s) => /Purple/.test(s.reason))).toBe(true);
  });
});

describe('convertXfaToAcroForm: /XFA removal', () => {
  it('removes /XFA and /NeedsRendering by default and says so', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE, needsRendering: true,
    }));
    const report = convertXfaToAcroForm(doc);
    expect(report.xfaRemoved).toBe(true);
    const acro = doc.resolve(doc.catalog().get('AcroForm') as never) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(false);
    expect(doc.catalog().has('NeedsRendering')).toBe(false);
    // Save()'s mark-sweep is what actually drops the packet streams.
    expect(new TextDecoder().decode(doc.Save())).not.toContain('<template');
  });

  it('keeps both under removeXfa: false', () => {
    const doc = Document.Open(buildXfaPdf({
      template: POSITIONED_TEMPLATE, needsRendering: true,
    }));
    const report = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(report.xfaRemoved).toBe(false);
    const acro = doc.resolve(doc.catalog().get('AcroForm') as never) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(true);
    expect(doc.catalog().has('NeedsRendering')).toBe(true);
  });

  // Removal is one-way and discards the only description of anything refused,
  // so a conversion that converted nothing must not throw the packet away.
  it('does not remove /XFA when nothing converted', () => {
    const doc = Document.Open(buildXfaPdf({ template: '<template/>' }));
    const report = convertXfaToAcroForm(doc);
    expect(report.xfaRemoved).toBe(false);
    const acro = doc.resolve(doc.catalog().get('AcroForm') as never) as Map<string, unknown>;
    expect(acro.has('XFA')).toBe(true);
  });
});
```

Export `GROUP_TEMPLATE` from `test/helpers/build-xfa-pdf.ts` — the `exclGroup`
fragment from Task 7's test, hoisted so both files use one definition.

- [ ] **Step 3: Write the implementation**

Add to `src/xfaconvert.ts`:

```ts
/** The per-type half of a positioned field, in `createField`'s vocabulary. */
function specFor(e: PlanEntry): FieldSpec {
  const entries: Array<[string, PdfObject]> = [...valueEntries(e)];
  if (e.options) entries.push(['Opt', optArray(e.options)]);
  if (e.maxLen !== undefined) entries.push(['MaxLen', e.maxLen]);
  if (e.tooltip !== undefined) entries.push(['TU', pdfText(e.tooltip)]);
  // A checkbox carries its on-state in /AS, and buildButtonAP keys the /AP by
  // the export name the caller chose rather than by synthOnState's guess --
  // which is exactly the case an unchecked box with a custom export exposes.
  if (e.ft === 'Btn' && e.onState !== undefined) {
    const on = e.value === e.onState ? e.onState : 'Off';
    entries.push(['V', name(on)], ['AS', name(on)]);
  }
  return {
    ft: e.ft,
    ...(e.ff !== 0 ? { ff: e.ff } : {}),
    entries,
    ...(e.ft === 'Btn' && e.onState !== undefined
      ? { buildAP: (d, dict, acro) => buildButtonAP(d, dict, e.onState!, 'checkbox', resolveDA(d, dict, acro)) }
      : {}),
  };
}

/** One positioned field through `createField`, so the widget dict, the /AP
 *  generation and the page /Annots wiring are all reused rather than
 *  rewritten. Returns false when it declined, which costs that field alone. */
function applyPositioned(doc: Document, e: PlanEntry): boolean {
  try {
    createField(doc, {
      page: e.page!, rect: e.rect!, name: e.name,
      readOnly: (e.ff & FF_READONLY) !== 0,
      required: (e.ff & FF_REQUIRED) !== 0,
    }, specFor(e));
    return true;
  } catch {
    return false;
  }
}
```

For a group, `addRadioGroup` validates every option before allocating anything
and throws `RangeError` for a `selected` naming no option — so the selection is
checked here first and dropped with a report entry rather than losing the whole
group:

```ts
function applyGroup(doc: Document, g: GroupPlan, report: XfaConvertReport): boolean {
  const exports = g.options.map((o) => o.export);
  let selected = g.selected;
  if (selected !== undefined && !exports.includes(selected)) {
    report.skipped.push({
      what: 'field', name: g.name,
      reason: `the data names '${selected}', which is not one of this group's options`,
    });
    selected = undefined;
  }
  try {
    addRadioGroup(doc, {
      name: g.name,
      options: g.options.map((o) => ({ page: o.page, rect: o.rect, export: o.export })),
      ...(selected !== undefined ? { selected } : {}),
      readOnly: g.readOnly, required: g.required,
    });
    return true;
  } catch {
    return false;
  }
}
```

Extend `convertXfaToAcroForm`'s apply loop, in the spec's order —
`ensureAcroForm`, then reconciles, then creations, then the removal:

```ts
  const acro = ensureAcroForm(doc);

  for (const e of plan.entries) if (e.reconcile) applyReconcile(doc, e);

  let created = 0;
  for (const e of plan.entries) {
    if (e.reconcile) continue;
    const ok = e.rect !== undefined ? applyPositioned(doc, e) : applyBare(doc, acro, e);
    if (ok) { created += 1; continue; }
    // A field that would not create degrades rather than aborting the run: if
    // it was positioned, try it bare before giving up on it entirely.
    const bare = e.rect !== undefined && applyBare(doc, acro, { ...e, rect: undefined, page: undefined });
    const i = plan.report.fields.findIndex((f) => f.name === e.name);
    if (bare && i >= 0) { plan.report.fields[i] = { name: e.name, type: e.type, route: 'bare' }; created += 1; }
    else if (i >= 0) plan.report.fields.splice(i, 1);
    plan.report.skipped.push({
      what: 'field', name: e.name,
      reason: bare ? 'the widget could not be created; the field carries no geometry'
        : 'the field name conflicts with the existing tree',
    });
  }

  for (const g of plan.groups) {
    if (g.reconcile) continue;
    if (applyGroup(doc, g, plan.report)) { created += 1; continue; }
    const i = plan.report.fields.findIndex((f) => f.name === g.name);
    if (i >= 0) plan.report.fields.splice(i, 1);
    plan.report.skipped.push({ what: 'field', name: g.name, reason: 'the radio group could not be created' });
  }

  // Removal is ONE-WAY and discards the only description of anything refused,
  // so it happens only when something actually converted. It destroys nothing
  // immediately -- it orphans the packet streams, and Save()'s mark-sweep is
  // what drops them, so a caller who dislikes the report can simply not save.
  const removeXfa = opts.removeXfa !== false;
  if (removeXfa && created > 0) {
    acro.delete('XFA');
    doc.catalog().delete('NeedsRendering');
    plan.report.xfaRemoved = true;
  }
  doc.markModified();
  return plan.report;
```

> **Note:** `dataOnly` was computed in the plan phase, before any field was
> downgraded here. **Recompute it after the apply loop**, from
> `report.fields`, or a field that fell back to bare leaves the flag saying the
> document renders when it does not.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/xfaconvert.test.ts` — Expected: PASS, 33 cases.
Run: `npm test` — Expected: the whole suite green.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 5: Prove three assertions load-bearing**

| Mutation | Expected red |
|---|---|
| remove `/XFA` unconditionally, ignoring `created > 0` | the converted-nothing case |
| `applyGroup` passes an unvalidated `selected` straight to `addRadioGroup` | the Purple case (it throws and the group is lost) |
| `specFor` uses `e.defaultValue` for a positioned field's `/V` | the ToSvg case |

Revert each, confirm green.

- [ ] **Step 6: Commit**

```
feat(6t2v.3): apply positioned widgets, radio groups and the /XFA removal

A field whose whole layout chain is positioned goes through createField, and an
exclGroup through addRadioGroup -- so the widget dict, the /AP generation and
the page /Annots wiring are reused rather than rewritten, and a converted
document's fields render and fill exactly like authored ones.

A field that will not create costs itself: it falls back to geometry-less and is
reported, rather than aborting a run of two hundred. A radio selection the data
names but the group does not offer is dropped with a report entry, because
addRadioGroup rejects it and losing the whole control over one stale datum is
the worse answer.

/XFA and /NeedsRendering go only when something actually converted. Removal is
one-way and discards the only description of everything refused, so a conversion
that converted nothing must not throw the packet away. It destroys nothing
immediately either -- it orphans the packet streams and Save()'s mark-sweep is
what drops them, so a caller who dislikes the report can simply not save.

Measured: removing /XFA unconditionally, passing an unvalidated selection to
addRadioGroup, and drawing the template default instead of the entered value
each redden exactly the case named for them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 10: the public surface — `Document.ConvertXfaToAcroForm` and `index.ts`

**Files:**
- Modify: `src/document.ts` (one method, beside `ConvertToGrayscale` ~line 1654)
- Modify: `src/index.ts` (type exports, beside the `colorconvert.js` block ~line 239)
- Test: `test/xfa-public-api.test.ts`

**Interfaces:**
- Consumes: `convertXfaToAcroForm` and the report types from
  `src/xfaconvert.js`.
- Produces:
  - `Document.prototype.ConvertXfaToAcroForm(opts?: XfaConvertOptions): XfaConvertReport`
  - `index.ts` exports `XfaConvertOptions`, `XfaConvertReport`,
    `XfaFieldResult`, `XfaSkipped` **as types only**, and nothing else from
    this feature.

- [ ] **Step 1: Write the failing test**

Create `test/xfa-public-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as api from '../src/index.js';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { buildXfaPdf, POSITIONED_TEMPLATE } from './helpers/build-xfa-pdf.js';

describe('the XFA public surface', () => {
  it('is reachable from the Document facade', () => {
    const doc = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    const report = doc.ConvertXfaToAcroForm();
    expect(report.fields).toHaveLength(1);
    expect(report.xfaRemoved).toBe(true);
  });

  it('defaults removeXfa to true and honours false', () => {
    const keep = Document.Open(buildXfaPdf({ template: POSITIONED_TEMPLATE }));
    expect(keep.ConvertXfaToAcroForm({ removeXfa: false }).xfaRemoved).toBe(false);
  });

  // The packet, template and data models stay INTERNAL until a caller asks for
  // them -- the posture parseHtmlFragment takes. Asserted by name so the
  // absence is a decision the suite enforces rather than an oversight.
  it('exports the entry point types and none of the internals', () => {
    for (const absent of [
      'parseXfaTemplate', 'parseXfaDatasets', 'decodeXfaPackets', 'buildXfaPlan',
      'convertXfaToAcroForm', 'measureToPt', 'rectFromBox', 'chainIsPositioned',
      'mediumAgrees', 'boxFor', 'somName', 'bindFieldValue',
    ]) expect(api).not.toHaveProperty(absent);
  });

  // The byte-identity fence. A document with no /XFA is unchanged by the call.
  it('leaves a document with no /XFA byte-identical', () => {
    const doc = Document.New();
    doc.AddPage(PageFormat.A4);
    doc.AddText({ page: 1, x: 72, y: 72, text: 'hello' });
    const before = doc.Save();
    const report = doc.ConvertXfaToAcroForm();
    expect(report.fields).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(doc.Save()).toEqual(before);
  });
});
```

Also add a `type`-only compile check at the top of the file, which is what pins
the *type* exports (a `not.toHaveProperty` cannot see them, since types are
erased):

```ts
import type {
  XfaConvertOptions, XfaConvertReport, XfaFieldResult, XfaSkipped,
} from '../src/index.js';

// A compile-time assertion: these four must be exported as types from index.ts.
const _opts: XfaConvertOptions = { removeXfa: true };
const _skip: XfaSkipped = { what: 'field', reason: 'x' };
const _res: XfaFieldResult = { name: 'a', type: 'text', route: 'bare' };
const _rep: XfaConvertReport = {
  packets: [], fields: [], skipped: [], xfaRemoved: false, dataOnly: false,
};
void _opts; void _skip; void _res; void _rep;
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run test/xfa-public-api.test.ts`
Expected: FAIL — `doc.ConvertXfaToAcroForm is not a function`.
Run: `npm run typecheck` — Expected: FAIL, `has no exported member 'XfaConvertOptions'`.

- [ ] **Step 3: Add the method**

In `src/document.ts`, beside `ConvertToGrayscale`:

```ts
  /** Convert this document's XFA form to a real `/AcroForm` field tree.
   *
   *  Fields whose template layout chain is positioned throughout get widgets
   *  with rects and appearance streams; every other field gets a geometry-less
   *  field dict, which `doc.Form` still finds, fills and exports. `/XFA` and
   *  `/NeedsRendering` are removed by default once something has converted —
   *  pass `{ removeXfa: false }` to keep them.
   *
   *  The returned {@link XfaConvertReport} names what did not convert, and is
   *  the first place to look when a converted document is missing a field or
   *  renders nothing. `report.dataOnly` says the document converted to data and
   *  renders nothing at all, which is what a dynamic XFA form does: this makes
   *  its fields addressable, it does not build the pages the layout engine
   *  would have.
   *
   *  Throws {@link UnsupportedFeatureError} for a signed document, which adding
   *  fields would invalidate. */
  ConvertXfaToAcroForm(opts: XfaConvertOptions = {}): XfaConvertReport {
    return convertXfaToAcroForm(this, opts);
  }
```

with the import added to the existing import block:

```ts
import {
  convertXfaToAcroForm,
  type XfaConvertOptions, type XfaConvertReport,
} from './xfaconvert.js';
```

In `src/index.ts`, after the `colorconvert.js` block:

```ts
export type {
  XfaConvertOptions, XfaConvertReport, XfaFieldResult, XfaSkipped,
} from './xfaconvert.js';
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run test/xfa-public-api.test.ts` — Expected: PASS, 4 cases.
Run: `npm test` — Expected: the whole suite green.
Run: `npm run typecheck` — Expected: clean.
Run: `npm run build` — Expected: clean, and `dist/index.d.ts` mentions
`XfaConvertReport`.

- [ ] **Step 5: Prove the internals really are absent**

Add `export { convertXfaToAcroForm } from './xfaconvert.js';` to `index.ts`,
run `npx vitest run test/xfa-public-api.test.ts`, confirm the absence case goes
RED, then revert. This is the assertion most likely to rot, because adding an
export is the natural reflex when a later feature wants one.

- [ ] **Step 6: Commit**

```
feat(6t2v.3): doc.ConvertXfaToAcroForm, the one public entry point

index.ts exports the option and report TYPES and nothing else: the packet,
template and data models stay internal until a caller asks for them, the posture
parseHtmlFragment takes. test/xfa-public-api.test.ts asserts those absences BY
NAME, so they are a decision the suite enforces rather than an oversight --
adding an export is the natural reflex when a later feature wants one, and that
case is what makes it deliberate.

The byte-identity fence is asserted directly: a document with no /XFA saves to
the same bytes before and after the call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 11: the vendored hybrid oracle

**The anchor of the whole feature.** A static XFA form carries *two independent
descriptions of one field set* — the XFA template, and the `/AcroForm`
LiveCycle generated from it. Converting from the template alone and comparing
against what Adobe wrote validates the SOM naming, the type mapping and the
entire geometry pipeline against numbers we did not compute.

**Files:**
- Create: `test/fixtures/xfa/PROVENANCE.md`
- Create: `test/fixtures/xfa/*.pdf` (the vendored forms)
- Create: `test/xfa-real.test.ts`

**Interfaces:**
- Consumes: the whole public surface from Task 10.
- Produces: nothing importable. This task produces evidence.

- [ ] **Step 1: Obtain the fixtures**

Source **US federal forms**, which are US Government works and public domain, so
they can be committed and the suite stays hermetic — no network, no Acrobat.
Prefer USCIS and IRS fillable forms; both publish LiveCycle-produced XFA.

For each candidate, before committing it, record:

```bash
node -e '
const { Document } = require("./dist/index.js");
const fs = require("node:fs");
const doc = Document.Open(new Uint8Array(fs.readFileSync(process.argv[1])));
const acro = doc.resolve(doc.catalog().get("AcroForm"));
console.log("pages", doc.Pages.length);
console.log("acroform fields", doc.Form.Fields.length);
console.log("needsRendering", doc.catalog().has("NeedsRendering"));
console.log("xfa", acro && acro.has("XFA"));
' path/to/form.pdf
```

A form is **usable as the oracle** only when it is HYBRID: `/XFA` present AND
`doc.Form.Fields.length > 0`. A dynamic form (no AcroForm fields) is worth
vendoring too, but as a *second* fixture covering the `dataOnly` path, not as
the oracle. Record the SHA-256 of every file:
`node -e 'console.log(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' f.pdf`

- [ ] **Step 2: Write the oracle test**

Create `test/xfa-real.test.ts`. **Name the files as `<agency>-<form>.pdf`** —
`uscis-i9.pdf`, `irs-f1040.pdf` — and substitute those two names for the
`<HYBRID FIXTURE NAME>` / `<DYNAMIC FIXTURE NAME>` markers below; they are the
only two values in this plan that Step 1 rather than this document supplies,
because which form is hybrid and which is dynamic is not knowable until the
probe in Step 1 has run.

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';

const load = (n: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/xfa/${n}`, import.meta.url)));

/** Strip /AcroForm /Fields in a copy, leaving /XFA intact, so the conversion
 *  runs from the TEMPLATE ALONE and cannot read the answer it is being
 *  checked against. */
function stripAcroFields(bytes: Uint8Array): Document {
  const doc = Document.Open(bytes);
  const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
  acro.set('Fields', []);
  for (const p of doc.Pages) p.Dict.delete('Annots');
  doc.markModified();
  return Document.Open(doc.Save());
}

describe('the hybrid oracle', () => {
  const bytes = load('<HYBRID FIXTURE NAME>.pdf');

  it('reproduces the field names Adobe wrote', () => {
    const adobe = new Set(Document.Open(bytes).Form.Fields.map((f) => f.FullName));
    const ours = stripAcroFields(bytes);
    ours.ConvertXfaToAcroForm({ removeXfa: false });
    const mine = new Set(ours.Form.Fields.map((f) => f.FullName));
    // Every name Adobe wrote must be one we synthesized. We may produce MORE
    // (a field Adobe declined to emit), which is why this is a subset test in
    // one direction and reported in the other.
    const missing = [...adobe].filter((n) => !mine.has(n));
    expect(missing).toEqual([]);
  });

  it('reproduces the /FT and /Ff Adobe wrote for every shared field', () => {
    const adobe = new Map(Document.Open(bytes).Form.Fields.map((f) => [f.FullName, f]));
    const ours = stripAcroFields(bytes);
    ours.ConvertXfaToAcroForm({ removeXfa: false });
    for (const f of ours.Form.Fields) {
      const a = adobe.get(f.FullName);
      if (!a) continue;
      expect([f.FullName, f.Type]).toEqual([f.FullName, a.Type]);
    }
  });

  // The whole geometry pipeline -- units, anchors, offset accumulation, the
  // y-flip -- against numbers we did not compute.
  it('reproduces the rects Adobe wrote, to within 1pt', () => {
    const src = Document.Open(bytes);
    const adobe = new Map(src.Form.Fields.map(
      (f) => [f.FullName, src.resolve(f.Dict.get('Rect')) as number[]],
    ));
    const ours = stripAcroFields(bytes);
    const report = ours.ConvertXfaToAcroForm({ removeXfa: false });
    const placed = report.fields.filter((f) => f.route === 'positioned');
    // If this is zero the chain interpretation is wrong -- see plan
    // Interpretation 2 -- and the answer is to fix the chain, never to loosen
    // the positioned rule.
    expect(placed.length).toBeGreaterThan(0);
    let compared = 0;
    for (const r of placed) {
      const want = adobe.get(r.name);
      if (!want || want.length !== 4) continue;
      const got = ours.resolve(ours.Form.Get(r.name)!.Dict.get('Rect')) as number[];
      for (let i = 0; i < 4; i++) expect(Math.abs(got[i] - want[i])).toBeLessThanOrEqual(1);
      compared += 1;
    }
    // A loop that compared nothing passes vacuously. Assert it did work.
    expect(compared).toBeGreaterThan(0);
  });

  it('reports every refusal rather than dropping a field silently', () => {
    const ours = stripAcroFields(bytes);
    const report = ours.ConvertXfaToAcroForm({ removeXfa: false });
    const named = new Set(report.fields.map((f) => f.name));
    for (const s of report.skipped) if (s.name) expect(named.has(s.name)).toBe(false);
  });
});

describe('the dynamic fixture', () => {
  it('converts to data and says the document renders nothing', () => {
    const doc = Document.Open(load('<DYNAMIC FIXTURE NAME>.pdf'));
    const report = doc.ConvertXfaToAcroForm();
    expect(report.fields.length).toBeGreaterThan(0);
    expect(report.dataOnly).toBe(true);
    expect(doc.Form.Fields.length).toBeGreaterThan(0);
    expect(Document.Open(doc.Save()).Form.Fields.length).toBe(doc.Form.Fields.length);
  });
});
```

- [ ] **Step 3: Run it and record what it says**

Run: `npx vitest run test/xfa-real.test.ts`.

This is the step that produces findings rather than a pass. Whatever it reports,
**record it** — in PROVENANCE and in the commit message. Three answers are
expected and each has a defined response:

- **The rect comparison passes.** The chain interpretation and the whole
  geometry pipeline are confirmed against Adobe's own numbers.
- **`placed.length` is zero.** Interpretation 2 is wrong for this producer.
  Investigate where the chain actually begins by dumping
  `parseXfaTemplate(...).fields.map(f => f.layouts)` — do **not** loosen
  `chainIsPositioned`.
- **Rects are placed but wrong by a constant.** That is an offset the chain
  misses — most likely a `<contentArea>` the walk did not pass through. Fix the
  chain; do not add a correction term.

Record the actual counts: how many fields the form has, how many converted
positioned, how many bare, how many refused and why.

- [ ] **Step 4: Answer the spec's two remaining open questions**

From the same fixtures, and record both answers in PROVENANCE whether or not
they change anything:

```bash
node -e '/* dump every field anchorType and every subform occur max */'
```

- Does any vendored form use a non-`topLeft` `anchorType`? If none does, the
  anchor arithmetic is **builder-covered only** and PROVENANCE says so.
- Does any use `<occur max>` in an otherwise positioned template? If so,
  confirm Interpretation 3 degrades it and that Adobe placed it anyway (which
  would be a finding worth its own issue, not a fix here).

- [ ] **Step 5: Write PROVENANCE**

Create `test/fixtures/xfa/PROVENANCE.md`, following
`test/fixtures/pdfx/PROVENANCE.md`'s shape: producer and version (readable from
the packet's own generator processing instruction), source URL, SHA-256, and a
per-fixture table of what it covers. It **must** state the ceiling explicitly:

- **No second implementation arbitrates our output.** The hybrid comparison is
  strong evidence for the forms it covers and is not conformance evidence. No
  XFA implementation is installed and none can be.
- Which template constructs appear in **no** vendored form — at minimum `px` /
  `pc` units and (probably) non-`topLeft` anchors — naming the builder tests
  that hold those rules instead.
- That the oracle covers **positioned layout only**, since a flow-laid field
  has no Adobe rect to compare against either.
- The measured counts from Step 3.

- [ ] **Step 6: Commit**

```
test(6t2v.3): the hybrid XFA document as the oracle

A static XFA form carries two independent descriptions of one field set -- the
template, and the /AcroForm LiveCycle generated from it. test/xfa-real.test.ts
strips /AcroForm /Fields in a copy, converts from the template ALONE, and
compares the result against what Adobe wrote: names, types and RECTS. That
validates the SOM naming, the type mapping and the whole geometry pipeline --
units, anchors, offset accumulation, the y-flip -- against numbers we did not
compute, which is the cff.ts-charstrings-checked-against-hmtx arrangement.

The rect comparison asserts `compared > 0` beside the per-field bounds, because
a loop that compared nothing passes vacuously and would report the pipeline
healthy while converting no geometry at all.

PROVENANCE states the ceiling: no second XFA implementation arbitrates this, the
oracle covers positioned layout only, and it names the constructs no vendored
form exercises together with the builder tests that hold those rules instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 12: the mutation sweep the spec names

Each task above already ran the mutations local to it. This task runs **the
spec's own seven** end to end, from the public entry point, and — this is the
point of the task — **builds the fixture each one needs first**, because for
three of them the obvious fixture measures nothing.

**Files:**
- Modify: `test/xfaconvert.test.ts` (a `describe('mutation fences')` block)
- Modify: `test/helpers/build-xfa-pdf.ts` (the fixtures the sweep needs)
- Create: `docs/superpowers/notes/2026-09-09-xfa-mutations.md` (the record)

**Interfaces:**
- Consumes: everything. Produces: evidence and one note file.

- [ ] **Step 1: Build the seven fixtures, each shaped for its mutation**

| # | Mutation | What the fixture MUST have, and why the obvious one fails |
|---|---|---|
| 1 | Flip the y-axis sign | Field near the page **top**, and a **non-zero CropBox origin**. A field at the page centre lands identically under both readings. |
| 2 | Use the template `<value>` as `/V` rather than `/DV` | A `datasets` value that **differs** from the template default. Equal values are green under both readings. |
| 3 | Accumulate offsets from the immediate parent only | A chain **three deep with a non-zero offset at each level**. Two deep, or a zero at any level, and the two sums coincide. |
| 4 | Swap the `<items>` export/display halves | A choice field whose two halves **differ**, and the assertion on the **export** half (`/V` membership), not merely on `/Opt` being present. |
| 5 | Drop the medium-versus-CropBox check | A fixture whose medium **deliberately disagrees** — declare A4 on a US Letter page. |
| 6 | Test `layout` on the immediate parent, not the whole chain | A **positioned subform nested inside a flowed one**. A flat flowed template is red under both readings. |
| 7 | Ignore `access="readOnly"` / `nullTest="error"` | Two fields, one carrying each, asserted on `/Ff` bits 1 and 2 individually. |

Add each as an exported template constant in `test/helpers/build-xfa-pdf.ts`,
named for the rule it fences: `Y_FLIP_TEMPLATE`, `DIFFERING_DEFAULT_TEMPLATE`,
`THREE_DEEP_TEMPLATE`, `PAIRED_ITEMS_TEMPLATE`, `WRONG_MEDIUM_TEMPLATE` (Task 7
already has this one), `NESTED_FLOW_TEMPLATE`, `FLAGS_TEMPLATE`.

- [ ] **Step 2: Write the fence block**

Append to `test/xfaconvert.test.ts`:

```ts
describe('mutation fences', () => {
  const convert = (spec: Parameters<typeof buildXfaPdf>[0]) => {
    const doc = Document.Open(buildXfaPdf(spec));
    return { doc, report: doc.ConvertXfaToAcroForm({ removeXfa: false }) };
  };
  const rectOf = (doc: Document, n: string) =>
    doc.resolve(doc.Form.Get(n)!.Dict.get('Rect') as never) as number[];

  // 1. Y_FLIP_TEMPLATE places its field 0.5in from the page TOP on a page whose
  //    CropBox origin is (10, 20). Under a flipped sign it lands near the
  //    BOTTOM, which no centre-of-page fixture could show.
  it('places a top-of-page field near the top of the CropBox', () => {
    const { doc } = convert({ template: Y_FLIP_TEMPLATE, mediaBox: [10, 20, 622, 812] });
    const [, lly, , ury] = rectOf(doc, 'form1[0].Page1[0].f[0]');
    expect(ury).toBeCloseTo(776, 6);
    expect(lly).toBeCloseTo(758, 6);
  });

  // 2. The default and the datum DIFFER, so /V and /DV cannot both be right.
  it('draws the entered value and keeps the authored one as /DV', () => {
    const { doc } = convert({
      template: DIFFERING_DEFAULT_TEMPLATE,
      datasets: `<xfa:datasets><xfa:data><form1><Page1><f>ENTERED</f>
        </Page1></form1></xfa:data></xfa:datasets>`,
    });
    expect(doc.Form.Get('form1[0].Page1[0].f[0]')!.Value).toBe('ENTERED');
    expect(doc.Pages[0].ToSvg()).not.toContain('AUTHORED');
  });

  // 3. Three levels, each with a non-zero offset: 0.25in + 1in + 10pt = 100pt.
  it('sums every level of the offset chain', () => {
    const { doc } = convert({ template: THREE_DEEP_TEMPLATE });
    expect(rectOf(doc, 'form1[0].Page1[0].A[0].B[0].f[0]')[0]).toBeCloseTo(100, 6);
  });

  // 4. The EXPORT half is what /V carries. Asserting only that /Opt exists is
  //    green under the swap.
  it('accepts the export half as a value and rejects the display half', () => {
    const { doc } = convert({ template: PAIRED_ITEMS_TEMPLATE });
    const f = doc.Form.Get('form1[0].Page1[0].c[0]')!;
    expect(() => { f.Value = 'US'; }).not.toThrow();
    expect(() => { f.Value = 'United States'; }).toThrow();
  });

  // 5. A4 declared on a US Letter page.
  it('degrades every field on a page whose medium disagrees', () => {
    const { report } = convert({ template: WRONG_MEDIUM_TEMPLATE });
    expect(report.fields.every((f) => f.route === 'bare')).toBe(true);
  });

  // 6. A positioned subform INSIDE a flowed one: the immediate parent says
  //    position and the chain says no.
  it('degrades a positioned subform nested inside a flowed one', () => {
    const { report } = convert({ template: NESTED_FLOW_TEMPLATE });
    expect(report.fields[0].route).toBe('bare');
  });

  // 7. Each flag on its own field, each bit asserted alone.
  it('carries readOnly and required through to /Ff', () => {
    const { doc } = convert({ template: FLAGS_TEMPLATE });
    const ff = (n: string) =>
      doc.resolve(doc.Form.Get(`form1[0].Page1[0].${n}[0]`)!.Dict.get('Ff') as never) as number;
    expect(ff('ro') & 1).toBeTruthy();
    expect(ff('ro') & 2).toBeFalsy();
    expect(ff('req') & 2).toBeTruthy();
    expect(ff('req') & 1).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run the block and verify it passes**

Run: `npx vitest run test/xfaconvert.test.ts` — Expected: PASS, 40 cases.

- [ ] **Step 4: Run the seven mutations and record the counts**

For each, apply the mutation to `src/`, run **`npm test`** (the whole suite, so
a mutation reddening something unexpected is visible), record the file:case
counts, and revert.

| # | Where to mutate | Minimum expected |
|---|---|---|
| 1 | `rectFromBox`: `const ury = crop[1] + box.y` | ≥ 3 (2 in `xfageom`, 1 here) |
| 2 | `valueEntries`: write `defaultValue` to `V` and `value` to `DV` | ≥ 3 |
| 3 | `accumulateOrigin`: read only the last entry | ≥ 2 |
| 4 | `itemsOf`: `const exp = lists[0]` unconditionally, `disp = lists[1]` | ≥ 2 |
| 5 | `mediumAgrees`: `return true` | ≥ 3 |
| 6 | `chainIsPositioned`: `layouts[layouts.length - 1] === 'position'` | ≥ 3 |
| 7 | `fieldOf`: `readOnly: false, required: false` | ≥ 2 |

**A mutation that reddens nothing is a finding, not a pass.** Build the fixture
that catches it before moving on, or — if it provably cannot be caught — record
it as an uncovered rule in the note file, the way this repo does everywhere
else. Do not delete the rule.

- [ ] **Step 5: Run the byte-identity fence**

```bash
git stash list   # must be empty of this feature's work
npx vitest run test/form-create.test.ts test/form.test.ts \
  test/pdfaconvert.test.ts test/pdfavalidate.test.ts \
  test/pdfx-real.test.ts test/drprune.test.ts
git diff --stat -- test/form-create.test.ts test/form.test.ts \
  test/pdfaconvert.test.ts test/pdfavalidate.test.ts \
  test/pdfx-real.test.ts test/drprune.test.ts
```

Expected: all green, and the diff **empty**. A non-empty diff on any of those
means this feature changed existing behaviour, which it must not.

- [ ] **Step 6: Write the note and commit**

Create `docs/superpowers/notes/2026-09-09-xfa-mutations.md` recording, per
mutation: what was changed, which files and how many cases went red, and — for
anything that reddened nothing — why, and which rule is therefore held by
reasoning rather than by the suite.

```
test(6t2v.3): the seven mutation fences the design names

Each runs from the public entry point, and each needed its fixture SHAPED for
it, because for three of them the obvious fixture measures nothing: a y-flip is
invisible for a field at the page centre, a value-versus-default swap is
invisible when the two agree, and an offset chain two deep sums identically
whether every level or only the last is read.

Two more are worth naming for the same reason. The items swap must be asserted
on the EXPORT half -- that /V accepts 'US' and rejects 'United States' -- since
asserting only that /Opt exists is green under the swap. And the chain rule
needs a positioned subform nested INSIDE a flowed one, since a flat flowed
template degrades under both readings.

docs/superpowers/notes/2026-09-09-xfa-mutations.md records the per-mutation
counts, and any rule that reddened nothing is recorded there as held by
reasoning rather than by the suite -- not deleted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

### Task 13: documentation, and closing the issue

**Files:**
- Modify: `README.md` (a new `### Convert an XFA Form to an AcroForm` example
  under *Additional Examples*, the API Reference *Core API* table, and the two
  Limitations entries at ~line 1769 and ~line 3449)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `CLAUDE.md` (five module entries in the Source list, plus the
  `fixtures/xfa/` row in the fixtures table)
- No `src/` or `test/` change.

- [ ] **Step 1: README — the worked example**

Add `### Convert an XFA Form to an AcroForm` under *Additional Examples*. Note
the heading style there is **imperative** ("Set Viewer Preferences", "Extract
Text"), not a noun phrase. Show:

```ts
const doc = Document.Open(bytes);
const report = doc.ConvertXfaToAcroForm();

for (const f of report.fields)
  console.log(f.route, f.name, f.type, f.page ?? '(no geometry)');
for (const s of report.skipped)
  console.log('skipped', s.what, s.name ?? '', s.reason);

if (report.dataOnly)
  console.log('converted to data; this document renders nothing');

fs.writeFileSync('out.pdf', doc.Save());
```

and say in prose, because each is the thing a caller gets wrong:

- Positioned templates get **real widgets**; flow-laid ones get **fields with
  no geometry**, which `doc.Form` still fills and `ExportFdf` still exports.
- `dataOnly` means the document converts to data and **renders nothing** — a
  dynamic XFA form's pages are built by a layout engine this library does not
  have, so its fields become addressable and its pages do not appear.
- The useful order with PDF/A is **`ConvertXfaToAcroForm` then
  `ConvertToPdfA`**: the fields survive as a real AcroForm and the PDF/A
  prohibition on `/XFA` is satisfied for free. The other order deletes them.
- It throws `UnsupportedFeatureError` on a signed document.

- [ ] **Step 2: README — the API Reference row**

Add `ConvertXfaToAcroForm` to the **Core API** table (~line 2590), and the four
type names to the types table. **Read the CLAUDE.md warning first:** that table
is several **alphabetical runs concatenated**, not one sorted list — inserting
by scanning for the first name that sorts higher lands the row in the wrong
table. Find the run that holds the other `Convert*` rows and insert there.

- [ ] **Step 3: README — the two Limitations entries**

Both currently say XFA is never read. Rewrite ~line 3449 to say what is now
true and what is still not:

- `/AcroForm /XFA` **is** read, and `ConvertXfaToAcroForm` converts it.
- The **dynamic layout engine is not implemented**: no text measurement, no box
  growth, no repeating subforms, no flow stacking. A field under any flow
  layout gets no geometry, ever, and is reported.
- Conversion is **one-way**: nothing is written back into the XFA packets, so
  `Field.Value` edits still do not reach a hybrid's XFA half. That is the
  existing limitation, narrowed rather than removed.
- **`px` and `pc` measurements are refused**, so a field stated in them degrades
  to geometry-less and is reported.
- `<imageEdit>`, `<barcode>` and `<signature>` fields are refused and reported.

Update the ~line 1769 paragraph likewise: the hybrid advice "delete `/XFA`
yourself" now names the method instead.

- [ ] **Step 4: CHANGELOG**

Under `## [Unreleased]` → `### Added`, following this repo's house style — a
bold lead-in, then prose saying what it does, why the design went that way and
what was measured:

```markdown
- **XFA forms convert to real AcroForm fields.** `doc.ConvertXfaToAcroForm()`
  decodes `/AcroForm /XFA` (single XDP stream or the alternating name/stream
  array), models the `template` packet's field set, binds values out of
  `datasets`, and emits an `/AcroForm` field tree — so a form that only Acrobat
  could fill becomes one this library, and every other viewer, can read, fill,
  flatten, redact and export. …
```

Then say the three things that decide whether someone should upgrade:

1. **Geometry is not all-or-nothing.** `layout="position"` states `x`/`y`/`w`/`h`
   in the template, so static and XFAF forms get **real widgets with rects and
   appearance streams**. A field under any flow layout gets a geometry-less
   field dict instead — addressable and fillable, drawn nowhere — and says so on
   the report. The dynamic layout engine is deliberately not implemented, and no
   rect is ever approximated: a field drawn in the wrong place looks right and
   is wrong.
2. **A hybrid document reconciles by name.** The synthesized name is the SOM
   expression, occurrence indices included, which is exactly what LiveCycle
   writes into the AcroForm half — so an existing field has its `/V` updated and
   its geometry left alone, and an FDF exported from a converted document stays
   interchangeable with Acrobat's.
3. **What was measured.** The oracle is the hybrid document itself: it carries
   two independent descriptions of one field set, so converting from the
   template alone and comparing against the AcroForm LiveCycle wrote validates
   the SOM naming, the type mapping and the whole geometry pipeline against
   numbers we did not compute.

Close with the refusals — signed documents throw; `px`/`pc` units, rotated
fields, `<signature>`, `<imageEdit>` and `<barcode>` are reported rather than
guessed at — and `(6t2v.3)`.

- [ ] **Step 5: CLAUDE.md**

Add five entries to the Source list, in the style of the file: what the module
is, then its invariants with the reasoning and what was measured. At minimum
record, because each is a rule a later reader would otherwise undo:

- **`xfageom.ts`** — imports nothing; `px`/`pc`/`em` are refused rather than
  guessed, and why that is the honest answer; the medium-versus-CropBox check
  as the thing that makes the rest trustworthy, with the 1pt figure and its
  reasoning; the whole-chain layout rule, and the measurement that a
  last-element test reddens only some fixtures.
- **`xfatemplate.ts`** — the SOM name is the AcroForm name, so reconciliation is
  equality; the `save="1"` items list is the EXPORT half; the template `<value>`
  is `/DV` and never `/V`; and the plan's *Interpretation 2* in full, because
  "the chain starts below the pageSet-carrying subform" reads as arbitrary
  without the LiveCycle `layout="tb"` finding beside it.
- **`xfadata.ts`** — SOM-shaped data paths so the join is one Map lookup;
  `match="none"`; a container records no value of its own.
- **`xfapacket.ts`** — the two `/XFA` shapes; the `resolve`/`inflate` seam; that
  it owns the `parseXml` throw boundary and why that boundary is here rather
  than in `xml.ts`; and that a per-packet failure is mandatory because
  `preamble`/`postamble` never parse.
- **`xfaconvert.ts`** — plan-then-apply as `formcreate.ts`'s rule scaled to a
  document; positioned fields reuse `createField`/`addRadioGroup`; a bare field
  is appended through `resolvePath(...).container.push` and **not**
  `appendField`, with the reason; the exclGroup all-or-nothing rule; `dataOnly`
  distinguishing "renders nothing" from "converted nothing"; `/XFA` removal only
  when something converted; the signed refusal and its `docmdp.ts` reasoning.

Add the `fixtures/xfa/` row to the fixtures table, and record the finding that
`drprune.ts` currently skips any document carrying `/XFA` (`drprune.ts:219`) —
so a converted document becomes prunable, which is a *consequence* to note, not
a change to make.

Then run the sweep CLAUDE.md itself documents, which must come back **empty**:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*\`]$b[*\`]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 6: Verify, commit and close**

```bash
npm run typecheck && npm test && npm run build
```

Then:

```bash
bd update aspose-pdf-foss-for-ts-6t2v.3 --status closed
bd remember --key xfa-to-acroform-shipped "..."
git add -A && git commit -F <message file>
git pull --rebase && git push && git status
```

The `bd remember` entry should record, in this repo's memory style: the entry
point, the five modules and their split, the positioned-versus-bare rule, the
medium check, the hybrid oracle and its ceiling, and the four refusals.

**Work is not complete until `git push` succeeds and `git status` shows
"up to date with origin".**

```
docs(6t2v.3): XFA to AcroForm conversion in README, CHANGELOG and CLAUDE.md

README gains a worked example, a Core API row, and two rewritten Limitations
entries: /XFA is read now, the dynamic layout engine still is not, conversion is
one-way, and px/pc units are refused. The useful order with PDF/A is documented
because it is easy to get backwards -- ConvertXfaToAcroForm then ConvertToPdfA
keeps the fields, the other order deletes them.

CLAUDE.md gains the five module entries, each carrying the reasoning a later
reader would otherwise undo: why px is refused rather than converted, why the
layout chain starts below the pageSet-carrying subform, why the parseXml throw
boundary lives in xfapacket.ts, and why a bare field is appended through
resolvePath rather than appendField.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

---

## Self-review of this plan

- **Spec coverage.** Packet decoding → Task 6. Template model → Tasks 3–4.
  Value binding → Task 5. Positioned widgets → Task 9. Geometry-less fields →
  Task 8. Hybrid reconciliation → Tasks 7–8. `/XFA` + `/NeedsRendering` removal
  → Task 9. The public entry point and report → Tasks 7 and 10. The mapping
  table → Task 7. `/Opt` through `choiceopt.ts` → Tasks 7–8. Measurements,
  positioned-versus-flow, offsets, anchors, the y-flip, the medium check → Tasks
  1–2. Plan-then-apply → Tasks 7–8. The refusals → Tasks 7–9. The hybrid oracle,
  builders and fixtures → Tasks 7, 11, 12. The seven mutations → Task 12. Docs →
  Task 13. The three open questions → *Interpretations* 1–3, with 2 and 3
  re-checked empirically in Task 11.
- **Explicitly out of scope, and no task builds them:** the dynamic layout
  engine, approximate geometry, XFA scripting, writing XFA back, rendering an
  XFA form, `<imageEdit>`/`<barcode>`/`<signature>` synthesis, and any change to
  `pdfaconvert.ts`.
- **Naming consistency to hold while implementing:** `measureToPt`,
  `anchorShift`, `rectFromBox`, `mediumAgrees`, `chainIsPositioned`,
  `accumulateOrigin`, `boxFor`, `parseXfaTemplate`, `somName`,
  `parseXfaDatasets`, `bindFieldValue`, `decodeXfaPackets`, `buildXfaPlan`,
  `convertXfaToAcroForm`, `ConvertXfaToAcroForm`. `XfaField.geom` /`.layouts` /
  `.offsets` / `.pageIndex` / `.bindRef` / `.bindMatch` are declared in Task 3
  and populated in Tasks 4–5; no later task adds a field to that interface.
