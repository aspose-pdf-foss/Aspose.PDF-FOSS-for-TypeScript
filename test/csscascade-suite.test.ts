import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { computeStyles } from '../src/csscompute.js';
import {
  loadCascadeGoldens, pathOf, compareProp, isComparedProp,
} from './helpers/cascade-goldens.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

const G = loadCascadeGoldens();

function elementsInOrder(n: HtmlNode): HtmlElement[] {
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

describe('the Blink cascade corpus', () => {
  it('loads a non-trivial corpus', () => {
    expect(G.chrome).toMatch(/Chrome/);
    expect(G.cases.length).toBeGreaterThanOrEqual(14);
  });

  it('agrees with Blink on every declared property, with no allowlist', () => {
    const failures: string[] = [];
    for (const c of G.cases) {
      const doc = parseHtml(c.html);
      const r = computeStyles(doc);
      const els = elementsInOrder(doc);
      if (els.length !== c.values.length) {
        failures.push(`${c.id}: ${els.length} elements, Blink had ${c.values.length}`);
        continue;
      }
      for (let i = 0; i < els.length; i++) {
        const el = els[i] as HtmlElement;
        const s = r.styles.get(el);
        if (s === undefined) { failures.push(`${c.id}: no style for ${el.name}`); continue; }
        for (const p of c.props) {
          const want = (c.values[i] as Record<string, string>)[p] as string;
          const got = compareProp(p, s, want);
          if (!got.ok) {
            failures.push(
              `${c.id} [${pathOf(el).join('.')}] ${el.name} ${p}: ${got.ours} != ${want}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('the harness itself', () => {
  // The differential-test trap: a comparator that always returns ok would
  // leave the corpus green whatever the code does. A tampered golden MUST
  // turn it red.
  it('fails when a golden value is wrong', () => {
    const c = G.cases.find((x) => x.props.includes('color'));
    expect(c).toBeDefined();
    const doc = parseHtml((c as { html: string }).html);
    const s = computeStyles(doc).styles.get(elementsInOrder(doc)[0] as HtmlElement);
    expect(s).toBeDefined();
    // The tampered colour must be far from the real one. `rgb(1, 2, 3)` is
    // NOT: the comparator's tolerance is 0.02 of a 0..1 component and 3/255
    // is 0.012, so against black it passes — a tamper too small to fail is
    // no evidence at all.
    expect(compareProp('color', s!, 'rgb(255, 0, 255)').ok).toBe(false);
  });

  it('compares the properties it claims to, rather than skipping them', () => {
    // A missing KEY_OF row silently returns ok:true for that property, so the
    // map is asserted to cover every property any fixture names. Asked of the
    // MAP rather than of a call, so a deliberate value-dependent exclusion —
    // `line-height: normal` — cannot be mistaken for a missing row.
    for (const c of G.cases) {
      for (const p of c.props) {
        expect(isComparedProp(p), `${c.id}: ${p}`).toBe(true);
      }
    }
  });
});
