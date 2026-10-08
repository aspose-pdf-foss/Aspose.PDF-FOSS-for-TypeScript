import { describe, it, expect } from 'vitest';
import {
  lowerNotes, refsIn, keptRefs, formatMark, normalizeNoteOptions, NOTE, type MarkRun,
} from '../src/flownotes.js';
import type { TextRun } from '../src/textdecor.js';

describe('lowerNotes', () => {
  it('returns a string and a note-free run list unchanged (identity)', () => {
    const runs: TextRun[] = [{ text: 'a' }];
    expect(lowerNotes('plain', 12)).toBe('plain');
    expect(lowerNotes(runs, 12)).toBe(runs);
  });

  it('splits a noted run into its body and a mark run carrying a NoteRef', () => {
    const note = { content: 'The note.' };
    const out = lowerNotes([{ text: 'claim', fontSize: 10, color: [1, 0, 0], footnote: note }], 12) as TextRun[];
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: 'claim', fontSize: 10, color: [1, 0, 0] });
    expect('footnote' in out[0]).toBe(false);
    const ref = (out[1] as MarkRun)[NOTE];
    expect(ref.kind).toBe('footnote');
    expect(ref.note).toBe(note);
    expect(ref.baseSize).toBe(10);            // the run's own size wins
    expect(ref.markRun).toBe(out[1]);
    expect(out[1].color).toEqual([1, 0, 0]);
  });

  it('uses the block size when the run states none', () => {
    const out = lowerNotes([{ text: 'x', endnote: { content: 'e' } }], 12) as TextRun[];
    expect((out[1] as MarkRun)[NOTE].baseSize).toBe(12);
    expect((out[1] as MarkRun)[NOTE].kind).toBe('endnote');
  });

  it('refuses a run with both footnote and endnote', () => {
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 'a' }, endnote: { content: 'b' } } as never], 12))
      .toThrow(TypeError);
  });
  it('refuses an empty or non-string mark', () => {
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 'a', mark: '' } } as never], 12)).toThrow(TypeError);
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 'a', mark: 7 } } as never], 12)).toThrow(TypeError);
  });
  it('lowers a FlowNote cited twice in one run list into two refs (v9j3.3.1)', () => {
    const n = { content: 'a' };
    const refs = refsIn(lowerNotes([{ text: 'x', footnote: n }, { text: 'y', footnote: n }] as never, 12) as TextRun[]);
    expect(refs).toHaveLength(2);
    expect(refs[0].note).toBe(refs[1].note);
  });
  it('lets the same runs be lowered again (per-Render uniqueness is the numberer’s)', () => {
    const n = { content: 'a' };
    lowerNotes([{ text: 'x', footnote: n } as never], 12);
    expect(() => lowerNotes([{ text: 'y', footnote: n } as never], 12)).not.toThrow();
  });
  it('refuses a note whose text body itself carries a note', () => {
    const inner = { content: 'deep' };
    expect(() => lowerNotes([{ text: 'x', footnote: { content: [{ text: 'n', footnote: inner }] } } as never], 12))
      .toThrow(/nest/);
  });
  it('refuses content that is neither text nor elements', () => {
    expect(() => lowerNotes([{ text: 'x', footnote: { content: 42 } } as never], 12)).toThrow(TypeError);
    expect(() => lowerNotes([{ text: 'x', footnote: { content: [{}] } } as never], 12)).toThrow(TypeError);
  });
  it('validates everything before lowering anything', () => {
    const good = { content: 'ok' };
    expect(() => lowerNotes([{ text: 'a', footnote: good }, { text: 'b', footnote: { content: 'z', mark: '' } }] as never, 12))
      .toThrow(TypeError);
    // `good` was not consumed by the failed call:
    expect(() => lowerNotes([{ text: 'a', footnote: good } as never], 12)).not.toThrow();
  });
});

describe('refsIn / keptRefs', () => {
  it('finds refs in order, and carries them through a {...run} copy', () => {
    const out = lowerNotes([{ text: 'a', footnote: { content: '1' } }, { text: 'b', endnote: { content: '2' } }] as never, 12) as TextRun[];
    const refs = refsIn(out);
    expect(refs.map((r) => r.kind)).toEqual(['footnote', 'endnote']);
    const copy = out.map((r) => ({ ...r, text: r.text }));   // what sliceContent does
    expect(refsIn(copy)).toEqual(refs);
  });
  it('keptRefs is refs(text) minus refs(remainder), by identity', () => {
    const out = lowerNotes([{ text: 'a', footnote: { content: '1' } }, { text: 'b', footnote: { content: '2' } }] as never, 12) as TextRun[];
    const [r1, r2] = refsIn(out);
    expect(keptRefs(out, null)).toEqual([r1, r2]);
    expect(keptRefs(out, out.slice(2))).toEqual([r1]);
    expect(keptRefs(out, out)).toEqual([]);
    expect(refsIn('text')).toEqual([]);
  });
});

describe('formatMark', () => {
  it.each([
    [1, 'arabic', '1'], [12, 'arabic', '12'],
    [4, 'roman', 'iv'], [9, 'roman', 'ix'], [40, 'roman', 'xl'], [1994, 'Roman', 'MCMXCIV'],
    [1, 'alpha', 'a'], [26, 'alpha', 'z'], [27, 'alpha', 'aa'], [28, 'Alpha', 'BB'],
    [1, 'symbols', '*'], [5, 'symbols', '¶'], [6, 'symbols', '#'], [7, 'symbols', '**'], [13, 'symbols', '***'],
  ] as const)('%i as %s is %s', (n, f, want) => {
    expect(formatMark(n, f)).toBe(want);
  });
});

describe('normalizeNoteOptions', () => {
  it('fills the spec defaults per kind', () => {
    const f = normalizeNoteOptions(undefined, 'footnote');
    expect(f).toMatchObject({ format: 'arabic', start: 1, markScale: 0.6, fontSize: 8, spacing: 4, newPage: false });
    expect(f.separator).toEqual({ width: undefined, thickness: 0.5, color: [0, 0, 0] });
    const e = normalizeNoteOptions(undefined, 'endnote');
    expect(e).toMatchObject({ format: 'roman', fontSize: 10 });
  });
  it('separator false means none', () => {
    expect(normalizeNoteOptions({ separator: false }, 'footnote').separator).toBeUndefined();
  });
  it.each([
    [{ format: 'greek' }], [{ start: 0 }], [{ start: 1.5 }], [{ markScale: 0 }], [{ markScale: 1.5 }],
    [{ fontSize: 0 }], [{ spacing: -1 }], [{ separator: { thickness: 0 } }],
    [{ separator: { color: [2, 0, 0] } }], [{ newPage: 'yes' }],
  ])('refuses %j', (o) => {
    expect(() => normalizeNoteOptions(o as never, 'endnote')).toThrow(TypeError);
  });
});
