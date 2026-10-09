import { describe, it, expect } from 'vitest';
import { layoutPage, type LayoutNode, type Placed } from '../src/xfaflow.js';
import type { XfaRawGeom } from '../src/xfageom.js';

/** A field leaf; its label doubles as its SOM name. */
const fld = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'field', label, field: label, geom, children: [], ...extra });
const drw = (label: string, geom: XfaRawGeom, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'draw', label, geom, children: [], ...extra });
const sub = (
  label: string, layout: string, geom: XfaRawGeom, children: LayoutNode[],
  extra: Partial<LayoutNode> = {},
): LayoutNode => ({ kind: 'subform', label, layout, geom, children, ...extra });
// A contentArea of ample height, so a flowed page subform is bounded; the
// page-root cases state their own geometry.
const page = (children: LayoutNode[], geom: XfaRawGeom = { h: '10000pt' }): LayoutNode =>
  ({ kind: 'page', label: 'contentArea', layout: 'position', geom, children });

const box = (m: Map<string, Placed>, n: string) => {
  const p = m.get(n);
  if (p === undefined) throw new Error(`${n}: no result`);
  if ('reason' in p) throw new Error(`${n}: ${p.reason}`);
  return p.box;
};
const why = (m: Map<string, Placed>, n: string): string => {
  const p = m.get(n);
  if (p === undefined) throw new Error(`${n}: no result`);
  if ('box' in p) throw new Error(`${n}: placed at ${JSON.stringify(p.box)}`);
  return p.reason;
};
const S = { w: '10pt', h: '10pt' };

