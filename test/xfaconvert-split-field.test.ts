import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { decodeStream } from '../src/filters.js';
import { isStream, type PdfDict, type PdfObject } from '../src/types.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

const probe = (n: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/xfa-adobe/${n}.pdf`, import.meta.url)));
const latin = (b: Uint8Array): string => Buffer.from(b).toString('latin1');
const TEN = Array.from({ length: 10 }, (_, i) => `line ${String(i + 1).padStart(2, '0')}`).join('\n');

/** A probe's body rebuilt as the probe script builds it (without the docReady
 *  report and the config packet only Reader needs), with `f` bound to `datum`. */
function variant(name: string, o: { datum?: string; edit?: (body: string) => string; pageArea?: string } = {}): Uint8Array {
  let body = readFileSync(new URL(`./fixtures/xfa-adobe/${name}.xml`, import.meta.url), 'utf8');
  if (o.edit) body = o.edit(body);
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/2.8/"><subform name="form1" layout="tb" locale="en_US">
  <pageSet>${o.pageArea ?? `<pageArea name="P1" id="P1"><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea>`}</pageSet>
  <subform name="oracle" layout="tb" w="7.5in"><field name="out" w="7.5in" h="3in"><ui><textEdit multiLine="1"/></ui></field></subform>
  ${body}
</subform></template>`;
  const data = o.datum === undefined ? '<xfa:data/>'
    : `<xfa:data><form1><pos><f>${o.datum}</f></pos></form1></xfa:data>`;
  return buildXfaPdf({ template, needsRendering: true, singleStream: true,
    datasets: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/">${data}</xfa:datasets>` });
}

function converted(bytes: Uint8Array) {
  const src = Document.Open(bytes);
  const report = src.ConvertXfaToAcroForm();
  const doc = Document.Open(src.Save());
  const fld = doc.Form.Fields.find((f) => f.FullName === 'form1[0].pos[0].f[0]');
  const kids = fld ? ((doc.resolve(fld.Dict.get('Kids')) ?? []) as PdfObject[]).map((k) => doc.resolve(k) as PdfDict) : [];
  const apText = (w: PdfDict): string => {
    const ap = doc.resolve(w.get('AP')) as PdfDict | undefined;
    const n = ap ? doc.resolve(ap.get('N')) : undefined;
    return n && isStream(n) ? latin(decodeStream(n)) : '';
  };
  return { doc, report, fld, kids, apText };
}

describe('ConvertXfaToAcroForm: a field Adobe splits (164g.13)', () => {
  // t45: ten lines, 5 on page 1 (60pt) and 5 on page 2 (70pt).
  it('creates one field with a widget per piece, each on its own page', () => {
    const { doc, fld, kids } = converted(probe('t45'));
    expect(kids.length).toBe(2);
    expect(fld!.Dict.has('Rect')).toBe(false);
    const pageOf = (w: PdfDict) => doc.Pages.findIndex((pg) => ((doc.resolve(pg.Dict.get('Annots')) ?? []) as PdfObject[])
      .some((a) => doc.resolve(a) === w)) + 1;
    expect(kids.map(pageOf)).toEqual([1, 2]);
    expect(kids.map((w) => { const r = doc.resolve(w.get('Rect')) as number[]; return Math.round(r[3] - r[1]); })).toEqual([60, 70]);
  });
  it('shows each widget its own lines of the bound value, and keeps the whole value', () => {
    const { fld, kids, apText } = converted(variant('t45', { datum: TEN }));
    expect(String(fld!.Value)).toContain('line 10');
    const [a, b] = kids.map(apText);
    expect(a).toContain('line 05');
    expect(a).not.toContain('line 06');
    expect(b).toContain('line 06');
    expect(b).toContain('line 10');
    expect(b).not.toContain('line 05');
  });
  // The converter's rule for every field: /V from the data, the template's
  // <value> as /DV, and a widget draws /V -- so a default alone draws nothing.
  it('draws nothing for a template default alone, which is /DV', () => {
    const { fld, kids, apText } = converted(probe('t45'));
    expect(fld!.Dict.has('V')).toBe(false);
    expect(fld!.Dict.has('DV')).toBe(true);
    for (const w of kids) expect(apText(w)).not.toContain('line');
  });
  // t54: the cut falls below the text, so the second widget shows nothing.
  it('shows nothing in a piece below the text', () => {
    const { kids, apText } = converted(variant('t54', { datum: 'line 01\nline 02\nline 03' }));
    expect(kids.length).toBe(2);
    expect(apText(kids[0])).toContain('line 03');
    expect(apText(kids[1])).not.toContain('line');
  });
  // Review Focus 4: a password field's pieces are masked.
  it('masks every piece of a password field', () => {
    const { kids, apText } = converted(variant('t45', {
      datum: TEN, edit: (b) => b.replace('<textEdit multiLine="1"/>', '<passwordEdit/>'),
    }));
    expect(kids.length).toBe(2);
    for (const w of kids) expect(apText(w)).not.toContain('line');
  });
  // Review Focus 3: a field whose tail is refused is refused whole, never half-created.
  it('creates no widget for a field whose tail could not be placed', () => {
    const { fld, report } = converted(variant('t45', {
      datum: TEN,
      pageArea: `<pageArea name="P1" id="P1"><occur max="1"/><medium short="8.5in" long="11in" stock="letter"/>
    <contentArea x="0.5in" y="0.5in" w="7.5in" h="10in"/></pageArea><occur max="1"/>`,
    }));
    if (fld) expect(fld.Dict.has('Kids') || fld.Dict.has('Rect')).toBe(false);
    expect(report.skipped.some((s) => s.name === 'form1[0].pos[0].f[0]')).toBe(true);
  });
});
