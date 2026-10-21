import { describe, it, expect } from 'vitest';
import { paginate, type XfaBody, type XfaPageAreaModel, type XfaContentArea, type XfaHeight } from '../src/xfapage.js';
import type { LayoutNode, XfaBreak } from '../src/xfaflow.js';
import type { LeafText } from '../src/xfarich.js';

const kid = (label: string, h: number, extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'position', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], ...extra });
const tb = (label: string, children: LayoutNode[], extra: Partial<LayoutNode> = {}): LayoutNode =>
  ({ kind: 'subform', label, layout: 'tb', geom: { w: '100pt' }, children, ...extra });
const ca = (h: number): XfaContentArea =>
  ({ node: { kind: 'page', label: 'contentArea', layout: 'tb', geom: { w: '500pt', h: `${String(h)}pt` }, children: [] } });
const area = (cas: XfaContentArea[]): XfaPageAreaModel => ({ max: -1, contentAreas: cas });
const body = (pageAreas: XfaPageAreaModel[], kids: LayoutNode[]): XfaBody => ({
  root: { kind: 'subform', label: 'root[0]', layout: 'tb', geom: {}, children: kids },
  pageSet: { relation: 'orderedOccurrence', max: -1, pageAreas },
});
const pt = (s: string | undefined): number => Number((s ?? '0pt').replace('pt', ''));
const hOf = (n: LayoutNode): number => (n.geom.h !== undefined ? pt(n.geom.h)
  : n.children.filter((k) => k.presence !== 'hidden').reduce((s, k) => s + hOf(k), 0));
const bang = (n: LayoutNode): boolean => n.label.endsWith('!') || n.children.some(bang);
const flowHeight: XfaHeight = (n) => ({ h: hOf(n), past: bang(n) });
const SPLITS = new Set(['tb', 'lr-tb', 'table']);
const shape = (n: LayoutNode): string =>
  (SPLITS.has(n.layout ?? '') && n.geom.h === undefined ? `${n.label}(${n.children.map(shape).join(',')})` : n.label);
const run = (b: XfaBody, hooks = {}) => paginate(b, flowHeight, hooks);
const split = (b: XfaBody, hooks = {}) => run(b, hooks).pages.map((p) =>
  p.contentAreas.map((c) => `${String(c.index)}:${c.children.map(shape).join(',')}`).join(' '));
const refusals = (b: XfaBody) => [...run(b).refused].map(([n, w]) => [n.label, w]);
const NEXT = { keep: { next: 'contentArea' } };
const PREV = { keep: { previous: 'contentArea' } };
const EMPTY_TEXT = {
  kind: 'text', paras: [{ runs: [], base: { family: ['Courier'], size: 10, bold: false, italic: false },
    marginLeft: 0, marginRight: 0, textIndent: 0, lineHeight: 0, spaceAbove: 0, spaceBelow: 0 }],
  insets: { l: 0, r: 0, t: 0, b: 0 }, password: false, picture: false,
} as unknown as LeafText;
const fld = (label: string, h: number): LayoutNode =>
  ({ kind: 'field', label, field: label, ui: 'textEdit', geom: { w: '100pt', h: `${String(h)}pt` }, children: [], text: EMPTY_TEXT });
const pb = (): XfaBreak => ({ targetType: 'pageArea', startNew: false });

