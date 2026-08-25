import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';

/** One stream, two text lines at different baselines. */
const TWO_LINES = 'BT /F1 10 Tf 50 200 Td (First line) Tj ET '
  + 'BT /F1 10 Tf 50 150 Td (Second line) Tj ET';

describe('StructElement.MarkContent', () => {
  it('tags existing content so GetStructTree/GetText round-trip', () => {
    const doc = Document.Open(buildMultiStreamPage([TWO_LINES]));
    const page = doc.Pages[0];
    const region = page.Search('First line')[0].quads[0]; // page-space box of line 1

    const root = doc.CreateStructTree();
    const p = root.Append('P');
    const mcid = p.MarkContent(page, region);
    expect(mcid).toBeGreaterThanOrEqual(0);

    const re = Document.Open(doc.Save());
    const tree = re.GetStructTree()!;
    expect(tree.Children.map((c) => c.Type)).toContain('P');
    const pEl = tree.Children.find((c) => c.Type === 'P')!;
    expect(pEl.GetText()).toContain('First line');
    expect(pEl.GetText()).not.toContain('Second line');
  });

  it('writes /P <</MCID 0>> BDC ... EMC into the content', () => {
    const doc = Document.Open(buildMultiStreamPage([TWO_LINES]));
    const page = doc.Pages[0];
    const region = page.Search('First line')[0].quads[0];
    const p = doc.CreateStructTree().Append('P');
    p.MarkContent(page, region);

    const raw = new TextDecoder('latin1').decode(page.Contents);
    expect(raw).toMatch(/\/P << \/MCID 0 >> BDC/);
    expect(raw).toContain('EMC');
  });

  it('returns -1 and tags nothing for an empty region', () => {
    const doc = Document.Open(buildMultiStreamPage([TWO_LINES]));
    const p = doc.CreateStructTree().Append('P');
    expect(p.MarkContent(doc.Pages[0], [0, 0, 5, 5])).toBe(-1);
  });
});

/** One line of text split across THREE content streams — the shape every test
 *  above avoids by handing `buildMultiStreamPage` a single-element array.
 *
 *  A page's /Contents array is logically ONE stream (32000-1 7.8.2), so this is
 *  an ordinary page, not a damaged one; `page.AddText` produces exactly this
 *  shape, a new stream per call. */
const SPLIT_LINE = [
  'BT /F1 10 Tf 50 200 Td (alpha) Tj ET',
  'BT /F1 10 Tf 80 200 Td (bravo) Tj ET',
  'BT /F1 10 Tf 110 200 Td (charlie) Tj ET',
];

describe('StructElement.MarkContent across content streams (c3t7.10)', () => {
  it('marks the content in EVERY stream the region covers', () => {
    // regionOpSpan used to keep only the stream with the most hits, so two
    // thirds of this line were left unmarked — in no structure element and not
    // artifacted either, and so absent from every export.
    const doc = Document.Open(buildMultiStreamPage(SPLIT_LINE));
    const page = doc.Pages[0];
    const p = doc.CreateStructTree().Append('P');
    p.MarkContent(page, page.GetStructuredText()[0].quad);

    const re = Document.Open(doc.Save());
    const pEl = re.GetStructTree()!.Children.find((c) => c.Type === 'P')!;
    expect(pEl.GetText()).toContain('alpha');
    expect(pEl.GetText()).toContain('bravo');
    expect(pEl.GetText()).toContain('charlie');
  });

  it('returns the first MCID it allocated', () => {
    const doc = Document.Open(buildMultiStreamPage(SPLIT_LINE));
    const page = doc.Pages[0];
    const p = doc.CreateStructTree().Append('P');
    expect(p.MarkContent(page, page.GetStructuredText()[0].quad)).toBe(0);
  });

  it('leaves content outside the region alone', () => {
    // The rule is "every stream the region covers", not "every stream".
    const doc = Document.Open(buildMultiStreamPage([
      ...SPLIT_LINE, 'BT /F1 10 Tf 50 100 Td (elsewhere) Tj ET',
    ]));
    const page = doc.Pages[0];
    const line = page.GetStructuredText().find((b) => b.text.includes('alpha'))!;
    const p = doc.CreateStructTree().Append('P');
    p.MarkContent(page, line.quad);

    const re = Document.Open(doc.Save());
    const pEl = re.GetStructTree()!.Children.find((c) => c.Type === 'P')!;
    expect(pEl.GetText()).not.toContain('elsewhere');
  });
});
