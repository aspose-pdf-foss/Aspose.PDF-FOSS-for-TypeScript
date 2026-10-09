import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildXfaPlan, convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

// cb07: two real USCIS hybrid forms made ConvertXfaToAcroForm THROW, where its
// contract is to report what it cannot convert. i-130's State lists repeat the
// export 'UT' and one list carries an empty item -- both in Adobe's own /Opt --
// and i-765's datasets bind an EMPTY datum to its State lists.

const NAME = 'form1[0].Page1[0].st[0]';

/** One positioned choice list; `items` is the template's item list. */
const choiceTemplate = (items: string): string => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
  <subform name="Page1" layout="position">
    <field name="st" x="1in" y="2in" w="3in" h="20pt"><ui><choiceList/></ui>
      <items>${items}</items></field>
  </subform></subform></template>`;

const datum = (body: string): string =>
  `<xfa:datasets><xfa:data><form1><Page1>${body}</Page1></form1></xfa:data></xfa:datasets>`;

/** The XFA document plus an AcroForm choice field of the same SOM name -- the
 *  hybrid shape LiveCycle writes, so conversion RECONCILES rather than creates. */
function hybrid(data: string): Document {
  const doc = Document.Open(buildXfaPdf({
    template: choiceTemplate('<text>AL</text><text>UT</text>'), datasets: datum(data),
  }));
  doc.Form.AddComboBox({ page: 1, rect: [72, 628, 288, 648], name: NAME, options: ['AL', 'UT'] });
  return doc;
}

describe('ConvertXfaToAcroForm: a template item list is data, not caller input', () => {
  it('keeps a repeated export and an empty export as written (i-130)', () => {
    const items = '<text>AL</text><text>UT</text><text>UT</text><text></text>';
    const p = buildXfaPlan(Document.Open(buildXfaPdf({ template: choiceTemplate(items) })), {});
    expect(p.entries[0].options?.map((o) => o.export)).toEqual(['AL', 'UT', 'UT', '']);
  });

  it('creates the field with that /Opt rather than throwing', () => {
    const doc = Document.Open(buildXfaPdf({
      template: choiceTemplate('<text>AL</text><text>UT</text><text>UT</text>'),
    }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.fields.map((f) => f.name)).toEqual([NAME]);
    expect(Document.Open(doc.Save()).Form.Get(NAME)!.Options).toEqual(['AL', 'UT', 'UT']);
  });
});

describe('ConvertXfaToAcroForm: an empty datum on a choice list is no selection', () => {
  it('binds no value in the plan (i-765)', () => {
    const p = buildXfaPlan(Document.Open(buildXfaPdf({
      template: choiceTemplate('<text>AL</text><text>UT</text>'), datasets: datum('<st/>'),
    })), {});
    expect(p.entries[0].value).toBeUndefined();
  });

  it('reconciles an existing field without throwing and selects nothing', () => {
    const doc = hybrid('<st></st>');
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.skipped).toEqual([]);
    expect(doc.Form.Get(NAME)!.Dict.has('V')).toBe(false);
  });

  it('still selects a datum the list offers', () => {
    const doc = hybrid('<st>UT</st>');
    convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Form.Get(NAME)!.Value).toBe('UT');
  });
});

describe('ConvertXfaToAcroForm: a reconcile the field refuses is reported, not thrown', () => {
  it('reports a datum the existing /Opt does not offer and leaves the field alone', () => {
    const doc = hybrid('<st>ZZ</st>');
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.skipped).toEqual([expect.objectContaining({ what: 'field', name: NAME })]);
    expect(r.skipped[0].reason).toContain('ZZ');
    expect(doc.Form.Get(NAME)!.Dict.has('V')).toBe(false);
  });
});

// fdq3: a radio group's selection binds by the GROUP's data path, which leaves
// an unnamed container out where the SOM name spells it `#subform[0]`.
describe('ConvertXfaToAcroForm: a radio group under an unnamed subform binds its datum', () => {
  it('selects the datum by the data path, not the SOM name', () => {
    const p = buildXfaPlan(Document.Open(buildXfaPdf({
      template: `<template><subform name="form1" layout="tb">
        <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/></pageArea></pageSet>
        <subform layout="position"><exclGroup name="colour">
          <field name="r" x="1in" y="1in" w="20pt" h="20pt"><ui><checkButton/></ui>
            <items><text>Red</text></items></field>
          <field name="g" x="1in" y="2in" w="20pt" h="20pt"><ui><checkButton/></ui>
            <items><text>Green</text></items></field>
        </exclGroup></subform></subform></template>`,
      datasets: '<xfa:datasets><xfa:data><form1><colour>Green</colour></form1></xfa:data></xfa:datasets>',
    })), {});
    expect(p.groups.map((g) => [g.name, g.selected]))
      .toEqual([['form1[0].#subform[0].colour[0]', 'Green']]);
  });
});
