import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const dynamic = (template: string) => Document.Open(buildXfaPdf({ template, pages: 1, needsRendering: true }));
/** US Letter with a 720pt content area: F 600 leaves 120. */
const form = (c: string, d: string) => `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="8.5in" long="11in"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea></pageSet>
  <subform name="F" w="7.5in" h="600pt"/>
  <subform name="C" w="7.5in" h="80pt">${c}<field name="c" x="0" y="0" w="1in" h="0.3in"><ui><textEdit/></ui></field></subform>
  <subform name="D" w="7.5in" h="80pt">${d}<field name="d" x="0" y="0" w="1in" h="0.3in"><ui><textEdit/></ui></field></subform>
  </subform></template>`;
const pageOf = (r: ReturnType<typeof convertXfaToAcroForm>, name: string) => r.fields.find((f) => f.name === name)?.page;

describe('ConvertXfaToAcroForm: adhesion end to end (164g.14)', () => {
  it('moves an adhering pair to the next page together', () => {
    const doc = dynamic(form('<keep next="contentArea"/>', ''));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(doc.Pages).toHaveLength(2);
    expect(pageOf(r, 'form1[0].C[0].c[0]')).toBe(2);
    expect(pageOf(r, 'form1[0].D[0].d[0]')).toBe(2);
  });

  it('names an unprobed shape in report.warnings and keeps today\'s layout', () => {
    const doc = dynamic(form('<keep next="contentArea"/>', '<breakBefore targetType="pageArea"/>'));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.warnings).toContainEqual(expect.stringMatching(/adhesion into a sibling with a breakBefore is not implemented \(164g\.14\)/));
    expect(pageOf(r, 'form1[0].C[0].c[0]')).toBe(1);
    expect(pageOf(r, 'form1[0].D[0].d[0]')).toBe(2);
  });
});
