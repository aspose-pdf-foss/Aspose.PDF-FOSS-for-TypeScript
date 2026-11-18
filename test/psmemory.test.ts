import { describe, it, expect } from 'vitest';
import { PsMemory } from '../src/psmemory.js';
import { PsBudget } from '../src/psbudget.js';
import { integer, real, name } from '../src/psvalue.js';
import { LoadLimits } from '../src/loadlimits.js';
describe('PostScript memory', () => {
  it('shares intervals and copies overlapping arrays safely', () => {
    const m = new PsMemory(new PsBudget()); const a = m.array(4);
    for (let i=0;i<4;i++) m.put(a, i, integer(i));
    const v = m.interval(a, 1, 3); m.put(v, 0, integer(9));
    expect(m.get(a, 1)).toEqual(integer(9));
    m.copy(m.interval(a, 0, 3), v);
    expect([0,1,2,3].map(i => m.get(a,i))).toEqual([0,0,9,2].map(integer));
  });
  it('normalizes numeric and string dictionary keys', () => {
    const m = new PsMemory(new PsBudget()); const d = m.dictionary();
    m.put(d, integer(1), integer(3)); expect(m.lookup(d, real(1))).toEqual(integer(3));
    m.put(d, m.string(new Uint8Array([97])), integer(4)); expect(m.lookup(d, name('a'))).toEqual(integer(4));
  });
  it('enforces reference access, dictionary body access and packed writes', () => {
    const m = new PsMemory(new PsBudget()); const a = m.array(1); const ro = m.restrictAccess(a, 'readonly');
    expect(() => m.put(ro, 0, integer(1))).toThrowError(expect.objectContaining({errorName:'invalidaccess'}));
    m.put(a, 0, integer(1));
    const d = m.dictionary(); m.restrictAccess(d, 'readonly');
    expect(() => m.put(d, name('x'), integer(1))).toThrowError(expect.objectContaining({errorName:'invalidaccess'}));
    expect(() => m.put(m.array(1, false, true), 0, integer(1))).toThrowError(expect.objectContaining({errorName:'invalidaccess'}));
  });
  it('restores nested local changes, preserves strings and globals, and rejects live new roots', () => {
    const m = new PsMemory(new PsBudget()); const a = m.array(1); const s = m.string(1);
    m.put(a,0,integer(1)); const save = m.save(); m.put(a,0,integer(2));
    const inner = m.save(); m.put(a,0,integer(3)); m.restore(inner, []); expect(m.get(a,0)).toEqual(integer(2));
    m.put(s,0,integer(65)); m.currentGlobal = true; const g = m.array(1); m.put(g,0,integer(7)); m.currentGlobal = false;
    const fresh = m.array(1); m.put(fresh,0,fresh);
    expect(() => m.restore(save, [fresh])).toThrowError(expect.objectContaining({errorName:'invalidrestore'}));
    m.restore(save, []); expect(m.get(a,0)).toEqual(integer(1)); expect(m.get(s,0)).toEqual(integer(65)); expect(m.get(g,0)).toEqual(integer(7));
  });
  it('refuses allocation before constructing huge arrays', () => {
    const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({maxPostScriptVmBytes: 64, maxContainerItems: null})));
    expect(() => m.array(1_000_000_000)).toThrowError(expect.objectContaining({limit:'maxPostScriptVmBytes'}));
  });
});

describe('PostScript restore and access boundaries', () => {
  it('restores dictionary access and rejects global references to local composites', () => {
    const m = new PsMemory(new PsBudget()); const d = m.dictionary(); const s = m.save();
    m.restrictAccess(d, 'readonly'); m.restore(s, []); m.put(d, name('x'), integer(1));
    const local = m.array(1); m.currentGlobal = true; const global = m.array(1);
    expect(() => m.put(global, 0, local)).toThrowError(expect.objectContaining({errorName:'invalidaccess'}));
  });
  it('terminates while checking cyclic old roots', () => {
    const m = new PsMemory(new PsBudget()); const a = m.array(1); m.put(a,0,a);
    const s = m.save(); m.restore(s, [a]); expect(m.get(a,0)).toBe(a);
  });
});

