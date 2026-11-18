import { inflateSync } from 'node:zlib';
import type { PsInterpreter } from './psvm.js';
import type { PsScanner } from './psscan.js';
import type { PsBudget } from './psbudget.js';
import { PsFault, boolean, integer, name, canRead, type PsFile, type PsString, type PsDictionary, type PsValue } from './psvalue.js';
import { DecodeBudget } from './decodebudget.js';
import { asciiHexDecode, ascii85Decode, runLengthDecode } from './ascii.js';
import { lzwDecode } from './lzw.js';
import { applyPredictor } from './predictor.js';
import { rethrowLimit, UnsupportedFeatureError } from './errors.js';

/** Readers are owned by one VM; all sources are supplied bytes, never paths. */
export interface PsReader {
  position: number;
  closed: boolean;
  readonly source: Uint8Array;
  readonly depth: number;
  readByte(): number | undefined;
  available(): number;
  close(): void;
}

class SourceReader implements PsReader {
  closed = false;
  constructor(private initial: PsScanner | (() => PsScanner), private readonly budget: PsBudget,
    readonly depth = 0, private readonly parent?: SourceReader, private readonly closeSource = false) {}
  get scanner(): PsScanner {
    const pending: SourceReader[] = [];
    let current: SourceReader | undefined = this;
    while (current && typeof current.initial === 'function' && !current.closed) {
      this.budget.work(); this.budget.allocate(16, 'filter initialization chain');
      pending.push(current); current = current.parent;
    }
    while (pending.length) {
      const reader = pending.pop()!;
      if (typeof reader.initial === 'function') reader.initial = reader.initial();
    }
    if (typeof this.initial === 'function') throw new PsFault('ioerror');
    return this.initial;
  }
  get source(): Uint8Array { return this.scanner.source; }
  get position(): number { return this.scanner.position; }
  set position(value: number) { this.scanner.position = value; }
  readByte(): number | undefined {
    if (this.closed || this.position === this.source.length) { this.close(); return undefined; }
    this.scanner.memory.budget.work(1, 'file byte');
    const byte = this.source[this.position++];
    if (this.position === this.source.length) this.close();
    return byte;
  }
  available(): number { return this.closed ? 0 : this.source.length - this.position; }
  close(): void {
    let current: SourceReader | undefined = this;
    while (current && !current.closed) {
      current.closed = true;
      current = current.closeSource ? current.parent : undefined;
    }
  }
}

export function currentPsFile(vm: PsInterpreter): PsFile {
  const file = vm.currentFile;
  if (!file) throw new PsFault('invalidaccess');
  return file;
}

export function psStringBytes(vm: PsInterpreter, value: PsString): Uint8Array {
  if (!value.body.valid) throw new PsFault('invalidrestore');
  if (!canRead(value)) throw new PsFault('invalidaccess');
  vm.budget.allocate(64, 'string byte view');
  return value.body.bytes.subarray(value.offset, value.offset + value.length);
}

function parameter(vm: PsInterpreter, parameters: PsDictionary | undefined, key: string, fallback: number): number {
  const value = parameters && vm.memory.lookup(parameters, name(key));
  if (!value) return fallback;
  if (value.kind !== 'integer') throw new PsFault('typecheck');
  return value.value;
}

