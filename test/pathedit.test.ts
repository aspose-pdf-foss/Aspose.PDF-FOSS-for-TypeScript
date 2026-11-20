import { describe, expect, it } from 'vitest';
import { Document } from '../src/index.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildRawPdf } from './helpers/build-page-tree-pdf.js';
import { decodePng } from './helpers/decode-png.js';

const stream = (body: string, entries = '') =>
  `<< /Length ${body.length} ${entries} >>\nstream\n${body}\nendstream`;

function openContents(...bodies: string[]): Document {
  const refs = bodies.map((_, i) => `${5 + i} 0 R`).join(' ');
  return Document.Open(buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
    `[${refs}]`,
    ...bodies.map((body) => stream(body)),
  ]));
}

function openForms(tagged = false, ownsResources = false): Document {
  return Document.Open(buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] /MediaBox [0 0 100 100] /Resources << /XObject << /Outer 7 0 R /Inner 8 0 R >> >> >>',
    '<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>',
    stream('/Outer Do q 1 0 0 1 40 0 cm /Outer Do Q'),
    stream('/Outer Do'),
    stream('/Inner Do q 1 0 0 1 0 30 cm /Inner Do Q', '/Type /XObject /Subtype /Form /BBox [0 0 100 100]'
      + (ownsResources ? ' /Resources << /XObject << /Inner 8 0 R >> >>' : '')),
    stream('0 0 1 rg 1 1 10 10 re f', '/Type /XObject /Subtype /Form /BBox [0 0 20 20]' + (tagged ? ' /StructParents 4' : '')),
  ]));
}

