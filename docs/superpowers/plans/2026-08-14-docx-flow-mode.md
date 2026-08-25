# DOCX Flow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `Document`/`Page` a `ToDocx()` that maps `docmodel.ts`'s neutral tree to WordprocessingML — styled runs, `Heading1`–`Heading6`, lists, hyperlinks, images and tables — inside the package `8yt9.1` already writes.

**Architecture:** Four new modules on the pattern `svgdraw.ts`/`svgembed.ts` set: three pure (`docxflow.ts` maps nodes to body XML through injected sinks, `docxtable.ts` maps a `Table` to `w:tbl`, `docxstyles.ts` generates `styles.xml` and `numbering.xml`) and one — `docxexport.ts` — that touches a `Document` to encode images and assemble parts. Before any of that, three shared files gain what the mapper has nothing to read today: `font.ts` learns to report weight and slant, `text.ts`/`struct.ts` carry it onto their text runs, and `docmodel.ts` carries it plus each figure's drawn size onto the neutral model.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest, `node:zlib` only. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-docx-flow-mode-design.md`

## Global Constraints

- **Zero runtime dependencies** — only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension (`import { Page } from './page.js'`).
- **Issue tracking is `bd`**, never TodoWrite or markdown TODO lists. This plan is `aspose-pdf-foss-for-ts-8yt9.2`.
- **Both gates green before any task is considered done:** `npm run typecheck` and `npm test`.
- **Byte-identity fence:** `test/html-identity.test.ts` and the Markdown export snapshots must stay green through Tasks 1–5. They are the evidence the model extension moved nothing; if one goes red, the change is wrong, not the snapshot.
- **Prove assertions load-bearing.** A test passing on its first run is not evidence. Break the path it covers, confirm red, restore. Task 12 collects the mutations that must be run.
- **Error types** are `PdfParseError` / `UnsupportedFeatureError` / `InvalidPasswordError` from `errors.ts`. Nothing in this plan should throw a new kind.
- **Word compatibility is not claimed.** No CI here opens Word; tests prove ECMA-376 structural conformance only.

Two unit constants are shared by three of the new modules:

```ts
export const EMU_PER_PT = 12700;    // 914400 EMU per inch, 72pt per inch
export const TWIPS_PER_PT = 20;     // 1440 twips per inch
```

They live in `docxstyles.ts` (Task 6) and are imported from there by
`docxflow.ts`, `docxtable.ts` and `docxexport.ts`. **Not** in `docxflow.ts`:
`docxflow.ts` imports `docxtable.ts`, so a constant defined in the former and
imported by the latter is a module cycle — the same hazard that makes
`docxtable.ts` take its paragraph builder as an argument. `docxstyles.ts`
imports neither, which is what makes it the safe home.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/font.ts` (modify) | `fontStyleOf` + `TextFont.bold`/`.italic` — the single owner of "is this font bold or italic" |
| `src/text.ts` (modify) | `TextFragment` carries `bold`/`italic` (untagged path) |
| `src/struct.ts` (modify) | `StructTextNode` carries them; `Nodes` splits a run where the style changes (tagged path) |
| `src/docmodel.ts` (modify) | `DocText.bold`/`.italic`, `DocFigure.sizes` — both builders |
| `src/docxstyles.ts` (new) | `styles.xml`, `numbering.xml`, and the style-id vocabulary |
| `src/docxflow.ts` (new) | `DocNode[]` → `<w:body>` inner XML, through injected sinks |
| `src/docxtable.ts` (new) | `Table` → `w:tbl` |
| `src/docxexport.ts` (new) | The only module here that reads a `Document`: model, image encoding, package assembly |
| `src/docxpackage.ts` (modify) | `writeDocx` gains optional extra parts and rels |
| `src/document.ts`, `src/page.ts`, `src/node.ts`, `src/index.ts` (modify) | Public entry points |

---

### Task 1: `fontStyleOf` — one owner for weight and slant

**Files:**
- Modify: `src/font.ts`
- Test: `test/font-style.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks. `PdfDict` is a `Map<string, PdfObject>` keyed without the leading `/`; `type Resolve = (o: PdfObject | undefined) => PdfObject` is already declared at `src/font.ts:15`.
- Produces:
  ```ts
  export interface FontStyle { bold: boolean; italic: boolean }
  export function fontStyleOf(dict: PdfDict, resolve: Resolve): FontStyle;
  // and on TextFont:
  readonly bold: boolean;
  readonly italic: boolean;
  ```

Why a free function over the dict rather than a method on `TextFont`: `TextFont` does not retain its descriptor, and a pure function over a dict is testable without constructing a font. The constructor calls it and stores the two booleans.

- [ ] **Step 1: Write the failing test**

Create `test/font-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { fontStyleOf } from '../src/font.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';

/** Identity resolve: these dicts hold no indirect references. */
const R = (o: PdfObject | undefined): PdfObject => o as PdfObject;

const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

const withDescriptor = (base: string, fd: [string, PdfObject][]): PdfDict =>
  dict([['BaseFont', name(base)], ['FontDescriptor', dict(fd)]]);

describe('fontStyleOf', () => {
  it('reads italic from /Flags bit 7', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['Flags', 64]]), R))
      .toEqual({ bold: false, italic: true });
  });

  it('reads bold from the ForceBold flag', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['Flags', 262144]]), R).bold).toBe(true);
  });

  it('reads italic from a non-zero /ItalicAngle', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['ItalicAngle', -12]]), R).italic).toBe(true);
  });

  it('reads bold from /FontWeight >= 600', () => {
    expect(fontStyleOf(withDescriptor('AnonFace', [['FontWeight', 700]]), R).bold).toBe(true);
    expect(fontStyleOf(withDescriptor('AnonFace', [['FontWeight', 400]]), R).bold).toBe(false);
  });

  // A subset prefix must not defeat the name test: this is the everyday shape
  // of an embedded face, and an equality test against a face list misses it.
  it('sees through a subset prefix in the /BaseFont name', () => {
    expect(fontStyleOf(dict([['BaseFont', name('AAAAAB+Arial-BoldMT')]]), R).bold).toBe(true);
    expect(fontStyleOf(dict([['BaseFont', name('ABCDEF+Helvetica-Oblique')]]), R).italic).toBe(true);
  });

  it('treats a plain face as neither', () => {
    expect(fontStyleOf(dict([['BaseFont', name('Helvetica')]]), R))
      .toEqual({ bold: false, italic: false });
  });

  // The name is positive evidence in its own right. A descriptor that merely
  // omits /FontWeight says nothing, and must not veto a name that does.
  it('believes the name when the descriptor is silent', () => {
    expect(fontStyleOf(withDescriptor('Arial-BoldItalicMT', [['Flags', 4]]), R))
      .toEqual({ bold: true, italic: true });
  });

  // A composite font keeps its descriptor on the DESCENDANT, not the parent.
  it('finds a Type0 descriptor through /DescendantFonts', () => {
    const desc = dict([['FontDescriptor', dict([['Flags', 262144]])]]);
    const f = dict([
      ['Subtype', name('Type0')], ['BaseFont', name('AnonFace')],
      ['DescendantFonts', [desc] as unknown as PdfObject],
    ]);
    expect(fontStyleOf(f, R).bold).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/font-style.test.ts`
Expected: FAIL — `fontStyleOf` is not exported from `src/font.ts`.

- [ ] **Step 3: Implement `fontStyleOf` in `src/font.ts`**

Add above `export class TextFont` (around line 155):

```ts
/** A font's weight and slant, as the document declares them. */
export interface FontStyle { bold: boolean; italic: boolean }

/** The descriptor that describes `dict`'s outlines: a composite font keeps it
 *  on the descendant, not on the Type0 parent. */
function descriptorOf(dict: PdfDict, resolve: Resolve): PdfDict | undefined {
  const direct = resolve(dict.get('FontDescriptor'));
  if (isDict(direct)) return direct;
  const desc = resolve(dict.get('DescendantFonts'));
  if (!isArray(desc) || !desc.length) return undefined;
  const d0 = resolve(desc[0]);
  if (!isDict(d0)) return undefined;
  const fd = resolve(d0.get('FontDescriptor'));
  return isDict(fd) ? fd : undefined;
}

/** Is this font bold, and is it italic?
 *
 *  **Invariant:** ONE owner. Two consumers ask — the tagged path through
 *  `struct.ts` and the untagged path through `fragmentsFromGlyphs` — and a
 *  second copy is how the two come to disagree about whether a heading is bold
 *  on a document where only one of them runs. Same rule glyphprogram.ts records
 *  for `gidForCode`.
 *
 *  **Invariant:** every signal is POSITIVE evidence and they are OR-ed; a
 *  descriptor that merely omits `/FontWeight` says nothing and must not veto a
 *  `/BaseFont` name that says Bold. Most embedded subsets carry a name and an
 *  almost empty descriptor.
 *
 *  **Invariant:** the name test sees through a subset prefix. `/AAAAAB+Arial-BoldMT`
 *  is the everyday shape of an embedded face, so this is a substring search on
 *  the stripped name, never an equality test against a face list. */
export function fontStyleOf(dict: PdfDict, resolve: Resolve): FontStyle {
  let bold = false;
  let italic = false;

  const fd = descriptorOf(dict, resolve);
  if (fd) {
    const flags = resolve(fd.get('Flags'));
    if (typeof flags === 'number') {
      if (flags & 64) italic = true;         // bit 7, Italic
      if (flags & 262144) bold = true;       // bit 19, ForceBold
    }
    const angle = resolve(fd.get('ItalicAngle'));
    if (typeof angle === 'number' && angle !== 0) italic = true;
    const weight = resolve(fd.get('FontWeight'));
    if (typeof weight === 'number' && weight >= 600) bold = true;
  }

  const bf = resolve(dict.get('BaseFont'));
  if (isName(bf)) {
    const n = bf.name.replace(/^[A-Z]{6}\+/, '').toLowerCase();
    if (/bold|black|heavy/.test(n)) bold = true;
    if (/italic|oblique/.test(n)) italic = true;
  }
  return { bold, italic };
}
```

`isArray` is already imported in `font.ts`; confirm `isDict` and `isName` are too and add them to the existing `./types.js` import if not.

- [ ] **Step 4: Store the answer on `TextFont`**

Add the fields to the class body beside `readonly name?: string` (around line 179):

```ts
  /** True when the document declares this font bold / italic. See fontStyleOf. */
  readonly bold: boolean;
  readonly italic: boolean;
```

and in the constructor, immediately after the `/BaseFont` block (`if (isName(bf)) this.name = bf.name;`):

```ts
    const style = fontStyleOf(dict, resolve);
    this.bold = style.bold;
    this.italic = style.italic;
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/font-style.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors
Run: `npm test` — Expected: whole suite green

- [ ] **Step 6: Commit**

```bash
git add src/font.ts test/font-style.test.ts
git commit -m "feat(font): one owner for a font's weight and slant"
```

---

### Task 2: `TextFragment` carries `bold`/`italic`

**Files:**
- Modify: `src/text.ts` (the `TextFragment` interface around line 549, and `fragmentsFromGlyphs` around line 570)
- Test: `test/text-fragment-style.test.ts` (new)

**Interfaces:**
- Consumes: `TextFont.bold` / `TextFont.italic` (Task 1). `GlyphEvent.font` is a `TextFont` (`src/text.ts:207`).
- Produces: `TextFragment.bold?: boolean`, `TextFragment.italic?: boolean`.

`fragmentsFromGlyphs` already breaks a fragment on a font change and already holds the `TextFont` in its `Cur` accumulator, so the run granularity is free — this is only stamping two fields at flush time.

- [ ] **Step 1: Write the failing test**

Create `test/text-fragment-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';

