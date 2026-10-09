// test/xfaconvert-measure.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildXfaPdf } from './helpers/build-xfa-pdf.js';

/** A one-page dynamic form: a tb page subform holding a height-growable Arial
 *  field above a fixed one, so the second field's y proves the first grew.
 *  Nothing is embedded, so Arial is measured with the Liberation Sans
 *  substitute -- which equals Arial's metrics (164g.7's closed table). */
function buildGrowForm(value: string | string[], extra = ''): Document {
  const template = `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">
<subform name="form1" layout="tb"><pageSet><pageArea name="P"><contentArea w="612pt" h="792pt"/>
<medium short="8.5in" long="11in"/></pageArea></pageSet>
<subform name="S" layout="tb" w="612pt">
<field name="grow" w="100pt" ${extra}><ui><textEdit multiLine="1"/></ui><font typeface="Arial" size="10pt"/><margin/></field>
<field name="after" w="100pt" h="20pt"><ui><textEdit/></ui></field>
</subform></subform></template>`;
  const datasets = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><S>${
    Array.isArray(value)
      // Several <value> children are ONE datum with several values (xfadata.ts).
      ? `<grow>${value.map((v) => `<value>${v}</value>`).join('')}</grow>`
      : `<grow>${value}</grow>`
  }</S></form1></xfa:data></xfa:datasets>`;
  return Document.Open(buildXfaPdf({ template, datasets, needsRendering: true }));
}

const rect = (doc: Document, n: string) => doc.resolve(doc.Form.Get(n)!.Dict.get('Rect')) as number[];

describe('ConvertXfaToAcroForm measures growable fields', () => {
  it('grows a field to its bound value in Arial (the Liberation substitute when nothing is embedded)', () => {
    const doc = buildGrowForm('one two three four five six seven eight nine ten');
    const r = doc.ConvertXfaToAcroForm();
    expect(r.fields.find((f) => f.name.endsWith('grow[0]'))?.route).toBe('positioned');
    const g = rect(doc, 'form1[0].S[0].grow[0]');
    const a = rect(doc, 'form1[0].S[0].after[0]');
    const lines = Math.round((g[3] - g[1]) / ((1854 + 434) / 2048 * 10));
    expect(lines).toBeGreaterThan(1);
    expect(a[3]).toBeCloseTo(g[1], 2);
    expect(r.warnings).toEqual([]);
  });

  it('measures an empty growable field as one line', () => {
    const doc = buildGrowForm('');
    doc.ConvertXfaToAcroForm();
    const g = rect(doc, 'form1[0].S[0].grow[0]');
    expect(g[3] - g[1]).toBeCloseTo((1854 + 434) / 2048 * 10, 2);
  });

  // Review Focus 1: a multi-valued datum never reaches the measurer as a string.
  it('refuses a growable text field bound to several values', () => {
    const doc = buildGrowForm(['a', 'b']);
    const r = doc.ConvertXfaToAcroForm();
    expect(r.fields.find((f) => f.name.endsWith('grow[0]'))?.route).toBe('bare');
    expect(r.skipped.some((s) => s.name?.endsWith('grow[0]') && /several values/.test(s.reason))).toBe(true);
  });

  it('reports a swapped min/max as a warning', () => {
    const doc = buildGrowForm('a', 'minH="40pt" maxH="30pt"');
    const r = doc.ConvertXfaToAcroForm();
    expect(r.warnings).toEqual(['grow[0]: minH exceeds maxH, so the two are swapped (XFA 3.3 p. 277)']);
  });
});