describe('layoutPage: positioned layout', () => {
  // Three deep with a non-zero offset at EACH level: "accumulate the immediate
  // parent only" is invisible with fewer. Moved here from accumulateOrigin.
  it('sums every level of the chain, the contentArea included', () => {
    const m = layoutPage(page([
      sub('P', 'position', { x: '0.25in', y: '0.5in' }, [
        sub('A', 'position', { x: '1in', y: '2in' }, [
          fld('f', { x: '10pt', y: '20pt', w: '1in', h: '1in' }),
        ]),
      ]),
    ], { x: '5pt', y: '6pt' }));
    expect(box(m, 'f')).toEqual({ x: 105, y: 206, w: 72, h: 72 });
  });

  it('reads an absent x or y as zero, at the field and at a container', () => {
    const m = layoutPage(page([sub('P', 'position', { y: '1in' }, [fld('f', { w: '1in', h: '1in' })])]));
    expect(box(m, 'f')).toEqual({ x: 0, y: 72, w: 72, h: 72 });
  });

  // XFA 3.3 Appendix A (p. 1510): Px = Cx + Mx + Ox -- a container's margin
  // insets shift its positioned children.
  it('shifts positioned children by the container margin', () => {
    const m = layoutPage(page([sub('P', 'position', { x: '100pt', y: '100pt' }, [
      fld('f', { x: '1pt', y: '2pt', ...S }),
    ], { margin: { leftInset: '5pt', topInset: '7pt' } })]));
    expect(box(m, 'f')).toEqual({ x: 106, y: 109, w: 10, h: 10 });
  });

  it('applies the field anchor shift', () => {
    const m = layoutPage(page([fld('f', { x: '1in', y: '1in', w: '2in', h: '1in', anchorType: 'middleCenter' })]));
    expect(box(m, 'f')).toEqual({ x: 0, y: 36, w: 144, h: 72 });
  });

  // New with the engine: a CONTAINER's anchor is applied too, against its
  // stated size or, when growable, its content extent.
  it('applies a container anchor shift, sized or growable', () => {
    const fixed = layoutPage(page([sub('P', 'position',
      { x: '200pt', y: '100pt', w: '100pt', h: '50pt', anchorType: 'bottomRight' },
      [fld('f', { ...S })])]));
    expect(box(fixed, 'f')).toEqual({ x: 100, y: 50, w: 10, h: 10 });
    const grown = layoutPage(page([sub('P', 'position',
      { x: '100pt', y: '100pt', anchorType: 'middleCenter' },
      [fld('f', { w: '40pt', h: '20pt' })])]));
    expect(box(grown, 'f')).toEqual({ x: 80, y: 90, w: 40, h: 20 });
  });

  it('refuses a rotate, an unreadable measure, a bad anchor and an absent size, each by name', () => {
    const m = layoutPage(page([
      fld('rot', { ...S, rotate: '90' }),
      fld('px', { w: '1px', h: '10pt' }),
      fld('anc', { ...S, anchorType: 'centre' }),
      fld('noH', { w: '10pt' }),
      fld('noW', { h: '10pt' }),
      fld('emptyX', { x: '', ...S }),
    ]));
    expect(why(m, 'rot')).toMatch(/rotate="90"/);
    expect(why(m, 'px')).toMatch(/w="1px" could not be read/);
    expect(why(m, 'anc')).toMatch(/anchorType="centre"/);
    expect(why(m, 'noH')).toMatch(/states no h.*164g\.7/);
    expect(why(m, 'noW')).toMatch(/states no w.*164g\.7/);
    expect(why(m, 'emptyX')).toMatch(/x="" could not be read/);
  });

  it('accepts rotate="0", which is not a rotation', () => {
    expect(box(layoutPage(page([fld('f', { ...S, rotate: '0' })])), 'f'))
      .toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  // In positioned layout a failure is local: the sibling's place does not
  // depend on it.
  it('keeps a positioned failure to itself', () => {
    const m = layoutPage(page([fld('bad', { w: '10pt' }), fld('ok', { x: '5pt', ...S })]));
    expect(why(m, 'bad')).toBeTruthy();
    expect(box(m, 'ok')).toEqual({ x: 5, y: 0, w: 10, h: 10 });
  });

  it('refuses a node carrying a refusal, and an unknown layout', () => {
    const m = layoutPage(page([
      sub('R', 'tb', {}, [fld('a', S)], { refusal: 'R: a repeating page subform needs page breaking (164g.3)' }),
      sub('U', 'rl-tb', {}, [fld('b', S)]),
    ]));
    expect(why(m, 'a')).toMatch(/needs page breaking \(164g\.3\)/);
    expect(why(m, 'b')).toMatch(/layout="rl-tb" is not laid out/);
  });

  it('knows nothing of a synthetic occur layout (164g.2)', () => {
    const m = layoutPage(page([sub('R', 'occur', {}, [fld('a', S)])]));
    expect(why(m, 'a')).toMatch(/layout="occur" is not laid out/);
  });
});

describe('layoutPage: presence', () => {
  it('gives a hidden or inactive field no box, and an invisible one its place', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('h', S, { presence: 'hidden' }),
      fld('i', S, { presence: 'inactive' }),
      fld('v', S, { presence: 'invisible' }),
      fld('after', S),
    ])]));
    expect(why(m, 'h')).toBe('presence="hidden" takes no space in the layout');
    expect(why(m, 'i')).toBe('presence="inactive" takes no space in the layout');
    expect(box(m, 'v')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    // The hidden two took no space; the invisible one did.
    expect(box(m, 'after')).toEqual({ x: 0, y: 10, w: 10, h: 10 });
  });

  it('conceals everything inside a hidden container', () => {
    const m = layoutPage(page([sub('H', 'position', {}, [fld('f', S)], { presence: 'hidden' })]));
    expect(why(m, 'f')).toMatch(/presence="hidden"/);
  });
});

