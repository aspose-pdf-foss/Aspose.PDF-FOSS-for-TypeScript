# PDF/UA-2: PUA, language, optional content, destinations and embedded files (`q7hc.4.4`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ISO 14289-2 clauses 8.4.3, 8.4.4, 8.6, 8.7, 8.8 and 8.14.1 — the 11
remaining PDF/UA-2 rules — with part 1 byte-identical and the font rules
unmoved.

**Architecture:** the deduped glyph walk moves out of `uafont.ts` into a leaf
`uaglyph.ts` that yields a FINER key than `uafont.ts` uses, and `uafont.ts`
collapses the extra components away so its report does not change. `uatext.ts`
holds the PUA and language rules, `uadoc.ts` the optional-content, destination
and embedded-file rules. One authoring change: a GoTo action gains `/SD` beside
its `/D`.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No runtime
dependencies — `node:` built-ins only.

**Spec:** `docs/superpowers/specs/2026-09-16-pdfua2-pua-lang-oc-dests-design.md`

## Global Constraints

- **Zero runtime dependencies.** `node:` built-ins only.
- **ESM + NodeNext.** Every relative import specifier carries `.js`.
- **`npm run typecheck` and `npm test` green before any task is done.**
- **Part 1 is byte-identical.** These four must pass **UNEDITED**:
  `test/pdfua-part1-identity.test.ts`, `test/pdfua2-validate.test.ts`,
  `test/pdfuaconvert.test.ts`, `test/markdown-pdfua.test.ts`.
- **The font rules must not move.** `test/pdfua2-font.test.ts` and
  `test/pdfua2-font-coverage.test.ts` must pass **UNEDITED** — that is the fence
  for the glyph-walk extraction and the dedup collapse.
- **Every new rule opens `if (ctx.part !== 2) return [];`** and is APPENDED to
  `RULES`, never inserted.
- **`CHANGELOG.md` is updated in the same commit as any user-visible change,**
  under `## [Unreleased]`, citing `q7hc.4.3`'s neighbour `q7hc.4.4` at the end.
- **A new `src/*.ts` module earns a CLAUDE.md Source-list entry when it lands.**
  Run the sweep through node, not shell globbing:
  ```bash
  node -e "
  const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');
  const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts'))
    .filter(b=>!md.includes('**'+b+'**') && !md.includes('\`'+b+'\`'));
  console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
  ```
- **`npx vitest run test/import-cycles.test.ts` must still report the same 15
  pairs.** Run it after every task that adds an import.
- **The anchor is a TRANSCRIPTION, not a runnable oracle**, fetched 2026-09-16.
  Every test expression is quoted in the spec. **Never write one from memory.**

## Verified API surface

Every name below was checked against the codebase before this plan was written.

| Name | Where | Signature / fact |
|---|---|---|
| `UaCtx` | `uarule.ts:36` | `{ doc, catalog, part, tree, nodes }` |
| `Rule` | `uarule.ts:44` | `(ctx: UaCtx) => ValidationIssue[]` |
| `uaClause` | `uarule.ts:49` | `(part, { 1?, 2? }) => string` |
| `WalkedNode` | `uarule.ts:26` | `{ element, parentType, parent }` |
| `Ctx` | `validatectx.ts:11` | `{ doc, catalog, R(o), cache }` |
| `nameOf` | `validatectx.ts:27` | `(ctx, dict, key) => string \| undefined` |
| `vctx` | `uafont.ts:38` | private today; **moves to `uarule.ts` in Task 1** |
| `DistinctGlyph` | `uafont.ts:89` | `{ font, fontDict, code, cid, text, renderMode }` |
| `distinctGlyphs` | `uafont.ts:106` | private; **moves to `uaglyph.ts` in Task 1** |
| `objKey` / `OBJ_IDS` | `uafont.ts:133-139` | private; move with it |
| `rendersVisibly` | `uafont.ts:146` | **stays in `uafont.ts`** — a font question |
| `drawn` | `uafont.ts:507` | stays; filters `renderMode !== 3` |
| `GlyphEvent` | `text.ts` | carries `mcid?`, `artifact?`, `text`, `code`, `cid`, `renderMode?` |
| `MarkedContentEvent` | `text.ts:390` | fires ONLY when an `/MCID` resolves (`q7hc.1`) — **do not widen** |
| `StructElement.Page` | `struct.ts:195` | walks `/Pg` up the ancestor chain |
| `StructElement.Children` | `struct.ts:145` | `StructElement[]` |
| `StructTreeRoot.Children` | `struct.ts:613` | `StructElement[]` |
| `StructTreeRoot.ElementFor` | `struct.ts:590` | `(structParentsKey, mcid) => StructElement \| undefined` |
| `collectNameTree` | `nametree.ts:43` | `(doc, node, out: Array<[string, PdfObject]>) => void` |
| `encodeDest` | `outline.ts:220` | `(pageRef: PdfRef, view?) => PdfObject[]` — 4 call sites |
| `attachments` | `embeddedfile.ts:188` | lists `/Names /EmbeddedFiles` |
| `validatectx.ts` imports | — | does **not** import `uarule.js`, so Task 1's new edge closes no cycle |

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `src/uaglyph.ts` | The deduped glyph walk, keyed finely. A near-leaf. |
| **Modify** `src/uarule.ts` | Gains `vctx` — the `UaCtx` → `validatectx.Ctx` bridge. |
| **Modify** `src/uafont.ts` | Imports the walk; collapses the extra key components. |
| **Modify** `src/text.ts` | `GlyphEvent.mcProps` — inherited marked-content strings. |
| **Create** `src/uatext.ts` | Clauses 8.4.3, 8.4.4, 8.6 — six rules. |
| **Create** `src/uadoc.ts` | Clauses 8.7, 8.8, 8.14.1 — five rules. |
| **Modify** `src/structvalidate.ts` | Append `TEXT_RULES` then `DOC_RULES`. |
| **Modify** `src/actions.ts` | A GoTo action gains `/SD`. |
| **Create** `test/helpers/build-ua-misc-pdf.ts` | Fixture builder for all 11 rules. |
| **Create** `test/pdfua2-text.test.ts` | Cross-part pairs for the six text rules. |
| **Create** `test/pdfua2-doc.test.ts` | Cross-part pairs for the five document rules. |
| **Create** `test/pdfua2-misc-coverage.test.ts` | The census and the PUA range count. |
| **Create** `test/struct-dest-authoring.test.ts` | The `/SD` authoring change. |
| **Modify** `CLAUDE.md`, `README.md`, `CHANGELOG.md` | Entries, count, API text. |

---

### Task 1: Extract the glyph walk to `uaglyph.ts`

**Files:**
- Create: `src/uaglyph.ts`
- Modify: `src/uarule.ts`, `src/uafont.ts`

**Interfaces:**
- Produces: `vctx(ctx: UaCtx): Ctx` from `./uarule.js`;
  `DistinctGlyph { font, fontDict, code, cid, text, renderMode, mcid?, artifact? }`
  and `distinctGlyphs(ctx: UaCtx): DistinctGlyph[]` from `./uaglyph.js`.

- [ ] **Step 1: Move `vctx` into `uarule.ts`**

Cut `CTX` and `vctx` from `src/uafont.ts` (lines 37-49) and paste into
`src/uarule.ts`, adding the two imports it needs. `validatectx.ts` does not
import `uarule.ts`, so this closes no cycle — verify in Step 6.

```ts
import { type Ctx } from './validatectx.js';
import type { PdfObject } from './types.js';

/** A `validatectx.Ctx` over this run, so the shared object and font walks can
 *  be reused. Memoized on the `UaCtx`, so `enumerateFonts` and the all-objects
 *  scan are each walked once per validation however many rules ask.
 *
 *  **Invariant:** it lives HERE, in the vocabulary every PDF/UA rule module
 *  shares, because THREE now need it — `uafont.ts`, `uatext.ts` and
 *  `uadoc.ts` — and none may import another. Three copies is how three rule
 *  modules come to disagree about which objects a document has. */
const CTX = new WeakMap<UaCtx, Ctx>();
export function vctx(ctx: UaCtx): Ctx {
  let c = CTX.get(ctx);
  if (c === undefined) {
    c = {
      doc: ctx.doc, catalog: ctx.catalog,
      R: (o: PdfObject | undefined) => ctx.doc.resolve(o),
      cache: new Map<string, unknown>(),
    };
    CTX.set(ctx, c);
  }
  return c;
}
```

In `src/uafont.ts`, replace the deleted block with
`import { uaClause, vctx, type Rule, type UaCtx } from './uarule.js';`
(it already imports the first, third and fourth from there).

Add `textOf` beside it, for the same reason — THREE rule modules need "this
string entry's text" and none may import another:

```ts
/** A PDF string entry's text, or `undefined` when the key is absent or holds
 *  something that is not a string.
 *
 *  **Invariant:** it decodes through `metadata.ts`'s `decodePdfText`, the one
 *  owner of the PDFDocEncoding/UTF-16 rule — CLAUDE.md records `structns.ts`
 *  reusing it for exactly this reason. Decoding by hand here would be a second
 *  reading of the same bytes. */
export function textOf(ctx: UaCtx, o: PdfObject | undefined): string | undefined {
  const v = ctx.doc.resolve(o);
  return isString(v) ? decodePdfText(v.bytes) : undefined;
}
```

> Confirm both names first: `grep -n "export function decodePdfText" src/metadata.ts`
> and `grep -n "export function isString" src/types.ts`. If `uarule.ts`
> importing `metadata.ts` closes a cycle (check
> `npx vitest run test/import-cycles.test.ts` in Step 6), fall back to
> `String.fromCharCode(...v.bytes)` and record the narrowing in the doc comment.

- [ ] **Step 2: Create `src/uaglyph.ts` with the FINER key**

Move `DistinctGlyph`, `GLYPHS`, `distinctGlyphs`, `OBJ_IDS` and `objKey` out of
`uafont.ts` into this new file, adding `mcid` and `artifact` to both the record
and the key.

