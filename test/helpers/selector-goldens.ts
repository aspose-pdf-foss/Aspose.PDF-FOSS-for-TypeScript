/** Loader for the Blink-generated selector corpus, plus the child-index path
 *  function that is its other half.
 *
 *  Test-only. Nothing in `src/` may import this, the rule
 *  `test/helpers/css-parsing.ts` and `test/helpers/wpt-tree.ts` already set.
 *
 *  The path is computed on BOTH sides — here and inside the browser in
 *  scripts/gen-selector-goldens.ts — which is the one place a bug can cancel
 *  out. test/cssselect-suite.test.ts carries a deliberate-mismatch test for
 *  exactly that reason. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HtmlElement } from '../../src/htmldom.js';

const FILE = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..', 'fixtures', 'css-selectors', 'goldens.json',
);

export interface SelectorCase { doc: string; selector: string; paths: number[][] }
export interface SpecCase { doc: string; property: string; winner: string; loser: string }
export interface SelectorGoldens {
  chrome: string;
  cases: SelectorCase[];
  specificity: SpecCase[];
}

export function loadSelectorGoldens(): SelectorGoldens {
  return JSON.parse(readFileSync(FILE, 'utf8')) as SelectorGoldens;
}

/** The child-index path from the document element, counting ELEMENT children
 *  only. Mirrors the walk the generator makes with `parentElement.children`,
 *  which is an element-only collection. */
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
