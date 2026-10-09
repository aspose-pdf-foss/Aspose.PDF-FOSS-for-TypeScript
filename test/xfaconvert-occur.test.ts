import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

// 164g.2: ConvertXfaToAcroForm instantiates a repeating subform once per data
// group, binds each instance's fields to its own group, and lays them out.
const FLOW = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
    <contentArea x="0" y="0" w="8.5in" h="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="tb">
    <subform name="R" layout="tb"><occur max="-1"/>
      <field name="a" w="2in" h="20pt"><ui><textEdit/></ui></field></subform>
  </subform></subform></template>`;
const data = (rows: string) =>
  `<xfa:datasets><xfa:data><form1><Page1>${rows}</Page1></form1></xfa:data></xfa:datasets>`;

describe('ConvertXfaToAcroForm: <occur> (164g.2)', () => {
  it('creates one field per instance, valued from its own data group, stacked', () => {
    const doc = Document.Open(buildXfaPdf({
      template: FLOW, datasets: data('<R><a>one</a></R><R><a>two</a></R><R><a>three</a></R>'),
    }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.fields.map((f) => [f.name, f.route])).toEqual([
      ['form1[0].Page1[0].R[0].a[0]', 'positioned'],
      ['form1[0].Page1[0].R[1].a[0]', 'positioned'],
      ['form1[0].Page1[0].R[2].a[0]', 'positioned'],
    ]);
    const get = (k: number) => doc.Form.Get(`form1[0].Page1[0].R[${String(k)}].a[0]`)!;
    expect([0, 1, 2].map((k) => get(k).Value)).toEqual(['one', 'two', 'three']);
    const top = (k: number) => (doc.resolve(get(k).Dict.get('Rect')) as number[])[3];
    // tb stacks each 20pt instance directly below the previous one.
    expect(top(0) - top(1)).toBeCloseTo(20, 6);
    expect(top(1) - top(2)).toBeCloseTo(20, 6);
  });

  it('reports the fields of a repeating subform it refuses, with the reason', () => {
    const POS = FLOW.replace('<subform name="Page1" layout="tb">', '<subform name="Page1">');
    const doc = Document.Open(buildXfaPdf({ template: POS, datasets: data('<R/><R/>') }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.fields.map((f) => f.name)).toEqual(['form1[0].Page1[0].R[0].a[0]']);
    expect(r.skipped).toContainEqual(expect.objectContaining({
      what: 'field', name: 'form1[0].Page1[0].R[0].a[0]',
      reason: expect.stringMatching(/2 instances of a repeating subform in a positioned container would overlap/),
    }));
  });
});
