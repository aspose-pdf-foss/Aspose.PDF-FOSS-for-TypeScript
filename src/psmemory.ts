import { PsBudget } from './psbudget.js';
import type { PsReader } from './pssource.js';
import type { PsFile, PsFileBody } from './psvalue.js';
import { copyPsState, visitPsStateRoots, type PsState } from './psstate.js';
import {
  PsFault, accessOf, canRead, canWrite, integer, isComposite, isReference, name, normalizeKey,
  psEquals, psNull, type PsAccess, type PsArray, type PsBody, type PsComposite,
  type PsDictionary, type PsGState, type PsReference, type PsName, type PsOperator, type PsSave, type PsString, type PsValue, type PsFontId,
} from './psvalue.js';

type Snapshot = { values: PsValue[] } | { entries: [PsValue, PsValue][]; access: PsAccess; capacity: number } | { state: PsState };
type Level = { token: PsSave; epoch: number; global: boolean; journal: Map<PsBody, Snapshot> };
const rank: Record<PsAccess, number> = { unlimited: 0, readonly: 1, executeonly: 2, noaccess: 3 };
let nextSaveId = 1;

/** All source-controlled composite access, writes and allocation pass here.
 * Bodies are exposed for typed execution/inspection; callers must not mutate
 * their storage or access attributes directly. */
export class PsMemory {
  currentGlobal = false;
  private epoch = 0;
  private bodies: PsBody[] = [];
  private levels: Level[] = [];
  private systemBootstrapped = false;
  private systemDictionary?: PsDictionary;
  private readonly bindings = new Map<string, { resolve: () => PsValue; roots: readonly PsValue[] }>();
  private readonly parents = new WeakMap<PsDictionary['body'], PsDictionary>();
  constructor(readonly budget: PsBudget) {}
  /** Constructor-only systemdict finalization. The language explicitly permits
   * this one global dictionary to hold the fixed local user/error dictionaries.
   * No regular write or source operator uses this exception. */
  bootstrapSystemDictionary(value: PsDictionary): void {
    if (this.systemBootstrapped || this.levels.length || value.body.global) throw new PsFault('invalidaccess');
    this.systemBootstrapped = true; value.body.global = true; value.body.access = 'readonly';
    this.systemDictionary = value;
  }

  /** Fixed host installations can add operator objects to the remembered system
   * dictionary. Source writes still use put and its normal readonly checks. */
  installSystemOperator(key: PsName, value: PsOperator): void {
    this.installSystemValue(key, value);
  }
  installSystemValue(key: PsName, value: PsValue): void {
    this.retained(true, value);
    this.installSystemEntry(key, value);
    this.bindings.delete(key.text);
  }
  installSystemBinding(key: PsName, resolve: () => PsValue, roots: readonly PsValue[]): void {
    if (!this.systemDictionary || this.levels.length) throw new PsFault('invalidaccess');
    for (const value of roots) this.retained(false, value);
    this.budget.allocate(128 + roots.length * 16, 'system binding');
    const binding = { resolve, roots: roots.slice() };
    this.installSystemEntry(key, psNull()); this.bindings.set(key.text, binding);
  }
  private installSystemEntry(key: PsName, value: PsValue): void {
    const dictionary = this.systemDictionary;
    if (!dictionary || this.levels.length) throw new PsFault('invalidaccess');
    const index = this.find(dictionary, key);
    if (index >= 0) dictionary.body.entries[index] = [dictionary.body.entries[index]![0], value];
    else {
      this.budget.items(dictionary.body.entries.length + 1, 'system operators');
      this.budget.allocate(64, 'system operator entry');
      dictionary.body.entries.push([key, value]);
      dictionary.body.capacity = Math.max(dictionary.body.capacity, dictionary.body.entries.length);
    }
  }