// These cases catch memory barriers that were absent in the recovered implementation.
describe('PostScript memory barriers and accounting', () => {
  it('requires read access to extract an interval', () => {
    const m = new PsMemory(new PsBudget());
    for (const value of [m.array(1), m.string(1)]) {
      expect(() => m.interval(m.restrictAccess(value, 'noaccess'), 0, 1))
        .toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
    }
  });

  it('validates restore using the final old contents, without mutating on failure', () => {
    const m = new PsMemory(new PsBudget()); const a = m.array(1); const d = m.dictionary();
    m.put(a, 0, integer(1)); m.put(d, name('x'), integer(2));
    const token = m.save(); const fresh = m.array(1);
    m.put(a, 0, fresh); m.put(d, name('x'), fresh);
    expect(() => m.restore(token, [a, d, fresh]))
      .toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
    expect(m.get(a, 0)).toBe(fresh);
    m.restore(token, [a, d]);
    expect(m.get(a, 0)).toEqual(integer(1)); expect(m.get(d, name('x'))).toEqual(integer(2));
    expect(() => m.get(fresh, 0)).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
  });

  it('rejects storing discarded array and dictionary keys or values', () => {
    const m = new PsMemory(new PsBudget()); const a = m.array(1); const d = m.dictionary();
    const token = m.save(); const discarded = m.array(0); m.restore(token, []);
    expect(() => m.put(a, 0, discarded)).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
    expect(() => m.put(d, discarded, integer(1))).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
    expect(() => m.put(d, name('x'), discarded)).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
  });

  it('charges journal copies before changing the target', () => {
    const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 2 })));
    const a = m.array(2); m.put(a, 0, integer(1)); m.save();
    expect(() => m.put(a, 0, integer(9))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
    expect(m.get(a, 0)).toEqual(integer(1));
  });

  it('charges dictionary enumeration work before making its copy', () => {
    const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 2 })));
    const d = m.dictionary(); m.put(d, name('a'), integer(1)); m.put(d, name('b'), integer(2));
    expect(() => m.entries(d)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
  });

  it('charges name creation while normalizing string keys before insertion', () => {
    const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 193 })));
    const d = m.dictionary(1); const key = m.string(new Uint8Array([97]));
    expect(() => m.put(d, key, integer(1))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
    expect(m.lookup(d, name('a'))).toBeUndefined();
  });

  it('charges restore scratch storage before traversing roots', () => {
    const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 128 })));
    const a = m.array(0); const token = m.save();
    expect(() => m.restore(token, [a])).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
    expect(a.body.valid).toBe(true);
  });

  it('constructs packed arrays through a checked initializer and refuses local children in globals', () => {
    const m = new PsMemory(new PsBudget()); const local = m.array(0);
    const packed = m.arrayFrom([integer(3), integer(4)], true, true);
    expect(m.get(packed, 1)).toEqual(integer(4));
    expect(() => m.put(packed, 0, integer(1))).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
    m.currentGlobal = true;
    expect(() => m.arrayFrom([local])).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
  });

  it('copies dictionaries and journals removal through the same memory barrier', () => {
    const m = new PsMemory(new PsBudget()); const source = m.dictionary(); const target = m.dictionary();
    m.put(source, name('x'), integer(7)); m.put(target, name('y'), integer(8));
    expect(m.copy(source, target)).toBe(target);
    expect(m.get(target, name('x'))).toEqual(integer(7)); expect(m.get(target, name('y'))).toEqual(integer(8));
    const token = m.save(); m.remove(target, name('x')); expect(m.lookup(target, name('x'))).toBeUndefined();
    m.restore(token, [target]); expect(m.get(target, name('x'))).toEqual(integer(7));
  });
});

it('rejects live newer or invalidated save objects before changing VM', () => {
  const m = new PsMemory(new PsBudget()); const a = m.array(1); const outer = m.save();
  m.put(a, 0, integer(8)); const inner = m.save();
  expect(() => m.restore(outer, [inner])).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
  expect(m.get(a, 0)).toEqual(integer(8));
  m.restore(inner, []);
  expect(() => m.restore(outer, [inner])).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
  m.restore(outer, []); expect(m.get(a, 0)).toMatchObject({ kind: 'null' });
});

it('meters comparisons of long dictionary names', () => {
  const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptOperations: 3 })));
  const d = m.dictionary(); m.put(d, name('abc'), integer(1));
  expect(() => m.lookup(d, name('abd'))).toThrowError(expect.objectContaining({ limit: 'maxPostScriptOperations' }));
});


it('rejects executeonly dictionaries', () => {
  const m = new PsMemory(new PsBudget()); const d = m.dictionary();
  expect(() => m.restrictAccess(d, 'executeonly')).toThrowError(expect.objectContaining({ errorName: 'typecheck' }));
});

