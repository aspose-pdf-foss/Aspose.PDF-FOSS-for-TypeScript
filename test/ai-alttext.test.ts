import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { PageFormat } from '../src/pageformat.js';
import type { StructElement } from '../src/struct.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { scriptedModel, userTextOf } from './helpers/scripted-model.js';
import { buildPng, buildPngRgb } from './helpers/build-embed-images.js';
import { buildTaggedPdf } from './helpers/build-tagged-pdf.js';
import type { AiRequest } from '../src/aimodel.js';

const RED = buildPngRgb();
const BLUE = buildPng(2, 1, 2, [0, 0, 255, 0, 0, 255]);
const alt = (s: string): string => JSON.stringify({ alt: s, decorative: false });
const imagesSent = (r: AiRequest): { bytes: Uint8Array; mediaType: string }[] => {
  const user = r.messages.find((m) => m.role === 'user')!;
  return Array.isArray(user.content)
    ? user.content.filter((p) => p.type === 'image') as { bytes: Uint8Array; mediaType: string }[]
    : [];
};

function figures(doc: Document): StructElement[] {
  const out: StructElement[] = [];
  const walk = (els: StructElement[]): void => {
    for (const e of els) { if (e.StandardType === 'Figure') out.push(e); else walk(e.Children); }
  };
  walk(doc.GetStructTree()!.Children);
  return out;
}

/** A tagged page per entry; each image is drawn into its own /Figure. */
function taggedDoc(...pages: Uint8Array[][]): Document {
  const doc = Document.New(PageFormat.custom(400, 400));
  const root = doc.CreateStructTree();
  pages.forEach((imgs, p) => {
    const page = p === 0 ? doc.Pages[0]! : doc.AddPage(PageFormat.custom(400, 400)).page;
    imgs.forEach((png, i) => page.AddImage(png, [20 + i * 150, 20, 100, 100], { tag: root.Append('Figure') }));
  });
  return doc;
}

describe('GenerateAltText, tagged (3ywf.4)', () => {
  it('fills a missing /Alt, clears IllustrationAlt, and survives Save/Open', async () => {
    const doc = taggedDoc([RED]);
    expect(doc.ValidatePdfUa(1).Issues.some((i) => i.rule === 'IllustrationAlt')).toBe(true);
    const r = await doc.GenerateAltText(scriptedModel(() => alt('A red square.')));
    expect(r.figures).toEqual([{ page: 1, status: 'described', alt: 'A red square.' }]);
    expect(doc.ValidatePdfUa(1).Issues.some((i) => i.rule === 'IllustrationAlt')).toBe(false);
    expect(figures(Document.Open(doc.Save()))[0]!.Alt).toBe('A red square.');
  });

  it('keeps an author\'s /Alt unless overwrite', async () => {
    const doc = taggedDoc([RED]);
    figures(doc)[0]!.Alt = 'Author text';
    const m = scriptedModel(() => alt('Model text'));
    expect((await doc.GenerateAltText(m)).figures).toEqual([]);
    expect(m.requests).toHaveLength(0);
    await doc.GenerateAltText(m, { overwrite: true });
    expect(figures(doc)[0]!.Alt).toBe('Model text');
  });

  it('describes one picture once however many figures show it', async () => {
    const doc = taggedDoc([RED, RED], [RED]);
    const m = scriptedModel(() => alt('A red square.'));
    const r = await doc.GenerateAltText(m);
    expect(m.requests).toHaveLength(1);
    expect(r.requests).toBe(1);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.', 'A red square.', 'A red square.']);
  });

  it('makes one request per distinct picture', async () => {
    const m = scriptedModel((_, n) => alt(`Picture ${n}.`));
    await taggedDoc([RED, BLUE]).GenerateAltText(m);
    expect(m.requests).toHaveLength(2);
  });

  it('sends a cropped render for a figure that draws no image', async () => {
    const doc = Document.New(PageFormat.A4);
    const fig = doc.CreateStructTree().Append('Figure');
    doc.Pages[0]!.AddBarcode({ type: 'code128', data: 'ABC-123' }, [50, 300, 200, 60], { tag: fig });
    const m = scriptedModel(() => alt('A barcode.'));
    await doc.GenerateAltText(m);
    const sent = imagesSent(m.requests[0]!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.mediaType).toBe('image/png');
    const v = new DataView(sent[0]!.bytes.buffer, sent[0]!.bytes.byteOffset);
    expect(v.getUint32(16)).toBeLessThan(600); // cropped: the full A4 page at scale 2 is 1190 wide
    expect(fig.Alt).toBe('A barcode.');
  });

  it('skips a figure with no image and no extent', async () => {
    const doc = Document.Open(buildTaggedPdf());
    const m = scriptedModel(() => alt('x'));
    const r = await doc.GenerateAltText(m, { overwrite: true });
    expect(r.figures).toEqual([{ page: 1, status: 'skipped', reason: 'no image and no bounding box' }]);
    expect(m.requests).toHaveLength(0);
  });

  it('reports a decorative picture and leaves its figure alone', async () => {
    const doc = taggedDoc([RED]);
    const r = await doc.GenerateAltText(scriptedModel(() => JSON.stringify({ alt: '', decorative: true })));
    expect(r.figures).toEqual([{ page: 1, status: 'decorative' }]);
    expect(figures(doc)[0]!.Alt).toBeUndefined();
  });

  it('records a failure and carries on', async () => {
    const r = await taggedDoc([RED, BLUE]).GenerateAltText(scriptedModel((_, n) => (n === 1 ? 'garbage' : alt('Blue.'))));
    expect(r.figures.map((f) => f.status)).toEqual(['failed', 'described']);
    expect(r.figures[0]!.reason).toMatch(/shape/);
  });

  it('sends the page text as context and asks in the document language', async () => {
    const doc = taggedDoc([RED]);
    doc.Pages[0]!.AddText('Figure 1: quarterly revenue', 20, 300);
    doc.Lang = 'de-DE';
    const m = scriptedModel(() => alt('x'));
    await doc.GenerateAltText(m);
    expect(userTextOf(m.requests[0]!)).toContain('quarterly revenue');
    expect(userTextOf(m.requests[0]!)).toContain('de-DE');
    const m2 = scriptedModel(() => alt('x'));
    await doc.GenerateAltText(m2, { overwrite: true, language: 'French' });
    expect(userTextOf(m2.requests[0]!)).toContain('French');
  });

  it('describes only the selected pages', async () => {
    const doc = taggedDoc([RED], [BLUE]);
    const r = await doc.GenerateAltText(scriptedModel(() => alt('x')), { pages: [2] });
    expect(r.figures.map((f) => f.page)).toEqual([2]);
    expect(figures(doc)[0]!.Alt).toBeUndefined();
  });

  it('makes no request on a second run (Review Focus 5)', async () => {
    const doc = taggedDoc([RED, BLUE]);
    await doc.GenerateAltText(scriptedModel(() => alt('x')));
    const m = scriptedModel(() => alt('y'));
    expect((await doc.GenerateAltText(m)).figures).toEqual([]);
    expect(m.requests).toHaveLength(0);
  });

  it('stops on abort, keeping what it finished', async () => {
    const ctrl = new AbortController();
    const seen: string[] = [];
    const doc = taggedDoc([RED, BLUE]);
    const m = scriptedModel((_, n) => { if (n === 1) ctrl.abort(new Error('stop')); return alt('Red.'); });
    await expect(doc.GenerateAltText(m, { signal: ctrl.signal, onFigure: (f) => seen.push(f.status) })).rejects.toThrow('stop');
    expect(seen).toEqual(['described']);
    expect(figures(doc)[0]!.Alt).toBe('Red.');
  });
});

