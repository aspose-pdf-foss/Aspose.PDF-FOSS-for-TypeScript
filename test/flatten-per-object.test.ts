import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildBlankPage } from './helpers/build-blank-page.js';
import { PdfDict, PdfObject, isArray, isDict, isName, isString } from '../src/types.js';
import { decodePdfText } from '../src/metadata.js';

/** A dict's /T partial name, or undefined. */
function partialName(doc: Document, d: PdfDict): string | undefined {
  const t = doc.resolve(d.get('T'));
  return isString(t) ? decodePdfText(t.bytes) : undefined;
}

/** A one-page document with `n` text fields named f0..f(n-1), each with a value
 *  so there is something to bake. */
function formWith(n: number): Document {
  const doc = Document.Open(buildBlankPage());
  for (let i = 0; i < n; i++) {
    doc.Form.AddTextField({ page: 1, rect: [10, 10 + i * 30, 210, 35 + i * 30], name: `f${i}` });
    doc.Form.Get(`f${i}`)!.Value = `v${i}`;
  }
  return doc;
}

/** The partial names (/T) of every node in /AcroForm /Fields, top level only. */
function acroFieldNames(doc: Document): string[] {
  const acro = doc.resolve(doc.catalog().get('AcroForm'));
  if (!isDict(acro)) return [];
  const fields = doc.resolve(acro.get('Fields'));
  if (!isArray(fields)) return [];
  const out: string[] = [];
  for (const e of fields as PdfObject[]) {
    const d = doc.resolve(e);
    if (!isDict(d)) continue;
    const t = partialName(doc, d);
    if (t !== undefined) out.push(t);
  }
  return out;
}

/** Every /Annots entry across the document, as dicts. */
function allAnnots(doc: Document): PdfDict[] {
  const out: PdfDict[] = [];
  for (const page of doc.Pages) {
    const a = doc.resolve(page.Dict.get('Annots'));
    if (!isArray(a)) continue;
    for (const e of a as PdfObject[]) {
      const d = doc.resolve(e);
      if (isDict(d)) out.push(d);
    }
  }
  return out;
}

/** The /T text of every annotation-bearing widget still on a page. */
function widgetNames(doc: Document): string[] {
  const out: string[] = [];
  for (const d of allAnnots(doc)) {
    const s = doc.resolve(d.get('Subtype'));
    if (!isName(s) || s.name !== 'Widget') continue;
    const t = partialName(doc, d);
    if (t !== undefined) out.push(t);
  }
  return out;
}

const content = (doc: Document, i = 0) =>
  new TextDecoder('latin1').decode(doc.Pages[i].Contents);

describe('Field.Flatten', () => {
  it('bakes two of six fields and leaves the other four interactive', () => {
    const doc = formWith(6);
    expect(doc.Form.Get('f1')!.Flatten()).toBe(1);
    expect(doc.Form.Get('f3')!.Flatten()).toBe(1);

    const saved = Document.Open(doc.Save());
    expect(acroFieldNames(saved).sort()).toEqual(['f0', 'f2', 'f4', 'f5']);
    expect(widgetNames(saved).sort()).toEqual(['f0', 'f2', 'f4', 'f5']);
    // The survivors are still real fields, not orphaned dicts.
    expect(saved.Form.Get('f0')!.Value).toBe('v0');
    expect(saved.Form.Get('f1')).toBeUndefined();
  });

  it('bakes the value into page content as a Form XObject draw', () => {
    const doc = formWith(2);
    doc.Form.Get('f0')!.Flatten();
    expect(content(doc)).toMatch(/\/Fm\d+ Do/);
  });

  it('leaves the document with no field that has lost its widget', () => {
    // The trap this exists to close: page.FlattenAnnotations() bakes the widget
    // and drops it from /Annots, but leaves the field dict wired into
    // /AcroForm /Fields — a field with a value and no widget anywhere.
    const doc = formWith(3);
    doc.Form.Get('f1')!.Flatten();
    const saved = Document.Open(doc.Save());
    const onPage = new Set(widgetNames(saved));
    for (const nameInAcro of acroFieldNames(saved))
      expect(onPage.has(nameInAcro)).toBe(true);
  });

  it('is a no-op returning 0 for a field whose widget was already flattened', () => {
    const doc = formWith(2);
    const field = doc.Form.Get('f0')!;
    expect(field.Flatten()).toBe(1);
    expect(doc.Form.Get('f0')).toBeUndefined();
  });
});

describe('Annotation.Flatten', () => {
  it('bakes one annotation and leaves the rest in /Annots', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    page.AddSquare({ rect: [10, 10, 60, 60], color: [1, 0, 0] });
    page.AddSquare({ rect: [80, 10, 130, 60], color: [0, 0, 1] });
    expect(page.Annotations.length).toBe(2);

    expect(page.Annotations[0].Flatten()).toBe(true);
    expect(page.Annotations.length).toBe(1);
    expect(content(doc)).toMatch(/\/Fm\d+ Do/);
  });

  it('unwires the field when the annotation flattened is a form widget', () => {
    // A widget is not just ink: baking it without unwiring the field leaves the
    // value reachable from /AcroForm /Fields with no widget anywhere.
    const doc = formWith(2);
    const widget = doc.Pages[0].Annotations.find(
      (a) => a.Subtype === 'Widget')!;
    expect(widget.Flatten()).toBe(true);
    const saved = Document.Open(doc.Save());
    expect(acroFieldNames(saved).length).toBe(1);
    expect(widgetNames(saved).length).toBe(1);
  });

  it('returns false for an annotation with no usable appearance', () => {
    const doc = Document.Open(buildBlankPage());
    const page = doc.Pages[0];
    const note = page.AddTextNote({ rect: [10, 10, 30, 30], contents: 'hi' });
    note.Dict.delete('AP');
    expect(page.Annotations[0].Flatten()).toBe(false);
    expect(page.Annotations.length).toBe(1);
  });
});

describe('per-object flatten and the structure tree', () => {
  /** A blank page with two tagged text fields, each under its own /Form element. */
  function taggedFields(): Document {
    const doc = Document.Open(buildBlankPage());
    doc.Form.AddTextField({ page: 1, rect: [10, 10, 210, 40], name: 'a' });
    doc.Form.AddTextField({ page: 1, rect: [10, 50, 210, 80], name: 'b' });
    const root = doc.CreateStructTree();
    for (const w of doc.Pages[0].Annotations)
      root.Append('Form', { alt: 'field' }).AddAnnotation(w);
    return doc;
  }

  it('retags the flattened field as content rather than untagging it', () => {
    const doc = taggedFields();
    doc.Form.Get('a')!.Flatten();

    const tree = doc.GetStructTree()!;
    // /Form describes a widget annotation and there is no widget any more, so
    // the element retypes — but it is still in the tree, holding the baked ink.
    const types = tree.Children.map((c) => c.Type).sort();
    expect(types).toEqual(['Figure', 'Form']);
  });

  it('does not leave the flattened widget alive through Save', () => {
    const doc = taggedFields();
    doc.Form.Get('a')!.Flatten();
    const saved = Document.Open(doc.Save());
    let widgets = 0;
    for (const [, o] of saved.objectEntries()) {
      if (!isDict(o)) continue;
      const st = saved.resolve(o.get('Subtype'));
      if (isName(st) && st.name === 'Widget') widgets++;
    }
    expect(widgets).toBe(1); // only field b
  });
});
