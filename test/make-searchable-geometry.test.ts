import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import type { Page } from '../src/page.js';
import { PageFormat } from '../src/pageformat.js';
import { visitContent, type GlyphEvent } from '../src/text.js';
import { streamOf } from '../src/pagecontent.js';
import { fakeOcr } from './helpers/fake-ocr.js';
import { buildPdfaPdf } from './helpers/build-pdfa-pdf.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';

const BOX: [number, number, number, number] = [20, 30, 100, 50]; // pixels
const TEXT = 'ABCD';

function glyphs(doc: Document, page: Page): GlyphEvent[] {
  const out: GlyphEvent[] = [];
  visitContent(doc, page, { glyph: (e) => { out.push(e); } });
  return out;
}

/** Page point of pixel (px, py) on a 200x100 page at scale 1 — derived by hand
 *  from PDF 32000-1 8.3 and /Rotate, NOT from baseMatrix. */
const PAGE_OF: Record<number, (px: number, py: number) => [number, number]> = {
  0: (px, py) => [px, 100 - py],
  90: (px, py) => [py, px],
  180: (px, py) => [200 - px, py],
  270: (px, py) => [200 - py, 100 - px],
};
/** Direction of the text baseline in page space. */
const ANGLE: Record<number, number> = { 0: 0, 90: Math.PI / 2, 180: Math.PI, 270: -Math.PI / 2 };

function expectSpanAt(g: GlyphEvent[], at: (px: number, py: number) => [number, number], angle: number, height: number): void {
  expect(g.map((e) => e.text).join('')).toBe(TEXT);
  const [x0, , x1, y1] = BOX;
  const step = (x1 - x0) / TEXT.length;
  for (let i = 0; i < TEXT.length; i++) {
    const [ex, ey] = at(x0 + step * i, y1);
    expect(g[i]!.quad[0]).toBeCloseTo(ex, 3);
    expect(g[i]!.quad[1]).toBeCloseTo(ey, 3);
  }
  expect(Math.cos(g[0]!.angle)).toBeCloseTo(Math.cos(angle), 6);
  expect(Math.sin(g[0]!.angle)).toBeCloseTo(Math.sin(angle), 6);
  expect(g[0]!.fontSize).toBeCloseTo(height, 3);
  expect(g.every((e) => e.renderMode === 3)).toBe(true); // invisible by MODE, not by an empty glyph
}

async function ocrOne(doc: Document, dpi = 72, box = BOX): Promise<void> {
  const r = await doc.MakeSearchable(fakeOcr(() => [{ text: TEXT, box }]), { dpi, force: true });
  expect(r.pages[0]!.status).toBe('ocr');
}

describe('MakeSearchable geometry (3ywf.3)', () => {
  for (const rot of [0, 90, 180, 270]) {
    it(`places each glyph over its pixels on a /Rotate ${rot} page`, async () => {
      const doc = Document.New(PageFormat.custom(200, 100));
      doc.Pages[0]!.Rotate = rot;
      await ocrOne(doc);
      expectSpanAt(glyphs(doc, doc.Pages[0]!), PAGE_OF[rot]!, ANGLE[rot]!, 20);
    });
  }

  it('honours an offset CropBox', async () => {
    const doc = Document.New(PageFormat.custom(300, 300));
    doc.Pages[0]!.CropBox = [50, 60, 250, 160];
    await ocrOne(doc);
    expectSpanAt(glyphs(doc, doc.Pages[0]!), (px, py) => [px + 50, 160 - py], 0, 20);
  });

  it('maps pixels at a non-default dpi (Review Focus 5)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    await ocrOne(doc, 144, [40, 60, 200, 100]); // the same box, doubled
    expectSpanAt(glyphs(doc, doc.Pages[0]!), (px, py) => [px, 100 - py], 0, 20);
  });

  it('is not moved by a CTM the page content leaves changed (Review Focus 2)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    const page = doc.Pages[0]!;
    page.Dict.set('Contents', doc.allocObject(streamOf(new TextEncoder().encode('2 0 0 2 0 0 cm'))));
    await ocrOne(doc);
    expectSpanAt(glyphs(doc, page), PAGE_OF[0]!, 0, 20);
  });

  it('survives Save and Open (Review Focus 1)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    doc.Pages[0]!.Rotate = 90;
    await ocrOne(doc);
    const back = Document.Open(doc.Save());
    expectSpanAt(glyphs(back, back.Pages[0]!), PAGE_OF[90]!, ANGLE[90]!, 20);
    // Since w7jf extraction lays a rotated baseline out in its own frame, so
    // the layer on a /Rotate 90 page reads back whole.
    expect(back.Pages[0]!.GetText()).toContain(TEXT);
  });
});

