/** The engine floats anything satisfying FloatContent, and an element carrying
 *  a float marker is floated as one (zch2.10). Driven from a hand-built
 *  FloatContent, so nothing here needs the CSS stack. */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { paragraph } from '../src/flow.js';
import type { FloatContent, FlowElement } from '../src/flowelement.js';
import type { Page } from '../src/page.js';

/** A FloatContent that records where it was painted and draws nothing. */
function stubContent(width: number, height: number, degrade = false): FloatContent & {
  painted: { x: number; topY: number }[];
} {
  const painted: { x: number; topY: number }[] = [];
  return {
    width,
    spacing: 0,
    painted,
    degradeOnOverflow: degrade,
    measure: () => height,
    paintAt: (_page: Page, x: number, topY: number) => { painted.push({ x, topY }); return height; },
  };
}

/** An element carrying a float marker; its own place() is the degrade path. */
function floatEl(content: FloatContent, side: 'left' | 'right'): FlowElement {
  const inner = paragraph('degraded body text')[0];
  return {
    float: { side, content },
    spaceBefore: 0,
    spaceAfter: 0,
    place: (ctx) => inner.place(ctx),
    measure: (ctx) => inner.measure!(ctx),
  };
}

/** A FloatContent that splits: every splitPaint call paints `perColumn` and
 *  hands back a tail one step shorter, so `columns` of 3 spans three columns.
 *  `painted` records every paint by either route. */
function splittingContent(width: number, perColumn: number, columns: number): {
  content: FloatContent;
  painted: { x: number; topY: number; height: number }[];
  splits: number;
} {
  const painted: { x: number; topY: number; height: number }[] = [];
  const state = { splits: 0 };
  const make = (left: number): FloatContent => ({
    width,
    spacing: 0,
    degradeOnOverflow: true,
    measure: () => perColumn * left,
    paintAt: (_page: Page, x: number, topY: number) => {
      painted.push({ x, topY, height: perColumn * left });
      return perColumn * left;
    },
    splitPaint: (_page: Page, x: number, topY: number, _max: number, side: 'left' | 'right') => {
      state.splits++;
      painted.push({ x, topY, height: perColumn });
      const rest = left - 1;
      return {
        height: perColumn,
        tail: rest === 0 ? undefined : {
          float: { side, content: make(rest) },
          spaceBefore: 0,
          spaceAfter: 0,
          place: (ctx) => paragraph('degraded body text')[0].place(ctx),
        } as FlowElement,
      };
    },
  });
  const content = make(columns);
  return { content, painted, get splits() { return state.splits; } };
}

describe('an element carrying a float marker', () => {
  it('is painted through its FloatContent, not placed in flow', () => {
    const c = stubContent(100, 50);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(c, 'left')]);
    flow.AddParagraph('body text that should wrap beside the float');
    flow.Render();
    expect(c.painted).toHaveLength(1);
  });

  it('narrows the channel for the text beside it', () => {
    const build = (withFloat: boolean): number => {
      const doc = Document.New();
      const flow = doc.NewFlow({ format: PageFormat.A4 });
      if (withFloat) flow.AddElements([floatEl(stubContent(200, 60), 'left')]);
      flow.AddParagraph('alpha bravo charlie delta echo foxtrot golf hotel india');
      const page = flow.Render()[0];
      return Math.min(...page.GetTextFragments().map((f) => f.quad[0]));
    };
    const withoutX = build(false);
    const withX = build(true);
    // The float is on the left, so the text starts further right.
    expect(withX).toBeGreaterThan(withoutX + 100);
  });
});

describe('a float that cannot fit an empty column', () => {
  it('THROWS when the content is not degradable (FloatingBox behaviour)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(stubContent(100, 5000, false), 'left')]);
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/);
  });

  it('lays out in flow and does NOT throw when it is degradable', () => {
    const c = stubContent(100, 5000, true);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(c, 'left')]);
    const pages = flow.Render();
    expect(c.painted).toHaveLength(0);                          // never floated
    expect(pages[0].GetText()).toContain('degraded body text'); // placed in flow
  });
});

