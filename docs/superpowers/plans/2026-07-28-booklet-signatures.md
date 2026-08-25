# Booklet `sheetsPerSignature` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `doc.Booklet` split a long book into several separately-folded signatures via `sheetsPerSignature`, with an opt-in `padSignatures` for uniform signature sizes.

**Architecture:** The change is confined to page *ordering*. `bookletSides` grows an options object and chunks the padded page list into signatures, running today's per-signature formula over each chunk with an offset; `BookletSide.sheet` becomes the nesting level **within** its signature (so creep restarts per fold) and a `signature` index is added. Geometry (`bookletCells`, `BookletMetrics`), sheet assembly and placement are untouched.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, zero runtime dependencies.

Spec: `docs/superpowers/specs/2026-07-28-booklet-signatures-design.md`. Issue: `aspose-pdf-foss-for-ts-1gg0.6`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension.
- **The default path must not move.** Omitting `sheetsPerSignature` yields exactly today's output; the single-signature case is `k = 0, M = N` in the new formula, not a separate branch.
- **`M` is always a multiple of 4.** `N` and `P = 4 * sheetsPerSignature` both are, so every chunk — including a short last one — is a whole number of sheets.
- **`BookletSide.sheet` is per-signature.** It drives creep, and each signature folds separately. A globally increasing level is the bug this feature is most likely to introduce.
- **Validate before allocating.** All new checks join `Document.Booklet`'s existing up-front block, which runs before the output Document is built.
- **Issue tracking is `bd`.** Do NOT use TodoWrite or markdown TODO lists.
- **Before closing the issue:** `npm run typecheck` and `npm test` must both be green.
- Commit after every task. Do not push until the whole plan is done and the session-close protocol in `CLAUDE.md` runs.

---

### Task 1: Signature chunking in the pure model

`bookletSides` takes an options object, chunks the padded list into signatures, and reports each side's signature index and per-signature nesting level.

**Files:**
- Modify: `src/booklet.ts` (`BookletOptions` ~line 8, `BookletSide` ~line 24, `bookletSides` ~line 52)
- Modify: `src/document.ts:1884` (the one call site — `bookletSides(src.length, binding)`)
- Test: `test/booklet.test.ts` (existing `bookletSides — ordering` describe, plus a new one)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, from `src/booklet.ts`:
  - `BookletOptions.sheetsPerSignature?: number` and `BookletOptions.padSignatures?: boolean`
  - `type BookletOrderOptions = Pick<BookletOptions, 'binding' | 'sheetsPerSignature' | 'padSignatures'>`
  - `BookletSide.signature: number` (new field; `sheet` keeps its name but changes meaning to per-signature)
  - `bookletSides(pageCount: number, opts?: BookletOrderOptions): BookletSide[]` — **replaces** `bookletSides(pageCount, binding)`

- [ ] **Step 1: Migrate the existing call sites to the options object**

Every current call passes a binding positionally — 12 of them, all inside the
`bookletSides — ordering` describe (`grep -n "bookletSides(" test/booklet.test.ts`
lists them). Change each to the object form, e.g.:

```ts
    expect(shape(bookletSides(4, { binding: 'left' }))).toEqual(['4|1', '2|3']);
    expect(bookletSides(4, { binding: 'left' }).map((s) => s.sheet)).toEqual([0, 0]);
```

`bookletSides(8)` (the "defaults to left binding" test) and `bookletSides(0, 'left')`
become `bookletSides(8)` and `bookletSides(0)`.

In `src/document.ts:1884`:

```ts
    const sides = bookletSides(src.length, { binding });
```

Do not run anything yet — the implementation lands in Step 3.

- [ ] **Step 2: Write the failing test**

Append a new describe to `test/booklet.test.ts`, after the
`bookletSides — ordering` one:

