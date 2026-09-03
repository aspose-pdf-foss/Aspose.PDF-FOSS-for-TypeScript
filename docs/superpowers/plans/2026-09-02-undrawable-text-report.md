# Reporting undrawable text — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a caller who renders text the resolved face cannot encode learns that
it did not draw, instead of getting a blank page and an empty `skipped`.

**Architecture:** one new pure leaf (`textcoverage.ts`) owns "what of this text
can this face not draw". The shared flow builders — which `cssflow.ts`,
`mdflow.ts` and `Flow.Add*` all funnel through — call it once per block and fire
an opt-in `onUndrawable` sink. HTML translates that into a 20th `NotRendered`
construct, Markdown into two flat strings, and a hand-built caller receives it
raw. Table cells bypass the builders and get their own one-shot walk.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-02-undrawable-text-report-design.md`

## Global Constraints

- Zero runtime dependencies. Only `node:` built-ins. Do not add npm runtime deps.
- ESM + NodeNext: every import specifier carries the `.js` extension.
- `npm run typecheck` and `npm test` must both be green before any task closes.
- Target one file with `npx vitest run test/<name>.test.ts`.
- TDD: the failing test is written and *observed failing* before the code.
- `textcoverage.ts` is a PURE LEAF: no `Document`, no `Page`, no PDF object
  module, no `node:` import. Value imports limited to `encoding.js` and
  `embeddedfont.js`; `AuthoringFont` and `TextRun` come in as `import type`,
  which is what `textdecor.ts` already does.
- Nothing here may throw. The leaf returns `undefined` for "fully drawable".
- A document with no undrawable text must stay BYTE-IDENTICAL. The fences are
  `test/rich-runs-identity.test.ts`, `test/html-identity.test.ts`,
  `test/docx-flow-identity.test.ts`, `test/markdown-export.test.ts`.
- Every new rule gets a mutation check (Task 7). Anything reddening nothing is
  RECORDED as uncovered in CLAUDE.md rather than quietly kept.
- CHANGELOG entry lands in Task 7, as one entry for the whole issue — the shape
  `zch2.7` and `zch2.11` used.

## Three corrections to the spec, settled while pinning signatures

These are deviations from the approved design. They are decisions, not gaps.

1. **`quote()` needs no sink.** `quote(blocks: FlowElement[], …)` takes
   already-built elements and owns no text of its own (`flowblock.ts:370`); its
   children are paragraphs that detect for themselves. The spec listed it as a
   detection site. It is not one, and adding one would double-report every
   quoted paragraph.
2. **`stamp.ts`'s checks are NOT rewritten to use `coverageOf`.** They are not
   the same question: `coverageOf` SKIPS `\n`/`\r`/`\t` (the partial rule needs
   that), while the painter's `driver.probe(text) === 0` counts them as nothing.
   For `text === "\n"` the painter says "nothing to draw" and `coverageOf` says
   "fully drawable" — routing would send an empty line to the painter and move
   bytes. Instead the leaf exports the painter's sentence verbatim as
   `drawsNothing(text, driver)`, stamp.ts adopts that, and a fence test pins
   that the two answers agree on text containing no structure characters.
3. **The per-character predicate reuses each owner's own.**
   `EmbeddedFont.probe(ch) > 0` and `encodeWinAnsi(ch).length > 0` — no
   reach-through to `font.sfnt.cmapLookup`, which `stamp.ts:607` does and a leaf
   should not.

## File structure

| File | Responsibility |
|---|---|
| `src/textcoverage.ts` (new) | The leaf. `Undrawable`, `coverageOf`, `drawsNothing`. |
| `src/stamp.ts` | Adopts `drawsNothing`; `TextBlockOptions`/`StampOptions` gain `onUndrawable`; `stampText`/`stampTextBlock` fire it. |
| `src/flow.ts` | `FlowParagraphOptions`/`FlowListOptions` gain `onUndrawable`; `paragraph`, `heading`, `list` detect and fire. |
| `src/flowblock.ts` | `FlowCodeOptions` gains `onUndrawable`; `codeBlock` detects and fires. |
| `src/htmlreport.ts` | `Construct` gains `'text'`; `CONSTRUCTS` 19 → 20. |
| `src/cssflow.ts` | `textElement` passes a sink closing over its `el`. |
| `src/mdflow.ts` | Passes a sink pushing `'text'` / `'text:partial'`. |
| `src/tableauthor.ts` | `reportTableCoverage(t, onUndrawable)` — the one-shot cell walk. |
| `src/csstable.ts`, `src/flowtable.ts`, `src/page.ts`, `src/flow.ts` | Call `reportTableCoverage` once per table. |

---

### Task 1: The `textcoverage.ts` leaf

**Files:**
- Create: `src/textcoverage.ts`
- Test: `test/textcoverage.test.ts`
- Modify: `CLAUDE.md` (module-list entry)

**Interfaces:**
- Consumes: `EmbeddedFont` (`embeddedfont.js`), `encodeWinAnsi` (`encoding.js`),
  `AuthoringFont` (type, `stamp.js`), `TextRun` (type, `textdecor.js`),
  `FontDriver` (type, `layout.js`).
- Produces:
  - `interface Undrawable { lost: string; all: boolean }`
  - `coverageOf(content: string | TextRun[], blockFont: AuthoringFont, shaped: boolean): Undrawable | undefined`
  - `drawsNothing(text: string, driver: FontDriver): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/textcoverage.test.ts`:

```ts
/** The one owner of "what of this text can this face not draw" (zch2.14).
 *
 *  The exclusions are the whole feature. `probe('a\nb')` is 2 of 3 codepoints
 *  because \n is layout structure rather than ink, so without them every code
 *  block and every hard-broken paragraph in every document reports a loss. */
