import { describe, expect, it } from 'vitest';
import {
  BleedMarkAnnotation, ColorBarAnnotation, ColorsOfCMYK, Document, PrinterMarkAnnotation,
  PrinterMarkCornerPosition, PrinterMarkSidePosition, RegistrationMarkAnnotation, TrimMarkAnnotation,
  type Rect,
} from '../src/index.js';
import { isDict, isRef, isStream, name, type PdfDict } from '../src/types.js';
import { inflateStream } from '../src/flate.js';
import { parseContentStream } from '../src/content.js';
import { buildPdfxPdf } from './helpers/build-pdfx-pdf.js';

function printPage() {
  const doc = Document.New();
  const { page } = doc.AddPage();
  page.MediaBox = [-20, 30, 180, 330];
  page.CropBox = [-10, 40, 170, 320];
  page.TrimBox = [0, 50, 160, 310];
  page.BleedBox = [-5, 45, 165, 315];
  return { doc, page };
}

function appearance(doc: Document, mark: PrinterMarkAnnotation) {
  const ap = doc.resolve(mark.Dict.get('AP'));
  if (!isDict(ap)) throw new Error('missing appearance dictionary');
  const entry = ap.get('N');
  expect(isRef(entry)).toBe(true);
  const form = doc.resolve(entry);
  if (!isStream(form)) throw new Error('missing appearance stream');
  return form;
}

function contained(box: number[], rect: Rect): boolean {
  return rect[0] >= box[0] && rect[1] >= box[1] && rect[2] <= box[2] && rect[3] <= box[3];
}

function overlaps(a: Rect, b: number[]): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

