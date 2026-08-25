import { describe, it, expect } from 'vitest';
import { sweepObjects } from '../src/recover.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('sweepObjects', () => {
  it('finds a header at offset 0', () => {
    const { candidates } = sweepObjects(enc('1 0 obj\n<< >>\nendobj\n'));
    expect(candidates.get(1)).toEqual([{ offset: 0, gen: 0 }]);
  });

  it('finds headers after CRLF and after a bare CR', () => {
    const { candidates } = sweepObjects(enc('%PDF\r\n7 0 obj\nx\rendobj\r12 3 obj\n'));
    expect(candidates.get(7)?.[0].gen).toBe(0);
    expect(candidates.get(12)?.[0].gen).toBe(3);
  });

  it('rejects an obj-shaped run whose number is not preceded by whitespace', () => {
    // Glued to a delimiter, as it would be inside stream data: not a header.
    const { candidates } = sweepObjects(enc('stream\n<< /L 5 >>7 0 obj\nendstream'));
    expect(candidates.size).toBe(0);
  });

  it('merges an adjacent digit run into one object number', () => {
    // A known limit of a byte sweep: digits cannot be "glued" to digits, so
    // `1234599 0 obj` in stream data reads as a header for object 1234599.
    // Harmless — the bogus object fails to parse and lands in RecoveryReport.lost.
    const { candidates } = sweepObjects(enc('stream\n1234599 0 obj\nendstream'));
    expect([...candidates.keys()]).toEqual([1234599]);
  });

  it('rejects a run where obj is glued to a following letter', () => {
    const { candidates } = sweepObjects(enc('1 0 object\n'));
    expect(candidates.size).toBe(0);
  });

  it('returns every candidate for one object number, ascending by offset', () => {
    const buf = enc('5 0 obj\nA\nendobj\n5 0 obj\nB\nendobj\n');
    const list = sweepObjects(buf).candidates.get(5)!;
    expect(list.length).toBe(2);
    expect(list[0].offset).toBeLessThan(list[1].offset);
  });

  it('records trailer keyword offsets, latest first', () => {
    const buf = enc('trailer\n<< /A 1 >>\nxx\ntrailer\n<< /B 2 >>\n');
    const { trailerOffsets } = sweepObjects(buf);
    expect(trailerOffsets.length).toBe(2);
    expect(trailerOffsets[0]).toBeGreaterThan(trailerOffsets[1]);
    // offset points just past the keyword, at the whitespace before the dict
    expect(new TextDecoder('latin1').decode(buf.subarray(trailerOffsets[0], trailerOffsets[0] + 3)))
      .toBe('\n<<');
  });

  it('rejects an absurdly long digit run', () => {
    const { candidates } = sweepObjects(enc(`${'9'.repeat(12)} 0 obj\n`));
    expect(candidates.size).toBe(0);
  });
});