describe('adhesion between root children (164g.14)', () => {
  // Content area 100: F 40 leaves 60.
  it('moves an adhering pair together when they do not fit (R1, t55)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('D', 40)])))
      .toEqual(['0:F', '0:C,D']);
  });
  it('previous on the second is the same (t56)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40), kid('D', 40, PREV)])))
      .toEqual(['0:F', '0:C,D']);
  });
  it('a chain of three moves together; the one after it does not (t55, t57)', () => {
    expect(split(body([area([ca(200)])], [kid('F', 120), kid('C', 30, NEXT), kid('D', 30, NEXT), kid('E', 30), kid('G', 10)])))
      .toEqual(['0:F', '0:C,D,E,G']);
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 20, NEXT), kid('D', 20), kid('E', 30)])))
      .toEqual(['0:F,C,D', '0:E']);
  });
  it('a chain whose MIDDLE link fails moves whole', () => {
    // C+D fit the 60 left, D+E do not: C must wait too.
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 20, NEXT), kid('D', 20, NEXT), kid('E', 30)])))
      .toEqual(['0:F', '0:C,D,E']);
  });
  it('skips a hidden sibling (t63)', () => {
    // H is SHORTER than D on purpose: adhering to an H the same height as D
    // holds C off exactly as adhering to D does, which is all t63 can see.
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('H', 5, { presence: 'hidden' }), kid('D', 40)])))
      .toEqual(['0:F', '0:C,H,D']);
  });
  it('holds off from an EMPTY region when the next region holds the pair (spec 3; p. 295)', () => {
    // A 50 then B 200 on each page: C fits A, C + D does not, both fit B.
    expect(split(body([area([ca(50), ca(200)])], [kid('C', 40, NEXT), kid('D', 40)]))).toEqual(['1:C,D']);
  });
  it('does not reach a non-sibling (t62)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40), tb('X', [kid('D', 40, PREV)])])))
      .toEqual(['0:F,C', '0:X(D)']);
  });
  it('ignores keep next on the last child', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT)]))).toEqual(['0:F,C']);
  });
  it('needs only the first piece of a splittable next (R2, t58)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 30, NEXT), tb('D', [kid('d1', 20), kid('d2', 40)])])))
      .toEqual(['0:F,C,D(d1)', '0:D(d2)']);
  });
  it('needs only a piece of a field it can split (R2, t65)', () => {
    // 60 left: C 40, then 20 >= the 10pt font size of an empty field. Since
    // 164g.27 D's head takes those 20, as t65's D splits 44/16.
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), fld('D', 60)]), { fieldLines: () => 0 }))
      .toEqual(['0:F,C,D', '0:D']);
  });
  it('moves a splittable child that fits whole but not with its next WHOLE (R3, t61)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), tb('S', [kid('s1', 20), kid('s2', 20)], NEXT), kid('N', 40)])))
      .toEqual(['0:F', '0:S(s1,s2),N']);
  });
  it('runs the next past this region when the pair cannot fit an empty one (R4, t69)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 20), kid('C', 40, NEXT), kid('D', 70), kid('E', 10)])))
      .toEqual(['0:F,C,D', '0:E']);
  });
  it('R4 at an empty region: the first stays, the next runs past (t59)', () => {
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 80, NEXT), kid('D', 80)])))
      .toEqual(['0:F', '0:C,D']);
  });
  it('refuses a run-away member that draws past, and everything after it', () => {
    const r = refusals(body([area([ca(100)])], [kid('F', 20), kid('C', 40, NEXT), kid('D!', 70), kid('E', 10)]));
    expect(r[0]).toEqual(['D!', expect.stringMatching(/^D!: .*cannot fit an empty content area.*\(164g\.14 R4\)/) as unknown as string]);
    expect(r.map(([n]) => n)).toEqual(['D!', 'E']);
  });
  it('terminates on a long unsatisfiable chain', () => {
    const kids = Array.from({ length: 40 }, (_, i) => kid(i === 5 ? `K${String(i)}!` : `K${String(i)}`, 30, NEXT));
    const res = run(body([area([ca(100)])], kids));
    expect(res.refused.size).toBe(35);
    expect(res.pages[0].contentAreas[0].children.map((k) => k.label)).toEqual(['K0', 'K1', 'K2', 'K3', 'K4']);
  });
  it('ignores adhesion into a sibling with a breakBefore, with a warning (section 4)', () => {
    const r = run(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('D', 40, { breakBefore: pb() })]));
    expect(split(body([area([ca(100)])], [kid('F', 40), kid('C', 40, NEXT), kid('D', 40, { breakBefore: pb() })])))
      .toEqual(['0:F,C', '0:D']);
    expect(r.warnings).toContainEqual(expect.stringMatching(/D: adhesion into a sibling with a breakBefore .*\(164g\.14\)/));
  });
});

const lrtb = (label: string, children: LayoutNode[]): LayoutNode =>
  ({ kind: 'subform', label, layout: 'lr-tb', geom: { w: '300pt' }, children });

