import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { buildMultiStreamPage, buildTextAndImagePage } from './helpers/build-edit-pdf.js';
import { buildTablePdf, hline, vline, text } from './helpers/build-table-pdf.js';

// A 20pt title, then two 2-line 10pt paragraphs, well separated vertically.
const DOC = 'BT /F1 20 Tf 50 250 Td (Big Title) Tj ET '
  + 'BT /F1 10 Tf 50 210 Td (Para one line one here) Tj 0 -12 Td (para one line two here) Tj ET '
  + 'BT /F1 10 Tf 50 160 Td (Para two line one here) Tj 0 -12 Td (para two line two here) Tj ET';

describe('doc.AutoTag — headings + paragraphs', () => {
  it('tags a title as H1 and paragraphs as P, marking the doc Tagged', () => {
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    const report = doc.AutoTag();
    expect(report.headings).toBe(1);
    expect(report.paragraphs).toBe(2);
    expect(doc.IsTagged).toBe(true);

    const re = Document.Open(doc.Save());
    const kids = re.GetStructTree()!.Children;
    expect(kids.map((c) => c.Type)).toEqual(['H1', 'P', 'P']);
    expect(kids[0].GetText()).toContain('Big Title');
    expect(kids[1].GetText()).toContain('Para one');
  });

  it('throws on an already-tagged doc unless force is set', () => {
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    doc.AutoTag();
    expect(() => doc.AutoTag()).toThrow(UnsupportedFeatureError);
    expect(() => doc.AutoTag({ force: true })).not.toThrow();
  });

  it('sets lang and title from opts', () => {
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    doc.AutoTag({ lang: 'en-US', title: 'My Report' });
    expect(doc.Lang).toBe('en-US');
    expect(doc.GetMetadata().title).toBe('My Report');
  });
});

describe('doc.AutoTag — figures + artifacts', () => {
  const withImage = () => Document.Open(buildTextAndImagePage(
    'BT /F1 10 Tf 50 250 Td (caption) Tj ET q 100 0 0 100 50 50 cm /Im0 Do Q'));

  it('tags an image as Figure with /Alt when alt is provided', () => {
    const doc = withImage();
    const report = doc.AutoTag({ alt: () => 'a company logo' });
    expect(report.figures).toBe(1);
    expect(report.artifacts).toBe(0);

    const re = Document.Open(doc.Save());
    const fig = re.GetStructTree()!.Children.find((c) => c.Type === 'Figure')!;
    expect(fig).toBeDefined();
    expect(fig.Alt).toBe('a company logo');
  });

  it('marks an undescribed image as /Artifact (not in the tree)', () => {
    const doc = withImage();
    const report = doc.AutoTag(); // no alt callback
    expect(report.figures).toBe(0);
    expect(report.artifacts).toBe(1);

    const re = Document.Open(doc.Save());
    expect(re.GetStructTree()!.Children.some((c) => c.Type === 'Figure')).toBe(false);
    expect(new TextDecoder('latin1').decode(re.Pages[0].Contents)).toContain('/Artifact BMC');
  });
});

describe('doc.AutoTag — PDF/UA improvement', () => {
  it('reduces PDF/UA errors on a simple untagged doc', () => {
    const before = Document.Open(buildMultiStreamPage([DOC])).ValidatePdfUa().Errors.length;
    const doc = Document.Open(buildMultiStreamPage([DOC]));
    doc.AutoTag({ lang: 'en-US', title: 'Doc' });
    const after = doc.ValidatePdfUa().Errors.length;
    expect(after).toBeLessThan(before);
  });
});

// A 2x2 ruled grid with cell text (same construction as the table tests).
const TABLE = hline(50, 150, 200) + hline(50, 150, 150) + hline(50, 150, 100)
  + vline(50, 100, 200) + vline(100, 100, 200) + vline(150, 100, 200)
  + text(55, 175, 'A') + text(105, 175, 'B')
  + text(55, 125, 'C') + text(105, 125, 'D');

