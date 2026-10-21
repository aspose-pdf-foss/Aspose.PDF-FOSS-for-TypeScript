// test/xfatemplate-bookend.test.ts
import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import type { LayoutNode } from '../src/xfaflow.js';

/**
 * `<bookend>` (164g.29): what the Adobe probes t160-t176 cannot separate. The
 * probes themselves are test/xfa-adobe-oracle.test.ts.
 */
const tpl = (inner: string) => parseXfaTemplate(parseXml(new TextEncoder().encode(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f" layout="tb">
    <pageSet><pageArea><contentArea w="7.5in" h="10in"/></pageArea></pageSet>${inner}</subform></template>`,
)));
const LT = `<proto><subform name="L" id="L_ID" layout="position" w="1in" h="20pt"><field name="Lf" w="1in" h="10pt"><ui><textEdit/></ui></field></subform>
  <subform name="T" id="T_ID" layout="position" w="1in" h="20pt"/></proto>`;
const draw = (n: string) => `<draw name="${n}" w="1in" h="10pt"/>`;
const labels = (n: LayoutNode) => n.children.map((c) => c.label);
const s = (t: ReturnType<typeof tpl>) => t.body!.root.children.find((c) => c.label === 'S[0]')!;

describe('XFA bookend leaders and trailers (164g.29)', () => {
  it('makes the leader the first child and the trailer the last, its fields ordinary fields', () => {
    const t = tpl(`<subform name="S" layout="tb"><bookend leader="#L_ID" trailer="#T_ID"/>${draw('D1')}</subform>${LT}`);
    expect(labels(s(t))).toEqual(['L[0]', 'D1', 'T[0]']);
    expect(t.fields.map((f) => f.name)).toContain('f[0].S[0].L[0].Lf[0]');
    expect(t.copyFields.size).toBe(0);
  });

  it('reads the deprecated <break bookendLeader bookendTrailer>', () => {
    const t = tpl(`<subform name="S" layout="tb"><break bookendLeader="#L_ID" bookendTrailer="#T_ID"/>${draw('D1')}</subform>${LT}`);
    expect(labels(s(t))).toEqual(['L[0]', 'D1', 'T[0]']);
  });

  // t172 names the copy after the walk's instances; consuming the index is
  // what keeps a later copy of the same name -- an overflow leader made during
  // pagination -- from colliding with it (unprobed; the natural reading).
  it('consumes the copy index, so a later copy of the name follows it', () => {
    const t = tpl(`<subform name="S" layout="tb"><bookend leader="#L_ID"/><overflow leader="#L_ID"/>${draw('D1')}</subform>${LT}`);
    const over = s(t).overflow!.leader![0];
    expect(labels(s(t))[0]).toBe('L[0]');
    expect(over.make(0).label).toBe('L[1]');
  });

  it('lays the root subform\'s bookend at the start and end of the document (t166)', () => {
    const t = parseXfaTemplate(parseXml(new TextEncoder().encode(
      `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="f" layout="tb">
        <bookend leader="#L_ID" trailer="#T_ID"/>
        <pageSet><pageArea><contentArea w="7.5in" h="10in"/></pageArea></pageSet>${draw('D1')}${LT}</subform></template>`,
    )));
    expect(labels(t.body!.root)).toEqual(['L[0]', 'D1', 'T[0]']);
  });

  it('ignores a bookend on a positioned subform, with a warning (t168)', () => {
    const t = tpl(`<subform name="S" w="1in" h="1in"><bookend leader="#L_ID" trailer="#T_ID"/>${draw('D1')}</subform>${LT}`);
    expect(labels(s(t))).toEqual(['D1']);
    expect(t.warnings).toEqual(['S[0]: a bookend on a position subform is ignored, as Adobe ignores it (164g.29, t168)']);
  });

  it('refuses a target it does not resolve, in the bookend\'s place', () => {
    const t = tpl(`<subform name="S" layout="tb"><bookend leader="#L_ID #T_ID" trailer="a.b"/>${draw('D1')}</subform>${LT}`);
    const [lead, , trail] = s(t).children;
    expect(lead.refusal).toBe('S[0]: its bookend leader "#L_ID #T_ID" names several targets (164g.29)');
    expect(trail.refusal).toBe('S[0]: its bookend trailer "a.b" is a SOM expression, which is not resolved (164g.15)');
  });

  it('ignores a target that names a draw, as Adobe does (t173)', () => {
    const t = tpl(`<subform name="S" layout="tb"><bookend leader="#Q_ID"/>${draw('D1')}</subform>
      <proto><draw name="Q" id="Q_ID" w="1in" h="10pt"/></proto>`);
    expect(labels(s(t))).toEqual(['D1']);
    expect(t.warnings[0]).toContain('its bookend leader "#Q_ID" names a <draw>, not a subform');
  });
});
