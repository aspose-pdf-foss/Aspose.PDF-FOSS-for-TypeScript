# Family and style matching (`l1my.3`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller ask `LoadFontByName` for a weight and a slant, name several families in preference order, see which face was actually chosen, and get the four faces Markdown emphasis needs.

**Architecture:** A new pure leaf `src/fontmatch.ts` holds every rule — deriving a face's weight and slant from what the index already recorded, filtering by family, and the CSS Fonts 4 §5.2 slant-then-weight walk — over `FaceRecord[]` with no `node:fs` and no `Document`. `document.ts` keeps the I/O and the memo: it concatenates the indexed folders, calls the matcher, and loads the winner. Nothing new is read from any font file.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest, zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-24-font-family-style-matching-design.md` — read it before Task 1. The plan argues from it.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. `fontmatch.ts` imports none at all.
- **ESM + NodeNext:** every import specifier carries the `.js` extension (`import type { FaceRecord } from './fontsource.js';`).
- **Strict TypeScript.** `npm run typecheck` must be green before any commit.
- **No new disk reads.** Every rule is arithmetic over `FaceRecord.names`, which `fontsource.ts` already populates during its partial-read scan. If a task seems to need a new sfnt table, stop — that is out of scope per the spec.
- **`test/font-byname.test.ts` is a regression fence.** Its existing cases must stay green **with no edits**. A red case there means the general rule got the `l1my.1` special case wrong; it is never a stale fixture.
- **Errors:** nothing in this feature throws. A miss is `undefined`; a nonsense weight is clamped.
- **Spec correction carried by this plan:** the spec names the four-face type `FontFamilySpec`. The real type in `src/mdstyle.ts:14` is **`MarkdownFontFamily`**. Task 4 declares its own `FontFamily` in `fontmatch.ts`, which is structurally assignable to it. Do not import `mdstyle.js` from `document.ts`.
- **Commit style:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` as the last line of every commit message. Cite `l1my.3` in the subject scope.

---

### Task 1: Style derivation in a new pure leaf

Derive a face's **weight** and **slant** from the fields the index already holds. This is the analogue of `fontStyleOf` in `font.ts`: every signal is positive evidence and they are OR-ed.

**Files:**
- Create: `src/fontmatch.ts`
- Test: `test/font-match.test.ts`

**Interfaces:**
- Consumes: `FontNames` from `src/fontnames.ts` (fields `family`, `subfamily`, `typographicFamily`, `typographicSubfamily`, `postScriptName`, `bold`, `italic`, `weight`), `FaceRecord` from `src/fontsource.ts` (`{ path, faceIndex, names }`). **Type-only imports** — no runtime edge.
- Produces: `export interface FaceStyle { weight: number; italic: boolean }`, `export function weightFromSubfamily(s: string): number | undefined`, `export function deriveStyle(names: FontNames): FaceStyle`.

- [ ] **Step 1: Write the failing test**

Create `test/font-match.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveStyle, weightFromSubfamily } from '../src/fontmatch.js';
import type { FontNames } from '../src/fontnames.js';
import type { FaceRecord } from '../src/fontsource.js';

/** A FaceRecord over hand-written naming fields — the whole point of the pure
 *  split: no temp folder, no sfnt, no Document. `weight` defaults to 400
 *  because that is what an ABSENT OS/2 table yields, which is the case the
 *  corroboration rule exists for. */
export function rec(
  n: Partial<FontNames> & { family: string },
  path = `${n.family}-${n.subfamily ?? 'Regular'}.ttf`,
): FaceRecord {
  return {
    path,
    faceIndex: 0,
    names: {
      family: n.family,
      subfamily: n.subfamily ?? 'Regular',
      typographicFamily: n.typographicFamily,
      typographicSubfamily: n.typographicSubfamily,
      postScriptName: n.postScriptName,
      bold: n.bold ?? false,
      italic: n.italic ?? false,
      weight: n.weight ?? 400,
    },
  };
}

describe('weightFromSubfamily', () => {
  it('reads the nine documented weight words', () => {
    expect(weightFromSubfamily('Thin')).toBe(100);
    expect(weightFromSubfamily('ExtraLight')).toBe(200);
    expect(weightFromSubfamily('Light')).toBe(300);
    expect(weightFromSubfamily('Regular')).toBe(400);
    expect(weightFromSubfamily('Medium')).toBe(500);
    expect(weightFromSubfamily('SemiBold')).toBe(600);
    expect(weightFromSubfamily('Bold')).toBe(700);
    expect(weightFromSubfamily('ExtraBold')).toBe(800);
    expect(weightFromSubfamily('Black')).toBe(900);
  });

  it('prefers the longer word where one contains another', () => {
    // 'ExtraLight' contains 'Light' and 'SemiBold' contains 'Bold', so a
    // first-match scan in the wrong order silently reports 300 and 700 —
    // plausible weights, and both wrong. Order is the whole rule here.
    expect(weightFromSubfamily('Extra Light')).toBe(200);
    expect(weightFromSubfamily('UltraLight')).toBe(200);
    expect(weightFromSubfamily('Demi Bold')).toBe(600);
    expect(weightFromSubfamily('UltraBold')).toBe(800);
  });

  it('reports nothing for a word that names no weight', () => {
    expect(weightFromSubfamily('Condensed')).toBeUndefined();
    expect(weightFromSubfamily('')).toBeUndefined();
  });
});

describe('deriveStyle — weight', () => {
  it('trusts a stated weight that is not the default', () => {
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Light', weight: 300 }).names).weight).toBe(300);
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Bold', weight: 700 }).names).weight).toBe(700);
  });

  it('does NOT re-derive a stated weight from the subfamily name', () => {
    // 'Roboto Condensed Light' at a stated 300 must stay 300. The name is a
    // second opinion nobody asked for once the font made a numeric statement.
    const n = rec({ family: 'F', subfamily: 'Bold', weight: 300 }).names;
    expect(deriveStyle(n).weight).toBe(300);
  });

  it('corroborates a weight of 400 from the macStyle bold bit', () => {
    // 400 is ALSO what an absent OS/2 and a stated 0 produce, so it is the one
    // value that may mean "said nothing". A mis-stated Bold left at 400 is both
    // unreachable at 700 and a rival for the face returned at 400.
    const n = rec({ family: 'F', subfamily: 'Bold', weight: 400, bold: true }).names;
    expect(deriveStyle(n).weight).toBe(700);
  });

  it('corroborates a weight of 400 from the subfamily with the bit clear', () => {
    const n = rec({ family: 'F', subfamily: 'SemiBold', weight: 400 }).names;
    expect(deriveStyle(n).weight).toBe(600);
  });

  it('prefers the typographic subfamily (ID 17) over ID 2', () => {
    // The everyday shape: ID 1 'Roboto Light' / ID 2 'Regular', with the
    // typographic pair saying 'Roboto' / 'Light'. Read ID 2 and every weight of
    // the family derives as 400.
    const n = rec({
      family: 'Roboto Light', subfamily: 'Regular',
      typographicFamily: 'Roboto', typographicSubfamily: 'Light', weight: 400,
    }).names;
    expect(deriveStyle(n).weight).toBe(300);
  });

  it('falls back to 400 when nothing states a weight', () => {
    expect(deriveStyle(rec({ family: 'F' }).names).weight).toBe(400);
  });
});

