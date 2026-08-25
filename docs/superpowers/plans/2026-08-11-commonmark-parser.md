# CommonMark Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse Markdown text into a CommonMark abstract syntax tree, conforming to CommonMark 0.31.2 and verified against all 652 cases of the official suite with no allowlist.

**Architecture:** The spec's Appendix A two-phase algorithm. A **block phase** walks lines maintaining a stack of open blocks (matching open blocks, opening new containers, attaching a remainder to a leaf); an **inline phase** then runs over each leaf's accumulated raw text using a delimiter stack for emphasis and a bracket stack for links. Six new `src/` modules plus two generated data tables. No PDF is produced — the deliverable is a tree.

**Tech Stack:** TypeScript (strict, ESM/NodeNext), vitest, zero runtime dependencies. Data generators are `node:https` + `node:fs` scripts run by hand, never at build time.

**Spec:** `docs/superpowers/specs/2026-08-11-commonmark-parser-design.md`

**Issue:** `aspose-pdf-foss-for-ts-gl6o.1` (claimed). Close it in Task 14.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. The parser modules import nothing outside `src/`.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { MdNode } from './mdast.js'`.
- **`strict` TypeScript.** `npm run typecheck` must stay clean after every task.
- **CommonMark version is 0.31.2.** Not 0.30. The two differ in the definition of a punctuation character, which changes emphasis flanking.
- **No source positions on nodes**, **no options parameter** on `parseMarkdown`. Both are deliberate omissions recorded in the spec; do not add them.
- **No GFM.** Tables, strikethrough, task lists and extended autolinks are `gl6o.2`. Do not implement them, and do not add hooks for them.
- **Errors:** the parser never throws. Markdown has no invalid input — every byte sequence is a valid document. This is unlike the rest of `src/`, which throws `PdfParseError`.
- **Test command:** `npx vitest run test/<name>.test.ts` for one file, `npm test` for all.
- **Commit style:** conventional prefix + `(md)` scope, e.g. `feat(md): block phase leaf blocks (gl6o.1)`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/mdast.ts` | Node model and type guards. Pure data; imports nothing. |
| `src/mdscan.ts` | Lexical scanners both phases share: HTML tag grammar, entity references, backslash escapes, link destination/title, label normalization, character classes. |
| `src/mdblock.ts` | Block phase: the open-block stack, container starts, leaf blocks, tabs, lazy continuation, list tightness. |
| `src/mdinline.ts` | Inline phase: code spans, the emphasis delimiter stack, the link/image bracket stack, autolinks, raw inline HTML, breaks. |
| `src/mdentity.ts` | Generated. The HTML5 named entity table. |
| `src/markdown.ts` | `parseMarkdown` — normalizes input, runs both phases, returns `MdDocument`. |
| `src/unicode-data.ts` | Regenerated with `unicodePunctuation`. |
| `scripts/gen-entities.mjs` | New. Emits `src/mdentity.ts` from WHATWG `entities.json`. |
| `scripts/gen-ucd.mjs` | Extended to emit the P\*/S\* table. |
| `test/helpers/spec-suite.ts` | Loads `spec.json`, groups cases by section. |
| `test/helpers/md-html.ts` | The HTML conformance oracle. Test-only; nothing in `src/` imports it. |
| `test/fixtures/commonmark/spec.json` | Vendored official suite + `PROVENANCE.md`. |

---

### Task 1: Vendor the spec suite and its loader

**Files:**
- Create: `test/fixtures/commonmark/spec.json`
- Create: `test/fixtures/commonmark/PROVENANCE.md`
- Create: `test/helpers/spec-suite.ts`
- Create: `test/commonmark-spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SpecCase { markdown: string; html: string; example: number; section: string; startLine: number }`, `loadSpecCases(): SpecCase[]`, `casesInSections(...sections: string[]): SpecCase[]`.

- [ ] **Step 1: Download the suite**

```bash
cd "s:/Aspose/PAS/gitlab.com/esopsa/pdf4ts/aspose-pdf-foss-for-ts"
mkdir -p test/fixtures/commonmark
curl -fsSL https://spec.commonmark.org/0.31.2/spec.json -o test/fixtures/commonmark/spec.json
```

If the machine has no network, the file is also produced by `python3 test/spec_tests.py --dump-tests` in a `commonmark/commonmark-spec` checkout at tag `0.31.2`. Do not hand-author it.

- [ ] **Step 2: Verify what arrived**

```bash
node -e "const c=require('./test/fixtures/commonmark/spec.json'); console.log(c.length, new Set(c.map(x=>x.section)).size, Object.keys(c[0]).join(','))"
sha256sum test/fixtures/commonmark/spec.json
wc -c test/fixtures/commonmark/spec.json
```

Expected: `652` cases, `26` distinct sections, keys `markdown,html,example,start_line,end_line,section`. **If the count is not 652, stop** — a different spec revision was fetched and every gate in this plan is calibrated to 0.31.2. Keep the sha256 and byte count for Step 4.

- [ ] **Step 3: Write the loader**

```ts
// test/helpers/spec-suite.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One example from the official CommonMark suite. */
export interface SpecCase {
  markdown: string;
  html: string;
  example: number;
  section: string;
  startLine: number;
}

interface RawCase {
  markdown: string; html: string; example: number; section: string; start_line: number;
}

const SPEC_URL = new URL('../fixtures/commonmark/spec.json', import.meta.url);

let cached: SpecCase[] | undefined;

/** All 652 cases, in spec order. */
export function loadSpecCases(): SpecCase[] {
  if (cached === undefined) {
    const raw: RawCase[] = JSON.parse(readFileSync(fileURLToPath(SPEC_URL), 'utf8'));
    cached = raw.map((c) => ({
      markdown: c.markdown, html: c.html, example: c.example,
      section: c.section, startLine: c.start_line,
    }));
  }
  return cached;
}

/** The cases belonging to the named sections. Throws if a name matches nothing,
 *  so a typo in a section gate fails loudly instead of vacuously passing. */
export function casesInSections(...sections: string[]): SpecCase[] {
  const all = loadSpecCases();
  const want = new Set(sections);
  for (const s of sections) {
    if (!all.some((c) => c.section === s)) throw new Error(`no spec section named ${JSON.stringify(s)}`);
  }
  return all.filter((c) => want.has(c.section));
}
```

- [ ] **Step 4: Write the failing test**

```ts
// test/commonmark-spec.test.ts
import { describe, it, expect } from 'vitest';
import { loadSpecCases, casesInSections } from './helpers/spec-suite.js';

describe('CommonMark spec suite', () => {
  it('loads all 652 official cases', () => {
    const cases = loadSpecCases();
    expect(cases.length).toBe(652);
    expect(new Set(cases.map((c) => c.section)).size).toBe(26);
  });

  it('numbers examples 1..652 with no gaps', () => {
    expect(loadSpecCases().map((c) => c.example)).toEqual(
      Array.from({ length: 652 }, (_, i) => i + 1),
    );
  });

  it('rejects a section name that does not exist', () => {
    expect(() => casesInSections('Tabs', 'Not A Section')).toThrow(/no spec section/);
  });

  it('selects by section', () => {
    const tabs = casesInSections('Tabs');
    expect(tabs.length).toBeGreaterThan(0);
    expect(tabs.every((c) => c.section === 'Tabs')).toBe(true);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: PASS. (This task vendors data rather than code, so the test confirms the fixture rather than driving an implementation.)

- [ ] **Step 6: Write PROVENANCE.md**

Fill the two placeholders from Step 2's output. Follow the house format of `test/fixtures/fonts/PROVENANCE.md`.

```markdown
# CommonMark spec suite — provenance

