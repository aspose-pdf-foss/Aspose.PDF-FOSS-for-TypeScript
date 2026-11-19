import { describe, expect, it } from 'vitest';
import { Document, PdfParseError } from '../src/index.js';
import { epsSource, dosEps } from './helpers/build-eps.js';
import { psBytes, joinPs, encryptedPs } from './helpers/ps-font-program.js';
import { parseContentStream } from '../src/content.js';
import { extractPaths } from '../src/paths.js';
import { decodePng } from './helpers/decode-png.js';
import { isDict, isStream } from '../src/types.js';
import { inflateStream } from '../src/flate.js';

function reopen(bytes: Uint8Array): Document {
  const doc = Document.New(); doc.AddPostScript(bytes); return Document.Open(doc.Save());
}
describe('EPS saved output', () => {
  it('rejects a duplicate outer prolog terminator before appending a page', () => {
    const doc = reopen(epsSource('-10 20 5 5 rectfill'));
    const before = doc.Save();
    const malformed = epsSource('%%BeginProlog\n%%EndProlog\n%%EndProlog\n-10 20 5 5 rectfill');
    expect(() => doc.AddPostScript(malformed)).toThrow(PdfParseError);
    expect(doc.Save()).toEqual(before);
  });
  it('isolates imported crop and rotation from an existing root without changing old inheritance', () => {
    const doc = Document.New(); doc.AddPostScript(psBytes('showpage'));
    const root = doc.resolve(doc.catalog().get('Pages')); if (!isDict(root)) throw new Error('root');
    root.set('CropBox', [10,10,20,20]); root.set('Rotate',90);
    // Existing page must actually inherit these keys, rather than carrying overrides.
    doc.Pages[0]!.Dict.delete('CropBox'); doc.Pages[0]!.Dict.delete('Rotate');
    doc.AddPostScript(epsSource('-10 20 5 5 rectfill'));
    doc.AddPostScript(psBytes('showpage'));
    const saved = Document.Open(doc.Save());
    expect(saved.Pages[0]!.CropBox).toEqual([10,10,20,20]); expect(saved.Pages[0]!.Rotate).toBe(90);
    expect(saved.Pages[1]!.CropBox).toEqual([0,0,100,50]); expect(saved.Pages[1]!.Rotate).toBe(0);
    expect(saved.Pages[2]!.CropBox).toEqual([0,0,595,842]); expect(saved.Pages[2]!.Rotate).toBe(0);
    const png = decodePng(saved.Pages[1]!.ToImage()); expect([png.width,png.height]).toEqual([100,50]);
    expect(png.at(2,47)).toEqual([0,0,0,255]);
  });
  it.each(['currentfile read', 'currentfile /ASCIIHexDecode filter read'])('confines %s to the exact declared PS span at EOF', reader => {
    const source = epsSource(`/boundary { ${reader} { pop escapedWrapper } if } def boundary\n`);
    expect(reopen(dosEps(source, psBytes('41>'))).Pages[0]!.MediaBox).toEqual([0,0,100,50]);
  });
  it.each([
    ['%%BoundingBox: -10 20 90 70', -10, 20, 100, 50],
    ['%%BoundingBox: -10 20 90 70\n%%HiResBoundingBox: -9.5 20.25 89.75 69.5', -9.5, 20.25, 99.25, 49.25],
  ] as const)('normalizes %s exactly once through all resets', (comments, x, y, width, height) => {
    const doc = reopen(epsSource(`initgraphics initmatrix initclip ${x} ${y} 5 5 rectfill showpage systemdict /showpage get exec`, comments));
    expect(doc.Pages).toHaveLength(1); expect(doc.Pages[0]!.MediaBox).toEqual([0, 0, width, height]);
    const path = extractPaths(doc, doc.Pages[0]!).find(p => p.fill)!;
    expect(path.bbox).toEqual([0, 0, 5, 5]);
    const png = decodePng(doc.Pages[0]!.ToImage());
    expect(png.at(2, png.height - 3)).toEqual([0, 0, 0, 255]);
    expect(png.at(7, png.height - 3)).toEqual([255, 255, 255, 255]);
  });
  it('normalizes text, image, forms and bound patterns without translating nested paint twice', () => {
    const source = epsSource([
      '/Courier 10 selectfont -10 40 moveto (A) show',
      'gsave -5 25 translate 4 4 scale 1 1 8 [1 0 0 -1 0 1] <00> image grestore',
      '<< /FormType 1 /BBox [0 0 5 5] /Matrix [1 0 0 1 10 40] /PaintProc { pop 0 0 5 5 rectfill } >> execform',
      '<< /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 5 5] /XStep 10 /YStep 10 /PaintProc { pop 1 0 0 setrgbcolor 0 0 5 5 rectfill } >> matrix makepattern setpattern 30 20 20 10 rectfill',
      'showpage initgraphics -20 20 5 5 rectfill',
    ].join('\n'));
    const doc = reopen(source), page = doc.Pages[0]!, png = decodePng(page.ToImage());
    expect(page.GetText()).toContain('A');
    const tm = parseContentStream(page.Contents).find(op => op.operator === 'Tm')!;
    expect(tm.operands.slice(4)).toEqual([0, 20]);
    expect(png.at(6, 43)).toEqual([0, 0, 0, 255]); // image at (5,5)
    expect(png.at(22, 28)).toEqual([0, 0, 0, 255]); // form at (20,20)
    expect(png.at(42, 47)).toEqual([255, 0, 0, 255]); // pattern at (40,0)
    expect(png.at(47, 47)).toEqual([255, 255, 255, 255]);
    expect(png.at(97, 47)).toEqual([255, 255, 255, 255]); // outside-crop mark cannot wrap
  });
  it.each(['tiff', 'wmf'] as const)('keeps raw currentfile image samples and offsets intact inside %s framing', kind => {
    const payload = joinPs(psBytes('gsave -5 25 translate 3 1 scale 3 1 8 [3 0 0 -1 0 1] currentfile image\n'), Uint8Array.of(40, 10, 37), psBytes('\ngrestore\n'));
    const source = joinPs(epsSource(`%%BeginData: ${payload.length} Binary Bytes\n`), payload, psBytes('%%EndData\nshowpage\n'));
    const wrapped = Buffer.from(dosEps(source, psBytes('%%BoundingBox: 0 0 999 999\nmissing'), kind));
    const doc = Document.New(); doc.AddPostScript(wrapped); const before = doc.Save(); wrapped.fill(0);
    expect(doc.Save()).toEqual(before);
    const saved = Document.Open(before), res = saved.resolve(saved.Pages[0]!.Dict.get('Resources'));
    const objects = isDict(res) ? saved.resolve(res.get('XObject')) : undefined;
    const image = isDict(objects) ? saved.resolve([...objects.values()][0]) : undefined;
    expect(isStream(image)).toBe(true);
    expect(isStream(image) && inflateStream(image)).toEqual(Uint8Array.of(40, 10, 37));
  });
  it('executes an encrypted font resource that DSC skips structurally', () => {
    const body = encryptedPs('/Local << /FontType 3 /FontMatrix [.001 0 0 .001 0 0] /FontBBox [0 0 500 700] /Encoding StandardEncoding /BuildGlyph { pop pop 500 0 setcharwidth 0 0 500 700 rectfill } >> definefont pop currentfile closefile', { hex: true });
    const source = joinPs(epsSource(`%%BeginResource: font Local\n%%BeginData: ${body.length} Hex Bytes\n`), body,
      psBytes('\n%%EndData\n%%EndResource\n/Local 10 selectfont -10 20 moveto (A) show'));
    const doc = reopen(source); expect(doc.Pages[0]!.GetText()).toContain('A');
    expect(decodePng(doc.Pages[0]!.ToImage()).at(2, 47)).toEqual([0, 0, 0, 255]);
  });
  it('uses only the outer deferred trailer and ignores nested, preview and string boxes', () => {
    const body = '%%BeginDocument: child\n%%Trailer\n%%BoundingBox: 0 0 999 999\n%%EndDocument\n'
      + '(label\n%%Trailer\n%%BoundingBox: 0 0 888 888\n) pop\n'
      + '%%BeginPreview: 1 1 1 1\n%%BoundingBox: 0 0 777 777\n%%EndPreview\n'
      + '%%Trailer\n%%BoundingBox: -10 20 90 70\n%%EOF';
    expect(reopen(epsSource(body, '%%BoundingBox: (atend)')).Pages[0]!.MediaBox).toEqual([0, 0, 100, 50]);
  });
});
