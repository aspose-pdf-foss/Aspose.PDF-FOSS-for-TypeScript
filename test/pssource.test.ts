import { describe, expect, it } from 'vitest';
import { runGraphics } from './helpers/ps-graphics.js';
import { LoadLimits } from '../src/loadlimits.js';

describe('PostScript supplied sources', () => {
  it.each([
    ['currentfile read A pop 7 8 add', [65, 15]],
    ['currentfile type /filetype eq currentfile dup eq', [true, true]],
    ['(currentfile) cvx exec currentfile eq', [true]],
    ['currentfile token 42 pop 7 8 add', [42, 15]],
    ['currentfile 3 string readstring ABC pop 0 get 7 8 add', [65, 15]],
    ['currentfile 2 string readhexstring 4142 pop 1 get 7 8 add', [66, 15]],
    ['currentfile 9 string readline AB\r\n pop length 7 8 add', [2, 15]],
    ['currentfile /f exch def /s save def currentfile s restore f eq', [true]],
    ['/s save def (41>) /ASCIIHexDecode filter s restore read', [false]],
    ['(4142>) /ASCIIHexDecode filter dup read pop exch read pop', [65, 66]],
  ])('runs %s', (source, values) => {
    const { vm } = runGraphics(source);
    expect(vm.stack.map(value => 'value' in value ? value.value : value.kind)).toEqual(values);
  });
  it('executes decoded files on the same source cursor', () => {
    const { vm } = runGraphics('(37203820616464>) /ASCIIHexDecode filter cvx exec');
    expect(vm.stack).toMatchObject([{ value: 15 }]);
  });
  it('keeps old positions advanced across restore', () => {
    const { vm } = runGraphics('/f (4142>) /ASCIIHexDecode filter def /s save def f read pop s restore f read pop');
    expect(vm.stack).toMatchObject([{ value: 65 }, { value: 66 }]);
  });
  it('checks file access and global barriers', () => {
    expect(() => runGraphics('currentfile noaccess read')).toThrow(/invalidaccess/);
    expect(() => runGraphics('currentfile true setglobal 1 array dup 0 4 -1 roll put')).toThrow(/invalidaccess/);
  });
  it('allows read from a closed file to report EOF', () => {
    const { vm } = runGraphics('(41>) /ASCIIHexDecode filter dup closefile read');
    expect(vm.stack).toMatchObject([{ value: false }]);
  });
  it('refuses host paths explicitly', () => {
    expect(() => runGraphics('(secret) (r) file')).toThrow(/unsupported/i);
  });
  it('shares decoded totals across filter instances', () => {
    expect(() => runGraphics('(414243>) /ASCIIHexDecode filter 3 string readstring pop pop '
      + '(444546>) /ASCIIHexDecode filter 3 string readstring',
      LoadLimits.defaults.with({ maxTotalDecodedBytes: 5 })))
      .toThrowError(expect.objectContaining({ limit: 'maxTotalDecodedBytes' }));
  });
  it('closes the source when a CloseSource filter closes', () => {
    const { vm } = runGraphics('/f (4142>) /ASCIIHexDecode filter def '
      + 'f << /CloseSource true >> /ASCIIHexDecode filter closefile f read');
    expect(vm.stack).toMatchObject([{ value: false }]);
  });
  it('does not decode a filter merely to close it or restore it', () => {
    const { vm } = runGraphics('(bad) /FlateDecode filter closefile /s save def '
      + '(bad) /FlateDecode filter s restore read');
    expect(vm.stack).toMatchObject([{ value: false }]);
  });
});