The official conformance suite for CommonMark, here to validate `parseMarkdown`
against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-11-commonmark-parser-design.md`.

**Source:** <https://spec.commonmark.org/0.31.2/spec.json>, the machine-readable
dump of the CommonMark 0.31.2 specification, published by the CommonMark project
(John MacFarlane et al., CC-BY-SA 4.0). Downloaded verbatim, not regenerated.

| File | Bytes | SHA-256 |
|---|---|---|
| `spec.json` | <BYTES FROM STEP 2> | `<SHA256 FROM STEP 2>` |

### Command

```bash
curl -fsSL https://spec.commonmark.org/0.31.2/spec.json -o test/fixtures/commonmark/spec.json
```

## Shape

A JSON array of 652 objects across 26 sections, each with `markdown` (the input),
`html` (the expected rendering), `example` (1-based index), `section`, and
`start_line`/`end_line` into the specification prose.

## What it covers

Every construct in CommonMark 0.31.2, including the ones a PDF renderer will
never draw — raw HTML blocks, HTML comments, processing instructions. The suite
is what catches the class a programmatic builder cannot: our parser and our own
expectations agreeing with each other and both disagreeing with CommonMark.

## What it does NOT cover

- **GFM.** No tables, strikethrough, task lists or extended autolinks. That is
  `gl6o.2`, which brings its own fixture.
- **The AST.** The expectations are HTML, so the suite is blind to every
  distinction the rendering collapses — list tightness above all, which drives
  paragraph spacing in Flow. `test/markdown-ast.test.ts` exists for exactly the
  gap this fixture leaves.
- **Robustness.** No case nests deeper than ten or exercises adversarial
  emphasis. `test/markdown-pathological.test.ts` covers that.
- **Rendering.** `test/helpers/md-html.ts` is a test-only oracle whose sole
  purpose is to make this fixture measurable. It is not a supported output
  format and nothing in `src/` imports it.
```

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/commonmark test/helpers/spec-suite.ts test/commonmark-spec.test.ts
git commit -m "$(cat <<'EOF'
test(md): vendor the CommonMark 0.31.2 spec suite (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The node model

**Files:**
- Create: `src/mdast.ts`
- Create: `test/markdown-ast.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the whole node union, consumed by every later task. Exact shapes below — later tasks construct these by hand, so the property names are load-bearing.

- [ ] **Step 1: Write the failing test**

```ts
// test/markdown-ast.test.ts
import { describe, it, expect } from 'vitest';
import { isMdBlock, isMdInline, isMdContainer, type MdDocument, type MdList } from '../src/mdast.js';

describe('mdast model', () => {
  it('classifies blocks and inlines', () => {
    expect(isMdBlock({ type: 'paragraph', children: [] })).toBe(true);
    expect(isMdBlock({ type: 'emph', children: [] })).toBe(false);
    expect(isMdInline({ type: 'emph', children: [] })).toBe(true);
    expect(isMdInline({ type: 'paragraph', children: [] })).toBe(false);
  });

  it('classifies containers — nodes whose children are blocks', () => {
    expect(isMdContainer({ type: 'document', children: [] })).toBe(true);
    expect(isMdContainer({ type: 'block_quote', children: [] })).toBe(true);
    expect(isMdContainer({ type: 'list', ordered: false, start: 1, delimiter: '-', tight: true, children: [] })).toBe(true);
    expect(isMdContainer({ type: 'item', children: [] })).toBe(true);
    expect(isMdContainer({ type: 'paragraph', children: [] })).toBe(false);
    expect(isMdContainer({ type: 'code_block', fenced: false, info: '', literal: '' })).toBe(false);
  });

  it('types a document tree end to end', () => {
    const list: MdList = {
      type: 'list', ordered: true, start: 3, delimiter: ')', tight: false,
      children: [{ type: 'item', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] }] }],
    };
    const doc: MdDocument = { type: 'document', children: [list] };
    expect(doc.children[0]).toBe(list);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/markdown-ast.test.ts`
Expected: FAIL — cannot resolve `../src/mdast.js`.

- [ ] **Step 3: Write the model**

```ts
// src/mdast.ts
/** The CommonMark abstract syntax tree, per CommonMark 0.31.2.
 *
 *  Pure data: this module imports nothing and allocates no PDF objects. Nodes
 *  carry no source positions — see the design note in
 *  docs/superpowers/specs/2026-08-11-commonmark-parser-design.md. */

export interface MdDocument { type: 'document'; children: MdBlock[]; }
export interface MdBlockQuote { type: 'block_quote'; children: MdBlock[]; }

/** `tight` decides whether an item's paragraphs render as paragraphs (loose) or
 *  as bare content (tight). It is invisible in most HTML renderings but drives
 *  paragraph spacing in Flow, so gl6o.3 depends on it. */
export interface MdList {
  type: 'list';
  ordered: boolean;
  /** The first ordered item's number; 1 for a bullet list. */
  start: number;
  /** The marker character: `-`, `+`, `*` for bullets; `.` or `)` for ordered. */
  delimiter: '-' | '+' | '*' | '.' | ')';
  tight: boolean;
  children: MdItem[];
}
export interface MdItem { type: 'item'; children: MdBlock[]; }

export interface MdParagraph { type: 'paragraph'; children: MdInline[]; }
/** Level 1..6, identical for the ATX (`# x`) and setext (`x\n=`) spellings. */
export interface MdHeading { type: 'heading'; level: number; children: MdInline[]; }
export interface MdThematicBreak { type: 'thematic_break'; }
/** `info` is the raw info string of a fenced block, entity-decoded and
 *  backslash-unescaped but not split on whitespace; '' for an indented block. */
export interface MdCodeBlock { type: 'code_block'; fenced: boolean; info: string; literal: string; }
/** Raw HTML, verbatim. gl6o.3 will drop these; the spec suite renders them. */
export interface MdHtmlBlock { type: 'html_block'; literal: string; }

export interface MdText { type: 'text'; value: string; }
export interface MdSoftBreak { type: 'softbreak'; }
export interface MdHardBreak { type: 'linebreak'; }
export interface MdEmph { type: 'emph'; children: MdInline[]; }
export interface MdStrong { type: 'strong'; children: MdInline[]; }
export interface MdCode { type: 'code'; value: string; }
/** Inline and reference links are indistinguishable here: both carry a resolved
 *  destination and title, which is what gl6o.3 wants. */
export interface MdLink { type: 'link'; destination: string; title: string; children: MdInline[]; }
export interface MdImage { type: 'image'; destination: string; title: string; children: MdInline[]; }
export interface MdHtmlInline { type: 'html_inline'; literal: string; }

export type MdBlock =
  | MdDocument | MdBlockQuote | MdList | MdItem
  | MdParagraph | MdHeading | MdThematicBreak | MdCodeBlock | MdHtmlBlock;

export type MdInline =
  | MdText | MdSoftBreak | MdHardBreak
  | MdEmph | MdStrong | MdCode | MdLink | MdImage | MdHtmlInline;

export type MdNode = MdBlock | MdInline;

const BLOCK_TYPES = new Set<string>([
  'document', 'block_quote', 'list', 'item',
  'paragraph', 'heading', 'thematic_break', 'code_block', 'html_block',
]);
/** Blocks whose children are themselves blocks. */
const CONTAINER_TYPES = new Set<string>(['document', 'block_quote', 'list', 'item']);

export function isMdBlock(n: { type: string }): n is MdBlock { return BLOCK_TYPES.has(n.type); }
export function isMdInline(n: { type: string }): n is MdInline { return !BLOCK_TYPES.has(n.type); }
export function isMdContainer(n: { type: string }): boolean { return CONTAINER_TYPES.has(n.type); }
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run test/markdown-ast.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/mdast.ts test/markdown-ast.test.ts
git commit -m "$(cat <<'EOF'
feat(md): CommonMark node model (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The HTML conformance oracle

The oracle decides whether every later gate is meaningful, so it is tested
against hand-built trees **before** any parser exists. A broken oracle makes the
652-case suite green for the wrong reasons.

**Files:**
- Create: `test/helpers/md-html.ts`
- Create: `test/md-html-oracle.test.ts`

**Interfaces:**
- Consumes: `MdDocument`, the node union from `src/mdast.ts`.
- Produces: `renderHtml(doc: MdDocument): string`.

- [ ] **Step 1: Write the failing test**

The expected strings below are the spec's own rendering conventions: a trailing
newline after each block, `<li>` content inline when the list is tight,
destinations percent-encoded and `&`/`<`/`>`/`"` escaped in text and attributes.

```ts
// test/md-html-oracle.test.ts
import { describe, it, expect } from 'vitest';
import { renderHtml } from './helpers/md-html.js';
import type { MdDocument } from '../src/mdast.js';

const doc = (...children: MdDocument['children']): MdDocument => ({ type: 'document', children });

describe('md-html oracle', () => {
  it('renders a paragraph', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [{ type: 'text', value: 'hi' }] })))
      .toBe('<p>hi</p>\n');
  });

  it('escapes text but not the tags around it', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [{ type: 'text', value: 'a<b & "c"' }] })))
      .toBe('<p>a&lt;b &amp; &quot;c&quot;</p>\n');
  });

  it('renders headings, thematic breaks and raw HTML blocks', () => {
    expect(renderHtml(doc({ type: 'heading', level: 3, children: [{ type: 'text', value: 'x' }] })))
      .toBe('<h3>x</h3>\n');
    expect(renderHtml(doc({ type: 'thematic_break' }))).toBe('<hr />\n');
    expect(renderHtml(doc({ type: 'html_block', literal: '<div>\n' }))).toBe('<div>\n');
  });

  it('renders a fenced code block with its info language', () => {
    expect(renderHtml(doc({ type: 'code_block', fenced: true, info: 'ts run', literal: 'a & b\n' })))
      .toBe('<pre><code class="language-ts">a &amp; b\n</code></pre>\n');
    expect(renderHtml(doc({ type: 'code_block', fenced: false, info: '', literal: 'x\n' })))
      .toBe('<pre><code>x\n</code></pre>\n');
  });

  it('renders a tight list with bare item content and a loose one with paragraphs', () => {
    const item = { type: 'item', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a' }] }] } as const;
    expect(renderHtml(doc({ type: 'list', ordered: false, start: 1, delimiter: '-', tight: true, children: [item] })))
      .toBe('<ul>\n<li>a</li>\n</ul>\n');
    expect(renderHtml(doc({ type: 'list', ordered: false, start: 1, delimiter: '-', tight: false, children: [item] })))
      .toBe('<ul>\n<li>\n<p>a</p>\n</li>\n</ul>\n');
  });

  it('emits start only when an ordered list does not start at 1', () => {
    const item = { type: 'item', children: [] } as const;
    expect(renderHtml(doc({ type: 'list', ordered: true, start: 1, delimiter: '.', tight: true, children: [item] })))
      .toBe('<ol>\n<li></li>\n</ol>\n');
    expect(renderHtml(doc({ type: 'list', ordered: true, start: 7, delimiter: '.', tight: true, children: [item] })))
      .toBe('<ol start="7">\n<li></li>\n</ol>\n');
  });

  it('renders inline emphasis, code, breaks and raw HTML', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'emph', children: [{ type: 'text', value: 'a' }] },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'code', value: 'c<d' },
      { type: 'softbreak' },
      { type: 'linebreak' },
      { type: 'html_inline', literal: '<br>' },
    ] }))).toBe('<p><em>a</em><strong>b</strong><code>c&lt;d</code>\n<br />\n<br></p>\n');
  });

  it('percent-encodes a destination and escapes its markup', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'link', destination: '/a b?x=1&y=2', title: 'T"t', children: [{ type: 'text', value: 'L' }] },
    ] }))).toBe('<p><a href="/a%20b?x=1&amp;y=2" title="T&quot;t">L</a></p>\n');
  });

  it('renders an image with alt text flattened from its children', () => {
    expect(renderHtml(doc({ type: 'paragraph', children: [
      { type: 'image', destination: '/i.png', title: '', children: [
        { type: 'text', value: 'a' },
        { type: 'emph', children: [{ type: 'text', value: 'b' }] },
        { type: 'code', value: 'c' },
      ] },
    ] }))).toBe('<p><img src="/i.png" alt="abc" /></p>\n');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/md-html-oracle.test.ts`
Expected: FAIL — cannot resolve `./helpers/md-html.js`.

- [ ] **Step 3: Implement the oracle**

Rules the implementation must follow, each visible in a test above:

1. Every block emits a trailing `\n`; `html_block` emits its literal verbatim (it already ends in `\n`).
2. Text escapes `&` `<` `>` `"` — and only those four.
3. A destination is percent-encoded for every byte outside the spec's safe set, then attribute-escaped. Encode with `encodeURI`, then re-encode `[` `]` and `"`, and leave an existing valid `%XX` triple alone — double-encoding `%20` into `%2520` is the classic failure.
4. `class="language-X"` uses the **first whitespace-delimited word** of `info`, omitted when `info` is empty.
5. A tight list's `<li>` renders its paragraphs' children with no `<p>`; a loose list wraps them.
6. `start` appears on `<ol>` only when it is not 1.
7. `softbreak` is `\n`; `linebreak` is `<br />\n`.
8. An image's `alt` is the concatenated **text** of its descendants — `text` and `code` values, recursively through `emph`/`strong`/`link`, with `softbreak` as a space and `html_inline` contributing nothing.

```ts
// test/helpers/md-html.ts
import type { MdBlock, MdDocument, MdInline } from '../../src/mdast.js';

/** Render an AST to the HTML the CommonMark suite expects.
 *
 *  TEST-ONLY. This exists so that conformance is measurable; HTML is not a
 *  supported output of this library and nothing in src/ imports this file. */
export function renderHtml(doc: MdDocument): string { /* per the rules above */ }
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/md-html-oracle.test.ts`
Expected: PASS, all nine.

- [ ] **Step 5: Commit**

```bash
git add test/helpers/md-html.ts test/md-html-oracle.test.ts
git commit -m "$(cat <<'EOF'
test(md): HTML conformance oracle, verified against hand-built trees (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The HTML5 entity table

**Files:**
- Create: `scripts/gen-entities.mjs`
- Create: `src/mdentity.ts` (generated — run the script, commit the output)
- Create: `test/mdentity.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `namedEntity(name: string): string | undefined`, where `name` excludes both `&` and `;` (`namedEntity('copy') === '\u00a9'`).

- [ ] **Step 1: Write the failing test**

```ts
// test/mdentity.test.ts
import { describe, it, expect } from 'vitest';
import { namedEntity } from '../src/mdentity.js';

describe('HTML5 named entities', () => {
  it('resolves the common ones', () => {
    expect(namedEntity('copy')).toBe('\u00a9');
    expect(namedEntity('amp')).toBe('&');
    expect(namedEntity('nbsp')).toBe('\u00a0');
    expect(namedEntity('MediumSpace')).toBe('\u205f');
  });

  it('resolves a two-code-point value', () => {
    expect(namedEntity('NotEqualTilde')).toBe('\u2242\u0338');
    expect(namedEntity('nvap')).toBe('\u224d\u20d2');
  });

  it('is case sensitive', () => {
    expect(namedEntity('Alpha')).toBe('\u0391');  // capital alpha
    expect(namedEntity('alpha')).toBe('\u03b1');  // small alpha \u2014 a distinct entity
    expect(namedEntity('ALPHA')).toBeUndefined();
  });

  it('rejects a name that is not an entity', () => {
    expect(namedEntity('nope')).toBeUndefined();
    expect(namedEntity('')).toBeUndefined();
  });

  it('does not inherit from Object.prototype', () => {
    expect(namedEntity('constructor')).toBeUndefined();
    expect(namedEntity('__proto__')).toBeUndefined();
    expect(namedEntity('toString')).toBeUndefined();
  });

  it('carries only semicolon-terminated forms', () => {
    // entities.json lists both "&copy;" and the legacy "&copy"; CommonMark
    // recognises only the first, so the table must not admit "copy" twice or
    // admit names that exist solely in the semicolon-less spelling.
    expect(namedEntity('copy')).toBeDefined();
    expect(namedEntity('copy;')).toBeUndefined();
    expect(namedEntity('&copy')).toBeUndefined();
  });
});
```

The prototype test is not paranoia: this codebase already carries the
`hasOwnProperty`-not-`in` invariant for the bundled CMap table, for the identical
reason — the name comes out of a document.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/mdentity.test.ts`
Expected: FAIL — cannot resolve `../src/mdentity.js`.

- [ ] **Step 3: Write the generator**

```js
// scripts/gen-entities.mjs
// @ts-nocheck
// Generates src/mdentity.ts from the WHATWG HTML5 named character references.
// Downloads entities.json into a gitignored unicode/ dir (cached) and emits the
// committed src/mdentity.ts. Run via: npm run gen:entities
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://html.spec.whatwg.org/entities.json';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rawDir = join(root, 'unicode');
mkdirSync(rawDir, { recursive: true });
const cache = join(rawDir, 'entities.json');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u) => get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location); }
      if (res.statusCode !== 200) { reject(new Error(`${u} -> ${res.statusCode}`)); return; }
      const out = createWriteStream(dest); res.pipe(out); out.on('finish', () => out.close(resolve));
    }).on('error', reject);
    go(url);
  });
}

