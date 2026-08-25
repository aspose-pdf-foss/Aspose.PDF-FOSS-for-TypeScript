# SVG `<pattern>` embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `page.AddSVGObject` paint `<pattern>` fills as PDF tiling patterns instead of reporting `pattern` in `skipped`.

**Architecture:** A PatternType 1 pattern is a content *stream*, and streams must be indirect objects — so `svgdraw.ts`, which allocates nothing, gets an `SvgTileSink` that `svgembed.ts` implements, mirroring `SvgFontProvider` from `1gg0.8`. Tile content is emitted by a child `Emitter` sharing the walker's indexes but building its own `/Resources`. A new pure module `src/svgpattern.ts` owns `href` inheritance and the tile geometry, mirroring `svggradient.ts`'s role.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-29-svg-pattern-design.md`. Issue: `aspose-pdf-foss-for-ts-1gg0.19`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension.
- **`strict` TypeScript.** `npm run typecheck` green before any task is done.
- **Task tracking is `bd`.** Issue `aspose-pdf-foss-for-ts-1gg0.19`, already claimed. No TodoWrite, no markdown TODO lists.
- **`svgdraw.ts` and `svgpattern.ts` allocate no PDF objects and import no `Document`.** Only `svgembed.ts` may allocate. The sink is how a stream gets made.
- **Content is y-down.** Pattern space is the enclosing stream's space, so no extra flip anywhere — the page-level flip stays in `placementMatrix` alone.
- **Commit after every task**, prefix `fix(svg):` / `feat(svg):` / `refactor(svg):` / `test(svg):` / `docs(svg):`, subject ending `(1gg0.19)`.
- **Every commit message ends with:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/svgdraw.ts` | modify | `canon` ref fix; extracted `buildResources`; per-emitter font tracking; child `Emitter`; the pattern paint path and cycle guard; ink-bbox accumulation. |
| `src/svgpattern.ts` | **create** | `href` inheritance, unit resolution, tile rect → `/BBox` `/XStep` `/YStep` `/Matrix`. Pure. |
| `src/svgtext.ts` | modify | `SvgFontProvider` gains `dict()`, so a tile can build its own `/Font`. |
| `src/svgembed.ts` | modify | Implements `SvgTileSink`; drops the post-walk `/Font` merge, now done in the walker. |
| `README.md` | modify | Supported attributes, the `overflow: visible` stacking approximation. |
| `test/svg-pattern.test.ts` | **create** | The pure geometry suite. |
| `test/svg-draw.test.ts` | modify | `canon` regression, nested stream, resources, cycle guard, reporting. |
| `test/svg-embed.test.ts` | modify | Indirect stream vs direct dict; round trip. |
| `test/svg-pattern-render.test.ts` | **create** | The cross-implementation check through `ToImage`. |

---

### Task 1: Fix `canon`'s missing `ref` case

Dormant today — nothing puts a reference in a pattern dict. Tiles are the first, and the failure is silent: two unrelated tiles canonicalize identically and the second paints the first's content. Lands first, on its own.

**Files:**
- Modify: `src/svgdraw.ts:109-114` (`canon`)
- Test: `test/svg-draw.test.ts`

**Interfaces:**
- Consumes: `PdfRef` from `./types.js` — `{ kind: 'ref'; num: number; gen: number }`.
- Produces: nothing new; `canon` gains a branch.

- [ ] **Step 1: Write the failing test**

Append to `test/svg-draw.test.ts`:

```ts
import { __canon } from '../src/svgdraw.js';
import { ref, name } from '../src/types.js';

describe('svgdraw — canon', () => {
  it('distinguishes two different references', () => {
    // Without a ref branch both stringify to "[object Object]", so patKey
    // returns the FIRST tile's key for the second and it paints the wrong
    // content. Dormant until tiling patterns put refs in a pattern dict.
    expect(__canon(ref(4))).not.toBe(__canon(ref(5)));
  });

  it('distinguishes a reference from a name and from a number', () => {
    expect(__canon(ref(4))).not.toBe(__canon(name('R4')));
    expect(__canon(ref(4))).not.toBe(__canon(4));
  });

  it('still canonicalizes equal references equally', () => {
    expect(__canon(ref(4))).toBe(__canon(ref(4)));
  });

  it('reaches a reference nested inside a dict', () => {
    const a = new Map([['X', ref(1)]]);
    const b = new Map([['X', ref(2)]]);
    expect(__canon(a)).not.toBe(__canon(b));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — `__canon` is not exported, and once exported the first, second and fourth assertions fail.

- [ ] **Step 3: Implement**

In `src/svgdraw.ts`, add the branch and export the function for testing:

```ts
/** A stable string for a direct PdfObject tree, used only for pattern equality.
 *  Patterns nest three dicts deep, so a field-by-field compare would be worse.
 *
 *  @internal Exported for tests: the ref branch is load-bearing but only
 *  reachable through a tiling pattern, which makes it easy to break silently. */
