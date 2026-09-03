import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import {
  parseSelectorText, selectAll, specificityOf, compareSpecificity,
} from '../src/cssselect.js';
import { loadSelectorGoldens, pathOf } from './helpers/selector-goldens.js';

const G = loadSelectorGoldens();

describe('the Blink selector corpus', () => {
  // Counts asserted so a regenerated corpus reddens the build rather than
  // quietly changing what zch2.2.2 tests.
  it('loads a non-trivial corpus', () => {
    expect(G.chrome).toMatch(/Chrome/);
    expect(G.cases.length).toBeGreaterThan(800);
    expect(G.specificity.length).toBeGreaterThan(7);
  });

  it('agrees with Blink on every match set, with no allowlist', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const list = parseSelectorText(c.selector);
      if (list === null) {
        // Blink parsed it, so refusing it is a real divergence rather than a
        // scope decision — every out-of-scope selector was dropped by the
        // generator only when BLINK refused it too.
        failures.push(`${c.selector}: we refuse, Blink parses`);
        continue;
      }
      const ours = selectAll(parseHtml(c.doc), list).map(pathOf);
      const a = JSON.stringify(ours);
      const b = JSON.stringify(c.paths);
      if (a !== b) failures.push(`${c.selector} on ${c.doc.slice(0, 40)}: ${a} != ${b}`);
    }
    expect(failures).toEqual([]);
  });

  it('agrees with Blink on every specificity contest', () => {
    for (const s of G.specificity) {
      const w = parseSelectorText(s.winner);
      const l = parseSelectorText(s.loser);
      expect(w, s.winner).not.toBeNull();
      expect(l, s.loser).not.toBeNull();
      // >= 0 rather than > 0: the generator puts the losing rule SECOND, so a
      // tie is legitimately resolved by source order and the second still
      // wins. Only a strictly lower specificity for the observed winner is a
      // real disagreement.
      expect(
        compareSpecificity(specificityOf(w![0]!), specificityOf(l![0]!)),
        `${s.winner} beat ${s.loser}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the harness itself', () => {
  // The differential-test trap: the child-index path is computed on both
  // sides, so a bug in the walk could cancel out and leave the suite green.
  // A golden edited to name the wrong element MUST turn it red. Without this,
  // "the paths agree" could mean "both walks are wrong the same way".
  it('fails when a golden names the wrong element', () => {
    const real = G.cases.find((c) => c.paths.length > 0);
    expect(real).toBeDefined();
    const list = parseSelectorText(real!.selector);
    expect(list).not.toBeNull();
    const ours = selectAll(parseHtml(real!.doc), list!).map(pathOf);
    const tampered = real!.paths.map((p) => [...p.slice(0, -1), (p.at(-1) ?? 0) + 7]);
    expect(JSON.stringify(ours)).not.toBe(JSON.stringify(tampered));
  });

  it('produces a path that round-trips to the element it names', () => {
    const doc = parseHtml('<!doctype html><div><p>a</p><span><i>b</i></span></div>');
    const list = parseSelectorText('i');
    const el = selectAll(doc, list!)[0];
    expect(el).toBeDefined();
    // html > body > div > span > i, counting element children only.
    expect(pathOf(el!)).toEqual([1, 0, 1, 0]);
  });
});
