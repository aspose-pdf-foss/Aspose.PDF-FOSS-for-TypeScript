# HTML5 Foreign Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse SVG and MathML subtrees into their own namespaces, turning on 207 more vendored WPT cases and taking the in-scope corpus from 1,317 to 1,524.

**Architecture:** One new pure leaf, `src/htmlforeign.ts`, holding the four adjustment tables, the two integration-point predicates and the breakout list — everything assertable from a table entry with no parser in the picture. `src/htmldom.ts` gains a namespace on an element, `src/htmlstack.ts`'s scope terminators become namespace-aware, and `src/htmltree.ts` gains the §13.2.6 dispatcher branch plus the foreign token rules. `src/htmltoken.ts` gains one callback so `<![CDATA[` can route on tree state.

**Tech Stack:** TypeScript (ESM, NodeNext, `strict`), vitest. No new runtime dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-27-html5-foreign-content-design.md`](../specs/2026-08-27-html5-foreign-content-design.md)

**Issue:** `zch2.1.3.1`, under `zch2.1.3`, under `zch2.1`, under epic `zch2`.

## Global Constraints

- **Zero runtime dependencies.** Only `node:` built-ins, and this feature needs none.
- **ESM + NodeNext.** Every import specifier carries `.js`: `import { SVG_TAG_NAMES } from './htmlforeign.js'`.
- **Nothing throws.** No `throw` in `src/htmldom.ts`, `src/htmlstack.ts`, `src/htmlforeign.ts` or `src/htmltree.ts`. Every string is a valid HTML document.
- **Purity.** None of the four may import `document.js`, `page.js`, or any PDF object module. `htmlforeign.ts` imports `htmldom.js` for TYPES ONLY and nothing else; it must not import `htmlstack.ts` or `htmltree.ts`.
- **Nothing is exported from `src/index.ts`.** `parseHtml` ships with `zch2.1.3.3`.
- **Spec names, verbatim.** `adjustedCurrentNode`, `isMathmlTextIntegrationPoint`, `isHtmlIntegrationPoint` — named as §13.2.6 names them.
- **THE STANDING FENCE: all 1,317 cases green today must stay green.** Every task runs `npx vitest run test/wpt-tree.test.ts` and expects 1,317 passing until Task 5, which raises it to 1,524. A red case there is information, not a chore.
- **Never edit a vendored expectation, and never move a case between buckets to make it green.** If a rule genuinely cannot be satisfied, stop and report it.
- **Run before closing any task:** `npm run typecheck` and `npm test`, both green. The full suite takes ~100s, so run them as separate commands or the 2-minute default timeout kills them.
- **Writing files:** this Windows/Git Bash setup eats backslashes in heredocs *and* in `node -e` one-liners, even with a quoted delimiter. Use the Write/Edit tools for any file containing escapes. If a shell command must emit a backslash, build it with `String.fromCharCode(92)`. Symptom to watch for: `grep` reporting a source file as `Binary file … matches`.
- **CHANGELOG.md** gets an `## [Unreleased]` entry only in the final task.

## File Structure

| File | Responsibility |
|---|---|
| `src/htmlforeign.ts` | **Create.** The four adjustment tables, the two integration-point predicates, the breakout list. Pure data and predicates; no stack, no insertion. |
| `src/htmldom.ts` | **Modify.** `HtmlNamespace`, `HtmlElement.ns`, `createElement`'s third parameter. |
| `src/htmlstack.ts` | **Modify.** Scope terminators keyed on `(ns, name)`. |
| `src/htmltoken.ts` | **Modify.** Constructor options; the `<![CDATA[` routing test. |
| `src/htmltree.ts` | **Modify.** Dispatcher branch, foreign token rules, `math`/`svg` start tags, namespace-aware `special`. |
| `test/helpers/wpt-tree.ts` | **Modify.** Serializer namespace prefix; the bucket predicate. |
| `test/htmlforeign.test.ts` | **Create.** Tables and predicates, from element literals. |
| `test/htmldom.test.ts` | **Modify.** Namespace on a node. |
| `test/htmlstack.test.ts` | **Modify.** Namespace-aware scope. |
| `test/htmltoken.test.ts` | **Modify.** The CDATA seam. |
| `test/htmltree.test.ts` | **Modify.** Hand-built foreign cases, copied from the corpus. |
| `test/wpt-tree-suite.test.ts` | **Modify.** Bucket counts. |
| `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md` | **Modify.** Final task. |

---

## A note on the tables

The five tables are written out in full in Task 2, Step 3, transcribed from
`html.spec.whatwg.org/multipage/parsing.html` on 2026-08-27. Copy them from
there literally. Do **not** retype one from memory and do **not** "complete"
one that looks truncated: a single wrong pair is a silently mis-cased element
that still renders, and the sizes are asserted (37, 58, 1, 11, 44) precisely
so that a half-transcribed table is a red build instead.

---

## Task 1: Namespaces in the node model and the serializer

Lands the interface change first, with nothing using it, so the fence is
unambiguous: every one of the 1,317 green cases must still be green with
`ns` present and defaulted.

**Files:**
- Modify: `src/htmldom.ts`
- Modify: `test/helpers/wpt-tree.ts` (`serializeTree` only)
- Test: `test/htmldom.test.ts`, `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type HtmlNamespace = 'html' | 'svg' | 'math';
  export interface HtmlElement {
    kind: 'element';
    ns: HtmlNamespace;
    name: string;
    attrs: Map<string, string>;
    children: HtmlNode[];
    parent: HtmlNode | null;
  }
  export function createElement(
    name: string, attrs?: Map<string, string>, ns?: HtmlNamespace,
  ): HtmlElement;   // ns defaults to 'html'
  ```

- [ ] **Step 1: Write the failing tests**

Append to `test/htmldom.test.ts`:

```ts
describe('element namespaces', () => {
  // The default is the fence: every call site written before zch2.1.3.1
  // keeps meaning exactly what it meant, which is what makes "the 1,317
  // green cases stay byte-identical" something the suite checks.
  it('defaults an element to the HTML namespace', () => {
    expect(createElement('div').ns).toBe('html');
    expect(createElement('div', new Map([['a', '1']])).ns).toBe('html');
  });

  it('takes a namespace as its third argument', () => {
    expect(createElement('svg', undefined, 'svg').ns).toBe('svg');
    expect(createElement('mi', new Map(), 'math').ns).toBe('math');
  });
});
```

Append to `test/wpt-tree-suite.test.ts`, inside the existing
`describe('the html5lib tree serializer', ...)`:

```ts
  // html5lib writes a foreign element as `<ns name>` and an HTML one bare.
  // Note SVG's own root serializes `<svg svg>` — the prefix is the namespace,
  // not the tag, so it repeats. That reads like a bug and is the format.
  it('prefixes a foreign element with its namespace', () => {
    const doc = createDocument();
    const svg = createElement('svg', undefined, 'svg');
    const g = createElement('g', undefined, 'svg');
    const mi = createElement('mi', undefined, 'math');
    appendChild(doc, svg);
    appendChild(svg, g);
    appendChild(doc, mi);
    expect(serializeTree(doc)).toBe('| <svg svg>\n|   <svg g>\n| <math mi>');
  });

  it('leaves an HTML element unprefixed', () => {
    const doc = createDocument();
    appendChild(doc, createElement('div'));
    expect(serializeTree(doc)).toBe('| <div>');
  });

  // Adjusted foreign attributes are stored under their DISPLAY key, so the
  // serializer needs no namespace logic for attributes and its existing sort
  // already produces the corpus's order.
  it('writes a namespaced attribute from its key, sorted with the rest', () => {
    const doc = createDocument();
    const g = createElement('g', new Map([['xml lang', 'en'], ['xlink href', 'foo']]), 'svg');
    appendChild(doc, g);
    expect(serializeTree(doc)).toBe('| <svg g>\n|   xlink href="foo"\n|   xml lang="en"');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/htmldom.test.ts test/wpt-tree-suite.test.ts`
