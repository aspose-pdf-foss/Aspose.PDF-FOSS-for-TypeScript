import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { Document } from '../src/document.js';
import { Page } from '../src/page.js';
import { buildClassicPdf } from './helpers/build-pdf.js';
import { PdfDict, PdfStream, name } from '../src/types.js';

// Any opened document works as the owner; resolve() returns inline values as-is.
const doc = Document.Open(buildClassicPdf(1));
const dec = (u: Uint8Array) => new TextDecoder('latin1').decode(u);

function rawStream(text: string): PdfStream {
  const raw = new TextEncoder().encode(text);
  return { kind: 'stream', dict: new Map([['Length', raw.length]]), raw };
}

function flateStream(text: string): PdfStream {
  const raw = new Uint8Array(deflateSync(Buffer.from(text)));
  return {
    kind: 'stream',
    dict: new Map<string, any>([['Filter', name('FlateDecode')], ['Length', raw.length]]),
    raw,
  };
}

describe('Page', () => {
  it('exposes Number and Dict from construction', () => {
    const dict: PdfDict = new Map<string, any>([['Type', name('Page')]]);
    const page = new Page(doc, dict, 7);
    expect(page.Number).toBe(7);
    expect(page.Dict).toBe(dict);
  });

  it('reads MediaBox, and CropBox/Rect fall back to it', () => {
    const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]);
    const page = new Page(doc, dict, 1);
    expect(page.MediaBox).toEqual([0, 0, 200, 200]);
    expect(page.CropBox).toEqual([0, 0, 200, 200]);
    expect(page.Rect).toEqual([0, 0, 200, 200]);
  });

  it('defaults MediaBox to US Letter when absent', () => {
    const page = new Page(doc, new Map(), 1);
    expect(page.MediaBox).toEqual([0, 0, 612, 792]);
  });

  it('normalizes Rotate and defaults to 0', () => {
    expect(new Page(doc, new Map(), 1).Rotate).toBe(0);
    expect(new Page(doc, new Map<string, any>([['Rotate', 450]]), 1).Rotate).toBe(90);
    expect(new Page(doc, new Map<string, any>([['Rotate', -90]]), 1).Rotate).toBe(270);
  });

  it('Rotate setter writes the live dict and is observable via the getter', () => {
    const dict: PdfDict = new Map<string, any>([['Type', name('Page')]]);
    const page = new Page(doc, dict, 1);
    page.Rotate = 90;
    expect(page.Rotate).toBe(90);
    expect(dict.get('Rotate')).toBe(90);          // wrote the live dict
    page.Rotate = 450;
    expect(page.Rotate).toBe(90);                  // normalized
  });

  it('returns Resources dict or undefined', () => {
    const res: PdfDict = new Map<string, any>([['Font', new Map()]]);
    expect(new Page(doc, new Map<string, any>([['Resources', res]]), 1).Resources).toBe(res);
    expect(new Page(doc, new Map(), 1).Resources).toBeUndefined();
  });

  it('decodes a single Contents stream', () => {
    const dict: PdfDict = new Map<string, any>([['Contents', rawStream('Page 1')]]);
    expect(dec(new Page(doc, dict, 1).Contents)).toBe('Page 1');
  });

  it('concatenates a Contents array with newline separators and inflates Flate', () => {
    const dict: PdfDict = new Map<string, any>([['Contents', [flateStream('Hello'), flateStream('World')]]]);
    expect(dec(new Page(doc, dict, 1).Contents)).toBe('Hello\nWorld');
  });

  it('returns empty Contents when absent', () => {
    expect(new Page(doc, new Map(), 1).Contents.length).toBe(0);
  });

  it('returns Annotation dicts, or [] when absent', () => {
    const a1: PdfDict = new Map<string, any>([['Subtype', name('Text')]]);
    const a2: PdfDict = new Map<string, any>([['Subtype', name('Link')]]);
    expect(new Page(doc, new Map<string, any>([['Annots', [a1, a2]]]), 1).Annotations.map((x) => x.Dict)).toEqual([a1, a2]);
    expect(new Page(doc, new Map(), 1).Annotations).toEqual([]);
  });

  it('exposes its owning Document', () => {
    const d = Document.Open(buildClassicPdf(1));
    expect(d.Pages[0].Document).toBe(d);
  });
});