describe('editing one PagePath', () => {
  it('removes a path spanning an indirect Contents array and preserves the following streams', () => {
    const doc = openContents('0 0 1 rg 10 10 m 20 10 l', '20 20 l h f 60 10 10 10 re f', '80 10 4 4 re f');
    const page = doc.Pages[0];
    const [target, next] = page.GetPaths();
    target.Remove();
    expect(() => next.Remove()).toThrow(RangeError);
    const [reopened] = Document.Open(doc.Save()).Pages;
    expect(reopened.GetPaths().map((path) => [path.bbox, path.fill?.rgb])).toEqual([
      [[60, 10, 70, 20], [0, 0, 255]], [[80, 10, 84, 14], [0, 0, 255]],
    ]);
  });

  it('keeps unrelated operands that continue into the next Contents stream', () => {
    const doc = openContents('10 10 20 20 re f\n1 0 0', 'rg 50 50 30 30 re f');
    const page = doc.Pages[0];
    expect(decodePng(page.ToImage()).at(60, 40)).toEqual([255, 0, 0, 255]);
    page.GetPaths()[0].Remove();
    const png = decodePng(Document.Open(doc.Save()).Pages[0].ToImage());
    expect(png.at(20, 80)).toEqual([255, 255, 255, 255]);
    expect(png.at(60, 40)).toEqual([255, 0, 0, 255]);
  });

  it('overrides just the requested fill and stroke channels of a path', () => {
    const doc = openContents('1 0 0 rg 0 0 1 RG 2 w 10 10 10 10 re B 40 10 10 10 re B');
    doc.Pages[0].GetPaths()[0].Recolor({ fill: [0, 1, 0], stroke: [1, 0, 1] });
    const [target, next] = Document.Open(doc.Save()).Pages[0].GetPaths();
    expect([target.fill?.rgb, target.stroke?.rgb, target.lineWidth]).toEqual([[0, 255, 0], [255, 0, 255], 2]);
    expect([next.fill?.rgb, next.stroke?.rgb, next.lineWidth]).toEqual([[255, 0, 0], [0, 0, 255], 2]);
  });

  it('preserves a painted clip when recoloring and removing its paint', () => {
    const doc = openContents('1 0 0 rg 10 10 30 30 re W f 30 10 30 30 re f');
    const page = doc.Pages[0];
    page.GetPaths()[0].Recolor({ fill: [0, 1, 0] });
    let png = decodePng(Document.Open(doc.Save()).Pages[0].ToImage());
    expect(png.at(20, 75)).toEqual([0, 255, 0, 255]);
    expect(png.at(35, 75)).toEqual([255, 0, 0, 255]);
    expect(png.at(55, 75)).toEqual([255, 255, 255, 255]);

    const [, persistentClip] = page.GetPaths();
    expect([persistentClip.fill, persistentClip.stroke, persistentClip.clip]).toEqual([null, null, 'nonzero']);
    persistentClip.Transform([1, 0, 0, 1, 20, 0]);
    png = decodePng(page.ToImage());
    expect(png.at(20, 75)).toEqual([0, 255, 0, 255]);
    expect(png.at(55, 75)).toEqual([255, 0, 0, 255]);

    const original = openContents('1 0 0 rg 10 10 30 30 re W f 30 10 30 30 re f');
    const originalPage = original.Pages[0];
    originalPage.GetPaths()[0].Remove();
    png = decodePng(originalPage.ToImage());
    expect(png.at(20, 75)).toEqual([255, 255, 255, 255]);
    expect(png.at(35, 75)).toEqual([255, 0, 0, 255]);
    expect(png.at(55, 75)).toEqual([255, 255, 255, 255]);
    originalPage.GetPaths()[0].Remove(); // clip-only
    expect(decodePng(originalPage.ToImage()).at(55, 75)).toEqual([255, 0, 0, 255]);
  });

  it('keeps the same stroke coverage when recoloring a path with a clip', () => {
    const page = openContents('8 w 20 20 30 30 re W* S').Pages[0];
    const before = decodePng(page.ToImage());
    page.GetPaths()[0].Recolor({ stroke: [1, 0, 0] });
    const after = decodePng(page.ToImage());
    expect(after.at(17, 65)).toEqual(before.at(17, 65));
    expect(after.at(22, 65)).toEqual([255, 0, 0, 255]);
  });

  it('transforms geometry in local coordinates and keeps the stroke width', () => {
    const doc = openContents('1 0 0 1 10 10 cm 3 w 0 0 10 20 re S 30 30 m 50 30 l S');
    doc.Pages[0].GetPaths()[0].Transform([0, 1, -1, 0, 40, 0]);
    const [target, next] = Document.Open(doc.Save()).Pages[0].GetPaths();
    expect(target.bbox).toEqual([30, 10, 50, 20]);
    expect(target.subpaths[0].closed).toBe(true);
    expect(target.lineWidth).toBe(3);
    expect(next.bbox).toEqual([40, 40, 60, 40]);
  });

  it('keeps the current point when a cubic continues from a closed rectangle', () => {
    const page = openContents('4 w 25 35 25 45 re 60 85 85 85 v S').Pages[0];
    const before = page.ToImage();
    page.GetPaths()[0].Transform([1, 0, 0, 1, 0, 0]);
    expect(Buffer.from(page.ToImage()).equals(before)).toBe(true);

    page.GetPaths()[0].Transform([0, 1, -1, 0, 100, 0]);
    const [path] = page.GetPaths();
    expect(path.subpaths[1]?.segments).toEqual([
      { op: 'move', pt: [65, 25] },
      { op: 'cubic', c1: [65, 25], c2: [15, 60], pt: [15, 85] },
    ]);
  });

  it.each(['inherited', 'own'] as const)('copies only the selected nested Form draw with %s resources', (scope) => {
    const doc = openForms(false, scope === 'own');
    const [page, other] = doc.Pages;
    const paths = page.GetPaths();
    expect(paths.map((path) => path.bbox.slice(0, 2))).toEqual([[1, 1], [1, 31], [41, 1], [41, 31]]);
    paths[3].Recolor({ fill: [1, 0, 0] });
    expect(() => paths[0].Transform([1, 0, 0, 1, 2, 0])).toThrow(RangeError);
    const blue = [0, 0, 255];
    const [reopened, sibling] = Document.Open(doc.Save()).Pages;
    expect(reopened.GetPaths().map((path) => path.fill?.rgb)).toEqual([blue, blue, blue, [255, 0, 0]]);
    expect(sibling.GetPaths().map((path) => path.fill?.rgb)).toEqual([blue, blue]);
    expect(other.GetPaths().map((path) => path.fill?.rgb)).toEqual([blue, blue]);
  });

  it('preserves inherited resources and other artwork in a transparency group', () => {
    const doc = Document.Open(buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] /MediaBox [0 0 100 100] /Resources << /XObject << /Outer 5 0 R /Inner 6 0 R >> /ExtGState << /Blend << /BM /Multiply >> >> >> >>',
      '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
      stream('1 1 0 rg 0 0 100 100 re f /Outer Do'),
      stream('q /Blend gs 0 1 1 rg 0 0 50 50 re f Q /Inner Do',
        '/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true >>'),
      stream('0 0 1 rg 60 60 15 15 re f', '/Type /XObject /Subtype /Form /BBox [0 0 100 100]'),
    ]));
    const page = doc.Pages[0];
    const before = decodePng(page.ToImage());
    const target = page.GetPaths().find((path) => path.addr.path.length === 2)!;
    target.Recolor({ fill: [1, 0, 0] });
    const after = decodePng(Document.Open(doc.Save()).Pages[0].ToImage());
    expect(after.at(10, 89)).toEqual(before.at(10, 89));
    expect(after.at(65, 35)).toEqual([255, 0, 0, 255]);
  });

  it('refuses invalid operations before changing page objects or resources', () => {
    const doc = openContents('0 0 0 rg 10 10 10 10 re f');
    const path = doc.Pages[0].GetPaths()[0];
    const before = doc.Save();
    expect(() => path.Recolor({ stroke: [0, 0, 1] })).toThrow(RangeError);
    expect(() => path.Recolor({ fill: [0, 0, 2] })).toThrow(RangeError);
    expect(() => path.Transform([1, 0, 0, 1, 0, Infinity])).toThrow(TypeError);
    expect(doc.Save()).toEqual(before);

    const tagged = openForms(true);
    const page = tagged.Pages[0];
    const resources = page.Resources;
    const count = [...tagged.objectEntries()].length;
    expect(() => page.GetPaths()[0].Remove()).toThrow(UnsupportedFeatureError);
    expect(page.Resources).toBe(resources);
    expect([...tagged.objectEntries()]).toHaveLength(count);
  });

  it('verifies the handle after reading caller-supplied options', () => {
    const page = openContents('10 10 10 10 re f 40 10 10 10 re f').Pages[0];
    const [target, other] = page.GetPaths();
    let edited = false;
    expect(() => target.Recolor({
      get fill(): [number, number, number] {
        if (!edited) { edited = true; other.Remove(); }
        return [1, 0, 0];
      },
    })).toThrow(RangeError);
    expect(page.GetPaths().map((path) => path.fill?.rgb)).toEqual([[0, 0, 0]]);
  });
});
