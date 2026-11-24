import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import { PageInformationAnnotation } from '../src/annotation.js';
import { parseContentStream } from '../src/content.js';
import { inflateStream } from '../src/flate.js';
import { isDict, isName, isRef, isStream, name } from '../src/types.js';

const info = { label: 'Proof (A)\\B', timestamp: new Date('2024-01-02T03:04:05Z') };
const text = (n: number) => `Proof (A)\\B  Page ${n}  2024-01-02T03:04:05.000Z`;

function appearance(doc: Document, mark: PageInformationAnnotation) {
  const ap = doc.resolve(mark.Dict.get('AP'));
  if (!isDict(ap)) throw new Error('missing AP dictionary');
  expect([...ap.keys()]).toEqual(['N']);
  expect(isRef(ap.get('N'))).toBe(true);
  const form = doc.resolve(ap.get('N'));
  if (!isStream(form)) throw new Error('missing AP form');
  return form;
}

describe('page information printer marks', () => {
  it('keeps alternate appearances when replacing the caption of a reopened mark', () => {
    const doc = Document.New();
    doc.AddPage().page.AddPrinterMarks({ kinds: ['pageInformation'] });
    const copy = Document.Open(doc.Save());
    const mark = copy.Pages[0].Annotations[0] as PageInformationAnnotation;
    const ap = copy.resolve(mark.Dict.get('AP'));
    if (!isDict(ap)) throw new Error('missing appearance');
    const prior = ap.get('N')!;
    ap.set('R', prior);
    ap.set('D', prior);
    mark.Contents = 'Revised caption';
    const edited = copy.resolve(mark.Dict.get('AP'));
    if (!isDict(edited)) throw new Error('missing replacement appearance');
    expect([edited.get('R'), edited.get('D')]).toEqual([prior, prior]);
    expect(edited.get('N')).not.toEqual(prior);
    expect(ap.get('N')).toBe(prior);
  });
  it('adds a typed mark to each selected page and preserves the text, font and PDF flags', () => {
    const doc = Document.New();
    for (let n = 0; n < 4; n++) doc.AddPage().page.MediaBox = [-20, -10, 140, 90];
    const marks = doc.AddPrinterMarks({ pages: '4,2,4', kinds: ['pageInformation'], pageInformation: info });
    expect(marks.map((mark) => mark.Contents)).toEqual([text(2), text(4)]);
    expect(marks.every((mark) => mark instanceof PageInformationAnnotation)).toBe(true);
    const saved = Document.Open(doc.Save({ compressed: true }));
    expect(saved.Pages.map((page) => page.Annotations.length)).toEqual([0, 1, 0, 1]);
    for (const n of [2, 4]) {
      const page = saved.Pages[n - 1];
      const mark = page.Annotations[0];
      expect(mark).toBeInstanceOf(PageInformationAnnotation);
      if (!(mark instanceof PageInformationAnnotation)) throw new Error('wrong mark');
      expect(mark.Subtype).toBe('PrinterMark');
      expect(mark.MarkName).toBe('PageInformation');
      expect(mark.Flags).toBe(68);
      expect(mark.Contents).toBe(text(n));
      expect(mark.Rect![1]).toBeGreaterThan(page.TrimBox[3]);
      const form = appearance(saved, mark);
      const res = saved.resolve(form.dict.get('Resources'));
      const fonts = isDict(res) && saved.resolve(res.get('Font'));
      const ops = parseContentStream(inflateStream(form));
      const fontName = ops.find((op) => op.operator === 'Tf')?.operands[0];
      if (!isDict(fonts) || !isName(fontName)) throw new Error('missing text font');
      const font = saved.resolve(fonts.get(fontName.name));
      expect(isDict(font) && font.get('BaseFont')).toEqual(name('Helvetica'));
      expect(ops.filter((op) => op.operator === 'Tj').map((op) => op.operands[0]))
        .toEqual([{ kind: 'string', bytes: new TextEncoder().encode(text(n)) }]);
    }
  });

  it('renders the same visible text as an annotation and as a page artifact', () => {
    const make = (mode: 'annotation' | 'content') => {
      const doc = Document.New();
      const page = doc.AddPage().page;
      page.MediaBox = [0, 0, 165, 90];
      page.TrimBox = [15, 10, 150, 45];
      page.AddPrinterMarks({ mode, kinds: ['pageInformation'] });
      return Document.Open(doc.Save()).Pages[0];
    };
    const page = make('content');
    expect(page.Annotations).toHaveLength(0);
    expect(page.Artifacts).toHaveLength(1);
    const annotation = make('annotation');
    expect(annotation.Annotations[0].Contents).toBe('Page 1');
    expect(page.ToImage()).toEqual(annotation.ToImage());
    const blank = Document.New().AddPage().page;
    blank.MediaBox = page.MediaBox;
    expect(page.ToImage()).not.toEqual(blank.ToImage());
  });

  it('keeps a shared annotations array isolated to the selected page', () => {
    const doc = Document.New();
    const first = doc.AddPage().page;
    const second = doc.AddPage().page;
    const shared = doc.allocObject([]);
    first.Dict.set('Annots', shared);
    second.Dict.set('Annots', shared);
    doc.AddPrinterMarks({ pages: [1], kinds: ['pageInformation'] });
    expect(first.Annotations).toHaveLength(1);
    expect(second.Annotations).toHaveLength(0);
  });

  it('refreshes the appearance when a reopened mark changes its caption', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const mark = new PageInformationAnnotation(page, [20, 760, 190, 780], info);
    expect(mark.Rect).toEqual([20, 760, 190, 780]);
    const reopened = Document.Open(doc.Save());
    const saved = reopened.Pages[0].Annotations[0] as PageInformationAnnotation;
    saved.Contents = 'Second (proof)';
    const body = Buffer.from(inflateStream(appearance(reopened, saved))).toString('latin1');
    expect(body).toContain('(Second \\(proof\\)) Tj');
    expect(Document.Open(reopened.Save({ incremental: true })).Pages[0].Annotations[0].Contents).toBe('Second (proof)');
  });

  it.each(['annotation', 'content'] as const)('preflights all selected pages before applying %s output', (mode) => {
    const doc = Document.New();
    doc.AddPage();
    doc.AddPage().page.TrimBox = [10, 0, 10, 60];
    const before = doc.Save();
    const objectCount = [...doc.objectEntries()].length;
    expect(() => doc.AddPrinterMarks({ pages: [2, 1], mode, kinds: ['pageInformation'] })).toThrow(/TrimBox/);
    expect(doc.Save()).toEqual(before);
    expect([...doc.objectEntries()]).toHaveLength(objectCount);
    expect(() => doc.AddPrinterMarks({ pages: '1,3' })).toThrow(/range/);
    expect(() => doc.AddPrinterMarks({ pages: [1], kinds: ['pageInformation'],
      pageInformation: { timestamp: new Date(NaN) } })).toThrow(/timestamp/);
    expect(doc.Save()).toEqual(before);
  });

  it('checks every annotation can reference its page before attaching the first mark', () => {
    const original = Document.New();
    const first = original.AddPage().page;
    const second = original.AddPage().page;
    const tree = original.resolve(first.Dict.get('Parent'));
    if (!isDict(tree)) throw new Error('missing page tree');
    tree.set('Kids', [original.pageRef(1), second.Dict]);
    const doc = Document.Open(original.Save());
    const before = doc.Save();
    expect(() => doc.AddPrinterMarks({ kinds: ['pageInformation'] })).toThrow(/indirect object/);
    expect(doc.Save()).toEqual(before);
  });
});