async function main() {
  if (!existsSync(cache)) { process.stdout.write(`downloading ${SOURCE}\n`); await download(SOURCE, cache); }
  const raw = JSON.parse(readFileSync(cache, 'utf8'));

  // CommonMark recognises only the semicolon-terminated spelling. entities.json
  // keys look like "&copy;" and "&copy"; keep the former, strip the framing.
  const table = {};
  for (const [key, val] of Object.entries(raw)) {
    if (!key.startsWith('&') || !key.endsWith(';')) continue;
    table[key.slice(1, -1)] = val.characters;
  }
  const names = Object.keys(table).sort();
  if (names.length < 2000) throw new Error(`only ${names.length} entities — entities.json looks wrong`);

  const out = `// GENERATED by scripts/gen-entities.mjs from ${SOURCE} — do not edit.
// The ${names.length} semicolon-terminated HTML5 named character references.
// CommonMark 0.31.2 recognises only this spelling: "&copy;" resolves, "&copy"
// stays literal text, so the legacy semicolon-less keys are dropped here.
/* eslint-disable */

const ENTITIES: Record<string, string> = ${JSON.stringify(table, null, 0)};

/** The replacement for a named entity, given the name alone — no '&', no ';'.
 *  Probed with hasOwnProperty rather than \`in\`, because the name comes out of a
 *  document: '&constructor;' would otherwise resolve to a function. */
export function namedEntity(name: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : undefined;
}
`;
  writeFileSync(join(root, 'src', 'mdentity.ts'), out);
  process.stdout.write(`src/mdentity.ts: ${names.length} entities\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Add the script and run the generator**

In `package.json`, beside `"gen:ucd"`:

```json
"gen:entities": "node scripts/gen-entities.mjs",
```

Then:

```bash
npm run gen:entities
```

Expected: `src/mdentity.ts: 2125 entities` (any count over 2000 is fine; the exact figure tracks the living WHATWG list).

- [ ] **Step 5: Run the test and typecheck**

Run: `npx vitest run test/mdentity.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Confirm the test is load-bearing**

Temporarily change `hasOwnProperty.call(ENTITIES, name)` to `name in ENTITIES` in the generated file and re-run. The prototype test must go red. Revert by re-running `npm run gen:entities`.

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-entities.mjs src/mdentity.ts test/mdentity.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(md): HTML5 named entity table (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Unicode punctuation for the flanking rules

**Files:**
- Modify: `scripts/gen-ucd.mjs`
- Modify: `src/unicode-data.ts` (regenerated)
- Modify: `test/unicode-data.test.ts` (append the new describe block — this is a
  `unicode-data.ts` accessor, so it belongs with its siblings rather than in a
  markdown-named file)

**Interfaces:**
- Consumes: nothing.
- Produces: `unicodePunctuation(cp: number): boolean` exported from `src/unicode-data.ts`.

- [ ] **Step 1: Write the failing test**

CommonMark 0.31.2 defines a Unicode punctuation character as general category
Pc, Pd, Pe, Pf, Pi, Po, Ps **or** Sc, Sk, Sm, So. The S\* half arrived in 0.31.0;
an implementation written against 0.30 omits it and gets flanking wrong around
`$`, `+` and `©`.

```ts
// test/unicode-data.test.ts — append this block. Add `unicodePunctuation` to the
// file's existing import from '../src/unicode-data.js'; do not add a second
// import line, and reuse a `cp` helper if the file already has one.
const cp = (s: string) => s.codePointAt(0)!;

describe('unicodePunctuation', () => {
  it('accepts every ASCII punctuation character', () => {
    for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') {
      expect(unicodePunctuation(cp(c)), c).toBe(true);
    }
  });

  it('accepts the P* categories beyond ASCII', () => {
    expect(unicodePunctuation(cp('\u2014'))).toBe(true); // Pd em dash
    expect(unicodePunctuation(cp('\u201c'))).toBe(true); // Pi left double quote
    expect(unicodePunctuation(cp('\u201d'))).toBe(true); // Pf right double quote
    expect(unicodePunctuation(cp('\u3002'))).toBe(true); // Po ideographic full stop
    expect(unicodePunctuation(cp('\uff08'))).toBe(true); // Ps fullwidth left paren
  });

  it('accepts the S* categories — the 0.31.0 change', () => {
    expect(unicodePunctuation(cp('$'))).toBe(true);      // Sc
    expect(unicodePunctuation(cp('\u00a3'))).toBe(true); // Sc pound
    expect(unicodePunctuation(cp('+'))).toBe(true);      // Sm
    expect(unicodePunctuation(cp('\u00a9'))).toBe(true); // So copyright
    expect(unicodePunctuation(cp('^'))).toBe(true);      // Sk
    expect(unicodePunctuation(cp('\u{1f600}'))).toBe(true); // So, astral
  });

  it('rejects letters, digits, marks and whitespace', () => {
    for (const c of 'aZ0\u00e9\u4e2d\u3042 \t\n') expect(unicodePunctuation(cp(c)), c).toBe(false);
    expect(unicodePunctuation(cp('\u0301'))).toBe(false); // Mn combining acute
    expect(unicodePunctuation(cp('\u00a0'))).toBe(false); // Zs no-break space
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/unicode-data.test.ts`
Expected: FAIL — `unicodePunctuation` is not exported.

- [ ] **Step 3: Extend the generator**

Add the parser beside `parseQuoteCat` in `scripts/gen-ucd.mjs`:

```js
// P*/S* General_Category from UnicodeData.txt — CommonMark 0.31.2's "Unicode
// punctuation character" (symbols were folded in at 0.31.0). Handles the
// First>/Last> range pairs defensively: no P*/S* block uses one today, but the
// Lo/Co/Cs blocks that do share this file.
function parsePunct(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].split(';');
    if (f.length < 3) continue;
    const gc = f[2];
    if (gc[0] !== 'P' && gc[0] !== 'S') continue;
    const cp = HEX(f[0]);
    if (f[1].endsWith(', First>')) { const g = lines[++i].split(';'); rows.push([cp, HEX(g[0]), 1]); }
    else rows.push([cp, cp, 1]);
  }
  return rows;
}
```

In `main()`, beside the `qc` table:

```js
  // Unicode punctuation (P* | S*) for CommonMark emphasis flanking — sparse; default 0.
  const pu = buildTable(parsePunct(read('unicodeData')), [], Number, 0);
```

In the emitted template, beside `const _qc = [`:

```js
const _pu = [
${fmtFlat(pu)}
];
```

and beside the other accessors:

```js
export function unicodePunctuation(cp: number): boolean { return lookup(_pu, cp) === 1; }
```

- [ ] **Step 4: Regenerate and check for drift**

```bash
npm run gen:ucd
git diff --stat src/unicode-data.ts
```

Expected: `src/unicode-data.ts` gains the `_pu` table and the accessor and **nothing else**. If any other table's lines changed, the pinned `UNICODE_VERSION` was not honoured or a cached UCD file is stale — investigate before continuing; do not commit a drifting regeneration.

- [ ] **Step 5: Run the new test and the conformance suites that prove no drift**

```bash
npx vitest run test/unicode-data.test.ts
npx vitest run test/bidi-conformance.test.ts test/linebreak-conformance.test.ts
npm run typecheck
```

Expected: all PASS. The two conformance suites run against the committed
`BidiCharacterTest.txt` / `LineBreakTest.txt`, so they are what proves the
regeneration left the shaping stack's data intact — an ordinary unit test would
not notice a table shifting by one range.

- [ ] **Step 6: Commit**

```bash
git add scripts/gen-ucd.mjs src/unicode-data.ts test/unicode-data.test.ts
git commit -m "$(cat <<'EOF'
feat(md): Unicode P*/S* punctuation class for emphasis flanking (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Shared lexical scanners

**Files:**
- Create: `src/mdscan.ts`
- Create: `test/mdscan.test.ts`

**Interfaces:**
- Consumes: `namedEntity` from `src/mdentity.js`, `unicodePunctuation` from `src/unicode-data.js`.
- Produces:

```ts
export const ASCII_PUNCT: string;                     // the 32 escapable characters
export function isUnicodeWhitespace(cp: number): boolean;
export function isPunctuation(cp: number): boolean;   // ASCII punct | unicodePunctuation
export function decodeEntities(s: string): string;    // named + numeric, invalid left literal
export function unescapeString(s: string): string;    // backslash escapes then entities
export function normalizeLabel(s: string): string;    // reference-label key
export function scanHtmlTag(s: string, i: number): number;  // end index, or -1
export function scanLinkDestination(s: string, i: number): { dest: string; end: number } | undefined;
export function scanLinkTitle(s: string, i: number): { title: string; end: number } | undefined;
```

- [ ] **Step 1: Write the failing test**

```ts
// test/mdscan.test.ts
import { describe, it, expect } from 'vitest';
import {
  decodeEntities, unescapeString, normalizeLabel,
  scanHtmlTag, scanLinkDestination, scanLinkTitle, isPunctuation, isUnicodeWhitespace,
} from '../src/mdscan.js';

describe('character classes', () => {
  it('treats ASCII punctuation and Unicode P*/S* alike', () => {
    expect(isPunctuation('!'.codePointAt(0)!)).toBe(true);
    expect(isPunctuation('$'.codePointAt(0)!)).toBe(true);
    expect(isPunctuation('a'.codePointAt(0)!)).toBe(false);
  });

  it('counts Zs plus tab, LF, FF and CR as whitespace, and nothing else', () => {
    for (const c of [' ', '\t', '\n', '\f', '\r', '\u00a0', '\u3000', '\u2009']) {
      expect(isUnicodeWhitespace(c.codePointAt(0)!), JSON.stringify(c)).toBe(true);
    }
    expect(isUnicodeWhitespace('\u200b'.codePointAt(0)!)).toBe(false); // Cf, not Zs
    expect(isUnicodeWhitespace('a'.codePointAt(0)!)).toBe(false);
  });
});

describe('decodeEntities', () => {
  it('resolves named, decimal and hex references', () => {
    expect(decodeEntities('&copy; &#35; &#X22; &#x22;')).toBe('\u00a9 # " "');
  });

  it('leaves an unknown or unterminated reference literal', () => {
    expect(decodeEntities('&nope; &copy &#; &#x; &')).toBe('&nope; &copy &#; &#x; &');
  });

  it('maps zero, out-of-range and surrogate references to U+FFFD', () => {
    expect(decodeEntities('&#0;')).toBe('\ufffd');
    expect(decodeEntities('&#x110000;')).toBe('\ufffd');
    expect(decodeEntities('&#xD800;')).toBe('\ufffd');
  });
});

describe('unescapeString', () => {
  it('unescapes the 32 ASCII punctuation characters and nothing else', () => {
    expect(unescapeString('\\*\\_\\!\\\\')).toBe('*_!\\');
    expect(unescapeString('\\a\\ \\\n')).toBe('\\a\\ \\\n');
  });

  it('applies escapes before entities, so an escaped ampersand stays literal', () => {
    expect(unescapeString('\\&copy;')).toBe('&copy;');
    expect(unescapeString('&copy;')).toBe('\u00a9');
  });
});

describe('normalizeLabel', () => {
  it('strips, collapses internal whitespace, and case folds', () => {
    expect(normalizeLabel('  Foo\n  Bar  ')).toBe('foo bar');
    expect(normalizeLabel('\u0422\u041e\u041b\u041f\u041e\u0419')).toBe(normalizeLabel('\u0422\u043e\u043b\u043f\u043e\u0439'));
  });
});

describe('scanHtmlTag', () => {
  it('accepts open tags, close tags, comments, PIs, declarations and CDATA', () => {
    for (const s of ['<a>', '<a href="x" />', '</a>', '<!-- c -->', '<?php ?>', '<!DOCTYPE html>', '<![CDATA[x]]>']) {
      expect(scanHtmlTag(s, 0), s).toBe(s.length);
    }
  });

  it('rejects what is not a tag', () => {
    for (const s of ['<>', '<1a>', '< a>', '</a b>', '<a', '<!-->']) {
      expect(scanHtmlTag(s, 0), s).toBe(-1);
    }
  });
});

describe('scanLinkDestination', () => {
  it('reads a pointy-bracket destination, unescaping inside', () => {
    expect(scanLinkDestination('<a b\\>c>', 0)).toEqual({ dest: 'a b>c', end: 8 });
  });

  it('reads a bare destination with balanced parentheses', () => {
    expect(scanLinkDestination('a(b)c d', 0)).toEqual({ dest: 'a(b)c', end: 5 });
  });

  it('rejects a bare destination with unbalanced parentheses', () => {
    expect(scanLinkDestination('a(b', 0)).toBeUndefined();
  });

  it('rejects a pointy-bracket destination containing a newline', () => {
    expect(scanLinkDestination('<a\nb>', 0)).toBeUndefined();
  });
});

describe('scanLinkTitle', () => {
  it('reads all three quotings', () => {
    expect(scanLinkTitle('"t"', 0)).toEqual({ title: 't', end: 3 });
    expect(scanLinkTitle("'t'", 0)).toEqual({ title: 't', end: 3 });
    expect(scanLinkTitle('(t)', 0)).toEqual({ title: 't', end: 3 });
  });

  it('unescapes and decodes entities inside', () => {
    expect(scanLinkTitle('"a\\"b&copy;"', 0)).toEqual({ title: 'a"b\u00a9', end: 12 });
  });

  it('rejects an unclosed title and a parenthesised title containing (', () => {
    expect(scanLinkTitle('"t', 0)).toBeUndefined();
    expect(scanLinkTitle('(a(b)', 0)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/mdscan.test.ts`
Expected: FAIL — cannot resolve `../src/mdscan.js`.

- [ ] **Step 3: Implement the scanners**

Notes that decide the assertions above:

- `ASCII_PUNCT` is exactly ``!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~`` — 32 characters. A backslash before anything else is literal, including before a newline (a backslash at end of line is a hard break, decided by `mdinline.ts`, not here).
- Unicode whitespace is Zs — U+0020, U+00A0, U+1680, U+2000–200A, U+202F, U+205F, U+3000 — plus tab, LF, FF, CR. Hard-code the Zs list; it is eight ranges and needs no table.
- `unescapeString` runs escapes **then** entities, so `\&copy;` stays literal.
- `normalizeLabel` trims, collapses each internal whitespace run to one space, then case folds. Use `toLowerCase()`; it is simple case mapping rather than full folding and differs on `ß`/`ẞ`. Ship `toLowerCase()` and let the 652 cases arbitrate — add a fold table here only if a case demands it.
- `scanHtmlTag` implements the spec's tag grammar: open tag (name `[A-Za-z][A-Za-z0-9-]*`, attributes, optional `/`), closing tag, comment (`<!-->` and `<!--->` are **not** comments), processing instruction, declaration (`<!` + letter), CDATA. Returns the index just past the tag, or -1.
- `scanLinkDestination` handles both forms: `<...>` with no unescaped `<`, `>` or newline; or a bare run with no ASCII control or space, in which parentheses must balance and may be backslash-escaped.

```ts
// src/mdscan.ts
import { namedEntity } from './mdentity.js';
import { unicodePunctuation } from './unicode-data.js';

/** Lexical scanners shared by the block and inline phases of the CommonMark
 *  parser.
 *
 *  Invariant: an HTML tag, an entity reference, a backslash escape, a link
 *  destination, a link title and a reference label each have exactly ONE
 *  scanner. A reference definition's destination and an inline link's
 *  destination that disagree is a bug no HTML rendering reveals — both emit the
 *  same <a href> for most inputs and differ only on the balanced-parenthesis
 *  and pointy-bracket forms. */
```

- [ ] **Step 4: Run the test and typecheck**

Run: `npx vitest run test/mdscan.test.ts && npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/mdscan.ts test/mdscan.test.ts
git commit -m "$(cat <<'EOF'
feat(md): shared lexical scanners (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Block phase — leaf blocks and the pipeline

Wires `parseMarkdown` end to end with a text-only inline pass, so every later
task has a working pipeline to extend and a real spec-suite gate to move.

**Files:**
- Create: `src/mdblock.ts`
- Create: `src/markdown.ts`
- Modify: `test/commonmark-spec.test.ts`

**Interfaces:**
- Consumes: `src/mdast.js`, `src/mdscan.js`.
- Produces:
  ```ts
  // src/mdblock.ts
  export interface LinkRef { destination: string; title: string; }
  export interface BlockResult { doc: MdDocument; refs: Map<string, LinkRef>; }
  /** `lines` are already newline-normalized and NUL-scrubbed. Leaf blocks come
   *  back with their raw text in `literal` (code/html) or, for paragraph and
   *  heading, staged on the node's `children` as a single MdText holding the raw
   *  string — the inline phase replaces it in Task 10. */
  export function parseBlocks(lines: string[]): BlockResult;

  // src/markdown.ts
  export function parseMarkdown(src: string): MdDocument;
  ```

- [ ] **Step 1: Write the failing test — move the spec gate to the leaf sections**

Append to `test/commonmark-spec.test.ts`:

```ts
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

/** The sections implemented so far. Grows task by task until Task 14 replaces
 *  this with loadSpecCases() and no filter. */
const GATED = [
  'Tabs', 'Precedence', 'Thematic breaks', 'ATX headings', 'Setext headings',
  'Indented code blocks', 'Fenced code blocks', 'HTML blocks', 'Paragraphs',
  'Blank lines', 'Textual content',
];

describe.each(GATED)('%s', (section) => {
  for (const c of casesInSections(section)) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown))).toBe(c.html);
    });
  }
});
```

Note `Textual content` and `Precedence` are inline-light sections that pass once
escapes and entities work — both are already in `mdscan.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: FAIL — cannot resolve `../src/markdown.js`.

- [ ] **Step 3: Implement the entry point**

```ts
// src/markdown.ts
import type { MdDocument } from './mdast.js';
import { parseBlocks } from './mdblock.js';
import { parseInlines } from './mdinline.js';   // Task 10; text-only stub until then

/** Parse CommonMark 0.31.2 into an abstract syntax tree.
 *
 *  Never throws: every string is a valid Markdown document. */
export function parseMarkdown(src: string): MdDocument {
  // Line endings normalize on entry and NUL becomes U+FFFD, as the spec requires.
  const text = src.replace(/\r\n?/g, '\n').replace(/\0/g, '\ufffd');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const { doc, refs } = parseBlocks(lines);
  parseInlines(doc, refs);
  return doc;
}
```

- [ ] **Step 4: Implement the leaf blocks**

`parseBlocks` for this task handles only the document root — no containers yet.
Per line, in the spec's precedence order:

1. **Tabs as columns.** Track a column position, not a character index. A tab advances to the next multiple of 4. When a construct consumes part of a tab's width, the remainder survives as spaces. This is the single most-failed detail in the `Tabs` section; getting it wrong there is the gate's job to catch.
2. **Blank line** — closes a paragraph, is retained inside a fenced or indented code block.
3. **Thematic break** — three or more of `-`, `_` or `*`, up to 3 leading spaces, nothing else but spaces/tabs.
4. **ATX heading** — 1–6 `#` then a space or end of line; a closing run of `#` is stripped.
5. **Fenced code block** — three or more backticks or tildes; the info string follows on the same line (a backtick fence's info may not contain a backtick). The closing fence must be at least as long and of the same character. Content is dedented by the opening fence's indent, up to that many spaces per line.
6. **Indented code block** — four columns of indent, and only where a paragraph cannot lazily continue.
7. **Setext heading** — a `=` or `-` run under a paragraph promotes it; level 1 for `=`, 2 for `-`. A `-` run is a thematic break when there is no paragraph above it.
8. **HTML block** — the spec's seven conditions, using `scanHtmlTag` for condition 7. Each condition has its own end condition; condition 7 cannot interrupt a paragraph.
9. **Paragraph** — everything else, accumulating raw lines joined by `\n` with each line's leading and trailing whitespace stripped.

Leaf text is staged raw: a paragraph or heading holds a single `MdText` whose
`value` is the unparsed run. Task 10 replaces it.

- [ ] **Step 5: Stub the inline phase**

```ts
// src/mdinline.ts — Task 10 replaces the body; this makes the pipeline run.
import type { MdDocument } from './mdast.js';
import type { LinkRef } from './mdblock.js';
import { unescapeString } from './mdscan.js';

/** Replace each leaf's staged raw text with parsed inline nodes, in place. */
export function parseInlines(doc: MdDocument, refs: Map<string, LinkRef>): void {
  // Walk paragraphs and headings; for now, unescape the staged MdText only.
  // Task 10 implements code spans, emphasis, links, autolinks and raw HTML.
}
```

- [ ] **Step 6: Run the gate**

Run: `npx vitest run test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS — every case in the ten gated sections.

- [ ] **Step 7: Commit**

```bash
git add src/mdblock.ts src/markdown.ts src/mdinline.ts test/commonmark-spec.test.ts
git commit -m "$(cat <<'EOF'
feat(md): block phase leaf blocks and the parse pipeline (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Block phase — containers, lists and lazy continuation

**Files:**
- Modify: `src/mdblock.ts`
- Modify: `test/commonmark-spec.test.ts`
- Modify: `test/markdown-ast.test.ts`

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: no new exports; `parseBlocks` now emits `MdBlockQuote`, `MdList` and `MdItem`.

- [ ] **Step 1: Write the failing tests — the AST facts the oracle cannot see**

Append to `test/markdown-ast.test.ts`:

```ts
import { parseMarkdown } from '../src/markdown.js';
import type { MdList } from '../src/mdast.js';

const firstList = (src: string): MdList => {
  const n = parseMarkdown(src).children.find((c) => c.type === 'list');
  if (n === undefined) throw new Error('no list parsed');
  return n as MdList;
};

describe('list model — invisible to an HTML oracle, load-bearing for Flow', () => {
  it('marks a list with no blank lines tight', () => {
    expect(firstList('- a\n- b\n').tight).toBe(true);
  });

  it('marks a list with a blank line between items loose', () => {
    expect(firstList('- a\n\n- b\n').tight).toBe(false);
  });

  it('marks a list with a blank line inside one item loose', () => {
    expect(firstList('- a\n\n  b\n').tight).toBe(false);
  });

  it('keeps an ordered start and delimiter', () => {
    const l = firstList('7) a\n8) b\n');
    expect(l.ordered).toBe(true);
    expect(l.start).toBe(7);
    expect(l.delimiter).toBe(')');
  });

  it('starts a new list when the bullet character changes', () => {
    const doc = parseMarkdown('- a\n+ b\n');
    expect(doc.children.filter((c) => c.type === 'list').length).toBe(2);
  });

  it('nests a list inside a block quote', () => {
    const doc = parseMarkdown('> - a\n');
    expect(doc.children[0].type).toBe('block_quote');
  });
});
```

- [ ] **Step 2: Extend the spec gate**

In `test/commonmark-spec.test.ts`, add to `GATED`:

```ts
  'Block quotes', 'List items', 'Lists',
```

- [ ] **Step 3: Run both to verify they fail**

Run: `npx vitest run test/markdown-ast.test.ts test/commonmark-spec.test.ts`
Expected: FAIL — no list or block-quote nodes are produced.

- [ ] **Step 4: Implement containers**

Restructure `parseBlocks` into the spec's Appendix A loop. Per line:

1. **Match open blocks**, outermost first. A block quote matches `>` plus one optional space; a list item matches its content indent. Stop at the first that does not match; the rest are *not* closed yet.
2. **Try new container starts** on what remains, repeatedly. A list item start is a bullet (`-`, `+`, `*`) or an ordered marker (1–9 digits then `.` or `)`) followed by 1–4 spaces of content indent — or, when the rest of the line is blank, one space. An item starting with an indented code block gets content indent marker+1.
3. **Attach the remainder** to a leaf, closing every unmatched block first — **except** under lazy continuation: a paragraph continuation line needs no container prefix at all, so `> a\nb` keeps `b` in the quote's paragraph.
4. **Tightness** is decided when the list closes: loose if any blank line separates its items, or if any item contains a blank line between two of its own blocks. A trailing blank line before the list ends does not make it loose.
5. **A list ends** when the marker character or ordered delimiter changes; the next marker opens a new list.
6. **Depth cap.** Track container nesting; past 1000, stop opening new containers and let the line fall through as paragraph text. Task 13 tests it.

- [ ] **Step 5: Run the gate**

Run: `npx vitest run test/markdown-ast.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Confirm the tightness assertions are load-bearing**

Hard-code `tight: true` in the list constructor. The three tightness tests and
several `Lists` spec cases must go red. Revert.

- [ ] **Step 7: Commit**

```bash
git add src/mdblock.ts test/commonmark-spec.test.ts test/markdown-ast.test.ts
git commit -m "$(cat <<'EOF'
feat(md): block quotes, lists and lazy continuation (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Link reference definitions

**Files:**
- Modify: `src/mdblock.ts`
- Modify: `test/markdown-ast.test.ts`
- Modify: `test/commonmark-spec.test.ts`

**Interfaces:**
- Consumes: `normalizeLabel`, `scanLinkDestination`, `scanLinkTitle` from `src/mdscan.js`.
- Produces: `BlockResult.refs` is now populated. Keys are normalized labels; first definition wins.

- [ ] **Step 1: Write the failing test**

Append to `test/markdown-ast.test.ts`:

```ts
describe('link reference definitions', () => {
  it('removes a definition-only paragraph from the tree', () => {
    expect(parseMarkdown('[a]: /u "t"\n').children).toEqual([]);
  });

  it('keeps the paragraph text that follows definitions on the same run', () => {
    const doc = parseMarkdown('[a]: /u\ntext\n');
    expect(doc.children.length).toBe(1);
    expect(doc.children[0].type).toBe('paragraph');
  });

  it('lets the first of two identical labels win', () => {
    const doc = parseMarkdown('[a]: /first\n[a]: /second\n\n[a]\n');
    const p = doc.children[0] as { children: { type: string; destination?: string }[] };
    expect(p.children[0].destination).toBe('/first');
  });

  it('matches a label case-insensitively and across a newline', () => {
    const doc = parseMarkdown('[Foo\n  bar]: /u\n\n[foo bar]\n');
    const p = doc.children[0] as { children: { type: string; destination?: string }[] };
    expect(p.children[0].destination).toBe('/u');
  });
});
```

- [ ] **Step 2: Extend the spec gate**

Add `'Link reference definitions'` to `GATED`.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/markdown-ast.test.ts test/commonmark-spec.test.ts`
Expected: FAIL — definitions still render as paragraph text.

- [ ] **Step 4: Implement**

When a paragraph closes, repeatedly try to consume a definition off its front:
`[label]:` then optional whitespace (at most one newline) then a destination,
then optionally whitespace and a title — where the title must be the last thing
on its line, or it is not part of the definition. Store under
`normalizeLabel(label)` with `Map.has` guarding first-wins. A label is 1–999
characters and may not be empty after normalization. If the paragraph is emptied,
drop it; otherwise keep the remainder.

- [ ] **Step 5: Run the gate**

Run: `npx vitest run test/markdown-ast.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: `Link reference definitions` cases pass. The four AST tests still fail
their `destination` assertions — reference **links** arrive in Task 12. Mark
those two tests `it.skip` with the comment `// unskip in Task 12`, and unskip
them there.

- [ ] **Step 6: Commit**

```bash
git add src/mdblock.ts test/markdown-ast.test.ts test/commonmark-spec.test.ts
git commit -m "$(cat <<'EOF'
feat(md): link reference definitions (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Inline phase — code spans, autolinks, raw HTML, breaks

**Files:**
- Modify: `src/mdinline.ts`
- Modify: `test/commonmark-spec.test.ts`

**Interfaces:**
- Consumes: `src/mdscan.js`, `src/mdast.js`.
- Produces: `parseInlines(doc, refs)` now replaces staged text with real inline nodes for everything except emphasis (Task 11) and links/images (Task 12).

- [ ] **Step 1: Extend the spec gate**

Add to `GATED`:

```ts
  'Backslash escapes', 'Entity and numeric character references', 'Inlines',
  'Code spans', 'Autolinks', 'Raw HTML', 'Hard line breaks', 'Soft line breaks',
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: FAIL across the seven new sections.

- [ ] **Step 3: Implement**

Walk the staged raw text left to right. Precedence, per the spec:

1. **Backslash escape** — `\` + one of the 32 ASCII punctuation characters is that character literally; `\` at end of line is a **hard break**.
2. **Code span** — a run of N backticks matched by the next run of exactly N. Content has one leading and one trailing space stripped when both exist and the content is not all spaces; interior newlines become spaces. An unmatched run is literal text. Code spans bind tighter than everything else, including emphasis.
3. **Autolink** — `<scheme:rest>` where scheme is 2–32 letters/digits/`+`/`.`/`-` starting with a letter, or `<email@host>`. Produces an `MdLink` whose destination is the text (mailto: prefixed for email) and whose child is the literal text.
4. **Raw inline HTML** — `scanHtmlTag` succeeding produces `MdHtmlInline`.
5. **Entity references** — via `decodeEntities`, but **not** inside a code span, an autolink destination or raw HTML.
6. **Hard break** — two or more spaces before a newline, or a backslash before a newline. Trailing spaces are stripped either way.
7. **Soft break** — any other newline. The spaces around it are stripped.
8. Everything else accumulates into `MdText`.

Merge adjacent `MdText` nodes as they are emitted — a tree with five one-character
text nodes renders identically but is noise for `gl6o.3` to walk.

- [ ] **Step 4: Run the gate**

Run: `npx vitest run test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS across all gated sections.

- [ ] **Step 5: Commit**

```bash
git add src/mdinline.ts test/commonmark-spec.test.ts
git commit -m "$(cat <<'EOF'
feat(md): inline code spans, autolinks, raw HTML and breaks (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Inline phase — emphasis

**Files:**
- Modify: `src/mdinline.ts`
- Modify: `test/commonmark-spec.test.ts`

**Interfaces:**
- Consumes: `isPunctuation`, `isUnicodeWhitespace` from `src/mdscan.js`.
- Produces: `MdEmph` and `MdStrong` nodes.

- [ ] **Step 1: Extend the spec gate**

Add `'Emphasis and strong emphasis'` to `GATED` — 131 cases, the largest section
in the suite and the one that punishes a shortcut.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: FAIL across the emphasis section.

- [ ] **Step 3: Implement the delimiter stack**

Collect runs of `*` and `_` into a doubly-linked delimiter stack as the text is
scanned, recording for each run: the character, its length, and whether it can
open and whether it can close.

**Flanking**, the part that needs `mdscan.ts`'s character classes:

- A run is **left-flanking** when it is not followed by whitespace, and either not followed by punctuation, or followed by punctuation and preceded by whitespace or punctuation.
- **Right-flanking** is the mirror image.
- `*` can open when left-flanking and close when right-flanking.
- `_` can open when left-flanking **and** (not right-flanking, or preceded by punctuation); closing is the mirror. This is what stops `snake_case_word` from emphasizing.
- Start and end of the run's containing text count as whitespace.

**`process_emphasis`**, run after the whole run is scanned:

```ts
// openersBottom[closerChar][closerLength % 3][closerCanAlsoOpen] remembers how
// far back a failed search reached, so the next closer of the same shape does
// not re-scan the same openers. WITHOUT this the algorithm is O(n^2) on
// adversarial input like '*a*a*a*...' — the bound is part of the algorithm, not
// a guard bolted on top. test/markdown-pathological.test.ts asserts it.
```

Walk closers left to right. For each, walk back to the nearest opener of the same
character that is above `openersBottom`, honouring the **rule of 3**: if one of
the two runs can both open and close, the sum of their original lengths may not
be a multiple of 3 unless both lengths are. On a match, emit `MdStrong` when both
have 2+ delimiters (consuming 2 from each), else `MdEmph` (consuming 1); remove
delimiters between them; delete a run when it empties. On no match, set
`openersBottom` for this closer's shape and remove the closer if it cannot open.

- [ ] **Step 4: Run the gate**

Run: `npx vitest run test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS, including all 131 emphasis cases.

- [ ] **Step 5: Confirm the flanking classes are load-bearing**

Change `isPunctuation` to test ASCII punctuation only (dropping the Unicode
P\*/S\* half). Emphasis cases involving `$`, `©` and CJK punctuation must go red —
that is the 0.30-vs-0.31.2 difference proving the Task 5 table is consulted.
Revert.

- [ ] **Step 6: Commit**

```bash
git add src/mdinline.ts test/commonmark-spec.test.ts
git commit -m "$(cat <<'EOF'
feat(md): emphasis delimiter stack with openers_bottom (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Inline phase — links and images

**Files:**
- Modify: `src/mdinline.ts`
- Modify: `test/commonmark-spec.test.ts`
- Modify: `test/markdown-ast.test.ts`

**Interfaces:**
- Consumes: `refs` from `parseBlocks`, `scanLinkDestination`/`scanLinkTitle`/`normalizeLabel` from `src/mdscan.js`.
- Produces: `MdLink` and `MdImage` nodes with resolved `destination` and `title`.

- [ ] **Step 1: Extend the spec gate and unskip the reference tests**

Add `'Links'` and `'Images'` to `GATED`. In `test/markdown-ast.test.ts`, unskip
the two Task 9 tests marked `// unskip in Task 12`, and add:

```ts
describe('links and images', () => {
  it('resolves an inline and a reference link to the same node shape', () => {
    const inline = parseMarkdown('[a](/u "t")\n');
    const ref = parseMarkdown('[a][r]\n\n[r]: /u "t"\n');
    expect(JSON.stringify(inline.children[0])).toBe(JSON.stringify(ref.children[0]));
  });

  it('distinguishes an image from a link', () => {
    const doc = parseMarkdown('![a](/i.png)\n');
    const p = doc.children[0] as { children: { type: string }[] };
    expect(p.children[0].type).toBe('image');
  });

  it('keeps inline structure inside an image description', () => {
    const doc = parseMarkdown('![a *b*](/i.png)\n');
    const p = doc.children[0] as { children: { children: { type: string }[] }[] };
    expect(p.children[0].children.map((c) => c.type)).toEqual(['text', 'emph']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/commonmark-spec.test.ts test/markdown-ast.test.ts`
Expected: FAIL across `Links`, `Images` and the new AST tests.

- [ ] **Step 3: Implement the bracket stack**

Push an entry for each `[` and `![` as they are scanned. On a `]`, look back to
the nearest unmatched opener and try, in order: an **inline** link
`](dest "title")`, a **full reference** `][label]`, a **collapsed reference**
`][]`, then a **shortcut reference** `]` with the bracketed text as the label.
Resolve labels through `normalizeLabel` against `refs`. On success, run
`process_emphasis` over the delimiters inside the brackets, wrap the contents in
`MdLink`/`MdImage`, and — for a **link**, not an image — deactivate every earlier
opener on the stack, which is what forbids nested links. On failure, the `]` is
literal text and the opener is removed.

The **depth cap** from Task 8 applies here too: past 1000 nested brackets, stop
pushing openers and let the brackets be literal text.

- [ ] **Step 4: Run the gate**

Run: `npx vitest run test/commonmark-spec.test.ts test/markdown-ast.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mdinline.ts test/commonmark-spec.test.ts test/markdown-ast.test.ts
git commit -m "$(cat <<'EOF'
feat(md): links and images via the bracket stack (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Robustness — depth cap and the emphasis bound

**Files:**
- Create: `test/markdown-pathological.test.ts`
- Modify: `src/mdblock.ts`, `src/mdinline.ts` (only if a bound is missing)

**Interfaces:**
- Consumes: `parseMarkdown`.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// test/markdown-pathological.test.ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';

/** Markdown is untrusted text by definition. Every case here has CVE history in
 *  cmark. The parser must never throw and never take the process down. */
describe('pathological input', () => {
  it('survives deeply nested block quotes', () => {
    const src = '>'.repeat(50_000) + ' x\n';
    expect(() => parseMarkdown(src)).not.toThrow();
  });

  it('survives deeply nested brackets', () => {
    expect(() => parseMarkdown('['.repeat(50_000) + 'a' + ']'.repeat(50_000))).not.toThrow();
  });

  it('survives deeply nested list items', () => {
    let src = '';
    for (let i = 0; i < 10_000; i++) src += '  '.repeat(i) + '- a\n';
    expect(() => parseMarkdown(src)).not.toThrow();
  });

  it('does not blow up on adversarial emphasis', () => {
    const t0 = Date.now();
    parseMarkdown('*a'.repeat(50_000) + '*');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on unmatched code-span backticks', () => {
    const t0 = Date.now();
    parseMarkdown('`a'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('does not blow up on many unresolved reference labels', () => {
    const t0 = Date.now();
    parseMarkdown('[a]'.repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('parses a document with no trailing newline', () => {
    expect(parseMarkdown('a').children.length).toBe(1);
  });

  it('parses an empty document', () => {
    expect(parseMarkdown('').children).toEqual([]);
  });

  it('scrubs NUL to U+FFFD', () => {
    const doc = parseMarkdown('a\0b\n');
    const p = doc.children[0] as { children: { value?: string }[] };
    expect(p.children[0].value).toBe('a\ufffdb');
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/markdown-pathological.test.ts`
Expected: whichever bounds are missing show up as a `RangeError`, a hang, or a
timeout. Fix them in `mdblock.ts` / `mdinline.ts`; do not weaken the test.

- [ ] **Step 3: Confirm the cap is load-bearing**

Raise the container cap from 1000 to `Infinity` and re-run. The nested-quote and
nested-list tests must go red with a stack overflow. Restore 1000.

- [ ] **Step 4: Confirm the emphasis bound is load-bearing**

Disable `openersBottom` (always search to the bottom of the stack) and re-run.
The adversarial-emphasis test must exceed its 5s budget. Restore it.

- [ ] **Step 5: Verify the caps changed no conformance**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: PASS — no spec case nests past ten, so the cap must be invisible to
the suite.

- [ ] **Step 6: Commit**

```bash
git add test/markdown-pathological.test.ts src/mdblock.ts src/mdinline.ts
git commit -m "$(cat <<'EOF'
test(md): depth cap and emphasis bound against pathological input (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Full 652 gate, public API and docs

**Files:**
- Modify: `test/commonmark-spec.test.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything.
- Produces: `parseMarkdown` and the node types on the public API.

- [ ] **Step 1: Replace the section gate with the whole suite**

In `test/commonmark-spec.test.ts`, delete `GATED` and the `describe.each` over
it, and replace with:

```ts
describe('conformance', () => {
  for (const c of loadSpecCases()) {
    it(`${c.section} example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown))).toBe(c.html);
    });
  }
});
```

No allowlist, no skips. Keep the four fixture tests from Task 1 and the
`casesInSections` helper — `gl6o.2` will want it again.

- [ ] **Step 2: Run the full suite**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: 652 passing, 0 failing, 0 skipped. If any case fails, fix the parser —
do not skip the case and do not adjust the oracle to match the parser.

- [ ] **Step 3: Export the public API**

In `src/index.ts`, beside the other feature exports:

```ts
export { parseMarkdown } from './markdown.js';
export type {
  MdNode, MdBlock, MdInline,
  MdDocument, MdBlockQuote, MdList, MdItem, MdParagraph, MdHeading,
  MdThematicBreak, MdCodeBlock, MdHtmlBlock,
  MdText, MdSoftBreak, MdHardBreak, MdEmph, MdStrong, MdCode, MdLink, MdImage, MdHtmlInline,
} from './mdast.js';
export { isMdBlock, isMdInline, isMdContainer } from './mdast.js';
```

- [ ] **Step 4: Document it**

In `README.md`, add to Features:

```markdown
- **Markdown parsing** — `parseMarkdown` turns CommonMark 0.31.2 text into an
  abstract syntax tree, verified against all 652 cases of the official spec
  suite. Rendering into a PDF page arrives separately; this is the parser.
```

and to the API overview:

```markdown
### Markdown

```ts
import { parseMarkdown } from '@asposefoss/pdf';

const doc = parseMarkdown('# Title\n\nSome *emphasis* and a [link](/u).\n');
// doc.children[0] -> { type: 'heading', level: 1, children: [...] }
```

Nodes carry no source positions. GFM constructs — tables, strikethrough, task
lists — are not recognised yet.
```

In `CLAUDE.md`, add to the module map, after the `flow.ts` entry:

```markdown
- **markdown.ts**, **mdast.ts**, **mdblock.ts**, **mdinline.ts**, **mdscan.ts**,
  **mdentity.ts** — CommonMark 0.31.2 parsing (`parseMarkdown`), the spec's
  Appendix A two-phase algorithm: `mdblock.ts` walks lines over a stack of open
  blocks, `mdinline.ts` then runs a delimiter stack for emphasis and a bracket
  stack for links over each leaf's raw text. Nothing here produces PDF — the
  renderer is `gl6o.3`.
  **Invariant:** an HTML tag, an entity, a backslash escape, a link destination,
  a link title and a reference label each have exactly one scanner, in
  `mdscan.ts`. Both phases need the HTML grammar — the block phase for HTML
  block conditions 1–7, the inline phase for `HtmlInline` — and a reference
  definition's destination must parse identically to an inline link's. Two
  copies differ only on the balanced-parenthesis and pointy-bracket forms, which
  no HTML rendering reveals.
  **Invariant:** the parser never throws. Every string is a valid CommonMark
  document, so there is no `PdfParseError` path here — unlike every other parser
  in `src/`. Damage shows up as literal text, never as an exception.
  **Invariant:** `unicodePunctuation` is P\* **and** S\*. CommonMark folded
  symbols into the definition at 0.31.0, and the class decides emphasis
  flanking, so an implementation written against 0.30 silently mis-emphasizes
  around `$`, `+` and `©`.
  **Invariant:** the emphasis algorithm keeps the spec's `openers_bottom`
  bookkeeping and the block phase caps container nesting at 1000. Both are
  bounds against adversarial input rather than conformance requirements — no
  spec case nests past ten — so the suite cannot protect them and
  `test/markdown-pathological.test.ts` does.
  **Invariant:** `test/helpers/md-html.ts` is a test-only conformance oracle,
  not an output format. The suite's expectations are HTML, so conformance is
  unmeasurable without it; nothing in `src/` may import it. It is also blind to
  list tightness, which drives Flow's paragraph spacing — `markdown-ast.test.ts`
  covers what the rendering collapses.
```

- [ ] **Step 5: Run everything**

```bash
npm run typecheck
npm test
npm run build
```

Expected: all green. `npm run build` confirms the new modules emit cleanly to
`dist/` with their `.d.ts`.

- [ ] **Step 6: Commit**

```bash
git add test/commonmark-spec.test.ts src/index.ts README.md CLAUDE.md
git commit -m "$(cat <<'EOF'
feat(md): 652/652 CommonMark conformance and the public parseMarkdown API (gl6o.1)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close the issue and push**

```bash
bd remember --key commonmark-parser-shipped "CommonMark 0.31.2 parser shipped (gl6o.1). src/markdown.ts parseMarkdown(src)->MdDocument; two-phase per spec Appendix A. mdast.ts model (no source positions, no options arg), mdblock.ts block phase, mdinline.ts inline phase, mdscan.ts the ONE owner of the HTML tag grammar/entities/escapes/link destination+title/label normalization, mdentity.ts generated by scripts/gen-entities.mjs. unicodePunctuation (P*|S*) added to unicode-data.ts via gen-ucd.mjs. All 652 official cases pass with no allowlist via the test-only oracle test/helpers/md-html.ts; test/fixtures/commonmark/spec.json vendored. Parser never throws. Container nesting capped at 1000; emphasis keeps openers_bottom. Next: gl6o.2 GFM, gl6o.3 render into Flow."
bd close aspose-pdf-foss-for-ts-gl6o.1
git pull --rebase
git push
git status
```

Expected: `git status` shows the branch up to date with origin.

---

## Self-Review

**Spec coverage** — every section of `docs/superpowers/specs/2026-08-11-commonmark-parser-design.md` maps to a task:

| Spec section | Task |
|---|---|
| Two phases, block phase | 7, 8 |
| Two phases, inline phase | 10, 11, 12 |
| `src/mdast.ts` node model | 2 |
| `src/mdscan.ts` and its one-scanner invariant | 6, 14 (CLAUDE.md) |
| Link reference definitions harvested into a map | 9 |
| Public export + README | 14 |
| Robustness: depth cap, quadratic emphasis | 8, 12 (caps), 13 (tests) |
| Line-ending normalization, NUL → U+FFFD | 7 (implementation), 13 (test) |
| `unicodePunctuation` via `gen-ucd.mjs` | 5 |
| Entity table via `gen-entities.mjs`, semicolon-only, multi-code-point, numeric refs | 4, 6 |
| Label normalization and case folding | 6, 9 |
| Vendored `spec.json` + PROVENANCE | 1 |
| Test-only HTML oracle | 3 |
| 652 cases, no allowlist | 14 |
| AST tests for what HTML hides | 8, 9, 12 |
| Pathological tests | 13 |
| Load-bearing confirmations | 4, 5 (drift), 8, 11, 13 |

The spec's "break the path" list is covered: `openers_bottom` (13), S\* categories
(11), reference definitions without case folding (6, via `normalizeLabel`'s test),
the depth cap (13). **Tabs as three spaces** is exercised by the `Tabs` section
gate in Task 7 rather than by a deliberate mutation — noted so the implementer
knows the gate is the assertion there.

**Type consistency** — `parseBlocks(lines: string[]): BlockResult` (Task 7) is
what Tasks 8, 9 extend; `parseInlines(doc, refs)` (Task 7 stub) keeps its
signature through Tasks 10–12; `LinkRef { destination, title }` matches the
`MdLink`/`MdImage` property names in Task 2; `namedEntity` (Task 4) and
`unicodePunctuation` (Task 5) are consumed under those exact names in Task 6.
`renderHtml(doc)` (Task 3) is called identically in Tasks 7–14.

**Known ordering wrinkle, handled:** Task 9's four AST assertions about resolved
destinations cannot pass until Task 12 supplies reference links. Task 9 Step 5
marks the two affected tests `it.skip` with an explicit unskip instruction, and
Task 12 Step 1 unskips them. This is the only skip in the plan and it does not
survive it.
