import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { name } from '../src/types.js';
import { buildStampTarget } from './helpers/build-stamp-target.js';

describe('TableAttributes (read/write)', () => {
  it('round-trips table attributes through Save/Open', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const td = root.Append('Table').Append('TR').Append('TD');
    td.SetTableAttributes({ colSpan: 2, headers: ['h1', 'h2'], scope: 'Column' });

    const re = Document.Open(doc.Save());
    const rtd = re.GetStructTree()!.Children[0].Children[0].Children[0];
    const a = rtd.TableAttributes!;
    expect(a.colSpan).toBe(2);
    expect(a.rowSpan).toBe(1);          // default
    expect(a.headers).toEqual(['h1', 'h2']);
    expect(a.scope).toBe('Column');
  });

  it('returns undefined when the element has no /Table attributes', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    expect(p.TableAttributes).toBeUndefined();
  });

  it('prefers /A over /C (ClassMap) for the same owner+key', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const td = root.Append('Table').Append('TD');
    // /C class "cell" -> ColSpan 9 in ClassMap; /A ColSpan 3 must win.
    root.Dict.set('ClassMap', new Map([
      ['cell', new Map<string, any>([['O', name('Table')], ['ColSpan', 9]])],
    ]));
    td.Dict.set('C', name('cell'));
    td.SetTableAttributes({ colSpan: 3 });
    expect(td.TableAttributes!.colSpan).toBe(3);
  });

  it('reads an attribute supplied only via /C', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const td = root.Append('Table').Append('TD');
    root.Dict.set('ClassMap', new Map([
      ['cell', new Map<string, any>([['O', name('Table')], ['RowSpan', 4]])],
    ]));
    td.Dict.set('C', name('cell'));
    expect(td.TableAttributes!.rowSpan).toBe(4);
  });

  it('deletes a key when set to undefined', () => {
    const doc = Document.Open(buildStampTarget());
    const td = doc.CreateStructTree().Append('Table').Append('TD');
    td.SetTableAttributes({ scope: 'Row' });
    td.SetTableAttributes({ scope: undefined });
    expect(td.TableAttributes!.scope).toBeUndefined();
  });
});

describe('ListAttributes (read/write)', () => {
  it('round-trips ListNumbering', () => {
    const doc = Document.Open(buildStampTarget());
    const l = doc.CreateStructTree().Append('L');
    l.SetListAttributes({ listNumbering: 'Decimal' });
    const re = Document.Open(doc.Save());
    const rl = re.GetStructTree()!.Children[0];
    expect(rl.ListAttributes!.listNumbering).toBe('Decimal');
  });

  it('returns undefined when there is no /List owner', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    expect(p.ListAttributes).toBeUndefined();
  });

  it('ignores an out-of-enum ListNumbering value (lenient)', () => {
    const doc = Document.Open(buildStampTarget());
    const l = doc.CreateStructTree().Append('L');
    l.Dict.set('A', [new Map<string, any>([['O', name('List')], ['ListNumbering', name('Bogus')]])]);
    expect(l.ListAttributes!.listNumbering).toBeUndefined();
  });
});

describe('LayoutAttributes (read/write)', () => {
  it('round-trips scalar, enum, color, bbox, and number-or-name fields', () => {
    const doc = Document.Open(buildStampTarget());
    const fig = doc.CreateStructTree().Append('Figure');
    fig.SetLayoutAttributes({
      placement: 'Block',
      color: [1, 0, 0],
      spaceBefore: 6,
      bbox: [10, 20, 110, 220],
      width: 'Auto',
      lineHeight: 14,
      columnWidths: [100, 120],
    });
    const re = Document.Open(doc.Save());
    const a = re.GetStructTree()!.Children[0].LayoutAttributes!;
    expect(a.placement).toBe('Block');
    expect(a.color).toEqual([1, 0, 0]);
    expect(a.spaceBefore).toBe(6);
    expect(a.bbox).toEqual([10, 20, 110, 220]);
    expect(a.width).toBe('Auto');
    expect(a.lineHeight).toBe(14);
    expect(a.columnWidths).toEqual([100, 120]);
  });

  it('round-trips Edged values (scalar and per-edge)', () => {
    const doc = Document.Open(buildStampTarget());
    const root = doc.CreateStructTree();
    const a = root.Append('P');
    const b = root.Append('P');
    a.SetLayoutAttributes({ padding: 4, borderColor: [0, 0, 1] });
    b.SetLayoutAttributes({ padding: [1, 2, 3, 4], borderColor: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]] });
    const re = Document.Open(doc.Save());
    const ra = re.GetStructTree()!.Children[0].LayoutAttributes!;
    const rb = re.GetStructTree()!.Children[1].LayoutAttributes!;
    expect(ra.padding).toBe(4);
    expect(ra.borderColor).toEqual([0, 0, 1]);
    expect(rb.padding).toEqual([1, 2, 3, 4]);
    expect(rb.borderColor).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]]);
  });

  it('is lenient: a malformed field is omitted, siblings intact', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    p.Dict.set('A', [new Map<string, any>([
      ['O', name('Layout')],
      ['SpaceBefore', name('NotANumber')], // wrong type
      ['SpaceAfter', 8],
    ])]);
    const a = p.LayoutAttributes!;
    expect(a.spaceBefore).toBeUndefined();
    expect(a.spaceAfter).toBe(8);
  });

  it('returns undefined when there is no /Layout owner', () => {
    const doc = Document.Open(buildStampTarget());
    const p = doc.CreateStructTree().Append('P');
    expect(p.LayoutAttributes).toBeUndefined();
  });
});