  private body<T extends PsBody>(body: T): T { this.bodies.push(body); return body; }
  private identity(): PsBody { return { global: this.currentGlobal, valid: true, epoch: ++this.epoch }; }
  private length(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new PsFault('rangecheck');
    this.budget.items(n);
  }
  array(length: number, executable = false, packed = false): PsArray {
    this.length(length);
    this.budget.allocate(64 + length * 16, 'array'); this.budget.work(length, 'array initialization');
    const values: PsValue[] = new Array<PsValue>(length).fill(psNull());
    const body = this.body({ ...this.identity(), values, packed });
    return { kind: 'array', body, offset: 0, length, access: 'unlimited', executable };
  }
  /** Checked construction, including packed arrays, with shallow value copies. */
  arrayFrom(values: readonly PsValue[], executable = false, packed = false): PsArray {
    this.length(values.length);
    this.budget.work(values.length, 'array initialization');
    for (const value of values) this.retained(this.currentGlobal, value);
    this.budget.allocate(64 + values.length * 16, 'array');
    const body = this.body({ ...this.identity(), values: values.slice(), packed });
    return { kind: 'array', body, offset: 0, length: values.length, access: 'unlimited', executable };
  }
  string(bytesOrLength: Uint8Array | number): PsString {
    const length = typeof bytesOrLength === 'number' ? bytesOrLength : bytesOrLength.length;
    this.length(length); this.budget.allocate(64 + length, 'string'); this.budget.work(length, 'string initialization');
    this.budget.limits.enforce('maxObjectBytes', length, 'PostScript string');
    const bytes = typeof bytesOrLength === 'number' ? new Uint8Array(length) : new Uint8Array(bytesOrLength);
    const body = this.body({ ...this.identity(), bytes });
    return { kind: 'string', body, offset: 0, length, access: 'unlimited', executable: false };
  }
  dictionary(capacity = 0): PsDictionary {
    this.length(capacity); this.budget.allocate(64 + capacity * 64, 'dictionary');
    const body = this.body({ ...this.identity(), entries: [] as [PsValue, PsValue][], access: 'unlimited' as PsAccess, capacity });
    return { kind: 'dictionary', body, executable: false };
  }
  fontId(): PsFontId {
    this.budget.allocate(64, 'font identity');
    return { kind: 'fontid', body: this.body(this.identity()), access: 'readonly', executable: false };
  }
  readonlyRegistry(parent?: PsDictionary): {
    dictionary: PsDictionary; put(key: PsValue, value: PsValue): void; remove(key: PsValue): void;
  } {
    if (parent) { this.read(parent); this.retained(this.currentGlobal, parent); }
    const dictionary = this.dictionary(); dictionary.body.access = 'readonly';
    if (parent) this.parents.set(dictionary.body, parent);
    return { dictionary,
      put: (key, value) => { this.valid(dictionary); this.putDictionary(dictionary, key, value); },
      remove: key => { this.valid(dictionary); this.removeDictionary(dictionary, key); },
    };
  }
  name(text: string, executable = false): PsName {
    this.budget.allocate(64 + text.length * 2, 'name');
    return name(text, executable);
  }
  gstate(state: PsState): PsGState {
    visitPsStateRoots(state, value => this.retained(this.currentGlobal, value));
    const copy = copyPsState(state, this.budget);
    this.budget.allocate(64, 'gstate body');
    const body = this.body({ ...this.identity(), state: copy });
    return { kind: 'gstate', body, access: 'unlimited', executable: false };
  }
  file(reader: PsReader, roots: readonly PsValue[] = []): PsFile {
    this.budget.allocate(96 + roots.length * 16, 'file body');
    for (const value of roots) this.retained(this.currentGlobal, value);
    const body = this.body({ ...this.identity(), reader, owner: this, roots: roots.slice() });
    return { kind: 'file', body, access: 'readonly', executable: false };
  }
  readFile(value: PsFile, execute = false): PsReader {
    if (value.body.owner !== this) throw new PsFault('invalidaccess');
    if (execute) { this.valid(value); if (accessOf(value) === 'noaccess') throw new PsFault('invalidaccess'); }
    else this.read(value);
    return value.body.reader;
  }
  checkWritableString(value: PsString): void { this.write(value); }
  readGState(value: PsGState): PsState {
    this.read(value);
    return value.body.state;
  }
  writeGState(value: PsGState, state: PsState): void {
    this.write(value);
    visitPsStateRoots(state, item => this.retained(value.body.global, item));
    const copy = copyPsState(state, this.budget);
    this.journal(value);
    value.body.state = copy;
  }
  private valid(value: PsReference): void { if (!value.body.valid) throw new PsFault('invalidrestore'); }
  private read(value: PsReference): void { this.valid(value); if (!canRead(value)) throw new PsFault('invalidaccess'); }
  private write(value: PsReference): void { this.valid(value); if (!canWrite(value)) throw new PsFault('invalidaccess'); }
  private execute(value: PsArray | PsString): void {
    this.valid(value); if (accessOf(value) === 'noaccess') throw new PsFault('invalidaccess');
  }
  /** Check even empty procedures, for which there is no first instruction. */
  checkExecutable(value: PsArray | PsString): void { this.execute(value); }
  private retained(global: boolean, value: PsValue): void {
    if (value.kind === 'save') {
      this.budget.work(this.levels.length, 'save value');
      if (!this.levels.some(level => level.token.id === value.id)) throw new PsFault('invalidrestore');
      if (global) throw new PsFault('invalidaccess');
    }
    if (!isReference(value)) return;
    this.valid(value);
    if (global && !value.body.global) throw new PsFault('invalidaccess');
  }
  private index(value: PsArray | PsString, key: number | PsValue): number {
    const n = typeof key === 'number' ? key : key.kind === 'integer' ? key.value : NaN;
    if (!Number.isInteger(n)) throw new PsFault('typecheck');
    if (n < 0 || n >= value.length) throw new PsFault('rangecheck');
    return n;
  }
  private key(key: number | PsValue): PsValue {
    if (typeof key === 'number' || key.kind === 'null') throw new PsFault('typecheck');
    if (isReference(key)) this.valid(key);
    if (key.kind === 'string') {
      this.read(key); this.budget.work(key.length, 'string key');
      this.budget.allocate(64 + key.length * 2, 'string key name');
    }
    return normalizeKey(key);
  }
  private find(value: PsDictionary, key: PsValue): number {
    for (let i = 0; i < value.body.entries.length; i++) {
      this.budget.work();
      if (psEquals(value.body.entries[i]![0], key, count => this.budget.work(count, 'dictionary key comparison'))) return i;
    }
    return -1;
  }
  private journal(value: PsArray | PsDictionary | PsGState): void {
    if (value.body.global) return;
    for (const level of this.levels) {
      this.budget.work();
      if (value.body.epoch > level.epoch || level.journal.has(value.body)) continue;
      if (value.kind === 'gstate') {
        level.journal.set(value.body, { state: copyPsState(value.body.state, this.budget) });
        continue;
      }
      const length = value.kind === 'array' ? value.body.values.length : value.body.entries.length;
      this.budget.allocate(64 + length * (value.kind === 'array' ? 16 : 64), 'save journal');
      this.budget.work(length, 'save journal');
      level.journal.set(value.body, value.kind === 'array'
        ? { values: value.body.values.slice() }
        : { entries: value.body.entries.map(([key, item]) => [key, item]), access: value.body.access, capacity: value.body.capacity });
    }
  }
  get(value: PsComposite, key: number | PsValue): PsValue {
    this.read(value);
    if (value.kind === 'dictionary') {
      const found = this.lookup(value, this.key(key));
      if (found === undefined) throw new PsFault('undefined');
      return found;
    }
    const index = this.index(value, key) + value.offset;
    return value.kind === 'array' ? value.body.values[index]! : integer(value.body.bytes[index]!);
  }
  /** VM instruction fetch; executeonly objects remain executable. */
  fetch(value: PsArray | PsString, index: number): PsValue {
    this.execute(value); const offset = this.index(value, index) + value.offset;
    return value.kind === 'array' ? value.body.values[offset]! : integer(value.body.bytes[offset]!);
  }
  /** bind alone may inspect and replace packed instructions despite access.
   * Ordinary arrays still follow their reference permissions. */
  bindFetch(value: PsArray, index: number): PsValue {
    this.valid(value);
    if (!value.body.packed) this.read(value);
    this.budget.work(); return value.body.values[value.offset + this.index(value, index)]!;
  }
  bindReplace(value: PsArray, index: number, replacement: PsValue): void {
    this.valid(value);
    if (!value.body.packed) this.write(value);
    if (replacement.kind !== 'operator' && replacement.kind !== 'array') throw new PsFault('typecheck');
    const target = value.offset + this.index(value, index);
    this.retained(value.body.global, replacement); this.journal(value); this.budget.work();
    value.body.values[target] = replacement;
  }
  /** Shared byte view for lazy execution. The caller must retain the original
   * string reference among restore roots while the scanner is active. */
  executionBytes(value: PsString): Uint8Array {
    this.execute(value); this.budget.allocate(64, 'execution byte view');
    return value.body.bytes.subarray(value.offset, value.offset + value.length);
  }
  lookup(value: PsDictionary, key: PsValue): PsValue | undefined {
    const normalized = this.key(key);
    let current: PsDictionary | undefined = value, depth = 0;
    while (current) {
      this.read(current);
      const index = this.find(current, normalized);
      if (index >= 0) return this.bindingValue(current, current.body.entries[index]!);
      current = this.parents.get(current.body);
      if (current) this.budget.depth(++depth, 'dictionary overlay');
    }
    return undefined;
  }
  private bindingValue(dictionary: PsDictionary, pair: [PsValue, PsValue]): PsValue {
    const key = pair[0];
    if (dictionary.body === this.systemDictionary?.body && key.kind === 'name') {
      const binding = this.bindings.get(key.text);
      if (binding) { this.budget.work(1, 'system binding'); const value = binding.resolve(); this.retained(false, value); return value; }
    }
    return pair[1];
  }
  dictionarySize(value: PsDictionary): number {
    this.read(value);
    return this.parents.has(value.body) ? this.entries(value).length : value.body.entries.length;
  }
  entries(value: PsDictionary): [PsValue, PsValue][] {
    this.read(value);
    if (!this.parents.has(value.body)) {
      this.budget.allocate(value.body.entries.length * 64, 'dictionary entries');
      this.budget.work(value.body.entries.length, 'dictionary entries');
      return value.body.entries.map(pair => [pair[0], this.bindingValue(value, pair)]);
    }
    const result: [PsValue, PsValue][] = [];
    let current: PsDictionary | undefined = value, depth = 0;
    while (current) {
      this.read(current);
      for (const pair of current.body.entries) {
        this.budget.work(1, 'dictionary overlay entries');
        let shadowed = false;
        for (const entry of result) {
          this.budget.work(1, 'dictionary overlay comparison');
          if (psEquals(entry[0], pair[0], n => this.budget.work(n))) { shadowed = true; break; }
        }
        if (!shadowed) {
          this.budget.items(result.length + 1); this.budget.allocate(64, 'dictionary overlay entry');
          result.push([pair[0], this.bindingValue(current, pair)]);
        }
      }
      current = this.parents.get(current.body);
      if (current) this.budget.depth(++depth, 'dictionary overlay');
    }
    return result;
  }
  put(target: PsComposite, key: number | PsValue, value: PsValue): void {
    this.write(target);
    if (target.kind === 'dictionary') {
      this.putDictionary(target, key, value); return;
    }
    const index = this.index(target, key) + target.offset;
    if (target.kind === 'string') {
      if (value.kind !== 'integer') throw new PsFault('typecheck');
      if (!Number.isInteger(value.value) || value.value < 0 || value.value > 255) throw new PsFault('rangecheck');
      target.body.bytes[index] = value.value;
      return;
    }
    this.retained(target.body.global, value); this.journal(target);
    target.body.values[index] = value;
  }
  private putDictionary(target: PsDictionary, key: number | PsValue, value: PsValue): void {
    const normalized = this.key(key);
    this.retained(target.body.global, normalized); this.retained(target.body.global, value);
    const index = this.find(target, normalized);
    if (index < 0) {
      this.budget.items(target.body.entries.length + 1);
      if (target.body.entries.length >= target.body.capacity) this.budget.allocate(64, 'dictionary entry');
    }
    this.journal(target);
    if (index < 0) {
      target.body.entries.push([normalized, value]);
      target.body.capacity = Math.max(target.body.capacity, target.body.entries.length);
    } else target.body.entries[index] = [target.body.entries[index]![0], value];
  }
  /** Implements undef; absence is harmless, access and journaling still apply. */
  remove(target: PsDictionary, key: PsValue): void {
    this.write(target); this.removeDictionary(target, key);
  }
  private removeDictionary(target: PsDictionary, key: PsValue): void {
    const index = this.find(target, this.key(key));
    if (index < 0) return;
    this.budget.work(target.body.entries.length - index, 'dictionary removal');
    this.journal(target); target.body.entries.splice(index, 1);
  }
  interval<T extends PsArray | PsString>(value: T, start: number, length: number): T {
    this.read(value);
    if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || length < 0 || start + length > value.length) throw new PsFault('rangecheck');
    return { ...value, offset: value.offset + start, length };
  }
  copy<T extends PsComposite>(source: T, target: T): T {
    this.read(source); this.write(target);
    if (source.kind !== target.kind) throw new PsFault('typecheck');
    if (source.kind === 'dictionary' && target.kind === 'dictionary') {
      // Snapshot first so aliasing and self-copy do not change iteration.
      for (const [key, value] of this.entries(source)) this.put(target, key, value);
      return target as T;
    }
    if (source.kind === 'dictionary' || target.kind === 'dictionary') throw new PsFault('typecheck');
    if (source.length > target.length) throw new PsFault('rangecheck');
    this.budget.work(source.length, 'copy');
    this.budget.allocate(source.length * (source.kind === 'array' ? 16 : 1), 'copy');
    if (source.kind === 'array' && target.kind === 'array') {
      const values = source.body.values.slice(source.offset, source.offset + source.length);
      for (const value of values) this.retained(target.body.global, value);
      this.journal(target);
      for (let i = 0; i < values.length; i++) target.body.values[target.offset + i] = values[i]!;
    } else if (source.kind === 'string' && target.kind === 'string') {
      target.body.bytes.set(source.body.bytes.slice(source.offset, source.offset + source.length), target.offset);
    }
    // Preserve the destination's reference attributes.
    return { ...target, length: source.length };
  }
  restrictAccess<T extends PsReference>(value: T, access: PsAccess): T {
    this.valid(value);
    if ((value.kind === 'dictionary' || value.kind === 'gstate' || value.kind === 'fontid') && access === 'executeonly') throw new PsFault('typecheck');
    if (rank[access] < rank[accessOf(value)]) throw new PsFault('invalidaccess');
    if (value.kind === 'dictionary') { this.journal(value); value.body.access = access; return value; }
    return { ...value, access };
  }
  save(): PsSave {
    this.budget.depth(this.levels.length + 1); this.budget.allocate(64, 'save');
    const token: PsSave = { kind: 'save', id: nextSaveId++, executable: false };
    this.levels.push({ token, epoch: this.epoch, global: this.currentGlobal, journal: new Map() });
    return token;
  }
  restore(token: PsSave, roots: readonly PsValue[]): void {
    this.budget.work(this.levels.length, 'restore save lookup');
    const index = this.levels.findIndex(level => level.token.id === token.id);
    if (index < 0) throw new PsFault('invalidrestore');
    const level = this.levels[index]!;
    this.budget.allocate(roots.length * 16, 'restore roots'); this.budget.work(roots.length, 'restore roots');
    const seen = new Set<PsBody>(); const pending = [...roots];
    const push = (value: PsValue): void => { this.budget.allocate(16, 'restore pending'); pending.push(value); };
    while (pending.length) {
      this.budget.work(); const value = pending.pop()!;
      if (value.kind === 'save') {
        this.budget.work(this.levels.length, 'restore save root');
        const rootIndex = this.levels.findIndex(saved => saved.token.id === value.id);
        if (rootIndex < 0 || rootIndex > index) throw new PsFault('invalidrestore');
      }
      if (!isReference(value)) continue;
      // File references remain usable as closed files after restore. Unlike
      // arrays/strings they do not make the restore invalid.
      if (value.kind === 'file') continue;
      if (!value.body.valid || (!value.body.global && value.body.epoch > level.epoch)) throw new PsFault('invalidrestore');
      if (seen.has(value.body)) continue;
      this.budget.allocate(64, 'restore visited body'); seen.add(value.body);
      // Check the final graph. New children of an old local body disappear
      // when that body's journal is restored and must not prevent restore.
      const snapshot = level.journal.get(value.body);
      if (value.kind === 'array') {
        const values = snapshot && 'values' in snapshot ? snapshot.values : value.body.values;
        for (const item of values) push(item);
      } else if (value.kind === 'dictionary') {
        const parent = this.parents.get(value.body); if (parent) push(parent);
        if (value.body === this.systemDictionary?.body) for (const binding of this.bindings.values())
          for (const root of binding.roots) push(root);
        const entries = snapshot && 'entries' in snapshot ? snapshot.entries : value.body.entries;
        for (const [key, item] of entries) { push(key); push(item); }
      } else if (value.kind === 'gstate') {
        const state = snapshot && 'state' in snapshot ? snapshot.state : value.body.state;
        visitPsStateRoots(state, push);
      }
    }
    // All validation and proportional charges precede the first VM mutation.
    this.budget.work(this.bodies.length + level.journal.size, 'restore bodies');
    for (const [body, snapshot] of level.journal) {
      if ('values' in snapshot) (body as PsArray['body']).values = snapshot.values;
      else if ('state' in snapshot) (body as PsGState['body']).state = snapshot.state;
      else {
        const dictionary = body as PsDictionary['body'];
        dictionary.entries = snapshot.entries; dictionary.access = snapshot.access; dictionary.capacity = snapshot.capacity;
      }
    }
    for (const body of this.bodies) if (!body.global && body.epoch > level.epoch) {
      if ('reader' in body) (body as PsFileBody).reader.close();
      else body.valid = false;
    }
    this.levels.length = index; this.currentGlobal = level.global;
  }
}