describe('MakeSearchable text and appearance (3ywf.3)', () => {
  it('round-trips Latin, Cyrillic, CJK, Arabic and an astral character', async () => {
    const lines = ['Hello', 'Привет', '漢字テキスト', 'مرحبا', '𝐀𝐁𝐂'];
    const doc = Document.New(PageFormat.custom(200, 100));
    await doc.MakeSearchable(fakeOcr(() => lines.map((t, i) => ({ text: t, box: [10, 10 + i * 15, 150, 22 + i * 15] as [number, number, number, number] }))), { dpi: 72 });
    const back = Document.Open(doc.Save());
    const text = back.Pages[0]!.GetText();
    for (const t of lines) expect(text).toContain(t);
    expect(back.Pages[0]!.Search('Привет')).toHaveLength(1);
  });

  it('extracts decomposed engine text composed (Review Focus 3)', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'café', box: [10, 10, 100, 30] }]), { dpi: 72 });
    expect(doc.Pages[0]!.GetText()).toContain('café');
    expect(doc.Pages[0]!.Search('café')).toHaveLength(1);
  });

  it('leaves the rendered page byte-identical', async () => {
    const doc = Document.New(PageFormat.custom(200, 100));
    doc.Pages[0]!.AddText('Visible', 20, 50);
    const before = doc.Pages[0]!.ToImage();
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'Hidden layer', box: [10, 10, 190, 40] }]), { force: true, dpi: 72 });
    expect(Buffer.compare(Buffer.from(doc.Pages[0]!.ToImage()), Buffer.from(before))).toBe(0);
  });
});

describe('MakeSearchable conformance (3ywf.3)', () => {
  const rules = (issues: { rule: string }[]): string[] => issues.map((i) => i.rule).sort();

  it('adds no PDF/A-2b issue', async () => {
    const doc = Document.Open(buildPdfaPdf({}, 2));
    const before = rules(doc.ValidatePdfA('2b').Issues);
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'Scanned', box: [10, 10, 100, 30] }]), { force: true, dpi: 72 });
    expect(rules(Document.Open(doc.Save()).ValidatePdfA('2b').Issues)).toEqual(before);
  });

  it('adds no PDF/UA issue to a tagged document, at either part', async () => {
    const doc = Document.Open(buildTaggedPdf());
    const before1 = rules(doc.ValidatePdfUa(1).Issues);
    const before2 = rules(doc.ValidatePdfUa(2).Issues);
    await doc.MakeSearchable(fakeOcr(() => [{ text: 'Scanned', box: [10, 10, 100, 30] }]), { force: true, dpi: 72 });
    const back = Document.Open(doc.Save());
    expect(rules(back.ValidatePdfUa(1).Issues)).toEqual(before1);
    expect(rules(back.ValidatePdfUa(2).Issues)).toEqual(before2);
  });

  it('marks the layer as an artifact in a tagged document only', async () => {
    const tagged = Document.Open(buildTaggedPdf());
    await tagged.MakeSearchable(fakeOcr(() => [{ text: 'Ω', box: [10, 10, 50, 30] }]), { force: true, dpi: 72 });
    const ours = glyphs(tagged, tagged.Pages[0]!).filter((g) => g.text === 'Ω');
    expect(ours.length).toBe(1);
    expect(ours[0]!.artifact).toBe(true);
    const plain = Document.New(PageFormat.custom(200, 100));
    await plain.MakeSearchable(fakeOcr(() => [{ text: 'x', box: [10, 10, 50, 30] }]), { dpi: 72 });
    expect(glyphs(plain, plain.Pages[0]!)[0]!.artifact).toBeUndefined();
  });
});
