# ConvertToGrayscale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `Document.ConvertToGrayscale()` — convert a document's colour to DeviceGray across page content, form XObjects, tiling patterns, Type 3 glyph procedures, image XObjects, shadings and annotations.

**Architecture:** Operator-level neutralization. Every colour-*setting* operator becomes `g`/`G` carrying the Rec. 601 luma of the colour it set; `cs`/`CS` becomes `/DeviceGray`; named `/ColorSpace` resources are left unreferenced rather than retargeted. Two order-independent phases — an object-level pass over images, shadings and functions keyed by object number, and a content-level pass over every content stream, also keyed by object number.

**Tech Stack:** TypeScript (strict, ESM + NodeNext, `.js` import specifiers), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-20-grayscale-conversion-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:zlib`, `node:crypto`, `node:fs`. Do not add npm runtime deps.
- **ESM + NodeNext.** Every import specifier carries `.js`: `import { luma } from './grayscale.js'`.
- **Luma is Rec. 601 on the encoded values:** `0.299 R + 0.587 G + 0.114 B`. One owner, `grayscale.ts`. No other module may write those constants.
- **Numbers are rounded to 4 decimals** before entering a content stream, via `grayNum` — `pdfxcolor.ts`'s existing rule.
- **Purity:** `grayscale.ts`, `grayops.ts`, `grayimage.ts` and `grayshading.ts` must NOT import `document.js` or `page.js`. `grayimage.ts` and `grayshading.ts` take `resolve`/`inflate` as arguments (the `glyphprogram.ts` pattern). `grayconvert.ts` is the only module here that touches a `Document`.
- **Errors:** throw only `UnsupportedFeatureError` (signed document). Nothing else throws; damage is reported in `skipped`.
- **Two lists, and the difference is load-bearing:** `images` = converted, `skipped` = could not be. An object with *no colour to convert* (an `/ImageMask`, an already-DeviceGray image) goes in **neither**.
- **Run `npm run typecheck` and `npm test` before closing.** Both must be green.
- Target a single file with `npx vitest run test/<name>.test.ts`.

---

### Task 1: `grayscale.ts` — the greying rule

**Files:**
- Create: `src/grayscale.ts`
- Test: `test/grayscale-core.test.ts`

**Interfaces:**
- Consumes: `resolveColorSpace`, `ColorConverter` from `src/colorspace.ts`.
- Produces:
  - `luma(r: number, g: number, b: number): number` — 0..1 in, 0..1 out, clamped.
  - `type GraySpace = { kind: 'gray' } | { kind: 'rgb' } | { kind: 'cmyk' } | { kind: 'pattern'; base?: GraySpace; resourceName?: string } | { kind: 'other'; converter: ColorConverter }`
  - `componentsOf(space: GraySpace): number`
  - `grayOf(comps: readonly number[], space: GraySpace): number`
  - `grayNum(v: number): number`

- [ ] **Step 1: Write the failing test**

Create `test/grayscale-core.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { luma, grayOf, grayNum, componentsOf, type GraySpace } from '../src/grayscale.js';
import type { ColorConverter } from '../src/colorspace.js';

const GRAY: GraySpace = { kind: 'gray' };
const RGB: GraySpace = { kind: 'rgb' };
const CMYK: GraySpace = { kind: 'cmyk' };

describe('luma', () => {
  it('is Rec. 601 on the primaries', () => {
    expect(luma(1, 0, 0)).toBeCloseTo(0.299, 10);
    expect(luma(0, 1, 0)).toBeCloseTo(0.587, 10);
    expect(luma(0, 0, 1)).toBeCloseTo(0.114, 10);
  });

  it('maps black to 0 and white to 1', () => {
    expect(luma(0, 0, 0)).toBe(0);
    expect(luma(1, 1, 1)).toBe(1);
  });

  it('clamps out-of-range input rather than emitting an invalid operand', () => {
    expect(luma(2, 2, 2)).toBe(1);
    expect(luma(-1, -1, -1)).toBe(0);
  });
});

describe('grayOf', () => {
  it('passes DeviceGray through unchanged', () => {
    expect(grayOf([0.5], GRAY)).toBe(0.5);
  });

  // The three weights sum to 0.9999999999999999 in IEEE754, so a neutral RGB
  // grey comes back 1 ulp low. grayNum's 4-decimal rounding is what makes an
  // already-neutral colour survive conversion byte-identically -- measured,
  // not assumed: without the rounding this asserts 0.49999999999999994.
  it('rounds a neutral RGB grey back to itself', () => {
    expect(grayNum(grayOf([0.5, 0.5, 0.5], RGB))).toBe(0.5);
  });

  it('converts CMYK through its RGB equivalent', () => {
    // Pure cyan -> rgb(0,1,1) -> 0.587 + 0.114.
    expect(grayOf([1, 0, 0, 0], CMYK)).toBeCloseTo(0.701, 10);
    // Any colour at K=1 is black.
    expect(grayOf([0.3, 0.4, 0.5, 1], CMYK)).toBe(0);
  });

  it('routes a non-device space through its ColorConverter', () => {
    const converter: ColorConverter = {
      components: 1,
      toRgb: () => [255, 0, 0],   // 0..255, as colorspace.ts emits
      initial: () => [0, 0, 0],
    };
    expect(grayOf([0.7], { kind: 'other', converter })).toBeCloseTo(0.299, 10);
  });

  it('reads a pattern space through its base', () => {
    expect(grayOf([1, 0, 0], { kind: 'pattern', base: RGB })).toBeCloseTo(0.299, 10);
  });

  it('treats missing components as zero rather than NaN', () => {
    expect(grayOf([], RGB)).toBe(0);
  });
});

