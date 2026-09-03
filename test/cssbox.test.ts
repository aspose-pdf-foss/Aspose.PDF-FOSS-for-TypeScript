import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { buildBoxes } from '../src/cssbox.js';
import type { BlockBox, BoxNode, TableBox } from '../src/cssbox.js';
import type { FamilyResolver } from '../src/cssinline.js';
import type { ResolvedFamily } from '../src/mdstyle.js';

const FAMILY: ResolvedFamily = {
  regular: 'Helvetica', bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique', boldItalic: 'Helvetica-BoldOblique',
};
const resolver: FamilyResolver = () => FAMILY;

const build = (src: string) => buildBoxes(parseHtml(src), resolver);

/** The box for `#<id>`, found anywhere in the tree. */
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

/** A compact shape: kind, tag, and either child shapes or the run texts. */
function shape(b: BoxNode): unknown {
  if (b.kind === 'table') return ['table', b.el.name];
  const head = [b.kind, b.el?.name ?? '-'];
  return b.content.kind === 'blocks'
    ? [...head, b.content.children.map(shape)]
    : [...head, b.content.runs.map((r) => r.text)];
}

describe('display', () => {
  it('makes a box for a block element', () => {
    const b = find(build('<!doctype html><div id=t>x</div>').boxes, 't');
    expect(b?.kind).toBe('block');
  });

  it('makes NO box for display:none, and none for its subtree', () => {
    // Not a box flagged invisible: a hidden subtree must not reach zch2.4,
    // must not consume a margin, and must not take part in collapsing.
    const { boxes } = build('<!doctype html><div id=t style="display:none"><p id=k>x</p></div>');
    expect(find(boxes, 't')).toBeUndefined();
    expect(find(boxes, 'k')).toBeUndefined();
  });

  it('marks a list-item', () => {
    expect(find(build('<!doctype html><ul><li id=t>x</li></ul>').boxes, 't')?.kind)
      .toBe('list-item');
  });

  it('emits a table box OPAQUE, without descending into it', () => {
    // zch2.6 owns the anonymous-table fixup and builds through flowtable.ts.
    const { boxes } = build('<!doctype html><table id=t><tr><td id=k>x</td></tr></table>');
    const t = find(boxes, 't');
    expect(t?.kind).toBe('table');
    expect(find(boxes, 'k')).toBeUndefined();
  });
});

describe('the two formatting contexts', () => {
  it('gives a block with only text one INLINE context', () => {
    const b = find(build('<!doctype html><p id=t>a <b>b</b></p>').boxes, 't') as BlockBox;
    expect(b.content.kind).toBe('inline');
    expect(b.content.kind === 'inline' && b.content.runs.map((r) => r.text))
      .toEqual(['a ', 'b']);
  });

  it('gives a block with only block children a BLOCKS context', () => {
    const b = find(build('<!doctype html><div id=t><p>a</p><p>b</p></div>').boxes, 't') as BlockBox;
    expect(b.content.kind).toBe('blocks');
    expect(b.content.kind === 'blocks' && b.content.children.length).toBe(2);
  });

  it('WRAPS mixed inline content in anonymous block boxes', () => {
    // The rule the issue is named for. `a<p>b</p>c` is three block-level
    // boxes: anonymous, p, anonymous.
    const b = find(build('<!doctype html><div id=t>a<p>b</p>c</div>').boxes, 't') as BlockBox;
    expect(shape(b)).toEqual(['block', 'div', [
      ['anonymous', '-', ['a']],
      ['block', 'p', ['b']],
      ['anonymous', '-', ['c']],
    ]]);
  });

  it('makes NO anonymous box for whitespace between two blocks', () => {
    // `<div><p>a</p>\n<p>b</p></div>` has a text node between the two, and it
    // collapses to nothing. An anonymous box holding one space would add a
    // whole empty line to every prettily-indented document there is.
    const b = find(build('<!doctype html><div id=t><p>a</p>\n  <p>b</p></div>').boxes, 't') as BlockBox;
    expect(b.content.kind === 'blocks' && b.content.children.length).toBe(2);
  });

  it('gives an anonymous box its PARENT style, not a fresh initial one', () => {
    // It exists to hold inline content, so it must inherit the styling that
    // content is in. A fresh initial style resets the font and colour of
    // every mixed container in a document.
    const b = find(build(
      '<!doctype html><div id=t style="font-size:30px;color:red">a<p>b</p></div>').boxes,
    't') as BlockBox;
    const anon = b.content.kind === 'blocks' ? b.content.children[0] as BlockBox : undefined;
    expect(anon?.kind).toBe('anonymous');
    expect(anon?.style.fontSize).toBe(30);
    expect(anon?.content.kind === 'inline'
      && anon.content.runs[0]?.color).toEqual([1, 0, 0]);
  });
});

