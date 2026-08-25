import { describe, it, expect } from 'vitest';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { readXref } from '../src/xref.js';
import { isRef } from '../src/types.js';

describe('readXref (classic)', () => {
  it('reads entries and trailer Root', () => {
    const pdf = buildClassicPdf(2);
    const { entries, trailer } = readXref(pdf);
    expect(entries.get(1)?.type).toBe('offset');
    const root = trailer.get('Root');
    expect(isRef(root!) && root.num).toBe(1);
    // object 1 offset should point at "1 0 obj"
    const e = entries.get(1)!;
    if (e.type === 'offset') {
      const s = new TextDecoder('latin1').decode(pdf.subarray(e.offset, e.offset + 7));
      expect(s).toBe('1 0 obj');
    }
  });
});