describe('componentsOf', () => {
  it('reports the operand count each space takes', () => {
    expect(componentsOf(GRAY)).toBe(1);
    expect(componentsOf(RGB)).toBe(3);
    expect(componentsOf(CMYK)).toBe(4);
    expect(componentsOf({ kind: 'pattern' })).toBe(0);
    expect(componentsOf({ kind: 'pattern', base: RGB })).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayscale-core.test.ts`
Expected: FAIL — `Failed to resolve import "../src/grayscale.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/grayscale.ts`:

```ts
import type { ColorConverter } from './colorspace.js';

/**
 * The greying rule, and its only owner.
 *
 * Rec. 601 luma on the *encoded* values -- what JPEG's own Y channel is, and
 * what Ghostscript and the rest of the PDF tooling emit, so a document
 * converted here matches the same document converted elsewhere. It is also
 * what keeps a coefficient-domain JPEG route available later: a baseline
 * JPEG's Y *is* this quantity, so dropping the chroma components in the DCT
 * domain would be an exact, generation-free greying. Rec. 709 would close that
 * door for a photometric argument no other tool acts on.
 */
export function luma(r: number, g: number, b: number): number {
  const v = 0.299 * r + 0.587 * g + 0.114 * b;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * A colour space reduced to what greying needs.
 *
 * The three device families are held structurally and converted in float,
 * because they are the 99% case and `ColorConverter.toRgb` quantizes to 8-bit
 * on the way past. Everything else -- ICCBased, Indexed, Separation, DeviceN,
 * CalRGB, Lab -- arrives as `other` carrying the converter `resolveColorSpace`
 * already builds, which is why none of them needs a case here.
 */
export type GraySpace =
  | { kind: 'gray' }
  | { kind: 'rgb' }
  | { kind: 'cmyk' }
  /** `/Pattern`, optionally `[/Pattern base]` for an uncoloured pattern.
   *  `resourceName` is the `/Resources /ColorSpace` key it was found under, so
   *  a caller can retarget that one array; undefined for a bare `/Pattern`. */
  | { kind: 'pattern'; base?: GraySpace; resourceName?: string }
  | { kind: 'other'; converter: ColorConverter };

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How many numeric operands this space takes. A bare `/Pattern` takes none. */
export function componentsOf(space: GraySpace): number {
  switch (space.kind) {
    case 'gray': return 1;
    case 'rgb': return 3;
    case 'cmyk': return 4;
    case 'pattern': return space.base ? componentsOf(space.base) : 0;
    case 'other': return space.converter.components;
  }
}

/** The single grey component for `comps` interpreted in `space`. */
export function grayOf(comps: readonly number[], space: GraySpace): number {
  switch (space.kind) {
    case 'gray':
      return clamp01(comps[0] ?? 0);
    case 'rgb':
      return luma(comps[0] ?? 0, comps[1] ?? 0, comps[2] ?? 0);
    case 'cmyk': {
      const c = comps[0] ?? 0, m = comps[1] ?? 0, y = comps[2] ?? 0, k = comps[3] ?? 0;
      return luma((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k));
    }
    case 'pattern':
      return space.base ? grayOf(comps, space.base) : 0;
    case 'other': {
      const [r, g, b] = space.converter.toRgb([...comps]);
      return luma(r / 255, g / 255, b / 255);
    }
  }
}

/** Round to 4 decimals; PDF numbers gain nothing from more. `pdfxcolor.ts`'s
 *  existing rule, and what makes an already-neutral colour survive greying
 *  byte-identically despite the weights summing 1 ulp shy of 1. */
export const grayNum = (v: number): number => Number(v.toFixed(4));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayscale-core.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/grayscale.ts test/grayscale-core.test.ts
git commit -m "feat(10u9.1): the Rec. 601 greying rule and its GraySpace vocabulary"
```

---

### Task 2: `grayops.ts` — the content-operator rewriter

**Files:**
- Create: `src/grayops.ts`
- Test: `test/grayops.test.ts`

**Interfaces:**
- Consumes: `GraySpace`, `grayOf`, `grayNum` from Task 1; `ContentOp` from `src/content.ts`; `isName`, `name`, `PdfObject` from `src/types.ts`.
- Produces:
  - `type SpaceLookup = (resourceName: string) => GraySpace | undefined`
  - `interface GrayOpsResult { ops: ContentOp[]; changed: number; patternSpaces: Set<string> }`
  - `grayscaleOps(ops: readonly ContentOp[], lookup: SpaceLookup): GrayOpsResult`

- [ ] **Step 1: Write the failing test**

Create `test/grayops.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { grayscaleOps, type SpaceLookup } from '../src/grayops.js';
import type { GraySpace } from '../src/grayscale.js';
import type { ContentOp } from '../src/content.js';
import { name } from '../src/types.js';

const op = (operator: string, ...operands: unknown[]): ContentOp =>
  ({ operator, operands: operands as ContentOp['operands'] });

const none: SpaceLookup = () => undefined;

describe('grayscaleOps — device colour operators', () => {
  it('rewrites rg to g with the luma', () => {
    const r = grayscaleOps([op('rg', 1, 0, 0)], none);
    expect(r.ops).toEqual([op('g', 0.299)]);
    expect(r.changed).toBe(1);
  });

  it('rewrites RG to G, keeping the stroke/fill distinction', () => {
    const r = grayscaleOps([op('RG', 0, 1, 0)], none);
    expect(r.ops).toEqual([op('G', 0.587)]);
  });

  it('rewrites k to g', () => {
    const r = grayscaleOps([op('k', 1, 0, 0, 0)], none);
    expect(r.ops).toEqual([op('g', 0.701)]);
  });

  it('leaves g and G untouched and counts no change', () => {
    const r = grayscaleOps([op('g', 0.5), op('G', 0.25)], none);
    expect(r.ops).toEqual([op('g', 0.5), op('G', 0.25)]);
    expect(r.changed).toBe(0);
  });

  it('leaves non-colour operators alone', () => {
    const ops = [op('q'), op('re', 0, 0, 10, 10), op('f'), op('Q')];
    const r = grayscaleOps(ops, none);
    expect(r.ops).toEqual(ops);
    expect(r.changed).toBe(0);
  });
});

describe('grayscaleOps — named colour spaces', () => {
  const lookup: SpaceLookup = (n) =>
    n === 'CS0' ? ({ kind: 'rgb' } as GraySpace) : undefined;

  it('retargets cs to DeviceGray and converts the following sc', () => {
    const r = grayscaleOps([op('cs', name('CS0')), op('sc', 1, 0, 0)], lookup);
    expect(r.ops).toEqual([op('cs', name('DeviceGray')), op('g', 0.299)]);
    expect(r.changed).toBe(2);
  });

  it('resolves scn through the space in force, not the operand count', () => {
    // Four operands in a DeviceN space -- an operand-count heuristic would
    // read this as CMYK and get a different answer.
    const dn: SpaceLookup = (n) => n === 'DN' ? ({
      kind: 'other',
      converter: { components: 4, toRgb: () => [0, 0, 255], initial: () => [0, 0, 0] },
    } as GraySpace) : undefined;
    const r = grayscaleOps([op('cs', name('DN')), op('scn', 0.1, 0.2, 0.3, 0.4)], dn);
    expect(r.ops[1]).toEqual(op('g', 0.114));
  });

  it('does not rewrite a cs that already names DeviceGray', () => {
    const r = grayscaleOps([op('cs', name('DeviceGray')), op('sc', 0.5)], none);
    expect(r.changed).toBe(0);
    expect(r.ops).toEqual([op('cs', name('DeviceGray')), op('sc', 0.5)]);
  });

  it('falls back to gray for an unresolvable space rather than throwing', () => {
    const r = grayscaleOps([op('cs', name('Nope')), op('sc', 0.5)], none);
    expect(() => r).not.toThrow();
    expect(r.ops[0]).toEqual(op('cs', name('DeviceGray')));
  });
});

describe('grayscaleOps — graphics state', () => {
  it('restores the space in force across q/Q', () => {
    const lookup: SpaceLookup = (n) => n === 'CS0' ? ({ kind: 'rgb' } as GraySpace) : undefined;
    const r = grayscaleOps([
      op('cs', name('CS0')),
      op('q'), op('cs', name('DeviceGray')), op('sc', 0.5), op('Q'),
      op('sc', 1, 0, 0),
    ], lookup);
    // The trailing sc must still be read as RGB -- the inner DeviceGray was popped.
    expect(r.ops[5]).toEqual(op('g', 0.299));
  });

  it('clamps an unbalanced Q instead of throwing', () => {
    expect(() => grayscaleOps([op('Q'), op('Q'), op('rg', 1, 0, 0)], none)).not.toThrow();
    const r = grayscaleOps([op('Q'), op('rg', 1, 0, 0)], none);
    expect(r.ops[1]).toEqual(op('g', 0.299));
  });

  it('starts in DeviceGray, PDF’s initial colour', () => {
    const r = grayscaleOps([op('sc', 0.4)], none);
    expect(r.changed).toBe(0);
  });
});

describe('grayscaleOps — patterns', () => {
  it('leaves a coloured pattern scn entirely alone', () => {
    const r = grayscaleOps(
      [op('cs', name('Pattern')), op('scn', name('P0'))], none);
    expect(r.ops).toEqual([op('cs', name('Pattern')), op('scn', name('P0'))]);
    expect(r.changed).toBe(0);
  });

  it('converts an uncoloured pattern’s operands and reports its space', () => {
    const lookup: SpaceLookup = (n) => n === 'CSp'
      ? ({ kind: 'pattern', base: { kind: 'rgb' }, resourceName: 'CSp' } as GraySpace)
      : undefined;
    const r = grayscaleOps(
      [op('cs', name('CSp')), op('scn', 1, 0, 0, name('P0'))], lookup);
    // The pattern space itself is kept: the name must stay resolvable.
    expect(r.ops[0]).toEqual(op('cs', name('CSp')));
    expect(r.ops[1]).toEqual(op('scn', 0.299, name('P0')));
    expect([...r.patternSpaces]).toEqual(['CSp']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayops.test.ts`
Expected: FAIL — `Failed to resolve import "../src/grayops.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/grayops.ts`:

```ts
import type { ContentOp } from './content.js';
import { isName, name, type PdfObject } from './types.js';
import { grayOf, grayNum, type GraySpace } from './grayscale.js';

/** Resolve a `/Resources /ColorSpace` key to a space. Undefined = unknown. */
export type SpaceLookup = (resourceName: string) => GraySpace | undefined;

export interface GrayOpsResult {
  ops: ContentOp[];
  changed: number;
  /** `/ColorSpace` keys holding a `[/Pattern base]` array whose base must be
   *  retargeted to `/DeviceGray`. Reported here, rewritten by the caller --
   *  this module allocates nothing and touches no dict. */
  patternSpaces: Set<string>;
}

const GRAY: GraySpace = { kind: 'gray' };

/** Colour-space names a `cs` operand may carry without a resource entry. */
const DEVICE: Readonly<Record<string, GraySpace>> = {
  DeviceGray: GRAY, G: GRAY, CalGray: GRAY,
  DeviceRGB: { kind: 'rgb' }, RGB: { kind: 'rgb' }, CalRGB: { kind: 'rgb' },
  DeviceCMYK: { kind: 'cmyk' }, CMYK: { kind: 'cmyk' },
  Pattern: { kind: 'pattern' },
};

const nums = (operands: readonly PdfObject[]): number[] =>
  operands.filter((o): o is number => typeof o === 'number');

/**
 * Rewrite a content stream's colour operators to DeviceGray.
 *
 * Never throws: a damaged operator is left exactly as it was. The graphics
 * state is a `q`/`Q` stack of the fill and stroke spaces, both starting at
 * DeviceGray -- PDF's initial colour is black in DeviceGray -- and an
 * unbalanced `Q` clamps at the bottom rather than failing, the rule the four
 * non-object grammars in this repo already follow.
 */
export function grayscaleOps(
  ops: readonly ContentOp[], lookup: SpaceLookup,
): GrayOpsResult {
  const patternSpaces = new Set<string>();
  let changed = 0;
  let cur: { fill: GraySpace; stroke: GraySpace } = { fill: GRAY, stroke: GRAY };
  const stack: Array<{ fill: GraySpace; stroke: GraySpace }> = [];

  const out = ops.map((op): ContentOp => {
    switch (op.operator) {
      case 'q':
        stack.push(cur);
        return op;
      case 'Q':
        // Clamp rather than throw: damaged content must not take the
        // conversion down, and the worst case is one wrong space downstream.
        cur = stack.pop() ?? cur;
        return op;

      case 'g': case 'G':
        cur = op.operator === 'g' ? { ...cur, fill: GRAY } : { ...cur, stroke: GRAY };
        return op;

      case 'rg': case 'RG': case 'k': case 'K': {
        const fill = op.operator === 'rg' || op.operator === 'k';
        const space: GraySpace = op.operator === 'k' || op.operator === 'K'
          ? { kind: 'cmyk' } : { kind: 'rgb' };
        cur = fill ? { ...cur, fill: GRAY } : { ...cur, stroke: GRAY };
        const n = nums(op.operands);
        if (n.length === 0) return op;
        changed++;
        return { operator: fill ? 'g' : 'G', operands: [grayNum(grayOf(n, space))] };
      }

      case 'cs': case 'CS': {
        const a = op.operands[0];
        if (!isName(a)) return op;                       // malformed; leave it
        const space = DEVICE[a.name] ?? lookup(a.name) ?? GRAY;
        const fill = op.operator === 'cs';
        cur = fill ? { ...cur, fill: space } : { ...cur, stroke: space };
        if (space.kind === 'pattern') {
          // Keep the name: it must stay resolvable for the scn that follows.
          if (space.base && space.resourceName) patternSpaces.add(space.resourceName);
          return op;
        }
        if (a.name === 'DeviceGray') return op;
        changed++;
        return { ...op, operands: [name('DeviceGray')] };
      }

      case 'sc': case 'scn': case 'SC': case 'SCN': {
        const fill = op.operator === 'sc' || op.operator === 'scn';
        const space = fill ? cur.fill : cur.stroke;
        const last = op.operands[op.operands.length - 1];
        const n = nums(op.operands);

        if (isName(last)) {
          // A pattern. Coloured (no numbers) takes its colour from the
          // pattern's own content stream, which the caller converts separately.
          if (n.length === 0) return op;
          const base = space.kind === 'pattern' && space.base ? space.base : space;
          changed++;
          return { ...op, operands: [grayNum(grayOf(n, base)), last] };
        }
        if (n.length === 0 || space.kind === 'gray') return op;
        changed++;
        return { operator: fill ? 'g' : 'G', operands: [grayNum(grayOf(n, space))] };
      }

      default:
        return op;
    }
  });

  return { ops: out, changed, patternSpaces };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayops.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/grayops.ts test/grayops.test.ts
git commit -m "feat(10u9.1): content-operator colour rewriter with a q/Q space stack"
```

---

### Task 3: `grayconvert.ts` — enumeration, entry point, content streams end to end

This is the task that makes the feature real: after it, page content, form XObjects, tiling patterns, Type 3 charprocs, annotation appearances and soft-mask groups all convert.

**Files:**
- Create: `src/grayconvert.ts`
- Modify: `src/signature.ts` (add `hasSignatureField`)
- Modify: `src/optimize.ts:74-92` (delete private `isSigned`, import `hasSignatureField`)
- Modify: `src/document.ts` (add `ConvertToGrayscale`)
- Modify: `src/index.ts` (export the types)
- Create: `test/helpers/build-grayscale-pdf.ts`
- Test: `test/grayscale-convert.test.ts`

**Interfaces:**
- Consumes: `grayscaleOps`, `SpaceLookup` (Task 2); `GraySpace` (Task 1); `parseContentStream`/`serializeContentStream` from `src/content.ts`; `inflateStream` from `src/flate.ts`; `resolveColorSpace` from `src/colorspace.ts`; `doc.replaceObject(num, obj)`, `doc.resolve(o)`, `doc.catalog()`, `doc.Pages`.
- Produces:
  - `interface GrayscaleOptions { quality?: number }`
  - `interface GrayImageResult { objNum: number; from: string; route: 'palette' | 'jpeg' | 'flate'; bytesDelta: number }`
  - `interface GraySkipped { objNum?: number; what: 'image' | 'shading' | 'content' | 'annotation'; reason: string }`
  - `interface GrayscaleReport { streams: number; operators: number; images: GrayImageResult[]; shadings: number; annotations: number; skipped: GraySkipped[]; lossy: boolean; bytesDelta: number }`
  - `convertToGrayscale(doc: Document, opts: GrayscaleOptions): GrayscaleReport`
  - `Document.ConvertToGrayscale(opts?: GrayscaleOptions): GrayscaleReport`
  - From `src/signature.ts`: `hasSignatureField(doc: Document): boolean`

- [ ] **Step 1: Move `isSigned` to `signature.ts`**

One owner for "does this document carry a signature". `optimize.ts` has the only copy today and this feature needs the same guard for the same reason.

Add to `src/signature.ts` (its imports already include `PdfDict` from `./types.js`; add `isDict`, `isArray`, `isName` to that import, and add a type-only `Document` import):

```ts
import type { Document } from './document.js';
```

```ts
/** True when the document carries any signature field. Optimizing or
 *  converting one would invalidate it, and `Save()` returns the cached signed
 *  bytes verbatim, so every change would be discarded silently. */
export function hasSignatureField(doc: Document): boolean {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return false;
  const fields = doc.resolve(acro.get('Fields'));
  if (!isArray(fields)) return false;
  const stack = [...fields];
  const seen = new Set<PdfDict>();
  while (stack.length) {
    const f = doc.resolve(stack.pop()!);
    if (!isDict(f) || seen.has(f)) continue;
    seen.add(f);
    const ft = doc.resolve(f.get('FT'));
    if (isName(ft) && ft.name === 'Sig') return true;
    const kids = doc.resolve(f.get('Kids'));
    if (isArray(kids)) stack.push(...kids);
  }
  return false;
}
```

In `src/optimize.ts`, delete the private `isSigned` function (lines 74-92) and its one call site's reference, adding:

```ts
import { hasSignatureField } from './signature.js';
```

and change `if (isSigned(doc)) {` at line 301 to `if (hasSignatureField(doc)) {`.

- [ ] **Step 2: Run the existing suite to prove the move is behaviour-neutral**

Run: `npx vitest run test/optimize.test.ts && npm run typecheck`
Expected: PASS, unchanged. Typecheck clean.

- [ ] **Step 3: Commit the refactor on its own**

```bash
git add src/signature.ts src/optimize.ts
git commit -m "refactor(10u9.1): one owner for hasSignatureField, in signature.ts"
```

- [ ] **Step 4: Write the fixture builder**

Create `test/helpers/build-grayscale-pdf.ts`. It assembles a one-page PDF whose colour lives in five different places, so a single conversion exercises the whole enumeration.

```ts
const enc = (s: string) => new TextEncoder().encode(s);

type Obj = string | { dict: string; raw: Uint8Array };

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Assemble numbered objects into a classic-xref PDF. Object 1 must be /Catalog. */
export function assemble(objs: Obj[]): Uint8Array {
  const parts: Uint8Array[] = [enc('%PDF-1.7\n')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  for (let i = 1; i < objs.length; i++) {
    const o = objs[i];
    offsets[i] = pos;
    if (typeof o === 'string') {
      const b = enc(`${i} 0 obj\n${o}\nendobj\n`);
      parts.push(b); pos += b.length;
    } else {
      const head = enc(`${i} 0 obj\n${o.dict}\nstream\n`);
      const tail = enc('\nendstream\nendobj\n');
      parts.push(head, o.raw, tail);
      pos += head.length + o.raw.length + tail.length;
    }
  }
  const xref = pos;
  let x = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  parts.push(enc(x));
  return concat(parts);
}

const stream = (extra: string, body: string) => ({
  dict: `<< ${extra}/Length ${enc(body).length} >>`,
  raw: enc(body),
});

/**
 * A 200x200 page carrying colour in five places at once:
 *   - page content: `1 0 0 rg` and a named DeviceRGB space via `/CS0 cs`
 *   - a Form XObject: `0 0 1 rg`
 *   - a tiling pattern: `0 1 0 rg`
 *   - a Type 3 glyph procedure: `1 1 0 rg`
 *   - an annotation /AP stream: `0 1 1 rg`
 * Every one of them must come back grey.
 */
export function buildGrayscalePdf(): Uint8Array {
  const content =
    '1 0 0 rg 0 0 50 50 re f\n'
    + '/CS0 cs 0 0 1 sc 50 0 50 50 re f\n'
    + '/Fm0 Do\n'
    + '/Pattern cs /P0 scn 0 100 50 50 re f\n'
    + 'BT /T3 12 Tf 10 150 Td (a) Tj ET\n';

  return assemble([
    '',                                                            // 0 (free)
    '<< /Type /Catalog /Pages 2 0 R >>',                           // 1
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',                   // 2
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '        // 3
      + '/Resources << /ColorSpace << /CS0 /DeviceRGB >> '
      + '/XObject << /Fm0 5 0 R >> /Pattern << /P0 6 0 R >> '
      + '/Font << /T3 7 0 R >> >> '
      + '/Contents 4 0 R /Annots [10 0 R] >>',
    stream('', content),                                           // 4
    { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] '  // 5
        + `/Length ${enc('0 0 1 rg 0 0 50 50 re f').length} >>`,
      raw: enc('0 0 1 rg 0 0 50 50 re f') },
    { dict: '<< /Type /Pattern /PatternType 1 /PaintType 1 '       // 6
        + '/TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 '
        + '/Resources << >> '
        + `/Length ${enc('0 1 0 rg 0 0 10 10 re f').length} >>`,
      raw: enc('0 1 0 rg 0 0 10 10 re f') },
    '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 12 12] '        // 7
      + '/FontMatrix [0.001 0 0 0.001 0 0] /CharProcs 8 0 R '
      + '/Encoding << /Type /Encoding /Differences [97 /a] >> '
      + '/FirstChar 97 /LastChar 97 /Widths [1000] /Resources << >> >>',
    '<< /a 9 0 R >>',                                              // 8
    { dict: `<< /Length ${enc('1000 0 0 0 12 12 d1 1 1 0 rg 0 0 12 12 re f').length} >>`,
      raw: enc('1000 0 0 0 12 12 d1 1 1 0 rg 0 0 12 12 re f') },   // 9
    '<< /Type /Annot /Subtype /Square /Rect [100 100 150 150] '    // 10
      + '/F 4 /C [1 0 0] /IC [0 0 1] /AP << /N 11 0 R >> >>',
    { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 50 50] '  // 11
        + `/Length ${enc('0 1 1 rg 0 0 50 50 re f').length} >>`,
      raw: enc('0 1 1 rg 0 0 50 50 re f') },
  ]);
}

/** The same page with every colour already stated in DeviceGray. Converting it
 *  must change nothing at all -- the byte-identity fence. */
export function buildAlreadyGrayPdf(): Uint8Array {
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << >> /Contents 4 0 R >>',
    stream('', '0.3 g 0 0 50 50 re f 0.7 G 1 w 10 10 m 40 40 l S'),
  ]);
}
```

- [ ] **Step 5: Write the failing test**

Create `test/grayscale-convert.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildGrayscalePdf, buildAlreadyGrayPdf } from './helpers/build-grayscale-pdf.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { inflateStream } from '../src/flate.js';
import { isStream } from '../src/types.js';

/** Every content stream in the saved document, as text. */
function allContent(bytes: Uint8Array): string {
  const doc = Document.Open(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    try { out.push(new TextDecoder().decode(inflateStream(obj))); } catch { /* not content */ }
  }
  return out.join('\n');
}

describe('Document.ConvertToGrayscale — content streams', () => {
  it('converts colour in all five content locations', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertToGrayscale();
    const text = allContent(doc.Save());

    // No colour-setting operator survives anywhere.
    expect(text).not.toMatch(/\brg\b/);
    expect(text).not.toMatch(/\bRG\b/);
    expect(text).not.toMatch(/\bk\b/);

    // Each of the five reds/blues/greens/yellows/cyans became its luma.
    expect(text).toContain('0.299 g');   // page content, 1 0 0 rg
    expect(text).toContain('0.114 g');   // page content, /CS0 cs 0 0 1 sc
    expect(text).toContain('0.587 g');   // tiling pattern, 0 1 0 rg
    expect(text).toContain('0.886 g');   // Type 3 charproc, 1 1 0 rg
    expect(text).toContain('0.701 g');   // annotation /AP, 0 1 1 rg

    expect(report.streams).toBe(5);
    expect(report.operators).toBe(6);    // five rg/sc + one cs retarget
    expect(report.skipped).toEqual([]);
    expect(report.lossy).toBe(false);
  });

  it('retargets a named colour space to DeviceGray', () => {
    const doc = Document.Open(buildGrayscalePdf());
    doc.ConvertToGrayscale();
    expect(allContent(doc.Save())).toContain('/DeviceGray cs');
  });

  it('converts a shared form XObject exactly once', () => {
    // Placing the same form twice must not double-count or re-convert output.
    const doc = Document.Open(buildGrayscalePdf());
    const first = doc.ConvertToGrayscale();
    const again = doc.ConvertToGrayscale();
    expect(first.operators).toBeGreaterThan(0);
    // A second run finds nothing left to do -- the pass is idempotent.
    expect(again.operators).toBe(0);
    expect(again.streams).toBe(0);
  });

  it('leaves an already-grey document byte-identical', () => {
    const src = buildAlreadyGrayPdf();
    const control = Document.Open(src).Save();
    const doc = Document.Open(src);
    const report = doc.ConvertToGrayscale();
    expect(report.operators).toBe(0);
    expect(doc.Save()).toEqual(control);
  });

  it('refuses a signed document rather than discarding the change', () => {
    const doc = Document.Open(buildFormPdf());
    // buildFormPdf has no /Sig field; add one so the guard fires.
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as Map<string, unknown>;
    expect(acro).toBeDefined();
    const fields = doc.resolve(acro.get('Fields') as never) as unknown[];
    fields.push(doc.allocObject(new Map([['FT', { kind: 'name', name: 'Sig' }]]) as never));
    expect(() => doc.ConvertToGrayscale()).toThrow(UnsupportedFeatureError);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run test/grayscale-convert.test.ts`
Expected: FAIL — `doc.ConvertToGrayscale is not a function`.

- [ ] **Step 7: Write `src/grayconvert.ts`**

```ts
import type { Document } from './document.js';
import {
  PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream, name,
} from './types.js';
import { UnsupportedFeatureError } from './errors.js';
import { hasSignatureField } from './signature.js';
import { parseContentStream, serializeContentStream } from './content.js';
import { inflateStream } from './flate.js';
import { resolveColorSpace } from './colorspace.js';
import { grayscaleOps, type SpaceLookup } from './grayops.js';
import type { GraySpace } from './grayscale.js';

export interface GrayscaleOptions {
  /** IJG quality for re-encoded DCT images, 1..100. Default 90. */
  quality?: number;
}

export interface GrayImageResult {
  objNum: number;
  /** The colour space it came from, e.g. 'DeviceRGB', 'Indexed'. */
  from: string;
  route: 'palette' | 'jpeg' | 'flate';
  /** Negative when the converted image is smaller. */
  bytesDelta: number;
}

export interface GraySkipped {
  objNum?: number;
  what: 'image' | 'shading' | 'content' | 'annotation';
  reason: string;
}

export interface GrayscaleReport {
  streams: number;
  operators: number;
  images: GrayImageResult[];
  shadings: number;
  annotations: number;
  /** What could not be converted, and why. The first place to look when a
   *  converted document still shows colour. */
  skipped: GraySkipped[];
  /** True when any image was re-encoded through JPEG: the output is no longer
   *  a lossless greying of the original. */
  lossy: boolean;
  bytesDelta: number;
}

const MAX_DEPTH = 32;

/** The object number an indirect entry points at, or undefined for a direct one. */
function refNum(o: PdfObject | undefined): number | undefined {
  return o && typeof o === 'object' && 'kind' in o && o.kind === 'ref' ? o.num : undefined;
}

const dictOf = (doc: Document, o: PdfObject | undefined): PdfDict | undefined => {
  const r = doc.resolve(o);
  return isDict(r) ? r : undefined;
};

/**
 * Build the `/Resources /ColorSpace` lookup for one content scope.
 *
 * Everything non-device funnels through `resolveColorSpace`, which is what
 * keeps ICCBased, Indexed, Separation, DeviceN and Lab from needing cases of
 * their own -- and holds this feature to the repo's rule that "what colour is
 * this operand" has exactly one owner.
 */
function spaceLookup(doc: Document, resources: PdfDict | undefined): SpaceLookup {
  const csDict = dictOf(doc, resources?.get('ColorSpace'));
  const cache = new Map<string, GraySpace | undefined>();
  return (key: string): GraySpace | undefined => {
    if (cache.has(key)) return cache.get(key);
    let out: GraySpace | undefined;
    const entry = csDict?.get(key);
    const cs = doc.resolve(entry);
    if (isArray(cs) && cs.length > 0 && isName(doc.resolve(cs[0]))
        && (doc.resolve(cs[0]) as { name: string }).name === 'Pattern') {
      out = cs.length > 1
        ? { kind: 'pattern', base: baseSpace(doc, cs[1]), resourceName: key }
        : { kind: 'pattern' };
    } else if (cs !== undefined && cs !== null) {
      out = baseSpace(doc, entry);
    }
    cache.set(key, out);
    return out;
  };
}

function baseSpace(doc: Document, cs: PdfObject | undefined): GraySpace {
  const r = doc.resolve(cs);
  if (isName(r)) {
    if (r.name === 'DeviceGray' || r.name === 'G' || r.name === 'CalGray') return { kind: 'gray' };
    if (r.name === 'DeviceRGB' || r.name === 'RGB') return { kind: 'rgb' };
    if (r.name === 'DeviceCMYK' || r.name === 'CMYK') return { kind: 'cmyk' };
  }
  return {
    kind: 'other',
    converter: resolveColorSpace(
      r, (o) => doc.resolve(o), (s) => inflateStream(s as PdfStream)),
  };
}

/** One content stream and the resources in force for it. */
interface Scope { objNum: number; stream: PdfStream; resources: PdfDict | undefined }

/**
 * Every content stream in the document, with its effective resources.
 *
 * Six sources: page /Contents, Form XObjects, tiling patterns, Type 3
 * /CharProcs, annotation /AP streams (/N /R /D, including the per-state dict
 * form) and ExtGState /SMask /G groups. Deduped by object number -- a
 * correctness rule, not an optimization: a form reached through two pages
 * would otherwise be rewritten twice, the second time from the first write's
 * output.
 */
function collectScopes(doc: Document): Scope[] {
  const out: Scope[] = [];
  const seen = new Set<number>();

  const addStream = (o: PdfObject | undefined, resources: PdfDict | undefined,
                     depth: number): void => {
    const num = refNum(o);
    const s = doc.resolve(o);
    if (!isStream(s) || num === undefined || seen.has(num) || depth > MAX_DEPTH) return;
    seen.add(num);
    const own = dictOf(doc, s.dict.get('Resources')) ?? resources;
    out.push({ objNum: num, stream: s, resources: own });
    walkResources(own, depth + 1);
  };

  const walkResources = (resources: PdfDict | undefined, depth: number): void => {
    if (!resources || depth > MAX_DEPTH) return;

    const xo = dictOf(doc, resources.get('XObject'));
    if (xo) for (const [, v] of xo) {
      const s = doc.resolve(v);
      if (isStream(s) && isName(doc.resolve(s.dict.get('Subtype')))
          && (doc.resolve(s.dict.get('Subtype')) as { name: string }).name === 'Form')
        addStream(v, resources, depth);
    }

    const pat = dictOf(doc, resources.get('Pattern'));
    if (pat) for (const [, v] of pat) {
      const s = doc.resolve(v);
      if (isStream(s) && doc.resolve(s.dict.get('PatternType')) === 1)
        addStream(v, resources, depth);
    }

    const fonts = dictOf(doc, resources.get('Font'));
    if (fonts) for (const [, v] of fonts) {
      const f = dictOf(doc, v);
      const procs = f ? dictOf(doc, f.get('CharProcs')) : undefined;
      if (!procs) continue;
      const fontRes = f ? dictOf(doc, f.get('Resources')) : undefined;
      for (const [, p] of procs) addStream(p, fontRes ?? resources, depth);
    }

    const gs = dictOf(doc, resources.get('ExtGState'));
    if (gs) for (const [, v] of gs) {
      const g = dictOf(doc, v);
      const sm = g ? dictOf(doc, g.get('SMask')) : undefined;
      if (sm) addStream(sm.get('G'), resources, depth);
    }
  };

  for (const page of doc.Pages) {
    const resources = dictOf(doc, page.Dict.get('Resources'));
    const contents = page.Dict.get('Contents');
    const c = doc.resolve(contents);
    if (isArray(c)) for (const e of c) addStream(e, resources, 0);
    else addStream(contents, resources, 0);
    walkResources(resources, 0);

    const annots = doc.resolve(page.Dict.get('Annots'));
    if (isArray(annots)) for (const a of annots) {
      const ad = dictOf(doc, a);
      const ap = ad ? dictOf(doc, ad.get('AP')) : undefined;
      if (!ap) continue;
      for (const key of ['N', 'R', 'D']) {
        const entry = ap.get(key);
        const r = doc.resolve(entry);
        if (isStream(r)) addStream(entry, resources, 0);
        else if (isDict(r)) for (const [, st] of r) addStream(st, resources, 0);
      }
    }
  }
  return out;
}

/** Rewrite a `[/Pattern base]` colour space in place to `[/Pattern /DeviceGray]`.
 *  The sole colour-space resource this design retargets -- safe because such an
 *  array is referenced by nothing but `cs` + `scn`, never by an image. */
function retargetPatternSpaces(
  doc: Document, resources: PdfDict | undefined, keys: Set<string>,
): void {
  if (keys.size === 0) return;
  const csDict = dictOf(doc, resources?.get('ColorSpace'));
  if (!csDict) return;
  for (const key of keys) {
    const arr = doc.resolve(csDict.get(key));
    if (isArray(arr) && arr.length > 1) csDict.set(key, [arr[0], name('DeviceGray')]);
  }
}

/** Rewrite every content stream. Returns the streams and operators changed. */
function convertContent(
  doc: Document, report: GrayscaleReport,
): void {
  for (const scope of collectScopes(doc)) {
    let ops;
    try {
      ops = parseContentStream(inflateStream(scope.stream));
    } catch (e) {
      report.skipped.push({
        objNum: scope.objNum, what: 'content',
        reason: `content stream would not parse: ${(e as Error).message}`,
      });
      continue;
    }
    const r = grayscaleOps(ops, spaceLookup(doc, scope.resources));
    retargetPatternSpaces(doc, scope.resources, r.patternSpaces);
    if (r.changed === 0) continue;

    const raw = serializeContentStream(r.ops);
    const dict: PdfDict = new Map(scope.stream.dict);
    dict.delete('Filter');            // we wrote raw (uncompressed) bytes
    dict.delete('DecodeParms');
    dict.delete('DP');
    dict.set('Length', raw.length);
    doc.replaceObject(scope.objNum, { kind: 'stream', dict, raw });

    report.streams++;
    report.operators += r.changed;
    report.bytesDelta += raw.length - scope.stream.raw.length;
  }
}

/** Convert a document's colour to DeviceGray. See the module docs above. */
export function convertToGrayscale(
  doc: Document, opts: GrayscaleOptions = {},
): GrayscaleReport {
  if (hasSignatureField(doc)) {
    throw new UnsupportedFeatureError(
      'ConvertToGrayscale: the document is signed; converting it would '
      + 'invalidate the signature and Save() would discard the change');
  }
  void opts;                          // consumed by the image pass (Task 6)
  const report: GrayscaleReport = {
    streams: 0, operators: 0, images: [], shadings: 0, annotations: 0,
    skipped: [], lossy: false, bytesDelta: 0,
  };
  convertContent(doc, report);
  return report;
}
```

- [ ] **Step 8: Wire the entry point**

In `src/document.ts`, add to the imports:

```ts
import {
  convertToGrayscale, GrayscaleOptions, GrayscaleReport,
} from './grayconvert.js';
```

and add the method beside `Optimize` (after line 1420):

```ts
  /** Convert the document's colour to DeviceGray in place: page content, form
   *  XObjects, tiling patterns, Type 3 glyph procedures, image XObjects,
   *  shadings and annotations. Colour is discarded, so this is not reversible;
   *  the returned report lists what converted and what could not. Throws
   *  {@link UnsupportedFeatureError} for a signed document. */
  ConvertToGrayscale(opts: GrayscaleOptions = {}): GrayscaleReport {
    return convertToGrayscale(this, opts);
  }
```

In `src/index.ts`, beside the `optimize.js` export block, add:

```ts
export type {
  GrayscaleOptions, GrayscaleReport, GrayImageResult, GraySkipped,
} from './grayconvert.js';
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run test/grayscale-convert.test.ts && npm run typecheck`
Expected: PASS, 5 tests. Typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add src/grayconvert.ts src/document.ts src/index.ts \
        test/helpers/build-grayscale-pdf.ts test/grayscale-convert.test.ts
git commit -m "feat(10u9.1): ConvertToGrayscale over every content stream"
```

---

### Task 4: `grayimage.ts` — the Indexed palette route

The best route and the one to build first: it rewrites the lookup table alone, never touches sample data, is lossless, shrinks the palette, and is the only route that works below 8 bits per component.

**Files:**
- Create: `src/grayimage.ts`
- Test: `test/grayimage.test.ts`

**Interfaces:**
- Consumes: `grayOf`, `luma`, `GraySpace` (Task 1).
- Produces:
  - `type Resolve = (o: PdfObject | undefined) => PdfObject`
  - `type Inflate = (s: PdfStream) => Uint8Array`
  - `interface GrayImageOptions { quality?: number }`
  - `type GrayImageOutcome = { kind: 'converted'; stream: PdfStream; from: string; route: 'palette' | 'jpeg' | 'flate' } | { kind: 'none' } | { kind: 'skip'; reason: string }`
  - `grayscaleImage(stream: PdfStream, resolve: Resolve, inflate: Inflate, opts: GrayImageOptions): GrayImageOutcome`

`kind: 'none'` means *nothing to convert* — an `/ImageMask`, an already-grey image. It goes in neither report list; that distinction is what keeps the skip list readable.

- [ ] **Step 1: Write the failing test**

Create `test/grayimage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { grayscaleImage } from '../src/grayimage.js';
import { PdfDict, PdfObject, PdfStream, isStream, name } from '../src/types.js';

const resolve = (o: PdfObject | undefined): PdfObject => o as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;

const img = (entries: [string, PdfObject][], raw: Uint8Array): PdfStream => ({
  kind: 'stream',
  dict: new Map<string, PdfObject>([
    ['Type', name('XObject')], ['Subtype', name('Image')], ...entries,
  ]) as PdfDict,
  raw,
});

describe('grayscaleImage — nothing to convert', () => {
  it('reports none for an image mask', () => {
    const s = img([['ImageMask', true], ['Width', 2], ['Height', 2]], new Uint8Array(1));
    expect(grayscaleImage(s, resolve, inflate, {}).kind).toBe('none');
  });

  it('reports none for an already-DeviceGray image', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['ColorSpace', name('DeviceGray')],
      ['BitsPerComponent', 8],
    ], new Uint8Array(4));
    expect(grayscaleImage(s, resolve, inflate, {}).kind).toBe('none');
  });
});

describe('grayscaleImage — the Indexed palette route', () => {
  const palette = () => new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);

  it('greys the lookup table and leaves the samples untouched', () => {
    const samples = new Uint8Array([0, 1, 2, 3]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3,
        { kind: 'string', bytes: palette() } as PdfObject]],
    ], samples);

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('palette');
    // Sample data is byte-identical: only the palette moved.
    expect(r.stream.raw).toEqual(samples);

    const cs = r.stream.dict.get('ColorSpace') as PdfObject[];
    expect(cs[1]).toEqual(name('DeviceGray'));
    const lut = cs[3] as { bytes: Uint8Array };
    // 0.299, 0.587, 0.114, 1.0 -> 8-bit.
    expect([...lut.bytes]).toEqual([76, 150, 29, 255]);
  });

  it('converts at 4 bits per component, where the sample routes cannot', () => {
    const s = img([
      ['Width', 4], ['Height', 1], ['BitsPerComponent', 4],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3,
        { kind: 'string', bytes: palette() } as PdfObject]],
    ], new Uint8Array([0x01, 0x23]));

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('palette');
    expect(r.stream.dict.get('BitsPerComponent')).toBe(4);
  });

  it('reads a palette stored as a stream, not only as a string', () => {
    const lutStream: PdfStream = { kind: 'stream', dict: new Map(), raw: palette() };
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3, lutStream]],
    ], new Uint8Array([0, 1, 2, 3]));

    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    const cs = r.stream.dict.get('ColorSpace') as PdfObject[];
    expect(isStream(cs[3] as PdfObject)).toBe(true);
    expect([...(cs[3] as PdfStream).raw]).toEqual([76, 150, 29, 255]);
  });

  it('preserves every unrelated dict key', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', [name('Indexed'), name('DeviceRGB'), 3,
        { kind: 'string', bytes: palette() } as PdfObject]],
      ['SMask', { kind: 'ref', num: 9, gen: 0 } as PdfObject],
      ['Intent', name('RelativeColorimetric')],
    ], new Uint8Array([0, 1, 2, 3]));

    const r = grayscaleImage(s, resolve, inflate, {});
    if (r.kind !== 'converted') throw new Error('expected converted');
    expect(r.stream.dict.get('SMask')).toEqual({ kind: 'ref', num: 9, gen: 0 });
    expect(r.stream.dict.get('Intent')).toEqual(name('RelativeColorimetric'));
  });
});

