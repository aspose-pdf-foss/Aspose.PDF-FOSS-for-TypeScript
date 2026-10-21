// test/xfatemplate-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import type { LayoutNode } from '../src/xfaflow.js';

const tpl = (body: string) => parseXfaTemplate(parseXml(new TextEncoder().encode(
  `<template><subform name="form1" layout="tb"><pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
   <contentArea w="8.5in" h="11in"/></pageArea></pageSet>${body}</subform></template>`)));
const find = (n: LayoutNode, pred: (n: LayoutNode) => boolean): LayoutNode | undefined =>
  pred(n) ? n : n.children.map((c) => find(c, pred)).find((x) => x !== undefined);

describe('xfatemplate: chrome on the layout tree (164g.4)', () => {
  it("puts a subform's own border on its node", () => {
    const t = tpl('<subform name="S" layout="position" w="1in" h="1in"><border><edge thickness="2pt"/></border></subform>');
    const s = find(t.body!.root, (n) => n.label === 'S[0]')!;
    expect(s.chrome?.border?.edges?.[0].thickness).toBe(2);
  });

  it("puts a draw's geometry and border on its node", () => {
    const t = tpl('<subform name="S" layout="position"><draw x="0" y="0" w="1in" h="0"><value><line/></value><border><edge/></border></draw></subform>');
    const d = find(t.body!.root, (n) => n.kind === 'draw')!;
    expect(d.chrome?.geometry?.kind).toBe('line');
    expect(d.chrome?.border).toBeDefined();
  });

  it("puts a field's caption text, caption and margin on its node, and its ui border on the field", () => {
    const t = tpl(`<subform name="S" layout="position"><field name="f" x="0" y="0" w="2in" h="20pt">
      <ui><textEdit><border><edge stroke="lowered"/></border></textEdit></ui>
      <caption reserve="1in" placement="left"><value><text>Name</text></value></caption>
      <margin leftInset="1pt"/><border><edge/></border></field></subform>`);
    const n = find(t.body!.root, (x) => x.kind === 'field')!;
    expect(n.chrome?.caption?.paras[0].runs[0].text).toBe('Name');
    expect(n.chrome?.fieldCaption).toEqual({ reserve: '1in', placement: 'left' });
    expect(n.chrome?.fieldMargin).toEqual({ leftInset: '1pt' });
    expect(n.chrome?.border).toBeDefined();
    expect(t.fields[0].widgetBorder?.edges?.[0].stroke).toBe('lowered');
  });

  it("gives a push button's field border to its widget, not to the page", () => {
    const t = tpl(`<subform name="S" layout="position"><field name="b" x="0" y="0" w="1in" h="20pt">
      <ui><button/></ui><border><edge stroke="raised"/></border></field></subform>`);
    const n = find(t.body!.root, (x) => x.kind === 'field')!;
    expect(n.chrome?.border).toBeUndefined();
    expect(t.fields[0].widgetBorder?.edges?.[0].stroke).toBe('raised');
  });

  it('carries no chrome key on a node that states none', () => {
    const t = tpl('<subform name="S" layout="position"><field name="f" x="0" y="0" w="1in" h="1in"><ui><textEdit/></ui></field></subform>');
    expect('chrome' in find(t.body!.root, (x) => x.kind === 'field')!).toBe(false);
  });

  it('reads chrome on a master page too', () => {
    const t = parseXfaTemplate(parseXml(new TextEncoder().encode(
      `<template><subform name="form1" layout="tb"><pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
       <contentArea w="8.5in" h="11in"/><draw x="0" y="0" w="1in" h="10pt"><value><text>CUI</text></value><border><edge/></border></draw>
       </pageArea></pageSet><subform name="S"/></subform></template>`)));
    const m = t.body!.pageSet!.pageAreas[0].master!;
    expect(find(m, (n) => n.kind === 'draw')?.chrome?.border).toBeDefined();
  });
  it("records a field's ui and orphans/widows for splitting (164g.13, 164g.26)", () => {
    const t = tpl(`<field name="a" w="1in" h="1in"><ui><textEdit><comb numberOfCells="4"/></textEdit></ui></field>
      <field name="b" w="1in" h="1in"><para orphans="2"/><ui><checkButton/></ui></field>
      <field name="c" w="1in" h="1in"><ui><textEdit/></ui></field>
      <field name="d" w="1in" h="1in"><para widows="3" orphans="-1"/><ui><textEdit/></ui></field>`);
    const at = (l: string) => find(t.body!.root, (n) => n.label === l)!;
    expect([at('a[0]').ui, at('a[0]').lineKeep]).toEqual(['textEdit', undefined]);
    expect([at('b[0]').ui, at('b[0]').lineKeep]).toEqual(['checkButton', { orphans: 2, widows: 0 }]);
    expect([at('c[0]').ui, at('c[0]').lineKeep]).toEqual(['textEdit', undefined]);
    expect(at('d[0]').lineKeep).toEqual({ orphans: 0, widows: 3 });
  });
});
