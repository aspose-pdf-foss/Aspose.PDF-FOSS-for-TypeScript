# Annotation Appearance-Text Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Page.SearchAnnotations(find, options?)`, which finds text drawn inside annotations' `/AP` appearance streams — a `/FreeText`'s visible words, a filled form field's value — which `Page.Search` cannot see.

**Architecture:** A new `src/annotsearch.ts` resolves each visible annotation's appearance through the existing `isAnnotVisible` + `resolveAppearance` predicates, walks it with a new neutral `visitFormContent` primitive in `text.ts`, and assembles **one `layoutLines` per annotation**. `TextMatch`, `searchText`, `replaceText`, `redactText` and `markRedactText` are not touched.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-08-17-annotation-appearance-search-design.md`

## Global Constraints

- **Zero runtime dependencies.** Do not add npm runtime deps.
- **ESM + NodeNext.** Every relative import specifier carries the `.js` extension (`import { Page } from './page.js'`), even from a `.ts` file.
- **Do not modify** `searchText`, `replaceText`, `redactText`, `markRedactText`, `TextMatch`, or `ContentAddr`. The full suite staying green is the fence for that claim.
- **`findRanges` and `buildMatch` get exactly one owner** — `textedit.ts`. Never copy either into `annotsearch.ts`.
- **No `GlyphEvent` may escape `annotsearch.ts`.** `AnnotationMatch` carries `annot`, `text` and `quads` only.
- **One `layoutLines` assembly per annotation**, never one shared across annotations or with page content.
- Run `npm run typecheck` and `npm test` before closing. Target one file with `npx vitest run test/<name>.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/text.ts` (modify) | Gains `visitFormContent` — walk one Form XObject at a given placement, `Do` semantics. Knows nothing about annotations (it cannot: `annotappearance.ts` value-imports `placementMatrix` from here, so importing back closes a cycle). |
| `src/textedit.ts` (modify) | Exports `findRanges` and `buildMatch`. No behaviour change. |
| `src/annotsearch.ts` (create) | The whole feature: `AnnotationMatch`, `searchAnnotations`. Holds every dependency on `annotation.ts` and `annotappearance.ts`. |
| `src/page.ts` (modify) | `Page.SearchAnnotations`. |
| `src/index.ts` (modify) | Public export of `searchAnnotations` + `AnnotationMatch`. |
| `test/helpers/build-annot-text-pdf.ts` (create) | One fixture page carrying seven annotations covering every case. |
| `test/annot-search.test.ts` (create) | All assertions. |

---

## The Fixture, Once

Task 1 creates the fixture and every later task reuses it unchanged. Its geometry is load-bearing, so here is the whole map. Page is `MediaBox [0 0 300 300]`, one shared Helvetica font `/F1` with no `/Widths` (Standard-14 AFM metrics path).

| What | Object | `/Rect` | AP `/BBox` | AP content | Resulting device baseline |
|---|---|---|---|---|---|
| page content: `alpha` | 4 | — | — | `BT /F1 10 Tf 20 100 Td (alpha) Tj ET` | y=100, x from 20 |
| `/FreeText` `bravo` | 6 → AP 7 | `[120 95 220 115]` | `[0 0 100 20]` | `BT /F1 10 Tf 2 5 Td (bravo) Tj ET` | y=100, x from 122 |
| `/Widget` `charlie` | 8 → AP 9 | `[20 200 220 220]` | `[0 0 200 20]` | `... 2 5 Td (charlie) Tj ...` | y=205, x from 22 |
| hidden (`/F 2`) `delta` | 10 → AP 11 | `[20 250 220 270]` | `[0 0 200 20]` | `... 2 5 Td (delta) Tj ...` | y=255 |
| `/Popup` `echo` | 12 → AP 13 | `[20 30 220 50]` | `[0 0 200 20]` | `... 2 5 Td (echo) Tj ...` | y=35 |
| malformed `foxtrot` | 14 → AP 15 | `[20 150 220 170]` | `[0 0 200 20]` | AP has `/Filter /NotAFilter` | throws on decode |
| `/Matrix` `golf` | 16 → AP 17 | `[20 60 120 80]` | `[0 0 100 20]`, `/Matrix [1 0 0 1 500 500]` | `... 2 5 Td (golf) Tj ...` | y=65, x from 22 |

**Why `bravo` shares y=100 with the page's `alpha`:** `layoutLines` groups by baseline with tolerance `max(2, 0.5 * size)` = 5pt at 10pt, and inserts exactly one space between runs on a line whose gap exceeds `0.25 * size`. Equal baselines plus a ~77pt gap means a *shared* assembly would produce the literal string `alpha bravo`. That is the trap Task 3 pins.

**Why `golf` uses `/Matrix [1 0 0 1 500 500]`:** `placementMatrix` maps the `/Matrix`-transformed BBox `[500 500 600 520]` onto `/Rect [20 60 120 80]`, giving `place = [1 0 0 1 -480 -440]`. Correct code composes `mul(Matrix, place) = translate(20, 60)`, so `Td 2 5` lands at device `(22, 65)`. Code that forgets to re-apply `/Matrix` puts it at `(-478, -435)`, far off the page. The two answers cannot be confused.

**`/Annots` order is `[6 8 10 12 14 16]`** — the malformed `foxtrot` sits *before* `golf`, which is what makes Task 4's degradation assertion meaningful.

---

### Task 1: The walk, the search, and the public API

