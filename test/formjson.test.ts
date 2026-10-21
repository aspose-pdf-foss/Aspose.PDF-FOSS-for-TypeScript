import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Document } from '../src/document.js';
import { PdfParseError, UnsupportedFeatureError } from '../src/errors.js';
import { readFormJson, writeFormJson } from '../src/formjson.js';
import type { Field } from '../src/formfield.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

const open = () => Document.Open(buildFormPdf());
type Entry = { name: string; type: string; value: unknown; options?: unknown; richText?: string };
const parse = (doc: Document, opts = {}) => JSON.parse(doc.ExportJson(opts)) as { fields: Entry[]; file?: string; id?: string[] };
const entry = (doc: Document, n: string, opts = {}) => parse(doc, opts).fields.find((f) => f.name === n);

describe('ExportJson', () => {
  it('writes each field with its type and typed value', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    doc.Form.Get('tags')!.Value = ['a', 'b'];
    expect(entry(doc, 'name')).toEqual({ name: 'name', type: 'text', value: 'Bob' });
    expect(entry(doc, 'agree')).toEqual({ name: 'agree', type: 'checkbox', value: true, options: ['Yes'] });
    expect(entry(doc, 'color')?.value).toBe('Red');
    expect(entry(doc, 'tags')?.value).toEqual(['a', 'b']);
  });

  it('writes a choice field\'s options, keeping a display half', () => {
    const doc = open();
    doc.Form.Get('tags')!.Value = ['b'];
    expect(entry(doc, 'size')?.options).toEqual(['S', 'M', 'L']);
    expect(entry(doc, 'tags')?.options).toEqual([{ export: 'a', display: 'Alpha' }, 'b', 'c']);
  });

  it('writes an unchecked checkbox as false only with includeEmpty', () => {
    expect(entry(open(), 'agree')).toBeUndefined();
    expect(entry(open(), 'agree', { includeEmpty: true })?.value).toBe(false);
  });

  it('writes a radio group\'s EXPORT, where FDF and XFDF write its state', () => {
    const doc = Document.Open(readFileSync(new URL('./fixtures/xfa/dod-dd3183.pdf', import.meta.url)));
    const f: Field = doc.Form.Fields.find((x) => x.Type === 'radio' && x.FullName.endsWith('.RadioButtonList[1]'))!;
    f.Value = 'No'; // index state '1'
    const e = entry(doc, f.FullName);
    expect(e?.value).toBe('No');
    expect(e?.options).toEqual(['Yes', 'No', 'Partially']);
    expect(new TextDecoder().decode(doc.ExportXfdf())).toContain('<value>1</value>');
  });

  it('carries file and id, and rich text', () => {
    const doc = open();
    doc.Form.Get('name')!.Dict.set('RV', { kind: 'string', bytes: new TextEncoder().encode('<body>Bob</body>') });
    const j = parse(doc, { file: 'form.pdf' });
    expect(j.file).toBe('form.pdf');
    expect(j.fields.find((f) => f.name === 'name')?.richText).toBe('<body>Bob</body>');
  });

  it('indents only when asked', () => {
    expect(open().ExportJson()).not.toContain('\n');
    expect(open().ExportJson({ indent: 2 })).toContain('\n  "fields"');
    expect(() => open().ExportJson({ indent: -1 })).toThrow(RangeError);
  });

  it('refuses annotations rather than ignoring them', () => {
    expect(() => open().ExportJson({ annotations: true } as never)).toThrow(UnsupportedFeatureError);
  });

  it('leaves FDF and XFDF unchanged by the typed model', () => {
    const doc = open();
    expect(new TextDecoder().decode(doc.ExportXfdf())).not.toContain('options');
  });
});

