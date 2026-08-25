import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { PdfDict, PdfObject, isArray, isDict, isName } from '../src/types.js';

/** Dicts of the given /Subtype anywhere in the object map — including objects no
 *  page points at any more, which is the whole question here. */
function subtypeCount(doc: Document, subtype: string): number {
  let n = 0;
  for (const [, o] of doc.objectEntries()) {
    if (!isDict(o)) continue;
    const st = doc.resolve(o.get('Subtype'));
    if (isName(st) && st.name === subtype) n++;
  }
  return n;
}

/** The /K kids of a struct element, as an array however /K is shaped. */
function kids(doc: Document, elem: PdfDict): PdfObject[] {
  const k = doc.resolve(elem.get('K'));
  if (isArray(k)) return k;
  return k === null || k === undefined ? [] : [k];
}

/** Every OBJR dict among an element's kids. */
function objrs(doc: Document, elem: PdfDict): PdfDict[] {
  const out: PdfDict[] = [];
  for (const kid of kids(doc, elem)) {
    const d = doc.resolve(kid);
    if (!isDict(d)) continue;
    const t = doc.resolve(d.get('Type'));
    if (isName(t) && t.name === 'OBJR') out.push(d);
  }
  return out;
}

/** The flat /ParentTree /Nums array of the document's structure tree. */
function parentTreeNums(doc: Document): PdfObject[] {
  const root = doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict;
  const pt = doc.resolve(root.get('ParentTree')) as PdfDict;
  const nums = doc.resolve(pt.get('Nums'));
  return isArray(nums) ? nums : [];
}

/** The keys (even slots) of the /ParentTree /Nums array. */
const parentTreeKeys = (doc: Document): number[] =>
  parentTreeNums(doc).filter((_, i) => i % 2 === 0).map((k) => k as number);

/** A blank page carrying a tagged text field: returns the document, the /Form
 *  element the widget is tagged under, and the widget's /StructParent key. */
function taggedField(name = 'a'): { doc: Document; form: PdfDict; key: number } {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name });
  const root = doc.CreateStructTree();
  const form = root.Append('Form');
  const widget = doc.Pages[0].Annotations[0];
  form.AddAnnotation(widget);
  const key = doc.resolve(widget.Dict.get('StructParent')) as number;
  return { doc, form: form.Dict, key };
}

describe('removal and the structure tree', () => {
  it('drops the OBJR when a tagged field is removed', () => {
    const { doc, form } = taggedField();
    expect(objrs(doc, form).length).toBe(1);

    expect(doc.Form.RemoveField('a')).toBe(true);

    expect(objrs(doc, form).length).toBe(0);
  });

  it('really removes the widget from the saved file', () => {
    const { doc } = taggedField();
    doc.Form.RemoveField('a');

    // The OBJR /Obj ref is reachable from /Root through /StructTreeRoot, so a
    // leftover keeps the widget alive through Save()'s mark-sweep.
    const saved = Document.Open(doc.Save());
    expect(subtypeCount(saved, 'Widget')).toBe(0);
  });

  it('clears the widget /ParentTree slot', () => {
    const { doc, key } = taggedField();
    expect(parentTreeKeys(doc)).toContain(key);

    doc.Form.RemoveField('a');

    expect(parentTreeKeys(doc)).not.toContain(key);
  });

  it('prunes a struct element the removal leaves with no kids', () => {
    const { doc, form } = taggedField();
    const root = doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict;

    doc.Form.RemoveField('a');

    expect(kids(doc, root).map((k) => doc.resolve(k))).not.toContain(form);
  });

  it('keeps an element that still has other kids', () => {
    const { doc, form } = taggedField();
    doc.GetStructTree()!.Children[0].Append('Span');

    doc.Form.RemoveField('a');

    expect(objrs(doc, form).length).toBe(0);
    expect(kids(doc, form).length).toBe(1);
  });

  it('drops the OBJR when a tagged annotation is removed from its page', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const annot = page.AddTextNote({ rect: [10, 10, 30, 30], contents: 'note' });
    const root = doc.CreateStructTree();
    const note = root.Append('Note');
    note.AddAnnotation(annot);
    const key = doc.resolve(annot.Dict.get('StructParent')) as number;

    page.RemoveAnnotation(annot);

    expect(objrs(doc, note.Dict).length).toBe(0);
    expect(parentTreeKeys(doc)).not.toContain(key);
    expect(subtypeCount(Document.Open(doc.Save()), 'Text')).toBe(0);
  });

  it('leaves an untagged document alone', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    expect(doc.Form.RemoveField('a')).toBe(true);
    expect(subtypeCount(Document.Open(doc.Save()), 'Widget')).toBe(0);
  });
});
