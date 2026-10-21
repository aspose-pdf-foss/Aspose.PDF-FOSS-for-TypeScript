// test/xfa-leaders.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { layoutPages } from '../src/xfapage.js';
import type { LayoutNode } from '../src/xfaflow.js';

/**
 * Overflow and break leaders and trailers (164g.15): the rules the Adobe probes
 * (t73-t90, test/xfa-adobe-oracle.test.ts) cannot separate, and every shape
 * this feature refuses by name. Every size is stated, so no text is measured.
 */
const tpl = (body: string, caH = 100, proto = '') => parseXfaTemplate(parseXml(new TextEncoder().encode(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f" layout="tb">
  <pageSet><pageArea name="P1" id="P1"><contentArea name="A" x="0" y="0" w="500pt" h="${String(caH)}pt"/>
  <medium short="612pt" long="792pt"/></pageArea></pageSet>${body}${proto ? `<proto>${proto}</proto>` : ''}</subform></template>`,
)));
const d = (n: string, h: number): string => `<draw name="${n}" w="100pt" h="${String(h)}pt"><value><text>${n}</text></value></draw>`;
/** A positioned block holding a field, so a refusal has a field to name. */
const blk = (n: string, h: number): string => `<subform name="${n}" w="100pt" h="${String(h)}pt"><field name="x" w="10pt" h="5pt"><ui><textEdit/></ui></field></subform>`;
const why = (r: ReturnType<typeof run>['r']): string => [...r.refused.values()].join(' | ');
/** A positioned leader or trailer: an id, an occur max, a field `x`. */
const copy = (n: string, h: number, max?: number): string =>
  `<subform name="${n}" id="${n}_ID" w="500pt" h="${String(h)}pt">${max === undefined ? '' : `<occur max="${String(max)}"/>`}`
  + `<field name="x" x="0" y="0" w="50pt" h="${String(h)}pt"><ui><textEdit/></ui></field></subform>`;
const run = (body: string, caH = 100, proto = '') => {
  const t = tpl(body, caH, proto);
  const warnings: string[] = [];
  return { t, warnings, r: layoutPages(t.body!, undefined, warnings) };
};
/** Per page, the label of every draw and copy subform placed, in order. */
const labels = (r: ReturnType<typeof run>['r']): string[][] =>
  r.pages.map((p) => p.nodes.flatMap((n) => ('box' in n && (n.node.kind === 'draw' || /^[LTX]/.test(n.node.label)) ? [n.node.label] : [])));
const overflowOf = (t: ReturnType<typeof tpl>): LayoutNode['overflow'] => t.body!.root.children[0].overflow;

describe('leader and trailer targets (164g.15 R1, R2)', () => {
  it('resolves #id in a proto under the root subform, and ignores one at template level, with a warning', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="#L_ID"/></subform>`, 100, copy('L', 20));
    expect(overflowOf(t)?.leader?.map((s) => s.name)).toEqual(['L']);
    const top = parseXfaTemplate(parseXml(new TextEncoder().encode(
      `<template><subform name="f" layout="tb"><pageSet><pageArea><contentArea h="100pt"/></pageArea></pageSet>
      <subform name="S" layout="tb"><overflow leader="#L_ID"/></subform></subform><proto>${copy('L', 20)}</proto></template>`)));
    expect(overflowOf(top)?.leader).toEqual([]);
    expect(top.warnings).toEqual([expect.stringMatching(/"#L_ID" names nothing under the root subform, so it is ignored/) as unknown as string]);
  });

  it('ignores a target that is not a subform (t90), with a warning', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="#X_ID"/></subform><proto><draw name="X" id="X_ID"/></proto>`);
    expect(overflowOf(t)?.leader).toEqual([]);
    expect(t.warnings[0]).toMatch(/names a <draw>, not a subform/);
  });

  it('searches a bare name among the asserting subform\'s children, then its ancestors\' (DD 1494)', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="H" trailer="K"/><subform name="H"/></subform><subform name="K"/>`);
    const of = overflowOf(t)!;
    expect(of.leader?.map((s) => [s.name, s.refusal])).toEqual([['H', undefined]]);
    expect(of.trailer?.map((s) => [s.name, s.refusal])).toEqual([['K', undefined]]);
  });

  it('refuses a SOM expression, a name it resolves to nothing, a subformSet and an unreadable occur, where inserted', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="f.S.H nope #Z_ID #B_ID"/></subform>`
      + '<proto><subformSet id="Z_ID"/><subform name="B" id="B_ID"><occur max="x"/></subform></proto>');
    expect(overflowOf(t)!.leader!.map((s) => s.refusal)).toEqual([
      expect.stringMatching(/"f\.S\.H" is a SOM expression, which is not resolved \(164g\.15\)/),
      expect.stringMatching(/"nope" is a SOM name we resolve to no subform/),
      expect.stringMatching(/names a subformSet/),
      expect.stringMatching(/states an unreadable <occur max>/),
    ]);
  });

  it('reads <occur max>: 1 when absent (t73), -1 for none', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="#A_ID #B_ID"/></subform>`, 100, copy('A', 10) + copy('B', 10, -1));
    expect(overflowOf(t)!.leader!.map((s) => s.max)).toEqual([1, -1]);
  });

  it('reads the deprecated <break overflowLeader overflowTrailer>, and <overflow> wins over it', () => {
    const legacy = tpl(`<subform name="S" layout="tb"><break overflowTrailer="#T_ID"/></subform>`, 100, copy('T', 10));
    expect(overflowOf(legacy)?.trailer?.map((s) => s.name)).toEqual(['T']);
    const both = tpl(`<subform name="S" layout="tb"><overflow leader=""/><break overflowLeader="#T_ID"/></subform>`, 100, copy('T', 10));
    expect(overflowOf(both)).toEqual({ leader: [] });
  });
});

