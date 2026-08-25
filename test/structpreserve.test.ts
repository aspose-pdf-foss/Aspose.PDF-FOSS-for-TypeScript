import { describe, test, expect } from 'vitest';
import { Document } from '../src/index.js';
import { buildMultiPageTaggedPdf, buildRoleConflictTaggedPdf } from './helpers/build-multipage-tagged-pdf.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

describe('structpreserve fixture', () => {
  test('multi-page tagged fixture opens with a 2-element root and spanning Sect', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    expect(doc.Pages.length).toBe(2);
    expect(doc.IsTagged).toBe(true);
    const tree = doc.GetStructTree();
    expect(tree).not.toBeNull();
    const top = tree!.Children;
    expect(top.map((e) => e.Type)).toEqual(['Document']);
    const document = top[0];
    expect(document.Children.map((e) => e.Type)).toEqual(['Sect', 'Figure']);
    const sect = document.Children[0];
    expect(sect.Children.map((e) => e.Type)).toEqual(['P', 'P']);
    // reading order across both pages
    expect(tree!.GetText()).toContain('Page one body');
    expect(tree!.GetText()).toContain('Page two body');
  });
});

describe('structpreserve — Split', () => {
  test('each split page is tagged with its own slice', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const parts = doc.Split();
    expect(parts.length).toBe(2);

    const t0 = parts[0].GetStructTree();
    expect(parts[0].IsTagged).toBe(true);
    expect(t0).not.toBeNull();
    expect(t0!.GetText()).toContain('Page one body');
    expect(t0!.GetText()).not.toContain('Page two body');
    // ParentTree round-trips: page 1's StructParents resolves MCID 0 -> a P
    const sp = parts[0].Pages[0].Dict.get('StructParents');
    expect(typeof sp).toBe('number');
    expect(t0!.ElementFor(sp as number, 0)?.Type).toBe('P');

    const t1 = parts[1].GetStructTree();
    expect(t1!.GetText()).toContain('Page two body');
    expect(t1!.GetText()).not.toContain('Page one body');
  });
});

describe('structpreserve — ExtractPages', () => {
  test('subset prunes dropped-page branches; spanning Sect keeps only survivor', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const out = doc.ExtractPages([1]);
    const tree = out.GetStructTree();
    expect(tree).not.toBeNull();
    const document = tree!.Children[0];
    expect(document.Type).toBe('Document');
    const sect = document.Children.find((e) => e.Type === 'Sect')!;
    expect(sect).toBeDefined();
    // Sect spanned pages 1 & 2; only the page-1 P survives
    expect(sect.Children.map((e) => e.Type)).toEqual(['P']);
    expect(tree!.GetText()).toContain('Page one body');
    expect(tree!.GetText()).not.toContain('Page two body');
  });

  test('source document is not mutated', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    doc.ExtractPages([1]);
    // source still spans both pages
    const sect = doc.GetStructTree()!.Children[0].Children[0];
    expect(sect.Children.length).toBe(2);
  });
});

