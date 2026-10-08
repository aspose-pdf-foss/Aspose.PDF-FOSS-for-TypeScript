import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { paragraph } from '../src/flow.js';
import {
  settleBudget, NoteColumn, NoteNumberer, normalizeNoteOptions, lowerNotes, refsIn,
  type NoteRef,
} from '../src/flownotes.js';

const foot = normalizeNoteOptions(undefined, 'footnote');
function makeRefs(bodies: string[]): NoteRef[] {
  const runs = bodies.map((b, i) => ({ text: `w${i} `, footnote: { content: b } }));
  const refs = refsIn(lowerNotes(runs as never, 12));
  const nb = new NoteNumberer(foot, normalizeNoteOptions(undefined, 'endnote'), (t, s) => paragraph(t, { fontSize: s }));
  refs.forEach((r) => nb.assign(r));
  return refs;
}

describe('NoteColumn.footHeight', () => {
  it('is 0 with no notes and spacing + separator + stacked body otherwise', () => {
    const col = new NoteColumn(foot, 300);
    expect(col.footHeight()).toBe(0);
    const [a] = makeRefs(['short note']);
    const h = col.footHeight([a]);
    expect(h).toBeGreaterThan(4 + 0.5);
    col.commit([a]);
    expect(col.footHeight()).toBeCloseTo(h, 9);
    expect(col.empty).toBe(false);
  });
});

describe('settleBudget', () => {
  // A stub: content kept grows with the budget; a ref is kept once 50pt is.
  const ref = { kind: 'footnote' } as NoteRef;
  const measure = (b: number) => ({ usedHeight: Math.floor(b / 10) * 10, notes: b >= 50 ? [ref] : [] });

  it('leaves the budget alone when no footnote is kept', () => {
    expect(settleBudget(measure, 40, 100, () => 30, false)).toEqual({ budget: 40, refs: [] });
  });
  it('finds the LARGEST budget whose content and notes fit, keeping the ref', () => {
    // usedHeight + 30 <= 100 holds up to 70pt of content, i.e. budgets below 80.
    const s = settleBudget(measure, 100, 100, (rs) => (rs.length ? 30 : 0), false);
    expect(s).not.toBe('advance');
    if (s !== 'advance') {
      expect(s.refs).toEqual([ref]);
      expect(s.budget).toBeGreaterThan(79.9);
      expect(s.budget).toBeLessThan(80);
    }
  });
  it('keeps the lines BEFORE the reference when the reference and its note cannot fit', () => {
    // The ref is on line 5; with an 80pt note only 20pt of content may stay,
    // which is two lines that cite nothing — the reference moves on with its line.
    const s = settleBudget(measure, 100, 100, (rs) => (rs.length ? 80 : 0), false);
    expect(s).not.toBe('advance');
    if (s !== 'advance') {
      expect(s.refs).toEqual([]);
      expect(s.budget).toBeGreaterThan(49.9);     // all four lines above the ref stay
      expect(s.budget).toBeLessThan(50);
    }
  });
  // The reference is on the FIRST line: nothing can stay without it.
  const first = (b: number) => ({ usedHeight: Math.floor(b / 10) * 10, notes: b >= 10 ? [ref] : [] });
  it('advances mid-column when the first line and its whole note cannot share the column', () => {
    expect(settleBudget(first, 100, 100, (rs) => (rs.length ? 95 : 0), false)).toBe('advance');
  });
  it('at a column start bisects to the smallest budget that keeps a line', () => {
    const s = settleBudget(first, 100, 100, (rs) => (rs.length ? 95 : 0), true);
    expect(s).not.toBe('advance');
    if (s !== 'advance') {
      expect(s.budget).toBeGreaterThanOrEqual(10);
      expect(s.budget).toBeLessThan(10.02);
      expect(s.refs).toEqual([ref]);
    }
  });
  it('terminates on a budget that only ever shrinks', () => {
    let calls = 0;
    const grow = (b: number) => { calls++; return { usedHeight: b, notes: Array.from({ length: Math.floor(b) }, () => ref) }; };
    settleBudget(grow, 100, 100, (rs) => rs.length * 0.9, false);
    expect(calls).toBeLessThan(200);
  });
  it('ignores endnote refs when reserving room but returns them', () => {
    const en = { kind: 'endnote' } as NoteRef;
    const m = (b: number) => ({ usedHeight: b, notes: [en] });
    expect(settleBudget(m, 60, 100, () => 999, false)).toEqual({ budget: 60, refs: [en] });
  });
});

describe('settleBudget and an infeasible foot', () => {
  it('a foot reported Infinity (a float in the way) keeps only lines citing nothing', () => {
    const ref = { kind: 'footnote' } as NoteRef;
    const m = (b: number) => ({ usedHeight: Math.floor(b / 10) * 10, notes: b >= 50 ? [ref] : [] });
    const s = settleBudget(m, 100, 100, (rs) => (rs.length ? Infinity : 0), false);
    expect(s).not.toBe('advance');
    if (s !== 'advance') { expect(s.refs).toEqual([]); expect(s.budget).toBeGreaterThan(49.9); }
  });
});

describe('NoteColumn.paint', () => {
  it('paints a separator and the notes at the column foot, nothing left over', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const col = new NoteColumn(foot, 300);
    const refs = makeRefs(['first note', 'second note']);
    col.commit(refs);
    col.paint({ doc, page, x: 72, penY: 600, contentBottom: 72, columnEmpty: false });
    expect(col.empty).toBe(true);
    const frags = page.GetTextFragments();
    const first = frags.find((f) => f.text.startsWith('first'))!;
    const second = frags.find((f) => f.text.startsWith('second'))!;
    expect(first.quad[1]).toBeGreaterThan(second.quad[1]);      // note 1 above note 2
    expect(second.quad[1]).toBeGreaterThanOrEqual(72 - 1e-6);
    expect(new TextDecoder('latin1').decode(page.Contents)).toMatch(/ re\nf/);   // the rule
  });
  it('carries what does not fit into the next column, painting it first there', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const col = new NoteColumn(foot, 300);
    col.commit(makeRefs(['word '.repeat(600)]));
    col.paint({ doc, page, x: 72, penY: 150, contentBottom: 72, columnEmpty: false });
    expect(col.empty).toBe(false);
    const page2 = doc.AddPage().page;
    col.paint({ doc, page: page2, x: 72, penY: 770, contentBottom: 72, columnEmpty: true });
    expect(page2.GetText()).toContain('word');
  });
  it('draws an unsplittable piece taller than an empty column past the bottom rather than looping', () => {
    const doc = Document.New();
    const page = doc.AddPage().page;
    const col = new NoteColumn(foot, 300);
    const [r] = makeRefs(['x']);
    const tall = { measure: () => ({ usedHeight: 2000, fits: true }),
      place: (c: { availHeight: number }) => c.availHeight >= 2000
        ? { usedHeight: 2000, remainder: null, drew: true } : { usedHeight: 0, remainder: tall, drew: false } } as never;
    r.body = [tall];
    col.commit([r]);
    col.paint({ doc, page, x: 72, penY: 770, contentBottom: 72, columnEmpty: true });
    expect(col.empty).toBe(true);
  });
});