export function __canon(v: PdfObject): string {
  if (v instanceof Map) return `<${[...v].map(([k, x]) => `${k}:${__canon(x)}`).join(',')}>`;
  if (Array.isArray(v)) return `[${v.map(__canon).join(',')}]`;
  if (v !== null && typeof v === 'object' && 'kind' in v) {
    // A ref would otherwise fall through to String(v) === "[object Object]",
    // making EVERY reference canonicalize identically.
    if (v.kind === 'name') return `/${v.name}`;
    if (v.kind === 'ref') return `R${v.num}.${v.gen}`;
  }
  return String(v);
}
```

Replace the two existing `canon(` call sites inside `patKey` with `__canon(`, and
delete the old `function canon`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/svg-draw.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Prove the branch is load-bearing**

Temporarily delete the `v.kind === 'ref'` line.
Run: `npx vitest run test/svg-draw.test.ts`
Expected: three of the four new tests FAIL. Revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "fix(svg): canonicalize references distinctly for pattern dedup (1gg0.19)

canon() had no ref case, so every PdfRef stringified to [object Object] and
two unrelated entries compared equal. Dormant today -- nothing puts a
reference in a pattern dict -- but tiling patterns are about to, and patKey
would then hand the second tile the first one's key and paint its content.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Build resources inside the walker, per emitter

Today `drawSvg` assembles `/ExtGState` + `/Pattern`, and `svgembed.ts` merges `/Font` in afterwards. A tile is a separate stream with its own `/Resources`, so a font used only inside a tile would land in the form's dict and the tile's `/F0` would not resolve. Resource assembly moves into the walker and becomes per-emitter.

**Files:**
- Modify: `src/svgtext.ts` — `SvgFontProvider`
- Modify: `src/svgdraw.ts` — `Emitter`, `buildResources`, `drawSvg`
- Modify: `src/svgembed.ts` — drop the post-walk merge
- Test: `test/svg-embed.test.ts`

**Interfaces:**
- Consumes: `SvgFace` (from `1gg0.8`).
- Produces:
  - `SvgFontProvider.dict(): PdfDict` — every face registered so far, by resource key.
  - `Emitter.usedFonts: Set<string>` — resource keys this emitter's content referenced.
  - `function buildResources(e: Emitter): PdfDict` (module-private).

- [ ] **Step 1: Write the failing test**

Append to `test/svg-embed.test.ts`:

```ts
describe('page.AddSVGObject — font resources', () => {
  it('registers only the faces the content actually used', () => {
    // Two faces exist in the document; the form must carry both, since both
    // are drawn at form level. The point of the assertion is that /Font is
    // built from what was USED, not merged in wholesale afterwards.
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 100 50">' +
      '<text y="10" font-family="serif">a</text>' +
      '<text y="30" font-family="monospace">b</text></svg>'), RECT);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const fonts = res.get('Font') as PdfDict;
    expect(fonts.size).toBe(2);
  });

  it('emits no /Font for an SVG without text', () => {
    const p = page();
    p.AddSVGObject(svg(DOC), RECT);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    expect(res.has('Font')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify the first fails**

Run: `npx vitest run test/svg-embed.test.ts`
Expected: the two-face test may already pass (the wholesale merge produces the
same dict here). That is fine — it is a characterization test pinning behaviour
across the refactor. The real proof is Step 6.

- [ ] **Step 3: Give the provider a `dict()`**

In `src/svgtext.ts`:

```ts
/** Resolves a CSS font-family list to a usable face, registering it on demand. */
export interface SvgFontProvider {
  face(families: string[], bold: boolean, italic: boolean): SvgFace;
  /** Every face registered so far, keyed by resource name. Read when a content
   *  stream builds its own /Resources — the form and each pattern tile do so
   *  independently, and a tile cannot see the form's dictionary. */
  dict(): PdfDict;
}
```

Add `import type { PdfDict } from './types.js';` to `svgtext.ts`.

- [ ] **Step 4: Track usage and assemble per emitter**

In `src/svgdraw.ts`, on `Emitter`:

```ts
  /** Font resource keys this stream's content referenced. A tile builds its own
   *  /Font from these; the provider's dict is document-wide. */
  readonly usedFonts = new Set<string>();
```

In the `text` branch of `walk`, after `emitGlyphs` reports it drew:

```ts
      if (drew) for (const g of glyphs) e.usedFonts.add(g.style.face.key);
```

Add the assembler beside `drawSvg`:

```ts
/** The /Resources for one content stream. Called once for the form and once per
 *  pattern tile: a tile's stream cannot see the form's dictionary, so each
 *  carries its own. */
function buildResources(e: Emitter): PdfDict {
  const res: PdfDict = new Map<string, PdfObject>();
  if (e.extg.size > 0) res.set('ExtGState', e.extg);
  if (e.pat.size > 0) res.set('Pattern', e.pat);
  if (e.usedFonts.size > 0) {
    const all = e.fonts.dict();
    const fonts: PdfDict = new Map<string, PdfObject>();
    for (const k of e.usedFonts) {
      const v = all.get(k);
      if (v !== undefined) fonts.set(k, v);
    }
    if (fonts.size > 0) res.set('Font', fonts);
  }
  return res;
}
```

and use it in `drawSvg`, replacing the inline assembly:

```ts
  walk(e, root, INITIAL, false, [...IDENTITY]);
  return {
    content: e.out.join('\n'),
    resources: buildResources(e),
    skipped: [...e.skipped].sort(),
  };
```

- [ ] **Step 5: Update `svgembed.ts`**

Implement `dict()` on the provider returned by `fontProvider`:

```ts
  const provider: SvgFontProvider = {
    dict: () => fonts,
    face(families, bold, italic): SvgFace {
```

and delete the post-walk merge, which the walker now does:

```ts
  const { provider } = fontProvider(doc, font);
  const { content, resources, skipped } = drawSvg(root, vb, provider);
```

`fontProvider` no longer needs to return `fonts` separately — return just
`provider`, or keep the shape and ignore it.

- [ ] **Step 6: Run to verify, and confirm nothing moved**

Run: `npx vitest run test/svg-embed.test.ts test/svg-text.test.ts test/svg-draw.test.ts test/svg-golden.test.ts`
Expected: PASS. Any font test that moves means the used-key filter is wrong.

Then temporarily make `buildResources` include the whole `e.fonts.dict()`
instead of the filtered subset, and re-run. Expected: still green *today* —
which is why this refactor is not self-proving, and Task 8 adds the test that
is (a tile-only font must not appear in the form's `/Font`).

Run: `npm run typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/svgdraw.ts src/svgtext.ts src/svgembed.ts test/svg-embed.test.ts
git commit -m "refactor(svg): build /Resources per content stream (1gg0.19)

svgembed merged /Font into the form's resources after the walk, which works
only while there is exactly one content stream. A pattern tile is a separate
stream that cannot see the form's dictionary, so assembly moves into the
walker and becomes per-emitter, filtered to the faces that stream actually
referenced.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The tile sink and the child emitter

**Files:**
- Modify: `src/svgdraw.ts`
- Test: `test/svg-draw.test.ts` (indirectly, via Task 6 — this task adds no behaviour on its own)

**Interfaces:**
- Produces:
  - `interface SvgTileSink { tile(dict: PdfDict, content: string): PdfObject }`
  - `Emitter.tiles: SvgTileSink`
  - `Emitter.child(): Emitter` — shares indexes, forks output.
  - `drawSvg(root, viewport, provider, tiles)` — a fourth parameter.

- [ ] **Step 1: Add the interface and the child constructor**

In `src/svgdraw.ts`:

```ts
/** Allocates a tiling-pattern content stream and returns its reference.
 *  svgembed.ts implements it, because a PatternType 1 pattern IS a stream and
 *  streams must be indirect objects — which svgdraw.ts, allocating nothing,
 *  cannot produce. Mirrors SvgFontProvider, for the same reason. */
export interface SvgTileSink {
  tile(dict: PdfDict, content: string): PdfObject;
}
```

On `Emitter`, the shared members become assignable so a child can inherit them.
Change `readonly ids`, `readonly active` and `readonly skipped` to plain fields,
add:

```ts
  /** Supplied by svgembed.ts: only it may allocate a pattern stream. */
  tiles!: SvgTileSink;
  /** Pattern ids currently being expanded, to break reference cycles. Shared
   *  with every child, so a cycle through a tile is caught too. */
  activePatterns = new Set<string>();

  /** A fresh emitter for a nested content stream — a pattern tile.
   *
   *  Indexes, the font provider, the sink and the cycle guards are SHARED; the
   *  output buffer and every resource map are FORKED, because a tile's stream
   *  has its own /Resources and cannot see the enclosing form's. */
  child(): Emitter {
    const c = new Emitter();
    c.ids = this.ids;
    c.css = this.css;
    c.fonts = this.fonts;
    c.tiles = this.tiles;
    c.viewport = this.viewport;
    c.skipped = this.skipped;              // a loss inside a tile is still a loss
    c.active = this.active;
    c.activePatterns = this.activePatterns;
    return c;
  }
```

Thread the sink through both entry points:

```ts
export function drawSvg(
  root: XmlNode, viewport: ViewBox, provider: SvgFontProvider, tiles: SvgTileSink,
): DrawResult {
  const e = new Emitter();
  e.viewport = viewport;
  e.fonts = provider;
  e.tiles = tiles;
```

and the same in `__ctmProbe`.

- [ ] **Step 2: Update the call sites**

`src/svgembed.ts` — a placeholder sink until Task 8:

```ts
  const { content, resources, skipped } = drawSvg(root, vb, provider, {
    tile: (d, c) => doc.allocObject({ kind: 'stream', dict: d, raw: enc(c) }),
  });
```

`test/svg-draw.test.ts` and any other `drawSvg`/`__ctmProbe` caller — add a stub:

```ts
import { ref } from '../src/types.js';
const noTiles = { tile: () => ref(0) };
```

and pass it as the fourth argument in the `draw` and `probe` helpers.

- [ ] **Step 3: Run to verify nothing moved**

Run: `npx vitest run test/svg-draw.test.ts test/svg-embed.test.ts test/svg-text.test.ts test/svg-golden.test.ts && npm run typecheck`
Expected: PASS, clean typecheck. This task is pure plumbing; a behaviour change here is a mistake.

- [ ] **Step 4: Commit**

```bash
git add src/svgdraw.ts src/svgembed.ts test/svg-draw.test.ts
git commit -m "feat(svg): add the tile sink and a child emitter (1gg0.19)

A tile's content is a separate stream with its own /Resources, so it needs
its own emitter -- indexes, provider, sink and cycle guards shared, output
and resource maps forked. Plumbing only; no behaviour change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `svgpattern.ts` — `href` inheritance and unit resolution

**Files:**
- Create: `src/svgpattern.ts`
- Test: `test/svg-pattern.test.ts`

**Interfaces:**
- Consumes: `XmlNode`; `CssMap`; `SegBBox`; `ViewBox`; `Matrix`.
- Produces:
  - `interface ResolvedPattern { attrs: Map<string, string>; content: XmlNode }` — `content` is the element whose children supply the tile.
  - `function resolvePattern(node: XmlNode, ids: Map<string, XmlNode>): ResolvedPattern`
  - `interface TileRect { x: number; y: number; w: number; h: number }`
  - `function tileRect(attrs, obb, bbox, viewport): TileRect | null` — `null` when the tile has no area.

- [ ] **Step 1: Write the failing tests**

Create `test/svg-pattern.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseXml, type XmlNode } from '../src/xml.js';
import { resolvePattern, tileRect } from '../src/svgpattern.js';

const xml = (s: string) => new TextEncoder().encode(s);

/** Index every element carrying an id, as svgdraw does. */
function index(root: XmlNode): Map<string, XmlNode> {
  const m = new Map<string, XmlNode>();
  const walk = (n: XmlNode): void => {
    const id = n.attrs.get('id');
    if (id !== undefined && !m.has(id)) m.set(id, n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return m;
}

function pat(src: string, id = 'p') {
  const root = parseXml(xml(src));
  const ids = index(root);
  return { r: resolvePattern(ids.get(id)!, ids), ids };
}

const VP = { minX: 0, minY: 0, w: 200, h: 100 };
const BOX = { x: 10, y: 20, w: 40, h: 80 };

describe('svgpattern — href inheritance', () => {
  it('keeps its own attributes', () => {
    const { r } = pat('<svg><pattern id="p" width="4" height="5"/></svg>');
    expect(r.attrs.get('width')).toBe('4');
  });

  it('inherits attributes it does not define', () => {
    const { r } = pat('<svg><pattern id="base" width="4" height="5"/>' +
      '<pattern id="p" href="#base" width="9"/></svg>');
    expect(r.attrs.get('width')).toBe('9');       // own wins
    expect(r.attrs.get('height')).toBe('5');      // inherited
  });

  it('never inherits id or href', () => {
    const { r } = pat('<svg><pattern id="base" width="4"/>' +
      '<pattern id="p" href="#base"/></svg>');
    expect(r.attrs.get('id')).toBe('p');
    expect(r.attrs.get('href')).toBe('#base');
  });

  it('takes content from the nearest ancestor that has children', () => {
    const { r } = pat('<svg><pattern id="base"><rect width="1" height="1"/></pattern>' +
      '<pattern id="p" href="#base" width="9"/></svg>');
    expect(r.content.children.map((c) => c.name)).toEqual(['rect']);
  });

  it('prefers its own content over inherited content', () => {
    const { r } = pat('<svg><pattern id="base"><rect/></pattern>' +
      '<pattern id="p" href="#base"><circle/></pattern></svg>');
    expect(r.content.children.map((c) => c.name)).toEqual(['circle']);
  });

  it('terminates on a reference cycle', () => {
    const { r } = pat('<svg><pattern id="p" href="#q" width="1"/>' +
      '<pattern id="q" href="#p" height="2"/></svg>');
    expect(r.attrs.get('height')).toBe('2');
  });
});

describe('svgpattern — tile rect', () => {
  it('resolves objectBoundingBox fractions against the shape box', () => {
    const attrs = new Map([['x', '0.5'], ['y', '0.25'], ['width', '0.5'], ['height', '0.5']]);
    expect(tileRect(attrs, true, BOX, VP)).toEqual({ x: 20, y: 20, w: 20, h: 40 });
  });

  it('resolves userSpaceOnUse values as user units', () => {
    const attrs = new Map([['x', '5'], ['y', '6'], ['width', '7'], ['height', '8']]);
    expect(tileRect(attrs, false, BOX, VP)).toEqual({ x: 5, y: 6, w: 7, h: 8 });
  });

  it('resolves a userSpaceOnUse percentage against the viewport', () => {
    const attrs = new Map([['width', '50%'], ['height', '50%']]);
    const t = tileRect(attrs, false, BOX, VP)!;
    expect(t.w).toBeCloseTo(100, 9);
    expect(t.h).toBeCloseTo(50, 9);
  });

  it('defaults x and y to zero', () => {
    const attrs = new Map([['width', '4'], ['height', '5']]);
    expect(tileRect(attrs, false, BOX, VP)).toMatchObject({ x: 0, y: 0 });
  });

  it('returns null for a tile with no area', () => {
    // SVG: the element is not rendered by that paint. Not a fidelity loss.
    expect(tileRect(new Map([['width', '0'], ['height', '5']]), false, BOX, VP)).toBe(null);
    expect(tileRect(new Map([['width', '4'], ['height', '-1']]), false, BOX, VP)).toBe(null);
    expect(tileRect(new Map(), false, BOX, VP)).toBe(null);
  });

  it('returns null under objectBoundingBox when the shape has no area', () => {
    const attrs = new Map([['width', '0.5'], ['height', '0.5']]);
    expect(tileRect(attrs, true, { x: 0, y: 0, w: 0, h: 10 }, VP)).toBe(null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-pattern.test.ts`
Expected: FAIL — `Cannot find module '../src/svgpattern.js'`.

- [ ] **Step 3: Implement**

Create `src/svgpattern.ts`:

```ts
// SVG <pattern> -> PDF PatternType 1 tiling pattern (issue 1gg0.19). Pure
// arithmetic: href inheritance, unit resolution and the tile geometry. Mirrors
// svggradient.ts's role for the other paint server; the two share no attributes
// and so share no code beyond the matrix helpers.
import type { XmlNode } from './xml.js';
import type { SegBBox } from './svgpath.js';
import type { ViewBox } from './svgtransform.js';

/** A pattern flattened through its href chain: the effective attributes, and
 *  the element whose children supply the tile content. */
export interface ResolvedPattern {
  attrs: Map<string, string>;
  content: XmlNode;
}

/** Never inherited through href — they identify the reference itself. */
const NOT_INHERITED = new Set(['id', 'href', 'xlink:href']);

/** Flatten a pattern's `href` / `xlink:href` chain. Content is inherited when
 *  the referring element has none of its own, mirroring how a gradient inherits
 *  stops. A visited set breaks reference cycles. */
export function resolvePattern(
  node: XmlNode, ids: Map<string, XmlNode>,
): ResolvedPattern {
  const attrs = new Map(node.attrs);
  let content = node;
  const seen = new Set<string>();
  const selfId = node.attrs.get('id');
  if (selfId !== undefined) seen.add(selfId);

  let cur: XmlNode = node;
  for (;;) {
    const href = cur.attrs.get('href') ?? cur.attrs.get('xlink:href');
    if (href === undefined || href[0] !== '#') break;
    const id = href.slice(1);
    if (id === '' || seen.has(id)) break;
    seen.add(id);
    const next = ids.get(id);
    if (!next || next.name !== 'pattern') break;
    for (const [k, v] of next.attrs)
      if (!NOT_INHERITED.has(k) && !attrs.has(k)) attrs.set(k, v);
    if (content.children.length === 0) content = next;
    cur = next;
  }
  return { attrs, content };
}

export interface TileRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Resolve one length. Under objectBoundingBox a bare number is a fraction of
 *  the box; under userSpaceOnUse a percentage resolves against `span`. */
function len(
  v: string | undefined, dflt: number, obb: boolean, span: number,
): number {
  if (v === undefined) return dflt;
  const t = v.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return dflt;
  if (t.endsWith('%')) return obb ? n / 100 : (n / 100) * span;
  return n;
}

/** The tile rect in the units `obb` selects, or null when it has no area —
 *  which SVG says means the element is simply not rendered by that paint. */
export function tileRect(
  attrs: Map<string, string>, obb: boolean, bbox: SegBBox | null, viewport: ViewBox,
): TileRect | null {
  const sx = obb ? (bbox?.w ?? 0) : viewport.w;
  const sy = obb ? (bbox?.h ?? 0) : viewport.h;
  if (obb && (!bbox || !(bbox.w > 0) || !(bbox.h > 0))) return null;

  const fx = len(attrs.get('x'), 0, obb, sx);
  const fy = len(attrs.get('y'), 0, obb, sy);
  const fw = len(attrs.get('width'), 0, obb, sx);
  const fh = len(attrs.get('height'), 0, obb, sy);
  if (!(fw > 0) || !(fh > 0)) return null;

  return obb
    ? { x: bbox!.x + fx * bbox!.w, y: bbox!.y + fy * bbox!.h,
        w: fw * bbox!.w, h: fh * bbox!.h }
    : { x: fx, y: fy, w: fw, h: fh };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/svg-pattern.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/svgpattern.ts test/svg-pattern.test.ts
git commit -m "feat(svg): resolve pattern href inheritance and the tile rect (1gg0.19)

Mirrors svggradient's href flattening: attributes inherit when not defined
locally, content inherits when the referring element has no children, and a
visited set breaks cycles. A tile with no area returns null -- SVG says the
element is not rendered by that paint, which is a mandated outcome rather
than a fidelity loss.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `svgpattern.ts` — the tile matrix, `viewBox` and content units

**Files:**
- Modify: `src/svgpattern.ts`
- Test: `test/svg-pattern.test.ts`

**Interfaces:**
- Consumes: `parseTransform`, `parseViewBox`, `placementMatrix` from `./svgtransform.js`; `mul`, `IDENTITY` from `./text.js`.
- Produces: `function tileMatrix(attrs, rect, obb, bbox, ctm): { matrix: Matrix; content: Matrix }` — `matrix` is the pattern `/Matrix`; `content` is the extra transform to emit at the top of the tile stream (identity when neither `viewBox` nor `patternContentUnits` asks for one).

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-pattern.test.ts`:

```ts
import { tileMatrix } from '../src/svgpattern.js';
import { IDENTITY } from '../src/text.js';

const RECT = { x: 10, y: 20, w: 4, h: 5 };
const attrs = (o: Record<string, string>) => new Map(Object.entries(o));

describe('svgpattern — the tile matrix', () => {
  it('translates the pattern origin to the tile rect', () => {
    const { matrix } = tileMatrix(attrs({}), RECT, false, BOX, [...IDENTITY]);
    expect(matrix).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it('composes the walker CTM after the tile placement', () => {
    const { matrix } = tileMatrix(attrs({}), RECT, false, BOX, [2, 0, 0, 2, 0, 0]);
    expect(matrix).toEqual([2, 0, 0, 2, 20, 40]);
  });

  it('applies patternTransform inside the pattern coordinate system', () => {
    // Leftmost = first applied, matching gradientTransform's order.
    const { matrix } = tileMatrix(
      attrs({ patternTransform: 'scale(3)' }), RECT, false, BOX, [...IDENTITY]);
    expect(matrix).toEqual([3, 0, 0, 3, 10, 20]);
  });

  it('leaves the content transform identity by default', () => {
    const { content } = tileMatrix(attrs({}), RECT, false, BOX, [...IDENTITY]);
    expect(content).toEqual([...IDENTITY]);
  });

  it('scales content by the shape box under patternContentUnits', () => {
    const { content } = tileMatrix(
      attrs({ patternContentUnits: 'objectBoundingBox' }), RECT, false, BOX, [...IDENTITY]);
    expect(content).toEqual([BOX.w, 0, 0, BOX.h, 0, 0]);
  });

  it('fits a viewBox to the tile, overriding patternContentUnits', () => {
    // viewBox 0 0 10 10 into a 4x5 tile, meet -> uniform scale 0.4, centred.
    const { content } = tileMatrix(
      attrs({ viewBox: '0 0 10 10', patternContentUnits: 'objectBoundingBox' }),
      RECT, false, BOX, [...IDENTITY]);
    expect(content[0]).toBeCloseTo(0.4, 9);
    expect(content[3]).toBeCloseTo(0.4, 9);
  });

  it('stretches a viewBox under preserveAspectRatio none', () => {
    const { content } = tileMatrix(
      attrs({ viewBox: '0 0 10 10', preserveAspectRatio: 'none' }),
      RECT, false, BOX, [...IDENTITY]);
    expect(content[0]).toBeCloseTo(0.4, 9);
    expect(content[3]).toBeCloseTo(0.5, 9);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-pattern.test.ts`
Expected: FAIL — `tileMatrix` is not exported.

- [ ] **Step 3: Implement**

Append to `src/svgpattern.ts` (adding the imports named above):

```ts
/** The pattern `/Matrix` and the transform the tile's own content needs.
 *
 *  `/Matrix` maps pattern space to the enclosing content stream's default
 *  space — which in this stack is y-down, exactly as gradients assume, so no
 *  flip belongs here. patternTransform applies INSIDE pattern space and is
 *  therefore the leftmost factor, matching gradientTransform's order.
 *
 *  The content transform is returned separately rather than folded in, because
 *  /BBox and /XStep are expressed in pattern space: folding a viewBox scale
 *  into /Matrix would scale the tile spacing along with the artwork. */
export function tileMatrix(
  attrs: Map<string, string>, rect: TileRect, obb: boolean,
  bbox: SegBBox | null, ctm: Matrix,
): { matrix: Matrix; content: Matrix } {
  const pt = parseTransform(attrs.get('patternTransform'));
  const place: Matrix = [1, 0, 0, 1, rect.x, rect.y];
  const matrix = mul(mul(pt, place), ctm);

  const vb = parseViewBox(attrs.get('viewBox'));
  if (vb) {
    // A viewBox overrides patternContentUnits entirely (SVG 1.1 §13.3). /Matrix
    // has already placed the tile, so fit into a rect at the origin.
    const m = placementMatrix(vb, [0, 0, rect.w, rect.h],
      attrs.get('preserveAspectRatio'), undefined);
    // placementMatrix was written for the PAGE placement in 1gg0.3, so it
    // carries the y-flip: it yields [sx, 0, 0, -sy, e, f] mapping
    // y -> -sy*y + f. The tile wants the y-DOWN fit, y -> sy*y + f', which
    // lands the viewBox top at the same offset ty:
    //
    //   f  = h - ty + vbMinY*sy   =>   ty = h - f + vbMinY*sy
    //   f' = ty - vbMinY*sy       =>   f' = h - f
    //
    // so negating c and d and replacing f with h - f is exact, not a fudge.
    return { matrix, content: [m[0], m[1], -m[2], -m[3], m[4], rect.h - m[5]] };
  }

  const ccu = attrs.get('patternContentUnits') === 'objectBoundingBox';
  const content: Matrix = ccu && bbox
    ? [bbox.w, 0, 0, bbox.h, 0, 0]
    : [...IDENTITY];
  void obb;
  return { matrix, content };
}
```

If the two scale assertions fail, the derivation above is wrong somewhere — fix
the formula. Do **not** adjust the tests: 0.4 uniform under `meet` and 0.4 × 0.5
under `none` are the specification, computed by hand from a 10 × 10 viewBox in a
4 × 5 tile.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/svg-pattern.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/svgpattern.ts test/svg-pattern.test.ts
git commit -m "feat(svg): compose the tile matrix, viewBox and content units (1gg0.19)

/Matrix places the tile in the enclosing stream's y-down space; the content
transform is returned SEPARATELY rather than folded in, because /BBox and
/XStep live in pattern space and folding a viewBox scale into /Matrix would
scale the tile spacing along with the artwork.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Paint a pattern in the walker

**Files:**
- Modify: `src/svgdraw.ts` — `DEFINITION`, `gradientFor`/`resolvePaint`, `walk`'s `refs` loop
- Test: `test/svg-draw.test.ts`

**Interfaces:**
- Consumes: `resolvePattern`, `tileRect`, `tileMatrix` (Tasks 4–5); `Emitter.child`, `SvgTileSink` (Task 3).
- Produces: `function tilingFor(e: Emitter, node: XmlNode, bbox: SegBBox | null, ctm: Matrix): PdfObject | null` (module-private) — the pattern object, or null when the pattern paints nothing.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-draw.test.ts`:

```ts
describe('drawSvg — pattern', () => {
  const P = '<defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse">' +
    '<rect width="2" height="2" fill="red"/></pattern></defs>';

  it('paints a pattern fill and reports nothing', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="url(#p)"/></svg>`);
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain('/Pattern cs');
    expect(r.content).toMatch(/\/P\d+ scn/);
  });

  it('registers the tile as a Pattern resource', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="url(#p)"/></svg>`);
    const pat = r.resources.get('Pattern') as PdfDict;
    expect(isDict(pat)).toBe(true);
    expect(pat.size).toBe(1);
  });

  it('does not draw the pattern content at form level', () => {
    // The tile's rect belongs in the TILE's stream, not the form's.
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="url(#p)"/></svg>`);
    expect((r.content.match(/1 0 0 rg/g) ?? []).length).toBe(0);
  });

  it('paints nothing and reports nothing for an empty pattern', () => {
    // SVG mandates the element is not rendered by that paint: an outcome, not
    // a fidelity loss -- the same rule a stopless gradient follows.
    const r = draw('<svg><defs><pattern id="p" width="4" height="4"/></defs>' +
      '<rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).not.toMatch(/\bf\b/);
  });

  it('paints nothing for a zero-sized tile', () => {
    const r = draw('<svg><defs><pattern id="p" width="0" height="4">' +
      '<rect width="1" height="1"/></pattern></defs>' +
      '<rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toEqual([]);
    expect(r.content).not.toMatch(/\bf\b/);
  });

  it('reports a pattern reference cycle instead of hanging', () => {
    const r = draw('<svg><defs><pattern id="p" width="4" height="4" ' +
      'patternUnits="userSpaceOnUse">' +
      '<rect width="2" height="2" fill="url(#p)"/></pattern></defs>' +
      '<rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toContain('pattern');
  });

  it('propagates a loss from inside a tile', () => {
    const r = draw('<svg><defs><pattern id="p" width="4" height="4" ' +
      'patternUnits="userSpaceOnUse"><mask id="m"/><rect width="1" height="1"/>' +
      '</pattern></defs><rect width="9" height="9" fill="url(#p)"/></svg>');
    expect(r.skipped).toContain('mask');
  });

  it('strokes with a pattern too', () => {
    const r = draw(`<svg>${P}<rect width="9" height="9" fill="none" ` +
      'stroke="url(#p)" stroke-width="2"/></svg>');
    expect(r.content).toContain('/Pattern CS');
    expect(r.content).toMatch(/\/P\d+ SCN/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — `pattern` is reported and nothing paints.

- [ ] **Step 3: Implement**

In `src/svgdraw.ts`, add `'pattern'` to `DEFINITION`:

```ts
const DEFINITION = new Set(['clipPath', 'linearGradient', 'radialGradient', 'pattern']);
```

Add the tile builder above `resolvePaint`:

```ts
/** Build (or reuse) the tiling pattern for one `<pattern>` element, painting its
 *  children into a nested content stream. Returns null when the pattern paints
 *  nothing, which SVG treats as an outcome rather than a loss. */
function tilingFor(
  e: Emitter, node: XmlNode, bbox: SegBBox | null, ctm: Matrix,
): PdfObject | null {
  const id = node.attrs.get('id') ?? '';
  if (id !== '' && e.activePatterns.has(id)) {
    e.skipped.add('pattern');                 // reference cycle
    return null;
  }
  const { attrs, content } = resolvePattern(node, e.ids);
  if (content.children.length === 0) return null;

  const obb = (attrs.get('patternUnits') ?? 'objectBoundingBox') !== 'userSpaceOnUse';
  const rect = tileRect(attrs, obb, bbox, e.viewport);
  if (!rect) return null;
  const { matrix, content: cm } = tileMatrix(attrs, rect, obb, bbox, ctm);

  const sub = e.child();
  if (id !== '') sub.activePatterns.add(id);
  const hasCm = cm.some((v, i) => v !== IDENTITY[i]);
  if (hasCm) { sub.out.push('q'); sub.out.push(`${cm.map(num).join(' ')} cm`); }
  for (const c of content.children) walk(sub, c, INITIAL, false, hasCm ? mul(cm, ctm) : ctm);
  if (hasCm) sub.out.push('Q');
  if (id !== '') sub.activePatterns.delete(id);

  const dict: PdfDict = new Map<string, PdfObject>([
    ['Type', name('Pattern')],
    ['PatternType', 1],
    ['PaintType', 1],
    ['TilingType', 1],
    ['BBox', [0, 0, rect.w, rect.h]],
    ['XStep', rect.w],
    ['YStep', rect.h],
    ['Resources', buildResources(sub)],
    ['Matrix', [...matrix]],
  ]);
  return e.tiles.tile(dict, sub.out.join('\n'));
}
```

In `resolvePaint`, resolve a `url()` to either paint server. Replace the two
`gradientFor` calls with a helper that tries both:

```ts
/** A resolved url() paint. Unifies the two paint servers so resolvePaint has
 *  one shape to consume: the Pattern resource is already REGISTERED and carried
 *  as a key, since a tile is a ref and a shading is a dict. */
type ServerPaint =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgb; opacity: number }
  | { kind: 'pattern'; key: string; opacity: number };

/** Resolve a url() reference to a gradient or a tiling pattern. Returns null
 *  when it names neither, which leaves the element's own colour in play. */
function paintServer(
  e: Emitter, id: string | null, bbox: SegBBox | null, ctm: Matrix,
): ServerPaint | null {
  if (id === null) return null;
  const node = e.ids.get(id);
  if (!node) return null;
  if (node.name === 'pattern') {
    const t = tilingFor(e, node, bbox, ctm);
    return t === null ? { kind: 'none' } : { kind: 'pattern', key: e.patKey(t), opacity: 1 };
  }
  const g = gradientFor(e, id, bbox, ctm);
  if (!g) return null;
  if (g.kind === 'pattern')
    return { kind: 'pattern', key: e.patKey(g.pattern), opacity: g.opacity };
  if (g.kind === 'solid')
    return { kind: 'solid', color: g.color, opacity: g.opacity };
  return { kind: 'none' };
}
```

`Emitter.patKey` currently takes a `PdfDict`; widen it to `PdfObject` so a ref
can be registered:

```ts
  patKey(d: PdfObject): string {
```

`resolvePaint` then changes in exactly four places — the two resolutions, the
alpha helper's type, and the two colour branches. Everything else, including all
the stroke parameters, is untouched:

```ts
export function resolvePaint(
  e: Emitter, p: Paint, bbox: SegBBox | null, ctm: Matrix,
): PaintOps {
  const fg = p.fillRef !== null ? paintServer(e, p.fillRef, bbox, ctm) : null;
  const sg = p.strokeRef !== null ? paintServer(e, p.strokeRef, bbox, ctm) : null;

  const doFill = fg ? fg.kind !== 'none' : p.fill !== null;
  const doStroke = (sg ? sg.kind !== 'none' : p.stroke !== null) && p.strokeWidth > 0;
  const ops: string[] = [];
  if (!doFill && !doStroke) return { fill: false, stroke: false, ops };

  const gAlpha = (g: ServerPaint | null): number => (g && g.kind !== 'none' ? g.opacity : 1);
  const ca = doFill ? p.fillOpacity * gAlpha(fg) : 1;
  const CA = doStroke ? p.strokeOpacity * gAlpha(sg) : 1;
  if (ca < 1 || CA < 1) ops.push(`/${e.gsKey(ca, CA)} gs`);
  if (doFill) {
    if (fg && fg.kind === 'pattern') ops.push('/Pattern cs', `/${fg.key} scn`);
    else if (fg && fg.kind === 'solid') ops.push(`${fg.color.map(num).join(' ')} rg`);
    else ops.push(`${p.fill!.map(num).join(' ')} rg`);
  }
  if (doStroke) {
    if (sg && sg.kind === 'pattern') ops.push('/Pattern CS', `/${sg.key} SCN`);
    else if (sg && sg.kind === 'solid') ops.push(`${sg.color.map(num).join(' ')} RG`);
    else ops.push(`${p.stroke!.map(num).join(' ')} RG`);
    ops.push(`${num(p.strokeWidth)} w`);
    if (p.lineCap !== 0) ops.push(`${p.lineCap} J`);
    if (p.lineJoin !== 0) ops.push(`${p.lineJoin} j`);
    if (p.miterLimit !== 4) ops.push(`${num(p.miterLimit)} M`);
    if (p.dash.length > 0) ops.push(`[${p.dash.map(num).join(' ')}] ${num(p.dashOffset)} d`);
  }
  return { fill: doFill, stroke: doStroke, ops };
}
```

Add `import type { Rgb } from './svgstyle.js';` for the `ServerPaint` union.

Finally, in `walk`'s `refs` loop, stop reporting a resolvable pattern:

```ts
    if (target && (target.name === 'linearGradient' || target.name === 'radialGradient'
                   || target.name === 'pattern'))
      continue;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/svg-draw.test.ts test/svg-gradient.test.ts test/svg-golden.test.ts && npm run typecheck`
Expected: PASS, with **no edits** to the gradient or golden files — the shading path must be untouched.

- [ ] **Step 5: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "feat(svg): paint <pattern> as a PDF tiling pattern (1gg0.19)

A pattern's children are walked into a child emitter and handed to the sink
as a stream. A cycle reports 'pattern' as <use> reports itself; an empty
pattern or a zero-area tile paints nothing and reports nothing, which is the
outcome SVG mandates rather than a fidelity loss.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `overflow: visible`

**Files:**
- Modify: `src/svgdraw.ts` — ink accumulation and the `/BBox` split
- Test: `test/svg-draw.test.ts`

**Interfaces:**
- Produces: `Emitter.ink: SegBBox | null` — the union of everything this emitter painted, in its own space.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-draw.test.ts`:

```ts
describe('drawSvg — pattern overflow', () => {
  const tile = (overflow: string) =>
    '<svg><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"' +
    (overflow ? ` overflow="${overflow}"` : '') +
    '><rect x="-2" y="-2" width="8" height="8" fill="red"/></pattern></defs>' +
    '<rect width="20" height="20" fill="url(#p)"/></svg>';

  /** The single tile dict handed to the sink. */
  function tileDict(src: string): PdfDict {
    const seen: PdfDict[] = [];
    drawSvg(parseXml(new TextEncoder().encode(src)), VP, fakeProvider(), {
      tile: (d) => { seen.push(d); return ref(seen.length); },
    });
    expect(seen.length).toBe(1);
    return seen[0];
  }

  it('clips to the tile box by default', () => {
    const d = tileDict(tile(''));
    expect(d.get('BBox')).toEqual([0, 0, 4, 4]);
    expect(d.get('XStep')).toBe(4);
  });

  it('grows the BBox to the ink under overflow visible, keeping the step', () => {
    // PDF always clips to /BBox, so spilling is expressed by a BBox larger
    // than the step: adjacent cells then overlap.
    const d = tileDict(tile('visible'));
    const b = d.get('BBox') as number[];
    expect(b[0]).toBeLessThanOrEqual(-2);
    expect(b[2]).toBeGreaterThanOrEqual(6);
    expect(d.get('XStep')).toBe(4);        // spacing unchanged
    expect(d.get('YStep')).toBe(4);
  });

  it('leaves the BBox at the tile when overflow visible has no overhang', () => {
    const d = tileDict(
      '<svg><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse" ' +
      'overflow="visible"><rect width="4" height="4"/></pattern></defs>' +
      '<rect width="20" height="20" fill="url(#p)"/></svg>');
    expect(d.get('BBox')).toEqual([0, 0, 4, 4]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-draw.test.ts`
Expected: FAIL — the overflow BBox equals the tile box.

- [ ] **Step 3: Implement**

On `Emitter`:

```ts
  /** Union of everything this emitter painted, in its own space. Accumulated
   *  only for a tile that asked for overflow: visible, where /BBox must cover
   *  the ink rather than the cell. */
  ink: SegBBox | null = null;
  wantInk = false;

  addInk(b: SegBBox | null, m: Matrix): void {
    if (!this.wantInk || !b) return;
    const xs = [b.x, b.x + b.w];
    const ys = [b.y, b.y + b.h];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const x of xs) for (const y of ys) {
      const px = m[0] * x + m[2] * y + m[4];
      const py = m[1] * x + m[3] * y + m[5];
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const cur = this.ink;
    this.ink = cur === null
      ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
      : { x: Math.min(cur.x, x0), y: Math.min(cur.y, y0),
          w: Math.max(cur.x + cur.w, x1) - Math.min(cur.x, x0),
          h: Math.max(cur.y + cur.h, y1) - Math.min(cur.y, y0) };
  }
```

In `paintShape`, after the paint decision succeeds:

```ts
  e.addInk(bbox(), ctm);
```

In the `text` branch of `walk`, after `emitGlyphs` returns true:

```ts
      if (drew) e.addInk(glyphsBBox(glyphs), here);
```

(import `glyphsBBox` from `./svgtext.js`).

In `tilingFor`, request ink and widen the box:

```ts
  const sub = e.child();
  sub.wantInk = (attrs.get('overflow') ?? '').trim() === 'visible';
  …
  let bx = 0, by = 0, bw = rect.w, bh = rect.h;
  if (sub.wantInk && sub.ink) {
    // /XStep and /YStep stay at the tile size, so the cells overlap and the
    // content spills -- which is what overflow: visible means.
    bx = Math.min(0, sub.ink.x);
    by = Math.min(0, sub.ink.y);
    bw = Math.max(rect.w, sub.ink.x + sub.ink.w) - bx;
    bh = Math.max(rect.h, sub.ink.y + sub.ink.h) - by;
  }
```

and use `['BBox', [bx, by, bx + bw, by + bh]]` while `/XStep` and `/YStep` keep
`rect.w` and `rect.h`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/svg-draw.test.ts && npm run typecheck`
Expected: PASS and a clean typecheck.

- [ ] **Step 5: Prove the split is load-bearing**

Temporarily set `/XStep` and `/YStep` to `bw`/`bh` instead of `rect.w`/`rect.h`.
Run: `npx vitest run test/svg-draw.test.ts`
Expected: the "keeping the step" test FAILS. Revert and confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/svgdraw.ts test/svg-draw.test.ts
git commit -m "feat(svg): support overflow: visible on a pattern (1gg0.19)

PDF always clips a cell to /BBox, so spilling is expressed by a BBox that
covers the ink while /XStep and /YStep stay at the tile size -- adjacent
cells then overlap and content crosses boundaries. The child emitter
accumulates the ink union only when asked, since it costs an eager bbox per
shape.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The real sink, and the tile-only font

**Files:**
- Modify: `src/svgembed.ts`
- Test: `test/svg-embed.test.ts`

**Interfaces:**
- Consumes: `SvgTileSink` (Task 3).
- Produces: the sink implementation, replacing Task 3's inline placeholder.

- [ ] **Step 1: Write the failing tests**

Append to `test/svg-embed.test.ts`:

```ts
describe('page.AddSVGObject — pattern', () => {
  const P = '<svg viewBox="0 0 20 20"><defs>' +
    '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse">' +
    '<rect width="2" height="2" fill="#ff0000"/></pattern></defs>' +
    '<rect width="20" height="20" fill="url(#p)"/></svg>';

  it('registers the tile as an indirect stream, not a direct dict', () => {
    // This is the observable difference from a shading pattern, which stays a
    // direct dict: a PatternType 1 pattern IS a stream, and streams must be
    // indirect objects.
    const p = page();
    expect(p.AddSVGObject(svg(P), RECT).skipped).toEqual([]);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const pats = res.get('Pattern') as PdfDict;
    const entry = [...pats.values()][0];
    expect(isRef(entry)).toBe(true);
    const tile = p.Document.resolve(entry);
    expect(isStream(tile)).toBe(true);
    expect((tile as PdfStream).dict.get('PatternType')).toBe(1);
    expect(dec((tile as PdfStream).raw)).toContain('1 0 0 rg');
  });

  it('puts a tile-only font in the TILE resources, not the form', () => {
    // The form has no text at all, so its /Font must be absent entirely.
    const p = page();
    p.AddSVGObject(svg('<svg viewBox="0 0 20 20"><defs>' +
      '<pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse">' +
      '<text y="6">x</text></pattern></defs>' +
      '<rect width="20" height="20" fill="url(#p)"/></svg>'), RECT);
    const form = theForm(p.Document, p);
    const res = form.dict.get('Resources') as PdfDict;
    expect(res.has('Font')).toBe(false);
    const pats = res.get('Pattern') as PdfDict;
    const tile = p.Document.resolve([...pats.values()][0]) as PdfStream;
    const tres = tile.dict.get('Resources') as PdfDict;
    expect((tres.get('Font') as PdfDict).size).toBe(1);
  });

  it('nests a pattern inside a pattern', () => {
    const p = page();
    const r = p.AddSVGObject(svg('<svg viewBox="0 0 20 20"><defs>' +
      '<pattern id="inner" width="2" height="2" patternUnits="userSpaceOnUse">' +
      '<rect width="1" height="1" fill="#00ff00"/></pattern>' +
      '<pattern id="outer" width="8" height="8" patternUnits="userSpaceOnUse">' +
      '<rect width="6" height="6" fill="url(#inner)"/></pattern></defs>' +
      '<rect width="20" height="20" fill="url(#outer)"/></svg>'), RECT);
    expect(r.skipped).toEqual([]);
    const res = theForm(p.Document, p).dict.get('Resources') as PdfDict;
    const outer = p.Document.resolve(
      [...(res.get('Pattern') as PdfDict).values()][0]) as PdfStream;
    const ores = outer.dict.get('Resources') as PdfDict;
    expect(ores.has('Pattern')).toBe(true);   // the inner tile lives here
  });

  it('survives a Save/Open round trip', () => {
    const p = page();
    p.AddSVGObject(svg(P), RECT);
    const rt = Document.Open(p.Document.Save());
    const res = theForm(rt, rt.Pages[0]).dict.get('Resources') as PdfDict;
    const tile = rt.resolve([...(rt.resolve(res.get('Pattern')) as PdfDict).values()][0]);
    expect(isStream(tile)).toBe(true);
  });
});
```

Add `isRef` to the `types.js` import at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/svg-embed.test.ts`
Expected: the tile-only-font test FAILS if Task 2's filter is wrong; the others
should pass with Task 3's placeholder sink, which already allocates correctly.

- [ ] **Step 3: Promote the placeholder to a named implementation**

In `src/svgembed.ts`, replace the inline object with a documented one:

```ts
/** The sink svgdraw.ts uses to turn a built tile into a PDF object. This module
 *  is the only one that may allocate, which is why the walker takes a sink
 *  rather than building the stream itself. */
function tileSink(doc: Document): SvgTileSink {
  return {
    tile: (dict, content) =>
      doc.allocObject({ kind: 'stream', dict, raw: enc(content) }),
  };
}
```

and pass `tileSink(doc)` to `drawSvg`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/svg-embed.test.ts && npm run typecheck && npm test`
Expected: all green. Paste the vitest summary line into the session.

- [ ] **Step 5: Commit**

```bash
git add src/svgembed.ts test/svg-embed.test.ts
git commit -m "feat(svg): allocate tile streams from svgembed (1gg0.19)

The observable difference from a shading pattern, which stays a direct dict:
a tiling pattern is an indirect reference to a stream. A font used only
inside a tile now lands in the tile's own /Resources, which the form must
not carry -- the assertion Task 2's refactor could not make on its own.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The cross-implementation check

`raster.ts` implements tiling patterns independently (`blitTile` replicates a cell across the clip bbox on the pattern lattice, reading `/Matrix`, `/XStep` and `/YStep` itself). Rendering through it is a genuine writer-versus-reader check — what CLAUDE.md's differential rule asks for, and what `1gg0.11` could not have.

**Files:**
- Create: `test/svg-pattern-render.test.ts`

- [ ] **Step 1: Write the tests**

Create `test/svg-pattern-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildSvgPdf } from './helpers/build-svg-fixtures.js';
import { decodePng, type DecodedPng } from './helpers/decode-png.js';

const svg = (s: string) => new TextEncoder().encode(s);

/** Place `src` over a 200x200 page at 1 px per point, so an SVG unit in a
 *  200-unit viewBox is one device pixel and SVG y maps 1:1 onto device y.
 *
 *  raster.ts rasterizes tiling patterns with its own reading of /Matrix,
 *  /XStep and /YStep, so these assertions do not round-trip through the code
 *  that produced them. */
function render(src: string) {
  const p = Document.Open(buildSvgPdf({ mediaBox: [0, 0, 200, 200], content: '' })).Pages[0];
  const r = p.AddSVGObject(svg(src), [0, 0, 200, 200], { fit: 'fill' });
  const rt = Document.Open(p.Document.Save());
  return { png: decodePng(rt.Pages[0].ToImage()), skipped: r.skipped };
}

const isRed = (png: DecodedPng, x: number, y: number): boolean => {
  const [r, g, b] = png.at(x, y);
  return r > 200 && g < 80 && b < 80;
};

/** A 100x100 checkerboard cell: red square in the top-left quadrant only. */
const CHECKER =
  '<svg viewBox="0 0 200 200"><defs>' +
  '<pattern id="p" width="100" height="100" patternUnits="userSpaceOnUse">' +
  '<rect width="50" height="50" fill="#ff0000"/></pattern></defs>' +
  '<rect width="200" height="200" fill="url(#p)"/></svg>';

describe('AddSVGObject — patterns through Save/Open/ToImage', () => {
  it('tiles the cell across the shape on the XStep/YStep lattice', () => {
    const { png, skipped } = render(CHECKER);
    expect(skipped).toEqual([]);
    // Four cells at 100pt spacing; the red square occupies the first quadrant
    // of each. Sampling all four proves the lattice, not just the first cell.
    for (const [cx, cy] of [[0, 0], [100, 0], [0, 100], [100, 100]]) {
      expect(isRed(png, cx + 25, cy + 25)).toBe(true);    // inside the square
      expect(isRed(png, cx + 75, cy + 75)).toBe(false);   // the empty quadrant
    }
  });

  it('places the tile origin where x and y ask', () => {
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<pattern id="p" x="50" y="50" width="100" height="100" patternUnits="userSpaceOnUse">' +
      '<rect width="50" height="50" fill="#ff0000"/></pattern></defs>' +
      '<rect width="200" height="200" fill="url(#p)"/></svg>');
    // Shifting the tile by (50,50) moves the red square with it.
    expect(isRed(png, 75, 75)).toBe(true);
    expect(isRed(png, 25, 25)).toBe(false);
  });

  it('scales the tile under objectBoundingBox units', () => {
    // Default patternUnits: width 0.5 of a 200-wide box = a 100pt cell.
    const { png, skipped } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<pattern id="p" width="0.5" height="0.5">' +
      '<rect width="50" height="50" fill="#ff0000"/></pattern></defs>' +
      '<rect width="200" height="200" fill="url(#p)"/></svg>');
    expect(skipped).toEqual([]);
    expect(isRed(png, 25, 25)).toBe(true);
    expect(isRed(png, 125, 25)).toBe(true);
    expect(isRed(png, 75, 75)).toBe(false);
  });

  it('spills across cell boundaries under overflow visible', () => {
    // The square is bigger than the cell, so with overflow:visible it reaches
    // into the neighbouring cell; clipped, it could not.
    const { png } = render(
      '<svg viewBox="0 0 200 200"><defs>' +
      '<pattern id="p" width="100" height="100" patternUnits="userSpaceOnUse" ' +
      'overflow="visible"><rect width="150" height="20" fill="#ff0000"/></pattern>' +
      '</defs><rect width="200" height="200" fill="url(#p)"/></svg>');
    expect(isRed(png, 120, 10)).toBe(true);     // past the 100pt cell edge
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/svg-pattern-render.test.ts`
Expected: PASS. If a sample lands on a cell boundary, move it to a cell centre —
but do **not** loosen the lattice assertions: four cells sampled is what proves
`/XStep` and `/YStep`, and one cell alone would pass on a broken lattice.

- [ ] **Step 3: Prove the lattice assertion is load-bearing**

In `tilingFor`, temporarily set `/XStep` and `/YStep` to twice `rect.w`/`rect.h`.
Run: `npx vitest run test/svg-pattern-render.test.ts`
Expected: the tiling test FAILS at the second cell. Revert and confirm green.

- [ ] **Step 4: Commit**

```bash
git add test/svg-pattern-render.test.ts
git commit -m "test(svg): rasterize tiling patterns end to end (1gg0.19)

raster.ts implements tiling itself -- blitTile replicates a cell across the
clip bbox with its own reading of /Matrix, /XStep and /YStep -- so this is a
real writer-versus-reader check rather than a round trip through one body of
code. Four cells are sampled, since one alone passes on a broken lattice.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Documentation and close-out

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

In the **SVG embedding** bullet (search `AddSVGObject`), remove `<pattern>` from
the not-rendered list and add after the gradient sentences:

```markdown
**Patterns** — `<pattern>` becomes a PDF tiling pattern: `x`/`y`/`width`/`height` under `patternUnits` (`objectBoundingBox` default or `userSpaceOnUse`), `patternContentUnits`, `patternTransform`, `viewBox` + `preserveAspectRatio`, and `href`/`xlink:href` reuse between pattern elements. Tile content is anything the walker can draw — shapes, groups, `use`, clip paths, gradients, text, and nested patterns behind a cycle guard — emitted as the pattern's own content stream with its own resources. `overflow="visible"` is honoured by growing the pattern's `/BBox` past its step, so cells overlap and content spills; where spilled content overlaps a neighbouring cell, PDF leaves the paint order between cells implementation-dependent, so stacking may differ from a browser's. A pattern with no children, or with a zero-area tile, paints nothing and is *not* reported — SVG mandates that outcome, as it does for a stopless gradient.
```

Update the API-table row for `page.AddSVGObject` to mention pattern support.

- [ ] **Step 2: Run the full gate**

Run: `npm run typecheck && npm test`
Expected: both green, with the summary line pasted into the session.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "docs(svg): document <pattern> support (1gg0.19)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status
```

`git status` MUST show the branch up to date with origin.

- [ ] **Step 4: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-1gg0.19
```

- [ ] **Step 5: Record what was learned**

```bash
bd remember --key svg-pattern-shipped "1gg0.19 shipped. <pattern> -> PDF PatternType 1. src/svgpattern.ts is pure (href inheritance, tileRect, tileMatrix); svgdraw builds tile content with a CHILD Emitter (indexes/provider/sink/cycle-guards shared, output and resource maps FORKED, because a tile's stream has its own /Resources and cannot see the form's). THE structural fact: a tiling pattern IS a stream and streams must be indirect, so svgdraw -- which allocates nothing -- takes an SvgTileSink that svgembed implements, exactly as SvgFontProvider solved the same problem in 1gg0.8. A shading pattern stays a DIRECT dict; a tiling pattern is an indirect ref. TRAPS: (1) canon() had no ref case, so every PdfRef stringified to [object Object] and two tiles deduped as one -- fixed first, separately. (2) /Resources assembly had to move out of svgembed into the walker and become per-emitter, or a tile-only font lands in the form's /Font and the tile's /F0 does not resolve. (3) the viewBox/patternContentUnits transform is returned SEPARATELY from /Matrix and emitted as a cm inside the tile stream: folding it into /Matrix would scale /XStep and /YStep along with the artwork. (4) overflow:visible = /BBox covering the ink while /XStep and /YStep stay at the tile size, so cells overlap; inter-cell paint order is implementation-dependent, documented not reported. Verification: unlike 1gg0.11, raster.ts implements tiling ITSELF (blitTile), so test/svg-pattern-render.test.ts is a genuine writer-vs-reader check -- sample FOUR cells, one alone passes on a broken lattice."
```

- [ ] **Step 6: Verify**

Run: `bd show aspose-pdf-foss-for-ts-1gg0.19 && git status`
Expected: closed, clean tree, up to date with origin.

---

## Notes for the implementer

**Task 1 lands alone and first.** The `canon` fix is a latent bug in shipped code, not part of the feature. Keeping it separate means it can be reverted or cherry-picked on its own.

**Task 2 is not self-proving.** Filtering `/Font` by used keys produces identical output today, because there is only one content stream. The assertion that proves it is in Task 8 (a tile-only font absent from the form). Do not skip Task 8's second test.

**Do not fold the content transform into `/Matrix`.** `/BBox`, `/XStep` and `/YStep` are all in pattern space. A `viewBox` scale in `/Matrix` scales the tile *spacing* too, which looks nearly right at scale 1 and drifts visibly otherwise.

**`resolvePaint` is shared with `1gg0.8`'s text path.** Widening it to patterns gives pattern-filled text for free — but note `1z2m`: `ToImage` renders pattern-filled *glyphs* as flat colour, so do not write a rasterized assertion for that combination.
