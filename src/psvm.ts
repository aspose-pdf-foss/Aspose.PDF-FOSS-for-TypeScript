import type { LoadLimits } from './loadlimits.js';
import { PdfParseError, rethrowLimit } from './errors.js';
import { PsBudget } from './psbudget.js';
import { PsMemory } from './psmemory.js';
import { PsScanner } from './psscan.js';
import { PsFault, boolean, name, operator, psNull, type PsArray, type PsDictionary, type PsSave, type PsString, type PsValue } from './psvalue.js';
import { installPsCore } from './pscore.js';
import { installPsData } from './psdata.js';

type Frame =
  | { kind: 'source'; scanner: PsScanner; owner?: PsString }
  | { kind: 'procedure'; procedure: PsArray; index: number; offset: number }
  | { kind: 'loop'; step: () => boolean; roots: readonly PsValue[] }
  | { kind: 'execute'; value: PsValue; indirect: boolean; offset: number }
  | { kind: 'handler'; fault: PsFault; command: PsValue }
  | { kind: 'stopped' };

export class PsInterpreter {
  private readonly operands: PsValue[] = [];
  get stack(): readonly PsValue[] { return this.operands; }
  readonly budget: PsBudget;
  readonly memory: PsMemory;
  readonly systemdict: PsDictionary;
  readonly globaldict: PsDictionary;
  readonly userdict: PsDictionary;
  readonly errordict: PsDictionary;
  readonly error: PsDictionary;
  private readonly dictionaries: PsDictionary[];
  packing = false;
  private readonly frames: Frame[] = [];
  private running = false;
  private offset = 0;
  private initializing = true;
  private command: PsValue = psNull();
  private undo: { index: number; value: PsValue }[] | undefined;
  private undoFloor = 0;
  private undoLength = 0;
  private readonly saves: { token: PsSave; packing: boolean }[] = [];
  private uncaught: PsFault | undefined;
  get currentScanner(): PsScanner | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) { this.budget.work(); const frame = this.frames[i]!; if (frame.kind === 'source') return frame.scanner; }
    return undefined;
  }
  get dictionaryStack(): readonly PsDictionary[] { return this.dictionaries; }
  get currentdict(): PsDictionary { return this.dictionaries[this.dictionaries.length - 1]!; }
  constructor(options: { limits?: LoadLimits } = {}) {
    this.budget = new PsBudget(options.limits); this.memory = new PsMemory(this.budget);
    [this.systemdict, this.globaldict, this.userdict] = this.budget.bootstrap(() => {
      const system = this.memory.dictionary(); this.memory.currentGlobal = true;
      const global = this.memory.dictionary(); this.memory.currentGlobal = false;
      return [system, global, this.memory.dictionary()];
    });
    this.dictionaries = [this.systemdict, this.globaldict, this.userdict];
    [this.errordict, this.error] = this.budget.bootstrap(() => [this.memory.dictionary(), this.memory.dictionary()]);
    this.budget.bootstrap(() => {
      installPsCore(this);
      installPsData(this);
      for (const [key, value] of [['true', boolean(true)], ['false', boolean(false)], ['null', psNull()]] as const) this.memory.put(this.systemdict, name(key), value);
      for (const [key, value] of [['systemdict', this.systemdict], ['globaldict', this.globaldict], ['userdict', this.userdict], ['errordict', this.errordict], ['$error', this.error]] as const) this.memory.put(this.systemdict, name(key), value);
      for (const key of ['configurationerror', 'dictfull', 'dictstackoverflow', 'dictstackunderflow', 'execstackoverflow', 'handleerror', 'interrupt', 'invalidaccess', 'invalidexit', 'invalidfileaccess', 'invalidfont', 'invalidrestore', 'ioerror', 'limitcheck', 'nocurrentpoint', 'rangecheck', 'stackoverflow', 'stackunderflow', 'syntaxerror', 'timeout', 'typecheck', 'undefined', 'undefinedfilename', 'undefinedresource', 'undefinedresult', 'unmatchedmark', 'unregistered', 'VMerror']) {
        this.memory.put(this.errordict, name(key), operator(key, () => this.standardError(key)));
      }
      for (const key of ['errorname', 'command', 'errorinfo', 'ostack', 'estack', 'dstack']) this.memory.put(this.error, name(key), psNull());
      this.memory.put(this.error, name('newerror'), boolean(false));
      this.memory.put(this.error, name('recordstacks'), boolean(true));
      this.memory.put(this.error, name('binary'), boolean(false));
      this.memory.bootstrapSystemDictionary(this.systemdict);
    });
    this.initializing = false;
  }
  registerOperator(text: string, execute: (vm: PsInterpreter) => void): void {
    this.budget.allocate(64, 'operator');
    this.memory.put(this.initializing ? this.systemdict : this.userdict, this.memory.name(text), operator(text, () => execute(this)));
  }
  lookup(text: string): PsValue | undefined {
    const key = name(text); const dictionary = this.where(key); return dictionary ? this.memory.lookup(dictionary, key) : undefined;
  }
  where(key: PsValue): PsDictionary | undefined {
    for (let i = this.dictionaries.length - 1; i >= 0; i--) {
      this.budget.work(); const value = this.memory.lookup(this.dictionaries[i]!, key); if (value !== undefined) return this.dictionaries[i]!;
    }
    return undefined;
  }
  begin(dictionary: PsDictionary): void {
    this.memory.lookup(dictionary, name(''));
    this.budget.depth(this.dictionaries.length - 2, 'dictionary stack'); this.budget.allocate(16, 'dictionary stack');
    this.dictionaries.push(dictionary);
  }
  end(): void { if (this.dictionaries.length <= 3) throw new PsFault('dictstackunderflow'); this.dictionaries.pop(); }
  clearDictionaries(): void { this.dictionaries.length = 3; }
  scanner(source: Uint8Array): PsScanner {
    const scanner = new PsScanner(source, this.memory, text => { const value = this.lookup(text); if (!value) throw new PsFault('undefined', scanner.lastTokenOffset); return value; }, () => this.packing);
    return scanner;
  }
  peek(depth = 0): PsValue {
    if (depth < 0) throw new PsFault('rangecheck');
    const value = this.operands[this.operands.length - 1 - depth]; if (!value) throw new PsFault('stackunderflow'); return value;
  }
  typed<K extends PsValue['kind']>(kind: K, depth = 0): Extract<PsValue, { kind: K }> {
    const value = this.peek(depth); if (value.kind !== kind) throw new PsFault('typecheck');
    return value as Extract<PsValue, { kind: K }>;
  }
  number(depth = 0): Extract<PsValue, { kind: 'integer' | 'real' }> {
    const value = this.peek(depth); if (value.kind !== 'integer' && value.kind !== 'real') throw new PsFault('typecheck'); return value;
  }
  replace(count: number, ...values: PsValue[]): void {
    if (!Number.isInteger(count) || count < 0) throw new PsFault('rangecheck');
    if (count > this.operands.length) throw new PsFault('stackunderflow');
    this.budget.items(this.operands.length - count + values.length);
    this.budget.allocate(values.length * 16, 'operand stack');
    if (this.undo) {
      const floor = Math.min(this.undoFloor, this.operands.length - count);
      this.budget.allocate((this.undoFloor - floor) * 32, 'operand undo'); this.budget.work(this.undoFloor - floor);
      while (this.undoFloor > floor) { const index = --this.undoFloor; this.undo.push({ index, value: this.operands[index]! }); }
    }
    this.operands.length -= count; for (const value of values) this.operands.push(value);
  }
  push(value: PsValue): void { this.replace(0, value); }
  pop(): PsValue { const value = this.peek(); this.replace(1); return value; }
  markDepth(): number {
    for (let i = 0; i < this.operands.length; i++) { this.budget.work(); if (this.peek(i).kind === 'mark') return i; }
    throw new PsFault('unmatchedmark');
  }
  slice(start: number, end = this.operands.length): PsValue[] {
    this.budget.allocate((end - start) * 16, 'operand scratch'); this.budget.work(end - start); return this.operands.slice(start, end);
  }
  procedure(depth = 0): PsArray {
    const value = this.typed('array', depth); if (!value.executable) throw new PsFault('typecheck');
    this.memory.checkExecutable(value); return value;
  }
  private frame(value: Frame): void {
    this.budget.depth(this.frames.length + 1, 'execution stack'); this.budget.allocate(96, 'execution frame'); this.frames.push(value);
  }
  /** Schedule work only; registered operators must never recursively run the pump. */
  execute(value: PsValue, indirect = true): void {
    this.frame({ kind: 'execute', value, indirect, offset: this.offset });
  }
  private dispatch(value: PsValue, indirect = true): void {
    for (;;) {
      this.budget.work();
      this.command = value;
      if (!value.executable || (value.kind === 'array' && !indirect)) { this.push(value); return; }
      if (value.kind === 'name') {
        const resolved = this.lookup(value.text); if (!resolved) throw new PsFault('undefined'); value = resolved; indirect = true; continue;
      }
      if (value.kind === 'operator') { value.execute(); return; }
      if (value.kind === 'array') { this.memory.checkExecutable(value); this.frame({ kind: 'procedure', procedure: value, index: 0, offset: this.offset }); return; }
      if (value.kind === 'string') { this.frame({ kind: 'source', scanner: this.scanner(this.memory.executionBytes(value)), owner: value }); return; }
      if (value.kind !== 'null') this.push(value); return;
    }
  }
  scheduleLoop(step: () => boolean, roots: readonly PsValue[]): void {
    this.budget.allocate(roots.length * 16, 'loop roots'); this.frame({ kind: 'loop', step, roots });
  }
  scheduleStopped(value: PsValue): void { this.frame({ kind: 'stopped' }); this.execute(value); }
  exit(): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      this.budget.work(); const frame = this.frames[i]!;
      if (frame.kind === 'stopped') break;
      if (frame.kind === 'loop') { this.frames.length = i; return; }
    }
    throw new PsFault('invalidexit');
  }
  stop(fault?: PsFault): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      this.budget.work(); if (this.frames[i]!.kind === 'stopped') { this.frames.length = i; this.push(boolean(true)); return; }
    }
    if (!fault) for (let i = this.frames.length - 1; i >= 0; i--) { this.budget.work(); const frame = this.frames[i]!; if (frame.kind === 'handler') { fault = frame.fault; break; } }
    this.frames.length = 0; this.uncaught = fault;
  }
  quit(): void { this.frames.length = 0; }
  executionStack(): PsValue[] {
    this.budget.allocate(this.frames.length * 16, 'execution stack view'); this.budget.work(this.frames.length);
    return this.frames.map(frame => frame.kind === 'procedure' ? frame.procedure : frame.kind === 'source' ? frame.owner ?? psNull() : frame.kind === 'execute' ? frame.value : frame.kind === 'handler' ? frame.command : name(`--${frame.kind}--`));
  }
  get executionDepth(): number { return this.frames.length; }
  save(): PsSave {
    this.budget.allocate(32, 'save interpreter state'); const token = this.memory.save(); this.saves.push({ token, packing: this.packing }); return token;
  }
  restore(token: PsSave): void {
    const roots: PsValue[] = [];
    const add = (value: PsValue): void => { this.budget.allocate(16, 'live roots'); this.budget.work(); roots.push(value); };
    for (const value of this.operands) add(value);
    for (const dict of this.dictionaries) add(dict);
    for (const frame of this.frames) {
      this.budget.work();
      if (frame.kind === 'procedure') add(frame.procedure);
      else if (frame.kind === 'source' && frame.owner) add(frame.owner);
      else if (frame.kind === 'execute') add(frame.value);
      else if (frame.kind === 'handler') add(frame.command);
      else if (frame.kind === 'loop') for (const value of frame.roots) add(value);
    }
    this.budget.work(this.saves.length); const index = this.saves.findIndex(save => save.token.id === token.id);
    this.memory.restore(token, roots);
    if (index >= 0) { this.packing = this.saves[index]!.packing; this.saves.length = index; }
  }
  private recover(fault: PsFault): void {
    if (this.undo) {
      this.operands.length = this.undoLength;
      for (const item of this.undo) this.operands[item.index] = item.value;
    }
    this.undo = undefined;
    this.push(this.command);
    const key = name(fault.errorName);
    const dictionary = this.lookup('errordict');
    const handler = dictionary?.kind === 'dictionary' ? this.memory.lookup(dictionary, key) : undefined;
    if (!handler) throw fault;
    this.frame({ kind: 'handler', fault, command: this.command }); this.execute(handler);
  }
  private standardError(errorName: string): void {
    const command = this.pop();
    this.memory.currentGlobal = false;
    this.memory.put(this.error, name('newerror'), boolean(true));
    this.memory.put(this.error, name('errorname'), name(errorName));
    this.memory.put(this.error, name('command'), command);
    this.memory.put(this.error, name('errorinfo'), psNull());
    const record = this.memory.lookup(this.error, name('recordstacks'));
    if (record?.kind === 'boolean' && record.value) {
      this.memory.put(this.error, name('ostack'), this.memory.arrayFrom(this.operands));
      this.memory.put(this.error, name('dstack'), this.memory.arrayFrom(this.dictionaries));
      this.memory.put(this.error, name('estack'), this.memory.arrayFrom(this.executionStack()));
    }
    let offset = this.offset;
    for (let i = this.frames.length - 1; i >= 0; i--) { this.budget.work(); const frame = this.frames[i]!; if (frame.kind === 'handler') { offset = frame.fault.offset ?? offset; break; } }
    this.stop(new PsFault(errorName, offset));
  }
  run(source: Uint8Array): void {
    if (this.running) throw new PsFault('invalidaccess');
    this.running = true;
    this.uncaught = undefined;
    try {
      this.frame({ kind: 'source', scanner: this.scanner(source) });
      while (this.frames.length) {
        this.budget.work(); const frame = this.frames[this.frames.length - 1]!;
        this.budget.allocate(64, 'operand undo buffer');
        this.undo = []; this.undoFloor = this.undoLength = this.operands.length; this.command = psNull();
        let scanning = false;
        try {
          if (frame.kind === 'source') {
            scanning = true; const value = frame.scanner.next(); scanning = false; this.offset = frame.scanner.lastTokenOffset;
            if (!value) this.frames.pop(); else this.dispatch(value, false);
          } else if (frame.kind === 'procedure') {
            this.offset = frame.offset;
            if (frame.index === frame.procedure.length) this.frames.pop();
            else this.dispatch(this.memory.fetch(frame.procedure, frame.index++), false);
          } else if (frame.kind === 'execute') {
            this.frames.pop(); this.offset = frame.offset; this.dispatch(frame.value, frame.indirect);
          } else if (frame.kind === 'loop') {
            if (!frame.step()) this.frames.pop();
          } else if (frame.kind === 'handler') this.frames.pop();
          else { this.frames.pop(); this.push(boolean(false)); }
          this.undo = undefined;
        } catch (caught) {
          rethrowLimit(caught);
          if (!(caught instanceof PsFault)) throw caught;
          if (caught.command) this.command = caught.command;
          if (scanning && frame.kind === 'source') { this.offset = frame.scanner.lastTokenOffset; this.frames.pop(); }
          this.recover(new PsFault(caught.errorName, caught.offset ?? this.offset));
        }
      }
      if (this.uncaught) throw this.uncaught;
    } catch (caught) {
      rethrowLimit(caught);
      if (caught instanceof PsFault) throw new PdfParseError(`PostScript ${caught.errorName}`, caught.offset ?? this.offset);
      throw caught;
    } finally { this.frames.length = 0; this.running = false; this.undo = undefined; }
  }
}
