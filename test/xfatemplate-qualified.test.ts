import { describe, it, expect } from 'vitest';
import { parseXml } from '../src/xml.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';

const CA = '<contentArea x="0" y="0" w="500pt" h="700pt"/>';
const MED = '<medium short="8.5in" long="11in"/>';
const tpl = (pageSet: string, body = '<subform name="s" w="100pt" h="10pt"/>') => parseXfaTemplate(parseXml(new TextEncoder().encode(
  `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1" layout="tb">${pageSet}${body}</subform></template>`)));

describe('qualified page sets in the template (164g.9)', () => {
  it('reads the three qualifiers onto each page area', () => {
    const t = tpl(`<pageSet relation="duplexPaginated"><pageArea name="A" pagePosition="rest" oddOrEven="even" blankOrNotBlank="blank">${MED}${CA}</pageArea><pageArea name="B">${MED}${CA}</pageArea></pageSet>`);
    const ps = t.body!.pageSet!;
    expect(ps.relation).toBe('duplexPaginated');
    expect(ps.refusal).toBeUndefined();
    expect(ps.pageAreas[0]).toMatchObject({ pagePosition: 'rest', oddOrEven: 'even', blankOrNotBlank: 'blank' });
    expect(ps.pageAreas[1].pagePosition).toBeUndefined();
  });
  it('refuses an unknown qualifier value by name under a qualified relation', () => {
    const ps = tpl(`<pageSet relation="simplexPaginated"><pageArea name="A" pagePosition="middle">${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBe('pageArea pagePosition="middle" is not one XFA defines (XFA 3.3 p. 302)');
  });
  it('ignores qualifiers, valid or not, under orderedOccurrence (p. 302)', () => {
    const ps = tpl(`<pageSet><pageArea name="A" pagePosition="middle" oddOrEven="even">${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBeUndefined();
    expect(ps.pageAreas[0].pagePosition).toBeUndefined();
    expect(ps.pageAreas[0].oddOrEven).toBeUndefined();
  });
  it('ignores occur on a qualified page area and page set, with one warning each (p. 296)', () => {
    const ps = tpl(`<pageSet relation="simplexPaginated"><occur min="3" max="2"/><pageArea name="A"><occur min="5" max="x"/>${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBeUndefined();
    expect(ps.pageAreas[0].max).toBe(-1);
    expect(ps.max).toBe(-1);
    expect(ps.warnings).toEqual([
      'pageArea A states <occur>, which simplexPaginated ignores (XFA 3.3 p. 296)',
      'pageSet states <occur>, which simplexPaginated ignores (XFA 3.3 p. 296)',
    ]);
  });
  it('refuses a relation XFA does not define', () => {
    const ps = tpl(`<pageSet relation="shuffled"><pageArea name="A">${MED}${CA}</pageArea></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBe('pageSet relation="shuffled" is not one XFA defines (XFA 3.3 p. 798)');
  });
  it('still refuses a second or nested page set, citing 164g.22', () => {
    const ps = tpl(`<pageSet relation="simplexPaginated"><pageArea name="A">${MED}${CA}</pageArea><pageSet relation="duplexPaginated"><pageArea name="B">${MED}${CA}</pageArea></pageSet></pageSet>`).body!.pageSet!;
    expect(ps.refusal).toBe('more than one pageSet, or a nested one, is not paginated (164g.22)');
  });
  it('reads pageEven and pageOdd breaks without refusing them', () => {
    const t = tpl(`<pageSet><pageArea name="A">${MED}${CA}</pageArea></pageSet>`,
      '<subform name="s" w="100pt" h="10pt"><breakBefore targetType="pageOdd" startNew="1"/></subform>');
    expect(t.body!.root.children[0].breakBefore).toEqual({ targetType: 'pageOdd', startNew: true });
  });
});
