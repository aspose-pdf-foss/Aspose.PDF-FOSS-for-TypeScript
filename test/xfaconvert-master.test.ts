import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { convertXfaToAcroForm, buildXfaPlan } from '../src/xfaconvert.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

// d3mq part 2. A master page (<pageArea>) is laid out from the PAGE origin
// (XFA 3.3 p. 271, 288); instance n of a field is on the n-th page that
// instantiates its page area.

const LETTER = '<medium short="8.5in" long="11in"/>';

/** Pages P1, P1, P2: P1 may occur twice, each body subform fills a content
 *  area, so the third falls through to P2 (XFA 3.3 p. 298-300) -- all within
 *  ONE page-set instance. (Going BACK from P2 to P1 would open a second
 *  page-set instance, which master fields refuse; 164g.3 pins that rule.)
 *  Per-page-area numbering names the P2 instance P2[0]; a page index would say
 *  P2[2]. P1 carries a text field 'stamp' at x=1in y=10in; P2 carries 'mark' at
 *  x=2in y=0.5in. */
const P1_P1_P2 = (o: { p1Max?: string; p2Max?: string; psMax?: string; kids?: number } = {}) => `<template><subform name="form1" layout="tb">
  <pageSet>${o.psMax !== undefined ? `<occur max="${o.psMax}"/>` : ''}
    <pageArea name="P1"><occur max="${o.p1Max ?? '2'}"/>${LETTER}<contentArea x="0.5in" y="0.5in" w="7.5in" h="9in"/>
      <field name="stamp" x="1in" y="10in" w="2in" h="20pt"><ui><textEdit/></ui></field></pageArea>
    <pageArea name="P2">${o.p2Max !== undefined ? `<occur max="${o.p2Max}"/>` : ''}${LETTER}<contentArea x="0.5in" y="1in" w="7.5in" h="9in"/>
      <field name="mark" x="2in" y="0.5in" w="1in" h="12pt"><ui><textEdit/></ui></field></pageArea>
  </pageSet>
  ${['A', 'B', 'C', 'D'].slice(0, o.kids ?? 3).map((k) => `<subform name="${k}" w="7.5in" h="9in"/>`).join('\n  ')}
  </subform></template>`;
const ALTERNATING = P1_P1_P2();

const convert = (template: string, o: { pages?: number; datasets?: string; mediaBox?: [number, number, number, number] } = {}) => {
  const doc = Document.Open(buildXfaPdf({ template, ...o }));
  return { doc, r: convertXfaToAcroForm(doc, { removeXfa: false }) };
};
const rect = (doc: Document, n: string) => doc.resolve(doc.Form.Get(n)!.Dict.get('Rect')) as number[];