describe('layoutPage: tb', () => {
  // XFA 3.3 p. 280: each child "immediately below the nominal extent of the
  // previous ... aligned with the left edge". A draw takes up space too.
  it('stacks children at the left edge, draws included', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', { w: '50pt', h: '10pt' }),
      fld('b', { w: '30pt', h: '20pt' }),
      drw('d', { w: '10pt', h: '5pt' }),
      fld('c', { ...S }),
    ])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 50, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 0, y: 10, w: 30, h: 20 });
    expect(box(m, 'c')).toEqual({ x: 0, y: 35, w: 10, h: 10 });
  });

  // p. 280: a flowed child's x, y and anchor point are ignored.
  it('ignores a flowed child x, y and anchor', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', { x: '100pt', y: '100pt', ...S, anchorType: 'bottomRight' }),
    ])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });

  it('starts inside the container margin', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [fld('a', S)],
      { margin: { leftInset: '3pt', topInset: '4pt' } })]));
    expect(box(m, 'a')).toEqual({ x: 3, y: 4, w: 10, h: 10 });
  });

  // Review Focus 3: an unsizable draw breaks the flow, and the reason names it.
  it('refuses an unsizable item and every later sibling, naming the cause', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      fld('a', S), drw('d', { w: '10pt' }), fld('b', S), fld('c', S),
    ])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(why(m, 'b')).toMatch(/^an earlier item in its flow could not be laid out \(d: states no h/);
    expect(why(m, 'c')).toMatch(/\(d: states no h/);
  });

  // Review Focus 2: an unnamed field produces nothing but takes its space.
  it('lets an unnamed field take its space', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      { kind: 'field', label: '<field>', geom: { ...S }, children: [] },
      fld('b', S),
    ])]));
    expect(m.size).toBe(1);
    expect(box(m, 'b').y).toBe(10);
  });

  // p. 275-276: a growable container's extent is its content plus margins.
  it('sizes a growable container from its children plus its margins', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })],
        { margin: { topInset: '2pt', bottomInset: '3pt' } }),
      fld('b', S),
    ])]));
    expect(box(m, 'a').y).toBe(2);
    expect(box(m, 'b').y).toBe(35);
  });

  it('raises a growable extent to minH, honours maxH="0" as none, and refuses content past maxH', () => {
    const grown = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { minH: '50pt' } }),
      fld('b', S),
    ])]));
    expect(box(grown, 'b').y).toBe(50);
    const zero = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { maxH: '0' } }),
      fld('b', S),
    ])]));
    expect(box(zero, 'b').y).toBe(30);
    const clipped = layoutPage(page([sub('T', 'tb', {}, [
      sub('G', 'tb', {}, [fld('a', { w: '10pt', h: '30pt' })], { minMax: { maxH: '20pt' } }),
      fld('b', S),
    ])]));
    expect(why(clipped, 'b')).toMatch(/exceeds maxH/);
  });

  it('refuses a child that would not fit a fixed-height container', () => {
    const m = layoutPage(page([sub('T', 'tb', { h: '25pt' }, [fld('a', S), fld('b', S), fld('c', S)])]));
    expect(box(m, 'b').y).toBe(10);
    expect(why(m, 'c')).toMatch(/splitting \(164g\.3\)/);
  });

  it('refuses a flowed child that states a non-left hAlign, and a row outside a table', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [sub('R', 'tb', {}, [fld('a', S)], { hAlign: 'right' })]),
      sub('U', 'tb', {}, [sub('W', 'row', {}, [fld('b', S)])])]));
    expect(why(m, 'a')).toMatch(/hAlign="right"/);
    expect(why(m, 'b')).toMatch(/layout="row" outside a table/);
  });
});

describe('layoutPage: lr-tb', () => {
  it('lays a container with no stated w on one line', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '10pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect([box(m, 'a').x, box(m, 'b').x, box(m, 'c').x]).toEqual([0, 10, 30]);
    expect(box(m, 'c').y).toBe(0);
  });

  // p. 281: "immediately to the right ... or if this fails immediately below
  // it aligned with the left edge".
  it('wraps to the left edge when the next child does not fit', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '10pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect(box(m, 'c')).toEqual({ x: 0, y: 10, w: 30, h: 10 });
  });

  it('wraps against the width inside the container margins', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '40pt' }, [
      fld('a', { w: '20pt', h: '10pt' }), fld('b', { w: '20pt', h: '10pt' }),
    ], { margin: { leftInset: '2pt', rightInset: '2pt' } })]));
    expect(box(m, 'b')).toEqual({ x: 2, y: 10, w: 20, h: 10 });
  });

  it('puts an over-wide child alone on its own line', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '50pt', h: '10pt' }), fld('c', { w: '10pt', h: '10pt' }),
    ])]));
    expect(box(m, 'b')).toEqual({ x: 0, y: 10, w: 50, h: 10 });
    expect(box(m, 'c')).toEqual({ x: 0, y: 20, w: 10, h: 10 });
  });

  it('top-aligns a single line of mixed heights', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '10pt', h: '30pt' }),
    ])]));
    expect(box(m, 'a').y).toBe(0);
    expect(box(m, 'b').y).toBe(0);
  });

  // The spec's "immediately below it" does not say below what when the line's
  // heights differ, so that wrap refuses rather than picks.
  it('refuses a wrap after a line of mixed heights', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', { w: '35pt' }, [
      fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '20pt' }), fld('c', { w: '30pt', h: '10pt' }),
    ])]));
    expect(why(m, 'c')).toMatch(/mixed heights/);
  });

  it('sizes a growable lr-tb as its line: summed widths, tallest height', () => {
    const m = layoutPage(page([sub('T', 'tb', {}, [
      sub('L', 'lr-tb', {}, [fld('a', { w: '10pt', h: '10pt' }), fld('b', { w: '20pt', h: '15pt' })]),
      fld('c', S),
    ])]));
    expect(box(m, 'c').y).toBe(15);
  });
});

