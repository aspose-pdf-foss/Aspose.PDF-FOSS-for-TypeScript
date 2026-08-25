import { describe, it, expect } from 'vitest';
import {
  parseBlocks, parseSelector, specificity, splitSelectorList, matches,
  parseStylesheet, resolveAll, collectStyleText,
} from '../src/svgcss.js';
import { parseXml, type XmlNode } from '../src/xml.js';

const xml = (s: string) => new TextEncoder().encode(s);
const spec = (s: string) => specificity(parseSelector(s)!);

const props = (css: string) =>
  parseBlocks(css).rules.map((r) => ({
    sel: r.selector,
    decls: r.decls.map((d) => `${d.prop}=${d.value}${d.important ? '!' : ''}`),
  }));

describe('svgcss — block parsing', () => {
  it('parses a rule into a selector and declarations', () => {
    expect(props('.a { fill: red; stroke: blue }'))
      .toEqual([{ sel: '.a', decls: ['fill=red', 'stroke=blue'] }]);
  });

  it('lower-cases property names but not values', () => {
    expect(props('.a { FILL: Red }')).toEqual([{ sel: '.a', decls: ['fill=Red'] }]);
  });

  it('records !important separately from the value', () => {
    expect(props('.a { fill: red !important }'))
      .toEqual([{ sel: '.a', decls: ['fill=red!'] }]);
  });

  it('strips comments, including one containing a brace', () => {
    // The comment must go first, or the brace inside it closes the rule early.
    expect(props('.a { fill: red /* } not a brace */ ; stroke: blue }'))
      .toEqual([{ sel: '.a', decls: ['fill=red', 'stroke=blue'] }]);
  });

  it('ignores a declaration with no colon without killing its neighbours', () => {
    expect(props('.a { fill: red; garbage; stroke: blue }'))
      .toEqual([{ sel: '.a', decls: ['fill=red', 'stroke=blue'] }]);
  });

  it('skips @import up to its semicolon', () => {
    const r = parseBlocks('@import url(x.css); .a { fill: red }');
    expect(r.rules.map((x) => x.selector)).toEqual(['.a']);
    expect(r.dropped).toBe(true);
  });

  it('skips @media and @font-face with brace balancing', () => {
    const r = parseBlocks(
      '@media print { .a { fill: red } } @font-face { font-family: X } .b { fill: blue }');
    expect(r.rules.map((x) => x.selector)).toEqual(['.b']);
    expect(r.dropped).toBe(true);
  });

  it('reports nothing dropped for a clean stylesheet', () => {
    expect(parseBlocks('.a { fill: red }').dropped).toBe(false);
  });

  it('tolerates an unterminated final rule', () => {
    expect(props('.a { fill: red')).toEqual([{ sel: '.a', decls: ['fill=red'] }]);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(parseBlocks('').rules).toEqual([]);
    expect(parseBlocks('   \n  ').rules).toEqual([]);
  });
});