```ts
describe('bookletSides — signatures', () => {
  it('splits into one-sheet signatures, each folding on its own', () => {
    const sides = bookletSides(12, { sheetsPerSignature: 1 });
    expect(shape(sides)).toEqual(['4|1', '2|3', '8|5', '6|7', '12|9', '10|11']);
    expect(sides.map((s) => s.signature)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('nests two sheets inside each two-sheet signature', () => {
    const sides = bookletSides(16, { sheetsPerSignature: 2 });
    expect(shape(sides)).toEqual([
      '8|1', '2|7', '6|3', '4|5',        // signature 0: pages 1-8
      '16|9', '10|15', '14|11', '12|13', // signature 1: pages 9-16
    ]);
    expect(sides.map((s) => s.signature)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('lets the last signature be short', () => {
    // 10 pages -> padded to 12 -> signature 0 has 2 sheets, signature 1 has 1.
    const sides = bookletSides(10, { sheetsPerSignature: 2 });
    expect(shape(sides)).toEqual(['8|1', '2|7', '6|3', '4|5', '_|9', '10|_']);
    expect(sides.map((s) => s.signature)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 1, 1, 0, 0]);
  });

  it('pads every signature full with padSignatures', () => {
    // 10 pages -> padded to 16 -> two full two-sheet signatures.
    const sides = bookletSides(10, { sheetsPerSignature: 2, padSignatures: true });
    expect(shape(sides)).toEqual([
      '8|1', '2|7', '6|3', '4|5',
      '_|9', '10|_', '_|_', '_|_',
    ]);
    expect(sides.map((s) => s.sheet)).toEqual([0, 0, 1, 1, 0, 0, 1, 1]);
  });

  it('pads a book shorter than one signature up to a full one', () => {
    // 6 pages, 4 sheets/signature = 16 pages/signature -> padded to 16.
    const sides = bookletSides(6, { sheetsPerSignature: 4, padSignatures: true });
    expect(sides).toHaveLength(8);
    expect(sides.every((s) => s.signature === 0)).toBe(true);
    expect(shape(sides).slice(0, 2)).toEqual(['_|1', '2|_']);
  });

  it('mirrors signature cells with binding right', () => {
    const sides = bookletSides(8, { sheetsPerSignature: 1, binding: 'right' });
    expect(shape(sides)).toEqual(['1|4', '3|2', '5|8', '7|6']);
  });

  it('places every real page exactly once, whatever the signature size', () => {
    for (const n of [5, 9, 10, 13, 17]) {
      for (const sheetsPerSignature of [1, 2, 3]) {
        const seen = bookletSides(n, { sheetsPerSignature })
          .flatMap((s) => [s.left, s.right])
          .filter((p): p is number => p !== null)
          .sort((a, b) => a - b);
        expect(seen).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      }
    }
  });

  it('is a no-op when the whole book fits one signature', () => {
    expect(bookletSides(8, { sheetsPerSignature: 2 })).toEqual(bookletSides(8));
    expect(bookletSides(8, { sheetsPerSignature: 9 })).toEqual(bookletSides(8));
  });
});
```

Also add `signature` to the existing ordering suite's first test so the new field
is asserted on the default path:

```ts
    expect(bookletSides(4, { binding: 'left' }).map((s) => s.signature)).toEqual([0, 0]);
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/booklet.test.ts -t "signatures"`
Expected: FAIL — `sheetsPerSignature` is ignored, so every shape comes back as the single-signature ordering and `signature` is `undefined`.

- [ ] **Step 4: Write the implementation**

In `src/booklet.ts`, add to `BookletOptions` after `creep`:

```ts
  /** Sheets per folded signature. Integer >= 1. Default: the whole book is one
   *  signature — folding 40 nested sheets is not physical, so a long book is
   *  bound as several signatures, each folded and stapled separately. */
  sheetsPerSignature?: number;
  /** Pad the book so every signature holds exactly `sheetsPerSignature` sheets.
   *  Default false: the last signature is short, as a real bindery would run it.
   *  Requires `sheetsPerSignature`. */
  padSignatures?: boolean;
```

Add `signature` to `BookletSide` and restate what `sheet` means:

```ts
/** @internal One printed side of a folded sheet. */
export interface BookletSide {
  /** Nesting level WITHIN its signature: 0 = that signature's outermost sheet.
   *  Drives creep, which restarts per signature because each one folds on its
   *  own — a globally increasing level would shift the last sheet of a long
   *  book by many times the intended creep. */
  sheet: number;
  /** 0-based signature index; always 0 without `sheetsPerSignature`. */
  signature: number;
  /** 1-based source page number in the left cell, or null for a pad blank. */
  left: number | null;
  /** 1-based source page number in the right cell, or null for a pad blank. */
  right: number | null;
}

/** @internal The ordering options — the subset of BookletOptions that decides
 *  which page lands on which sheet, as opposed to sheet geometry. */
export type BookletOrderOptions =
  Pick<BookletOptions, 'binding' | 'sheetsPerSignature' | 'padSignatures'>;
```

