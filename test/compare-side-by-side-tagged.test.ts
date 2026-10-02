// Tagged side-by-side output (aq4a.7): each sheet holds two placed pages whose
// marked content would collide (both number their MCIDs from 0), so the right
// page's MCIDs are renumbered in its placed copy and its structure is cloned
// with the same offset. The checks read the RESULT's structure back through
// the library's own resolution — an MCID that collided would resolve to the
// other document's element and the texts below would be wrong.
import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';
import { buildMultiPageTextPdf } from './helpers/build-text-pdf.js';
import { buildTaggedMcShapesPdf } from './helpers/build-tagged-mc-shapes-pdf.js';

/** A tagged document authored by this library: one paragraph per entry. */
function tagged(...paras: string[]): Document {
  const d = Document.New();
  d.AddMarkdown(paras.join('\n\n'), { format: PageFormat.A4, tagged: true, lang: 'en-US', title: 'T' });
  return d;
}
const untagged = (line: string) =>
  Document.Open(buildMultiPageTextPdf([`BT /F1 10 Tf 20 260 Td (${line}) Tj ET`]));

function walk(els: StructElement[], out: StructElement[] = []): StructElement[] {
  for (const e of els) { out.push(e); walk(e.Children, out); }
  return out;
}
const texts = (d: Document, type: string): string[] =>
  walk(d.GetStructTree()!.Children).filter((e) => e.Type === type).map((e) => e.GetText().trim());
const untaggedIssues = (d: Document) => d.ValidatePdfUa().Issues.filter((i) => i.rule === 'UntaggedContent');

describe('CompareSideBySide({ tagged: true })', () => {
  it('carries both documents’ structure, each resolving to its own text', () => {
    const { document: out } = tagged('the quick brown fox', 'second para').CompareSideBySide(
      tagged('the slow brown fox', 'second para'), { tagged: true });
    expect(texts(out, 'P')).toEqual(['the quick brown fox', 'second para', 'the slow brown fox', 'second para']);
  });

  it('renumbers MCIDs reached through a named property list, a nested form and an inherited /Pg', () => {
    const shapes = (w: string) => Document.Open(buildTaggedMcShapesPdf(w));
    // the source reads back as written, so the fixture itself is sound
    expect(texts(shapes('alpha'), 'P')).toEqual(['named alpha', 'nested alpha', 'inline alpha']);
    const { document: out } = shapes('alpha').CompareSideBySide(shapes('beta'), { tagged: true });
    expect(texts(out, 'P')).toEqual([
      'named alpha', 'nested alpha', 'inline alpha', 'named beta', 'nested beta', 'inline beta',
    ]);
    expect(untaggedIssues(out)).toEqual([]);
    expect(texts(Document.Open(out.Save()), 'P')).toHaveLength(6);
  });

  it('leaves no visible content untagged', () => {
    const { document: out } = tagged('the quick brown fox').CompareSideBySide(tagged('the slow brown fox'), { tagged: true });
    expect(untaggedIssues(out)).toEqual([]);
    expect(untaggedIssues(Document.Open(out.Save()))).toEqual([]);
  });

  it('tags every mark as an Annot element whose alternate text says what changed', () => {
    const { document: out } = tagged('the quick brown fox').CompareSideBySide(tagged('the slow brown fox'), { tagged: true });
    const root = out.GetStructTree()!;
    const marks = out.Pages[0].Annotations;
    expect(marks).toHaveLength(2);
    for (const m of marks) {
      const key = out.resolve(m.Dict.get('StructParent'));
      expect(typeof key).toBe('number');
      const el = root.ElementForObject(key as number)!;
      expect(el.Type).toBe('Annot');
      expect(el.Alt).toBe(m.Contents);
    }
    const changes = root.Children.find((e) => e.Type === 'Sect' && e.Dict.has('T'))!;
    expect(changes.Children.map((e) => e.Alt)).toEqual(['Deleted: quick', 'Inserted: slow']);
  });

  it('marks drawn boxes as artifacts', () => {
    const { document: out } = tagged('the quick brown fox').CompareSideBySide(
      tagged('the slow brown fox'), { tagged: true, marks: 'content' });
    expect(out.Pages[0].Annotations).toHaveLength(0);
    expect(untaggedIssues(out)).toEqual([]);
  });

  it('clones the structure twice when a document is compared with itself', () => {
    const d = tagged('alpha beta');
    const { document: out } = d.CompareSideBySide(d, { tagged: true });
    expect(texts(out, 'P')).toEqual(['alpha beta', 'alpha beta']);
    expect(untaggedIssues(out)).toEqual([]);
  });

  it('keeps the first document’s language', () => {
    // AddMarkdown's lang goes on the flow's /Sect, never the catalog, so the
    // sources carry their language in the structure the result clones; the
    // catalog's is set here to see it copied.
    const a = tagged('x');
    a.Lang = 'de-DE';
    const { document: out } = a.CompareSideBySide(tagged('y'), { tagged: true });
    expect(out.Lang).toBe('de-DE');
    expect(tagged('x').CompareSideBySide(tagged('y'), { tagged: true }).document.Lang).toBeUndefined();
  });

  it('cannot tag what was never tagged, and says so', () => {
    const { document: out } = untagged('the quick fox').CompareSideBySide(untagged('the slow fox'), { tagged: true });
    expect(untaggedIssues(out).length).toBeGreaterThan(0);
    expect(texts(out, 'P')).toEqual([]);
  });

  it('writes no structure by default', () => {
    const { document: out } = tagged('the quick fox').CompareSideBySide(tagged('the slow fox'));
    expect(out.GetStructTree()).toBeNull();
    expect(out.Pages[0].Dict.has('StructParents')).toBe(false);
    expect(out.Pages[0].Annotations.every((a) => !a.Dict.has('StructParent'))).toBe(true);
  });

  it('refuses a tagged option that is not a boolean', () => {
    expect(() => tagged('x').CompareSideBySide(tagged('y'), { tagged: 'yes' } as never)).toThrow(TypeError);
  });
});