describe('ImportJson', () => {
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
    const r = dst.ImportJson(src.ExportJson());
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

  it('unchecks a checkbox from false', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    doc.ImportJson('{"fields":[{"name":"agree","value":false}]}');
    expect(doc.Form.Get('agree')!.Value).toBe(false);
  });

  it('sets a radio group by export through a radio /Opt', () => {
    const load = () => Document.Open(readFileSync(new URL('./fixtures/xfa/dod-dd3183.pdf', import.meta.url)));
    const pick = (d: Document) => d.Form.Fields.find((x) => x.Type === 'radio' && x.FullName.endsWith('.RadioButtonList[1]'))!;
    const src = load();
    pick(src).Value = 'Partially';
    const dst = load();
    const r = dst.ImportJson(src.ExportJson());
    expect(r.imported).toContain(pick(dst).FullName);
    expect(pick(dst).Value).toBe('Partially');
  });

  it('accepts bytes with a BOM', () => {
    const doc = open();
    const bytes = new TextEncoder().encode('﻿{"fields":[{"name":"name","value":"Ada"}]}');
    expect(doc.ImportJson(bytes).imported).toEqual(['name']);
    expect(doc.Form.Get('name')!.Value).toBe('Ada');
  });

  it('skips an entry whose stated type differs from the field\'s', () => {
    const doc = open();
    const r = doc.ImportJson('{"fields":[{"name":"name","type":"choice","value":"x"}]}');
    expect(r.skipped).toEqual([{ name: 'name', reason: 'field is text, data is choice' }]);
    expect(doc.Form.Get('name')!.Value).toBe('Bob');
  });

  it('reports values the field rejects and unknown fields', () => {
    const doc = open();
    const r = doc.ImportJson(JSON.stringify({ fields: [
      { name: 'agree', value: 'Yes' },
      { name: 'size', value: 'XXL' },
      { name: 'nope', value: 'x' },
      { name: 'name', value: 'Ada' },
    ] }));
    expect(r.imported).toEqual(['name']);
    expect(r.skipped.map((s) => s.name)).toEqual(['agree', 'size', 'nope']);
    expect(r.skipped[2].reason).toBe('no such field');
  });

  it('reports file and id from the data', () => {
    const r = open().ImportJson('{"file":"a.pdf","id":["00","ff"],"fields":[]}');
    expect(r.sourceFile).toBe('a.pdf');
    expect(r.sourceId).toEqual(['00', 'ff']);
  });

  it('refuses a malformed file whole, changing nothing', () => {
    const bad = [
      'not json', '[]', '{}', '{"fields":{}}', '{"fields":[1]}',
      '{"fields":[{"value":"x"}]}', '{"fields":[{"name":"name"}]}',
      '{"fields":[{"name":"name","value":3}]}', '{"fields":[{"name":"name","value":["a",1]}]}',
      '{"fields":[{"name":"name","type":"pushbutton","value":"x"}]}',
      '{"fields":[{"name":"name","value":"x","richText":1}]}',
      '{"id":["a"],"fields":[]}', '{"file":1,"fields":[]}',
      '{"fields":[{"name":"name","value":"Ada"},{"name":"size"}]}',
    ];
    for (const s of bad) {
      const doc = open();
      expect(() => doc.ImportJson(s), s).toThrow(PdfParseError);
      expect(doc.Form.Get('name')!.Value).toBe('Bob');
    }
  });
});

describe('readFormJson / writeFormJson', () => {
  it('reads what it writes', () => {
    const data = readFormJson(writeFormJson({ file: 'f', id: ['0a', '0b'], fields: [
      { name: 'a', type: 'text', values: ['x'], value: 'x' },
      { name: 'b', type: 'checkbox', values: ['Yes'], value: true },
      { name: 'c', type: 'choice', values: ['p', 'q'], value: ['p', 'q'] },
    ] }));
    expect(data.file).toBe('f');
    expect(data.id).toEqual(['0a', '0b']);
    expect(data.fields.map((f) => [f.name, f.type, f.value])).toEqual([
      ['a', 'text', 'x'], ['b', 'checkbox', true], ['c', 'choice', ['p', 'q']]]);
  });

  it('reads an absent type as unknown', () => {
    expect(readFormJson('{"fields":[{"name":"a","value":"x"}]}').fields[0].type).toBe('unknown');
  });
});
