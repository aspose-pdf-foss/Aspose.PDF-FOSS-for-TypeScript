import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { applyFormData, collectFormData } from '../src/formdata.js';
import type { FormData } from '../src/formdata.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';

const open = () => Document.Open(buildFormPdf());
const byName = <T extends { name: string }>(fields: T[], n: string) => fields.find((f) => f.name === n);

describe('collectFormData', () => {
  it('exports non-empty values with their field types', () => {
    const d = collectFormData(open());
    expect(byName(d.fields, 'name')).toEqual({ name: 'name', type: 'text', values: ['Bob'] });
    expect(byName(d.fields, 'color')).toEqual({ name: 'color', type: 'radio', values: ['Red'] });
    expect(byName(d.fields, 'size')).toEqual({ name: 'size', type: 'choice', values: ['M'] });
  });

  it('omits empty and Off fields by default', () => {
    const d = collectFormData(open());
    expect(byName(d.fields, 'agree')).toBeUndefined(); // checkbox at Off
    expect(byName(d.fields, 'tags')).toBeUndefined();  // multi-select, no /V
  });

  it('includes empty fields when asked', () => {
    const d = collectFormData(open(), { includeEmpty: true });
    expect(byName(d.fields, 'agree')).toEqual({ name: 'agree', type: 'checkbox', values: ['Off'] });
    expect(byName(d.fields, 'tags')?.values).toEqual(['']);
  });

  it('exports a checked checkbox as its on-state name', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    expect(byName(collectFormData(doc).fields, 'agree')?.values).toEqual(['Yes']);
  });

  it('exports a multi-select choice as several values', () => {
    const doc = open();
    doc.Form.Get('tags')!.Value = ['a', 'b'];
    expect(byName(collectFormData(doc).fields, 'tags')?.values).toEqual(['a', 'b']);
  });

  it('uses fully-qualified names for nested fields', () => {
    const doc = open();
    doc.Form.Get('parent.child')!.Value = 'kid';
    expect(byName(collectFormData(doc).fields, 'parent.child')?.values).toEqual(['kid']);
  });

  it('never exports signature or pushbutton fields', () => {
    const d = collectFormData(open(), { includeEmpty: true });
    expect(byName(d.fields, 'sig')).toBeUndefined();
  });

  it('carries the /F reference only when given', () => {
    expect(collectFormData(open()).file).toBeUndefined();
    expect(collectFormData(open(), { file: 'form.pdf' }).file).toBe('form.pdf');
  });

  it('exports /RV rich text when the field has it', () => {
    const doc = open();
    const f = doc.Form.Get('name')!;
    f.Dict.set('RV', { kind: 'string', bytes: new TextEncoder().encode('<body><b>Bob</b></body>') });
    expect(byName(collectFormData(doc).fields, 'name')?.richText).toBe('<body><b>Bob</b></body>');
  });

  it('returns an empty field list for a document with no form', () => {
    const doc = Document.Open(buildFormPdf());
    doc.catalog().delete('AcroForm');
    expect(collectFormData(doc).fields).toEqual([]);
  });
});

const data = (fields: FormData['fields'], extra: Partial<FormData> = {}): FormData =>
  ({ fields, ...extra });
const entry = (name: string, values: string[]) => ({ name, type: 'unknown' as const, values });

describe('applyFormData', () => {
  it('sets each field type from string values', () => {
    const doc = open();
    const r = applyFormData(doc, data([
      entry('name', ['Ada']),
      entry('agree', ['Yes']),
      entry('color', ['Green']),
      entry('size', ['L']),
      entry('tags', ['a', 'b']),
    ]));
    expect(r.skipped).toEqual([]);
    expect(r.imported).toHaveLength(5);
    const form = doc.Form;
    expect(form.Get('name')!.Value).toBe('Ada');
    expect(form.Get('agree')!.Value).toBe(true);
    expect(form.Get('color')!.Value).toBe('Green');
    expect(form.Get('size')!.Value).toBe('L');
    expect(form.Get('tags')!.Value).toEqual(['a', 'b']);
  });

  it('treats Off and an absent value as unchecked', () => {
    const doc = open();
    doc.Form.Get('agree')!.Value = true;
    applyFormData(doc, data([entry('agree', ['Off'])]));
    expect(doc.Form.Get('agree')!.Value).toBe(false);

    doc.Form.Get('agree')!.Value = true;
    applyFormData(doc, data([entry('agree', [])]));
    expect(doc.Form.Get('agree')!.Value).toBe(false);
  });

  it('skips an unknown field name without throwing', () => {
    const doc = open();
    const r = applyFormData(doc, data([entry('ghost', ['x']), entry('name', ['Ada'])]));
    expect(r.imported).toEqual(['name']);
    expect(r.skipped).toEqual([{ name: 'ghost', reason: 'no such field' }]);
  });

  it('skips a rejected value and leaves the field unchanged', () => {
    const doc = open();
    const r = applyFormData(doc, data([entry('size', ['XXL'])]));
    expect(r.imported).toEqual([]);
    expect(r.skipped[0].name).toBe('size');
    expect(r.skipped[0].reason).toContain('XXL');
    expect(doc.Form.Get('size')!.Value).toBe('M'); // untouched
  });

  it('skips field types that carry no settable value', () => {
    const doc = open();
    const r = applyFormData(doc, data([entry('sig', ['x'])]));
    expect(r.skipped).toEqual([{ name: 'sig', reason: 'field type is not settable' }]);
  });

  it('skips everything when the document has no form', () => {
    const doc = open();
    doc.catalog().delete('AcroForm');
    const r = applyFormData(doc, data([entry('name', ['Ada'])]));
    expect(r.imported).toEqual([]);
    expect(r.skipped).toEqual([{ name: 'name', reason: 'document has no form' }]);
  });

  it('surfaces the source file and id without enforcing them', () => {
    const doc = open();
    const r = applyFormData(doc, data([], { file: 'other.pdf', id: ['aa', 'bb'] }));
    expect(r.sourceFile).toBe('other.pdf');
    expect(r.sourceId).toEqual(['aa', 'bb']);
  });

  it('applies rich text alongside the plain value', () => {
    const doc = open();
    applyFormData(doc, data([{ name: 'name', type: 'unknown', values: ['Ada'], richText: '<body>A</body>' }]));
    const rv = doc.Form.Get('name')!.Dict.get('RV') as { kind: 'string'; bytes: Uint8Array };
    expect(new TextDecoder().decode(rv.bytes)).toContain('<body>A</body>');
  });

  it('regenerates the appearance stream on import', () => {
    const doc = open();
    applyFormData(doc, data([entry('name', ['Ada'])]));
    const ap = doc.resolve(doc.Form.Get('name')!.Dict.get('AP'));
    expect(ap).not.toBeNull();
  });
});
