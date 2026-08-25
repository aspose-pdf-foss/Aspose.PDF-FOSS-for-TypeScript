import { describe, it, expect } from 'vitest';
import {
  FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB,
  FF_RADIO, FF_PUSHBUTTON, FF_COMBO, FF_EDIT, FF_MULTISELECT,
  FF_FILESELECT, FF_RICHTEXT, FF_DONOTSPELLCHECK, FF_DONOTSCROLL,
} from '../src/fieldflags.js';

// PDF 32000-1 tables 226 (common), 228 (text), 229 (button), 230 (choice).
// Spec bit N has value 2^(N-1); these are those values written out.
describe('field flag bits', () => {
  it('matches the specification tables', () => {
    expect(FF_READONLY).toBe(1);            // bit 1
    expect(FF_REQUIRED).toBe(2);            // bit 2
    expect(FF_MULTILINE).toBe(4096);        // bit 13
    expect(FF_PASSWORD).toBe(8192);         // bit 14
    expect(FF_RADIO).toBe(32768);           // bit 16
    expect(FF_PUSHBUTTON).toBe(65536);      // bit 17
    expect(FF_COMBO).toBe(131072);          // bit 18
    expect(FF_EDIT).toBe(262144);           // bit 19
    expect(FF_MULTISELECT).toBe(2097152);   // bit 22
    expect(FF_FILESELECT).toBe(1048576);    // bit 21
    expect(FF_DONOTSPELLCHECK).toBe(4194304); // bit 23
    expect(FF_DONOTSCROLL).toBe(8388608);   // bit 24
    expect(FF_COMB).toBe(16777216);         // bit 25
    expect(FF_RICHTEXT).toBe(33554432);     // bit 26
  });

  it('gives every flag a distinct bit', () => {
    const all = [
      FF_READONLY, FF_REQUIRED, FF_MULTILINE, FF_PASSWORD, FF_COMB,
      FF_RADIO, FF_PUSHBUTTON, FF_COMBO, FF_EDIT, FF_MULTISELECT,
      FF_FILESELECT, FF_RICHTEXT, FF_DONOTSPELLCHECK, FF_DONOTSCROLL,
    ];
    expect(new Set(all).size).toBe(all.length);
    for (const f of all) expect(f & (f - 1)).toBe(0); // exactly one bit set
  });
});
