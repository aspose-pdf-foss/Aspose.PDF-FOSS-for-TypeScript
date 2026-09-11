import { describe, it, expect } from 'vitest';
import { Document } from '../src/document.js';
import { decodePng } from './helpers/decode-png.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGlyphSource } from '../src/raster.js';
import { buildNamedFont } from './helpers/build-sfnt.js';
import { buildType0Pdf, buildSimpleTextPdf, fontDictOf } from './helpers/build-text-pdf.js';

/**
 * A NON-EMBEDDED composite font draws real glyphs (lqcs.1).
 *
 * **The issue's premise was wrong and the correction matters for testing.** It
 * says such a font "paints nothing at all"; measured, it paints PLACEHOLDER
 * BOXES — `rasterizeGlyphRun` already falls back to `drawGlyphPlaceholder` when
 * no gid resolves, so the four-CID fixture below rendered 1120 ink pixels before
 * this change against 1902 for the same string filled in Helvetica. A test that
 * asserts "ink appears" therefore passes on the UNFIXED build; only a comparison
 * against the real filled render discriminates.
 *
 * The CID -> Unicode half also already existed: `TextFont.textOf` tries
 * `/ToUnicode` first and `cidunicode.ts`'s bundled collection table second, and
 * the answer reaches raster.ts as `Glyph.text`. What was missing is the
 * substitute face itself, and the rule that a substituted composite font selects
 * by UNICODE rather than by CID.
 */

/** A /ToUnicode CMap mapping the given CID range to a run of codepoints. */
const bfrange = (loCid: number, hiCid: number, loUni: number) =>
  `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n`
  + `1 begincodespacerange <0000> <FFFF> endcodespacerange\n`
  + `1 beginbfrange <${loCid.toString(16).padStart(4, '0')}> `
  + `<${hiCid.toString(16).padStart(4, '0')}> `
  + `<${loUni.toString(16).padStart(4, '0')}> endbfrange\n`
  + `endcmap end end`;

/** Show a run of 2-byte CIDs at 48pt. */
const show = (cids: number[]) =>
  `BT /F1 48 Tf 20 100 Td <${cids.map((c) => c.toString(16).padStart(4, '0')).join('')}> Tj ET`;

function inkCount(bytes: Uint8Array): number {
  const png = decodePng(bytes);
  let n = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const [r, g, b] = png.at(x, y);
      if (r !== 255 || g !== 255 || b !== 255) n++;
    }
  }
  return n;
}

const render = (pdf: Uint8Array) => Document.Open(pdf).Pages[0].ToImage();

describe('non-embedded composite font', () => {
  it('draws the SAME ink as the simple font showing the same string', () => {
    // CIDs 0x21..0x24 -> U+0041..U+0044 ("ABCD"). The substitute is the same
    // Helvetica the simple font resolves to and the advances are the document's,
    // so the two renders should agree closely — where the pre-fix build drew
    // hairline boxes at 1120 px against Helvetica's 1902.
    const composite = inkCount(render(buildType0Pdf(show([0x21, 0x22, 0x23, 0x24]), bfrange(0x21, 0x24, 0x41))));
    const simple = inkCount(render(buildSimpleTextPdf('BT /F1 48 Tf 20 100 Td (ABCD) Tj ET')));
    expect(composite).toBeGreaterThan(simple * 0.8);
    expect(composite).toBeLessThan(simple * 1.2);
  });

  it('selects the glyph by UNICODE, never by the CID', () => {
    // **The trap, and the fixture for it had to be rebuilt — measured.**
    // `gidForProgram` falls back to `cmapLookup(code)` after trying the text,
    // which is right for a simple font (the code IS a character code) and wrong
    // for a composite one (it is a CID). But the fallback only fires when the
    // TEXT LOOKUP FAILS, so a fixture whose Unicode the substitute HAS — CID
    // 0x41 -> U+0058 'X', say — never reaches it and measures nothing.
    //
    // What reaches it is a CID whose Unicode the substitute LACKS while the CID
    // itself is a valid Latin codepoint: CID 0x41 -> U+4E00, which Helvetica has
    // no glyph for. A build that fell through would draw a confident `A` where a
    // Japanese character belongs — the exact failure that makes substituting by
    // CID unsafe, and the one lqcs.2 will lean on when real CJK faces arrive.
    const cjk = inkCount(render(buildType0Pdf(show([0x41]), bfrange(0x41, 0x41, 0x4e00))));
    const realA = inkCount(render(buildSimpleTextPdf('BT /F1 48 Tf 20 100 Td (A) Tj ET')));
    expect(cjk).not.toBe(realA);
    // It falls back to the placeholder box, which is the honest answer: we have
    // no face for this character. Boxes are hairline, so far less ink than a
    // filled glyph.
    expect(cjk).toBeLessThan(realA);
  });

  it('still draws a placeholder box for a CID with no Unicode', () => {
    // Identity ordering and no usable /ToUnicode entry: nothing can say what
    // character this is, so there is no glyph to substitute and the existing
    // box stands. It must NOT fall through to some arbitrary gid.
    const ink = inkCount(render(buildType0Pdf(show([0x30]), bfrange(0x21, 0x24, 0x41))));
    expect(ink).toBeGreaterThan(0);                      // the box is drawn
    const realZero = inkCount(render(buildSimpleTextPdf('BT /F1 48 Tf 20 100 Td (0) Tj ET')));
    expect(ink).not.toBe(realZero);                      // and it is not the glyph '0'
  });

  it('leaves glyph positions to the document /W, unchanged by substitution', () => {
    const page = Document.Open(
      buildType0Pdf(show([0x21, 0x22, 0x23, 0x24]), bfrange(0x21, 0x24, 0x41)),
    ).Pages[0];
    const frags = page.GetTextFragments();
    expect(frags.length).toBeGreaterThan(0);
    // The run starts where the text matrix put it; substitution must not move it.
    expect(frags[0].quad[0]).toBeCloseTo(20, 1);
  });
});