Expected: FAIL — `createElement` takes two arguments, `ns` is not a property.

- [ ] **Step 3: Add the namespace to the node model**

In `src/htmldom.ts`, add above `HtmlElement`:

```ts
/** The three namespaces tree construction can produce. A three-value union
 *  rather than a namespace URI: every comparison in the parser is against one
 *  of three constants, and the html5lib serializer wants the short spelling
 *  anyway, so a URI would be a long string compare everywhere plus a map back
 *  to `svg`/`math` at the end. */
export type HtmlNamespace = 'html' | 'svg' | 'math';
```

Add `ns: HtmlNamespace;` to `HtmlElement` immediately after `kind`, and change
`createElement`:

```ts
export function createElement(
  name: string,
  attrs?: Map<string, string>,
  ns: HtmlNamespace = 'html',
): HtmlElement {
  return {
    kind: 'element',
    ns,
    name,
    attrs: attrs ?? new Map<string, string>(),
    children: [],
    parent: null,
  };
}
```

- [ ] **Step 4: Teach the serializer the prefix**

In `test/helpers/wpt-tree.ts`, in `serializeTree`'s `case 'element'`, replace
the element line with:

```ts
        case 'element': {
          const prefix = n.ns === 'html' ? '' : `${n.ns} `;
          lines.push(`${pad}<${prefix}${n.name}>`);
```

Leave the attribute loop exactly as it is — adjusted attributes arrive under
their display key, so its existing sort is already right.

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run test/htmldom.test.ts test/wpt-tree-suite.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the standing fence**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: PASS, **1,317** — unchanged. If this is red, the default on
`createElement` is wrong and nothing later in this plan will make sense.

- [ ] **Step 7: Prove the default load-bearing**

Change `ns: HtmlNamespace = 'html'` to `ns: HtmlNamespace = 'svg'` and run
`npx vitest run test/wpt-tree.test.ts`.
Expected: FAIL, on essentially every case. Revert.

- [ ] **Step 8: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmldom.ts test/helpers/wpt-tree.ts test/htmldom.test.ts test/wpt-tree-suite.test.ts
git commit -m "feat(zch2.1.3.1): element namespaces in the node model

A three-value union rather than a namespace URI: every comparison in the
parser is against one of three constants and the html5lib serializer wants
the short spelling anyway.

createElement's ns defaults to 'html', which is the fence rather than a
convenience — every call site written before this is unchanged, so the 1,317
green WPT cases staying green is evidence the change is inert. Measured:
defaulting to 'svg' instead reddens essentially all of them.

Attributes stay Map<string, string>. Adjusted foreign attributes will be
stored under their DISPLAY key ('xlink href'), which is sound rather than
merely convenient: whitespace terminates an attribute name in the tokenizer,
so no document can produce a literal key that collides. The serializer's
existing sort then already produces the corpus's order."
```

---

## Task 2: `src/htmlforeign.ts` — the tables and the predicates

Everything that can be asserted from a table entry with no parser in the
picture, the split `htmlcharref.ts` already makes against `htmltoken.ts`.

**Files:**
- Create: `src/htmlforeign.ts`
- Test: `test/htmlforeign.test.ts`

**Interfaces:**
- Consumes: `HtmlElement`, `HtmlNamespace` (Task 1).
- Produces:
  ```ts
  export const SVG_TAG_NAMES: ReadonlyMap<string, string>;
  export const SVG_ATTRS: ReadonlyMap<string, string>;
  export const MATHML_ATTRS: ReadonlyMap<string, string>;
  export const FOREIGN_ATTRS: ReadonlyMap<string, string>;
  export const FOREIGN_BREAKOUT: ReadonlySet<string>;
  export function adjustSvgTagName(name: string): string;
  export function adjustAttributes(
    attrs: Map<string, string>, table: ReadonlyMap<string, string>,
  ): Map<string, string>;
  export function isMathmlTextIntegrationPoint(el: HtmlElement): boolean;
  export function isHtmlIntegrationPoint(el: HtmlElement): boolean;
  ```

`adjustAttributes` returns a NEW map and is called once per table, so a token
in SVG is run through `SVG_ATTRS` then `FOREIGN_ATTRS`.

- [ ] **Step 1: Write the failing test**

Create `test/htmlforeign.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SVG_TAG_NAMES, SVG_ATTRS, MATHML_ATTRS, FOREIGN_ATTRS, FOREIGN_BREAKOUT,
  adjustSvgTagName, adjustAttributes,
  isMathmlTextIntegrationPoint, isHtmlIntegrationPoint,
} from '../src/htmlforeign.js';
import { createElement } from '../src/htmldom.js';

describe('the foreign-content adjustment tables', () => {
  // Sizes asserted so a half-transcribed table is a red build rather than a
  // silently mis-cased element that still renders. Read from the HTML
  // Standard on 2026-08-27.
  it('has the sizes the spec has', () => {
    expect(SVG_TAG_NAMES.size).toBe(37);
    expect(SVG_ATTRS.size).toBe(58);
    expect(MATHML_ATTRS.size).toBe(1);
    expect(FOREIGN_ATTRS.size).toBe(11);
    expect(FOREIGN_BREAKOUT.size).toBe(44);
  });

  // Every key is the all-lowercase spelling the tokenizer produces, and every
  // value differs from it except where the spec's own value is lowercase.
  it('keys every table on the lowercase spelling the tokenizer emits', () => {
    for (const table of [SVG_TAG_NAMES, SVG_ATTRS, MATHML_ATTRS]) {
      for (const key of table.keys()) expect(key).toBe(key.toLowerCase());
    }
  });

  it('fixes SVG tag case, and leaves an unlisted name alone', () => {
    expect(adjustSvgTagName('foreignobject')).toBe('foreignObject');
    expect(adjustSvgTagName('fegaussianblur')).toBe('feGaussianBlur');
    expect(adjustSvgTagName('textpath')).toBe('textPath');
    expect(adjustSvgTagName('g')).toBe('g');
    expect(adjustSvgTagName('circle')).toBe('circle');
  });

  it('renames a listed attribute and keeps its value', () => {
    const out = adjustAttributes(new Map([['viewbox', '0 0 1 1'], ['id', 'x']]), SVG_ATTRS);
    expect(out.get('viewBox')).toBe('0 0 1 1');
    expect(out.has('viewbox')).toBe(false);
    expect(out.get('id')).toBe('x');
  });

  it('adjusts the one MathML attribute', () => {
    const out = adjustAttributes(new Map([['definitionurl', 'u']]), MATHML_ATTRS);
    expect(out.get('definitionURL')).toBe('u');
  });

  // A namespaced attribute is stored under its DISPLAY key: prefix, a SPACE,
  // then the local name. That is what the html5lib format writes, and it is
  // unforgeable — whitespace ends an attribute name in the tokenizer.
  it('rewrites a namespaced attribute to its display key', () => {
    const out = adjustAttributes(new Map([['xlink:href', 'foo'], ['xml:lang', 'en']]), FOREIGN_ATTRS);
    expect(out.get('xlink href')).toBe('foo');
    expect(out.get('xml lang')).toBe('en');
  });

  // xmlns has NO prefix, so it keeps its own name — the one entry in the
  // table whose key and value are equal, which reads like a typo.
  it('leaves a bare xmlns alone while prefixing xmlns:xlink', () => {
    const out = adjustAttributes(
      new Map([['xmlns', 'u'], ['xmlns:xlink', 'v']]), FOREIGN_ATTRS,
    );
    expect(out.get('xmlns')).toBe('u');
    expect(out.get('xmlns xlink')).toBe('v');
  });

  it('returns a new map rather than mutating its input', () => {
    const input = new Map([['viewbox', '0 0 1 1']]);
    const out = adjustAttributes(input, SVG_ATTRS);
    expect(input.get('viewbox')).toBe('0 0 1 1');
    expect(out).not.toBe(input);
  });
});

