import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { importPageAsXObject } from '../src/compose.js';
import { isDict, isName, isStream, type PdfDict, type PdfStream } from '../src/types.js';
import { buildComposeSource, buildComposeTarget } from './helpers/build-compose-pdf.js';

const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

describe('importPageAsXObject', () => {
  it('imports a page as a /Form XObject with BBox = source CropBox and its content', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const ref = importPageAsXObject(target, src.Pages[0]);

    const xobj = target.resolve(ref);
    expect(isStream(xobj)).toBe(true);
    const d = (xobj as PdfStream).dict;
    expect(isName(d.get('Subtype')) && (d.get('Subtype') as { name: string }).name).toBe('Form');
    expect(d.get('BBox')).toEqual([0, 0, 200, 100]);
    expect(dec((xobj as PdfStream).raw)).toContain('(Hi) Tj');
  });

  it('deep-copies the source resources into the target document', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const ref = importPageAsXObject(target, src.Pages[0]);

    const d = (target.resolve(ref) as PdfStream).dict;
    const res = target.resolve(d.get('Resources'));
    expect(isDict(res)).toBe(true);
    const fonts = target.resolve((res as PdfDict).get('Font'));
    expect(isDict(fonts)).toBe(true);
    const f1 = target.resolve((fonts as PdfDict).get('F1'));
    expect(isDict(f1)).toBe(true); // the Helvetica font dict now lives in target
  });

  it('leaves the source document untouched', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const beforeContent = dec(src.Pages[0].Contents);
    importPageAsXObject(target, src.Pages[0]);
    expect(dec(src.Pages[0].Contents)).toBe(beforeContent);
    // source resources intact and still resolvable
    const srcFonts = src.resolve(src.Pages[0].Resources!.get('Font'));
    expect(isDict(srcFonts)).toBe(true);
  });

  it('orients content per /Rotate via /Matrix', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource(90)); // CropBox [0 0 200 100], w=200 h=100
    const ref = importPageAsXObject(target, src.Pages[0]);
    const d = (target.resolve(ref) as PdfStream).dict;
    // translate(0,0) then rotate 90 -> [0,1,-1,0, h, 0] with h=100
    expect(d.get('Matrix')).toEqual([0, 1, -1, 0, 100, 0]);
  });

  it('round-trips: imported XObject survives Save/Open', () => {
    const target = Document.Open(buildComposeTarget());
    const src = Document.Open(buildComposeSource());
    const ref = importPageAsXObject(target, src.Pages[0]);
    // reference it so mark-sweep keeps it, then round-trip
    target.Pages[0].Dict.set('Keep', ref);
    const reopened = Document.Open(target.Save());
    const kept = reopened.resolve(reopened.Pages[0].Dict.get('Keep'));
    expect(isStream(kept)).toBe(true);
    expect(dec((kept as { raw: Uint8Array }).raw)).toContain('(Hi) Tj');
  });
});