describe('adhesion inside a split chain (164g.14 R5)', () => {
  it('holds a leaf off with the leaf it adheres to (t60)', () => {
    expect(split(body([area([ca(100)])], [tb('S', [kid('s1', 60), kid('s2', 20, NEXT), kid('s3', 30), kid('s4', 10)])])))
      .toEqual(['0:S(s1)', '0:S(s2,s3,s4)']);
  });
  it('previous on the later leaf is the same', () => {
    expect(split(body([area([ca(100)])], [tb('S', [kid('s1', 60), kid('s2', 20), kid('s3', 30, PREV), kid('s4', 10)])])))
      .toEqual(['0:S(s1)', '0:S(s2,s3,s4)']);
  });
  it('a nested container adheres to its sibling at the level they part', () => {
    // I's last leaf i2 and the sibling J: I states keep next.
    expect(split(body([area([ca(100)])], [tb('S', [kid('a', 50), tb('I', [kid('i1', 10), kid('i2', 20)], NEXT), kid('J', 30)])])))
      .toEqual(['0:S(a,I(i1))', '0:S(I(i2),J)']);
  });
  it('the last piece of a split root child adheres to the next root child (R2, t70)', () => {
    // S splits: s1 on page 1, s2 on page 2. s3 fits after s2 there (90), but
    // s3 + N (120) do not, and fit an empty page: s3 waits with N.
    expect(split(body([area([ca(100)])], [kid('F', 40), tb('S', [kid('s1', 50), kid('s2', 80), kid('s3', 10)], NEXT), kid('N', 30)])))
      .toEqual(['0:F,S(s1)', '0:S(s2)', '0:S(s3),N']);
  });
  it('rows of a table adhere (t72)', () => {
    // r1 fits the 50 left; r2 fits too, but r2 + r3 (80) do not, and fit an empty area.
    const row = (l: string, extra: Partial<LayoutNode> = {}): LayoutNode =>
      ({ kind: 'subform', label: l, layout: 'row', geom: { h: '20pt' }, children: [], ...extra });
    const T: LayoutNode = { kind: 'subform', label: 'T', layout: 'table', geom: { w: '100pt' }, children: [row('r1'), row('r2', NEXT), row('r3'), row('r4')] };
    expect(split(body([area([ca(100)])], [kid('F', 50), T]))).toEqual(['0:F,T(r1)', '0:T(r2,r3,r4)']);
  });
  it('falls back to whole placement for adhesion between lr-tb items (section 4)', () => {
    const res = run(body([area([ca(100)])], [kid('F', 40), lrtb('L', [kid('a', 40, NEXT), kid('b', 40)])]));
    expect(res.pages.map((pg) => pg.contentAreas.map((c) => c.children.map(shape).join(',')).join(' '))).toEqual(['F', 'L(a,b)']);
    expect(res.refused.size).toBe(0);
  });
  it('a pair inside a split that cannot fit an empty region is not forced, with a warning (decision 2)', () => {
    const res = run(body([area([ca(100)])], [tb('S', [kid('s1', 50), kid('s2', 40, NEXT), kid('s3', 70)])]));
    expect(split(body([area([ca(100)])], [tb('S', [kid('s1', 50), kid('s2', 40, NEXT), kid('s3', 70)])])))
      .toEqual(['0:S(s1,s2)', '0:S(s3)']);
    expect(res.warnings).toContainEqual(expect.stringMatching(/s2: .*not kept inside a split subform \(164g\.14\)/));
  });
});

describe('adhesion: unprobed shapes later in a run-away chain (final review)', () => {
  // I1: C 80 and D 80 cannot fit an empty 100pt area together, so D runs past
  // after C; E, a SPLITTABLE member D adheres to, must not be forced (section 4).
  it('does not force a splittable later member; it is laid out as before, with a warning', () => {
    const b = body([area([ca(100)])], [kid('C', 80, NEXT), kid('D', 80, NEXT), tb('E', [kid('e1', 30), kid('e2', 30)]), kid('G', 10)]);
    const res = run(b);
    expect(res.refused.size).toBe(0);
    expect(split(b)).toEqual(['0:C,D', '0:E(e1,e2),G']);
    expect(res.warnings).toContainEqual(expect.stringMatching(/E: .*not kept \(164g\.14\)/));
  });
  it('does not force a later member that states a breakBefore; the break applies', () => {
    const b = body([area([ca(100)])], [kid('C', 80, NEXT), kid('D', 80, NEXT), kid('E', 30, { breakBefore: pb() })]);
    expect(run(b).refused.size).toBe(0);
    expect(split(b)).toEqual(['0:C,D', '0:E']);
  });
  // I2: keep next and a breakAfter on one child: the break separates the pair
  // anyway, so the adhesion is not kept and the child is not moved for it.
  it('ignores keep next on a child with a breakAfter, with a warning', () => {
    const b = body([area([ca(100)])], [kid('F', 40), kid('C', 40, { ...NEXT, breakAfter: pb() }), kid('D', 40)]);
    expect(split(b)).toEqual(['0:F,C', '0:D']);
    expect(run(b).warnings).toContainEqual(expect.stringMatching(/C: adhesion from a subform with a breakAfter .*\(164g\.14\)/));
  });
});

