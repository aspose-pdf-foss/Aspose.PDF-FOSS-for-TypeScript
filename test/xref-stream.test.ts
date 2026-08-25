import { describe, it, expect } from 'vitest';
import { buildXrefStreamPdf } from './helpers/build-pdf.js';
import { readXref } from '../src/xref.js';
import { isRef } from '../src/types.js';

describe('readXref (xref stream)', () => {
  it('parses W-formatted entries and trailer', () => {
    const pdf = buildXrefStreamPdf();
    const { entries, trailer } = readXref(pdf);
    expect(entries.get(3)?.type).toBe('offset');
    const root = trailer.get('Root');
    expect(isRef(root!) && root.num).toBe(1);
    const e = entries.get(1)!;
    if (e.type === 'offset') {
      const s = new TextDecoder('latin1').decode(pdf.subarray(e.offset, e.offset + 7));
      expect(s).toBe('1 0 obj');
    }
  });
});
