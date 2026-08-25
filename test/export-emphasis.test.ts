import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { parseMarkdown } from '../src/markdown.js';
import { renderHtml } from './helpers/md-html.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { buildSvgPdf, HELV_RESOURCES } from './helpers/build-svg-fixtures.js';

/** A one-page document whose Markdown source is rendered by our own stack and
 *  then exported back out. Headings default to Helvetica-Bold, paragraphs to
 *  the regular face, and `**x**` selects the bold family member — so the
 *  round trip is a real emphasis fixture without any hand-built content. */
function via(src: string): Document {
  const doc = Document.New();
  doc.AddMarkdown(src, { tagged: true });
  return Document.Open(doc.Save());
}

/** "Footnote" at 10pt on baseline 200, a 6pt "1" raised to 204, then "follows"
 *  back on 200 — the fixture `test/struct-text-script.test.ts` uses, AutoTagged.
 *
 *  ONE content stream, deliberately. `page.AddText` splices a new stream per
 *  call, and AutoTag keeps only the first stream of a multi-stream page
 *  (c3t7.10) — which drops two of these three runs before any serializer sees
 *  them, and reads exactly like a script bug that it is not. */
function taggedFootnote(): Document {
  const doc = Document.Open(buildMultiStreamPage([
    'BT /F1 10 Tf 50 200 Td (Footnote) Tj ET '
    + 'BT /F1 6 Tf 90 204 Td (1) Tj ET '
    + 'BT /F1 10 Tf 97 200 Td (follows) Tj ET',
  ]));
  doc.AutoTag();
  return doc;
}

/** One `P` holding TWO marked-content sequences, both in Helvetica-Bold.
 *
 *  The only shape that yields adjacent same-style text runs: `struct.ts` splits
 *  an own-text run where the derived STYLE changes, so a document our own
 *  writer produces never has two — even `**a** **b**` arrives as one run. */
function twoBoldMcids(): Document {
  const doc = Document.Open(buildSvgPdf({
    content: 'BT /F1 10 Tf 20 100 Td (alpha) Tj ET BT /F1 10 Tf 60 100 Td (beta) Tj ET',
    resources: HELV_RESOURCES,
  }));
  const page = doc.Pages[0];
  const frags = page.GetTextFragments();
  const quadOf = (t: string) => frags.find((f) => f.text === t)!.quad;
  const p = doc.CreateStructTree().Append('P');
  p.MarkContent(page, quadOf('alpha'));
  p.MarkContent(page, quadOf('beta'));
  return doc;
}

describe('HTML export carries emphasis', () => {
  it('emits <b> for a bold run', () => {
    // <b> and not <strong>: emphasis here is DERIVED from the producing face,
    // and <strong> would assert an importance the PDF never stated.
    const html = via('plain **bold** plain').ToHtml();
    expect(html).toContain('<b>bold</b>');
    expect(html).not.toContain('<strong>');
  });

  it('emits <i> for an italic run', () => {
    const html = via('plain *slanted* plain').ToHtml();
    expect(html).toContain('<i>slanted</i>');
    expect(html).not.toContain('<em>');
  });

  it('keeps the words either side of the emphasis', () => {
    expect(via('plain **bold** plain').ToHtml()).toContain('plain');
  });

  it('merges adjacent same-style runs into one element', () => {
    // Same rule as the Markdown side, and the same fixture: two MCIDs on one
    // element, which is the only shape that produces adjacent same-style runs.
    expect(Document.Open(twoBoldMcids().Save()).ToHtml()).toContain('<b>alphabeta</b>');
  });

  it('does not emit <b> for a uniformly bold heading', () => {
    // mdstyle defaults headings to Helvetica-Bold; both formats render a
    // heading bold themselves, so repeating it is noise.
    const html = via('# Title').ToHtml();
    expect(html).toContain('Title');
    expect(html).not.toContain('<b>');
  });
});

describe('Markdown export carries emphasis', () => {
  it('round-trips bold and italic through our own stack', () => {
    // Today this loses both: the model carries them and the serializer ignores
    // them.
    const md = via('plain **bold** and *slanted* text').ToMarkdown();
    expect(md).toContain('**bold**');
    expect(md).toContain('*slanted*');
  });

  it('emits ONE delimiter pair for adjacent same-style runs', () => {
    // The merge is what makes this correct: `**a****b**` is a four-asterisk
    // delimiter run that does not reparse as two strong spans.
    //
    // Measured: this needs TWO MCIDs on one element. Every `via()` fixture is
    // useless here — struct.ts already merges runs whose derived style matches,
    // so even `**a** **b**` arrives as the single run `a b`, and the assertion
    // passes with mergeAdjacentText stubbed out to `return nodes`.
    const md = Document.Open(twoBoldMcids().Save()).ToMarkdown();
    expect(md).toContain('**alphabeta**');
    expect(md).not.toContain('****');
    expect(renderHtml(parseMarkdown(md))).toContain('<strong>alphabeta</strong>');
  });


  it('does not emphasize a uniformly bold heading', () => {
    const md = via('# Title').ToMarkdown();
    expect(md).toContain('# Title');
    expect(md).not.toContain('**');
  });

  it('reparses to the same emphasis it started with', () => {
    // The whole point, closed as a loop: Markdown -> PDF -> Markdown -> AST
    // must still say strong. Asserting on the emitted STRING alone would pass
    // for `**a****b**`, which contains `**bold**` as a substring and yet does
    // not reparse as emphasis at all.
    const md = via('a **bold** b').ToMarkdown();
    const html = renderHtml(parseMarkdown(md));
    expect(html).toContain('<strong>bold</strong>');
  });

  it('emits a superscript as raw <sup>, which CommonMark cannot spell', () => {
    // Built directly rather than through Markdown, which has no superscript
    // syntax to render from in the first place. TAGGED, so this is the route
    // c3t7.7 built: scriptByGlyph classifies per page and styledRuns looks the
    // answer up.
    const md = Document.Open(taggedFootnote().Save()).ToMarkdown();
    expect(md).toContain('<sup>1</sup>');
  });

  it('emits a subscript on the UNTAGGED path too', () => {
    // The other route into the model — TextLine.styles rather than styledRuns.
    // 10pt "H", a 6pt "2" dropped 3pt, then 10pt "O". markScriptLevel needs a
    // size drop (6 vs a dominant 10, under the 0.85 ratio) AND a baseline shift
    // (3pt, over 0.1 em), with the baselines inside its max(2, 0.5*size) = 5pt
    // line tolerance so the three read as one line. A negative shift is 'sub'.
    const doc = Document.New();
    const { page } = doc.AddPage();
    page.AddText('H', 50, 200, { fontSize: 10 });
    page.AddText('2', 57, 197, { fontSize: 6 });
    page.AddText('O', 61, 200, { fontSize: 10 });
    const md = Document.Open(doc.Save()).ToMarkdown();
    expect(md).toContain('<sub>2</sub>');
  });

  it('emits a superscript in the HTML export as well', () => {
    expect(Document.Open(taggedFootnote().Save()).ToHtml()).toContain('<sup>1</sup>');
  });
});
