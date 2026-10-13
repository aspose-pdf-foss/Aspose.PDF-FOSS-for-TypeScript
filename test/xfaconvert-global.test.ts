// test/xfaconvert-global.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const LETTER = '<medium short="8.5in" long="11in"/>';
const DATA = (inner: string) => `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>${inner}</xfa:data></xfa:datasets>`;
const TPL = (body: string, master = '') => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><occur max="2"/>${LETTER}<contentArea x="0.5in" y="0.5in" w="7.5in" h="9in"/>${master}</pageArea></pageSet>
  <subform name="A" layout="position" w="7.5in" h="9in">${body}</subform>
  <subform name="B" layout="position" w="7.5in" h="9in"/></subform></template>`;
const TEXT = (n: string, bind = '<bind match="global"/>') =>
  `<field name="${n}" x="1in" y="1in" w="2in" h="20pt">${bind}<ui><textEdit/></ui></field>`;
const convert = (template: string, datasets?: string) => {
  const doc = Document.Open(buildXfaPdf({ template, pages: 2, ...(datasets ? { datasets } : {}) }));
  return { doc, r: convertXfaToAcroForm(doc, { removeXfa: false }) };
};

describe('ConvertXfaToAcroForm: bind match="global" (yy09)', () => {
  it('binds a body field to a datum stored at the record root', () => {
    const { doc } = convert(TPL(TEXT('who')), DATA('<form1><who>Ada</who><A/></form1>'));
    expect(doc.Form.Get('form1[0].A[0].who[0]')!.Value).toBe('Ada');
  });

  it('gives every master-page instance the one global value', () => {
    const { doc, r } = convert(TPL('', TEXT('stamp').replace('y="1in"', 'y="10in"')),
      DATA('<form1><stamp>CUI</stamp></form1>'));
    const names = r.fields.filter((f) => f.name.includes('#pageSet')).map((f) => f.name);
    expect(names).toEqual(['form1[0].#pageSet[0].P1[0].stamp[0]', 'form1[0].#pageSet[0].P1[1].stamp[0]']);
    expect(names.map((n) => doc.Form.Get(n)!.Value)).toEqual(['CUI', 'CUI']);
    expect(r.warnings.join('\n')).not.toMatch(/yy09/);
  });

  it('leaves a master-page field with neither dataRef nor global unbound', () => {
    const { doc } = convert(TPL('', TEXT('stamp', '').replace('y="1in"', 'y="10in"')),
      DATA('<form1><stamp>CUI</stamp></form1>'));
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('');
  });

  it('warns once for a name that is global on one field and ordinary on another', () => {
    const { r } = convert(TPL(TEXT('n') + TEXT('n', '').replace('y="1in"', 'y="3in"')), DATA('<form1><n>x</n></form1>'));
    expect(r.warnings.filter((w) => /"n".*global on some fields and ordinary on others/.test(w))).toHaveLength(1);
  });

  it('warns once for an exclGroup stating match="global", and binds it by its own path', () => {
    const group = `<exclGroup name="g" x="1in" y="4in"><bind match="global"/>
      <field name="r1" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>1</text></items></field>
      <field name="r2" x="20pt" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>2</text></items></field></exclGroup>`;
    const { r } = convert(TPL(group), DATA('<form1><A><g>2</g></A></form1>'));
    expect(r.warnings.filter((w) => /exclGroup.*match="global"/.test(w))).toHaveLength(1);
  });

  // Review Focus 5: a global choice list bound outside its /Opt is reported, never thrown.
  it('reports a global choice-list datum its /Opt lacks', () => {
    const list = `<field name="pick" x="1in" y="5in" w="2in" h="20pt"><bind match="global"/><ui><choiceList/></ui>
      <items><text>One</text><text>Two</text></items></field>`;
    const { doc, r } = convert(TPL(list), DATA('<form1><pick>Nine</pick></form1>'));
    expect(r.skipped).toContainEqual({ what: 'field', name: 'form1[0].A[0].pick[0]',
      reason: "the data value is not one of the field's options, so it is not set" });
    expect(doc.Form.Get('form1[0].A[0].pick[0]')!.Dict.has('V')).toBe(false);
  });

  it('keeps a created choice-list datum its /Opt holds, and an editable one whatever it says', () => {
    const list = (open = '') => `<field name="pick" x="1in" y="5in" w="2in" h="20pt"><bind match="global"/><ui><choiceList${open}/></ui>
      <items><text>One</text><text>Two</text></items></field>`;
    expect(convert(TPL(list()), DATA('<form1><pick>Two</pick></form1>')).doc.Form.Get('form1[0].A[0].pick[0]')!.Value).toBe('Two');
    const edit = convert(TPL(list(' open="userControl"')), DATA('<form1><pick>Nine</pick></form1>'));
    expect(edit.doc.Form.Get('form1[0].A[0].pick[0]')!.Value).toBe('Nine');
    expect(edit.r.skipped).toEqual([]);
  });

  it('measures a growable global field with the value it will carry', () => {
    const grow = `<field name="note" x="1in" y="6in" w="2in" minH="12pt"><bind match="global"/><font typeface="Arial" size="10pt"/><ui><textEdit multiLine="1"/></ui></field>`;
    const long = 'word '.repeat(60).trim();
    const short = convert(TPL(grow), DATA('<form1><note>a</note></form1>'));
    const tall = convert(TPL(grow), DATA(`<form1><note>${long}</note></form1>`));
    const h = (d: Document) => { const r = d.resolve(d.Form.Get('form1[0].A[0].note[0]')!.Dict.get('Rect')) as number[]; return r[3] - r[1]; };
    expect(h(tall.doc)).toBeGreaterThan(h(short.doc));
  });
});