describe('ConvertXfaToAcroForm: master-page fields, one instance per page (d3mq)', () => {
  it('numbers instances per PAGE AREA, not per page', () => {
    const { doc, r } = convert(ALTERNATING, { pages: 3 });
    const master = r.fields.filter((f) => f.name.includes('#pageSet')).map((f) => [f.name, f.page]);
    expect(master).toEqual([
      ['form1[0].#pageSet[0].P1[0].stamp[0]', 1],
      ['form1[0].#pageSet[0].P1[1].stamp[0]', 2],
      ['form1[0].#pageSet[0].P2[0].mark[0]', 3],
    ]);
    // From the PAGE origin, not the content area: x = 72, top = 792 - 720.
    expect(rect(doc, 'form1[0].#pageSet[0].P1[1].stamp[0]')).toEqual([72, 52, 216, 72]);
    expect(rect(doc, 'form1[0].#pageSet[0].P2[0].mark[0]')).toEqual([144, 744, 216, 756]);
  });

  it('creates nothing for a field the layout refuses, and reports it ONCE', () => {
    const T = ALTERNATING.replace('<field name="stamp"', '<field name="stamp" presence="hidden"');
    const { doc, r } = convert(T, { pages: 3 });
    expect(r.fields.some((f) => f.name.includes('stamp'))).toBe(false);
    const s = r.skipped.filter((x) => x.name?.includes('stamp'));
    expect(s.map((x) => x.name)).toEqual(['form1[0].#pageSet[0].P1[0].stamp[0]']);
    expect(s[0].reason).toMatch(/presence="hidden".*no instance is created/);
    expect(doc.Form.Fields.some((f) => f.FullName.includes('stamp'))).toBe(false);
  });

  it('reports a field refused for its UI kind once PER INSTANCE, by the instance name', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><ui><textEdit/></ui>',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><ui><barcode type="pdf417"/></ui>');
    const { r } = convert(T, { pages: 3 });
    expect(r.skipped.filter((x) => x.name?.includes('stamp')).map((x) => x.name)).toEqual([
      'form1[0].#pageSet[0].P1[0].stamp[0]', 'form1[0].#pageSet[0].P1[1].stamp[0]',
    ]);
  });

  it('carries a subform\'s offset to the field inside it', () => {
    const T = ALTERNATING.replace('<field name="mark" x="2in" y="0.5in" w="1in" h="12pt"><ui><textEdit/></ui></field>',
      '<subform name="Footer" x="1in" y="10in"><field name="mark" x="2in" y="6pt" w="1in" h="12pt"><ui><textEdit/></ui></field></subform>');
    const { doc } = convert(T, { pages: 3 });
    // x = 72 + 144; top = 720 + 6 from the page top.
    expect(rect(doc, 'form1[0].#pageSet[0].P2[0].Footer[0].mark[0]')).toEqual([216, 54, 288, 66]);
  });

  it('binds an explicit dataRef, every instance sharing the one value (XFA 3.3 p. 271)', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt">',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><bind match="dataRef" ref="$data.form1.hdr.code"/>');
    const { doc } = convert(T, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><hdr><code>X-7</code></hdr></form1></xfa:data></xfa:datasets>' });
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('X-7');
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[1].stamp[0]')!.Value).toBe('X-7');
  });

  // c3jq: $record is the OUTER data element (XFA 3.3 p. 91-92), so the same
  // datum is $record.hdr.code -- the ref a form written that way states.
  it('binds a $record dataRef under the outer data element', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt">',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><bind match="dataRef" ref="$record.hdr.code"/>');
    const { doc } = convert(T, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><hdr><code>X-7</code></hdr></form1></xfa:data></xfa:datasets>' });
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('X-7');
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[1].stamp[0]')!.Value).toBe('X-7');
  });

  it('does NOT bind by name: a page-background field needs an explicit reference (p. 271)', () => {
    // The datum sits at the master field's own DATA path (`stamp[0]`: a master
    // page is walked from an empty data path), so an implicit name match WOULD
    // find it -- measured: a dataset under <form1> left this case green with
    // name binding switched on.
    const { doc } = convert(ALTERNATING, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><stamp>no</stamp></xfa:data></xfa:datasets>' });
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].stamp[0]')!.Value).toBe('');
  });

  it('binds match="global" instances and no longer warns about yy09', () => {
    const T = ALTERNATING.replace('<field name="stamp" x="1in" y="10in" w="2in" h="20pt">',
      '<field name="stamp" x="1in" y="10in" w="2in" h="20pt"><bind match="global"/>');
    const { doc, r } = convert(T, { pages: 3, datasets: '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><stamp>S</stamp></form1></xfa:data></xfa:datasets>' });
    expect(r.warnings.join('\n')).not.toMatch(/yy09/);
    const stamps = r.fields.filter((f) => f.name.includes('stamp')).map((f) => f.name);
    expect(stamps).toHaveLength(2);
    expect(stamps.map((n) => doc.Form.Get(n)!.Value)).toEqual(['S', 'S']);
  });

  it('refuses a radio group on a master page, once', () => {
    const T = ALTERNATING.replace('<field name="mark" x="2in" y="0.5in" w="1in" h="12pt"><ui><textEdit/></ui></field>',
      `<exclGroup name="g" x="2in" y="0.5in"><field name="a" w="10pt" h="10pt"><ui><checkButton shape="round"/></ui><items><text>1</text></items></field></exclGroup>`);
    const { r } = convert(T, { pages: 3 });
    const s = r.skipped.filter((x) => x.name?.includes('.g[0].'));
    expect(s.map((x) => x.reason)).toEqual([expect.stringMatching(/exclGroup.*master page/)]);
  });

  it('reports a page area no page instantiates, once', () => {
    // Two pages, both P1: P2 is never instantiated.
    const { r } = convert(P1_P1_P2({ kids: 2 }), { pages: 2 });
    expect(r.skipped.filter((x) => x.name?.includes('mark'))).toEqual([{
      what: 'field', name: 'form1[0].#pageSet[0].P2[0].mark[0]',
      reason: expect.stringMatching(/no laid-out page is an instance of its <pageArea>/) as unknown as string,
    }]);
  });

  // Final review: an UNNAMED <pageArea> is still paginated onto pages, but the
  // walk skipped it, so its fields vanished with no report entry.
  it('reports a field on an UNNAMED page area rather than losing it silently', () => {
    const T = ALTERNATING.replace('<pageArea name="P2">', '<pageArea>');
    const { r } = convert(T, { pages: 3 });
    const s = r.skipped.filter((x) => x.name?.includes('mark'));
    expect(s.map((x) => x.name)).toEqual(['form1[0].#pageSet[0].#pageArea[0].mark[0]']);
    expect(s[0].reason).toMatch(/unnamed <pageArea>/);
    expect(r.fields.some((f) => f.name.includes('mark'))).toBe(false);
  });

  it('refuses every master field when pagination opens a second page-set instance', () => {
    // P1 once, P2 once, then the third page needs a NEW page-set instance.
    const { r } = convert(P1_P1_P2({ p1Max: '1', p2Max: '1', psMax: '2' }), { pages: 3 });
    expect(r.fields.some((f) => f.name.includes('#pageSet'))).toBe(false);
    expect(r.skipped.filter((x) => x.name?.includes('#pageSet')).map((x) => x.reason))
      .toEqual([expect.stringMatching(/second page-set instance/), expect.stringMatching(/second page-set instance/)]);
  });

  it('skips a page whose medium disagrees, and keeps every other page\'s instances', () => {
    // Every page of this PDF is A4; the template says Letter. Only the medium
    // check can fail here, so the case asserts the per-page skip directly via
    // the plan, where each page's medium is compared on its own.
    const doc = Document.Open(buildXfaPdf({ template: ALTERNATING, pages: 3, mediaBox: [0, 0, 595.28, 841.89] }));
    const p = buildXfaPlan(doc, {});
    expect(p.report.skipped.filter((x) => x.what === 'page')).toHaveLength(3);
    expect(p.entries.filter((e) => e.master)).toEqual([]);
  });

  it('does not let master instances alone replace a dynamic document\'s placeholder pages', () => {
    // The body places nothing (its only field is hidden), so the placeholder is
    // kept, and the master instance is dropped and reported.
    const T = `<template><subform name="form1" layout="tb">
      <pageSet><pageArea name="P1">${LETTER}<contentArea w="8.5in" h="11in"/>
        <field name="cui" x="1in" y="0.2in" w="2in" h="12pt"><ui><textEdit/></ui></field></pageArea></pageSet>
      <subform name="Page1" w="8.5in" h="11in"><field name="body" presence="hidden" x="1in" y="1in" w="1in" h="12pt"><ui><textEdit/></ui></field></subform>
      </subform></template>`;
    const doc = Document.Open(buildXfaPdf({ template: T, pages: 1, needsRendering: true }));
    const r = convertXfaToAcroForm(doc, { removeXfa: false });
    expect(r.pagesCreated).toBe(0);
    expect(doc.Form.Get('form1[0].#pageSet[0].P1[0].cui[0]')).toBeUndefined();
    expect(r.skipped).toContainEqual(expect.objectContaining({
      name: 'form1[0].#pageSet[0].P1[0].cui[0]', reason: expect.stringMatching(/placeholder/) as unknown as string,
    }));
  });
});
