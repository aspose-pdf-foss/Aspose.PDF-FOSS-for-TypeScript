import { describe, it, expect } from 'vitest';
import {
  STANDARD_STRUCTURE_TYPES, resolveRole, checkStructType,
} from '../src/structtype.js';

const NO_ROLES: ReadonlyMap<string, string> = new Map();

describe('structtype: the standard set', () => {
  it('holds the 49 PDF 1.7 standard structure types', () => {
    expect(STANDARD_STRUCTURE_TYPES.size).toBe(49);
    for (const t of ['Document', 'P', 'H1', 'TD', 'Span', 'Figure', 'Formula'])
      expect(STANDARD_STRUCTURE_TYPES.has(t)).toBe(true);
  });

  it('does not hold a name that merely looks like one', () => {
    expect(STANDARD_STRUCTURE_TYPES.has('H7')).toBe(false);
    expect(STANDARD_STRUCTURE_TYPES.has('Paragraph')).toBe(false);
  });
});

describe('structtype: resolveRole', () => {
  it('returns a standard type unchanged', () => {
    expect(resolveRole('P', NO_ROLES)).toBe('P');
  });

  it('follows a one-hop mapping', () => {
    expect(resolveRole('Subtitle', new Map([['Subtitle', 'P']]))).toBe('P');
  });

  it('follows a chain to the first standard type', () => {
    const rm = new Map([['Deck', 'Subtitle'], ['Subtitle', 'P']]);
    expect(resolveRole('Deck', rm)).toBe('P');
  });

  it('stops on an unmapped name rather than inventing one', () => {
    expect(resolveRole('Nonsense', NO_ROLES)).toBe('Nonsense');
  });

  // A self-referential or mutually-referential /RoleMap is a file we did not
  // write; it must terminate rather than hang.
  it('stops on a cycle', () => {
    expect(resolveRole('A', new Map([['A', 'B'], ['B', 'A']]))).toBe('A');
  });

  // A standard type SHADOWED by a RoleMap entry keeps its own meaning: the walk
  // tests the standard set first, so a file remapping /P cannot make every
  // paragraph in the document resolve somewhere else.
  it('prefers the standard set over a shadowing RoleMap entry', () => {
    expect(resolveRole('P', new Map([['P', 'Span']]))).toBe('P');
  });
});

describe('structtype: checkStructType', () => {
  it('accepts a standard type and returns it unchanged', () => {
    expect(checkStructType('H1', NO_ROLES)).toBe('H1');
  });

  it('accepts a custom type the RoleMap resolves', () => {
    expect(checkStructType('Subtitle', new Map([['Subtitle', 'P']]))).toBe('Subtitle');
  });

  it('rejects an unmapped custom type with a RangeError', () => {
    expect(() => checkStructType('Nonsense', NO_ROLES)).toThrow(RangeError);
    expect(() => checkStructType('Nonsense', NO_ROLES)).toThrow(/RegisterRole/);
  });

  it('rejects a custom type whose chain does not reach a standard type', () => {
    expect(() => checkStructType('Deck', new Map([['Deck', 'Subtitle']]))).toThrow(RangeError);
  });

  // Wrong KIND of thing, not a thing outside the allowed set — formcreate.ts's
  // split. An empty name is not a PDF name at all.
  it('rejects a non-string or empty type with a TypeError', () => {
    expect(() => checkStructType('', NO_ROLES)).toThrow(TypeError);
    expect(() => checkStructType(undefined, NO_ROLES)).toThrow(TypeError);
    expect(() => checkStructType(7 as unknown, NO_ROLES)).toThrow(TypeError);
  });
});
