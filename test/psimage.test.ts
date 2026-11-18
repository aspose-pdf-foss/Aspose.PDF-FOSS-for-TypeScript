import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { appendPsPages } from '../src/pspdf.js';
import { Document } from '../src/document.js';
import { parseContentStream } from '../src/content.js';
import { decodePng } from './helpers/decode-png.js';

function document(source: string): Document {
  const { graphics } = runGraphics(source); const doc = Document.New();
  appendPsPages(doc, graphics.finish()); return Document.Open(doc.Save());
}
describe('PostScript image operators', () => {
  it('lets a producer exit the enclosing language loop without publishing an image', () => {
    const { vm, graphics } = runGraphics('1 { 1 1 8 matrix { exit } image 99 } repeat 7 showpage');
    expect(vm.stack).toMatchObject([{ value: 7 }]);
    expect(parseContentStream(graphics.finish()[0]!.content).some(op => op.operator === 'Do')).toBe(false);
  });
  it('reports invalidexit for an image producer without an enclosing language loop', () => {
    expect(() => runGraphics('1 1 8 matrix { exit } image')).toThrow(/invalidexit/);
  });
  it('saves and reopens RGB pixels with the image matrix direction', () => {
    const doc = document('<< /PageSize [20 10] >> setpagedevice 20 10 scale '
      + '2 1 8 [2 0 0 -1 0 1] <ff000000ff00> false 3 colorimage showpage');
    expect([...doc.Pages[0]!.Images[0]!.Decode()]).toEqual([255, 0, 0, 0, 255, 0]);
    const png = decodePng(doc.Pages[0]!.ToImage());
    expect(png.at(2, 5)).toEqual([255, 0, 0, 255]);
    expect(png.at(17, 5)).toEqual([0, 255, 0, 255]);
  });
  it.each([[1, 'a0'], [2, '6c'], [4, '1230'], [8, '102030'], [12, '1234567890']])
  ('retains %i-bit row padding', (bits, hex) => {
    const doc = document(`3 1 ${bits} [3 0 0 -1 0 1] <${hex}> image showpage`);
    expect(doc.Pages[0]!.Images[0]!.Bits).toBe(bits === 12 ? 16 : bits);
    expect([...doc.Pages[0]!.Images[0]!.Decode()]).toEqual(bits === 12
      ? [0x12, 0x31, 0x45, 0x64, 0x78, 0x97] : [...Buffer.from(hex, 'hex')]);
  });
  it('interleaves separate sample planes', () => {
    const doc = document('2 1 8 [2 0 0 -1 0 1] <ff00> <00ff> <0000> true 3 colorimage showpage');
    expect([...doc.Pages[0]!.Images[0]!.Decode()]).toEqual([255, 0, 0, 0, 255, 0]);
  });
  it('copies a producer scratch string before invoking it again', () => {
    const doc = document('/s 1 string def /n 0 def 2 1 8 [2 0 0 -1 0 1] '
      + '{ s 0 n put /n n 255 add def s } image showpage');
    expect([...doc.Pages[0]!.Images[0]!.Decode()]).toEqual([0, 255]);
  });
  it('converts nonlinear tint samples on the existing pump', () => {
    const doc = document('[/Separation /Spot /DeviceRGB { dup mul dup 0 }] setcolorspace '
      + '<< /ImageType 1 /Width 1 /Height 1 /BitsPerComponent 8 /ImageMatrix [1 0 0 -1 0 1] '
      + '/Decode [0 1] /DataSource <80> >> image showpage');
    expect([...doc.Pages[0]!.Images[0]!.Decode()]).toEqual([64, 64, 0]);
  });
  it('reads inline currentfile bytes and resumes following source', () => {
    const { vm, graphics } = runGraphics('1 1 8 [1 0 0 -1 0 1] currentfile image A 7 8 add showpage');
    expect(vm.stack).toMatchObject([{ value: 15 }]);
    expect(graphics.finish()).toHaveLength(1);
  });
  it('uses the current color and correct polarity for a stencil', () => {
    const doc = document('<< /PageSize [20 10] >> setpagedevice 20 10 scale 1 0 0 setrgbcolor '
      + '2 1 true [2 0 0 -1 0 1] <80> imagemask showpage');
    const png = decodePng(doc.Pages[0]!.ToImage());
    expect(png.at(2, 5)).toEqual([255, 0, 0, 255]);
    expect(png.at(17, 5)).toEqual([255, 255, 255, 255]);
    expect(parseContentStream(doc.Pages[0]!.Contents).some(op => op.operator === 'Do')).toBe(true);
  });
  it('drops an incomplete row at early EOF and emits no partial image', () => {
    const { graphics } = runGraphics('2 1 8 [2 0 0 -1 0 1] (41>) /ASCIIHexDecode filter image showpage');
    expect(parseContentStream(graphics.finish()[0]!.content).some(op => op.operator === 'Do')).toBe(false);
  });
  it('lets a returning handler resume the producer', () => {
    const doc = document('errordict /undefined { pop } put 1 1 8 [1 0 0 -1 0 1] { missing <80> } image showpage');
    expect([...doc.Pages[0]!.Images[0]!.Decode()]).toEqual([128]);
  });
  it('paints complete rows at their original position before early EOF', () => {
    const doc = document('2 2 8 [2 0 0 -2 0 2] (414243>) /ASCIIHexDecode filter image showpage');
    const image = doc.Pages[0]!.Images[0]!;
    expect([image.Width, image.Height]).toEqual([2, 1]);
    expect([...image.Decode()]).toEqual([65, 66]);
    expect(parseContentStream(doc.Pages[0]!.Contents).find(op => op.operator === 'cm')?.operands)
      .toEqual([1, 0, 0, 0.5, 0, 0.5]);
  });
  it('does not publish an image abandoned by stop', () => {
    const { vm, graphics } = runGraphics('{ 1 1 8 [1 0 0 -1 0 1] { stop } image } stopped showpage');
    expect(vm.stack).toMatchObject([{ value: true }]);
    expect(parseContentStream(graphics.finish()[0]!.content).some(op => op.operator === 'Do')).toBe(false);
  });
});
