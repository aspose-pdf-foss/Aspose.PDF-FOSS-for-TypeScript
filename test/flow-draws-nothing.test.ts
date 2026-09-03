/** An element that draws nothing because there is NOTHING TO DRAW must be
 *  discarded, not retried in the next column.
 *
 *  `fits` used to mean "nothing left over AND something was drawn", which
 *  conflates "empty" with "did not fit here". Only the second may mean retry:
 *  at a column start the engine has nowhere left to retry and throws
 *  'element does not fit in an empty column'. The everyday way to reach it is
 *  a Standard-14 fallback face that cannot encode the text — every character
 *  is dropped, the block measures 0 high, and the document refuses to render
 *  rather than coming out blank (zch2.13). */
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import { frameBoxes, type BoxFrame } from '../src/cssframe.js';
import type {
  FlowElement, MeasureContext, PlaceContext, PlaceResult,
} from '../src/flowelement.js';

/** Cyrillic: no WinAnsi code, so the Standard-14 fallback drops every glyph. */
const NONE = 'При';

const FRAME: BoxFrame = {
  marginLeft: 0, marginRight: 0,
  insetLeft: 0, insetRight: 0, insetTop: 0, insetBottom: 0,
  minHeight: 0,
};

/** An inner element with nothing to draw: no height, nothing left over. */
class Empty implements FlowElement {
  measure(_ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    return { usedHeight: 0, fits: true };
  }
  place(_ctx: PlaceContext): PlaceResult {
    return { usedHeight: 0, remainder: null, drew: false };
  }
}

/** An inner element that needs `total` points and splits when offered less. */
class Needs implements FlowElement {
  constructor(private readonly total: number) {}
  measure(ctx: MeasureContext): { usedHeight: number; fits: boolean } {
    const used = Math.min(this.total, Math.max(0, ctx.availHeight));
    return { usedHeight: used, fits: used >= this.total };
  }
  place(ctx: PlaceContext): PlaceResult {
    const used = Math.min(this.total, Math.max(0, ctx.availHeight));
    if (used <= 0) return { usedHeight: 0, remainder: this, drew: false };
    return {
      usedHeight: used,
      remainder: used >= this.total ? null : new Needs(this.total - used),
      drew: true,
    };
  }
}

describe('BoxElement over an inner element with nothing to draw', () => {
  it('discards it rather than asking for another column', () => {
    const doc = Document.New();
    const { page } = doc.AddPage(PageFormat.A4);
    const [el] = frameBoxes([new Empty()], FRAME);
    const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 500 });
    expect(res.usedHeight).toBe(0);
    expect(res.remainder).toBeNull();
  });

  it('reports it as fitting, so the verdict survives a NESTING chain', () => {
    // A <div> wrapping a <p> is a BoxElement wrapping a BoxElement: the inner
    // box's measure is what the outer one reads to decide discard-or-retry.
    const [inner] = frameBoxes([new Empty()], FRAME);
    const [outer] = frameBoxes([inner], FRAME);
    expect(outer.measure?.({ width: 400, availHeight: 500 })).toEqual(
      { usedHeight: 0, fits: true });
  });

  it('still asks for another column when the inner element genuinely does not fit',
    () => {
      const doc = Document.New();
      const { page } = doc.AddPage(PageFormat.A4);
      const [el] = frameBoxes([new Needs(50)], FRAME);
      const res = el.place({ doc, page, x: 0, top: 700, width: 400, availHeight: 0 });
      expect(res.usedHeight).toBe(0);
      expect(res.remainder).toBe(el);
    });
});

describe('AddHtml with text the fallback face cannot encode', () => {
  const shapes: Array<[string, string]> = [
    ['a paragraph', `<p>${NONE}</p>`],
    ['a div wrapping a paragraph', `<div><p>${NONE}</p></div>`],
    ['bare text with no tags', NONE],
    ['a list item', `<ul><li>${NONE}</li></ul>`],
    ['a block quote', `<blockquote>${NONE}</blockquote>`],
    ['a code block', `<pre><code>${NONE}</code></pre>`],
  ];
  for (const [name, src] of shapes) {
    it(`renders ${name} as blank rather than throwing`, () => {
      const doc = Document.New();
      expect(() => doc.AddHtml(src)).not.toThrow();
    });
  }

  it('still draws a following paragraph that CAN be encoded', () => {
    const doc = Document.New();
    const { pages } = doc.AddHtml(`<p>${NONE}</p><p>drawn anyway</p>`);
    expect(pages[0].GetText()).toContain('drawn anyway');
  });

  it('draws the encodable part of a mixed paragraph', () => {
    const doc = Document.New();
    const { pages } = doc.AddHtml(`<p>${NONE} kept</p>`);
    expect(pages[0].GetText()).toContain('kept');
  });
});

describe('Flow with text the fallback face cannot encode', () => {
  it('renders a paragraph, a list and a quote as blank rather than throwing', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4 });
    flow.AddParagraph(NONE);
    flow.AddList([NONE]);
    expect(() => flow.Render()).not.toThrow();
  });

  it('renders a Markdown code block as blank rather than throwing', () => {
    const doc = Document.New();
    expect(() => doc.AddMarkdown('```\n' + NONE + '\n```')).not.toThrow();
  });
});

describe('keep-with-next against a heading that draws nothing', () => {
  it('does not let it push the following content to a new column', () => {
    // `fits` alone is true for a heading with nothing to draw, and the
    // lookahead then measures the next element against a column it has not
    // actually shortened — so an undrawable heading breaks the page under it.
    const doc = Document.New();
    const flow = doc.NewFlow({ format: PageFormat.A4, keepHeadingsWithNext: true });
    flow.AddParagraph('lead');
    flow.AddHeading(1, NONE);
    flow.AddParagraph(NONE);
    flow.AddParagraph('tail');
    const pages = flow.Render();
    expect(pages).toHaveLength(1);
    expect(pages[0].GetText()).toContain('tail');
  });
});