describe('grayscaleImage — guards', () => {
  it('skips a colour-key /Mask, which has no faithful grey range', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')],
      ['Mask', [0, 10, 0, 10, 0, 10]],
    ], new Uint8Array(12));
    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/colour-key/i);
  });

  it('skips an image carrying a /Decode array', () => {
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Decode', [1, 0, 1, 0, 1, 0]],
    ], new Uint8Array(12));
    const r = grayscaleImage(s, resolve, inflate, {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/\/Decode/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayimage.test.ts`
Expected: FAIL — `Failed to resolve import "../src/grayimage.js"`.

- [ ] **Step 3: Write `src/grayimage.ts` with the palette route and the guards**

```ts
import {
  PdfDict, PdfObject, PdfStream, isArray, isName, isStream, isString, name,
} from './types.js';
import { resolveColorSpace } from './colorspace.js';
import { luma } from './grayscale.js';

export type Resolve = (o: PdfObject | undefined) => PdfObject;
export type Inflate = (s: PdfStream) => Uint8Array;

export interface GrayImageOptions {
  /** IJG quality for re-encoded DCT images, 1..100. Default 90. */
  quality?: number;
}

export type GrayImageOutcome =
  | { kind: 'converted'; stream: PdfStream; from: string; route: 'palette' | 'jpeg' | 'flate' }
  /** Nothing to convert -- an /ImageMask, an already-grey image. Belongs in
   *  neither report list: a skip list padded with non-gaps is unreadable. */
  | { kind: 'none' }
  | { kind: 'skip'; reason: string };

const nm = (resolve: Resolve, o: PdfObject | undefined): string | undefined => {
  const r = resolve(o);
  return isName(r) ? r.name : undefined;
};

/** The head name of a colour space: 'DeviceRGB', 'Indexed', 'ICCBased', ... */
function csHead(resolve: Resolve, cs: PdfObject | undefined): string {
  const r = resolve(cs);
  if (isName(r)) return r.name;
  if (isArray(r) && r.length > 0) return nm(resolve, r[0]) ?? '';
  return '';
}

/** True when the space already delivers a single grey component. */
function alreadyGray(resolve: Resolve, cs: PdfObject | undefined): boolean {
  const head = csHead(resolve, cs);
  if (head === 'DeviceGray' || head === 'G' || head === 'CalGray') return true;
  if (head === 'ICCBased') {
    const arr = resolve(cs);
    const s = isArray(arr) ? resolve(arr[1]) : undefined;
    return isStream(s) && resolve(s.dict.get('N')) === 1;
  }
  return false;
}

/** A reason this image must not be converted, or undefined when it may be. */
function guard(resolve: Resolve, dict: PdfDict): string | undefined {
  const mask = resolve(dict.get('Mask'));
  if (isArray(mask)) {
    return 'colour-key /Mask: two colours can share a luma, so an RGB range is '
      + 'not a grey range and the mask would match pixels it never matched';
  }
  if (dict.has('Decode')) {
    return 'has /Decode (sample inversion the conversion would not reproduce)';
  }
  return undefined;
}

/** Grey one palette entry set. `nc` components per entry, 0..255 bytes in. */
function grayPalette(table: Uint8Array, nc: number): Uint8Array {
  const count = Math.floor(table.length / nc);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const r = (table[i * nc] ?? 0) / 255;
    const g = nc > 1 ? (table[i * nc + 1] ?? 0) / 255 : r;
    const b = nc > 2 ? (table[i * nc + 2] ?? 0) / 255 : r;
    // A CMYK palette needs the full converter; RGB and gray are exact here.
    out[i] = Math.round(luma(r, g, b) * 255);
  }
  return out;
}

/** The Indexed route: rewrite the lookup table, leave the samples alone. */
function convertIndexed(
  stream: PdfStream, resolve: Resolve, inflate: Inflate,
): GrayImageOutcome {
  const cs = resolve(stream.dict.get('ColorSpace'));
  if (!isArray(cs) || cs.length < 4) return { kind: 'skip', reason: 'malformed Indexed colourspace' };

  const base = resolve(cs[1]);
  if (alreadyGray(resolve, base)) return { kind: 'none' };

  const converter = resolveColorSpace(base, resolve, (s) => inflate(s as PdfStream));
  const nc = converter.components;

  const lookupObj = resolve(cs[3]);
  let table: Uint8Array;
  if (isString(lookupObj)) table = lookupObj.bytes;
  else if (isStream(lookupObj)) table = inflate(lookupObj);
  else return { kind: 'skip', reason: 'Indexed /Lookup is neither a string nor a stream' };

  // Route each entry through the base converter so a CMYK, Lab or ICCBased
  // palette greys by the same rule as everything else.
  const count = Math.floor(table.length / nc);
  const grey = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const comps: number[] = [];
    for (let k = 0; k < nc; k++) comps.push((table[i * nc + k] ?? 0) / 255);
    const [r, g, b] = converter.toRgb(comps);
    grey[i] = Math.round(luma(r / 255, g / 255, b / 255) * 255);
  }

  const lookup: PdfObject = isStream(lookupObj)
    ? { kind: 'stream',
        dict: new Map([...lookupObj.dict, ['Length', grey.length]]).
          // the greyed table is written raw
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          constructor === Map ? stripFilter(lookupObj.dict, grey.length) : new Map(),
        raw: grey }
    : { kind: 'string', bytes: grey };

  const dict: PdfDict = new Map(stream.dict);
  dict.set('ColorSpace', [cs[0], name('DeviceGray'), cs[2], lookup]);
  return { kind: 'converted', stream: { ...stream, dict }, from: 'Indexed', route: 'palette' };
}