describe('deriveStyle — slant', () => {
  it('reads the macStyle italic bit', () => {
    expect(deriveStyle(rec({ family: 'F', italic: true }).names).italic).toBe(true);
  });

  it('reads "italic" and "oblique" from the subfamily with the bit clear', () => {
    // head.macStyle has no oblique bit, so a face named Oblique that leaves the
    // italic bit clear is otherwise invisible to an italic request.
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Italic' }).names).italic).toBe(true);
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Oblique' }).names).italic).toBe(true);
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Bold Oblique' }).names).italic).toBe(true);
  });

  it('is upright when neither signal fires', () => {
    expect(deriveStyle(rec({ family: 'F', subfamily: 'Bold' }).names).italic).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-match.test.ts`
Expected: FAIL — `Failed to resolve import "../src/fontmatch.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/fontmatch.ts`:

```ts
/**
 * Choosing a face: deriving what style a face IS, and which face best answers a
 * request for a family, a weight and a slant.
 *
 * A pure leaf. It takes `FaceRecord[]` and returns one of them — no `node:fs`,
 * no `Document`, and no font file — which is what lets every branch of the
 * weight walk be asserted from hand-built records. `fontsource.ts` imports
 * nothing from here; the two type imports below are erased.
 *
 * The matching rule is CSS Fonts 4 §5.2, cited rather than invented: slant
 * first, then the desired-weight walk. See the design under
 * `docs/superpowers/specs/2026-08-24-font-family-style-matching-design.md`.
 */
import type { FontNames } from './fontnames.js';
import type { FaceRecord } from './fontsource.js';

/** A face's style as DERIVED, which is not always what it states. */
export interface FaceStyle {
  /** CSS weight, 1..1000. */
  weight: number;
  /** Italic or oblique — one bit, since `head.macStyle` has no oblique. */
  italic: boolean;
}

/**
 * The weight a subfamily word names.
 *
 * ORDER IS THE RULE: 'ExtraLight' contains 'Light' and 'SemiBold' contains
 * 'Bold', so the compound spellings must be tested first or a first-match scan
 * reports 300 and 700 — plausible weights, and both wrong.
 */
const SUBFAMILY_WEIGHTS: readonly (readonly [RegExp, number])[] = [
  [/extra\s*light|ultra\s*light/i, 200],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/thin/i, 100],
  [/light/i, 300],
  [/medium/i, 500],
  [/black|heavy/i, 900],
  [/bold/i, 700],
  [/book|regular|normal/i, 400],
];

/** The weight `s` names, or undefined when it names none. */
export function weightFromSubfamily(s: string): number | undefined {
  for (const [re, w] of SUBFAMILY_WEIGHTS) if (re.test(s)) return w;
  return undefined;
}

/**
 * A face's derived weight and slant.
 *
 * Every signal is POSITIVE evidence and they are OR-ed — the rule `fontStyleOf`
 * in font.ts already sets for the same question asked of a document's own
 * fonts. A face that merely omits `OS/2` says nothing and must not veto a
 * subfamily that says Bold.
 *
 * The weight corroboration fires ONLY at 400, deliberately. 400 is what an
 * absent `OS/2`, a stated 0 and a genuine Regular all produce, so it is the one
 * value that may mean "said nothing" — and a mis-stated Bold left there costs
 * twice, being unreachable at 700 AND a rival for the face returned at 400. At
 * any other value the font made a numeric statement and the name is a second
 * opinion nobody asked for.
 */
export function deriveStyle(names: FontNames): FaceStyle {
  const sub = names.typographicSubfamily ?? names.subfamily;
  const stated = names.weight;
  const weight = stated !== 400
    ? stated
    : names.bold ? 700 : (weightFromSubfamily(sub) ?? 400);
  return { weight, italic: names.italic || /italic|oblique/i.test(sub) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/font-match.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Mutation-check the two rules that would otherwise be green either way**

Per the repo rule, prove the assertions load-bearing rather than watching them go green.

1. Move `[/bold/i, 700]` above `[/semi\s*bold|demi\s*bold/i, 600]` in `SUBFAMILY_WEIGHTS`. Run `npx vitest run test/font-match.test.ts`. Expected: RED on "prefers the longer word where one contains another". **Restore it.**
2. Change `stated !== 400` to `stated !== 400 && stated !== 300`. Run again. Expected: RED on "does NOT re-derive a stated weight from the subfamily name". **Restore it.**

Record both results in the commit body. If either stays green, the test is not pinning the rule — fix the test before proceeding.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/fontmatch.ts test/font-match.test.ts
git commit -F - <<'EOF'
feat(l1my.3): derive a face's weight and slant

A new pure leaf, src/fontmatch.ts, over FaceRecord[] -- no fs and no
Document, so every rule is assertable from hand-written naming fields.

Signals are positive evidence and OR-ed, the rule fontStyleOf already
sets in font.ts. The weight corroboration fires only at 400, which is
what an absent OS/2, a stated 0 and a genuine Regular all produce alike
-- the one value that may mean "said nothing". A mis-stated Bold left
there is both unreachable at 700 and a rival for the face returned at
400, so it costs twice.

Measured load-bearing: reordering SUBFAMILY_WEIGHTS so /bold/ precedes
/semibold/ reddens the containment case, and widening the corroboration
past 400 reddens the stated-weight case.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The family filter and the CSS §5.2 matcher

**Files:**
- Modify: `src/fontmatch.ts` (append)
- Modify: `test/font-match.test.ts` (append)

**Interfaces:**
- Consumes: `deriveStyle`, `FaceStyle` and the `rec()` helper from Task 1.
- Produces:
  - `export interface StyleRequest { weight: number; italic: boolean }`
  - `export function clampWeight(w: number | undefined): number`
  - `export function familyMatches(names: FontNames, want: string): boolean` — `want` must already be trimmed and lower-cased.
  - `export function weightKey(have: number, want: number): [number, number]` — a lexicographic sort key; lower is better.
  - `export function matchFace(faces: readonly FaceRecord[], want: string, req: StyleRequest): FaceRecord | undefined`
  - `export function matchChain(faces: readonly FaceRecord[], chain: readonly string[], req: StyleRequest): FaceRecord | undefined`

- [ ] **Step 1: Write the failing test**

Append to `test/font-match.test.ts`:

```ts
import { clampWeight, familyMatches, matchChain, matchFace, weightKey } from '../src/fontmatch.js';

/** Roboto in six weights, upright, in a deliberately unsorted order so that a
 *  matcher which merely takes the first or last face cannot pass. */
const ROBOTO = [
  rec({ family: 'Roboto', subfamily: 'Medium', weight: 500 }),
  rec({ family: 'Roboto', subfamily: 'Thin', weight: 100 }),
  rec({ family: 'Roboto', subfamily: 'Bold', weight: 700 }),
  rec({ family: 'Roboto', subfamily: 'Regular', weight: 400 }),
  rec({ family: 'Roboto', subfamily: 'Black', weight: 900 }),
  rec({ family: 'Roboto', subfamily: 'Light', weight: 300 }),
];

/** The full §5.2 order for `want`, by asking repeatedly and removing the
 *  winner — one lucky pick proves nothing about the ORDER. */
function walkOrder(faces: FaceRecord[], want: number): number[] {
  const pool = [...faces];
  const out: number[] = [];
  while (pool.length > 0) {
    const hit = matchFace(pool, 'roboto', { weight: want, italic: false })!;
    out.push(deriveStyle(hit.names).weight);
    pool.splice(pool.indexOf(hit), 1);
  }
  return out;
}

describe('clampWeight', () => {
  it('defaults to 400 and clamps to 1..1000 rather than rejecting', () => {
    // A number in an options bag, not a document we are parsing.
    expect(clampWeight(undefined)).toBe(400);
    expect(clampWeight(700)).toBe(700);
    expect(clampWeight(0)).toBe(1);
    expect(clampWeight(5000)).toBe(1000);
    expect(clampWeight(Number.NaN)).toBe(400);
    expect(clampWeight(612.4)).toBe(612);
  });
});

describe('familyMatches', () => {
  it('matches the typographic family (ID 16) and ID 1 alike', () => {
    const n = rec({ family: 'Foo Semibold', typographicFamily: 'Foo' }).names;
    expect(familyMatches(n, 'foo')).toBe(true);
    expect(familyMatches(n, 'foo semibold')).toBe(true);
    expect(familyMatches(n, 'bar')).toBe(false);
  });
});

describe('matchFace — the CSS Fonts 4 §5.2 weight walk', () => {
  it('walks 400 as: >=want and <=500 asc, then <want desc, then >500 asc', () => {
    expect(walkOrder(ROBOTO, 400)).toEqual([400, 500, 300, 100, 700, 900]);
  });

  it('walks 500 the same way, which leaves only 500 in the first tier', () => {
    expect(walkOrder(ROBOTO, 500)).toEqual([500, 400, 300, 100, 700, 900]);
  });

  it('walks a want below 400 as: <=want desc, then >want asc', () => {
    expect(walkOrder(ROBOTO, 300)).toEqual([300, 100, 400, 500, 700, 900]);
  });

  it('walks a want above 500 as: >=want asc, then <want desc', () => {
    expect(walkOrder(ROBOTO, 600)).toEqual([700, 900, 500, 400, 300, 100]);
    expect(walkOrder(ROBOTO, 900)).toEqual([900, 700, 500, 400, 300, 100]);
  });
});

describe('matchFace — slant', () => {
  it('OUTRANKS weight: an italic request takes Italic over Bold', () => {
    // The surprising half of §5.2, and the rule most likely to be "corrected"
    // by a later reader. A weight-first matcher returns Bold, which is a
    // perfectly plausible face — which is why this is asserted alone.
    const faces = [
      rec({ family: 'Alpha', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Alpha', subfamily: 'Bold', weight: 700 }),
      rec({ family: 'Alpha', subfamily: 'Italic', weight: 400, italic: true }),
    ];
    const hit = matchFace(faces, 'alpha', { weight: 700, italic: true })!;
    expect(hit.names.subfamily).toBe('Italic');
  });

  it('falls back to the wrong slant rather than to nothing', () => {
    const faces = [rec({ family: 'Alpha', subfamily: 'Regular', weight: 400 })];
    expect(matchFace(faces, 'alpha', { weight: 400, italic: true })).toBeDefined();
  });

  it('picks the best weight WITHIN the matching slant', () => {
    const faces = [
      rec({ family: 'Alpha', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Alpha', subfamily: 'Italic', weight: 400, italic: true }),
      rec({ family: 'Alpha', subfamily: 'Bold Italic', weight: 700, italic: true }),
    ];
    const hit = matchFace(faces, 'alpha', { weight: 700, italic: true })!;
    expect(hit.names.subfamily).toBe('Bold Italic');
  });
});

describe('matchFace — ties and misses', () => {
  it('breaks a tie by index order, which is registration then directory order', () => {
    const faces = [
      rec({ family: 'Alpha', weight: 400 }, 'first.ttf'),
      rec({ family: 'Alpha', weight: 400 }, 'second.ttf'),
    ];
    expect(matchFace(faces, 'alpha', { weight: 400, italic: false })!.path).toBe('first.ttf');
  });

  it('returns undefined only when the family is absent', () => {
    expect(matchFace(ROBOTO, 'nonexistent', { weight: 400, italic: false })).toBeUndefined();
  });
});

describe('matchChain', () => {
  it('stops at the first PRESENT family even when a later one has the exact style', () => {
    // The decision at the top of the design: the chain selects a FAMILY, and
    // style matching then runs inside the winner. Arial exists in Regular only,
    // Liberation Sans has a real Bold, and the answer at weight 700 is Arial
    // Regular. This looks like a bug, so it is asserted directly.
    const faces = [
      rec({ family: 'Arial', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Liberation Sans', subfamily: 'Regular', weight: 400 }),
      rec({ family: 'Liberation Sans', subfamily: 'Bold', weight: 700 }),
    ];
    const hit = matchChain(faces, ['Arial', 'Liberation Sans'], { weight: 700, italic: false })!;
    expect(hit.names.family).toBe('Arial');
  });

  it('falls to the next family when the first is absent', () => {
    const faces = [rec({ family: 'Liberation Sans', subfamily: 'Bold', weight: 700 })];
    const hit = matchChain(faces, ['Arial', 'Liberation Sans'], { weight: 700, italic: false })!;
    expect(hit.names.family).toBe('Liberation Sans');
  });

  it('trims, lower-cases and skips empty names', () => {
    const faces = [rec({ family: 'Arial', weight: 400 })];
    expect(matchChain(faces, ['', '  ARIAL '], { weight: 400, italic: false })).toBeDefined();
    expect(matchChain(faces, [], { weight: 400, italic: false })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-match.test.ts`
Expected: FAIL — `clampWeight`, `familyMatches`, `matchFace`, `matchChain`, `weightKey` are not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/fontmatch.ts`:

```ts
/** What a caller asked for, normalised. */
export interface StyleRequest {
  weight: number;
  italic: boolean;
}

/** A requested weight, defaulted and clamped. It is a number in an options bag,
 *  not a document we are parsing, so it is clamped rather than rejected. */
export function clampWeight(w: number | undefined): number {
  if (w === undefined || !Number.isFinite(w)) return 400;
  return Math.min(1000, Math.max(1, Math.round(w)));
}

/** Whether `names` belongs to the family `want`, which must ALREADY be trimmed
 *  and lower-cased. Matched against the typographic family (ID 16) where the
 *  font states one and ID 1 otherwise — unchanged from l1my.1. */
export function familyMatches(names: FontNames, want: string): boolean {
  const typo = (names.typographicFamily ?? names.family).trim().toLowerCase();
  return typo === want || names.family.trim().toLowerCase() === want;
}

/**
 * A lexicographic sort key for `have` against the desired weight `want`, under
 * CSS Fonts 4 §5.2's weight walk. Lower is better; compare tier, then distance.
 *
 *   400 <= want <= 500 : >=want and <=500 asc, then <want desc, then >500 asc
 *   want < 400         : <=want desc, then >want asc
 *   want > 500         : >=want asc, then <want desc
 */
export function weightKey(have: number, want: number): [number, number] {
  if (want >= 400 && want <= 500) {
    if (have >= want && have <= 500) return [0, have - want];
    if (have < want) return [1, want - have];
    return [2, have - 500];
  }
  if (want < 400) return have <= want ? [0, want - have] : [1, have - want];
  return have >= want ? [0, have - want] : [1, want - have];
}

/**
 * The face of family `want` that best answers `req`, or undefined when no face
 * belongs to that family at all.
 *
 * SLANT OUTRANKS WEIGHT (§5.2 applies style before weight), which is the
 * surprising half: asking { weight: 700, italic: true } of a family holding
 * [Regular, Bold, Italic] yields Italic, not Bold. The upright bold face is a
 * worse answer than the italic regular one, because slant is the stronger
 * signal.
 *
 * Once the family exists this ALWAYS returns a face: the slant pass keeps every
 * face when none matches, and the weight walk ranks all of them. Ties fall to
 * index order, which is registration order and then directory order, so a
 * lookup stays reproducible.
 */
export function matchFace(
  faces: readonly FaceRecord[], want: string, req: StyleRequest,
): FaceRecord | undefined {
  const family = faces.filter((f) => familyMatches(f.names, want));
  if (family.length === 0) return undefined;

  const slanted = family.filter((f) => deriveStyle(f.names).italic === req.italic);
  const pool = slanted.length > 0 ? slanted : family;

  let best = pool[0];
  let bestKey = weightKey(deriveStyle(best.names).weight, req.weight);
  for (let i = 1; i < pool.length; i++) {
    const k = weightKey(deriveStyle(pool[i].names).weight, req.weight);
    // Strict <, so an equal rank leaves the earlier face in place.
    if (k[0] < bestKey[0] || (k[0] === bestKey[0] && k[1] < bestKey[1])) {
      best = pool[i];
      bestKey = k;
    }
  }
  return best;
}

/**
 * The first family in `chain` that any face belongs to, resolved to one face.
 *
 * The chain selects a FAMILY; style matching then runs inside the winner. A
 * caller stated a preference order over families and a style detail must not
 * silently override it — so ['Arial', 'Liberation Sans'] at weight 700, with
 * Arial present in Regular only, gives Arial Regular and never consults
 * Liberation Sans. That is CSS's own behaviour and it keeps the two mechanisms
 * independent: one picks the family, the other picks the face.
 */
export function matchChain(
  faces: readonly FaceRecord[], chain: readonly string[], req: StyleRequest,
): FaceRecord | undefined {
  for (const name of chain) {
    const want = name.trim().toLowerCase();
    if (want === '') continue;
    const hit = matchFace(faces, want, req);
    if (hit) return hit;
  }
  return undefined;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/font-match.test.ts`
Expected: PASS, 25 tests.

- [ ] **Step 5: Mutation-check the two rules a plausible-looking build would pass**

1. **Slant-first.** In `matchFace`, replace the slant pass with `const pool = family;` (weight only). Run `npx vitest run test/font-match.test.ts`. Expected: RED on "OUTRANKS weight: an italic request takes Italic over Bold" and on "picks the best weight WITHIN the matching slant". **Restore it.**
2. **Chain-picks-a-family.** In `matchChain`, replace the loop body with one that collects a hit from every name and returns the one whose `deriveStyle` weight is closest to `req.weight`. Run again. Expected: RED on "stops at the first PRESENT family even when a later one has the exact style". **Restore it.**

Record both in the commit body.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/fontmatch.ts test/font-match.test.ts
git commit -F - <<'EOF'
feat(l1my.3): the family filter and the CSS 5.2 matcher

Slant first, then the desired-weight walk, transcribed from CSS Fonts 4
5.2 as a lexicographic (tier, distance) key. The three want-bands are
each asserted as a full ORDER -- by asking repeatedly and removing the
winner -- rather than by one lucky pick.

Slant outranking weight is the surprising half: { weight: 700, italic:
true } over [Regular, Bold, Italic] yields Italic, not Bold. And the
chain selects a FAMILY, with style matching running inside the winner,
so ['Arial','Liberation Sans'] at 700 gives Arial Regular and never
consults Liberation Sans.

Measured load-bearing: dropping the slant pass reddens both slant cases,
and scoring across families instead of stopping at the first present one
reddens the chain case.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Wire the chain and the style request into `LoadFontByName`, and add `ResolveFontByName`

**Files:**
- Modify: `src/fontmatch.ts` (append the two public types)
- Modify: `src/document.ts:1497-1552` (the `LoadFontByName` doc comment and body)
- Modify: `test/font-byname.test.ts` (append only — **do not edit existing cases**)

**Interfaces:**
- Consumes: `matchChain`, `deriveStyle`, `clampWeight`, `StyleRequest` from Task 2; `indexFolder` and `FaceRecord` from `src/fontsource.js` (already imported at `src/document.ts:126`); `AddFontOptions` at `src/document.ts:150`; `this.fontFolders` at `src/document.ts:313`; `this.fontsByPath` at `src/document.ts:317`.
- Produces:
  - `export interface LoadFontOptions extends AddFontOptions { weight?: number; italic?: boolean }` — declared in `fontmatch.ts`, which imports `AddFontOptions` **as a type** from `./document.js`.
  - `export interface FontMatch { family: string; subfamily: string; weight: number; italic: boolean; exact: boolean; path: string; faceIndex: number }`
  - `Document.LoadFontByName(family: string | string[], opts?: LoadFontOptions): EmbeddedFont | undefined`
  - `Document.ResolveFontByName(family: string | string[], opts?: LoadFontOptions): FontMatch | undefined`

- [ ] **Step 1: Write the failing test**

Append to `test/font-byname.test.ts`. It already imports `Document`, `buildNamedFont` and defines `folderWith` — reuse them; add nothing to the existing cases.

```ts
describe('Document.LoadFontByName — style matching', () => {
  /** One family in four faces, as a real family ships. */
  function familyFolder(): string {
    return folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'b.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', weight: 700, bold: true }),
      'i.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Italic', weight: 400, italic: true }),
      'bi.ttf': buildNamedFont({
        family: 'Alpha Sans', subfamily: 'Bold Italic', weight: 700, bold: true, italic: true,
      }),
    });
  }

  it('resolves a weight and a slant to the face that carries them', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    expect(doc.ResolveFontByName('Alpha Sans', { weight: 700 })!.subfamily).toBe('Bold');
    expect(doc.ResolveFontByName('Alpha Sans', { italic: true })!.subfamily).toBe('Italic');
    expect(doc.ResolveFontByName('Alpha Sans', { weight: 700, italic: true })!.subfamily)
      .toBe('Bold Italic');
    expect(doc.ResolveFontByName('Alpha Sans')!.subfamily).toBe('Regular');
  });

  it('reports exact: false and NAMES the face it substituted', () => {
    // The whole reason ResolveFontByName exists: EmbeddedFont.sfnt is @internal,
    // so a caller who asked for bold and got upright otherwise cannot find out.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const m = doc.ResolveFontByName('Alpha Sans', { weight: 700 })!;
    expect(m.exact).toBe(false);
    expect(m.subfamily).toBe('Regular');
    expect(m.weight).toBe(400);
    expect(doc.ResolveFontByName('Alpha Sans')!.exact).toBe(true);
  });

  it('returns undefined from Resolve when no family in the chain is present', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    expect(doc.ResolveFontByName(['Nonexistent Grotesk'])).toBeUndefined();
    expect(doc.ResolveFontByName([])).toBeUndefined();
  });

  it('takes the first PRESENT family of a chain, not the best style in it', () => {
    const dir = folderWith({
      'a.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'lb.ttf': buildNamedFont({ family: 'Beta Sans', subfamily: 'Bold', weight: 700, bold: true }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const m = doc.ResolveFontByName(['Alpha Sans', 'Beta Sans'], { weight: 700 })!;
    expect(m.family).toBe('Alpha Sans');
    expect(doc.ResolveFontByName(['Missing Sans', 'Beta Sans'], { weight: 700 })!.family)
      .toBe('Beta Sans');
  });

  it('loads the resolved face, and Load and Resolve agree about which it is', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    const m = doc.ResolveFontByName('Alpha Sans', { weight: 700, italic: true })!;
    const font = doc.LoadFontByName('Alpha Sans', { weight: 700, italic: true })!;
    expect(font).toBeDefined();
    // PostScript name is buildNamedFont's family with spaces stripped, so the
    // handle is checked against the file the resolver named instead.
    expect(doc.LoadFontByName(['Alpha Sans'], { weight: 700, italic: true })).toBe(font);
    expect(m.path.endsWith('bi.ttf')).toBe(true);
  });

  it('gives different styles of one family DIFFERENT handles', () => {
    const doc = Document.New();
    doc.RegisterFontFolder(familyFolder());
    const regular = doc.LoadFontByName('Alpha Sans')!;
    const bold = doc.LoadFontByName('Alpha Sans', { weight: 700 })!;
    expect(regular).not.toBe(bold);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-byname.test.ts`
Expected: FAIL — `doc.ResolveFontByName is not a function`.

- [ ] **Step 3: Add the two public types to `src/fontmatch.ts`**

Append:

```ts
import type { AddFontOptions } from './document.js';

/** A style request alongside the ordinary font options. */
export interface LoadFontOptions extends AddFontOptions {
  /** CSS weight, 1..1000. Default 400. Clamped, never rejected. */
  weight?: number;
  /** Prefer an italic or oblique face. Default false. */
  italic?: boolean;
}

/** What a name resolves to — reported without loading or embedding anything. */
export interface FontMatch {
  /** The family as the FONT states it (ID 16 where present), not as asked for. */
  family: string;
  /** The subfamily as the font states it (ID 17 where present). */
  subfamily: string;
  /** DERIVED weight and slant, not the raw usWeightClass or macStyle bits. */
  weight: number;
  italic: boolean;
  /** Whether weight AND slant both matched the request exactly. False means a
   *  face was substituted — the only way a caller can learn that, since
   *  `EmbeddedFont.sfnt` is internal. */
  exact: boolean;
  path: string;
  faceIndex: number;
}
```

- [ ] **Step 4: Replace `LoadFontByName` in `src/document.ts`**

Add to the import at `src/document.ts:126`-ish a new line:

```ts
import {
  matchChain, deriveStyle, clampWeight,
  type LoadFontOptions, type FontMatch,
} from './fontmatch.js';
```

Replace the whole doc comment and body at `src/document.ts:1497-1552` with:

```ts
  /**
   * What `family` resolves to, without loading or embedding anything.
   *
   * `family` may be one name or a preference chain. The chain selects a
   * FAMILY — the first name any indexed face belongs to wins outright, and
   * style matching then runs inside it — so a style detail never overrides the
   * order the caller stated. Matching is trimmed and case-insensitive, against
   * the typographic family (name ID 16) where the font states one and ID 1
   * otherwise.
   *
   * Within that family the rule is CSS Fonts 4 §5.2: slant first, then the
   * desired-weight walk. Slant outranking weight is the surprising half —
   * `{ weight: 700, italic: true }` over a family holding Regular, Bold and
   * Italic yields the Italic face, not the Bold one.
   *
   * `undefined` only when no family in the chain is present. Once one is, a
   * face always comes back, possibly a substituted one — which is what
   * {@link FontMatch.exact} reports, and the only way to learn it.
   */
  ResolveFontByName(
    family: string | string[], opts: LoadFontOptions = {},
  ): FontMatch | undefined {
    const chain = typeof family === 'string' ? [family] : family;
    const req = { weight: clampWeight(opts.weight), italic: opts.italic ?? false };

    const faces: FaceRecord[] = [];
    for (const dir of this.fontFolders) faces.push(...indexFolder(dir));

    const hit = matchChain(faces, chain, req);
    if (!hit) return undefined;

    const style = deriveStyle(hit.names);
    return {
      family: hit.names.typographicFamily ?? hit.names.family,
      subfamily: hit.names.typographicSubfamily ?? hit.names.subfamily,
      weight: style.weight,
      italic: style.italic,
      exact: style.weight === req.weight && style.italic === req.italic,
      path: hit.path,
      faceIndex: hit.faceIndex,
    };
  }

  /**
   * The face matching `family`, registered and ready to draw with.
   *
   * Selection is {@link ResolveFontByName}'s, so the two cannot disagree about
   * what a name means: a family chain, then CSS Fonts 4 §5.2 slant-then-weight
   * matching inside the winning family.
   *
   * Returns `undefined` when no registered folder holds any family in the
   * chain: a machine without a given face is an ordinary outcome, not an
   * unsupported feature, and substituting a Standard-14 face silently would
   * render the document in something the caller never chose. Never throws — an
   * unreadable file, a malformed font and a folder that does not exist are all
   * skipped.
   *
   * Degradation WITHIN a family is silent by design: ask for bold where only
   * upright exists and an upright face comes back. Call
   * {@link ResolveFontByName} to see which face that was.
   *
   * Requesting one face twice returns the SAME handle, so the font is embedded
   * once however many times it is drawn with.
   */
  LoadFontByName(
    family: string | string[], opts: LoadFontOptions = {},
  ): EmbeddedFont | undefined {
    const hit = this.ResolveFontByName(family, opts);
    if (!hit) return undefined;

    // Keyed by path AND face: the faces of a collection share one path, so a
    // path-only key hands back face 0's font for every face of the file and
    // every glyph is then drawn from the wrong one, silently.
    const key = `${hit.path}#${hit.faceIndex}`;
    const already = this.fontsByPath.get(key);
    if (already) return already;

    let font: EmbeddedFont;
    try {
      // AddFontOptions is passed field by field rather than spread: `opts` also
      // carries weight and italic, which are selection inputs and mean nothing
      // to AddFont.
      font = this.AddFont(new Uint8Array(readFileSync(hit.path)),
        { shape: opts.shape, faceIndex: hit.faceIndex });
    } catch {
      return undefined;   // readable enough to index, not enough to parse
    }
    this.fontsByPath.set(key, font);
    return font;
  }
```

- [ ] **Step 5: Run the new tests AND the regression fence**

Run: `npx vitest run test/font-byname.test.ts`
Expected: PASS — the six new cases **and every pre-existing case, unedited**.

If "prefers the regular face over bold and italic siblings" or "searches registered folders in registration order" goes red, the general rule got the `l1my.1` special case wrong. Resolving at `{ weight: 400, italic: false }` must reproduce the old tie-break: the slant pass keeps the upright faces, the weight walk starts at 400, ties fall to index order. Fix `fontmatch.ts`, never the fixture.

- [ ] **Step 6: Mutation-check that the old tie-break is genuinely subsumed**

In `matchFace`, change the tie-break comparison from strict `<` to `<=`. Run `npx vitest run test/font-byname.test.ts`. Expected: RED on the pre-existing "searches registered folders in registration order". **Restore it.** This proves the fence is doing its job rather than passing by luck.

- [ ] **Step 7: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/fontmatch.ts src/document.ts test/font-byname.test.ts
git commit -F - <<'EOF'
feat(l1my.3): a family chain and a style request on LoadFontByName

LoadFontByName takes a name or a preference chain plus { weight, italic }
and is now ResolveFontByName plus a read plus AddFont, so the two cannot
disagree about which face a name means. ResolveFontByName reports the
chosen family, subfamily, derived weight and slant, path and face index,
and whether the request was met exactly -- the only way a caller can
learn a face was substituted, EmbeddedFont.sfnt being internal.

l1my.1's prefer-a-plain-face tie-break is subsumed rather than replaced:
it is what resolving at weight 400 upright already does. Every existing
case in test/font-byname.test.ts stays green UNEDITED, and loosening the
tie-break comparison to <= reddens the registration-order case, so the
fence is passing on purpose rather than by luck.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `LoadFontFamily` and the public exports

**Files:**
- Modify: `src/fontmatch.ts` (append `FontFamily`)
- Modify: `src/document.ts` (append `LoadFontFamily` after `LoadFontByName`)
- Modify: `src/index.ts:8-12` (the `./document.js` type export block)
- Modify: `test/font-byname.test.ts` (append)

**Interfaces:**
- Consumes: `LoadFontByName` and `ResolveFontByName` from Task 3; `EmbeddedFont` from `src/embeddedfont.js`; `AddFontOptions` at `src/document.ts:150`.
- Produces:
  - `export interface FontFamily { regular: EmbeddedFont; bold?: EmbeddedFont; italic?: EmbeddedFont; boldItalic?: EmbeddedFont }` in `fontmatch.ts`. Structurally assignable to `MarkdownFontFamily` (`src/mdstyle.ts:14`), whose `regular` is `AuthoringFont = StdFont | EmbeddedFont`.
  - `Document.LoadFontFamily(family: string | string[], opts?: AddFontOptions): FontFamily | undefined`
  - `LoadFontOptions`, `FontMatch`, `FontFamily` re-exported from `src/index.ts`.

- [ ] **Step 1: Write the failing test**

Append to `test/font-byname.test.ts`:

```ts
describe('Document.LoadFontFamily', () => {
  it('fills all four slots from a four-face family', () => {
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'b.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', weight: 700, bold: true }),
      'i.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Italic', weight: 400, italic: true }),
      'bi.ttf': buildNamedFont({
        family: 'Alpha Sans', subfamily: 'Bold Italic', weight: 700, bold: true, italic: true,
      }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = doc.LoadFontFamily('Alpha Sans')!;
    expect(fam).toBeDefined();
    const handles = new Set([fam.regular, fam.bold, fam.italic, fam.boldItalic]);
    expect(handles.size).toBe(4);       // four files, four distinct handles
  });

  it('leaves a slot UNDEFINED rather than filling it with the regular face', () => {
    // The point of the method. Filling `bold` with whatever the matcher
    // returned would put the regular face in all four slots for a one-weight
    // family: four faces that are one face, dressed as a family. Undefined
    // routes through mdstyle.ts's own documented fallback instead — and both
    // render identically, so only an assertion on the SLOT can see this.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Solo Sans', subfamily: 'Regular', weight: 400 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = doc.LoadFontFamily('Solo Sans')!;
    expect(fam.regular).toBeDefined();
    expect(fam.bold).toBeUndefined();
    expect(fam.italic).toBeUndefined();
    expect(fam.boldItalic).toBeUndefined();
  });

  it('fills the bold slot from a Semibold, which exact matching would refuse', () => {
    // A bucket, not the equality FontMatch.exact uses: a family shipping
    // Semibold and no 700 has a bold face — it is the only heavier face there
    // is — while ResolveFontByName at 700 still reports exact: false.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Semi Sans', subfamily: 'Regular', weight: 400 }),
      's.ttf': buildNamedFont({ family: 'Semi Sans', subfamily: 'SemiBold', weight: 600 }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    const fam = doc.LoadFontFamily('Semi Sans')!;
    expect(fam.bold).toBeDefined();
    expect(fam.bold).not.toBe(fam.regular);
    expect(doc.ResolveFontByName('Semi Sans', { weight: 700 })!.exact).toBe(false);
  });

  it('returns undefined when no family in the chain is present', () => {
    const doc = Document.New();
    expect(doc.LoadFontFamily('Nonexistent Grotesk')).toBeUndefined();
  });

  it('drops straight into AddMarkdown as a font family', () => {
    // Pins the structural compatibility with MarkdownFontFamily, which is a
    // COMPILE-time claim the type system would otherwise be the only witness to.
    const dir = folderWith({
      'r.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Regular', weight: 400 }),
      'b.ttf': buildNamedFont({ family: 'Alpha Sans', subfamily: 'Bold', weight: 700, bold: true }),
    });
    const doc = Document.New();
    doc.RegisterFontFolder(dir);
    doc.AddPage(PageFormat.A4);
    const fam = doc.LoadFontFamily('Alpha Sans')!;
    // Note the nesting: the face goes under `style`, per MarkdownFlowOptions —
    // `{ font }` at the top level is a type error, not a runtime one.
    expect(() => doc.AddMarkdown('Plain and **bold**.', { style: { font: fam } })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/font-byname.test.ts -t "LoadFontFamily"`
Expected: FAIL — `doc.LoadFontFamily is not a function`.

- [ ] **Step 3: Add `FontFamily` to `src/fontmatch.ts`**

Append (the `EmbeddedFont` import is type-only, so it adds no runtime edge):

```ts
import type { EmbeddedFont } from './embeddedfont.js';

/**
 * The four faces emphasis selects between, loaded from disk.
 *
 * Structurally assignable to `MarkdownFontFamily` (mdstyle.ts), so it drops
 * straight into `AddMarkdown({ font })` — declared here rather than imported
 * from there, because a general font API must not depend on the Markdown
 * vocabulary. An absent slot is deliberate: see `Document.LoadFontFamily`.
 */
export interface FontFamily {
  regular: EmbeddedFont;
  bold?: EmbeddedFont;
  italic?: EmbeddedFont;
  boldItalic?: EmbeddedFont;
}
```

- [ ] **Step 4: Add `LoadFontFamily` to `src/document.ts`**

Extend the `./fontmatch.js` import with `type FontFamily`, then append immediately after `LoadFontByName`:

```ts
  /**
   * The four faces of `family`, ready to hand to `AddMarkdown({ font })`.
   *
   * `regular` is the weight-400 upright resolution and always exists once any
   * family in the chain does. The other three are filled ONLY when the chosen
   * face actually plays that role — weight ≥ 600 for the two bold slots, slant
   * matching for the two italic ones — and left `undefined` otherwise.
   *
   * That is the point of the method. Filling `bold` with whatever the matcher
   * returned would put the regular face in all four slots for a family shipping
   * one weight: four faces that are one face, dressed as a family. An absent
   * slot routes through the documented "an unstated face falls back to
   * `regular`" rule instead, producing the identical rendering by a route a
   * reader can follow.
   *
   * The bold test is a BUCKET, not the equality {@link FontMatch.exact} uses,
   * and the difference is deliberate: a family shipping Semibold and no 700 has
   * a bold face — it is the only heavier face there is — while resolving it at
   * 700 still reports `exact: false`. One question is "which face plays this
   * role", the other is "did I get what I asked for".
   *
   * Handles come through the same memo {@link LoadFontByName} uses, so two
   * slots resolving to one file share one handle and nothing is embedded twice.
   */
  LoadFontFamily(
    family: string | string[], opts: AddFontOptions = {},
  ): FontFamily | undefined {
    const regular = this.LoadFontByName(family, { ...opts, weight: 400, italic: false });
    if (!regular) return undefined;

    /** The face for a slot, or undefined when nothing plays that role. */
    const slot = (weight: number, italic: boolean): EmbeddedFont | undefined => {
      const hit = this.ResolveFontByName(family, { weight, italic });
      if (!hit) return undefined;
      if (hit.italic !== italic || (hit.weight >= 600) !== (weight >= 600)) return undefined;
      return this.LoadFontByName(family, { ...opts, weight, italic });
    };

    const out: FontFamily = { regular };
    const bold = slot(700, false);
    if (bold) out.bold = bold;
    const italic = slot(400, true);
    if (italic) out.italic = italic;
    const boldItalic = slot(700, true);
    if (boldItalic) out.boldItalic = boldItalic;
    return out;
  }
```

- [ ] **Step 5: Export the three types from `src/index.ts`**

After the existing `./document.js` type block at `src/index.ts:9-12`, add:

```ts
export type { LoadFontOptions, FontMatch, FontFamily } from './fontmatch.js';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/font-byname.test.ts`
Expected: PASS — all cases, existing and new.

- [ ] **Step 7: Mutation-check the empty-slot rule**

In `LoadFontFamily`'s `slot`, delete the role check (`if (hit.italic !== italic || ...) return undefined;`). Run `npx vitest run test/font-byname.test.ts -t "LoadFontFamily"`. Expected: RED on "leaves a slot UNDEFINED rather than filling it with the regular face" — **and green on everything else**, including the AddMarkdown case, because filling the slot with the regular face renders identically. That asymmetry is the whole reason the assertion is written against the slot. **Restore it.**

- [ ] **Step 8: Typecheck, run the whole suite, and commit**

```bash
npm run typecheck
npm test
git add src/fontmatch.ts src/document.ts src/index.ts test/font-byname.test.ts
git commit -F - <<'EOF'
feat(l1my.3): LoadFontFamily returns the four faces emphasis needs

doc.AddMarkdown(src, { font: doc.LoadFontFamily('Roboto') }) now gets
real bold and italic off the disk, where an embedded face previously
derived nothing and emphasis showed no change at all.

A slot is filled only when the chosen face actually plays that role, and
left undefined otherwise -- filling it with the regular face would give a
one-weight family four faces that are one face, dressed as a family. The
bold test is a bucket rather than FontMatch.exact's equality, so a family
shipping Semibold and no 700 still has a bold face while resolving it at
700 correctly reports exact: false.

Measured: deleting the role check reddens only the empty-slot assertion
and leaves the AddMarkdown case green, since both builds render the same
-- which is why that case is asserted against the slot itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Documentation

**Files:**
- Modify: `CHANGELOG.md` (insert an `### Added` block under `## [Unreleased]`, before the existing `### Fixed` at line 19)
- Modify: `README.md:373-397` (the font-by-name prose) and `README.md:2197-2199` (the API table)
- Modify: `CLAUDE.md` (the `fontnames.ts`/`fontsource.ts` bullet)

**Interfaces:**
- Consumes: everything from Tasks 1-4. Produces no code.

- [ ] **Step 1: Add the CHANGELOG entry**

Insert directly after `## [Unreleased]` in `CHANGELOG.md`, before the existing `### Fixed`:

```markdown
### Added

- **A font can be asked for by weight and slant, with a family fallback chain** — `LoadFontByName` took a family name and nothing else, so a caller who wanted Roboto Bold had to know which file held it; the rule where a family had several faces was a tie-break that preferred a plain one, which is a sensible default and no way to ask for anything else. It now takes `{ weight, italic }` and resolves them by the published CSS Fonts 4 §5.2 rule — slant first, then the desired-weight walk — so a folder of nine Roboto weights is nine reachable faces rather than one. Citing §5.2 rather than inventing a rule matters here: the ordering it specifies is not the obvious one, and slant outranks weight, so asking for bold italic of a family holding Regular, Bold and Italic gives **Italic**, not Bold. `family` also accepts a list, which is a preference chain over **families**: the first name any indexed face belongs to wins outright and style matching then runs inside it, so `['Arial', 'Liberation Sans']` at weight 700 returns Arial Regular on a machine whose Arial ships upright only, and never consults Liberation Sans. A style detail must not silently override the order a caller stated. Degradation inside a family is silent, as it has to be — but `EmbeddedFont` exposes nothing about the face it holds, so **`ResolveFontByName`** is new beside it: the same selection, reporting the family, subfamily, derived weight and slant, path and face index it *would* load, plus whether the request was met exactly, without loading or embedding anything. Nothing new is read from disk for any of this — the folder index already recorded every field, so `l1my.1`'s partial-read cost model is untouched. (`l1my.3`)

- **`LoadFontFamily` gives Markdown real emphasis from a system font** — `AddMarkdown` selects emphasis from a four-face family, and an embedded face derived nothing: bold and italic fell back to the regular face, so `**bold**` rendered identically to its surroundings and the document said something it did not mean. `doc.LoadFontFamily('Roboto')` returns the four faces in the shape `AddMarkdown({ font })` already takes. A slot is filled only when the chosen face actually plays that role and left absent otherwise, which is deliberate rather than incomplete: filling it with the regular face would give a one-weight family four faces that are one face, where an absent slot routes through the documented fallback and renders the same by a route a reader can follow. The bold slot is a bucket rather than an exact test, so a family shipping Semibold and no 700 has a bold face — it is the only heavier face there is — while resolving that family at 700 still reports `exact: false`, because the caller asked for 700 and did not get it. (`l1my.3`)
```

- [ ] **Step 2: Update the README prose**

Replace the paragraph at `README.md:383-397` beginning "Two things are deliberate." — keep its first two sentences about opt-in system directories and the `undefined` return verbatim, then replace the matching sentences ("Matching is exact on the family name, case-insensitive; where a family has several faces, the one that is neither bold nor italic is preferred.") with:

```markdown
A family can be asked for by **weight and slant**, and `family` accepts a list:

```ts
const bold = doc.LoadFontByName(['Roboto', 'Liberation Sans'], { weight: 700 });
const family = doc.LoadFontFamily('Roboto');     // { regular, bold?, italic?, boldItalic? }
doc.AddMarkdown('Plain and **bold**.', { style: { font: family } });
```

Selection follows [CSS Fonts 4 §5.2](https://www.w3.org/TR/css-fonts-4/#font-style-matching):
**slant first, then the desired-weight walk.** Two consequences are worth
stating because neither is the obvious one. Slant outranks weight, so asking a
family holding *Regular, Bold, Italic* for `{ weight: 700, italic: true }`
returns the **Italic** face rather than the Bold one. And a list is a preference
chain over **families**, not a search for the best face: the first name any
installed face belongs to wins outright and matching runs inside it, so
`['Arial', 'Liberation Sans']` at weight 700 gives Arial Regular on a machine
whose Arial ships upright only. A style detail never overrides the order you
stated.

Degradation inside a family is silent — ask for bold where only upright exists
and an upright face comes back. `doc.ResolveFontByName(family, opts)` reports
what *would* be loaded, without loading it: the family and subfamily as the font
states them, the derived weight and slant, the path and face index, and an
`exact` flag saying whether your request was met. It is the only way to find
out, since the `EmbeddedFont` handle exposes nothing about the face it holds.
```

Then add to the API table after `README.md:2199`:

```markdown
| `doc.ResolveFontByName(family, opts?)` | What a name would resolve to — family, subfamily, derived weight/slant, path, and whether the style matched exactly — without loading it |
| `doc.LoadFontFamily(family, opts?)` | The four faces emphasis selects between, ready for `AddMarkdown({ font })`; a slot is absent when no face plays that role |
```

- [ ] **Step 3: Update `CLAUDE.md`**

Append to the `fontnames.ts`, `fontsource.ts` bullet, after the existing prefer-a-plain-face note (replacing the "**Note:** the prefer-a-plain-face rule is a TIE-BREAK…" paragraph, whose forward reference to `l1my.3` is now spent):

```markdown
- **fontmatch.ts** — choosing WHICH face of a family, a pure leaf over
  `FaceRecord[]`: no `node:fs`, no `Document`, no font file, which is what lets
  every branch of the weight walk be asserted from hand-written naming fields.
  **Invariant:** the matching rule is CSS Fonts 4 §5.2, **cited rather than
  invented** — slant first, then the desired-weight walk. This repo anchors its
  trickier arithmetic outside itself (32000-1, T.88's SLTP constants, UAX #9/#14,
  Adobe TN #5014), and a hand-rolled weight rule would be one more thing only
  our own tests agree with.
  **Invariant:** **slant OUTRANKS weight**, which is the surprising half.
  `{ weight: 700, italic: true }` over a family holding *[Regular, Bold,
  Italic]* yields **Italic**, not Bold — the upright bold face is a worse answer
  than the italic regular one. A weight-first matcher returns a perfectly
  plausible face, so this is asserted alone in `test/font-match.test.ts` and
  named for what it protects.
  **Invariant:** a family CHAIN selects a **family**, and style matching then
  runs inside the winner. `['Arial', 'Liberation Sans']` at weight 700 with
  Arial present in Regular only gives Arial Regular and never consults
  Liberation Sans. The caller stated a preference order over families; scoring
  family position against style distance instead makes the answer depend on a
  weighting nobody can predict from the docs, and lets installing a font
  silently displace an earlier choice.
  **Invariant:** `l1my.1`'s prefer-a-plain-face rule is **subsumed, not
  replaced** — it is exactly what resolving at `{ weight: 400, italic: false }`
  does. `test/font-byname.test.ts`'s pre-existing cases are the fence for that
  claim and are expected to stay green unedited; a red one there means the
  general rule got the special case wrong, not that the fixture is stale.
  **Invariant:** every style signal is POSITIVE evidence and they are OR-ed, the
  rule `fontStyleOf` already sets in font.ts. The weight corroboration fires
  ONLY at 400, because 400 is what an absent `OS/2`, a stated 0 and a genuine
  Regular all produce alike — the one value that may mean "said nothing" — and a
  mis-stated Bold left there costs twice, being unreachable at 700 AND a rival
  for the face returned at 400. At any other value the font made a numeric
  statement and the subfamily name is a second opinion nobody asked for.
  **Invariant:** `LoadFontFamily` fills a slot only when the chosen face plays
  that role, and leaves it absent otherwise — filling it with the regular face
  gives a one-weight family four faces that are one face. **Measured:** both
  builds render identically, so only an assertion on the SLOT can see it; the
  `AddMarkdown` case stays green either way.
  **Note:** the bold slot is a BUCKET (`weight ≥ 600`), not `FontMatch.exact`'s
  equality, and the two differ on purpose. A family shipping Semibold and no 700
  has a bold face — it is the only heavier face there is — while resolving it at
  700 reports `exact: false`, because the caller asked for 700 and did not get
  it. "Which face plays this role" and "did I get what I asked for" are
  different questions.
  **Note:** a face whose weight lives in ID 1 with no typographic pair
  (`Arial Narrow`) is its own family under the ID 16-else-ID 1 rule and is not
  reachable as a style of the base name. Documented as a limit rather than
  fixed: decomposing a family name would be exactly the string-parsing the
  derivation rule refuses to do on subfamilies, and it would make
  `LoadFontByName('Arial')` start matching files it does not match today.
```

- [ ] **Step 4: Verify the whole suite and the build**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. A docs-only task must not move a test.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md CLAUDE.md
git commit -F - <<'EOF'
docs(l1my.3): style matching in CHANGELOG, README and CLAUDE.md

Records the three things a caller otherwise discovers by surprise: the
CSS Fonts 4 5.2 citation, slant outranking weight, and a family chain
selecting a FAMILY rather than searching for the best face.

CLAUDE.md gains a fontmatch.ts entry and retires the forward reference in
the fontsource.ts tie-break note, which l1my.3 has now spent -- the rule
is subsumed by resolving at weight 400 upright rather than living on
beside the general one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Close out the session

- [ ] **Step 1: Verify everything is green**

```bash
npm run typecheck && npm test && npm run build
```

- [ ] **Step 2: File follow-ups for anything discovered**

```bash
bd create "<title>" -t task -p 3 --parent aspose-pdf-foss-for-ts-l1my -d "<what and why>"
```

Note `l1my.4` (font folder scan misses an unusual or absent extension) already exists and is **not** part of this work.

- [ ] **Step 3: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-l1my.3 --reason "<one paragraph: what shipped, the three invariants, what was measured>"
bd show aspose-pdf-foss-for-ts-l1my
```

Expected: the epic reads 3/4 complete, with only `l1my.4` open.

- [ ] **Step 4: Push — work is NOT complete until this succeeds**

```bash
git pull --rebase
git push
git status          # MUST show "up to date with origin"
```

---

## Self-review notes

**Spec coverage.** Every section of the design maps to a task: the module layout and derivation to Task 1; the §5.2 matching rule and the chain to Task 2; the `LoadFontByName`/`ResolveFontByName` API and the "tie-break is subsumed" claim to Task 3; `LoadFontFamily` and its bucket-vs-equality rule to Task 4; the documentation section to Task 5. The spec's degradation section is covered by Task 2's `clampWeight` cases and Task 3's `undefined` cases. The four out-of-scope items produce no task by design; the last of them (the `Arial Narrow` limit) is recorded in `CLAUDE.md` in Task 5 so it is written down somewhere in the tree.

**Naming correction carried.** The spec's `FontFamilySpec` does not exist; the real type is `MarkdownFontFamily` (`src/mdstyle.ts:14`) and this plan declares its own structurally-compatible `FontFamily`. Task 4 Step 6's `AddMarkdown` case is what pins that compatibility at runtime rather than leaving the type system as its only witness.

**Type consistency.** `deriveStyle` returns `FaceStyle` and is used under that name in Tasks 2-4. `StyleRequest` is `{ weight, italic }` throughout, always built from `clampWeight(opts.weight)` and `opts.italic ?? false`. `FontMatch.weight`/`.italic` are the derived values, matching what `deriveStyle` produced. `matchFace` takes an already-lower-cased `want`; only `matchChain` and `familyMatches`' callers lower-case, and `matchChain` is the only caller of `matchFace` outside the tests.
