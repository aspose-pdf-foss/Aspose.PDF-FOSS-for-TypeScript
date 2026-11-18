import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { eexecInput, installPsEexec, psFontSource } from '../src/pseexec.js';
import { LoadLimits } from '../src/loadlimits.js';
import { ResourceLimitError } from '../src/errors.js';
import { constants, deflateSync } from 'node:zlib';
import { lzwEncode } from '../src/lzw.js';
import { encryptedPs, flatePs, joinPs, pfbSegment, psBytes } from './helpers/ps-font-program.js';

function machine(limits = LoadLimits.defaults) {
  const vm = new PsInterpreter({ limits });
  const graphics = installPsGraphics(vm);
  installPsEexec(vm, graphics.decode);
  return { vm, graphics };
}

describe('bounded PostScript eexec execution', () => {
  it.each([false, true])('returns to the exact clear suffix (hex=%s)', hex => {
    const { vm } = machine();
    vm.run(encryptedPs('mark currentfile closefile', { hex, suffix: 'cleartomark 7 8 add' }));
    expect(vm.stack).toMatchObject([{ value: 15 }]);
  });
  it('decrypts bytes read explicitly from currentfile using the same cipher state', () => {
    const { vm } = machine();
    vm.run(encryptedPs('currentfile 3 string readstring ABC pop 0 get currentfile closefile', { suffix: ' 1 add' }));
    expect(vm.stack).toMatchObject([{ value: 66 }]);
  });
  it.each(['ASCIIHexDecode', 'FlateDecode'])('leaves both decrypted and clear suffixes after %s', filter => {
    const { vm } = machine();
    const data = filter === 'ASCIIHexDecode' ? psBytes('37>') : flatePs('7');
    const body = joinPs(psBytes(`currentfile /${filter} filter cvx exec `), data,
      psBytes(' 8 add currentfile closefile'));
    vm.run(encryptedPs(body, { hex: true, suffix: ' 2 mul' }));
    expect(vm.stack).toMatchObject([{ value: 30 }]);
  });
  it('runs with systemdict on top and restores the complete prior prefix', () => {
    const { vm } = machine();
    vm.run(psBytes('/add { pop pop 99 } def'));
    const prefix = [...vm.dictionaryStack];
    vm.run(encryptedPs('7 8 add 1 dict begin currentfile closefile', { suffix: ' 2 3 add' }));
    expect(vm.stack).toMatchObject([{ value: 15 }, { value: 99 }]);
    expect(vm.dictionaryStack).toEqual(prefix);
  });
  it.each([
    ['stored', { level: 0 }], ['fixed', { strategy: constants.Z_FIXED }], ['dynamic', { level: 9 }],
  ] as const)('finds the exact %s Deflate boundary', (_, options) => {
    const { vm } = machine();
    const text = `${'0 pop 1 pop 2 pop 3 pop 400 pop 56 pop '.repeat(120)}7`;
    const data = deflateSync(psBytes(text), options);
    vm.run(encryptedPs(joinPs(psBytes('currentfile /FlateDecode filter cvx exec '), data,
      psBytes(' 8 add currentfile closefile')), { hex: true, suffix: ' 2 mul' }));
    expect(vm.stack).toMatchObject([{ value: 30 }]);
  });
  it.each([0, 1])('finds LZW EOD without decrypting clear suffixes (EarlyChange=%s)', early => {
    const { vm } = machine();
    const data = lzwEncode(psBytes(`${'1 pop 2 pop 3 pop '.repeat(150)}7`), early);
    vm.run(encryptedPs(joinPs(psBytes(`currentfile << /EarlyChange ${early} >> /LZWDecode filter cvx exec `), data,
      psBytes(' 8 add currentfile closefile')), { hex: true, suffix: ' 2 mul' }));
    expect(vm.stack).toMatchObject([{ value: 30 }]);
  });
  it('restores caller dictionaries removed by the encrypted program', () => {
    const { vm } = machine();
    vm.run(psBytes('1 dict begin /caller 42 def'));
    const prefix = [...vm.dictionaryStack];
    vm.run(encryptedPs('cleardictstack currentfile closefile', { suffix: ' caller' }));
    expect(vm.dictionaryStack).toEqual(prefix);
    expect(vm.stack).toMatchObject([{ value: 42 }]);
  });
  it('keeps a returning error handler inside the encrypted scope', () => {
    const { vm } = machine();
    vm.run(psBytes('errordict /undefined { pop 6 } put'));
    vm.run(encryptedPs('1 dict begin missing 7 8 add currentfile closefile'));
    expect(vm.stack).toMatchObject([{ value: 6 }, { value: 15 }]);
    expect(vm.dictionaryStack).toHaveLength(3);
  });
  it.each(['stop', 'exit', 'quit', 'fail'])('restores dictionary scope after %s', escape => {
    const { vm } = machine();
    const prefix = [...vm.dictionaryStack];
    const failure = new ResourceLimitError('maxPostScriptOperations', 1, 2);
    vm.registerOperator('fail', () => { throw failure; });
    const bytes = encryptedPs(`1 dict begin ${escape}`);
    if (escape === 'quit' || escape === 'stop') vm.run(bytes);
    else expect(() => vm.run(bytes)).toThrow();
    expect(vm.dictionaryStack).toEqual(prefix);
    vm.run(psBytes('7 8 add'));
    expect(vm.stack.at(-1)).toMatchObject({ value: 15 });
  });
  it.each([false, true])('executes supplied PFB segments (hex=%s)', hex => {
    const { vm } = machine();
    vm.run(psFontSource(encryptedPs('mark currentfile closefile', { hex, pfb: true, suffix: 'cleartomark 7 8 add' }), vm.budget));
    expect(vm.stack).toMatchObject([{ value: 15 }]);
  });
  it('preserves cipher state across PFB binary segment boundaries', () => {
    const { vm } = machine();
    const bytes = encryptedPs('7 8 add currentfile closefile');
    const start = psBytes('currentfile eexec\n').length;
    const pfb = joinPs(pfbSegment(1, bytes.subarray(0, start)), pfbSegment(2, bytes.subarray(start, start + 7)),
      pfbSegment(2, bytes.subarray(start + 7)), pfbSegment(1, psBytes(' 2 mul')), new Uint8Array([128, 3]));
    vm.run(psFontSource(pfb, vm.budget));
    expect(vm.stack).toMatchObject([{ value: 30 }]);
  });
  it('honors a PFB binary tag even when all four cipher prefix bytes look hexadecimal', () => {
    const { vm } = machine();
    let state = 55665;
    const cipher = [...psBytes('ABCD')];
    for (const encoded of cipher) state = ((encoded + state) * 52845 + 22719) & 65535;
    for (const byte of psBytes('7 8 add currentfile closefile\n')) {
      const encoded = byte ^ (state >> 8); cipher.push(encoded);
      state = ((encoded + state) * 52845 + 22719) & 65535;
    }
    vm.run(psFontSource(joinPs(pfbSegment(1, psBytes('currentfile eexec\n')),
      pfbSegment(2, new Uint8Array(cipher)), new Uint8Array([128, 3])), vm.budget));
    expect(vm.stack).toMatchObject([{ value: 15 }]);
  });
  it('accounts for whitespace between eexec hex pairs without moving the clear suffix', () => {
    const { vm } = machine();
    const bytes = encryptedPs('7 8 add currentfile closefile', { hex: true });
    const start = psBytes('currentfile eexec\n').length;
    const text = Buffer.from(bytes.subarray(start)).toString('ascii').match(/.{1,2}/g)!.join(' \r\n');
    vm.run(joinPs(bytes.subarray(0, start), psBytes(text), psBytes(' 2 mul')));
    expect(vm.stack).toMatchObject([{ value: 30 }]);
  });
  it.each([
    new Uint8Array([128]), new Uint8Array([128, 4]),
    new Uint8Array([128, 1, 20, 0, 0, 0, 65]),
    pfbSegment(1, psBytes('7')),
  ])('rejects malformed or truncated PFB framing %#', bytes => {
    const { vm } = machine();
    expect(() => psFontSource(bytes, vm.budget)).toThrow(/invalidfont|ioerror/);
  });
  it('rejects a truncated eexec random prefix', () => {
    const { vm, graphics } = machine();
    const input = eexecInput(vm, vm.memory.string(new Uint8Array([255, 255])), graphics.decode);
    expect(() => input.byteAt(0)).toThrow(/ioerror/);
  });
  it('charges decoded bytes against the shared graphics decode total', () => {
    const { vm } = machine(LoadLimits.defaults.with({ maxTotalDecodedBytes: 8 }));
    expect(() => vm.run(encryptedPs('123456789 currentfile closefile')))
      .toThrowError(expect.objectContaining({ limit: 'maxTotalDecodedBytes' }));
    expect(vm.dictionaryStack).toHaveLength(3);
  });
  it('enforces the cumulative eexec stream bound', () => {
    const { vm } = machine(LoadLimits.defaults.with({ maxDecodedStreamBytes: 8 }));
    expect(() => vm.run(encryptedPs('123456789 currentfile closefile')))
      .toThrowError(expect.objectContaining({ limit: 'maxDecodedStreamBytes' }));
  });
});