/** A palette stream's dict with its filter dropped (we write raw bytes). */
function stripFilter(src: PdfDict, length: number): PdfDict {
  const d: PdfDict = new Map(src);
  d.delete('Filter');
  d.delete('DecodeParms');
  d.delete('DP');
  d.set('Length', length);
  return d;
}

/**
 * Convert one image XObject to DeviceGray.
 *
 * Pure: `resolve` and `inflate` arrive as arguments so every rule is testable
 * from a hand-built dict without building a file -- `glyphprogram.ts`'s
 * pattern.
 */
export function grayscaleImage(
  stream: PdfStream, resolve: Resolve, inflate: Inflate,
  opts: GrayImageOptions = {},
): GrayImageOutcome {
  void opts;                                   // used by the sample routes
  const dict = stream.dict;
  if (resolve(dict.get('ImageMask')) === true) return { kind: 'none' };

  const cs = dict.get('ColorSpace');
  if (cs === undefined) return { kind: 'skip', reason: 'missing /ColorSpace' };
  if (alreadyGray(resolve, cs)) return { kind: 'none' };

  const g = guard(resolve, dict);
  if (g) return { kind: 'skip', reason: g };

  const head = csHead(resolve, cs);
  if (head === 'Indexed' || head === 'I') return convertIndexed(stream, resolve, inflate);

  return { kind: 'skip', reason: `route not implemented for ${head}` };
}
```

> Note for the implementer: the ternary building `lookup` above is deliberately
> written out in the next step — simplify it to
> `{ kind: 'stream', dict: stripFilter(lookupObj.dict, grey.length), raw: grey }`
> for the stream case. It is spelled awkwardly here only to keep the two
> branches visible; write the clean form.

- [ ] **Step 4: Simplify the `lookup` construction**

Replace the `const lookup: PdfObject = ...` expression with:

```ts
  const lookup: PdfObject = isStream(lookupObj)
    ? { kind: 'stream', dict: stripFilter(lookupObj.dict, grey.length), raw: grey }
    : { kind: 'string', bytes: grey };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/grayimage.test.ts && npm run typecheck`
Expected: PASS, 7 tests. Typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/grayimage.ts test/grayimage.test.ts
git commit -m "feat(10u9.1): Indexed images grey by palette rewrite, samples untouched"
```

---

### Task 5: `grayimage.ts` — the DCT and sample routes

**Files:**
- Modify: `src/grayimage.ts`
- Modify: `test/grayimage.test.ts`

**Interfaces:**
- Consumes: `decodeJpeg` from `src/jpeg.ts`; `encodeJpeg`, `JpegKind` from `src/jpegencode.ts`; `encodeStream` from `src/filters.ts`; `ImageInfo`-equivalent decoding — but note **`grayimage.ts` must not import `image.ts`'s `ImageInfo`, which takes a `Document`**. Decode through the `inflate` callback for sample filters and `decodeJpeg` for DCT.
- Produces: the same `grayscaleImage` signature, now returning `route: 'jpeg'` and `route: 'flate'`.

- [ ] **Step 1: Write the failing tests**

Append to `test/grayimage.test.ts`:

```ts
import { encodeJpeg } from '../src/jpegencode.js';
import { decodeJpeg } from '../src/jpeg.js';
import { deflateSync, inflateSync } from 'node:zlib';

describe('grayscaleImage — the DCT route', () => {
  it('re-encodes an RGB JPEG as a one-component grey JPEG', () => {
    const w = 8, h = 8;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { rgb[i * 3] = 255; rgb[i * 3 + 1] = 0; rgb[i * 3 + 2] = 0; }
    const jpeg = encodeJpeg(w, h, rgb, 'rgb', { quality: 90 });

    const s = img([
      ['Width', w], ['Height', h], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('DCTDecode')],
    ], jpeg);

    const r = grayscaleImage(s, resolve, inflate, { quality: 90 });
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('jpeg');
    expect(r.from).toBe('DeviceRGB');
    expect(r.stream.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    expect(r.stream.dict.get('Filter')).toEqual(name('DCTDecode'));

    const out = decodeJpeg(r.stream.raw);
    expect(out.comps).toBe(1);
    expect(out.width).toBe(w);
    // Pure red -> 0.299 * 255 = 76, within JPEG's tolerance.
    expect(Math.abs(out.data[0] - 76)).toBeLessThanOrEqual(6);
  });
});

describe('grayscaleImage — the sample route', () => {
  it('greys Flate RGB samples and re-deflates them', () => {
    const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
    const s = img([
      ['Width', 2], ['Height', 2], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(rgb)));

    const r = grayscaleImage(s, (o) => o as never,
      (st) => new Uint8Array(inflateSync(st.raw)), {});
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.route).toBe('flate');
    expect(r.stream.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    expect(r.stream.dict.get('BitsPerComponent')).toBe(8);
    expect([...new Uint8Array(inflateSync(r.stream.raw))]).toEqual([76, 150, 29, 255]);
  });

  it('skips sub-8-bit non-indexed samples, which arrive still packed', () => {
    const s = img([
      ['Width', 8], ['Height', 1], ['BitsPerComponent', 4],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(new Uint8Array(12))));
    const r = grayscaleImage(s, (o) => o as never,
      (st) => new Uint8Array(inflateSync(st.raw)), {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/BitsPerComponent/);
  });

  it('reports a decode that produces the wrong number of samples', () => {
    const s = img([
      ['Width', 4], ['Height', 4], ['BitsPerComponent', 8],
      ['ColorSpace', name('DeviceRGB')], ['Filter', name('FlateDecode')],
    ], new Uint8Array(deflateSync(new Uint8Array(3))));
    const r = grayscaleImage(s, (o) => o as never,
      (st) => new Uint8Array(inflateSync(st.raw)), {});
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/expected/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayimage.test.ts`
Expected: FAIL — the four new tests report `skip` with `route not implemented for DeviceRGB`.