describe('GenerateAltText, untagged (3ywf.4)', () => {
  function untagged(...imgs: Uint8Array[]): Document {
    const doc = Document.New(PageFormat.custom(400, 400));
    doc.Pages[0]!.AddText('Body text', 20, 300);
    imgs.forEach((png, i) => doc.Pages[0]!.AddImage(png, [20 + i * 150, 20, 100, 100]));
    return doc;
  }

  it('describes each picture and then auto-tags the document', async () => {
    const doc = untagged(RED);
    const r = await doc.GenerateAltText(scriptedModel(() => alt('A red square.')));
    expect(r.figures).toEqual([{ page: 1, status: 'described', alt: 'A red square.' }]);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.']);
  });

  it('describes a picture drawn on two pages once, and tags both (Review Focus 5)', async () => {
    const doc = untagged(RED);
    doc.AddPage(PageFormat.custom(400, 400)).page.AddImage(RED, [20, 20, 100, 100]);
    const m = scriptedModel(() => alt('A red square.'));
    await doc.GenerateAltText(m);
    expect(m.requests).toHaveLength(1);
    expect(figures(doc).map((f) => f.Alt)).toEqual(['A red square.', 'A red square.']);
  });

  it('artifacts a decorative picture', async () => {
    const doc = untagged(RED);
    const r = await doc.GenerateAltText(scriptedModel(() => JSON.stringify({ alt: '', decorative: true })));
    expect(r.figures[0]!.status).toBe('decorative');
    expect(figures(doc)).toEqual([]);
    expect(doc.GetStructTree()).not.toBeNull();
  });

  it('does not auto-tag when the run was aborted after its last request', async () => {
    const ctrl = new AbortController();
    const doc = untagged(RED);
    const m = scriptedModel(() => { ctrl.abort(new Error('stop')); return alt('A red square.'); });
    await expect(doc.GenerateAltText(m, { signal: ctrl.signal })).rejects.toThrow('stop');
    expect(doc.GetStructTree()).toBeNull();
  });

  it('refuses with autoTag false, and refuses a page selection', async () => {
    const m = scriptedModel(() => alt('x'));
    await expect(untagged(RED).GenerateAltText(m, { autoTag: false })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    await expect(untagged(RED).GenerateAltText(m, { pages: [1] })).rejects.toThrow(RangeError);
    expect(m.requests).toHaveLength(0);
  });
});

describe('GenerateAltText, refusals (3ywf.4)', () => {
  it('refuses a document with signature fields', async () => {
    const doc = taggedDoc([RED]);
    doc.Form.AddSignatureField({ page: 1, rect: [300, 300, 380, 340], name: 'S' });
    await expect(doc.GenerateAltText(scriptedModel(() => alt('x')))).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });
  it('validates its options before any request', async () => {
    const m = scriptedModel(() => alt('x'));
    const doc = taggedDoc([RED]);
    await expect(doc.GenerateAltText({} as never)).rejects.toThrow(TypeError);
    await expect(doc.GenerateAltText(m, { overwrite: 'yes' as never })).rejects.toThrow(TypeError);
    await expect(doc.GenerateAltText(m, { language: 5 as never })).rejects.toThrow(TypeError);
    await expect(doc.GenerateAltText(m, { onFigure: 5 as never })).rejects.toThrow(TypeError);
    expect(m.requests).toHaveLength(0);
  });
});