**Files:**
- Create: `test/helpers/build-annot-text-pdf.ts`
- Create: `test/annot-search.test.ts`
- Create: `src/annotsearch.ts`
- Modify: `src/text.ts` (add `visitFormContent` immediately after `visitContent`)
- Modify: `src/textedit.ts` (export the existing `findRanges` and `buildMatch`)
- Modify: `src/page.ts` (add `SearchAnnotations` immediately after `Search`)
- Modify: `src/index.ts` (add exports beside the `textedit.js` ones)

Locate every insertion point by **symbol name, not line number** — this repo's line numbers have been wrong twice, which is why `CLAUDE.md` and the c3t7 epic both say to name the symbol.

**Interfaces:**
- Consumes: `isAnnotVisible(doc, annot)`, `resolveAppearance(doc, annot)` from `./annotappearance.js`; `wrapAnnotation(doc, dict)` and class `Annotation` from `./annotation.js`; `layoutLines`, `runFromGlyph`, `mul`, types `Matrix`/`Rect`/`GlyphEvent`/`RefRun`/`ContentVisitor` from `./text.js`; `SearchOptions` from `./textedit.js`.
- Produces, relied on by every later task:
  - `visitFormContent(doc: Document, stream: PdfStream, fallbackResources: PdfDict | undefined, base: Matrix, visitor: ContentVisitor): void` — in `text.ts`.
  - `findRanges(text: string, find: string | RegExp): [number, number][]` and `buildMatch(text: string, refs: (GlyphEvent | undefined)[], start: number, end: number): TextMatch` — exported from `textedit.ts`.
  - `interface AnnotationMatch { annot: Annotation; text: string; quads: Rect[] }` and `searchAnnotations(doc: Document, page: Page, find: string | RegExp, opts?: SearchOptions): AnnotationMatch[]` — in `annotsearch.ts`.
  - `Page.SearchAnnotations(find: string | RegExp, options?: SearchOptions): AnnotationMatch[]`.
  - `buildAnnotTextPdf(): Uint8Array` — in `test/helpers/build-annot-text-pdf.ts`.

---

- [ ] **Step 1: Write the fixture builder**

Create `test/helpers/build-annot-text-pdf.ts`. It mirrors `test/helpers/build-text-pdf.ts`'s style exactly (same `enc`/`byteLen`/`serialize`/`contentObj` shape — copy them, that file does not export them).

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

interface Obj { [n: number]: string }

