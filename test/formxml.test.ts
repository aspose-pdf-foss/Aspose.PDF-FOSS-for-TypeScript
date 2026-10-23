import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { readFormXml, writeFormXml, xmlElementName } from '../src/formxml.js';
import { parseXml } from '../src/xml.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

const open = () => Document.Open(buildFormPdf());
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const xml = (s: string) => new TextEncoder().encode(s);
const dd3183 = () => Document.Open(readFileSync(new URL('./fixtures/xfa/dod-dd3183.pdf', import.meta.url)));
const radio = (d: Document) => d.Form.Fields.find((x) => x.Type === 'radio' && x.FullName.endsWith('.RadioButtonList[1]'))!;

describe('xmlElementName', () => {
  it('leaves a valid name alone', () => {
    expect(xmlElementName('name')).toBeUndefined();
    expect(xmlElementName('Имя_1')).toBeUndefined();
  });

  it('replaces what XML cannot spell and guards the start', () => {
    expect(xmlElementName('RadioButtonList[1]')).toBe('RadioButtonList_1_');
    expect(xmlElementName('first name')).toBe('first_name');
    expect(xmlElementName('1st')).toBe('_1st');
    expect(xmlElementName('xmlData')).toBe('_xmlData');
    expect(xmlElementName('a:b')).toBe('a_b');
    expect(xmlElementName('')).toBe('_');
  });
});