import { describe, it, expect } from 'vitest';
import { coverageOf } from '../src/textcoverage.js';

describe('coverageOf', () => {
  it('returns undefined for text the face draws in full', () => {
    expect(coverageOf('hello world', 'Helvetica', false)).toBeUndefined();
  });

  it('reports every character lost, and that NOTHING drew', () => {
    expect(coverageOf('При', 'Helvetica', false)).toEqual({ lost: 'При', all: true });
  });

  it('reports a PARTIAL loss without claiming the block is blank', () => {
    expect(coverageOf('alpha При omega', 'Helvetica', false))
      .toEqual({ lost: 'При', all: false });
  });

  it('does not report a newline, a carriage return or a tab', () => {
    // Measured: encodeWinAnsi drops all three, so a naive codepoint count puts
    // a report on every code block and every hard-broken paragraph.
    expect(coverageOf('a\nb', 'Helvetica', false)).toBeUndefined();
    expect(coverageOf('a\r\nb', 'Helvetica', false)).toBeUndefined();
    expect(coverageOf('a\tb', 'Helvetica', false)).toBeUndefined();
  });

  it('does not report the WinAnsi punctuation a document actually uses', () => {
    expect(coverageOf('“curly” — dash… ½', 'Helvetica', false)).toBeUndefined();
  });

  it('reports a combining mark, which genuinely does not draw', () => {
    expect(coverageOf('é', 'Helvetica', false))
      .toEqual({ lost: '́', all: false });
  });

  it('reports an astral character as one lost codepoint, not two units', () => {
    expect(coverageOf('a😀b', 'Helvetica', false))
      .toEqual({ lost: '😀', all: false });
  });

  it('DEDUPLICATES lost characters, in first-appearance order', () => {
    // Without this a page of Cyrillic puts the whole page in a report field.
    expect(coverageOf('ББА', 'Helvetica', false)?.lost).toBe('БА');
  });

  it('judges each run against its OWN face, falling back to the block font', () => {
    const runs = [{ text: 'При' }, { text: 'ok', font: 'Times-Roman' as const }];
    expect(coverageOf(runs, 'Helvetica', false)).toEqual({ lost: 'При', all: false });
  });

  it('suppresses the PARTIAL report for a shaped block, keeping all-or-nothing', () => {
    // A shaper legitimately consumes joiners and format characters, so a
    // per-character scan reports loss where nothing was lost.
    expect(coverageOf('alpha При', 'Helvetica', true)).toBeUndefined();
    expect(coverageOf('При', 'Helvetica', true)).toEqual({ lost: 'При', all: true });
  });

  it('returns undefined for text that is only structure', () => {
    expect(coverageOf('\n\t', 'Helvetica', false)).toBeUndefined();
  });

  it('returns undefined for empty content', () => {
    expect(coverageOf('', 'Helvetica', false)).toBeUndefined();
    expect(coverageOf([], 'Helvetica', false)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/textcoverage.test.ts`
Expected: FAIL — cannot resolve `../src/textcoverage.js`.

- [ ] **Step 3: Write the leaf**

Create `src/textcoverage.ts`:

```ts
/** What of a piece of text the resolved face cannot draw (zch2.14).
 *
 *  Invariant: a PURE LEAF. Value imports are `encoding.js` and
 *  `embeddedfont.js`; `AuthoringFont`, `TextRun` and `FontDriver` arrive as
 *  types, which is what textdecor.ts already does. No Document, no Page, no
 *  PDF object module, no `node:` import — so every rule below is testable
 *  from a string and a font with no PDF built. It never throws.
 *
 *  Invariant: the per-character question goes through each owner's OWN
 *  predicate — EmbeddedFont.probe and encodeWinAnsi — never a reach-through
 *  to font.sfnt.cmapLookup, which stamp.ts does and a leaf should not.
 *
 *  Invariant: STRUCTURE characters are excluded, and this is the whole
 *  feature rather than a detail. Measured: encodeWinAnsi drops \n, \r and \t,
 *  so `a\nb` probes 2 of 3 codepoints — without the exclusion every code
 *  block and every hard-broken paragraph in every document carries a report.
 *
 *  Invariant: a SHAPED block gets the all-or-nothing answer only. A shaper
 *  legitimately consumes joiners and format characters (ZWJ, ZWNJ, the bidi
 *  marks), so a per-character scan reports loss where the shaper did its job.
 *
 *  Note the DIFFERENCE from `drawsNothing`, and it is why they are two
 *  functions rather than one. `coverageOf` answers "what did the author ask
 *  for that will not appear", so it skips structure. `drawsNothing` answers
 *  the painter's question, "will any bytes be emitted", for which a lone
 *  newline IS nothing. Collapsing them sends an empty line to the painter. */

import { EmbeddedFont } from './embeddedfont.js';
import { encodeWinAnsi } from './encoding.js';
import type { AuthoringFont } from './stamp.js';
import type { TextRun } from './textdecor.js';
import type { FontDriver } from './layout.js';

/** Characters the layout engine consumes as structure rather than ink. */
const STRUCTURE = new Set(['\n', '\r', '\t']);

/** Cap on `lost`, so a page of Cyrillic does not become a report field. */
const LOST_CAP = 32;

/** What a face will not draw of the text it was given. */
export interface Undrawable {
  /** The DISTINCT undrawable characters, in first-appearance order, capped. */
  lost: string;
  /** True when NOTHING drew: the block is blank, not merely thinner. */
  all: boolean;
}

/** Can `font` draw this single character? */
function canDraw(font: AuthoringFont, ch: string): boolean {
  return font instanceof EmbeddedFont
    ? font.probe(ch) > 0
    : encodeWinAnsi(ch).length > 0;
}

/** The painter's question: will showing `text` through `driver` emit anything?
 *  Exported so stamp.ts's early returns and this module state it once. */
export function drawsNothing(text: string, driver: FontDriver): boolean {
  return driver.probe(text) === 0;
}

/** What `content` asks for that its face(s) cannot draw, or `undefined` when
 *  every character draws. A `TextRun` is judged against its own `font`, falling
 *  back to `blockFont` — the rule resolveRuns already applies, and a second
 *  rule here would report a run against a face it is not drawn in. */
export function coverageOf(
  content: string | TextRun[], blockFont: AuthoringFont, shaped: boolean,
): Undrawable | undefined {
  const parts = typeof content === 'string'
    ? [{ text: content, font: blockFont }]
    : content.map((r) => ({ text: r.text, font: r.font ?? blockFont }));

  let drew = false;
  const seen = new Set<string>();
  const lost: string[] = [];
  for (const p of parts) {
    for (const ch of p.text) {
      if (STRUCTURE.has(ch)) continue;
      if (canDraw(p.font, ch)) { drew = true; continue; }
      if (seen.has(ch)) continue;
      seen.add(ch);
      if (lost.length < LOST_CAP) lost.push(ch);
    }
  }
  if (lost.length === 0) return undefined;
  // A shaped block reports only that it drew nothing at all.
  if (drew && shaped) return undefined;
  return { lost: lost.join(''), all: !drew };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/textcoverage.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Add the CLAUDE.md module entry**

Insert into the Source list in `CLAUDE.md`, alphabetically near the other text
leaves (after the `textdecor.ts` mentions, before `toc.ts`):

```markdown
- **textcoverage.ts** — what of a piece of text the resolved face cannot draw
  (`zch2.14`). A pure leaf: `encoding.js` and `embeddedfont.js` by value,
  `AuthoringFont`/`TextRun`/`FontDriver` as types — the shape `textdecor.ts`
  already has. It never throws, and `undefined` means fully drawable.
  **Invariant:** the per-character question goes through each owner's OWN
  predicate (`EmbeddedFont.probe`, `encodeWinAnsi`), never a reach-through to
  `font.sfnt.cmapLookup` — which `stamp.ts` does and a leaf should not.
  **Invariant:** `\n`, `\r` and `\t` are EXCLUDED, and that is the feature
  rather than a detail. Measured: `encodeWinAnsi` drops all three, so `a\nb`
  probes 2 of its 3 codepoints and every code block and every hard-broken
  paragraph in every document would carry a `degraded` record.
  **Invariant:** a SHAPED block gets the all-or-nothing answer only. A shaper
  legitimately consumes joiners and format characters, so a per-character scan
  reports loss where the shaper did its job.
  **Invariant, and the two are NOT one function:** `coverageOf` skips
  structure because it answers "what did the author ask for that will not
  appear"; `drawsNothing` counts it because it answers the painter's "will any
  bytes be emitted", for which a lone newline IS nothing. Collapsing them
  sends an empty line to the painter and moves bytes.
  **Invariant:** `lost` is DISTINCT characters, capped at 32. A page of
  Cyrillic must not become a report field.
```

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/textcoverage.ts test/textcoverage.test.ts CLAUDE.md
git commit -m "feat(zch2.14): textcoverage.ts, the one owner of what a face cannot draw"
```

---

### Task 2: `stamp.ts` adopts `drawsNothing`, with an agreement fence

**Files:**
- Modify: `src/stamp.ts` (the four `driver.probe(text) === 0` sites at ~1030,
  1041, 1084, 1109, and `nothingDrawable` at ~507)
- Test: `test/textcoverage.test.ts` (append)

**Interfaces:**
- Consumes: `drawsNothing`, `coverageOf` from Task 1.
- Produces: nothing new. This task is behaviour-preserving by construction.

- [ ] **Step 1: Write the failing fence test**

Append to `test/textcoverage.test.ts`:

```ts
import { drawsNothing } from '../src/textcoverage.js';
import { winAnsiDriver } from '../src/layout.js';

describe('drawsNothing agrees with coverageOf on text without structure', () => {
  const CASES = ['hello', 'При', 'alpha При omega', '', 'é', '😀'];
  it('says nothing-drew exactly when coverageOf says all', () => {
    const d = winAnsiDriver('Helvetica');
    for (const t of CASES) {
      const cov = coverageOf(t, 'Helvetica', false);
      const allLost = cov !== undefined && cov.all;
      expect([t, drawsNothing(t, d)]).toEqual([t, allLost || t === '']);
    }
  });

  it('DIVERGES on structure, which is why they are two functions', () => {
    // The painter emits nothing for a lone newline; the author lost nothing.
    expect(drawsNothing('\n', winAnsiDriver('Helvetica'))).toBe(true);
    expect(coverageOf('\n', 'Helvetica', false)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/textcoverage.test.ts`
Expected: FAIL — `drawsNothing` is not exported yet if Task 1 was skipped;
otherwise PASS for the first case and FAIL only if the leaf is wrong. If both
pass immediately, that is expected — this test fences Task 2 rather than
driving it, so record that and continue.

- [ ] **Step 3: Adopt `drawsNothing` in stamp.ts**

In `src/stamp.ts`, add the import:

```ts
import { drawsNothing } from './textcoverage.js';
```

Replace each of the four early returns of the form:

```ts
  if (driver.probe(text) === 0) return { remainder: null, usedHeight: 0 };
```

with:

```ts
  if (drawsNothing(text, driver)) return { remainder: null, usedHeight: 0 };
```

taking care to keep each site's own return shape — they differ:
`{ remainder: null, usedHeight: 0 }` at ~1030 and ~1041,
`{ usedHeight: 0, remainder: null }` at ~1084, and `return []` at ~1109.

And in `nothingDrawable`:

```ts
function nothingDrawable(runs: ResolvedRun[]): boolean {
  return runs.every((r) => !isAtomicRun(r.layout) && drawsNothing(r.layout.text, r.layout.driver));
}
```

- [ ] **Step 4: Run the fences and the suite**

Run: `npx vitest run test/textcoverage.test.ts test/rich-runs-identity.test.ts test/html-identity.test.ts`
Expected: PASS. `rich-runs-identity` hashes emitted page bytes — this task is a
pure substitution of one expression for an identical one, so a red hash means
the substitution changed a site's semantics and must be undone, not accepted.

- [ ] **Step 5: Commit**

```bash
npm run typecheck
git add src/stamp.ts test/textcoverage.test.ts
git commit -m "refactor(zch2.14): stamp.ts states the nothing-drew rule once"
```

---

### Task 3: The `onUndrawable` sink on the builders and the page-level calls

**Files:**
- Modify: `src/stamp.ts` (`StampOptions`, `TextBlockOptions`, `stampText`,
  `stampTextBlock`)
- Modify: `src/flow.ts` (`FlowParagraphOptions`, `FlowListOptions`,
  `paragraph`, `heading`, `list`)
- Modify: `src/flowblock.ts` (`FlowCodeOptions`, `codeBlock`)
- Test: `test/text-undrawable-report.test.ts` (create)

**Interfaces:**
- Consumes: `Undrawable`, `coverageOf` from Task 1.
- Produces: `onUndrawable?: (u: Undrawable) => void` on `StampOptions`,
  `TextBlockOptions`, `FlowParagraphOptions`, `FlowListOptions`,
  `FlowCodeOptions`. `FlowHeadingOptions` extends `FlowParagraphOptions`, so
  `heading()` inherits it with no separate declaration.

- [ ] **Step 1: Write the failing test**

Create `test/text-undrawable-report.test.ts`:

```ts
/** Text the resolved face cannot encode is REPORTED, not silently dropped
 *  (zch2.14). The Standard-14 fallback has no WinAnsi code for Cyrillic, so
 *  with no registered font folder such a paragraph draws as nothing. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { Undrawable } from '../src/textcoverage.js';

const NONE = 'При';

describe('the Flow builders fire onUndrawable', () => {
  it('reports a paragraph that draws nothing, as all', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(NONE, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });

  it('reports a paragraph that loses only some characters, as NOT all', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(`alpha ${NONE} omega`, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([{ lost: 'При', all: false }]);
  });

  it('says NOTHING for a paragraph the face draws in full', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('all fine', { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([]);
  });

  it('fires EXACTLY ONCE for a paragraph, not once per measure', () => {
    // The engine measures speculatively many times per element; a sink fired
    // from measure would report a handful of duplicates for one paragraph.
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(NONE, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toHaveLength(1);
  });

  it('reports a heading and a list item', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddHeading(1, NONE, { onUndrawable: (u) => seen.push(u) });
    flow.AddList([NONE], { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toHaveLength(2);
    expect(seen.every((u) => u.all)).toBe(true);
  });

  it('reports a code block', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddCodeBlock(NONE, { onUndrawable: (u) => seen.push(u) });
    flow.Render();
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });
});

describe('a sink that throws', () => {
  it('PROPAGATES rather than being swallowed', () => {
    // resolveImage's documented rule: a throw from a caller's own callback is
    // the caller's bug, not a missing resource. Swallowing it would hide a
    // defect in the one place a caller asked to be told about things.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    // Note WHERE it throws: the sink fires at BUILD time, inside the builder
    // that AddParagraph delegates to — not during Render().
    expect(() => flow.AddParagraph(NONE, {
      onUndrawable: () => { throw new Error('caller bug'); },
    })).toThrow('caller bug');
  });
});

describe('the page-level calls fire onUndrawable', () => {
  it('reports from AddTextBlock', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddTextBlock(NONE, [50, 50, 300, 300], { onUndrawable: (u) => seen.push(u) });
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });

  it('reports from AddText', () => {
    const seen: Undrawable[] = [];
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddText(NONE, 50, 50, { onUndrawable: (u) => seen.push(u) });
    expect(seen).toEqual([{ lost: 'При', all: true }]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: FAIL — `onUndrawable` is not a known option, and `seen` stays empty.

- [ ] **Step 3: Add the option to the three option bags**

In `src/stamp.ts`, add to `StampOptions` (which `TextBlockOptions` extends, so
one declaration covers both):

```ts
  /** Called when the resolved face cannot draw some or all of this text.
   *  Opt-in: a caller who passes nothing gets the previous silence. Fires once
   *  per drawn block — never from a measure pass, which the flow engine runs
   *  speculatively many times per element. */
  onUndrawable?: (u: Undrawable) => void;
```

with `import type { Undrawable } from './textcoverage.js';` beside the
`drawsNothing` import added in Task 2.

In `src/flow.ts`, add the identical field with the identical doc comment to
`FlowParagraphOptions` and `FlowListOptions`. `FlowHeadingOptions` extends
`FlowParagraphOptions`, so it inherits.

In `src/flowblock.ts`, add it to `FlowCodeOptions`.

- [ ] **Step 4: Fire it from the builders**

In `src/flow.ts`, add a private helper above `paragraph`:

```ts
/** Report what the block's face cannot draw, once, at BUILD time. The sink is
 *  CONSUMED here and never forwarded: paragraphOptions() copies an explicit
 *  whitelist rather than spreading, so flowTextBlock cannot fire it a second
 *  time when the block is painted — and that whitelist is what enforces it. */
function reportCoverage(
  text: FlowText, font: AuthoringFont, onUndrawable?: (u: Undrawable) => void,
): void {
  if (onUndrawable === undefined) return;
  const u = coverageOf(text, font, font instanceof EmbeddedFont && font.shape);
  if (u !== undefined) onUndrawable(u);
}
```

with `import { coverageOf, type Undrawable } from './textcoverage.js';` and
`EmbeddedFont` already imported in `flow.ts` (check; add if absent).

Call it as the first statement of each builder, using the SAME default the
painter applies:

```ts
export function paragraph(text: FlowText, o: FlowParagraphOptions = {}): FlowElement[] {
  reportCoverage(text, o.font ?? 'Helvetica', o.onUndrawable);
  const { spaceBefore, spaceAfter } = normalizeSpacing(o);
  // …unchanged…
}
```

For `heading`, call it AFTER `withDefaults` is built, so the reported face is
the `'Helvetica-Bold'` the painter will use:

```ts
  reportCoverage(text, withDefaults.font ?? 'Helvetica-Bold', o.onUndrawable);
```

For `list`, report each item's body text against the list's body font
(`o.font ?? 'Helvetica'`) as the items are built.

In `src/flowblock.ts`, inside `codeBlock`, after `opts` is assembled:

```ts
  reportCoverage(preformat(text, tabWidth), options.font ?? 'Courier', options.onUndrawable);
```

Note the reported text is the PREFORMATTED text — the U+00A0 substitution is
what actually reaches the driver, and reporting the raw text would judge
characters the painter never sees. `flowblock.ts` gets its own copy of
`reportCoverage` (four lines) rather than importing it from `flow.ts`, which
imports `flowblock.ts` and would close a cycle.

- [ ] **Step 5: Fire it from the page-level calls**

In `src/stamp.ts`, in `stampTextBlock` and `stampText`, after `normalizeBlockOptions`
/ the stamp equivalent has resolved `o.font`, and BEFORE the early return:

```ts
  if (options.onUndrawable !== undefined) {
    const u = coverageOf(content, o.font, effectiveShape(o.font, options.shape));
    if (u !== undefined) options.onUndrawable(u);
  }
```

Do NOT add this to `measureTextBlock` or `wrapLines`.

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: PASS, 9 tests.

Note the Flow cases call `Render()` after `Add*` even though the sink has
already fired by then. That is deliberate and is what makes the
fires-exactly-once case meaningful: it proves placement does not fire a second
time.

- [ ] **Step 7: Run the byte-identity fences**

Run: `npx vitest run test/rich-runs-identity.test.ts test/html-identity.test.ts test/docx-flow-identity.test.ts test/markdown-export.test.ts`
Expected: PASS. The sink emits no operators; a red hash means a builder changed
what it hands the painter, which it must not.

- [ ] **Step 8: Commit**

```bash
npm run typecheck
git add src/stamp.ts src/flow.ts src/flowblock.ts test/text-undrawable-report.test.ts
git commit -m "feat(zch2.14): onUndrawable sink on the flow builders and page text"
```

---

### Task 4: HTML — the 20th construct

**Files:**
- Modify: `src/htmlreport.ts` (`Construct`, `CONSTRUCTS`)
- Modify: `src/cssflow.ts` (`textElement`)
- Modify: `test/htmlreport.test.ts:29` (19 → 20)
- Modify: `test/htmlreport-render.test.ts` (add the `'text'` render case)
- Test: `test/text-undrawable-report.test.ts` (append)

**Interfaces:**
- Consumes: `coverageOf` (Task 1), `Undrawable` (Task 1),
  `onUndrawable` on `FlowParagraphOptions` (Task 3).
- Produces: `Construct` includes `'text'`; `CONSTRUCTS.length === 20`.

- [ ] **Step 1: Write the failing test**

Append to `test/text-undrawable-report.test.ts`:

```ts
import { describe as describeReport } from '../src/htmlreport.js';

describe('AddHtml reports undrawable text', () => {
  it('reports a wholly undrawable paragraph as dropped, naming its element', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<p>${NONE}</p>`);
    const t = skipped.filter((r) => r.construct === 'text');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('dropped');
    expect(t[0].detail).toBe('При');
    expect(t[0].el?.name).toBe('p');
  });

  it('reports a partly undrawable paragraph as DEGRADED', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<p>alpha ${NONE} omega</p>`);
    const t = skipped.filter((r) => r.construct === 'text');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('degraded');
    expect(t[0].detail).toBe('При');
  });

  it('says nothing for a document the fallback face draws in full', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml('<p>all fine</p>');
    expect(skipped.filter((r) => r.construct === 'text')).toEqual([]);
  });

  it('flattens to a loggable string through describeNotRendered', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<p>${NONE}</p>`);
    expect(skipped.map(describeReport)).toContain('text:При');
  });

  it('reports the same records through all three entry points', () => {
    const src = `<p>${NONE}</p>`;
    const viaDoc = Document.New().AddHtml(src).skipped;
    const flowDoc = Document.New();
    const flow = flowDoc.NewFlow({ format: PageFormat.A4 });
    const viaFlow = flow.AddHtml(src).skipped;
    const pageDoc = Document.New();
    const { page } = pageDoc.AddPage(PageFormat.A4);
    const viaPage = page.AddHtml(src, [72, 72, 451, 697]).skipped;
    const names = (rs: { construct: string; kind: string }[]) =>
      rs.map((r) => `${r.construct}/${r.kind}`);
    expect(names(viaFlow)).toEqual(names(viaDoc));
    expect(names(viaPage)).toEqual(names(viaDoc));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: FAIL — `'text'` is not a `Construct`, and every filter is empty.

- [ ] **Step 3: Add the construct**

In `src/htmlreport.ts`, extend the union and the list. Add a new comment group
so the grouping stays meaningful:

```ts
export type Construct =
  // Replaced elements and foreign content.
  | 'iframe' | 'svg' | 'math'
  | 'object' | 'video' | 'audio' | 'canvas'
  // Form controls.
  | 'input' | 'select' | 'textarea' | 'button'
  // Properties computed and not read.
  | 'inline-block' | 'vertical-align' | 'inline-box'
  // Layout constructs.
  | 'float' | 'image' | 'table' | 'table-cell-blocks' | 'link'
  // Text the resolved face cannot draw. Matches svgdraw.ts's name for the
  // same failure, so the library states one rule across both importers.
  | 'text';

export const CONSTRUCTS: readonly Construct[] = [
  'iframe', 'svg', 'math',
  'object', 'video', 'audio', 'canvas',
  'input', 'select', 'textarea', 'button',
  'inline-block', 'vertical-align', 'inline-box',
  'float', 'image', 'table', 'table-cell-blocks', 'link',
  'text',
];
```

- [ ] **Step 4: Fire the sink from `textElement`**

In `src/cssflow.ts`, `textElement` already receives `el`. Build the sink there
and pass it into both builder calls:

```ts
function textElement(
  runs: TextRun[], el: HtmlElement | null, style: ComputedStyle,
  atomics: FlowAtomic[] | undefined, c: Ctx,
): FlowElement[] {
  const onUndrawable = (u: Undrawable): void => {
    c.skipped.push({
      el, kind: u.all ? 'dropped' : 'degraded', construct: 'text', detail: u.lost,
    });
  };
  const opts: FlowParagraphOptions = {
    align: alignOf(style.textAlign),
    leading: leadingOf(style),
    atomics: atomics !== undefined && atomics.length > 0 ? atomics : undefined,
    onUndrawable,
  };
  const level = headingLevel(el);
  if (level === 0) return paragraph(runs, opts);
  return heading(level, runs, {
    ...opts,
    font: runs[0]?.font,
    fontSize: runs[0]?.fontSize,
  });
}
```

Update both call sites (`cssflow.ts:355` and `:363`) to pass `c`:

```ts
      return frameBoxes(textElement(loneRuns, box.el, style, undefined, c), frameOf(r), spacing);
```

```ts
      textElement(runs, box.el, style, atomics, c), frameOf(r), spacing);
```

Add `import type { Undrawable } from './textcoverage.js';`.

- [ ] **Step 5: Move the two vocabulary fences**

In `test/htmlreport.test.ts:29`, change `expect(CONSTRUCTS.length).toBe(19)` to
`toBe(20)`.

In `test/htmlreport-render.test.ts`, `CASES` is typed
`[construct: string, kind: string, src: string][]` (line 175) and is asserted
against `CONSTRUCTS` at line ~199. Add this entry at the end of the list, after
the `'link'` row:

```ts
    ['text', 'dropped', '<p>При</p>'],
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/text-undrawable-report.test.ts test/htmlreport.test.ts test/htmlreport-render.test.ts test/cssflow-report.test.ts test/html-render.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add src/htmlreport.ts src/cssflow.ts test/
git commit -m "feat(zch2.14): AddHtml reports text the face cannot draw"
```

---

### Task 5: Markdown — two flat strings

**Files:**
- Modify: `src/mdflow.ts` (paragraph, heading, list, code-block mapping)
- Test: `test/text-undrawable-report.test.ts` (append)

**Interfaces:**
- Consumes: `onUndrawable` (Task 3).
- Produces: `MarkdownResult.skipped` may contain `'text'` and `'text:partial'`.
  Type unchanged (`string[]`).

- [ ] **Step 1: Write the failing test**

Append to `test/text-undrawable-report.test.ts`:

```ts
describe('AddMarkdown reports undrawable text', () => {
  it("reports 'text' when nothing drew", () => {
    const doc = Document.New();
    expect(doc.AddMarkdown(NONE).skipped).toContain('text');
  });

  it("reports 'text:partial' when only some characters were lost", () => {
    const doc = Document.New();
    expect(doc.AddMarkdown(`alpha ${NONE} omega`).skipped).toContain('text:partial');
  });

  it('says nothing for a document the fallback face draws in full', () => {
    const doc = Document.New();
    expect(doc.AddMarkdown('all fine').skipped).toEqual([]);
  });

  it('reports a heading and a fenced code block too', () => {
    const doc = Document.New();
    const { skipped } = doc.AddMarkdown(`# ${NONE}\n\n\`\`\`\n${NONE}\n\`\`\``);
    expect(skipped.filter((s) => s === 'text')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: FAIL — `skipped` contains neither string.

- [ ] **Step 3: Pass the sink from mdflow**

In `src/mdflow.ts`, add a helper beside the existing `Ctx` use:

```ts
/** The Markdown presentation of an undrawable block. `skipped` is a flat
 *  string list by decision (zch2.7 kept it that way), so the dropped/degraded
 *  distinction becomes two strings rather than a `kind` field. */
function undrawableSink(c: Ctx): (u: Undrawable) => void {
  return (u) => { c.skipped.push(u.all ? 'text' : 'text:partial'); };
}
```

with `import type { Undrawable } from './textcoverage.js';`.

Pass `onUndrawable: undrawableSink(c)` into every builder call `mdflow.ts`
makes that carries text — the `paragraph(...)` calls (lines ~109 and ~119), the
`heading(...)` call, the `list(...)` call and the `codeBlock(...)` call at
line ~148. `quote(...)` takes already-built elements and must NOT get one: its
children report for themselves and a second sink would double-report.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Run the Markdown fences**

Run: `npx vitest run test/markdown-flow.test.ts test/markdown-export.test.ts test/html-identity.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npm run typecheck
git add src/mdflow.ts test/text-undrawable-report.test.ts
git commit -m "feat(zch2.14): AddMarkdown reports text the face cannot draw"
```

---

### Task 6: Table cells

**Files:**
- Modify: `src/tableauthor.ts` (add `reportTableCoverage`)
- Modify: `src/csstable.ts` or `src/cssflow.ts` (call it for an HTML table)
- Modify: `src/mdflow.ts` (call it for a Markdown table)
- Modify: `src/page.ts` (`AddTable`) and `src/flow.ts` (`AddTable`) — pass the
  raw sink from options
- Test: `test/text-undrawable-report.test.ts` (append)

**Interfaces:**
- Consumes: `coverageOf` (Task 1), `resolveCellStyle` (existing, exported from
  `tableauthor.ts:302`).
- Produces:
  `reportTableCoverage(t: TableBuilder, onUndrawable: (u: Undrawable) => void): void`

- [ ] **Step 1: Write the failing test**

Append to `test/text-undrawable-report.test.ts`:

```ts
describe('table cells report undrawable text', () => {
  it('reports a cell whose text the face cannot draw, through AddHtml', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml(`<table><tr><td>${NONE}</td><td>ok</td></tr></table>`);
    const t = skipped.filter((r) => r.construct === 'text');
    expect(t).toHaveLength(1);
    expect(t[0].kind).toBe('dropped');
    expect(t[0].detail).toBe('При');
  });

  it('reports a Markdown table cell', () => {
    const doc = Document.New();
    const src = `| a | b |\n| --- | --- |\n| ${NONE} | ok |`;
    expect(doc.AddMarkdown(src, { gfm: true }).skipped).toContain('text');
  });

  it('says nothing for a table the face draws in full', () => {
    const doc = Document.New();
    const { skipped } = doc.AddHtml('<table><tr><td>ok</td></tr></table>');
    expect(skipped.filter((r) => r.construct === 'text')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: FAIL — no `'text'` record for a table.

- [ ] **Step 3: Add the one-shot walk to tableauthor.ts**

In `src/tableauthor.ts`:

```ts
/** Report what each cell's resolved face cannot draw, ONCE.
 *
 *  A cell's effective font comes from the cell -> row -> table cascade, which
 *  `resolveCellStyle` owns, so this cannot live in the shared flow builders the
 *  way a paragraph's check does — a cell never goes through them. Called
 *  explicitly by each consumer rather than from `measure`, which the flow
 *  engine runs speculatively many times per table. */
export function reportTableCoverage(
  t: TableBuilder, onUndrawable: (u: Undrawable) => void,
): void {
  for (const row of t.rows) {
    for (const cell of row.cells) {
      const st = resolveCellStyle(cell, row.style, t.defaults);
      const u = coverageOf(
        cell.text, st.font, st.font instanceof EmbeddedFont && st.font.shape,
      );
      if (u !== undefined) onUndrawable(u);
    }
  }
}
```

with `import { coverageOf, type Undrawable } from './textcoverage.js';`.
`EmbeddedFont` is already imported by `tableauthor.ts`. No visibility change is
needed: `TableBuilder.rows` and `.defaults`, `RowBuilder.cells` and `.style`,
and `CellBuilder.text` are all already public `readonly` (or, for `text`,
`public`) members — verified at `tableauthor.ts:518`, `:536`, `:471`, `:479`
and `:439`.

- [ ] **Step 4: Call it from the four consumers**

HTML — `src/cssflow.ts:314` already holds the builder in `built` and guards
`if (built !== null)`. Add the call as the first statement inside that guard,
before the `els.push(...table(built, …))`:

```ts
    if (built !== null) {
      reportTableCoverage(built, (u) => {
        c.skipped.push({
          el: box.el, kind: u.all ? 'dropped' : 'degraded',
          construct: 'text', detail: u.lost,
        });
      });
      els.push(...table(built, {
```

Markdown — `src/mdflow.ts:279` currently reads `return table(mdTable(n, c), {`.
Hoist the builder so it can be reported before it is placed:

```ts
      const built = mdTable(n, c);
      reportTableCoverage(built, undrawableSink(c));
      return table(built, {
```

`page.AddTable` and `Flow.AddTable` — add `onUndrawable?: (u: Undrawable) => void`
to their options bags and, when present, call `reportTableCoverage(t, opts.onUndrawable)`
once before placing.

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run test/text-undrawable-report.test.ts`
Expected: PASS, 3 new tests.

- [ ] **Step 6: Run the table fences**

Run: `npx vitest run test/csstable.test.ts test/flow-table.test.ts test/table-author.test.ts test/table-cell-runs.test.ts test/markdown-tables.test.ts test/table-slice-identity.test.ts`
Expected: PASS. Those are the exact file names in `test/` — note `flow-table`,
not `flowtable`, and `markdown-tables`, not `markdown-flow`.
`table-slice-identity` is the byte fence for a paginated table.

- [ ] **Step 7: Commit**

```bash
npm run typecheck
git add src/tableauthor.ts src/cssflow.ts src/mdflow.ts src/page.ts src/flow.ts test/
git commit -m "feat(zch2.14): table cells report text the face cannot draw"
```

---

### Task 7: Mutation sweep, docs, and close

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `CLAUDE.md`
- Verify: whole suite

**Interfaces:**
- Consumes: everything above.
- Produces: no code. This task's deliverable is EVIDENCE plus documentation.

- [ ] **Step 1: Run the full suite and the typecheck**

```bash
npm run typecheck
npm test
```
Expected: all green. Record the file and test counts.

- [ ] **Step 2: Mutation-check every new rule**

For each mutation below: apply it, run the named test file, record how many
cases redden, then REVERT it. A mutation that reddens nothing is not deleted —
it is recorded as uncovered in CLAUDE.md, the habit this repo runs on.

| # | Mutation | Expect red in |
|---|---|---|
| 1 | Drop `\n` from `STRUCTURE` in `textcoverage.ts` | `textcoverage`, and probably every code-block fixture |
| 2 | Drop `\t` from `STRUCTURE` | `textcoverage` |
| 3 | Remove the `drew && shaped` suppression | `textcoverage` |
| 4 | Return `all: drew` instead of `all: !drew` | `textcoverage`, `text-undrawable-report` |
| 5 | Drop the dedup (`seen`) | `textcoverage` |
| 6 | Fire the sink from `measureTextBlock` too | the fires-exactly-once case |
| 7 | Forward `onUndrawable` through `paragraphOptions()` | the fires-exactly-once case |
| 8 | Report the RAW text in `codeBlock` rather than the preformatted text | the code-block case |
| 9 | Use the block font for every run in `coverageOf` | the per-run case |
| 10 | Skip `reportTableCoverage` for one consumer | that consumer's table case |

- [ ] **Step 3: Write the CHANGELOG entry**

Add under `## [Unreleased]` → `### Added`. Draft, to be adjusted only where the
mutation results from Step 2 contradict it:

```markdown
- **Text a font cannot draw now says so.** With no registered font folder the
  fallback is Standard-14 with WinAnsi, which has no code for Cyrillic, Greek
  or CJK — so `AddHtml('<p>При</p>')` rendered a blank page, `skipped` came
  back empty, and nothing anywhere said why. It is reported now, on all three
  HTML entry points as a new **`text`** construct, on `AddMarkdown` as `text`
  or `text:partial`, and on hand-built flow and page text through a new opt-in
  **`onUndrawable`** option. Table cells report too, through their own walk —
  a cell never passes through the shared flow builders, so a table of Cyrillic
  would otherwise have stayed silent one construct away from the fix.
  **`dropped` versus `degraded` is the point of it**: nothing drew is one
  failure, a word vanishing out of a sentence is a worse one, because the page
  looks perfectly fine — `'alpha При omega'` drew as `'alpha  omega'` and no
  test, export or diff could tell you. **The reporting is opt-in for
  hand-built text and free for HTML and Markdown**, which already had a
  `skipped` channel promising exactly this; a callback rather than a changed
  return type, because `Flow.Add*` is chainable, `Render()` returns pages and
  `AddTextBlock` returns its remainder, and breaking three of the most-used
  methods in the library buys nothing a sink does not.
  **Two things were measured rather than reasoned about, and both would have
  shipped as bugs.** The obvious partial rule — encodable count against
  codepoint count — fires on `\n`, `\r` and `\t`, which encode to nothing
  because they are layout structure rather than ink: unfixed, every code block
  and every hard-broken paragraph in every document carries a report. And
  `FontDriver.probe` is the wrong primitive for the partial case at all, since
  the shaped driver counts GLYPHS and Arabic ligatures legitimately produce
  fewer glyphs than characters — so a shaped block gets the all-or-nothing
  answer only, and the per-character question goes through each font's own
  predicate. The construct is named `text` to match what the SVG importer has
  reported for the same failure since long before this, so the library states
  one rule across both importers rather than two. **Explicit non-goal:** no
  fallback face is substituted. We report that Times cannot draw `При`; we do
  not go looking for a face that can, which would change what documents
  render rather than only what they say about themselves. (`zch2.14`)
```

- [ ] **Step 4: Update the README limitation**

`README.md` carries a sentence added by `zch2.13` beginning "**Text the resolved
face cannot encode is dropped, and is not yet reported.**" Rewrite it: it IS
reported now, on HTML (as a `text` construct with `dropped`/`degraded`), on
Markdown (as `text` / `text:partial`), and on hand-built flow and page text
through the opt-in `onUndrawable`. Keep the advice to register a font folder,
and keep the statement that no fallback face is substituted.

- [ ] **Step 5: Record the mutation results in CLAUDE.md**

Append to the `textcoverage.ts` entry a `**Note, measured:**` line giving the
sweep's outcome, naming anything that reddened nothing as uncovered.

- [ ] **Step 6: Final verification and commit**

```bash
npm run typecheck
npm test
git add CHANGELOG.md README.md CLAUDE.md
git commit -m "docs(zch2.14): changelog, README limitation and measured coverage notes"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-zch2.14 --reason "<what shipped, the mutation results, anything uncovered>"
git add .beads/
git commit -m "chore(beads): close zch2.14"
git pull --rebase
git push
git status -sb
```
Expected: `## main...origin/main` with nothing ahead.