Replace `bookletSides` with:

```ts
export function bookletSides(
  pageCount: number, opts: BookletOrderOptions = {},
): BookletSide[] {
  if (pageCount <= 0) return [];
  const binding = opts.binding ?? 'left';
  let n = Math.ceil(pageCount / 4) * 4;
  // Without sheetsPerSignature the whole book is one signature, so perSig = n
  // and the loop below runs exactly once with offset 0 — today's formula, not a
  // separate branch.
  const perSig = opts.sheetsPerSignature !== undefined ? 4 * opts.sheetsPerSignature : n;
  if (opts.padSignatures) n = Math.ceil(n / perSig) * perSig;
  const cell = (p: number): number | null => (p <= pageCount ? p : null);
  const sides: BookletSide[] = [];
  for (let signature = 0, offset = 0; offset < n; signature++, offset += perSig) {
    // Both n and perSig are multiples of 4, so a short last chunk is still a
    // whole number of sheets.
    const m = Math.min(perSig, n - offset);
    for (let s = 0; s < m / 4; s++) {
      const pairs: [number, number][] = [
        [offset + m - 2 * s, offset + 2 * s + 1],     // front
        [offset + 2 * s + 2, offset + m - 2 * s - 1], // back
      ];
      for (const [l, r] of pairs) {
        const [left, right] = binding === 'right' ? [r, l] : [l, r];
        sides.push({ sheet: s, signature, left: cell(left), right: cell(right) });
      }
    }
  }
  return sides;
}
```

Update the doc comment above it to describe chunking (keep the existing prose
about padding and blanks, and add):

```
 *  With `sheetsPerSignature` the padded list is split into chunks of
 *  4 * sheetsPerSignature pages and the same formula runs over each chunk at an
 *  offset; `padSignatures` first pads the book so every chunk is full.
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/booklet.test.ts`
Expected: PASS — the new suite plus every pre-existing booklet test, which is the
proof the default path did not move.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/booklet.ts src/document.ts test/booklet.test.ts
git commit -m "feat(booklet): signature chunking in bookletSides (1gg0.6)"
```

---

### Task 2: `sheetsPerSignature` on `Document.Booklet`

Validation and threading, so the option reaches the model and creep restarts per fold in real output.

**Files:**
- Modify: `src/document.ts:1849-1884` (`Booklet`: the validation block and the `bookletSides` call)
- Test: `test/booklet.test.ts` (two new describes)

**Interfaces:**
- Consumes: `bookletSides(pageCount, opts?: BookletOrderOptions)`, `BookletSide.signature`, `BookletOptions.sheetsPerSignature` / `.padSignatures` (Task 1).
- Produces: no new exported names — `Booklet(opts?: BookletOptions): Document` is unchanged in shape.

- [ ] **Step 1: Write the failing test**

Append to `test/booklet.test.ts`:

```ts
describe('doc.Booklet — signatures', () => {
  it('imposes each signature as its own fold', () => {
    const out = Document.Open(buildNUpSource(8)).Booklet({ sheetsPerSignature: 1 });
    expect(out.Pages.length).toBe(4);
    expect(placed(out, out.Pages[0]).map((p) => p.label)).toEqual(['P4', 'P1']);
    expect(placed(out, out.Pages[1]).map((p) => p.label)).toEqual(['P2', 'P3']);
    expect(placed(out, out.Pages[2]).map((p) => p.label)).toEqual(['P8', 'P5']);
    expect(placed(out, out.Pages[3]).map((p) => p.label)).toEqual(['P6', 'P7']);
  });

  it('leaves the last signature short by default', () => {
    // 10 pages -> padded to 12 -> 6 printed sides.
    const out = Document.Open(buildNUpSource(10)).Booklet({ sheetsPerSignature: 2 });
    expect(out.Pages.length).toBe(6);
  });

  it('pads every signature full with padSignatures', () => {
    // 10 pages -> padded to 16 -> 8 printed sides, the last carrying nothing.
    const out = Document.Open(buildNUpSource(10))
      .Booklet({ sheetsPerSignature: 2, padSignatures: true });
    expect(out.Pages.length).toBe(8);
    expect(pageXObjects(out, out.Pages[6]).size).toBe(0);
    expect(pageXObjects(out, out.Pages[7]).size).toBe(0);
  });

  it('matches the default output when the book fits one signature', () => {
    const a = Document.Open(buildNUpSource(8)).Booklet({ sheetsPerSignature: 2 }).Save();
    const b = Document.Open(buildNUpSource(8)).Booklet().Save();
    expect(a).toEqual(b);
  });

  it('restarts creep at every signature', () => {
    // 16 pages, 2 sheets/signature -> sides: sig0 s0, sig0 s1, sig1 s0, sig1 s1
    // (two output pages each). Signature 1's sheet 1 is the FOURTH physical
    // sheet: a globally-counted nesting level would shift it by 3*creep.
    const out = Document.Open(buildNUpSource(16))
      .Booklet({ sheetsPerSignature: 2, creep: 2 });
    expect(out.Pages.length).toBe(8);
    const sig0sheet1 = placed(out, out.Pages[2]);
    const sig1sheet0 = placed(out, out.Pages[4]);
    const sig1sheet1 = placed(out, out.Pages[6]);
    expect(sig0sheet1[0].e).toBeCloseTo(2, 6);     // 1 * creep
    expect(sig1sheet0[0].e).toBeCloseTo(0, 6);     // outermost of its fold: unshifted
    expect(sig1sheet1[0].e).toBeCloseTo(2, 6);     // 1 * creep, NOT 3 * creep
    expect(sig1sheet1[1].e).toBeCloseTo(198, 6);   // right cell, inward
  });
});