/** flow.AddHeading draws in Helvetica-Bold and AddParagraph in Helvetica, so
 *  one rendered flow gives both a bold and a plain fragment. */
function rendered() {
  const doc = Document.New();
  const flow = doc.NewFlow();
  flow.AddHeading(1, 'Bold heading');
  flow.AddParagraph('Plain body text.');
  const [page] = flow.Render();
  return page;
}

const fragOf = (page: ReturnType<typeof rendered>, needle: string) =>
  page.GetTextFragments().find((f) => f.text.includes(needle))!;

describe('TextFragment style', () => {
  it('marks a fragment drawn in a bold face', () => {
    expect(fragOf(rendered(), 'Bold heading').bold).toBe(true);
  });

  // Absent, not `false`: a fragment is compared and snapshotted in several
  // tests, and a key that is always present moves output unrelated to this.
  it('omits the fields for a plain face', () => {
    const f = fragOf(rendered(), 'Plain body');
    expect(f.bold).toBeUndefined();
    expect(f.italic).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/text-fragment-style.test.ts`
Expected: FAIL — `.bold` is `undefined` on the heading fragment (and TypeScript rejects the property).

- [ ] **Step 3: Extend the interface**

In `src/text.ts`, add to `TextFragment` after `fontName?: string`:

```ts
  /** True when the producing font declares itself bold / italic. Absent rather
   *  than false, so a fragment gains no key when the answer is "no". */
  bold?: boolean;
  italic?: boolean;
```

- [ ] **Step 4: Stamp them in `fragmentsFromGlyphs`**

In the `flush` closure, the fragment is currently assembled as:

```ts
    const { font, end, line, angle, vert, ...rest } = cur;
    const frag = Math.abs(angle) > 1e-6 ? { ...rest, angle } : rest;
    out.push(vert ? { ...frag, vertical: true } : frag);
```

Replace the last line with:

```ts
    const styled = {
      ...frag,
      ...(font.bold ? { bold: true } : {}),
      ...(font.italic ? { italic: true } : {}),
    };
    out.push(vert ? { ...styled, vertical: true } : styled);
```

`cur` is built per font, so `font` is constant across the fragment being flushed — this is why no split has to be added here.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/text-fragment-style.test.ts` — Expected: PASS
Run: `npm run typecheck && npm test` — Expected: green, **including** `test/text-fragments.test.ts` and `test/html-identity.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/text.ts test/text-fragment-style.test.ts
git commit -m "feat(text): carry the producing font's weight and slant on a fragment"
```

---

### Task 3: `StructTextNode` splits on style

**Files:**
- Modify: `src/struct.ts` (`StructTextNode` at line 37; `Nodes` around line 216; `interleave` around line 245)
- Test: `test/struct-text-style.test.ts` (new)

**Interfaces:**
- Consumes: `TextFont.bold`/`.italic` (Task 1); the module-private `spacedText(glyphs: GlyphEvent[]): string` and `mcidGlyphs(doc, page): Map<number, GlyphEvent[]>`.
- Produces: `StructTextNode.bold?: boolean`, `StructTextNode.italic?: boolean`, and the guarantee that one MCID may now yield several text nodes.

- [ ] **Step 1: Write the failing test**

Create `test/struct-text-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { StructElement } from '../src/struct.js';

/** A tagged flow whose paragraph has a bold phrase in the middle: mdruns.ts
 *  maps `**word**` onto the bold member of the face's family. */
function taggedDoc() {
  const doc = Document.New();
  const flow = doc.NewFlow({ tagged: true });
  flow.AddMarkdown('Plain start **bold middle** plain end.');
  flow.Render();
  return doc;
}

/** Every text node under the tree, depth first. */
function textNodes(el: StructElement): { text: string; bold?: boolean }[] {
  const out: { text: string; bold?: boolean }[] = [];
  for (const n of el.Nodes) {
    if (n instanceof StructElement) out.push(...textNodes(n));
    else out.push({ text: n.text, ...(n.bold ? { bold: true } : {}) });
  }
  return out;
}

describe('StructTextNode style', () => {
  it('splits one own-text run where the style changes', () => {
    const root = taggedDoc().GetStructTree()!;
    const nodes = root.Children.flatMap((c) => textNodes(c));
    const bold = nodes.filter((n) => n.bold);
    expect(bold.length).toBe(1);
    expect(bold[0].text.trim()).toBe('bold middle');
  });

  // The split is three more chances to make the mistake spacedText exists to
  // prevent: concatenating the pieces must reproduce the whole paragraph,
  // separator spaces and all.
  it('keeps the spaces either side of the split', () => {
    const root = taggedDoc().GetStructTree()!;
    const joined = root.Children.flatMap((c) => textNodes(c)).map((n) => n.text).join('');
    expect(joined.replace(/\s+/g, ' ').trim()).toBe('Plain start bold middle plain end.');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/struct-text-style.test.ts`
Expected: FAIL — one text node per MCID, so no node is marked bold.

- [ ] **Step 3: Extend the interface and add the splitter**

In `src/struct.ts`, replace the `StructTextNode` declaration at line 37:

```ts
export interface StructTextNode {
  kind: 'text'; text: string; page: Page;
  /** True when the run's font declares itself bold / italic. Absent when not. */
  bold?: boolean; italic?: boolean;
}
```

Add beside `spacedText` (around line 590):

```ts
/** Split a glyph run into maximal pieces sharing a style, each still built by
 *  `spacedText`.
 *
 *  **Invariant:** the split is on the derived STYLE, not on the font object. A
 *  document that sets one face through two font objects, or alternates between
 *  two regular faces, must not fragment into a run per font — that multiplies
 *  runs downstream for no visible difference, and every new boundary is another
 *  edge whose separator space has to be got right.
 *
 *  **Invariant:** each piece goes through `spacedText`, so the leading and
 *  trailing spaces a run drew survive. `assembleLines` drops whitespace at a
 *  line's edges, which is right for a whole element and wrong for a fragment of
 *  one — the `(the docs )` case. Splitting a run in three is three more chances
 *  to lose those spaces. */
function styledRuns(glyphs: GlyphEvent[], page: Page): StructTextNode[] {
  const out: StructTextNode[] = [];
  let start = 0;
  const emit = (from: number, to: number): void => {
    if (to <= from) return;
    const piece = glyphs.slice(from, to);
    const text = spacedText(piece);
    if (!text) return;
    const { bold, italic } = piece[0].font;
    out.push({
      kind: 'text', text, page,
      ...(bold ? { bold: true } : {}), ...(italic ? { italic: true } : {}),
    });
  };
  for (let i = 1; i <= glyphs.length; i++) {
    const prev = glyphs[i - 1].font;
    const next = glyphs[i]?.font;
    if (next && next.bold === prev.bold && next.italic === prev.italic) continue;
    emit(start, i);
    start = i;
  }
  return out;
}
```

- [ ] **Step 4: Route both producers through it**

In `Nodes` (around line 216), replace the `out.push({ kind: 'text', text: spacedText(...), page: it.page })` block with:

```ts
      out.push(...styledRuns(mcidGlyphs(this.doc, it.page).get(it.mcid) ?? [], it.page));
```

In `interleave` (around line 263), replace the `emit` closure:

```ts
    const emit = (glyphs: GlyphEvent[]): void => {
      out.push(...styledRuns(glyphs, page));
    };
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/struct-text-style.test.ts` — Expected: PASS
Run: `npm run typecheck && npm test` — Expected: green, especially `test/struct*.test.ts`, `test/docmodel.test.ts`, `test/html-identity.test.ts`

If a struct test asserts a node count, read it before changing it: a paragraph of one face must still yield exactly one node, and a changed count there means the split is firing where the style did not change.

- [ ] **Step 6: Commit**

```bash
git add src/struct.ts test/struct-text-style.test.ts
git commit -m "feat(struct): split an own-text run where the font's style changes"
```

---

### Task 4: `DocText` carries `bold`/`italic`

**Files:**
- Modify: `src/docmodel.ts` (`DocText` at line 34; the tagged text path in `itemBlocks`/`elementNode`; the untagged path around line 522)
- Test: `test/docmodel-style.test.ts` (new)

**Interfaces:**
- Consumes: `StructTextNode.bold`/`.italic` (Task 3), `TextFragment.bold`/`.italic` (Task 2).
- Produces: `DocText.bold?: boolean`, `DocText.italic?: boolean`.

The tagged builder currently joins several text nodes into one string (`texts.join('')`). It must instead emit one `DocText` per style run. The untagged builder reads `TextLine.fragments`, which now carry the flags.

- [ ] **Step 1: Write the failing test**

Create `test/docmodel-style.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocModel, type DocNode, type DocText } from '../src/docmodel.js';

function model(tagged: boolean): DocNode[] {
  const doc = Document.New();
  const flow = doc.NewFlow(tagged ? { tagged: true } : {});
  flow.AddMarkdown('Plain start **bold middle** plain end.');
  flow.Render();
  return buildDocModel(doc, doc.Pages);
}

function texts(nodes: DocNode[]): DocText[] {
  const out: DocText[] = [];
  const walk = (n: DocNode): void => {
    if (n.kind === 'text') out.push(n);
    else if (n.kind === 'container') n.children.forEach(walk);
    else if (n.kind === 'list') n.items.forEach((i) => i.blocks.forEach(walk));
    else if (n.kind === 'listItem') n.blocks.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

describe('DocText style', () => {
  for (const tagged of [true, false]) {
    it(`carries bold through the ${tagged ? 'tagged' : 'untagged'} builder`, () => {
      const bold = texts(model(tagged)).filter((t) => t.bold);
      expect(bold.length).toBe(1);
      expect(bold[0].text.trim()).toBe('bold middle');
    });

    it(`omits the flags for plain text (${tagged ? 'tagged' : 'untagged'})`, () => {
      const plain = texts(model(tagged)).find((t) => t.text.includes('Plain start'))!;
      expect(plain.bold).toBeUndefined();
      expect(plain.italic).toBeUndefined();
    });
  }

  // The whole point of the model extension is that it is invisible to the
  // serializers that do not read it.
  it('leaves the Markdown export byte-identical', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ tagged: true });
    flow.AddMarkdown('Plain start **bold middle** plain end.');
    flow.Render();
    expect(doc.ToMarkdown()).toBe('Plain start bold middle plain end.\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docmodel-style.test.ts`
Expected: FAIL — `.bold` is undefined on every node (and TypeScript rejects the property).

- [ ] **Step 3: Extend the interface**

In `src/docmodel.ts`, replace line 34:

```ts
/** A run of text, decoded and UNESCAPED — escaping is a serializer concern, and
 *  the serializers escape differently.
 *
 *  `bold`/`italic` are derived from the producing font (see `fontStyleOf`), not
 *  declared by the PDF: a PDF records a face, not an emphasis. Absent rather
 *  than false, and read by `docxflow.ts` alone — which is what keeps the HTML
 *  and Markdown exports byte-identical across their addition. */
export interface DocText { kind: 'text'; text: string; bold?: boolean; italic?: boolean }
```

- [ ] **Step 4: Emit one `DocText` per style run on both paths**

Add a helper near the top of the tagged section:

```ts
/** A text node for one style run; the flags are omitted when false. */
function docText(text: string, style: { bold?: boolean; italic?: boolean }): DocText {
  return {
    kind: 'text', text,
    ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}),
  };
}
```

Everywhere the tagged builder accumulates `texts: string[]` and flushes `texts.join('')` into a single `{ kind: 'text', text }`, accumulate `DocText[]` instead and push them all. Concretely, in `itemBlocks` the accumulator becomes `let texts: DocText[] = []` and `flush` becomes:

```ts
  const flush = (): void => {
    const runs = texts;
    texts = [];
    if (runs.some((r) => r.text)) out.push({ kind: 'container', type: 'P', children: runs });
  };
```

with the text branch pushing `docText(n.text, n)` instead of `texts.push(n.text)`. Apply the same change to the other own-text accumulators in `elementNode`. Adjacent runs sharing a style are **not** merged: `struct.ts` already emitted them as one run, so two adjacent nodes mean two marked-content sequences, and merging them would fold a `/Span` boundary away.

On the untagged path, a `TextLine`'s `fragments` already carry the flags. Where the builder emits a line's text as one `DocText`, emit one per fragment run instead, merging consecutive fragments with equal flags so a line in a single face still yields exactly one node — the untagged snapshots depend on that.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/docmodel-style.test.ts` — Expected: PASS
Run: `npm run typecheck && npm test` — Expected: green

`test/html-identity.test.ts` is the gate here. If it goes red, a line in one face is being split into several `DocText`s and `htmlsemantic.ts` is emitting them separately — fix the merge, not the snapshot.

- [ ] **Step 6: Commit**

```bash
git add src/docmodel.ts test/docmodel-style.test.ts
git commit -m "feat(docmodel): carry font-derived emphasis on a text run"
```

---

### Task 5: `DocFigure` carries the drawn size

**Files:**
- Modify: `src/docmodel.ts` (`DocFigure` at line 42; `pageMcidImages` around line 71; `figureStreams` around line 92; the untagged `page.Images` loop at line 533)
- Test: `test/docmodel-figure-size.test.ts` (new)

**Interfaces:**
- Consumes: `ImageEvent.quad` — the device-space box of the drawn unit square (`src/text.ts:241`).
- Produces: `DocFigure.sizes?: { width: number; height: number }[]`, parallel to `images`.

- [ ] **Step 1: Write the failing test**

Create `test/docmodel-figure-size.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildDocModel, type DocFigure, type DocNode } from '../src/docmodel.js';
import { PageFormat } from '../src/index.js';
import { buildPngRgb } from './helpers/build-embed-images.js';

/** A 2x1 PNG is enough: the assertion is about the DRAWN box, not the pixels —
 *  and its aspect ratio deliberately does not match either rect below, so a
 *  size taken from the pixels cannot accidentally agree. */
const PNG = buildPngRgb();

function figures(nodes: DocNode[]): DocFigure[] {
  const out: DocFigure[] = [];
  const walk = (n: DocNode): void => {
    if (n.kind === 'figure') out.push(n);
    else if (n.kind === 'container') n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

describe('DocFigure sizes', () => {
  it('records the size the image was drawn at, not its pixel count', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddImage(PNG, [10, 10, 180, 120]);      // Page.AddImage(data, [x, y, w, h])
    const fig = figures(buildDocModel(doc, doc.Pages))[0];
    expect(fig.sizes?.[0].width).toBeCloseTo(180, 1);
    expect(fig.sizes?.[0].height).toBeCloseTo(120, 1);
  });

  it('keeps sizes the same length as images', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    page.AddImage(PNG, [10, 10, 50, 50]);
    page.AddImage(PNG, [100, 10, 60, 30]);
    const fig = figures(buildDocModel(doc, doc.Pages));
    for (const f of fig) expect(f.sizes?.length).toBe(f.images.length);
  });
});
```

Note `page.AddImage` embeds ONE XObject per distinct payload, so the second test
may yield one figure drawn twice rather than two figures — assert what the model
actually produces after seeing it, but keep the `sizes.length === images.length`
invariant as the assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docmodel-figure-size.test.ts`
Expected: FAIL — `sizes` is undefined.

- [ ] **Step 3: Extend the interface**

```ts
export interface DocFigure {
  kind: 'figure'; alt: string; images: PdfStream[];
  /** Each image's DRAWN size in points, parallel to `images`.
   *
   *  **Invariant:** same length as `images` whenever present, and an entry whose
   *  size could not be determined is `{ width: 0, height: 0 }` rather than
   *  omitted — omitting it shifts every later index and silently mis-sizes the
   *  rest of a composite figure.
   *
   *  **Invariant:** the DRAWN size, not the pixel count. A producer that placed
   *  a 2400px scan two inches wide said what it meant; reading the pixels as
   *  96 DPI arrives at 25 inches. */
  sizes?: { width: number; height: number }[];
  tagged: boolean;
}
```

- [ ] **Step 4: Record the size alongside the stream**

Change `pageMcidImages`'s memo from `Map<number, PdfStream[]>` to `Map<number, PlacedImage[]>` with:

```ts
interface PlacedImage { stream: PdfStream; width: number; height: number }
```

filling it in the existing `visitContent` image callback from `e.quad`:

```ts
      const list = map!.get(e.mcid);
      const placed: PlacedImage = {
        stream: e.stream,
        width: Math.abs(e.quad[2] - e.quad[0]),
        height: Math.abs(e.quad[3] - e.quad[1]),
      };
      if (list) list.push(placed); else map!.set(e.mcid, [placed]);
```

`figureStreams` collects `PlacedImage[]`, and the `Figure` branch builds both arrays from it.

The untagged path at line 533 iterates `page.Images`, which is **resource order and carries no geometry**. Build a one-pass lookup for the page and consult it:

```ts
    // page.Images is resource order and says nothing about placement, so the
    // drawn box comes from a content walk keyed by the stream object.
    const drawn = new Map<PdfStream, { width: number; height: number }>();
    visitContent(doc, page, {
      image: (e) => {
        if (!e.stream || drawn.has(e.stream)) return;
        drawn.set(e.stream, {
          width: Math.abs(e.quad[2] - e.quad[0]),
          height: Math.abs(e.quad[3] - e.quad[1]),
        });
      },
    });
    for (const img of page.Images) {
      const size = drawn.get(img.Stream) ?? { width: 0, height: 0 };
      out.push({ kind: 'figure', alt: '', images: [img.Stream], sizes: [size], tagged: false });
    }
```

An image in the resources that the page never draws keeps `{ 0, 0 }` — that is the honest answer, and Task 9 falls back to pixels for it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/docmodel-figure-size.test.ts` — Expected: PASS
Run: `npm run typecheck && npm test` — Expected: green, including `test/html-identity.test.ts` and `test/docmodel.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/docmodel.ts test/docmodel-figure-size.test.ts
git commit -m "feat(docmodel): carry each figure image's drawn size"
```

---

### Task 6: `docxstyles.ts` — styles and numbering

**Files:**
- Create: `src/docxstyles.ts`
- Test: `test/docx-styles.test.ts` (new)

**Interfaces:**
- Consumes: `escapeXml` from `./xml.js`.
- Produces:
  ```ts
  export const STYLE: {
    normal: 'Normal'; quote: 'Quote'; code: 'SourceCode';
    listParagraph: 'ListParagraph'; hyperlink: 'Hyperlink';
    heading(level: number): string;      // 'Heading1' .. 'Heading6'
  };
  export interface DocxNumbering { numId: number; ordered: boolean; start?: number }
  export function docxStylesXml(): string;
  export function docxNumberingXml(nums: DocxNumbering[]): string;
  export const BULLETS: readonly string[];   // '•', '◦', '▪'
  export const EMU_PER_PT = 12700;
  export const TWIPS_PER_PT = 20;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/docx-styles.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docxStylesXml, docxNumberingXml, STYLE, BULLETS } from '../src/docxstyles.js';
import { parseXml } from '../src/xml.js';

const parse = (s: string) => parseXml(new TextEncoder().encode(s));

describe('docxStylesXml', () => {
  it('parses as XML', () => {
    expect(() => parse(docxStylesXml())).not.toThrow();
  });

  // The mapper cannot name a style this module does not define: a w:pStyle
  // pointing at an undefined style is not an error any reader reports -- Word
  // falls back to body text, so a document of headings arrives looking like one
  // long paragraph and nothing anywhere says why.
  it('defines every style the mapper can name', () => {
    const xml = docxStylesXml();
    for (let n = 1; n <= 6; n++) expect(xml).toContain(`w:styleId="${STYLE.heading(n)}"`);
    for (const id of [STYLE.normal, STYLE.quote, STYLE.code, STYLE.listParagraph, STYLE.hyperlink])
      expect(xml).toContain(`w:styleId="${id}"`);
  });

  it('gives the hyperlink style character type', () => {
    expect(docxStylesXml()).toContain(`<w:style w:type="character" w:styleId="${STYLE.hyperlink}"`);
  });
});

describe('docxNumberingXml', () => {
  it('emits one w:num per list, each with its own abstract definition kind', () => {
    const xml = docxNumberingXml([
      { numId: 1, ordered: false },
      { numId: 2, ordered: true, start: 5 },
    ]);
    expect(() => parse(xml)).not.toThrow();
    expect(xml).toContain('<w:num w:numId="1">');
    expect(xml).toContain('<w:num w:numId="2">');
  });

  // On the w:num, never on the abstract definition: the abstract one is shared,
  // so a start override there moves every list that uses it.
  it('puts a start override on the num, not the abstract definition', () => {
    const xml = docxNumberingXml([{ numId: 2, ordered: true, start: 5 }]);
    const num = xml.slice(xml.indexOf('<w:num w:numId="2">'));
    expect(num).toContain('<w:startOverride w:val="5"/>');
    expect(xml.slice(0, xml.indexOf('<w:num '))).not.toContain('startOverride');
  });

  it('omits the override when a list starts at one', () => {
    expect(docxNumberingXml([{ numId: 1, ordered: true }])).not.toContain('startOverride');
  });

  // The private use area is a Windows-font dependency: where Symbol is missing,
  // so is the glyph.
  it('uses real bullet characters, not Symbol private use', () => {
    const xml = docxNumberingXml([{ numId: 1, ordered: false }]);
    expect(xml).toContain(BULLETS[0]);
    expect(xml).not.toContain('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-styles.test.ts`
Expected: FAIL — cannot resolve `../src/docxstyles.js`.

- [ ] **Step 3: Implement `src/docxstyles.ts`**

```ts
import { escapeXml } from './xml.js';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Points to English Metric Units and to twips.
 *
 *  Here rather than in `docxflow.ts` because `docxtable.ts` needs them too and
 *  `docxflow.ts` imports `docxtable.ts` — defining them there and importing
 *  back would close a cycle. This module imports neither. */
export const EMU_PER_PT = 12700;
export const TWIPS_PER_PT = 20;

/** The style ids the mapper may name.
 *
 *  **Invariant:** the mapper cannot name a style this module does not define,
 *  so the ids live here and the two are one decision. A `w:pStyle` pointing at
 *  an undefined style is not an error a reader reports — Word falls back to
 *  body text, so a document of headings arrives looking like one long paragraph
 *  and nothing says why. */
export const STYLE = {
  normal: 'Normal',
  quote: 'Quote',
  code: 'SourceCode',
  listParagraph: 'ListParagraph',
  hyperlink: 'Hyperlink',
  heading: (level: number): string => `Heading${Math.min(6, Math.max(1, level))}`,
} as const;

/** One list the body emitted: its id, its kind, and its first ordinal. */
export interface DocxNumbering { numId: number; ordered: boolean; start?: number }

/** **Invariant:** real bullet characters in the document font, not Word's
 *  conventional U+F0B7 in Symbol. That codepoint is private use and means a
 *  bullet only in a font present on Windows and frequently not elsewhere. */
export const BULLETS = ['•', '◦', '▪'] as const;

const HEADING_PT = [16, 14, 13, 12, 11, 10];

function headingStyle(level: number): string {
  const half = HEADING_PT[level - 1] * 2;     // w:sz is half-points
  return `<w:style w:type="paragraph" w:styleId="${STYLE.heading(level)}">`
    + `<w:name w:val="heading ${level}"/><w:basedOn w:val="${STYLE.normal}"/>`
    + `<w:pPr><w:keepNext/><w:outlineLvl w:val="${level - 1}"/>`
    + `<w:spacing w:before="240" w:after="120"/></w:pPr>`
    + `<w:rPr><w:b/><w:sz w:val="${half}"/></w:rPr></w:style>`;
}

export function docxStylesXml(): string {
  const styles = [
    '<w:docDefaults><w:rPrDefault><w:rPr>'
      + '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/>'
      + '</w:rPr></w:rPrDefault></w:docDefaults>',
    `<w:style w:type="paragraph" w:default="1" w:styleId="${STYLE.normal}">`
      + '<w:name w:val="Normal"/></w:style>',
    ...[1, 2, 3, 4, 5, 6].map(headingStyle),
    `<w:style w:type="paragraph" w:styleId="${STYLE.quote}">`
      + `<w:name w:val="Quote"/><w:basedOn w:val="${STYLE.normal}"/>`
      + '<w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>',
    `<w:style w:type="paragraph" w:styleId="${STYLE.code}">`
      + `<w:name w:val="Source Code"/><w:basedOn w:val="${STYLE.normal}"/>`
      + '<w:pPr><w:spacing w:after="0"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr></w:style>',
    `<w:style w:type="paragraph" w:styleId="${STYLE.listParagraph}">`
      + `<w:name w:val="List Paragraph"/><w:basedOn w:val="${STYLE.normal}"/>`
      + '<w:pPr><w:contextualSpacing/></w:pPr></w:style>',
    `<w:style w:type="character" w:styleId="${STYLE.hyperlink}">`
      + '<w:name w:val="Hyperlink"/>'
      + '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>',
  ].join('');
  return `${DECL}<w:styles xmlns:w="${W_NS}">${styles}</w:styles>\n`;
}

/** Nine levels of one list kind. */
function abstractNum(id: number, ordered: boolean): string {
  const levels = Array.from({ length: 9 }, (_, i) => {
    const fmt = ordered ? 'decimal' : 'bullet';
    const text = ordered ? `%${i + 1}.` : BULLETS[i % BULLETS.length];
    const indent = 720 * (i + 1);
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/>`
      + `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${escapeXml(text)}"/>`
      + '<w:lvlJc w:val="left"/>'
      + `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
  }).join('');
  return `<w:abstractNum w:abstractNumId="${id}">`
    + '<w:multiLevelType w:val="hybridMultilevel"/>' + levels + '</w:abstractNum>';
}

/** **Invariant:** `w:startOverride` goes on the `w:num`, never on the abstract
 *  definition. The abstract one is shared by every list of its kind, so an
 *  override there renumbers all of them. */
export function docxNumberingXml(nums: DocxNumbering[]): string {
  const body = abstractNum(0, false) + abstractNum(1, true)
    + nums.map((n) => {
      const override = n.ordered && n.start !== undefined && n.start !== 1
        ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride>`
        : '';
      return `<w:num w:numId="${n.numId}">`
        + `<w:abstractNumId w:val="${n.ordered ? 1 : 0}"/>${override}</w:num>`;
    }).join('');
  return `${DECL}<w:numbering xmlns:w="${W_NS}">${body}</w:numbering>\n`;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/docx-styles.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/docxstyles.ts test/docx-styles.test.ts
git commit -m "feat(docx): the style and numbering vocabulary the mapper names"
```

---

### Task 7: `docxflow.ts` — runs, paragraphs, headings, quotes, code

**Files:**
- Create: `src/docxflow.ts`
- Test: `test/docx-flow.test.ts` (new)

**Interfaces:**
- Consumes: `DocNode`/`DocText` (Task 4), `STYLE` (Task 6), `escapeXml` from `./xml.js`.
- Produces:
  ```ts
  export interface RunFmt { bold?: boolean; italic?: boolean; style?: string }
  export interface ParaProps { style?: string; numId?: number; ilvl?: number; indent?: number }
  export function sanitizeXml(s: string): string;
  export function runXml(text: string, fmt?: RunFmt): string;
  export function paragraphXml(runs: string, props?: ParaProps): string;
  export function docxBody(nodes: DocNode[], images: DocxImageSink, links: DocxLinkSink):
    { xml: string; nums: DocxNumbering[] };
  ```
  Tasks 8 and 9 add the list and link/figure branches to `docxBody`; this task establishes it with those branches falling through to the transparent case.

- [ ] **Step 1: Write the failing test**

Create `test/docx-flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docxBody, sanitizeXml, runXml, paragraphXml } from '../src/docxflow.js';
import { STYLE } from '../src/docxstyles.js';
import type { DocNode } from '../src/docmodel.js';
import { parseXml } from '../src/xml.js';

const noImages = { add: () => undefined };
const noLinks = { add: () => 'rIdX' };
const body = (nodes: DocNode[]) => docxBody(nodes, noImages, noLinks).xml;
const para = (type: string, text: string): DocNode =>
  ({ kind: 'container', type, children: [{ kind: 'text', text }] });

/** Body XML is a fragment; wrap it so the XML parser has a single root. */
const parses = (xml: string) =>
  expect(() => parseXml(new TextEncoder().encode(
    `<w:body xmlns:w="http://x">${xml}</w:body>`))).not.toThrow();

describe('runXml', () => {
  // Without xml:space, Word collapses the trailing space a /Link's own run drew
  // -- rejoining the words either side into `Seethe docshere.`, the exact defect
  // spacedText exists to prevent, reintroduced one layer down.
  it('preserves space on every w:t', () => {
    expect(runXml('the docs ')).toContain('<w:t xml:space="preserve">the docs </w:t>');
  });

  it('emits b and i from the run format', () => {
    expect(runXml('x', { bold: true, italic: true }))
      .toContain('<w:rPr><w:b/><w:i/></w:rPr>');
  });

  it('escapes XML metacharacters', () => {
    expect(runXml('a & b < c')).toContain('a &amp; b &lt; c');
  });

  // A raw newline in w:t is legal XML and renders as a space, silently joining
  // lines the document showed separately.
  it('turns a newline into w:br', () => {
    const xml = runXml('one\ntwo');
    expect(xml).toContain('<w:br/>');
    expect(xml).not.toContain('one\ntwo');
  });
});

describe('sanitizeXml', () => {
  // One control byte does not corrupt a paragraph -- it makes document.xml
  // unparseable, so Word rejects the whole file with no clue where the fault is.
  it('drops characters XML 1.0 forbids', () => {
    expect(sanitizeXml('a bc')).toBe('abc');
  });

  it('keeps tab and newline', () => {
    expect(sanitizeXml('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('docxBody blocks', () => {
  it('maps H1..H6 onto the heading styles', () => {
    for (let n = 1; n <= 6; n++)
      expect(body([para(`H${n}`, 'x')])).toContain(`<w:pStyle w:val="${STYLE.heading(n)}"/>`);
  });

  it('maps P onto a bare paragraph', () => {
    const xml = body([para('P', 'hello')]);
    expect(xml).toContain('<w:t xml:space="preserve">hello</w:t>');
    expect(xml).not.toContain('w:pStyle');
    parses(xml);
  });

  it('maps BlockQuote onto the quote style', () => {
    expect(body([{ kind: 'container', type: 'BlockQuote', children: [para('P', 'q')] }]))
      .toContain(`<w:pStyle w:val="${STYLE.quote}"/>`);
  });

  // One paragraph per source line, so indentation and line structure survive.
  it('maps a code block to one styled paragraph per line', () => {
    const xml = body([{ kind: 'code', text: 'line one\n    line two' }]);
    expect(xml.match(new RegExp(`w:val="${STYLE.code}"`, 'g'))?.length).toBe(2);
    expect(xml).toContain('<w:t xml:space="preserve">    line two</w:t>');
  });

  it('carries a run\'s emphasis through', () => {
    const xml = body([{ kind: 'container', type: 'P', children: [
      { kind: 'text', text: 'plain ' }, { kind: 'text', text: 'bold', bold: true },
    ] }]);
    expect(xml).toContain('<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold</w:t>');
  });

  // Everything in a tagged tree hangs under a Document wrapper, so dropping
  // unknown types empties the output entirely.
  it('is transparent to an unknown container type', () => {
    expect(body([{ kind: 'container', type: 'Whatever', children: [para('H2', 'kept')] }]))
      .toContain(`<w:pStyle w:val="${STYLE.heading(2)}"/>`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-flow.test.ts`
Expected: FAIL — cannot resolve `../src/docxflow.js`.

- [ ] **Step 3: Implement `src/docxflow.ts`**

```ts
import { escapeXml } from './xml.js';
import type { DocNode, DocText } from './docmodel.js';
import type { PdfStream } from './types.js';
import { EMU_PER_PT, STYLE, type DocxNumbering } from './docxstyles.js';

/** An image registered with the package: its relationship id and, as a size of
 *  last resort, the encoded picture's own pixel dimensions. */
export interface DocxImage { rid: string; pxWidth: number; pxHeight: number }
export interface DocxImageSink { add(stream: PdfStream): DocxImage | undefined }
export interface DocxLinkSink { add(href: string): string }

export interface RunFmt { bold?: boolean; italic?: boolean; style?: string }
export interface ParaProps { style?: string; numId?: number; ilvl?: number; indent?: number }

/** Drop the characters XML 1.0 forbids, keeping tab, newline and return.
 *
 *  **Invariant:** this runs before escaping and on every string that reaches a
 *  `w:t`. `escapeXml` handles `& < > "` and nothing else, and extracted PDF text
 *  can carry a NUL or a C0 control. One such byte does not corrupt a paragraph —
 *  it makes `document.xml` unparseable, so Word rejects the entire file with no
 *  indication of where the fault is. */
export function sanitizeXml(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const ok = c === 0x09 || c === 0x0a || c === 0x0d
      || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd)
      || (c >= 0x10000 && c <= 0x10ffff);
    if (ok) out += ch;
  }
  return out;
}

/** Text as `w:t` segments, line breaks as `w:br`.
 *
 *  **Invariant:** every `w:t` carries `xml:space="preserve"`. A `/Link` draws
 *  `(the docs )` inside its own marked content, and without it Word collapses
 *  that trailing space, rejoining the words either side.
 *
 *  **Invariant:** a newline becomes `<w:br/>`, matching what `Table.toHtml`
 *  already does with `<br>`. A raw newline in `w:t` is legal XML and renders as
 *  a space, silently joining lines the document showed separately. */
function textXml(text: string): string {
  return sanitizeXml(text).split('\n')
    .map((line) => `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`)
    .join('<w:br/>');
}

export function runXml(text: string, fmt: RunFmt = {}): string {
  const props = (fmt.style ? `<w:rStyle w:val="${fmt.style}"/>` : '')
    + (fmt.bold ? '<w:b/>' : '') + (fmt.italic ? '<w:i/>' : '');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${textXml(text)}</w:r>`;
}

export function paragraphXml(runs: string, props: ParaProps = {}): string {
  const numPr = props.numId !== undefined
    ? `<w:numPr><w:ilvl w:val="${props.ilvl ?? 0}"/><w:numId w:val="${props.numId}"/></w:numPr>`
    : '';
  const ind = props.indent ? `<w:ind w:left="${Math.round(props.indent)}"/>` : '';
  const pPr = (props.style ? `<w:pStyle w:val="${props.style}"/>` : '') + numPr + ind;
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Heading level, or 0 for anything else. Mirrors mdexport.ts. */
function headingLevel(type: string): number {
  const m = /^H([1-6])$/.exec(type);
  return m ? Number(m[1]) : 0;
}

/** Walk state: the sinks, and the numbering the walk has allocated so far. */
interface Ctx {
  images: DocxImageSink;
  links: DocxLinkSink;
  nums: DocxNumbering[];
}

/** Every text run under a node, flattened — the inline projection.
 *  Tasks 8 and 9 extend this for links. */
function inlineRuns(node: DocNode, fmt: RunFmt, ctx: Ctx): string {
  if (node.kind === 'text') {
    const t = node as DocText;
    return runXml(t.text, { ...fmt, ...(t.bold ? { bold: true } : {}), ...(t.italic ? { italic: true } : {}) });
  }
  if (node.kind === 'container') return node.children.map((c) => inlineRuns(c, fmt, ctx)).join('');
  return '';
}

/** Append `node`'s block XML to `out`. */
function nodeBlocks(node: DocNode, ctx: Ctx, out: string[], props: ParaProps = {}): void {
  if (node.kind === 'text') {
    if (node.text) out.push(paragraphXml(inlineRuns(node, {}, ctx), props));
    return;
  }
  if (node.kind === 'code') {
    // One paragraph per line: indentation and line structure both survive, and
    // a code block is not one paragraph with soft breaks in Word's model.
    for (const line of node.text.split('\n'))
      out.push(paragraphXml(runXml(line), { ...props, style: STYLE.code }));
    return;
  }
  if (node.kind === 'container') {
    if (node.type === 'BlockQuote') {
      const inner: string[] = [];
      for (const c of node.children) nodeBlocks(c, ctx, inner, { ...props, style: STYLE.quote });
      out.push(...inner);
      return;
    }
    const level = headingLevel(node.type);
    if (level) {
      out.push(paragraphXml(inlineRuns(node, {}, ctx), { ...props, style: STYLE.heading(level) }));
      return;
    }
    if (node.type === 'P' || node.type === 'Span' || node.type === 'Link' || node.type === 'Code') {
      const runs = inlineRuns(node, {}, ctx);
      if (runs) out.push(paragraphXml(runs, props));
      return;
    }
    // Transparent: an unknown type emits its children as sibling blocks rather
    // than vanishing. Everything in a tagged tree hangs under a Document
    // wrapper, so dropping unknown types empties the output entirely.
    for (const c of node.children) nodeBlocks(c, ctx, out, props);
    return;
  }
  // 'list', 'listItem', 'table' and 'figure' arrive in Tasks 8-10.
}

/** Map a document tree to the inner XML of `<w:body>`.
 *
 *  **Invariant:** the mapper REPORTS the lists it emitted rather than a flag
 *  saying that it did. `numbering.xml` needs one `w:num` per list with that
 *  list's kind and start override, and the mapper is the only thing that knows
 *  how many ids it allocated and what each meant. */
export function docxBody(
  nodes: DocNode[], images: DocxImageSink, links: DocxLinkSink,
): { xml: string; nums: DocxNumbering[] } {
  const ctx: Ctx = { images, links, nums: [] };
  const out: string[] = [];
  for (const n of nodes) nodeBlocks(n, ctx, out);
  return { xml: out.join(''), nums: ctx.nums };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/docx-flow.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/docxflow.ts test/docx-flow.test.ts
git commit -m "feat(docx): map paragraphs, headings, quotes and code to WordprocessingML"
```

---

### Task 8: `docxflow.ts` — lists

**Files:**
- Modify: `src/docxflow.ts`
- Test: `test/docx-flow-lists.test.ts` (new)

**Interfaces:**
- Consumes: `DocList`/`DocListItem` (`src/docmodel.ts:47-49`), `DocxNumbering`/`BULLETS` (Task 6), `nodeBlocks`/`paragraphXml` (Task 7).
- Produces: the `'list'` and `'listItem'` branches of `nodeBlocks`, and populated `nums`.

- [ ] **Step 1: Write the failing test**

Create `test/docx-flow-lists.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docxBody } from '../src/docxflow.js';
import type { DocNode } from '../src/docmodel.js';

const noImages = { add: () => undefined };
const noLinks = { add: () => 'rIdX' };
const run = (nodes: DocNode[]) => docxBody(nodes, noImages, noLinks);

const item = (text: string, checked?: boolean): DocNode =>
  ({ kind: 'listItem', blocks: [{ kind: 'container', type: 'P',
    children: [{ kind: 'text', text }] }], ...(checked !== undefined ? { checked } : {}) });

const list = (ordered: boolean, items: DocNode[], start?: number): DocNode =>
  ({ kind: 'list', ordered, items: items as never, ...(start !== undefined ? { start } : {}) });

describe('docxBody lists', () => {
  it('gives each item a numPr referencing the list\'s numId', () => {
    const { xml, nums } = run([list(false, [item('one'), item('two')])]);
    expect(nums).toEqual([{ numId: 1, ordered: false }]);
    expect(xml.match(/<w:numId w:val="1"\/>/g)?.length).toBe(2);
  });

  // Two sibling lists must not continue each other's numbering.
  it('allocates a numId per list', () => {
    const { nums } = run([list(true, [item('a')]), list(true, [item('b')])]);
    expect(nums.map((n) => n.numId)).toEqual([1, 2]);
  });

  it('reports an ordered list\'s start', () => {
    expect(run([list(true, [item('a')], 5)]).nums[0]).toEqual({ numId: 1, ordered: true, start: 5 });
  });

  it('raises ilvl for a nested list', () => {
    const nested: DocNode = { kind: 'listItem', blocks: [
      { kind: 'container', type: 'P', children: [{ kind: 'text', text: 'outer' }] },
      list(false, [item('inner')]),
    ] } as DocNode;
    const { xml } = run([list(false, [nested])]);
    expect(xml).toContain('<w:ilvl w:val="0"/>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
  });

  // A task's state is CONTENT, not a marker the serializer re-derives -- the
  // one place the marker-suppression rule does not apply, exactly as the HTML
  // export emits a disabled checkbox.
  it('writes a task item\'s state as a literal box', () => {
    const { xml } = run([list(false, [item('done', true), item('todo', false)])]);
    expect(xml).toContain('☒ done');
    expect(xml).toContain('☐ todo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-flow-lists.test.ts`
Expected: FAIL — lists produce no output at all.

- [ ] **Step 3: Implement the list branches**

Add to `Ctx` a nesting depth, and to `nodeBlocks` these branches before the trailing comment:

```ts
  if (node.kind === 'list') {
    // One numId per list: two sibling lists must not continue each other's
    // numbering, which sharing an id would make them do.
    const numId = ctx.nums.length + 1;
    ctx.nums.push({
      numId, ordered: node.ordered,
      ...(node.start !== undefined ? { start: node.start } : {}),
    });
    for (const it of node.items) listItemBlocks(it, ctx, out, props, numId, ctx.depth);
    return;
  }
  if (node.kind === 'listItem') {
    listItemBlocks(node, ctx, out, props, undefined, ctx.depth);
    return;
  }
```

and the helper:

```ts
/** One item: its first block carries the marker, its remaining blocks are
 *  indented siblings, and a nested list raises the level.
 *
 *  **Invariant:** a task's checked state is CONTENT, emitted as a literal ☐/☒
 *  at the head of the first paragraph. It is the one place the
 *  marker-suppression rule does not apply — the state is what the document
 *  says, not decoration re-derived by the serializer, exactly as
 *  htmlsemantic.ts emits a disabled checkbox. */
function listItemBlocks(
  item: DocListItem, ctx: Ctx, out: string[], props: ParaProps,
  numId: number | undefined, depth: number,
): void {
  const box = item.checked === undefined ? '' : item.checked ? '☒ ' : '☐ ';
  let first = true;
  for (const b of item.blocks) {
    if (b.kind === 'list') {
      ctx.depth = depth + 1;
      nodeBlocks(b, ctx, out, props);
      ctx.depth = depth;
      continue;
    }
    const marker: ParaProps = first && numId !== undefined
      ? { ...props, style: STYLE.listParagraph, numId, ilvl: depth }
      : { ...props, style: STYLE.listParagraph, indent: 720 * (depth + 1) };
    if (first && box && b.kind === 'container') {
      out.push(paragraphXml(runXml(box) + inlineRuns(b, {}, ctx), marker));
    } else {
      nodeBlocks(b, ctx, out, marker);
    }
    first = false;
  }
}
```

Initialize `depth: 0` in `docxBody`'s `Ctx` and add `depth: number` to the interface. Import `DocListItem` from `./docmodel.js`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/docx-flow-lists.test.ts test/docx-flow.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/docxflow.ts test/docx-flow-lists.test.ts
git commit -m "feat(docx): map lists, nesting and task state onto w:numPr"
```

---

### Task 9: `docxflow.ts` — hyperlinks and figures

**Files:**
- Modify: `src/docxflow.ts`
- Test: `test/docx-flow-media.test.ts` (new)

**Interfaces:**
- Consumes: `DocContainer.href` (`src/docmodel.ts:30`), `DocFigure.sizes` (Task 5), `DocxImageSink`/`DocxLinkSink`/`EMU_PER_PT` (Task 7), `STYLE.hyperlink` (Task 6).
- Produces: the `Link` and `'figure'` branches.

- [ ] **Step 1: Write the failing test**

Create `test/docx-flow-media.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docxBody } from '../src/docxflow.js';
import { STYLE } from '../src/docxstyles.js';
import type { DocNode } from '../src/docmodel.js';
import type { PdfStream } from '../src/types.js';

const stream = (n: number) => ({ dict: new Map([['N', n]]), raw: new Uint8Array() }) as unknown as PdfStream;
const imageSink = () => {
  const seen: PdfStream[] = [];
  return {
    seen,
    add(s: PdfStream) { seen.push(s); return { rid: `rIdImg${seen.length}`, pxWidth: 100, pxHeight: 50 }; },
  };
};
const linkSink = () => {
  const seen: string[] = [];
  return { seen, add(h: string) { seen.push(h); return `rIdLnk${seen.length}`; } };
};

describe('docxBody hyperlinks', () => {
  it('wraps a link\'s runs in w:hyperlink with the hyperlink style', () => {
    const links = linkSink();
    const { xml } = docxBody([{ kind: 'container', type: 'P', children: [
      { kind: 'text', text: 'See ' },
      { kind: 'container', type: 'Link', href: 'https://example.com',
        children: [{ kind: 'text', text: 'the docs' }] },
    ] }], { add: () => undefined }, links);
    expect(links.seen).toEqual(['https://example.com']);
    expect(xml).toContain('<w:hyperlink r:id="rIdLnk1">');
    expect(xml).toContain(`<w:rStyle w:val="${STYLE.hyperlink}"/>`);
  });

  // An internal GoTo names a page object that will not exist once the PDF is
  // gone, so it degrades to the words it was on.
  it('emits a destination-less link as plain runs', () => {
    const links = linkSink();
    const { xml } = docxBody([{ kind: 'container', type: 'P', children: [
      { kind: 'container', type: 'Link', children: [{ kind: 'text', text: 'chapter two' }] },
    ] }], { add: () => undefined }, links);
    expect(links.seen).toEqual([]);
    expect(xml).not.toContain('w:hyperlink');
    expect(xml).toContain('chapter two');
  });
});

describe('docxBody figures', () => {
  const fig = (sizes?: { width: number; height: number }[]): DocNode =>
    ({ kind: 'figure', alt: 'a chart', images: [stream(1)], tagged: true, ...(sizes ? { sizes } : {}) });

  it('sizes the drawing from the drawn box in EMU', () => {
    const { xml } = docxBody([fig([{ width: 180, height: 120 }])], imageSink(), linkSink());
    expect(xml).toContain('cx="2286000"');   // 180 * 12700
    expect(xml).toContain('cy="1524000"');   // 120 * 12700
  });

  it('falls back to pixels at 96 DPI when the drawn size is unknown', () => {
    const { xml } = docxBody([fig([{ width: 0, height: 0 }])], imageSink(), linkSink());
    expect(xml).toContain('cx="952500"');    // 100px * 0.75pt * 12700
  });

  it('puts the alt text on docPr', () => {
    expect(docxBody([fig([{ width: 10, height: 10 }])], imageSink(), linkSink()).xml)
      .toContain('descr="a chart"');
  });

  // Word tolerates a duplicate id in some builds and calls the file corrupt in
  // others, which makes it look like a reader-dependent defect.
  it('gives every drawing a unique non-zero docPr id', () => {
    const { xml } = docxBody(
      [fig([{ width: 10, height: 10 }]), fig([{ width: 10, height: 10 }])],
      imageSink(), linkSink());
    const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('0');
  });

  // A tagged /Figure still has accessible content to announce; an untagged page
  // image has none, so it leaves nothing behind.
  it('keeps a tagged figure\'s alt when the image will not encode', () => {
    const dead = { add: () => undefined };
    expect(docxBody([fig()], dead, linkSink()).xml).toContain('a chart');
    expect(docxBody([{ kind: 'figure', alt: '', images: [stream(2)], tagged: false }],
      dead, linkSink()).xml).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-flow-media.test.ts`
Expected: FAIL — no `w:hyperlink`, no `w:drawing`.

- [ ] **Step 3: Implement the link branch**

In `inlineRuns`, before the generic container recursion:

```ts
  if (node.kind === 'container') {
    const inner = node.children.map((c) => inlineRuns(c, fmt, ctx)).join('');
    // Only a URI destination becomes a hyperlink. A GoTo names a page object
    // that will not exist once the PDF is gone, so it degrades to its words.
    if (node.type === 'Link' && node.href && inner) {
      const rid = ctx.links.add(node.href);
      const styled = node.children
        .map((c) => inlineRuns(c, { ...fmt, style: STYLE.hyperlink }, ctx)).join('');
      return `<w:hyperlink r:id="${escapeXml(rid)}">${styled}</w:hyperlink>`;
    }
    return inner;
  }
```

- [ ] **Step 4: Implement the figure branch**

Add to `nodeBlocks`:

```ts
  if (node.kind === 'figure') {
    const drawings: string[] = [];
    node.images.forEach((s, i) => {
      const img = ctx.images.add(s);
      if (!img) return;
      const drawn = node.sizes?.[i];
      // The drawn size is what the producer meant. Pixels at 96 DPI are the
      // fallback for an image the page never actually drew.
      const wPt = drawn && drawn.width > 0 ? drawn.width : img.pxWidth * 0.75;
      const hPt = drawn && drawn.height > 0 ? drawn.height : img.pxHeight * 0.75;
      // A figure is described once: repeating /Alt on each part would have a
      // screen reader announce the same description N times.
      drawings.push(drawingXml(img.rid, wPt, hPt, i === 0 ? node.alt : '', ++ctx.drawingId));
    });
    if (drawings.length) {
      for (const d of drawings) out.push(paragraphXml(`<w:r>${d}</w:r>`, props));
    } else if (node.tagged && node.alt) {
      out.push(paragraphXml(runXml(node.alt), props));
    }
    return;
  }
```

with `drawingId: number` on `Ctx` (initialized `0`) and:

```ts
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006';

/** One inline picture.
 *
 *  **Invariant:** `wp:docPr@id` is unique across the document and non-zero.
 *  Word tolerates a duplicate in some builds and reports the file as corrupt in
 *  others, which makes it look like a defect that depends on the reader. */
function drawingXml(rid: string, wPt: number, hPt: number, alt: string, id: number): string {
  const cx = Math.max(1, Math.round(wPt * EMU_PER_PT));
  const cy = Math.max(1, Math.round(hPt * EMU_PER_PT));
  const descr = alt ? ` descr="${escapeXml(alt)}"` : '';
  return '<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${id}" name="Picture ${id}"${descr}/>`
    + `<a:graphic xmlns:a="${DRAWING_NS}/main">`
    + `<a:graphicData uri="${DRAWING_NS}/picture">`
    + `<pic:pic xmlns:pic="${DRAWING_NS}/picture">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"${descr}/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${escapeXml(rid)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/docx-flow-media.test.ts test/docx-flow.test.ts test/docx-flow-lists.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/docxflow.ts test/docx-flow-media.test.ts
git commit -m "feat(docx): map hyperlinks and inline pictures"
```

---

### Task 10: `docxtable.ts`

**Files:**
- Create: `src/docxtable.ts`
- Modify: `src/docxflow.ts` (the `'table'` branch)
- Test: `test/docx-table.test.ts` (new)

**Interfaces:**
- Consumes: `Table`/`TableRow`/`TableCell` from `./tablemodel.js` (`cell.quad` is `[x0,y0,x1,y1]` in the table's upright frame), `TWIPS_PER_PT`/`paragraphXml` (Task 7).
- Produces:
  ```ts
  export interface DocxTableCtx { paragraph(text: string): string }
  export function docxTable(table: Table, ctx: DocxTableCtx): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/docx-table.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docxTable } from '../src/docxtable.js';
import { Table, type TableCell, type TableRow } from '../src/tablemodel.js';
import { parseXml } from '../src/xml.js';

const ctx = { paragraph: (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>` };

const cell = (row: number, col: number, text: string, over: Partial<TableCell> = {}): TableCell =>
  ({ row, col, rowSpan: 1, colSpan: 1, quad: [col * 100, 0, (col + 1) * 100, 20], text, ...over });

const table = (rows: TableRow[], cols: number) =>
  new Table([0, 0, cols * 100, rows.length * 20], rows.length, cols, rows);

const row = (cells: TableCell[]): TableRow => ({ cells, quad: [0, 0, 200, 20] });

const parses = (xml: string) =>
  expect(() => parseXml(new TextEncoder().encode(
    `<w:body xmlns:w="http://x">${xml}</w:body>`))).not.toThrow();

describe('docxTable', () => {
  it('emits a grid column per column, in twips', () => {
    const xml = docxTable(table([row([cell(0, 0, 'a'), cell(0, 1, 'b')])], 2), ctx);
    expect(xml.match(/<w:gridCol /g)?.length).toBe(2);
    expect(xml).toContain('w:w="2000"');    // 100pt * 20 twips
    parses(xml);
  });

  // An empty w:tc is invalid WordprocessingML and Word refuses the document --
  // an empty PARAGRAPH is how the format spells an empty cell.
  it('gives every cell at least one paragraph', () => {
    const xml = docxTable(table([row([cell(0, 0, ''), cell(0, 1, 'b')])], 2), ctx);
    expect(xml).not.toMatch(/<w:tc>(<w:tcPr>.*?<\/w:tcPr>)?<\/w:tc>/);
    expect(xml.match(/<w:p>/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('maps colSpan to gridSpan', () => {
    const xml = docxTable(table([row([cell(0, 0, 'wide', { colSpan: 2 })])], 2), ctx);
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
  });

  it('maps rowSpan to a vMerge restart and a continuation', () => {
    const xml = docxTable(table([
      row([cell(0, 0, 'tall', { rowSpan: 2 }), cell(0, 1, 'x')]),
      row([cell(1, 1, 'y')]),
    ], 2), ctx);
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge/>');
  });

  it('repeats a header row across pages', () => {
    const xml = docxTable(table([
      row([cell(0, 0, 'H', { isHeader: true })]),
      row([cell(1, 0, 'd')]),
    ], 1), ctx);
    expect(xml).toContain('<w:tblHeader/>');
  });

  // WordprocessingML nests directly, unlike GFM -- which is why
  // Table.toMarkdown has to follow a nested table with its parent and this
  // module does not.
  it('nests a table inside its parent cell', () => {
    const inner = table([row([cell(0, 0, 'inner')])], 1);
    const xml = docxTable(table([row([cell(0, 0, 'outer', { tables: [inner] })])], 1), ctx);
    const cellStart = xml.indexOf('<w:tc>');
    const cellEnd = xml.indexOf('</w:tc>', cellStart);
    expect(xml.slice(cellStart, cellEnd)).toContain('inner');
  });

  it('returns nothing for a table with no rows', () => {
    expect(docxTable(table([], 0), ctx)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-table.test.ts`
Expected: FAIL — cannot resolve `../src/docxtable.js`.

- [ ] **Step 3: Implement `src/docxtable.ts`**

```ts
import type { Table, TableCell } from './tablemodel.js';
import { TWIPS_PER_PT } from './docxstyles.js';

/** `paragraph` builds one `w:p` from cell text.
 *
 *  **Invariant:** it is PASSED IN rather than imported. `docxflow.ts` calls this
 *  module, so importing back would close a cycle — and a second paragraph
 *  emitter is how a cell comes to lose the `xml:space` attribute or the
 *  control-character strip the rest of the document has. */
export interface DocxTableCtx { paragraph(text: string): string }

/** Column edges in the table's own frame, from every cell's left edge plus the
 *  table's right edge. Auto-fit is not attempted: the geometry the extractor
 *  recovered is the best statement of what the columns were. */
function gridWidths(table: Table): number[] {
  const edges = new Set<number>();
  for (const r of table.rows) for (const c of r.cells) edges.add(c.quad[0]);
  edges.add(table.quad[2]);
  const sorted = [...edges].sort((a, b) => a - b);
  const widths: number[] = [];
  for (let i = 1; i < sorted.length; i++) widths.push(sorted[i] - sorted[i - 1]);
  return widths.length ? widths : [table.quad[2] - table.quad[0]];
}

/** The cells covered by a rowSpan from an earlier row, by column. */
function coveredColumns(table: Table, rowIndex: number): Set<number> {
  const out = new Set<number>();
  for (let r = 0; r < rowIndex; r++) {
    for (const c of table.rows[r]?.cells ?? []) {
      if (c.rowSpan > 1 && r + c.rowSpan > rowIndex) {
        for (let i = 0; i < c.colSpan; i++) out.add(c.col + i);
      }
    }
  }
  return out;
}

function cellXml(c: TableCell, widthTwips: number, ctx: DocxTableCtx, merge?: 'restart'): string {
  const props = `<w:tcW w:w="${Math.round(widthTwips)}" w:type="dxa"/>`
    + (c.colSpan > 1 ? `<w:gridSpan w:val="${c.colSpan}"/>` : '')
    + (c.rowSpan > 1 && merge === 'restart' ? '<w:vMerge w:val="restart"/>' : '');
  // An empty w:tc is invalid and Word refuses the document; an empty PARAGRAPH
  // is how the format spells an empty cell.
  const nested = (c.tables ?? []).map((t) => docxTable(t, ctx)).join('');
  const body = ctx.paragraph(c.text) + nested + (nested ? ctx.paragraph('') : '');
  return `<w:tc><w:tcPr>${props}</w:tcPr>${body}</w:tc>`;
}

/** A continuation cell for a rowSpan started above. */
function mergedCellXml(widthTwips: number, ctx: DocxTableCtx): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${Math.round(widthTwips)}" w:type="dxa"/>`
    + `<w:vMerge/></w:tcPr>${ctx.paragraph('')}</w:tc>`;
}

export function docxTable(table: Table, ctx: DocxTableCtx): string {
  if (!table.rows.length) return '';
  const widths = gridWidths(table).map((w) => Math.round(w * TWIPS_PER_PT));
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const total = widths.reduce((a, b) => a + b, 0);

  const rows = table.rows.map((r, ri) => {
    const covered = coveredColumns(table, ri);
    const header = r.cells.length > 0 && r.cells.every((c) => c.isHeader);
    const cells: string[] = [];
    let col = 0;
    for (const c of r.cells) {
      while (covered.has(col) && col < widths.length) {
        cells.push(mergedCellXml(widths[col] ?? 0, ctx));
        col++;
      }
      const span = widths.slice(col, col + c.colSpan).reduce((a, b) => a + b, 0);
      cells.push(cellXml(c, span || widths[col] || 0, ctx, 'restart'));
      col += c.colSpan;
    }
    while (col < widths.length && covered.has(col)) {
      cells.push(mergedCellXml(widths[col] ?? 0, ctx));
      col++;
    }
    // w:tblHeader makes Word repeat the row when the table breaks a page.
    const trPr = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
  }).join('');

  // A uniform single-line frame. Reading the extractor's ruling geometry into
  // per-cell w:tcBorders is 8yt9.3, not this task.
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/>`
    + '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="auto"/>`).join('')
    + `</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>`;
}
```

`Table.summary` is deliberately not emitted here. It has no obvious
WordprocessingML home — `w:tblCaption` is a later schema addition — and an
element the schema does not accept fails the whole part rather than one table.
It belongs with `8yt9.3`'s border work, which is already reading the table's
other recovered attributes.

- [ ] **Step 4: Wire it into `docxflow.ts`**

```ts
  if (node.kind === 'table') {
    const xml = docxTable(node.table, { paragraph: (t) => paragraphXml(runXml(t)) });
    if (xml) {
      out.push(xml);
      // An empty paragraph after a table, always: two w:tbl elements with
      // nothing between them merge into one table in Word, and a body ending in
      // a table has no paragraph mark for the section properties to attach to.
      out.push(paragraphXml(''));
    }
    return;
  }
```

- [ ] **Step 5: Add the adjacency test to `test/docx-flow.test.ts`**

```ts
  it('separates two adjacent tables with a paragraph', () => {
    const t = { kind: 'table', table: new Table([0, 0, 100, 20], 1, 1,
      [{ cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, quad: [0, 0, 100, 20], text: 'x' }],
         quad: [0, 0, 100, 20] }]) } as DocNode;
    const xml = body([t, t]);
    expect(xml).toMatch(/<\/w:tbl><w:p\/?>/);
  });
```

Import `Table` from `../src/tablemodel.js` in that file.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/docx-table.test.ts test/docx-flow.test.ts` — Expected: PASS
Run: `npm run typecheck` — Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/docxtable.ts src/docxflow.ts test/docx-table.test.ts test/docx-flow.test.ts
git commit -m "feat(docx): map an extracted table to w:tbl"
```

---

### Task 11: `docxexport.ts`, package assembly and the public API

**Files:**
- Create: `src/docxexport.ts`
- Modify: `src/docxpackage.ts`, `src/document.ts`, `src/page.ts`, `src/node.ts`, `src/index.ts`
- Test: `test/docx-export.test.ts` (new)

**Interfaces:**
- Consumes: `docxBody` (Tasks 7–9), `docxStylesXml`/`docxNumberingXml` (Task 6), `buildDocModel` from `./docmodel.js`, `encodeImage`/`imageExtension` from `./imagehref.js`, `writeDocx` from `./docxpackage.js`, `unzip`/`entry`/`textOf` from `test/helpers/unzip.js`.
- Produces:
  ```ts
  // docxpackage.ts
  export interface DocxExtras { parts?: OoxmlPart[]; rels?: OoxmlRelationship[] }
  export function writeDocx(bodyXml: string, extras?: DocxExtras): Uint8Array;
  // docxexport.ts
  export function renderDocumentToDocx(doc: Document): Uint8Array;
  export function renderPageToDocx(doc: Document, page: Page): Uint8Array;
  // document.ts / page.ts
  ToDocx(): Uint8Array;
  // node.ts
  export async function saveDocxFile(inputPath: string, outPath: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/docx-export.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/index.js';
import { unzip, entry, textOf } from './helpers/unzip.js';
import { parseXml } from '../src/xml.js';

function built() {
  const doc = Document.New();
  const flow = doc.NewFlow({ tagged: true });
  flow.AddMarkdown([
    '# Title', '', 'Plain start **bold middle** plain end.', '',
    '- one', '- two', '', '[the docs](https://example.com)', '',
  ].join('\n'));
  flow.Render();
  return doc;
}

const parts = (doc: Document) => unzip(doc.ToDocx());
const paths = (doc: Document) => parts(doc).map((e) => e.path).sort();

describe('ToDocx package', () => {
  it('writes the expected part set', () => {
    const p = paths(built());
    expect(p).toContain('[Content_Types].xml');
    expect(p).toContain('_rels/.rels');
    expect(p).toContain('word/document.xml');
    expect(p).toContain('word/styles.xml');
    expect(p).toContain('word/numbering.xml');
    expect(p).toContain('word/_rels/document.xml.rels');
  });

  it('declares a content type for every part', () => {
    const es = parts(built());
    const ct = textOf(es, '[Content_Types].xml');
    for (const e of es) {
      if (e.path === '[Content_Types].xml') continue;
      if (e.path.endsWith('.rels')) continue;   // covered by the extension default
      expect(ct).toContain(`PartName="/${e.path}"`);
    }
  });

  it('resolves every internal relationship to a part that exists', () => {
    const es = parts(built());
    const present = new Set(es.map((e) => e.path));
    for (const e of es) {
      if (!e.path.endsWith('.rels')) continue;
      const dir = e.path.replace(/_rels\/[^/]+$/, '');
      const xml = new TextDecoder().decode(e.bytes);
      for (const m of xml.matchAll(/Target="([^"]+)"(?![^>]*External)/g)) {
        expect(present.has(`${dir}${m[1]}`)).toBe(true);
      }
    }
  });

  it('parses every XML part', () => {
    for (const e of parts(built())) {
      if (!e.path.endsWith('.xml') && !e.path.endsWith('.rels')) continue;
      expect(() => parseXml(e.bytes)).not.toThrow();
    }
  });

  // Both are serializers over one model, so their text cannot disagree.
  it('agrees with the Markdown export about the text', () => {
    const doc = built();
    const words = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const docx = textOf(parts(doc), 'word/document.xml').replace(/<[^>]+>/g, '');
    expect(words(docx)).toBe(words(doc.ToMarkdown()));
  });

  it('closes the body with the page size', () => {
    expect(textOf(parts(built()), 'word/document.xml')).toContain('<w:pgSz ');
  });

  // Two runs over one input must give identical bytes, or nothing downstream
  // can be snapshot-tested.
  it('is byte-reproducible', () => {
    const doc = built();
    expect(Buffer.from(doc.ToDocx()).equals(Buffer.from(doc.ToDocx()))).toBe(true);
  });

  it('omits numbering when the document has no list', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph('No lists here.');
    flow.Render();
    expect(paths(doc)).not.toContain('word/numbering.xml');
  });

  it('exports one page on its own', () => {
    const doc = built();
    expect(() => unzip(doc.Pages[0].ToDocx())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/docx-export.test.ts`
Expected: FAIL — `ToDocx` does not exist on `Document`.

- [ ] **Step 3: Extend `writeDocx`**

In `src/docxpackage.ts`:

```ts
/** Parts and relationships a caller adds beside the minimal set. */
export interface DocxExtras { parts?: OoxmlPart[]; rels?: OoxmlRelationship[] }

export function writeDocx(bodyXml: string, extras: DocxExtras = {}): Uint8Array {
  const parts: OoxmlPart[] = [
    { path: 'word/document.xml', bytes: utf8(documentXml(bodyXml)), contentType: DOC_TYPE },
    ...(extras.parts ?? []),
  ];
  const rels: OoxmlRelationship[] = [
    { source: '', id: 'rId1', type: `${REL_BASE}/officeDocument`, target: 'word/document.xml' },
    ...(extras.rels ?? []),
  ];
  return buildOoxmlPackage(parts, rels);
}
```

and widen the namespace declarations in `documentXml`, which a drawing and a hyperlink both need:

```ts
function documentXml(bodyXml: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + `<w:document xmlns:w="${W_NS}" xmlns:r="${REL_BASE}"`
    + ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"'
    + `><w:body>${bodyXml}</w:body></w:document>\n`;
}
```

- [ ] **Step 4: Implement `src/docxexport.ts`**

```ts
import { createHash } from 'node:crypto';
import type { Document } from './document.js';
import type { Page } from './page.js';
import { buildDocModel } from './docmodel.js';
import { encodeImage, imageExtension } from './imagehref.js';
import type { PdfStream } from './types.js';
import { docxBody, type DocxImage } from './docxflow.js';
import { docxNumberingXml, docxStylesXml, TWIPS_PER_PT } from './docxstyles.js';
import { writeDocx, type DocxExtras } from './docxpackage.js';
import type { OoxmlPart, OoxmlRelationship } from './ooxml.js';
import { ImageInfo } from './image.js';

const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STYLES_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const NUMBERING_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** `w:sectPr` from the first page's box, in twips.
 *
 *  **Invariant:** the page size is stated. Word's default is US Letter, so
 *  every A4 document would otherwise reflow on open — a change to the document
 *  made by saying nothing. */
function sectPr(page: Page | undefined): string {
  const box = page?.CropBox ?? page?.MediaBox ?? [0, 0, 595.28, 841.89];
  const w = Math.round((box[2] - box[0]) * TWIPS_PER_PT);
  const h = Math.round((box[3] - box[1]) * TWIPS_PER_PT);
  return `<w:sectPr><w:pgSz w:w="${w}" w:h="${h}"/>`
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
}

function render(doc: Document, pages: Page[]): Uint8Array {
  const parts: OoxmlPart[] = [];
  const rels: OoxmlRelationship[] = [];
  let nextRel = 2;                     // rId1 is the package root -> document
  const relId = (): string => `rId${nextRel++}`;

  // Identity is the hash of the ENCODED BYTES, not the PdfStream object: a
  // merged document holds distinct stream objects with identical content, and
  // keying on identity writes the same picture into the package several times.
  const seen = new Map<string, DocxImage>();
  const images = {
    add(stream: PdfStream): DocxImage | undefined {
      const enc = encodeImage(doc, stream, [0, 0, 0]);
      if (!enc) return undefined;
      const key = createHash('sha256').update(enc.bytes).digest('hex');
      const hit = seen.get(key);
      if (hit) return hit;
      const ext = imageExtension(enc.mediaType);
      const path = `word/media/image${seen.size + 1}.${ext}`;
      // Stored, never deflated: encodeImage returns JPEG or PNG, both already
      // compressed, and deflating them costs time and usually grows them.
      parts.push({ path, bytes: enc.bytes, contentType: enc.mediaType, store: true });
      const id = relId();
      rels.push({ source: 'word/document.xml', id, type: `${REL_BASE}/image`,
        target: path.slice('word/'.length) });
      const info = new ImageInfo(doc, '', stream);
      const img: DocxImage = { rid: id, pxWidth: info.Width || 0, pxHeight: info.Height || 0 };
      seen.set(key, img);
      return img;
    },
  };

  const links = {
    add(href: string): string {
      const id = relId();
      rels.push({ source: 'word/document.xml', id, type: `${REL_BASE}/hyperlink`,
        target: href, external: true });
      return id;
    },
  };

  let xml = '';
  let nums: ReturnType<typeof docxBody>['nums'] = [];
  try {
    ({ xml, nums } = docxBody(buildDocModel(doc, pages), images, links));
  } catch {
    // Degrade: emit whatever was produced. Matches mdexport.ts's render and
    // renderPageToSvg, neither of which throws on a document we could not
    // fully reconstruct.
  }

  parts.push({ path: 'word/styles.xml', bytes: utf8(docxStylesXml()), contentType: STYLES_TYPE });
  rels.push({ source: 'word/document.xml', id: relId(), type: `${REL_BASE}/styles`,
    target: 'styles.xml' });

  // Only when a list exists: a numbering part defining lists nobody uses is the
  // same nothing as a relationships part with no relationships.
  if (nums.length) {
    parts.push({ path: 'word/numbering.xml', bytes: utf8(docxNumberingXml(nums)),
      contentType: NUMBERING_TYPE });
    rels.push({ source: 'word/document.xml', id: relId(), type: `${REL_BASE}/numbering`,
      target: 'numbering.xml' });
  }

  const extras: DocxExtras = { parts, rels };
  return writeDocx(xml + sectPr(pages[0]), extras);
}

/** Render every page to one `.docx`. Never throws. */
export function renderDocumentToDocx(doc: Document): Uint8Array {
  return render(doc, doc.Pages);
}

/** Render one page to a `.docx`. Never throws. */
export function renderPageToDocx(doc: Document, page: Page): Uint8Array {
  return render(doc, [page]);
}
```

Signatures used above, verified against the current source: `ImageInfo`'s
constructor is `(doc, Name, stream)` (`src/image.ts:27`) and exposes `Width`
/`Height`; `Page.CropBox` and `Page.MediaBox` are both `number[]` getters
(`src/page.ts:109` and `:120`).

- [ ] **Step 5: Wire the public API**

`src/document.ts`, beside `ToHtml`:

```ts
  /** Render every page to a `.docx` (Office Open XML, flow mode).
   *
   *  Reconstructs the document from the tagged structure tree when there is
   *  one, and from font-size heuristics when there is not — the same model
   *  `ToHtml` and `ToMarkdown` read. Emphasis is inferred from the producing
   *  font, pages flow continuously rather than breaking, and the file's
   *  images travel inside the package. Never throws. */
  ToDocx(): Uint8Array {
    return renderDocumentToDocx(this);
  }
```

`src/page.ts`, beside `ToMarkdown`:

```ts
  /** Render this page to a `.docx`. See `Document.ToDocx`. */
  ToDocx(): Uint8Array {
    return renderPageToDocx(this.doc, this);
  }
```

`src/node.ts`:

```ts
/** Read a PDF from disk, export it to a `.docx`, and write it to `outPath`.
 *
 *  Unlike `saveMarkdownFile` there are no sidecar files: a `.docx` contains
 *  its own images. */
export async function saveDocxFile(inputPath: string, outPath: string): Promise<void> {
  const input = new Uint8Array(await readFile(inputPath));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, Document.Open(input).ToDocx());
}
```

`src/index.ts`, beside the existing OOXML type exports:

```ts
export type { DocxExtras } from './docxpackage.js';
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/docx-export.test.ts` — Expected: PASS
Run: `npm run typecheck && npm test` — Expected: whole suite green, including `test/docx-package.test.ts` from `8yt9.1`

- [ ] **Step 7: Commit**

```bash
git add src/docxexport.ts src/docxpackage.ts src/document.ts src/page.ts src/node.ts src/index.ts test/docx-export.test.ts
git commit -m "feat(docx): Document.ToDocx over the neutral document model"
```

---

### Task 12: Prove the assertions, then document

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Possibly modify: any test whose mutation ran green

**Interfaces:**
- Consumes: everything above.
- Produces: no code. This task is the evidence and the docs.

A test passing on its first run is not evidence. Each mutation below is applied, the suite run, the named test confirmed **red**, then the mutation reverted. Any mutation that leaves the suite green means the assertion is not load-bearing — strengthen it and record what you found.

- [ ] **Step 1: Run the mutations**

| # | Mutation | Must go red |
|---|---|---|
| 1 | Drop `xml:space="preserve"` from `textXml` | `test/docx-flow.test.ts` "preserves space on every w:t" |
| 2 | Make `sanitizeXml` the identity function | `test/docx-flow.test.ts` "drops characters XML 1.0 forbids" |
| 3 | Emit `bold: false` rather than omitting it in `fragmentsFromGlyphs` | `test/text-fragment-style.test.ts` "omits the fields for a plain face" |
| 4 | Split `styledRuns` on `glyphs[i].font !== prev` (the object) | `test/struct-text-style.test.ts`, and check whether any docmodel test notices |
| 5 | Use `img.pxWidth * 0.75` unconditionally in the figure branch | `test/docx-flow-media.test.ts` "sizes the drawing from the drawn box" |
| 6 | Emit `<w:tc><w:tcPr/></w:tc>` for an empty cell | `test/docx-table.test.ts` "gives every cell at least one paragraph" |
| 7 | Use a constant `1` for `wp:docPr@id` | `test/docx-flow-media.test.ts` "unique non-zero docPr id" |
| 8 | Move `startOverride` onto the abstract definition | `test/docx-styles.test.ts` "puts a start override on the num" |
| 9 | Drop `sectPr` from the body | `test/docx-export.test.ts` "closes the body with the page size" |
| 10 | Drop the empty paragraph after a table | `test/docx-flow.test.ts` "separates two adjacent tables" |

Record any mutation that stayed green in the issue and in the module's comment, the way CLAUDE.md records the `scanDelimiterRow` and `docinfer` follower-clause findings. Two redundant defences mean breaking either one alone proves nothing — say so rather than leaving a false claim of coverage.

- [ ] **Step 2: Update `README.md`**

Add `ToDocx` to the API overview beside `ToHtml`/`ToMarkdown`, and add to Limitations:

- DOCX export is flow mode: pages are concatenated with no page break, matching `ToHtml` and `ToMarkdown`. Reproducing the PDF's pagination is a later feature.
- Bold and italic are **inferred from the producing font**, not read from the PDF. A document that sets bold by using a bold face is recovered; one that fakes it with a stroke width is not.
- No headers, footers, footnotes or revision tracking — a PDF records none of them in a form the model carries.
- Word compatibility is unverified in CI (already present from `8yt9.1`; leave it).

- [ ] **Step 3: Update `CLAUDE.md`**

In the Source list, add an entry after the `zip.ts`/`ooxml.ts`/`docxpackage.ts` one covering `docxflow.ts`, `docxtable.ts`, `docxstyles.ts` and `docxexport.ts`, carrying the invariants proven above: `xml:space` on every `w:t`; the control-character strip before escaping; one style owner in `docxstyles.ts`; the paragraph builder passed into `docxtable.ts` rather than imported; `w:tc` never empty; the empty paragraph between adjacent tables; unique non-zero `docPr` ids; image identity as an encoded-bytes hash; media parts stored; and the reported numbering rather than a flag.

Extend the `docmodel.ts` entry with the two new fields and why the other two serializers ignore them, and the `font.ts` entry with `fontStyleOf`'s single ownership and the OR-of-positive-signals rule.

- [ ] **Step 4: Verify and commit**

Run: `npm run typecheck && npm test` — Expected: green

```bash
git add README.md CLAUDE.md
git commit -m "docs(docx): record the flow-mode invariants and the inferred-emphasis limit"
```

- [ ] **Step 5: Close out the issue**

```bash
bd close aspose-pdf-foss-for-ts-8yt9.2
git pull --rebase && git push && git status
```

Rewrite `8yt9.3`'s description to what it now is — border and shading recovery from the ruled geometry, plus nested-table refinement — since the `w:tbl` grid, spans and header rows landed here:

```bash
bd update aspose-pdf-foss-for-ts-8yt9.3 -d "Ruled-border and shading recovery for w:tbl. The grid, colSpan/rowSpan, header-row repetition and nesting shipped in 8yt9.2; what remains is reading the extracted ruling geometry into per-cell w:tcBorders and w:shd, rather than the uniform single-line frame 8yt9.2 emits."
```

The session is not complete until `git push` succeeds and `git status` shows the branch up to date with origin.
