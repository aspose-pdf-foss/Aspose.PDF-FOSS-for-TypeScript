import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildFormPdf } from './helpers/build-form-pdf.js';
import { isArray, PdfDict, PdfObject } from '../src/types.js';

const blank = () => Document.Open(buildBlankPage());
const acroOf = (d: Document) => d.resolve(d.catalog().get('AcroForm')) as PdfDict;
const fieldsOf = (d: Document) => d.resolve(acroOf(d).get('Fields')) as PdfObject[];
const annotsOf = (d: Document, page = 1): PdfObject[] => {
  const a = d.resolve(d.Pages[page - 1].Dict.get('Annots'));
  return isArray(a) ? a : [];
};
const names = (d: Document) => d.Form.Fields.map((f) => f.FullName);

describe('Form.RemoveField', () => {
  it('removes the field, its /Fields entry and its widget', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'b' });
    expect(annotsOf(doc).length).toBe(2);

    expect(doc.Form.RemoveField('a')).toBe(true);

    expect(names(doc)).toEqual(['b']);
    expect(fieldsOf(doc).length).toBe(1);
    expect(annotsOf(doc).length).toBe(1);
    expect(doc.Form.Get('a')).toBeUndefined();
  });

  it('is idempotent, and an unknown name changes nothing', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(doc.Form.RemoveField('a')).toBe(true);
    const after = doc.Save().length;
    expect(doc.Form.RemoveField('a')).toBe(false);
    expect(doc.Form.RemoveField('nope')).toBe(false);
    expect(doc.Save().length).toBe(after);
  });

  it('takes a Field handle, and returns false for one already removed', () => {
    const doc = blank();
    const f = doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(doc.Form.RemoveField(f)).toBe(true);
    expect(doc.Form.RemoveField(f)).toBe(false);
    expect(doc.Form.Fields).toEqual([]);
  });

  it('does not remove a field belonging to another document', () => {
    const a = blank();
    const foreign = a.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const b = blank();
    b.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const before = b.Save().length;
    expect(b.Form.RemoveField(foreign)).toBe(false);
    expect(names(b)).toEqual(['a']);
    expect(b.Save().length).toBe(before);
  });

  it('rebuilds a held Form', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const form = doc.Form;
    expect(form.Fields.length).toBe(1);
    form.RemoveField('a');
    expect(form.Fields).toEqual([]);
  });

  it('keeps a sibling and the parent node it still needs', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'address.city' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'address.zip' });

    expect(doc.Form.RemoveField('address.city')).toBe(true);

    expect(names(doc)).toEqual(['address.zip']);
    expect(fieldsOf(doc).length).toBe(1);
  });

  it('prunes every ancestor the removal empties', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a.b.c' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'keep' });

    expect(doc.Form.RemoveField('a.b.c')).toBe(true);

    expect(names(doc)).toEqual(['keep']);
    expect(fieldsOf(doc).length).toBe(1);
  });

  it('prunes an intermediate node read from a file', () => {
    // buildFormPdf: field 12 'parent' exists only to hold kid 13 'child'.
    const doc = Document.Open(buildFormPdf());
    expect(doc.Form.RemoveField('parent.child')).toBe(true);

    const after = Document.Open(doc.Save()).Form.Fields.map((f) => f.FullName);
    expect(after).not.toContain('parent.child');
    expect(after).not.toContain('parent');
    expect(after.length).toBe(7);
  });

  it('drops /Kids widgets from every page they sit on', () => {
    const doc = blank();
    doc.AddPage();
    doc.Form.AddRadioGroup({
      name: 'color',
      options: [
        { page: 1, rect: [10, 10, 30, 30], export: 'red' },
        { page: 2, rect: [10, 10, 30, 30], export: 'green' },
      ],
    });
    expect(annotsOf(doc, 1).length).toBe(1);
    expect(annotsOf(doc, 2).length).toBe(1);

    expect(doc.Form.RemoveField('color')).toBe(true);

    expect(annotsOf(doc, 1)).toEqual([]);
    expect(annotsOf(doc, 2)).toEqual([]);
    expect(fieldsOf(doc)).toEqual([]);
  });

  it('removes a /Kids-widget field read from a file', () => {
    // buildFormPdf: field 8 'color' owns widgets 9 and 10, and the page /Annots
    // is [6 7 9 10 11 13].
    const doc = Document.Open(buildFormPdf());
    expect(doc.Form.RemoveField('color')).toBe(true);
    expect(doc.Form.Get('color')).toBeUndefined();
    expect(annotsOf(doc).length).toBe(4);

    const back = Document.Open(doc.Save());
    expect(back.Form.Get('color')).toBeUndefined();
    expect(back.Form.Fields.map((f) => f.FullName).sort())
      .toEqual(['agree', 'font', 'name', 'parent.child', 'sig', 'size', 'tags']);
  });

  it('scrubs /AcroForm /CO so the field cannot survive Save', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'total' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'keep' });
    // Nothing we write emits /CO; documents from other producers do.
    const acro = acroOf(doc);
    acro.set('CO', [fieldsOf(doc)[0]]);

    expect(doc.Form.RemoveField('total')).toBe(true);

    expect(doc.resolve(acro.get('CO'))).toEqual([]);
    const saved = doc.Save();
    expect(new TextDecoder('latin1').decode(saved)).not.toContain('(total)');
    expect(Document.Open(saved).Form.Get('total')).toBeUndefined();
  });

  it('scrubs a pruned ancestor from /CO too', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'sums.total' });
    const acro = acroOf(doc);
    acro.set('CO', [fieldsOf(doc)[0]]);   // the 'sums' node, which pruning removes

    expect(doc.Form.RemoveField('sums.total')).toBe(true);

    expect(doc.resolve(acro.get('CO'))).toEqual([]);
    expect(new TextDecoder('latin1').decode(doc.Save())).not.toContain('(sums)');
  });

  it('rejects an argument that is neither a name nor a Field', () => {
    const doc = blank();
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(() => doc.Form.RemoveField({} as never)).toThrow(TypeError);
    expect(names(doc)).toEqual(['a']);
  });
});
