import { expect, it } from 'vitest';
import { Document, MarkupAnnotation } from '../src/index.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';

const pdf = (...pages: string[][]) => buildMultiPageTextPdf(pages.map(lines =>
  lines.map((line, i) => `BT /F1 10 Tf 20 ${260 - 20 * i} Td (${line}) Tj ET`).join('\n')));
const doc = (...pages: string[][]) => Document.Open(pdf(...pages));

it('marks the selected live copy, keeping both originals and their byte views intact', () => {
  const bytes = pdf(['start new end']);
  const before = Uint8Array.from(bytes);
  const a = doc(['start old end']), b = Document.Open(bytes);
  b.Pages[0].AddCaret({ rect: [5, 5, 10, 10], contents: 'existing' });
  for (const side of ['source', 'destination'] as const) {
    const { document, comparison } = a.CompareMarkup(b, side === 'source' ? { side } : {});
    expect(comparison).toEqual(a.CompareText(b));
    const page = Document.Open(document.Save()).Pages[0];
    const source = side === 'source';
    const mark = page.Annotations.find(m => m.Subtype === (source ? 'StrikeOut' : 'Highlight'))!;
    expect(mark.Rect).toEqual(page.Search(source ? 'old' : 'new')[0].quads[0]);
    expect(mark.Contents).toContain(source ? 'old' : 'new');
    const caret = page.Annotations.find(m => m.Subtype === 'Caret' && m.Contents !== 'existing')!;
    expect(caret.Contents).toContain(source ? 'new' : 'old');
    expect(caret.Rect![0]).toBeCloseTo(page.Search('start')[0].quads[0][2]);
    expect(page.Annotations.some(m => m.Contents === 'existing')).toBe(!source);
  }
  b.CompareMarkup(b).document.Pages[0].Annotations[0].Contents = 'edited';
  expect(b.Pages[0].Annotations.map(m => m.Contents)).toEqual(['existing']);
  expect(a.Pages[0].Annotations).toHaveLength(0);
  expect(bytes).toEqual(before);
});

it('anchors a leading change before the next equal span and keeps absent pages out of other page pairs', () => {
  const a = doc(['removed keep'], ['only old']), b = doc(['keep']);
  const { document, comparison } = a.CompareMarkup(b, { compare: { mode: 'pages' } });
  expect(document.Pages).toHaveLength(1);
  const notes = document.Pages[0].Annotations;
  expect(notes).toHaveLength(1);
  expect(notes[0].Rect![2]).toBeCloseTo(b.Pages[0].Search('keep')[0].quads[0][0]);
  expect(comparison.pages![1].changes[0].oldText).toBe('only old');
  expect(b.CompareMarkup(a, { side: 'source', compare: { mode: 'pages' } }).document.Pages[0].Annotations).toHaveLength(1);
  expect(doc(['old']).CompareMarkup(doc(['new'])).document.Pages[0].Annotations.map(m => m.Subtype)).toEqual(['Highlight']);
});

it('keeps each changed line in the rotated and cropped page’s own space, including its rendered appearance', () => {
  const a = doc(['keep']), b = doc(['keep one two', 'three']);
  b.Pages[0].Rotate = 90;
  b.Pages[0].Dict.set('CropBox', [10, 150, 280, 290]);
  const out = Document.Open(a.CompareMarkup(b).document.Save());
  const [mark] = out.Pages[0].Annotations as MarkupAnnotation[];
  expect(mark.QuadPoints).toHaveLength(16);
  expect(out.Pages[0].Rotate).toBe(90);
  expect(out.Pages[0].CropBox).toEqual(b.Pages[0].CropBox);
  expect(b.CompareRendering(out, { annotations: false }).identical).toBe(true);
  const boxes = b.CompareRendering(out, { mergeDistance: 0 }).pages[0].regions;
  for (const word of ['one', 'three']) {
    const [x, y, r, t] = b.Pages[0].Search(word)[0].quads[0];
    expect(boxes.some(box => box[0] < r && box[2] > x && box[1] < t && box[3] > y)).toBe(true);
  }
});

it('retains password protection and rejects an invalid side', () => {
  const bytes = doc(['keep new']).Save({ encrypt: { userPassword: 'reader', ownerPassword: 'owner' } });
  const b = Document.Open(bytes, { password: 'reader' });
  const a = doc(['keep']);
  const copy = a.CompareMarkup(b).document.Save();
  expect(() => Document.Open(copy)).toThrow();
  expect(Document.Open(copy, { password: 'reader' }).Pages[0].Annotations).toHaveLength(1);
  expect(() => a.CompareMarkup(b, { side: 'both' as never })).toThrow(RangeError);
});

it('preserves the remaining decode budget of both inputs', () => {
  const compressed = (text: string) => Document.Open(doc([text]).Save({ streamFilter: 'ASCII85Decode' }));
  for (const side of ['source', 'destination'] as const) {
    const a = compressed('old'), b = compressed('new');
    const before = [a.decodeBudget.decoded, b.decodeBudget.decoded];
    const { comparison } = a.CompareMarkup(b, { side });
    expect(comparison.stats).toMatchObject({ deleted: 1, inserted: 1 });
    expect([a.decodeBudget.decoded, b.decodeBudget.decoded]).toEqual(before);
  }
});

it('compares unsaved embedded text on either side without finalizing the input fonts', () => {
  const a = doc(['same']), b = doc(['same']);
  const fa = a.AddFontFile('fonts/LiberationSerif-Regular.ttf');
  const fb = b.AddFontFile('fonts/LiberationSerif-Regular.ttf');
  a.Pages[0].AddText('Ω', 30, 50, { font: fa });
  b.Pages[0].AddText('Ж', 30, 50, { font: fb });
  const slots = [a.getObject(fa.objNum!), b.getObject(fb.objNum!)];
  const { document: copy, comparison } = a.CompareMarkup(b);
  expect(comparison.changes.filter(c => c.op !== 'equal').map(c => c.oldText || c.newText)).toEqual(['Ω', 'Ж']);
  expect(a.getObject(fa.objNum!)).toBe(slots[0]);
  expect(b.getObject(fb.objNum!)).toBe(slots[1]);
  expect(Document.Open(copy.Save()).Pages[0].GetText()).toContain('Ж');
});
