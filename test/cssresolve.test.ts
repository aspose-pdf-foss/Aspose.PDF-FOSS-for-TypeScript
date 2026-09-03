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

describe('the math functions, resolved against the containing width', () => {
  it('resolves a mixed calc() width', () => {
    // 50% of 800, less 20px. Neither half alone is the answer, which is what
    // makes this the case a `{px} | {pct}` model could not express at all.
    expect(r('<div id=t style="width:calc(50% - 20px)">x</div>').contentWidth).toBe(380);
  });

  it('resolves a retained min() width, and the winner changes with the width', () => {
    const src = '<div id=t style="width:min(50%, 100px)">x</div>';
    expect(r(src, 100).contentWidth).toBe(50);
    expect(r(src, 800).contentWidth).toBe(100);
  });

  it('resolves a calc() padding against the WIDTH, on every edge', () => {
    // Vertical padding resolves against the width too, which is the part
    // that surprises — and the reason nothing here can be precomputed.
    const b = r('<div id=t style="padding:calc(10% + 4px)">x</div>', 200);
    expect(b.insetTop).toBe(24);
    expect(b.insetLeft).toBe(24);
  });

  it('IGNORES a height whose value depends on the width, as it does a bare %', () => {
    // A percentage height resolves against a height we do not have, and a
    // math function carrying one is no more resolvable than the percentage.
    // Note a BARE `height:50%` cannot pin this: its px part is 0, so a build
    // that wrongly reported the px part would still answer 0 and look right.
    expect(r('<div id=t style="height:calc(50% + 30px)">x</div>').minHeight).toBe(0);
    expect(r('<div id=t style="height:min(50%, 30px)">x</div>').minHeight).toBe(0);
  });

  it('keeps a percentage-FREE math function as a real minimum height', () => {
    expect(r('<div id=t style="height:calc(100px + 1em)">x</div>').minHeight).toBe(116);
    expect(r('<div id=t style="height:max(100px, 200px)">x</div>').minHeight).toBe(200);
  });
});
