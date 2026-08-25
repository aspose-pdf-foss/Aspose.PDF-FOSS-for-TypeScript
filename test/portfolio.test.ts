import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-annot-target.js';
import { isDict } from '../src/types.js';
import type { CollectionSettings } from '../src/collection.js';

const settings: CollectionSettings = {
  fields: [
    { name: 'name', type: 'filename', displayName: 'Name', order: 0 },
    { name: 'reviewer', type: 'string', displayName: 'Reviewer', order: 1, editable: true },
    { name: 'revision', type: 'number', displayName: 'Rev', order: 2, visible: false },
  ],
  view: 'tile',
  sortBy: 'reviewer',
  sortAscending: false,
  initialFile: 'a.txt',
};

describe('Document collection (portfolio)', () => {
  it('round-trips SetCollection through Save/Open', () => {
    const doc = Document.Open(buildBlankPage());
    doc.AddAttachment('a.txt', new TextEncoder().encode('A'), {});
    doc.SetCollection(settings);
    const re = Document.Open(doc.Save());
    const got = re.GetCollection()!;
    expect(got.view).toBe('tile');
    expect(got.sortBy).toBe('reviewer');
    expect(got.sortAscending).toBe(false);
    expect(got.initialFile).toBe('a.txt');
    expect(got.fields.map((f) => [f.name, f.type, f.displayName])).toEqual([
      ['name', 'filename', 'Name'],
      ['reviewer', 'string', 'Reviewer'],
      ['revision', 'number', 'Rev'],
    ]);
    expect(got.fields[1].editable).toBe(true);
    expect(got.fields[2].visible).toBe(false);
  });

  it('GetCollection is undefined without a /Collection', () => {
    const doc = Document.Open(buildBlankPage());
    expect(doc.GetCollection()).toBeUndefined();
  });

  it('RemoveCollection reports presence and drops the dict', () => {
    const doc = Document.Open(buildBlankPage());
    doc.SetCollection({ fields: [{ name: 'name', type: 'filename', displayName: 'Name' }] });
    expect(doc.RemoveCollection()).toBe(true);
    expect(doc.RemoveCollection()).toBe(false);
    expect(Document.Open(doc.Save()).GetCollection()).toBeUndefined();
  });

  it('built-in-only schema writes no /CI on filespecs', () => {
    const doc = Document.Open(buildBlankPage());
    const att = doc.AddAttachment('a.txt', new TextEncoder().encode('A'), {});
    doc.SetCollection({ fields: [{ name: 'name', type: 'filename', displayName: 'Name' }] });
    expect(isDict(att.Dict.get('CI'))).toBe(false);
  });

  it('validates field type, sortBy, and field names', () => {
    const doc = Document.Open(buildBlankPage());
    expect(() => doc.SetCollection({ fields: [{ name: 'x', type: 'bogus' as any, displayName: 'X' }] })).toThrow(TypeError);
    expect(() => doc.SetCollection({ fields: [{ name: '', type: 'string', displayName: 'X' }] })).toThrow(TypeError);
    expect(() => doc.SetCollection({
      fields: [{ name: 'x', type: 'string', displayName: 'X' }], sortBy: 'missing',
    })).toThrow(RangeError);
  });
});