```ts
/** The glyphs a document shows, deduplicated — the walk ISO 14289-2's glyph
 *  rules share (`q7hc.4.3`'s font rules and `q7hc.4.4`'s PUA rule).
 *
 *  **Invariant:** a near-LEAF. It imports `text.js` and `types.js` for the walk
 *  and `uarule.js` for `UaCtx`, and it imports NEITHER rule module — which is
 *  what lets `uafont.ts` and `uatext.ts` both reach it without reaching each
 *  other. The extraction `colornames.ts`, `preformat.ts`, `bordersides.ts`,
 *  `datauri.ts` and `langmatch.ts` each already made.
 *
 *  **Invariant: this key is FINER than `uafont.ts` uses, deliberately.**
 *  `GFGlyph.getGlyph` caches by `(fontId, fontName, glyphCode, renderingMode,
 *  markedContent, structElem, isRealContent)`. `q7hc.4.3` dropped the last
 *  three, on the reasoning that doing so only ever MERGES findings veraPDF
 *  would separate. 8.4.3-1 cannot accept that merge: the same PUA code drawn
 *  once under an element carrying `/Alt` and once under an element carrying
 *  none must stay distinguishable, or a real defect hides behind a conformant
 *  sibling — a MISSED DEFECT rather than a smaller report. So the walk yields
 *  the fine granularity and `uafont.ts` collapses `mcid` and `artifact` away on
 *  its own side, which is what keeps its report byte-identical. @internal */
import { visitContent } from './text.js';
import type { PdfDict } from './types.js';
import type { TextFont } from './font.js';
import type { UaCtx } from './uarule.js';

/** One distinct glyph the document shows. */
export interface DistinctGlyph {
  font: TextFont;
  fontDict: PdfDict;
  code: number;
  cid: number;
  text: string;
  renderMode: number;
  /** The `/MCID` in force, when the glyph sits in marked content. */
  mcid?: number;
  /** True when the glyph sits inside an `/Artifact` scope. veraPDF's
   *  `isRealContent` is its negation — transcribed by inference rather than
   *  quotation, since that term is a constructor parameter threaded down from
   *  the operator layer. */
  artifact?: boolean;
  /** `/ActualText`, `/Alt` and `/Lang` inherited from the marked-content
   *  stack, when any BDC in scope states one (Task 2). */
  mcProps?: { actualText?: string; alt?: string; lang?: string };
  /** The structure element this glyph's `/MCID` resolves to.
   *
   *  **Invariant: resolved HERE, in the walk, and never re-derived by a rule.**
   *  `StructTreeRoot.ElementFor(structParentsKey, mcid)` needs the PAGE's
   *  `/StructParents`, and the walk is the only place that knows which page it
   *  is on — a rule holding only a `DistinctGlyph` would have to find the page
   *  again, which is a second answer to "which element marked this glyph". */
  element?: StructElement;
}

const GLYPHS = new WeakMap<UaCtx, DistinctGlyph[]>();

/** A stable id per dict, so the dedup key can be a string. A `Map` keyed by the
 *  dict itself cannot also carry the code, the mode and the MCID. */
const OBJ_IDS = new WeakMap<PdfDict, number>();
let nextObjId = 0;
function objKey(d: PdfDict): number {
  let id = OBJ_IDS.get(d);
  if (id === undefined) { id = nextObjId++; OBJ_IDS.set(d, id); }
  return id;
}

/** Every distinct glyph the document shows, memoized per run.
 *
 *  **Invariant:** `code` and `cid` come off the `GlyphEvent` rather than being
 *  re-derived from `byteStart`/`byteLen`. CLAUDE.md records that every consumer
 *  which re-derived them that way "drew the right glyph for `/Identity-H` and
 *  the wrong one for every other CMap, silently". */
export function distinctGlyphs(ctx: UaCtx): DistinctGlyph[] {
  let out = GLYPHS.get(ctx);
  if (out !== undefined) return out;
  const seen = new Map<string, DistinctGlyph>();
  const tree = ctx.doc.GetStructTree();
  for (const page of ctx.doc.Pages) {
    // The page's /StructParents is what ElementFor keys on, and this walk is
    // the only place that knows which page we are on.
    const spRaw = ctx.doc.resolve(page.Dict.get('StructParents'));
    const sp = typeof spRaw === 'number' ? spRaw : undefined;
    visitContent(ctx.doc, page, {
      glyph: (e) => {
        const renderMode = e.renderMode ?? 0;
        const fontDict = e.font.dict;
        const key = `${objKey(fontDict)}|${e.code}|${renderMode}`
          + `|${e.mcid ?? -1}|${e.artifact === true ? 1 : 0}`;
        if (seen.has(key)) return;
        const element = tree !== null && sp !== undefined && e.mcid !== undefined
          ? tree.ElementFor(sp, e.mcid)
          : undefined;
        seen.set(key, {
          font: e.font, fontDict, code: e.code, cid: e.cid,
          text: e.text, renderMode,
          ...(e.mcid !== undefined ? { mcid: e.mcid } : {}),
          ...(e.artifact === true ? { artifact: true } : {}),
          ...(e.mcProps !== undefined ? { mcProps: e.mcProps } : {}),
          ...(element !== undefined ? { element } : {}),
        });
      },
    });
  }
  out = [...seen.values()];
  GLYPHS.set(ctx, out);
  return out;
}
```

> `e.mcProps` does not exist until Task 2. Write the spread anyway and let
> `tsc` fail — Task 2's Step 4 is what makes it compile. If you prefer a green
> tree between tasks, omit that one line here and add it in Task 2.

- [ ] **Step 3: Make `uafont.ts` collapse the extra components**

In `src/uafont.ts`, delete the moved declarations and import instead:

```ts
import { distinctGlyphs as fineGlyphs, type DistinctGlyph } from './uaglyph.js';
```

Add the collapse directly above `rendersVisibly`:

```ts
/** The glyph walk at the granularity the FONT rules use — `uaglyph.ts`'s fine
 *  records collapsed back to `(font, code, renderMode)`.
 *
 *  **Invariant, and it is what keeps `q7hc.4.3`'s report unmoved:** a font that
 *  is not embedded and is drawn in five hundred elements is ONE finding, not
 *  five hundred. `uaglyph.ts` keys on the MCID and the artifact flag because
 *  8.4.3-1 needs them; no font rule does, and splitting on them here would turn
 *  every font finding on a tagged document into one per marked-content
 *  sequence. `test/pdfua2-font.test.ts`'s dedup cases are the fence. */
const FONT_GLYPHS = new WeakMap<UaCtx, DistinctGlyph[]>();
function distinctGlyphs(ctx: UaCtx): DistinctGlyph[] {
  let out = FONT_GLYPHS.get(ctx);
  if (out !== undefined) return out;
  const seen = new Map<string, DistinctGlyph>();
  for (const g of fineGlyphs(ctx)) {
    const key = `${objKey(g.fontDict)}|${g.code}|${g.renderMode}`;
    if (!seen.has(key)) seen.set(key, g);
  }
  out = [...seen.values()];
  FONT_GLYPHS.set(ctx, out);
  return out;
}
```

`objKey` moved out, so `uafont.ts` needs its own. Rather than export it (it is
an implementation detail of a dedup key), give `uafont.ts` a two-line private
copy keyed on the same `WeakMap` pattern — or simpler, key the collapse on the
dict identity directly:

```ts
const seen = new Map<PdfDict, Map<string, DistinctGlyph>>();
for (const g of fineGlyphs(ctx)) {
  let byCode = seen.get(g.fontDict);
  if (byCode === undefined) { byCode = new Map(); seen.set(g.fontDict, byCode); }
  const k = `${g.code}|${g.renderMode}`;
  if (!byCode.has(k)) byCode.set(k, g);
}
out = [...seen.values()].flatMap((m) => [...m.values()]);
```

Use the second form: it needs no id counter and cannot collide.

- [ ] **Step 4: Run the font fences**

```bash
npx vitest run test/pdfua2-font.test.ts test/pdfua2-font-coverage.test.ts
```
Expected: PASS, **unedited**. If either moves, the collapse is wrong — the font
rules' granularity must be exactly what it was.

- [ ] **Step 5: Prove the collapse is load-bearing**

Mutate `uafont.ts`'s `distinctGlyphs` to `return fineGlyphs(ctx);` and run the
same two files. **Expected: the dedup cases go RED** only if a fixture draws the
same code under two different MCIDs. `test/pdfua2-font.test.ts`'s fixtures are
UNTAGGED, so `mcid` is `undefined` throughout and the mutation is GREEN.

Record that honestly rather than inventing a fixture for it: the collapse is
held by reasoning, not by the suite, and the note in Step 3 says so. Revert the
mutation.

- [ ] **Step 6: Typecheck, cycles, suite, commit**

```bash
npm run typecheck && npx vitest run test/import-cycles.test.ts && npm test
git add src/uaglyph.ts src/uarule.ts src/uafont.ts
git commit -m "refactor(q7hc.4.4): extract the glyph walk to uaglyph.ts

8.4.3-1 needs the walk and uafont.ts owned it privately, so it moves to a
leaf both rule modules can reach -- the extraction colornames.ts,
preformat.ts, bordersides.ts, datauri.ts and langmatch.ts each made.

The leaf keys FINER than the font rules do, on the MCID and the artifact
flag as GFGlyph does, because 8.4.3-1 must tell a PUA glyph under an
element carrying /Alt from one under an element carrying none -- merging
those hides a real defect rather than shortening the report. uafont.ts
collapses both components away on its own side, so its findings are
unchanged and test/pdfua2-font.test.ts passes unedited.

vctx moves to uarule.ts, the vocabulary every rule module shares, because
three now need it and none may import another."
```

---

### Task 2: `GlyphEvent.mcProps` — inherited marked-content strings

**Files:**
- Modify: `src/text.ts`
- Test: `test/text-mcprops.test.ts`

**Interfaces:**
- Produces: `GlyphEvent.mcProps?: { actualText?: string; alt?: string; lang?: string }`

- [ ] **Step 1: Write the failing test**

