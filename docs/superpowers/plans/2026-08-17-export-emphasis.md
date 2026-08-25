# Export Emphasis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry `DocText.bold`, `.italic` and `.script` into the HTML and Markdown exports, which today read no character styling at all.

**Architecture:** Two pure helpers do the work — `styledChildren` in `docmodel.ts` (merge adjacent same-style runs; drop a heading's uniform bold) and `emphasizeMarkdown` in `mdescape.ts` (wrap escaped text in `*`/`**`/`***` and `<sub>`/`<sup>`). The two serializers then call them at the four places they emit text. `docxflow.ts` is untouched.

**Tech Stack:** TypeScript (ESM + NodeNext, `strict`), vitest. Zero runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-17-export-emphasis-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins.
- **ESM + NodeNext.** Every relative import carries the `.js` extension, even from a `.ts` file.
- **Do not modify `docxflow.ts`, `docxexport.ts`, or `buildDocModel`.** `test/docx-flow-identity.test.ts` pins the **sha256** of DOCX flow output, and `docxflow.ts` emits one `w:r` per `DocText` — merging runs in the builder would move that hash. The two new rules are serializer-local by necessity.
- **HTML uses `<b>`/`<i>`, never `<strong>`/`<em>`.** Emphasis here is derived from a face, not declared.
- **Markdown uses `*`, `**`, `***`, never `_`** — `_` does not work intraword and PDF runs split mid-word constantly.
- **Script nests outermost:** `<sup>**x**</sup>`, in both formats.
- **Heading bold suppression is narrow:** bold only, `H1`–`H6` only, and only when *every* text run in the subtree is bold.
- `test/html-identity.test.ts` and `test/markdown-export.test.ts` are **fences, not goldens**. Neither is expected to move. If one does, stop and show the diff — never refresh it silently.
- Run `npm run typecheck` and `npm test` before closing. Target one file with `npx vitest run test/<name>.test.ts`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/docmodel.ts` (modify) | Gains `styledChildren` — the two structural rules. Exported but never called by the builder. |
| `src/mdescape.ts` (modify) | Gains `emphasizeMarkdown` — Markdown's delimiter spelling, beside the escapers it must cooperate with. |
| `src/htmlsemantic.ts` (modify) | Emits `<b>`/`<i>`/`<sub>`/`<sup>`; routes container children through `styledChildren`. |
| `src/mdexport.ts` (modify) | Emits through `emphasizeMarkdown`; routes container children through `styledChildren`. |
| `test/docmodel-styled-children.test.ts` (create) | Unit tests for the two structural rules, over hand-built `DocNode` literals — no PDF needed. |
| `test/md-emphasis.test.ts` (create) | Unit + round-trip tests for the Markdown emitter. |
| `test/export-emphasis.test.ts` (create) | End-to-end through both exports. |

---

### Task 1: `styledChildren` — the two structural rules

**Files:**
- Create: `test/docmodel-styled-children.test.ts`
- Modify: `src/docmodel.ts` (add after the `DocCode` interface, before the `// ---------- tagged:` comment)

**Interfaces:**
- Consumes: `DocNode`, `DocContainer`, `DocText` from `./docmodel.js` (all already exported).
- Produces, relied on by Tasks 3 and 4:
  - `styledChildren(node: DocContainer): DocNode[]`

- [ ] **Step 1: Write the failing test**

Create `test/docmodel-styled-children.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { styledChildren } from '../src/docmodel.js';
import type { DocContainer, DocNode, DocText } from '../src/docmodel.js';

const t = (text: string, style: Partial<DocText> = {}): DocText =>
  ({ kind: 'text', text, ...style });
const box = (type: string, children: DocNode[]): DocContainer =>
  ({ kind: 'container', type, children });

/** Just the text nodes, as [text, bold?, italic?, script?] tuples. */
const shape = (nodes: DocNode[]) => nodes.map((n) =>
  n.kind === 'text' ? [n.text, n.bold, n.italic, n.script] : n.kind);

describe('styledChildren — merging adjacent runs', () => {
  it('merges two adjacent runs sharing a style', () => {
    // Required, not cosmetic: emitted separately these give Markdown
    // `**a****b**`, a four-asterisk delimiter run that does not reparse as two
    // strong spans. struct.ts splits per MCID, so this is the normal case.
    const out = styledChildren(box('P', [t('a', { bold: true }), t('b', { bold: true })]));
    expect(shape(out)).toEqual([['ab', true, undefined, undefined]]);
  });

  it('does not merge runs whose styles differ', () => {
    const out = styledChildren(box('P', [t('a', { bold: true }), t('b', { italic: true })]));
    expect(shape(out)).toEqual([['a', true, undefined, undefined], ['b', undefined, true, undefined]]);
  });

  it('merges plain runs too', () => {
    expect(shape(styledChildren(box('P', [t('a'), t('b')]))))
      .toEqual([['ab', undefined, undefined, undefined]]);
  });

  it('does not merge across a non-text sibling', () => {
    const out = styledChildren(box('P', [t('a', { bold: true }), box('Link', []), t('b', { bold: true })]));
    expect(shape(out)).toEqual([['a', true, undefined, undefined], 'container', ['b', true, undefined, undefined]]);
  });

  it('distinguishes script when merging', () => {
    const out = styledChildren(box('P', [t('a', { script: 'super' }), t('b')]));
    expect(shape(out)).toEqual([['a', undefined, undefined, 'super'], ['b', undefined, undefined, undefined]]);
  });
});

describe('styledChildren — heading bold suppression', () => {
  it('drops bold when every run in a heading has it', () => {
    // mdstyle defaults headings to Helvetica-Bold, so without this our own
    // `# Title` round-trips as `# **Title**`.
    const out = styledChildren(box('H1', [t('Title', { bold: true })]));
    expect(shape(out)).toEqual([['Title', undefined, undefined, undefined]]);
  });

  it('drops it through a nested container too', () => {
    // The heading rule spans the SUBTREE: a bold run inside a Link inside a
    // uniformly bold heading is still baseline typography.
    const out = styledChildren(box('H2', [box('Link', [t('Title', { bold: true })])]));
    const link = out[0] as DocContainer;
    expect(shape(link.children)).toEqual([['Title', undefined, undefined, undefined]]);
  });

  it('KEEPS bold when only some of the heading is bold', () => {
    // The case that stops the rule collapsing into "headings never emphasize".
    const out = styledChildren(box('H1', [t('plain '), t('bold', { bold: true })]));
    expect(shape(out)).toEqual([
      ['plain ', undefined, undefined, undefined],
      ['bold', true, undefined, undefined],
    ]);
  });

  it('keeps italic in a uniformly italic heading', () => {
    // Neither format supplies italic to a heading, so suppressing it would
    // simply lose information.
    expect(shape(styledChildren(box('H1', [t('T', { italic: true })]))))
      .toEqual([['T', undefined, true, undefined]]);
  });

  it('does NOT suppress bold in a uniformly bold paragraph', () => {
    // A paragraph set entirely in bold IS a distinction the document is making.
    expect(shape(styledChildren(box('P', [t('all', { bold: true })]))))
      .toEqual([['all', true, undefined, undefined]]);
  });

  it('treats a heading with no text as not-uniformly-bold', () => {
    // `every` over an empty set is vacuously true, which would make this branch
    // fire on a heading holding only a figure. Harmless today, wrong in spirit.
    const out = styledChildren(box('H1', [box('Figure', [])]));
    expect(out).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/docmodel-styled-children.test.ts`
Expected: FAIL — `styledChildren is not a function` (or a TS resolution error).

- [ ] **Step 3: Implement**

In `src/docmodel.ts`, insert after the `DocCode` interface declaration and before the `// ---------- tagged: structure-tree driven ----------` comment:

```ts
/** Every text node under `nodes`, depth first. */
function textNodesUnder(nodes: DocNode[], out: DocText[] = []): DocText[] {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n);
    else if (n.kind === 'container') textNodesUnder(n.children, out);
    else if (n.kind === 'listItem') textNodesUnder(n.blocks, out);
  }
  return out;
}

/** `node` with `bold` removed from every text run beneath it. */
function withoutBold(node: DocNode): DocNode {
  if (node.kind === 'text') {
    if (!node.bold) return node;
    const { bold, ...rest } = node;
    return rest;
  }
  if (node.kind === 'container') return { ...node, children: node.children.map(withoutBold) };
  if (node.kind === 'listItem') return { ...node, blocks: node.blocks.map(withoutBold) };
  return node;
}

/** True when two text runs would emit identical markup. */
function sameStyle(a: DocText, b: DocText): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.script === b.script;
}

/** Adjacent text siblings sharing a style, merged into one run. */
function mergeAdjacentText(nodes: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.kind === 'text' && prev !== undefined && prev.kind === 'text' && sameStyle(prev, n)) {
      out[out.length - 1] = { ...prev, text: prev.text + n.text };
      continue;
    }
    out.push(n);
  }
  return out;
}

const HEADING = /^H[1-6]$/;

/**
 * A container's children, prepared for an inline serializer. Two rules, in one
 * place so `htmlsemantic.ts` and `mdexport.ts` cannot drift on either.
 *
 * **Invariant:** adjacent text siblings sharing `(bold, italic, script)` are
 * MERGED, and that is required rather than tidy. `struct.ts` splits a run per
 * MCID and per style, so adjacent same-style siblings are the normal case — and
 * two bold runs emitted separately give Markdown `**a****b**`, a four-asterisk
 * delimiter run that does not reparse as two strong spans.
 *
 * **Invariant:** a heading's UNIFORM bold is dropped, throughout its subtree.
 * That is the heading's baseline typography rather than an inline distinction,
 * and both formats already render headings bold themselves; without it our own
 * `# Title` round-trips as `# **Title**`, since `mdstyle.ts` defaults headings
 * to Helvetica-Bold. Narrow in three directions on purpose: headings only (a
 * bold paragraph IS a distinction, and no format supplies it), bold only
 * (nothing supplies a heading's italic), and uniform only (one bold word among
 * plain ones survives).
 *
 * **Invariant:** the builder never calls this. `test/docx-flow-identity.test.ts`
 * pins the sha256 of DOCX flow output and `docxflow.ts` emits one `w:r` per
 * `DocText`, so merging runs in `buildDocModel` would move that hash. These
 * rules are serializer-local by necessity, not by preference.
 */
export function styledChildren(node: DocContainer): DocNode[] {
  let kids = node.children;
  if (HEADING.test(node.type)) {
    const texts = textNodesUnder(kids);
    // `every` is vacuously true on an empty set, so require at least one run.
    if (texts.length > 0 && texts.every((t) => t.bold)) kids = kids.map(withoutBold);
  }
  return mergeAdjacentText(kids);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/docmodel-styled-children.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/docmodel.ts test/docmodel-styled-children.test.ts
git commit -m "$(cat <<'EOF'
feat(docmodel): styledChildren — merge same-style runs, drop heading bold

Two rules the HTML and Markdown serializers both need, in one place so they
cannot drift. The merge is required rather than cosmetic: struct.ts splits a
run per MCID, so two adjacent bold runs are the normal case and emitting them
separately gives Markdown `**a****b**`.

Exported but never called by the builder — docx-flow-identity pins the sha256
of DOCX output and docxflow emits one w:r per DocText.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `emphasizeMarkdown` — the delimiter spelling

**Files:**
- Create: `test/md-emphasis.test.ts`
- Modify: `src/mdescape.ts` (append at end of file)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, relied on by Task 4:
  - `emphasizeMarkdown(escaped: string, style: { bold?: boolean; italic?: boolean; script?: 'sub' | 'super' }): string`

- [ ] **Step 1: Write the failing test**

Create `test/md-emphasis.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emphasizeMarkdown, escapeMarkdownInline } from '../src/mdescape.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

/** Emit `s` with `style`, then render it through our own parser + oracle. */
const roundTrip = (s: string, style: Parameters<typeof emphasizeMarkdown>[1]) =>
  renderHtml(parseMarkdown(emphasizeMarkdown(escapeMarkdownInline(s), style))).trim();

describe('emphasizeMarkdown', () => {
  it('returns text unchanged when there is no style', () => {
    expect(emphasizeMarkdown('plain', {})).toBe('plain');
  });

  it('spells bold, italic and both', () => {
    expect(emphasizeMarkdown('x', { bold: true })).toBe('**x**');
    expect(emphasizeMarkdown('x', { italic: true })).toBe('*x*');
    expect(emphasizeMarkdown('x', { bold: true, italic: true })).toBe('***x***');
  });

  it('spells script as raw HTML, outermost', () => {
    // CommonMark has no sub/sup syntax; Table.toMarkdown already sets the
    // precedent of emitting raw HTML (<br>) for what GFM cannot express.
    expect(emphasizeMarkdown('x', { script: 'super' })).toBe('<sup>x</sup>');
    expect(emphasizeMarkdown('x', { script: 'sub' })).toBe('<sub>x</sub>');
    // Outermost, so the Markdown delimiters stay adjacent to the text the
    // flanking rules are about.
    expect(emphasizeMarkdown('x', { bold: true, script: 'super' })).toBe('<sup>**x**</sup>');
  });

  it('hoists surrounding whitespace OUTSIDE the delimiters', () => {
    // A closing `**` preceded by whitespace is not a closer, so `** bold **`
    // renders its asterisks literally instead of emphasizing.
    expect(emphasizeMarkdown(' x ', { bold: true })).toBe(' **x** ');
  });

  it('leaves an all-whitespace run alone', () => {
    expect(emphasizeMarkdown('   ', { bold: true })).toBe('   ');
    expect(emphasizeMarkdown('', { bold: true })).toBe('');
  });
});

describe('emphasizeMarkdown round trip through our own parser', () => {
  // The module's stated rule: correctness is defined against our parser, never
  // against a hand-written list of delimiter hazards.
  it('bold reparses as strong', () => {
    expect(roundTrip('word', { bold: true })).toBe('<p><strong>word</strong></p>');
  });

  it('italic reparses as em', () => {
    expect(roundTrip('word', { italic: true })).toBe('<p><em>word</em></p>');
  });

  it('bold+italic reparses as both', () => {
    expect(roundTrip('word', { bold: true, italic: true }))
      .toBe('<p><em><strong>word</strong></em></p>');
  });

  it('a padded run still reparses as strong', () => {
    // The hoisting rule, measured rather than reasoned about: without it the
    // asterisks survive as literal text.
    expect(roundTrip(' word ', { bold: true })).toContain('<strong>word</strong>');
    expect(roundTrip(' word ', { bold: true })).not.toContain('**');
  });

  it('text containing a literal asterisk still reparses as its own text', () => {
    // escapeMarkdownInline escapes `*`, so an emitted delimiter can never
    // collide with one the document contained.
    expect(roundTrip('2 * 3', { bold: true })).toBe('<p><strong>2 * 3</strong></p>');
  });

  it('emphasizes intraword, which is why the delimiter is * and not _', () => {
    expect(roundTrip('word', { bold: true }).includes('_')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/md-emphasis.test.ts`
Expected: FAIL — `emphasizeMarkdown is not exported by src/mdescape.ts`.

- [ ] **Step 3: Implement**

Append to `src/mdescape.ts`:

```ts
/** Wrap already-escaped text in the delimiters its style calls for.
 *
 *  Takes ESCAPED text and never escapes its own delimiters — that split is what
 *  makes this safe: `escapeMarkdown`/`escapeMarkdownInline` already escape `*`
 *  and `_`, so an emitted delimiter can never collide with a literal asterisk
 *  the document contained.
 *
 *  `*` rather than `_`, because `_` does not emphasize intraword and PDF text
 *  runs split mid-word constantly.
 *
 *  Sub/superscript has no CommonMark spelling, so it is raw `<sub>`/`<sup>` —
 *  the precedent `Table.toMarkdown` sets by emitting `<br>` for a cell newline,
 *  under the rule that what the grammar cannot express is reported rather than
 *  dropped. It nests OUTSIDE the emphasis so the `*` delimiters stay adjacent
 *  to the text, which is what CommonMark's flanking rules look at.
 *
 *  **Invariant:** surrounding whitespace is hoisted outside the delimiters. A
 *  closing `**` preceded by whitespace is not a closer, so `** bold **` renders
 *  its asterisks literally instead of emphasizing — the same move
 *  `mdexport.ts`'s link case already makes for `[the docs ](url)`.
 *
 *  **Invariant:** correctness is defined against our own parser, as everything
 *  else in this module is: `parseMarkdown(emphasizeMarkdown(escape(s), style))`
 *  must yield `s` carrying that emphasis. */
export function emphasizeMarkdown(
  escaped: string,
  style: { bold?: boolean; italic?: boolean; script?: 'sub' | 'super' },
): string {
  const marks = style.bold && style.italic ? '***' : style.bold ? '**' : style.italic ? '*' : '';
  if (!marks && !style.script) return escaped;
  // An all-whitespace run has nothing to emphasize, and wrapping it would emit
  // delimiters that cannot close.
  const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(escaped)!;
  if (!core) return escaped;
  let out = `${marks}${core}${marks}`;
  if (style.script) out = `<${style.script === 'super' ? 'sup' : 'sub'}>${out}</${style.script === 'super' ? 'sup' : 'sub'}>`;
  return `${lead}${out}${tail}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/md-emphasis.test.ts`
Expected: PASS, 11 tests.

If `bold+italic reparses as both` fails on element order (`<strong><em>` rather than `<em><strong>`), fix the **expectation** to match what our parser actually produces — `***x***` is correct CommonMark either way, and the point of the test is that both survive, not which nests outer.

- [ ] **Step 5: Commit**

```bash
git add src/mdescape.ts test/md-emphasis.test.ts
git commit -m "$(cat <<'EOF'
feat(mdescape): emphasizeMarkdown — delimiter spelling for derived emphasis

Takes escaped text and wraps it: * / ** / *** (never _, which does not work
intraword), with raw <sub>/<sup> outermost since CommonMark cannot spell them.
Surrounding whitespace is hoisted outside the delimiters, because a closing **
preceded by whitespace is not a closer.

Correctness is defined against our own parser, as the module's escapers
already are.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire the HTML serializer

**Files:**
- Modify: `src/htmlsemantic.ts`
- Create: `test/export-emphasis.test.ts` (HTML half; Task 4 appends the Markdown half)

**Interfaces:**
- Consumes: `styledChildren(node: DocContainer): DocNode[]` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `test/export-emphasis.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';

/** A one-page document whose Markdown source is rendered by our own stack and
 *  then exported back out. Headings default to Helvetica-Bold, paragraphs to
 *  the regular face, and `**x**` selects the bold family member — so the
 *  round trip is a real emphasis fixture without any hand-built content. */
function via(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true });
  return Document.Open(doc.Save());
}

describe('HTML export carries emphasis', () => {
  it('emits <b> for a bold run', () => {
    // <b> and not <strong>: emphasis here is DERIVED from the producing face,
    // and <strong> would assert an importance the PDF never stated.
    const html = via('plain **bold** plain').ToHtml();
    expect(html).toContain('<b>bold</b>');
    expect(html).not.toContain('<strong>');
  });

  it('emits <i> for an italic run', () => {
    const html = via('plain *slanted* plain').ToHtml();
    expect(html).toContain('<i>slanted</i>');
    expect(html).not.toContain('<em>');
  });

  it('keeps the words either side of the emphasis', () => {
    expect(via('plain **bold** plain').ToHtml()).toContain('plain');
  });

  it('does not emit <b> for a uniformly bold heading', () => {
    // mdstyle defaults headings to Helvetica-Bold; both formats render a
    // heading bold themselves, so repeating it is noise.
    const html = via('# Title').ToHtml();
    expect(html).toContain('Title');
    expect(html).not.toContain('<b>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/export-emphasis.test.ts`
Expected: FAIL on the first two — the HTML contains `bold` as plain text with no `<b>`.

- [ ] **Step 3: Implement**

In `src/htmlsemantic.ts` the existing docmodel import is **type-only**:

```ts
import type { DocFigure, DocListItem, DocNode } from './docmodel.js';
```

`styledChildren` is a value, so add `DocText` to that line and a separate value import beside it:

```ts
import type { DocFigure, DocListItem, DocNode, DocText } from './docmodel.js';
import { styledChildren } from './docmodel.js';
```

Then add this helper above `nodeHtml`:

```ts
/** Wrap a text run in the elements its derived style calls for.
 *
 *  `<b>`/`<i>` rather than `<strong>`/`<em>`: HTML5 defines `<b>` as
 *  stylistically offset WITHOUT conveying importance, which is exactly what a
 *  face-derived style is — `CLAUDE.md` records that a PDF states a face and
 *  never an emphasis. Script nests outermost, matching the Markdown emitter.
 *  No whitespace hoisting: HTML has no flanking rules. */
function emphasizeHtml(inner: string, node: DocText): string {
  let out = inner;
  if (node.italic) out = `<i>${out}</i>`;
  if (node.bold) out = `<b>${out}</b>`;
  if (node.script) out = `<${node.script === 'super' ? 'sup' : 'sub'}>${out}</${node.script === 'super' ? 'sup' : 'sub'}>`;
  return out;
}
```

Change the text branch of `nodeHtml` from:

```ts
  if (node.kind === 'text') return escapeHtml(node.text);
```

to:

```ts
  if (node.kind === 'text') return emphasizeHtml(escapeHtml(node.text), node);
```

And change the container tail from:

```ts
  const inner = node.children.map((c) => nodeHtml(doc, c)).filter((s) => s).join('');
```

to:

```ts
  // styledChildren, not node.children: it merges adjacent same-style runs and
  // drops a heading's uniform bold, and both serializers must apply both.
  const inner = styledChildren(node).map((c) => nodeHtml(doc, c)).filter((s) => s).join('');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/export-emphasis.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Check the HTML fence**

Run: `npx vitest run test/html-identity.test.ts`
Expected: PASS with **no snapshot update**. Measured before starting: no fixture in that file's set uses a bold, italic or oblique face, so it should not move.

If it DOES fail, STOP. Do not run vitest with `-u`. Print the diff, and report it — that snapshot is a fence, and a move means a fixture has emphasis nobody knew about, which is information, not a chore.

- [ ] **Step 6: Commit**

```bash
git add src/htmlsemantic.ts test/export-emphasis.test.ts
git commit -m "$(cat <<'EOF'
feat(html): carry derived emphasis into the semantic HTML export

<b>/<i>/<sub>/<sup> rather than <strong>/<em>: emphasis here is derived from
the producing face, and <strong> would assert an importance the PDF never
stated. Container children now route through styledChildren, so adjacent
same-style runs merge and a uniformly bold heading emits no <b>.

test/html-identity.test.ts's snapshot did not move: no fixture in its set uses
a bold or italic face.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire the Markdown serializer

**Files:**
- Modify: `src/mdexport.ts`
- Modify: `test/export-emphasis.test.ts` (append the Markdown half)

**Interfaces:**
- Consumes: `styledChildren(node: DocContainer): DocNode[]` (Task 1); `emphasizeMarkdown(escaped, style)` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `test/export-emphasis.test.ts`:

```ts
describe('Markdown export carries emphasis', () => {
  it('round-trips bold and italic through our own stack', () => {
    // Today this loses both: the model carries them and the serializer ignores
    // them.
    const md = via('plain **bold** and *slanted* text').ToMarkdown();
    expect(md).toContain('**bold**');
    expect(md).toContain('*slanted*');
  });

  it('emits ONE delimiter pair for adjacent same-style runs', () => {
    // The merge is what makes this correct: `**a****b**` is a four-asterisk
    // delimiter run that does not reparse as two strong spans.
    const md = via('**one two three**').ToMarkdown();
    expect(md).not.toContain('****');
  });

  it('does not emphasize a uniformly bold heading', () => {
    const md = via('# Title').ToMarkdown();
    expect(md).toContain('# Title');
    expect(md).not.toContain('**');
  });

  it('reparses to the same emphasis it started with', () => {
    // The whole point, closed as a loop: Markdown -> PDF -> Markdown -> AST
    // must still say strong. Asserting on the emitted STRING alone would pass
    // for `**a****b**`, which contains `**bold**` as a substring and yet does
    // not reparse as emphasis at all.
    const md = via('a **bold** b').ToMarkdown();
    const html = renderHtml(parseMarkdown(md));
    expect(html).toContain('<strong>bold</strong>');
  });

  it('emits a superscript as raw <sup>, which CommonMark cannot spell', () => {
    // Built directly rather than through Markdown, which has no superscript
    // syntax to render from in the first place.
    // 10pt "H", a 6pt "2" dropped 3pt, then 10pt "O". markScriptLevel needs a
    // size drop (6 vs a dominant 10, under the 0.85 ratio) AND a baseline shift
    // (3pt, over 0.1 em), with the baselines inside its max(2, 0.5*size) = 5pt
    // line tolerance so the three read as one line. A negative shift is 'sub'.
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.AddText('H', 50, 200, { fontSize: 10 });
    page.AddText('2', 57, 197, { fontSize: 6 });
    page.AddText('O', 61, 200, { fontSize: 10 });
    doc.AutoTag();
    const md = Document.Open(doc.Save()).ToMarkdown();
    expect(md).toContain('<sub>2</sub>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/export-emphasis.test.ts`
Expected: FAIL on the first — the Markdown contains `bold` with no `**`.

- [ ] **Step 3: Implement**

In `src/mdexport.ts`:

Both imports already exist as value imports, so extend them in place:

```ts
import {
  buildDocModel, styledChildren, type DocFigure, type DocList, type DocListItem, type DocNode,
} from './docmodel.js';
import { escapeLinkDestination, escapeMarkdown, emphasizeMarkdown } from './mdescape.js';
```

Change `inlineText`'s text branch from:

```ts
  if (node.kind === 'text') return escapeMarkdown(node.text);
```

to:

```ts
  if (node.kind === 'text') return emphasizeMarkdown(escapeMarkdown(node.text), node);
```

Change `inlineText`'s container recursion from:

```ts
    const inner = node.children.map(inlineText).join('');
```

to:

```ts
    const inner = styledChildren(node).map(inlineText).join('');
```

In `nodeBlocks`, change the text branch from:

```ts
    const t = escapeMarkdown(node.text);
```

to:

```ts
    const t = emphasizeMarkdown(escapeMarkdown(node.text), node);
```

And change **both** remaining `node.children.map(inlineText).join('').trim()` call sites — the heading branch and the `P`/`INLINE_TYPES` branch — to:

```ts
    const t = styledChildren(node).map(inlineText).join('').trim();
```

The heading branch is the one that gets bold suppression, since `styledChildren` reads `node.type`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/export-emphasis.test.ts`
Expected: PASS, 9 tests.

If the `<sub>` case fails, first check *where*: print
`Document.Open(doc.Save()).Pages[0].GetTextFragments()` and confirm the `2`
fragment carries `script: 'sub'`. If it does not, the fixture's geometry is at
fault and the coordinates need adjusting — not the serializer. `c3t7.7` already
proved the tagged path supplies `script`, so a miss here is this fixture's
problem, not a gap in the feature.

- [ ] **Step 5: Check the Markdown fence**

Run: `npx vitest run test/markdown-export.test.ts`
Expected: PASS unchanged. Measured before starting: no `via()` case in that file uses a heading, and `buildUntaggedHtmlPdf` uses no bold face.

If it fails, STOP and report the diff rather than editing the expectation.

- [ ] **Step 6: Check the DOCX fence**

Run: `npx vitest run test/docx-flow-identity.test.ts`
Expected: PASS. This is the evidence that neither new rule leaked into `buildDocModel` — it pins the sha256 of DOCX flow output, which would move if runs were merged in the builder.

- [ ] **Step 7: Commit**

```bash
git add src/mdexport.ts test/export-emphasis.test.ts
git commit -m "$(cat <<'EOF'
feat(mdexport): carry derived emphasis into the Markdown export

Text runs emit through emphasizeMarkdown and container children through
styledChildren, so `**bold**` survives a Markdown -> PDF -> Markdown trip and
adjacent same-style runs emit one delimiter pair rather than `**a****b**`.

Both fences held: markdown-export's expectations and docx-flow-identity's
sha256 are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Prove the rules load-bearing, then document

**Files:**
- Modify: `CLAUDE.md` (the `docmodel.ts` entry)
- Modify: `README.md` (two statements that become false)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: nothing new.

- [ ] **Step 1: Prove the merge is load-bearing**

In `src/docmodel.ts`, temporarily make `mergeAdjacentText` a no-op:

```ts
function mergeAdjacentText(nodes: DocNode[]): DocNode[] {
  return nodes;   // TEMPORARY — must go red
}
```

Run: `npx vitest run test/export-emphasis.test.ts test/docmodel-styled-children.test.ts`
Expected: FAIL on `emits ONE delimiter pair for adjacent same-style runs` (the export produces `****`) and on the merging cases in the unit test.

Then restore the function body exactly as Task 1 wrote it and re-run — both green, and `git diff src/docmodel.ts` empty.

- [ ] **Step 2: Prove the heading suppression is load-bearing**

In `src/docmodel.ts`, temporarily drop the heading branch from `styledChildren`:

```ts
export function styledChildren(node: DocContainer): DocNode[] {
  return mergeAdjacentText(node.children);   // TEMPORARY — must go red
}
```

Run: `npx vitest run test/export-emphasis.test.ts`
Expected: FAIL on `does not emphasize a uniformly bold heading` — the Markdown comes back as `# **Title**`, which is exactly the defect the rule exists to prevent.

Restore, re-run, confirm `git diff src/docmodel.ts` is empty.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS with no snapshot updates and no expectation edits.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Retire the stale CLAUDE.md invariant**

In `CLAUDE.md`'s `docmodel.ts` entry (around line 1663), replace this whole
invariant — find it with `grep -n "read by \`docxflow.ts\` alone" CLAUDE.md`:

```
  **Invariant:** `DocText.bold`/`.italic`/`.script` and `DocFigure.sizes` are
  read by `docxflow.ts` alone, are optional, and are absent rather than false,
  zero or undefined-as-a-value. `htmlsemantic.ts` and `mdexport.ts` emit a text
  node as `escapeHtml(node.text)` / `escapeMarkdown(node.text)` and read no
  character styling whatever — so a bold word exports bold to `.docx` and plain
  to both of them. That is a real fidelity gap, tracked as its own issue rather
  than an accident, and retiring it means deliberately re-recording
  `test/html-identity.test.ts` and the Markdown snapshots.
```

with:

```markdown
  **Invariant:** `DocText.bold`/`.italic`/`.script` are read by ALL THREE
  serializers as of c3t7.8 — `docxflow.ts` as `w:b`/`w:i`/`w:vertAlign`,
  `htmlsemantic.ts` as `<b>`/`<i>`/`<sub>`/`<sup>`, and `mdexport.ts` as
  `*`/`**`/`***` plus raw `<sub>`/`<sup>`. All are still optional and absent
  rather than false. The old "read by docxflow.ts alone" rule, and the
  byte-identity it bought for the other two, is deliberately retired.
  `DocFigure.sizes` IS still DOCX-only and still absent-rather-than-zero — do
  not read this change as covering it. Emphasis remains DERIVED from
  the producing font (`fontStyleOf`), never declared: a PDF records a face, not
  an emphasis — which is why HTML gets `<b>`/`<i>` rather than
  `<strong>`/`<em>`, whose semantics assert an importance the document never
  stated.
  **Invariant:** the two rules the exports need live in `styledChildren`, and
  the BUILDER never calls it. Adjacent text siblings sharing a style are merged
  — required, not tidy: `struct.ts` splits a run per MCID, so two adjacent bold
  runs are the normal case and emitting them separately gives Markdown
  `**a****b**`, a four-asterisk delimiter run that does not reparse as two
  strong spans. A heading's UNIFORM bold is dropped throughout its subtree,
  because both formats already render headings bold and `mdstyle.ts` defaults
  them to Helvetica-Bold, so our own `# Title` would otherwise round-trip as
  `# **Title**`. Narrow on purpose: headings only, bold only, uniform only.
  **Invariant:** neither rule may move into `buildDocModel`.
  `test/docx-flow-identity.test.ts` pins the sha256 of DOCX flow output and
  `docxflow.ts` emits one `w:r` per `DocText`, so merging runs there moves the
  hash. That test is now the fence that matters for this area.
  **Note, measured:** `test/html-identity.test.ts` and
  `test/markdown-export.test.ts` did NOT move when emphasis shipped — no
  fixture in the html-identity set uses a bold, italic or oblique face, and no
  `via()` case uses a heading. They remain fences; a future move there is
  information, not a chore.
```

- [ ] **Step 6: Fix the two false README statements**

Both false claims sit in the **same** bullet — the sub/superscript one, at
roughly `README.md:2126`. Confirm with
`grep -n "read no character styling" README.md`, which should report exactly
one line. Replace this substring:

```
and only the **DOCX** export consumes it, as `w:vertAlign` — so `H₂O` survives a `.docx` round trip. HTML and Markdown export it flat, because those two serializers read no character styling at all (a **bold** word exports bold to `.docx` and plain to both of them).
```

with:

```
and all three exports consume it — DOCX as `w:vertAlign`, HTML as `<sub>`/`<sup>`, and Markdown as raw `<sub>`/`<sup>`, since CommonMark has no syntax for it and dropping it would lose the information (the same rule that makes `Table.toMarkdown` emit `<br>` for a cell newline) — so `H₂O` survives a round trip through any of them.
```

That one edit retires both false statements: the DOCX-only claim and the
"read no character styling at all" claim.

Then retitle the neighbouring bullet, whose scope is now wrong. Find it with
`grep -n "DOCX emphasis is inferred, not read" README.md` and change just the
bold lead-in from:

```
- **DOCX emphasis is inferred, not read**
```

to:

```
- **Emphasis is inferred, not read** (in all three exports)
```

Leave that bullet's body alone — "a PDF records a *font*, not an emphasis" is
still exactly right, and is the reason HTML gets `<b>` rather than `<strong>`.

- [ ] **Step 7: Commit and close**

```bash
git add CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: retire the docxflow-alone invariant for emphasis

All three serializers now read DocText.bold/.italic/.script. Records why the
two new rules cannot move into the builder (docx-flow-identity's sha256), and
that neither the html-identity snapshot nor markdown-export's expectations
moved — measured, not assumed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
bd close aspose-pdf-foss-for-ts-c3t7.8
```

---

## Notes for the implementer

**On the fences.** Three tests in this repo are fences rather than goldens:
`test/html-identity.test.ts` (a snapshot), `test/markdown-export.test.ts`
(exact expectations) and `test/docx-flow-identity.test.ts` (a sha256). None is
expected to move. **Never** run `vitest -u`, and never edit an expectation to
match new output. If one goes red, that is the fence doing its job — stop,
print the diff, and report it.

**On the mutation steps in Task 5.** Do not skip them and do not commit while
mutated. Each ends with `git diff src/docmodel.ts` empty. A green assertion is
not evidence in this repo until it has been shown to fail.

**Where NOT to put the two rules.** If you find yourself editing
`buildDocModel`, `docxflow.ts` or `docxexport.ts`, stop — the design's central
claim is that none of them need to change, and a change there means the shape
was wrong and needs re-deciding rather than patching.

**Table cells are out of scope.** `Table.toHtml()`/`toMarkdown()` take their
text from the `Table` model, which carries no emphasis at all. A flat cell is
correct here and is a separate gap.
