// krf2.3: heuristic watermark detection -- untagged content repeated across
// pages (the same Form or image XObject at the same place, or the same text at
// the same place) reported as candidates, and a repeated XObject draw removable.
import { describe, expect, it } from 'vitest';
import { Document } from '../src/document.js';
import type { WatermarkCandidate } from '../src/watermarkdetect.js';
import { PageFormat } from '../src/pageformat.js';
import { buildDecorateTarget } from './helpers/build-decorate-pdf.js';
import { buildPngRgb } from './helpers/build-embed-images.js';
import { buildRepeatedFormsPdf } from './helpers/build-artifact-remove-pdf.js';

/** `n` pages, each with body text that differs per page. Not
 *  `buildDecorateTarget`, whose pages carry a `P1`, `P2`, ... label at one
 *  spot -- a running mark this detector rightly reports. */
function doc(n = 3): Document {
  const d = Document.New();
  for (let i = 0; i < n; i++) d.AddPage(PageFormat.custom(400, 300));
  d.Pages.forEach((p, i) => p.AddText(`body text number ${'x'.repeat(i + 1)}`, 20, 150 + 10 * i));
  return d;
}

it('reports a page label repeated with only its number changing', () => {
  const d = Document.Open(buildDecorateTarget({ count: 3 }));
  expect(d.FindWatermarks().map((w) => w.kind === 'text' && w.occurrences.map((o) => o.text)))
    .toEqual([['P1', 'P2', 'P3']]);
});
const kinds = (c: WatermarkCandidate[]) => c.map((w) => `${w.kind}:${w.pages.join(',')}`);

describe('doc.FindWatermarks', () => {
  it('finds an image drawn at the same place on every page', () => {
    const d = doc();
    d.AddWatermark({ image: buildPngRgb() });
    const found = d.FindWatermarks();
    expect(kinds(found)).toEqual(['xobject:1,2,3']);
    const [w] = found;
    expect(w.kind === 'xobject' && w.subtype).toBe('Image');
    expect(w.occurrences.map((o) => o.page)).toEqual([1, 2, 3]);
  });

  it('finds a repeated Form XObject placed from one template', () => {
    const d = doc();
    const t = d.NewTemplate(50, 20);
    t.page.AddText('CONFIDENTIAL', 0, 5);
    for (const p of d.Pages) t.PlaceOn(p, [10, 10, 50, 20]);
    const found = d.FindWatermarks();
    expect(kinds(found)).toEqual(['xobject:1,2,3']);
    expect(found[0].kind === 'xobject' && found[0].subtype).toBe('Form');
  });

  it('finds the same text at the same place, and reports each occurrence’s own text', () => {
    const d = doc();
    d.AddWatermark({ text: 'DRAFT' });
    d.AddHeaderFooter({ footer: { center: 'Page {page} of {total}' } });
    const found = d.FindWatermarks().filter((w) => w.kind === 'text');
    expect(found.map((w) => w.occurrences.map((o) => o.text))).toEqual(
      expect.arrayContaining([
        ['DRAFT', 'DRAFT', 'DRAFT'],
        ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3'],
      ]));
    expect(found).toHaveLength(2);
  });

  it('does not report text that differs in more than its digits', () => {
    const d = doc();
    expect(d.FindWatermarks()).toEqual([]);
  });

  it('needs at least half the pages, and never fewer than two', () => {
    const d = doc(4);
    d.AddWatermark({ image: buildPngRgb(), pages: [1] });
    expect(d.FindWatermarks()).toEqual([]);
    const e = doc(4);
    e.AddWatermark({ image: buildPngRgb(), pages: [1, 3] });
    expect(kinds(e.FindWatermarks())).toEqual(['xobject:1,3']);
    expect(e.FindWatermarks({ minPages: 3 })).toEqual([]);
    const one = doc(1);
    one.AddWatermark({ image: buildPngRgb() });
    expect(one.FindWatermarks()).toEqual([]);
  });

  it('does not match the same thing at a different place', () => {
    const d = doc(2);
    d.AddWatermark({ text: 'DRAFT', position: 'top-left', pages: [1] });
    d.AddWatermark({ text: 'DRAFT', position: 'bottom-right', pages: [2] });
    expect(d.FindWatermarks()).toEqual([]);
  });

  it('skips decoration already marked as an artifact', () => {
    const d = doc();
    d.AddWatermark({ image: buildPngRgb(), artifact: true });
    d.AddHeaderFooter({ footer: { center: '{page}' }, artifact: true });
    expect(d.FindWatermarks()).toEqual([]);
  });

  it('skips tagged content and finds what was stamped after tagging', () => {
    const d = doc();
    d.AddHeaderFooter({ footer: { center: 'Footer' } });
    d.Lang = 'en';
    d.AutoTag();
    expect(d.FindWatermarks()).toEqual([]);
    d.AddWatermark({ text: 'LATER' });
    expect(d.FindWatermarks().map((w) => w.kind === 'text' && w.occurrences[0].text)).toEqual(['LATER']);
  });

  it('places a form through its /Matrix and the CTM, and skips a tagged draw', () => {
    const d = Document.Open(buildRepeatedFormsPdf());
    const found = d.FindWatermarks();
    expect(kinds(found)).toEqual(['xobject:1,2']);
    expect(found[0].bbox).toEqual([16, 20, 36, 30]);
  });

  it('defaults to half the pages, rounded up, when that is more than two', () => {
    const d = doc(6);
    d.AddWatermark({ image: buildPngRgb(), pages: [1, 2] });
    expect(d.FindWatermarks()).toEqual([]);
    d.AddWatermark({ image: buildPngRgb(), pages: [3, 4, 5] });
    expect(kinds(d.FindWatermarks())).toEqual(['xobject:3,4,5']);
  });

  it('scopes to `pages`, counting the threshold against the selection', () => {
    const d = doc(4);
    d.AddWatermark({ image: buildPngRgb(), pages: [3, 4] });
    expect(kinds(d.FindWatermarks({ pages: '3-4' }))).toEqual(['xobject:3,4']);
  });

  it('refuses a bad option before reading anything', () => {
    const d = doc();
    expect(() => d.FindWatermarks({ minPages: 1 })).toThrow(RangeError);
    expect(() => d.FindWatermarks({ minPages: 2.5 })).toThrow(TypeError);
    expect(() => d.FindWatermarks({ tolerance: -1 })).toThrow(RangeError);
  });
});