describe('the integration-point predicates', () => {
  it('names the five MathML text integration points', () => {
    for (const n of ['mi', 'mo', 'mn', 'ms', 'mtext']) {
      expect(isMathmlTextIntegrationPoint(createElement(n, undefined, 'math'))).toBe(true);
    }
    expect(isMathmlTextIntegrationPoint(createElement('math', undefined, 'math'))).toBe(false);
  });

  // The namespace is half the answer. An HTML <mi> is an ordinary unknown
  // element; only a MathML one is an integration point.
  it('requires the MathML namespace', () => {
    expect(isMathmlTextIntegrationPoint(createElement('mi'))).toBe(false);
    expect(isMathmlTextIntegrationPoint(createElement('mi', undefined, 'svg'))).toBe(false);
  });

  it('reads annotation-xml encoding case-insensitively', () => {
    const enc = (v: string) =>
      createElement('annotation-xml', new Map([['encoding', v]]), 'math');
    expect(isHtmlIntegrationPoint(enc('text/html'))).toBe(true);
    expect(isHtmlIntegrationPoint(enc('TEXT/HTML'))).toBe(true);
    expect(isHtmlIntegrationPoint(enc('application/xhtml+xml'))).toBe(true);
    expect(isHtmlIntegrationPoint(enc('text/plain'))).toBe(false);
    expect(isHtmlIntegrationPoint(createElement('annotation-xml', undefined, 'math'))).toBe(false);
  });

  it('names the three SVG integration points', () => {
    for (const n of ['foreignObject', 'desc', 'title']) {
      expect(isHtmlIntegrationPoint(createElement(n, undefined, 'svg'))).toBe(true);
    }
    expect(isHtmlIntegrationPoint(createElement('g', undefined, 'svg'))).toBe(false);
  });

  // foreignObject is stored ADJUSTED, so the predicate matches the adjusted
  // spelling. Matching the lowercase one instead silently never fires.
  it('matches the adjusted spelling of foreignObject', () => {
    expect(isHtmlIntegrationPoint(createElement('foreignobject', undefined, 'svg'))).toBe(false);
    expect(isHtmlIntegrationPoint(createElement('foreignObject', undefined, 'svg'))).toBe(true);
  });
});