// ---------------------------------------------------------------------------

function folderWith(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf4ts-type0sub-'));
  for (const [rel, bytes] of Object.entries(files)) writeFileSync(join(dir, rel), bytes);
  return dir;
}

describe('installed-face substitution (lqcs.2)', () => {
  /** A non-embedded Identity-H page whose four CIDs mean four kanji. */
  const cjkPdf = (baseFont?: string) => buildType0Pdf(
    show([0x41, 0x42, 0x43, 0x44]), bfrange(0x41, 0x44, 0x4e00), { baseFont });
  const MINCHO_CMAP: [number, number][] =
    [[0x4e00, 1], [0x4e01, 1], [0x4e02, 1], [0x4e03, 1]];

  it('reports no substitute family with no render folder registered', () => {
    const doc = Document.Open(cjkPdf());
    const src = buildGlyphSource(doc, fontDictOf(doc));
    expect(src.substituted).toBe(true);
    expect(src.substituteFamily).toBeUndefined();    // the bundled face
  });

  it('resolves /BaseFont to an installed face when one is registered', () => {
    const dir = folderWith({ 'm.ttf': buildNamedFont({
      family: 'MS Mincho', postScriptName: 'MS-Mincho', cmap: MINCHO_CMAP,
    }) });
    const doc = Document.Open(cjkPdf('MS-Mincho'));
    doc.RegisterRenderFontFolder(dir);
    expect(buildGlyphSource(doc, fontDictOf(doc)).substituteFamily).toBe('MS Mincho');
  });

  it('falls back to the bundled face when the folder holds nothing usable', () => {
    const dir = folderWith({ 'l.ttf': buildNamedFont({
      family: 'Latin Only', cmap: [[0x41, 1]], unicodeRange: [1, 0, 0, 0],
    }) });
    const doc = Document.Open(cjkPdf('AbsentFamily'));
    doc.RegisterRenderFontFolder(dir);
    const src = buildGlyphSource(doc, fontDictOf(doc));
    expect(src.substituted).toBe(true);
    expect(src.substituteFamily).toBeUndefined();
  });

  it('strips a subset prefix before matching by name', () => {
    const dir = folderWith({ 'm.ttf': buildNamedFont({
      family: 'MS Mincho', postScriptName: 'MS-Mincho', cmap: MINCHO_CMAP,
    }) });
    const doc = Document.Open(cjkPdf('AAAAAB+MS-Mincho'));
    doc.RegisterRenderFontFolder(dir);
    expect(buildGlyphSource(doc, fontDictOf(doc)).substituteFamily).toBe('MS Mincho');
  });
});