describe('XObject candidate Remove()', () => {
  it('removes every occurrence, its q/cm/Q wrapper and the image itself', () => {
    const d = doc();
    d.AddWatermark({ image: buildPngRgb(), mode: 'overlay', opacity: 0.5 });
    const [w] = d.FindWatermarks();
    if (w.kind !== 'xobject') throw new Error('expected an xobject candidate');
    expect(w.Remove()).toBe(3);
    for (const p of d.Pages) {
      expect(p.Images).toHaveLength(0);
      expect(p.GetText()).toContain('body text');
      expect(new TextDecoder('latin1').decode(p.Contents)).not.toMatch(/\bDo\b|\bgs\b/);
    }
    const again = Document.Open(d.Save());
    expect(again.FindWatermarks()).toEqual([]);
    expect([...again.objectEntries()].some(([, o]) =>
      typeof o === 'object' && o !== null && 'kind' in o && o.kind === 'stream'
      && (o.dict.get('Subtype') as { name?: string } | undefined)?.name === 'Image')).toBe(false);
  });

  it('refuses when the page changed since detection, removing nothing', () => {
    const d = doc();
    d.AddWatermark({ image: buildPngRgb() });
    const [w] = d.FindWatermarks();
    if (w.kind !== 'xobject') throw new Error('expected an xobject candidate');
    d.Pages[1].RemoveArtifacts(() => true);
    d.AddWatermark({ text: 'shift', pages: [2], mode: 'underlay' });
    expect(() => w.Remove()).toThrow(RangeError);
    expect(d.Pages[0].Images).toHaveLength(1);
  });
});