describe('the foreign breakout list', () => {
  it('holds the HTML start tags that pop out of foreign content', () => {
    for (const n of ['b', 'blockquote', 'div', 'h1', 'table', 'ul', 'var']) {
      expect(FOREIGN_BREAKOUT.has(n)).toBe(true);
    }
  });

  // `font` is NOT in the list: it breaks out only when it carries color,
  // face or size, which is a rule at the call site rather than a member.
  it('excludes font, whose rule is conditional', () => {
    expect(FOREIGN_BREAKOUT.has('font')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmlforeign.test.ts`
Expected: FAIL — `../src/htmlforeign.js` does not exist.

- [ ] **Step 3: Write the module**

Create `src/htmlforeign.ts` with exactly this content. The five tables are
transcribed from the HTML Standard on 2026-08-27 — copy them literally rather
than retyping, and do not "complete" one that looks truncated:

```ts
/** The data half of HTML5 foreign content (HTML Standard §13.2.6.5): the four
 *  adjustment tables, the two integration-point predicates and the breakout
 *  list.
 *
 *  Invariant: a PURE LEAF. It imports htmldom.js for TYPES ONLY and nothing
 *  else — no stack, no insertion, no tokenizer — which is what lets every
 *  table entry and every predicate be asserted from an element literal with no
 *  parser in the picture. The token RULES stay in htmltree.ts, because they
 *  insert elements, pop the stack and reconstruct formatting; moving those out
 *  needs either a wide seam of injected callbacks or an import back that
 *  closes a cycle. Same split htmlcharref.ts makes against htmltoken.ts.
 *
 *  Invariant: nothing here throws. */

import type { HtmlElement } from './htmldom.js';

/** §13.2.6.5's SVG tag-name table: 37 entries, keyed on the all-lowercase
 *  spelling the tokenizer emits. */
export const SVG_TAG_NAMES: ReadonlyMap<string, string> = new Map([
  ['altglyph', 'altGlyph'], ['altglyphdef', 'altGlyphDef'], ['altglyphitem', 'altGlyphItem'],
  ['animatecolor', 'animateColor'], ['animatemotion', 'animateMotion'],
  ['animatetransform', 'animateTransform'], ['clippath', 'clipPath'], ['feblend', 'feBlend'],
  ['fecolormatrix', 'feColorMatrix'], ['fecomponenttransfer', 'feComponentTransfer'],
  ['fecomposite', 'feComposite'], ['feconvolvematrix', 'feConvolveMatrix'],
  ['fediffuselighting', 'feDiffuseLighting'], ['fedisplacementmap', 'feDisplacementMap'],
  ['fedistantlight', 'feDistantLight'], ['fedropshadow', 'feDropShadow'],
  ['feflood', 'feFlood'], ['fefunca', 'feFuncA'], ['fefuncb', 'feFuncB'],
  ['fefuncg', 'feFuncG'], ['fefuncr', 'feFuncR'], ['fegaussianblur', 'feGaussianBlur'],
  ['feimage', 'feImage'], ['femerge', 'feMerge'], ['femergenode', 'feMergeNode'],
  ['femorphology', 'feMorphology'], ['feoffset', 'feOffset'], ['fepointlight', 'fePointLight'],
  ['fespecularlighting', 'feSpecularLighting'], ['fespotlight', 'feSpotLight'],
  ['fetile', 'feTile'], ['feturbulence', 'feTurbulence'], ['foreignobject', 'foreignObject'],
  ['glyphref', 'glyphRef'], ['lineargradient', 'linearGradient'],
  ['radialgradient', 'radialGradient'], ['textpath', 'textPath'],
]);

/** "Adjust SVG attributes": 58 entries. */
export const SVG_ATTRS: ReadonlyMap<string, string> = new Map([
  ['attributename', 'attributeName'], ['attributetype', 'attributeType'],
  ['basefrequency', 'baseFrequency'], ['baseprofile', 'baseProfile'], ['calcmode', 'calcMode'],
  ['clippathunits', 'clipPathUnits'], ['diffuseconstant', 'diffuseConstant'],
  ['edgemode', 'edgeMode'], ['filterunits', 'filterUnits'], ['glyphref', 'glyphRef'],
  ['gradienttransform', 'gradientTransform'], ['gradientunits', 'gradientUnits'],
  ['kernelmatrix', 'kernelMatrix'], ['kernelunitlength', 'kernelUnitLength'],
  ['keypoints', 'keyPoints'], ['keysplines', 'keySplines'], ['keytimes', 'keyTimes'],
  ['lengthadjust', 'lengthAdjust'], ['limitingconeangle', 'limitingConeAngle'],
  ['markerheight', 'markerHeight'], ['markerunits', 'markerUnits'],
  ['markerwidth', 'markerWidth'], ['maskcontentunits', 'maskContentUnits'],
  ['maskunits', 'maskUnits'], ['numoctaves', 'numOctaves'], ['pathlength', 'pathLength'],
  ['patterncontentunits', 'patternContentUnits'], ['patterntransform', 'patternTransform'],
  ['patternunits', 'patternUnits'], ['pointsatx', 'pointsAtX'], ['pointsaty', 'pointsAtY'],
  ['pointsatz', 'pointsAtZ'], ['preservealpha', 'preserveAlpha'],
  ['preserveaspectratio', 'preserveAspectRatio'], ['primitiveunits', 'primitiveUnits'],
  ['refx', 'refX'], ['refy', 'refY'], ['repeatcount', 'repeatCount'],
  ['repeatdur', 'repeatDur'], ['requiredextensions', 'requiredExtensions'],
  ['requiredfeatures', 'requiredFeatures'], ['specularconstant', 'specularConstant'],
  ['specularexponent', 'specularExponent'], ['spreadmethod', 'spreadMethod'],
  ['startoffset', 'startOffset'], ['stddeviation', 'stdDeviation'],
  ['stitchtiles', 'stitchTiles'], ['surfacescale', 'surfaceScale'],
  ['systemlanguage', 'systemLanguage'], ['tablevalues', 'tableValues'], ['targetx', 'targetX'],
  ['targety', 'targetY'], ['textlength', 'textLength'], ['viewbox', 'viewBox'],
  ['viewtarget', 'viewTarget'], ['xchannelselector', 'xChannelSelector'],
  ['ychannelselector', 'yChannelSelector'], ['zoomandpan', 'zoomAndPan'],
]);

/** "Adjust MathML attributes". ONE entry is what the spec defines — it reads
 *  like an error and is not. A table anyway, so all three adjust calls have
 *  one shape. */
export const MATHML_ATTRS: ReadonlyMap<string, string> = new Map([
  ['definitionurl', 'definitionURL'],
]);

/** "Adjust foreign attributes", stored as the html5lib DISPLAY key: the
 *  prefix, a SPACE, then the local name. `xmlns` has no prefix and so keeps
 *  its own name — the one row whose key and value are equal. */
export const FOREIGN_ATTRS: ReadonlyMap<string, string> = new Map([
  ['xlink:actuate', 'xlink actuate'], ['xlink:arcrole', 'xlink arcrole'],
  ['xlink:href', 'xlink href'], ['xlink:role', 'xlink role'],
  ['xlink:show', 'xlink show'], ['xlink:title', 'xlink title'],
  ['xlink:type', 'xlink type'], ['xml:lang', 'xml lang'],
  ['xml:space', 'xml space'], ['xmlns', 'xmlns'], ['xmlns:xlink', 'xmlns xlink'],
]);

/** The HTML start tags that pop out of foreign content, 44 of them. `font` is
 *  deliberately absent: it breaks out only when it carries `color`, `face` or
 *  `size`, which is a test at the call site rather than a member here. */
export const FOREIGN_BREAKOUT: ReadonlySet<string> = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em',
  'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing',
  'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike',
  'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);

export function adjustSvgTagName(name: string): string {
  return SVG_TAG_NAMES.get(name) ?? name;
}

/** Rename every listed attribute, keeping its value and leaving the rest
 *  alone. Returns a NEW map: a token's attributes are run through two tables
 *  in SVG (SVG_ATTRS then FOREIGN_ATTRS), and mutating in place would make the
 *  order of those two calls matter. */
export function adjustAttributes(
  attrs: Map<string, string>,
  table: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of attrs) out.set(table.get(k) ?? k, v);
  return out;
}

const MATHML_TEXT_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
const SVG_HTML_POINTS = new Set(['foreignObject', 'desc', 'title']);
const HTML_ENCODINGS = new Set(['text/html', 'application/xhtml+xml']);

/** §13.2.6.5. The NAMESPACE is half the answer: an HTML `<mi>` is an ordinary
 *  unknown element and only a MathML one is an integration point. */
export function isMathmlTextIntegrationPoint(el: HtmlElement): boolean {
  return el.ns === 'math' && MATHML_TEXT_POINTS.has(el.name);
}

/** §13.2.6.5. Note the SVG names are the ADJUSTED spellings, because that is
 *  what the element carries by the time this is asked — matching
 *  `foreignobject` here silently never fires.
 *
 *  The spec phrases the annotation-xml case as a property of the START TAG's
 *  `encoding` attribute, which invites keeping a side table; we store the
 *  token's attributes on the element, so reading the element is equivalent. */
export function isHtmlIntegrationPoint(el: HtmlElement): boolean {
  if (el.ns === 'svg') return SVG_HTML_POINTS.has(el.name);
  if (el.ns !== 'math' || el.name !== 'annotation-xml') return false;
  const enc = el.attrs.get('encoding');
  return enc !== undefined && HTML_ENCODINGS.has(enc.toLowerCase());
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmlforeign.test.ts`
Expected: PASS, all 13 assertions.

- [ ] **Step 5: Verify the table sizes against the spec, not against the test**

The size assertions only prove the module agrees with itself if both were
typed from the same wrong source. Confirm the counts independently:

```bash
node -e "const m=require('fs').readFileSync('src/htmlforeign.ts','utf8');
for (const n of ['SVG_TAG_NAMES','SVG_ATTRS','FOREIGN_ATTRS']) {
  const i=m.indexOf(n); const j=m.indexOf(']);', i);
  console.log(n, (m.slice(i,j).match(/\['/g)||[]).length);
}"
```
Expected: `SVG_TAG_NAMES 37`, `SVG_ATTRS 58`, `FOREIGN_ATTRS 11`.

- [ ] **Step 6: Prove the namespace half of the predicates load-bearing**

Delete `el.ns === 'math' &&` from `isMathmlTextIntegrationPoint` and run the
file.
Expected: FAIL on "requires the MathML namespace" alone. Revert.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck
npx vitest run test/htmlforeign.test.ts test/wpt-tree.test.ts
git add src/htmlforeign.ts test/htmlforeign.test.ts
git commit -m "feat(zch2.1.3.1): the foreign-content tables and predicates

A pure leaf over htmldom.js's TYPES alone: no stack, no insertion, no
tokenizer, so every table entry and every predicate is assertable from an
element literal with no parser in the picture. The token rules stay in
htmltree.ts, which inserts and pops. Same split htmlcharref.ts makes.

Table sizes are asserted (37, 58, 1, 11, 44) so a half-transcribed table is
a red build rather than a silently mis-cased element that still renders.
Three rows read like typos and are not: MathML's table has exactly one entry,
xmlns is the one foreign attribute whose key equals its value because it has
no prefix, and the SVG integration points are the ADJUSTED spellings, since
that is what the element carries by the time the predicate is asked."
```

---

## Task 3: Namespace-aware `special` and scope

**Files:**
- Modify: `src/htmlstack.ts`
- Modify: `src/htmltree.ts` (the `SPECIAL` set and its four call sites)
- Test: `test/htmlstack.test.ts`

**Interfaces:**
- Consumes: `HtmlElement`, `HtmlNamespace` (Task 1).
- Produces:
  ```ts
  // htmlstack.ts — unchanged signatures; hasInScope now means an HTML element
  // of that name, and the terminators are (ns, name) pairs.
  export function isSpecial(el: HtmlElement): boolean;   // htmltree.ts, module-private
  ```

The rule, and why it is silent when wrong: the special category and the scope
lists both hold MathML `mi/mo/mn/ms/mtext/annotation-xml` and SVG
`foreignObject/desc/title`. An SVG `title` is special **and** an HTML
`<title>` is special — but MathML `mi` is special while an HTML `<mi>` is not,
and an HTML `<desc>` is not. A name-only test is wrong in both directions, and
what it breaks is the adoption agency's choice of furthest block: the result is
a mis-nested tree that still renders.

- [ ] **Step 1: Write the failing test**

Add this import beside the existing ones at the TOP of
`test/htmlstack.test.ts`:

```ts
import type { HtmlNamespace } from '../src/htmldom.js';
```

then append the rest to the end of the file:

```ts
function nsStackOf(...pairs: [string, HtmlNamespace][]): OpenElements {
  const s = new OpenElements();
  for (const [n, ns] of pairs) s.push(createElement(n, undefined, ns));
  return s;
}

describe('namespace-aware scope', () => {
  // An SVG foreignObject terminates the scope; an HTML element of the same
  // name does not, because no such HTML element is in the list.
  it('terminates a scope at an SVG integration point', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['foreignObject', 'svg'], ['span', 'html']).hasInScope('p')).toBe(false);
  });

  it('does not terminate at an HTML element of the same name', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['foreignObject', 'html'], ['span', 'html']).hasInScope('p')).toBe(true);
  });

  it('terminates at a MathML text integration point', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['mi', 'math'], ['span', 'html']).hasInScope('p')).toBe(false);
  });

  // The everyday direction: an HTML <mi> is an unknown element and stops
  // nothing.
  it('does not terminate at an HTML mi', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'], ['p', 'html'],
      ['mi', 'html'], ['span', 'html']).hasInScope('p')).toBe(true);
  });

  // hasInScope names an HTML element. A foreign element of that name is not
  // the target, or `</p>` inside SVG would close an SVG <p>.
  it('looks for an HTML element, not a foreign one of the same name', () => {
    expect(nsStackOf(['html', 'html'], ['body', 'html'],
      ['p', 'svg']).hasInScope('p')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmlstack.test.ts`
Expected: FAIL on the four namespace cases — the current search is name-only.

- [ ] **Step 3: Make the terminators `(ns, name)` pairs**

In `src/htmlstack.ts`, replace the scope constants and `scopeSearch`:

```ts
/** A scope terminator, as `ns:name`. Keying on the pair is not tidiness: an
 *  SVG `title` terminates a scope and so does an HTML `<title>`, but MathML
 *  `mi` does and an HTML `<mi>` does not. A name-only test is wrong in both
 *  directions, and what it breaks is the adoption agency's choice of furthest
 *  block — a mis-nested tree that still renders. */
const BASE_SCOPE = [
  'html:applet', 'html:caption', 'html:html', 'html:table', 'html:td', 'html:th',
  'html:marquee', 'html:object', 'html:select', 'html:template',
  'math:mi', 'math:mo', 'math:mn', 'math:ms', 'math:mtext', 'math:annotation-xml',
  'svg:foreignObject', 'svg:desc', 'svg:title',
];

const SCOPE_STOPPERS: Record<ScopeKind, string[]> = {
  default: BASE_SCOPE,
  listItem: [...BASE_SCOPE, 'html:ol', 'html:ul'],
  button: [...BASE_SCOPE, 'html:button'],
  table: ['html:html', 'html:table', 'html:template'],
};
```

and inside `scopeSearch`:

```ts
      if (match(el)) return true;
      if (stoppers.includes(`${el.ns}:${el.name}`)) return false;
```

Then make the three name-taking entry points mean *an HTML element of that
name*:

```ts
  hasInScope(name: string, kind: ScopeKind = 'default'): boolean {
    return this.scopeSearch((e) => e.ns === 'html' && e.name === name, kind);
  }

  hasOneOfInScope(names: string[], kind: ScopeKind = 'default'): boolean {
    return this.scopeSearch((e) => e.ns === 'html' && names.includes(e.name), kind);
  }

  containsName(name: string): boolean {
    return this.items.some((e) => e.ns === 'html' && e.name === name);
  }
```

`hasElementInScope` compares identity and is unchanged.

- [ ] **Step 4: Make `special` namespace-aware in `htmltree.ts`**

Replace the `SPECIAL` set's four `SPECIAL.has(...)` call sites with an
`isSpecial(el)` helper. Keep the existing 78-name set for HTML and add the
nine foreign members:

```ts
const SPECIAL_FOREIGN = new Set([
  'math:mi', 'math:mo', 'math:mn', 'math:ms', 'math:mtext', 'math:annotation-xml',
  'svg:foreignObject', 'svg:desc', 'svg:title',
]);

/** §13.2.4.2's special category. Namespace-aware for the reason htmlstack.ts
 *  records: MathML `mi` is special while an HTML `<mi>` is not. */
function isSpecial(el: HtmlElement): boolean {
  return el.ns === 'html'
    ? SPECIAL.has(el.name)
    : SPECIAL_FOREIGN.has(`${el.ns}:${el.name}`);
}
```

Call sites to change (all currently `SPECIAL.has(node.name)`): the `li` start
tag loop, the `dd`/`dt` start tag loop, `anyOtherEndTag`, and the furthest-block
search in `adoptionAgency`.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run test/htmlstack.test.ts`
Expected: PASS, all 18 assertions.

- [ ] **Step 6: Run the standing fence**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: PASS, **1,317** — unchanged. Nothing creates a foreign element yet,
so every stack in the corpus is still all-HTML and the pair keys must behave
exactly as the bare names did.

- [ ] **Step 7: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmlstack.ts src/htmltree.ts test/htmlstack.test.ts
git commit -m "feat(zch2.1.3.1): namespace-aware special and scope

The special category and the scope terminators both hold MathML
mi/mo/mn/ms/mtext/annotation-xml and SVG foreignObject/desc/title, so both
must key on (ns, name). An SVG title terminates a scope and so does an HTML
<title>, but MathML mi does and an HTML <mi> does not — a name-only test is
wrong in BOTH directions, and what it breaks is the adoption agency's choice
of furthest block, which yields a mis-nested tree that still renders.

hasInScope now means an HTML element of that name, or </p> inside an SVG
subtree would close an SVG <p>. hasElementInScope compares identity and is
untouched. The 1,317 WPT cases stay green: nothing creates a foreign element
yet, so the pair keys must behave exactly as the bare names did."
```

---

## Task 4: The tokenizer's CDATA seam

**Files:**
- Modify: `src/htmltoken.ts`
- Test: `test/htmltoken.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface TokenizerOptions {
    /** Asked at the moment `<![CDATA[` is seen. Default: () => false. */
    adjustedCurrentNodeIsForeign?: () => boolean;
  }
  export class HtmlTokenizer {
    constructor(src: string, options?: TokenizerOptions);
  }
  ```

- [ ] **Step 1: Write the failing test**

Append to `test/htmltoken.test.ts` (import `TokenizerState` if it is not
already imported there):

```ts
describe('the CDATA routing seam', () => {
  function tokensOf(src: string, foreign: boolean) {
    const t = new HtmlTokenizer(src, { adjustedCurrentNodeIsForeign: () => foreign });
    const out: HtmlToken[] = [];
    for (;;) {
      const tok = t.next();
      if (tok.kind === 'eof') break;
      out.push(tok);
    }
    return { tokens: out, errors: t.errors };
  }

  // In HTML content `<![CDATA[` is a bogus comment plus a parse error. This
  // is zch2.1.1's behaviour and must not move.
  it('makes a bogus comment in HTML content', () => {
    const { tokens, errors } = tokensOf('<![CDATA[a]]>', false);
    expect(tokens).toEqual([{ kind: 'comment', data: '[CDATA[a]]' }]);
    expect(errors.map((e) => e.code)).toContain('cdata-in-html-content');
  });

  // In foreign content the same bytes are a CDATA section: its contents come
  // through as CHARACTERS and there is no parse error at all.
  it('makes character tokens in foreign content', () => {
    const { tokens, errors } = tokensOf('<![CDATA[a]]>', true);
    expect(tokens.map((t) => (t as { data: string }).data).join('')).toBe('a');
    expect(tokens.every((t) => t.kind === 'character')).toBe(true);
    expect(errors.map((e) => e.code)).not.toContain('cdata-in-html-content');
  });

  // The default is what keeps zch2.1.1's 7,032 cases untouched.
  it('defaults to HTML content when no callback is given', () => {
    const t = new HtmlTokenizer('<![CDATA[a]]>');
    expect(t.next()).toEqual({ kind: 'comment', data: '[CDATA[a]]' });
  });

  // Asked at the moment of the decision, never cached: the stack changes
  // between tokens, so a flag read once is right until a <svg> opens.
  it('asks the callback at each decision rather than caching it', () => {
    let foreign = false;
    const t = new HtmlTokenizer('<![CDATA[a]]><![CDATA[b]]>', {
      adjustedCurrentNodeIsForeign: () => foreign,
    });
    expect(t.next()).toEqual({ kind: 'comment', data: '[CDATA[a]]' });
    foreign = true;
    expect(t.next()).toEqual({ kind: 'character', data: 'b' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: FAIL — the constructor takes one argument; the foreign cases produce
comments.

- [ ] **Step 3: Add the option and the routing test**

In `src/htmltoken.ts`, above the class:

```ts
export interface TokenizerOptions {
  /** Whether the adjusted current node is a non-HTML element, which is what
   *  decides whether `<![CDATA[` opens a CDATA section (§13.2.5.42).
   *
   *  Invariant: a CALLBACK asked at the moment of the decision, never a flag
   *  kept in sync. The stack of open elements changes between tokens, so a
   *  cached answer stays right until a `<svg>` opens mid-stream — which is
   *  exactly the document this exists for. Pull matches the seam the tokenizer
   *  already is (`next`/`setState`). */
  adjustedCurrentNodeIsForeign?: () => boolean;
}
```

Add the field and constructor parameter:

```ts
  private readonly isForeign: () => boolean;

  constructor(src: string, options?: TokenizerOptions) {
    this.src = preprocess(src);
    this.isForeign = options?.adjustedCurrentNodeIsForeign ?? (() => false);
    this.scanInputStream();
  }
```

Then replace the `[CDATA[` branch of markup declaration open. Keep the
existing comment about the column, and put the new test FIRST so the error is
not reported when the section is legal:

```ts
    if (this.src.startsWith('[CDATA[', this.i)) {
      this.advance(7);
      if (this.isForeign()) {
        this.state = TokenizerState.CdataSection;
        return;
      }
      // Reported at the LAST character of the sequence it consumed (col 9 of
      // `<![CDATA[`), unlike incorrectly-opened-comment below, which consumes
      // nothing and reports at the character it only looked at.
      this.error('cdata-in-html-content', { line: at.line, col: at.col + 6, index: at.index + 6 });
      this.commentData = '[CDATA[';
      this.state = TokenizerState.BogusComment;
      return;
    }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/htmltoken.test.ts`
Expected: PASS, including all of `zch2.1.1`'s existing cases.

- [ ] **Step 5: Run the tokenizer conformance fence**

Run: `npx vitest run test/html5lib-tokenizer.test.ts test/html5lib-suite.test.ts`
Expected: PASS, **7,032** cases — unchanged. The default callback is what
makes this true; a red case means the default is not `false`.

- [ ] **Step 6: Run the gates and commit**

```bash
npm run typecheck
npm test
git add src/htmltoken.ts test/htmltoken.test.ts
git commit -m "feat(zch2.1.3.1): the tokenizer's CDATA routing seam

markup declaration open routes '<![CDATA[' to the CDATA section state only
when the adjusted current node is not an HTML element. zch2.1.1 implemented
the second half and left the first marked in a comment; its CDATA states
already existed and already passed their own cases, so no state changes here.

A CALLBACK asked at the moment of the decision, never a flag kept in sync:
the stack changes between tokens, so a cached answer stays right until a
<svg> opens mid-stream. Pull matches the seam the tokenizer already is. The
default is () => false, which is what keeps the 7,032 html5lib cases and
cdata-in-html-content untouched."
```

---

## Task 5: Foreign content in `htmltree.ts`, and the corpus turned on

The largest task. It lands the parsing and takes the corpus from 1,317 to
1,524.

**Files:**
- Modify: `src/htmltree.ts`
- Modify: `test/helpers/wpt-tree.ts` (the bucket predicate)
- Test: `test/htmltree.test.ts`, `test/wpt-tree-suite.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: no new exports. `parseHtml` keeps its signature and stays
  unexported from `index.ts`.

### What to implement

**The dispatcher branch**, before the insertion-mode switch. HTML rules apply
when: the stack is empty; the adjusted current node is an HTML element; the
adjusted current node is a MathML text integration point and the token is a
character, or a start tag whose name is neither `mglyph` nor `malignmark`; the
adjusted current node is a MathML `annotation-xml` and the token is a start tag
named `svg`; the adjusted current node is an HTML integration point and the
token is a start tag or a character; or the token is EOF. Otherwise the
foreign rules run.

`adjustedCurrentNode()` returns the current node. It is named for the spec and
differs only in the fragment case, which is `zch2.1.3.3`.

**The `math` and `svg` start tags in "in body"** (§13.2.6.4.7): reconstruct the
active formatting elements; adjust MathML (or SVG) attributes; adjust foreign
attributes; insert a foreign element in that namespace; and if the token is
self-closing, pop and acknowledge.

**The foreign token rules** (§13.2.6.5):

| Token | Action |
|---|---|
| U+0000 | Insert U+FFFD — **not** ignore, which is what "in body" does |
| whitespace | Insert the character |
| any other character | Insert the character; `framesetOk = false` |
| comment | Insert a comment |
| DOCTYPE | Ignore |
| a start tag in `FOREIGN_BREAKOUT`, or `font` with `color`/`face`/`size`, or an end tag `br`/`p` | While the current node is not a MathML text integration point, an HTML integration point, or an HTML element, pop. Then reprocess in the current insertion mode. |
| any other start tag | If the adjusted current node is MathML, adjust MathML attributes; if SVG, adjust the tag name and the SVG attributes; adjust foreign attributes; insert a foreign element in the **adjusted current node's** namespace; if self-closing, pop and acknowledge |
| any other end tag | Walk from the current node: if its name lowercased equals the token's, pop through it and return; if it is the topmost element, return; else move up, and once past the first node, if it is an HTML element process the token in the current insertion mode instead |

- [ ] **Step 1: Write the failing hand-built test**

Append to `test/htmltree.test.ts`. **Every expectation is copied from the
corpus with its case id** — none is invented:

```ts
describe('foreign content', () => {
  // tests10.dat#8 — note `<svg svg>`: the prefix is the namespace, not the
  // tag, so SVG's own root repeats. And the table is foster-parented out.
  it('parses an svg subtree into the SVG namespace', () => {
    expect(tree('<!DOCTYPE html><body><table><tbody><svg><g>foo</g><g>bar</g></svg></tbody></table>'))
      .toBe('| <!DOCTYPE html>\n| <html>\n|   <head>\n|   <body>\n|     <svg svg>\n|       <svg g>\n|         "foo"\n|       <svg g>\n|         "bar"\n|     <table>\n|       <tbody>');
  });

  // tests10.dat#1 — in HTML content `<![CDATA[` is a bogus comment.
  it('makes a comment of a CDATA section outside foreign content', () => {
    expect(tree('<!DOCTYPE html><svg></svg><![CDATA[a]]>')).toBe(
      '| <!DOCTYPE html>\n| <html>\n|   <head>\n|   <body>\n|     <svg svg>\n|     <!-- [CDATA[a]] -->',
    );
  });

  it('never throws on foreign input', () => {
    for (const s of ['<svg>', '<svg/>', '<math>', '<svg><foreignObject><div></div>',
      '<math><annotation-xml encoding=text/html><p>', '<svg><![CDATA[x]]>']) {
      expect(() => parseHtml(s)).not.toThrow();
    }
  });
});
```

Before writing any further case, read its real expectation out of the corpus
rather than guessing it. `wpt-tree.ts` is TypeScript and `node --experimental-strip-types`
will not resolve its `.js` specifiers, so the way to do this is a scratch
vitest file — create it now and delete it in Step 7:

```ts
// test/_show.test.ts — SCRATCH, delete before committing.
import { it } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { serializeTree, loadWptCases } from './helpers/wpt-tree.js';

it('show', () => {
  for (const spec of (process.env.SHOW ?? '').split(',').filter((s) => s !== '')) {
    const [f, i] = spec.split('#');
    const c = loadWptCases([f as string])[Number(i)];
    if (c === undefined) { console.log(`${spec}: no such case`); continue; }
    console.log(`=== ${spec}`);
    console.log('IN  : ' + JSON.stringify(c.data));
    console.log('WANT:\n' + c.document);
    console.log('GOT :\n' + serializeTree(parseHtml(c.data)));
  }
});
```

Run it as `SHOW="tests10.dat#8,svg.dat#0" npx vitest run test/_show.test.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/htmltree.test.ts`
Expected: FAIL — `<svg>` currently parses into the HTML namespace, so the
serializer writes `<svg>` rather than `<svg svg>`.

- [ ] **Step 3: Implement foreign content**

Work in `src/htmltree.ts`, running `npx vitest run test/htmltree.test.ts` as
each rule lands. Add to the parser's state nothing at all — foreign content is
entirely a function of the stack. The pieces, in the order they are easiest to
land: `adjustedCurrentNode()`, the `math`/`svg` start tags in "in body", the
dispatcher branch, then the foreign token rules.

`insertElement` gains a namespace parameter defaulting to `'html'`, mirroring
`createElement`, so no existing call site moves.

Wire the tokenizer seam in the `TreeBuilder` constructor:

```ts
    this.tokenizer = new HtmlTokenizer(src, {
      adjustedCurrentNodeIsForeign: () => {
        const node = this.adjustedCurrentNode();
        return node !== undefined && node.ns !== 'html';
      },
    });
```

- [ ] **Step 4: Run the hand-built test to verify it passes**

Run: `npx vitest run test/htmltree.test.ts`
Expected: PASS.

- [ ] **Step 5: Retire the foreign bucket**

In `test/helpers/wpt-tree.ts`, delete the `svg|math` line from `classify` and
rename the remaining template test's bucket. The `Bucket` union loses
`'foreign'` and gains `'template'`:

```ts
export type Bucket =
  | 'inScope' | 'fragment' | 'scripted' | 'template' | 'processingInstruction'
  | 'selectedContent';
```

```ts
  // zch2.1.3.1 retired the `foreign` bucket: svg and math now RUN. What is
  // left of it is the template test, which keeps the 110 template-only cases
  // and — because it is now the only test of the two — the 2 that are both.
  if (/^\| +<template>/m.test(doc) || /^\| +content$/m.test(doc)) return 'template';
```

Update `test/wpt-tree-suite.test.ts`'s count assertion:

```ts
    expect(all.length).toBe(1936);
    expect(casesInBucket('fragment').length).toBe(196);
    expect(casesInBucket('scripted').length).toBe(14);
    expect(casesInBucket('template').length).toBe(112);
    expect(casesInBucket('selectedContent').length).toBe(4);
    expect(casesInBucket('processingInstruction').length).toBe(86);
    expect(casesInBucket('inScope').length).toBe(1524);
    const sum = (['fragment', 'scripted', 'template', 'selectedContent',
      'processingInstruction', 'inScope'] as const)
      .reduce((n, b) => n + casesInBucket(b).length, 0);
    expect(sum).toBe(1936);
```

and change the `'foreign'` reference in the exclusion test, if any, to
`'template'`.

- [ ] **Step 6: Turn on the corpus and drive it green**

Run: `npx vitest run test/wpt-tree.test.ts`
Expected: 1,524 cases collected. Fix `src/htmltree.ts` until all pass.

**Never edit a vendored expectation, and never move a case into another bucket
to make it green.** If a rule genuinely cannot be satisfied, stop and report
it rather than reclassifying — that is the silent-skip failure this whole
design guards against. If the corpus contradicts this plan about the spec,
the corpus wins and the contradiction gets recorded, the way `zch2.1.2`'s
`select` finding was.

- [ ] **Step 7: Delete the scratch file and run the gates**

```bash
rm -f test/_show.test.ts
npm run typecheck
npm test
git add src/htmltree.ts test/helpers/wpt-tree.ts test/htmltree.test.ts test/wpt-tree-suite.test.ts
git commit -m "feat(zch2.1.3.1): foreign content, and 1,524 WPT cases green

The §13.2.6 dispatcher branch, the foreign token rules, and the math/svg
start tags in 'in body'. An element created while the foreign rules run takes
the ADJUSTED CURRENT NODE's namespace, not one derived from its own name,
which is what puts <g> in SVG without a table of SVG element names.

Two rules that differ from HTML content and are easy to miss: a NUL is
inserted as U+FFFD rather than ignored, and the self-closing flag is READ —
zch2.1.2 ignored it entirely and correctly, since no HTML element's parsing
depends on it, but <svg/> is an empty element while <svg> swallows the rest
of the document.

The foreign bucket is retired rather than split: svg and math now run, and
what is left of it is the template test, which keeps the 110 template-only
cases and the 2 that are both. 1,317 -> 1,524 in scope, all six counts
re-asserted."
```

---

## Task 6: Mutations, docs, and close

**Files:**
- Modify: `test/fixtures/wpt/PROVENANCE.md`, `CLAUDE.md`, `CHANGELOG.md`

- [ ] **Step 1: Run the mutations and record what actually reddens**

Run each against
`npx vitest run test/wpt-tree.test.ts test/htmltree.test.ts test/htmlstack.test.ts test/htmlforeign.test.ts`,
note the count and the files, then revert:

| # | Mutation | Expected |
|---|---|---|
| 1 | `adjustSvgTagName` returns its argument unchanged | `tests10`, `svg` |
| 2 | `isMathmlTextIntegrationPoint` and `isHtmlIntegrationPoint` both return `false` | the `foreignObject` and `annotation-xml` cases |
| 3 | `FOREIGN_BREAKOUT` emptied | `tests10`, `tests11` |
| 4 | The self-closing branch of "any other start tag" deleted | the `<svg/>` cases |
| 5 | `adjustedCurrentNodeIsForeign` forced to `() => false` | `tests10`'s `<![CDATA[` cases |
| 6 | `isSpecial` made namespace-blind (`SPECIAL.has(el.name)` for every element) | possibly NOTHING — record it if so |
| 7 | Foreign NUL ignored rather than inserted as U+FFFD | the `plain-text-unsafe` cases |

- [ ] **Step 2: Write the results into PROVENANCE.md**

Append a `### zch2.1.3.1` subsection under the existing `## Mutation results`
with the observed file names and counts, **not the predictions**. A mutation
that reddens nothing is the important result — it means the corpus does not
cover that rule, and it is recorded as an uncovered gap rather than left to be
discovered. Update the bucket table in the `## Buckets` section to the new six
counts, and add a line to `## What the corpus corrected about the spec` if the
corpus disagreed with this plan anywhere.

- [ ] **Step 3: Update the CLAUDE.md source-list entry**

The existing `htmldom.ts`/`htmlstack.ts`/`htmltree.ts` entry gains
`**htmlforeign.ts**` in its heading and these invariants:

```markdown
  **Invariant:** `htmlforeign.ts` is a pure leaf holding DATA and PREDICATES
  only — it imports `htmldom.js` for types and nothing else. The token rules
  stay in `htmltree.ts`, because they insert elements, pop the stack and
  reconstruct formatting; moving them out needs either a wide seam of injected
  callbacks or an import back that closes a cycle. Its five tables carry
  asserted SIZES (37, 58, 1, 11, 44), so a half-transcribed table is a red
  build rather than a silently mis-cased element that still renders.
  **Invariant:** `special` and the four scope terminator lists key on
  `(ns, name)`, never a bare name. An SVG `title` terminates a scope and so
  does an HTML `<title>` — but MathML `mi` does and an HTML `<mi>` does not, so
  a name-only test is wrong in BOTH directions. What it breaks is the adoption
  agency's choice of furthest block: a mis-nested tree that still renders.
  **Invariant:** an element created in foreign content takes the ADJUSTED
  CURRENT NODE's namespace, never one derived from its own name. That is what
  puts `<g>` in SVG with no table of SVG element names, and an unknown element
  inside `<math>` in MathML.
  **Invariant:** the tokenizer's `adjustedCurrentNodeIsForeign` is a CALLBACK
  asked at the moment `<![CDATA[` is seen, never a flag kept in sync. The stack
  changes between tokens, so a cached answer is right until a `<svg>` opens
  mid-stream — exactly the document it exists for. Its default is `() => false`,
  which is what holds the 7,032 tokenizer cases still.
  **Note:** the self-closing flag is read HERE and nowhere else. `zch2.1.2`
  ignored it entirely and was right to — no HTML element's parsing depends on
  it — but in foreign content `<svg/>` is an empty element while `<svg>`
  swallows the rest of the document.
  **Note:** a NUL in foreign content is inserted as U+FFFD, where "in body"
  ignores it. One `case` label apart, and no rendering reveals the difference
  until a document carries one.
```

Update the entry's case counts from 1,317 to 1,524 and its bucket list. Then
run the repo's own sweep and confirm it does not name `htmlforeign.ts`:

```bash
for f in src/*.ts; do b=$(basename "$f")
  grep -q "[*][*]$b[*][*]" CLAUDE.md || echo "$b"
done
```

- [ ] **Step 4: Add the CHANGELOG entry**

Under `## [Unreleased]`, in **Added**, above the tree-construction entry:

```markdown
- **HTML5 foreign content**, so an inline `<svg>` or `<math>` subtree parses
  into its own namespace instead of silently into the HTML one — the reason
  `zch2.1.2` withheld the `parseHtml` export. The rules for parsing tokens in
  foreign content (HTML Standard §13.2.6.5), the four adjustment tables that
  fix the case of SVG element and attribute names and turn `xlink:href` into a
  namespaced attribute, the two integration-point predicates that decide when
  an HTML insertion mode resumes inside a foreign subtree, and the breakout
  list that pops out of one on an HTML block start tag. **1,524 of the 1,936
  vendored web-platform-tests cases now run, all green**, up from 1,317. The
  self-closing flag is read for the first time in the parser's life: no HTML
  element's parsing depends on it, but `<svg/>` is an empty element while
  `<svg>` swallows the rest of the document. Still not reachable from public
  API — `parseHtml` ships with fragment parsing in `zch2.1.3.3`. (`zch2.1.3.1`)
```

- [ ] **Step 5: Run the gates, commit, close, push**

```bash
npm run typecheck
npm test
git add -A src test docs CLAUDE.md CHANGELOG.md
git commit -m "feat(zch2.1.3.1): mutations recorded, docs, close

Seven mutations run and recorded in PROVENANCE.md with observed counts rather
than predictions; any that reddened nothing are written down as uncovered."
bd close aspose-pdf-foss-for-ts-zch2.1.3.1
bd export -o .beads/issues.jsonl
git add .beads && git commit -m "chore(beads): close zch2.1.3.1"
git pull --rebase && git push && git status -sb
```

`git status` must show the branch up to date with origin.

---

## Self-review

**Spec coverage.** `htmlforeign.ts` as a pure leaf with the four tables and two
predicates → Task 2; the node model's `ns` field and the `'html'` default →
Task 1; attributes staying `Map<string, string>` with display keys → Tasks 1
and 2; the serializer's prefix → Task 1; the tokenizer callback and its default
→ Task 4; the dispatcher branch and `adjustedCurrentNode` → Task 5; the
namespace-aware `special` and scope → Task 3; element creation taking the
adjusted current node's namespace → Task 5; the bucket retirement and the six
re-asserted counts → Task 5; the six named mutations → Task 6, which adds a
seventh (foreign NUL) the spec did not name.

**Two things the plan settles that the spec did not:**

1. **Task ordering puts the interface changes first and inert.** Tasks 1, 3 and
   4 all end by running the 1,317-case fence and expecting it *unchanged*,
   which is what makes each of them independently reviewable — a reviewer can
   reject Task 3 without touching Task 1. Only Task 5 moves the number.
2. **`adjustAttributes` returns a new map and takes the table as an argument.**
   A token in SVG is run through two tables in sequence; mutating in place
   would make the order of those two calls matter, and it does not.

**Known soft spot, flagged rather than hidden:** Task 5's Step 3 is "build it
rule by rule" rather than a literal transcription, exactly as `zch2.1.2`'s
Task 5 was. Its Step 6 is the real gate — 207 more vendored cases, no
allowlist. Mutation 6 (`isSpecial` made namespace-blind) is the one most
likely to redden nothing, because a document has to mis-nest formatting
*across* a foreign boundary to expose it; if it does redden nothing, Task 3's
unit assertions are the only thing holding that rule and PROVENANCE must say
so.
