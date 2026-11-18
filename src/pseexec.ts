import { RATIO_FLOOR, type DecodeBudget } from './decodebudget.js';
import { byteInput, type PsByteInput } from './psinput.js';
import type { PsBudget } from './psbudget.js';
import type { PsInterpreter } from './psvm.js';
import { PsFault, type PsFile, type PsString } from './psvalue.js';
import { psStringBytes, sourcePsFile } from './pssource.js';

type Segment = { start: number; end: number; type: number };
const framing = new WeakMap<PsByteInput, readonly Segment[]>();
const installed = new WeakSet<PsInterpreter>();
const white = (byte: number): boolean => byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
const hex = (byte: number): number => byte >= 48 && byte <= 57 ? byte - 48
  : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;

/** Strip supplied PFB framing without losing the binary/ASCII segment tags. */
export function psFontSource(bytes: Uint8Array, budget: PsBudget): PsByteInput {
  budget.limits.enforce('maxFileBytes', bytes.length, 'PostScript font source');
  if (bytes[0] !== 128) return byteInput(bytes, budget);
  const segments: Segment[] = [];
  let at = 0, length = 0, ended = false;
  while (at < bytes.length) {
    budget.work(1, 'PFB segment');
    if (bytes[at++] !== 128) throw new PsFault('invalidfont');
    const type = bytes[at++];
    if (type === 3) { ended = true; break; }
    if ((type !== 1 && type !== 2) || at + 4 > bytes.length) throw new PsFault('invalidfont');
    const size = bytes[at]! + bytes[at + 1]! * 256 + bytes[at + 2]! * 65536 + bytes[at + 3]! * 16777216;
    at += 4;
    if (at + size > bytes.length) throw new PsFault('invalidfont');
    budget.items(segments.length + 1, 'PFB segments'); budget.allocate(48, 'PFB segment');
    segments.push({ start: at, end: at + size, type }); length += size; at += size;
  }
  if (!ended || at !== bytes.length) throw new PsFault('invalidfont');
  budget.allocate(64 + length, 'PFB source'); budget.work(length, 'PFB source');
  const output = new Uint8Array(length);
  let offset = 0;
  for (const segment of segments) {
    output.set(bytes.subarray(segment.start, segment.end), offset);
    const size = segment.end - segment.start;
    segment.start = offset; segment.end = offset + size; offset += size;
  }
  const input = byteInput(output, budget); framing.set(input, segments); return input;
}

/** Lookahead caches cipher state but never commits its parent's cursor. Every
 * decoded byte records its encoded end, including intervening hex whitespace. */
export function eexecInput(vm: PsInterpreter, source: PsFile | PsString, decode: DecodeBudget): PsByteInput {
  const reader = source.kind === 'file' ? vm.memory.readFile(source) : undefined;
  const parent = reader?.input ?? byteInput(psStringBytes(vm, source as PsString), vm.budget);
  const start = reader?.position ?? 0;
  vm.budget.allocate(128, 'eexec input');
  let cursor = start, state = 55665, random = 0, zero = start, position = 0, closed = false;
  let mode: 'binary' | 'hex' | undefined;
  let bytes = new Uint8Array(0), ends = new Float64Array(0), length = 0;
  const detect = (): void => {
    let segment: Segment | undefined;
    for (const item of framing.get(parent) ?? []) {
      vm.budget.work(1, 'PFB eexec mode');
      if (start >= item.start && start < item.end) { segment = item; break; }
    }
    if (segment?.type === 2) { mode = 'binary'; return; }
    let count = 0, peek = cursor;
    while (count < 4) {
      vm.budget.work(1, 'eexec detection');
      const byte = parent.byteAt(peek++);
      if (byte === undefined || hex(byte) < 0 && !white(byte)) { mode = 'binary'; return; }
      if (!white(byte)) count++;
    }
    mode = 'hex';
  };
  const cipherByte = (optional = false): number | undefined => {
    if (mode === 'binary') { vm.budget.work(1, 'eexec byte'); return parent.byteAt(cursor++); }
    let high = -1;
    for (;;) {
      vm.budget.work(1, 'eexec hex byte');
      const byte = parent.byteAt(cursor++);
      if (byte === undefined) { if (high >= 0) throw new PsFault('ioerror'); return undefined; }
      if (white(byte)) continue;
      const digit = hex(byte); if (digit < 0) { if (optional) return undefined; throw new PsFault('ioerror'); }
      if (high < 0) high = digit;
      else return high * 16 + digit;
    }
  };
  const input: PsByteInput = {
    get position() { return position; },
    set position(value) {
      if (!Number.isSafeInteger(value) || value < 0 || value > length) throw new PsFault('rangecheck');
      position = value;
      const committed = value === 0 ? zero : ends[value - 1]!;
      if (reader) reader.position = committed; else parent.position = committed;
    },
    get closed() { return closed; },
    peekLineFeed() {
      if (position < length) return bytes[position] === 10;
      const saved = cursor;
      let next: number | undefined;
      try { next = cipherByte(true); } finally { cursor = saved; }
      return next !== undefined && (next ^ (state >> 8)) === 10;
    },
    byteAt(index) {
      if (!Number.isSafeInteger(index) || index < 0) return undefined;
      if (!mode) detect();
      while (length <= index) {
        const encoded = cipherByte();
        if (encoded === undefined) { if (random < 4) throw new PsFault('ioerror'); return undefined; }
        const byte = encoded ^ (state >> 8);
        state = ((encoded + state) * 52845 + 22719) & 65535;
        if (random < 4) { random++; zero = cursor; continue; }
        vm.budget.limits.enforce('maxFileBytes', length + 1, 'eexec source');
        decode.limits.enforce('maxDecodedStreamBytes', length + 1, 'eexec');
        if (length + 1 > RATIO_FLOOR)
          decode.limits.enforce('maxExpansionRatio', Math.ceil((length + 1) / Math.max(1, cursor - start)), 'eexec');
        decode.check(1, cursor - start, undefined, 'eexec');
        if (length === bytes.length) {
          const capacity = Math.max(16, length * 2);
          vm.budget.allocate(128 + capacity * 9, 'eexec cache'); vm.budget.work(length, 'eexec cache');
          const next = new Uint8Array(capacity), offsets = new Float64Array(capacity);
          next.set(bytes); offsets.set(ends); bytes = next; ends = offsets;
        }
        bytes[length] = byte; ends[length++] = cursor; decode.chargeBytes(1);
      }
      return bytes[index];
    },
    span(first, end) {
      if (first < 0 || end < first || end > 0 && this.byteAt(end - 1) === undefined) throw new PsFault('rangecheck');
      vm.budget.allocate(64, 'eexec view'); return bytes.subarray(first, end);
    },
    available() { return closed ? 0 : -1; },
    close() { closed = true; },
  };
  return input;
}

export function installPsEexec(vm: PsInterpreter, decode: DecodeBudget): void {
  if (installed.has(vm)) throw new PsFault('invalidaccess');
  vm.registerStandardOperator('eexec', () => {
    const source = vm.peek();
    if (source.kind !== 'file' && source.kind !== 'string') throw new PsFault('typecheck');
    const file = sourcePsFile(vm, eexecInput(vm, source, decode), [source]);
    vm.replace(1);
    const scope = vm.withDictionaryScope(vm.systemdict);
    vm.invoke({ ...file, executable: true }, { ...scope, roots: [...scope.roots, file] });
  });
  installed.add(vm);
}
