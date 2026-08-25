# Link Rect Trailing Space Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a `/Link` annotation's rect at its run's last glyph, instead of extending it over the separator space that run also paints.

**Architecture:** One field on `stamp.ts`'s module-private `SegmentBox`, computed in `segmentBoxes` where the segment text and the justification `Tw` are both already in hand, and subtracted by `runLinkBoxes` alone. `runDecorOps` ignores it, so decoration and every emitted byte are unchanged.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-link-rect-trailing-space-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **TDD.** Write the failing test, run it, watch it fail, then implement.
- **`npm run typecheck && npm test` must be green before every commit.**
- **No content bytes change.** Annotations are not page content, and decoration is untouched — `test/rich-runs-identity.test.ts` must stay green without regenerating a single hash.
- **The trim matches U+0020 only,** never `\s`. JavaScript's `\s` matches U+00A0, which a code block deliberately paints for every space so indentation survives (`preformat`).
- **No public surface change.** `SegmentBox` is module-private to `stamp.ts`.
- Run a single test file with `npx vitest run test/<name>.test.ts`.

## Measured baseline

From probing the current build, for a 12pt Helvetica-Bold link run named `docs`
followed by more text. The fix must move each of these to zero:

| Case | Overshoot |
|---|---|
| mid-sentence, left-aligned | 3.34pt |
| **justified** | **6.16pt** — `Tw` widens the trailing space too |
| end of a wrapped line | 3.34pt |

A *leading* space never reaches the linked run's segment: layout moves it to the
preceding run. Only the trailing end needs trimming.

---

### Task 1: Trim the trailing space from a link rect

**Files:**
- Modify: `src/stamp.ts` (`SegmentBox` line 563, `segmentBoxes` lines 577-594, `runLinkBoxes` lines 641-657, the one `segmentBoxes` call at line 797)
- Test: `test/link-rect-trim.test.ts` (create)

**Interfaces:**
- Produces: `SegmentBox` gains `trailing: number` — points of trailing U+0020 included in `width`. `segmentBoxes` gains a sixth parameter `runs: ResolvedRun[]`. Both module-private to `stamp.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/link-rect-trim.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { TextRun } from '../src/textdecor.js';

const LINK = 'https://example.com';

/** Render `runs` into a page and return the single /Link annotation's rect. */
const linkRect = (runs: TextRun[], opts: object = {}): number[] => {
  const doc = Document.New();
  const { page } = doc.AddPage(PageFormat.A4);
  page.AddTextBlock(runs, [50, 300, 300, 300], { fontSize: 12, ...opts });
  const links = page.Annotations.filter((a) => a.Subtype === 'Link');
  expect(links.length).toBe(1);
  return links[0].Rect!;
};

describe('a link rect stops at its last glyph', () => {
  it('is the same width whether or not text follows the link', () => {
    // The separator space belongs to the run that PAINTS it, which is the
    // preceding one — so the linked run's segment is 'docs ' when text follows
    // and 'docs' when it does not. The rect must not notice the difference.
    const followed = linkRect([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
      { text: ' and more' },
    ]);
    const final = linkRect([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
    ]);
    expect(followed[2] - followed[0]).toBeCloseTo(final[2] - final[0], 5);
  });

  it('ends inside the extracted fragment, by no more than one space', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
      { text: ' and more' },
    ], [50, 300, 300, 300], { fontSize: 12 });
    const rect = page.Annotations.filter((a) => a.Subtype === 'Link')[0].Rect!;
    // GetTextFragments reports this fragment as 'docs ' — INCLUDING the
    // separator — which is exactly why `rect === frag.quad` is the wrong
    // assertion here. Bound it instead: strictly inside, by at most a space.
    const frag = page.GetTextFragments().find((f) => f.text.startsWith('docs'))!;
    const space = 0.278 * 12;   // every Helvetica face's space advance is 278/1000
    expect(rect[2]).toBeLessThan(frag.quad[2]);
    expect(rect[2]).toBeGreaterThan(frag.quad[2] - space - 0.5);
  });

  it('trims the Tw-widened space on a justified line', () => {
    const runs: TextRun[] = [
      { text: 'alpha beta gamma delta epsilon zeta eta ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK },
      { text: ' theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon' },
    ];
    // Justification widens spaces via Tw and leaves glyphs alone, and it does
    // not change where lines break — so once the separator is trimmed, the two
    // rects cover the identical four glyphs and must be identically wide.
    // Untrimmed they differ by the Tw the separator gained.
    const justified = linkRect(runs, { align: 'justify' });
    const left = linkRect(runs, { align: 'left' });
    expect(justified[2] - justified[0]).toBeCloseTo(left[2] - left[0], 5);
  });

  it('places no annotation for a link run that is only whitespace', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([
      { text: 'see' },
      { text: '   ', link: LINK },
      { text: 'more' },
    ], [50, 300, 300, 300], { fontSize: 12 });
    expect(page.Annotations.filter((a) => a.Subtype === 'Link').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/link-rect-trim.test.ts`
