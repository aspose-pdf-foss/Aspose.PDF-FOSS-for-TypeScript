// test/xfaconvert-chrome.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const TPL = (body: string, master = '') => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea x="0" y="0" w="8.5in" h="11in"/>${master}</pageArea></pageSet>
  <subform name="Page1" layout="position" w="8.5in" h="11in">${body}</subform></subform></template>`;
const FIELD = '<field name="f" x="1in" y="1in" w="3in" h="20pt"><font typeface="Arial"/><ui><textEdit/></ui><caption reserve="1in"><value><text>Name</text></value></caption></field>';
const DRAW = '<draw x="1in" y="3in" w="3in" h="14pt"><font typeface="Arial" size="10pt"/><value><text>Hello chrome</text></value><border><edge/></border></draw>';
const dynamic = (template: string) => Document.Open(buildXfaPdf({ template, pages: 1, needsRendering: true }));
const reopen = (d: Document) => Document.Open(d.Save());

describe('ConvertXfaToAcroForm paints chrome on the pages it creates (164g.4)', () => {
  it('draws the draw text and the field caption on the created page', () => {
    const doc = dynamic(TPL(FIELD + DRAW));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.pagesCreated).toBe(1);
    expect(r.chromePages).toBe(1);
    const text = reopen(doc).Pages[0].GetText();
    expect(text).toContain('Hello chrome');
    expect(text).toContain('Name');
  });

  it('never paints a field value as page content', () => {
    const doc = Document.Open(buildXfaPdf({
      template: TPL(FIELD), pages: 1, needsRendering: true,
      datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><Page1><f>SECRET</f></Page1></form1></xfa:data></xfa:datasets>',
    }));
    doc.ConvertXfaToAcroForm();
    const d2 = reopen(doc);
    const frags = d2.Pages[0].GetTextFragments({ includeAnnotations: false } as never).map((f) => f.text).join(' ');
    expect(frags).not.toContain('SECRET');
  });

  it('paints master-page chrome on every page of that area', () => {
    const master = '<draw x="0.5in" y="0.2in" w="2in" h="12pt"><font typeface="Arial"/><value><text>CUI MARK</text></value></draw>';
    const two = `<template><subform name="form1" layout="tb">
      <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/><contentArea x="0" y="0" w="8.5in" h="11in"/>${master}</pageArea></pageSet>
      <subform name="A" layout="position" w="8.5in" h="11in">${FIELD}</subform>
      <subform name="B" layout="position" w="8.5in" h="11in"><breakBefore targetType="pageArea"/>${DRAW}</subform></subform></template>`;
    const doc = dynamic(two);
    const r = doc.ConvertXfaToAcroForm();
    expect(r.pagesCreated).toBe(2);
    const d2 = reopen(doc);
    expect(d2.Pages.map((p) => p.GetText().includes('CUI MARK'))).toEqual([true, true]);
  });

  // Review Focus 2: placeholder pages kept, so no chrome on them.
  it('paints nothing when the placeholder pages are kept', () => {
    const doc = dynamic(TPL('<field name="s" x="1in" y="1in" w="1in" h="1in"><ui><signature/></ui></field>' + DRAW));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.pagesCreated).toBe(0);
    expect(r.chromePages).toBe(0);
    expect(reopen(doc).Pages[0].GetText()).not.toContain('Hello chrome');
  });

  // The case above converts NOTHING (a signature is refused), so the converter
  // returns before it decides about the placeholder and the kept-pages branch
  // is never reached. A field converted BARE (a px width is refused, 164g.1)
  // reaches it: something converts, no body content is placed.
  it('paints nothing when a bare field keeps the placeholder pages', () => {
    const doc = dynamic(TPL('<field name="b" x="1in" y="1in" w="72px" h="20pt"><ui><textEdit/></ui></field>' + DRAW));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.fields.length).toBe(1);
    expect(r.pagesCreated).toBe(0);
    expect(r.chromePages).toBe(0);
    expect(reopen(doc).Pages[0].GetText()).not.toContain('Hello chrome');
  });

  // Review Focus 1: a face nothing resolves -- refused at layout, reported, no throw.
  it('reports a draw in a face nothing resolves and paints the rest', () => {
    const missing = '<draw x="1in" y="5in" w="3in"><font typeface="NoSuchFace"/><value><text>gone</text></value></draw>';
    const doc = dynamic(TPL(FIELD + DRAW + missing));
    const r = doc.ConvertXfaToAcroForm();
    expect(r.skipped.filter((s) => s.what === 'chrome').map((s) => s.reason).join('\n')).toMatch(/NoSuchFace/);
    expect(reopen(doc).Pages[0].GetText()).toContain('Hello chrome');
  });

  it('paints nothing on a hybrid, which reports chromePages 0', () => {
    const doc = Document.Open(buildXfaPdf({ template: TPL(FIELD + DRAW), pages: 1, acroFieldObjects: ['{HYBRID}'] }));
    expect(doc.ConvertXfaToAcroForm().chromePages).toBe(0);
  });
});
