import type { PsByteInput } from './psinput.js';
import type { LoadLimits } from './loadlimits.js';
import { PdfParseError, rethrowLimit } from './errors.js';
import { PsBudget } from './psbudget.js';
import { PsMemory } from './psmemory.js';
import { PsScanner } from './psscan.js';
import { PsFault, boolean, name, operator, psNull, type PsArray, type PsDictionary, type PsSave, type PsString, type PsValue } from './psvalue.js';
import { installPsCore } from './pscore.js';
import { installPsData } from './psdata.js';
import type { PsFile } from './psvalue.js';

export interface PsInvocation {
  roots: readonly PsValue[];
  complete: () => void;
  /** Allocation-free, nonthrowing cleanup, including during resource exhaustion. */
  unwind: () => void;
}

export interface PsSaveSnapshot {
  visitRoots(visit: (value: PsValue) => void): void;
  /** Activate a prepared boundary after memory save succeeds, without allocation. */
  saved?(): void;
  /** Apply already prepared state without allocating or throwing. */
  restore(): void;
}

export interface PsSaveParticipant {
  /** Prepare and charge a snapshot without mutating participant state. */
  prepareSave(): PsSaveSnapshot;
}

type Frame =
  | { kind: 'source'; scanner: PsScanner; owner?: PsString | PsFile }
  | { kind: 'procedure'; procedure: PsArray; index: number; offset: number }
  | { kind: 'loop'; step: () => boolean; roots: readonly PsValue[] }
  | { kind: 'work'; step: () => boolean; roots: readonly PsValue[] }
  | { kind: 'execute'; value: PsValue; indirect: boolean; offset: number }
  | { kind: 'handler'; fault: PsFault; command: PsValue }
  | { kind: 'invocation'; invocation: PsInvocation; command: PsValue; offset: number }
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
  private started = false;
  private offset = 0;
  private initializing = true;
  private command: PsValue = psNull();
  private undo: { index: number; value: PsValue }[] | undefined;
  private undoFloor = 0;
  private undoLength = 0;
  private readonly saves: { token: PsSave; packing: boolean; snapshots: PsSaveSnapshot[] }[] = [];
  private readonly saveParticipants: PsSaveParticipant[] = [];
  private uncaught: PsFault | undefined;
  private fileSupport?: { open(scanner: PsScanner): PsFile; scanner(file: PsFile): PsScanner };
  installFileSupport(support: { open(scanner: PsScanner): PsFile; scanner(file: PsFile): PsScanner }): void {
    if (this.running || this.fileSupport || this.saves.length) throw new PsFault('invalidaccess');
    this.fileSupport = support;
  }
  get currentFile(): PsFile | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      this.budget.work(); const frame = this.frames[i]!;
      if (frame.kind === 'source' && frame.owner?.kind === 'file') return frame.owner;
    }
    return undefined;
  }
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
  /** Install a fixed library operator before source execution and open saves.
   * Host extensions continue to use registerOperator and ordinary userdict. */
  registerStandardOperator(text: string, execute: (vm: PsInterpreter) => void): void {
    if (this.running || this.saves.length) throw new PsFault('invalidaccess');
    this.budget.allocate(64, 'standard operator');
    this.memory.installSystemOperator(this.memory.name(text), operator(text, () => execute(this)));
  }
  /** Optional feature preflight, before any installation allocates or publishes. */
  assertStandardInstallation(): void { if (this.running || this.started || this.saves.length) throw new PsFault('invalidaccess'); }
  registerStandardValue(text: string, value: PsValue): void {
    if (this.running || this.saves.length) throw new PsFault('invalidaccess');
    this.memory.installSystemValue(this.memory.name(text), value);
  }
  registerStandardBinding(text: string, resolve: () => PsValue, roots: readonly PsValue[]): void {
    if (this.running || this.saves.length) throw new PsFault('invalidaccess');
    this.memory.installSystemBinding(this.memory.name(text), resolve, roots);
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
  /** Restore the exact caller prefix, even if the callback used begin/end or
   * cleardictstack. Cleanup is safe while unwinding an exhausted budget. */
  withDictionaryScope(dictionary: PsDictionary): PsInvocation {
    this.budget.allocate(64 + this.dictionaries.length * 16, 'dictionary scope');
    this.budget.work(this.dictionaries.length, 'dictionary scope');
    const prefix = this.dictionaries.slice();
    this.begin(dictionary);
    const restore = (): void => {
      this.dictionaries.length = prefix.length;
      for (let i = 0; i < prefix.length; i++) this.dictionaries[i] = prefix[i]!;
    };
    return { roots: prefix, complete: restore, unwind: restore };
  }
  scanner(source: Uint8Array | PsByteInput): PsScanner {
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
  /** Schedule a callback with completion and lexical-scope cleanup on the same
   * iterative pump. A returning language error handler stays inside the scope. */
  invoke(value: PsValue, invocation: PsInvocation): void {
    const base = this.frames.length;
    let installed = false;
    let scheduled = false;
    try {
      this.budget.allocate(invocation.roots.length * 16, 'invocation roots');
      this.frame({ kind: 'invocation', invocation, command: this.command, offset: this.offset });
      installed = true;
      this.execute(value);
      scheduled = true;
    } finally {
      if (!scheduled) {
        if (installed) this.unwindTo(base);
        else invocation.unwind();
      }
    }
  }
  /** Cleanup deliberately spends no fuel and allocates no scratch storage. */
  private unwindTo(length: number): void {
    while (this.frames.length > length) {
      const frame = this.frames.pop()!;
      if (frame.kind === 'invocation') frame.invocation.unwind();
    }
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
      if (value.kind === 'file') {
        if (!this.fileSupport) throw new PsFault('invalidaccess');
        this.frame({ kind: 'source', scanner: this.fileSupport.scanner(value), owner: value }); return;
      }
      if (value.kind !== 'null') this.push(value); return;
    }
  }
  scheduleLoop(step: () => boolean, roots: readonly PsValue[]): void {
    this.budget.allocate(roots.length * 16, 'loop roots'); this.frame({ kind: 'loop', step, roots });
  }
  /** Internal continuation work is not a language-level exit target. */
  scheduleWork(step: () => boolean, roots: readonly PsValue[]): void {
    this.budget.allocate(roots.length * 16, 'work roots'); this.frame({ kind: 'work', step, roots });
  }
  scheduleStopped(value: PsValue): void { this.frame({ kind: 'stopped' }); this.execute(value); }
  exit(): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      this.budget.work(); const frame = this.frames[i]!;
      if (frame.kind === 'stopped') break;
      if (frame.kind === 'loop') { this.unwindTo(i); return; }
    }
    throw new PsFault('invalidexit');
  }
  stop(fault?: PsFault): void {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      this.budget.work(); if (this.frames[i]!.kind === 'stopped') { this.unwindTo(i); this.push(boolean(true)); return; }
    }
    if (!fault) for (let i = this.frames.length - 1; i >= 0; i--) { this.budget.work(); const frame = this.frames[i]!; if (frame.kind === 'handler') { fault = frame.fault; break; } }
    this.unwindTo(0); this.uncaught = fault;
  }
  quit(): void { this.unwindTo(0); }
  executionStack(): PsValue[] {
    this.budget.allocate(this.frames.length * 16, 'execution stack view'); this.budget.work(this.frames.length);
    return this.frames.map(frame => frame.kind === 'procedure' ? frame.procedure : frame.kind === 'source' ? frame.owner ?? psNull() : frame.kind === 'execute' ? frame.value : frame.kind === 'handler' ? frame.command : name(`--${frame.kind}--`));
  }
  get executionDepth(): number { return this.frames.length; }
  addSaveParticipant(participant: PsSaveParticipant): void {
    if (this.running || this.saves.length) throw new PsFault('invalidaccess');
    this.budget.items(this.saveParticipants.length + 1);
    this.budget.allocate(16, 'save participant');
    this.saveParticipants.push(participant);
  }
  save(): PsSave {
    this.budget.allocate(32 + this.saveParticipants.length * 16, 'save interpreter state');
    const snapshots: PsSaveSnapshot[] = [];
    for (const participant of this.saveParticipants) {
      this.budget.work();
      snapshots.push(participant.prepareSave());
    }
    const token = this.memory.save();
    this.saves.push({ token, packing: this.packing, snapshots });
    for (const snapshot of snapshots) snapshot.saved?.();
    return token;
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
      else if (frame.kind === 'loop' || frame.kind === 'work') for (const value of frame.roots) add(value);
      else if (frame.kind === 'invocation') for (const value of frame.invocation.roots) add(value);
    }
    this.budget.work(this.saves.length); const index = this.saves.findIndex(save => save.token.id === token.id);
    if (index >= 0) {
      const snapshots = this.saves[index]!.snapshots;
      this.budget.work(snapshots.length, 'save participant restore');
      for (const snapshot of snapshots) snapshot.visitRoots(add);
    }
    this.memory.restore(token, roots);
    if (index >= 0) {
      this.packing = this.saves[index]!.packing;
      for (const snapshot of this.saves[index]!.snapshots) snapshot.restore();
      this.saves.length = index;
    }
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
  run(source: Uint8Array | PsByteInput): void {
    if (this.running) throw new PsFault('invalidaccess');
    this.started = true;
    this.running = true;
    this.uncaught = undefined;
    try {
      const scanner = this.scanner(source);
      this.frame({ kind: 'source', scanner, owner: this.fileSupport?.open(scanner) });
      while (this.frames.length) {
        this.budget.work(); const frame = this.frames[this.frames.length - 1]!;
        this.budget.allocate(64, 'operand undo buffer');
        this.undo = []; this.undoFloor = this.undoLength = this.operands.length; this.command = psNull();
        let scanning = false;
        try {
          if (frame.kind === 'source') {
            scanning = true;
            const value = frame.owner?.kind === 'file' && frame.owner.body.reader.closed ? undefined : frame.scanner.next();
            scanning = false; this.offset = frame.scanner.lastTokenOffset;
            if (!value) {
              this.frames.pop();
              if (frame.owner?.kind === 'file') this.memory.readFile(frame.owner, true).close();
            } else this.dispatch(value, false);
          } else if (frame.kind === 'procedure') {
            this.offset = frame.offset;
            if (frame.index === frame.procedure.length) this.frames.pop();
            else this.dispatch(this.memory.fetch(frame.procedure, frame.index++), false);
          } else if (frame.kind === 'execute') {
            this.frames.pop(); this.offset = frame.offset; this.dispatch(frame.value, frame.indirect);
          } else if (frame.kind === 'loop' || frame.kind === 'work') {
            if (!frame.step()) this.frames.pop();
          } else if (frame.kind === 'invocation') {
            this.frames.pop();
            this.offset = frame.offset;
            this.command = frame.command;
            let completed = false;
            try {
              frame.invocation.complete();
              completed = true;
            } finally {
              if (!completed) frame.invocation.unwind();
            }
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
    } finally { this.unwindTo(0); this.running = false; this.undo = undefined; }
  }
}
