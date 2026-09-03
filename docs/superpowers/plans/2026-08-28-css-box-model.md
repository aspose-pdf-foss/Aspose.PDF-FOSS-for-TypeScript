# Box Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `zch2.2.3`'s `Map<HtmlElement, ComputedStyle>` into a box tree — box generation, the two formatting contexts, margin collapsing, used widths, insets and float classification — without positioning anything.

**Architecture:** Four new pure leaves under `src/`, plus one small extraction from `flowblock.ts`. `cssbox.ts` builds the tree and delegates inline content to `cssinline.ts`, which lowers it to `TextRun[]` so `layoutRuns` stays the one wrapping engine. `cssresolve.ts` resolves a box against a containing-block WIDTH supplied at place time, and `cssmargin.ts` collapses. No x, no y, no pagination: `zch2.4` maps boxes to `FlowElement`s and `flow.ts` does the rest.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. Zero runtime dependencies. `puppeteer` and `tsx` are installed `--no-save` for the generator script only and are never recorded in `package.json`.

**Spec:** `docs/superpowers/specs/2026-08-28-css-box-model-design.md`

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins — and none of the new modules may import even those.
- **ESM + NodeNext.** Every import specifier carries the `.js` extension: `import { preformat } from './preformat.js';`
- **All four new CSS modules are PURE LEAVES.** None may import `document.js`, `page.js`, any PDF object module (`pagecontent.js`, `serialize.js`, `stamp.js`, `flowblock.ts`, …), any `node:` module, `svgcss.js` or `svgstyle.js`. They may import each other, `cssprop.js`, `cssvalue.js`, `htmldom.js`, `textdecor.js` (types) and the new `preformat.js`.
- **Nothing throws.** Anything unrenderable is a VALUE on an `unsupported: UnsupportedDeclaration[]` list, for `zch2.7`. This is `csstoken.ts`'s, `cssselect.ts`'s and the whole `zch2.2.3` stack's rule.
- **NOTHING IS POSITIONED.** No module in this plan computes an x, a y, a line break or a page break. A step that reaches for one is a step in the wrong issue.
- **Units are CSS px throughout.** `1px = 0.75pt`, and that multiply belongs to `zch2.4`.
- **Nothing is exported from `src/index.ts`.** `zch2.4` is the next consumer. There is therefore **no `CHANGELOG.md` entry** — no public API moves. `zch2.2.1`, `zch2.2.2` and `zch2.2.3` all set this precedent.
- **Both gates green before the issue closes:** `npm run typecheck` and `npm test`.
- **Task tracking is `bd`,** never TodoWrite or a markdown TODO list. The issue is `zch2.3`, already claimed.
- **Commit style:** conventional prefix with the issue id, e.g. `feat(zch2.3): ...`. End every commit message with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/preformat.ts` | **Create.** `preformat` and `expandTabs`, extracted from `flowblock.ts`. A leaf importing nothing. |
| `src/flowblock.ts` | **Modify.** Delete its private `NBSP`/`expandTabs`/`preformat`; import and re-export from `preformat.js`. Pure move. |
| `src/cssinline.ts` | **Create.** An inline formatting context's content → `TextRun[]` plus atomics. |
| `src/cssbox.ts` | **Create.** The `BoxNode` model and box generation — display, anonymous boxes, the BFC/IFC split. |
| `src/cssresolve.ts` | **Create.** Used widths (CSS 2.1 §10.3.3), insets, min-height, shrink-to-fit. |
| `src/cssmargin.ts` | **Create.** The four collapsing rules. |
| `test/preformat.test.ts` | **Create.** The extracted rule, on its own. |
| `test/cssinline.test.ts` | **Create.** Run mapping, white-space, links, atomics. |
| `test/cssbox.test.ts` | **Create.** Display, anonymous boxes, the BFC/IFC split, tables. |
| `test/cssresolve.test.ts` | **Create.** The §10.3.3 case analysis, insets, min-height, shrink-to-fit. |
| `test/cssmargin.test.ts` | **Create.** All four rules and the combining rule. |
| `scripts/gen-box-goldens.ts` | **Create.** The Blink oracle generator. Not run by `npm test`. |
| `test/helpers/box-goldens.ts` | **Create.** Test-only loader. Nothing in `src/` may import it. |
| `test/fixtures/css-box/*` | **Create.** Generated goldens + `PROVENANCE.md`. |
| `test/cssbox-suite.test.ts` | **Create.** Runs the goldens whole. |
| `CLAUDE.md` | **Modify.** Entries for the five new modules. |

---

## Reference: what the neighbouring modules actually provide

**Measured by reading the code, not assumed.** Every type below already
exists; nothing in this plan may redefine one.

### From `zch2.2.3`

```ts
// src/cssprop.ts
interface ComputedStyle {         // 43 fields, all already computed, px units
  fontFamily: string[]; fontSize: number;
  fontStyle: 'normal' | 'italic' | 'oblique'; fontWeight: number;
  lineHeight: 'normal' | { number: number } | { px: number };
  color: Color; backgroundColor: Color;
  textDecorationLine: ('underline' | 'overline' | 'line-through')[];
  textDecorationColor: Color; textDecorationStyle: …;
  textIndent: LengthPct; whiteSpace: 'normal'|'pre'|'nowrap'|'pre-wrap'|'pre-line';
  verticalAlign: …;
  display: 'inline'|'block'|'inline-block'|'list-item'|'none'|'table'
         |'table-row-group'|'table-header-group'|'table-footer-group'
         |'table-row'|'table-cell'|'table-caption';
  float: 'none'|'left'|'right'; clear: 'none'|'left'|'right'|'both';
  width: Auto<LengthPct>; height: Auto<LengthPct>;
  marginTop|Right|Bottom|Left: Auto<LengthPct>;
  paddingTop|Right|Bottom|Left: LengthPct;
  borderTop|Right|Bottom|LeftWidth: number;
  borderTop|Right|Bottom|LeftStyle: BorderStyle;
  borderTop|Right|Bottom|LeftColor: Color;
  listStyleType: string; listStylePosition: 'outside'|'inside';
  borderCollapse: 'separate'|'collapse'; borderSpacing: number;
}
interface UnsupportedDeclaration {
  el: HtmlElement | null; property: string; value: string;
  reason: 'unknown-property'|'unparsable-value'|'unsupported-at-rule'
        |'unsupported-media-feature';
}
// src/cssvalue.ts
interface Color { rgb: [number, number, number]; a: number }
type LengthPct = { px: number } | { pct: number };
// src/csscompute.ts
function computeStyles(root: HtmlDocument): {
  styles: Map<HtmlElement, ComputedStyle>;
  unsupported: UnsupportedDeclaration[];
};
```

### From the authoring layer

```ts
// src/textdecor.ts
interface TextRun extends DecorationOptions {
  text: string; font?: AuthoringFont; fontSize?: number;
  color?: [number, number, number]; link?: string;
}
interface DecorationOptions {
  underline?: Decoration; strikethrough?: Decoration; background?: BackgroundStyle;
}
type Decoration = boolean | DecorationStyle;
interface DecorationStyle { color?: [number,number,number]; thickness?: number; offset?: number }
interface BackgroundStyle { color: [number, number, number]; padding?: number }
// src/stamp.ts
type AuthoringFont = StdFont | EmbeddedFont;
// src/mdstyle.ts
interface ResolvedFamily { regular: AuthoringFont; bold: AuthoringFont;
                           italic: AuthoringFont; boldItalic: AuthoringFont }
function faceFor(family: ResolvedFamily, bold: boolean, italic: boolean): AuthoringFont;
```

**TRAP 1 — `TextRun.color` has NO alpha and `ComputedStyle.color` does.** A
translucent text colour flattens to its RGB and the alpha is lost. Record it
on `unsupported` rather than dropping it silently; do not invent an alpha
field on `TextRun`, which would move bytes for every existing caller.

**TRAP 2 — `ComputedStyle.fontFamily` is a `string[]` of family NAMES and
`TextRun.font` is an `AuthoringFont`.** Turning one into the other needs a
`Document` (to load a face by name), which these modules may not import. It is
therefore an INJECTED callback, and `zch2.5` supplies the real one.

**TRAP 3 — `layoutRuns` COLLAPSES runs of spaces**, which is right for
`white-space: normal` and fatal to `pre`. `flowblock.ts` already solved this
by substituting U+00A0, and Task 1 extracts that rule rather than writing a
second copy.

---

## Task 1: extract `preformat` into a leaf

`cssinline.ts` needs the `white-space: pre` rule, and `flowblock.ts` — where
it lives — imports `pagecontent.js` and `serialize.js`, both PDF object
modules. Importing it would break the pure-leaf invariant, and a second copy
of the rule is the hazard `CLAUDE.md` names repeatedly. Same move as
`colornames.ts`.

**Files:**
- Create: `src/preformat.ts`
- Modify: `src/flowblock.ts` (delete `NBSP`, `expandTabs`, `preformat`; import instead)
- Test: `test/preformat.test.ts`

**Interfaces:**
- Produces:

```ts
export const NBSP: string;                                    // ' '
export function expandTabs(line: string, tabWidth: number): string;
export function preformat(text: string, tabWidth: number): string;
```

- [ ] **Step 1: Write the failing test**

Create `test/preformat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { preformat, expandTabs, NBSP } from '../src/preformat.js';

describe('preformat', () => {
  it('protects LEADING indentation with no-break spaces', () => {
    // layoutRuns collapses runs of spaces, which is right for prose and fatal
    // to indentation. U+00A0 costs nothing: WinAnsiEncoding names that code
    // /space and its AFM advance is identical.
    expect(preformat('  a', 4)).toBe(`${NBSP}${NBSP}a`);
  });

  it('protects an INTERIOR run of two or more spaces', () => {
    expect(preformat('a  b', 4)).toBe(`a${NBSP}${NBSP}b`);
  });

  it('leaves a SINGLE interior space alone', () => {
    // One space is an ordinary word separator and must stay breakable, or a
    // long preformatted line could never wrap at all.
    expect(preformat('a b', 4)).toBe('a b');
  });

  it('keeps newlines, so each source line stays its own unit', () => {
    expect(preformat('a\n  b', 4)).toBe(`a\n${NBSP}${NBSP}b`);
  });

  it('expands a tab to the next tab stop, not to a fixed width', () => {
    expect(expandTabs('\ta', 4)).toBe(`${NBSP.repeat(4)}a`);
    expect(expandTabs('ab\tc', 4)).toBe(`ab${NBSP.repeat(2)}c`);
    expect(expandTabs('abcd\te', 4)).toBe(`abcd${NBSP.repeat(4)}e`);
  });

  it('expands a tab directly to no-break spaces', () => {
    // A tab is indentation BY INTENT, so a one-column tab must not be left
    // unprotected by the two-or-more rule below it.
    expect(expandTabs('abc\td', 4)).toBe(`abc${NBSP}d`);
  });

  it('is empty-safe', () => {
    expect(preformat('', 4)).toBe('');
    expect(expandTabs('', 4)).toBe('');
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/preformat.test.ts`
Expected: FAIL — `Failed to resolve import "../src/preformat.js"`.

- [ ] **Step 3: Create `src/preformat.ts`**

Move the three declarations VERBATIM out of `src/flowblock.ts` — `NBSP` at
roughly line 151, `expandTabs` at 156, and `preformat` at 192 — into the new
file, exporting all three:

```ts
/** Preformatted text: the rule that lets indentation survive being drawn.
 *
 *  Invariant: a LEAF importing NOTHING. It lives here rather than in
 *  flowblock.ts because two stacks need it and flowblock.ts imports
 *  pagecontent.js and serialize.js — PDF object modules — so cssinline.ts
 *  cannot reach it there without giving up its purity. A second copy of the
 *  rule is the hazard CLAUDE.md names repeatedly; this is colornames.ts's
 *  move.
 *
 *  Invariant: the substitution is U+00A0 and it exists because layoutRuns
 *  COLLAPSES runs of spaces (`a  b` lays out as `a b`), which is fatal to
 *  indentation. U+00A0 costs nothing: `winAnsi[0xA0]` is U+00A0,
 *  WinAnsiEncoding names that code `/space` (Annex D Table D.2's documented
 *  duplicate), and its AFM advance is identical — 278 in Helvetica, 600 in
 *  Courier. Each source line then becomes one unbreakable unit and an
 *  over-wide line falls through the existing UAX #14 path.
 *
 *  Invariant: a SINGLE interior space is left alone. It is an ordinary word
 *  separator and must stay breakable, or a long preformatted line could never
 *  wrap at all. Only a leading run, or a run of two or more, is protected. */

export const NBSP = ' ';

/** Expand `line`'s tabs to `tabWidth` columns. A tab expands directly to
 *  no-break spaces: it is indentation by intent, and the run rule below would
 *  otherwise leave a one-column tab unprotected. */