describe('layoutPage: the page root', () => {
  it('bounds a flowed page subform by the contentArea height', () => {
    const fits = layoutPage(page([sub('P', 'tb', {}, [fld('a', S), fld('b', S)])],
      { x: '36pt', y: '36pt', w: '540pt', h: '20pt' }));
    expect(box(fits, 'b')).toEqual({ x: 36, y: 46, w: 10, h: 10 });
    const over = layoutPage(page([sub('P', 'tb', {}, [fld('a', S), fld('b', S)])],
      { w: '540pt', h: '15pt' }));
    expect(why(over, 'a')).toMatch(/overflows its contentArea.*164g\.3/);
  });

  // A subform whose flow broke part-way is bounded by what DID place: the
  // break must not let a placed box past the contentArea.
  it('bounds a broken flow by the items that placed', () => {
    const items = () => [fld('a', S), fld('b', S), drw('d', { w: '10pt' }), fld('c', S)];
    const fits = layoutPage(page([sub('P', 'tb', {}, items())], { w: '540pt', h: '20pt' }));
    expect(box(fits, 'b').y).toBe(10);
    expect(why(fits, 'c')).toMatch(/\(d: states no h/);
    const over = layoutPage(page([sub('P', 'tb', {}, items())], { w: '540pt', h: '15pt' }));
    expect(why(over, 'a')).toMatch(/overflows its contentArea/);
  });

  it('refuses a flowed page subform when the contentArea states no height', () => {
    const m = layoutPage(page([sub('P', 'tb', {}, [fld('a', S)])], {}));
    expect(why(m, 'a')).toMatch(/uses layout="tb" and its pageArea declares no contentArea height/);
  });
});

/** A row of cells. */
const row = (label: string, cells: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  sub(label, 'row', {}, cells, extra);
const table = (cols: string | undefined, rows: LayoutNode[], geom: XfaRawGeom = {}): LayoutNode =>
  sub('T', 'table', geom, rows, cols === undefined ? {} : { columnWidths: cols });
const H = (h: number, extra: XfaRawGeom = {}): XfaRawGeom => ({ h: `${String(h)}pt`, ...extra });

describe('layoutPage: tables', () => {
  // XFA 3.3 p. 329: rows stacked top to bottom, each cell expanded to its
  // column's designated width.
  it('places cells by column width and rows top to bottom', () => {
    const m = layoutPage(page([table('20pt 30pt', [
      row('r1', [fld('a', H(10)), fld('b', H(10))]),
      row('r2', [fld('c', H(12)), fld('d', H(12))]),
    ], { x: '100pt', y: '50pt' })]));
    expect(box(m, 'a')).toEqual({ x: 100, y: 50, w: 20, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 120, y: 50, w: 30, h: 10 });
    expect(box(m, 'c')).toEqual({ x: 100, y: 60, w: 20, h: 12 });
    expect(box(m, 'd')).toEqual({ x: 120, y: 60, w: 30, h: 12 });
  });

  it('ignores a cell own stated width', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', H(10, { w: '5pt' }))])])]));
    expect(box(m, 'a').w).toBe(20);
  });

  // p. 329: "For each row it expands the cells vertically to the height of the
  // tallest cell in the row."
  it('expands every cell in a row to its tallest cell', () => {
    const m = layoutPage(page([table('20pt 20pt', [row('r', [fld('a', H(10)), fld('b', H(16))])])]));
    expect(box(m, 'a').h).toBe(16);
  });

  it('keeps a positioned cell subform children at their offsets inside the cell', () => {
    const m = layoutPage(page([table('20pt 30pt', [row('r', [
      drw('d', H(10)),
      sub('C', 'position', H(10), [fld('f', { x: '2pt', y: '3pt', w: '5pt', h: '5pt' })]),
    ])])]));
    expect(box(m, 'f')).toEqual({ x: 22, y: 3, w: 5, h: 5 });
  });

  it('sizes a -1 column to its widest single-column cell', () => {
    const m = layoutPage(page([table('-1 30pt', [
      row('r1', [fld('a', H(10, { w: '15pt' })), fld('b', H(10))]),
      row('r2', [fld('c', H(10, { w: '25pt' })), fld('d', H(10))]),
    ])]));
    expect(box(m, 'a').w).toBe(25);
    expect(box(m, 'b').x).toBe(25);
  });

  // Review Focus 4: columns past the list default to -1 (p. 327).
  it('auto-sizes the columns past the end of columnWidths', () => {
    const m = layoutPage(page([table('20pt', [
      row('r1', [fld('a', H(10)), fld('b', H(10, { w: '40pt' }))]),
      row('r2', [fld('c', H(10)), fld('d', H(10, { w: '50pt' }))]),
    ])]));
    expect(box(m, 'b')).toEqual({ x: 20, y: 0, w: 50, h: 10 });
  });

  it('refuses a -1 column that no single-column cell with a stated width can size', () => {
    const m = layoutPage(page([table('-1', [row('r', [fld('a', H(10))])])]));
    expect(why(m, 'a')).toMatch(/column 1 has width -1/);
  });

  // p. 330: colSpan sums columns; -1 spans the rest and later cells are not
  // displayed; 0 is not allowed.
  it('spans columns', () => {
    const m = layoutPage(page([table('10pt 20pt 30pt', [row('r', [
      fld('a', H(10, { }), { colSpan: '2' }), fld('b', H(10)),
    ])])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 30, h: 10 });
    expect(box(m, 'b')).toEqual({ x: 30, y: 0, w: 30, h: 10 });
  });

  it('spans the rest for colSpan="-1" and does not display the cells after it', () => {
    const m = layoutPage(page([table('10pt 20pt 30pt', [row('r', [
      fld('a', H(10)), fld('b', H(10), { colSpan: '-1' }), fld('c', H(10)),
    ])])]));
    expect(box(m, 'b')).toEqual({ x: 10, y: 0, w: 50, h: 10 });
    expect(why(m, 'c')).toMatch(/follows a colSpan="-1" cell/);
  });

  it('refuses colSpan="0" and every later row', () => {
    const m = layoutPage(page([table('10pt', [
      row('r1', [fld('a', H(10), { colSpan: '0' })]),
      row('r2', [fld('b', H(10))]),
    ])]));
    expect(why(m, 'a')).toMatch(/colSpan="0"/);
    expect(why(m, 'b')).toMatch(/an earlier item/);
  });

  // p. 329: a short row leaves an empty region on its right; the table is as
  // wide as all its columns.
  it('gives a short row only its own cells and the table its full width', () => {
    const m = layoutPage(page([sub('L', 'lr-tb', {}, [
      table('10pt 20pt', [row('r1', [fld('a', H(10)), fld('b', H(10))]), row('r2', [fld('c', H(5))])]),
      fld('after', H(10, { w: '10pt' })),
    ])]));
    expect(box(m, 'c')).toEqual({ x: 0, y: 10, w: 10, h: 5 });
    expect(box(m, 'after').x).toBe(30);
  });

  it('sizes a growable table as the sum of its rows', () => {
    const m = layoutPage(page([sub('S', 'tb', {}, [
      table('10pt', [row('r1', [fld('a', H(10))]), row('r2', [fld('b', H(7))])]),
      fld('after', H(10, { w: '10pt' })),
    ])]));
    expect(box(m, 'after').y).toBe(17);
  });

  it('refuses a table child that is not a row, and the rows after it', () => {
    const m = layoutPage(page([table('10pt', [
      row('r1', [fld('a', H(10))]),
      sub('X', 'position', {}, [fld('b', H(10, { w: '10pt' }))]),
      row('r3', [fld('c', H(10))]),
    ])]));
    expect(box(m, 'a').y).toBe(0);
    expect(why(m, 'b')).toMatch(/not a row/);
    expect(why(m, 'c')).toMatch(/an earlier item/);
  });

  it('refuses a row that states its own size or a margin', () => {
    const sized = layoutPage(page([table('10pt', [sub('r', 'row', { h: '20pt' }, [fld('a', H(10))])])]));
    expect(why(sized, 'a')).toMatch(/own size or margin/);
    const margined = layoutPage(page([table('10pt', [row('r', [fld('a', H(10))],
      { margin: { topInset: '1pt' } })])]));
    expect(why(margined, 'a')).toMatch(/own size or margin/);
  });

  it('refuses a cell that states no height', () => {
    const m = layoutPage(page([table('10pt', [row('r', [fld('a', {})])])]));
    expect(why(m, 'a')).toMatch(/states no h.*164g\.7/);
  });

  // The f1040 Row6 shape: a growable lr-tb cell whose single line exactly fills
  // its column; and the refusal when it would not.
  it('lays an lr-tb cell on one line when it fits its column, and refuses when it does not', () => {
    const fits = layoutPage(page([table('50pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', H(10, { w: '20pt' })), fld('b', H(10, { w: '30pt' }))]),
    ])])]));
    expect(box(fits, 'b')).toEqual({ x: 20, y: 0, w: 30, h: 10 });
    const over = layoutPage(page([table('50pt', [row('r', [
      sub('C', 'lr-tb', {}, [fld('a', H(10, { w: '30pt' })), fld('b', H(10, { w: '30pt' }))]),
    ])])]));
    expect(why(over, 'a')).toMatch(/one line wider than its column/);
  });

  it('refuses a column width it cannot read', () => {
    const m = layoutPage(page([table('10px', [row('r', [fld('a', H(10))])])]));
    expect(why(m, 'a')).toMatch(/columnWidths entry "10px"/);
  });
});