Create `test/text-mcprops.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { buildMcPropsPdf } from './helpers/build-mcprops-pdf.js';

function glyphs(bytes: Uint8Array): GlyphEvent[] {
  const doc = Document.Open(bytes);
  const out: GlyphEvent[] = [];
  visitContent(doc, doc.Pages[0], { glyph: (e) => { out.push(e); } });
  return out;
}

describe('GlyphEvent.mcProps', () => {
  it('is ABSENT when no BDC in scope states one', () => {
    // renderMode's rule: a key present on every glyph would move every fixture
    // that compares an event.
    const [g] = glyphs(buildMcPropsPdf([{ text: 'a' }]));
    expect('mcProps' in g).toBe(false);
  });

  it('carries /ActualText, /Alt and /Lang from the enclosing BDC', () => {
    const [g] = glyphs(buildMcPropsPdf([
      { text: 'a', props: { ActualText: 'x', Alt: 'y', Lang: 'en-GB' } },
    ]));
    expect(g.mcProps).toEqual({ actualText: 'x', alt: 'y', lang: 'en-GB' });
  });

  it('INHERITS through nesting, inner winning', () => {
    // containsStringKey reads the inherited attribute, so an outer /Alt covers
    // an inner sequence that states none.
    const out = glyphs(buildMcPropsPdf([
      { text: 'a', props: { Alt: 'outer' }, nested: { props: {}, text: 'b' } },
    ]));
    expect(out).toHaveLength(2);
    expect(out[1].mcProps?.alt).toBe('outer');
  });

  it('is POPPED at EMC, so a later glyph is uncovered', () => {
    const out = glyphs(buildMcPropsPdf([
      { text: 'a', props: { Alt: 'y' } },
      { text: 'b' },
    ]));
    expect(out[0].mcProps?.alt).toBe('y');
    expect('mcProps' in out[1]).toBe(false);
  });

  it('applies to a BDC with NO /MCID, which fires no marked event', () => {
    // The whole reason this rides on the glyph rather than on
    // MarkedContentEvent, whose q7hc.1 invariant is that it fires only when an
    // /MCID resolves.
    const [g] = glyphs(buildMcPropsPdf([{ text: 'a', props: { Alt: 'y' }, noMcid: true }]));
    expect(g.mcProps?.alt).toBe('y');
  });
});
```

- [ ] **Step 2: Write the fixture builder**

Create `test/helpers/build-mcprops-pdf.ts`, following
`test/helpers/build-render-mode-pdf.ts`'s hand-assembled shape (that file is the
suite's idiom for a hand-written content stream; `Page.AppendContent` does NOT
exist — do not invent it).

```ts
const enc = (s: string) => new TextEncoder().encode(s);
const byteLen = (s: string) => enc(s).length;

function assemble(objects: string[], maxObj: number, rootNum: number): Uint8Array {
  let body = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = new Array(maxObj + 1).fill(0);
  for (let n = 1; n <= maxObj; n++) {
    offsets[n] = byteLen(body);
    body += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xrefOffset = byteLen(body);
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${maxObj + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc(body + xref + trailer);
}

function streamObj(content: string): string {
  return `<< /Length ${byteLen(content)} >>\nstream\n${content}\nendstream`;
}

export interface McSpec {
  text: string;
  /** Property-list entries; omit to draw outside any BDC. */
  props?: Record<string, string>;
  /** Omit the /MCID, so `MarkedContentEvent` never fires for this sequence. */
  noMcid?: boolean;
  /** A nested BDC drawn inside this one. */
  nested?: { props: Record<string, string>; text: string };
}

/** A one-page document drawing each spec, optionally inside a `/Span` BDC. */
export function buildMcPropsPdf(specs: McSpec[]): Uint8Array {
  let mcid = 0;
  const parts: string[] = [];
  let y = 700;
  const dict = (p: Record<string, string>, withMcid: boolean): string => {
    const entries = Object.entries(p).map(([k, v]) => `/${k} (${v})`);
    if (withMcid) entries.unshift(`/MCID ${mcid++}`);
    return `<< ${entries.join(' ')} >>`;
  };
  const show = (t: string, at: number): string =>
    `BT /F1 12 Tf 1 0 0 1 72 ${at} Tm (${t}) Tj ET`;
  for (const s of specs) {
    if (s.props === undefined) { parts.push(show(s.text, y)); y -= 20; continue; }
    const inner = s.nested === undefined ? '' :
      `\n/Span ${dict(s.nested.props, true)} BDC\n${show(s.nested.text, y - 20)}\nEMC`;
    parts.push(`/Span ${dict(s.props, s.noMcid !== true)} BDC\n${show(s.text, y)}${inner}\nEMC`);
    y -= s.nested === undefined ? 20 : 40;
  }
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 612 792] >>`;
  objects[3] = `<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /StructParents 0 >>`;
  objects[4] = streamObj(parts.join('\n'));
  objects[5] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  return assemble(objects, 5, 1);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/text-mcprops.test.ts`
Expected: FAIL — `mcProps` is undefined on every event.

- [ ] **Step 4: Implement the inherited stack**

In `src/text.ts`, add the field to `GlyphEvent` immediately after `renderMode`:

```ts
  /** `/ActualText`, `/Alt` and `/Lang` inherited from the marked-content stack
   *  — the innermost BDC in scope that states each key.
   *
   *  **Absent when no BDC in scope states any of them**, `color`'s and
   *  `renderMode`'s rule, which is what keeps every existing fixture that
   *  compares an event byte-identical.
   *
   *  **Invariant: it rides on the GLYPH and not on `MarkedContentEvent`**,
   *  which fires ONLY when an `/MCID` resolves (`q7hc.1`). A BDC may carry
   *  `/ActualText` with no `/MCID` at all, and ISO 14289-2 8.4.3-1 reads
   *  exactly that case — veraPDF's `containsStringKey` checks the inherited
   *  marked-content attribute BEFORE it looks at the structure element. */
  mcProps?: { actualText?: string; alt?: string; lang?: string };
```

Beside `mcidStack` and `artifactStack`, add a third stack of the same shape.
Declare the running value near them:

```ts
  type McProps = { actualText?: string; alt?: string; lang?: string };
  const mcPropsStack: (McProps | undefined)[] = [];
  let mcProps: McProps | undefined;
```

In the `BDC` branch — beside the existing `mcidStack.push(activeMcid)` — push
the current value and compute the new one from the resolved property list. The
walker already resolves that dict for `mcidFromProps`; reuse it rather than
resolving twice:

```ts
          mcPropsStack.push(mcProps);
          mcProps = inheritMcProps(ctx, mcProps, op.operands[1], properties);
```

In the `EMC` branch, beside the existing pops:

```ts
          mcProps = mcPropsStack.pop();
```

Add the helper near `mcidFromProps`:

```ts
/** The marked-content string attributes in force inside this BDC: the new
 *  property list's values, falling back to the enclosing scope's.
 *
 *  Returns the SAME object when the BDC states none, so the common case
 *  allocates nothing and `mcProps` stays absent on the event. */
function inheritMcProps(
  ctx: Ctx, outer: McProps | undefined,
  operand: PdfObject | undefined, properties?: PdfDict,
): McProps | undefined {
  let d: PdfObject | undefined = operand;
  if (isName(d)) d = properties?.get(d.name);
  const props = ctx.doc.resolve(d);
  if (!isDict(props)) return outer;
  const str = (k: string): string | undefined => {
    const v = ctx.doc.resolve(props.get(k));
    return isString(v) ? decodePdfText(v.bytes) : undefined;
  };
  const actualText = str('ActualText') ?? outer?.actualText;
  const alt = str('Alt') ?? outer?.alt;
  const lang = str('Lang') ?? outer?.lang;
  if (actualText === undefined && alt === undefined && lang === undefined) return undefined;
  return {
    ...(actualText !== undefined ? { actualText } : {}),
    ...(alt !== undefined ? { alt } : {}),
    ...(lang !== undefined ? { lang } : {}),
  };
}
```

> **Confirm the two helpers before writing this.** Run
> `grep -n "isString" src/types.ts` and
> `grep -n "export function decodePdfText" src/metadata.ts`. `decodePdfText` is
> `metadata.ts`'s owner of the PDFDocEncoding/UTF-16 rule — CLAUDE.md records
> that `structns.ts` reuses it for exactly this reason, so do NOT decode by
> hand. If `text.ts` importing `metadata.ts` closes a cycle, use
> `String.fromCharCode(...v.bytes)` and record the narrowing.

Set it on the event, beside `renderMode`:

```ts
      ...(mcProps !== undefined ? { mcProps } : {}),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/text-mcprops.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Prove nothing else moved**

```bash
npx vitest run test/text.test.ts test/text-fragments.test.ts test/text-script.test.ts test/search-region.test.ts test/docmodel.test.ts test/text-render-mode-event.test.ts
```
Expected: PASS, **unedited**. `mcProps` is absent unless a BDC states one, so
every event comparison is byte-identical.

- [ ] **Step 7: Typecheck, cycles, suite, commit**

```bash
npm run typecheck && npx vitest run test/import-cycles.test.ts && npm test
git add src/text.ts src/uaglyph.ts test/text-mcprops.test.ts test/helpers/build-mcprops-pdf.ts CHANGELOG.md
git commit -m "feat(q7hc.4.4): GlyphEvent carries inherited marked-content strings

ISO 14289-2 8.4.3-1 excuses a PUA glyph when an /ActualText or /Alt is in
scope, and veraPDF's containsStringKey checks the INHERITED marked-content
attribute before it looks at the structure element -- so a BDC carrying
/ActualText with no /MCID counts, and MarkedContentEvent fires only when an
/MCID resolves. Widening that would break q7hc.1's invariant, so the value
rides on the glyph instead.

Absent unless a BDC in scope states one, GlyphEvent.color's rule, so every
existing extraction fixture is byte-identical."
```

---

### Task 3: `uatext.ts` — the four PUA rules

**Files:**
- Create: `src/uatext.ts`, `test/helpers/build-ua-misc-pdf.ts`, `test/pdfua2-text.test.ts`
- Modify: `src/structvalidate.ts`

**Interfaces:**
- Consumes: `vctx`, `uaClause`, `Rule`, `UaCtx` from `./uarule.js`;
  `distinctGlyphs` from `./uaglyph.js`.
- Produces: `export const TEXT_RULES: Rule[]`; rule names `PuaWithoutReplacement`,
  `ActualTextPua`, `AltPua`, `TextStringPua`.

- [ ] **Step 1: Write the failing test**