describe('copies (164g.15 R8)', () => {
  it('names a copy after every instance the walk counted (t73: H[1]), and makes it purely', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="H"/><subform name="H" h="10pt"><field name="x" h="10pt"><ui><textEdit/></ui></field></subform></subform>`);
    const s = overflowOf(t)!.leader![0];
    const a = s.make(0);
    expect(a.label).toBe('H[1]');
    expect(s.make(0).label).toBe('H[1]');
    expect(s.make(1).label).toBe('H[2]');
    expect(t.copyFields.get(a)?.map((f) => f.name)).toEqual(['f[0].S[0].H[1].x[0]']);
  });

  it('names a proto copy from [0] under the asserting subform (t88: S.L), and a break copy under its parent (t85)', () => {
    const t = tpl(`<subform name="S" layout="tb"><overflow leader="#L_ID"/><breakBefore targetType="pageArea" trailer="#L_ID"/></subform>`, 100, copy('L', 10));
    const leader = overflowOf(t)!.leader![0];
    expect(t.copyFields.get(leader.make(0))?.map((f) => f.name)).toEqual(['f[0].S[0].L[0].x[0]']);
    const trailer = t.body!.root.children[0].breakBefore!.trailer!;
    expect(t.copyFields.get(trailer.make(1))?.map((f) => f.name)).toEqual(['f[0].L[1].x[0]']);
  });
});

describe('pagination (164g.15)', () => {
  // p. 325, unprobed: past its own spent list a subform spends the next
  // asserting ancestor's.
  it("inherits an ancestor's leader once its own are spent", () => {
    const { r } = run(`<subform name="A" layout="tb"><overflow leader="#LA_ID"/><subform name="B" layout="tb"><overflow leader="#LB_ID"/>`
      + `${d('d1', 80)}${d('d2', 80)}${d('d3', 80)}</subform></subform>`, 100, copy('LA', 10) + copy('LB', 10));
    expect(labels(r)).toEqual([['d1'], ['LB[0]', 'd2'], ['LA[0]', 'd3']]);
  });

  it('is blocked by an empty list (t80)', () => {
    const { r } = run(`<subform name="A" layout="tb"><overflow leader="#L_ID"/><subform name="B" layout="tb"><overflow leader=""/>`
      + `${d('d1', 80)}${d('d2', 80)}</subform></subform>`, 100, copy('L', 10, -1));
    expect(labels(r)).toEqual([['d1'], ['d2']]);
  });

  it('lists every copy it laid down', () => {
    const { r } = run(`<subform name="S" layout="tb"><overflow leader="#L_ID" trailer="#T_ID"/>${d('d1', 60)}${d('d2', 60)}</subform>`,
      100, copy('L', 10) + copy('T', 10));
    expect(labels(r)).toEqual([['d1', 'T[0]'], ['L[0]', 'd2']]);
    expect(r.copies.map((n) => n.label)).toEqual(['T[0]', 'L[0]']);
  });

  // Decision: in an EMPTY region the reservation alone does not keep a leaf
  // out; the trailer is then laid down only if it still fits.
  it('takes a leaf into an empty region without the reservation, and warns when the trailer then does not fit', () => {
    const { r, warnings } = run(`<subform name="S" layout="tb"><overflow trailer="#T_ID"/>${d('d1', 90)}${d('d2', 50)}</subform>`,
      100, copy('T', 30));
    expect(labels(r)).toEqual([['d1'], ['d2']]);
    expect(warnings).toContainEqual(expect.stringMatching(/an overflow trailer that does not fit the region it closes is not laid down/));
  });

  // The fallback shows only where the NEXT region could hold the leaf with its
  // reservation: p. 295's empty-region rule would otherwise move it there.
  it('keeps the leaf in an empty region even when a larger next region could hold it reserved', () => {
    const t = parseXfaTemplate(parseXml(new TextEncoder().encode(
      `<template><subform name="f" layout="tb"><pageSet><pageArea name="P1"><contentArea name="A" w="500pt" h="100pt"/>
      <contentArea name="B" y="100pt" w="500pt" h="200pt"/></pageArea></pageSet>
      <subform name="S" layout="tb"><overflow trailer="#T_ID"/>${d('d1', 90)}${d('d2', 150)}</subform>
      <proto>${copy('T', 30)}</proto></subform></template>`)));
    const r = layoutPages(t.body!, undefined, []);
    const ys = r.pages[0].nodes.flatMap((n) => ('box' in n && n.node.kind === 'draw' ? [[n.node.label, n.box.y]] : []));
    expect(ys).toEqual([['d1', 0], ['d2', 100]]);
  });

  // `restore` must take back the copies a positioned split's PLAN commits, or
  // they are counted, numbered and listed twice.
  it('lists each positioned-split leader once', () => {
    const { r } = run(`<subform name="P" w="500pt" h="250pt"><keep intact="none"/><overflow leader="#L_ID"/>`
      + `<field name="a" x="0" y="0" w="50pt" h="20pt"><ui><textEdit/></ui></field>`
      + `<field name="b" x="0" y="110pt" w="50pt" h="20pt"><ui><textEdit/></ui></field>`
      + `<field name="c" x="0" y="220pt" w="50pt" h="20pt"><ui><textEdit/></ui></field></subform>`,
    100, copy('L', 10, -1));
    expect(r.copies.map((n) => n.label)).toEqual(['L[0]', 'L[1]']);
  });

  it('refuses an unresolved leader where it would be inserted, and not before', () => {
    expect(run(`<subform name="S" layout="tb"><overflow leader="a.b"/>${blk('d1', 40)}</subform>`).r.refused.size).toBe(0);
    const { r } = run(`<subform name="S" layout="tb"><overflow leader="a.b"/>${blk('d1', 60)}${blk('d2', 60)}</subform>`);
    expect(why(r)).toMatch(/"a\.b" is a SOM expression/);
  });

  /** Per page, each placed copy's label and top. */
  const tops = (r: ReturnType<typeof run>['r']): string[][] =>
    r.pages.map((p) => p.nodes.flatMap((n) => ('box' in n && /^[LT]\[/.test(n.node.label) ? [`${n.node.label}@${String(n.box.y)}`] : [])));

  // 164g.31 S4 (t182): the trailer closes the region inside the BREAKING
  // subform's parent, the leader opens the next one there; S5 (t183): a break
  // lays no overflow leader or trailer.
  it('lays a break leader and trailer inside a split chain, and no overflow copy at a break (164g.31)', () => {
    const own = run(`<subform name="S" layout="tb">${blk('d1', 30)}<subform name="C" layout="tb"><breakBefore targetType="pageArea" leader="#L_ID" trailer="#T_ID"/>${blk('d2', 30)}</subform></subform>`,
      100, copy('L', 10) + copy('T', 10));
    expect(own.r.refused.size).toBe(0);
    expect(tops(own.r)).toEqual([['T[0]@30'], ['L[0]@0']]);
    const across = run(`<subform name="S" layout="tb"><overflow leader="#L_ID"/>${blk('d1', 30)}<subform name="C" layout="tb"><breakBefore targetType="pageArea"/>${blk('d2', 30)}</subform></subform>`,
      100, copy('L', 10));
    expect(across.r.refused.size).toBe(0);
    expect(tops(across.r)).toEqual([[], []]);
  });

  // S4's home is the breaking subform's PARENT, which only a nested container
  // separates from the root child -- and only its margin makes it observable:
  // inside M the trailer sits below M's top inset, beside M it sits below M's
  // whole fragment. A trailer that does not fit opens the next region (S3).
  it('lays a nested break\'s copies in its parent, and moves a chain trailer that does not fit (164g.31)', () => {
    const brk = '<subform name="C" w="100pt" h="10pt"><breakBefore targetType="pageArea" leader="#L_ID" trailer="#T_ID"/></subform>';
    const nested = run(`<subform name="S" layout="tb">${blk('d1', 30)}<subform name="M" layout="tb"><margin topInset="5pt" bottomInset="5pt"/>`
      + `${blk('d2', 10)}${brk}</subform></subform>`, 100, copy('L', 10) + copy('T', 10));
    expect(nested.r.refused.size).toBe(0);
    expect(tops(nested.r)).toEqual([['T[0]@45'], ['L[0]@5']]);
    const full = run(`<subform name="S" layout="tb">${blk('d1', 95)}${brk}</subform>`, 100, copy('L', 10) + copy('T', 10));
    expect(full.r.refused.size).toBe(0);
    expect(tops(full.r)).toEqual([[], ['T[0]@0'], ['L[0]@0']]);
  });

  // 164g.31 S1 (t177), S2 (t180), S3 (t181).
  it("ignores a start break's copies, lays a still break's in place, and moves an unfitting trailer (164g.31)", () => {
    const brk = (attrs: string): string => `<subform name="S" w="100pt" h="10pt"><breakBefore targetType="pageArea" ${attrs}/>`
      + '<field name="x" w="10pt" h="5pt"><ui><textEdit/></ui></field></subform>';
    const start = run(brk('leader="#L_ID"'), 100, copy('L', 10));
    expect(start.r.refused.size).toBe(0);
    expect(tops(start.r)).toEqual([[]]);
    expect(start.warnings).toEqual([expect.stringMatching(/chooses where layout starts is ignored.*\(164g\.31\)/) as unknown as string]);
    // A pageArea break naming the current page area does not move.
    const still = run(blk('A', 10) + brk('target="P1" leader="#L_ID" trailer="#T_ID"'), 100, copy('L', 10) + copy('T', 10));
    expect(still.r.refused.size).toBe(0);
    expect(tops(still.r)).toEqual([['T[0]@10', 'L[0]@20']]);
    const full = run(blk('A', 95) + brk('trailer="#T_ID"'), 100, copy('T', 10));
    expect(full.r.refused.size).toBe(0);
    expect(tops(full.r)).toEqual([[], ['T[0]@0'], []]);
    // Laid down when it fits: the trailer closes page 1, the leader opens page 2 (t85).
    const fits = run(blk('A', 50) + brk('leader="#L_ID" trailer="#T_ID"'), 100, copy('L', 10) + copy('T', 10));
    expect(labels(fits.r)).toEqual([['T[0]'], ['L[0]']]);
  });

  // 164g.31 S2 (t179): an auto break's copies are siblings -- trailer, then
  // leader, before a breakBefore -- and a positioned parent ignores them.
  it('lays an auto break\'s trailer and leader in place, and ignores them in a positioned parent (164g.31)', () => {
    const auto = '<breakBefore targetType="auto" leader="#L_ID" trailer="#T_ID"/>';
    const flow = run(`${blk('A', 10)}<subform name="S" w="100pt" h="10pt">${auto}</subform>`, 100, copy('L', 10) + copy('T', 10));
    expect(flow.t.body!.root.children.map((c) => c.label)).toEqual(['A[0]', 'T[0]', 'L[0]', 'S[0]']);
    expect(tops(flow.r)).toEqual([['T[0]@10', 'L[0]@20']]);
    const pos = run(`<subform name="Q" w="500pt" h="50pt"><subform name="S" w="100pt" h="10pt">${auto}</subform></subform>`,
      100, copy('L', 10) + copy('T', 10));
    expect(pos.t.body!.root.children[0].children.map((c) => c.label)).toEqual(['S[0]']);
    expect(pos.t.warnings).toEqual(['S[0]: a leader or trailer on a breakBefore that does not move, in a position subform, is ignored (164g.31)']);
  });

  // 164g.31 S6 (t185): reserved in the cut, laid below the fragment it closes.
  it('reserves an overflow trailer on a split positioned subform and lays it below the fragment (164g.31)', () => {
    const { r } = run(`<subform name="P" w="500pt" h="150pt"><keep intact="none"/><overflow trailer="#T_ID"/>`
      + `<field name="a" x="0" y="0" w="50pt" h="20pt"><ui><textEdit/></ui></field><field name="b" x="0" y="120pt" w="50pt" h="20pt"><ui><textEdit/></ui></field></subform>`,
      100, copy('T', 10));
    expect(r.refused.size).toBe(0);
    expect(tops(r)).toEqual([['T[0]@90'], []]);
  });
});