describe('doc.AutoTag — tables', () => {
  it('tags a ruled table as Table > TR > TH/TD with first-row headers', () => {
    const doc = Document.Open(buildTablePdf(TABLE));
    const report = doc.AutoTag();
    expect(report.tables).toBe(1);

    const re = Document.Open(doc.Save());
    const kids = re.GetStructTree()!.Children;
    const table = kids.find((c) => c.Type === 'Table')!;
    expect(table).toBeDefined();
    const trs = table.Children;
    expect(trs.map((r) => r.Type)).toEqual(['TR', 'TR']);
    expect(trs[0].Children.map((c) => c.Type)).toEqual(['TH', 'TH']); // header row
    expect(trs[1].Children.map((c) => c.Type)).toEqual(['TD', 'TD']); // body row
    expect(trs[0].Children[0].GetText()).toContain('A');              // MCID round-trip
    expect(trs[1].Children[1].GetText()).toContain('D');
    expect(trs[0].Children[0].TableAttributes?.scope).toBe('Column');

    // Table text is not also tagged as a paragraph.
    expect(kids.some((c) => c.Type === 'P')).toBe(false);
  });

  it('reports no TableStructure errors from ValidatePdfUa', () => {
    const doc = Document.Open(buildTablePdf(TABLE));
    doc.AutoTag();
    expect(doc.ValidatePdfUa().Errors.some((e) => e.rule === 'TableStructure')).toBe(false);
  });

  it('skips table tagging when opts.tables is false', () => {
    const doc = Document.Open(buildTablePdf(TABLE));
    const report = doc.AutoTag({ tables: false });
    expect(report.tables).toBe(0);
    expect(doc.GetStructTree()!.Children.some((c) => c.Type === 'Table')).toBe(false);
    expect(report.paragraphs).toBeGreaterThan(0); // cells fell back to P/H
  });
});

describe('doc.AutoTag — a page whose /Contents is an array (c3t7.10)', () => {
  /** One line of text, one AddText call per word. `page.AddText` splices a NEW
   *  content stream per call, so this is the everyday shape of an authored page
   *  rather than a synthetic one — and every AutoTag test above happens to use a
   *  single-stream fixture, which is why the defect survived. */
  function threeStamps(): Document {
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.AddText('alpha', 50, 200, { fontSize: 10 });
    page.AddText('bravo', 80, 200, { fontSize: 10 });
    page.AddText('charlie', 110, 200, { fontSize: 10 });
    doc.AutoTag();
    return doc;
  }

  it('keeps the text of every stream, not just the busiest one', () => {
    // markContentRegion used to reduce the region to ONE stream, so two thirds
    // of this line ended up in no structure element and were not artifacted
    // either — invisible to GetStructTree and to every export built on it.
    const el = Document.Open(threeStamps().Save())
      .GetStructTree()!.Children.find((c) => c.Type === 'P')!;
    expect(el.GetText()).toContain('alpha');
    expect(el.GetText()).toContain('bravo');
    expect(el.GetText()).toContain('charlie');
  });

  it('carries all of it into the exports', () => {
    // The reported symptom: the model dropped everything after the first
    // stream, so ToMarkdown returned a fraction of the page.
    const re = Document.Open(threeStamps().Save());
    expect(re.ToMarkdown()).toContain('alpha');
    expect(re.ToMarkdown()).toContain('charlie');
    expect(re.ToHtml()).toContain('charlie');
  });

  it('leaves no page content untagged', () => {
    // The stronger statement, and the one a validator can make: every glyph is
    // now inside a marked-content sequence. Dropping streams did not merely
    // lose text from the tree, it left that text unmarked in a tagged document.
    const doc = threeStamps();
    expect(doc.ValidatePdfUa().Warnings.some((w) => w.rule === 'UntaggedContent'))
      .toBe(false);
  });
});