Create `test/pdfua2-text.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildUaMiscPdf, type UaMiscSpec } from './helpers/build-ua-misc-pdf.js';

const ids = (spec: UaMiscSpec, part: 1 | 2): string[] =>
  Document.Open(buildUaMiscPdf(spec)).ValidatePdfUa(part).Issues.map((i) => i.rule);

/** A rule must report at part 2 AND be silent at part 1. A single-part
 *  assertion provably cannot tell a rule that correctly went quiet from one
 *  that was never wired up. */
function expectPair(spec: UaMiscSpec, rule: string): void {
  expect(ids(spec, 2), `${rule} at part 2`).toContain(rule);
  expect(ids(spec, 1), `${rule} at part 1`).not.toContain(rule);
}

describe('PDF/UA-2 8.4.3-1: PUA needs a replacement', () => {
  it('reports a glyph mapping to the BMP private use area', () => {
    expectPair({ puaText: true }, 'PuaWithoutReplacement');
  });

  it('is silent for ordinary text', () => {
    expect(ids({}, 2)).not.toContain('PuaWithoutReplacement');
  });

  it('is EXCUSED by /ActualText on the enclosing BDC', () => {
    expect(ids({ puaText: true, mcProps: { ActualText: 'phone' } }, 2))
      .not.toContain('PuaWithoutReplacement');
  });

  it('is EXCUSED by /Alt on the glyph OWN structure element', () => {
    expect(ids({ puaText: true, tagged: true, altOn: 'self' }, 2))
      .not.toContain('PuaWithoutReplacement');
  });

  it('is NOT excused by /Alt on a GRANDPARENT element', () => {
    // containsStringKey reads structureElement.getKey(key) DIRECTLY -- not up
    // the ancestor chain. The obvious reading of "an Alt covers its subtree" is
    // wrong here, and this case is the only thing that pins it.
    expectPair({ puaText: true, tagged: true, altOn: 'grandparent' },
      'PuaWithoutReplacement');
  });

  it('EXEMPTS an artifact, which is not real content', () => {
    expect(ids({ puaText: true, artifact: true }, 2))
      .not.toContain('PuaWithoutReplacement');
  });
});

describe('PDF/UA-2 8.4.3-2/-3 and 8.6-1: PUA in strings', () => {
  it('-2 reports PUA in an /ActualText', () => {
    expectPair({ tagged: true, actualTextValue: '' }, 'ActualTextPua');
  });

  it('-3 reports PUA in an /Alt', () => {
    expectPair({ tagged: true, altValue: '' }, 'AltPua');
  });

  it('8.6-1 reports PUA in a human-readable string', () => {
    expectPair({ title: 'Report ' }, 'TextStringPua');
  });

  it('8.6-1 reaches the SUPPLEMENTARY planes, not just the BMP', () => {
    // PUAHelper holds THREE ranges. A single-range check passes every
    // supplementary PUA codepoint silently.
    expectPair({ title: 'Report \u{F0001}' }, 'TextStringPua');
    expectPair({ title: 'Report \u{100001}' }, 'TextStringPua');
  });

  it('8.6-1 is silent just OUTSIDE each range', () => {
    // The bounds end at FFFD, not FFFF -- the last two of each plane are
    // noncharacters and are deliberately outside.
    for (const s of ['\uDFFF', '\u{EFFFF}', '\u{FFFFE}', '\u{10FFFE}']) {
      expect(ids({ title: `Report ${s}` }, 2), JSON.stringify(s))
        .not.toContain('TextStringPua');
    }
  });

  it('8.6-1 is silent for ordinary metadata', () => {
    expect(ids({ title: 'Report' }, 2)).not.toContain('TextStringPua');
  });
});
```

- [ ] **Step 2: Write the fixture builder**

Create `test/helpers/build-ua-misc-pdf.ts`. It must serve Tasks 3-6, so define
the whole `UaMiscSpec` now. Model it on `test/helpers/build-annot-pdf.ts`, which
opens `buildStampTarget()`, sets `Lang`/title/`DisplayDocTitle` and calls
`doc.CreateStructTree()` — a document that is not tagged short-circuits
`validatePdfUa` entirely and every rule goes silent.

```ts
import { Document } from '../../src/document.js';
import { buildStampTarget } from './build-stamp-target.js';
import { name, type PdfDict, type PdfObject } from '../../src/types.js';

export interface UaMiscSpec {
  /** Draw text whose /ToUnicode maps the code INTO the BMP private use area. */
  puaText?: boolean;
  /** Property-list entries on the BDC wrapping the drawn text. */
  mcProps?: Record<string, string>;
  /** Wrap the drawn text in an /Artifact BDC instead of a /Span. */
  artifact?: boolean;
  /** Build a structure tree around the drawn text. */
  tagged?: boolean;
  /** Put an /Alt on the glyph's own element, or on its grandparent. */
  altOn?: 'self' | 'grandparent';
  /** /Alt value on the tagged element (tests 8.4.3-3). */
  altValue?: string;
  /** /ActualText value on the tagged element (tests 8.4.3-2). */
  actualTextValue?: string;
  /** /Info /Title; defaults to 'T'. Pass '' to omit it. */
  title?: string;
  /** Catalog /Lang; defaults to 'en-US'. Pass null to omit the key. */
  lang?: string | null;
  /** A /Lang on the drawn text's BDC property list. */
  bdcLang?: string;
  /** A /Lang on the tagged structure element. */
  elementLang?: string;
  /** Optional content: a /D config, plus this many /Configs entries. */
  oc?: { configs?: number; dName?: string | null; configName?: string | null; as?: boolean };
  /** An outline item with a plain page destination (tests 8.8-1). */
  outlineDest?: boolean;
  /** A link annotation whose GoTo action carries /D and optionally /SD. */
  goTo?: { sd?: boolean; arrayIsStructDest?: boolean };
  /** An embedded file, with or without /Desc. */
  attachment?: { desc?: string | null };
  /** A /FileAttachment annotation's /FS, which is NOT in /EmbeddedFiles. */
  looseFileSpec?: boolean;
}

export function buildUaMiscPdf(spec: UaMiscSpec): Uint8Array { /* Step 2b */ }
```

- [ ] **Step 2b: The builder body**

> Write it against the real APIs rather than guessing. Before starting, read
> `test/helpers/build-annot-pdf.ts` (the tagged-document scaffold and the raw
> `/Annots` push), `test/helpers/build-font-pdf.ts` (a hand-built font with a
> `/ToUnicode` stream — reuse its `toUnicodeStream` shape to map code 65 to
> U+E001 for `puaText`) and `test/helpers/build-render-mode-pdf.ts` (the
> content-stream idiom). The builder must produce, for the flags above:
> a page whose content draws one glyph in `/F1`, wrapped in `/Span << /MCID 0
> … >> BDC … EMC` when `mcProps` or `tagged` is set and in `/Artifact BDC` when
> `artifact` is; a structure tree of `Document > Sect > P` when `tagged`, with
> the `/Alt` placed on the `P` for `altOn: 'self'` and on the `Document` for
> `'grandparent'`; `doc.SetMetadata({ title })`; `doc.Lang`; and the optional
> content, outline, link, attachment and filespec objects the later tasks need.
> Use `doc.allocObject` for anything indirect and `doc.markModified()` before
> `doc.Save()`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-text.test.ts`
Expected: FAIL — none of the four rule ids appear.

- [ ] **Step 4: Write `src/uatext.ts`**

```ts
/** ISO 14289-2 clauses 8.4.3, 8.4.4 and 8.6 — PUA and natural language, six of
 *  the 11 rules `q7hc.4.4` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.4 Text representation for content/8.4.3`, `.../8.4.4` and
 *  `PDF_UA/2/8.6`, plus `PUAHelper.java` for the ranges and
 *  `MarkedContentHelper.java` for the /ActualText lookup, fetched 2026-09-16.
 *  A TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** its own module beside `uaannot.ts`, `uafont.ts` and
 *  `uadoc.ts`, all four over `uarule.ts`. The split is by SUBJECT.
 *
 *  **Invariant:** NOTHING here is converted, with ONE exception that is not
 *  this module's doing: `ConvertToPdfUa` already sets the catalog `/Lang` from
 *  `opts.lang`, so `CatalogLangMissing` resolves for any caller supplying one.
 *  Every other rule lands in `unresolved` — a PUA codepoint's meaning and a
 *  language tag are things only the author knows. @internal */
import { isDict, isString, type PdfDict, type PdfObject } from './types.js';
import { textOf, uaClause, vctx, type Rule, type UaCtx } from './uarule.js';
import { nameOf } from './validatectx.js';
import { distinctGlyphs } from './uaglyph.js';
import type { ValidationIssue } from './validation.js';

/** The Unicode private use areas, transcribed from veraPDF's `PUAHelper`:
 *  `{0xE000, 0xF8FF, 0xF0000, 0xFFFFD, 0x100000, 0x10FFFD}`.
 *
 *  **Invariant: THREE ranges, and both supplementary bounds end at `FFFD`.**
 *  The last two code points of each plane are noncharacters and are outside
 *  the private use area; a single-range check silently passes every
 *  supplementary PUA codepoint, which is the everyday shape for a symbol font
 *  that ran out of BMP room. Asserted by SIZE in
 *  `test/pdfua2-misc-coverage.test.ts`. */
const PUA_RANGES: readonly (readonly [number, number])[] = [
  [0xe000, 0xf8ff], [0xf0000, 0xffffd], [0x100000, 0x10fffd],
];

/** Does this text contain a private-use code point?
 *
 *  **Note it iterates by CODE POINT** where veraPDF indexes by UTF-16 unit and
 *  calls `codePointAt(i)` at every index. The two agree: at a lead surrogate
 *  both read the full code point, and at a trail surrogate veraPDF reads a
 *  value in `0xDC00..0xDFFF`, which is below every range here. */
export function containsPua(s: string | undefined): boolean {
  if (s === undefined || s === '') return false;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const [lo, hi] of PUA_RANGES) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

/** Exported for the census, which asserts the COUNT. @internal */
export const PUA_RANGE_COUNT = PUA_RANGES.length;

