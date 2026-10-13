import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { decodeStream } from '../src/filters.js';
import { decodeXfaPackets } from '../src/xfapacket.js';
import { parseXfaTemplate } from '../src/xfatemplate.js';
import { widgetStyleOf } from '../src/xfaborder.js';
import { isDict, type PdfDict, type PdfObject } from '../src/types.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const fixture = (f: string) => Document.Open(new Uint8Array(readFileSync(`test/fixtures/xfa/${f}`)));
const tplOf = (doc: Document) => {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  const d = decodeXfaPackets(isDict(acro) ? acro : undefined, (o) => doc.resolve(o), (s) => decodeStream(s));
  if ('reason' in d) throw new Error(d.reason);
  return parseXfaTemplate(d.packets.get('template')!);
};
const r3 = (xs: number[]) => xs.map((x) => Math.round(x * 1000) / 1000);
const nameOf = (o: unknown) => (o as { name: string }).name;

describe('widget borders against what Adobe wrote (164g.4)', () => {
  // IRS f1040's three bordered text fields and DoD DD 1155's Reset button: the
  // only widgets in the corpus whose /AcroForm carries /MK /BC and /BS.
  const CASES: Array<[string, string]> = [
    ['irs-f1040.pdf', 'topmostSubform[0].Page2[0].f2_39[0]'],
    ['irs-f1040.pdf', 'topmostSubform[0].Page2[0].f2_41[0]'],
    ['irs-f1040.pdf', 'topmostSubform[0].Page2[0].f2_43[0]'],
    ['dod-dd1155.pdf', 'form1[0].#pageSet[0].Page1[0].ResetButton[0]'],
  ];
  for (const [file, name] of CASES) {
    it(`maps ${name} as Adobe did`, () => {
      const doc = fixture(file);
      const tpl = tplOf(doc);
      const f = [...tpl.fields, ...tpl.masterPageFields].find((x) => x.name === name)!;
      const ours = widgetStyleOf(f.widgetBorder!)!.style;
      const adobe = doc.Form.Get(name)!.Dict;
      const mk = doc.resolve(adobe.get('MK')) as PdfDict;
      const bs = doc.resolve(adobe.get('BS')) as PdfDict;
      // Adobe writes 0.199997 for 51/255 = 0.2: its own float rounding.
      expect(r3(ours.borderColor!)).toEqual(r3(doc.resolve(mk.get('BC')) as number[]));
      expect(ours.borderWidth).toBe(doc.resolve(bs.get('W')));
      expect(ours.borderStyle).toBe('solid');
      expect(nameOf(bs.get('S'))).toBe('S');
      expect(ours.backgroundColor).toBeUndefined();
      expect(mk.has('BG')).toBe(false);
    });
  }
});

describe('ConvertXfaToAcroForm writes widget borders on fields it creates', () => {
  const TPL = (ui: string, fieldBorder = '') => `<template><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea w="8.5in" h="11in"/></pageArea></pageSet>
    <subform name="Page1" layout="position"><field name="f" x="1in" y="1in" w="2in" h="20pt">${ui}${fieldBorder}</field></subform></subform></template>`;
  const widget = (doc: Document) => doc.Form.Get('form1[0].Page1[0].f[0]')!.Dict;

  it('writes /BS /S /I for a lowered edit-region border', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><textEdit><border><edge stroke="lowered"/></border></textEdit></ui>') }));
    doc.ConvertXfaToAcroForm();
    const bs = doc.resolve(widget(doc).get('BS')) as PdfDict;
    expect(nameOf(bs.get('S'))).toBe('I');
  });

  it('writes /BS /S /B for a raised push-button border', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><button/></ui>', '<border><edge stroke="raised"/></border>') }));
    doc.ConvertXfaToAcroForm();
    const bs = doc.resolve(widget(doc).get('BS')) as PdfDict;
    expect(nameOf(bs.get('S'))).toBe('B');
  });

  it('writes nothing for a field whose template states no widget border', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><textEdit/></ui>') }));
    doc.ConvertXfaToAcroForm();
    expect(widget(doc).has('BS')).toBe(false);
  });

  it('reports an etched widget border, drawn solid', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL('<ui><textEdit><border><edge stroke="etched"/></border></textEdit></ui>') }));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.skipped).toContainEqual({ what: 'chrome', name: 'form1[0].Page1[0].f[0]', reason: 'an etched widget border has no AcroForm counterpart and is drawn solid' });
  });
});