describe('float and clear', () => {
  it('carries float and clear onto the box', () => {
    const b = find(build(
      '<!doctype html><div id=t style="float:left;clear:both">x</div>').boxes, 't');
    expect(b?.float).toBe('left');
    expect(b?.clear).toBe('both');
  });

  it('defaults both to none', () => {
    const b = find(build('<!doctype html><div id=t>x</div>').boxes, 't');
    expect(b?.float).toBe('none');
    expect(b?.clear).toBe('none');
  });
});

describe('the whole build', () => {
  it('starts at the document element, not the document', () => {
    const { boxes } = build('<!doctype html><p>x</p>');
    expect(boxes.length).toBe(1);
    expect((boxes[0] as BlockBox).el?.name).toBe('html');
  });

  it('drops head, which the UA sheet gives display:none', () => {
    const { boxes } = build('<!doctype html><title>t</title><p id=t>x</p>');
    const html = boxes[0] as BlockBox;
    const kids = html.content.kind === 'blocks' ? html.content.children : [];
    expect(kids.some((k) => (k as BlockBox).el?.name === 'head')).toBe(false);
    expect(find(boxes, 't')).toBeDefined();
  });

  it('carries the cascade unsupported list through', () => {
    const { unsupported } = build('<!doctype html><style>p{box-shadow:0 0 2px}</style><p>x</p>');
    expect(unsupported.some((u) => u.property === 'box-shadow')).toBe(true);
  });

  it('never throws, on any document', () => {
    for (const s of ['', '<p>x</p>', '<div><span>a</span></div>',
      '<table><tr><td>x</td></tr></table>', '<template><b>x</b></template>',
      '<div style="display:none"></div>']) {
      expect(() => build(s), s).not.toThrow();
    }
  });
});