/** 8.4.3-1: real content mapping to PUA needs an /ActualText or /Alt.
 *
 *  Profile test:
 *  `isRealContent == false || unicodePUA == false || actualTextPresent == true
 *   || altPresent == true`.
 *
 *  **Invariant, and the obvious reading is WRONG:** the `/Alt` lookup reads the
 *  glyph's OWN structure element, never its ancestors —
 *  `MarkedContentHelper.containsStringKey` calls `structureElement.getKey(key)`
 *  directly and requires a non-empty STRING. So an `/Alt` on a grandparent does
 *  NOT excuse a PUA glyph. It checks the inherited MARKED-CONTENT attribute
 *  first, which is what `GlyphEvent.mcProps` supplies.
 *
 *  **Invariant:** `isRealContent` maps to `!artifact`. That term is a
 *  constructor parameter threaded down from veraPDF's operator layer rather
 *  than a quotable expression, so it is transcribed by INFERENCE — recorded
 *  here as such rather than presented as certain. */
const puaWithoutReplacementRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const g of distinctGlyphs(ctx)) {
    if (g.artifact === true) continue;
    if (!containsPua(g.text)) continue;
    if (g.mcProps?.actualText !== undefined || g.mcProps?.alt !== undefined) continue;
    // The glyph's OWN element, resolved by the walk. Read DIRECTLY, never up
    // the ancestor chain — see the invariant above.
    if (g.element !== undefined) {
      const at = textOf(ctx, g.element.Dict.get('ActualText'));
      const alt = textOf(ctx, g.element.Dict.get('Alt'));
      if ((at !== undefined && at !== '') || (alt !== undefined && alt !== '')) continue;
    }
    issues.push({
      rule: 'PuaWithoutReplacement', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.3' }),
      message: `Code ${g.code} maps to a Unicode private-use value with no `
        + '/ActualText or /Alt to say what it means.',
    });
  }
  return issues;
};
```

Add the three string rules:

```ts
/** 8.4.3-2 and 8.4.3-3: an /ActualText or /Alt shall not itself contain PUA.
 *
 *  Both over every structure element — `ctx.nodes` is the tree walk every
 *  structure rule already shares, so this adds no second walk. */
const structStringPuaRules: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { element } of ctx.nodes) {
    for (const [key, rule, clause] of [
      ['ActualText', 'ActualTextPua', '8.4.3'],
      ['Alt', 'AltPua', '8.4.3'],
    ] as const) {
      const v = textOf(ctx, element.Dict.get(key));
      if (!containsPua(v)) continue;
      issues.push({
        rule, severity: 'error',
        clause: uaClause(ctx.part, { 2: clause }), element,
        message: `The /${key} entry contains a Unicode private-use value.`,
      });
    }
  }
  return issues;
};

/** 8.6-1: a human-readable text string shall not use the PUA.
 *
 *  **Invariant: a CURATED set of entries, and that is a decision.** veraPDF
 *  decides "intended to be human readable" by which strings its model wraps as
 *  `CosTextString`; we have no such model, and sweeping every string in the
 *  document would report on `/ID`, the encryption `/O` and `/U`, and a
 *  signature's `/Contents` — binary values that are not text at all, so every
 *  encrypted or signed file would report. The set below is what this library
 *  already models as human-readable, which is the README's existing framing of
 *  these validators as a curated, machine-checkable subset. The narrowing is
 *  stated rather than left to be discovered. */
const textStringPuaRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const hit = (where: string, v: string | undefined): void => {
    if (!containsPua(v)) return;
    issues.push({
      rule: 'TextStringPua', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.6' }),
      message: `${where} contains a Unicode private-use value.`,
    });
  };
  const m = ctx.doc.GetMetadata();
  for (const k of ['title', 'author', 'subject', 'keywords', 'creator', 'producer'] as const) {
    hit(`/Info /${k[0].toUpperCase()}${k.slice(1)}`, m[k]);
  }
  for (const { element } of ctx.nodes) {
    for (const k of ['Alt', 'ActualText', 'E', 'T']) {
      hit(`A structure element's /${k}`, textOf(ctx, element.Dict.get(k)));
    }
  }
  // Outline titles, annotation /Contents //T //Subj, field /T //TU //V,
  // optional-content /Name //Creator and filespec /Desc follow the same shape.
  return issues;
};

export const TEXT_RULES: Rule[] = [
  puaWithoutReplacementRule, structStringPuaRules, textStringPuaRule,
];
```

> Finish `textStringPuaRule`'s remaining sources against the real accessors:
> `doc.Outlines` for titles, `page.Annotations` for `/Contents`, `/T` and
> `/Subj`, `doc.Form.Fields` for `/T`, `/TU` and a string `/V`,
> `doc.Layers.Configs` for `/Name` and `/Creator`, and `doc.Attachments` for
> `/Desc`. Confirm each accessor's name with `grep -n "get Outlines\|get
> Attachments\|get Layers" src/document.ts` before writing it.

- [ ] **Step 5: Append in `structvalidate.ts`**

```ts
import { TEXT_RULES } from './uatext.js';
```

and after `...FONT_RULES`:

```ts
  // q7hc.4.4 — ISO 14289-2 8.4.3, 8.4.4 and 8.6, part 2 only. APPENDED.
  ...TEXT_RULES,
```

- [ ] **Step 6: Run the test, the fences and the cycle check**

```bash
npx vitest run test/pdfua2-text.test.ts
npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfua2-font.test.ts test/import-cycles.test.ts
```
Expected: PASS, all, **unedited**.

- [ ] **Step 7: Prove three rules are load-bearing**

Run each mutation, confirm it reddens, then **revert**:

1. Drop the `g.artifact === true` skip — "EXEMPTS an artifact" must redden.
2. Walk the ancestor chain for `/Alt` instead of reading the element directly —
   "is NOT excused by /Alt on a GRANDPARENT" must redden.
3. Keep only `PUA_RANGES[0]` — both supplementary cases must redden.

- [ ] **Step 8: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uatext.ts src/structvalidate.ts test/pdfua2-text.test.ts test/helpers/build-ua-misc-pdf.ts CHANGELOG.md
git commit -m "feat(q7hc.4.4): the four PUA rules

PUA is THREE ranges and both supplementary bounds end at FFFD, not FFFF --
the last two of each plane are noncharacters. A single-range check passes
every supplementary PUA codepoint silently.

8.4.3-1's /Alt lookup reads the glyph's OWN structure element, never its
ancestors: containsStringKey calls structureElement.getKey(key) directly.
An /Alt on a grandparent does NOT excuse a PUA glyph, which is the
opposite of the obvious reading and is pinned by its own case.

8.6-1 is a CURATED set of entries rather than every string in the file:
sweeping all of them reports on /ID, the encryption /O and /U and a
signature's /Contents, so every encrypted or signed document would fail on
binary values that are not text."
```

---

### Task 4: `uatext.ts` — the two language rules

**Files:**
- Modify: `src/uatext.ts`
- Test: `test/pdfua2-text.test.ts`

**Interfaces:**
- Produces: rule names `CatalogLangMissing`, `LangSyntax`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-text.test.ts`:

```ts
describe('PDF/UA-2 8.4.4: natural language', () => {
  it('-1 reports a catalog with no /Lang', () => {
    expectPair({ lang: null }, 'CatalogLangMissing');
  });

  it('-1 is silent for a stated /Lang', () => {
    expect(ids({ lang: 'en-US' }, 2)).not.toContain('CatalogLangMissing');
  });

  it('-1 accepts an EMPTY /Lang, which 8.4.4-2 catches instead', () => {
    // The profile's prose says "non-empty"; its TEST is containsLang == true
    // alone. Implementing the prose would report one defect twice, and would
    // disagree with what veraPDF says about this file.
    expect(ids({ lang: '' }, 2)).not.toContain('CatalogLangMissing');
    expect(ids({ lang: '' }, 2)).toContain('LangSyntax');
  });

  it('-2 reports a /Lang failing the profile regex', () => {
    for (const bad of ['en_US', '1en', 'toolongsubtag9', 'en-', '-en']) {
      expect(ids({ lang: bad }, 2), bad).toContain('LangSyntax');
    }
  });

  it('-2 accepts the forms the regex admits', () => {
    for (const ok of ['en', 'en-US', 'zh-Hant-TW', 'x', 'abcdefgh-12345678']) {
      expect(ids({ lang: ok }, 2), ok).not.toContain('LangSyntax');
    }
  });

  it('-2 reaches a /Lang on a structure ELEMENT', () => {
    expectPair({ tagged: true, elementLang: 'en_US' }, 'LangSyntax');
  });

  it('-2 reaches a /Lang on a BDC property list', () => {
    expectPair({ bdcLang: 'en_US' }, 'LangSyntax');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-text.test.ts`
Expected: FAIL — neither rule id appears.

- [ ] **Step 3: Write the two rules**

Add to `src/uatext.ts` and to `TEXT_RULES`:

```ts
/** 8.4.4-2's language-tag grammar, transcribed VERBATIM from the profile:
 *  `/^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/`.
 *
 *  **Invariant: it is the ANCHOR's own regex and is NARROWER than BCP 47.**
 *  Do not substitute a general matcher and do not reach for `langmatch.ts`,
 *  which answers a different question (does this tag MATCH that range).
 *  Reporting what a conforming validator would not is as wrong as missing what
 *  it would. */
const LANG_TAG = /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/;

/** 8.4.4-1: the catalog shall state /Lang.
 *
 *  **Note it tests PRESENCE only.** The profile's description says "with a
 *  non-empty value" and its test is `containsLang == true` alone; an empty
 *  `/Lang ()` is caught by 8.4.4-2 instead, whose regex demands at least one
 *  letter. The pair gives the prose's answer and neither rule alone does, so
 *  adding a non-empty check here would report one defect twice.
 *
 *  Presence is read off the RAW catalog dict: `doc.resolve(undefined)` is
 *  `null`, so comparing a resolved value against `undefined` is true for every
 *  ABSENT key — the trap `pdfxvalidate.ts` and `pdfatransparency.ts` record. */
const catalogLangRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  if (ctx.catalog.has('Lang')) return [];
  return [{
    rule: 'CatalogLangMissing', severity: 'error',
    clause: uaClause(ctx.part, { 2: '8.4.4' }),
    message: 'Catalog dictionary does not contain a /Lang entry.',
  }];
};

/** 8.4.4-2: every /Lang shall match the profile's grammar — the catalog's,
 *  every structure element's, and every marked-content property list's.
 *
 *  **A stated NARROWING:** a property-list `/Lang` is seen only on a BDC that
 *  encloses at least one glyph, because it arrives through the glyph walk.
 *  `MarkedContentEvent` fires only when an `/MCID` resolves (`q7hc.1`) and
 *  widening that would break an invariant three other consumers rely on; a
 *  second content walker would be the duplication this repo repeatedly records
 *  as a defect. A `/Lang` on a sequence containing no text is not examined. */
const langSyntaxRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const check = (where: string, v: string | undefined): void => {
    if (v === undefined) return;
    const key = `${where}|${v}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (LANG_TAG.test(v)) return;
    issues.push({
      rule: 'LangSyntax', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.4.4' }),
      message: `${where} states the language tag '${v}', which is not a valid `
        + 'language identifier.',
    });
  };
  check('The catalog', textOf(ctx, ctx.catalog.get('Lang')));
  for (const { element } of ctx.nodes) {
    check('A structure element', textOf(ctx, element.Dict.get('Lang')));
  }
  for (const g of distinctGlyphs(ctx)) {
    check('A marked-content property list', g.mcProps?.lang);
  }
  return issues;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Assert that conversion already resolves 8.4.4-1**