export function expandTabs(line: string, tabWidth: number): string {
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = tabWidth - (col % tabWidth);
      out += NBSP.repeat(n);
      col += n;
      continue;
    }
    out += ch;
    col++;
  }
  return out;
}

export function preformat(text: string, tabWidth: number): string {
  return text.split('\n').map((raw) => {
    const line = expandTabs(raw, tabWidth);
    let out = '';
    let i = 0;
    while (i < line.length) {
      if (line[i] !== ' ') { out += line[i]; i++; continue; }
      let j = i;
      while (j < line.length && line[j] === ' ') j++;
      const len = j - i;
      out += i === 0 || len >= 2 ? NBSP.repeat(len) : ' ';
      i = j;
    }
    return out;
  }).join('\n');
}
```

- [ ] **Step 4: Rewire `src/flowblock.ts`**

Delete the three declarations just moved. Add to its imports:

```ts
import { preformat, NBSP } from './preformat.js';
```

`flowblock.ts` currently exports `preformat`, and `mdflow.ts` imports it from
there. Keep that import path working by re-exporting, so no other module
moves:

```ts
export { preformat } from './preformat.js';
```

If `npm run typecheck` reports `NBSP` unused in `flowblock.ts`, drop it from
the import — the file may reference it only through `preformat`.

- [ ] **Step 5: Run the new test and the Flow fence**

Run: `npx vitest run test/preformat.test.ts test/flow-block.test.ts test/markdown-render.test.ts test/rich-runs-identity.test.ts`
Expected: PASS. `test/rich-runs-identity.test.ts` hashes emitted page bytes
for eight existing call sites and is the fence for "pure move" — it must not
move. If a file name differs in this repo, run `npx vitest run test/flow*.test.ts test/md*.test.ts`.

- [ ] **Step 6: Full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: both green, same totals as before plus `test/preformat.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/preformat.ts src/flowblock.ts test/preformat.test.ts
git commit -m "refactor(zch2.3): lift preformat into a leaf

cssinline.ts needs the white-space: pre rule, and flowblock.ts — where it
lives — imports pagecontent.js and serialize.js, both PDF object modules,
so reaching it there would cost the new module its purity. A second copy
of the rule is the hazard CLAUDE.md names repeatedly, so the rule moves
instead. colornames.ts's move, for the same reason.

flowblock.ts re-exports preformat so mdflow.ts's import path is unchanged.

Pure move, no behaviour change. rich-runs-identity.test.ts hashes emitted
page bytes for eight call sites and is the fence; it did not move.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 2: `cssinline.ts` — an inline formatting context to `TextRun[]`

**Files:**
- Create: `src/cssinline.ts`
- Test: `test/cssinline.test.ts`

**Interfaces:**
- Consumes: `ComputedStyle`, `UnsupportedDeclaration` from `src/cssprop.js`; `TextRun` from `src/textdecor.js`; `ResolvedFamily`, `faceFor` from `src/mdstyle.js`; `preformat` from `src/preformat.js`; `HtmlElement`, `HtmlNode` from `src/htmldom.js`.
- Produces:

```ts
export type FamilyResolver = (families: string[]) => ResolvedFamily;
export interface AtomicInline {
  kind: 'image';
  el: HtmlElement;
  style: ComputedStyle;
  /** The index of the run this sits BEFORE; `runs.length` means "at the end". */
  beforeRun: number;
}
export interface InlineContent { runs: TextRun[]; atomics: AtomicInline[] }
export function inlineContentOf(
  nodes: HtmlNode[],
  parentStyle: ComputedStyle,
  styles: Map<HtmlElement, ComputedStyle>,
  resolveFamily: FamilyResolver,
  unsupported: UnsupportedDeclaration[],
): InlineContent;
```

**Why `resolveFamily` is injected:** `ComputedStyle.fontFamily` is a list of
family NAMES and `TextRun.font` is an `AuthoringFont`. Turning one into the
other needs a `Document` — `LoadFontByName` — which a pure leaf may not
import. `zch2.5` supplies the real resolver; tests supply a Standard-14 stub.

- [ ] **Step 1: Write the failing test**

Create `test/cssinline.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { computeStyles } from '../src/csscompute.js';
import { inlineContentOf } from '../src/cssinline.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ComputedStyle, UnsupportedDeclaration } from '../src/cssprop.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

/** A Standard-14 stub: enough to tell the four faces apart by name. */
const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

function elementsOf(n: HtmlNode): HtmlElement[] {
  const out: HtmlElement[] = [];
  const walk = (x: HtmlNode): void => {
    if (x.kind === 'element') out.push(x);
    if (x.kind === 'element' || x.kind === 'document' || x.kind === 'fragment') {
      for (const c of x.children) walk(c);
    }
  };
  walk(n);
  return out;
}

/** Lower the inline children of `#t`. */
function lower(src: string): {
  runs: ReturnType<typeof inlineContentOf>['runs'];
  atomics: ReturnType<typeof inlineContentOf>['atomics'];
  unsupported: UnsupportedDeclaration[];
} {
  const doc = parseHtml(src);
  const { styles } = computeStyles(doc);
  const el = elementsOf(doc).find((e) => e.attrs.get('id') === 't') as HtmlElement;
  const style = styles.get(el) as ComputedStyle;
  const unsupported: UnsupportedDeclaration[] = [];
  const c = inlineContentOf(el.children, style, styles, resolver, unsupported);
  return { runs: c.runs, atomics: c.atomics, unsupported };
}

const texts = (src: string): string[] => lower(src).runs.map((r) => r.text);

describe('text and runs', () => {
  it('lowers a single text node to one run', () => {
    expect(texts('<p id=t>hello</p>')).toEqual(['hello']);
  });

  it('MERGES adjacent pieces of identical style into one run', () => {
    // A run per DOM node would give layoutRuns three runs for `a<span>b</span>c`
    // where one is right, and it would move bytes against the string path.
    expect(texts('<p id=t>a<span>b</span>c</p>')).toEqual(['abc']);
  });

  it('splits a run where the derived style changes', () => {
    expect(texts('<p id=t>a<b>b</b>c</p>')).toEqual(['a', 'b', 'c']);
  });

  it('picks the bold face at weight >= 600, matching fontmatch.ts bold slot', () => {
    // fontmatch.ts's bold slot is `weight >= 600`, so a family shipping
    // Semibold and no 700 still has a bold face. One rule, not two.
    const r = lower('<p id=t>a<span style="font-weight:600">b</span></p>').runs;
    expect(r[0]?.font).toBe('Helvetica');
    expect(r[1]?.font).toBe('Helvetica-Bold');
  });

  it('picks the italic and bold-italic faces', () => {
    expect(lower('<p id=t><i>a</i></p>').runs[0]?.font).toBe('Helvetica-Oblique');
    expect(lower('<p id=t><b><i>a</i></b></p>').runs[0]?.font)
      .toBe('Helvetica-BoldOblique');
  });

  it('carries font size and colour', () => {
    const r = lower('<p id=t style="font-size:20px;color:red">a</p>').runs[0];
    expect(r?.fontSize).toBe(20);
    expect(r?.color).toEqual([1, 0, 0]);
  });
});

describe('decoration', () => {
  it('maps underline and line-through', () => {
    expect(lower('<p id=t><u>a</u></p>').runs[0]?.underline).toBeTruthy();
    expect(lower('<p id=t><s>a</s></p>').runs[0]?.strikethrough).toBeTruthy();
  });

  it('maps a non-transparent background and omits a transparent one', () => {
    expect(lower('<p id=t><span style="background-color:yellow">a</span></p>')
      .runs[0]?.background).toEqual({ color: [1, 1, 0] });
    expect(lower('<p id=t>a</p>').runs[0]?.background).toBeUndefined();
  });

  it('records overline, which TextRun cannot express', () => {
    const { runs, unsupported } = lower(
      '<p id=t><span style="text-decoration:overline">a</span></p>');
    expect(runs[0]?.underline).toBeFalsy();
    expect(unsupported.some((u) => u.property === 'text-decoration-line')).toBe(true);
  });

  it('records a translucent text colour, whose alpha TextRun cannot carry', () => {
    const { runs, unsupported } = lower(
      '<p id=t style="color:rgba(255,0,0,0.5)">a</p>');
    expect(runs[0]?.color).toEqual([1, 0, 0]);          // flattened, not dropped
    expect(unsupported.some((u) => u.property === 'color')).toBe(true);
  });
});

describe('links', () => {
  it('sets link on the runs inside an <a href>', () => {
    const r = lower('<p id=t>a<a href="http://x/">b</a>c</p>').runs;
    expect(r.map((x) => x.link)).toEqual([undefined, 'http://x/', undefined]);
  });

  it('does NOT merge two differently-destined links that style identically', () => {
    // The destination is part of a run's identity: merging would point the
    // whole phrase at the second URI — output that renders perfectly and
    // links wrongly. mdruns.ts records the same rule.
    const r = lower('<p id=t><a href="x">a</a><a href="y">b</a></p>').runs;
    expect(r.length).toBe(2);
    expect(r.map((x) => x.link)).toEqual(['x', 'y']);
  });

  it('ignores an <a> with no href, which is not a link', () => {
    expect(lower('<p id=t><a>a</a></p>').runs[0]?.link).toBeUndefined();
  });
});

describe('white-space', () => {
  it('collapses runs of whitespace under the default normal', () => {
    expect(texts('<p id=t>a \n\t b</p>')).toEqual(['a b']);
  });

  it('strips whitespace at the START and END of the context', () => {
    expect(texts('<p id=t>   a   </p>')).toEqual(['a']);
  });

  it('protects indentation under pre', () => {
    // Through preformat, so the U+00A0 rule has one owner. layoutRuns
    // collapses runs of spaces, which would otherwise eat the indent.
    const r = texts('<p id=t style="white-space:pre">  a</p>');
    expect(r[0]).toBe('  a');
  });

  it('keeps newlines under pre-line but collapses spaces', () => {
    expect(texts('<p id=t style="white-space:pre-line">a  \n  b</p>'))
      .toEqual(['a\nb']);
  });

  it('turns <br> into a newline, which layoutRuns breaks on', () => {
    expect(texts('<p id=t>a<br>b</p>')).toEqual(['a\nb']);
  });
});

