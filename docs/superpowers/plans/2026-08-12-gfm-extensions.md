# GFM Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the CommonMark 0.31.2 parser with the five GitHub Flavored Markdown extensions — tables, task list items, strikethrough, extended autolinks and disallowed raw HTML — behind `parseMarkdown(src, { gfm: true })`.

**Architecture:** Two new pure modules (`src/mdtable.ts`, `src/mdgfm.ts`) hold every extension rule; the two existing phase modules gain a handful of guarded hooks. With `gfm` off no new code executes and output is byte-identical to today's. Conformance is pinned by the 24 extension examples in GitHub's own `spec.txt`, run through the existing test-only HTML oracle.

**Tech Stack:** TypeScript (strict, ESM + NodeNext), vitest, zero runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins. Do not add npm runtime deps.
- **ESM + NodeNext:** every import specifier carries the `.js` extension (`import { x } from './mdgfm.js'`).
- **`gfm` defaults to false.** `parseMarkdown(src)` must remain strict CommonMark 0.31.2. `test/commonmark-spec.test.ts` calls `parseMarkdown(c.markdown)` with no options and must stay 652/652 after every task.
- **Nothing in `src/` may import `test/helpers/md-html.ts`.** The oracle is test-only; the dependency runs one way.
- **The parser never throws.** Every string is a valid Markdown document; there is no `PdfParseError` path in this stack.
- **Design doc:** `docs/superpowers/specs/2026-08-12-gfm-extensions-design.md`. Read it before starting.
- **Quality gate before closing any task:** `npm run typecheck` and `npm test` must both be green.
- **Upstream reference** (already read and transcribed into this plan; fetch only if a rule looks wrong): `github/cmark-gfm` `extensions/table.c`, `extensions/strikethrough.c`, `extensions/autolink.c`, `extensions/tasklist.c`, `extensions/ext_scanners.re`.

---

### Task 1: Vendor the GFM spec and load its extension examples

Test-only task. No `src/` changes. Produces the conformance data every later task asserts against.

**Files:**
- Create: `test/fixtures/gfm/spec.txt` (downloaded)
- Create: `test/fixtures/gfm/PROVENANCE.md`
- Create: `test/helpers/gfm-suite.ts`
- Create: `test/gfm-spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface GfmCase { markdown: string; html: string; example: number; section: string; extension: string; startLine: number }`
  - `loadGfmExamples(): GfmCase[]` — all 672 examples in the file, `extension: ''` for a plain CommonMark one.
  - `gfmExtensionCases(): GfmCase[]` — the 24 examples tagged with an extension name.

- [ ] **Step 1: Download the spec and record its provenance**

```bash
mkdir -p test/fixtures/gfm
curl -sS -L -o test/fixtures/gfm/spec.txt \
  https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt
sha256sum test/fixtures/gfm/spec.txt
curl -sS https://api.github.com/repos/github/cmark-gfm/commits/master | head -3
```

Expected SHA-256 at the time this plan was written:
`7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c` (216680 bytes).
If it differs, the file moved on upstream — record the value you actually got, and re-check the per-section example counts in Step 3 before continuing.

- [ ] **Step 2: Write `test/fixtures/gfm/PROVENANCE.md`**

```markdown
# GFM spec suite

## Source

| | |
|---|---|
| File | `spec.txt` |
| Upstream | `https://raw.githubusercontent.com/github/cmark-gfm/master/test/spec.txt` |
| Commit | <paste the `sha` from the API call in Step 1> |
| Retrieved | 2026-08-12 |
| SHA-256 | `7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c` |
| Size | 216680 bytes |
| Declares | `title: GitHub Flavored Markdown Spec`, `version: 0.29`, `date: 2019-04-06` |
| Licence | CC-BY-SA 4.0 |

Byte-identical to upstream. Tabs are written as `→` (U+2192) inside example
bodies, exactly as in the CommonMark spec file; the loader substitutes them.

## What it covers

The 24 examples tagged with an extension name on their opening fence:

| Tag | Section | Examples |
|---|---|---|
| `table` | Tables (extension) | 8 |
| `disabled` | Task list items (extension) | 2 |
| `strikethrough` | Strikethrough (extension) | 2 |
| `autolink` | Autolinks (extension) | 11 |
| `tagfilter` | Disallowed Raw HTML (extension) | 1 |

## What it does NOT cover

**The other 648 examples in this file are not run.** They are a whole CommonMark
**0.29** document, and this library conforms to **0.31.2**; running them would
need an allowlist for the version divergences, and an allowlist means a
shortfall stops being a red build. `test/fixtures/commonmark/spec.json` (the
official 0.31.2 suite, 652 examples, no allowlist) covers that body of the file
instead.

Coverage inside the extension sections is thin, and thinnest where the grammar
is richest:

- **Tables** get 8 examples. Not covered: a table inside a block quote or a list
  item, alignment markers with no dashes (`:-`), a header row whose cells are
  empty, or a table interrupted by a fenced code block.
- **Task lists** get 2. Neither uses an uppercase `[X]`, though the prose
  mandates it; neither has a loose item or a non-paragraph first block.
- **Strikethrough** gets 2, both `~~`. Single-tilde `~x~`, which `cmark-gfm`
  accepts, is not exercised here at all.
- **Autolinks** get 11, all inside plain paragraphs. Not covered: an autolink
  candidate inside link text, inside emphasis, or spanning a soft break.

`test/gfm-ast.test.ts` covers what the HTML rendering collapses; the
hand-written cases in each feature's tests cover the gaps listed above.
```

- [ ] **Step 3: Write the failing loader test**

Create `test/gfm-spec.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadGfmExamples, gfmExtensionCases } from './helpers/gfm-suite.js';