describe('radio groups', () => {
  const GROUP = (b1: string, b2: string) => `<template><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea w="8.5in" h="11in"/></pageArea></pageSet>
    <subform name="Page1" layout="position"><exclGroup name="g">
      <field name="a" x="1in" y="1in" w="12pt" h="12pt"><ui><checkButton shape="round"><border><edge stroke="${b1}"/></border></checkButton></ui><items><text>A</text></items></field>
      <field name="b" x="2in" y="1in" w="12pt" h="12pt"><ui><checkButton shape="round"><border><edge stroke="${b2}"/></border></checkButton></ui><items><text>B</text></items></field>
    </exclGroup></subform></subform></template>`;
  const kids = (doc: Document) => {
    const k = doc.resolve(doc.Form.Get('form1[0].Page1[0].g[0]')!.Dict.get('Kids')) as PdfObject[];
    return k.map((x) => doc.resolve(x) as PdfDict);
  };

  it('gives every widget the first member\'s border', () => {
    const doc = Document.Open(buildXfaPdf({ template: GROUP('lowered', 'lowered') }));
    doc.ConvertXfaToAcroForm();
    for (const w of kids(doc)) expect(nameOf((doc.resolve(w.get('BS')) as PdfDict).get('S'))).toBe('I');
  });

  it('reports members that disagree and uses the first', () => {
    const doc = Document.Open(buildXfaPdf({ template: GROUP('lowered', 'raised') }));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.skipped).toContainEqual({ what: 'chrome', name: 'form1[0].Page1[0].g[0]', reason: "a radio group's members state different widget borders, so the first is used" });
    for (const w of kids(doc)) expect(nameOf((doc.resolve(w.get('BS')) as PdfDict).get('S'))).toBe('I');
  });
});

// Found by the pdf.js chrome oracle: a push button's caption is its FACE, so it
// is never chrome, and the converter created buttons with no /MK /CA -- 28
// labels across OPM 1644 and DD 1494 drawn nowhere and reported nowhere.
describe('push-button captions become /MK /CA (164g.4)', () => {
  const BTN = (caption: string) => `<template><subform name="form1" layout="tb">
    <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea w="8.5in" h="11in"/></pageArea></pageSet>
    <subform name="Page1" layout="position"><field name="b" x="1in" y="1in" w="1in" h="20pt"><ui><button/></ui>${caption}</field></subform></subform></template>`;
  const tplOfXml = (xml: string) => {
    const doc = Document.Open(buildXfaPdf({ template: xml }));
    return { doc, f: tplOf(doc).fields.find((x) => x.name === 'form1[0].Page1[0].b[0]')! };
  };
  const caOf = (doc: Document) => {
    const mk = doc.resolve(doc.Form.Get('form1[0].Page1[0].b[0]')!.Dict.get('MK')) as PdfDict | null;
    if (!isDict(mk)) return undefined;
    const ca = mk.get('CA') as { bytes: Uint8Array } | undefined;
    return ca === undefined ? undefined : new TextDecoder('latin1').decode(ca.bytes);
  };

  it('reads a plain-text caption', () => {
    expect(tplOfXml(BTN('<caption><value><text>Print Form</text></value></caption>')).f.buttonCaption).toBe('Print Form');
  });

  it('reads a rich-text caption, spacerun spans included', () => {
    const rich = '<caption><value><exData contentType="text/html"><body xmlns="http://www.w3.org/1999/xhtml"><p>Reset<span style="xfa-spacerun:yes">  </span>Page</p></body></exData></value></caption>';
    expect(tplOfXml(BTN(rich)).f.buttonCaption).toBe('Reset Page');
  });

  it('reads no caption that is hidden or invisible', () => {
    expect(tplOfXml(BTN('<caption presence="hidden"><value><text>X</text></value></caption>')).f.buttonCaption).toBeUndefined();
    expect(tplOfXml(BTN('<caption presence="invisible"><value><text>X</text></value></caption>')).f.buttonCaption).toBeUndefined();
  });

  it('writes the caption as /MK /CA on a button it creates', () => {
    const { doc } = tplOfXml(BTN('<caption><value><text>Print Form</text></value></caption>'));
    doc.ConvertXfaToAcroForm();
    expect(caOf(doc)).toBe('Print Form');
  });

  it('writes no /CA for a button with no caption', () => {
    const { doc } = tplOfXml(BTN(''));
    doc.ConvertXfaToAcroForm();
    expect(caOf(doc)).toBeUndefined();
  });

  it("matches the /CA Adobe wrote for DD 1155's Reset button", () => {
    const name = 'form1[0].#pageSet[0].Page1[0].ResetButton[0]';
    const src = fixture('dod-dd1155.pdf');
    const adobe = src.resolve(src.Form.Get(name)!.Dict.get('MK')) as PdfDict;
    const adobeCa = new TextDecoder('latin1').decode((adobe.get('CA') as { bytes: Uint8Array }).bytes);
    const f = tplOf(src).masterPageFields.find((x) => x.name === name)!;
    expect(f.buttonCaption).toBe(adobeCa.trim());
  });
});