describe('ExportXml', () => {
  it('writes one element per name segment, the value as its text', () => {
    const doc = open();
    doc.Form.Get('parent.child')!.Value = 'kid';
    const root = parseXml(doc.ExportXml());
    expect(root.name).toBe('fields');
    expect(root.children.find((c) => c.name === 'name')?.text).toBe('Bob');
    const parent = root.children.find((c) => c.name === 'parent')!;
    expect(parent.children.map((c) => [c.name, c.text])).toEqual([['child', 'kid']]);
  });

  it('writes a checkbox as its on-state name or Off', () => {
    const doc = open();
    expect(text(doc.ExportXml({ includeEmpty: true }))).toContain('<agree>Off</agree>');
    doc.Form.Get('agree')!.Value = true;
    expect(text(doc.ExportXml())).toContain('<agree>Yes</agree>');
  });

  it('writes a multi-select once per value', () => {
    const doc = open();
    doc.Form.Get('tags')!.Value = ['a', 'b'];
    const root = parseXml(doc.ExportXml());
    expect(root.children.filter((c) => c.name === 'tags').map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('writes a radio group\'s EXPORT under a mangled name, the real name kept', () => {
    const doc = dd3183();
    radio(doc).Value = 'No'; // index state '1'
    const s = text(doc.ExportXml());
    expect(s).toContain('<RadioButtonList_1_ xfdf:original="RadioButtonList[1]">No</RadioButtonList_1_>');
    expect(s).toContain('xmlns:xfdf="http://ns.adobe.com/xfdf-transition/"');
  });

  it('drops characters XML cannot carry', () => {
    const doc = open();
    doc.Form.Get('name')!.Value = 'A\u0001B';
    expect(text(doc.ExportXml())).toContain('<name>AB</name>');
  });

  it('escapes markup in a value', () => {
    const doc = open();
    doc.Form.Get('name')!.Value = '<a&b>';
    expect(readFormXml(doc.ExportXml()).fields.find((f) => f.name === 'name')?.values).toEqual(['<a&b>']);
  });

  it('refuses options it would silently ignore', () => {
    expect(() => open().ExportXml({ annotations: true } as never)).toThrow(UnsupportedFeatureError);
    expect(() => open().ExportXml({ file: 'x.pdf' } as never)).toThrow(UnsupportedFeatureError);
  });
});

describe('ImportXml', () => {
  it('round-trips every settable field', () => {
    const src = open();
    const form = src.Form;
    form.Get('name')!.Value = 'Ada';
    form.Get('agree')!.Value = true;
    form.Get('color')!.Value = 'Green';
    form.Get('size')!.Value = 'L';
    form.Get('tags')!.Value = ['a', 'b'];
    form.Get('parent.child')!.Value = 'kid';
    const dst = open();
    const r = dst.ImportXml(src.ExportXml());
    expect(r.skipped).toEqual([]);
    expect(r.imported).toHaveLength(6);
    const g = Document.Open(dst.Save()).Form;
    expect(g.Get('name')!.Value).toBe('Ada');
    expect(g.Get('agree')!.Value).toBe(true);
    expect(g.Get('color')!.Value).toBe('Green');
    expect(g.Get('size')!.Value).toBe('L');
    expect(g.Get('tags')!.Value).toEqual(['a', 'b']);
    expect(g.Get('parent.child')!.Value).toBe('kid');
  });

  it('sets a radio group by EXPORT, not by state', () => {
    // DD 3183 states the export '1' on a widget whose state is '3' elsewhere in
    // its groups; the round trip must land on the export named.
    for (const v of ['Yes', 'No', 'Partially']) {
      const src = dd3183();
      radio(src).Value = v;
      const dst = dd3183();
      dst.ImportXml(src.ExportXml());
      expect(radio(dst).Value).toBe(v);
    }
  });

  it('reads an export that is ANOTHER widget\'s state name as the export', () => {
    // In this group the export '1' belongs to the widget whose state is '3',
    // while state '1' is "MTF / Market": read as a state, '1' lands there.
    const pick = (d: Document) => d.Form.Fields.find((x) => x.FullName.endsWith('#subform[1].RadioButtonList[0]'))!;
    const src = dd3183();
    pick(src).Value = '1';
    const dst = dd3183();
    dst.ImportXml(src.ExportXml());
    expect(pick(dst).Value).toBe('1');
  });

  it('writes a group with no value as Off, which imports cleanly', () => {
    const src = dd3183(); // every radio group here has no /V
    const r = dd3183().ImportXml(src.ExportXml({ includeEmpty: true }));
    expect(r.skipped.filter((s) => s.name.includes('RadioButtonList'))).toEqual([]);
  });

  it('clears a radio group and unchecks a checkbox from Off', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    const r = doc.ImportXml(xml('<fields><agree>Off</agree><color>Off</color></fields>'));
    expect(r.skipped).toEqual([]);
    expect(doc.Form.Get('agree')!.Value).toBe(false);
    expect(doc.Form.Get('color')!.Value).toBe('Off');
  });

  it('round-trips an unselected radio group through includeEmpty', () => {
    const src = open();
    src.ImportXml(xml('<fields><color>Off</color></fields>'));
    const dst = open();
    // The empty multi-select is refused exactly as XFDF refuses it.
    const r = dst.ImportXml(src.ExportXml({ includeEmpty: true }));
    expect(r.skipped).toEqual([{ name: 'tags', reason: "choice field has no option ''" }]);
    expect(dst.Form.Get('color')!.Value).toBe('Off');
  });

  it('reads the real name from xfdf:original', () => {
    const doc = open();
    doc.Form.Get('name')!.Dict.set('T', { kind: 'string', bytes: new TextEncoder().encode('first name') });
    const r = doc.ImportXml(xml(
      '<fields xmlns:xfdf="http://ns.adobe.com/xfdf-transition/"><first_name xfdf:original="first name">Ada</first_name></fields>'));
    expect(r.imported).toEqual(['first name']);
    expect(doc.Form.Get('first name')!.Value).toBe('Ada');
  });

  it('accepts any root name and keeps a value\'s whitespace', () => {
    const doc = open();
    doc.ImportXml(xml('<form1>\n  <name>  Ada  </name>\n</form1>'));
    expect(doc.Form.Get('name')!.Value).toBe('  Ada  ');
  });

  it('reports unknown fields and rejected values', () => {
    const r = open().ImportXml(xml('<fields><nope>x</nope><size>XXL</size><name>Ada</name></fields>'));
    expect(r.imported).toEqual(['name']);
    expect(r.skipped.map((s) => s.name)).toEqual(['nope', 'size']);
  });

  it('refuses text that is not XML, changing nothing', () => {
    const doc = open();
    expect(() => doc.ImportXml(xml('<fields><name>Ada</fields>'))).toThrow(PdfParseError);
    expect(doc.Form.Get('name')!.Value).toBe('Bob');
  });
});

describe('writeFormXml', () => {
  it('nests two fields under one shared container', () => {
    const s = text(writeFormXml({ fields: [
      { name: 'a.b', type: 'text', values: ['1'] },
      { name: 'a.c', type: 'text', values: ['2'] },
    ] }));
    expect(s.match(/<a>/g)).toHaveLength(1);
    expect(readFormXml(xml(s)).fields.map((f) => [f.name, f.values])).toEqual([['a.b', ['1']], ['a.c', ['2']]]);
  });
});
