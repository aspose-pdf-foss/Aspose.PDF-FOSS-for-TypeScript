import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { isDict, isStream, type PdfDict } from '../src/types.js';
import {
  buildComposeSource, buildComposeTargetWithContent,
} from './helpers/build-compose-pdf.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

/** The single XObject registered under the page's /Resources /XObject, with its key. */
function stampedXObject(doc: Document, page: import('../src/page.js').Page): { key: string; dict: PdfDict } {
  const res = doc.resolve(page.Dict.get('Resources')) as PdfDict;
  const xobjs = doc.resolve(res.get('XObject')) as PdfDict;
  const [key] = [...xobjs.keys()];
  const xobj = doc.resolve(xobjs.get(key));
  return { key, dict: (xobj as { dict: PdfDict }).dict };
}

describe('page.StampWith', () => {
  it('overlays src as a Form XObject painted after existing content', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource());
    const page = target.Pages[0];

    page.StampWith(src.Pages[0]);

    const { key } = stampedXObject(target, page);
    expect(key).toMatch(/^Fm\d+$/);
    const c = dec(page.Contents);
    expect(c).toContain(`/${key} Do`);
    // overlay draws after the page's own content
    expect(c.indexOf('TARGET')).toBeLessThan(c.indexOf(`/${key} Do`));
  });

  it('underlays src before existing content when mode is underlay', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource());
    const page = target.Pages[0];

    page.StampWith(src.Pages[0], { mode: 'underlay' });

    const { key } = stampedXObject(target, page);
    const c = dec(page.Contents);
    expect(c.indexOf(`/${key} Do`)).toBeLessThan(c.indexOf('TARGET'));
  });

  it('defaults the placement to fit the source BBox onto the page CropBox', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource()); // BBox [0 0 200 100]
    const page = target.Pages[0];                    // CropBox [0 0 300 300]

    page.StampWith(src.Pages[0]);

    // 200x100 -> 300x300 : sx = 1.5, sy = 3, origin (0,0)
    const c = dec(page.Contents);
    expect(c).toMatch(/1\.5 0 0 3 0 0 cm/);
  });

  it('maps the source BBox onto an explicit rect', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource()); // BBox [0 0 200 100]
    const page = target.Pages[0];

    page.StampWith(src.Pages[0], { rect: [50, 50, 150, 100] });

    // 200x100 -> 100x50 : sx = 0.5, sy = 0.5, origin (50,50)
    const c = dec(page.Contents);
    expect(c).toMatch(/0\.5 0 0 0\.5 50 50 cm/);
  });

  it('applies an extra clockwise rotation to the placed content', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource()); // BBox [0 0 200 100]
    const page = target.Pages[0];                    // CropBox [0 0 300 300]

    page.StampWith(src.Pages[0], { rotate: 90 });

    // rotate 90 cw swaps the fitted extent (100 wide x 200 tall) before the
    // CropBox fit; cm = rotate · placement = [0 -1.5 3 0 0 300].
    const c = dec(page.Contents);
    expect(c).toMatch(/0 -1\.5 3 0 0 300 cm/);
  });

  it('rejects a malformed rect and an invalid rotate', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource());
    const page = target.Pages[0];
    expect(() => page.StampWith(src.Pages[0], { rect: [0, 0, 1] as never })).toThrow(TypeError);
    expect(() => page.StampWith(src.Pages[0], { rotate: 45 as never })).toThrow(TypeError);
  });

  it('registers an /ExtGState and emits gs for opacity < 1', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource());
    const page = target.Pages[0];

    page.StampWith(src.Pages[0], { opacity: 0.5 });

    const res = target.resolve(page.Dict.get('Resources')) as PdfDict;
    const gs = target.resolve(res.get('ExtGState'));
    expect(isDict(gs)).toBe(true);
    const c = dec(page.Contents);
    expect(c).toMatch(/\/GS\d+ gs/);
  });

  it('leaves the source document untouched', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource());
    const before = dec(src.Pages[0].Contents);

    target.Pages[0].StampWith(src.Pages[0]);

    expect(dec(src.Pages[0].Contents)).toBe(before);
    expect(src.Pages[0].Dict.has('XObject')).toBe(false);
  });

  it('round-trips: the stamped content survives Save/Open', () => {
    const target = Document.Open(buildComposeTargetWithContent());
    const src = Document.Open(buildComposeSource());
    target.Pages[0].StampWith(src.Pages[0]);

    const reopened = Document.Open(target.Save());
    const page = reopened.Pages[0];
    // the page still draws the imported XObject ...
    expect(dec(page.Contents)).toContain(' Do');
    // ... and that XObject still carries the imported "Hi" content
    const res = reopened.resolve(page.Dict.get('Resources')) as PdfDict;
    const xobjs = reopened.resolve(res.get('XObject')) as PdfDict;
    const fm = reopened.resolve([...xobjs.values()][0]);
    expect(isStream(fm)).toBe(true);
    expect(dec((fm as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
  });
});
