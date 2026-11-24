import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { LinkAnnotation } from '../src/annotation.js';
import { name, type PdfDict, type PdfObject } from '../src/types.js';

const rect: [number, number, number, number] = [10, 10, 70, 35];
const action = { type: 'uri', uri: 'https://example.org/review' } as const;

describe('link highlight and border', () => {
  it.each([['none', 'N'], ['outline', 'O'], ['push', 'P'], ['invert', undefined]] as const)(
    'round-trips %s through the public API', (highlight, code) => {
      const doc = Document.New(), page = doc.AddPage().page;
      const link = page.AddLink({ rect, action, border: 2.5, highlight });
      expect(link.Dict.get('H')).toEqual(code ? name(code) : undefined);
      const reopened = Document.Open(doc.Save()).Pages[0].Annotations[0] as LinkAnnotation;
      expect([reopened.Highlight, reopened.BorderWidth, reopened.Action]).toEqual([highlight, 2.5, action]);
      reopened.Highlight = 'invert';
      expect(reopened.Dict.has('H')).toBe(false);
    });

  it('edits a legacy border without changing its shared corners, dash array, appearance or destination', () => {
    const doc = Document.New(), page = doc.AddPage().page;
    const link = page.AddLink({ rect, action });
    expect([link.Highlight, link.BorderWidth]).toEqual(['invert', 0]);
    link.Dict.delete('A');
    const dest = [doc.pageRef(1), name('Fit')];
    link.Dict.set('Dest', dest);
    const border = [4, 5, 1, [6, 3]], ref = doc.allocObject(border);
    link.Dict.set('Border', ref);
    const ap = new Map<string, PdfObject>();
    link.Dict.set('AP', ap);
    link.Dict.set('H', doc.allocObject(name('O')));
    expect(link.Highlight).toBe('outline');
    link.BorderWidth = 3;
    link.Highlight = 'push';
    expect(doc.resolve(link.Dict.get('Border'))).toEqual([4, 5, 3, [6, 3]]);
    expect(doc.resolve(ref)).toEqual([4, 5, 1, [6, 3]]);
    expect(link.Dict.get('AP')).toBe(ap);
    expect(link.Dict.get('Dest')).toBe(dest);
    expect((Document.Open(doc.Save()).Pages[0].Annotations[0] as LinkAnnotation).Dest).toMatchObject({ page: 1 });
  });

  it('honors /BS over /Border and preserves the style of a shared indirect border dictionary', () => {
    const doc = Document.New(), link = doc.AddPage().page.AddLink({ rect, action, border: 4 });
    const bs: PdfDict = new Map<string, PdfObject>([['W', doc.allocObject(7)], ['D', [3, 2]], ['S', name('D')]]);
    link.Dict.set('BS', doc.allocObject(bs));
    expect(link.BorderWidth).toBe(7);
    link.BorderWidth = 0;
    const edited = doc.resolve(link.Dict.get('BS')) as PdfDict;
    expect([edited.get('W'), edited.get('D'), edited.get('S')]).toEqual([0, [3, 2], name('D')]);
    expect(doc.resolve(bs.get('W'))).toBe(7);
    expect((Document.Open(doc.Save()).Pages[0].Annotations[0] as LinkAnnotation).BorderWidth).toBe(0);
  });

  it('rejects invalid activation settings and widths before changing a link or attaching a new one', () => {
    const doc = Document.New(), page = doc.AddPage().page;
    expect(() => page.AddLink({ rect, action, highlight: 'invalid' as never })).toThrow(TypeError);
    expect(page.Annotations).toHaveLength(0);
    const link = page.AddLink({ rect, action });
    link.Dict.delete('Border');
    expect(link.BorderWidth).toBe(1);
    expect(() => { link.BorderWidth = -1; }).toThrow(TypeError);
    expect(() => { link.Highlight = 'invalid' as never; }).toThrow(TypeError);
    expect([link.BorderWidth, link.Highlight]).toEqual([1, 'invert']);
    expect(link.Action).toEqual(action);
  });
});