describe('svgcss — selector parsing', () => {
  it('parses each simple selector kind', () => {
    expect(parseSelector('rect')!.parts).toEqual([{ type: 'rect', classes: [] }]);
    expect(parseSelector('.a')!.parts).toEqual([{ classes: ['a'] }]);
    expect(parseSelector('#x')!.parts).toEqual([{ id: 'x', classes: [] }]);
    expect(parseSelector('*')!.parts).toEqual([{ classes: [] }]);
  });

  it('parses a compound of type, id and several classes', () => {
    expect(parseSelector('rect#x.a.b')!.parts)
      .toEqual([{ type: 'rect', id: 'x', classes: ['a', 'b'] }]);
  });

  it('records descendant and child combinators between compounds', () => {
    const d = parseSelector('g .a')!;
    expect(d.parts.length).toBe(2);
    expect(d.combinators).toEqual(['descendant']);
    const c = parseSelector('g > rect')!;
    expect(c.combinators).toEqual(['child']);
    expect(parseSelector('g>rect')!.combinators).toEqual(['child']);
  });

  it('splits a selector list on top-level commas', () => {
    expect(splitSelectorList('.a, #b , rect')).toEqual(['.a', '#b', 'rect']);
  });

  it('rejects selector syntax it does not support', () => {
    expect(parseSelector('[fill]')).toBe(null);
    expect(parseSelector('a:first-child')).toBe(null);
    expect(parseSelector('a + b')).toBe(null);
    expect(parseSelector('a ~ b')).toBe(null);
    expect(parseSelector('')).toBe(null);
    expect(parseSelector('g >')).toBe(null);
  });

  it('counts specificity as ids, classes, then types', () => {
    expect(spec('#x')).toBeGreaterThan(spec('.a'));
    expect(spec('.a')).toBeGreaterThan(spec('rect'));
    expect(spec('rect')).toBeGreaterThan(spec('*'));
    expect(spec('*')).toBe(0);
  });

  it('adds specificity across a combinator', () => {
    expect(spec('g .a')).toBeGreaterThan(spec('.a'));
    expect(spec('.a.b')).toBeGreaterThan(spec('.a'));
  });

  it('does not let 100 types outrank one class', () => {
    expect(spec('.a')).toBeGreaterThan(spec('g g g g g g g g g g'));
  });
});

/** Find the first element named `name`, with its ancestor chain. */
function find(src: string, name: string): { node: XmlNode; ancestors: XmlNode[] } {
  const root = parseXml(xml(src));
  const stack: XmlNode[] = [];
  let hit: { node: XmlNode; ancestors: XmlNode[] } | null = null;
  const walk = (n: XmlNode): void => {
    if (!hit && n.name === name) hit = { node: n, ancestors: [...stack] };
    stack.push(n);
    for (const c of n.children) walk(c);
    stack.pop();
  };
  walk(root);
  return hit!;
}

const hits = (src: string, sel: string, target = 'rect') => {
  const { node, ancestors } = find(src, target);
  return matches(parseSelector(sel)!, node, ancestors);
};

describe('svgcss — matching', () => {
  const DOC = '<svg><g class="outer"><g id="mid"><rect class="a b"/></g></g></svg>';

  it('matches by type, class, id and universal', () => {
    expect(hits(DOC, 'rect')).toBe(true);
    expect(hits(DOC, '.a')).toBe(true);
    expect(hits(DOC, '*')).toBe(true);
    expect(hits('<svg><rect id="x"/></svg>', '#x')).toBe(true);
  });

  it('requires every class in a compound', () => {
    expect(hits(DOC, '.a.b')).toBe(true);
    expect(hits(DOC, '.a.c')).toBe(false);
  });

  it('matches case-sensitively, because SVG is XML', () => {
    expect(hits(DOC, 'RECT')).toBe(false);
    expect(hits(DOC, '.A')).toBe(false);
  });

  it('matches a descendant at any depth', () => {
    expect(hits(DOC, '.outer rect')).toBe(true);
    expect(hits(DOC, 'svg rect')).toBe(true);
  });

  it('matches a child only at depth one', () => {
    expect(hits(DOC, '#mid > rect')).toBe(true);
    expect(hits(DOC, '.outer > rect')).toBe(false);
  });

  it('backtracks over descendant candidates', () => {
    // The NEAREST g matching the middle compound has no .outer above it; a
    // further one does. Taking only the nearest candidate fails this.
    const src = '<svg><g class="outer"><g><g><rect/></g></g></g></svg>';
    expect(hits(src, '.outer g rect')).toBe(true);
  });

  it('rejects when an ancestor compound is absent', () => {
    expect(hits(DOC, '.nosuch rect')).toBe(false);
  });

  it('matches a single-compound selector against the root itself', () => {
    const { node, ancestors } = find('<svg/>', 'svg');
    expect(matches(parseSelector('svg')!, node, ancestors)).toBe(true);
  });
});