- [ ] **Step 3: Add the two sample routes**

Add to `src/grayimage.ts`:

```ts
import { decodeJpeg } from './jpeg.js';
import { encodeJpeg, type JpegKind } from './jpegencode.js';
import { encodeStream } from './filters.js';
```

```ts
const CHANNELS: Record<JpegKind, number> = { gray: 1, rgb: 3, cmyk: 4 };

const DCT_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'DCT']);
const SAMPLE_FILTERS: ReadonlySet<string> = new Set([
  'FlateDecode', 'Fl', 'LZWDecode', 'LZW', 'RunLengthDecode', 'RL', 'JPXDecode',
]);

/** Terminal (codec) filter of a chain: the last entry, or the single name. */
function terminalFilter(resolve: Resolve, dict: PdfDict): string | undefined {
  const f = resolve(dict.get('Filter'));
  if (isName(f)) return f.name;
  if (isArray(f) && f.length > 0) return nm(resolve, f[f.length - 1]);
  return undefined;
}

/** The JpegKind a colour space implies, or a reason it has none. */
function kindOf(resolve: Resolve, cs: PdfObject | undefined): JpegKind | { reason: string } {
  const head = csHead(resolve, cs);
  switch (head) {
    case 'DeviceGray': case 'CalGray': case 'G': return 'gray';
    case 'DeviceRGB': case 'CalRGB': case 'RGB': return 'rgb';
    case 'DeviceCMYK': case 'CMYK': return 'cmyk';
    case 'ICCBased': {
      const arr = resolve(cs);
      const s = isArray(arr) ? resolve(arr[1]) : undefined;
      const n = isStream(s) ? resolve(s.dict.get('N')) : undefined;
      if (n === 1) return 'gray';
      if (n === 3) return 'rgb';
      if (n === 4) return 'cmyk';
      return { reason: `ICCBased with unsupported /N ${String(n)}` };
    }
    default: return { reason: `unsupported colourspace: ${head || '(absent)'}` };
  }
}

/** Interleaved samples -> one grey byte per pixel, through the one rule. */
function greySamples(src: Uint8Array, pixels: number, kind: JpegKind): Uint8Array {
  const nc = CHANNELS[kind];
  const out = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const o = i * nc;
    if (kind === 'gray') { out[i] = src[o] ?? 0; continue; }
    if (kind === 'rgb') {
      out[i] = Math.round(luma((src[o] ?? 0) / 255, (src[o + 1] ?? 0) / 255,
                               (src[o + 2] ?? 0) / 255) * 255);
      continue;
    }
    const c = (src[o] ?? 0) / 255, m = (src[o + 1] ?? 0) / 255;
    const y = (src[o + 2] ?? 0) / 255, k = (src[o + 3] ?? 0) / 255;
    out[i] = Math.round(
      luma((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)) * 255);
  }
  return out;
}

/**
 * The replacement dict: copy the original, then override only what changed.
 *
 * A denylist, not an allowlist -- `imageopt.ts`'s rule, for its reason.
 * Synthesizing a fresh dict from what this converter knows would silently drop
 * /SMask, /OC, /Intent and /Metadata, and an image that loses its /SMask
 * renders its transparent background black with no error raised anywhere.
 */
function rebuild(
  original: PdfStream, raw: Uint8Array, filter: 'DCTDecode' | 'FlateDecode',
): PdfStream {
  const dict: PdfDict = new Map(original.dict);
  dict.delete('DecodeParms');
  dict.delete('DP');
  dict.delete('Decode');                       // the guard means there was none
  dict.set('ColorSpace', name('DeviceGray'));
  dict.set('BitsPerComponent', 8);
  dict.set('Filter', name(filter));
  dict.set('Length', raw.length);
  return { kind: 'stream', dict, raw };
}
```

Then extend `grayscaleImage`, replacing the final `return { kind: 'skip', reason: ... }` with:

```ts
  const bpc = resolve(dict.get('BitsPerComponent'));
  if (bpc !== 8) {
    return { kind: 'skip',
      reason: `BitsPerComponent ${String(bpc ?? '(absent)')} is not 8 and the `
        + 'space is not Indexed, so the samples arrive still packed' };
  }

  const kind = kindOf(resolve, cs);
  if (typeof kind !== 'string') return { kind: 'skip', reason: kind.reason };

  const w = resolve(dict.get('Width'));
  const h = resolve(dict.get('Height'));
  if (typeof w !== 'number' || typeof h !== 'number' || w < 1 || h < 1) {
    return { kind: 'skip', reason: 'missing or invalid /Width or /Height' };
  }

  const filter = terminalFilter(resolve, dict);
  const isDct = filter !== undefined && DCT_FILTERS.has(filter);
  if (!isDct && (filter === undefined || !SAMPLE_FILTERS.has(filter))) {
    return { kind: 'skip', reason: `unsupported filter ${filter ?? '(none)'}` };
  }

  let src: Uint8Array;
  try {
    if (isDct) {
      const j = decodeJpeg(inflate(stream));
      if (j.width !== w || j.height !== h) {
        return { kind: 'skip',
          reason: `JPEG geometry ${j.width}x${j.height} disagrees with the dict ${w}x${h}` };
      }
      if (j.comps !== CHANNELS[kind]) {
        return { kind: 'skip',
          reason: `JPEG has ${j.comps} components, colourspace implies ${CHANNELS[kind]}` };
      }
      src = j.data;
    } else {
      src = inflate(stream);
      const want = w * h * CHANNELS[kind];
      if (src.length !== want) {
        return { kind: 'skip', reason: `decoded ${src.length} bytes, expected ${want}` };
      }
    }
  } catch (e) {
    return { kind: 'skip', reason: `decode failed: ${(e as Error).message}` };
  }

  const grey = greySamples(src, w * h, kind);
  const from = csHead(resolve, cs);
  try {
    if (isDct) {
      const jpeg = encodeJpeg(w, h, grey, 'gray', { quality: opts.quality ?? 90 });
      return { kind: 'converted', stream: rebuild(stream, jpeg, 'DCTDecode'), from, route: 'jpeg' };
    }
    const flate = encodeStream(grey, 'FlateDecode');
    return { kind: 'converted', stream: rebuild(stream, flate.raw, 'FlateDecode'), from, route: 'flate' };
  } catch (e) {
    return { kind: 'skip', reason: `re-encode failed: ${(e as Error).message}` };
  }
```

Delete the now-unused `void opts;` line and the `grayPalette` helper (superseded by the converter-driven loop in `convertIndexed`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayimage.test.ts && npm run typecheck`
Expected: PASS, 11 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/grayimage.ts test/grayimage.test.ts
git commit -m "feat(10u9.1): grey DCT images as grey JPEG and sample images as Flate"
```

---

### Task 6: Wire images into `grayconvert.ts`

**Files:**
- Modify: `src/grayconvert.ts`
- Modify: `test/helpers/build-grayscale-pdf.ts` (add an image-bearing fixture)
- Modify: `test/grayscale-convert.test.ts`

**Interfaces:**
- Consumes: `grayscaleImage`, `GrayImageOutcome` (Tasks 4–5).
- Produces: `report.images`, `report.lossy`, `report.skipped` entries with `what: 'image'`.

- [ ] **Step 1: Write the failing test**

Add to `test/helpers/build-grayscale-pdf.ts`:

```ts
import { deflateSync } from 'node:zlib';
import { encodeJpeg } from '../../src/jpegencode.js';

/** A page drawing one RGB Flate image and one RGB JPEG image. */
export function buildGrayscaleImagePdf(): Uint8Array {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);
  const flate = new Uint8Array(deflateSync(rgb));
  const jw = 8, jh = 8;
  const jrgb = new Uint8Array(jw * jh * 3);
  for (let i = 0; i < jw * jh; i++) { jrgb[i * 3] = 255; }
  const jpeg = encodeJpeg(jw, jh, jrgb, 'rgb', { quality: 90 });
  const content = 'q 50 0 0 50 0 0 cm /Im0 Do Q q 50 0 0 50 60 0 cm /Im1 Do Q';

  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /XObject << /Im0 5 0 R /Im1 6 0 R >> >> /Contents 4 0 R >>',
    { dict: `<< /Length ${content.length} >>`, raw: new TextEncoder().encode(content) },
    { dict: '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 '
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode '
        + `/Length ${flate.length} >>`, raw: flate },
    { dict: `<< /Type /XObject /Subtype /Image /Width ${jw} /Height ${jh} `
        + '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
        + `/Length ${jpeg.length} >>`, raw: jpeg },
  ]);
}
```

Add to `test/grayscale-convert.test.ts`:

```ts
import { buildGrayscaleImagePdf } from './helpers/build-grayscale-pdf.js';
import { name } from '../src/types.js';

describe('Document.ConvertToGrayscale — images', () => {
  it('converts both image XObjects and reports each route', () => {
    const doc = Document.Open(buildGrayscaleImagePdf());
    const report = doc.ConvertToGrayscale();

    expect(report.images).toHaveLength(2);
    expect(report.images.map((i) => i.route).sort()).toEqual(['flate', 'jpeg']);
    for (const i of report.images) expect(i.from).toBe('DeviceRGB');
    // A JPEG re-encode happened, so the output is no longer a lossless greying.
    expect(report.lossy).toBe(true);
    expect(report.skipped).toEqual([]);
  });

  it('leaves every image XObject in DeviceGray', () => {
    const doc = Document.Open(buildGrayscaleImagePdf());
    doc.ConvertToGrayscale();
    const saved = Document.Open(doc.Save());
    let images = 0;
    for (const [, obj] of saved.objectEntries()) {
      if (!isStream(obj)) continue;
      const st = saved.resolve(obj.dict.get('Subtype'));
      if (!st || !('name' in st) || st.name !== 'Image') continue;
      images++;
      expect(obj.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    }
    expect(images).toBe(2);
  });

  it('is not lossy when no JPEG was re-encoded', () => {
    const doc = Document.Open(buildGrayscalePdf());
    expect(doc.ConvertToGrayscale().lossy).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayscale-convert.test.ts`
Expected: FAIL — `report.images` is `[]`.

- [ ] **Step 3: Add the image pass to `src/grayconvert.ts`**

```ts
import { grayscaleImage } from './grayimage.js';
```

```ts
/**
 * Convert every image XObject once, keyed by object number.
 *
 * Walks the whole object map rather than the page resources: an image reached
 * through three placements, or from inside a form XObject, is one object and
 * must convert once. `replaceObject` installs at the same number so every
 * referrer follows untouched -- `imageopt.ts`'s rule.
 */
function convertImages(
  doc: Document, report: GrayscaleReport, opts: GrayscaleOptions,
): void {
  const resolve = (o: PdfObject | undefined): PdfObject => doc.resolve(o);
  const inflate = (s: PdfStream): Uint8Array => inflateStream(s);

  const targets: Array<[number, PdfStream]> = [];
  for (const [ref, obj] of doc.objectEntries()) {
    if (!isStream(obj)) continue;
    const sub = doc.resolve(obj.dict.get('Subtype'));
    if (isName(sub) && sub.name === 'Image') targets.push([ref.num, obj]);
  }

  for (const [objNum, stream] of targets) {
    const r = grayscaleImage(stream, resolve, inflate, { quality: opts.quality });
    if (r.kind === 'none') continue;
    if (r.kind === 'skip') {
      report.skipped.push({ objNum, what: 'image', reason: r.reason });
      continue;
    }
    convertMatte(doc, r.stream, resolve, inflate);
    doc.replaceObject(objNum, r.stream);
    const bytesDelta = r.stream.raw.length - stream.raw.length;
    report.images.push({ objNum, from: r.from, route: r.route, bytesDelta });
    report.bytesDelta += bytesDelta;
    if (r.route === 'jpeg') report.lossy = true;
  }
}

/** An /SMask's /Matte is an array in the PARENT image's colour space, so it
 *  greys alongside the parent. The /SMask stream itself is DeviceGray by
 *  specification and is left alone. */
function convertMatte(
  doc: Document, image: PdfStream, resolve: Resolve, inflate: Inflate,
): void {
  const sm = doc.resolve(image.dict.get('SMask'));
  if (!isStream(sm)) return;
  const matte = doc.resolve(sm.dict.get('Matte'));
  if (!isArray(matte) || matte.length <= 1) return;
  const comps = matte.filter((v): v is number => typeof v === 'number');
  if (comps.length === 0) return;
  void resolve; void inflate;
  sm.dict.set('Matte', [grayNum(grayOf(comps, baseSpace(doc, image.dict.get('ColorSpace'))))]);
}
```

Add to the imports at the top of `grayconvert.ts`:

```ts
import { grayNum, grayOf } from './grayscale.js';
import type { Resolve, Inflate } from './grayimage.js';
```

and call it from `convertToGrayscale`, before `convertContent`:

```ts
  convertImages(doc, report, opts);
  convertContent(doc, report);
```

Delete the `void opts;` placeholder line.

Note: `convertMatte` reads the image's **original** `/ColorSpace` — call it with the pre-conversion stream. Change the call to:

```ts
    convertMatte(doc, stream, resolve, inflate);   // the ORIGINAL, not r.stream
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayscale-convert.test.ts && npm run typecheck`
Expected: PASS, 8 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/grayconvert.ts test/helpers/build-grayscale-pdf.ts test/grayscale-convert.test.ts
git commit -m "feat(10u9.1): convert image XObjects and an /SMask /Matte"
```

---

### Task 7: `grayshading.ts` — shadings and functions

**Files:**
- Create: `src/grayshading.ts`
- Test: `test/grayshading.test.ts`

**Interfaces:**
- Consumes: `parseFunction` from `src/pdffunction.ts`; `grayOf`, `grayNum`, `luma` (Task 1); `Resolve`, `Inflate` (Task 4).
- Produces:
  - `type ShadingOutcome = { kind: 'converted'; dict: PdfDict } | { kind: 'none' } | { kind: 'skip'; reason: string }`
  - `grayscaleShading(dict: PdfDict, resolve: Resolve, inflate: Inflate): ShadingOutcome`
  - `grayscaleFunction(fn: PdfObject, resolve: Resolve, inflate: Inflate, inputs: number): PdfObject`

- [ ] **Step 1: Write the failing test**

Create `test/grayshading.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { grayscaleShading, grayscaleFunction } from '../src/grayshading.js';
import { parseFunction } from '../src/pdffunction.js';
import { PdfDict, PdfObject, PdfStream, isStream, name } from '../src/types.js';
import { luma } from '../src/grayscale.js';

const resolve = (o: PdfObject | undefined): PdfObject => o as PdfObject;
const inflate = (s: PdfStream): Uint8Array => s.raw;

const d = (entries: [string, PdfObject][]): PdfDict =>
  new Map<string, PdfObject>(entries) as PdfDict;

describe('grayscaleFunction — type 2 converts exactly', () => {
  it('maps /C0 and /C1 through luma and keeps /N', () => {
    const fn = d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
      ['C0', [1, 0, 0]], ['C1', [0, 0, 1]],
    ]);
    const out = grayscaleFunction(fn, resolve, inflate, 1) as PdfDict;
    expect(out.get('FunctionType')).toBe(2);
    expect(out.get('N')).toBe(1);
    expect(out.get('C0')).toEqual([0.299]);
    expect(out.get('C1')).toEqual([0.114]);
  });
});