describe('Page box setters', () => {
  it('MediaBox setter writes the live dict and is observable via the getter', () => {
    const dict: PdfDict = new Map<string, any>([['Type', name('Page')]]);
    const page = new Page(doc, dict, 1);
    page.MediaBox = [0, 0, 300, 400];
    expect(page.MediaBox).toEqual([0, 0, 300, 400]);
    expect(dict.get('MediaBox')).toEqual([0, 0, 300, 400]); // wrote the live dict
  });

  it('CropBox setter is independent of MediaBox', () => {
    const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 600, 800]]]);
    const page = new Page(doc, dict, 1);
    page.CropBox = [10, 10, 290, 390];
    expect(page.CropBox).toEqual([10, 10, 290, 390]);
    expect(page.MediaBox).toEqual([0, 0, 600, 800]); // untouched
  });

  it('stores a copy: mutating the caller array afterwards does not change the page', () => {
    const page = new Page(doc, new Map(), 1);
    const box = [0, 0, 100, 100];
    page.MediaBox = box;
    box[2] = 999;
    expect(page.MediaBox).toEqual([0, 0, 100, 100]);
  });

  it('overrides an inherited MediaBox for that page only', () => {
    // buildClassicPdf puts MediaBox [0 0 200 200] on the /Pages root; leaves inherit it.
    const d = Document.Open(buildClassicPdf(2));
    d.Pages[0].MediaBox = [0, 0, 300, 300];
    expect(d.Pages[0].MediaBox).toEqual([0, 0, 300, 300]);
    expect(d.Pages[1].MediaBox).toEqual([0, 0, 200, 200]); // sibling still inherits
  });

  it('set boxes survive Save + reopen', () => {
    const d = Document.Open(buildClassicPdf(1));
    d.Pages[0].MediaBox = [0, 0, 300, 300];
    d.Pages[0].CropBox = [5, 5, 295, 295];
    const d2 = Document.Open(d.Save());
    expect(d2.Pages[0].MediaBox).toEqual([0, 0, 300, 300]);
    expect(d2.Pages[0].CropBox).toEqual([5, 5, 295, 295]);
  });

  it('throws TypeError on anything that is not 4 finite numbers', () => {
    const page = new Page(doc, new Map(), 1);
    expect(() => { page.MediaBox = [0, 0, 100] as any; }).toThrow(TypeError);            // wrong length
    expect(() => { page.MediaBox = [0, 0, 100, '100'] as any; }).toThrow(TypeError);     // non-number entry
    expect(() => { page.CropBox = [0, 0, 100, NaN]; }).toThrow(TypeError);               // NaN
    expect(() => { page.CropBox = [0, 0, Infinity, 100]; }).toThrow(TypeError);          // non-finite
    expect(() => { page.MediaBox = 'box' as any; }).toThrow(TypeError);                  // not an array
    expect(() => { page.MediaBox = [0, 0, 100] as any; }).toThrow(/MediaBox must be/);   // names the key
  });

  it('leaves the dict untouched when the setter throws', () => {
    const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]);
    const page = new Page(doc, dict, 1);
    expect(() => { page.MediaBox = [1, 2, 3] as any; }).toThrow(TypeError);
    expect(page.MediaBox).toEqual([0, 0, 200, 200]); // old value intact
  });
});

describe('BleedBox / TrimBox / ArtBox', () => {
  const KEYS = ['BleedBox', 'TrimBox', 'ArtBox'] as const;

  it('falls back to CropBox (then MediaBox) when absent', () => {
    const page = new Page(doc, new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]), 1);
    for (const k of KEYS) expect(page[k]).toEqual([0, 0, 200, 200]);
    const page2 = new Page(doc, new Map<string, any>([
      ['MediaBox', [0, 0, 200, 200]], ['CropBox', [10, 10, 190, 190]],
    ]), 1);
    for (const k of KEYS) expect(page2[k]).toEqual([10, 10, 190, 190]);
  });

  it('reads an own value; other boxes still fall back', () => {
    const page = new Page(doc, new Map<string, any>([
      ['MediaBox', [0, 0, 200, 200]], ['BleedBox', [5, 5, 195, 195]],
    ]), 1);
    expect(page.BleedBox).toEqual([5, 5, 195, 195]);
    expect(page.TrimBox).toEqual([0, 0, 200, 200]);
    expect(page.ArtBox).toEqual([0, 0, 200, 200]);
  });

  it('is NOT inherited from an ancestor /Pages node', () => {
    // MediaBox IS inheritable (the CropBox fallback resolves through the
    // parent), but the parent's BleedBox must be ignored.
    const parent: PdfDict = new Map<string, any>([
      ['MediaBox', [0, 0, 200, 200]], ['BleedBox', [1, 1, 9, 9]],
    ]);
    const page = new Page(doc, new Map<string, any>([['Parent', parent]]), 1);
    expect(page.BleedBox).toEqual([0, 0, 200, 200]);
  });

  it('setter writes the live dict and the getter reflects it (all three keys)', () => {
    for (const k of KEYS) {
      const dict: PdfDict = new Map<string, any>([['MediaBox', [0, 0, 200, 200]]]);
      const page = new Page(doc, dict, 1);
      page[k] = [5, 6, 100, 101];
      expect(page[k]).toEqual([5, 6, 100, 101]);
      expect(dict.get(k)).toEqual([5, 6, 100, 101]);
    }
  });

  it('stores a defensive copy', () => {
    const page = new Page(doc, new Map<string, any>(), 1);
    const box = [1, 2, 3, 4];
    page.TrimBox = box;
    box[0] = 99;
    expect(page.TrimBox).toEqual([1, 2, 3, 4]);
  });

  it('throws TypeError on invalid input, leaving the dict untouched', () => {
    const dict: PdfDict = new Map<string, any>();
    const page = new Page(doc, dict, 1);
    const bad: any[] = [[1, 2, 3], [1, 2, 3, '4'], [1, 2, 3, NaN], [1, 2, 3, Infinity], 'nope', null];
    for (const b of bad) expect(() => { (page as any).ArtBox = b; }).toThrow(TypeError);
    expect(dict.has('ArtBox')).toBe(false);
  });

  it('survives Save + reopen', () => {
    const d = Document.Open(buildClassicPdf(1));
    d.Pages[0].BleedBox = [2, 2, 198, 198];
    d.Pages[0].ArtBox = [3, 3, 197, 197];
    const re = Document.Open(d.Save());
    expect(re.Pages[0].BleedBox).toEqual([2, 2, 198, 198]);
    expect(re.Pages[0].ArtBox).toEqual([3, 3, 197, 197]);
  });
});

import * as api from '../src/index.js';

describe('index exports', () => {
  it('re-exports the Page class', () => {
    expect(api.Page).toBe(Page);
  });
});