/** Resolved declarations for the first element named `name`. The node must come
 *  from the SAME parse as the map, since the map is keyed by node identity. */
function declsFor(src: string, name: string) {
  const root = parseXml(xml(src));
  const { css } = collectStyleText(root);
  const map = resolveAll(root, parseStylesheet(css));
  let hit: XmlNode | null = null;
  const walk = (n: XmlNode): void => {
    if (!hit && n.name === name) hit = n;
    for (const c of n.children) walk(c);
  };
  walk(root);
  return map.get(hit!) ?? { normal: new Map(), important: new Map() };
}

describe('svgcss — the pre-pass', () => {
  it('collects style text from anywhere, including defs and CDATA', () => {
    const root = parseXml(xml('<svg><defs><style><![CDATA[.a{fill:red}]]></style></defs>' +
      '<style>.b{fill:blue}</style></svg>'));
    const { css } = collectStyleText(root);
    expect(css).toContain('.a{fill:red}');
    expect(css).toContain('.b{fill:blue}');
  });

  it('flags a style element whose type is not text/css', () => {
    const root = parseXml(xml('<svg><style type="text/plain">.a{fill:red}</style></svg>'));
    expect(collectStyleText(root).badType).toBe(true);
    expect(collectStyleText(root).css).toBe('');
  });

  it('accepts an absent or text/css type', () => {
    const a = parseXml(xml('<svg><style type="text/css">.a{fill:red}</style></svg>'));
    expect(collectStyleText(a).badType).toBe(false);
    expect(collectStyleText(a).css).toContain('.a');
  });

  it('applies a matching rule to the element', () => {
    const d = declsFor('<svg><style>.a{fill:red}</style><rect class="a"/></svg>', 'rect');
    expect(d.normal.get('fill')).toBe('red');
  });

  it('applies a rule declared AFTER the element it styles', () => {
    const d = declsFor('<svg><rect class="a"/><style>.a{fill:red}</style></svg>', 'rect');
    expect(d.normal.get('fill')).toBe('red');
  });

  it('lets higher specificity win regardless of order', () => {
    const d = declsFor('<svg><style>#x{fill:red} .a{fill:blue}</style>' +
      '<rect id="x" class="a"/></svg>', 'rect');
    expect(d.normal.get('fill')).toBe('red');
  });

  it('breaks a specificity tie by source order', () => {
    const d = declsFor('<svg><style>.a{fill:red} .b{fill:blue}</style>' +
      '<rect class="a b"/></svg>', 'rect');
    expect(d.normal.get('fill')).toBe('blue');
  });

  it("scores a grouped selector's branches independently", () => {
    // If `.a, #b` collapsed to one rule at the id's specificity, .a would beat
    // the later #c and fill red.
    const d = declsFor('<svg><style>.a, #b { fill: red } #c { fill: blue }</style>' +
      '<rect class="a" id="c"/></svg>', 'rect');
    expect(d.normal.get('fill')).toBe('blue');
  });

  it('keeps important declarations in their own map', () => {
    const d = declsFor('<svg><style>.a{fill:red !important; stroke:blue}</style>' +
      '<rect class="a"/></svg>', 'rect');
    expect(d.important.get('fill')).toBe('red');
    expect(d.normal.get('stroke')).toBe('blue');
    expect(d.normal.has('fill')).toBe(false);
  });

  it('drops a whole rule whose selector will not parse', () => {
    const sheet = parseStylesheet('.a:hover { fill: red } .a { stroke: blue }');
    expect(sheet.rules.length).toBe(1);
    expect(sheet.dropped).toBe(true);
  });

  it('resolves stop elements inside defs', () => {
    const d = declsFor('<svg><style>.s{stop-color:red}</style><defs><linearGradient>' +
      '<stop class="s"/></linearGradient></defs></svg>', 'stop');
    expect(d.normal.get('stop-color')).toBe('red');
  });
});
