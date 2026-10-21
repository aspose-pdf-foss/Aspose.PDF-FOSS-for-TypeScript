// test/form-button-opt.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { isName, type PdfDict } from '../src/types.js';
import type { Field } from '../src/formfield.js';
import { addRadioGroup } from '../src/formcreate.js';

/**
 * A button field's `/Opt` (32000-1 12.7.4.2.4, 164g.39): one text string per
 * widget in `/Kids` order, naming that widget's EXPORT value, while its on-state
 * may be an index name (`/0`, `/1`). Adobe writes exactly that for every radio
 * group of DoD DD 3183 (test/fixtures/xfa/), so its groups are the fixture.
 */
const dd3183 = (): Document => Document.Open(readFileSync(new URL('./fixtures/xfa/dod-dd3183.pdf', import.meta.url)));
const radio = (doc: Document, suffix: string): Field =>
  doc.Form.Fields.find((f) => f.Type === 'radio' && f.FullName.endsWith(suffix))!;
const states = (doc: Document, f: Field): string[] => f.Widgets.map((w) => {
  const as = doc.resolve(w.get('AS'));
  return isName(as) ? as.name : '?';
});
const v = (doc: Document, f: Field): string => {
  const x = doc.resolve(f.Dict.get('V'));
  return isName(x) ? x.name : '?';
};

describe('radio /Opt export values (164g.39)', () => {
  it('reports the exports as Options, not the index state names', () => {
    const doc = dd3183();
    expect(radio(doc, '.RadioButtonList[1]').Options).toEqual(['Yes', 'No', 'Partially']);
  });

  it('selects by export, writing the index state, and reads the export back', () => {
    const doc = dd3183();
    const f = radio(doc, '.RadioButtonList[1]');
    f.Value = 'No';
    expect(v(doc, f)).toBe('1');
    expect(states(doc, f)).toEqual(['Off', '1', 'Off']);
    expect(f.Value).toBe('No');
    // Through a save, the next reader sees the same.
    const again = Document.Open(doc.Save());
    expect(radio(again, '.RadioButtonList[1]').Value).toBe('No');
  });

  // Group 0 states an export that is itself a digit, at index 3: matching by
  // export and matching by state name would pick different widgets.
  it('matches the export, never the state name, when the two collide', () => {
    const doc = dd3183();
    const f = radio(doc, '.#subform[1].RadioButtonList[0]');
    expect(f.Options).toEqual(['USUHS', 'MTF / Market', 'DHA Directorate', '1', 'MILDEP/SG', 'Other']);
    f.Value = '1';
    expect(v(doc, f)).toBe('3');
    expect(f.Value).toBe('1');
  });

  it('refuses a state name that is not an export, and clears with Off', () => {
    const doc = dd3183();
    const f = radio(doc, '.RadioButtonList[1]');
    expect(() => { f.Value = '0'; }).toThrow("radio group has no option '0'");
    f.Value = 'Yes';
    f.Value = 'Off';
    expect(v(doc, f)).toBe('Off');
    expect(states(doc, f)).toEqual(['Off', 'Off', 'Off']);
  });

  // FDF and XFDF carry a button's value as its appearance STATE name, so data
  // exchange keeps speaking states: an export would write /No into a field
  // whose states are 0, 1 and 2.
  it('exchanges FDF and XFDF data as the state name, both ways', () => {
    const doc = dd3183();
    radio(doc, '.RadioButtonList[1]').Value = 'Partially';
    const xfdf = doc.ExportXfdf();
    expect(new TextDecoder().decode(xfdf)).toMatch(/RadioButtonList\[1\]">\s*<value>2<\/value>/);
    const fdf = doc.ExportFdf();
    const target = dd3183();
    target.ImportXfdf(xfdf);
    expect(radio(target, '.RadioButtonList[1]').Value).toBe('Partially');
    const viaFdf = dd3183();
    viaFdf.ImportFdf(fdf);
    expect(radio(viaFdf, '.RadioButtonList[1]').Value).toBe('Partially');
  });
});

describe('writing a radio group as /Opt with index states (164g.37)', () => {
  it('writes /Opt, names widget i\'s state i, and selects by index', () => {
    const doc = Document.New();
    doc.AddPage();
    const f = addRadioGroup(doc, { name: 'r', selected: 'No', options: [
      { page: 1, rect: [10, 10, 30, 30], export: 'Yes' }, { page: 1, rect: [40, 10, 60, 30], export: 'No' }] },
    { indexStates: true });
    expect(v(doc, f)).toBe('1');
    expect(states(doc, f)).toEqual(['Off', '1']);
    expect(f.Widgets.map((w) => [...(doc.resolve((doc.resolve(w.get('AP')) as PdfDict).get('N')) as PdfDict).keys()].sort()))
      .toEqual([['0', 'Off'], ['1', 'Off']]);
    expect(f.Options).toEqual(['Yes', 'No']);
    expect(f.Value).toBe('No');
  });
});

describe('radio without /Opt (164g.39 compatibility)', () => {
  // A widget may hold more than the one on-state `Options` reports; without
  // /Opt every state its /AP /N holds is still selectable, as before.
  it('still accepts any state a widget holds', () => {
    const doc = Document.New();
    doc.AddPage();
    const f = doc.Form.AddRadioGroup({ name: 'r', options: [
      { page: 1, rect: [10, 10, 30, 30], export: 'A' }, { page: 1, rect: [40, 10, 60, 30], export: 'C' }] });
    const n = doc.resolve((doc.resolve(f.Widgets[0].get('AP')) as PdfDict).get('N')) as PdfDict;
    n.set('B', n.get('A')!);
    expect(f.Options).toEqual(['A', 'C']);
    f.Value = 'B';
    expect(f.Value).toBe('B');
    expect(() => { f.Value = 'Z'; }).toThrow("radio group has no option 'Z'");
  });
});

describe('checkbox /Opt export values (164g.39)', () => {
  /** A checkbox whose one widget's on-state is /0 and whose /Opt names it 'Agree'. */
  const box = (): { doc: Document; f: Field } => {
    const doc = Document.New();
    doc.AddPage();
    const f = doc.Form.AddCheckbox({ name: 'c', page: 1, rect: [10, 10, 30, 30], exportValue: '0' });
    f.Dict.set('Opt', [{ kind: 'string', bytes: new TextEncoder().encode('Agree') }]);
    return { doc, f };
  };
  it('reports the export as its option', () => {
    expect(box().f.Options).toEqual(['Agree']);
  });
  it('exports a checked box as its state name', () => {
    const { doc, f } = box();
    f.Value = true;
    expect(new TextDecoder().decode(doc.ExportXfdf())).toMatch(/name="c">\s*<value>0<\/value>/);
    expect((f.Dict as PdfDict).get('V')).toEqual({ kind: 'name', name: '0' });
  });
});
