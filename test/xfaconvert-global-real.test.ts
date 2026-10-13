// test/xfaconvert-global-real.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { editPacket } from './helpers/xfa-dynamic.js';

const open = (f: string) => Document.Open(new Uint8Array(readFileSync(`test/fixtures/${f}`)));

describe('global binding on real forms (yy09)', () => {
  // IRS f1040 (Designer 6.5, hybrid). Five checkboxes named c1_8 share one
  // global datum, written once as topmostSubform.c1_8 -- not at any field's
  // own path. On-states 1..5; the vendored datum is "0" (none checked).
  it('f1040: the c1_8 checkbox whose on-state is the datum is the one checked', () => {
    const doc = open('xfa/irs-f1040.pdf');
    editPacket(doc, 'datasets', /<c1_8\s*>0<\/c1_8\s*>/, () => '<c1_8>2</c1_8>');
    const r = doc.ConvertXfaToAcroForm();
    const P = 'topmostSubform[0].Page1[0].';
    const names = [`${P}Checkbox_ReadOrder[0].c1_8[0]`, `${P}Checkbox_ReadOrder[0].c1_8[1]`,
      `${P}Checkbox_ReadOrder[0].c1_8[2]`, `${P}c1_8[0]`, `${P}c1_8[1]`];
    expect(names.map((n) => doc.Form.Get(n)!.Value)).toEqual([false, true, false, false, false]);
    expect(r.skipped.filter((s) => /refused the data value/.test(s.reason))).toEqual([]);
  });

  // Review Focus 4.
  it('hybrids: a blank or "0" checkbox datum is no refusal, and leaves the box off', () => {
    for (const f of ['xfa/irs-f1040.pdf', 'xfa/irs-fw9.pdf', 'xfa/uscis-i130.pdf', 'xfa/uscis-i765.pdf']) {
      const doc = open(f);
      const r = doc.ConvertXfaToAcroForm();
      expect(r.skipped.filter((s) => /checkbox value must be a boolean/.test(s.reason)), f).toEqual([]);
    }
  });

  // A blank datum SETS NOTHING -- it does not mean "off". The two agree for a
  // box that is already off, which is every box in the vendored files, so the
  // case checks one in Adobe's AcroForm half first: blank data must leave it on.
  it('I-130: a blank checkbox datum leaves a checked AcroForm box checked', () => {
    const doc = open('xfa/uscis-i130.pdf');
    const n = 'form1[0].#subform[0].Pt1Line1_Spouse[0]';
    doc.Form.Get(n)!.Value = true;
    doc.ConvertXfaToAcroForm();
    expect(doc.Form.Get(n)!.Value).toBe(true);
  });

  // OPM 1644 (dynamic). checkbox1[0] and [1] (on VA, OR) share the global
  // datum OF1644.checkbox1, "Off" as vendored. pdf.js 6.3.289's rule names the
  // same datum: no ordinary match within three data levels of the field, so
  // the first checkbox1 anywhere -- derived from the transcribed rule, not by
  // running pdf.js.
  it('OPM 1644: the global checkbox1 pair binds the root datum', () => {
    const doc = open('xfa-dynamic/opm1644.pdf');
    editPacket(doc, 'datasets', /<checkbox1\s*>Off<\/checkbox1\s*>/, () => '<checkbox1>OR</checkbox1>');
    doc.ConvertXfaToAcroForm();
    const B = 'OF1644[0].Page1[0].SectionIIIpt2[0].Row4[0].Subformc1[0].#subform[0].';
    expect([`${B}checkbox1[0]`, `${B}checkbox1[1]`].map((n) => doc.Form.Get(n)!.Value)).toEqual([false, true]);
  });
});