This is the ONLY rule in the whole epic that an EXISTING pass fixes:
`ConvertToPdfUa` sets the catalog `/Lang` from `opts.lang`
(`pdfuaconvert.ts:42`). Assert it rather than assume it — append to
`test/pdfua2-text.test.ts`:

```ts
describe('8.4.4-1 resolves through the EXISTING /Lang conversion pass', () => {
  it('is not left unresolved when opts.lang is supplied', () => {
    // Every other rule in q7hc.4.4 lands in `unresolved`, and this one does not
    // — because pdfuaconvert.ts has set the catalog /Lang since PDF/UA-1. No
    // new pass was added for it; the assertion is here so the difference reads
    // as a fact about the converter rather than an accident.
    const doc = Document.Open(buildUaMiscPdf({ lang: null }));
    const report = doc.ConvertToPdfUa({ part: 2, title: 'T', lang: 'en-US' });
    expect(report.unresolved.map((i) => i.rule)).not.toContain('CatalogLangMissing');
  });
});
```

- [ ] **Step 6: Prove the empty-Lang split is load-bearing**

Mutate `catalogLangRule` to also report an empty value. Expected: the "accepts
an EMPTY /Lang" case reddens. Revert.

- [ ] **Step 7: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uatext.ts test/pdfua2-text.test.ts CHANGELOG.md
git commit -m "feat(q7hc.4.4): the two natural-language rules

8.4.4-1 tests PRESENCE only. The profile's prose says 'with a non-empty
value' and its test is containsLang == true alone -- an empty /Lang is
caught by 8.4.4-2's regex instead, which demands at least one letter. The
pair gives the prose's answer and neither rule alone does, so implementing
the prose would report one defect twice.

The regex is the anchor's own and is NARROWER than BCP 47; langmatch.ts
answers a different question and is deliberately not reused."
```

---

### Task 5: `uadoc.ts` — optional content and embedded files

**Files:**
- Create: `src/uadoc.ts`, `test/pdfua2-doc.test.ts`
- Modify: `src/structvalidate.ts`

**Interfaces:**
- Produces: `export const DOC_RULES: Rule[]`; rule names `OcConfigName`,
  `OcConfigAs`, `EmbeddedFileDesc`.

- [ ] **Step 1: Write the failing test**

Create `test/pdfua2-doc.test.ts` with the same `ids`/`expectPair` preamble as
`test/pdfua2-text.test.ts` (repeat it — the engineer may read these out of
order), then:

```ts
describe('PDF/UA-2 8.7: optional content', () => {
  it('-1 reports a /Configs entry with no /Name', () => {
    expectPair({ oc: { configs: 1, configName: null } }, 'OcConfigName');
  });

  it('-1 reports an EMPTY /Name', () => {
    expectPair({ oc: { configs: 1, configName: '' } }, 'OcConfigName');
  });

  it('-1 examines /D too, once /Configs exists', () => {
    expectPair({ oc: { configs: 1, configName: 'C', dName: null } }, 'OcConfigName');
  });

  it('-1 is SILENT with no /Configs array, whatever /D says', () => {
    // gContainsConfigs is a document-level variable off /OCProperties. A
    // document carrying only a /D is exempt ENTIRELY -- "including the default"
    // means /D is examined WHEN /Configs is present, not always. A fixture with
    // only a /D measures nothing whatever the code does.
    expect(ids({ oc: { dName: null } }, 2)).not.toContain('OcConfigName');
  });

  it('-2 reports /AS in a configuration dictionary', () => {
    expectPair({ oc: { configs: 1, configName: 'C', as: true } }, 'OcConfigAs');
  });

  it('-2 is silent without /AS', () => {
    expect(ids({ oc: { configs: 1, configName: 'C' } }, 2)).not.toContain('OcConfigAs');
  });
});

describe('PDF/UA-2 8.14.1-1: embedded files need a description', () => {
  it('reports an attachment with no /Desc', () => {
    expectPair({ attachment: { desc: null } }, 'EmbeddedFileDesc');
  });

  it('is silent when /Desc is present', () => {
    expect(ids({ attachment: { desc: 'A spreadsheet' } }, 2))
      .not.toContain('EmbeddedFileDesc');
  });

  it('EXEMPTS a filespec that is not in /EmbeddedFiles', () => {
    // The profile's own escape: `presentInEmbeddedFiles == false`. A
    // /FileAttachment annotation's /FS is a file specification and is not in
    // the name tree, so it is not examined.
    expect(ids({ looseFileSpec: true }, 2)).not.toContain('EmbeddedFileDesc');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-doc.test.ts`
Expected: FAIL — none of the three rule ids appear.

- [ ] **Step 3: Write the three rules**

```ts
/** ISO 14289-2 clauses 8.7, 8.8 and 8.14.1 — optional content, intra-document
 *  destinations and embedded files, five of the 11 rules `q7hc.4.4` added.
 *
 *  Transcribed from veraPDF/veraPDF-validation-profiles@integration
 *  `PDF_UA/2/8.7`, `PDF_UA/2/8.8` and `PDF_UA/2/8.14`, plus
 *  `veraPDF-parser`'s `PDDestination.java` and `PDAction.java`, which between
 *  them define what a structure destination IS. Fetched 2026-09-16. A
 *  TRANSCRIPTION and not a runnable oracle — `72nc.1`'s ceiling.
 *
 *  **Invariant:** NOTHING here is converted, and `ConvertToPdfUa` gains no
 *  pass. Synthesizing an optional-content `/Name` or an attachment `/Desc`
 *  invents text the document does not contain; stripping `/AS` is destructive,
 *  and `ocusage.ts` records that `/AS` is precisely what makes a `/Usage` do
 *  anything, so removing it silently changes what the document intends.
 *  @internal */
import { isDict, isName, isString, type PdfDict, type PdfObject } from './types.js';
import { textOf, uaClause, type Rule, type UaCtx } from './uarule.js';
import { collectNameTree } from './nametree.js';
import type { ValidationIssue } from './validation.js';

/** 8.7-1: every optional-content configuration needs a non-empty /Name — but
 *  ONLY when the catalog's /OCProperties carries a /Configs entry.
 *
 *  **Invariant, and the issue text got this wrong:** `gContainsConfigs` is a
 *  document-level variable over `PDOCProperties` (`containsConfigs`). A
 *  document carrying only a `/D` is exempt ENTIRELY. So "including the default"
 *  means `/D` is examined WHEN a `/Configs` array is present — not that `/D`
 *  always needs a name. A fixture with only a `/D` measures nothing. */
const ocConfigNameRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const props = ctx.doc.resolve(ctx.catalog.get('OCProperties'));
  if (!isDict(props) || !props.has('Configs')) return [];
  const issues: ValidationIssue[] = [];
  for (const cfg of ocConfigs(ctx)) {
    const n = textOf(ctx, cfg.get('Name'));
    if (n !== undefined && n !== '') continue;
    issues.push({
      rule: 'OcConfigName', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.7' }),
      message: 'An optional content configuration dictionary has a missing or '
        + 'empty /Name entry.',
    });
  }
  return issues;
};

/** 8.7-2: /AS shall not appear in any configuration dictionary.
 *
 *  **Note what this prohibits outright:** `ocusage.ts` records that `/Usage`
 *  ALONE IS INERT and that an `/AS` entry is what makes a usage application do
 *  anything. So PDF/UA-2 bans automatic usage application altogether — a
 *  document may still carry `/Usage`, and nothing will apply it. */
const ocConfigAsRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const cfg of ocConfigs(ctx)) {
    if (!cfg.has('AS')) continue;
    issues.push({
      rule: 'OcConfigAs', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.7' }),
      message: 'An optional content configuration dictionary contains the '
        + 'prohibited /AS entry.',
    });
  }
  return issues;
};

/** Every configuration dictionary: `/D` plus each `/Configs` entry. */
function ocConfigs(ctx: UaCtx): PdfDict[] {
  const props = ctx.doc.resolve(ctx.catalog.get('OCProperties'));
  if (!isDict(props)) return [];
  const out: PdfDict[] = [];
  const d = ctx.doc.resolve(props.get('D'));
  if (isDict(d)) out.push(d);
  const cfgs = ctx.doc.resolve(props.get('Configs'));
  if (Array.isArray(cfgs)) {
    for (const c of cfgs) {
      const r = ctx.doc.resolve(c);
      if (isDict(r)) out.push(r);
    }
  }
  return out;
}

/** 8.14.1-1: a file specification in /EmbeddedFiles needs a /Desc.
 *
 *  Profile test: `containsDesc == true || presentInEmbeddedFiles == false`. The
 *  escape is what keeps a `/FileAttachment` annotation's `/FS` — a file
 *  specification that is not in the name tree — out of the rule. */
const embeddedFileDescRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  const names = ctx.doc.resolve(ctx.catalog.get('Names'));
  if (!isDict(names)) return [];
  const entries: Array<[string, PdfObject]> = [];
  collectNameTree(ctx.doc, names.get('EmbeddedFiles') ?? null, entries);
  for (const [key, value] of entries) {
    const fs = ctx.doc.resolve(value);
    if (!isDict(fs) || fs.has('Desc')) continue;
    issues.push({
      rule: 'EmbeddedFileDesc', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.14.1' }),
      message: `The embedded file '${key}' has no /Desc entry describing it.`,
    });
  }
  return issues;
};

