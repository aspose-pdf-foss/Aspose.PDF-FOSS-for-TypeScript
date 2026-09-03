import { describe, it, expect } from 'vitest';
import { parseHtml } from '../src/htmltree.js';
import { computeStyles } from '../src/csscompute.js';
import type { ComputedStyle } from '../src/cssprop.js';
import type { HtmlElement, HtmlNode } from '../src/htmldom.js';

function elementsOf(n: HtmlNode): HtmlElement[] {
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

/** The computed style of `#<id>`. */
function style(src: string, id: string): ComputedStyle {
  const doc = parseHtml(src);
  const r = computeStyles(doc);
  const el = elementsOf(doc).find((e) => e.attrs.get('id') === id);
  const s = r.styles.get(el as HtmlElement);
  if (s === undefined) throw new Error(`no style for #${id}`);
  return s;
}

describe('inheritance', () => {
  it('inherits an inherited property from the parent', () => {
    expect(style('<div style="color:red"><p id=t>x</p></div>', 't').color)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('does NOT inherit a non-inherited property', () => {
    expect(style('<div style="background-color:red"><p id=t>x</p></div>', 't')
      .backgroundColor).toEqual({ rgb: [0, 0, 0], a: 0 });
  });

  it('inherits border-collapse and border-spacing, which read wrong', () => {
    // They ARE inherited — the reason being that setting them on a container
    // should reach the table. Asserted on an element the UA sheet says
    // nothing about, for the reason the next test gives.
    const s = style('<div style="border-collapse:collapse;border-spacing:4px">'
      + '<p id=t>x</p></div>', 't');
    expect(s.borderCollapse).toBe('collapse');
    expect(s.borderSpacing).toBe(4);
  });

  it('lets the UA sheet DECLARATION on table beat that inheritance', () => {
    // The surprising half, and it is correct: an inherited property is
    // inherited only where the element has no declaration of its own, and the
    // UA sheet declares `table { border-collapse: separate; border-spacing:
    // 2px }` directly. So wrapping a table in a collapsing container does not
    // collapse it — an author must target the table. Browsers agree.
    const s = style('<!doctype html><div style="border-collapse:collapse;border-spacing:4px">'
      + '<table id=t><tr><td>x</td></tr></table></div>', 't');
    expect(s.borderCollapse).toBe('separate');
    expect(s.borderSpacing).toBe(2);
  });

  it('does NOT inherit text-decoration', () => {
    // It PROPAGATES visually to in-flow descendants, which is zch2.4's rule.
    // Modelling it as inheritance would let a descendant that sets its own
    // wrongly win, and would put the underline on the wrong element here.
    expect(style('<div style="text-decoration:underline"><p id=t>x</p></div>', 't')
      .textDecorationLine).toEqual([]);
  });

  it('gives the document element the initial value of an inherited property', () => {
    const doc = parseHtml('<!doctype html><p>x</p>');
    const r = computeStyles(doc);
    const html = elementsOf(doc).find((e) => e.name === 'html') as HtmlElement;
    expect(r.styles.get(html)?.fontSize).toBe(16);
  });
});

describe('the CSS-wide keywords', () => {
  it('inherit takes the parent value even for a non-inherited property', () => {
    expect(style('<div style="background-color:red">'
      + '<p id=t style="background-color:inherit">x</p></div>', 't').backgroundColor)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('initial takes the property initial even for an inherited property', () => {
    expect(style('<div style="color:red"><p id=t style="color:initial">x</p></div>', 't')
      .color).toEqual({ rgb: [0, 0, 0], a: 1 });
  });

  it('unset is inherit for an inherited property and initial for the rest', () => {
    expect(style('<div style="color:red"><p id=t style="color:unset">x</p></div>', 't')
      .color).toEqual({ rgb: [1, 0, 0], a: 1 });
    expect(style('<div style="background-color:red">'
      + '<p id=t style="background-color:unset">x</p></div>', 't').backgroundColor)
      .toEqual({ rgb: [0, 0, 0], a: 0 });
  });

  it('revert rolls back to the UA value, NOT to the initial', () => {
    // The UA sheet gives p a 1em top margin. `revert` must find it; treating
    // revert as unset gives 0 instead, which is a plausible wrong answer.
    const s = style('<!doctype html><style>p{margin-top:50px}</style>'
      + '<p id=t style="margin-top:revert">x</p>', 't');
    expect(s.marginTop).toEqual({ px: 16, pct: 0 });          // 1em of the 16px base
  });

  it('revert falls back to unset when the UA sheet says nothing', () => {
    const s = style('<!doctype html><div style="color:red">'
      + '<p id=t style="color:revert">x</p></div>', 't');
    expect(s.color).toEqual({ rgb: [1, 0, 0], a: 1 });
  });
});

describe('relative lengths', () => {
  it('resolves a font-size em against the PARENT size', () => {
    // The rule whose error compounds: 2em inside a 20px parent is 40px, and
    // resolving against the element's own size would make it 2 x itself.
    expect(style('<div style="font-size:20px"><p id=t style="font-size:2em">x</p></div>', 't')
      .fontSize).toBe(40);
  });

  it('resolves a NON-font-size em against the ELEMENT own size', () => {
    // The other half. margin-top:2em on an element whose own font-size is
    // 20px is 40px, even though the parent is 10px.
    const s = style('<div style="font-size:10px">'
      + '<p id=t style="font-size:20px;margin-top:2em">x</p></div>', 't');
    expect(s.marginTop).toEqual({ px: 40, pct: 0 });
  });

  it('compounds font-size down the tree', () => {
    expect(style('<div style="font-size:10px"><div style="font-size:2em">'
      + '<p id=t style="font-size:2em">x</p></div></div>', 't').fontSize).toBe(40);
  });

  it('resolves rem against the document element, not the parent', () => {
    const s = style('<!doctype html><style>html{font-size:10px}</style>'
      + '<div style="font-size:100px"><p id=t style="margin-top:2rem">x</p></div>', 't');
    expect(s.marginTop).toEqual({ px: 20, pct: 0 });
  });

  it('resolves a font-size percentage against the parent', () => {
    expect(style('<div style="font-size:20px"><p id=t style="font-size:150%">x</p></div>', 't')
      .fontSize).toBe(30);
  });
});

describe('line-height', () => {
  it('inherits a NUMBER as a number, so each descendant scales its own size', () => {
    const s = style('<div style="font-size:10px;line-height:1.5">'
      + '<p id=t style="font-size:20px">x</p></div>', 't');
    expect(s.lineHeight).toEqual({ number: 1.5 });
  });

  it('inherits a PERCENTAGE as the px it computed to on the ANCESTOR', () => {
    // The distinction. 150% of the div's 10px is 15px, and the child keeps
    // 15px rather than recomputing 150% of its own 20px.
    const s = style('<div style="font-size:10px;line-height:150%">'
      + '<p id=t style="font-size:20px">x</p></div>', 't');
    expect(s.lineHeight).toEqual({ px: 15 });
  });
});

describe('currentColor', () => {
  it('resolves against the element OWN computed colour', () => {
    const s = style('<p id=t style="color:red;border-top-color:currentColor">x</p>', 't');
    expect(s.borderTopColor).toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('resolves the INITIAL of a border colour the same way', () => {
    // border-*-color's initial IS currentColor, so the same rule must reach a
    // property nobody declared.
    expect(style('<p id=t style="color:red">x</p>', 't').borderTopColor)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });

  it('uses the INHERITED colour when the element sets none', () => {
    expect(style('<div style="color:red"><p id=t>x</p></div>', 't').borderTopColor)
      .toEqual({ rgb: [1, 0, 0], a: 1 });
  });
});

describe('percentages that stay percentages', () => {
  it('keeps a percentage margin, padding and width unresolved', () => {
    const s = style('<p id=t style="margin-left:10%;padding-top:5%;width:50%">x</p>', 't');
    expect(s.marginLeft).toEqual({ px: 0, pct: 10 });
    expect(s.paddingTop).toEqual({ px: 0, pct: 5 });
    expect(s.width).toEqual({ px: 0, pct: 50 });
  });
});

describe('font-weight relative keywords', () => {
  it('resolves bolder and lighter against the parent computed weight', () => {
    expect(style('<div style="font-weight:400">'
      + '<p id=t style="font-weight:bolder">x</p></div>', 't').fontWeight).toBe(700);
    expect(style('<div style="font-weight:700">'
      + '<p id=t style="font-weight:lighter">x</p></div>', 't').fontWeight).toBe(400);
  });
});

describe('the UA sheet reaches the output', () => {
  it('gives h1 its size and weight', () => {
    const s = style('<!doctype html><h1 id=t>x</h1>', 't');
    expect(s.fontSize).toBe(32);              // 2em of the 16px base
    expect(s.fontWeight).toBe(700);
    expect(s.display).toBe('block');
  });

  it('gives li display:list-item and head display:none', () => {
    expect(style('<!doctype html><ul><li id=t>x</li></ul>', 't').display).toBe('list-item');
    const doc = parseHtml('<!doctype html><title>x</title><p>y</p>');
    const head = elementsOf(doc).find((e) => e.name === 'head') as HtmlElement;
    expect(computeStyles(doc).styles.get(head)?.display).toBe('none');
  });
});

describe('reporting', () => {
  it('records an unparsable value and leaves the property at its cascade fallback', () => {
    const doc = parseHtml('<p id=t style="color:notacolour">x</p>');
    const r = computeStyles(doc);
    const el = elementsOf(doc).find((e) => e.attrs.get('id') === 't') as HtmlElement;
    expect(r.styles.get(el)?.color).toEqual({ rgb: [0, 0, 0], a: 1 });
    expect(r.unsupported.some(
      (u) => u.property === 'color' && u.reason === 'unparsable-value')).toBe(true);
  });

  it('carries the collection unsupported list through', () => {
    const r = computeStyles(parseHtml('<style>p{box-shadow:0 0 2px}</style>'));
    expect(r.unsupported.some((u) => u.property === 'box-shadow')).toBe(true);
  });

  it('never throws, on any document', () => {
    for (const s of ['', '<p>x</p>', '<p style="color">x</p>',
      '<style>p{font-size:-5px}</style><p>x</p>', '<template><b>x</b></template>']) {
      expect(() => computeStyles(parseHtml(s)), s).not.toThrow();
    }
  });
});

/** The computed style AND the unsupported report for a source. */
function run(src: string, id: string) {
  const doc = parseHtml(src);
  const r = computeStyles(doc);
  const el = elementsOf(doc).find((e) => e.attrs.get('id') === id) as HtmlElement;
  return { style: r.styles.get(el) as ComputedStyle, unsupported: r.unsupported };
}

const RED = { rgb: [1, 0, 0], a: 1 };
const GREEN = { rgb: [0, 128 / 255, 0], a: 1 };

describe('var() at computed-value time', () => {
  it('resolves a var() against a custom property on the same element', () => {
    expect(style('<p id=t style="--c:red;color:var(--c)">x</p>', 't').color)
      .toEqual(RED);
  });

  it('inherits a custom property from an ancestor (#6)', () => {
    expect(style('<div style="--c:red"><p id=t style="color:var(--c)">x</p></div>', 't')
      .color).toEqual(RED);
  });

  it('resolves a var() in font-size, which computes FIRST', () => {
    // The environment has to be built before font-size or this silently
    // falls back to the inherited size.
    expect(style('<p id=t style="--fs:24px;font-size:var(--fs)">x</p>', 't').fontSize)
      .toBe(24);
  });

  it('resolves a var() inside calc() (#11)', () => {
    expect(style('<div id=t style="--w:10px;margin-top:calc(var(--w) * 2)">x</div>', 't')
      .marginTop).toEqual({ px: 20, pct: 0 });
  });

  it('uses the fallback for an undefined property (#2)', () => {
    expect(style('<p id=t style="color:var(--nope, red)">x</p>', 't').color).toEqual(RED);
  });

  it('does NOT use the fallback when the substituted value fails the property (#1)', () => {
    // THE trap. --x resolves fine, `color: 10px` then fails, and the property
    // falls back to INHERITED green rather than to the fallback red. Both
    // readings render a perfectly plausible page.
    const src = '<div style="color:green"><p id=t style="--x:10px;color:var(--x, red)">x</p></div>';
    expect(style(src, 't').color).toEqual(GREEN);
  });

  it('IACVT on an inherited property inherits (#14)', () => {
    const src = '<div style="color:red"><p id=t style="color:var(--nope)">x</p></div>';
    expect(style(src, 't').color).toEqual(RED);
  });

  it('IACVT on a non-inherited property takes the INITIAL, not the parent (#15)', () => {
    const src = '<div style="margin-top:40px"><div id=t style="margin-top:var(--nope)">x</div></div>';
    expect(style(src, 't').marginTop).toEqual({ px: 0, pct: 0 });
  });

  it('expands a shorthand carrying a var() (#7)', () => {
    const s = style('<p id=t style="--c:red;border:2px solid var(--c)">x</p>', 't');
    expect(s.borderTopWidth).toBe(2);
    expect(s.borderTopStyle).toBe('solid');
    expect(s.borderTopColor).toEqual(RED);
  });

  it('reports an undefined var, so a caller can act on it', () => {
    const { unsupported } = run('<p id=t style="color:var(--nope)">x</p>', 't');
    expect(unsupported.some(
      (u) => u.property === 'color' && u.reason === 'undefined-var')).toBe(true);
  });

  it('reports a cycle as a cycle rather than as an unparsable value', () => {
    const { unsupported } = run(
      '<p id=t style="--a:var(--b);--b:var(--a);color:var(--a)">x</p>', 't');
    expect(unsupported.some((u) => u.reason === 'var-cycle')).toBe(true);
  });

  it('does NOT treat a SUBSTITUTED css-wide keyword as a keyword', () => {
    // Measured against Chrome: `--x: initial; color: var(--x)` computes to
    // the INHERITED colour, not to color's initial black. So a keyword that
    // arrives by substitution is not a keyword — the declaration is invalid
    // at computed-value time instead. Checking cssWideOf on the substituted
    // value gets `inherit` right by luck and `initial` wrong, which is why
    // the keyword test reads the RAW value.
    const src = '<div style="color:red"><p id=t style="--x:initial;color:var(--x)">x</p></div>';
    expect(style(src, 't').color).toEqual(RED);
  });

  it('still honours a REAL css-wide keyword, which has no var in it', () => {
    const src = '<div style="color:red"><p id=t style="color:initial">x</p></div>';
    expect(style(src, 't').color).not.toEqual(RED);
  });

  it('does not let an invalid custom property poison the element (#24)', () => {
    expect(style('<p id=t style="--junk:var(--nope);color:red">x</p>', 't').color)
      .toEqual(RED);
  });
});
