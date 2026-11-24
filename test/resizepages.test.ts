import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';
import { buildClassicPdf } from './helpers/build-pdf.js';

const box: [number, number, number, number] = [5, 7, 205, 157];
function fixture() {
  const doc = Document.Open(buildClassicPdf(3, { rotate: 90 }));
  doc.Pages[0].CropBox = [10, 20, 110, 70];
  return doc;
}
const dict = (entries: [string, PdfObject][]): PdfDict => new Map(entries);

describe('Document.ResizePages', () => {
  it('uses each selected crop in unrotated page space and preserves indirect Contents arrays', () => {
    const doc = fixture(), [first, second, third] = doc.Pages;
    const original = first.Dict.get('Contents')!;
    first.Dict.set('Contents', doc.allocObject([original]));
    const annotation = dict([['Subtype', name('FreeText')], ['Rect', [20, 30, 40, 50]],
      ['CL', [20, 30, 25, 35, 40, 50]], ['RD', [1, 2, 3, 4]]]);
    first.Dict.set('Annots', doc.allocObject([doc.allocObject(annotation)]));
    second.Dict.set('Annots', [dict([['Subtype', name('Line')], ['L', [10, 20, 60, 100]]])]);
    doc.ResizePages([2, 1, 1], box);

    const [a, b, c] = Document.Open(doc.Save()).Pages;
    expect([a.MediaBox, a.CropBox, b.MediaBox, b.CropBox]).toEqual([box, box, box, box]);
    expect([a.Rotate, b.Rotate]).toEqual([90, 90]);
    expect(new TextDecoder().decode(a.Contents)).toMatch(/2 0 0 3 -15 -53 cm[\s\S]*\(Page 1\)/);
    expect(a.Annotations[0].Rect).toEqual([25, 37, 65, 97]);
    expect(a.Annotations[0].Dict.get('CL')).toEqual([25, 37, 35, 52, 65, 97]);
    expect(a.Annotations[0].Dict.get('RD')).toEqual([2, 6, 6, 12]);
    expect(b.Annotations[0].Dict.get('L')).toEqual([15, 22, 65, 82]);
    expect(c.CropBox).toEqual(third.CropBox);
  });

  it('transforms quadpoints, vertices and every ink stroke without editing shared source coordinates', () => {
    const doc = fixture(), [first, second] = doc.Pages;
    const coordinates = doc.allocObject([20, 30, 40, 50, 50, 60]);
    const polygon = () => dict([['Subtype', name('Polygon')], ['Vertices', coordinates]]);
    const ink = dict([['Subtype', name('Ink')], ['InkList', [coordinates, [30, 40, 40, 50]]]]);
    const mark = dict([['Subtype', name('Highlight')], ['QuadPoints', [20, 30, 40, 30, 20, 50, 40, 50]]]);
    first.Dict.set('Annots', [polygon(), ink, mark]);
    second.Dict.set('Annots', [polygon()]);
    doc.ResizePages([1], box);
    expect(first.Annotations[0].Dict.get('Vertices')).toEqual([25, 37, 65, 97, 85, 127]);
    expect(ink.get('InkList')).toEqual([[25, 37, 65, 97, 85, 127], [45, 67, 65, 97]]);
    expect(mark.get('QuadPoints')).toEqual([25, 37, 65, 37, 25, 97, 65, 97]);
    expect(doc.resolve(second.Annotations[0].Dict.get('Vertices'))).toEqual([20, 30, 40, 50, 50, 60]);
  });

  it('resizes signed line-leader distances perpendicular to the line and moves its popup once', () => {
    const doc = fixture();
    const popup = dict([['Subtype', name('Popup')], ['Rect', [20, 30, 40, 50]]]);
    const horizontal = dict([['Subtype', name('Line')], ['L', [20, 30, 40, 30]],
      ['LL', -4], ['LLE', 3], ['LLO', 2], ['Popup', doc.allocObject(popup)]]);
    const vertical = dict([['Subtype', name('Line')], ['L', [20, 30, 20, 50]], ['LL', 4]]);
    doc.Pages[0].Dict.set('Annots', [horizontal, vertical]);
    doc.ResizePages([1], box);
    expect([horizontal.get('LL'), horizontal.get('LLE'), horizontal.get('LLO'), vertical.get('LL')])
      .toEqual([-12, 9, 6, 8]);
    expect(popup.get('Rect')).toEqual([25, 37, 65, 97]);
  });

  it.each(['selection', 'crop', 'annotation', 'target', 'destination'] as const)('leaves all objects intact on invalid %s', fault => {
    const doc = fixture();
    if (fault === 'crop') doc.Pages[1].CropBox = [5, 0, 5, 10];
    if (fault === 'annotation') doc.Pages[1].Dict.set('Annots', [dict([['Subtype', name('Link')], ['Rect', [2, 3]]])]);
    if (fault === 'destination') doc.catalog().set('OpenAction', [doc.pageRef(2), name('FitR'), 20, null, 40, 50]);
    const before = doc.Save(), count = [...doc.objectEntries()].length;
    expect(() => doc.ResizePages(fault === 'selection' ? [1, 4] : [1, 2],
      fault === 'target' ? [0, 0, 2, 0] : box)).toThrow(/ResizePages:/);
    expect([...doc.objectEntries()].length).toBe(count);
    expect(doc.Save()).toEqual(before);
  });

  it('transforms a destination shared by a cross-page link, outline, catalog and legacy name exactly once', () => {
    const doc = fixture(), dest = doc.allocObject([doc.pageRef(1), name('XYZ'), 20, 30, 1.5]);
    const link = dict([['Subtype', name('Link')], ['Rect', [1, 2, 3, 4]], ['Dest', dest]]);
    doc.Pages[2].Dict.set('Annots', [link]);
    doc.SetOutlines([{ Title: 'target', Dest: { page: 1 } }]);
    const root = doc.resolve(doc.catalog().get('Outlines')) as PdfDict;
    const bookmark = doc.resolve(root.get('First')) as PdfDict;
    bookmark.set('Dest', dest);
    doc.catalog().set('OpenAction', dest);
    doc.catalog().set('Dests', dict([['shared', dict([['D', dest]])]]));
    doc.ResizePages([1], box);
    const reopened = Document.Open(doc.Save());
    const view = { type: 'XYZ', left: 25, top: 37, zoom: 1.5 };
    expect(reopened.GetOutlines()[0].Dest).toEqual({ page: 1, view });
    expect(reopened.GetNamedDestinations()[0].dest.view).toEqual(view);
    expect(reopened.Pages[2].Annotations[0].Rect).toEqual([1, 2, 3, 4]);
    expect(reopened.Pages[2].Annotations[0].Dict.get('Dest')).toEqual(reopened.catalog().get('OpenAction'));
  });

  it('updates local action chains and named views while retaining nulls, zoom and remote coordinates', () => {
    const doc = fixture(), target = doc.pageRef(1);
    const xyz = [target, name('XYZ'), null, 30, null];
    const remote = [0, name('FitH'), 30], other = [doc.pageRef(2), name('FitH'), 30];
    const action = dict([['S', name('URI')], ['Next', [
      dict([['S', name('GoTo')], ['D', xyz]]), dict([['S', name('GoToR')], ['D', remote]]),
      dict([['S', name('GoTo')], ['D', other]])]]]);
    doc.Pages[2].Dict.set('Annots', [dict([['Subtype', name('Link')], ['A', action]])]);
    doc.SetNamedDestination('rect', { page: 1, view: { type: 'FitR', left: 20, bottom: 30, right: 40, top: 50 } });
    for (const fit of ['FitH', 'FitBH', 'FitV', 'FitBV'] as const)
      doc.SetNamedDestination(fit, { page: 1, view: fit === 'FitH' || fit === 'FitBH'
        ? { type: fit, top: 30 } : { type: fit, left: 20 } });
    doc.ResizePages([1], box);
    expect(xyz.slice(2)).toEqual([null, 37, null]);
    expect(remote[2]).toBe(30);
    expect(other[2]).toBe(30);
    const views = Object.fromEntries(doc.GetNamedDestinations().map(d => [d.name, d.dest.view]));
    expect(views.rect).toEqual({ type: 'FitR', left: 25, bottom: 37, right: 65, top: 97 });
    for (const type of ['FitV', 'FitBV']) expect(views[type]).toEqual({ type, left: 25 });
    for (const type of ['FitH', 'FitBH']) expect(views[type]).toEqual({ type, top: 37 });
  });

  it('preserves an omitted nullable view operand and treats an empty selection as a no-op', () => {
    const doc = fixture();
    const abbreviated = [doc.pageRef(1), name('FitH')];
    doc.catalog().set('OpenAction', abbreviated);
    const before = doc.Save();
    doc.ResizePages([], box);
    expect(doc.Save()).toEqual(before);
    doc.ResizePages([1], box);
    expect(abbreviated).toHaveLength(2);
  });
});
