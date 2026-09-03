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

function findBox(bs: BoxNode[], id: string): BoxNode | undefined {
  for (const b of bs) {
    if (b.el?.attrs.get('id') === id) return b;
    if (b.kind !== 'table' && b.content.kind === 'blocks') {
      const hit = findBox(b.content.children, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The collapsed gaps before each child of `#t`. */
function gaps(src: string, width = 800): number[] {
  const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
  const t = findBox(boxes, 't') as BlockBox;
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
    expect(gaps('<div id=t><p style="margin:0">a</p>'
      + '<div><p style="margin-top:40px">b</p></div></div>')[1]).toBe(40);
  });

  it('does NOT let it escape a parent with top padding', () => {
    expect(gaps('<div id=t><p style="margin:0">a</p>'
      + '<div style="padding-top:1px"><p style="margin-top:40px">b</p></div></div>')[1])
      .toBe(0);
  });

  it('does NOT let it escape a parent with a top border', () => {
    expect(gaps('<div id=t><p style="margin:0">a</p>'
      + '<div style="border-top:1px solid black"><p style="margin-top:40px">b</p></div></div>')[1])
      .toBe(0);
  });
});

describe('rule 3: parent and last in-flow child', () => {
  it('lets a child bottom margin escape a parent with no height', () => {
    expect(gaps('<div id=t><div><p style="margin-bottom:40px">a</p></div>'
      + '<p style="margin:0">b</p></div>')[1]).toBe(40);
  });

  it('does NOT let it escape a parent that states a height', () => {
    // The condition that reads as an afterthought and is not: a parent with a
    // height has a bottom edge of its own for the margin to stop at.
    expect(gaps('<div id=t><div style="height:50px"><p style="margin-bottom:40px">a</p></div>'
      + '<p style="margin:0">b</p></div>')[1]).toBe(0);
  });

  it('does NOT let it escape a parent with bottom padding', () => {
    expect(gaps('<div id=t><div style="padding-bottom:1px">'
      + '<p style="margin-bottom:40px">a</p></div><p style="margin:0">b</p></div>')[1])
      .toBe(0);
  });
});

describe('rule 4: a wholly empty block', () => {
  it('collapses its own top and bottom margins together, spending them ONCE', () => {
    // An empty div with 20px top and 30px bottom contributes 30 in TOTAL —
    // not 50, and not 30 twice.
    //
    // The gap lands entirely after it, which is the second half of the rule
    // and the half a per-sibling reading gets wrong: an empty block occupies
    // no vertical space, so its margins are still adjoining everything on
    // both sides and the whole run is ONE margin. Emitting 30 before it and
    // 30 after spends that margin twice — measured against Chrome, 60px
    // where 30px is right. Chrome splits the same 30 as 20 before the
    // zero-height box and 10 after; the running total is what matters and it
    // agrees.
    expect(gaps('<div id=t><p style="margin:0">a</p>'
      + '<div style="margin:20px 0 30px"></div>'
      + '<p style="margin:0">b</p></div>')).toEqual([0, 0, 30]);
  });

  it('does NOT collapse one that has a border', () => {
    const g = gaps('<div id=t><p style="margin:0">a</p>'
      + '<div style="margin:20px 0 30px;border:1px solid black"></div>'
      + '<p style="margin:0">b</p></div>');
    expect(g[1]).toBe(20);
    expect(g[2]).toBe(30);
  });
});

describe('what does not collapse', () => {
  it('does not collapse a FLOAT margin with its siblings', () => {
    const g = gaps('<div id=t><p style="margin:0 0 30px">a</p>'
      + '<p style="float:left;margin-top:20px">b</p></div>');
    expect(g[1]).toBe(20);
  });

  it('does not collapse across a cleared box', () => {
    const g = gaps('<div id=t><p style="margin:0 0 30px">a</p>'
      + '<p style="clear:both;margin-top:20px">b</p></div>');
    expect(g[1]).toBe(20);
  });
});

describe('outerMargins', () => {
  it('reports a box own margins when nothing escapes', () => {
    const { boxes } = buildBoxes(
      parseHtml('<!doctype html><div id=t style="padding:1px;margin:10px 0 20px">x</div>'),
      resolver);
    const r = resolveBoxes([findBox(boxes, 't') as BoxNode], 800)[0]!;
    expect(outerMargins(r)).toEqual({ top: 10, bottom: 20 });
  });
});
