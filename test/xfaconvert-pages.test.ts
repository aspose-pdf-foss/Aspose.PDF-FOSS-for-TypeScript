import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

// A4 on purpose: the placeholder page buildXfaPdf writes is US Letter, so a
// page sized from the PLACEHOLDER rather than the <medium> is visible.
const TWO_PAGES = `<template><subform name="form1" layout="tb">
  <pageSet><pageArea name="P1"><medium short="210mm" long="297mm"/>
    <contentArea w="210mm" h="297mm"/></pageArea></pageSet>
  <subform name="Page1" w="210mm" h="297mm">
    <field name="a" x="1in" y="1in" w="2in" h="20pt"><ui><textEdit/></ui></field></subform>
  <subform name="Page2" w="210mm" h="297mm"><break before="pageArea" startNew="1"/>
    <field name="b" x="1in" y="2in" w="2in" h="20pt"><ui><textEdit/></ui></field></subform>
  </subform></template>`;

const dynamic = (template: string) => Document.Open(buildXfaPdf({ template, pages: 1, needsRendering: true }));
const A4: [number, number] = [595.2755905511812, 841.8897637795276];

describe('ConvertXfaToAcroForm: a dynamic document gets the pages its layout produces', () => {
  it('replaces the placeholder with one page per laid-out page, sized from the medium', () => {
    const doc = dynamic(TWO_PAGES);
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(2);
    expect(doc.Pages).toHaveLength(2);
    for (const p of doc.Pages) {
      expect(p.MediaBox[2]).toBeCloseTo(A4[0], 6);
      expect(p.MediaBox[3]).toBeCloseTo(A4[1], 6);
    }
    expect(r.warnings).toContainEqual(expect.stringMatching(/1 placeholder page\(s\) were replaced by the 2 page\(s\) the layout produced/));
    expect(r.fields.map((f) => [f.name, f.route, f.page])).toEqual([
      ['form1[0].Page1[0].a[0]', 'positioned', 1],
      ['form1[0].Page2[0].b[0]', 'positioned', 2],
    ]);
    // b sits 2in from the top of an A4 page.
    const rect = doc.resolve(doc.Form.Get('form1[0].Page2[0].b[0]')!.Dict.get('Rect')) as number[];
    expect(rect[3]).toBeCloseTo(A4[1] - 144, 6);
  });

  it('survives a save and reopen', () => {
    const doc = dynamic(TWO_PAGES);
    convertXfaToAcroForm(doc);
    const again = Document.Open(doc.Save());
    expect(again.Pages).toHaveLength(2);
    expect(again.Form.Get('form1[0].Page2[0].b[0]')).toBeDefined();
  });

  // Review Focus 2: replacing pages is one-way, so it happens only when
  // something is placed.
  it('leaves the document byte-identical when nothing would be placed', () => {
    const bytes = buildXfaPdf({ template: TWO_PAGES.replace(/<ui><textEdit\/><\/ui>/g, '<ui><signature/></ui>'), pages: 1, needsRendering: true });
    const doc = Document.Open(bytes);
    const before = doc.Save();
    const r = convertXfaToAcroForm(doc);
    expect(r.pagesCreated).toBe(0);
    expect(doc.Pages).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(doc.Save()), Buffer.from(before))).toBe(0);
  });

  // The case the guard exists for: the pages lay out, but every field is left
  // without geometry (here a rotate), so nothing would sit on the new pages.
  // The test above returns before the guard is ever asked.
  it('keeps the placeholder when the fields convert but none is placed', () => {
    const doc = dynamic(TWO_PAGES.replace(/<field name="(a|b)" /g, '<field name="$1" rotate="90" '));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.fields.map((f) => f.route)).toEqual(['bare', 'bare']);
    expect(r.pagesCreated).toBe(0);
    expect(doc.Pages).toHaveLength(1);
  });

  it('refuses the whole document when a laid-out page has no readable medium', () => {
    const doc = dynamic(TWO_PAGES.replace('<medium short="210mm" long="297mm"/>', ''));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(0);
    expect(doc.Pages).toHaveLength(1);
    expect(r.skipped).toContainEqual(expect.objectContaining({
      what: 'document', reason: expect.stringMatching(/page 1's pageArea states no readable <medium>/) as unknown as string,
    }));
    expect(r.fields.every((f) => f.route === 'bare')).toBe(true);
  });

  it('treats a document with AcroForm fields as a hybrid, whose count must match', () => {
    const doc = Document.Open(buildXfaPdf({ template: TWO_PAGES, pages: 1, needsRendering: true, acroFieldObjects: ['{HYBRID}'] }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(0);
    expect(r.skipped).toContainEqual(expect.objectContaining({
      what: 'document', reason: expect.stringMatching(/layout produces 2 page\(s\) and the document has 1/) as unknown as string,
    }));
  });

  it('reports pagesCreated 0 for an ordinary hybrid conversion', () => {
    const doc = Document.Open(buildXfaPdf({ template: TWO_PAGES, pages: 2, mediaBox: [0, 0, A4[0], A4[1]] }));
    expect(convertXfaToAcroForm(doc, { removeXfa: false }).pagesCreated).toBe(0);
  });
});
