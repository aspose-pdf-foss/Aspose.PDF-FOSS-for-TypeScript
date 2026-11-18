import type { PsState } from './psstate.js';
import type { PsReader } from './pssource.js';

export type PsAccess = 'unlimited' | 'readonly' | 'executeonly' | 'noaccess';
export interface PsBody { global: boolean; valid: boolean; epoch: number }
export interface PsArrayBody extends PsBody { values: PsValue[]; packed: boolean }
export interface PsStringBody extends PsBody { bytes: Uint8Array }
export interface PsDictionaryBody extends PsBody { entries: [PsValue, PsValue][]; access: PsAccess; capacity: number }
export interface PsGStateBody extends PsBody { state: PsState }
export interface PsFileBody extends PsBody { reader: PsReader; owner: object; roots: readonly PsValue[] }
interface Ref { executable: boolean }
export type PsInteger = Ref & { kind: 'integer'; value: number };
export type PsReal = Ref & { kind: 'real'; value: number };
export type PsBoolean = Ref & { kind: 'boolean'; value: boolean };
export type PsName = Ref & { kind: 'name'; text: string };
export type PsOperator = Ref & { kind: 'operator'; name: string; execute: () => void };
export type PsMark = Ref & { kind: 'mark' };
export type PsNull = Ref & { kind: 'null' };
export type PsArray = Ref & { kind: 'array'; body: PsArrayBody; offset: number; length: number; access: PsAccess };
export type PsString = Ref & { kind: 'string'; body: PsStringBody; offset: number; length: number; access: PsAccess };
export type PsDictionary = Ref & { kind: 'dictionary'; body: PsDictionaryBody };
export type PsComposite = PsArray | PsString | PsDictionary;
export type PsGState = Ref & { kind: 'gstate'; body: PsGStateBody; access: PsAccess };
export type PsFile = Ref & { kind: 'file'; body: PsFileBody; access: PsAccess };
export type PsFontId = Ref & { kind: 'fontid'; body: PsBody; access: PsAccess };
export type PsReference = PsComposite | PsGState | PsFile | PsFontId;
export type PsSave = Ref & { kind: 'save'; id: number };
export type PsValue = PsInteger | PsReal | PsBoolean | PsName | PsOperator | PsMark | PsNull | PsReference | PsSave;
export class PsFault extends Error {
  constructor(readonly errorName: string, readonly offset?: number, readonly command?: PsValue) { super(errorName); this.name = 'PsFault'; }
}
export function integer(value: number): PsInteger {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new PsFault('rangecheck');
  return { kind: 'integer', value, executable: false };
}
export function real(value: number): PsReal {
  if (!Number.isFinite(value)) throw new PsFault('rangecheck');
  return { kind: 'real', value, executable: false };
}
export const boolean = (value: boolean): PsBoolean => ({ kind: 'boolean', value, executable: false });
/** Text is a byte-preserving Latin-1 representation, never UTF-8 decoded. */
export const name = (text: string, executable = false): PsName => ({ kind: 'name', text, executable });
export const operator = (name: string, execute: () => void): PsOperator => ({ kind: 'operator', name, execute, executable: true });
export const mark = (): PsMark => ({ kind: 'mark', executable: false });
export const psNull = (): PsNull => ({ kind: 'null', executable: false });
export function withExecutable<T extends PsValue>(value: T, executable: boolean): T { return { ...value, executable }; }
export function accessOf(value: PsReference): PsAccess { return value.kind === 'dictionary' ? value.body.access : value.access; }
export function canRead(value: PsReference): boolean { return accessOf(value) === 'unlimited' || accessOf(value) === 'readonly'; }
export function canWrite(value: PsReference): boolean { return accessOf(value) === 'unlimited' && !(value.kind === 'array' && value.body.packed); }
export function isComposite(value: PsValue): value is PsComposite { return value.kind === 'array' || value.kind === 'string' || value.kind === 'dictionary'; }
/** Backed objects, including non-indexable graphics states. */
export function isReference(value: PsValue): value is PsReference { return isComposite(value) || value.kind === 'gstate' || value.kind === 'file' || value.kind === 'fontid'; }
/** Supply work when comparing source-controlled bytes/names in a running VM. */
export function psEquals(a: PsValue, b: PsValue, work?: (count: number) => void): boolean {
  if ((a.kind === 'integer' || a.kind === 'real') && (b.kind === 'integer' || b.kind === 'real')) return a.value === b.value;
  if ((a.kind === 'string' && b.kind === 'name') || (a.kind === 'name' && b.kind === 'string')) {
    const string = a.kind === 'string' ? a : b as PsString;
    const text = a.kind === 'name' ? a.text : (b as PsName).text;
    if (!string.body.valid) throw new PsFault('invalidrestore');
    if (!canRead(string)) throw new PsFault('invalidaccess');
    if (string.length !== text.length) return false;
    work?.(string.length);
    for (let i = 0; i < string.length; i++) if (string.body.bytes[string.offset + i] !== text.charCodeAt(i)) return false;
    return true;
  }
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'boolean': return b.kind === 'boolean' && a.value === b.value;
    case 'name':
      if (b.kind !== 'name' || a.text.length !== b.text.length) return false;
      work?.(a.text.length);
      return a.text === b.text;
    case 'string':
      if (b.kind !== 'string') return false;
      if (!a.body.valid || !b.body.valid) throw new PsFault('invalidrestore');
      if (!canRead(a) || !canRead(b)) throw new PsFault('invalidaccess');
      if (a.length !== b.length) return false;
      work?.(a.length);
      for (let i = 0; i < a.length; i++) if (a.body.bytes[a.offset + i] !== b.body.bytes[b.offset + i]) return false;
      return true;
    case 'array': return b.kind === 'array' && a.body === b.body && a.offset === b.offset && a.length === b.length;
    case 'dictionary': return b.kind === 'dictionary' && a.body === b.body;
    case 'gstate': return b.kind === 'gstate' && a.body === b.body;
    case 'file': return b.kind === 'file' && a.body === b.body;
    case 'fontid':
      if (!a.body.valid || b.kind === 'fontid' && !b.body.valid) throw new PsFault('invalidrestore');
      return b.kind === 'fontid' && a.body === b.body;
    case 'operator': return b.kind === 'operator' && a.execute === b.execute;
    case 'save': return b.kind === 'save' && a.id === b.id;
    case 'mark': case 'null': return true;
    default: return false;
  }
}
/** String dictionary keys behave as names; caller validates readability first. */
export function normalizeKey(key: PsValue): PsValue {
  if (key.kind !== 'string') return key;
  let text = ''; for (let i = 0; i < key.length; i++) text += String.fromCharCode(key.body.bytes[key.offset+i]!);
  return name(text);
}
