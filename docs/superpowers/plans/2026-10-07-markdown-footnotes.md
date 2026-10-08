# Markdown Footnotes (v9j3.3.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `parseMarkdown(src, { gfm: true })` parses GitHub footnotes (cmark-gfm's grammar), and the three `AddMarkdown` entry points render them through the v9j3.3 Flow footnote engine.

**Architecture:** The block phase opens a `footnote_definition` container; the inline phase turns `[^label]` into a placeholder `footnote_reference`; a post-pass `resolveFootnotes` (cmark-gfm's `process_footnotes`) numbers references in tree order, turns unmatched ones back into literal text, and moves cited definitions to `MdDocument.footnotes`. The mapper builds one `FlowNote` per cited definition and cites it from an empty run; the engine gains "a repeated citation" (same mark, one note) and `notesAsTrailing` for the single-rect `page.AddMarkdown`. cmark-gfm's own test data is the oracle.

**Tech Stack:** TypeScript (strict, ESM/NodeNext, `.js` specifiers), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-07-markdown-footnotes-design.md`

**Upstream transcribed (cmark-gfm master `27d942c8b0a62d192f616e5bf3578f4b6a89e180`):** `src/blocks.c` (`process_footnotes`, `parse_footnote_definition_block_prefix`, the definition start in `open_new_blocks`), `src/scanners.re` (`_scan_footnote_definition`), `src/inlines.c` (`handle_close_bracket` noMatch branch, the `!` case in `parse_inline`), `src/footnotes.c` + `src/map.c` (label normalization, first-wins), `src/html.c` (footnote HTML). Every port names its function in a comment.

## Global Constraints

- `gfm` off: byte-identical. `test/commonmark-spec.test.ts`'s no-options run is the fence; its `{ gfm: true }` run's divergence list may grow only with a stated reason per entry.
- No new value-import 2-cycle (`npx vitest run test/import-cycles.test.ts`).
- Every `catch` calls `rethrowLimit` first; this plan adds none.
- New exports need README API rows (`test/readme-api.test.ts`).
- Option names: `MarkdownFlowOptions.footnotePlacement?: 'foot' | 'end'` (default `'foot'`) and `MarkdownStyle.footnoteSize?: number` (default 8). **Ruling:** the spec says `footnotes`; it is renamed because `doc.AddMarkdown` takes `MarkdownFlowOptions & FlowOptions` and `FlowOptions.footnotes` (the note-style object) already exists — one key with two types in one intersection.
- Refused citations render as literal `[^label]` and push `'footnote (table cell)'` or `'footnote (nested)'` to `skipped`.
- `npm run typecheck` and `npm test` green before closing.

## Review Focus

1. **A document with fifty footnotes**: all fifty marks and notes render, numbered 1..50 in citation order. → Task 6.
2. **A citation in a heading**: the mark sits on the heading line and the note is placed. → Task 6.
3. **A label whose case and spacing differ between citation and definition** (`[^Note]` / `[^note]:`): they match (case fold). → Task 3.
4. **A citation inside a block quote and inside a list item**: both marks drawn, both notes placed. → Task 6.
5. **An undefined reference** (`[^nope]`): the literal text `[^nope]` is drawn and nothing is reported missing. → Task 6.

---

### Task 1: Block phase — footnote definitions

**Files:**
- Modify: `src/mdast.ts` (new node types)
- Modify: `src/mdblock.ts` (`Kind`, `canContain`, `matchContinuation`, `tryStart`, `MAYBE_START_GFM`, `assemble`)
- Test: `test/md-footnote-blocks.test.ts` (create)

**Interfaces:**
- Produces:

```ts
// mdast.ts
export interface MdFootnoteReference {
  type: 'footnote_reference';
  /** The DEFINITION's label as written (cmark-gfm renders the definition's
   *  literal); before resolution, the reference's own raw label. */
  label: string;
  /** 1-based, order of first citation; 0 before resolution. */
  index: number;
  /** 1 for the first citation of its definition, 2, 3…; 0 before resolution. */
  occurrence: number;
}
export interface MdFootnoteDefinition {
  type: 'footnote_definition';
  label: string;          // as written
  index: number;          // 0 until cited
  /** How many citations it has (cmark-gfm's def_count). */
  references: number;
  children: MdBlock[];
}
// MdDocument gains: footnotes?: MdFootnoteDefinition[];
// MdBlock gains MdFootnoteDefinition; MdInline gains MdFootnoteReference;
// BLOCK_TYPES and CONTAINER_TYPES gain 'footnote_definition'.
```

- [ ] **Step 1: Write the failing test**

```ts
// test/md-footnote-blocks.test.ts
import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../src/mdblock.js';
import type { MdFootnoteDefinition, MdBlock } from '../src/mdast.js';

const lines = (s: string) => s.replace(/\n$/, '').split('\n');
const defs = (children: MdBlock[]) => children.filter((b) => b.type === 'footnote_definition') as MdFootnoteDefinition[];

describe('footnote definitions (block phase, gfm)', () => {
  it('opens a container on [^label]: and parses its first line as a paragraph', () => {
    const { doc } = parseBlocks(lines('[^1]: Some *bold* note.'), true);
    const [d] = defs(doc.children);
    expect(d.label).toBe('1');
    expect(d.children.map((c) => c.type)).toEqual(['paragraph']);
  });
  it('swallows the spaces after the colon (no indented code)', () => {
    const { doc } = parseBlocks(lines('[^n]:       spaces stripped'), true);
    expect(defs(doc.children)[0].children.map((c) => c.type)).toEqual(['paragraph']);
  });
  it('continues on lines indented 4+, through blank lines', () => {
    const { doc } = parseBlocks(lines('[^f]:\n    > quote\n\n        code\n\n    para\n\nafter'), true);
    const [d] = defs(doc.children);
    expect(d.children.map((c) => c.type)).toEqual(['block_quote', 'code_block', 'paragraph']);
    expect(doc.children.map((c) => c.type)).toEqual(['footnote_definition', 'paragraph']);
  });
  it('an 8-space continuation is a code block inside the definition', () => {
    const { doc } = parseBlocks(lines('[^c]:\n        code here'), true);
    expect(defs(doc.children)[0].children.map((c) => c.type)).toEqual(['code_block']);
  });
  it('interrupts a paragraph', () => {
    const { doc } = parseBlocks(lines('text\n[^a]: note'), true);
    expect(doc.children.map((c) => c.type)).toEqual(['paragraph', 'footnote_definition']);
  });
  it('a label may not contain a space, tab or ]', () => {
    for (const src of ['[^a b]: x', '[^a\tb]: x', '[^]: x']) {
      const { doc } = parseBlocks(lines(src), true);
      expect(defs(doc.children)).toHaveLength(0);
    }
  });
  it('a definition may hold a definition', () => {
    const { doc } = parseBlocks(lines('[^a]:[^b]:'), true);
    const [a] = defs(doc.children);
    expect(defs(a.children).map((d) => d.label)).toEqual(['b']);
  });
  it('is inert with gfm off: the line is a paragraph (a link reference attempt)', () => {
    const { doc } = parseBlocks(lines('[^1]: note'), false);
    expect(defs(doc.children)).toHaveLength(0);
  });
  it('an indented [^x]: is not a definition', () => {
    const { doc } = parseBlocks(lines('    [^x]: note'), true);
    expect(defs(doc.children)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/md-footnote-blocks.test.ts`
Expected: FAIL — no `footnote_definition` nodes.

- [ ] **Step 3: Implement**

`src/mdast.ts`: add the two interfaces (doc comments as above), add `footnotes?: MdFootnoteDefinition[]` to `MdDocument` with the doc comment "Cited definitions in `index` order (gfm only); absent when nothing was cited.", extend the unions and both type sets.

`src/mdblock.ts`:
- `Kind` gains `'footnote_definition'`.
- `canContain`: `if (parent === 'document' || parent === 'block_quote' || parent === 'item' || parent === 'footnote_definition') return child !== 'item';`
- `MAYBE_START_GFM = /^[#`~*+_=<>0-9|:[-]/` (adds `[`; a gate only — a line that starts nothing still falls through).
- A constant transcribed from `_scan_footnote_definition`:

```ts
/** cmark-gfm scanners.re `_scan_footnote_definition`:
 *  `'[^' ([^\] \r\n\x00\t]+) ']:' [ \t]*`. The trailing blanks are part of the
 *  match, which is why `[^n]:       text` opens no indented code block. */
const FOOTNOTE_DEF = /^\[\^([^\] \r\n\0\t]+)\]:[ \t]*/;
```

- `matchContinuation`, new case (cmark-gfm `parse_footnote_definition_block_prefix`):

```ts
      case 'footnote_definition':
        if (this.indent >= CODE_INDENT) { this.advance(CODE_INDENT, true); return 'matched'; }
        if (this.blank) return 'matched';
        return 'closed';
```

- `tryStart`, inside `if (!this.indented) { … }`, AFTER the thematic-break branch (cmark-gfm's `open_new_blocks` order — thematic break, then footnote definition, then list item):

```ts
      // GFM footnote definition (cmark-gfm open_new_blocks). Its opening line's
      // remainder is ordinary block content, so it returns a container.
      if (this.gfm) {
        const fd = FOOTNOTE_DEF.exec(rest);
        if (fd !== null) {
          this.advanceNextNonspace();
          this.advance(fd[0].length, false);
          this.closeUnmatched();
          const node: MdFootnoteDefinition = {
            type: 'footnote_definition', label: fd[1], index: 0, references: 0, children: [],
          };
          return { block: this.addChild('footnote_definition', node), leaf: false };
        }
      }
```

- `assemble`: add `case 'footnote_definition':` beside `'block_quote'` so `c.node.children = inner`.
- `finalize` needs no case (the switch's default does nothing — check it has one; add `case 'footnote_definition': break;` if the switch is exhaustive).

- [ ] **Step 4: Run to verify it passes, plus the fences**

Run: `npx vitest run test/md-footnote-blocks.test.ts test/commonmark-spec.test.ts test/gfm-spec.test.ts test/gfm-ast.test.ts test/markdown-ast.test.ts`
Expected: PASS. If the `{ gfm: true }` CommonMark run reports a NEW divergence, record it in the divergence list with a one-line reason (it must be a `[^…]:` line, which GFM legitimately reads differently) and note it in the ledger.

- [ ] **Step 5: Commit**

```bash
git add src/mdast.ts src/mdblock.ts test/md-footnote-blocks.test.ts
git commit -m "feat(v9j3.3.1): GFM footnote definitions in the block phase"
```

---

### Task 2: Inline phase — footnote references

**Files:**
- Modify: `src/mdinline.ts` (`parseCloseBracket`, `parseBang`, `walk`)
- Test: `test/md-footnote-inlines.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `MdFootnoteReference`.
- Produces: placeholder `{ type: 'footnote_reference', label: <raw text after ^>, index: 0, occurrence: 0 }` nodes; `walk` descends into `footnote_definition`.

- [ ] **Step 1: Write the failing test**

```ts
// test/md-footnote-inlines.test.ts
import { describe, it, expect } from 'vitest';
import { parseBlocks } from '../src/mdblock.js';
import { parseInlines } from '../src/mdinline.js';
import type { MdParagraph } from '../src/mdast.js';

function inl(src: string, gfm = true) {
  const { doc, refs } = parseBlocks(src.split('\n'), gfm);
  parseInlines(doc, refs, gfm);
  return (doc.children[0] as MdParagraph).children;
}

describe('footnote references (inline phase, gfm)', () => {
  it('[^label] becomes a placeholder reference', () => {
    expect(inl('a[^1] b')).toEqual([
      { type: 'text', value: 'a' },
      { type: 'footnote_reference', label: '1', index: 0, occurrence: 0 },
      { type: 'text', value: ' b' },
    ]);
  });
  it('the label is the RAW text between [^ and ], whatever parsed inside', () => {
    const n = inl('x[^~~is~~1]').find((k) => k.type === 'footnote_reference');
    expect(n).toMatchObject({ label: '~~is~~1' });
  });
  it('[^] alone is not a reference', () => {
    expect(inl('a[^]').some((k) => k.type === 'footnote_reference')).toBe(false);
  });
  it('a link wins: [^x](url) is a link', () => {
    expect(inl('[^x](http://a.b)')[0]).toMatchObject({ type: 'link' });
  });
  it('![^1] is a bang then a reference, never an image', () => {
    const ns = inl('a![^1]');
    expect(ns.map((n) => n.type)).toEqual(['text', 'footnote_reference']);
    expect((ns[0] as { value: string }).value).toBe('a!');
  });
  it('two references side by side', () => {
    expect(inl('x[^a][^b]').filter((k) => k.type === 'footnote_reference')).toHaveLength(2);
  });
  it('emphasis around a reference still closes', () => {
    expect(inl('*a[^1]*')[0]).toMatchObject({ type: 'emph' });
  });
  it('is inert with gfm off', () => {
    expect(inl('a[^1] b', false).some((k) => k.type === 'footnote_reference')).toBe(false);
  });
  it('resolves inside a definition body too', () => {
    const { doc, refs } = parseBlocks(['[^a]: see[^b]'], true);
    parseInlines(doc, refs, true);
    const def = doc.children[0] as { children: MdParagraph[] };
    expect(def.children[0].children.some((k) => k.type === 'footnote_reference')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/md-footnote-inlines.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`parseBang` — cmark-gfm `parse_inline`'s `'!'` case refuses `![^` as an image opener:

```ts
    if (this.subject[this.pos] === '[' && !(this.gfm && this.subject[this.pos + 1] === '^')) {
```

(keep the rest unchanged; check the field holding the gfm flag in `InlineParser` — the constructor takes `gfm`.)

`parseCloseBracket` — replace the `if (!matched) { … }` block with:

```ts
    if (!matched) {
      // cmark-gfm handle_close_bracket, noMatch: a bracket that is not a link
      // and whose text starts with `^` plus at least one more character is a
      // footnote reference. Its label is the RAW source between `[^` and `]`,
      // whatever parsed inside — so an undefined `[^~~x~~]` later comes back
      // as those exact characters. Unlike a link it deactivates no opener.
      const raw = this.subject.slice(opener.index, afterBracket - 1);
      if (this.gfm && !isImage && raw.length > 1 && raw[0] === '^') {
        this.processEmphasis(opener.prevDelimiter);
        this.list.extract(opener.node, undefined);          // discard what parsed inside
        this.list.push({ type: 'footnote_reference', label: raw.slice(1), index: 0, occurrence: 0 });
        this.list.remove(opener.node);
        this.removeBracket();
        this.pos = afterBracket;
        return true;
      }
      this.removeBracket();
      this.pos = afterBracket;
      this.text(']');
      return true;
    }
```

`walk`: add `case 'footnote_definition':` to the container group (`document`, `block_quote`, `item`, `list`).

- [ ] **Step 4: Run to verify it passes, plus the fences**

Run: `npx vitest run test/md-footnote-inlines.test.ts test/commonmark-spec.test.ts test/gfm-spec.test.ts test/markdown-links.test.ts`
Expected: PASS (same divergence rule as Task 1).

- [ ] **Step 5: Commit**

```bash
git add src/mdinline.ts test/md-footnote-inlines.test.ts
git commit -m "feat(v9j3.3.1): GFM footnote references in the inline phase"
```

---

### Task 3: `resolveFootnotes` — numbering, literal fallback, `MdDocument.footnotes`

**Files:**
- Modify: `src/mdgfm.ts` (add `resolveFootnotes`)
- Modify: `src/markdown.ts` (call it when `gfm`)
- Test: `test/md-footnote-resolve.test.ts` (create)

**Interfaces:**
- Produces: `export function resolveFootnotes(doc: MdDocument): void` — after it, every `footnote_reference` has `index`/`occurrence` and its definition's label; every `footnote_definition` is gone from the tree; `doc.footnotes` holds the cited ones in `index` order (absent if none).

- [ ] **Step 1: Write the failing test**

```ts
// test/md-footnote-resolve.test.ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdInline, MdBlock, MdDocument } from '../src/mdast.js';

function refs(doc: MdDocument) {
  const out: { label: string; index: number; occurrence: number }[] = [];
  const inl = (ns: MdInline[]) => ns.forEach((n) => {
    if (n.type === 'footnote_reference') out.push({ label: n.label, index: n.index, occurrence: n.occurrence });
    if ('children' in n) inl(n.children as MdInline[]);
  });
  const blk = (bs: MdBlock[]) => bs.forEach((b) => {
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'table_cell') inl(b.children);
    else if ('children' in b) blk(b.children as MdBlock[]);
  });
  blk(doc.children);
  for (const d of doc.footnotes ?? []) blk(d.children);
  return out;
}
const md = (s: string) => parseMarkdown(s, { gfm: true });

describe('resolveFootnotes', () => {
  it('numbers by first citation and counts occurrences', () => {
    const doc = md('a[^x] b[^y] c[^x]\n\n[^y]: Y\n[^x]: X\n');
    expect(refs(doc)).toEqual([
      { label: 'x', index: 1, occurrence: 1 },
      { label: 'y', index: 2, occurrence: 1 },
      { label: 'x', index: 1, occurrence: 2 },
    ]);
    expect(doc.footnotes!.map((d) => [d.label, d.index, d.references])).toEqual([['x', 1, 2], ['y', 2, 1]]);
  });
  it('removes every definition from the tree, cited or not', () => {
    const doc = md('t[^a]\n\n> [^a]: A\n\n[^unused]: U\n');
    expect(JSON.stringify(doc.children)).not.toContain('footnote_definition');
    expect(doc.footnotes!.map((d) => d.label)).toEqual(['a']);
  });
  it('an undefined reference is the literal source text', () => {
    const doc = md('x[^~~is~~1] y\n');
    expect(JSON.stringify(doc.children)).toContain('[^~~is~~1]');
    expect(doc.footnotes).toBeUndefined();
  });
  it('matches labels by case fold and collapsed whitespace (Review Focus 3)', () => {
    const doc = md('t[^Note]\n\n[^note]: n\n');
    expect(refs(doc)[0]).toMatchObject({ index: 1, label: 'note' });   // the DEFINITION's spelling
  });
  it('the first definition of a label wins', () => {
    const doc = md('t[^a]\n\n[^a]: first\n\n[^a]: second\n');
    expect(JSON.stringify(doc.footnotes)).toContain('first');
    expect(JSON.stringify(doc.footnotes)).not.toContain('second');
  });
  it('numbers in TREE order: a citation inside an earlier definition counts where that definition sits', () => {
    // cmark-gfm process_footnotes walks the tree with definitions still in place.
    const doc = md('[^a]: A cites[^b]\n\nlater[^a] and[^c]\n\n[^b]: B\n[^c]: C\n');
    const order = doc.footnotes!.map((d) => d.label);
    expect(order).toEqual(['b', 'a', 'c']);
  });
  it('a reference longer than 1000 characters is literal', () => {
    const long = 'x'.repeat(1001);
    const doc = md(`t[^${long}]\n\n[^${long}]: n\n`);
    expect(doc.footnotes).toBeUndefined();
  });
  it('gfm off produces no footnotes field', () => {
    expect(parseMarkdown('t[^a]\n\n[^a]: n\n').footnotes).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/md-footnote-resolve.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** in `src/mdgfm.ts` (import `normalizeLabel` from `mdscan.js` — check that import closes no cycle):

```ts
/** cmark-gfm blocks.c `process_footnotes`, transcribed.
 *
 *  1. Collect definitions in POST-order (cmark's EXIT events); for a repeated
 *     label the earliest collected wins (map.c sorts by label, then age).
 *  2. Walk the tree with the definitions STILL IN PLACE, numbering each
 *     reference on first sight of its definition — so a citation inside an
 *     earlier definition numbers where that definition sits. A reference with
 *     no definition (or a label past 1000 characters, `cmark_map_lookup`'s
 *     bound) becomes the literal text `[^label]`.
 *  3. Unlink EVERY definition — cited, uncited and duplicate — and keep the
 *     cited ones in index order on `doc.footnotes`. */
export function resolveFootnotes(doc: MdDocument): void {
  const defs = new Map<string, MdFootnoteDefinition>();
  const collect = (bs: MdBlock[]): void => {
    for (const b of bs) {
      if ('children' in b && b.type !== 'paragraph' && b.type !== 'heading' && b.type !== 'table_cell')
        collect(b.children as MdBlock[]);
      if (b.type === 'footnote_definition') {
        const key = normalizeLabel(b.label);
        if (key !== '' && !defs.has(key)) defs.set(key, b);
      }
    }
  };
  collect(doc.children);

  let next = 0;
  const cited: MdFootnoteDefinition[] = [];
  const inl = (ns: MdInline[]): MdInline[] => {
    const out: MdInline[] = [];
    for (const n of ns) {
      if (n.type === 'footnote_reference') {
        const def = n.label.length <= 1000 ? defs.get(normalizeLabel(n.label)) : undefined;
        if (def === undefined) { out.push({ type: 'text', value: `[^${n.label}]` }); continue; }
        if (def.index === 0) { def.index = ++next; cited.push(def); }
        def.references++;
        out.push({ type: 'footnote_reference', label: def.label, index: def.index, occurrence: def.references });
        continue;
      }
      if ('children' in n) (n as { children: MdInline[] }).children = inl(n.children as MdInline[]);
      out.push(n);
    }
    return out;
  };
  const walk = (bs: MdBlock[]): void => {
    for (const b of bs) {
      if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'table_cell') b.children = inl(b.children);
      else if ('children' in b) walk(b.children as MdBlock[]);
    }
  };
  walk(doc.children);

  const unlink = (bs: MdBlock[]): MdBlock[] => bs
    .filter((b) => b.type !== 'footnote_definition')
    .map((b) => {
      if ('children' in b && b.type !== 'paragraph' && b.type !== 'heading' && b.type !== 'table_cell')
        (b as { children: MdBlock[] }).children = unlink(b.children as MdBlock[]);
      return b;
    });
  for (const d of cited) d.children = unlink(d.children);
  doc.children = unlink(doc.children);
  if (cited.length > 0) doc.footnotes = cited;
}
```

Note: `table` → `table_row` → `table_cell` all have `children`; the `'children' in b` checks above route rows through `walk`/`unlink` and stop at cells, whose children are inlines.

`src/markdown.ts`: after `parseInlines(doc, refs, gfm);` add `if (gfm) resolveFootnotes(doc);`.

- [ ] **Step 4: Run to verify it passes, plus the fences**

Run: `npx vitest run test/md-footnote-resolve.test.ts test/md-footnote-inlines.test.ts test/md-footnote-blocks.test.ts test/commonmark-spec.test.ts test/gfm-spec.test.ts test/gfm-ast.test.ts test/import-cycles.test.ts`
Expected: PASS. Update `test/md-footnote-inlines.test.ts` only if a case there asserted a placeholder that `parseMarkdown` now resolves — it uses `parseBlocks`/`parseInlines` directly, so it should not need to.

- [ ] **Step 5: Commit**

```bash
git add src/mdgfm.ts src/markdown.ts test/md-footnote-resolve.test.ts
git commit -m "feat(v9j3.3.1): resolve footnotes — numbering, literal fallback, doc.footnotes"
```

---

### Task 4: The oracle — cmark-gfm's footnote examples

**Files:**
- Create: `test/fixtures/gfm-footnotes/extensions.txt`, `test/fixtures/gfm-footnotes/regression.txt` (byte-identical downloads), `test/fixtures/gfm-footnotes/PROVENANCE.md`
- Modify: `test/helpers/gfm-suite.ts` (export a loader that takes a file URL)
- Modify: `test/helpers/md-html.ts` (footnote HTML)
- Test: `test/gfm-footnotes-spec.test.ts` (create)

- [ ] **Step 1: Vendor the files**

```bash
mkdir -p test/fixtures/gfm-footnotes
curl -sSfL -o test/fixtures/gfm-footnotes/extensions.txt https://raw.githubusercontent.com/github/cmark-gfm/63dd7b72e0b785a967cb2f760e22e4e5e45bcd4b/test/extensions.txt
curl -sSfL -o test/fixtures/gfm-footnotes/regression.txt https://raw.githubusercontent.com/github/cmark-gfm/a97a478930ff164a2736d5011e2deafede214907/test/regression.txt
sha256sum test/fixtures/gfm-footnotes/*.txt
```

Write `PROVENANCE.md` in the house style of `test/fixtures/gfm/PROVENANCE.md`: a source table per file (upstream URL, pinned commit = the last commit touching that file, retrieved date, SHA-256, size, licence CC-BY-SA 4.0 from the file header), "What it covers" (the 3 examples in `extensions.txt` between `## Footnotes` and `## Interop`, and the 7 `regression.txt` examples whose fence tags include `footnotes` — 10 in all; list each by section/line), "What it does NOT cover" (every other example in both files is not run; HTML for footnote refs inside a link; the backslash-escaped `[\^x]`, which cmark-gfm treats as a reference and this implementation does not — record it as a known divergence, unexercised by the corpus), and a "Measured" section filled in at Task 7.

- [ ] **Step 2: Generalize the loader**

In `test/helpers/gfm-suite.ts`, factor the body of `loadGfmExamples()` into `export function loadExamplesFrom(url: URL): GfmCase[]` (same fence parsing, same `section`/`extension`/`startLine` fields, `extension` = the first fence tag, and add `tags: string[]` = every fence tag) and keep `loadGfmExamples()` as `loadExamplesFrom(SPEC_URL)`. `test/gfm-spec.test.ts` must stay green unedited (it asserts 672 and the 24-case selection).

- [ ] **Step 3: Write the failing test**

```ts
// test/gfm-footnotes-spec.test.ts
import { describe, it, expect } from 'vitest';
import { loadExamplesFrom } from './helpers/gfm-suite.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

const EXT = new URL('./fixtures/gfm-footnotes/extensions.txt', import.meta.url);
const REG = new URL('./fixtures/gfm-footnotes/regression.txt', import.meta.url);

/** extensions.txt: every example after `## Footnotes` and before `## Interop`. */
function extensionCases() {
  const all = loadExamplesFrom(EXT);
  const start = all.findIndex((c) => c.section === 'Footnotes');
  const end = all.findIndex((c, i) => i > start && c.section === 'Interop');
  return all.slice(start, end === -1 ? undefined : end);
}
const regressionCases = () => loadExamplesFrom(REG).filter((c) => c.tags.includes('footnotes'));

describe('cmark-gfm footnote corpus', () => {
  it('selects exactly 3 + 7 examples', () => {
    expect(extensionCases()).toHaveLength(3);
    expect(regressionCases()).toHaveLength(7);
  });
  for (const c of [...extensionCases(), ...regressionCases()]) {
    it(`${c.section} (line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});
```

If `section` for the first footnote example is the subsection heading rather than `Footnotes`, select by line range instead (the line of `## Footnotes` to the line of `## Interop` in the file) — the count assertion is what guards the selection.

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run test/gfm-footnotes-spec.test.ts`
Expected: the count test passes; the 10 rendering cases FAIL (no footnote HTML).

- [ ] **Step 5: Implement the footnote HTML in `test/helpers/md-html.ts`** (cmark-gfm `html.c`):

```ts
      case 'footnote_reference': {
        const l = escapeHref(n.label);
        const id = n.occurrence > 1 ? `${l}-${n.occurrence}` : l;
        this.lit(`<sup class="footnote-ref"><a href="#fn-${l}" id="fnref-${id}" data-footnote-ref>${n.index}</a></sup>`);
        break;
      }
```

and in `renderHtml`, after `r.block(doc, false)`:

```ts
  if (doc.footnotes !== undefined) r.footnotes(doc.footnotes);
```

with, on `Renderer`:

```ts
  /** cmark-gfm html.c S_put_footnote_backref: one backref per citation; the
   *  first bare, the rest suffixed `-N` with a `<sup>N</sup>`. `m` is the
   *  definition's position, which equals its index. */
  backrefs(d: MdFootnoteDefinition): string {
    const l = escapeHref(d.label);
    const m = String(d.index);
    let s = `<a href="#fnref-${l}" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="${m}" aria-label="Back to reference ${m}">↩</a>`;
    for (let i = 2; i <= d.references; i++) {
      s += ` <a href="#fnref-${l}-${i}" class="footnote-backref" data-footnote-backref data-footnote-backref-idx="${m}-${i}" aria-label="Back to reference ${m}-${i}">↩<sup class="footnote-ref">${i}</sup></a>`;
    }
    return s;
  }

  footnotes(defs: MdFootnoteDefinition[]): void {
    this.cr();
    this.lit('<section class="footnotes" data-footnotes>'); this.cr();
    this.lit('<ol>'); this.cr();
    for (const d of defs) {
      this.lit(`<li id="fn-${escapeHref(d.label)}">`); this.cr();
      const last = d.children[d.children.length - 1];
      // A paragraph is never tight inside a definition; the backrefs go INSIDE
      // the last one when it is a paragraph, else on a line of their own.
      for (const c of d.children) {
        if (c === last && c.type === 'paragraph') {
          this.cr(); this.lit('<p>'); this.inlines(c.children);
          this.lit(` ${this.backrefs(d)}</p>`); this.cr();
        } else {
          this.block(c, false);
        }
      }
      if (last === undefined || last.type !== 'paragraph') { this.lit(this.backrefs(d)); this.lit('\n'); }
      this.lit('</li>'); this.cr();
    }
    this.lit('</ol>'); this.cr();
    this.lit('</section>'); this.cr();
  }
```

Add `footnote_reference` to `plainText`'s switch (contributes its index as text, matching cmark's alt rendering of a node's literal). Import `MdFootnoteDefinition`.

- [ ] **Step 6: Run to verify it passes; triage any failure against the expectation**

Run: `npx vitest run test/gfm-footnotes-spec.test.ts test/gfm-spec.test.ts test/commonmark-spec.test.ts`
Expected: PASS. A failing case is evidence: compare our AST against the expected HTML and fix the PARSER (Tasks 1–3) when the structure differs, the ORACLE when only spelling differs. Ledger each such fix as a ruling naming the case.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/gfm-footnotes test/helpers/gfm-suite.ts test/helpers/md-html.ts test/gfm-footnotes-spec.test.ts src
git commit -m "test(v9j3.3.1): cmark-gfm's footnote examples as the oracle"
```

---

### Task 5: Engine — repeated citations and `notesAsTrailing`

**Files:**
- Modify: `src/flownotes.ts` (`NoteRef.repeatOf`, `NoteNumberer`, `lowerNotes`, `notesAsTrailing`)
- Modify: `src/flow.ts` (`commitRefs`: skip repeats for tagging and endnotes)
- Modify: `test/flownotes-lower.test.ts`, `test/flow-notes-review.test.ts` (superseded cases)
- Test: `test/flownotes-repeat.test.ts` (create)

**Interfaces:**
- Produces: `NoteRef.repeatOf?: NoteRef`; `export function notesAsTrailing(elements: FlowElement[], foot: ResolvedNoteOptions, end: ResolvedNoteOptions, makeBody: BodyMaker): FlowElement[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/flownotes-repeat.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph } from '../src/flow.js';
import { notesAsTrailing, normalizeNoteOptions } from '../src/flownotes.js';
import { placeElements } from '../src/flowplace.js';
import type { StructElement } from '../src/struct.js';

const pageOf = (pages: { GetText(): string }[], s: string) => pages.findIndex((p) => p.GetText().includes(s));
const count = (t: string, s: string) => t.split(s).length - 1;

describe('a repeated citation', () => {
  it('draws the same mark at every citation and the note once', () => {
    const note = { content: 'ONLYONCE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: note }, { text: ' b' }, { text: '', footnote: note }]);
    flow.AddParagraph([{ text: 'c' }, { text: '', footnote: note }]);
    const [p] = flow.Render();
    expect(count(p.GetText(), 'ONLYONCE')).toBe(1);
    expect(p.GetTextFragments().filter((f) => f.text.trim() === '1').length).toBe(4);   // 3 marks + the gutter
  });
  it('places the note with its FIRST citation', () => {
    const note = { content: 'FIRSTPAGE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: note }]);
    flow.AddColumnBreak();
    flow.AddParagraph([{ text: 'b' }, { text: '', footnote: note }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'FIRSTPAGE')).toBe(0);
  });
  it('makes one /Note in a tagged flow', () => {
    const doc = Document.New();
    const note = { content: 'n' };
    const flow = doc.NewFlow({ tagged: true });
    flow.AddParagraph([{ text: 'a' }, { text: '', footnote: note }, { text: ' b' }, { text: '', footnote: note }]);
    flow.Render();
    const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
    expect(all(doc.GetStructTree()!).filter((e) => e.Type === 'Note')).toHaveLength(1);
  });
  it('a repeated endnote is listed once', () => {
    const note = { content: 'ENDONCE' };
    const flow = Document.New().NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', endnote: note }, { text: ' b' }, { text: '', endnote: note }]);
    expect(count(flow.Render()[0].GetText(), 'ENDONCE')).toBe(1);
  });
});

describe('notesAsTrailing', () => {
  const foot = normalizeNoteOptions(undefined, 'footnote');
  const end = normalizeNoteOptions(undefined, 'endnote');
  const mk = (t: string, s: number) => paragraph(t, { fontSize: s });
  it('numbers, detaches, and appends the notes after the content', () => {
    const els = paragraph([{ text: 'body' }, { text: '', footnote: { content: 'TRAIL' } }]);
    const out = notesAsTrailing(els, foot, end, mk);
    expect(out.length).toBeGreaterThan(els.length);
    expect(out.flatMap((e) => e.noteRefs?.() ?? [])).toEqual([]);
    const doc = Document.New();
    const page = doc.AddPage().page;
    placeElements(doc, page, out, [72, 72, 400, 700]);
    const f = page.GetTextFragments();
    expect(f.find((x) => x.text.includes('TRAIL'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('body'))!.quad[1]);
  });
  it('returns the elements unchanged when nothing cites a note', () => {
    const els = paragraph('plain');
    expect(notesAsTrailing(els, foot, end, mk)).toBe(els);
  });
  it('lists footnotes before endnotes, a repeat once', () => {
    const n = { content: 'FN' };
    const els = paragraph([{ text: 'x' }, { text: '', endnote: { content: 'EN' } }, { text: '', footnote: n }, { text: '', footnote: n }]);
    const doc = Document.New();
    const page = doc.AddPage().page;
    placeElements(doc, page, notesAsTrailing(els, foot, end, mk), [72, 72, 400, 700]);
    const t = page.GetText();
    expect(t.indexOf('FN')).toBeLessThan(t.indexOf('EN'));
    expect(count(t, 'FN')).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/flownotes-repeat.test.ts`
Expected: FAIL (a second citation throws; `notesAsTrailing` missing).

- [ ] **Step 3: Implement**

`src/flownotes.ts`:
- Module doc: replace the "cited ONCE per Render" invariant with: "**Invariant:** a `FlowNote` cited several times is numbered and placed by its FIRST citation in queue order; every later citation is a REPEAT — the same mark, an empty body, `repeatOf` set — so it reserves no foot room, commits nothing and is never tagged (GitHub's footnote model, `v9j3.3.1`)."
- `NoteRef`: add `/** The first citation of the same note, for a repeated citation. */ repeatOf?: NoteRef;`.
- `checkNote`: delete the `seen` parameter use and the "referenced only once" throw; `lowerNotes` drops its `seen` set.
- `NoteNumberer`: replace `cited` with `private readonly firsts = new Map<FlowNote, NoteRef>();` and at the top of `assign`, after the idempotence check:

```ts
    const prior = this.firsts.get(ref.note);
    if (prior !== undefined) {
      const o = ref.kind === 'footnote' ? this.foot : this.end;
      ref.mark = prior.mark;
      ref.markRun.text = prior.mark;
      ref.markRun.fontSize = ref.baseSize * o.markScale;
      ref.markRun.rise = ref.baseSize * MARK_RISE;
      ref.repeatOf = prior;
      return;                                   // body stays []
    }
    this.firsts.set(ref.note, ref);
```

- `notesAsTrailing` (import `rule` from `flowblock.js` beside `fillRect`):

```ts
/** Notes for a SINGLE RECT (`page.AddMarkdown`), which has no column foot and
 *  no next column: number every reference in `elements`, DETACH each (delete
 *  the symbol key from its mark run, which the lowering owns) so
 *  `placeElements` stops refusing, and append the notes after the content —
 *  footnotes, then endnotes, each note once — under the footnote separator.
 *  Numbering is per call. Returns `elements` itself when nothing cites a note. */
export function notesAsTrailing(
  elements: FlowElement[], foot: ResolvedNoteOptions, end: ResolvedNoteOptions, makeBody: BodyMaker,
): FlowElement[] {
  const refs = elements.flatMap((e) => e.noteRefs?.() ?? []);
  if (refs.length === 0) return elements;
  const nb = new NoteNumberer(foot, end, makeBody);
  for (const r of refs) nb.assign(r);
  for (const r of refs) delete (r.markRun as Partial<MarkRun>)[NOTE];
  const firsts = refs.filter((r) => r.repeatOf === undefined);
  const out = [...elements];
  const sep = foot.separator;
  if (sep !== undefined)
    out.push(...rule({ thickness: sep.thickness, color: sep.color, width: sep.width, spaceBefore: foot.spacing }));
  for (const r of firsts) if (r.kind === 'footnote') out.push(...r.body);
  for (const r of firsts) if (r.kind === 'endnote') out.push(...r.body);
  return out;
}
```

(`rule()`'s `width` is optional; when `sep.width` is undefined it draws the full width — pass `width: sep.width` only when defined.)

`src/flow.ts` `commitRefs`: tag only `refs.filter((r) => r.repeatOf === undefined)`, and push endnotes only when `r.repeatOf === undefined`.

Superseded tests: in `test/flownotes-lower.test.ts`, the case "refuses a FlowNote referenced twice within one run list" becomes "lowers a FlowNote cited twice in one run list into two refs" (assert `refsIn(out)` has length 2, both `note` identical). In `test/flow-notes-review.test.ts`, "one FlowNote cited twice in ONE flow is still refused" becomes "…renders the note once" (assert the note text occurs once). Note both in the ledger as superseded by the spec.

- [ ] **Step 4: Run to verify they pass, plus the engine suite**

Run: `npx vitest run test/flownotes-repeat.test.ts test/flownotes-lower.test.ts test/flownotes-number.test.ts test/flownotes-column.test.ts test/flow-footnotes.test.ts test/flow-endnotes.test.ts test/flow-notes-tagged.test.ts test/flow-notes-review.test.ts test/flow-notes-protocol.test.ts test/import-cycles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flownotes.ts src/flow.ts test/flownotes-repeat.test.ts test/flownotes-lower.test.ts test/flow-notes-review.test.ts
git commit -m "feat(v9j3.3.1): repeated note citations and notes in a single rect"
```

---

### Task 6: The mapping and the entry points

**Files:**
- Modify: `src/mdstyle.ts` (`MarkdownStyle.footnoteSize`, `ResolvedMarkdownStyle.footnoteSize`, `noteStyle`)
- Modify: `src/mdruns.ts` (`RunContext.note`, `noteRefusal`; the `footnote_reference` case; `plainText`)
- Modify: `src/mdflow.ts` (`MarkdownFlowOptions.footnotePlacement`, `Ctx.notes`/`inNote`, note map, resolvers, skipped ordering)
- Modify: `src/page.ts` (`AddMarkdown` → `notesAsTrailing`), `src/document.ts` (`AddMarkdown` forwards `footnoteSize` to the flow's note options)
- Test: `test/markdown-footnotes.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 AST, Task 5 engine.
- Produces: `MarkdownFlowOptions.footnotePlacement?: 'foot' | 'end'`; `MarkdownStyle.footnoteSize?: number`.

- [ ] **Step 1: Write the failing tests**

```ts
// test/markdown-footnotes.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { StructElement } from '../src/struct.js';

const pageOf = (pages: { GetText(): string }[], s: string) => pages.findIndex((p) => p.GetText().includes(s));
const count = (t: string, s: string) => t.split(s).length - 1;
const render = (src: string, o: object = {}) => Document.New().AddMarkdown(src, { gfm: true, ...o });

describe('Markdown footnotes through doc.AddMarkdown', () => {
  it('draws the mark and places the note at the page foot', () => {
    const { pages, skipped } = render('A claim.[^1]\n\n[^1]: The SOURCE.\n');
    const f = pages[0].GetTextFragments();
    const body = f.find((x) => x.text.includes('claim'))!;
    const note = f.find((x) => x.text.includes('SOURCE'))!;
    expect(note.quad[1]).toBeLessThan(body.quad[1]);
    expect(note.quad[1]).toBeLessThan(200);
    expect(note.fontSize).toBeCloseTo(8, 1);
    expect(skipped).toEqual([]);
  });
  it("footnotePlacement 'end' makes endnotes after the content", () => {
    const { pages } = render('A.[^1]\n\nclosing paragraph\n\n[^1]: ENDTEXT\n', { footnotePlacement: 'end' });
    const f = pages[0].GetTextFragments();
    expect(f.find((x) => x.text.includes('ENDTEXT'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('closing'))!.quad[1]);
    expect(f.some((x) => x.text === 'i')).toBe(true);
  });
  it('a repeated citation draws one note', () => {
    const { pages } = render('a[^x] b[^x]\n\n[^x]: REPEATED\n');
    expect(count(pages[0].GetText(), 'REPEATED')).toBe(1);
  });
  it('a note may hold a list and code', () => {
    const { pages } = render('t[^n]\n\n[^n]: intro\n\n    - alpha\n    - beta\n\n        codeline\n');
    const t = pages[0].GetText();
    for (const s of ['alpha', 'beta', 'codeline']) expect(t).toContain(s);
  });
  it('footnoteSize sets the note body size', () => {
    const { pages } = render('t[^n]\n\n[^n]: SIZED\n', { style: { footnoteSize: 6 } });
    expect(pages[0].GetTextFragments().find((x) => x.text.includes('SIZED'))!.fontSize).toBeCloseTo(6, 1);
  });
  it('a mark in bold text is bold', () => {
    const { pages } = render('**strong[^b]**\n\n[^b]: n\n');
    const mark = pages[0].GetTextFragments().find((x) => x.text === '1' && x.quad[1] > 400)!;
    expect(mark.fontName).toMatch(/Bold/);
  });
  it('a citation in a table cell is literal and reported', () => {
    const { pages, skipped } = render('t[^a]\n\n| h |\n| - |\n| c[^a] |\n\n[^a]: n\n');
    expect(pages[0].GetText()).toContain('[^a]');
    expect(skipped).toContain('footnote (table cell)');
  });
  it('a citation inside a note is literal and reported', () => {
    const { pages, skipped } = render('t[^a]\n\n[^a]: see[^b]\n[^b]: B\n');
    expect(pages[0].GetText()).toContain('[^b]');
    expect(skipped).toContain('footnote (nested)');
  });
  it('an undefined reference is drawn literally and not reported (Review Focus 5)', () => {
    const { pages, skipped } = render('x[^nope] y\n');
    expect(pages[0].GetText()).toContain('[^nope]');
    expect(skipped).toEqual([]);
  });
  it('a citation in a heading, a quote and a list item (Review Focus 2, 4)', () => {
    const { pages } = render('# Title[^h]\n\n> quoted[^q]\n\n- item[^l]\n\n[^h]: HNOTE\n[^q]: QNOTE\n[^l]: LNOTE\n');
    const t = pages[0].GetText();
    for (const s of ['HNOTE', 'QNOTE', 'LNOTE']) expect(t).toContain(s);
  });
  it('fifty footnotes all render in order (Review Focus 1)', () => {
    const body = Array.from({ length: 50 }, (_, i) => `p${i}[^n${i}]`).join('\n\n');
    const defs = Array.from({ length: 50 }, (_, i) => `[^n${i}]: NOTE${i}X`).join('\n');
    const { pages } = render(`${body}\n\n${defs}\n`);
    const all = pages.map((p) => p.GetText()).join('\n');
    for (let i = 0; i < 50; i++) expect(all).toContain(`NOTE${i}X`);
    expect(all.indexOf('NOTE0X')).toBeLessThan(all.indexOf('NOTE49X'));
  });
  it('tagged: one /Note per definition, inside the citing /P', () => {
    const doc = Document.New();
    doc.AddMarkdown('a[^x] b[^x]\n\n[^x]: n\n', { gfm: true, tagged: true });
    const all = (el: { Children: StructElement[] }): StructElement[] => el.Children.flatMap((c) => [c, ...all(c)]);
    const notes = all(doc.GetStructTree()!).filter((e) => e.Type === 'Note');
    expect(notes).toHaveLength(1);
    expect(notes[0].Parent!.Type).toBe('P');
  });
  it('gfm off: [^1] is ordinary text and output matches an unfootnoted render', () => {
    const { pages } = Document.New().AddMarkdown('a[^1]\n\n[^1]: n\n');
    expect(pages[0].GetText()).toContain('[^1]');
  });
  it('refuses a bad footnotePlacement and footnoteSize before allocating', () => {
    expect(() => render('x', { footnotePlacement: 'side' })).toThrow(TypeError);
    expect(() => render('x', { style: { footnoteSize: 0 } })).toThrow(TypeError);
  });
});

describe('page.AddMarkdown', () => {
  it('places the notes after the content inside the rect', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r = page.AddMarkdown('A claim.[^1]\n\n[^1]: RECTNOTE\n', [72, 72, 400, 700], { gfm: true });
    const f = page.GetTextFragments();
    expect(f.find((x) => x.text.includes('RECTNOTE'))!.quad[1]).toBeLessThan(f.find((x) => x.text.includes('claim'))!.quad[1]);
    expect(r.remainder).toEqual([]);
  });
  it('notes that do not fit come back in the remainder', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const r = page.AddMarkdown('A.[^1]\n\n[^1]: ' + 'word '.repeat(400) + '\n', [72, 600, 400, 40], { gfm: true });
    expect(r.remainder.length).toBeGreaterThan(0);
  });
});
```

Check `TextFragment.fontName` exists (it does, `text.ts` ~1117) and that a bold Standard-14 mark reports a `/BaseFont` containing `Bold`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/markdown-footnotes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/mdstyle.ts`:
- `MarkdownStyle.footnoteSize?: number` — "Footnote and endnote body size (points). > 0. Default 8, the Flow engine's own default."
- `ResolvedMarkdownStyle.footnoteSize: number`, resolved with `pos(style.footnoteSize, 8, 'footnoteSize')`.
- `export function noteStyle(st: ResolvedMarkdownStyle): ResolvedMarkdownStyle` — `k = st.footnoteSize / st.fontSize`; returns a copy with `fontSize = st.footnoteSize`, and `leading`, `paragraphSpacing`, `heading.sizes`, `heading.spaceBefore/After`, `code.fontSize`, `code.padding`, `code.spaceBefore/After`, `quote.indent`, `quote.spaceBefore/After`, `list.itemSpacing`, `list.spaceBefore/After`, `list.indent` (when defined), `table.fontSize`, `table.padding`, `table.spaceBefore/After`, `rule.spaceBefore/After`, `image.spaceBefore/After` each multiplied by `k`. Ratios (`code.sizeRatio`) and colours unchanged.

`src/mdruns.ts`:

```ts
import type { MdFootnoteReference } from './mdast.js';
import type { FlowNote, FlowTextRun } from './flownotes.js';

/** How a footnote citation becomes a note (v9j3.3.1). ABSENT where a citation
 *  cannot be honoured — a table cell, a note body — and then the citation is
 *  drawn as its literal `[^label]` and reported as `noteRefusal`. */
export type NoteResolver = (n: MdFootnoteReference) => { kind: 'footnote' | 'endnote'; note: FlowNote } | undefined;
// RunContext gains:
//   note?: NoteResolver;
//   noteRefusal?: string;   // the `skipped` entry when `note` is absent
// InlineContent.runs becomes FlowTextRun[].
```

In `inlineRuns`' walk:

```ts
        case 'footnote_reference': {
          const r = ctx.note?.(n);
          if (r === undefined) {
            push(`[^${n.label}]`, s);
            skipped.push(ctx.noteRefusal ?? 'footnote');
            break;
          }
          // An empty run CARRYING the note: the engine draws the mark after
          // it, in this run's style, so a mark in bold text is bold. A merge
          // barrier both ways — text before must not be absorbed into it, and
          // text after must not be appended to it, or the mark would follow
          // that text instead.
          out.push({ text: '', ...runProps(s, style, ctx), [r.kind]: r.note });
          lastKey = undefined;
          break;
        }
```

`plainText`: `case 'footnote_reference': break;`.

`src/mdflow.ts`:
- `MarkdownFlowOptions.footnotePlacement?: 'foot' | 'end'` — "Where GFM footnotes go (v9j3.3.1): `'foot'` (default) at the foot of the column citing them, `'end'` as endnotes after the content, as GitHub renders them."
- `Ctx` gains `notes?: Map<number, FlowNote>; inNote?: boolean;`.
- `function noteResolver(c: Ctx): NoteResolver | undefined` — `undefined` when `c.notes === undefined || c.inNote`; else `(ref) => { const note = c.notes!.get(ref.index); return note === undefined ? undefined : { kind: c.opts.footnotePlacement === 'end' ? 'endnote' : 'footnote', note }; }`.
- Every `inlineRuns` call in `paragraphElements` (main path), `headingElements` and `itemNode` adds `note: noteResolver(c), noteRefusal: c.inNote ? 'footnote (nested)' : undefined`. The lone-image alt fallback path adds nothing (alt text holds no citation). `mdTable`'s cell call adds `noteRefusal: 'footnote (table cell)'` and no `note`.
- In `markdownElements`, after `st` is resolved and before mapping: validate `footnotePlacement` (`undefined | 'foot' | 'end'`, else `TypeError('footnotePlacement must be \'foot\' or \'end\'')`); then

```ts
  const c: Ctx = { st, opts: options, skipped: [] };
  const noteSkipped: string[] = [];
  if (doc.footnotes !== undefined) {
    // One FlowNote per cited definition, built once, so repeated citations
    // share it. Its body goes through the SAME blockElements a top-level block
    // does, at the note size, with citations inside it refused (no nesting).
    // Note-body reports are kept apart and appended after the main body's, so
    // `skipped` stays in document order — the notes come last.
    const nc: Ctx = { st: noteStyle(st), opts: options, skipped: noteSkipped, inNote: true };
    c.notes = new Map(doc.footnotes.map((d) => [d.index, { content: blockElements(d.children, nc, 0) }]));
  }
  const elements = blockElements(doc.children, c, 0);
  c.skipped.push(...noteSkipped);
```

`src/page.ts` `AddMarkdown`: after `markdownElements`, replace `elements` passed to `placeElements` with

```ts
    const placed = notesAsTrailing(elements,
      normalizeNoteOptions({ fontSize: options.style?.footnoteSize }, 'footnote'),
      normalizeNoteOptions({ fontSize: options.style?.footnoteSize }, 'endnote'),
      (t, fontSize) => paragraph(t, { fontSize }));
```

(import `notesAsTrailing`, `normalizeNoteOptions` from `flownotes.js` and `paragraph` from `flow.js`. Verified: `flow.ts` imports `Page` as a TYPE only and `page.ts` already reaches `flow.ts` through `mdflow.ts`, so the direct edge closes no 2-cycle — `test/import-cycles.test.ts` confirms.)

`src/document.ts` `AddMarkdown`: before `new Flow(this, options)`, forward the note size so the gutter mark matches the body:

```ts
    const size = options.style?.footnoteSize;
    const flowOptions = size === undefined ? options : {
      ...options,
      footnotes: { fontSize: size, ...options.footnotes },
      endnotes: { fontSize: size, ...options.endnotes },
    };
    const flow = new Flow(this, flowOptions);
```

- [ ] **Step 4: Run to verify they pass, plus the Markdown fences**

Run: `npx vitest run test/markdown-footnotes.test.ts test/markdown-flow.test.ts test/markdown-squeeze.test.ts test/markdown-pdfua.test.ts test/gfm-footnotes-spec.test.ts test/import-cycles.test.ts`
Then: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mdstyle.ts src/mdruns.ts src/mdflow.ts src/page.ts src/document.ts test/markdown-footnotes.test.ts
git commit -m "feat(v9j3.3.1): render Markdown footnotes through the Flow engine"
```

---

### Task 7: Docs, mutation sweep, verification

**Files:**
- Modify: `README.md` (the Markdown capability line, an example, `MarkdownFlowOptions`/`MarkdownStyle` rows, `parseMarkdown` row mentions footnotes, Scope and Limitations; drop "a `FlowNote` object may be cited only once per flow")
- Modify: `CHANGELOG.md` (`### Added` entry for Markdown footnotes; amend the v9j3.3 entry's "cited once" sentence; a `### Changed` line: a `FlowNote` may now be cited repeatedly)
- Modify: `CLAUDE.md` (the `markdown.ts…mdgfm.ts` entry: footnotes as the sixth extension and its invariants; the `flownotes.ts` entry: repeated citations and `notesAsTrailing`; the fixtures table: `fixtures/gfm-footnotes/`)
- Modify: `docs/superpowers/specs/2026-10-07-markdown-footnotes-design.md` (the `footnotePlacement` rename)
- Modify: `test/fixtures/gfm-footnotes/PROVENANCE.md` ("Measured" section)

- [ ] **Step 1: Mutation sweep** (harness at the scratchpad `mut.cjs` pattern: strip ANSI, trust the exit status, verify each pattern applies exactly once). Mutations, each expected RED:
1. `FOOTNOTE_DEF` drops the trailing `[ \t]*` → corpus `other-note` case.
2. `matchContinuation` footnote case: `CODE_INDENT` → 2 → corpus blockquote case.
3. `tryStart`: footnote branch moved after list items → hand-built "interrupts a paragraph"? (record whatever reddens).
4. `parseCloseBracket`: `raw.length > 1` → `> 0` → `[^]` unit case.
5. `parseBang` guard removed → `![^1]` unit case.
6. `resolveFootnotes`: number in definition-collection order instead of citation order → corpus.
7. `resolveFootnotes`: last definition wins → unit case.
8. `resolveFootnotes`: unmatched reference dropped instead of literal → corpus `[^nope]`.
9. `resolveFootnotes`: walk definitions AFTER the main text (not in place) → the tree-order unit case.
10. md-html backref inside the last paragraph only → corpus code-block case.
11. `NoteNumberer`: repeat gets a fresh number → `flownotes-repeat`.
12. `commitRefs`: tag repeats too → tagged repeat case.
13. `notesAsTrailing`: no detach → `page.AddMarkdown` throws.
14. `mdruns`: barrier `lastKey = undefined` removed → a mark-after-text case (add one if green: `a[^1]b` must draw `b` AFTER the mark).
15. `mdflow`: table cell gets the resolver → table-cell case (engine throws).
Record results in the CLAUDE.md entry and PROVENANCE's "Measured" section, naming any rule held only by a hand-built case and any equivalent mutant.

- [ ] **Step 2: Docs** per the Files list, house style: bold lead-ins, what it does and why, the issue id. README example:

```ts
doc.AddMarkdown(
  'Coverage is uneven.[^survey]\n\n[^survey]: Field notes, 2024 — *vol. 2*.\n',
  { gfm: true, footnotePlacement: 'foot', style: { footnoteSize: 8 } },
);
```

Run `npx vitest run test/readme-api.test.ts` and copy any count it reports. Run the CLAUDE.md module sweep; it must print nothing.

- [ ] **Step 3: Full verification**

Run: `npm run typecheck` then `npm test`
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md CLAUDE.md docs/superpowers/specs/2026-10-07-markdown-footnotes-design.md test/fixtures/gfm-footnotes/PROVENANCE.md
git commit -m "docs(v9j3.3.1): Markdown footnotes — README, CHANGELOG, CLAUDE.md"
```