describe('nested boxes and atomics', () => {
  it('skips a display:none subtree entirely', () => {
    expect(texts('<p id=t>a<span style="display:none">HIDDEN</span>b</p>'))
      .toEqual(['ab']);
  });

  it('records an inline image as an atomic, positioned by run index', () => {
    const { runs, atomics } = lower('<p id=t>a<img src=x.png>b</p>');
    expect(atomics.length).toBe(1);
    expect(atomics[0]?.kind).toBe('image');
    expect(atomics[0]?.beforeRun).toBe(1);
    expect(runs.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('never throws, on any inline content', () => {
    for (const s of ['<p id=t></p>', '<p id=t> </p>', '<p id=t><span></span></p>',
      '<p id=t><a href="">x</a></p>', '<p id=t><br></p>']) {
      expect(() => lower(s), s).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssinline.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssinline.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssinline.ts`:

```ts
/** An inline formatting context's content, lowered to the TextRun model.
 *
 *  Invariant: a PURE LEAF over cssprop.js, textdecor.js, mdstyle.js,
 *  preformat.js and htmldom.js — all for types or pure functions. No
 *  Document, no Page, no PDF object module, no `node:` import.
 *
 *  Invariant: it adds NO wrapping engine. CLAUDE.md's rule is that there is
 *  ONE, `layoutRuns` in layout.ts, and that a second wrapper lets a box
 *  measure one way and paint another. So an IFC lowers to TextRun[] and
 *  layoutRuns wraps it — which also inherits justification, per-line leading
 *  and runlink.ts's link-rect geometry for free.
 *
 *  Invariant: `resolveFamily` is INJECTED. ComputedStyle.fontFamily is a list
 *  of family NAMES and TextRun.font is an AuthoringFont; turning one into the
 *  other needs Document.LoadFontByName, which this module may not import.
 *  zch2.5 supplies the real resolver.
 *
 *  Invariant: adjacent pieces of identical style MERGE into one run. A run per
 *  DOM node gives layoutRuns three runs for `a<span>b</span>c` where one is
 *  right, and moves bytes against the plain-string path. The merge key folds
 *  in the LINK DESTINATION, because `[a](x)[b](y)` styles identically on both
 *  sides and merging would point the whole phrase at the second URI — output
 *  that renders perfectly and links wrongly. mdruns.ts records the same rule. */

import type { HtmlElement, HtmlNode } from './htmldom.js';
import type { ComputedStyle, UnsupportedDeclaration } from './cssprop.js';
import type { Color } from './cssvalue.js';
import type { TextRun } from './textdecor.js';
import type { ResolvedFamily } from './mdstyle.js';
import { faceFor } from './mdstyle.js';
import { preformat } from './preformat.js';

export type FamilyResolver = (families: string[]) => ResolvedFamily;

export interface AtomicInline {
  kind: 'image';
  el: HtmlElement;
  style: ComputedStyle;
  /** The index of the run this sits BEFORE; `runs.length` means at the end. */
  beforeRun: number;
}

export interface InlineContent { runs: TextRun[]; atomics: AtomicInline[] }

/** Tabs expand to this many columns under `pre`. CSS's `tab-size` initial. */
const TAB_WIDTH = 8;

/** fontmatch.ts's bold slot is `weight >= 600`, so a family shipping Semibold
 *  and no 700 still has a bold face. One rule, not two. */
const BOLD_AT = 600;

function rgbOf(c: Color): [number, number, number] {
  return [c.rgb[0], c.rgb[1], c.rgb[2]];
}

/** Apply CSS white-space processing to one text node's data. */
function processText(data: string, ws: ComputedStyle['whiteSpace']): string {
  if (ws === 'pre' || ws === 'pre-wrap') return preformat(data, TAB_WIDTH);
  if (ws === 'pre-line') {
    // Spaces and tabs collapse; newlines survive as hard breaks.
    return data.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
  }
  // normal and nowrap: every run of whitespace becomes one space. `nowrap`
  // differs only in whether a line may BREAK there, which is layoutRuns'
  // question and not this module's.
  return data.replace(/\s+/g, ' ');
}

/** The styling in force at a point in the inline tree. */
interface State {
  style: ComputedStyle;
  link: string | undefined;
}

/** A run's identity. Two adjacent pieces merge when these agree. */
function keyOf(r: TextRun): string {
  return JSON.stringify([
    r.font, r.fontSize, r.color, r.underline, r.strikethrough,
    r.background, r.link,
  ]);
}

function runFor(
  text: string, s: State, resolveFamily: FamilyResolver,
  el: HtmlElement | null, unsupported: UnsupportedDeclaration[],
): TextRun {
  const st = s.style;
  const family = resolveFamily(st.fontFamily);
  const run: TextRun = {
    text,
    font: faceFor(family, st.fontWeight >= BOLD_AT, st.fontStyle !== 'normal'),
    fontSize: st.fontSize,
    color: rgbOf(st.color),
  };
  // TextRun.color has no alpha. Flatten and RECORD, rather than dropping the
  // colour or inventing a field every existing caller would have to ignore.
  if (st.color.a < 1) {
    unsupported.push({
      el, property: 'color', value: `alpha ${String(st.color.a)}`,
      reason: 'unparsable-value',
    });
  }
  if (st.textDecorationLine.includes('underline')) run.underline = true;
  if (st.textDecorationLine.includes('line-through')) run.strikethrough = true;
  if (st.textDecorationLine.includes('overline')) {
    unsupported.push({
      el, property: 'text-decoration-line', value: 'overline',
      reason: 'unparsable-value',
    });
  }
  if (st.backgroundColor.a > 0) run.background = { color: rgbOf(st.backgroundColor) };
  if (s.link !== undefined) run.link = s.link;
  return run;
}

export function inlineContentOf(
  nodes: HtmlNode[],
  parentStyle: ComputedStyle,
  styles: Map<HtmlElement, ComputedStyle>,
  resolveFamily: FamilyResolver,
  unsupported: UnsupportedDeclaration[],
): InlineContent {
  const runs: TextRun[] = [];
  const atomics: AtomicInline[] = [];

  const push = (text: string, s: State, el: HtmlElement | null): void => {
    if (text === '') return;
    const run = runFor(text, s, resolveFamily, el, unsupported);
    const last = runs[runs.length - 1];
    if (last !== undefined && keyOf(last) === keyOf(run)) { last.text += text; return; }
    runs.push(run);
  };

  const visit = (n: HtmlNode, s: State): void => {
    if (n.kind === 'text') { push(processText(n.data, s.style.whiteSpace), s, null); return; }
    if (n.kind !== 'element') return;               // comment, doctype

    const st = styles.get(n) ?? s.style;
    if (st.display === 'none') return;              // no box, no text, no margin

    if (n.ns === 'html' && n.name === 'br') {
      // layoutRuns breaks on a newline, so a hard break needs no run kind of
      // its own — the rule mdruns.ts already follows.
      push('\n', s, n);
      return;
    }
    if (n.ns === 'html' && n.name === 'img') {
      atomics.push({ kind: 'image', el: n, style: st, beforeRun: runs.length });
      return;
    }

    const href = n.ns === 'html' && n.name === 'a' ? n.attrs.get('href') : undefined;
    const next: State = {
      style: st,
      link: href !== undefined && href !== '' ? href : s.link,
    };
    for (const c of n.children) visit(c, next);
  };

  for (const n of nodes) visit(n, { style: parentStyle, link: undefined });

  // CSS strips whitespace at the start and end of a line. Only the ends of the
  // whole context are knowable here; the interior ones are layoutRuns'.
  //
  // A PLAIN SPACE trim, and that is what makes it safe under `pre`:
  // preformat has already turned a leading run of spaces into U+00A0, which
  // `/^ +/` does not match, so indentation survives a trim that prose needs.
  const first = runs[0];
  const last = runs[runs.length - 1];
  if (first !== undefined) first.text = first.text.replace(/^ +/, '');
  if (last !== undefined) last.text = last.text.replace(/ +$/, '');

  return { runs: runs.filter((r) => r.text !== ''), atomics };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssinline.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/cssinline.ts test/cssinline.test.ts
git commit -m "feat(zch2.3): lower an inline formatting context to TextRun[]

It adds NO wrapping engine. CLAUDE.md's rule is that there is ONE,
layoutRuns in layout.ts, and that a second wrapper lets a box measure one
way and paint another — so an IFC lowers to the TextRun model textdecor.ts
already defines, which also inherits justification, per-line leading and
runlink.ts's link-rect geometry for free.

Adjacent pieces of identical style MERGE: a run per DOM node gives
layoutRuns three runs for 'a<span>b</span>c' where one is right. The merge
key folds in the link destination, because two adjacent links style
identically and merging would point the whole phrase at the second URI —
output that renders perfectly and links wrongly.

resolveFamily is INJECTED: fontFamily is a list of NAMES and TextRun.font
is an AuthoringFont, and bridging them needs Document.LoadFontByName, which
a pure leaf may not import. The bold threshold is weight >= 600, matching
fontmatch.ts's bold slot rather than inventing a second rule.

Two things TextRun cannot express are flattened and RECORDED rather than
dropped: a translucent colour loses its alpha, and overline has no field.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 3: `cssbox.ts` — the box model and box generation

**Files:**
- Create: `src/cssbox.ts`
- Test: `test/cssbox.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced, plus `computeStyles` from `src/csscompute.js`.
- Produces:

```ts
export type BoxNode = BlockBox | TableBox;
export interface BlockBox {
  kind: 'block' | 'anonymous' | 'list-item';
  el: HtmlElement | null;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  content:
    | { kind: 'blocks'; children: BoxNode[] }
    | { kind: 'inline'; runs: TextRun[]; atomics: AtomicInline[] };
}
export interface TableBox {
  kind: 'table';
  el: HtmlElement;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
}
export function buildBoxes(
  root: HtmlDocument, resolveFamily: FamilyResolver,
): { boxes: BoxNode[]; unsupported: UnsupportedDeclaration[] };
```

**The core rule this task exists for:** a block container holds EITHER only
block-level children OR exactly one inline formatting context. Where an author
mixes them, the inline runs are wrapped in ANONYMOUS block boxes.

- [ ] **Step 1: Write the failing test**

Create `test/cssbox.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import type { BlockBox, BoxNode } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

const build = (src: string) => buildBoxes(parseHtml(src), resolver);

/** The box for `#<id>`, found anywhere in the tree. */
function find(boxes: BoxNode[], id: string): BoxNode | undefined {
  for (const b of boxes) {
    if (b.el?.attrs.get('id') === id) return b;
    if (b.kind !== 'table' && b.content.kind === 'blocks') {
      const hit = find(b.content.children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** A compact shape: kind, tag, and either child shapes or the run texts. */
function shape(b: BoxNode): unknown {
  if (b.kind === 'table') return ['table', b.el.name];
  const head = [b.kind, b.el?.name ?? '-'];
  return b.content.kind === 'blocks'
    ? [...head, b.content.children.map(shape)]
    : [...head, b.content.runs.map((r) => r.text)];
}

describe('display', () => {
  it('makes a box for a block element', () => {
    const b = find(build('<!doctype html><div id=t>x</div>').boxes, 't');
    expect(b?.kind).toBe('block');
  });

  it('makes NO box for display:none, and none for its subtree', () => {
    // Not a box flagged invisible: a hidden subtree must not reach zch2.4,
    // must not consume a margin, and must not take part in collapsing.
    const { boxes } = build('<!doctype html><div id=t style="display:none"><p id=k>x</p></div>');
    expect(find(boxes, 't')).toBeUndefined();
    expect(find(boxes, 'k')).toBeUndefined();
  });

  it('marks a list-item', () => {
    expect(find(build('<!doctype html><ul><li id=t>x</li></ul>').boxes, 't')?.kind)
      .toBe('list-item');
  });

  it('emits a table box OPAQUE, without descending into it', () => {
    // zch2.6 owns the anonymous-table fixup and builds through flowtable.ts.
    const { boxes } = build('<!doctype html><table id=t><tr><td id=k>x</td></tr></table>');
    const t = find(boxes, 't');
    expect(t?.kind).toBe('table');
    expect(find(boxes, 'k')).toBeUndefined();
  });
});

describe('the two formatting contexts', () => {
  it('gives a block with only text one INLINE context', () => {
    const b = find(build('<!doctype html><p id=t>a <b>b</b></p>').boxes, 't') as BlockBox;
    expect(b.content.kind).toBe('inline');
    expect(b.content.kind === 'inline' && b.content.runs.map((r) => r.text))
      .toEqual(['a ', 'b']);
  });

  it('gives a block with only block children a BLOCKS context', () => {
    const b = find(build('<!doctype html><div id=t><p>a</p><p>b</p></div>').boxes, 't') as BlockBox;
    expect(b.content.kind).toBe('blocks');
    expect(b.content.kind === 'blocks' && b.content.children.length).toBe(2);
  });

  it('WRAPS mixed inline content in anonymous block boxes', () => {
    // The rule the issue is named for. `a<p>b</p>c` is three block-level
    // boxes: anonymous, p, anonymous.
    const b = find(build('<!doctype html><div id=t>a<p>b</p>c</div>').boxes, 't') as BlockBox;
    expect(shape(b)).toEqual(['block', 'div', [
      ['anonymous', '-', ['a']],
      ['block', 'p', ['b']],
      ['anonymous', '-', ['c']],
    ]]);
  });

  it('makes NO anonymous box for whitespace between two blocks', () => {
    // `<div><p>a</p>\n<p>b</p></div>` has a text node between the two, and it
    // collapses to nothing. An anonymous box holding one space would add a
    // whole empty line to every prettily-indented document there is.
    const b = find(build('<!doctype html><div id=t><p>a</p>\n  <p>b</p></div>').boxes, 't') as BlockBox;
    expect(b.content.kind === 'blocks' && b.content.children.length).toBe(2);
  });

  it('gives an anonymous box its PARENT style, not a fresh initial one', () => {
    // It exists to hold inline content, so it must inherit the styling that
    // content is in. A fresh initial style resets the font and colour of
    // every mixed container in a document.
    const b = find(build(
      '<!doctype html><div id=t style="font-size:30px;color:red">a<p>b</p></div>').boxes,
    't') as BlockBox;
    const anon = b.content.kind === 'blocks' ? b.content.children[0] as BlockBox : undefined;
    expect(anon?.kind).toBe('anonymous');
    expect(anon?.style.fontSize).toBe(30);
    expect(anon?.content.kind === 'inline'
      && anon.content.runs[0]?.color).toEqual([1, 0, 0]);
  });
});

describe('float and clear', () => {
  it('carries float and clear onto the box', () => {
    const b = find(build(
      '<!doctype html><div id=t style="float:left;clear:both">x</div>').boxes, 't');
    expect(b?.float).toBe('left');
    expect(b?.clear).toBe('both');
  });

  it('defaults both to none', () => {
    const b = find(build('<!doctype html><div id=t>x</div>').boxes, 't');
    expect(b?.float).toBe('none');
    expect(b?.clear).toBe('none');
  });
});

describe('the whole build', () => {
  it('starts at the document element, not the document', () => {
    const { boxes } = build('<!doctype html><p>x</p>');
    expect(boxes.length).toBe(1);
    expect((boxes[0] as BlockBox).el?.name).toBe('html');
  });

  it('drops head, which the UA sheet gives display:none', () => {
    const { boxes } = build('<!doctype html><title>t</title><p id=t>x</p>');
    const html = boxes[0] as BlockBox;
    const kids = html.content.kind === 'blocks' ? html.content.children : [];
    expect(kids.some((k) => (k as BlockBox).el?.name === 'head')).toBe(false);
    expect(find(boxes, 't')).toBeDefined();
  });

  it('carries the cascade unsupported list through', () => {
    const { unsupported } = build('<!doctype html><style>p{box-shadow:0 0 2px}</style><p>x</p>');
    expect(unsupported.some((u) => u.property === 'box-shadow')).toBe(true);
  });

  it('never throws, on any document', () => {
    for (const s of ['', '<p>x</p>', '<div><span>a</span></div>',
      '<table><tr><td>x</td></tr></table>', '<template><b>x</b></template>',
      '<div style="display:none"></div>']) {
      expect(() => build(s), s).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssbox.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssbox.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssbox.ts`:

```ts
/** Box generation: the styled tree to a box tree.
 *
 *  Invariant: a PURE LEAF over csscompute.js, cssprop.js, cssinline.js and
 *  htmldom.js. No Document, no Page, no PDF object module, no `node:` import.
 *
 *  Invariant: IT POSITIONS NOTHING. No x, no y, no line break, no page break.
 *  cssresolve.ts resolves a box against a width and zch2.4 hands the result to
 *  flow.ts, which does the stacking and the pagination it already does for
 *  Markdown. A step here that reaches for a coordinate is a step in the wrong
 *  issue.
 *
 *  Invariant, and the rule this module exists for: a block container holds
 *  EITHER only block-level children OR exactly one inline formatting context.
 *  Where an author mixes them the inline runs are wrapped in ANONYMOUS block
 *  boxes — which is what "block and inline formatting contexts" means.
 *
 *  Invariant: an anonymous box carries its PARENT's computed style and no
 *  element. It exists to hold inline content, so it must inherit the styling
 *  that content is in; a fresh initial style would reset the font and colour
 *  of every mixed container in a document.
 *
 *  Invariant: `display: none` generates NO BOX, rather than a box flagged
 *  invisible. A hidden subtree must not reach zch2.4, must not consume a
 *  margin, and must not take part in margin collapsing.
 *
 *  Invariant: a table-display box is emitted OPAQUE and not descended into.
 *  CSS 2.1 §17.2.1's anonymous-table fixup belongs with zch2.6, the issue that
 *  knows what a table becomes and builds it through flowtable.ts. */

import type { HtmlDocument, HtmlElement, HtmlNode } from './htmldom.js';
import type { ComputedStyle, UnsupportedDeclaration } from './cssprop.js';
import type { TextRun } from './textdecor.js';
import { computeStyles } from './csscompute.js';
import { inlineContentOf } from './cssinline.js';
import type { AtomicInline, FamilyResolver } from './cssinline.js';

export interface BlockBox {
  kind: 'block' | 'anonymous' | 'list-item';
  /** null for an anonymous box, which corresponds to no element. */
  el: HtmlElement | null;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
  content:
    | { kind: 'blocks'; children: BoxNode[] }
    | { kind: 'inline'; runs: TextRun[]; atomics: AtomicInline[] };
}

export interface TableBox {
  kind: 'table';
  el: HtmlElement;
  style: ComputedStyle;
  float: 'none' | 'left' | 'right';
  clear: 'none' | 'left' | 'right' | 'both';
}

export type BoxNode = BlockBox | TableBox;

const TABLE_DISPLAYS = new Set<ComputedStyle['display']>([
  'table', 'table-row-group', 'table-header-group', 'table-footer-group',
  'table-row', 'table-cell', 'table-caption',
]);

const BLOCK_DISPLAYS = new Set<ComputedStyle['display']>(['block', 'list-item']);

/** Is this node block-LEVEL, i.e. does it force its parent into a BFC? */
function isBlockLevel(n: HtmlNode, styles: Map<HtmlElement, ComputedStyle>): boolean {
  if (n.kind !== 'element') return false;
  const st = styles.get(n);
  if (st === undefined) return false;
  return BLOCK_DISPLAYS.has(st.display) || TABLE_DISPLAYS.has(st.display);
}

/** Does this node contribute anything to an inline context?
 *
 *  A text node of pure whitespace does NOT. `<div><p>a</p>\n<p>b</p></div>`
 *  has a text node between the two blocks and it collapses to nothing; an
 *  anonymous box holding one space would add a whole empty line to every
 *  prettily-indented document there is. */
function contributesInline(n: HtmlNode, styles: Map<HtmlElement, ComputedStyle>): boolean {
  if (n.kind === 'text') return n.data.trim() !== '';
  if (n.kind !== 'element') return false;
  return styles.get(n)?.display !== 'none';
}

export function buildBoxes(
  root: HtmlDocument, resolveFamily: FamilyResolver,
): { boxes: BoxNode[]; unsupported: UnsupportedDeclaration[] } {
  const { styles, unsupported } = computeStyles(root);

  const boxFor = (el: HtmlElement): BoxNode | null => {
    const style = styles.get(el);
    if (style === undefined || style.display === 'none') return null;

    const float = style.float;
    const clear = style.clear;

    if (TABLE_DISPLAYS.has(style.display)) {
      return { kind: 'table', el, style, float, clear };
    }

    const kind: BlockBox['kind'] = style.display === 'list-item' ? 'list-item' : 'block';

    // Does any child force a block formatting context?
    const hasBlockChild = el.children.some((c) => isBlockLevel(c, styles));

    if (!hasBlockChild) {
      const c = inlineContentOf(el.children, style, styles, resolveFamily, unsupported);
      return { kind, el, style, float, clear, content: { kind: 'inline', ...c } };
    }

    // A BFC. Runs of inline-level children between the block-level ones are
    // gathered into anonymous boxes.
    const children: BoxNode[] = [];
    let pending: HtmlNode[] = [];
    const flush = (): void => {
      if (!pending.some((n) => contributesInline(n, styles))) { pending = []; return; }
      const c = inlineContentOf(pending, style, styles, resolveFamily, unsupported);
      if (c.runs.length > 0 || c.atomics.length > 0) {
        children.push({
          kind: 'anonymous', el: null, style, float: 'none', clear: 'none',
          content: { kind: 'inline', ...c },
        });
      }
      pending = [];
    };

    for (const child of el.children) {
      if (isBlockLevel(child, styles)) {
        flush();
        const b = child.kind === 'element' ? boxFor(child) : null;
        if (b !== null) children.push(b);
        continue;
      }
      pending.push(child);
    }
    flush();

    return { kind, el, style, float, clear, content: { kind: 'blocks', children } };
  };

  // The DOCUMENT ELEMENT is the root box, not the document: a document is not
  // a box and has no style.
  const docEl = root.children.find((c): c is HtmlElement => c.kind === 'element');
  const boxes: BoxNode[] = [];
  if (docEl !== undefined) {
    const b = boxFor(docEl);
    if (b !== null) boxes.push(b);
  }
  return { boxes, unsupported };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssbox.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/cssbox.ts test/cssbox.test.ts
git commit -m "feat(zch2.3): box generation and the two formatting contexts

The rule the issue is named for: a block container holds EITHER only
block-level children OR exactly one inline formatting context, and where an
author mixes them the inline runs are wrapped in anonymous block boxes.

Three rules that are silent when wrong, each with its own test. An
anonymous box carries its PARENT's style and no element — a fresh initial
style would reset the font and colour of every mixed container in a
document. display:none generates NO BOX rather than an invisible one, so a
hidden subtree cannot consume a margin or take part in collapsing. And a
whitespace-only text node between two blocks makes no anonymous box at all,
or every prettily-indented document gains an empty line per nesting level.

A table-display box is emitted OPAQUE and not descended into: CSS 2.1
§17.2.1's anonymous-table fixup belongs with zch2.6, which knows what a
table becomes.

It positions nothing — no x, no y, no line break, no page break.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 4: `cssresolve.ts` — used widths, insets and min-height

**Files:**
- Create: `src/cssresolve.ts`
- Test: `test/cssresolve.test.ts`

**Interfaces:**
- Consumes: `BoxNode`, `BlockBox` from `src/cssbox.js`; `LengthPct`, `Auto` from `src/cssvalue.js` / `src/cssprop.js`.
- Produces:

```ts
export interface ResolvedBox {
  box: BoxNode;
  /** The content box's width. */
  contentWidth: number;
  insetLeft: number; insetRight: number;    // border + padding
  insetTop: number; insetBottom: number;
  /** Resolved to px, BEFORE collapsing. cssmargin.ts collapses them. */
  marginTop: number; marginBottom: number;
  marginLeft: number; marginRight: number;
  /** From `height`, treated as a MINIMUM. 0 when `auto`. */
  minHeight: number;
}
export type MeasureFn = (box: BoxNode) => { min: number; max: number };
export function resolveBoxes(
  boxes: BoxNode[], containingWidth: number, measure?: MeasureFn,
): ResolvedBox[];
```

- [ ] **Step 1: Write the failing test**

Create `test/cssresolve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { resolveBoxes } from '../src/cssresolve.js';
import type { BlockBox, BoxNode } from '../src/cssbox.js';
import type { ResolvedBox, MeasureFn } from '../src/cssresolve.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

function find(boxes: BoxNode[], id: string): BoxNode | undefined {
  for (const b of boxes) {
    if (b.el?.attrs.get('id') === id) return b;
    if (b.kind !== 'table' && b.content.kind === 'blocks') {
      const hit = find(b.content.children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** Resolve `#t` against `width`, with `#t` treated as a direct child of it. */
function r(src: string, width = 800, measure?: MeasureFn): ResolvedBox {
  const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
  const box = find(boxes, 't') as BoxNode;
  return resolveBoxes([box], width, measure)[0] as ResolvedBox;
}

describe('the CSS 2.1 §10.3.3 case analysis', () => {
  it('width auto fills the containing block', () => {
    expect(r('<div id=t>x</div>').contentWidth).toBe(800);
  });

  it('subtracts padding and border from an auto width', () => {
    // Measured in Chrome: 800 - 2*10 - 2*5 = 770.
    const b = r('<div id=t style="padding:10px;border:5px solid black">x</div>');
    expect(b.contentWidth).toBe(770);
    expect(b.insetLeft).toBe(15);
    expect(b.insetRight).toBe(15);
  });

  it('honours a stated width and a percentage width', () => {
    expect(r('<div id=t style="width:300px">x</div>').contentWidth).toBe(300);
    expect(r('<div id=t style="width:50%">x</div>').contentWidth).toBe(400);
  });

  it('CENTRES with both margins auto, splitting the remainder EQUALLY', () => {
    // Measured in Chrome: width:50%; margin:0 auto in an 800px block gives a
    // 400px content box with 200px on each side. Splitting unevenly gives a
    // document that looks fine and is never centred.
    const b = r('<div id=t style="width:400px;margin:0 auto">x</div>');
    expect(b.contentWidth).toBe(400);
    expect(b.marginLeft).toBe(200);
    expect(b.marginRight).toBe(200);
  });

  it('lets ONE auto margin absorb the whole remainder', () => {
    const b = r('<div id=t style="width:400px;margin-left:auto;margin-right:0">x</div>');
    expect(b.marginLeft).toBe(400);
    expect(b.marginRight).toBe(0);
  });

  it('turns an auto margin into 0 when the WIDTH is auto', () => {
    // width absorbs the remainder and the margins do not.
    const b = r('<div id=t style="margin:0 auto">x</div>');
    expect(b.marginLeft).toBe(0);
    expect(b.marginRight).toBe(0);
    expect(b.contentWidth).toBe(800);
  });

  it('adjusts margin-right when over-constrained', () => {
    // Nothing is auto and the numbers do not add up: margin-right gives way.
    const b = r('<div id=t style="width:700px;margin-left:200px;margin-right:200px">x</div>');
    expect(b.marginLeft).toBe(200);
    expect(b.marginRight).toBe(-100);
    expect(b.contentWidth).toBe(700);
  });

  it('never gives a negative content width', () => {
    expect(r('<div id=t style="padding:600px">x</div>').contentWidth).toBe(0);
  });
});

describe('percentages', () => {
  it('resolves a percentage margin against the containing WIDTH', () => {
    // Even a VERTICAL one. That is the rule that surprises, and it is why
    // resolution takes a width rather than baking one in.
    const b = r('<div id=t style="margin-top:10%;margin-bottom:10%">x</div>');
    expect(b.marginTop).toBe(80);
    expect(b.marginBottom).toBe(80);
  });

  it('resolves a percentage padding against the containing WIDTH too', () => {
    const b = r('<div id=t style="padding-top:10%">x</div>');
    expect(b.insetTop).toBe(80);
  });
});

describe('height is a minimum', () => {
  it('reports a stated height as minHeight', () => {
    expect(r('<div id=t style="height:200px">x</div>').minHeight).toBe(200);
  });

  it('reports 0 for auto, which is every box that states none', () => {
    expect(r('<div id=t>x</div>').minHeight).toBe(0);
  });

  it('ignores a percentage height rather than guessing', () => {
    // It resolves against the containing block's HEIGHT, which a module that
    // positions nothing does not have. 0 means "content-sized", which is what
    // the box would have been anyway.
    expect(r('<div id=t style="height:50%">x</div>').minHeight).toBe(0);
  });
});

describe('shrink-to-fit for a float', () => {
  const measure: MeasureFn = () => ({ min: 50, max: 300 });

  it('takes the max-content width when it fits', () => {
    expect(r('<div id=t style="float:left">x</div>', 800, measure).contentWidth)
      .toBe(300);
  });

  it('takes the available width when max-content exceeds it', () => {
    expect(r('<div id=t style="float:left">x</div>', 200, measure).contentWidth)
      .toBe(200);
  });

  it('never goes below min-content', () => {
    expect(r('<div id=t style="float:left">x</div>', 20, measure).contentWidth)
      .toBe(50);
  });

  it('honours a STATED width on a float, measuring nothing', () => {
    let called = false;
    const spy: MeasureFn = () => { called = true; return { min: 1, max: 2 }; };
    expect(r('<div id=t style="float:left;width:120px">x</div>', 800, spy).contentWidth)
      .toBe(120);
    expect(called).toBe(false);
  });

  it('falls back to the full width when no measurer is supplied', () => {
    expect(r('<div id=t style="float:left">x</div>', 800).contentWidth).toBe(800);
  });

  it('does NOT shrink-to-fit a non-floated box', () => {
    expect(r('<div id=t>x</div>', 800, measure).contentWidth).toBe(800);
  });
});

describe('the whole call', () => {
  it('returns one entry per input box, in order', () => {
    const { boxes } = buildBoxes(
      parseHtml('<!doctype html><div><p id=a>a</p><p id=b>b</p></div>'), resolver);
    const html = boxes[0] as BlockBox;
    const kids = html.content.kind === 'blocks' ? html.content.children : [];
    expect(resolveBoxes(kids, 800).length).toBe(kids.length);
  });

  it('never throws', () => {
    for (const s of ['<div id=t></div>', '<div id=t style="width:0">x</div>',
      '<div id=t style="margin:auto">x</div>', '<table id=t><tr><td>x</td></tr></table>']) {
      expect(() => r(s), s).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssresolve.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssresolve.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssresolve.ts`:

```ts
/** Resolving a box against a containing-block WIDTH: used widths, insets,
 *  margins and min-height.
 *
 *  Invariant: a PURE LEAF over cssbox.js, cssprop.js and cssvalue.js — types
 *  and arithmetic only. No Document, no PDF object module, no `node:` import.
 *
 *  Invariant: it takes a WIDTH as an argument rather than baking one in, and
 *  that is forced rather than preferred. A percentage margin resolves against
 *  the containing block's WIDTH — vertical margins included, which is the
 *  part that surprises — so nothing here can be precomputed. flow.ts supplies
 *  the width at place() time.
 *
 *  Invariant: a percentage HEIGHT is ignored and reported as 0. It resolves
 *  against the containing block's HEIGHT, which a module that positions
 *  nothing does not have; 0 means content-sized, which is what the box would
 *  have been anyway.
 *
 *  Invariant: `measure` is INJECTED, the seam grayimage.ts uses for
 *  resolve/inflate. Shrink-to-fit needs intrinsic widths, and measuring text
 *  means layoutRuns, which would drag a font stack into a pure leaf. */

import type { BoxNode } from './cssbox.js';
import type { ComputedStyle } from './cssprop.js';
import type { LengthPct } from './cssvalue.js';

export interface ResolvedBox {
  box: BoxNode;
  contentWidth: number;
  insetLeft: number; insetRight: number;
  insetTop: number; insetBottom: number;
  marginTop: number; marginBottom: number;
  marginLeft: number; marginRight: number;
  minHeight: number;
}

/** Intrinsic widths of a box's own content, for a float's shrink-to-fit. */
export type MeasureFn = (box: BoxNode) => { min: number; max: number };

/** A length or percentage against the containing WIDTH. */
function px(v: LengthPct, width: number): number {
  return 'px' in v ? v.px : (width * v.pct) / 100;
}

/** A margin, which may also be `auto`. `auto` is reported as undefined so the
 *  §10.3.3 case analysis can see which of the three are open. */
function marginPx(v: ComputedStyle['marginTop'], width: number): number | undefined {
  return v === 'auto' ? undefined : px(v, width);
}

export function resolveBoxes(
  boxes: BoxNode[], containingWidth: number, measure?: MeasureFn,
): ResolvedBox[] {
  return boxes.map((box) => resolveOne(box, containingWidth, measure));
}

function resolveOne(box: BoxNode, cw: number, measure?: MeasureFn): ResolvedBox {
  const s = box.style;

  const insetLeft = s.borderLeftWidth + px(s.paddingLeft, cw);
  const insetRight = s.borderRightWidth + px(s.paddingRight, cw);
  const insetTop = s.borderTopWidth + px(s.paddingTop, cw);
  const insetBottom = s.borderBottomWidth + px(s.paddingBottom, cw);

  // Vertical margins resolve against the WIDTH, and `auto` on one is 0.
  const marginTop = marginPx(s.marginTop, cw) ?? 0;
  const marginBottom = marginPx(s.marginBottom, cw) ?? 0;

  let mLeft = marginPx(s.marginLeft, cw);
  let mRight = marginPx(s.marginRight, cw);
  const stated = s.width === 'auto' ? undefined : px(s.width, cw);

  // A FLOAT with an auto width is shrink-to-fit rather than fill.
  let width: number | undefined = stated;
  if (width === undefined && box.float !== 'none') {
    const avail = Math.max(0, cw - (mLeft ?? 0) - (mRight ?? 0) - insetLeft - insetRight);
    if (measure !== undefined) {
      const { min, max } = measure(box);
      width = Math.max(min, Math.min(max, avail));
    } else {
      width = avail;
    }
    mLeft ??= 0;
    mRight ??= 0;
  }

  // CSS 2.1 §10.3.3. The constraint is
  //   marginLeft + insetLeft + width + insetRight + marginRight = cw
  // and the algorithm is a case analysis over which of the three are `auto`.
  if (width === undefined) {
    // `width: auto` absorbs the remainder; an `auto` margin becomes 0.
    mLeft ??= 0;
    mRight ??= 0;
    width = cw - mLeft - mRight - insetLeft - insetRight;
  } else if (mLeft === undefined && mRight === undefined) {
    // Both margins auto: the remainder splits EQUALLY. This is how
    // `margin: 0 auto` centres, and splitting it unevenly gives a document
    // that looks fine and is never centred.
    const rest = cw - width - insetLeft - insetRight;
    mLeft = rest / 2;
    mRight = rest / 2;
  } else if (mLeft === undefined) {
    mLeft = cw - width - insetLeft - insetRight - (mRight as number);
  } else if (mRight === undefined) {
    mRight = cw - width - insetLeft - insetRight - mLeft;
  } else {
    // Nothing auto. If the numbers do not add up the box is over-constrained
    // and margin-right gives way — which is what makes it the only value that
    // can come out negative.
    mRight = cw - width - insetLeft - insetRight - mLeft;
  }

  // A percentage height resolves against a height we do not have; 0 means
  // content-sized, which is what the box would have been anyway.
  const minHeight = s.height === 'auto' || !('px' in s.height) ? 0 : s.height.px;

  return {
    box,
    contentWidth: Math.max(0, width),
    insetLeft, insetRight, insetTop, insetBottom,
    marginTop, marginBottom, marginLeft: mLeft, marginRight: mRight,
    minHeight,
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssresolve.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/cssresolve.ts test/cssresolve.test.ts
git commit -m "feat(zch2.3): used widths, insets and min-height

CSS 2.1 §10.3.3 transcribed rather than approximated: a case analysis over
which of margin-left, width and margin-right are auto. The both-auto case
splits the remainder EQUALLY, which is how 'margin: 0 auto' centres and is
the one line whose failure gives a document that looks fine and is never
centred. Over-constrained, margin-right gives way — which is why it is the
only value that can come out negative.

Two numbers are checked against Chrome rather than reasoned about: a block
in an 800px container with 10px padding and 5px borders has a 770px content
box, and width:50% with margin:0 auto gives 400px with 200px each side.

It takes a WIDTH as an argument rather than baking one in, and that is
forced: a percentage margin resolves against the containing block's width,
vertical margins included. A percentage HEIGHT is ignored and reported as 0
— it resolves against a height a module that positions nothing does not
have, and 0 means content-sized, which is what the box would have been.

Shrink-to-fit for a float takes an INJECTED measure callback, the seam
grayimage.ts uses: measuring text means layoutRuns, and importing it would
drag a font stack into a pure leaf. With no measurer a float falls back to
the full available width.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `cssmargin.ts` — the four collapsing rules

**Files:**
- Create: `src/cssmargin.ts`
- Test: `test/cssmargin.test.ts`

**Interfaces:**
- Consumes: `ResolvedBox` from `src/cssresolve.js`; `BlockBox` from `src/cssbox.js`.
- Produces:

```ts
/** The gap BEFORE each box, after collapsing. Parallel to the input. */
export function collapseMargins(resolved: ResolvedBox[]): number[];
/** Combine two adjoining margins: the largest positive plus the most
 *  negative. NOT `max`. */
export function combineMargins(a: number, b: number): number;
/** The margin that escapes a box's top edge, and the one that escapes its
 *  bottom, after rules 2, 3 and 4 have run over its own subtree. */
export function outerMargins(r: ResolvedBox): { top: number; bottom: number };
```

- [ ] **Step 1: Write the failing test**

Create `test/cssmargin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { resolveBoxes } from '../src/cssresolve.js';
import { collapseMargins, combineMargins, outerMargins } from '../src/cssmargin.js';
import type { BlockBox, BoxNode } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

/** The collapsed gaps before each child of `#t`. */
function gaps(src: string, width = 800): number[] {
  const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
  const find = (bs: BoxNode[]): BoxNode | undefined => {
    for (const b of bs) {
      if (b.el?.attrs.get('id') === 't') return b;
      if (b.kind !== 'table' && b.content.kind === 'blocks') {
        const hit = find(b.content.children);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const t = find(boxes) as BlockBox;
  const kids = t.content.kind === 'blocks' ? t.content.children : [];
  return collapseMargins(resolveBoxes(kids, width));
}

describe('combineMargins', () => {
  it('takes the larger of two positives', () => {
    expect(combineMargins(30, 20)).toBe(30);
    expect(combineMargins(20, 30)).toBe(30);
  });

  it('is the largest positive PLUS the most negative, not max', () => {
    // 40 against -10 is 30. A document with no negative margins cannot tell
    // the two readings apart, which is why the fixture uses one.
    expect(combineMargins(40, -10)).toBe(30);
    expect(combineMargins(-10, 40)).toBe(30);
  });

  it('takes the most negative when both are negative', () => {
    expect(combineMargins(-10, -30)).toBe(-30);
  });

  it('is 0 for two zeroes', () => {
    expect(combineMargins(0, 0)).toBe(0);
  });
});

describe('rule 1: adjacent siblings', () => {
  it('collapses to the larger of the two', () => {
    // Measured in Chrome: 30px bottom against 20px top gives a 30px gap.
    expect(gaps('<div id=t><p style="margin:0 0 30px">a</p>'
      + '<p style="margin:20px 0 0">b</p></div>')).toEqual([0, 30]);
  });

  it('gives the FIRST child no gap of its own', () => {
    // Its own top margin escapes the parent under rule 2; it is not a gap
    // between siblings, and counting it twice doubles the space above.
    expect(gaps('<div id=t><p style="margin-top:20px">a</p></div>')).toEqual([0]);
  });
});

describe('rule 2: parent and first in-flow child', () => {
  it('lets a child top margin escape a parent with no top border or padding', () => {
    // Measured in Chrome: a zero-margin wrapper whose first child has
    // margin-top:40px produces a 40px gap BEFORE THE WRAPPER, and
    // wrap.top === child.top.
    expect(gaps('<div id=t><p>a</p><div><p style="margin-top:40px">b</p></div></div>')[1])
      .toBe(40);
  });

  it('does NOT let it escape a parent with top padding', () => {
    expect(gaps('<div id=t><p>a</p>'
      + '<div style="padding-top:1px"><p style="margin-top:40px">b</p></div></div>')[1])
      .toBe(0);
  });

  it('does NOT let it escape a parent with a top border', () => {
    expect(gaps('<div id=t><p>a</p>'
      + '<div style="border-top:1px solid black"><p style="margin-top:40px">b</p></div></div>')[1])
      .toBe(0);
  });
});

describe('rule 3: parent and last in-flow child', () => {
  it('lets a child bottom margin escape a parent with no height', () => {
    expect(gaps('<div id=t><div><p style="margin-bottom:40px">a</p></div>'
      + '<p>b</p></div>')[1]).toBe(40);
  });

  it('does NOT let it escape a parent that states a height', () => {
    // The condition that reads as an afterthought and is not: a parent with a
    // height has a bottom edge of its own for the margin to stop at.
    expect(gaps('<div id=t><div style="height:50px"><p style="margin-bottom:40px">a</p></div>'
      + '<p>b</p></div>')[1]).toBe(0);
  });

  it('does NOT let it escape a parent with bottom padding', () => {
    expect(gaps('<div id=t><div style="padding-bottom:1px">'
      + '<p style="margin-bottom:40px">a</p></div><p>b</p></div>')[1]).toBe(0);
  });
});

describe('rule 4: a wholly empty block', () => {
  it('collapses its own top and bottom margins together', () => {
    // An empty div with 20px top and 30px bottom contributes 30, not 50.
    expect(gaps('<div id=t><p>a</p><div style="margin:20px 0 30px"></div>'
      + '<p>b</p></div>')).toEqual([0, 30, 0]);
  });

  it('does NOT collapse one that has a border', () => {
    const g = gaps('<div id=t><p>a</p>'
      + '<div style="margin:20px 0 30px;border:1px solid black"></div><p>b</p></div>');
    expect(g[1]).toBe(20);
    expect(g[2]).toBe(30);
  });
});

describe('what does not collapse', () => {
  it('does not collapse a FLOAT margin with its siblings', () => {
    const g = gaps('<div id=t><p style="margin-bottom:30px">a</p>'
      + '<p style="float:left;margin-top:20px">b</p></div>');
    expect(g[1]).toBe(20);
  });

  it('does not collapse across a cleared box', () => {
    const g = gaps('<div id=t><p style="margin-bottom:30px">a</p>'
      + '<p style="clear:both;margin-top:20px">b</p></div>');
    expect(g[1]).toBe(20);
  });
});

describe('outerMargins', () => {
  it('reports a box own margins when nothing escapes', () => {
    const { boxes } = buildBoxes(
      parseHtml('<!doctype html><div id=t style="padding:1px;margin:10px 0 20px">x</div>'),
      resolver);
    const find = (bs: BoxNode[]): BoxNode | undefined => {
      for (const b of bs) {
        if (b.el?.attrs.get('id') === 't') return b;
        if (b.kind !== 'table' && b.content.kind === 'blocks') {
          const hit = find(b.content.children);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    };
    const r = resolveBoxes([find(boxes) as BoxNode], 800)[0]!;
    expect(outerMargins(r)).toEqual({ top: 10, bottom: 20 });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/cssmargin.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cssmargin.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cssmargin.ts`:

```ts
/** Margin collapsing, CSS 2.1 §8.3.1.
 *
 *  Invariant: a PURE LEAF over cssbox.js and cssresolve.js — types and
 *  arithmetic. No Document, no PDF object module, no `node:` import. Its own
 *  module rather than a section of cssresolve.ts because this is the geometry
 *  that is silently wrong when reversed, and it should be testable from
 *  numbers rather than from a built file — floatstack.ts's split.
 *
 *  Invariant: the combining rule is NOT `max`. Adjoining margins combine as
 *  the largest POSITIVE plus the most NEGATIVE, so 40px against -10px is 30px.
 *  A document with no negative margins cannot tell the two readings apart,
 *  which is why the fixture for it uses one.
 *
 *  Invariant: floats and cleared boxes do not collapse. Neither does the root.
 *
 *  Note for zch2.4, and it is the whole point of returning GAPS: flow.ts adds
 *  `spaceAfter + paragraphSpacing + spaceBefore` between consecutive elements
 *  rather than collapsing. Set `paragraphSpacing: 0`, put the entire gap in
 *  the following element's `spaceBefore`, and zero every `spaceAfter` — and
 *  Flow's additive rule then reproduces the collapsed result exactly, with no
 *  change to Flow. */

import type { BlockBox } from './cssbox.js';
import type { ResolvedBox } from './cssresolve.js';
import { resolveBoxes } from './cssresolve.js';

/** Combine two adjoining margins. The largest positive plus the most
 *  negative — `Math.max` is wrong the moment a negative margin appears. */
export function combineMargins(a: number, b: number): number {
  return Math.max(a, b, 0) + Math.min(a, b, 0);
}

/** Does a box's own top edge let a child's margin through? */
function openTop(r: ResolvedBox): boolean {
  return r.insetTop === 0;
}

/** Does its bottom edge? A stated height gives the box a bottom edge of its
 *  own for the margin to stop at. */
function openBottom(r: ResolvedBox): boolean {
  return r.insetBottom === 0 && r.minHeight === 0;
}

/** Does this box participate in collapsing at all? */
function collapses(r: ResolvedBox): boolean {
  return r.box.float === 'none' && r.box.clear === 'none';
}

/** A box's in-flow block children, resolved against its own content width —
 *  which is exactly what a child's containing block is. */
function childrenOf(r: ResolvedBox): ResolvedBox[] {
  if (r.box.kind === 'table') return [];
  const c = r.box.content;
  if (c.kind !== 'blocks') return [];
  return resolveBoxes(c.children, r.contentWidth);
}

/** Is the box wholly empty — no content, no insets, no height — so that rule
 *  4 collapses its own two margins together? */
function isEmpty(r: ResolvedBox): boolean {
  if (r.insetTop !== 0 || r.insetBottom !== 0 || r.minHeight !== 0) return false;
  if (r.box.kind === 'table') return false;
  const c = (r.box as BlockBox).content;
  if (c.kind === 'inline') return c.runs.length === 0 && c.atomics.length === 0;
  return c.children.length === 0;
}

/** The margins that escape a box's top and bottom edges, after rules 2, 3 and
 *  4 have run over its own subtree. */
export function outerMargins(r: ResolvedBox): { top: number; bottom: number } {
  if (!collapses(r)) return { top: r.marginTop, bottom: r.marginBottom };

  // Rule 4: a wholly empty block's own margins collapse together, and the
  // result escapes both edges as one margin.
  if (isEmpty(r)) {
    const m = combineMargins(r.marginTop, r.marginBottom);
    return { top: m, bottom: m };
  }

  const kids = childrenOf(r);
  let top = r.marginTop;
  let bottom = r.marginBottom;

  // Rule 2: the first in-flow child's top margin joins ours, if our top edge
  // is open.
  const first = kids.find(collapses);
  if (first !== undefined && openTop(r)) {
    top = combineMargins(top, outerMargins(first).top);
  }
  // Rule 3: the last in-flow child's bottom margin joins ours, if our bottom
  // edge is open — which a stated height closes.
  const last = [...kids].reverse().find(collapses);
  if (last !== undefined && openBottom(r)) {
    bottom = combineMargins(bottom, outerMargins(last).bottom);
  }
  return { top, bottom };
}

/** The gap BEFORE each box in a sibling list, after collapsing. The first
 *  entry is always 0: a first child's top margin escapes its parent under
 *  rule 2 and is not a gap between siblings, so counting it here would double
 *  the space above it. */
export function collapseMargins(resolved: ResolvedBox[]): number[] {
  const out: number[] = [];
  let prevBottom: number | null = null;
  for (const r of resolved) {
    const { top, bottom } = outerMargins(r);
    out.push(prevBottom === null ? 0 : combineMargins(prevBottom, top));
    prevBottom = bottom;
  }
  return out;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/cssmargin.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Full suite and typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: both green.

- [ ] **Step 6: Commit**

```bash
git add src/cssmargin.ts test/cssmargin.test.ts
git commit -m "feat(zch2.3): margin collapsing, all four rules

Adjacent siblings; parent and first in-flow child through an open top edge;
parent and last in-flow child through an open bottom edge, which a stated
HEIGHT closes; and a wholly empty block's own two margins.

The combining rule is NOT max. Adjoining margins combine as the largest
positive plus the most negative, so 40px against -10px is 30px — and a
document with no negative margins cannot tell the two readings apart, which
is why the fixture for it uses one.

Floats and cleared boxes do not collapse, and each has its own test: a
float's margin sitting beside a sibling's is exactly the case a
sibling-only implementation gets wrong while looking right.

collapseMargins returns the gap BEFORE each box and always 0 for the first,
whose own top margin escapes its parent under rule 2 — counting it here as
well would double the space above it. That shape is chosen for zch2.4:
flow.ts ADDS spaceAfter + paragraphSpacing + spaceBefore, so putting the
whole gap in spaceBefore with paragraphSpacing 0 reproduces the collapsed
result exactly, with no change to Flow.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---
## Task 6: the Blink oracle

**Files:**
- Create: `scripts/gen-box-goldens.ts`
- Create: `test/helpers/box-goldens.ts`
- Create: `test/fixtures/css-box/goldens.json` (generated)
- Create: `test/fixtures/css-box/PROVENANCE.md`
- Create: `test/cssbox-suite.test.ts`

**Interfaces:**
- Produces (test-only):

```ts
export interface BoxCase { id: string; html: string; rows: BoxRow[] }
export interface BoxRow { path: number[]; width: number; gap: number | null }
export interface BoxGoldens { chrome: string; cases: BoxCase[] }
export function loadBoxGoldens(): BoxGoldens;
```

**What it records, and why exactly these two numbers.** Verified in a browser
before this plan was written:

- `getComputedStyle(el).width` IS the used CONTENT width in px. A block in an
  800px container with `padding: 10px` and `border: 5px` reports **770px**,
  while its `getBoundingClientRect().width` is 800 (the border box). So the
  comparison needs no arithmetic on our side.
- `next.top − prev.bottom` from `getBoundingClientRect()` IS the collapsed
  margin between two siblings. And it is the ONLY way to see one:
  `getComputedStyle(el).marginTop` reports the SPECIFIED margin, never the
  collapsed one — measured, a wrapper whose child's `margin-top: 40px`
  collapses through it still reports `0px`. A corpus built on computed styles
  could not test this rule set at all.

One measurement covers rules 1 and 2 together: that same wrapper produces a
40px gap before ITSELF, because the child's margin escaped it.

- [ ] **Step 1: Write the generator**

Create `scripts/gen-box-goldens.ts`:

```ts
// Generates test/fixtures/css-box/goldens.json — Chrome's used content width
// and collapsed sibling gap for every element of a set of documents.
//
// Not part of `npm test`:
//   npm i --no-save tsx puppeteer
//   npx tsx scripts/gen-box-goldens.ts
//
// Two numbers only, and deliberately: zch2.3 positions nothing, so absolute
// geometry is not ours to compare. See test/fixtures/css-box/PROVENANCE.md.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test', 'fixtures', 'css-box');

/** Every fixture pins `html { width: 800px }` so a percentage is
 *  viewport-independent, and `body { margin: 0 }` so the UA sheet's 8px body
 *  margin does not enter a comparison about author CSS.
 *
 *  Fixtures are STATIC and FLOAT-FREE: a float would drag float PLACEMENT
 *  into a comparison meant to measure widths, and text is kept short enough
 *  not to wrap, since where a line breaks is layoutRuns' answer and not this
 *  issue's. */
const HEAD = '<style>html{width:800px}body{margin:0}</style>';

const CASES: { id: string; html: string }[] = [
  {
    id: 'insets',
    html: '<div style="padding:10px;border:5px solid black">a</div>'
      + '<div style="padding:0 20px">b</div>',
  },
  {
    id: 'stated-and-percentage-width',
    html: '<div style="width:300px">a</div><div style="width:50%">b</div>',
  },
  {
    id: 'auto-margins-centre',
    html: '<div style="width:400px;margin:0 auto">a</div>'
      + '<div style="width:400px;margin-left:auto">b</div>',
  },
  {
    id: 'sibling-collapse',
    html: '<p style="margin:0 0 30px">a</p><p style="margin:20px 0 0">b</p>'
      + '<p style="margin:40px 0">c</p>',
  },
  {
    id: 'collapse-through-parent',
    html: '<p style="margin:0">a</p>'
      + '<div><p style="margin-top:40px">b</p></div>'
      + '<p style="margin:0">c</p>',
  },
  {
    id: 'collapse-blocked-by-padding',
    html: '<p style="margin:0">a</p>'
      + '<div style="padding-top:1px"><p style="margin-top:40px">b</p></div>',
  },
  {
    id: 'collapse-blocked-by-height',
    html: '<div style="height:50px"><p style="margin-bottom:40px">a</p></div>'
      + '<p style="margin:0">b</p>',
  },
  {
    id: 'empty-block-collapse',
    html: '<p style="margin:0">a</p><div style="margin:20px 0 30px"></div>'
      + '<p style="margin:0">b</p>',
  },
  {
    id: 'negative-margin',
    html: '<p style="margin:0 0 40px">a</p><p style="margin:-10px 0 0">b</p>',
  },
  {
    id: 'nested-widths',
    html: '<div style="width:600px;padding:20px">'
      + '<div style="padding:10px">a</div><div style="width:50%">b</div></div>',
  },
];

const browser = await puppeteer.launch();
const chrome = await browser.version();
const cases: unknown[] = [];

for (const c of CASES) {
  const page = await browser.newPage();
  await page.emulateMediaType('print');
  await page.setContent(`<!doctype html>${HEAD}${c.html}`);
  const rows = await page.evaluate(() => {
    // No named inner function: tsx compiles with esbuild's keepNames, which
    // rewrites one into a call to an injected __name helper that does not
    // exist in the page, so the callback throws the moment puppeteer
    // serializes it across.
    const out: { path: number[]; width: number; gap: number | null }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const path: number[] = [];
      let n: Element | null = el;
      while (n !== null && n.parentElement !== null) {
        path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
        n = n.parentElement;
      }
      const prev = el.previousElementSibling;
      const gap = prev === null
        ? null
        : el.getBoundingClientRect().top - prev.getBoundingClientRect().bottom;
      out.push({ path, width: parseFloat(getComputedStyle(el).width), gap });
    }
    return out;
  });
  await page.close();
  cases.push({ id: c.id, html: `<!doctype html>${HEAD}${c.html}`, rows });
}

await browser.close();

mkdirSync(outDir, { recursive: true });
const json = `${JSON.stringify({ chrome, cases }, null, 1)}\n`;
const file = join(outDir, 'goldens.json');
writeFileSync(file, json);

const rows = cases.reduce((n: number, c) => n + (c as { rows: unknown[] }).rows.length, 0);
console.log(`chrome:  ${chrome}`);
console.log(`cases:   ${cases.length}`);
console.log(`rows:    ${rows}`);
console.log(`bytes:   ${Buffer.byteLength(json)}`);
console.log(`sha256:  ${createHash('sha256').update(json).digest('hex')}`);
```

- [ ] **Step 2: Generate the goldens**

Run:

```bash
npm i --no-save tsx puppeteer
npx tsx scripts/gen-box-goldens.ts
```

Expected: it prints the Chrome version, the counts and the SHA-256, and writes
`test/fixtures/css-box/goldens.json`. **Record the printed values** — they go
verbatim into `PROVENANCE.md` in Step 6.

If puppeteer cannot download a browser here, STOP and report it rather than
hand-writing goldens. A hand-written "oracle" is our own answer wearing a
costume, which is worse than no oracle because it looks like evidence.

- [ ] **Step 3: Write the loader**

Create `test/helpers/box-goldens.ts`:

```ts
/** Loader for the Blink-generated box corpus.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  test/helpers/selector-goldens.ts and test/helpers/cascade-goldens.ts
 *  already set. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlElement } from '../../src/htmldom.js';

const FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-box', 'goldens.json',
);

export interface BoxRow { path: number[]; width: number; gap: number | null }
export interface BoxCase { id: string; html: string; rows: BoxRow[] }
export interface BoxGoldens { chrome: string; cases: BoxCase[] }

export function loadBoxGoldens(): BoxGoldens {
  return JSON.parse(readFileSync(FILE, 'utf8')) as BoxGoldens;
}

/** The child-index path from the document element, element children only —
 *  the same walk the generator makes with `parentElement.children`. */
export function pathOf(el: HtmlElement): number[] {
  const out: number[] = [];
  let n: HtmlElement = el;
  for (;;) {
    const p = n.parent;
    if (p === null || p.kind !== 'element') return out;
    const sibs = p.children.filter((c): c is HtmlElement => c.kind === 'element');
    out.unshift(sibs.indexOf(n));
    n = p;
  }
}
```

- [ ] **Step 4: Write the suite test**

Create `test/cssbox-suite.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import { resolveBoxes } from '../src/cssresolve.js';
import { collapseMargins } from '../src/cssmargin.js';
import { loadBoxGoldens, pathOf } from './helpers/box-goldens.js';
import type { BlockBox, BoxNode } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;
const G = loadBoxGoldens();
const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5;

/** Walk our box tree, resolving each level against its parent's content
 *  width, and report `path -> { width, gap }` exactly as the generator does. */
function ourRows(html: string): Map<string, { width: number; gap: number }> {
  const out = new Map<string, { width: number; gap: number }>();
  const { boxes } = buildBoxes(parseHtml(html), resolver);

  const walk = (children: BoxNode[], containingWidth: number): void => {
    const resolved = resolveBoxes(children, containingWidth);
    const gaps = collapseMargins(resolved);
    resolved.forEach((r, i) => {
      if (r.box.el !== null) {
        out.set(pathOf(r.box.el).join('.'), {
          width: r.contentWidth, gap: gaps[i] as number,
        });
      }
      if (r.box.kind !== 'table' && r.box.content.kind === 'blocks') {
        walk(r.box.content.children, r.contentWidth);
      }
    });
  };

  // The document element's containing block is the initial one, which every
  // fixture pins at 800px.
  walk(boxes, 800);
  return out;
}

describe('the Blink box corpus', () => {
  it('loads a non-trivial corpus', () => {
    expect(G.chrome).toMatch(/Chrome/);
    expect(G.cases.length).toBeGreaterThanOrEqual(10);
  });

  it('agrees with Blink on every used content width', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const ours = ourRows(c.html);
      for (const row of c.rows) {
        const key = row.path.join('.');
        const mine = ours.get(key);
        if (mine === undefined) continue;      // an element we generate no box for
        if (!near(mine.width, row.width)) {
          failures.push(`${c.id} [${key}] width: ${mine.width} != ${row.width}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('agrees with Blink on every collapsed sibling gap', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const ours = ourRows(c.html);
      for (const row of c.rows) {
        if (row.gap === null) continue;        // first child: no gap to compare
        const key = row.path.join('.');
        const mine = ours.get(key);
        if (mine === undefined) continue;
        if (!near(mine.gap, row.gap)) {
          failures.push(`${c.id} [${key}] gap: ${mine.gap} != ${row.gap}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the harness itself', () => {
  // A comparison that silently skips everything would leave the corpus green
  // whatever the code does, so the number of rows actually compared is
  // asserted rather than assumed.
  it('compares a substantial number of rows, rather than skipping them', () => {
    let compared = 0;
    for (const c of G.cases) {
      const ours = ourRows(c.html);
      for (const row of c.rows) if (ours.has(row.path.join('.'))) compared++;
    }
    expect(compared).toBeGreaterThan(30);
  });

  it('fails when a golden value is wrong', () => {
    const c = G.cases[0]!;
    const ours = ourRows(c.html);
    const row = c.rows.find((r) => ours.has(r.path.join('.')))!;
    const mine = ours.get(row.path.join('.'))!;
    // Far from the real value: `near` allows 0.5px, so a small tamper would
    // pass and prove nothing.
    expect(near(mine.width, row.width + 100)).toBe(false);
  });
});
```

- [ ] **Step 5: Run the suite**

Run: `npx vitest run test/cssbox-suite.test.ts`
Expected: PASS.

If a comparison fails it is **real** — fix `src/`, never the goldens. The one
legitimate reason to change a fixture is a construct this issue's scope
deliberately excludes; remove it, regenerate, and record the reason in
`PROVENANCE.md` rather than deleting it silently.

- [ ] **Step 6: Write `PROVENANCE.md`**

Create `test/fixtures/css-box/PROVENANCE.md`, filling every bracketed value
from what Step 2 printed:

```markdown
# css-box — provenance

Chrome's used content width and collapsed sibling gap for every element of a
set of documents, here to validate `src/cssresolve.ts` and `src/cssmargin.ts`
against expectations this repo did not author. See
`docs/superpowers/specs/2026-08-28-css-box-model-design.md`.

**GENERATED, not vendored**, the way `test/fixtures/svg/`,
`test/fixtures/css-selectors/` and `test/fixtures/css-cascade/` are.

**Producer:** [chrome version printed by the generator], via puppeteer.
**Command:**

    npm i --no-save tsx puppeteer
    npx tsx scripts/gen-box-goldens.ts

| File | Bytes | Cases | Rows | SHA-256 |
|---|---|---|---|---|
| `goldens.json` | [bytes] | [cases] | [rows] | `[sha256]` |

## The two numbers, and why exactly these

- **`getComputedStyle(el).width` IS the used CONTENT width** in px. Measured:
  a block in an 800px container with `padding: 10px` and `border: 5px` reports
  770px, while its `getBoundingClientRect().width` is 800 — the border box. So
  the comparison needs no arithmetic on our side and cannot drift.
- **`next.top − prev.bottom` IS the collapsed margin** between two siblings.

**The gap is the ONLY way to observe collapsing at all.**
`getComputedStyle(el).marginTop` reports the SPECIFIED margin, never the
collapsed one — measured, a wrapper whose first child has `margin-top: 40px`
collapsing through it still reports `0px`. A corpus built on computed styles,
as `test/fixtures/css-cascade/` is, could not test this rule set. That is the
whole argument for measuring geometry here.

**One measurement covers rules 1 and 2 together**, which was not obvious until
it was run: that same wrapper produces a 40px gap before ITSELF, because the
child's margin escaped it, and `wrap.top === child.top`.

Every fixture pins `html { width: 800px }` so percentages are
viewport-independent, and `body { margin: 0 }` so the UA sheet's 8px body
margin does not enter a comparison about author CSS.

## The ceiling — do not read the corpus past it

1. **One engine, no second to arbitrate** — as for `zch2.2.2` and `zch2.2.3`.
2. **ABSOLUTE POSITIONS ARE OUTSIDE THE CORPUS, because we produce none.**
   `zch2.3` computes no x and no y by design; widths and inter-sibling gaps
   are the whole comparison. A reader expecting a "box model" corpus to have
   checked where anything is will be wrong.
3. **Floats are outside it.** A float in a fixture would drag float PLACEMENT
   into a comparison meant to measure widths. Shrink-to-fit is hand-tested
   only, in `test/cssresolve.test.ts`, against an injected measurer.
4. **Line breaking is outside it.** Where a line breaks is `layoutRuns`'
   answer and is pinned by that module's tests; fixture text is kept short
   enough not to wrap, so a difference there cannot reach these numbers.
5. **Inline geometry is outside it** — `inline-block`, `vertical-align` and
   inline padding are out of `zch2.3`'s scope entirely.
6. **An element we generate no box for is skipped, not failed.** `<head>` and
   its children are `display: none` under our UA sheet and Chrome's alike, so
   they appear in the goldens with no counterpart here. The suite asserts the
   NUMBER of rows actually compared, so a skip that swallowed everything
   would be a red build rather than a green one.

## Regenerating

Only when the fixture set grows. Re-run the command above and update the
table. If a comparison then fails it is REAL — fix `src/`, never the goldens.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/gen-box-goldens.ts test/helpers/box-goldens.ts \
        test/fixtures/css-box test/cssbox-suite.test.ts
git commit -m "test(zch2.3): a Blink-generated box corpus

Two numbers per element, and deliberately only two: the used content width
from getComputedStyle(el).width, and the collapsed gap to the previous
sibling from getBoundingClientRect. zch2.3 positions nothing, so absolute
geometry is not ours to compare.

Both were verified in a browser before the design was written.
getComputedStyle().width IS the used CONTENT width — 770px for a block in
an 800px container with 10px padding and 5px borders, whose
getBoundingClientRect().width is 800 — so the comparison needs no
arithmetic on our side.

And the sibling gap is the ONLY way to observe collapsing at all: Chrome
reports the SPECIFIED margin through the CSSOM, never the collapsed one, so
a corpus built on computed styles — which is exactly what
test/fixtures/css-cascade/ is — could not test this rule set. One
measurement also covers rules 1 and 2 together, a child's margin collapsing
through its parent showing up as the parent's own gap.

PROVENANCE.md records the ceiling, and leads with the part a reader will
get wrong: absolute positions are outside the corpus because we produce
none.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Mutations, documentation, and close

**Files:**
- Modify: `CLAUDE.md`
- Modify: `src/*.ts` (comments only, if a mutation finds an unpinned rule)

- [ ] **Step 1: Run the eleven mutations**

For each row: make the edit, run
`npx vitest run test/preformat.test.ts test/cssinline.test.ts test/cssbox.test.ts test/cssresolve.test.ts test/cssmargin.test.ts test/cssbox-suite.test.ts`,
record which files went red, then **revert the edit**. A mutation that reddens
NOTHING is recorded in `CLAUDE.md` as an uncovered rule — never quietly
dropped.

| # | Mutation | Expected to redden |
|---|---|---|
| 1 | In `outerMargins`, return early so only rule 1 applies | the collapse-through-parent cases, and the corpus |
| 2 | In `openBottom`, drop the `minHeight === 0` condition | the blocked-by-height case, and the corpus |
| 3 | In `combineMargins`, `return Math.max(a, b)` | the negative-margin cases, and every all-positive case stays green |
| 4 | In `resolveOne`, split the both-auto case as `rest` / `0` | the centring case, and the corpus |
| 5 | In `collapses`, ignore `float` | the float case |
| 6 | In `px`, resolve a percentage against a hard-coded height | the percentage-margin case |
| 7 | In `resolveOne`, return `minHeight` as the box's exact height | *(see step 2 — this is `zch2.4`'s line)* |
| 8 | In `boxFor`, descend into a table box | the opaque-table case |
| 9 | In `flush`, emit an anonymous box for whitespace-only runs | the indented-document case |
| 10 | In `boxFor`, give an anonymous box `INITIAL_STYLE` | the parent-style case |
| 11 | In `boxFor`, emit a box for `display: none` | the hidden-subtree case |

Two extra, for the traps this plan found while measuring:

| # | Mutation | Expected to redden |
|---|---|---|
| 12 | In `keyOf`, drop `r.link` | the two-adjacent-links case |
| 13 | In `processText`, use `preformat` for `normal` too | the collapsing cases |

- [ ] **Step 2: Record the results**

Write the outcome into the Step 4 commit message.

**Mutation 7 is expected to redden NOTHING, and that is not a gap in this
issue.** `minHeight` is reported here and CONSUMED by `zch2.4`, which decides
whether a box may exceed it; nothing in `zch2.3` can tell the two readings
apart. Record it in the `CLAUDE.md` entry as held by that issue rather than by
this suite, and note it in `zch2.4`'s issue so its plan carries the test.

If any OTHER mutation reddens nothing, add a
`**Note, measured, and it covers NOTHING:**` paragraph to the relevant
`CLAUDE.md` entry naming the rule.

- [ ] **Step 3: Add the `CLAUDE.md` entries**

Insert into the Source list in `CLAUDE.md`, immediately after the
`**cssvalue.ts**, **cssprop.ts**, …` cascade entry:

```markdown
- **preformat.ts** — `preformat` and `expandTabs`, the rule that lets
  indentation survive being drawn. A leaf importing NOTHING, extracted from
  `flowblock.ts` so `cssinline.ts` can reach it: `flowblock.ts` imports
  `pagecontent.js` and `serialize.js`, so a pure CSS leaf cannot. `flowblock.ts`
  re-exports it, keeping `mdflow.ts`'s import path unchanged.
  **Invariant:** the substitution is U+00A0 and it exists because `layoutRuns`
  COLLAPSES runs of spaces, which is fatal to indentation. A SINGLE interior
  space is left alone — it is an ordinary word separator and must stay
  breakable, or a long preformatted line could never wrap at all.
- **cssinline.ts**, **cssbox.ts**, **cssresolve.ts**, **cssmargin.ts** — the
  box model (`zch2.3`): the styled tree to a box tree, and the arithmetic to
  resolve one against a containing-block width. All four are pure leaves and
  none throws. Nothing is exported from `index.ts` — `zch2.4` is the next
  consumer.
  **Invariant, and it is the decision the whole issue turns on: IT POSITIONS
  NOTHING.** No x, no y, no line break, no page break. `zch2.4` maps each box
  to a `FlowElement` and `flow.ts` stacks and paginates exactly as it does for
  Markdown — which is what makes that issue's "mirror mdflow.ts, hand back a
  flat array" possible, and what keeps the existing pagination, keep-with-next
  and column budget working unchanged. A full layout engine was considered and
  rejected: it would duplicate both.
  **Invariant:** `resolveBoxes` takes a WIDTH as an argument rather than
  baking one in, and that is forced rather than preferred. A percentage margin
  resolves against the containing block's WIDTH — vertical margins included,
  which is the part that surprises — so nothing can be precomputed. `flow.ts`
  supplies it at `place()` time.
  **Invariant, the rule `cssbox.ts` exists for:** a block container holds
  EITHER only block-level children OR exactly one inline formatting context,
  and a mixed container's inline runs are wrapped in ANONYMOUS block boxes.
  An anonymous box carries its PARENT's computed style and no element — a
  fresh initial style would reset the font and colour of every mixed container
  in a document. A whitespace-only text node between two blocks makes NO
  anonymous box, or every prettily-indented document gains an empty line per
  nesting level.
  **Invariant:** `display: none` generates NO BOX, rather than one flagged
  invisible. A hidden subtree must not reach `zch2.4`, must not consume a
  margin, and must not take part in collapsing.
  **Invariant:** a table-display box is emitted OPAQUE and not descended into.
  CSS 2.1 §17.2.1's anonymous-table fixup belongs with `zch2.6`, the issue
  that knows what a table becomes and builds it through `flowtable.ts`.
  **Invariant:** `cssinline.ts` adds NO wrapping engine. An IFC lowers to the
  `TextRun[]` model `textdecor.ts` defines and `layoutRuns` wraps it — the
  one-wrapping-engine rule, which also buys justification, per-line leading
  and `runlink.ts`'s link-rect geometry. A run's merge key folds in the LINK
  DESTINATION, because two adjacent links style identically and merging would
  point the whole phrase at the second URI; `mdruns.ts` records the same rule.
  **Invariant:** `resolveFamily` and `measure` are both INJECTED, the seam
  `grayimage.ts` uses for `resolve`/`inflate`. `fontFamily` is a list of NAMES
  and `TextRun.font` is an `AuthoringFont`, and bridging them needs
  `Document.LoadFontByName`; shrink-to-fit needs `layoutRuns`. Either import
  would put a font stack inside a pure leaf.
  **Invariant:** margin collapsing combines the largest POSITIVE plus the most
  NEGATIVE, NOT `Math.max`. 40px against −10px is 30px, and a document with no
  negative margins cannot tell the two readings apart.
  **Invariant:** `collapseMargins` returns the gap BEFORE each box and always
  0 for the first, whose own top margin escapes its parent under rule 2 —
  counting it here as well would double the space above it. That shape is
  chosen for `zch2.4`: `flow.ts` ADDS `spaceAfter + paragraphSpacing +
  spaceBefore`, so putting the whole gap in `spaceBefore` with
  `paragraphSpacing: 0` reproduces the collapsed result exactly, with no
  change to Flow.
  **Note, measured, and it covers NOTHING here:** treating `height` as an
  exact height rather than a MINIMUM reddens nothing in this suite.
  `minHeight` is reported here and consumed by `zch2.4`, which decides whether
  a box may exceed it, so no test in `zch2.3` can tell the two readings apart.
  Held by that issue, and named in it.
  **Note on the oracle, GENERATED rather than vendored:**
  `scripts/gen-box-goldens.ts` drives headless Chrome and records exactly two
  numbers per element — the used content width, and the collapsed gap to the
  previous sibling. `getComputedStyle(el).width` IS the used CONTENT width
  (measured: 770px for a block in an 800px container with 10px padding and 5px
  borders, whose `getBoundingClientRect().width` is 800), and the sibling gap
  is the ONLY way to observe collapsing at all — Chrome reports the SPECIFIED
  margin through the CSSOM and never the collapsed one, so
  `zch2.2.3`'s computed-style corpus could not have tested this rule set.
  **Note on the ceiling, and it is the part a reader will get wrong:**
  ABSOLUTE POSITIONS ARE OUTSIDE THE CORPUS, because we produce none. So are
  floats, line breaking and inline geometry.
  `test/fixtures/css-box/PROVENANCE.md` says so at the top.
```

- [ ] **Step 4: Verify the `CLAUDE.md` sweep passes**

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

Expected: `preformat.ts`, `cssinline.ts`, `cssbox.ts`, `cssresolve.ts` and
`cssmargin.ts` all ABSENT from the output.

- [ ] **Step 5: Both gates**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck silent; full suite green.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md src/
git commit -m "docs(zch2.3): CLAUDE.md entries for the box model, and mutation results

Thirteen mutations run; [N] reddened something. [Name any that reddened
nothing beyond mutation 7, and note them in the entry.]

Mutation 7 — treating height as exact rather than a minimum — reddens
nothing HERE by construction, and that is recorded rather than treated as a
gap: minHeight is reported by zch2.3 and consumed by zch2.4, which decides
whether a box may exceed it, so no test in this issue can tell the two
readings apart. zch2.4's issue carries the test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Note the deferred test on `zch2.4`**

```bash
bd update aspose-pdf-foss-for-ts-zch2.4 --notes "From zch2.3: two rules land HERE and cannot be tested there.

(1) height-as-a-minimum. zch2.3's ResolvedBox.minHeight is a floor; the decision that a box may EXCEED it is zch2.4's, so mutation 7 in zch2.3's plan reddens nothing in that issue. This plan must carry a test that content taller than a stated height makes the box taller rather than clipping.

(2) The collapsed gap goes in spaceBefore. cssmargin.collapseMargins returns the gap BEFORE each box; flow.ts ADDS spaceAfter + paragraphSpacing + spaceBefore, so zch2.4 must set paragraphSpacing 0, put the whole gap in spaceBefore, and zero every spaceAfter. Putting it in spaceAfter instead reproduces the same total for a uniform list and diverges the moment a gap differs, so the fixture needs two DIFFERENT gaps in one list."
```

- [ ] **Step 8: Close the issue**

```bash
bd close aspose-pdf-foss-for-ts-zch2.3 --reason "Shipped. Four pure leaves — cssinline.ts, cssbox.ts, cssresolve.ts, cssmargin.ts — plus preformat.ts extracted from flowblock.ts so a pure CSS leaf could reach the U+00A0 rule.

The decision the issue turns on: it POSITIONS NOTHING. Box generation, the two formatting contexts, CSS 2.1 §10.3.3 used widths, insets, float/clear classification, shrink-to-fit, height-as-a-minimum, and all four margin-collapsing rules — with no x, no y, no line break and no page break. zch2.4 maps boxes to FlowElements and flow.ts stacks and paginates unchanged.

Anchored by [rows] Blink comparisons across [cases] documents: the used content width, and the collapsed sibling gap. The gap is the only way to observe collapsing at all — Chrome reports the SPECIFIED margin through the CSSOM, never the collapsed one — which is why zch2.2.3's computed-style approach could not be reused. PROVENANCE.md leads with the ceiling a reader will get wrong: absolute positions are outside the corpus because we produce none.

[N] of 13 mutations reddened something. Mutation 7 (height exact rather than minimum) reddens nothing by construction — minHeight is consumed by zch2.4 — and is noted on that issue rather than recorded as a gap here.

Unblocks zch2.4."
```

- [ ] **Step 9: Push**

```bash
npm prune
bd export -o .beads/issues.jsonl
git add .beads/
git commit -m "chore(beads): close zch2.3

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git pull --rebase
git push
git status   # MUST show "up to date with origin"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-08-28-css-box-model-design.md` maps to a task.
"It positions nothing" → the Global Constraints and Task 3's header. Scope and
the deferrals → Task 3 (tables opaque, `display: none`) and Task 2 (the
recorded inline limitations). The box model and the anonymous-box rules →
Task 3. Modules → the File Structure, plus Task 1, which the spec implies by
requiring `preformat` in a pure leaf and which is called out explicitly here.
Used widths → Task 4. Margin collapsing → Task 5. `height` as a minimum →
Task 4, with its untestability recorded in Task 7. The oracle and its ceiling
→ Task 6. What it hands `zch2.4` → the Interfaces blocks of Tasks 4 and 5,
and Task 7 Step 7. The spec's eleven mutations → Task 7, plus two more for
traps found while writing.

**One place the plan adds to the spec, noted rather than smuggled.** The spec
names four modules; the plan has five, because `preformat` has to leave
`flowblock.ts` before `cssinline.ts` can use it — `flowblock.ts` imports
`pagecontent.js` and `serialize.js`. The spec's own "one owner for a shared
rule" reasoning forces the extraction; only the module count differs.

**Placeholder scan.** The only bracketed values are in Task 6 Step 6 and
Task 7 Steps 6 and 8, and each is a number the preceding step *prints*, with
the command that produces it named. No `TBD`, no "handle edge cases", no
"similar to Task N" — the `FAMILY`/`resolver` stub and the `find` helper are
repeated in full in each test file that uses them, because the files are
written in different tasks and may be read out of order.

**Type consistency.** `FamilyResolver`, `AtomicInline`, `InlineContent` and
`inlineContentOf` are introduced in Task 2 and used unchanged in Tasks 3 and
6. `BoxNode`, `BlockBox`, `TableBox` and `buildBoxes` come from Task 3 and are
consumed by Tasks 4, 5 and 6. `ResolvedBox`, `MeasureFn` and `resolveBoxes`
come from Task 4 and are consumed by Tasks 5 and 6; `cssmargin.ts` imports
`resolveBoxes` as a value, which is a straight line and closes no cycle.
`collapseMargins`, `combineMargins` and `outerMargins` come from Task 5.
`preformat`, `expandTabs` and `NBSP` come from Task 1. `pathOf` appears in the
generator (over the browser's `Element`) and in the loader (over
`HtmlElement`) as two deliberately separate functions, as `zch2.2.2`
established.

**One risk the executor should know about.** Task 6 Step 2 depends on
puppeteer downloading a browser. If it cannot, stop and report — Tasks 1–5 and
their hand-built suites stand on their own, and `zch2.4` is unblocked by them.