describe('printer marks', () => {
  it('attaches individual marks at the selected corner, side, or bar rectangle', () => {
    const { doc, page } = printPage();
    const trim = new TrimMarkAnnotation(page, PrinterMarkCornerPosition.TopLeft);
    const bleed = new BleedMarkAnnotation(page, PrinterMarkCornerPosition.BottomRight);
    const registration = new RegistrationMarkAnnotation(page, PrinterMarkSidePosition.Right);
    const bar = new ColorBarAnnotation(page, [40, 52, 120, 60], ColorsOfCMYK.Magenta);

    expect(trim.Rect![0]).toBeLessThan(page.BleedBox[0]);
    expect(trim.Rect![3]).toBeGreaterThan(page.BleedBox[3]);
    expect(overlaps(trim.Rect!, page.TrimBox)).toBe(false);
    expect(bleed.Rect![2]).toBeGreaterThan(page.BleedBox[2]);
    expect(bleed.Rect![1]).toBeLessThan(page.BleedBox[1]);
    expect(registration.Rect![0]).toBeGreaterThan(page.BleedBox[2]);
    expect(bar.Rect![3]).toBeLessThan(page.BleedBox[1]);
    expect(bar.Rect![2] - bar.Rect![0]).toBe(80);
    expect(bar.Rect![3] - bar.Rect![1]).toBe(8);
    const barOps = parseContentStream(inflateStream(appearance(doc, bar)));
    const tints = barOps.filter((op) => op.operator === 'k').map((op) => op.operands);
    expect(tints).toHaveLength(11);
    expect(tints[0]).toEqual([0, 0, 0, 0]);
    expect(tints[5]).toEqual([0, 0.5, 0, 0]);
    expect(tints[10]).toEqual([0, 1, 0, 0]);
    expect(page.Annotations.map((annotation) => annotation.Dict)).toEqual(
      [trim, bleed, registration, bar].map((annotation) => annotation.Dict),
    );
  });

  it('grows the media, preserves the original boxes and artwork, and reopens printable forms', () => {
    const { doc, page } = printPage();
    const note = page.AddTextNote({ rect: [5, 55, 25, 75], contents: 'existing note' });
    const marks = page.AddPrinterMarks();
    expect(marks).toHaveLength(16);
    expect(page.MediaBox[0]).toBeLessThan(-20);
    expect(page.MediaBox[1]).toBeLessThan(30);
    expect(page.TrimBox).toEqual([0, 50, 160, 310]);
    expect(page.BleedBox).toEqual([-5, 45, 165, 315]);
    expect(page.Annotations[0].Dict).toBe(note.Dict);
    expect(note.Rect).toEqual([5, 55, 25, 75]);
    const reopened = Document.Open(doc.Save({ compressed: true }));
    const savedPage = reopened.Pages[0];
    const savedMarks = savedPage.Annotations.filter((a): a is PrinterMarkAnnotation =>
      a instanceof PrinterMarkAnnotation,
    );
    expect(savedMarks.map((mark) => mark.MarkName)).toEqual([
      ...Array(4).fill('TrimMark'), ...Array(4).fill('BleedMark'),
      ...Array(4).fill('RegistrationTarget'), ...Array(4).fill('ColorBar'),
    ]);
    for (const mark of savedMarks) {
      expect(mark.Flags).toBe(68);
      expect(reopened.resolve(mark.Dict.get('P')) === savedPage.Dict).toBe(true);
      expect(contained(savedPage.MediaBox, mark.Rect!)).toBe(true);
      expect(contained(savedPage.CropBox, mark.Rect!)).toBe(true);
      expect(appearance(reopened, mark).dict.get('Subtype')).toEqual(name('Form'));
    }
    const target = appearance(reopened, savedMarks[8]);
    const resources = reopened.resolve(target.dict.get('Resources')) as PdfDict;
    const spaces = reopened.resolve(resources.get('ColorSpace')) as PdfDict;
    const space = [...spaces.values()][0];
    expect(space).toEqual([name('Separation'), name('All'), name('DeviceCMYK'), expect.any(Map)]);
    expect(parseContentStream(inflateStream(target)).some((op) => op.operator === 'SCN')).toBe(true);
  });

  it('renders the same ink in content mode and marks it as an artifact', () => {
    const make = (mode: 'annotation' | 'content' | 'blank') => {
      const { doc, page } = printPage();
      page.Graphics().setFillColor([0, 0, 1]).drawRect(35, 85, 30, 40).fill().apply();
      if (mode !== 'blank') {
        const marks = page.AddPrinterMarks({ mode });
        expect(marks).toHaveLength(mode === 'content' ? 0 : 16);
      }
      return Document.Open(doc.Save()).Pages[0];
    };
    const asAnnotations = make('annotation');
    const asContent = make('content');
    expect(asContent.Annotations).toEqual([]);
    expect(asContent.Artifacts).toHaveLength(1);
    const image = asContent.ToImage();
    expect(asAnnotations.ToImage()).toEqual(image);
    const blank = make('blank');
    blank.MediaBox = asContent.MediaBox;
    blank.CropBox = asContent.CropBox;
    expect(image).not.toEqual(blank.ToImage());
  });

  it('puts content-mode XObjects on the selected page even with shared resources', () => {
    const { doc, page } = printPage();
    const { page: sibling } = doc.AddPage();
    const resources: PdfDict = new Map();
    const shared = doc.allocObject(resources);
    page.Dict.set('Resources', shared);
    sibling.Dict.set('Resources', shared);

    page.AddPrinterMarks({ kinds: ['registration'], mode: 'content' });
    expect(sibling.Resources?.has('XObject')).toBe(false);
    expect(page.Resources?.has('XObject')).toBe(true);
  });

  it.each(['annotation', 'content'] as const)('preserves ArtBox-only PDF/X pages in %s mode', (mode) => {
    const doc = Document.Open(buildPdfxPdf({}, '4'));
    const page = doc.Pages[0];
    const original = page.TrimBox;
    page.ArtBox = original;
    page.Dict.delete('TrimBox');
    expect(doc.ValidatePdfX('4').Errors).toEqual([]);

    const marks = page.AddPrinterMarks({ mode });
    expect(page.Dict.has('TrimBox')).toBe(false);
    expect(page.ArtBox).toEqual(original);
    if (mode === 'annotation') expect(marks[0].Rect![2]).toBe(original[0]);
    expect(doc.ValidatePdfX('4').Errors).toEqual([]);
  });

  it('validates generated PDF/X marks and refuses a printer mark overlapping the trim', () => {
    const doc = Document.Open(buildPdfxPdf({}, '4'));
    const page = doc.Pages[0];
    const marks = page.AddPrinterMarks();
    expect(marks.some((mark) => overlaps(mark.Rect!, page.BleedBox))).toBe(true);
    expect(marks.some((mark) => overlaps(mark.Rect!, page.TrimBox))).toBe(false);
    expect(doc.ValidatePdfX('4').Errors).toEqual([]);

    const rect = marks[0].Rect!;
    marks[0].Rect = [rect[0], rect[1] - 1, rect[2] + 1, rect[3]];
    expect(doc.ValidatePdfX('4').Errors.map((issue) => issue.rule)).toEqual(['Annotations']);
  });

  it('keeps the bleed box optional on a PDF/X page with an annotation in the crop margin', () => {
    const doc = Document.Open(buildPdfxPdf({}, '4'));
    const page = doc.Pages[0];
    page.Dict.delete('BleedBox');
    page.AddTextNote({ rect: [5, 100, 8, 105], contents: 'margin note' });
    expect(doc.ValidatePdfX('4').Errors).toEqual([]);

    const marks = page.AddPrinterMarks({ kinds: ['bleed'] });
    expect(marks[0].Rect![2]).toBe(page.TrimBox[0]);
    expect(page.Dict.has('BleedBox')).toBe(false);
    expect(doc.ValidatePdfX('4').Errors).toEqual([]);
  });

  it('keeps all CMYK ramps horizontal when a narrow page needs small patches', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.TrimBox = [0, 0, 30.2, 50];
    const bars = page.AddPrinterMarks({ kinds: ['colorBar'] });
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      const patches = parseContentStream(inflateStream(appearance(doc, bar)))
        .filter((op) => op.operator === 're');
      expect(patches[1].operands[0]).toBeGreaterThan(0);
      expect(patches[1].operands[1]).toBe(0);
    }
  });

  it.each(['annotation', 'content'] as const)('declares PDF 1.4 for marks added to a PDF 1.3 in %s mode', (mode) => {
    const original = Document.New();
    original.AddPage();
    const bytes = original.Save();
    bytes[7] = 0x33;
    const doc = Document.Open(bytes);
    doc.Pages[0].AddPrinterMarks({ mode });
    const updated = Document.Open(doc.Save({ incremental: true }));
    expect(updated.headerVersion()).toBe('1.4');
  });

  it('preserves an inherited crop on request and freezes the implicit finish', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const { page: sibling } = doc.AddPage();
    const parent = doc.resolve(page.Dict.get('Parent')) as PdfDict;
    const original = [15, 20, 225, 315];
    parent.set('CropBox', original);
    page.MediaBox = [...original];
    sibling.MediaBox = [...original];
    page.AddPrinterMarks({ kinds: ['trim'], expandCropBox: false });

    expect(page.MediaBox).not.toEqual(original);
    expect(page.CropBox).toEqual(original);
    expect(page.TrimBox).toEqual(original);
    expect(page.Dict.has('BleedBox')).toBe(false);
    expect(sibling.MediaBox).toEqual(original);
    expect(sibling.CropBox).toEqual(original);
    expect(sibling.Annotations).toEqual([]);
  });

  it('does not grow again from an enlarged crop when adding the same kinds', () => {
    const doc = Document.New();
    const { page } = doc.AddPage();
    const original = page.CropBox;
    const first = page.AddPrinterMarks({ kinds: ['trim', 'trim', 'bleed'] });
    const media = page.MediaBox;
    const second = page.AddPrinterMarks({ kinds: ['trim', 'bleed'] });
    expect(first).toHaveLength(8);
    expect(second.map((mark) => mark.Rect)).toEqual(first.map((mark) => mark.Rect));
    expect(page.MediaBox).toEqual(media);
    expect(page.TrimBox).toEqual(original);
    expect(page.Dict.has('BleedBox')).toBe(false);
  });

  it('validates options and placement before changing the document', () => {
    const { doc, page } = printPage();
    const before = doc.Save();
    expect(page.AddPrinterMarks({ kinds: [] })).toEqual([]);
    expect(() => page.AddPrinterMarks({ kinds: ['unknown' as never] })).toThrow(/printer mark kind/);
    expect(() => page.AddPrinterMarks({ mode: 'none' as never })).toThrow(/mode/);
    expect(() => new TrimMarkAnnotation(page, 'Center' as never)).toThrow(/corner/);
    expect(() => new RegistrationMarkAnnotation(page, 'Center' as never)).toThrow(/side/);
    expect(() => new ColorBarAnnotation(page, [0, 0, 0, 10])).toThrow(/rectangle/);
    expect(() => new ColorBarAnnotation(page, [0, 0, 10, 10], 'Red' as never)).toThrow(/CMYK/);
    expect(doc.Save()).toEqual(before);
  });
});
