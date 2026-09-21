import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  publicExports, readmeApiSection, readmeFirstCells, readmeImportedNames, readmeRowNames,
} from './helpers/public-exports.js';

/** `clik`. README's API Reference claims to list every name `index.ts` exports
 *  and states how many there are. Both claims had drifted — 17 exports had no
 *  row, the counts were 18 types and 8 values short — because nothing checked
 *  either. This is what checks them now, and it asks the TypeScript compiler
 *  what the package exports rather than a regex (`k738`). */

const { types, values } = publicExports();
const api = readmeApiSection();

describe('README API Reference matches index.ts (clik)', () => {
  it('found an export surface at all', () => {
    // A helper that resolved nothing would make every assertion below vacuous
    // — the failure `k738` records for a sweep that parsed zero edges.
    expect(types.length).toBeGreaterThan(300);
    expect(values.length).toBeGreaterThan(100);
  });

  it('gives every exported name a row', () => {
    const rows = readmeRowNames(api);
    const missing = [...types, ...values].filter((n) => !rows.has(n));
    expect(missing).toEqual([]);
  });

  it('states the counts the compiler reports', () => {
    // \s+ throughout: the sentence is hard-wrapped, and where it breaks moves
    // whenever a number gains a digit.
    const m = /(\d+)\s+public\s+types\s+plus\s+(\d+)\s+functions,\s+classes\s+and\s+constants/.exec(api);
    expect(m, 'the count sentence').not.toBeNull();
    expect({ types: Number(m![1]), values: Number(m![2]) })
      .toEqual({ types: types.length, values: values.length });
  });

  it('carries no module-suffixed pseudo-names', () => {
    // `Rect-text`, `RGB-annotdraw`: a generator's way of telling same-named
    // declarations apart. index.ts exports ONE of each name, so the suffixed
    // spelling is importable by nobody and the real export had no row.
    const suffixed = readmeFirstCells(api).filter((c) => /^`[A-Za-z_$][\w$]*-[a-z]/.test(c));
    expect(suffixed).toEqual([]);
  });

  it('keeps every table row in its columns', () => {
    // A bare `|` inside a first cell splits the row: `HtmlNode`'s union was
    // written that way and rendered as nine cells.
    const bad = api.split('\n').filter((l) => /^\| `[^`]*` \| `[^`]*` \| `/.test(l));
    expect(bad).toEqual([]);
  });
});

describe("README's examples import only what the package exports (clik)", () => {
  it('names nothing index.ts does not export', () => {
    // saveImagesFile and htmlFileToPdf were imported from '@asposefoss/pdf' by
    // README's own example while index.ts exported neither: their tests import
    // src/node.js directly, so nothing in the suite could see it.
    const exported = new Set([...types, ...values]);
    const imported = readmeImportedNames();
    expect(imported.length).toBeGreaterThan(20);
    expect(imported.filter((n) => !exported.has(n))).toEqual([]);
  });

  it('reads the whole README, not just the API section', () => {
    // The wrappers' example sits in Additional Examples, well above the API
    // Reference — a check scoped to the tables would never have seen it.
    expect(readFileSync('README.md', 'utf8').indexOf('saveImagesFile,'))
      .toBeLessThan(readFileSync('README.md', 'utf8').indexOf('## API Reference'));
  });
});