export const DOC_RULES: Rule[] = [
  ocConfigNameRule, ocConfigAsRule, embeddedFileDescRule,
];
```

- [ ] **Step 4: Append in `structvalidate.ts`**

```ts
import { DOC_RULES } from './uadoc.js';
```

and after `...TEXT_RULES`:

```ts
  ...DOC_RULES,
```

- [ ] **Step 5: Run the test, the fences and the cycle check**

```bash
npx vitest run test/pdfua2-doc.test.ts
npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/import-cycles.test.ts
```
Expected: PASS, all, **unedited**.

- [ ] **Step 6: Prove the /Configs gate is load-bearing**

Delete the `!props.has('Configs')` early return. Expected: the "is SILENT with
no /Configs array" case reddens. Revert.

- [ ] **Step 7: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uadoc.ts src/structvalidate.ts test/pdfua2-doc.test.ts test/helpers/build-ua-misc-pdf.ts CHANGELOG.md
git commit -m "feat(q7hc.4.4): the optional-content and embedded-file rules

8.7-1 is CONDITIONAL on a /Configs array existing -- gContainsConfigs is a
document-level variable, so a document carrying only a /D is exempt
entirely. 'Including the default' means /D is examined WHEN /Configs is
present, not that /D always needs a name; a fixture with only a /D
measures nothing whatever the code does.

8.7-2 bans /AS outright, which ocusage.ts records is precisely what makes
a /Usage do anything -- so PDF/UA-2 prohibits automatic usage application.

8.14.1-1's escape is presentInEmbeddedFiles == false, which keeps a
/FileAttachment annotation's /FS out of the rule."
```

---

### Task 6: `uadoc.ts` — the two destination rules

**Files:**
- Modify: `src/uadoc.ts`
- Test: `test/pdfua2-doc.test.ts`

**Interfaces:**
- Produces: rule names `DestinationNotStructure`, `GoToNotStructure`.

- [ ] **Step 1: Write the failing test**

Append to `test/pdfua2-doc.test.ts`:

```ts
describe('PDF/UA-2 8.8: intra-document destinations', () => {
  it('-1 reports an outline destination targeting a PAGE', () => {
    expectPair({ outlineDest: true }, 'DestinationNotStructure');
  });

  it('-2 reports a GoTo action with no /SD', () => {
    expectPair({ goTo: {} }, 'GoToNotStructure');
  });

  it('-2 is silent once /SD is present', () => {
    expect(ids({ goTo: { sd: true } }, 2)).not.toContain('GoToNotStructure');
  });

  it('-2 still reports when /D is a structure-destination ARRAY', () => {
    // The asymmetry, and it is the finding: PDDestination treats an array whose
    // first element carries /S as a structure destination, but
    // PDAction.containsStructureDestination falls through to FALSE for a direct
    // array -- only /SD, or a NAMED destination, satisfies an action. A fixture
    // that only toggles /SD present/absent cannot see this at all.
    expectPair({ goTo: { arrayIsStructDest: true } }, 'GoToNotStructure');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/pdfua2-doc.test.ts`
Expected: FAIL — neither rule id appears.

- [ ] **Step 3: Write the two rules**

```ts
/** Is this destination a STRUCTURE destination?
 *
 *  Transcribed from `veraPDF-parser`'s `PDDestination.getIsStructDestination`:
 *  a NAME or STRING is resolved through the catalog's `/Dests` dictionary or
 *  the `/Names /Dests` name tree FIRST — and a name that does not resolve is
 *  NOT a structure destination — then a DICT qualifies by carrying `/SD`, and
 *  an ARRAY by its FIRST ELEMENT carrying `/S`.
 *
 *  **Invariant, and it is the whole rule:** `at(0).knownKey('S')` means the
 *  first element is a STRUCTURE ELEMENT rather than a page. A structure element
 *  dictionary always carries `/S`, its type; a page never does. Testing for
 *  `/Type /StructElem` instead would miss every element that omits the
 *  optional `/Type`. */
function isStructDestination(ctx: UaCtx, destObj: PdfObject | undefined): boolean {
  let dest = ctx.doc.resolve(destObj);
  if (isString(dest) || isName(dest)) {
    const resolved = resolveNamedDest(ctx, dest);
    if (resolved === undefined) return false;
    dest = resolved;
  }
  if (isDict(dest)) return dest.has('SD');
  if (Array.isArray(dest) && dest.length > 0) {
    const first = ctx.doc.resolve(dest[0]);
    return isDict(first) && first.has('S');
  }
  return false;
}
```

> `resolveNamedDest(ctx, dest)` looks a STRING up in `/Root /Names /Dests`
> through `collectNameTree`, and a NAME up in the catalog's `/Dests`
> dictionary — the two are different mechanisms and both are in the transcribed
> source. Return `undefined` when the name is absent, so the caller reports.

```ts
/** 8.8-1: an in-document destination shall be a structure destination.
 *
 *  **Note this reports on documents THIS LIBRARY authors.** `AddOutline`,
 *  `/OpenAction` and named destinations all emit page destinations, and
 *  `q7hc.4.4` deliberately did NOT change them: an outline item's `/Dest` is
 *  tested directly, so satisfying it means replacing the page reference with a
 *  structure element — a destination a PDF 1.7 viewer cannot resolve. Trading
 *  navigation in every existing viewer for a conformance line is the caller's
 *  decision, so the rule reports and conversion leaves it unresolved, exactly
 *  as `FontNotEmbedded` does. Only GoTo ACTIONS were changed, because `/SD`
 *  sits BESIDE `/D` there and costs no compatibility. */
const destinationRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { where, dest } of documentDestinations(ctx)) {
    if (isStructDestination(ctx, dest)) continue;
    issues.push({
      rule: 'DestinationNotStructure', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.8' }),
      message: `${where} targets a page rather than a structure element.`,
    });
  }
  return issues;
};

/** 8.8-2: a GoTo action shall carry a structure destination.
 *
 *  **Invariant, and it is NOT 8.8-1's test:**
 *  `PDAction.containsStructureDestination` answers true for `/SD`, or for a `/D`
 *  that is a NAME or STRING resolving to a structure destination — and FALLS
 *  THROUGH TO FALSE for a `/D` that is a direct ARRAY, even when that array IS
 *  a structure destination. So an action can satisfy this only through `/SD` or
 *  a named destination. Writing a structure-destination array into `/D`
 *  provably cannot satisfy it, which is why the authoring change adds `/SD`. */
const goToActionRule: Rule = (ctx) => {
  if (ctx.part !== 2) return [];
  const issues: ValidationIssue[] = [];
  for (const { where, action } of goToActions(ctx)) {
    if (action.has('SD')) continue;
    const d = ctx.doc.resolve(action.get('D'));
    if ((isString(d) || isName(d)) && isStructDestination(ctx, d)) continue;
    issues.push({
      rule: 'GoToNotStructure', severity: 'error',
      clause: uaClause(ctx.part, { 2: '8.8' }),
      message: `${where} carries no structure destination (/SD).`,
    });
  }
  return issues;
};
```

> `documentDestinations(ctx)` yields every in-document destination with a label:
> each outline item's `/Dest` (walk `doc.Outlines`), the catalog's
> `/OpenAction` when it is an ARRAY rather than an action dict, and each
> `/Names /Dests` entry. `goToActions(ctx)` yields every action dict whose `/S`
> is `GoTo`: an annotation's `/A`, an outline item's `/A`, and the catalog's
> `/OpenAction` when it IS an action dict. Confirm the accessors with
> `grep -n "get Outlines" src/document.ts` and reuse
> `page.Annotations` rather than walking `/Annots` by hand.

Add both to `DOC_RULES`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/pdfua2-doc.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the asymmetry is load-bearing**

Mutate `goToActionRule` to accept a direct `/D` array through
`isStructDestination`. Expected: the "still reports when /D is a
structure-destination ARRAY" case reddens. Revert.

- [ ] **Step 6: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/uadoc.ts test/pdfua2-doc.test.ts test/helpers/build-ua-misc-pdf.ts CHANGELOG.md
git commit -m "feat(q7hc.4.4): the two intra-document destination rules

A structure destination is an ARRAY whose FIRST ELEMENT carries /S -- a
structure element rather than a page -- or a DICT carrying /SD. Testing
for /Type /StructElem instead would miss every element omitting that
optional key.

8.8-2 is NOT the same test: PDAction.containsStructureDestination falls
through to FALSE for a /D that is a direct array, even when that array IS
a structure destination, so only /SD or a named destination satisfies an
action. A fixture that only toggles /SD cannot see that at all, which is
why one carries a structure-destination array in /D."
```

---

### Task 7: A GoTo action gains `/SD`

**Files:**
- Modify: `src/actions.ts`
- Test: `test/struct-dest-authoring.test.ts`

**Interfaces:**
- Consumes: `StructTreeRoot.Children`, `StructElement.Children`,
  `StructElement.Page` from `./struct.js`.

- [ ] **Step 1: Write the failing test**

Create `test/struct-dest-authoring.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

describe('a GoTo action carries /SD in a tagged document', () => {
  it('adds /SD beside /D, leaving /D a page destination', () => {
    const doc = Document.Open(buildTaggedPdf());
    const page = doc.Pages[0];
    page.AddLink([10, 10, 60, 30], { type: 'goto', page: 0 });
    const a = doc.resolve(page.Annotations[page.Annotations.length - 1].Dict.get('A'));
    expect(a).toBeDefined();
    // /D stays a page destination, so a PDF 1.7 viewer navigates as before.
    const d = doc.resolve((a as Map<string, unknown>).get('D')) as unknown[];
    expect(Array.isArray(d)).toBe(true);
    // /SD is the structure destination the rule asks for.
    const sd = doc.resolve((a as Map<string, unknown>).get('SD')) as unknown[];
    expect(Array.isArray(sd)).toBe(true);
  });

  it('satisfies 8.8-2', () => {
    const doc = Document.Open(buildTaggedPdf());
    doc.Pages[0].AddLink([10, 10, 60, 30], { type: 'goto', page: 0 });
    const round = Document.Open(doc.Save());
    expect(round.ValidatePdfUa(2).Issues.map((i) => i.rule))
      .not.toContain('GoToNotStructure');
  });

  it('writes NO /SD in an UNTAGGED document, which stays byte-identical', () => {
    // There is no structure element to point at, so the output must not move.
    const a = Document.Open(buildStampTarget());
    a.Pages[0].AddLink([10, 10, 60, 30], { type: 'goto', page: 0 });
    const withLink = a.Save();
    const b = Document.Open(buildStampTarget());
    b.Pages[0].AddLink([10, 10, 60, 30], { type: 'goto', page: 0 });
    expect(Buffer.from(withLink).equals(Buffer.from(b.Save()))).toBe(true);
    const act = a.resolve(a.Pages[0].Annotations[0].Dict.get('A')) as Map<string, unknown>;
    expect(act.has('SD')).toBe(false);
  });
});
```

> **Confirm `Page.AddLink`'s name and signature first** with
> `grep -n "AddLink" src/page.ts src/annotation.ts`. If it differs, use the real
> one; do NOT invent an API.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/struct-dest-authoring.test.ts`
Expected: FAIL — no `/SD` is written.