describe('layoutPage: review fixes', () => {
  // Overflow is checked wherever a flow sits, not only when the PAGE subform
  // itself flows: a positioned page holding a growable tb must not place a box
  // past the contentArea's bottom.
  it('refuses a flowed box past the contentArea under a positioned page subform', () => {
    const m = layoutPage(page([sub('P', 'position', {}, [
      sub('T', 'tb', { y: '5pt' }, [fld('a', S), fld('b', S)]),
    ])], { w: '540pt', h: '20pt' }));
    expect(box(m, 'a').y).toBe(5);
    expect(why(m, 'b')).toMatch(/overflows its contentArea.*164g\.3/);
  });

  it('refuses a flow under a positioned page subform when the contentArea states no height', () => {
    const m = layoutPage(page([sub('P', 'position', {}, [sub('T', 'tb', {}, [fld('a', S)])])], {}));
    expect(why(m, 'a')).toMatch(/declares no contentArea height/);
  });

  // XFA 3.3 p. 329: "the visible representation of the object may extend
  // beyond the allotted region" -- a stated column width is the cell's box.
  it('narrows a leaf cell wider than its column to the column', () => {
    const m = layoutPage(page([table('20pt', [row('r', [fld('a', H(10, { w: '30pt' }))])])]));
    expect(box(m, 'a')).toEqual({ x: 0, y: 0, w: 20, h: 10 });
  });

  // Content past a stated maxH would be clipped, which is not laid out -- even
  // when the container itself sits topLeft under a positioned parent.
  it('refuses the content of a container past its maxH under a positioned parent', () => {
    const m = layoutPage(page([sub('P', 'position', {}, [
      sub('G', 'tb', {}, [fld('a', S), fld('b', S)], { minMax: { maxH: '15pt' } }),
    ])]));
    expect(why(m, 'a')).toMatch(/exceeds maxH/);
  });

  // Two fields sharing one SOM name on a page cannot both be addressed by it.
  it('refuses both fields of a duplicated SOM name rather than letting one win', () => {
    const m = layoutPage(page([fld('f', { x: '0pt', ...S }), fld('f', { x: '50pt', ...S })]));
    expect(why(m, 'f')).toMatch(/share the SOM name/);
  });
});