Expected: the first three FAIL. The first two by roughly 3.34pt, the third by
roughly 2.8pt (the `Tw` share alone). The whitespace-only case may already pass;
that is fine, it is a guard rather than a driver.

- [ ] **Step 3: Add `trailing` to `SegmentBox` in `src/stamp.ts`**

Replace the one-line interface at line 563:

```ts
interface SegmentBox {
  run: number; x: number; baseline: number; width: number;
  /** Points of trailing space included in `width`.
   *
   *  The separator between two words belongs to the run that PAINTS it, which
   *  is the preceding one — so a linked run followed by more text paints a
   *  space after its last glyph. A link rect trims this; decoration does not,
   *  because it is shipped typography fenced by rich-runs-identity and because
   *  a clickable 3-6pt of blank space is felt where an underline's is not. */
  trailing: number;
}
```

- [ ] **Step 4: Compute it in `segmentBoxes`**

Add the `runs` parameter and the trailing measurement:

```ts
function segmentBoxes(
  lines: LaidLine[], x: number, w: number, baseline0: number,
  o: NormalizedBlockOptions, runs: ResolvedRun[],
): SegmentBox[] {
  const out: SegmentBox[] = [];
  lines.forEach((line, i) => {
    const tw = justifySpacing(o.align, w, line);
    const baseline = baseline0 - i * o.leading;
    let dx = x + alignOffset(o.align, w, line.width);
    for (const seg of line.segments) {
      let spaces = 0;
      if (tw > 0) for (const ch of seg.text) if (ch === ' ') spaces++;
      const width = seg.width + tw * spaces;
      // U+0020 only — NOT \s, which in JavaScript also matches U+00A0, the
      // character a code block substitutes for every space so its indentation
      // survives `layoutRuns` collapsing runs of spaces. That is a glyph the
      // author asked for, not a separator. It also matches what justifySpacing
      // counts, which is `ch === ' '` exactly.
      const tail = seg.text.slice(seg.text.replace(/ +$/, '').length);
      const r = runs[seg.run];
      // `width` already includes the Tw those spaces gained, so the nominal
      // advance alone under-trims a justified line.
      const trailing = tail === '' ? 0
        : r.layout.driver.measure(tail, r.layout.fontSize) + tw * tail.length;
      out.push({ run: seg.run, x: dx, baseline, width, trailing });
      dx += width;
    }
  });
  return out;
}
```

- [ ] **Step 5: Subtract it in `runLinkBoxes`**

In the `out.push`, change the rect's right edge only:

```ts
      rect: [
        b.x,
        b.baseline + vm.descent * size,
        b.x + b.width - b.trailing,
        b.baseline + vm.ascent * size,
      ],
```

- [ ] **Step 6: Pass `runs` at the single call site**

`segmentBoxes` is called once, in `flowTextBlock`'s runs branch (around line 797,
NOT in `buildRunBlockBody`, which receives the boxes as a parameter). `resolved`
is already in scope there:

```ts
      const boxes = segmentBoxes(
        lines, x, w, firstBaseline(y, h, lines.length, ro), ro, resolved);
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run test/link-rect-trim.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Confirm the `Tw` term is load-bearing**

Temporarily drop the `Tw` half — change `+ tw * tail.length` to `+ 0`. Re-run.
Expected: "trims the Tw-widened space on a justified line" goes red; the other
three stay green, because `tw` is 0 for a non-justified line. Restore.

- [ ] **Step 9: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean, with `test/rich-runs-identity.test.ts` green and no hash
regenerated — decoration and emission are untouched.

```bash
git add src/stamp.ts test/link-rect-trim.test.ts
git commit -m "$(cat <<'EOF'
fix(text): a link rect stops at its last glyph

The separator space belongs to the run that paints it, which is the preceding
one, so a linked run followed by more text painted a space past its last glyph
and the rect covered it — 3.34pt at 12pt, and 6.16pt justified, where Tw widens
that space too. The trim subtracts the Tw as well as the nominal advance, which
is what the justified case pins.

The anchor is deliberately not `rect === fragment.quad`: GetTextFragments
reports the fragment as 'docs ', including the separator, so that assertion
states the bug. Two inputs through one path instead — the same run with and
without following text must yield the same width.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Guard the two traps, and update the docs