/** Serialize numbered objects (1..maxObj) into a classic-xref PDF. */
function serialize(objects: Obj, maxObj: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    if (!objects[n]) continue;
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function contentObj(stream: string, extra = ''): string {
  return `<< /Length ${byteLen(stream)} ${extra}>>\nstream\n${stream}\nendstream`;
}

/** An appearance stream: a Form XObject sharing the page's /F1 font. */
function apObj(bbox: string, body: string, extra = ''): string {
  return contentObj(body, `/Type /XObject /Subtype /Form /BBox [${bbox}] ` +
    `/Resources << /Font << /F1 5 0 R >> >> ${extra}`);
}

/** Draw `word` at (2, 5) inside an appearance stream, 10pt Helvetica. */
const draw = (word: string) => `BT /F1 10 Tf 2 5 Td (${word}) Tj ET`;

/**
 * One 300x300 page carrying page text "alpha" at baseline y=100 plus seven
 * annotations. See docs/superpowers/plans/2026-08-17-annotation-appearance-search.md
 * for the full geometry map and why each case is shaped as it is.
 *
 * "bravo" deliberately shares baseline y=100 with the page's "alpha": a shared
 * layoutLines assembly would splice them into the single line "alpha bravo",
 * which is the phantom match the per-annotation assembly exists to prevent.
 */
export function buildAnnotTextPdf(): Uint8Array {
  const objects: Obj = {
    1: `<< /Type /Catalog /Pages 2 0 R >>`,
    2: `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 300 300] >>`,
    3: `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> ` +
       `/Contents 4 0 R /Annots [6 0 R 8 0 R 10 0 R 12 0 R 14 0 R 16 0 R] >>`,
    4: contentObj('BT /F1 10 Tf 20 100 Td (alpha) Tj ET'),
    5: `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,

    // Shares the page text's baseline — the interleaving case.
    6: `<< /Type /Annot /Subtype /FreeText /Rect [120 95 220 115] /AP << /N 7 0 R >> >>`,
    7: apObj('0 0 100 20', draw('bravo')),

    // A filled form field: its value is drawn only in the appearance.
    8: `<< /Type /Annot /Subtype /Widget /FT /Tx /T (f1) /V (charlie) ` +
       `/Rect [20 200 220 220] /AP << /N 9 0 R >> >>`,
    9: apObj('0 0 200 20', draw('charlie')),

    // /F 2 = Hidden.
    10: `<< /Type /Annot /Subtype /FreeText /F 2 /Rect [20 250 220 270] /AP << /N 11 0 R >> >>`,
    11: apObj('0 0 200 20', draw('delta')),

    12: `<< /Type /Annot /Subtype /Popup /Rect [20 30 220 50] /AP << /N 13 0 R >> >>`,
    13: apObj('0 0 200 20', draw('echo')),

    // Unknown filter: decodeStream throws UnsupportedFeatureError on this one.
    // Placed BEFORE "golf" so that degradation is observable.
    14: `<< /Type /Annot /Subtype /FreeText /Rect [20 150 220 170] /AP << /N 15 0 R >> >>`,
    15: apObj('0 0 200 20', draw('foxtrot'), '/Filter /NotAFilter '),

    // /Matrix must be re-applied on top of the placement matrix.
    16: `<< /Type /Annot /Subtype /FreeText /Rect [20 60 120 80] /AP << /N 17 0 R >> >>`,
    17: apObj('0 0 100 20', draw('golf'), '/Matrix [1 0 0 1 500 500] '),
  };
  return serialize(objects, 17);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/annot-search.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildAnnotTextPdf } from './helpers/build-annot-text-pdf.js';

const page = () => Document.Open(buildAnnotTextPdf()).Pages[0];

describe('SearchAnnotations', () => {
  it('finds text drawn only inside an /AP appearance stream', () => {
    const hits = page().SearchAnnotations('bravo');
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe('bravo');
    expect(hits[0].annot.Subtype).toBe('FreeText');
  });

  it("finds a form field's value, which lives only in its appearance", () => {
    const hits = page().SearchAnnotations('charlie');
    expect(hits).toHaveLength(1);
    expect(hits[0].annot.Subtype).toBe('Widget');
  });

  it('matches a RegExp globally, like Search', () => {
    expect(page().SearchAnnotations(/b.avo/)).toHaveLength(1);
  });

  // Both directions of the split: neither entry point sees the other's text.
  it('does not return page content text', () => {
    expect(page().SearchAnnotations('alpha')).toHaveLength(0);
  });

  it('Search still does not return appearance text', () => {
    expect(page().Search('bravo')).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/annot-search.test.ts`
Expected: FAIL — `page().SearchAnnotations is not a function`.

- [ ] **Step 4: Add `visitFormContent` to `src/text.ts`**

Insert immediately after the `visitContent` function. `nums`, `resolveDict`, `mul`, `inflateStream`, `walkScope`, `Ctx` and `PdfStream` are all already available in this file — add no imports.

```ts
/** Walk one Form XObject's content as though `cm base` + `Do` had drawn it: the
 *  stream's own /Matrix is applied on top of `base`, and its /Resources fall
 *  back to `fallbackResources`. Deliberately the same rule as `walkScope`'s `Do`
 *  case — a second placement rule is how a form comes to be measured in one
 *  place and drawn in another.
 *
 *  This function knows nothing about annotations and must not learn:
 *  `annotappearance.ts` value-imports `placementMatrix` from this module, so
 *  importing `isAnnotVisible`/`resolveAppearance` back would close a cycle.
 *  `annotsearch.ts` owns that half.
 *
 *  **Invariant:** the `GlyphEvent.addr` on this walk is `{ path: [],
 *  streamIndex: 0 }`, which names the page's first content stream and is a lie
 *  — an /AP stream is not addressable by `ContentAddr`, whose `path` is a chain
 *  of XObject resource names descended from the page. No event from here may
 *  reach a consumer that acts on `addr`; `AnnotationMatch` carries none, and a
 *  fabricated path would throw `XObject /X not found` inside
 *  `EditableContent.cowXObject` rather than degrade. */
export function visitFormContent(
  doc: Document, stream: PdfStream, fallbackResources: PdfDict | undefined,
  base: Matrix, visitor: ContentVisitor,
): void {
  const ctx: Ctx = { doc, visitor, fontCache: new Map() };
  const mat = nums(doc.resolve(stream.dict.get('Matrix')) as PdfObject[] | undefined);
  const ctm = mat.length === 6 ? mul(mat as Matrix, base) : base;
  const res = resolveDict(doc, stream.dict.get('Resources')) ?? fallbackResources;
  walkScope(ctx, [{ bytes: inflateStream(stream), streamIndex: 0 }], res, [], ctm, 0, new Set());
}
```

- [ ] **Step 5: Export `findRanges` and `buildMatch` from `src/textedit.ts`**

Two one-word edits: change `function findRanges(` to `export function findRanges(`, and `function buildMatch(` to `export function buildMatch(`. Then extend each doc comment with its shared-owner note:

On `findRanges`, append to the existing comment:
```
 *  Exported for `annotsearch.ts`: the rule that a RegExp is always applied
 *  globally regardless of its own `g` flag has exactly one owner.
```

On `buildMatch`, append:
```
 *  Exported for `annotsearch.ts`, which uses `text` and `quads` and drops
 *  `hits` — that discard is the single point where a `GlyphEvent` from an
 *  appearance-stream walk stops travelling.
```

Change nothing else in this file.

- [ ] **Step 6: Create `src/annotsearch.ts`**

```ts
// Search the text an annotation DRAWS: the words inside its /AP appearance
// stream — a /FreeText's visible text, a filled form field's value — which
// `searchText` cannot see, because `visitContent` walks page content only.
//
// Its own module rather than part of textedit.ts for the reason redactannots.ts
// is its own module rather than part of redact.ts: textedit.ts is
// content-stream search and edit, and this is /Annots object-graph work that
// happens to end in a search. It also holds textedit.ts free of a dependency on
// annotation.ts, the way runlink.ts holds stamp.ts's to one symbol.
import type { Document } from './document.js';
import type { Page } from './page.js';
import type { GlyphEvent, Rect, RefRun } from './text.js';
import { visitFormContent, layoutLines, runFromGlyph } from './text.js';
import { isAnnotVisible, resolveAppearance } from './annotappearance.js';
import { Annotation, wrapAnnotation } from './annotation.js';
import { findRanges, buildMatch, type SearchOptions } from './textedit.js';
import { isArray, isDict } from './types.js';

/** A match in the text one annotation's appearance stream draws.
 *
 *  Deliberately carries no `GlyphEvent`, unlike {@link TextMatch}: an /AP
 *  stream is not addressable by `ContentAddr`, so any provenance here would be
 *  a value no consumer could act on. */
export interface AnnotationMatch {
  /** The annotation whose appearance drew the matched text. */
  annot: Annotation;
  /** The matched substring of that annotation's assembled appearance text. */
  text: string;
  /** Page-space boxes [x0,y0,x1,y1], one per line the match spans. */
  quads: Rect[];
}

const centroidOf = (q: Rect): [number, number] => [(q[0] + q[2]) / 2, (q[1] + q[3]) / 2];
const inRect = (r: Rect, x: number, y: number): boolean =>
  x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

/** Find every occurrence of `find` in the text drawn by the page's annotations.
 *  A string is matched literally; a RegExp is always applied globally. Results
 *  come back in /Annots order, reading order within each annotation.
 *
 *  Only annotations a static render would draw are searched (`isAnnotVisible`:
 *  not Hidden, not NoView, not a /Popup), so this agrees with `ToImage`,
 *  `ToSvg` and `FlattenAnnotations` about exactly which annotations count.
 *
 *  **Invariant:** ONE `layoutLines` assembly per annotation, never one shared
 *  across annotations or with page content. `layoutLines` groups runs by
 *  baseline Y and orders them by X, so a note drawn over a paragraph shares its
 *  line: a shared assembly would splice the note's words into the paragraph's
 *  and match a query spanning both — a phantom match, not a feature.
 *
 *  **Invariant:** no `GlyphEvent` escapes this module. `buildMatch` produces
 *  `hits`, and they are dropped here; see `visitFormContent` for why an
 *  appearance stream has no honest `ContentAddr`. */
export function searchAnnotations(
  doc: Document, page: Page, find: string | RegExp, opts: SearchOptions = {},
): AnnotationMatch[] {
  const annots = doc.resolve(page.Dict.get('Annots'));
  if (!isArray(annots)) return [];
  const region = opts.region;
  const out: AnnotationMatch[] = [];

  for (const e of annots) {
    const dict = doc.resolve(e);
    if (!isDict(dict) || !isAnnotVisible(doc, dict)) continue;
    const ap = resolveAppearance(doc, dict);
    if (ap === undefined) continue;

    const runs: RefRun<GlyphEvent>[] = [];
    try {
      visitFormContent(doc, ap.stream, page.Resources, ap.place, {
        glyph: (g) => {
          if (!g.text) return;
          if (region && !inRect(region, ...centroidOf(g.quad))) return;
          runs.push(runFromGlyph(g, g));
        },
      });
    } catch {
      // Degrade exactly as pagerender.ts's drawAnnots does: a malformed
      // appearance costs only itself and must not drop the ones after it.
      continue;
    }
    if (runs.length === 0) continue;

    const { text, refs } = layoutLines(runs);
    if (text.length === 0) continue;
    const annot = wrapAnnotation(doc, dict);
    for (const [start, end] of findRanges(text, find)) {
      const m = buildMatch(text, refs, start, end);
      out.push({ annot, text: m.text, quads: m.quads });
    }
  }
  return out;
}
```

- [ ] **Step 7: Add `Page.SearchAnnotations` to `src/page.ts`**

Add the import beside the existing `textedit.js` import:

```ts
import { searchAnnotations, type AnnotationMatch } from './annotsearch.js';
```

Then insert this method directly after the `Search` method:

```ts
  /** Find every occurrence of `find` (a literal string or RegExp) in the text
   *  the page's annotations DRAW — a /FreeText's visible words, a filled form
   *  field's value — which `Search` does not see, because it walks page content
   *  streams only. Each match carries the annotation, the matched substring and
   *  one page-space quad per line it spans. Only annotations a static render
   *  would draw are searched (not Hidden, not NoView, not a /Popup). A RegExp is
   *  always applied globally.
   *
   *  Unlike `Search`, a match carries no glyph provenance: an appearance stream
   *  is not addressable by the content-edit layer, so there is nothing a caller
   *  could act on. To redact what this finds, pass the quads to `Redact` —
   *  which removes any annotation whose /Rect they intersect, the whole
   *  annotation being the only granularity available. */
  SearchAnnotations(find: string | RegExp, options?: SearchOptions): AnnotationMatch[] {
    return searchAnnotations(this.doc, this, find, options);
  }
```

- [ ] **Step 8: Export from `src/index.ts`**

Add directly after the `export type { TextMatch, SearchOptions } from './textedit.js';` line:

```ts
export { searchAnnotations } from './annotsearch.js';
export type { AnnotationMatch } from './annotsearch.js';
```

`visitFormContent` is **not** exported here — see its invariant.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 10: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 11: Commit**

```bash
git add src/annotsearch.ts src/text.ts src/textedit.ts src/page.ts src/index.ts test/annot-search.test.ts test/helpers/build-annot-text-pdf.ts
git commit -m "$(cat <<'EOF'
feat(search): find text drawn inside annotation appearance streams

Page.SearchAnnotations walks each visible annotation's /AP through a new
neutral visitFormContent primitive and assembles one layoutLines per
annotation. searchText and its four consumers are untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Quads are glyph boxes, and /Matrix is honoured

**Files:**
- Modify: `test/annot-search.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Page.SearchAnnotations`, `AnnotationMatch.quads`, `buildAnnotTextPdf` (Task 1).
- Produces: nothing new.

Why this task exists separately: the whole point of shipping reading (b) rather than reading (a) is that quads are *tight glyph boxes*, not the `/Rect`. A containment-only assertion passes for a `/Rect`-sized quad, so it must be asserted **strictly smaller**.

- [ ] **Step 1: Write the failing tests**

Append to `test/annot-search.test.ts`:

```ts
describe('SearchAnnotations geometry', () => {
  it('returns tight glyph boxes, not the annotation /Rect', () => {
    const hits = page().SearchAnnotations('bravo');
    const [x0, y0, x1, y1] = hits[0].quads[0];
    // Inside /Rect [120 95 220 115]...
    expect(x0).toBeGreaterThanOrEqual(120);
    expect(y0).toBeGreaterThanOrEqual(95);
    expect(x1).toBeLessThanOrEqual(220);
    expect(y1).toBeLessThanOrEqual(115);
    // ...and strictly SMALLER than it. Containment alone is satisfied by a
    // /Rect-sized quad, which is the shape this feature exists to avoid.
    expect((x1 - x0) * (y1 - y0)).toBeLessThan(0.5 * (220 - 120) * (115 - 95));
  });

  it('places glyphs where the appearance actually draws them', () => {
    // AP BBox [0 0 100 20] maps onto /Rect [120 95 220 115] 1:1, and the text
    // is drawn at Td 2 5 in 10pt, so the box is x from 122, y 100..110.
    const [x0, y0, , y1] = page().SearchAnnotations('bravo')[0].quads[0];
    expect(x0).toBeCloseTo(122, 1);
    expect(y0).toBeCloseTo(100, 1);
    expect(y1).toBeCloseTo(110, 1);
  });

  it('one quad per line the match spans', () => {
    expect(page().SearchAnnotations('bravo')[0].quads).toHaveLength(1);
  });

  it("re-applies the appearance stream's own /Matrix on top of the placement", () => {
    // /Matrix [1 0 0 1 500 500] with BBox [0 0 100 20] gives a transformed box
    // of [500 500 600 520], which placementMatrix maps onto /Rect [20 60 120 80]
    // as translate(-480,-440). Composing the two gives translate(20,60), so
    // Td 2 5 lands at (22, 65). Code that drops the /Matrix puts it at
    // (-478, -435) — off the page, and nowhere near a plausible answer.
    const hits = page().SearchAnnotations('golf');
    expect(hits).toHaveLength(1);
    const [x0, y0] = hits[0].quads[0];
    expect(x0).toBeCloseTo(22, 1);
    expect(y0).toBeCloseTo(65, 1);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. Task 1's implementation already satisfies these — these are the assertions that pin it. If the `/Matrix` case fails, `visitFormContent` is missing the `mul(mat, base)` composition from Task 1 Step 4.

- [ ] **Step 3: Prove the /Matrix assertion load-bearing**

In `src/text.ts`, temporarily change `visitFormContent`'s composition to ignore the stream matrix:

```ts
  const ctm = base;   // TEMPORARY — must go red
```

Run: `npx vitest run test/annot-search.test.ts`
Expected: FAIL on `re-applies the appearance stream's own /Matrix`, reporting a received x0 near -478.

- [ ] **Step 4: Revert the mutation**

Restore the line to:

```ts
  const ctm = mat.length === 6 ? mul(mat as Matrix, base) : base;
```

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. Confirm `git diff src/text.ts` is empty.

- [ ] **Step 5: Commit**

```bash
git add test/annot-search.test.ts
git commit -m "$(cat <<'EOF'
test(search): pin annotation match quads as tight glyph boxes

Asserts the box is strictly smaller than the /Rect, not merely inside it —
containment alone is satisfied by the /Rect-sized quad this feature exists to
avoid. The /Matrix case was confirmed to go red with the composition removed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: One assembly per annotation — the load-bearing invariant

**Files:**
- Modify: `test/annot-search.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Page.SearchAnnotations`, `Page.Search`, `buildAnnotTextPdf` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/annot-search.test.ts`:

```ts
describe('per-annotation assembly', () => {
  // The fixture puts the /FreeText's "bravo" on baseline y=100, the same
  // baseline as the page's "alpha", ~77pt to its right. layoutLines groups by
  // baseline (tolerance max(2, 0.5*size) = 5pt here) and inserts exactly one
  // space where the gap exceeds 0.25*size, so ONE shared assembly would produce
  // the literal line "alpha bravo".
  it('never matches across page content and an annotation', () => {
    expect(page().SearchAnnotations('alpha bravo')).toHaveLength(0);
    expect(page().Search('alpha bravo')).toHaveLength(0);
  });

  it('never matches across two annotations', () => {
    // "bravo" and "charlie" are on different baselines, so a shared assembly
    // would join them with a newline rather than a space — assert both spellings
    // so the test cannot pass by accident of the separator.
    expect(page().SearchAnnotations('bravo charlie')).toHaveLength(0);
    expect(page().SearchAnnotations('bravo\ncharlie')).toHaveLength(0);
  });

  it('proves the halves are individually present', () => {
    // Without this, the two assertions above would pass just as well if
    // SearchAnnotations found nothing at all.
    expect(page().SearchAnnotations('bravo')).toHaveLength(1);
    expect(page().SearchAnnotations('charlie')).toHaveLength(1);
    expect(page().Search('alpha')).toHaveLength(1);
  });

  it('returns matches in /Annots order', () => {
    const hits = page().SearchAnnotations(/bravo|charlie|golf/);
    expect(hits.map((h) => h.text)).toEqual(['bravo', 'charlie', 'golf']);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS.

- [ ] **Step 3: Prove the interleaving assertion load-bearing**

This is the invariant the whole design turns on, so it gets measured rather than assumed. Make exactly two temporary edits to `src/annotsearch.ts`.

Change the `text.js` import line to pull in `visitContent`:

```ts
import { visitContent, visitFormContent, layoutLines, runFromGlyph } from './text.js';
```

and, inside `searchAnnotations`, seed each annotation's run list with the page's own glyphs — the same defect as a shared assembly, reached without restructuring the loop. Replace:

```ts
    const runs: RefRun<GlyphEvent>[] = [];
```

with:

```ts
    // TEMPORARY — must go red
    const runs: RefRun<GlyphEvent>[] = [];
    visitContent(doc, page, { glyph: (g) => { if (g.text) runs.push(runFromGlyph(g, g)); } });
```

Run: `npx vitest run test/annot-search.test.ts`
Expected: FAIL on `never matches across page content and an annotation` — `SearchAnnotations('alpha bravo')` now returns 1.

- [ ] **Step 4: Revert the mutation**

Remove the `visitContent` call and drop `visitContent` from the `text.js` import.

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. Confirm `git diff src/annotsearch.ts` is empty.

- [ ] **Step 5: Commit**

```bash
git add test/annot-search.test.ts
git commit -m "$(cat <<'EOF'
test(search): pin one layoutLines assembly per annotation

A shared assembly splices a note's words into the line of the paragraph it
sits over, so "alpha bravo" would match across the two. Confirmed to go red
when the annotation runs are seeded with the page's own glyphs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Visibility filtering and degradation

**Files:**
- Modify: `test/annot-search.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Page.SearchAnnotations`, `buildAnnotTextPdf` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/annot-search.test.ts`:

```ts
describe('which annotations are searched', () => {
  // isAnnotVisible is the shared predicate pagerender.ts and flatten.ts use, so
  // search agrees with ToImage/ToSvg/FlattenAnnotations about what draws.
  it('skips a Hidden annotation (/F 2)', () => {
    expect(page().SearchAnnotations('delta')).toHaveLength(0);
  });

  it('skips a /Popup', () => {
    // A popup is the note window of a parent markup annotation; viewers draw it
    // only while the note is open.
    expect(page().SearchAnnotations('echo')).toHaveLength(0);
  });

  it('proves those two are otherwise findable text', () => {
    // Both carry a well-formed /AP drawing their word, so the two assertions
    // above are about visibility and not about a broken fixture.
    const doc = Document.Open(buildAnnotTextPdf());
    const p = doc.Pages[0];
    const hidden = p.Annotations.find((a) => a.Flags === 2)!;
    hidden.Flags = 0;
    expect(p.SearchAnnotations('delta')).toHaveLength(1);
  });

  it('skips a NoView annotation (/F 32)', () => {
    // The other bit isAnnotVisible tests: displayed on print only. The fixture
    // has no NoView annotation, so set the flag on one that is otherwise found —
    // which also proves the assertion is about the flag and nothing else.
    const doc = Document.Open(buildAnnotTextPdf());
    const p = doc.Pages[0];
    expect(p.SearchAnnotations('bravo')).toHaveLength(1);
    p.Annotations.find((a) => a.Subtype === 'FreeText' && a.Flags === 0)!.Flags = 32;
    expect(p.SearchAnnotations('bravo')).toHaveLength(0);
  });

  it('a malformed appearance costs only itself', () => {
    // Object 15 declares /Filter /NotAFilter, so decodeStream throws on it. It
    // sits BEFORE "golf" in /Annots, so a missing try/catch would drop golf too.
    const p = page();
    expect(p.SearchAnnotations('foxtrot')).toHaveLength(0);
    expect(p.SearchAnnotations('golf')).toHaveLength(1);
  });

  it('returns [] for a page with no /Annots at all', () => {
    const doc = Document.Open(buildAnnotTextPdf());
    doc.Pages[0].Dict.delete('Annots');
    expect(doc.Pages[0].SearchAnnotations('bravo')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS.

- [ ] **Step 3: Prove the degradation assertion load-bearing**

In `src/annotsearch.ts`, temporarily remove the `try`/`catch` around `visitFormContent`, leaving the call bare.

Run: `npx vitest run test/annot-search.test.ts`
Expected: FAIL — `UnsupportedFeatureError: unsupported decode filter: NotAFilter` thrown out of `a malformed appearance costs only itself`, before `golf` is ever reached.

- [ ] **Step 4: Revert the mutation**

Restore the `try`/`catch`.

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. Confirm `git diff src/annotsearch.ts` is empty.

- [ ] **Step 5: Commit**

```bash
git add test/annot-search.test.ts
git commit -m "$(cat <<'EOF'
test(search): pin annotation visibility filtering and degradation

Hidden and /Popup annotations are skipped via the shared isAnnotVisible, with
a companion assertion that both carry findable text once unhidden. The
malformed-/AP case was confirmed to go red with the try/catch removed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Region scoping

**Files:**
- Modify: `test/annot-search.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: `Page.SearchAnnotations`, `SearchOptions.region`, `buildAnnotTextPdf` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `test/annot-search.test.ts` (add `import type { Rect } from '../src/text.js';` to the file's imports):

```ts
describe('SearchAnnotations region scoping', () => {
  // Same rule as searchText and extractTables: a glyph is in or out by its
  // quad's CENTROID, never partly in.
  const BAND: Rect = [0, 190, 300, 230];   // covers "charlie" (baseline 205) only

  it('keeps only annotations whose glyphs fall inside the region', () => {
    const p = page();
    expect(p.SearchAnnotations('charlie', { region: BAND })).toHaveLength(1);
    expect(p.SearchAnnotations('bravo', { region: BAND })).toHaveLength(0);
  });

  it('decides a glyph by its CENTROID, not by overlap', () => {
    // "charlie" is 10pt on baseline 205, so its quads span y 205..215 and the
    // centroids sit at y=210. A region starting at 211 overlaps every quad but
    // excludes every centroid; an intersection rule would keep them all.
    const p = page();
    expect(p.SearchAnnotations('charlie', { region: [0, 211, 300, 300] })).toHaveLength(0);
    expect(p.SearchAnnotations('charlie', { region: [0, 209, 300, 300] })).toHaveLength(1);
  });

  it('does NOT find a match straddling the region boundary', () => {
    // Filtering happens before line assembly, so a region cutting through a word
    // leaves only the glyphs inside it and the whole word is no longer there to
    // match. Correct, and the behaviour someone will later mistake for a bug.
    const cut: Rect = [0, 190, 37, 230];    // keeps roughly "cha"
    const p = page();
    expect(p.SearchAnnotations('charlie', { region: cut })).toHaveLength(0);
    // Proof the glyphs were not simply all excluded: the prefix IS found.
    expect(p.SearchAnnotations('cha', { region: cut })).toHaveLength(1);
  });

  it('omitting region gives exactly the unscoped result', () => {
    const p = page();
    const shape = (hits: { text: string; quads: Rect[] }[]) => hits.map((m) => [m.text, m.quads]);
    expect(shape(p.SearchAnnotations('charlie', {}))).toEqual(shape(p.SearchAnnotations('charlie')));
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. If `does NOT find a match straddling` fails because the prefix is `char` rather than `cha`, adjust the `cut` x bound down by 2pt rather than changing the assertion — the point is that a partial word is kept and the whole word is not.

- [ ] **Step 3: Prove the centroid rule load-bearing**

In `src/annotsearch.ts`, temporarily replace the centroid filter with an overlap test:

```ts
          // TEMPORARY — must go red
          if (region && !(g.quad[0] <= region[2] && region[0] <= g.quad[2]
                       && g.quad[1] <= region[3] && region[1] <= g.quad[3])) return;
```

Run: `npx vitest run test/annot-search.test.ts`
Expected: FAIL on `decides a glyph by its CENTROID` — the `[0, 211, 300, 300]` case now returns 1.

- [ ] **Step 4: Revert the mutation**

Restore `if (region && !inRect(region, ...centroidOf(g.quad))) return;`.

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. Confirm `git diff src/annotsearch.ts` is empty.

- [ ] **Step 5: Commit**

```bash
git add test/annot-search.test.ts
git commit -m "$(cat <<'EOF'
test(search): pin region scoping for SearchAnnotations

Reuses SearchOptions.region and the centroid containment rule searchText and
extractTables share. Confirmed to go red when the filter is switched to an
overlap test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The documented redaction recipe, the fence, and the docs

**Files:**
- Modify: `test/annot-search.test.ts` (append a final `describe` block)
- Modify: `README.md` (Features and API overview sections)
- Modify: `CLAUDE.md` (add an `annotsearch.ts` entry in the Source list, after the `textedit.ts` paragraph inside the `text.ts` bullet)

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: nothing new.

- [ ] **Step 1: Test the recipe the docs are about to promise**

`RedactText`/`MarkRedactText` gain no annotation flag, so the README tells callers to route the quads through `Redact` instead. A documented recipe nobody runs is a documented recipe that rots. Append to `test/annot-search.test.ts`:

```ts
describe('redacting what SearchAnnotations finds', () => {
  it('removes the annotation whose appearance drew the text', () => {
    // The documented route: SearchAnnotations gives the quads, Redact consumes
    // them, and removeCoveredAnnotations takes any annotation whose /Rect they
    // intersect. The whole annotation is the only granularity available without
    // surgery on the /AP stream, and that is the honest answer rather than a gap.
    const doc = Document.Open(buildAnnotTextPdf());
    const p = doc.Pages[0];
    const hits = p.SearchAnnotations('charlie');
    expect(hits).toHaveLength(1);

    p.Redact(hits.flatMap((m) => m.quads));

    const after = Document.Open(doc.Save()).Pages[0];
    expect(after.SearchAnnotations('charlie')).toHaveLength(0);
    // And it took only that one: the /FreeText elsewhere on the page survives.
    expect(after.SearchAnnotations('bravo')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the new test**

Run: `npx vitest run test/annot-search.test.ts`
Expected: PASS. `charlie` is a `/Widget`, so its removal goes through `removeField` — if it fails on the surviving-`bravo` assertion, the redaction rects are wider than intended and Task 2's geometry assertions should be re-read first.

- [ ] **Step 3: Run the full suite as the untouched-consumers fence**

Run: `npm test`
Expected: PASS, no regressions. This is the evidence for the plan's claim that `searchText`, `replaceText`, `redactText` and `markRedactText` are unchanged — in particular `test/search-region.test.ts` and every redaction test must be green with no edits.

- [ ] **Step 4: Run the typechecker**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Add the `CLAUDE.md` entry**

In the `text.ts` bullet, immediately after the paragraph describing `textedit.ts` (the one ending with the `region` scoping invariants), add:

```markdown
  **annotsearch.ts** — search the text an annotation *draws*
  (`Page.SearchAnnotations`): the words inside its `/AP` appearance stream, a
  `/FreeText`'s visible text or a filled form field's value, which
  `visitContent` never sees because it walks page content streams only. Its own
  module for redactannots.ts's reason — textedit.ts is content-stream search
  and edit, this is `/Annots` object-graph work — and it holds textedit.ts free
  of a dependency on annotation.ts.
  **Invariant:** ONE `layoutLines` assembly per annotation, never one shared
  with page content or across annotations. `layoutLines` groups by baseline and
  orders by X, so a note drawn over a paragraph shares its line — a shared
  assembly splices the note's words into the paragraph's and matches a query
  spanning both. Measured: the fixture's `bravo` sits on the page text's own
  baseline, and seeding the annotation runs with the page's glyphs turns
  `alpha bravo` into a hit.
  **Invariant:** no `GlyphEvent` escapes this module, which is why
  `AnnotationMatch` carries none. An `/AP` stream is not addressable by
  `ContentAddr` — its `path` is a chain of XObject resource names descended
  from the page — so `visitFormContent`'s `addr` names the page's first content
  stream and is a lie; a fabricated path throws `XObject /X not found` inside
  `EditableContent.cowXObject` rather than degrading. `buildMatch`'s `hits` are
  dropped at the one boundary in `searchAnnotations`.
  **Invariant:** `visitFormContent` lives in text.ts and knows nothing about
  annotations. annotappearance.ts value-imports `placementMatrix` from text.ts,
  so a `visitAnnotationAppearance` there would close a cycle; the annotation
  half (`isAnnotVisible`, `resolveAppearance`, composing `ap.place`) is
  annotsearch.ts's. Using those two predicates rather than reading `/AP`
  directly is what makes search agree with `ToImage`, `ToSvg` and
  `FlattenAnnotations` about which annotations draw.
  **Invariant:** redaction is left alone. `RedactText`/`MarkRedactText` gain no
  annotation flag — a caller passes the quads to `Redact`, and
  `removeCoveredAnnotations` then takes the whole annotation, which is the only
  granularity available without surgery on the `/AP` stream.
```

- [ ] **Step 6: Add the `README.md` entries**

In the Features list, beside the existing text-search entry, add:

```markdown
- Search the text annotations **draw** (`page.SearchAnnotations`) — a
  `/FreeText`'s visible words, a filled form field's value — which page-content
  search cannot see.
```

In the API overview, beside `page.Search`, add:

```markdown
`page.SearchAnnotations(find, options?)` — find `find` (string or RegExp) in the
text drawn by the page's annotations' `/AP` appearance streams. Returns
`AnnotationMatch[]`: `{ annot, text, quads }`, in `/Annots` order. Only
annotations a static render would draw are searched (not Hidden, NoView or
`/Popup`). Accepts the same `options.region` as `page.Search`. A match carries
no glyph provenance — an appearance stream is not addressable by the
content-edit layer — so `ReplaceText` has no annotation counterpart. To redact
what it finds, pass `hits.flatMap(m => m.quads)` to `page.Redact`, which removes
any annotation those rects intersect.
```

- [ ] **Step 7: File the follow-up issue for reading (a)**

```bash
bd create "Search annotation /Contents strings" \
  -t feature -p 3 --parent aspose-pdf-foss-for-ts-c3t7 -l gap-vs-go \
  -d "Split from c3t7.6, which shipped reading (b): the text an annotation DRAWS, via Page.SearchAnnotations over /AP appearance streams.

This is reading (a): the /Contents string, a note's BODY. It is not drawn, so it has no glyphs and no geometry beyond the annotation's /Rect.

Read c3t7.6's design doc first (docs/superpowers/specs/2026-08-17-annotation-appearance-search-design.md) -- it settles why the two readings are different features wearing one name, and records that (a)'s only available geometry is the whole /Rect, which is exactly the shape that makes feeding such a hit to redaction dangerous.

The honest prior question here is whether this earns an API at all: page.Annotations + Annotation.Contents already expose the strings, so the delta is a uniform string/RegExp matcher over them. Argue that before designing. If it ships, the obvious shape is a sibling of searchAnnotations in annotsearch.ts, with a result type that does NOT pretend to carry a text quad."
```

- [ ] **Step 8: Commit the docs**

```bash
git add README.md CLAUDE.md test/annot-search.test.ts
git commit -m "$(cat <<'EOF'
docs: record annotsearch.ts and Page.SearchAnnotations

Four invariants: one assembly per annotation, no GlyphEvent escapes,
visitFormContent stays annotation-free (annotappearance.ts imports
placementMatrix from text.ts), and redaction is left untouched.

The README's redaction recipe is covered by a test rather than left to rot:
SearchAnnotations quads into Redact removes that annotation and no other.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Close the issue and push**

```bash
bd close aspose-pdf-foss-for-ts-c3t7.6
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Notes for the implementer

**On mutation steps.** Tasks 2–5 each contain a step that deliberately breaks the code to confirm a test goes red, then reverts. Do not skip them and do not commit while mutated — each of those tasks ends with `git diff src/` being empty for the mutated file. This repo's convention is that a green assertion is not evidence until it has been shown to fail; the four invariants above were all reasoned about before they were measured, and the plan records which measurement pins which.

**On the fixture's numbers.** Widths come from Helvetica's AFM table (`metrics.ts`), reached because `/F1` carries no `/Widths`. If an assertion is off by a point or two, prefer widening the tolerance or moving the *fixture* geometry over relaxing an assertion into vacuity — a `toBeGreaterThan` where an exact value was meant is how these tests go quietly green with the bug present.

**What must not change.** If you find yourself editing `searchText`, `replaceText`, `redactText`, `markRedactText`, `TextMatch` or `ContentAddr`, stop: the design's central claim is that none of them need to, and a change there means the shape was wrong and needs re-deciding rather than patching.
