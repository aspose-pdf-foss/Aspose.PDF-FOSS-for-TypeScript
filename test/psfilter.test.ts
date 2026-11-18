import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { lzwEncode } from '../src/lzw.js';
import { runLengthEncode, ascii85Encode } from '../src/ascii.js';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { LoadLimits } from '../src/loadlimits.js';

function runFilter(filter: string, data: Uint8Array, params = '', limits = LoadLimits.defaults) {
  const prefix = new TextEncoder().encode(`currentfile ${params} /${filter} filter 3 string readstring `);
  const suffix = new TextEncoder().encode(' pop 0 get 7 8 add');
  const vm = new PsInterpreter({ limits }); installPsGraphics(vm);
  vm.run(new Uint8Array([...prefix, ...data, ...suffix]));
  return vm;
}
describe('PostScript decoding filters', () => {
  const abc = new Uint8Array([65, 66, 67]);
  it.each([
    ['ASCIIHexDecode', new TextEncoder().encode('414243>')],
    ['ASCII85Decode', ascii85Encode(abc)],
    ['RunLengthDecode', runLengthEncode(abc)],
    ['FlateDecode', deflateSync(abc)],
    ['LZWDecode', lzwEncode(abc)],
  ])('leaves following source after %s', (filter, data) => {
    expect(runFilter(filter, data).stack).toMatchObject([{ value: 65 }, { value: 15 }]);
  });
  it('supports LZW EarlyChange zero', () => {
    expect(runFilter('LZWDecode', lzwEncode(abc, 0), '<< /EarlyChange 0 >>').stack)
      .toMatchObject([{ value: 65 }, { value: 15 }]);
  });
  it('applies a PNG predictor', () => {
    expect(runFilter('FlateDecode', deflateSync(new Uint8Array([1, 65, 1, 1])),
      '<< /Predictor 15 /Columns 3 >>').stack).toMatchObject([{ value: 65 }, { value: 15 }]);
  });
  it('caps decoded output before native allocation and cannot be stopped', () => {
    expect(() => runFilter('FlateDecode', deflateSync(new Uint8Array(10000)), '',
      LoadLimits.defaults.with({ maxDecodedStreamBytes: 100 })))
      .toThrowError(expect.objectContaining({ limit: 'maxDecodedStreamBytes' }));
  });
  it('rejects malformed data and invalid parameters', () => {
    expect(() => runFilter('ASCIIHexDecode', new TextEncoder().encode('GG>'))).toThrow(/ioerror/);
    expect(() => runFilter('LZWDecode', lzwEncode(abc), '<< /EarlyChange 3 >>')).toThrow(/rangecheck/);
  });
});
