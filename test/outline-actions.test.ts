import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import type { PdfAction } from '../src/actions.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildOutlinePdf } from './helpers/build-outline-pdf.js';

const open = () => Document.Open(buildOutlinePdf());
const reopen = (doc: Document) => Document.Open(doc.Save());
const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);
function first(doc: Document): PdfDict {
  const root = doc.resolve(doc.catalog().get('Outlines')) as PdfDict;
  return doc.resolve(root.get('First')) as PdfDict;
}
function install(doc: Document, action: PdfObject): void {
  const item = first(doc);
  item.delete('Dest');
  item.set('A', action);
}

describe('bookmark actions', () => {
  const actions: PdfAction[] = [
    { type: 'uri', uri: 'https://example.org/' }, { type: 'goto', page: 2, view: { type: 'Fit' } },
    { type: 'submit', url: 'https://example.org/form', fields: ['Name'], format: 'xfdf' },
    { type: 'reset', fields: ['Name'], exclude: true }, { type: 'javascript', script: 'void 0' },
  ];
  it.each(actions)('authors and reads a $type bookmark through Save/Open', action => {
    const doc = open();
    doc.SetOutlines([{ Title: 'Action', Action: action }]);
    const saved = reopen(doc);
    expect(saved.GetOutlines()[0].Action).toEqual(action);
    expect(first(saved).has('A')).toBe(true);
    expect(first(saved).has('Dest')).toBe(false);
  });

  it('keeps an indirect unknown action, its private keys and its successor through a rename and spread', () => {
    const doc = open();
    const opaque = dict([['S', name('VendorJump')], ['Version', 42], ['Next', dict([['S', name('ResetForm')]])]]);
    const raw = doc.allocObject(opaque);
    install(doc, raw);
    const [item] = doc.GetOutlines();
    doc.SetOutlines([{ ...item, Title: 'Renamed', Bold: true }]);
    expect(first(doc).get('A')).toEqual(raw);
    const saved = reopen(doc);
    expect(saved.resolve(first(saved).get('A'))).toEqual(opaque);
    expect(saved.GetOutlines()[0].Title).toBe('Renamed');
  });

  it('retains a named action and its chain even when the name resolves to a page', () => {
    const doc = open();
    const action = dict([['S', name('GoTo')], ['D', name('chap3')], ['Next', dict([['S', name('Print')]])]]);
    install(doc, action);
    const [item] = doc.GetOutlines();
    expect(item.Dest).toEqual({ name: 'chap3' });
    expect(item.Action).toEqual({ type: 'goto', page: 2, view: { type: 'Fit' } });
    doc.SetOutlines([{ ...item, Children: [], Title: 'Changed' }]);
    const saved = reopen(doc);
    expect(saved.resolve(first(saved).get('A'))).toEqual(action);
    expect(first(saved).has('Dest')).toBe(false);
  });

  it('honors changes to the typed action and legacy Dest, including a nested edit', () => {
    const doc = open();
    const d = [doc.pageRef(1), name('XYZ'), 10, 30, null];
    install(doc, dict([['S', name('GoTo')], ['D', d]]));
    let [item] = doc.GetOutlines();
    if (item.Action?.type !== 'goto' || item.Action.view?.type !== 'XYZ') throw Error('expected a typed GoTo');
    item.Action.view.left = 45;
    doc.SetOutlines([item]);
    expect(doc.GetOutlines()[0].Dest).toMatchObject({ view: { left: 45 } });
    [item] = doc.GetOutlines();
    item.Dest = { name: 'later' };
    doc.SetOutlines([item]);
    expect(first(doc).has('A')).toBe(false);
    expect(reopen(doc).GetOutlines()[0].Dest).toEqual({ name: 'later' });
  });

  it('validates nested actions and competing targets before replacing the old tree', () => {
    const doc = open(), before = doc.Save();
    expect(() => doc.SetOutlines([{ Title: 'outer', Children: [{ Title: 'bad', Action: { type: 'goto', page: 99 } }] }]))
      .toThrow(RangeError);
    expect(() => doc.SetOutlines([{ Title: 'both', Dest: { page: 1 }, Action: actions[0] }])).toThrow(/Action.*Dest|Dest.*Action/);
    expect(doc.Save()).toEqual(before);
  });

  it('keeps shared bookmark, link and catalog open-action coordinates after a resize and a stale outline edit', () => {
    const doc = open(), dest = doc.allocObject([doc.pageRef(2), name('XYZ'), 15, 30, 1.5]);
    const raw = doc.allocObject(dict([['S', name('GoTo')], ['D', dest]]));
    install(doc, raw);
    doc.catalog().set('OpenAction', raw);
    doc.Pages[0].Dict.set('Annots', [dict([['Subtype', name('Link')], ['Dest', dest], ['Rect', [1, 2, 3, 4]]])]);
    const [item] = doc.GetOutlines();
    doc.ResizePages([2], [0, 0, 1224, 1584]);
    doc.SetOutlines([{ ...item, Title: 'Resized' }]);
    const saved = reopen(doc);
    const expected = { type: 'goto', page: 2, view: { type: 'XYZ', left: 30, top: 60, zoom: 1.5 } };
    expect(saved.GetOpenAction()).toEqual({ kind: 'action', action: expected });
    expect(saved.GetOutlines()[0].Action).toEqual(expected);
    expect(first(saved).get('A')).toEqual(saved.catalog().get('OpenAction'));
    expect((saved.resolve(first(saved).get('A')) as PdfDict).get('D')).toEqual(saved.Pages[0].Annotations[0].Dict.get('Dest'));
  });

  it('rejects reusing foreign opaque references and allows a replacement typed action', () => {
    const source = open(), target = open();
    install(source, source.allocObject(dict([['S', name('Custom')]])));
    const [item] = source.GetOutlines(), before = target.Save();
    expect(() => target.SetOutlines([item])).toThrow(/document/);
    expect(target.Save()).toEqual(before);
    target.SetOutlines([{ ...item, Action: actions[0] }]);
    expect(reopen(target).GetOutlines()[0].Action).toEqual(actions[0]);
  });

  it('resizes the destination-dictionary form of OpenAction when it is independent of the bookmark', () => {
    const doc = open();
    doc.catalog().set('OpenAction', dict([['D', [doc.pageRef(2), name('FitH'), 30]]]));
    doc.SetOutlines([{ Title: 'Other page', Action: { type: 'goto', page: 3 } }]);
    doc.ResizePages([2], [0, 0, 1224, 1584]);
    expect(reopen(doc).GetOpenAction()).toEqual({ kind: 'dest', dest: { page: 2, view: { type: 'FitH', top: 60 } } });
  });

  it('leaves an opened bookmark-free document unmodified on an empty replacement', () => {
    const doc = open();
    doc.SetOutlines([]);
    const saved = reopen(doc);
    saved.SetOutlines([]);
    expect(saved.isModifiedInternal()).toBe(false);
  });

  it('refuses stale raw references when a new catalog object graph is installed in the same document', () => {
    const doc = open();
    install(doc, doc.allocObject(dict([['S', name('Custom')]])));
    const items = doc.GetOutlines();
    doc.trailer.set('Root', doc.allocObject(new Map(doc.catalog())));
    const before = doc.Save();
    expect(() => doc.SetOutlines(items)).toThrow(/document/);
    expect(doc.Save()).toEqual(before);
  });
});
