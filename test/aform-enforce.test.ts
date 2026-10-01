// test/aform-enforce.test.ts
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfDict } from '../src/types.js';
import { buildBlankPage } from './helpers/build-blank-page.js';

function pctDoc(): Document {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'pct', value: '10',
    actions: { validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100);' } } });
  return Document.Open(doc.Save());
}

describe('EnforceRules', () => {
  it('is off by default, and the setter accepts anything', () => {
    const doc = pctDoc();
    expect(doc.Form.EnforceRules).toBe(false);
    doc.Form.Get('pct')!.Value = '150';
    expect(doc.Form.Get('pct')!.Value).toBe('150');
  });

  it('persists across doc.Form accesses', () => {
    const doc = pctDoc();
    doc.Form.EnforceRules = true;
    expect(doc.Form.EnforceRules).toBe(true);
  });

  it('refuses a rejected value with RangeError and leaves the document byte-identical', () => {
    const doc = pctDoc();
    doc.Form.EnforceRules = true;
    const before = doc.Save();
    expect(() => { doc.Form.Get('pct')!.Value = '150'; }).toThrow(/AFRange_Validate/);
    expect(() => { doc.Form.Get('pct')!.Value = '150'; }).toThrow(RangeError);
    expect(doc.Save()).toEqual(before);
  });

  it('accepts a value the rule accepts', () => {
    const doc = pctDoc();
    doc.Form.EnforceRules = true;
    doc.Form.Get('pct')!.Value = '50';
    expect(doc.Form.Get('pct')!.Value).toBe('50');
  });

  it('does not block Recalculate from storing a result its own rule rejects', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a', value: '500' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 't', actions: {
      calculate: { type: 'javascript', script: 'AFSimple_Calculate("SUM", "a")' },
      validate: { type: 'javascript', script: 'AFRange_Validate(true, 0, true, 100)' } } });
    const acro = doc.resolve(doc.catalog().get('AcroForm')) as PdfDict;
    const dict = doc.Form.Get('t')!.Dict;
    const ref = [...doc.objectEntries()].find(([, o]) => o === dict)![0];   // already a PdfRef
    acro.set('CO', [ref]);
    doc.Form.EnforceRules = true;
    doc.Form.Recalculate();
    expect(doc.Form.Get('t')!.Value).toBe('500');
    expect(doc.Form.CheckValues().rejected.map((r) => r.field)).toEqual(['t']);
  });

  it('refuses a non-boolean', () => {
    expect(() => { (pctDoc().Form as { EnforceRules: unknown }).EnforceRules = 'yes'; }).toThrow(TypeError);
  });
});
