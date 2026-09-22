import { describe, it, expect } from 'vitest';
import {
  encodeFieldLock, readFieldLock, fieldMdpReference, readFieldMdpLock, isLocked, type FieldLock,
} from '../src/siglock.js';
import { isDict, isName, isRef, name, ref, PdfDict, PdfObject } from '../src/types.js';

const ident = (o: PdfObject | undefined) => o ?? null;
const str = (s: string): PdfObject => ({ kind: 'string', bytes: new TextEncoder().encode(s) });
const nameOf = (o: PdfObject | undefined) => (isName(o) ? o.name : undefined);

describe('encodeFieldLock / readFieldLock (puep.4)', () => {
  it('writes /Type /SigFieldLock, /Action, and /Fields only when listing', () => {
    const all = encodeFieldLock({ action: 'all' });
    expect(nameOf(all.get('Type'))).toBe('SigFieldLock');
    expect(nameOf(all.get('Action'))).toBe('All');
    expect(all.has('Fields')).toBe(false);
    const inc = encodeFieldLock({ action: 'include', fields: ['a', 'b.c'] });
    expect(nameOf(inc.get('Action'))).toBe('Include');
    expect(nameOf(encodeFieldLock({ action: 'exclude', fields: ['x'] }).get('Action'))).toBe('Exclude');
  });

  it('round-trips each action', () => {
    const locks: FieldLock[] = [
      { action: 'all' }, { action: 'include', fields: ['a', 'Имя'] }, { action: 'exclude', fields: ['z'] },
    ];
    for (const l of locks) expect(readFieldLock(ident, encodeFieldLock(l))).toEqual(l);
  });

  const bad: Array<[string, unknown, ErrorConstructor]> = [
    ['not an object', 'all', TypeError],
    ['unknown action', { action: 'some' }, RangeError],
    ['include with no list', { action: 'include' }, TypeError],
    ['include with an empty list', { action: 'include', fields: [] }, RangeError],
    ['exclude with an empty name', { action: 'exclude', fields: [''] }, RangeError],
    ['all with a list', { action: 'all', fields: ['a'] }, RangeError],
    ['a non-string name', { action: 'include', fields: [1] }, TypeError],
  ];
  for (const [label, lock, err] of bad)
    it(`refuses: ${label}`, () => expect(() => encodeFieldLock(lock as FieldLock)).toThrow(err));

  it('reads leniently: a bad action or a missing list is no lock', () => {
    const d = (e: Array<[string, PdfObject]>): PdfDict => new Map(e);
    expect(readFieldLock(ident, d([['Action', name('Sometimes')]]))).toBeUndefined();
    expect(readFieldLock(ident, d([['Action', name('Include')]]))).toBeUndefined();
    expect(readFieldLock(ident, d([['Action', name('Include')], ['Fields', [str('a'), 5]]]))).toBeUndefined();
    expect(readFieldLock(ident, 7)).toBeUndefined();
    // /All ignores a stray /Fields rather than failing.
    expect(readFieldLock(ident, d([['Action', name('All')], ['Fields', [str('a')]]]))).toEqual({ action: 'all' });
  });
});

describe('fieldMdpReference (puep.4) — pyHanko\'s fieldmdp_reference_dictionary', () => {
  it('builds the SigRef with /Data pointing at the catalog', () => {
    const r = fieldMdpReference({ action: 'include', fields: ['a'] }, ref(1, 0));
    expect(nameOf(r.get('Type'))).toBe('SigRef');
    expect(nameOf(r.get('TransformMethod'))).toBe('FieldMDP');
    const data = r.get('Data');
    expect(isRef(data) && data.num).toBe(1);
    const tp = r.get('TransformParams');
    expect(isDict(tp)).toBe(true);
    const p = tp as PdfDict;
    expect(nameOf(p.get('Type'))).toBe('TransformParams');
    expect(nameOf(p.get('Action'))).toBe('Include');
    expect(nameOf(p.get('V'))).toBe('1.2');
    expect(p.has('Fields')).toBe(true);
  });

  it('reads the lock back out of a signature\'s /Reference, beside a DocMDP entry', () => {
    const docmdp: PdfDict = new Map<string, PdfObject>([['Type', name('SigRef')], ['TransformMethod', name('DocMDP')]]);
    const lock: FieldLock = { action: 'exclude', fields: ['keep'] };
    const sig: PdfDict = new Map<string, PdfObject>([['Reference', [docmdp, fieldMdpReference(lock, ref(1, 0))]]]);
    expect(readFieldMdpLock(sig, ident)).toEqual(lock);
    expect(readFieldMdpLock(new Map([['Reference', [docmdp]]]), ident)).toBeUndefined();
    expect(readFieldMdpLock(new Map(), ident)).toBeUndefined();
  });
});

describe('isLocked (puep.4) — pyHanko\'s FieldMDPSpec.is_locked', () => {
  it('all locks everything', () => {
    expect(isLocked({ action: 'all' }, 'anything.at.all')).toBe(true);
  });

  it('include locks exactly the listed fields and their subtrees', () => {
    const l: FieldLock = { action: 'include', fields: ['a', 'grp'] };
    expect(isLocked(l, 'a')).toBe(true);
    expect(isLocked(l, 'grp.child')).toBe(true);
    expect(isLocked(l, 'b')).toBe(false);
  });

  it('a name PREFIX is not a subtree: include [a] does not lock ab', () => {
    expect(isLocked({ action: 'include', fields: ['a'] }, 'ab')).toBe(false);
    expect(isLocked({ action: 'include', fields: ['grp'] }, 'grpX.child')).toBe(false);
  });

  it('exclude inverts: everything but the listed fields and their subtrees', () => {
    const l: FieldLock = { action: 'exclude', fields: ['free', 'open'] };
    expect(isLocked(l, 'free')).toBe(false);
    expect(isLocked(l, 'open.inner')).toBe(false);
    expect(isLocked(l, 'other')).toBe(true);
    expect(isLocked(l, 'freedom')).toBe(true);
  });
});