describe('grayscaleFunction — type 3 recurses', () => {
  it('converts each sub-function and leaves /Bounds and /Encode alone', () => {
    const sub = (c0: number[], c1: number[]): PdfDict => d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1], ['C0', c0], ['C1', c1],
    ]);
    const fn = d([
      ['FunctionType', 3], ['Domain', [0, 1]],
      ['Functions', [sub([1, 0, 0], [0, 1, 0]), sub([0, 1, 0], [0, 0, 1])]],
      ['Bounds', [0.5]], ['Encode', [0, 1, 0, 1]],
    ]);
    const out = grayscaleFunction(fn, resolve, inflate, 1) as PdfDict;
    expect(out.get('Bounds')).toEqual([0.5]);
    expect(out.get('Encode')).toEqual([0, 1, 0, 1]);
    const fns = out.get('Functions') as PdfDict[];
    expect(fns[0].get('C0')).toEqual([0.299]);
    expect(fns[1].get('C1')).toEqual([0.114]);
  });
});

describe('grayscaleFunction — resampling', () => {
  // The oracle is OUTSIDE the conversion: evaluate the converted function and
  // compare against the luma of the ORIGINAL's output. Asserting the emitted
  // dict would only prove the writer agrees with itself.
  const sampleAgrees = (
    original: PdfObject, converted: PdfObject, at: number[][],
  ): void => {
    const before = parseFunction(original, resolve, inflate);
    const after = parseFunction(converted, resolve, inflate);
    for (const x of at) {
      const rgb = before(x);
      const want = luma(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0);
      expect(after(x)[0]).toBeCloseTo(want, 2);
    }
  };

  it('resamples a type 4 PostScript function into a 1-output sampled function', () => {
    const src = '{ dup 1 exch sub 0 }';       // t -> (t, 1-t, 0)
    const fn: PdfStream = {
      kind: 'stream',
      dict: d([
        ['FunctionType', 4], ['Domain', [0, 1]], ['Range', [0, 1, 0, 1, 0, 1]],
        ['Length', src.length],
      ]),
      raw: new TextEncoder().encode(src),
    };
    const out = grayscaleFunction(fn, resolve, inflate, 1);
    expect(isStream(out)).toBe(true);
    if (!isStream(out)) return;
    expect(out.dict.get('FunctionType')).toBe(0);
    expect(out.dict.get('Range')).toEqual([0, 1]);
    expect(out.dict.get('Size')).toEqual([256]);
    expect(out.dict.get('BitsPerSample')).toBe(8);
    sampleAgrees(fn, out, [[0], [0.25], [0.5], [0.75], [1]]);
  });

  it('samples a two-input function on a grid, not a line', () => {
    // ShadingType 1 takes a 2-in function. A resampler that assumes one input
    // emits a flat wash -- plausible output nobody looks at closely.
    const src = '{ exch dup 3 1 roll 0 }';    // (x,y) -> (y, x, 0), roughly
    const fn: PdfStream = {
      kind: 'stream',
      dict: d([
        ['FunctionType', 4], ['Domain', [0, 1, 0, 1]], ['Range', [0, 1, 0, 1, 0, 1]],
        ['Length', src.length],
      ]),
      raw: new TextEncoder().encode(src),
    };
    const out = grayscaleFunction(fn, resolve, inflate, 2);
    if (!isStream(out)) throw new Error('expected a sampled function');
    expect(out.dict.get('Size')).toEqual([64, 64]);
    expect(out.dict.get('Domain')).toEqual([0, 1, 0, 1]);
    expect(out.raw.length).toBe(64 * 64);
  });

  it('joins an array of one-output functions into a single function', () => {
    const chan = (v: number): PdfDict => d([
      ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1], ['C0', [0]], ['C1', [v]],
    ]);
    const arr: PdfObject = [chan(1), chan(0), chan(0)];   // t -> (t, 0, 0)
    const out = grayscaleFunction(arr, resolve, inflate, 1);
    expect(Array.isArray(out)).toBe(false);
    const after = parseFunction(out, resolve, inflate);
    expect(after([1])[0]).toBeCloseTo(0.299, 2);
    expect(after([0])[0]).toBeCloseTo(0, 2);
  });
});