describe('a float too tall for an EMPTY column (zch2.15)', () => {
  it('splits across columns instead of degrading', () => {
    // The column is 698pt (A4 less 72pt margins). 400 x 3 = 1200 does not fit,
    // nor does 800; the last 400 does, so it lands through the ordinary
    // paintAt path. Three paints, three pages.
    const f = splittingContent(100, 400, 3);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(f.content, 'left')]);
    const pages = flow.Render();
    expect(f.painted).toHaveLength(3);
    expect(f.splits).toBe(2);
    expect(pages).toHaveLength(3);
    expect(pages[0].GetText()).not.toContain('degraded body text');
  });

  it('takes the excluded band from the height PAINTED, not the height measured', () => {
    // Measures 2000 and paints 100. With the band read from measure() the
    // channel stays narrow for the whole column and every line of body text is
    // indented; with it read from the paint, the text resumes at full width
    // 100pt down. A float that fills its budget exactly cannot see this.
    //
    // The body must OVERFLOW the 100pt band, which is ~7 lines at the narrowed
    // width. A shorter paragraph fits inside the band whole, so every line is
    // indented under BOTH readings and the case measures nothing — the first
    // version of this fixture had 23 words and passed with the bug in place.
    const tail: FloatContent = {
      width: 200, spacing: 0, degradeOnOverflow: true,
      measure: () => 50,
      paintAt: () => 50,
    };
    const content: FloatContent = {
      width: 200, spacing: 0, degradeOnOverflow: true,
      measure: () => 2000,
      paintAt: () => 2000,
      splitPaint: (_p: Page, _x: number, _t: number, _m: number, side: 'left' | 'right') => ({
        height: 100,
        tail: {
          float: { side, content: tail },
          spaceBefore: 0, spaceAfter: 0,
          place: (ctx) => paragraph('degraded body text')[0].place(ctx),
        } as FlowElement,
      }),
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(content, 'left')]);
    const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima '
      + 'mike november oscar papa quebec romeo sierra tango uniform victor whiskey';
    flow.AddParagraph(`${WORDS} ${WORDS} ${WORDS} ${WORDS}`);
    const xs = flow.Render()[0].GetTextFragments()
      .sort((a, b) => b.quad[1] - a.quad[1])
      .map((fr) => fr.quad[0]);
    expect(xs.length).toBeGreaterThan(1);
    expect(xs[0]).toBeGreaterThan(xs[xs.length - 1] + 100);
  });

  it('degrades when splitPaint can place nothing, and asks exactly once', () => {
    let calls = 0;
    const content: FloatContent = {
      width: 100, spacing: 0, degradeOnOverflow: true,
      measure: () => 5000,
      paintAt: () => 5000,
      splitPaint: () => { calls++; return { height: 0 }; },
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(content, 'left')]);
    const pages = flow.Render();
    expect(calls).toBe(1);
    expect(pages[0].GetText()).toContain('degraded body text');
  });

  it('still THROWS for a non-degradable content whose split places nothing', () => {
    const content: FloatContent = {
      width: 100, spacing: 0,
      measure: () => 5000,
      paintAt: () => 5000,
      splitPaint: () => ({ height: 0 }),
    };
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddElements([floatEl(content, 'left')]);
    expect(() => flow.Render()).toThrow(/does not fit in an empty column/);
  });
});

describe('a float that DOES fit an empty column (zch2.10 stands)', () => {
  it('defers WHOLE rather than splitting, even when it does not fit what is left', () => {
    // 690 fits the 698pt column but not what one paragraph leaves of it, so
    // zch2.10's defer runs and splitPaint is never asked. The 8pt margin is
    // deliberate: any single line of text exceeds it.
    const f = splittingContent(100, 690, 1);
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph('a paragraph that spends part of the first column');
    flow.AddElements([floatEl(f.content, 'left')]);
    flow.Render();
    expect(f.splits).toBe(0);
    expect(f.painted).toHaveLength(1);
  });
});