**Files:**
- Test: `test/link-rect-trim.test.ts` (append)
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1.

- [ ] **Step 1: Write the guard tests**

Append to `test/link-rect-trim.test.ts`:

```ts
describe('what the trim must not touch', () => {
  it('does not trim a non-breaking space, which is a real glyph', () => {
    // The \s trap, guarded directly. A code block substitutes U+00A0 for every
    // space so its indentation survives layout collapsing runs of spaces; \s
    // matches U+00A0 in JavaScript, so trimming with it would eat glyphs the
    // author asked for. No rendering would reveal this — only a width does.
    //
    // Write the escape, never a literal U+00A0: on screen it is identical to a
    // space, and this test turns entirely on which of the two it is.
    const withNbsp = linkRect([{ text: 'docs\u00A0', link: LINK }]);
    const plain = linkRect([{ text: 'docs', link: LINK }]);
    expect(withNbsp[2] - withNbsp[0]).toBeGreaterThan(plain[2] - plain[0]);
  });

  it('leaves an underline spanning the space the link rect drops', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock([
      { text: 'see ' },
      { text: 'docs', font: 'Helvetica-Bold', link: LINK, underline: true },
      { text: ' and more' },
    ], [50, 300, 300, 300], { fontSize: 12 });
    const rect = page.Annotations.filter((a) => a.Subtype === 'Link')[0].Rect!;
    // The underline is the only thin filled path on the page. Read from
    // GetPaths — a different extractor from the annotation dict.
    const rules = page.GetPaths().filter(
      (p) => p.fill !== null && p.bbox[3] - p.bbox[1] < 3);
    expect(rules.length).toBe(1);
    // Decoration is deliberately NOT trimmed: it is byte-fenced typography, and
    // an interaction target and a rule are different concerns.
    expect(rules[0].bbox[2]).toBeGreaterThan(rect[2]);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/link-rect-trim.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 3: Confirm the U+0020-only guard is load-bearing**

Temporarily change `/ +$/` to `/\s+$/` in `segmentBoxes`. Re-run.
Expected: "does not trim a non-breaking space" goes red. Restore.

- [ ] **Step 4: Update `README.md`**

In the Limitations bullet beginning "**Markdown rendering covers the block and
inline vocabulary**", delete this sentence entirely:

```
A link's rect includes the separator space owned by the linked run, so it can run about one space wider than its glyphs.
```

Nothing replaces it — the limitation no longer exists. Leave the rest of the
bullet, including the sentences either side of it, untouched.

- [ ] **Step 5: Update `CLAUDE.md`**

In the `runlink.ts` / `flowtable.ts` entry, immediately after the invariant
beginning "**Invariant:** a link rect and a text background are ONE geometry",
add:

```markdown
  **Invariant:** a link rect stops at its run's last GLYPH, while run decoration
  spans the run's whole segment. They differ on purpose: the separator space
  between two words belongs to the run that paints it, so both would otherwise
  include it — but a clickable 3-6pt of blank space is felt directly (a hand
  cursor over nothing) where an underline's is not, and decoration is shipped
  typography fenced by `rich-runs-identity`. `SegmentBox.trailing` carries the
  amount; only `runLinkBoxes` subtracts it.
  **Invariant:** that trim matches U+0020 only, never `\s`. JavaScript's `\s`
  matches U+00A0, which `preformat` substitutes for every space in a code block
  so its indentation survives `layoutRuns` collapsing runs of spaces — a glyph
  the author asked for, not a separator. It also agrees with `justifySpacing`,
  which counts `ch === ' '` exactly.
  **Invariant:** the trim subtracts the `Tw` those spaces gained as well as
  their nominal advance, because `SegmentBox.width` already includes it.
  Measured: 3.34pt of overshoot unjustified, 6.16pt justified, so a `Tw`-blind
  trim leaves nearly half the defect in the case that shows it worst.
```

- [ ] **Step 6: Typecheck, full suite**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add test/link-rect-trim.test.ts README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
test(text): guard the link-rect trim's two traps

\s would eat the U+00A0 a code block paints for indentation, and no rendering
would reveal it — only a width does. Decoration must keep the space it drops,
read through GetPaths rather than the annotation dict. Both confirmed to go red
when broken.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing the issue

- [ ] **Run the whole gate**

```bash
npm run typecheck
npm test
npm run build
```

All three green. `test/rich-runs-identity.test.ts` and
`test/table-slice-identity.test.ts` must both pass with no hash regenerated:
this change touches no content byte, only an annotation rect.

- [ ] **Close and push**

```bash
bd close aspose-pdf-foss-for-ts-2avp
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```