describe('table boxes (zch2.6)', () => {
  /** The first table box in the tree. */
  const tableOf = (src: string): TableBox => {
    const { boxes } = buildBoxes(parseHtml(`<!doctype html>${src}`), resolver);
    const seek = (bs: BoxNode[]): TableBox | undefined => {
      for (const b of bs) {
        if (b.kind === 'table') return b;
        if (b.content.kind === 'blocks') {
          const hit = seek(b.content.children);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    };
    const t = seek(boxes);
    if (t === undefined) throw new Error('no table box');
    return t;
  };

  it('descends into rows and cells', () => {
    const t = tableOf('<table><tr><td>a</td><td>b</td></tr></table>');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].cells.length).toBe(2);
  });

  it('reads a cell as an ordinary block container, so its runs are built', () => {
    // A cell's content goes through the SAME machinery a paragraph's does,
    // which is what makes bold, code and links behave identically inside one.
    const t = tableOf('<table><tr><td>hello</td></tr></table>');
    const c = t.rows[0].cells[0].content;
    expect(c.kind).toBe('inline');
    if (c.kind !== 'inline') throw new Error('expected inline');
    expect(c.runs.map((r) => r.text).join('')).toBe('hello');
  });

  it('marks a thead row as the head section and its cells as headers', () => {
    const t = tableOf('<table><thead><tr><th>h</th></tr></thead>'
      + '<tbody><tr><td>b</td></tr></tbody></table>');
    expect(t.rows[0].section).toBe('head');
    expect(t.rows[0].cells[0].header).toBe(true);
    expect(t.rows[1].section).toBe('body');
    expect(t.rows[1].cells[0].header).toBe(false);
  });

  it('marks a td inside a thead as a header too', () => {
    // The SECTION decides, not the tag. A <thead> is the header section
    // whatever its cells are called, and it is what repeats atop each page of
    // a paginated table — which is the only thing `header` is read for.
    // Measured: with every thead fixture using <th>, the `inHead` half of the
    // rule is unreachable and a mutation deleting it reddens nothing.
    const t = tableOf('<table><thead><tr><td>h</td></tr></thead>'
      + '<tbody><tr><td>b</td></tr></tbody></table>');
    expect(t.rows[0].cells[0].header).toBe(true);
    expect(t.rows[1].cells[0].header).toBe(false);
  });

  it('marks a bare th as a header even outside a thead', () => {
    const t = tableOf('<table><tr><th>h</th><td>b</td></tr></table>');
    expect(t.rows[0].cells[0].header).toBe(true);
    expect(t.rows[0].cells[1].header).toBe(false);
  });

  it('puts a tfoot row in the foot section', () => {
    const t = tableOf('<table><tfoot><tr><td>f</td></tr></tfoot></table>');
    expect(t.rows[0].section).toBe('foot');
  });

  it('reads colspan and rowspan, defaulting to 1', () => {
    const t = tableOf('<table><tr><td colspan=2 rowspan=3>a</td><td>b</td></tr></table>');
    expect(t.rows[0].cells[0].colSpan).toBe(2);
    expect(t.rows[0].cells[0].rowSpan).toBe(3);
    expect(t.rows[0].cells[1].colSpan).toBe(1);
    expect(t.rows[0].cells[1].rowSpan).toBe(1);
  });

  it('clamps a junk span to 1 rather than producing NaN', () => {
    // A NaN span reaches TableBuilder and corrupts the whole grid, where 1 is
    // simply the cell the author most likely meant.
    const t = tableOf('<table><tr><td colspan=0 rowspan=abc>a</td></tr></table>');
    expect(t.rows[0].cells[0].colSpan).toBe(1);
    expect(t.rows[0].cells[0].rowSpan).toBe(1);
  });

  it('takes the caption out of the row flow', () => {
    const t = tableOf('<table><caption>Cap</caption><tr><td>a</td></tr></table>');
    expect(t.caption).not.toBeNull();
    expect(t.rows.length).toBe(1);
  });

  it('wraps a stray display:table-cell in an anonymous ROW (17.2.1)', () => {
    // The fixup earns its place HERE, not on <table> markup: htmltree.ts
    // already produces well-formed table > tbody > tr > td, so real HTML
    // needs almost none of 17.2.1.
    const t = tableOf('<div style="display:table">'
      + '<div style="display:table-cell">a</div></div>');
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].el).toBeNull();
    expect(t.rows[0].cells.length).toBe(1);
  });

  it('wraps a stray non-cell child of a row in an anonymous CELL (17.2.1)', () => {
    const t = tableOf('<div style="display:table">'
      + '<div style="display:table-row"><span>a</span></div></div>');
    expect(t.rows[0].cells.length).toBe(1);
    expect(t.rows[0].cells[0].el).toBeNull();
  });

  it('gives an empty table NO rows, so nothing downstream indexes grid[0]', () => {
    // A table with no rows draws nothing and would otherwise reach
    // TableBuilder with zero rows, whose grid[0] does not exist.
    const t = tableOf('<table></table>');
    expect(t.rows.length).toBe(0);
  });
});
