import { describe, it, expect } from 'vitest';
import { makeOttoWithCff } from './helpers/build-sfnt.js';
import { buildFontPdf } from './helpers/build-font-pdf.js';
import { parseSfnt } from '../src/sfnt.js';
import { Document } from '../src/document.js';
import { UnsupportedFeatureError } from '../src/errors.js';
import { decodePng } from './helpers/decode-png.js';

// dmin.5: dmin.3 declined reading CFF2. A CFF2 font used to reach SfntFont's
// "neither a glyf nor a CFF table" PdfParseError, which calls a well-formed
// font broken. The refusal is now a named one.

describe('CFF2 is refused by name', () => {
  it('parseSfnt throws UnsupportedFeatureError naming CFF2', () => {
    const f = makeOttoWithCff('CFF2');
    expect(() => parseSfnt(f)).toThrow(UnsupportedFeatureError);
    expect(() => parseSfnt(f)).toThrow(/CFF2/);
  });

  it('AddFont surfaces the same refusal to the caller', () => {
    const doc = Document.New();
    expect(() => doc.AddFont(makeOttoWithCff('CFF2'))).toThrow(UnsupportedFeatureError);
    expect(() => doc.AddFont(makeOttoWithCff('CFF2'))).toThrow(/CFF2/);
  });

  it('a font with NEITHER outline table is still a parse error, not a CFF2 one', () => {
    // Only the CFF2 table turns the refusal into UnsupportedFeatureError; an
    // outline-less font is genuinely broken.
    const f = makeOttoWithCff('CFF2');
    const t = new TextDecoder('latin1');
    const bytes = new Uint8Array(f);
    // Re-tag the CFF2 directory entry to an unrelated table.
    const at = t.decode(bytes).indexOf('CFF2');
    bytes.set([0x7A, 0x7A, 0x7A, 0x7A], at); // 'zzzz'
    expect(() => parseSfnt(bytes)).toThrow(/neither a glyf nor a CFF/);
    expect(() => parseSfnt(bytes)).not.toThrow(UnsupportedFeatureError);
  });
});

describe('an embedded CFF2 program degrades rather than throwing', () => {
  const pdf = (): Uint8Array =>
    buildFontPdf({ openTypeProgram: makeOttoWithCff('CFF2'), text: 'AB' });

  it('opens, extracts its text and renders', () => {
    const doc = Document.Open(pdf());
    const page = doc.Pages[0];
    expect(page.GetText()).toContain('AB');
    expect(() => page.ToSvg()).not.toThrow();
  });

  it('renders exactly as the same font with NO program — the refusal is caught at the program, not the page', () => {
    // "Does not throw" cannot see this: renderCanvas catches around the whole
    // interpreter, so a refusal escaping the loader loses the PAGE silently and
    // ToImage still returns a (blank) PNG. Measured: rethrowing it from
    // loadEmbeddedProgram leaves every other case here green.
    // buildFontPdf draws at y 700 on a 300x200 page, so the text is redrawn
    // on-page first — otherwise both renders are blank and agree vacuously.
    const render = (bytes: Uint8Array): Uint8Array => {
      const doc = Document.Open(bytes);
      const page = doc.Pages[0];
      const raw = new TextEncoder().encode('BT /F1 48 Tf 20 80 Td (AB) Tj ET');
      page.Dict.set('Contents', doc.allocObject(
        { kind: 'stream', dict: new Map([['Length', raw.length]]), raw }));
      return page.ToImage();
    };
    const got = render(pdf());
    const img = decodePng(got);
    let ink = 0;
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) if (img.at(x, y)[0] < 128) ink++;
    expect(ink).toBeGreaterThan(100);
    expect(Buffer.compare(got, render(buildFontPdf({ text: 'AB' })))).toBe(0);
  });

});
