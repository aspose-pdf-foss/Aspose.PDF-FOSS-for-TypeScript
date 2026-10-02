// Document comparison against two revisions of one document written by
// Microsoft Word 2010 (aq4a.6). The oracle is the EDIT LIST in
// scripts/gen-compare-word.ps1 — six edits made in Word between the two
// exports — not anything this library computed. See
// test/fixtures/compare/PROVENANCE.md for what the files cover and do not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Document } from '../src/document.js';
import type { TextChange } from '../src/compare.js';
import type { Rect } from '../src/text.js';

const file = (n: string) => readFileSync(`test/fixtures/compare/${n}`);
const rev1 = () => Document.Open(file('word2010-rev1.pdf'));
const rev2 = () => Document.Open(file('word2010-rev2.pdf'));

/** E3 + E4 of the script: a deleted sentence and the paragraph inserted after it. */
const DELETED_SENTENCE = 'Late delivery incurs a penalty of two percent per week.';
const INSERTED_PARAGRAPH = 'All prices exclude value added tax, which the customer pays at the rate in force on the date of the invoice. '
  + 'Payment is due within fourteen days of that date. Interest on late payment accrues daily at the base rate published '
  + 'by the central bank plus four percent, from the day after the due date until the day the payment is received in full, '
  + 'and the supplier may suspend deliveries while any invoice remains unpaid.';

/** Each change region as [deleted, inserted]. */
function regions(cs: TextChange[]): [string, string][] {
  const out: [string, string][] = [];
  let cur: [string, string] | undefined;
  for (const c of cs) {
    if (c.op === 'equal') { cur = undefined; continue; }
    if (!cur) { cur = ['', '']; out.push(cur); }
    if (c.op === 'delete') cur[0] = c.oldText; else cur[1] = c.newText;
  }
  return out;
}
const overlaps = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe('comparison over two Word 2010 revisions', () => {
  it('reads the vendored files, unchanged', () => {
    const sha = (n: string) => createHash('sha256').update(file(n)).digest('hex');
    expect(sha('word2010-rev1.pdf')).toBe('cc5135f9469326b751b60be1cb034b9719b0c0e5a7268d7681e6780d211ff59b');
    expect(sha('word2010-rev2.pdf')).toBe('0c50a8efdb25357344f9f987124c5b95e9fc870b7e4a780d5e1a54fc9472e7ad');
  });

  it('moved Clause 17 from page 1 to page 2, which the reflow cases depend on', () => {
    expect(rev1().Pages[0].GetText()).toContain('Clause 17.');
    expect(rev2().Pages[0].GetText()).not.toContain('Clause 17.');
    expect(rev2().Pages[1].GetText()).toContain('Clause 17.');
  });

  it('reports exactly the five text edits made in Word, and nothing for the recolour', () => {
    const r = rev1().CompareText(rev2());
    expect(regions(r.changes)).toEqual([
      ['thirty', 'sixty'],                              // E2
      [DELETED_SENTENCE, INSERTED_PARAGRAPH],            // E3 + E4, adjacent: one change
      ['colour', 'color'],                              // E5
      ['December.', 'November.'],                       // E6
    ]);
    expect(r.changes[0]).toMatchObject({ op: 'equal' });
    expect(r.changes[0].oldText.startsWith('Service Agreement')).toBe(true); // E1 is not a text change
    expect(r.minimal).toBe(true);
  });

  it('splits the rewrite around a shared word only when asked for the minimal diff', () => {
    // Both passages contain "of"; the smallest diff keeps it, a reader does not.
    const r = rev1().CompareText(rev2(), { cleanup: 'none' });
    expect(regions(r.changes).length).toBeGreaterThan(4);
  });

  it('reports Clause 17 as moved in pages mode, and not in document mode', () => {
    const doc = rev1().CompareText(rev2());
    expect(doc.changes.some((c) => c.op !== 'equal' && /Clause 17/.test(c.oldText + c.newText))).toBe(false);
    const pages = rev1().CompareText(rev2(), { mode: 'pages' });
    const [p1, p2] = pages.pages!;
    expect(p1.changes.some((c) => c.op === 'delete' && c.oldText.includes('Clause 17.'))).toBe(true);
    expect(p2.changes.some((c) => c.op === 'insert' && c.newText.includes('Clause 17.'))).toBe(true);
  });

  it('places each edit on its page where Search finds the same words', () => {
    const a = rev1(), b = rev2();
    const r = a.CompareText(b);
    const del = r.changes.find((c) => c.op === 'delete' && c.oldText === 'thirty')!;
    expect(del.old).toEqual([{ page: 1, text: 'thirty', quads: a.Pages[0].Search('thirty')[0].quads }]);
    const ins = r.changes.find((c) => c.op === 'insert' && c.newText === 'November.')!;
    expect(ins.new).toEqual([{ page: 2, text: 'November.', quads: b.Pages[1].Search('November.')[0].quads }]);
  });

  it('finds the one changed letter at character granularity', () => {
    const r = rev1().CompareText(rev2(), { granularity: 'character' });
    const u = r.changes.filter((c) => c.op === 'delete' && c.oldText === 'u');
    expect(u).toHaveLength(1);
    expect(u[0].old[0].page).toBe(1);
  });

  it('sees the recoloured heading that text comparison cannot, and the page-2 edit', () => {
    const a = rev1(), b = rev2();
    const g = a.CompareRendering(b);
    expect(g.identical).toBe(false);
    const heading = b.Pages[0].Search('Service Agreement')[0].quads[0];
    expect(g.pages[0].regions.some((r) => overlaps(r, heading))).toBe(true);
    const nov = b.Pages[1].Search('November.')[0].quads[0];
    expect(g.pages[1].regions.some((r) => overlaps(r, nov))).toBe(true);
  });

  it('carries Word’s own tagging through a tagged side-by-side, adding no PDF/UA issue', () => {
    const a = rev1(), b = rev2();
    const { document: out } = a.CompareSideBySide(b, { tagged: true });
    const rules = (d: Document) => [...new Set(d.ValidatePdfUa().Issues.map((i) => i.rule))].sort();
    expect(rules(out)).toEqual(rules(a));
    expect(rules(out)).not.toContain('UntaggedContent');
  });

  it('marks each edit on the side-by-side sheet over its own words', () => {
    const { document: out } = rev1().CompareSideBySide(rev2());
    const notes = (p: number) => out.Pages[p].Annotations.map((a) => a.Contents);
    expect(notes(0)).toEqual([
      'Deleted: thirty', `Deleted: ${DELETED_SENTENCE}`, 'Deleted: colour',
      'Inserted: sixty', `Inserted: ${INSERTED_PARAGRAPH}`, 'Inserted: color',
    ]);
    expect(notes(1)).toEqual(['Deleted: December.', 'Inserted: November.']);
    const mark = out.Pages[0].Annotations.find((a) => a.Contents === 'Deleted: thirty')!;
    close(mark.Rect!, out.Pages[0].Search('thirty')[0].quads[0]);
  });
});
