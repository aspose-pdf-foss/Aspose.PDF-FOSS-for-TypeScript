import { describe, it, expect } from 'vitest';
import { ref, name, isRef, isName, isDict, isStream } from '../src/types.js';

describe('type guards', () => {
  it('identifies refs and names', () => {
    expect(isRef(ref(5, 0))).toBe(true);
    expect(isName(name('Type'))).toBe(true);
    expect(isRef(name('Type'))).toBe(false);
  });
  it('identifies dicts and streams', () => {
    expect(isDict(new Map())).toBe(true);
    expect(isStream({ kind: 'stream', dict: new Map(), raw: new Uint8Array() })).toBe(true);
    expect(isDict([])).toBe(false);
  });
});