- [ ] **Step 3: Implement**

In `src/actions.ts`, at the GoTo branch (line 61), after `/D` is set:

```ts
        // ISO 14289-2 8.8-2: a GoTo action satisfies the rule only through /SD.
        // PDAction.containsStructureDestination falls through to FALSE for a /D
        // that is a direct ARRAY, even when that array IS a structure
        // destination -- so /SD is the only route, and it sits BESIDE /D rather
        // than replacing it, which costs no compatibility: a PDF 1.7 viewer
        // reads /D and navigates exactly as before.
        //
        // Written only when the document is tagged AND an element resolves for
        // the target page, so an untagged document is byte-identical.
        const el = firstElementOnPage(doc, p);
        if (el !== undefined) dict.set('SD', encodeDest(el.Ref, a.view));
```

Add the helper to `src/actions.ts`:

```ts
/** The first structure element, in TREE ORDER, whose content lies on `page`.
 *
 *  Tree order rather than content order because it is deterministic and
 *  independent of how the page was drawn — two documents with the same
 *  structure produce the same destination. `StructElement.Page` walks `/Pg` up
 *  the ancestor chain, so an element inheriting its page from a parent is
 *  found. Returns `undefined` for an untagged document, which is what keeps
 *  every existing fixture byte-identical. */
function firstElementOnPage(doc: Document, page: number): StructElement | undefined {
  const root = doc.GetStructTree();
  if (!root) return undefined;
  const walk = (els: StructElement[]): StructElement | undefined => {
    for (const el of els) {
      if (el.Page?.Number === page) return el;
      const found = walk(el.Children);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(root.Children);
}
```

> `StructElement.Ref` must be an indirect reference for `encodeDest` to accept
> it. Confirm with `grep -n "get Ref" src/struct.ts`; if the element exposes no
> ref, take it from the tree walk instead, and if it cannot be referenced
> indirectly, return `undefined` rather than writing a direct dict into a
> destination array.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/struct-dest-authoring.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Prove untagged output did not move**

```bash
npx vitest run test/annotations.test.ts test/outline.test.ts test/toc.test.ts test/html-identity.test.ts test/markdown-export.test.ts
```
Expected: PASS. A moved byte-identity hash here means `/SD` is being written for
a document that should not get one.

- [ ] **Step 6: Typecheck, suite, commit**

```bash
npm run typecheck && npm test
git add src/actions.ts test/struct-dest-authoring.test.ts CHANGELOG.md
git commit -m "feat(q7hc.4.4): a GoTo action carries /SD in a tagged document

ISO 14289-2 8.8-2 is satisfiable by an action ONLY through /SD:
PDAction.containsStructureDestination falls through to false for a /D that
is a direct array, even when that array is itself a structure destination.

/SD sits BESIDE /D rather than replacing it, so there is no compatibility
loss -- a PDF 1.7 viewer reads /D and navigates as before. Outline items
and /OpenAction are deliberately NOT changed: their /Dest is tested
directly, so satisfying 8.8-1 there means a destination an older viewer
cannot resolve, and that trade is the caller's to make.

Untagged documents are byte-identical by construction, since no element
resolves and no /SD is written."
```

---

### Task 8: The census, the count, and the docs

**Files:**
- Create: `test/pdfua2-misc-coverage.test.ts`
- Modify: `CLAUDE.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 0: Absorb the `pdfua2-convert.test.ts` fallout**

Expected, and predicted by the spec. That file asserts an EXHAUSTIVE
`unresolved` list, so any new rule firing on its fixtures moves it — as
`FontNotEmbedded` did in `q7hc.4.3`. Run it and read what appeared:

```bash
npx vitest run test/pdfua2-convert.test.ts
```

For each new entry, decide whether it is a TRUE POSITIVE on that fixture before
touching the list. `buildTaggedPdf` carries a `/Link` annotation, so
`GoToNotStructure` and `DestinationNotStructure` are both plausible; neither is
converted, by the decision recorded in `uadoc.ts`. Add each to the expected
array **with a comment in that file's own style**, beside `HeadingNesting`,
`LinkEnclosure` and `FontNotEmbedded`, naming the clause and why conversion
declines it.

**Do NOT suppress a rule to keep this file green.** If an entry is not a true
positive on that fixture, the rule is wrong — fix the rule.

- [ ] **Step 1: Write the census**

Create `test/pdfua2-misc-coverage.test.ts`, listing the 11 rule names against
their clauses exactly as `test/pdfua2-font-coverage.test.ts` does. Assert
`toHaveLength(11)`, that each appears in `src/uatext.ts` or `src/uadoc.ts`, that
`PUA_RANGES` holds **3** entries (parsed out of the source the way the font
census parses `TABLE_116_CMAPS`), and that every rule is gated to part 2.

```ts
const CLAUSE_RULES = [
  'PuaWithoutReplacement',   // 8.4.3-1
  'ActualTextPua',           // 8.4.3-2
  'AltPua',                  // 8.4.3-3
  'CatalogLangMissing',      // 8.4.4-1
  'LangSyntax',              // 8.4.4-2
  'TextStringPua',           // 8.6-1
  'OcConfigName',            // 8.7-1
  'OcConfigAs',              // 8.7-2
  'DestinationNotStructure', // 8.8-1
  'GoToNotStructure',        // 8.8-2
  'EmbeddedFileDesc',        // 8.14.1-1
] as const;
```

- [ ] **Step 2: Correct the rule count in CLAUDE.md**

Find the paragraph beginning **"Note the SCOPE, so the absences read as
decisions"**. It says **79 of 91** ship with 12 remaining as `.4` (11) and
`.6` (1). Update to: **90 of 91** ship, the one remaining being `.6`
(`8.10.3.5-1`, 1).

- [ ] **Step 3: Add the CLAUDE.md entries**

Three new Source-list entries after `uafont.ts`: `uaglyph.ts`, `uatext.ts` and
`uadoc.ts`, each carrying its subject, its anchor, and the invariants this plan
records — for `uaglyph.ts` the FINER key and why `uafont.ts` collapses it; for
`uatext.ts` the three PUA ranges, the direct-element `/Alt` lookup, the
curated 8.6-1 set, and 8.4.4-1 testing presence only; for `uadoc.ts` the
`/Configs` gate and the destination asymmetry.

Extend `text.ts`'s entry with the `mcProps` invariant and the stated narrowing.
Extend `uarule.ts`'s entry with `vctx` and why it moved there.
Extend `actions.ts`'s coverage with the `/SD` rule and the compatibility
argument.

- [ ] **Step 4: README and CHANGELOG**

Extend the `ValidatePdfUa` sentence with clauses 8.4.3, 8.4.4, 8.6, 8.7, 8.8 and
8.14.1, naming the curated 8.6-1 scope as a limitation and the fact that outline
destinations report. Note under Limitations that a `/Lang` on a marked-content
sequence containing no text is not examined.

Add an `## [Unreleased]` → `### Added` entry citing `q7hc.4.4` that names the 11
rules, the `/SD` authoring change and its compatibility argument, and the two
things a reader would otherwise get wrong: 8.4.4-1 testing presence only, and
8.7-1 being conditional on `/Configs`.

- [ ] **Step 5: Full verification and commit**

```bash
npm run typecheck && npm test
npx vitest run test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts test/pdfua2-font.test.ts test/import-cycles.test.ts
node -e "const fs=require('fs');const md=fs.readFileSync('CLAUDE.md','utf8');const m=fs.readdirSync('src').filter(f=>f.endsWith('.ts')).filter(b=>!md.includes('**'+b+'**')&&!md.includes('\`'+b+'\`'));console.log(m.length===0?'sweep clean':'MISSING: '+m.join(', '));"
git add test/pdfua2-misc-coverage.test.ts CLAUDE.md README.md CHANGELOG.md
git commit -m "docs(q7hc.4.4): the census, and 90 of 91"
```

---

## Final verification

- [ ] `npm run typecheck` and `npm test` — green.
- [ ] The four part-1 fences pass **with no edit in the diff**:
      `git diff --stat main -- test/pdfua-part1-identity.test.ts test/pdfua2-validate.test.ts test/pdfuaconvert.test.ts test/markdown-pdfua.test.ts`
      (expected: empty).
- [ ] **The font fences did not move.**
      `git diff --stat main -- test/pdfua2-font.test.ts test/pdfua2-font-coverage.test.ts`
      must also be empty. If either moved, the dedup collapse in Task 1 is wrong
      and font findings changed granularity.
- [ ] **No extraction test moved.** `mcProps` is absent unless a BDC states one,
      so `git diff --stat main -- test/text.test.ts test/text-fragments.test.ts test/text-script.test.ts test/docmodel.test.ts`
      must be empty.
- [ ] `test/import-cycles.test.ts` — the same 15 pairs.
- [ ] The CLAUDE.md sweep prints nothing.
- [ ] `test/pdfua2-convert.test.ts` moved ONLY to add new true positives, each
      explained in that file's own style beside `HeadingNesting`,
      `LinkEnclosure` and `FontNotEmbedded`.
- [ ] `bd close q7hc.4.4` with a note recording: the three issue-text
      corrections, the destination asymmetry, the curated 8.6-1 scope, the
      stated `/Lang` narrowing, the `isRealContent` inference, and any rule a
      mutation showed to be uncovered.
- [ ] `git pull --rebase && git push && git status` — must show up to date with
      origin. **Work is not complete until the push succeeds.**
