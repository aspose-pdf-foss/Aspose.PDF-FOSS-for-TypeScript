import { describe, expect, it } from 'vitest';
import { PsInterpreter } from '../src/psvm.js';
import { installPsGraphics } from '../src/psgraphics.js';
import { LoadLimits } from '../src/loadlimits.js';

function countingInput(text: string) {
  const bytes = new TextEncoder().encode(text);
  let highest = -1;
  return {
    position: 0, closed: false,
    byteAt(index: number): number | undefined { highest = Math.max(highest, index); return bytes[index]; },
    span(start: number, end: number): Uint8Array { return bytes.slice(start, end); },
    available(): number { return -1; },
    close(): void { this.closed = true; },
    get highest() { return highest; },
  };
}

describe('PostScript pull-byte inputs', () => {
  it('scans a token without pulling the following token', () => {
    const vm = new PsInterpreter(), input = countingInput('12 34');
    const scanner = vm.scanner(input);
    expect(scanner.next()).toMatchObject({ kind: 'integer', value: 12 });
    expect(scanner.position).toBe(3);
    expect(input.highest).toBeLessThanOrEqual(2);
    expect(scanner.next()).toMatchObject({ kind: 'integer', value: 34 });
    expect(scanner.next()).toBeUndefined();
  });
  it('executes a pull input on the existing VM pump', () => {
    const vm = new PsInterpreter();
    vm.run(countingInput('7 8 add'));
    expect(vm.stack).toMatchObject([{ value: 15 }]);
  });
  it('shares scanner and explicit readstring positions including CRLF separators', () => {
    const vm = new PsInterpreter(); installPsGraphics(vm);
    vm.run(countingInput('currentfile 2 string readstring\r\nAB pop 1 get 7 8 add'));
    expect(vm.stack).toMatchObject([{ value: 66 }, { value: 15 }]);
  });
  it('shares token inspection and subsequent source execution', () => {
    const vm = new PsInterpreter(); installPsGraphics(vm);
    vm.run(countingInput('currentfile token 42 pop 7 8 add'));
    expect(vm.stack).toMatchObject([{ value: 42 }, { value: 15 }]);
  });
  it('preserves nested procedures and byte strings', () => {
    const vm = new PsInterpreter();
    vm.run(countingInput('{ (A\\n) <4243> } exec'));
    expect(vm.stack).toMatchObject([
      { kind: 'string', body: { bytes: new Uint8Array([65, 10]) } },
      { kind: 'string', body: { bytes: new Uint8Array([66, 67]) } },
    ]);
  });
  it('retains token-start offsets and diagnostic bytes for a truncated token', () => {
    const vm = new PsInterpreter(), scanner = vm.scanner(countingInput('  (abc'));
    expect(() => scanner.next()).toThrowError(expect.objectContaining({
      errorName: 'syntaxerror', offset: 2,
      command: expect.objectContaining({ kind: 'string', body: expect.objectContaining({ bytes: new TextEncoder().encode('(abc') }) }),
    }));
  });
  it('checks token growth before pulling an unbounded token', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxObjectBytes: 8 }) });
    const input = countingInput('(' + 'x'.repeat(10000));
    expect(() => vm.scanner(input).next()).toThrowError(expect.objectContaining({
      limit: 'maxObjectBytes', allowed: 8, reached: 9,
    }));
    expect(input.highest).toBeLessThanOrEqual(8);
  });
  it('bounds scratch allocation for a streamed literal string', () => {
    const vm = new PsInterpreter({ limits: LoadLimits.defaults.with({ maxPostScriptVmBytes: 256 }) });
    expect(() => vm.scanner(countingInput('(' + 'x'.repeat(10000))).next())
      .toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', allowed: 256 }));
  });
  it('decodes a supplied prefix without consuming later source', () => {
    const vm = new PsInterpreter(); installPsGraphics(vm);
    vm.run(countingInput('currentfile /ASCIIHexDecode filter 1 string readstring 41> pop 0 get 7 8 add'));
    expect(vm.stack).toMatchObject([{ value: 65 }, { value: 15 }]);
  });
});
