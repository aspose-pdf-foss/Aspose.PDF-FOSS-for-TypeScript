import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { RedactAnnotation } from '../src/annotation.js';
import { buildRedactReadTarget } from './helpers/build-redact-annot.js';
import { buildMultiStreamPage } from './helpers/build-edit-pdf.js';
import { isStream, PdfDict, PdfStream } from '../src/types.js';
import { inflateStream } from '../src/flate.js';

describe('RedactAnnotation read model', () => {
  it('wraps a /Redact annotation and exposes every key', () => {
    const doc = Document.Open(buildRedactReadTarget());
    const a = doc.Pages[0].Annotations[0];
    expect(a).toBeInstanceOf(RedactAnnotation);

    const r = a as RedactAnnotation;
    expect(r.Subtype).toBe('Redact');
    expect(r.QuadPoints).toEqual([50, 130, 200, 130, 50, 100, 200, 100]);
    expect(r.InteriorColor).toEqual([0, 0, 1]);
    expect(r.OverlayText).toBe('CLASSIFIED');
    expect(r.Repeat).toBe(true);
    expect(r.Alignment).toBe('center');
    expect(r.FontSize).toBe(9);
    expect(r.TextColor).toEqual([1, 1, 1]);
    expect(r.Author).toBe('auditor');
    expect(r.Overlay).toBeUndefined();
  });

  it('round-trips setter writes through Save/Open', () => {
    const doc = Document.Open(buildRedactReadTarget());
    const r = doc.Pages[0].Annotations[0] as RedactAnnotation;
    r.OverlayText = 'REDACTED';
    r.Alignment = 'right';
    r.Repeat = false;
    r.InteriorColor = [1, 0, 0];

    const back = Document.Open(doc.Save()).Pages[0].Annotations[0] as RedactAnnotation;
    expect(back.OverlayText).toBe('REDACTED');
    expect(back.Alignment).toBe('right');
    expect(back.Repeat).toBe(false);
    expect(back.InteriorColor).toEqual([1, 0, 0]);
  });

  it('rejects malformed QuadPoints without writing them', () => {
    const doc = Document.Open(buildRedactReadTarget());
    const r = doc.Pages[0].Annotations[0] as RedactAnnotation;
    expect(() => { r.QuadPoints = [1, 2, 3]; }).toThrow(TypeError);
    expect(r.QuadPoints).toEqual([50, 130, 200, 130, 50, 100, 200, 100]);
  });
});

describe('page.AddRedact', () => {
  const page1 = () => Document.Open(
    buildMultiStreamPage(['BT /F1 10 Tf 50 100 Td (TopSecret) Tj ET']));

  it('writes every /Redact key and returns a live handle', () => {
    const doc = page1();
    const r = doc.Pages[0].AddRedact({
      rect: [40, 95, 200, 115], fill: [0, 0, 0], overlayText: 'REDACTED',
      align: 'center', fontSize: 8, textColor: [1, 1, 1], author: 'auditor',
    });

    expect(r).toBeInstanceOf(RedactAnnotation);
    expect(r.Subtype).toBe('Redact');
    expect(r.Rect).toEqual([40, 95, 200, 115]);
    expect(r.QuadPoints).toEqual([40, 115, 200, 115, 40, 95, 200, 95]);
    expect(r.InteriorColor).toEqual([0, 0, 0]);
    expect(r.OverlayText).toBe('REDACTED');
    expect(r.Alignment).toBe('center');
    expect(r.FontSize).toBe(8);
    expect(r.Author).toBe('auditor');
    expect(r.Color).toEqual([1, 0, 0]); // mark outline defaults to red
  });

  it('MARKING REMOVES NOTHING — the text survives a save/open round trip', () => {
    // The assertion this whole feature exists to keep true. If AddRedact ever
    // starts deleting content, mark mode has silently become apply mode.
    const doc = page1();
    doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115], overlayText: 'REDACTED' });

    const back = Document.Open(doc.Save());
    expect(back.Pages[0].GetText()).toContain('TopSecret');
    expect(back.Pages[0].Annotations).toHaveLength(1);
  });

  it('installs a stroked, unfilled /AP so a mark cannot pass for a redaction', () => {
    const doc = page1();
    const r = doc.Pages[0].AddRedact({ rect: [40, 95, 200, 115] });
    const ap = doc.resolve((doc.resolve(r.Dict.get('AP')) as PdfDict).get('N'));
    expect(isStream(ap)).toBe(true);
    const body = new TextDecoder('latin1').decode(inflateStream(ap as PdfStream));
    expect(body).toContain('1 0 0 RG');
    expect(body).not.toContain(' rg');
  });

  it('rejects quads and rect together, adding no annotation', () => {
    const doc = page1();
    expect(() => doc.Pages[0].AddRedact({
      rect: [0, 0, 10, 10], quads: [0, 10, 10, 10, 0, 0, 10, 0],
    })).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('rejects neither quads nor rect, adding no annotation', () => {
    const doc = page1();
    expect(() => doc.Pages[0].AddRedact({})).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });

  it('rejects a bad fill colour before allocating anything', () => {
    const doc = page1();
    expect(() => doc.Pages[0].AddRedact({
      rect: [0, 0, 10, 10], fill: [2, 0, 0],
    })).toThrow(TypeError);
    expect(doc.Pages[0].Annotations).toHaveLength(0);
  });
});