describe('GFM spec suite', () => {
  // The full count is asserted because the extension cases are selected out of
  // it: a fence scanner that silently loses examples would still return a
  // plausible-looking subset.
  it('finds every example in the vendored file', () => {
    expect(loadGfmExamples().length).toBe(672);
  });

  it('numbers examples 1..672 with no gaps', () => {
    expect(loadGfmExamples().map((c) => c.example)).toEqual(
      Array.from({ length: 672 }, (_, i) => i + 1),
    );
  });

  it('selects the 24 extension examples', () => {
    const cases = gfmExtensionCases();
    const counts: Record<string, number> = {};
    for (const c of cases) counts[c.extension] = (counts[c.extension] ?? 0) + 1;
    expect(counts).toEqual({ table: 8, disabled: 2, strikethrough: 2, autolink: 11, tagfilter: 1 });
    expect(cases.length).toBe(24);
  });

  it('carries the section heading and the example body', () => {
    const first = gfmExtensionCases()[0];
    expect(first.section).toBe('Tables (extension)');
    expect(first.markdown).toBe('| foo | bar |\n| --- | --- |\n| baz | bim |\n');
    expect(first.html.startsWith('<table>\n<thead>\n')).toBe(true);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run test/gfm-spec.test.ts`
Expected: FAIL — cannot resolve `./helpers/gfm-suite.js`.

- [ ] **Step 5: Write the loader**

Create `test/helpers/gfm-suite.ts`:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One example from GitHub's `spec.txt`.
 *
 *  `extension` is the word on the opening fence — `table`, `disabled`,
 *  `strikethrough`, `autolink`, `tagfilter` — and '' for a plain CommonMark
 *  example. Only the tagged ones are run; see the PROVENANCE for why. */
export interface GfmCase {
  markdown: string;
  html: string;
  example: number;
  section: string;
  extension: string;
  startLine: number;
}

const SPEC_URL = new URL('../fixtures/gfm/spec.txt', import.meta.url);
const FENCE = '`'.repeat(32);
const OPEN = `${FENCE} example`;

/** Tabs are written as U+2192 in the spec file, as in CommonMark's own. */
function body(lines: string[]): string {
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`.replace(/→/g, '\t');
}

let cached: GfmCase[] | undefined;

/** Every example in the file, in spec order, numbered as the spec numbers them. */
export function loadGfmExamples(): GfmCase[] {
  if (cached !== undefined) return cached;
  const lines = readFileSync(fileURLToPath(SPEC_URL), 'utf8').split('\n');
  const out: GfmCase[] = [];
  let section = '';
  let example = 0;

  for (let i = 0; i < lines.length; i++) {
    const heading = /^#{1,6} +(.*)$/.exec(lines[i]);
    if (heading !== null) { section = heading[1].trim(); continue; }
    if (!lines[i].startsWith(OPEN)) continue;

    const extension = lines[i].slice(OPEN.length).trim();
    const startLine = i + 1;
    example++;

    const markdown: string[] = [];
    const html: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j] !== '.'; j++) markdown.push(lines[j]);
    for (j++; j < lines.length && !lines[j].startsWith(FENCE); j++) html.push(lines[j]);
    i = j;

    out.push({ markdown: body(markdown), html: body(html), example, section, extension, startLine });
  }

  cached = out;
  return out;
}

/** The examples GitHub tagged with an extension name — the only ones we run. */
export function gfmExtensionCases(): GfmCase[] {
  return loadGfmExamples().filter((c) => c.extension !== '');
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/gfm-spec.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures/gfm test/helpers/gfm-suite.ts test/gfm-spec.test.ts
git commit -m "test(md): vendor GitHub's spec.txt and load its 24 extension examples (gl6o.2)"
```

---

### Task 2: `MarkdownOptions` plumbing and strikethrough

The first vertical slice: it introduces the option, threads it into both phases, and lands one extension end to end.

**Files:**
- Modify: `src/mdast.ts` (add `MdStrikethrough`, extend `MdInline`)
- Modify: `src/markdown.ts` (the options argument)
- Modify: `src/mdblock.ts:791` (`parseBlocks` signature, `gfm` field on `BlockParser`)
- Modify: `src/mdinline.ts` (`parseInlines`/`walk`/`InlineParser` signatures, `~` handling)
- Create: `src/mdgfm.ts`
- Modify: `test/helpers/md-html.ts` (`<del>`)
- Create: `test/gfm-ast.test.ts`
- Modify: `test/gfm-spec.test.ts` (run the strikethrough examples)

**Interfaces:**
- Consumes: `gfmExtensionCases()` from Task 1.
- Produces:
  - `export interface MdStrikethrough { type: 'strikethrough'; children: MdInline[] }` in `mdast.ts`
  - `export interface MarkdownOptions { gfm?: boolean }` in `markdown.ts`
  - `export function parseMarkdown(src: string, options?: MarkdownOptions): MdDocument`
  - `export function parseBlocks(lines: string[], gfm?: boolean): BlockResult`
  - `export function parseInlines(doc: MdDocument, refs: Map<string, LinkRef>, gfm?: boolean): void`
  - `src/mdgfm.ts` exists and exports `export function strikeDelimiters(n: number): boolean` — whether a run of `n` tildes may join the delimiter stack.

- [ ] **Step 1: Write the failing tests**

Add to `test/gfm-spec.test.ts` (import `parseMarkdown` and `renderHtml` at the top):

```ts
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

describe('strikethrough', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'strikethrough')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }))).toBe(c.html);
    });
  }
});
```

Create `test/gfm-ast.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdParagraph } from '../src/mdast.js';

/** The tree assertions the HTML oracle cannot make. */

function para(src: string, gfm = true): MdParagraph {
  const doc = parseMarkdown(src, { gfm });
  const first = doc.children[0];
  if (first.type !== 'paragraph') throw new Error(`expected a paragraph, got ${first.type}`);
  return first;
}

describe('strikethrough', () => {
  it('is off unless gfm is asked for', () => {
    expect(para('~~x~~', false).children).toEqual([{ type: 'text', value: '~~x~~' }]);
  });

  it('accepts a single tilde, as cmark-gfm does', () => {
    expect(para('~x~').children).toEqual([
      { type: 'strikethrough', children: [{ type: 'text', value: 'x' }] },
    ]);
  });

  it('leaves a run of three tildes literal', () => {
    expect(para('~~~x~~~').children).toEqual([{ type: 'text', value: '~~~x~~~' }]);
  });

  it('requires the opener and closer runs to be the same length', () => {
    expect(para('~~x~').children).toEqual([{ type: 'text', value: '~~x~' }]);
  });

  it('nests with emphasis on the one delimiter stack', () => {
    expect(para('~~*x*~~').children).toEqual([
      {
        type: 'strikethrough',
        children: [{ type: 'emph', children: [{ type: 'text', value: 'x' }] }],
      },
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/gfm-ast.test.ts test/gfm-spec.test.ts`
Expected: FAIL — `parseMarkdown` takes one argument, and `~~x~~` renders as literal text.

- [ ] **Step 3: Add the node type**

In `src/mdast.ts`, after `MdCode`:

```ts
/** GFM strikethrough. Wraps inlines exactly as emph and strong do. */
export interface MdStrikethrough { type: 'strikethrough'; children: MdInline[]; }
```

and add `| MdStrikethrough` to the `MdInline` union.

- [ ] **Step 4: Add the options argument**

Replace the body of `src/markdown.ts`:

```ts
import type { MdDocument } from './mdast.js';
import { parseBlocks } from './mdblock.js';
import { parseInlines } from './mdinline.js';

/** Options for `parseMarkdown`. */
export interface MarkdownOptions {
  /** Enable the five GitHub Flavored Markdown extensions: tables, task list
   *  items, strikethrough, extended autolinks and disallowed raw HTML.
   *
   *  Off by default, so the default path is strict CommonMark 0.31.2 — the one
   *  the 652-case conformance suite pins. */
  gfm?: boolean;
}

/** Parse CommonMark 0.31.2 into an abstract syntax tree.
 *
 *  Never throws: every string is a valid Markdown document. Unlike every other
 *  parser in this library there is no PdfParseError path — damage shows up as
 *  literal text. */
export function parseMarkdown(src: string, options?: MarkdownOptions): MdDocument {
  const gfm = options?.gfm === true;
  // Line endings normalize on entry and NUL becomes U+FFFD, as the spec requires.
  const text = src.replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const { doc, refs } = parseBlocks(lines, gfm);
  parseInlines(doc, refs, gfm);
  return doc;
}
```

Note: the existing file writes the replacement character literally (`'�'`). Keep whichever spelling is already there — do not "fix" it; `�` above is the same character.

- [ ] **Step 5: Thread `gfm` through the block phase**

In `src/mdblock.ts`, add a field and constructor parameter to `BlockParser`:

```ts
class BlockParser {
  doc: Open;
  tip: Open;
  oldTip: Open;
  refs = new Map<string, LinkRef>();
  /** Whether the GFM extensions are enabled. Off leaves every hook below dead. */
  gfm: boolean;
  ...
  constructor(gfm: boolean) {
    this.gfm = gfm;
    ...
  }
```

and the entry point at the bottom of the file:

```ts
export function parseBlocks(lines: string[], gfm = false): BlockResult {
  const p = new BlockParser(gfm);
  for (const line of lines) p.incorporateLine(line);
  return p.finish();
}
```

- [ ] **Step 6: Thread `gfm` through the inline phase**

In `src/mdinline.ts`:

```ts
export function parseInlines(doc: MdDocument, refs: Map<string, LinkRef>, gfm = false): void {
  walk(doc, refs, gfm);
}

function walk(block: MdBlock, refs: Map<string, LinkRef>, gfm: boolean): void {
  switch (block.type) {
    case 'document':
    case 'block_quote':
    case 'item':
    case 'list':
      for (const c of block.children) walk(c, refs, gfm);
      return;
    case 'paragraph':
    case 'heading': {
      const raw = staged(block.children);
      block.children = raw === '' ? [] : new InlineParser(raw.trim(), refs, gfm).parse();
      return;
    }
    default:
      return;
  }
}
```

and on the class:

```ts
class InlineParser {
  ...
  gfm: boolean;

  constructor(subject: string, refs: Map<string, LinkRef>, gfm = false) {
    this.subject = subject;
    this.refs = refs;
    this.gfm = gfm;
  }
```

- [ ] **Step 7: Create `src/mdgfm.ts` with the tilde run rule**

```ts
/** The GitHub Flavored Markdown extensions that are not the table block:
 *  strikethrough, task list items, extended autolinks, and the disallowed-raw-HTML
 *  filter.
 *
 *  Pure: strings and data in, strings and data out. Nothing here touches a
 *  Document or allocates a PDF object, and nothing here imports the block or
 *  inline phase — the phase modules call in, never the other way round. */

/** Whether a run of `n` tildes may join the delimiter stack.
 *
 *  One or two, never three or more — cmark-gfm's strikethrough.c pushes a
 *  delimiter only for `delims == 2 || delims == 1`, so `~~~x~~~` is literal
 *  text. The spec's prose says "two tildes" and its two examples only use two;
 *  the single-tilde form is real GitHub behaviour and is pinned by hand in
 *  test/gfm-ast.test.ts. */
export function strikeDelimiters(n: number): boolean {
  return n === 1 || n === 2;
}
```

- [ ] **Step 8: Handle `~` in the inline parser**

In `src/mdinline.ts`, import the rule and add a GFM text-run regex:

```ts
import { strikeDelimiters } from './mdgfm.js';

const TEXT_RUN = /[^\n`[\]\\!<&*_]+/y;
/** `~` is a delimiter only under GFM, so the run regex forks rather than
 *  breaking every ordinary text run on a tilde. */
const TEXT_RUN_GFM = /[^\n`[\]\\!<&*_~]+/y;
```

Widen the delimiter char type:

```ts
interface Delim {
  cc: '*' | '_' | '~';
  ...
```

In `parse()`, add the case beside `*`/`_`:

```ts
        case '*':
        case '_': ok = this.handleDelim(c); break;
        case '~': ok = this.gfm ? this.handleDelim(c) : false; break;
```

In `parseString()`, pick the regex:

```ts
  parseString(): void {
    const run = this.match(this.gfm ? TEXT_RUN_GFM : TEXT_RUN);
    if (run !== undefined) { this.text(run); return; }
    // A special character no rule claimed is ordinary text.
    this.text(this.subject[this.pos]);
    this.pos++;
  }
```

In `handleDelim`, gate the push for `~` (`scanDelims` needs no change — its
`cc === '_' ? ... : leftFlanking` branch already gives `~` the `*` rules, which
is what cmark-gfm uses):

```ts
    const node = this.text(this.subject.slice(start, this.pos));
    const eligible = cc === '~' ? strikeDelimiters(res.numdelims) : true;
    if (eligible && (res.canOpen || res.canClose)) {
```

- [ ] **Step 9: Resolve `~` pairs in `processEmphasis`**

In `src/mdinline.ts`, add the branch at the top of the `while (closer !== undefined)` loop in `processEmphasis`, immediately after the `canClose` check:

```ts
      if (!closer.canClose) { closer = closer.next; continue; }
      if (closer.cc === '~') { closer = this.strikethrough(closer, stackBottom); continue; }
```

and the method beside it:

```ts
  /** cmark-gfm's strikethrough `insert`: the nearest '~' opener wins the search
   *  regardless of length, and the pair only wraps when the two runs are the
   *  SAME length. Either way every delimiter between the two ends dies, which is
   *  why a failed match cannot be retried against an opener further back. */
  strikethrough(closer: Delim, stackBottom: Delim | undefined): Delim | undefined {
    const next = closer.next;
    let opener = closer.prev;
    while (opener !== undefined && opener !== stackBottom && !(opener.cc === '~' && opener.canOpen)) {
      opener = opener.prev;
    }
    if (opener === undefined || opener === stackBottom) {
      if (!closer.canOpen) this.removeDelimiter(closer);
      return next;
    }
    if (opener.numdelims === closer.numdelims) {
      const children = this.list.extract(opener.node, closer.node);
      this.list.insertAfter(opener.node, { type: 'strikethrough', children });
      this.list.remove(opener.node);
      this.list.remove(closer.node);
    }
    this.removeDelimitersBetween(opener, closer);
    this.removeDelimiter(closer);
    this.removeDelimiter(opener);
    return next;
  }
```

- [ ] **Step 10: Render `<del>` in the oracle**

In `test/helpers/md-html.ts`, add a case to `inline()`:

```ts
      case 'strikethrough': this.lit('<del>'); this.inlines(n.children); this.lit('</del>'); break;
```

(`plainText`'s `default` branch already recurses into its children, so an image
alt containing strikethrough keeps its text.)

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npx vitest run test/gfm-ast.test.ts test/gfm-spec.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS — the two strikethrough examples, the five AST assertions, and all 652 CommonMark cases.

- [ ] **Step 12: Confirm the assertions are load-bearing**

Temporarily change `strikeDelimiters` to `return n >= 1 && n <= 3;` and re-run
`npx vitest run test/gfm-ast.test.ts`. Expected: the "run of three tildes"
test FAILS. Revert. Then temporarily drop the `opener.numdelims === closer.numdelims`
condition and re-run. Expected: the "same length" test FAILS. Revert.

- [ ] **Step 13: Commit**

```bash
git add src/mdast.ts src/markdown.ts src/mdblock.ts src/mdinline.ts src/mdgfm.ts test/helpers/md-html.ts test/gfm-ast.test.ts test/gfm-spec.test.ts
git commit -m "feat(md): parseMarkdown options and GFM strikethrough (gl6o.2)"
```

---

### Task 3: Task list items

**Files:**
- Modify: `src/mdast.ts` (`MdItem.checked`)
- Modify: `src/mdblock.ts` (`finalize`'s `item` case + a helper)
- Modify: `test/helpers/md-html.ts` (the checkbox)
- Modify: `test/gfm-spec.test.ts`, `test/gfm-ast.test.ts`

**Interfaces:**
- Consumes: `BlockParser.gfm` (Task 2).
- Produces: `MdItem.checked?: boolean` — absent on an ordinary item, `false` for `[ ]`, `true` for `[x]`/`[X]`.

- [ ] **Step 1: Write the failing tests**

Add to `test/gfm-spec.test.ts`:

```ts
describe('task list items', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'disabled')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }))).toBe(c.html);
    });
  }
});
```

Add to `test/gfm-ast.test.ts` (import `MdList` alongside `MdParagraph`):

```ts
function list(src: string, gfm = true): MdList {
  const first = parseMarkdown(src, { gfm }).children[0];
  if (first.type !== 'list') throw new Error(`expected a list, got ${first.type}`);
  return first;
}

describe('task list items', () => {
  it('records the marker and strips it from the content', () => {
    const l = list('- [ ] foo\n- [x] bar');
    expect(l.children.map((i) => i.checked)).toEqual([false, true]);
    expect(l.children[0].children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: 'foo' }] },
    ]);
  });

  it('accepts an uppercase X, which the prose mandates', () => {
    expect(list('- [X] foo').children[0].checked).toBe(true);
  });

  it('leaves an ordinary item undefined rather than false', () => {
    expect(list('- foo').children[0].checked).toBeUndefined();
  });

  it('needs whitespace after the marker', () => {
    const l = list('- [x]foo');
    expect(l.children[0].checked).toBeUndefined();
    expect(l.children[0].children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '[x]foo' }] },
    ]);
  });

  it('is off unless gfm is asked for', () => {
    expect(list('- [ ] foo', false).children[0].checked).toBeUndefined();
  });

  // The marker must not disturb what drives paragraph spacing in Flow.
  it('leaves list tightness alone', () => {
    expect(list('- [ ] a\n- [ ] b').tight).toBe(true);
    expect(list('- [ ] a\n\n- [ ] b').tight).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/gfm-ast.test.ts test/gfm-spec.test.ts`
Expected: FAIL — `checked` does not exist on `MdItem`.

- [ ] **Step 3: Add the field**

In `src/mdast.ts`:

```ts
export interface MdItem {
  type: 'item';
  /** GFM task list marker: absent on an ordinary item, false for `[ ]`, true
   *  for `[x]`. The marker itself is stripped from the item's content. */
  checked?: boolean;
  children: MdBlock[];
}
```

- [ ] **Step 4: Strip the marker at item finalize**

In `src/mdblock.ts`, add a case to `finalize`'s switch (before `default`):

```ts
      case 'item':
        if (this.gfm) applyTaskMarker(block);
        break;
```

and the helper beside `stageText` at the bottom of the file:

```ts
/** GFM task list items.
 *
 *  The marker is `[ ]`, `[x]` or `[X]` at the very start of the item's first
 *  paragraph, followed by at least one space or tab. It is stripped from the
 *  content and recorded on the node, so no consumer has to know the syntax —
 *  and so a renderer cannot accidentally draw the brackets.
 *
 *  Runs at item finalize, by which point the paragraph has already been
 *  finalized and staged (finalize always walks inner blocks first).
 *
 *  Note `[X]`: cmark-gfm's own scanner matches only the lowercase form, but the
 *  spec's prose says "either lowercase or uppercase" and its own strstr check
 *  looks for both. The prose wins; the examples use neither. */
const TASK_MARKER = /^\[([ xX])\][ \t\v\f]+/;

function applyTaskMarker(item: Open): void {
  const first = item.children[0];
  if (first === undefined || first.kind !== 'paragraph') return;
  const p = first.node as MdParagraph;
  const raw = p.children.length === 1 && p.children[0].type === 'text' ? p.children[0].value : '';
  const m = TASK_MARKER.exec(raw);
  if (m === null) return;
  (item.node as MdItem).checked = m[1] !== ' ';
  // An item that was nothing but a marker leaves an empty paragraph, which
  // assemble() then drops.
  stageText(p, raw.slice(m[0].length));
}
```

- [ ] **Step 5: Render the checkbox in the oracle**

In `test/helpers/md-html.ts`, replace the `item` case:

```ts
      case 'item':
        this.cr();
        this.lit('<li>');
        // The space is the one that followed the marker. The parser drops it as
        // insignificant leading whitespace — the AST cannot carry it, since a
        // leaf's staged text is trimmed before inline parsing — so the oracle
        // puts it back, exactly as it puts back percent-encoding.
        if (n.checked !== undefined) {
          this.lit(`<input ${n.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `);
        }
        this.blocks(n.children, tight);
        this.lit('</li>');
        this.cr();
        break;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/gfm-ast.test.ts test/gfm-spec.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Confirm the assertions are load-bearing**

Temporarily relax `TASK_MARKER` to `/^\[([ xX])\]/` (dropping the whitespace
requirement) and re-run `npx vitest run test/gfm-ast.test.ts`. Expected: the
"needs whitespace after the marker" test FAILS. Revert.

- [ ] **Step 8: Commit**

```bash
git add src/mdast.ts src/mdblock.ts test/helpers/md-html.ts test/gfm-ast.test.ts test/gfm-spec.test.ts
git commit -m "feat(md): GFM task list items (gl6o.2)"
```

---

### Task 4: `src/mdtable.ts` — the table grammar, standalone

Pure module, no wiring. Every rule here is transcribed from `cmark-gfm`'s
`extensions/ext_scanners.re` and `row_from_string` in `extensions/table.c`.

**Files:**
- Modify: `src/mdast.ts` (`MdAlign`, `MdTable`, `MdTableRow`, `MdTableCell`, type sets)
- Create: `src/mdtable.ts`
- Create: `test/mdtable.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export type MdAlign = 'left' | 'center' | 'right'` (in `mdast.ts`)
  - `export function scanDelimiterRow(line: string): (MdAlign | null)[] | undefined` — the per-column alignment, or `undefined` when the line is not a delimiter row.
  - `export function splitRow(line: string): string[]` — the row's cells, trimmed, with `\|` unescaped to `|`. Never empty for a non-blank line.
  - `export function buildRows(lines: string[], columns: number): MdTableRow[]` — `lines[0]` is the header; body rows pad and truncate to `columns`.

- [ ] **Step 1: Write the failing tests**

Create `test/mdtable.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scanDelimiterRow, splitRow, buildRows } from '../src/mdtable.js';

describe('scanDelimiterRow', () => {
  it('reads alignment off each cell', () => {
    expect(scanDelimiterRow('| --- | :-- | :-: | --: |')).toEqual([null, 'left', 'center', 'right']);
  });

  it('accepts missing outer pipes and loose spacing', () => {
    expect(scanDelimiterRow(':-:  |   -----------:')).toEqual(['center', 'right']);
  });

  it('rejects a line with no dashes', () => {
    expect(scanDelimiterRow('| : | : |')).toBeUndefined();
  });

  it('rejects ordinary text', () => {
    expect(scanDelimiterRow('| abc | def |')).toBeUndefined();
    expect(scanDelimiterRow('---x')).toBeUndefined();
  });

  // A single-column table needs a pipe, or `---` under a paragraph would be a
  // setext heading and `- - -` a thematic break.
  it('reads a single column only when a pipe is present', () => {
    expect(scanDelimiterRow('| --- |')).toEqual([null]);
    expect(scanDelimiterRow('| ---')).toEqual([null]);
    expect(scanDelimiterRow('---')).toBeUndefined();
  });
});

describe('splitRow', () => {
  it('drops the optional outer pipes and trims each cell', () => {
    expect(splitRow('| abc | def |')).toEqual(['abc', 'def']);
    expect(splitRow('bar | baz')).toEqual(['bar', 'baz']);
  });

  it('unescapes an escaped pipe into the cell text', () => {
    expect(splitRow('| f\\|oo  |')).toEqual(['f|oo']);
    expect(splitRow('| b `\\|` az |')).toEqual(['b `|` az']);
  });

  it('keeps empty cells', () => {
    expect(splitRow('| a || b |')).toEqual(['a', '', 'b']);
  });

  it('treats a line with no pipe as one cell', () => {
    expect(splitRow('bar')).toEqual(['bar']);
  });
});

describe('buildRows', () => {
  it('marks the first row as the header', () => {
    const rows = buildRows(['| a | b |', '| c | d |'], 2);
    expect(rows.map((r) => r.header)).toEqual([true, false]);
    expect(rows[1].children.map((c) => c.children)).toEqual([
      [{ type: 'text', value: 'c' }],
      [{ type: 'text', value: 'd' }],
    ]);
  });

  it('pads a short body row and truncates a long one', () => {
    const rows = buildRows(['| a | b |', '| bar |', '| bar | baz | boo |'], 2);
    expect(rows[1].children.map((c) => c.children)).toEqual([[{ type: 'text', value: 'bar' }], []]);
    expect(rows[2].children.map((c) => c.children)).toEqual([
      [{ type: 'text', value: 'bar' }],
      [{ type: 'text', value: 'baz' }],
    ]);
  });

  it('builds a header-only table', () => {
    expect(buildRows(['| a |'], 1).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mdtable.test.ts`
Expected: FAIL — cannot resolve `../src/mdtable.js`.

- [ ] **Step 3: Add the node types**

In `src/mdast.ts`, after `MdHtmlBlock`:

```ts
/** GFM table alignment, from the `:` markers on the delimiter row. */
export type MdAlign = 'left' | 'center' | 'right';
/** `align` carries one entry per column, null where the delimiter row gave
 *  none — which is not the same as 'left', since a renderer may have its own
 *  default. */
export interface MdTable { type: 'table'; align: (MdAlign | null)[]; children: MdTableRow[]; }
export interface MdTableRow { type: 'table_row'; header: boolean; children: MdTableCell[]; }
/** Holds inlines, like a paragraph does. */
export interface MdTableCell { type: 'table_cell'; children: MdInline[]; }
```

Extend the union and the type sets:

```ts
export type MdBlock =
  | MdDocument | MdBlockQuote | MdList | MdItem
  | MdParagraph | MdHeading | MdThematicBreak | MdCodeBlock | MdHtmlBlock
  | MdTable | MdTableRow | MdTableCell;

const BLOCK_TYPES = new Set<string>([
  'document', 'block_quote', 'list', 'item',
  'paragraph', 'heading', 'thematic_break', 'code_block', 'html_block',
  'table', 'table_row', 'table_cell',
]);
/** Blocks whose children are themselves blocks. A cell is not one: like a
 *  paragraph, its children are inlines. */
const CONTAINER_TYPES = new Set<string>(['document', 'block_quote', 'list', 'item', 'table', 'table_row']);
```

- [ ] **Step 4: Write `src/mdtable.ts`**

```ts
import type { MdAlign, MdTableCell, MdTableRow } from './mdast.js';

/** The GFM table block grammar: delimiter row, cell splitting, row building.
 *
 *  Pure — strings in, data out. It never sees a Document and never parses an
 *  inline: a cell's text is staged raw and mdinline.ts replaces it, exactly as
 *  a paragraph's is.
 *
 *  Transcribed from cmark-gfm's ext_scanners.re and row_from_string:
 *
 *    spacechar    = [ \t\v\f]
 *    escaped_char = \\ followed by an ASCII punctuation character
 *    table_marker = spacechar* :? -+ :? spacechar*
 *    table_cell   = (escaped_char | [^|\r\n])+
 *    delimiter row = |? table_marker (| table_marker)* |? spacechar*
 */

const SPACE = '[ \\t\\v\\f]';
const MARKER = `${SPACE}*:?-+:?${SPACE}*`;
const DELIMITER_ROW = new RegExp(`^\\|?${MARKER}(?:\\|${MARKER})*\\|?${SPACE}*$`);

/** The alignment of each column, or undefined when this is not a delimiter row.
 *
 *  A single-column row must carry a pipe: without one, `---` under a paragraph
 *  is a setext heading and `- - -` is a thematic break, and both outrank a
 *  table. The regex allows a bare marker, so the pipe is checked here. */
export function scanDelimiterRow(line: string): (MdAlign | null)[] | undefined {
  if (!DELIMITER_ROW.test(line)) return undefined;
  if (!line.includes('|')) return undefined;
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  });
}

/** Split a row into trimmed cell texts.
 *
 *  Leading and trailing pipes are optional. `\|` is a literal pipe and does not
 *  split — and the unescape happens HERE, before any inline parsing, which is
 *  why a code span in a cell can contain a pipe at all (`b `\|` az` renders as
 *  <code>|</code>). A line with no pipe is one cell, which is what makes a bare
 *  `bar` line continue a table rather than end it. */
export function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let i = 0;
  // Skip one leading pipe, and the spaces after it.
  if (line[i] === '|') { i++; while (isSpace(line[i])) i++; }
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += c + line[i + 1]; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  // A trailing pipe closes the last cell rather than opening an empty one.
  if (cur.trim() !== '' || cells.length === 0) cells.push(cur.trim());
  return cells;
}

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\v' || c === '\f';
}

/** Build the table's rows. `lines[0]` is the header; every body row is padded
 *  with empty cells when short and truncated when long, which is the one place
 *  the header and the body differ (a header whose width disagrees with the
 *  delimiter row is not a table at all — that check lives in mdblock.ts). */
export function buildRows(lines: string[], columns: number): MdTableRow[] {
  return lines.map((line, i) => {
    const cells = splitRow(line);
    const children: MdTableCell[] = [];
    for (let c = 0; c < columns; c++) {
      const raw = cells[c] ?? '';
      children.push({ type: 'table_cell', children: raw === '' ? [] : [{ type: 'text', value: raw }] });
    }
    return { type: 'table_row', header: i === 0, children };
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/mdtable.test.ts && npm run typecheck`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add src/mdast.ts src/mdtable.ts test/mdtable.test.ts
git commit -m "feat(md): the GFM table grammar as a standalone module (gl6o.2)"
```

---

### Task 5: Wire the table into the block phase

**Files:**
- Modify: `src/mdblock.ts` (`Kind`, `ACCEPTS_LINES`, `canContain`, `tryStart`, `matchContinuation`, `incorporateLine:318`, `finalize`)
- Modify: `src/mdinline.ts` (`walk` descends into cells)
- Modify: `test/helpers/md-html.ts` (`<table>`)
- Modify: `test/gfm-spec.test.ts`, `test/gfm-ast.test.ts`

**Interfaces:**
- Consumes: `scanDelimiterRow`, `splitRow`, `buildRows` (Task 4); `BlockParser.gfm` (Task 2).
- Produces: an `MdTable` node in the tree, with cells holding staged raw text that the inline phase replaces.

- [ ] **Step 1: Write the failing tests**

Add to `test/gfm-spec.test.ts`:

```ts
describe('tables', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'table')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }))).toBe(c.html);
    });
  }
});
```

Add to `test/gfm-ast.test.ts` (import `MdTable`):

```ts
function table(src: string): MdTable {
  const first = parseMarkdown(src, { gfm: true }).children[0];
  if (first.type !== 'table') throw new Error(`expected a table, got ${first.type}`);
  return first;
}

describe('tables', () => {
  it('carries per-column alignment, with null for a column that gave none', () => {
    expect(table('| a | b | c |\n| :- | -: | --- |').align).toEqual(['left', 'right', null]);
  });

  it('marks the header row and only the header row', () => {
    const t = table('| a |\n| - |\n| b |\n| c |');
    expect(t.children.map((r) => r.header)).toEqual([true, false, false]);
  });

  it('parses inlines inside cells', () => {
    const t = table('| *a* |\n| - |');
    expect(t.children[0].children[0].children).toEqual([
      { type: 'emph', children: [{ type: 'text', value: 'a' }] },
    ]);
  });

  // Only the paragraph's LAST line becomes the header; the rest stays a paragraph.
  it('splits the paragraph above the header off', () => {
    const doc = parseMarkdown('lead in\n| a |\n| - |\n| b |', { gfm: true });
    expect(doc.children.map((n) => n.type)).toEqual(['paragraph', 'table']);
    expect(doc.children[0]).toEqual({
      type: 'paragraph', children: [{ type: 'text', value: 'lead in' }],
    });
  });

  it('needs the header and delimiter rows to have the same width', () => {
    expect(parseMarkdown('| a | b |\n| - |', { gfm: true }).children[0].type).toBe('paragraph');
  });

  it('is off unless gfm is asked for', () => {
    expect(parseMarkdown('| a |\n| - |').children[0].type).toBe('paragraph');
  });

  it('ends at a blank line but not at a pipeless line', () => {
    const doc = parseMarkdown('| a |\n| - |\nbar\n\nbaz', { gfm: true });
    expect(doc.children.map((n) => n.type)).toEqual(['table', 'paragraph']);
    expect((doc.children[0] as MdTable).children.length).toBe(2);
  });

  it('ends where another block begins', () => {
    const doc = parseMarkdown('| a |\n| - |\n> quote', { gfm: true });
    expect(doc.children.map((n) => n.type)).toEqual(['table', 'block_quote']);
  });

  it('works inside a block quote', () => {
    const doc = parseMarkdown('> | a |\n> | - |\n> | b |', { gfm: true });
    const quote = doc.children[0];
    if (quote.type !== 'block_quote') throw new Error('expected a block quote');
    expect(quote.children[0].type).toBe('table');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/gfm-ast.test.ts test/gfm-spec.test.ts`
Expected: FAIL — every table parses as a paragraph.

- [ ] **Step 3: Teach the block parser the `table` kind**

In `src/mdblock.ts`, extend the imports and the three tables:

```ts
import type {
  MdBlock, MdBlockQuote, MdCodeBlock, MdDocument, MdHeading, MdHtmlBlock, MdItem, MdList,
  MdParagraph, MdTable,
} from './mdast.js';
import { buildRows, scanDelimiterRow, splitRow } from './mdtable.js';

type Kind =
  | 'document' | 'block_quote' | 'list' | 'item'
  | 'paragraph' | 'heading' | 'code_block' | 'html_block' | 'thematic_break' | 'table';

/** Only these take the generic "attach the remainder" step. Everything else has
 *  already consumed whatever its opening line carried. */
const ACCEPTS_LINES = new Set<Kind>(['paragraph', 'code_block', 'html_block', 'table']);
```

`canContain` needs no change: `table` is not one of the listed parents, so it
falls through to `return false` and `addChild` finalizes the table before
opening anything inside it. Rows are built at finalize, never through `addChild`.

- [ ] **Step 4: Let new blocks interrupt a table, and let `tryStart` see a delimiter row**

In `incorporateLine`, line 318 currently reads:

```ts
    let matchedLeaf = container.kind !== 'paragraph' && ACCEPTS_LINES.has(container.kind);
```

Replace it with:

```ts
    // A table takes lines like a paragraph does, but must still let a new block
    // start on the next line — `# x` after a table is a heading, not a row.
    let matchedLeaf = container.kind !== 'paragraph' && container.kind !== 'table'
      && ACCEPTS_LINES.has(container.kind);
```

Six lines below, the loop bails out early for any line that cannot begin a
block, and a delimiter row begins with `|` or `:` — neither of which is in that
character class, so without this change `tryStart` is never reached and every
table silently stays a paragraph. Name the two classes beside the other block
regexes near line 102:

```ts
/** Characters that can begin a block. Cheap gate: a line starting with anything
 *  else cannot open one, so tryStart is not worth calling. GFM adds `|` and `:`
 *  for a table's delimiter row. */
const MAYBE_START = /^[#`~*+_=<>0-9-]/;
const MAYBE_START_GFM = /^[#`~*+_=<>0-9|:-]/;
```

and replace the literal in `incorporateLine`:

```ts
      if (!this.indented && !(this.gfm ? MAYBE_START_GFM : MAYBE_START).test(this.line.slice(this.nextNonspace))) {
        this.advanceNextNonspace();
        break;
      }
```

- [ ] **Step 5: Continue a table until a blank line**

In `matchContinuation`, add a case (a blank line is the only thing that closes
a table from here; another block start is handled by Step 4):

```ts
      case 'table':
        return this.blank ? 'closed' : 'matched';
```

- [ ] **Step 6: Open the table in `tryStart`**

In `src/mdblock.ts`, insert this branch immediately after the setext-heading
branch and before the thematic-break branch, inside the `if (!this.indented)` block:

```ts
      // GFM table. Structurally the same move as the setext heading above: the
      // open paragraph's last line is the header, and replaceChild swaps the
      // paragraph for the table. Any earlier paragraph lines stay behind as a
      // paragraph of their own.
      if (this.gfm && container.kind === 'paragraph') {
        const align = scanDelimiterRow(rest);
        const header = container.lines[container.lines.length - 1];
        if (align !== undefined && header !== undefined && splitRow(header).length === align.length) {
          this.closeUnmatched();
          const node: MdTable = { type: 'table', align, children: [] };
          const t: Open = {
            kind: 'table', node, parent: container.parent, children: [], open: true,
            lines: [header], startLine: container.startLine, lastLineBlank: false,
            depth: container.depth,
          };
          const above = container.lines.slice(0, -1);
          if (above.length > 0) {
            // The lead-in paragraph keeps the original Open; the table becomes
            // its sibling, so the two arrive in source order.
            container.lines = above;
            this.tip = container;
            this.finalize(container);
            container.parent?.children.push(t);
          } else {
            replaceChild(container, t);
          }
          this.tip = t;
          this.advance(this.line.length - this.pos, false);
          return { block: t, leaf: true };
        }
      }
```

- [ ] **Step 7: Build the rows at finalize**

In `finalize`'s switch, add before `default`:

```ts
      case 'table': {
        const n = block.node as MdTable;
        // The opening line contributes an empty string: 'table' is in
        // ACCEPTS_LINES, so incorporateLine attaches the remainder of the
        // delimiter row — which tryStart has already consumed — as a line. A
        // blank line closes the table rather than joining it, so this filter
        // can only ever drop that artifact.
        n.children = buildRows(block.lines.filter((l) => NON_SPACE.test(l)), n.align.length);
        break;
      }
```

- [ ] **Step 8: Parse inlines inside cells**

In `src/mdinline.ts`, add a case to `walk`:

```ts
    case 'table':
      for (const row of block.children) walk(row, refs, gfm);
      return;
    case 'table_row':
      for (const cell of block.children) walk(cell, refs, gfm);
      return;
    case 'table_cell': {
      const raw = staged(block.children);
      block.children = raw === '' ? [] : new InlineParser(raw.trim(), refs, gfm).parse();
      return;
    }
```

(`staged` takes `MdInline[]`; a cell's children are typed the same as a
paragraph's, so it applies unchanged.)

- [ ] **Step 9: Render the table in the oracle**

In `test/helpers/md-html.ts`, add to `block()`'s switch:

```ts
      case 'table': {
        this.cr();
        this.lit('<table>');
        this.cr();
        const [head, ...body] = n.children;
        if (head !== undefined) {
          this.lit('<thead>');
          this.cr();
          this.block(head, tight);
          this.lit('</thead>');
          this.cr();
        }
        // No rows in the body means no <tbody> at all.
        if (body.length > 0) {
          this.lit('<tbody>');
          this.cr();
          for (const row of body) this.block(row, tight);
          this.lit('</tbody>');
          this.cr();
        }
        this.lit('</table>');
        this.cr();
        break;
      }
      case 'table_row': {
        this.lit('<tr>');
        this.cr();
        const align = this.align;
        for (let i = 0; i < n.children.length; i++) {
          const a = align[i] === undefined || align[i] === null ? '' : ` align="${align[i]}"`;
          const tag = n.header ? 'th' : 'td';
          this.lit(`<${tag}${a}>`);
          this.inlines(n.children[i].children);
          this.lit(`</${tag}>`);
          this.cr();
        }
        this.lit('</tr>');
        this.cr();
        break;
      }
      case 'table_cell':
        // Rendered by its row, which needs the column index for the alignment.
        break;
```

and give the `Renderer` the field the row case reads, set by the table case:

```ts
class Renderer {
  buf = '';
  lastOut = '\n';
  /** The enclosing table's column alignments, which a row needs by index. */
  align: (MdAlign | null)[] = [];
```

with `this.align = n.align;` as the first line of the `table` case, and the
import updated to `import type { MdAlign, MdBlock, MdDocument, MdInline } from '../../src/mdast.js';`.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run test/gfm-ast.test.ts test/gfm-spec.test.ts test/mdtable.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS — the 8 table examples, the 9 AST assertions, and all 652 CommonMark cases still green.

- [ ] **Step 11: Confirm the assertions are load-bearing**

Temporarily drop the `splitRow(header).length === align.length` condition in
Step 6 and re-run `npx vitest run test/gfm-spec.test.ts`. Expected: the
"header row must match the delimiter row" example FAILS. Revert.

Then temporarily move the table branch ABOVE the setext branch and re-run
`npx vitest run test/commonmark-spec.test.ts`. Expected: setext heading cases
FAIL. Revert. (This is why the order is specified: a delimiter row and a setext
underline overlap on inputs like `| - |`.)

- [ ] **Step 12: Commit**

```bash
git add src/mdblock.ts src/mdinline.ts test/helpers/md-html.ts test/gfm-ast.test.ts test/gfm-spec.test.ts
git commit -m "feat(md): GFM tables in the block phase (gl6o.2)"
```

---

### Task 6: Extended autolinks

The largest task. Every rule is a transcription of `cmark-gfm`'s
`extensions/autolink.c`; the comments say which function each piece came from.

**Files:**
- Modify: `src/mdgfm.ts`
- Modify: `src/mdinline.ts` (`walk` runs the pass)
- Create: `test/mdgfm-autolink.test.ts`
- Modify: `test/gfm-spec.test.ts`

**Interfaces:**
- Consumes: `isPunctuation`, `isUnicodeWhitespace` from `src/mdscan.ts`.
- Produces: `export function extendedAutolinks(nodes: MdInline[]): MdInline[]` in `src/mdgfm.ts` — rewrites `text` nodes into text/link sequences, recursing into containers but never into a `link`.

- [ ] **Step 1: Write the failing tests**

Add to `test/gfm-spec.test.ts`:

```ts
describe('extended autolinks', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'autolink')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }))).toBe(c.html);
    });
  }
});
```

Create `test/mdgfm-autolink.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';
import type { MdInline, MdParagraph } from '../src/mdast.js';

function inlines(src: string, gfm = true): MdInline[] {
  const first = parseMarkdown(src, { gfm }).children[0];
  if (first.type !== 'paragraph') throw new Error(`expected a paragraph, got ${first.type}`);
  return (first as MdParagraph).children;
}

function link(dest: string, text: string): MdInline {
  return { type: 'link', destination: dest, title: '', children: [{ type: 'text', value: text }] };
}

describe('extended autolinks', () => {
  it('inserts http:// for a www. link', () => {
    expect(inlines('www.commonmark.org')).toEqual([link('http://www.commonmark.org', 'www.commonmark.org')]);
  });

  it('keeps the scheme of a bare url', () => {
    expect(inlines('http://commonmark.org')).toEqual([link('http://commonmark.org', 'http://commonmark.org')]);
  });

  it('prefixes mailto: for a bare address', () => {
    expect(inlines('foo@bar.baz')).toEqual([link('mailto:foo@bar.baz', 'foo@bar.baz')]);
  });

  it('does not double the scheme on an explicit mailto:', () => {
    expect(inlines('mailto:foo@bar.baz')).toEqual([link('mailto:foo@bar.baz', 'mailto:foo@bar.baz')]);
  });

  it('is off unless gfm is asked for', () => {
    expect(inlines('www.commonmark.org', false)).toEqual([{ type: 'text', value: 'www.commonmark.org' }]);
  });

  it('never fires inside a link', () => {
    expect(inlines('[www.a.com](/x)')).toEqual([
      { type: 'link', destination: '/x', title: '', children: [{ type: 'text', value: 'www.a.com' }] },
    ]);
  });

  it('never fires inside a code span', () => {
    expect(inlines('`www.a.com`')).toEqual([{ type: 'code', value: 'www.a.com' }]);
  });

  it('does not start mid-word', () => {
    expect(inlines('xwww.a.com')).toEqual([{ type: 'text', value: 'xwww.a.com' }]);
    expect(inlines('xhttp://a.com')).toEqual([{ type: 'text', value: 'xhttp://a.com' }]);
  });

  it('needs a dot in the domain', () => {
    expect(inlines('www.commonmark')).toEqual([{ type: 'text', value: 'www.commonmark' }]);
  });

  it('rejects an underscore in either of the last two segments', () => {
    expect(inlines('www.xxx.yyy._zzz')).toEqual([{ type: 'text', value: 'www.xxx.yyy._zzz' }]);
    expect(inlines('www._xxx.yyy.zzz')[0].type).toBe('link');
  });

  it('fires across an emphasis boundary on its own text node', () => {
    expect(inlines('*x* www.a.com')).toEqual([
      { type: 'emph', children: [{ type: 'text', value: 'x' }] },
      { type: 'text', value: ' ' },
      link('http://www.a.com', 'www.a.com'),
    ]);
  });

  // The '&' arrives as its own text node from the entity scanner; the pass sees
  // one merged run because NodeList.collect already joins adjacent text nodes.
  it('spans a text node boundary left by a failed entity', () => {
    expect(inlines('www.a.com/x?q=1&hl=en')).toEqual([
      link('http://www.a.com/x?q=1&hl=en', 'www.a.com/x?q=1&hl=en'),
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mdgfm-autolink.test.ts test/gfm-spec.test.ts`
Expected: FAIL — nothing autolinks.

- [ ] **Step 3: Write the character and trimming helpers**

Append to `src/mdgfm.ts`:

```ts
import type { MdInline } from './mdast.js';
import { isPunctuation, isUnicodeWhitespace } from './mdscan.js';

const isAlpha = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
const isAlnum = (c: string | undefined): boolean =>
  isAlpha(c) || (c !== undefined && c >= '0' && c <= '9');
/** cmark's isspace, which is C's: space, tab, and the four vertical forms. */
const isCSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\v' || c === '\f' || c === '\r';

/** cmark's is_valid_hostchar: neither Unicode whitespace nor punctuation.
 *  Ours is CommonMark 0.31's P*+S* class rather than cmark's hand-rolled table;
 *  the two agree on every ASCII character, which is all any spec example uses. */
function isHostChar(s: string, i: number): boolean {
  const cp = s.codePointAt(i);
  if (cp === undefined) return false;
  return !isUnicodeWhitespace(cp) && !isPunctuation(cp);
}

/** cmark's autolink_delim: where the link really ends.
 *
 *  `sub` starts at the link, `end` is the candidate length. Trailing sentence
 *  punctuation is dropped, a closing paren is kept only while the parens
 *  balance, a trailing `&entity;` is dropped whole, and a `<` ends the link
 *  outright. */
export function autolinkDelim(sub: string, end: number): number {
  let linkEnd = end;
  let opening = 0;
  let closing = 0;

  for (let i = 0; i < linkEnd; i++) {
    const c = sub[i];
    if (c === '<') { linkEnd = i; break; }
    if (c === '(') opening++;
    else if (c === ')') closing++;
  }

  while (linkEnd > 0) {
    const c = sub[linkEnd - 1];
    if (c === ')') {
      if (closing <= opening) return linkEnd;
      closing--;
      linkEnd--;
    } else if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':'
      || c === '*' || c === '_' || c === '~' || c === "'" || c === '"') {
      linkEnd--;
    } else if (c === ';') {
      let newEnd = linkEnd - 2;
      while (newEnd > 0 && isAlpha(sub[newEnd])) newEnd--;
      if (newEnd < linkEnd - 2 && sub[newEnd] === '&') linkEnd = newEnd;
      else linkEnd--;
    } else {
      return linkEnd;
    }
  }
  return linkEnd;
}

/** cmark's check_domain: the length of the domain at the start of `s`, or 0.
 *
 *  `allowShort` drops the requirement of a dot — a scheme'd URL may point at a
 *  bare host, a `www.` link may not. The underscore rule bars `_` from either
 *  of the last two segments, because host names may not carry one; it is
 *  skipped past ten segments, which is cmark's own denial-of-service guard.
 *
 *  The loop bounds (from 1, to length-1) are cmark's: the first and last
 *  characters are never examined here, and the caller extends past the end. */
export function checkDomain(s: string, allowShort: boolean): number {
  let np = 0;
  let uscore1 = 0;
  let uscore2 = 0;
  let i = 1;
  for (; i < s.length - 1; i++) {
    if (s[i] === '\\' && i < s.length - 2) i++;
    if (s[i] === '_') uscore2++;
    else if (s[i] === '.') { uscore1 = uscore2; uscore2 = 0; np++; }
    else if (!isHostChar(s, i) && s[i] !== '-') break;
  }
  if ((uscore1 > 0 || uscore2 > 0) && np <= 10) return 0;
  if (allowShort) return i;
  return np > 0 ? i : 0;
}
```

- [ ] **Step 4: Write the www and url scanner**

Append to `src/mdgfm.ts`:

```ts
const SCHEME = /(?:https?|ftp):\/\//gi;

function mkLink(destination: string, text: string): MdInline {
  return { type: 'link', destination, title: '', children: [{ type: 'text', value: text }] };
}

/** cmark's www_match and url_match, over one text node.
 *
 *  cmark runs these during inline parsing, on the trigger characters 'w' and
 *  ':'. Running them here instead costs one divergence, recorded rather than
 *  hidden: cmark refuses to autolink while a bracket is open, so
 *  `[a www.b.com]` with no matching reference stays plain text there and
 *  becomes a link here. No spec example covers it. */
function splitUrls(s: string): MdInline[] {
  const out: MdInline[] = [];
  let base = 0;
  let i = 0;

  while (i < s.length) {
    SCHEME.lastIndex = i;
    const m = SCHEME.exec(s);
    const url = m === null ? -1 : m.index;
    const www = s.indexOf('www.', i);
    if (url < 0 && www < 0) break;

    const isWww = url < 0 || (www >= 0 && www < url);
    const start = isWww ? www : url;
    let end = 0;

    if (isWww) {
      // The character before must be start-of-text, whitespace, or one of *_~(.
      const prev = start === 0 ? undefined : s[start - 1];
      if (prev === undefined || isCSpace(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') {
        const domain = checkDomain(s.slice(start), false);
        if (domain > 0) end = start + domain;
      }
    } else {
      // A scheme preceded by a letter is part of a longer word, not a scheme.
      const afterScheme = start + m![0].length;
      if (!isAlpha(s[start - 1]) && isHostChar(s, afterScheme)) {
        const domain = checkDomain(s.slice(afterScheme), true);
        if (domain > 0) end = afterScheme + domain;
      }
    }

    if (end === 0) { i = start + 1; continue; }

    while (end < s.length && !isCSpace(s[end]) && s[end] !== '<') end++;
    const len = autolinkDelim(s.slice(start), end - start);
    if (len === 0) { i = start + 1; continue; }

    const text = s.slice(start, start + len);
    if (start > base) out.push({ type: 'text', value: s.slice(base, start) });
    out.push(mkLink(isWww ? `http://${text}` : text, text));
    base = start + len;
    i = base;
  }

  if (base < s.length) out.push({ type: 'text', value: s.slice(base) });
  return out;
}
```

- [ ] **Step 5: Write the email scanner**

Append to `src/mdgfm.ts`:

```ts
/** cmark's validate_protocol: whether `protocol` sits immediately before the
 *  local part, and is itself preceded by a non-alphanumeric. */
function validateProtocol(protocol: string, s: string, at: number, rewind: number, maxRewind: number): boolean {
  const len = protocol.length;
  if (len > maxRewind - rewind) return false;
  const from = at - rewind - len;
  if (s.slice(from, from + len) !== protocol) return false;
  if (len === maxRewind - rewind) return true;
  return !isAlnum(s[from - 1]);
}

/** cmark's postprocess_text: bare email addresses, plus explicit mailto: and
 *  xmpp: URLs, which share the same local-part grammar.
 *
 *  Runs after splitUrls, mirroring cmark's ordering — there, www/url match
 *  during inline parsing and this runs as a postprocess, so a scheme'd URL
 *  containing an '@' is already a link and never reaches here. */
function splitEmails(s: string): MdInline[] {
  const out: MdInline[] = [];
  let base = 0;
  let offset = 0;

  while (base + offset < s.length) {
    const at0 = s.indexOf('@', base + offset);
    if (at0 < 0) break;

    let maxRewind = at0 - (base + offset);
    let rewind = 0;
    let autoMailto = true;
    let isXmpp = false;
    let linkEnd = 0;
    let np = 0;
    let retry = true;
    let abandoned = false;

    while (retry) {
      retry = false;
      const at = base + offset + maxRewind;

      autoMailto = true;
      isXmpp = false;
      for (rewind = 0; rewind < maxRewind; rewind++) {
        const c = s[at - rewind - 1];
        if (isAlnum(c) || c === '.' || c === '+' || c === '-' || c === '_') continue;
        if (c === ':') {
          if (validateProtocol('mailto:', s, at, rewind, maxRewind)) { autoMailto = false; continue; }
          if (validateProtocol('xmpp:', s, at, rewind, maxRewind)) { autoMailto = false; isXmpp = true; continue; }
        }
        break;
      }
      if (rewind === 0) { offset += maxRewind + 1; abandoned = true; break; }

      np = 0;
      const limit = s.length - at;
      for (linkEnd = 1; linkEnd < limit; linkEnd++) {
        const c = s[at + linkEnd];
        if (isAlnum(c)) continue;
        if (c === '@') {
          // Another '@': start again from just past the first one.
          offset += maxRewind + 1;
          maxRewind = linkEnd - 1;
          retry = true;
          break;
        }
        if (c === '.' && linkEnd < limit - 1 && isAlnum(s[at + linkEnd + 1])) np++;
        else if (c === '/' && isXmpp) continue;
        else if (c !== '-' && c !== '_') break;
      }
    }
    if (abandoned) continue;

    const at = base + offset + maxRewind;
    const last = s[at + linkEnd - 1];
    if (linkEnd < 2 || np === 0 || (!isAlpha(last) && last !== '.')) {
      offset += maxRewind + linkEnd;
      continue;
    }

    linkEnd = autolinkDelim(s.slice(at), linkEnd);
    if (linkEnd === 0) { offset += maxRewind + 1; continue; }

    const start = at - rewind;
    if (start > base) out.push({ type: 'text', value: s.slice(base, start) });
    const text = s.slice(start, at + linkEnd);
    out.push(mkLink(autoMailto ? `mailto:${text}` : text, text));
    base = at + linkEnd;
    offset = 0;
  }

  if (base < s.length) out.push({ type: 'text', value: s.slice(base) });
  return out;
}

/** Rewrite every text node into a text/link sequence.
 *
 *  Recurses into containers but NEVER into a link, so links do not nest — the
 *  same guarantee CommonMark's bracket stack gives. Code spans and existing
 *  links are already their own node types by the time this runs, so the two
 *  contexts an autolink must not fire in are structurally excluded rather than
 *  re-derived. */
export function extendedAutolinks(nodes: MdInline[]): MdInline[] {
  const out: MdInline[] = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      for (const piece of splitUrls(n.value)) {
        if (piece.type !== 'text') { out.push(piece); continue; }
        out.push(...splitEmails(piece.value));
      }
      continue;
    }
    if (n.type === 'link') { out.push(n); continue; }
    if (n.type === 'emph' || n.type === 'strong' || n.type === 'strikethrough' || n.type === 'image') {
      n.children = extendedAutolinks(n.children);
    }
    out.push(n);
  }
  return out;
}
```

- [ ] **Step 6: Run the pass from the inline phase**

In `src/mdinline.ts`, import it and apply it to every leaf's parsed inlines:

```ts
import { extendedAutolinks, strikeDelimiters } from './mdgfm.js';
```

and in `walk`, replace the two parse sites (`paragraph`/`heading`, and the
`table_cell` case from Task 5) with a shared helper defined below `walk`:

```ts
function parseLeaf(raw: string, refs: Map<string, LinkRef>, gfm: boolean): MdInline[] {
  if (raw === '') return [];
  const nodes = new InlineParser(raw.trim(), refs, gfm).parse();
  return gfm ? extendedAutolinks(nodes) : nodes;
}
```

so the cases read `block.children = parseLeaf(staged(block.children), refs, gfm);`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/mdgfm-autolink.test.ts test/gfm-spec.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS — the 11 autolink examples, the 12 hand-written cases, and all 652 CommonMark cases.

- [ ] **Step 8: Confirm the assertions are load-bearing**

Temporarily make `extendedAutolinks` recurse into a `link` (drop the
`if (n.type === 'link')` early return) and re-run
`npx vitest run test/mdgfm-autolink.test.ts`. Expected: "never fires inside a
link" FAILS. Revert.

Temporarily change `checkDomain`'s last line to `return i;` and re-run.
Expected: "needs a dot in the domain" FAILS. Revert.

Temporarily return `end` from `autolinkDelim` unchanged and re-run
`npx vitest run test/gfm-spec.test.ts`. Expected: several autolink examples
FAIL on trailing punctuation. Revert.

- [ ] **Step 9: Commit**

```bash
git add src/mdgfm.ts src/mdinline.ts test/mdgfm-autolink.test.ts test/gfm-spec.test.ts
git commit -m "feat(md): GFM extended autolinks (gl6o.2)"
```

---

### Task 7: Disallowed raw HTML

**Files:**
- Modify: `src/mdgfm.ts`
- Modify: `test/helpers/md-html.ts` (apply the filter)
- Modify: `test/gfm-spec.test.ts`
- Create: `test/mdgfm-tagfilter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function filterDisallowedHtml(html: string): string`.

- [ ] **Step 1: Write the failing tests**

Add to `test/gfm-spec.test.ts`:

```ts
describe('disallowed raw HTML', () => {
  for (const c of gfmExtensionCases().filter((x) => x.extension === 'tagfilter')) {
    it(`example ${c.example} (spec line ${c.startLine})`, () => {
      expect(renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })).toBe(c.html);
    });
  }
});
```

Create `test/mdgfm-tagfilter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterDisallowedHtml } from '../src/mdgfm.js';

describe('filterDisallowedHtml', () => {
  it('escapes the leading < of a disallowed tag', () => {
    expect(filterDisallowedHtml('<strong> <title> <style> <em>')).toBe('<strong> &lt;title> &lt;style> <em>');
  });

  it('is case insensitive', () => {
    expect(filterDisallowedHtml('<XMP> and <xmp>')).toBe('&lt;XMP> and &lt;xmp>');
  });

  it('escapes closing tags too', () => {
    expect(filterDisallowedHtml('</script>')).toBe('&lt;/script>');
  });

  it('leaves a longer name that merely starts the same alone', () => {
    expect(filterDisallowedHtml('<styled> <titles>')).toBe('<styled> <titles>');
  });

  it('leaves every other tag untouched', () => {
    expect(filterDisallowedHtml('<div class="x"> <br/>')).toBe('<div class="x"> <br/>');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/mdgfm-tagfilter.test.ts`
Expected: FAIL — `filterDisallowedHtml` is not exported.

- [ ] **Step 3: Implement the filter**

Append to `src/mdgfm.ts`:

```ts
/** The nine tags GFM's tagfilter extension neutralizes. They are the ones that
 *  change how the HTML around them is interpreted, so a document that embeds
 *  one changes the meaning of everything after it. */
const DISALLOWED_TAGS = [
  'title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext',
];

const DISALLOWED = new RegExp(`<(/?)(${DISALLOWED_TAGS.join('|')})(?=[\\s/>])`, 'gi');

/** GFM's "disallowed raw HTML": replace the leading `<` of a disallowed tag
 *  with `&lt;`.
 *
 *  This is a RENDERING transform — the spec defines it as applying "when
 *  rendering HTML output" — so it does not touch the tree: MdHtmlBlock and
 *  MdHtmlInline keep their literal raw, exactly as a link destination is stored
 *  unencoded. It lives here because the tag list belongs with the other GFM
 *  rules and because a consumer emitting HTML from this AST needs it; this
 *  library's own renderer produces PDF and drops raw HTML entirely, so nothing
 *  in src/ calls it. That is deliberate, and the same trade cmapcodec.ts makes
 *  with its build-time encoder: one owner for a rule beats two copies. */
export function filterDisallowedHtml(html: string): string {
  return html.replace(DISALLOWED, (_m, slash: string, name: string) => `&lt;${slash}${name}`);
}
```

- [ ] **Step 4: Give the oracle a `gfm` option**

In `test/helpers/md-html.ts`:

```ts
import { filterDisallowedHtml } from '../../src/mdgfm.js';

export interface RenderOptions {
  /** Apply GFM's disallowed-raw-HTML filter, which is a render-time transform
   *  and so lives here rather than in the tree. */
  gfm?: boolean;
}

export function renderHtml(doc: MdDocument, options?: RenderOptions): string {
  const r = new Renderer();
  r.gfm = options?.gfm === true;
  r.block(doc, false);
  return r.buf;
}
```

with `gfm = false;` on the class, and the two raw-HTML sites reading it:

```ts
      case 'html_inline': this.lit(this.gfm ? filterDisallowedHtml(n.literal) : n.literal); break;
```

```ts
      case 'html_block': {
        const literal = this.gfm ? filterDisallowedHtml(n.literal) : n.literal;
        this.cr();
        this.lit(literal.replace(/\n$/, ''));
        this.cr();
        break;
      }
```

The oracle importing from `src/` is the allowed direction; the ban is on `src/`
importing the oracle.

- [ ] **Step 5: Pass `{ gfm: true }` to the oracle in the other extension suites**

In `test/gfm-spec.test.ts`, change the `renderHtml(...)` call in the
strikethrough, task list, table and autolink describes to
`renderHtml(parseMarkdown(c.markdown, { gfm: true }), { gfm: true })`, so every
extension example runs the renderer in the same mode.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/mdgfm-tagfilter.test.ts test/gfm-spec.test.ts test/commonmark-spec.test.ts && npm run typecheck`
Expected: PASS — all 24 extension examples now green, 652 CommonMark still green.

- [ ] **Step 7: Confirm the assertion is load-bearing**

Temporarily drop the `(?=[\\s/>])` lookahead and re-run
`npx vitest run test/mdgfm-tagfilter.test.ts`. Expected: "leaves a longer name
that merely starts the same alone" FAILS. Revert.

- [ ] **Step 8: Commit**

```bash
git add src/mdgfm.ts test/helpers/md-html.ts test/mdgfm-tagfilter.test.ts test/gfm-spec.test.ts
git commit -m "feat(md): GFM disallowed raw HTML filter (gl6o.2)"
```

---

### Task 8: Public exports, the divergence run, and documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `test/commonmark-spec.test.ts`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the public surface — `MarkdownOptions`, `MdAlign`, `MdTable`, `MdTableRow`, `MdTableCell`, `MdStrikethrough`, `filterDisallowedHtml`.

- [ ] **Step 1: Export the new surface**

In `src/index.ts`, beside the existing Markdown exports at line 168:

```ts
export { parseMarkdown } from './markdown.js';
export type { MarkdownOptions } from './markdown.js';
export { filterDisallowedHtml } from './mdgfm.js';
export { isMdBlock, isMdInline, isMdContainer } from './mdast.js';
```

and add `MdAlign`, `MdTable`, `MdTableRow`, `MdTableCell`, `MdStrikethrough` to
the existing `export type { ... } from './mdast.js';` list.

- [ ] **Step 2: Write the failing divergence test**

Add to the end of `test/commonmark-spec.test.ts`:

```ts
/** GFM claims to be a strict superset of CommonMark. This pins exactly which
 *  cases it changes, so behaviour cannot leak into constructs nobody looked at.
 *  Each entry needs a reason; an unexplained number is a bug, not a fact. */
const GFM_DIVERGENCES = new Map<number, string>([
  // filled in by Step 3
]);

describe('conformance under { gfm: true }', () => {
  it('diverges only where an extension is expected to apply', () => {
    const actual = new Set<number>();
    for (const c of loadSpecCases()) {
      if (renderHtml(parseMarkdown(c.markdown, { gfm: true })) !== c.html) actual.add(c.example);
    }
    expect([...actual].sort((a, b) => a - b)).toEqual([...GFM_DIVERGENCES.keys()].sort((a, b) => a - b));
  });
});
```

- [ ] **Step 3: Run it, then fill in the list**

Run: `npx vitest run test/commonmark-spec.test.ts`
Expected: FAIL, printing the actual divergence numbers.

For each number the run reports, look the case up with:

```bash
node -e "const c=require('./test/fixtures/commonmark/spec.json').find(x=>x.example===NNN);console.log(c.section);console.log(JSON.stringify(c.markdown))"
```

and add it to `GFM_DIVERGENCES` with a one-line reason naming the extension
responsible — for example `[603, 'bare www. URL becomes an extended autolink']`.
If a number cannot be explained by one of the five extensions, that is a bug in
this implementation: fix the bug rather than recording the number. If the run
reports nothing, leave the map empty.

Re-run until green.

- [ ] **Step 4: Update `README.md`**

In the Features list, extend the Markdown entry to name GFM. In the API
overview, replace the `parseMarkdown` entry with:

```markdown
### Markdown

`parseMarkdown(src, options?)` parses [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/)
into an abstract syntax tree, verified against all 652 cases of the official
suite. It never throws — every string is a valid Markdown document.

`{ gfm: true }` adds the five GitHub Flavored Markdown extensions, verified
against the 24 extension examples of GitHub's own spec: tables (`MdTable` with
per-column alignment), task list items (`MdItem.checked`), strikethrough
(`MdStrikethrough`), extended autolinks (bare `www.`, `http://`, `ftp://` and
email addresses, which become ordinary `MdLink` nodes), and disallowed raw HTML.

The last of those is defined by the spec as a rendering transform, so it does
not alter the tree: `filterDisallowedHtml(html)` is exported for consumers that
emit HTML.

Rendering a parsed document into a PDF is `gl6o.3` and is not implemented yet.
```

- [ ] **Step 5: Update `CLAUDE.md`**

Extend the `markdown.ts` module-map bullet: add `mdtable.ts` and `mdgfm.ts` to
the file list, note that GFM is opt-in behind `{ gfm: true }` and that `gl6o.2`
is done, and add these invariants:

```markdown
  **Invariant:** `gfm` off must leave the output byte-identical. Every extension
  hook is guarded, and `test/commonmark-spec.test.ts` runs the 652 cases with no
  options at all — the default path is the one the conformance suite pins. A
  second run with `{ gfm: true }` asserts an explicit divergence list, so an
  extension leaking into an unrelated construct is a red build rather than a
  discovery years later.
  **Invariant:** a table's header is the paragraph's LAST line, and a pipeless
  line still continues the table. Both are cmark-gfm's behaviour and neither is
  obvious from the spec prose: `bar` under a table is a one-cell row padded to
  width, not a paragraph, and only a blank line or another block structure ends
  the table. The `tryStart` branch must stay AFTER the setext branch, since
  `| - |` and a setext underline overlap.
  **Invariant:** strikethrough rides the SAME delimiter stack as `*` and `_`.
  A post-pass cannot get `*a~~b*c~~` right. Runs of one or two tildes only, and
  the opener and closer runs must be the same length — a longer run is literal
  text.
  **Invariant:** the extended-autolink pass never descends into a `link`. Code
  spans and links are already their own node types when it runs, which is what
  makes a post-pass correct here where it is wrong for the other extensions.
  One divergence from cmark-gfm is recorded rather than hidden: cmark refuses to
  autolink while a bracket is open, so `[a www.b.com]` with no matching
  reference stays plain text there and becomes a link here.
  **Invariant:** the tag filter is a RENDERING transform and does not touch the
  tree. `MdHtmlBlock`/`MdHtmlInline` keep their literal raw, exactly as a link
  destination is stored unencoded; `filterDisallowedHtml` is public API whose
  only in-repo caller is the oracle, on cmapcodec.ts's terms.
```

Also add the new fixture row to the third-party fixtures table:

```markdown
| `fixtures/gfm/` | `PROVENANCE.md` | GitHub's own `spec.txt` — the 24 examples tagged with an extension name. The other 648 are a CommonMark **0.29** document and are deliberately not run |
```

- [ ] **Step 6: Run the full suite**

Run: `npm run typecheck && npm test`
Expected: PASS, with the 652 CommonMark cases, the 24 GFM examples, and every
pre-existing test green.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts test/commonmark-spec.test.ts README.md CLAUDE.md
git commit -m "feat(md): export the GFM surface, pin the divergences, document it (gl6o.2)"
```

- [ ] **Step 8: Close the issue and push**

```bash
bd close gl6o.2
git pull --rebase
git push -u origin feat/gfm-extensions-gl6o.2
git status
```

`git status` must report the branch is up to date with its remote.

---

## As-built corrections

Three claims in this plan were wrong and were corrected during execution. They
are recorded here rather than edited away, because each was caught only by
running the step it belonged to.

1. **Task 5, Step 11's second mutation does not go red.** Moving the table
   branch above the setext branch leaves all 652 CommonMark cases passing. What
   actually keeps `foo\n---` a setext heading is `scanDelimiterRow`'s pipe
   requirement — a setext underline is `-` or `=` only and can never contain a
   pipe, so the two branches are disjoint in either order. The ordering and the
   pipe rule are redundant defences, which is why breaking either alone proves
   nothing. `CLAUDE.md` records this as measured, not assumed.

2. **Task 6's "needs a dot in the domain" test asserted the wrong behaviour.**
   `www.commonmark` *is* autolinked: `check_domain` counts the period inside
   `www.` itself, so one segment after the prefix suffices. The real boundary is
   a bare `www.` with nothing after it, which is what the test now pins.

3. **Task 6, Step 8's first mutation proved nothing.** Removing the `link`
   early return from `extendedAutolinks` leaves the no-nested-links test green,
   because the recursion list below it is a closed enumeration that already
   omits `link`. The mutation that does go red is *adding* `link` to that list.

Two smaller notes: `~~~x~~~` at the start of a line is a fenced code block, so
the three-tilde assertion needs an inline context; and the plan's heredoc-based
edits are unreliable for code containing quote characters — use file writes.