it('keeps save objects local even when current allocation mode is global', () => {
  const m = new PsMemory(new PsBudget()); m.currentGlobal = true;
  const token = m.save(); const a = m.array(1); const d = m.dictionary();
  expect(() => m.put(a, 0, token)).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
  expect(() => m.put(d, token, integer(1))).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
  expect(() => m.put(d, name('s'), token)).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
});


it('applies exact array allocation and container/depth boundaries', () => {
  const exact = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 80 })));
  expect(exact.array(1).length).toBe(1);
  const short = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 79 })));
  expect(() => short.array(1)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', allowed: 79, reached: 80 }));
  const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxContainerItems: 2, maxNestingDepth: 2 })));
  m.array(2); m.string(2); m.dictionary(2);
  for (const create of [() => m.array(3), () => m.string(3), () => m.dictionary(3)]) {
    expect(create).toThrowError(expect.objectContaining({ limit: 'maxContainerItems', allowed: 2, reached: 3 }));
  }
  m.save(); m.save();
  expect(() => m.save()).toThrowError(expect.objectContaining({ limit: 'maxNestingDepth', allowed: 2, reached: 3 }));
});

it('refuses large string and dictionary allocation before constructing storage', () => {
  const m = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 64, maxContainerItems: null })));
  expect(() => m.string(1_000_000_000)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
  expect(() => m.dictionary(1_000_000_000)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes' }));
});

it('keeps string intervals shared, copies overlapping bytes safely, and normalizes keys independently of later mutation', () => {
  const m = new PsMemory(new PsBudget()); const s = m.string(new Uint8Array([97, 98, 99, 100]));
  const view = m.interval(s, 1, 3); m.put(view, 0, integer(255));
  m.copy(m.interval(s, 0, 3), view);
  expect([0, 1, 2, 3].map(i => m.get(s, i))).toEqual([integer(97), integer(97), integer(255), integer(99)]);
  const d = m.dictionary(); const key = m.string(new Uint8Array([0, 255]));
  m.put(d, key, integer(5)); m.put(key, 0, integer(1));
  expect(m.get(d, name('\u0000\u00ff'))).toEqual(integer(5));
  expect(m.lookup(d, name('\u0001\u00ff'))).toBeUndefined();
});

it('preserves global dictionary mutations and allocation mode through local restore', () => {
  const m = new PsMemory(new PsBudget()); m.currentGlobal = true; const d = m.dictionary();
  m.put(d, name('x'), integer(1)); const token = m.save(); m.currentGlobal = false;
  m.put(d, name('x'), integer(2)); m.restore(token, [d, token]);
  expect(m.currentGlobal).toBe(true); expect(m.get(d, name('x'))).toEqual(integer(2));
});

it('allows execution fetches through executeonly views while refusing normal reads and noaccess execution', () => {
  const m = new PsMemory(new PsBudget()); const a = m.arrayFrom([integer(7)], true);
  const s = m.string(new Uint8Array([65]));
  const procedure = m.restrictAccess(a, 'executeonly'); const source = m.restrictAccess(s, 'executeonly');
  expect(m.fetch(procedure, 0)).toEqual(integer(7)); expect(m.fetch(source, 0)).toEqual(integer(65));
  expect(() => m.get(procedure, 0)).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
  expect(() => m.get(source, 0)).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
  const bytes = m.executionBytes(source); m.put(s, 0, integer(66)); expect(bytes[0]).toBe(66);
  expect(() => m.fetch(m.restrictAccess(a, 'noaccess'), 0)).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
  expect(() => m.executionBytes(m.restrictAccess(s, 'noaccess'))).toThrowError(expect.objectContaining({ errorName: 'invalidaccess' }));
});

it('charges execution views and refuses views of restored-away strings', () => {
  const bounded = new PsMemory(new PsBudget(LoadLimits.defaults.with({ maxPostScriptVmBytes: 128 })));
  const source = bounded.string(1);
  expect(() => bounded.executionBytes(source)).toThrowError(expect.objectContaining({ limit: 'maxPostScriptVmBytes', allowed: 128, reached: 129 }));
  const m = new PsMemory(new PsBudget()); const token = m.save(); const discarded = m.string(1);
  m.restore(token, []);
  expect(() => m.executionBytes(discarded)).toThrowError(expect.objectContaining({ errorName: 'invalidrestore' }));
});
