/** An inline <svg> survives as an ATOMIC — the shape `<img>` already has —
 *  instead of being suppressed (zch2.12).
 *
 *  It is an atomic and not a block box because an `<svg>` is `display: inline`
 *  by DEFAULT, so it never reaches cssbox.ts's boxFor at all: `visit` handles
 *  non-block-level nodes and only block-level children are routed to `boxFor`.
 *  A first attempt added a block box kind and produced NO box whatsoever for a
 *  top-level `<svg>`, which is what sent this back to the issue's own words —
 *  "a lone <svg> in a block is already the lone-atomic path imageElement
 *  takes".
 *
 *  The sizing numbers are MEASURED against Chrome/152 — see the table in
 *  docs/superpowers/specs/2026-09-02-inline-svg-design.md. The first row is the
 *  counter-intuitive one: a viewBox-only <svg> FILLS its container. */
import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import type { BoxNode } from '../src/cssbox.js';
import type { AtomicInline, FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolveFamily: FamilyResolver = () => FAMILY;

const build = (src: string): ReturnType<typeof buildBoxes> =>
  buildBoxes(parseHtml(`<!doctype html>${src}`), resolveFamily);

/** Every atomic anywhere in the box tree. */
function atomics(boxes: BoxNode[]): AtomicInline[] {
  const out: AtomicInline[] = [];
  const walk = (bs: BoxNode[]): void => {
    for (const b of bs) {
      if (b.kind === 'table') continue;
      if (b.content.kind === 'inline') out.push(...b.content.atomics);
      else walk(b.content.children);
    }
  };
  walk(boxes);
  return out;
}

describe('an inline <svg>', () => {
  it('becomes an atomic instead of being suppressed', () => {
    const { boxes, report } = build('<svg viewBox="0 0 10 10"><rect/></svg>');
    expect(report.filter((r) => r.construct === 'svg')).toEqual([]);
    const a = atomics(boxes);
    expect(a).toHaveLength(1);
    expect(a[0].kind).toBe('svg');
    expect(a[0].el.name).toBe('svg');
  });

  it('<math> IS still suppressed and reported', () => {
    const { report } = build('<math><mi>x</mi></math>');
    expect(report.filter((r) => r.construct === 'math')).toHaveLength(1);
  });

  it('does not leak its text into the flow', () => {
    // The leak zch2.7 closed: SVG <text> arriving as body text. It stays closed
    // because the subtree becomes ONE atomic rather than inline content.
    const { boxes } = build('<svg viewBox="0 0 10 10"><text>LEAK</text></svg>');
    const runs: string[] = [];
    const walk = (bs: BoxNode[]): void => {
      for (const b of bs) {
        if (b.kind === 'table') continue;
        if (b.content.kind === 'inline') runs.push(...b.content.runs.map((r) => r.text));
        else walk(b.content.children);
      }
    };
    walk(boxes);
    expect(runs.join('')).not.toContain('LEAK');
  });

  it('is an atomic even when CSS makes it display:block', () => {
    // display:block routes it to boxFor rather than visit, and a block-level
    // <svg> whose children were walked as content is exactly the leak above.
    const { boxes } = build('<svg style="display:block" viewBox="0 0 10 10"><text>X</text></svg>');
    expect(atomics(boxes)).toHaveLength(1);
  });
});
