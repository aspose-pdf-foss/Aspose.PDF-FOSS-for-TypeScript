import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { name, isRef, type PdfDict, type PdfObject } from '../src/types.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';

const open = () => Document.Open(buildMultiStreamPage([
  'BT /F1 10 Tf 50 210 Td (First paragraph) Tj ET BT /F1 10 Tf 50 150 Td (Second paragraph) Tj ET',
]));
const action = { type: 'uri', uri: 'https://example.org' } as const;
const rect: [number, number, number, number] = [49, 209, 130, 221];
const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('annotation structure in AutoTag', () => {
  it('places links with their text, keeps the remaining page order and preserves rendered and extracted content', () => {
    const doc = open(), page = doc.Pages[0];
    const note = page.AddTextNote({ rect: [5, 5, 25, 25], contents: 'Review note', popup: {} });
    const second = page.AddLink({ rect: [49, 149, 145, 161], action });
    const first = page.AddLink({ rect, action });
    first.Dict.delete('P'); // Optional in ordinary producer PDFs.
    const blank = doc.AddPage().page;
    const widget = dict([['Subtype', name('Widget')], ['Rect', [20, 20, 50, 40]]]);
    const arr = doc.resolve(page.Dict.get('Annots')) as PdfObject[];
    arr.push(widget);
    const original = Document.Open(doc.Save()).Pages[0];
    const pixels = original.ToImage({ scale: 0.5 }), plain = original.GetText();
    expect(doc.AutoTag({ tables: false }).annotations).toBe(4);
    expect(blank.Dict.has('Tabs')).toBe(false);

    const saved = Document.Open(doc.Save()), p = saved.Pages[0], tree = saved.GetStructTree()!;
    expect(p.Dict.get('Tabs')).toEqual(name('S'));
    expect(p.GetText()).toBe(plain);
    expect(p.ToImage({ scale: 0.5 })).toEqual(pixels);
    expect(tree.Children.map(e => e.Type)).toEqual(['P', 'P', 'Annot', 'Form']);
    const [p1, p2, noteOwner, formOwner] = tree.Children;
    const owners = [p1.Children[0], p2.Children[0], noteOwner, formOwner];
    expect(owners.map(e => e.Type)).toEqual(['Link', 'Link', 'Annot', 'Form']);
    for (const [i, el] of owners.entries()) {
      const items = el.ContentItems;
      expect(items).toHaveLength(1);
      const item = items[0];
      if (item.kind !== 'objr') throw Error('expected OBJR');
      const a = saved.resolve(item.ref) as PdfDict;
      expect(item.page?.Number).toBe(1);
      expect(tree.ElementForObject(a.get('StructParent') as number)?.Dict).toBe(el.Dict);
      expect(a.get('Rect')).toEqual([first.Rect, second.Rect, note.Rect, widget.get('Rect')][i]);
    }
    expect(p.Annotations.find(a => a.Subtype === 'Popup')!.Dict.has('StructParent')).toBe(false);
  });

  it('preserves a manual tag and its parent-tree key on repeated forced tagging', () => {
    const doc = open(), p = doc.Pages[0], link = p.AddLink({ rect, action });
    const root = doc.CreateStructTree(), manual = root.Append('Link', { alt: 'manual label' });
    manual.AddAnnotation(link);
    const key = link.Dict.get('StructParent');
    const raw = doc.resolve(p.Dict.get('Annots')) as PdfObject[];
    raw.push(raw[0]); // same indirect object occurs twice on the page
    const note = p.AddTextNote({ rect: [10, 10, 20, 20], contents: 'note' });
    expect(doc.AutoTag({ force: true }).annotations).toBe(1);
    expect(doc.AutoTag({ force: true }).annotations).toBe(0);
    expect(link.Dict.get('StructParent')).toBe(key);
    expect(root.ElementForObject(key as number)?.Dict).toBe(manual.Dict);
    expect(manual.ContentItems.filter(k => k.kind === 'objr')).toHaveLength(1);
    const saved = Document.Open(doc.Save());
    expect(new TextDecoder('latin1').decode(saved.Save()).match(/\/Type \/OBJR\b/g)).toHaveLength(2);
    expect(root.ElementForObject(note.Dict.get('StructParent') as number)?.Type).toBe('Annot');
  });

  it('sets tab order on an annotation-only page and skips noninteractive and hidden entries', () => {
    const doc = Document.New(), p = doc.AddPage().page;
    const annotations = ['PrinterMark', 'Popup', 'TrapNet'].map(s => dict([['Subtype', name(s)]]));
    for (const flag of [1, 2, 32]) annotations.push(dict([['Subtype', name('Text')], ['F', flag]]));
    annotations.push(dict([['Subtype', name('Widget')], ['Rect', [1, 1, 1, 1]]]));
    const visible = dict([['Subtype', name('Text')], ['F', 32 | 256]]);
    p.Dict.set('Annots', [...annotations, visible]);
    p.Dict.set('Tabs', name('R'));
    expect(doc.AutoTag().annotations).toBe(1);
    expect(p.Dict.get('Tabs')).toEqual(name('S'));
    expect(annotations.every(a => !a.has('StructParent'))).toBe(true);
    expect(isRef((p.Dict.get('Annots') as PdfObject[]).at(-1))).toBe(true);
    expect(doc.GetStructTree()!.ElementForObject(visible.get('StructParent') as number)?.Type).toBe('Annot');
  });

  it('places a link over cell text under that cell in table reading order', () => {
    const grid = hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
      + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
      + text(55, 175, 'A') + text(105, 175, 'B') + text(55, 125, 'C') + text(105, 125, 'D');
    const doc = Document.Open(buildTablePdf(grid));
    doc.Pages[0].AddLink({ rect: [104, 124, 115, 138], action });
    doc.AutoTag();
    const tree = Document.Open(doc.Save()).GetStructTree()!;
    expect(tree.Children[0].Children[1].Children[1].Children.map(e => e.Type)).toEqual(['Link']);
  });

  it('uses the active QuadPoints of a link rather than whitespace inside its enclosing rectangle', () => {
    const doc = open(), p = doc.Pages[0];
    const link = p.AddLink({ rect: [49, 149, 150, 222], action });
    link.Dict.set('QuadPoints', [49, 149, 150, 149, 150, 161, 49, 161]);
    doc.AutoTag();
    const [first, second] = doc.GetStructTree()!.Children;
    expect(first.Children).toHaveLength(0);
    expect(second.Children[0].Alt).toBe('Second paragraph');
  });

  it('repairs a missing OBJR in its existing owner without allocating another parent-tree key', () => {
    const doc = open(), p = doc.Pages[0], link = p.AddLink({ rect, action });
    const root = doc.CreateStructTree(), manual = root.Append('Link', { alt: 'manual label' });
    manual.AddAnnotation(link);
    const key = link.Dict.get('StructParent');
    manual.Dict.delete('K');
    doc.AutoTag({ force: true });
    expect(link.Dict.get('StructParent')).toBe(key);
    expect(root.ElementForObject(key as number)?.Dict).toBe(manual.Dict);
    expect(manual.ContentItems.map(c => c.kind)).toEqual(['objr']);
  });

  it('recognizes an indirect link subtype and orders two links on one line by their anchors', () => {
    const doc = open(), page = doc.Pages[0];
    const later = page.AddLink({ rect: [76, 209, 135, 222], action });
    const earlier = page.AddLink({ rect: [49, 209, 72, 222], action });
    earlier.Dict.set('Subtype', doc.allocObject(name('Link')));
    doc.AutoTag();
    const [a, b] = doc.GetStructTree()!.Children[0].Children;
    expect(a?.Dict).toBe(doc.GetStructTree()!.ElementForObject(earlier.Dict.get('StructParent') as number)?.Dict);
    expect(b?.Dict).toBe(doc.GetStructTree()!.ElementForObject(later.Dict.get('StructParent') as number)?.Dict);
  });

  it('orders links in a multiline cell by text reading order even when the lower link is farther left', () => {
    const grid = hline(50, 180, 220) + hline(50, 180, 150) + hline(50, 180, 100)
      + vline(50, 100, 220) + vline(125, 100, 220) + vline(180, 100, 220)
      + text(53, 165, 'Lower') + text(82, 195, 'Upper') + text(130, 195, 'B')
      + text(55, 125, 'C') + text(130, 125, 'D');
    const doc = Document.Open(buildTablePdf(grid)), page = doc.Pages[0];
    page.AddLink({ rect: [50, 164, 90, 178], action });
    page.AddLink({ rect: [81, 194, 120, 208], action });
    doc.AutoTag();
    const cell = doc.GetStructTree()!.Children[0].Children[0].Children[0];
    expect(cell.Children.map(el => el.Alt)).toEqual(['Upper', 'Lower']);
  });
});