export function decodePsSource(vm: PsInterpreter, source: PsFile | PsString, filter: string,
  parameters: PsDictionary | undefined, decode: DecodeBudget): PsFile {
  const reader = source.kind === 'file' ? vm.memory.readFile(source) : new SourceReader(vm.scanner(psStringBytes(vm, source)), vm.budget);
  if (!(reader instanceof SourceReader)) throw new PsFault('invalidaccess');
  vm.budget.depth(reader.depth + 1, 'filter chain');
  vm.budget.limits.enforce('maxFilterChain', reader.depth + 1, 'PostScript filter chain');
  const closeValue = parameters && vm.memory.lookup(parameters, name('CloseSource'));
  if (closeValue && closeValue.kind !== 'boolean') throw new PsFault('typecheck');
  const closeSource = closeValue?.kind === 'boolean' && closeValue.value;
  const early = parameter(vm, parameters, 'EarlyChange', 1);
  const predictor = parameter(vm, parameters, 'Predictor', 1);
  const colors = parameter(vm, parameters, 'Colors', 1);
  const bpc = parameter(vm, parameters, 'BitsPerComponent', 8);
  const columns = parameter(vm, parameters, 'Columns', 1);
  if ((early !== 0 && early !== 1) || ![1, 2, 10, 11, 12, 13, 14, 15].includes(predictor)
    || colors <= 0 || columns <= 0 || ![1, 2, 4, 8, 16].includes(bpc)
    || !Number.isSafeInteger(colors * columns * bpc)) throw new PsFault('rangecheck');
  if (!['ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode', 'FlateDecode', 'LZWDecode'].includes(filter))
    throw new UnsupportedFeatureError('PostScript decoding filter is unsupported');
  return vm.memory.file(new SourceReader(() => {
  const start = reader.position;
  vm.budget.allocate(64, 'encoded file view');
  const input = reader.source.subarray(start, start + reader.available());
  const bound = decode.cap(input.length);
  // Scratch arrays, native output and predictor rows fit inside this hold.
  // Leave half the VM/work capacity available for codec dictionaries.
  const cap = Math.max(0, Math.floor(Math.min(bound.bytes, vm.budget.remainingBytes / 64,
    (vm.budget.remainingOperations - input.length) / 32, 0x3fffffff)));
  const reservation = vm.budget.reserve((cap + 1) * 32, input.length + (cap + 1) * 16);
  let consumed = 0, output: Uint8Array;
  try {
    let committed = false;
    try {
      if (filter === 'FlateDecode') {
        const inflated = inflateSync(input, { maxOutputLength: Math.max(1, cap + 1), info: true }) as unknown as
          { buffer: Uint8Array; engine: { bytesWritten: number } };
        output = inflated.buffer; consumed = inflated.engine.bytesWritten;
      } else if (filter === 'LZWDecode') {
        const metadata = { consumed: 0, ended: false, charge: (bytes: number, work: number): void => {
          vm.budget.allocate(bytes, 'LZW dictionary'); vm.budget.work(work, 'LZW dictionary');
        } };
        output = lzwDecode(input, early, cap, metadata); consumed = metadata.consumed;
        if (!metadata.ended && output.length <= cap) throw new PsFault('ioerror');
      } else {
        if (filter === 'RunLengthDecode') {
          let ended = false;
          while (consumed < input.length) {
            vm.budget.work(); const length = input[consumed++]!;
            if (length === 128) { ended = true; break; }
            consumed += length < 128 ? length + 1 : 1;
          }
          if (consumed > input.length || !ended) throw new PsFault('ioerror');
        } else {
          while (consumed < input.length) {
            vm.budget.work(); const byte = input[consumed++]!;
            if (filter === 'ASCIIHexDecode' && byte === 62) break;
            if (filter === 'ASCII85Decode' && byte === 126) {
              if (input[consumed++] !== 62) throw new PsFault('ioerror');
              break;
            }
          }
        }
        const prefix = input.subarray(0, consumed);
        output = filter === 'ASCIIHexDecode' ? asciiHexDecode(prefix, cap)
          : filter === 'ASCII85Decode' ? ascii85Decode(prefix, cap) : runLengthDecode(prefix, cap);
      }
      decode.check(output.length, consumed, undefined, 'PostScript filter');
      if (output.length > cap) {
        // Name the VM/work bound which prevented the codec from growing.
        vm.budget.allocate(output.length * 64, 'filter output capacity');
        vm.budget.work(output.length * 32, 'filter output capacity');
      }
      if (predictor !== 1 && (filter === 'FlateDecode' || filter === 'LZWDecode')) {
        const row = Math.ceil(colors * columns * bpc / 8);
        vm.budget.allocate(row * 2, 'predictor row scratch');
        output = applyPredictor(output, { predictor, colors, bpc, columns });
      }
      reservation.commit(output.length * 32, consumed + output.length * 16);
      committed = true;
    } finally { if (!committed) reservation.cancel(); }
  } catch (caught) {
    rethrowLimit(caught);
    if ((caught as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
      decode.check(cap + 1, input.length, undefined, 'PostScript filter');
      vm.budget.allocate((cap + 1) * 64, 'filter output capacity');
      vm.budget.work((cap + 1) * 32, 'filter output capacity');
    }
    throw caught instanceof PsFault ? caught : new PsFault('ioerror');
  }
  decode.chargeBytes(output.length);
  reader.position = start + consumed;
  return vm.scanner(output);
  }, vm.budget, reader.depth + 1, reader, closeSource), parameters ? [source, parameters] : [source]);
}

export function installPsSource(vm: PsInterpreter, decode: DecodeBudget): void {
  vm.installFileSupport({
    open: scanner => vm.memory.file(new SourceReader(scanner, vm.budget)),
    scanner: file => {
      const reader = vm.memory.readFile(file, true);
      if (!(reader instanceof SourceReader)) throw new PsFault('invalidaccess');
      if (reader.closed) { const scanner = vm.scanner(new Uint8Array(0)); return scanner; }
      return reader.scanner;
    },
  });
  const op = (text: string, execute: () => void): void => vm.registerStandardOperator(text, execute);
  op('currentfile', () => vm.push(currentPsFile(vm)));
  op('read', () => {
    const byte = vm.memory.readFile(vm.typed('file')).readByte();
    if (byte === undefined) vm.replace(1, boolean(false));
    else vm.replace(1, integer(byte), boolean(true));
  });
  for (const text of ['bytesavailable', 'fileposition']) op(text, () => {
    const reader = vm.memory.readFile(vm.typed('file'));
    vm.replace(1, integer(text === 'bytesavailable' ? reader.available() : reader.position));
  });
  op('closefile', () => { vm.memory.readFile(vm.typed('file')).close(); vm.replace(1); });
  for (const text of ['readstring', 'readhexstring', 'readline']) op(text, () => {
    const target = vm.typed('string'), reader = vm.memory.readFile(vm.typed('file', 1));
    // Validate destination before consuming any bytes, including empty strings.
    vm.memory.checkWritableString(target);
    let count = 0, complete = false, high = -1;
    for (;;) {
      if (text !== 'readline' && count === target.length) { complete = true; break; }
      const byte = reader.readByte();
      if (byte === undefined) break;
      if (text === 'readline' && (byte === 10 || byte === 13)) {
        if (byte === 13 && reader.source[reader.position] === 10) reader.readByte();
        complete = true; break;
      }
      if (count === target.length) throw new PsFault('rangecheck');
      if (text === 'readhexstring') {
        if ([0, 9, 10, 12, 13, 32].includes(byte)) continue;
        const digit = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55
          : byte >= 97 && byte <= 102 ? byte - 87 : -1;
        if (digit < 0) continue;
        if (high < 0) { high = digit; continue; }
        vm.memory.put(target, count++, integer(high * 16 + digit)); high = -1;
      } else vm.memory.put(target, count++, integer(byte));
    }
    if (high >= 0 && count < target.length) vm.memory.put(target, count++, integer(high * 16));
    vm.replace(2, vm.memory.interval(target, 0, count), boolean(complete));
  });
  const stringToken = vm.lookup('token')!;
  op('token', () => {
    const value = vm.peek();
    if (value.kind !== 'file') { if (stringToken.kind !== 'operator') throw new PsFault('typecheck'); stringToken.execute(); return; }
    const reader = vm.memory.readFile(value);
    if (!(reader instanceof SourceReader)) throw new PsFault('invalidaccess');
    const next = reader.closed ? undefined : reader.scanner.next();
    if (next) vm.replace(1, next, boolean(true));
    else { reader.close(); vm.replace(1, boolean(false)); }
  });
  op('filter', () => {
    const filter = vm.typed('name');
    const parameters = vm.peek(1).kind === 'dictionary' ? vm.typed('dictionary', 1) : undefined;
    const source = vm.peek(parameters ? 2 : 1);
    if (source.kind !== 'file' && source.kind !== 'string') throw new PsFault('typecheck');
    const file = decodePsSource(vm, source, filter.text, parameters, decode);
    vm.replace(parameters ? 3 : 2, file);
  });
  for (const text of ['file', 'run', 'deletefile', 'renamefile', 'filenameforall']) op(text, () => {
    throw new UnsupportedFeatureError('PostScript host file access is unsupported');
  });
}
