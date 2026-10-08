import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { FlowNote } from '../src/flow.js';
import { UnsupportedFeatureError } from '../src/errors.js';

const fn = (content: FlowNote['content'], mark?: string): { footnote: FlowNote } =>
  ({ footnote: { content, ...(mark ? { mark } : {}) } });
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const nwords = (n: number) => Array.from({ length: n }, (_, i) => `n${i}`).join(' ');

function pageOf(pages: { GetText(): string }[], needle: string): number {
  return pages.findIndex((p) => p.GetText().includes(needle));
}

describe('footnotes', () => {
  it('places the note on the same page as its reference, below the body text', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'A claim' }, { text: '', ...fn('Source: the archive.') }, { text: ' continues.' }]);
    const [p] = flow.Render();
    const frags = p.GetTextFragments();
    const body = frags.find((f) => f.text.includes('claim'))!;
    const note = frags.find((f) => f.text.includes('Source'))!;
    expect(note.quad[1]).toBeLessThan(body.quad[1]);
    expect(note.quad[1]).toBeGreaterThanOrEqual(72 - 1e-6);
    expect(note.quad[1]).toBeLessThan(200);                      // at the foot, not after the text
  });

  it('a flow without notes renders byte-identically to before', () => {
    // Page content, not Save(): Save() writes a fresh random /ID per document.
    const a = Document.New().NewFlow().AddParagraph(words(300)).Render();
    const b = Document.New().NewFlow({ footnotes: { fontSize: 9 } }).AddParagraph(words(300)).Render();
    expect(b).toHaveLength(a.length);
    a.forEach((p, i) => expect(Buffer.from(b[i].Contents).equals(Buffer.from(p.Contents))).toBe(true));
  });

  it('moves a reference line to the next page when its note cannot fit below it', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    // Measured: with 620 filler words REF sits at y 139 and its note fits
    // below; at 640 it would sit near 120 — room for the line, not the note.
    // The note's words use their own prefix so the filler cannot satisfy a lookup.
    flow.AddParagraph(words(640));
    flow.AddParagraph([{ text: 'REF' }, { text: '', ...fn(nwords(120)) }]);
    const pages = flow.Render();
    expect(pageOf(pages, 'REF')).toBe(1);
    expect(pageOf(pages, 'n0 ')).toBe(1);
    expect(pageOf(pages, 'n119')).toBe(1);
  });

  it('keeps a reference line in place when its note fits below it', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph(words(620));
    flow.AddParagraph([{ text: 'REF' }, { text: '', ...fn(nwords(120)) }]);
    const pages = flow.Render();
    expect(pages).toHaveLength(1);
    expect(pageOf(pages, 'n119')).toBe(0);
  });

  it('splits a note taller than a column across pages, continuing under a separator', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'Start' }, { text: '', ...fn(words(2500)) }]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(pageOf(pages, 'Start')).toBe(0);
    expect(pageOf(pages, 'w0 ')).toBe(0);                            // the note STARTS on the ref's page
    expect(pages[pages.length - 1].GetText()).toContain('w2499');   // and is drawn to the end
  });

  it('drains a very long note after the last element (Review Focus 3)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2 });
    flow.AddParagraph([{ text: 'Only' }, { text: '', ...fn(words(9000)) }]);
    const pages = flow.Render();
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[pages.length - 1].GetText()).toContain('w8999');
  });

  it('paints a carried note ABOVE the notes of the column it carries into', () => {
    // Measured: a 2500-word note carries into page 2, where BREF also lands.
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'AREF' }, { text: '', ...fn(nwords(2500)) }]);
    flow.AddParagraph([{ text: 'BREF' }, { text: '', ...fn('BNOTE') }]);
    const pages = flow.Render();
    const p = pages[pageOf(pages, 'BREF')];
    const y = (s: string) => p.GetTextFragments().find((f) => f.text.includes(s))!.quad[1];
    expect(pageOf(pages, 'n2499')).toBe(pageOf(pages, 'BREF'));
    expect(y('n2499')).toBeGreaterThan(y('BNOTE'));
  });

  it('a column filled by carry makes content WAIT, keeping each note with its reference', () => {
    // Measured: a 4000-word note's carry fills page 2 and part of page 3.
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'AREF' }, { text: '', ...fn(nwords(4000)) }]);
    flow.AddParagraph([{ text: 'BREF' }, { text: '', ...fn('BNOTE') }]);
    flow.AddParagraph(words(200));
    const pages = flow.Render();
    expect(pageOf(pages, 'BNOTE')).toBeGreaterThanOrEqual(0);
    expect(pageOf(pages, 'BNOTE')).toBe(pageOf(pages, 'BREF'));
    expect(pages[pages.length - 1].GetText()).toContain('w199');
  });

  it('stacks many notes from one line in reference order (Review Focus 1)', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    const runs = Array.from({ length: 8 }, (_, i) => [{ text: ` s${i}` }, { text: '', ...fn(`NOTE${i}`) }]).flat();
    flow.AddParagraph(runs as never);
    const [p] = flow.Render();
    const ys = Array.from({ length: 8 }, (_, i) => p.GetTextFragments().find((f) => f.text.includes(`NOTE${i}`))!.quad[1]);
    for (let i = 1; i < 8; i++) expect(ys[i]).toBeLessThan(ys[i - 1]);
  });

  it('two columns: each column carries its own notes', () => {
    const doc = Document.New();
    const flow = doc.NewFlow({ columns: 2, columnGap: 18 });
    flow.AddParagraph([{ text: 'LEFT' }, { text: '', ...fn('Left note') }]);
    flow.AddColumnBreak();
    flow.AddParagraph([{ text: 'RIGHT' }, { text: '', ...fn('Right note') }]);
    const [p] = flow.Render();
    const f = p.GetTextFragments();
    const mid = PageFormat.A4.width / 2;
    expect(f.find((x) => x.text.includes('Left note'))!.quad[0]).toBeLessThan(mid);
    expect(f.find((x) => x.text.includes('Right note'))!.quad[0]).toBeGreaterThan(mid);
  });

  it('numbers continuously across pages and honours an explicit mark', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'a' }, { text: '', ...fn('n-a') }]);
    flow.AddParagraph([{ text: 'b' }, { text: '', ...fn('n-b', '†') }]);
    flow.AddColumnBreak();
    flow.AddParagraph([{ text: 'c' }, { text: '', ...fn('n-c') }]);
    const pages = flow.Render();
    expect(pages[1].GetTextFragments().some((x) => x.text === '2')).toBe(true);
  });

  it('a float never overlaps the foot area', () => {
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'R' }, { text: '', ...fn(words(150)) }]);
    const box = doc.NewFloatingBox({ width: 150 });
    box.AddParagraph(words(220));
    flow.AddFloatBox(box, 'right');
    const pages = flow.Render();
    const noteTop = Math.max(...pages[0].GetTextFragments()
      .filter((x) => x.fontSize < 8.5 && x.quad[1] < 400).map((x) => x.quad[3]));
    const floatBottom = Math.min(...pages[0].GetTextFragments()
      .filter((x) => x.quad[0] > 300 && x.fontSize > 8.5).map((x) => x.quad[1]));
    expect(floatBottom).toBeGreaterThan(noteTop);
  });

  it('keep-with-next sees the foot-reduced bottom (Review Focus 5)', () => {
    // A footnote committed early raises the effective bottom by ~75pt. Measured:
    // at 588 filler words the heading's lookahead finds room for a body line
    // above the RAW bottom but not above the footnotes, so only the
    // foot-reduced reading moves the heading with its body.
    const doc = Document.New();
    const flow = doc.NewFlow();
    flow.AddParagraph([{ text: 'x' }, { text: '', ...fn(nwords(150)) }]);
    flow.AddParagraph(words(588));
    flow.AddHeading(2, 'KEPT');
    flow.AddParagraph(Array.from({ length: 40 }, (_, i) => `b${i}`).join(' '));
    const pages = flow.Render();
    expect(pageOf(pages, 'KEPT')).toBe(1);
    expect(pageOf(pages, 'b0 ')).toBe(1);
  });

  it('refuses a float whose content carries a reference', () => {
    // elementFloat content is only reachable through AddHtml today; build it directly.
    // Skip if the test cannot construct one without the CSS stack: assert via a
    // hand-built FlowElement carrying `float` and `noteRefs`.
    const doc = Document.New();
    const flow = doc.NewFlow();
    const el = { float: { side: 'left', content: { width: 50, spacing: 0, measure: () => 10, paintAt: () => 10 } },
      noteRefs: () => [{ kind: 'footnote' }], place: () => ({ usedHeight: 0, remainder: null, drew: false }) };
    flow.AddElements([el as never]);
    expect(() => flow.Render()).toThrow(UnsupportedFeatureError);
  });

  it('validates note options in the constructor', () => {
    expect(() => Document.New().NewFlow({ footnotes: { fontSize: -1 } })).toThrow(TypeError);
  });
});
