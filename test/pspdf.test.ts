import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { appendPsPages, PsPdfWriter } from '../src/pspdf.js';
import { Document } from '../src/document.js';
import { extractPaths } from '../src/paths.js';
import { parseContentStream } from '../src/content.js';
import { PsBudget } from '../src/psbudget.js';
import { LoadLimits } from '../src/loadlimits.js';
import { name, isDict, type PdfStream, type PdfDict, type PdfObject } from '../src/types.js';
import { decodePng } from './helpers/decode-png.js';

function document(source: string): Document {
  const { graphics } = runGraphics(source);
  const doc = Document.New();
  appendPsPages(doc, graphics.finish());
  return Document.Open(doc.Save());
}

describe('PostScript PDF output', () => {
  it('prepares every page before publishing any page on a failed append', () => {
    const pages = runGraphics('0 0 1 1 rectfill showpage showpage').graphics.finish();
    const cycle: PdfDict = new Map(); cycle.set('cycle', cycle);
    const invalid = { ...pages[1]!, resources: new Map([['XObject', cycle]]) };
    const doc = Document.New();
    expect(() => appendPsPages(doc, [pages[0]!, invalid])).toThrow(/cyclic/i);
    expect(doc.Pages).toHaveLength(0);
  });
  it('saves and reopens actual vector path geometry', () => {
    const doc = document('10 20 moveto 30 40 lineto stroke showpage');
    const paths = extractPaths(doc, doc.Pages[0]!).filter(path => path.stroke || path.fill);
    expect(paths).toHaveLength(1);
    expect(paths[0]!.bbox).toEqual([10, 20, 30, 40]);
    expect(paths[0]!.stroke?.rgb).toEqual([0, 0, 0]);
  });

  it('retains the full stroke matrix while preserving constructed device coordinates', () => {
    const doc = document('10 20 moveto 30 40 lineto [2 1 0 3 4 5] setmatrix stroke showpage');
    const path = extractPaths(doc, doc.Pages[0]!).find(path => path.stroke)!;
    expect(path.ctm).toEqual([2, 1, 0, 3, 4, 5]);
    [10, 20, 30, 40].forEach((value, i) => expect(path.bbox[i]).toBeCloseTo(value, 8));
  });

  it('emits even-odd fills and preserves paths across rectangle painting', () => {
    const { vm, graphics } = runGraphics('1 2 moveto 3 4 5 6 rectfill currentpoint newpath 0 0 moveto 10 0 lineto 10 10 lineto closepath eofill showpage');
    expect(vm.stack).toMatchObject([{ value: 1 }, { value: 2 }]);
    const doc = Document.New();
    appendPsPages(doc, graphics.finish());
    const paths = extractPaths(doc, doc.Pages[0]!).filter(path => path.stroke || path.fill);
    expect(paths.map(path => path.fillRule)).toEqual(['nonzero', 'evenodd']);
  });

  it('renders the intersection of cumulative clipping constraints', () => {
    const doc = document('<< /PageSize [20 20] >> setpagedevice 0 0 10 20 rectclip 5 0 10 20 rectclip 0 0 20 20 rectfill showpage');
    const png = decodePng(doc.Pages[0]!.ToImage());
    expect(png.at(7, 10)).toEqual([0, 0, 0, 255]);
    expect(png.at(2, 10)).toEqual([255, 255, 255, 255]);
    expect(png.at(12, 10)).toEqual([255, 255, 255, 255]);
  });

  it('serializes names, byte strings and small finite numbers as valid PDF tokens', () => {
    const writer = new PsPdfWriter(new PsBudget(), [0, 0, 20, 20]);
    writer.emit('m', [1e-7, 2]);
    writer.emit('Do', [name('a b')]);
    expect(parseContentStream(writer.finish().content)).toMatchObject([
      { operator: 'm', operands: [1e-7, 2] },
      { operator: 'Do', operands: [{ kind: 'name', name: 'a b' }] },
    ]);
  });

  it('reuses resources and isolates a completed snapshot from later resource additions', () => {
    const writer = new PsPdfWriter(new PsBudget(), [0, 0, 20, 20]);
    const image: PdfStream = { kind: 'stream', dict: new Map(), raw: new Uint8Array([1]) };
    const key = writer.resource('XObject', image);
    expect(writer.resource('XObject', image)).toBe(key);
    const first = writer.finish();
    writer.resource('XObject', { ...image, raw: new Uint8Array([2]) });
    const resources = first.resources.get('XObject');
    expect(isDict(resources) && resources.size).toBe(1);
  });

  it('enforces output token limits while producing content', () => {
    const writer = new PsPdfWriter(new PsBudget(LoadLimits.defaults.with({ maxContentTokens: 3 })), [0, 0, 20, 20]);
    writer.emit('m', [1, 2]);
    expect(() => writer.emit('l', [3, 4])).toThrowError(expect.objectContaining({ limit: 'maxContentTokens' }));
    expect(parseContentStream(writer.finish().content)).toHaveLength(1);
  });

  it('reuses resource and content streams across copied pages', () => {
    const writer = new PsPdfWriter(new PsBudget(), [0, 0, 20, 20]);
    const form: PdfStream = { kind: 'stream', raw: new TextEncoder().encode('0 0 1 1 re f\n'),
      dict: new Map<string, PdfObject>([
        ['Type', name('XObject')], ['Subtype', name('Form')], ['BBox', [0, 0, 1, 1]], ['Resources', new Map()],
      ]),
    };
    const key = writer.resource('XObject', form);
    writer.emit('Do', [name(key)]);
    const output = writer.finish();
    const doc = Document.New();
    appendPsPages(doc, [output, output]);
    const first = doc.Pages[0]!.Dict, second = doc.Pages[1]!.Dict;
    expect(first.get('Contents')).toEqual(second.get('Contents'));
    const firstResources = first.get('Resources') as PdfDict;
    const secondResources = second.get('Resources') as PdfDict;
    expect((firstResources.get('XObject') as PdfDict).get(key))
      .toEqual((secondResources.get('XObject') as PdfDict).get(key));
  });

  it('validates every requested page before publishing page entries', () => {
    const doc = Document.New();
    const before = doc.Save();
    expect(() => appendPsPages(doc, [
      { box: [0, 0, 20, 20], content: new Uint8Array(), resources: new Map() },
      { box: [0, 0, -1, 20], content: new Uint8Array(), resources: new Map() },
    ])).toThrow();
    expect(doc.Pages).toHaveLength(0);
    expect(doc.Save()).toEqual(before);
  });
});