describe('doc.Booklet — signature validation', () => {
  const doc = () => Document.Open(buildNUpSource(4));

  it('rejects a sheetsPerSignature that is not a positive integer', () => {
    expect(() => doc().Booklet({ sheetsPerSignature: 0 })).toThrow(TypeError);
    expect(() => doc().Booklet({ sheetsPerSignature: -1 })).toThrow(TypeError);
    expect(() => doc().Booklet({ sheetsPerSignature: 1.5 })).toThrow(TypeError);
    expect(() => doc().Booklet({ sheetsPerSignature: NaN })).toThrow(TypeError);
  });

  it('rejects a non-boolean padSignatures', () => {
    expect(() => doc().Booklet({ sheetsPerSignature: 1, padSignatures: 'yes' as unknown as boolean }))
      .toThrow(TypeError);
  });

  it('rejects padSignatures without sheetsPerSignature', () => {
    expect(() => doc().Booklet({ padSignatures: true })).toThrow(TypeError);
    expect(() => doc().Booklet({ padSignatures: false })).toThrow(TypeError);
  });

  it('leaves the source untouched when a signature option is rejected', () => {
    const d = doc();
    const before = d.Save();
    expect(() => d.Booklet({ sheetsPerSignature: 0 })).toThrow(TypeError);
    expect(d.Save()).toEqual(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/booklet.test.ts -t "signature"`
Expected: FAIL — `Booklet` ignores both options, so page counts and placements
match the single-signature imposition and no call throws.

- [ ] **Step 3: Write the implementation**

In `src/document.ts`, inside `Booklet`, after the `pageSize` check (~line 1863)
and before `const src = this.Pages;`:

```ts
    const sheetsPerSignature = opts.sheetsPerSignature;
    if (sheetsPerSignature !== undefined &&
        (!Number.isInteger(sheetsPerSignature) || sheetsPerSignature < 1))
      throw new TypeError('Booklet: sheetsPerSignature must be an integer >= 1');
    if (opts.padSignatures !== undefined && typeof opts.padSignatures !== 'boolean')
      throw new TypeError('Booklet: padSignatures must be a boolean');
    // An option that cannot do anything is rejected, not ignored: padding to
    // full signatures is meaningless without a signature size.
    if (opts.padSignatures !== undefined && sheetsPerSignature === undefined)
      throw new TypeError('Booklet: padSignatures requires sheetsPerSignature');
    const padSignatures = opts.padSignatures ?? false;
```

Then change the `bookletSides` call (~line 1884, currently
`bookletSides(src.length, { binding })` after Task 1):

```ts
    const sides = bookletSides(src.length, { binding, sheetsPerSignature, padSignatures });
```

Nothing else in `Booklet` changes: `bookletCells(metrics, side.sheet)` already
reads the per-signature nesting level, and sheet assembly is driven by
`sides.length`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/booklet.test.ts test/nup.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/document.ts test/booklet.test.ts
git commit -m "feat(booklet): sheetsPerSignature and padSignatures on Document.Booklet (1gg0.6)"
```

---

### Task 3: Prove the assertions load-bearing, then document

**Files:**
- Modify: `README.md:24` (composition feature bullet) and `README.md:1383` (API table row)
- Test: no new tests — this task breaks the code on purpose and restores it

**Interfaces:**
- Consumes: everything from Tasks 1–2. No new production code unless a mutation reveals a gap.

- [ ] **Step 1: Mutation 1 — global nesting level**

The repo rule: a test that has never been seen to fail has not been shown to test
anything. In `src/booklet.ts`, make `sheet` count globally by hoisting a counter
outside the signature loop:

```ts
  let physicalSheet = 0;
  for (let signature = 0, offset = 0; offset < n; signature++, offset += perSig) {
    const m = Math.min(perSig, n - offset);
    for (let s = 0; s < m / 4; s++, physicalSheet++) {
      // … and push `sheet: physicalSheet` instead of `sheet: s`
```

Run: `npx vitest run test/booklet.test.ts`
Expected: **FAIL** — "restarts creep at every signature" and the per-signature
`sheet` assertions in Task 1's suite.

Restore: `git checkout src/booklet.ts`

- [ ] **Step 2: Mutation 2 — drop the chunk offset**

In `src/booklet.ts`, remove `offset +` from all four page expressions in `pairs`:

```ts
      const pairs: [number, number][] = [
        [m - 2 * s, 2 * s + 1],
        [2 * s + 2, m - 2 * s - 1],
      ];
```

Run: `npx vitest run test/booklet.test.ts`
Expected: **FAIL** — every signature would repeat pages 1..M, so the chunking
shapes and "places every real page exactly once" both go red.

Restore: `git checkout src/booklet.ts`

- [ ] **Step 3: Mutation 3 — padSignatures ignored**

In `src/booklet.ts`, delete the padding line:

```ts
  if (opts.padSignatures) n = Math.ceil(n / perSig) * perSig;
```

Run: `npx vitest run test/booklet.test.ts`
Expected: **FAIL** — the two `padSignatures` tests in Task 1 and the page-count
test in Task 2.

Restore: `git checkout src/booklet.ts`, then confirm green:
`npx vitest run test/booklet.test.ts`

- [ ] **Step 4: Update the README**

In `README.md:24`, the composition bullet describes `doc.Booklet`. Replace the
parenthesised option list

```
(`binding` for an RTL book, `pageSize`, `margin`, `gutter`, and `creep` to compensate for the fore-edge push-out of nested sheets)
```

with

```
(`binding` for an RTL book, `pageSize`, `margin`, `gutter`, and `creep` to compensate for the fore-edge push-out of nested sheets). By default the whole book is one signature; `sheetsPerSignature` splits it into several separately-folded signatures (40 nested sheets is not physically foldable), the last one short unless `padSignatures` pads every signature full
```

In `README.md:1383`, extend the `doc.Booklet` row's option list from

```
(`binding`, `pageSize`, `margin`, `gutter`, `creep`)
```

to

```
(`binding`, `pageSize`, `margin`, `gutter`, `creep`, `sheetsPerSignature`, `padSignatures`)
```

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: the full suite green.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs(booklet): sheetsPerSignature and padSignatures (1gg0.6)

Mutation-checked: a global nesting level, a dropped chunk offset, and an
ignored padSignatures each turn the suite red."
```

- [ ] **Step 7: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.6
```

Then follow the session-close protocol in `CLAUDE.md`: file follow-ups for
anything left, `git pull --rebase`, `git push`, and confirm `git status` shows the
branch up to date with origin.