describe('grayscaleShading', () => {
  it('retargets /ColorSpace, greys /Background and converts /Function', () => {
    const sh = d([
      ['ShadingType', 2], ['ColorSpace', name('DeviceRGB')],
      ['Coords', [0, 0, 100, 0]], ['Background', [1, 0, 0]],
      ['Function', d([
        ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
        ['C0', [1, 0, 0]], ['C1', [0, 0, 1]],
      ])],
    ]);
    const r = grayscaleShading(sh, resolve, inflate);
    expect(r.kind).toBe('converted');
    if (r.kind !== 'converted') return;
    expect(r.dict.get('ColorSpace')).toEqual(name('DeviceGray'));
    expect(r.dict.get('Background')).toEqual([0.299]);
    expect((r.dict.get('Function') as PdfDict).get('C0')).toEqual([0.299]);
  });

  it('reports none for a shading already in DeviceGray', () => {
    const sh = d([['ShadingType', 2], ['ColorSpace', name('DeviceGray')]]);
    expect(grayscaleShading(sh, resolve, inflate).kind).toBe('none');
  });

  it('skips a function-less mesh, whose colour is bit-packed in the data', () => {
    const sh = d([
      ['ShadingType', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerCoordinate', 16], ['BitsPerComponent', 8], ['BitsPerFlag', 8],
    ]);
    const r = grayscaleShading(sh, resolve, inflate);
    expect(r.kind).toBe('skip');
    if (r.kind !== 'skip') return;
    expect(r.reason).toMatch(/mesh/i);
  });

  it('converts a mesh that DOES carry a /Function', () => {
    const sh = d([
      ['ShadingType', 4], ['ColorSpace', name('DeviceRGB')],
      ['BitsPerCoordinate', 16], ['BitsPerComponent', 8], ['BitsPerFlag', 8],
      ['Function', d([
        ['FunctionType', 2], ['Domain', [0, 1]], ['N', 1],
        ['C0', [1, 0, 0]], ['C1', [0, 1, 0]],
      ])],
    ]);
    expect(grayscaleShading(sh, resolve, inflate).kind).toBe('converted');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayshading.test.ts`
Expected: FAIL — `Failed to resolve import "../src/grayshading.js"`.

- [ ] **Step 3: Write `src/grayshading.ts`**

```ts
import {
  PdfDict, PdfObject, PdfStream, isArray, isDict, isName, isStream, name,
} from './types.js';
import { parseFunction } from './pdffunction.js';
import { resolveColorSpace } from './colorspace.js';
import { grayNum, luma } from './grayscale.js';
import type { Resolve, Inflate } from './grayimage.js';

export type ShadingOutcome =
  | { kind: 'converted'; dict: PdfDict }
  | { kind: 'none' }
  | { kind: 'skip'; reason: string };

/** Samples per axis. One input is a gradient ramp; two is a function-based
 *  shading's Domain rectangle, where 256x256 would be 64KB for no visible gain. */
const SAMPLES_1D = 256;
const SAMPLES_2D = 64;

const numbers = (o: PdfObject | undefined): number[] =>
  isArray(o) ? o.filter((v): v is number => typeof v === 'number') : [];

/** The luma of one colour stated in `space`, via the one owner of that rule. */
function greyComponent(
  comps: number[], space: PdfObject | undefined, resolve: Resolve, inflate: Inflate,
): number {
  const converter = resolveColorSpace(
    resolve(space), resolve, (s) => inflate(s as PdfStream));
  const [r, g, b] = converter.toRgb(comps);
  return grayNum(luma(r / 255, g / 255, b / 255));
}

/**
 * Convert a function's colour output to a single grey component.
 *
 * Exact where exactness is free -- type 2 through /C0 and /C1, type 3 by
 * recursion -- and resampled otherwise. `inputs` is the function's input arity:
 * 1 for shading types 2-7, 2 for a type 1 (function-based) shading. Assuming 1
 * for a 2-in function emits a flat grey wash, which renders as a plausible
 * design choice rather than as a fault.
 */
export function grayscaleFunction(
  fn: PdfObject, resolve: Resolve, inflate: Inflate, inputs: number,
  space?: PdfObject,
): PdfObject {
  // An ARRAY of n one-output functions is not a recursion case but a joining
  // case: the whole array describes one colour, so it collapses to one function.
  if (isArray(fn)) return resample(fn, resolve, inflate, inputs, space);

  const r = resolve(fn);
  const dict = isStream(r) ? r.dict : isDict(r) ? r : undefined;
  if (!dict) return fn;
  const type = resolve(dict.get('FunctionType'));

  if (type === 2) {
    const out: PdfDict = new Map(dict);
    for (const key of ['C0', 'C1'] as const) {
      const c = numbers(resolve(dict.get(key)));
      const comps = c.length > 0 ? c : (key === 'C0' ? [0] : [1]);
      out.set(key, [greyComponent(comps, space, resolve, inflate)]);
    }
    return out;
  }

  if (type === 3) {
    const subs = resolve(dict.get('Functions'));
    if (!isArray(subs)) return resample(fn, resolve, inflate, inputs, space);
    const out: PdfDict = new Map(dict);
    out.set('Functions',
      subs.map((s) => grayscaleFunction(s, resolve, inflate, inputs, space)));
    return out;
  }

  return resample(fn, resolve, inflate, inputs, space);
}

/** Evaluate any function (or array of them) and emit a 1-output type 0. */
function resample(
  fn: PdfObject, resolve: Resolve, inflate: Inflate, inputs: number,
  space: PdfObject | undefined,
): PdfObject {
  const inflateFn = (s: { dict: PdfDict; raw: Uint8Array }): Uint8Array =>
    inflate(s as PdfStream);

  // An array of n one-output functions evaluates as one n-output function.
  const evalAt: (x: number[]) => number[] = isArray(fn)
    ? (() => {
        const parts = fn.map((f) => parseFunction(f, resolve, inflateFn));
        return (x: number[]) => parts.map((p) => p(x)[0] ?? 0);
      })()
    : parseFunction(fn, resolve, inflateFn);

  const src = resolve(fn);
  const srcDict = isStream(src) ? src.dict : isDict(src) ? src : undefined;
  const domain = numbers(srcDict ? resolve(srcDict.get('Domain')) : undefined);
  const dom = domain.length >= inputs * 2 ? domain
    : Array.from({ length: inputs * 2 }, (_, i) => (i % 2 === 0 ? 0 : 1));

  const size = inputs === 1 ? [SAMPLES_1D] : new Array(inputs).fill(SAMPLES_2D);
  const total = size.reduce((a, b) => a * b, 1);
  const raw = new Uint8Array(total);

  const converter = resolveColorSpace(
    resolve(space), resolve, (s) => inflate(s as PdfStream));

  // Sample index -> input coordinates. The FIRST input varies fastest, which is
  // 32000-1 7.10.2's ordering for a type 0 sample table.
  for (let i = 0; i < total; i++) {
    const x: number[] = [];
    let rest = i;
    for (let k = 0; k < inputs; k++) {
      const n = size[k];
      const j = rest % n;
      rest = Math.floor(rest / n);
      const lo = dom[k * 2] ?? 0, hi = dom[k * 2 + 1] ?? 1;
      x.push(lo + (hi - lo) * (n === 1 ? 0 : j / (n - 1)));
    }
    const out = evalAt(x);
    const [r, g, b] = converter.toRgb(out);
    raw[i] = Math.round(luma(r / 255, g / 255, b / 255) * 255);
  }

  const dict: PdfDict = new Map<string, PdfObject>([
    ['FunctionType', 0],
    ['Domain', dom],
    ['Range', [0, 1]],
    ['Size', size],
    ['BitsPerSample', 8],
    ['Length', raw.length],
  ]);
  return { kind: 'stream', dict, raw };
}

/** True when the space already delivers a single grey component. */
function alreadyGray(resolve: Resolve, cs: PdfObject | undefined): boolean {
  const r = resolve(cs);
  if (isName(r)) return r.name === 'DeviceGray' || r.name === 'CalGray' || r.name === 'G';
  if (isArray(r) && r.length > 0) {
    const head = resolve(r[0]);
    if (isName(head) && head.name === 'CalGray') return true;
    if (isName(head) && head.name === 'ICCBased') {
      const s = resolve(r[1]);
      return isStream(s) && resolve(s.dict.get('N')) === 1;
    }
  }
  return false;
}

/** Convert one shading dict to DeviceGray. */
export function grayscaleShading(
  dict: PdfDict, resolve: Resolve, inflate: Inflate,
): ShadingOutcome {
  const cs = dict.get('ColorSpace');
  if (cs === undefined) return { kind: 'skip', reason: 'shading has no /ColorSpace' };
  if (alreadyGray(resolve, cs)) return { kind: 'none' };

  const type = resolve(dict.get('ShadingType'));
  const fn = dict.get('Function');

  if (typeof type === 'number' && type >= 4 && fn === undefined) {
    return { kind: 'skip',
      reason: `mesh shading type ${type} without a /Function: per-vertex colour `
        + 'is bit-packed in the stream data' };
  }

  const out: PdfDict = new Map(dict);
  out.set('ColorSpace', name('DeviceGray'));

  const bg = numbers(resolve(dict.get('Background')));
  if (bg.length > 0) out.set('Background', [greyComponent(bg, cs, resolve, inflate)]);

  if (fn !== undefined) {
    const inputs = type === 1 ? 2 : 1;
    out.set('Function', grayscaleFunction(fn, resolve, inflate, inputs, cs));
  }
  return { kind: 'converted', dict: out };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayshading.test.ts && npm run typecheck`
Expected: PASS, 9 tests. Typecheck clean.

If the two PostScript sources in the test do not produce the intended
3-component output, adjust them until `parseFunction(fn, …)([0.5])` returns a
3-element array — the assertion is against the *original's* own output, so any
valid 3-output program works.

- [ ] **Step 5: Commit**

```bash
git add src/grayshading.ts test/grayshading.test.ts
git commit -m "feat(10u9.1): grey shadings, exact for type 2/3 and resampled otherwise"
```

---

### Task 8: Wire shadings into `grayconvert.ts`

**Files:**
- Modify: `src/grayconvert.ts`
- Modify: `test/helpers/build-grayscale-pdf.ts`
- Modify: `test/grayscale-convert.test.ts`

**Interfaces:**
- Consumes: `grayscaleShading` (Task 7).
- Produces: `report.shadings`, `skipped` entries with `what: 'shading'`.

A shading is reachable two ways — `/Resources /Shading` (for `sh`) and a shading
pattern's `/Shading` (`/PatternType 2`). Both are walked; dedup is by the dict's
identity, since a shading is frequently a *direct* dict with no object number.

- [ ] **Step 1: Write the failing test**

Add to `test/helpers/build-grayscale-pdf.ts`:

```ts
/** A page painting an axial shading via `sh` and a shading pattern via scn. */
export function buildGrayscaleShadingPdf(): Uint8Array {
  const content = 'q 0 0 100 100 re W n /Sh0 sh Q '
    + 'q /Pattern cs /P1 scn 100 0 100 100 re f Q';
  const fn = '<< /FunctionType 2 /Domain [0 1] /N 1 /C0 [1 0 0] /C1 [0 0 1] >>';
  return assemble([
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] '
      + '/Resources << /Shading << /Sh0 5 0 R >> /Pattern << /P1 6 0 R >> >> '
      + '/Contents 4 0 R >>',
    { dict: `<< /Length ${content.length} >>`, raw: new TextEncoder().encode(content) },
    `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function ${fn} >>`,
    `<< /PatternType 2 /Shading << /ShadingType 3 /ColorSpace /DeviceRGB `
      + `/Coords [50 50 0 50 50 40] /Function ${fn} >> >>`,
  ]);
}
```

Add to `test/grayscale-convert.test.ts`:

```ts
import { buildGrayscaleShadingPdf } from './helpers/build-grayscale-pdf.js';

describe('Document.ConvertToGrayscale — shadings', () => {
  it('converts a /Shading resource and a shading pattern alike', () => {
    const doc = Document.Open(buildGrayscaleShadingPdf());
    const report = doc.ConvertToGrayscale();
    expect(report.shadings).toBe(2);
    expect(report.skipped).toEqual([]);

    const text = new TextDecoder().decode(doc.Save());
    expect(text).not.toContain('/DeviceRGB');
    expect(text).toContain('/DeviceGray');
    expect(text).toContain('/C0 [0.299]');
    expect(text).toContain('/C1 [0.114]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayscale-convert.test.ts`
Expected: FAIL — `expected 0 to be 2`.

- [ ] **Step 3: Add the shading pass**

Add to `src/grayconvert.ts`:

```ts
import { grayscaleShading } from './grayshading.js';
```

```ts
/**
 * Convert every shading, reached from `/Resources /Shading` and from a shading
 * pattern's `/Shading`.
 *
 * Deduped by dict identity rather than object number: a shading is very often a
 * DIRECT dict inside a pattern, so it has no object number to key on. A direct
 * dict is mutated in place; an indirect one is replaced at its own number.
 */
function convertShadings(doc: Document, report: GrayscaleReport): void {
  const resolve = (o: PdfObject | undefined): PdfObject => doc.resolve(o);
  const inflate = (s: PdfStream): Uint8Array => inflateStream(s);
  const seen = new Set<PdfDict>();

  const convert = (holder: PdfDict, key: string): void => {
    const entry = holder.get(key);
    const target = doc.resolve(entry);
    const dict = isStream(target) ? target.dict : isDict(target) ? target : undefined;
    if (!dict || seen.has(dict)) return;
    seen.add(dict);

    const r = grayscaleShading(dict, resolve, inflate);
    if (r.kind === 'none') return;
    if (r.kind === 'skip') {
      report.skipped.push({ objNum: refNum(entry), what: 'shading', reason: r.reason });
      return;
    }
    // Write through whichever container actually holds it.
    if (isStream(target)) {
      const num = refNum(entry);
      const replaced: PdfStream = { kind: 'stream', dict: r.dict, raw: target.raw };
      if (num !== undefined) doc.replaceObject(num, replaced);
      else holder.set(key, replaced);
    } else {
      const num = refNum(entry);
      if (num !== undefined) doc.replaceObject(num, r.dict);
      else holder.set(key, r.dict);
    }
    report.shadings++;
  };

  for (const [, obj] of doc.objectEntries()) {
    const dict = isStream(obj) ? obj.dict : isDict(obj) ? obj : undefined;
    if (!dict) continue;
    // A shading pattern holds its shading under /Shading.
    if (doc.resolve(dict.get('PatternType')) === 2) convert(dict, 'Shading');
    // ExtGState soft masks and resource dicts hold a /Shading sub-dict.
    const shDict = dictOf(doc, dict.get('Shading'));
    if (shDict && doc.resolve(dict.get('PatternType')) !== 2) {
      for (const [k] of shDict) convert(shDict, k);
    }
  }
}
```

Call it from `convertToGrayscale`, after `convertImages` and before `convertContent`:

```ts
  convertImages(doc, report, opts);
  convertShadings(doc, report);
  convertContent(doc, report);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayscale-convert.test.ts && npm run typecheck`
Expected: PASS, 9 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/grayconvert.ts test/helpers/build-grayscale-pdf.ts test/grayscale-convert.test.ts
git commit -m "feat(10u9.1): convert /Shading resources and shading patterns"
```

---

### Task 9: Annotation colour — `/C`, `/IC`, `/MK`, `/DA`

**Files:**
- Modify: `src/grayconvert.ts`
- Modify: `test/grayscale-convert.test.ts`

**Interfaces:**
- Consumes: `grayscaleOps` (Task 2) — a `/DA` is a content-stream fragment and goes through the *same* rewriter, not through `parseDA`.
- Produces: `report.annotations`, `skipped` entries with `what: 'annotation'`.

- [ ] **Step 1: Write the failing test**

Add to `test/grayscale-convert.test.ts`:

```ts
describe('Document.ConvertToGrayscale — annotations', () => {
  it('greys /C and /IC', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const report = doc.ConvertToGrayscale();
    const annot = doc.Pages[0].Annotations[0];
    expect(annot.Dict.get('C')).toEqual([0.299]);
    expect(annot.Dict.get('IC')).toEqual([0.114]);
    expect(report.annotations).toBe(1);
  });

  it('leaves an empty /C empty rather than painting a black border', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const annot = doc.Pages[0].Annotations[0];
    annot.Dict.set('C', []);
    doc.ConvertToGrayscale();
    expect(annot.Dict.get('C')).toEqual([]);
  });

  it('rewrites a /DA through the content rewriter, keeping its other operators', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const annot = doc.Pages[0].Annotations[0];
    annot.Dict.set('DA', { kind: 'string', bytes: new TextEncoder().encode('/Helv 12 Tf 1 0 0 rg') });
    doc.ConvertToGrayscale();
    const da = new TextDecoder().decode(
      (annot.Dict.get('DA') as { bytes: Uint8Array }).bytes);
    expect(da).toContain('/Helv 12 Tf');   // parseDA would have kept only this
    expect(da).toContain('0.299 g');
    expect(da).not.toContain('rg');
  });

  it('greys a widget /MK /BG and /BC', () => {
    const doc = Document.Open(buildGrayscalePdf());
    const annot = doc.Pages[0].Annotations[0];
    annot.Dict.set('MK', new Map<string, unknown>([
      ['BG', [0, 1, 0]], ['BC', [0, 0, 1]],
    ]) as never);
    doc.ConvertToGrayscale();
    const mk = annot.Dict.get('MK') as Map<string, unknown>;
    expect(mk.get('BG')).toEqual([0.587]);
    expect(mk.get('BC')).toEqual([0.114]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayscale-convert.test.ts`
Expected: FAIL — `/C` is still `[1, 0, 0]`.

- [ ] **Step 3: Add the annotation pass**

Add to `src/grayconvert.ts`:

```ts
import { isString } from './types.js';
```

```ts
/** Collapse a 1-, 3- or 4-component colour array to one grey component.
 *  An EMPTY array is legal and means *no colour* -- it must stay empty, or a
 *  border appears where the document asked for none. */
function greyColorArray(doc: Document, holder: PdfDict, key: string): boolean {
  const arr = doc.resolve(holder.get(key));
  if (!isArray(arr) || arr.length === 0) return false;
  const comps = arr.filter((v): v is number => typeof v === 'number');
  if (comps.length === 0) return false;
  if (comps.length === 1) return false;                 // already one component
  const space: GraySpace = comps.length === 4 ? { kind: 'cmyk' } : { kind: 'rgb' };
  holder.set(key, [grayNum(grayOf(comps, space))]);
  return true;
}

/** Rewrite a `/DA` string through the CONTENT rewriter.
 *  Not `parseDA`, which reduces a /DA to { fontName, size, color } and would
 *  drop every operator it does not recognise on re-emission. */
function greyDA(doc: Document, holder: PdfDict): boolean {
  const da = doc.resolve(holder.get('DA'));
  if (!isString(da)) return false;
  let ops;
  try { ops = parseContentStream(da.bytes); } catch { return false; }
  const r = grayscaleOps(ops, () => undefined);
  if (r.changed === 0) return false;
  const bytes = serializeContentStream(r.ops);
  // serializeContentStream ends each op with a newline; a /DA is a one-liner.
  const text = new TextDecoder().decode(bytes).replace(/\n/g, ' ').trim();
  holder.set('DA', { kind: 'string', bytes: new TextEncoder().encode(text) });
  return true;
}

/** Every annotation's own colour: /C, /IC, /MK /BG and /BC, and /DA.
 *  Appearance streams are already in the content enumeration, so a widget's
 *  drawn colour and its /MK cannot end up disagreeing. */
function convertAnnotations(doc: Document, report: GrayscaleReport): void {
  for (const page of doc.Pages) {
    const annots = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(annots)) continue;
    for (const a of annots) {
      const ad = dictOf(doc, a);
      if (!ad) continue;
      let touched = false;
      touched = greyColorArray(doc, ad, 'C') || touched;
      touched = greyColorArray(doc, ad, 'IC') || touched;
      touched = greyDA(doc, ad) || touched;
      const mk = dictOf(doc, ad.get('MK'));
      if (mk) {
        touched = greyColorArray(doc, mk, 'BG') || touched;
        touched = greyColorArray(doc, mk, 'BC') || touched;
      }
      if (touched) report.annotations++;
    }
  }

  // The form-wide default appearance gets the same treatment.
  const acro = dictOf(doc, doc.catalog().get('AcroForm'));
  if (acro) greyDA(doc, acro);
}
```

Call it from `convertToGrayscale`, after `convertContent`:

```ts
  convertImages(doc, report, opts);
  convertShadings(doc, report);
  convertContent(doc, report);
  convertAnnotations(doc, report);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayscale-convert.test.ts && npm run typecheck`
Expected: PASS, 13 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/grayconvert.ts test/grayscale-convert.test.ts
git commit -m "feat(10u9.1): grey annotation /C, /IC, /MK and /DA"
```

---

### Task 10: Inline images (`BI`)

The last content-side colour source. Kept last because it is the phase that could
grow: if the inline-image dict handling turns out to need more than the
abbreviated-key map below, stop, file it as its own issue under epic `10u9`, and
remove the inline image from the Task 11 oracle fixture **explicitly** — with a
comment saying why — rather than leaving it silently unconverted.

**Files:**
- Modify: `src/grayops.ts`
- Modify: `test/grayops.test.ts`

**Interfaces:**
- Consumes: `grayOf`, `grayNum` (Task 1).
- Produces: `grayscaleOps` now rewrites `BI` ops whose `inlineImage.dict` names a convertible space.

Inline-image dicts use abbreviated keys: `/CS` (`/ColorSpace`), `/BPC`
(`/BitsPerComponent`), `/F` (`/Filter`), `/D` (`/Decode`), `/IM` (`/ImageMask`),
`/W`, `/H`. Device space names abbreviate too: `/G`, `/RGB`, `/CMYK`, `/I`.

- [ ] **Step 1: Write the failing test**

Add to `test/grayops.test.ts`:

```ts
describe('grayscaleOps — inline images', () => {
  const bi = (dict: [string, unknown][], data: Uint8Array): ContentOp => ({
    operator: 'BI', operands: [],
    inlineImage: { dict: new Map(dict) as never, data },
  });

  it('greys unfiltered RGB samples and rewrites /CS and /BPC', () => {
    const op0 = bi([
      ['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8],
    ], new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]));

    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(1);
    const out = r.ops[0].inlineImage!;
    expect(out.dict.get('CS')).toEqual(name('G'));
    expect(out.dict.get('BPC')).toBe(8);
    expect([...out.data]).toEqual([76, 150, 29, 255]);
  });

  it('leaves an inline image mask alone', () => {
    const op0 = bi([['W', 8], ['H', 1], ['IM', true]], new Uint8Array([0xff]));
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(0);
    expect(r.ops[0]).toBe(op0);
  });

  it('leaves a filtered inline image alone rather than guessing at its bytes', () => {
    const op0 = bi([
      ['W', 2], ['H', 2], ['CS', name('RGB')], ['BPC', 8], ['F', name('Fl')],
    ], new Uint8Array([1, 2, 3]));
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(0);
  });

  it('leaves an already-grey inline image alone', () => {
    const op0 = bi([['W', 2], ['H', 2], ['CS', name('G')], ['BPC', 8]],
      new Uint8Array([1, 2, 3, 4]));
    const r = grayscaleOps([op0], () => undefined);
    expect(r.changed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grayops.test.ts`
Expected: FAIL — `expected 0 to be 1`.

- [ ] **Step 3: Implement the `BI` case in `src/grayops.ts`**

Add to the imports:

```ts
import { isName as isNm } from './types.js';
```

(the file already imports `isName`; reuse it — no second import is needed.)

Add before `grayscaleOps`:

```ts
/** Inline-image colour spaces, abbreviated and spelled out (32000-1 8.9.5.2). */
const INLINE_SPACE: Readonly<Record<string, { space: GraySpace; nc: number }>> = {
  G: { space: { kind: 'gray' }, nc: 1 },
  DeviceGray: { space: { kind: 'gray' }, nc: 1 },
  RGB: { space: { kind: 'rgb' }, nc: 3 },
  DeviceRGB: { space: { kind: 'rgb' }, nc: 3 },
  CMYK: { space: { kind: 'cmyk' }, nc: 4 },
  DeviceCMYK: { space: { kind: 'cmyk' }, nc: 4 },
};

/**
 * Grey an inline image's samples in place.
 *
 * Only unfiltered 8-bpc device colour is converted: an inline image's payload
 * lives in the content stream and in no object, so a filtered one would have to
 * be decoded and re-encoded here, in a module that deliberately imports no
 * codec. Everything else is returned untouched -- and stays visible to the
 * caller's report as content that did not convert.
 */
function grayInlineImage(op: ContentOp): ContentOp | undefined {
  const img = op.inlineImage;
  if (!img) return undefined;
  const d = img.dict;
  if (d.get('IM') === true || d.get('ImageMask') === true) return undefined;
  if (d.has('F') || d.has('Filter')) return undefined;
  if (d.has('D') || d.has('Decode')) return undefined;

  const bpc = d.get('BPC') ?? d.get('BitsPerComponent');
  if (bpc !== 8) return undefined;

  const csObj = d.get('CS') ?? d.get('ColorSpace');
  if (!isName(csObj)) return undefined;
  const entry = INLINE_SPACE[csObj.name];
  if (!entry || entry.nc === 1) return undefined;

  const w = d.get('W') ?? d.get('Width');
  const h = d.get('H') ?? d.get('Height');
  if (typeof w !== 'number' || typeof h !== 'number') return undefined;
  const pixels = w * h;
  if (img.data.length < pixels * entry.nc) return undefined;

  const out = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    const comps: number[] = [];
    for (let k = 0; k < entry.nc; k++) comps.push((img.data[i * entry.nc + k] ?? 0) / 255);
    out[i] = Math.round(grayOf(comps, entry.space) * 255);
  }

  const dict = new Map(d);
  dict.delete('ColorSpace');
  dict.set('CS', name('G'));
  dict.set('BPC', 8);
  if (dict.has('L')) dict.set('L', out.length);
  if (dict.has('Length')) dict.set('Length', out.length);
  return { ...op, inlineImage: { dict, data: out } };
}
```

Add the case to the switch in `grayscaleOps`, before `default`:

```ts
      case 'BI': {
        const converted = grayInlineImage(op);
        if (!converted) return op;
        changed++;
        return converted;
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grayops.test.ts && npm run typecheck`
Expected: PASS, 18 tests. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/grayops.ts test/grayops.test.ts
git commit -m "feat(10u9.1): grey unfiltered inline images in place"
```

---

### Task 11: The pixel oracle, mutation verification, README and CHANGELOG

The task that proves the whole thing. A missed content stream renders in colour
and leaves every structural assertion green; only a rendered-pixel check sees it.

**Files:**
- Create: `test/grayscale-render.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `test/helpers/build-grayscale-pdf.ts` (add the everything fixture)

**Interfaces:**
- Consumes: everything above; `decodePng` from `test/helpers/decode-png.ts`; `Page.ToImage`.

- [ ] **Step 1: Add the everything fixture**

Add to `test/helpers/build-grayscale-pdf.ts`:

```ts
/**
 * One page carrying colour in every place this feature converts: page content,
 * a named colour space, a Form XObject, a tiling pattern, a Type 3 glyph
 * procedure, an axial shading, a shading pattern, an RGB Flate image, an RGB
 * JPEG image, an unfiltered inline image, and an annotation with /C, /IC and a
 * drawn /AP. Everything is opaque and covers a known rectangle, so the render
 * can be swept pixel by pixel.
 */
export function buildEverythingColorPdf(): Uint8Array {
  // Compose from the pieces above; each draw is placed in its own 40x40 cell of
  // a 200x200 page so a failure names the construct that failed.
  // (Assemble exactly as buildGrayscalePdf does, adding the shading, image and
  // inline-image draws from buildGrayscaleShadingPdf and buildGrayscaleImagePdf.)
  //
  // Content:
  //   1 0 0 rg      0   0 40 40 re f      page content
  //   /CS0 cs 0 0 1 sc  40 0 40 40 re f   named space
  //   /Fm0 Do                             form XObject
  //   /Pattern cs /P0 scn 0 40 40 40 re f tiling pattern
  //   /Pattern cs /P1 scn 40 40 40 40 re f shading pattern
  //   q 0 80 40 40 re W n /Sh0 sh Q       sh
  //   q 40 0 0 40 80 80 cm /Im0 Do Q      Flate image
  //   q 40 0 0 40 120 80 cm /Im1 Do Q     JPEG image
  //   q 40 0 0 40 160 80 cm BI ... ID ... EI Q   inline image
  //   BT /T3 40 Tf 0 160 Td (a) Tj ET     Type 3 glyph
  //   (annotation /AP covers 120 0 40 40)
  throw new Error('assemble as described above, mirroring buildGrayscalePdf');
}
```

> Implementer: replace the `throw` with the real assembly, following
> `buildGrayscalePdf` exactly — same `assemble` helper, same object numbering
> discipline. Every fill must be **opaque** and every colour must have a luma
> distinct from 0 and 1 so a "did anything draw at all" bug cannot pass.

- [ ] **Step 2: Write the oracle test**

Create `test/grayscale-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { buildEverythingColorPdf } from './helpers/build-grayscale-pdf.js';

/** Every pixel with R === G === B, and how many were painted at all. */
function sweep(png: Uint8Array): { colored: Array<[number, number]>; painted: number } {
  const img = decodePng(png);
  const colored: Array<[number, number]> = [];
  let painted = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = img.at(x, y);
      if (a === 0) continue;
      if (r !== 255 || g !== 255 || b !== 255) painted++;
      // JPEG and resampling introduce a little channel drift; 2/255 is well
      // inside that and far outside any real hue.
      if (Math.abs(r - g) > 2 || Math.abs(g - b) > 2) colored.push([x, y]);
    }
  }
  return { colored, painted };
}

describe('ConvertToGrayscale — the rendered page', () => {
  it('paints colour before conversion', () => {
    // The control. Without it, a fixture that draws nothing would pass below.
    const doc = Document.Open(buildEverythingColorPdf());
    const s = sweep(doc.Pages[0].ToImage({ scale: 1 }));
    expect(s.painted).toBeGreaterThan(2000);
    expect(s.colored.length).toBeGreaterThan(2000);
  });

  it('leaves no coloured pixel anywhere after conversion', () => {
    const doc = Document.Open(buildEverythingColorPdf());
    const report = doc.ConvertToGrayscale();
    const s = sweep(doc.Pages[0].ToImage({ scale: 1 }));

    // Name the offenders: a bare count says nothing about which construct leaked.
    expect(s.colored.slice(0, 20)).toEqual([]);
    expect(s.painted).toBeGreaterThan(2000);   // still drawn, just grey
    expect(report.skipped).toEqual([]);
  });

  it('survives a round trip through Save', () => {
    const doc = Document.Open(buildEverythingColorPdf());
    doc.ConvertToGrayscale();
    const reopened = Document.Open(doc.Save());
    expect(sweep(reopened.Pages[0].ToImage({ scale: 1 })).colored.slice(0, 20)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the oracle**

Run: `npx vitest run test/grayscale-render.test.ts`
Expected: PASS, 3 tests. If a construct leaks, the failure names its pixels — map
them back to the cell that drew them.

- [ ] **Step 4: Prove the oracle load-bearing, one pass at a time**

For each of the five passes below, break it, run the oracle, and record whether
it went red. This is CLAUDE.md's standing rule: a fixture usually passes on the
first run, and that is not evidence.

```bash
# 1. content   -- in convertContent, `continue` before replaceObject
# 2. images    -- in convertImages, `continue` before replaceObject
# 3. shadings  -- in convertShadings, return before report.shadings++
# 4. annots    -- in convertAnnotations, return immediately
# 5. inline    -- in grayInlineImage, return undefined immediately
npx vitest run test/grayscale-render.test.ts
```

Write the result into a comment at the top of `test/grayscale-render.test.ts`,
naming any pass the oracle **cannot** see. The annotation pass is the leading
candidate: `/C` and `/IC` are only drawn when the annotation has no `/AP`, and
this fixture gives it one — so if breaking pass 4 leaves the oracle green, say
so and note that `test/grayscale-convert.test.ts`'s `/C` assertions are what
fence it. Do not claim coverage the measurement does not support.

- [ ] **Step 5: Commit the oracle and its findings**

```bash
git add test/grayscale-render.test.ts test/helpers/build-grayscale-pdf.ts
git commit -m "test(10u9.1): pixel oracle for grayscale conversion, with mutation findings"
```

- [ ] **Step 6: Update the README**

In `README.md`, add to the Features list, next to the other document-wide
operations:

```markdown
- **Grayscale conversion** — `doc.ConvertToGrayscale()` converts page content,
  form XObjects, patterns, Type 3 glyphs, images, shadings and annotations to
  DeviceGray, reporting what converted and what could not.
```

And to the API overview, beside `Optimize`:

```markdown
### Grayscale

```ts
const report = doc.ConvertToGrayscale({ quality: 90 });
report.images;    // one entry per converted image, with its route
report.skipped;   // what could not convert, and why
report.lossy;     // true when a JPEG was re-encoded
```

Colour is discarded, so the conversion is not reversible. A signed document
throws `UnsupportedFeatureError`.
```

- [ ] **Step 7: Update the CHANGELOG**

Add under `## [Unreleased]`, in **Added**:

```markdown
- **Grayscale conversion** (`Document.ConvertToGrayscale`). Converts a
  document's colour to DeviceGray across page content, form XObjects, tiling
  patterns, Type 3 glyph procedures, image XObjects, shadings and annotations.
  Colour operators are neutralized rather than their colour spaces retargeted:
  every `rg`/`k`/`sc`/`scn` becomes `g`/`G` carrying the Rec. 601 luma of the
  colour it set, resolved through the same `resolveColorSpace` the renderer
  uses, so ICCBased, Indexed, Separation, DeviceN and Lab need no cases of
  their own. That choice is what lets the object-level and content-level
  passes run in either order — the content pass reads colour-space resources
  no pass rewrites. Images take the cheapest faithful route: an Indexed image
  greys by palette rewrite alone, leaving its samples untouched and working at
  any bit depth, while a JPEG re-encodes as a grey JPEG (`quality`, default
  90) and other decodable samples become grey Flate. Rec. 601 rather than
  Rec. 709 because it is what the rest of the PDF tooling emits and is exactly
  JPEG's own Y channel. Shading functions convert exactly where that is free
  (type 2 through `/C0`/`/C1`, type 3 by recursion) and are resampled into a
  one-output sampled function otherwise. What could not convert — a
  function-less mesh shading, a colour-key `/Mask`, a filtered inline image —
  is reported in `skipped` rather than silently left in colour. (10u9.1)
```

- [ ] **Step 8: Run the full suite and typecheck**

Run: `npm run typecheck && npm test`
Expected: both green. Nothing outside `src/gray*.ts`, `src/signature.ts`,
`src/optimize.ts`, `src/document.ts` and `src/index.ts` should have moved — if
another test file goes red, that is information, not a chore.

- [ ] **Step 9: Commit and close**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(10u9.1): README and changelog for ConvertToGrayscale"
bd close 10u9.1
```

- [ ] **Step 10: File the follow-up issues**

```bash
bd create "Mesh shadings 4-7 without /Function in ConvertToGrayscale" \
  -p 3 --parent 10u9 -l gap-vs-go \
  -d "Per-vertex colour is bit-packed in the shading stream alongside /BitsPerCoordinate and /BitsPerFlag, with the colour ranges in /Decode. Currently reported in GrayscaleReport.skipped. See docs/superpowers/specs/2026-08-20-grayscale-conversion-design.md."
bd create "Coefficient-domain JPEG greying" \
  -p 3 --parent 10u9 -l gap-vs-go \
  -d "A baseline JPEG's Y channel IS Rec. 601 luma, so dropping the chroma components in the DCT domain would be an exact, generation-free greying producing a smaller file than the decode/re-encode route. Needs a coefficient-level transcoder the repo does not have."
bd create "Colour-key /Mask images in ConvertToGrayscale" \
  -p 3 --parent 10u9 -l gap-vs-go \
  -d "Two colours can share a luma, so an RGB range is not a grey range and a naively converted mask matches pixels it never matched. Currently skipped and reported."
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the greying rule → Task 1;
operator-level neutralization and the `[/Pattern base]` exception → Task 2;
enumeration, the two-phase invariant, the signed-document guard and the
byte-identity fence → Task 3; the Indexed route and the guards → Task 4; the DCT
and sample routes, the copy-then-override dict and `/SMask /Matte` → Tasks 5–6;
functions including the array-join and two-input shapes, and the mesh skip →
Tasks 7–8; `/C`, `/IC`, `/MK`, `/DA` and the empty-array trap → Task 9; inline
images → Task 10; the pixel oracle, mutation verification, README, CHANGELOG and
the three follow-up issues → Task 11.

**Two known gaps, both deliberate.** Task 11 Step 1 leaves the everything
fixture's assembly to the implementer with a written spec of its content rather
than 120 lines of transcribed PDF syntax — the pattern is fully shown in Task 3.
And Task 7 Step 4 notes that the two PostScript sources may need adjusting; the
assertion is against the original function's own output, so any valid 3-output
program satisfies it.

**Type consistency.** `GrayscaleOptions`, `GrayscaleReport`, `GrayImageResult`
and `GraySkipped` are declared once in Task 3 and used unchanged in Tasks 6, 8
and 9. `Resolve`/`Inflate` are declared in Task 4 and imported by Tasks 6, 7 and
8. `GraySpace`, `grayOf`, `grayNum`, `componentsOf` and `luma` are declared in
Task 1 and used under those exact names throughout. `grayscaleOps` returns
`{ ops, changed, patternSpaces }` in Task 2 and is destructured that way in
Tasks 3 and 9.