describe('adhesion: 164g.14 review minors (164g.28)', () => {
  const copySpec = { label: '#L', max: -1, scope: {}, name: 'L', make: () => kid('L', 10) };
  // A root that lays overflow copies moves a root field WHOLE (164g.27), so a
  // piece that would fit puts nothing here: the pair moves together.
  it('does not count on a root field piece when the root lays overflow copies', () => {
    const kids = [kid('F', 40), kid('C', 40, NEXT), fld('D', 60)];
    const withCopies = body([area([ca(100)])], kids);
    withCopies.root.overflow = { trailer: [copySpec] };
    expect(split(withCopies, { fieldLines: () => 0 })).toEqual(['0:F', '0:C,D']);
    // Without them the field splits and C stays, as before (t65).
    expect(split(body([area([ca(100)])], kids), { fieldLines: () => 0 })).toEqual(['0:F,C,D', '0:D']);
  });

  it('says so when the adhered-to sibling\'s first piece breaks', () => {
    const b = body([area([ca(100)])], [kid('F', 40), kid('C', 30, NEXT), tb('D', [kid('d1', 20, { breakBefore: pb() }), kid('d2', 40)])]);
    expect(split(b)).toEqual(['0:F,C', '0:D(d1,d2)']);
    expect(run(b).warnings).toEqual(['D: adhesion into a sibling whose first piece breaks is not implemented (164g.14)']);
  });

  // Section 4: adhesion between lr-tb items makes the chain unsplittable, so it
  // is placed whole -- and refused, naming why, when it cannot fit at all.
  it('places an lr-tb chain whose items adhere whole, and names the adhesion when it cannot fit', () => {
    const lr = (n: number, last = ''): LayoutNode => ({ kind: 'subform', label: 'S', layout: 'lr-tb', geom: { w: '100pt' },
      children: Array.from({ length: n }, (_, i) => kid(`i${String(i)}${i === n - 1 ? last : ''}`, 30, NEXT)) });
    expect(split(body([area([ca(100)])], [kid('F', 40), lr(3)]))).toEqual(['0:F', '0:S(i0,i1,i2)']);
    const too = body([area([ca(100)])], [kid('F', 40), lr(5, '!')]);
    expect(refusals(too)).toEqual([
      ['S', expect.stringMatching(/i0: adhesion between the items of an lr-tb line is not implemented \(164g\.14\)/)],
    ]);
  });

  // Section 2: the chain walk is a loop, and a region's walk is remembered,
  // so a split table whose every row keeps next costs measures linear in the
  // rows a region holds where it cost quadratic -- 20,201 and 50,501 calls
  // before. What is left is `fitsNextEmpty`'s sliding window on a page where
  // the chain cannot fit, which no shortcut answers without assuming fragment
  // heights are monotone. A FENCE, recorded when it was written.
  it('measures a keep-next table in a recorded number of calls', () => {
    for (const [n, want] of [[200, 10400], [400, 30800]]) {
      let calls = 0;
      const counting: XfaHeight = (x, limit) => { calls++; return flowHeight(x, limit); };
      paginate(body([area([ca(1000)])], [tb('T', Array.from({ length: n }, (_, i) => kid(`r${String(i)}`, 10, NEXT)))]), counting);
      expect(calls).toBe(want);
    }
  });

  // The recursive walk overflowed the stack between 5,000 and 6,000 rows,
  // measured; 8,000 leaves room for a machine with a deeper stack. Its time is
  // the region fit test's, which re-measures the region per leaf (164g.12).
  it('walks a chain far deeper than the call stack', () => {
    const n = 8000;
    // Zero-height rows all keep next, so the walk from the first runs the
    // whole chain before the last row, too tall for the region, ends it.
    const rows = [...Array.from({ length: n }, (_, i) => kid(`r${String(i)}`, 0, NEXT)), kid('end', 60)];
    const r = run(body([area([ca(100)])], [kid('F', 50), tb('T', rows)]));
    expect(r.refused.size).toBe(0);
    expect(r.pages.length).toBe(2);
  }, 60_000);
});
