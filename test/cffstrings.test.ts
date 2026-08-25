import { describe, it, expect } from 'vitest';
import { STANDARD_STRINGS, sidToName } from '../src/cffstrings.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('CFF standard strings', () => {
  it('has exactly 391 entries in SID order', () => {
    expect(STANDARD_STRINGS.length).toBe(391);
  });

  it('anchors at the known SIDs', () => {
    expect(STANDARD_STRINGS[0]).toBe('.notdef');
    expect(STANDARD_STRINGS[1]).toBe('space');
    expect(STANDARD_STRINGS[2]).toBe('exclam');
    expect(STANDARD_STRINGS[5]).toBe('dollar');
    expect(STANDARD_STRINGS[8]).toBe('quoteright');
    expect(STANDARD_STRINGS[17]).toBe('zero');
    expect(STANDARD_STRINGS[34]).toBe('A');
    expect(STANDARD_STRINGS[390]).toBe('Semibold');   // the last standard string
  });

  it('has no duplicate names — a duplicate means a transcription slip', () => {
    expect(new Set(STANDARD_STRINGS).size).toBe(391);
  });

  // The count and the endpoints cannot catch a wrong-but-unique name in the
  // middle, which would silently resolve to the wrong GID. These are the
  // documented interior landmarks; together with the count they pin every
  // stretch of the table.
  it('anchors at the interior landmarks the spec fixes', () => {
    expect(STANDARD_STRINGS[59]).toBe('Z');            // end of uppercase
    expect(STANDARD_STRINGS[66]).toBe('a');            // start of lowercase
    expect(STANDARD_STRINGS[91]).toBe('z');            // end of lowercase
    expect(STANDARD_STRINGS[96]).toBe('exclamdown');
    expect(STANDARD_STRINGS[104]).toBe('quotesingle');
    expect(STANDARD_STRINGS[110]).toBe('fl');
    expect(STANDARD_STRINGS[149]).toBe('germandbls');  // end of the Standard set
    expect(STANDARD_STRINGS[170]).toBe('copyright');
    expect(STANDARD_STRINGS[228]).toBe('zcaron');      // end of the ISOAdobe charset
    expect(STANDARD_STRINGS[229]).toBe('exclamsmall'); // start of the Expert set
    expect(STANDARD_STRINGS[378]).toBe('Ydieresissmall'); // end of the Expert set
    expect(STANDARD_STRINGS[379]).toBe('001.000');        // the version strings
    expect(STANDARD_STRINGS[383]).toBe('Black');          // the weight names
    expect(STANDARD_STRINGS[384]).toBe('Bold');
  });

  it('resolves a standard SID without consulting the String INDEX', () => {
    expect(sidToName(1, [])).toBe('space');
  });

  it('resolves SID >= 391 through the String INDEX', () => {
    expect(sidToName(391, [enc('uni4E2D')])).toBe('uni4E2D');
    expect(sidToName(392, [enc('uni4E2D'), enc('g07')])).toBe('g07');
  });

  it('returns undefined for a SID past the String INDEX rather than guessing', () => {
    expect(sidToName(400, [enc('only-one')])).toBeUndefined();
  });
});