describe('structpreserve — Merge/Append', () => {
  test('merge of two tagged docs concatenates trees with non-colliding keys', () => {
    const a = Document.Open(buildMultiPageTaggedPdf()); // pages 1,2
    const b = Document.Open(buildMultiPageTaggedPdf()); // pages 1,2
    const merged = Document.Merge(a, b);
    expect(merged.Pages.length).toBe(4);
    const tree = merged.GetStructTree();
    expect(tree).not.toBeNull();
    // two Document roots (one per source)
    expect(tree!.Children.map((e) => e.Type)).toEqual(['Document', 'Document']);
    // every page's StructParents key is distinct
    const keys = merged.Pages.map((p) => p.Dict.get('StructParents'));
    expect(new Set(keys).size).toBe(keys.length);
    // each page resolves its own MCID 0 to a P
    for (const p of merged.Pages) {
      const k = p.Dict.get('StructParents') as number;
      expect(tree!.ElementFor(k, 0)?.Type).toBe('P');
    }
    expect(tree!.GetText()).toContain('Page one body');
    expect(tree!.GetText()).toContain('Page two body');
  });

  test('append onto a tagged doc grafts the source tree and keeps existing keys', () => {
    const a = Document.Open(buildMultiPageTaggedPdf());
    const b = Document.Open(buildMultiPageTaggedPdf());
    const beforeKeys = a.Pages.map((p) => p.Dict.get('StructParents'));
    a.Append(b);
    expect(a.Pages.length).toBe(4);
    // original pages keep their structure-parent keys
    expect(a.Pages.slice(0, 2).map((p) => p.Dict.get('StructParents'))).toEqual(beforeKeys);
    const tree = a.GetStructTree();
    expect(tree!.Children.map((e) => e.Type)).toEqual(['Document', 'Document']);
  });

  test('RoleMap conflict renames the source role and updates cloned /S', () => {
    const a = Document.Open(buildMultiPageTaggedPdf()); // RoleMap MyHead->H2
    const b = Document.Open(buildRoleConflictTaggedPdf()); // RoleMap MyHead->H3, a MyHead element
    const merged = Document.Merge(a, b);
    const rm = merged.GetStructTree()!.RoleMap;
    expect(rm.get('MyHead')).toBe('H2');       // a's mapping preserved
    expect(rm.get('MyHead_2')).toBe('H3');      // b's conflicting mapping renamed
    const text = JSON.stringify([...rm.entries()]);
    expect(text).toContain('MyHead_2');
  });
});

describe('structpreserve — OBJR / annotations', () => {
  test('surviving annotation keeps its Figure structure and re-keyed StructParent', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const out = doc.ExtractPages([1]); // page 1 carries the Figure + Link annot
    const tree = out.GetStructTree();
    const figure = tree!.Children[0].Children.find((e) => e.Type === 'Figure');
    expect(figure).toBeDefined();
    expect(figure!.Alt).toBe('A figure');
    // the OBJR resolves to a surviving annotation, re-keyed into the new ParentTree
    const items = figure!.ContentItems;
    const objr = items.find((it) => it.kind === 'objr');
    expect(objr).toBeDefined();
    const annot = out.resolve((objr as { ref: import('../src/types.js').PdfRef }).ref);
    const key = (annot as Map<string, unknown>).get('StructParent');
    expect(typeof key).toBe('number');
    expect(tree!.ElementForObject(key as number)?.Type).toBe('Figure');
  });

  test('Figure on a dropped page is pruned entirely', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    const out = doc.ExtractPages([2]); // page 2 has no Figure/annot
    const tree = out.GetStructTree();
    const types = tree!.Children[0].Children.map((e) => e.Type);
    expect(types).not.toContain('Figure');
  });
});

describe('structpreserve — opt-out, untagged, AddPage, Reorder', () => {
  test('opt-out drops structure on Split and ExtractPages', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    expect(doc.Split({ preserveStructure: false })[0].GetStructTree()).toBeNull();
    expect(doc.ExtractPages([1], { preserveStructure: false }).GetStructTree()).toBeNull();
  });

  test('untagged source yields untagged output', () => {
    const doc = Document.Open(buildClassicPdf(2));
    expect(doc.IsTagged).toBe(false);
    expect(doc.Split()[0].GetStructTree()).toBeNull();
    expect(doc.ExtractPages([1]).GetStructTree()).toBeNull();
    expect(Document.Merge(doc, doc).GetStructTree()).toBeNull();
  });

  test('AddPage(source) carries the page structure into a fresh doc', () => {
    const src = Document.Open(buildMultiPageTaggedPdf());
    const dst = Document.Merge(); // empty, untagged
    dst.AddPage(src.Pages[0]);
    const tree = dst.GetStructTree();
    expect(tree).not.toBeNull();
    expect(tree!.GetText()).toContain('Page one body');
  });

  test('Reorder leaves the existing structure tree intact and resolvable', () => {
    const doc = Document.Open(buildMultiPageTaggedPdf());
    doc.Reorder([2, 1]);
    const tree = doc.GetStructTree();
    expect(tree).not.toBeNull();
    // both pages still resolve their MCID 0 to a P
    for (const p of doc.Pages) {
      const k = p.Dict.get('StructParents') as number;
      expect(tree!.ElementFor(k, 0)?.Type).toBe('P');
    }
  });
});
