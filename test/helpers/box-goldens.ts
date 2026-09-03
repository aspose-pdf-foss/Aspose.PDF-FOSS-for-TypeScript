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
