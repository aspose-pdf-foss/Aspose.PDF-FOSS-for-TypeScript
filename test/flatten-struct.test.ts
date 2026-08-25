import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { flattenAnnotations, flattenForm } from '../src/flatten.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { buildFlattenPopupTarget } from './helpers/build-flatten-target.js';
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

/** The page's content streams as text. */
const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

/** A blank page carrying a text field tagged under a /Form element with an
 *  /Alt. Returns the document, that element's dict, and the widget's
 *  /StructParent key. */
function taggedField(): { doc: Document; form: PdfDict; key: number } {
  const doc = Document.Open(buildBlankPage());
  doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
  const root = doc.CreateStructTree();
  const form = root.Append('Form', { alt: 'Your name' });
  const widget = doc.Pages[0].Annotations[0];
  form.AddAnnotation(widget);
  const key = doc.resolve(widget.Dict.get('StructParent')) as number;
  return { doc, form: form.Dict, key };
}

describe('flatten and the structure tree', () => {
  it('does not leave a flattened widget alive through Save', () => {
    const { doc } = taggedField();

    flattenForm(doc);

    // The OBJR /Obj ref is reachable from /Root through /StructTreeRoot, so a
    // leftover keeps the widget in the saved bytes with no /Annots entry.
    const saved = Document.Open(doc.Save());
    expect(subtypeCount(saved, 'Widget')).toBe(0);
  });

  it('retypes the flattened element from /Form to /Figure and keeps its /Alt', () => {
    const { doc, form } = taggedField();

    flattenForm(doc);

    // /Form identifies a widget annotation (ISO 32000-1 Table 337) and there is
    // no widget any more — but /Figure is alt-required too, so the /Alt the
    // document already needed to validate carries over untouched.
    expect((doc.resolve(form.get('S')) as { name: string }).name).toBe('Figure');
    expect(doc.GetStructTree()!.Children[0].Alt).toBe('Your name');
  });

  it('swaps the OBJR for a marked-content kid wired to the page', () => {
    const { doc, form } = taggedField();

    flattenForm(doc);

    expect(objrs(doc, form).length).toBe(0);
    const k = kids(doc, form);
    expect(k.length).toBe(1);
    expect(typeof k[0]).toBe('number');

    // The element claims the page it now draws on, and the page's MCID array
    // maps that MCID back to the element.
    expect(doc.resolve(form.get('Pg'))).toBe(doc.Pages[0].Dict);
    const sp = doc.resolve(doc.Pages[0].Dict.get('StructParents')) as number;
    const nums = parentTreeNums(doc);
    const at = nums.indexOf(sp);
    const arr = doc.resolve(nums[at + 1]) as PdfObject[];
    expect(doc.resolve(arr[k[0] as number])).toBe(form);
  });

  it('clears the annotation /ParentTree slot', () => {
    const { doc, key } = taggedField();
    expect(parentTreeKeys(doc)).toContain(key);

    flattenForm(doc);

    expect(parentTreeKeys(doc)).not.toContain(key);
  });

  it('wraps the baked appearance in BDC/EMC under the retyped tag', () => {
    const { doc } = taggedField();

    flattenForm(doc);

    const c = content(doc);
    expect(c).toMatch(/\/Figure <<\/MCID 0>> BDC\s+q [^\n]* cm \/Fm0 Do Q\s+EMC/);
  });

  it('keeps the baked content in the annotation reading-order slot', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    const root = doc.CreateStructTree();
    const el = root.Append('Form', { alt: 'Your name' });
    // The widget comes FIRST, with a text run after it. That order is what makes
    // this discriminating: with the OBJR last, appending the content kid and
    // then letting the untagObjects sweep drop the OBJR lands on the same array
    // as writing in place, and the assertion proves nothing.
    el.AddAnnotation(doc.Pages[0].Annotations[0]);
    const after = el.NextMcid(doc.Pages[0]);
    expect(kids(doc, el.Dict).length).toBe(2);

    flattenForm(doc);

    // The content kid replaces the OBJR in place, so the baked ink stays ahead
    // of the text run it preceded. Appending would put it behind.
    const k = kids(doc, el.Dict);
    expect(k).toEqual([after + 1, after]);
  });

  it('falls back to dropping the tag on a /Kids-based /ParentTree', () => {
    const { doc } = taggedField();
    // Rehang the flat /Nums under a /Kids leaf — a shape we read but decline to
    // author into. Authoring throws there, and flatten must not.
    const root = doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict;
    const pt = doc.resolve(root.get('ParentTree')) as PdfDict;
    const nums = doc.resolve(pt.get('Nums')) as PdfObject[];
    const leaf: PdfDict = new Map<string, PdfObject>([
      ['Limits', [0, 999]], ['Nums', nums],
    ]);
    pt.delete('Nums');
    pt.set('Kids', [doc.allocObject(leaf)]);

    expect(() => flattenForm(doc)).not.toThrow();

    expect(content(doc)).not.toContain('BDC');
    expect(subtypeCount(Document.Open(doc.Save()), 'Widget')).toBe(0);
  });

  it('leaves an untagged document byte-identical', () => {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });

    flattenForm(doc);

    expect(content(doc)).not.toContain('BDC');
    expect(doc.Pages[0].Dict.has('StructParents')).toBe(false);
  });

  it('untags an orphaned /Popup and retags the markup that displaced it', () => {
    const doc = Document.Open(buildFlattenPopupTarget());
    const page = doc.Pages[0];
    // The fixture mirrors what a viewer writes, which does not include /P;
    // tagAnnotation derives the page from it.
    for (const a of page.Annotations) a.Dict.set('P', doc.pageRef(1));
    const root = doc.CreateStructTree();
    const figure = root.Append('Figure', { alt: 'green box' });
    const note = root.Append('Note');
    figure.AddAnnotation(page.Annotations[0]); // /Square markup, gets baked
    note.AddAnnotation(page.Annotations[1]);   // /Popup, dropped with its parent

    flattenAnnotations(doc, page);

    // The markup's ink is now page content, so its tag follows it.
    expect(objrs(doc, figure.Dict).length).toBe(0);
    expect(kids(doc, figure.Dict).map((k) => typeof k)).toEqual(['number']);
    // The popup's ink is gone, so its tag goes with it — and the element it
    // emptied is pruned.
    expect(kids(doc, doc.resolve(doc.catalog().get('StructTreeRoot')) as PdfDict)
      .map((k) => doc.resolve(k))).not.toContain(note.Dict);

    const saved = new TextDecoder('latin1').decode(doc.Save());
    expect(saved).not.toContain('/Subtype /Popup');
    expect(saved).not.toContain('/Subtype /Square');
  });
});
